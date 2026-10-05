/**
 * Manual activity logging — "+ Log activity" on the Plan tab.
 *
 * Replaces the legacy cross-training form in renderer.ts, which became
 * unreachable when the Plan tab superseded the legacy week view (found
 * dogfooding 2026-06-04). Same pipeline as the legacy submit handler:
 * createActivity → buildCrossTrainingPopup → showSuggestionModal →
 * applyAdjustments + workoutMods, so a logged session can reduce or replace
 * the remaining planned runs through the canonical TSS currency.
 *
 * Circular-import rule: plan-view.ts imports this file, so re-renders go
 * through a dynamic import of plan-view.
 */
import { getMutableState, saveState, addCrossActivity } from '@/state';
import { SPORT_LABELS } from '@/constants';
import type { SportKey } from '@/types';
import {
  createActivity,
  normalizeSport,
  buildCrossTrainingPopup,
  workoutsToPlannedRuns,
  applyAdjustments,
} from '@/cross-training';
import { showSuggestionModal } from './suggestion-modal';
import { resolveWeekWorkouts } from './week-resolve';
import { writeAdjustmentMods, adjustableWorkouts } from '@/workouts/workout-mods';
import { showSimpleToast } from './toast';
import { addAdhocWorkoutFromPending } from '@/calculations/activity-matcher';
import type { GarminPendingItem } from '@/types';

/** Sports offered in the picker, common ones first. */
const SPORT_ORDER: SportKey[] = [
  'cycling', 'swimming', 'strength', 'hiking', 'tennis', 'padel', 'soccer',
  'basketball', 'rowing', 'elliptical', 'skiing', 'skating', 'climbing',
  'boxing', 'martial_arts', 'crossfit', 'dancing', 'yoga', 'pilates',
  'stair_climbing', 'jump_rope', 'walking', 'rugby', 'snowboarding',
  'kitesurfing', 'surfing', 'sailing', 'paddleboard', 'kayaking',
  'wakeboarding', 'extra_run', 'generic_sport',
];

export function openLogActivityOverlay(): void {
  document.getElementById('log-activity-overlay')?.remove();

  // Mode-aware subtitle: only running mode runs the replace/reduce suggester.
  const s0 = getMutableState();
  const isRunningMode = s0.eventType !== 'triathlon' && s0.eventType !== 'hyrox' && !s0.trackOnly;
  const subtitle = isRunningMode
    ? 'A session done outside the plan. Its load counts toward the week and can reduce upcoming runs.'
    : 'A session done outside the plan. Its load counts toward the week.';

  const options = SPORT_ORDER
    .filter(k => SPORT_LABELS[k])
    .map(k => `<option value="${k}">${SPORT_LABELS[k]}</option>`)
    .join('');

  const overlay = document.createElement('div');
  overlay.id = 'log-activity-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
      <div style="font-size:16px;font-weight:600;color:var(--c-black)">Log an activity</div>
      <p style="font-size:12px;color:var(--c-muted);line-height:1.5;margin:4px 0 16px">${subtitle}</p>
      <label style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:4px">Sport</label>
      <select id="la-sport" class="m-select" style="width:100%;margin-bottom:12px">${options}</select>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        <div style="flex:1">
          <label style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:4px">Duration (min)</label>
          <input id="la-duration" type="number" inputmode="numeric" min="5" max="600" placeholder="60" class="m-select" style="width:100%" />
        </div>
        <div style="flex:1">
          <label style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:4px">Effort (RPE 1 to 10)</label>
          <input id="la-rpe" type="number" inputmode="numeric" min="1" max="10" placeholder="5" class="m-select" style="width:100%" />
        </div>
      </div>
      <div id="la-error" style="display:none;font-size:12px;color:var(--c-muted);margin-bottom:10px"></div>
      <button id="la-submit" style="width:100%;padding:13px;border-radius:999px;border:none;background:var(--c-black);color:var(--c-bg);font-size:14px;font-weight:600;cursor:pointer;font-family:var(--f)">Log activity</button>
      <button id="la-cancel" style="width:100%;padding:11px;border:none;background:transparent;color:var(--c-muted);font-size:13px;cursor:pointer;font-family:var(--f)">Cancel</button>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#la-cancel')?.addEventListener('click', close);

  overlay.querySelector('#la-submit')?.addEventListener('click', () => {
    const sport = (overlay.querySelector('#la-sport') as HTMLSelectElement)?.value || 'generic_sport';
    const dur = parseInt((overlay.querySelector('#la-duration') as HTMLInputElement)?.value || '0', 10);
    const rpe = parseInt((overlay.querySelector('#la-rpe') as HTMLInputElement)?.value || '0', 10);
    const err = overlay.querySelector('#la-error') as HTMLElement;
    if (!dur || dur < 5 || dur > 600 || !rpe || rpe < 1 || rpe > 10) {
      err.textContent = 'Enter a duration of 5 to 600 minutes and an effort from 1 to 10.';
      err.style.display = 'block';
      return;
    }
    close();
    submitManualActivity(sport, dur, rpe);
  });
}

/** Mode fork: running gets the full replace/reduce suggester; the other
 * modes land the activity exactly where a synced one lands (the SEV-1-fixed
 * adhoc path, canonical TSS stamps + Recent-list record) and let their own
 * pipelines (tri cross-training overload, strain) pick it up. */
function submitManualActivity(sport: string, durationMin: number, rpe: number): void {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk) return;

  if (s.eventType === 'triathlon' || s.eventType === 'hyrox' || s.trackOnly) {
    submitAdhocForMode(s, wk, sport, durationMin, rpe);
    return;
  }

  const activity = createActivity(sport, durationMin, rpe, undefined, undefined, s.w);
  const jsDay = new Date().getDay();
  activity.dayOfWeek = jsDay === 0 ? 6 : jsDay - 1;

  const workouts = resolveWeekWorkouts(s, s.w);
  // Sessions the user scaled by hand keep their Adjust: never offered for a cut.
  const weekRuns = workoutsToPlannedRuns(adjustableWorkouts(workouts.filter((w: any) => w.t !== 'cross' && w.t !== 'gym')), s.pac);
  const popup = buildCrossTrainingPopup(
    {
      raceGoal: s.rd,
      plannedRunsPerWeek: s.rw,
      injuryMode: !!(s as any).injuryState?.active,
      easyPaceSecPerKm: s.pac?.e,
      runnerType: s.typ as 'Speed' | 'Endurance' | 'Balanced' | undefined,
    },
    weekRuns,
    activity,
  );

  const rerender = () => import('./plan-view').then(({ renderPlanView }) => renderPlanView());

  const hasAdjustments = popup.reduceOutcome.adjustments.length > 0 ||
    popup.replaceOutcome.adjustments.length > 0;

  if (!hasAdjustments) {
    activity.applied = true;
    addCrossActivity(activity);
    saveState();
    showSimpleToast(`${SPORT_LABELS[normalizeSport(sport) as SportKey] ?? 'Activity'} logged. No plan changes needed.`);
    rerender();
    return;
  }

  showSuggestionModal(popup, normalizeSport(sport), (decision) => {
    activity.applied = true;
    addCrossActivity(activity);

    if (decision && decision.choice !== 'keep' && decision.adjustments.length > 0) {
      const modifiedWorkouts = applyAdjustments(workouts, decision.adjustments, normalizeSport(sport), s.pac);
      // One mod per session: replaces the session's current change (upsert). The
      // reason is the one applyAdjustments wrote for each session.
      for (const adj of decision.adjustments) {
        const modified = modifiedWorkouts.find(w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex);
        if (!modified) continue;
        writeAdjustmentMods(wk, modifiedWorkouts, [adj], modified.modReason || '');
      }
    }
    saveState();
    rerender();
  });
}

/** Tri/cycling/HYROX/just-track: synthetic pending-item accept — the same
 * canonical path a synced activity takes (addAdhocWorkoutFromPending stamps
 * TSS-scale loads and creates the GarminActual record with startTime). */
function submitAdhocForMode(
  s: ReturnType<typeof getMutableState>,
  wk: NonNullable<ReturnType<typeof getMutableState>['wks']>[number],
  sport: string,
  durationMin: number,
  rpe: number,
): void {
  const sportKey = normalizeSport(sport);
  const now = new Date();
  const garminId = `manual-${now.getTime()}`;
  const id = `garmin-${garminId}`;
  const item = {
    garminId,
    activityType: sportKey.toUpperCase(),
    appType: sportKey === 'strength' ? 'gym' : 'cross',
    startTime: now.toISOString(),
    durationSec: durationMin * 60,
    distanceM: null,
    avgHR: null,
    maxHR: null,
    aerobicEffect: null,
    anaerobicEffect: null,
    garminRpe: rpe,
    calories: null,
    iTrimp: null,
  } as GarminPendingItem;

  addAdhocWorkoutFromPending(wk, item, id, rpe);
  if (!wk.rated) wk.rated = {};
  wk.rated[id] = rpe; // manual log is a completed session, not a plan slot
  saveState();
  showSimpleToast(`${SPORT_LABELS[sportKey as SportKey] ?? 'Activity'} logged: ${durationMin} min, RPE ${rpe}.`);
  import('./main-view').then(({ renderMainView }) => renderMainView());
}
