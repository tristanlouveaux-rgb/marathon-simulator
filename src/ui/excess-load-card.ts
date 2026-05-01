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
import { SPORTS_DB, TL_PER_MIN } from '@/constants';
import { getMutableState, saveState } from '@/state';
import { getWeeklyExcess, computePlannedSignalB, getTrailingEffortScore, computeDecayedCarry, computeACWR, computeRunningFloorKm } from '@/calculations/fitness-model';
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
import { isTimingMod } from '@/cross-training/timing-check';
import type { WorkoutMod } from '@/types';
import { formatKm } from '@/utils/format';

// ---------------------------------------------------------------------------
// Helpers

/**
 * Generates workouts for the current week (offset=0) or next week (offset=1).
 * Must match getPlanHTML call exactly so workout names/IDs align with plan-view and wk.rated keys.
 */
function getWeekWorkouts(offset: 0 | 1 = 0) {
  const s = getMutableState();
  const weekIdx = s.w - 1 + offset; // 0-indexed
  const wk = s.wks?.[weekIdx];
  if (!wk) return [];
  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w + offset, s.tw, s.v, s.gs,
    getTrailingEffortScore(s.wks, s.w + offset), wk.scheduledAcwrStatus,
  );

  // Apply stored workoutMods so the modal reflects the actual plan state (matching plan-view.ts).
  for (const mod of wk.workoutMods ?? []) {
    if (isTimingMod(mod.modReason)) continue;
    const w = workouts.find((wo: any) => wo.n === mod.name && (mod.dayOfWeek == null || wo.dayOfWeek === mod.dayOfWeek));
    if (!w) continue;
    if (mod.originalDistance != null) (w as any).originalDistance = mod.originalDistance;
    (w as any).status = mod.status;
    if (mod.newDistance != null) (w as any).d = mod.newDistance;
    if (mod.newType) (w as any).t = mod.newType;
  }

  return workouts.filter((w: any) => w.status !== 'replaced');
}

/**
 * Filters a workout list to only those that can still be done or reduced:
 * unrated AND whose actual calendar date is today or later.
 * Uses absolute dates so workouts from a past week never appear as upcoming
 * even if s.w hasn't advanced yet.
 */
function filterRemainingWorkouts<T extends { id?: string; n: string; dayOfWeek?: number }>(
  workouts: T[],
  _wk: Week,
  _weekIdx: number,
  _planStartDate: string,
): T[] {
  // "Remaining" = unrated only. Past-day unrated runs stay eligible so the user
  // can replan the rest of the week — e.g. if Wednesday's tempo was missed and
  // today is Friday, the suggester can still downgrade it to absorb extra load
  // from cross-training done after it was scheduled.
  return workouts.filter(w => _wk.rated[w.id || w.n] === undefined);
}

/**
 * Returns true when the current week still has workouts that can be reduced
 * (unrated and whose calendar date is today or later).
 * Exported so plan-view.ts can determine banner label without re-generating workouts.
 */
export function hasRemainingWeekWorkouts(): boolean {
  const s = getMutableState();
  const weekIdx = s.w - 1; // 0-indexed
  const wk = s.wks?.[weekIdx];
  if (!wk || !s.planStartDate) return false;
  const all = getWeekWorkouts(0);
  return filterRemainingWorkouts(all, wk, weekIdx, s.planStartDate).length > 0;
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
  const carried = computeDecayedCarry(s.wks ?? [], s.w, plannedB, s.planStartDate);
  return getWeeklyExcess(wk, plannedB, s.planStartDate, carried);
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

  // Mode safety: this card and trigger are running-mode only. The tri plan-view
  // (`src/ui/triathlon/plan-view.ts`) does not render the carry-over card or
  // any "Adjust Plan" button that calls this function. If a future refactor
  // wires this into the tri plan-view by mistake, the running-modal popup it
  // builds (with running-plan adjustments) will be wrong for tri mode. Tri
  // surfaces equivalent overload via `detectCrossTrainingOverload` and the
  // tri suggestion modal. See ISSUE-151.
  if (s.eventType === 'triathlon') return;

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
    // Use cross_training when activities span multiple sports so the modal doesn't
    // misidentify a ski+run mix as "extra run".
    const sportSet = new Set(items.map(i => i.sport ?? 'cross_training'));
    sport = sportSet.size === 1 ? [...sportSet][0] : 'cross_training';
    const totalDurationMin = items.reduce((sum, i) => sum + i.durationMin, 0);
    const totalAerobic = items.reduce((sum, i) => sum + i.aerobic, 0);
    const avgRPE = Math.min(9, Math.max(3, Math.round(totalAerobic > 3.5 ? 7 : totalAerobic > 2.5 ? 5 : 4)));
    combinedActivity = createActivity(sport, Math.round(totalDurationMin), avgRPE, undefined, undefined, s.w);
    const mostRecent = items.reduce((a, b) => (a.date > b.date ? a : b));
    const jsDay = new Date(mostRecent.date).getDay();
    combinedActivity.dayOfWeek = jsDay === 0 ? 6 : jsDay - 1;

    // Look up actual iTRIMP from source activities (garminActuals + adhocWorkouts)
    // so the popup computes load from HR data, not RPE estimation.
    let totalITrimp = 0;
    const seenIds = new Set<string>();
    for (const item of items) {
      if (seenIds.has(item.garminId)) continue;
      seenIds.add(item.garminId);
      let found = false;
      for (const actual of Object.values(wk.garminActuals ?? {})) {
        if (actual.garminId === item.garminId && actual.iTrimp != null && actual.iTrimp > 0) {
          totalITrimp += actual.iTrimp;
          found = true;
          break;
        }
      }
      if (!found) {
        const adhocId = `garmin-${item.garminId}`;
        for (const adhoc of wk.adhocWorkouts ?? []) {
          if (adhoc.id === adhocId && (adhoc as any).iTrimp != null && (adhoc as any).iTrimp > 0) {
            totalITrimp += (adhoc as any).iTrimp;
            break;
          }
        }
      }
    }
    if (totalITrimp > 0) {
      combinedActivity.iTrimp = totalITrimp;
    }

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

  const weekIdx = s.w - 1;
  const allWeekWorkouts = getWeekWorkouts(0);
  const remainingWorkouts = filterRemainingWorkouts(allWeekWorkouts, wk, weekIdx, s.planStartDate ?? '');

  if (remainingWorkouts.length === 0) {
    // No remaining workouts this week — don't adjust next week's plan mid-week.
    // The load will carry forward automatically via migration at week advance.
    return;
  }

  // Has remaining workouts — offer to reduce/replace them.
  const weekRuns = workoutsToPlannedRuns(remainingWorkouts, s.pac);
  const _tier = s.athleteTierOverride ?? s.athleteTier;
  const _atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const _acwr = computeACWR(s.wks, s.w, _tier, s.ctlBaseline ?? undefined, s.planStartDate, _atlSeed, s.signalBBaseline ?? undefined, undefined, (s as any).previousPlanWks);
  const ctx = {
    raceGoal: s.rd, plannedRunsPerWeek: s.rw,
    injuryMode: !!(s as any).injuryState, easyPaceSecPerKm: s.pac?.e,
    runnerType: s.typ as 'Speed' | 'Endurance' | 'Balanced' | undefined,
    floorKm: computeRunningFloorKm(s.pac?.m, s.w, s.tw ?? 16, wk?.ph),
    acwrStatus: _acwr.status,
  };
  // Pass overshoot TSS so the suggester caps the reduction budget to only what's needed.
  // `excess` is already the week-level overshoot (computeWeekRawTSS - plannedSignalB).
  const plannedB = computePlannedSignalB(
    s.historicWeeklyTSS, s.ctlBaseline, wk.ph ?? 'base',
    s.athleteTierOverride ?? s.athleteTier, s.rw, undefined, undefined, s.sportBaselineByType,
  );
  const targetTSS = plannedB ?? 0;
  const activityTSS = combinedActivity.iTrimp
    ? combinedActivity.iTrimp * 100 / 15000
    : items.reduce((sum, it) => sum + it.durationMin * (TL_PER_MIN[5] ?? 1.15), 0);

  const popup = buildCrossTrainingPopup(ctx, weekRuns, combinedActivity, undefined, recoveryMultiplier, excess);

  // For multi-activity case, rewrite the summary to describe the actual mix rather than
  // attributing everything to a single session type.
  if (items.length > 1) {
    const roundedActivityTSS = Math.round(activityTSS);
    const loadNote = popup.tier === 'rpe' ? ' (estimated from RPE)' : '';
    const equivKmStr = popup.equivalentEasyKm > 0
      ? `, equivalent to ${formatKm(popup.equivalentEasyKm, s.unitPref ?? 'km')} easy running`
      : '';
    const targetNote = targetTSS ? ` Adjustments bring your week back to ~${Math.round(targetTSS)} TSS target.` : '';
    popup.summary = `${roundedActivityTSS} TSS${loadNote} from ${items.length} extra activities${equivKmStr}.${targetNote}`;
    popup.sportName = 'extra activities';
  } else if (targetTSS) {
    popup.summary += ` Adjustments bring your week back to ~${Math.round(targetTSS)} TSS target.`;
  }

  showSuggestionModal(popup, sportLabel, (decision) => {
    if (!decision) return;

    const s3 = getMutableState();
    const wk3 = s3.wks?.[s3.w - 1];
    if (!wk3) return;

    if (decision.choice !== 'keep' && decision.adjustments.length > 0) {
      const freshW = getWeekWorkouts(0);
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

    // Clear unspent items only when the user acted on them (Reduce/Replace).
    // "Keep Plan" leaves items intact so TSS stays correct and the strip remains visible.
    if (decision.choice !== 'keep') {
      wk3.unspentLoadItems = [];
      wk3.unspentLoad = 0;
    }

    saveState();
    render();
  }, undefined, undefined, () => {
    // "Push to next week" — close the modal; load carries via migration. No state change needed.
    render();
  });
}

/**
 * No workouts remain this week — the extra load carries to next week automatically.
 * Show the suggestion modal targeting next week's runs so the user can absorb it there.
 */
function _triggerCarryoverToNextWeek(
  excess: number,
  sport: string,
  sportLabel: string,
  combinedActivity: ReturnType<typeof createActivity>,
  recoveryMultiplier: number,
): void {
  const s = getMutableState();
  const nextWk = s.wks?.[s.w]; // 0-indexed: current = s.w-1, next = s.w
  const nextWeekWorkouts = getWeekWorkouts(1);

  if (!nextWk || nextWeekWorkouts.length === 0) {
    // No next week in plan — nothing to adjust, just clear.
    const s2 = getMutableState();
    const wk2 = s2.wks?.[s2.w - 1];
    if (wk2) { wk2.unspentLoadItems = []; wk2.unspentLoad = 0; }
    saveState();
    render();
    return;
  }

  const weekRuns = workoutsToPlannedRuns(nextWeekWorkouts, s.pac);
  const _tier2 = s.athleteTierOverride ?? s.athleteTier;
  const _atlSeed2 = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const _acwr2 = computeACWR(s.wks, s.w, _tier2, s.ctlBaseline ?? undefined, s.planStartDate, _atlSeed2, s.signalBBaseline ?? undefined, undefined, (s as any).previousPlanWks);
  const ctx = {
    raceGoal: s.rd, plannedRunsPerWeek: s.rw,
    injuryMode: !!(s as any).injuryState, easyPaceSecPerKm: s.pac?.e,
    runnerType: s.typ as 'Speed' | 'Endurance' | 'Balanced' | undefined,
    floorKm: computeRunningFloorKm(s.pac?.m, s.w, s.tw ?? 16, nextWk?.ph),
    acwrStatus: _acwr2.status,
  };
  const popup = buildCrossTrainingPopup(ctx, weekRuns, combinedActivity, undefined, recoveryMultiplier);
  popup.headline = `${Math.round(excess)} TSS carried to next week`;
  popup.summary = `This week's extra load has been pushed to next week. Reduce next week's runs to absorb it, or keep the plan as-is.`;

  showSuggestionModal(popup, sportLabel, (decision) => {
    if (!decision) return;

    const s3 = getMutableState();
    const nextWk3 = s3.wks?.[s3.w]; // next week
    const currWk3 = s3.wks?.[s3.w - 1]; // current week

    if (decision.choice !== 'keep' && decision.adjustments.length > 0 && nextWk3) {
      const nextW = getWeekWorkouts(1);
      const modified = applyAdjustments(nextW, decision.adjustments, normalizeSport(sport), s3.pac);
      if (!nextWk3.workoutMods) nextWk3.workoutMods = [];
      for (const adj of decision.adjustments) {
        const mw = modified.find(w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex);
        if (!mw) continue;
        nextWk3.workoutMods.push({
          name: mw.n, dayOfWeek: mw.dayOfWeek, status: mw.status || 'reduced',
          modReason: `Garmin: ${sportLabel} (carried)`, confidence: mw.confidence,
          originalDistance: mw.originalDistance, newDistance: mw.d, newType: mw.t, newRpe: mw.rpe || mw.r,
        } as WorkoutMod);
      }
    }

    // Clear unspent items on current week
    if (currWk3) { currWk3.unspentLoadItems = []; currWk3.unspentLoad = 0; }

    saveState();
    render();
  });
}

