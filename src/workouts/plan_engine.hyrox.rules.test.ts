/**
 * HYROX plan rules over plan lengths 8 to 24, every band and the hours range
 * (lane H2a, parameter sheet 2026-10-12 and Tristan's decisions of the same
 * day). Real initializer, real generator. Every week of every plan must hold:
 *   - the acute:chronic guard: a training week's planned load (canonical TSS)
 *     at most ACWR_SAFE_HIGH x the mean of the previous 4 planned weeks, weeks
 *     before week 1 counting as week 1 (deload weeks and the week after them
 *     included);
 *   - the single-run rule: no run longer than 110% of the longest run of the
 *     previous 4 weeks (LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST, distance);
 *   - no two hard sessions on consecutive days, Sunday to the next Monday
 *     included; at most 3 hard sessions and 2 hard runs a week;
 *   - 48 h between eccentric sessions (no two on consecutive days, across
 *     weeks too) and at most the structure's eccentric count (a generator
 *     check, not a sourced cap);
 *   - taper weeks at most taperFraction (0.70, then 0.55) of the reference
 *     week, or, where session floors hold them above, never above the week
 *     before; never above the week before in any case, except race week by
 *     its primer when the primer is all it holds (SCIENCE_LOG §CE update 4);
 *   - deload weeks at most HYROX_DELOAD_FACTOR of the last loaded week in
 *     planned minutes and TSS, with no more hard sessions or quality runs
 *     than that week (running's CV.4; review 2026-10-12: the median deload
 *     cut 9.4%);
 *   - race week holds the primer whenever it holds a run, at
 *     HYROX_RACE_WEEK_PRIMER_MIN with 10 min of tempo work, and its circuit
 *     no more rounds than the week before's;
 *   - every training week whose tier format calls for a quality run holds
 *     one, or the week's hyroxPlanNotes say why it does not (the share, the
 *     110% ceiling, the long run, the guard, the deload, the run slots);
 *   - the weekly MTL at most the cap, or a note says the floors held it above;
 *   - the long run is the week's longest run;
 *   - no brick in base, before plan week 5 or in race week;
 *   - one prescribed session a day.
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
import { plannedTssPerMin } from '@/constants';
import { ACWR_SAFE_HIGH } from '@/constants/triathlon-constants';
import {
  HYROX_HOURS_RANGE, HYROX_ECCENTRIC_SESSIONS_GENERATOR_CHECK, HYROX_FIRST_BRICK_WEEK,
  HYROX_MAX_HARD_SESSIONS, HYROX_MAX_HARD_RUNS, HYROX_MTL_CAP, HYROX_WEEKLY_SESSIONS,
  HYROX_QUALITY_FORMATS, HYROX_DELOAD_FACTOR, HYROX_RACE_WEEK_PRIMER_MIN, HYROX_WEEKLY_STRUCTURE,
  hyroxTier,
} from '@/constants/hyrox-constants';
import { isFourWeekCycleDeloadWeek, LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST, LONG_RUN_LOOKBACK_WEEKS } from './plan_engine';
import { taperFraction } from './phases';
import { isHighIntensity, isHardRun, isEccentricSession, isHyroxLongRun } from './scheduler.hyrox';
import {
  hyroxRunLengthKm, generateHyroxRun, generateHyroxStation, withHyroxRounds, withoutHyroxStation,
  MIN_CIRCUIT_ROUNDS, MIN_CIRCUIT_STATIONS,
} from './hyrox-generators';
import { generateHyroxPlan, generateHyroxPlanDetailed, regenerateHyroxWeek } from './plan_engine.hyrox';
import { planTrainingWeeks } from './race-week-layout';

const BANDS: AbilityBand[] = ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive'];
/** Previous open-singles finish time that bands an athlete; null = first-timer. */
const BAND_PREV_SEC: Record<AbilityBand, number | null> = {
  total_beginner: null, beginner: 7800, novice: 6600, intermediate: 5400, advanced: 4200, competitive: 3300,
};
const EPS = 1e-6;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

function build(band: AbilityBand, hours: number, weeks: number, over: Partial<OnboardingState> = {}): SimulatorState {
  resetState();
  const sec = BAND_PREV_SEC[band];
  initializeHyroxSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: hours, planDurationWeeks: weeks, customRaceDate: null,
    ...(sec != null ? { previousHyroxTimeSec: sec, hyroxPreviousTimeFormat: 'open_singles' } : {}),
    ...over,
  } as OnboardingState);
  return getState();
}

const prescribed = (wk: Week | undefined): Workout[] => (wk?.triWorkouts ?? []).filter(w => w.commute !== true);
const minutes = (wk: Week | undefined) => prescribed(wk).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
const tss = (wk: Week | undefined) =>
  prescribed(wk).reduce((a, w) => a + (w.estimatedDurationMin ?? 0) * plannedTssPerMin(w.t, w.rpe ?? w.r ?? 5), 0);
const runs = (wk: Week | undefined) => prescribed(wk).filter(w => w.discipline === 'run');
const longestKm = (wk: Week | undefined) => Math.max(0, ...runs(wk).map(hyroxRunLengthKm));
const isQuality = (w: Workout) => w.t === 'hyrox_run_tempo' || w.t === 'hyrox_run_intervals';
const isCircuit = (w: Workout) => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density';
const notes = (wk: Week | undefined) => wk?.hyroxPlanNotes ?? [];

/** Every rule violation of a built plan, as readable strings. */
function violations(s: SimulatorState): string[] {
  const out: string[] = [];
  const tw = planTrainingWeeks(s);
  const wks = s.wks.slice(0, tw);
  const tier = hyroxTier(s.hyroxConfig!.athleteBand);
  let taperStart = tw + 1;
  for (let w = tw; w >= 1 && wks[w - 1].ph === 'taper'; w--) taperStart = w;
  const taperLen = tw - taperStart + 1;

  // Placement across the whole plan: hard and eccentric adjacency, Sun to Mon included.
  const flat: Array<{ day: number; w: Workout; week: number }> = [];
  wks.forEach((wk, i) => {
    const days = prescribed(wk).map(w => w.dayOfWeek);
    if (new Set(days).size !== days.length) out.push(`W${i + 1}: two sessions on one day`);
    for (const w of prescribed(wk)) flat.push({ day: i * 7 + (w.dayOfWeek ?? 0), w, week: i + 1 });
  });
  flat.sort((a, b) => a.day - b.day);
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length && flat[j].day - flat[i].day <= 1; j++) {
      const a = flat[i]; const b = flat[j];
      if (isHighIntensity(a.w) && isHighIntensity(b.w)) out.push(`W${a.week}/W${b.week}: hard ${a.w.n} and ${b.w.n} on consecutive days`);
      if (isEccentricSession(a.w) && isEccentricSession(b.w)) out.push(`W${a.week}/W${b.week}: eccentric ${a.w.n} and ${b.w.n} within 48 h`);
    }
  }

  for (let i = 0; i < wks.length; i++) {
    const wk = wks[i];
    const w = i + 1;
    const ph = wk.ph as 'base' | 'build' | 'peak' | 'taper';
    const ws = prescribed(wk);
    const raceWeek = w === tw;
    // Hard-session counts.
    if (ws.filter(isHighIntensity).length > HYROX_MAX_HARD_SESSIONS) out.push(`W${w}: ${ws.filter(isHighIntensity).length} hard sessions`);
    if (ws.filter(isHardRun).length > HYROX_MAX_HARD_RUNS) out.push(`W${w}: ${ws.filter(isHardRun).length} hard runs`);
    // Eccentric generator check.
    const structPhase = ph === 'taper' || raceWeek ? 'peak' : ph;
    const ecc = ws.filter(isEccentricSession).length;
    if (ecc > HYROX_ECCENTRIC_SESSIONS_GENERATOR_CHECK[tier][structPhase]) out.push(`W${w}: ${ecc} eccentric sessions`);
    // Bricks.
    const bricks = ws.filter(x => x.discipline === 'brick');
    if (bricks.length > 0 && (ph === 'base' || w < HYROX_FIRST_BRICK_WEEK || raceWeek)) out.push(`W${w}: brick in ${raceWeek ? 'race week' : ph} week ${w}`);
    // Long run is the longest run.
    const long = ws.find(isHyroxLongRun);
    if (long) {
      for (const r of runs(wk)) if (hyroxRunLengthKm(r) > hyroxRunLengthKm(long) + EPS) out.push(`W${w}: ${r.n} longer than the long run`);
    }
    if (raceWeek && long) out.push(`W${w}: long run in race week`);
    // Single-run rule.
    if (w >= 2) {
      const prev = Math.max(0, ...wks.slice(Math.max(0, i - LONG_RUN_LOOKBACK_WEEKS), i).map(longestKm));
      if (prev > 0 && longestKm(wk) > prev * (1 + LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST) + EPS) {
        out.push(`W${w}: longest run ${longestKm(wk).toFixed(2)} km above 110% of ${prev.toFixed(2)} km`);
      }
    }
    // Deload ceiling: the last loaded week x HYROX_DELOAD_FACTOR.
    if (ph !== 'taper' && isFourWeekCycleDeloadWeek(w, ph)) {
      let ref = -1;
      for (let k = i - 1; k >= 0; k--) if (wks[k].ph !== 'taper' && !isFourWeekCycleDeloadWeek(k + 1, wks[k].ph)) { ref = k; break; }
      if (ref >= 0) {
        const r = wks[ref];
        if (minutes(wk) > HYROX_DELOAD_FACTOR * minutes(r) + EPS) out.push(`W${w}: deload ${minutes(wk)} min above ${HYROX_DELOAD_FACTOR} x W${ref + 1} (${minutes(r)})`);
        if (tss(wk) > HYROX_DELOAD_FACTOR * tss(r) + EPS) out.push(`W${w}: deload ${tss(wk).toFixed(1)} TSS above ${HYROX_DELOAD_FACTOR} x W${ref + 1} (${tss(r).toFixed(1)})`);
        if (ws.filter(isHighIntensity).length > prescribed(r).filter(isHighIntensity).length) out.push(`W${w}: deload holds more hard sessions than W${ref + 1}`);
        if (ws.filter(isQuality).length > prescribed(r).filter(isQuality).length) out.push(`W${w}: deload holds more quality runs than W${ref + 1}`);
      }
    }
    // Race week: the primer whenever it holds a run, at its fixed size; the
    // circuit no more rounds than the week before's.
    if (raceWeek) {
      const primer = ws.filter(isQuality);
      if (runs(wk).length > 0 && primer.length !== 1) out.push(`W${w}: race week holds ${primer.length} primers`);
      for (const p of primer) {
        if (p.estimatedDurationMin !== HYROX_RACE_WEEK_PRIMER_MIN || !/ 10 min at /.test(p.d ?? '')) out.push(`W${w}: race-week primer ${p.estimatedDurationMin} min (${p.d})`);
      }
      const prevRounds = Math.max(0, ...prescribed(wks[i - 1]).filter(isCircuit).map(x => x.hyroxRounds ?? 0));
      for (const c of ws.filter(isCircuit)) {
        if ((c.hyroxRounds ?? 0) > Math.max(prevRounds, MIN_CIRCUIT_ROUNDS)) out.push(`W${w}: race-week circuit ${c.hyroxRounds} rounds, the week before ${prevRounds}`);
      }
    }
    // Quality coverage: present, or a note says why not.
    if (ph !== 'taper' && !raceWeek && HYROX_QUALITY_FORMATS[tier][ph as 'base' | 'build' | 'peak'] && !ws.some(isQuality)) {
      if (!notes(wk).some(n => /quality run|Tempo Run|Interval Run/.test(n))) out.push(`W${w}: no quality run and no note why`);
    }
    // Weekly MTL cap.
    const mtl = ws.reduce((a, x) => a + (x.musculoTendonLoad ?? 0), 0);
    if (mtl > s.hyroxConfig!.mtlCap + EPS && !notes(wk).some(n => /MTL/.test(n))) out.push(`W${w}: MTL ${mtl.toFixed(0)} above the ${s.hyroxConfig!.mtlCap} cap with no note`);
    // Acute:chronic guard on training weeks.
    if (w >= 2 && ph !== 'taper') {
      let chronic = 0;
      for (let k = 1; k <= 4; k++) chronic += tss(wks[i - k] ?? wks[0]);
      chronic /= 4;
      if (tss(wk) > ACWR_SAFE_HIGH * chronic + EPS) out.push(`W${w}: planned ${tss(wk).toFixed(1)} TSS above ${(ACWR_SAFE_HIGH * chronic).toFixed(1)}`);
    }
    // Taper fractions.
    if (ph === 'taper' && w >= taperStart) {
      let refMin = (s.hyroxConfig!.weeklyHoursAvailable) * 60;
      for (let k = taperStart - 2; k >= 0; k--) {
        if (wks[k].ph !== 'taper' && !isFourWeekCycleDeloadWeek(k + 1, wks[k].ph)) { refMin = minutes(wks[k]); break; }
      }
      const ceiling = taperFraction(w - taperStart + 1, taperLen) * refMin;
      const raw = w >= 2 ? minutes(wks[i - 1]) : Infinity;
      // Race week may sit above the week before by its primer when the primer
      // is all it holds.
      const before = raceWeek ? Math.max(raw, HYROX_RACE_WEEK_PRIMER_MIN) : raw;
      if (minutes(wk) > Math.max(ceiling, before) + EPS) out.push(`W${w}: taper ${minutes(wk)} min above ${Math.round(ceiling)} and the week before (${raw})`);
      if (minutes(wk) > before + EPS) out.push(`W${w}: taper ${minutes(wk)} min above the week before (${raw})`);
    }
  }
  return out;
}

describe('HYROX plan rules: plan lengths 8 to 24, every band, the hours range', () => {
  for (const band of BANDS) {
    it(`${band}`, () => {
      const range = HYROX_HOURS_RANGE[band];
      const found: string[] = [];
      let plans = 0;
      for (let len = 8; len <= 24; len++) {
        for (const hrs of [range.min, range.default, range.max]) {
          const s = build(band, hrs, len);
          plans++;
          for (const v of violations(s)) found.push(`${len}w ${hrs}h: ${v}`);
        }
      }
      expect(plans).toBe(17 * 3);
      expect(found.slice(0, 10)).toEqual([]);
    });
  }

  it('race-date plans (Thursday and Saturday races, Sunday and Wednesday onboarding) hold the same rules', () => {
    const found: string[] = [];
    const ORIGINAL_TZ = process.env.TZ;
    process.env.TZ = 'Europe/London';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const now of ['2026-10-04T12:00:00', '2026-10-07T12:00:00']) {
        vi.setSystemTime(new Date(now));
        for (const race of ['2026-12-03', '2026-12-05', '2027-02-20']) {
          for (const band of BANDS) {
            const s = build(band, HYROX_HOURS_RANGE[band].default, 0, { customRaceDate: race } as Partial<OnboardingState>);
            for (const v of violations(s)) found.push(`${now.slice(0, 10)} ${race} ${band}: ${v}`);
          }
        }
      }
    } finally {
      vi.useRealTimers();
      if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
    }
    expect(found.slice(0, 10)).toEqual([]);
  });
});

describe('HYROX weekly structure and session counts', () => {
  it('slider extra sessions go to easy runs (up to 5), never bricks or station sessions', () => {
    for (const band of BANDS) {
      const def = HYROX_WEEKLY_SESSIONS[band];
      const s = build(band, HYROX_HOURS_RANGE[band].max, 16, { hyroxWeeklySessionCount: 7 } as Partial<OnboardingState>);
      const hx = s.hyroxConfig!;
      expect(hx.stationSessionsPerWeek).toBe(def.stations);
      expect(hx.bricksPerWeek).toBe(def.bricks);
      expect(hx.runsPerWeek).toBe(Math.min(5, def.runs + (7 - def.runs - def.stations - def.bricks)));
      for (const wk of s.wks) {
        expect(prescribed(wk).filter(w => w.discipline === 'station').length).toBeLessThanOrEqual(def.stations);
        expect(prescribed(wk).filter(w => w.discipline === 'brick').length).toBeLessThanOrEqual(hyroxTier(band) === 'advanced' ? 2 : 1);
      }
    }
  });

  it('advanced peak holds a key brick and a secondary brick that is not a hard session', () => {
    const s = build('advanced', 10, 18);
    const peak = s.wks.filter(wk => wk.ph === 'peak');
    expect(peak.length).toBeGreaterThan(0);
    const withTwo = peak.filter(wk => prescribed(wk).filter(w => w.discipline === 'brick').length === 2);
    expect(withTwo.length).toBeGreaterThan(0);
    for (const wk of withTwo) {
      const bricks = prescribed(wk).filter(w => w.discipline === 'brick');
      expect(bricks.filter(isHighIntensity)).toHaveLength(1);
      const light = bricks.find(w => w.hyroxLight)!;
      expect(isEccentricSession(light)).toBe(false);
    }
  });

  it('every week of a plan of 3 or more weeks ends in a 2-week taper', () => {
    for (const len of [8, 12, 18, 24]) {
      const s = build('intermediate', 8, len);
      expect(s.wks.filter(wk => wk.ph === 'taper')).toHaveLength(2);
    }
  });
});

describe('HYROX long run', () => {
  it('starts at the tier start (no logged runs; beginners 30 min) and steps 5 min every 3 weeks to the tier cap', () => {
    const first = (s: SimulatorState) => prescribed(s.wks[0]).find(isHyroxLongRun)!.estimatedDurationMin;
    expect(first(build('total_beginner', 4, 18))).toBe(30);
    expect(first(build('intermediate', 8, 18))).toBe(60);
    expect(first(build('advanced', 10, 18))).toBe(75);
    const s = build('advanced', 16, 24);
    const longs = s.wks.filter(wk => wk.ph !== 'taper').map(wk => prescribed(wk).find(isHyroxLongRun)?.estimatedDurationMin ?? 0);
    expect(Math.max(...longs)).toBeLessThanOrEqual(90);
  });

  it('starts at no more than 110% of the longest run logged in the 30 days before the plan', () => {
    resetState();
    const ms = getMutableState();
    // A 25-min run 10 days before today (no distance: its duration stands in).
    ms.onboardingRunHistory = [{ startTime: new Date(Date.now() - 10 * 86400000).toISOString(), activityType: 'RUNNING', distKm: 0, durSec: 25 * 60 } as never];
    initializeHyroxSimulator({
      ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', trainingMode: 'hyrox', hyroxFormat: 'open_singles',
      triTimeAvailableHoursPerWeek: 8, planDurationWeeks: 16, customRaceDate: null,
      previousHyroxTimeSec: 5400, hyroxPreviousTimeFormat: 'open_singles',
      onboardingRunHistory: ms.onboardingRunHistory,
    } as unknown as OnboardingState);
    const s = getState();
    const long = prescribed(s.wks[0]).find(isHyroxLongRun)!;
    expect(long.estimatedDurationMin).toBe(Math.floor(25 * (1 + LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST)));
  });
});

describe('HYROX quality runs', () => {
  it('tier formats: intermediate peak 8 x 1 km at goal race pace, advanced peak 6 x 4 min by heart rate, beginner base easy only', () => {
    const s = build('intermediate', 12, 18);
    const peak = s.wks.find(wk => wk.ph === 'peak' && !isFourWeekCycleDeloadWeek(wk.w, 'peak'))!;
    const q = prescribed(peak).find(w => w.t === 'hyrox_run_intervals');
    expect(q?.d).toMatch(/8 × 1 km at goal race pace/);
    const adv = build('advanced', 12, 18);
    const advPeak = adv.wks.find(wk => wk.ph === 'peak' && !isFourWeekCycleDeloadWeek(wk.w, 'peak'))!;
    expect(prescribed(advPeak).find(w => w.t === 'hyrox_run_intervals')?.d).toMatch(/6 × 4 min at about 90% of max HR/);
    const beg = build('beginner', 5, 18);
    for (const wk of beg.wks.filter(w => w.ph === 'base')) {
      expect(prescribed(wk).some(w => w.t === 'hyrox_run_tempo' || w.t === 'hyrox_run_intervals')).toBe(false);
    }
    expect(HYROX_QUALITY_FORMATS.beginner.base).toBeNull();
  });

  it('tempo pace: threshold pace with a real running-fitness signal, HYROX race pace (labelled) without one', () => {
    const fmt = { kind: 'run_tempo' as const, workMin: 25 };
    const withLt = generateHyroxRun({ kind: 'run_tempo', targetMinutes: 0, format: fmt, band: 'intermediate', phase: 'build', slotIndex: 1, runPaceSecKm: 330, thresholdPaceSecKm: 290 });
    expect(withLt.d).toContain('25 min at threshold pace (~4:50/km)');
    expect(withLt.estimatedDurationMin).toBe(40);
    const without = generateHyroxRun({ kind: 'run_tempo', targetMinutes: 0, format: fmt, band: 'intermediate', phase: 'build', slotIndex: 1, runPaceSecKm: 330 });
    expect(without.d).toContain('25 min at HYROX race pace (~5:30/km)');
  });
});

describe('HYROX MTL cap cuts real station volume', () => {
  it('withHyroxRounds cuts rounds, MTL, duration and the description together', () => {
    const w = generateHyroxStation({
      kind: 'station_density', targetMinutes: 55, band: 'advanced', stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      phase: 'build', slotIndex: 1,
    });
    expect(w.hyroxRounds).toBeGreaterThan(2);
    const cut = withHyroxRounds(w, 2);
    expect(cut.hyroxRounds).toBe(2);
    expect(cut.musculoTendonLoad!).toBeCloseTo(w.musculoTendonLoad! * 2 / w.hyroxRounds!, 6);
    expect(cut.estimatedDurationMin!).toBeLessThan(w.estimatedDurationMin!);
    expect(cut.d.startsWith('2 rounds')).toBe(true);
  });

  it('a week over its MTL cap prescribes fewer station or brick rounds, not just smaller numbers', () => {
    const s = build('intermediate', 14, 18);
    const cap = HYROX_MTL_CAP.intermediate;
    const uncapped = (() => {
      const ms = getMutableState();
      const saved = ms.hyroxConfig!.mtlCap;
      ms.hyroxConfig!.mtlCap = 1e9;
      const plan = generateHyroxPlan(ms);
      ms.hyroxConfig!.mtlCap = saved;
      return plan;
    })();
    let cutWeeks = 0;
    s.wks.forEach((wk, i) => {
      const before = prescribed(uncapped[i]).filter(w => w.discipline !== 'run').reduce((a, w) => a + (w.hyroxRounds ?? 0), 0);
      const after = prescribed(wk).filter(w => w.discipline !== 'run').reduce((a, w) => a + (w.hyroxRounds ?? 0), 0);
      const mtl = prescribed(wk).reduce((a, w) => a + (w.musculoTendonLoad ?? 0), 0);
      if (after < before) {
        cutWeeks++;
        // The reported MTL is the sum of what the sessions prescribe.
        expect(mtl).toBeCloseTo(prescribed(wk).reduce((a, w) => a + (w.hyroxComponents ?? []).reduce((b, c) => b + c.mtl, 0), 0), 6);
      }
    });
    expect(cutWeeks).toBeGreaterThan(0);
    expect(cap).toBeGreaterThan(0);
  });
});

describe('HYROX plan detail', () => {
  it('reports the guard and the taper budgets it built each week with', () => {
    const s = build('intermediate', 8, 18);
    const { detail } = generateHyroxPlanDetailed(s);
    expect(detail).toHaveLength(18);
    for (const d of detail) {
      if (d.acwrCapTss != null) expect(d.plannedTss).toBeLessThanOrEqual(d.acwrCapTss + EPS);
    }
    const loaded = detail.filter(d => d.phase !== 'taper' && !d.deload);
    const ref = loaded[loaded.length - 1];
    expect(detail[16].budgetMin).toBe(Math.round(0.70 * ref.plannedMin));
    expect(detail[17].budgetMin).toBe(Math.round(0.55 * ref.plannedMin));
  });
});

describe('HYROX review fixes (2026-10-13)', () => {
  /** Training weeks of every band at its default hours over lengths 8 to 24. */
  function grid(): SimulatorState[] {
    const out: SimulatorState[] = [];
    for (const band of BANDS) {
      for (let len = 8; len <= 24; len += 2) out.push(structuredClone(build(band, HYROX_HOURS_RANGE[band].default, len)));
    }
    return out;
  }

  it('every deload week is at most HYROX_DELOAD_FACTOR of the last loaded week (minutes and TSS)', () => {
    let checked = 0;
    let worst = 0;
    for (const s of grid()) {
      const { detail } = generateHyroxPlanDetailed(s);
      let last: (typeof detail)[number] | null = null;
      for (const d of detail) {
        if (d.phase === 'taper') continue;
        if (!d.deload) { last = d; continue; }
        if (!last) continue;
        checked++;
        worst = Math.max(worst, d.plannedMin / last.plannedMin, d.plannedTss / last.plannedTss);
        expect(d.deloadCapMin).toBeCloseTo(HYROX_DELOAD_FACTOR * last.plannedMin, 6);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(worst).toBeLessThanOrEqual(HYROX_DELOAD_FACTOR + EPS);
  });

  it('a deload holds no session longer, or with more rounds, than the same session in the last loaded week', () => {
    for (const s of grid()) {
      const tw = planTrainingWeeks(s);
      let last: Week | null = null;
      for (let i = 0; i < tw; i++) {
        const wk = s.wks[i];
        if (wk.ph === 'taper') continue;
        if (!isFourWeekCycleDeloadWeek(i + 1, wk.ph)) { last = wk; continue; }
        if (!last) continue;
        for (const w of prescribed(wk).filter(x => (x.discipline === 'station' || x.discipline === 'brick') && x.t !== 'hyrox_assessment')) {
          const same = prescribed(last).filter(x => x.t === w.t);
          if (same.length === 0) continue;
          expect(w.hyroxRounds ?? 0).toBeLessThanOrEqual(Math.max(...same.map(x => x.hyroxRounds ?? 0)));
        }
      }
    }
  });

  it('race week holds the primer whenever it holds a run: 10 min of tempo work, never sized from the budget', () => {
    let seen = 0;
    for (const s of grid()) {
      const rw = s.wks[planTrainingWeeks(s) - 1];
      const primer = prescribed(rw).filter(isQuality);
      if (runs(rw).length > 0) { expect(primer).toHaveLength(1); seen++; }
      for (const p of primer) {
        expect(p.estimatedDurationMin).toBe(HYROX_RACE_WEEK_PRIMER_MIN);
        expect(p.d).toMatch(/ 10 min at /);
      }
    }
    expect(seen).toBeGreaterThan(50);
  });

  it('race week keeps the peak structure minus the brick at the default hours (the primer, easy runs, the circuit)', () => {
    for (const band of BANDS) {
      const peak = HYROX_WEEKLY_STRUCTURE[hyroxTier(band)].peak;
      // 16 weeks: the week before the taper is a loaded week.
      const s = build(band, HYROX_HOURS_RANGE[band].default, 16);
      const rw = prescribed(s.wks[planTrainingWeeks(s) - 1]);
      expect(rw.filter(w => w.discipline === 'run')).toHaveLength(peak.runs);
      expect(rw.filter(w => w.discipline === 'station')).toHaveLength(peak.stations);
      expect(rw.filter(w => w.discipline === 'brick')).toHaveLength(0);
      // 18 weeks: week 16 is a deload, so taper week 1 sits under it and race
      // week may shed a session to stay under taper week 1 (the taper never
      // rises); the note says so.
      const s18 = build(band, HYROX_HOURS_RANGE[band].default, 18);
      const rw18 = s18.wks[planTrainingWeeks(s18) - 1];
      const held = prescribed(rw18).filter(w => w.discipline === 'run').length + prescribed(rw18).filter(w => w.discipline === 'station').length;
      if (held < peak.runs + peak.stations) expect(notes(rw18).some(n => /the taper never rises/.test(n))).toBe(true);
    }
  });

  it('the generator notes persist on the week (Week.hyroxPlanNotes) and match the plan detail', () => {
    const s = build('advanced', 4, 12);
    const { weeks, detail } = generateHyroxPlanDetailed(s);
    let noted = 0;
    detail.forEach((d, i) => {
      expect(weeks[i].hyroxPlanNotes ?? []).toEqual(d.adjustments);
      if (d.adjustments.length > 0) noted++;
    });
    expect(noted).toBeGreaterThan(0);
    // The stored plan carries them too.
    expect(s.wks.some(wk => (wk.hyroxPlanNotes ?? []).length > 0)).toBe(true);
  });

  it('a long run trimmed for a quality run that then leaves the week keeps its full length', () => {
    // Review 2026-10-12: advanced, 4 h, 12 weeks, week 5 trimmed its long run
    // to 34 min for a tempo run that then left the week (longer than the long
    // run), against 60 min in week 3, the last loaded week.
    const s = build('advanced', 4, 12);
    const longOf = (wk: Week) => prescribed(wk).find(isHyroxLongRun)?.estimatedDurationMin ?? 0;
    expect(prescribed(s.wks[4]).some(isQuality)).toBe(false);
    expect(notes(s.wks[4]).some(n => /Tempo Run longer than the long run/.test(n))).toBe(true);
    expect(longOf(s.wks[4])).toBeGreaterThanOrEqual(longOf(s.wks[2]));
  });

  it('withoutHyroxStation takes one station out of a circuit: component, MTL, duration and description', () => {
    const w = generateHyroxStation({
      kind: 'station_technique', targetMinutes: 50, band: 'intermediate', stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      phase: 'build', slotIndex: 1,
    });
    const stations = (w.hyroxComponents ?? []).filter(c => c.type !== 'run');
    expect(stations.length).toBeGreaterThan(MIN_CIRCUIT_STATIONS);
    const gone = stations[0].type as HyroxStation;
    const cut = withoutHyroxStation(w, gone);
    expect((cut.hyroxComponents ?? []).some(c => c.type === gone)).toBe(false);
    expect(cut.musculoTendonLoad!).toBeCloseTo((cut.hyroxComponents ?? []).reduce((a, c) => a + c.mtl, 0), 6);
    expect(cut.estimatedDurationMin!).toBeLessThan(w.estimatedDurationMin!);
    expect(cut.d.split(' + ').length).toBe(w.d.split(' + ').length - 1);
    // Never below MIN_CIRCUIT_STATIONS.
    let floor = cut;
    for (const c of stations.slice(1)) floor = withoutHyroxStation(floor, c.type as never);
    expect((floor.hyroxComponents ?? []).filter(c => c.type !== 'run').length).toBe(MIN_CIRCUIT_STATIONS);
  });

  it('the weekly MTL cap cuts rounds, then stations, then the technique session, and notes each step', () => {
    const s = build('total_beginner', 8, 16);
    const ms = getMutableState();
    ms.hyroxConfig!.mtlCap = 1; // every week over: every lever fires
    const plan = generateHyroxPlanDetailed(ms);
    const all = plan.detail.flatMap(d => d.adjustments).join('\n');
    expect(all).toMatch(/round\(s\) cut \(MTL cap 1\)|station\(s\) taken out of a circuit \(MTL cap 1\)|technique station session left out \(MTL cap 1\)/);
    for (const d of plan.detail) {
      const mtl = prescribed({ triWorkouts: d.workouts } as Week).reduce((a, w) => a + (w.musculoTendonLoad ?? 0), 0);
      if (mtl > 1) expect(d.adjustments.some(n => /MTL/.test(n))).toBe(true);
    }
    expect(s.hyroxConfig!.mtlCap).toBe(1);
  });

  it('regenerating the current week reads the stored week before: no hard Monday after a stored hard Sunday', () => {
    const s = build('advanced', 10, 16);
    const ms = getMutableState();
    ms.w = 6;
    // The user moved a hard session to the stored week 5's Sunday.
    const hardSunday: Workout = {
      ...generateHyroxRun({ kind: 'run_tempo', targetMinutes: 40, band: 'advanced', phase: 'build', slotIndex: 5 }),
      id: 'W5-moved', dayOfWeek: 6, dayName: 'Sun',
    };
    ms.wks[4].triWorkouts = [...(ms.wks[4].triWorkouts ?? []).filter(w => w.dayOfWeek !== 6), hardSunday];
    const regen = regenerateHyroxWeek(ms, 6)!;
    const monday = (regen.triWorkouts ?? []).filter(w => w.dayOfWeek === 0);
    expect(monday.some(isHighIntensity)).toBe(false);
    // The full regeneration from s.w (rebake, version bump) holds it as well.
    const plan = generateHyroxPlan(ms);
    expect((plan[5].triWorkouts ?? []).filter(w => w.dayOfWeek === 0).some(isHighIntensity)).toBe(false);
    expect(s.tw).toBe(16);
  });
});
