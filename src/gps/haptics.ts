/**
 * Haptic/vibration feedback for GPS tracking events.
 * Uses Capacitor Haptics on native, navigator.vibrate on web.
 */

/** Short vibration for split completion */
export async function splitAlert(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([200, 100, 200]);
    }
  } catch { /* silently ignore if not supported */ }
}

/** Longer vibration for workout completion (all splits done) */
export async function workoutCompleteAlert(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([300, 150, 300, 150, 300]);
    }
  } catch { /* silently ignore if not supported */ }
}
