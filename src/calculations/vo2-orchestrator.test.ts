import { describe, it, expect } from 'vitest';
import { computeVO2Estimates } from './vo2-orchestrator';
import type { SimulatorState, Week, GarminActual } from '@/types';

const NOW = new Date('2026-05-01T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString();

function mkState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    w: 3,
    tw: 12,
    v: 45,
    iv: 45,
    rpeAdj: 0,
    expectedFinal: 48,
    rd: 'marathon' as any,
    epw: 5,
    rw: 4,
    wkm: 50,
    pbs: {} as any,
    rec: null,
    lt: null,
    vo2: null,
    initialLT: null,
    initialVO2: null,
    initialBaseline: null,
    currentFitness: null,
    forecastTime: null,
    typ: 'balanced' as any,
    b: 1.06,
    wks: [],
    pac: { e: 330 } as any,
    skip: [],
    timp: 0,
    restingHR: 50,
    maxHR: 195,
    bodyWeightKg: 75,
    biologicalSex: 'male',
    ...overrides,
  } as SimulatorState;
}

function mkWeek(actuals: Record<string, GarminActual>): Week {
  return {
    w: 1,
    ph: 'build' as any,
    workouts: [],
    targetTSS: 0,
    actualTSS: 0,
    garminActuals: actuals,
  } as any as Week;
}

function mkActual(opts: Partial<GarminActual> & { id: string; daysAgo: number; activityType: string }): [string, GarminActual] {
  const { id, daysAgo: ago, ...rest } = opts;
  return [id, {
    garminId: id,
    startTime: daysAgo(ago),
    distanceKm: 0,
    durationSec: 1800,
    avgPaceSecKm: null,
    avgHR: null,
    maxHR: null,
    calories: null,
    ...rest,
  } as GarminActual];
}

describe('vo2 orchestrator', () => {
  it('returns null per-source for unsupported modalities, lifts running via physio fallback', () => {
    const r = computeVO2Estimates(mkState({ wks: [], v: 45 }), NOW);
    // Direct HR-calibrated regression null (no qualifying runs) → orchestrator
    // falls back to getPhysiologicalVdot() which walks LT → PB → Tanda. State
    // has no LT/PBs but has s.v=45 → Tanda tier resolves and running gets 45.
    expect(r.running.value).toBe(45);
    expect(r.cycling.value).toBeNull();
    expect(r.cardiac.value).toBeNull();
    expect(r.headline.value).toBe(45);
    expect(r.headline.sport).toBe('running');
  });

  it('returns null headline when no inputs AND no s.v', () => {
    const r = computeVO2Estimates(mkState({ wks: [], v: 0 }), NOW);
    expect(r.headline.value).toBeNull();
  });

  it('padel-only user (HR-only): running null, cycling null, headline = cardiac', () => {
    // No qualifying running data (only one short run) and no FTP. Cardiac
    // ceiling fires from HR data. Headline falls through to cardiac as the
    // tier-2 fallback because measured-modality tier-1 has nothing.
    const padelActuals = Object.fromEntries(Array.from({ length: 8 }).map((_, i) =>
      mkActual({ id: `p${i}`, daysAgo: i * 4, activityType: 'padel', maxHR: 195, avgHR: 165, durationSec: 3600 })
    ));
    const r = computeVO2Estimates(mkState({ wks: [mkWeek(padelActuals)], v: 0 }), NOW);
    expect(r.cardiac.value).toBeGreaterThan(0);
    expect(r.cycling.value).toBeNull();
    // Headline picks cardiac when measured-modality has nothing
    expect(r.headline.sport).toBe('cardiac');
    expect(r.headline.value).toBeCloseTo(r.cardiac.value!, 5);
  });

  it('headline = max(running, cycling) — cardiac never claims headline when measured modalities have data', () => {
    // Cardiac ceiling ≈ 59.7. Add cycling FTP so cycling-direct fires.
    // No running. Headline should = cycling-direct, NOT cardiac, even though
    // cardiac is higher — cardiac is informational only.
    const padelActuals = Object.fromEntries(Array.from({ length: 8 }).map((_, i) =>
      mkActual({ id: `p${i}`, daysAgo: i * 4, activityType: 'padel', maxHR: 195, avgHR: 165, durationSec: 3600 })
    ));
    const r = computeVO2Estimates(mkState({
      wks: [mkWeek(padelActuals)],
      triConfig: { bike: { ftp: 280, ftpConfidence: 'high' as const } } as any,
    }), NOW);
    expect(r.cardiac.value).toBeGreaterThan(0);
    expect(r.cycling.value).not.toBeNull();
    // Even if cardiac > cycling, headline picks cycling (a measured modality)
    expect(r.headline.sport).toBe('cycling');
    expect(r.headline.value).toBeCloseTo(r.cycling.value!, 5);
  });

  it('cycling estimate produced when FTP is set on triConfig', () => {
    const r = computeVO2Estimates(mkState({
      triConfig: {
        bike: { ftp: 280, ftpConfidence: 'high' as const },
      } as any,
    }), NOW);
    // 10.8 × 280/75 + 7 ≈ 47.3
    expect(r.cycling.value).toBeCloseTo(47.3, 0);
    expect(r.cycling.source).toBe('acsm-ftp');
  });

  it('returns null headline when no measured-modality, no cardiac, and no s.v', () => {
    const r = computeVO2Estimates(mkState({ wks: [], v: 0 }), NOW);
    expect(r.headline.value).toBeNull();
  });
});
