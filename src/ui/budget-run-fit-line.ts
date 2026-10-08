import type { BudgetRunFit } from '@/workouts/plan_engine';
import { formatKm, type UnitPref } from '@/utils/format';

/**
 * The Plan tab's run-count line (Tristan 2026-10-08): why a week holds fewer
 * runs than the runner chose, when the weekly budget consolidated easy runs
 * (plan_engine BudgetRunFit). States the runs chosen, the runs that fit and the
 * ceiling that set the budget. The engine decides when it applies; this only
 * words it.
 *   - Hours target binds and the runs fill it, with no room under it for another
 *     run: "The 2 h weekly target fits 2 of your 4 runs this week."
 *   - Volume ramp binds: "Building from 15 km a week, this week's volume fits 2 of
 *     your 4 runs." (no km clause when current weekly running is unknown)
 *   - No ceiling named (the effort/CTL lever cost the run, the runs pass the hours
 *     target or leave room under it, or the target capped the ramp's destination;
 *     budgetRunFitOf): "This week's volume fits 2 of your 4 runs."
 * The closing "Each stays at a useful length." names no minute figure: the
 * engine keeps every run at EASY_FLOOR_MIN or longer, but the opt-in body-mass
 * swap (generator.ts) can shorten an easy run below it afterwards.
 */
export function budgetRunFitLine(fit: BudgetRunFit, unitPref: UnitPref): string {
  const runs = `${fit.fittedRuns} of your ${fit.chosenRuns} runs`;
  const length = 'Each stays at a useful length.';
  if (fit.binding === 'hours' && fit.hoursTarget != null) {
    return `The ${fit.hoursTarget} h weekly target fits ${runs} this week. ${length}`;
  }
  if (fit.currentWeeklyKm != null && fit.currentWeeklyKm > 0) {
    return `Building from ${formatKm(fit.currentWeeklyKm, unitPref, 0)} a week, this week's volume fits ${runs}. ${length}`;
  }
  return `This week's volume fits ${runs}. ${length}`;
}
