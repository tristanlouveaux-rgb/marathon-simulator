/**
 * Bulk catch-up — one pass for a multi-week absence.
 *
 * Background: the week-end debrief gates `advanceWeekToToday` (see
 * `welcome-back.ts`) so the plan pointer can only move one week per full
 * debrief. An athlete who missed 3 weeks therefore had to open the app three
 * times and sit through three completion prompts, three analysis animations
 * and three plan generations before reaching today's week.
 *
 * This module collapses that into a single pass:
 *  1. Apply the detraining penalty for the whole gap once.
 *  2. Run the normal per-week advance arithmetic headlessly for every missed
 *     week (same auto-skip, carry-forward and race-time penalty rules as the
 *     interactive flow — no numbers change, only the number of prompts).
 *  3. Generate the landing week once and show a single summary.
 *
 * Not used when an injury is active: rehab weeks require a per-week check-in
 * that cannot be batched, so those fall back to the interactive flow.
 */

import { getState, getMutableState, saveState } from '@/state';
import { next } from '@/ui/events';
import { computeVdotLoss, currentCalendarWeek } from '@/ui/welcome-back';
import { generateWeekWorkouts } from '@/workouts/generator';
import { getTrailingEffortScore } from '@/calculations/fitness-model';
import { fmtDesc, ft } from '@/utils/format';
import type { Workout } from '@/types';
import { computeCatchUpGap, type CatchUpGap } from '@/ui/catch-up-gap';

export { computeCatchUpGap, CATCH_UP_MIN_WEEKS } from '@/ui/catch-up-gap';
export type { CatchUpGap, CatchUpGapInput } from '@/ui/catch-up-gap';

/** What the catch-up did, for the summary modal. */
export interface CatchUpSummary extends CatchUpGap {
  /** Weeks actually advanced. Equals `weeks` unless an advance was blocked. */
  weeksAdvanced: number;
  /** Unrated runs resolved across the gap (carried forward plus dropped). */
  sessionsMissed: number;
  /** Race-time penalty added across the gap, in seconds. */
  penaltySec: number;
  /** Base VDOT before and after the detraining adjustment. */
  vdotBefore: number | null;
  vdotAfter: number | null;
  /** True when the landing week was reset to Base phase (3+ weeks away). */
  landedOnBaseWeek: boolean;
}

/** Read state and decide whether a bulk catch-up applies. */
export function detectCatchUpGap(): CatchUpGap | null {
  const s = getState() as any;
  if (!s.planStartDate || !s.wks?.length) return null;
  return computeCatchUpGap({
    currentWeek: s.w ?? 0,
    calendarWeek: currentCalendarWeek(),
    totalWeeks: s.tw ?? 0,
    generatedWeeks: s.wks.length,
    onboarded: !!s.hasCompletedOnboarding,
    injuryActive: !!s.injuryState?.active,
  });
}

/**
 * Close the gap. Runs the normal week-advance arithmetic once per missed week
 * with the prompts suppressed, so the resulting state is identical to walking
 * the cascade by hand.
 */
export async function runCatchUp(gap: CatchUpGap): Promise<CatchUpSummary> {
  const s = getMutableState() as any;
  const vdotBefore = typeof s.v === 'number' ? s.v : null;

  // Detraining for the whole gap, applied once. Same curve and same clamp as
  // advanceWeekToToday uses for the weeks it advances on its own.
  if (vdotBefore != null) {
    const loss = computeVdotLoss(vdotBefore, gap.weeks);
    if (loss > 0) s.v = Math.max(Math.round((vdotBefore - loss) * 10) / 10, 20);
  }

  let weeksAdvanced = 0;
  let sessionsMissed = 0;
  let penaltySec = 0;

  // Bounded by the gap: `next()` always reports whether it moved, and the loop
  // can never run more times than there are weeks to cover.
  for (let i = 0; i < gap.weeks; i++) {
    if ((getMutableState() as any).w >= gap.toWeek) break;
    const result = await next({ autoResolveIncomplete: true, suppressRender: true });
    if (!result.advanced) break;
    weeksAdvanced++;
    sessionsMissed += result.carriedForward + result.dropped;
    penaltySec += result.penaltySec;
  }

  const after = getMutableState() as any;

  // If an advance was blocked part-way, re-apply detraining for the weeks that
  // actually happened so the penalty never exceeds the ground covered.
  if (vdotBefore != null && weeksAdvanced < gap.weeks) {
    const loss = computeVdotLoss(vdotBefore, weeksAdvanced);
    after.v = Math.max(Math.round((vdotBefore - loss) * 10) / 10, 20);
  }

  // 3+ weeks away: land on a Base week so volume is reduced on return.
  // This mirrors the rule in advanceWeekToToday, applied to the week the
  // athlete actually lands on rather than the debrief-capped one.
  const landingWeek = after.wks?.[after.w - 1];
  const landedOnBaseWeek = weeksAdvanced >= 3 && !!landingWeek;
  if (landedOnBaseWeek) landingWeek.ph = 'base';

  // Record the debrief gate exactly as a completed debrief would. Without this
  // the launch-time rollback in main.ts (`s.w > lastCompleteDebriefWeek + 1`)
  // would drag the athlete back to the start of the gap on the next open, and
  // shouldAutoDebrief would fire a debrief for a week they never trained.
  if (weeksAdvanced > 0) {
    after.lastCompleteDebriefWeek = after.w - 1;
    after.lastDebriefWeek = after.w - 1;
    after.lastDebriefShownDate = new Date().toISOString().split('T')[0];
  }

  saveState();

  return {
    ...gap,
    toWeek: after.w,
    weeksAdvanced,
    sessionsMissed,
    penaltySec,
    vdotBefore,
    vdotAfter: typeof after.v === 'number' ? after.v : null,
    landedOnBaseWeek,
  };
}

// ─── Summary modal ───────────────────────────────────────────────────────────

const PHASE_LABEL: Record<string, string> = {
  base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper',
};

const ROW = 'display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--c-border)';
const LABEL = 'font-size:13px;color:var(--c-muted)';
const VALUE = 'font-size:14px;font-weight:600;color:var(--c-black)';

const TYPE_LABEL: Record<string, string> = {
  easy: 'Easy', long: 'Long', threshold: 'Tempo', vo2: 'VO2',
  marathon_pace: 'MP', progressive: 'Prog', intervals: 'Reps',
  hill_repeats: 'Hills', mixed: 'Mixed', rest: 'Rest',
  cross: 'Cross', gym: 'Gym', strength: 'Gym',
};

const TYPE_BG: Record<string, string> = {
  long: 'rgba(59,130,246,0.1)',
  threshold: 'rgba(249,115,22,0.1)',
  vo2: 'rgba(249,115,22,0.1)',
  intervals: 'rgba(249,115,22,0.1)',
  hill_repeats: 'rgba(249,115,22,0.1)',
  progressive: 'rgba(249,115,22,0.1)',
};

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function weeksLabel(n: number): string {
  return n === 1 ? '1 week' : `${n} weeks`;
}

/** Generate the landing week exactly as the plan view will render it. */
function generateLandingWeek(): Workout[] {
  const s = getState() as any;
  const wk = s.wks?.[s.w - 1];
  if (!wk) return [];
  return generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
    getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus, (wk as any).forceDeload,
  );
}

function renderWorkoutList(workouts: Workout[], unitPref: 'km' | 'mi'): string {
  if (workouts.length === 0) {
    return '<p style="font-size:13px;color:var(--c-muted);text-align:center;padding:16px 0">No sessions generated</p>';
  }
  return workouts.map(w => {
    const label = TYPE_LABEL[w.t] || w.t;
    const bg = TYPE_BG[w.t] || 'rgba(0,0,0,0.05)';
    const desc = w.d ? escapeHtml(fmtDesc(w.d, unitPref)).replace(/\n/g, ', ') : '';
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--c-border)">
        <span style="font-size:11px;font-weight:600;padding:3px 8px;border-radius:8px;background:${bg};color:var(--c-black);white-space:nowrap;min-width:56px;text-align:center">${escapeHtml(label)}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(w.n)}</div>
          ${desc ? `<div style="font-size:12px;color:var(--c-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${desc}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

/**
 * Run the catch-up and show a single summary covering the whole gap.
 * `onComplete` fires when the athlete dismisses it, and should land them on the
 * plan so they see the week that was generated.
 */
export async function showCatchUpModal(gap: CatchUpGap, onComplete: () => void): Promise<void> {
  if (document.getElementById('catch-up-modal')) return;

  const summary = await runCatchUp(gap);

  // Nothing moved (advance was blocked): don't show an empty summary.
  if (summary.weeksAdvanced === 0) {
    onComplete();
    return;
  }

  const s = getState() as any;
  const unitPref = (s.unitPref ?? 'km') as 'km' | 'mi';
  const wk = s.wks?.[s.w - 1];
  const phase = wk?.ph ? (PHASE_LABEL[wk.ph] ?? wk.ph) : '';
  const workouts = generateLandingWeek();

  const vdotDropped = summary.vdotBefore != null && summary.vdotAfter != null &&
    summary.vdotAfter < summary.vdotBefore;
  // Race-time penalties only exist in race mode; continuous mode drops sessions
  // from the plan instead of adjusting a target time.
  const showPenalty = summary.penaltySec > 0 && !s.continuousMode;

  const overlay = document.createElement('div');
  overlay.id = 'catch-up-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:20px';

  overlay.innerHTML = `
    <div style="width:100%;max-width:400px;background:var(--c-surface);border-radius:20px;
                padding:24px 20px 20px;box-shadow:0 8px 40px rgba(0,0,0,0.18);
                max-height:85vh;overflow-y:auto">

      <div style="position:relative;text-align:center;margin-bottom:14px">
        <span style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">Back after ${weeksLabel(summary.weeksAdvanced)}</span>
        <button id="catch-up-close"
          style="position:absolute;right:0;top:50%;transform:translateY(-50%);width:28px;height:28px;
                 border-radius:50%;border:1px solid var(--c-border);background:none;cursor:pointer;
                 font-size:14px;color:var(--c-muted);display:flex;align-items:center;justify-content:center">✕</button>
      </div>

      <p style="font-size:13px;line-height:1.5;color:var(--c-muted);margin:0 0 16px">
        The plan moved from week ${summary.fromWeek} to week ${summary.toWeek} in one pass. Missed sessions were resolved together, so there is no week-by-week catch-up to work through.
      </p>

      <div style="border-top:1px solid var(--c-border)">
        <div style="${ROW}">
          <span style="${LABEL}">Weeks missed</span>
          <span style="${VALUE}">${summary.weeksAdvanced}</span>
        </div>
        <div style="${ROW}">
          <span style="${LABEL}">Sessions missed</span>
          <span style="${VALUE}">${summary.sessionsMissed}</span>
        </div>
        ${vdotDropped ? `
        <div style="${ROW}">
          <span style="${LABEL}">Fitness</span>
          <span style="${VALUE}">${summary.vdotBefore!.toFixed(1)} to ${summary.vdotAfter!.toFixed(1)}</span>
        </div>` : ''}
        ${showPenalty ? `
        <div style="${ROW}">
          <span style="${LABEL}">Race target</span>
          <span style="${VALUE}">+${ft(summary.penaltySec)}</span>
        </div>` : ''}
      </div>

      ${summary.landedOnBaseWeek ? `
      <p style="font-size:13px;line-height:1.5;color:var(--c-muted);margin:14px 0 0">
        Week ${summary.toWeek} is set to Base phase. Volume is reduced and intensity targets are guides, not goals, for the first week back.
      </p>` : ''}

      <div style="margin-top:18px">
        <div style="font-size:11px;font-weight:600;color:var(--c-muted);margin-bottom:6px;letter-spacing:0.02em">Week ${summary.toWeek}${phase ? ` · ${phase} phase` : ''}</div>
        ${renderWorkoutList(workouts, unitPref)}
      </div>

      <div style="margin-top:20px">
        <button id="catch-up-continue"
          style="width:100%;padding:14px;border-radius:12px;border:none;background:var(--c-black);
                 color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--f);
                 letter-spacing:-0.01em">Continue →</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    onComplete();
  };
  overlay.querySelector('#catch-up-continue')?.addEventListener('click', close);
  overlay.querySelector('#catch-up-close')?.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}
