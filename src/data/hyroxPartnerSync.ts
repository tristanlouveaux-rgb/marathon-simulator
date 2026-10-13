/**
 * HYROX Doubles partner: keep this athlete's snapshot fresh while linked.
 *
 * Every hook is gated to HYROX doubles mode (eventType 'hyrox' with a doubles
 * format), matching the Partner entry point, which appears in doubles only.
 *
 * Hooks:
 *   - launch (main.ts, HYROX block): syncHyroxPartnerOnLaunch() reads the link
 *     (and, when unlinked, whether a code is out), caches it for the session
 *     and pushes the snapshot when linked;
 *   - app foreground (main.ts visibilitychange): refreshHyroxPartnerOnForeground()
 *     re-reads the link only when a code is out or a link exists, so a partner
 *     redeeming a code, or unlinking, is picked up on resume without opening
 *     the Partner page. A new link pushes the snapshot at once;
 *   - every saveState() (persistence.ts): scheduleHyroxPartnerSnapshotSync()
 *     debounces a push after benchmark, run-pace or forecast changes. It
 *     returns at once unless the session cache says linked, so unlinked users
 *     and every other mode pay nothing. It also notices the athlete leaving
 *     doubles mode in place (Account > Edit settings: a format change, or a
 *     switch to another sport) and deletes their own snapshot then; the link
 *     stays, so a temporary format change does not cost the pair their link;
 *   - Reset plan and Wipe everything (events.ts): cleanUpHyroxPartnerOnReset()
 *     runs before the local reset (rules below);
 *   - the Partner page pushes right after linking and on open, and polls the
 *     link only while a code is on screen.
 *
 * Reset rules (softResetState replaces the state with defaults, so neither
 * path passes through the leaving-doubles check):
 *   - Wipe everything ends the link and deletes the athlete's snapshot and
 *     code (removeAllMyPartnerData), whatever mode they were in;
 *   - Reset plan deletes the snapshot at once when the athlete was in doubles
 *     (the rebuilt state has no HYROX numbers until setup ends). The link
 *     waits for the new setup: finished in HYROX doubles, the link stays and
 *     the next push restores the snapshot; finished in anything else, the
 *     cleanup runs as for a wipe.
 * Both record a pending flag (HYROX_PARTNER_PENDING_KEY, with the account id)
 * before any request, cleared only once the server cleanup succeeds. Offline,
 * the reset does not wait: the flag is retried at the next launch
 * (resolvePendingHyroxPartnerCleanup, main.ts), and while it stands the sync
 * and the Partner page read and write nothing, so a new snapshot never
 * reaches the old partner. A flag for another account waits for that
 * account to sign in again.
 *
 * A push is skipped when the snapshot is unchanged since the last push, and
 * refused when the local state is not stamped as the signed-in user's
 * (getLocalStateOwner), so a stale in-memory state from a previous account can
 * never be written under a new one (the 2026-08-04 cross-account incident).
 * The same stamp guards the leaving-doubles delete. The server refuses a
 * snapshot write from a user with no link (42501, read as 'not_linked'): the
 * cache then flips to unlinked and pushes stop.
 *
 * Static imports stay light (store, owner stamp, the doubles-format check):
 * the snapshot builder and the Supabase calls load on first use.
 */

import { getState } from '@/state/store';
import { isHyroxDoublesFormat } from '@/calculations/hyrox-division';
import { getLocalStateOwner } from './planSettingsSync';
import type { HyroxPartnerSource } from './hyroxPartner';

export interface HyroxPartnerCache {
  linked: boolean;
  /** The partner's initials once their snapshot has been read. */
  initials?: string | null;
  /** Linked: when the link was made, so a different link is noticed. */
  since?: string | null;
  /** Unlinked: expiry of this athlete's open code, or null when none. */
  inviteExpiresAt?: string | null;
}

/** Session cache of the link state; undefined until checked this session. */
let cache: HyroxPartnerCache | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPushed: string | null = null;
/** Whether the last saveState saw doubles mode; undefined before the first. */
let lastSeenDoubles: boolean | undefined;
let foregroundInFlight = false;
let cacheListener: ((next: HyroxPartnerCache | undefined) => void) | null = null;
let sourceForTests: HyroxPartnerSource | null = null;

/** localStorage key of a reset's partner cleanup still owed to the server. */
export const HYROX_PARTNER_PENDING_KEY = 'mosaic_hyrox_partner_cleanup';

export interface PendingHyroxPartnerCleanup {
  /** The account the reset was made in; only that session runs it. */
  userId: string;
  /** 'wipe': end the link, delete the snapshot and code. 'reset': decide once
   *  setup is finished again (doubles keeps the link, else as 'wipe'). */
  action: 'wipe' | 'reset';
}

/** Cached read of the pending flag; undefined until first read. */
let pending: PendingHyroxPartnerCleanup | null | undefined;
let pendingInFlight: Promise<void> | null = null;
/** The saveState hook tries a 'reset' decision once per session. */
let pendingTriedOnSave = false;

/** Debounce after the last saveState before a push. Engineering value: long
 *  enough to coalesce a burst of saves (a session completion writes several),
 *  short enough that the partner sees the change within the same visit. */
const PUSH_DEBOUNCE_MS = 4000;

export function getHyroxPartnerCache(): HyroxPartnerCache | undefined {
  return cache;
}

export function setHyroxPartnerCache(next: HyroxPartnerCache | undefined): void {
  cache = next;
  if (!next?.linked) {
    lastPushed = null;
    if (timer) { clearTimeout(timer); timer = null; }
  }
  try { cacheListener?.(next); } catch { /* a view's listener never breaks the sync */ }
}

/** One listener for cache changes (the Stats Partner row label). Setting a
 *  new one replaces the old, so re-rendering a view never stacks listeners. */
export function setHyroxPartnerCacheListener(fn: ((next: HyroxPartnerCache | undefined) => void) | null): void {
  cacheListener = fn;
}

async function liveSource(): Promise<HyroxPartnerSource> {
  return sourceForTests ?? (await import('./hyroxPartner')).hyroxPartnerSource;
}

/** HYROX mode with a doubles format: the only mode with a partner. */
export function inHyroxDoublesMode(): boolean {
  const s = getState();
  return s.eventType === 'hyrox' && !!s.hyroxConfig && isHyroxDoublesFormat(s.hyroxConfig.format);
}

function stateOwner(): string | null {
  try { return getLocalStateOwner(); } catch { return null; }
}

function readPending(): PendingHyroxPartnerCleanup | null {
  if (pending !== undefined) return pending;
  pending = null;
  try {
    const raw = localStorage.getItem(HYROX_PARTNER_PENDING_KEY);
    const p = raw ? JSON.parse(raw) as Partial<PendingHyroxPartnerCleanup> : null;
    if (p && typeof p.userId === 'string' && p.userId && (p.action === 'wipe' || p.action === 'reset')) {
      pending = { userId: p.userId, action: p.action };
    }
  } catch { /* unreadable storage: nothing pending */ }
  return pending;
}

function writePending(next: PendingHyroxPartnerCleanup | null): void {
  pending = next;
  try {
    if (next) localStorage.setItem(HYROX_PARTNER_PENDING_KEY, JSON.stringify(next));
    else localStorage.removeItem(HYROX_PARTNER_PENDING_KEY);
  } catch { /* storage unavailable: the flag lives for this session only */ }
}

/** True while a reset's partner cleanup is still owed to the server. */
export function hasPendingHyroxPartnerCleanup(): boolean {
  return readPending() != null;
}

/**
 * Reset plan / Wipe everything (events.ts), called before softResetState:
 * the owner stamp is read first, before softResetState clears it. Records
 * the pending flag, then tries the server step once (see the header rules).
 * Never throws. Offline the requests fail at once, so the reset is not held
 * up; the flag stays for the next launch.
 */
export async function cleanUpHyroxPartnerOnReset(
  kind: 'wipe' | 'reset',
  source?: HyroxPartnerSource,
): Promise<void> {
  const owner = stateOwner();
  const wasDoubles = inHyroxDoublesMode();
  try {
    const src = source ?? await liveSource();
    const userId = owner ?? await src.sessionUserId();
    if (!userId) return;
    writePending({ userId, action: kind });
    setHyroxPartnerCache(undefined);
    if (kind === 'wipe') {
      const res = await src.removeAllMyPartnerData({ expectUserId: userId });
      if (res.ok) writePending(null);
    } else if (wasDoubles) {
      await src.removeMySnapshot({ expectUserId: userId });
    }
  } catch (e) {
    console.warn('[hyroxPartnerSync] reset cleanup failed:', e);
  }
}

/**
 * Run a pending reset cleanup if it can be decided now. 'wipe' always runs;
 * 'reset' waits for setup to finish, then keeps the link when the athlete is
 * in HYROX doubles and runs the full cleanup otherwise. The flag is cleared
 * only on success; a call for another account is refused (no_session) and the
 * flag waits for that account. Concurrent callers share one attempt.
 */
export function resolvePendingHyroxPartnerCleanup(source?: HyroxPartnerSource): Promise<void> {
  const p = readPending();
  if (!p) return Promise.resolve();
  if (pendingInFlight) return pendingInFlight;
  const attempt = async (): Promise<void> => {
    try {
      if (p.action === 'reset') {
        if (!getState().hasCompletedOnboarding) return;
        if (inHyroxDoublesMode()) { writePending(null); return; }
      }
      const src = source ?? await liveSource();
      const res = await src.removeAllMyPartnerData({ expectUserId: p.userId });
      if (res.ok) {
        writePending(null);
        setHyroxPartnerCache({ linked: false, inviteExpiresAt: null });
      }
    } catch (e) {
      console.warn('[hyroxPartnerSync] pending cleanup failed:', e);
    }
  };
  // Cleared in a .finally so it runs after this assignment, even when the
  // attempt returns without awaiting anything.
  const run = attempt().finally(() => { if (pendingInFlight === run) pendingInFlight = null; });
  pendingInFlight = run;
  return run;
}

/** Settle a pending cleanup first; true while it still stands (the partner
 *  feature then reads and writes nothing). */
export async function partnerBlockedByPendingCleanup(source?: HyroxPartnerSource): Promise<boolean> {
  if (!readPending()) return false;
  await resolvePendingHyroxPartnerCleanup(source);
  return readPending() != null;
}

/** Called from saveState(). Cheap no-op unless linked in doubles mode, or
 *  the athlete has just left doubles mode, or a Reset plan's link decision
 *  is due (setup just finished). */
export function scheduleHyroxPartnerSnapshotSync(): void {
  if (readPending()?.action === 'reset' && !pendingTriedOnSave && getState().hasCompletedOnboarding) {
    pendingTriedOnSave = true;
    void resolvePendingHyroxPartnerCleanup().then(() => {
      // Back in doubles after a Reset plan: read the link and push now
      // rather than at the next launch.
      if (!readPending() && cache === undefined && inHyroxDoublesMode()) void syncHyroxPartnerOnLaunch();
    });
  }
  const doubles = inHyroxDoublesMode();
  const leftDoubles = lastSeenDoubles === true && !doubles;
  lastSeenDoubles = doubles;
  if (leftDoubles) {
    void removeOwnSnapshotAfterLeavingDoubles();
    return;
  }
  if (!cache?.linked || !doubles) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushHyroxPartnerSnapshot();
  }, PUSH_DEBOUNCE_MS);
}

/** The athlete left doubles mode: their race numbers serve no partner now,
 *  so their own snapshot is deleted. The link stays; the next push happens
 *  once they are back in doubles (launch, foreground or the Partner page). */
async function removeOwnSnapshotAfterLeavingDoubles(): Promise<boolean> {
  if (timer) { clearTimeout(timer); timer = null; }
  lastPushed = null;
  try {
    const owner = stateOwner();
    if (!owner) return false;
    const res = await (await liveSource()).removeMySnapshot({ expectUserId: owner });
    return res.ok;
  } catch (e) {
    console.warn('[hyroxPartnerSync] snapshot delete failed:', e);
    return false;
  }
}

/** Build and push the snapshot now. Returns true when the server holds the
 *  current snapshot. */
export async function flushHyroxPartnerSnapshot(
  opts: { source?: HyroxPartnerSource; force?: boolean } = {},
): Promise<boolean> {
  try {
    if (!inHyroxDoublesMode()) return false;
    const owner = stateOwner();
    if (!owner) return false;
    const { buildHyroxPartnerSnapshot } = await import('@/calculations/hyrox-partner-snapshot');
    const snapshot = buildHyroxPartnerSnapshot(getState());
    if (!snapshot) return false;
    const signature = JSON.stringify(snapshot);
    if (!opts.force && signature === lastPushed) return true;
    const source = opts.source ?? await liveSource();
    const res = await source.upsertMySnapshot(snapshot, { expectUserId: owner });
    if (res.ok) lastPushed = signature;
    // The server holds no link for this user (the partner unlinked since the
    // cache was filled): stop pushing until a link is read again.
    else if (res.error === 'not_linked') setHyroxPartnerCache({ linked: false, inviteExpiresAt: null });
    return res.ok;
  } catch (e) {
    console.warn('[hyroxPartnerSync] push failed:', e);
    return false;
  }
}

/** Read the link (and the partner's initials when linked) into the session
 *  cache. With `readInvite`, an unlinked read also fetches whether a code is
 *  out; without it the previously known code expiry is kept. Leaves the cache
 *  untouched when offline or signed out. */
export async function refreshHyroxPartnerCache(
  source?: HyroxPartnerSource,
  opts: { readInvite?: boolean } = {},
): Promise<HyroxPartnerCache | undefined> {
  try {
    const src = source ?? await liveSource();
    if (await partnerBlockedByPendingCleanup(src)) return cache;
    const link = await src.getLink();
    if (!link.ok) return cache;
    if (!link.value) {
      let inviteExpiresAt = cache && !cache.linked ? (cache.inviteExpiresAt ?? null) : null;
      if (opts.readInvite) {
        const inv = await src.getOpenInvite();
        if (inv.ok) inviteExpiresAt = inv.value?.expiresAt ?? null;
      }
      setHyroxPartnerCache({ linked: false, inviteExpiresAt });
      return cache;
    }
    const partner = await src.getPartnerSnapshot();
    setHyroxPartnerCache({
      linked: true,
      since: link.value.createdAt,
      initials: partner.ok ? (partner.value?.snapshot.initials ?? null) : (cache?.initials ?? null),
    });
    return cache;
  } catch (e) {
    console.warn('[hyroxPartnerSync] link check failed:', e);
    return cache;
  }
}

/** Launch hook: refresh the cache, then push when linked. Doubles only. */
export async function syncHyroxPartnerOnLaunch(source?: HyroxPartnerSource): Promise<void> {
  if (!inHyroxDoublesMode()) return;
  lastSeenDoubles = true;
  const src = source ?? await liveSource();
  const c = await refreshHyroxPartnerCache(src, { readInvite: true });
  if (c?.linked) await flushHyroxPartnerSnapshot({ source: src, force: true });
}

function waitingOnCode(c: HyroxPartnerCache): boolean {
  if (c.linked || !c.inviteExpiresAt) return false;
  const t = Date.parse(c.inviteExpiresAt);
  return Number.isFinite(t) && t > Date.now();
}

/** Foreground hook: re-read the link when a code is out or a link exists (the
 *  two states another person can change). A link that is new, or different
 *  from the one cached, gets the snapshot pushed at once. Doubles only; a
 *  no-op before the link has been checked this session. */
export async function refreshHyroxPartnerOnForeground(source?: HyroxPartnerSource): Promise<void> {
  const before = cache;
  if (foregroundInFlight || !before || !inHyroxDoublesMode()) return;
  if (!before.linked && !waitingOnCode(before)) return;
  foregroundInFlight = true;
  try {
    const src = source ?? await liveSource();
    const after = await refreshHyroxPartnerCache(src);
    if (after?.linked && (!before.linked || before.since !== after.since)) {
      await flushHyroxPartnerSnapshot({ source: src, force: true });
    }
  } catch (e) {
    console.warn('[hyroxPartnerSync] foreground refresh failed:', e);
  } finally {
    foregroundInFlight = false;
  }
}

/** Test seam: route the internal calls (leaving-doubles delete) to a mock. */
export function _setHyroxPartnerSyncSourceForTests(source: HyroxPartnerSource | null): void {
  sourceForTests = source;
}

/** Test seam: forget the session cache, pending push and listeners. */
export function _resetHyroxPartnerSyncForTests(): void {
  cache = undefined;
  lastPushed = null;
  lastSeenDoubles = undefined;
  foregroundInFlight = false;
  cacheListener = null;
  sourceForTests = null;
  pending = undefined;
  pendingInFlight = null;
  pendingTriedOnSave = false;
  if (timer) { clearTimeout(timer); timer = null; }
}
