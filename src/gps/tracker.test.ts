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
      // ~1.1km in 1 second = 1100 m/s — far too fast
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
});
