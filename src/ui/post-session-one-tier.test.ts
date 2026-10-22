// @vitest-environment jsdom
/**
 * One session, one tier word and one number on every surface (2026-10-22, E1).
 *
 * The surfaces quoted the Strain ring's number but picked the tier word from
 * different percents:
 * - the coach line (Home in running and HYROX, the coach page in every mode):
 *   session TSS over the planned day;
 * - triathlon Home and Readiness (capacityStrainNote): strain TSS over the
 *   capacity anchor max(planned, CTL/7);
 * - the Readiness page's Today's Strain card: strain TSS over the planned day.
 * So one session read "Solid session today. 58 TSS logged." on Home and "Big
 * session logged (58 TSS). Daily target well exceeded." on Readiness. Every
 * surface now calls postSessionNote (capacity-strain.ts): gated on a logged
 * session, tier from pctCapacity, the ring's number quoted.
 *
 * Real generators and resolver, real Home and Readiness renders (jsdom); the
 * coach page prints computeDailyCoach(s).primaryMessage verbatim
 * (coach-view.ts getClassicCoachHTML).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { getDefaultState, setState, resetState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { TL_PER_MIN } from '@/constants';
import { renderHomeView } from './home-view';
import { renderReadinessView } from './readiness-view';
import { getPlannedDayTSSContext } from './planned-day-tss';
import { computeDailyCoach } from '@/calculations/daily-coach';
import { computeCapacityStrain } from '@/calculations/capacity-strain';
import { localDateKey } from '@/utils/local-date';
import { createDefaultInjuryState } from '@/types/injury';
import type { SimulatorState } from '@/types/state';

const PLAN_MONDAY = new Date(2026, 8, 28, 12, 0, 0); // Monday 28 Sep 2026, local noon

function hyroxState(): SimulatorState {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = '2026-09-28';
  s.w = 1;
  s.tw = 16;
  s.hyroxConfig = {
    format: 'open_singles',
    athleteBand: band,
    hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0,
    mtlCap: HYROX_MTL_CAP[band],
    mtlHistory: [],
    runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
    stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
    bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
    weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
    generatorVersion: HYROX_GENERATOR_VERSION,
  } as SimulatorState['hyroxConfig'];
  s.wks = generateHyroxPlan(s);
  return s;
}

function runningState(): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'running',
    trackOnly: false,
    planStartDate: '2026-09-28',
    w: 1,
    tw: 18,
    rw: 4,
    rd: 'marathon',
    typ: 'balanced',
    v: 45,
    gs: 0,
    pac: { e: 330 },
    wks: [{ ph: 'base', rated: {}, skip: [] }],
  } as unknown as SimulatorState;
}

function triState(): SimulatorState {
  const s = {
    ...getDefaultState(),
    eventType: 'triathlon',
    trackOnly: false,
    planStartDate: '2026-09-28',
    w: 1,
    tw: 20,
    v: 50,
    pac: { e: 300, t: 250, i: 230, m: 275, r: 200 },
    wks: [],
    triConfig: {
      distance: '70.3',
      timeAvailableHoursPerWeek: 12,
      volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: 3 },
      bike: { hasPowerMeter: true, ftp: 220 },
      swim: { cssSecPer100m: 100 },
      weeksToRace: 20,
    },
  } as unknown as SimulatorState;
  s.wks = generateTriathlonPlan(s);
  return s;
}

/**
 * Today = the first planned day of the current week (PLAN_MONDAY's week),
 * 18:00. Logs a synced HR-less, unrated session at `mult` x the planned TSS
 * (minutes x TL_PER_MIN[5]) and `steps` steps.
 */
function sessionDay(s: SimulatorState, mult: number, steps: number): number {
  const ctx = getPlannedDayTSSContext(s, s.w);
  const dow = [0, 1, 2, 3, 4, 5, 6].find(d => ctx.plannedTSSForDay(d) > 0);
  expect(dow, 'the week holds a planned day').toBeDefined();
  vi.setSystemTime(new Date(PLAN_MONDAY.getTime() + dow! * 86400000 + 6 * 3600000)); // 18:00
  const planned = ctx.plannedTSSForDay(dow!);
  const minutes = Math.round((mult * planned) / TL_PER_MIN[5]);
  const start = new Date(PLAN_MONDAY.getTime() + dow! * 86400000 - 4 * 3600000); // 08:00
  const wk = s.wks[s.w - 1];
  wk.garminActuals = {
    ...(wk.garminActuals ?? {}),
    'garmin-sync-1': {
      garminId: 'sync-1', startTime: start.toISOString(), durationSec: minutes * 60, distanceKm: 0,
      avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, activityType: 'OTHER',
    } as any,
  };
  s.physiologyHistory = [{ date: localDateKey(new Date()), sleepScore: 80, steps } as any];
  return planned;
}

/**
 * Sets the athlete's chronic load so CTL/7 is `dailyCtlMult` x the planned day
 * (the capacity anchor above the plan). Triathlon reads triConfig.fitness;
 * running and HYROX read the live Signal B CTL, which seeds from
 * signalBBaseline only once a plan week is complete, so their scenario runs
 * in week 2. The live CTL is linear in the seed (no activity before today),
 * so the seed is scaled from a probe.
 */
function setDailyCtl(s: SimulatorState, planned: number, dailyCtlMult: number): void {
  const weeklyCtl = dailyCtlMult * planned * 7;
  if (s.eventType === 'triathlon') {
    const disc = (ctl: number) => ({ ctl, atl: ctl, tsb: 0 });
    (s.triConfig as any).fitness = {
      swim: disc(weeklyCtl * 0.2), bike: disc(weeklyCtl * 0.45), run: disc(weeklyCtl * 0.35),
      combinedCtl: weeklyCtl, crossTrainingCtl: 0, crossTrainingAtl: 0,
    };
    return;
  }
  const PROBE = 1000;
  s.signalBBaseline = PROBE;
  s.ctlBaseline = PROBE;
  const factor = computeCapacityStrain(s).weeklyCtl / PROBE;
  expect(factor, 'the seed reaches the live CTL').toBeGreaterThan(0);
  s.signalBBaseline = weeklyCtl / factor;
  s.ctlBaseline = weeklyCtl / factor;
}

/** Moves a state to week 2 of the same calendar (plan started a week earlier). */
function toWeek2(s: SimulatorState): void {
  s.planStartDate = '2026-09-21';
  s.w = 2;
  if (s.wks.length < 2) s.wks.push({ ph: 'base', rated: {}, skip: [] } as any);
}

/** An active rehab-phase injury (the plan is capped, the coach adds the injury blocker). */
function injure(s: SimulatorState): void {
  (s as any).injuryState = {
    ...createDefaultInjuryState(),
    active: true,
    injuryPhase: 'rehab',
    startDate: PLAN_MONDAY.toISOString(),
    currentPain: 3,
  };
}

const TIER = /(Big session|Solid session|Good training) today\. (\d+) TSS logged/;
const INJURY_CAP = /injury-capped day/;
const OLD_CARD_TIER = /Big session logged|Daily target well exceeded/;

const ringTSS = (): number => {
  const m = (document.getElementById('home-strain-ring')!.textContent ?? '').match(/(\d+)\s*TSS/);
  expect(m, 'the Strain ring shows a TSS number').not.toBeNull();
  return Number(m![1]);
};
const tierOf = (text: string | undefined | null): { word: string; tss: number } | null => {
  const m = (text ?? '').replace(/\s+/g, ' ').match(TIER);
  return m ? { word: m[1], tss: Number(m[2]) } : null;
};
const homeLine = (): string | undefined =>
  Array.from(document.querySelectorAll('p'))
    .map(p => (p.textContent ?? '').replace(/\s+/g, ' ').trim())
    .find(t => TIER.test(t));
const pageText = () => (document.getElementById('app-root')!.textContent ?? '').replace(/\s+/g, ' ');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
  resetState();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Every surface's tier, asserted equal (word and number) and quoting the ring. */
function expectOneTierEverywhere(s: SimulatorState): { word: string; tss: number } {
  setState(s);
  renderHomeView();
  const ring = ringTSS();
  const home = tierOf(homeLine());
  expect(home, 'Home prints a post-session tier').not.toBeNull();
  expect(home!.tss).toBe(ring);

  const coach = tierOf(computeDailyCoach(s).primaryMessage);
  expect(coach, 'the coach page prints a post-session tier').not.toBeNull();
  expect(coach).toEqual(home);

  document.body.innerHTML = '<div id="app-root"></div>';
  renderReadinessView();
  const card = tierOf(document.getElementById('rdn-card-strain')?.textContent);
  expect(card, "Readiness's Today's Strain card prints a post-session tier").not.toBeNull();
  expect(card).toEqual(home);
  // Any other tier on the Readiness page (the triathlon hero sentence) agrees.
  for (const m of pageText().matchAll(new RegExp(TIER, 'g'))) {
    expect({ word: m[1], tss: Number(m[2]) }).toEqual(home);
  }
  expect(pageText()).not.toMatch(OLD_CARD_TIER);
  return home!;
}

for (const [mode, build] of [['running', runningState], ['HYROX', hyroxState], ['triathlon', triState]] as const) {
  describe(`${mode}: one session, one tier word and number on every surface`, () => {
    it('a session at 1.1x the plan plus 14,000 steps', () => {
      const s = build();
      sessionDay(s, 1.1, 14000);
      expectOneTierEverywhere(s);
    });

    it('the capacity anchor above the plan: plan-relative "Big", capacity "Solid"', () => {
      const s = build();
      if (s.eventType !== 'triathlon') toWeek2(s);
      const planned = sessionDay(s, 1.45, 0);
      setDailyCtl(s, planned, 1.2);
      const cs = computeCapacityStrain(s);
      // The case that split the surfaces: strain over plan is in the Big tier,
      // strain over capacity in the Solid tier.
      expect(Math.round(cs.pctPlan), 'strain over plan').toBeGreaterThanOrEqual(130);
      expect(Math.round(cs.pctCapacity), 'strain over capacity').toBeGreaterThanOrEqual(100);
      expect(Math.round(cs.pctCapacity), 'strain over capacity').toBeLessThan(130);
      expect(expectOneTierEverywhere(s).word).toBe('Solid session');
    });

    for (const [label, setup] of [['healthy', (_s: SimulatorState) => {}], ['injured', injure]] as const) {
      it(`${label}: half the plan plus 20,000 or more steps prints no tier and no injury-cap line anywhere`, () => {
        const s = build();
        setup(s);
        // The case that read as a finished session: the strain (steps
        // included) in the Big tier and over the injury-cap margin, the session
        // alone half the plan. Steps rise from 20,000 in 5,000s until the
        // strain gets there (planned days differ in size by mode).
        let steps = 20000;
        sessionDay(s, 0.5, steps);
        while (computeCapacityStrain(s).pctCapacity < 130 && steps < 60000) {
          steps += 5000;
          sessionDay(s, 0.5, steps);
        }
        const cs = computeCapacityStrain(s);
        expect(Math.round(cs.pctCapacity), 'strain over capacity, steps included').toBeGreaterThanOrEqual(130);
        expect(cs.todayTSS, 'strain over the 1.3 injury-cap margin').toBeGreaterThan(cs.plannedDayTSS * 1.3);
        expect(Math.round(cs.sessionPctCapacity), 'the session alone').toBeLessThan(80);
        expect(cs.injuryCapOvershoot).toBe(false);
        setState(s);
        renderHomeView();
        expect(homeLine()).toBeUndefined();
        expect(pageText()).not.toMatch(INJURY_CAP);
        const coach = computeDailyCoach(s).primaryMessage;
        expect(coach).not.toMatch(TIER);
        expect(coach).not.toMatch(INJURY_CAP);
        document.body.innerHTML = '<div id="app-root"></div>';
        renderReadinessView();
        expect(pageText()).not.toMatch(TIER);
        expect(pageText()).not.toMatch(INJURY_CAP);
        expect(document.getElementById('rdn-card-strain')?.textContent ?? '').not.toMatch(/Session complete/);
      });
    }

    it('steps alone on a planned day print no session line anywhere', () => {
      const s = build();
      sessionDay(s, 1.1, 24000);
      s.wks[s.w - 1].garminActuals = {};
      setState(s);
      renderHomeView();
      expect(homeLine()).toBeUndefined();
      expect(tierOf(computeDailyCoach(s).primaryMessage)).toBeNull();
      document.body.innerHTML = '<div id="app-root"></div>';
      renderReadinessView();
      const card = (document.getElementById('rdn-card-strain')?.textContent ?? '').replace(/\s+/g, ' ');
      expect(card).not.toMatch(TIER);
      expect(card).not.toMatch(/Session in progress|Session complete/);
    });
  });
}
