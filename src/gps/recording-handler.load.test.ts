/**
 * Audit B9, live path: the real handleCompletedRecording stores a finished GPS
 * recording as an activity record, so the run counts in every load signal.
 * Only the UI edges are stubbed (completion modal answers with an RPE, rate()
 * writes the rating, renders are no-ops).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));
vi.mock('@/ui/suggestion-modal', () => ({ showSuggestionModal: vi.fn() }));
vi.mock('@/ui/gps-completion-modal', () => ({
  openGpsCompletionModal: (_data: unknown, onComplete: (rpe: number) => void) => onComplete(7),
}));
vi.mock('@/ui/events', async () => {
  const { getMutableState } = await import('@/state/store');
  return {
    rate: (id: string, _n: string, rpe: number) => {
      const s = getMutableState();
      s.wks[s.w - 1].rated[id] = rpe;
    },
  };
});
vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/workouts', async (orig) => ({
  ...(await orig<typeof import('@/workouts')>()),
  generateWeekWorkouts: () => [
    { n: 'Easy Run', t: 'easy', d: '8km', r: 3, rpe: 3, dayOfWeek: 2, id: 'W1-easy-0' },
  ],
}));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { handleCompletedRecording } from './recording-handler';
import { computeWeekTSS, computeWeekRawTSS, computeTodaySignalBTSS } from '@/calculations/fitness-model';
import { TL_PER_MIN } from '@/constants';
import type { GpsRecording, Week } from '@/types';

function week(): Week {
  return {
    w: 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
  } as unknown as Week;
}

function recording(): GpsRecording {
  const startMs = Date.parse('2026-09-30T07:00:00Z');
  return {
    id: `gps_${startMs}`,
    workoutName: 'Just Run',
    week: 1,
    date: new Date(startMs + 2700 * 1000).toISOString(),
    route: [{ lat: 51.5, lng: -0.1, altitude: null, accuracy: 5, speed: null, timestamp: startMs }],
    splits: [],
    totalDistance: 8000,
    totalElapsed: 2700,
    averagePace: 337.5,
  };
}

describe('handleCompletedRecording stores the run as load (audit B9)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('an impromptu in-app GPS run (track-only) counts in Signal A, weekly and daily Signal B', () => {
    const s = getDefaultState();
    s.trackOnly = true;
    s.planStartDate = '2026-09-28';
    s.w = 1;
    s.wks = [week()];
    setState(s);

    const rec = recording();
    handleCompletedRecording(rec, 'Just Run');

    const wk = getMutableState().wks[0];
    expect(wk.adhocWorkouts?.map(w => w.id)).toEqual([rec.id]);
    expect(wk.garminActuals?.[rec.id]?.garminId).toBe(`guided-${rec.id}`);
    const expected = Math.round(45 * TL_PER_MIN[7]);
    expect(computeWeekTSS(wk, wk.rated)).toBe(expected);       // was 0
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(expected);    // was a flat 35
    expect(computeTodaySignalBTSS(wk, '2026-09-30')).toBeGreaterThan(0); // was 0
  });

  it('a GPS run started from a plan card stores its record on that slot and counts once', () => {
    const s = getDefaultState();
    s.planStartDate = '2026-09-28';
    s.w = 1;
    s.wks = [week()];
    setState(s);

    const rec = recording();
    handleCompletedRecording(rec, 'Easy Run');

    const wk = getMutableState().wks[0];
    expect(wk.rated['W1-easy-0']).toBe(7);
    expect(wk.gpsRecordings?.['W1-easy-0']).toBe(rec.id);
    expect(wk.garminActuals?.['W1-easy-0']?.garminId).toBe(`guided-${rec.id}`);
    expect(wk.adhocWorkouts ?? []).toHaveLength(0);
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(Math.round(45 * TL_PER_MIN[7])); // was 0
  });
});
