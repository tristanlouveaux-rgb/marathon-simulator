/**
 * Mode-agnostic strength-session completion. Writes `wk.rated[workoutId] = rpe`
 * via the existing `rate()` function (events.ts). The field every mode's plan
 * view reads to render "done". Passing `expected === rpe` makes `rate()` skip
 * its running-specific VDOT adjustment, so a gym RPE never moves a runner's
 * VDOT. Mirrors what the running gym "Mark Done" button already does.
 *
 * Used by:
 * - the quick "Mark as done" action on any strength card / modal, and
 * - the guided-session finish (passes the user's 1-tap RPE + measured duration).
 *
 * Measured duration is logged to the console for now; persistence of the
 * measured value beyond the prescribed `estimatedDurationMin` is a follow-up.
 */

import type { Workout } from '@/types';
import type { HyroxComponent, HyroxStation } from '@/types/triathlon';
import { STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import { rate } from '@/ui/events';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import type { SetRecord } from './strength-controller';

export interface CompleteStrengthOpts {
  /** RPE the user actually rated; defaults to the workout's prescribed RPE so
   *  the quick "Mark as done" path produces no VDOT shift (expected === rpe). */
  rpe?: number;
  /** Actually-measured session duration in seconds, when available (e.g. from
   *  the guided overlay's elapsed clock). Logged for now. */
  durationSec?: number;
  /** Target week (1-based). Defaults to the current week. */
  targetWeek?: number;
  /** Per-set / per-station time records captured by the guided overlay. For
   *  HYROX workouts these feed `stationBenchmarkHistory` so the prediction
   *  model picks up the measured times. */
  records?: SetRecord[];
}

export function completeStrengthSession(workout: Workout, opts: CompleteStrengthOpts = {}): void {
  const id = (workout as any).id ?? workout.n;
  const prescribed = (workout.rpe ?? workout.r ?? 5) as number;
  const chosen = typeof opts.rpe === 'number' ? opts.rpe : prescribed;
  const type = workout.t || 'gym';

  // `expected === chosen` => rpeDif=0 => no VDOT/efficiency change for gym.
  rate(id, workout.n, chosen, chosen, type, false, undefined, opts.targetWeek);

  if (typeof opts.durationSec === 'number' && opts.durationSec > 0) {
    const mins = Math.round(opts.durationSec / 60);
    // eslint-disable-next-line no-console
    console.log(`[strength] completed ${workout.n}: ${mins} min, RPE ${chosen}`);
  }

  // HYROX: align each station record to a hyroxComponent and append to the
  // station benchmark history. Lets the predictor pick up freshly measured
  // station times the next time it runs.
  if (opts.records && opts.records.length) {
    const components = (workout as any).hyroxComponents as HyroxComponent[] | undefined;
    if (Array.isArray(components) && components.length === opts.records.length) {
      writeHyroxStationHistory(components, opts.records);
    }
  }
}

/**
 * For each HYROX *station* component (skipping runs), append the captured time
 * to `triConfig.stationBenchmarkHistory` so the predictor's "latest entry per
 * station" read picks it up. Source = 'manual' (recorded inside the app);
 * format is read from `triConfig.hyroxPreviousTimeFormat` so the entry sits in
 * the right Singles / Doubles / Pro slot.
 */
function writeHyroxStationHistory(components: HyroxComponent[], records: SetRecord[]): void {
  const state = getMutableState();
  const tri = (state as any).triConfig as { stationBenchmarkHistory?: Partial<Record<HyroxStation, Array<any>>>; hyroxPreviousTimeFormat?: string; benchmarksAtProWeights?: boolean } | undefined;
  if (!tri) return;
  if (!tri.stationBenchmarkHistory) tri.stationBenchmarkHistory = {};
  const dateISO = new Date().toISOString();
  const format = (tri.hyroxPreviousTimeFormat as any) ?? 'open_singles';
  const proWeights = tri.benchmarksAtProWeights ?? false;
  let writes = 0;
  components.forEach((c, i) => {
    if (c.type === 'run') return;
    const station = c.type as HyroxStation;
    if (!STATION_DISPLAY[station]) return;
    const sec = Math.round(records[i]?.durationSec ?? 0);
    if (sec <= 0) return;
    const bucket = (tri.stationBenchmarkHistory![station] ??= []);
    bucket.push({ dateISO, sec, source: 'manual', format, proWeights });
    writes++;
  });
  if (writes > 0) {
    saveState();
    // eslint-disable-next-line no-console
    console.log(`[strength] HYROX history: appended ${writes} station times (format ${format})`);
  }
}
