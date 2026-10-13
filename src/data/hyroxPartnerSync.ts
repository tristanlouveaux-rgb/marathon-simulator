/**
 * HYROX Doubles partner: keep this athlete's snapshot fresh while linked.
 *
 * Hooks:
 *   - launch (main.ts, HYROX block): syncHyroxPartnerOnLaunch() reads the link
 *     once, caches it for the session and pushes the snapshot when linked;
 *   - every saveState() (persistence.ts): scheduleHyroxPartnerSnapshotSync()
 *     debounces a push after benchmark, run-pace or forecast changes. It
 *     returns at once unless the session cache says linked, so unlinked users
 *     and every other mode pay nothing;
 *   - the Partner page pushes right after linking and on open.
 *
 * A push is skipped when the snapshot is unchanged since the last push, and
 * refused when the local state is not stamped as the signed-in user's
 * (getLocalStateOwner), so a stale in-memory state from a previous account can
 * never be written under a new one (the 2026-08-04 cross-account incident).
 *
 * Static imports stay light (store + owner stamp): the snapshot builder and
 * the Supabase calls load on first use.
 */

import { getState } from '@/state/store';
import { getLocalStateOwner } from './planSettingsSync';
import type { HyroxPartnerSource } from './hyroxPartner';

export interface HyroxPartnerCache {
  linked: boolean;
  /** The partner's initials once their snapshot has been read. */
  initials?: string | null;
}

/** Session cache of the link state; undefined until checked this session. */
let cache: HyroxPartnerCache | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPushed: string | null = null;

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
}

async function liveSource(): Promise<HyroxPartnerSource> {
  return (await import('./hyroxPartner')).hyroxPartnerSource;
}

function inHyroxMode(): boolean {
  const s = getState();
  return s.eventType === 'hyrox' && !!s.hyroxConfig;
}

/** Called from saveState(). Cheap no-op unless linked in HYROX mode. */
export function scheduleHyroxPartnerSnapshotSync(): void {
  if (!cache?.linked || !inHyroxMode()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushHyroxPartnerSnapshot();
  }, PUSH_DEBOUNCE_MS);
}

/** Build and push the snapshot now. Returns true when the server holds the
 *  current snapshot. */
export async function flushHyroxPartnerSnapshot(
  opts: { source?: HyroxPartnerSource; force?: boolean } = {},
): Promise<boolean> {
  try {
    if (!inHyroxMode()) return false;
    let owner: string | null = null;
    try { owner = getLocalStateOwner(); } catch { owner = null; }
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
 *  cache. Leaves the cache untouched when offline or signed out. */
export async function refreshHyroxPartnerCache(source?: HyroxPartnerSource): Promise<HyroxPartnerCache | undefined> {
  try {
    const src = source ?? await liveSource();
    const link = await src.getLink();
    if (!link.ok) return cache;
    if (!link.value) {
      setHyroxPartnerCache({ linked: false });
      return cache;
    }
    const partner = await src.getPartnerSnapshot();
    setHyroxPartnerCache({
      linked: true,
      initials: partner.ok ? (partner.value?.snapshot.initials ?? null) : (cache?.initials ?? null),
    });
    return cache;
  } catch (e) {
    console.warn('[hyroxPartnerSync] link check failed:', e);
    return cache;
  }
}

/** Launch hook: refresh the cache, then push when linked. */
export async function syncHyroxPartnerOnLaunch(source?: HyroxPartnerSource): Promise<void> {
  if (!inHyroxMode()) return;
  const src = source ?? await liveSource();
  const c = await refreshHyroxPartnerCache(src);
  if (c?.linked) await flushHyroxPartnerSnapshot({ source: src, force: true });
}

/** Test seam: forget the session cache and pending push. */
export function _resetHyroxPartnerSyncForTests(): void {
  cache = undefined;
  lastPushed = null;
  if (timer) { clearTimeout(timer); timer = null; }
}
