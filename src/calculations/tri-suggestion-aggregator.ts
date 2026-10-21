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
import { handledTriSuggestionIds, isOpenForTriSuggestion } from './tri-suggestion-handled';
import { canApplyTriSuggestion, isTriQualitySession } from './tri-suggestion-apply';

/**
 * Volume-ramp suggestions are OFF pending Tristan's decision on the comparison
 * window. checkVolumeRamp compares the current week's actuals SO FAR with next
 * week's full plan, so mid-week it fires on a partial week (an Ironman week with
 * one 1 h ride logged proposes trimming next week's long ride on every launch).
 * The plan's own deload-to-build steps also exceed the 10% cap with full
 * adherence. The two candidate gates (evaluate only once the current week is
 * complete, or compare the last completed week's actuals with the current
 * week's plan) need his call. The detector, its trim target and the notify-once
 * stamp stay wired and tested behind `opts.volumeRamp`.
 */
export const TRI_VOLUME_RAMP_SUGGESTIONS_LIVE = false;

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
  /** Ids of rows merged into this one because they targeted the same session
   *  (oneRowPerSession). Answering this row answers them too, so a declined
   *  swap does not come back as a separate downgrade row the same week. */
  alsoAnswers?: string[];
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

export interface CollectTriSuggestionsOptions {
  /** Evaluate the volume-ramp detector. Defaults to
   *  TRI_VOLUME_RAMP_SUGGESTIONS_LIVE (off); tests switch it on. */
  volumeRamp?: boolean;
}

export function collectTriSuggestions(
  state: SimulatorState,
  opts: CollectTriSuggestionsOptions = {},
): TriSuggestionBundle {
  const mods: TriSuggestionMod[] = [];

  // ── Volume-ramp violations (one per discipline that exceeds 10% cap) ────
  // s.w is 1-based (store.ts default w: 1): the current week is wks[s.w - 1]
  // and next week is wks[s.w].
  const curIdx = (state.w ?? 1) - 1;
  const rampOn = opts.volumeRamp ?? TRI_VOLUME_RAMP_SUGGESTIONS_LIVE;
  const ramps: VolumeRampViolation[] = rampOn ? checkVolumeRamp(state) : [];
  for (const v of ramps) {
    const nextWk = (state.wks ?? [])[curIdx + 1];
    // A session an earlier trim (or any other change) already touched is not a
    // target: trimming it again compounds 15% per launch (87 -> 74 -> 63 min).
    const targetWorkout = nextWk?.triWorkouts?.find(
      w => (w.discipline ?? 'run') === v.discipline && isLongOrEndurance(w) && isOpenForTriSuggestion(w),
    );
    // Nothing left to trim in that discipline: no proposal (accepting it would
    // change nothing).
    if (!targetWorkout?.id) continue;
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
  // Proposed only when the swap would change today's session
  // (canApplyTriSuggestion): a brick or an off-ladder kind is left untouched by
  // the apply step, so a row for it would promise a change that never happens.
  if (rpe && canApplyTriSuggestion(rpe.todayWorkout, 'swap_easy')) {
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
      // Find today's planned workout. Quality only.
      const todayDow = (new Date().getDay() + 6) % 7;
      const wk = (state.wks ?? [])[curIdx];
      // A session already changed (an accepted downgrade or swap, an Adjust),
      // done or dropped is not proposed again: re-proposing stepped a bike
      // threshold down a rung per launch (threshold, sweet spot, tempo, endurance).
      const todayWorkout = wk?.triWorkouts?.find(w => w.dayOfWeek === todayDow && isOpenForTriSuggestion(w));
      const action = readiness.overall === 'Overreaching' ? 'swap_easy' : 'downgrade_today';
      // Quality by the shared classifier (isTriQualitySession), which counts
      // every off-ladder kind the gate lands a downgrade for: over-unders and
      // open-water swims match no type keyword. Proposed only when the apply
      // step would change the session (canApplyTriSuggestion): never a brick;
      // an off-ladder kind takes a downgrade (OFF_LADDER_DOWNGRADE_RUNG) but no
      // swap, and a neuromuscular sprint neither (sweet spot would add load).
      if (todayWorkout && isTriQualitySession(todayWorkout) && canApplyTriSuggestion(todayWorkout, action)) {
        const sentence = readiness.sentence;
        mods.push({
          id: `readiness_${todayWorkout.id ?? 'today'}`,
          source: 'readiness',
          discipline: (todayWorkout.discipline ?? 'run') as Discipline,
          headline: `Recovery is ${readiness.overall.toLowerCase()} — consider downgrading today`,
          body: `${sentence} Today's ${todayWorkout.n || todayWorkout.t} is a quality session — swap for an easy session.`,
          severity: readiness.overall === 'Overreaching' ? 'warning' : 'caution',
          targetWorkoutId: todayWorkout.id,
          action,
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
    // Placeholder fallback; the modal reads overloadOptions directly. The
    // recommended option holds a change in one of its two sets.
    const firstMod = recOpt.reduceMods[0] ?? recOpt.replaceMods[0];
    // Map detector's severity vocabulary (heavy/extreme) to the aggregator's
    // existing severity vocabulary (caution/warning). The modal keys its
    // banner/colour styling off the latter.
    const severity: 'caution' | 'warning' = overload.severity === 'extreme' ? 'warning' : 'caution';
    mods.push({
      id: `xt_overload_${overload.recommendedDiscipline}`,
      source: 'cross_training_overload',
      discipline: recDiscipline,
      headline: `Cross-training added ${overload.crossTrainingTSS} TSS this week — consider easing your ${recDiscipline}`,
      body: `Your tri plan is ${overload.plannedTriTSS} TSS this week. Cross-training has added ${overload.crossTrainingTSS} TSS on top (+${overshootPct}%). ${recDiscipline.charAt(0).toUpperCase() + recDiscipline.slice(1)} has the most remaining planned load — start there, or flip to swim/run via the chip switcher.`,
      severity,
      // Placeholder values. The modal reads `overloadOptions` and commits the
      // full per-discipline mod array, not this single workout. Kept as a
      // graceful fallback if the modal renders the generic-list layout.
      targetWorkoutId: firstMod?.workoutId,
      action: firstMod?.action ?? 'trim_volume',
      overloadOptions: overload,
    });
  }

  // Notify-once: proposals the user already answered this week (ticked, left
  // unticked or dismissed in the modal) are not proposed again until the week
  // rolls over. Cross-training overload keeps its own record instead
  // (Week.triSuggestionsHandled.crossTrainingTSS): the detector counts only
  // cross-training the user has not answered yet.
  const handled = handledTriSuggestionIds(state);
  const open = oneRowPerSession(
    mods.filter(m => m.source === 'cross_training_overload' || !handled.has(m.id)),
  );

  return {
    mods: open,
    diagnostics: {
      rampViolations: ramps.length,
      rpeBlown: !!rpe,
      readinessLabel,
      crossTrainingOverload: !!overload,
    },
  };
}

/**
 * Every proposal id a set of shown rows answers: each row's own id plus the ids
 * merged into it (alsoAnswers). The modal records these as handled.
 */
export function answeredModIds(mods: TriSuggestionMod[]): string[] {
  return mods.flatMap(m => [m.id, ...(m.alsoAnswers ?? [])]);
}

// ─── One row per session ─────────────────────────────────────────────────────
// The RPE-blown and readiness detectors both pick today's first open session, so
// when both fire they propose two changes to one session, both ticked by default.
// Applying both stepped the session twice. Keep one row per target session: the
// stronger action (a swap to easy over a one-rung downgrade over a trim), then the
// higher severity, then the earlier row. The dropped row's id rides along in
// alsoAnswers. applyTriSuggestions also applies at most one mod per session per
// batch, as the backstop. Overload rows carry their own per-discipline option
// set and are left as they are.

const ACTION_STRENGTH: Record<TriSuggestionMod['action'], number> = {
  swap_easy: 2,
  downgrade_today: 1,
  trim_volume: 0,
};
const SEVERITY_STRENGTH: Record<TriSuggestionMod['severity'], number> = {
  warning: 1,
  caution: 0,
};

function strongerRow(a: TriSuggestionMod, b: TriSuggestionMod): boolean {
  const byAction = ACTION_STRENGTH[a.action] - ACTION_STRENGTH[b.action];
  if (byAction !== 0) return byAction > 0;
  return SEVERITY_STRENGTH[a.severity] > SEVERITY_STRENGTH[b.severity];
}

function oneRowPerSession(mods: TriSuggestionMod[]): TriSuggestionMod[] {
  const out: TriSuggestionMod[] = [];
  const slotOfTarget = new Map<string, number>();
  for (const m of mods) {
    const target = m.source === 'cross_training_overload' ? undefined : m.targetWorkoutId;
    if (!target) { out.push(m); continue; }
    const slot = slotOfTarget.get(target);
    if (slot == null) { slotOfTarget.set(target, out.length); out.push(m); continue; }
    const kept = out[slot];
    const [winner, loser] = strongerRow(m, kept) ? [m, kept] : [kept, m];
    out[slot] = { ...winner, alsoAnswers: [...(winner.alsoAnswers ?? []), ...answeredModIds([loser])] };
  }
  return out;
}

// ─── Heuristics ────────────────────────────────────────────────────────────

// Quality: isTriQualitySession (tri-suggestion-apply.ts), shared with the
// cross-training overload builders and read from the same table as the gate.
const LONG_KEYWORDS = ['long', 'endurance'];

function isLongOrEndurance(workout: Workout): boolean {
  const t = (workout.t ?? '').toLowerCase();
  return LONG_KEYWORDS.some(k => t.includes(k));
}
