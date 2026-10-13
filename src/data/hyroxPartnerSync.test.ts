// @vitest-environment jsdom
/**
 * HYROX Doubles partner sync: pushes only while linked, debounced after
 * saves, skips unchanged snapshots, and never writes a state that is not
 * stamped as the signed-in user's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
  getUserId: async () => { throw new Error('SESSION_EXPIRED'); },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
}));

import { getDefaultState, setState } from '@/state/store';
import { setLocalStateOwner } from './planSettingsSync';
import { HYROX_HOURS_RANGE, HYROX_MTL_CAP, HYROX_WEEKLY_SESSIONS } from '@/constants/hyrox-constants';
import {
  flushHyroxPartnerSnapshot,
  getHyroxPartnerCache,
  refreshHyroxPartnerCache,
  scheduleHyroxPartnerSnapshotSync,
  setHyroxPartnerCache,
  syncHyroxPartnerOnLaunch,
  _resetHyroxPartnerSyncForTests,
} from './hyroxPartnerSync';
import type { HyroxPartnerSource, PartnerResult } from './hyroxPartner';
import type { SimulatorState } from '@/types/state';

function seedHyrox(over: Partial<SimulatorState> = {}): void {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.v = 50;
  s.biologicalSex = 'male';
  s.hyroxConfig = {
    format: 'open_doubles', division: 'men', athleteBand: band, hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0, mtlCap: HYROX_MTL_CAP[band], mtlHistory: [],
    runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
    stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
    bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
    weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
    stationBenchmarksSingles: { ski_erg: 270 },
  };
  Object.assign(s, over);
  setState(s);
}

const ok = <T>(value: T): PartnerResult<T> => ({ ok: true, value });

function mockSource(linked: boolean): HyroxPartnerSource & { upsertMySnapshot: ReturnType<typeof vi.fn> } {
  return {
    createInvite: vi.fn(),
    getOpenInvite: vi.fn(),
    redeemInvite: vi.fn(),
    unlink: vi.fn(),
    getLink: vi.fn(async () => ok(linked ? { partnerId: 'user-b', createdAt: 't' } : null)),
    getPartnerSnapshot: vi.fn(async () => ok(null)),
    upsertMySnapshot: vi.fn(async () => ok(undefined)),
  } as unknown as HyroxPartnerSource & { upsertMySnapshot: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  _resetHyroxPartnerSyncForTests();
  localStorage.clear();
  setLocalStateOwner('user-a');
  seedHyrox();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('partner snapshot sync', () => {
  it('launch: linked pushes the snapshot under the stamped owner; unlinked pushes nothing', async () => {
    const linked = mockSource(true);
    await syncHyroxPartnerOnLaunch(linked);
    expect(getHyroxPartnerCache()).toEqual({ linked: true, initials: null });
    expect(linked.upsertMySnapshot).toHaveBeenCalledTimes(1);
    const [snap, opts] = linked.upsertMySnapshot.mock.calls[0];
    expect(opts).toEqual({ expectUserId: 'user-a' });
    expect(snap.format).toBe('open_doubles');

    _resetHyroxPartnerSyncForTests();
    const unlinked = mockSource(false);
    await syncHyroxPartnerOnLaunch(unlinked);
    expect(getHyroxPartnerCache()).toEqual({ linked: false });
    expect(unlinked.upsertMySnapshot).not.toHaveBeenCalled();
  });

  it('launch outside HYROX mode does nothing', async () => {
    seedHyrox({ eventType: 'marathon' as SimulatorState['eventType'] });
    const src = mockSource(true);
    await syncHyroxPartnerOnLaunch(src);
    expect(src.getLink).not.toHaveBeenCalled();
  });

  it('no owner stamp (state not yet the signed-in user\'s): no push', async () => {
    setLocalStateOwner(null);
    const src = mockSource(true);
    expect(await flushHyroxPartnerSnapshot({ source: src })).toBe(false);
    expect(src.upsertMySnapshot).not.toHaveBeenCalled();
  });

  it('an unchanged snapshot is not pushed twice unless forced', async () => {
    const src = mockSource(true);
    setHyroxPartnerCache({ linked: true });
    expect(await flushHyroxPartnerSnapshot({ source: src })).toBe(true);
    expect(await flushHyroxPartnerSnapshot({ source: src })).toBe(true);
    expect(src.upsertMySnapshot).toHaveBeenCalledTimes(1);
    await flushHyroxPartnerSnapshot({ source: src, force: true });
    expect(src.upsertMySnapshot).toHaveBeenCalledTimes(2);
  });

  it('saveState hook: a no-op while unlinked or unchecked; debounced while linked', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    scheduleHyroxPartnerSnapshotSync();
    expect(spy).not.toHaveBeenCalled();
    setHyroxPartnerCache({ linked: false });
    scheduleHyroxPartnerSnapshotSync();
    expect(spy).not.toHaveBeenCalled();
    setHyroxPartnerCache({ linked: true });
    scheduleHyroxPartnerSnapshotSync();
    scheduleHyroxPartnerSnapshotSync();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    spy.mockRestore();
  });

  it('unlinking clears a pending push', () => {
    vi.useFakeTimers();
    setHyroxPartnerCache({ linked: true });
    scheduleHyroxPartnerSnapshotSync();
    expect(vi.getTimerCount()).toBe(1);
    setHyroxPartnerCache({ linked: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failed link check keeps the cache as it was', async () => {
    setHyroxPartnerCache({ linked: true, initials: 'MK' });
    const src = mockSource(true);
    (src.getLink as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'offline' });
    expect(await refreshHyroxPartnerCache(src)).toEqual({ linked: true, initials: 'MK' });
  });
});
