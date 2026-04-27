/**
 * Post-run GPS completion modal.
 * Shows actual vs planned data, splits table, RPE selector,
 * and completes the workout via rate().
 */

import type { GpsRecording, GpsSplit, Workout } from '@/types';
import { formatPace, formatWorkoutTime, formatKm } from '@/utils';
import { parseDistanceKm } from '@/calculations/matching';
import { getState } from '@/state';
import { summariseAdherence, type AdherenceSummary } from '@/guided/adherence';

const MODAL_ID = 'gps-completion-modal';

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
  modal.className = 'fixed inset-0 flex items-center justify-center z-50';
  modal.style.background = 'rgba(0,0,0,0.45)';
  modal.innerHTML = `
    <div class="rounded-xl p-6 w-full max-w-md mx-4 shadow-xl max-h-[90vh] overflow-y-auto" style="background:var(--c-surface);border:1px solid var(--c-border-strong)">
      <h2 class="text-lg font-semibold mb-1" style="color:var(--c-black)">Run Complete</h2>
      <div class="text-sm mb-4" style="color:var(--c-muted)">${escapeHtml(workoutLabel)}</div>

      <!-- Summary grid -->
      <div class="grid grid-cols-3 gap-2 mb-4">
        <div class="rounded-lg p-3 text-center" style="background:var(--c-bg);border:1px solid var(--c-border)">
          <div class="text-xs" style="color:var(--c-faint)">Distance</div>
          <div class="text-lg font-bold" style="color:var(--c-black)">${formatKm(actualDistKm, unitPref, 2)}</div>
        </div>
        <div class="rounded-lg p-3 text-center" style="background:var(--c-bg);border:1px solid var(--c-border)">
          <div class="text-xs" style="color:var(--c-faint)">Time</div>
          <div class="text-lg font-bold" style="color:var(--c-black)">${formatWorkoutTime(recording.totalElapsed)}</div>
        </div>
        <div class="rounded-lg p-3 text-center" style="background:var(--c-bg);border:1px solid var(--c-border)">
          <div class="text-xs" style="color:var(--c-faint)">Avg Pace</div>
          <div class="text-lg font-bold" style="color:var(--c-black)">${avgPace > 0 && avgPace < 1800 ? formatPace(avgPace, unitPref) : '--'}</div>
        </div>
      </div>

      <!-- Planned vs Actual -->
      ${plannedDistKm > 0 ? `
        <div class="rounded-lg p-3 mb-4" style="background:var(--c-bg);border:1px solid var(--c-border)">
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
        <div class="text-sm mb-2" style="color:var(--c-black)">How did it feel? <span id="gps-rpe-label" class="font-bold" style="color:var(--c-ok)"></span></div>
        <div class="grid grid-cols-10 gap-1">
          ${Array.from({ length: 10 }, (_, i) => i + 1).map(r => `
            <button data-rpe="${r}" class="gps-rpe-btn px-1 py-2 text-sm rounded transition-colors" style="border:1.5px solid var(--c-border-strong);color:var(--c-black);background:var(--c-surface)">${r}</button>
          `).join('')}
        </div>
        <div class="flex justify-between text-xs mt-1" style="color:var(--c-faint)">
          <span>Easy</span>
          <span>Max effort</span>
        </div>
      </div>

      <!-- Buttons rendered dynamically via showMainButtons() -->
      <div id="gps-btn-row" class="flex gap-3"></div>
    </div>
  `;

  document.body.appendChild(modal);

  let selectedRpe = 0;
  let currentSaveBtn: HTMLButtonElement | null = null;

  function showMainButtons(): void {
    const row = document.getElementById('gps-btn-row');
    if (!row) return;
    row.innerHTML = '';
    row.className = 'flex gap-3';

    const discardBtn = document.createElement('button');
    discardBtn.className = 'm-btn-secondary px-4 py-2 rounded-lg text-sm font-medium';
    discardBtn.textContent = 'Discard';
    discardBtn.addEventListener('click', showDiscardConfirm);

    const saveBtn = document.createElement('button') as HTMLButtonElement;
    saveBtn.className = 'flex-1 m-btn-primary px-4 py-2 rounded-lg text-sm font-medium';
    saveBtn.style.opacity = selectedRpe === 0 ? '0.4' : '1';
    saveBtn.textContent = saveLabel;
    saveBtn.disabled = selectedRpe === 0;
    saveBtn.addEventListener('click', () => {
      if (selectedRpe > 0) { closeGpsCompletionModal(); onComplete(selectedRpe); }
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

  // RPE buttons
  modal.querySelectorAll('.gps-rpe-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedRpe = parseInt((btn as HTMLElement).dataset.rpe || '0');
      modal.querySelectorAll('.gps-rpe-btn').forEach(b => {
        (b as HTMLElement).style.background = 'var(--c-surface)';
        (b as HTMLElement).style.color = 'var(--c-black)';
        (b as HTMLElement).style.borderColor = 'var(--c-border-strong)';
      });
      (btn as HTMLElement).style.background = 'var(--c-ok)';
      (btn as HTMLElement).style.color = 'white';
      (btn as HTMLElement).style.borderColor = 'var(--c-ok)';
      const label = document.getElementById('gps-rpe-label');
      if (label) label.textContent = `RPE ${selectedRpe}`;
      if (currentSaveBtn) {
        currentSaveBtn.disabled = false;
        currentSaveBtn.style.opacity = '1';
      }
    });
  });

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
    <div class="rounded-lg p-3 mb-4" style="background:var(--c-bg);border:1px solid var(--c-border)">
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
  let h = `<div class="rounded-lg p-3 mb-4" style="background:var(--c-bg);border:1px solid var(--c-border)">`;
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
    const targetStr = split.targetPace ? formatPace(split.targetPace, unitPref) : '--';
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
  modal.className = 'fixed inset-0 flex items-center justify-center z-50';
  modal.style.background = 'rgba(0,0,0,0.45)';
  modal.innerHTML = `
    <div class="rounded-xl p-6 w-full max-w-md mx-4 shadow-xl max-h-[90vh] overflow-y-auto" style="background:var(--c-surface);border:1px solid var(--c-border-strong)">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold" style="color:var(--c-black)">${escapeHtml(recording.workoutName)}</h2>
        <button id="gps-modal-close" style="color:var(--c-faint);background:none;border:none;cursor:pointer;padding:0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="text-xs mb-3" style="color:var(--c-faint)">${new Date(recording.date).toLocaleDateString()}</div>

      <!-- Summary grid -->
      <div class="grid grid-cols-3 gap-2 mb-4">
        <div class="rounded-lg p-3 text-center" style="background:var(--c-bg);border:1px solid var(--c-border)">
          <div class="text-xs" style="color:var(--c-faint)">Distance</div>
          <div class="text-lg font-bold" style="color:var(--c-black)">${formatKm(actualDistKm, unitPref2, 2)}</div>
        </div>
        <div class="rounded-lg p-3 text-center" style="background:var(--c-bg);border:1px solid var(--c-border)">
          <div class="text-xs" style="color:var(--c-faint)">Time</div>
          <div class="text-lg font-bold" style="color:var(--c-black)">${formatWorkoutTime(recording.totalElapsed)}</div>
        </div>
        <div class="rounded-lg p-3 text-center" style="background:var(--c-bg);border:1px solid var(--c-border)">
          <div class="text-xs" style="color:var(--c-faint)">Avg Pace</div>
          <div class="text-lg font-bold" style="color:var(--c-black)">${avgPace > 0 && avgPace < 1800 ? formatPace(avgPace, unitPref2) : '--'}</div>
        </div>
      </div>

      ${recording.splits.length > 0 ? renderAdherenceSection(summariseAdherence(recording.splits)) : ''}
      ${recording.splits.length > 0 ? renderSplitsSection(recording.splits, unitPref2) : ''}

      <button id="gps-detail-close" class="w-full m-btn-glass m-btn-glass--inset">
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
