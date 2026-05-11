/**
 * HYROX volume helpers — feed the per-station horizon model.
 *
 * **Side of the line**: tracking. Pure functions; no state mutation.
 *
 * Why a single Hyrox-wide session count (not per-station): one Hyrox-style
 * workout typically hits multiple stations and a run, so per-station counting
 * would either double-count (every workout = 1 to every class) or be
 * structurally noisy (only 0.3 sled sessions/wk reads as undertraining for
 * sled even though every Hyrox session involves loaded movement). The
 * literature reports class-level adaptation rates against total Hyrox-style
 * frequency, so we mirror that.
 */

import type { SimulatorState } from '@/types/state';

/**
 * Average planned Hyrox sessions per week over the next `weeks` weeks of the
 * plan. Counts every `wk.triWorkouts` entry in the look-ahead window — Hyrox
 * mode stores all session types (run, station, brick) under the same field as
 * triathlon mode does.
 *
 * Falls back to current and earlier weeks only when fewer future weeks remain
 * (race week, taper). Returns 0 if the plan has no upcoming workouts.
 */
export function plannedHyroxSessionsPerWeek(
  state: SimulatorState,
  weeks: number = 4,
): number {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  let total = 0;
  let weeksCovered = 0;
  for (let w = currentWeek; w < wks.length && weeksCovered < weeks; w++) {
    const wk = wks[w];
    if (!wk?.triWorkouts) continue;
    weeksCovered += 1;
    total += wk.triWorkouts.length;
  }
  if (weeksCovered === 0) return 0;
  return total / weeksCovered;
}
