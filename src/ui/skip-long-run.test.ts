/**
 * Audit X5: skipping the fast-finish long run ("Long Run (Fast Finish)",
 * type 'progressive') must follow the long-run skip rules: the long-run skip
 * warning, the long-run carry into next week, and the long-run race-time charge
 * on a second skip. Before the fix all three keyed on workoutType === 'long'.
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
import type { SimulatorState } from '@/types';

// Minimal DOM: the long-run warning appends an overlay and waits for a click on
// "Skip Anyway". Each element records its click handlers so the test can press it.
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

const FF_ID = 'W13-progressive-0';
const FF_NAME = 'Long Run (Fast Finish)';
const FF_DESC = '24km: last 5 @ MP';

function freshState(): SimulatorState {
  return {
    w: 13, tw: 16, rd: 'marathon', continuousMode: false, timp: 0,
    wks: Array.from({ length: 16 }, (_, i) => ({ w: i + 1, ph: 'peak', rated: {}, skip: [] })),
  } as unknown as SimulatorState;
}

describe('skipping the fast-finish long run', () => {
  beforeEach(() => {
    overlays.length = 0;
    setState(freshState());
  });

  it('shows the long-run skip warning, and an ordinary progressive run does not', () => {
    skip(FF_ID, FF_NAME, 'progressive', false, 0, FF_DESC, 5, 6, 'Sunday', undefined, true);
    expect(overlays).toHaveLength(1);
    // Nothing is skipped until the user confirms.
    expect(getMutableState().wks[12].skip).toHaveLength(0);

    setState(freshState());
    overlays.length = 0;
    skip('W13-progressive-1', 'Progressive Run', 'progressive', false, 0, '10km: last 3 @ MP', 5, 1, 'Tuesday');
    expect(overlays).toHaveLength(0);
    expect(getMutableState().wks[12].skip).toHaveLength(1);
  });

  it('carries the long-run stamp into next week when confirmed', async () => {
    skip(FF_ID, FF_NAME, 'progressive', false, 0, FF_DESC, 5, 6, 'Sunday', undefined, true);
    overlays[0].querySelector('#btn-skip-longrun').click();
    await Promise.resolve();
    const carried = getMutableState().wks[12].skip;
    expect(carried).toHaveLength(1);
    expect(carried[0].workout.t).toBe('progressive');
    expect(carried[0].workout.n).toBe(FF_NAME);
    expect(carried[0].workout.longRun).toBe(true);
  });

  it('charges the long-run penalty on a second skip, like the steady long run', () => {
    skip(FF_ID, `[Makeup] ${FF_NAME}`, 'progressive', true, 1, FF_DESC, 5, 6, 'Sunday', undefined, true);
    const ffCharge = getMutableState().timp;

    setState(freshState());
    skip('W13-long-0', '[Makeup] Long Run', 'long', true, 1, '24km', 3, 6, 'Sunday');
    const steadyCharge = getMutableState().timp;

    expect(ffCharge).toBe(Math.round(TIM.marathon.long! * 1.5));
    expect(ffCharge).toBe(steadyCharge);

    // An ordinary progressive run keeps its own (smaller) charge.
    setState(freshState());
    skip('W13-progressive-1', '[Makeup] Progressive Run', 'progressive', true, 1, '10km: last 3 @ MP', 5, 1, 'Tuesday');
    expect(getMutableState().timp).toBe(Math.round(TIM.marathon.progressive! * 1.5));
  });
});
