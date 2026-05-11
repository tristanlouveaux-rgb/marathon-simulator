/**
 * Manual "Recompute power curves" — user-triggered escape hatch when
 * `power_curve` is missing on the user's recent rides and the auto-backfill
 * isn't filling it (rate-limited, budget exhausted, conditions don't fire on
 * launch, etc).
 *
 * Calls `sync-strava-activities` with mode `powerCurveRefresh`. The edge
 * function reads cycling rides from the DB without a curve, fetches their
 * watts streams (up to 30), computes mean-max curves, and updates the rows.
 *
 * Pairs with the FTP debug overlay's "Recompute power" button — see
 * `src/ui/ftp-debug-overlay.ts` and `docs/CHANGELOG.md` 2026-05-02 entry.
 */

import { callEdgeFunction } from './supabaseClient';

export interface RecomputePowerCurvesResult {
  ok: boolean;
  /** Number of cycling rides without a curve that matched the threshold filters. */
  eligibleCount?: number;
  /** Number of watts streams successfully fetched from Strava. */
  fetched?: number;
  /** Number of rows where the curve was stored back to the DB. */
  stored?: number;
  /** True when the loop was cut short by a Strava 429. */
  truncatedBy429?: boolean;
  /** Failure message when ok=false. */
  message?: string;
}

export async function recomputePowerCurves(): Promise<RecomputePowerCurvesResult> {
  console.log('[recompute-power-curves] Calling edge function (mode=powerCurveRefresh)…');
  try {
    const result = await callEdgeFunction<RecomputePowerCurvesResult>(
      'sync-strava-activities',
      { mode: 'powerCurveRefresh' },
    );
    if (!result || !result.ok) {
      console.warn('[recompute-power-curves] Edge function returned non-ok result:', result);
      return { ok: false, message: 'Server returned an error' };
    }
    console.log(
      `[recompute-power-curves] Done — eligible=${result.eligibleCount} fetched=${result.fetched} stored=${result.stored}` +
      (result.truncatedBy429 ? ' (truncated by 429)' : '')
    );
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[recompute-power-curves] Failed:', msg);
    if (msg.includes('429')) {
      return { ok: false, message: 'Strava rate-limited. Wait ~15 min and try again.' };
    }
    return { ok: false, message: msg };
  }
}
