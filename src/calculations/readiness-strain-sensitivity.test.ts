import { describe, it, expect, afterEach } from 'vitest';
import { computeReadiness } from './readiness';
import { computeCapacityStrain } from './capacity-strain';
import { setAthleteNormalizer, computeAthleteNormalizer } from './fitness-model';
import { estimateDirectPerDisciplineCTLFromActivities } from './tri-benchmarks-from-history';
import type { SimulatorState } from '@/types/state';

/**
 * Maths verification for "why doesn't training move the readiness score?"
 * (Tristan dogfood, 2026-06-04 — see docs/READINESS_AUDIT.md).
 *
 * Three findings, each pinned by a test block below:
 *
 * 1. The strain floor is a CAP, not a penalty (readiness.ts:627-638).
 *    Below 100% of the capacity anchor it can only pull a HIGH ambient score
 *    down to 54-100; it never subtracts from a score already below the floor.
 *    A tired athlete (ambient < 60) who trains at 93% of capacity sees ZERO
 *    score change. By design — but it explains "the score ignores my session".
 *
 * 2. TSS undercount (ISSUE-259) moves the result across two label bands.
 *    The same 56-min VO2 ride scored honestly (~70 power-TSS) vs by HR-iTRIMP
 *    (43) is the difference between floor 24 "Ease Back" and floor 59
 *    "On Track". The anchor maths is fine; the input is the whole story.
 *
 * 3. The capacity anchor's numerator and denominator are on DIFFERENT
 *    iTRIMP→TSS scales (ISSUE-263 class, see docs/LOAD_CURRENCY_PLAN.md).
 *    todayTSS uses the personal normalizer (fitness-model.ts:291); the tri
 *    weeklyCtl pipe uses the population /150 (tri-benchmarks-from-history.ts
 *    estimateTss). For an athlete whose personal normalizer is 12100, every
 *    pctCapacity is inflated 15000/12100 ≈ 1.24× vs a consistent scale.
 */

// ── Shared ambient inputs ────────────────────────────────────────────────────
// "Fresh-ish athlete": composite lands ~69 (Primed/On Track boundary region).
const FRESH = {
  tsb: 21,            // weekly units → daily +3
  acwr: 0.9,
  ctlNow: 45,
  sleepScore: 75,     // above all sleep floors
  sleepHistory: [],
  hrvRmssd: null,
  hrvPersonalAvg: null,
  sleepBankSec: null,
  sleepDebtExcessSec: null,
  weeksOfHistory: 65, // Tristan's real value (no insufficient-history default)
  recentLegLoads: [],
  acwrSafeUpper: 1.3,
};

// "Tired athlete": composite lands ~44 (Manage Load).
const TIRED = {
  ...FRESH,
  tsb: -28,           // daily −4
  acwr: 1.15,
  sleepScore: 70,
  precomputedRecoveryScore: 55,
};

describe('strain floor shape (readiness.ts:627) — exact floor per strainPct', () => {
  // Floor formula: 50-100% → 100→54 (0.92 pts/%); 100-180% → 54→10 (0.55 pts/%).
  const floorAt = (sp: number) => sp <= 100
    ? Math.round(100 - (sp - 50) * (46 / 50))
    : Math.max(10, Math.round(54 - (sp - 100) * (44 / 80)));

  it('strainPct ≤ 50 has no effect', () => {
    const base = computeReadiness({ ...FRESH, precomputedRecoveryScore: 90, strainPct: null });
    const low = computeReadiness({ ...FRESH, precomputedRecoveryScore: 90, strainPct: 45 });
    expect(low.score).toBe(base.score);
    expect(low.hardFloor).toBeNull();
  });

  it.each([
    [93, 60],   // a hard session just under capacity → only caps to 60 ("On Track")
    [100, 54],  // exactly at capacity → top of Manage Load
    [130, 38],  // the "Load exceeded" ring threshold
    [155, 24],  // honest power-TSS for the dogfood ride → Ease Back
    [180, 10],
    [210, 10],  // injury-capped plan-relative % — clamps at 10
  ])('strainPct %i% → floor %i on a fresh athlete', (sp, expected) => {
    expect(floorAt(sp)).toBe(expected); // formula self-check
    const r = computeReadiness({ ...FRESH, precomputedRecoveryScore: 90, strainPct: sp });
    expect(r.score).toBe(expected);
    expect(r.hardFloor).toBe('strain');
  });

  it('the floor is a cap, NOT a penalty: a tired athlete (ambient < floor) sees zero change at 93%', () => {
    const base = computeReadiness({ ...TIRED, strainPct: null });
    const trained = computeReadiness({ ...TIRED, strainPct: 93 });
    expect(base.score).toBeLessThan(60);       // ambient already below the 93% floor
    expect(trained.score).toBe(base.score);    // session is invisible to the score
    expect(trained.hardFloor).not.toBe('strain');
  });
});

describe('dogfood ride (iTRIMP 5202, capacity anchor 45.3) — undercount vs honest TSS', () => {
  // Audit numbers (docs/READINESS_AUDIT.md §2/§5): HR-iTRIMP gives 43 TSS,
  // power-based Coggan TSS ≈ 70 for the same 6×2min @ 350W session.
  const ANCHOR = 45.3;

  it('HR-undercounted 43 TSS → 95% of capacity → floor 59, label stays "On Track"', () => {
    const pct = (43 / ANCHOR) * 100; // 94.9%
    const r = computeReadiness({ ...FRESH, precomputedRecoveryScore: 90, strainPct: pct });
    expect(r.score).toBe(59);
    expect(r.label).toBe('On Track');
  });

  it('honest ~70 power-TSS → 155% of capacity → floor 24 "Ease Back"', () => {
    const pct = (70 / ANCHOR) * 100; // 154.5%
    const r = computeReadiness({ ...FRESH, precomputedRecoveryScore: 90, strainPct: pct });
    expect(r.score).toBe(24);
    expect(r.label).toBe('Ease Back');
  });

  it('the measurement gap alone spans two label bands (59 On Track vs 24 Ease Back)', () => {
    const under = computeReadiness({ ...FRESH, precomputedRecoveryScore: 90, strainPct: (43 / ANCHOR) * 100 });
    const honest = computeReadiness({ ...FRESH, precomputedRecoveryScore: 90, strainPct: (70 / ANCHOR) * 100 });
    expect(under.score - honest.score).toBe(35);
  });
});

describe('capacity-strain scale mismatch (ISSUE-263 class) — numerator vs denominator', () => {
  // A personal HR profile (ltHR 158 / resting 50 / max 190) gives a normalizer
  // ≈ 12.2k — materially below the population 15000, like Tristan's. Reset to
  // the population fallback after each test (module-level state).
  const PROFILE = { ltHR: 158, restingHR: 50, maxHR: 190 };
  const personalNorm = computeAthleteNormalizer(PROFILE.ltHR, PROFILE.restingHR, PROFILE.maxHR);
  const setPersonal = () => setAthleteNormalizer(PROFILE.ltHR, PROFILE.restingHR, PROFILE.maxHR);
  afterEach(() => setAthleteNormalizer()); // no args → 15000 fallback

  const today = new Date().toISOString().split('T')[0];
  const ride = {
    activityType: 'cycling',
    durationSec: 56 * 60,
    // Early-morning stamp: must be in the past at test runtime or the CTL
    // pipe's `day < 0` guard drops the activity entirely.
    startTime: `${today}T00:30:00Z`,
    iTrimp: 5202,
  };

  function triState(weeklyCtlParts: { swim: number; bike: number; run: number; cross: number }): SimulatorState {
    const mkFit = (ctl: number) => ({ ctl, atl: ctl, tsb: 0, directCount: 1 });
    return {
      w: 1,
      eventType: 'triathlon',
      trackOnly: false,
      wks: [{
        triWorkouts: [],
        garminActuals: { 'bike-1': { ...ride, distanceKm: 30 } },
        adhocWorkouts: [],
      }],
      physiologyHistory: [],
      triConfig: {
        fitness: {
          swim: mkFit(weeklyCtlParts.swim),
          bike: mkFit(weeklyCtlParts.bike),
          run: mkFit(weeklyCtlParts.run),
          combinedCtl: 0,
          crossTrainingAtl: 0,
          crossTrainingCtl: weeklyCtlParts.cross,
        },
      },
    } as unknown as SimulatorState;
  }

  it('todayTSS uses the PERSONAL normalizer when an HR profile is set', () => {
    setPersonal();
    const cs = computeCapacityStrain(triState({ swim: 0, bike: 50, run: 20, cross: 13 }));
    expect(personalNorm).toBeLessThan(15000);
    expect(cs.todayTSS).toBe(Math.round((5202 * 100) / personalNorm)); // 43 at this profile
    expect(cs.todayTSS).toBe(43);
  });

  it('FIXED (ISSUE-263): the tri CTL pipe uses the SAME personal normalizer as the numerator', () => {
    // This test used to DOCUMENT the mismatch: the capacity-strain numerator
    // valued a ride via the personal normalizer while the tri CTL denominator
    // hardcoded population /150, inflating every pctCapacity by
    // 15000/personalNorm. The 2026-06-04 canonicalisation routed the tri CTL
    // pipe through normalizeiTrimp (personal, plausibility-gated), so the two
    // pipes now agree by construction.
    setPersonal();
    const est = estimateDirectPerDisciplineCTLFromActivities([ride]);
    // One ride today: bike weekly CTL = (iTrimp×100/personalNorm ÷ 42) × 7
    expect(est.bike.ctl).toBeCloseTo((((5202 * 100) / personalNorm) / 42) * 7, 1);
  });

  it('weeklyCtl 83 (the 2026-06-04 live value) makes ANY normal session read as massive overreach', () => {
    setPersonal();
    const cs = computeCapacityStrain(triState({ swim: 0, bike: 50, run: 20, cross: 13 }));
    expect(cs.weeklyCtl).toBe(83);
    expect(cs.anchorTSS).toBeCloseTo(83 / 7, 1);            // 11.9 TSS/day
    expect(cs.pctCapacity).toBeGreaterThan(350);            // 43 / 11.9 ≈ 363%
    // → strain floor 10 "Ease Back" for a routine session. If weeklyCtl is
    // really 83 (vs ~317 in the audit two days earlier), the anchor has lost
    // its data, and the score will now OVER-react instead of under-react.
  });

  it('audit-era weeklyCtl 317 reproduces the documented 93-95% behaviour', () => {
    setPersonal();
    const cs = computeCapacityStrain(triState({ swim: 30, bike: 100, run: 44, cross: 143 }));
    expect(cs.weeklyCtl).toBe(317);
    expect(cs.pctCapacity).toBeCloseTo((43 / (317 / 7)) * 100, 0); // ≈ 95%
    expect(cs.pctCapacity).toBeGreaterThan(90);
    expect(cs.pctCapacity).toBeLessThan(100);
  });
});
