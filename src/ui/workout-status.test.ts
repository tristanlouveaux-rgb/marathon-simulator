import { describe, it, expect } from 'vitest';
import {
  computeWorkoutStatus,
  renderWorkoutStatusChip,
  computeWeekStatusContext,
  deriveWorkoutStatus,
  TODAY_ACCENT,
  type WorkoutStatusFlags,
} from './workout-status';

const base: WorkoutStatusFlags = {
  isDone: false,
  hasMatchedActivity: false,
  isSkipped: false,
  isReplaced: false,
  isHoliday: false,
  isAdded: false,
  isReduced: false,
  isToday: false,
  isPast: false,
};

describe('computeWorkoutStatus — labels and precedence', () => {
  it('upcoming (no flags) renders no chip', () => {
    const chip = computeWorkoutStatus(base);
    expect(chip.label).toBe('Upcoming');
    expect(chip.show).toBe(false);
  });

  it('today is terracotta', () => {
    const chip = computeWorkoutStatus({ ...base, isToday: true });
    expect(chip.label).toBe('Today');
    expect(chip.color).toBe(TODAY_ACCENT);
    expect(chip.show).toBe(true);
  });

  it('past and undone is Missed (orange)', () => {
    const chip = computeWorkoutStatus({ ...base, isPast: true });
    expect(chip.label).toBe('Missed');
    expect(chip.color).toBe('#FF9500');
  });

  it('done manually is Done (green)', () => {
    const chip = computeWorkoutStatus({ ...base, isDone: true });
    expect(chip.label).toBe('Done');
    expect(chip.color).toBe('#34C759');
  });

  it('done with matched activity is Logged (green)', () => {
    const chip = computeWorkoutStatus({ ...base, isDone: true, hasMatchedActivity: true });
    expect(chip.label).toBe('Logged');
    expect(chip.color).toBe('#34C759');
  });

  it('done wins over past — a logged past session is Logged, not Missed', () => {
    const chip = computeWorkoutStatus({ ...base, isDone: true, hasMatchedActivity: true, isPast: true });
    expect(chip.label).toBe('Logged');
    expect(chip.color).toBe('#34C759');
  });

  it('skipped is not coloured orange (distinct from Missed)', () => {
    const chip = computeWorkoutStatus({ ...base, isSkipped: true, isPast: true });
    expect(chip.label).toBe('Skipped');
    expect(chip.color).toBe('var(--c-faint)');
  });

  it('replaced wins over reduced', () => {
    const chip = computeWorkoutStatus({ ...base, isReplaced: true, isReduced: true });
    expect(chip.label).toBe('Replaced');
  });

  it('reduced renders as Adjusted', () => {
    expect(computeWorkoutStatus({ ...base, isReduced: true }).label).toBe('Adjusted');
  });

  it('holiday and added are surfaced', () => {
    expect(computeWorkoutStatus({ ...base, isHoliday: true }).label).toBe('Holiday');
    expect(computeWorkoutStatus({ ...base, isAdded: true }).label).toBe('Added');
  });
});

describe('renderWorkoutStatusChip', () => {
  it('returns empty string for the trivial Upcoming state', () => {
    expect(renderWorkoutStatusChip(computeWorkoutStatus(base))).toBe('');
  });

  it('renders a span with the colour for a non-trivial state', () => {
    const html = renderWorkoutStatusChip(computeWorkoutStatus({ ...base, isToday: true }));
    expect(html).toContain('Today');
    expect(html).toContain(TODAY_ACCENT);
  });
});

describe('deriveWorkoutStatus — workout + week context', () => {
  const ctxPast = { viewWeek: 1, currentWeek: 3, weekEnded: false, actualToday: 2 };

  it('a matched activity reads as Logged', () => {
    const wk = { garminActuals: { w1: { distanceKm: 5 } }, rated: {} };
    const w = { id: 'w1', n: 'Easy', dayOfWeek: 0, matchedActivityId: 'w1' };
    expect(deriveWorkoutStatus(w, wk, ctxPast).label).toBe('Logged');
  });

  it('completed status with no match reads as Done', () => {
    const wk = { garminActuals: {}, rated: {} };
    const w = { id: 'w2', n: 'Long', dayOfWeek: 0, status: 'completed' };
    expect(deriveWorkoutStatus(w, wk, ctxPast).label).toBe('Done');
  });

  it('a positive rating reads as Done', () => {
    const wk = { garminActuals: {}, rated: { w3: 6 } };
    const w = { id: 'w3', n: 'Tempo', dayOfWeek: 0 };
    expect(deriveWorkoutStatus(w, wk, ctxPast).label).toBe('Done');
  });

  it('an undone session in a past week reads as Missed', () => {
    const wk = { garminActuals: {}, rated: {} };
    const w = { id: 'w4', n: 'Threshold', dayOfWeek: 0 };
    expect(deriveWorkoutStatus(w, wk, ctxPast).label).toBe('Missed');
  });

  it('a skip rating reads as Skipped', () => {
    const wk = { garminActuals: {}, rated: { w5: 'skip' } };
    const w = { id: 'w5', n: 'Recovery', dayOfWeek: 0 };
    expect(deriveWorkoutStatus(w, wk, ctxPast).label).toBe('Skipped');
  });

  it('a replaced workout reads as Replaced', () => {
    const wk = { garminActuals: {}, rated: {} };
    const w = { id: 'w6', n: 'Swim', dayOfWeek: 0, status: 'replaced' };
    expect(deriveWorkoutStatus(w, wk, ctxPast).label).toBe('Replaced');
  });

  it('a future week shows no chip for an untouched session', () => {
    const ctxFuture = { viewWeek: 5, currentWeek: 3, weekEnded: false, actualToday: 2 };
    const wk = { garminActuals: {}, rated: {} };
    const w = { id: 'w7', n: 'Brick', dayOfWeek: 4 };
    expect(deriveWorkoutStatus(w, wk, ctxFuture).show).toBe(false);
  });
});

describe('current-week today detection (regression: Saturday session marked Missed)', () => {
  // Saturday = actualToday 5. weekEnded false (the common case, incl. a missing
  // planStartDate). Today's own session must read Today, not Missed.
  const satCtx = { viewWeek: 4, currentWeek: 4, weekEnded: false, actualToday: 5 };
  const emptyWk = { garminActuals: {}, rated: {} };

  it("today's session reads Today even when weekEnded is false", () => {
    const w = { id: 's', n: 'Long ride', dayOfWeek: 5 };
    expect(deriveWorkoutStatus(w, emptyWk, satCtx).label).toBe('Today');
  });

  it('an earlier-in-week undone session reads Missed', () => {
    const w = { id: 's', n: 'Tue swim', dayOfWeek: 1 };
    expect(deriveWorkoutStatus(w, emptyWk, satCtx).label).toBe('Missed');
  });

  it('a later-in-week session reads Upcoming (no chip)', () => {
    const w = { id: 's', n: 'Sun run', dayOfWeek: 6 };
    expect(deriveWorkoutStatus(w, emptyWk, satCtx).show).toBe(false);
  });

  it('a fully-elapsed current week (weekEnded) still flags undone sessions Missed', () => {
    const ended = { viewWeek: 4, currentWeek: 4, weekEnded: true, actualToday: 5 };
    const w = { id: 's', n: 'Sat ride', dayOfWeek: 5 };
    expect(deriveWorkoutStatus(w, emptyWk, ended).label).toBe('Missed');
  });
});

describe('computeWeekStatusContext', () => {
  it('never marks a non-current week as ended', () => {
    const ctx = computeWeekStatusContext('2026-01-05', 2, 4);
    expect(ctx.weekEnded).toBe(false);
    expect(ctx.actualToday).toBeGreaterThanOrEqual(0);
    expect(ctx.actualToday).toBeLessThanOrEqual(6);
  });

  it('a missing planStartDate leaves weekEnded false (does not blanket-mark the week past)', () => {
    const ctx = computeWeekStatusContext(undefined, 3, 3);
    expect(ctx.weekEnded).toBe(false);
  });

  it('a current week whose calendar range is long past is marked ended', () => {
    // Week 1 anchored on a date years ago is unambiguously elapsed.
    const ctx = computeWeekStatusContext('2020-01-06', 1, 1);
    expect(ctx.weekEnded).toBe(true);
  });
});
