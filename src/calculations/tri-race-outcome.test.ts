import { describe, it, expect } from 'vitest';
import {
  getRaceOutcomeRetro,
  appendRaceOutcome,
  detectAndLogRaceOutcome,
} from './tri-race-outcome';
import type { SimulatorState } from '@/types/state';
import type { TriRaceLogEntry } from '@/types/triathlon';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

function baseState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 0,
    wks: [],
    triConfig: {
      distance: 'ironman',
      raceDate: isoDaysAgo(1),
      prediction: {
        totalSec: 13 * 3600,        // 13:00:00
        swimSec: 1 * 3600,           // 1:00
        bikeSec: 6 * 3600,           // 6:00
        runSec: 5 * 3600,            // 5:00
        t1Sec: 240,
        t2Sec: 180,
        totalRangeSec: [12 * 3600, 14 * 3600],
        computedAtISO: new Date().toISOString(),
      } as any,
    },
    ...overrides,
  } as unknown as SimulatorState;
}

describe('getRaceOutcomeRetro', () => {
  it('no log → no display', () => {
    const r = getRaceOutcomeRetro(baseState());
    expect(r.display).toBe(false);
  });

  it('beat prediction by ≥ 1 min → display', () => {
    const s = baseState();
    s.triConfig!.raceLog = [{
      dateISO: isoDaysAgo(1),
      distance: 'ironman',
      predictedTotalSec: 13 * 3600,
      predictedPerLeg: { swim: 3600, bike: 21600, run: 18000 },
      actualTotalSec: 13 * 3600 - 4 * 60,  // beat by 4 min
      actualPerLeg: { swim: 3500, bike: 21500, run: 17880 },
    }];
    const r = getRaceOutcomeRetro(s);
    expect(r.display).toBe(true);
    expect(r.headline).toContain('beat your prediction');
    expect(r.headline).toContain('4 min');
  });

  it('came in slower than predicted → log only, no display', () => {
    const s = baseState();
    s.triConfig!.raceLog = [{
      dateISO: isoDaysAgo(1),
      distance: 'ironman',
      predictedTotalSec: 13 * 3600,
      predictedPerLeg: { swim: 3600, bike: 21600, run: 18000 },
      actualTotalSec: 13 * 3600 + 5 * 60,  // missed by 5 min
      actualPerLeg: { swim: 3700, bike: 21800, run: 18000 },
    }];
    const r = getRaceOutcomeRetro(s);
    expect(r.display).toBe(false);
  });

  it('beat by less than 1 min → no display (below threshold)', () => {
    const s = baseState();
    s.triConfig!.raceLog = [{
      dateISO: isoDaysAgo(1),
      distance: 'ironman',
      predictedTotalSec: 13 * 3600,
      predictedPerLeg: { swim: 3600, bike: 21600, run: 18000 },
      actualTotalSec: 13 * 3600 - 30,  // beat by 30s — below 60s threshold
      actualPerLeg: { swim: 3590, bike: 21590, run: 18000 },
    }];
    const r = getRaceOutcomeRetro(s);
    expect(r.display).toBe(false);
  });
});

describe('appendRaceOutcome', () => {
  it('appends new entry', () => {
    const s = baseState();
    const entry: TriRaceLogEntry = {
      dateISO: isoDaysAgo(1),
      distance: 'ironman',
      predictedTotalSec: 13 * 3600,
      predictedPerLeg: { swim: 3600, bike: 21600, run: 18000 },
      actualTotalSec: 12.95 * 3600,
      actualPerLeg: { swim: 3500, bike: 21500, run: 17880 },
    };
    expect(appendRaceOutcome(s, entry)).toBe(true);
    expect(s.triConfig!.raceLog).toHaveLength(1);
  });

  it('idempotent — skips duplicate dateISO', () => {
    const s = baseState();
    const entry: TriRaceLogEntry = {
      dateISO: isoDaysAgo(1),
      distance: 'ironman',
      predictedTotalSec: 13 * 3600,
      predictedPerLeg: { swim: 3600, bike: 21600, run: 18000 },
      actualTotalSec: 12.95 * 3600,
      actualPerLeg: { swim: 3500, bike: 21500, run: 17880 },
    };
    appendRaceOutcome(s, entry);
    expect(appendRaceOutcome(s, entry)).toBe(false);  // duplicate
    expect(s.triConfig!.raceLog).toHaveLength(1);
  });
});

describe('detectAndLogRaceOutcome', () => {
  it('skips when race date in the future', () => {
    const s = baseState({
      triConfig: { ...baseState().triConfig!, raceDate: '2099-01-01' } as any,
    });
    expect(detectAndLogRaceOutcome(s)).toBeNull();
    expect(s.triConfig!.raceLog ?? []).toHaveLength(0);
  });

  it('skips when no race-day activities found', () => {
    const s = baseState();  // no wks/garminActuals
    expect(detectAndLogRaceOutcome(s)).toBeNull();
  });

  it('detects when race-day activities sum properly', () => {
    const s = baseState();
    const raceDate = isoDaysAgo(1);
    const swimStart = new Date(raceDate + 'T07:00:00Z').toISOString();
    const bikeStart = new Date(raceDate + 'T08:00:00Z').toISOString();
    const runStart  = new Date(raceDate + 'T13:30:00Z').toISOString();
    s.wks = [
      {
        garminActuals: {
          a1: { garminId: 'a1', startTime: swimStart, durationSec: 3500, distanceKm: 3.8, activityType: 'SWIMMING' } as any,
          a2: { garminId: 'a2', startTime: bikeStart, durationSec: 21500, distanceKm: 180, activityType: 'CYCLING' } as any,
          a3: { garminId: 'a3', startTime: runStart,  durationSec: 17880, distanceKm: 42.2, activityType: 'RUNNING' } as any,
        },
      },
    ] as any;
    const entry = detectAndLogRaceOutcome(s);
    expect(entry).not.toBeNull();
    expect(entry!.distance).toBe('ironman');
    expect(entry!.actualTotalSec).toBe(3500 + 21500 + 17880);
    expect(entry!.actualPerLeg.bike).toBe(21500);
  });

  it('idempotent — repeat call returns null', () => {
    const s = baseState();
    const raceDate = isoDaysAgo(1);
    const start = new Date(raceDate + 'T08:00:00Z').toISOString();
    s.wks = [
      {
        garminActuals: {
          a1: { garminId: 'a1', startTime: start, durationSec: 3500, distanceKm: 3.8, activityType: 'SWIMMING' } as any,
          a2: { garminId: 'a2', startTime: start, durationSec: 21500, distanceKm: 180, activityType: 'CYCLING' } as any,
          a3: { garminId: 'a3', startTime: start, durationSec: 17880, distanceKm: 42.2, activityType: 'RUNNING' } as any,
        },
      },
    ] as any;
    expect(detectAndLogRaceOutcome(s)).not.toBeNull();
    expect(detectAndLogRaceOutcome(s)).toBeNull();  // already logged
  });
});
