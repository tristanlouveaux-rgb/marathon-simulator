/**
 * Small display labels the HYROX Forecast page, its chip drill-downs and the
 * Stats page share, so the same fact reads the same on every surface.
 *
 * Display only. No calculation here.
 */

/**
 * The plan-week sub-line: "Week N of M", "Plan complete" once the plan has
 * run out, or '' when there is no plan length. `w` is 1-based (store default
 * w: 1; the current week is wks[w - 1]), as Home, Plan and Stats print it
 * (`hyrox/stats-view.ts`, `hyrox/plan-view.ts`). The Forecast used to print
 * w + 1, one week ahead (ISSUE-406 (a)).
 */
export function hyroxWeekLine(w: number | null | undefined, tw: number | null | undefined): string {
  if (!tw || tw <= 0 || !w || w < 1) return '';
  return w > tw ? 'Plan complete' : `Week ${w} of ${tw}`;
}
