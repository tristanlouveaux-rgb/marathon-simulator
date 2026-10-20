/**
 * HYROX station content inside the plan (lane H2b part 1, generator v19), real
 * initializer and real generator:
 *   - station sessions by tier and phase (beginner technique; intermediate
 *     technique in base, race pace in build and peak; advanced race pace and
 *     technique in base and build, race pace alone in peak) and the race-pace
 *     dose stepping 0.5 x, 0.75 x and 1.0 x toward peak, never above the
 *     week's nominal size;
 *   - the beginner load schedule (sleds unloaded weeks 1-2, then 50%, others
 *     60%, race weight 4 weeks before race week) and its RPE autoregulation
 *     from the rating on the last station session (up, hold, suppressed);
 *   - the stored weakest station leading the race-pace session;
 *   - doubles at half of every station; bricks by tier in the plan;
 *   - the MTL cap seeing the new sessions;
 *   - the H2 integration minors: (a) week 1 over the chosen hours, (b) taper
 *     week 1 losing its station work, (c) the version regeneration re-banding
 *     a stored plan.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
});
vi.stubGlobal('alert', vi.fn());
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { getState, getMutableState, resetState } from '@/state/store';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Week, Workout } from '@/types';
import type { AbilityBand, HyroxStation } from '@/types/triathlon';
import { HYROX_MTL_CAP, computeDoublesCap, hyroxTier } from '@/constants/hyrox-constants';
import { isHyroxDeloadWeek } from './plan_engine';
import { generateHyroxPlan, hyroxSimWeeks, generateHyroxPlanDetailed, HYROX_GENERATOR_VERSION } from './plan_engine.hyrox';
import { planTrainingWeeks } from './race-week-layout';
import { isHyroxEasyErg, hyroxLoadStepNote } from './hyrox-generators';
import { hyroxComponentSets } from './hyrox-session-shape';
import { hyroxBeginnerRaceWeightWeek, hyroxRacePaceSets, hyroxLoadKgAt } from './hyrox-station-dose';
import { applyHyroxGeneratorRegen } from '@/state/hyrox-plan-regen';
import { hyroxPlanningBandFor } from '@/calculations/hyrox-planning-band';
import { noteRatingSource } from '@/calculations/athlete-rating';
import { applyHyroxPrevTimeUpdate } from '@/state/hyrox-prev-time-update';
import { applyHyroxPrevFormatChange } from '@/state/hyrox-prev-format-fix';

const PREV: Record<AbilityBand, number | null> = {
  total_beginner: null, beginner: 8662, novice: 6600, intermediate: 5400, advanced: 4200, competitive: 3300,
};

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

function build(band: AbilityBand, hours: number, weeks: number, over: Partial<OnboardingState> = {}): SimulatorState {
  resetState();
  const sec = PREV[band];
  initializeHyroxSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', trainingMode: 'hyrox',
    hyroxFormat: 'open_singles', experienceLevel: 'intermediate', triTimeAvailableHoursPerWeek: hours,
    planDurationWeeks: weeks, customRaceDate: null,
    ...(sec != null ? { previousHyroxTimeSec: sec, hyroxPreviousTimeFormat: 'open_singles' } : {}),
    ...over,
  } as OnboardingState);
  return getMutableState();
}

const prescribed = (wk: Week | undefined): Workout[] => (wk?.triWorkouts ?? []).filter(w => w.commute !== true);
const isWork = (w: Workout) => (w.discipline === 'station' || w.discipline === 'brick') && !isHyroxEasyErg(w);
const stations = (w: Workout) => (w.hyroxComponents ?? []).filter(c => c.type !== 'run');
const minutes = (wk: Week | undefined) => prescribed(wk).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
const loadsOf = (w: Workout | undefined): Partial<Record<HyroxStation, number>> =>
  Object.fromEntries(stations(w ?? ({} as Workout)).filter(c => c.loadKg != null).map(c => [c.type, c.loadKg!]));

describe('station sessions by tier and phase', () => {
  it('beginner: one technique session a week (week 1 the assessment), no race-pace session', () => {
    const s = build('beginner', 5, 16);
    s.wks.slice(1, planTrainingWeeks(s)).forEach(wk => {
      const st = prescribed(wk).filter(w => w.discipline === 'station' && !isHyroxEasyErg(w));
      expect(st.every(w => w.t === 'hyrox_station_technique')).toBe(true);
      expect(st.length).toBeLessThanOrEqual(1);
    });
  });

  it('intermediate: technique in base, race pace in build and peak, the dose stepping toward peak', () => {
    const s = build('intermediate', 8, 16);
    const phases = s.wks.map(w => w.ph);
    let peakFull = 0;
    s.wks.slice(1, planTrainingWeeks(s)).forEach((wk, k) => {
      const i = k + 1;
      const st = prescribed(wk).filter(w => w.discipline === 'station' && !isHyroxEasyErg(w));
      if (wk.ph === 'base') expect(st.every(w => w.t === 'hyrox_station_technique' && w.hyroxRounds === 2)).toBe(true);
      // A full-sim week runs its race-pace session in the technique format
      // (lane H2b part 2).
      const fullSimWeek = prescribed(wk).some(w => w.t === 'hyrox_sim' && w.hyroxSpec?.simKind === 'full');
      if ((wk.ph === 'build' || wk.ph === 'peak') && !fullSimWeek) {
        const rp = st.filter(w => w.t === 'hyrox_station_density');
        expect(rp).toHaveLength(1);
        const deload = isHyroxDeloadWeek(i + 1, phases);
        const nominal = (wk.ph === 'build' ? 0.92 : 1) * (deload ? 0.75 : 1);
        // Never above the week's nominal size; a held week takes sets off.
        expect(rp[0].hyroxRounds!).toBeLessThanOrEqual(hyroxRacePaceSets(nominal, false));
        expect(rp[0].hyroxRounds!).toBeGreaterThanOrEqual(2);
        // Build at 0.92 of peak rounds to the full 1.0 x (nearest quarter, 2026-10-20).
        if (wk.ph === 'build' && !deload) expect(rp[0].hyroxRounds).toBe(4);
        if (wk.ph === 'peak' && rp[0].hyroxRounds === 4) peakFull++;
      }
    });
    expect(peakFull).toBeGreaterThan(0); // the full race volume at peak
  });

  it('advanced: race pace and technique in base and build, race pace alone with the key and secondary bricks in peak', () => {
    const s = build('advanced', 10, 16);
    const phases = s.wks.map(w => w.ph);
    s.wks.slice(1, planTrainingWeeks(s)).forEach((wk, k) => {
      const i = k + 1;
      if (isHyroxDeloadWeek(i + 1, phases) || wk.ph === 'taper') return;
      // A race simulation takes the key brick's slot (lane H2b part 2).
      if (prescribed(wk).some(w => w.t === 'hyrox_sim')) return;
      const types = prescribed(wk).filter(isWork).map(w => w.t).sort();
      if (wk.ph === 'base') expect(types).toEqual(['hyrox_station_density', 'hyrox_station_technique']);
      if (wk.ph === 'build') expect(types).toEqual(['hyrox_brick', 'hyrox_station_density', 'hyrox_station_technique']);
      if (wk.ph === 'peak') {
        expect(types).toEqual(['hyrox_brick', 'hyrox_mini_brick', 'hyrox_station_density']);
        const secondary = prescribed(wk).find(w => w.t === 'hyrox_mini_brick')!;
        expect(secondary.hyroxLight).toBe(true);
        expect(secondary.hyroxRounds).toBe(4);
        expect(prescribed(wk).find(w => w.t === 'hyrox_brick')!.hyroxRounds).toBe(6);
      }
    });
  });

  it('a race-pace session holds the stored weakest station first, and the forecast\'s is stored at creation', () => {
    const s = build('intermediate', 8, 16, { customRaceDate: new Date(Date.now() + 16 * 7 * 86400000).toISOString().slice(0, 10) } as Partial<OnboardingState>);
    expect(s.hyroxConfig!.planWeakestStation).not.toBeUndefined();
    s.hyroxConfig!.planWeakestStation = 'sandbag_lunges';
    const wks = generateHyroxPlan(s);
    const rp = wks.flatMap(wk => prescribed(wk)).filter(w => w.t === 'hyrox_station_density');
    expect(rp.length).toBeGreaterThan(0);
    for (const w of rp) {
      expect(stations(w)[0].type).toBe('sandbag_lunges');
      expect(w.d).toContain("Sandbag Lunges is the forecast's weakest station.");
    }
    // Rebuilds read the stored station: the same plan twice.
    expect(JSON.stringify(generateHyroxPlan(s).map(w => w.triWorkouts))).toBe(JSON.stringify(wks.map(w => w.triWorkouts)));
  });
});

describe('the beginner load schedule in a plan', () => {
  it('sleds unloaded in weeks 1-2, then 50%; the others the standard implement at or below 60%; race weight from the race-weight week; bricks read the same loads', () => {
    const s = build('beginner', 5, 16, { biologicalSex: 'female' } as Partial<OnboardingState>);
    const tw = planTrainingWeeks(s);
    // Race weight from the week before the planned full sim (lane H2b part 2).
    const fullSim = [...hyroxSimWeeks(s, tw).entries()].find(([, v]) => v.kind === 'full')?.[0] ?? null;
    const rw = hyroxBeginnerRaceWeightWeek(tw, fullSim);
    for (let w = 2; w <= tw; w++) {
      for (const x of prescribed(s.wks[w - 1]).filter(isWork)) {
        for (const c of stations(x)) {
          if (c.loadKg == null) continue;
          const sled = c.type === 'sled_push' || c.type === 'sled_pull';
          if (w >= rw) expect(c.loadPct, `W${w} ${x.n} ${c.type}`).toBeUndefined();
          else if (sled && w <= 2) expect(c.loadKg).toBe(0);
          else if (sled) expect(c.loadKg).toBe(c.type === 'sled_push' ? 50 : 37.5); // 50% of 102 / 78, to the plate
          // The implement at or below 60% (W-Open: 8 kg kettlebells, a 5 kg
          // sandbag, a 2 kg ball: HYROX_IMPLEMENT_SIZES_KG).
          else expect(c.loadKg).toBe(hyroxLoadKgAt(c.type as HyroxStation, 'W-Open', 0.6));
        }
      }
    }
  });

  it('a station session rated easier than its target climbs each of its stations one plate the next time; on target holds; an injury suppresses', () => {
    const run = (rating: number | null, injured = false) => {
      const s = build('beginner', 5, 16, { biologicalSex: 'female' } as Partial<OnboardingState>);
      const tech = (w: number) => s.wks[w - 1].triWorkouts!.find(x => x.t === 'hyrox_station_technique')!;
      // W5 (base) holds both sleds; W6, the next session holding them, too.
      expect(loadsOf(tech(5))).toMatchObject({ sled_push: 50, sled_pull: 37.5 });
      // The athlete's own rating (an estimate from a synced recording holds
      // the load: hyrox-load-step-rating-source.test.ts).
      if (rating != null) {
        s.wks[4].rated[tech(5).id!] = rating;
        noteRatingSource(s.wks[4], tech(5).id!, 'user');
      }
      s.w = 6;
      if (injured) (s as unknown as { injuryState: unknown }).injuryState = { active: true, injuryPhase: 'acute', location: 'knee', runCapacity: 100, upperLoadCapacity: 100, lowerLoadCapacity: 100 };
      const wks = generateHyroxPlan(s);
      notes = wks[5].hyroxPlanNotes ?? [];
      card = hyroxLoadStepNote(wks[5].triWorkouts!.find(x => x.t === 'hyrox_station_technique')!);
      return loadsOf(wks[5].triWorkouts!.find(x => x.t === 'hyrox_station_technique'));
    };
    let notes: string[] = [];
    let card: string | null = null;
    expect(run(3)).toMatchObject({ sled_push: 52.5, sled_pull: 40 });
    // The session says so in one short note on its card (part 2).
    expect(card).toBe('Load up after an easy rating: Sled Push 50 to 52.5 kg, Sled Pull 37.5 to 40 kg.');
    // The week says why the load moved.
    expect(notes).toContain('W6: Sled Push load 50 to 52.5 kg (the last session holding it was rated easier than RPE 5)');
    expect(notes).toContain('W6: Sled Pull load 37.5 to 40 kg (the last session holding it was rated easier than RPE 5)');
    expect(run(5)).toMatchObject({ sled_push: 50, sled_pull: 37.5 });
    expect(notes.some(n => /load .* kg \(the last session/.test(n))).toBe(false);
    expect(card).toBeNull();
    expect(run(8)).toMatchObject({ sled_push: 50, sled_pull: 37.5 });
    expect(run(null)).toMatchObject({ sled_push: 50, sled_pull: 37.5 });
    expect(run(3, true)).toMatchObject({ sled_push: 50, sled_pull: 37.5 });
  });

  it('intermediate and advanced athletes train at race weight', () => {
    for (const band of ['novice', 'competitive'] as AbilityBand[]) {
      const s = build(band, 8, 12, { biologicalSex: 'male' } as Partial<OnboardingState>);
      for (const wk of s.wks) for (const x of prescribed(wk).filter(isWork)) for (const c of stations(x)) expect(c.loadPct).toBeUndefined();
    }
  });
});

describe('doubles, prescriptions and the MTL cap in the plan', () => {
  it('a doubles athlete trains half of every station, and every session says so once', () => {
    const s = build('intermediate', 8, 16, { hyroxFormat: 'open_doubles', biologicalSex: 'female', hyroxDivision: 'mixed' } as Partial<OnboardingState>);
    const work = s.wks.flatMap(wk => prescribed(wk)).filter(w => isWork(w) && w.t !== 'hyrox_assessment');
    expect(work.length).toBeGreaterThan(10);
    for (const w of work) {
      expect(w.d.match(/Doubles: half of every station/g)).toHaveLength(1);
      if (w.t === 'hyrox_station_technique') expect(w.hyroxRounds).toBe(1);
      if (w.t === 'hyrox_station_density') expect(w.hyroxRounds!).toBeLessThanOrEqual(2);
      // The woman in a mixed pair throws the Men Open ball to her own target.
      if (stations(w).some(c => c.type === 'wall_balls')) expect(w.d).toContain('6 kg ball to 2.70 m');
    }
  });

  it('every station session and brick states damper 6, sled lanes and the wall-ball target', () => {
    const s = build('advanced', 10, 16, { biologicalSex: 'male' } as Partial<OnboardingState>);
    for (const w of s.wks.flatMap(wk => prescribed(wk)).filter(x => isWork(x) && x.t !== 'hyrox_assessment')) {
      // A race simulation holds full stations (lane H2b part 2).
      const sim = w.t === 'hyrox_sim';
      for (const c of stations(w)) {
        if (c.type === 'ski_erg' || c.type === 'row_erg') expect(w.d).toMatch(sim ? /1000 m, damper 6/ : /250 m, damper 6/);
        if (c.type === 'sled_push' || c.type === 'sled_pull') expect(w.d).toMatch(sim ? /4 lanes \(50 m\)/ : /1 lane \(12\.5 m\)/);
        if (c.type === 'wall_balls') expect(w.d).toContain('6 kg ball to 3.00 m');
      }
      expect(w.d).not.toMatch(/—/);
    }
  });

  it('the MTL cap cuts the new sessions\' sets and stations, keeps the week\'s last station work, and the text follows the cut', () => {
    const s = build('intermediate', 10, 16);
    s.hyroxConfig!.mtlCap = Math.round(HYROX_MTL_CAP.intermediate / 3);
    const { detail } = generateHyroxPlanDetailed(s);
    let cut = 0;
    for (const d of detail.slice(1)) {
      if (d.phase === 'taper') continue;
      expect(prescribed({ triWorkouts: d.workouts } as Week).some(isWork), `W${d.week}`).toBe(true);
      const mtl = prescribed({ triWorkouts: d.workouts } as Week).reduce((a, w) => a + (w.musculoTendonLoad ?? 0), 0);
      if (mtl > s.hyroxConfig!.mtlCap + 1e-6) expect(d.adjustments.some(n => /MTL/.test(n))).toBe(true);
      if (d.adjustments.some(n => /MTL cap/.test(n) && /round|station/.test(n))) cut++;
      for (const w of d.workouts.filter(x => x.hyroxSpec && (x.t === 'hyrox_station_technique' || x.t === 'hyrox_station_density'))) {
        for (const c of stations(w)) expect(w.d).toMatch(new RegExp(`: ${hyroxComponentSets(c, w.hyroxRounds ?? 1)} × `));
        // Its stations, warm-up and finisher (lane H2b part 2).
        expect(w.musculoTendonLoad!).toBeCloseTo(stations(w).reduce((a, c) => a + c.mtl, 0) + (w.hyroxSpec?.warmup?.mtl ?? 0) + (w.hyroxSpec?.finisher?.mtl ?? 0), 6);
      }
    }
    expect(cut).toBeGreaterThan(0);
  });
});

describe('H2 integration review minors', () => {
  const ORIGINAL_TZ = process.env.TZ;
  const at = (iso: string) => {
    process.env.TZ = 'Europe/London';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  };
  const restore = () => {
    vi.useRealTimers();
    if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  };

  it('(a) week 1 of a short race plan for a beginner-tier woman at Pro-tier loads holds the chosen hours: the quality step runs again after the long run leaves', () => {
    at('2026-10-05T12:00:00');
    try {
      for (const [fmt, div] of [['pro_singles', undefined], ['pro_doubles', 'women'], ['open_doubles', 'mixed']] as const) {
        for (const race of ['2026-10-22', '2026-10-26', '2026-11-05']) {
          const s = build('beginner', 2, 0, { hyroxFormat: fmt, hyroxDivision: div, biologicalSex: 'female', customRaceDate: race } as Partial<OnboardingState>);
          for (let i = 0; i < planTrainingWeeks(s); i++) expect(minutes(s.wks[i]), `${fmt} ${race} W${i + 1}`).toBeLessThanOrEqual(120);
        }
      }
      // The review's example: the interval run leaves; the assessment stays.
      const s = build('beginner', 2, 0, { hyroxFormat: 'pro_singles', biologicalSex: 'female', customRaceDate: '2026-10-22' } as Partial<OnboardingState>);
      const w1 = prescribed(s.wks[0]);
      expect(w1.some(w => w.t === 'hyrox_assessment')).toBe(true);
      expect(w1.some(w => w.t === 'hyrox_run_intervals' || w.t === 'hyrox_run_tempo')).toBe(false);
      expect(minutes(s.wks[0])).toBeLessThanOrEqual(120);
    } finally { restore(); }
  });

  it('(b) a Thursday race keeps taper week 1\'s station work over the tempo when no other day is free', () => {
    at('2026-10-05T12:00:00');
    try {
      const s = build('total_beginner', 5, 0, { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed', biologicalSex: 'female', customRaceDate: '2026-12-24' } as Partial<OnboardingState>);
      const tw = planTrainingWeeks(s);
      const t1 = s.wks[tw - 2];
      expect(t1.ph).toBe('taper');
      expect(prescribed(t1).some(isWork)).toBe(true);
      // Since part 2 (2026-10-20) this week holds its station circuit beside
      // the tempo, so only the mini brick the race window drops is lost and
      // the tempo keeps its day. When the eased-tempo path runs, the tempo is
      // gone from the week.
      if ((t1.hyroxPlanNotes ?? []).some(n => /Tempo Run run easy \(the week keeps its station work/.test(n))) {
        expect(prescribed(t1).some(w => w.t === 'hyrox_run_tempo')).toBe(false);
      }
    } finally { restore(); }
  });

  it('(b) the race taper\'s brick is never longer or heavier than the reference week\'s brick of its type', () => {
    at('2026-10-05T12:00:00');
    try {
      let checked = 0;
      for (const band of ['total_beginner', 'beginner'] as AbilityBand[]) {
        for (const [sex, fmt] of [['male', 'open_singles'], ['female', 'pro_singles']] as const) {
          for (const race of ['2026-12-17', '2026-12-19', '2027-01-21', '2027-02-20']) {
            for (const h of [3, 5]) {
              const s = build(band, h, 0, { biologicalSex: sex, hyroxFormat: fmt, customRaceDate: race } as Partial<OnboardingState>);
              const tw = planTrainingWeeks(s);
              const phases = s.wks.map(w => w.ph);
              let ref = tw - 2;
              while (ref >= 1 && (s.wks[ref - 1].ph === 'taper' || isHyroxDeloadWeek(ref, phases))) ref--;
              if (ref < 1) continue;
              for (const b of prescribed(s.wks[tw - 2]).filter(w => w.discipline === 'brick')) {
                const same = prescribed(s.wks[ref - 1]).filter(w => w.t === b.t);
                if (same.length === 0) continue;
                checked++;
                expect(b.estimatedDurationMin!).toBeLessThanOrEqual(Math.max(...same.map(w => w.estimatedDurationMin ?? 0)) + 1e-6);
                expect(b.musculoTendonLoad!).toBeLessThanOrEqual(Math.max(...same.map(w => w.musculoTendonLoad ?? 0)) + 1e-6);
              }
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    } finally { restore(); }
  });

  it('(c) the version regeneration re-bands a stored plan on the planning band and moves the MTL cap with it', () => {
    // A 7800 s Open Singles finish: beginner on the old global scale (2:00+
    // was 7200 s), novice on the planning band (pooled thresholds 3774, 4869,
    // 6318 and 7853 s).
    expect(hyroxPlanningBandFor(7800, 'open_singles', undefined)).toBe('novice');
    const s = build('beginner', 5, 16);
    s.hyroxConfig!.previousHyroxTimeSec = 7800;
    s.hyroxConfig!.hyroxPreviousTimeFormat = 'open_singles';
    s.hyroxConfig!.athleteBand = 'beginner';
    s.hyroxConfig!.mtlCap = HYROX_MTL_CAP.beginner;
    s.hyroxConfig!.generatorVersion = HYROX_GENERATOR_VERSION - 1;
    expect(applyHyroxGeneratorRegen(s)).toBe(true);
    expect(s.hyroxConfig!.athleteBand).toBe('novice');
    expect(s.hyroxConfig!.mtlCap).toBe(HYROX_MTL_CAP.novice);
    expect(hyroxTier(s.hyroxConfig!.athleteBand)).toBe('intermediate');
    // Doubles: the doubles cap.
    const d = build('beginner', 5, 16, { hyroxFormat: 'open_doubles' } as Partial<OnboardingState>);
    d.hyroxConfig!.previousHyroxTimeSec = 7800;
    d.hyroxConfig!.hyroxPreviousTimeFormat = 'open_singles';
    d.hyroxConfig!.athleteBand = 'beginner';
    d.hyroxConfig!.generatorVersion = HYROX_GENERATOR_VERSION - 1;
    applyHyroxGeneratorRegen(d);
    expect(d.hyroxConfig!.athleteBand).toBe('novice');
    expect(d.hyroxConfig!.mtlCap).toBe(computeDoublesCap(HYROX_MTL_CAP.novice));
    // An old race the physiology does not vouch for keeps the slower band the
    // initializer gave it (its staleness rule, hyroxStalenessAdjustedBand):
    // a 70-min finish four years ago with a VDOT of 40 stays novice.
    const old = build('novice', 6, 16);
    old.v = 40;
    old.hyroxConfig!.previousHyroxTimeSec = 4200;
    old.hyroxConfig!.hyroxPreviousTimeFormat = 'open_singles';
    old.hyroxConfig!.hyroxPreviousRaceDate = new Date(Date.now() - 4 * 365 * 86400000).toISOString().slice(0, 10);
    old.hyroxConfig!.athleteBand = 'novice';
    old.hyroxConfig!.mtlCap = HYROX_MTL_CAP.novice;
    old.hyroxConfig!.generatorVersion = HYROX_GENERATOR_VERSION - 1;
    expect(hyroxPlanningBandFor(4200, 'open_singles', undefined)).toBe('advanced');
    applyHyroxGeneratorRegen(old);
    expect(old.hyroxConfig!.athleteBand).toBe('novice');
    expect(old.hyroxConfig!.mtlCap).toBe(HYROX_MTL_CAP.novice);
    // A first-timer (no previous time) keeps the band their running fitness gave.
    const f = build('total_beginner', 4, 16);
    const band = f.hyroxConfig!.athleteBand;
    f.hyroxConfig!.generatorVersion = HYROX_GENERATOR_VERSION - 1;
    applyHyroxGeneratorRegen(f);
    expect(f.hyroxConfig!.athleteBand).toBe(band);
    expect(getState().hyroxConfig!.generatorVersion).toBe(HYROX_GENERATOR_VERSION);
  });

  it('(c) every path that bands a stored previous race applies the staleness rule: log-a-race and the format fix give the regeneration\'s band', () => {
    const fourYearsAgo = new Date(Date.now() - 4 * 365 * 86400000).toISOString().slice(0, 10);
    // Log-a-race: the 70-min finish four years ago with a VDOT of 40 stays
    // novice (its time alone bands advanced), the band the version
    // regeneration and the initializer give it.
    const logged = build('novice', 6, 16);
    logged.v = 40;
    applyHyroxPrevTimeUpdate({ timeSec: 4200, format: 'open_singles', raceDateISO: fourYearsAgo });
    expect(getState().hyroxConfig!.athleteBand).toBe('novice');
    // A recent race is trusted: advanced.
    const recent = build('novice', 6, 16);
    recent.v = 40;
    applyHyroxPrevTimeUpdate({ timeSec: 4200, format: 'open_singles', raceDateISO: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) });
    expect(getState().hyroxConfig!.athleteBand).toBe('advanced');
    // The format fix on the same old race: novice whichever format it is filed under.
    const fixed = build('novice', 6, 16);
    fixed.v = 40;
    fixed.hyroxConfig!.previousHyroxTimeSec = 4200;
    fixed.hyroxConfig!.hyroxPreviousTimeFormat = 'pro_singles';
    fixed.hyroxConfig!.hyroxPreviousRaceDate = fourYearsAgo;
    applyHyroxPrevFormatChange('open_singles');
    expect(getState().hyroxConfig!.athleteBand).toBe('novice');
  });
});
