/**
 * LOAD CURRENCY ANCHOR TESTS (ISSUE-263) — the durable deliverable.
 *
 * Canonical unit: TSS, 1 hour at lactate threshold = 100, per the TL_PER_MIN
 * calibration with type-keyed valuation (TSS_RPE_BY_TYPE: an easy run is
 * prescribed RPE 3 but valued at the RPE-4 row, ~55 TSS/h).
 *
 * These tests exist to make the mixed-scale bug class UNREPRESENTABLE: before
 * 2026-06-04 the app carried 8 distinct load scales and subtracted numbers
 * across them (Garmin-scale cuts vs TSS budgets, Training Effect 0–5 summed
 * as TSS, four divergent universalLoad tiers, two competing iTRIMP
 * normalizers). If one of these anchors fails, a scale has drifted — fix the
 * producer, do not loosen the anchor.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  TL_PER_MIN,
  LOAD_PER_MIN_BY_INTENSITY,
  TSS_RPE_BY_TYPE,
  plannedTssPerMin,
  garminToTssRatio,
} from '@/constants';
import { calculateWorkoutLoad } from '@/workouts';
import {
  computePlannedDaySignalBTSS,
  computeAthleteNormalizer,
  normalizeiTrimp,
  getAthleteNormalizer,
  setAthleteNormalizer,
  computeWeekRawTSS,
} from '@/calculations/fitness-model';
import { triActivityTss, withTriRatedRpe } from '@/calculations/tri-benchmarks-from-history';
import { calculateITrimpFromSummary } from '@/calculations/trimp';
import { computeUniversalLoad, saturateCredit } from '@/cross-training/universalLoad';
import { detectCrossTrainingOverload, overloadReductionBudget } from '@/calculations/tri-cross-training-overload';
import { applyTriSuggestions } from '@/calculations/tri-suggestion-apply';
import type { TriSuggestionMod } from '@/calculations/tri-suggestion-aggregator';
import { getDefaultState } from '@/state/store';
import { EASY_LOAD_PER_KM, TAU, HR_ZONE_TSS_PER_MIN } from '@/cross-training/universal-load-constants';
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import type { SimulatorState, Workout } from '@/types';
import type { GarminActual, Week } from '@/types/state';

const EASY_HOUR_TSS = 60 * TL_PER_MIN[4]; // 55.2 — THE anchor

beforeEach(() => setAthleteNormalizer()); // population normalizer 15000

describe('Anchor 1: a 60-min easy run ≈ 55 TSS in every planned pipeline', () => {
  it('canonical table: TL_PER_MIN[4] × 60 = 55.2', () => {
    expect(EASY_HOUR_TSS).toBeCloseTo(55.2, 5);
  });

  it('calculateWorkoutLoad (planned-run producer, w.aerobic stamps)', () => {
    // 10km at 6:00/km = 60 min. Prescribed RPE 3; valuation is type-keyed.
    const loads = calculateWorkoutLoad('easy', '10km', 30, 360);
    expect(loads.aerobic + loads.anaerobic).toBeCloseTo(EASY_HOUR_TSS, 0);
  });

  it('computePlannedDaySignalBTSS (strain target)', () => {
    const w = { t: 'easy', n: 'Easy Run', d: '10km', r: 3, rpe: 3, dayOfWeek: 2 } as Workout;
    const tss = computePlannedDaySignalBTSS([w], 2, 6.0);
    expect(tss).toBeCloseTo(EASY_HOUR_TSS, 0);
  });

  it('triathlon engine easy run (mirror rule: tri == running mode)', () => {
    const state = {
      mode: 'triathlon',
      triConfig: { distance: 'olympic', weeklyHours: 7, raceDateISO: '2026-09-01' },
      w: 1, planStartDate: '2026-06-01',
    } as unknown as SimulatorState;
    const weeks = generateTriathlonPlan(state);
    const easyRuns = weeks.flatMap(wk => (wk as any).triWorkouts ?? [])
      .filter((w: any) => w.discipline === 'run' && w.t === 'easy' && w.estimatedDurationMin > 0);
    expect(easyRuns.length).toBeGreaterThan(0);
    for (const w of easyRuns) {
      const perMin = ((w.aerobic ?? 0) + (w.anaerobic ?? 0)) / w.estimatedDurationMin;
      // within rounding of the canonical easy rate (was 1.0/min pre-ISSUE-263)
      expect(perMin).toBeGreaterThan(TL_PER_MIN[4] - 0.06);
      expect(perMin).toBeLessThan(TL_PER_MIN[4] + 0.06);
    }
  });

  it('type-keyed valuation: prescribed RPE 3 does NOT drop the easy anchor to 39', () => {
    expect(plannedTssPerMin('easy', 3)).toBe(TL_PER_MIN[4]);
    expect(plannedTssPerMin('long', 5)).toBe(TL_PER_MIN[4]);
    expect(plannedTssPerMin('threshold', 7)).toBe(TL_PER_MIN[7]);
    // unmapped types fall back to the prescribed RPE row
    expect(plannedTssPerMin('gym', 6)).toBe(TL_PER_MIN[6]);
  });
});

describe('Anchor 2: 1 hour at LT = 100 TSS (the definition)', () => {
  it('normalizeiTrimp(normalizer) === 100 — exact, for any plausible profile', () => {
    // 1h exactly at ltHR produces iTRIMP = 3600 × hrr × e^(1.92·hrr) = the
    // normalizer itself, so the conversion must return exactly 100.
    const norm = computeAthleteNormalizer(172, 42, 192);
    expect(normalizeiTrimp(norm, norm)).toBeCloseTo(100, 10);
    expect(normalizeiTrimp(15000, 15000)).toBeCloseTo(100, 10);
  });

  it('holds for either sex: producer and normalizer share the β of the athlete\'s sex', () => {
    // A female iTRIMP (β 1.67) over a male-β normalizer read ~0.81× (audit B12).
    for (const sex of ['female', 'male'] as const) {
      const itrimp = calculateITrimpFromSummary(172, 3600, 42, 192, sex);
      expect(normalizeiTrimp(itrimp, computeAthleteNormalizer(172, 42, 192, sex)), sex).toBeCloseTo(100, 6);
    }
  });

  it('Tier B zone weights anchor Z4 (threshold zone) at exactly 100 TSS/h', () => {
    expect(HR_ZONE_TSS_PER_MIN[3] * 60).toBeCloseTo(100, 5);
  });
});

describe('Anchor 3: universalLoad tiers agree for the same easy hour', () => {
  // One identical 60-min easy session (IF 0.74 → 55.2 TSS ground truth) fed
  // through each tier. extra_run: sportMult 1.0, activeFraction 1.0, so the
  // tier maths is isolated from sport corrections.
  const base = { sport: 'extra_run', durationMin: 60, rpe: 4, dayOfWeek: 2 };

  it('Tier A+ (iTRIMP), Tier A (Garmin raw), Tier B (zones) within 15% of the anchor', () => {
    const aPlus = computeUniversalLoad({ ...base, iTrimp: EASY_HOUR_TSS * 150 } as any, 'half');
    const aGarmin = computeUniversalLoad({
      ...base, fromGarmin: true,
      garminAerobicLoad: EASY_HOUR_TSS * garminToTssRatio(4) * 0.95,
      garminAnaerobicLoad: EASY_HOUR_TSS * garminToTssRatio(4) * 0.05,
    } as any, 'half');
    const bZones = computeUniversalLoad({
      ...base,
      hrZones: { zone1Minutes: 5, zone2Minutes: 55, zone3Minutes: 0, zone4Minutes: 0, zone5Minutes: 0 },
    } as any, 'half');

    for (const [tier, r] of [['itrimp', aPlus], ['garmin', aGarmin], ['hr', bZones]] as const) {
      expect(r.tier).toBe(tier);
      expect(r.baseLoad).toBeGreaterThan(EASY_HOUR_TSS * 0.85);
      expect(r.baseLoad).toBeLessThan(EASY_HOUR_TSS * 1.15);
    }
  });

  it('Tier C (RPE estimate) lands at anchor × 0.80 — the deliberate uncertainty discount', () => {
    const c = computeUniversalLoad(base as any, 'half');
    expect(c.tier).toBe('rpe');
    expect(c.baseLoad).toBeCloseTo(EASY_HOUR_TSS * 0.80, 0);
  });
});

describe('Anchor 4: replacement credit can never exceed its own load', () => {
  it('saturation has slope ≤ 1 everywhere (the old curve amplified ×1.87)', () => {
    for (const raw of [10, 50, 100, 200, 400, 900]) {
      const credit = TAU * (1 - Math.exp(-raw / TAU));
      expect(credit).toBeLessThanOrEqual(raw);
      // The exported curve the planners call is this formula.
      expect(saturateCredit(raw)).toBeCloseTo(credit, 10);
    }
  });

  it('RRC ≤ baseLoad for real sessions across tiers', () => {
    for (const input of [
      { sport: 'cycling', durationMin: 90, rpe: 7, iTrimp: 12000 },
      { sport: 'cycling', durationMin: 90, rpe: 7 },
      { sport: 'extra_run', durationMin: 120, rpe: 5, iTrimp: 16000 },
    ]) {
      const r = computeUniversalLoad(input as any, 'half');
      expect(r.runReplacementCredit).toBeLessThanOrEqual(r.baseLoad + 0.1);
    }
  });
});

describe('Anchor 4b: the triathlon overload budget never exceeds the unanswered load', () => {
  // The triathlon overload detector turns unanswered cross-training TSS into a
  // budget of planned TSS it may cut. Until 2026-10-21 it kept the old
  // 1500 × (1 − e^(−load / 800)) curve (slope 1.875 at zero): 50 TSS of tennis
  // unlocked about 91 TSS of cuts. SCIENCE_LOG §DP.
  it('overloadReductionBudget(load) ≤ load from 10 to 900 TSS', () => {
    for (const raw of [10, 25, 50, 100, 200, 400, 900]) {
      expect(overloadReductionBudget(raw)).toBeLessThanOrEqual(raw);
      expect(overloadReductionBudget(raw)).toBeGreaterThan(0);
    }
    expect(overloadReductionBudget(0)).toBe(0);
  });

  // What a proposal takes off the plan is what applyTriSuggestions does, not the
  // modal's label: the anchor applies every proposed set to a copy of the plan
  // and measures the drop in planned TSS. Until 2026-10-21 (second pass) the
  // label was clipped to the budget while Apply made the whole change, so this
  // anchor passed on the label while the plan lost more than the load.
  const weekTss = (s: SimulatorState, wi: number) =>
    (s.wks![wi].triWorkouts ?? []).reduce((a, w) => a + (w.aerobic ?? 0) + (w.anaerobic ?? 0), 0);

  /** Apply one option set to a copy; returns the drop in the week's planned TSS. */
  function appliedDrop(s: SimulatorState, wi: number, set: { workoutId: string; action: TriSuggestionMod['action']; discipline: 'swim' | 'bike' | 'run'; workoutLabel: string }[]): number {
    const c = structuredClone(s);
    const before = weekTss(c, wi);
    const r = applyTriSuggestions(c, set.map((a, i) => ({
      id: `xt_${i}`, source: 'cross_training_overload', discipline: a.discipline, headline: a.workoutLabel,
      body: '', severity: 'caution', targetWorkoutId: a.workoutId, action: a.action,
    }) as TriSuggestionMod));
    expect(r.skipped).toBe(0);
    return before - weekTss(c, wi);
  }

  it('accepting a proposal takes no more planned TSS than the unanswered load, and exactly what the modal shows', () => {
    // 400 TSS planned and 62 TSS of tennis (15.5%, heavy; budget 58.2). The
    // threshold run's swap to easy takes 137 (200 -> 68 min easy, 63) and its
    // downgrade 69 (200 -> 90 min marathon pace, 131): both exceed the budget,
    // so neither is proposed. The long ride's trim takes 30 (240 -> 204 min).
    const wk = {
      w: 1,
      triWorkouts: [
        { id: 'mon-r', t: 'threshold', n: 'Run threshold', d: '90min', r: 8, discipline: 'run', aerobic: 150, anaerobic: 50, dayOfWeek: 0, estimatedDurationMin: 90 },
        { id: 'sat-b', t: 'bike_endurance', n: 'Long bike', d: '4h', r: 5, discipline: 'bike', aerobic: 180, anaerobic: 20, dayOfWeek: 5, estimatedDurationMin: 240 },
      ],
      adhocWorkouts: [{ id: 'garmin-tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 62 * 150 }],
    };
    const s = { eventType: 'triathlon', w: 1, wks: [wk] } as unknown as SimulatorState;
    const r = detectCrossTrainingOverload(s, 0);
    expect(r).not.toBeNull();
    expect(r!.crossTrainingTSS).toBe(62);
    for (const d of ['swim', 'bike', 'run'] as const) {
      for (const set of [r!.options[d].reduceMods, r!.options[d].replaceMods]) {
        const shown = set.reduce((a, m) => a + m.tssReduction, 0);
        const drop = appliedDrop(s, 0, set);
        expect(drop, d).toBeLessThanOrEqual(r!.crossTrainingTSS);
        expect(drop, d).toBeLessThanOrEqual(overloadReductionBudget(62));
        expect(drop, d).toBe(shown);
      }
    }
    expect(r!.options.run.replaceMods).toEqual([]);
    expect(r!.options.run.reduceMods).toEqual([]);
    expect(r!.options.bike.reduceMods).toMatchObject([{ workoutId: 'sat-b', action: 'trim_volume', tssReduction: 30 }]);
  });

  it('generated plans: every proposed set takes at most the unanswered load, and what it shows', () => {
    let sets = 0;
    for (const distance of ['sprint', 'olympic', '70.3', 'ironman']) {
      const base = {
        ...getDefaultState(), eventType: 'triathlon', w: 1, tw: 20, v: 50,
        pac: { e: 300, t: 250, i: 230, m: 275, r: 200 }, wks: [],
        triConfig: {
          distance, timeAvailableHoursPerWeek: 12, volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
          skillRating: { swim: 3, bike: 3, run: 3 }, bike: { hasPowerMeter: true, ftp: 220 }, swim: { cssSecPer100m: 100 }, weeksToRace: 20,
        },
      } as unknown as SimulatorState;
      base.wks = generateTriathlonPlan(base);
      for (let wi = 0; wi < base.wks.length; wi++) {
        // Heavy and extreme loads, run-affinity (tennis) and bike-affinity (cycling).
        for (const pct of [0.16, 0.30]) for (const sport of ['tennis', 'cycling']) {
          const s = structuredClone(base);
          s.w = wi + 1;
          s.wks[wi].adhocWorkouts = [{ id: 'xt', t: 'cross', n: sport, d: '90min', r: 6, iTrimp: pct * weekTss(s, wi) * 150 } as any];
          const o = detectCrossTrainingOverload(s, 0);
          if (!o) continue;
          for (const d of ['swim', 'bike', 'run'] as const) {
            for (const set of [o.options[d].reduceMods, o.options[d].replaceMods]) {
              const where = `${distance} wk${wi + 1} ${pct} ${sport} ${d}`;
              const drop = appliedDrop(s, wi, set);
              expect(drop, where).toBeLessThanOrEqual(o.crossTrainingTSS + 0.5);
              // Equal up to the rounding of a fractional stored load.
              expect(Math.abs(drop - set.reduce((a, m) => a + m.tssReduction, 0)), where).toBeLessThanOrEqual(0.5 * set.length);
              sets += 1;
            }
          }
        }
      }
    }
    expect(sets).toBeGreaterThan(500);
  });
});

describe('Anchor 5: equivalentEasyKm round-trips through the single derived constant', () => {
  it('EASY_LOAD_PER_KM is derived from the canonical table (6:00/km × TL_PER_MIN[4])', () => {
    expect(EASY_LOAD_PER_KM).toBeCloseTo(6.0 * TL_PER_MIN[4], 5);
  });

  it('eqEasyKm × EASY_LOAD_PER_KM ≈ RRC (below the display cap)', () => {
    const r = computeUniversalLoad({ sport: 'cycling', durationMin: 60, rpe: 5, iTrimp: 8000 } as any, 'half');
    expect(r.equivalentEasyKm * EASY_LOAD_PER_KM).toBeCloseTo(r.runReplacementCredit, 0);
  });
});

describe('Anchor 6: TSS↔iTRIMP encode/decode is an exact round-trip', () => {
  it('encode with getAthleteNormalizer, decode with normalizeiTrimp — identity', () => {
    setAthleteNormalizer(172, 42, 192); // any plausible personal profile
    const tss = 73.4;
    const encoded = (tss * getAthleteNormalizer()) / 100;
    expect(normalizeiTrimp(encoded)).toBeCloseTo(tss, 8);
    setAthleteNormalizer();
  });
});

describe('Anchor 7: the Garmin→TSS conversion law is per-RPE, not a flat factor', () => {
  it('ratio table matches the two source tables row by row', () => {
    for (let rpe = 1; rpe <= 10; rpe++) {
      expect(garminToTssRatio(rpe)).toBeCloseTo(LOAD_PER_MIN_BY_INTENSITY[rpe] / TL_PER_MIN[rpe], 10);
    }
    expect(garminToTssRatio(4)).toBeCloseTo(1.5 / 0.92, 5);  // ~1.63 easy
    expect(garminToTssRatio(8)).toBeCloseTo(4.5 / 2.22, 5);  // ~2.03 vo2
  });
});

describe('Anchor 8: no hardcoded population normalizer in user-facing code', () => {
  it('zero `/15000`-style decodes outside fitness-model and tests', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        if (entry.name === 'fitness-model.ts') continue; // the canonical fallback constant lives here
        const src = fs.readFileSync(full, 'utf8');
        for (const [i, line] of src.split('\n').entries()) {
          const code = line.split('//')[0];
          if (/\/\s*15000|\*\s*150\b|\/\s*150\b/.test(code) && /[tT]rimp/i.test(code)) {
            offenders.push(`${full}:${i + 1}: ${line.trim()}`);
          }
        }
      }
    };
    walk(path.join(__dirname, '..'));
    expect(offenders).toEqual([]);
  });
});

describe('Anchor 9: type-keyed valuation map stays on canonical table rows', () => {
  it('every TSS_RPE_BY_TYPE entry points at a real TL_PER_MIN row', () => {
    for (const [type, rpe] of Object.entries(TSS_RPE_BY_TYPE)) {
      expect(TL_PER_MIN[rpe], `${type} → RPE ${rpe}`).toBeDefined();
    }
    // The decided anchors
    expect(TSS_RPE_BY_TYPE.easy).toBe(4);
    expect(TSS_RPE_BY_TYPE.long).toBe(4);
    expect(TSS_RPE_BY_TYPE.recovery).toBe(3);
  });
});

describe('Anchor 10: a session without heart rate is worth the same in tri fitness and Signal B', () => {
  // Triathlon / cycling per-discipline fitness (triActivityTss) once valued a
  // heart-rate-less hour on a private per-minute scale (ride 60, swim 54,
  // class 36 TSS) while computeWeekRawTSS read 69 (TL_PER_MIN[5]).
  const actual = (activityType: string): GarminActual => ({
    garminId: 'strava-anchor', activityType, startTime: '2026-10-07T08:00:00.000Z', durationSec: 3600,
    distanceKm: 0, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null,
  } as GarminActual);

  for (const activityType of ['CYCLING', 'LAP_SWIMMING', 'HIIT']) {
    for (const rated of [undefined, 7]) {
      it(`${activityType}, ${rated == null ? 'unrated' : `rated ${rated}`}`, () => {
        const wk = { w: 1, garminActuals: { slot: actual(activityType) }, rated: rated == null ? {} : { slot: rated } } as unknown as Week;
        const [dbRow] = withTriRatedRpe([actual(activityType)], [wk]);
        expect(Math.round(triActivityTss(dbRow))).toBe(computeWeekRawTSS(wk, wk.rated));
        expect(triActivityTss(dbRow)).toBeCloseTo(60 * TL_PER_MIN[rated ?? 5], 6);
      });
    }
  }
});
