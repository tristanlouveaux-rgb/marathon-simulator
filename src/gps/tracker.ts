import type {
  GpsPoint, GpsSplit, GpsLiveData, GpsTrackingStatus, SplitScheme
} from '@/types';
import type { GpsProvider } from './providers/types';
import { haversineDistance, calculatePace, rollingPace, filterJitter } from './geo-math';

export type TrackerUpdateCallback = (data: GpsLiveData) => void;

/**
 * Central GPS tracker: processes GPS points, accumulates distance,
 * detects splits, and exposes live data.
 *
 * State machine: idle -> acquiring -> tracking -> paused | stopped
 */
export class GpsTracker {
  private provider: GpsProvider;
  private status: GpsTrackingStatus = 'idle';
  private points: GpsPoint[] = [];
  private totalDistance = 0;
  private startTime = 0;       // epoch ms when tracking began
  private pauseStart = 0;      // epoch ms when pause began
  private totalPauseMs = 0;    // accumulated pause time
  private splitScheme: SplitScheme | null = null;
  private currentSegmentIdx = 0;
  private segmentDistance = 0;      // distance within current segment
  private segmentStartMs = 0;      // epoch ms when current segment began
  private segmentPauseMs = 0;      // accumulated pause time within segment
  private completedSplits: GpsSplit[] = [];
  private listeners: TrackerUpdateCallback[] = [];
  private lastAccuracy: number | null = null; // track accuracy during acquisition

  constructor(provider: GpsProvider, splitScheme?: SplitScheme) {
    this.provider = provider;
    this.splitScheme = splitScheme ?? null;
  }

  /** Register a listener for live data updates */
  onUpdate(cb: TrackerUpdateCallback): void {
    this.listeners.push(cb);
  }

  /** Remove a listener */
  offUpdate(cb: TrackerUpdateCallback): void {
    this.listeners = this.listeners.filter(l => l !== cb);
  }

  /** Get current live data snapshot */
  getLiveData(): GpsLiveData {
    return {
      status: this.status,
      totalDistance: this.totalDistance,
      elapsed: this.getElapsed(),
      currentPace: rollingPace(this.points),
      currentSplit: this.getCurrentSplitData(),
      completedSplits: [...this.completedSplits],
      points: this.points.length,
      accuracy: this.lastAccuracy,
    };
  }

  getStatus(): GpsTrackingStatus {
    return this.status;
  }

  getPoints(): GpsPoint[] {
    return [...this.points];
  }

  /** Start tracking */
  async start(): Promise<boolean> {
    if (this.status !== 'idle') return false;

    this.status = 'acquiring';
    this.notify();

    const granted = await this.provider.requestPermissions();
    if (!granted) {
      this.status = 'idle';
      this.notify();
      return false;
    }

    this.provider.startWatching(
      (point) => this.handlePoint(point),
      (error) => console.error('GPS error:', error)
    );

    return true;
  }

  /** Pause tracking (keeps GPS watching but stops accumulating) */
  pause(): void {
    if (this.status !== 'tracking') return;
    this.status = 'paused';
    this.pauseStart = Date.now();
    this.notify();
  }

  /** Resume from pause */
  resume(): void {
    if (this.status !== 'paused') return;
    const pauseDuration = Date.now() - this.pauseStart;
    this.totalPauseMs += pauseDuration;
    this.segmentPauseMs += pauseDuration;
    this.pauseStart = 0;
    this.status = 'tracking';
    this.notify();
  }

  /** Stop tracking completely */
  stop(): void {
    if (this.status === 'idle' || this.status === 'stopped') return;
    if (this.status === 'paused') {
      const pauseDuration = Date.now() - this.pauseStart;
      this.totalPauseMs += pauseDuration;
      this.segmentPauseMs += pauseDuration;
      this.pauseStart = 0;
    }
    this.provider.stopWatching();
    this.status = 'stopped';
    this.notify();
  }

  /** Elapsed tracking time in seconds (excludes pause time) */
  private getElapsed(): number {
    if (this.startTime === 0) return 0;
    const now = Date.now();
    let paused = this.totalPauseMs;
    if (this.status === 'paused' && this.pauseStart > 0) {
      paused += now - this.pauseStart;
    }
    return Math.max(0, (now - this.startTime - paused) / 1000);
  }

  /** Process an incoming GPS point */
  private handlePoint(point: GpsPoint): void {
    // Always track accuracy for UI feedback
    this.lastAccuracy = point.accuracy;

    // First point: transition from acquiring to tracking
    if (this.status === 'acquiring') {
      // Notify with current accuracy even if not ready to track
      this.notify();

      if (point.accuracy > 30) return; // wait for acceptable accuracy

      this.status = 'tracking';
      this.startTime = point.timestamp;
      this.segmentStartMs = point.timestamp;
      this.points.push(point);
      this.notify();
      return;
    }

    if (this.status !== 'tracking') return;

    const prev = this.points.length > 0 ? this.points[this.points.length - 1] : null;

    // Jitter filter
    if (filterJitter(point, prev)) return;

    // Accumulate distance
    if (prev) {
      const dist = haversineDistance(prev.lat, prev.lng, point.lat, point.lng);
      this.totalDistance += dist;
      this.segmentDistance += dist;
    }

    this.points.push(point);

    // Check split boundaries
    this.checkSplitBoundary();

    this.notify();
  }

  /** Check if we've crossed a segment boundary */
  private checkSplitBoundary(): void {
    if (!this.splitScheme) return;
    const segments = this.splitScheme.segments;
    if (this.currentSegmentIdx >= segments.length) return;

    const segment = segments[this.currentSegmentIdx];
    if (this.segmentDistance >= segment.distance) {
      // Actual elapsed time for this segment (excluding pauses)
      const now = this.points[this.points.length - 1]?.timestamp ?? Date.now();
      const segmentElapsed = Math.max(0, (now - this.segmentStartMs - this.segmentPauseMs) / 1000);

      const split: GpsSplit = {
        index: this.completedSplits.length,
        label: segment.label,
        distance: this.segmentDistance,
        elapsed: segmentElapsed,
        pace: calculatePace(this.segmentDistance, segmentElapsed),
        targetPace: segment.targetPace,
      };
      this.completedSplits.push(split);
      this.segmentDistance -= segment.distance; // carry over excess
      this.currentSegmentIdx++;

      // Reset segment timer for the next segment
      this.segmentStartMs = now;
      this.segmentPauseMs = 0;
    }
  }

  /** Get data for the in-progress split */
  private getCurrentSplitData(): GpsSplit | null {
    if (!this.splitScheme) {
      // Default: km splits
      const kmCompleted = Math.floor(this.totalDistance / 1000);
      const distInSplit = this.totalDistance - kmCompleted * 1000;
      if (this.totalDistance <= 0) return null;
      return {
        index: kmCompleted,
        label: `km ${kmCompleted + 1}`,
        distance: distInSplit,
        elapsed: 0,
        pace: rollingPace(this.points) ?? 0,
        targetPace: null,
      };
    }

    if (this.currentSegmentIdx >= this.splitScheme.segments.length) return null;
    const segment = this.splitScheme.segments[this.currentSegmentIdx];
    return {
      index: this.currentSegmentIdx,
      label: segment.label,
      distance: this.segmentDistance,
      elapsed: 0,
      pace: rollingPace(this.points) ?? 0,
      targetPace: segment.targetPace,
    };
  }

  /** Notify all listeners */
  private notify(): void {
    const data = this.getLiveData();
    for (const cb of this.listeners) {
      cb(data);
    }
  }
}
