// @vitest-environment jsdom
/**
 * MTL detail page reads the current week and the shared completion test.
 *
 * Two faults surfaced once f2 made HYROX completions count:
 *  - the page indexed weeks[s.w] with a 1-based s.w, so it showed NEXT week:
 *    its sessions as "This week", an actual MTL of 0 and chronic / acute one
 *    week ahead of the Stats card and the readiness floor;
 *  - the "This week" rows marked a session completed only on
 *    `matchedActivityId`, which HYROX never sets, so a session done through
 *    its slot record (matcher, GPS run, Mark as Done, quick done) read
 *    "planned" while its MTL already counted in the totals.
 *
 * Real generator, real page render (jsdom).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDefaultState, setState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { computeWeekActualMTL, hyroxMtlAcwr } from '@/calculations/mtl';
import { ROLLING_ACWR_MIN_OBSERVED_DAYS } from '@/calculations/fitness-model';
import { renderMtlLoadView } from './mtl-load-view';
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

/** The status line of each "This week" row, in day order. */
function rowStatuses(): string[] {
  return Array.from(document.querySelectorAll('#app-root div'))
    .filter(el => el.children.length === 0)
    .map(el => (el.textContent ?? '').trim())
    .filter(t => t === 'completed' || t === 'planned');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
});

describe('MTL detail page in week 2 of a HYROX plan', () => {
  it('shows the current week, marks a slot-record completion done, and agrees with Stats / readiness', () => {
    const s = hyroxState();
    s.w = 2;
    for (const w of s.wks[0].triWorkouts ?? []) complete(s.wks[0], w);
    const wk2 = s.wks[1];
    const rows = (wk2.triWorkouts ?? [])
      .filter(w => (w.musculoTendonLoad ?? 0) > 0)
      .sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0));
    complete(wk2, rows[0]);
    setState(s);

    renderMtlLoadView(() => {});
    const text = document.getElementById('app-root')!.textContent ?? '';

    // "This week" lists week 2: one row per MTL session, the first done.
    expect(rowStatuses()).toEqual(rows.map((_, i) => (i === 0 ? 'completed' : 'planned')));
    // Hero reads week 2's actual MTL, not next week's 0.
    expect(Math.round(computeWeekActualMTL(wk2))).toBeGreaterThan(0);
    expect(text).not.toContain('No station work completed this week yet.');
    // Chronic matches the value the Stats card and the readiness floor read.
    const load = hyroxMtlAcwr(s)!;
    expect(text).toContain(load.chronic.toFixed(1));
    // One completed plan week: the ratio is withheld, and the page says why.
    expect(load.reason).toBe('history');
    expect(text).toContain(`Ramp rate appears once ${ROLLING_ACWR_MIN_OBSERVED_DAYS} days of plan weeks are complete.`);
  });
});
