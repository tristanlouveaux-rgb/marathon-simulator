/**
 * Plan tab — weekly calendar strip + Vergia-style workout card list.
 * Week navigation with < > buttons (keyboard arrow keys on web, swipe on iOS Phase 3).
 * Complex interactions (rating, Garmin matching) delegate to renderMainView() for now.
 */

import { getState, getMutableState, saveState } from '@/state';
import type { SimulatorState, Week, Workout } from '@/types';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { isSimulatorMode } from '@/main';
import { generateWeekWorkouts, calculateWorkoutLoad } from '@/workouts';
import { isDeloadWeek, abilityBandFromVdot } from '@/workouts/plan_engine';
import { rate, skip, removeGarminActivity, next, setOnWeekAdvance, isBenchmarkWeek, maybeInitKmNudge } from './events';
import { openActivityReReview, showActivityReview } from './activity-review';
import { openInjuryModal, isInjuryActive, markAsRecovered, getInjuryStateForDisplay } from './injury/modal';
import { openCheckinOverlay } from './checkin-overlay';
import { openCoachModal } from './coach-modal';
import { applyIllnessMods, clearIllness, openIllnessModal } from './illness-modal';
import { applyHolidayMods, buildHolidayBannerPlan, clearHoliday, cancelScheduledHoliday, openHolidayModal, isWeekInHoliday, getHolidayDaysForWeek, applyBridgeMods_renderTime } from './holiday-modal';
import { openSessionGenerator } from './session-generator';
import { openBenchmarkOverlay, maybeTriggerBenchmarkOverlay } from './benchmark-overlay';
import { getReturnToRunLevelLabel, recordMorningPain } from '@/injury/engine';
import { INJURY_PROTOCOLS } from '@/constants/injury-protocols';
import { TL_PER_MIN, SPORTS_DB } from '@/constants';
import { computeWeekTSS, computeWeekRawTSS, getWeeklyExcess, computePlannedWeekTSS, computePlannedSignalB, getTrailingEffortScore, computeCrossTrainTSSPerMin, estimateWorkoutDurMin, computeDecayedCarry } from '@/calculations/fitness-model';
import { normalizeSport } from '@/cross-training/activities';
import { formatActivityType, getHREffort } from '@/calculations/activity-matcher';
import { formatKm, fmtDesc, formatPace } from '@/utils/format';
import { triggerExcessLoadAdjustment, hasRemainingWeekWorkouts } from './excess-load-card';
import { showRunBreakdownSheet, buildProgressBars } from './home-view';
import { computeWeekSignals, getSignalPills, getFutureWeekPills, PILL_COLORS, type SignalPill } from '@/calculations/coach-insight';
import { isTimingMod, mergeTimingMods } from '@/cross-training/timing-check';
import type { MorningPainResponse } from '@/types/injury';
import { computeRecoveryStatus, sleepQualityToScore } from '@/recovery/engine';
import { calculateZones, getWorkoutHRTarget } from '@/calculations/heart-rate';
import type { RecoveryEntry, RecoveryLevel } from '@/recovery/engine';
import { showWeekDebrief, shouldShowSundayDebrief } from '@/ui/week-debrief';

// ─── Module state ────────────────────────────────────────────────────────────

let _viewWeek: number | null = null; // null = current week
let _workoutLookup: Map<string, { n: string; d: string }> = new Map();

// ─── Recovery undo — module-level delegated handler (set once, survives re-renders) ──
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
      <button id="undo-adj-confirm-btn" style="width:100%;padding:13px;border-radius:12px;border:none;background:var(--c-accent);color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--f);margin-bottom:8px">Restore original</button>
      <button id="undo-adj-cancel-btn" style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--c-border);background:transparent;color:var(--c-text);font-size:15px;cursor:pointer;font-family:var(--f)">Cancel</button>
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
    // Match by name only — dayOfWeek is optional on WorkoutMod and may differ
    // from the rendered workout (e.g. after drag-reorder). Remove all non-auto
    // mods for this workout name so double-applications are also cleared.
    wk2.workoutMods = (wk2.workoutMods ?? []).filter(
      m => !(m.name === workoutName && !m.modReason?.startsWith('Auto:'))
    );
    saveState();
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  });
}, true); // capture phase — fires before card-header bubble handler

// ─── Navigation ──────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') {
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'record') {
    import('./record-view').then(({ renderRecordView }) => renderRecordView());
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
  const d = new Date(planStartDate);
  d.setDate(d.getDate() + (weekNum - 1) * 7);
  return d;
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
const PLAN_CARD_STYLE = 'background:var(--c-surface);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)';

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


function fmtZoneSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

// ─── Workout expanded detail ──────────────────────────────────────────────────

function buildWorkoutExpandedDetail(w: any, wk: Week | undefined, viewWeek: number, currentWeek?: number): string {
  const id = w.id || w.n;
  const rated = wk?.rated ?? {};
  const ratingVal = rated[id];
  const garminActual = wk?.garminActuals?.[id];
  const isDone = (typeof ratingVal === 'number' && ratingVal > 0) || !!garminActual;
  const isSkipped = ratingVal === 'skip';

  // Compute planned TSS using TL_PER_MIN (same scale as fitness-model.ts)
  const _s = getState();
  const plannedTSS = (() => {
    const t = (w.t || '').toLowerCase();
    if (!t || t === 'rest') return 0;
    const baseMinPerKm = _s.pac?.e ? _s.pac.e / 60 : 5.5;
    const durMin = estimateWorkoutDurMin(w, baseMinPerKm);
    const rpe = w.rpe ?? w.r ?? 5;

    // Cross-training: use historical iTrimp-based rate when available,
    // fall back to TL_PER_MIN × sport runSpec (avoids running-calibrated inflation).
    if (t === 'cross' || t === 'gym') {
      const sportKey = t === 'gym' ? 'strength' : normalizeSport(w.n || 'generic_sport');
      const historicalRate = computeCrossTrainTSSPerMin(_s.wks, sportKey);
      if (historicalRate != null) {
        return Math.round(historicalRate * durMin);
      }
      const cfg = (SPORTS_DB as Record<string, { runSpec?: number }>)[sportKey];
      const runSpec = cfg?.runSpec ?? 0.40;
      return Math.round((TL_PER_MIN[Math.round(rpe)] ?? 1.15) * durMin * runSpec);
    }

    return Math.round((TL_PER_MIN[Math.round(rpe)] ?? 1.15) * durMin);
  })();

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
    const timingMod = (wk?.workoutMods ?? []).find(m => isTimingMod(m.modReason) && m.name === w.n) as any;
    const suggestedType = timingMod?.newType as string | undefined;
    const suggestionLabel = timingMod?.suggestionLabel as string | undefined;
    const tssYesterday = timingMod?.tssYesterday as number | undefined;
    const newDistance = timingMod?.newDistance ?? w.d ?? '';
    const tssNote = tssYesterday ? ` (${tssYesterday} TSS yesterday)` : '';
    html += `<div style="padding:9px 12px;background:rgba(249,115,22,0.06);border:1px solid rgba(249,115,22,0.25);border-radius:var(--r-card);margin-bottom:10px">`;
    html += `<div style="font-size:11px;font-weight:600;color:#F97316;margin-bottom:3px">Suggestion — hard session yesterday${tssNote}</div>`;
    html += `<div style="font-size:12px;color:var(--c-muted);margin-bottom:8px">You trained hard yesterday. Consider ${suggestionLabel ?? 'an easier effort'} today, or move this session to a different day for full intensity.</div>`;
    if (suggestedType) {
      html += `<button class="plan-timing-accept" data-workout-name="${escapeHtml(w.n)}" data-day="${w.dayOfWeek ?? ''}" data-new-type="${escapeHtml(suggestedType)}" data-new-distance="${escapeHtml(newDistance)}" style="font-size:12px;font-weight:600;color:#F97316;background:rgba(249,115,22,0.1);border:1px solid rgba(249,115,22,0.3);border-radius:8px;padding:6px 12px;cursor:pointer">Apply: ${suggestionLabel ?? suggestedType} ↓</button>`;
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
      ? Math.round((garminActual.iTrimp * 100) / 15000)
      : dur > 0 ? Math.round(dur * (TL_PER_MIN[Math.round(rpeVal)] ?? 0.92)) : null;
    const statsArr: string[] = [];
    if (garminActual.distanceKm > 0.1) statsArr.push(formatKm(garminActual.distanceKm, _s.unitPref ?? 'km'));
    if (garminActual.avgPaceSecKm) statsArr.push(fmtPacePlan(garminActual.avgPaceSecKm, _s.unitPref ?? 'km'));
    if (garminActual.avgHR) statsArr.push(`HR ${garminActual.avgHR}`);
    statsArr.push(`${dur} min`);
    if (actualTSS != null) statsArr.push(`TSS ${actualTSS}`);
    if (garminActual.calories) statsArr.push(`${garminActual.calories} kcal`);
    const source = garminActual.garminId?.startsWith('strava-') ? 'Strava' : 'Garmin';
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
    // Don't pass plannedTSS for cross-training — activity-detail planned bar is
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

  // ── Workout description ───────────────────────────────────────────────────
  if (w.d && w.d.trim()) {
    const descHtml = escapeHtml(fmtDesc(w.d, _s.unitPref ?? 'km')).replace(/\n/g, '<br>');
    // Note: fmtDesc handles both km distances and M:SS/km pace strings
    html += `<div style="font-size:13px;color:var(--c-muted);line-height:1.6;margin-bottom:14px">${descHtml}</div>`;
  }

  // ── Planned vs Actual load ────────────────────────────────────────────────
  if (w.t && w.t !== 'rest') {
    // plannedTSS already computed at top of function

    // Actual TSS (already computed above when garminActual is present)
    const rpeForLoad = typeof rated[id] === 'number' ? (rated[id] as number) : (w.rpe || w.r || 5);
    const actualTSSForBars = garminActual
      ? (garminActual.iTrimp != null && garminActual.iTrimp > 0
        ? Math.round((garminActual.iTrimp * 100) / 15000)
        : Math.round((garminActual.durationSec / 60) * (TL_PER_MIN[Math.round(rpeForLoad)] ?? 0.92)))
      : null;

    const isCrossTraining = w.t === 'cross' || w.t === 'gym';

    if (garminActual && actualTSSForBars != null && plannedTSS > 0 && !isCrossTraining) {
      // Show planned vs actual comparison (running sessions only — cross-training
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
      // No actual data — show planned TSS + HR target if available
      html += `<div style="margin-bottom:14px">`;
      html += `<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:4px">Planned Load</div>`;
      html += `<div style="font-size:13px;color:var(--c-text)">~${plannedTSS} TSS</div>`;
      if (_hrTarget) {
        const hasStructure = (w.d || '').toLowerCase().includes('warm up');
        const hrLine = hasStructure
          ? `Expected HR — ${_hrTarget.zone} during effort · ${_hrTarget.min}–${_hrTarget.max} bpm`
          : `Expected HR — ${_hrTarget.zone} · ${_hrTarget.min}–${_hrTarget.max} bpm`;
        html += `<div style="font-size:11px;color:var(--c-muted);margin-top:3px">${hrLine}</div>`;
      }
      html += `</div>`;
    }
  }

  // ── Action buttons ────────────────────────────────────────────────────────
  const _isPastWeek = currentWeek != null && viewWeek < currentWeek;
  const _isSynced = !!garminActual;

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
      // Capacity test workout — different button set
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
        // Start Workout — primary CTA for running workouts
        html += `<button class="plan-detail-start-btn m-btn-primary" data-workout-id="${safeId}" data-week-num="${viewWeek}" style="width:100%;margin-bottom:8px;font-size:13px;padding:10px 0;text-align:center;justify-content:center;display:flex;align-items:center;gap:6px">
            <span style="width:10px;height:10px;background:white;clip-path:polygon(0 0,100% 50%,0 100%);display:inline-block;flex-shrink:0"></span>
            Start Workout</button>`;
        // Mark as Done + Skip — demoted to inline text links
        html += `<div style="display:flex;gap:12px;justify-content:center;margin-top:4px">`;
        html += `<button class="plan-action-mark-done" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-rpe="${rpe}" data-type="${w.t}" data-week-num="${viewWeek}" style="font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:4px 0">Mark as Done</button>`;
        html += `<span style="color:var(--c-border)">·</span>`;
        html += `<button class="plan-action-skip" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-type="${w.t}" data-rpe="${rpe}" data-desc="${safeDesc}" data-day="${w.dayOfWeek ?? 0}" data-week-num="${viewWeek}" style="font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:4px 0">Skip</button>`;
        html += `</div>`;
      } else if (w.t === 'gym') {
        html += `<button class="plan-action-mark-done m-btn-secondary" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-rpe="0" data-type="gym" data-week-num="${viewWeek}" style="width:100%;margin-bottom:8px;font-size:13px;padding:10px 0;text-align:center;display:block">Mark Done</button>`;
        html += `<button class="plan-action-skip m-btn-secondary" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-type="${w.t}" data-rpe="${rpe}" data-desc="${safeDesc}" data-day="${w.dayOfWeek ?? 0}" data-week-num="${viewWeek}" style="width:100%;font-size:12px;padding:8px 0;text-align:center;display:block;opacity:0.6">Skip</button>`;
      } else {
        html += `<button class="plan-action-mark-done m-btn-secondary" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-rpe="${rpe}" data-type="${w.t}" data-week-num="${viewWeek}" style="width:100%;margin-bottom:8px;font-size:13px;padding:10px 0;text-align:center;display:block">Mark Done</button>`;
        html += `<button class="plan-action-skip m-btn-secondary" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-type="${w.t}" data-rpe="${rpe}" data-desc="${safeDesc}" data-day="${w.dayOfWeek ?? 0}" data-week-num="${viewWeek}" style="width:100%;font-size:12px;padding:8px 0;text-align:center;display:block;opacity:0.6">Skip</button>`;
      }
    } else if (isDone) {
      html += `<button class="plan-action-unrate m-btn-secondary" data-workout-id="${escapeHtml(id)}" style="width:100%;font-size:12px;padding:8px 0;text-align:center;display:block;opacity:0.7">Unmark as Done</button>`;
    }
  } // end synced guard

  // ── Move to day ───────────────────────────────────────────────────────────
  const currentDay = w.dayOfWeek ?? 0;
  html += `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--c-border)">`;
  html += `<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:7px">Move to day</div>`;
  html += `<div style="display:flex;gap:4px;flex-wrap:wrap">`;
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((day, i) => {
    const isActive = i === currentDay;
    html += `<button class="plan-move-btn" data-workout-id="${escapeHtml(id)}" data-target-day="${i}" data-current-day="${currentDay}" style="padding:5px 8px;font-size:11px;font-weight:600;border-radius:5px;border:1px solid ${isActive ? 'var(--c-accent)' : 'var(--c-border)'};background:${isActive ? 'var(--c-accent)' : 'transparent'};color:${isActive ? 'white' : 'var(--c-black)'};cursor:pointer;opacity:${isActive ? '1' : '0.7'}">${day}</button>`;
  });
  html += `</div></div>`;

  html += `</div></div>`;
  return html;
}

// ─── Activity log section ─────────────────────────────────────────────────────

function buildActivityLog(wk: Week | undefined, viewWeek: number, currentWeek: number): string {
  if (!wk) return '';
  const s = getState();
  const actuals = wk.garminActuals || {};
  const adhocGarmin = (wk.adhocWorkouts || []).filter((w: any) => w.id?.startsWith('garmin-'));
  const garminMatched = wk.garminMatched || {};
  const pendingItems = (wk.garminPending || []).filter(p => garminMatched[p.garminId] === '__pending__');

  // Deduplicate: garmin-* keys in garminActuals that also exist in adhocGarmin are the same activity.
  // Count each activity once. Orphaned garmin-* actuals (adhoc removed via ×) are counted from actuals.
  const adhocIds = new Set(adhocGarmin.map((w: any) => w.id || ''));
  const dedupedActualKeys = Object.keys(actuals).filter(k => !(k.startsWith('garmin-') && adhocIds.has(k)));
  const totalItems = dedupedActualKeys.length + adhocGarmin.length + pendingItems.length;
  if (totalItems === 0) return '';

  const matchedCount = dedupedActualKeys.length + adhocGarmin.length;
  const _plannedBForLog = computePlannedSignalB(
    s.historicWeeklyTSS, s.ctlBaseline, wk.ph ?? 'base',
    s.athleteTierOverride ?? s.athleteTier, s.rw, undefined, undefined, s.sportBaselineByType,
  );
  const _carriedForLog = computeDecayedCarry(s.wks ?? [], wk.w ?? s.w, _plannedBForLog, s.planStartDate);
  const excessLoad = _plannedBForLog > 0 ? Math.round(getWeeklyExcess(wk, _plannedBForLog, s.planStartDate, _carriedForLog)) : 0;

  let h = `<div class="fade" style="margin:10px 16px 0;padding:14px 16px;${PLAN_CARD_STYLE};animation-delay:0.12s">`;

  // Header
  h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">`;
  h += `<div>`;
  h += `<span style="font-size:12px;font-weight:600;color:var(--c-black)">Activity Log</span>`;
  if (matchedCount > 0) {
    h += `<span style="font-size:11px;color:var(--c-muted);margin-left:8px">${matchedCount} matched`;
    if (excessLoad > 0) h += ` · +${excessLoad} excess TSS`;
    h += `</span>`;
  }
  h += `</div>`;
  if (viewWeek === currentWeek) {
    h += `<button id="plan-review-btn" style="font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:0;font-family:var(--f);font-weight:500">`;
    if (pendingItems.length > 0) h += `${pendingItems.length} pending · `;
    h += `Review <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle"><path d="M9 18l6-6-6-6"/></svg></button>`;
  }
  h += `</div>`;

  // Pending banner
  if (pendingItems.length > 0 && viewWeek === currentWeek) {
    h += `<div style="margin-bottom:8px;padding:10px 12px;border:1px solid var(--c-border-strong);border-radius:12px;display:flex;align-items:center;justify-content:space-between;gap:8px">`;
    h += `<div>`;
    h += `<div style="font-size:13px;font-weight:600;color:var(--c-black)">${pendingItems.length} activit${pendingItems.length === 1 ? 'y' : 'ies'} pending review</div>`;
    const types = [...new Set(pendingItems.map(p => p.appType || p.activityType))].slice(0, 3).join(', ');
    if (types) h += `<div style="font-size:11px;color:var(--c-muted);margin-top:2px">${types}</div>`;
    h += `</div>`;
    h += `<button id="plan-review-btn-2" style="font-size:12px;padding:7px 14px;flex-shrink:0;border-radius:10px;border:1px solid var(--c-border-strong);background:transparent;color:var(--c-black);font-weight:500;cursor:pointer;font-family:var(--f)">Review</button>`;
    h += `</div>`;
  }

  const excessGarminIds = new Set((wk.unspentLoadItems || []).map((u: any) => u.garminId));

  h += `<div style="padding:8px 0 4px">`;

  // Build set of adhoc garmin IDs so we can deduplicate garminActuals entries
  // that are also present as adhocWorkouts (created together by addAdhocWorkoutFromPending).
  const adhocGarminIds = new Set(adhocGarmin.map((w: any) => w.id || ''));

  // Collect all items into a single array with sortable timestamps, then render sorted by date.
  type LogEntry = { sortTime: number; html: string };
  const logEntries: LogEntry[] = [];

  // garminActuals entries: plan-slot matches show "Matched", orphaned garmin-* entries
  // (adhoc was removed via ×) show "Logged". Skip garmin-* entries that still have
  // a corresponding adhocWorkout — the adhoc loop renders those with correct Logged/Excess badge.
  for (const [workoutId, a] of Object.entries(actuals)) {
    if (workoutId.startsWith('garmin-') && adhocGarminIds.has(workoutId)) continue;
    const actual = a as any;
    const isAdhocOrphan = workoutId.startsWith('garmin-');
    const activityName = actual.displayName || actual.workoutName || workoutId;
    const slotName = !isAdhocOrphan && actual.workoutName && actual.workoutName !== actual.displayName ? actual.workoutName : null;
    const dur = Math.round(actual.durationSec / 60);
    const statsArr: string[] = [];
    if (actual.distanceKm > 0.1) statsArr.push(formatKm(actual.distanceKm, s.unitPref ?? 'km'));
    if (actual.avgPaceSecKm) statsArr.push(fmtPacePlan(actual.avgPaceSecKm, s.unitPref ?? 'km'));
    if (actual.avgHR) statsArr.push(`HR ${actual.avgHR}`);
    statsArr.push(`${dur} min`);
    const dateStr = actual.startTime ? new Date(actual.startTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

    const isExcess = isAdhocOrphan && excessGarminIds.has(workoutId.slice('garmin-'.length));
    const badgeLabel = isAdhocOrphan ? (isExcess ? 'Excess' : 'Logged') : 'Matched';
    const badgeHtml = `<span style="font-size:9px;font-weight:600;color:var(--c-muted);background:rgba(0,0,0,0.04);border:1px solid var(--c-border);border-radius:100px;padding:2px 7px">${badgeLabel}</span>`;

    let row = `<div class="m-list-item plan-act-open" data-workout-key="${escapeHtml(workoutId)}" data-week-num="${viewWeek}" style="cursor:pointer">`;
    row += `<div style="width:5px;height:5px;border-radius:50%;background:var(--c-faint);flex-shrink:0"></div>`;
    row += `<div style="flex:1;min-width:0">`;
    row += `<div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(activityName)}</div>`;
    const subParts = [...statsArr];
    if (dateStr) subParts.push(dateStr);
    if (slotName) subParts.push(`→ ${slotName}`);
    row += `<div style="font-size:11px;color:var(--c-muted);margin-top:1px">${subParts.join(' · ')}</div>`;
    row += `</div>`;
    row += `<div style="display:flex;align-items:center;gap:6px">`;
    row += badgeHtml;
    row += `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
    if (actual.garminId) {
      row += `<button class="plan-remove-garmin" data-garmin-id="${escapeHtml(actual.garminId)}" style="font-size:20px;line-height:1;color:var(--c-faint);background:none;border:none;cursor:pointer;padding:0">×</button>`;
    }
    row += `</div>`;
    row += `</div>`;

    const sortTime = actual.startTime ? new Date(actual.startTime).getTime() : 0;
    logEntries.push({ sortTime, html: row });
  }

  // Adhoc garmin/strava activities — logged only or excess load
  for (const w of adhocGarmin) {
    const wAny = w as any;
    const rawId = (w.id || '').slice('garmin-'.length);
    // Stats come from fields stored directly on the adhoc workout by addAdhocWorkoutFromPending.
    const name = wAny.n || 'Activity';
    const dur = wAny.garminDurationMin || wAny.dur || 0;
    const km = wAny.garminDistKm || wAny.km || wAny.distanceKm || 0;
    const avgHR = wAny.garminAvgHR;
    const paceSecPerKm = wAny.garminDistKm > 0.1 && wAny.garminDurationMin > 0
      ? Math.round((wAny.garminDurationMin * 60) / wAny.garminDistKm)
      : null;
    const isExcess = excessGarminIds.has(rawId);
    const statsArr: string[] = [];
    if (km > 0.1) statsArr.push(typeof km === 'number' ? formatKm(km, s.unitPref ?? 'km') : formatKm(parseFloat(km), s.unitPref ?? 'km'));
    if (paceSecPerKm) statsArr.push(fmtPacePlan(paceSecPerKm, s.unitPref ?? 'km'));
    if (avgHR) statsArr.push(`HR ${avgHR}`);
    if (dur > 0) statsArr.push(`${dur} min`);
    const adhocTime = wAny.garminTimestamp || wAny.startTime;
    const adhocDateStr = adhocTime ? new Date(adhocTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
    if (adhocDateStr) statsArr.push(adhocDateStr);

    const tagLabel = isExcess ? 'Excess' : 'Logged';
    const tagHtml = `<span style="font-size:9px;font-weight:600;color:var(--c-muted);background:rgba(0,0,0,0.04);border:1px solid var(--c-border);border-radius:100px;padding:2px 7px">${tagLabel}</span>`;

    let row = `<div class="m-list-item plan-adhoc-open" data-adhoc-id="${escapeHtml(w.id || '')}" data-week-num="${viewWeek}" style="cursor:pointer">`;
    row += `<div style="width:5px;height:5px;border-radius:50%;background:var(--c-faint);flex-shrink:0"></div>`;
    row += `<div style="flex:1;min-width:0">`;
    row += `<div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</div>`;
    if (statsArr.length) row += `<div style="font-size:11px;color:var(--c-muted);margin-top:1px">${statsArr.join(' · ')}</div>`;
    row += `</div>`;
    row += `<div style="display:flex;align-items:center;gap:6px">`;
    row += tagHtml;
    row += `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
    row += `</div>`;
    row += `</div>`;

    const sortTime = adhocTime ? new Date(adhocTime).getTime() : 0;
    logEntries.push({ sortTime, html: row });
  }

  // Pending items as individual rows — ensures unassigned / not-yet-reviewed activities
  // are always visible in the log (not just as an aggregate banner count).
  for (const p of pendingItems) {
    const dur = Math.round(p.durationSec / 60);
    const distKm = (p.distanceM ?? 0) / 1000;
    const statsArr: string[] = [];
    if (distKm > 0.1) statsArr.push(formatKm(distKm, s.unitPref ?? 'km'));
    if (p.avgPaceSecKm) statsArr.push(fmtPacePlan(p.avgPaceSecKm, s.unitPref ?? 'km'));
    if (p.avgHR) statsArr.push(`HR ${p.avgHR}`);
    if (dur > 0) statsArr.push(`${dur} min`);
    const dateStr = p.startTime ? new Date(p.startTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
    if (dateStr) statsArr.push(dateStr);
    const name = formatActivityType(p.activityType);

    let row = `<div class="m-list-item" style="cursor:pointer">`;
    row += `<div style="width:5px;height:5px;border-radius:50%;background:var(--c-faint);flex-shrink:0"></div>`;
    row += `<div style="flex:1;min-width:0">`;
    row += `<div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</div>`;
    if (statsArr.length) row += `<div style="font-size:11px;color:var(--c-muted);margin-top:1px">${statsArr.join(' · ')}</div>`;
    row += `</div>`;
    row += `<div style="display:flex;align-items:center;gap:6px">`;
    row += `<span style="font-size:9px;font-weight:600;color:var(--c-muted);background:rgba(0,0,0,0.04);border:1px solid var(--c-border);border-radius:100px;padding:2px 7px">Pending</span>`;
    row += `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
    row += `</div>`;
    row += `</div>`;

    const sortTime = p.startTime ? new Date(p.startTime).getTime() : 0;
    logEntries.push({ sortTime, html: row });
  }

  // Sort all entries by date (oldest first)
  logEntries.sort((a, b) => b.sortTime - a.sortTime);
  for (const entry of logEntries) h += entry.html;

  h += `</div></div>`;
  return h;
}

// ─── Calendar strip ───────────────────────────────────────────────────────────

// ─── Workout cards ────────────────────────────────────────────────────────────

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
      // Rest day row — also a drop target
      dayFirstCardEmitted.add(dayIdx);
      cards.push(`
        <div id="plan-day-${dayIdx}" class="plan-drop-zone" data-day-of-week="${dayIdx}" style="display:flex;align-items:center;padding:15px 18px;border-top:1px solid var(--c-border);transition:background 0.15s">
          <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);width:36px">${DAY_SHORT[dayIdx]}</span>
          <span class="plan-drop-label" style="font-size:12px;color:var(--c-faint);letter-spacing:0.02em">Rest</span>
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
      const isPast = viewWeek < s.w || (isCurrentWeek && !todayInRange) || (isCurrentWeek && todayInRange && dayIdx < actualToday);
      const isRest = w.t === 'rest' || w.n?.toLowerCase().includes('rest');

      if (isRest) {
        const dayAnchorId = !dayFirstCardEmitted.has(dayIdx) ? `id="plan-day-${dayIdx}" ` : '';
        dayFirstCardEmitted.add(dayIdx);
        cards.push(`
          <div ${dayAnchorId}class="plan-drop-zone" data-day-of-week="${dayIdx}" style="display:flex;align-items:center;padding:15px 18px;border-top:1px solid var(--c-border);transition:background 0.15s">
            <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);width:36px">${DAY_SHORT[dayIdx]}</span>
            <span class="plan-drop-label" style="font-size:12px;color:var(--c-faint);letter-spacing:0.02em">Rest</span>
          </div>
        `);
        continue;
      }

      // Garmin actual — direct lookup by workout slot ID (needed for isDone)
      const garminAct: any = (wk?.garminActuals as any)?.[id] || null;
      const isDone = (typeof ratingVal === 'number' && ratingVal > 0) || !!garminAct;
      const isSkipped = ratingVal === 'skip';

      // Issue 1: show actual activity name when matched (e.g. "Swimming" not "General Sport 1")
      const name = garminAct?.displayName || w.n || 'Workout';
      const isReduced = !isDone && !isSkipped && (w as any).status === 'reduced' && !isTimingMod((w as any).modReason);
      const distKm = w.km || w.distanceKm;
      const durationMin = w.dur;
      let valueStr = distKm ? (typeof distKm === 'number' ? formatKm(distKm, s.unitPref ?? 'km') : formatKm(parseFloat(distKm), s.unitPref ?? 'km'))
        : durationMin ? `${Math.round(durationMin)} min`
          : '';
      // For reduced workouts, parse new distance from w.d ("5.2km (was 8km)") — w.km is not updated by mods
      if (isReduced && (w as any).d) {
        const reducedKm = parseFloat((w as any).d);
        if (!isNaN(reducedKm)) valueStr = formatKm(reducedKm, s.unitPref ?? 'km');
      }

      // Replacement detection
      const isReplaced = (w as any).status === 'replaced';
      const replacedByAdhoc = isReplaced
        ? (wk?.adhocWorkouts || []).find((a: any) => a.dayOfWeek === w.dayOfWeek && !(a.id || '').startsWith('garmin-'))
        : null;

      // Status label (neutral text — colour reserved for Today only)
      let statusLabel: string;
      if (isDone) statusLabel = garminAct ? 'Logged' : 'Done';
      else if (isReplaced) statusLabel = 'Replaced';
      else if ((w as any).status === 'holiday') statusLabel = 'Holiday';
      else if ((w as any).id?.startsWith('holiday-') || (w as any).id?.startsWith('adhoc-')) statusLabel = 'Added';
      else if (isReduced) statusLabel = 'Adjusted';
      else if (isSkipped) statusLabel = 'Skipped';
      else if (isToday) statusLabel = 'Today';
      else if (isPast) statusLabel = 'Missed';
      else statusLabel = 'Upcoming';

      // Visual hierarchy: Today = terracotta accent, Logged = solid muted, Missed = faint + italic
      const dayLabelColor = isToday
        ? TODAY_ACCENT
        : (isDone ? 'var(--c-black)' : (isPast && !isDone && !isSkipped ? 'var(--c-faint)' : 'var(--c-faint)'));
      const statusLabelColor = isToday
        ? TODAY_ACCENT
        : isDone ? '#34C759'
        : (isPast && !isDone && !isSkipped) ? '#FF9500'
        : 'var(--c-faint)';
      const statusLabelWeight = isDone || (isPast && !isDone && !isSkipped) ? '600' : '400';
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
        actMatchRow = `<div class="plan-act-open" data-workout-key="${escapeHtml(id)}" data-week-num="${viewWeek}" style="display:flex;align-items:center;gap:5px;margin-top:3px;cursor:pointer">
          <span style="font-size:11px;color:var(--c-muted)">${matchName ? escapeHtml(matchName) + ' · ' : ''}${source}${matchStats.length ? ' · ' + matchStats.join(' · ') : ''}</span>
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
      const isUserGenerated = (w as any).id?.startsWith('holiday-') || (w as any).id?.startsWith('adhoc-');
      const deleteBtn = isUserGenerated && !isDone
        ? `<button class="plan-adhoc-delete-btn" data-workout-id="${id}" data-week-num="${viewWeek}"
            style="padding:7px 10px;font-size:11px;border-radius:8px;border:1px solid var(--c-border);
                   background:transparent;color:var(--c-muted);cursor:pointer;font-family:var(--f)">Remove</button>`
        : '';
      const rightContent = showHeaderStart
        ? `<div style="display:flex;gap:6px;align-items:center">${deleteBtn}<button class="plan-start-btn m-btn-primary" data-workout-id="${id}" data-week-num="${viewWeek}" style="padding:7px 14px;font-size:12px">
            <span style="width:10px;height:10px;background:white;clip-path:polygon(0 0,100% 50%,0 100%);display:inline-block;flex-shrink:0"></span>
            Start
          </button></div>`
        : isDone
          ? `<div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:13px;font-weight:500;color:var(--c-muted)">${valueStr}</span>
            <span class="plan-view-btn" data-workout-id="${id}" data-week="${viewWeek}" style="opacity:0.3;cursor:pointer;display:flex;align-items:center">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </span>
          </div>`
          : valueStr
            ? `<div style="display:flex;align-items:center;gap:10px">
            ${undoAdjBtn}
            <span style="font-size:13px;font-weight:400;color:var(--c-muted)">${valueStr}</span>
            <span class="plan-view-btn" data-workout-id="${id}" data-week="${viewWeek}" style="opacity:0.25;cursor:pointer;display:flex;align-items:center">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </span>
          </div>`
            : undoAdjBtn ? `<div style="display:flex;align-items:center">${undoAdjBtn}</div>` : '';

      // Only first card of each day gets the scroll-anchor ID (no duplicate IDs)
      const dayAnchorId = !dayFirstCardEmitted.has(dayIdx) ? `id="plan-day-${dayIdx}" ` : '';
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
        if (newDesc) {
          lines.push(`<div style="font-size:12px;color:var(--c-text, #333);margin-top:2px">${fmtDesc(newDesc, cardUnitPref)}</div>`);
        }
        if (origLabel) {
          lines.push(`<div style="font-size:11px;color:var(--c-faint);margin-top:1px">Original plan: ${fmtDesc(origLabel, cardUnitPref)}</div>`);
        }
        reducedBadge = lines.join('');
      }

      const _autoReduceNote = (w as any).autoReduceNote as string | undefined;
      const _isAutoMod = _isAutoMod_pre && !isDone && !!_autoReduceNote;
      const autoReduceRow = _isAutoMod
        ? `<div style="padding:6px 18px 10px;border-top:1px dashed var(--c-border);display:flex;align-items:center;justify-content:space-between;gap:8px">
            <span style="font-size:11px;color:var(--c-muted)">${escapeHtml(_autoReduceNote)}</span>
            <button class="plan-auto-undo-btn" data-workout-id="${escapeHtml(id)}" style="font-size:11px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:0;white-space:nowrap;flex-shrink:0;text-decoration:underline;text-underline-offset:2px">Undo</button>
          </div>`
        : '';

      const expandDetail = buildWorkoutExpandedDetail(w, wk, viewWeek, s.w);
      cards.push(`
        <div ${dayAnchorId}class="plan-workout-card" data-workout-id="${id}" data-day-of-week="${dayIdx}" draggable="true" style="border-top:1px solid var(--c-border);${borderLeft}">
          <div class="plan-card-header" style="display:flex;align-items:center;padding:${headerPad};gap:12px;cursor:pointer">
            <div style="width:36px;flex-shrink:0">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:${dayLabelColor};line-height:1.2">${DAY_SHORT[dayIdx]}</div>
              <div style="font-size:9px;font-weight:${statusLabelWeight};color:${statusLabelColor};margin-top:1px">${statusLabel}</div>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:15px;font-weight:400;letter-spacing:-0.01em;opacity:${nameOpacity};text-decoration:${nameDecoration};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
              ${actMatchRow}
              ${isTimingMod((w as any).modReason) && !isDone ? `<div style="margin-top:3px"><span style="font-size:10px;font-weight:500;color:var(--c-muted);letter-spacing:0.01em">Suggestion — hard session yesterday</span></div>` : ''}
              ${reducedBadge}
            </div>
            <div style="flex-shrink:0;display:flex;align-items:center;gap:6px">
              ${rightContent}
              <svg class="plan-card-chevron" style="transition:transform 0.2s;flex-shrink:0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
            </div>
          </div>
          ${autoReduceRow}
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
  return `<button id="plan-wrap-up-btn" style="padding:8px 18px;border-radius:100px;border:none;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);cursor:pointer;font-size:13px;font-weight:600;color:#0F172A;font-family:var(--f);box-shadow:0 1px 4px rgba(0,0,0,0.06)">Wrap up week</button>`;
}

// ─── Injury UI ───────────────────────────────────────────────────────────────

/**
 * Header button — "Check-in" when healthy, "In Recovery" pill when injured.
 * Only shown on the current week.
 */
function buildInjuryHeaderBtn(injured: boolean, isCurrentWeek: boolean): string {
  if (!isCurrentWeek) return '';
  if (injured) {
    return `<button id="plan-injury-update" style="padding:8px 18px;border-radius:100px;border:none;background:rgba(234,88,12,0.12);backdrop-filter:blur(8px);cursor:pointer;font-size:13px;font-weight:600;color:#92400E;font-family:var(--f);box-shadow:0 1px 4px rgba(0,0,0,0.06)">In Recovery</button>`;
  }
  return `<button id="plan-checkin-btn" style="padding:8px 18px;border-radius:100px;border:none;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);cursor:pointer;font-size:13px;font-weight:600;color:#0F172A;font-family:var(--f);box-shadow:0 1px 4px rgba(0,0,0,0.06)">Check-in</button>`;
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
 * Full injury status card — shown at the top of the plan card list when injury is active.
 */
function buildInjuryBanner(): string {
  if (!isInjuryActive()) return '';

  const inj = getInjuryStateForDisplay();
  const protocol = INJURY_PROTOCOLS[inj.type];
  const displayName = protocol?.displayName || inj.type;

  // Phase label (text only — no colour)
  const phaseLabels: Record<string, string> = {
    acute: 'Acute — Rest',
    rehab: 'Rehabilitation',
    test_capacity: 'Capacity Testing',
    return_to_run: 'Return to Run',
    graduated_return: 'Graduated Return',
    resolved: 'Resolved',
  };
  const phaseLabelText = phaseLabels[inj.injuryPhase] || 'Rehabilitation';

  // Can-run label (text only — opacity-coded by severity)
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
          <div style="font-size:17px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${displayName}</div>
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
 * Handle a morning pain response — persists the entry, updates pain level,
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

  // Inline feedback — no full re-render
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
 * Optional fitness check-in panel — shown on post-deload weeks for continuous mode users.
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

  // Not started — show prompt to open overlay
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
 * Compact recovery status row — shown at the top of the plan card list.
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
    // No data — invite to log
    return `
      <div ${base}var(--c-border);background:var(--c-surface)">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="width:8px;height:8px;border-radius:50%;background:rgba(0,0,0,0.18);flex-shrink:0"></span>
          <span style="font-size:13px;color:var(--c-muted)">Sleep not logged yet</span>
        </div>
        <button id="plan-recovery-log"
          style="font-size:12px;font-weight:600;color:var(--c-accent);background:none;border:none;cursor:pointer;padding:0">
          Log sleep →
        </button>
      </div>
    `;
  }

  const c = cfg[level] || cfg.green;

  if (level === 'green' || alreadyPrompted || !shouldPrompt) {
    // Logged + OK (or already acted on today) — quiet confirmation
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
 * Compact card below the status pill — always visible when there is any history.
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
          style="font-size:12px;font-weight:600;color:var(--c-accent);background:none;border:none;cursor:pointer;padding:0">
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
    <div style="width:100%;max-width:480px;background:var(--c-bg);border-radius:20px 20px 0 0;
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
 * Bottom-sheet modal shown when recovery is low — offers to adjust today's run.
 * Exported so main.ts orchestration can call it after Garmin physiology sync.
 */
export function showRecoveryAdjustModal(entry: RecoveryEntry): void {
  const s = getState();
  const history: RecoveryEntry[] = (s as any).recoveryHistory || [];
  const { level, reasons } = computeRecoveryStatus(entry, history);

  const wk = s.wks[s.w - 1];
  if (!wk) return;

  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
    getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus,
  );

  if (wk.workoutMods && wk.workoutMods.length > 0) {
    for (const mod of wk.workoutMods) {
      const w = workouts.find((wo: any) => wo.n === mod.name && (mod.dayOfWeek == null || wo.dayOfWeek === mod.dayOfWeek));
      if (w) {
        if (!isTimingMod(mod.modReason)) {
          if (mod.originalDistance != null) (w as any).originalDistance = mod.originalDistance;
          (w as any).status = mod.status;
          (w as any).d = mod.newDistance;
          if (mod.newType) (w as any).t = mod.newType;
        }
      }
    }
  }

  const jsDay = new Date().getDay();
  const todayIdx = jsDay === 0 ? 6 : jsDay - 1;

  const runWorkouts = workouts.filter((w: any) =>
    w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest' && w.status !== 'replaced'
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
                <div style="font-size:12px;color:var(--c-muted);margin-top:2px">Ignore pace targets — just get the run in</div>
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
          <p style="font-size:13px;color:var(--c-muted);margin:0 0 16px">No run scheduled today — no adjustments needed.</p>
          <button id="ra-dismiss" class="m-btn-secondary" style="width:100%">Dismiss</button>
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
  // Only count items whose date falls BEFORE this week's start — items added via
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

// ─── Adjust week row ─────────────────────────────────────────────────────────

function buildAdjustWeekRow(wk: Week | undefined, s: SimulatorState): string {
  const isCurrentWeek = wk?.w === s.w;
  if (!isCurrentWeek) return '';

  const _plannedB = wk ? computePlannedSignalB(
    s.historicWeeklyTSS, s.ctlBaseline, wk.ph ?? 'base',
    s.athleteTierOverride ?? s.athleteTier, s.rw, undefined, undefined, s.sportBaselineByType,
  ) : 0;
  const _carriedForStrip = computeDecayedCarry(s.wks ?? [], s.w, _plannedB, s.planStartDate);
  const _excessThisWeek = wk ? getWeeklyExcess(wk, _plannedB, s.planStartDate) : 0;
  const _excess = wk ? getWeeklyExcess(wk, _plannedB, s.planStartDate, _carriedForStrip) : 0;
  const _hasPendingExcess = _excess > 15;
  const carryPortion = Math.round(_carriedForStrip);

  // Only show when total effective load exceeds planned — carry alone (under target) is informational only.
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

// buildWeekOverview removed — pills now rendered inline in header

// ─── Main render ─────────────────────────────────────────────────────────────

function getPlanHTML(s: SimulatorState, viewWeek: number): string {
  const wk = s.wks?.[viewWeek - 1];
  const rated = wk?.rated ?? {};
  const isCurrentWeek = viewWeek === s.w;

  // Get workouts for this week — must match activity-review.ts call exactly so workout IDs align
  const workouts = wk
    ? generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
      null, s.recurringActivities,
      s.onboarding?.experienceLevel, undefined, s.pac?.e, viewWeek, s.tw, s.v, s.gs,
      getTrailingEffortScore(s.wks, viewWeek), wk.scheduledAcwrStatus, (wk as any).forceDeload,
    )
    : [];

  // Merge user-generated sessions (holiday or adhoc) into the workout list so they render as cards
  if (wk?.adhocWorkouts) {
    for (const aw of wk.adhocWorkouts) {
      if ((aw.id || '').startsWith('holiday-') || (aw.id || '').startsWith('adhoc-')) {
        workouts.push(aw);
      }
    }
  }

  // Apply mods
  if (wk?.workoutMods) {
    for (const mod of wk.workoutMods) {
      // Timing mods are created after applying workoutMoves, so their dayOfWeek is
      // the moved day — but workouts still have default days here. Match by name only.
      const w = isTimingMod(mod.modReason)
        ? workouts.find((wo: any) => wo.n === mod.name)
        : workouts.find((wo: any) => wo.n === mod.name && (mod.dayOfWeek == null || wo.dayOfWeek === mod.dayOfWeek));
      if (w) {
        (w as any).modReason = mod.modReason;
        if (mod.autoReduceNote != null) (w as any).autoReduceNote = mod.autoReduceNote;
        if (!isTimingMod(mod.modReason)) {
          // Non-timing mods: apply distance/type/status changes
          if (mod.originalDistance != null) (w as any).originalDistance = mod.originalDistance;
          (w as any).d = mod.newDistance;
          (w as any).status = mod.status;
          if (mod.newType) (w as any).t = mod.newType;
          if (mod.newRpe != null) (w as any).rpe = mod.newRpe;
        }
        // Timing mods are suggestions only — workout distance/type/status unchanged
      }
    }
  }

  // Apply day moves (drag-and-drop reorder)
  if (wk?.workoutMoves) {
    for (const [workoutId, newDay] of Object.entries(wk.workoutMoves)) {
      const w = workouts.find((wo: any) => (wo.id || wo.n) === workoutId);
      if (w) (w as any).dayOfWeek = newDay;
    }
  }

  // Apply illness modifications in memory (render-time only — not persisted to state)
  const _illness = (s as any).illnessState;
  if (_illness?.active && isCurrentWeek) {
    applyIllnessMods(workouts, _illness.severity);
  }

  // Apply holiday modifications in memory (render-time only)
  // Only for active holidays where today >= startDate (not future scheduled holidays)
  // Also verify endDate hasn't passed — prevents stale state from applying mods
  const _holiday = s.holidayState;
  const _today = new Date().toISOString().split('T')[0];
  if (_holiday?.active && _today >= _holiday.startDate && _today <= _holiday.endDate
      && s.planStartDate && isWeekInHoliday(viewWeek, s.planStartDate, _holiday)) {
    const holidayDays = getHolidayDaysForWeek(viewWeek, s.planStartDate, _holiday);
    applyHolidayMods(workouts, _holiday.canRun, holidayDays);
  }

  // Apply post-holiday bridge scaling (render-time only)
  if (wk) {
    applyBridgeMods_renderTime(workouts, wk);
  }

  // Populate workout lookup for Start button click handlers
  _workoutLookup = new Map();
  for (const w of workouts) {
    _workoutLookup.set(w.id || w.n, { n: w.n || '', d: w.d || '' });
  }

  const dateRange = fmtWeekRange(s.planStartDate, viewWeek);
  const phase = wk?.ph ? phaseLabel(wk.ph) : '';

  // Running km — planned vs actual
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

  // Week load — Signal B (full physiological, all sports) for all weeks
  // Using Signal B everywhere so the bar always matches what the breakdown sheet shows.
  const _weekRawTSS = wk ? Math.round(computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate)) : 0;
  const _plannedTSS = computePlannedSignalB(
    s.historicWeeklyTSS,
    s.ctlBaseline,
    wk?.ph ?? 'base',
    s.athleteTierOverride ?? s.athleteTier,
    s.rw,
    undefined,
    undefined,
    s.sportBaselineByType,
  );
  // Include decayed carry from previous weeks in the effective total
  const _weekCarry = isCurrentWeek ? computeDecayedCarry(s.wks ?? [], s.w, _plannedTSS, s.planStartDate) : 0;
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
  const _nonRunTypes = ['cross', 'cross_training', 'strength', 'rest', 'capacity_test', 'gym'];
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

  const canGoBack = viewWeek > 1;
  const canGoForward = viewWeek < s.tw;
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
  const _phaseBg: Record<string, { top: string; mid: string }> = {
    base:  { top: '#C5DFF8', mid: '#E3F0FA' },   // cool blue sky
    build: { top: '#F0D9C4', mid: '#F5E8DC' },   // warm amber
    peak:  { top: '#F0C4C4', mid: '#F5DCDC' },   // warm rose
    taper: { top: '#C5DFF8', mid: '#E3F0FA' },   // cool blue (same as physiology)
  };
  const _pb = _phaseBg[wk?.ph ?? 'base'] ?? _phaseBg.base;

  // Design tokens — same as physiology page
  const _TM = '#0F172A';
  const _TS = '#64748B';
  const _TL = '#94A3B8';
  const _BG = '#FAF9F6';

  return `
    <style>
      #plan-view { box-sizing:border-box; }
      #plan-view *, #plan-view *::before, #plan-view *::after { box-sizing:inherit; }
      @keyframes planFloat { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .plan-fade { opacity:0; animation:planFloat 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      @keyframes barGrow { from { width:0% } }
      .m-prog-fill { animation:barGrow 0.8s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="plan-view" style="position:relative;min-height:100vh;background:${_BG};font-family:var(--f);overflow-x:hidden">

      <!-- Background — full-page gradient, phase-tinted, fading to cream -->
      <div style="position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;pointer-events:none;z-index:0">
        <div style="position:absolute;inset:0;background:linear-gradient(180deg, ${_pb.top} 0%, ${_pb.mid} 15%, #F0F7FC 35%, #F5F8FB 55%, ${_BG} 80%)"></div>
        <svg style="position:absolute;top:0;left:0;width:100%;height:600px" viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="plBlur"><feGaussianBlur stdDeviation="20"/></filter>
            <filter id="plSoft"><feGaussianBlur stdDeviation="6"/></filter>
          </defs>
          <ellipse cx="200" cy="100" rx="100" ry="70" fill="rgba(255,255,255,0.5)" filter="url(#plSoft)" opacity="0.6"/>
          <ellipse cx="80" cy="180" rx="60" ry="25" fill="white" filter="url(#plBlur)" opacity="0.35"/>
          <ellipse cx="340" cy="160" rx="50" ry="20" fill="white" filter="url(#plBlur)" opacity="0.25"/>
          <path d="M-40,280 Q60,240 150,265 T320,245 T440,270 L440,600 L-40,600 Z" fill="rgba(255,255,255,0.25)" filter="url(#plSoft)"/>
          <path d="M-20,350 Q100,330 220,345 T440,335 L440,600 L-20,600 Z" fill="rgba(255,255,255,0.15)"/>
        </svg>
      </div>

      <div style="position:relative;z-index:10;padding-bottom:48px">

        <!-- Header bar: nav + profile -->
        <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            ${navBtn('prev', canGoBack)}
            ${navBtn('next', canGoForward)}
          </div>
          <button id="plan-account-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);
            display:flex;align-items:center;justify-content:center;
            font-size:12px;font-weight:600;color:${_TM};font-family:var(--f);
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
          ">${initials || 'Me'}</button>
        </div>

        <!-- Hero: Week + phase + date + actions — all one block -->
        <div class="plan-fade" style="animation-delay:0.06s;text-align:center;padding:20px 20px 0">
          <div style="font-size:48px;font-weight:700;color:${_TM};letter-spacing:-0.03em;line-height:1">
            Week ${viewWeek}<span style="font-weight:300;color:${_TS}"> / ${s.tw}</span>
          </div>
          ${wk?.ph ? `<div style="font-size:17px;font-weight:700;color:${_TM};margin-top:10px;letter-spacing:-0.01em">${phaseLabel(wk.ph)}</div>` : ''}
          ${dateRange ? `<div style="font-size:14px;font-weight:500;color:${_TS};margin-top:4px">${dateRange}</div>` : ''}
          ${viewWeek < s.w ? `<div style="margin-top:8px"><button id="plan-jump-current" style="background:none;border:none;padding:0;font-size:13px;font-weight:600;color:${_TS};cursor:pointer;font-family:var(--f)">Go to current week \u2192</button></div>` : ''}

          <!-- Action buttons — part of the hero block -->
          <div style="display:flex;justify-content:center;gap:8px;margin-top:18px;flex-wrap:wrap">
            ${isCurrentWeek ? `<button id="plan-coach-btn" style="padding:8px 18px;border-radius:100px;border:none;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);cursor:pointer;font-size:13px;font-weight:600;color:${_TM};font-family:var(--f);box-shadow:0 1px 4px rgba(0,0,0,0.06)">Coach</button>` : ''}
            ${buildInjuryHeaderBtn(injured, isCurrentWeek)}
            ${_wrapBtn}
            ${isCurrentWeek && s.w > 1 ? `<button id="plan-review-week-btn" style="padding:8px 18px;border-radius:100px;border:none;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);cursor:pointer;font-size:13px;font-weight:600;color:${_TM};font-family:var(--f);box-shadow:0 1px 4px rgba(0,0,0,0.06)">Review past week</button>` : ''}
            ${viewWeek === s.w ? `<button id="plan-generate-session" style="padding:8px 18px;border-radius:100px;border:none;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);cursor:pointer;font-size:13px;font-weight:600;color:${_TM};font-family:var(--f);box-shadow:0 1px 4px rgba(0,0,0,0.06)">+ Add session</button>` : ''}
          </div>
        </div>

        <!-- This Week progress (current week only) -->
        ${isCurrentWeek ? `<div class="plan-fade" style="animation-delay:0.12s;margin-top:20px">${buildProgressBars(s)}</div>` : (weekLoadBar || weekKmBar ? `
        <div class="plan-fade" style="animation-delay:0.12s;margin:20px 16px 0;padding:14px 16px;${PLAN_CARD_STYLE}">
          ${weekLoadBar}
          ${weekKmBar}
        </div>` : '')}

        <!-- Workout card list -->
        <div id="plan-card-list" style="padding:12px 0 16px;${isFutureWeek ? 'opacity:0.75' : ''}">
          ${isFutureWeek ? `<div class="plan-fade" style="animation-delay:0.16s;margin:4px 16px 8px;padding:12px 15px;${PLAN_CARD_STYLE};font-size:13px;font-weight:500;color:${_TS};line-height:1.5">Draft. Final workouts depend on the preceding week's performance.</div>` : ''}
          ${buildCarryOverCard(wk)}
          ${buildKmNudgeCard(wk, s, workouts)}
          ${buildAdjustWeekRow(wk, s)}
          ${buildInjuryBanner()}
          ${buildIllnessBanner()}
          ${buildHolidayBannerPlan(s)}
          ${buildMorningPainCheck()}
          ${buildBenchmarkPanel(s)}
          <div class="plan-fade" style="animation-delay:0.18s;margin:10px 16px 0;${PLAN_CARD_STYLE};overflow:hidden">
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
    import('./load-taper-view').then(({ renderLoadTaperView }) => renderLoadTaperView(viewWeek, 'plan'));
  });

  // Km bar → run breakdown sheet (compact bars on past/future weeks)
  document.getElementById('plan-km-bar-row')?.addEventListener('click', () => {
    showRunBreakdownSheet(s, viewWeek);
  });

  // This Week card (from buildProgressBars on current week) — whole card → Load & Taper
  document.getElementById('this-week-card')?.addEventListener('click', () => {
    import('./load-taper-view').then(({ renderLoadTaperView }) => renderLoadTaperView(viewWeek, 'plan'));
  });

  // (Week overview toggle removed — pills now inline)

  // Coach button
  document.getElementById('plan-coach-btn')?.addEventListener('click', () => openCoachModal());

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

  // Week navigation
  document.getElementById('plan-week-prev')?.addEventListener('click', () => {
    if (viewWeek > 1) {
      _viewWeek = viewWeek - 1;
      renderPlanView();
    }
  });
  document.getElementById('plan-week-next')?.addEventListener('click', () => {
    if (viewWeek < s.tw) {
      _viewWeek = viewWeek + 1;
      renderPlanView();
    }
  });

  // Jump to current week (shown only when viewing a past week)
  document.getElementById('plan-jump-current')?.addEventListener('click', () => {
    _viewWeek = null;
    renderPlanView();
  });

  // Edit week button (shown only on current week)
  // Review past week button — fires week-end debrief for the PREVIOUS week
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

  // Benchmark panel — open overlay or trigger auto-show
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

  // Keyboard arrow keys for week navigation on web
  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' && viewWeek > 1) {
      _viewWeek = viewWeek - 1;
      document.removeEventListener('keydown', keyHandler);
      renderPlanView();
    } else if (e.key === 'ArrowRight' && viewWeek < s.tw) {
      _viewWeek = viewWeek + 1;
      document.removeEventListener('keydown', keyHandler);
      renderPlanView();
    }
  };
  document.addEventListener('keydown', keyHandler);

  // Start button (header + expanded detail) — look up workout from module-level lookup
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
      const el = btn as HTMLElement;
      const wId = el.dataset.workoutId || '';
      const name = el.dataset.name || '';
      const rpe = parseInt(el.dataset.rpe || '5', 10);
      const type = el.dataset.type || 'easy';
      const weekNum = el.dataset.weekNum ? parseInt(el.dataset.weekNum, 10) : undefined;
      rate(wId, name, rpe, rpe, type, false, undefined, weekNum);
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
      skip(wId, name, type, false, 0, desc, rpe, day, '', weekNum);
      renderPlanView();
    });
  });

  document.querySelectorAll('.plan-action-unrate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLElement;
      const wId = el.dataset.workoutId || '';
      const ms = getMutableState();
      const wk = ms.wks?.[ms.w - 1];
      if (!wk) return;
      delete wk.rated[wId];
      if (wk.garminActuals?.[wId]) {
        const gId = wk.garminActuals[wId].garminId;
        delete wk.garminActuals[wId];
        if (gId && wk.garminMatched?.[gId]) wk.garminMatched[gId] = '__pending__';
      }
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
        getTrailingEffortScore(s2.wks, s2.w), wk2.scheduledAcwrStatus,
      );
      // Apply existing mods so distances reflect current state
      for (const mod of (wk2.workoutMods ?? [])) {
        const w = nudgeWorkouts.find((wo: any) => wo.n === mod.name && (mod.dayOfWeek == null || wo.dayOfWeek === mod.dayOfWeek));
        if (w && !mod.modReason?.startsWith('Timing:')) {
          if (mod.originalDistance != null) (w as any).originalDistance = mod.originalDistance;
          (w as any).d = mod.newDistance;
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
        // Run was reduced by cross-training — update the existing reduce mod's distance
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
    renderPlanView();
  });

  // ─── Adjust week button ────────────────────────────────────────────────────
  document.getElementById('plan-adjust-week-btn')?.addEventListener('click', () => {
    triggerExcessLoadAdjustment();
  });

  // ─── Tier 1 auto-reduce — undo button ─────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.plan-auto-undo-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s2 = getMutableState();
      const wk2 = s2.wks?.[s2.w - 1];
      if (!wk2) return;
      // Remove all Auto: mods — restores the easy run; unspentLoadItems already in state → card reappears
      wk2.workoutMods = (wk2.workoutMods ?? []).filter(m => !m.modReason?.startsWith('Auto:'));
      saveState();
      // Must use render() (full re-render) not renderPlanView() — the excess load card
      // lives in the Training tab (main-view.ts) and won't reappear on Plan-only re-render
      import('@/ui/renderer').then(({ render }) => render());
    });
  });

  // ─── Timing suggestion — accept downgrade ──────────────────────────────────
  document.querySelectorAll<HTMLElement>('.plan-timing-accept').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const workoutName = btn.dataset.workoutName || '';
      const dayOfWeek = btn.dataset.day !== '' ? parseInt(btn.dataset.day!, 10) : undefined;
      const newType = btn.dataset.newType || '';
      const newDistance = btn.dataset.newDistance || '';
      if (!workoutName || !newType) return;

      const ms = getMutableState();
      const wk = ms.wks?.[ms.w - 1];
      if (!wk) return;

      // Replace the Timing: suggestion mod with a real applied mod
      wk.workoutMods = (wk.workoutMods ?? []).filter(
        m => !(isTimingMod(m.modReason) && m.name === workoutName && (dayOfWeek == null || m.dayOfWeek === dayOfWeek))
      );
      wk.workoutMods.push({
        name: workoutName,
        dayOfWeek,
        status: 'reduced',
        modReason: 'Timing accepted: hard session day before',
        confidence: 'medium',
        originalDistance: newDistance,
        newDistance,
        newType,
      });
      saveState();
      renderPlanView();
    });
  });

  // ─── Activity log review buttons ───────────────────────────────────────────
  const _reviewClick = () => {
    const _s = getMutableState();
    const _wk = _s.wks?.[_s.w - 1];
    if (!_wk) return;

    const _pending = (_wk.garminPending ?? []).filter(
      p => (_wk.garminMatched?.[p.garminId] ?? '__pending__') === '__pending__',
    );
    if (_pending.length > 0) {
      // Still-unprocessed items: process them without undoing prior decisions
      showActivityReview(_pending, () => renderPlanView());
    } else {
      // All items processed: full re-review (undoes, shows with saved slot assignments)
      openActivityReReview(() => renderPlanView());
    }
  };
  document.getElementById('plan-review-btn')?.addEventListener('click', _reviewClick);
  document.getElementById('plan-review-btn-2')?.addEventListener('click', _reviewClick);


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
      const s2 = getState();
      const actual = s2.wks?.[weekNum - 1]?.garminActuals?.[workoutKey];
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
      const s2 = getState();
      const wk2 = s2.wks?.[weekNum - 1];
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
      renderPlanView();
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
      renderPlanView();
    });
  });

  // Touch swipe for iOS/mobile (left = next week, right = prev week)
  let touchStartX = 0;
  const page = document.querySelector('.mosaic-page') as HTMLElement;
  if (page) {
    page.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
    page.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 60) {
        if (dx < 0 && viewWeek < s.tw) { _viewWeek = viewWeek + 1; renderPlanView(); }
        if (dx > 0 && viewWeek > 1) { _viewWeek = viewWeek - 1; renderPlanView(); }
      }
    }, { passive: true });
  }
}

export function renderPlanView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const viewWeek = (_viewWeek !== null && _viewWeek >= 1 && _viewWeek <= s.tw)
    ? _viewWeek
    : s.w;
  if (viewWeek === s.w) maybeInitKmNudge();
  container.innerHTML = getPlanHTML(s, viewWeek);
  wirePlanHandlers(s, viewWeek);
  setOnWeekAdvance(() => {
    _viewWeek = null;
    renderPlanView();
  });

  // Auto-show end-of-week debrief on Sunday (once per day)
  if (viewWeek === s.w && shouldShowSundayDebrief()) {
    setTimeout(() => showWeekDebrief(s.w, 'complete'), 400);
  }
}
