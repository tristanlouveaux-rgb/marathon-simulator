/**
 * Tests for HYROX run-pace personalisation: back-computing observed pace
 * from a race, blending observations into the personal offset, and
 * applying decay.
 */

import { describe, it, expect } from 'vitest';
import {
  backComputeRunPaceFromRace,
  blendPersonalRunPaceOffset,
  computePersonalRunPaceOffset,
  estimateStationsAndRoxzoneFromBand,
  type HyroxRaceObservation,
} from './hyrox-personal-pace';
import type { SimulatorState } from '@/types/state';

function makeObs(overrides: Partial<HyroxRaceObservation> = {}): HyroxRaceObservation {
  return {
    finishSec: 3600,         // 1h finish
    stationsTotalSec: 1500,  // ~25 min stations
    roxzoneSec: 300,         // 5 min transitions
    format: 'open_singles',
    dateISO: '2026-01-01',
    stationsFromSplits: false,
    ...overrides,
  };
}

describe('backComputeRunPaceFromRace', () => {
  it('returns the average per-1km pace from finish - stations - roxzone', () => {
    // 3600 - 1500 - 300 = 1800 s running / 8 km = 225 s/km
    expect(backComputeRunPaceFromRace(makeObs())).toBe(225);
  });

  it('returns null when implausibly small remainder', () => {
    expect(backComputeRunPaceFromRace(makeObs({ stationsTotalSec: 3500 }))).toBeNull();
  });

  it('returns null when pace lands out of physiological range', () => {
    // 100 s/km would imply 12 min total run — too fast.
    expect(backComputeRunPaceFromRace({
      finishSec: 1100, stationsTotalSec: 200, roxzoneSec: 100,
      format: 'open_singles', dateISO: '2026-01-01', stationsFromSplits: false,
    })).toBeNull();
  });

  it('rounds to the nearest second', () => {
    // 3603 - 1500 - 300 = 1803 / 8 = 225.375 → 225
    expect(backComputeRunPaceFromRace(makeObs({ finishSec: 3603 }))).toBe(225);
  });
});

describe('estimateStationsAndRoxzoneFromBand', () => {
  it('returns plausible totals for intermediate', () => {
    const { stationsTotalSec, roxzoneSec } = estimateStationsAndRoxzoneFromBand('intermediate', 'open_singles');
    expect(stationsTotalSec).toBeGreaterThan(1200);
    expect(stationsTotalSec).toBeLessThan(2500);
    expect(roxzoneSec).toBeGreaterThan(0);
  });

  it('faster bands yield smaller station totals than slower bands', () => {
    const advanced = estimateStationsAndRoxzoneFromBand('advanced', 'open_singles').stationsTotalSec;
    const intermediate = estimateStationsAndRoxzoneFromBand('intermediate', 'open_singles').stationsTotalSec;
    const beginner = estimateStationsAndRoxzoneFromBand('beginner', 'open_singles').stationsTotalSec;
    expect(advanced).toBeLessThan(intermediate);
    expect(intermediate).toBeLessThan(beginner);
  });
});

describe('blendPersonalRunPaceOffset', () => {
  it('first observation with splits-quality data uses the high weight (0.6)', () => {
    const r = blendPersonalRunPaceOffset({
      observedPaceSecKm: 230,
      modelPaceSecKm: 250,
      stationsFromSplits: true,
    });
    // residual = -20; first obs, no existing offset → 0 × 0.4 + (-20) × 0.6 = -12
    expect(r.offsetSec).toBe(-12);
    expect(r.confidence).toBeCloseTo(0.6, 4);
  });

  it('first observation without splits uses the lower weight (0.35)', () => {
    const r = blendPersonalRunPaceOffset({
      observedPaceSecKm: 230,
      modelPaceSecKm: 250,
      stationsFromSplits: false,
    });
    // residual = -20; first obs → 0 × 0.65 + (-20) × 0.35 = -7
    expect(r.offsetSec).toBe(-7);
    expect(r.confidence).toBeCloseTo(0.35, 4);
  });

  it('subsequent observation blends with prior offset', () => {
    // Prior offset -12 with confidence 0.6; new obs residual -10 with splits.
    const r = blendPersonalRunPaceOffset({
      observedPaceSecKm: 240,
      modelPaceSecKm: 250,
      stationsFromSplits: true,
      existingOffsetSec: -12,
      existingConfidence: 0.6,
    });
    // -12 × 0.4 + (-10) × 0.6 = -4.8 + -6 = -10.8 → -11
    expect(r.offsetSec).toBe(-11);
    expect(r.confidence).toBeLessThanOrEqual(1.0);
    expect(r.confidence).toBeGreaterThan(0.6);
  });

  it('clamps the offset magnitude to ±60 s/km', () => {
    const r = blendPersonalRunPaceOffset({
      observedPaceSecKm: 100,
      modelPaceSecKm: 300,
      stationsFromSplits: true,
    });
    // residual = -200 but clamp at -60.
    expect(r.offsetSec).toBeGreaterThanOrEqual(-60);
  });

  it('positive residuals (model too optimistic) produce positive offsets', () => {
    const r = blendPersonalRunPaceOffset({
      observedPaceSecKm: 260,
      modelPaceSecKm: 240,
      stationsFromSplits: true,
    });
    expect(r.offsetSec).toBeGreaterThan(0);
  });
});

function makeState(opts: { offset?: number; updatedAt?: string }): SimulatorState {
  return {
    hyroxConfig: {
      format: 'open_singles',
      athleteBand: 'intermediate',
      hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0,
      mtlCap: 60,
      mtlHistory: [],
      runsPerWeek: 3,
      stationSessionsPerWeek: 2,
      bricksPerWeek: 1,
      weeklyHoursAvailable: 6,
      personalRunPaceOffsetSec: opts.offset,
      personalRunPaceOffsetUpdatedAtISO: opts.updatedAt,
    },
  } as unknown as SimulatorState;
}

describe('computePersonalRunPaceOffset — decay', () => {
  it('returns 0 when no offset stored', () => {
    expect(computePersonalRunPaceOffset(makeState({}))).toBe(0);
  });

  it('returns 0 when no updatedAt date stored', () => {
    expect(computePersonalRunPaceOffset(makeState({ offset: -15 }))).toBe(0);
  });

  it('returns the full offset when fresh (today)', () => {
    const today = new Date().toISOString();
    expect(computePersonalRunPaceOffset(makeState({ offset: -15, updatedAt: today }))).toBe(-15);
  });

  it('returns 0 when 12+ months old (fully decayed)', () => {
    const oneYearPlusAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 380);
    const r = computePersonalRunPaceOffset(makeState({
      offset: -15, updatedAt: oneYearPlusAgo.toISOString(),
    }));
    expect(r).toBe(0);
  });

  it('decays linearly — 6 months in returns ~50%', () => {
    const sixMonthsAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 182.5);
    const r = computePersonalRunPaceOffset(makeState({
      offset: -20, updatedAt: sixMonthsAgo.toISOString(),
    }));
    expect(r).toBeLessThan(0);
    expect(r).toBeGreaterThan(-15); // ~-10 expected
    expect(r).toBeLessThan(-5);
  });

  it('handles malformed dates gracefully', () => {
    expect(computePersonalRunPaceOffset(makeState({
      offset: -10, updatedAt: 'not-a-date',
    }))).toBe(0);
  });
});
