/**
 * Race-distance-aware intensity distribution for triathlon plans.
 *
 * Volume (hours, swim/bike/run split, plan length) is already distance-aware.
 * This module makes the *intensity distribution within each discipline* depend
 * on race distance, not just training phase — the gap identified after the
 * sprint/olympic/t100 promotion. Mirrors running mode's `workoutPriority(race,
 * phase)` precedent (`plan_engine.ts:300`) and delivers SCIENCE_LOG §30's flagged
 * "future work: weight by intensity distribution (Seiler polarized model)".
 *
 * Two levers (user-approved):
 *   1. COUNT — how many of a discipline's weekly slots are quality (the rest are
 *      aerobic). Short course = more; Ironman = fewer (TRI_QUALITY_SLOTS).
 *   2. FLAVOUR — which hard kind fills a quality slot. Short = VO2/speed/anaerobic;
 *      long = sub-threshold (sweet-spot/tempo/threshold) (TRI_QUALITY_FLAVOUR).
 *
 * Seiler ~80/20 easy:hard *by training time* is preserved at every distance: the
 * aerobic + long sessions carry the bulk of weekly minutes even when a slot is
 * "quality". What changes is the flavour of the hard minority and how many
 * sessions carry it.
 *
 * Science:
 *   - Seiler & Kjerland 2006; Seiler 2010; Stöggl & Sperlich 2014 — 80/20 by time.
 *   - Coyle 1984 fractional-utilization decay + specificity — train the hard work
 *     at the race's intensity flavour (short = at/above threshold; long = sub-threshold).
 *   - Daniels phases / Bompa — base-first: defer top-end VO2/anaerobic to build/peak.
 *   - Friel *Triathlete's Training Bible*; Dixon *Fast-Track Triathlete* — distance-
 *     specific intensity emphasis (coaching consensus). Confidence: medium for the
 *     exact slot counts, high for the direction. See SCIENCE_LOG.
 */

import type { TriathlonDistance } from '@/types/triathlon';
import type { TrainingPhase } from '@/types/training';
import type { SwimSessionKind } from './swim';
import type { BikeSessionKind } from './bike';

/** The two quality run kinds (long/easy are aerobic, not "quality"). */
export type TriRunQualityKind = 'threshold' | 'vo2';

/**
 * Quality-slot count, by distance × phase × discipline. Capped by available slots.
 * The bike's long ride and the run's long run are always reserved aerobic, so quality
 * slots are drawn from the remaining slots.
 *
 * Counts are DISCIPLINE-SPECIFIC, not uniform — this preserves Seiler 80/20 by time.
 * The run stays at a single quality session at every distance (running carries the
 * highest injury risk per hour, Vleck & Garbutt 1998); short-course run intensity
 * comes from FLAVOUR (vo2 vs threshold), not extra hard runs. The bike, which
 * tolerates intensity with low injury risk, carries 2 quality sessions for every
 * format except Ironman (1, aerobic-led). Swim adds a second quality session only
 * for short course (speed focus). This reproduces the pre-2026-06-15 70.3 pattern
 * (bike 2 / run 1 / swim 1) and the Ironman correction (all disciplines → 1).
 */
type DisciplineCounts = { swim: number; bike: number; run: number };
export const TRI_QUALITY_SLOTS: Record<TriathlonDistance, Record<TrainingPhase, DisciplineCounts>> = {
  sprint: {
    base:  { swim: 1, bike: 1, run: 0 },
    build: { swim: 2, bike: 2, run: 1 },
    peak:  { swim: 2, bike: 2, run: 1 },
    taper: { swim: 1, bike: 1, run: 0 },
  },
  olympic: {
    base:  { swim: 1, bike: 1, run: 0 },
    build: { swim: 2, bike: 2, run: 1 },
    peak:  { swim: 2, bike: 2, run: 1 },
    taper: { swim: 1, bike: 1, run: 0 },
  },
  t100: {
    base:  { swim: 0, bike: 1, run: 0 },
    build: { swim: 1, bike: 2, run: 1 },
    peak:  { swim: 1, bike: 2, run: 1 },
    taper: { swim: 0, bike: 1, run: 0 },
  },
  '70.3': {
    base:  { swim: 0, bike: 1, run: 0 },
    build: { swim: 1, bike: 2, run: 1 },
    peak:  { swim: 1, bike: 2, run: 1 },
    taper: { swim: 0, bike: 1, run: 0 },
  },
  ironman: {
    base:  { swim: 0, bike: 0, run: 0 },
    build: { swim: 1, bike: 1, run: 1 },
    peak:  { swim: 1, bike: 1, run: 1 },
    taper: { swim: 0, bike: 0, run: 0 },
  },
};

/** Disciplines used to index the per-discipline quality counts. */
export type TriQualityDiscipline = 'swim' | 'bike' | 'run';

/**
 * Priority-ordered quality kinds per discipline, by distance. Phase gates the
 * top end (base uses only the lower-intensity members; build/peak unlock the rest).
 * Short = VO2/speed/anaerobic; Ironman = sub-threshold only.
 */
export const TRI_QUALITY_FLAVOUR: Record<TriathlonDistance, {
  swim: SwimSessionKind[];
  bike: BikeSessionKind[];
  run: TriRunQualityKind[];
}> = {
  sprint:  { swim: ['speed', 'threshold'], bike: ['vo2', 'vo2_micros', 'vlamax', 'over_under'], run: ['vo2', 'threshold'] },
  olympic: { swim: ['speed', 'threshold'], bike: ['vo2', 'over_under', 'vo2_micros'],           run: ['vo2', 'threshold'] },
  t100:    { swim: ['threshold', 'speed'], bike: ['threshold', 'over_under', 'sweet_spot'],      run: ['threshold'] },
  '70.3':  { swim: ['threshold', 'speed'], bike: ['threshold', 'over_under', 'sweet_spot', 'vo2'], run: ['threshold'] },
  ironman: { swim: ['threshold'],          bike: ['sweet_spot', 'tempo', 'threshold'],           run: ['threshold'] },
};

/** Brick policy by distance: which phases get a brick + the run share of weekly hours.
 *  Sprint races barely warrant brick volume; the IM brick run is decisive. */
export const TRI_BRICK_POLICY: Record<TriathlonDistance, { phases: TrainingPhase[]; runShare: number }> = {
  sprint:  { phases: ['peak'],            runShare: 0.20 },
  olympic: { phases: ['build', 'peak'],   runShare: 0.22 },
  t100:    { phases: ['build', 'peak'],   runShare: 0.25 },
  '70.3':  { phases: ['build', 'peak'],   runShare: 0.25 },
  ironman: { phases: ['build', 'peak'],   runShare: 0.30 },
};

/** Bike brick share of weekly bike hours — distance-independent (slightly shorter than the solo long ride). */
export const BRICK_BIKE_SHARE = 0.40;

// Base-phase allowed quality kinds (defer top-end intensity to build/peak; Daniels/Bompa).
const BASE_ALLOWED_SWIM: readonly SwimSessionKind[] = ['threshold'];
const BASE_ALLOWED_BIKE: readonly BikeSessionKind[] = ['sweet_spot', 'tempo'];
const BASE_ALLOWED_RUN: readonly TriRunQualityKind[] = ['threshold'];

/** Fallback quality kind when a distance's flavour list has nothing base-eligible. */
const BASE_FALLBACK_SWIM: SwimSessionKind = 'threshold';
const BASE_FALLBACK_BIKE: BikeSessionKind = 'sweet_spot';
const BASE_FALLBACK_RUN: TriRunQualityKind = 'threshold';

function gateForBase<T>(list: readonly T[], allowed: readonly T[], phase: TrainingPhase, fallback: T): T[] {
  if (phase !== 'base') return [...list];
  const filtered = list.filter((k) => allowed.includes(k));
  return filtered.length ? filtered : [fallback];
}

/**
 * Which slot indices are quality for a discipline this week. Quality slots are the
 * first `count` eligible slots; the last slot is reserved aerobic when `reserveLast`
 * (bike long ride / run long run). Swim has no reserved long, so reserveLast=false.
 */
export function triQualitySlotIndices(
  distance: TriathlonDistance,
  phase: TrainingPhase,
  discipline: TriQualityDiscipline,
  totalSlots: number,
  reserveLast: boolean,
): Set<number> {
  const count = TRI_QUALITY_SLOTS[distance][phase][discipline];
  const reservedLast = reserveLast ? totalSlots - 1 : -1;
  const out = new Set<number>();
  let added = 0;
  for (let i = 0; i < totalSlots && added < count; i++) {
    if (i === reservedLast) continue;
    out.add(i);
    added++;
  }
  return out;
}

/** Quality bike kind for a quality slot (caller applies excluded-substitution). */
export function selectBikeQualityKind(
  distance: TriathlonDistance,
  phase: TrainingPhase,
  slotIndex: number,
  weekIndex: number,
): BikeSessionKind {
  const flavour = gateForBase(TRI_QUALITY_FLAVOUR[distance].bike, BASE_ALLOWED_BIKE, phase, BASE_FALLBACK_BIKE);
  // Rotate within the flavour list across weeks/slots so variety is preserved.
  return flavour[Math.abs(weekIndex + slotIndex) % flavour.length];
}

/** Quality swim kind for a quality slot. */
export function selectSwimQualityKind(
  distance: TriathlonDistance,
  phase: TrainingPhase,
  slotIndex: number,
  weekIndex: number,
): SwimSessionKind {
  const flavour = gateForBase(TRI_QUALITY_FLAVOUR[distance].swim, BASE_ALLOWED_SWIM, phase, BASE_FALLBACK_SWIM);
  return flavour[Math.abs(weekIndex + slotIndex) % flavour.length];
}

/** Quality run kind for a quality slot. */
export function selectRunQualityKind(
  distance: TriathlonDistance,
  phase: TrainingPhase,
  slotIndex: number,
  weekIndex: number,
): TriRunQualityKind {
  const flavour = gateForBase(TRI_QUALITY_FLAVOUR[distance].run, BASE_ALLOWED_RUN, phase, BASE_FALLBACK_RUN);
  return flavour[Math.abs(weekIndex + slotIndex) % flavour.length];
}
