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

/** Provenance of the HYROX run pace: deriveHyroxRunPace(...).provenance. */
export type HyroxRunPaceProvenance = 'user' | 'derived' | 'seed';

/**
 * Short provenance label for the run pace: the Forecast's Run pace chip and
 * the Run pace page's Source row. Read from the pace's provenance
 * (deriveHyroxRunPace(...).provenance, carried as prediction.runPaceSource),
 * the same value the Stats caption reads (hyroxRunPaceCaption), so a derived
 * pace never reads "Set manually" on one surface and "Updated from your runs"
 * on the other (ISSUE-406 (d)).
 */
export function hyroxRunPaceSourceLabel(provenance: HyroxRunPaceProvenance): string {
  if (provenance === 'derived') return 'From VDOT';
  if (provenance === 'seed') return 'Band median';
  return 'Set manually';
}

/**
 * The Stats caption under the run pace (the benchmark provenance caption
 * rule: "Set manually." until an auto-derived value beats it). Same
 * provenance as hyroxRunPaceSourceLabel.
 */
export function hyroxRunPaceCaption(provenance: HyroxRunPaceProvenance): string {
  if (provenance === 'derived') return 'Updated from your runs. Beat your last test.';
  if (provenance === 'seed') return 'Population est.';
  return 'Set manually.';
}
