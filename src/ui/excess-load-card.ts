/**
 * Excess Load Card — persistent card on the Training tab showing unspent load
 * from overflow/surplus Garmin activities.
 *
 * Shows aerobic + anaerobic mini-bars, [Adjust Plan] and [Dismiss] buttons.
 * Tapping the card body opens a detail popup listing each UnspentLoadItem.
 */

import type { Week, UnspentLoadItem } from '@/types/state';
import { getMutableState, saveState } from '@/state';
import { render } from '@/ui/renderer';
import {
  normalizeSport,
  buildCrossTrainingPopup,
  workoutsToPlannedRuns,
  applyAdjustments,
  createActivity,
} from '@/cross-training';
import { showSuggestionModal } from '@/ui/suggestion-modal';
import { generateWeekWorkouts } from '@/workouts';
import { gp } from '@/calculations/paces';
import { mapAppTypeToSport } from '@/calculations/activity-matcher';
import type { WorkoutMod } from '@/types';

// ---------------------------------------------------------------------------
// Helper

function getWeekWorkoutsForExcess() {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk) return [];
  let wg = 0;
  for (let i = 0; i < s.w - 1; i++) wg += s.wks[i].wkGain;
  const currentVDOT = s.v + wg + s.rpeAdj + (s.physioAdj || 0);
  const previousSkips = s.w > 1 ? s.wks[s.w - 2].skip : [];
  let trailingEffort = 0;
  const lookback = Math.min(3, s.w - 1);
  if (lookback > 0) {
    let total = 0; let count = 0;
    for (let i = s.w - 2; i >= s.w - 1 - lookback && i >= 0; i--) {
      if (s.wks[i].effortScore != null) { total += s.wks[i].effortScore!; count++; }
    }
    if (count > 0) trailingEffort = total / count;
  }
  return generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, previousSkips, s.commuteConfig,
    (s as any).injuryState || null, s.recurringActivities,
    s.onboarding?.experienceLevel,
    (s.maxHR || s.restingHR || s.onboarding?.age)
      ? { lthr: undefined, maxHR: s.maxHR, restingHR: s.restingHR, age: s.onboarding?.age }
      : undefined,
    gp(currentVDOT, s.lt).e, s.w, s.tw, currentVDOT, s.gs, trailingEffort,
  );
}

function miniBar(value: number, max: number, colorClass: string): string {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return `<div class="flex-1 bg-gray-700 rounded-full h-1.5 overflow-hidden">
    <div class="${colorClass} h-full rounded-full" style="width: ${pct}%"></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Returns the excess load card HTML, or empty string if no unspent items.
 * Wire up events by calling wireExcessLoadCard() after inserting into DOM.
 */
export function renderExcessLoadCard(wk: Week | undefined): string {
  if (!wk) return '';
  const items = wk.unspentLoadItems;

  if (!items?.length) {
    return `
      <div class="bg-gray-900/40 border border-gray-800 rounded-lg px-3 py-2.5 flex items-center justify-between">
        <div>
          <p class="text-gray-500 text-xs font-medium">Excess Load</p>
          <p class="text-gray-600 text-xs mt-0.5">No overflow — all activities matched to plan slots</p>
        </div>
      </div>`;
  }

  const totalAerobic   = items.reduce((sum, i) => sum + i.aerobic, 0);
  const totalAnaerobic = items.reduce((sum, i) => sum + i.anaerobic, 0);
  const maxVal = Math.max(totalAerobic, totalAnaerobic, 1);

  return `
    <div id="excess-load-card" class="bg-amber-950/30 border border-amber-800/50 rounded-lg p-3 cursor-pointer">
      <div class="flex items-start justify-between gap-2 mb-2">
        <div>
          <p class="text-amber-300 text-sm font-medium">Excess Activity Load</p>
          <p class="text-xs text-amber-400/70 mt-0.5">${items.length} activit${items.length === 1 ? 'y' : 'ies'} not yet applied to plan</p>
        </div>
        <span class="text-xs text-amber-500 mt-0.5">Tap for details</span>
      </div>
      <div class="space-y-1.5 mb-3">
        <div class="flex items-center gap-2 text-xs">
          <span class="text-gray-400 w-16 shrink-0">Aerobic</span>
          ${miniBar(totalAerobic, maxVal, 'bg-red-400')}
          <span class="text-gray-400 w-8 text-right">${totalAerobic.toFixed(1)}</span>
        </div>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-gray-400 w-16 shrink-0">Anaerobic</span>
          ${miniBar(totalAnaerobic, maxVal, 'bg-amber-400')}
          <span class="text-gray-400 w-8 text-right">${totalAnaerobic.toFixed(1)}</span>
        </div>
      </div>
      <div class="flex gap-2">
        <button id="excess-adjust-btn"
                class="flex-1 py-1.5 bg-amber-700/60 hover:bg-amber-700 text-amber-100 text-xs font-medium rounded-lg transition-colors">
          Adjust Plan
        </button>
        <button id="excess-dismiss-btn"
                class="px-3 py-1.5 bg-gray-700/60 hover:bg-gray-700 text-gray-300 text-xs font-medium rounded-lg transition-colors">
          Dismiss
        </button>
      </div>
      <p id="excess-dismiss-warning" class="hidden text-xs text-red-400 mt-2">
        Dismissing will remove this load without adjusting your plan. Tap Dismiss again to confirm.
      </p>
    </div>`;
}

/**
 * Wire up event handlers on the excess load card after render.
 * Call this from main-view.ts wireEventHandlers() whenever the card exists in DOM.
 */
export function wireExcessLoadCard(): void {
  const card = document.getElementById('excess-load-card');
  if (!card) return;

  const s   = getMutableState();
  const wk  = s.wks?.[s.w - 1];
  if (!wk?.unspentLoadItems?.length) return;

  // Tap card body → popup (not on buttons)
  card.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('#excess-adjust-btn') || target.closest('#excess-dismiss-btn')) return;
    showExcessLoadPopup(wk.unspentLoadItems!);
  });

  // Adjust Plan
  document.getElementById('excess-adjust-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerExcessLoadAdjustment();
  });

  // Dismiss (two-tap confirmation)
  let dismissWarningShown = false;
  document.getElementById('excess-dismiss-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const warning = document.getElementById('excess-dismiss-warning');
    if (!dismissWarningShown) {
      dismissWarningShown = true;
      warning?.classList.remove('hidden');
      return;
    }
    // Second tap — confirm clear
    const s2  = getMutableState();
    const wk2 = s2.wks?.[s2.w - 1];
    if (wk2) {
      wk2.unspentLoadItems = [];
    }
    saveState();
    render();
  });
}

// ---------------------------------------------------------------------------
// Popup

function showExcessLoadPopup(items: UnspentLoadItem[]): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 bg-black/70 flex items-end justify-center';

  const totalAerobic   = items.reduce((sum, i) => sum + i.aerobic, 0);
  const totalAnaerobic = items.reduce((sum, i) => sum + i.anaerobic, 0);
  const maxVal = Math.max(totalAerobic, totalAnaerobic, 1);

  const itemRows = items.map(item => {
    const iMax = Math.max(item.aerobic, item.anaerobic, 1);
    return `
      <div class="border-t border-gray-800 pt-3">
        <div class="flex justify-between items-center mb-1">
          <p class="text-white text-sm font-medium">${escHtml(item.displayName)}</p>
          <span class="text-xs text-gray-500">${Math.round(item.durationMin)} min</span>
        </div>
        <p class="text-xs text-gray-400 mb-2">${escHtml(item.sport)} · ${new Date(item.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</p>
        <div class="space-y-1">
          <div class="flex items-center gap-2 text-xs">
            <span class="text-gray-400 w-16 shrink-0">Aerobic</span>
            ${miniBar(item.aerobic, iMax, 'bg-red-400')}
            <span class="text-gray-400 w-8 text-right">${item.aerobic.toFixed(1)}</span>
          </div>
          <div class="flex items-center gap-2 text-xs">
            <span class="text-gray-400 w-16 shrink-0">Anaerobic</span>
            ${miniBar(item.anaerobic, iMax, 'bg-amber-400')}
            <span class="text-gray-400 w-8 text-right">${item.anaerobic.toFixed(1)}</span>
          </div>
        </div>
      </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="bg-gray-900 rounded-t-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
         style="padding-bottom: env(safe-area-inset-bottom, 0px)">
      <div class="px-4 pt-4 pb-3 border-b border-gray-800">
        <div class="flex items-center justify-between">
          <h2 class="text-white font-semibold">Excess Activity Load</h2>
          <button id="elp-close" class="text-gray-400 text-xl leading-none">✕</button>
        </div>
        <p class="text-xs text-gray-400 mt-1">${items.length} activit${items.length === 1 ? 'y' : 'ies'} with unspent load</p>
        <div class="space-y-1.5 mt-3">
          <div class="flex items-center gap-2 text-xs">
            <span class="text-gray-400 w-16 shrink-0">Total Aero</span>
            ${miniBar(totalAerobic, maxVal, 'bg-red-400')}
            <span class="text-gray-400 w-8 text-right">${totalAerobic.toFixed(1)}</span>
          </div>
          <div class="flex items-center gap-2 text-xs">
            <span class="text-gray-400 w-16 shrink-0">Total An.</span>
            ${miniBar(totalAnaerobic, maxVal, 'bg-amber-400')}
            <span class="text-gray-400 w-8 text-right">${totalAnaerobic.toFixed(1)}</span>
          </div>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        ${itemRows}
      </div>
      <div class="px-4 py-3 border-t border-gray-800 flex gap-2">
        <button id="elp-adjust"
                class="flex-1 py-2.5 bg-amber-700/60 hover:bg-amber-700 text-amber-100 text-sm font-medium rounded-xl transition-colors">
          Adjust Plan
        </button>
        <button id="elp-close2"
                class="px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors">
          Close
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#elp-close')?.addEventListener('click', close);
  overlay.querySelector('#elp-close2')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#elp-adjust')?.addEventListener('click', () => {
    close();
    triggerExcessLoadAdjustment();
  });
}

// ---------------------------------------------------------------------------
// Trigger reduce/replace modal

function triggerExcessLoadAdjustment(): void {
  const s  = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk?.unspentLoadItems?.length) return;

  const items = wk.unspentLoadItems;

  // Build a combined cross-training activity from all unspent items
  const totalDurationMin = items.reduce((sum, i) => sum + i.durationMin, 0);
  const totalAerobic     = items.reduce((sum, i) => sum + i.aerobic, 0);
  const totalAnaerobic   = items.reduce((sum, i) => sum + i.anaerobic, 0);

  // Dominant sport by duration (approximation since we don't track per-item duration-weighted)
  const sport = items[0]?.sport ?? 'Cross-training';

  const avgRPE = Math.min(9, Math.max(3, Math.round(
    (totalAerobic > 3.5 ? 7 : totalAerobic > 2.5 ? 5 : 4)
  )));

  const combinedActivity = createActivity(sport, Math.round(totalDurationMin), avgRPE, undefined, undefined, s.w);
  // Attach most recent date
  const mostRecent = items.reduce((a, b) => (a.date > b.date ? a : b));
  const jsDay = new Date(mostRecent.date).getDay();
  combinedActivity.dayOfWeek = jsDay === 0 ? 6 : jsDay - 1;

  const freshWorkouts = getWeekWorkoutsForExcess().filter(w => wk.rated[w.id || w.n] === undefined);
  const weekRuns      = workoutsToPlannedRuns(freshWorkouts, s.pac);
  const ctx = { raceGoal: s.rd, plannedRunsPerWeek: s.rw, injuryMode: !!(s as any).injuryState, easyPaceSecPerKm: s.pac?.e, runnerType: s.typ as 'Speed' | 'Endurance' | 'Balanced' | undefined };
  const popup = buildCrossTrainingPopup(ctx, weekRuns, combinedActivity);

  const sportLabel = items.length === 1 ? items[0].displayName : `${items.length} activities`;

  showSuggestionModal(popup, sportLabel, (decision) => {
    if (!decision) return;

    const s3  = getMutableState();
    const wk3 = s3.wks?.[s3.w - 1];
    if (!wk3) return;

    if (decision.choice !== 'keep' && decision.adjustments.length > 0) {
      const freshW   = getWeekWorkoutsForExcess();
      const modified = applyAdjustments(freshW, decision.adjustments, normalizeSport(sport), s3.pac);
      if (!wk3.workoutMods) wk3.workoutMods = [];
      for (const adj of decision.adjustments) {
        const mw = modified.find(w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex);
        if (!mw) continue;
        wk3.workoutMods.push({
          name: mw.n, dayOfWeek: mw.dayOfWeek, status: mw.status || 'reduced',
          // Always use "Garmin: <label>" so openActivityReReview() cleanup filter works
          modReason: `Garmin: ${sportLabel}`, confidence: mw.confidence,
          originalDistance: mw.originalDistance, newDistance: mw.d, newType: mw.t, newRpe: mw.rpe || mw.r,
        } as WorkoutMod);
      }
    }

    // Clear the unspent items once plan is adjusted
    wk3.unspentLoadItems = [];
    wk3.unspentLoad = 0;

    saveState();
    render();
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
