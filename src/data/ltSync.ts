/**
 * LT Sync. Recomputes the active lactate-threshold value from all available
 * inputs and applies it to state.
 *
 * Decision flow:
 *   1. Build derive inputs (VDOT, maxHR, PBs, sustained-running activities, optional fresh
 *      Garmin reading, optional user override) from state.
 *   2. Call `resolveLT()`. This returns the value the app *should* use given
 *      the priority chain (override > fresh Garmin > blended derived).
 *   3. If a fresh Garmin reading exists AND our derived value differs by
 *      >10s/km, stash a `ltSuggestion` so the LT detail page can ask the user
 *      to choose. Otherwise apply silently. `s.lt` flows into pace zones
 *      (`paces.gp`) and the LT bar.
 *
 * Pure: this module reads/writes `s.lt`/`s.ltSuggestion`/`s.ltSource` etc.
 * but performs no I/O. Sync code calls it after pulling Garmin physio.
 */

import { resolveLT, deriveLT, diagnoseSustainedEfforts, type BestEffortInput, type SustainedEffortInput, type DeriveLTInput, type LTDerivationResult, type SustainedEffortDiagnostic } from '@/calculations/lt-derivation';
import { ltDanielsInputVdot, effectivePhysiologyPbs, modelPbAgeWeightsIfMeasured } from '@/calculations/physiological-vdot';
import { computePredictionInputs, collectRunsFromState } from '@/calculations/prediction-inputs';
import { raceEffortHrFloorForState } from '@/calculations/heart-rate';
import type { SimulatorState } from '@/types';

/** Meaningful-change threshold — an applied LT shift of at least this many
 *  s/km is surfaced to the user (small toast, per the adaptation-transparency
 *  rule). Below it, the value updates silently. Formerly the Garmin-vs-derived
 *  conflict threshold; the suggestion flow it gated was removed 2026-06-04
 *  (watch readings now auto-apply). */
export const LT_NOTIFY_THRESHOLD_SEC_KM = 10;

/** Auto-improvement gap — derived must beat user override by ≥ this many s/km
 *  before we silently replace the override (see CLAUDE.md). */
const LT_AUTO_IMPROVE_GAP_SEC_KM = 3;

/** Build BestEffortInputs from PB times. Distances in metres, times in seconds.
 *  Reads via `effectivePhysiologyPbs` so freshly-typed wizard PBs are visible
 *  to LT derivation BEFORE finalize commits them to `s.pbs` (the review
 *  screen's LT row previously derived against the previous plan's PBs). */
function pbsToBestEfforts(s: SimulatorState, now?: string): BestEffortInput[] {
  const efforts: BestEffortInput[] = [];
  const pbs = effectivePhysiologyPbs(s);
  // PB age weights (pbAgeWeight): an old PB weighs less in critical speed and
  // in the long-race LT bound, on the same measured-volume gate as the blend
  // and the engine floor (modelPbAgeWeightsIfMeasured): with no running data
  // an old PB keeps full weight (§BV). The PB times themselves are unchanged.
  const at = now ? new Date(now) : new Date();
  const inputs = computePredictionInputs(collectRunsFromState(s), at, raceEffortHrFloorForState(s));
  const w = modelPbAgeWeightsIfMeasured(pbs, s, inputs, at) ?? {};
  if (pbs.k5 && pbs.k5 > 0) efforts.push({ distanceM: 5000, elapsedSec: pbs.k5, ageWeight: w.k5 ?? 1 });
  if (pbs.k10 && pbs.k10 > 0) efforts.push({ distanceM: 10000, elapsedSec: pbs.k10, ageWeight: w.k10 ?? 1 });
  if (pbs.h && pbs.h > 0) efforts.push({ distanceM: 21097.5, elapsedSec: pbs.h, ageWeight: w.h ?? 1 });
  if (pbs.m && pbs.m > 0) efforts.push({ distanceM: 42195, elapsedSec: pbs.m, ageWeight: w.m ?? 1 });
  return efforts;
}

/**
 * Walk all available run sources and pick out RUNNING activities long enough
 * to even be candidates (≥20 min). The derivation engine applies the full
 * outlier/quality filtering itself (HR band, decoupling, treadmill, heat,
 * elevation, pace CV); we just hand it the raw runs.
 *
 * Sources merged:
 *   - `s.wks[].garminActuals`. Populated post-onboarding by standalone sync.
 *   - `s.onboardingRunHistory`. Seeded by the Strava backfill at onboarding,
 *     before plan generation builds wks. Without this the empirical LT path
 *     would be blind during the entire review screen for fresh users.
 *
 * Dedup by startTime. The same run can appear in both buckets once weeks
 * are generated and the activity gets matched.
 */
function collectSustainedEfforts(s: SimulatorState): SustainedEffortInput[] {
  const seen = new Set<string>();
  const out: SustainedEffortInput[] = [];

  const weeks = s.wks ?? [];
  for (const wk of weeks) {
    const actuals = wk.garminActuals;
    if (!actuals) continue;
    for (const a of Object.values(actuals)) {
      const aType = (a.activityType || '').toUpperCase();
      if (aType !== 'RUNNING' && !aType.includes('RUN')) continue;
      if (!a.startTime) continue;
      if (!a.durationSec || a.durationSec < 1200) continue; // 20 min cutoff. Saves work
      if (!a.avgPaceSecKm || a.avgPaceSecKm <= 0) continue;
      seen.add(a.startTime);
      out.push({
        startTime: a.startTime,
        durationSec: a.durationSec,
        avgPaceSecKm: a.avgPaceSecKm,
        avgHR: a.avgHR,
        kmSplits: a.kmSplits ?? null,
        hrDrift: a.hrDrift ?? null,
        sportType: a.activityType ?? null,
        ambientTempC: a.ambientTempC ?? null,
        elevationGainM: a.elevationGainM ?? null,
      });
    }
  }

  for (const r of s.onboardingRunHistory ?? []) {
    const aType = (r.activityType || '').toUpperCase();
    if (aType !== 'RUNNING' && !aType.includes('RUN')) continue;
    if (!r.startTime || seen.has(r.startTime)) continue;
    if (!r.durSec || r.durSec < 1200) continue;
    if (!r.distKm || r.distKm <= 0) continue;
    // Prefer the explicitly-stored avgPaceSecKm when the entry was DB-seeded
    // (it accounts for moving-time vs elapsed-time differences); fall back to
    // duration/distance for lightweight entries from the edge function summary.
    const avgPaceSecKm = (r.avgPaceSecKm && r.avgPaceSecKm > 0)
      ? r.avgPaceSecKm
      : r.durSec / r.distKm;
    if (!isFinite(avgPaceSecKm) || avgPaceSecKm <= 0) continue;
    out.push({
      startTime: r.startTime,
      durationSec: r.durSec,
      avgPaceSecKm,
      avgHR: r.avgHR ?? null,
      // Quality fields are optional. Populated when the entry was seeded from
      // the DB (rich shape), absent when seeded only from the edge function's
      // lightweight summary. The derivation engine treats absent fields as
      // "filter does not apply" rather than failing the run.
      kmSplits: r.kmSplits ?? null,
      hrDrift: r.hrDrift ?? null,
      sportType: r.activityType ?? null,
      ambientTempC: r.ambientTempC ?? null,
      elevationGainM: r.elevationGainM ?? null,
    });
  }

  return out;
}

/** Build the full DeriveLTInput from current state — used by both the sync flow
 *  (`recomputeLT`) and the LT detail page (so it can show the same methods and
 *  provenance). The Daniels VDOT input is `ltDanielsInputVdot`: the unified
 *  physiological-VDOT chain (`getPhysiologicalVdot`), with the triathlete run
 *  caps applied to a watch or engine-fallback value so a triathlete's run paces
 *  follow the same capped figure as the engine VDOT and the blend. See
 *  `src/calculations/physiological-vdot.ts`. */
export function buildLTInputs(s: SimulatorState, opts: { now?: string; garmin?: { ltPaceSecKm: number; ltHR?: number | null; asOf: string } | null } = {}): DeriveLTInput {
  const garmin = opts.garmin === undefined ? (s.garminLT ?? null) : opts.garmin;
  return {
    vdot: ltDanielsInputVdot(s, { now: opts.now }),
    maxHR: s.maxHR ?? null,
    bestEfforts: pbsToBestEfforts(s, opts.now),
    sustainedEfforts: collectSustainedEfforts(s),
    garmin,
    override: s.ltOverride ?? null,
    now: opts.now ?? new Date().toISOString(),
  };
}

/** Convenience: re-run the full derivation (no apply) so a UI can inspect the
 *  methods, weights, and provenance for the *derived-only* path. */
export function deriveLTForState(s: SimulatorState, now?: string): LTDerivationResult {
  return deriveLT({ ...buildLTInputs(s, { now }), garmin: null, override: null });
}

/**
 * Diagnostic: returns one row per recent running activity explaining whether
 * it qualified for the empirical LT path and, if not, why. Used by the LT
 * detail page to dump a console.table on render.
 */
export function diagnoseLTForState(s: SimulatorState, now?: string): SustainedEffortDiagnostic[] {
  const efforts = collectSustainedEfforts(s);
  const at = now ? new Date(now) : new Date();
  return diagnoseSustainedEfforts(efforts, s.maxHR ?? null, at);
}

interface RecomputeOptions {
  /** Latest Garmin LT reading. If omitted, uses `s.garminLT`. */
  garmin?: { ltPaceSecKm: number; ltHR?: number | null; asOf: string } | null;
  /** Override `now` for tests. */
  now?: string;
}

/**
 * Recompute the LT value the app should use. Mutates `s` directly; caller is
 * responsible for `saveState()`.
 *
 * Returns the source we ended up applying (or 'pending' if we surfaced a conflict).
 */
export function recomputeLT(
  s: SimulatorState,
  opts: RecomputeOptions = {},
): 'override' | 'garmin' | 'derived' | 'pending' | 'none' {
  const garmin = opts.garmin === undefined ? (s.garminLT ?? null) : opts.garmin;
  const now = opts.now ?? new Date().toISOString();

  // Persist the latest Garmin reading separately so we can keep showing it even
  // after a conflict resolution chooses derived.
  if (opts.garmin && opts.garmin.ltPaceSecKm > 0) {
    s.garminLT = { ...opts.garmin };
  }

  // Same inputs as the LT detail page (buildLTInputs): one construction, so
  // the applied s.lt and the displayed derivation cannot diverge.
  const inputs = buildLTInputs(s, { now, garmin });

  // Derived-only result (ignores Garmin). Used for the conflict check.
  const derivedOnly = deriveLT({ ...inputs, garmin: null });

  // Resolved result (priority chain applied).
  const resolved = resolveLT(inputs);

  // If user has overridden, normally apply it. Per CLAUDE.md "Manually-set
  // Benchmarks Yield to Improvements": auto-clear the override when the derived
  // estimate clearly beats it (faster pace, ≥3 s/km gap, derived confidence
  // 'medium' or 'high'). The paired LTHR comes along. It's a single
  // physiological calibration, not a separable axis.
  if (s.ltOverride) {
    const ovrPace = s.ltOverride.ltPaceSecKm;
    const dPace = derivedOnly.ltPaceSecKm;
    const dConf = derivedOnly.confidence;
    const beats =
      dPace != null &&
      ovrPace - dPace >= LT_AUTO_IMPROVE_GAP_SEC_KM &&
      (dConf === 'high' || dConf === 'medium');
    if (beats) {
      console.log(`[lt] override auto-improved: user ${ovrPace}s/km → derived ${Math.round(dPace!)}s/km (${dConf} conf)`);
      delete s.ltOverride;
      // Recompute resolved without the override so we apply the derived path.
      const resolvedNoOverride = resolveLT({ ...inputs, override: null });
      applyResolved(s, resolvedNoOverride, now);
      return resolvedNoOverride.source === 'garmin' ? 'garmin' : 'derived';
    }
    applyResolved(s, resolved, now);
    return 'override';
  }

  // Watch readings auto-apply — measured beats modelled (Tristan, 2026-06-04).
  // The old behaviour parked any >10s/km Garmin–derived disagreement behind a
  // suggestion card; a user who never opened it never got their watch LT.
  // resolveLT already arbitrates: Garmin wins unless the derived estimate is
  // clearly better (faster ≥3s/km at medium+ confidence). Clear any pending
  // suggestion from the old flow so stale cards don't linger.
  if (s.ltSuggestion) delete s.ltSuggestion;
  if (!resolved.ltPaceSecKm) return 'none';
  applyResolved(s, resolved, now);
  return resolved.source === 'garmin' ? 'garmin' : 'derived';
}

function applyResolved(s: SimulatorState, resolved: ReturnType<typeof resolveLT>, now: string): void {
  if (resolved.ltPaceSecKm == null) return;
  s.lt = Math.round(resolved.ltPaceSecKm);
  s.ltPace = s.lt;
  if (resolved.ltHR != null) s.ltHR = Math.round(resolved.ltHR);
  s.ltUpdatedAt = now;
  s.ltSource = resolved.source;
  s.ltConfidence = resolved.confidence;
}

/** Convenience: clear any pending suggestion (e.g. after the user picks). */
export function clearLTSuggestion(s: SimulatorState): void {
  if (s.ltSuggestion) delete s.ltSuggestion;
}
