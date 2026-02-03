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
});
