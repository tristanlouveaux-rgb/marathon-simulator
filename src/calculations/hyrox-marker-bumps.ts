/**
 * HYROX marker-bump detector — mirrors the triathlon pattern in
 * `tri-marker-bumps.ts`. Currently only the run pace is auto-derived from
 * physiology (VDOT); future work could add station benchmarks once a
 * training-side training-data signal is built (see plan ticket — out of
 * scope for the current bug fix chain).
 *
 * **Side**: tracking. Pure-function detector + a separate state mutation
 * (`applyHyroxRunPaceBump`) that overwrites `hx.hyroxRunPaceSecKm` and flips
 * provenance when the derived value is meaningfully faster than the user's
 * stored value. Mirrors CLAUDE.md "Manually-set Benchmarks Yield to
 * Improvements" rule.
 */

import type { SimulatorState } from '@/types/state';
import { deriveHyroxRunPace } from './hyrox-run-pace';

export interface HyroxMarkerBump {
  marker: 'hyroxRunPace';
  from: number | null;
  to: number;
  improvement: number;
  toastText: string;
}

/** Format pace to "5:00/km" for toast text. */
function fmtPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, '0')}/km`;
}

/** Detect HYROX marker improvements vs the last notified snapshot. */
export function detectHyroxMarkerBumps(state: SimulatorState): HyroxMarkerBump[] {
  const hx = state.hyroxConfig;
  if (!hx) return [];
  const bumps: HyroxMarkerBump[] = [];

  const result = deriveHyroxRunPace(state);
  // Only fire the bump when the derived path won AND we have a previous
  // notified value to compare against. The "yield to improvements" already
  // happened inside deriveHyroxRunPace.
  if (result.source === 'derived') {
    const notified = hx.notifiedMarkers?.hyroxRunPaceSecKm ?? null;
    if (notified != null && notified - result.paceSecKm >= 5) {
      bumps.push({
        marker: 'hyroxRunPace',
        from: notified,
        to: result.paceSecKm,
        improvement: notified - result.paceSecKm,
        toastText: `HYROX run pace updated ${fmtPace(notified)} → ${fmtPace(result.paceSecKm)} — beat your last test.`,
      });
    }
  }
  return bumps;
}

/** Apply the derived run pace to state and flip provenance. Mutates. Caller
 *  must `saveState()`. Idempotent — running on already-derived state is fine.
 *  Returns true when a write happened. */
export function applyHyroxRunPaceDerivation(state: SimulatorState): boolean {
  const hx = state.hyroxConfig;
  if (!hx) return false;
  const result = deriveHyroxRunPace(state);
  if (result.source !== 'derived') {
    // Don't write a 'seed' value into the user's slot. Update the source field
    // for UI accuracy when the slot is empty.
    if (hx.hyroxRunPaceSecKm == null && hx.hyroxRunPaceSource !== result.source) {
      hx.hyroxRunPaceSource = result.source;
      return true;
    }
    return false;
  }
  if (hx.hyroxRunPaceSecKm === result.paceSecKm && hx.hyroxRunPaceSource === 'derived') {
    return false;
  }
  hx.hyroxRunPaceSecKm = result.paceSecKm;
  hx.hyroxRunPaceSource = 'derived';
  return true;
}

/** Snapshot current marker values onto `notifiedMarkers` after surfacing.
 *  Mirrors `snapshotNotifiedMarkers` in `tri-marker-bumps.ts`. */
export function snapshotHyroxNotifiedMarkers(state: SimulatorState): void {
  const hx = state.hyroxConfig;
  if (!hx) return;
  hx.notifiedMarkers = {
    ...(hx.notifiedMarkers ?? {}),
    hyroxRunPaceSecKm: hx.hyroxRunPaceSecKm,
  };
}
