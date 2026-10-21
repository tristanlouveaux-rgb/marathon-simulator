// @vitest-environment jsdom
/**
 * HYROX Forecast reads the current week as wks[s.w - 1] (ISSUE-406 (a)).
 *
 * s.w is 1-based (store default w: 1). The Forecast sub-line printed
 * `Week ${s.w + 1} of N`, one week ahead of Home, Plan and Stats, and the
 * Training drill-down used s.w as the index: next week's phase, "Week 2 of N"
 * in week 1, one week too few to go, and next week counted as the current
 * week in "Sessions ahead".
 *
 * Real generator, real page render (jsdom).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDefaultState, setState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { renderHyroxForecastView } from './forecast-view';
import { renderHyroxChipDetail } from './forecast-chip-detail-view';
import { hyroxWeekLine, fmtSessionsPerWeek } from './forecast-labels';
import { plannedHyroxSessionsPerWeek } from '@/calculations/hyrox-volume';
import type { SimulatorState } from '@/types/state';

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
  } as SimulatorState['hyroxConfig'];
  s.wks = generateHyroxPlan(s);
  return s;
}

function sessionCount(s: SimulatorState, idx: number): number {
  return (s.wks[idx]?.triWorkouts ?? []).filter(w => w != null).length;
}

function pageText(): string {
  return document.getElementById('app-root')!.textContent ?? '';
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
});

describe('hyroxWeekLine', () => {
  it('prints the 1-based week, Plan complete past the end, nothing without a plan length', () => {
    expect(hyroxWeekLine(1, 16)).toBe('Week 1 of 16');
    expect(hyroxWeekLine(16, 16)).toBe('Week 16 of 16');
    expect(hyroxWeekLine(17, 16)).toBe('Plan complete');
    expect(hyroxWeekLine(3, 0)).toBe('');
    expect(hyroxWeekLine(undefined, 16)).toBe('');
    expect(hyroxWeekLine(0, 16)).toBe('');
  });
});

describe('HYROX Forecast in week 1 of 16', () => {
  it('the sub-line reads Week 1 of 16', () => {
    setState(hyroxState());
    renderHyroxForecastView();
    const text = pageText();
    expect(text).toContain('Week 1 of 16');
    expect(text).not.toContain('Week 2 of 16');
  });

  it('the Training page shows week 1, its phase, 15 weeks to go and every session ahead', () => {
    const s = hyroxState();
    // Give next week a different phase label so the page shows which week it read.
    s.wks[1].ph = s.wks[0].ph === 'build' ? 'base' : 'build';
    setState(s);

    renderHyroxChipDetail('training');

    const text = pageText();
    expect(text).toContain('Week 1 of 16');
    expect(text).toContain('15 weeks to go');
    const ph = String(s.wks[0].ph);
    expect(text).toMatch(new RegExp(`Phase\\s*${ph[0].toUpperCase()}${ph.slice(1)}`));
    // Nothing completed yet: sessions ahead = all of week 1 plus every later week.
    let ahead = 0;
    for (let i = 0; i < s.wks.length; i++) ahead += sessionCount(s, i);
    expect(text.match(/Sessions ahead\s*(\d+)/)?.[1]).toBe(String(ahead));
  });
});

describe('HYROX Forecast at the end of the plan', () => {
  it('race week reads Week 16 of 16', () => {
    const s = hyroxState();
    s.w = s.tw;
    setState(s);
    renderHyroxForecastView();
    expect(pageText()).toContain('Week 16 of 16');
    expect(pageText()).not.toContain('Week 17 of 16');
  });

  it('past the last week the sub-line and the Training page read Plan complete', () => {
    const s = hyroxState();
    s.w = s.tw + 1;
    setState(s);
    renderHyroxForecastView();
    expect(pageText()).toContain('Plan complete');
    expect(pageText()).not.toMatch(/Week 1[78] of 16/);

    document.body.innerHTML = '<div id="app-root"></div>';
    renderHyroxChipDetail('training');
    expect(pageText()).toContain('Plan complete');
  });
});

// ─── One sessions-per-week number (ISSUE-406 (f)) ────────────────────────────
// The Training chip counted every session of wks[s.w] (next week) while the
// Race order footer printed plannedHyroxSessionsPerWeek: "5/wk" beside
// "4.5 sessions/wk". Both print the footer's number now.
function trainingChipHeadline(): string {
  const chip = document.querySelector('[data-hx-chip="training"]');
  return (chip?.children[1]?.textContent ?? '').trim();
}

describe('Training chip and Race order footer', () => {
  it('print the same sessions-per-week number', () => {
    const s = hyroxState();
    s.hyroxConfig!.raceDate = '2027-01-17'; // a race date shows the footer
    // Make the current week differ from the next so a one-week count would show.
    s.wks[1].triWorkouts = (s.wks[1].triWorkouts ?? []).slice(1);
    setState(s);
    renderHyroxForecastView();

    const expected = fmtSessionsPerWeek(plannedHyroxSessionsPerWeek(s, 4));
    expect(trainingChipHeadline()).toBe(`${expected}/wk`);
    const footer = pageText().match(/(\d+(?:\.\d)?) sessions?\/wk for/);
    expect(footer?.[1]).toBe(expected);
  });

  it('race week reads the race week, not "0/wk" past the end of the plan', () => {
    const s = hyroxState();
    s.w = s.tw;
    setState(s);
    renderHyroxForecastView();
    expect(trainingChipHeadline()).not.toBe('0/wk');
    expect(trainingChipHeadline()).toBe(`${fmtSessionsPerWeek(plannedHyroxSessionsPerWeek(s, 4))}/wk`);
    expect(pageText()).not.toContain('Build a plan');
  });

  it('fmtSessionsPerWeek drops a trailing .0', () => {
    expect(fmtSessionsPerWeek(4.5)).toBe('4.5');
    expect(fmtSessionsPerWeek(5)).toBe('5');
    expect(fmtSessionsPerWeek(4.25)).toBe('4.3');
  });
});
