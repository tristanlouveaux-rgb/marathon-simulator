/**
 * HYROX volume helpers. Feed the per-station horizon model.
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
import { isHyroxEasyErg } from '@/workouts/hyrox-easy-erg';

/**
 * Average planned Hyrox sessions per week over `weeks` plan weeks starting at
 * the current week (wks[s.w - 1]). Counts every `wk.triWorkouts` entry in the look-ahead window except
 * easy erg work (isHyroxEasyErg: easy aerobic volume on the ergs, not a
 * Hyrox-style session; review 2026-10-13: counting it lifted the station
 * horizon, up to 49 s faster for a beginner). Hyrox mode stores all session
 * types (run, station, brick) under the same field as triathlon mode does. A closing week (raceClosing: a Monday to Wednesday
 * race's own week, which holds only the race) is not a training week and is
 * skipped, as every running weeks-of-training input reads planTrainingWeeks.
 *
 * Averages over the weeks that remain when fewer than `weeks` do (race week
 * covers itself). Returns 0 if the plan has no workouts from the current week
 * on. The window started at wks[s.w], next week (s.w is 1-based), until
 * 2026-10-21: it skipped the week in progress and in race week read past the
 * plan and returned 0. The doc claimed a fallback to earlier weeks the code
 * never had.
 */
export function plannedHyroxSessionsPerWeek(
  state: SimulatorState,
  weeks: number = 4,
): number {
  const wks = state.wks ?? [];
  // s.w is 1-based: the current week is wks[s.w - 1] (wks[s.w] is next week).
  const currentIdx = Math.max(0, (state.w ?? 1) - 1);
  let total = 0;
  let weeksCovered = 0;
  for (let w = currentIdx; w < wks.length && weeksCovered < weeks; w++) {
    const wk = wks[w];
    if (!wk?.triWorkouts || wk.raceClosing) continue;
    weeksCovered += 1;
    total += wk.triWorkouts.filter(w => !isHyroxEasyErg(w)).length;
  }
  if (weeksCovered === 0) return 0;
  return total / weeksCovered;
}
