/**
 * Excess Load Card — persistent card on the Training tab showing unspent load
 * from overflow/surplus Garmin activities.
 *
 * Shows aerobic + anaerobic mini-bars, [Adjust Plan] and [Dismiss] buttons.
 * Tapping the card body opens a detail popup listing each UnspentLoadItem.
 */

import type { Week, UnspentLoadItem } from '@/types/state';
import type { SportKey } from '@/types';
import { SPORTS_DB, TL_PER_MIN } from '@/constants';
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

function miniBar(value: number, max: number, color: string): string {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return `<div style="flex:1;background:rgba(0,0,0,0.08);border-radius:4px;height:4px;overflow:hidden">
    <div style="background:${color};height:100%;border-radius:4px;width:${pct}%"></div>
  </div>`;
}

/** Compute TSS-equivalent for an unspent item (same formula as computeWeekTSS fallback) */
function itemTL(item: UnspentLoadItem): number {
  const cfg = (SPORTS_DB as any)[item.sport];
  const runSpec: number = cfg?.runSpec ?? 0.35;
  return Math.round(item.durationMin * (TL_PER_MIN[5] ?? 1.15) * runSpec);
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
      <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between">
        <div>
          <p style="color:var(--c-muted);font-size:12px;font-weight:500">Excess Load</p>
          <p style="color:var(--c-faint);font-size:12px;margin-top:2px">No overflow — all activities matched to plan slots</p>
        </div>
      </div>`;
  }

  const totalTL     = items.reduce((sum, i) => sum + itemTL(i), 0);
  const totalImpact = items.reduce((sum, i) => sum + i.durationMin * (SPORTS_DB[i.sport as SportKey]?.impactPerMin ?? 0), 0);
  const impactColor = totalImpact <= 0 ? '#16a34a'
    : totalImpact < 4   ? '#16a34a'
    : totalImpact < 10  ? 'var(--c-caution)'
    :                     'var(--c-warn)';
  const impactText = totalImpact <= 0 ? 'No leg impact'
    : totalImpact < 4   ? 'Low leg impact'
    : totalImpact < 10  ? 'Moderate leg impact'
    :                     'High leg impact';

  return `
    <div id="excess-load-card" style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.3);border-radius:10px;padding:12px;cursor:pointer">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px">
        <div>
          <p style="color:var(--c-caution);font-size:13px;font-weight:500">Excess Activity Load</p>
          <p style="font-size:12px;color:rgba(245,158,11,0.7);margin-top:2px">${items.length} activit${items.length === 1 ? 'y' : 'ies'} not yet applied to plan</p>
        </div>
        <span style="font-size:12px;color:var(--c-caution);margin-top:2px">Tap for details</span>
      </div>
      <div style="margin-bottom:10px">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
          <span style="font-size:18px;font-weight:700;color:var(--c-black)">${totalTL}</span>
          <span style="font-size:12px;color:var(--c-faint)">TSS unspent</span>
        </div>
        <p style="font-size:10px;color:var(--c-faint)">Training stress not yet applied to plan</p>
        <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:6px">
          <span style="color:${impactColor}">${impactText}</span>
          <button id="excess-impact-info" style="font-size:9px;color:var(--c-faint);border:1px solid var(--c-border);border-radius:50%;width:14px;height:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:none;cursor:pointer;padding:0">?</button>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button id="excess-adjust-btn"
                style="flex:1;padding:8px;background:rgba(245,158,11,0.15);color:var(--c-caution);font-size:12px;font-weight:500;border:none;border-radius:8px;cursor:pointer">
          Adjust Plan
        </button>
        <button id="excess-dismiss-btn"
                style="padding:8px 14px;background:var(--c-bg);color:var(--c-muted);font-size:12px;font-weight:500;border:1px solid var(--c-border);border-radius:8px;cursor:pointer">
          Dismiss
        </button>
      </div>
      <p id="excess-dismiss-warning" style="display:none;font-size:12px;color:var(--c-warn);margin-top:8px">
        Dismissing will remove this load without adjusting your plan. Tap Dismiss again to confirm.
      </p>
    </div>`;
}

function showImpactInfoSheet(): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.5);display:flex;align-items:flex-end;justify-content:center';
  overlay.innerHTML = `
    <div style="background:var(--c-surface);border-radius:16px 16px 0 0;width:100%;max-width:480px;padding-bottom:env(safe-area-inset-bottom,0px)">
      <div style="padding:16px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;justify-content:space-between">
        <h2 style="color:var(--c-black);font-weight:600;font-size:16px">Leg Impact</h2>
        <button id="impact-sheet-close" style="color:var(--c-muted);font-size:18px;background:none;border:none;cursor:pointer;padding:0">✕</button>
      </div>
      <div style="padding:16px;display:flex;flex-direction:column;gap:14px;font-size:14px">
        <p style="color:var(--c-muted);line-height:1.6">Leg impact tracks musculoskeletal stress from activities that load your joints and tendons — separate from cardiovascular fitness stress (TSS).</p>
        <p style="color:var(--c-faint);line-height:1.6">Running creates high impact per minute. Court sports like tennis and padel create moderate impact. Cycling and swimming create almost none.</p>
        <div style="background:var(--c-bg);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px">
          <p style="color:var(--c-faint);font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.05em">Impact levels</p>
          <div style="display:flex;align-items:center;gap:8px;font-size:12px"><div style="width:8px;height:8px;border-radius:50%;background:#16a34a;flex-shrink:0"></div><span style="color:#16a34a">None / Low</span><span style="color:var(--c-faint);margin-left:4px">— cycling, swimming, yoga, rowing</span></div>
          <div style="display:flex;align-items:center;gap:8px;font-size:12px"><div style="width:8px;height:8px;border-radius:50%;background:var(--c-caution);flex-shrink:0"></div><span style="color:var(--c-caution)">Moderate</span><span style="color:var(--c-faint);margin-left:4px">— tennis, padel, hiking, basketball</span></div>
          <div style="display:flex;align-items:center;gap:8px;font-size:12px"><div style="width:8px;height:8px;border-radius:50%;background:var(--c-warn);flex-shrink:0"></div><span style="color:var(--c-warn)">High</span><span style="color:var(--c-faint);margin-left:4px">— running, jump rope, stair climbing</span></div>
        </div>
        <p style="color:var(--c-faint);font-size:12px">High leg impact from unplanned activities may increase injury risk even if your TSS looks manageable. Consider reducing your next run if leg impact is high.</p>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#impact-sheet-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
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
    if (target.closest('#excess-adjust-btn') || target.closest('#excess-dismiss-btn') || target.closest('#excess-impact-info')) return;
    showExcessLoadPopup(wk.unspentLoadItems!);
  });

  // Leg impact info button
  document.getElementById('excess-impact-info')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showImpactInfoSheet();
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
      if (warning) warning.style.display = '';
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
  overlay.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.5);display:flex;align-items:flex-end;justify-content:center';

  const totalTL = items.reduce((sum, i) => sum + itemTL(i), 0);

  const itemRows = items.map(item => {
    const tl = itemTL(item);
    return `
      <div style="border-top:1px solid var(--c-border);padding-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
          <p style="color:var(--c-black);font-size:14px;font-weight:500">${escHtml(item.displayName)}</p>
          <span style="color:var(--c-ok);font-weight:500;font-size:14px">${tl} TSS</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--c-muted)">
          <span>${Math.round(item.durationMin)} min</span>
          <span>·</span>
          <span>${escHtml(item.sport)}</span>
          <span>·</span>
          <span>${new Date(item.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          <span style="color:var(--c-faint);margin-left:4px">aerobic</span>
        </div>
      </div>`;
  }).join('');

  overlay.innerHTML = `
    <div style="background:var(--c-surface);border-radius:16px 16px 0 0;width:100%;max-width:480px;max-height:80vh;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom,0px)">
      <div style="padding:16px;border-bottom:1px solid var(--c-border)">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <h2 style="color:var(--c-black);font-weight:600;font-size:16px">Excess Activity Load</h2>
          <button id="elp-close" style="color:var(--c-muted);font-size:18px;background:none;border:none;cursor:pointer;padding:0">✕</button>
        </div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-top:8px">
          <span style="font-size:20px;font-weight:700;color:var(--c-black)">${totalTL}</span>
          <span style="font-size:13px;color:var(--c-muted)">TSS unspent</span>
        </div>
        <p style="font-size:10px;color:var(--c-faint);margin-top:2px">Training stress not yet applied to plan</p>
      </div>
      <div style="flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px">
        ${itemRows}
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--c-border);display:flex;gap:8px">
        <button id="elp-adjust"
                style="flex:1;padding:12px;background:rgba(245,158,11,0.15);color:var(--c-caution);font-size:14px;font-weight:500;border:none;border-radius:10px;cursor:pointer">
          Adjust Plan
        </button>
        <button id="elp-close2"
                style="padding:12px 18px;background:var(--c-bg);color:var(--c-muted);font-size:14px;font-weight:500;border:1px solid var(--c-border);border-radius:10px;cursor:pointer">
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
