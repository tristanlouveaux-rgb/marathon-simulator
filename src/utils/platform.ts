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

/**
 * True on touch-primary devices (native iOS/Android shells and mobile web).
 * The native HTML5 `draggable` attribute makes WKWebView/mobile Safari lift its
 * own translucent drag preview on long-press, which collides with our custom
 * touch DnD clone and shows doubled, mis-positioned ghosts. On these devices we
 * disable `draggable` and rely on the touch handlers; the HTML5 drag path only
 * ever fired with a mouse anyway.
 */
export function isTouchPrimary(): boolean {
  if (isNative()) return true;
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}
