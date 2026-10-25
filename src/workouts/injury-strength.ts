/**
 * Injury-adapted strength prescription (shared across running, triathlon, HYROX).
 *
 * Physiological basis: relative rest + regional load substitution. When one
 * body region is injured, loading the *unaffected* regions maintains strength
 * and neuromuscular qualities without stressing the healing tissue (Bleakley
 * et al. 2012; PEACE & LOVE, Dubois & Esculier 2020). A knee injury does not
 * preclude upper-body strength; a shoulder injury does not preclude lower-body
 * strength. Relative rest is region-specific, not systemic, so the unaffected
 * region is loaded from the acute phase onward. Only the injured region is
 * ever withheld.
 *
 * Tailoring goes deeper than upper/lower: every exercise is tagged with the
 * body areas it actually loads, and any exercise that touches the injured area
 * is excluded. So a shoulder injury drops front/side planks, pallof press,
 * goblet squats and glute bridges (all of which load the shoulder) and keeps
 * shoulder-free leg and core work. Loads stay submaximal (RPE <= 5) and
 * pain-gated through recovery, normalising once resolved.
 *
 * This module produces the *content* (exercise list -> `.d` string, duration,
 * RPE). Each plan engine attaches its own load fields (triathlon adds scaled
 * aerobic/anaerobic; running derives load from RPE x duration downstream).
 */

import type { Workout } from '@/types';
import type { InjuryState, InjuryLocation } from '@/types/injury';
import { bodyRegionLoadability } from '@/injury/engine';

type Region = 'lower' | 'upper' | 'core';

/** Functional body areas an exercise can load/require. A superset of injury
 *  locations plus `grip` (loaded grip, relevant to hand/wrist/elbow injuries). */
type BodyArea =
  | 'shoulder' | 'elbow' | 'wrist' | 'neck' | 'lowerBack' | 'chest'
  | 'hip' | 'knee' | 'hamstring' | 'calf' | 'foot' | 'grip';

interface Exercise {
  region: Region;
  sets: string;       // "3x12", "3x10 each leg"
  name: string;       // "Bodyweight Squat"
  cue: string;        // pain-gated feel cue
  rest: string;       // "60s rest"
  loads: BodyArea[];  // areas this exercise meaningfully loads or requires
}

/**
 * Body areas to avoid loading for each injury location. Includes the injured
 * site plus tightly-coupled structures (a hamstring crosses the knee; a wrist
 * injury rules out loaded grip). Any exercise whose `loads` intersect this set
 * is excluded from prescription.
 */
const LOCATION_AVOID: Record<InjuryLocation, BodyArea[]> = {
  foot:       ['foot', 'calf'],
  knee:       ['knee'],
  calf:       ['calf', 'foot'],
  hamstring:  ['hamstring', 'knee'],
  hip:        ['hip'],
  back:       ['lowerBack'],
  shoulder:   ['shoulder'],
  upper_arm:  ['shoulder', 'elbow'],
  elbow:      ['elbow', 'grip'],
  forearm:    ['elbow', 'wrist', 'grip'],
  wrist:      ['wrist', 'grip'],
  neck:       ['neck', 'shoulder'],
  chest_ribs: ['chest', 'shoulder'],
  other:      [],
};

/**
 * Exercise library. Bodyweight / band / machine biased so it filters cleanly
 * for a wide range of injuries; loaded variants are tagged with `grip`/joint
 * areas so they drop out for the relevant injuries. Order is the selection
 * priority within a region (first safe N are chosen).
 */
const LIBRARY: Exercise[] = [
  // ── Lower body ──
  { region: 'lower', sets: '3x12', name: 'Bodyweight Squat', cue: 'Pain-free depth, controlled', rest: '45s rest', loads: ['knee', 'hip'] },
  { region: 'lower', sets: '3x10 each leg', name: 'Reverse Lunge (bodyweight)', cue: 'Steady, touch the back knee down lightly', rest: '60s rest', loads: ['knee', 'hip'] },
  { region: 'lower', sets: '3x10 each leg', name: 'Step-Ups (low box, bodyweight)', cue: 'Drive through the heel', rest: '60s rest', loads: ['knee', 'hip'] },
  { region: 'lower', sets: '3x10 each leg', name: 'Single-Leg RDL (bodyweight)', cue: 'Balance first, flat back', rest: '45s rest', loads: ['hamstring', 'hip'] },
  { region: 'lower', sets: '3x12 each side', name: 'Banded Hip Abduction', cue: 'Slow and controlled', rest: '30s rest', loads: ['hip'] },
  { region: 'lower', sets: '3x15', name: 'Standing Calf Raises (bodyweight)', cue: 'Full pain-free range, pause at the top', rest: '30s rest', loads: ['calf', 'foot'] },
  { region: 'lower', sets: '3x40s', name: 'Wall Sit', cue: 'Thighs toward parallel, back flat', rest: '45s rest', loads: ['knee', 'hip'] },
  { region: 'lower', sets: '3x10 each leg', name: 'Hamstring Slider Curl', cue: 'Slow eccentric, hips up', rest: '45s rest', loads: ['hamstring', 'knee'] },
  { region: 'lower', sets: '3x12', name: 'Glute Bridge', cue: 'Squeeze at the top for 1s', rest: '30s rest', loads: ['hip', 'hamstring', 'shoulder'] },
  { region: 'lower', sets: '3x10 each leg', name: 'Single-Leg Glute Bridge', cue: 'Hips level throughout', rest: '30s rest', loads: ['hip', 'hamstring', 'shoulder'] },

  // ── Upper body ──
  { region: 'upper', sets: '3x12', name: 'Band Pull-Apart', cue: 'Shoulders down, slow', rest: '30s rest', loads: ['shoulder'] },
  { region: 'upper', sets: '3x12', name: 'Band Face Pull', cue: 'Lead with the elbows, slow', rest: '30s rest', loads: ['shoulder'] },
  { region: 'upper', sets: '3x10', name: 'Dumbbell Row', cue: 'Squeeze the shoulder blade, controlled', rest: '60s rest', loads: ['shoulder', 'elbow', 'grip'] },
  { region: 'upper', sets: '3x8 each arm', name: 'Single-Arm Press (light)', cue: 'Brace the core, no shooting pain', rest: '60s rest', loads: ['shoulder', 'elbow'] },
  { region: 'upper', sets: '3x10', name: 'Incline Push-Up', cue: 'Body in a line, elbows about 45 degrees', rest: '45s rest', loads: ['shoulder', 'elbow', 'wrist', 'chest'] },
  { region: 'upper', sets: '3x12', name: 'Biceps Curl (light)', cue: 'Controlled, no swinging', rest: '30s rest', loads: ['elbow', 'grip'] },
  { region: 'upper', sets: '3x30s each side', name: 'Suitcase Carry', cue: 'Tall posture, ribs down', rest: '45s rest', loads: ['grip', 'shoulder'] },

  // ── Core ──
  { region: 'core', sets: '3x10', name: 'Dead Bug', cue: 'Slow, lower back flat (arms resting if a shoulder is sore)', rest: '30s rest', loads: [] },
  { region: 'core', sets: '3x12', name: 'Heel Taps', cue: 'Lower back stays flat', rest: '30s rest', loads: [] },
  { region: 'core', sets: '3x20s', name: 'Hollow Hold', cue: 'Arms by your sides, lower back pressed down', rest: '30s rest', loads: [] },
  { region: 'core', sets: '3x12 each side', name: 'Supine Marches', cue: 'Slow, brace the trunk', rest: '30s rest', loads: [] },
  { region: 'core', sets: '3x40s', name: 'Front Plank', cue: 'Flat back, brace', rest: '30s rest', loads: ['shoulder', 'wrist'] },
  { region: 'core', sets: '3x25s each side', name: 'Side Plank', cue: 'Hips stacked and lifted', rest: '30s rest', loads: ['shoulder', 'wrist'] },
  { region: 'core', sets: '3x10 each side', name: 'Pallof Press', cue: 'Resist the rotation', rest: '30s rest', loads: ['shoulder', 'grip'] },
  { region: 'core', sets: '3x8 each side', name: 'Bird Dog', cue: 'Opposite arm and leg, slow', rest: '30s rest', loads: ['shoulder', 'wrist'] },
];

/** How many exercises to take per region (before the closing stretch line). */
const MAX_PER_REGION: Record<Region, number> = { lower: 4, upper: 4, core: 3 };

/** Per-block duration (min) when a region is at full capacity; scaled by
 *  capacity. Full-body (lower+upper+core) ~= the 45min non-injured template. */
const BLOCK_MIN: Record<Region, number> = { lower: 18, upper: 15, core: 10 };

/** Submaximal RPE by phase. Acute kept lightest (fresh inflammation managed
 *  systemically even though only the unaffected region is loaded). Anchored to
 *  the existing gym.ts return/maintenance templates (RPE 3-5). */
export const RPE_BY_PHASE: Record<string, number> = {
  acute: 3,
  rehab: 4,
  test_capacity: 4,
  return_to_run: 4,
  graduated_return: 5,
};

const SHORT_LOCATION_LABEL: Record<InjuryLocation, string> = {
  foot: 'Foot', knee: 'Knee', calf: 'Calf', hamstring: 'Hamstring', hip: 'Hip',
  back: 'Back', shoulder: 'Shoulder', upper_arm: 'Upper-arm', elbow: 'Elbow',
  forearm: 'Forearm', wrist: 'Wrist', neck: 'Neck', chest_ribs: 'Chest/rib',
  other: 'General',
};

/** Trunk/spine locations where anti-rotation and plank core loading is itself
 *  contraindicated → the core region is dropped entirely. For limb injuries
 *  core work is safe (and the library is filtered for any incidental loading
 *  of the injured limb, e.g. wrist for a plank). */
const TRUNK_LOCATIONS: InjuryLocation[] = ['back', 'neck', 'chest_ribs'];

export type InjuryStrengthDecision =
  | { kind: 'normal' }
  | { kind: 'none'; reason: string }
  | { kind: 'adapted'; workout: Workout };

/**
 * Decide the strength prescription for an injured athlete. Region-aware,
 * exercise-level injury-aware, and phase-gated. The returned workout is a
 * single adapted session; callers that schedule multiple strength sessions
 * replicate it up to their session count.
 */
export function injuryStrengthDecision(
  injuryState: InjuryState | null | undefined,
): InjuryStrengthDecision {
  if (!injuryState?.active) return { kind: 'normal' };

  const phase = injuryState.injuryPhase;
  if (phase === 'resolved') return { kind: 'normal' };

  const loc = injuryState.location || 'other';
  const label = SHORT_LOCATION_LABEL[loc] ?? 'General';
  // Phrase for "the <X>" sentence positions. A specific location reads "the
  // knee"; an unspecified one reads "the injured area" (not "the general").
  const bodyPhrase = loc === 'other' ? 'injured area' : label.toLowerCase();
  const avoid = new Set<BodyArea>(LOCATION_AVOID[loc] ?? []);
  const safe = (ex: Exercise) => ex.loads.every(a => !avoid.has(a));

  const { upper, lower } = bodyRegionLoadability(injuryState);
  const upperOK = upper > 0;
  const lowerOK = lower > 0;
  const trunkSafe = !TRUNK_LOCATIONS.includes(loc);

  // Pick the first N injury-safe exercises in each loadable region. A
  // region's exercise count follows its capacity the way its block minutes do
  // (BLOCK_MIN x capacity, below), so the list a card shows matches its
  // length: round(MAX_PER_REGION x capacity), at least one while the region is
  // loadable. Core is not capacity-scaled (its block is whole).
  const pick = (region: Region, capOK: boolean, capPct = 100): Exercise[] =>
    capOK
      ? LIBRARY.filter(e => e.region === region && safe(e))
          .slice(0, Math.max(1, Math.round(MAX_PER_REGION[region] * (capPct / 100))))
      : [];

  const lowerEx = pick('lower', lowerOK, lower);
  const upperEx = pick('upper', upperOK, upper);
  const coreEx = pick('core', trunkSafe && (upperOK || lowerOK));

  const selected = [...lowerEx, ...upperEx, ...coreEx];
  if (selected.length === 0) {
    return {
      kind: 'none',
      reason: `${label} injury. Loaded strength paused; follow the rehab protocol and mobility work.`,
    };
  }

  // Duration scales with region capacity (TSS follows downstream).
  let durationMin = 0;
  const regionLabels: string[] = [];
  if (lowerEx.length) { durationMin += Math.round(BLOCK_MIN.lower * (lower / 100)); regionLabels.push('lower-body'); }
  if (upperEx.length) { durationMin += Math.round(BLOCK_MIN.upper * (upper / 100)); regionLabels.push('upper-body'); }
  if (coreEx.length)  { durationMin += BLOCK_MIN.core; regionLabels.push('core'); }

  const lines = selected.map(e => `${e.sets} ${e.name} (${e.cue}) (${e.rest})`);
  lines.push(`Stretch to finish: gentle range, nothing that aggravates the ${bodyPhrase}.`);

  const rpe = RPE_BY_PHASE[phase] ?? 4;
  const name = capitaliseFirst(`${joinRegions(regionLabels)} strength`);
  const reason = buildReason(label, bodyPhrase, upperEx.length > 0, lowerEx.length > 0);

  const workout: Workout = {
    t: 'gym',
    n: name,
    d: lines.join('\n'),
    r: rpe,
    rpe,
    estimatedDurationMin: Math.max(10, durationMin),
    modReason: reason,
  } as Workout;

  return { kind: 'adapted', workout };
}

/** "lower-body & core" / "upper-body, lower-body & core". */
function joinRegions(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} & ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

function buildReason(label: string, bodyPhrase: string, upperOK: boolean, lowerOK: boolean): string {
  if (upperOK && !lowerOK) {
    return `${label} injury. Upper-body and core only, with shoulder-safe exercises; lower-body loading paused while it settles.`;
  }
  if (lowerOK && !upperOK) {
    return `${label} injury. Lower-body and core only, picked to avoid loading the ${bodyPhrase}; upper-body loading paused while it settles.`;
  }
  return `${label} injury. Exercises picked to avoid loading the ${bodyPhrase}.`;
}

function capitaliseFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
