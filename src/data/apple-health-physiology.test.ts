/**
 * Apple Health physiology sync (audit X4): day keys, night attribution,
 * newest-wins merge, read limits and cross-source step counting.
 *
 * The HealthExtras plugin is replaced by an emulator that behaves like the
 * Swift side: timestamps come back as GMT ISO strings ending in "Z", quantity
 * reads filter on start date, sort and apply the caller's limit (0 = none),
 * and sleep reads return overlapping segments ascending with a 2000 default.
 *
 * Time zones are set per block with process.env.TZ, using fixed-offset zones
 * with no DST: America/Phoenix (UTC-7) and Australia/Brisbane (UTC+10).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { SimulatorState, PhysiologyDayEntry } from '@/types';
import { getDefaultState } from '@/state/store';

let mockState: SimulatorState;

vi.mock('@/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state')>();
  return {
    ...actual,
    getMutableState: () => mockState,
    getState: () => mockState,
    saveState: vi.fn(),
  };
});

type Raw = { value: number; unit?: string; startDate: string; endDate: string; sourceName?: string };

const hk = vi.hoisted(() => ({
  quantity: {} as Record<string, Raw[]>,
  sleep: [] as Raw[],
  permissionCalls: [] as string[][],
  quantityCalls: [] as Array<{ dataType: string; startDate?: string; endDate?: string; limit?: number; ascending?: boolean }>,
  sleepCalls: [] as Array<{ startDate?: string; endDate?: string; limit?: number }>,
}));

vi.mock('@/data/healthExtras', () => ({
  isHealthExtrasAvailable: () => true,
  requestHealthExtrasPermissions: vi.fn(async (read: string[]) => {
    hk.permissionCalls.push([...read]);
    return { granted: read, denied: [] };
  }),
  readQuantitySamples: vi.fn(async (opts: { dataType: string; startDate: string; endDate: string; limit?: number; ascending?: boolean }) => {
    hk.quantityCalls.push(opts);
    const s = Date.parse(opts.startDate);
    const e = Date.parse(opts.endDate);
    const dir = opts.ascending === false ? -1 : 1;
    let out = (hk.quantity[opts.dataType] ?? [])
      .filter(x => { const t = Date.parse(x.startDate); return t >= s && t <= e; })
      .sort((a, b) => (Date.parse(a.startDate) - Date.parse(b.startDate)) * dir);
    if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
    return out.map(x => ({ unit: '', ...x }));
  }),
  readSleepSamples: vi.fn(async (opts: { startDate: string; endDate: string; limit?: number }) => {
    hk.sleepCalls.push(opts);
    const s = Date.parse(opts.startDate);
    const e = Date.parse(opts.endDate);
    let out = hk.sleep
      .filter(x => Date.parse(x.startDate) < e && Date.parse(x.endDate) > s)
      .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate));
    const limit = opts.limit ?? 2000;
    if (limit > 0) out = out.slice(0, limit);
    return out;
  }),
  readLatestQuantity: vi.fn(async () => ({ value: null, asOf: null })),
  readCharacteristics: vi.fn(async () => ({ dateOfBirth: null, biologicalSex: null })),
  queryWorkouts: vi.fn(async () => []),
  readWorkoutRouteLocations: vi.fn(async () => []),
  startWorkoutObserver: vi.fn(async () => ({ started: false, alreadyRunning: false })),
  addWorkoutObserverListener: vi.fn(async () => ({ remove: async () => undefined })),
}));

// The Garmin snapshot (physiologySync) is driven through a stubbed edge call so
// one test can interleave a Garmin write with Apple reads.
const edge = vi.hoisted(() => ({ response: null as unknown }));
vi.mock('@/data/supabaseClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/supabaseClient')>();
  return { ...actual, callEdgeFunction: vi.fn(async () => edge.response) };
});

import { syncPhysiologySnapshot } from './physiologySync';
import {
  syncAppleHealthPhysiology,
  dailyStepsAcrossSources,
  sleepWakeDateKey,
  mergeApplePhysiologyEntries,
  CORE_READ_TYPES,
} from './appleHealthSync';
import { mergeManualSleepHistory } from '@/calculations/sleep-insights';

const ORIGINAL_TZ = process.env.TZ;
function restoreTz(): void {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
}

/** GMT ISO string for a LOCAL wall-clock time in the current TZ (month 1-12). */
function local(y: number, mo: number, d: number, h: number, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

function steps(value: number, start: string, end: string, sourceName = 'Apple Watch'): Raw & { unit: string } {
  return { value, unit: 'count', startDate: start, endDate: end, sourceName };
}

/** HKCategoryValueSleepAnalysis: 0 inBed, 1 asleep, 2 awake, 3 core, 4 deep, 5 REM. */
function seg(value: number, start: string, end: string, sourceName = 'Apple Watch'): Raw {
  return { value, startDate: start, endDate: end, sourceName };
}

function entry(date: string): PhysiologyDayEntry | undefined {
  return mockState.physiologyHistory?.find(e => e.date === date);
}

function setNow(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  mockState = getDefaultState() as SimulatorState;
  mockState.connectedSources = { physiology: 'apple' };
  mockState.appleHealthConnected = true;
  hk.quantity = {};
  hk.sleep = [];
  hk.permissionCalls = [];
  hk.quantityCalls = [];
  hk.sleepCalls = [];
  vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'ios' } });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── UTC-7 ──────────────────────────────────────────────────────────────────

describe('Apple physiology sync in UTC-7 (America/Phoenix)', () => {
  beforeAll(() => { process.env.TZ = 'America/Phoenix'; });
  afterAll(restoreTz);

  it('the zone is applied', () => {
    expect(new Date(2026, 9, 1).getTimezoneOffset()).toBe(420);
  });

  it('keys evening steps to that local date instead of the next UTC date', async () => {
    // 19:00 on 1 Oct local = 02:00Z on 2 Oct.
    hk.quantity.stepCount = [
      steps(400, local(2026, 10, 1, 19, 0), local(2026, 10, 1, 19, 10)),
      steps(5000, local(2026, 10, 2, 7, 0), local(2026, 10, 2, 8, 0)),
    ];
    setNow(local(2026, 10, 2, 9, 0));
    expect(await syncAppleHealthPhysiology(7)).toBe(true);
    expect(entry('2026-10-01')?.steps).toBe(400);
    expect(entry('2026-10-02')?.steps).toBe(5000);
  });

  it('keeps the pre-midnight part of a night on the wake date', async () => {
    // 22:30 on 1 Oct to 06:30 on 2 Oct local, 8 h asleep. The first segment
    // ends at 23:30, which the old noon filter dropped as a "nap".
    hk.sleep = [
      seg(3, local(2026, 10, 1, 22, 30), local(2026, 10, 1, 23, 30)),
      seg(4, local(2026, 10, 1, 23, 30), local(2026, 10, 2, 1, 0)),
      seg(3, local(2026, 10, 2, 1, 0), local(2026, 10, 2, 4, 0)),
      seg(5, local(2026, 10, 2, 4, 0), local(2026, 10, 2, 6, 30)),
    ];
    setNow(local(2026, 10, 2, 9, 0));
    await syncAppleHealthPhysiology(7);
    const night = entry('2026-10-02');
    expect(night?.sleepDurationSec).toBe(8 * 3600);
    expect(night?.sleepDeepSec).toBe(1.5 * 3600);
    expect(entry('2026-10-01')?.sleepDurationSec).toBeUndefined();
  });

  it('a later sync the same day replaces the earlier value (no freeze)', async () => {
    hk.quantity.stepCount = [steps(400, local(2026, 10, 2, 7, 0), local(2026, 10, 2, 7, 10))];
    setNow(local(2026, 10, 2, 9, 0));
    await syncAppleHealthPhysiology(7);
    expect(entry('2026-10-02')?.steps).toBe(400);

    hk.quantity.stepCount.push(steps(5000, local(2026, 10, 2, 12, 0), local(2026, 10, 2, 13, 0)));
    setNow(local(2026, 10, 2, 18, 0));
    await syncAppleHealthPhysiology(7);
    expect(entry('2026-10-02')?.steps).toBe(5400);
  });
});

// ─── UTC+10 ─────────────────────────────────────────────────────────────────

describe('Apple physiology sync in UTC+10 (Australia/Brisbane)', () => {
  beforeAll(() => { process.env.TZ = 'Australia/Brisbane'; });
  afterAll(restoreTz);

  it('the zone is applied', () => {
    expect(new Date(2026, 9, 1).getTimezoneOffset()).toBe(-600);
  });

  it('keys a 23:00-07:00 night and the morning resting HR to the local wake date', async () => {
    // Whole night is 13:00Z-21:00Z on 30 Sep, so UTC keys put it a day early.
    hk.sleep = [
      seg(3, local(2026, 9, 30, 23, 0), local(2026, 9, 30, 23, 30)),
      seg(4, local(2026, 9, 30, 23, 30), local(2026, 10, 1, 1, 0)),
      seg(3, local(2026, 10, 1, 1, 0), local(2026, 10, 1, 4, 30)),
      seg(5, local(2026, 10, 1, 4, 30), local(2026, 10, 1, 7, 0)),
    ];
    hk.quantity.restingHeartRate = [{ value: 52, startDate: local(2026, 10, 1, 7, 0), endDate: local(2026, 10, 1, 7, 0) }];
    hk.quantity.stepCount = [steps(1200, local(2026, 10, 1, 6, 0), local(2026, 10, 1, 7, 0))];
    setNow(local(2026, 10, 1, 9, 0));
    await syncAppleHealthPhysiology(7);
    const day = entry('2026-10-01');
    expect(day?.sleepDurationSec).toBe(8 * 3600);
    expect(day?.restingHR).toBe(52);
    expect(day?.steps).toBe(1200);
    expect(entry('2026-09-30')).toBeUndefined();
  });

  it('reads every sample from local midnight, and sleep from the noon before', async () => {
    setNow(local(2026, 10, 1, 9, 0));
    hk.quantity.stepCount = [steps(10, local(2026, 10, 1, 8, 0), local(2026, 10, 1, 8, 5))];
    await syncAppleHealthPhysiology(7);
    expect(hk.quantityCalls.length).toBe(5);
    for (const c of hk.quantityCalls) {
      expect(c.limit).toBe(0);
      expect(c.startDate).toBe(local(2026, 9, 24, 0, 0));
    }
    expect(hk.sleepCalls).toHaveLength(1);
    expect(hk.sleepCalls[0].limit).toBe(0);
    expect(hk.sleepCalls[0].startDate).toBe(local(2026, 9, 23, 12, 0));
  });

  it('keeps the newest days of a dense step history on a long read', async () => {
    // 150 samples a day over a 7-day read = 1200 samples, beyond the old
    // 1000-sample oldest-first limit, which cut off the newest 1+ days.
    const dense: Raw[] = [];
    for (let day = 24; day <= 31; day++) {
      const [mo, d] = day <= 30 ? [9, day] : [10, 1];
      for (let i = 0; i < 150; i++) {
        const start = new Date(2026, mo - 1, d, 0, 0).getTime() + i * 5 * 60_000;
        dense.push(steps(10, new Date(start).toISOString(), new Date(start + 60_000).toISOString()));
      }
    }
    hk.quantity.stepCount = dense;
    setNow(local(2026, 10, 1, 23, 0));
    await syncAppleHealthPhysiology(7);
    expect(entry('2026-10-01')?.steps).toBe(1500);
    expect(entry('2026-09-30')?.steps).toBe(1500);
  });

  it('counts overlapping iPhone and Watch steps once', async () => {
    hk.quantity.stepCount = [
      steps(1000, local(2026, 10, 1, 10, 0), local(2026, 10, 1, 10, 20), 'iPhone'),
      steps(1000, local(2026, 10, 1, 10, 0), local(2026, 10, 1, 10, 20), 'Apple Watch'),
      steps(500, local(2026, 10, 1, 15, 0), local(2026, 10, 1, 15, 10), 'Apple Watch'),
    ];
    setNow(local(2026, 10, 1, 18, 0));
    await syncAppleHealthPhysiology(7);
    expect(entry('2026-10-01')?.steps).toBe(1500);
  });

  it('takes one sleep source per night, preferring the staged one', async () => {
    // Watch (staged) and a third-party app (generic asleep) record the same
    // 8 h night. Summing them stored 16 h.
    hk.sleep = [
      seg(3, local(2026, 9, 30, 23, 0), local(2026, 10, 1, 2, 0)),
      seg(4, local(2026, 10, 1, 2, 0), local(2026, 10, 1, 3, 30)),
      seg(5, local(2026, 10, 1, 3, 30), local(2026, 10, 1, 7, 0)),
      seg(1, local(2026, 9, 30, 23, 0), local(2026, 10, 1, 7, 0), 'AutoSleep'),
      seg(0, local(2026, 9, 30, 22, 45), local(2026, 10, 1, 7, 15), 'iPhone'),
    ];
    setNow(local(2026, 10, 1, 9, 0));
    await syncAppleHealthPhysiology(7);
    const day = entry('2026-10-01');
    expect(day?.sleepDurationSec).toBe(8 * 3600);
    expect(day?.sleepDeepSec).toBe(1.5 * 3600);
  });

  it('does not write tonight before it is over', async () => {
    // A 22:00-23:00 segment tonight belongs to tomorrow's night.
    hk.sleep = [seg(3, local(2026, 10, 1, 22, 0), local(2026, 10, 1, 23, 0))];
    hk.quantity.stepCount = [steps(300, local(2026, 10, 1, 8, 0), local(2026, 10, 1, 8, 10))];
    setNow(local(2026, 10, 1, 23, 30));
    await syncAppleHealthPhysiology(7);
    expect(entry('2026-10-02')).toBeUndefined();
    expect(entry('2026-10-01')?.sleepDurationSec).toBeUndefined();
  });

  it('a supplementary Apple source never overwrites Garmin, but refreshes its own gap-fills', async () => {
    mockState.connectedSources = { physiology: 'garmin' };
    // Garmin wrote steps for today; it never sends respiratory rate.
    mockState.physiologyHistory = [{ date: '2026-10-01', steps: 6000, sleepScore: 81 }];
    hk.quantity.stepCount = [steps(400, local(2026, 10, 1, 7, 0), local(2026, 10, 1, 7, 10))];
    hk.quantity.respiratoryRate = [{ value: 14, startDate: local(2026, 10, 1, 3, 0), endDate: local(2026, 10, 1, 3, 0) }];
    setNow(local(2026, 10, 1, 9, 0));
    await syncAppleHealthPhysiology(7);
    expect(entry('2026-10-01')?.steps).toBe(6000);
    expect(entry('2026-10-01')?.sleepScore).toBe(81);
    expect(entry('2026-10-01')?.respiratoryRate).toBe(14);

    // A newer respiratory reading refreshes Apple's own value.
    hk.quantity.respiratoryRate.push({ value: 15, startDate: local(2026, 10, 1, 5, 0), endDate: local(2026, 10, 1, 5, 0) });
    setNow(local(2026, 10, 1, 12, 0));
    await syncAppleHealthPhysiology(7);
    expect(entry('2026-10-01')?.respiratoryRate).toBe(15);
    expect(entry('2026-10-01')?.steps).toBe(6000);
  });

  it('once Garmin writes a value equal to an Apple gap-fill, a newer Apple read no longer overwrites it', async () => {
    mockState.connectedSources = { physiology: 'garmin' };
    hk.quantity.restingHeartRate = [{ value: 52, startDate: local(2026, 10, 1, 6, 0), endDate: local(2026, 10, 1, 6, 0) }];
    setNow(local(2026, 10, 1, 7, 0));
    await syncAppleHealthPhysiology(7);
    expect(entry('2026-10-01')?.restingHR).toBe(52);          // Apple gap-fill

    // Garmin (primary) reports the same 52 for that local date.
    edge.response = { days: [{ calendar_date: '2026-10-01', resting_hr: 52 }], maxHR: null, latestPhysio: null };
    await syncPhysiologySnapshot(7);

    hk.quantity.restingHeartRate.push({ value: 55, startDate: local(2026, 10, 1, 8, 0), endDate: local(2026, 10, 1, 8, 0) });
    setNow(local(2026, 10, 1, 9, 0));
    await syncAppleHealthPhysiology(7);
    expect(entry('2026-10-01')?.restingHR).toBe(52);
  });

  it('leaves manual sleep ratings alone (they live in recoveryHistory)', async () => {
    mockState.recoveryHistory = [{ date: '2026-09-28', sleepScore: 40, source: 'manual' } as never];
    hk.sleep = [
      seg(3, local(2026, 9, 30, 23, 0), local(2026, 10, 1, 3, 0)),
      seg(4, local(2026, 10, 1, 3, 0), local(2026, 10, 1, 7, 0)),
    ];
    setNow(local(2026, 10, 1, 9, 0));
    await syncAppleHealthPhysiology(7);
    expect(mockState.recoveryHistory).toEqual([{ date: '2026-09-28', sleepScore: 40, source: 'manual' }]);
    const merged = mergeManualSleepHistory(mockState.physiologyHistory ?? [], mockState.recoveryHistory as never);
    expect(merged.find(e => e.date === '2026-09-28')?.sleepScore).toBe(40);
    expect(merged.find(e => e.date === '2026-10-01')?.sleepDurationSec).toBe(8 * 3600);
  });

  it('asks for heartRate in the primary permission sheet', async () => {
    setNow(local(2026, 10, 1, 9, 0));
    await syncAppleHealthPhysiology(7);
    expect(hk.permissionCalls[0]).toContain('heartRate');
    expect(CORE_READ_TYPES).toContain('heartRate');
  });
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('Apple physiology helpers (UTC+10)', () => {
  beforeAll(() => { process.env.TZ = 'Australia/Brisbane'; });
  afterAll(restoreTz);

  it('sleepWakeDateKey: before noon is that morning, noon onward is the next morning', () => {
    expect(sleepWakeDateKey(local(2026, 10, 1, 6, 30))).toBe('2026-10-01');
    expect(sleepWakeDateKey(local(2026, 10, 1, 11, 59))).toBe('2026-10-01');
    expect(sleepWakeDateKey(local(2026, 10, 1, 12, 0))).toBe('2026-10-02');
    expect(sleepWakeDateKey(local(2026, 10, 1, 23, 30))).toBe('2026-10-02');
    expect(sleepWakeDateKey('garbage')).toBe('');
  });

  it('dailyStepsAcrossSources splits a sample that spans local midnight', () => {
    const out = dailyStepsAcrossSources([
      steps(200, local(2026, 9, 30, 23, 50), local(2026, 10, 1, 0, 10)),
    ]);
    expect(out.get('2026-09-30')).toBeCloseTo(100, 6);
    expect(out.get('2026-10-01')).toBeCloseTo(100, 6);
  });

  it('dailyStepsAcrossSources sums one source, and keeps the higher source where two overlap', () => {
    const out = dailyStepsAcrossSources([
      // Same source, back to back: summed.
      steps(300, local(2026, 10, 1, 9, 0), local(2026, 10, 1, 9, 10), 'iPhone'),
      steps(300, local(2026, 10, 1, 9, 10), local(2026, 10, 1, 9, 20), 'iPhone'),
      // Watch overlaps the second half of the iPhone stretch with more steps.
      steps(500, local(2026, 10, 1, 9, 10), local(2026, 10, 1, 9, 20), 'Apple Watch'),
      // Zero-length manual entry: no interval to overlap, added as-is.
      steps(50, local(2026, 10, 1, 12, 0), local(2026, 10, 1, 12, 0), 'Health'),
    ]);
    expect(out.get('2026-10-01')).toBeCloseTo(300 + 500 + 50, 6);
  });

  it('mergeApplePhysiologyEntries keeps fields Apple does not send', () => {
    const merged = mergeApplePhysiologyEntries(
      [{ date: '2026-10-01', vo2max: 52, steps: 100, appleValues: { steps: 100 } }],
      [{ date: '2026-10-01', steps: 900 }],
      false,
    );
    expect(merged[0]).toMatchObject({ date: '2026-10-01', vo2max: 52, steps: 900, appleValues: { steps: 900 } });
  });
});
