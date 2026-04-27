import type {
  GpsPoint, GpsSplit, GpsLiveData, GpsTrackingStatus, SplitScheme
} from '@/types';
import type { GpsProvider } from './providers/types';
import { haversineDistance, calculatePace, rollingPace, filterJitter } from './geo-math';

export type TrackerUpdateCallback = (data: GpsLiveData) => void;
export type SplitCompleteCallback = (split: GpsSplit, allDone: boolean) => void;
export type AutoPauseCallback = () => void;

/** Speed below which the runner is considered stopped, m/s. */
const AUTO_PAUSE_STOP_SPEED_MPS = 0.5;
/** Continuous seconds below stop speed required to trigger auto-pause. */
const AUTO_PAUSE_STOP_DURATION_S = 5;
/** Speed above which the runner is considered moving again, m/s. */
const AUTO_PAUSE_RESUME_SPEED_MPS = 1.5;
/** Continuous seconds above resume speed required to auto-resume. */
const AUTO_PAUSE_RESUME_DURATION_S = 3;
/** Seconds of recent GPS samples kept for motion detection. */
const MOTION_WINDOW_SEC = 10;

export interface GpsTrackerOptions {
  /** Enable speed-based auto-pause/auto-resume. Default true. */
  autoPause?: boolean;
}

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
  private splitListeners: SplitCompleteCallback[] = [];
  private autoPauseListeners: AutoPauseCallback[] = [];
  private autoResumeListeners: AutoPauseCallback[] = [];
  private lastAccuracy: number | null = null; // track accuracy during acquisition
  private autoPauseEnabled = true;
  private autoPausedFlag = false;            // true if current pause was triggered by auto-pause
  private motionBuffer: GpsPoint[] = [];     // recent points for speed estimation

  constructor(provider: GpsProvider, splitScheme?: SplitScheme, options?: GpsTrackerOptions) {
    this.provider = provider;
    this.splitScheme = splitScheme ?? null;
    this.autoPauseEnabled = options?.autoPause ?? true;
  }

  /** Enable or disable auto-pause at runtime. */
  setAutoPauseEnabled(enabled: boolean): void {
    this.autoPauseEnabled = enabled;
    if (!enabled) {
      // If currently auto-paused, resume immediately so user isn't stuck.
      if (this.status === 'paused' && this.autoPausedFlag) {
        this.autoPausedFlag = false;
        this.resume();
      }
    }
  }

  /** Register a listener for auto-pause events. */
  onAutoPause(cb: AutoPauseCallback): void {
    this.autoPauseListeners.push(cb);
  }

  /** Register a listener for auto-resume events. */
  onAutoResume(cb: AutoPauseCallback): void {
    this.autoResumeListeners.push(cb);
  }

  /** Register a listener for live data updates */
  onUpdate(cb: TrackerUpdateCallback): void {
    this.listeners.push(cb);
  }

  /** Remove a listener */
  offUpdate(cb: TrackerUpdateCallback): void {
    this.listeners = this.listeners.filter(l => l !== cb);
  }

  /** Register a callback for split completions */
  onSplitComplete(cb: SplitCompleteCallback): void {
    this.splitListeners.push(cb);
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

    // Start elapsed timer immediately — don't wait for GPS lock
    this.startTime = Date.now();

    this.provider.startWatching(
      (point) => this.handlePoint(point),
      (error) => console.error('GPS error:', error)
    );

    return true;
  }

  /** Pause tracking (keeps GPS watching but stops accumulating) */
  pause(): void {
    if (this.status !== 'tracking' && this.status !== 'acquiring') return;
    this.status = 'paused';
    this.pauseStart = Date.now();
    // Manual pause clears the auto flag so manual resume is required.
    this.autoPausedFlag = false;
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
    this.autoPausedFlag = false;
    this.notify();
  }

  /** Returns true if the tracker is currently in an auto-paused state. */
  isAutoPaused(): boolean {
    return this.status === 'paused' && this.autoPausedFlag;
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

  /**
   * Close the current segment and advance to the next one, using whatever
   * distance/time has been accumulated so far. Mirrors the body of
   * `checkSplitBoundary` so the tracker's split state stays authoritative.
   * Called by the guided runs controller when the user taps "Skip rest"
   * (or any step-skip UI) so the tracker doesn't keep counting the
   * abandoned segment.
   */
  skipSegment(): void {
    if (!this.splitScheme) return;
    const segments = this.splitScheme.segments;
    if (this.currentSegmentIdx >= segments.length) return;

    const segment = segments[this.currentSegmentIdx];
    const lastPoint = this.points.length > 0 ? this.points[this.points.length - 1] : null;
    const now = lastPoint ? lastPoint.timestamp : Date.now();
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
    this.segmentDistance = 0;
    this.currentSegmentIdx++;
    this.segmentStartMs = lastPoint ? lastPoint.timestamp : Date.now();
    this.segmentPauseMs = 0;

    const allDone = this.currentSegmentIdx >= segments.length;
    for (const cb of this.splitListeners) cb(split, allDone);
    this.notify();
  }

  /**
   * Extend the current segment's target by `sec` seconds (time-based segments only).
   * Returns the new total duration, or null if the current segment is distance-based
   * or there is no active scheme. Mutates the scheme in place — the scheme is a
   * per-run copy passed to the constructor, so this does not leak to the plan.
   */
  extendSegment(sec: number): number | null {
    if (!this.splitScheme) return null;
    const segment = this.splitScheme.segments[this.currentSegmentIdx];
    if (!segment || segment.durationSeconds == null) return null;
    segment.durationSeconds += sec;
    return segment.durationSeconds;
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
      this.segmentStartMs = point.timestamp;
      this.points.push(point);
      this.notify();
      return;
    }

    // Track motion for auto-pause detection in both tracking and auto-paused states
    // (so we can also detect resume while auto-paused).
    if (this.autoPauseEnabled &&
        (this.status === 'tracking' || (this.status === 'paused' && this.autoPausedFlag))) {
      this.motionBuffer.push(point);
      const cutoff = point.timestamp - MOTION_WINDOW_SEC * 1000;
      this.motionBuffer = this.motionBuffer.filter((p) => p.timestamp >= cutoff);
      this.evaluateAutoPause(point.timestamp);
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

  /**
   * Called every second by the external timer so time-based recovery segments
   * auto-advance even without incoming GPS points.
   */
  public tick(): void {
    // Tick fires every second. Evaluate auto-pause even when no GPS point has
    // arrived recently (e.g. indoors with a weak signal — a stationary user
    // still needs to be detected as stopped).
    if (this.autoPauseEnabled &&
        (this.status === 'tracking' || (this.status === 'paused' && this.autoPausedFlag))) {
      this.evaluateAutoPause(Date.now());
    }
    if (this.status !== 'tracking') return;
    this.checkSplitBoundary();
    this.notify();
  }

  /**
   * Speed-based auto-pause detector.
   * - In tracking: if mean speed over last STOP_DURATION seconds stays below
   *   STOP_SPEED, auto-pause and mark the pause as auto.
   * - In auto-paused: if mean speed over last RESUME_DURATION seconds stays
   *   above RESUME_SPEED, auto-resume.
   * Uses distance over the sample window as the speed signal.
   */
  private evaluateAutoPause(nowMs: number): void {
    const distOver = (windowSec: number): number => {
      const cutoff = nowMs - windowSec * 1000;
      const window = this.motionBuffer.filter((p) => p.timestamp >= cutoff);
      if (window.length < 2) return 0;
      let dist = 0;
      for (let i = 1; i < window.length; i++) {
        dist += haversineDistance(
          window[i - 1].lat, window[i - 1].lng,
          window[i].lat, window[i].lng,
        );
      }
      return dist;
    };

    // Require the motion buffer to actually span the evaluation window,
    // otherwise we don't have enough data to judge.
    const bufferSpan = (): number => {
      if (this.motionBuffer.length < 2) return 0;
      return (nowMs - this.motionBuffer[0].timestamp) / 1000;
    };

    if (this.status === 'tracking') {
      if (bufferSpan() < AUTO_PAUSE_STOP_DURATION_S) return;
      const dist = distOver(AUTO_PAUSE_STOP_DURATION_S);
      const meanSpeed = dist / AUTO_PAUSE_STOP_DURATION_S;
      if (meanSpeed < AUTO_PAUSE_STOP_SPEED_MPS) this.triggerAutoPause();
      return;
    }

    if (this.status === 'paused' && this.autoPausedFlag) {
      if (bufferSpan() < AUTO_PAUSE_RESUME_DURATION_S) return;
      const dist = distOver(AUTO_PAUSE_RESUME_DURATION_S);
      const meanSpeed = dist / AUTO_PAUSE_RESUME_DURATION_S;
      if (meanSpeed > AUTO_PAUSE_RESUME_SPEED_MPS) this.triggerAutoResume();
    }
  }

  private triggerAutoPause(): void {
    this.status = 'paused';
    this.pauseStart = Date.now();
    this.autoPausedFlag = true;
    this.notify();
    for (const cb of this.autoPauseListeners) cb();
  }

  private triggerAutoResume(): void {
    const pauseDuration = Date.now() - this.pauseStart;
    this.totalPauseMs += pauseDuration;
    this.segmentPauseMs += pauseDuration;
    this.pauseStart = 0;
    this.status = 'tracking';
    this.autoPausedFlag = false;
    this.notify();
    for (const cb of this.autoResumeListeners) cb();
  }

  /** Check if we've crossed a segment boundary */
  private checkSplitBoundary(): void {
    if (!this.splitScheme) return;
    const segments = this.splitScheme.segments;
    if (this.currentSegmentIdx >= segments.length) return;

    const segment = segments[this.currentSegmentIdx];
    // Use last GPS point timestamp for consistency (not Date.now())
    const lastPoint = this.points.length > 0 ? this.points[this.points.length - 1] : null;
    const now = lastPoint ? lastPoint.timestamp : Date.now();
    const segmentElapsed = Math.max(0, (now - this.segmentStartMs - this.segmentPauseMs) / 1000);

    const isDone = segment.durationSeconds != null
      ? segmentElapsed >= segment.durationSeconds
      : this.segmentDistance >= segment.distance;

    if (isDone) {

      const split: GpsSplit = {
        index: this.completedSplits.length,
        label: segment.label,
        distance: this.segmentDistance,
        elapsed: segmentElapsed,
        pace: calculatePace(this.segmentDistance, segmentElapsed),
        targetPace: segment.targetPace,
      };
      this.completedSplits.push(split);
      // Time-based segments: reset segment distance (recovery distance should not bleed into the next rep).
      // Distance-based segments: carry over excess so sub-second boundary crossings are accurate.
      this.segmentDistance = segment.durationSeconds != null ? 0 : this.segmentDistance - segment.distance;
      this.currentSegmentIdx++;

      // Reset segment timer for the next segment (use point timestamp for consistency)
      this.segmentStartMs = lastPoint ? lastPoint.timestamp : Date.now();
      this.segmentPauseMs = 0;

      // Notify split listeners
      const allDone = this.currentSegmentIdx >= segments.length;
      for (const cb of this.splitListeners) {
        cb(split, allDone);
      }
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
    const segmentElapsed = this.segmentStartMs > 0
      ? Math.max(0, (Date.now() - this.segmentStartMs - this.segmentPauseMs) / 1000)
      : 0;
    return {
      index: this.currentSegmentIdx,
      label: segment.label,
      distance: this.segmentDistance,
      elapsed: segmentElapsed,
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
