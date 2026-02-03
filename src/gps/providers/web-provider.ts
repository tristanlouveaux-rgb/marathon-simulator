import type { GpsPoint } from '@/types';
import type { GpsProvider, GpsCallback, GpsErrorCallback } from './types';

/**
 * Browser Geolocation API provider.
 * Foreground only — stops when the tab is backgrounded.
 */
export class WebGpsProvider implements GpsProvider {
  private watchId: number | null = null;

  readonly supportsBackground = false;

  async requestPermissions(): Promise<boolean> {
    if (!navigator.geolocation) return false;
    try {
      await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
        });
      });
      return true;
    } catch {
      return false;
    }
  }

  startWatching(onPoint: GpsCallback, onError: GpsErrorCallback): void {
    if (!navigator.geolocation) {
      onError(new Error('Geolocation not available'));
      return;
    }

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const point: GpsPoint = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          altitude: pos.coords.altitude,
          accuracy: pos.coords.accuracy,
          speed: pos.coords.speed,
          timestamp: pos.timestamp,
        };
        onPoint(point);
      },
      (err) => onError(err),
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000,
      }
    );
  }

  stopWatching(): void {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
}
