import type { SportKey, CrossActivity, IntensityProfile } from '@/types';
import { SPORTS_DB, SPORT_ALIASES, RPE_MULT, ANAEROBIC_WEIGHT, RPE_WEIGHT, DEFAULT_RPE, LOAD_PER_MIN_BY_INTENSITY } from '@/constants';
import { generateId } from '@/utils';

/**
 * Normalize sport name to standard key
 * @param name - Raw sport name
 * @returns Normalized sport key
 */
export function normalizeSport(name: string): SportKey {
  const clean = name.toLowerCase().trim().replace(/ /g, '_');
  return (SPORT_ALIASES[clean] || clean) as SportKey;
}

/**
 * Best-guess sport from a raw Garmin/Strava activityType string. Handles the
 * common synonyms ("WeightTraining" → strength, "VirtualRide" → cycling, etc.).
 * Returns `'generic_sport'` when nothing matches.
 *
 * Single source of truth for activityType → SportKey derivation; both the
 * sport-picker UI and the fitness-model TSS helpers import from here so a
 * "strength" classification is consistent across surfaces.
 */
export function deriveSportFromActivityType(activityType: string | null | undefined): SportKey {
  if (!activityType) return 'generic_sport';
  const raw = activityType.toLowerCase().trim();
  if (raw in SPORTS_DB) return raw as SportKey;
  if (raw in SPORT_ALIASES) return SPORT_ALIASES[raw];
  if (raw.includes('run')) return 'extra_run';
  if (raw.includes('swim')) return 'swimming';
  if (raw.includes('cycl') || raw.includes('bike') || raw.includes('ride') || raw.includes('mountain_bik')) return 'cycling';
  if (raw.includes('walk')) return 'walking';
  if (raw.includes('hik')) return 'hiking';
  if (raw.includes('ski') && raw.includes('board')) return 'snowboarding';
  if (raw.includes('ski')) return 'skiing';
  if (raw.includes('yoga')) return 'yoga';
  if (raw.includes('row')) return 'rowing';
  if (raw.includes('climb')) return 'climbing';
  if (raw.includes('strength') || raw.includes('weight') || raw.includes('gym')) return 'strength';
  if (raw.includes('kite')) return 'kitesurfing';
  if (raw.includes('surf')) return 'surfing';
  if (raw.includes('sail')) return 'sailing';
  if (raw.includes('kayak') || raw.includes('canoe')) return 'kayaking';
  if (raw.includes('paddle') || raw === 'sup') return 'paddleboard';
  if (raw.includes('wake')) return 'wakeboarding';
  return 'generic_sport';
}

/**
 * Robust "is this a strength session?" detector. Combines three signals so the
 * detection survives Strava's generic activityType (often `Workout`) when the
 * only "strength" cue is in the user-provided activity name.
 *
 * Order:
 *   1. Manual user override (`manualSport === 'strength'`).
 *   2. activityType derivation (handles `WeightTraining`, `STRENGTH_TRAINING`,
 *      `gym`, `weights`).
 *   3. Substring match on `workoutName` / `displayName` for strength keywords.
 *
 * Shared single source of truth. Both the fitness-model TSS override and the
 * activity-detail UI chips import this so a session detected as strength on
 * one surface is detected on the other.
 */
const STRENGTH_NAME_RE = /strength|weight|lift|barbell|squat|deadlift|bench|powerlift/i;
export function isStrengthActual(actual: {
  activityType?: string | null;
  manualSport?: string;
  workoutName?: string;
  displayName?: string;
}): boolean {
  if (actual.manualSport === 'strength') return true;
  const derived = deriveSportFromActivityType(actual.activityType);
  if (derived === 'strength') return true;
  // Name fallback only fires when activityType was ambiguous (generic_sport).
  // Otherwise a run named "Easy run to lose weight" would mis-classify as
  // strength via the `weight` keyword. Mirrors getEffectiveSport's rule that
  // name mappings only apply when the type derives to generic_sport.
  if (derived !== 'generic_sport') return false;
  const name = `${actual.workoutName ?? ''} ${actual.displayName ?? ''}`;
  return STRENGTH_NAME_RE.test(name);
}

/**
 * Whether a synced activity counts as a "gym" session the way the matcher does
 * (`mapGarminType` → 'gym'): weight training OR HIIT. Broader than
 * `isStrengthActual` — a watch HIIT slots against a planned gym session and
 * counts for adherence/load, so it should also count toward the strength
 * surface's session/streak number (even when the user matched it from the watch
 * rather than starting it in-app). It carries no per-lift weights, so it adds 0
 * to tonnage / est-1RM — those stay `isStrengthActual` / `loggedLifts` based.
 */
export function isGymSessionActual(actual: {
  activityType?: string | null;
  manualSport?: string;
  workoutName?: string;
  displayName?: string;
}): boolean {
  if (isStrengthActual(actual)) return true;
  const raw = (actual.activityType ?? '').toLowerCase();
  return raw.includes('hiit') || raw.includes('high_intensity_interval');
}

/**
 * activityType of a HYROX station or brick session recorded in the app, guided
 * or quick done (strength-complete.ts). Not a device type: the watch copy of the
 * same session arrives as HIIT, which the matcher files in its gym bucket.
 */
export const IN_APP_HYROX_ACTIVITY_TYPE = 'hyrox';

/** True for a HYROX station or brick session recorded in the app. */
export function isInAppHyroxSession(actual: { activityType?: string | null }): boolean {
  return (actual.activityType ?? '').toLowerCase() === IN_APP_HYROX_ACTIVITY_TYPE;
}

// ─── The activity's own sport, for load weighting ────────────────────────────
//
// Signal A (running-specific load) weights every activity by the runSpec of the
// sport that was actually done. These resolvers answer "what sport was this?"
// from the stored record, never from the plan slot it filled. Tracking side:
// they describe what happened.

/**
 * SportKey from a recorded activity LABEL instead of a raw type code: the
 * `formatActivityType` output that slot fills store as `displayName`
 * ("Stair Climbing", "Lap Swim", "HIIT"), or an adhoc workout's `n`. Spaces and
 * hyphens become underscores so the label reads like the code it came from,
 * then the canonical `deriveSportFromActivityType` rules apply.
 */
export function deriveSportFromLabel(label: string | null | undefined): SportKey {
  if (!label) return 'generic_sport';
  const clean = label.replace(/\s*\((Garmin|Strava)\)\s*$/i, '').trim().replace(/[\s-]+/g, '_');
  return deriveSportFromActivityType(clean);
}

/** Plan slot ids are `W${week}-${type}-${idx}` (generator.ts, plan_engine.triathlon.ts). */
const PLAN_SLOT_TYPE_RE = /^W\d+-([a-z_]+)-\d+$/;
/** Plan workout types the matcher fills with gym-bucket activities (strength or HIIT). */
const GYM_WORKOUT_TYPES = new Set(['gym', 'strength']);
/** Adhoc workout types that are not runs (same set computeWeekTSS has always used). */
const NON_RUN_WORKOUT_TYPES = new Set(['cross', 'gym', 'strength', 'rest']);

function isGymSlotKey(key: string): boolean {
  const t = key.match(PLAN_SLOT_TYPE_RE)?.[1];
  return t != null && GYM_WORKOUT_TYPES.has(t);
}

/**
 * The sport of a `garminActuals` entry (keyed by plan slot id or `garmin-<id>`).
 *
 * Precedence:
 *   1. `manualSport`: the user's reclassification (same rule as getEffectiveSport).
 *   2. `isStrengthActual`: the detector computeStrengthRpeTSS uses, so the RPE
 *      path and the HR path agree on what a strength session is.
 *   3. `activityType`: what the device or source recorded.
 *   4. `displayName` on a slot fill (no `workoutName`): every cross/gym slot
 *      writer in activity-review.ts stores `formatActivityType(activityType)`
 *      there without the type itself.
 *   5. Otherwise a run. Run-slot matches carry `workoutName` (the planned run's
 *      name). Rows from before `activityType` was stored keep their full weight.
 *
 * An ambiguous result (`generic_sport`) for a gym-bucket activity (HIIT, see
 * isGymSessionActual) or a gym plan slot resolves to strength, the same mapping
 * the matcher applies to its 'gym' bucket (mapAppTypeToSport('gym') = 'gym',
 * SPORT_ALIASES.gym = 'strength'). So does a HYROX station or brick session
 * recorded in the app (isInAppHyroxSession, decision 2026-10-06): its watch
 * copy is a HIIT, so the session weighs the same in Signal A whichever copy
 * holds the slot (SPORTS_DB strength runSpec, not generic_sport's).
 */
export function resolveActualSport(
  key: string,
  actual: {
    activityType?: string | null;
    manualSport?: string;
    workoutName?: string;
    displayName?: string;
  },
): SportKey {
  if (actual.manualSport && actual.manualSport in SPORTS_DB) return actual.manualSport as SportKey;
  if (isStrengthActual(actual)) return 'strength';
  let sport: SportKey;
  if (actual.activityType) sport = deriveSportFromActivityType(actual.activityType);
  else if (actual.displayName && !actual.workoutName) sport = deriveSportFromLabel(actual.displayName);
  else sport = isGymSlotKey(key) ? 'strength' : 'running';
  if (sport === 'generic_sport' && (isGymSessionActual(actual) || isInAppHyroxSession(actual) || isGymSlotKey(key))) return 'strength';
  return sport;
}

/**
 * The sport of an adhoc workout (synced activity logged outside the plan, or a
 * legacy entry with no `garminActuals` twin). A run-typed adhoc is a run whatever
 * its name (an activity first classified as a run keeps `t: 'easy'`); otherwise
 * the name is the recorded label. A gym-typed adhoc with an ambiguous name
 * resolves to strength, as in resolveActualSport.
 */
export function resolveAdhocSport(w: { t?: string; n?: string }): SportKey {
  const t = w.t ?? 'cross';
  if (!NON_RUN_WORKOUT_TYPES.has(t)) return 'running';
  const sport = deriveSportFromLabel(w.n);
  if (sport === 'generic_sport' && GYM_WORKOUT_TYPES.has(t)) return 'strength';
  return sport;
}

/** True when the sport is running (planned or extra). */
export function isRunSport(sport: SportKey): boolean {
  return sport === 'running' || sport === 'extra_run';
}

/**
 * Signal A weight of a sport: its SPORTS_DB `runSpec` (running 1.0). The
 * resolvers above only return SPORTS_DB keys; the generic_sport row is the
 * defensive fallback.
 */
export function signalARunSpec(sport: SportKey): number {
  return SPORTS_DB[sport]?.runSpec ?? SPORTS_DB.generic_sport.runSpec;
}

/**
 * Get RPE multiplier for load calculation
 * @param rpe - RPE value (1-10)
 * @returns Multiplier
 */
export function getRPEMult(rpe: number): number {
  for (const threshold of [9, 8, 7, 6, 5, 4, 3, 2, 1]) {
    if (rpe >= threshold) return RPE_MULT[threshold];
  }
  return 1.0;
}

/**
 * Calculate RPE factor for load adjustment
 * @param rpe - RPE value (1-10)
 * @returns Factor
 */
export function rpeFactor(rpe: number | null | undefined): number {
  const r = rpe || DEFAULT_RPE;
  return 1.0 + (r - DEFAULT_RPE) * RPE_WEIGHT;
}

/**
 * Calculate weighted load from aerobic and anaerobic
 * @param aerobic - Aerobic load
 * @param anaerobic - Anaerobic load
 * @returns Weighted load
 */
export function weightedLoad(aerobic: number, anaerobic: number): number {
  return aerobic + ANAEROBIC_WEIGHT * anaerobic;
}

/**
 * Get intensity profile from aerobic/anaerobic loads
 * @param aerobic - Aerobic load
 * @param anaerobic - Anaerobic load
 * @returns Intensity profile
 */
export function intensityProfile(aerobic: number, anaerobic: number): IntensityProfile {
  const total = aerobic + anaerobic;
  const ratio = total <= 0 ? 0 : anaerobic / total;
  const weighted = weightedLoad(aerobic, anaerobic);
  return { total, anaerobicRatio: ratio, weighted };
}

/**
 * Check if activity qualifies as a hard day
 * @param aerobic - Aerobic load
 * @param anaerobic - Anaerobic load
 * @returns True if hard day
 */
export function isHardDay(aerobic: number, anaerobic: number): boolean {
  const profile = intensityProfile(aerobic, anaerobic);
  return profile.anaerobicRatio >= 0.22 || profile.weighted >= 40;
}

/**
 * Check if sport can modify a workout type
 * @param sportKey - Sport key
 * @param workoutType - Workout type
 * @returns True if can touch
 */
export function canTouchWorkout(sportKey: SportKey, workoutType: string): boolean {
  const sp = SPORTS_DB[sportKey];
  if (!sp) return true;
  const wt = workoutType.toLowerCase();
  return !sp.noReplace.some(nr => nr.toLowerCase() === wt);
}

/**
 * Create a cross-training activity
 * @param sport - Sport name
 * @param durationMin - Duration in minutes
 * @param rpe - RPE (1-10)
 * @param aerobicLoad - Aerobic load (optional, will estimate if not provided)
 * @param anaerobicLoad - Anaerobic load (optional)
 * @param week - Week number
 * @returns CrossActivity object
 */
export function createActivity(
  sport: string,
  durationMin: number,
  rpe: number,
  aerobicLoad?: number,
  anaerobicLoad?: number,
  week: number = 1,
  iTrimp?: number | null
): CrossActivity {
  const normalizedSport = normalizeSport(sport);

  // Use Garmin loads if provided, otherwise estimate
  let aerobic_load: number;
  let anaerobic_load: number;
  const fromGarmin = !!(aerobicLoad && aerobicLoad > 0);

  if (fromGarmin) {
    aerobic_load = aerobicLoad!;
    anaerobic_load = anaerobicLoad || 0;
  } else {
    // Estimate in Garmin scale using calibrated rates
    const baseRate = LOAD_PER_MIN_BY_INTENSITY[rpe] || 2.0;
    aerobic_load = durationMin * baseRate * 0.85;
    anaerobic_load = rpe > 7 ? durationMin * baseRate * 0.15 : durationMin * baseRate * 0.05;
  }

  return {
    id: generateId(),
    date: new Date(),
    week,
    sport: normalizedSport,
    duration_min: durationMin,
    rpe,
    aerobic_load,
    anaerobic_load,
    dayOfWeek: new Date().getDay(),
    aerobic: aerobic_load,
    anaerobic: anaerobic_load,
    fromGarmin,
    applied: false,
    renderCycle: -1,
    ...(iTrimp != null ? { iTrimp } : {}),
  };
}

/**
 * Calculate total weekly load from activities
 * @param activities - Array of activities
 * @param week - Week to filter by
 * @returns Total weekly load
 */
export function getWeeklyLoad(activities: CrossActivity[], week: number): number {
  return activities
    .filter(a => a.week === week)
    .reduce((sum, a) => {
      const sportData = SPORTS_DB[normalizeSport(a.sport)] || { mult: 1.0 };
      let load = a.aerobic_load + (a.anaerobic_load || 0) * ANAEROBIC_WEIGHT;
      load *= sportData.mult;
      load *= getRPEMult(a.rpe);
      return sum + load;
    }, 0);
}

/**
 * Aggregate activities from current and previous weeks
 * @param allActivities - All cross-training activities
 * @param currentWeek - Current week number
 * @returns Object with current and previous week activities separated
 */
export function aggregateActivitiesWithDecay(
  allActivities: CrossActivity[],
  currentWeek: number
): { current: CrossActivity[]; previous: CrossActivity[]; } {
  const current = allActivities.filter(a => a.week === currentWeek);
  const previous = allActivities.filter(a => a.week === currentWeek - 1);

  return { current, previous };
}
