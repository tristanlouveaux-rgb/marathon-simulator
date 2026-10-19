import type { SimulatorState, Week } from '@/types/state';
import { isWeekInHoliday } from '../holiday-modal';
import { firstTrackedDow } from '../workout-status';

type HyroxHoursFit = NonNullable<Week['hyroxHoursFit']>;

/**
 * The HYROX plan view's hours line (round 6, item 7): a loaded week whose
 * chosen session count holds it under its size (plan_engine.hyrox
 * HyroxHoursFit). The engine decides when it applies; this words it:
 * "Your 5 sessions fit about 6 h of your 8 h." The week's minutes round to
 * the nearest half hour; the engine sets it only for a week 20 min or more
 * under its size, so the rounded figure stays under the chosen hours.
 */
export function hyroxHoursFitLine(fit: HyroxHoursFit): string {
  const hours = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));
  const about = Math.round(fit.plannedMin / 30) / 2;
  return `Your ${fit.sessions} session${fit.sessions === 1 ? '' : 's'} fit about ${hours(about)} h of your ${hours(fit.chosenHours)} h.`;
}

/**
 * The week's hours line, when the plan view shows it: current and future
 * weeks only, and never when injury, illness (the current week), a holiday,
 * its comeback bridge or a partial first week shapes the week instead (the
 * running plan's run-count line follows the same rule, week-resolve
 * planNotes).
 */
export function hyroxHoursFitFor(s: SimulatorState, viewWeek: number): HyroxHoursFit | undefined {
  const wk = s.wks?.[viewWeek - 1];
  const fit = wk?.hyroxHoursFit;
  if (!wk || !fit || viewWeek < (s.w ?? 1)) return undefined;
  if ((s as { injuryState?: { active?: boolean } }).injuryState?.active) return undefined;
  if (viewWeek === s.w && (s as { illnessState?: { active?: boolean } }).illnessState?.active) return undefined;
  const holiday = s.holidayState;
  if (holiday?.active && s.planStartDate && isWeekInHoliday(viewWeek, s.planStartDate, holiday)) return undefined;
  if ((wk as { _holidayBridgeScale?: number })._holidayBridgeScale) return undefined;
  if (firstTrackedDow(s.planStartDate, viewWeek, s.planCreatedAt) > 0) return undefined;
  return fit;
}
