import { Capacitor } from '@capacitor/core';

/**
 * Recommended @transistorsoft/capacitor-background-geolocation config for guided runs.
 *
 * iOS: keeps tracking alive when the phone is locked or the app is backgrounded.
 *   `UIBackgroundModes: location` must be set in Info.plist (it is).
 *   `preventSuspend: true` prevents CPU suspension while the user is stationary.
 *
 * Android: `foregroundService + notification` runs a persistent foreground service with a
 *   non-dismissable notification. iOS ignores these fields; they are harmless to set.
 *
 * Call `BackgroundGeolocation.ready(GUIDED_RUN_LOCATION_CONFIG)` before `.start()` on
 * native. On web, do nothing — GPS is read from `navigator.geolocation` via the existing
 * tracker.
 */
export const GUIDED_RUN_LOCATION_CONFIG = {
  desiredAccuracy: 0,
  distanceFilter: 5,
  stopOnTerminate: true,
  startOnBoot: false,
  preventSuspend: true,
  heartbeatInterval: 60,
  locationAuthorizationRequest: 'Always' as const,
  foregroundService: true,
  notification: {
    title: 'Guided run in progress',
    text: 'Tracking pace and splits',
    sticky: true,
  },
} as const;

export function isNativeGeolocationAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}
