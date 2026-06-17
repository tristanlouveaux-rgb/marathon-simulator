import { describe, it, expect } from 'vitest';
import { refreshBlendedFitness, predictStandardDistances, getStandardForecastDetail, getStandardForecastProjection } from './blended-fitness';
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

describe('refreshBlendedFitness — race-validated anchor (triathlete bug)', () => {
  // A 1:55-half triathlete: watch VO2max 56 (inflated by cycling/swimming), no
  // running PBs, no recent standalone runs. A recent 70.3 implies run VDOT ~43.
  // Without the anchor, the watch-driven blend collapses s.v to ~56 and every
  // training pace / the marathon forecast comes out far too fast.
  const recentMonth = new Date().toISOString().slice(0, 7);  // YYYY-MM (recent)
  const today = new Date().toISOString().slice(0, 10);

  function triNoRunHistory(overrides: Partial<SimulatorState> = {}): SimulatorState {
    return baseState({
      rd: 'marathon',  // tri mode forces the placeholder distance
      pbs: {},
      vo2: 56,
      vo2UpdatedAt: today,
      physiologyHistory: [{ date: today, vo2max: 56 }] as SimulatorState['physiologyHistory'],
      onboardingRunHistory: undefined,
      ...overrides,
    });
  }

  it('caps s.v to the race VDOT when the watch overstates and nothing corroborates it', () => {
    const s = triNoRunHistory({
      raceRunVdot: { vdot: 43, dateISO: recentMonth, distance: '70.3', source: 'onboarding-past-race' },
    });
    const ok = refreshBlendedFitness(s);
    expect(ok).toBe(true);
    expect(s.v).toBeCloseTo(43, 1);
    expect(s.blendedEffectiveVdot).toBeCloseTo(43, 1);
  });

  it('without the anchor, the same watch-driven state does NOT land at the race value', () => {
    const s = triNoRunHistory();  // no raceRunVdot
    refreshBlendedFitness(s);
    // The watch (56) is not pulled down to 43 absent a race anchor.
    expect(s.v).toBeGreaterThan(45);
  });

  it('a stale race (>365 days) stands down — anchor does not pin s.v', () => {
    const s = triNoRunHistory({
      raceRunVdot: { vdot: 43, dateISO: '2020-01', distance: '70.3', source: 'onboarding-past-race' },
    });
    refreshBlendedFitness(s);
    expect(s.v).toBeGreaterThan(45);
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

  it('predicts for a track-only user with a resolved VDOT but no PBs (matches the Stats VO2 bar gate)', () => {
    // Canonical-gate behaviour: the forecast shows whenever there is a running-
    // fitness signal (here the baseline VDOT v:45), even with no PBs/device/LT.
    // The Daniels fallback predicts from that VDOT alone, so this surface stays
    // in lock-step with the Stats "VO2 Max" bar, which shows from the same value.
    const s = baseState({ trackOnly: true, pbs: {}, v: 45 });
    const preds = predictStandardDistances(s);
    expect(preds['5k']).not.toBeNull();
    expect(preds['marathon']).not.toBeNull();
    expect(preds['5k']!).toBeLessThan(preds['marathon']!);
  });

  it('returns all-null when there is no running-fitness signal at all', () => {
    // No VDOT (v:0), no PBs, no device VO2, no LT, no run history → nothing to
    // resolve. Both this grid and the Stats bar hide together (consistent empty).
    const s = baseState({ trackOnly: true, pbs: {}, v: 0, iv: 0 });
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

  it('waterfall stages reconcile to the hero (finalSec === predictedSec)', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now) });
    const detail = getStandardForecastDetail(s, '5k');
    expect(detail.stages).not.toBeNull();
    const st = detail.stages!;
    // The hero IS the last stage.
    expect(st.finalSec).toBe(detail.predictedSec);
    // The staged chain reconstructs the final to floating-point precision.
    const chain = st.calibratedSec * st.durability.multiplier * st.shoeMul;
    expect(chain).toBeCloseTo(st.finalSec, 6);
  });

  it('supershoes stage shifts the final by the 3% boost', () => {
    const std = getStandardForecastDetail(baseState({ onboardingRunHistory: mkRunHistory(now), shoeKind: 'standard' }), '10k');
    const carbon = getStandardForecastDetail(baseState({ onboardingRunHistory: mkRunHistory(now), shoeKind: 'supershoes' }), '10k');
    expect(std.stages!.shoeMul).toBe(1.0);
    expect(carbon.stages!.shoeMul).toBe(0.97);
    // Capacity blend is identical; only the shoe multiplier moves the final.
    expect(carbon.stages!.blendedSec).toBeCloseTo(std.stages!.blendedSec, 6);
    expect(carbon.stages!.finalSec).toBeLessThan(std.stages!.finalSec);
  });
});

describe('getStandardForecastProjection — plan-progression forward forecast', () => {
  const now = new Date();

  it('returns weeks+1 points (0..weeks); index 0 is current fitness', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now), rw: 5 });
    const proj = getStandardForecastProjection(s, '5k', 8);
    expect(proj).not.toBeNull();
    expect(proj!).toHaveLength(9);
    expect(proj![0].weeksAhead).toBe(0);
    expect(proj![8].weeksAhead).toBe(8);
  });

  it('projects monotonic improvement (later weeks no slower than earlier)', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now), rw: 5 });
    const proj = getStandardForecastProjection(s, '5k', 12)!;
    for (let i = 1; i < proj.length; i++) {
      expect(proj[i].value).toBeLessThanOrEqual(proj[i - 1].value + 1e-6);
    }
    // A 12-week hold yields a real gain over today.
    expect(proj[proj.length - 1].value).toBeLessThan(proj[0].value);
  });

  it('rises from week 1 — no dead-flat start then a kink (saturating shape)', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now), rw: 5 });
    const proj = getStandardForecastProjection(s, 'half', 12)!;
    // Week 1 already shows improvement (adaptation begins immediately), and the
    // early gain per week is no smaller than the late gain (concave, fastest
    // early — the dual-tau saturation, not a flat lag then linear ramp).
    expect(proj[1].value).toBeLessThan(proj[0].value);
    const earlyStep = proj[0].value - proj[1].value; // wk0 → wk1 (positive = faster)
    const lateStep = proj[proj.length - 2].value - proj[proj.length - 1].value;
    expect(earlyStep).toBeGreaterThan(0);
    expect(earlyStep).toBeGreaterThanOrEqual(lateStep - 1e-6);
  });

  it('a longer horizon forecasts a faster time than a shorter one', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now), rw: 5 });
    const four = getStandardForecastProjection(s, '5k', 4)!;
    const twelve = getStandardForecastProjection(s, '5k', 12)!;
    expect(twelve[twelve.length - 1].value).toBeLessThan(four[four.length - 1].value);
    // Both share the same anchor ("now").
    expect(twelve[0].value).toBeCloseTo(four[0].value, 6);
  });

  it('returns null when there is no plan to project along (rw = 0)', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now), rw: 0 });
    expect(getStandardForecastProjection(s, '5k', 8)).toBeNull();
  });

  it('returns null when there is no VDOT', () => {
    const s = baseState({ onboardingRunHistory: mkRunHistory(now), v: 0, rw: 5 });
    expect(getStandardForecastProjection(s, '5k', 8)).toBeNull();
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

describe('refreshBlendedFitness — engine/readiness separation + peak-volume forecast (ISSUE-297)', () => {
  // 20:00 5K (VDOT ~49.8) and nothing else, 8 km/wk typed, marathon target.
  // The classic ISSUE-297 case: a strong engine off thin running volume.
  const lowVolume5kOnly = (): SimulatorState => baseState({
    rd: 'marathon', tw: 20, w: 1,
    rw: 2, epw: 2, wkm: 8, detectedWeeklyKm: 8,
    pbs: { k5: 1200 }, rec: null, lt: null, vo2: null,
    typ: 'Balanced', v: 49.8, iv: 49.8,
    pac: { e: 300, t: 250, i: 225, m: 270, r: 215 },
  });

  it('holds the engine at demonstrated PB capacity instead of burying it with the volume penalty', () => {
    const s = lowVolume5kOnly();
    const ok = refreshBlendedFitness(s);
    expect(ok).toBe(true);
    // Capacity from a 20:00 5K is VDOT ~49.8. The low-volume marathon penalty
    // must not collapse the engine to ~40 (the pre-fix behaviour).
    expect(s.v).toBeGreaterThanOrEqual(48);
    expect(s.blendedEffectiveVdot).toBeGreaterThanOrEqual(48);
  });

  it('keeps today’s race estimate honestly slow off 8 km/wk (readiness penalty stays on the prediction)', () => {
    const s = lowVolume5kOnly();
    refreshBlendedFitness(s);
    // tv(49.8, marathon) ≈ 3:09; the low-volume penalty correctly slows TODAY.
    expect(s.blendedRaceTimeSec!).toBeGreaterThan(3 * 3600 + 20 * 60); // slower than 3:20
  });

  it('forecast credits the plan’s volume ramp — projects materially faster than today', () => {
    const s = lowVolume5kOnly();
    refreshBlendedFitness(s);
    // The forecast assumes the plan builds the athlete to its peak volume, so the
    // penalty lifts and the race-day projection beats the thin-volume "today".
    expect(s.forecastTime!).toBeLessThan(s.blendedRaceTimeSec! - 15 * 60); // ≥15 min faster
  });

  it('is deterministic: repeated refreshes do not drift (no feedback loop)', () => {
    const s = lowVolume5kOnly();
    refreshBlendedFitness(s);
    const v1 = s.v, today1 = s.blendedRaceTimeSec, fc1 = s.forecastTime, lt1 = s.lt;
    for (let i = 0; i < 4; i++) refreshBlendedFitness(s);
    expect(s.v).toBeCloseTo(v1!, 3);
    expect(s.blendedRaceTimeSec).toBeCloseTo(today1!, 3);
    expect(s.forecastTime).toBeCloseTo(fc1!, 3);
    expect(s.lt).toBeCloseTo(lt1!, 3);
  });

  it('no regression: a recent run proving real slowness DOES lower the engine below PB capacity', () => {
    // Same 20:00 5K PB, but a recent ~30:00 5K-equivalent run + low real volume:
    // genuine detraining evidence, so the engine is allowed below capacity.
    const s = baseState({
      rd: 'marathon', tw: 20, w: 1,
      rw: 2, epw: 2, wkm: 8, detectedWeeklyKm: 8,
      pbs: { k5: 1200 },
      rec: { d: 5, t: 1800, weeksAgo: 1 }, // 30:00 5K, fresh — demonstrates slowness
      lt: null, vo2: null, typ: 'Balanced', v: 49.8, iv: 49.8,
      pac: { e: 300, t: 250, i: 225, m: 270, r: 215 },
    });
    refreshBlendedFitness(s);
    // Recent demonstrated slowness overrides the capacity floor.
    expect(s.v!).toBeLessThan(48);
  });
});
