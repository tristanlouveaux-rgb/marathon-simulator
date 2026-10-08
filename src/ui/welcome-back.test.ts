/**
 * Tests for `assertPlanAnchorConsistent`. The launch-time tripwire that
 * surfaces drift between `s.w` and `planStartDate` before activities silently
 * mis-file.
 *
 * Real incident, 2026-05-28: an injury-modal bug over-advanced `s.w` while
 * `planStartDate` drifted forward by a week, and two cycles dropped out of the
 * plan view for days. This test guards the tripwire that would have caught it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setState, getMutableState } from '@/state/store';
import { assertPlanAnchorConsistent, reconcilePlanAnchorToEarliestActivity, detrainingLossFraction, computeVdotLoss, DETRAINING_DEADZONE_DAYS, advanceWeekToToday } from './welcome-back';
import type { SimulatorState } from '@/types/state';

function buildState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  const wks = Array.from({ length: 12 }, (_, i) => ({
    w: i + 1,
    ph: 'base',
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
  }));
  return {
    eventType: 'running',
    hasCompletedOnboarding: true,
    planStartDate: '2026-04-27', // Mon Apr 27 2026
    w: 5,
    wks,
    ...overrides,
  } as unknown as SimulatorState;
}

describe('assertPlanAnchorConsistent', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('is silent when s.w and planStartDate agree on today (week 5 day 4)', () => {
    // Apr 27 + 28d = May 25 (Mon, start of week 5). Apr 27 + 31d = May 28 (Thu, mid-week 5).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
    setState(buildState({ planStartDate: '2026-04-27', w: 5 }));
    assertPlanAnchorConsistent();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when planStartDate has drifted forward (real 2026-05-28 incident)', () => {
    // The actual corrupted state: anchor bumped from Apr 27 → May 4 while s.w stayed 5.
    // Under May 4 anchor, today May 28 is week 4, not week 5.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
    setState(buildState({ planStartDate: '2026-05-04', w: 5 }));
    assertPlanAnchorConsistent();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toMatch(/s\.w=5/);
    expect(msg).toMatch(/weekIndexForDate\(today\)=4/);
    expect(msg).toMatch(/drift=\+1w/);
  });

  it('warns when s.w has been over-advanced (mirror of the injury-bug shape)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
    // Anchor is correct (Apr 27 → today is week 5) but s.w jumped to 6.
    setState(buildState({ planStartDate: '2026-04-27', w: 6 }));
    assertPlanAnchorConsistent();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/drift=\+1w/);
  });

  it('warns with negative drift when s.w is behind the anchor', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
    setState(buildState({ planStartDate: '2026-04-27', w: 3 }));
    assertPlanAnchorConsistent();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/drift=-2w/);
  });

  it('is silent when planStartDate is unset (fresh install, no plan yet)', () => {
    setState(buildState({ planStartDate: undefined, w: 1, wks: [] }));
    assertPlanAnchorConsistent();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is silent before onboarding is complete', () => {
    setState(buildState({ hasCompletedOnboarding: false }));
    assertPlanAnchorConsistent();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is silent when today is before planStartDate (computed is null)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T12:00:00Z')); // before Apr 27 plan start
    setState(buildState({ planStartDate: '2026-04-27', w: 1 }));
    assertPlanAnchorConsistent();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is silent when today is past the end of the plan', () => {
    vi.useFakeTimers();
    // Plan = 12 weeks from Apr 27 → ends week ending Jul 19. Test Aug 1.
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    setState(buildState({ planStartDate: '2026-04-27', w: 12 }));
    assertPlanAnchorConsistent();
    // weekIndexForDate returns null when idx > wks.length. No warn.
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('reconcilePlanAnchorToEarliestActivity', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  /** Put an activity (by startTime) into a given week's garminActuals. */
  function withActual(state: SimulatorState, weekIdx: number, startTime: string): SimulatorState {
    (state.wks[weekIdx] as unknown as { garminActuals: Record<string, unknown> }).garminActuals = {
      [`garmin-${startTime}`]: { garminId: startTime, startTime, distanceKm: 5 },
    };
    return state;
  }

  it('pulls planStartDate back to the Monday of the earliest activity (real 2026-06-01 incident)', () => {
    // Anchor drifted to May 4 while the first activity was Apr 27 (a Monday).
    const s = withActual(buildState({ planStartDate: '2026-05-04', w: 5 }), 3, '2026-04-27T08:00:00Z');
    setState(s);
    const moved = reconcilePlanAnchorToEarliestActivity();
    expect(moved).toBe(true);
    expect(getMutableState().planStartDate).toBe('2026-04-27');
    // Anchor moved back 1 week → s.w bumps 5→6 so no spurious detraining fires.
    expect(getMutableState().w).toBe(6);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('snaps a mid-week earliest activity back to its Monday', () => {
    // First activity Wed Apr 29 → its Monday is Apr 27.
    const s = withActual(buildState({ planStartDate: '2026-05-04', w: 5 }), 0, '2026-04-29T18:00:00Z');
    setState(s);
    expect(reconcilePlanAnchorToEarliestActivity()).toBe(true);
    expect(getMutableState().planStartDate).toBe('2026-04-27');
    expect(getMutableState().w).toBe(6);
  });

  it('considers adhocWorkouts garminTimestamp when finding the earliest', () => {
    const s = buildState({ planStartDate: '2026-05-04', w: 5 });
    (s.wks[2] as unknown as { adhocWorkouts: unknown[] }).adhocWorkouts = [
      { id: 'garmin-x', garminTimestamp: '2026-04-27T06:00:00Z' },
    ];
    setState(s);
    expect(reconcilePlanAnchorToEarliestActivity()).toBe(true);
    expect(getMutableState().planStartDate).toBe('2026-04-27');
  });

  it('considers garminPending startTime when finding the earliest', () => {
    const s = buildState({ planStartDate: '2026-05-04', w: 5 });
    (s.wks[1] as unknown as { garminPending: unknown[] }).garminPending = [
      { garminId: 'p1', startTime: '2026-04-27T07:00:00Z' },
    ];
    setState(s);
    expect(reconcilePlanAnchorToEarliestActivity()).toBe(true);
    expect(getMutableState().planStartDate).toBe('2026-04-27');
  });

  it('does NOT move the anchor when it already precedes the earliest activity (user rested week 1)', () => {
    // Anchor Apr 27, first activity not until May 11 (week 3). Valid — leave alone.
    const s = withActual(buildState({ planStartDate: '2026-04-27', w: 5 }), 2, '2026-05-11T08:00:00Z');
    setState(s);
    expect(reconcilePlanAnchorToEarliestActivity()).toBe(false);
    expect(getMutableState().planStartDate).toBe('2026-04-27');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does NOT move the anchor when it equals the earliest activity Monday', () => {
    const s = withActual(buildState({ planStartDate: '2026-04-27', w: 5 }), 0, '2026-04-27T08:00:00Z');
    setState(s);
    expect(reconcilePlanAnchorToEarliestActivity()).toBe(false);
    expect(getMutableState().planStartDate).toBe('2026-04-27');
  });

  it('is a no-op when there are no logged activities', () => {
    setState(buildState({ planStartDate: '2026-05-04', w: 5 }));
    expect(reconcilePlanAnchorToEarliestActivity()).toBe(false);
    expect(getMutableState().planStartDate).toBe('2026-05-04');
  });

  it('is a no-op before onboarding, with no anchor, or with no weeks', () => {
    setState(buildState({ hasCompletedOnboarding: false, planStartDate: '2026-05-04' }));
    expect(reconcilePlanAnchorToEarliestActivity()).toBe(false);
    setState(buildState({ planStartDate: undefined as unknown as string, wks: [] }));
    expect(reconcilePlanAnchorToEarliestActivity()).toBe(false);
  });
});

describe('detrainingLossFraction — shared VDOT/FTP/CSS decay curve', () => {
  it('loses nothing inside the 10-day dead-zone', () => {
    expect(detrainingLossFraction(0)).toBe(0);
    expect(detrainingLossFraction(7)).toBe(0);   // a normal week off is a taper
    expect(detrainingLossFraction(9)).toBe(0);
    expect(detrainingLossFraction(DETRAINING_DEADZONE_DAYS)).toBe(0); // boundary: 0 days past
  });

  it('starts detraining only past the dead-zone, and grows with time away', () => {
    const d14 = detrainingLossFraction(14);
    const d21 = detrainingLossFraction(21);
    const d35 = detrainingLossFraction(35);
    expect(d14).toBeGreaterThan(0);
    expect(d21).toBeGreaterThan(d14);
    expect(d35).toBeGreaterThan(d21);
    // ~2 weeks past the dead-zone (24 days) should be a small single-digit % loss,
    // matching the ~1.2%/wk early-detraining rate (Mujika & Padilla 2000).
    expect(detrainingLossFraction(24)).toBeLessThan(0.05);
  });

  it('attenuates loss by the activity-while-away ratio', () => {
    const full = detrainingLossFraction(31, 0);      // sedentary holiday
    const half = detrainingLossFraction(31, 0.5);    // kept ~half the load
    const kept = detrainingLossFraction(31, 1);      // trained as normal away
    expect(half).toBeCloseTo(full * 0.5, 6);
    expect(kept).toBe(0);
    // ratios above 1 (trained MORE than normal) clamp to no loss, never negative.
    expect(detrainingLossFraction(31, 1.4)).toBe(0);
  });
});

describe('computeVdotLoss — inherits the dead-zone', () => {
  it('docks nothing for a one-week gap', () => {
    expect(computeVdotLoss(50, 1)).toBe(0); // 7 days < dead-zone
  });
  it('docks a small amount for a multi-week gap', () => {
    const loss = computeVdotLoss(50, 3); // 21 days → ~1 week of detraining
    expect(loss).toBeGreaterThan(0);
    expect(loss).toBeLessThan(2); // small: a few tenths of a VDOT point, not a cliff
  });
});

describe('advanceWeekToToday: race week and a closing week always open (design v4 Q16)', () => {
  afterEach(() => vi.useRealTimers());
  const raceState = (w: number, lastCompleteDebriefWeek: number): SimulatorState => {
    const wks = Array.from({ length: 7 }, (_, i) => ({
      w: i + 1, ph: i >= 4 ? 'taper' : 'build', ...(i === 6 ? { raceClosing: true } : {}),
      rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
    }));
    return {
      eventType: 'running', hasCompletedOnboarding: true, continuousMode: false,
      planStartDate: '2026-10-05', w, tw: 7, wks, rd: 'marathon',
      onboarding: { customRaceDate: '2026-11-17' }, lastCompleteDebriefWeek,
    } as unknown as SimulatorState;
  };

  it('a skipped debrief no longer holds the runner out of race week or the closing week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 11, 12)); // Wed 11 Nov: week 6 (race week)
    setState(raceState(5, 4));
    advanceWeekToToday();
    expect(getMutableState().w).toBe(6);
    vi.setSystemTime(new Date(2026, 10, 16, 12)); // Mon 16 Nov: week 7 (closing week, race Tuesday)
    setState(raceState(5, 4));
    advanceWeekToToday();
    expect(getMutableState().w).toBe(7);
  });

  it('earlier weeks keep the debrief cap', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 4, 12)); // Wed 4 Nov: week 5
    setState(raceState(3, 3));
    advanceWeekToToday();
    expect(getMutableState().w).toBe(4);
  });
});
