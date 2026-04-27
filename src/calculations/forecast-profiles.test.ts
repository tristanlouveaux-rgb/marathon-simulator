import { describe, it, expect } from 'vitest';
import { blendPredictions } from './predictions';
import { applyTrainingHorizonAdjustment } from './training-horizon';
import { cv, tv, rd, rdKm } from './vdot';
import { calculateFatigueExponent, getRunnerType, getAbilityBand } from './fatigue';
import type { PBs, RecentRun, RaceDistance, RunnerType } from '@/types';

// ──────────────── Helpers ────────────────

interface RecurringActivity {
  durMin: number;
  intensity: 'easy' | 'moderate' | 'hard';
  freq: number;
}

interface TestProfile {
  name: string;
  pbs: PBs;
  recentRace: RecentRun | null;
  ltPace: number | null;
  vo2max: number | null;
  confirmedRunnerType: RunnerType | null;
  experienceLevel: string;
  runsPerWeek: number;
  recurringActivities: RecurringActivity[];
  activeLifestyle: boolean;
  planDurationWeeks: number;
  raceDistance: RaceDistance;
  baselineRange: [number, number];
  forecastRange: [number, number];
}

const INTENSITY_FACTOR: Record<string, number> = {
  easy: 0.5, moderate: 0.7, hard: 0.9,
};

function computeEffectiveSessions(p: Pick<TestProfile, 'runsPerWeek' | 'recurringActivities' | 'activeLifestyle'>): number {
  let eff = p.runsPerWeek;
  for (const a of p.recurringActivities) {
    eff += (a.durMin / 60) * INTENSITY_FACTOR[a.intensity] * a.freq;
  }
  if (p.activeLifestyle) eff += 0.5;
  return eff;
}

interface PipelineResult {
  success: boolean;
  blendedTime: number;
  baselineVdot: number;
  forecastVdot: number;
  forecastTime: number;
  b: number;
  runnerType: RunnerType;
  improvementPct: number;
  components: {
    week_factor: number;
    session_factor: number;
    type_modifier: number;
    undertrain_penalty: number;
    taper_bonus: number;
  };
}

function runFullPipeline(p: Pick<TestProfile, 'pbs' | 'recentRace' | 'ltPace' | 'vo2max' | 'confirmedRunnerType' | 'experienceLevel' | 'runsPerWeek' | 'recurringActivities' | 'activeLifestyle' | 'planDurationWeeks' | 'raceDistance'>): PipelineResult {
  const b = calculateFatigueExponent(p.pbs);
  const runnerType = p.confirmedRunnerType || getRunnerType(b);
  const targetDistM = rd(p.raceDistance);

  const blendedTime = blendPredictions(
    targetDistM, p.pbs, p.ltPace, p.vo2max, b, runnerType, p.recentRace
  );

  if (blendedTime === null || blendedTime <= 0) {
    return { success: false } as PipelineResult;
  }

  const baselineVdot = cv(targetDistM, blendedTime);
  const abilityBand = getAbilityBand(baselineVdot);
  const sessions = computeEffectiveSessions(p);
  const taperWeeks = p.raceDistance === 'marathon' ? 3 : 2;

  const horizon = applyTrainingHorizonAdjustment({
    baseline_vdot: baselineVdot,
    target_distance: p.raceDistance,
    weeks_remaining: p.planDurationWeeks,
    sessions_per_week: sessions,
    runner_type: runnerType,
    ability_band: abilityBand,
    taper_weeks: taperWeeks,
    experience_level: p.experienceLevel,
    hm_pb_seconds: p.pbs.h,
  });

  const forecastVdot = baselineVdot + horizon.vdot_gain;
  const forecastTime = tv(forecastVdot, rdKm(p.raceDistance));

  return {
    success: true,
    blendedTime,
    baselineVdot,
    forecastVdot,
    forecastTime,
    b,
    runnerType,
    improvementPct: horizon.improvement_pct,
    components: horizon.components,
  };
}

/** Format seconds as H:MM:SS or MM:SS for readable assertion messages */
function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ──────────────── 12 Test Profiles ────────────────

const PROFILES: TestProfile[] = [
  {
    name: '1. Total Beginner 5K',
    pbs: { k5: 1920 },
    recentRace: null, ltPace: null, vo2max: null,
    confirmedRunnerType: null,
    experienceLevel: 'total_beginner',
    runsPerWeek: 2, recurringActivities: [], activeLifestyle: false,
    planDurationWeeks: 8, raceDistance: '5k',
    baselineRange: [1800, 2040],
    forecastRange: [1620, 1980],
  },
  {
    name: '2. Beginner Marathon',
    pbs: { k5: 1500 },
    recentRace: null, ltPace: null, vo2max: null,
    confirmedRunnerType: null,
    experienceLevel: 'beginner',
    runsPerWeek: 3, recurringActivities: [], activeLifestyle: false,
    planDurationWeeks: 12, raceDistance: 'marathon',
    baselineRange: [13800, 18000],
    forecastRange: [13200, 17700],
  },
  {
    name: '3. Novice Half',
    pbs: { k5: 1380, k10: 2880 },
    recentRace: null, ltPace: null, vo2max: null,
    confirmedRunnerType: null,
    experienceLevel: 'novice',
    runsPerWeek: 4, recurringActivities: [], activeLifestyle: false,
    planDurationWeeks: 16, raceDistance: 'half',
    baselineRange: [6120, 7200],
    forecastRange: [5700, 7080],
  },
  {
    name: '4. Intermediate Marathon',
    pbs: { k5: 1200, k10: 2520, h: 5700, m: 12000 },
    recentRace: null, ltPace: 240, vo2max: 50,
    confirmedRunnerType: null,
    experienceLevel: 'intermediate',
    runsPerWeek: 5,
    recurringActivities: [{ durMin: 45, intensity: 'moderate' as const, freq: 1 }],
    activeLifestyle: false,
    planDurationWeeks: 20, raceDistance: 'marathon',
    baselineRange: [10800, 13200],
    forecastRange: [10080, 12600],
  },
  {
    name: '5. Competitive Half',
    pbs: { k5: 1020, k10: 2130, h: 4800 },
    recentRace: { d: 10, t: 2160, weeksAgo: 3 },
    ltPace: 215, vo2max: 58,
    confirmedRunnerType: null,
    experienceLevel: 'competitive',
    runsPerWeek: 6,
    recurringActivities: [{ durMin: 45, intensity: 'moderate' as const, freq: 2 }],
    activeLifestyle: false,
    planDurationWeeks: 12, raceDistance: 'half',
    baselineRange: [4500, 5400],
    forecastRange: [4320, 5280],
  },
  {
    name: '6. Returning Runner',
    pbs: { k5: 1140, k10: 2400, h: 5280 },
    recentRace: { d: 5, t: 1440, weeksAgo: 4 },
    ltPace: null, vo2max: null,
    confirmedRunnerType: null,
    experienceLevel: 'returning',
    runsPerWeek: 4, recurringActivities: [], activeLifestyle: false,
    planDurationWeeks: 16, raceDistance: 'half',
    baselineRange: [5400, 7200],
    forecastRange: [4920, 6900],
  },
  {
    name: '7. Speed → Marathon',
    pbs: { k5: 1080, k10: 2280 },
    recentRace: null, ltPace: 225, vo2max: null,
    confirmedRunnerType: 'Speed',
    experienceLevel: 'intermediate',
    runsPerWeek: 5, recurringActivities: [], activeLifestyle: false,
    planDurationWeeks: 20, raceDistance: 'marathon',
    baselineRange: [10080, 12900],  // 2:48–3:35; 18:00 5K + LT 3:45/km predicts ~2:51:50
    forecastRange: [9600, 12300],   // lower bound: marathon max_gain reduced (audit #10)
  },
  {
    name: '8. Endurance → 5K',
    pbs: { k5: 1320, k10: 2640, m: 11100 },
    recentRace: null, ltPace: 245, vo2max: null,
    confirmedRunnerType: 'Endurance',
    experienceLevel: 'intermediate',
    runsPerWeek: 5, recurringActivities: [], activeLifestyle: false,
    planDurationWeeks: 16, raceDistance: '5k',
    baselineRange: [1140, 1380],
    forecastRange: [1050, 1320],
  },
  {
    name: '9. Low Vol + Cross',
    pbs: { k5: 1440, k10: 3000 },
    recentRace: null, ltPace: null, vo2max: null,
    confirmedRunnerType: null,
    experienceLevel: 'novice',
    runsPerWeek: 2,
    recurringActivities: [{ durMin: 60, intensity: 'moderate' as const, freq: 3 }],
    activeLifestyle: false,
    planDurationWeeks: 16, raceDistance: 'half',
    baselineRange: [6480, 8100],
    forecastRange: [5880, 7800],
  },
  {
    name: '10. High Vol Advanced',
    pbs: { k5: 1050, k10: 2190, h: 4920, m: 10500 },
    recentRace: { d: 21.097, t: 4980, weeksAgo: 6 },
    ltPace: 220, vo2max: 58,
    confirmedRunnerType: null,
    experienceLevel: 'advanced',
    runsPerWeek: 7,
    recurringActivities: [{ durMin: 45, intensity: 'moderate' as const, freq: 2 }],
    activeLifestyle: false,
    planDurationWeeks: 24, raceDistance: 'marathon',
    baselineRange: [9900, 11400],
    forecastRange: [9300, 11100],
  },
  {
    name: '11. Year-Long Beginner',
    pbs: { k5: 1680 },
    recentRace: null, ltPace: null, vo2max: null,
    confirmedRunnerType: null,
    experienceLevel: 'beginner',
    runsPerWeek: 3, recurringActivities: [], activeLifestyle: false,
    planDurationWeeks: 52, raceDistance: 'marathon',
    baselineRange: [16000, 20400],
    forecastRange: [13800, 19200],
  },
  {
    name: '12. Active Non-Runner',
    pbs: { k5: 1800 },
    recentRace: null, ltPace: null, vo2max: null,
    confirmedRunnerType: null,
    experienceLevel: 'total_beginner',
    runsPerWeek: 3,
    recurringActivities: [{ durMin: 45, intensity: 'moderate' as const, freq: 2 }],
    activeLifestyle: true,
    planDurationWeeks: 16, raceDistance: 'half',
    baselineRange: [7500, 10200],
    forecastRange: [6900, 9900],
  },
];

// ──────────────── Block 1: Per-profile pipeline tests ────────────────

describe('Per-profile pipeline tests', () => {
  for (const p of PROFILES) {
    it(p.name, () => {
      const r = runFullPipeline(p);
      expect(r.success, 'pipeline should succeed').toBe(true);

      // Blended time within baseline range
      expect(
        r.blendedTime,
        `baseline ${fmt(r.blendedTime)} should be in [${fmt(p.baselineRange[0])}, ${fmt(p.baselineRange[1])}]`
      ).toBeGreaterThanOrEqual(p.baselineRange[0]);
      expect(
        r.blendedTime,
        `baseline ${fmt(r.blendedTime)} should be in [${fmt(p.baselineRange[0])}, ${fmt(p.baselineRange[1])}]`
      ).toBeLessThanOrEqual(p.baselineRange[1]);

      // Training should improve you
      expect(
        r.forecastTime,
        `forecast ${fmt(r.forecastTime)} should be faster than baseline ${fmt(r.blendedTime)}`
      ).toBeLessThan(r.blendedTime);

      // Forecast time within forecast range
      expect(
        r.forecastTime,
        `forecast ${fmt(r.forecastTime)} should be in [${fmt(p.forecastRange[0])}, ${fmt(p.forecastRange[1])}]`
      ).toBeGreaterThanOrEqual(p.forecastRange[0]);
      expect(
        r.forecastTime,
        `forecast ${fmt(r.forecastTime)} should be in [${fmt(p.forecastRange[0])}, ${fmt(p.forecastRange[1])}]`
      ).toBeLessThanOrEqual(p.forecastRange[1]);

      // Improvement within experience-appropriate bounds (0-15%)
      expect(r.improvementPct, 'improvement should be positive').toBeGreaterThan(0);
      expect(r.improvementPct, 'improvement should be ≤15%').toBeLessThanOrEqual(15);
    });
  }
});

// ──────────────── Block 2: Guardrail tests ────────────────

describe('Guardrail tests', () => {
  /** Helper: run horizon with given params and return projected VDOT */
  function projectVdot(
    baselineVdot: number,
    distance: RaceDistance,
    experience: string,
    opts?: { hmPb?: number }
  ) {
    const abilityBand = getAbilityBand(baselineVdot);
    const result = applyTrainingHorizonAdjustment({
      baseline_vdot: baselineVdot,
      target_distance: distance,
      weeks_remaining: 24,
      sessions_per_week: 6,
      runner_type: 'Balanced',
      ability_band: abilityBand,
      taper_weeks: distance === 'marathon' ? 3 : 2,
      experience_level: experience,
      hm_pb_seconds: opts?.hmPb,
    });
    return {
      projVdot: baselineVdot + result.vdot_gain,
      improvementPct: result.improvement_pct,
    };
  }

  it('beginner cannot forecast sub-4 marathon (cap VDOT 42.5)', () => {
    const { projVdot } = projectVdot(40, 'marathon', 'beginner');
    expect(projVdot, `projected VDOT ${projVdot.toFixed(1)} should be ≤42.5`).toBeLessThanOrEqual(42.6);
  });

  it('novice cannot forecast sub-3:30 marathon (cap VDOT 47.5)', () => {
    const { projVdot } = projectVdot(45, 'marathon', 'novice');
    expect(projVdot, `projected VDOT ${projVdot.toFixed(1)} should be ≤47.5`).toBeLessThanOrEqual(47.6);
  });

  it('intermediate cannot forecast sub-3 marathon without fast HM PB (cap 53.5)', () => {
    const { projVdot } = projectVdot(51, 'marathon', 'intermediate');
    expect(projVdot, `projected VDOT ${projVdot.toFixed(1)} should be ≤53.5`).toBeLessThanOrEqual(53.6);
  });

  it('advanced CAN forecast sub-3 marathon (no cap)', () => {
    const { projVdot, improvementPct } = projectVdot(52, 'marathon', 'advanced');
    // Advanced has rank 4, so sub-3 guard (rank < 4) doesn't fire
    expect(improvementPct, 'should have positive improvement').toBeGreaterThan(0);
    // With baseline 52 and positive improvement, should be able to exceed 53.5
    expect(projVdot, `projected VDOT ${projVdot.toFixed(1)} should exceed 53.5`).toBeGreaterThan(53.5);
  });

  it('HM PB < 1:28 bypasses sub-3 guardrail for intermediate', () => {
    // Need aggressive params so uncapped projection exceeds 53.5
    // baseline 51 < 51.5 (53.5 - 2), so escape clause doesn't apply
    const abilityBand = getAbilityBand(51);
    const params = {
      baseline_vdot: 51,
      target_distance: 'marathon' as RaceDistance,
      weeks_remaining: 40,
      sessions_per_week: 9,
      runner_type: 'Balanced' as RunnerType,
      ability_band: abilityBand,
      taper_weeks: 3,
      experience_level: 'intermediate',
    };
    const withoutHm = applyTrainingHorizonAdjustment(params);
    const withFastHm = applyTrainingHorizonAdjustment({ ...params, hm_pb_seconds: 5200 });

    const projWithout = 51 + withoutHm.vdot_gain;
    const projWith = 51 + withFastHm.vdot_gain;

    // Without fast HM: capped at 53.5
    expect(projWithout, `without HM: ${projWithout.toFixed(1)} should be ≤53.5`).toBeLessThanOrEqual(53.6);
    // With fast HM (1:26:40 < 1:28): cap bypassed, can exceed 53.5
    expect(projWith, `with fast HM: ${projWith.toFixed(1)} should exceed 53.5`).toBeGreaterThan(53.5);
  });

  it('beginner cannot forecast sub-2 half (cap VDOT 40.5)', () => {
    const { projVdot } = projectVdot(38, 'half', 'beginner');
    expect(projVdot, `projected VDOT ${projVdot.toFixed(1)} should be ≤40.5`).toBeLessThanOrEqual(40.6);
  });
});

// ──────────────── Block 3: Cross-profile comparisons ────────────────

describe('Cross-profile comparisons', () => {
  /** Run pipeline for a simple profile with overrides */
  function runWith(overrides: Partial<TestProfile>) {
    const base: TestProfile = {
      name: 'comparison',
      pbs: { k5: 1300, k10: 2700 },
      recentRace: null, ltPace: null, vo2max: null,
      confirmedRunnerType: null,
      experienceLevel: 'intermediate',
      runsPerWeek: 4, recurringActivities: [], activeLifestyle: false,
      planDurationWeeks: 16, raceDistance: 'half',
      baselineRange: [0, Infinity], forecastRange: [0, Infinity],
    };
    return runFullPipeline({ ...base, ...overrides });
  }

  it('more weeks → more improvement, with diminishing returns', () => {
    const w8 = runWith({ planDurationWeeks: 8 });
    const w16 = runWith({ planDurationWeeks: 16 });
    const w24 = runWith({ planDurationWeeks: 24 });
    const w52 = runWith({ planDurationWeeks: 52 });

    // Monotonically increasing
    expect(w16.improvementPct).toBeGreaterThan(w8.improvementPct);
    expect(w24.improvementPct).toBeGreaterThan(w16.improvementPct);
    expect(w52.improvementPct).toBeGreaterThan(w24.improvementPct);

    // Diminishing returns: gain from 8→16 > gain from 24→52
    const gain8to16 = w16.improvementPct - w8.improvementPct;
    const gain24to52 = w52.improvementPct - w24.improvementPct;
    expect(gain8to16, 'early weeks should give more improvement than later weeks').toBeGreaterThan(gain24to52);
  });

  it('more sessions → more improvement', () => {
    const s3 = runWith({ runsPerWeek: 3 });
    const s5 = runWith({ runsPerWeek: 5 });
    const s7 = runWith({ runsPerWeek: 7 });

    expect(s5.improvementPct).toBeGreaterThan(s3.improvementPct);
    expect(s7.improvementPct).toBeGreaterThan(s5.improvementPct);
  });

  it('higher experience level → higher ceiling (monotonic)', () => {
    const levels = ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced'] as const;
    const results = levels.map(lvl => runWith({ experienceLevel: lvl }));

    for (let i = 1; i < results.length; i++) {
      expect(
        results[i].improvementPct,
        `${levels[i]} should improve more than ${levels[i - 1]}`
      ).toBeGreaterThanOrEqual(results[i - 1].improvementPct);
    }
  });

  it('cross-training boosts effective sessions', () => {
    const runsOnly = runWith({ runsPerWeek: 2 });
    const withCycling = runWith({
      runsPerWeek: 2,
      recurringActivities: [{ durMin: 60, intensity: 'moderate' as const, freq: 3 }],
    });

    expect(
      withCycling.improvementPct,
      '2 runs + 3× cycling should improve more than 2 runs alone'
    ).toBeGreaterThan(runsOnly.improvementPct);
  });

  it('returning runner improves more than same-VDOT intermediate', () => {
    const returning = runWith({ experienceLevel: 'returning' });
    const intermediate = runWith({ experienceLevel: 'intermediate' });

    expect(
      returning.improvementPct,
      'returning (exp factor 1.15) should beat intermediate (1.0)'
    ).toBeGreaterThan(intermediate.improvementPct);
  });

  it('speed runner improves more at marathon than endurance runner', () => {
    const speed = runWith({ confirmedRunnerType: 'Speed', raceDistance: 'marathon' });
    const endurance = runWith({ confirmedRunnerType: 'Endurance', raceDistance: 'marathon' });

    // type_modifier: marathon Speed=1.15, Endurance=0.90
    expect(
      speed.improvementPct,
      'Speed type should improve more at marathon'
    ).toBeGreaterThan(endurance.improvementPct);
  });

  it('endurance runner improves more at 5K than speed runner', () => {
    const speed = runWith({ confirmedRunnerType: 'Speed', raceDistance: '5k' });
    const endurance = runWith({ confirmedRunnerType: 'Endurance', raceDistance: '5k' });

    // type_modifier: 5k Speed=0.90, Endurance=1.15
    expect(
      endurance.improvementPct,
      'Endurance type should improve more at 5K'
    ).toBeGreaterThan(speed.improvementPct);
  });
});

// ──────────────── Block 4: Edge cases ────────────────

describe('Edge cases', () => {
  it('only one PB still produces valid prediction', () => {
    const r = runFullPipeline({
      pbs: { k5: 1500 },
      recentRace: null, ltPace: null, vo2max: null,
      confirmedRunnerType: null,
      experienceLevel: 'intermediate',
      runsPerWeek: 4, recurringActivities: [], activeLifestyle: false,
      planDurationWeeks: 16, raceDistance: 'half',
    });
    expect(r.success).toBe(true);
    expect(r.blendedTime).toBeGreaterThan(0);
    expect(r.forecastTime).toBeLessThan(r.blendedTime);
    expect(r.b, 'single PB defaults to 1.06').toBeCloseTo(1.06, 2);
  });

  it('very stale recent race (20 weeks) has near-zero influence', () => {
    const base = {
      pbs: { k5: 1300, k10: 2700 } as PBs,
      ltPace: null, vo2max: null,
      confirmedRunnerType: null as RunnerType | null,
      experienceLevel: 'intermediate',
      runsPerWeek: 4, recurringActivities: [] as RecurringActivity[], activeLifestyle: false,
      planDurationWeeks: 16, raceDistance: 'half' as RaceDistance,
    };
    const withoutRecent = runFullPipeline({ ...base, recentRace: null });
    const withStaleRecent = runFullPipeline({
      ...base,
      recentRace: { d: 10, t: 2800, weeksAgo: 20 },
    });

    const diff = Math.abs(withStaleRecent.blendedTime - withoutRecent.blendedTime);
    expect(
      diff / withoutRecent.blendedTime,
      `stale recent should change baseline by <2% (actual: ${(diff / withoutRecent.blendedTime * 100).toFixed(1)}%)`
    ).toBeLessThan(0.02);
  });

  it('very short plan (4 weeks) gives positive but tiny improvement (<3%)', () => {
    const r = runFullPipeline({
      pbs: { k5: 1300, k10: 2700 },
      recentRace: null, ltPace: null, vo2max: null,
      confirmedRunnerType: null,
      experienceLevel: 'intermediate',
      runsPerWeek: 4, recurringActivities: [], activeLifestyle: false,
      planDurationWeeks: 4, raceDistance: 'half',
    });
    expect(r.improvementPct, 'should be positive').toBeGreaterThan(0);
    expect(r.improvementPct, 'should be <3% for 4-week plan').toBeLessThan(3);
  });

  it('very long plan (52 weeks) is bounded and diminishing vs 24-week', () => {
    const base = {
      pbs: { k5: 1300, k10: 2700 } as PBs,
      recentRace: null, ltPace: null, vo2max: null,
      confirmedRunnerType: null as RunnerType | null,
      experienceLevel: 'intermediate',
      runsPerWeek: 4, recurringActivities: [] as RecurringActivity[], activeLifestyle: false,
      raceDistance: 'half' as RaceDistance,
    };
    const w24 = runFullPipeline({ ...base, planDurationWeeks: 24 });
    const w52 = runFullPipeline({ ...base, planDurationWeeks: 52 });

    expect(w52.improvementPct).toBeGreaterThan(w24.improvementPct);
    // But the marginal gain should be small (< double)
    expect(w52.improvementPct, '52wk should not be double 24wk').toBeLessThan(w24.improvementPct * 2);
  });

  it('undertraining (1 session/week marathon) fires penalty, improvement <2%', () => {
    const r = runFullPipeline({
      pbs: { k5: 1300, k10: 2700 },
      recentRace: null, ltPace: null, vo2max: null,
      confirmedRunnerType: null,
      experienceLevel: 'intermediate',
      runsPerWeek: 1, recurringActivities: [], activeLifestyle: false,
      planDurationWeeks: 16, raceDistance: 'marathon',
    });
    expect(r.components.undertrain_penalty, 'undertrain penalty should fire').toBeGreaterThan(0);
    expect(r.improvementPct, 'improvement should be very small').toBeLessThan(2);
  });

  it('VDOT near guardrail boundary — within-2-VDOT escape clause bypasses cap', () => {
    // Baseline 52 is within 2 VDOT of 53.5 ceiling (52 >= 51.5)
    // The escape clause should allow projection above 53.5
    const abilityBand = getAbilityBand(52);
    const result = applyTrainingHorizonAdjustment({
      baseline_vdot: 52,
      target_distance: 'marathon',
      weeks_remaining: 30,
      sessions_per_week: 7,
      runner_type: 'Balanced',
      ability_band: abilityBand,
      taper_weeks: 3,
      experience_level: 'intermediate',
    });
    const projVdot = 52 + result.vdot_gain;
    // Intermediate rank=3 < 4 triggers sub-3 guard, but escape clause lets it through
    expect(projVdot, `projected VDOT ${projVdot.toFixed(1)} should exceed 53.5 via escape clause`).toBeGreaterThan(53.5);
  });
});

// ──────────────── Block 5: Sensibility regression guards ────────────────

describe('Sensibility regression guards', () => {
  /** Minimal pipeline for regression profiles (PB-only, no LT/VO2) */
  function regressionRun(
    pbs: PBs,
    experience: string,
    weeks: number,
    distance: RaceDistance,
    runs: number,
    recentRace?: RecentRun | null,
  ) {
    return runFullPipeline({
      pbs,
      recentRace: recentRace ?? null,
      ltPace: null, vo2max: null,
      confirmedRunnerType: null,
      experienceLevel: experience,
      runsPerWeek: runs,
      recurringActivities: [],
      activeLifestyle: false,
      planDurationWeeks: weeks,
      raceDistance: distance,
    });
  }

  it('25:00 5K beginner → 16wk marathon → forecast 4:15-5:30', () => {
    const r = regressionRun({ k5: 1500 }, 'beginner', 16, 'marathon', 3);
    expect(r.success).toBe(true);
    expect(
      r.forecastTime,
      `forecast ${fmt(r.forecastTime)} should be in [4:15:00, 5:30:00]`
    ).toBeGreaterThanOrEqual(13800);
    expect(r.forecastTime).toBeLessThanOrEqual(19800);
  });

  it('20:00 5K intermediate → 20wk marathon → forecast 3:05-3:45', () => {
    const r = regressionRun({ k5: 1200 }, 'intermediate', 20, 'marathon', 5);
    expect(r.success).toBe(true);
    expect(
      r.forecastTime,
      `forecast ${fmt(r.forecastTime)} should be in [3:05:00, 3:45:00]`
    ).toBeGreaterThanOrEqual(11100);
    expect(r.forecastTime).toBeLessThanOrEqual(13500);
  });

  it('17:00 5K competitive → 12wk half → forecast 1:14-1:28', () => {
    const r = regressionRun({ k5: 1020 }, 'competitive', 12, 'half', 6);
    expect(r.success).toBe(true);
    expect(
      r.forecastTime,
      `forecast ${fmt(r.forecastTime)} should be in [1:14:00, 1:28:00]`
    ).toBeGreaterThanOrEqual(4440);
    expect(r.forecastTime).toBeLessThanOrEqual(5280);
  });

  it('30:00 5K total_beginner → 8wk 5K → forecast 27:00-32:00', () => {
    const r = regressionRun({ k5: 1800 }, 'total_beginner', 8, '5k', 2);
    expect(r.success).toBe(true);
    expect(
      r.forecastTime,
      `forecast ${fmt(r.forecastTime)} should be in [27:00, 32:00]`
    ).toBeGreaterThanOrEqual(1620);
    expect(r.forecastTime).toBeLessThanOrEqual(1920);
  });

  it('19:00 5K returning → 16wk half (slow recent) → forecast 1:24-1:50', () => {
    const r = regressionRun(
      { k5: 1140 }, 'returning', 16, 'half', 4,
      { d: 5, t: 1440, weeksAgo: 4 },
    );
    expect(r.success).toBe(true);
    expect(
      r.forecastTime,
      `forecast ${fmt(r.forecastTime)} should be in [1:24:00, 1:50:00]`
    ).toBeGreaterThanOrEqual(5040);
    expect(r.forecastTime).toBeLessThanOrEqual(6600);
  });
});
