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
import { setState } from '@/state/store';
import { assertPlanAnchorConsistent } from './welcome-back';
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
