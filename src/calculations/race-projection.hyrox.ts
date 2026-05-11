/**
 * HYROX race-day projection.
 *
 * **Side of the line**: tracking. Projects current prediction forward to race
 * day, factoring in training volume, sessions/week, plan adherence to date,
 * MTL CTL trend, and taper proximity. Mirrors the triathlon `buildProjection`
 * approach — see `race-prediction.triathlon.ts:340` for the parent pattern.
 *
 * The current `predictHyroxRace()` answers "if you raced today". This module
 * projects that forward via percentage adjustments, returning:
 *   - `projectedTotalSec` — race-day estimated finish
 *   - `factors` — itemised contributions for transparency
 *   - `confidenceRangeSec` — symmetric ±band around the projection
 *
 * Confidence: medium-low. The factor weights are heuristic (anchored on
 * running/triathlon horizon-model parameters, with HYROX-specific scaling
 * applied to MTL CTL). They will sharpen as real outcome data lands.
 */

import type { SimulatorState, PhysiologyDayEntry } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';
import type { HyroxPrediction } from './race-prediction.hyrox';
import {
  HYROX_WEEKLY_SESSIONS,
  HYROX_TAPER_DAYS,
  HYROX_MTL_CAP,
} from '@/constants/hyrox-constants';

export interface HyroxProjectionFactor {
  /** Display name. */
  name: string;
  /** Time delta in seconds (negative = faster, positive = slower). */
  deltaSec: number;
  /** Plain-language explanation surfaced in the confidence panel. */
  explanation: string;
}

export interface HyroxProjection {
  /** Race-day projected total finish time. */
  projectedTotalSec: number;
  /** Today's total (passthrough from prediction). */
  currentTotalSec: number;
  /** Net delta from current to projected (negative = expected to get faster). */
  improvementSec: number;
  /** Itemised factor list for the confidence-panel breakdown. */
  factors: HyroxProjectionFactor[];
  /** Symmetric confidence range around projectedTotalSec, e.g. [low, high]. */
  confidenceRangeSec: [number, number];
  /** Number of weeks until the race (or 0 if no race date / past). */
  weeksRemaining: number;
  /** Per-component breakdown of the improvement allocation. */
  byDiscipline: {
    run:      { currentSec: number; projectedSec: number; deltaSec: number };
    stations: { currentSec: number; projectedSec: number; deltaSec: number };
    roxzone:  { currentSec: number; projectedSec: number; deltaSec: number };
  };
}

/** Days between two ISO dates. Negative if `to` is before `from`. */
function daysBetween(fromISO: string, toISO: string): number {
  const a = new Date(fromISO).getTime();
  const b = new Date(toISO).getTime();
  return Math.round((b - a) / 86400000);
}

/**
 * Compute weeks remaining to the race. Returns 0 if no race date or race already past.
 */
function computeWeeksRemaining(state: SimulatorState): number {
  const raceDate = state.hyroxConfig?.raceDate ?? state.onboarding?.customRaceDate;
  if (!raceDate) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const days = daysBetween(today, raceDate);
  if (days <= 0) return 0;
  return days / 7;
}

/**
 * Approximate per-band CTL anchor. The expected MTL CTL (daily-equivalent ÷7
 * EMA of weeklyMTL) for an athlete training at band-default volume.
 * Below this anchor the athlete is undertrained for their declared band; above,
 * they have headroom. Anchors are ~70% of the band's MTL cap, divided by 7.
 */
function expectedMtlCtl(band: AbilityBand): number {
  return (HYROX_MTL_CAP[band] * 0.70) / 7;
}

/**
 * Compute a readiness score (0..1) from physiologyHistory.
 * Combines HRV trend (28-day baseline vs 7-day mean), sleep score, and RHR trend.
 * Returns 0.5 for "neutral" when data is missing.
 */
function computeReadinessScore(physio: PhysiologyDayEntry[] | undefined): number | null {
  if (!physio || physio.length < 14) return null;
  const recent7 = physio.slice(-7);
  const baseline28 = physio.slice(-28);

  // HRV trend: recent vs baseline.
  const hrvRecent = recent7.map(p => p.hrvRmssd).filter((v): v is number => typeof v === 'number');
  const hrvBaseline = baseline28.map(p => p.hrvRmssd).filter((v): v is number => typeof v === 'number');
  let hrvFactor = 0.5;
  if (hrvRecent.length >= 3 && hrvBaseline.length >= 7) {
    const r = hrvRecent.reduce((s, v) => s + v, 0) / hrvRecent.length;
    const b = hrvBaseline.reduce((s, v) => s + v, 0) / hrvBaseline.length;
    if (b > 0) {
      const ratio = r / b;
      hrvFactor = Math.max(0, Math.min(1, 0.5 + (ratio - 1) * 2.5));
    }
  }

  // Sleep score: 7-day mean (Garmin scale 0–100).
  const sleepRecent = recent7.map(p => p.sleepScore).filter((v): v is number => typeof v === 'number');
  let sleepFactor = 0.5;
  if (sleepRecent.length >= 3) {
    const mean = sleepRecent.reduce((s, v) => s + v, 0) / sleepRecent.length;
    sleepFactor = Math.max(0, Math.min(1, mean / 100));
  }

  // RHR trend: recent vs baseline (lower = better).
  const rhrRecent = recent7.map(p => p.restingHR).filter((v): v is number => typeof v === 'number');
  const rhrBaseline = baseline28.map(p => p.restingHR).filter((v): v is number => typeof v === 'number');
  let rhrFactor = 0.5;
  if (rhrRecent.length >= 3 && rhrBaseline.length >= 7) {
    const r = rhrRecent.reduce((s, v) => s + v, 0) / rhrRecent.length;
    const b = rhrBaseline.reduce((s, v) => s + v, 0) / rhrBaseline.length;
    if (b > 0) {
      const ratio = r / b;  // <1 = recent lower = better
      rhrFactor = Math.max(0, Math.min(1, 0.5 + (1 - ratio) * 5));
    }
  }

  // Weighted blend: HRV 50%, sleep 25%, RHR 25%.
  return hrvFactor * 0.5 + sleepFactor * 0.25 + rhrFactor * 0.25;
}

/**
 * Compute plan adherence ratio (0..1) for the last N completed weeks.
 * Counts completed station/brick/run sessions vs planned, excluding the current week.
 */
function computeAdherence(state: SimulatorState, lookbackWeeks: number = 3): number {
  const wks = state.wks ?? [];
  const currentIdx = (state.w ?? 1) - 1;
  const startIdx = Math.max(0, currentIdx - lookbackWeeks);
  let plannedCount = 0;
  let completedCount = 0;
  for (let i = startIdx; i < currentIdx; i++) {
    const wk: any = wks[i];
    if (!wk) continue;
    const planned = (wk.triWorkouts ?? []).length;
    const completed = (wk.garminActuals ?? []).length;
    plannedCount += planned;
    completedCount += Math.min(completed, planned);
  }
  if (plannedCount === 0) return 1.0;
  return Math.min(1, completedCount / plannedCount);
}

/**
 * Build a race-day projection from the current prediction.
 *
 * The projection adjusts the current finish time by stacked percentage factors:
 *   - **MTL fitness gap**: actual mtlCTL vs band-expected anchor
 *   - **Sessions per week**: configured volume vs band default
 *   - **Plan adherence**: completed vs planned over last 3 weeks
 *   - **Taper readiness**: ~1-2% bonus when within taper window
 *
 * Each factor is bounded so the combined projection multiplier stays in [0.93, 1.07].
 */
export function buildHyroxProjection(state: SimulatorState, prediction: HyroxPrediction): HyroxProjection {
  const hx = state.hyroxConfig!;
  const band = hx.athleteBand;
  const factors: HyroxProjectionFactor[] = [];
  const currentTotalSec = prediction.totalSec;

  // ── Factor 1: MTL CTL fitness vs band anchor ────────────────────────────
  // Prefer per-discipline split CTL when available; fall back to overall mtlCTL.
  // Discipline splits let us attribute fitness gains specifically to run vs stations
  // rather than as a single global factor.
  const expected = expectedMtlCtl(band);
  const runCtl     = hx.runMtlCTL     ?? 0;
  const stationCtl = hx.stationMtlCTL ?? 0;
  const brickCtl   = hx.brickMtlCTL   ?? 0;
  const splitTotalCtl = runCtl + stationCtl + brickCtl;
  const actualCtl = splitTotalCtl > 0 ? splitTotalCtl : (hx.mtlCTL ?? 0);
  if (expected > 0 && actualCtl > 0) {
    const ratio = actualCtl / expected;  // 1.0 = on band, >1 = above, <1 = below
    // Convert to ±5% bound. Tanh-style soft saturation keeps extreme ratios from blowing up.
    const ctlPct = Math.max(-0.05, Math.min(0.05, (ratio - 1) * 0.10));
    const ctlSec = -ctlPct * currentTotalSec;  // negative pct = faster
    const splitNote = splitTotalCtl > 0
      ? ` Run ${runCtl.toFixed(1)} · stations ${stationCtl.toFixed(1)} · brick ${brickCtl.toFixed(1)}.`
      : '';
    factors.push({
      name: 'Training fitness',
      deltaSec: Math.round(ctlSec),
      explanation: (ratio >= 1.0
        ? `MTL chronic load (${actualCtl.toFixed(1)}) is above the ${band} band anchor (${expected.toFixed(1)}). Training above your declared level.`
        : `MTL chronic load (${actualCtl.toFixed(1)}) is below the ${band} band anchor (${expected.toFixed(1)}). Currently undertrained for your target.`) + splitNote,
    });
  }

  // ── Factor 2: Sessions per week vs band default ────────────────────────
  const defaults = HYROX_WEEKLY_SESSIONS[band];
  const expectedSessions = defaults.runs + defaults.stations + defaults.bricks;
  const actualSessions = (hx.runsPerWeek ?? defaults.runs)
                        + (hx.stationSessionsPerWeek ?? defaults.stations)
                        + (hx.bricksPerWeek ?? defaults.bricks);
  if (expectedSessions > 0) {
    const sessionRatio = actualSessions / expectedSessions;
    const sessionPct = Math.max(-0.03, Math.min(0.03, (sessionRatio - 1) * 0.06));
    const sessionSec = -sessionPct * currentTotalSec;
    if (Math.abs(sessionSec) >= 5) {
      factors.push({
        name: 'Weekly volume',
        deltaSec: Math.round(sessionSec),
        explanation: `${actualSessions} sessions/week vs band default of ${expectedSessions}.`,
      });
    }
  }

  // ── Factor 3: Plan adherence ───────────────────────────────────────────
  const adherence = computeAdherence(state);
  if (adherence < 0.95) {
    // Penalise: missed sessions cost up to 4% slowdown.
    const adherencePct = (1 - adherence) * 0.04;  // 0..4% slowdown
    const adherenceSec = adherencePct * currentTotalSec;
    factors.push({
      name: 'Plan adherence',
      deltaSec: Math.round(adherenceSec),
      explanation: `Completed ${Math.round(adherence * 100)}% of planned sessions in the last 3 weeks.`,
    });
  }

  // ── Factor 4: Taper readiness ──────────────────────────────────────────
  const weeksRemaining = computeWeeksRemaining(state);
  const taperWindowWeeks = HYROX_TAPER_DAYS[band] / 7;
  if (weeksRemaining > 0 && weeksRemaining <= taperWindowWeeks * 1.5) {
    // 1.5–2% taper bonus — fitness consolidates, fatigue clears.
    // Scale by how much taper time remains within the window.
    const taperFraction = Math.min(1, (taperWindowWeeks - Math.max(0, weeksRemaining - taperWindowWeeks)) / taperWindowWeeks);
    const taperPct = -0.015 * taperFraction;
    const taperSec = taperPct * currentTotalSec;
    factors.push({
      name: 'Taper bonus',
      deltaSec: Math.round(taperSec),
      explanation: `Race in ~${weeksRemaining.toFixed(1)} weeks. Taper consolidates fitness — typical 1-2% improvement.`,
    });
  }

  // ── Factor 5: Race-day readiness (HRV / sleep / RHR) ───────────────────
  // Only meaningful close to the race. Fires within taper window only.
  if (weeksRemaining > 0 && weeksRemaining <= taperWindowWeeks * 1.5) {
    const readinessScore = computeReadinessScore(state.physiologyHistory);
    if (readinessScore != null) {
      // Score 0.5 = neutral. Range −2% (poor) to +2% (great).
      const readinessPct = (0.5 - readinessScore) * 0.04;  // poor readiness → +2% (slower)
      const readinessSec = readinessPct * currentTotalSec;
      if (Math.abs(readinessSec) >= 5) {
        const readinessLabel = readinessScore >= 0.7 ? 'high' : readinessScore <= 0.35 ? 'low' : 'moderate';
        factors.push({
          name: 'Race-day readiness',
          deltaSec: Math.round(readinessSec),
          explanation: `Recovery signals over the last 7 days indicate ${readinessLabel} readiness. HRV, sleep, and resting HR vs baseline.`,
        });
      }
    }
  }

  // ── Combine ────────────────────────────────────────────────────────────
  const totalDeltaSec = factors.reduce((s, f) => s + f.deltaSec, 0);
  const projectedTotalSec = currentTotalSec + totalDeltaSec;

  // ── Per-discipline allocation ──────────────────────────────────────────
  // Apportion the total improvement proportionally to each component's share
  // of current total. Run + stations get the projection delta; roxzone is
  // mostly a transition fudge and stays static.
  const runShare      = prediction.runSec / Math.max(1, currentTotalSec);
  const stationsShare = prediction.stationsSec / Math.max(1, currentTotalSec);
  const runDelta      = Math.round(totalDeltaSec * runShare);
  const stationsDelta = Math.round(totalDeltaSec * stationsShare);
  // Roxzone gets the remainder (small, near zero) — keeps the breakdown summing to total.
  const roxzoneDelta  = totalDeltaSec - runDelta - stationsDelta;
  const byDiscipline = {
    run:      { currentSec: prediction.runSec,      projectedSec: prediction.runSec + runDelta,           deltaSec: runDelta },
    stations: { currentSec: prediction.stationsSec, projectedSec: prediction.stationsSec + stationsDelta, deltaSec: stationsDelta },
    roxzone:  { currentSec: prediction.roxzoneSec,  projectedSec: prediction.roxzoneSec + roxzoneDelta,   deltaSec: roxzoneDelta },
  };

  // ── Confidence range ───────────────────────────────────────────────────
  // Base ±4% range. Widens with weeksRemaining (uncertainty grows farther out)
  // and tightens with calibration (high-confidence prediction → tighter band).
  let basePct = 0.04;
  if (weeksRemaining > 4)  basePct += 0.01;
  if (weeksRemaining > 12) basePct += 0.01;
  if (prediction.confidence === 'low')    basePct += 0.02;
  if (prediction.confidence === 'medium') basePct += 0.01;
  const halfRange = projectedTotalSec * basePct;
  const confidenceRangeSec: [number, number] = [
    Math.round(projectedTotalSec - halfRange),
    Math.round(projectedTotalSec + halfRange),
  ];

  return {
    projectedTotalSec: Math.round(projectedTotalSec),
    currentTotalSec,
    improvementSec: Math.round(projectedTotalSec - currentTotalSec),
    factors,
    confidenceRangeSec,
    weeksRemaining,
    byDiscipline,
  };
}
