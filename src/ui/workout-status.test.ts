import { describe, it, expect } from 'vitest';
import {
  computeWorkoutStatus,
  renderWorkoutStatusChip,
  computeWeekStatusContext,
  deriveWorkoutStatus,
  firstTrackedDow,
  dropPreOnboardSessions,
  TODAY_ACCENT,
  type WorkoutStatusFlags,
} from './workout-status';

const base: WorkoutStatusFlags = {
  isDone: false,
  hasMatchedActivity: false,
  isSkipped: false,
  isReplaced: false,
  isHoliday: false,
  isIllness: false,
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

  it('past illness-rested day is "Illness" (faint), NOT Missed', () => {
    const chip = computeWorkoutStatus({ ...base, isPast: true, isIllness: true });
    expect(chip.label).toBe('Illness');
    expect(chip.color).toBe('var(--c-faint)');   // deliberate rest, not an orange miss
  });

  it('a done session logged during illness still reads Done, not Illness', () => {
    const chip = computeWorkoutStatus({ ...base, isPast: true, isIllness: true, isDone: true });
    expect(chip.label).toBe('Done');
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

  it('done wins over today — a session logged TODAY is green, not terracotta', () => {
    // Regression: label came from the done-first cascade ("Logged") but colour
    // from a today-first cascade (terracotta), so today's completed session
    // looked different from every other completed session in the week.
    const chip = computeWorkoutStatus({ ...base, isDone: true, hasMatchedActivity: true, isToday: true });
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

  it('threads planCreatedAt into firstTrackedDow for the current week', () => {
    // Week 1 starts Mon 2026-06-01; plan created Wed 2026-06-03 → Mon/Tue (0,1)
    // are pre-creation, Wed (2) is the first tracked day.
    const ctx = computeWeekStatusContext('2026-06-01', 1, 1, '2026-06-03');
    expect(ctx.firstTrackedDow).toBe(2);
  });

  it('does not apply firstTrackedDow to a non-current week', () => {
    const ctx = computeWeekStatusContext('2026-06-01', 2, 4, '2026-06-03');
    expect(ctx.firstTrackedDow).toBe(0);
  });
});

describe('firstTrackedDow — pre-creation days', () => {
  it('returns 0 when planCreatedAt is absent (legacy behaviour)', () => {
    expect(firstTrackedDow('2026-06-01', 1, undefined)).toBe(0);
  });

  it('returns the weekday of the creation date when created mid-week', () => {
    // Mon 06-01 .. created Wed 06-03 → first tracked is Wed = index 2.
    expect(firstTrackedDow('2026-06-01', 1, '2026-06-03')).toBe(2);
  });

  it('returns 0 when creation predates the week start (established plan)', () => {
    // Viewing week 3; creation was weeks earlier → whole week is tracked.
    expect(firstTrackedDow('2026-06-01', 3, '2026-05-20')).toBe(0);
  });
});

describe('pre-creation days are not Missed (onboard mid-week)', () => {
  // Plan created Wed (firstTrackedDow 2); today is Thu (actualToday 3).
  const ctx = { viewWeek: 1, currentWeek: 1, weekEnded: false, actualToday: 3, firstTrackedDow: 2 };
  const emptyWk = { garminActuals: {}, rated: {} };

  it('a pre-creation day (Tue, before Wed build) is not Missed', () => {
    const w = { id: 't', n: 'Tue swim', dayOfWeek: 1 };
    expect(deriveWorkoutStatus(w, emptyWk, ctx).show).toBe(false); // Upcoming, no chip
  });

  it('a post-creation earlier day (Wed) still reads Missed', () => {
    const w = { id: 'w', n: 'Wed ride', dayOfWeek: 2 };
    expect(deriveWorkoutStatus(w, emptyWk, ctx).label).toBe('Missed');
  });

  it("today's session still reads Today", () => {
    const w = { id: 'th', n: 'Thu run', dayOfWeek: 3 };
    expect(deriveWorkoutStatus(w, emptyWk, ctx).label).toBe('Today');
  });
});

describe('dropPreOnboardSessions — reduced partial first week', () => {
  // Mon..Sun, one session per day, dayOfWeek 0..6.
  const fullWeek = Array.from({ length: 7 }, (_, d) => ({ id: `d${d}`, dayOfWeek: d }));

  it('drops pre-onboard days when onboarded mid-week (Wed onboard → keep Wed..Sun)', () => {
    // planStart Mon 06-01, created Wed 06-03 → firstTrackedDow 2.
    const kept = dropPreOnboardSessions(fullWeek, '2026-06-01', 1, 1, '2026-06-03');
    expect(kept.map(w => w.dayOfWeek)).toEqual([2, 3, 4, 5, 6]);
  });

  it('Sat onboard leaves a chill 2-session week (Sat + Sun)', () => {
    // created Sat 06-06 → firstTrackedDow 5.
    const kept = dropPreOnboardSessions(fullWeek, '2026-06-01', 1, 1, '2026-06-06');
    expect(kept.map(w => w.dayOfWeek)).toEqual([5, 6]);
  });

  it('Sun onboard leaves a single-session lead-in week', () => {
    // created Sun 06-07 → firstTrackedDow 6.
    const kept = dropPreOnboardSessions(fullWeek, '2026-06-01', 1, 1, '2026-06-07');
    expect(kept.map(w => w.dayOfWeek)).toEqual([6]);
  });

  it('Monday onboard keeps the whole week (no-op)', () => {
    const kept = dropPreOnboardSessions(fullWeek, '2026-06-01', 1, 1, '2026-06-01');
    expect(kept).toHaveLength(7);
  });

  it('no-op for an established plan (creation predates week start)', () => {
    const kept = dropPreOnboardSessions(fullWeek, '2026-06-01', 1, 1, '2026-05-20');
    expect(kept).toHaveLength(7);
  });

  it('no-op for any week other than the current one', () => {
    // Viewing week 1 while current week is 2: pre-onboard filtering only applies
    // to the live week, so past weeks render exactly as they happened.
    const kept = dropPreOnboardSessions(fullWeek, '2026-06-01', 1, 2, '2026-06-03');
    expect(kept).toHaveLength(7);
  });

  it('no-op when planCreatedAt is absent (legacy)', () => {
    const kept = dropPreOnboardSessions(fullWeek, '2026-06-01', 1, 1, undefined);
    expect(kept).toHaveLength(7);
  });
});
