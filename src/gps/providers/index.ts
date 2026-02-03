export type { GpsProvider, GpsCallback, GpsErrorCallback } from './types';
export { WebGpsProvider } from './web-provider';
export { NativeGpsProvider } from './native-provider';
export { MockGpsProvider } from './mock-provider';

import type { GpsProvider } from './types';
import { isNative } from '@/utils/platform';
import { WebGpsProvider } from './web-provider';
import { NativeGpsProvider } from './native-provider';

/**
 * Factory: returns the native provider on iOS/Android, web provider in browser.
 */
export function createGpsProvider(): GpsProvider {
  if (isNative()) {
    return new NativeGpsProvider();
  }
  return new WebGpsProvider();
}
