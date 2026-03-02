import type { GpsPoint } from '@/types';
import type { GpsProvider, GpsCallback, GpsErrorCallback } from './types';

/**
 * Native GPS provider using @transistorsoft/capacitor-background-geolocation.
 * Supports background tracking on iOS.
 *
 * This provider lazy-imports the plugin so it doesn't break web builds
 * (the plugin is only available in native Capacitor shells).
 */
export class NativeGpsProvider implements GpsProvider {
  private bgGeo: any = null;
  private onPointCb: GpsCallback | null = null;
  private onErrorCb: GpsErrorCallback | null = null;

  readonly supportsBackground = true;

  async requestPermissions(): Promise<boolean> {
    try {
      const mod = await import('@transistorsoft/capacitor-background-geolocation');
      this.bgGeo = mod.default;

      const state = await this.bgGeo.ready({
        desiredAccuracy: this.bgGeo.DESIRED_ACCURACY_HIGH,
        distanceFilter: 10,
        stopOnTerminate: false,
        startOnBoot: false,
        enableHeadless: false,
        preventSuspend: true,
        heartbeatInterval: 60,
        pausesLocationUpdatesAutomatically: false,
        locationAuthorizationRequest: 'Always',
        backgroundPermissionRationale: {
          title: 'Allow background location access',
          message: 'Marathon Simulator needs background location to track your run when the app is in the background.',
          positiveAction: 'Allow',
          negativeAction: 'Cancel',
        },
      });

      return state.enabled !== undefined;
    } catch {
      return false;
    }
  }

  startWatching(onPoint: GpsCallback, onError: GpsErrorCallback): void {
    if (!this.bgGeo) {
      onError(new Error('Native GPS not initialized. Call requestPermissions() first.'));
      return;
    }

    this.onPointCb = onPoint;
    this.onErrorCb = onError;

    this.bgGeo.onLocation(
      (location: any) => {
        if (!this.onPointCb) return;
        const point: GpsPoint = {
          lat: location.coords.latitude,
          lng: location.coords.longitude,
          altitude: location.coords.altitude,
          accuracy: location.coords.accuracy,
          speed: location.coords.speed,
          timestamp: new Date(location.timestamp).getTime(),
        };
        this.onPointCb(point);
      },
      (error: any) => {
        console.warn('GPS location error:', error);
        if (this.onErrorCb) {
          this.onErrorCb(new Error(error?.message || 'Location error'));
        }
      }
    );

    this.bgGeo.onProviderChange((event: any) => {
      if (!event.enabled) {
        console.warn('Location services disabled by user');
        if (this.onErrorCb) {
          this.onErrorCb(new Error('Location services disabled'));
        }
      }
    });

    this.bgGeo.start();
  }

  stopWatching(): void {
    if (this.bgGeo) {
      this.bgGeo.stop();
      this.bgGeo.removeListeners();
    }
    this.onPointCb = null;
    this.onErrorCb = null;
  }
}
