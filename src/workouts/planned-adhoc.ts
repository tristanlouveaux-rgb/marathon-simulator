/**
 * Planned sessions that live in `wk.adhocWorkouts`.
 *
 * `adhocWorkouts` holds two different things:
 *   - synced or logged activities (`garmin-<id>`, GPS-recorded UUIDs, manual
 *     entries). These are done load.
 *   - sessions injected INTO the plan, not yet done: user-added sessions
 *     (`adhoc-`), holiday replacements (`holiday-`) and post-deload benchmark
 *     check-ins (`benchmark-`, benchmark-overlay.ts). These are prescriptions.
 *
 * PLANNING side of the tracking/planning line. A planned session is never load
 * by itself: when it is done, the synced activity carries the load. Every load
 * reader skips these ids and every plan resolver renders them as plan cards.
 * Before this helper each site listed only `holiday-` and `adhoc-`, so a picked
 * benchmark check-in counted as completed load the moment it was chosen and
 * again when the real run synced (audit B8, 2026-09).
 */

/** Id prefixes of planned (not yet done) sessions stored in `adhocWorkouts`. */
export const PLANNED_ADHOC_ID_PREFIXES = ['adhoc-', 'holiday-', 'benchmark-'] as const;

/** True when an `adhocWorkouts` id is a planned session, not a done activity. */
export function isPlannedAdhocId(id: string | null | undefined): boolean {
  if (!id) return false;
  return PLANNED_ADHOC_ID_PREFIXES.some(p => id.startsWith(p));
}
