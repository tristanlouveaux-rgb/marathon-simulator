/**
 * Monte Carlo forecast simulator — triathlon mode.
 *
 * Mirrors the marathon sim (`race-forecast-simulation.ts`) but operates on the
 * already-computed triathlon prediction (`predictTriathlonRace`) as its
 * deterministic mean. Per Tristan's design call (2026-05-19), tri uses a
 * single total-time cone (not per-discipline cones) — the race-forecast card
 * above the cone surfaces per-leg detail; the cone is for "total race
 * outcome range".
 *
 * Three uncertainty sources (same as running):
 *
 *   1. Improvement-percentage variance around the mean training response
 *      (Bouchard 2011 individual-response literature, scaled wider to
 *      capture life noise).
 *   2. Adherence (clipped normal, mean 0.90, σ 0.12).
 *   3. Race-day form factor (N(1.0, 0.025), clipped ±7%, ramping in over
 *      the last 8 weeks).
 *
 * The implicit assumption with a single total-time sim is that per-discipline
 * improvements are correlated within a trial (one athlete, one body, one
 * training response) — which is the right modelling choice for a single-trial
 * multi-discipline race. A per-discipline cone is a future extension.
 *
 * Returns the same `ForecastSimResult` shape as the marathon sim so the
 * shared chart builder (`src/ui/forecast-cone.ts`) renders both modes
 * identically.
 *
 * Seeded RNG (`mulberry32(101 + currentWeek)`) keeps the displayed cone
 * stable within a plan week.
 *
 * Science note: `docs/SCIENCE_LOG.md §MC`.
 */

import type { SimulatorState } from '@/types';
import type { ForecastSimResult } from './race-forecast-simulation';
import { predictTriathlonRace } from './race-prediction.triathlon';

// ── RNG (seeded for stable display) ──────────────────────────────────────────

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalSample(rng: () => number, mean: number, sd: number): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sd;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function smoothstep(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return p * p * (3 - 2 * p);
}

function percentile(sortedAsc: number[], pct: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = pct * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

// ── Simulator ────────────────────────────────────────────────────────────────

/**
 * @param goalSec  Optional user-set goal time. From `triConfig.targetFinishTimeSec`
 *                 in production. Never derive from any model prediction.
 */
export function runTriForecastSim(
  s: SimulatorState,
  trialCount: number = 2000,
  goalSec: number | null = null,
): ForecastSimResult | null {
  const tri = s.triConfig;
  if (!tri) return null;

  const pred = predictTriathlonRace(s);
  if (!pred) return null;
  const projectedSec = pred.totalSec;
  const currentSec = pred.currentTotalSec ?? projectedSec;
  if (projectedSec <= 0 || currentSec <= 0) return null;

  const totalWeeks = s.tw ?? (s.wks?.length ?? 16);
  const currentWeek = Math.max(1, Math.min(totalWeeks, s.w ?? 1));
  const weeksRemaining = Math.max(0, totalWeeks - currentWeek);

  // Mean improvement % — how much the plan is expected to deliver between
  // today's fitness and race-day fitness. Negative when projection is
  // somehow slower than today (rare); simulate around it without clamping.
  const meanImprovementPct = ((currentSec - projectedSec) / currentSec) * 100;
  // σ_improvement: 50% relative, floored at 0.8 pct. Bouchard 2011 individual
  // variance (~30–40%) plus life noise (injury, illness, travel) widens to 50%.
  const sigmaImprovementPct = Math.max(0.8, Math.abs(meanImprovementPct) * 0.50);

  const meanAdherence = 0.90;
  const sigmaAdherence = 0.12;
  const meanForm = 1.0;
  const sigmaForm = 0.025;
  const FORM_RAMP_WEEKS = 8;

  const rng = mulberry32(101 + currentWeek);

  const trials: number[][] = [];
  for (let trial = 0; trial < trialCount; trial++) {
    const improvementPct = normalSample(rng, meanImprovementPct, sigmaImprovementPct);
    const adherence = clamp(normalSample(rng, meanAdherence, sigmaAdherence), 0.5, 1.0);
    const formFactor = clamp(normalSample(rng, meanForm, sigmaForm), 0.93, 1.07);

    // The deterministic projection already assumes a realistic plan, so the sim
    // adds spread around it — not a mean shift. Normalising adherence by its
    // own mean keeps the variance (good and bad weeks widen the cone) while
    // pinning E[multiplier] ≈ 1.0, so the simulated median equals the
    // deterministic projection by construction.
    const adherenceMul = adherence / meanAdherence;
    const trialFinalSec = currentSec * (1 - (improvementPct / 100) * adherenceMul);
    const trialWeeks: number[] = [];
    const steps = weeksRemaining;
    for (let w = 0; w <= steps; w++) {
      const p = steps > 0 ? w / steps : 1;
      const shapedP = smoothstep(p);
      const weekTime = currentSec + (trialFinalSec - currentSec) * shapedP;
      const weeksToRace = steps - w;
      const formIntensity = Math.max(0, Math.min(1, (FORM_RAMP_WEEKS - weeksToRace) / FORM_RAMP_WEEKS));
      const effectiveFormFactor = 1 + (formFactor - 1) * formIntensity;
      trialWeeks.push(weekTime * effectiveFormFactor);
    }
    trials.push(trialWeeks);
  }

  // **Headline alignment.** The deterministic median trial is `projectedSec`
  // by construction (median improvementPct = mean, median adherenceMul = 1.0,
  // median formFactor = 1.0). But the *empirical* race-day median across 2000
  // samples drifts a little — typically 10–40s — because formFactor at race
  // day perturbs each trial independently. Shift-align the cone so the
  // empirical race-day p50 lands exactly on the headline. Today's p50 stays
  // at `currentSec` (no shift at w=0). The shift ramps in via the same
  // smoothstep used for the deterministic trajectory, preserving cone width.
  if (weeksRemaining > 0) {
    const raceDayTimes = trials.map(t => t[weeksRemaining]).sort((a, b) => a - b);
    const empiricalMed = percentile(raceDayTimes, 0.50);
    const shiftAtRace = projectedSec - empiricalMed;
    if (Math.abs(shiftAtRace) > 0.5) {
      for (const t of trials) {
        for (let w = 0; w <= weeksRemaining; w++) {
          const p = w / weeksRemaining;
          t[w] += shiftAtRace * smoothstep(p);
        }
      }
    }
  }

  const weekResults = [];
  for (let w = 0; w <= weeksRemaining; w++) {
    const times = trials.map(t => t[w]).sort((a, b) => a - b);
    weekResults.push({
      week: currentWeek + w,
      p10: percentile(times, 0.10),
      p25: percentile(times, 0.25),
      p50: percentile(times, 0.50),
      p75: percentile(times, 0.75),
      p90: percentile(times, 0.90),
    });
  }
  const raceDay = weekResults[weekResults.length - 1];

  const goalProbability = goalSec && goalSec > 0
    ? trials.filter(t => t[weeksRemaining] <= goalSec).length / trialCount
    : null;

  return {
    weeks: weekResults,
    raceDay: { p10: raceDay.p10, p25: raceDay.p25, p50: raceDay.p50, p75: raceDay.p75, p90: raceDay.p90 },
    trialCount,
    goalProbability,
    pointEstimate: projectedSec,
  };
}
