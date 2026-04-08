/**
 * Week-End Debrief
 *
 * A focused modal that fires once at the end of each training week.
 * Replaces the welcome-back modal (ISSUE-81).
 *
 * Trigger paths:
 *   1. User taps "Wrap up week" button in the current week header (plan-view)
 *      → mode 'complete': CTA calls next() to advance the week
 *   2. Auto: on app open on Monday after week advance (guarded by lastDebriefWeek)
 *      → mode 'review': CTA just closes and records the debrief
 *   3. Auto: on plan-view render on Sunday (guarded by lastDebriefShownDate)
 *      → mode 'complete'
 *
 * Content:
 *   - Distance completed
 *   - Total training load (TSS)
 *   - Running Fitness (CTL value + delta)
 *   - Effort trend — if effortScore significantly off, offer one pacing adjustment
 *   - Next week preview (phase + planned TSS)
 *
 * Internal names (ATL/CTL/TSB/rpeAdj) must NOT appear in user-facing copy.
 */

import { getState, getMutableState, saveState } from '@/state';
import { computeFitnessModel, computeWeekTSS, computeWeekRawTSS, computePlannedWeekTSS, computePlannedSignalB } from '@/calculations/fitness-model';
import { formatKm } from '@/utils/format';
import { renderHomeView } from '@/ui/home-view';
import { next } from '@/ui/events';
import { computeWeekSignals, getSignalPills, getCoachCopy, PILL_COLORS, type SignalPill } from '@/calculations/coach-insight';

// ─── Phase helpers (local — same mapping as plan-view) ────────────────────────

const PHASE_LABEL: Record<string, string> = {
  base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper',
};
const PHASE_COLORS: Record<string, { bg: string; text: string }> = {
  base:  { bg: 'rgba(59,130,246,0.1)',  text: '#2563EB' },
  build: { bg: 'rgba(249,115,22,0.1)',  text: '#EA580C' },
  peak:  { bg: 'rgba(239,68,68,0.1)',   text: '#DC2626' },
  taper: { bg: 'rgba(34,197,94,0.1)',   text: '#16A34A' },
};

function phaseBadge(ph: string): string {
  if (!ph) return '';
  const label = PHASE_LABEL[ph] || ph;
  const c = PHASE_COLORS[ph] ?? { bg: 'rgba(0,0,0,0.06)', text: 'var(--c-muted)' };
  return `<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:${c.bg};color:${c.text}">${label}</span>`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if the week-end debrief should fire automatically (missed-week path).
 * Returns true if the completed week has not yet been debriefed.
 */
export function shouldAutoDebrief(): boolean {
  const s = getState() as any;
  const completedWeek = (s.w ?? 1) - 1; // previous week (now complete)
  if (completedWeek < 1) return false;
  if ((s.lastDebriefWeek ?? 0) >= completedWeek) return false;
  return true;
}

/**
 * Check if the Sunday end-of-week debrief should auto-show.
 * Returns true when:
 *   - Today is Sunday (ourDay() === 6)
 *   - The debrief hasn't been auto-shown today yet
 */
export function shouldShowSundayDebrief(): boolean {
  const s = getState() as any;
  if (!s.wks || !s.w || !s.hasCompletedOnboarding) return false;
  const js = new Date().getDay();
  const isSunday = js === 0; // Sunday in JS land
  if (!isSunday) return false;
  const today = new Date().toISOString().split('T')[0];
  if ((s.lastDebriefShownDate ?? '') === today) return false;
  return true;
}

/**
 * Show the week-end debrief.
 *
 * @param forWeek   Week number to summarise. Defaults to s.w - 1 (auto/review path).
 *                  Pass s.w for the Sunday/complete path.
 * @param mode      'complete' → CTA calls next() to advance week.
 *                  'review'  → CTA just closes and records (week already advanced).
 */
export function showWeekDebrief(forWeek?: number, mode: 'complete' | 'review' = 'review'): void {
  const s = getState() as any;
  const weekNum = forWeek ?? (s.w ?? 1) - 1;
  if (weekNum < 1 || !s.wks?.[weekNum - 1]) return;

  // Mark as shown today (prevents auto re-fire on same day even if cancelled)
  const ms = getMutableState() as any;
  ms.lastDebriefShownDate = new Date().toISOString().split('T')[0];
  saveState();

  const wk = s.wks[weekNum - 1];
  const nextWk = s.wks[weekNum] ?? null;

  // ── Compute metrics ────────────────────────────────────────────────────────

  const tier = s.athleteTierOverride ?? s.athleteTier;
  const atlSeedMultiplier = 1 + Math.min(0.1 * (s.gs ?? 0), 0.3);
  const atlSeed = (s.ctlBaseline ?? 0) * atlSeedMultiplier;
  const metrics = computeFitnessModel(
    s.wks ?? [], s.w ?? 1, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed,
  );
  const ctlNow  = metrics[weekNum - 1]?.ctl  ?? null;
  const ctlPrev = metrics[weekNum - 2]?.ctl  ?? null;
  const ctlDelta = ctlNow != null && ctlPrev != null ? Math.round((ctlNow - ctlPrev) * 10) / 10 : null;
  // Display CTL as daily-equivalent (÷7)
  const ctlDisplay = ctlNow != null ? Math.round((ctlNow / 7) * 10) / 10 : null;

  // Signal B (raw physiological TSS — all sports, no runSpec discount)
  const weekRawTSS = Math.round(computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate));
  // Signal A (run-equivalent, still needed for coach signals)
  const actualTSS = wk.actualTSS ?? computeWeekTSS(wk, wk.rated ?? {}, s.planStartDate);
  // Signal B planned — must match the denominator used in the plan bar
  const plannedTSS = computePlannedSignalB(
    s.historicWeeklyTSS, s.ctlBaseline, wk.ph, tier, s.rw, undefined, undefined, s.sportBaselineByType,
  );
  // % of plan: Signal B actual vs Signal B planned (never mix signals)
  // Expressed as delta from plan (e.g. +14% means 14% over, -10% means 10% under)
  const tssPct = plannedTSS > 0 ? Math.round((weekRawTSS / plannedTSS) * 100) - 100 : null;

  // Distance: use wk.completedKm if set, otherwise sum garminActuals
  const rawKm = wk.completedKm
    ?? Object.values(wk.garminActuals ?? {}).reduce((sum: number, a: any) => sum + (a.distanceKm ?? 0), 0);
  const distanceKm = rawKm > 0 ? Math.round(rawKm * 10) / 10 : null;

  const effortScore: number | null = wk.effortScore ?? null;
  const effortHigh  = effortScore != null && effortScore >  1.0;
  const effortLow   = effortScore != null && effortScore < -1.0;
  const showPacing  = effortHigh || effortLow;

  // ── Coach insight ──────────────────────────────────────────────────────────
  const _actuals = Object.values(wk.garminActuals ?? {}) as any[];
  const _hrDriftVals = _actuals
    .map((a: any) => a.hrDrift)
    .filter((v: any) => typeof v === 'number' && !isNaN(v));
  const _avgHrDrift = _hrDriftVals.length > 0
    ? _hrDriftVals.reduce((acc: number, v: number) => acc + v, 0) / _hrDriftVals.length
    : null;
  const _signals = computeWeekSignals(effortScore, tssPct, ctlDelta, _avgHrDrift);
  const _pills = getSignalPills(_signals);
  const _coachCopy = getCoachCopy(_signals, wk.ph);

  const _pillsHtml = _pills.map((p: SignalPill) => {
    const c = PILL_COLORS[p.color];
    return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:3px 9px;border-radius:10px;background:${c.bg};color:${c.text};white-space:nowrap"><span style="font-size:9px;opacity:0.6;letter-spacing:0.04em">${p.label.toUpperCase()}</span>${p.value}</span>`;
  }).join('');

  // Hide coach block when the effort adjustment prompt is already showing — avoids duplicate messaging
  const coachBlock = !showPacing && (_pills.length > 0 || _coachCopy) ? `
    <div style="margin-top:16px;padding:14px;background:rgba(0,0,0,0.03);border-radius:10px">
      ${_pills.length > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:6px${_coachCopy ? ';margin-bottom:10px' : ''}">${_pillsHtml}</div>` : ''}
      ${_coachCopy ? `<p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0">${_coachCopy}</p>` : ''}
    </div>
  ` : '';

  // Next week preview
  const nextPhase    = nextWk?.ph ?? null;
  const nextPlanned  = nextWk ? computePlannedWeekTSS(
    s.historicWeeklyTSS, s.ctlBaseline, nextWk.ph, tier, s.rw,
  ) : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  const tssColor = tssPct == null ? 'var(--c-muted)'
    : tssPct > 0   ? 'var(--c-warn)'
    : tssPct >= -20 ? 'var(--c-ok)'
    : 'var(--c-caution)';

  const ROW = 'display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--c-border)';
  const LABEL_STYLE = 'font-size:14px;color:var(--c-muted);font-weight:500';
  const VALUE_STYLE = 'font-size:15px;font-weight:700;letter-spacing:-0.02em';

  // Running Fitness row: show current value and delta
  const fitnessValue = ctlDisplay != null
    ? ctlDisplay.toString()
    : '—';
  const fitnessDelta = ctlDelta != null && ctlDelta !== 0
    ? `<span style="font-size:12px;font-weight:500;color:${ctlDelta > 0 ? 'var(--c-ok)' : 'var(--c-warn)'};margin-left:4px">${ctlDelta > 0 ? '↑' : '↓'} ${Math.abs(ctlDelta)}</span>`
    : '';

  const effortBlock = showPacing ? `
    <div style="margin-top:16px;padding:14px;background:rgba(0,0,0,0.04);border-radius:10px">
      <p style="font-size:14px;line-height:1.5;margin:0 0 12px;color:var(--c-black)">${
        effortHigh
          ? 'Your runs felt harder than planned this week. Adjust pacing down for next week?'
          : 'Your runs felt easier than planned. Adjust pacing up slightly?'
      }</p>
      <label style="display:flex;align-items:center;gap:10px;font-size:14px;font-weight:500;cursor:pointer">
        <input type="checkbox" id="debrief-pacing-toggle" checked style="width:18px;height:18px;accent-color:var(--c-accent)">
        <span>${effortHigh ? 'Ease back on target paces' : 'Push slightly harder'}</span>
      </label>
    </div>
  ` : '';

  const nextWeekBlock = nextPhase ? `
    <div style="margin-top:16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--c-muted);font-weight:500">Next week</span>
      ${phaseBadge(nextPhase)}
      ${nextPlanned ? `<span style="font-size:12px;color:var(--c-muted)">~${Math.round(nextPlanned)} TSS planned</span>` : ''}
    </div>
  ` : '';

  const ctaLabel = mode === 'complete' ? 'Complete week →' : 'Continue →';

  const html = `
    <div id="week-debrief-modal"
      style="position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.45);
             display:flex;align-items:center;justify-content:center;padding:20px">
      <div style="width:100%;max-width:400px;background:var(--c-surface);
                  border-radius:20px;padding:24px 20px 20px;
                  box-shadow:0 8px 40px rgba(0,0,0,0.18);
                  max-height:85vh;overflow-y:auto">

        <!-- Header -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
          <div style="display:flex;align-items:center;gap:8px">
            ${wk.ph ? phaseBadge(wk.ph) : ''}
            <span style="font-size:17px;font-weight:700;letter-spacing:-0.02em">Week ${weekNum}</span>
          </div>
          <button id="debrief-cancel"
            style="width:28px;height:28px;border-radius:50%;border:1px solid var(--c-border);
                   background:none;cursor:pointer;font-size:14px;color:var(--c-muted);
                   display:flex;align-items:center;justify-content:center;flex-shrink:0">✕</button>
        </div>

        <!-- Metrics -->
        <div style="border-top:1px solid var(--c-border)">
          ${distanceKm != null ? `
          <div style="${ROW}">
            <span style="${LABEL_STYLE}">Distance</span>
            <span style="${VALUE_STYLE}">${formatKm(distanceKm, s.unitPref ?? 'km')}</span>
          </div>` : ''}
          <div style="${ROW}">
            <span style="${LABEL_STYLE}">Training load</span>
            <span style="${VALUE_STYLE};color:${tssColor}">${weekRawTSS}${tssPct != null ? `<span style="font-size:12px;font-weight:500;color:${tssColor};margin-left:4px">(${tssPct > 0 ? '+' : ''}${tssPct}% vs plan)</span>` : ''}</span>
          </div>
          <div style="${ROW};border-bottom:none">
            <span style="${LABEL_STYLE}">Running fitness</span>
            <span style="${VALUE_STYLE}">${fitnessValue}${fitnessDelta}</span>
          </div>
        </div>

        ${coachBlock}
        ${effortBlock}
        ${nextWeekBlock}

        <div id="debrief-cta-area" style="margin-top:20px">
          <button id="debrief-continue"
            style="width:100%;padding:14px;border-radius:12px;border:none;
                   background:var(--c-accent);color:#fff;font-size:15px;font-weight:600;
                   cursor:pointer;font-family:var(--f);letter-spacing:-0.01em">${ctaLabel}</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', html);
  _wireHandlers(weekNum, effortScore, showPacing, mode);
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

function _wireHandlers(
  weekNum: number,
  effortScore: number | null,
  showPacing: boolean,
  mode: 'complete' | 'review',
): void {
  document.getElementById('debrief-cancel')?.addEventListener('click', () => {
    document.getElementById('week-debrief-modal')?.remove();
    // Do NOT set lastDebriefWeek — cancel means "I'll come back to this"
  });

  document.getElementById('debrief-continue')?.addEventListener('click', () => {
    if (showPacing) {
      const toggle = document.getElementById('debrief-pacing-toggle') as HTMLInputElement | null;
      if (toggle?.checked && effortScore != null) {
        _applyPacingAdj(effortScore);
      }
    }
    if (mode === 'complete') {
      _handleUncompletedSessions(weekNum, mode);
    } else {
      _closeAndRecord(weekNum, mode);
    }
  });
}

/**
 * Check for uncompleted sessions and either show a prompt or proceed directly.
 */
function _handleUncompletedSessions(weekNum: number, mode: 'complete' | 'review'): void {
  const s = getMutableState() as any;
  const wk = s.wks?.[weekNum - 1];
  if (!wk) {
    _closeAndRecord(weekNum, mode);
    return;
  }

  const workouts: any[] = wk.workouts ?? [];
  const rated: Record<string, any> = wk.rated ?? {};

  // Find sessions already pushed from THIS week to next (to avoid double-push)
  const alreadyPushedIds = new Set<string>(
    (wk.skip ?? []).map((entry: any) => entry.workout?.id).filter(Boolean)
  );

  // Uncompleted = not rated AND not already in this week's skip array
  const uncompleted = workouts.filter((w: any) => {
    const id = w.id || w.n;
    return rated[id] === undefined && !alreadyPushedIds.has(id);
  });

  if (uncompleted.length === 0) {
    _closeAndRecord(weekNum, mode);
    return;
  }

  // Show inline prompt inside the debrief modal
  const ctaArea = document.getElementById('debrief-cta-area');
  if (!ctaArea) {
    _closeAndRecord(weekNum, mode);
    return;
  }

  const count = uncompleted.length;
  const label = count === 1 ? '1 session' : `${count} sessions`;
  ctaArea.innerHTML = `
    <p style="font-size:14px;color:var(--c-black);margin:0 0 14px;text-align:center">
      ${label} weren't completed this week. What would you like to do?
    </p>
    <div style="display:flex;gap:10px;justify-content:center">
      <button id="debrief-push-sessions" class="m-btn-primary" style="flex:1;font-size:14px;padding:12px 0;text-align:center">Move to next week</button>
      <button id="debrief-drop-sessions" class="m-btn-secondary" style="flex:1;font-size:14px;padding:12px 0;text-align:center;opacity:0.7">Drop them</button>
    </div>
  `;

  document.getElementById('debrief-push-sessions')?.addEventListener('click', () => {
    const nextWk = s.wks?.[weekNum]; // index weekNum = week weekNum+1
    if (nextWk) {
      for (const w of uncompleted) {
        const id = w.id || w.n;
        // Mark as skipped in this week
        if (!wk.rated) wk.rated = {};
        wk.rated[id] = 'skip';
        // Push to next week's skip list
        if (!nextWk.skip) nextWk.skip = [];
        nextWk.skip.push({
          n: w.n || '',
          t: w.t || 'easy',
          workout: {
            id,
            n: w.n || '',
            t: w.t || 'easy',
            d: w.d || '',
            rpe: w.rpe || w.r || 5,
            r: w.rpe || w.r || 5,
            dayOfWeek: w.dayOfWeek,
            dayName: w.dayName || '',
          },
          skipCount: 1,
        });
      }
      saveState();
    }
    _closeAndRecord(weekNum, mode);
  });

  document.getElementById('debrief-drop-sessions')?.addEventListener('click', () => {
    _closeAndRecord(weekNum, mode);
  });
}

/**
 * Apply a small rpeAdj change proportional to effortScore.
 * Cap at ±0.5 VDOT per adjustment to prevent overcorrection.
 */
function _applyPacingAdj(effortScore: number): void {
  const s = getMutableState() as any;
  const adj = Math.max(-0.5, Math.min(0.5, -effortScore * 0.25));
  s.rpeAdj = (s.rpeAdj ?? 0) + adj;
  saveState();
}

function _closeAndRecord(weekNum: number, mode: 'complete' | 'review'): void {
  const s = getMutableState() as any;
  s.lastDebriefWeek = weekNum;
  saveState();
  document.getElementById('week-debrief-modal')?.remove();
  if (mode === 'complete') {
    next(); // triggers setOnWeekAdvance callback → re-renders plan view
  } else {
    import('@/ui/plan-view').then(({ renderPlanView }) => renderPlanView());
  }
}
