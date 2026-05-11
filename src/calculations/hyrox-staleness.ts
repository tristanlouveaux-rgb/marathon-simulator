/**
 * HYROX race-time staleness model.
 *
 * **Side**: tracking. Race time from a year ago should not anchor today's
 * forecast with the same authority as last week's. This module computes a
 * time-based staleness category, and crucially, gates the penalty on
 * cross-mode physiology evidence — an athlete with stable/improving VDOT
 * through the race-age window has clearly maintained fitness, so we should
 * lean less heavily on the time decay.
 *
 * Detraining literature anchor: Mujika & Padilla 2000, Coyle 1984
 * (cited in SCIENCE_LOG §A and §K). HYROX-specific consideration: skill
 * components (sled push, sandbag carry, wall ball cadence) decay slower than
 * pure VO2max if the athlete keeps doing functional work. So we decay BAND
 * weight faster than SPLITS weight.
 *
 * Thresholds (6 / 12 / 24 months) are directional, not precise. Recalibrate
 * once race-outcome data lands. See SCIENCE_LOG §V.
 */

import type { SimulatorState } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';
import { getHyroxEventById } from '@/data/hyrox-events';
import { HYROX_MTL_CAP } from '@/constants/hyrox-constants';

export type HyroxStalenessCategory = 'fresh' | 'aging' | 'stale' | 'very_stale' | 'unknown';

export interface HyroxStalenessResult {
  ageMonths: number | null;
  category: HyroxStalenessCategory;
  /** Weight on race-time-derived BAND. 1.0 = full trust, 0 = ignore. */
  bandWeight: number;
  /** Weight on per-station SPLITS. Decays slower (skill persistence). */
  splitsWeight: number;
  /** Confidence cap to apply to the prediction's confidence field. */
  confidenceCap: 'low' | 'medium' | null;
  /** Physiology evidence factor [0.5..1.0]. 1.0 = athlete clearly held or
   *  improved fitness; pulls weights back toward 1.0. 0.5 = no evidence
   *  either way. */
  physiologyMitigation: number;
}

const FRESH_MO = 6;
const STALE_MO = 12;
const VERY_STALE_MO = 24;
const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

/** Map VDOT to a HYROX ability band (mirrors HYROX_TIME_TO_BAND_THRESHOLDS
 *  but keyed off aerobic capacity instead of finish time). */
export function bandFromVdot(v: number | null | undefined): AbilityBand | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 60) return 'competitive';
  if (v >= 53) return 'advanced';
  if (v >= 45) return 'intermediate';
  if (v >= 38) return 'novice';
  if (v >= 30) return 'beginner';
  return 'total_beginner';
}

/** Compute physiology mitigation [0.5..1.0] from current cross-mode signals.
 *  Mirrors the readiness-score blend in race-projection.hyrox.ts but adapted
 *  to a "have you held fitness?" question rather than a "are you race-ready
 *  today?" question. */
function computePhysiologyMitigation(state: SimulatorState): number {
  const hx = state.hyroxConfig;
  if (!hx) return 0.5;

  const factors: number[] = [];

  // Signal 1: VDOT vs band-implied VDOT. Above implied = mitigation up.
  const v = state.v;
  const impliedVdot: Record<AbilityBand, number> = {
    competitive: 60, advanced: 53, intermediate: 45,
    novice: 38, beginner: 32, total_beginner: 28,
  };
  if (typeof v === 'number' && v > 0) {
    const expected = impliedVdot[hx.athleteBand];
    // Lerp: VDOT at expected = 0.7 (slight positive); +5 above = 1.0;
    // -5 below = 0.4. Bounded.
    const ratio = (v - expected) / 5;
    const f = Math.max(0, Math.min(1, 0.7 + ratio * 0.3));
    factors.push(f);
  }

  // Signal 2: MTL CTL vs band-expected (anchor at 70% of cap). Above = good.
  const ctl = hx.mtlCTL ?? 0;
  if (ctl > 0) {
    const expectedCtl = (HYROX_MTL_CAP[hx.athleteBand] * 0.70) / 7;
    const ratio = ctl / expectedCtl;
    const f = Math.max(0, Math.min(1, 0.5 + (ratio - 1) * 0.5));
    factors.push(f);
  }

  // Signal 3: Strava ctlBaseline (Signal A — running-equivalent). When
  // present, strong baseline = athlete has maintained running volume.
  const ctlBaseline = state.ctlBaseline;
  if (typeof ctlBaseline === 'number' && ctlBaseline > 0) {
    // Anchor at 50 (recreational tier). Below 25 = poor signal; above 75 = strong.
    const f = Math.max(0, Math.min(1, ctlBaseline / 100));
    factors.push(f);
  }

  if (factors.length === 0) return 0.5;
  const mean = factors.reduce((s, v) => s + v, 0) / factors.length;
  // Clamp to [0.5, 1.0] — we never punish athletes for bad mitigation; we
  // only release them from the staleness penalty when the evidence is good.
  return Math.max(0.5, Math.min(1.0, mean));
}

/** Apply physiology mitigation to a base time-decayed weight. Linear lerp from
 *  base toward 1.0 as mitigation goes from 0.5 → 1.0. */
function applyMitigation(baseWeight: number, mitigation: number): number {
  return baseWeight + (1.0 - baseWeight) * (mitigation - 0.5) * 2;
}

export function computeHyroxStaleness(state: SimulatorState): HyroxStalenessResult {
  const hx = state.hyroxConfig;
  const dateStr = hx?.hyroxPreviousRaceDate
    ?? (hx?.hyroxPreviousTimeRaceId ? getHyroxEventById(hx.hyroxPreviousTimeRaceId)?.date : undefined);
  const unknown: HyroxStalenessResult = {
    ageMonths: null, category: 'unknown',
    bandWeight: 1, splitsWeight: 1, confidenceCap: null, physiologyMitigation: 1,
  };
  if (!dateStr) return unknown;

  const raceMs = new Date(dateStr).getTime();
  if (Number.isNaN(raceMs)) return unknown;
  const monthsAgo = (Date.now() - raceMs) / MS_PER_MONTH;
  if (monthsAgo < 0) return unknown; // future-dated nonsense, treat as unknown

  const mitigation = computePhysiologyMitigation(state);

  let baseBandWeight = 1.0;
  let baseSplitsWeight = 1.0;
  let category: HyroxStalenessCategory = 'fresh';
  let confidenceCap: 'low' | 'medium' | null = null;

  if (monthsAgo < FRESH_MO) {
    // No decay.
  } else if (monthsAgo < STALE_MO) {
    category = 'aging';
    const t = (monthsAgo - FRESH_MO) / (STALE_MO - FRESH_MO);
    baseBandWeight = 1.0 - 0.6 * t;
    baseSplitsWeight = 1.0 - 0.2 * t;
    confidenceCap = 'medium';
  } else if (monthsAgo < VERY_STALE_MO) {
    category = 'stale';
    const t = (monthsAgo - STALE_MO) / (VERY_STALE_MO - STALE_MO);
    baseBandWeight = 0.4 - 0.2 * t;
    baseSplitsWeight = 0.8 - 0.2 * t;
    confidenceCap = 'low';
  } else {
    category = 'very_stale';
    baseBandWeight = 0.2;
    baseSplitsWeight = 0.6;
    confidenceCap = 'low';
  }

  return {
    ageMonths: monthsAgo,
    category,
    bandWeight: applyMitigation(baseBandWeight, mitigation),
    splitsWeight: applyMitigation(baseSplitsWeight, mitigation),
    confidenceCap,
    physiologyMitigation: mitigation,
  };
}
