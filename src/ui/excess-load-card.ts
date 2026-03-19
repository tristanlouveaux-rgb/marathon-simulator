/**
 * Excess Load Card — amber card on the Training tab when total week Signal B
 * exceeds the composite planned target (running plan + cross-training budget).
 *
 * Excess is detected from the FULL Signal B picture — matched activities that
 * were harder than expected, extra sessions, heavy cross-training — everything.
 * Whether activities matched plan slots or not is irrelevant to detection.
 *
 * Three-tier response:
 *   Tier 1 (≤15 TSS excess): silently auto-reduce. No card.
 *   Tier 2 (15–40 TSS): amber card. Tap to adjust plan.
 *   Tier 3 (>40 TSS or elevated ACWR): blocking modal fires instead.
 */

import type { Week } from '@/types/state';
import { SPORTS_DB } from '@/constants';
import { getMutableState, saveState } from '@/state';
import { getWeeklyExcess, computePlannedSignalB } from '@/calculations/fitness-model';
import { computeRecoveryTrend } from '@/calculations/readiness';
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


// ---------------------------------------------------------------------------
// Public API

/**
 * Compute the total week Signal B excess vs the composite planned target.
 * Returns 0 when no plan data is available.
 */
function computeTotalWeekExcess(wk: Week, s: ReturnType<typeof getMutableState>): number {
  const plannedB = computePlannedSignalB(
    s.historicWeeklyTSS, s.ctlBaseline, wk.ph ?? 'base',
    s.athleteTierOverride ?? s.athleteTier, s.rw, undefined, undefined, s.sportBaselineByType,
  );
  if (!plannedB) return 0;
  return getWeeklyExcess(wk, plannedB, s.planStartDate);
}

/**
 * Returns the excess load card HTML, or empty string if no excess in Tier 2 range.
 * Wire up events by calling wireExcessLoadCard() after inserting into DOM.
 *
 * Detection is now total-week Signal B vs plannedSignalB — not limited to unspent items.
 */
export function renderExcessLoadCard(wk: Week | undefined): string {
  if (!wk) return '';

  // Tier 1 auto-reduce: excess was silently absorbed — don't show the card
  if (wk.workoutMods?.some(m => m.modReason?.startsWith('Auto:'))) return '';

  const _s = getMutableState();

  // No plan data yet — skip (can't compute meaningful target)
  if (!_s.historicWeeklyTSS?.length && !_s.ctlBaseline) return '';

  const excess = computeTotalWeekExcess(wk, _s);

  // Tier 2: amber card only for 15–40 TSS excess.
  // Below 15: Tier 1 auto-handles. Above 40 or ACWR elevated: Tier 3 modal fires instead.
  if (excess < 15 || excess > 40) return '';

  return `
    <div id="excess-load-card" style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.3);border-radius:10px;padding:12px;cursor:pointer">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px">
        <div>
          <p style="color:var(--c-caution);font-size:13px;font-weight:500">Excess Activity Load</p>
          <p style="font-size:12px;color:rgba(245,158,11,0.7);margin-top:2px">${excess} TSS above your usual week</p>
        </div>
        <span style="font-size:12px;color:var(--c-caution);margin-top:2px">Adjust plan</span>
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
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
        Tap Dismiss again to confirm — this won't adjust your plan.
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

  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk) return;

  // Adjust Plan
  document.getElementById('excess-adjust-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerExcessLoadAdjustment();
  });

  // Dismiss (two-tap confirmation) — just dismisses the card for this render cycle
  // by marking the week as excess-dismissed. Does not clear activity data.
  let dismissWarningShown = false;
  document.getElementById('excess-dismiss-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const warning = document.getElementById('excess-dismiss-warning');
    if (!dismissWarningShown) {
      dismissWarningShown = true;
      if (warning) warning.style.display = '';
      return;
    }
    // Second tap — add an auto-mod note so Tier 1 suppression hides the card
    const s2 = getMutableState();
    const wk2 = s2.wks?.[s2.w - 1];
    if (wk2) {
      if (!wk2.workoutMods) wk2.workoutMods = [];
      wk2.workoutMods.push({
        name: '__excess_dismissed__',
        dayOfWeek: 0,
        status: 'reduced',
        modReason: 'Auto: excess dismissed',
      } as any);
    }
    saveState();
    render();
  });
}

// ---------------------------------------------------------------------------
// Trigger reduce/replace modal

/**
 * Compute weighted runSpec for the week's activities.
 * Excess from running (runSpec 1.0) → full reduction. Cycling (0.55) → smaller reduction.
 */
function computeWeightedRunSpec(wk: Week): number {
  let totalRawTSS = 0;
  let weightedSum = 0;
  const ITRIMP_NORMALIZER = 15000;
  const seenIds = new Set<string>();

  for (const actual of Object.values(wk.garminActuals ?? {})) {
    if (actual.garminId && seenIds.has(actual.garminId)) continue;
    if (actual.garminId) seenIds.add(actual.garminId);
    if (!actual.iTrimp || actual.iTrimp <= 0) continue;
    const tss = (actual.iTrimp * 100) / ITRIMP_NORMALIZER;
    const sportKey = normalizeSport(actual.displayName || actual.workoutName || '');
    const cfg = (SPORTS_DB as any)[sportKey];
    // Running: actuals from plan slots have no activityType or activityType=RUNNING
    const aType = (actual.activityType || '').toUpperCase();
    const isRun = aType === 'RUNNING' || aType.includes('RUN') || (!aType && actual.avgPaceSecKm != null && actual.avgPaceSecKm > 0);
    const runSpec = isRun ? 1.0 : (cfg?.runSpec ?? 0.35);
    totalRawTSS += tss;
    weightedSum += tss * runSpec;
  }
  for (const w of wk.adhocWorkouts ?? []) {
    const rawId = w.id?.startsWith('garmin-') ? w.id.slice('garmin-'.length) : null;
    if (rawId && seenIds.has(rawId)) continue;
    if (rawId) seenIds.add(rawId);
    if (!w.iTrimp || w.iTrimp <= 0) continue;
    const tss = (w.iTrimp * 100) / ITRIMP_NORMALIZER;
    const sportKey = normalizeSport(w.n.replace(' (Garmin)', '').toLowerCase());
    const cfg = (SPORTS_DB as any)[sportKey];
    const runSpec = cfg?.runSpec ?? 0.35;
    totalRawTSS += tss;
    weightedSum += tss * runSpec;
  }

  return totalRawTSS > 0 ? weightedSum / totalRawTSS : 0.7; // default mid-range
}

export function triggerExcessLoadAdjustment(): void {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk) return;

  // Compute total week excess (Signal B vs plannedSignalB)
  const excess = computeTotalWeekExcess(wk, s);
  const hasCarriedItems = (wk.unspentLoadItems?.length ?? 0) > 0;
  // Allow carry-over card to open even when current-week excess is ≤ 0 —
  // the items were unresolved from last week and are already in state.
  if (excess <= 0 && !hasCarriedItems) return;

  // Recovery trend multiplier — modulates how aggressively we reduce.
  // Passed to buildCrossTrainingPopup which inflates runReplacementCredit accordingly.
  const recoveryMultiplier = s.physiologyHistory?.length
    ? computeRecoveryTrend(s.physiologyHistory)
    : 1.0;

  // Build a combined activity representing the total week excess.
  // Primary source: unspent items (when present).
  // Fallback: synthetic activity from excess TSS (iTrimp = excessTSS * 150).
  let sport: string;
  let combinedActivity: ReturnType<typeof createActivity>;
  let sportLabel: string;

  const items = wk.unspentLoadItems ?? [];
  if (items.length > 0) {
    sport = items[0]?.sport ?? 'cross_training';
    const totalDurationMin = items.reduce((sum, i) => sum + i.durationMin, 0);
    const totalAerobic = items.reduce((sum, i) => sum + i.aerobic, 0);
    const avgRPE = Math.min(9, Math.max(3, Math.round(totalAerobic > 3.5 ? 7 : totalAerobic > 2.5 ? 5 : 4)));
    combinedActivity = createActivity(sport, Math.round(totalDurationMin), avgRPE, undefined, undefined, s.w);
    const mostRecent = items.reduce((a, b) => (a.date > b.date ? a : b));
    const jsDay = new Date(mostRecent.date).getDay();
    combinedActivity.dayOfWeek = jsDay === 0 ? 6 : jsDay - 1;
    sportLabel = items.length === 1 ? items[0].displayName : `${items.length} activities`;
  } else {
    // No unspent items — excess came from matched activities being harder than expected.
    // Create a synthetic activity representing the excess TSS so the suggester can
    // size reductions correctly. iTrimp = excessTSS * 150 (inverse of TSS = iTrimp*100/15000).
    sport = 'cross_training';
    const syntheticDurationMin = Math.round(excess * 2); // rough estimate
    combinedActivity = createActivity(sport, syntheticDurationMin, 5, undefined, undefined, s.w);
    combinedActivity.iTrimp = excess * 150;
    combinedActivity.dayOfWeek = 6; // end of week
    sportLabel = 'Week overload';
  }

  const freshWorkouts = getWeekWorkoutsForExcess().filter(w => wk.rated[w.id || w.n] === undefined);
  const weekRuns = workoutsToPlannedRuns(freshWorkouts, s.pac);
  const ctx = {
    raceGoal: s.rd, plannedRunsPerWeek: s.rw,
    injuryMode: !!(s as any).injuryState, easyPaceSecPerKm: s.pac?.e,
    runnerType: s.typ as 'Speed' | 'Endurance' | 'Balanced' | undefined,
  };
  const popup = buildCrossTrainingPopup(ctx, weekRuns, combinedActivity, undefined, recoveryMultiplier);

  showSuggestionModal(popup, sportLabel, (decision) => {
    if (!decision) return;

    const s3 = getMutableState();
    const wk3 = s3.wks?.[s3.w - 1];
    if (!wk3) return;

    if (decision.choice !== 'keep' && decision.adjustments.length > 0) {
      const freshW = getWeekWorkoutsForExcess();
      const modified = applyAdjustments(freshW, decision.adjustments, normalizeSport(sport), s3.pac);
      if (!wk3.workoutMods) wk3.workoutMods = [];
      for (const adj of decision.adjustments) {
        const mw = modified.find(w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex);
        if (!mw) continue;
        wk3.workoutMods.push({
          name: mw.n, dayOfWeek: mw.dayOfWeek, status: mw.status || 'reduced',
          modReason: `Garmin: ${sportLabel}`, confidence: mw.confidence,
          originalDistance: mw.originalDistance, newDistance: mw.d, newType: mw.t, newRpe: mw.rpe || mw.r,
        } as WorkoutMod);
      }
    }

    // Clear unspent items after adjustment
    wk3.unspentLoadItems = [];
    wk3.unspentLoad = 0;

    saveState();
    render();
  });
}

