/**
 * Screen Wake Lock — keeps the device screen awake during a guided run.
 *
 * Web-only interim solution. The browser releases the lock automatically when
 * the tab hides or the screen locks; this module re-acquires it on the next
 * `visibilitychange` to `visible` while a lock is intended to be held.
 *
 * A future Capacitor migration will swap this for @capacitor-community/keep-awake.
 */

// Minimal shape of the Screen Wake Lock API (lib.dom.d.ts types are
// not always available in the project's TS config, so we declare locally).
interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

let sentinel: WakeLockSentinelLike | null = null;
let pending: Promise<void> | null = null;
let intended = false;
let visibilityHandlerAttached = false;

function getWakeLock(): WakeLockLike | null {
  if (typeof navigator === 'undefined') return null;
  const wl = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
  return wl ?? null;
}

/** True when the Screen Wake Lock API is available in this browser. */
export function isWakeLockSupported(): boolean {
  return getWakeLock() !== null;
}

async function requestSentinel(): Promise<void> {
  if (pending) return pending;
  const wl = getWakeLock();
  if (!wl) return;
  pending = (async () => {
    try {
      sentinel = await wl.request('screen');
    } catch (err) {
      // Safari/iOS sometimes rejects when the document isn't visible, or when
      // the user has explicitly disabled it. Never throw to the caller.
      // eslint-disable-next-line no-console
      console.warn('[wake-lock] request failed', err);
      sentinel = null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

function onVisibilityChange(): void {
  if (!intended) return;
  if (typeof document === 'undefined') return;
  if (document.visibilityState !== 'visible') return;
  if (sentinel && !sentinel.released) return;
  // Browser released the lock on hide; re-acquire now that we're visible.
  void requestSentinel();
}

function attachVisibilityHandler(): void {
  if (visibilityHandlerAttached) return;
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  visibilityHandlerAttached = true;
}

function detachVisibilityHandler(): void {
  if (!visibilityHandlerAttached) return;
  if (typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  visibilityHandlerAttached = false;
}

/**
 * Acquire a screen wake lock. No-op if the API is unavailable. Idempotent —
 * calling twice while a lock is already held does not stack sentinels.
 */
export async function acquireWakeLock(): Promise<void> {
  if (!isWakeLockSupported()) return;
  intended = true;
  attachVisibilityHandler();
  if (sentinel && !sentinel.released) return; // already held
  await requestSentinel();
}

/** Release the wake lock and stop re-acquiring on visibility changes. */
export async function releaseWakeLock(): Promise<void> {
  intended = false;
  detachVisibilityHandler();
  const current = sentinel;
  sentinel = null;
  if (!current || current.released) return;
  try {
    await current.release();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[wake-lock] release failed', err);
  }
}
