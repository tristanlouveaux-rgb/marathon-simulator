/**
 * Post-run GPS completion modal.
 * Shows actual vs planned data, splits table, RPE selector,
 * and completes the workout via rate().
 */

import type { GpsRecording, GpsSplit, Workout } from '@/types';
import { formatPace, fpModel, formatWorkoutTime, formatKm } from '@/utils';
import { parseDistanceKm } from '@/calculations/matching';
import { getState } from '@/state';
import { summariseAdherence, type AdherenceSummary } from '@/guided/adherence';
import { createSafetySlider } from '@/ui/safety-slider';
import { trimRouteEnds } from '@/gps/anonymize-route';
import { submitRouteSafetyRating } from '@/data/safetyRatingSync';

const MODAL_ID = 'gps-completion-modal';

/** Frosted dim behind the modal — matches the goal-time overlay recipe. */
const OVERLAY_STYLE =
  'background:rgba(15,23,42,0.42);backdrop-filter:blur(12px) saturate(1.1);-webkit-backdrop-filter:blur(12px) saturate(1.1)';
/** The floating card: white surface (canonical modal colour). Inner tiles read as
 *  raised via their own shadow stack, large radius, soft layered shadow, no hard border. */
const CARD_STYLE =
  'background:var(--c-surface);border-radius:24px;box-shadow:0 24px 64px rgba(0,0,0,0.18),0 0 0 1px rgba(0,0,0,0.04)';
/** Raised grouped tile: white surface lifted off the card with the canonical
 *  m-card shadow stack plus a subtle bevel — the app's 3D glass-card depth. */
const RAISED_TILE =
  'background:var(--c-surface);border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,0.05),0 5px 14px rgba(0,0,0,0.07),inset 0 1px 0 rgba(255,255,255,0.7),inset 0 -1px 0 rgba(0,0,0,0.03)';

export interface CompletionData {
  recording: GpsRecording;
  workout: Workout | null;
  workoutId: string;
  isSkipped: boolean;
}

type OnComplete = (rpe: number) => void;
type OnDiscard = () => void;

/**
 * Open the post-run completion modal.
 * Returns via callbacks so the caller can wire in rate() + state save.
 */
export function openGpsCompletionModal(
  data: CompletionData,
  onComplete: OnComplete,
  onDiscard: OnDiscard,
): void {
  closeGpsCompletionModal();

  const { recording, workout } = data;

  const actualDistKm = recording.totalDistance / 1000;
  const plannedDistKm = workout ? parseDistanceKm(workout.d) : 0;
  const avgPace = recording.averagePace;
  const unitPref = getState().unitPref ?? 'km';
  const workoutLabel = workout ? workout.n : recording.workoutName;
  const saveLabel = workout ? 'Complete Workout' : 'Save Run';

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 flex items-center justify-center z-50 p-4';
  modal.style.cssText = OVERLAY_STYLE;
  modal.innerHTML = `
    <div class="w-full max-w-md max-h-[90vh] overflow-y-auto" style="${CARD_STYLE};padding:24px">
      <h2 style="font-size:19px;font-weight:700;letter-spacing:-0.01em;color:var(--c-black);margin-bottom:2px">Run Complete</h2>
      <div class="text-sm mb-5" style="color:var(--c-muted)">${escapeHtml(workoutLabel)}</div>

      <!-- Summary grid -->
      <div class="grid grid-cols-3 gap-2 mb-3">
        <div class="text-center" style="${RAISED_TILE};padding:12px 8px">
          <div class="text-xs" style="color:var(--c-faint)">Distance</div>
          <div class="font-bold" style="color:var(--c-black);font-size:18px;margin-top:2px">${formatKm(actualDistKm, unitPref, 2)}</div>
        </div>
        <div class="text-center" style="${RAISED_TILE};padding:12px 8px">
          <div class="text-xs" style="color:var(--c-faint)">Time</div>
          <div class="font-bold" style="color:var(--c-black);font-size:18px;margin-top:2px">${formatWorkoutTime(recording.totalElapsed)}</div>
        </div>
        <div class="text-center" style="${RAISED_TILE};padding:12px 8px">
          <div class="text-xs" style="color:var(--c-faint)">Avg Pace</div>
          <div class="font-bold" style="color:var(--c-black);font-size:18px;margin-top:2px">${avgPace > 0 && avgPace < 1800 ? formatPace(avgPace, unitPref) : '--'}</div>
        </div>
      </div>

      <!-- Planned vs Actual -->
      ${plannedDistKm > 0 ? `
        <div class="mb-3" style="${RAISED_TILE};padding:12px 14px">
          <div class="text-xs font-semibold mb-2" style="color:var(--c-faint)">Planned vs Actual</div>
          <div class="flex justify-between text-sm">
            <span style="color:var(--c-muted)">Distance</span>
            <span style="color:var(--c-black)">
              ${formatKm(actualDistKm, unitPref)} / ${formatKm(plannedDistKm, unitPref)}
              <span style="${distanceStyle(actualDistKm, plannedDistKm)}" class="ml-1">
                (${distancePercent(actualDistKm, plannedDistKm)})
              </span>
            </span>
          </div>
        </div>
      ` : ''}

      <!-- Pace adherence -->
      ${recording.splits.length > 0 ? renderAdherenceSection(summariseAdherence(recording.splits)) : ''}

      <!-- Splits table -->
      ${recording.splits.length > 0 ? renderSplitsSection(recording.splits, unitPref) : ''}

      <!-- RPE selector -->
      <div class="mb-5">
        <div class="text-sm mb-3" style="color:var(--c-black)">How did it feel?</div>
        <div style="text-align:center;margin-bottom:8px">
          <span id="gps-rpe-value" style="font-size:26px;font-weight:700;color:var(--c-faint)">&ndash;&ndash;</span>
          <span id="gps-rpe-desc" style="display:block;font-size:12px;margin-top:2px;min-height:16px;color:var(--c-faint)">Slide to rate your effort</span>
        </div>
        <input id="gps-rpe-slider" type="range" class="m-slider-glass" min="1" max="10" value="5" step="1">
        <div class="flex justify-between text-xs mt-1" style="color:var(--c-faint)">
          <span>Easy</span>
          <span>Max effort</span>
        </div>
      </div>

      <!-- Safety rating block inserted dynamically if route >= 1km -->
      <div id="gps-safety-block"></div>

      <!-- Buttons rendered dynamically via showMainButtons() -->
      <div id="gps-btn-row" class="flex gap-3"></div>
    </div>
  `;

  document.body.appendChild(modal);

  let selectedRpe = 0;
  let currentSaveBtn: HTMLButtonElement | null = null;

  // Safety slider. Only for outdoor routes >= 1km
  let safetySlider: ReturnType<typeof createSafetySlider> | null = null;
  const hasRoute = recording.route.length >= 2 && actualDistKm >= 1;
  if (hasRoute) {
    safetySlider = createSafetySlider();
    document.getElementById('gps-safety-block')?.appendChild(safetySlider.el);
  }

  function showMainButtons(): void {
    const row = document.getElementById('gps-btn-row');
    if (!row) return;
    row.innerHTML = '';
    row.className = 'flex gap-3';

    // Discard: frosted glass float with press-in, but borderless (the white rim
    // reads heavy on the off-white card). Float shadow keeps the depth.
    const discardBtn = document.createElement('button');
    discardBtn.className = 'm-btn-glass m-btn-glass--inset';
    discardBtn.style.cssText = 'padding:13px 22px;font-size:14px;border:none';
    discardBtn.textContent = 'Discard';
    discardBtn.addEventListener('click', showDiscardConfirm);

    // Complete is the primary CTA: dark pill, full-width. Depth + press-in now
    // come from the .m-btn-primary class (app-wide default).
    const saveBtn = document.createElement('button') as HTMLButtonElement;
    saveBtn.className = 'flex-1 m-btn-primary';
    saveBtn.style.cssText = 'justify-content:center;padding:13px 18px;font-size:14px';
    saveBtn.style.opacity = selectedRpe === 0 ? '0.4' : '1';
    saveBtn.textContent = saveLabel;
    saveBtn.disabled = selectedRpe === 0;
    saveBtn.addEventListener('click', () => {
      if (selectedRpe > 0) {
        closeGpsCompletionModal();
        onComplete(selectedRpe);
        if (safetySlider && hasRoute) {
          const trimResult = trimRouteEnds(recording.route);
          if (trimResult) {
            void submitRouteSafetyRating({
              activityId: recording.id,
              source: 'gps_recording',
              polylineTrimmed: trimResult.encodedPolyline,
              pointCount: trimResult.pointCount,
              distanceKm: trimResult.distanceKm,
              safetyScore: safetySlider.getScore(),
              centerLat: trimResult.centerLat,
              centerLng: trimResult.centerLng,
              boundsNorth: trimResult.boundsNorth,
              boundsSouth: trimResult.boundsSouth,
              boundsEast: trimResult.boundsEast,
              boundsWest: trimResult.boundsWest,
            });
          }
        }
      }
    });

    currentSaveBtn = saveBtn;
    row.appendChild(discardBtn);
    row.appendChild(saveBtn);
  }

  function showDiscardConfirm(): void {
    const row = document.getElementById('gps-btn-row');
    if (!row) return;
    row.innerHTML = '';
    row.className = 'block';
    currentSaveBtn = null;

    const msg = document.createElement('p');
    msg.className = 'text-sm mb-3';
    msg.style.color = 'var(--c-black)';
    msg.textContent = "This run won't be saved. Are you sure?";

    const btnRow = document.createElement('div');
    btnRow.className = 'flex gap-3';

    const keepBtn = document.createElement('button');
    keepBtn.className = 'flex-1 m-btn-glass m-btn-glass--inset';
    keepBtn.textContent = 'Keep';
    keepBtn.addEventListener('click', showMainButtons);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'flex-1 px-4 py-2 rounded-lg text-sm font-medium';
    confirmBtn.style.color = 'white';
    confirmBtn.style.background = '#EF4444';
    confirmBtn.textContent = 'Yes, Discard';
    confirmBtn.addEventListener('click', () => { closeGpsCompletionModal(); onDiscard(); });

    btnRow.appendChild(keepBtn);
    btnRow.appendChild(confirmBtn);
    row.appendChild(msg);
    row.appendChild(btnRow);
  }

  // RPE slider. Untouched until the user interacts, so Complete stays disabled
  // and the readout shows a prompt rather than a default value.
  const rpeSlider = modal.querySelector('#gps-rpe-slider') as HTMLInputElement | null;
  const rpeValueEl = modal.querySelector('#gps-rpe-value') as HTMLElement | null;
  const rpeDescEl = modal.querySelector('#gps-rpe-desc') as HTMLElement | null;
  function commitRpe(): void {
    if (!rpeSlider) return;
    selectedRpe = parseInt(rpeSlider.value, 10);
    const colour = rpeColour(selectedRpe);
    if (rpeValueEl) {
      rpeValueEl.textContent = String(selectedRpe);
      rpeValueEl.style.color = colour;
    }
    if (rpeDescEl) {
      rpeDescEl.textContent = RPE_DESCRIPTORS[selectedRpe] ?? '';
      rpeDescEl.style.color = colour;
    }
    if (currentSaveBtn) {
      currentSaveBtn.disabled = false;
      currentSaveBtn.style.opacity = '1';
    }
  }
  // 'input' covers drag + keyboard; 'click' covers a tap that lands on the
  // current thumb position (no value change, so 'input' would not fire).
  rpeSlider?.addEventListener('input', commitRpe);
  rpeSlider?.addEventListener('click', commitRpe);

  showMainButtons();
}

export function closeGpsCompletionModal(): void {
  document.getElementById(MODAL_ID)?.remove();
}

function renderAdherenceSection(summary: AdherenceSummary): string {
  if (summary.paced.length === 0) return '';
  const hitPct = summary.hitRate != null ? Math.round(summary.hitRate * 100) : 0;
  const avg = summary.avgDeviationSec;
  const avgLabel = avg == null
    ? ''
    : Math.abs(avg) < 1
      ? 'on target'
      : avg > 0
        ? `${Math.round(avg)}s behind target on average`
        : `${Math.abs(Math.round(avg))}s faster than target on average`;
  const bits: string[] = [];
  if (summary.fastCount > 0) bits.push(`${summary.fastCount} fast`);
  if (summary.slowCount > 0) bits.push(`${summary.slowCount} slow`);
  const breakdown = bits.length > 0 ? bits.join(' · ') : 'all within ±5s/km';

  return `
    <div class="mb-3" style="${RAISED_TILE};padding:12px 14px">
      <div class="text-xs font-semibold mb-2" style="color:var(--c-faint)">Pace adherence</div>
      <div class="flex items-baseline justify-between mb-1">
        <span class="text-sm" style="color:var(--c-black)">${summary.onPaceCount} of ${summary.paced.length} splits on pace</span>
        <span class="text-lg font-bold" style="color:var(--c-black)">${hitPct}%</span>
      </div>
      <div class="text-xs" style="color:var(--c-muted)">${breakdown}${avgLabel ? ` · ${avgLabel}` : ''}</div>
    </div>
  `;
}

function renderSplitsSection(splits: GpsSplit[], unitPref: 'km' | 'mi' = 'km'): string {
  let h = `<div class="mb-3" style="${RAISED_TILE};padding:12px 14px">`;
  h += `<div class="text-xs font-semibold mb-2" style="color:var(--c-faint)">Splits</div>`;
  h += `<table class="w-full text-xs">`;
  h += `<thead><tr style="border-bottom:1px solid var(--c-border);color:var(--c-faint)">`;
  h += `<th class="text-left py-1 font-medium">Split</th>`;
  h += `<th class="text-right py-1 font-medium">Dist</th>`;
  h += `<th class="text-right py-1 font-medium">Pace</th>`;
  h += `<th class="text-right py-1 font-medium">Target</th>`;
  h += `</tr></thead><tbody>`;

  for (const split of splits) {
    const paceStr = split.pace > 0 && split.pace < 1800 ? formatPace(split.pace, unitPref) : '--';
    const targetStr = split.targetPace ? fpModel(split.targetPace, unitPref) : '--'; // target: model pace, whole second
    const diff = split.targetPace ? split.pace - split.targetPace : 0;
    const paceStyle = diff > 10 ? `color:var(--c-warn)` : diff < -10 ? `color:var(--c-ok)` : `color:var(--c-black)`;

    h += `<tr style="border-bottom:1px solid var(--c-border)">`;
    h += `<td class="py-1" style="color:var(--c-black)">${escapeHtml(split.label)}</td>`;
    h += `<td class="text-right" style="color:var(--c-muted)">${formatKm(split.distance / 1000, unitPref, 2)}</td>`;
    h += `<td class="text-right font-mono" style="${paceStyle}">${paceStr}</td>`;
    h += `<td class="text-right" style="color:var(--c-faint)">${targetStr}</td>`;
    h += `</tr>`;
  }

  h += `</tbody></table></div>`;
  return h;
}

/** Borg CR10 effort anchors for the 1–10 session-RPE scale. Descriptive only;
 *  the numeric RPE passed to rate() is unchanged. */
const RPE_DESCRIPTORS: Record<number, string> = {
  1: 'Very easy',
  2: 'Easy',
  3: 'Easy',
  4: 'Moderate',
  5: 'Moderate',
  6: 'Comfortably hard',
  7: 'Hard',
  8: 'Very hard',
  9: 'Very hard',
  10: 'Max effort',
};

/** Effort-graded colour, mirroring the safety slider in this same modal. */
function rpeColour(rpe: number): string {
  if (rpe <= 3) return 'var(--c-ok)';
  if (rpe <= 6) return 'var(--c-caution)';
  return 'var(--c-warn)';
}

function distanceStyle(actual: number, planned: number): string {
  const ratio = actual / planned;
  if (ratio >= 0.9 && ratio <= 1.1) return `color:var(--c-ok)`;
  if (ratio >= 0.75 && ratio <= 1.25) return `color:var(--c-caution)`;
  return `color:var(--c-warn)`;
}

function distancePercent(actual: number, planned: number): string {
  const pct = ((actual / planned) * 100).toFixed(0);
  return `${pct}%`;
}

/**
 * Open a read-only detail view for a past GPS recording.
 * Used by the "View Run" button on completed workout cards.
 */
export function openGpsRecordingDetail(recording: GpsRecording): void {
  closeGpsCompletionModal();

  const actualDistKm = recording.totalDistance / 1000;
  const avgPace = recording.averagePace;
  const unitPref2 = getState().unitPref ?? 'km';

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 flex items-center justify-center z-50 p-4';
  modal.style.cssText = OVERLAY_STYLE;
  modal.innerHTML = `
    <div class="w-full max-w-md max-h-[90vh] overflow-y-auto" style="${CARD_STYLE};padding:24px">
      <div class="flex items-center justify-between mb-1">
        <h2 style="font-size:19px;font-weight:700;letter-spacing:-0.01em;color:var(--c-black)">${escapeHtml(recording.workoutName)}</h2>
        <button id="gps-modal-close" style="color:var(--c-faint);background:none;border:none;cursor:pointer;padding:0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="text-xs mb-4" style="color:var(--c-faint)">${new Date(recording.date).toLocaleDateString()}</div>

      <!-- Summary grid -->
      <div class="grid grid-cols-3 gap-2 mb-3">
        <div class="text-center" style="${RAISED_TILE};padding:12px 8px">
          <div class="text-xs" style="color:var(--c-faint)">Distance</div>
          <div class="font-bold" style="color:var(--c-black);font-size:18px;margin-top:2px">${formatKm(actualDistKm, unitPref2, 2)}</div>
        </div>
        <div class="text-center" style="${RAISED_TILE};padding:12px 8px">
          <div class="text-xs" style="color:var(--c-faint)">Time</div>
          <div class="font-bold" style="color:var(--c-black);font-size:18px;margin-top:2px">${formatWorkoutTime(recording.totalElapsed)}</div>
        </div>
        <div class="text-center" style="${RAISED_TILE};padding:12px 8px">
          <div class="text-xs" style="color:var(--c-faint)">Avg Pace</div>
          <div class="font-bold" style="color:var(--c-black);font-size:18px;margin-top:2px">${avgPace > 0 && avgPace < 1800 ? formatPace(avgPace, unitPref2) : '--'}</div>
        </div>
      </div>

      ${recording.splits.length > 0 ? renderAdherenceSection(summariseAdherence(recording.splits)) : ''}
      ${recording.splits.length > 0 ? renderSplitsSection(recording.splits, unitPref2) : ''}

      <button id="gps-detail-close" class="w-full m-btn-glass m-btn-glass--inset" style="margin-top:8px">
        Close
      </button>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('gps-modal-close')?.addEventListener('click', closeGpsCompletionModal);
  document.getElementById('gps-detail-close')?.addEventListener('click', closeGpsCompletionModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeGpsCompletionModal();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
