import { describe, it, expect, vi } from 'vitest';

// Mirror the localStorage + alert stubs the other initialization tests use, so
// saveState() and any onboarding side-effects have somewhere to write.
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('alert', vi.fn());

import { seedReviewerDemo } from './demo-data';
import { getState } from './store';
import { isReviewerCode, isValidAccessCode } from '@/constants/access-codes';

describe('seedReviewerDemo', () => {
  it('produces a complete, onboarded running account a reviewer can evaluate', () => {
    const ok = seedReviewerDemo();
    expect(ok).toBe(true);

    const s = getState();
    // Onboarding is marked done so the app boots into the main view, not the wizard.
    expect(s.hasCompletedOnboarding).toBe(true);
    // A real plan was generated (non-empty weeks).
    expect(s.wks.length).toBeGreaterThan(0);
    // The marathon target carried through.
    expect(s.rd).toBe('marathon');
    // Fitness was seeded, so the forecast/home aren't blank.
    expect((s.v ?? 0)).toBeGreaterThan(0);
    // A trial window was set, matching the normal completeOnboarding path.
    expect(typeof s.trialExpiry).toBe('string');
  });

  it('seeds a race that is always in the future (a hardcoded date went stale once)', () => {
    seedReviewerDemo();
    const s = getState();
    // Regression: the original seed hardcoded date '2026-04-26'; once that passed,
    // a fresh REVIEW account booted with a "race is done" banner over a Week-1 plan.
    const raceDate = new Date(s.onboarding?.selectedRace?.date ?? '1970-01-01');
    const daysOut = (raceDate.getTime() - Date.now()) / 86400000;
    expect(daysOut).toBeGreaterThan(105); // ~15 weeks minimum
    expect(daysOut).toBeLessThan(126);    // and not absurdly far (≤18 weeks)
    // Date is stored as a UTC-anchored YYYY-MM-DD; read its weekday in UTC so the
    // assertion is timezone-independent (getDay() would read Saturday in the Americas).
    expect(raceDate.getUTCDay()).toBe(0);    // race day lands on a Sunday
  });

  it('generates a real multi-week phased training block (not an empty shell)', () => {
    seedReviewerDemo();
    const s = getState();
    // A full block, not a single rolling week.
    expect((s.tw ?? 0)).toBeGreaterThan(1);
    expect(s.wks.length).toBe(s.tw);
    // Every week is assigned a training phase (running plans generate workouts
    // on demand from each week's phase, so a phase on every week == a real plan).
    expect(s.wks.every((wk: any) => typeof wk.ph === 'string' && wk.ph.length > 0)).toBe(true);
  });
});

describe('reviewer code routing', () => {
  it('the reviewer code is recognised as such, not as a Strava beta code', () => {
    expect(isReviewerCode('REVIEW')).toBe(true);
    expect(isReviewerCode('review')).toBe(true);
    expect(isReviewerCode('  Review  ')).toBe(true);
    // It must NOT also unlock the Strava beta path.
    expect(isValidAccessCode('REVIEW')).toBe(false);
  });

  it('the Strava beta code is not mistaken for the reviewer code', () => {
    expect(isReviewerCode('BENJAMIN')).toBe(false);
  });
});
