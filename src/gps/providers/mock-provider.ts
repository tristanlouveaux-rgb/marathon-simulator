import type { GpsPoint } from '@/types';
import type { GpsProvider, GpsCallback, GpsErrorCallback } from './types';

/**
 * Mock GPS provider for unit tests.
 * Lets you push points programmatically.
 */
export class MockGpsProvider implements GpsProvider {
  private onPointCb: GpsCallback | null = null;
  private onErrorCb: GpsErrorCallback | null = null;
  private _watching = false;

  readonly supportsBackground = false;

  permissionGranted = true;

  async requestPermissions(): Promise<boolean> {
    return this.permissionGranted;
  }

  startWatching(onPoint: GpsCallback, onError: GpsErrorCallback): void {
    this.onPointCb = onPoint;
    this.onErrorCb = onError;
    this._watching = true;
  }

  stopWatching(): void {
    this.onPointCb = null;
    this.onErrorCb = null;
    this._watching = false;
  }

  get isWatching(): boolean {
    return this._watching;
  }

  /** Simulate receiving a GPS point */
  pushPoint(point: GpsPoint): void {
    if (this.onPointCb) {
      this.onPointCb(point);
    }
  }

  /** Simulate a GPS error */
  pushError(error: Error): void {
    if (this.onErrorCb) {
      this.onErrorCb(error);
    }
  }
}
