/**
 * Rule 5 (M4 design v4 review, major 1): a skipped long run or quality session
 * is not carried into a taper week of a running race plan. It is dropped with
 * the base penalty (the past-the-carry-limit path). Easy runs still carry, and
 * nothing changes before non-taper weeks or in continuous mode.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./renderer', () => ({ render: vi.fn(), log: vi.fn() }));
vi.mock('@/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state')>();
  return { ...actual, saveState: vi.fn() };
});

import { setState, getMutableState } from '@/state/store';
import { skip } from './events';
import { TIM } from '@/constants';
import { isTaperCarryBlocked, filterTaperMakeups } from '@/workouts/race-day-rules';
import type { SimulatorState } from '@/types';

function makeElement(): any {
  const handlers: Record<string, Array<() => void>> = {};
  const buttons: Record<string, any> = {};
  return {
    className: '', innerHTML: '', style: {},
    addEventListener(type: string, fn: () => void) { (handlers[type] ??= []).push(fn); },
    click() { (handlers.click ?? []).forEach(fn => fn()); },
    querySelector(sel: string) { return (buttons[sel] ??= makeElement()); },
    remove() {},
  };
}
const overlays: any[] = [];
(globalThis as any).document = {
  createElement: () => makeElement(),
  getElementById: () => null,
  body: { appendChild: (el: any) => { overlays.push(el); return el; } },
};

// 7-week block: build x4, peak (week 5), taper (6), race week (7).
const PHASES = ['build', 'build', 'build', 'build', 'peak', 'taper', 'taper'];
function blockState(w: number, continuousMode = false): SimulatorState {
  return {
    w, tw: 7, rd: 'marathon', continuousMode, timp: 0, eventType: 'running',
    wks: PHASES.map((ph, i) => ({ w: i + 1, ph, rated: {}, skip: [] })),
  } as unknown as SimulatorState;
}

describe('isTaperCarryBlocked / filterTaperMakeups', () => {
  const s = blockState(5);
  it('long runs and quality sessions into a taper week: blocked; easy runs and non-taper weeks: carried', () => {
    expect(isTaperCarryBlocked(s, 6, { t: 'long', longRun: true })).toBe(true);
    expect(isTaperCarryBlocked(s, 6, { t: 'progressive', longRun: true })).toBe(true);
    expect(isTaperCarryBlocked(s, 6, { t: 'threshold' })).toBe(true);
    expect(isTaperCarryBlocked(s, 6, { t: 'float' })).toBe(true);
    expect(isTaperCarryBlocked(s, 6, { t: 'easy' })).toBe(false);
    expect(isTaperCarryBlocked(s, 5, { t: 'long', longRun: true })).toBe(false);
    expect(isTaperCarryBlocked(blockState(5, true), 6, { t: 'long', longRun: true })).toBe(false);
    expect(isTaperCarryBlocked({ ...s, eventType: 'triathlon' } as any, 6, { t: 'long', longRun: true })).toBe(false);
  });
  it('the generator backstop keeps easy makeups in a taper week and none in race week', () => {
    const skips = [
      { workout: { t: 'long', longRun: true } }, { workout: { t: 'threshold' } }, { workout: { t: 'easy' } },
    ];
    expect(filterTaperMakeups(skips).map(x => x.workout.t)).toEqual(['easy']);
    expect(filterTaperMakeups(skips, { raceWeek: true })).toEqual([]);
  });
});

describe('skip() before a taper week', () => {
  beforeEach(() => { overlays.length = 0; });

  it('a quality session skipped in the peak week is dropped with the base penalty, not carried', () => {
    setState(blockState(5));
    skip('W5-marathon_pace-0', 'Marathon Pace', 'marathon_pace', false, 0, '10km @ MP', 6, 1, 'Tuesday');
    const s = getMutableState();
    expect(s.wks[4].skip).toHaveLength(0);
    expect(s.wks[4].rated['W5-marathon_pace-0']).toBe('skip');
    expect(s.timp).toBe(TIM.marathon.marathon_pace);
  });

  it('the peak-week long run is dropped with the long-run base penalty', async () => {
    setState(blockState(5));
    skip('W5-long-0', 'Long Run', 'long', false, 0, '22km', 3, 6, 'Sunday', undefined, true);
    overlays[0].querySelector('#btn-skip-longrun').click();
    await Promise.resolve();
    const s = getMutableState();
    expect(s.wks[4].skip).toHaveLength(0);
    expect(s.timp).toBe(TIM.marathon.long);
  });

  it('an easy run still carries into the taper; a quality session before a build week still carries', () => {
    setState(blockState(5));
    skip('W5-easy-0', 'Easy Run', 'easy', false, 0, '8km', 3, 2, 'Wednesday');
    expect(getMutableState().wks[4].skip).toHaveLength(1);
    setState(blockState(3));
    skip('W3-marathon_pace-0', 'Marathon Pace', 'marathon_pace', false, 0, '10km @ MP', 6, 1, 'Tuesday');
    expect(getMutableState().wks[2].skip).toHaveLength(1);
    expect(getMutableState().timp).toBe(0);
  });
});
