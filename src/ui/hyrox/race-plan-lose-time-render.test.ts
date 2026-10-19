// @vitest-environment jsdom
/**
 * Race plan and "where you lost time": what the screens render.
 *  - Visual constraints (UX_PATTERNS): no capitals-only labels, no heavy
 *    letter-spacing, no em dash, at most 2 non-neutral colours (these use none).
 *  - The race plan page: 16 legs in race order, the clock ends on the goal,
 *    the forecast column only beside a goal, the unrealistic line, the doubles
 *    caption, the Checkpoints toggle.
 *  - The Forecast tab: the race plan entry row and the lose-time card sit
 *    above "Where to gain"; the empty states are one line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { getDefaultState, setState } from '@/state/store';
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { buildHyroxRacePlan } from '@/calculations/hyrox-race-plan';
import { analyzeHyroxLoseTime } from '@/calculations/hyrox-lose-time';
import { hyroxPeerSplitsAt } from '@/calculations/hyrox-results';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { renderHyroxRacePlanView, renderRacePlanBody, buildRacePlanEntryCard, racePlanFeasibilityLine } from './race-plan-view';
import { renderHyroxLoseTimeView, renderLoseTimeBody, buildLoseTimeCard, fmtLostSigned } from './lose-time-view';
import { renderHyroxForecastView } from './forecast-view';
import type { SimulatorState } from '@/types/state';
import type { HyroxStation } from '@/types/triathlon';

function hyroxState(hx: Partial<NonNullable<SimulatorState['hyroxConfig']>>, top: Partial<SimulatorState> = {}): SimulatorState {
  const s = getDefaultState();
  s.eventType = 'hyrox' as SimulatorState['eventType'];
  s.w = 1;
  s.wks = [];
  s.biologicalSex = 'female';
  Object.assign(s, top);
  s.hyroxConfig = {
    format: 'open_singles', athleteBand: 'intermediate', hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0, mtlCap: 1000, mtlHistory: [], runsPerWeek: 3,
    stationSessionsPerWeek: 1, bricksPerWeek: 1, weeklyHoursAvailable: 8,
    ...hx,
  } as NonNullable<SimulatorState['hyroxConfig']>;
  return s;
}

/** A past result: the field's profile at 1:24:31 with Wall Balls +72 s and
 *  the Roxzone -72 s. */
function pastResult(): Partial<NonNullable<SimulatorState['hyroxConfig']>> {
  const p = hyroxPeerSplitsAt({ format: 'open_singles', sex: 'female' }, 5071)!;
  const stations = Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, Math.round(p.segments[st])])) as Record<HyroxStation, number>;
  stations.wall_balls += 72;
  const legs = p.runLegsSec.map(Math.round);
  const rox = 5071 - legs.reduce((a, b) => a + b, 0) - HYROX_STATION_ORDER.reduce((a, st) => a + stations[st], 0);
  return {
    previousHyroxTimeSec: 5071, hyroxPreviousTimeFormat: 'open_singles', hyroxPreviousRaceDate: '2026-03-14',
    hyroxPreviousStationSplits: stations, hyroxPreviousRunSplitsSec: legs, hyroxPreviousRoxzoneSec: rox,
  };
}

const NEUTRAL = new Set([
  'var(--c-black)', 'var(--c-muted)', 'var(--c-faint)', 'var(--c-border)', 'var(--c-border-strong)',
  'var(--c-bg)', 'var(--c-surface)', 'var(--c-text)',
  '#0f172a', '#64748b', '#94a3b8', '#fdfcf7', '#fff', '#ffffff',
]);
function nonNeutralColours(html: string): string[] {
  const found = html.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|var\(--c-[a-z-]+\)/g) ?? [];
  const out = new Set<string>();
  for (const c of found) {
    const k = c.toLowerCase().replace(/\s+/g, '');
    if (NEUTRAL.has(k)) continue;
    if (/^rgba?\((255,255,255|0,0,0)(,|\))/.test(k)) continue;
    out.add(k);
  }
  return [...out];
}
function expectVisualConstraints(html: string): void {
  expect(html).not.toMatch(/text-transform\s*:\s*uppercase/i);
  const ls = [...html.matchAll(/letter-spacing\s*:\s*(-?\d*\.?\d+)em/gi)].map(m => parseFloat(m[1]));
  for (const v of ls) expect(v).toBeLessThan(0.05);
  expect(html).not.toContain('\u2014');
  expect(nonNeutralColours(html).length).toBeLessThanOrEqual(2);
}

const app = () => document.getElementById('app-root')!;

beforeEach(() => {
  document.body.innerHTML = '<div id="app-root"></div>';
});

describe('race plan page', () => {
  it('a goal: 16 legs in race order, the clock ends on the goal, the forecast muted beside it', () => {
    const base = hyroxState({}, {});
    const fc = predictHyroxRace(base)!.totalSec;
    const s = hyroxState({ targetFinishTimeSec: fc - 300 });
    setState(s);
    renderHyroxRacePlanView();
    const legs = [...app().querySelectorAll('[data-rp-leg]')].map(el => el.getAttribute('data-rp-leg'));
    expect(legs).toEqual(['run-1', 'ski_erg', 'run-2', 'sled_push', 'run-3', 'sled_pull', 'run-4', 'burpee_broad_jumps',
      'run-5', 'row_erg', 'run-6', 'farmer_carry', 'run-7', 'sandbag_lunges', 'run-8', 'wall_balls', 'roxzone']);
    const wallBalls = app().querySelector('[data-rp-leg="wall_balls"]')!.textContent!;
    const goal = (fc - 300);
    const h = Math.floor(goal / 3600), m = Math.floor((goal % 3600) / 60), sec = goal % 60;
    const goalTxt = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    expect(wallBalls).toContain(goalTxt);
    expect(app().textContent).toContain(`Splits for your ${goalTxt} goal`);
    expect(app().textContent).toContain('Forecast');
    expect(app().textContent).toContain('Change goal');
  });

  it('the Checkpoints toggle shows the clock after each run and the finish', () => {
    setState(hyroxState({ targetFinishTimeSec: 5000 }));
    renderHyroxRacePlanView();
    const cp = document.getElementById('rp-checkpoints')!;
    expect(cp.style.display).toBe('none');
    (app().querySelector('[data-rp-mode="checkpoints"]') as HTMLButtonElement).click();
    expect(cp.style.display).toBe('');
    expect(document.getElementById('rp-splits')!.style.display).toBe('none');
    expect([...cp.querySelectorAll('[data-rp-checkpoint]')].map(el => el.getAttribute('data-rp-checkpoint')))
      .toEqual(['Run 1', 'Run 2', 'Run 3', 'Run 4', 'Run 5', 'Run 6', 'Run 7', 'Run 8', 'Finish']);
  });

  it('no goal: the forecast is the target, no forecast column, "Set a goal"', () => {
    const s = hyroxState({});
    const plan = buildHyroxRacePlan(s, predictHyroxRace(s)!);
    const html = renderRacePlanBody(plan);
    expect(html).not.toContain('>Forecast<');
    expect(html).toContain('>Split<');
    expect(html).toContain('Set a goal');
  });

  it('an unrealistic goal: one plain line', () => {
    const s = hyroxState({ targetFinishTimeSec: 3000 });
    const plan = buildHyroxRacePlan(s, predictHyroxRace(s)!);
    const line = racePlanFeasibilityLine(plan);
    expect(line).toMatch(/^This goal is about \d+ min out of reach\. With every leg at the top-1% median of your field, the splits reach \d:\d\d:\d\d\.$/);
    expect(renderRacePlanBody(plan)).toContain(line);
  });

  it('doubles: the pair caption', () => {
    const s = hyroxState({ format: 'open_doubles', division: 'mixed', targetFinishTimeSec: 4600 });
    const plan = buildHyroxRacePlan(s, predictHyroxRace(s)!);
    expect(renderRacePlanBody(plan)).toContain('Partners run every leg together; station splits are the pair\'s time.');
  });

  it('meets the visual constraints (goal, no goal, unrealistic, doubles)', () => {
    for (const hx of [{ targetFinishTimeSec: 5000 }, {}, { targetFinishTimeSec: 3000 }, { format: 'pro_doubles' as const, division: 'women' as const, targetFinishTimeSec: 4400 }]) {
      const s = hyroxState(hx);
      expectVisualConstraints(renderRacePlanBody(buildHyroxRacePlan(s, predictHyroxRace(s)!)));
    }
    expectVisualConstraints(buildRacePlanEntryCard(hyroxState({})));
  });
});

describe('where you lost time', () => {
  it('the card: headline, the top 3 losses, both links', () => {
    const s = hyroxState(pastResult());
    const html = buildLoseTimeCard(s, true);
    expect(html).toContain('Most time lost on Wall Balls: 1:12 slower than athletes finishing in 1:24.');
    document.body.innerHTML = html;
    const rows = [...document.querySelectorAll('[data-lt-seg]')];
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows[0].getAttribute('data-lt-seg')).toBe('wall_balls');
    expect(rows[0].textContent).toContain('+1:12');
    expect(document.getElementById('hx-lose-time-all')).not.toBeNull();
    expect(document.getElementById('hx-lose-time-gain')).not.toBeNull();
    expectVisualConstraints(html);
  });

  it('without "Where to gain" on the page the link is left out', () => {
    expect(buildLoseTimeCard(hyroxState(pastResult()), false)).not.toContain('hx-lose-time-gain');
  });

  it('no past result: one line inviting a paste', () => {
    const html = buildLoseTimeCard(hyroxState({}), true);
    expect(html).toContain('Paste a past result to compare each segment with athletes who finished in the same time.');
    expect(html).toContain('data-lt-status="no_result"');
    expectVisualConstraints(html);
  });

  it('a finish without splits: one line asking for them', () => {
    const html = buildLoseTimeCard(hyroxState({ previousHyroxTimeSec: 5071, hyroxPreviousTimeFormat: 'open_singles' }), true);
    expect(html).toContain('Add the splits from your 1:24:31 to compare each segment');
    expectVisualConstraints(html);
  });

  it('the drill-down: time lost, time gained, level, provenance', () => {
    const s = hyroxState(pastResult());
    setState(s);
    renderHyroxLoseTimeView();
    const txt = app().textContent!;
    expect(txt).toContain('Your 1:24:31 against athletes who finished in 1:24');
    expect(txt).toContain('Time lost');
    expect(txt).toContain('Time gained');
    expect(txt).toContain('Open Singles women finishers');
    const lt = analyzeHyroxLoseTime(s);
    // Every compared segment shows once: a row, or the level line.
    const rows = app().querySelectorAll('[data-lt-seg]').length;
    const level = app().querySelector('[data-lt-level]')?.textContent ?? '';
    const levelCount = level ? level.replace('Level with your peers: ', '').replace(/\.$/, '').split(', ').length : 0;
    expect(rows + levelCount).toBe(lt.segments.length);
    expectVisualConstraints(renderLoseTimeBody(lt, true));
  });

  it('signs: plus for time lost, the minus sign for time gained', () => {
    expect(fmtLostSigned(72)).toBe('+1:12');
    expect(fmtLostSigned(-20.4)).toBe('\u22120:20');
  });
});

describe('Forecast tab placement', () => {
  it('the race plan row and the lose-time card render; lose-time sits right above "Where to gain"', () => {
    const raceDate = new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10);
    setState(hyroxState({ ...pastResult(), raceDate, targetFinishTimeSec: 5000 }));
    renderHyroxForecastView();
    const entry = document.getElementById('hx-race-plan-entry');
    const lose = document.getElementById('hx-lose-time');
    expect(entry).not.toBeNull();
    expect(lose).not.toBeNull();
    // The entry row carries no numbers (the goal shows in the hero).
    expect(entry!.textContent).not.toMatch(/\d/);
    const gain = document.getElementById('hx-where-to-gain');
    expect(gain).not.toBeNull();
    expect(lose!.nextElementSibling).toBe(gain);
  });
});
