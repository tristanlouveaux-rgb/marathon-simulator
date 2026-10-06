// @vitest-environment jsdom
/**
 * Tri past-race step: the Strava scan reads a year of garmin_activities.
 *
 * F8: a Strava or Apple sync that would stamp iTRIMP before the athlete's sex
 * is final is held (trimp-sex-gate.ts) and starts when about-you is left, two
 * steps before this one, so its rows may still be landing when the athlete
 * taps Scan. Released syncs are startup tasks; the scan waits for them before
 * it reads, so a race day in the held backfill is found.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';

const h = vi.hoisted(() => {
  const store: { state: any } = { state: { onboarding: {} } };
  let releaseSyncs: () => void = () => undefined;
  const db: { rows: Array<Record<string, unknown>>; reads: number } = { rows: [], reads: 0 };
  const query = {
    select: () => query,
    eq: () => query,
    gte: () => query,
    in: () => query,
    order: async () => { db.reads++; return { data: db.rows, error: null }; },
  };
  return {
    store,
    db,
    query,
    getState: vi.fn(() => store.state),
    awaitStartupSyncs: vi.fn(() => new Promise<void>((resolve) => { releaseSyncs = resolve; })),
    finishSyncs: () => releaseSyncs(),
  };
});

vi.mock('@/state/store', () => ({ getState: h.getState }));
vi.mock('../controller', () => ({ nextStep: vi.fn(), updateOnboarding: vi.fn() }));
vi.mock('../renderer', () => ({ renderProgressIndicator: () => '', renderBackButton: () => '' }));
vi.mock('@/ui/page-flair', () => ({
  buildRingBackground: () => '', buildSunGlint: () => '', buildAtmosphereBase: () => '',
}));
vi.mock('@/app/runtime', () => ({ awaitStartupSyncs: h.awaitStartupSyncs }));
vi.mock('@/data/supabaseClient', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    from: () => h.query,
  },
  callEdgeFunction: vi.fn(),
}));

import { renderTriPastRace } from './tri-past-race';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  h.db.rows = [];
  h.db.reads = 0;
  h.store.state = { onboarding: { currentStep: 'tri-past-race', trainingMode: 'triathlon', triDistance: 'ironman', triPastRace: null } };
  document.body.innerHTML = '<div id="app-root"></div>';
  renderTriPastRace(document.getElementById('app-root')!, h.store.state.onboarding as OnboardingState);
});

describe('tri past-race Strava scan waits for syncs released after about-you', () => {
  it('does not read garmin_activities until the startup syncs settle, then finds the race the held backfill wrote', async () => {
    (document.getElementById('tpr-strava-btn') as HTMLButtonElement).click();
    await settle();
    expect(h.awaitStartupSyncs).toHaveBeenCalled();
    expect(h.db.reads).toBe(0);

    // The released backfill lands a multisport race day, then settles.
    const raceDay = new Date();
    raceDay.setMonth(raceDay.getMonth() - 2);
    h.db.rows = [{
      garmin_id: 'strava-123', activity_type: 'TRIATHLON',
      start_time: raceDay.toISOString(), duration_sec: 5 * 3600, distance_m: 113000,
    }];
    h.finishSyncs();
    await settle();

    expect(h.db.reads).toBe(1);
    expect(document.getElementById('tpr-scan-hint')?.textContent).toContain('Found 1 candidate');
  });
});
