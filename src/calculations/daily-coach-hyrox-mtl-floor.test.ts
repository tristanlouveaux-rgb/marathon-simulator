// @vitest-environment jsdom
/**
 * The coach's readiness sees the HYROX MTL floor that Home and Readiness apply.
 *
 * Home (buildReadinessRing) and the Readiness page pass the canonical MTL load
 * ratio (mtl.ts hyroxMtlAcwr) to their own computeReadiness call, and draw the
 * ring score and colour from it. The ring label, the sentence under it and the
 * coach stance come from computeDailyCoach, whose computeReadiness call had no
 * mtlAcwr. Once f2 let completions reach chronic MTL, the floor could fire: a
 * real ramp capped the ring at 34 in Ease Back colour while the coach read 61
 * and the label under the ring said "On Track".
 *
 * Real generator, real ramp (easy runs only in weeks 1 to 4, then every
 * session in week 5), real computeDailyCoach, real Home and Readiness renders.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { getDefaultState, setState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { computeMTLFitnessFatigue, hyroxMtlAcwr } from './mtl';
import { computeDailyCoach } from './daily-coach';
import { renderHomeView } from '@/ui/home-view';
import { renderReadinessView } from '@/ui/readiness-view';
import type { SimulatorState, Week, Workout } from '@/types/state';

function hyroxState(): SimulatorState {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = '2026-09-28'; // a Monday
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
  };
  s.wks = generateHyroxPlan(s);
  return s;
}

/** The slot record a HYROX completion writes (wk.garminActuals[id]). */
function complete(wk: Week, w: Workout): void {
  wk.garminActuals ??= {};
  wk.garminActuals[w.id!] = {
    garminId: `guided-manual-${w.id}`, startTime: null, distanceKm: 0,
    durationSec: (w.estimatedDurationMin ?? 0) * 60,
    avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
  };
}

/** Easy runs only in weeks 1 to 4, every session of week 5; today is in week 5. */
function rampState(): SimulatorState {
  const s = hyroxState();
  for (let week = 1; week <= 4; week++) {
    const wk = s.wks[week - 1];
    (wk.triWorkouts ?? []).filter(w => w.n === 'Easy Run').forEach(w => complete(wk, w));
  }
  s.w = 5;
  (s.wks[4].triWorkouts ?? []).forEach(w => complete(s.wks[4], w));
  const { mtlCTL, mtlATL } = computeMTLFitnessFatigue(s.wks, s.w - 1); // main.ts launch refresh
  s.hyroxConfig!.mtlCTL = mtlCTL;
  s.hyroxConfig!.mtlATL = mtlATL;
  return s;
}

/** Score and label printed in a ring container: "<score><label>". */
function ringText(el: Element | null): { score: number; label: string } {
  expect(el).not.toBeNull();
  const text = (el!.textContent ?? '').replace(/\s+/g, ' ').trim();
  const m = text.match(/(\d+)\s*(Primed|On Track|Manage Load|Ease Back|Overreaching)/);
  expect(m, text).not.toBeNull();
  return { score: Number(m![1]), label: m![2] };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 29, 12, 0, 0)); // Thursday of plan week 5, local noon
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('coach readiness on a HYROX MTL ramp', () => {
  it('the coach readiness carries the MTL floor', () => {
    const s = rampState();
    expect(hyroxMtlAcwr(s)!.ratio!).toBeGreaterThan(1.5);

    const coach = computeDailyCoach(s);
    expect(coach.readiness.hardFloor).toBe('mtlLoad');
    expect(coach.readiness.score).toBe(34);
    expect(coach.readiness.label).toBe('Ease Back');
    expect(coach.ringLabel).toBe('Ease Back');
  });

  it('Home ring: score and label agree with the coach', () => {
    const s = rampState();
    setState(s);
    renderHomeView();
    const ring = ringText(document.getElementById('home-readiness-ring'));
    const coach = computeDailyCoach(s);
    expect(ring.score).toBe(34);
    expect(ring.score).toBe(coach.readiness.score);
    expect(ring.label).toBe('Ease Back');
    expect(ring.label).toBe(coach.ringLabel);
  });

  it('Readiness page ring: score and label agree with the coach', () => {
    const s = rampState();
    setState(s);
    renderReadinessView();
    const circle = document.getElementById('rdn-ring-circle');
    const ring = ringText(circle?.closest('svg')?.parentElement ?? null);
    const coach = computeDailyCoach(s);
    expect(ring.score).toBe(34);
    expect(ring.score).toBe(coach.readiness.score);
    expect(ring.label).toBe(coach.ringLabel);
  });

  it('is HYROX only: a running plan passes no MTL ratio to the coach', () => {
    const s = rampState();
    s.eventType = 'running' as any;
    expect(hyroxMtlAcwr(s)).toBeNull();
    expect(computeDailyCoach(s).readiness.hardFloor).not.toBe('mtlLoad');
  });
});
