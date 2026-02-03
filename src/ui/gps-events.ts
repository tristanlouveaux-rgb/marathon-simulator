import type { Paces, GpsRecording, GpsLiveData } from '@/types';
import { GpsTracker } from '@/gps/tracker';
import { buildSplitScheme } from '@/gps/split-scheme';
import { createGpsProvider } from '@/gps/providers';
import { saveGpsRecording } from '@/gps/persistence';
import { updateInlineGps } from './gps-panel';
import { getState } from '@/state';

let activeTracker: GpsTracker | null = null;
let activeWorkoutName: string | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;

// Lifecycle callbacks (wired from main.ts to avoid circular imports)
let onTrackingStartCb: (() => void) | null = null;
let onTrackingStopCb: (() => void) | null = null;

/** Register a callback invoked after tracking starts or state changes (pause/resume). */
export function setOnTrackingStart(cb: () => void): void {
  onTrackingStartCb = cb;
}

/** Register a callback invoked after tracking stops. */
export function setOnTrackingStop(cb: () => void): void {
  onTrackingStopCb = cb;
}

// --- State getters for renderer ---

export function getActiveWorkoutName(): string | null {
  return activeWorkoutName;
}

export function getActiveGpsData(): GpsLiveData | null {
  if (!activeTracker) return null;
  return activeTracker.getLiveData();
}

export function isTrackingActive(): boolean {
  if (!activeTracker) return false;
  const status = activeTracker.getStatus();
  return status !== 'idle' && status !== 'stopped';
}

/**
 * Start GPS tracking for a workout.
 * @param workoutName - Name of the workout being tracked
 * @param workoutDesc - Workout description string (for split scheme)
 * @param paces - Current pace zones
 */
export async function startTracking(
  workoutName: string,
  workoutDesc: string,
  paces: Paces
): Promise<void> {
  if (activeTracker && activeTracker.getStatus() !== 'idle' && activeTracker.getStatus() !== 'stopped') {
    return; // Already tracking
  }

  const provider = createGpsProvider();
  const scheme = buildSplitScheme(workoutDesc, paces);

  activeTracker = new GpsTracker(provider, scheme.segments.length > 0 ? scheme : undefined);
  activeWorkoutName = workoutName;

  activeTracker.onUpdate(updateInlineGps);

  const started = await activeTracker.start();
  if (!started) {
    activeTracker = null;
    activeWorkoutName = null;
    alert('GPS permission denied');
    return;
  }

  // Update elapsed time display every second
  timerInterval = setInterval(() => {
    if (activeTracker) {
      updateInlineGps(activeTracker.getLiveData());
    }
  }, 1000);
}

/** Toggle pause/resume */
export function togglePause(): void {
  if (!activeTracker) return;
  const status = activeTracker.getStatus();
  if (status === 'tracking') {
    activeTracker.pause();
  } else if (status === 'paused') {
    activeTracker.resume();
  }
  // Re-render so inline buttons update
  if (onTrackingStartCb) onTrackingStartCb();
}

/** Stop tracking and save the recording */
export function stopTracking(): void {
  if (!activeTracker) return;

  activeTracker.stop();

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // Save recording
  const data = activeTracker.getLiveData();
  const s = getState();

  if (data.totalDistance > 10) {
    const recording: GpsRecording = {
      id: `gps_${Date.now()}`,
      workoutName: activeWorkoutName || 'Unknown',
      week: s.w || 1,
      date: new Date().toISOString(),
      route: activeTracker.getPoints(),
      splits: data.completedSplits,
      totalDistance: data.totalDistance,
      totalElapsed: data.elapsed,
      averagePace: data.totalDistance > 0 ? (data.elapsed / data.totalDistance) * 1000 : 0,
    };
    saveGpsRecording(recording);
  }

  activeTracker = null;
  activeWorkoutName = null;

  if (onTrackingStopCb) onTrackingStopCb();
}

function gpsPause(): void {
  togglePause();
}

function gpsResume(): void {
  togglePause();
}

function gpsStop(): void {
  stopTracking();
}

// Expose to window for onclick handlers
declare global {
  interface Window {
    gpsPause: typeof gpsPause;
    gpsResume: typeof gpsResume;
    gpsStop: typeof gpsStop;
    trackWorkout: (name: string, desc: string) => void;
  }
}

window.gpsPause = gpsPause;
window.gpsResume = gpsResume;
window.gpsStop = gpsStop;

/**
 * Called from "Track Run" button on a workout card.
 */
window.trackWorkout = async (name: string, desc: string) => {
  const s = getState();
  await startTracking(name, desc, s.pac || { e: 330, t: 270, i: 240, m: 285, r: 210 });
  if (onTrackingStartCb) onTrackingStartCb();
};
