/**
 * Plan tab. Weekly calendar strip + Vergia-style workout card list.
 * Week navigation with < > buttons (keyboard arrow keys on web, swipe on iOS Phase 3).
 * Complex interactions (rating, Garmin matching) delegate to renderMainView() for now.
 */

import { extraRunAddsQualitySession, runningPlanShapeInputs, type BudgetRunFit, type PlanWeekNotes } from '@/workouts/plan_engine';
import { budgetRunFitLine } from './budget-run-fit-line';
import { getState, getMutableState, saveState } from '@/state';
import { AI_COACH_ENABLED } from '@/constants/feature-flags';
import type { SimulatorState, Week, Workout } from '@/types';
import { renderTabBar, wireTabBarHandlers, navigateToForecastTab, type TabId } from './tab-bar';
import { isSimulatorMode } from '@/app/runtime';
import { generateWeekWorkouts, calculateWorkoutLoad } from '@/workouts';
import { isSimpleDistanceDesc, parseDistanceKm, findWorkoutForMod, stripPaceTokens, modDisplayDescription, retargetDescriptionPace, displayDescWithPace } from '@/workouts/workout-scaling';
import { isDeloadWeek, abilityBandFromVdot } from '@/workouts/plan_engine';
import { isLongRun } from '@/workouts/long-run';
import { rate, skip, removeGarminActivity, unratePlanSlot, next, setOnWeekAdvance, isBenchmarkWeek, maybeInitKmNudge } from './events';
import { openInjuryModal, isInjuryActive, markAsRecovered, getInjuryStateForDisplay } from './injury/modal';
import { openCheckinOverlay } from './checkin-overlay';
import { firstTrackedDow } from './workout-status';
import { clearIllness, openIllnessModal } from './illness-modal';
import { buildHolidayBannerPlan, clearHoliday, cancelScheduledHoliday, openHolidayModal } from './holiday-modal';
import { openSessionGenerator, openVibesScienceModal } from './session-generator';
import { openLogActivityOverlay } from './log-activity-overlay';
import { openBenchmarkOverlay, maybeTriggerBenchmarkOverlay } from './benchmark-overlay';
import { getReturnToRunLevelLabel, recordMorningPain } from '@/injury/engine';
import { INJURY_PROTOCOLS } from '@/constants/injury-protocols';
import { TL_PER_MIN, SPORTS_DB } from '@/constants';
import { computeWeekTSS, computeWeekRawTSS, computeWeekActualTSS, getWeeklyExcess, getTrailingEffortScore, computeCrossTrainTSSPerMin, estimateWorkoutDurMin, computePlannedWorkoutSignalBTSS, normalizeiTrimp, planCardBaseMinPerKm} from '@/calculations/fitness-model';
import { computePlannedWeekTarget, computeCurrentWeekCarry } from '@/calculations/planned-week-target';
import { computeDailyCoach } from '@/calculations/daily-coach';
import { normalizeSport } from '@/cross-training/activities';
import { formatActivityType, getHREffort } from '@/calculations/activity-matcher';
import { collectWeekActivities } from '@/calculations/week-activity-log';
import { formatKm, fmtDesc, formatPace, ft } from '@/utils/format';
import { isTouchPrimary, fireSelectionHaptic } from '@/utils/platform';
import { triggerExcessLoadAdjustment, hasRemainingWeekWorkouts } from './excess-load-card';
import { showRunBreakdownSheet } from './home-view';
import { computeWeekSignals, getSignalPills, getFutureWeekPills, PILL_COLORS, type SignalPill } from '@/calculations/coach-insight';
import { isTimingMod, mergeTimingMods, acceptTimingSuggestion } from '@/cross-training/timing-check';
import { removeWorkoutMods } from '@/workouts/workout-mods';
import { resolveWeekWorkouts } from './week-resolve';
import { isStoodDownByLayer } from '@/workouts/render-layer';
import { parseStrengthSession, strengthCardSummary } from '@/guided/strength-model';
import { gymLegLoadNudgeForWorkout } from '@/calculations/strength-leg-load';
import type { MorningPainResponse } from '@/types/injury';
import { computeRecoveryStatus, sleepQualityToScore } from '@/recovery/engine';
import { calculateZones, getWorkoutHRTarget } from '@/calculations/heart-rate';
import type { RecoveryEntry, RecoveryLevel } from '@/recovery/engine';
import { showWeekDebrief, shouldShowSundayDebrief } from '@/ui/week-debrief';
import { buildRingBackground, atmosphereGradient, buildSunGlint, shouldPlayEntrance } from './page-flair';
import { isPlannedAdhocId } from '@/workouts/planned-adhoc';
import { recordPlannedRunDone, PLAN_CARD_NON_RUN_TYPES, isInAppActual, isManualInAppActual } from '@/calculations/in-app-activity';

// ─── Module state ────────────────────────────────────────────────────────────

let _viewWeek: number | null = null; // null = current week
// When non-null, the plan view renders an archived plan (`previousPlanWks[idx]`)
// in the same UI as the live plan, instead of `s.wks`. Lets the user step back
// past week 1 and browse a finished plan week-by-week. null = live plan.
let _viewArchiveIdx: number | null = null;
let _workoutLookup: Map<string, Workout> = new Map();

// ─── Recovery undo. Module-level delegated handler (set once, survives re-renders) ──
// Must be outside wirePlanHandlers so it works regardless of render path.
document.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest<HTMLElement>('.plan-recovery-undo-btn');
  if (!btn) return;
  e.stopPropagation();
  const workoutName = btn.dataset.workoutName || '';
  const dayOfWeek = btn.dataset.dayOfWeek !== undefined && btn.dataset.dayOfWeek !== ''
    ? parseInt(btn.dataset.dayOfWeek, 10) : null;
  const weekNum = parseInt(btn.dataset.weekNum || '0', 10);
  const origLabel = btn.dataset.origLabel || workoutName || 'original workout';

  const existing = document.getElementById('undo-adj-confirm');
  if (existing) existing.remove();
  const sheet = document.createElement('div');
  sheet.id = 'undo-adj-confirm';
  sheet.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
  sheet.innerHTML = `
    <div style="position:absolute;inset:0;background:rgba(0,0,0,0.45)" id="undo-adj-backdrop"></div>
    <div style="position:relative;width:100%;max-width:360px;background:var(--c-surface);border-radius:18px;padding:24px 20px 20px;z-index:1">
      <div style="font-size:16px;font-weight:600;margin-bottom:6px">Undo adjustment?</div>
      <div style="font-size:14px;color:var(--c-muted);margin-bottom:24px">This will restore the workout to <strong style="color:var(--c-text)">${origLabel}</strong>.</div>
      <button id="undo-adj-confirm-btn" class="m-btn-primary" style="width:100%;padding:13px;font-size:15px;margin-bottom:8px">Restore original</button>
      <button id="undo-adj-cancel-btn" class="m-btn-secondary" style="width:100%;padding:13px;font-size:15px">Cancel</button>
    </div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  document.getElementById('undo-adj-backdrop')?.addEventListener('click', close);
  document.getElementById('undo-adj-cancel-btn')?.addEventListener('click', close);
  document.getElementById('undo-adj-confirm-btn')?.addEventListener('click', () => {
    close();
    const s2 = getMutableState();
    const wk2 = s2.wks?.[weekNum - 1];
    if (!wk2) return;
    // Match by name only. DayOfWeek is optional on WorkoutMod and may differ
    // from the rendered workout (e.g. after drag-reorder). Remove all non-auto
    // mods for this workout name, including ones a later change replaced
    // (removeWorkoutMods walks the replaced-mod chain), so the session returns
    // to the plan.
    removeWorkoutMods(wk2, m => m.name === workoutName && !m.modReason?.startsWith('Auto:'));
    saveState();
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  });
}, true); // capture phase. Fires before card-header bubble handler

// ─── Shared card actions (both render paths wire the same buttons) ───────────

/** Timing suggestion "Apply": replace the pending suggestion with the accepted
 *  change (acceptTimingSuggestion: stable-id match, new RPE, one mod per session).
 *  Returns true when state changed. */
function onTimingAccept(btn: HTMLElement): boolean {
  const workoutName = btn.dataset.workoutName || '';
  if (!workoutName) return false;
  const dayOfWeek = btn.dataset.day ? parseInt(btn.dataset.day, 10) : undefined;
  const ms = getMutableState();
  const wk = ms.wks?.[ms.w - 1];
  if (!wk) return false;
  if (!acceptTimingSuggestion(wk, { workoutId: btn.dataset.workoutId || undefined, name: workoutName, dayOfWeek })) return false;
  saveState();
  return true;
}

// ─── Navigation ──────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  // Leaving the plan tab clears archive view so the next return to the plan
  // tab lands on the live current plan, not whichever past plan was last open.
  _viewArchiveIdx = null;
  _viewWeek = null;
  if (tab === 'home') {
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'forecast') {
    // Mode-aware: routes to the running standard-distance forecast (or the targeted
    // race forecast) for running/On-demand, tri forecast for tri, etc. Was hardcoded
    // to the triathlon forecast, which is broken for a running / On-demand user.
    navigateToForecastTab();
  } else if (tab === 'stats') {
    import('./stats-view').then(({ renderStatsView }) => renderStatsView());
  } else if (tab === 'account') {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function ourDay(): number {
  const js = new Date().getDay();
  return js === 0 ? 6 : js - 1;
}

/** "Mon 17 Feb" from planStartDate + week offset + day offset */
function weekStartDate(planStartDate: string, weekNum: number): Date {
  // Parse YYYY-MM-DD as local midnight. `new Date("YYYY-MM-DD")` parses as UTC
  // midnight, which is 01:00–02:00 local in positive-UTC zones. Comparing
  // against local-midnight `now` then puts today *before* week 1 start and
  // marks every day Missed. Component construction gives local midnight
  // directly, matching the comparison side of every same-day check.
  const [y, m, d] = planStartDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + (weekNum - 1) * 7);
  return date;
}

function fmtWeekRange(planStartDate: string | undefined, weekNum: number): string {
  if (!planStartDate) return '';
  const start = weekStartDate(planStartDate, weekNum);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  return `${start.toLocaleDateString('en-GB', opts)} – ${end.toLocaleDateString('en-GB', opts)}`;
}

function phaseLabel(ph: string): string {
  const map: Record<string, string> = { base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper' };
  return map[ph] || ph;
}

const PHASE_COLORS: Record<string, { bg: string; text: string }> = {
  base: { bg: 'rgba(59,130,246,0.1)', text: '#2563EB' },
  build: { bg: 'rgba(249,115,22,0.1)', text: '#EA580C' },
  peak: { bg: 'rgba(239,68,68,0.1)', text: '#DC2626' },
  taper: { bg: 'rgba(34,197,94,0.1)', text: '#16A34A' },
};

// Single accent used to highlight "today" in workout rows.
// Warm terracotta, matches Load/Taper hero.
const TODAY_ACCENT = '#C4553A';

// Shared CARD shadow system for banners / notice cards on the Plan page.
// Matches the aesthetic of Rolling Load / Load-Taper / Sleep.
const PLAN_CARD_STYLE = 'background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.65);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)';

// Hero name for the running plan, mirroring the triathlon view shape
// ("Tristan's 70.3"). Race name takes precedence; distance label is the
// fallback so unnamed targets still feel personal ("Tristan's 5k").
function getDistanceLabel(dist: string | null | undefined): string | null {
  if (!dist) return null;
  if (dist === '5k') return '5k';
  if (dist === '10k') return '10k';
  if (dist === 'half') return 'Half Marathon';
  if (dist === 'marathon') return 'Marathon';
  return null;
}

function getRunnerHeroName(s: SimulatorState): string {
  const firstName = (s.onboarding?.name || '').split(' ')[0]?.trim();
  const possessive = firstName ? `${firstName}'s` : 'Your';
  const raceName = (s.onboarding as any)?.selectedRace?.name?.toString().trim();
  if (raceName) return `${possessive} ${raceName} Plan`;
  const distLabel = getDistanceLabel(s.onboarding?.raceDistance ?? null);
  if (distLabel) return `${possessive} ${distLabel}`;
  return `${possessive} Running Plan`;
}

function daysUntilRace(iso: string | null | undefined): number {
  if (!iso) return 0;
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return 0;
  const now = new Date().setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((target - now) / 86400000));
}

function escapeHtmlPlan(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Count completed sessions in a week. Mirrors the dedup logic in
// home-view.buildProgressBars so both surfaces report the same number.
// A "done" session is either a synced activity (Garmin/Strava) matched to a
// slot, or an unsynced manual workout that has been rated (non-skip).
function countDoneSessionsForWeek(wk: any): number {
  if (!wk) return 0;
  const doneIds = new Set<string>();
  const actualsKeys = new Set<string>();
  for (const [key, act] of Object.entries(wk.garminActuals || {})) {
    const id = (act as any)?.garminId || key;
    if (id) doneIds.add(id);
    actualsKeys.add(key);
  }
  for (const w of (wk.adhocWorkouts || []) as any[]) {
    if (w.id && actualsKeys.has(w.id)) continue;
    const isSynced = w.id?.startsWith('garmin-') || w.id?.startsWith('strava-');
    if (isSynced) doneIds.add(w.id);
    else if (wk.rated?.[w.id] && wk.rated[w.id] !== 'skip') doneIds.add(w.id);
  }
  return doneIds.size;
}

// 3-column weekly summary card. Mirrors the triathlon Plan's summary strip
// (Hours / Sessions / Week load) but adapted for running: Sessions / Distance
// / Training Load. When `showActuals` is true the cell shows "actual / planned";
// when false (future weeks) it shows planned only. Whole card is tappable —
// `#plan-week-summary-card` is wired in `wirePlanHandlers` to open Load & Taper.
function buildPlanWeekSummaryCard(args: {
  plannedSessions: number;
  actualSessions: number;
  plannedKm: number;
  actualKm: number;
  plannedTSS: number;
  actualTSS: number;
  showActuals: boolean;
  unitPref: 'km' | 'mi';
}): string {
  const { plannedSessions, actualSessions, plannedKm, actualKm, plannedTSS, actualTSS, showActuals, unitPref } = args;

  const cellLabel = (text: string) =>
    `<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">${text}</div>`;

  const cellValue = (mainText: string, suffix: string = '') =>
    `<div style="font-size:20px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums;margin-top:2px">${mainText}${suffix ? `<span style="font-size:11px;color:var(--c-faint);font-weight:500;margin-left:2px">${suffix}</span>` : ''}</div>`;

  const sessionsValue = showActuals
    ? `${actualSessions} <span style="color:var(--c-faint);font-weight:400">/ ${plannedSessions}</span>`
    : `${plannedSessions}`;
  const kmValue = showActuals
    ? `${formatKm(actualKm, unitPref).replace(/\s?(km|mi)$/, '')} <span style="color:var(--c-faint);font-weight:400">/ ${formatKm(plannedKm, unitPref).replace(/\s?(km|mi)$/, '')}</span>`
    : `${formatKm(plannedKm, unitPref).replace(/\s?(km|mi)$/, '')}`;
  const tssValue = showActuals
    ? `${Math.round(actualTSS)} <span style="color:var(--c-faint);font-weight:400">/ ${Math.round(plannedTSS)}</span>`
    : `${Math.round(plannedTSS)}`;

  const kmUnit = unitPref === 'mi' ? 'mi' : 'km';

  return `
    <div style="padding:16px 20px 0">
      <button id="plan-week-summary-card" style="all:unset;box-sizing:border-box;display:block;width:100%;cursor:pointer;background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.65);border-radius:16px;padding:14px 16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
        <div style="display:flex;gap:16px;justify-content:space-between">
          <div style="flex:1;text-align:center">
            ${cellLabel('Sessions')}
            ${cellValue(sessionsValue)}
          </div>
          <div style="flex:1;text-align:center;border-left:1px solid rgba(0,0,0,0.06);border-right:1px solid rgba(0,0,0,0.06)">
            ${cellLabel('Distance')}
            ${cellValue(kmValue, kmUnit)}
          </div>
          <div style="flex:1;text-align:center">
            ${cellLabel('Training Load')}
            ${cellValue(tssValue, 'TSS')}
          </div>
        </div>
      </button>
    </div>
  `;
}

function phaseBadge(ph: string): string {
  if (!ph) return '';
  const label = phaseLabel(ph);
  const c = PHASE_COLORS[ph] ?? { bg: 'rgba(0,0,0,0.06)', text: 'var(--c-muted)' };
  return `<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:${c.bg};color:${c.text};letter-spacing:0.02em;text-transform:none">${label}</span>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtPacePlan(secPerKm: number, pref: 'km' | 'mi' = 'km'): string {
  const sec = pref === 'mi' ? secPerKm * 1.60934 : secPerKm;
  const unit = pref === 'mi' ? '/mi' : '/km';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}${unit}`;
}

function safeDetailId(id: string): string {
  return 'detail-' + id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Open the right modal for a tapped strength/gym card. A session already logged
 * opens its recap (openStrengthSummary — what was logged: weights, RPE, HR), not
 * the Start / Mark-done overlay. An undone session opens the editable detail.
 * HYROX has its own recap, so a logged HYROX card falls through to the detail
 * view. Shared by both card-header click bindings so they never diverge.
 */
function openGymCardDetail(id: string, viewWeek: number): void {
  const wo = _workoutLookup.get(id);
  if (!wo) return;
  const wk = getState().wks?.[viewWeek - 1];
  const ratingVal = wk?.rated?.[id];
  const isDone = (typeof ratingVal === 'number' && ratingVal > 0) || !!(wk?.garminActuals as any)?.[id];
  if (isDone) {
    import('@/guided/strength-complete').then(({ buildLoggedStrengthResult }) => {
      const result = buildLoggedStrengthResult(wo, viewWeek - 1);
      if (result && !result.isHyrox) {
        import('./strength-summary-card').then(({ openStrengthSummary }) => openStrengthSummary(wo, result));
      } else {
        import('./strength-workout-detail-modal').then(({ openStrengthWorkoutDetail }) => openStrengthWorkoutDetail(wo));
      }
    });
    return;
  }
  import('./strength-workout-detail-modal').then(({ openStrengthWorkoutDetail }) => openStrengthWorkoutDetail(wo));
}


function fmtZoneSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

// ─── Workout expanded detail ──────────────────────────────────────────────────

/**
 * Planned TSS shown on a running Plan-tab card: the "Planned load" line, the
 * Planned-vs-Actual bar, and the plannedTSS forwarded to the activity-detail
 * "Load vs plan" card (data-planned-tss).
 *
 * PLANNING side. Runs read the canonical per-workout pricer, the same one the
 * day's strain target sums (computePlannedDaySignalBTSS via
 * getPlannedDayTSSContext), so the card and Home agree on the same session.
 * Audit B2: this used TL_PER_MIN[w.rpe], 0.65/min for an RPE-3 easy run against
 * the 0.92/min day target, so on-plan easy runs read about 140% in red.
 * Replaced and skipped runs price at 0, as in the day target.
 */
export function planCardPlannedTSS(w: any, s: Pick<SimulatorState, 'pac' | 'wks'>): number {
  const t = (w.t || '').toLowerCase();
  if (!t || t === 'rest') return 0;
  const baseMinPerKm = planCardBaseMinPerKm(s);

  // Cross-training: use historical iTrimp-based rate when available,
  // fall back to TL_PER_MIN × sport runSpec (avoids running-calibrated inflation).
  if (t === 'cross' || t === 'gym') {
    const durMin = estimateWorkoutDurMin(w, baseMinPerKm);
    const rpe = w.rpe ?? w.r ?? 5;
    const sportKey = t === 'gym' ? 'strength' : normalizeSport(w.n || 'generic_sport');
    const historicalRate = computeCrossTrainTSSPerMin(s.wks, sportKey);
    if (historicalRate != null) {
      return Math.round(historicalRate * durMin);
    }
    const cfg = (SPORTS_DB as Record<string, { runSpec?: number }>)[sportKey];
    const runSpec = cfg?.runSpec ?? 0.40;
    return Math.round((TL_PER_MIN[Math.round(rpe)] ?? 1.15) * durMin * runSpec);
  }

  return Math.round(computePlannedWorkoutSignalBTSS(w, baseMinPerKm));
}

function buildWorkoutExpandedDetail(w: any, wk: Week | undefined, viewWeek: number, currentWeek?: number): string {
  const id = w.id || w.n;
  const rated = wk?.rated ?? {};
  const ratingVal = rated[id];
  const garminActual = wk?.garminActuals?.[id];
  const isDone = (typeof ratingVal === 'number' && ratingVal > 0) || !!garminActual;
  const isSkipped = ratingVal === 'skip';

  const _s = getState();
  const plannedTSS = planCardPlannedTSS(w, _s);

  // Derive HR target on the fly if not already stored on the workout
  const _hrTarget = w.hrTarget ?? (() => {
    const zones = calculateZones({
      lthr: _s.ltHR ?? undefined,
      maxHR: _s.maxHR ?? undefined,
      restingHR: _s.restingHR ?? undefined,
    });
    return zones ? getWorkoutHRTarget(w.t, zones) : undefined;
  })();

  let html = `<div class="plan-card-detail" id="${safeDetailId(id)}" style="display:none;border-top:1px solid var(--c-border);background:var(--c-surface)">`;
  html += `<div style="padding:14px 18px 16px">`;

  // ── Timing downgrade suggestion ───────────────────────────────────────────
  if (isTimingMod(w.modReason) && !isDone) {
    const timingMod = (wk?.workoutMods ?? []).find(m => isTimingMod(m.modReason)
      && (m.workoutId && w.id ? m.workoutId === w.id : m.name === w.n)) as any;
    const suggestedType = timingMod?.newType as string | undefined;
    const suggestionLabel = timingMod?.suggestionLabel as string | undefined;
    const tssYesterday = timingMod?.tssYesterday as number | undefined;
    const tssNote = tssYesterday ? ` (${tssYesterday} TSS yesterday)` : '';
    html += `<div style="padding:9px 12px;background:rgba(249,115,22,0.06);border:1px solid rgba(249,115,22,0.25);border-radius:var(--r-card);margin-bottom:10px">`;
    html += `<div style="font-size:11px;font-weight:600;color:#F97316;margin-bottom:3px">Suggestion: hard session yesterday${tssNote}</div>`;
    html += `<div style="font-size:12px;color:var(--c-muted);margin-bottom:8px">You trained hard yesterday. Consider ${suggestionLabel ?? 'an easier effort'} today, or move this session to a different day for full intensity.</div>`;
    if (suggestedType) {
      html += `<button class="plan-timing-accept" data-workout-id="${escapeHtml(timingMod?.workoutId ?? '')}" data-workout-name="${escapeHtml(timingMod?.name ?? w.n)}" data-day="${timingMod?.dayOfWeek ?? w.dayOfWeek ?? ''}" style="font-size:12px;font-weight:600;color:#F97316;background:rgba(249,115,22,0.1);border:1px solid rgba(249,115,22,0.3);border-radius:8px;padding:6px 12px;cursor:pointer">Apply: ${suggestionLabel ?? suggestedType} ↓</button>`;
    }
    html += `</div>`;
  }

  // ── Garmin / Strava matched banner ────────────────────────────────────────
  if (garminActual) {
    const actName = garminActual.displayName || garminActual.workoutName;
    const dur = Math.round(garminActual.durationSec / 60);
    // Compute actual TSS: prefer iTRIMP-based (HR-measured), fall back to duration estimate
    const rpeVal = typeof rated[id] === 'number' ? (rated[id] as number) : (w.rpe || w.r || 5);
    const actualTSS = garminActual.iTrimp != null && garminActual.iTrimp > 0
      ? Math.round(normalizeiTrimp(garminActual.iTrimp))
      : dur > 0 ? Math.round(dur * (TL_PER_MIN[Math.round(rpeVal)] ?? 0.92)) : null;
    const statsArr: string[] = [];
    if (garminActual.distanceKm > 0.1) statsArr.push(formatKm(garminActual.distanceKm, _s.unitPref ?? 'km'));
    if (garminActual.avgPaceSecKm) statsArr.push(fmtPacePlan(garminActual.avgPaceSecKm, _s.unitPref ?? 'km'));
    if (garminActual.avgHR) statsArr.push(`HR ${garminActual.avgHR}`);
    statsArr.push(`${dur} min`);
    if (actualTSS != null) statsArr.push(`TSS ${actualTSS}`);
    if (garminActual.calories) statsArr.push(`${garminActual.calories} kcal`);
    // In-app records (GPS run, Mark as Done, guided session) are logged by Mosaic itself.
    const source = isInAppActual(garminActual) ? 'Mosaic'
      : garminActual.garminId?.startsWith('strava-') ? 'Strava' : 'Garmin';
    html += `<div style="padding:9px 12px;background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);border-radius:var(--r-card);margin-bottom:4px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px">`;
    html += `<div>`;
    html += `<div style="font-size:11px;font-weight:600;color:var(--c-ok);margin-bottom:3px">✓ ${source}${actName ? `: ${escapeHtml(actName)}` : ' activity logged'}</div>`;
    html += `<div style="font-size:12px;color:var(--c-muted)">${statsArr.join(' · ')}</div>`;
    // Training effect badges (Garmin 1-5 scale)
    if (garminActual.aerobicEffect != null || garminActual.anaerobicEffect != null) {
      const teLabel = (val: number) => val < 1.0 ? 'No effect' : val < 2.0 ? 'Minor' : val < 3.0 ? 'Maintaining' : val < 4.0 ? 'Improving' : val < 5.0 ? 'Highly improving' : 'Overreaching';
      const teColor = (val: number) => val < 2.0 ? 'var(--c-faint)' : val < 3.5 ? '#22C55E' : val < 4.5 ? '#F97316' : '#EF4444';
      html += `<div style="display:flex;gap:5px;margin-top:5px;flex-wrap:wrap">`;
      if (garminActual.aerobicEffect != null) {
        const v = garminActual.aerobicEffect;
        html += `<span style="font-size:9px;font-weight:600;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,0.04);border:1px solid var(--c-border);color:${teColor(v)}">Aerobic ${v.toFixed(1)} · ${teLabel(v)}</span>`;
      }
      if (garminActual.anaerobicEffect != null) {
        const v = garminActual.anaerobicEffect;
        html += `<span style="font-size:9px;font-weight:600;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,0.04);border:1px solid var(--c-border);color:${teColor(v)}">Anaerobic ${v.toFixed(1)} · ${teLabel(v)}</span>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
    if (garminActual.garminId) {
      html += `<button class="plan-remove-garmin" data-garmin-id="${escapeHtml(garminActual.garminId)}" style="font-size:19px;color:var(--c-faint);background:none;border:none;cursor:pointer;padding:0;line-height:1;flex-shrink:0">×</button>`;
    }
    html += `</div>`;
    // Don't pass plannedTSS for cross-training. Activity-detail planned bar is
    // meaningless when RPE-assumed HR ≠ actual HR for non-running sports.
    const detailPlannedTSS = (w.t === 'cross' || w.t === 'gym') ? 0 : plannedTSS;
    html += `<button class="plan-act-open m-btn-link" data-workout-key="${escapeHtml(id)}" data-week-num="${viewWeek}" data-planned-tss="${detailPlannedTSS}" style="font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:10px;padding:4px 0">View full activity <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>`;
  }

  // ── Route map ─────────────────────────────────────────────────────────────
  if (garminActual?.polyline) {
    const kmSplitsAttr = garminActual.kmSplits?.length
      ? ` data-km-splits="${escapeHtml(JSON.stringify(garminActual.kmSplits))}"`
      : '';
    html += `<div style="margin-bottom:12px;border-radius:var(--r-card);overflow:hidden;border:1px solid var(--c-border)">`;
    html += `<canvas class="plan-detail-map" data-polyline="${escapeHtml(garminActual.polyline)}"${kmSplitsAttr} style="width:100%;display:block;height:150px"></canvas>`;
    html += `</div>`;
  }

  // ── HR zones (actual) ─────────────────────────────────────────────────────
  if (garminActual?.hrZones) {
    const z = garminActual.hrZones;
    const total = z.z1 + z.z2 + z.z3 + z.z4 + z.z5;
    if (total > 0) {
      const pct = (v: number) => Math.max(1, Math.round((v / total) * 100));
      const zones: [number, string, string][] = [
        [z.z1, '#3B82F6', 'Z1'], [z.z2, '#22C55E', 'Z2'],
        [z.z3, '#EAB308', 'Z3'], [z.z4, '#F97316', 'Z4'], [z.z5, '#EF4444', 'Z5'],
      ];
      html += `<div style="margin-bottom:12px">`;
      html += `<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:5px">HR Zones</div>`;
      html += `<div style="height:7px;border-radius:4px;display:flex;overflow:hidden;gap:1px;margin-bottom:5px">`;
      zones.filter(([v]) => v > 0).forEach(([v, col]) => {
        html += `<div style="flex:${pct(v)};background:${col}"></div>`;
      });
      html += `</div><div style="display:flex;flex-wrap:wrap;gap:3px 10px">`;
      zones.filter(([v]) => v > 0).forEach(([v, col, lbl]) => {
        html += `<span style="font-size:10px;color:var(--c-muted);display:flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:1px;background:${col};display:inline-block"></span>${lbl} ${fmtZoneSec(v)}</span>`;
      });
      html += `</div></div>`;
    }
  }

  // ── km splits sparkline ───────────────────────────────────────────────────
  const isRunAct = !garminActual?.activityType || garminActual.activityType.includes('RUN');
  if (isRunAct && garminActual?.kmSplits && garminActual.kmSplits.length > 0) {
    const splits = garminActual.kmSplits;
    const minP = Math.min(...splits);
    const maxP = Math.max(...splits);
    const range = maxP - minP || 1;
    const splitUnitPref = _s.unitPref ?? 'km';
    const splitUnit = splitUnitPref === 'mi' ? 'mi' : 'km';
    html += `<div style="margin-bottom:12px">`;
    html += `<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:5px">${splitUnit} Splits</div>`;
    html += `<div style="display:flex;align-items:flex-end;gap:2px;height:28px">`;
    splits.forEach((pace, i) => {
      const norm = (pace - minP) / range;
      // Invert: faster (lower pace) = taller bar
      const barHeight = Math.round(40 + (1 - norm) * 60);
      const barColor = norm < 0.33 ? '#22C55E' : norm < 0.67 ? '#EAB308' : '#EF4444';
      html += `<div title="${splitUnit} ${i + 1}: ${fmtPacePlan(pace, splitUnitPref)}" style="flex:1;height:${barHeight}%;background:${barColor};border-radius:2px 2px 0 0;min-width:4px"></div>`;
    });
    html += `</div>`;
    html += `<div style="display:flex;justify-content:space-between;margin-top:3px">`;
    html += `<span style="font-size:9px;color:var(--c-faint)">${splitUnit} 1</span>`;
    html += `<span style="font-size:9px;color:var(--c-faint)">${splitUnit} ${splits.length}</span>`;
    html += `</div>`;
    html += `</div>`;
  }

  // Description is now always visible in the card body. Not repeated here.

  // ── Planned vs Actual load ────────────────────────────────────────────────
  if (w.t && w.t !== 'rest') {
    // plannedTSS already computed at top of function

    // Actual TSS (already computed above when garminActual is present)
    const rpeForLoad = typeof rated[id] === 'number' ? (rated[id] as number) : (w.rpe || w.r || 5);
    const actualTSSForBars = garminActual
      ? (garminActual.iTrimp != null && garminActual.iTrimp > 0
        ? Math.round(normalizeiTrimp(garminActual.iTrimp))
        : Math.round((garminActual.durationSec / 60) * (TL_PER_MIN[Math.round(rpeForLoad)] ?? 0.92)))
      : null;

    const isCrossTraining = w.t === 'cross' || w.t === 'gym';

    // A Mark as Done record carries the planned dose itself, so a planned-vs-actual
    // bar would compare the plan with the plan. It falls through to Planned Load.
    const hasMeasuredActual = !!garminActual && !isManualInAppActual(garminActual);
    if (hasMeasuredActual && actualTSSForBars != null && plannedTSS > 0 && !isCrossTraining) {
      // Show planned vs actual comparison (running sessions only. Cross-training
      // intensity varies too much vs RPE assumptions to make this meaningful)
      const maxTSS = Math.max(plannedTSS, actualTSSForBars, 1);
      const plannedPct = Math.round((plannedTSS / maxTSS) * 100);
      const actualPct = Math.round((actualTSSForBars / maxTSS) * 100);
      const ratio = actualTSSForBars / plannedTSS;
      const actualColor = ratio > 1.15 ? '#EF4444' : ratio < 0.80 ? '#EAB308' : '#22C55E';
      html += `<div style="margin-bottom:14px">`;
      html += `<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:6px">Training Load</div>`;
      html += `<div style="display:flex;flex-direction:column;gap:6px">`;
      // Planned row
      html += `<div style="display:flex;align-items:center;gap:8px">`;
      html += `<span style="font-size:10px;color:var(--c-muted);width:50px;flex-shrink:0">Planned</span>`;
      html += `<div style="flex:1;height:5px;background:rgba(0,0,0,0.05);border-radius:3px;overflow:hidden"><div style="width:${plannedPct}%;height:100%;background:var(--c-border);border-radius:3px"></div></div>`;
      html += `<span style="font-size:10px;color:var(--c-faint);width:40px;text-align:right;flex-shrink:0">${plannedTSS} TSS</span>`;
      html += `</div>`;
      // Actual row
      html += `<div style="display:flex;align-items:center;gap:8px">`;
      html += `<span style="font-size:10px;color:var(--c-muted);width:50px;flex-shrink:0">Actual</span>`;
      html += `<div style="flex:1;height:5px;background:rgba(0,0,0,0.05);border-radius:3px;overflow:hidden"><div style="width:${actualPct}%;height:100%;background:${actualColor};border-radius:3px"></div></div>`;
      html += `<span style="font-size:10px;font-weight:600;width:40px;text-align:right;flex-shrink:0" style="color:${actualColor}">${actualTSSForBars} TSS</span>`;
      html += `</div>`;
      html += `</div></div>`;
    } else if (plannedTSS > 0) {
      // No actual data. Show planned TSS + HR target if available
      html += `<div style="margin-bottom:14px">`;
      html += `<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:4px">Planned Load</div>`;
      html += `<div style="font-size:13px;color:var(--c-text)">~${plannedTSS} TSS</div>`;
      if (_hrTarget) {
        const hasStructure = (w.d || '').toLowerCase().includes('warm up');
        const hrLine = hasStructure
          ? `Expected HR: ${_hrTarget.zone} during effort · ${_hrTarget.min}–${_hrTarget.max} bpm`
          : `Expected HR: ${_hrTarget.zone} · ${_hrTarget.min}–${_hrTarget.max} bpm`;
        html += `<div style="font-size:11px;color:var(--c-muted);margin-top:3px">${hrLine}</div>`;
      }
      html += `</div>`;
    }
  }

  // ── Action buttons ────────────────────────────────────────────────────────
  const _isPastWeek = currentWeek != null && viewWeek < currentWeek;
  // An in-app record (GPS run, Mark as Done) is not a watch sync: the card keeps
  // its Unmark action so the user can undo their own entry on a past week.
  const _isSynced = !!garminActual && !isInAppActual(garminActual);

  // Synced-from-watch guard: past weeks with garmin/strava match are read-only
  if (_isPastWeek && _isSynced) {
    const syncSource = garminActual!.garminId?.startsWith('strava-') ? 'Strava' : 'watch';
    html += `<div style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.15);border-radius:var(--r-card);margin-bottom:8px">`;
    html += `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-ok)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>`;
    html += `<span style="font-size:12px;font-weight:500;color:var(--c-ok)">Synced from ${syncSource}</span>`;
    html += `</div>`;
  } else {
    const testType = (w as any).testType as string | undefined;
    if (!isDone && !isSkipped && testType) {
      // Capacity test workout. Different button set
      const safeTestType = escapeHtml(testType);
      html += `
      <div style="margin-bottom:8px">
        <div style="font-size:11px;color:var(--c-muted);margin-bottom:8px;line-height:1.4">
          Complete the test run and report how it felt:
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <button class="plan-capacity-test-btn"
            data-test-type="${safeTestType}" data-passed="false"
            style="padding:11px 0;border-radius:10px;border:1.5px solid rgba(239,68,68,0.3);
                   background:rgba(254,242,242,0.8);cursor:pointer;
                   display:flex;flex-direction:column;align-items:center;gap:4px">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DC2626"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M15 9l-6 6M9 9l6 6"/>
            </svg>
            <span style="font-size:13px;font-weight:600;color:#991B1B">Had Pain</span>
          </button>
          <button class="plan-capacity-test-btn"
            data-test-type="${safeTestType}" data-passed="true"
            style="padding:11px 0;border-radius:10px;border:1.5px solid rgba(34,197,94,0.3);
                   background:rgba(240,253,244,0.8);cursor:pointer;
                   display:flex;flex-direction:column;align-items:center;gap:4px">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16A34A"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9 12l2 2 4-4"/>
            </svg>
            <span style="font-size:13px;font-weight:600;color:#15803D">Pain-Free!</span>
          </button>
        </div>
      </div>
    `;
    } else if (!isDone && !isSkipped) {
      const safeId = escapeHtml(id);
      const rpe = w.rpe || w.r || 5;
      const safeDesc = escapeHtml((w.d || '').replace(/\n/g, ' '));
      const isRunType = w.t && w.t !== 'gym' && w.t !== 'cross' && w.t !== 'rest';
      if (isRunType) {
        // Start Workout. Primary CTA for running workouts
        html += `<button class="plan-detail-start-btn m-btn-primary" data-workout-id="${safeId}" data-week-num="${viewWeek}" style="width:100%;margin-bottom:8px;font-size:13px;padding:10px 0;text-align:center;justify-content:center;display:flex;align-items:center;gap:6px">
            <span style="width:10px;height:10px;background:white;clip-path:polygon(0 0,100% 50%,0 100%);display:inline-block;flex-shrink:0"></span>
            Start Workout</button>`;
        // Mark as Done + Skip. Demoted to inline text links
        html += `<div style="display:flex;gap:12px;justify-content:center;margin-top:4px">`;
        html += `<button class="plan-action-mark-done" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-rpe="${rpe}" data-type="${w.t}" data-week-num="${viewWeek}" style="font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:4px 0">Mark as Done</button>`;
        html += `<span style="color:var(--c-border)">·</span>`;
        html += `<button class="plan-action-adjust" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-day="${w.dayOfWeek ?? 0}" data-week-num="${viewWeek}" data-d="${safeDesc}" data-orig="${escapeHtml((w as any).originalDistance || '')}" data-type="${w.t}" data-rpe="${rpe}" data-dur="${(w as any).estimatedDurationMin ?? ''}" data-orig-dur="${(w as any).originalDurationMin ?? ''}" style="font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:4px 0">Adjust</button>`;
        html += `<span style="color:var(--c-border)">·</span>`;
        html += `<button class="plan-action-skip" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-type="${w.t}" data-long-run="${isLongRun(w) ? '1' : ''}" data-rpe="${rpe}" data-desc="${safeDesc}" data-day="${w.dayOfWeek ?? 0}" data-week-num="${viewWeek}" style="font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:4px 0">Skip</button>`;
        html += `</div>`;
      } else if (w.t === 'gym') {
        html += `<button class="plan-action-mark-done m-btn-glass m-btn-glass--inset" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-rpe="0" data-type="gym" data-week-num="${viewWeek}" style="width:100%;margin-bottom:8px">Mark Done</button>`;
        html += `<button class="plan-action-skip m-btn-glass m-btn-glass--inset" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-type="${w.t}" data-rpe="${rpe}" data-desc="${safeDesc}" data-day="${w.dayOfWeek ?? 0}" data-week-num="${viewWeek}" style="width:100%;opacity:0.6">Skip</button>`;
      } else {
        html += `<button class="plan-action-mark-done m-btn-glass m-btn-glass--inset" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-rpe="${rpe}" data-type="${w.t}" data-week-num="${viewWeek}" style="width:100%;margin-bottom:8px">Mark Done</button>`;
        html += `<button class="plan-action-skip m-btn-glass m-btn-glass--inset" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-type="${w.t}" data-rpe="${rpe}" data-desc="${safeDesc}" data-day="${w.dayOfWeek ?? 0}" data-week-num="${viewWeek}" style="width:100%;opacity:0.6">Skip</button>`;
      }
    } else if (isDone) {
      html += `<button class="plan-action-unrate m-btn-glass m-btn-glass--inset" data-workout-id="${escapeHtml(id)}" data-week-num="${viewWeek}" style="width:100%;opacity:0.7">Unmark as Done</button>`;
    } else if (isSkipped) {
      html += `<button class="plan-action-unrate m-btn-glass m-btn-glass--inset" data-workout-id="${escapeHtml(id)}" data-week-num="${viewWeek}" style="width:100%;opacity:0.7">Unskip</button>`;
    }
  } // end synced guard

  // "Move to day" picker removed (Tristan, 2026-06-01) — drag-and-drop reorder
  // covers day changes and the picker cluttered every expanded card.

  html += `</div></div>`;
  return html;
}

// ─── Activity log section ─────────────────────────────────────────────────────

// Past weeks only — mirrors the triathlon plan's activity log (2026-06-04).
// The current week's actuals already show inline on the day cards, and Home →
// Recent carries the Review entry point, so a current-week duplicate list with
// its own Review button, pending banner and × unmatch controls restated the
// same data three ways. Past weeks keep a compact record of what happened.
// Rows come from the shared week-activity gatherer (collectWeekActivities) so
// this log, the home feed, and the tri/HYROX logs show the identical deduped set.
function buildActivityLog(wk: Week | undefined, viewWeek: number, currentWeek: number): string {
  if (!wk || viewWeek >= currentWeek) return '';
  const s = getState();
  const entries = collectWeekActivities(wk);
  if (entries.length === 0) return '';

  const unit = s.unitPref ?? 'km';
  // Same status vocabulary as the tri log: matched planned sessions read
  // "Logged"; only genuinely extra or unplaced activities call themselves out.
  const STATUS_LABEL: Record<string, string> = { matched: 'Logged', logged: 'Logged', excess: 'Excess', pending: 'Pending' };

  let h = `<div class="fade" style="margin:10px 16px 0;padding:14px 16px;${PLAN_CARD_STYLE};animation-delay:0.12s">`;
  h += `<div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:4px">Activity log</div>`;

  for (const e of entries) {
    const dateStr = e.sortTime ? new Date(e.sortTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
    const statsArr: string[] = [];
    if (dateStr) statsArr.push(dateStr);
    if (e.distanceKm > 0.1) statsArr.push(formatKm(e.distanceKm, unit));
    if (e.durationMin > 0) statsArr.push(`${e.durationMin} min`);
    const meta = statsArr.join(' · ');

    const cls = e.source === 'actual' ? 'plan-act-open' : e.source === 'adhoc' ? 'plan-adhoc-open' : '';
    const dataAttr = e.source === 'actual' ? ` data-workout-key="${escapeHtml(e.key)}" data-week-num="${viewWeek}"`
      : e.source === 'adhoc' ? ` data-adhoc-id="${escapeHtml(e.key)}" data-week-num="${viewWeek}"`
      : '';

    h += `<div${cls ? ` class="${cls}"` : ''}${dataAttr} style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.05);${cls ? 'cursor:pointer' : ''}">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:#0F172A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.name)}</div>
        ${meta ? `<div style="font-size:11px;color:var(--c-muted)">${meta}</div>` : ''}
      </div>
      <div style="flex-shrink:0"><span style="font-size:11px;color:var(--c-muted)">${STATUS_LABEL[e.badge] ?? ''}</span></div>
    </div>`;
  }

  h += `</div>`;
  return h;
}

// ─── Calendar strip ───────────────────────────────────────────────────────────

// ─── Workout cards ────────────────────────────────────────────────────────────

function runWorkoutTypeBadgeLabel(t: string, n: string): string {
  const type = (t || '').toLowerCase();
  if (type === 'easy' || type === 'recovery') return 'Easy';
  if (type === 'long') return 'Long';
  if (type === 'threshold' || type === 'tempo') return 'Threshold';
  if (type === 'vo2' || type === 'intervals') return 'VO2';
  if (type === 'marathon_pace' || type === 'race_pace') return 'MP';
  if (type === 'fartlek') return 'Fartlek';
  if (type === 'progressive' || (n || '').toLowerCase().includes('progression')) return 'Prog';
  if (type === 'gym' || type === 'strength') return 'Gym';
  if (type === 'cross' || type === 'cross_training') return 'Cross';
  if (type === 'mixed') return 'Mixed';
  return 'Run';
}

function buildWorkoutCards(
  s: SimulatorState,
  workouts: any[],
  viewWeek: number,
): string {
  const wk = s.wks?.[viewWeek - 1];
  const rated = wk?.rated ?? {};
  const today = ourDay();
  const isCurrentWeek = viewWeek === s.w;
  const jsDay = new Date().getDay();
  const actualToday = jsDay === 0 ? 6 : jsDay - 1;
  // Days before the plan was created were never schedulable — don't mark them
  // "Missed" on a freshly built plan (e.g. onboard Wed → Tue is not a miss).
  const firstTracked = isCurrentWeek ? firstTrackedDow(s.planStartDate, viewWeek, s.planCreatedAt) : 0;

  // Check if today actually falls within this week's date range.
  // If the week ended (e.g. week not wrapped up yet), don't mark any day as "today".
  let todayInRange = false;
  if (isCurrentWeek && s.planStartDate) {
    const wkStart = weekStartDate(s.planStartDate, viewWeek);
    const wkEnd = new Date(wkStart);
    wkEnd.setDate(wkEnd.getDate() + 6);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    todayInRange = now >= wkStart && now <= wkEnd;
  }

  // Compute coach once per render so the indicator can attach to today's row only.
  // Skipped outside the current-week-and-in-range view. The modifier only makes sense for today.
  const coach = isCurrentWeek && todayInRange ? computeDailyCoach(s) : null;
  const todayMod = coach ? coach.workoutMod : 'none';

  // Pre-compute effective dayOfWeek for each workout based on garminActual startTime
  const effectiveDay = new Map<string, number>();
  if (s.planStartDate && wk?.garminActuals) {
    const weekMonday = weekStartDate(s.planStartDate, viewWeek);
    for (const w of workouts) {
      const wId = w.id || w.n;
      const ga = (wk.garminActuals as any)?.[wId];
      if (ga?.startTime) {
        const actDate = new Date(ga.startTime);
        const jsDay = actDate.getDay();
        const monDay = jsDay === 0 ? 6 : jsDay - 1; // convert JS Sunday=0 to Mon=0..Sun=6
        // Only override if the activity falls within this week (within 7 days of weekMonday)
        const diffMs = actDate.getTime() - weekMonday.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays < 7) {
          effectiveDay.set(wId, monDay);
        }
      }
    }
  }

  // Build one card per day (Mon–Sun), grouping workouts by dayOfWeek
  const cards: string[] = [];
  const dayFirstCardEmitted = new Set<number>(); // track which days have had their first card anchor

  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const dayWorkouts = workouts.filter((w: any) => {
      const wId = w.id || w.n;
      const eff = effectiveDay.get(wId);
      return (eff != null ? eff : w.dayOfWeek) === dayIdx;
    });

    if (dayWorkouts.length === 0) {
      // Rest day. Same row shape as triathlon Plan: day label + horizontal
      // line + "Rest" tag. No outer card, no border-top. The day is just
      // a header strip, matching the rhythm of workout days.
      dayFirstCardEmitted.add(dayIdx);
      cards.push(`
        <div id="plan-day-${dayIdx}" class="plan-drop-zone" data-day-of-week="${dayIdx}" style="display:flex;align-items:center;gap:10px;padding:${dayIdx === 0 ? '4' : '20'}px 4px 8px;transition:background 0.15s;border-radius:6px">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-muted);min-width:36px">${DAY_SHORT[dayIdx]}</span>
          <span style="flex:1;height:1px;background:rgba(0,0,0,0.07)"></span>
          <span class="plan-drop-label" style="font-size:11px;color:var(--c-faint);font-weight:500;letter-spacing:0.02em">Rest</span>
        </div>
      `);
      continue;
    }

    // Sort workouts within each day: most recent activity first (by garminActual startTime)
    dayWorkouts.sort((a: any, b: any) => {
      const aId = a.id || a.n;
      const bId = b.id || b.n;
      const aTime = (wk?.garminActuals as any)?.[aId]?.startTime || (wk?.garminActuals as any)?.[aId]?.date || '';
      const bTime = (wk?.garminActuals as any)?.[bId]?.startTime || (wk?.garminActuals as any)?.[bId]?.date || '';
      if (bTime && aTime) return bTime > aTime ? 1 : bTime < aTime ? -1 : 0;
      if (bTime) return 1;
      if (aTime) return -1;
      return 0;
    });

    // Render each workout for this day
    for (const w of dayWorkouts) {
      const id = w.id || w.n;
      const ratingVal = rated[id];
      const isToday = isCurrentWeek && todayInRange && dayIdx === actualToday;
      const isPast = viewWeek < s.w || (isCurrentWeek && !todayInRange) || (isCurrentWeek && todayInRange && dayIdx >= firstTracked && dayIdx < actualToday);
      const isRest = w.t === 'rest' || w.n?.toLowerCase().includes('rest');

      if (isRest) {
        const dayAnchorId = !dayFirstCardEmitted.has(dayIdx) ? `id="plan-day-${dayIdx}" ` : '';
        dayFirstCardEmitted.add(dayIdx);
        cards.push(`
          <div ${dayAnchorId}class="plan-drop-zone" data-day-of-week="${dayIdx}" style="display:flex;align-items:center;gap:10px;padding:${dayIdx === 0 ? '4' : '20'}px 4px 8px;transition:background 0.15s;border-radius:6px">
            <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-muted);min-width:36px">${DAY_SHORT[dayIdx]}</span>
            <span style="flex:1;height:1px;background:rgba(0,0,0,0.07)"></span>
            <span class="plan-drop-label" style="font-size:11px;color:var(--c-faint);font-weight:500;letter-spacing:0.02em">Rest</span>
          </div>
        `);
        continue;
      }

      // Garmin actual. Direct lookup by workout slot ID (needed for isDone)
      const garminAct: any = (wk?.garminActuals as any)?.[id] || null;
      const isDone = (typeof ratingVal === 'number' && ratingVal > 0) || !!garminAct;
      const isSkipped = ratingVal === 'skip';

      // Issue 1: show actual activity name when matched (e.g. "Swimming" not "General Sport 1")
      const rawName = garminAct?.displayName || w.n || 'Workout';
      const name = rawName.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
      // Cross-training sport swap: planned slot was one sport, the matched activity is another.
      // The day-proximity fallback in activity-review.ts can attach a tennis activity to a wakeboarding
      // slot, etc. When that happens the heading shows the actual sport and the planned description is
      // misleading. Replace it with a "Planned: <slot name>" caption.
      const planNameLower = (w.n || '').toLowerCase().trim();
      const actNameLower = (garminAct?.displayName || '').toLowerCase().trim();
      const isSportSwap = !!garminAct && (w.t === 'cross' || w.t === 'gym')
        && !!actNameLower && !!planNameLower
        && actNameLower !== planNameLower
        && !actNameLower.startsWith(planNameLower)
        && !planNameLower.startsWith(actNameLower);
      const isReduced = !isDone && !isSkipped && (w as any).status === 'reduced' && !isTimingMod((w as any).modReason);
      const distKm = w.km || w.distanceKm;
      const durationMin = w.dur;
      const estMin = (w as any).estimatedDurationMin as number | undefined;
      const isRunTypeCard = !!w.t && w.t !== 'gym' && w.t !== 'cross' && w.t !== 'rest';

      let valueStr: string;
      if (isRunTypeCard) {
        // Time is the universal unit and updates live with any Adjust. Distance is
        // shown alongside only for distance-defined runs (easy / long / MP). Structured
        // sessions (tempo / intervals) headline time only — there is no single honest
        // distance, which is why a tempo no longer mis-shows its warm-up "2.0 km".
        const timeMin = (estMin && estMin > 0) ? Math.round(estMin) : (durationMin ? Math.round(durationMin) : 0);
        const dKm = isSimpleDistanceDesc((w as any).d) ? parseDistanceKm((w as any).d) : null;
        const parts: string[] = [];
        if (dKm && dKm > 0) parts.push(formatKm(dKm, s.unitPref ?? 'km'));
        if (timeMin > 0) parts.push(`${timeMin} min`);
        valueStr = parts.join(' · ');
      } else {
        valueStr = distKm ? (typeof distKm === 'number' ? formatKm(distKm, s.unitPref ?? 'km') : formatKm(parseFloat(distKm), s.unitPref ?? 'km'))
          : durationMin ? `${Math.round(durationMin)} min`
            : '';
        if (isReduced && (w as any).d) {
          const kmMatch = /(\d+\.?\d*)\s*km/i.exec((w as any).d);
          if (kmMatch) valueStr = formatKm(parseFloat(kmMatch[1]), s.unitPref ?? 'km');
        }
      }

      // Replacement detection
      const isReplaced = (w as any).status === 'replaced';
      const replacedByAdhoc = isReplaced
        ? (wk?.adhocWorkouts || []).find((a: any) => a.dayOfWeek === w.dayOfWeek && !(a.id || '').startsWith('garmin-'))
        : null;

      // Status label (neutral text. Colour reserved for Today only)
      let statusLabel: string;
      if (isDone) statusLabel = garminAct ? 'Logged' : 'Done';
      else if (isReplaced) statusLabel = 'Replaced';
      else if ((w as any).status === 'holiday') statusLabel = 'Holiday';
      else if (isPlannedAdhocId((w as any).id)) statusLabel = 'Added';
      else if (isReduced) statusLabel = 'Adjusted';
      else if (isSkipped) statusLabel = 'Skipped';
      else if (isToday) statusLabel = 'Today';
      else if ((w as any).illnessMod) statusLabel = 'Illness';
      else if (isPast) statusLabel = 'Missed';
      else statusLabel = 'Upcoming';

      // An illness-rested/scaled day is a deliberate non-miss (like holiday), so
      // it must not pick up the orange "Missed" colour/weight on a past day.
      const isIllnessMod = !!(w as any).illnessMod;
      // Visual hierarchy: Today = terracotta accent, Logged = solid muted, Missed = faint + italic
      const dayLabelColor = isToday
        ? TODAY_ACCENT
        : (isDone ? 'var(--c-black)' : (isPast && !isDone && !isSkipped ? 'var(--c-faint)' : 'var(--c-faint)'));
      // Done wins the colour as well as the label (mirrors workout-status.ts):
      // a session completed today must read green, not terracotta.
      const statusLabelColor = isDone
        ? '#34C759'
        : isToday ? TODAY_ACCENT
        : (isPast && !isSkipped && !isIllnessMod) ? '#FF9500'
        : 'var(--c-faint)';
      const statusLabelWeight = isDone || (isPast && !isDone && !isSkipped && !isIllnessMod) ? '600' : '400';
      const borderLeft = isToday ? `border-left:3px solid ${TODAY_ACCENT};` : '';

      const headerPad = isToday ? '16px 18px 16px 15px' : '15px 18px';
      const nameOpacity = isSkipped || isReplaced ? '0.45' : (isPast && !isDone ? '0.55' : '1');
      const nameDecoration = isReplaced ? 'line-through' : 'none';

      // Build inline activity match / replacement sub-row
      let actMatchRow = '';
      if (garminAct) {
        const source = garminAct.garminId?.startsWith('strava-') ? 'Strava' : 'Garmin';
        const matchStats: string[] = [];
        if (garminAct.distanceKm > 0.1) matchStats.push(formatKm(garminAct.distanceKm, s.unitPref ?? 'km'));
        if (garminAct.avgPaceSecKm) matchStats.push(fmtPacePlan(garminAct.avgPaceSecKm, s.unitPref ?? 'km'));
        const matchDur = Math.round(garminAct.durationSec / 60);
        if (matchDur > 0) matchStats.push(`${matchDur} min`);
        const matchName = garminAct.workoutName || garminAct.displayName || '';
        const showMatchName = !!matchName && matchName.toLowerCase().trim() !== (name || '').toLowerCase().trim();
        actMatchRow = `<div class="plan-act-open" data-workout-key="${escapeHtml(id)}" data-week-num="${viewWeek}" style="display:flex;align-items:center;gap:5px;margin-top:3px;cursor:pointer">
          <span style="font-size:11px;color:var(--c-muted)">${showMatchName ? escapeHtml(matchName) + ' · ' : ''}${source}${matchStats.length ? ' · ' + matchStats.join(' · ') : ''}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </div>`;
      } else if (isReplaced && replacedByAdhoc) {
        const repName = (replacedByAdhoc as any).n || (replacedByAdhoc as any).name || 'Cross-training';
        const repDur = (replacedByAdhoc as any).dur || (replacedByAdhoc as any).durationMin || 0;
        actMatchRow = `<div style="display:flex;align-items:center;gap:5px;margin-top:3px">
          <span style="font-size:11px;color:var(--c-muted)">→ ${escapeHtml(repName)}${repDur ? ` · ${Math.round(repDur)} min` : ''}</span>
        </div>`;
      }

      const showUndoAdj = isReduced && !(w as any).modReason?.startsWith?.('Auto:') && !isDone;
      const undoAdjBtn = showUndoAdj
        ? `<button class="plan-recovery-undo-btn" data-workout-name="${escapeHtml(w.n)}" data-day-of-week="${(w as any).dayOfWeek ?? ''}" data-week-num="${viewWeek}" data-orig-label="${escapeHtml((w as any).originalDistance || w.n || '')}" style="font-size:11px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:0;white-space:nowrap;flex-shrink:0;text-decoration:underline;text-underline-offset:2px">Undo adjustment</button>`
        : '';

      const isRunnable = w.t && w.t !== 'gym' && w.t !== 'cross' && w.t !== 'rest';
      const showHeaderStart = isCurrentWeek && !isDone && isRunnable;
      const isUserGenerated = isPlannedAdhocId((w as any).id);
      const deleteBtn = isUserGenerated && !isDone
        ? `<button class="plan-adhoc-delete-btn" data-workout-id="${id}" data-week-num="${viewWeek}"
            style="padding:7px 10px;font-size:11px;border-radius:8px;border:1px solid var(--c-border);
                   background:transparent;color:var(--c-muted);cursor:pointer;font-family:var(--f)">Remove</button>`
        : '';
      // Value and expand arrows are now in the badge row / bottom chevron. RightContent
      // only carries the Start button (today) and the Undo-adjustment link (reduced workouts).
      const rightContent = showHeaderStart
        ? `<div style="display:flex;gap:6px;align-items:center">${deleteBtn}<button class="plan-start-btn m-btn-primary" data-workout-id="${id}" data-week-num="${viewWeek}" style="padding:7px 14px;font-size:12px">
            <span style="width:10px;height:10px;background:white;clip-path:polygon(0 0,100% 50%,0 100%);display:inline-block;flex-shrink:0"></span>
            Start
          </button></div>`
        : undoAdjBtn
          ? `<div style="display:flex;align-items:center">${undoAdjBtn}</div>`
          : '';

      // Day separator. Emitted once before the first workout card of each day
      const isFirstInDay = !dayFirstCardEmitted.has(dayIdx);
      if (isFirstInDay) {
        const sepAnchorId = `id="plan-day-${dayIdx}" `;
        const nonRestCount = dayWorkouts.filter((dw: any) => dw.t !== 'rest').length;
        const dayHeaderColor = isToday ? TODAY_ACCENT : '#0F172A';
        cards.push(`
          <div ${sepAnchorId}class="plan-day-sep" data-day-of-week="${dayIdx}" style="display:flex;align-items:center;gap:10px;padding:${dayIdx === 0 ? '4' : '20'}px 4px 8px">
            <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:${dayHeaderColor};min-width:36px">${DAY_SHORT[dayIdx]}</span>
            <span style="flex:1;height:1px;background:rgba(0,0,0,0.07)"></span>
            ${nonRestCount > 1 ? `<span style="font-size:11px;color:var(--c-faint)">${nonRestCount} sessions</span>` : ''}
          </div>
        `);
      }
      dayFirstCardEmitted.add(dayIdx);

      // Sub-rows for ACWR-reduced workouts: current plan + original plan
      let reducedBadge = '';
      const _isAutoMod_pre = !!(w as any).modReason?.startsWith?.('Auto:');
      if (isReduced && !_isAutoMod_pre) {
        const origDist = (w as any).originalDistance as string | undefined;
        const newDesc = (w as any).d as string | undefined;
        // "Original plan" fallback: parse from "5.2km (was 8km)" if originalDistance not set
        const wasMatch = !origDist && newDesc ? /\(was (\d+\.?\d*km)\)/.exec(newDesc) : null;
        const origLabel = origDist || (wasMatch ? wasMatch[1] : null);
        const cardUnitPref = s.unitPref ?? 'km';
        const lines: string[] = [];
        // Only show the "Original:" caption when both the label is a clean distance
        // ("8km") AND the session itself is a simple distance run. Structured
        // sessions (tempo / intervals) have no single honest distance, so a
        // "Original: 2km" caption there is meaningless (it was the warm-up). This
        // also heals stale mods from the earlier distance-only scaling build.
        const origLabelClean = origLabel ? stripPaceTokens(origLabel) : origLabel;
        if (origLabelClean && /^\s*\d+(?:\.\d+)?\s*km\s*$/i.test(origLabelClean) && isSimpleDistanceDesc((w as any).d)) {
          // Show the original WITH its pace so the adjustment reads as
          // what → what ("6km @ 6:10/km" → "6km @ MP (4:44/km)"). Every
          // original that passes the clean-distance gate is a simple easy/long
          // run, whose prescription pace is the easy pace — re-derived live so
          // it matches what an unadjusted card would show today.
          const origDisplay = retargetDescriptionPace(origLabelClean, 'easy', s.pac?.e);
          lines.push(`<div style="font-size:11px;color:var(--c-faint);margin-top:2px">Original: ${fmtDesc(origDisplay, cardUnitPref)}</div>`);
        }
        reducedBadge = lines.join('');
      }

      const _autoReduceNote = (w as any).autoReduceNote as string | undefined;
      const _isAutoMod = _isAutoMod_pre && !isDone && !!_autoReduceNote;
      const autoReduceRow = _isAutoMod
        ? `<div style="padding:6px 16px 10px;border-top:1px dashed var(--c-border);display:flex;align-items:center;justify-content:space-between;gap:8px">
            <span style="font-size:11px;color:var(--c-muted)">${escapeHtml(_autoReduceNote)}</span>
            <button class="plan-auto-undo-btn" data-workout-id="${escapeHtml(id)}" style="font-size:11px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:0;white-space:nowrap;flex-shrink:0;text-decoration:underline;text-underline-offset:2px">Undo</button>
          </div>`
        : '';

      // Coach workout modifier note. Rendered only on today's row, only when the session
      // isn't done, and only when stance maps to downgrade or skip. Informational only.
      const showCoachNote = isToday && !isDone && !isSkipped && !isReplaced && todayMod !== 'none' && !!coach;
      const coachNoteRow = showCoachNote
        ? (todayMod === 'skip'
            ? `<div style="padding:10px 16px;border-top:1px solid var(--c-border);font-size:12px;color:var(--c-muted);line-height:1.45"><strong style="color:var(--c-black);font-weight:600">Consider rest today.</strong> ${coach!.primaryMessage}</div>`
            : `<div style="padding:10px 16px;border-top:1px solid var(--c-border);font-size:12px;color:var(--c-muted);line-height:1.45"><strong style="color:var(--c-black);font-weight:600">Go easier today.</strong> ${coach!.primaryMessage}</div>`)
        : '';

      // Type badge + description (always visible)
      const typeBadgeLabel = runWorkoutTypeBadgeLabel(w.t, w.n || '');
      // Persisted simple-distance descs (adhoc objects, coach/auto reductions)
      // gain their type's pace at display time. Skipped when an effort-picker
      // target exists — the Target row below carries that (more precise) number.
      const descWithPace = (w as any).targetPaceSecKm
        ? (w as any).d
        : displayDescWithPace((w as any).d, w.t, s.pac?.e);
      const descText = descWithPace?.trim() ? fmtDesc(descWithPace, s.unitPref ?? 'km') : '';
      // Strength/gym sessions collapse their exercise list to a "tap to view"
      // summary; the full breakdown opens in the strength detail modal. The raw
      // multi-exercise description reads as a run-on paragraph inline.
      const isGymCard = (w.t === 'gym' || w.t === 'strength') && !isSportSwap && !isReplaced;
      const gymExerciseCount = isGymCard && (w as any).d?.trim() ? (parseStrengthSession(w as any)?.exerciseCount ?? 0) : 0;
      let descRow: string;
      if (isSportSwap) {
        descRow = `<div style="font-size:11px;color:var(--c-muted);margin-top:3px">Planned: ${escapeHtml((w.n || 'Cross-training').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()))}</div>`;
      } else if (gymExerciseCount > 0) {
        descRow = `<div style="font-size:13px;color:var(--c-muted);margin-top:4px">${gymExerciseCount} exercise${gymExerciseCount === 1 ? '' : 's'} · tap to view</div>`;
      } else if (descText && !isReplaced) {
        descRow = `<div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-top:4px">${escapeHtml(descText).replace(/\n/g, '<br>')}</div>`;
      } else {
        descRow = '';
      }

      // Leg-load nudge: a leg-heavy gym day on already-loaded legs gets a passive
      // "consider easing" note (surface + suggest, no plan mutation). Shared helper
      // so this matches the tri plan-view card exactly. See strength-leg-load.ts.
      let legLoadNudgeRow = '';
      if (isGymCard && !isDone && !isSkipped) {
        const msg = gymLegLoadNudgeForWorkout(w as any, s.recentLegLoads ?? [], (w as any).rpe ?? 7, Date.now());
        if (msg) legLoadNudgeRow = `<div style="margin-top:4px"><span style="font-size:10px;font-weight:500;color:var(--c-muted)">${escapeHtml(msg)}</span></div>`;
      }

      // Status chip (right side of badge row. Only show non-trivial states)
      const showStatusChip = statusLabel !== 'Upcoming';
      const statusChip = showStatusChip
        ? `<span style="font-size:10px;font-weight:600;color:${statusLabelColor}">${statusLabel}</span>`
        : '';

      // Target pace note (below name). Suppressed when the description already
      // carries a pace — two targets on one card is the duplicate-surface fail.
      const targetPaceRow = !isDone && !isSkipped && (w as any).targetPaceSecKm && !/@/.test(descText)
        ? `<div style="font-size:11px;color:var(--c-muted);margin-top:2px">Target: ${fmtPacePlan((w as any).targetPaceSecKm, s.unitPref ?? 'km')}</div>`
        : '';

      const expandDetail = buildWorkoutExpandedDetail(w, wk, viewWeek, s.w);

      cards.push(`
        <div class="plan-workout-card" data-workout-id="${id}" data-day-of-week="${dayIdx}" ${gymExerciseCount > 0 ? 'data-gym-detail="1"' : ''} draggable="true" style="
          background:#fff;
          border-radius:14px;
          margin-bottom:8px;
          overflow:hidden;
          box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 14px rgba(0,0,0,0.05);
          ${borderLeft}
        ">
          <div class="plan-card-header" style="padding:14px 16px;cursor:pointer">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
              <span style="display:inline-flex;align-items:center;background:rgba(0,0,0,0.05);color:var(--c-muted);font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;padding:3px 8px;border-radius:100px">${typeBadgeLabel}</span>
              ${valueStr ? `<span style="font-size:11px;color:var(--c-muted);font-variant-numeric:tabular-nums">${valueStr}</span>` : ''}
              <span style="flex:1"></span>
              ${statusChip}
            </div>
            <div style="display:flex;align-items:flex-start;gap:8px">
              <div style="flex:1;min-width:0">
                <div style="font-size:15px;font-weight:600;letter-spacing:-0.01em;opacity:${nameOpacity};text-decoration:${nameDecoration}">${name}</div>
                ${targetPaceRow}
                ${descRow}
                ${actMatchRow}
                ${isTimingMod((w as any).modReason) && !isDone ? `<div style="margin-top:4px"><span style="font-size:10px;font-weight:500;color:var(--c-muted)">Suggestion: hard session yesterday</span></div>` : ''}
                ${legLoadNudgeRow}
                ${reducedBadge}
              </div>
              <div style="flex-shrink:0;display:flex;align-items:center;gap:6px">
                ${rightContent}
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;padding-top:8px">
              <svg class="plan-card-chevron" style="transition:transform 0.2s" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
            </div>
          </div>
          ${autoReduceRow}
          ${coachNoteRow}
          ${expandDetail}
        </div>
      `);
    }
  }

  return cards.join('');
}

// ─── Wrap Up Week pill (shown in header on Sunday or when all workouts done) ──

/**
 * Returns true when every non-rest workout for this week has been
 * marked done (rated > 0 or has a garminActual) or skipped.
 */
function allWorkoutsDone(workouts: any[], wk: any): boolean {
  const nonRest = workouts.filter((w: any) => w.t !== 'rest');
  if (nonRest.length === 0) return false;
  return nonRest.every((w: any) => {
    const id = w.id || w.n;
    const ratingVal = wk?.rated?.[id];
    const hasActual = !!wk?.garminActuals?.[id];
    return (typeof ratingVal === 'number' && ratingVal > 0) || hasActual || ratingVal === 'skip';
  });
}

/**
 * Small "Wrap up week" pill for the plan header.
 * Visible on Sunday (day 6), after the week's Sunday has passed, or when every workout is done/skipped.
 */
function buildWrapUpWeekBtn(s: SimulatorState, workouts: any[], viewWeek: number): string {
  if (viewWeek !== s.w) return '';
  if ((s as any).wks?.[viewWeek - 1]?.weekCompleted) return '';
  const today = ourDay(); // 6 = Sunday
  const wk = (s as any).wks?.[viewWeek - 1];
  // Show if: it's Sunday, the week's Sunday has already passed, or all workouts are done
  let pastWeekEnd = false;
  if (s.planStartDate) {
    const weekEnd = weekStartDate(s.planStartDate, viewWeek);
    weekEnd.setDate(weekEnd.getDate() + 6); // Sunday of this plan week
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    pastWeekEnd = now > weekEnd;
  }
  const show = today === 6 || pastWeekEnd || allWorkoutsDone(workouts, wk);
  if (!show) return '';
  return `<button id="plan-wrap-up-btn" class="m-btn-glass">Wrap up week</button>`;
}

// ─── Injury UI ───────────────────────────────────────────────────────────────

/**
 * Header button. "Check-in" when healthy, "In Recovery" pill when injured.
 * Only shown on the current week.
 */
function buildInjuryHeaderBtn(injured: boolean, isCurrentWeek: boolean): string {
  if (!isCurrentWeek) return '';
  if (injured) {
    return `<button id="plan-injury-update" style="padding:8px 18px;border-radius:100px;border:none;background:rgba(234,88,12,0.12);backdrop-filter:blur(8px);cursor:pointer;font-size:13px;font-weight:600;color:#92400E;font-family:var(--f);box-shadow:0 1px 4px rgba(0,0,0,0.06)">In Recovery</button>`;
  }
  return `<button id="plan-checkin-btn" class="m-btn-glass">Check-in</button>`;
}

/**
 * Banner shown while illnessState.active is true.
 */
function buildIllnessBanner(): string {
  const s = getState();
  const illness = (s as any).illnessState;
  if (!illness?.active) return '';

  const today = new Date().toISOString().split('T')[0];
  const start = new Date(illness.startDate + 'T12:00:00');
  const todayDate = new Date(today + 'T12:00:00');
  const dayNum = Math.max(1, Math.round((todayDate.getTime() - start.getTime()) / 86400000) + 1);

  const severityLabel = illness.severity === 'resting' ? 'Full rest' : 'Still running';
  const severityDetail = illness.severity === 'resting'
    ? 'All running workouts replaced with rest.'
    : 'Quality sessions → easy. Distances scaled to 50–60%.';

  return `
    <div id="illness-banner" style="margin:14px 16px 0;padding:14px 16px;${PLAN_CARD_STYLE}">
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:12px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span style="font-size:14px;font-weight:600;letter-spacing:-0.01em;color:var(--c-black)">Illness · Day ${dayNum}</span>
            <span style="font-size:10px;font-weight:600;color:var(--c-muted);border:1px solid var(--c-border-strong);border-radius:100px;padding:2px 8px;letter-spacing:0.02em">${severityLabel}</span>
          </div>
          <div style="font-size:12px;color:var(--c-muted);line-height:1.5">${severityDetail} Skipped workouts don't count against adherence.</div>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button id="illness-update-btn"
          style="flex:1;font-size:13px;padding:10px 0;text-align:center;border-radius:10px;border:1px solid var(--c-border-strong);background:transparent;color:var(--c-black);font-weight:500;cursor:pointer;font-family:var(--f)">
          Change
        </button>
        <button id="illness-mark-recovered"
          style="flex:1;font-size:13px;padding:10px 0;text-align:center;border-radius:10px;border:1px solid var(--c-black);background:var(--c-black);color:#fff;font-weight:500;cursor:pointer;font-family:var(--f)">
          Recovered
        </button>
      </div>
    </div>
  `;
}

/**
 * Goal-feasibility banner. Flags when the end-of-plan forecast is materially
 * slower than the user's frozen goal (s.initialBaseline). 20-min threshold is a
 * pragmatic cut-off: smaller deltas fall inside normal race-day variance (weather,
 * fuelling, pacing) and shouldn't alarm the user. Larger deltas mean the current
 * plan + fitness trajectory won't get them there. Surface the gap and offer to
 * add a quality session (same lever as the milestone accept flow).
 */
function buildGoalFeasibilityBanner(s: SimulatorState): string {
  if (s.continuousMode || !s.initialBaseline || !s.forecastTime) return '';
  // Suppress once we hit taper/deload. No time to add stimulus, and the
  // CTA would be misleading with only 2-3 low-volume weeks left to work with.
  const currentWeek = s.wks?.[(s.w ?? 1) - 1];
  if (currentWeek?.ph === 'taper') return '';
  const goalSec = s.initialBaseline;
  // Use course-adjusted finish when available so the banner reflects the
  // realistic prediction the user sees on the home card and detail view.
  const forecastSec = s.forecastTimeAdjusted ?? s.forecastTime;
  const gapSec = forecastSec - goalSec;
  if (gapSec < 20 * 60) return '';
  const gapMin = Math.round(gapSec / 60);
  const canAddSession = (s.epw ?? 0) < 7;
  // One more run a week only adds a quality session when the plan can seat it
  // (quality cap, block budget); otherwise it is an easy run, and the button says so.
  const addsQuality = canAddSession && extraRunAddsQualitySession(runningPlanShapeInputs(s), s.w ?? 1);
  return `
    <div style="margin:14px 16px 0;padding:14px 16px;${PLAN_CARD_STYLE}">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:6px">Goal check</div>
      <div style="font-size:14px;font-weight:500;color:var(--c-black);line-height:1.5;margin-bottom:4px">Forecast finish ${ft(forecastSec)} is ${gapMin} min slower than your goal of ${ft(goalSec)}.</div>
      <div style="font-size:12px;color:var(--c-muted);line-height:1.5;margin-bottom:${canAddSession ? '12px' : '0'}">The prediction updates weekly as your running data comes in. ${addsQuality ? 'Adding a quality session raises the ceiling the plan can hit.' : 'Adding a run a week raises the volume the plan builds.'}</div>
      ${canAddSession ? `<button id="goal-add-session" style="padding:8px 14px;border-radius:100px;border:1px solid var(--c-border);background:transparent;color:var(--c-black);font-size:12px;font-weight:600;cursor:pointer">${addsQuality ? 'Add a quality session' : 'Add a run a week'}</button>` : ''}
    </div>
  `;
}

/**
 * Time-budget banner. Fires when the rendered plan total exceeds the user's
 * stated weekly hours by more than a small slack. Two CTAs: accept the shorter
 * sessions (plan engine has already used soft floors), or bump the hours target
 * to make it fit. Dismissal is tracked against the current `weeklyTrainingHours`
 * value, so the banner re-arms if the user later changes their target.
 *
 * Plan-engine context: `applyHoursBudget` holds easy runs at a 25m floor and
 * consolidates them (fewer, longer) when the budget is tight, trims the long
 * run to its 40m/30m floors, then accepts the residual overflow. The banner is
 * the user-facing surface for that residual.
 */
function buildBudgetBanner(s: SimulatorState, workouts: any[], viewWeek: number): string {
  // Only show on current and future weeks. Past weeks are immutable.
  if (viewWeek < s.w) return '';
  const target = s.onboarding?.weeklyTrainingHours;
  if (target == null || target <= 0) return '';
  const SLACK_MIN = 5;
  const totalMin = workouts.reduce((sum, w) => sum + ((w as any).estimatedDurationMin ?? 0), 0);
  const overflowMin = totalMin - target * 60;
  if (overflowMin <= SLACK_MIN) return '';
  // Dismissed for this hours value?
  if (s.onboarding?.budgetAcceptedAtHours === target) return '';
  // Round recommended hours up to the next 0.5h that fits the plan.
  const recommendedHours = Math.ceil(totalMin / 30) / 2;
  const overflowLabel = overflowMin >= 60
    ? `${(overflowMin / 60).toFixed(1)} h`
    : `${overflowMin} min`;
  return `
    <div id="budget-banner-card" style="margin:14px 16px 0;padding:14px 16px;${PLAN_CARD_STYLE}">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:6px">Time budget</div>
      <div style="font-size:14px;font-weight:500;color:var(--c-black);line-height:1.5;margin-bottom:4px">This week's plan totals about ${(totalMin / 60).toFixed(1)} h, ${overflowLabel} over your ${target} h target.</div>
      <div style="font-size:12px;color:var(--c-muted);line-height:1.5;margin-bottom:12px">Sessions are already at minimum effective duration. Quality work cannot be shortened without losing the training stimulus.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="budget-accept-btn" style="padding:8px 14px;border-radius:100px;border:1px solid var(--c-border);background:transparent;color:var(--c-black);font-size:12px;font-weight:600;cursor:pointer">Accept shorter sessions</button>
        <button id="budget-increase-btn" data-recommended="${recommendedHours}" style="padding:8px 14px;border-radius:100px;border:1px solid var(--c-border);background:transparent;color:var(--c-black);font-size:12px;font-weight:600;cursor:pointer">Increase to ${recommendedHours} h/week</button>
      </div>
    </div>
  `;
}

/**
 * Run-count line (Tristan 2026-10-08). One line when the week holds fewer runs
 * than the runner chose because its weekly budget consolidated easy runs: the
 * fit keeps the fewest runs that each stay at a useful length rather than
 * splitting the budget into short ones (applyHoursBudget in a full plan, the
 * sharpening-block fit in a block). The plan engine decides when this applies
 * and reports it (plan_engine BudgetRunFit): loaded weeks only, never a deload,
 * taper or race week. The resolver drops it when injury, illness, a holiday or
 * its bridge, or a partial first week shapes the week instead
 * (resolveWeekWorkouts planNotes). Current and future weeks only. Wording:
 * budgetRunFitLine. The top margin keeps it apart from the Time budget banner
 * (buildBudgetBanner, no bottom margin), which can show in the same week.
 */
function buildBudgetRunFitNote(s: SimulatorState, fit: BudgetRunFit | undefined, viewWeek: number): string {
  if (!fit || viewWeek < s.w) return '';
  return `<div id="plan-budget-run-fit" style="margin:8px 16px 8px;padding:12px 15px;${PLAN_CARD_STYLE};font-size:13px;font-weight:500;color:var(--c-muted);line-height:1.5">${budgetRunFitLine(fit, s.unitPref ?? 'km')}</div>`;
}

/**
 * Full injury status card. Shown at the top of the plan card list when injury is active.
 */
function buildInjuryBanner(): string {
  if (!isInjuryActive()) return '';

  const inj = getInjuryStateForDisplay();
  const protocol = INJURY_PROTOCOLS[inj.type];
  const displayName = protocol?.displayName || inj.type;

  // Phase label (text only. No colour)
  const phaseLabels: Record<string, string> = {
    acute: 'Acute — Rest',
    rehab: 'Rehabilitation',
    test_capacity: 'Capacity Testing',
    return_to_run: 'Return to Run',
    graduated_return: 'Graduated Return',
    resolved: 'Resolved',
  };
  const phaseLabelText = phaseLabels[inj.injuryPhase] || 'Rehabilitation';

  // Can-run label (text only. Opacity-coded by severity)
  const canRunLabels = {
    yes: 'Can run',
    limited: 'Limited running',
    no: 'No running',
  };
  const canRunText = canRunLabels[inj.canRun] || canRunLabels['no'];

  const levelLabel = inj.injuryPhase === 'return_to_run'
    ? getReturnToRunLevelLabel(inj.returnToRunLevel || 1)
    : inj.injuryPhase === 'graduated_return'
      ? `Week ${3 - (inj.graduatedReturnWeeksLeft || 0)} of 2`
      : '';

  const isReturnPhase = inj.injuryPhase === 'return_to_run' || inj.injuryPhase === 'graduated_return';

  return `
    <div style="margin:14px 16px 0;padding:16px;${PLAN_CARD_STYLE}">

      <!-- Top row: injury name + pain level -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
        <div style="flex:1;min-width:0;padding-right:12px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:4px">Recovery mode</div>
          <div style="font-size:17px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(displayName)}</div>
          <div style="font-size:12px;color:var(--c-muted);margin-top:3px;font-weight:500">${phaseLabelText}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Pain</div>
          <div style="font-size:30px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:var(--c-black)">
            ${inj.currentPain}<span style="font-size:13px;color:var(--c-faint);font-weight:400">/10</span>
          </div>
        </div>
      </div>

      <!-- Can-run + optional level -->
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
        <span style="display:inline-flex;align-items:center;padding:4px 11px;border-radius:100px;font-size:11px;font-weight:600;border:1px solid var(--c-border-strong);color:var(--c-muted);letter-spacing:0.01em">${canRunText}</span>
        ${levelLabel ? `<span style="font-size:11px;color:var(--c-faint);font-weight:500">${levelLabel}</span>` : ''}
      </div>

      ${isReturnPhase ? `
      <div style="padding:10px 12px;border-radius:10px;background:rgba(0,0,0,0.03);margin-bottom:14px">
        <p style="font-size:11px;color:var(--c-muted);line-height:1.55;margin:0">Not medical advice. Consult a sports physiotherapist if pain persists or worsens. Never push through sharp pain.</p>
      </div>` : ''}

      <div style="display:flex;gap:8px">
        <button id="plan-injury-update"
          style="flex:1;font-size:13px;padding:10px 0;text-align:center;border-radius:10px;border:1px solid var(--c-border-strong);background:transparent;color:var(--c-black);font-weight:500;cursor:pointer;font-family:var(--f)">
          Update injury
        </button>
        <button id="plan-injury-recovered"
          style="flex:1;font-size:13px;padding:10px 0;text-align:center;border-radius:10px;border:1px solid var(--c-black);background:var(--c-black);color:#fff;font-weight:500;cursor:pointer;font-family:var(--f)">
          I'm recovered
        </button>
      </div>
    </div>
  `;
}

// ─── Morning pain check ──────────────────────────────────────────────────────

/**
 * Card shown once per day when the user is injured. Asks: Worse / Same / Better.
 * Renders nothing if not injured or already answered today.
 */
function buildMorningPainCheck(): string {
  if (!isInjuryActive()) return '';

  const s = getState();
  const today = new Date().toISOString().split('T')[0];
  if ((s as any).lastMorningPainDate === today) return '';

  const inj = getInjuryStateForDisplay();
  const pain = inj.currentPain || 0;
  const protocol = INJURY_PROTOCOLS[inj.type];
  const injName = protocol?.displayName || inj.type;

  const btnBase = 'padding:12px 0;border-radius:10px;border:1px solid var(--c-border-strong);background:transparent;cursor:pointer;font-size:13px;font-weight:500;color:var(--c-black);font-family:var(--f)';

  return `
    <div id="morning-pain-check" style="margin:12px 16px 0;padding:16px;${PLAN_CARD_STYLE}">
      <div style="margin-bottom:13px">
        <div style="font-size:14px;font-weight:600;letter-spacing:-0.01em;color:var(--c-black);margin-bottom:3px">Morning check-in</div>
        <div style="font-size:12px;color:var(--c-muted);line-height:1.5">How does your ${injName.toLowerCase()} feel vs yesterday? <span style="color:var(--c-faint);font-weight:500">· Pain ${pain}/10</span></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px">
        <button class="plan-morning-pain-btn" data-response="worse" style="${btnBase}">Worse</button>
        <button class="plan-morning-pain-btn" data-response="same" style="${btnBase}">Same</button>
        <button class="plan-morning-pain-btn" data-response="better" style="${btnBase}">Better</button>
      </div>
    </div>
  `;
}

/**
 * Handle a morning pain response. Persists the entry, updates pain level,
 * and replaces the card with a quiet confirmation message.
 */
function handleMorningPainResponse(response: 'worse' | 'same' | 'better'): void {
  const s = getMutableState();
  const injuryState = (s as any).injuryState;
  if (!injuryState) return;

  const today = new Date().toISOString().split('T')[0];
  s.lastMorningPainDate = today;

  const entry: MorningPainResponse = {
    date: today,
    response,
    painLevel: injuryState.currentPain || 0,
  };
  if (!injuryState.morningPainResponses) injuryState.morningPainResponses = [];
  injuryState.morningPainResponses.push(entry);

  const newPain = response === 'better'
    ? Math.max(0, (injuryState.currentPain || 1) - 1)
    : response === 'worse'
      ? Math.min(10, (injuryState.currentPain || 1) + 1)
      : injuryState.currentPain;

  (s as any).injuryState = recordMorningPain(injuryState, newPain);
  saveState();

  // Inline feedback. No full re-render
  const container = document.getElementById('morning-pain-check');
  if (!container) return;

  const msgs = {
    worse: 'Logged. Extra rest added to today.',
    same: 'Logged. Steady as she goes.',
    better: 'Improvement logged.',
  };
  const text = msgs[response];

  container.style.transition = 'opacity 0.2s';
  container.style.opacity = '0';
  setTimeout(() => {
    container.innerHTML = `
      <div style="padding:14px 16px;${PLAN_CARD_STYLE}">
        <span style="font-size:13px;color:var(--c-muted);line-height:1.4">${text}</span>
      </div>
    `;
    container.style.opacity = '1';
    container.style.border = 'none';
    container.style.background = 'transparent';
    container.style.boxShadow = 'none';
  }, 200);
}

// ─── Recovery pill ───────────────────────────────────────────────────────────

// ─── Benchmark panel ─────────────────────────────────────────────────────────

/** Format a recorded benchmark result for display */
function formatBenchmarkResult(result: any): string {
  const unitPref = getState().unitPref ?? 'km';
  const fmtPace = (sec: number) => formatPace(sec, unitPref);
  switch (result.type) {
    case 'easy_checkin':
      return result.avgPaceSecKm ? `Easy check-in · ${fmtPace(result.avgPaceSecKm)} avg` : `Easy check-in · ${result.durationSec ? Math.round(result.durationSec / 60) + 'min' : 'logged'}`;
    case 'threshold_check':
      return result.avgPaceSecKm ? `Threshold check · ${fmtPace(result.avgPaceSecKm)}` : 'Threshold check · logged';
    case 'speed_check':
      return result.distanceKm ? `Speed check · ${formatKm(result.distanceKm, unitPref, 2)} in 12 min` : 'Speed check · logged';
    case 'race_simulation':
      return result.distanceKm && result.durationSec
        ? `Race sim · ${formatKm(result.distanceKm, unitPref)} in ${Math.floor(result.durationSec / 60)}:${String(Math.round(result.durationSec % 60)).padStart(2, '0')}`
        : 'Race simulation · logged';
    default: return 'Check-in recorded';
  }
}

/**
 * Optional fitness check-in panel. Shown on post-deload weeks for continuous mode users.
 * Compact status card: not yet started → open overlay | workout added | completed | skipped.
 */
function buildBenchmarkPanel(s: SimulatorState): string {
  if (!(s as any).continuousMode) return '';
  if (!isBenchmarkWeek(s.w, true)) return '';

  const existing = (s as any).benchmarkResults?.find((b: any) => b.week === s.w);

  // Skipped
  if (existing?.source === 'skipped') {
    return `
      <div style="margin:12px 16px 0;padding:13px 15px;${PLAN_CARD_STYLE}">
        <span style="font-size:12px;color:var(--c-muted)">Check-in skipped this block.</span>
      </div>
    `;
  }

  // Recorded (from watch or generated workout completed)
  if (existing && existing.source !== 'skipped') {
    const resultText = formatBenchmarkResult(existing);
    return `
      <div style="margin:12px 16px 0;padding:14px 16px;${PLAN_CARD_STYLE}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
          <span style="font-size:13px;font-weight:600;color:var(--c-black)">Check-in recorded</span>
          ${existing.source === 'garmin' ? `<span style="font-size:10px;font-weight:600;color:var(--c-muted);border:1px solid var(--c-border-strong);padding:2px 8px;border-radius:100px;letter-spacing:0.02em">From watch</span>` : ''}
        </div>
        <div style="font-size:12px;color:var(--c-muted);line-height:1.5">${resultText}</div>
      </div>
    `;
  }

  // Check if a benchmark workout was already added to this week
  const wk = s.wks?.[s.w - 1];
  const hasBenchmarkWorkout = wk?.adhocWorkouts?.some((w: Workout) => w.id?.startsWith('benchmark-'));

  if (hasBenchmarkWorkout) {
    return `
      <div style="margin:12px 16px 0;padding:14px 16px;${PLAN_CARD_STYLE}">
        <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:3px">Check-in workout added</div>
        <div style="font-size:12px;color:var(--c-muted);line-height:1.5">Complete the workout and results will be recorded automatically from your watch.</div>
      </div>
    `;
  }

  // Not started. Show prompt to open overlay
  return `
    <div style="margin:12px 16px 0;padding:16px;${PLAN_CARD_STYLE}">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:13px;font-weight:600;color:#0F172A;margin-bottom:2px">Fitness check-in available</div>
          <div style="font-size:12px;color:#64748B;line-height:1.4">Post-deload. Good time to measure fitness.</div>
        </div>
        <button id="btn-benchmark-open"
          style="padding:8px 16px;border-radius:100px;border:1px solid var(--c-border);
                 background:transparent;font-size:12px;font-weight:600;color:#0F172A;
                 cursor:pointer;font-family:var(--f);white-space:nowrap">
          Choose
        </button>
      </div>
    </div>
  `;
}


// ─── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Compact recovery status row. Shown at the top of the plan card list.
 * States: no data (prompt) | green (all good) | amber/orange/red + unresolved (tap to adjust) | prompted (quiet dot).
 */
function buildRecoveryPill(s: SimulatorState): string {
  const today = new Date().toISOString().split('T')[0];
  const history: RecoveryEntry[] = (s as any).recoveryHistory || [];
  const todayEntry = history.find(e => e.date === today) || null;
  const alreadyPrompted = (s as any).lastRecoveryPromptDate === today;
  const { level, shouldPrompt } = computeRecoveryStatus(todayEntry, history);

  // Config per level
  const cfg: Record<string, { label: string; dot: string; bg: string; border: string; text: string }> = {
    green: { label: 'Well rested', dot: '#22C55E', bg: 'rgba(240,253,244,0.7)', border: 'rgba(34,197,94,0.2)', text: '#15803D' },
    yellow: { label: 'Fair recovery', dot: '#F59E0B', bg: 'rgba(255,251,235,0.7)', border: 'rgba(245,158,11,0.2)', text: '#92400E' },
    orange: { label: 'Low recovery', dot: '#F97316', bg: 'rgba(255,247,237,0.7)', border: 'rgba(249,115,22,0.2)', text: '#9A3412' },
    red: { label: 'Very low', dot: '#EF4444', bg: 'rgba(254,242,242,0.7)', border: 'rgba(239,68,68,0.2)', text: '#991B1B' },
  };

  const base = `
    style="margin:10px 18px 0;display:flex;align-items:center;justify-content:space-between;
           padding:10px 14px;border-radius:12px;border:1px solid
  `;

  if (!todayEntry) {
    // No data. Invite to log
    return `
      <div ${base}var(--c-border);background:var(--c-surface)">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="width:8px;height:8px;border-radius:50%;background:rgba(0,0,0,0.18);flex-shrink:0"></span>
          <span style="font-size:13px;color:var(--c-muted)">Sleep not logged yet</span>
        </div>
        <button id="plan-recovery-log"
          style="font-size:12px;font-weight:600;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:0">
          Log sleep →
        </button>
      </div>
    `;
  }

  const c = cfg[level] || cfg.green;

  if (level === 'green' || alreadyPrompted || !shouldPrompt) {
    // Logged + OK (or already acted on today). Quiet confirmation
    return `
      <div ${base}${c.border};background:${c.bg}">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="width:8px;height:8px;border-radius:50%;background:${c.dot};flex-shrink:0"></span>
          <span style="font-size:13px;font-weight:500;color:${c.text}">${c.label}</span>
        </div>
        <button id="plan-recovery-log"
          style="font-size:11px;color:rgba(0,0,0,0.35);background:none;border:none;cursor:pointer;padding:0">
          Update
        </button>
      </div>
    `;
  }

  // Poor recovery + not yet prompted → show CTA to adjust plan
  return `
    <div ${base}${c.border};background:${c.bg}">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="width:8px;height:8px;border-radius:50%;background:${c.dot};flex-shrink:0"></span>
        <div>
          <span style="font-size:13px;font-weight:500;color:${c.text}">${c.label}</span>
          <span style="font-size:11px;color:rgba(0,0,0,0.38);margin-left:6px">Adjust today?</span>
        </div>
      </div>
      <button id="plan-recovery-adjust"
        style="font-size:12px;font-weight:600;color:${c.text};background:none;border:none;cursor:pointer;padding:0">
        Adjust →
      </button>
    </div>
  `;
}

/**
 * 7-day recovery history panel with dot indicators.
 * Compact card below the status pill. Always visible when there is any history.
 */
function buildRecoveryLogPanel(s: SimulatorState): string {
  const history: RecoveryEntry[] = (s as any).recoveryHistory || [];
  const today = new Date().toISOString().split('T')[0];
  const loggedToday = history.some(e => e.date === today);

  if (history.length === 0) return '';

  // Build last 7 days in order (oldest first)
  const last7 = history.slice(-7);

  const dotStyle = (score: number): string => {
    if (score >= 80) return 'background:var(--c-ok)';
    if (score >= 65) return 'background:var(--c-ok-muted)';
    if (score >= 50) return 'background:var(--c-caution)';
    return 'background:var(--c-warn)';
  };

  const shortDate = (iso: string): string => {
    const [, , d] = iso.split('-');
    return d.replace(/^0/, '');
  };

  const dots = last7.map(e => `
    <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1">
      <div style="width:10px;height:10px;border-radius:50%;${dotStyle(e.sleepScore)}" title="${e.date}"></div>
      <span style="font-size:9px;color:var(--c-faint);font-weight:500">${shortDate(e.date)}</span>
    </div>
  `).join('');

  // Pad with empty slots if < 7 days of data
  const emptySlots = Math.max(0, 7 - last7.length);
  const empties = Array.from({ length: emptySlots }, () => `
    <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1">
      <div style="width:10px;height:10px;border-radius:50%;background:var(--c-faint)"></div>
      <span style="font-size:9px;color:var(--c-faint)">–</span>
    </div>
  `).join('');

  return `
    <div class="m-card" style="margin:0 14px 10px;padding:12px 14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <span style="font-size:12px;font-weight:600;color:var(--c-black);letter-spacing:-0.01em">Sleep · 7 days</span>
        <button id="plan-recovery-log-panel"
          style="font-size:12px;font-weight:600;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:0">
          ${loggedToday ? 'Update ✓' : 'Log today'}
        </button>
      </div>
      <div style="display:flex;align-items:center;gap:0">
        ${empties}${dots}
      </div>
    </div>
  `;
}

/**
 * Bottom-sheet modal for logging how recovered you feel today (1–10 scale).
 */
export function showRecoveryLogModal(): void {
  const overlay = document.createElement('div');
  overlay.id = 'plan-recovery-overlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center;';

  // Build 10 colour-graded buttons (1 = red, 10 = green)
  const buttons = Array.from({ length: 10 }, (_, i) => {
    const score = i + 1;
    // Interpolate hue from 0° (red) at 1 to 120° (green) at 10
    const hue = Math.round(((score - 1) / 9) * 120);
    const isHighEnd = score >= 8;
    return `
      <button class="plan-recovery-score-btn" data-score="${score}"
        style="flex:1;padding:10px 0;border-radius:10px;border:none;cursor:pointer;
               background:hsl(${hue},75%,${isHighEnd ? 42 : 50}%);color:#fff;
               font-size:15px;font-weight:700;line-height:1">
        ${score}
      </button>`;
  }).join('');

  overlay.innerHTML = `
    <div style="width:100%;max-width:480px;background:var(--c-surface);border-radius:20px 20px 0 0;
                padding:0 0 env(safe-area-inset-bottom,16px);overflow:hidden">
      <div style="display:flex;justify-content:center;padding:12px 0 4px">
        <div style="width:36px;height:4px;border-radius:2px;background:rgba(0,0,0,0.12)"></div>
      </div>
      <div style="padding:4px 20px 20px">
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.02em;margin-bottom:4px">How recovered do you feel today?</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px">We'll adjust your workout if needed.</div>
        <div style="display:flex;gap:5px;margin-bottom:10px">${buttons}</div>
        <div style="display:flex;justify-content:space-between;margin-bottom:16px">
          <span style="font-size:11px;color:var(--c-muted)">Very fatigued</span>
          <span style="font-size:11px;color:var(--c-muted)">Fully rested</span>
        </div>
        <button id="plan-recovery-modal-cancel"
          style="width:100%;padding:12px;font-size:13px;color:var(--c-muted);background:none;border:none;cursor:pointer">
          Cancel
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelectorAll('.plan-recovery-score-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const score = parseInt((btn as HTMLElement).dataset.score ?? '5', 10);
      overlay.remove();
      handleRecoveryScoreInput(score);
    });
  });

  document.getElementById('plan-recovery-modal-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function handleRecoveryScoreInput(score: number): void {
  const s = getMutableState();
  const today = new Date().toISOString().split('T')[0];
  // Map 1–10 → 10–100 sleep score equivalent
  const sleepScore = score * 10;

  const entry: RecoveryEntry = { date: today, sleepScore, source: 'manual' };

  if (!s.recoveryHistory) s.recoveryHistory = [];
  const idx = s.recoveryHistory.findIndex((e: RecoveryEntry) => e.date === today);
  if (idx >= 0) {
    s.recoveryHistory[idx] = entry;
  } else {
    s.recoveryHistory.push(entry);
  }
  // Cap history at 30 entries
  if (s.recoveryHistory.length > 30) s.recoveryHistory = s.recoveryHistory.slice(-30);

  s.lastRecoveryPromptDate = today;
  saveState();

  if (sleepScore < 70) {
    renderPlanView();
    setTimeout(() => showRecoveryAdjustModal(entry), 80);
  } else {
    renderPlanView();
  }
}

/**
 * Bottom-sheet modal shown when recovery is low. Offers to adjust today's run.
 * Exported so main.ts orchestration can call it after Garmin physiology sync.
 */
export function showRecoveryAdjustModal(entry: RecoveryEntry): void {
  const s = getState();
  const history: RecoveryEntry[] = (s as any).recoveryHistory || [];
  const { level, reasons } = computeRecoveryStatus(entry, history);

  const wk = s.wks[s.w - 1];
  if (!wk) return;

  // The week as the Plan tab shows it (canonical resolver). A session a holiday or
  // an illness rest day stands down is not offered, matching applyRecoveryAdjustment,
  // which sizes the change from the same session's plan values.
  const workouts = resolveWeekWorkouts(s, s.w);

  const jsDay = new Date().getDay();
  const todayIdx = jsDay === 0 ? 6 : jsDay - 1;

  const runWorkouts = workouts.filter((w: any) =>
    w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest' && w.status !== 'replaced'
    && !isStoodDownByLayer(w)
  );

  let todayWorkout = runWorkouts.find((w: any) => w.dayOfWeek === todayIdx);
  if (!todayWorkout && runWorkouts.length > 0) {
    const unrated = runWorkouts.filter((w: any) => !wk.rated[(w.id || w.n)]);
    todayWorkout = unrated[0] || runWorkouts[0];
  }

  const levelMeta: Record<RecoveryLevel, { label: string; color: string; bg: string }> = {
    green: { label: 'Good', color: 'var(--c-ok)', bg: 'var(--c-ok-bg)' },
    yellow: { label: 'Low', color: '#d97706', bg: '#fef3c7' },
    orange: { label: 'Low', color: '#ea580c', bg: '#ffedd5' },
    red: { label: 'Very Low', color: 'var(--c-warn)', bg: '#fee2e2' },
  };
  const meta = levelMeta[level];
  const isEasyType = todayWorkout && (todayWorkout.t === 'easy' || todayWorkout.t === 'long');

  const overlay = document.createElement('div');
  overlay.id = 'recovery-adjust-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center;z-index:9999;';

  overlay.innerHTML = `
    <div style="background:var(--c-surface);border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:0 0 env(safe-area-inset-bottom,0)">
      <!-- Handle -->
      <div style="display:flex;justify-content:center;padding:12px 0 4px">
        <div style="width:36px;height:4px;border-radius:2px;background:var(--c-border-strong)"></div>
      </div>

      <div style="padding:16px 20px 24px">
        <!-- Recovery status badge -->
        <div style="display:inline-flex;align-items:center;gap:6px;background:${meta.bg};border-radius:20px;padding:4px 10px 4px 6px;margin-bottom:14px">
          <div style="width:8px;height:8px;border-radius:50%;background:${meta.color}"></div>
          <span style="font-size:13px;font-weight:600;color:${meta.color}">Recovery: ${meta.label}</span>
        </div>

        ${reasons.length > 0 ? `
          <ul style="margin:0 0 14px;padding:0;list-style:none">
            ${reasons.map(r => `
              <li style="font-size:13px;color:var(--c-muted);display:flex;gap:6px;margin-bottom:4px">
                <span style="color:var(--c-faint)">•</span>${r}
              </li>
            `).join('')}
          </ul>
        ` : ''}

        ${todayWorkout ? `
          <div style="background:var(--c-faint);border-radius:10px;padding:10px 12px;margin-bottom:16px;display:flex;align-items:center;gap:8px">
            <div>
              <div style="font-size:12px;color:var(--c-muted);font-weight:500">Today</div>
              <div style="font-size:14px;font-weight:600;color:var(--c-black)">${todayWorkout.n}</div>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px">
            ${isEasyType ? `
              <button id="ra-easyflag" style="background:var(--c-ok-bg);border:1.5px solid var(--c-ok);border-radius:12px;padding:12px 14px;text-align:left;cursor:pointer;position:relative">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <span style="font-size:14px;font-weight:600;color:var(--c-ok)">Run by feel</span>
                  ${level === 'red' || level === 'orange' ? `<span style="font-size:11px;font-weight:600;color:var(--c-ok);background:rgba(16,185,129,0.15);padding:2px 8px;border-radius:10px">Recommended</span>` : ''}
                </div>
                <div style="font-size:12px;color:var(--c-muted);margin-top:2px">Ignore pace targets. Just get the run in.</div>
              </button>
            ` : `
              <button id="ra-downgrade" style="background:var(--c-ok-bg);border:1.5px solid var(--c-ok);border-radius:12px;padding:12px 14px;text-align:left;cursor:pointer">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <span style="font-size:14px;font-weight:600;color:var(--c-ok)">Downgrade to Easy</span>
                  ${level === 'red' || level === 'orange' ? `<span style="font-size:11px;font-weight:600;color:var(--c-ok);background:rgba(16,185,129,0.15);padding:2px 8px;border-radius:10px">Recommended</span>` : ''}
                </div>
                <div style="font-size:12px;color:var(--c-muted);margin-top:2px">Keep distance, lower intensity</div>
              </button>
            `}

            <button id="ra-reduce" style="background:var(--c-surface);border:1.5px solid var(--c-border-strong);border-radius:12px;padding:12px 14px;text-align:left;cursor:pointer">
              <div style="font-size:14px;font-weight:600;color:var(--c-black)">Reduce Distance</div>
              <div style="font-size:12px;color:var(--c-muted);margin-top:2px">Cut by 20% · keep workout type</div>
            </button>

            <button id="ra-ignore" style="background:transparent;border:none;padding:10px;cursor:pointer;text-align:center">
              <span style="font-size:14px;color:var(--c-muted)">Keep plan unchanged</span>
            </button>
          </div>
        ` : `
          <p style="font-size:13px;color:var(--c-muted);margin:0 0 16px">No run scheduled today. No adjustments needed.</p>
          <button id="ra-dismiss" class="m-btn-glass m-btn-glass--inset" style="width:100%">Dismiss</button>
        `}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  if (todayWorkout) {
    const workoutDay = (todayWorkout as any).dayOfWeek ?? todayIdx;
    const workoutName = todayWorkout.n;

    overlay.querySelector('#ra-easyflag')?.addEventListener('click', () => {
      overlay.remove();
      (window as any).applyRecoveryAdjustment('easyflag', workoutDay, workoutName);
    });
    overlay.querySelector('#ra-downgrade')?.addEventListener('click', () => {
      overlay.remove();
      (window as any).applyRecoveryAdjustment('downgrade', workoutDay, workoutName);
    });
    overlay.querySelector('#ra-reduce')?.addEventListener('click', () => {
      overlay.remove();
      (window as any).applyRecoveryAdjustment('reduce', workoutDay, workoutName);
    });
    overlay.querySelector('#ra-ignore')?.addEventListener('click', () => {
      overlay.remove();
      markRecoveryPrompted();
    });
  } else {
    overlay.querySelector('#ra-dismiss')?.addEventListener('click', () => {
      overlay.remove();
      markRecoveryPrompted();
    });
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); markRecoveryPrompted(); } });
}

function markRecoveryPrompted(): void {
  const s = getMutableState();
  (s as any).lastRecoveryPromptDate = new Date().toISOString().split('T')[0];
  saveState();
  renderPlanView();
}

// ─── Carry-over card ─────────────────────────────────────────────────────────

function buildCarryOverCard(wk: Week | undefined): string {
  if (!wk?.hasCarriedLoad || wk.carryOverCardDismissed) return '';
  // Only count items whose date falls BEFORE this week's start. Items added via
  // populateUnspentLoadItems for current-week excess are not carry-overs.
  const s = getState();
  let weekStartIso = '';
  if (s.planStartDate && wk.w != null) {
    const d = new Date(s.planStartDate);
    d.setDate(d.getDate() + (wk.w - 1) * 7);
    weekStartIso = d.toISOString().slice(0, 10);
  }
  const carriedItems = weekStartIso
    ? (wk.unspentLoadItems ?? []).filter(i => i.date < weekStartIso)
    : (wk.unspentLoadItems ?? []);
  const count = carriedItems.length;
  if (count === 0) return '';
  return `
    <div id="plan-carry-over-card" style="margin:12px 16px 0;padding:13px 15px;${PLAN_CARD_STYLE};display:flex;align-items:flex-start;justify-content:space-between;gap:10px;cursor:pointer">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:2px">Unresolved load from last week</div>
        <div style="font-size:12px;color:var(--c-muted);line-height:1.5">${count} cross-training ${count === 1 ? 'activity' : 'activities'} carried over. Tap to adjust this week.</div>
      </div>
      <button id="plan-carry-over-dismiss" style="flex-shrink:0;background:none;border:none;cursor:pointer;padding:0;color:var(--c-muted);font-size:18px;line-height:1;opacity:0.5" aria-label="Dismiss">×</button>
    </div>`;
}

// ─── Consecutive-skip coaching note ──────────────────────────────────────────

/**
 * Shows a plain coaching note when the user has pushed workouts in 2+ consecutive
 * completed weeks. Signals that the sliding pattern is becoming a habit and will
 * eventually cause workouts to be dropped.
 *
 * Only fires in the current week view (not future or past week previews) and
 * only when there are actual skips detected.
 */
function buildConsecutiveSkipNote(s: SimulatorState, viewWeek: number): string {
  if (viewWeek !== s.w) return '';
  const wks = s.wks ?? [];
  const completedWeeks = Math.max(0, (s.w ?? 1) - 1);
  let consecutiveCount = 0;
  for (let i = completedWeeks - 1; i >= 0; i--) {
    if ((wks[i]?.skip?.length ?? 0) > 0) {
      consecutiveCount++;
    } else {
      break;
    }
  }
  if (consecutiveCount < 2) return '';
  return `
    <div style="margin:0 16px 8px;padding:11px 14px;border-radius:12px;background:var(--c-surface);border:1px solid var(--c-border)">
      <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:2px">Sessions sliding for ${consecutiveCount} weeks</div>
      <div style="font-size:12px;color:var(--c-muted);line-height:1.45">Workouts pushed to next week will drop on a second skip and affect your race prediction. Consider reducing this week's volume instead.</div>
    </div>`;
}

// ─── Km nudge card ───────────────────────────────────────────────────────────

interface KmNudgeCandidate {
  workoutName: string;
  dayOfWeek: number;
  currentDistanceKm: number;
  extensionKm: number;
  wasReduced: boolean;
}

/**
 * Compute candidate easy runs that could be extended to bring running km toward the floor.
 * For cross-training-reduced runs: can restore up to the amount removed.
 * For unreduced runs: can extend up to 20% of planned km, clamped 1.5–5km.
 */
function computeKmNudgeCandidates(
  workouts: Workout[],
  wk: Week,
  floorKm: number,
): KmNudgeCandidate[] {
  const mods = wk.workoutMods ?? [];
  const candidates: KmNudgeCandidate[] = [];

  for (const w of workouts) {
    // Only uncompleted easy runs (not already rated, not already KmNudge-extended)
    if (w.t !== 'easy') continue;
    if (wk.rated[w.id ?? w.n]) continue;
    if (mods.some(m => m.name === w.n && m.modReason?.startsWith('KmNudge:'))) continue;

    const distMatch = w.d?.match(/(\d+\.?\d*)\s*km/i);
    const currentKm = distMatch ? parseFloat(distMatch[1]) : 0;
    if (currentKm <= 0) continue;

    // Check if this run was reduced by cross-training
    const reduceMod = mods.find(m =>
      m.name === w.n &&
      (m.status === 'reduced') &&
      !m.modReason?.startsWith('KmNudge:') &&
      !m.modReason?.startsWith('Auto:')
    );

    let maxAddKm: number;
    let wasReduced = false;
    if (reduceMod?.originalDistance) {
      const origMatch = reduceMod.originalDistance.match(/(\d+\.?\d*)\s*km/i);
      const originalKm = origMatch ? parseFloat(origMatch[1]) : currentKm;
      maxAddKm = originalKm - currentKm;
      wasReduced = maxAddKm > 0;
    } else {
      maxAddKm = Math.min(5, Math.max(1.5, Math.round(currentKm * 0.20 * 2) / 2));
    }

    if (maxAddKm < 1.0) continue;

    candidates.push({
      workoutName: w.n,
      dayOfWeek: w.dayOfWeek ?? 0,
      currentDistanceKm: currentKm,
      extensionKm: Math.round(maxAddKm * 10) / 10,
      wasReduced,
    });
  }

  return candidates;
}

function buildKmNudgeCard(wk: Week | undefined, s: SimulatorState, workouts: Workout[]): string {
  if (!wk?.kmNudge || wk.kmNudgeDismissed) return '';
  // Guard against legacy format (old state without floorKm)
  if (!('floorKm' in wk.kmNudge)) return '';

  const { floorKm, hasReductions } = wk.kmNudge;
  const unitPref = s.unitPref ?? 'km';
  const candidates = computeKmNudgeCandidates(workouts, wk, floorKm);
  if (candidates.length === 0) return '';

  const headline = hasReductions
    ? 'Running km low, but load has been high'
    : 'Running below target';

  const body = hasReductions
    ? `Some runs were reduced for load management. Getting the distance in at easy effort keeps aerobic development on track. Floor: ${formatKm(floorKm, unitPref, 0)}/week.`
    : `Running km has been below ${formatKm(floorKm, unitPref, 0)} for 2+ weeks. Consider extending an easy run.`;

  const buttons = candidates.map(c => {
    const newKm = c.currentDistanceKm + c.extensionKm;
    const label = `+ ${formatKm(c.extensionKm, unitPref)} to ${escapeHtml(c.workoutName)}`;
    const detail = `${formatKm(c.currentDistanceKm, unitPref)} → ${formatKm(newKm, unitPref)}`;
    return `<button class="km-nudge-apply-btn" data-name="${escapeHtml(c.workoutName)}" data-day="${c.dayOfWeek}" style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;color:var(--c-black);background:transparent;border:1px solid var(--c-border-strong);border-radius:10px;padding:9px 13px;cursor:pointer;width:100%;text-align:left;font-family:var(--f)">`
      + `<span>${label}</span><span style="font-weight:400;color:var(--c-muted);font-size:11px">${detail}</span></button>`;
  }).join('');

  return `
    <div id="plan-km-nudge-card" style="margin:12px 16px 0;padding:14px 16px;${PLAN_CARD_STYLE}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:2px">${headline}</div>
          <div style="font-size:12px;color:var(--c-muted);line-height:1.5">${body}</div>
        </div>
        <button id="plan-km-nudge-dismiss" style="flex-shrink:0;background:none;border:none;cursor:pointer;padding:0;color:var(--c-muted);font-size:18px;line-height:1;opacity:0.5" aria-label="Dismiss">×</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${buttons}
      </div>
    </div>`;
}

// ─── Vibes Run nudge card ────────────────────────────────────────────────────

/**
 * Build-phase discovery nudge for the Vibes Run feature. One-shot per plan:
 * surfaces on the current week if it sits in a build phase and the user hasn't
 * dismissed (or accepted) it yet. Excluded from triathlon and cycling modes.
 */
function buildVibesRunNudgeCard(s: SimulatorState, wk: Week | undefined, viewWeek: number): string {
  if (!wk) return '';
  if (viewWeek !== s.w) return '';
  if (wk.ph !== 'build') return '';
  if (s.vibesRunNudgeDismissed) return '';

  return `
    <div id="plan-vibes-nudge-card" style="margin:12px 16px 0;padding:14px 16px;${PLAN_CARD_STYLE};position:relative;overflow:hidden">
      <div aria-hidden="true" style="position:absolute;top:0;left:0;width:240px;height:240px;pointer-events:none;
        background:radial-gradient(ellipse 70% 70% at 18% 18%, rgba(255,248,229,0.5) 0%, rgba(255,248,229,0.18) 30%, transparent 70%)"></div>
      <div style="position:relative">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:4px">Run by Feel</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.55;margin-bottom:8px">Extra session. Sometimes plans are too prescriptive. Listening to your body lets you push yourself. 5km easy, then keep going if it's still fun.</div>
            <div style="font-size:12px;color:var(--c-black);line-height:1.55;margin-bottom:8px;font-style:italic">Tristan (our founder) got his half marathon PB on one of these.</div>
            <button id="vibes-nudge-science" style="background:none;border:none;padding:0;font-size:11px;color:var(--c-muted);cursor:pointer;text-align:left;font-family:var(--f);line-height:1.5">The science: fartlek, central governor, flow states, Born to Run</button>
          </div>
          <button id="vibes-nudge-dismiss" style="flex-shrink:0;background:none;border:none;cursor:pointer;padding:0;color:var(--c-muted);font-size:18px;line-height:1;opacity:0.5" aria-label="Dismiss">×</button>
        </div>
        <button id="vibes-nudge-try" style="margin-top:6px;display:inline-flex;align-items:center;padding:9px 14px;font-size:12px;font-weight:600;color:var(--c-black);background:transparent;border:1px solid var(--c-border-strong);border-radius:10px;cursor:pointer;font-family:var(--f)">Try one</button>
      </div>
    </div>`;
}

// ─── Adjust week row ─────────────────────────────────────────────────────────

function buildAdjustWeekRow(wk: Week | undefined, s: SimulatorState): string {
  const isCurrentWeek = wk?.w === s.w;
  if (!isCurrentWeek) return '';

  const _plannedB = wk ? computePlannedWeekTarget(s, s.w) : 0;
  const _carriedForStrip = computeCurrentWeekCarry(s, s.w);
  const _excessThisWeek = wk ? getWeeklyExcess(wk, _plannedB, s.planStartDate) : 0;
  const _excess = wk ? getWeeklyExcess(wk, _plannedB, s.planStartDate, _carriedForStrip) : 0;
  const _hasPendingExcess = _excess > 15;
  const carryPortion = Math.round(_carriedForStrip);

  // Only show when total effective load exceeds planned. Carry alone (under target) is informational only.
  if (!_hasPendingExcess) return '';

  const _hasRemaining = hasRemainingWeekWorkouts();
  const excess = Math.round(_excess);

  const stripLabel = carryPortion > 0 && carryPortion >= excess * 0.3
    ? `${excess} TSS excess (${carryPortion} from last week)`
    : `${excess} TSS excess`;

  if (!_hasRemaining) {
    return `
      <div style="padding:8px 18px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:12px;color:var(--c-muted);font-weight:500">${stripLabel}</span>
      </div>`;
  }

  return `
    <button id="plan-adjust-week-btn" style="width:100%;padding:9px 18px;background:transparent;border:none;border-bottom:1px solid var(--c-border);display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-family:var(--f)">
      <span style="font-size:12px;color:var(--c-muted);font-weight:500">${stripLabel}</span>
      <span style="font-size:11px;color:var(--c-muted);text-decoration:underline;text-underline-offset:2px">Adjust plan</span>
    </button>`;
}

// ─── Week Overview (coach signals) ───────────────────────────────────────────

function _renderPills(pills: SignalPill[]): string {
  return pills.map(p => {
    const c = PILL_COLORS[p.color];
    return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:3px 9px;border-radius:10px;background:${c.bg};color:${c.text};white-space:nowrap"><span style="font-size:9px;opacity:0.6;letter-spacing:0.04em">${p.label.toUpperCase()}</span>${p.value}</span>`;
  }).join('');
}

// buildWeekOverview removed. Pills now rendered inline in header

// Computes the resolved workout list for a given week with all mods/moves/illness/holiday/bridge applied.
// Shared between getPlanHTML (full render) and rerenderWeekListLocal (localized drag-and-drop rerender).
// Delegates to the canonical resolveWeekWorkouts (week-resolve.ts) so the Home
// Today card reads the SAME plan — see CLAUDE.md "same source" rule. The only
// thing this wrapper adds is populating the drag-and-drop _workoutLookup.
function computeRenderedWorkouts(s: SimulatorState, viewWeek: number, planNotes?: PlanWeekNotes): any[] {
  const workouts = resolveWeekWorkouts(s, viewWeek, { planNotes });

  _workoutLookup = new Map();
  for (const w of workouts) {
    _workoutLookup.set(w.id || w.n, w);
  }

  return workouts;
}

/**
 * Plan-card Mark as Done. Rates the slot (as before) and, for a run, stores the
 * session's planned load as its activity record (audit B9). Tracking side: the
 * record carries the planned duration (the same estimateWorkoutDurMin dose the
 * card's planned load uses) and planned distance at the rated RPE, stamped on
 * the planned day, so the run counts in Signal A, weekly and daily Signal B and
 * the rolling ACWR. A watch copy that syncs later supersedes it in place.
 *
 * recordPlannedRunDone decides whether a record is written: non-run cards
 * (cross, injury cross-training, strength, capacity test, gym, rest) and
 * future-week cards keep the rating-only behaviour.
 */
function markPlanCardDone(el: HTMLElement): void {
  const wId = el.dataset.workoutId || '';
  const name = el.dataset.name || '';
  const rpe = parseInt(el.dataset.rpe || '5', 10);
  const type = el.dataset.type || 'easy';
  const weekNum = el.dataset.weekNum ? parseInt(el.dataset.weekNum, 10) : undefined;
  // Read the rendered workout before rate(): rate() re-renders, which rebuilds the lookup.
  const w = _workoutLookup.get(wId);
  rate(wId, name, rpe, rpe, type, false, undefined, weekNum);

  if (!w) return;
  const ms = getMutableState();
  const wn = weekNum ?? ms.w;
  const wk = ms.wks?.[wn - 1];
  if (!wk) return;
  const written = recordPlannedRunDone(wk, wId, w, {
    rpe,
    durationMin: estimateWorkoutDurMin(w, planCardBaseMinPerKm(ms)),
    planStartDate: ms.planStartDate,
    weekNum: wn,
    currentWeek: ms.w,
  });
  if (written) saveState();
}

// ─── Main render ─────────────────────────────────────────────────────────────

function getPlanHTML(s: SimulatorState, viewWeek: number): string {
  const wk = s.wks?.[viewWeek - 1];
  const rated = wk?.rated ?? {};
  const isCurrentWeek = viewWeek === s.w;

  const planNotes: PlanWeekNotes = {};
  const workouts = computeRenderedWorkouts(s, viewWeek, planNotes);

  const dateRange = fmtWeekRange(s.planStartDate, viewWeek);
  const phase = wk?.ph ? phaseLabel(wk.ph) : '';

  // Running km. Planned vs actual
  const _isRunType = (t: string) => t !== 'cross' && t !== 'gym' && t !== 'strength' && t !== 'rest';
  const _parseKmFromDesc = (desc: string): number => {
    const lines = (desc || '').split('\n').filter(l => l.trim());
    let total = 0;
    for (const line of lines) {
      const kmMatch = line.match(/^(\d+\.?\d*)km/);
      if (kmMatch) { total += parseFloat(kmMatch[1]); continue; }
      const intervalMMatch = line.match(/^(\d+)×\d+\.?\d*min.*?~(\d+\.?\d*)m\b/i);
      if (intervalMMatch) { total += parseInt(intervalMMatch[1]) * parseFloat(intervalMMatch[2]) / 1000; continue; }
      const intervalKmMatch = line.match(/^(\d+)×(\d+\.?\d*)km/i);
      if (intervalKmMatch) { total += parseInt(intervalKmMatch[1]) * parseFloat(intervalKmMatch[2]); continue; }
    }
    return total;
  };
  const _runWorkouts = workouts.filter((w: any) => _isRunType(w.t || ''));
  const _plannedKm = _runWorkouts.reduce((sum: number, w: any) => sum + _parseKmFromDesc((w as any).d || ''), 0);
  const _runWorkoutIds = new Set(_runWorkouts.map((w: any) => w.id || w.n));
  const _RUN_ACTIVITY_TYPES = new Set(['RUNNING', 'TREADMILL_RUNNING', 'TRAIL_RUNNING', 'VIRTUAL_RUN', 'TRACK_RUNNING']);
  const _garminIdAppType = new Map<string, string>();
  for (const p of (wk as any)?.garminPending ?? []) {
    if (p.garminId && p.appType) _garminIdAppType.set(p.garminId, p.appType);
  }
  const _actualKm = Object.entries(wk?.garminActuals ?? {})
    .reduce((sum: number, [id, a]: [string, any]) => {
      const isRunSlot = _runWorkoutIds.has(id);
      const isRunActivityType = _RUN_ACTIVITY_TYPES.has((a as any).activityType ?? '');
      const isRunViaAppType = _garminIdAppType.get((a as any).garminId ?? '') === 'run';
      return sum + ((isRunSlot || isRunActivityType || isRunViaAppType) && (a as any).distanceKm > 0.1 ? (a as any).distanceKm : 0);
    }, 0);
  const _kmBarPct = _plannedKm > 0 && _actualKm > 0 ? Math.round((_actualKm / _plannedKm) * 100) : 0;
  const _kmBarFill = Math.min(_kmBarPct, 100);
  const _kmBarColor = _kmBarPct >= 70 ? 'var(--c-ok)' : 'var(--c-muted)';
  const weekKmBar = _plannedKm > 0 ? `
    <div id="plan-km-bar-row" style="margin-top:6px;padding-bottom:4px;cursor:pointer">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;gap:8px">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;color:var(--c-faint)">Running</span>
        <div style="display:flex;align-items:center;gap:4px">
          <span style="font-size:11px;font-weight:500;color:var(--c-muted)">${_actualKm > 0 ? `${formatKm(_actualKm, s.unitPref ?? 'km')} / ${formatKm(_plannedKm, s.unitPref ?? 'km')}` : `${formatKm(_plannedKm, s.unitPref ?? 'km')} planned`}</span>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;color:var(--c-muted)"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </div>
      </div>
      <div style="height:5px;background:rgba(0,0,0,0.07);border-radius:3px;overflow:hidden">
        <div style="height:100%;border-radius:3px;background:${_kmBarColor};width:${_kmBarFill}%;transition:width 0.3s"></div>
      </div>
    </div>` : '';

  // Week load. Signal B (full physiological, all sports) for all weeks
  // Using Signal B everywhere so the bar always matches what the breakdown sheet shows.
  // computeWeekActualTSS is the one "week actual load" every reader uses (B18).
  const _weekRawTSS = computeWeekActualTSS(wk, s.planStartDate);
  // Canonical per-week target: deload weeks and the race-taper position included.
  const _plannedTSS = computePlannedWeekTarget(s, viewWeek);
  // Include decayed carry from previous weeks in the effective total (current week only)
  const _weekCarry = computeCurrentWeekCarry(s, viewWeek);
  const _weekTotalTSS = _weekRawTSS + _weekCarry;
  // Bar shown for all weeks when planned is known; over-target fills fully (no cap)
  const _loadBarPct = _plannedTSS > 0 && _weekTotalTSS > 0
    ? Math.round((_weekTotalTSS / _plannedTSS) * 100)
    : 0;
  const _loadBarColor = _loadBarPct >= 100 ? 'var(--c-ok)' : _loadBarPct >= 70 ? 'var(--c-ok)' : 'var(--c-accent)';
  // Fill width: at/over target = 100%, under = proportional
  const _loadBarFill = _loadBarPct >= 100 ? 100 : _loadBarPct;
  const weekLoadBar = _plannedTSS > 0 ? `
    <div id="plan-load-bar-row" style="margin-top:8px;padding-bottom:12px;cursor:pointer">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Week Load (TSS)</span>
        <div style="display:flex;align-items:center;gap:4px">
          <span style="font-size:11px;font-weight:500;color:var(--c-muted)">${_weekTotalTSS > 0 ? `${_weekTotalTSS} / ${_plannedTSS}` : `${_plannedTSS} planned`}</span>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;color:var(--c-muted)"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </div>
      </div>
      <div style="height:5px;background:rgba(0,0,0,0.07);border-radius:3px;overflow:hidden">
        <div style="height:100%;border-radius:3px;background:${_loadBarColor};width:${_loadBarFill}%;transition:width 0.3s"></div>
      </div>
    </div>` : '';
  // ── Week Overview signals ───────────────────────────────────────────────────
  const isFutureWeek = viewWeek > s.w;
  // Compute RPE on-the-fly from rated workouts (same as events.ts / week-debrief)
  const _nonRunTypes = PLAN_CARD_NON_RUN_TYPES;
  let _effortScore: number | null = wk?.rpeEffort ?? wk?.effortScore ?? null;
  {
    const allRunsForEffort = [
      ...workouts,
      ...(wk?.adhocWorkouts ?? []).filter((w: any) => w.id?.startsWith('garmin-') && !_nonRunTypes.includes(w.t)),
    ];
    let rpeTotalDev = 0, rpeCount = 0;
    for (const wo of allRunsForEffort) {
      if (_nonRunTypes.includes((wo as any).t)) continue;
      const wId = (wo as any).id || (wo as any).n;
      const rating = rated[wId];
      if (typeof rating !== 'number') continue;
      const expected = (wo as any).rpe || (wo as any).r || 5;
      rpeTotalDev += rating - expected;
      rpeCount++;
    }
    if (rpeCount > 0) _effortScore = rpeTotalDev / rpeCount;
  }
  const _tssPct = _plannedTSS > 0 && _weekTotalTSS > 0
    ? Math.round((_weekTotalTSS / _plannedTSS) * 100) : null;
  const _actuals = Object.values(wk?.garminActuals ?? {}) as any[];
  const _hrDriftVals = _actuals.map((a: any) => a.hrDrift).filter((v: any) => typeof v === 'number' && !isNaN(v));
  const _avgHrDrift = _hrDriftVals.length > 0
    ? _hrDriftVals.reduce((acc: number, v: number) => acc + v, 0) / _hrDriftVals.length : null;
  // Compute average HR effort from garminActuals (stored or on-the-fly)
  const _RUN_TYPES_PV = new Set(['RUNNING', 'TREADMILL_RUNNING', 'TRAIL_RUNNING', 'VIRTUAL_RUN', 'TRACK_RUNNING']);
  // Build workout lookup for plannedType fallback
  const _woByIdPV: Record<string, any> = {};
  for (const wo of workouts) _woByIdPV[(wo as any).id || (wo as any).n] = wo;
  const _hrEffortVals: number[] = [];
  for (const [wId, actual] of Object.entries(wk?.garminActuals ?? {}) as [string, any][]) {
    if (!_RUN_TYPES_PV.has(actual?.activityType ?? '')) continue;
    let hrScore = actual?.hrEffortScore ?? null;
    if (hrScore == null && actual?.avgHR) {
      const woType = actual?.plannedType ?? _woByIdPV[wId]?.t ?? null;
      if (woType) hrScore = getHREffort(actual.avgHR, woType, s);
    }
    if (hrScore != null) _hrEffortVals.push(hrScore);
  }
  const _avgHrEffort = _hrEffortVals.length > 0
    ? _hrEffortVals.reduce((acc, v) => acc + v, 0) / _hrEffortVals.length : null;
  let _wgAccum = 0;
  for (let i = 0; i < viewWeek - 1; i++) _wgAccum += (s.wks[i]?.wkGain ?? 0);
  const _effectiveVdot = (s.v ?? 0) + _wgAccum + (s.rpeAdj ?? 0) + (s.physioAdj ?? 0);
  const _signals = computeWeekSignals(_effortScore, _avgHrEffort, _tssPct, null, _avgHrDrift);
  const _acwrStatus = (viewWeek === s.w + 1) ? (wk?.scheduledAcwrStatus ?? null) : null;
  const _weeksToRace = s.tw - viewWeek + 1;
  const _pills = isFutureWeek
    ? getFutureWeekPills(_effectiveVdot, wk?.ph ?? 'base', _acwrStatus, _weeksToRace, !s.continuousMode)
    : getSignalPills(_signals);
  // Coach copy and future week copy removed with Week Overview section

  // Enable prev at week 1 when there's an archived prior plan to step into.
  // Crosses plan boundaries: prev keeps walking backwards through archives,
  // next exits the archive at its last week back to the live plan.
  const _liveArchives = (((getState() as any).previousPlanWks ?? []) as any[]);
  const _inArchive = _viewArchiveIdx !== null;
  const _hasOlderArchive = _inArchive && _viewArchiveIdx! > 0;
  const canGoBack = _inArchive
    ? (viewWeek > 1 || _hasOlderArchive)
    : (viewWeek > 1 || _liveArchives.length > 0);
  const canGoForward = _inArchive
    ? true   // always can go forward. Last archive week exits to live plan
    : viewWeek < s.tw;
  const injured = isInjuryActive();
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  const navBtn = (dir: 'prev' | 'next', enabled: boolean) => `
    <button id="plan-week-${dir}" class="plan-nav-btn"
      style="width:36px;height:36px;border-radius:50%;border:none;cursor:${enabled ? 'pointer' : 'default'};
        background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 1px 4px rgba(0,0,0,0.08);
        opacity:${enabled ? '1' : '0.3'}">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        ${dir === 'prev' ? '<polyline points="15 18 9 12 15 6"/>' : '<polyline points="9 18 15 12 9 6"/>'}
      </svg>
    </button>
  `;

  // ── Wrap up week (conditional) ──
  const _wrapBtn = buildWrapUpWeekBtn(s, workouts, viewWeek);

  // ── Light background tints per phase (like physiology sky) ──
  // Archive view (past plan) gets a neutral cool-grey instead of the live phase
  // colour so the user has an unmissable visual cue that this isn't today's plan.
  const _phaseBg: Record<string, { top: string; mid: string }> = {
    base:  { top: '#C5DFF8', mid: '#E3F0FA' },   // cool blue sky
    build: { top: '#F0D9C4', mid: '#F5E8DC' },   // warm amber
    peak:  { top: '#F0C4C4', mid: '#F5DCDC' },   // warm rose
    taper: { top: '#C5DFF8', mid: '#E3F0FA' },   // cool blue (same as physiology)
  };
  const _archiveBg = { top: '#D6DBE2', mid: '#E8EBEF' };
  const _pb = _viewArchiveIdx !== null
    ? _archiveBg
    : (_phaseBg[wk?.ph ?? 'base'] ?? _phaseBg.base);

  // Design tokens. Same as physiology page
  const _TM = '#0F172A';
  const _TS = '#64748B';
  const _TL = '#94A3B8';
  const _BG = '#FAF9F6';

  // Entrance plays on the first Plan visit per session only. Revisits (and week
  // paging) render settled — instant, and nothing moves behind the glass cards.
  const animate = shouldPlayEntrance('plan');

  return `
    <style>
      #plan-view { box-sizing:border-box; }
      #plan-view *, #plan-view *::before, #plan-view *::after { box-sizing:inherit; }
      @keyframes planFloat { from { opacity:0; } to { opacity:1; } }
      .plan-fade { ${animate ? 'opacity:0; animation:planFloat 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;' : 'opacity:1;'} }
      @keyframes barGrow { from { width:0% } }
      .m-prog-fill { ${animate ? 'animation:barGrow 0.8s cubic-bezier(0.2,0.8,0.2,1) forwards;' : ''} }
    </style>

    <div id="plan-view" style="position:relative;min-height:100vh;background:${atmosphereGradient('sky')};font-family:var(--f);overflow-x:hidden">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('rp', { variant: 'sweep', palette: 'sky', pulse: animate, entrance: animate ? 'small' : 'none' })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <!-- Header: archive nav (only when relevant) + race countdown + profile -->
        <div class="plan-fade" style="animation-delay:0.02s;padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div style="display:flex;align-items:center;gap:8px;min-height:36px">
            ${(_viewArchiveIdx !== null || _liveArchives.length > 0) ? `${navBtn('prev', canGoBack)}${_viewArchiveIdx !== null ? navBtn('next', canGoForward) : ''}` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            ${(() => {
              // Mode-aware race date: HYROX stores it on hyroxConfig, not
              // onboarding — same fallback chain home-view uses (persona-QA P04).
              const _raceDays = daysUntilRace((s as any).hyroxConfig?.raceDate ?? s.onboarding?.customRaceDate ?? null);
              if (_raceDays <= 0) return '';
              const _disp = _raceDays > 14 ? `${Math.floor(_raceDays / 7)}` : `${_raceDays}`;
              const _unit = _raceDays > 14 ? 'weeks' : 'days';
              return `<div style="display:flex;align-items:baseline;gap:3px;padding:4px 12px;border-radius:100px;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);box-shadow:0 1px 4px rgba(0,0,0,0.06)"><span style="font-size:22px;font-weight:700;letter-spacing:-0.03em;color:${_TM};line-height:1">${_disp}</span><span style="font-size:11px;font-weight:500;color:${_TS}">${_unit}</span></div>`;
            })()}
            <button id="plan-account-btn" style="
              width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
              background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);
              display:flex;align-items:center;justify-content:center;
              font-size:12px;font-weight:600;color:${_TM};font-family:var(--f);
              box-shadow:0 1px 4px rgba(0,0,0,0.08);
            ">${initials || 'Me'}</button>
          </div>
        </div>

        <!-- Hero: race name + phase + week + actions -->
        <div class="plan-fade" style="animation-delay:0.06s;text-align:center;padding:20px 20px 0">
          ${_viewArchiveIdx !== null ? `<div style="font-size:11px;font-weight:600;color:${_TS};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px">Past plan</div>` : ''}
          <div style="font-size:42px;font-weight:700;color:${_TM};letter-spacing:-0.03em;line-height:1.05">${escapeHtmlPlan(getRunnerHeroName(s))}</div>
          ${wk?.ph ? `<div style="font-size:17px;font-weight:700;color:${_TM};margin-top:10px;letter-spacing:-0.01em">${phaseLabel(wk.ph)}</div>` : ''}
          ${s.tw ? `<div style="font-size:14px;font-weight:500;color:${_TS};margin-top:4px">Week ${viewWeek} of ${s.tw}${dateRange ? ` · ${dateRange}` : ''}</div>` : ''}
          ${viewWeek < s.w ? `<div style="margin-top:8px"><button id="plan-jump-current" style="background:none;border:none;padding:0;font-size:13px;font-weight:600;color:${_TS};cursor:pointer;font-family:var(--f)">${_viewArchiveIdx !== null ? 'Back to current plan' : 'Go to current week'} \u2192</button></div>` : ''}

          <!-- Action buttons — part of the hero block -->
          <div style="display:flex;justify-content:center;gap:8px;margin-top:18px;flex-wrap:wrap">
            ${isCurrentWeek && AI_COACH_ENABLED ? `<button id="plan-coach-btn" class="m-btn-glass">Coach</button>` : ''}
            ${buildInjuryHeaderBtn(injured, isCurrentWeek)}
            ${_wrapBtn}
            ${isCurrentWeek && s.w > 1 ? `<button id="plan-review-week-btn" class="m-btn-glass">Review past week</button>` : ''}
            ${viewWeek === s.w ? `<button id="plan-generate-session" class="m-btn-glass">+ Add session</button><button id="plan-log-activity" class="m-btn-glass">+ Log activity</button>` : ''}
          </div>
        </div>

        <!-- Weekly summary strip — 3-column card (Sessions / Distance / Load) mirroring triathlon Plan -->
        <div class="plan-fade" style="animation-delay:0.10s">${buildPlanWeekSummaryCard({
          plannedSessions: workouts.filter((w: any) => w.t !== 'rest').length,
          actualSessions: countDoneSessionsForWeek(wk),
          plannedKm: _plannedKm,
          actualKm: _actualKm,
          plannedTSS: _plannedTSS,
          actualTSS: _weekTotalTSS,
          showActuals: !isFutureWeek,
          unitPref: s.unitPref ?? 'km',
        })}</div>

        <!-- Week navigation pills (1, 2, 3 … N) -->
        <div class="plan-fade" style="animation-delay:0.14s;padding:8px 20px 8px">
          <div style="display:flex;gap:5px;overflow-x:auto;padding:2px 0;-webkit-overflow-scrolling:touch">
            ${Array.from({ length: s.tw }, (_, i) => {
              const wkNum = i + 1;
              const active = wkNum === viewWeek;
              return `<button data-plan-week-nav="${wkNum}" style="flex-shrink:0;min-width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:${active ? 600 : 500};font-variant-numeric:tabular-nums;border-radius:8px;border:none;background:${active ? '#0F172A' : 'rgba(255,255,255,0.75)'};color:${active ? '#fff' : 'var(--c-muted)'};box-shadow:${active ? '0 2px 6px rgba(0,0,0,0.15)' : '0 1px 2px rgba(0,0,0,0.04)'};cursor:pointer">${wkNum}</button>`;
            }).join('')}
          </div>
        </div>

        <!-- Workout card list -->
        <div id="plan-card-list" style="padding:12px 0 16px;${isFutureWeek ? 'opacity:0.75' : ''}">
          ${isFutureWeek ? `<div class="plan-fade" style="animation-delay:0.16s;margin:4px 16px 8px;padding:12px 15px;${PLAN_CARD_STYLE};font-size:13px;font-weight:500;color:${_TS};line-height:1.5">Estimated from last week's load. Sessions and distances adjust as you train.</div>` : ''}
          ${buildCarryOverCard(wk)}
          ${buildConsecutiveSkipNote(s, viewWeek)}
          ${buildKmNudgeCard(wk, s, workouts)}
          ${buildVibesRunNudgeCard(s, wk, viewWeek)}
          ${buildAdjustWeekRow(wk, s)}
          ${buildGoalFeasibilityBanner(s)}
          ${buildBudgetBanner(s, workouts, viewWeek)}
          ${buildBudgetRunFitNote(s, planNotes.budgetRunFit, viewWeek)}
          ${buildInjuryBanner()}
          ${buildIllnessBanner()}
          ${buildHolidayBannerPlan(s)}
          ${buildMorningPainCheck()}
          ${buildBenchmarkPanel(s)}
          ${viewWeek === s.w ? `
            <div class="plan-fade" style="animation-delay:0.16s;margin:6px 28px 0 20px;text-align:right">
              <span style="font-size:10px;color:var(--c-faint);font-weight:500">Hold and drag to reorder</span>
            </div>
          ` : ''}
          <div id="plan-week-list" class="plan-fade" style="animation-delay:0.18s;margin:6px 20px 0">
            ${buildWorkoutCards(s, workouts, viewWeek)}
          </div>
          ${buildActivityLog(wk, viewWeek, s.w)}
        </div>
      </div>

    </div>
    ${renderTabBar('plan', isSimulatorMode())}
  `;
}

function wirePlanHandlers(s: SimulatorState, viewWeek: number): void {
  wireTabBarHandlers(navigateTab);

  // Account button
  document.getElementById('plan-account-btn')?.addEventListener('click', () => {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // Load bar → Load & Taper page (compact bars on past/future weeks)
  document.getElementById('plan-load-bar-row')?.addEventListener('click', () => {
    import('./load-taper-view').then(({ renderLoadTaperView }) => renderLoadTaperView(viewWeek, 'plan', _viewArchiveIdx));
  });

  // Km bar → run breakdown sheet (compact bars on past/future weeks)
  document.getElementById('plan-km-bar-row')?.addEventListener('click', () => {
    showRunBreakdownSheet(s, viewWeek);
  });

  // This Week card (from buildProgressBars on current week). Whole card → Load & Taper
  document.getElementById('this-week-card')?.addEventListener('click', () => {
    import('./load-taper-view').then(({ renderLoadTaperView }) => renderLoadTaperView(viewWeek, 'plan', _viewArchiveIdx));
  });

  // 3-column weekly summary card (new shell). Whole card → Load & Taper.
  document.getElementById('plan-week-summary-card')?.addEventListener('click', () => {
    import('./load-taper-view').then(({ renderLoadTaperView }) => renderLoadTaperView(viewWeek, 'plan', _viewArchiveIdx));
  });

  // Week navigation pills (1, 2 … N). Clicking a pill previews that week
  // without changing s.w. Same semantics as the prev/next nav arrows but
  // direct-jump. Tapping the live week resets the preview override.
  document.querySelectorAll<HTMLElement>('[data-plan-week-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wkNum = parseInt(btn.getAttribute('data-plan-week-nav') || '0', 10);
      if (!wkNum) return;
      const liveS = getState();
      _viewWeek = (wkNum === liveS.w && _viewArchiveIdx === null) ? null : wkNum;
      renderPlanView();
    });
  });

  // (Week overview toggle removed. Pills now inline)

  // Goal-feasibility: add a quality session. Mirror the onboarding
  // milestone-accept lever (plan-preview.ts). Bump both rw (drives plan
  // regeneration) and epw (drives forecast). Then re-blend so the banner
  // disappears and expectedFinal/forecastTime reflect the added stimulus.
  document.getElementById('goal-add-session')?.addEventListener('click', () => {
    const ms = getMutableState();
    ms.rw = Math.min((ms.rw ?? 0) + 1, 7);
    ms.epw = Math.min((ms.epw ?? 0) + 1, 10);
    saveState();
    import('@/calculations/blended-fitness').then(({ refreshBlendedFitness }) => {
      refreshBlendedFitness(ms);
      saveState();
      renderPlanView();
    });
  });

  // Budget banner. Accept shorter sessions (record dismissal at current hours).
  document.getElementById('budget-accept-btn')?.addEventListener('click', () => {
    const ms = getMutableState();
    if (ms.onboarding && ms.onboarding.weeklyTrainingHours != null) {
      ms.onboarding.budgetAcceptedAtHours = ms.onboarding.weeklyTrainingHours;
      saveState();
      // In-place: accepting only dismisses this banner (nothing else on the page
      // reads budgetAcceptedAtHours), so drop the node instead of re-rendering.
      document.getElementById('budget-banner-card')?.remove();
    }
  });

  // Budget banner. Bump the user's weekly hours to fit the plan, re-blend,
  // then re-render. Plan workouts re-derive on render via generateWeekWorkouts.
  document.getElementById('budget-increase-btn')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLElement;
    const recommended = parseFloat(btn.dataset.recommended || '');
    if (!Number.isFinite(recommended) || recommended <= 0) return;
    const ms = getMutableState();
    if (!ms.onboarding) return;
    ms.onboarding.weeklyTrainingHours = recommended;
    // Clear dismissal. The user's situation has changed.
    ms.onboarding.budgetAcceptedAtHours = undefined;
    saveState();
    import('@/calculations/blended-fitness').then(({ refreshBlendedFitness }) => {
      refreshBlendedFitness(ms);
      saveState();
      renderPlanView();
    });
  });

  // Coach button → Coach sub-page
  document.getElementById('plan-coach-btn')?.addEventListener('click', () => {
    import('./coach-view').then(({ renderCoachView }) => renderCoachView(() => renderPlanView()));
  });

  // Check-in button
  document.getElementById('plan-checkin-btn')?.addEventListener('click', () => openCheckinOverlay());

  // Illness banner
  document.getElementById('illness-mark-recovered')?.addEventListener('click', () => clearIllness());
  document.getElementById('illness-update-btn')?.addEventListener('click', () => openIllnessModal());

  // Holiday banner
  document.getElementById('holiday-end-btn')?.addEventListener('click', () => clearHoliday());
  document.getElementById('holiday-generate-btn')?.addEventListener('click', () => openSessionGenerator());
  document.getElementById('holiday-cancel-btn')?.addEventListener('click', () => cancelScheduledHoliday());
  document.getElementById('holiday-change-btn')?.addEventListener('click', () => {
    cancelScheduledHoliday(() => {}); // no-op: modal opens immediately after
    openHolidayModal();
  });

  // Delete user-generated session (holiday or adhoc)
  document.querySelectorAll('.plan-adhoc-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      const wkId = el.dataset.workoutId || '';
      const weekNum = parseInt(el.dataset.weekNum || '0', 10);
      const ms = getMutableState();
      const wk2 = ms.wks?.[weekNum - 1];
      if (wk2?.adhocWorkouts) {
        wk2.adhocWorkouts = wk2.adhocWorkouts.filter((w: any) => (w.id || w.n) !== wkId);
        saveState();
        renderPlanView();
      }
    });
  });

  // Generate session button (current week only)
  document.getElementById('plan-generate-session')?.addEventListener('click', () => openSessionGenerator());
  document.getElementById('plan-log-activity')?.addEventListener('click', () => openLogActivityOverlay());

  // Week navigation. Crosses plan boundaries:
  //   prev at live wk1 → enter most recent archive at its last week
  //   prev at archive wk1 → step to the next-older archive (if any)
  //   next at archive last week → step to next archive forward, or exit to live wk1
  document.getElementById('plan-week-prev')?.addEventListener('click', () => {
    const liveArchives = ((getState() as any).previousPlanWks ?? []) as any[];
    if (_viewArchiveIdx === null) {
      if (viewWeek > 1) { _viewWeek = viewWeek - 1; renderPlanView(); return; }
      if (liveArchives.length > 0) {
        _viewArchiveIdx = liveArchives.length - 1;
        _viewWeek = liveArchives[_viewArchiveIdx].weeks.length;
        renderPlanView();
      }
      return;
    }
    if (viewWeek > 1) { _viewWeek = viewWeek - 1; renderPlanView(); return; }
    if (_viewArchiveIdx > 0) {
      _viewArchiveIdx -= 1;
      _viewWeek = liveArchives[_viewArchiveIdx].weeks.length;
      renderPlanView();
    }
  });
  document.getElementById('plan-week-next')?.addEventListener('click', () => {
    const liveArchives = ((getState() as any).previousPlanWks ?? []) as any[];
    if (_viewArchiveIdx !== null) {
      if (viewWeek < s.tw) { _viewWeek = viewWeek + 1; renderPlanView(); return; }
      if (_viewArchiveIdx < liveArchives.length - 1) {
        _viewArchiveIdx += 1;
        _viewWeek = 1;
        renderPlanView();
        return;
      }
      // Exit archive view → land on the live plan's week 1.
      _viewArchiveIdx = null;
      _viewWeek = 1;
      renderPlanView();
      return;
    }
    if (viewWeek < s.tw) { _viewWeek = viewWeek + 1; renderPlanView(); }
  });

  // Jump to current week (shown only when viewing a past week). Also clears
  // archive mode so the user comes back to the live plan, not an archived one.
  document.getElementById('plan-jump-current')?.addEventListener('click', () => {
    _viewWeek = null;
    _viewArchiveIdx = null;
    renderPlanView();
  });

  // Edit week button (shown only on current week)
  // Review past week button. Fires week-end debrief for the PREVIOUS week
  document.getElementById('plan-review-week-btn')?.addEventListener('click', () => {
    const curWeek = (getState() as any).w ?? 1;
    if (curWeek > 1) {
      import('@/ui/week-debrief').then(({ showWeekDebrief }) => {
        showWeekDebrief(curWeek - 1);
      });
    }
  });

  // Injury buttons
  document.getElementById('plan-injury-update')?.addEventListener('click', () => openInjuryModal());
  document.getElementById('plan-injury-recovered')?.addEventListener('click', () => {
    const ok = window.confirm('Mark yourself as fully recovered? Your normal training plan will resume.');
    if (ok) markAsRecovered();
  });

  // Morning pain check
  document.querySelectorAll('.plan-morning-pain-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const response = (btn as HTMLElement).dataset.response as 'worse' | 'same' | 'better';
      if (response) handleMorningPainResponse(response);
    });
  });

  // Benchmark panel. Open overlay or trigger auto-show
  document.getElementById('btn-benchmark-open')?.addEventListener('click', () => openBenchmarkOverlay());
  maybeTriggerBenchmarkOverlay();

  // Capacity test buttons (injury return-to-run phase)
  document.querySelectorAll('.plan-capacity-test-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const testType = el.dataset.testType;
      const passed = el.dataset.passed === 'true';
      if (testType && (window as any).rateCapacityTest) {
        (window as any).rateCapacityTest(testType, passed);
        renderPlanView();
      }
    });
  });

  // Keyboard arrow keys for week navigation on web. Mirrors the prev/next
  // click handlers so arrows also cross plan boundaries into archives.
  const keyHandler = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    document.removeEventListener('keydown', keyHandler);
    const trigger = e.key === 'ArrowLeft' ? 'plan-week-prev' : 'plan-week-next';
    document.getElementById(trigger)?.click();
  };
  document.addEventListener('keydown', keyHandler);

  // Start button (header + expanded detail). Look up workout from module-level lookup
  const startHandler = (e: Event) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const wkId = btn.dataset.workoutId || '';
    const workout = _workoutLookup.get(wkId);
    const name = workout?.n || wkId;
    const desc = workout?.d || '';
    if (window.trackWorkout) window.trackWorkout(name, desc);
  };
  document.querySelectorAll('.plan-start-btn').forEach(el => el.addEventListener('click', startHandler));
  document.querySelectorAll('.plan-detail-start-btn').forEach(el => el.addEventListener('click', startHandler));

  // View arrow → expand workout card inline (tap the card header to toggle)
  document.querySelectorAll('.plan-view-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (el as HTMLElement).dataset.workoutId || '';
      const detail = document.getElementById(safeDetailId(id));
      if (detail) {
        const isExpanded = detail.style.display !== 'none';
        detail.style.display = isExpanded ? 'none' : 'block';
        const card = detail.closest('.plan-workout-card');
        const chevron = card?.querySelector('.plan-card-chevron') as SVGElement | null;
        if (chevron) chevron.style.transform = isExpanded ? '' : 'rotate(180deg)';
      }
    });
  });

  // ─── Workout card expand/collapse ──────────────────────────────────────────
  document.querySelectorAll('.plan-card-header').forEach(header => {
    header.addEventListener('click', (e) => {
      const target = e.target as Element;
      // Don't expand if tapping the start button, view arrow, or activity detail link
      if (target.closest('.plan-start-btn') || target.closest('.plan-view-btn') || target.closest('.plan-act-open') || target.closest('.plan-recovery-undo-btn')) return;

      const card = header.closest('.plan-workout-card') as HTMLElement;
      const id = card?.getAttribute('data-workout-id');
      if (!id) return;

      // Strength/gym cards open the clean detail modal instead of expanding.
      // Exception: a SKIPPED gym session has no skip/unskip control in that
      // modal, so fall through to the inline expanded card where the Unskip
      // button lives. Otherwise the user can never un-skip a gym workout.
      if (card?.hasAttribute('data-gym-detail')) {
        const gymRating = getState().wks?.[viewWeek - 1]?.rated?.[id];
        if (gymRating !== 'skip') {
          openGymCardDetail(id, viewWeek);
          return;
        }
      }

      const detail = document.getElementById(safeDetailId(id));
      if (!detail) return;

      const isExpanded = detail.style.display !== 'none';
      detail.style.display = isExpanded ? 'none' : 'block';

      const chevron = header.querySelector('.plan-card-chevron') as SVGElement;
      if (chevron) chevron.style.transform = isExpanded ? '' : 'rotate(180deg)';

      // Render route map canvases when expanding
      if (!isExpanded) {
        detail.querySelectorAll<HTMLCanvasElement>('canvas.plan-detail-map').forEach(canvas => {
          const encoded = canvas.dataset.polyline;
          if (!encoded) return;
          const kmSplitsRaw = canvas.dataset.kmSplits;
          const kmSplits = kmSplitsRaw ? JSON.parse(kmSplitsRaw) as number[] : undefined;
          import('./strava-detail').then(({ drawPolylineOnCanvas }) => {
            requestAnimationFrame(() => void drawPolylineOnCanvas(canvas, encoded, kmSplits));
          });
        });
      }
    });
  });

  // ─── Move to day buttons ────────────────────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.plan-move-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wId = btn.dataset.workoutId || '';
      const targetDay = parseInt(btn.dataset.targetDay || '-1', 10);
      const currentDay = parseInt(btn.dataset.currentDay || '-1', 10);
      if (!wId || targetDay < 0 || targetDay === currentDay) return;
      const ms = getMutableState();
      const wk2 = ms.wks?.[viewWeek - 1];
      if (!wk2) return;
      const moves = wk2.workoutMoves ?? ((wk2 as any).workoutMoves = {} as Record<string, number>);
      moves[wId] = targetDay;
      mergeTimingMods(ms, wk2);
      saveState();
      renderPlanView();
    });
  });

  // ─── Action buttons in expanded detail ─────────────────────────────────────
  document.querySelectorAll('.plan-action-mark-done').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      markPlanCardDone(btn as HTMLElement);
      renderPlanView();
    });
  });

  document.querySelectorAll('.plan-action-skip').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLElement;
      const wId = el.dataset.workoutId || '';
      const name = el.dataset.name || '';
      const type = el.dataset.type || 'easy';
      const rpe = parseInt(el.dataset.rpe || '5', 10);
      const desc = el.dataset.desc || '';
      const day = parseInt(el.dataset.day || '0', 10);
      const weekNum = el.dataset.weekNum ? parseInt(el.dataset.weekNum, 10) : undefined;
      skip(wId, name, type, false, 0, desc, rpe, day, '', weekNum, el.dataset.longRun === '1');
      renderPlanView();
    });
  });

  document.querySelectorAll('.plan-action-adjust').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAdjustFromButton(btn as HTMLElement);
    });
  });

  document.querySelectorAll('.plan-action-unrate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLElement;
      const ms = getMutableState();
      // Operate on the week the card belongs to, not just the current week — a
      // skipped/done session on a past week must un-rate that week's record.
      const weekNum = parseInt(el.dataset.weekNum || '', 10) || ms.w;
      if (!unratePlanSlot(weekNum, el.dataset.workoutId || '')) return;
      saveState();
      renderPlanView();
    });
  });

  document.querySelectorAll('.plan-remove-garmin').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const gId = (btn as HTMLElement).dataset.garminId || '';
      if (gId) removeGarminActivity(gId);
      renderPlanView();
    });
  });

  // ─── Carry-over card ──────────────────────────────────────────────────────
  document.getElementById('plan-carry-over-card')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'plan-carry-over-dismiss') return;
    triggerExcessLoadAdjustment();
  });
  document.getElementById('plan-carry-over-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s2 = getMutableState();
    const wk2 = s2.wks?.[s2.w - 1];
    if (!wk2) return;
    wk2.carryOverCardDismissed = true;
    saveState();
    renderPlanView();
  });

  // ─── Km nudge card ────────────────────────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.km-nudge-apply-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s2 = getMutableState();
      const wk2 = s2.wks?.[s2.w - 1];
      if (!wk2?.kmNudge || !('floorKm' in wk2.kmNudge)) return;

      // Re-compute candidates to get data for the clicked button
      const nudgeWorkouts = generateWeekWorkouts(
        wk2.ph, s2.rw, s2.rd, s2.typ, [], s2.commuteConfig || undefined,
        null, s2.recurringActivities,
        s2.onboarding?.experienceLevel, undefined, s2.pac?.e, s2.w, s2.tw, s2.v, s2.gs,
        getTrailingEffortScore(s2.wks, s2.w), wk2.scheduledAcwrStatus, undefined,
        s2.onboarding?.weeklyTrainingHours, s2.onboarding?.runningExcludedWorkouts,
      );
      // Apply existing mods so distances reflect current state
      for (const mod of (wk2.workoutMods ?? [])) {
        const w = findWorkoutForMod(nudgeWorkouts as any[], mod);
        if (w && !mod.modReason?.startsWith('Timing:')) {
          if (mod.originalDistance != null) (w as any).originalDistance = mod.originalDistance;
          (w as any).d = modDisplayDescription(mod, s2.pac?.e);
          (w as any).status = mod.status;
        }
      }
      const candidates = computeKmNudgeCandidates(nudgeWorkouts, wk2, wk2.kmNudge.floorKm);
      const targetName = btn.dataset.name ?? '';
      const targetDay = parseInt(btn.dataset.day ?? '-1', 10);
      const candidate = candidates.find(c => c.workoutName === targetName && c.dayOfWeek === targetDay);
      if (!candidate) return;

      const newKm = Math.round((candidate.currentDistanceKm + candidate.extensionKm) * 10) / 10;
      if (!wk2.workoutMods) wk2.workoutMods = [];
      // Remove any existing KmNudge mod for this workout
      wk2.workoutMods = wk2.workoutMods.filter(m => !(m.name === candidate.workoutName && m.modReason?.startsWith('KmNudge:')));

      if (candidate.wasReduced) {
        // Run was reduced by cross-training. Update the existing reduce mod's distance
        const existingMod = wk2.workoutMods.find(m =>
          m.name === candidate.workoutName && m.status === 'reduced'
        );
        if (existingMod) {
          existingMod.newDistance = `${newKm}km easy`;
          existingMod.modReason += ' + KmNudge: volume restored';
        } else {
          wk2.workoutMods.push({
            name: candidate.workoutName,
            dayOfWeek: candidate.dayOfWeek,
            status: 'extended',
            modReason: `KmNudge: Running volume below floor — easy run extended`,
            originalDistance: `${candidate.currentDistanceKm}km`,
            newDistance: `${newKm}km easy`,
          });
        }
      } else {
        wk2.workoutMods.push({
          name: candidate.workoutName,
          dayOfWeek: candidate.dayOfWeek,
          status: 'extended',
          modReason: `KmNudge: Running volume below floor — easy run extended`,
          originalDistance: `${candidate.currentDistanceKm}km`,
          newDistance: `${newKm}km easy`,
        });
      }

      saveState();
      renderPlanView();
    });
  });
  document.getElementById('plan-km-nudge-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s2 = getMutableState();
    const wk2 = s2.wks?.[s2.w - 1];
    if (!wk2) return;
    wk2.kmNudgeDismissed = true;
    saveState();
    // In-place: the nudge is a purely additive card, so just drop the node
    // rather than re-rendering the whole Plan page (which flashes + scroll-jumps).
    document.getElementById('plan-km-nudge-card')?.remove();
  });

  // ─── Vibes Run nudge handlers ──────────────────────────────────────────────
  document.getElementById('vibes-nudge-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s2 = getMutableState();
    s2.vibesRunNudgeDismissed = true;
    saveState();
    // In-place: drop the additive nudge card, no full Plan re-render.
    document.getElementById('plan-vibes-nudge-card')?.remove();
  });
  document.getElementById('vibes-nudge-science')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openVibesScienceModal();
  });
  document.getElementById('vibes-nudge-try')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s2 = getMutableState();
    const wk2 = s2.wks?.[s2.w - 1];
    if (!wk2) return;
    if (!wk2.adhocWorkouts) wk2.adhocWorkouts = [];
    const jsDay = new Date().getDay();
    const ourDay = jsDay === 0 ? 6 : jsDay - 1;
    wk2.adhocWorkouts.push({
      id: `adhoc-${Date.now()}`,
      t: 'vibes',
      n: 'Run by Feel',
      d: '5km easy, then keep going if it\'s still fun',
      r: 4,
      rpe: 4,
      dayOfWeek: ourDay,
    });
    s2.vibesRunNudgeDismissed = true;
    saveState();
    renderPlanView();
  });

  // ─── Adjust week button ────────────────────────────────────────────────────
  document.getElementById('plan-adjust-week-btn')?.addEventListener('click', () => {
    triggerExcessLoadAdjustment();
  });

  // ─── Tier 1 auto-reduce. Undo button ─────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.plan-auto-undo-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s2 = getMutableState();
      const wk2 = s2.wks?.[s2.w - 1];
      if (!wk2) return;
      // Remove all Auto: mods. Restores the easy run; unspentLoadItems already in state → card reappears
      removeWorkoutMods(wk2, m => !!m.modReason?.startsWith('Auto:'));
      saveState();
      // Must use render() (full re-render) not renderPlanView(). The excess load card
      // lives in the Training tab (main-view.ts) and won't reappear on Plan-only re-render
      import('@/ui/renderer').then(({ render }) => render());
    });
  });

  // ─── Timing suggestion. Accept downgrade ──────────────────────────────────
  document.querySelectorAll<HTMLElement>('.plan-timing-accept').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onTimingAccept(btn)) renderPlanView();
    });
  });

  // (Activity-log Review buttons removed 2026-06-04 — the log is past-weeks-only
  // now, mirroring triathlon; the review entry point lives on Home → Recent.)

  // Wrap up week (Sunday / all-done pill in header)
  document.getElementById('plan-wrap-up-btn')?.addEventListener('click', () => {
    console.log('[plan-view] plan-wrap-up-btn clicked, s.w=', s.w);
    showWeekDebrief(s.w, 'complete');
  });

  // ─── Activity detail click-through ─────────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.plan-act-open').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const workoutKey = el.dataset.workoutKey || '';
      const weekNum = parseInt(el.dataset.weekNum || '0', 10);
      if (!workoutKey || !weekNum) return;
      // In archive mode `s` (closure) holds the synthetic archive state;
      // `getState().wks` is the live plan's array which doesn't contain
      // the archived week the user just clicked. Without this branch the
      // popup silently no-ops on every past-plan activity tap.
      const wksToUse = _viewArchiveIdx !== null ? (s as any).wks : getState().wks;
      const actual = wksToUse?.[weekNum - 1]?.garminActuals?.[workoutKey];
      if (!actual) return;
      const plannedTSSAttr = parseInt(el.dataset.plannedTss || '0', 10) || 0;
      const { renderActivityDetail } = await import('./activity-detail');
      renderActivityDetail(actual, actual.workoutName || actual.displayName || workoutKey, 'plan', plannedTSSAttr || undefined, workoutKey);
    });
  });

  // ─── Adhoc activity detail click-through (Excess / Logged) ─────────────────
  document.querySelectorAll<HTMLElement>('.plan-adhoc-open').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const adhocId = el.dataset.adhocId || '';
      const weekNum = parseInt(el.dataset.weekNum || '0', 10);
      if (!adhocId || !weekNum) return;
      const wksToUse = _viewArchiveIdx !== null ? (s as any).wks : getState().wks;
      const wk2 = wksToUse?.[weekNum - 1];
      const w = (wk2?.adhocWorkouts || []).find((aw: any) => aw.id === adhocId) as any;
      if (!w) return;
      const fakeActual = {
        garminId: w.id || '',
        startTime: w.garminTimestamp ?? null,
        distanceKm: w.garminDistKm ?? w.distanceKm ?? 0,
        durationSec: (w.garminDurationMin ?? w.durationMin ?? 0) * 60,
        avgPaceSecKm: w.garminAvgPace ?? null,
        avgHR: w.garminAvgHR ?? null,
        maxHR: w.garminMaxHR ?? null,
        calories: w.garminCalories ?? null,
        iTrimp: w.iTrimp ?? null,
        hrZones: w.hrZones ?? null,
        polyline: w.polyline ?? null,
        kmSplits: w.kmSplits ?? null,
        activityType: w.activityType ?? null,
        displayName: w.workoutName || w.displayName || w.name || w.n || 'Activity',
      };
      const { renderActivityDetail } = await import('./activity-detail');
      renderActivityDetail(fakeActual as any, fakeActual.displayName, 'plan');
    });
  });

  // ─── Drag-and-drop reorder within week ──────────────────────────────────────
  let _dragId = '';
  let _dragDay = -1;
  document.querySelectorAll<HTMLElement>('.plan-workout-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      _dragId = card.dataset.workoutId || '';
      _dragDay = parseInt(card.dataset.dayOfWeek || '-1', 10);
      (e as DragEvent).dataTransfer?.setData('text/plain', _dragId);
      card.style.opacity = '0.4';
    });
    card.addEventListener('dragend', () => {
      card.style.opacity = '';
      card.style.outline = '';
    });
    card.addEventListener('dragover', (e) => {
      if (!_dragId || card.dataset.workoutId === _dragId) return;
      e.preventDefault();
      card.style.outline = '2px solid var(--c-accent)';
      card.style.outlineOffset = '-2px';
    });
    card.addEventListener('dragleave', () => {
      card.style.outline = '';
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.style.outline = '';
      const srcId = _dragId || (e as DragEvent).dataTransfer?.getData('text/plain') || '';
      if (!srcId || card.dataset.workoutId === srcId) return;
      const targetId = card.dataset.workoutId || '';
      const srcDay = _dragDay;
      const targetDay = parseInt(card.dataset.dayOfWeek || '-1', 10);
      if (srcDay === targetDay || srcDay < 0 || targetDay < 0) return;
      const ms = getMutableState();
      const wk2 = ms.wks?.[viewWeek - 1];
      if (!wk2) return;
      const moves = wk2.workoutMoves ?? ((wk2 as any).workoutMoves = {} as Record<string, number>);
      moves[srcId] = targetDay;
      if (targetId) moves[targetId] = srcDay;
      mergeTimingMods(ms, wk2);
      saveState();
      _dragId = '';
      rerenderWeekListLocal(viewWeek);
    });
  });

  // ─── Rest-day drop zones ────────────────────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.plan-drop-zone').forEach(zone => {
    zone.addEventListener('dragover', (e) => {
      if (!_dragId) return;
      e.preventDefault();
      zone.style.background = 'rgba(99,102,241,0.08)';
      const label = zone.querySelector('.plan-drop-label') as HTMLElement | null;
      if (label) label.textContent = 'Drop here';
    });
    zone.addEventListener('dragleave', () => {
      zone.style.background = '';
      const label = zone.querySelector('.plan-drop-label') as HTMLElement | null;
      if (label) label.textContent = 'Rest';
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.style.background = '';
      const label = zone.querySelector('.plan-drop-label') as HTMLElement | null;
      if (label) label.textContent = 'Rest';
      const srcId = _dragId || (e as DragEvent).dataTransfer?.getData('text/plain') || '';
      const targetDay = parseInt(zone.dataset.dayOfWeek || '-1', 10);
      if (!srcId || targetDay < 0 || _dragDay === targetDay) return;
      const ms = getMutableState();
      const wk2 = ms.wks?.[viewWeek - 1];
      if (!wk2) return;
      const moves = wk2.workoutMoves ?? ((wk2 as any).workoutMoves = {} as Record<string, number>);
      moves[srcId] = targetDay;
      mergeTimingMods(ms, wk2);
      saveState();
      _dragId = '';
      rerenderWeekListLocal(viewWeek);
    });
  });

  // Touch DnD (iOS WKWebView + mobile web) is wired by the shared module-level
  // helper so the same code path re-attaches after every localized rerender.
  wirePlanCardTouchDnd(document, viewWeek);

  // Horizontal swipe on Plan now changes tabs (global page-swipe nav), not weeks.
  // Week navigation lives on the chevron buttons (#plan-week-prev / #plan-week-next)
  // and the numbered week pills. The old per-week touch swipe was removed here so
  // it no longer double-fires against the global tab swipe.
}

export function renderPlanView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  let s = getState();

  // Triathlon fork. Route to the tri plan view before any running-specific
  // setup runs. Running and track-only flows below are unaffected.
  if (s.eventType === 'triathlon') {
    import('./triathlon/plan-view').then(({ renderTriathlonPlanView }) => renderTriathlonPlanView());
    return;
  }

  // Just-Track users have no plan. Render an empty-state card with an
  // "Create a plan" CTA that relaunches the wizard at goals.
  if (s.trackOnly) {
    container.innerHTML = getTrackOnlyPlanHTML(s);
    wireTrackOnlyPlanHandlers();
    return;
  }

  // Archive mode: swap `s.wks`, `s.planStartDate`, `s.tw` to point at the
  // archived plan's data so all the existing plan-view rendering logic just
  // works. We set `s.w` to `archive.weeks.length + 1` so every archived week
  // is treated as "past" (no Mark-Done / Skip buttons, no "today" indicator).
  // The original `getState()` is preserved as `_liveState` for handlers that
  // need the real current week (e.g. archive count, jump-to-current).
  const archives = ((s as any).previousPlanWks ?? []) as Array<{ planStartDate: string; weeks: any[] }>;
  const archiveActive = _viewArchiveIdx !== null
    && _viewArchiveIdx >= 0
    && _viewArchiveIdx < archives.length;
  if (archiveActive) {
    const arc = archives[_viewArchiveIdx!];
    if (!arc?.weeks?.length) {
      // Defensive: archive is empty/corrupt. Drop back to live plan.
      _viewArchiveIdx = null;
      _viewWeek = null;
    } else {
      // Truncate archive weeks at the live plan's start at render time too —
      // the boot migration writes the truncated archive to disk, but a soft
      // reload (HMR) might not have run that migration yet. This view-time
      // filter makes the past-plan UI immediately self-correct: a 10-week
      // plan that got a continuousMode tail-extension week shows as 10 weeks,
      // not 11.
      let visibleWeeks = arc.weeks;
      const liveStartIso = (s as any).planStartDate as string | undefined;
      if (liveStartIso && arc.planStartDate) {
        const liveStartMs = new Date(liveStartIso + 'T00:00:00').getTime();
        const archStartMs = new Date(arc.planStartDate + 'T00:00:00').getTime();
        let firstOverlapIdx = arc.weeks.length;
        for (let i = 0; i < arc.weeks.length; i++) {
          if (archStartMs + i * 7 * 86400 * 1000 >= liveStartMs) {
            firstOverlapIdx = i;
            break;
          }
        }
        if (firstOverlapIdx < arc.weeks.length) {
          visibleWeeks = arc.weeks.slice(0, firstOverlapIdx);
        }
      }
      // If truncation emptied the archive entirely, fall back to live plan
      // rather than rendering an empty 0/0 view.
      if (visibleWeeks.length === 0) {
        _viewArchiveIdx = null;
        _viewWeek = null;
      } else {
        s = {
          ...(s as any),
          wks: visibleWeeks,
          planStartDate: arc.planStartDate,
          tw: visibleWeeks.length,
          w: visibleWeeks.length + 1,
        } as any;
        // If the user was sitting on a now-truncated week index, snap to the
        // last surviving week.
        if (_viewWeek !== null && _viewWeek > visibleWeeks.length) {
          _viewWeek = visibleWeeks.length;
        }
      }
    }
  }

  const viewWeek = (_viewWeek !== null && _viewWeek >= 1 && _viewWeek <= s.tw)
    ? _viewWeek
    : s.w;
  if (viewWeek === s.w && !archiveActive) maybeInitKmNudge();
  container.innerHTML = getPlanHTML(s, viewWeek);
  wirePlanHandlers(s, viewWeek);
  setOnWeekAdvance(() => {
    _viewWeek = null;
    _viewArchiveIdx = null;
    renderPlanView();
  });

  // Auto-show end-of-week debrief on Sunday (once per day)
  if (viewWeek === s.w && shouldShowSundayDebrief()) {
    setTimeout(() => showWeekDebrief(s.w, 'complete'), 400);
  }
}

// Localized re-render of just the week-list card after drag-and-drop.
// Same-week day reorders don't change weekly totals (TSS, km, counts), so the
// header/banners above the list stay correct. Rebuilding them causes a flicker.
// We replace only the list's innerHTML and re-wire handlers scoped to the new nodes.
// Non-card handlers (coach btn, banners, nav) are untouched and keep their original listeners.
// ─── Touch DnD for iOS WKWebView (HTML5 drag events don't fire there) ────────
// Long-press to reorder: the finger must rest TOUCH_DRAG_HOLD_MS before a drag
// arms, so scrolling the plan no longer reorders days by accident. Until the
// hold elapses, any real movement is treated as a scroll and the card is never
// picked up. (Tristan, 2026-06-01: 350ms. Mirrored in tri + HYROX.)
//
// Lives at module scope so BOTH the initial render (wirePlanHandlers) and every
// localized rerender (wireCardScopedHandlers, after each reorder) re-attach it.
// Earlier it was inline in wirePlanHandlers only, so touch reorder went dead
// after the first drag once the cards were rebuilt. Pass `root` so a local
// rerender rebinds only the fresh card nodes.
function wirePlanCardTouchDnd(root: ParentNode, viewWeek: number): void {
  const TOUCH_DRAG_HOLD_MS = 350;
  let _touchDragId = '';
  let _touchDragDay = -1;
  let _touchStartX = 0;
  let _touchStartY = 0;
  let _touchDragging = false;
  let _touchClone: HTMLElement | null = null;
  let _touchSourceCard: HTMLElement | null = null;
  let _touchLastHighlight: HTMLElement | null = null;
  let _touchHoldTimer: number | null = null;
  let _touchHoldMet = false;
  const _touchPrimary = isTouchPrimary();

  // Lift the card when the long-press hold completes so it's visibly clear the
  // card is now armed and the finger can move it. Without this the 350ms hold
  // gives no feedback and users don't realise dragging is enabled.
  const liftCard = (c: HTMLElement): void => {
    c.style.transition = 'transform 140ms ease, box-shadow 140ms ease';
    c.style.transform = 'scale(1.03)';
    c.style.boxShadow = '0 8px 24px rgba(0,0,0,0.16)';
    c.style.zIndex = '5';
  };
  const dropCard = (c: HTMLElement | null): void => {
    if (!c) return;
    c.style.transform = '';
    c.style.boxShadow = '';
    c.style.zIndex = '';
  };

  root.querySelectorAll<HTMLElement>('.plan-workout-card').forEach(card => {
    // On touch devices the native HTML5 `draggable` makes WKWebView lift its
    // own drag preview, doubling up with the custom clone below. Disable it so
    // only the touch DnD runs; desktop keeps it for mouse drag.
    if (_touchPrimary) card.draggable = false;
    card.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      _touchDragId = card.dataset.workoutId || '';
      _touchDragDay = parseInt(card.dataset.dayOfWeek || '-1', 10);
      _touchStartX = touch.clientX;
      _touchStartY = touch.clientY;
      _touchDragging = false;
      _touchSourceCard = card;
      _touchHoldMet = false;
      if (_touchHoldTimer !== null) clearTimeout(_touchHoldTimer);
      _touchHoldTimer = window.setTimeout(() => {
        _touchHoldMet = true;
        liftCard(card);
        fireSelectionHaptic();
      }, TOUCH_DRAG_HOLD_MS);
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!_touchDragId) return;
      const touch = e.touches[0];
      const dx = touch.clientX - _touchStartX;
      const dy = touch.clientY - _touchStartY;
      if (!_touchDragging) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Long-press gate. Before the hold elapses, real movement means the
        // user is scrolling: abandon the drag candidate and let the page
        // scroll (no preventDefault). After the hold, a small intentional
        // move arms the drag.
        if (!_touchHoldMet) {
          if (dist >= 8) {
            if (_touchHoldTimer !== null) { clearTimeout(_touchHoldTimer); _touchHoldTimer = null; }
            _touchDragId = '';
          }
          return;
        }
        // Hold met: the card is popped out and locked in. preventDefault on this
        // first move (even before the 8px drag threshold) so iOS does not
        // classify the gesture as a page scroll. Without this, a slow initial
        // move lets the page scroll and iOS then ignores later preventDefaults,
        // so the page keeps scrolling while you try to place the card.
        e.preventDefault();
        if (dist < 8) return;
        _touchDragging = true;
        if (_touchSourceCard) _touchSourceCard.style.opacity = '0.4';
        _touchClone = card.cloneNode(true) as HTMLElement;
        _touchClone.style.cssText = `position:fixed;pointer-events:none;opacity:0.75;z-index:9999;width:${card.offsetWidth}px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.18);`;
        document.body.appendChild(_touchClone);
      }

      e.preventDefault();

      if (_touchClone) {
        _touchClone.style.left = `${touch.clientX - card.offsetWidth / 2}px`;
        _touchClone.style.top  = `${touch.clientY - 30}px`;
      }

      if (_touchClone) _touchClone.style.visibility = 'hidden';
      const el = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;
      if (_touchClone) _touchClone.style.visibility = '';

      if (_touchLastHighlight) {
        _touchLastHighlight.style.outline = '';
        _touchLastHighlight.style.background = '';
        const lbl = _touchLastHighlight.querySelector('.plan-drop-label') as HTMLElement | null;
        if (lbl) lbl.textContent = 'Rest';
        _touchLastHighlight = null;
      }

      const targetCard = el?.closest<HTMLElement>('.plan-workout-card');
      if (targetCard && targetCard !== card) {
        targetCard.style.outline = '2px solid var(--c-accent)';
        targetCard.style.outlineOffset = '-2px';
        _touchLastHighlight = targetCard;
        return;
      }
      const targetZone = el?.closest<HTMLElement>('.plan-drop-zone');
      if (targetZone && !el?.closest('.plan-workout-card')) {
        const tDay = parseInt(targetZone.dataset.dayOfWeek || '-1', 10);
        if (tDay >= 0 && tDay !== _touchDragDay) {
          targetZone.style.background = 'rgba(99,102,241,0.08)';
          const lbl = targetZone.querySelector('.plan-drop-label') as HTMLElement | null;
          if (lbl) lbl.textContent = 'Drop here';
          _touchLastHighlight = targetZone;
        }
      }
    }, { passive: false });

    card.addEventListener('touchend', (e) => {
      if (_touchHoldTimer !== null) { clearTimeout(_touchHoldTimer); _touchHoldTimer = null; }
      _touchHoldMet = false;
      if (!_touchDragging || !_touchDragId) {
        dropCard(card);
        _touchDragId = '';
        _touchDragDay = -1;
        _touchSourceCard = null;
        _touchDragging = false;
        return;
      }

      if (_touchClone) { _touchClone.remove(); _touchClone = null; }
      dropCard(_touchSourceCard);
      if (_touchSourceCard) { _touchSourceCard.style.opacity = ''; }
      if (_touchLastHighlight) {
        _touchLastHighlight.style.outline = '';
        _touchLastHighlight.style.background = '';
        const lbl = _touchLastHighlight.querySelector('.plan-drop-label') as HTMLElement | null;
        if (lbl) lbl.textContent = 'Rest';
        _touchLastHighlight = null;
      }

      const touch = e.changedTouches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;

      const srcId = _touchDragId;
      const srcDay = _touchDragDay;
      _touchDragId = '';
      _touchDragDay = -1;
      _touchDragging = false;
      _touchSourceCard = null;

      const applyMove = (targetId: string, targetDay: number) => {
        if (srcDay === targetDay || srcDay < 0 || targetDay < 0) return;
        const ms = getMutableState();
        const wk2 = ms.wks?.[viewWeek - 1];
        if (!wk2) return;
        const moves = wk2.workoutMoves ?? ((wk2 as any).workoutMoves = {} as Record<string, number>);
        moves[srcId] = targetDay;
        if (targetId) moves[targetId] = srcDay;
        mergeTimingMods(ms, wk2);
        saveState();
        rerenderWeekListLocal(viewWeek);
      };

      const applyMoveToDay = (targetDay: number) => {
        if (srcDay === targetDay || srcDay < 0 || targetDay < 0) return;
        const ms = getMutableState();
        const wk2 = ms.wks?.[viewWeek - 1];
        if (!wk2) return;
        const moves = wk2.workoutMoves ?? ((wk2 as any).workoutMoves = {} as Record<string, number>);
        moves[srcId] = targetDay;
        mergeTimingMods(ms, wk2);
        saveState();
        rerenderWeekListLocal(viewWeek);
      };

      const targetCard = el?.closest<HTMLElement>('.plan-workout-card');
      if (targetCard && targetCard !== card) {
        const targetId = targetCard.dataset.workoutId || '';
        const targetDay = parseInt(targetCard.dataset.dayOfWeek || '-1', 10);
        applyMove(targetId, targetDay);
        return;
      }
      const targetZone = el?.closest<HTMLElement>('.plan-drop-zone');
      if (targetZone && !el?.closest('.plan-workout-card')) {
        applyMoveToDay(parseInt(targetZone.dataset.dayOfWeek || '-1', 10));
      }
    });

    // iOS fires touchcancel when a gesture is interrupted (e.g. scroll takes
    // over). Without resetting here, a card lifted by the hold would stay
    // popped out.
    card.addEventListener('touchcancel', () => {
      if (_touchHoldTimer !== null) { clearTimeout(_touchHoldTimer); _touchHoldTimer = null; }
      _touchHoldMet = false;
      dropCard(card);
      if (_touchClone) { _touchClone.remove(); _touchClone = null; }
      if (_touchSourceCard) { _touchSourceCard.style.opacity = ''; }
      _touchDragId = '';
      _touchDragDay = -1;
      _touchSourceCard = null;
      _touchDragging = false;
    });
  });
}

function rerenderWeekListLocal(viewWeek: number): void {
  const listEl = document.getElementById('plan-week-list');
  if (!listEl) { renderPlanView(); return; }
  const s = getState();
  const workouts = computeRenderedWorkouts(s, viewWeek);
  listEl.innerHTML = buildWorkoutCards(s, workouts, viewWeek);
  wireCardScopedHandlers(listEl, viewWeek);
}

// Wires handlers for elements that live inside .plan-workout-card / .plan-drop-zone.
// Scoped to `root` so a localized rerender only rebinds fresh card nodes and doesn't
// double-bind handlers on persistent outside elements (e.g. activity-log rows).
function wireCardScopedHandlers(root: ParentNode, viewWeek: number): void {
  // Start buttons (header + expanded detail)
  const startHandler = (e: Event) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const wkId = btn.dataset.workoutId || '';
    const workout = _workoutLookup.get(wkId);
    const name = workout?.n || wkId;
    const desc = workout?.d || '';
    if (window.trackWorkout) window.trackWorkout(name, desc);
  };
  root.querySelectorAll('.plan-start-btn').forEach(el => el.addEventListener('click', startHandler));
  root.querySelectorAll('.plan-detail-start-btn').forEach(el => el.addEventListener('click', startHandler));

  // Expand chevron (view arrow)
  root.querySelectorAll('.plan-view-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (el as HTMLElement).dataset.workoutId || '';
      const detail = document.getElementById(safeDetailId(id));
      if (detail) {
        const isExpanded = detail.style.display !== 'none';
        detail.style.display = isExpanded ? 'none' : 'block';
        const card = detail.closest('.plan-workout-card');
        const chevron = card?.querySelector('.plan-card-chevron') as SVGElement | null;
        if (chevron) chevron.style.transform = isExpanded ? '' : 'rotate(180deg)';
      }
    });
  });

  // Card header click (expand/collapse)
  root.querySelectorAll('.plan-card-header').forEach(header => {
    header.addEventListener('click', (e) => {
      const target = e.target as Element;
      if (target.closest('.plan-start-btn') || target.closest('.plan-view-btn') || target.closest('.plan-act-open') || target.closest('.plan-recovery-undo-btn')) return;
      const card = header.closest('.plan-workout-card') as HTMLElement;
      const id = card?.getAttribute('data-workout-id');
      if (!id) return;
      // Strength/gym cards open the clean detail modal instead of expanding.
      // Exception: a SKIPPED gym session has no skip/unskip control in that
      // modal, so fall through to the inline expanded card where the Unskip
      // button lives. Otherwise the user can never un-skip a gym workout.
      if (card?.hasAttribute('data-gym-detail')) {
        const gymRating = getState().wks?.[viewWeek - 1]?.rated?.[id];
        if (gymRating !== 'skip') {
          openGymCardDetail(id, viewWeek);
          return;
        }
      }
      const detail = document.getElementById(safeDetailId(id));
      if (!detail) return;
      const isExpanded = detail.style.display !== 'none';
      detail.style.display = isExpanded ? 'none' : 'block';
      const chevron = header.querySelector('.plan-card-chevron') as SVGElement;
      if (chevron) chevron.style.transform = isExpanded ? '' : 'rotate(180deg)';
      if (!isExpanded) {
        detail.querySelectorAll<HTMLCanvasElement>('canvas.plan-detail-map').forEach(canvas => {
          const encoded = canvas.dataset.polyline;
          if (!encoded) return;
          const kmSplitsRaw = canvas.dataset.kmSplits;
          const kmSplits = kmSplitsRaw ? JSON.parse(kmSplitsRaw) as number[] : undefined;
          import('./strava-detail').then(({ drawPolylineOnCanvas }) => {
            requestAnimationFrame(() => void drawPolylineOnCanvas(canvas, encoded, kmSplits));
          });
        });
      }
    });
  });

  // Move-to-day buttons
  root.querySelectorAll<HTMLElement>('.plan-move-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wId = btn.dataset.workoutId || '';
      const targetDay = parseInt(btn.dataset.targetDay || '-1', 10);
      const currentDay = parseInt(btn.dataset.currentDay || '-1', 10);
      if (!wId || targetDay < 0 || targetDay === currentDay) return;
      const ms = getMutableState();
      const wk2 = ms.wks?.[viewWeek - 1];
      if (!wk2) return;
      const moves = wk2.workoutMoves ?? ((wk2 as any).workoutMoves = {} as Record<string, number>);
      moves[wId] = targetDay;
      mergeTimingMods(ms, wk2);
      saveState();
      renderPlanView();
    });
  });

  // Expanded detail actions
  root.querySelectorAll('.plan-action-mark-done').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      markPlanCardDone(btn as HTMLElement);
      renderPlanView();
    });
  });

  root.querySelectorAll('.plan-action-skip').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLElement;
      const wId = el.dataset.workoutId || '';
      const name = el.dataset.name || '';
      const type = el.dataset.type || 'easy';
      const rpe = parseInt(el.dataset.rpe || '5', 10);
      const desc = el.dataset.desc || '';
      const day = parseInt(el.dataset.day || '0', 10);
      const weekNum = el.dataset.weekNum ? parseInt(el.dataset.weekNum, 10) : undefined;
      skip(wId, name, type, false, 0, desc, rpe, day, '', weekNum, el.dataset.longRun === '1');
      renderPlanView();
    });
  });

  root.querySelectorAll('.plan-action-adjust').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAdjustFromButton(btn as HTMLElement);
    });
  });

  root.querySelectorAll('.plan-action-unrate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLElement;
      const ms = getMutableState();
      // Operate on the week the card belongs to, not just the current week — a
      // skipped/done session on a past week must un-rate that week's record.
      const weekNum = parseInt(el.dataset.weekNum || '', 10) || ms.w;
      if (!unratePlanSlot(weekNum, el.dataset.workoutId || '')) return;
      saveState();
      renderPlanView();
    });
  });

  root.querySelectorAll('.plan-remove-garmin').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const gId = (btn as HTMLElement).dataset.garminId || '';
      if (gId) removeGarminActivity(gId);
      renderPlanView();
    });
  });

  // Tier-1 auto-reduce undo
  root.querySelectorAll<HTMLElement>('.plan-auto-undo-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s2 = getMutableState();
      const wk2 = s2.wks?.[s2.w - 1];
      if (!wk2) return;
      removeWorkoutMods(wk2, m => !!m.modReason?.startsWith('Auto:'));
      saveState();
      import('@/ui/renderer').then(({ render }) => render());
    });
  });

  // Timing-suggestion accept
  root.querySelectorAll<HTMLElement>('.plan-timing-accept').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onTimingAccept(btn)) renderPlanView();
    });
  });

  // Activity-match click-through (card-side only; log-side handled by initial wire)
  root.querySelectorAll<HTMLElement>('.plan-act-open').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const workoutKey = el.dataset.workoutKey || '';
      const weekNum = parseInt(el.dataset.weekNum || '0', 10);
      if (!workoutKey || !weekNum) return;
      const s2 = getState();
      const actual = s2.wks?.[weekNum - 1]?.garminActuals?.[workoutKey];
      if (!actual) return;
      const plannedTSSAttr = parseInt(el.dataset.plannedTss || '0', 10) || 0;
      const { renderActivityDetail } = await import('./activity-detail');
      renderActivityDetail(actual, actual.workoutName || actual.displayName || workoutKey, 'plan', plannedTSSAttr || undefined, workoutKey);
    });
  });

  // Adhoc delete
  root.querySelectorAll<HTMLElement>('.plan-adhoc-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      const wkId = el.dataset.workoutId || '';
      const weekNum = parseInt(el.dataset.weekNum || '0', 10);
      const ms = getMutableState();
      const wk2 = ms.wks?.[weekNum - 1];
      if (wk2?.adhocWorkouts) {
        wk2.adhocWorkouts = wk2.adhocWorkouts.filter((w: any) => (w.id || w.n) !== wkId);
        saveState();
        renderPlanView();
      }
    });
  });

  // Drag-and-drop reorder
  let _dragId = '';
  let _dragDay = -1;
  root.querySelectorAll<HTMLElement>('.plan-workout-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      _dragId = card.dataset.workoutId || '';
      _dragDay = parseInt(card.dataset.dayOfWeek || '-1', 10);
      (e as DragEvent).dataTransfer?.setData('text/plain', _dragId);
      card.style.opacity = '0.4';
    });
    card.addEventListener('dragend', () => {
      card.style.opacity = '';
      card.style.outline = '';
    });
    card.addEventListener('dragover', (e) => {
      if (!_dragId || card.dataset.workoutId === _dragId) return;
      e.preventDefault();
      card.style.outline = '2px solid var(--c-accent)';
      card.style.outlineOffset = '-2px';
    });
    card.addEventListener('dragleave', () => {
      card.style.outline = '';
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.style.outline = '';
      const srcId = _dragId || (e as DragEvent).dataTransfer?.getData('text/plain') || '';
      if (!srcId || card.dataset.workoutId === srcId) return;
      const targetId = card.dataset.workoutId || '';
      const srcDay = _dragDay;
      const targetDay = parseInt(card.dataset.dayOfWeek || '-1', 10);
      if (srcDay === targetDay || srcDay < 0 || targetDay < 0) return;
      const ms = getMutableState();
      const wk2 = ms.wks?.[viewWeek - 1];
      if (!wk2) return;
      const moves = wk2.workoutMoves ?? ((wk2 as any).workoutMoves = {} as Record<string, number>);
      moves[srcId] = targetDay;
      if (targetId) moves[targetId] = srcDay;
      mergeTimingMods(ms, wk2);
      saveState();
      _dragId = '';
      rerenderWeekListLocal(viewWeek);
    });
  });

  root.querySelectorAll<HTMLElement>('.plan-drop-zone').forEach(zone => {
    zone.addEventListener('dragover', (e) => {
      if (!_dragId) return;
      e.preventDefault();
      zone.style.background = 'rgba(99,102,241,0.08)';
      const label = zone.querySelector('.plan-drop-label') as HTMLElement | null;
      if (label) label.textContent = 'Drop here';
    });
    zone.addEventListener('dragleave', () => {
      zone.style.background = '';
      const label = zone.querySelector('.plan-drop-label') as HTMLElement | null;
      if (label) label.textContent = 'Rest';
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.style.background = '';
      const label = zone.querySelector('.plan-drop-label') as HTMLElement | null;
      if (label) label.textContent = 'Rest';
      const srcId = _dragId || (e as DragEvent).dataTransfer?.getData('text/plain') || '';
      const targetDay = parseInt(zone.dataset.dayOfWeek || '-1', 10);
      if (!srcId || targetDay < 0 || _dragDay === targetDay) return;
      const ms = getMutableState();
      const wk2 = ms.wks?.[viewWeek - 1];
      if (!wk2) return;
      const moves = wk2.workoutMoves ?? ((wk2 as any).workoutMoves = {} as Record<string, number>);
      moves[srcId] = targetDay;
      mergeTimingMods(ms, wk2);
      saveState();
      _dragId = '';
      rerenderWeekListLocal(viewWeek);
    });
  });

  // Re-attach touch DnD on the freshly rebuilt cards. Without this, touch
  // reorder went dead after the first drag (only the HTML5 mouse path above was
  // rewired) and the native `draggable` ghost reappeared on iOS.
  wirePlanCardTouchDnd(root, viewWeek);
}

// ─── Just-Track empty state ─────────────────────────────────────────────────

/**
 * Just-Track Plan tab. No forward planning. Instead, a retrospective log:
 * current week broken down by day (showing synced + recorded activities),
 * followed by a rolling history list of prior weeks with totals. Create-a-plan
 * CTA lives at the bottom.
 *
 * Values come from each week's `garminActuals` / `adhocWorkouts`. The same
 * buckets planned users write to. No special trackOnly data store.
 */
function getTrackOnlyPlanHTML(s: SimulatorState): string {
  const unit = s.unitPref ?? 'km';
  const wks = s.wks ?? [];
  const currentWk = wks[s.w - 1];
  const priorWks = wks.slice(0, Math.max(0, s.w - 1)).reverse();

  const currentWeekBlock = currentWk
    ? buildTrackOnlyWeekDetail(s, currentWk, 'This week')
    : '<div style="font-size:13px;color:var(--c-muted);padding:18px">No current week. Sync or record an activity to begin.</div>';

  const historyBlock = priorWks.length === 0 ? '' : `
    <div class="tp-rise" style="margin-top:22px;animation-delay:0.12s">
      <div style="font-size:11px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase;padding:0 4px 10px">History</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${priorWks.slice(0, 12).map(wk => buildTrackOnlyWeekRow(s, wk, unit)).join('')}
      </div>
    </div>`;

  const animate = shouldPlayEntrance('plan');

  return `
    <style>
      @keyframes floatUp { from { opacity:0; } to { opacity:1; } }
      .tp-rise { ${animate ? 'opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;' : 'opacity:1;'} }
      .tp-week-row { background:rgba(255,255,255,0.78); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border:1px solid rgba(255,255,255,0.65); border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04); padding:14px 16px; display:flex; align-items:center; gap:14px; }
      .tp-week-num { font-size:10px; font-weight:600; color:#94A3B8; letter-spacing:0.05em; text-transform:uppercase; }
      .tp-week-total { font-size:18px; font-weight:700; color:#0F172A; letter-spacing:-0.01em; font-variant-numeric:tabular-nums; }
      .tp-week-sub { font-size:11px; color:#64748B; margin-top:2px; }
    </style>
    <div class="mosaic-page" style="background:${atmosphereGradient('sky')};position:relative;min-height:100vh">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('pln', { variant: 'asymmetric', side: 'right', palette: 'sky', pulse: animate, entrance: animate ? 'small' : 'none' })}
      </div>
      ${buildSunGlint('low')}
      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding:56px 16px 120px">

        <div class="tp-rise" style="padding:0 4px 18px">
          <div style="font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0F172A">Sessions</div>
          <div style="font-size:13px;color:#64748B;margin-top:2px">Generate one any time. No fixed plan.</div>
        </div>

        <!-- Primary action: generate a session. On-demand has no plan, so this is the
             hero, not a plan-creation prompt. Whole-card tap target, no accent fill. -->
        <div class="tp-rise" style="margin-bottom:18px;animation-delay:0.06s">
          <button id="track-generate-session" style="display:block;width:100%;text-align:left;background:#fff;border:1px solid rgba(0,0,0,0.06);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px;cursor:pointer;font-family:inherit">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
              <div>
                <div style="font-size:16px;font-weight:700;color:#0F172A;letter-spacing:-0.01em;margin-bottom:4px">Generate a session</div>
                <div style="font-size:13px;color:#64748B;line-height:1.45">Run, bike, swim or gym. We read your recovery and size it to today.</div>
              </div>
              <span style="font-size:20px;color:#94A3B8;flex:0 0 auto">&rarr;</span>
            </div>
          </button>
        </div>

        ${buildTrackOnlyUpcoming(s)}
        ${currentWeekBlock}
        ${historyBlock}

      </div>
      ${renderTabBar('plan', isSimulatorMode())}
    </div>
  `;
}

/** One logged activity on the Just-Track Plan tab. */
interface TrackOnlyLogItem {
  day: string;
  name: string;
  /** Distance, else duration, else blank. */
  value: string;
  distanceKm: number;
  sortTime: number;
}

/**
 * The activities a Just-Track week holds, each once, newest first. The one list
 * the This week card (rows and distance) and the History row (distance and
 * session count) both read, so the two cannot disagree. Tracking side: it
 * describes what the user did. Load stays computeWeekRawTSS.
 *
 * Base: collectWeekActivities (week-activity-log.ts), the canonical week list,
 * de-duplicated by key. An activity record and its adhoc card under the same
 * key count once: an in-app GPS run (card and record under the recording id,
 * recording-handler.ts saveAsAdhoc) and an accepted synced activity (card and
 * actual under `garmin-<id>`). Pending items stay out: they are not reviewed
 * yet, carry no load in computeWeekRawTSS, and this card never listed them.
 *
 * Added: a non-synced adhoc card with no activity record, which the canonical
 * list does not model, once it is done (rated or timestamped). That is a
 * generated, holiday or benchmark session marked done, or a GPS card stored
 * before the run carried a record. A planned session not done yet renders
 * under Planned (buildTrackOnlyUpcoming) and stays out of this record of what
 * happened. So does an unfinished Quick Run placeholder (justRun: no id, no
 * rating).
 */
function trackOnlyWeekLog(wk: Week, unit: 'km' | 'mi'): TrackOnlyLogItem[] {
  const actuals = wk.garminActuals ?? {};
  const adhocs = (wk.adhocWorkouts ?? []) as any[];
  const ratedMap: Record<string, number | 'skip'> = wk.rated ?? {};
  const dayLabel = (ms: number) => ms > 0 ? new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) : '—';
  const valueOf = (km: number, min: number) => km > 0 ? formatKm(km, unit) : min > 0 ? `${Math.round(min)} min` : '';
  const adhocName = (w: any) => w?.activityType ? formatActivityType(w.activityType) : (w?.n || 'Workout');
  const items: TrackOnlyLogItem[] = [];

  for (const e of collectWeekActivities(wk)) {
    if (e.source === 'pending') continue;
    let name: string;
    if (e.source === 'actual') {
      const a = actuals[e.key] as any;
      name = a?.displayName || a?.workoutName || (a?.activityType ? formatActivityType(a.activityType) : 'Activity');
    } else {
      name = adhocName(adhocs.find(w => w.id === e.key));
    }
    items.push({ day: dayLabel(e.sortTime), name, value: valueOf(e.distanceKm, e.durationMin), distanceKm: e.distanceKm, sortTime: e.sortTime });
  }

  for (const w of adhocs) {
    const id: string = w.id || '';
    if (id.startsWith('garmin-')) continue; // listed above, as its card or its record
    if (id && actuals[id]) continue;        // its record is listed above
    if (!w.garminTimestamp && ratedMap[id] == null) continue; // not done
    const km = w.garminDistKm ?? w.distanceKm;
    const distanceKm = typeof km === 'number' && km > 0 ? km : 0;
    const sortTime = w.garminTimestamp ? (Date.parse(w.garminTimestamp) || 0) : 0;
    items.push({ day: dayLabel(sortTime), name: adhocName(w), value: valueOf(distanceKm, w.durationMin ?? 0), distanceKm, sortTime });
  }

  return items.sort((a, b) => b.sortTime - a.sortTime);
}

/** Per-week row for the Plan-tab history list. */
function buildTrackOnlyWeekRow(s: SimulatorState, wk: Week, unit: 'km' | 'mi'): string {
  const ratedMap: Record<string, number | 'skip'> = wk.rated ?? {};
  const tss = Math.round(computeWeekRawTSS(wk, ratedMap, s.planStartDate));
  const log = trackOnlyWeekLog(wk, unit);
  const km = log.reduce((sum, item) => sum + item.distanceKm, 0);
  const sessions = log.length;
  return `
    <div class="tp-week-row">
      <div style="flex:1;min-width:0">
        <div class="tp-week-num">Week ${wk.w}</div>
        <div class="tp-week-total">${formatKm(km, unit)}</div>
        <div class="tp-week-sub">${sessions} session${sessions === 1 ? '' : 's'} · ${tss} TSS</div>
      </div>
    </div>`;
}

/**
 * Upcoming generated sessions for the On-demand Plan tab, rendered as interactive
 * PLANNED-ACTIVITY cards (tap → workout detail with Start / Mark-as-done), so a
 * generated session appears as a planned activity here exactly like running/tri
 * plans show theirs. Filter: not-yet-synced, un-rated `adhoc-` sessions in the
 * current week (the same ones `buildRecentActivity` excludes from Recent).
 */
function buildTrackOnlyUpcoming(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  if (!wk) return '';
  const rated: Record<string, number | 'skip'> = wk.rated ?? {};
  const unit = s.unitPref ?? 'km';
  const esc = (str: string) => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const upcoming = (wk.adhocWorkouts ?? [])
    .map((w, idx) => ({ w: w as any, idx }))
    .filter(({ w }) => (w.id || '').startsWith('adhoc-') && !w.garminTimestamp && rated[w.id] == null);
  if (upcoming.length === 0) return '';

  // Type / discipline badge. Sentence-case (uppercase labels fail the UI lint).
  const TYPE_LABEL: Record<string, string> = {
    easy: 'Easy', long: 'Long', threshold: 'Threshold', vo2: 'VO2',
    marathon_pace: 'Marathon pace', progressive: 'Progressive', vibes: 'By feel', gym: 'Gym',
  };
  const cards = upcoming.map(({ w, idx }) => {
    const name = w.n || w.name || w.workoutName || 'Session';
    const dist = w.distanceKm;
    const dur = w.durationMin ?? w.estimatedDurationMin;
    const durLabel = typeof dur === 'number' && dur > 0 ? `${Math.round(dur)} min`
      : typeof dist === 'number' && dist > 0 ? formatKm(dist, unit) : '';
    const badge = w.discipline === 'bike' ? 'Bike' : w.discipline === 'swim' ? 'Swim'
      : TYPE_LABEL[w.t as string] ?? (w.t ? String(w.t).replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) : 'Session');
    // Structure preview: gym → "N exercises" summary; others → first lines of the
    // description (warm-up / main / cool-down), mirroring the plan-mode workout card.
    const summary = strengthCardSummary(w);
    const structure = summary
      ? `<div style="font-size:12px;color:#64748B;margin-top:6px;line-height:1.5">${esc(summary)}</div>`
      : (w.d ? `<div style="font-size:12px;color:#64748B;margin-top:6px;line-height:1.5">${String(w.d).split('\n').filter((l: string) => l.trim()).slice(0, 3).map((l: string) => esc(l.trim())).join('<br>')}</div>` : '');
    // Whole card is the tap target (→ session detail with Start / guided / Mark-done).
    // The Start pill is a span, so its click bubbles to the card — no double-fire.
    return `
      <div class="tp-upcoming-row" data-week-num="${s.w}" data-adhoc-idx="${idx}" style="background:#fff;border:1px solid rgba(0,0,0,0.06);border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05);padding:15px 16px;cursor:pointer;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:11px;font-weight:600;color:#475569;background:rgba(15,23,42,0.05);border-radius:100px;padding:3px 9px">${esc(badge)}</span>
          ${durLabel ? `<span style="font-size:12px;color:#64748B">${esc(durLabel)}</span>` : ''}
        </div>
        <div style="font-size:16px;font-weight:700;color:#0F172A;letter-spacing:-0.01em">${esc(name)}</div>
        ${structure}
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:12px;padding:9px 0;background:#0F172A;border-radius:10px;color:#fff;font-size:13px;font-weight:600">
          <span style="width:9px;height:9px;background:#fff;clip-path:polygon(0 0,100% 50%,0 100%);display:inline-block"></span>
          Start
        </div>
      </div>`;
  }).join('');

  return `
    <div class="tp-rise" style="margin-bottom:18px;animation-delay:0.04s">
      <div style="font-size:11px;font-weight:600;color:#64748B;letter-spacing:0.05em;text-transform:uppercase;padding:0 4px 10px">Planned</div>
      ${cards}
    </div>`;
}

function buildTrackOnlyWeekDetail(s: SimulatorState, wk: Week, title: string): string {
  const unit = s.unitPref ?? 'km';
  const ratedMap: Record<string, number | 'skip'> = wk.rated ?? {};
  const tss = Math.round(computeWeekRawTSS(wk, ratedMap, s.planStartDate));

  // Same list as the History row (trackOnlyWeekLog): each activity once, newest first.
  const rows = trackOnlyWeekLog(wk, unit);
  const km = rows.reduce((sum, r) => sum + r.distanceKm, 0);

  const rowsHtml = rows.length === 0
    ? '<div style="padding:16px;text-align:center;font-size:13px;color:var(--c-muted)">No activities logged this week.</div>'
    : rows.map(r => `
        <div class="tp-log-row" style="display:flex;align-items:center;gap:14px;padding:12px 16px;border-top:1px solid rgba(0,0,0,0.04)">
          <div style="min-width:54px;font-size:11px;color:#64748B">${r.day}</div>
          <div style="flex:1;min-width:0;font-size:14px;color:#0F172A">${escapeHtml(r.name)}</div>
          <div style="font-size:13px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${r.value}</div>
        </div>`).join('');

  return `
    <div class="tp-rise" style="animation-delay:0.06s">
      <div style="background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);overflow:hidden">
        <div style="padding:16px 16px 12px;display:flex;align-items:baseline;justify-content:space-between">
          <div>
            <div style="font-size:11px;font-weight:600;color:#64748B;letter-spacing:0.05em;text-transform:uppercase">${title}</div>
            <div class="tp-detail-total" style="font-size:24px;font-weight:700;letter-spacing:-0.02em;color:#0F172A;margin-top:4px">${formatKm(km, unit)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:#64748B">TSS</div>
            <div style="font-size:17px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${tss}</div>
          </div>
        </div>
        ${rowsHtml}
      </div>
    </div>`;
}

function wireTrackOnlyPlanHandlers(): void {
  wireTabBarHandlers(navigateTab);
  // Primary action: generate a session. Plan-creation lives in Settings now (it
  // resets the app), so it is no longer surfaced on the On-demand Plan tab.
  document.getElementById('track-generate-session')?.addEventListener('click', () => {
    import('./session-generator').then(({ openSessionGenerator }) => openSessionGenerator());
  });
  // Upcoming generated sessions → open the workout detail (Start / guided / Mark
  // done). Same routing as the home "To do"; openTriWorkoutDetail forwards gym
  // sessions to the strength flow.
  document.querySelectorAll<HTMLElement>('.tp-upcoming-row').forEach(el => {
    el.addEventListener('click', () => {
      const weekNum = Number(el.dataset.weekNum || 0);
      const adhocIdx = Number(el.dataset.adhocIdx);
      const st = getState();
      const adhoc = (st.wks?.[weekNum - 1]?.adhocWorkouts ?? [])[adhocIdx];
      if (adhoc) import('./triathlon/workout-detail-modal').then(({ openTriWorkoutDetail }) => openTriWorkoutDetail(adhoc, weekNum - 1));
    });
  });
}

/** Build a minimal Workout from an Adjust button's data attributes and open the
 *  per-session scaling overlay. The card already carries the resolved (post-mod)
 *  values, so we avoid re-deriving the week's workouts here. */
function openAdjustFromButton(el: HTMLElement): void {
  const weekNum = el.dataset.weekNum ? parseInt(el.dataset.weekNum, 10) : getMutableState().w;
  const durRaw = el.dataset.dur;
  const origDurRaw = el.dataset.origDur;
  const workoutId = el.dataset.workoutId || undefined;
  const w = {
    id: workoutId,
    n: el.dataset.name || '',
    dayOfWeek: el.dataset.day != null ? parseInt(el.dataset.day, 10) : undefined,
    d: el.dataset.d || '',
    t: el.dataset.type || 'easy',
    rpe: el.dataset.rpe ? parseInt(el.dataset.rpe, 10) : undefined,
    estimatedDurationMin: durRaw ? parseInt(durRaw, 10) : undefined,
    originalDurationMin: origDurRaw ? parseInt(origDurRaw, 10) : undefined,
    originalDistance: el.dataset.orig || undefined,
  } as import('@/types/state').Workout;
  import('@/ui/workout-adjust-overlay').then(m => m.openWorkoutAdjust(w, weekNum - 1, { workoutId }));
}
