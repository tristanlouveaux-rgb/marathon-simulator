/**
 * Physiological VDOT Resolution — single source of truth for "what's this
 * athlete's best available estimate of aerobic capacity right now?"
 *
 * Anchors the Daniels T-pace formula (LT engine), the VO2 stats card, and the
 * onboarding fitness row. Before this lived as a single function, three
 * surfaces independently picked from `s.vo2`, `s.hrCalibratedVdot`,
 * `deriveVdotFromLT(s.lt)`, PB-derived VDOT and `s.v` with subtly different
 * priorities and confidence semantics. The same athlete saw different VDOTs
 * across Stats / LT detail / onboarding by several points.
 *
 * This module returns one number, plus the source it came from and a short
 * caption, so every surface displays the same value with the same provenance.
 *
 * Distinct from `getEffectiveVdot(s)` in `effective-vdot.ts`, which adds
 * `rpeAdj + physioAdj` for race-time prediction and pace-zone prescription.
 * Those adjustments answer "what could you race today" — they don't belong
 * on a physiology number that should answer "what's your aerobic capacity"
 * (capacity doesn't shift when the user clicks an RPE dial).
 *
 * Pure — no state mutation, no I/O.
 */

import type { SimulatorState } from '@/types';
import { cv } from './vdot';
import { deriveVdotFromLT } from './lt-derivation';

// ─── Types ────────────────────────────────────────────────────────────────

export type PhysiologicalVdotSource =
  | 'device'          // s.vo2, fresh
  | 'hr-calibrated'   // s.hrCalibratedVdot, medium+ confidence
  | 'lt-derived'      // deriveVdotFromLT(s.lt) — only when LT was observation-based
  | 'pb-median'       // median of cv() across race-distance PBs
  | 'tanda-fallback'  // s.v, last resort
  | 'none';           // nothing usable

export type PhysiologicalVdotConfidence = 'high' | 'medium' | 'low' | 'none';

export interface PhysiologicalVdotResult {
  /** Resolved VDOT, or null when no source provided a usable value. */
  vdot: number | null;
  /** Which tier of the priority chain produced the value. */
  source: PhysiologicalVdotSource;
  /** Confidence in the value. Inherited from the source where applicable. */
  confidence: PhysiologicalVdotConfidence;
  /** Short human caption for UI. e.g. "From your watch", "Calibrated from 6 steady runs". */
  detail: string;
  /** True when we used `s.vo2` and it was within the freshness window. */
  isDeviceFresh: boolean;
  /** Days since the most recent device VO2 reading, when known. Null when no
   *  history is available (legacy state) or when no device value exists. */
  deviceAgeDays: number | null;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Freshness window for `s.vo2`. Matches the existing 60-day Garmin-LT window's
 *  intent (use device readings while they reflect current physiology). 90 days
 *  is the user-chosen default for VO2; longer than LT because VO2max drifts
 *  more slowly than LT pace. Beyond this window, fall through to derived
 *  sources rather than pin a stale device value. */
const DEVICE_FRESHNESS_DAYS = 90;

/** LT-derived VDOT only fires when LT itself came from observation, not from
 *  Daniels — otherwise we'd back-derive a number we just forward-derived
 *  (perfectly circular) or partially circular (the `'blended'` case includes
 *  Daniels at 0.35 weight). Trusted sources: empirical (steady runs),
 *  critical-speed (PBs), garmin (watch), override (user-entered). */
const TRUSTED_LT_SOURCES = new Set(['empirical', 'critical-speed', 'garmin', 'override']);

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── PB-derived VDOT (relocated from ltSync.ts so VDOT-source logic lives in one file) ───

/**
 * Median VDOT across the user's race-distance PBs (5K / 10K / HM / marathon).
 *
 * Median (not max) because PB profiles are often imbalanced — a fast 5K
 * specialist with weak endurance shouldn't have their 5K alone drive the
 * estimate, and a marathoner with a slow 5K shouldn't lose theirs to it.
 * The median collapses both biases.
 */
export function pbDerivedVdot(s: SimulatorState): number | null {
  const pbs = s.pbs ?? {};
  const candidates: number[] = [];
  if (pbs.k5 && pbs.k5 > 0) candidates.push(cv(5000, pbs.k5));
  if (pbs.k10 && pbs.k10 > 0) candidates.push(cv(10000, pbs.k10));
  if (pbs.h && pbs.h > 0) candidates.push(cv(21097.5, pbs.h));
  if (pbs.m && pbs.m > 0) candidates.push(cv(42195, pbs.m));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a - b);
  const mid = Math.floor(candidates.length / 2);
  return candidates.length % 2 === 0
    ? (candidates[mid - 1] + candidates[mid]) / 2
    : candidates[mid];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Days since the most recent `physiologyHistory` entry that carried a
 * non-null `vo2max`. Returns null when the history is empty or absent —
 * legacy state where we have `s.vo2` but no dated history is treated as
 * "fresh enough", because dropping a perfectly good number on a missing-
 * timestamp technicality would be worse than the (small) staleness risk.
 */
function deviceVo2AgeDays(s: SimulatorState, now: Date): number | null {
  const hist = s.physiologyHistory;
  if (!hist || hist.length === 0) return null;
  let mostRecent: string | null = null;
  for (const entry of hist) {
    if (entry.vo2max == null) continue;
    if (mostRecent == null || entry.date > mostRecent) mostRecent = entry.date;
  }
  if (mostRecent == null) return null;
  const ageMs = now.getTime() - new Date(mostRecent).getTime();
  return ageMs / DAY_MS;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

/**
 * Resolve the best available physiological VDOT for `s`. Walks a fixed
 * priority chain and returns the first source that yields a usable value.
 *
 * Priority:
 *   1. `s.vo2` (device-direct), when within {DEVICE_FRESHNESS_DAYS} of the
 *      most recent `physiologyHistory` reading. Watch is ground truth.
 *   2. `s.hrCalibratedVdot.vdot`, when confidence is 'high' or 'medium'.
 *      Pace-vs-%HRR regression of recent qualifying runs.
 *   3. `deriveVdotFromLT(s.lt)`, when `s.ltSource` is one of the trusted
 *      observation-based sources (empirical / critical-speed / garmin /
 *      override). Skipped for daniels/blended to avoid circularity.
 *   4. PB-median VDOT — median of `cv()` across the user's race PBs.
 *   5. `s.v` (Tanda-blended), as a last resort. This number is volume-
 *      discounted and under-states aerobic capacity for triathletes who cut
 *      back on running; we use it only when none of the more-direct sources
 *      are available.
 *
 * Returns `{ vdot: null, source: 'none' }` when nothing is usable.
 */
export function getPhysiologicalVdot(
  s: SimulatorState,
  opts: { now?: string | Date } = {},
): PhysiologicalVdotResult {
  const now = opts.now
    ? (opts.now instanceof Date ? opts.now : new Date(opts.now))
    : new Date();

  const deviceAgeDays = deviceVo2AgeDays(s, now);
  const isDeviceFresh = s.vo2 != null && s.vo2 > 0
    && (deviceAgeDays == null || deviceAgeDays <= DEVICE_FRESHNESS_DAYS);

  // 1. Device-direct, fresh.
  if (isDeviceFresh) {
    return {
      vdot: s.vo2 as number,
      source: 'device',
      confidence: 'high',
      detail: 'From your watch',
      isDeviceFresh: true,
      deviceAgeDays,
    };
  }

  // 2. HR-calibrated regression at medium+ confidence.
  const hr = s.hrCalibratedVdot;
  if (hr?.vdot != null && (hr.confidence === 'high' || hr.confidence === 'medium')) {
    const runWord = hr.n === 1 ? 'run' : 'runs';
    return {
      vdot: hr.vdot,
      source: 'hr-calibrated',
      confidence: hr.confidence,
      detail: `Calibrated from ${hr.n} steady ${runWord}`,
      isDeviceFresh: false,
      deviceAgeDays,
    };
  }

  // 3. LT-back-derived, only when LT was observation-based (avoid circularity).
  if (s.lt && s.ltSource && TRUSTED_LT_SOURCES.has(s.ltSource)) {
    const ltVdot = deriveVdotFromLT(s.lt);
    if (ltVdot != null && ltVdot >= 25) {
      const conf: PhysiologicalVdotConfidence = s.ltConfidence ?? 'medium';
      return {
        vdot: ltVdot,
        source: 'lt-derived',
        confidence: conf,
        detail: 'Derived from your LT pace',
        isDeviceFresh: false,
        deviceAgeDays,
      };
    }
  }

  // 4. PB-median across race PBs.
  const pbVdot = pbDerivedVdot(s);
  if (pbVdot != null) {
    return {
      vdot: pbVdot,
      source: 'pb-median',
      confidence: 'medium',
      detail: 'Median of your race-distance PBs',
      isDeviceFresh: false,
      deviceAgeDays,
    };
  }

  // 5. Tanda-blended fallback (volume-discounted, last resort).
  if (s.v != null && s.v > 0) {
    return {
      vdot: s.v,
      source: 'tanda-fallback',
      confidence: 'low',
      detail: 'Estimated from recent training',
      isDeviceFresh: false,
      deviceAgeDays,
    };
  }

  return {
    vdot: null,
    source: 'none',
    confidence: 'none',
    detail: '',
    isDeviceFresh: false,
    deviceAgeDays,
  };
}
