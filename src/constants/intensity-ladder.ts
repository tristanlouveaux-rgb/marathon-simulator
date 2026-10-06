/**
 * Running pace ladder: the single read side for "one pace category down".
 *
 * Rule (Tristan, 2026-10-05): a downgrade moves a run ONE pace category down
 * this ladder per step, never up. Every plan-change path that downgrades a run
 * reads it: the day-after timing check (cross-training/timing-check.ts), the
 * cross-training suggester (cross-training/suggester.ts) and the legacy plan
 * suggester (cross-training/planSuggester.ts).
 *
 * Categories, ascending: recovery, easy, marathon pace, threshold, vo2.
 *
 * Each existing running type sits on the rung of its intensity class. The class
 * is the canonical planned-load valuation row (TSS_RPE_BY_TYPE, constants/
 * sports.ts): row 3 = recovery, 4 = easy, 6 = marathon pace, 7 = threshold,
 * 8 = vo2. No new classification: the ladder test pins every type below to its
 * TSS_RPE_BY_TYPE row, so the two cannot drift.
 *   - vo2, intervals, hill_repeats: vo2 rung.
 *   - threshold, race_pace, float: threshold rung. Float fartlek reps run at 10K
 *     pace (RUN_PACE_FACTOR_VS_EASY 0.84, next to threshold's 0.833) and the
 *     generator prescribes them at RPE 7, as it does threshold.
 *   - marathon_pace, progressive, mixed: marathon-pace rung. A progressive run
 *     (and the fast-finish long run, t:'progressive') is easy running with a
 *     marathon-pace finish, so one step down drops the finish.
 *   - easy, long: easy rung. The steady long run is prescribed at easy pace.
 *   - recovery: bottom rung (easy pace + 12%, load.ts).
 *
 * Long-run slot: a long-run-slot session (isLongRun, workouts/long-run.ts)
 * stepped onto the easy rung is written as 'long', so a fast-finish long run
 * becomes an easy long run and keeps its long-run identity. A steady long run is
 * already on the easy rung, so one step takes it to recovery pace.
 *
 * Planning side only: this decides what a downgraded session prescribes. It
 * changes no load valuation (that stays type-keyed in TSS_RPE_BY_TYPE).
 */

/** Pace categories, ascending (index 0 = easiest). */
export const RUN_PACE_LADDER = ['recovery', 'easy', 'marathon_pace', 'threshold', 'vo2'] as const;
export type RunPaceCategory = typeof RUN_PACE_LADDER[number];

/** The rung each existing running workout type sits on. */
const RUNG_OF_TYPE: Record<string, RunPaceCategory> = {
  recovery: 'recovery',
  easy: 'easy',
  long: 'easy',
  marathon_pace: 'marathon_pace',
  progressive: 'marathon_pace',
  mixed: 'marathon_pace',
  threshold: 'threshold',
  race_pace: 'threshold',
  float: 'threshold',
  vo2: 'vo2',
  intervals: 'vo2',
  hill_repeats: 'vo2',
};

/** Ladder index of a running type, or -1 when the type is not on the ladder
 *  (cross-training, gym, rest, unknown). */
export function runPaceRung(type: string | undefined): number {
  const cat = RUNG_OF_TYPE[type ?? ''];
  return cat ? RUN_PACE_LADDER.indexOf(cat) : -1;
}

/**
 * Step a running type `steps` categories down the ladder (floored at recovery).
 * Off-ladder types come back unchanged. `longRun` marks the long-run slot: a
 * result on the easy rung is then written 'long' (an easy long run).
 */
export function stepDownRunType(type: string, steps: number, opts: { longRun?: boolean } = {}): string {
  const rung = runPaceRung(type);
  if (rung < 0) return type;
  const next = RUN_PACE_LADDER[Math.max(0, rung - Math.max(0, steps))];
  if (next === 'easy' && opts.longRun) return 'long';
  return next;
}

/**
 * The RPE the plan generator prescribes for each type a downgrade can write
 * (intent_to_workout.ts: easy 3, long 3, progressive 5, marathon_pace 6,
 * threshold 7, float fartlek 7, vo2 8). 'recovery' is never generated; its 3 is
 * the RPE the suggester already prices a recovery run at (suggester.ts
 * recovery downgrade, load.ts recovery pace comment). A downgrade writes the new
 * type's value, so the card's effort and the debrief read the new prescription.
 * The ladder test pins these against intentToWorkout output.
 */
export const RUN_GENERATOR_RPE: Record<string, number> = {
  recovery: 3,
  easy: 3,
  long: 3,
  progressive: 5,
  marathon_pace: 6,
  threshold: 7,
  float: 7,
  vo2: 8,
};

/** Generator RPE for a running type, or undefined when none is defined. */
export function generatorRpeForRunType(type: string | undefined): number | undefined {
  return RUN_GENERATOR_RPE[type ?? ''];
}
