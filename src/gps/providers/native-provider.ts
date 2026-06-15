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

      await this.bgGeo.ready({
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

      // ready() resolves regardless of the permission outcome — its State.enabled
      // only reflects whether the SDK is started, not whether location is
      // authorized. The old `state.enabled !== undefined` check was therefore
      // always true, so a user who DENIED location still got `true` and the app
      // recorded 0.00 km forever instead of falling back to timer-only mode.
      // requestPermission() explicitly prompts and resolves with the real status.
      const status = await this.bgGeo.requestPermission();
      return status === this.bgGeo.AUTHORIZATION_STATUS_ALWAYS
        || status === this.bgGeo.AUTHORIZATION_STATUS_WHEN_IN_USE;
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

    // start() boots the SDK in its battery-saving 'stationary' state: it emits
    // NO locations until its motion-detector decides the device is moving, which
    // for a runner starting from a standstill can take ~200m — or never fire if
    // Motion & Fitness permission was declined. changePace(true) forces the SDK
    // straight into the active 'moving' state so location tracking engages the
    // moment the user presses Start. This is the documented pattern for fitness
    // apps; without it the timer runs but distance stays 0.00 km.
    this.bgGeo.start()
      .then(() => this.bgGeo.changePace(true))
      .catch((error: any) => {
        console.warn('GPS start error:', error);
        if (this.onErrorCb) {
          this.onErrorCb(new Error(error?.message || 'Failed to start GPS'));
        }
      });
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
