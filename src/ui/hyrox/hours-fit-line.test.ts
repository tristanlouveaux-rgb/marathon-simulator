/**
 * The HYROX plan view's hours line (round 6, item 7): wording, rounding and
 * when the view shows it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { hyroxHoursFitLine, hyroxHoursFitFor } from './hours-fit-line';
import type { SimulatorState } from '@/types/state';

const fit = { sessions: 5, plannedMin: 362, chosenHours: 8 };

function state(over: Record<string, unknown> = {}, w = 3): SimulatorState {
  const wks = Array.from({ length: 6 }, (_, i) => ({
    w: i + 1, ph: 'build', triWorkouts: [], rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [],
    adjustments: [], unspentLoad: 0, extraRunLoad: 0, hyroxHoursFit: fit,
  }));
  return { w, tw: 6, wks, planStartDate: '2026-09-28', ...over } as unknown as SimulatorState;
}

describe('hyroxHoursFitLine', () => {
  it('states the sessions, the week rounded to the half hour, and the chosen hours', () => {
    expect(hyroxHoursFitLine(fit)).toBe('Your 5 sessions fit about 6 h of your 8 h.');
    expect(hyroxHoursFitLine({ sessions: 6, plannedMin: 334, chosenHours: 12 })).toBe('Your 6 sessions fit about 5.5 h of your 12 h.');
    // 20 min under the chosen hours, the engine's least shortfall: the
    // rounded figure stays under the chosen hours.
    expect(hyroxHoursFitLine({ sessions: 4, plannedMin: 460, chosenHours: 8 })).toBe('Your 4 sessions fit about 7.5 h of your 8 h.');
    expect(hyroxHoursFitLine(fit)).not.toMatch(/—/);
  });
});

describe('hyroxHoursFitFor', () => {
  it('shows on the current and future weeks the engine marked', () => {
    const s = state();
    expect(hyroxHoursFitFor(s, 3)).toEqual(fit);
    expect(hyroxHoursFitFor(s, 5)).toEqual(fit);
  });

  it('never on a past week, a week without the mark, or a week injury, illness or a holiday shapes', () => {
    expect(hyroxHoursFitFor(state(), 2)).toBeUndefined();
    const none = state();
    delete (none.wks[3] as { hyroxHoursFit?: unknown }).hyroxHoursFit;
    expect(hyroxHoursFitFor(none, 4)).toBeUndefined();
    expect(hyroxHoursFitFor(state({ injuryState: { active: true } }), 3)).toBeUndefined();
    expect(hyroxHoursFitFor(state({ illnessState: { active: true } }), 3)).toBeUndefined();
    // Illness shapes the current week only.
    expect(hyroxHoursFitFor(state({ illnessState: { active: true } }), 4)).toEqual(fit);
    const bridged = state();
    (bridged.wks[3] as { _holidayBridgeScale?: number })._holidayBridgeScale = 0.8;
    expect(hyroxHoursFitFor(bridged, 4)).toBeUndefined();
  });
});
