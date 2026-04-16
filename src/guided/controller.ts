import type { GpsLiveData, GuidedCueLogEntry, Paces, Workout } from '@/types';
import { buildTimeline, type Step, type Timeline } from './timeline';
import { GuideEngine, type CueEvent, type StepProgress } from './engine';
import { VoiceCoach } from './voice';
import { HapticsCoach } from './haptics';

const CUE_LOG_CAP = 100;

export interface GuideControllerOptions {
  voice?: boolean;
  haptics?: boolean;
  splitAnnouncements?: boolean;
  /** Speech rate, 0.8–1.4, default 1.0. */
  voiceRate?: number;
}

/**
 * Facade that composes GuideEngine + VoiceCoach + HapticsCoach into a single unit.
 * Lifecycle:
 *   const ctrl = new GuideController(workout, paces, opts);
 *   ctrl.start();
 *   // each tracker tick:
 *   ctrl.update(liveData);
 *   // on stop:
 *   ctrl.destroy();
 */
export class GuideController {
  private timeline: Timeline;
  private engine: GuideEngine;
  private voice: VoiceCoach | null;
  private haptics: HapticsCoach | null;
  private uiListeners: Array<(e: CueEvent) => void> = [];
  private cueLog: GuidedCueLogEntry[] = [];
  private lastElapsedSec = 0;
  private cueRelay = (event: CueEvent) => {
    this.appendCueLog(event);
    for (const cb of this.uiListeners) cb(event);
  };

  private appendCueLog(event: CueEvent): void {
    const step = ('step' in event ? event.step : null) ?? this.engine.currentStep();
    this.cueLog.push({
      ts: Date.now(),
      elapsedSec: this.lastElapsedSec,
      type: event.type,
      stepIdx: step?.idx ?? -1,
      stepLabel: step?.label ?? '',
    });
    if (this.cueLog.length > CUE_LOG_CAP) this.cueLog.shift();
  }

  constructor(workout: Workout, paces: Paces, options: GuideControllerOptions = {}) {
    const voiceOn = options.voice ?? true;
    const hapticsOn = options.haptics ?? true;
    this.timeline = buildTimeline(workout, paces);
    this.engine = new GuideEngine(this.timeline);
    this.voice = voiceOn
      ? new VoiceCoach({ splitAnnouncements: options.splitAnnouncements ?? true, rate: options.voiceRate ?? 1.0 })
      : null;
    this.haptics = hapticsOn ? new HapticsCoach() : null;
    if (this.voice) this.voice.attach(this.engine);
    if (this.haptics) this.haptics.attach(this.engine);
    this.engine.onCue(this.cueRelay);
  }

  getTimeline(): Timeline {
    return this.timeline;
  }

  currentStep(): Step | null {
    return this.engine.currentStep();
  }

  getProgress(data: GpsLiveData): StepProgress {
    return this.engine.getProgress(data);
  }

  /** Subscribe to cue events for UI rendering (e.g. rest-overlay "next up" preview). */
  onCue(cb: (e: CueEvent) => void): void {
    this.uiListeners.push(cb);
  }

  offCue(cb: (e: CueEvent) => void): void {
    this.uiListeners = this.uiListeners.filter((l) => l !== cb);
  }

  start(): void {
    this.engine.start();
  }

  update(data: GpsLiveData): void {
    this.lastElapsedSec = data.elapsed ?? 0;
    this.engine.update(data);
  }

  /** Snapshot of the cue ring buffer (last 100 events). For support diagnostics. */
  getCueLog(): GuidedCueLogEntry[] {
    return this.cueLog.slice();
  }

  /**
   * Skip the current step. Advances the engine AND the tracker in lockstep so
   * the SplitScheme doesn't keep counting the abandoned segment.
   */
  skipStep(tracker?: { skipSegment(): void }): void {
    this.engine.skipStep();
    tracker?.skipSegment();
  }

  /**
   * Extend the current step. Mutates both the engine's Timeline and the tracker's
   * SplitScheme so the countdown and the split boundary stay in sync.
   */
  extendCurrentStep(sec: number, tracker?: { extendSegment(sec: number): number | null }): number {
    const applied = this.engine.extendCurrentStep(sec);
    if (applied > 0) tracker?.extendSegment(applied);
    return applied;
  }

  /** Remaining +30s allowance for the current step (0 if capped or not in a timed step). */
  currentStepExtensionRemaining(): number {
    return this.engine.currentStepExtensionRemaining();
  }

  setSplitAnnouncementsEnabled(enabled: boolean): void {
    this.voice?.setSplitAnnouncementsEnabled(enabled);
  }

  setVoiceRate(rate: number): void {
    this.voice?.setRate(rate);
  }

  setHapticsEnabled(enabled: boolean): void {
    this.haptics?.setEnabled(enabled);
  }

  /** Stop ongoing speech, detach from engine. Call when the run ends or is cancelled. */
  destroy(): void {
    if (this.voice) {
      this.voice.cancel();
      this.voice.detach(this.engine);
    }
    if (this.haptics) this.haptics.detach(this.engine);
    this.engine.offCue(this.cueRelay);
    this.uiListeners = [];
  }
}
