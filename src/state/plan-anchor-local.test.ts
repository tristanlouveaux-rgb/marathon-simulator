/**
 * Plan anchors are local calendar dates in every mode (approved default Q10 of
 * the M4 sharpening design: local-date week counting and plan anchors in all
 * modes, not running only).
 *
 * Before: triathlon, cycling, HYROX and Just-Track wrote planStartDate from the
 * UTC Monday (persistence getMondayOf) and planCreatedAt from toISOString. In
 * the first hours of a Monday east of UTC that is the previous week's Monday
 * and yesterday's date; late on a Sunday west of UTC it is the next Monday,
 * a future anchor. Running race plans already used local dates.
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';

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

import { initializeTriathlonSimulator } from './initialization.triathlon';
import { initializeCyclingSimulator } from './initialization.cycling';
import { initializeHyroxSimulator } from './initialization.hyrox';
import { initializeSimulator } from './initialization';
import { getState, resetState } from './store';
import type { OnboardingState } from '@/types/onboarding';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { vi.useRealTimers(); localStorageMock.clear(); });
afterAll(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

const MODES: Array<[string, () => unknown]> = [
  ['triathlon', () => initializeTriathlonSimulator({ trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate' } as OnboardingState)],
  ['cycling', () => initializeCyclingSimulator({ trainingMode: 'cycling', cyclingDistance: '160km', experienceLevel: 'intermediate' } as OnboardingState)],
  ['hyrox', () => initializeHyroxSimulator({
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate', triTimeAvailableHoursPerWeek: 8,
  } as OnboardingState)],
  ['just-track', () => initializeSimulator({ trainingMode: 'running', trackOnly: true, experienceLevel: 'intermediate', pbs: {} } as unknown as OnboardingState)],
];

// [time zone, instant, local today, local Monday]
const CASES: Array<[string, string, string, string]> = [
  ['Australia/Sydney', '2026-10-11T13:30:00Z', '2026-10-12', '2026-10-12'], // Monday 00:30 local; UTC still Sunday
  ['America/Los_Angeles', '2026-10-12T05:30:00Z', '2026-10-11', '2026-10-05'], // Sunday 22:30 local; UTC already Monday
];

describe('plan anchors are local calendar dates in every mode', () => {
  for (const [tz, instant, today, monday] of CASES) {
    for (const [mode, init] of MODES) {
      it(`${mode}, ${tz} at ${instant}: planStartDate is the local Monday, planCreatedAt the local date`, () => {
        process.env.TZ = tz;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(instant));
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        resetState();
        init();
        expect(getState().planStartDate).toBe(monday);
        expect(getState().planCreatedAt).toBe(today);
        vi.restoreAllMocks();
      });
    }
  }
});
