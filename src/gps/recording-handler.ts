/**
 * Bridges a completed GPS recording to workout completion.
 * Shows the completion modal and calls rate() when the user confirms.
 */

import type { GpsRecording, Workout } from '@/types';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state';
import { rate } from '@/ui/events';
import { render } from '@/ui/renderer';
import { openGpsCompletionModal, type CompletionData } from '@/ui/gps-completion-modal';
import { deleteGpsRecording } from '@/gps/persistence';
import { generateWeekWorkouts, calculateWorkoutLoad } from '@/workouts';
import { getTrailingEffortScore } from '@/calculations/fitness-model';
import { parseDistanceKm } from '@/calculations/matching';
import { createActivity, buildCrossTrainingPopup, workoutsToPlannedRuns, applyAdjustments } from '@/cross-training';
import { showSuggestionModal } from '@/ui/suggestion-modal';

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
 */
export function handleCompletedRecording(recording: GpsRecording, workoutName: string): void {
  const s = getState();

  // Try to find a matching scheduled workout by name (normal GPS-from-workout-card flow)
  let workout: Workout | null = null;
  let workoutId = '';
  let weekWorkouts: Workout[] = [];

  if (s.w >= 1 && s.w <= s.wks.length) {
    const wk = s.wks[s.w - 1];
    const previousSkips = s.w > 1 ? s.wks[s.w - 2].skip : [];
    const injuryState = (s as any).injuryState || null;
    weekWorkouts = generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, previousSkips, s.commuteConfig,
      injuryState, s.recurringActivities, s.onboarding?.experienceLevel,
      undefined, undefined, s.w, s.tw, s.v, s.gs,
      getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus,
    );
    const matched = weekWorkouts.find(w => w.n === workoutName);
    if (matched) {
      workout = matched;
      workoutId = matched.id || matched.n;
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
      if (workout) {
        // Name-matched scheduled workout: rate it and link the recording
        rate(workoutId, workout.n, rpe, workout.rpe || workout.r, workout.t, false);
        const ms = getMutableState();
        const week = ms.wks[ms.w - 1];
        if (week) {
          if (!week.gpsRecordings) week.gpsRecordings = {};
          week.gpsRecordings[workoutId] = recording.id;
          saveState();
        }
        render();
      } else if (s.w >= 1 && s.w <= s.wks.length) {
        handleImpromptuRun(recording, workoutName, rpe, weekWorkouts);
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
 *    Day-of-week is intentionally ignored — the run could have been done on any day.
 * 2. If match found → offer assignment to that workout.
 * 3. Otherwise → save as adhoc and run load through suggestion pipeline.
 */
function handleImpromptuRun(
  recording: GpsRecording,
  workoutName: string,
  rpe: number,
  weekWorkouts: Workout[],
): void {
  const ms = getMutableState();
  const week = ms.wks[ms.w - 1];
  if (!week) { render(); return; }

  const distKm = recording.totalDistance / 1000;
  const durationMin = recording.totalElapsed / 60;

  // Filter to unrated, non-replaced planned runs
  const unratedRuns = weekWorkouts.filter(w => {
    const isReplaced = w.status === 'replaced' ||
      week.workoutMods?.some(m => m.name === w.n && m.status === 'replaced');
    if (isReplaced) return false;
    const wid = w.id || w.n;
    return week.rated[wid] == null && week.rated[w.n] == null;
  });

  // Match by distance proximity only — day-of-week does not matter for impromptu runs.
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
    // Rate the adhoc entry so it counts toward completedKm and effort
    rate(recording.id, workoutName, rpe, 5, 'easy', false);
  };

  const runLoadLogic = () => {
    saveAsAdhoc();
    saveState();

    // Build a CrossActivity from the run so the suggestion pipeline can assess
    // how much extra load this adds and offer plan adjustments
    const activity = createActivity('extra_run', durationMin, rpe, undefined, undefined, ms.w);

    // Apply existing mods so the suggester sees the true state of the week
    if (week.workoutMods?.length) {
      for (const mod of week.workoutMods) {
        const w = weekWorkouts.find(w => w.n === mod.name && w.dayOfWeek === mod.dayOfWeek);
        if (w) {
          w.status = mod.status as any;
          w.d = mod.newDistance;
          w.t = mod.newType || w.t;
          const loads = calculateWorkoutLoad(w.t, w.d, (mod.newRpe || 5) * 10);
          w.aerobic = loads.aerobic;
          w.anaerobic = loads.anaerobic;
        }
      }
    }

    const plannedRuns = workoutsToPlannedRuns(weekWorkouts, ms.pac);
    const popup = buildCrossTrainingPopup(
      {
        raceGoal: ms.rd,
        plannedRunsPerWeek: ms.rw,
        injuryMode: !!(ms as any).injuryState?.active,
        runnerType: ms.typ as 'Speed' | 'Endurance' | 'Balanced' | undefined,
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
          const modifiedWorkouts = applyAdjustments(weekWorkouts, decision.adjustments, 'run', ms.pac);
          if (!week.workoutMods) week.workoutMods = [];
          for (const adj of decision.adjustments) {
            const modified = modifiedWorkouts.find(
              w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex,
            );
            if (!modified) continue;
            week.workoutMods.push({
              name: modified.n,
              dayOfWeek: modified.dayOfWeek,
              status: modified.status || 'reduced',
              modReason: `GPS: ${workoutName}`,
              confidence: modified.confidence,
              originalDistance: modified.originalDistance,
              newDistance: modified.d,
              newType: modified.t,
              newRpe: modified.rpe || modified.r,
            });
          }
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
      if (confirmed) {
        // Assign the GPS run to the matched planned workout
        if (!week.gpsRecordings) week.gpsRecordings = {};
        week.gpsRecordings[matchId] = recording.id;
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

// Run types whose intensity is "quality" (not easy/long)
const QUALITY_RUN_TYPES = new Set(['threshold', 'vo2', 'intervals', 'race_pace', 'mixed', 'progressive', 'hill_repeats']);

/**
 * Find the best planned run to match an impromptu recording.
 * Matching is by distance only (± 30%) — day-of-week is ignored.
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
      const isQuality = QUALITY_RUN_TYPES.has(w.t);
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
 * Small confirmation dialog: "Looks like [Workout Name] — assign to it?"
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
