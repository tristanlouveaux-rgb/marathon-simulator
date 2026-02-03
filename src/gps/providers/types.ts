import type { GpsPoint } from '@/types';

/** Callback invoked on each new GPS fix */
export type GpsCallback = (point: GpsPoint) => void;

/** Callback invoked when an error occurs */
export type GpsErrorCallback = (error: GeolocationPositionError | Error) => void;

/** Abstract GPS provider interface */
export interface GpsProvider {
  /** Request location permissions. Returns true if granted. */
  requestPermissions(): Promise<boolean>;

  /** Start watching for GPS updates. Calls onPoint for each fix. */
  startWatching(onPoint: GpsCallback, onError: GpsErrorCallback): void;

  /** Stop watching for GPS updates. */
  stopWatching(): void;

  /** Whether this provider supports background tracking */
  readonly supportsBackground: boolean;
}
