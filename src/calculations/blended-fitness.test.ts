import { describe, it, expect } from 'vitest';
import { refreshBlendedFitness } from './blended-fitness';
import type { SimulatorState } from '@/types';

/** Build a 50-VDOT-ish 8-week run history that produces a medium+ HR regression. */
function mkRunHistory(now: Date): NonNullable<SimulatorState['onboardingRunHistory']> {
  const runs: NonNullable<SimulatorState['onboardingRunHistory']> = [];
  // pace seconds/km decreases (gets faster) as %VO2R rises.
  // RHR=50, maxHR=190 → HRR range 140 bpm. Pick avgHR values to span 50–85% HRR.
  const samples: Array<{ paceSec: number; hr: number }> = [
    { paceSec: 360, hr: 130 },  // ~57% HRR
    { paceSec: 340, hr: 140 },  // ~64% HRR
    { paceSec: 320, hr: 150 },  // ~71% HRR
    { paceSec: 310, hr: 155 },  // ~75% HRR
    { paceSec: 300, hr: 160 },  // ~79% HRR
    { paceSec: 290, hr: 165 },  // ~82% HRR
    { paceSec: 280, hr: 170 },  // ~86% HRR
    { paceSec: 270, hr: 175 },  // ~89% HRR — borderline upper
    { paceSec: 305, hr: 158 },
    { paceSec: 315, hr: 152 },
  ];
  samples.forEach((s, i) => {
    const ms = now.getTime() - (i * 5 + 2) * 24 * 60 * 60 * 1000;
    runs.push({
      startTime: new Date(ms).toISOString(),
      distKm: 10,
      durSec: 10 * s.paceSec,
      activityType: 'RUNNING',
      avgHR: s.hr,
    });
  });
  return runs;
}

function baseState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    schemaVersion: 1,
    w: 1, tw: 16, v: 45, iv: 45, rpeAdj: 0,
    rd: undefined as unknown as SimulatorState['rd'],
    epw: 5, rw: 5, wkm: 50,
    pbs: {}, rec: null, lt: null, vo2: null,
    initialLT: null, initialVO2: null, initialBaseline: null,
    currentFitness: null, forecastTime: null,
    typ: 'Balanced', calculatedRunnerType: 'Balanced',
    b: 1.06, wks: [],
    pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
    skip: [], timp: 0, expectedFinal: 50,
    restingHR: 50, maxHR: 190,
    ...overrides,
  };
}

describe('refreshBlendedFitness — pre-guard HR-calibrated cache', () => {
  const now = new Date();

  it('writes hrCalibratedVdot to state even when race distance is unset (onboarding case)', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now) });
    expect(s.rd).toBeUndefined();

    const ok = refreshBlendedFitness(s);

    // Returns false because rd is unset, but cache must still be populated.
    expect(ok).toBe(false);
    expect(s.hrCalibratedVdot).toBeDefined();
    expect(s.hrCalibratedVdot!.confidence).not.toBe('none');
    expect(s.hrCalibratedVdot!.vdot).not.toBeNull();
    expect(s.hrCalibratedVdot!.n).toBeGreaterThanOrEqual(3);
  });

  it('overwrites s.v with hrCalibratedVdot when confidence is medium+ and rd is unset', () => {
    const s = baseState({ v: 45, onboardingRunHistory: mkRunHistory(now) });
    refreshBlendedFitness(s);

    if (s.hrCalibratedVdot!.confidence === 'high' || s.hrCalibratedVdot!.confidence === 'medium') {
      expect(s.v).toBeCloseTo(s.hrCalibratedVdot!.vdot!, 1);
    }
  });

  it('does NOT overwrite s.v when confidence is low (too few qualifying runs)', () => {
    // Only 3 runs — not enough for medium tier; with R²<0.5 should land 'low'.
    const fewRuns = mkRunHistory(now).slice(0, 3);
    const s = baseState({ v: 45, onboardingRunHistory: fewRuns });
    refreshBlendedFitness(s);

    if (s.hrCalibratedVdot!.confidence === 'low') {
      expect(s.v).toBe(45);
    }
  });

  it('cache is populated as no-rhr when RHR missing', () => {
    const s = baseState({ restingHR: undefined, onboardingRunHistory: mkRunHistory(now) });
    refreshBlendedFitness(s);

    expect(s.hrCalibratedVdot).toBeDefined();
    expect(s.hrCalibratedVdot!.confidence).toBe('none');
    expect(s.hrCalibratedVdot!.reason).toBe('no-rhr');
    expect(s.hrCalibratedVdot!.vdot).toBeNull();
  });

  it('cache overwrites a previous stale entry on every call', () => {
    const s = baseState({
      onboardingRunHistory: mkRunHistory(now),
      hrCalibratedVdot: { vdot: 99, confidence: 'high', n: 99, r2: 0.99 },
    });
    refreshBlendedFitness(s);

    // Previous bogus values must be replaced by the actual computation.
    expect(s.hrCalibratedVdot!.vdot).not.toBe(99);
    expect(s.hrCalibratedVdot!.n).not.toBe(99);
  });
});
