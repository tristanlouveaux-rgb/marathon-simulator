import { describe, it, expect } from 'vitest';
import { refreshBlendedFitness, predictStandardDistances, getStandardForecastDetail } from './blended-fitness';
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
    { paceSec: 270, hr: 175 },  // ~89% HRR. Borderline upper
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
    // Only 3 runs. Not enough for medium tier; with R²<0.5 should land 'low'.
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

describe('predictStandardDistances — no-target-race forecast', () => {
  const now = new Date();

  it('returns a time for every standard distance from run history alone (no target race)', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now) });
    expect(s.rd).toBeUndefined();

    const preds = predictStandardDistances(s);

    for (const dist of ['5k', '10k', 'half', 'marathon'] as const) {
      expect(preds[dist]).not.toBeNull();
      expect(preds[dist]!).toBeGreaterThan(0);
      expect(isFinite(preds[dist]!)).toBe(true);
    }
  });

  it('predicts a longer time for longer distances (monotonic)', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now) });
    const p = predictStandardDistances(s);
    expect(p['5k']!).toBeLessThan(p['10k']!);
    expect(p['10k']!).toBeLessThan(p['half']!);
    expect(p['half']!).toBeLessThan(p['marathon']!);
  });

  it('supershoes apply a ~3% faster prediction than standard shoes', () => {
    const std = predictStandardDistances(baseState({ onboardingRunHistory: mkRunHistory(now), shoeKind: 'standard' }));
    const carbon = predictStandardDistances(baseState({ onboardingRunHistory: mkRunHistory(now), shoeKind: 'supershoes' }));
    // Ratio is exactly the 0.97 shoe multiplier (calibration/durability identical).
    expect(carbon['10k']! / std['10k']!).toBeCloseTo(0.97, 3);
  });

  it('returns all-null for a just-track user with no PBs', () => {
    const s = baseState({ trackOnly: true, pbs: {} });
    const preds = predictStandardDistances(s);
    expect(preds['5k']).toBeNull();
    expect(preds['marathon']).toBeNull();
  });
});

describe('getStandardForecastDetail — per-distance drill-down', () => {
  const now = new Date();

  it('headline predictedSec matches the grid prediction for the same distance', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now) });
    const grid = predictStandardDistances(s);
    const detail = getStandardForecastDetail(s, '10k');
    expect(detail.predictedSec).toBe(grid['10k']);
  });

  it('builds a trend point per recorded VDOT-history week (longer time at longer distance)', () => {
    const s = baseState({
      onboardingRunHistory: mkRunHistory(now),
      vdotHistory: [
        { week: 1, vdot: 48, date: '2026-05-01' },
        { week: 2, vdot: 49, date: '2026-05-08' },
        { week: 3, vdot: 50, date: '2026-05-15' },
      ],
    });
    const fiveK = getStandardForecastDetail(s, '5k');
    const marathon = getStandardForecastDetail(s, 'marathon');
    expect(fiveK.trend).toHaveLength(3);
    // Same VDOT, longer distance → larger predicted time at each point.
    expect(marathon.trend[0].value).toBeGreaterThan(fiveK.trend[0].value);
    // Rising VDOT → falling predicted time over the weeks.
    expect(fiveK.trend[2].value).toBeLessThan(fiveK.trend[0].value);
  });

  it('reports durability and calibration factor state', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now) });
    const detail = getStandardForecastDetail(s, 'marathon');
    expect(detail.durabilityMultiplier).toBeGreaterThanOrEqual(1);
    expect(detail.calibrationBiasSec).toBeNull(); // no logged races in baseState
    expect(detail.vdot).not.toBeNull();
  });
});

describe('manual VO2max override flows through to predictions', () => {
  const now = new Date();

  it('changing vo2Override moves the standard-distance prediction', () => {
    const base = { onboardingRunHistory: mkRunHistory(now), pbs: { k5: 1200 } };
    const low = predictStandardDistances(baseState({ ...base, vo2Override: { value: 45, setAt: now.toISOString() } }));
    const high = predictStandardDistances(baseState({ ...base, vo2Override: { value: 60, setAt: now.toISOString() } }));
    // A higher VO2max must predict a faster (smaller) time at every distance.
    expect(high['5k']!).toBeLessThan(low['5k']!);
    expect(high['marathon']!).toBeLessThan(low['marathon']!);
  });

  it('override is honoured over a stale device s.vo2', () => {
    const base = { onboardingRunHistory: mkRunHistory(now), pbs: { k5: 1200 } };
    // Device VO2 low, override high → prediction should reflect the override (faster).
    const overridden = predictStandardDistances(baseState({ ...base, vo2: 45, vo2Override: { value: 62, setAt: now.toISOString() } }));
    const deviceOnly = predictStandardDistances(baseState({ ...base, vo2: 45 }));
    expect(overridden['10k']!).toBeLessThan(deviceOnly['10k']!);
  });
});

describe('refreshBlendedFitness — records VDOT history for no-race users', () => {
  const now = new Date();

  it('appends a vdotHistory point even when no race distance is set', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now) });
    expect(s.rd).toBeUndefined();
    expect(s.vdotHistory ?? []).toHaveLength(0);

    refreshBlendedFitness(s);

    expect((s.vdotHistory ?? []).length).toBeGreaterThanOrEqual(1);
    expect(s.vdotHistory![0].vdot).toBeGreaterThan(0);
  });
});
