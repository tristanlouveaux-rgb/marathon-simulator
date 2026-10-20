// @vitest-environment jsdom
/**
 * Race plan and "where you lost time": what the screens render.
 *  - Visual constraints (UX_PATTERNS): no capitals-only labels, no heavy
 *    letter-spacing, no em dash, at most 2 non-neutral colours (these use none).
 *  - The race plan page: 16 legs in race order, the clock ends on the goal,
 *    the forecast column only beside a goal (never beside a goal at the
 *    forecast), the unrealistic line, the doubles caption, no checkpoints
 *    toggle (the Clock column is the clock after every run).
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
import { buildHyroxProjection } from '@/calculations/race-projection.hyrox';
import { renderHyroxRacePlanView, renderRacePlanBody, buildRacePlanEntryCard, racePlanFeasibilityLine } from './race-plan-view';
import { renderHyroxLoseTimeView, renderLoseTimeBody, buildLoseTimeCard, fmtLostSigned } from './lose-time-view';
import { renderHyroxForecastView } from './forecast-view';
import { openHyroxGoalModal } from './goal-modal';
import { ftRounded } from '@/utils/format';
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

  it('one splits card, no Splits / Checkpoints toggle: the Clock column is the clock after every run', () => {
    setState(hyroxState({ targetFinishTimeSec: 5000 }));
    renderHyroxRacePlanView();
    expect(document.getElementById('rp-splits')).not.toBeNull();
    expect(document.getElementById('rp-checkpoints')).toBeNull();
    expect(app().querySelector('[data-rp-mode]')).toBeNull();
    expect(app().textContent).not.toContain('Checkpoints');
  });

  it('a goal at the forecast is the forecast\'s plan: Split / Clock only, the time named once', () => {
    const fc = predictHyroxRace(hyroxState({}))!.totalSec;
    const s = hyroxState({ targetFinishTimeSec: fc });
    setState(s);
    renderHyroxRacePlanView();
    const head = document.getElementById('rp-splits')!.firstElementChild!.textContent!.replace(/\s+/g, ' ').trim();
    expect(head).toBe('Split Clock');
    expect(document.getElementById('rp-splits')!.textContent).not.toContain('Forecast');
    expect(app().querySelector('[data-rp-subhead]')!.textContent).toBe(`Splits for your ${ftRounded(fc)} goal. Matches your forecast.`);
    expect(app().querySelector('#rp-feasibility')).toBeNull();
    expect(app().textContent).toContain('Change goal');
    const plan = buildHyroxRacePlan(s, predictHyroxRace(s)!);
    expect(plan.basis).toBe('forecast');
    plan.legs.forEach(l => expect(l.splitSec).toBe(l.forecastSec));
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
    expect(line).toBe('1:00:00 is out of reach even with every leg at top-1% level for Open Singles women. Splits below are at your forecast.');
    expect(line).not.toMatch(/\d+ min/);
    const html = renderRacePlanBody(plan);
    expect(html).toContain(line);
    expect(html).not.toContain('>Goal<');
    expect(html).toContain('Change goal');
  });

  it('the subhead names the time the Wall Balls clock reaches (goal, no goal, unrealistic)', () => {
    const fc = predictHyroxRace(hyroxState({}))!.totalSec;
    for (const hx of [{ targetFinishTimeSec: 5300 }, {}, { targetFinishTimeSec: 3600 }, { targetFinishTimeSec: fc }]) {
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

describe('goal modal', () => {
  it('no goal yet: "Set a goal", the forecast offered, the line says so, no echo, no Clear goal', () => {
    const s = hyroxState({});
    setState(s);
    const p = predictHyroxRace(s)!;
    openHyroxGoalModal(p);
    const modal = document.getElementById('hx-goal-modal')!;
    expect(modal.textContent).toContain('Set a goal');
    expect((document.getElementById('hx-goal-input') as HTMLInputElement).value).toBe(ftRounded(p.totalSec));
    expect(document.querySelector('[data-goal-feasibility]')!.textContent!.trim()).toBe('Matches your forecast.');
    expect(document.getElementById('hx-goal-echo')!.textContent).toBe('');
    expect(document.getElementById('hx-goal-clear')).toBeNull();
    expect(document.getElementById('hx-goal-save')!.textContent).toBe('Keep forecast');
  });

  it('singles, no goal: the button reads "Keep forecast" at the forecast and "Save goal" once the input differs; keeping saves nothing and the hero keeps "Set a goal"', () => {
    const s = hyroxState({ raceDate: new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10) });
    setState(s);
    renderHyroxForecastView();
    const cta = () => document.getElementById('hx-set-target-cta') as HTMLButtonElement;
    expect(cta().textContent!.trim()).toBe('Set a goal ›');
    cta().click();
    return vi.waitFor(() => expect(document.getElementById('hx-goal-save')).not.toBeNull()).then(() => {
      const save = () => document.getElementById('hx-goal-save') as HTMLButtonElement;
      const input = document.getElementById('hx-goal-input') as HTMLInputElement;
      const offered = input.value;
      expect(save().textContent).toBe('Keep forecast');
      input.value = '1:20:00';
      input.dispatchEvent(new Event('input'));
      expect(save().textContent).toBe('Save goal');
      input.value = 'abc';
      input.dispatchEvent(new Event('input'));
      expect(save().textContent).toBe('Save goal');
      input.value = offered;
      input.dispatchEvent(new Event('input'));
      expect(save().textContent).toBe('Keep forecast');
      save().click();
      expect(s.hyroxConfig!.targetFinishTimeSec).toBeUndefined();
      expect(document.getElementById('hx-goal-modal')).toBeNull();
      // Still the Forecast tab (its Race order card is the forecast's plan),
      // not a race plan page repeating it.
      expect(app().querySelector('[data-rp-subhead]')).toBeNull();
      expect(cta().textContent!.trim()).toBe('Set a goal ›');
      expect(cta().getAttribute('data-has-goal')).not.toBe('1');
    });
  });

  it('singles, no goal: a changed input saves the goal and opens the race plan on it', () => {
    const s = hyroxState({ raceDate: new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10) });
    setState(s);
    renderHyroxForecastView();
    (document.getElementById('hx-set-target-cta') as HTMLButtonElement).click();
    return vi.waitFor(() => expect(document.getElementById('hx-goal-save')).not.toBeNull()).then(() => {
      const input = document.getElementById('hx-goal-input') as HTMLInputElement;
      input.value = '1:20:00';
      input.dispatchEvent(new Event('input'));
      (document.getElementById('hx-goal-save') as HTMLButtonElement).click();
      expect(s.hyroxConfig!.targetFinishTimeSec).toBe(4800);
      return vi.waitFor(() => expect(app().querySelector('[data-rp-subhead]')!.textContent).toContain('Splits for your 1:20:00 goal.'));
    });
  });

  it('doubles, no goal, from the Forecast tab: "Open race plan" opens the race plan at the forecast and sets no goal; Back keeps "Set a goal"', () => {
    const s = hyroxState({ format: 'open_doubles', division: 'mixed', raceDate: new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10) });
    setState(s);
    renderHyroxForecastView();
    (document.getElementById('hx-set-target-cta') as HTMLButtonElement).click();
    return vi.waitFor(() => expect(document.getElementById('hx-goal-save')).not.toBeNull()).then(() => {
      const save = document.getElementById('hx-goal-save') as HTMLButtonElement;
      expect(save.textContent).toBe('Open race plan');
      save.click();
      expect(s.hyroxConfig!.targetFinishTimeSec).toBeUndefined();
      const sub = app().querySelector('[data-rp-subhead]')!.textContent!;
      expect(sub).toBe(`Splits for your ${ftRounded(predictHyroxRace(s)!.totalSec)} forecast.`);
      expect(document.getElementById('rp-splits')!.textContent).not.toContain('Forecast');
      // On the race plan itself the same state keeps the page: "Keep forecast".
      (document.getElementById('rp-goal-link') as HTMLButtonElement).click();
      return vi.waitFor(() => expect(document.getElementById('hx-goal-save')).not.toBeNull()).then(() => {
        expect(document.getElementById('hx-goal-save')!.textContent).toBe('Keep forecast');
        (document.getElementById('hx-goal-save') as HTMLButtonElement).click();
        expect(app().querySelector('[data-rp-subhead]')).not.toBeNull();
        (document.getElementById('rp-back-btn') as HTMLButtonElement).click();
        return vi.waitFor(() => expect(document.getElementById('hx-set-target-cta')).not.toBeNull()).then(() => {
          expect(document.getElementById('hx-set-target-cta')!.textContent!.trim()).toBe('Set a goal ›');
        });
      });
    });
  });

  it('a goal on file: the button always reads "Save goal", even at the forecast', () => {
    const s = hyroxState({ targetFinishTimeSec: 5000 });
    setState(s);
    const p = predictHyroxRace(s)!;
    openHyroxGoalModal(p);
    const input = document.getElementById('hx-goal-input') as HTMLInputElement;
    expect(document.getElementById('hx-goal-save')!.textContent).toBe('Save goal');
    input.value = ftRounded(p.totalSec);
    input.dispatchEvent(new Event('input'));
    expect(document.getElementById('hx-goal-save')!.textContent).toBe('Save goal');
  });

  it('a goal on file: "Change goal" with Clear goal; the echo only when the input reads differently', () => {
    const s = hyroxState({ targetFinishTimeSec: 5000 });
    setState(s);
    openHyroxGoalModal(predictHyroxRace(s)!);
    expect(document.getElementById('hx-goal-modal')!.textContent).toContain('Change goal');
    expect(document.getElementById('hx-goal-modal')!.textContent).not.toContain('Set a goal');
    expect(document.getElementById('hx-goal-clear')).not.toBeNull();
    const input = document.getElementById('hx-goal-input') as HTMLInputElement;
    const echo = document.getElementById('hx-goal-echo')!;
    expect(input.value).toBe('1:23:20');
    expect(echo.textContent).toBe('');
    input.value = '1:00';
    input.dispatchEvent(new Event('input'));
    expect(echo.textContent).toBe('Goal: 1:00:00');
    input.value = '80:00';
    input.dispatchEvent(new Event('input'));
    expect(echo.textContent).toBe('Goal: 1:20:00');
    input.value = '1:20:00';
    input.dispatchEvent(new Event('input'));
    expect(echo.textContent).toBe('');
  });

  it('an unrealistic goal reads the race plan\'s one sentence', () => {
    const s = hyroxState({});
    setState(s);
    const p = predictHyroxRace(s)!;
    openHyroxGoalModal(p);
    const input = document.getElementById('hx-goal-input') as HTMLInputElement;
    input.value = '1:00:00';
    input.dispatchEvent(new Event('input'));
    const line = document.querySelector('[data-goal-feasibility]')!.textContent!.trim();
    expect(line).toBe('1:00:00 is out of reach even with every leg at top-1% level for Open Singles women.');
    const plan = buildHyroxRacePlan(hyroxState({ targetFinishTimeSec: 3600 }), p);
    expect(racePlanFeasibilityLine(plan).startsWith(line)).toBe(true);
    expectVisualConstraints(document.getElementById('hx-goal-modal')!.outerHTML.replace(/rgba\(0,0,0,0\.5\)/, ''));
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
    expect(html).toContain('Raced HYROX before? Paste a result to compare each segment with athletes who finished in the same time.');
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
    expect(html).toContain('Add the splits from your 1:24:31 to compare each segment with athletes who finished in the same time.');
    expectVisualConstraints(html);
  });

  it('a doubles finish without splits says pairs, on the card and the drill-down', () => {
    const s = hyroxState({ format: 'open_doubles', division: 'mixed', previousHyroxTimeSec: 4320, hyroxPreviousTimeFormat: 'open_doubles', hyroxPreviousTimeDivision: 'mixed' });
    expect(buildLoseTimeCard(s)).toContain('Add the splits from your 1:12:00 to compare each segment with pairs who finished in the same time.');
    setState(s);
    renderHyroxLoseTimeView();
    expect(app().textContent).toContain('Against pairs who finished in the same time');
    expect(app().textContent).not.toContain('athletes');
  });

  it('the drill-down: time lost, time gained, level, provenance', () => {
    const s = hyroxState(pastResult());
    setState(s);
    renderHyroxLoseTimeView();
    const txt = app().textContent!;
    expect(txt).toContain('Your 1:24:31 against athletes who finished in the same time');
    expect(txt).toContain('Time lost');
    expect(txt).toContain('Time gained');
    expect(txt).toContain('Typical splits of Open Singles women who finished in the same time.');
    expect(txt).not.toContain('near your time');
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

  it('the drill-down: Running is one row; its caption names no leg (the race plan\'s legs are near-even)', () => {
    const r = pastResult();
    const legs = r.hyroxPreviousRunSplitsSec!.map((v, i) => (v as number) + (i === 0 ? 30 : 20));
    const s = hyroxState({ ...r, hyroxPreviousRunSplitsSec: legs, hyroxPreviousRoxzoneSec: r.hyroxPreviousRoxzoneSec! - 170 });
    const lt = analyzeHyroxLoseTime(s);
    expect(lt.headline).toBe('Most time lost on Running: 2:51 slower than athletes finishing in 1:24:31');
    document.body.innerHTML = renderLoseTimeBody(lt, true);
    const run = document.querySelectorAll('[data-lt-seg="run_total"]');
    expect(run.length).toBe(1);
    expect(run[0].textContent).not.toContain('Most on');
    expect(document.body.textContent).not.toMatch(/\bRun [2-8]\b/);
  });

  it('a doubles result logged without its division names the field used and where to set the division', () => {
    // A singles man now: the field is men's pairs (his sex), named in the line.
    const s = hyroxState({
      format: 'open_singles',
      previousHyroxTimeSec: 4800, hyroxPreviousTimeFormat: 'open_doubles',
      hyroxPreviousStationSplits: { sled_push: 200, wall_balls: 300 },
    }, { biologicalSex: 'male' });
    const html = renderLoseTimeBody(analyzeHyroxLoseTime(s), false);
    expect(html).toContain('Typical splits of Open Doubles men\'s pairs who finished in the same time.');
    expect(html).toContain('Division not recorded with this result; set it with Update result.');
    expect(html).not.toContain('current division');
    const rec = hyroxState({
      format: 'open_doubles', division: 'mixed', hyroxPreviousTimeDivision: 'mixed',
      previousHyroxTimeSec: 4800, hyroxPreviousTimeFormat: 'open_doubles',
      hyroxPreviousStationSplits: { sled_push: 200, wall_balls: 300 },
    });
    expect(renderLoseTimeBody(analyzeHyroxLoseTime(rec), false)).not.toContain('Division not recorded');
  });

  it('level segments are listed in race order', () => {
    const lt = analyzeHyroxLoseTime(hyroxState(pastResult()));
    const order = ['Running', 'SkiErg', 'Sled Push', 'Sled Pull', 'Burpee Broad Jumps', 'Row Erg', 'Farmer Carry', 'Sandbag Lunges', 'Wall Balls', 'Roxzone'];
    const idx = lt.level.map(seg => order.indexOf(seg.label));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it('the paste invitations and "Update result" open the modal on the race splits, first and expanded', async () => {
    const raceDate = new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10);
    const opened = async (click: () => void) => {
      click();
      await vi.waitFor(() => expect(document.getElementById('lpt-splits-body')).not.toBeNull());
      const body = document.getElementById('lpt-splits-body')!;
      expect(body.style.display).toBe('block');
      // The splits (paste box first) sit above the finish time.
      const paste = document.getElementById('lpt-paste-clip-btn')!;
      const time = document.getElementById('lpt-time')!;
      expect(paste.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const toggle = document.getElementById('lpt-splits-toggle')!.textContent!;
      expect(toggle).toContain('Race splits');
      expect(toggle).not.toContain('optional');
      expect(toggle).not.toContain('Station split times');
      (document.querySelector('#lpt-cancel') as HTMLButtonElement).click();
      expect(document.getElementById('lpt-splits-body')).toBeNull();
    };
    // Forecast tab, no result: "Raced HYROX before?".
    setState(hyroxState({ raceDate }, { biologicalSex: 'male' }));
    renderHyroxForecastView();
    await opened(() => (document.getElementById('hx-lose-time-paste') as HTMLButtonElement).click());
    // Forecast tab, a finish without splits: "Add the splits".
    setState(hyroxState({ raceDate, previousHyroxTimeSec: 5071, hyroxPreviousTimeFormat: 'open_singles' }));
    renderHyroxForecastView();
    await opened(() => (document.getElementById('hx-lose-time-paste') as HTMLButtonElement).click());
    // The drill-down: "Update result".
    setState(hyroxState(pastResult()));
    renderHyroxLoseTimeView();
    await opened(() => (document.getElementById('lt-update') as HTMLButtonElement).click());
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

  // A Pro Singles man's 1:18:20 (strong stations, slower runs) and a Mixed
  // Doubles pair's 1:12:00: Running is the biggest loss for both.
  const PRO_MAN = {
    previousHyroxTimeSec: 4700, hyroxPreviousTimeFormat: 'pro_singles' as const, hyroxPreviousRaceDate: '2026-03-14',
    hyroxPreviousStationSplits: { ski_erg: 255, sled_push: 185, sled_pull: 260, burpee_broad_jumps: 230, row_erg: 280, farmer_carry: 100, sandbag_lunges: 220, wall_balls: 300 },
    hyroxPreviousRunSplitsSec: [265, 278, 292, 295, 300, 296, 298, 326], hyroxPreviousRoxzoneSec: 520,
  };
  const MIXED_PAIR = {
    format: 'open_doubles' as const, division: 'mixed' as const,
    previousHyroxTimeSec: 4320, hyroxPreviousTimeFormat: 'open_doubles' as const, hyroxPreviousTimeDivision: 'mixed' as const, hyroxPreviousRaceDate: '2026-03-14',
    hyroxPreviousStationSplits: { ski_erg: 240, sled_push: 110, sled_pull: 190, burpee_broad_jumps: 180, row_erg: 260, farmer_carry: 95, sandbag_lunges: 190, wall_balls: 200 },
    hyroxPreviousRunSplitsSec: [300, 310, 322, 325, 330, 328, 327, 345], hyroxPreviousRoxzoneSec: 268,
  };

  it('a Running loss: Where to gain adds Running at the Race order card\'s own average pace, current to race day', () => {
    const s = hyroxState({ ...PRO_MAN, raceDate: raceDate() }, { biologicalSex: 'male' });
    setState(s);
    renderHyroxForecastView();
    expect(document.querySelector('[data-lt-headline]')!.textContent).toContain('Most time lost on Running');
    const gain = document.getElementById('hx-where-to-gain')!;
    const run = gain.querySelector('[data-wtg-segment="run_total"]')!;
    expect(run).not.toBeNull();
    expect(run.textContent).toContain('Running');
    expect(run.textContent).toContain('Most time lost in your last race');
    expect(gain.textContent).toContain('plus Running, where your last race lost the most');
    // The same pace cell as the Race order card's "Average run pace" row.
    const avgLabel = [...document.querySelectorAll('span')].find(el => el.textContent === 'Average run pace')!;
    const avgCell = avgLabel.parentElement!.parentElement!.lastElementChild!.textContent!.trim();
    expect(run.textContent).toContain(avgCell);
    // The gain is the run total's, from the same projection.
    const proj = buildHyroxProjection(s, predictHyroxRace(s)!);
    const runGain = Math.round(proj.byDiscipline.run.currentSec - proj.byDiscipline.run.projectedSec);
    if (runGain >= 1) expect(run.textContent).toContain(`\u2212${runGain}s`);
    // The pace cell is per leg; the caption says the gain is the 8 legs' total.
    if (runGain >= 1) expect(run.textContent).toContain('Most time lost in your last race · 8-run total');
    expectVisualConstraints(gain.outerHTML);
  });

  it('a Mixed pair whose biggest loss is Running gets the Running row too (no Race order card for doubles)', () => {
    setState(hyroxState({ ...MIXED_PAIR, raceDate: raceDate() }));
    renderHyroxForecastView();
    expect(document.querySelector('[data-lt-headline]')!.textContent).toContain('Most time lost on Running');
    const gain = document.getElementById('hx-where-to-gain')!;
    expect(gain.querySelector('[data-wtg-segment="run_total"]')!.textContent).toContain('Most time lost in your last race');
    expectVisualConstraints(gain.outerHTML);
  });

  it('Where to gain without a past result: the top 2 only', () => {
    setState(hyroxState({ raceDate: raceDate() }));
    renderHyroxForecastView();
    const gain = document.getElementById('hx-where-to-gain')!;
    expect(gain.querySelectorAll('[data-wtg-station]').length).toBeLessThanOrEqual(2);
    expect(gain.textContent).not.toContain('last race');
  });

  it('the hero\'s goal line is the race plan\'s entry; no link in the Race order card; lose-time sits right above "Where to gain"', () => {
    setState(hyroxState({ ...pastResult(), raceDate: raceDate(), targetFinishTimeSec: 5000 }));
    renderHyroxForecastView();
    const cta = document.getElementById('hx-set-target-cta')!;
    expect(cta.textContent).toBe('Goal 1:23:20 · Race plan ›');
    expect(cta.getAttribute('data-has-goal')).toBe('1');
    expect(document.getElementById('hx-race-plan-link')).toBeNull();
    expect(document.getElementById('hx-race-plan-entry')).toBeNull();
    cta.click();
    expect(document.querySelector('[data-rp-subhead]')!.textContent).toContain('goal');
    setState(hyroxState({ ...pastResult(), raceDate: raceDate(), targetFinishTimeSec: 5000 }));
    renderHyroxForecastView();
    const lose = document.getElementById('hx-lose-time');
    expect(lose).not.toBeNull();
    const gain = document.getElementById('hx-where-to-gain');
    expect(gain).not.toBeNull();
    expect(lose!.nextElementSibling).toBe(gain);
  });

  it('without a goal the hero line sets one (the goal modal), and the Race order card heads its columns Split and Clock with Run N legs', () => {
    setState(hyroxState({ raceDate: raceDate() }));
    renderHyroxForecastView();
    const cta = document.getElementById('hx-set-target-cta')!;
    expect(cta.textContent).toBe('Set a goal ›');
    expect(cta.getAttribute('data-has-goal')).toBe('0');
    const head = document.querySelector('#hx-rows-race')!.firstElementChild!.textContent!.replace(/\s+/g, ' ').trim();
    expect(head).toBe('Split Clock');
    const rows = document.querySelector('#hx-rows-race')!.textContent!;
    expect(rows).toContain('Run 1');
    expect(rows).not.toMatch(/\bR1\b/);
  });

  it('doubles without a goal (no Race order card): the entry row, with no numbers; with a goal the hero line is the entry', () => {
    setState(hyroxState({ format: 'open_doubles', division: 'mixed', raceDate: raceDate() }));
    renderHyroxForecastView();
    const entry = document.getElementById('hx-race-plan-entry');
    expect(entry).not.toBeNull();
    expect(entry!.textContent).not.toMatch(/\d/);
    setState(hyroxState({ format: 'open_doubles', division: 'mixed', raceDate: raceDate(), targetFinishTimeSec: 4600 }));
    renderHyroxForecastView();
    expect(document.getElementById('hx-race-plan-entry')).toBeNull();
    expect(document.getElementById('hx-set-target-cta')!.textContent).toContain('Race plan ›');
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
