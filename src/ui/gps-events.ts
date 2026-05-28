import type { Paces, GpsRecording, GpsLiveData, SplitScheme, Workout } from '@/types';
import { GpsTracker } from '@/gps/tracker';
import { buildSplitScheme } from '@/gps/split-scheme';
import { createGpsProvider } from '@/gps/providers';
import { saveGpsRecording } from '@/gps/persistence';
import { handleCompletedRecording } from '@/gps/recording-handler';
import { splitAlert, workoutCompleteAlert } from '@/gps/haptics';
import { updateInlineGps } from './gps-panel';
import { getState } from '@/state';
import { GuideController } from '@/guided/controller';
import { mountGuidedOverlay, unmountGuidedOverlay, updateGuidedOverlay } from './guided-overlay';
import { acquireWakeLock, releaseWakeLock } from '@/utils/wake-lock';

let activeTracker: GpsTracker | null = null;
let activeGuide: GuideController | null = null;
let activeWorkoutName: string | null = null;
let activeWorkoutDesc: string | null = null;
let activeScheme: SplitScheme | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let lastSplitCount = 0;

// Lifecycle callbacks (wired from main.ts to avoid circular imports)
let onTrackingStartCb: (() => void) | null = null;
let onTrackingStopCb: (() => void) | null = null;
let onTrackingTickCb: ((data: GpsLiveData) => void) | null = null;

/** Register a callback invoked after tracking starts or state changes (pause/resume). */
export function setOnTrackingStart(cb: () => void): void {
  onTrackingStartCb = cb;
}

/** Register a callback invoked after tracking stops. */
export function setOnTrackingStop(cb: () => void): void {
  onTrackingStopCb = cb;
}

/** Register a callback invoked every second with live GPS data while tracking. */
export function setOnTrackingTick(cb: ((data: GpsLiveData) => void) | null): void {
  onTrackingTickCb = cb;
}

/** Return the active split scheme (structured workouts), or null for simple runs. */
export function getActiveSplitScheme(): SplitScheme | null {
  return activeScheme;
}

/** Return the active GuideController if guided mode is running, else null. */
export function getActiveGuideController(): GuideController | null {
  return activeGuide;
}

/** Skip the current guided step, advancing both engine and tracker splits in lockstep. */
export function guidedSkipStep(): void {
  if (!activeGuide) return;
  const tracker = activeTracker;
  const adapter = tracker ? { skipSegment: () => tracker.skipSegment() } : undefined;
  activeGuide.skipStep(adapter);
}

/** Disable guided coaching on the active run — stops voice and removes overlay. */
export function disableActiveGuide(): void {
  if (!activeGuide) return;
  activeGuide.destroy();
  activeGuide = null;
  unmountGuidedOverlay();
  void releaseWakeLock();
}

/** Forward a split-announcements toggle to the active guide, if any. */
export function setActiveGuideSplitAnnouncements(enabled: boolean): void {
  activeGuide?.setSplitAnnouncementsEnabled(enabled);
}

/** Forward a voice-rate change to the active guide, if any. */
export function setActiveGuideVoiceRate(rate: number): void {
  activeGuide?.setVoiceRate(rate);
}

/** Extend the current guided step by `sec` seconds, mutating both engine and tracker. */
export function guidedExtendCurrentStep(sec: number): void {
  if (!activeGuide) return;
  const tracker = activeTracker;
  const adapter = tracker ? { extendSegment: (s: number) => tracker.extendSegment(s) } : undefined;
  activeGuide.extendCurrentStep(sec, adapter);
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

export function isTrackingPaused(): boolean {
  if (!activeTracker) return false;
  return activeTracker.getStatus() === 'paused';
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

  activeScheme = scheme.segments.length > 0 ? scheme : null;
  activeTracker = new GpsTracker(provider, activeScheme ?? undefined);
  activeWorkoutName = workoutName;
  activeWorkoutDesc = workoutDesc;
  lastSplitCount = 0;

  // Guided mode: wire voice + haptics to step-by-step cues.
  const s = getState();
  if (s.guidedRunsEnabled && activeScheme) {
    const workout: Workout = { n: workoutName, d: workoutDesc, r: 0, t: 'guided' };
    activeGuide = new GuideController(workout, paces, {
      splitAnnouncements: s.guidedSplitAnnouncements ?? true,
      voiceRate: s.guidedVoiceRate ?? 1.0,
    });
    activeGuide.start();
    mountGuidedOverlay(activeGuide);
    // Keep the screen awake so the 1s tick interval stays unthrottled and voice
    // cues fire on time. Default ON; user can disable in Account → Preferences.
    if (s.guidedKeepScreenOn !== false) {
      void acquireWakeLock();
    }
  }

  activeTracker.onUpdate((data) => {
    updateInlineGps(data);
    if (activeGuide) {
      activeGuide.update(data);
      updateGuidedOverlay(activeGuide, data);
    }
  });

  // Wire split completion alerts
  activeTracker.onSplitComplete((_split, allDone) => {
    if (allDone) {
      workoutCompleteAlert();
    } else {
      splitAlert();
    }
  });

  const started = await activeTracker.start();
  if (!started) {
    // GPS denied. Fall back to timer-only mode (no distance/pace, but
    // elapsed time and time-based splits still work)
    const { MockGpsProvider } = await import('@/gps/providers/mock-provider');
    const timerProvider = new MockGpsProvider();
    activeTracker = new GpsTracker(timerProvider, activeScheme ?? undefined);
    activeTracker.onUpdate((data) => {
      updateInlineGps(data);
      if (activeGuide) {
        activeGuide.update(data);
        updateGuidedOverlay(activeGuide, data);
      }
    });
    activeTracker.onSplitComplete((_split, allDone) => {
      if (allDone) workoutCompleteAlert(); else splitAlert();
    });
    await activeTracker.start(); // MockGpsProvider always grants
    // Push a synthetic point to transition from 'acquiring' to 'tracking'
    // so tick() and the timer work (accuracy 0 = perfect, bypasses the >30 filter)
    timerProvider.pushPoint({
      lat: 0, lng: 0, altitude: null, accuracy: 0, speed: 0, timestamp: Date.now(),
    });
  }

  // Update elapsed time display every second; tick() also fires time-based segment advances
  timerInterval = setInterval(() => {
    if (activeTracker) {
      activeTracker.tick();
      const data = activeTracker.getLiveData();
      updateInlineGps(data);
      if (onTrackingTickCb) onTrackingTickCb(data);
    }
  }, 1000);
}

/** Toggle pause/resume */
export function togglePause(): void {
  if (!activeTracker) return;
  const status = activeTracker.getStatus();
  if (status === 'tracking' || status === 'acquiring') {
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
  const workoutName = activeWorkoutName || 'Unknown';

  if (data.totalDistance > 10 || data.elapsed > 5) {
    const recording: GpsRecording = {
      id: `gps_${Date.now()}`,
      workoutName,
      week: s.w || 1,
      date: new Date().toISOString(),
      route: activeTracker.getPoints(),
      splits: data.completedSplits,
      totalDistance: data.totalDistance,
      totalElapsed: data.elapsed,
      averagePace: data.totalDistance > 0 ? (data.elapsed / data.totalDistance) * 1000 : 0,
      ...(activeGuide ? { cueLog: activeGuide.getCueLog() } : {}),
    };
    saveGpsRecording(recording);

    // Clean up tracker state before showing modal
    if (activeGuide) { activeGuide.destroy(); activeGuide = null; unmountGuidedOverlay(); }
    void releaseWakeLock();
    activeTracker = null;
    activeWorkoutName = null;
    activeWorkoutDesc = null;
    activeScheme = null;
    lastSplitCount = 0;

    // Show completion modal instead of just re-rendering
    handleCompletedRecording(recording, workoutName);

    if (onTrackingStopCb) onTrackingStopCb();
    return;
  }

  // Distance too short. Discard silently
  void releaseWakeLock();
  activeTracker = null;
  activeWorkoutName = null;
  activeWorkoutDesc = null;
  activeScheme = null;
  lastSplitCount = 0;

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

/**
 * Manual lap capture. No-op when a structured split scheme is active (the
 * scheme owns the splits) — see `GpsTracker.captureLap`. When a lap lands,
 * we patch a small "Last lap" readout in the record-view header so the
 * runner gets immediate visual feedback, plus a haptic pulse to confirm
 * the press registered without needing to look at the screen.
 */
function gpsLap(): void {
  if (!activeTracker) return;
  const split = activeTracker.captureLap();
  if (!split) return;
  // Light haptic so the runner knows the press registered even mid-stride.
  try {
    if (typeof navigator !== 'undefined' && typeof (navigator as { vibrate?: (p: number | number[]) => boolean }).vibrate === 'function') {
      (navigator as { vibrate: (p: number | number[]) => boolean }).vibrate(60);
    }
  } catch { /* no-op */ }
  // Cheap inline readout patch — record-view's `rec-last-lap` element gets
  // updated if it exists. If the element isn't rendered (e.g. structured
  // workout), the patch is silently skipped.
  const el = typeof document !== 'undefined' ? document.getElementById('rec-last-lap') : null;
  if (el) {
    const min = Math.floor(split.elapsed / 60);
    const sec = Math.round(split.elapsed % 60);
    const mm = String(min);
    const ss = String(sec).padStart(2, '0');
    const meters = Math.round(split.distance);
    el.textContent = `${split.label}: ${mm}:${ss} · ${meters}m`;
    el.style.opacity = '1';
  }
}

// Expose to window for onclick handlers
declare global {
  interface Window {
    gpsPause: typeof gpsPause;
    gpsResume: typeof gpsResume;
    gpsStop: typeof gpsStop;
    gpsLap: typeof gpsLap;
    trackWorkout: (name: string, desc: string) => void;
  }
}

if (typeof window !== 'undefined') {
  window.gpsPause = gpsPause;
  window.gpsResume = gpsResume;
  window.gpsStop = gpsStop;
  window.gpsLap = gpsLap;
}

/**
 * Called from "Track Run" button on a workout card.
 * Starts tracking then navigates to the Record tab.
 */
if (typeof window !== 'undefined') {
  window.trackWorkout = async (name: string, desc: string) => {
    const s = getState();
    await startTracking(name, desc, s.pac || { e: 330, t: 270, i: 240, m: 285, r: 210 });
    const { renderRecordView } = await import('./record-view');
    renderRecordView();
  };
}
