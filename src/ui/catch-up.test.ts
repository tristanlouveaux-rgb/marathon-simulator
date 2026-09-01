import { describe, it, expect } from 'vitest';
import { computeCatchUpGap, CATCH_UP_MIN_WEEKS } from './catch-up-gap';

const base = {
  currentWeek: 5,
  calendarWeek: 8,
  totalWeeks: 16,
  generatedWeeks: 16,
  onboarded: true,
  injuryActive: false,
};

describe('computeCatchUpGap', () => {
  it('returns the full gap when the calendar is several weeks ahead', () => {
    expect(computeCatchUpGap(base)).toEqual({ fromWeek: 5, toWeek: 8, weeks: 3 });
  });

  it('triggers at exactly the minimum gap', () => {
    const gap = computeCatchUpGap({ ...base, calendarWeek: 5 + CATCH_UP_MIN_WEEKS });
    expect(gap).toEqual({ fromWeek: 5, toWeek: 5 + CATCH_UP_MIN_WEEKS, weeks: CATCH_UP_MIN_WEEKS });
  });

  it('does not trigger one week below the minimum', () => {
    expect(computeCatchUpGap({ ...base, calendarWeek: 5 + CATCH_UP_MIN_WEEKS - 1 })).toBeNull();
  });

  it('does not trigger when the plan is in sync with the calendar', () => {
    expect(computeCatchUpGap({ ...base, calendarWeek: 5 })).toBeNull();
  });

  it('does not trigger when the calendar is behind the plan pointer', () => {
    expect(computeCatchUpGap({ ...base, calendarWeek: 3 })).toBeNull();
  });

  it('caps the landing week at the planned plan length', () => {
    expect(computeCatchUpGap({ ...base, currentWeek: 12, calendarWeek: 20 }))
      .toEqual({ fromWeek: 12, toWeek: 16, weeks: 4 });
  });

  it('caps the landing week at the generated week array when it is shorter', () => {
    expect(computeCatchUpGap({ ...base, calendarWeek: 20, totalWeeks: 16, generatedWeeks: 10 }))
      .toEqual({ fromWeek: 5, toWeek: 10, weeks: 5 });
  });

  it('returns null when capping leaves less than the minimum gap', () => {
    expect(computeCatchUpGap({ ...base, currentWeek: 15, calendarWeek: 20 })).toBeNull();
  });

  it('falls back to the generated week count when totalWeeks is unset', () => {
    expect(computeCatchUpGap({ ...base, calendarWeek: 20, totalWeeks: 0, generatedWeeks: 12 }))
      .toEqual({ fromWeek: 5, toWeek: 12, weeks: 7 });
  });

  it('does not trigger while an injury is active (rehab needs a weekly check-in)', () => {
    expect(computeCatchUpGap({ ...base, injuryActive: true })).toBeNull();
  });

  it('does not trigger before onboarding completes', () => {
    expect(computeCatchUpGap({ ...base, onboarded: false })).toBeNull();
  });

  it('does not trigger with no generated weeks', () => {
    expect(computeCatchUpGap({ ...base, generatedWeeks: 0 })).toBeNull();
  });

  it('does not trigger with an invalid week pointer', () => {
    expect(computeCatchUpGap({ ...base, currentWeek: 0 })).toBeNull();
  });
});
