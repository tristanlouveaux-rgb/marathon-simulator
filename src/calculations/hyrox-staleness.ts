/**
 * HYROX race-time staleness model.
 *
 * **Side**: tracking. Race time from a year ago should not anchor today's
 * forecast with the same authority as last week's. This module computes a
 * time-based staleness category, and crucially, gates the penalty on
 * cross-mode physiology evidence. An athlete with stable/improving VDOT
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
 *
 * Per-entry splits decay (lane H3c): a station value decays by its OWN date.
 * A race split (or the boot migration's 'manual' seed of one) is the race,
 * so it reads the race-age splitsWeight below. A station test or a guided
 * session best reads hyroxEntrySplitsWeight at the entry's date, with the
 * same curve and the same physiology mitigation, so last week's test is not
 * pulled toward the seed because the race was 9 months ago, and a test 15
 * months old decays even when the race was recent or undated.
 */

import type { SimulatorState } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';
import { getHyroxEventById } from '@/data/hyrox-events';
import { hyroxMtlChronicVsPlan } from './mtl';

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
export function computePhysiologyMitigation(state: SimulatorState): number {
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

  // Signal 2: chronic MTL against the chronic MTL the plan prescribed
  // (mtl.ts computeMtlChronicVsPlan, the computation the race projection's
  // "Training fitness" factor reads). At plan = 0.5, the value the signal
  // gave at its anchor. The anchor used to be 70% of the band's MTL cap, which
  // sits above what the generator prescribes in base (about 57% of cap,
  // intermediate), so a plan-compliant athlete scored 0.35 and released less
  // of the staleness penalty. Withheld behind computeMtlAcwr's history guard.
  const mtlVsPlan = hyroxMtlChronicVsPlan(state);
  if (mtlVsPlan?.ratio != null) {
    const f = Math.max(0, Math.min(1, 0.5 + (mtlVsPlan.ratio - 1) * 0.5));
    factors.push(f);
  }

  // Signal 3: Strava ctlBaseline (Signal A. Running-equivalent). When
  // present, strong baseline = athlete has maintained running volume.
  const ctlBaseline = state.ctlBaseline;
  if (typeof ctlBaseline === 'number' && ctlBaseline > 0) {
    // Anchor at 50 (recreational tier). Below 25 = poor signal; above 75 = strong.
    const f = Math.max(0, Math.min(1, ctlBaseline / 100));
    factors.push(f);
  }

  if (factors.length === 0) return 0.5;
  const mean = factors.reduce((s, v) => s + v, 0) / factors.length;
  // Clamp to [0.5, 1.0]. We never punish athletes for bad mitigation; we
  // only release them from the staleness penalty when the evidence is good.
  return Math.max(0.5, Math.min(1.0, mean));
}

/** Apply physiology mitigation to a base time-decayed weight. Linear lerp from
 *  base toward 1.0 as mitigation goes from 0.5 → 1.0. */
function applyMitigation(baseWeight: number, mitigation: number): number {
  return baseWeight + (1.0 - baseWeight) * (mitigation - 0.5) * 2;
}

interface BaseDecay {
  category: Exclude<HyroxStalenessCategory, 'unknown'>;
  baseBandWeight: number;
  baseSplitsWeight: number;
  confidenceCap: 'low' | 'medium' | null;
}

/** The time-decay curve at an age in months, before physiology mitigation. */
function baseDecayAt(monthsAgo: number): BaseDecay {
  if (monthsAgo < FRESH_MO) {
    return { category: 'fresh', baseBandWeight: 1.0, baseSplitsWeight: 1.0, confidenceCap: null };
  }
  if (monthsAgo < STALE_MO) {
    const t = (monthsAgo - FRESH_MO) / (STALE_MO - FRESH_MO);
    return { category: 'aging', baseBandWeight: 1.0 - 0.6 * t, baseSplitsWeight: 1.0 - 0.2 * t, confidenceCap: 'medium' };
  }
  if (monthsAgo < VERY_STALE_MO) {
    const t = (monthsAgo - STALE_MO) / (VERY_STALE_MO - STALE_MO);
    return { category: 'stale', baseBandWeight: 0.4 - 0.2 * t, baseSplitsWeight: 0.8 - 0.2 * t, confidenceCap: 'low' };
  }
  return { category: 'very_stale', baseBandWeight: 0.2, baseSplitsWeight: 0.6, confidenceCap: 'low' };
}

/** Months between an ISO date and now; null when missing, unparseable or in
 *  the future. */
function monthsSince(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const ms = new Date(dateStr).getTime();
  if (Number.isNaN(ms)) return null;
  const months = (Date.now() - ms) / MS_PER_MONTH;
  return months < 0 ? null : months;
}

/**
 * The splits weight for one station value by its own date (a station test or
 * a guided session best): the race splits' curve read at the entry's age,
 * physiology-mitigated the same way. 1 when the date is missing, unparseable
 * or in the future (the race model's 'unknown'). `mitigation` is
 * computePhysiologyMitigation(state), computed once per forecast.
 */
export function hyroxEntrySplitsWeight(dateISO: string | undefined, mitigation: number): number {
  const months = monthsSince(dateISO);
  if (months == null) return 1;
  return applyMitigation(baseDecayAt(months).baseSplitsWeight, mitigation);
}

/** Bands from slowest to fastest. */
const STALENESS_BAND_ORDER: AbilityBand[] = ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive'];

/**
 * The band a previous race gives once its age is weighed (the onboarding
 * initializer's staleness rule, initialization.hyrox.ts): when the race is
 * old enough to be partly distrusted (bandWeight under 0.7) and the athlete's
 * VDOT gives another band, the slower of the two (never over-promise on a
 * stale benchmark; the staleness model is gated by physiology mitigation, so
 * a still-fit athlete keeps the race's band). `state.hyroxConfig` carries the
 * race (date or event id) and `athleteBand` set to `timeBand`. Shared by the
 * initializer and the version regeneration's re-band (hyrox-plan-regen.ts).
 */
export function hyroxStalenessAdjustedBand(state: SimulatorState, timeBand: AbilityBand): { band: AbilityBand; probe: HyroxStalenessResult } {
  const probe = computeHyroxStaleness(state);
  const vdotBand = bandFromVdot(state.v);
  if (probe.bandWeight < 0.7 && vdotBand && vdotBand !== timeBand) {
    const band = STALENESS_BAND_ORDER.indexOf(timeBand) < STALENESS_BAND_ORDER.indexOf(vdotBand) ? timeBand : vdotBand;
    return { band, probe };
  }
  return { band: timeBand, probe };
}

export function computeHyroxStaleness(state: SimulatorState): HyroxStalenessResult {
  const hx = state.hyroxConfig;
  const dateStr = hx?.hyroxPreviousRaceDate
    ?? (hx?.hyroxPreviousTimeRaceId ? getHyroxEventById(hx.hyroxPreviousTimeRaceId)?.date : undefined);
  const unknown: HyroxStalenessResult = {
    ageMonths: null, category: 'unknown',
    bandWeight: 1, splitsWeight: 1, confidenceCap: null, physiologyMitigation: 1,
  };
  const monthsAgo = monthsSince(dateStr);
  if (monthsAgo == null) return unknown; // no date, unparseable, or future-dated

  const mitigation = computePhysiologyMitigation(state);
  const d = baseDecayAt(monthsAgo);

  return {
    ageMonths: monthsAgo,
    category: d.category,
    bandWeight: applyMitigation(d.baseBandWeight, mitigation),
    splitsWeight: applyMitigation(d.baseSplitsWeight, mitigation),
    confidenceCap: d.confidenceCap,
    physiologyMitigation: mitigation,
  };
}
