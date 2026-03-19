import type { GpsLiveData, GpsSplit, GpsRecording } from '@/types';
import { formatPace, formatWorkoutTime, formatKm } from '@/utils';
import { getWeekRecordings, deleteGpsRecording } from '@/gps/persistence';
import { getState } from '@/state';

/**
 * Render inline GPS tracking HTML to embed inside a workout card.
 * Uses `gps-inline-*` IDs (unique since only one workout tracked at a time).
 */
export function renderInlineGpsHtml(data: GpsLiveData): string {
  let h = `<div id="gps-inline" class="mt-2 border-t border-green-300 pt-2 bg-green-50 rounded-b p-2">`;

  // Status
  const statusLabel = statusText(data.status, data.accuracy);
  const statusStyle = statusClassName(data.status, data.accuracy);
  h += `<div id="gps-inline-status" style="${statusStyle}">${statusLabel}</div>`;

  // Distance + Time
  h += `<div class="grid grid-cols-2 gap-2 mb-1">`;
  h += `<div class="bg-white rounded p-1.5 text-center">`;
  h += `<div class="text-xs text-gray-600">Distance</div>`;
  h += `<div class="text-lg font-bold text-green-700" id="gps-inline-distance">${formatKm(data.totalDistance / 1000, getState().unitPref ?? 'km', 2)}</div>`;
  h += `</div>`;
  h += `<div class="bg-white rounded p-1.5 text-center">`;
  h += `<div class="text-xs text-gray-600">Time</div>`;
  h += `<div class="text-lg font-bold text-blue-700" id="gps-inline-time">${formatWorkoutTime(data.elapsed)}</div>`;
  h += `</div>`;
  h += `</div>`;

  // Current pace
  h += `<div class="bg-white rounded p-1.5 text-center mb-1">`;
  h += `<div class="text-xs text-gray-600">Current Pace</div>`;
  const inlineUnitPref = getState().unitPref ?? 'km';
  const paceUnit = inlineUnitPref === 'mi' ? '/mi' : '/km';
  const paceStr = data.currentPace && data.currentPace < 1800 ? formatPace(data.currentPace, inlineUnitPref) : `--:--${paceUnit}`;
  h += `<div class="text-base font-bold" id="gps-inline-pace">${paceStr}</div>`;
  h += `</div>`;

  // Controls
  h += `<div class="flex gap-1 mb-1">`;
  h += `<button id="gps-inline-pause" onclick="window.gpsPause()" class="flex-1 py-1.5 rounded text-xs font-bold${data.status !== 'tracking' ? ' hidden' : ''}" style="background:#F59E0B;color:white">Pause</button>`;
  h += `<button id="gps-inline-resume" onclick="window.gpsResume()" class="flex-1 m-btn-primary py-1.5 rounded text-xs font-bold${data.status !== 'paused' ? ' hidden' : ''}">Resume</button>`;
  h += `<button onclick="window.gpsStop()" class="flex-1 py-1.5 rounded text-xs font-bold${data.status !== 'tracking' && data.status !== 'paused' && data.status !== 'acquiring' ? ' hidden' : ''}" style="background:#EF4444;color:white">Stop</button>`;
  h += `</div>`;

  // Splits
  if (data.completedSplits.length > 0 || data.currentSplit) {
    h += `<div id="gps-inline-splits">${renderSplitsTable(data.completedSplits, data.currentSplit)}</div>`;
  } else {
    h += `<div id="gps-inline-splits"></div>`;
  }

  h += `</div>`;
  return h;
}

/**
 * Update inline GPS elements with live data.
 * Silently returns if elements don't exist (e.g. mid re-render).
 */
export function updateInlineGps(data: GpsLiveData): void {
  const distEl = document.getElementById('gps-inline-distance');
  if (!distEl) return; // Not in DOM; render() will rebuild it

  distEl.textContent = formatKm(data.totalDistance / 1000, getState().unitPref ?? 'km', 2);

  const timeEl = document.getElementById('gps-inline-time');
  if (timeEl) timeEl.textContent = formatWorkoutTime(data.elapsed);

  const paceEl = document.getElementById('gps-inline-pace');
  if (paceEl) {
    const updUnitPref = getState().unitPref ?? 'km';
    const updPaceUnit = updUnitPref === 'mi' ? '/mi' : '/km';
    paceEl.textContent = data.currentPace && data.currentPace < 1800
      ? formatPace(data.currentPace, updUnitPref) : `--:--${updPaceUnit}`;
  }

  // Status
  const statusEl = document.getElementById('gps-inline-status');
  if (statusEl) {
    statusEl.textContent = statusText(data.status, data.accuracy);
    statusEl.style.cssText = statusClassName(data.status, data.accuracy);
  }

  // Toggle pause/resume button visibility
  toggleEl('gps-inline-pause', data.status === 'tracking');
  toggleEl('gps-inline-resume', data.status === 'paused');

  // Splits
  const splitsEl = document.getElementById('gps-inline-splits');
  if (splitsEl && (data.completedSplits.length > 0 || data.currentSplit)) {
    splitsEl.innerHTML = renderSplitsTable(data.completedSplits, data.currentSplit);
  }
}

function statusText(status: string, accuracy?: number | null): string {
  const labels: Record<string, string> = {
    idle: 'Ready',
    acquiring: 'Acquiring GPS signal...',
    tracking: 'Tracking',
    paused: 'Paused',
    stopped: 'Stopped',
  };

  // Show accuracy during acquisition
  if (status === 'acquiring' && accuracy !== null && accuracy !== undefined) {
    const needed = 30;
    if (accuracy <= needed) {
      return `Signal acquired! Starting...`;
    }
    return `Accuracy: ${accuracy.toFixed(0)}m (need <${needed}m)`;
  }

  return labels[status] ?? status;
}

function statusClassName(status: string, accuracy?: number | null): string {
  let colorStyle = 'color:var(--c-faint)';
  let extra = '';

  if (status === 'tracking') {
    colorStyle = 'color:var(--c-ok);font-weight:700';
  } else if (status === 'paused') {
    colorStyle = 'color:var(--c-caution);font-weight:700';
  } else if (status === 'acquiring') {
    extra = ' gps-status-pulse';
    if (accuracy !== null && accuracy !== undefined) {
      if (accuracy <= 10) {
        colorStyle = 'color:var(--c-ok)'; // Excellent
      } else if (accuracy <= 30) {
        colorStyle = 'color:var(--c-caution)'; // Good enough
      } else if (accuracy <= 50) {
        colorStyle = 'color:#F97316'; // Poor — orange
      } else {
        colorStyle = 'color:var(--c-warn)'; // Very poor
      }
    } else {
      colorStyle = 'color:var(--c-accent)';
    }
  }

  // Return a data-style attribute value to be used as inline style
  return `font-size:12px;margin-bottom:4px;${colorStyle}`;
}

function renderSplitsTable(completed: GpsSplit[], current: GpsSplit | null): string {
  let h = `<table class="w-full text-xs border-collapse">`;
  h += `<thead><tr class="border-b border-gray-200">`;
  h += `<th class="text-left py-1">Split</th>`;
  h += `<th class="text-right py-1">Dist</th>`;
  h += `<th class="text-right py-1">Pace</th>`;
  h += `<th class="text-right py-1">Target</th>`;
  h += `</tr></thead><tbody>`;

  for (const split of completed) {
    const paceStr = split.pace < 1800 ? formatPace(split.pace) : '--:--';
    const targetStr = split.targetPace ? formatPace(split.targetPace) : '--';
    const diff = split.targetPace ? split.pace - split.targetPace : 0;
    const diffColor = diff > 10 ? 'color:var(--c-warn)' : diff < -10 ? 'color:var(--c-ok)' : 'color:var(--c-muted)';

    h += `<tr class="border-b border-gray-100">`;
    h += `<td class="py-0.5">${split.label}</td>`;
    h += `<td class="text-right">${(split.distance / 1000).toFixed(2)}</td>`;
    h += `<td class="text-right font-mono" style="${diffColor}">${paceStr}</td>`;
    h += `<td class="text-right" style="color:var(--c-faint)">${targetStr}</td>`;
    h += `</tr>`;
  }

  if (current) {
    h += `<tr style="background:rgba(245,158,11,0.06)">`;
    h += `<td class="py-0.5 font-bold">${current.label}</td>`;
    h += `<td class="text-right">${(current.distance / 1000).toFixed(2)}</td>`;
    h += `<td class="text-right font-mono">...</td>`;
    h += `<td class="text-right" style="color:var(--c-faint)">${current.targetPace ? formatPace(current.targetPace) : '--'}</td>`;
    h += `</tr>`;
  }

  h += `</tbody></table>`;
  return h;
}

function toggleEl(id: string, show: boolean): void {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('hidden', !show);
}

/**
 * Refresh the past recordings list for the current week.
 * Targets #gps-recordings-section inside the workout list.
 */
export function refreshRecordings(): void {
  const container = document.getElementById('gps-recordings-section');
  if (!container) return;

  const s = getState();
  const week = s.w || 1;
  const recordings = getWeekRecordings(week);

  if (recordings.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = renderRecordingsList(recordings, week);
}

function renderRecordingsList(recordings: GpsRecording[], week: number): string {
  const unitPref = getState().unitPref ?? 'km';
  let h = `<details class="text-xs">`;
  h += `<summary class="cursor-pointer font-medium mb-1" style="color:var(--c-muted)">Recorded Runs — Week ${week} (${recordings.length})</summary>`;
  h += `<div class="space-y-1">`;

  for (const rec of recordings) {
    const date = new Date(rec.date).toLocaleDateString();
    const distKm = formatKm(rec.totalDistance / 1000, unitPref, 2);
    const paceStr = rec.averagePace > 0 && rec.averagePace < 1800
      ? formatPace(rec.averagePace, unitPref) : `--:--${unitPref === 'mi' ? '/mi' : '/km'}`;

    h += `<div class="flex items-center justify-between rounded p-1.5" style="background:var(--c-bg);border:1px solid var(--c-border)">`;
    h += `<div class="flex-1">`;
    h += `<div class="font-medium" style="color:var(--c-black)">${escapeHtml(rec.workoutName)}</div>`;
    h += `<div style="color:var(--c-muted)">${date} — ${distKm} — ${paceStr} — ${formatWorkoutTime(rec.totalElapsed)}</div>`;
    if (rec.splits.length > 0) {
      h += `<div style="color:var(--c-faint)">${rec.splits.length} split${rec.splits.length !== 1 ? 's' : ''}</div>`;
    }
    h += `</div>`;
    h += `<button class="gps-delete-rec ml-2 text-red-400 hover:text-red-600 px-1" data-id="${rec.id}" title="Delete">x</button>`;
    h += `</div>`;
  }

  h += `</div></details>`;
  return h;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Attach delegated click handler for delete buttons in the recordings list.
 * Delegates from #wo since recordings now live inside the workout area.
 */
export function attachRecordingsHandlers(): void {
  const woEl = document.getElementById('wo');
  if (!woEl) return;

  woEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.gps-delete-rec') as HTMLElement | null;
    if (!btn) return;
    const id = btn.dataset.id;
    if (id) {
      if (!confirm('Delete this recording?')) return;
      deleteGpsRecording(id);
      refreshRecordings();
    }
  });
}
