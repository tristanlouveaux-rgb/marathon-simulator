import { Capacitor } from '@capacitor/core';

/** Check if running inside a native Capacitor shell */
export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Check if running on iOS */
export function isIOS(): boolean {
  try {
    return Capacitor.getPlatform() === 'ios';
  } catch {
    return false;
  }
}

/** Get the current platform: 'ios' | 'android' | 'web' */
export function getPlatform(): string {
  try {
    return Capacitor.getPlatform();
  } catch {
    return 'web';
  }
}
