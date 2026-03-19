/**
 * Plan tab — weekly calendar strip + Vergia-style workout card list.
 * Week navigation with < > buttons (keyboard arrow keys on web, swipe on iOS Phase 3).
 * Complex interactions (rating, Garmin matching) delegate to renderMainView() for now.
 */

import { getState, getMutableState, saveState } from '@/state';
import type { SimulatorState, Week } from '@/types';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { isSimulatorMode } from '@/main';
import { generateWeekWorkouts, calculateWorkoutLoad } from '@/workouts';
import { isDeloadWeek, abilityBandFromVdot } from '@/workouts/plan_engine';
import { rate, skip, removeGarminActivity, next, setOnWeekAdvance, isBenchmarkWeek, findGarminRunForWeek, getBenchmarkOptions, recordBenchmark, skipBenchmark } from './events';
import { openActivityReReview } from './activity-review';
import { openInjuryModal, isInjuryActive, markAsRecovered, getInjuryStateForDisplay } from './injury/modal';
import { getReturnToRunLevelLabel, recordMorningPain } from '@/injury/engine';
import { INJURY_PROTOCOLS } from '@/constants/injury-protocols';
import { TL_PER_MIN, SPORTS_DB } from '@/constants';
import { computeWeekTSS, computeWeekRawTSS, getWeeklyExcess, computePlannedWeekTSS, computePlannedSignalB, getTrailingEffortScore, computeCrossTrainTSSPerMin } from '@/calculations/fitness-model';
import { normalizeSport } from '@/cross-training/activities';
import { formatKm, fmtDesc, formatPace } from '@/utils/format';
import { triggerExcessLoadAdjustment } from './excess-load-card';
import { showLoadBreakdownSheet } from './home-view';
import { isTimingMod, mergeTimingMods } from '@/cross-training/timing-check';
import type { MorningPainResponse } from '@/types/injury';
import { computeRecoveryStatus, sleepQualityToScore } from '@/recovery/engine';
import { calculateZones, getWorkoutHRTarget } from '@/calculations/heart-rate';
import type { RecoveryEntry, RecoveryLevel } from '@/recovery/engine';
import { showWeekDebrief, shouldShowSundayDebrief } from '@/ui/week-debrief';

// ─── Module state ────────────────────────────────────────────────────────────

let _viewWeek: number | null = null; // null = current week

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
const DAY_LETTER = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

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
    const desc: string = w.d || '';
    let durMin = 0;
    const lines = desc.split('\n').filter((l: string) => l.trim());
    let mainDesc = desc;
    let wucdMin = 0;
    if (lines.length >= 3 && lines[0].includes('warm up')) {
      mainDesc = lines[1];
      const wuKm = parseFloat((lines[0].match(/^(\d+\.?\d*)km/) || [])[1] || '0');
      const cdKm = parseFloat((lines[lines.length - 1].match(/^(\d+\.?\d*)km/) || [])[1] || '0');
      wucdMin = (wuKm + cdKm) * baseMinPerKm;
    }
    const intervalTimeMatch = mainDesc.match(/(\d+)×(\d+\.?\d*)min/);
    if (intervalTimeMatch) {
      const reps = parseInt(intervalTimeMatch[1]);
      const repDur = parseFloat(intervalTimeMatch[2]);
      const recMatch = mainDesc.match(/(\d+\.?\d*)\s*min\s*recovery/);
      const recMin = recMatch ? parseFloat(recMatch[1]) : 0;
      durMin = reps * repDur + (reps - 1) * recMin + wucdMin;
    } else {
      const kmMatch = mainDesc.match(/(\d+\.?\d*)km/);
      if (kmMatch) {
        const km = parseFloat(kmMatch[1]);
        let paceMinPerKm = baseMinPerKm;
        if (t === 'threshold' || t === 'tempo') paceMinPerKm = baseMinPerKm * 0.82;
        else if (t === 'vo2' || t === 'intervals') paceMinPerKm = baseMinPerKm * 0.73;
        else if (t === 'race_pace') paceMinPerKm = baseMinPerKm * 0.78;
        else if (t === 'marathon_pace') paceMinPerKm = baseMinPerKm * 0.87;
        else if (t === 'long') paceMinPerKm = baseMinPerKm * 1.03;
        durMin = km * paceMinPerKm + wucdMin;
      } else {
        const minMatch = mainDesc.match(/(\d+)min/);
        durMin = minMatch ? parseInt(minMatch[1]) + wucdMin : (wucdMin || 40);
      }
    }
    if (durMin <= 0) durMin = 40;
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
      if (w.t === 'gym') {
        html += `<button class="plan-action-mark-done m-btn-secondary" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-rpe="0" data-type="gym" data-week-num="${viewWeek}" style="width:100%;margin-bottom:8px;font-size:13px;padding:10px 0;text-align:center;display:block">Mark Done</button>`;
      } else {
        html += `<button class="plan-action-mark-done m-btn-primary" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-rpe="${rpe}" data-type="${w.t}" data-week-num="${viewWeek}" style="width:100%;margin-bottom:8px;font-size:13px;padding:10px 0;text-align:center;justify-content:center;display:flex">✓ Mark as Done</button>`;
      }
      const safeDesc = escapeHtml((w.d || '').replace(/\n/g, ' '));
      html += `<button class="plan-action-skip m-btn-secondary" data-workout-id="${safeId}" data-name="${escapeHtml(w.n || '')}" data-type="${w.t}" data-rpe="${rpe}" data-desc="${safeDesc}" data-day="${w.dayOfWeek ?? 0}" data-week-num="${viewWeek}" style="width:100%;font-size:12px;padding:8px 0;text-align:center;display:block;opacity:0.6">Skip</button>`;
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

  const totalItems = Object.keys(actuals).length + adhocGarmin.length + pendingItems.length;
  if (totalItems === 0) return '';

  const matchedCount = Object.keys(actuals).length + adhocGarmin.length;
  const excessLoad = Math.round((wk as any).unspentLoad || 0);

  let h = `<div style="border-top:1px solid var(--c-border)">`;

  // Header
  h += `<div style="padding:12px 18px 0;display:flex;align-items:center;justify-content:space-between">`;
  h += `<div>`;
  h += `<span class="m-sec-label" style="margin-bottom:0">Activity Log</span>`;
  if (matchedCount > 0) {
    h += `<span style="font-size:11px;color:var(--c-muted);margin-left:8px">${matchedCount} matched`;
    if (excessLoad > 0) h += ` · <span style="color:var(--c-caution)">+${excessLoad} excess TSS</span>`;
    h += `</span>`;
  }
  h += `</div>`;
  if (viewWeek === currentWeek) {
    h += `<button id="plan-review-btn" class="m-btn-link" style="font-size:12px">`;
    if (pendingItems.length > 0) h += `${pendingItems.length} pending · `;
    h += `Review <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>`;
  }
  h += `</div>`;

  // Pending banner
  if (pendingItems.length > 0 && viewWeek === currentWeek) {
    h += `<div style="margin:10px 18px 0;padding:10px 12px;background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.25);border-radius:var(--r-card);display:flex;align-items:center;justify-content:space-between;gap:8px">`;
    h += `<div>`;
    h += `<div style="font-size:13px;font-weight:600;color:var(--c-caution)">${pendingItems.length} activit${pendingItems.length === 1 ? 'y' : 'ies'} pending review</div>`;
    const types = [...new Set(pendingItems.map(p => p.appType || p.activityType))].slice(0, 3).join(', ');
    if (types) h += `<div style="font-size:11px;color:var(--c-muted);margin-top:2px">${types}</div>`;
    h += `</div>`;
    h += `<button id="plan-review-btn-2" class="m-btn-secondary" style="font-size:12px;padding:6px 14px;flex-shrink:0">Review</button>`;
    h += `</div>`;
  }

  const excessGarminIds = new Set((wk.unspentLoadItems || []).map((u: any) => u.garminId));

  h += `<div style="padding:8px 0 4px">`;

  // Matched plan-slot activities (garminActuals) — these replaced a planned session
  for (const [workoutId, a] of Object.entries(actuals)) {
    const actual = a as any;
    // Show actual activity name (displayName) for cross-training; for runs workoutName is the plan slot name
    const activityName = actual.displayName || actual.workoutName || workoutId;
    const slotName = actual.workoutName && actual.workoutName !== actual.displayName ? actual.workoutName : null;
    const source = actual.garminId?.startsWith('strava-') ? 'Strava' : 'Garmin';
    const dur = Math.round(actual.durationSec / 60);
    const statsArr: string[] = [];
    if (actual.distanceKm > 0.1) statsArr.push(formatKm(actual.distanceKm, s.unitPref ?? 'km'));
    if (actual.avgPaceSecKm) statsArr.push(fmtPacePlan(actual.avgPaceSecKm, s.unitPref ?? 'km'));
    if (actual.avgHR) statsArr.push(`HR ${actual.avgHR}`);
    statsArr.push(`${dur} min`);
    const dateStr = actual.startTime ? new Date(actual.startTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

    h += `<div class="m-list-item plan-act-open" data-workout-key="${escapeHtml(workoutId)}" data-week-num="${viewWeek}" style="cursor:pointer">`;
    h += `<div style="width:7px;height:7px;border-radius:50%;background:var(--c-ok);flex-shrink:0"></div>`;
    h += `<div style="flex:1;min-width:0">`;
    h += `<div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(activityName)}</div>`;
    const subParts = [...statsArr];
    if (dateStr) subParts.push(dateStr);
    if (slotName) subParts.push(`→ ${slotName}`);
    h += `<div style="font-size:11px;color:var(--c-muted);margin-top:1px">${subParts.join(' · ')}</div>`;
    h += `</div>`;
    h += `<div style="display:flex;align-items:center;gap:6px">`;
    h += `<span style="font-size:9px;font-weight:600;color:var(--c-ok);background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:4px;padding:2px 6px">Matched</span>`;
    h += `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
    if (actual.garminId) {
      h += `<button class="plan-remove-garmin" data-garmin-id="${escapeHtml(actual.garminId)}" style="font-size:20px;line-height:1;color:var(--c-faint);background:none;border:none;cursor:pointer;padding:0">×</button>`;
    }
    h += `</div>`;
    h += `</div>`;
  }

  // Adhoc garmin/strava activities — logged only or excess load
  for (const w of adhocGarmin) {
    const wAny = w as any;
    const rawId = (w.id || '').slice('garmin-'.length);
    const actual = wk?.garminActuals?.[rawId];
    const name = wAny.n || actual?.displayName || 'Activity';
    const dur = actual?.durationSec ? Math.round(actual.durationSec / 60) : (wAny.dur || 0);
    const km = actual?.distanceKm || wAny.km || wAny.distanceKm || 0;
    const isExcess = excessGarminIds.has(rawId);
    const statsArr: string[] = [];
    if (km > 0.1) statsArr.push(typeof km === 'number' ? formatKm(km, s.unitPref ?? 'km') : formatKm(parseFloat(km), s.unitPref ?? 'km'));
    if (actual?.avgPaceSecKm) statsArr.push(fmtPacePlan(actual.avgPaceSecKm, s.unitPref ?? 'km'));
    if (actual?.avgHR) statsArr.push(`HR ${actual.avgHR}`);
    if (dur > 0) statsArr.push(`${dur} min`);

    const hasActual = !!actual;
    const dotColor = isExcess ? 'var(--c-caution)' : 'var(--c-accent)';
    const tagHtml = isExcess
      ? `<span style="font-size:9px;font-weight:600;color:var(--c-caution);background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:4px;padding:2px 6px">Excess</span>`
      : `<span style="font-size:9px;font-weight:600;color:var(--c-muted);background:rgba(0,0,0,0.04);border:1px solid var(--c-border);border-radius:4px;padding:2px 6px">Logged</span>`;

    h += `<div class="m-list-item${hasActual ? ' plan-act-open' : ''}"${hasActual ? ` data-workout-key="${escapeHtml(rawId)}" data-week-num="${viewWeek}"` : ''} style="cursor:${hasActual ? 'pointer' : 'default'}">`;
    h += `<div style="width:7px;height:7px;border-radius:50%;background:${dotColor};flex-shrink:0"></div>`;
    h += `<div style="flex:1;min-width:0">`;
    h += `<div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</div>`;
    if (statsArr.length) h += `<div style="font-size:11px;color:var(--c-muted);margin-top:1px">${statsArr.join(' · ')}</div>`;
    h += `</div>`;
    h += `<div style="display:flex;align-items:center;gap:6px">`;
    h += tagHtml;
    if (hasActual) h += `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
    h += `</div>`;
    h += `</div>`;
  }

  h += `</div></div>`;
  return h;
}

// ─── Calendar strip ───────────────────────────────────────────────────────────

function buildCalendarStrip(
  workouts: any[],
  rated: Record<string, number | 'skip'>,
  viewWeek: number,
  currentWeek: number,
): string {
  const today = ourDay();
  const isCurrentWeek = viewWeek === currentWeek;

  const days = DAY_LETTER.map((letter, dayIdx) => {
    const dayWorkouts = workouts.filter((w: any) => w.dayOfWeek === dayIdx);
    const isRest = dayWorkouts.length === 0 || dayWorkouts.every((w: any) => w.t === 'rest');
    const isToday = isCurrentWeek && dayIdx === today;
    const isPast = viewWeek < currentWeek || (isCurrentWeek && dayIdx < today);

    // Status
    let anyRated = false;
    let anySkipped = false;
    if (!isRest) {
      for (const w of dayWorkouts) {
        const id = w.id || w.n;
        const r = rated[id];
        if (typeof r === 'number' && r > 0) anyRated = true;
        if (r === 'skip') anySkipped = true;
      }
    }

    let dotBg: string;
    let dotContent: string;
    let opacity = '1';

    if (isRest) {
      dotBg = 'transparent';
      dotContent = `<span style="font-size:12px;color:var(--c-faint)">—</span>`;
    } else if (anyRated) {
      dotBg = 'var(--c-ok)';
      dotContent = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>`;
    } else if (anySkipped) {
      dotBg = 'rgba(0,0,0,0.12)';
      dotContent = `<span style="font-size:11px;color:var(--c-muted)">×</span>`;
    } else if (isToday) {
      dotBg = 'var(--c-accent)';
      dotContent = `<span style="width:5px;height:5px;border-radius:50%;background:white;display:block"></span>`;
    } else if (isPast) {
      dotBg = 'rgba(0,0,0,0.08)';
      dotContent = `<span style="width:5px;height:5px;border-radius:50%;background:var(--c-muted);display:block"></span>`;
      opacity = '0.5';
    } else {
      dotBg = 'transparent';
      dotContent = `<span style="width:5px;height:5px;border-radius:50%;border:1.5px solid rgba(0,0,0,0.25);display:block"></span>`;
    }

    return `
      <div class="plan-day-pill" data-day="${dayIdx}" style="display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;flex:1;opacity:${opacity}">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${isToday ? 'var(--c-accent)' : 'var(--c-faint)'}">${letter}</span>
        <div style="width:26px;height:26px;border-radius:50%;background:${dotBg};display:flex;align-items:center;justify-content:center;${isToday ? 'box-shadow:0 0 0 2px var(--c-accent)' : ''}">${dotContent}</div>
      </div>
    `;
  }).join('');

  return `<div style="display:flex;gap:0;padding:12px 18px 10px">${days}</div>`;
}

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
        <div id="plan-day-${dayIdx}" class="plan-drop-zone" data-day-of-week="${dayIdx}" style="display:flex;align-items:center;padding:10px 18px;border-top:1px solid var(--c-border);transition:background 0.15s">
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
      const isToday = isCurrentWeek && dayIdx === actualToday;
      const isPast = viewWeek < s.w || (isCurrentWeek && dayIdx < actualToday);
      const isRest = w.t === 'rest' || w.n?.toLowerCase().includes('rest');

      if (isRest) {
        const dayAnchorId = !dayFirstCardEmitted.has(dayIdx) ? `id="plan-day-${dayIdx}" ` : '';
        dayFirstCardEmitted.add(dayIdx);
        cards.push(`
          <div ${dayAnchorId}class="plan-drop-zone" data-day-of-week="${dayIdx}" style="display:flex;align-items:center;padding:10px 18px;border-top:1px solid var(--c-border);transition:background 0.15s">
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

      // Status label + color
      let statusLabel: string;
      let statusColor: string;
      if (isDone) {
        statusLabel = garminAct ? 'Logged' : 'Done';
        statusColor = 'var(--c-ok)';
      } else if (isReplaced) {
        statusLabel = 'Replaced';
        statusColor = 'var(--c-caution)';
      } else if (isReduced) {
        statusLabel = 'Adjusted';
        statusColor = 'var(--c-caution)';
      } else if (isSkipped) {
        statusLabel = 'Skipped';
        statusColor = 'var(--c-muted)';
      } else if (isToday) {
        statusLabel = 'Today';
        statusColor = 'var(--c-accent)';
      } else if (isPast) {
        statusLabel = 'Missed';
        statusColor = 'var(--c-caution)';
      } else {
        statusLabel = 'Upcoming';
        statusColor = 'var(--c-faint)';
      }

      // Card border: colour-coded left stripe
      let borderLeft = '';
      if (isDone) borderLeft = 'border-left:3px solid var(--c-ok);';
      else if (isToday) borderLeft = 'border-left:3px solid var(--c-accent);';
      else if (isPast && !isSkipped && !isReplaced) borderLeft = 'border-left:3px solid rgba(245,158,11,0.35);';

      const headerPad = (borderLeft && !isToday) ? '13px 18px 13px 15px' : isToday ? '14px 18px 14px 15px' : '13px 18px';
      const nameOpacity = isSkipped || isReplaced ? '0.5' : '1';
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
          <div style="width:6px;height:6px;border-radius:50%;background:var(--c-ok);flex-shrink:0"></div>
          <span style="font-size:11px;color:var(--c-muted)">${matchName ? escapeHtml(matchName) + ' · ' : ''}${source}${matchStats.length ? ' · ' + matchStats.join(' · ') : ''}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--c-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </div>`;
      } else if (isReplaced && replacedByAdhoc) {
        const repName = (replacedByAdhoc as any).n || (replacedByAdhoc as any).name || 'Cross-training';
        const repDur = (replacedByAdhoc as any).dur || (replacedByAdhoc as any).durationMin || 0;
        actMatchRow = `<div style="display:flex;align-items:center;gap:5px;margin-top:3px">
          <span style="font-size:11px;color:var(--c-caution)">→ ${escapeHtml(repName)}${repDur ? ` · ${Math.round(repDur)} min` : ''}</span>
        </div>`;
      }

      const showUndoAdj = isReduced && !(w as any).modReason?.startsWith?.('Auto:') && !isDone;
      const undoAdjBtn = showUndoAdj
        ? `<button class="plan-recovery-undo-btn" data-workout-name="${escapeHtml(w.n)}" data-day-of-week="${(w as any).dayOfWeek ?? ''}" data-week-num="${viewWeek}" data-orig-label="${escapeHtml((w as any).originalDistance || w.n || '')}" style="font-size:11px;color:var(--c-caution);background:none;border:none;cursor:pointer;padding:0;white-space:nowrap;flex-shrink:0">Undo adjustment</button>`
        : '';

      const rightContent = isToday && !isDone
        ? `<button class="plan-start-btn m-btn-primary" data-workout-id="${id}" style="padding:7px 14px;font-size:12px">
            <span style="width:10px;height:10px;background:white;clip-path:polygon(0 0,100% 50%,0 100%);display:inline-block;flex-shrink:0"></span>
            Start
          </button>`
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
            <button class="plan-auto-undo-btn" data-workout-id="${escapeHtml(id)}" style="font-size:11px;color:var(--c-caution);background:none;border:none;cursor:pointer;padding:0;white-space:nowrap;flex-shrink:0">Undo</button>
          </div>`
        : '';

      const expandDetail = buildWorkoutExpandedDetail(w, wk, viewWeek, s.w);
      cards.push(`
        <div ${dayAnchorId}class="plan-workout-card" data-workout-id="${id}" data-day-of-week="${dayIdx}" draggable="true" style="border-top:1px solid var(--c-border);background:var(--c-surface);${borderLeft}">
          <div class="plan-card-header" style="display:flex;align-items:center;padding:${headerPad};gap:12px;cursor:pointer">
            <div style="width:36px;flex-shrink:0">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:${statusColor};line-height:1.2">${DAY_SHORT[dayIdx]}</div>
              <div style="font-size:9px;color:${statusColor};margin-top:1px">${statusLabel}</div>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:15px;font-weight:400;letter-spacing:-0.01em;opacity:${nameOpacity};text-decoration:${nameDecoration};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
              ${actMatchRow}
              ${isTimingMod((w as any).modReason) && !isDone ? `<div style="display:flex;align-items:center;gap:4px;margin-top:3px"><span style="font-size:10px;font-weight:600;color:#F97316;background:rgba(249,115,22,0.1);border-radius:4px;padding:1px 6px">Suggestion — hard session yesterday</span></div>` : ''}
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
 * Visible on Sunday (day 6) or when every workout is done/skipped.
 */
function buildWrapUpWeekBtn(s: SimulatorState, workouts: any[], viewWeek: number): string {
  if (viewWeek !== s.w) return '';
  if ((s as any).wks?.[viewWeek - 1]?.weekCompleted) return '';
  const today = ourDay(); // 6 = Sunday
  const wk = (s as any).wks?.[viewWeek - 1];
  const show = today === 6 || allWorkoutsDone(workouts, wk);
  if (!show) return '';
  return `<button id="plan-wrap-up-btn"
    style="height:30px;padding:0 12px;border-radius:15px;border:1.5px solid var(--c-accent);
           background:transparent;font-size:11px;font-weight:600;color:var(--c-accent);
           cursor:pointer;letter-spacing:0.01em;white-space:nowrap">Wrap up week</button>`;
}

// ─── Injury UI ───────────────────────────────────────────────────────────────

/**
 * Small header button — heart icon when healthy, amber pill when injured.
 */
function buildInjuryHeaderBtn(injured: boolean): string {
  if (injured) {
    return `
      <button id="plan-injury-update"
        style="display:inline-flex;align-items:center;gap:5px;padding:5px 11px;border-radius:100px;
               border:1px solid rgba(234,88,12,0.3);background:rgba(254,243,199,0.9);
               cursor:pointer;font-size:11px;font-weight:600;color:#92400E;white-space:nowrap">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
        In Recovery
      </button>
    `;
  }
  return `
    <button id="plan-report-injury"
      style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border);background:transparent;
             display:flex;align-items:center;justify-content:center;cursor:pointer"
      title="Report an injury">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="1.5"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    </button>
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

  // Phase config
  const phaseConfig: Record<string, { label: string; accent: string; bg: string; text: string; dot: string }> = {
    acute: { label: 'Acute — Rest', accent: '#EF4444,#DC2626', bg: 'rgba(254,242,242,0.85)', text: '#991B1B', dot: '#EF4444' },
    rehab: { label: 'Rehabilitation', accent: '#F59E0B,#F97316', bg: 'rgba(255,251,235,0.85)', text: '#92400E', dot: '#F59E0B' },
    test_capacity: { label: 'Capacity Testing', accent: '#8B5CF6,#A855F7', bg: 'rgba(245,243,255,0.85)', text: '#5B21B6', dot: '#8B5CF6' },
    return_to_run: { label: 'Return to Run', accent: '#3B82F6,#2563EB', bg: 'rgba(239,246,255,0.85)', text: '#1E40AF', dot: '#3B82F6' },
    graduated_return: { label: 'Graduated Return', accent: '#06B6D4,#0891B2', bg: 'rgba(236,254,255,0.85)', text: '#155E75', dot: '#06B6D4' },
    resolved: { label: 'Resolved', accent: '#22C55E,#16A34A', bg: 'rgba(240,253,244,0.85)', text: '#15803D', dot: '#22C55E' },
  };
  const pc = phaseConfig[inj.injuryPhase] || phaseConfig['rehab'];

  // Pain colour
  const painColor = inj.currentPain === 0 ? '#22C55E'
    : inj.currentPain <= 3 ? '#F59E0B'
      : inj.currentPain <= 6 ? '#F97316'
        : '#EF4444';

  // Can-run badge
  const canRunMap = {
    yes: { label: 'Can run', bg: 'rgba(34,197,94,0.12)', color: '#15803D' },
    limited: { label: 'Limited running', bg: 'rgba(245,158,11,0.12)', color: '#92400E' },
    no: { label: 'No running', bg: 'rgba(239,68,68,0.10)', color: '#991B1B' },
  };
  const cr = canRunMap[inj.canRun] || canRunMap['no'];

  // Return-to-run level label
  const levelLabel = inj.injuryPhase === 'return_to_run'
    ? getReturnToRunLevelLabel(inj.returnToRunLevel || 1)
    : inj.injuryPhase === 'graduated_return'
      ? `Week ${3 - (inj.graduatedReturnWeeksLeft || 0)} of 2`
      : '';

  const isReturnPhase = inj.injuryPhase === 'return_to_run' || inj.injuryPhase === 'graduated_return';

  return `
    <div style="margin:14px 16px 0;border-radius:16px;overflow:hidden;
                border:1px solid rgba(0,0,0,0.08);
                background:${pc.bg};
                box-shadow:0 1px 8px rgba(0,0,0,0.06)">

      <!-- Phase accent bar -->
      <div style="height:3px;background:linear-gradient(to right,${pc.accent})"></div>

      <div style="padding:16px">

        <!-- Top row: injury name + pain level -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:11px">
          <div style="flex:1;min-width:0;padding-right:12px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;
                        color:${pc.text};opacity:0.7;margin-bottom:3px">
              Recovery Mode
            </div>
            <div style="font-size:17px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black);
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              ${displayName}
            </div>
            <div style="font-size:12px;color:${pc.text};margin-top:2px;font-weight:500">
              ${pc.label}
            </div>
          </div>

          <!-- Pain level -->
          <div style="text-align:right;flex-shrink:0">
            <div style="font-size:10px;color:rgba(0,0,0,0.38);margin-bottom:2px;font-weight:500">Pain</div>
            <div style="font-size:30px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:${painColor}">
              ${inj.currentPain}<span style="font-size:13px;color:rgba(0,0,0,0.25);font-weight:400">/10</span>
            </div>
          </div>
        </div>

        <!-- Can-run badge + optional level -->
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
          <span style="display:inline-flex;align-items:center;gap:5px;padding:4px 11px;
                       border-radius:100px;font-size:11px;font-weight:600;
                       background:${cr.bg};color:${cr.color}">
            <span style="width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block"></span>
            ${cr.label}
          </span>
          ${levelLabel ? `<span style="font-size:11px;color:rgba(0,0,0,0.38);font-weight:400">${levelLabel}</span>` : ''}
        </div>

        ${isReturnPhase ? `
        <!-- Medical note -->
        <div style="padding:9px 11px;border-radius:9px;
                    background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.18);
                    margin-bottom:14px">
          <p style="font-size:11px;color:#92400E;line-height:1.55;margin:0">
            Not medical advice. Consult a sports physiotherapist if pain persists or worsens.
            Never push through sharp pain.
          </p>
        </div>` : ''}

        <!-- Actions -->
        <div style="display:flex;gap:8px">
          <button id="plan-injury-update" class="m-btn-secondary"
            style="flex:1;font-size:13px;padding:10px 0;text-align:center;justify-content:center">
            Update injury
          </button>
          <button id="plan-injury-recovered" class="m-btn-primary"
            style="flex:1;font-size:13px;padding:10px 0;text-align:center;justify-content:center;
                   background:#22C55E;border-color:#22C55E;display:flex;align-items:center;gap:5px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
            I'm Recovered
          </button>
        </div>

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

  return `
    <div id="morning-pain-check"
      style="margin:12px 16px 0;border-radius:16px;overflow:hidden;
             border:1px solid rgba(59,130,246,0.18);
             background:rgba(239,246,255,0.85);
             box-shadow:0 1px 6px rgba(59,130,246,0.08)">

      <!-- Accent bar -->
      <div style="height:3px;background:linear-gradient(to right,#60A5FA,#818CF8)"></div>

      <div style="padding:16px">
        <!-- Header row -->
        <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:13px">
          <!-- Sun icon -->
          <div style="width:36px;height:36px;border-radius:10px;
                      background:rgba(96,165,250,0.12);border:1px solid rgba(96,165,250,0.2);
                      display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3B82F6"
                 stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="5"/>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
          </div>
          <div>
            <div style="font-size:14px;font-weight:600;letter-spacing:-0.01em;color:var(--c-black);margin-bottom:2px">
              Morning check-in
            </div>
            <div style="font-size:12px;color:rgba(0,0,0,0.45);line-height:1.4">
              How does your ${injName.toLowerCase()} feel vs yesterday?
              <span style="display:inline-block;margin-left:4px;padding:1px 7px;border-radius:100px;
                           font-size:10px;font-weight:600;background:rgba(59,130,246,0.1);color:#1E40AF">
                Pain: ${pain}/10
              </span>
            </div>
          </div>
        </div>

        <!-- Response buttons -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px">

          <button class="plan-morning-pain-btn" data-response="worse"
            style="padding:10px 0;border-radius:10px;border:1px solid rgba(239,68,68,0.25);
                   background:rgba(254,242,242,0.7);cursor:pointer;
                   display:flex;flex-direction:column;align-items:center;gap:4px">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EF4444"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7"/>
            </svg>
            <span style="font-size:12px;font-weight:600;color:#991B1B">Worse</span>
          </button>

          <button class="plan-morning-pain-btn" data-response="same"
            style="padding:10px 0;border-radius:10px;border:1px solid rgba(0,0,0,0.1);
                   background:rgba(0,0,0,0.03);cursor:pointer;
                   display:flex;flex-direction:column;align-items:center;gap:4px">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-muted)"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12h14"/>
            </svg>
            <span style="font-size:12px;font-weight:600;color:var(--c-muted)">Same</span>
          </button>

          <button class="plan-morning-pain-btn" data-response="better"
            style="padding:10px 0;border-radius:10px;border:1px solid rgba(34,197,94,0.25);
                   background:rgba(240,253,244,0.7);cursor:pointer;
                   display:flex;flex-direction:column;align-items:center;gap:4px">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22C55E"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7"/>
            </svg>
            <span style="font-size:12px;font-weight:600;color:#15803D">Better</span>
          </button>

        </div>
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
    worse: { text: 'Logged. Extra rest added to today — hang in there.', dot: '#EF4444', bg: 'rgba(254,242,242,0.9)', border: 'rgba(239,68,68,0.2)' },
    same: { text: 'Logged. Steady as she goes — consistency is the plan.', dot: '#3B82F6', bg: 'rgba(239,246,255,0.9)', border: 'rgba(59,130,246,0.2)' },
    better: { text: 'Great news — improvement logged. Keep up the good work.', dot: '#22C55E', bg: 'rgba(240,253,244,0.9)', border: 'rgba(34,197,94,0.2)' },
  };
  const m = msgs[response];

  container.style.transition = 'opacity 0.2s';
  container.style.opacity = '0';
  setTimeout(() => {
    container.innerHTML = `
      <div style="padding:14px 16px;display:flex;align-items:center;gap:10px;
                  background:${m.bg};border-radius:16px;border:1px solid ${m.border}">
        <span style="width:8px;height:8px;border-radius:50%;background:${m.dot};flex-shrink:0"></span>
        <span style="font-size:13px;color:var(--c-black);line-height:1.4">${m.text}</span>
      </div>
    `;
    container.style.opacity = '1';
    container.style.borderRadius = '16px';
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
 * Optional fitness check-in panel — shown on benchmark weeks for continuous mode users.
 */
function buildBenchmarkPanel(s: SimulatorState): string {
  if (!(s as any).continuousMode) return '';
  if (!isBenchmarkWeek(s.w, true)) return '';
  // Never suggest hard efforts on deload/recovery weeks
  const ability = abilityBandFromVdot((s as any).v ?? 40, (s as any).onboarding?.experienceLevel ?? 'intermediate');
  if (isDeloadWeek(s.w, ability)) return '';

  const existing = (s as any).benchmarkResults?.find((b: any) => b.week === s.w);
  if (existing) {
    if (existing.source === 'skipped') {
      return `
        <div class="m-card" style="margin:0 14px 10px;padding:12px 14px;display:flex;align-items:center;gap:10px">
          <span style="font-size:18px">📊</span>
          <span style="font-size:13px;color:var(--c-muted)">Check-in skipped this block — keep training!</span>
        </div>
      `;
    }
    const resultText = formatBenchmarkResult(existing);
    return `
      <div class="m-card" style="margin:0 14px 10px;padding:12px 14px;border-left:3px solid var(--c-ok)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:14px">✅</span>
          <span style="font-size:13px;font-weight:600;color:var(--c-ok)">Check-in Recorded</span>
          ${existing.source === 'garmin' ? `<span style="font-size:11px;font-weight:600;color:#ea580c;background:#ffedd5;padding:2px 7px;border-radius:10px">From watch</span>` : ''}
        </div>
        <div style="font-size:12px;color:var(--c-muted)">${resultText}</div>
      </div>
    `;
  }

  const options = getBenchmarkOptions((s.onboarding as any)?.trainingFocus, (s.onboarding as any)?.experienceLevel);
  const garminRun = findGarminRunForWeek(s.w);

  return `
    <div class="m-card" style="margin:0 14px 10px;padding:14px;border-left:3px solid var(--c-accent)">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="width:38px;height:38px;border-radius:50%;background:rgba(59,130,246,0.12);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <span style="font-size:18px">📈</span>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:2px">Optional fitness check-in</div>
          <div style="font-size:12px;color:var(--c-muted);margin-bottom:12px">See how your fitness is tracking — skip anytime.</div>

          ${garminRun ? `
            <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:10px 12px;margin-bottom:10px">
              <div style="font-size:12px;font-weight:600;color:#ea580c;margin-bottom:2px">🏃 Run detected from watch</div>
              <div style="font-size:12px;color:var(--c-muted);margin-bottom:8px">${(garminRun as any).duration_min}min run · RPE ${(garminRun as any).rpe}</div>
              <button id="btn-benchmark-auto"
                style="font-size:12px;font-weight:600;color:var(--c-ok);background:none;border:none;cursor:pointer;padding:0">
                Use as check-in →
              </button>
            </div>
          ` : ''}

          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
            ${options.map((opt: any) => `
              <button class="btn-benchmark-option"
                data-bm-type="${opt.type}"
                style="text-align:left;padding:10px 12px;border-radius:10px;border:1.5px solid ${opt.recommended ? 'var(--c-accent)' : 'var(--c-border)'};background:${opt.recommended ? 'rgba(59,130,246,0.06)' : 'transparent'};cursor:pointer">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
                  <span style="font-size:13px;font-weight:600;color:${opt.recommended ? 'var(--c-accent)' : 'var(--c-black)'}">
                    ${opt.label}
                  </span>
                  ${opt.recommended ? `<span style="font-size:11px;font-weight:600;color:var(--c-accent);background:rgba(59,130,246,0.1);padding:2px 8px;border-radius:10px">Best for you</span>` : ''}
                </div>
                <div style="font-size:11px;color:var(--c-muted)">${opt.description}</div>
              </button>
            `).join('')}
          </div>

          <button id="btn-benchmark-skip"
            style="font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:4px 0">
            Skip this check-in
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Bottom-sheet modal for manually entering benchmark results.
 */
function showBenchmarkEntryModal(bmType: string): void {
  type BenchmarkType = 'easy_checkin' | 'threshold_check' | 'speed_check' | 'race_simulation';
  const type = bmType as BenchmarkType;
  const bmUnitPref = getState().unitPref ?? 'km';
  const bmDistUnit = bmUnitPref === 'mi' ? 'mi' : 'km';

  let title = '';
  let desc = '';
  let fieldsHTML = '';

  const paceInput = () => `
    <div style="margin-bottom:12px">
      <label style="font-size:12px;color:var(--c-muted);display:block;margin-bottom:6px">Average pace (min : sec per ${bmDistUnit})</label>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="number" id="bm-pace-min" min="2" max="12" placeholder="min"
          style="flex:1;background:var(--c-faint);border:1px solid var(--c-border-strong);border-radius:8px;padding:10px 12px;font-size:15px;color:var(--c-black);outline:none;-webkit-appearance:none">
        <span style="font-size:16px;color:var(--c-muted);font-weight:600">:</span>
        <input type="number" id="bm-pace-sec" min="0" max="59" placeholder="sec"
          style="flex:1;background:var(--c-faint);border:1px solid var(--c-border-strong);border-radius:8px;padding:10px 12px;font-size:15px;color:var(--c-black);outline:none;-webkit-appearance:none">
      </div>
    </div>
  `;

  switch (type) {
    case 'easy_checkin':
      title = 'Easy Check-in';
      desc = '30-min steady run at comfortable pace.';
      fieldsHTML = paceInput();
      break;
    case 'threshold_check':
      title = 'Threshold Check';
      desc = '20-min "comfortably hard" effort. Enter average pace.';
      fieldsHTML = paceInput();
      break;
    case 'speed_check':
      title = 'Speed Check (12-min test)';
      desc = 'How far did you run in 12 minutes?';
      fieldsHTML = `
        <div style="margin-bottom:12px">
          <label style="font-size:12px;color:var(--c-muted);display:block;margin-bottom:6px">Distance covered (${bmDistUnit})</label>
          <input type="number" id="bm-distance" step="0.01" min="0.5" max="6" placeholder="e.g. 2.80"
            style="width:100%;box-sizing:border-box;background:var(--c-faint);border:1px solid var(--c-border-strong);border-radius:8px;padding:10px 12px;font-size:15px;color:var(--c-black);outline:none;-webkit-appearance:none">
        </div>
      `;
      break;
    case 'race_simulation':
      title = 'Race Simulation';
      desc = 'Log your time trial result.';
      fieldsHTML = `
        <div style="margin-bottom:10px">
          <label style="font-size:12px;color:var(--c-muted);display:block;margin-bottom:6px">Distance (${bmDistUnit})</label>
          <input type="number" id="bm-distance" step="0.1" min="1" max="42.2" placeholder="e.g. 5"
            style="width:100%;box-sizing:border-box;background:var(--c-faint);border:1px solid var(--c-border-strong);border-radius:8px;padding:10px 12px;font-size:15px;color:var(--c-black);outline:none;-webkit-appearance:none">
        </div>
        <div style="margin-bottom:12px">
          <label style="font-size:12px;color:var(--c-muted);display:block;margin-bottom:6px">Time (min : sec)</label>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="number" id="bm-time-min" min="5" max="300" placeholder="min"
              style="flex:1;background:var(--c-faint);border:1px solid var(--c-border-strong);border-radius:8px;padding:10px 12px;font-size:15px;color:var(--c-black);outline:none;-webkit-appearance:none">
            <span style="font-size:16px;color:var(--c-muted);font-weight:600">:</span>
            <input type="number" id="bm-time-sec" min="0" max="59" placeholder="sec"
              style="flex:1;background:var(--c-faint);border:1px solid var(--c-border-strong);border-radius:8px;padding:10px 12px;font-size:15px;color:var(--c-black);outline:none;-webkit-appearance:none">
          </div>
        </div>
      `;
      break;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:var(--c-surface);border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:0 0 env(safe-area-inset-bottom,0)">
      <div style="display:flex;justify-content:center;padding:12px 0 4px">
        <div style="width:36px;height:4px;border-radius:2px;background:var(--c-border-strong)"></div>
      </div>
      <div style="padding:16px 20px 28px">
        <div style="font-size:17px;font-weight:700;color:var(--c-black);margin-bottom:4px">${title}</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:16px">${desc}</div>
        ${fieldsHTML}
        <div style="display:flex;flex-direction:column;gap:8px">
          <button id="btn-bm-submit" class="m-btn-primary" style="width:100%">Save result</button>
          <button id="btn-bm-cancel" class="m-btn-secondary" style="width:100%">Cancel</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#btn-bm-submit')?.addEventListener('click', () => {
    switch (type) {
      case 'easy_checkin':
      case 'threshold_check': {
        const m = +(document.getElementById('bm-pace-min') as HTMLInputElement)?.value || 0;
        const sec = +(document.getElementById('bm-pace-sec') as HTMLInputElement)?.value || 0;
        const paceSecRaw = m * 60 + sec;
        if (paceSecRaw < 120 || paceSecRaw > 900) { alert(`Enter a valid pace (min:sec per ${bmDistUnit})`); return; }
        // Convert to sec/km if user entered sec/mi
        const paceSec = bmUnitPref === 'mi' ? paceSecRaw * 1.60934 : paceSecRaw;
        overlay.remove();
        const dur = type === 'easy_checkin' ? 1800 : 1200;
        recordBenchmark(type, 'manual', undefined, dur, paceSec);
        break;
      }
      case 'speed_check': {
        const distRaw = +(document.getElementById('bm-distance') as HTMLInputElement)?.value;
        if (!distRaw || distRaw < 0.5) { alert(`Enter a distance (${bmDistUnit})`); return; }
        // Convert to km if user entered miles
        const distKm = bmUnitPref === 'mi' ? distRaw / 0.621371 : distRaw;
        overlay.remove();
        recordBenchmark('speed_check', 'manual', distKm, 720);
        break;
      }
      case 'race_simulation': {
        const distRaw = +(document.getElementById('bm-distance') as HTMLInputElement)?.value;
        const m = +(document.getElementById('bm-time-min') as HTMLInputElement)?.value || 0;
        const sec = +(document.getElementById('bm-time-sec') as HTMLInputElement)?.value || 0;
        const totalSec = m * 60 + sec;
        if (!distRaw || distRaw < 1) { alert('Enter a distance'); return; }
        if (totalSec < 300) { alert('Enter a valid time'); return; }
        // Convert to km if user entered miles
        const distKm = bmUnitPref === 'mi' ? distRaw / 0.621371 : distRaw;
        overlay.remove();
        recordBenchmark('race_simulation', 'manual', distKm, totalSec, totalSec / distKm);
        break;
      }
    }
  });

  overlay.querySelector('#btn-bm-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
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
    if (score >= 70) return 'background:var(--c-ok)';
    if (score >= 50) return 'background:#f59e0b';
    if (score >= 30) return 'background:#f97316';
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
  const count = wk.unspentLoadItems?.length ?? 0;
  if (count === 0) return '';
  return `
    <div id="plan-carry-over-card" style="margin:12px 16px 0;padding:12px 14px;border-radius:12px;background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.3);display:flex;align-items:flex-start;justify-content:space-between;gap:10px;cursor:pointer">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;color:var(--c-caution);margin-bottom:2px">Unresolved load from last week</div>
        <div style="font-size:11px;color:var(--c-muted)">${count} cross-training ${count === 1 ? 'activity' : 'activities'} carried over — tap to adjust this week</div>
      </div>
      <button id="plan-carry-over-dismiss" style="flex-shrink:0;background:none;border:none;cursor:pointer;padding:0;color:var(--c-muted);font-size:16px;line-height:1;opacity:0.6" aria-label="Dismiss">×</button>
    </div>`;
}

// ─── Adjust week row ─────────────────────────────────────────────────────────

function buildAdjustWeekRow(wk: Week | undefined, s: SimulatorState): string {
  const isCurrentWeek = wk?.w === s.w;
  if (!isCurrentWeek) return '';

  const _hasAutoMod = (wk?.workoutMods ?? []).some(m => m.modReason?.startsWith('Auto:'));
  const _plannedB = wk ? computePlannedSignalB(
    s.historicWeeklyTSS, s.ctlBaseline, wk.ph ?? 'base',
    s.athleteTierOverride ?? s.athleteTier, s.rw, undefined, undefined, s.sportBaselineByType,
  ) : 0;
  const _excess = wk ? getWeeklyExcess(wk, _plannedB, s.planStartDate) : 0;
  const _hasPendingExcess = _excess > 15 && !_hasAutoMod;

  // Only show when total week Signal B is meaningfully above planned — timing mods are surfaced inline.
  if (!_hasPendingExcess) return '';

  const label = _excess > 0 ? `Resolve ${Math.round(_excess)} TSS extra load` : 'Resolve extra load';

  return `
    <div style="padding:10px 16px 0">
      <button id="plan-adjust-week-btn" style="width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--c-caution);background:rgba(245,158,11,0.06);color:var(--c-caution);font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f);text-align:left">
        ${label} →
      </button>
    </div>`;
}

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
      getTrailingEffortScore(s.wks, viewWeek), wk.scheduledAcwrStatus,
    )
    : [];

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

  const dateRange = fmtWeekRange(s.planStartDate, viewWeek);
  const phase = wk?.ph ? phaseLabel(wk.ph) : '';
  // Week load — Signal B (full physiological, all sports) for all weeks
  // Using Signal B everywhere so the bar always matches what the breakdown sheet shows.
  const _weekTotalTSS = wk ? Math.round(computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate)) : 0;
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
  const canGoBack = viewWeek > 1;
  const canGoForward = viewWeek < s.tw;
  const injured = isInjuryActive();
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  const navBtn = (dir: 'prev' | 'next', enabled: boolean) => `
    <button id="plan-week-${dir}" class="plan-nav-btn"
      style="width:32px;height:32px;border-radius:50%;border:1px solid ${enabled ? 'var(--c-border-strong)' : 'var(--c-border)'};background:transparent;display:flex;align-items:center;justify-content:center;cursor:${enabled ? 'pointer' : 'default'};opacity:${enabled ? '1' : '0.25'}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        ${dir === 'prev' ? '<path d="M15 18l-6-6 6-6"/>' : '<path d="M9 18l6-6-6-6"/>'}
      </svg>
    </button>
  `;

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">

      <!-- Header -->
      <div style="padding:14px 18px 0;border-bottom:1px solid var(--c-border)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div>
            <div style="font-size:18px;font-weight:600;letter-spacing:-0.02em;line-height:1.1">
              Week ${viewWeek} of ${s.tw}
              ${!isCurrentWeek ? `<span style="font-size:12px;font-weight:500;color:var(--c-accent);margin-left:6px">← viewing</span>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap">
              ${wk?.ph ? phaseBadge(wk.ph) : ''}
              ${dateRange ? `<span style="font-size:11px;color:var(--c-faint);font-weight:500">${dateRange}</span>` : ''}
            </div>
            ${weekLoadBar}
            ${viewWeek < s.w ? `<button id="plan-jump-current" style="margin-top:4px;background:transparent;border:none;padding:0;font-size:11px;font-weight:600;color:var(--c-accent);cursor:pointer;letter-spacing:0.01em;display:flex;align-items:center;gap:3px">&#8594; This week</button>` : ''}
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${buildInjuryHeaderBtn(injured)}
            ${buildWrapUpWeekBtn(s, workouts, viewWeek)}
            ${viewWeek < s.w ? `<button id="plan-edit-week-btn" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border);background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer" title="Edit week">&#9998;</button>` : ''}
            ${isCurrentWeek && s.w > 1 ? `<button id="plan-review-week-btn" style="height:32px;padding:0 12px;border-radius:16px;border:1px solid var(--c-border);background:transparent;font-size:11px;font-weight:600;color:var(--c-muted);cursor:pointer;letter-spacing:0.02em">Review past week</button>` : ''}
            ${navBtn('prev', canGoBack)}
            ${navBtn('next', canGoForward)}
            <button id="plan-account-btn" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;letter-spacing:0.02em;cursor:pointer;color:var(--c-black);font-family:var(--f)">${initials || 'Me'}</button>
          </div>
        </div>

        <!-- 7-day calendar strip -->
        ${buildCalendarStrip(workouts, rated, viewWeek, s.w)}
      </div>

      <!-- Workout card list -->
      <div id="plan-card-list" style="background:var(--c-bg)">
        ${buildCarryOverCard(wk)}
        ${buildAdjustWeekRow(wk, s)}
        ${buildInjuryBanner()}
        ${buildMorningPainCheck()}
        ${buildBenchmarkPanel(s)}
        ${buildWorkoutCards(s, workouts, viewWeek)}
        ${buildActivityLog(wk, viewWeek, s.w)}
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

  // Load bar (all weeks) → breakdown sheet
  document.getElementById('plan-load-bar-row')?.addEventListener('click', () => {
    showLoadBreakdownSheet(s, viewWeek);
  });

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
  document.getElementById('plan-edit-week-btn')?.addEventListener('click', () => {
    const sheet = document.createElement('div');
    sheet.id = 'plan-edit-week-sheet';
    sheet.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:var(--c-surface);border-radius:16px 16px 0 0;padding:24px 20px 40px;box-shadow:0 -4px 24px rgba(0,0,0,0.12)';
    sheet.innerHTML = `
      <div style="width:36px;height:4px;background:var(--c-border);border-radius:2px;margin:0 auto 20px"></div>
      <div style="font-size:17px;font-weight:600;letter-spacing:-0.01em;margin-bottom:10px">Edit past week</div>
      <div style="font-size:14px;color:var(--c-muted);line-height:1.5">Tap a session card to mark it as done or skipped. Watch-synced sessions are locked.</div>
      <button id="plan-edit-week-close" style="margin-top:24px;width:100%;padding:13px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:15px;font-weight:500;cursor:pointer;color:var(--c-black);font-family:var(--f)">Close</button>
    `;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.35)';
    const close = () => { sheet.remove(); overlay.remove(); };
    overlay.addEventListener('click', close);
    sheet.querySelector('#plan-edit-week-close')?.addEventListener('click', close);
    document.body.appendChild(overlay);
    document.body.appendChild(sheet);
  });

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
  document.getElementById('plan-report-injury')?.addEventListener('click', () => openInjuryModal());
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

  // Benchmark panel
  document.getElementById('btn-benchmark-skip')?.addEventListener('click', () => {
    skipBenchmark();
    renderPlanView();
  });
  document.getElementById('btn-benchmark-auto')?.addEventListener('click', () => {
    const s = getState();
    const garminRun = findGarminRunForWeek(s.w);
    if (garminRun) {
      const options = getBenchmarkOptions((s.onboarding as any)?.trainingFocus, (s.onboarding as any)?.experienceLevel);
      const recommended = options.find((o: any) => o.recommended);
      const type = recommended?.type || 'easy_checkin';
      recordBenchmark(type as any, 'garmin', (garminRun as any).distance_km, (garminRun as any).duration_min * 60);
    }
  });
  document.querySelectorAll('.btn-benchmark-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const bmType = (btn as HTMLElement).dataset.bmType;
      if (bmType) showBenchmarkEntryModal(bmType);
    });
  });

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

  // Calendar strip — tap day → scroll to that card
  document.querySelectorAll('.plan-day-pill').forEach(el => {
    el.addEventListener('click', () => {
      const dayIdx = el.getAttribute('data-day');
      const card = document.getElementById(`plan-day-${dayIdx}`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Start button — go to record view
  document.querySelectorAll('.plan-start-btn').forEach(el => {
    el.addEventListener('click', () => {
      import('./record-view').then(({ renderRecordView }) => renderRecordView());
    });
  });

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
  document.getElementById('plan-review-btn')?.addEventListener('click', () => {
    openActivityReReview(() => renderPlanView());
  });
  document.getElementById('plan-review-btn-2')?.addEventListener('click', () => {
    openActivityReReview(() => renderPlanView());
  });


  // Wrap up week (Sunday / all-done pill in header)
  document.getElementById('plan-wrap-up-btn')?.addEventListener('click', () => {
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
      renderActivityDetail(actual, actual.workoutName || actual.displayName || workoutKey, 'plan', plannedTSSAttr || undefined);
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
