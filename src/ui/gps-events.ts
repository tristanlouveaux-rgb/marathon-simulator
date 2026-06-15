import type { Paces, GpsRecording, GpsLiveData, GpsPoint, SplitScheme, Workout } from '@/types';
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

// --- Pre-run acquisition (Garmin-style "Acquiring GPS… → GPS ready" gate) ---
let armedPaces: Paces | null = null;           // paces captured at arm(), reused at confirm
let isTimerOnlyArm = false;                     // permission denied: timer-only fallback armed
let timerOnlyProvider: { pushPoint: (p: GpsPoint) => void } | null = null;

/** Snapshot of acquisition state for the record-view gate UI. */
export interface ArmingData {
  /** True once GPS is locked (or timer-only mode, which is always ready). */
  ready: boolean;
  /** Best fix accuracy in metres, or null before the first fix. */
  accuracy: number | null;
  /** True when location was denied/unavailable and only a timer will run. */
  timerOnly: boolean;
}

// Lifecycle callbacks (wired from main.ts to avoid circular imports)
let onTrackingStartCb: (() => void) | null = null;
let onTrackingStopCb: (() => void) | null = null;
let onTrackingTickCb: ((data: GpsLiveData) => void) | null = null;
let onArmingUpdateCb: ((data: ArmingData) => void) | null = null;

/** Register a callback invoked while a run is armed, on each fix/accuracy change. */
export function setOnArmingUpdate(cb: ((data: ArmingData) => void) | null): void {
  onArmingUpdateCb = cb;
}

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

/** Toggle speed-based auto-pause on the active tracker (mid-run preference change). */
export function setActiveTrackerAutoPause(enabled: boolean): void {
  activeTracker?.setAutoPauseEnabled(enabled);
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
 * Arm GPS acquisition for a workout WITHOUT starting the run clock. The tracker
 * begins searching for a fix; record-view renders the "Acquiring GPS… → GPS
 * ready" gate from isArming()/getArmingData(). The run actually starts on
 * confirmStartTracking() (the user's Start / Start anyway tap). If location is
 * denied we arm a timer-only fallback so "Start anyway" still yields elapsed
 * time (no distance/pace).
 * @param workoutName - Name of the workout being tracked
 * @param workoutDesc - Workout description string (for split scheme)
 * @param paces - Current pace zones
 */
export async function armTracking(
  workoutName: string,
  workoutDesc: string,
  paces: Paces
): Promise<void> {
  if (activeTracker && activeTracker.getStatus() !== 'idle' && activeTracker.getStatus() !== 'stopped') {
    return; // Already armed or tracking
  }

  const provider = createGpsProvider();
  const scheme = buildSplitScheme(workoutDesc, paces);
  const autoPause = getState().gpsAutoPause !== false; // default on

  activeScheme = scheme.segments.length > 0 ? scheme : null;
  activeTracker = new GpsTracker(provider, activeScheme ?? undefined, { autoPause });
  activeWorkoutName = workoutName;
  activeWorkoutDesc = workoutDesc;
  armedPaces = paces;
  lastSplitCount = 0;
  isTimerOnlyArm = false;
  timerOnlyProvider = null;

  wireTrackerCallbacks(activeTracker);

  const armed = await activeTracker.arm();
  if (!armed) {
    // Location denied/unavailable. Arm a timer-only fallback so the user can
    // still "Start anyway" and get elapsed time + time-based splits.
    const { MockGpsProvider } = await import('@/gps/providers/mock-provider');
    const timerProvider = new MockGpsProvider();
    activeTracker = new GpsTracker(timerProvider, activeScheme ?? undefined, { autoPause });
    wireTrackerCallbacks(activeTracker);
    isTimerOnlyArm = true;
    timerOnlyProvider = timerProvider;
    await activeTracker.arm(); // MockGpsProvider always grants
  }

  if (onArmingUpdateCb) onArmingUpdateCb(getArmingData());
}

/** Shared listener wiring for a freshly-built tracker (arm + fallback paths). */
function wireTrackerCallbacks(tracker: GpsTracker): void {
  // Re-render the record view (toggles Pause/Resume, freezes/unfreezes stats) —
  // shared by manual toggle and the auto-pause/resume listeners below.
  const rerenderControls = (): void => { if (onTrackingStartCb) onTrackingStartCb(); };

  tracker.onUpdate((data) => {
    updateInlineGps(data);
    // While armed, push fix/accuracy changes to the acquisition gate UI.
    if (tracker.isArmed() && onArmingUpdateCb) onArmingUpdateCb(getArmingData());
    if (activeGuide) {
      activeGuide.update(data);
      updateGuidedOverlay(activeGuide, data);
    }
  });

  tracker.onSplitComplete((_split, allDone) => {
    if (allDone) {
      workoutCompleteAlert();
    } else {
      splitAlert();
    }
  });

  // Re-render controls when speed-based auto-pause/auto-resume fires, so the
  // button reflects the paused state and shows "Resume". Without this the
  // tracker can sit in an auto-paused state while the button still reads
  // "Pause" and the timer is frozen, looking like a run that won't resume.
  tracker.onAutoPause(rerenderControls);
  tracker.onAutoResume(rerenderControls);
}

/**
 * Confirm the armed run should begin now (GPS ready, or "Start anyway"). Starts
 * guided voice (if enabled), the run clock, and the 1 s tick loop. No-op unless
 * a tracker is currently armed.
 */
export function confirmStartTracking(): void {
  if (!activeTracker || !activeTracker.isArmed()) return;

  // Guided mode: wire voice + haptics now (not during acquisition) so cues
  // don't fire while the user is still standing at the start line.
  const s = getState();
  if (s.guidedRunsEnabled && activeScheme && armedPaces && activeWorkoutName) {
    const workout: Workout = { n: activeWorkoutName, d: activeWorkoutDesc ?? '', r: 0, t: 'guided' };
    activeGuide = new GuideController(workout, armedPaces, {
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

  activeTracker.confirmStart();

  // Timer-only fallback: push a synthetic point so the tracker leaves
  // 'acquiring' and tick()/time-based splits work (accuracy 0 bypasses the gate).
  if (isTimerOnlyArm && timerOnlyProvider) {
    timerOnlyProvider.pushPoint({
      lat: 0, lng: 0, altitude: null, accuracy: 0, speed: 0, timestamp: Date.now(),
    });
  }

  // Update elapsed time display every second; tick() also fires time-based advances.
  timerInterval = setInterval(() => {
    if (activeTracker) {
      activeTracker.tick();
      const data = activeTracker.getLiveData();
      updateInlineGps(data);
      if (onTrackingTickCb) onTrackingTickCb(data);
    }
  }, 1000);

  if (onTrackingStartCb) onTrackingStartCb();
}

/** Abandon a pre-run acquisition (user backed out before starting). */
export function cancelTracking(): void {
  if (!activeTracker) return;
  if (activeTracker.isArmed()) activeTracker.cancelArm();
  activeTracker = null;
  activeWorkoutName = null;
  activeWorkoutDesc = null;
  activeScheme = null;
  armedPaces = null;
  isTimerOnlyArm = false;
  timerOnlyProvider = null;
}

/** True while a run is armed and acquiring GPS (pre-start gate). */
export function isArming(): boolean {
  return activeTracker != null && activeTracker.isArmed();
}

/** Snapshot of acquisition state for the record-view gate UI. */
export function getArmingData(): ArmingData {
  if (!activeTracker) return { ready: false, accuracy: null, timerOnly: false };
  return {
    ready: isTimerOnlyArm || activeTracker.isGpsReady(),
    accuracy: activeTracker.getLiveData().accuracy,
    timerOnly: isTimerOnlyArm,
  };
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

/** Confirm Start from the acquisition gate (GPS ready or "Start anyway"). */
function gpsConfirmStart(): void {
  confirmStartTracking();
  if (onTrackingStartCb) onTrackingStartCb(); // re-render record view into live mode
}

/** Back out of the acquisition gate before the run starts. */
function gpsCancelStart(): void {
  cancelTracking();
  void import('./record-view').then(({ renderRecordView }) => renderRecordView());
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
    gpsConfirmStart: typeof gpsConfirmStart;
    gpsCancelStart: typeof gpsCancelStart;
    trackWorkout: (name: string, desc: string) => void;
  }
}

if (typeof window !== 'undefined') {
  window.gpsPause = gpsPause;
  window.gpsResume = gpsResume;
  window.gpsStop = gpsStop;
  window.gpsLap = gpsLap;
  window.gpsConfirmStart = gpsConfirmStart;
  window.gpsCancelStart = gpsCancelStart;
}

/**
 * Called from "Track Run" / "Start session" buttons on a workout card. Arms GPS
 * acquisition and navigates to the Record tab, where the user sees the
 * "Acquiring GPS… → GPS ready" gate and confirms the actual start.
 */
if (typeof window !== 'undefined') {
  window.trackWorkout = async (name: string, desc: string) => {
    const s = getState();
    await armTracking(name, desc, s.pac || { e: 330, t: 270, i: 240, m: 285, r: 210 });
    const { renderRecordView } = await import('./record-view');
    renderRecordView();
  };
}
