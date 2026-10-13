// @vitest-environment jsdom
/**
 * HYROX Doubles partner sync: doubles mode only; pushes only while linked,
 * debounced after saves, skips unchanged snapshots, never writes a state that
 * is not stamped as the signed-in user's; re-reads the link on foreground
 * when a code is out or a link exists; deletes the athlete's own snapshot
 * when they leave doubles mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
  getUserId: async () => { throw new Error('SESSION_EXPIRED'); },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
}));

import { getDefaultState, getState, setState } from '@/state/store';
import { setLocalStateOwner } from './planSettingsSync';
import { HYROX_HOURS_RANGE, HYROX_MTL_CAP, HYROX_WEEKLY_SESSIONS } from '@/constants/hyrox-constants';
import {
  flushHyroxPartnerSnapshot,
  getHyroxPartnerCache,
  refreshHyroxPartnerCache,
  refreshHyroxPartnerOnForeground,
  scheduleHyroxPartnerSnapshotSync,
  setHyroxPartnerCache,
  setHyroxPartnerCacheListener,
  syncHyroxPartnerOnLaunch,
  _resetHyroxPartnerSyncForTests,
  _setHyroxPartnerSyncSourceForTests,
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
const getStateHx = () => getState().hyroxConfig!;

type MockFns = Record<keyof HyroxPartnerSource, ReturnType<typeof vi.fn>>;

function mockSource(linked: boolean, invite: { code: string; expiresAt: string } | null = null): HyroxPartnerSource & MockFns {
  return {
    createInvite: vi.fn(),
    getOpenInvite: vi.fn(async () => ok(invite)),
    redeemInvite: vi.fn(),
    unlink: vi.fn(),
    getLink: vi.fn(async () => ok(linked ? { partnerId: 'user-b', createdAt: 't' } : null)),
    getPartnerSnapshot: vi.fn(async () => ok(null)),
    upsertMySnapshot: vi.fn(async () => ok(undefined)),
    removeMySnapshot: vi.fn(async () => ok(undefined)),
  } as unknown as HyroxPartnerSource & MockFns;
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
const inAnHour = () => new Date(Date.now() + 3600e3).toISOString();

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
    expect(getHyroxPartnerCache()).toEqual({ linked: true, since: 't', initials: null });
    expect(linked.upsertMySnapshot).toHaveBeenCalledTimes(1);
    const [snap, opts] = linked.upsertMySnapshot.mock.calls[0];
    expect(opts).toEqual({ expectUserId: 'user-a' });
    expect(snap.format).toBe('open_doubles');

    _resetHyroxPartnerSyncForTests();
    const expiresAt = inAnHour();
    const unlinked = mockSource(false, { code: 'ABCDEFGH', expiresAt });
    await syncHyroxPartnerOnLaunch(unlinked);
    // Unlinked: the launch also learns whether a code is out (for the foreground hook).
    expect(getHyroxPartnerCache()).toEqual({ linked: false, inviteExpiresAt: expiresAt });
    expect(unlinked.upsertMySnapshot).not.toHaveBeenCalled();
  });

  it('launch outside HYROX mode, or in HYROX singles, does nothing (doubles only, as the Partner row)', async () => {
    seedHyrox({ eventType: 'marathon' as SimulatorState['eventType'] });
    const src = mockSource(true);
    await syncHyroxPartnerOnLaunch(src);
    seedHyrox();
    getStateHx().format = 'open_singles';
    await syncHyroxPartnerOnLaunch(src);
    expect(src.getLink).not.toHaveBeenCalled();
    expect(await flushHyroxPartnerSnapshot({ source: src, force: true })).toBe(false);
    expect(src.upsertMySnapshot).not.toHaveBeenCalled();
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
    src.getLink.mockResolvedValueOnce({ ok: false, error: 'offline' });
    expect(await refreshHyroxPartnerCache(src)).toEqual({ linked: true, initials: 'MK' });
  });
});

describe('leaving doubles mode', () => {
  it('deletes the athlete\'s own snapshot under the owner stamp, once, on the save that leaves doubles', async () => {
    const src = mockSource(true);
    _setHyroxPartnerSyncSourceForTests(src);
    setHyroxPartnerCache({ linked: true });
    scheduleHyroxPartnerSnapshotSync(); // doubles seen
    getStateHx().format = 'open_singles';
    scheduleHyroxPartnerSnapshotSync(); // left doubles
    scheduleHyroxPartnerSnapshotSync(); // still singles: nothing more
    await settle();
    expect(src.removeMySnapshot).toHaveBeenCalledTimes(1);
    expect(src.removeMySnapshot).toHaveBeenCalledWith({ expectUserId: 'user-a' });
  });

  it('a switch to another sport counts; a pending push is dropped', async () => {
    vi.useFakeTimers();
    const src = mockSource(true);
    _setHyroxPartnerSyncSourceForTests(src);
    setHyroxPartnerCache({ linked: true });
    scheduleHyroxPartnerSnapshotSync();
    expect(vi.getTimerCount()).toBe(1);
    seedHyrox({ eventType: 'running' as SimulatorState['eventType'], hyroxConfig: undefined });
    scheduleHyroxPartnerSnapshotSync();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    await settle();
    expect(src.removeMySnapshot).toHaveBeenCalledTimes(1);
    expect(src.upsertMySnapshot).not.toHaveBeenCalled();
  });

  it('never on the first save of a session, and never without an owner stamp', async () => {
    const src = mockSource(true);
    _setHyroxPartnerSyncSourceForTests(src);
    getStateHx().format = 'open_singles';
    scheduleHyroxPartnerSnapshotSync(); // first observation is singles: unknown history
    await settle();
    expect(src.removeMySnapshot).not.toHaveBeenCalled();

    _resetHyroxPartnerSyncForTests();
    _setHyroxPartnerSyncSourceForTests(src);
    seedHyrox();
    scheduleHyroxPartnerSnapshotSync();
    setLocalStateOwner(null);
    getStateHx().format = 'pro_singles';
    scheduleHyroxPartnerSnapshotSync();
    await settle();
    expect(src.removeMySnapshot).not.toHaveBeenCalled();
  });
});

describe('foreground refresh', () => {
  it('does nothing before the launch check, when unlinked with no code out, or with an expired code', async () => {
    const src = mockSource(true);
    await refreshHyroxPartnerOnForeground(src);
    setHyroxPartnerCache({ linked: false, inviteExpiresAt: null });
    await refreshHyroxPartnerOnForeground(src);
    setHyroxPartnerCache({ linked: false, inviteExpiresAt: new Date(Date.now() - 1000).toISOString() });
    await refreshHyroxPartnerOnForeground(src);
    expect(src.getLink).not.toHaveBeenCalled();
  });

  it('a code out and the partner redeemed it: cache flips to linked and the snapshot is pushed', async () => {
    const src = mockSource(true);
    const seen: Array<boolean | undefined> = [];
    setHyroxPartnerCacheListener(c => seen.push(c?.linked));
    setHyroxPartnerCache({ linked: false, inviteExpiresAt: inAnHour() });
    await refreshHyroxPartnerOnForeground(src);
    expect(getHyroxPartnerCache()).toEqual({ linked: true, since: 't', initials: null });
    expect(src.upsertMySnapshot).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([false, true]);
  });

  it('linked and the partner unlinked: cache flips to unlinked, nothing is pushed', async () => {
    const src = mockSource(false);
    setHyroxPartnerCache({ linked: true, since: 't', initials: 'MK' });
    await refreshHyroxPartnerOnForeground(src);
    expect(getHyroxPartnerCache()).toEqual({ linked: false, inviteExpiresAt: null });
    expect(src.upsertMySnapshot).not.toHaveBeenCalled();
  });

  it('linked and still the same link: no push', async () => {
    const src = mockSource(true);
    setHyroxPartnerCache({ linked: true, since: 't', initials: null });
    await refreshHyroxPartnerOnForeground(src);
    expect(src.getLink).toHaveBeenCalledTimes(1);
    expect(src.upsertMySnapshot).not.toHaveBeenCalled();
  });

  it('outside doubles mode it does nothing', async () => {
    const src = mockSource(true);
    setHyroxPartnerCache({ linked: true, since: 't' });
    getStateHx().format = 'open_singles';
    await refreshHyroxPartnerOnForeground(src);
    expect(src.getLink).not.toHaveBeenCalled();
  });
});
