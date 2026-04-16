import type { GpsLiveData } from '@/types';
import type { Step, Timeline } from './timeline';

export type PaceStatus = 'onPace' | 'fast' | 'slow';

export type CueEvent =
  | { type: 'stepStart'; step: Step; nextStep: Step | null }
  | { type: 'stepHalfway'; step: Step }
  | { type: 'stepNextPreview'; step: Step; nextStep: Step; remainingSec: number }
  | { type: 'stepCountdown'; step: Step; secondsLeft: number }
  | { type: 'stepEnd'; step: Step }
  | { type: 'timelineComplete' }
  | {
      type: 'kmSplit';
      step: Step;
      kmIdx: number;            // 1-based km index within the step
      splitTimeSec: number;     // time for this km, seconds
      splitPaceSec: number;     // actual pace, sec/km
      targetPaceSec: number | null;
      deviationSec: number | null;   // splitPace - target; +ve = slow, -ve = fast
      status: PaceStatus;
    }
  | {
      type: 'paceCheck';
      step: Step;
      currentPaceSec: number;
      targetPaceSec: number;
      deviationSec: number;
      status: PaceStatus;
    };

export type CueCallback = (event: CueEvent) => void;

export interface GuideEngineOptions {
  /** Seconds of silent countdown before a step ends. Default 5. */
  countdownSec?: number;
  /** Seconds before recovery ends to emit the "next up" preview. Default 30. */
  recoveryPreviewSec?: number;
}

export interface StepProgress {
  step: Step | null;
  stepIdx: number;
  stepElapsedSec: number;
  stepDistanceM: number;
  stepRemainingSec: number | null;
  stepRemainingM: number | null;
  timelineComplete: boolean;
}

const DEFAULT_COUNTDOWN_SEC = 5;
const DEFAULT_RECOVERY_PREVIEW_SEC = 30;
/** Per-km split within ±5 sec/km of target counts as on-pace. */
const PACE_TOLERANCE_SEC_PER_KM = 5;
/** A "short rep" is one where per-km splits aren't meaningful. */
const SHORT_REP_DURATION_SEC = 300;
const SHORT_REP_DISTANCE_M = 2000;
/** Fraction into a short rep at which the single mid-rep pace check fires. */
const MID_REP_CHECK_FRACTION = 0.3;

/**
 * Drives a Timeline forward using GpsLiveData ticks from the GpsTracker.
 * Emits cue events the voice/haptic/UI layers subscribe to.
 *
 * Follows tracker pause (manual or auto) because GpsLiveData.elapsed
 * and totalDistance are frozen while paused.
 */
export class GuideEngine {
  private timeline: Timeline;
  private countdownSec: number;
  private recoveryPreviewSec: number;
  private listeners: CueCallback[] = [];

  private started = false;
  private complete = false;
  private stepIdx = 0;
  private stepStartElapsed = 0;      // tracker elapsed when current step started
  private stepStartDistance = 0;     // tracker totalDistance when current step started

  // Per-step flags, reset on step advance.
  private emittedStart = false;
  private emittedHalfway = false;
  private emittedPreview = false;
  private emittedCountdown = new Set<number>();
  private lastKmEmitted = 0;                 // # of km splits already announced in current step
  private lastKmElapsedAtCross = 0;          // step-elapsed when last km boundary was crossed
  private emittedPaceCheck = false;          // mid-rep pace check fired for this short rep

  constructor(timeline: Timeline, options: GuideEngineOptions = {}) {
    this.timeline = timeline;
    this.countdownSec = options.countdownSec ?? DEFAULT_COUNTDOWN_SEC;
    this.recoveryPreviewSec = options.recoveryPreviewSec ?? DEFAULT_RECOVERY_PREVIEW_SEC;
  }

  onCue(cb: CueCallback): void {
    this.listeners.push(cb);
  }

  offCue(cb: CueCallback): void {
    this.listeners = this.listeners.filter((l) => l !== cb);
  }

  /** Begin driving the timeline. Call once at the start of the guided run. */
  start(): void {
    this.started = true;
  }

  /** Advance past the current step immediately (user tapped "Skip"). */
  skipStep(): void {
    if (!this.started || this.complete) return;
    this.endCurrentStep();
  }

  /**
   * Extend the current step by `sec` seconds, capped at 2× the original duration.
   * Returns the actual seconds applied (0 if already at cap), so callers can keep
   * the tracker's SplitScheme in lockstep.
   */
  extendCurrentStep(sec: number): number {
    const step = this.currentStep();
    if (!step || step.durationSec == null) return 0;
    if (step.originalDurationSec == null) step.originalDurationSec = step.durationSec;
    const cap = step.originalDurationSec * 2;
    const available = Math.max(0, cap - step.durationSec);
    const applied = Math.min(sec, available);
    step.durationSec += applied;
    return applied;
  }

  /** Remaining extension allowance for the current step, in seconds. */
  currentStepExtensionRemaining(): number {
    const step = this.currentStep();
    if (!step || step.durationSec == null) return 0;
    const original = step.originalDurationSec ?? step.durationSec;
    return Math.max(0, original * 2 - step.durationSec);
  }

  currentStep(): Step | null {
    if (!this.started || this.complete) return null;
    return this.timeline.steps[this.stepIdx] ?? null;
  }

  /** Progress snapshot for UI rendering. */
  getProgress(data: GpsLiveData): StepProgress {
    const step = this.currentStep();
    if (!step) {
      return {
        step: null,
        stepIdx: this.stepIdx,
        stepElapsedSec: 0,
        stepDistanceM: 0,
        stepRemainingSec: null,
        stepRemainingM: null,
        timelineComplete: this.complete,
      };
    }
    const elapsed = data.elapsed - this.stepStartElapsed;
    const dist = data.totalDistance - this.stepStartDistance;
    return {
      step,
      stepIdx: this.stepIdx,
      stepElapsedSec: elapsed,
      stepDistanceM: dist,
      stepRemainingSec: step.durationSec != null ? Math.max(0, step.durationSec - elapsed) : null,
      stepRemainingM: step.distanceM != null ? Math.max(0, step.distanceM - dist) : null,
      timelineComplete: this.complete,
    };
  }

  /** Call on every GpsLiveData update from the tracker. */
  update(data: GpsLiveData): void {
    if (!this.started || this.complete) return;
    if (data.status !== 'tracking' && data.status !== 'paused') return;

    const step = this.currentStep();
    if (!step) return;

    // Emit stepStart on first update for each step.
    if (!this.emittedStart) {
      this.stepStartElapsed = data.elapsed;
      this.stepStartDistance = data.totalDistance;
      this.emittedStart = true;
      this.emit({
        type: 'stepStart',
        step,
        nextStep: this.timeline.steps[this.stepIdx + 1] ?? null,
      });
    }

    // Don't advance cues while paused — step time/distance is frozen anyway.
    if (data.status === 'paused') return;

    const stepElapsed = data.elapsed - this.stepStartElapsed;
    const stepDist = data.totalDistance - this.stepStartDistance;

    const isDurationStep = step.durationSec != null;
    const totalForStep = isDurationStep ? step.durationSec! : step.distanceM ?? 0;
    const progressForStep = isDurationStep ? stepElapsed : stepDist;
    const remainingSec = isDurationStep ? step.durationSec! - stepElapsed : null;

    // Halfway cue.
    if (!this.emittedHalfway && totalForStep > 0 && progressForStep >= totalForStep / 2) {
      this.emittedHalfway = true;
      this.emit({ type: 'stepHalfway', step });
    }

    // Recovery-specific: "next up" preview at T-30s (before the silent countdown).
    if (
      !this.emittedPreview &&
      step.type === 'recovery' &&
      remainingSec != null &&
      remainingSec <= this.recoveryPreviewSec &&
      remainingSec > this.countdownSec
    ) {
      const nextStep = this.timeline.steps[this.stepIdx + 1];
      if (nextStep) {
        this.emittedPreview = true;
        this.emit({ type: 'stepNextPreview', step, nextStep, remainingSec });
      }
    }

    // Silent countdown 5..1 (only for duration-based steps).
    if (remainingSec != null) {
      for (let s = this.countdownSec; s >= 1; s--) {
        if (!this.emittedCountdown.has(s) && remainingSec <= s && remainingSec > s - 1) {
          this.emittedCountdown.add(s);
          this.emit({ type: 'stepCountdown', step, secondsLeft: s });
        }
      }
    }

    // Per-km split announcements (fires when step distance crosses a 1km boundary).
    const targetKmMeters = (this.lastKmEmitted + 1) * 1000;
    if (stepDist >= targetKmMeters) {
      const splitTimeSec = stepElapsed - this.lastKmElapsedAtCross;
      const splitPaceSec = splitTimeSec > 0 ? splitTimeSec : 0;
      const target = step.targetPaceSec ?? null;
      const deviation = target != null ? splitPaceSec - target : null;
      const status: PaceStatus = deviation == null
        ? 'onPace'
        : Math.abs(deviation) <= PACE_TOLERANCE_SEC_PER_KM
          ? 'onPace'
          : deviation > 0 ? 'slow' : 'fast';
      this.lastKmEmitted++;
      this.lastKmElapsedAtCross = stepElapsed;
      this.emit({
        type: 'kmSplit',
        step,
        kmIdx: this.lastKmEmitted,
        splitTimeSec,
        splitPaceSec,
        targetPaceSec: target,
        deviationSec: deviation,
        status,
      });
    }

    // Mid-rep pace check on short paced work steps (intervals <5min or <2km).
    if (!this.emittedPaceCheck && isShortPacedWorkStep(step) && data.currentPace != null) {
      const fraction = totalForStep > 0 ? progressForStep / totalForStep : 0;
      if (fraction >= MID_REP_CHECK_FRACTION) {
        this.emittedPaceCheck = true;
        const target = step.targetPaceSec!;
        const deviation = data.currentPace - target;
        if (Math.abs(deviation) > PACE_TOLERANCE_SEC_PER_KM) {
          const status: PaceStatus = deviation > 0 ? 'slow' : 'fast';
          this.emit({
            type: 'paceCheck',
            step,
            currentPaceSec: data.currentPace,
            targetPaceSec: target,
            deviationSec: deviation,
            status,
          });
        }
      }
    }

    // Step completion.
    const isDone = isDurationStep
      ? stepElapsed >= step.durationSec!
      : step.distanceM != null && stepDist >= step.distanceM;
    if (isDone) this.endCurrentStep();
  }

  private endCurrentStep(): void {
    const step = this.currentStep();
    if (!step) return;
    this.emit({ type: 'stepEnd', step });
    this.stepIdx++;
    this.emittedStart = false;
    this.emittedHalfway = false;
    this.emittedPreview = false;
    this.emittedCountdown = new Set();
    this.lastKmEmitted = 0;
    this.lastKmElapsedAtCross = 0;
    this.emittedPaceCheck = false;
    if (this.stepIdx >= this.timeline.steps.length) {
      this.complete = true;
      this.emit({ type: 'timelineComplete' });
    }
  }

  private emit(event: CueEvent): void {
    for (const cb of this.listeners) cb(event);
  }
}

function isShortPacedWorkStep(step: Step): boolean {
  if (step.type !== 'work' || step.targetPaceSec == null) return false;
  if (step.durationSec != null) return step.durationSec < SHORT_REP_DURATION_SEC;
  if (step.distanceM != null) return step.distanceM < SHORT_REP_DISTANCE_M;
  return false;
}
