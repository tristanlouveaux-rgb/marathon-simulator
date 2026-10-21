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

/**
 * The phase of the week in progress, `wks[w - 1].ph` (`w` is 1-based), the
 * stored phase the plan generator wrote for that week. Undefined with no such
 * week (no plan, or past its end).
 */
export function hyroxCurrentWeekPhase(
  wks: ReadonlyArray<{ ph?: string }> | null | undefined,
  w: number | null | undefined,
): string | undefined {
  return wks?.[Math.max(0, (w ?? 1) - 1)]?.ph;
}

/**
 * A plan phase as the Forecast prints it: "Base", "Build", "Peak", "Taper";
 * '—' with none. The Training chip and the Training page read the current
 * week's phase through this (hyroxCurrentWeekPhase), so they cannot disagree.
 * The chip used a share of the plan elapsed (s.w / s.tw: under 40% Base, under
 * 75% Build, under 90% Peak, else Taper), which could name a different phase
 * from the week's own (D11, 2026-10-21).
 */
export function hyroxPhaseLabel(ph: string | undefined): string {
  if (!ph) return '—';
  return ph[0].toUpperCase() + ph.slice(1);
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

/**
 * Planned HYROX sessions per week as the Forecast prints it: one decimal,
 * a whole number without ".0" ("4.5", "5"). The Training chip and the Race
 * order footer print the same number (plannedHyroxSessionsPerWeek, the
 * station horizon's sessions_per_week) through this, so they cannot read
 * "5/wk" and "4.5 sessions/wk" side by side (ISSUE-406 (f)).
 */
export function fmtSessionsPerWeek(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}
