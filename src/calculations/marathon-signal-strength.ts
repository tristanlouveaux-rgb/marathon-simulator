/**
 * Marathon prediction signal strength — derives 0..1 quality scores for each
 * of the six blended predictors used by `blendPredictions`.
 *
 * Powers the "signal fingerprint" radial chart on the race-forecast page.
 * The chart shows *which signals are feeding the prediction*, not what each
 * one predicts numerically (per Tristan's call: show inputs, not internals).
 *
 * Each strength is a coarse proxy for "how much weight does the blend
 * realistically give this predictor for this athlete":
 *   - 0    = signal absent (predictor returns null, contributes nothing)
 *   - 0.33 = signal present but stale or low-confidence
 *   - 0.66 = signal present at medium confidence
 *   - 1.00 = signal present and fresh/high-confidence
 *
 * Heuristics are deliberately simple — the goal is a visually meaningful
 * fingerprint, not a calibration of the blend itself (which already lives
 * in `blendPredictions`).
 */

import type { SimulatorState } from '@/types/state';

export type SignalKey = 'pbs' | 'recent' | 'lt' | 'hrCal' | 'vo2' | 'volume';

export interface SignalStrength {
  key: SignalKey;
  label: string;
  /** 0..1 — drives axis length on the radar. */
  strength: number;
}

const SIGNAL_LABELS: Record<SignalKey, string> = {
  pbs:    'Race PBs',
  recent: 'Recent races',
  lt:     'Lactate threshold',
  hrCal:  'HR + pace',
  vo2:    'Garmin VO2max',
  volume: 'Training volume',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Race PBs: count of filled PBs (out of 4) + freshness bonus from pbDates. */
function pbsStrength(s: SimulatorState): number {
  const pbs = s.pbs;
  if (!pbs) return 0;
  const slots: Array<number | undefined> = [pbs.k5, pbs.k10, pbs.h, pbs.m];
  const filled = slots.filter(v => v != null && v > 0).length;
  if (filled === 0) return 0;
  const base = filled / 4; // 0.25 / 0.5 / 0.75 / 1.0
  // Freshness bonus: any PB within 365 days bumps the score modestly.
  const pbDates = s.onboarding?.pbDates as Record<string, string | undefined> | undefined;
  if (!pbDates) return Math.min(1, base);
  const now = Date.now();
  const anyFresh = (['k5', 'k10', 'h', 'm'] as const).some(k => {
    const iso = pbDates[k];
    if (!iso) return false;
    const age = (now - new Date(iso).getTime()) / DAY_MS;
    return age >= 0 && age <= 365;
  });
  return Math.min(1, base + (anyFresh ? 0.1 : 0));
}

/** Recent races: presence + recency of `s.rec` (RecentRun). */
function recentStrength(s: SimulatorState): number {
  const rec = s.rec;
  if (!rec || !rec.t || rec.t <= 0) return 0;
  const w = rec.weeksAgo ?? 0;
  if (w <= 4)  return 1.0;
  if (w <= 12) return 0.7;
  if (w <= 26) return 0.4;
  return 0.2;
}

/** Lactate threshold pace presence — single boolean signal, kept coarse. */
function ltStrength(s: SimulatorState): number {
  return (s.lt ?? 0) > 0 ? 1.0 : 0;
}

/** HR-calibrated VDOT confidence (set by `refreshBlendedFitness`). */
function hrCalStrength(s: SimulatorState): number {
  const c = s.hrCalibratedVdot?.confidence;
  if (c === 'high')   return 1.0;
  if (c === 'medium') return 0.66;
  if (c === 'low')    return 0.33;
  return 0;
}

/** Garmin / Apple VO2max presence. */
function vo2Strength(s: SimulatorState): number {
  return (s.vo2 ?? 0) > 0 ? 1.0 : 0;
}

/** Training volume signal: how many weeks of recent km data we have. */
function volumeStrength(s: SimulatorState): number {
  const hist = s.historicWeeklyKm ?? [];
  const weeksWithData = hist.filter(km => km > 0).length;
  if (weeksWithData >= 8) return 1.0;
  if (weeksWithData >= 4) return 0.66;
  if (weeksWithData >= 1) return 0.33;
  return 0;
}

/**
 * Compute the six per-signal strengths for the radar. Always returns six
 * entries (in canonical order) so the polygon shape is stable across athletes.
 */
export function getMarathonSignalStrengths(s: SimulatorState): SignalStrength[] {
  return [
    { key: 'pbs',    label: SIGNAL_LABELS.pbs,    strength: pbsStrength(s) },
    { key: 'recent', label: SIGNAL_LABELS.recent, strength: recentStrength(s) },
    { key: 'lt',     label: SIGNAL_LABELS.lt,     strength: ltStrength(s) },
    { key: 'hrCal',  label: SIGNAL_LABELS.hrCal,  strength: hrCalStrength(s) },
    { key: 'vo2',    label: SIGNAL_LABELS.vo2,    strength: vo2Strength(s) },
    { key: 'volume', label: SIGNAL_LABELS.volume, strength: volumeStrength(s) },
  ];
}

/** Count of signals at ≥0.5 strength — drives the "X of 6 signals" caption. */
export function activeSignalCount(signals: SignalStrength[]): number {
  return signals.filter(s => s.strength >= 0.5).length;
}
