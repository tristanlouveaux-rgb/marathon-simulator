/**
 * Aggregate the various tri-side trigger detectors into a single stream of
 * proposed plan modifications that the suggestion modal can present.
 *
 * Each detector returns its own shape (`VolumeRampViolation`, `RpeFlag`, …);
 * this module flattens them into a uniform `TriSuggestionMod` so the UI can
 * render them as a checkable list.
 *
 * **Side of the line**: planning. Pure read-only function; no state mutation.
 * The modal applies accepted mods through a separate apply step.
 */

import type { SimulatorState, Workout } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { checkVolumeRamp, type VolumeRampViolation } from './tri-volume-ramp';
import { detectRpeBlownSession, type RpeFlag } from './tri-rpe-flag';
import { computeTriReadiness } from './tri-readiness';
import {
  detectCrossTrainingOverload,
  type CrossTrainingOverloadResult,
} from './tri-cross-training-overload';

/** A single proposed modification surfaced to the user. */
export interface TriSuggestionMod {
  /** Stable id so the modal can track checkbox state. */
  id: string;
  /** What kind of trigger fired this proposal. */
  source: 'volume_ramp' | 'rpe_blown' | 'readiness' | 'cross_training_overload';
  /** Discipline the mod applies to (ramp violations are per-discipline; some
   *  triggers don't have a single discipline → 'all'). */
  discipline: Discipline | 'all';
  /** One-line headline for the row ("Bike volume +30% — propose trim"). */
  headline: string;
  /** Slightly longer body ("Next week's planned bike hours exceed this week's
   *  actual by 30%. Trim by ~1.5h to match Gabbett 5–10% ramp"). */
  body: string;
  /** Severity for visual treatment: amber (caution) / red (warning). */
  severity: 'caution' | 'warning';
  /** Specific workout this mod targets (if applicable). The apply step uses
   *  this to mutate `state.wks[*].triWorkouts`. */
  targetWorkoutId?: string;
  /** What action to take if accepted. The aggregator only describes — the
   *  apply step performs the mutation. */
  action: 'trim_volume' | 'downgrade_today' | 'swap_easy';
  /** Cross-training overload mods carry the full per-discipline option set so
   *  the modal can render a chip switcher (swim/bike/run) and Reduce / Replace
   *  & Reduce / Keep / Push-to-next-week buttons. The modal reads this directly;
   *  `targetWorkoutId`/`action` on the mod itself act as placeholders pointing
   *  at the recommended discipline's first proposed mod (used as a fallback if
   *  the modal is rendered in the legacy generic-list layout). */
  overloadOptions?: CrossTrainingOverloadResult;
}

export interface TriSuggestionBundle {
  mods: TriSuggestionMod[];
  /** Useful for diagnostics: which detectors fired / didn't. */
  diagnostics: {
    rampViolations: number;
    rpeBlown: boolean;
    readinessLabel: string | null;
    crossTrainingOverload: boolean;
  };
}

export function collectTriSuggestions(state: SimulatorState): TriSuggestionBundle {
  const mods: TriSuggestionMod[] = [];

  // ── Volume-ramp violations (one per discipline that exceeds 10% cap) ────
  const ramps: VolumeRampViolation[] = checkVolumeRamp(state);
  for (const v of ramps) {
    const nextWk = (state.wks ?? [])[(state.w ?? 0) + 1];
    const targetWorkout = nextWk?.triWorkouts?.find(
      w => (w.discipline ?? 'run') === v.discipline && isLongOrEndurance(w),
    );
    mods.push({
      id: `ramp_${v.discipline}`,
      source: 'volume_ramp',
      discipline: v.discipline,
      headline: `Next week's ${v.discipline} volume exceeds the safe ramp`,
      body: `${v.discipline} planned at ${v.nextWeekPlannedHours}h vs this week's actual ${v.thisWeekActualHours}h (+${Math.round(v.rampPct * 100)}%). Suggest trimming by ~${v.excessHours}h to match the 10% Gabbett ramp.`,
      severity: v.rampPct > 0.20 ? 'warning' : 'caution',
      targetWorkoutId: targetWorkout?.id,
      action: 'trim_volume',
    });
  }

  // ── RPE-flagged blown session ────────────────────────────────────────────
  const rpe: RpeFlag | null = detectRpeBlownSession(state);
  if (rpe) {
    const expected = rpe.yesterdayExpectedRpe;
    const actual = rpe.yesterdayActualRpe;
    const todayLabel = rpe.todayWorkout.n || rpe.todayWorkout.t;
    mods.push({
      id: `rpe_${rpe.todayWorkout.id ?? 'today'}`,
      source: 'rpe_blown',
      discipline: (rpe.todayWorkout.discipline ?? 'run') as Discipline,
      headline: `Yesterday's session ran hot — consider easing today`,
      body: `Yesterday hit ${actual}/10 RPE vs the planned ${expected}/10. Today's ${todayLabel} is a quality session — swap for an easy session to absorb that load.`,
      severity: 'caution',
      targetWorkoutId: rpe.todayWorkout.id,
      action: 'swap_easy',
    });
  }

  // ── Readiness gate (poor sleep/HRV + today is a quality session) ────────
  const readiness = computeTriReadiness(state);
  let readinessLabel: string | null = null;
  if (readiness) {
    readinessLabel = readiness.overall;
    if (readiness.overall === 'Manage Load' || readiness.overall === 'Ease Back' || readiness.overall === 'Overreaching') {
      // Find today's planned workout — quality only.
      const todayDow = (new Date().getDay() + 6) % 7;
      const wk = (state.wks ?? [])[state.w ?? 0];
      const todayWorkout = wk?.triWorkouts?.find(w => w.dayOfWeek === todayDow && w.status !== 'skipped');
      if (todayWorkout && isQuality(todayWorkout)) {
        const sentence = readiness.sentence;
        mods.push({
          id: `readiness_${todayWorkout.id ?? 'today'}`,
          source: 'readiness',
          discipline: (todayWorkout.discipline ?? 'run') as Discipline,
          headline: `Recovery is ${readiness.overall.toLowerCase()} — consider downgrading today`,
          body: `${sentence} Today's ${todayWorkout.n || todayWorkout.t} is a quality session — swap for an easy session.`,
          severity: readiness.overall === 'Overreaching' ? 'warning' : 'caution',
          targetWorkoutId: todayWorkout.id,
          action: readiness.overall === 'Overreaching' ? 'swap_easy' : 'downgrade_today',
        });
      }
    }
  }

  // ── Cross-training overload (extra non-tri TSS pushed week over plan) ───
  const overload: CrossTrainingOverloadResult | null = detectCrossTrainingOverload(state);
  if (overload) {
    const overshootPct = Math.round(overload.overshootPct * 100);
    const recDiscipline = overload.recommendedDiscipline;
    const recOpt = overload.options[recDiscipline];
    const firstMod = recOpt.reduceMods[0]; // placeholder fallback; modal reads overloadOptions directly
    // Map detector's severity vocabulary (heavy/extreme) to the aggregator's
    // existing severity vocabulary (caution/warning) — the modal keys its
    // banner/colour styling off the latter.
    const severity: 'caution' | 'warning' = overload.severity === 'extreme' ? 'warning' : 'caution';
    mods.push({
      id: `xt_overload_${overload.recommendedDiscipline}`,
      source: 'cross_training_overload',
      discipline: recDiscipline,
      headline: `Cross-training added ${overload.crossTrainingTSS} TSS this week — consider easing your ${recDiscipline}`,
      body: `Your tri plan is ${overload.plannedTriTSS} TSS this week. Cross-training has added ${overload.crossTrainingTSS} TSS on top (+${overshootPct}%). ${recDiscipline.charAt(0).toUpperCase() + recDiscipline.slice(1)} has the most remaining planned load — start there, or flip to swim/run via the chip switcher.`,
      severity,
      // Placeholder values — the modal reads `overloadOptions` and commits the
      // full per-discipline mod array, not this single workout. Kept as a
      // graceful fallback if the modal renders the generic-list layout.
      targetWorkoutId: firstMod?.workoutId,
      action: firstMod?.action ?? 'trim_volume',
      overloadOptions: overload,
    });
  }

  return {
    mods,
    diagnostics: {
      rampViolations: ramps.length,
      rpeBlown: !!rpe,
      readinessLabel,
      crossTrainingOverload: !!overload,
    },
  };
}

// ─── Heuristics ────────────────────────────────────────────────────────────

const QUALITY_KEYWORDS = ['threshold', 'vo2', 'tempo', 'sweet_spot', 'sweetspot', 'speed', 'race_pace', 'intervals', 'hills', 'brick'];
const LONG_KEYWORDS = ['long', 'endurance'];

function isQuality(workout: Workout): boolean {
  const t = (workout.t ?? '').toLowerCase();
  return QUALITY_KEYWORDS.some(k => t.includes(k));
}

function isLongOrEndurance(workout: Workout): boolean {
  const t = (workout.t ?? '').toLowerCase();
  return LONG_KEYWORDS.some(k => t.includes(k));
}
