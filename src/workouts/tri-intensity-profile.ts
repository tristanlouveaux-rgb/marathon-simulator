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
 *
 * Taper rows mirror peak (Tristan, 2026-10-13: keep quality in the taper).
 * Cutting intensity in a taper gave ES -0.02 against 0.33 for keeping it
 * (Bosquet 2007); in Wang 2023, where a negative SMD favours the taper,
 * keeping it gave -0.55 and cutting it +0.25. The race taper itself takes its
 * counts from the reference week (plan_engine.triathlon triTaperWeekOne);
 * these rows feed the inter-cycle taper weeks of 28+ week plans. The gate
 * below caps the intensity.
 */
type DisciplineCounts = { swim: number; bike: number; run: number };
export const TRI_QUALITY_SLOTS: Record<TriathlonDistance, Record<TrainingPhase, DisciplineCounts>> = {
  sprint: {
    base:  { swim: 1, bike: 1, run: 0 },
    build: { swim: 2, bike: 2, run: 1 },
    peak:  { swim: 2, bike: 2, run: 1 },
    taper: { swim: 2, bike: 2, run: 1 },
  },
  olympic: {
    base:  { swim: 1, bike: 1, run: 0 },
    build: { swim: 2, bike: 2, run: 1 },
    peak:  { swim: 2, bike: 2, run: 1 },
    taper: { swim: 2, bike: 2, run: 1 },
  },
  t100: {
    base:  { swim: 0, bike: 1, run: 0 },
    build: { swim: 1, bike: 2, run: 1 },
    peak:  { swim: 1, bike: 2, run: 1 },
    taper: { swim: 1, bike: 2, run: 1 },
  },
  '70.3': {
    base:  { swim: 0, bike: 1, run: 0 },
    build: { swim: 1, bike: 2, run: 1 },
    peak:  { swim: 1, bike: 2, run: 1 },
    taper: { swim: 1, bike: 2, run: 1 },
  },
  ironman: {
    base:  { swim: 0, bike: 0, run: 0 },
    build: { swim: 1, bike: 1, run: 1 },
    peak:  { swim: 1, bike: 1, run: 1 },
    taper: { swim: 1, bike: 1, run: 1 },
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

// Base: defer top-end VO2/anaerobic to build/peak (Daniels/Bompa). Base quality
// stays sub-threshold (bike sweet spot or tempo, swim and run threshold).
const LOW_INTENSITY_SWIM: readonly SwimSessionKind[] = ['threshold'];
const LOW_INTENSITY_BIKE: readonly BikeSessionKind[] = ['sweet_spot', 'tempo'];
const LOW_INTENSITY_RUN: readonly TriRunQualityKind[] = ['threshold'];

/** Fallback quality kind when a distance's flavour list has nothing low-intensity-eligible. */
const LOW_INTENSITY_FALLBACK_SWIM: SwimSessionKind = 'threshold';
const LOW_INTENSITY_FALLBACK_BIKE: BikeSessionKind = 'sweet_spot';
const LOW_INTENSITY_FALLBACK_RUN: TriRunQualityKind = 'threshold';

/**
 * Taper intensity ceiling by race distance (Tristan, 2026-10-13; SCIENCE_LOG
 * "Triathlon and cycling taper rebuild"). Quality stays in the taper (Bosquet
 * 2007: cutting intensity ES -0.02, keeping it 0.33). The ceiling differs:
 *   - 'short_efforts' (sprint, Olympic): short faster efforts are allowed, as
 *     Laidlow keeps 30:30 VO2max sessions in the taper (220 Triathlon 2017).
 *     The bike gains VO2 micro-intervals (30 s on, 30 s off, Billat 2001), the
 *     swim keeps speed sets (25 to 75 m fast reps); the run stays at threshold
 *     (the run library has no short-effort session).
 *   - 'race_pace' (T100, 70.3, Ironman): quality is capped at race intensity
 *     (Alexander keeps taper sessions at "target race intensity level",
 *     TrainingPeaks 2022; his "cap the intensity at my target race pace" is
 *     from a Shimano interview seen only as a search snippet, medium
 *     confidence). Threshold is above long-course race intensity, so the
 *     sub-threshold kinds the gate allowed before (threshold runs and swims,
 *     sweet-spot rides) give way to race-pace sessions (tri-taper.ts), held
 *     inside Dave Scott's 4 to 12 min taper sets. Cycling mode, whose events
 *     last 1.5 h or more, takes this ceiling at its event's intensity factor.
 */
export const TRI_TAPER_INTENSITY_CEILING: Record<TriathlonDistance, 'short_efforts' | 'race_pace'> = {
  sprint:  'short_efforts',
  olympic: 'short_efforts',
  t100:    'race_pace',
  '70.3':  'race_pace',
  ironman: 'race_pace',
};

/** A taper quality slot filled by a race-pace session (tri-taper.ts). */
export type TriRacePaceKind = 'race_pace';

const TAPER_SHORT_SWIM: readonly SwimSessionKind[] = ['threshold', 'speed'];
const TAPER_SHORT_BIKE: readonly BikeSessionKind[] = ['sweet_spot', 'tempo', 'vo2_micros'];
const TAPER_SHORT_RUN: readonly TriRunQualityKind[] = ['threshold'];

/** True when this plan's taper caps quality at race intensity. Cycling mode
 *  always does (its distance field is a 70.3 placeholder). */
export function triTaperCapsAtRacePace(distance: TriathlonDistance, cyclingOnly = false): boolean {
  return cyclingOnly || TRI_TAPER_INTENSITY_CEILING[distance] === 'race_pace';
}

function gateLowIntensity<T>(
  list: readonly T[], allowed: readonly T[], taperAllowed: readonly T[], phase: TrainingPhase, fallback: T,
): T[] {
  if (phase !== 'base' && phase !== 'taper') return [...list];
  const filtered = list.filter((k) => (phase === 'taper' ? taperAllowed : allowed).includes(k));
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
  cyclingOnly = false,
): BikeSessionKind | TriRacePaceKind {
  if (phase === 'taper' && triTaperCapsAtRacePace(distance, cyclingOnly)) return 'race_pace';
  const flavour = gateLowIntensity(TRI_QUALITY_FLAVOUR[distance].bike, LOW_INTENSITY_BIKE, TAPER_SHORT_BIKE, phase, LOW_INTENSITY_FALLBACK_BIKE);
  // Rotate within the flavour list across weeks/slots so variety is preserved.
  return flavour[Math.abs(weekIndex + slotIndex) % flavour.length];
}

/** Quality swim kind for a quality slot. */
export function selectSwimQualityKind(
  distance: TriathlonDistance,
  phase: TrainingPhase,
  slotIndex: number,
  weekIndex: number,
): SwimSessionKind | TriRacePaceKind {
  if (phase === 'taper' && triTaperCapsAtRacePace(distance)) return 'race_pace';
  const flavour = gateLowIntensity(TRI_QUALITY_FLAVOUR[distance].swim, LOW_INTENSITY_SWIM, TAPER_SHORT_SWIM, phase, LOW_INTENSITY_FALLBACK_SWIM);
  return flavour[Math.abs(weekIndex + slotIndex) % flavour.length];
}

/** Quality run kind for a quality slot. */
export function selectRunQualityKind(
  distance: TriathlonDistance,
  phase: TrainingPhase,
  slotIndex: number,
  weekIndex: number,
): TriRunQualityKind | TriRacePaceKind {
  if (phase === 'taper' && triTaperCapsAtRacePace(distance)) return 'race_pace';
  const flavour = gateLowIntensity(TRI_QUALITY_FLAVOUR[distance].run, LOW_INTENSITY_RUN, TAPER_SHORT_RUN, phase, LOW_INTENSITY_FALLBACK_RUN);
  return flavour[Math.abs(weekIndex + slotIndex) % flavour.length];
}
