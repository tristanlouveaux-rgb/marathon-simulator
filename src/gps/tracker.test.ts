import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GpsTracker } from './tracker';
import { MockGpsProvider } from './providers/mock-provider';
import type { GpsPoint, SplitScheme } from '@/types';

function makePoint(
  lat: number,
  lng: number,
  timestamp: number,
  accuracy: number = 5
): GpsPoint {
  return { lat, lng, altitude: null, accuracy, speed: null, timestamp };
}

describe('GpsTracker', () => {
  let provider: MockGpsProvider;
  let tracker: GpsTracker;

  beforeEach(() => {
    provider = new MockGpsProvider();
    tracker = new GpsTracker(provider);
  });

  describe('state transitions', () => {
    it('starts in idle state', () => {
      expect(tracker.getStatus()).toBe('idle');
    });

    it('transitions to acquiring on start', async () => {
      const updates: string[] = [];
      tracker.onUpdate((data) => updates.push(data.status));

      await tracker.start();
      expect(tracker.getStatus()).toBe('acquiring');
    });

    it('transitions to tracking on first valid point', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 1000));
      expect(tracker.getStatus()).toBe('tracking');
    });

    it('stays acquiring if first point has bad accuracy', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 1000, 50));
      expect(tracker.getStatus()).toBe('acquiring');
    });

    it('transitions to paused on pause', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 1000));
      tracker.pause();
      expect(tracker.getStatus()).toBe('paused');
    });

    it('transitions back to tracking on resume', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 1000));
      tracker.pause();
      tracker.resume();
      expect(tracker.getStatus()).toBe('tracking');
    });

    it('transitions to stopped on stop', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 1000));
      tracker.stop();
      expect(tracker.getStatus()).toBe('stopped');
    });

    it('returns false if start called when not idle', async () => {
      await tracker.start();
      const result = await tracker.start();
      expect(result).toBe(false);
    });

    it('returns false if permission denied', async () => {
      provider.permissionGranted = false;
      const result = await tracker.start();
      expect(result).toBe(false);
      expect(tracker.getStatus()).toBe('idle');
    });

    it('does nothing when pausing in non-tracking state', () => {
      tracker.pause();
      expect(tracker.getStatus()).toBe('idle');
    });

    it('does nothing when resuming in non-paused state', () => {
      tracker.resume();
      expect(tracker.getStatus()).toBe('idle');
    });
  });

  describe('acquisition gate (arm / confirmStart)', () => {
    it('arms into acquiring without starting the clock', async () => {
      const armed = await tracker.arm();
      expect(armed).toBe(true);
      expect(tracker.getStatus()).toBe('acquiring');
      expect(tracker.isArmed()).toBe(true);
      expect(tracker.getLiveData().elapsed).toBe(0);
    });

    it('does NOT auto-start tracking on a good fix while armed', async () => {
      await tracker.arm();
      provider.pushPoint(makePoint(0, 0, 1000)); // accuracy 5 = good
      // Without the confirm tap, a ready fix must not begin the run.
      expect(tracker.getStatus()).toBe('acquiring');
      expect(tracker.isArmed()).toBe(true);
    });

    it('reports isGpsReady once an acceptable fix arrives', async () => {
      await tracker.arm();
      expect(tracker.isGpsReady()).toBe(false);
      provider.pushPoint(makePoint(0, 0, 1000, 50)); // bad accuracy
      expect(tracker.isGpsReady()).toBe(false);
      provider.pushPoint(makePoint(0, 0, 2000, 12)); // good accuracy
      expect(tracker.isGpsReady()).toBe(true);
    });

    it('confirmStart begins tracking and accumulates from the next fix', async () => {
      await tracker.arm();
      provider.pushPoint(makePoint(0, 0, 1000)); // ready, still armed
      tracker.confirmStart();
      expect(tracker.isArmed()).toBe(false);
      // First post-confirm fix seeds the route; the next accumulates distance.
      provider.pushPoint(makePoint(0, 0, 2000));
      provider.pushPoint(makePoint(0.001, 0, 32000));
      expect(tracker.getStatus()).toBe('tracking');
      expect(tracker.getLiveData().totalDistance).toBeGreaterThan(100);
    });

    it('confirmStart is a no-op when not armed', async () => {
      tracker.confirmStart();
      expect(tracker.getStatus()).toBe('idle');
    });

    it('arm returns false and resets to idle when permission denied', async () => {
      provider.permissionGranted = false;
      const armed = await tracker.arm();
      expect(armed).toBe(false);
      expect(tracker.getStatus()).toBe('idle');
      expect(tracker.isArmed()).toBe(false);
    });

    it('cancelArm stops watching and returns to idle', async () => {
      await tracker.arm();
      expect(provider.isWatching).toBe(true);
      tracker.cancelArm();
      expect(tracker.getStatus()).toBe('idle');
      expect(tracker.isArmed()).toBe(false);
      expect(provider.isWatching).toBe(false);
    });
  });

  describe('distance accumulation', () => {
    it('accumulates distance between valid points', async () => {
      await tracker.start();
      // ~111m apart
      provider.pushPoint(makePoint(0, 0, 0));
      provider.pushPoint(makePoint(0.001, 0, 30000));

      const data = tracker.getLiveData();
      expect(data.totalDistance).toBeGreaterThan(100);
      expect(data.totalDistance).toBeLessThan(120);
    });

    it('does not accumulate distance when paused', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      provider.pushPoint(makePoint(0.001, 0, 30000));

      const distBefore = tracker.getLiveData().totalDistance;
      tracker.pause();
      provider.pushPoint(makePoint(0.002, 0, 60000));

      expect(tracker.getLiveData().totalDistance).toBe(distBefore);
    });

    it('resumes accumulating after resume', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      provider.pushPoint(makePoint(0.001, 0, 30000));

      tracker.pause();
      tracker.resume();
      provider.pushPoint(makePoint(0.002, 0, 60000));

      const data = tracker.getLiveData();
      expect(data.totalDistance).toBeGreaterThan(200);
    });

    it('tracks point count', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      provider.pushPoint(makePoint(0.001, 0, 30000));
      provider.pushPoint(makePoint(0.002, 0, 60000));

      expect(tracker.getLiveData().points).toBe(3);
    });
  });

  describe('jitter rejection', () => {
    it('rejects points with bad accuracy', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0)); // first point accepted
      provider.pushPoint(makePoint(0.001, 0, 30000, 50)); // bad accuracy

      expect(tracker.getLiveData().points).toBe(1);
      expect(tracker.getLiveData().totalDistance).toBe(0);
    });

    it('rejects points implying unrealistic speed', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      // ~1.1km in 1 second = 1100 m/s. Far too fast
      provider.pushPoint(makePoint(0.01, 0, 1000));

      expect(tracker.getLiveData().points).toBe(1);
    });

    it('accepts realistic running speed points', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      // ~111m in 30s = ~3.7 m/s, typical easy jog
      provider.pushPoint(makePoint(0.001, 0, 30000));

      expect(tracker.getLiveData().points).toBe(2);
    });
  });

  describe('split detection', () => {
    it('fires splits when segment distance is reached', async () => {
      const scheme: SplitScheme = {
        segments: [
          { label: 'km 1', distance: 1000, targetPace: 300 },
          { label: 'km 2', distance: 1000, targetPace: 300 },
        ],
        totalDistance: 2000,
        description: '2km easy',
      };

      tracker = new GpsTracker(provider, scheme);
      await tracker.start();

      // Push points to cover ~1.1 km (10 × ~111m)
      for (let i = 0; i <= 10; i++) {
        provider.pushPoint(makePoint(i * 0.001, 0, i * 30000));
      }

      const data = tracker.getLiveData();
      expect(data.completedSplits.length).toBeGreaterThanOrEqual(1);
      expect(data.completedSplits[0].label).toBe('km 1');
    });

    it('records actual elapsed time in completed splits', async () => {
      const scheme: SplitScheme = {
        segments: [
          { label: 'km 1', distance: 1000, targetPace: 300 },
        ],
        totalDistance: 1000,
        description: '1km',
      };

      tracker = new GpsTracker(provider, scheme);
      await tracker.start();

      // Push 10 points, each ~111m apart, 30s between = total ~300s for ~1.1km
      for (let i = 0; i <= 10; i++) {
        provider.pushPoint(makePoint(i * 0.001, 0, i * 30000));
      }

      const data = tracker.getLiveData();
      expect(data.completedSplits.length).toBe(1);
      // Elapsed should reflect actual GPS timestamps, not estimation
      // ~9 segments of 30s to cover ~1km = ~270s
      expect(data.completedSplits[0].elapsed).toBeGreaterThan(200);
      expect(data.completedSplits[0].elapsed).toBeLessThan(350);
      // Pace should be derived from actual elapsed, not rolling pace
      expect(data.completedSplits[0].pace).toBeGreaterThan(200);
      expect(data.completedSplits[0].pace).toBeLessThan(350);
    });

    it('provides default km splits without a scheme', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      provider.pushPoint(makePoint(0.001, 0, 30000));

      const data = tracker.getLiveData();
      expect(data.currentSplit).not.toBeNull();
      expect(data.currentSplit!.label).toBe('km 1');
    });
  });

  describe('listeners', () => {
    it('calls onUpdate listeners on state changes', async () => {
      const updates: string[] = [];
      tracker.onUpdate((data) => updates.push(data.status));

      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      tracker.pause();
      tracker.resume();
      tracker.stop();

      expect(updates).toContain('acquiring');
      expect(updates).toContain('tracking');
      expect(updates).toContain('paused');
      expect(updates).toContain('stopped');
    });

    it('can remove listeners', async () => {
      const calls: number[] = [];
      const cb = () => calls.push(1);
      tracker.onUpdate(cb);

      await tracker.start();
      expect(calls.length).toBeGreaterThan(0);

      const countBefore = calls.length;
      tracker.offUpdate(cb);
      provider.pushPoint(makePoint(0, 0, 0));
      expect(calls.length).toBe(countBefore);
    });
  });

  describe('stop from paused state', () => {
    it('can stop while paused', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      tracker.pause();
      tracker.stop();
      expect(tracker.getStatus()).toBe('stopped');
    });
  });

  describe('auto-pause', () => {
    // ~1m of latitude ≈ 111_000 meters, so 0.00001 lat ≈ 1.11m
    // To simulate ~3 m/s running, move ~0.000027 lat/sec.
    const LAT_PER_METER = 1 / 111_000;

    it('triggers auto-pause after 5s of near-zero movement while tracking', async () => {
      const events: string[] = [];
      tracker.onAutoPause(() => events.push('pause'));

      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));          // first point → tracking
      // Running for 2s
      provider.pushPoint(makePoint(LAT_PER_METER * 6, 0, 2000));
      // Now go stationary for 6s
      for (let t = 3000; t <= 8000; t += 1000) {
        provider.pushPoint(makePoint(LAT_PER_METER * 6, 0, t));
      }
      expect(tracker.getStatus()).toBe('paused');
      expect(tracker.isAutoPaused()).toBe(true);
      expect(events).toHaveLength(1);
    });

    it('auto-resumes after 3s of clear movement while auto-paused', async () => {
      const events: string[] = [];
      tracker.onAutoPause(() => events.push('pause'));
      tracker.onAutoResume(() => events.push('resume'));

      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      for (let t = 1000; t <= 7000; t += 1000) {
        provider.pushPoint(makePoint(0, 0, t));  // stationary → auto-pause
      }
      expect(tracker.isAutoPaused()).toBe(true);

      // Move ~2.5m/step over 3 seconds → mean ~2.5 m/s > 1.5 threshold
      for (let i = 1; i <= 4; i++) {
        provider.pushPoint(makePoint(LAT_PER_METER * 2.5 * i, 0, 7000 + i * 1000));
      }
      expect(tracker.getStatus()).toBe('tracking');
      expect(events).toEqual(['pause', 'resume']);
    });

    it('does not trigger when auto-pause disabled at construction', async () => {
      const p = new MockGpsProvider();
      const t2 = new GpsTracker(p, undefined, { autoPause: false });
      const events: string[] = [];
      t2.onAutoPause(() => events.push('pause'));

      await t2.start();
      p.pushPoint(makePoint(0, 0, 0));
      for (let t = 1000; t <= 8000; t += 1000) {
        p.pushPoint(makePoint(0, 0, t));
      }
      expect(t2.getStatus()).toBe('tracking');
      expect(events).toHaveLength(0);
    });

    it('manual pause does not set the auto flag', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      tracker.pause();
      expect(tracker.getStatus()).toBe('paused');
      expect(tracker.isAutoPaused()).toBe(false);
    });

    it('disabling auto-pause while auto-paused triggers resume', async () => {
      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      for (let t = 1000; t <= 7000; t += 1000) {
        provider.pushPoint(makePoint(0, 0, t));
      }
      expect(tracker.isAutoPaused()).toBe(true);
      tracker.setAutoPauseEnabled(false);
      expect(tracker.getStatus()).toBe('tracking');
    });

    it('brief pause under 5s does not trigger', async () => {
      const events: string[] = [];
      tracker.onAutoPause(() => events.push('pause'));

      await tracker.start();
      provider.pushPoint(makePoint(0, 0, 0));
      // stationary for only 3 seconds, then move
      for (let t = 1000; t <= 3000; t += 1000) {
        provider.pushPoint(makePoint(0, 0, t));
      }
      for (let i = 1; i <= 3; i++) {
        provider.pushPoint(makePoint(LAT_PER_METER * 3 * i, 0, 3000 + i * 1000));
      }
      expect(tracker.getStatus()).toBe('tracking');
      expect(events).toHaveLength(0);
    });
  });

  describe('captureLap (manual lap button)', () => {
    it('returns null when no GPS lock has been acquired', async () => {
      await tracker.start();
      // No points pushed yet — still acquiring.
      expect(tracker.captureLap()).toBeNull();
    });

    it('returns null when a structured scheme is active (scheme owns splits)', async () => {
      const scheme: SplitScheme = {
        segments: [{ label: 'km 1', distance: 1000, targetPace: 300 }],
        totalDistance: 1000,
        description: '1km',
      };
      tracker = new GpsTracker(provider, scheme, { autoPause: false });
      await tracker.start();
      // Cover ~400m so a lap would have measurable distance.
      for (let i = 0; i <= 4; i++) {
        provider.pushPoint(makePoint(i * 0.001, 0, i * 30000));
      }
      expect(tracker.captureLap()).toBeNull();
      // Scheme-managed splits remain untouched.
      expect(tracker.getLiveData().completedSplits).toHaveLength(0);
    });

    it('captures a Lap split with measured distance and elapsed', async () => {
      tracker = new GpsTracker(provider, undefined, { autoPause: false });
      await tracker.start();
      // ~330m over 90s.
      for (let i = 0; i <= 3; i++) {
        provider.pushPoint(makePoint(i * 0.001, 0, i * 30000));
      }
      const split = tracker.captureLap();
      expect(split).not.toBeNull();
      expect(split!.label).toBe('Lap 1');
      expect(split!.distance).toBeGreaterThan(200);
      expect(split!.distance).toBeLessThan(400);
      expect(split!.elapsed).toBeGreaterThan(60);
      expect(split!.elapsed).toBeLessThan(120);
      expect(split!.pace).toBeGreaterThan(0);
      expect(split!.targetPace).toBeNull();
    });

    it('numbers successive laps sequentially', async () => {
      tracker = new GpsTracker(provider, undefined, { autoPause: false });
      await tracker.start();
      for (let i = 0; i <= 3; i++) {
        provider.pushPoint(makePoint(i * 0.001, 0, i * 30000));
      }
      const first = tracker.captureLap();
      // Cover more ground.
      for (let i = 4; i <= 7; i++) {
        provider.pushPoint(makePoint(i * 0.001, 0, i * 30000));
      }
      const second = tracker.captureLap();
      expect(first!.label).toBe('Lap 1');
      expect(second!.label).toBe('Lap 2');
      // Both splits live in the completedSplits array.
      expect(tracker.getLiveData().completedSplits).toHaveLength(2);
    });

    it('resets segment counters so the next lap measures only its own distance', async () => {
      tracker = new GpsTracker(provider, undefined, { autoPause: false });
      await tracker.start();
      for (let i = 0; i <= 3; i++) {
        provider.pushPoint(makePoint(i * 0.001, 0, i * 30000));
      }
      const first = tracker.captureLap();
      for (let i = 4; i <= 7; i++) {
        provider.pushPoint(makePoint(i * 0.001, 0, i * 30000));
      }
      const second = tracker.captureLap();
      // Each lap is ~3 segments × ~111m ≈ similar distance, not cumulative.
      expect(second!.distance).toBeLessThan(first!.distance * 2);
    });

    it('notifies split listeners so the UI can patch a "Last lap" readout', async () => {
      tracker = new GpsTracker(provider, undefined, { autoPause: false });
      const seen: string[] = [];
      tracker.onSplitComplete((s) => seen.push(s.label));
      await tracker.start();
      for (let i = 0; i <= 3; i++) {
        provider.pushPoint(makePoint(i * 0.001, 0, i * 30000));
      }
      tracker.captureLap();
      expect(seen).toEqual(['Lap 1']);
    });

    it('returns null when stopped', async () => {
      tracker = new GpsTracker(provider, undefined, { autoPause: false });
      await tracker.start();
      for (let i = 0; i <= 3; i++) {
        provider.pushPoint(makePoint(i * 0.001, 0, i * 30000));
      }
      tracker.stop();
      expect(tracker.captureLap()).toBeNull();
    });
  });
});
