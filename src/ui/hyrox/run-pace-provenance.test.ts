// @vitest-environment jsdom
/**
 * The Forecast's Run pace chip and the Stats run pace row name the same
 * provenance (ISSUE-406 (d)).
 *
 * After applyHyroxRunPaceDerivation stored a derived pace, deriveHyroxRunPace
 * returned it with source 'user' (the stored value won), and the Forecast chip
 * read that branch: "Set manually". Stats read hx.hyroxRunPaceSource:
 * "Updated from your runs". Both now read the pace's provenance.
 *
 * Real generator, real Forecast and Stats renders (jsdom).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { getDefaultState, setState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { applyHyroxRunPaceDerivation } from '@/calculations/hyrox-marker-bumps';
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { renderHyroxForecastView } from './forecast-view';
import { renderHyroxStatsView, hyroxRunPaceRowCaption } from './stats-view';
import { deriveHyroxRunPace } from '@/calculations/hyrox-run-pace';
import { fmtModelPaceKm } from '@/utils/format';
import { hyroxRunPaceSourceLabel, hyroxRunPaceCaption } from './forecast-labels';
import type { SimulatorState } from '@/types/state';

function hyroxState(): SimulatorState {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = '2026-09-28';
  s.w = 1;
  s.tw = 16;
  s.v = 46;
  s.vo2 = 46; // a measured runner (watch VO2max): the VDOT branch needs a real signal (D5)
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

function runPaceChipText(): string {
  return (document.querySelector('[data-hx-chip="runpace"]')?.textContent ?? '').replace(/\s+/g, ' ');
}

function pageText(): string {
  return (document.getElementById('app-root')!.textContent ?? '').replace(/\s+/g, ' ');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
});

describe('run pace provenance on the Forecast and Stats', () => {
  it('a stored derived pace reads as derived on both', () => {
    const s = hyroxState();
    expect(applyHyroxRunPaceDerivation(s)).toBe(true); // the launch pass stores it
    expect(s.hyroxConfig!.hyroxRunPaceSource).toBe('derived');
    expect(predictHyroxRace(s)!.runPaceSource).toBe('derived');
    setState(s);

    renderHyroxForecastView();
    expect(runPaceChipText()).toContain(hyroxRunPaceSourceLabel('derived'));
    expect(runPaceChipText()).not.toContain('Set manually');

    document.body.innerHTML = '<div id="app-root"></div>';
    renderHyroxStatsView();
    expect(pageText()).toContain(hyroxRunPaceCaption('derived'));
    expect(pageText()).not.toContain('Set manually.');
  });

  it('a pace the athlete set reads as set manually on both', () => {
    const s = hyroxState();
    s.hyroxConfig!.hyroxRunPaceSecKm = 330;
    s.hyroxConfig!.hyroxRunPaceSource = 'user';
    s.v = 30; // a low VDOT derives no pace 5 s/km faster than 330, so the athlete's pace stands
    const p = predictHyroxRace(s)!;
    expect(p.runPaceSource).toBe('user');
    setState(s);

    renderHyroxForecastView();
    expect(runPaceChipText()).toContain('Set manually');

    document.body.innerHTML = '<div id="app-root"></div>';
    renderHyroxStatsView();
    expect(pageText()).toContain('Set manually.');
  });
});

describe('Stats run pace row says which pace it is (D12)', () => {
  it('singles: the pace before venue, captioned so', () => {
    const s = hyroxState();
    setState(s);
    renderHyroxStatsView();
    expect(pageText()).toContain(hyroxRunPaceRowCaption(false));
    expect(hyroxRunPaceRowCaption(false)).toBe('Average of 8 legs, before venue');
  });

  it("doubles: the pair's pace, and the seed row shows the derivation's doubles seed", () => {
    const s = hyroxState();
    s.vo2 = null; // no real signal: the seed (D5)
    s.hyroxConfig!.format = 'open_doubles';
    const r = deriveHyroxRunPace(s);
    expect(r.provenance).toBe('seed');
    setState(s);
    renderHyroxStatsView();
    const text = pageText();
    expect(text).toContain('Pair pace, 8 legs, before venue');
    // The row's number is the forecast's base pace (doubles run ratio applied),
    // not the singles band seed.
    expect(text).toContain(`${fmtModelPaceKm(r.paceSecKm)}/km`);
  });
});
