import { Capacitor } from '@capacitor/core';
import { KeepAwake } from '@capacitor-community/keep-awake';

/**
 * Keep-awake adapter — prevents the screen from auto-locking during a run.
 *
 * Native (Capacitor): `@capacitor-community/keep-awake` forwards to iOS
 *   `UIApplication.shared.isIdleTimerDisabled` and Android `FLAG_KEEP_SCREEN_ON`.
 * Browser: falls back to the Screen Wake Lock API where available.
 * Call `enable()` when a guided run starts and `disable()` when it ends.
 */
export async function enableScreenAwake(): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      await KeepAwake.keepAwake();
      return;
    }
  } catch {
    // Capacitor not available — fall through to browser wake lock.
  }
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
    try {
      await (navigator as Navigator & { wakeLock: { request: (t: string) => Promise<unknown> } })
        .wakeLock.request('screen');
    } catch {
      // Wake lock may be rejected (battery saver, page not visible). Non-fatal.
    }
  }
}

export async function disableScreenAwake(): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      await KeepAwake.allowSleep();
    }
  } catch {
    // No-op.
  }
}
