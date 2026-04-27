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

import { resolveLT, deriveLT, type BestEffortInput, type SustainedEffortInput, type DeriveLTInput, type LTDerivationResult } from '@/calculations/lt-derivation';
import type { SimulatorState } from '@/types';

/** Conflict threshold — Garmin and derived must agree within this band to apply silently. */
const LT_CONFLICT_THRESHOLD_SEC_KM = 10;

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
 * Walk garminActuals across all weeks and pick out RUNNING activities long
 * enough to even be candidates (≥20 min). The derivation engine applies the
 * full outlier/quality filtering itself (HR band, decoupling, treadmill, heat,
 * elevation, pace CV); we just hand it the raw runs.
 */
function collectSustainedEfforts(s: SimulatorState): SustainedEffortInput[] {
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
      out.push({
        startTime: a.startTime,
        durationSec: a.durationSec,
        avgPaceSecKm: a.avgPaceSecKm,
        avgHR: a.avgHR,
        kmSplits: a.kmSplits ?? null,
        sportType: a.activityType ?? null,
        ambientTempC: a.ambientTempC ?? null,
        elevationGainM: a.elevationGainM ?? null,
      });
    }
  }
  return out;
}

/** Build the full DeriveLTInput from current state — used by both the sync flow
 *  and the LT detail page (so it can show the same methods/provenance). */
export function buildLTInputs(s: SimulatorState, opts: { now?: string; garmin?: { ltPaceSecKm: number; ltHR?: number | null; asOf: string } | null } = {}): DeriveLTInput {
  const garmin = opts.garmin === undefined ? (s.garminLT ?? null) : opts.garmin;
  return {
    vdot: s.vo2 ?? s.v ?? null,
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
    vdot: s.vo2 ?? s.v ?? null,
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

  // If user has overridden, just apply it. No conflict logic.
  if (s.ltOverride) {
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
