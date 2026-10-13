// @vitest-environment jsdom
/**
 * HYROX Doubles partner sync: doubles mode only; pushes only while linked,
 * debounced after saves, skips unchanged snapshots, never writes a state that
 * is not stamped as the signed-in user's; re-reads the link on foreground
 * when a code is out or a link exists; deletes the athlete's own snapshot
 * when they leave doubles mode; stops pushing when the server refuses a
 * write for want of a link; and runs the Reset plan / Wipe everything
 * partner cleanup, with a pending flag retried until it succeeds.
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
  cleanUpHyroxPartnerOnReset,
  flushHyroxPartnerSnapshot,
  getHyroxPartnerCache,
  hasPendingHyroxPartnerCleanup,
  HYROX_PARTNER_PENDING_KEY,
  partnerBlockedByPendingCleanup,
  resolvePendingHyroxPartnerCleanup,
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
    // As the live source: refused unless the session user is the expected one.
    removeAllMyPartnerData: vi.fn(async (opts?: { expectUserId?: string }) =>
      (opts?.expectUserId && opts.expectUserId !== 'user-a' ? { ok: false, error: 'no_session' } : ok(undefined))),
    sessionUserId: vi.fn(async () => 'user-a'),
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

  it('a push refused for want of a link flips the cache to unlinked and stops pushing', async () => {
    vi.useFakeTimers();
    const src = mockSource(true);
    src.upsertMySnapshot.mockResolvedValueOnce({ ok: false, error: 'not_linked' });
    setHyroxPartnerCache({ linked: true, since: 't', initials: 'MK' });
    scheduleHyroxPartnerSnapshotSync();
    expect(await flushHyroxPartnerSnapshot({ source: src })).toBe(false);
    expect(getHyroxPartnerCache()).toEqual({ linked: false, inviteExpiresAt: null });
    // The pending debounced push is dropped and later saves schedule none.
    expect(vi.getTimerCount()).toBe(0);
    scheduleHyroxPartnerSnapshotSync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('any other failed push keeps the cache linked', async () => {
    const src = mockSource(true);
    src.upsertMySnapshot.mockResolvedValueOnce({ ok: false, error: 'offline' });
    setHyroxPartnerCache({ linked: true, since: 't' });
    expect(await flushHyroxPartnerSnapshot({ source: src })).toBe(false);
    expect(getHyroxPartnerCache()?.linked).toBe(true);
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

describe('Reset plan and Wipe everything', () => {
  const pendingFlag = () => JSON.parse(localStorage.getItem(HYROX_PARTNER_PENDING_KEY) ?? 'null');

  it('wipe: ends the link and deletes snapshot and code under the owner stamp; the flag clears on success', async () => {
    const src = mockSource(true);
    setHyroxPartnerCache({ linked: true, since: 't' });
    await cleanUpHyroxPartnerOnReset('wipe', src);
    expect(src.removeAllMyPartnerData).toHaveBeenCalledWith({ expectUserId: 'user-a' });
    expect(src.removeMySnapshot).not.toHaveBeenCalled();
    expect(pendingFlag()).toBeNull();
    expect(getHyroxPartnerCache()).toBeUndefined();
  });

  it('wipe offline: the flag stays for the next launch, which retries and clears it', async () => {
    const src = mockSource(true);
    src.removeAllMyPartnerData.mockResolvedValueOnce({ ok: false, error: 'offline' });
    await cleanUpHyroxPartnerOnReset('wipe', src);
    expect(pendingFlag()).toEqual([{ userId: 'user-a', action: 'wipe' }]);
    // Next launch: a fresh module state reads the flag from storage.
    _resetHyroxPartnerSyncForTests();
    seedHyrox({ eventType: 'running' as SimulatorState['eventType'], hyroxConfig: undefined });
    await resolvePendingHyroxPartnerCleanup(src);
    expect(src.removeAllMyPartnerData).toHaveBeenCalledTimes(2);
    expect(src.removeAllMyPartnerData).toHaveBeenLastCalledWith({ expectUserId: 'user-a' });
    expect(hasPendingHyroxPartnerCleanup()).toBe(false);
    expect(pendingFlag()).toBeNull();
  });

  it('no owner stamp: the session user is recorded; no session at all: nothing is recorded', async () => {
    setLocalStateOwner(null);
    const src = mockSource(true);
    src.removeAllMyPartnerData.mockResolvedValueOnce({ ok: false, error: 'offline' });
    await cleanUpHyroxPartnerOnReset('wipe', src);
    expect(pendingFlag()).toEqual([{ userId: 'user-a', action: 'wipe' }]);

    _resetHyroxPartnerSyncForTests();
    localStorage.clear();
    const none = mockSource(true);
    none.sessionUserId.mockResolvedValueOnce(null);
    await cleanUpHyroxPartnerOnReset('wipe', none);
    expect(none.removeAllMyPartnerData).not.toHaveBeenCalled();
    expect(pendingFlag()).toBeNull();
  });

  it('a flag for another account waits for that account: no request, the flag kept', async () => {
    localStorage.setItem(HYROX_PARTNER_PENDING_KEY, JSON.stringify([{ userId: 'user-z', action: 'wipe' }]));
    const src = mockSource(true);
    await resolvePendingHyroxPartnerCleanup(src);
    expect(src.removeAllMyPartnerData).not.toHaveBeenCalled();
    expect(pendingFlag()).toEqual([{ userId: 'user-z', action: 'wipe' }]);
    expect(hasPendingHyroxPartnerCleanup('user-z')).toBe(true);
    expect(hasPendingHyroxPartnerCleanup('user-a')).toBe(false);
  });

  it('another account\'s flag does not block the signed-in account', async () => {
    // A single entry, as a flag written before entries were kept per account.
    localStorage.setItem(HYROX_PARTNER_PENDING_KEY, JSON.stringify({ userId: 'user-z', action: 'wipe' }));
    const src = mockSource(true);
    expect(await partnerBlockedByPendingCleanup(src)).toBe(false);
    await syncHyroxPartnerOnLaunch(src);
    expect(src.getLink).toHaveBeenCalled();
    expect(src.upsertMySnapshot).toHaveBeenCalledWith(expect.anything(), { expectUserId: 'user-a' });
    expect(hasPendingHyroxPartnerCleanup('user-z')).toBe(true);
  });

  it('another account\'s Reset plan is not decided by the signed-in account\'s setup', async () => {
    // user-a is in HYROX doubles with setup finished: that would keep a link,
    // but the decision belongs to user-z's own rebuilt state.
    localStorage.setItem(HYROX_PARTNER_PENDING_KEY, JSON.stringify({ userId: 'user-z', action: 'reset' }));
    seedHyrox({ hasCompletedOnboarding: true });
    const src = mockSource(true);
    _setHyroxPartnerSyncSourceForTests(src);
    await resolvePendingHyroxPartnerCleanup(src);
    scheduleHyroxPartnerSnapshotSync();
    await settle();
    expect(src.removeAllMyPartnerData).not.toHaveBeenCalled();
    expect(localStorage.getItem(HYROX_PARTNER_PENDING_KEY)).not.toBeNull();
    expect(hasPendingHyroxPartnerCleanup('user-z')).toBe(true);
  });

  it('flags are kept per account: a new reset does not drop another account\'s flag', async () => {
    localStorage.setItem(HYROX_PARTNER_PENDING_KEY, JSON.stringify([{ userId: 'user-z', action: 'wipe' }]));
    const src = mockSource(true);
    src.removeAllMyPartnerData.mockResolvedValueOnce({ ok: false, error: 'offline' });
    await cleanUpHyroxPartnerOnReset('wipe', src);
    expect(pendingFlag()).toEqual([{ userId: 'user-z', action: 'wipe' }, { userId: 'user-a', action: 'wipe' }]);
    // Online again: user-a's entry clears, user-z's stays.
    await resolvePendingHyroxPartnerCleanup(src);
    expect(src.removeAllMyPartnerData).toHaveBeenLastCalledWith({ expectUserId: 'user-a' });
    expect(pendingFlag()).toEqual([{ userId: 'user-z', action: 'wipe' }]);
  });

  it('a wipe still owed stays a wipe when a Reset plan follows', async () => {
    const src = mockSource(true);
    src.removeAllMyPartnerData.mockResolvedValueOnce({ ok: false, error: 'offline' });
    await cleanUpHyroxPartnerOnReset('wipe', src);
    await cleanUpHyroxPartnerOnReset('reset', src);
    expect(pendingFlag()).toEqual([{ userId: 'user-a', action: 'wipe' }]);
  });

  it('the flag is written at the call, before any await (the partner chunk may not load offline)', async () => {
    const src = mockSource(true);
    src.removeAllMyPartnerData.mockResolvedValueOnce({ ok: false, error: 'offline' });
    _setHyroxPartnerSyncSourceForTests(src);
    const run = cleanUpHyroxPartnerOnReset('wipe');
    expect(pendingFlag()).toEqual([{ userId: 'user-a', action: 'wipe' }]);
    await run;
    expect(pendingFlag()).toEqual([{ userId: 'user-a', action: 'wipe' }]);
  });

  it('reset in doubles: the snapshot goes now, the link waits for the new setup', async () => {
    const src = mockSource(true);
    await cleanUpHyroxPartnerOnReset('reset', src);
    expect(src.removeMySnapshot).toHaveBeenCalledWith({ expectUserId: 'user-a' });
    expect(src.removeAllMyPartnerData).not.toHaveBeenCalled();
    expect(pendingFlag()).toEqual([{ userId: 'user-a', action: 'reset' }]);
  });

  it('reset outside doubles: no snapshot request, the decision still waits', async () => {
    seedHyrox({ eventType: 'running' as SimulatorState['eventType'], hyroxConfig: undefined });
    const src = mockSource(false);
    await cleanUpHyroxPartnerOnReset('reset', src);
    expect(src.removeMySnapshot).not.toHaveBeenCalled();
    expect(pendingFlag()).toEqual([{ userId: 'user-a', action: 'reset' }]);
  });

  it('reset decision: waits while setup is unfinished; doubles again keeps the link; anything else unlinks', async () => {
    const src = mockSource(true);
    localStorage.setItem(HYROX_PARTNER_PENDING_KEY, JSON.stringify({ userId: 'user-a', action: 'reset' }));
    // Setup not finished (the wizard after the reload).
    seedHyrox({ eventType: 'running' as SimulatorState['eventType'], hyroxConfig: undefined, hasCompletedOnboarding: false });
    await resolvePendingHyroxPartnerCleanup(src);
    expect(src.removeAllMyPartnerData).not.toHaveBeenCalled();
    expect(hasPendingHyroxPartnerCleanup()).toBe(true);

    // Finished in HYROX doubles: the link stays, the flag clears.
    seedHyrox({ hasCompletedOnboarding: true });
    await resolvePendingHyroxPartnerCleanup(src);
    expect(src.removeAllMyPartnerData).not.toHaveBeenCalled();
    expect(hasPendingHyroxPartnerCleanup()).toBe(false);

    // Finished in singles: as a wipe.
    _resetHyroxPartnerSyncForTests();
    localStorage.setItem(HYROX_PARTNER_PENDING_KEY, JSON.stringify({ userId: 'user-a', action: 'reset' }));
    seedHyrox({ hasCompletedOnboarding: true });
    getStateHx().format = 'open_singles';
    await resolvePendingHyroxPartnerCleanup(src);
    expect(src.removeAllMyPartnerData).toHaveBeenCalledWith({ expectUserId: 'user-a' });
    expect(hasPendingHyroxPartnerCleanup()).toBe(false);
  });

  it('the save that finishes setup settles a Reset plan decision once per session', async () => {
    const src = mockSource(true);
    _setHyroxPartnerSyncSourceForTests(src);
    src.removeAllMyPartnerData.mockResolvedValue({ ok: false, error: 'offline' });
    localStorage.setItem(HYROX_PARTNER_PENDING_KEY, JSON.stringify({ userId: 'user-a', action: 'reset' }));
    seedHyrox({ eventType: 'running' as SimulatorState['eventType'], hyroxConfig: undefined, hasCompletedOnboarding: false });
    scheduleHyroxPartnerSnapshotSync(); // mid-wizard save
    await settle();
    expect(src.removeAllMyPartnerData).not.toHaveBeenCalled();
    getState().hasCompletedOnboarding = true;
    scheduleHyroxPartnerSnapshotSync(); // setup finished, outside doubles
    scheduleHyroxPartnerSnapshotSync();
    await settle();
    expect(src.removeAllMyPartnerData).toHaveBeenCalledTimes(1);
    expect(hasPendingHyroxPartnerCleanup()).toBe(true); // offline: left for the next launch
  });

  it('back in doubles after a Reset plan: the finishing save reads the link and pushes', async () => {
    const src = mockSource(true);
    _setHyroxPartnerSyncSourceForTests(src);
    localStorage.setItem(HYROX_PARTNER_PENDING_KEY, JSON.stringify({ userId: 'user-a', action: 'reset' }));
    seedHyrox({ hasCompletedOnboarding: true });
    scheduleHyroxPartnerSnapshotSync();
    await settle();
    expect(hasPendingHyroxPartnerCleanup()).toBe(false);
    expect(src.removeAllMyPartnerData).not.toHaveBeenCalled();
    expect(src.getLink).toHaveBeenCalled();
    expect(src.upsertMySnapshot).toHaveBeenCalledTimes(1);
  });

  it('while a cleanup stands the sync reads and writes nothing for the partner', async () => {
    const src = mockSource(true);
    src.removeAllMyPartnerData.mockResolvedValue({ ok: false, error: 'unknown' });
    localStorage.setItem(HYROX_PARTNER_PENDING_KEY, JSON.stringify({ userId: 'user-a', action: 'wipe' }));
    seedHyrox({ hasCompletedOnboarding: true });
    expect(await partnerBlockedByPendingCleanup(src)).toBe(true);
    await syncHyroxPartnerOnLaunch(src);
    expect(src.getLink).not.toHaveBeenCalled();
    expect(src.upsertMySnapshot).not.toHaveBeenCalled();
    expect(getHyroxPartnerCache()).toBeUndefined();
    // Once the cleanup lands, the next check reads the link again.
    src.removeAllMyPartnerData.mockResolvedValue({ ok: true, value: undefined });
    expect(await partnerBlockedByPendingCleanup(src)).toBe(false);
  });

  it('nothing pending: no request and no block', async () => {
    const src = mockSource(true);
    await resolvePendingHyroxPartnerCleanup(src);
    expect(await partnerBlockedByPendingCleanup(src)).toBe(false);
    expect(src.removeAllMyPartnerData).not.toHaveBeenCalled();
  });
});
