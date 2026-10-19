/**
 * HYROX station dosing (lane H2b part 1): the two station-session formats,
 * the volume progression, the beginner load schedule with its RPE
 * autoregulation, and the brick structures by tier.
 *
 * Sources: the HYROX parameter sheet of 2026-10-12, revised after its
 * fact-check (technique.station_session, bricks.structure, the per-station
 * volume table, rules_to_code on damper and lanes), and Tristan's decision of
 * 2026-10-12: station work takes progressive loads borrowed from running and
 * weightlifting. Running's lever is volume that grows with the week (the
 * race-pace dose rides the week's size relative to peak); weightlifting's is
 * load, autoregulated from how the last session felt (suggestNextWeight,
 * strength-progression.ts). Intermediate and advanced athletes train at race
 * weight (sheet), so their lever is volume; beginners start light, so theirs
 * is load. Science: SCIENCE_LOG, HYROX station dosing (lane H2b).
 *
 * Side of the line: planning. Pure: no state access.
 */

import type { HyroxLoadTier, HyroxStation } from '@/types/triathlon';
import type { TrainingPhase } from '@/types/training';
import type { RirBucket } from '@/types/strength-log';
import type { HyroxTier } from '@/constants/hyrox-constants';
import { HYROX_LOAD_TIER_KG, STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import { STRENGTH_MIN_INCREMENT_KG } from '@/constants/strength-constants';
import { suggestNextWeight } from '@/calculations/strength-progression';

// ─── Sets ────────────────────────────────────────────────────────────────────

/**
 * One station set is a quarter of the station's race volume: the sheet's
 * 0.25 x column (250 m on an erg, one 12.5 m sled lane, 20 m of burpee broad
 * jumps, 50 m of farmers carry, 25 m of lunges, 25 wall balls). The brick's
 * per-round station dose is the same quarter (bricks.structure: 0.25 x per
 * round, the low end of Rox Lyfe's 20 to 25 wall balls after each run and
 * Rundida's one sled lane). Technique (0.5 x) is 2 sets a station and race
 * pace (1.0 x) 4, so the volume progression moves in quarters of the race
 * volume, and a sled set is one race lane.
 */
export const HYROX_STATION_SET_FRACTION = 0.25;

/**
 * The two station-session formats (sheet technique.station_session):
 *   - technique: 0.5 x race volume per station in short sets, RPE 5, 2 min
 *     rest between sets (RPE 5 is the generator's existing technique value;
 *     Centr's beginner plan rests a full 2 min; the 0.5 x volume is a product
 *     choice, no source gives a per-session fraction);
 *   - race pace: 1.0 x race volume per station at race weight, RPE 7, 90 s
 *     rest (1.0 x is the low end of the untiered race-pace examples: Rox
 *     Lyfe's 10 x 10 wall balls, Velites' 4 x 25 m sled push, Rox Lyfe's
 *     3 x 25 m sled; 90 s is Velites'; RPE 7 is the low end of
 *     docs/research/hyrox.md s3.5).
 */
export const HYROX_STATION_FORMATS = {
  technique: { volumeFraction: 0.5, rpe: 5, restSec: 120 },
  race_pace: { volumeFraction: 1.0, rpe: 7, restSec: 90 },
} as const;

/** Stations per station session by tier (sheet): beginner 4, rotated so each
 *  recurs every 2 weeks; intermediate and advanced 3, the race-pace session
 *  including the weakest. */
export const HYROX_STATIONS_PER_SESSION: Record<HyroxTier, number> = { beginner: 4, intermediate: 3, advanced: 3 };

/** Beginner sleds: 4 sets of one 12.5 m lane (sheet; Centr's beginner 4 sets,
 *  its 15 m set rounded down to a race lane), at the beginner load schedule. */
export const HYROX_BEGINNER_SLED_SETS = 4;

/** SkiErg and row damper in every division since 25/26 (26/27 Singles
 *  rulebook s8.1 and s8.5; the fact-check verified it). */
export const HYROX_ERG_DAMPER = 6;

/** The station's race volume (metres, or reps for wall balls), from the
 *  rulebook display table (STATION_DISPLAY). */
export function hyroxStationRaceAmount(station: HyroxStation): number {
  return parseInt(STATION_DISPLAY[station].distance, 10);
}

/** One set of a station (metres, or reps for wall balls). */
export function hyroxStationSetAmount(station: HyroxStation): number {
  return hyroxStationRaceAmount(station) * HYROX_STATION_SET_FRACTION;
}

/** Sets of the race volume (4 at a set of 0.25 x). */
const RACE_SETS = Math.round(HYROX_STATION_FORMATS.race_pace.volumeFraction / HYROX_STATION_SET_FRACTION);
/** Sets of the technique volume (2). */
const TECHNIQUE_SETS = Math.round(HYROX_STATION_FORMATS.technique.volumeFraction / HYROX_STATION_SET_FRACTION);

/**
 * Doubles: each partner trains half of every station (sheet; the rules set no
 * minimum split, and the plan trains 50/50). Half the sets, rounded up to a
 * whole set, so a station is never dropped and a sled set stays one lane.
 */
export function hyroxDoublesSets(sets: number): number {
  return Math.max(1, Math.ceil(sets / 2));
}

/** Sets a station takes in a technique session (2; doubles 1). */
export function hyroxTechniqueSets(doubles: boolean): number {
  return doubles ? hyroxDoublesSets(TECHNIQUE_SETS) : TECHNIQUE_SETS;
}

/**
 * Sets a station takes in a race-pace session: the volume progression
 * (Tristan 2026-10-12, running's lever). The dose steps from the technique
 * volume toward the race-pace volume as the week's size grows toward peak,
 * in whole quarters of the race volume, rounded down (the sheet's
 * conservative end): sets = floor(RACE_SETS x doseFraction), held between the
 * technique sets and the race sets. doseFraction is the week's size relative
 * to the plan's peak week (week budget ÷ chosen hours x HYROX_PEAK_MULT), so
 * the dose rides the phase ramp, the deload, the acute:chronic guard and the
 * effort lever that size the week. At the nominal multipliers: base 0.55 to
 * 0.74 holds 2 sets (0.5 x), 0.75 to 0.99 (late base, build at 0.92) 3 (0.75
 * x), peak at 1.00 the full 4 (1.0 x). Doubles take half (hyroxDoublesSets).
 */
export function hyroxRacePaceSets(doseFraction: number, doubles: boolean): number {
  const f = Number.isFinite(doseFraction) ? doseFraction : 1;
  const sets = Math.max(TECHNIQUE_SETS, Math.min(RACE_SETS, Math.floor(RACE_SETS * f + 1e-9)));
  return doubles ? hyroxDoublesSets(sets) : sets;
}

// ─── Loads ───────────────────────────────────────────────────────────────────

/** Stations that carry an external load. */
export const HYROX_LOADED_STATIONS: readonly HyroxStation[] = ['sled_push', 'sled_pull', 'farmer_carry', 'sandbag_lunges', 'wall_balls'];

export function isHyroxSled(station: HyroxStation): boolean {
  return station === 'sled_push' || station === 'sled_pull';
}

/** The race load of a station at a load tier (kg: the sled total including the
 *  sled, the farmers carry per hand, the sandbag, the ball), or null for a
 *  station with no load. */
export function hyroxRaceLoadKg(station: HyroxStation, tier: HyroxLoadTier): number | null {
  const t = HYROX_LOAD_TIER_KG[tier];
  switch (station) {
    case 'sled_push':      return t.sledPush;
    case 'sled_pull':      return t.sledPull;
    case 'farmer_carry':   return t.farmerPerHand;
    case 'sandbag_lunges': return t.sandbag;
    case 'wall_balls':     return t.wallBall;
    default:               return null;
  }
}

/**
 * The beginner load schedule (sheet technique.station_session, Centr's
 * beginner plan at the low end of each range):
 *   - sleds unloaded in plan weeks 1 and 2, then 50% of race sled weight;
 *   - the other loaded stations (farmers carry, sandbag, wall ball) at 60%;
 *   - race weight from the week before the full sim, or 4 weeks out without
 *     one (race sims are part 2: none yet), so the race is not the first
 *     race-weight session.
 */
export const HYROX_BEGINNER_LOADS = {
  sledUnloadedWeeks: 2,
  sledFraction: 0.5,
  otherFraction: 0.6,
  raceWeightWeeksOut: 4,
} as const;

/**
 * First plan week at race weight for a beginner: 4 weeks before race week
 * (`raceWeekIndex`, the plan's final training week), never inside the
 * unloaded sled weeks. In a plan of 7 weeks or fewer the reduced-load weeks
 * shrink or vanish (an open question).
 */
export function hyroxBeginnerRaceWeightWeek(raceWeekIndex: number): number {
  return Math.max(HYROX_BEGINNER_LOADS.sledUnloadedWeeks + 1, raceWeekIndex - HYROX_BEGINNER_LOADS.raceWeightWeeksOut);
}

/** The beginner schedule's fraction of race weight for a loaded station in
 *  plan week `weekIndex` (0: the sled unloaded), or null for a station with
 *  no load. */
export function hyroxBeginnerLoadFraction(station: HyroxStation, weekIndex: number, raceWeightWeek: number): number | null {
  if (!HYROX_LOADED_STATIONS.includes(station)) return null;
  if (weekIndex >= raceWeightWeek) return 1;
  if (isHyroxSled(station)) return weekIndex <= HYROX_BEGINNER_LOADS.sledUnloadedWeeks ? 0 : HYROX_BEGINNER_LOADS.sledFraction;
  return HYROX_BEGINNER_LOADS.otherFraction;
}

/**
 * A fraction of race weight as a prescribed load (kg). Sleds take plates, so
 * the sled total rounds down to the plate step (STRENGTH_MIN_INCREMENT_KG,
 * 2.5 kg, strength-progression's real plate jump): at or below the fraction.
 * The farmers carry, sandbag and wall ball are fixed implements: the exact
 * figure, and the prescription names "the nearest lighter" implement (sheet:
 * the nearest implement at or below it). No implement ladder is sourced.
 */
export function hyroxLoadKgAt(station: HyroxStation, tier: HyroxLoadTier, fraction: number): number | null {
  const race = hyroxRaceLoadKg(station, tier);
  if (race == null) return null;
  if (fraction >= 1) return race;
  const kg = race * Math.max(0, fraction);
  if (isHyroxSled(station)) return Math.floor(kg / STRENGTH_MIN_INCREMENT_KG + 1e-9) * STRENGTH_MIN_INCREMENT_KG;
  return Math.round(kg * 10) / 10;
}

/**
 * How the last station session felt against its target, as
 * strength-progression's reps-in-reserve bucket: easier than the target RPE
 * is 'reps-left' (the cue to climb), on it 'about-right', harder 'barely'.
 * Unrated: undefined (hold).
 */
export function hyroxRpeToRir(ratedRpe: number | undefined, targetRpe: number): RirBucket | undefined {
  if (ratedRpe == null || !Number.isFinite(ratedRpe)) return undefined;
  if (ratedRpe < targetRpe) return 'reps-left';
  if (ratedRpe > targetRpe) return 'barely';
  return 'about-right';
}

/** What the beginner load progression remembers of a station: the load of
 *  the last station session holding it, and that session's rating. */
export interface HyroxStationLoadMemory {
  kg: number;
  ratedRpe?: number;
  targetRpe: number;
}

/**
 * A beginner's load for a station in a plan week: the schedule's anchor, or
 * the load the last session held, stepped exactly as strength-progression's
 * suggestNextWeight steps a lift (a 2.5% step, at least one 2.5 kg plate;
 * climbs only in base and build when the last session felt easier than its
 * target RPE; holds in peak, taper and deload weeks; suppressed by an injury
 * that adapts or pauses strength work), whichever is heavier, never above
 * race weight. Null for a station with no load.
 */
export function hyroxBeginnerStationLoadKg(args: {
  station: HyroxStation;
  loadTier: HyroxLoadTier;
  weekIndex: number;
  raceWeightWeek: number;
  phase: TrainingPhase;
  deload: boolean;
  injuryKind: 'normal' | 'none' | 'adapted';
  memory?: HyroxStationLoadMemory;
}): number | null {
  const race = hyroxRaceLoadKg(args.station, args.loadTier);
  const fraction = hyroxBeginnerLoadFraction(args.station, args.weekIndex, args.raceWeightWeek);
  if (race == null || fraction == null) return null;
  const anchor = hyroxLoadKgAt(args.station, args.loadTier, fraction) ?? 0;
  const m = args.memory;
  const stepped = m
    ? suggestNextWeight({
        lastWeightKg: m.kg,
        lastRir: hyroxRpeToRir(m.ratedRpe, m.targetRpe),
        phase: args.phase,
        isDeload: args.deload,
        injuryKind: args.injuryKind,
      }).weightKg
    : 0;
  return Math.min(race, Math.max(anchor, stepped));
}

// ─── Bricks ──────────────────────────────────────────────────────────────────

/** A brick's structure (sheet bricks.structure). */
export interface HyroxBrickFormat {
  /** Rounds of run then station. */
  rounds: number;
  /** Each round's run (m). */
  runM: number;
  runEffort: 'race_no_faster' | 'race' | 'race_or_faster' | 'easy';
  /** Stations: 1, or 2 alternating rounds. */
  stations: 1 | 2;
  /** Rest between rounds (s); 0: the transition jog only. */
  roundRestSec: number;
  /** Jog from each run to its station (s): the existing 30 s transition. */
  transitionSec: number;
  /** Session RPE: the beginner and taper brick 6 and the tier bricks 7 (the
   *  generator's existing mini-brick and brick values); the secondary brick
   *  5 (sheet: technique effort). */
  rpe: number;
  /** The advanced key brick holds one eccentric station. */
  eccentricStation?: boolean;
}

/**
 * Bricks by tier (sheet bricks.structure; 3, 4 and 6 rounds and 400 m / 800 m
 * runs are the low ends of docs/research/hyrox.md s3.5 that real coach
 * examples also use; 0.25 x per round, HYROX_STATION_SET_FRACTION; the 2 min
 * rest is the existing mini-brick rest and Fast Talk's, a product choice for
 * beginners):
 *   - beginner: 3 x 400 m at goal race pace, no faster, into 1 station;
 *   - intermediate: 4 x 800 m at goal race pace into 2 stations alternating;
 *   - advanced key brick: 6 x 800 m at race pace or faster, negative split,
 *     2 stations alternating, one eccentric, the 30 s jog only;
 *   - advanced secondary brick (peak): 4 x 800 m easy into ergs, sleds or the
 *     farmers carry at technique effort, not a hard session.
 * The taper's downgraded brick takes the beginner structure on ergs.
 */
export const HYROX_BRICK_FORMATS: Record<HyroxTier | 'secondary', HyroxBrickFormat> = {
  beginner:     { rounds: 3, runM: 400, runEffort: 'race_no_faster', stations: 1, roundRestSec: 120, transitionSec: 30, rpe: 6 },
  intermediate: { rounds: 4, runM: 800, runEffort: 'race',           stations: 2, roundRestSec: 120, transitionSec: 30, rpe: 7 },
  advanced:     { rounds: 6, runM: 800, runEffort: 'race_or_faster', stations: 2, roundRestSec: 0,   transitionSec: 30, rpe: 7, eccentricStation: true },
  secondary:    { rounds: 4, runM: 800, runEffort: 'easy',           stations: 2, roundRestSec: 120, transitionSec: 30, rpe: 5 },
};

/**
 * The rounds a brick station takes (1-based): every round for a single
 * station; alternating stations take the odd (`slot` 0) or even (`slot` 1)
 * rounds. Doubles: every other one of those, the first included (half the
 * station, rounded up; the rounds left over are the partner's turn).
 */
export function hyroxBrickStationRounds(rounds: number, stations: 1 | 2, slot: 0 | 1, doubles: boolean): number[] {
  const own = Array.from({ length: rounds }, (_, i) => i + 1).filter(r => stations === 1 || (r - 1) % 2 === slot);
  return doubles ? own.filter((_, i) => i % 2 === 0) : own;
}
