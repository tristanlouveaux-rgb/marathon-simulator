// @vitest-environment jsdom
/**
 * Readiness MTL card reads the week's actual MTL from the shared computation.
 *
 * The card read `hyroxConfig.weeklyActualMTL`, which only the matcher's HYROX
 * station branch adds to. Runs, GPS runs, Mark as Done and quick done never
 * reach it, so once f2 made those completions count, Stats showed the week's
 * completed MTL while the Readiness card showed station matches only (0 for a
 * week of runs). Both now read computeWeekActualMTL / computeWeekMTL on the
 * current week, the numbers Stats and the MTL page show.
 *
 * Real generator, real Readiness render (jsdom).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDefaultState, setState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { computeWeekActualMTL, computeWeekMTL } from '@/calculations/mtl';
import { renderReadinessView } from './readiness-view';
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

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
});

describe('Readiness MTL card', () => {
  it('a week of completed runs shows their MTL, the same number Stats shows', () => {
    const s = hyroxState();
    const wk = s.wks[0];
    for (const w of wk.triWorkouts ?? []) if (w.discipline === 'run') complete(wk, w);
    setState(s);

    renderReadinessView();
    const card = document.getElementById('rdn-card-mtl');
    expect(card).not.toBeNull();

    const actual = Math.round(computeWeekActualMTL(wk));
    const planned = Math.round(computeWeekMTL(wk));
    expect(actual).toBeGreaterThan(0);
    expect(card!.textContent).toContain(`${actual} / ${HYROX_MTL_CAP.intermediate} MTL this week · ${planned} planned`);
  });
});
