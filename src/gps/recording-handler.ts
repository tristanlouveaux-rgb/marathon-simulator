/**
 * Bridges a completed GPS recording to workout completion.
 * Shows the completion modal and calls rate() when the user confirms.
 */

import { planTrainingWeeks } from '@/workouts/race-week-layout';
import type { GpsRecording, Week, Workout } from '@/types';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state';
import { rate } from '@/ui/events';
import { render } from '@/ui/renderer';
import { openGpsCompletionModal, type CompletionData } from '@/ui/gps-completion-modal';
import { deleteGpsRecording } from '@/gps/persistence';
import { isLongRun } from '@/workouts/long-run';
import { computeACWR, computeRunningFloorKm } from '@/calculations/fitness-model';
import { resolveWeekWorkouts, resolveWeekForPlanChanges } from '@/ui/week-resolve';
import { writeAdjustmentMods, adjustableWorkouts } from '@/workouts/workout-mods';
import { parseDistanceKm } from '@/calculations/matching';
import { createActivity, buildCrossTrainingPopup, workoutsToPlannedRuns, applyAdjustments } from '@/cross-training';
import { showSuggestionModal } from '@/ui/suggestion-modal';
import { buildGpsRunActual, writeInAppActual, isPlanCardRunType } from '@/calculations/in-app-activity';
import { resolveTriWeekWorkouts } from '@/ui/triathlon/week-resolve.triathlon';
import { reconcileTriCompletions } from '@/calculations/activity-matcher.triathlon';
import { noteRatingSource } from '@/calculations/athlete-rating';

/**
 * Handle a completed GPS recording: find the matching workout,
 * show the completion modal, and complete the workout on user confirm.
 *
 * Matched by name  → rate() is called → VDOT/effort score updated.
 * Impromptu run    → try smarter match (distance + day) against unrated
 *                    planned runs → offer assignment if match found.
 *                    If no match or user declines → save as adhoc and run
 *                    the load through the cross-training suggestion pipeline
 *                    so the plan can be adjusted accordingly.
 *
 * Every branch also stores the recording as an activity (`recordGpsActual`),
 * so the run carries its load into every signal exactly once (audit B9). The
 * exception is a recording started from a non-run card (injury cross-training
 * or rehab strength): it keeps the rating only, like Mark as Done there.
 *
 * Triathlon, cycling and HYROX (isMultiSportPlan): the cards are the run
 * sessions of wk.triWorkouts, not the running engine's week, which these modes
 * show nowhere. The run completes the card it was started from, keyed by the
 * card's own slot key, with the rating written as those modes write it (a
 * completion flag, never events.ts rate(), which moves running VDOT). With the
 * record under the slot key, the tri matcher direct-binds it and the watch copy
 * supersedes it in place, so the card stays done when the synced run arrives.
 */
export function handleCompletedRecording(recording: GpsRecording, workoutName: string): void {
  const s = getState();
  const multiSport = isMultiSportPlan(s);

  // Try to find a matching scheduled workout by name (normal GPS-from-workout-card flow)
  let workout: Workout | null = null;
  let workoutId = '';
  let weekWorkouts: Workout[] = [];

  // Track-only users have no planned workouts to match against. Go straight
  // to the adhoc-save path. Skipping the generateWeekWorkouts call also avoids
  // passing stale defaults (s.rd='half', s.v=50) into the generator.
  if (!s.trackOnly && s.w >= 1 && s.w <= s.wks.length) {
    if (multiSport) {
      // The run sessions of this week as the tri/HYROX plan view shows them.
      weekWorkouts = multiSportRunSessions(s);
      const matched = findStartedMultiSportCard(weekWorkouts, workoutName, s.wks[s.w - 1]?.rated ?? {});
      if (matched) {
        workout = matched;
        workoutId = matched.id ?? matched.n;
      }
    } else {
      // The week as the Plan tab shows it (canonical resolver): the cards the run
      // was started from, with every accepted change applied, so a cut or replaced
      // session is seen as cut or replaced by the matcher below.
      weekWorkouts = resolveWeekWorkouts(s, s.w) as Workout[];
      const matched = weekWorkouts.find(w => w.n === workoutName);
      if (matched) {
        workout = matched;
        workoutId = matched.id || matched.n;
      }
    }
  }

  const completionData: CompletionData = {
    recording,
    workout,
    workoutId,
    isSkipped: false,
  };

  openGpsCompletionModal(
    completionData,
    // onComplete
    (rpe: number) => {
      if (workout && multiSport) {
        // Tri/HYROX card: complete that slot (no running VDOT rating).
        const ms = getMutableState();
        const week = ms.wks[ms.w - 1];
        if (week) {
          completeMultiSportRunSlot(week, workoutId, workout, recording, rpe);
          saveState();
        }
        render();
      } else if (workout) {
        // Name-matched scheduled workout: rate it and link the recording
        rate(workoutId, workout.n, rpe, workout.rpe || workout.r, workout.t, false);
        const ms = getMutableState();
        const week = ms.wks[ms.w - 1];
        if (week) {
          if (!week.gpsRecordings) week.gpsRecordings = {};
          week.gpsRecordings[workoutId] = recording.id;
          // A run record on a non-run card (injury cross-training, rehab
          // strength) would read as running in Signal A. Those cards keep the
          // rating only, as Mark as Done does (recordPlannedRunDone).
          if (isPlanCardRunType(workout.t)) {
            recordGpsActual(week, workoutId, recording, rpe, workout.n, { workoutName: workout.n, plannedType: workout.t });
          }
          saveState();
        }
        render();
      } else if (s.w >= 1 && s.w <= s.wks.length) {
        handleImpromptuRun(recording, workoutName, rpe, weekWorkouts, multiSport);
      } else {
        render();
      }
    },
    // onDiscard
    () => {
      deleteGpsRecording(recording.id);
      render();
    },
  );
}

/**
 * Handle an impromptu GPS run (not started from a workout card).
 * 1. Try to match to an unrated planned run by distance (± 30%) and pace type.
 *    Day-of-week is intentionally ignored. The run could have been done on any day.
 * 2. If match found → offer assignment to that workout.
 * 3. Otherwise → save as adhoc and run load through suggestion pipeline.
 *
 * Triathlon, cycling and HYROX (`multiSport`): the candidates are the week's
 * tri/HYROX run sessions, an assigned run completes that slot as a card start
 * does (completeMultiSportRunSlot), and an extra run never reaches the running
 * suggestion pipeline (these modes have no running plan to change). Triathlon
 * offers its own suggestion pipeline instead; HYROX logs the run.
 */
function handleImpromptuRun(
  recording: GpsRecording,
  workoutName: string,
  rpe: number,
  weekWorkouts: Workout[],
  multiSport = false,
): void {
  const ms = getMutableState();
  const week = ms.wks[ms.w - 1];
  if (!week) { render(); return; }

  const distKm = recording.totalDistance / 1000;
  const durationMin = recording.totalElapsed / 60;

  // Filter to unrated, non-replaced planned runs (weekWorkouts is resolved, so a
  // replaced session carries status 'replaced'). In tri/HYROX 'replaced' marks a
  // session swapped to an easier one that is still to be done (planned-day-tss.ts),
  // and a session the matcher completed carries status 'completed' or a record at
  // its key without a rating, so those are the done checks there.
  const unratedRuns = weekWorkouts.filter(w => {
    const wid = w.id || w.n;
    if (multiSport) {
      if (w.status === 'completed' || w.status === 'skipped' || week.garminActuals?.[wid]) return false;
    } else if (w.status === 'replaced') {
      return false;
    }
    return week.rated[wid] == null && week.rated[w.n] == null;
  });

  // Match by distance proximity only. Day-of-week does not matter for impromptu runs.
  // Pick the planned run whose distance is closest to the recorded distance, within ±30%.
  // Optionally tiebreak by pace plausibility: if we have average pace, prefer a workout
  // type whose intensity aligns (e.g. avoid matching a slow easy-pace run to an interval session).
  const matchResult = findRunByDistance(distKm, recording.averagePace, unratedRuns, ms.pac);

  const saveAsAdhoc = () => {
    if (!week.adhocWorkouts) week.adhocWorkouts = [];
    // Remove any no-id placeholder with the same name (added by justRun() before GPS completed)
    week.adhocWorkouts = week.adhocWorkouts.filter(w => !(w.n === workoutName && !w.id));
    const adhocWo: Workout = {
      n: workoutName,
      d: `${distKm.toFixed(1)}km`,
      r: 5,
      t: 'easy',
      id: recording.id,
    };
    if (!week.adhocWorkouts.find(w => w.id === recording.id)) {
      week.adhocWorkouts.push(adhocWo);
    }
    if (!week.gpsRecordings) week.gpsRecordings = {};
    week.gpsRecordings[recording.id] = recording.id;
    if (multiSport) {
      // Tri/HYROX ratings are completion flags; rate() would move running VDOT.
      week.rated[recording.id] = rpe;
      noteRatingSource(week, recording.id, 'user');
    } else {
      // Rate the adhoc entry so it counts toward completedKm and effort
      rate(recording.id, workoutName, rpe, 5, 'easy', false);
    }
    // The activity record under the adhoc's own id: Signal B skips an adhoc
    // whose id has a garminActuals entry, so the run counts once, at its
    // measured duration instead of the old flat 30-minute default.
    recordGpsActual(week, recording.id, recording, rpe, workoutName);
  };

  const runLoadLogic = () => {
    saveAsAdhoc();
    saveState();

    if (multiSport) {
      // No running plan to change. Triathlon/cycling: the tri suggestion
      // pipeline reads the logged run (steps 2 and 3 of activity-review's
      // redirectToTriSuggestionFlow). HYROX: logged only.
      render();
      if (ms.eventType === 'triathlon') void offerTriSuggestions();
      return;
    }

    // Build a CrossActivity from the run so the suggestion pipeline can assess
    // how much extra load this adds and offer plan adjustments
    const activity = createActivity('extra_run', durationMin, rpe, undefined, undefined, ms.w);

    // The change is sized from and written against the plan-layers week: existing
    // changes (and their re-priced loads) applied, the illness/holiday/bridge render
    // layers left out so their output is never baked into a mod. Sessions the user
    // scaled by hand, or that a holiday or illness rest day stands down, are not offered.
    const planWeek = resolveWeekForPlanChanges(ms, ms.w) as Workout[];
    const plannedRuns = workoutsToPlannedRuns(adjustableWorkouts(planWeek), ms.pac);
    const _tier = ms.athleteTierOverride ?? ms.athleteTier;
    const _atlSeed = (ms.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (ms.gs ?? 0), 0.3));
    const _acwr = computeACWR(ms.wks, ms.w, _tier, ms.ctlBaseline ?? undefined, ms.planStartDate, _atlSeed, ms.signalBBaseline ?? undefined, undefined, (ms as any).previousPlanWks, ms.adaptiveRecovery);
    const _floorKm = computeRunningFloorKm(ms.pac?.m, ms.w, (planTrainingWeeks(ms) || 16), week?.ph);
    const popup = buildCrossTrainingPopup(
      {
        raceGoal: ms.rd,
        plannedRunsPerWeek: ms.rw,
        injuryMode: !!(ms as any).injuryState?.active,
        runnerType: ms.typ as 'Speed' | 'Endurance' | 'Balanced' | undefined,
        floorKm: _floorKm,
        acwrStatus: _acwr.status,
      },
      plannedRuns,
      activity,
      undefined,
    );

    const hasAdjustments =
      popup.reduceOutcome.adjustments.length > 0 ||
      popup.replaceOutcome.adjustments.length > 0;

    if (hasAdjustments) {
      showSuggestionModal(popup, 'run', (decision) => {
        if (decision && decision.choice !== 'keep' && decision.adjustments.length > 0) {
          const modifiedWorkouts = applyAdjustments(planWeek, decision.adjustments, 'run', ms.pac);
          writeAdjustmentMods(week, modifiedWorkouts, decision.adjustments, `GPS: ${workoutName}`);
        }
        saveState();
        render();
      });
    } else {
      render();
    }
  };

  if (matchResult) {
    const matchId = matchResult.id || matchResult.n;
    showMatchConfirm(matchResult.n, distKm).then(confirmed => {
      if (confirmed && multiSport) {
        completeMultiSportRunSlot(week, matchId, matchResult, recording, rpe);
        saveState();
        render();
      } else if (confirmed) {
        // Assign the GPS run to the matched planned workout
        if (!week.gpsRecordings) week.gpsRecordings = {};
        week.gpsRecordings[matchId] = recording.id;
        recordGpsActual(week, matchId, recording, rpe, matchResult.n, { workoutName: matchResult.n, plannedType: matchResult.t });
        saveState();
        rate(matchId, matchResult.n, rpe, matchResult.rpe ?? matchResult.r, matchResult.t, false);
        render();
      } else {
        runLoadLogic();
      }
    });
  } else {
    runLoadLogic();
  }
}

/** Triathlon, cycling (eventType 'triathlon') and HYROX: the plan is wk.triWorkouts. */
function isMultiSportPlan(s: { trackOnly?: boolean; eventType?: string }): boolean {
  return !s.trackOnly && (s.eventType === 'triathlon' || s.eventType === 'hyrox');
}

/**
 * The current week's tri/cycling/HYROX run sessions as the plan view shows them
 * (resolveTriWeekWorkouts, cloned): the cards a GPS run can be started from.
 */
function multiSportRunSessions(s: ReturnType<typeof getState>): Workout[] {
  return resolveTriWeekWorkouts(s, s.w).filter(w => w.discipline === 'run');
}

/**
 * The card a GPS run was started from: the run session with that name. Names
 * repeat (two HYROX "Easy Run"s, two tri "Easy run"s), so an unrated one is
 * preferred, today's first.
 */
function findStartedMultiSportCard(
  runs: Workout[],
  name: string,
  rated: Record<string, number | 'skip'>,
): Workout | null {
  const named = runs.filter(w => w.n === name);
  if (named.length === 0) return null;
  const jsDay = new Date().getDay();
  const today = jsDay === 0 ? 6 : jsDay - 1;
  const unrated = named.filter(w => rated[w.id ?? w.n] == null);
  return unrated.find(w => w.dayOfWeek === today)
    ?? unrated[0]
    ?? named.find(w => w.dayOfWeek === today)
    ?? named[0];
}

/**
 * Complete a tri/cycling/HYROX run session with a GPS recording. Tracking side.
 * The rating is the completion flag those modes write (triathlon setRated,
 * HYROX setHxRated), never events.ts rate(), which feeds running VDOT through
 * rpeAdj and IMP[s.rd]. The record sits under the slot key, so the tri matcher
 * direct-binds it (reconcileTriCompletions, run here so the card and the tri
 * fitness feed see it now) and a synced watch copy supersedes it in place
 * (matchAndAutoComplete), keeping the slot completed.
 */
function completeMultiSportRunSlot(
  week: Week,
  key: string,
  slot: Workout,
  recording: GpsRecording,
  rpe: number,
): void {
  if (!week.rated) week.rated = {};
  week.rated[key] = rpe;
  noteRatingSource(week, key, 'user');
  if (!week.gpsRecordings) week.gpsRecordings = {};
  week.gpsRecordings[key] = recording.id;
  recordGpsActual(week, key, recording, rpe, slot.n, { workoutName: slot.n, plannedType: slot.t });
  if (getState().eventType === 'triathlon') reconcileTriCompletions(week);
}

/**
 * Triathlon/cycling extra run: the tri suggestion aggregator reads the logged
 * run (its cross-training and volume detectors) and the tri modal offers any
 * change, as activity-review does for synced overflow.
 */
async function offerTriSuggestions(): Promise<void> {
  const { collectTriSuggestions } = await import('@/calculations/tri-suggestion-aggregator');
  const bundle = collectTriSuggestions(getState());
  if (bundle.mods.length === 0) return;
  const { showTriSuggestionModal } = await import('@/ui/triathlon/tri-suggestion-modal');
  await showTriSuggestionModal(bundle);
  render();
}

/**
 * Store a finished GPS recording as the activity behind `key` (a plan slot id,
 * or the adhoc id for an impromptu run). Tracking side: the record carries the
 * recording's own start, elapsed time and distance at the RPE the user just
 * rated, so Signal A, weekly and daily Signal B and the rolling ACWR all count
 * it once. A synced actual already at the key (the watch got there first) is
 * kept. When the watch copy arrives later it supersedes this record in place
 * (matchAndAutoComplete, in-app-activity.ts). `slot` is the planned workout the
 * run completed; an impromptu run outside the plan passes none.
 */
function recordGpsActual(
  week: Week,
  key: string,
  recording: GpsRecording,
  rpe: number,
  name: string,
  slot?: { workoutName: string; plannedType?: string | null },
): void {
  writeInAppActual(week, key, buildGpsRunActual(recording, { rpe, name, slot }));
}

// Run types whose intensity is "quality" (not easy/long)
const QUALITY_RUN_TYPES = new Set(['threshold', 'vo2', 'intervals', 'race_pace', 'mixed', 'progressive', 'hill_repeats', 'float']);

/**
 * Find the best planned run to match an impromptu recording.
 * Matching is by distance only (± 30%). Day-of-week is ignored.
 * When two candidates are equidistant, prefer the one whose type
 * aligns with the observed average pace:
 *   - pace > easyPace * 0.97  →  prefer easy/long workouts
 *   - pace < easyPace * 0.85  →  prefer quality workouts
 */
function findRunByDistance(
  distKm: number,
  avgPaceSecPerKm: number,
  candidates: Workout[],
  paces: { e?: number } | undefined,
): Workout | null {
  const easyPace = paces?.e ?? 0;
  let best: Workout | null = null;
  let bestDev = Infinity;

  for (const w of candidates) {
    const planned = parseDistanceKm(w.d);
    if (planned <= 0) continue;
    const ratio = distKm / planned;
    if (ratio < 0.70 || ratio > 1.35) continue;  // outside ±30%
    const dev = Math.abs(ratio - 1);

    // Pace plausibility tiebreak: penalise mismatches slightly
    let pacePenalty = 0;
    if (easyPace > 0 && avgPaceSecPerKm > 0) {
      // The fast-finish long run is t:'progressive' but averages near easy pace
      // (80% easy, 20% MP), so it scores as the long run, not a quality slot.
      const isQuality = QUALITY_RUN_TYPES.has(w.t) && !isLongRun(w);
      const ranAtEasyOrSlower = avgPaceSecPerKm >= easyPace * 0.97;
      const ranAtQualityPace  = avgPaceSecPerKm <= easyPace * 0.85;
      if (isQuality && ranAtEasyOrSlower) pacePenalty = 0.10;  // slow run, not a quality slot
      if (!isQuality && ranAtQualityPace) pacePenalty = 0.10;  // fast run, not an easy slot
    }

    const score = dev + pacePenalty;
    if (score < bestDev) { bestDev = score; best = w; }
  }

  return best;
}

/**
 * Small confirmation dialog: "Looks like [Workout Name]. Assign to it?"
 */
function showMatchConfirm(matchedWorkoutName: string, distKm: number): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
    overlay.innerHTML = `
      <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-6">
        <h3 class="text-white font-semibold text-lg mb-2">Assign to Workout?</h3>
        <p class="text-gray-400 text-sm mb-5">
          This looks like <span class="text-white font-medium">${escapeHtml(matchedWorkoutName)}</span>
          (${distKm.toFixed(1)} km). Assign your run to it?
        </p>
        <div class="flex flex-col gap-2">
          <button id="btn-gps-assign-yes" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors text-sm">
            Yes, assign to ${escapeHtml(matchedWorkoutName)}
          </button>
          <button id="btn-gps-assign-no" class="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg transition-colors text-sm">
            No, log as extra run
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#btn-gps-assign-yes')?.addEventListener('click', () => {
      overlay.remove();
      resolve(true);
    });
    overlay.querySelector('#btn-gps-assign-no')?.addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
