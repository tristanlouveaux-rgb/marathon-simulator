/**
 * Guided-strength controller. Wall-clock + tap driven state machine that walks
 * a parsed StrengthSession exercise -> set -> auto rest -> next set. Mode-
 * agnostic (running / triathlon / HYROX strength all use it). Distinct from the
 * GPS-tick `GuideController` (which is pace/distance driven for runs).
 *
 * The timer is injected (`ticker`) so the logic is unit-testable: tests pass a
 * no-op ticker and drive `tick()` manually; production uses `setInterval`.
 */

import type { GuidedSet, StrengthSession } from './strength-model';

export type StrengthPhase = 'idle' | 'active' | 'resting' | 'paused' | 'countdown' | 'done';

export interface StrengthCueEvent {
  type: 'setStart' | 'restStart' | 'restEnd' | 'pauseStart' | 'countdownStart' | 'tick' | 'complete';
  /** The set just started / being rested after. */
  set?: GuidedSet;
  /** The set that follows the current rest / pause. */
  nextSet?: GuidedSet | null;
  /** Duration (sec) of the set just completed — populated on pauseStart and on
   *  the implicit advance/restEnd that follows a completed set. */
  setDurationSec?: number;
  restRemainingSec?: number;
  /** Seconds remaining on the pre-station "Get ready" countdown. */
  countdownRemainingSec?: number;
  elapsedSec?: number;
}

/** Per-set time record captured as the athlete completes each set/station. */
export interface SetRecord {
  exerciseName: string;
  exerciseIndex: number;
  setIndex: number;
  setCount: number;
  reps: string;
  durationSec: number;
  /** Canonical lift slug, carried from the GuidedSet for weight persistence. */
  liftKey?: string;
  /** Working weight the user entered for this exercise (kg). Merged in by the
   *  overlay at finish (the controller stays weight-agnostic for HYROX reuse). */
  weightKg?: number;
  /** Reps-in-reserve bucket from the final set of the exercise. */
  rirBucket?: import('@/types/strength-log').RirBucket;
}

/** Registers a 1Hz callback; returns a stop function. */
export type Ticker = (cb: () => void) => (() => void);

const defaultTicker: Ticker = (cb) => {
  const id = setInterval(cb, 1000);
  return () => clearInterval(id);
};

export interface StrengthControllerOptions {
  onCue?: (e: StrengthCueEvent) => void;
  ticker?: Ticker;
  /** When true, completed sets enter the `paused` phase instead of a timed
   *  rest countdown. The user must call `startNextSet()` to advance. Used by
   *  HYROX (and any test-style workout where rest is unbounded). */
  manualAdvance?: boolean;
}

export class StrengthGuideController {
  private session: StrengthSession;
  private onCue?: (e: StrengthCueEvent) => void;
  private ticker: Ticker;
  private stopTicker: (() => void) | null = null;
  private manualAdvance: boolean;

  private idx = 0;            // index into session.sets
  private _phase: StrengthPhase = 'idle';
  private _elapsedSec = 0;
  private _restRemainingSec = 0;
  private _countdownRemainingSec = 0;
  /** Elapsed reading at the moment the current set entered `active`; used to
   *  compute the per-set duration on completion. */
  private setStartElapsed = 0;
  /** Elapsed reading at the moment the controller entered `paused`; used to
   *  render the rest-elapsed counter that ticks up between stations. */
  private pauseStartElapsed = 0;
  private records: SetRecord[] = [];

  constructor(session: StrengthSession, options: StrengthControllerOptions = {}) {
    this.session = session;
    this.onCue = options.onCue;
    this.ticker = options.ticker ?? defaultTicker;
    this.manualAdvance = options.manualAdvance ?? false;
  }

  // ── Getters ────────────────────────────────────────────────────────────────
  get phase(): StrengthPhase { return this._phase; }
  get elapsedSec(): number { return this._elapsedSec; }
  get restRemainingSec(): number { return this._restRemainingSec; }
  /** Seconds remaining on the pre-station countdown (zero unless `countdown`). */
  get countdownRemainingSec(): number { return this._countdownRemainingSec; }
  /** Seconds elapsed in the current paused rest period (zero unless `paused`). */
  get pauseElapsedSec(): number {
    return this._phase === 'paused' ? Math.max(0, this._elapsedSec - this.pauseStartElapsed) : 0;
  }
  /** Seconds elapsed on the current set/station since it became active (zero
   *  unless `active`). Drives the live per-exercise clock in the overlay. */
  get currentSetElapsedSec(): number {
    return this._phase === 'active' ? Math.max(0, this._elapsedSec - this.setStartElapsed) : 0;
  }
  get totalSets(): number { return this.session.sets.length; }
  /** Sets completed so far. While `active` (or `idle`) the current set is not
   *  counted; in `resting` / `paused` / `done` the just-completed set IS. */
  get completedSets(): number {
    if (this._phase === 'done') return this.totalSets;
    if (this._phase === 'resting' || this._phase === 'paused') return this.idx + 1;
    return this.idx;
  }
  /** Per-set time records captured so far (read-only copy). */
  get setRecords(): SetRecord[] { return this.records.slice(); }
  /** True when this controller was created in unbounded-rest mode (HYROX). */
  get isManualAdvance(): boolean { return this.manualAdvance; }

  currentSet(): GuidedSet | null {
    return this._phase === 'done' ? null : (this.session.sets[this.idx] ?? null);
  }
  nextSet(): GuidedSet | null {
    return this.session.sets[this.idx + 1] ?? null;
  }
  /** The most-recent captured time, or null. */
  lastRecord(): SetRecord | null {
    return this.records.length ? this.records[this.records.length - 1] : null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  start(): void {
    if (this._phase !== 'idle') return;
    this._phase = 'active';
    this.idx = 0;
    this._elapsedSec = 0;
    this.setStartElapsed = 0;
    this.stopTicker = this.ticker(() => this.tick(1));
    this.emit({ type: 'setStart', set: this.currentSet() ?? undefined, elapsedSec: 0 });
  }

  /** Advance the clock by `deltaSec` (called by the ticker, or by tests). */
  tick(deltaSec = 1): void {
    if (this._phase === 'idle' || this._phase === 'done') return;
    this._elapsedSec += deltaSec;
    if (this._phase === 'resting') {
      this._restRemainingSec = Math.max(0, this._restRemainingSec - deltaSec);
      if (this._restRemainingSec <= 0) {
        this.onRestComplete();
        return;
      }
    }
    if (this._phase === 'countdown') {
      this._countdownRemainingSec = Math.max(0, this._countdownRemainingSec - deltaSec);
      if (this._countdownRemainingSec <= 0) {
        this.advance();
        return;
      }
    }
    this.emit({
      type: 'tick',
      elapsedSec: this._elapsedSec,
      restRemainingSec: this._restRemainingSec,
      countdownRemainingSec: this._countdownRemainingSec,
    });
  }

  /** User taps "Complete set". Captures the per-set time, then transitions to
   *  rest countdown / paused / next set / finish depending on mode and config. */
  completeSet(): void {
    if (this._phase !== 'active') return;
    const cur = this.currentSet();
    const setDurationSec = Math.max(0, this._elapsedSec - this.setStartElapsed);
    if (cur) {
      this.records.push({
        exerciseName: cur.exerciseName,
        exerciseIndex: cur.exerciseIndex,
        setIndex: cur.setIndex,
        setCount: cur.setCount,
        reps: cur.reps,
        durationSec: setDurationSec,
        liftKey: cur.liftKey,
      });
    }
    const isLast = this.idx >= this.session.sets.length - 1;
    if (isLast) { this.finish(); return; }

    if (this.manualAdvance) {
      this._phase = 'paused';
      this.pauseStartElapsed = this._elapsedSec;
      this.emit({
        type: 'pauseStart',
        set: cur ?? undefined,
        nextSet: this.nextSet(),
        setDurationSec,
        elapsedSec: this._elapsedSec,
      });
      return;
    }

    const restSec = cur?.restSec ?? 0;
    if (restSec > 0) {
      this._phase = 'resting';
      this._restRemainingSec = restSec;
      this.emit({
        type: 'restStart',
        set: cur ?? undefined,
        nextSet: this.nextSet(),
        setDurationSec,
        restRemainingSec: restSec,
        elapsedSec: this._elapsedSec,
      });
    } else {
      this.advance();
    }
  }

  /** Begin the pre-station countdown from `paused`. Pass 0 (the default) to
   *  advance immediately, or a positive number of seconds for a visible "Get
   *  ready" countdown before the controller transitions to `active`. */
  startNextSet(seconds: number = 0): void {
    if (this._phase !== 'paused') return;
    const s = Math.max(0, Math.floor(seconds));
    if (s === 0) { this.advance(); return; }
    this._phase = 'countdown';
    this._countdownRemainingSec = s;
    this.emit({
      type: 'countdownStart',
      nextSet: this.nextSet(),
      countdownRemainingSec: s,
      elapsedSec: this._elapsedSec,
    });
  }

  /** End the current rest immediately and advance. */
  skipRest(): void {
    if (this._phase !== 'resting') return;
    this._restRemainingSec = 0;
    this.onRestComplete();
  }

  /** Add seconds to the running rest countdown. */
  extendRest(sec: number): void {
    if (this._phase !== 'resting') return;
    this._restRemainingSec += sec;
    this.emit({ type: 'tick', elapsedSec: this._elapsedSec, restRemainingSec: this._restRemainingSec });
  }

  /** Finish the session early or on the last set. */
  finish(): void {
    if (this._phase === 'done') return;
    this._phase = 'done';
    this.stop();
    this.emit({ type: 'complete', elapsedSec: this._elapsedSec });
  }

  /** Detach the ticker without emitting completion (cancel / dismiss). */
  destroy(): void {
    this.stop();
  }

  // ── Internals ────────────────────────────────────────────────────────────────
  private onRestComplete(): void {
    const justRested = this.currentSet();
    this.emit({ type: 'restEnd', set: justRested ?? undefined, elapsedSec: this._elapsedSec });
    this.advance();
  }

  private advance(): void {
    this.idx += 1;
    if (this.idx >= this.session.sets.length) { this.finish(); return; }
    this._phase = 'active';
    this._restRemainingSec = 0;
    this.setStartElapsed = this._elapsedSec;
    this.emit({ type: 'setStart', set: this.currentSet() ?? undefined, elapsedSec: this._elapsedSec });
  }

  private stop(): void {
    if (this.stopTicker) { this.stopTicker(); this.stopTicker = null; }
  }

  private emit(e: StrengthCueEvent): void {
    this.onCue?.(e);
  }
}
