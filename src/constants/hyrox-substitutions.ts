/**
 * HYROX no-equipment station substitutions.
 *
 * Per-station bodyweight or low-equipment swaps for users who don't have
 * access to a specific piece of equipment. Each option preserves approximate
 * MTL — the substitute targets a similar muscle group at a similar load
 * (see Damas et al. 2016 on equivalent eccentric stimulus across modalities).
 *
 * Used by the workout detail modal's per-station "I don't have this" picker.
 */
import type { HyroxStation } from '@/types/triathlon';

export interface StationSubstitution {
  /** Stable id for persistence. */
  id: string;
  /** Display name in the picker and on the swapped row. */
  name: string;
  /** Short instruction line shown under the name. */
  description: string;
  /** Multiplier on MTL relative to the original station (1.0 = same eccentric stimulus). */
  mtlFactor: number;
}

export const HYROX_STATION_SUBSTITUTIONS: Record<HyroxStation, StationSubstitution[]> = {
  ski_erg: [
    { id: 'run_replace',     name: 'Run replacement',         description: '500m moderate run instead of 1000m ski.',         mtlFactor: 0.7 },
    { id: 'jumping_jacks',   name: 'Jumping jacks',           description: '3 min continuous jumping jacks at moderate effort.', mtlFactor: 0.5 },
  ],
  sled_push: [
    { id: 'squat_thrusts',   name: 'Squat thrusts',           description: '50 reps — squat down, jump feet back to plank, jump in, stand.', mtlFactor: 0.8 },
    { id: 'wall_sit',        name: 'Wall sit + air squats',   description: '60s wall sit, then 30 air squats. Repeat ×2.',     mtlFactor: 0.6 },
  ],
  sled_pull: [
    { id: 'inverted_rows',   name: 'Inverted rows',           description: '40 reps under a sturdy table or low bar.',         mtlFactor: 0.7 },
    { id: 'reverse_snow',    name: 'Reverse snow angels',     description: 'Lying face down, 50 reverse snow-angels with isometric hold.', mtlFactor: 0.5 },
  ],
  burpee_broad_jumps: [
    { id: 'burpees_inplace', name: 'In-place burpees',        description: '40 burpees without the broad jump. Hands stay near feet.', mtlFactor: 0.85 },
    { id: 'air_squat_jumps', name: 'Air squat jumps',         description: '60 squat jumps as fast as possible.',              mtlFactor: 0.7 },
  ],
  row_erg: [
    { id: 'run_replace_row', name: 'Run replacement',         description: '500m moderate run instead of 1000m row.',          mtlFactor: 0.7 },
    { id: 'mountain_climb',  name: 'Mountain climbers',       description: '3 min continuous mountain climbers.',              mtlFactor: 0.6 },
  ],
  farmer_carry: [
    { id: 'backpack_carry',  name: 'Backpack carry',          description: '200m walk holding a heavy backpack in each hand (or one suitcase-style).', mtlFactor: 0.9 },
    { id: 'static_hold',     name: 'Static heavy hold',       description: '4 × 45s holds with heaviest household object you can grip.', mtlFactor: 0.7 },
  ],
  sandbag_lunges: [
    { id: 'bodyweight_lng',  name: 'Bodyweight lunges',       description: '150 alternating walking lunges (1.5× the rep count).', mtlFactor: 0.85 },
    { id: 'split_squats',    name: 'Bulgarian split squats',  description: '4 × 20 each leg, rear foot elevated on a chair.',  mtlFactor: 0.9 },
  ],
  wall_balls: [
    { id: 'goblet_squats',   name: 'Goblet squats',           description: '100 reps with any weight you have (water bottle / book).', mtlFactor: 0.85 },
    { id: 'air_squats',      name: 'Air squats × 2',          description: '200 air squats — double the rep count to match volume.', mtlFactor: 0.7 },
  ],
};

/** Get all substitutions for a station, including the option to revert. */
export function getSubstitutionsFor(station: HyroxStation): StationSubstitution[] {
  return HYROX_STATION_SUBSTITUTIONS[station] ?? [];
}

/** Look up a substitution by id within a station's list. */
export function findSubstitution(station: HyroxStation, id: string): StationSubstitution | undefined {
  return getSubstitutionsFor(station).find(s => s.id === id);
}
