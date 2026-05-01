/**
 * LT Sync — recomputes the active lactate-threshold value from all available
 * inputs and applies it to state.
 *
 * Decision flow:
 *   1. Build derive inputs (VDOT, maxHR, PBs, sustained-running activities, optional fresh
 *      Garmin reading, optional user override) from state.
 *   2. Call `resolveLT()` — this returns the value the app *should* use given
 *      the priority chain (override > fresh Garmin > blended derived).
 *   3. If a fresh Garmin reading exists AND our derived value differs by
 *      >10s/km, stash a `ltSuggestion` so the LT detail page can ask the user
 *      to choose. Otherwise apply silently — `s.lt` flows into pace zones
 *      (`paces.gp`) and the LT bar.
 *
 * Pure: this module reads/writes `s.lt`/`s.ltSuggestion`/`s.ltSource` etc.
 * but performs no I/O. Sync code calls it after pulling Garmin physio.
 */

import { resolveLT, deriveLT, diagnoseSustainedEfforts, type BestEffortInput, type SustainedEffortInput, type DeriveLTInput, type LTDerivationResult, type SustainedEffortDiagnostic } from '@/calculations/lt-derivation';
import { getPhysiologicalVdot } from '@/calculations/physiological-vdot';
import type { SimulatorState } from '@/types';

/** Conflict threshold — Garmin and derived must agree within this band to apply silently. */
const LT_CONFLICT_THRESHOLD_SEC_KM = 10;

/** Auto-improvement gap — derived must beat user override by ≥ this many s/km
 *  before we silently replace the override (see CLAUDE.md). */
const LT_AUTO_IMPROVE_GAP_SEC_KM = 3;

/** Build BestEffortInputs from PB times. Distances in metres, times in seconds. */
function pbsToBestEfforts(s: SimulatorState): BestEffortInput[] {
  const efforts: BestEffortInput[] = [];
  const pbs = s.pbs ?? {};
  if (pbs.k5 && pbs.k5 > 0) efforts.push({ distanceM: 5000, elapsedSec: pbs.k5 });
  if (pbs.k10 && pbs.k10 > 0) efforts.push({ distanceM: 10000, elapsedSec: pbs.k10 });
  if (pbs.h && pbs.h > 0) efforts.push({ distanceM: 21097.5, elapsedSec: pbs.h });
  if (pbs.m && pbs.m > 0) efforts.push({ distanceM: 42195, elapsedSec: pbs.m });
  return efforts;
}

/**
 * Walk all available run sources and pick out RUNNING activities long enough
 * to even be candidates (≥20 min). The derivation engine applies the full
 * outlier/quality filtering itself (HR band, decoupling, treadmill, heat,
 * elevation, pace CV); we just hand it the raw runs.
 *
 * Sources merged:
 *   - `s.wks[].garminActuals` — populated post-onboarding by standalone sync.
 *   - `s.onboardingRunHistory` — seeded by the Strava backfill at onboarding,
 *     before plan generation builds wks. Without this the empirical LT path
 *     would be blind during the entire review screen for fresh users.
 *
 * Dedup by startTime — the same run can appear in both buckets once weeks
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
      if (!a.durationSec || a.durationSec < 1200) continue; // 20 min cutoff — saves work
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
      // Quality fields are optional — populated when the entry was seeded from
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
 *  and the LT detail page (so it can show the same methods/provenance). The
 *  Daniels VDOT input comes from `getPhysiologicalVdot` so every surface that
 *  shows a VDOT or VO2 number resolves to the same value via the same priority
 *  chain. See `src/calculations/physiological-vdot.ts`. */
export function buildLTInputs(s: SimulatorState, opts: { now?: string; garmin?: { ltPaceSecKm: number; ltHR?: number | null; asOf: string } | null } = {}): DeriveLTInput {
  const garmin = opts.garmin === undefined ? (s.garminLT ?? null) : opts.garmin;
  return {
    vdot: getPhysiologicalVdot(s, { now: opts.now }).vdot,
    maxHR: s.maxHR ?? null,
    bestEfforts: pbsToBestEfforts(s),
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

  const inputs = {
    // Daniels VDOT input comes from the unified physiological-VDOT resolver.
    // See `src/calculations/physiological-vdot.ts` for the priority chain.
    vdot: getPhysiologicalVdot(s, { now }).vdot,
    maxHR: s.maxHR ?? null,
    bestEfforts: pbsToBestEfforts(s),
    sustainedEfforts: collectSustainedEfforts(s),
    garmin,
    override: s.ltOverride ?? null,
    now,
  };

  // Derived-only result (ignores Garmin) — used for the conflict check.
  const derivedOnly = deriveLT({ ...inputs, garmin: null });

  // Resolved result (priority chain applied).
  const resolved = resolveLT(inputs);

  // If user has overridden, normally apply it. Per CLAUDE.md "Manually-set
  // Benchmarks Yield to Improvements": auto-clear the override when the derived
  // estimate clearly beats it (faster pace, ≥3 s/km gap, derived confidence
  // 'medium' or 'high'). The paired LTHR comes along — it's a single
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

  // Garmin–derived conflict check: only fires when both values exist *and*
  // differ by more than the threshold. `resolveLT()` would silently prefer
  // Garmin in that case; we want the user's voice instead.
  const garminFresh = garmin && garmin.ltPaceSecKm > 0 && garmin.asOf
    && (new Date(now).getTime() - new Date(garmin.asOf).getTime()) / (1000 * 86400) <= 60;
  const derivedPace = derivedOnly.ltPaceSecKm;

  if (garminFresh && derivedPace != null) {
    const gap = Math.abs(garmin!.ltPaceSecKm - derivedPace);
    if (gap > LT_CONFLICT_THRESHOLD_SEC_KM) {
      s.ltSuggestion = {
        garmin: { ltPaceSecKm: garmin!.ltPaceSecKm, ltHR: garmin!.ltHR ?? null, asOf: garmin!.asOf },
        derived: {
          ltPaceSecKm: derivedPace,
          ltHR: derivedOnly.ltHR,
          provenance: derivedOnly.provenance,
        },
        detectedAt: now,
      };
      // Don't change the active value while a suggestion is pending. If s.lt
      // is empty though, fall back to the resolved value so workouts still
      // generate sensibly.
      if (!s.lt) applyResolved(s, resolved, now);
      return 'pending';
    }
  }

  // No conflict (or no Garmin) — clear any stale suggestion and apply.
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
