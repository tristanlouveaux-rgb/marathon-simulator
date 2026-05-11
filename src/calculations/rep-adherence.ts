/**
 * Rep adherence
 * =============
 *
 * Parses a planned interval workout description (e.g. "8×400m @ 5k pace",
 * "5×5min @ FTP") into rep targets, matches detected reps against those
 * targets, and produces a per-rep + aggregate adherence score.
 *
 * **Side of the line**: planning. The score feeds the effort multiplier
 * (running + tri) so progression next week reflects rep-level execution
 * rather than just whole-session averages.
 *
 * Pure functions over plan + actual. No DOM access, no state mutation.
 */

import type { ActivityRep, ActivityRepData, GarminActual, Workout } from '@/types/state';
import { gp, getPaceForZone } from './paces';
import { BIKE_ADHERENCE_BAND } from '@/constants/triathlon-constants';

// ─── Prescription parsing ───────────────────────────────────────────────────

/**
 * What a single rep is supposed to look like — the prescribed shape parsed
 * from the workout description. Either distance- or duration-based;
 * exactly one of `distanceM` / `durationSec` is set.
 */
export interface RepTarget {
  count: number;
  distanceM?: number;
  durationSec?: number;
  /** Target pace (sec/km) — running. */
  targetPaceSecKm?: number;
  /** Target watts — bike. */
  targetWatts?: number;
  /** What we parsed it from, for transparency. */
  parsedFrom: string;
}

/**
 * Recognise common interval-rep notations.
 * Examples we handle:
 *   - "8×400m @ 5k pace"       → 8 reps of 400m
 *   - "8 x 400m @ 5k"          → same
 *   - "6×800m @ vo2"           → 6 reps of 800m
 *   - "10×1km threshold"       → 10 reps of 1000m
 *   - "5×5min @ FTP"           → 5 reps of 5min
 *   - "4×4min @ vo2"           → 4 reps of 4min
 *   - "8 x 1km @ threshold"    → 8 reps of 1000m
 *
 * Returns null when no rep-pattern can be extracted.
 */
const REP_REGEX_DISTANCE = /(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(m|km|mi)\b/i;
const REP_REGEX_DURATION = /(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(s|sec|seconds|min|minutes)\b/i;

function distanceToMeters(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u === 'km') return value * 1000;
  if (u === 'mi') return value * 1609.344;
  return value; // 'm'
}

function durationToSeconds(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u === 'min' || u === 'minutes') return value * 60;
  return value; // 's', 'sec', 'seconds'
}

export function parseRepPrescription(description: string | undefined): {
  count: number;
  distanceM?: number;
  durationSec?: number;
  parsedFrom: string;
} | null {
  if (!description) return null;
  const distMatch = description.match(REP_REGEX_DISTANCE);
  if (distMatch) {
    const count = parseInt(distMatch[1], 10);
    const distanceM = Math.round(distanceToMeters(parseFloat(distMatch[2]), distMatch[3]));
    if (count >= 2 && distanceM >= 50) {
      return { count, distanceM, parsedFrom: distMatch[0] };
    }
  }
  const durMatch = description.match(REP_REGEX_DURATION);
  if (durMatch) {
    const count = parseInt(durMatch[1], 10);
    const durationSec = Math.round(durationToSeconds(parseFloat(durMatch[2]), durMatch[3]));
    if (count >= 2 && durationSec >= 15) {
      return { count, durationSec, parsedFrom: durMatch[0] };
    }
  }
  return null;
}

// ─── Target pace / power resolution ──────────────────────────────────────────

/**
 * Resolve target pace (sec/km) from a running workout. Uses the planned
 * workout's type ('vo2', 'threshold', 'intervals', etc.) and the user's
 * VDOT/LT to derive the canonical pace zone via `gp()`.
 *
 * Returns null when we can't pin down a target.
 */
export function resolveRunTargetPace(
  workoutType: string | undefined,
  vdot: number | undefined,
  ltPaceSecKm: number | undefined | null,
): number | null {
  if (!workoutType || !vdot) return null;
  const paces = gp(vdot, ltPaceSecKm);
  const pace = getPaceForZone(workoutType, paces);
  // `getPaceForZone` falls back to easy when type is unknown — guard against
  // returning easy as an "interval target" when the workout type isn't
  // actually an interval.
  const intervalTypes = ['vo2', 'intervals', 'i', '5k', '5K', 'threshold', 'tempo', 't', 'r'];
  if (!intervalTypes.includes(workoutType.toLowerCase())) return null;
  return Math.round(pace);
}

/**
 * Resolve target watts from a bike workout. Uses BIKE_TARGET_IF (from
 * tri-effort-scoring.ts) crossed with FTP.
 */
const BIKE_TARGET_IF: Record<string, number> = {
  bike_endurance:   0.65,
  bike_tempo:       0.80,
  bike_sweet_spot:  0.88,
  bike_threshold:   0.95,
  bike_vo2:         1.10,
  bike_hills:       0.90,
  bike_over_under:  1.00,
  bike_vo2_micros:  1.05,
  bike_vlamax:      0.85,
};

export function resolveBikeTargetWatts(
  workoutType: string | undefined,
  ftp: number | undefined,
): number | null {
  if (!workoutType || !ftp || ftp <= 0) return null;
  const intensityFactor = BIKE_TARGET_IF[workoutType];
  if (intensityFactor == null) return null;
  return Math.round(ftp * intensityFactor);
}

// ─── Per-rep adherence scoring ──────────────────────────────────────────────

/**
 * Per-rep band tolerance.
 *   - Running pace: ±5% of target (≈ ±9 sec/km on a 3:00/km interval).
 *   - Bike watts: same band as session-level adherence — see BIKE_ADHERENCE_BAND.
 *
 * Inside the band → in-target (counts toward `inBand` aggregate).
 */
const RUN_PACE_BAND = 0.05;

interface ScoredRep {
  rep: ActivityRep;
  /** Per-rep adherence ratio (1.0 = on target). */
  adherence: number | null;
  inBand: boolean;
}

function scoreRunRep(rep: ActivityRep, targetPaceSecKm: number): ScoredRep {
  if (rep.paceSecKm == null || rep.paceSecKm <= 0 || targetPaceSecKm <= 0) {
    return { rep, adherence: null, inBand: false };
  }
  // Lower sec/km = faster. Adherence > 1.0 = slower than target (under-cooked).
  const adherence = rep.paceSecKm / targetPaceSecKm;
  const inBand = Math.abs(adherence - 1.0) <= RUN_PACE_BAND;
  return { rep, adherence, inBand };
}

function scoreBikeRep(rep: ActivityRep, targetWatts: number, workoutType: string | undefined): ScoredRep {
  if (rep.avgWatts == null || rep.avgWatts <= 0 || targetWatts <= 0) {
    return { rep, adherence: null, inBand: false };
  }
  const adherence = rep.avgWatts / targetWatts;
  const bandHalf = BIKE_ADHERENCE_BAND[workoutType ?? ''] ?? 0.07;
  const inBand = Math.abs(adherence - 1.0) <= bandHalf;
  return { rep, adherence, inBand };
}

// ─── Top-level scoring ───────────────────────────────────────────────────────

export interface RepAdherenceInputs {
  /** The workout the user was prescribed. */
  workout: Workout | undefined;
  /** The actual activity with detected reps on `repData`. */
  actual: GarminActual;
  /** Discipline routing — drives whether to score on pace (run) or watts (bike). */
  discipline: 'run' | 'bike';
  /** Required for running pace resolution. */
  vdot?: number;
  ltPaceSecKm?: number | null;
  /** Required for bike watt resolution. */
  ftp?: number;
}

export interface ScoredRepData {
  reps: ActivityRep[];
  source: ActivityRepData['source'];
  score: NonNullable<ActivityRepData['score']>;
  /** Per-rep details (kept off the persisted shape — UI uses this). */
  perRep: ScoredRep[];
}

export function scoreRepAdherence(input: RepAdherenceInputs): ScoredRepData | null {
  const { workout, actual, discipline } = input;
  const repData = actual.repData;
  if (!repData || repData.reps.length === 0) return null;

  // Resolve target. If no target available, return reps without a score
  // (UI still shows the table; effort-multiplier sees no rep-level signal).
  let target: number | null = null;
  let parsedFrom: string | undefined;
  if (discipline === 'run') {
    target = resolveRunTargetPace(workout?.t, input.vdot, input.ltPaceSecKm);
  } else if (discipline === 'bike') {
    target = resolveBikeTargetWatts(workout?.t, input.ftp);
  }
  if (target == null) return null;

  // Try to parse rep prescription from workout description for `parsedFrom`
  // — purely for transparency in the UI ("Parsed: 8×400m").
  const description = workout?.d;
  const parsed = parseRepPrescription(description);
  if (parsed) parsedFrom = parsed.parsedFrom;

  const perRep = repData.reps.map(rep =>
    discipline === 'run'
      ? scoreRunRep(rep, target!)
      : scoreBikeRep(rep, target!, workout?.t),
  );

  const scoredReps = perRep.filter(r => r.adherence != null);
  if (scoredReps.length === 0) return null;

  const inBand = scoredReps.filter(r => r.inBand).length;
  const adherences = scoredReps.map(r => r.adherence!);
  const avgAdherence = adherences.reduce((a, b) => a + b, 0) / adherences.length;

  // Fade: compare last-half mean to first-half mean. For pace (run), higher
  // = slower = fade. For watts (bike), invert the sign so a positive fadePct
  // always means "got worse over the set".
  const half = Math.floor(scoredReps.length / 2);
  let fadePct = 0;
  if (half >= 1 && scoredReps.length - half >= 1) {
    const firstHalf = adherences.slice(0, half);
    const lastHalf = adherences.slice(scoredReps.length - half);
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const lastAvg = lastHalf.reduce((a, b) => a + b, 0) / lastHalf.length;
    if (firstAvg > 0) {
      // For run pace (adherence>1 = slow), positive fade means slower.
      // For bike watts (adherence>1 = strong), positive fade means weaker → invert.
      const raw = (lastAvg - firstAvg) / firstAvg * 100;
      fadePct = discipline === 'run' ? raw : -raw;
    }
  }

  return {
    reps: repData.reps,
    source: repData.source,
    perRep,
    score: {
      inBand,
      total: scoredReps.length,
      fadePct: Math.round(fadePct * 10) / 10,
      avgAdherence: Math.round(avgAdherence * 1000) / 1000,
      parsedFrom,
    },
  };
}

// ─── Effort-multiplier integration helper ───────────────────────────────────

/**
 * Convert a rep-level adherence score to the same "deviation" scale used
 * by the running effort blend (events.ts) and the tri effort multiplier
 * (effort-multiplier.triathlon.ts). On both, 1.0 = on target; we map
 * a deviation of 0.1 to "1 RPE point" so the rep signal can blend with
 * RPE the same way `hrEffortScore` and `powerAdherence` already do.
 *
 * Returns null when fewer than 60% of reps had a parseable target.
 */
export function repAdherenceToEffortDev(scored: ScoredRepData): number | null {
  if (scored.score.total === 0) return null;
  if (scored.score.total < scored.reps.length * 0.6) return null;
  // avgAdherence-1 is the "amount over target". 0.1 = 10% slow/strong → 1 RPE pt.
  return (scored.score.avgAdherence - 1.0) * 10;
}

// ─── Commentary helpers ──────────────────────────────────────────────────────

/**
 * Generate a one-line commentary string for the activity-detail page.
 * Examples:
 *   - "8/8 reps in band, no fade — strong execution."
 *   - "First 4 reps in band, last 4 faded 6%."
 *   - "All 5 reps under target — undercooked set."
 */
export function repCommentary(scored: ScoredRepData, discipline: 'run' | 'bike'): string {
  const { score, perRep } = scored;
  const total = score.total;
  if (total === 0) return '';

  const inBandPct = score.inBand / total;
  const overTarget = perRep.filter(r => r.adherence != null && r.adherence > 1.05).length;
  const underTarget = perRep.filter(r => r.adherence != null && r.adherence < 0.95).length;

  // Fade thresholds: ≥3% noticeable, ≥6% significant.
  const fade = score.fadePct;
  const fadeLabel =
    Math.abs(fade) < 3 ? 'no fade'
    : fade >= 6 ? `faded ${fade.toFixed(1)}%`
    : fade >= 3 ? `slowed ${fade.toFixed(1)}%`
    : fade <= -6 ? `built ${Math.abs(fade).toFixed(1)}%`
    : `built ${Math.abs(fade).toFixed(1)}%`;

  if (inBandPct >= 0.9) {
    return `${score.inBand}/${total} reps in target band, ${fadeLabel} — strong execution.`;
  }

  if (discipline === 'run') {
    if (overTarget >= total * 0.6) {
      return `${overTarget}/${total} reps slower than target — undercooked set.`;
    }
    if (underTarget >= total * 0.6) {
      return `${underTarget}/${total} reps faster than target — over-cooked the band.`;
    }
  } else {
    if (overTarget >= total * 0.6) {
      return `${overTarget}/${total} reps above target — over-cooked the band.`;
    }
    if (underTarget >= total * 0.6) {
      return `${underTarget}/${total} reps under target — undercooked set.`;
    }
  }

  // Mixed pattern — describe the fade.
  const half = Math.floor(total / 2);
  const firstInBand = perRep.slice(0, half).filter(r => r.inBand).length;
  const lastInBand = perRep.slice(total - half).filter(r => r.inBand).length;
  if (firstInBand > lastInBand) {
    return `First ${half} reps held the band, last ${half} ${fadeLabel}.`;
  }
  return `${score.inBand}/${total} reps in band, ${fadeLabel}.`;
}
