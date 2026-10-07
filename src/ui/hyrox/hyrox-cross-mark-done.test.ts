// @vitest-environment jsdom
/**
 * HYROX cross sessions (bike, row erg, swim) ticked with no recording count
 * like a recorded session (decision 2026-10-06), as triathlon's ticked
 * sessions already count toward fitness.
 *
 * Before: HYROX Mark as Done wrote a record for runs only (recordHxRunDone);
 * a cross session kept the rating only, so it was absent from every load
 * signal and failed the slot-record completion test the MTL sums use
 * (isMtlSessionCompleted), while the same session synced from a watch counted.
 *
 * Now the tick writes the same planned-load record as triathlon Mark as Done
 * (recordPlannedSessionDone), tagged cycling / rowing / swimming so Signal A
 * weights it at that sport's runSpec, and a synced copy supersedes it.
 *
 * Real HYROX plan, real injury cross-training offers (buildAerobicOffer, the
 * sessions the injury modal adds), real modal (jsdom), real matcher.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));
vi.mock('@/ui/hyrox/plan-view', () => ({ renderHyroxPlanView: vi.fn() }));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { buildAerobicOffer } from '@/calculations/capability-substitution';
import { createDefaultInjuryState, type InjuryState } from '@/types/injury';
import { openHyroxWorkoutDetail } from './workout-detail-modal';
import { isMtlSessionCompleted } from '@/calculations/mtl';
import { isManualInAppActual } from '@/calculations/in-app-activity';
import { computeWeekRawTSS, computeWeekTSS } from '@/calculations/fitness-model';
import { TL_PER_MIN, SPORTS_DB } from '@/constants';
import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import type { SimulatorState, Workout } from '@/types/state';

const OFFER_MIN = 40;
const OFFER_DAY = 2; // Wednesday

function hyroxState(): SimulatorState {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = '2026-09-28'; // a Monday
  s.w = 1;
  s.tw = 16;
  s.hyroxConfig = {
    format: 'open_singles',
    athleteBand: band,
    hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0,
    mtlCap: HYROX_MTL_CAP[band],
    mtlHistory: [],
    runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
    stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
    bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
    weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
    generatorVersion: HYROX_GENERATOR_VERSION,
  };
  s.wks = generateHyroxPlan(s);
  setState(s);
  return getMutableState();
}

const injury = (over: Partial<InjuryState>): InjuryState => ({
  ...createDefaultInjuryState(), active: true, injuryPhase: 'rehab', location: 'other', ...over,
});

/** The injury modal's accepted aerobic offer, as it lands in wk.adhocWorkouts. */
function addOffer(s: SimulatorState, over: Partial<InjuryState>, id: string): Workout {
  const offer = buildAerobicOffer(injury(over), OFFER_MIN, OFFER_DAY);
  expect(offer).not.toBeNull();
  const w = { ...offer!.workout, id } as Workout;
  (s.wks[0].adhocWorkouts ??= []).push(w);
  return w;
}

const BIKE: Partial<InjuryState> = { runCapacity: 0, bikeCapacity: 100 };
const ROW: Partial<InjuryState> = { runCapacity: 0, bikeCapacity: 0, upperLoadCapacity: 100 };
const SWIM: Partial<InjuryState> = { runCapacity: 0, bikeCapacity: 0, upperLoadCapacity: 0, swimCapacity: 100 };

function markDone(w: Workout): void {
  vi.setSystemTime(Date.now() + 1000); // one tap per second: record ids carry the tap time
  openHyroxWorkoutDetail(w, 0);
  (document.querySelector('#hx-detail-mark-done') as HTMLButtonElement).click();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0)); // Sunday evening of week 1
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a ticked HYROX cross session counts like a recorded one', () => {
  it('bike, row erg and swim each write a sport-tagged record and pass the MTL completion test', () => {
    const s = hyroxState();
    const wk = s.wks[0];
    const bike = addOffer(s, BIKE, 'adhoc-cap-1');
    const row = addOffer(s, ROW, 'adhoc-cap-2');
    const swim = addOffer(s, SWIM, 'adhoc-cap-3');
    expect(bike.discipline).toBe('bike');
    expect(row.discipline).toBeUndefined(); // the row erg has no discipline lane
    expect(swim.discipline).toBe('swim');
    for (const w of [bike, row, swim]) expect(isMtlSessionCompleted(wk, w)).toBe(false);

    for (const w of [bike, row, swim]) markDone(w);

    const tags = [bike, row, swim].map(w => wk.garminActuals?.[w.id!]?.manualSport);
    expect(tags).toEqual(['cycling', 'rowing', 'swimming']); // was undefined: rating only
    for (const w of [bike, row, swim]) {
      const rec = wk.garminActuals![w.id!];
      expect(isManualInAppActual(rec)).toBe(true);
      expect(rec.activityType).toBeNull();
      expect(rec.durationSec).toBe(OFFER_MIN * 60);
      expect(isMtlSessionCompleted(wk, w)).toBe(true);
    }
  });

  it('the ticked sessions count once in weekly Signal B and at their own runSpec in Signal A', () => {
    const s = hyroxState();
    const wk = s.wks[0];
    const bike = addOffer(s, BIKE, 'adhoc-cap-1');
    const row = addOffer(s, ROW, 'adhoc-cap-2');
    expect(computeWeekRawTSS(wk, wk.rated, s.planStartDate)).toBe(0);

    markDone(bike);
    markDone(row);

    const raw = (w: Workout) => OFFER_MIN * TL_PER_MIN[Math.round(w.rpe ?? w.r!)];
    // Both on the same day: the double-day bonus applies to Signal B, so check A exactly
    // and B as at least the plain sum.
    expect(computeWeekTSS(wk, wk.rated)).toBe(Math.round(raw(bike) * SPORTS_DB.cycling.runSpec + raw(row) * SPORTS_DB.rowing.runSpec));
    expect(computeWeekRawTSS(wk, wk.rated, s.planStartDate)).toBeGreaterThanOrEqual(Math.round(raw(bike) + raw(row)));
  });

  it('a synced row erg on the same day supersedes the rowing record; a ride does not', () => {
    const s = hyroxState();
    const wk = s.wks[0];
    const row = addOffer(s, ROW, 'adhoc-cap-2');
    markDone(row);
    const rowRow = (over: Partial<GarminActivityRow>): GarminActivityRow => ({
      garmin_id: 'strava-ROW', activity_type: 'ROWING', start_time: new Date(2026, 8, 28 + OFFER_DAY, 8, 0, 0).toISOString(),
      duration_sec: OFFER_MIN * 60, distance_m: 8000, avg_pace_sec_km: null, avg_hr: null, max_hr: null,
      calories: null, aerobic_effect: null, anaerobic_effect: null, iTrimp: null, hrZones: null, ...over,
    });

    matchAndAutoComplete([rowRow({ garmin_id: 'strava-RIDE', activity_type: 'CYCLING' })]);
    expect(isManualInAppActual(wk.garminActuals![row.id!])).toBe(true);

    matchAndAutoComplete([rowRow({})]);
    expect(wk.garminActuals![row.id!].garminId).toBe('strava-ROW');
    expect(wk.garminActuals![row.id!].manualSport).toBeUndefined();
    expect(Object.values(wk.garminActuals!).filter(a => a.garminId === 'strava-ROW')).toHaveLength(1);
  });

  it('Skip drops the record', () => {
    const s = hyroxState();
    const wk = s.wks[0];
    const bike = addOffer(s, BIKE, 'adhoc-cap-1');
    markDone(bike);
    expect(wk.garminActuals?.[bike.id!]).toBeTruthy();
    openHyroxWorkoutDetail(bike, 0);
    (document.querySelector('#hx-detail-skip') as HTMLButtonElement).click();
    expect(wk.rated[bike.id!]).toBe('skip');
    expect(wk.garminActuals?.[bike.id!]).toBeUndefined();
  });

  it('a HYROX run still records without a sport tag', () => {
    const s = hyroxState();
    const wk = s.wks[0];
    const run = (wk.triWorkouts ?? []).find(w => w.discipline === 'run' && (w.estimatedDurationMin ?? 0) > 0)!;
    markDone(run);
    const rec = wk.garminActuals![run.id!];
    expect(isManualInAppActual(rec)).toBe(true);
    expect(rec.manualSport).toBeUndefined();
    expect(rec.durationSec).toBe(run.estimatedDurationMin! * 60);
  });
});
