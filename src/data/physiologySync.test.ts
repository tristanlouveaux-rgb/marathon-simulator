/**
 * Tests for syncPhysiologySnapshot's physiologyHistory merge.
 *
 * Policy under test (2026-06-05): history merges by date, never wholesale
 * replace. A short-window call (sleep poller and foreground-resume use
 * days=7) must not truncate the 28-day baseline built by the 90-day launch
 * sync, and per-field merge keeps values the incoming row lacks (e.g. steps
 * written by syncTodaySteps, Apple gap-fill nights).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PhysiologyDayEntry, SimulatorState } from '@/types';
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

let mockResponse: unknown;

vi.mock('./supabaseClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./supabaseClient')>();
  return {
    ...actual,
    callEdgeFunction: vi.fn(async () => mockResponse),
  };
});

import { syncPhysiologySnapshot, syncTodaySteps } from './physiologySync';
import { releaseAppleOwnership } from './physiology-provenance';

/** ISO date string n days before 2026-06-05 */
function daysAgo(n: number): string {
  const d = new Date('2026-06-05T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split('T')[0];
}

function historyEntry(date: string, overrides: Partial<PhysiologyDayEntry> = {}): PhysiologyDayEntry {
  return { date, sleepScore: 70, hrvRmssd: 60, restingHR: 45, ...overrides };
}

beforeEach(() => {
  mockState = getDefaultState() as SimulatorState;
});

describe('syncPhysiologySnapshot — physiologyHistory merge', () => {
  it('a 7-day window does not truncate an existing 28-day history', async () => {
    mockState.physiologyHistory = Array.from({ length: 28 }, (_, i) => historyEntry(daysAgo(27 - i)));
    mockResponse = {
      days: Array.from({ length: 7 }, (_, i) => ({
        calendar_date: daysAgo(6 - i),
        sleep_score: 80,
      })),
      maxHR: null,
      latestPhysio: null,
    };

    await syncPhysiologySnapshot(7);

    const hist = mockState.physiologyHistory!;
    expect(hist.length).toBe(28);
    // Oldest day survived the 7-day call
    expect(hist[0].date).toBe(daysAgo(27));
    expect(hist[0].sleepScore).toBe(70);
    // Recent days took the incoming value
    expect(hist[hist.length - 1].sleepScore).toBe(80);
  });

  it('merges per-field: keeps existing steps when the incoming row lacks them', async () => {
    const today = daysAgo(0);
    mockState.physiologyHistory = [historyEntry(today, { steps: 8200, sleepScore: undefined })];
    mockResponse = {
      days: [{ calendar_date: today, sleep_score: 64, hrv_rmssd: 41 }],
      maxHR: null,
      latestPhysio: null,
    };

    await syncPhysiologySnapshot(7);

    const entry = mockState.physiologyHistory!.find(e => e.date === today)!;
    expect(entry.steps).toBe(8200);       // preserved — incoming row had no steps
    expect(entry.sleepScore).toBe(64);    // filled from incoming
    expect(entry.hrvRmssd).toBe(41);
  });

  it('incoming non-null values overwrite existing ones (Garmin wins where it has data)', async () => {
    const today = daysAgo(0);
    mockState.physiologyHistory = [historyEntry(today, { sleepScore: 50 })];
    mockResponse = {
      days: [{ calendar_date: today, sleep_score: 86 }],
      maxHR: null,
      latestPhysio: null,
    };

    await syncPhysiologySnapshot(7);

    expect(mockState.physiologyHistory!.find(e => e.date === today)!.sleepScore).toBe(86);
  });

  it('adds brand-new dates and caps the merged set at 28 days', async () => {
    mockState.physiologyHistory = Array.from({ length: 28 }, (_, i) => historyEntry(daysAgo(28 - i)));
    mockResponse = {
      days: [{ calendar_date: daysAgo(0), sleep_score: 75 }], // a date not yet in history
      maxHR: null,
      latestPhysio: null,
    };

    await syncPhysiologySnapshot(7);

    const hist = mockState.physiologyHistory!;
    expect(hist.length).toBe(28);
    expect(hist[hist.length - 1].date).toBe(daysAgo(0)); // newest kept
    expect(hist[0].date).toBe(daysAgo(27));              // oldest dropped, not newest
  });
});

describe('Garmin writers take ownership from Apple gap-fills (appleValues)', () => {
  it('a Garmin value equal to an Apple gap-fill becomes Garmin-owned; untouched Apple fields stay Apple-owned', async () => {
    const today = daysAgo(0);
    mockState.physiologyHistory = [{
      date: today, restingHR: 52, respiratoryRate: 14,
      appleValues: { restingHR: 52, respiratoryRate: 14 },
    }];
    mockResponse = {
      days: [{ calendar_date: today, resting_hr: 52 }],
      maxHR: null,
      latestPhysio: null,
    };

    await syncPhysiologySnapshot(7);

    const entry = mockState.physiologyHistory!.find(e => e.date === today)!;
    expect(entry.restingHR).toBe(52);
    // Garmin sent restingHR, so Apple no longer owns it, even at the same value.
    expect(entry.appleValues).toEqual({ respiratoryRate: 14 });
  });

  it("Garmin's epoch steps take ownership of today's steps", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-05T12:00:00Z'));
    try {
      const today = '2026-06-05';
      mockState.physiologyHistory = [{ date: today, steps: 4000, appleValues: { steps: 4000, restingHR: 50 }, restingHR: 50 }];
      mockResponse = { ok: true, steps: 4000, activeCalories: 0, activeMinutes: 0, highlyActiveMinutes: 0, epochCount: 1 };

      await syncTodaySteps();

      const entry = mockState.physiologyHistory!.find(e => e.date === today)!;
      expect(entry.steps).toBe(4000);
      expect(entry.appleValues).toEqual({ restingHR: 50 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('releaseAppleOwnership drops appleValues entirely when nothing is left, and never mutates its input', () => {
    const input = { date: '2026-06-05', steps: 10, appleValues: { steps: 10 } };
    const out = releaseAppleOwnership(input, ['steps', 'activeMinutes']);
    expect(out).toEqual({ date: '2026-06-05', steps: 10 });
    expect(input.appleValues).toEqual({ steps: 10 });
    // Nothing to release: the same object comes back.
    const plain = { date: '2026-06-05', steps: 10 };
    expect(releaseAppleOwnership(plain, ['steps'])).toBe(plain);
  });
});
