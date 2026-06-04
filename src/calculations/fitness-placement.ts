/**
 * Fitness placement — "where does this athlete sit" per metric.
 *
 * Canonical helpers for every surface that contextualises a fitness number
 * against a real reference population. Per the visualisation rule in
 * CLAUDE.md, every placement here derives from real ingested data:
 *
 *  - Run speed   → pooled marathon table (888,989 finishes, 5 majors)
 *  - VO2max      → FRIEND registry treadmill norms (Kaminsky 2015)
 *  - Bike FTP    → Coggan W/kg power-profile bands (bike-physics.ts)
 *  - HYROX       → real per-format finisher tables (89,868 rows, S4-S6)
 *
 * Two-numbers rule: any screen showing a placement next to a metric must
 * call these helpers with the same input the metric display uses.
 */

import { tv, rdKm } from '@/calculations/vdot';
import {
  lookupDistanceAggregatePercentile,
  pooledMarathonFinisherSummary,
  DISTANCE_AGGREGATE_PERCENTILE_TABLES,
} from '@/data/marathon-population-distributions';
import { ageGrade, type AgeGradeResult, type WmaDistanceKey } from '@/data/wma-age-grading';
import {
  lookupRunnerPopPercentile,
  RUNNER_POPULATION_TABLES,
  type RunnerPopDistance,
  type RunnerPopSex,
} from '@/data/runner-population-distributions';
import { lookupVo2Percentile, type Vo2Placement } from '@/data/vo2max-norms';
import { wattsPerKgTier } from '@/calculations/bike-physics';
import {
  HYROX_TOTAL_PERCENTILE_TABLES,
  lookupRealPercentile,
} from '@/data/hyrox-population-distributions';

/** Matches the (unexported) Format union in hyrox-population-distributions. */
type HyroxFormat = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

export interface RunSpeedPlacement {
  /** Marathon-equivalent finish time for the given VDOT (Daniels). */
  marathonEquivSec: number;
  /** % of real marathon finishers slower than this time (0-100). */
  fasterThanPct: number;
  /** Pooled real-finisher count behind the table. */
  finisherCount: number;
  /** Contributing venue display names, sorted. */
  venues: string[];
  /** Real-table scale anchors for position bars: fast p5 / median / slow p95 times. */
  scale: { fastSec: number; medianSec: number; slowSec: number };
}

/**
 * Place a runner's current fitness within the real marathon field.
 * The VDOT is converted to a marathon-equivalent time via the Daniels
 * curve (`tv`), then looked up against the pooled marathon aggregate.
 * Returns null when VDOT is unusable or no population data is ingested.
 */
export function runSpeedPlacement(vdot: number | null | undefined): RunSpeedPlacement | null {
  if (vdot == null || !isFinite(vdot) || vdot <= 0) return null;
  const marathonEquivSec = tv(vdot, 42.195);
  const cumPct = lookupDistanceAggregatePercentile('marathon', marathonEquivSec);
  if (cumPct == null) return null;
  const { count, venues } = pooledMarathonFinisherSummary();
  const scale = percentileScaleAnchors(DISTANCE_AGGREGATE_PERCENTILE_TABLES.marathon);
  if (!scale) return null;
  return {
    marathonEquivSec,
    fasterThanPct: Math.max(0, Math.min(100, 100 - cumPct)),
    finisherCount: count,
    venues,
    scale,
  };
}

/** Pull the p5 (fast) / p50 / p95 (slow) anchors out of a cumulative table. */
function percentileScaleAnchors(
  table: Array<[number, number]>,
): { fastSec: number; medianSec: number; slowSec: number } | null {
  const at = (p: number) => table.find(([, pct]) => pct === p)?.[0];
  const fastSec = at(5), medianSec = at(50), slowSec = at(95);
  if (fastSec == null || medianSec == null || slowSec == null) return null;
  return { fastSec, medianSec, slowSec };
}

/**
 * Place a VO2max within the FRIEND age/sex norms. Thin re-export so UI
 * call sites import every placement from one module. Returns null when
 * sex or age is unknown — no percentile claims against a guessed group.
 */
export function vo2maxPlacement(
  vo2MlKgMin: number | null | undefined,
  age: number | null | undefined,
  sex: 'male' | 'female' | 'prefer_not_to_say' | null | undefined,
): Vo2Placement | null {
  if (vo2MlKgMin == null) return null;
  return lookupVo2Percentile(vo2MlKgMin, age, sex);
}

export interface RunnerFieldPlacement {
  /** % of runners (sex-specific table when sex known) slower than this time, 0-100. */
  fasterThanPct: number;
  /** Which table was used — drives the caption noun. */
  sexUsed: RunnerPopSex;
  /** Real-table scale anchors: fast p1 / median p50 / slow p90 times. */
  scale: { fastSec: number; medianSec: number; slowSec: number };
}

/**
 * Place a time within the runner population at a distance ("faster than X%
 * of 10K runners"). Uses the sex-specific table when sex is known, the
 * overall table otherwise — a population claim needs no demographic table,
 * unlike FRIEND/WMA. Source: 35M race results (see
 * runner-population-distributions.ts).
 */
export function runnerFieldPlacement(
  distance: RunnerPopDistance,
  timeSec: number | null | undefined,
  sex: 'male' | 'female' | 'prefer_not_to_say' | null | undefined,
): RunnerFieldPlacement | null {
  if (timeSec == null || !isFinite(timeSec) || timeSec <= 0) return null;
  const sexUsed: RunnerPopSex = sex === 'male' || sex === 'female' ? sex : 'all';
  const pct = lookupRunnerPopPercentile(distance, sexUsed, timeSec);
  if (pct == null) return null;
  const t = RUNNER_POPULATION_TABLES[distance][sexUsed];
  const at = (p: number) => t.find(([, x]) => x === p)?.[0];
  const fastSec = at(1), medianSec = at(50), slowSec = at(90);
  if (fastSec == null || medianSec == null || slowSec == null) return null;
  return {
    fasterThanPct: Math.max(0, Math.min(100, 100 - pct)),
    sexUsed,
    scale: { fastSec, medianSec, slowSec },
  };
}

/**
 * Place *current fitness* within the runner population at a distance:
 * VDOT → projected time via Daniels → population lookup.
 */
export function runnerFieldPlacementForFitness(
  distance: RunnerPopDistance,
  vdot: number | null | undefined,
  sex: 'male' | 'female' | 'prefer_not_to_say' | null | undefined,
): (RunnerFieldPlacement & { timeSec: number }) | null {
  if (vdot == null || !isFinite(vdot) || vdot <= 0) return null;
  const km = rdKm(distance === 'k5' ? '5k' : distance === 'k10' ? '10k' : distance);
  const timeSec = tv(vdot, km);
  const p = runnerFieldPlacement(distance, timeSec, sex);
  return p ? { ...p, timeSec } : null;
}

/** Map the app's race-distance keys ('5k'|'10k'|'half'|'marathon') to WMA keys. */
export function wmaKeyForRaceDist(raceDist: string | null | undefined): WmaDistanceKey | null {
  switch (raceDist) {
    case '5k': return 'k5';
    case '10k': return 'k10';
    case 'half': return 'half';
    case 'marathon': return 'marathon';
    default: return null;
  }
}

export interface AgeGradePlacement extends AgeGradeResult {
  /** Projected (or actual) time that was graded, seconds. */
  timeSec: number;
}

/**
 * Age-grade an actual performance (e.g. a PB). Thin wrapper so UI call
 * sites import every placement from this module.
 */
export function ageGradeForTime(
  distance: WmaDistanceKey,
  timeSec: number | null | undefined,
  age: number | null | undefined,
  sex: 'male' | 'female' | 'prefer_not_to_say' | null | undefined,
): AgeGradePlacement | null {
  if (timeSec == null) return null;
  const g = ageGrade(distance, timeSec, age, sex);
  return g ? { ...g, timeSec } : null;
}

/**
 * Age-grade the athlete's *current fitness* at a distance: the VDOT is
 * converted to a projected time at that distance via the Daniels curve,
 * then graded against the WMA age/sex standard. Used by the review screen
 * so every athlete is framed at their own target distance.
 */
export function ageGradeForFitness(
  distance: WmaDistanceKey,
  vdot: number | null | undefined,
  age: number | null | undefined,
  sex: 'male' | 'female' | 'prefer_not_to_say' | null | undefined,
): AgeGradePlacement | null {
  if (vdot == null || !isFinite(vdot) || vdot <= 0) return null;
  const km = rdKm(distance === 'k5' ? '5k' : distance === 'k10' ? '10k' : distance);
  return ageGradeForTime(distance, tv(vdot, km), age, sex);
}

export interface FtpPlacement {
  wkg: number;
  /** Coggan band label, e.g. "Good". */
  label: string;
}

/**
 * Place an FTP on the Coggan W/kg power profile. Requires a real user
 * bodyweight — the sex-based default (75/62 kg) must not back a placement
 * claim, so callers pass `s.bodyWeightKg` directly, not the resolved value.
 */
export function ftpPlacement(
  ftpW: number | null | undefined,
  bodyWeightKg: number | null | undefined,
): FtpPlacement | null {
  if (ftpW == null || ftpW <= 0 || bodyWeightKg == null || bodyWeightKg <= 0) return null;
  const tier = wattsPerKgTier(ftpW, bodyWeightKg);
  if (tier.wkg <= 0) return null;
  return { wkg: tier.wkg, label: tier.label };
}

export interface HyroxPlacement {
  /** % of real finishers in this format slower than the time (0-100). */
  fasterThanPct: number;
  /** Real-table scale anchors for position bars: fast p5 / median / slow p95 times. */
  scale: { fastSec: number; medianSec: number; slowSec: number };
}

/**
 * Place a HYROX finish time within the real per-format field.
 * Returns null when the format has no ingested data (pro_doubles).
 */
export function hyroxPlacement(
  format: HyroxFormat,
  timeSec: number | null | undefined,
): HyroxPlacement | null {
  if (timeSec == null || !isFinite(timeSec) || timeSec <= 0) return null;
  const cumPct = lookupRealPercentile(HYROX_TOTAL_PERCENTILE_TABLES, format, timeSec);
  if (cumPct == null) return null;
  const scale = percentileScaleAnchors(HYROX_TOTAL_PERCENTILE_TABLES[format]);
  if (!scale) return null;
  return { fasterThanPct: Math.max(0, Math.min(100, 100 - cumPct)), scale };
}
