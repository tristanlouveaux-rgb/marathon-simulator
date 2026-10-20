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
 * One station set is a quarter of the station's race volume (250 m on an erg,
 * one 12.5 m sled lane, 20 m of burpee broad jumps, 50 m of farmers carry,
 * 25 m of lunges, 25 wall balls). Inside technique and race-pace sessions
 * this set size is a product choice: the sheet says only 'short sets' there
 * (its race-pace example uses 10-rep EMOM sets). It is consistent with the
 * sheet's 0.25 x column of the per-station volume table and its one-lane
 * sled set. The brick's per-round station dose is the sheet's own quarter
 * (bricks.structure: 0.25 x per round, the low end of Rox Lyfe's 20 to 25
 * wall balls after each run and Rundida's one sled lane). Technique (0.5 x)
 * is 2 sets a station and race pace (1.0 x) 4, so the volume progression
 * moves in quarters of the race volume, and a sled set is one race lane.
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
 * in whole quarters of the race volume, rounded to the nearest quarter
 * (Tristan 2026-10-20; halves round up): sets = round(RACE_SETS x
 * doseFraction), held between the technique sets and the race sets. Before,
 * floor() held intermediate build at 0.75 x where the sheet lists 1.0 x. doseFraction is the week's nominal size relative to
 * the plan's peak week: its phase multiplier x the deload factor x the
 * effort / MTL-gap lever ÷ HYROX_PEAK_MULT. It never reads the chosen hours
 * (plan_engine.hyrox.ts passes budgetPerHourMin ÷ HYROX_PEAK_MULT); the
 * acute:chronic guard and the ceilings reach the dose through the session's
 * share of the week's size (doseMinutes in the generator). At the nominal
 * multipliers: base 0.55 to 0.62 holds 2 sets (0.5 x), 0.625 to 0.87 3
 * (0.75 x), 0.875 and above (build at 0.92, peak at 1.00) the full 4 (1.0 x);
 * a base deload 2 (0.5 x), a build deload (0.92 x 0.75 = 0.69) and a peak
 * deload (1.00 x HYROX_DELOAD_FACTOR 0.75) 3 (0.75 x), never above the
 * reference week's session. Doubles take half (hyroxDoublesSets).
 */
export function hyroxRacePaceSets(doseFraction: number, doubles: boolean): number {
  const f = Number.isFinite(doseFraction) ? doseFraction : 1;
  const sets = Math.max(TECHNIQUE_SETS, Math.min(RACE_SETS, Math.floor(RACE_SETS * f + 0.5 + 1e-9)));
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
 * Standard implement sizes (kg) for the fixed implements (product facts, not
 * physiology): a beginner's load is the largest size at or below the
 * schedule's fraction of race weight (sheet: "the nearest implement at or
 * below it"), and a load step moves to the next size up (Tristan
 * 2026-10-20), never the 2.5 kg plate step a sled takes. Every HYROX race
 * weight is on its ladder.
 *   - Farmers carry (kettlebells; HYROX races 2 x 16, 24 or 32 kg): Rogue
 *     Kettlebells are sold at 4, 6, 8, 12, 16, 20, 24, 28 and 32 kg in this
 *     range (roguefitness.com/rogue-kettlebells, checked 2026-10-20).
 *   - Wall balls (HYROX races 4, 6 or 9 kg): the Centr x HYROX Competition
 *     Wall Ball (Centr is HYROX's official equipment provider) comes in 2,
 *     4, 6, 9 and 12 kg, the 4, 6 and 9 kg balls the competition weights
 *     (shop.hyroxequipment.centr.com, checked 2026-10-20).
 *   - Sandbags (HYROX races 10, 20 or 30 kg): the Centr x HYROX Competition
 *     Sandbag comes in 10, 20 and 30 kg, filled with 5 kg inner bags (2, 4
 *     and 6 of them; centr.com, checked 2026-10-20), so a bag loads in 5 kg
 *     steps.
 */
export const HYROX_IMPLEMENT_SIZES_KG: Partial<Record<HyroxStation, readonly number[]>> = {
  farmer_carry: [4, 6, 8, 12, 16, 20, 24, 28, 32],
  wall_balls: [2, 4, 6, 9, 12],
  sandbag_lunges: [5, 10, 15, 20, 25, 30],
};

/** The largest standard size at or below `kg` (the smallest size when
 *  `kg` sits under it), or `kg` for a station with no ladder. */
export function hyroxImplementAtOrBelow(station: HyroxStation, kg: number): number {
  const sizes = HYROX_IMPLEMENT_SIZES_KG[station];
  if (!sizes) return kg;
  let pick = sizes[0];
  for (const x of sizes) if (x <= kg + 1e-9) pick = x;
  return pick;
}

/** The next standard size above `kg`, or `kg` at the top of the ladder or
 *  for a station with no ladder. */
export function hyroxImplementAbove(station: HyroxStation, kg: number): number {
  const sizes = HYROX_IMPLEMENT_SIZES_KG[station];
  if (!sizes) return kg;
  return sizes.find(x => x > kg + 1e-9) ?? kg;
}

/**
 * The beginner load schedule (sheet technique.station_session, Centr's
 * beginner plan at the low end of each range):
 *   - sleds unloaded in plan weeks 1 and 2, then 50% of race sled weight;
 *   - the other loaded stations (farmers carry, sandbag, wall ball) at 60%;
 *   - race weight from the week before the full sim, or 4 weeks before race
 *     week in a plan with no full sim, so the race is not the first
 *     race-weight session.
 */
export const HYROX_BEGINNER_LOADS = {
  sledUnloadedWeeks: 2,
  sledFraction: 0.5,
  otherFraction: 0.6,
  raceWeightWeeksOut: 4,
} as const;

/** Reduced-load weeks a beginner holds after the unloaded sled weeks, before
 *  race weight, whatever the plan's length (Tristan 2026-10-20: plans of 7
 *  weeks or fewer keep at least one reduced-load week; before, a 7-week plan
 *  took the sleds from unloaded to race weight in week 3). */
export const HYROX_BEGINNER_MIN_REDUCED_WEEKS = 1;

/**
 * First plan week at race weight for a beginner: the week before the full
 * race simulation (`fullSimWeek`, sheet technique.station_session: race
 * weight from the week before the full sim, so the sim is not the first
 * race-weight session), or 4 weeks before race week (`raceWeekIndex`, the
 * plan's final training week) in a plan with no full sim. Never before the
 * unloaded sled weeks and HYROX_BEGINNER_MIN_REDUCED_WEEKS reduced-load
 * weeks after them.
 */
export function hyroxBeginnerRaceWeightWeek(raceWeekIndex: number, fullSimWeek?: number | null): number {
  const earliest = HYROX_BEGINNER_LOADS.sledUnloadedWeeks + HYROX_BEGINNER_MIN_REDUCED_WEEKS + 1;
  const start = fullSimWeek != null ? fullSimWeek - 1 : raceWeekIndex - HYROX_BEGINNER_LOADS.raceWeightWeeksOut;
  return Math.max(earliest, start);
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
 * The farmers carry, sandbag and wall ball are fixed implements: the largest
 * standard size at or below the fraction (HYROX_IMPLEMENT_SIZES_KG; sheet:
 * the nearest implement at or below it), never above race weight. Before
 * (lane H2b part 1) the exact figure, with "or the nearest lighter" in the
 * prescription.
 */
export function hyroxLoadKgAt(station: HyroxStation, tier: HyroxLoadTier, fraction: number): number | null {
  const race = hyroxRaceLoadKg(station, tier);
  if (race == null) return null;
  if (fraction >= 1) return race;
  const kg = race * Math.max(0, fraction);
  if (isHyroxSled(station)) return Math.floor(kg / STRENGTH_MIN_INCREMENT_KG + 1e-9) * STRENGTH_MIN_INCREMENT_KG;
  return Math.min(race, hyroxImplementAtOrBelow(station, kg));
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
 * the load the last session held, stepped when strength-progression's
 * suggestNextWeight steps a lift (climbs only in base and build when the last
 * session felt easier than its target RPE; holds in peak, taper and deload
 * weeks; suppressed by an injury that adapts or pauses strength work),
 * whichever is heavier, never above race weight. A sled steps as a lift does
 * (2.5%, at least one 2.5 kg plate); a fixed implement steps to the next
 * standard size (HYROX_IMPLEMENT_SIZES_KG, Tristan 2026-10-20: a plate step
 * took a 2.4 kg wall ball to race weight in one or two steps). Null for a
 * station with no load.
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
  const suggested = m
    ? suggestNextWeight({
        lastWeightKg: m.kg,
        lastRir: hyroxRpeToRir(m.ratedRpe, m.targetRpe),
        phase: args.phase,
        isDeload: args.deload,
        injuryKind: args.injuryKind,
      }).weightKg
    : 0;
  // A fixed implement climbs to the next standard size, holds otherwise.
  const ladder = HYROX_IMPLEMENT_SIZES_KG[args.station] != null;
  const stepped = m && ladder ? (suggested > m.kg + 1e-9 ? hyroxImplementAbove(args.station, m.kg) : m.kg) : suggested;
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
