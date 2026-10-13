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
 *     doubles mode (a format change through a rebuild, a switch to another
 *     sport, a wipe) and deletes their own snapshot then;
 *   - the Partner page pushes right after linking and on open, and polls the
 *     link only while a code is on screen.
 *
 * A push is skipped when the snapshot is unchanged since the last push, and
 * refused when the local state is not stamped as the signed-in user's
 * (getLocalStateOwner), so a stale in-memory state from a previous account can
 * never be written under a new one (the 2026-08-04 cross-account incident).
 * The same stamp guards the leaving-doubles delete.
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

/** Called from saveState(). Cheap no-op unless linked in doubles mode, or
 *  the athlete has just left doubles mode. */
export function scheduleHyroxPartnerSnapshotSync(): void {
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
  if (timer) { clearTimeout(timer); timer = null; }
}
