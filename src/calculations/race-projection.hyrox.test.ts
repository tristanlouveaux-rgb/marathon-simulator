import { describe, expect, it } from 'vitest';
import { buildHyroxProjection } from './race-projection.hyrox';
import { predictHyroxRace } from './race-prediction.hyrox';
import type { SimulatorState } from '@/types/state';

function buildState(overrides: Partial<SimulatorState['hyroxConfig']> = {}, extra: Partial<SimulatorState> = {}): SimulatorState {
  return {
    hyroxConfig: {
      format: 'open_singles',
      athleteBand: 'intermediate',
      hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0,
      mtlCap: 1300,
      mtlHistory: [],
      runsPerWeek: 3,
      stationSessionsPerWeek: 2,
      bricksPerWeek: 1,
      weeklyHoursAvailable: 8,
      ...overrides,
    },
    w: 1,
    wks: [],
    ...extra,
  } as unknown as SimulatorState;
}

describe('buildHyroxProjection', () => {
  it('returns same time when no factors fire', () => {
    const s = buildState();
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    // No race date → weeksRemaining = 0, no taper bonus.
    // No mtlCTL → no fitness factor. Default sessions match band → no volume factor.
    // No history → adherence = 1.0 → no penalty.
    expect(proj.projectedTotalSec).toBe(p.totalSec);
    expect(proj.factors.length).toBe(0);
  });

  it('applies a fitness bonus when MTL CTL is above band anchor', () => {
    const s = buildState({ mtlCTL: 200 });  // intermediate anchor ~ 130
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    expect(proj.improvementSec).toBeLessThan(0);
    const fitnessFactor = proj.factors.find(f => f.name === 'Training fitness');
    expect(fitnessFactor).toBeDefined();
    expect(fitnessFactor!.deltaSec).toBeLessThan(0);
  });

  it('applies a fitness penalty when MTL CTL is below band anchor', () => {
    const s = buildState({ mtlCTL: 50 });  // below intermediate anchor
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    expect(proj.improvementSec).toBeGreaterThan(0);
    const fitnessFactor = proj.factors.find(f => f.name === 'Training fitness');
    expect(fitnessFactor!.deltaSec).toBeGreaterThan(0);
  });

  it('applies a taper bonus when race is within taper window', () => {
    const tomorrow7d = new Date();
    tomorrow7d.setDate(tomorrow7d.getDate() + 7);
    const raceDate = tomorrow7d.toISOString().slice(0, 10);
    const s = buildState({ raceDate });
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    const taperFactor = proj.factors.find(f => f.name === 'Taper bonus');
    expect(taperFactor).toBeDefined();
    expect(taperFactor!.deltaSec).toBeLessThan(0); // bonus = faster
  });

  it('confidence range widens for far-out races and low confidence', () => {
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 16 * 7);
    const raceDate = farFuture.toISOString().slice(0, 10);
    const s = buildState({ raceDate }); // no calibration → low confidence
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    const halfRange = (proj.confidenceRangeSec[1] - proj.confidenceRangeSec[0]) / 2;
    // Base 4% + 1% (>4w) + 1% (>12w) + 2% (low conf) = 8% → halfRange ≈ 8% of total
    expect(halfRange).toBeGreaterThan(p.totalSec * 0.06);
  });
});
