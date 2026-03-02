import type { GpsPoint } from '@/types';
import type { GpsProvider, GpsCallback, GpsErrorCallback } from './types';

/**
 * Browser Geolocation API provider.
 * Foreground only — tracking may pause when the tab is backgrounded.
 */
export class WebGpsProvider implements GpsProvider {
  private watchId: number | null = null;
  private visibilityHandler: (() => void) | null = null;

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
        maximumAge: 3000,
        timeout: 15000,
      }
    );

    // Warn user when tab goes to background
    this.visibilityHandler = () => {
      if (document.hidden && this.watchId !== null) {
        onError(new Error('Tab backgrounded — GPS tracking may pause. Keep this tab visible for accurate tracking.'));
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  stopWatching(): void {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }
}
