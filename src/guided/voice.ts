import { Capacitor, registerPlugin } from '@capacitor/core';
import type { CueEvent } from './engine';
import type { Step } from './timeline';

interface GuidedVoicePlugin {
  speak(options: { text: string; rate: number }): Promise<void>;
  cancel(): Promise<void>;
}

// Registered lazily — the web shim throws on speak()/cancel() so we only call it on native.
const NativeVoice = registerPlugin<GuidedVoicePlugin>('GuidedVoice');

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export interface VoiceCoachOptions {
  /** Per-km split announcements on paced work steps. Default true. */
  splitAnnouncements?: boolean;
  /** Speech rate (1.0 = normal). Default 1.0. */
  rate?: number;
}

export interface PhraseOptions {
  splitAnnouncements: boolean;
}

/**
 * Pure text composition for cue events.
 * Returns null for events that should produce no speech (e.g. silent countdown).
 */
export function composePhrase(event: CueEvent, opts: PhraseOptions): string | null {
  switch (event.type) {
    case 'stepStart':
      return stepStartPhrase(event.step);
    case 'stepNextPreview':
      return `Thirty seconds. Next up: ${nextStepSummary(event.nextStep)}.`;
    case 'stepCountdown':
      // Countdown is handled by haptics (silent ticks).
      return null;
    case 'stepEnd':
      return null;
    case 'stepHalfway':
      return null;
    case 'timelineComplete':
      return 'Workout complete.';
    case 'kmSplit':
      return kmSplitPhrase(event, opts);
    case 'paceCheck':
      return event.status === 'fast' ? 'Ease back.' : 'Pick it up.';
    default:
      return null;
  }
}

function stepStartPhrase(step: Step): string {
  switch (step.type) {
    case 'warmup':
      return `Warm-up. ${formatKm(step.distanceM)} easy.`;
    case 'cooldown':
      return `Cool-down. ${formatKm(step.distanceM)} easy.`;
    case 'recovery':
      return `Recover. ${formatSeconds(step.durationSec)} easy.`;
    case 'easy':
      return `${formatKm(step.distanceM)} easy.`;
    case 'long':
      return `Long run. ${formatKm(step.distanceM)} easy.`;
    case 'work':
      return `Go. ${step.label}. ${workTargetPhrase(step)}.`;
  }
}

function workTargetPhrase(step: Step): string {
  const parts: string[] = [];
  if (step.durationSec != null) parts.push(formatSeconds(step.durationSec));
  else if (step.distanceM != null) parts.push(formatKm(step.distanceM));
  if (step.targetPaceSec != null) parts.push(`at ${formatPace(step.targetPaceSec)} per kilometre`);
  return parts.join(' ');
}

function nextStepSummary(step: Step): string {
  if (step.type === 'work') {
    return `${step.label}, ${workTargetPhrase(step)}`;
  }
  return stepStartPhrase(step).replace(/\.$/, '');
}

function kmSplitPhrase(
  event: Extract<CueEvent, { type: 'kmSplit' }>,
  opts: PhraseOptions,
): string | null {
  if (!opts.splitAnnouncements) return null;
  const isPacedWork = event.step.type === 'work' && event.targetPaceSec != null;
  const isEasy = !isPacedWork;

  // Easy-tone steps: only speak if too fast.
  if (isEasy && event.status !== 'fast') return null;

  const prefix = `Kilometre ${event.kmIdx}. ${formatPace(event.splitPaceSec)}.`;
  if (event.status === 'onPace') return `${prefix} On pace.`;
  if (event.status === 'fast') {
    const sec = Math.round(Math.abs(event.deviationSec ?? 0));
    return `${prefix} ${sec} seconds fast. Ease this one.`;
  }
  // slow
  const sec = Math.round(Math.abs(event.deviationSec ?? 0));
  return `${prefix} ${sec} seconds behind target.`;
}

/** Format meters → "5 kilometres" / "500 metres". */
function formatKm(meters: number | undefined): string {
  if (meters == null) return '';
  if (meters < 1000) return `${Math.round(meters)} metres`;
  const km = meters / 1000;
  const rounded = Math.round(km * 10) / 10;
  return rounded === 1 ? '1 kilometre' : `${rounded} kilometres`;
}

/** Format seconds → "90 seconds" / "3 minutes" / "4 minutes 30". */
function formatSeconds(sec: number | undefined): string {
  if (sec == null) return '';
  // Under 2 minutes, keep in seconds — more natural for short recoveries.
  if (sec < 120) return `${Math.round(sec)} seconds`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec - min * 60);
  if (rem === 0) return min === 1 ? '1 minute' : `${min} minutes`;
  return `${min} minutes ${rem} seconds`;
}

/** Format seconds/km → "4:15". */
function formatPace(secPerKm: number): string {
  const total = Math.round(secPerKm);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Voice coach. Subscribe via `attach(engine)`.
 *
 * On native iOS, `speak()`/`cancel()` delegate to the `GuidedVoice` Capacitor
 * plugin which wraps AVSpeechSynthesizer + AVAudioSession(.playback,
 * .voicePrompt, [.duckOthers, .mixWithOthers]) — music ducks and speech plays
 * over the silent switch.
 *
 * On web we fall back to the Web Speech API. Ducking isn't available on the
 * web platform; speech simply plays over whatever is already audible.
 */
export class VoiceCoach {
  private splitAnnouncements: boolean;
  private rate: number;
  private cueHandler = (event: CueEvent) => {
    const phrase = composePhrase(event, { splitAnnouncements: this.splitAnnouncements });
    if (phrase) this.speak(phrase);
  };

  constructor(options: VoiceCoachOptions = {}) {
    this.splitAnnouncements = options.splitAnnouncements ?? true;
    this.rate = options.rate ?? 1.0;
  }

  attach(engine: { onCue: (cb: (e: CueEvent) => void) => void }): void {
    engine.onCue(this.cueHandler);
  }

  detach(engine: { offCue: (cb: (e: CueEvent) => void) => void }): void {
    engine.offCue(this.cueHandler);
  }

  setSplitAnnouncementsEnabled(enabled: boolean): void {
    this.splitAnnouncements = enabled;
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.8, Math.min(1.4, rate));
  }

  speak(text: string): void {
    if (isNative()) {
      void NativeVoice.speak({ text, rate: this.rate }).catch(() => {});
      return;
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = this.rate;
    window.speechSynthesis.speak(utt);
  }

  cancel(): void {
    if (isNative()) {
      void NativeVoice.cancel().catch(() => {});
      return;
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
  }
}
