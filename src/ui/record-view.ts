/**
 * Record tab view — standalone GPS recording interface.
 *
 * Three live UIs:
 *   Simple   — single-pace run (easy/long/freerun): time + progress bar + pace stats
 *   Phased   — WU + main set + CD, no recovery gaps (tempo, progressive):
 *              segmented phase bar + current phase block + stats
 *   Interval — has recovery (null-pace) segments: full scrollable segment list + current block + stats
 */

import type { GpsLiveData, SplitScheme } from '@/types';
import {
  isTrackingActive,
  isTrackingPaused,
  getActiveGpsData,
  getActiveWorkoutName,
  setOnTrackingStart,
  setOnTrackingStop,
  setOnTrackingTick,
  getActiveSplitScheme,
} from './gps-events';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { isSimulatorMode } from '@/main';
import { getState } from '@/state';
import { formatKm, type UnitPref } from '@/utils/format';

function navigateTab(tab: TabId): void {
  setOnTrackingTick(null);
  if (tab === 'home') {
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'plan') {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  } else if (tab === 'account') {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  } else if (tab === 'stats') {
    import('./stats-view').then(({ renderStatsView }) => renderStatsView());
  }
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatPace(secPerKm: number, pref: UnitPref = 'km'): string {
  if (!secPerKm || secPerKm <= 0 || !isFinite(secPerKm)) return '--:--';
  const sec = pref === 'mi' ? secPerKm * 1.60934 : secPerKm;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function paceUnit(pref: UnitPref): string {
  return pref === 'mi' ? '/mi' : '/km';
}

function avgPace(data: GpsLiveData): number {
  return data.totalDistance > 0 ? data.elapsed / (data.totalDistance / 1000) : 0;
}

function fmtMeters(m: number, pref: UnitPref = 'km'): string {
  if (m >= 1000) return formatKm(m / 1000, pref, 2);
  if (pref === 'mi') return `${Math.round(m * 3.28084)} ft`;
  return `${Math.round(m)}m`;
}

// ---------------------------------------------------------------------------
// Workout type classification
// ---------------------------------------------------------------------------

/**
 * True if any segment has null targetPace (recovery) — interval-style workout.
 * These use the full scrollable segment list UI.
 */
function hasRecoverySegments(scheme: SplitScheme): boolean {
  return scheme.segments.some(s => s.targetPace === null);
}

/**
 * True if the scheme has more than one distinct non-null pace — phased workout
 * (WU + tempo + CD, progressive, etc.). No recovery gaps.
 * These use the segmented phase bar UI.
 */
function isPhasedWorkout(scheme: SplitScheme): boolean {
  if (scheme.segments.length === 0) return false;
  if (hasRecoverySegments(scheme)) return false;
  const firstPace = scheme.segments[0].targetPace;
  return scheme.segments.some(s => s.targetPace !== firstPace);
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Reset to -1 on each renderRecordView(); used to detect split completions for auto-scroll */
let lastCompletedIdx = -1;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function statsRow(elapsed: string, dist: string, pace: string, avg: string, unitPref: UnitPref = 'km'): string {
  const unit = paceUnit(unitPref);
  return `
    <div class="grid grid-cols-4 gap-2 px-4 mb-4">
      <div class="text-center">
        <p id="rec-elapsed" class="text-lg font-bold font-mono" style="color:var(--c-black)">${elapsed}</p>
        <p class="text-xs" style="color:var(--c-faint)">elapsed</p>
      </div>
      <div class="text-center">
        <p id="rec-dist" class="text-lg font-bold" style="color:var(--c-black)">${dist}</p>
        <p class="text-xs" style="color:var(--c-faint)">${unitPref}</p>
      </div>
      <div class="text-center">
        <p id="rec-pace" class="text-lg font-bold font-mono" style="color:var(--c-black)">${pace}</p>
        <p class="text-xs" style="color:var(--c-muted)">pace ${unit}</p>
      </div>
      <div class="text-center">
        <p id="rec-avg-pace" class="text-2xl font-semibold font-mono" style="color:var(--c-muted)">${avg}</p>
        <p class="text-xs" style="color:var(--c-faint)">avg ${unit}</p>
      </div>
    </div>
  `;
}

function controlButtons(): string {
  const paused = isTrackingPaused();
  return `
    <div class="flex gap-3 px-4">
      <button onclick="gpsPause()" class="flex-1 py-3 m-btn-secondary rounded-xl font-medium">${paused ? 'Resume' : 'Pause'}</button>
      <button onclick="gpsStop()" class="flex-1 py-3 rounded-xl font-medium" style="background:#EF4444;color:white">Stop</button>
    </div>
  `;
}

function recHeader(workoutName: string | null, right?: string): string {
  return `
    <div class="flex items-center gap-2 px-4 mb-4">
      <span class="w-2.5 h-2.5 rounded-full animate-pulse shrink-0" style="background:var(--c-warn)"></span>
      <span class="text-sm font-medium truncate" style="color:var(--c-black)">${workoutName ?? 'Run'}</span>
      ${right ? `<span class="text-xs ml-auto shrink-0" style="color:var(--c-faint)">${right}</span>` : ''}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Simple UI — single-pace run
// ---------------------------------------------------------------------------

function buildSimpleUI(data: GpsLiveData, workoutName: string | null): string {
  const unitPref = getState().unitPref ?? 'km';
  const scheme = getActiveSplitScheme();
  const totalDist = scheme?.totalDistance ?? 0;
  const distKm = data.totalDistance / 1000;
  const dist = formatKm(distKm, unitPref, 2);
  const elapsed = formatElapsed(data.elapsed);
  const pace = data.currentPace && data.currentPace > 0 ? formatPace(data.currentPace, unitPref) : '--:--';
  const avg = formatPace(avgPace(data), unitPref);
  const pct = totalDist > 0 ? Math.min(100, (data.totalDistance / totalDist) * 100) : 0;
  const targetPace = scheme?.segments[0]?.targetPace;

  const progressSection = totalDist > 0 ? `
    <div class="w-full max-w-xs mb-2">
      <div class="h-1.5 rounded-full overflow-hidden" style="background:var(--c-border)">
        <div id="rec-progress" class="h-full rounded-full transition-none" style="width:${pct}%;background:var(--c-ok)"></div>
      </div>
      <p class="text-xs text-center mt-1" style="color:var(--c-muted)">
        <span id="rec-dist">${dist}</span> / ${formatKm(totalDist / 1000, unitPref)}
      </p>
    </div>
  ` : `<p class="text-2xl font-bold mb-2" style="color:var(--c-black)"><span id="rec-dist">${dist}</span></p>`;

  return `
    <div class="flex-1 flex flex-col items-center justify-center px-6">
      <div class="flex items-center gap-2 mb-1">
        <span class="w-3 h-3 rounded-full animate-pulse" style="background:var(--c-warn)"></span>
        <span class="text-sm" style="color:var(--c-muted)">${workoutName ?? 'Run'}</span>
      </div>
      ${targetPace ? `<p class="text-xs mb-4" style="color:var(--c-accent)">Target: ${formatPace(targetPace, unitPref)}${paceUnit(unitPref)}</p>` : '<div class="mb-4"></div>'}
      <p id="rec-elapsed" class="text-6xl font-bold font-mono mb-6" style="color:var(--c-black)">${elapsed}</p>
      ${progressSection}
      <div class="grid grid-cols-2 gap-6 mb-8 w-full max-w-xs mt-4">
        <div class="text-center">
          <p id="rec-pace" class="text-3xl font-bold font-mono" style="color:var(--c-black)">${pace}</p>
          <p class="text-xs mt-1" style="color:var(--c-muted)">pace ${paceUnit(unitPref)}</p>
        </div>
        <div class="text-center">
          <p id="rec-avg-pace" class="text-2xl font-semibold font-mono" style="color:var(--c-muted)">${avg}</p>
          <p class="text-xs mt-1" style="color:var(--c-muted)">avg ${paceUnit(unitPref)}</p>
        </div>
      </div>
      <div class="flex gap-3">
        <button onclick="gpsPause()" class="px-6 py-3 m-btn-secondary rounded-xl font-medium">${isTrackingPaused() ? 'Resume' : 'Pause'}</button>
        <button onclick="gpsStop()" class="px-6 py-3 rounded-xl font-medium" style="background:#EF4444;color:white">Stop</button>
      </div>
    </div>
  `;
}

function patchSimpleStats(data: GpsLiveData): void {
  const unitPref = getState().unitPref ?? 'km';
  const elapsedEl = document.getElementById('rec-elapsed');
  const distEl = document.getElementById('rec-dist');
  const paceEl = document.getElementById('rec-pace');
  const avgEl = document.getElementById('rec-avg-pace');
  const progressEl = document.getElementById('rec-progress') as HTMLElement | null;

  if (elapsedEl) elapsedEl.textContent = formatElapsed(data.elapsed);
  if (distEl) distEl.textContent = formatKm(data.totalDistance / 1000, unitPref, 2);
  if (paceEl) paceEl.textContent = data.currentPace && data.currentPace > 0 ? formatPace(data.currentPace, unitPref) : '--:--';
  if (avgEl) avgEl.textContent = formatPace(avgPace(data), unitPref);

  if (progressEl) {
    const scheme = getActiveSplitScheme();
    const totalDist = scheme?.totalDistance ?? 0;
    if (totalDist > 0) {
      progressEl.style.width = `${Math.min(100, (data.totalDistance / totalDist) * 100)}%`;
    }
  }
}

// ---------------------------------------------------------------------------
// Phased UI — WU + main set + CD (no recovery gaps)
// ---------------------------------------------------------------------------

/** Short label for phase bar: strip common words to keep it compact */
function phaseBarLabel(label: string): string {
  return label
    .replace(/\bWarm\s+Up\b/i, 'WU')
    .replace(/\bCool\s+Down\b/i, 'CD')
    .replace(/\bEasy\b/i, '')
    .trim();
}

function buildPhasedBarHTML(data: GpsLiveData, scheme: SplitScheme): string {
  const currentIdx = data.completedSplits.length;
  const totalDist = scheme.totalDistance;
  const n = scheme.segments.length;

  const bars = scheme.segments.map((seg, i) => {
    const wpct = ((seg.distance / totalDist) * 100).toFixed(3);
    const roundL = i === 0 ? 'rounded-l-full' : '';
    const roundR = i === n - 1 ? 'rounded-r-full' : '';

    if (i < currentIdx) {
      return `<div style="width:${wpct}%;background:var(--c-ok)" class="h-full shrink-0 ${roundL} ${roundR}"></div>`;
    } else if (i === currentIdx) {
      const distInSeg = data.currentSplit?.distance ?? 0;
      const innerPct = seg.distance > 0
        ? Math.min(100, (distInSeg / seg.distance) * 100).toFixed(3)
        : '0';
      return `<div style="width:${wpct}%;background:rgba(0,0,0,0.08)" class="h-full shrink-0 overflow-hidden ${roundL} ${roundR}">
        <div id="rec-phase-fill" style="width:${innerPct}%;background:var(--c-accent)" class="h-full transition-none"></div>
      </div>`;
    } else {
      return `<div style="width:${wpct}%;background:rgba(0,0,0,0.08)" class="h-full shrink-0 ${roundL} ${roundR}"></div>`;
    }
  }).join('');

  const labels = scheme.segments.map((seg, i) => {
    const wpct = ((seg.distance / totalDist) * 100).toFixed(3);
    const isDone = i < currentIdx;
    const isCurrent = i === currentIdx;
    const colStyle = isDone
      ? `color:var(--c-ok)`
      : isCurrent
        ? `color:var(--c-accent);font-weight:600`
        : `color:var(--c-faint)`;
    const short = phaseBarLabel(seg.label);
    return `<div style="width:${wpct}%;${colStyle}" class="text-xs text-center truncate">${short}</div>`;
  }).join('');

  return `
    <div class="px-4 mb-4">
      <div class="flex h-4 gap-px w-full mb-1.5">${bars}</div>
      <div class="flex w-full">${labels}</div>
    </div>
  `;
}

function buildPhasedUI(data: GpsLiveData, workoutName: string | null): string {
  const unitPref = getState().unitPref ?? 'km';
  const scheme = getActiveSplitScheme()!;
  const currentIdx = data.completedSplits.length;
  const totalSegs = scheme.segments.length;
  const currentSeg = scheme.segments[currentIdx];
  const elapsed = formatElapsed(data.elapsed);
  const dist = formatKm(data.totalDistance / 1000, unitPref, 2);
  const pace = data.currentPace && data.currentPace > 0 ? formatPace(data.currentPace, unitPref) : '--:--';
  const avg = formatPace(avgPace(data), unitPref);
  const distInSeg = data.currentSplit?.distance ?? 0;
  const remaining = currentSeg ? Math.max(0, currentSeg.distance - distInSeg) : 0;

  return `
    <div class="flex-1 flex flex-col pt-4 overflow-hidden">
      ${recHeader(workoutName, `Phase ${Math.min(currentIdx + 1, totalSegs)} / ${totalSegs}`)}
      ${buildPhasedBarHTML(data, scheme)}
      <div class="m-card mx-4 p-4 mb-4">
        <p class="text-sm mb-1" style="color:var(--c-muted)">${currentSeg?.label ?? 'Complete'}</p>
        <p id="rec-current-seg-remaining" class="text-4xl font-bold mb-1" style="color:var(--c-black)">${fmtMeters(remaining, unitPref)}</p>
        ${currentSeg?.targetPace ? `<p class="text-sm" style="color:var(--c-accent)">${formatPace(currentSeg.targetPace, unitPref)}${paceUnit(unitPref)}</p>` : ''}
      </div>
      ${statsRow(elapsed, dist, pace, avg, unitPref)}
      ${controlButtons()}
    </div>
  `;
}

function patchPhasedStats(data: GpsLiveData): void {
  const unitPref = getState().unitPref ?? 'km';
  const elapsedEl = document.getElementById('rec-elapsed');
  const distEl = document.getElementById('rec-dist');
  const paceEl = document.getElementById('rec-pace');
  const avgEl = document.getElementById('rec-avg-pace');
  const remainEl = document.getElementById('rec-current-seg-remaining');
  const phaseFillEl = document.getElementById('rec-phase-fill') as HTMLElement | null;

  if (elapsedEl) elapsedEl.textContent = formatElapsed(data.elapsed);
  if (distEl) distEl.textContent = formatKm(data.totalDistance / 1000, unitPref, 2);
  if (paceEl) paceEl.textContent = data.currentPace && data.currentPace > 0 ? formatPace(data.currentPace, unitPref) : '--:--';
  if (avgEl) avgEl.textContent = formatPace(avgPace(data), unitPref);

  const scheme = getActiveSplitScheme();
  if (!scheme) return;

  const currentIdx = data.completedSplits.length;
  const currentSeg = scheme.segments[currentIdx];

  if (remainEl && currentSeg) {
    const distInSeg = data.currentSplit?.distance ?? 0;
    const updUnitPref = getState().unitPref ?? 'km';
    remainEl.textContent = fmtMeters(Math.max(0, currentSeg.distance - distInSeg), updUnitPref);
  }

  if (phaseFillEl && currentSeg && currentSeg.distance > 0) {
    const distInSeg = data.currentSplit?.distance ?? 0;
    phaseFillEl.style.width = `${Math.min(100, (distInSeg / currentSeg.distance) * 100)}%`;
  }

  // Phase completed — full re-render to update bar colours and current block
  if (currentIdx !== lastCompletedIdx) {
    lastCompletedIdx = currentIdx;
    renderRecordView();
  }
}

// ---------------------------------------------------------------------------
// Interval UI — rep + recovery workout
// ---------------------------------------------------------------------------

/** Format seconds as a compact time string for countdowns: "1:23" or "45s" */
function fmtCountdown(seconds: number): string {
  const s = Math.ceil(Math.max(0, seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}:${rem.toString().padStart(2, '0')}` : `${rem}s`;
}

/** Coloured phase badge from the current segment label */
function phaseBadge(label: string): { text: string; style: string } {
  const l = label.toLowerCase();
  if (l.includes('warm up'))   return { text: 'WARM UP',   style: `background:var(--c-caution-bg);color:var(--c-caution-text)` };
  if (l.includes('cool down')) return { text: 'COOL DOWN', style: `background:var(--c-ok-bg);color:var(--c-ok-text)` };
  if (l.includes('recovery'))  return { text: 'RECOVERY',  style: `background:rgba(0,0,0,0.06);color:var(--c-muted)` };
  if (l.includes('rep'))       return { text: 'INTERVAL',  style: `background:rgba(78,159,229,0.12);color:var(--c-accent)` };
  if (l.includes('fast km') || l.includes('tempo')) return { text: 'TEMPO', style: `background:rgba(245,158,11,0.12);color:var(--c-caution-text)` };
  return { text: 'ACTIVE', style: `background:rgba(0,0,0,0.06);color:var(--c-muted)` };
}

function buildSegmentListHTML(data: GpsLiveData, scheme: SplitScheme, unitPref: UnitPref = 'km'): string {
  const currentIdx = data.completedSplits.length;
  const segments = scheme.segments;
  const compact = segments.length > 6;

  return segments.map((seg, i) => {
    const distStr = seg.durationSeconds != null ? fmtCountdown(seg.durationSeconds) : fmtMeters(seg.distance, unitPref);
    const paceStr = seg.targetPace ? `${formatPace(seg.targetPace, unitPref)}${paceUnit(unitPref)}` : 'recovery';
    const isCompleted = i < currentIdx;
    const isCurrent = i === currentIdx;
    const isUpcoming = i > currentIdx;
    const iconChar = isCompleted ? '✓' : isCurrent ? '●' : '·';
    const iconStyle = isCompleted ? `color:var(--c-ok)` : isCurrent ? `color:var(--c-accent)` : `color:var(--c-faint)`;
    const rowStyle = isCurrent ? `background:rgba(78,159,229,0.07);border-radius:8px` : '';
    const rowOpacity = isUpcoming ? 'opacity-60' : '';
    const labelStyle = isCurrent ? `color:var(--c-black)` : `color:var(--c-muted)`;
    const idAttr = isCurrent ? 'id="rec-current-row"' : '';

    if (compact) {
      return `<div ${idAttr} class="flex items-center gap-2 px-2 py-1 ${rowOpacity}" style="${rowStyle}">
        <span class="w-5 text-center text-sm shrink-0" style="${iconStyle}">${iconChar}</span>
        <span class="flex-1 text-xs truncate" style="${labelStyle}">${seg.label}</span>
        <span class="text-xs shrink-0" style="color:var(--c-faint)">${distStr}</span>
        <span class="text-xs shrink-0 ml-1" style="color:var(--c-accent)">${paceStr}</span>
      </div>`;
    } else {
      return `<div ${idAttr} class="flex items-start gap-2 px-2 py-2 ${rowOpacity}" style="${rowStyle}">
        <span class="w-5 text-center text-base mt-0.5 shrink-0" style="${iconStyle}">${iconChar}</span>
        <div class="flex-1">
          <div class="text-sm" style="${labelStyle}">${seg.label}</div>
          <div class="text-xs" style="color:var(--c-faint)">${distStr} · ${paceStr}</div>
        </div>
      </div>`;
    }
  }).join('');
}

function buildIntervalUI(data: GpsLiveData, workoutName: string | null): string {
  const unitPref = getState().unitPref ?? 'km';
  const scheme = getActiveSplitScheme()!;
  const currentIdx = data.completedSplits.length;
  const totalSegs = scheme.segments.length;
  const currentSeg = scheme.segments[currentIdx];
  const elapsed = formatElapsed(data.elapsed);
  const dist = formatKm(data.totalDistance / 1000, unitPref, 2);
  const pace = data.currentPace && data.currentPace > 0 ? formatPace(data.currentPace, unitPref) : '--:--';
  const avg = formatPace(avgPace(data), unitPref);
  const isRecovery = currentSeg?.durationSeconds != null;
  const segElapsed = data.currentSplit?.elapsed ?? 0;
  const distInSeg = data.currentSplit?.distance ?? 0;

  // Remaining value — time (s) for recovery, distance (m) for work reps
  const remainingRaw = isRecovery
    ? Math.max(0, currentSeg!.durationSeconds! - segElapsed)
    : currentSeg ? Math.max(0, currentSeg.distance - distInSeg) : 0;

  // Big countdown in last 5 s; formatted time otherwise
  const remainingDisplay = isRecovery
    ? (remainingRaw <= 5 && remainingRaw > 0
        ? `<span style="font-size:3rem;font-weight:800;color:var(--c-warn);line-height:1">${Math.ceil(remainingRaw)}</span>`
        : `<span class="text-2xl font-bold" style="color:var(--c-black)">${fmtCountdown(remainingRaw)} left</span>`)
    : `<span class="text-2xl font-bold" style="color:var(--c-black)">${fmtMeters(remainingRaw, unitPref)}</span>`;

  const badge = phaseBadge(currentSeg?.label ?? '');

  return `
    <div class="flex-1 flex flex-col pt-3 overflow-hidden">
      <!-- Header: name + phase badge -->
      <div class="flex items-center gap-2 px-4 mb-3">
        <span class="w-2.5 h-2.5 rounded-full animate-pulse shrink-0" style="background:var(--c-warn)"></span>
        <span class="text-sm font-medium truncate" style="color:var(--c-black)">${workoutName ?? 'Workout'}</span>
        <span id="rec-phase-badge" class="ml-auto shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold" style="${badge.style}">${badge.text}</span>
      </div>

      <!-- Current segment — prominent, ABOVE the list -->
      <div class="m-card mx-4 px-4 py-3 mb-3">
        <div class="flex items-baseline justify-between gap-2">
          <p class="text-sm truncate" style="color:var(--c-muted)">${currentSeg?.label ?? 'Complete'}</p>
          <p id="rec-current-seg-remaining" class="shrink-0">${remainingDisplay}</p>
        </div>
        ${currentSeg?.targetPace
          ? `<p class="text-xs mt-0.5" style="color:var(--c-accent)">${formatPace(currentSeg.targetPace, unitPref)}${paceUnit(unitPref)}</p>`
          : `<p class="text-xs mt-0.5" style="color:var(--c-faint)">Walk or light jog</p>`}
      </div>

      <!-- Full segment list — fills remaining space, always visible -->
      <div id="rec-segment-list" class="mx-4 overflow-y-auto flex-1 min-h-0 mb-3 rounded-xl px-1 py-1" style="background:var(--c-bg)">
        ${buildSegmentListHTML(data, scheme, unitPref)}
      </div>

      ${statsRow(elapsed, dist, pace, avg, unitPref)}
      ${controlButtons()}
    </div>
  `;
}

function patchIntervalStats(data: GpsLiveData): void {
  const unitPref = getState().unitPref ?? 'km';
  const elapsedEl = document.getElementById('rec-elapsed');
  const distEl = document.getElementById('rec-dist');
  const paceEl = document.getElementById('rec-pace');
  const avgEl = document.getElementById('rec-avg-pace');
  const listEl = document.getElementById('rec-segment-list');
  const remainEl = document.getElementById('rec-current-seg-remaining');
  const badgeEl = document.getElementById('rec-phase-badge');

  if (elapsedEl) elapsedEl.textContent = formatElapsed(data.elapsed);
  if (distEl) distEl.textContent = formatKm(data.totalDistance / 1000, unitPref, 2);
  if (paceEl) paceEl.textContent = data.currentPace && data.currentPace > 0 ? formatPace(data.currentPace, unitPref) : '--:--';
  if (avgEl) avgEl.textContent = formatPace(avgPace(data), unitPref);

  const scheme = getActiveSplitScheme();
  if (!scheme) return;

  const currentIdx = data.completedSplits.length;
  const currentSeg = scheme.segments[currentIdx];

  if (remainEl && currentSeg) {
    if (currentSeg.durationSeconds != null) {
      // Time-based recovery: show countdown, big number in last 5 s
      const segElapsed = data.currentSplit?.elapsed ?? 0;
      const remaining = Math.max(0, currentSeg.durationSeconds - segElapsed);
      if (remaining <= 5 && remaining > 0) {
        remainEl.innerHTML = `<span style="font-size:3rem;font-weight:800;color:var(--c-warn);line-height:1">${Math.ceil(remaining)}</span>`;
      } else {
        remainEl.innerHTML = `<span class="text-2xl font-bold" style="color:var(--c-black)">${fmtCountdown(remaining)} left</span>`;
      }
    } else {
      const distInSeg = data.currentSplit?.distance ?? 0;
      remainEl.innerHTML = `<span class="text-2xl font-bold" style="color:var(--c-black)">${fmtMeters(Math.max(0, currentSeg.distance - distInSeg), unitPref)}</span>`;
    }
  }

  if (listEl) {
    listEl.innerHTML = buildSegmentListHTML(data, scheme, unitPref);
    if (currentIdx !== lastCompletedIdx) {
      // Full re-render on segment change (updates badge, hint text, remaining format).
      // Set lastCompletedIdx AFTER renderRecordView() because that function resets it to -1.
      renderRecordView();
      lastCompletedIdx = currentIdx;
      return;
    }
    document.getElementById('rec-current-row')?.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------------------
// Tick dispatcher
// ---------------------------------------------------------------------------

function updateRecordStats(data: GpsLiveData): void {
  const scheme = getActiveSplitScheme();
  if (scheme === null || scheme.segments.length === 0) {
    patchSimpleStats(data);
  } else if (isPhasedWorkout(scheme)) {
    patchPhasedStats(data);
  } else if (hasRecoverySegments(scheme)) {
    patchIntervalStats(data);
  } else {
    patchSimpleStats(data);
  }
}

// ---------------------------------------------------------------------------
// Root render
// ---------------------------------------------------------------------------

export function renderRecordView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;

  lastCompletedIdx = -1;

  setOnTrackingStart(() => renderRecordView());
  setOnTrackingStop(() => renderRecordView());

  const tracking = isTrackingActive();
  const liveData = getActiveGpsData();
  const workoutName = getActiveWorkoutName();

  let content: string;

  if (tracking && liveData) {
    const scheme = getActiveSplitScheme();
    let mode: 'simple' | 'phased' | 'interval' = 'simple';
    if (scheme && scheme.segments.length > 0) {
      if (isPhasedWorkout(scheme)) mode = 'phased';
      else if (hasRecoverySegments(scheme)) mode = 'interval';
    }

    if (mode === 'phased') {
      content = buildPhasedUI(liveData, workoutName);
    } else if (mode === 'interval') {
      content = buildIntervalUI(liveData, workoutName);
    } else {
      content = buildSimpleUI(liveData, workoutName);
    }

    setOnTrackingTick(updateRecordStats);
  } else {
    setOnTrackingTick(null);
    content = `
      <div class="flex-1 flex flex-col items-center justify-center px-6">
        <div class="flex items-center justify-center mb-4" style="width:64px;height:64px;border-radius:50%;background:rgba(0,0,0,0.06)">
          <svg class="w-8 h-8" style="color:var(--c-faint)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" stroke-width="2"/>
            <circle cx="12" cy="12" r="4" fill="currentColor"/>
          </svg>
        </div>
        <h2 class="text-lg font-semibold mb-2" style="color:var(--c-black)">Just Run</h2>
        <p class="text-sm text-center max-w-xs mb-6" style="color:var(--c-muted)">
          Unstructured run — we'll fit it into your plan automatically.
        </p>
        <button onclick="justRun()" class="m-btn-primary px-8 py-3 rounded-xl font-semibold">
          Start Run
        </button>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="flex flex-col pb-16" style="min-height:100vh;background:var(--c-bg)">
      <div style="background:var(--c-surface);border-bottom:1px solid var(--c-border)">
        <div class="max-w-7xl mx-auto px-4 py-4">
          <h1 class="text-xl font-semibold" style="color:var(--c-black)">Record</h1>
        </div>
      </div>
      ${content}
      ${renderTabBar('record', isSimulatorMode())}
    </div>
  `;

  wireTabBarHandlers(navigateTab);

  // Scroll interval list to current row after initial render
  if (tracking && liveData) {
    const scheme = getActiveSplitScheme();
    if (scheme && hasRecoverySegments(scheme)) {
      document.getElementById('rec-current-row')?.scrollIntoView({ block: 'nearest' });
    }
  }
}
