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
import { topWeakestLinks } from '@/calculations/hyrox-weakest-link';
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

  it('an unrealistic goal: one plain line, the splits at the forecast, no goal column', () => {
    const s = hyroxState({ targetFinishTimeSec: 3600 });
    const plan = buildHyroxRacePlan(s, predictHyroxRace(s)!);
    const line = racePlanFeasibilityLine(plan);
    expect(line).toBe('1:00:00 is out of reach even with every leg at the typical split of the top 1% of Open Singles women. Splits below are at your forecast.');
    expect(line).not.toMatch(/\d+ min/);
    const html = renderRacePlanBody(plan);
    expect(html).toContain(line);
    expect(html).not.toContain('>Goal<');
    expect(html).toContain('Change goal');
  });

  it('the subhead names the time the Wall Balls clock reaches (goal, no goal, unrealistic)', () => {
    for (const hx of [{ targetFinishTimeSec: 5300 }, {}, { targetFinishTimeSec: 3600 }]) {
      setState(hyroxState(hx));
      renderHyroxRacePlanView();
      const sub = app().querySelector('[data-rp-subhead]')!.textContent!;
      const clock = app().querySelector('[data-rp-leg="wall_balls"] [data-rp-clock]')!.textContent!.trim();
      expect(sub.startsWith(`Splits for your ${clock} `)).toBe(true);
    }
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
  it('the card: the headline alone when nothing else is material, and one link', () => {
    const s = hyroxState(pastResult());
    const html = buildLoseTimeCard(s);
    expect(html).toContain('Most time lost on Wall Balls: 1:12 slower than athletes finishing in 1:24:31.');
    document.body.innerHTML = html;
    // The headline's segment is not repeated as a row; nothing else is material.
    expect(document.querySelectorAll('[data-lt-seg]').length).toBe(0);
    expect(document.getElementById('hx-lose-time-all')).not.toBeNull();
    expect(document.getElementById('hx-lose-time-gain')).toBeNull();
    expectVisualConstraints(html);
  });

  it('the card: other material losses under the headline, never the headline\'s own segment', () => {
    const r = pastResult();
    const st = { ...r.hyroxPreviousStationSplits! } as Record<HyroxStation, number>;
    st.sled_pull += 40;
    st.ski_erg += 20;
    const s = hyroxState({ ...r, hyroxPreviousStationSplits: st, hyroxPreviousRoxzoneSec: r.hyroxPreviousRoxzoneSec! - 60 });
    document.body.innerHTML = buildLoseTimeCard(s);
    const rows = [...document.querySelectorAll('[data-lt-seg]')].map(el => el.getAttribute('data-lt-seg'));
    expect(rows).toEqual(['sled_pull', 'ski_erg']);
  });

  it('no past result: one line inviting a paste', () => {
    const html = buildLoseTimeCard(hyroxState({}));
    expect(html).toContain('Paste a past result to compare each segment with athletes who finished in the same time.');
    expect(html).toContain('data-lt-status="no_result"');
    expectVisualConstraints(html);
  });

  it('a first-timer with no result gets no card', () => {
    expect(buildLoseTimeCard(hyroxState({ athleteBand: 'total_beginner' }))).toBe('');
    // A past result still shows, whatever the band.
    expect(buildLoseTimeCard(hyroxState({ ...pastResult(), athleteBand: 'total_beginner' }))).toContain('Most time lost on');
  });

  it('a finish without splits: one line asking for them', () => {
    const html = buildLoseTimeCard(hyroxState({ previousHyroxTimeSec: 5071, hyroxPreviousTimeFormat: 'open_singles' }));
    expect(html).toContain('Add the splits from your 1:24:31 to compare each segment');
    expectVisualConstraints(html);
  });

  it('the drill-down: time lost, time gained, level, provenance', () => {
    const s = hyroxState(pastResult());
    setState(s);
    renderHyroxLoseTimeView();
    const txt = app().textContent!;
    expect(txt).toContain('Your 1:24:31 against athletes who finished in the same time');
    expect(txt).toContain('Time lost');
    expect(txt).toContain('Time gained');
    expect(txt).toContain('Median splits of Open Singles women who finished near your time.');
    expect(txt).toContain('Open Singles women finishers');
    const lt = analyzeHyroxLoseTime(s);
    // Every compared segment shows once: a row, or the level line.
    const rows = app().querySelectorAll('[data-lt-seg]').length;
    const level = app().querySelector('[data-lt-level]')?.textContent ?? '';
    const levelCount = level ? level.replace('Level with your peers: ', '').replace(/\.$/, '').split(', ').length : 0;
    expect(rows + levelCount).toBe(lt.segments.length);
    expect(lt.segments.length).toBe(10);
    expectVisualConstraints(renderLoseTimeBody(lt, true));
  });

  it('the drill-down: Running is one row; its caption names the leg that lost the most', () => {
    const r = pastResult();
    const legs = r.hyroxPreviousRunSplitsSec!.map((v, i) => (v as number) + (i === 0 ? 30 : 20));
    const s = hyroxState({ ...r, hyroxPreviousRunSplitsSec: legs, hyroxPreviousRoxzoneSec: r.hyroxPreviousRoxzoneSec! - 170 });
    const lt = analyzeHyroxLoseTime(s);
    expect(lt.headline).toBe('Most time lost on Running: 2:50 slower than athletes finishing in 1:24:31');
    document.body.innerHTML = renderLoseTimeBody(lt, true);
    const run = document.querySelectorAll('[data-lt-seg="run_total"]');
    expect(run.length).toBe(1);
    expect(run[0].textContent).toContain('Most on Run 1, +0:30');
    expect(document.body.textContent).not.toMatch(/\bRun [2-8]\b/);
  });

  it('a doubles result logged without its division says it is compared in the current one', () => {
    const s = hyroxState({
      format: 'open_doubles', division: 'mixed',
      previousHyroxTimeSec: 4800, hyroxPreviousTimeFormat: 'open_doubles',
      hyroxPreviousStationSplits: { sled_push: 200, wall_balls: 300 },
    });
    expect(renderLoseTimeBody(analyzeHyroxLoseTime(s), false)).toContain('Compared in your current division.');
    const rec = hyroxState({
      format: 'open_doubles', division: 'mixed', hyroxPreviousTimeDivision: 'mixed',
      previousHyroxTimeSec: 4800, hyroxPreviousTimeFormat: 'open_doubles',
      hyroxPreviousStationSplits: { sled_push: 200, wall_balls: 300 },
    });
    expect(renderLoseTimeBody(analyzeHyroxLoseTime(rec), false)).not.toContain('Compared in your current division.');
  });

  it('signs: plus for time lost, the minus sign for time gained', () => {
    expect(fmtLostSigned(72)).toBe('+1:12');
    expect(fmtLostSigned(-20.4)).toBe('\u22120:20');
  });
});

describe('Forecast tab placement', () => {
  const raceDate = () => new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10);

  it('the two cards name the same station: Where to gain adds the station the last race lost the most on', () => {
    setState(hyroxState({ ...pastResult(), raceDate: raceDate() }));
    renderHyroxForecastView();
    expect(document.querySelector('[data-lt-headline]')!.textContent).toContain('Wall Balls');
    const gain = document.getElementById('hx-where-to-gain')!;
    const wb = gain.querySelector('[data-wtg-station="wall_balls"]');
    expect(wb).not.toBeNull();
    const top2 = topWeakestLinks(predictHyroxRace(hyroxState({ ...pastResult(), raceDate: raceDate() })), 2).map(r => r.station);
    if (!top2.includes('wall_balls')) {
      expect(wb!.textContent).toContain('Most time lost in your last race');
      expect(gain.textContent).toContain('plus Wall Balls, where your last race lost the most');
      expect(gain.querySelectorAll('[data-wtg-station]').length).toBe(3);
    }
    expectVisualConstraints(gain.outerHTML);
  });

  it('Where to gain without a past result: the top 2 only', () => {
    setState(hyroxState({ raceDate: raceDate() }));
    renderHyroxForecastView();
    const gain = document.getElementById('hx-where-to-gain')!;
    expect(gain.querySelectorAll('[data-wtg-station]').length).toBeLessThanOrEqual(2);
    expect(gain.textContent).not.toContain('last race');
  });

  it('singles: the race plan is a link in the Race order card; lose-time sits right above "Where to gain"', () => {
    setState(hyroxState({ ...pastResult(), raceDate: raceDate(), targetFinishTimeSec: 5000 }));
    renderHyroxForecastView();
    expect(document.getElementById('hx-race-plan-entry')).toBeNull();
    const link = document.getElementById('hx-race-plan-link')!;
    expect(link.textContent).toBe('Race plan for your goal ›');
    const lose = document.getElementById('hx-lose-time');
    expect(lose).not.toBeNull();
    const gain = document.getElementById('hx-where-to-gain');
    expect(gain).not.toBeNull();
    expect(lose!.nextElementSibling).toBe(gain);
  });

  it('singles without a goal: the link leads with setting one', () => {
    setState(hyroxState({ raceDate: raceDate() }));
    renderHyroxForecastView();
    expect(document.getElementById('hx-race-plan-link')!.textContent).toBe('Set a goal for a race plan ›');
  });

  it('doubles (no Race order card): the entry row, with no numbers', () => {
    setState(hyroxState({ format: 'open_doubles', division: 'mixed', raceDate: raceDate(), targetFinishTimeSec: 4600 }));
    renderHyroxForecastView();
    const entry = document.getElementById('hx-race-plan-entry');
    expect(entry).not.toBeNull();
    expect(entry!.textContent).not.toMatch(/\d/);
  });

  it('one forecast clock: the Race order card\'s clock after every leg is the race plan\'s', () => {
    for (const hx of [{}, { venueId: 'mexico-city-exh' }]) {
      const s = hyroxState({ ...hx, raceDate: raceDate() });
      setState(s);
      renderHyroxForecastView();
      const plan = buildHyroxRacePlan(s, predictHyroxRace(s)!);
      const fmtClock = (sec: number) => {
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
      };
      for (const leg of plan.legs) {
        const key = leg.kind === 'run' ? `run-${leg.legNumber}` : leg.station!;
        const cell = document.querySelector(`#hx-rows-race [data-hx-race-clock="${key}"]`)!;
        expect(cell.textContent).toBe(fmtClock(leg.clockSec));
      }
    }
  });
});
