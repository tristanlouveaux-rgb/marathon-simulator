/**
 * HYROX weakest-link / "Where to gain" calculation.
 *
 * **Side**: tracking + planning. Surfaces which stations have the highest
 * forecast impact if the athlete trains them — combining current time, planned
 * training dose, and weeks remaining. Reuses the per-class horizon model
 * (`applyHyroxStationHorizon` in `training-horizon.hyrox.ts`) that powers the
 * trajectory panel; no new constants.
 *
 * Why "what's achievable with training" rather than "gap to band median": the
 * horizon model already encodes how much improvement is realistic given
 * weeks remaining + sessions/week. A station the athlete is at p30 on but
 * which the horizon model says is near a structural ceiling won't get an
 * inflated rec. Conversely, a station at p50 with a high gain rate (typical
 * of erg work for first-build athletes) can still be the highest-ROI lever.
 *
 * Ranking: descending by `gainableSec` = `currentSec - projectedSec`. Both
 * come straight from the prediction's projection markers. Stations that
 * source from a population seed (no calibrated test) are still included —
 * the projection there is "what the typical band-mate gains in this window".
 */

import type { HyroxPrediction, HyroxStationProjection } from './race-prediction.hyrox';

export interface WeakestLinkRow {
  station: HyroxStationProjection['station'];
  currentSec: number;
  projectedSec: number;
  gainableSec: number;
  improvementPct: number;
  source: 'calibrated' | 'seed';
}

/** Rank stations by absolute gain achievable at current training dose.
 *  Returns descending. Empty when no projection (no race date set, or
 *  projection unavailable). Caller is responsible for slicing top N. */
export function rankWeakestLinks(prediction: HyroxPrediction | null): WeakestLinkRow[] {
  if (!prediction?.projection) return [];
  const proj = prediction.projection;
  // No meaningful gains when race day is past or unset.
  if (proj.weeksRemaining <= 0) return [];

  const rows: WeakestLinkRow[] = proj.stations.map(p => ({
    station: p.station,
    currentSec: p.currentSec,
    projectedSec: p.projectedSec,
    gainableSec: Math.max(0, p.currentSec - p.projectedSec),
    improvementPct: p.improvementPct,
    source: p.source,
  }));

  rows.sort((a, b) => b.gainableSec - a.gainableSec);
  // Drop trailing entries with zero gain — they add noise without info.
  return rows.filter(r => r.gainableSec >= 1);
}

/** Convenience: top N rows from rankWeakestLinks. */
export function topWeakestLinks(prediction: HyroxPrediction | null, n = 2): WeakestLinkRow[] {
  return rankWeakestLinks(prediction).slice(0, n);
}
