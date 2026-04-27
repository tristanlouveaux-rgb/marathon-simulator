/**
 * Week-End Debrief — 3-step flow
 *
 * Step 1: Week Summary (metrics, signals, coach copy)
 * Step 2: Analysis Animation (~2.5s checklist with progress bar)
 * Step 3: Suggested Plan (adjusted vs standard, change annotations)
 *
 * Trigger paths:
 *   1. User taps "Wrap up week" button in the current week header (plan-view)
 *      → mode 'complete': CTA calls next() to advance the week
 *   2. Auto: on app open on Monday after week advance (guarded by lastDebriefWeek)
 *      → mode 'review': CTA just closes and records the debrief
 *   3. Auto: on plan-view render on Sunday (guarded by lastDebriefShownDate)
 *      → mode 'complete'
 *
 * Internal names (ATL/CTL/TSB/rpeAdj) must NOT appear in user-facing copy.
 */

import { getState, getMutableState, saveState } from '@/state';
import { computeFitnessModel, computeWeekTSS, computeWeekRawTSS, computePlannedWeekTSS, computePlannedSignalB, getTrailingEffortScore } from '@/calculations/fitness-model';
import { formatKm } from '@/utils/format';
import { next } from '@/ui/events';
import { computeWeekSignals, getSignalPills, getCoachCopy, PILL_COLORS, type SignalPill } from '@/calculations/coach-insight';
import { detectEasyDriftPattern } from '@/calculations/daily-coach';
import { planWeekSessions, effortMultiplier } from '@/workouts/plan_engine';
import { intentToWorkout, type SessionIntent } from '@/workouts/intent_to_workout';
import { generateWeekWorkouts } from '@/workouts/generator';
import { getHREffort } from '@/calculations/activity-matcher';

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

// ─── Constants ────────────────────────────────────────────────────────────────

const CARD = `background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)`;

const ANALYSIS_STEPS = [
  'Analysing heart rate data',
  'Comparing pace vs HR targets',
  'Factoring in RPE feedback',
  'Evaluating training load vs plan',
  'Checking recovery signals',
  'Building next week',
];

const STEP_DELAY_MS = 500; // time per analysis step
const RING_RADIUS = 56;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS; // ~351.86
const TOTAL_ANIMATION_MS = ANALYSIS_STEPS.length * STEP_DELAY_MS + 600; // total ring fill duration

// ─── Public API ───────────────────────────────────────────────────────────────

export function shouldAutoDebrief(): boolean {
  const s = getState() as any;
  const completedWeek = (s.w ?? 1) - 1;
  if (completedWeek < 1) return false;
  if ((s.lastDebriefWeek ?? 0) >= completedWeek) return false;
  return true;
}

/**
 * True when week `weekNum` still has Garmin/Strava activities awaiting the user's
 * matching decision (garminMatched[id] === '__pending__'). Auto-debrief must not
 * fire while these exist — the debrief summary would show incomplete load data
 * and overlay the matching screen.
 */
export function hasUnresolvedActivityAssignments(weekNum: number): boolean {
  const s = getState() as any;
  const wk = s.wks?.[weekNum - 1];
  if (!wk?.garminPending?.length) return false;
  const matched = wk.garminMatched ?? {};
  return wk.garminPending.some((p: any) => (matched[p.garminId] ?? '__pending__') === '__pending__');
}

/**
 * Fire the auto-debrief if safe: no matching screen is open, no debrief is
 * already mounted, and the target week has no unassigned activities. Called
 * from the launch path and from activity-review's onComplete — so the debrief
 * waits for the user to finish matching before popping.
 */
export function fireDebriefIfReady(pendingDebrief: boolean): void {
  if (document.getElementById('week-debrief-modal')) return;
  if (document.getElementById('activity-review-overlay')) return;
  const s = getState() as any;
  const targetWeek = pendingDebrief ? (s.w ?? 1) : (s.w ?? 1) - 1;
  if (targetWeek >= 1 && hasUnresolvedActivityAssignments(targetWeek)) return;
  if (pendingDebrief) {
    showWeekDebrief(s.w, 'complete');
  } else if (shouldAutoDebrief()) {
    showWeekDebrief();
  }
}

export function shouldShowSundayDebrief(): boolean {
  const s = getState() as any;
  if (!s.wks || !s.w || !s.hasCompletedOnboarding) return false;
  const js = new Date().getDay();
  const isSunday = js === 0;
  if (!isSunday) return false;
  const today = new Date().toISOString().split('T')[0];
  if ((s.lastDebriefShownDate ?? '') === today) return false;
  return true;
}

/**
 * Show the week-end debrief (Step 1: Summary).
 */
export function showWeekDebrief(
  forWeek?: number,
  mode: 'complete' | 'review' = 'review',
  debugOverride?: { effort?: number; acwrStatus?: 'safe' | 'caution' | 'high' },
): void {
  // Dedupe: if a debrief modal is already mounted, don't stack another (breaks handlers).
  if (document.getElementById('week-debrief-modal')) return;
  const s = getState() as any;
  const weekNum = forWeek ?? (s.w ?? 1) - 1;
  if (weekNum < 1 || !s.wks?.[weekNum - 1]) {
    return;
  }

  // Just-Track mode: show a retrospective-only variant. No plan-adherence,
  // no "next week" preview. Just this-week-vs-last-week deltas.
  if (s.trackOnly) {
    showTrackOnlyRetrospective(weekNum);
    return;
  }

  const wk = s.wks[weekNum - 1];

  // ── Compute metrics ──────────────────────────────────────────────────────

  const tier = s.athleteTierOverride ?? s.athleteTier;
  const atlSeedMultiplier = 1 + Math.min(0.1 * (s.gs ?? 0), 0.3);
  const atlSeed = (s.ctlBaseline ?? 0) * atlSeedMultiplier;
  const metrics = computeFitnessModel(
    s.wks ?? [], s.w ?? 1, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed,
  );
  const ctlNow  = metrics[weekNum - 1]?.ctl  ?? null;
  const ctlPrev = metrics[weekNum - 2]?.ctl  ?? null;
  const ctlDelta = ctlNow != null && ctlPrev != null ? Math.round((ctlNow - ctlPrev) * 10) / 10 : null;
  const ctlDisplay = ctlNow != null ? Math.round((ctlNow / 7) * 10) / 10 : null;

  const weekRawTSS = Math.round(computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate));
  const plannedTSS = computePlannedSignalB(
    s.historicWeeklyTSS, s.ctlBaseline, wk.ph, tier, s.rw, undefined, undefined, s.sportBaselineByType,
  );
  const tssPct = plannedTSS > 0 ? Math.round((weekRawTSS / plannedTSS) * 100) - 100 : null;

  const rawKm = wk.completedKm
    ?? Object.values(wk.garminActuals ?? {}).reduce((sum: number, a: any) => sum + (a.distanceKm ?? 0), 0);
  const distanceKm = rawKm > 0 ? Math.round(rawKm * 10) / 10 : null;

  // Compute RPE effort and HR effort separately — two distinct signals.
  // RPE effort: how hard users rated workouts vs expected (deviation scale, +/- from 0).
  // HR effort: average hrEffortScore from garminActuals (1.0 = on target, >1.0 = overcooked).
  let rpeScore: number | null = wk.rpeEffort ?? wk.effortScore ?? null; // prefer pure RPE, fall back to legacy blend
  let avgHrEffort: number | null = null;

  // Compute on-the-fly from this week's data (always prefer fresh over stored).
  const _RUN_TYPES = new Set(['RUNNING', 'TREADMILL_RUNNING', 'TRAIL_RUNNING', 'VIRTUAL_RUN', 'TRACK_RUNNING']);
  const _nonRunTypes = ['cross', 'cross_training', 'strength', 'rest', 'capacity_test', 'gym'];
  {
    // Generate workouts the same way events.ts does (wk.workouts is not populated until advance)
    const prevSkips = weekNum > 1 ? (s.wks[weekNum - 2]?.skip ?? []) : [];
    const injuryState = s.injuryState?.active ? s.injuryState : null;
    const weekWos = generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, prevSkips, s.commuteConfig,
      injuryState, s.recurringActivities, s.onboarding?.experienceLevel,
      undefined, undefined, weekNum, s.tw, undefined, s.gs,
      getTrailingEffortScore(s.wks, weekNum), wk.scheduledAcwrStatus,
    );
    // Apply mods so replaced workouts have correct RPE
    if (wk.workoutMods) {
      for (const mod of wk.workoutMods as any[]) {
        const wo = weekWos.find((w: any) => w.n === mod.name && (mod.dayOfWeek == null || w.dayOfWeek === mod.dayOfWeek));
        if (wo && mod.newRpe != null) { (wo as any).rpe = mod.newRpe; (wo as any).r = mod.newRpe; }
      }
    }
    const allRunsForEffort = [
      ...weekWos,
      ...(wk.adhocWorkouts ?? []).filter((w: any) => w.id?.startsWith('garmin-') && !_nonRunTypes.includes(w.t)),
    ];

    let rpeTotalDev = 0, rpeCount = 0;
    let hrTotal = 0, hrCount = 0;

    // RPE: iterate workouts to get correct expected RPE (same as events.ts)
    for (const wo of allRunsForEffort) {
      if (_nonRunTypes.includes((wo as any).t)) continue;
      const wId = (wo as any).id || (wo as any).n;
      const rating = wk.rated?.[wId];
      if (typeof rating !== 'number') continue;
      const expected = (wo as any).rpe || (wo as any).r || 5;
      rpeTotalDev += rating - expected;
      rpeCount++;
    }

    // HR effort: iterate actuals for hrEffortScore (stored or computed on-the-fly)
    // Build workout lookup by ID so we can get plannedType for on-the-fly computation
    const _woById: Record<string, any> = {};
    for (const wo of allRunsForEffort) _woById[(wo as any).id || (wo as any).n] = wo;

    for (const [wId, actual] of Object.entries(wk.garminActuals ?? {}) as [string, any][]) {
      if (!_RUN_TYPES.has(actual?.activityType ?? '')) continue;
      let hrScore = actual?.hrEffortScore ?? null;
      // Compute on-the-fly if not stored but we have avgHR and a workout type
      if (hrScore == null && actual?.avgHR) {
        const woType = actual?.plannedType ?? _woById[wId]?.t ?? null;
        if (woType) hrScore = getHREffort(actual.avgHR, woType, s);
      }
      if (hrScore != null) {
        hrTotal += hrScore;
        hrCount++;
      }
    }

    if (rpeCount > 0) rpeScore = rpeTotalDev / rpeCount;
    if (hrCount > 0) avgHrEffort = hrTotal / hrCount;
  }

  // ── Coach insight ────────────────────────────────────────────────────────
  const _actuals = Object.values(wk.garminActuals ?? {}) as any[];
  const _hrDriftVals = _actuals
    .map((a: any) => a.hrDrift)
    .filter((v: any) => typeof v === 'number' && !isNaN(v));
  const _avgHrDrift = _hrDriftVals.length > 0
    ? _hrDriftVals.reduce((acc: number, v: number) => acc + v, 0) / _hrDriftVals.length
    : null;
  const _signals = computeWeekSignals(rpeScore, avgHrEffort, tssPct, ctlDelta, _avgHrDrift);
  const _pills = getSignalPills(_signals);
  const _coachCopy = getCoachCopy(_signals, wk.ph);
  const _easyDriftNote = detectEasyDriftPattern(s);

  const coachNarrative = (_coachCopy || _easyDriftNote) ? `
    <div style="margin-top:16px;padding:14px;background:rgba(0,0,0,0.03);border-radius:10px">
      ${_coachCopy ? `<p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0">${_coachCopy}</p>` : ''}
      ${_easyDriftNote ? `<p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:${_coachCopy ? '10px 0 0 0' : '0'}">${_easyDriftNote}</p>` : ''}
    </div>
  ` : '';

  // ── Render Step 1: Summary ─────────────────────────────────────────────

  // Arrow colour only — used for directional indicators, not values
  const tssArrowColor = tssPct == null ? 'var(--c-muted)'
    : tssPct > 10  ? 'var(--c-warn)'
    : tssPct >= -25 ? 'var(--c-ok)'
    : 'var(--c-caution)';

  const ROW = 'display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--c-border)';
  const LABEL_STYLE = 'font-size:14px;color:var(--c-muted);font-weight:500';
  const VALUE_STYLE = 'font-size:15px;font-weight:700;letter-spacing:-0.02em';
  const SIGNAL_VALUE = 'font-size:14px;font-weight:600;color:var(--c-black)';

  const fitnessValue = ctlDisplay != null ? ctlDisplay.toString() : '—';
  const fitnessDelta = ctlDelta != null && ctlDelta !== 0
    ? `<span style="font-size:12px;font-weight:500;color:${ctlDelta > 0 ? 'var(--c-ok)' : 'var(--c-warn)'};margin-left:4px">${ctlDelta > 0 ? '↑' : '↓'} ${Math.abs(ctlDelta)}</span>`
    : '';

  // Sort signals: green (good) → neutral → amber (caution) → red (concern)
  const _pillOrder: Record<string, number> = { green: 0, neutral: 1, amber: 2, red: 3 };
  _pills.sort((a, b) => (_pillOrder[a.color] ?? 1) - (_pillOrder[b.color] ?? 1));

  // Build signal rows for the unified table (last row drops border)
  // Coloured arrow only, value text stays neutral
  const _arrowForPill = (p: SignalPill): string => {
    const arrowColor = p.color === 'green' ? 'var(--c-ok)'
      : p.color === 'red' ? 'var(--c-warn)'
      : p.color === 'amber' ? 'var(--c-caution)'
      : '';
    if (!arrowColor) return ''; // neutral = no arrow
    const arrow = p.color === 'green' ? '↑' : p.color === 'red' ? '↓' : '→';
    return `<span style="color:${arrowColor};margin-right:4px">${arrow}</span>`;
  };

  const signalRowsHtml = _pills.map((p: SignalPill, i: number) => {
    const isLast = i === _pills.length - 1;
    return `
    <div style="${ROW}${isLast ? ';border-bottom:none' : ''}">
      <span style="${LABEL_STYLE}">${p.label}</span>
      <span style="${SIGNAL_VALUE}">${_arrowForPill(p)}${p.value}</span>
    </div>`;
  }).join('');

  // CTA label depends on mode
  const ctaLabel = mode === 'complete' ? 'Generate next week' : 'Continue →';

  const html = `
    <div id="week-debrief-modal"
      style="position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.45);
             display:flex;align-items:center;justify-content:center;padding:20px">
      <div id="debrief-card" style="width:100%;max-width:400px;background:var(--c-surface);
                  border-radius:20px;padding:24px 20px 20px;
                  box-shadow:0 8px 40px rgba(0,0,0,0.18);
                  max-height:85vh;overflow-y:auto">

        <!-- Header -->
        <div style="position:relative;text-align:center;margin-bottom:18px">
          <span style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">${wk.ph ? PHASE_LABEL[wk.ph] + ' Phase' : ''} — Week ${weekNum}</span>
          <button id="debrief-cancel"
            style="position:absolute;right:0;top:50%;transform:translateY(-50%);width:28px;height:28px;border-radius:50%;border:1px solid var(--c-border);
                   background:none;cursor:pointer;font-size:14px;color:var(--c-muted);
                   display:flex;align-items:center;justify-content:center">✕</button>
        </div>

        <!-- Unified metrics + signals table -->
        <div style="border-top:1px solid var(--c-border)">
          ${distanceKm != null ? `
          <div style="${ROW}">
            <span style="${LABEL_STYLE}">Distance</span>
            <span style="${VALUE_STYLE}">${formatKm(distanceKm, s.unitPref ?? 'km')}</span>
          </div>` : ''}
          <div style="${ROW}">
            <span style="${LABEL_STYLE}">Training load</span>
            <span style="${VALUE_STYLE}">${weekRawTSS}${tssPct != null ? `<span style="font-size:12px;font-weight:500;margin-left:4px"><span style="color:${tssArrowColor}">${tssPct > 0 ? '↑' : tssPct < 0 ? '↓' : '→'}</span> <span style="color:var(--c-muted)">${tssPct > 0 ? '+' : ''}${tssPct}% vs plan</span></span>` : ''}</span>
          </div>
          <div style="${ROW}${_pills.length === 0 ? ';border-bottom:none' : ''}">
            <span style="${LABEL_STYLE}">Running load</span>
            <span style="${VALUE_STYLE}">${fitnessValue}${fitnessDelta}</span>
          </div>
          ${signalRowsHtml}
        </div>

        ${coachNarrative}

        <div id="debrief-cta-area" style="margin-top:20px">
          <button id="debrief-continue"
            style="width:100%;padding:14px;border-radius:12px;border:none;
                   background:var(--c-black);color:#fff;font-size:15px;font-weight:600;
                   cursor:pointer;font-family:var(--f);letter-spacing:-0.01em">${ctaLabel}</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', html);
  _wireStep1Handlers(weekNum, rpeScore, mode, debugOverride);
}

// ─── Step 1 Handlers ─────────────────────────────────────────────────────────

function _wireStep1Handlers(
  weekNum: number,
  effortScore: number | null,
  mode: 'complete' | 'review',
  debugOverride?: { effort?: number; acwrStatus?: 'safe' | 'caution' | 'high' },
): void {
  document.getElementById('debrief-cancel')?.addEventListener('click', () => {
    document.getElementById('week-debrief-modal')?.remove();
  });

  document.getElementById('debrief-continue')?.addEventListener('click', () => {
    if (mode === 'complete') {
      _showAnalysisAnimation(weekNum, effortScore, mode, debugOverride);
    } else {
      _closeAndRecord(weekNum, mode);
    }
  });
}

// ─── Step 2: Analysis Animation ──────────────────────────────────────────────

function _showAnalysisAnimation(
  weekNum: number,
  effortScore: number | null,
  mode: 'complete' | 'review',
  debugOverride?: { effort?: number; acwrStatus?: 'safe' | 'caution' | 'high' },
): void {
  const card = document.getElementById('debrief-card');
  if (!card) return;

  // Build checklist HTML — circles start as light border, fill black with white tick on complete
  const stepsHtml = ANALYSIS_STEPS.map((label, i) => `
    <div id="analysis-step-${i}" style="display:flex;align-items:center;gap:12px;padding:7px 0;opacity:0;transform:translateY(4px);transition:opacity 0.3s ease,transform 0.3s ease">
      <div id="analysis-check-${i}" style="width:22px;height:22px;border-radius:50%;border:1.5px solid var(--c-border);background:transparent;
           display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.25s ease">
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none" style="opacity:0;transition:opacity 0.15s ease">
          <path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <span style="font-size:14px;color:var(--c-black);font-weight:500">${label}</span>
    </div>
  `).join('');

  const ringSize = RING_RADIUS * 2 + 16; // viewBox padding

  card.innerHTML = `
    <!-- Header -->
    <div style="position:relative;text-align:center;margin-bottom:24px">
      <span style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">Analysing week ${weekNum}</span>
      <button id="debrief-cancel"
        style="position:absolute;right:0;top:50%;transform:translateY(-50%);width:28px;height:28px;border-radius:50%;border:1px solid var(--c-border);
               background:none;cursor:pointer;font-size:14px;color:var(--c-muted);
               display:flex;align-items:center;justify-content:center">✕</button>
    </div>

    <!-- Circular progress (smooth single transition) -->
    <div style="display:flex;justify-content:center;margin-bottom:28px">
      <div style="position:relative;width:${ringSize}px;height:${ringSize}px">
        <svg width="${ringSize}" height="${ringSize}" viewBox="0 0 ${ringSize} ${ringSize}" style="transform:rotate(-90deg)">
          <circle cx="${ringSize / 2}" cy="${ringSize / 2}" r="${RING_RADIUS}" stroke="var(--c-border)" stroke-width="6" fill="none"/>
          <circle id="analysis-progress-circle" cx="${ringSize / 2}" cy="${ringSize / 2}" r="${RING_RADIUS}" stroke="var(--c-black)" stroke-width="6" fill="none"
                  stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${RING_CIRCUMFERENCE}" stroke-linecap="round"
                  style="transition:stroke-dashoffset ${TOTAL_ANIMATION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)"/>
        </svg>
        <div id="analysis-progress-label" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em">0%</div>
      </div>
    </div>

    <!-- Checklist -->
    <div style="padding:0 4px">
      ${stepsHtml}
    </div>
  `;

  // Re-wire cancel
  document.getElementById('debrief-cancel')?.addEventListener('click', () => {
    document.getElementById('week-debrief-modal')?.remove();
  });

  // Start animation
  _runAnalysisAnimation(weekNum, effortScore, mode, debugOverride);
}

function _runAnalysisAnimation(
  weekNum: number,
  effortScore: number | null,
  mode: 'complete' | 'review',
  debugOverride?: { effort?: number; acwrStatus?: 'safe' | 'caution' | 'high' },
): void {
  const total = ANALYSIS_STEPS.length;
  const progressCircle = document.getElementById('analysis-progress-circle');
  const progressLabel = document.getElementById('analysis-progress-label');

  // Kick off one smooth CSS transition for the full ring fill (0 → 100%)
  requestAnimationFrame(() => {
    if (progressCircle) {
      progressCircle.setAttribute('stroke-dashoffset', '0');
    }
  });

  // Animate the % label with requestAnimationFrame for smooth counting
  const animStart = performance.now();
  const animDuration = TOTAL_ANIMATION_MS;
  const tickLabel = () => {
    const elapsed = performance.now() - animStart;
    const pct = Math.min(100, Math.round((elapsed / animDuration) * 100));
    if (progressLabel) progressLabel.textContent = `${pct}%`;
    if (pct < 100) requestAnimationFrame(tickLabel);
  };
  requestAnimationFrame(tickLabel);

  // Step through checklist items on a timer (visual only — ring runs independently)
  for (let i = 0; i < total; i++) {
    // Fade in + slide up
    setTimeout(() => {
      const stepEl = document.getElementById(`analysis-step-${i}`);
      if (stepEl) {
        stepEl.style.opacity = '1';
        stepEl.style.transform = 'translateY(0)';
      }
    }, i * STEP_DELAY_MS);

    // Mark step complete — solid black circle, white tick
    setTimeout(() => {
      const checkEl = document.getElementById(`analysis-check-${i}`);
      if (checkEl) {
        checkEl.style.borderColor = 'var(--c-black)';
        checkEl.style.background = 'var(--c-black)';
        const svg = checkEl.querySelector('svg');
        if (svg) (svg as unknown as HTMLElement).style.opacity = '1';
      }
    }, i * STEP_DELAY_MS + STEP_DELAY_MS * 0.7);
  }

  // After all steps + ring complete, transition to plan
  setTimeout(
    () => _showPlanPreview(weekNum, effortScore, mode, debugOverride),
    TOTAL_ANIMATION_MS + 200,
  );
}

// ─── Step 3: Plan Preview ────────────────────────────────────────────────────

function _showPlanPreview(
  weekNum: number,
  effortScore: number | null,
  mode: 'complete' | 'review',
  debugOverride?: { effort?: number; acwrStatus?: 'safe' | 'caution' | 'high' },
): void {
  const card = document.getElementById('debrief-card');
  if (!card) return;

  try {
    _renderPlanPreview(card, weekNum, effortScore, mode, debugOverride);
  } catch (err) {
    card.innerHTML = `
      <div style="text-align:center;padding:24px 8px">
        <p style="font-size:14px;color:var(--c-black);margin:0 0 12px">Couldn't generate next week's plan.</p>
        <p style="font-size:12px;color:var(--c-muted);margin:0 0 16px">${(err as Error)?.message ?? 'Unknown error'}</p>
        <button id="debrief-error-close" style="padding:10px 20px;border-radius:10px;border:1px solid var(--c-border);background:transparent;cursor:pointer">Close</button>
      </div>
    `;
    document.getElementById('debrief-error-close')?.addEventListener('click', () => {
      document.getElementById('week-debrief-modal')?.remove();
    });
  }
}

function _renderPlanPreview(
  card: HTMLElement,
  weekNum: number,
  effortScore: number | null,
  mode: 'complete' | 'review',
  debugOverride?: { effort?: number; acwrStatus?: 'safe' | 'caution' | 'high' },
): void {
  const s = getState() as any;
  const nextWeekIdx = weekNum + 1; // 1-based week number for next week
  const nextWk = s.wks?.[weekNum]; // 0-based array index
  const nextPhase = nextWk?.ph ?? s.wks?.[weekNum - 1]?.ph ?? 'base';

  // Build plan context shared between adjusted and standard
  const baseCtx = {
    runsPerWeek: s.rw ?? 3,
    raceDistance: s.rd ?? 'marathon',
    runnerType: s.typ ?? 'balanced',
    phase: nextPhase,
    fitnessLevel: s.onboarding?.experienceLevel ?? 'intermediate',
    weekIndex: nextWeekIdx,
    totalWeeks: s.tw ?? 16,
    vdot: s.v ?? 45,
  };

  // Trailing effort score and ACWR status (with debug override)
  const trailingEffort = debugOverride?.effort ?? getTrailingEffortScore(s.wks ?? [], nextWeekIdx);
  const acwrStatus = debugOverride?.acwrStatus ?? nextWk?.scheduledAcwrStatus ?? 'safe';

  // Generate ADJUSTED plan (with effort + ACWR context)
  const adjustedIntents = planWeekSessions({
    ...baseCtx,
    effortScore: trailingEffort,
    acwrStatus,
  });

  // Generate STANDARD plan (no effort adjustment, no ACWR reduction)
  const standardIntents = planWeekSessions({
    ...baseCtx,
    // No effortScore, no acwrStatus — vanilla plan
  });

  // Convert intents to workouts for display
  const easyPace = s.pac?.e;
  const adjustedWorkouts = adjustedIntents.map(i => intentToWorkout(i, baseCtx.raceDistance, baseCtx.runnerType, easyPace));
  const standardWorkouts = standardIntents.map(i => intentToWorkout(i, baseCtx.raceDistance, baseCtx.runnerType, easyPace));

  // Build per-workout annotations first — they define what "visibly different" means
  const easyPaceSec = easyPace ?? 360; // fallback 6:00/km
  const perWorkoutAnnotations: string[] = adjustedIntents.map((adj, i) => {
    const std = standardIntents[i];
    if (!std) return '';
    // Different workout type = always annotate
    if (adj.slot !== std.slot) return `Was ${_sessionTypeLabel(std.slot as string).toLowerCase()} in standard plan`;
    // Compute km difference
    const adjKm = adj.totalMinutes / (easyPaceSec / 60);
    const stdKm = std.totalMinutes / (easyPaceSec / 60);
    const kmDiff = adjKm - stdKm;
    if (Math.abs(kmDiff) < 1) return ''; // < 1km = not worth showing
    return `${kmDiff < 0 ? '↓' : '↑'} ${Math.abs(Math.round(kmDiff * 10) / 10)}km vs standard`;
  });

  // Plans are "visibly different" only when at least one workout has a real annotation.
  // Sub-1km volume tweaks would render identical workout lines, so don't bother showing
  // a Standard toggle the user can't tell apart.
  const visiblyDifferent = perWorkoutAnnotations.some(a => a !== '');

  // Textual adjustments list only when plans actually look different
  const changes = visiblyDifferent
    ? _computeChanges(adjustedIntents, standardIntents, trailingEffort, acwrStatus)
    : [];

  const changesHtml = changes.length > 0 ? `
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;color:var(--c-muted);margin-bottom:6px;letter-spacing:0.02em">Adjustments</div>
      ${changes.map(c => `
        <div style="font-size:13px;color:var(--c-black);line-height:1.5;padding:1px 0">${c}</div>
      `).join('')}
    </div>
  ` : '';

  const workoutsHtml = _renderWorkoutList(adjustedWorkouts, perWorkoutAnnotations);
  const standardWorkoutsHtml = _renderWorkoutList(standardWorkouts, []);

  const noChangesNote = !visiblyDifferent ? `
    <div style="margin-bottom:16px">
      <p style="font-size:13px;color:var(--c-muted);line-height:1.5;margin:0">No adjustments needed. Recent effort and training load are tracking to plan.</p>
    </div>
  ` : '';

  card.innerHTML = `
    <!-- Header -->
    <div style="position:relative;text-align:center;margin-bottom:18px">
      <span style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">${PHASE_LABEL[nextPhase] ?? nextPhase} Phase — Week ${nextWeekIdx}</span>
      <button id="debrief-cancel"
        style="position:absolute;right:0;top:50%;transform:translateY(-50%);width:28px;height:28px;border-radius:50%;border:1px solid var(--c-border);
               background:none;cursor:pointer;font-size:14px;color:var(--c-muted);
               display:flex;align-items:center;justify-content:center">✕</button>
    </div>

    ${noChangesNote}

    <!-- Plan toggle (only if plans are visibly different) -->
    ${visiblyDifferent ? `
    <div style="display:flex;gap:0;margin-bottom:16px;border-radius:10px;overflow:hidden;border:1px solid var(--c-border)">
      <button id="plan-toggle-adjusted" style="flex:1;padding:9px 0;font-size:13px;font-weight:600;border:none;cursor:pointer;
              background:var(--c-black);color:#fff;font-family:var(--f);transition:all 0.2s ease">Adjusted plan</button>
      <button id="plan-toggle-standard" style="flex:1;padding:9px 0;font-size:13px;font-weight:600;border:none;cursor:pointer;
              background:transparent;color:var(--c-muted);font-family:var(--f);transition:all 0.2s ease">Standard plan</button>
    </div>
    ` : ''}

    <!-- Workout lists (adjustments text inside adjusted div so it hides on toggle) -->
    <div id="plan-adjusted" style="display:block">${changesHtml}${workoutsHtml}</div>
    <div id="plan-standard" style="display:none">${standardWorkoutsHtml}</div>

    <!-- CTA -->
    <div id="debrief-cta-area" style="margin-top:20px">
      <button id="debrief-accept"
        style="width:100%;padding:14px;border-radius:12px;border:none;
               background:var(--c-black);color:#fff;font-size:15px;font-weight:600;
               cursor:pointer;font-family:var(--f);letter-spacing:-0.01em">Accept plan</button>
    </div>
  `;

  _wireStep3Handlers(weekNum, effortScore, mode, visiblyDifferent);
}

function _renderWorkoutList(workouts: any[], annotations: string[]): string {
  if (workouts.length === 0) return '<p style="font-size:13px;color:var(--c-muted);text-align:center;padding:16px 0">No sessions generated</p>';

  return workouts.map((w, i) => {
    const typeLabel = _sessionTypeLabel(w.t);
    const typeBg = _sessionTypeBg(w.t);
    const annotation = annotations[i] || '';
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--c-border)">
        <span style="font-size:11px;font-weight:600;padding:3px 8px;border-radius:8px;background:${typeBg};color:var(--c-black);white-space:nowrap;min-width:56px;text-align:center">${typeLabel}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${w.n}</div>
          <div style="font-size:12px;color:var(--c-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${w.d || ''}</div>
          ${annotation ? `<div style="font-size:11px;color:var(--c-muted);margin-top:2px">${annotation}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function _sessionTypeLabel(t: string): string {
  const map: Record<string, string> = {
    easy: 'Easy', long: 'Long', threshold: 'Tempo', vo2: 'VO2',
    marathon_pace: 'MP', progressive: 'Prog', float: 'Float',
  };
  return map[t] || t;
}

function _sessionTypeBg(t: string): string {
  const map: Record<string, string> = {
    easy: 'rgba(0,0,0,0.05)',
    long: 'rgba(59,130,246,0.1)',
    threshold: 'rgba(249,115,22,0.1)',
    vo2: 'rgba(239,68,68,0.1)',
    marathon_pace: 'rgba(147,51,234,0.1)',
    progressive: 'rgba(249,115,22,0.1)',
    float: 'rgba(0,0,0,0.05)',
  };
  return map[t] || 'rgba(0,0,0,0.05)';
}

// ─── Change detection ────────────────────────────────────────────────────────

function _computeChanges(
  adjusted: SessionIntent[],
  standard: SessionIntent[],
  trailingEffort: number,
  acwrStatus: string,
): string[] {
  const changes: string[] = [];

  // 1. Effort multiplier change
  const eMult = trailingEffort !== 0 ? effortMultiplier(trailingEffort) : 1.0;
  if (eMult < 0.97) {
    const pct = Math.round((1 - eMult) * 100);
    changes.push(`Volume scaled down ${pct}% based on recent effort feedback`);
  } else if (eMult > 1.03) {
    const pct = Math.round((eMult - 1) * 100);
    changes.push(`Volume scaled up ${pct}% based on recent effort feedback`);
  }

  // 2. ACWR-driven changes
  if (acwrStatus === 'caution') {
    changes.push('1 quality session replaced with easy (training load elevated)');
  } else if (acwrStatus === 'high') {
    changes.push('2 quality sessions replaced with easy (training load high)');
    changes.push('Long run capped at last week\'s distance');
  }

  // 3. Session count difference
  const adjQuality = adjusted.filter(i => i.slot !== 'easy').length;
  const stdQuality = standard.filter(i => i.slot !== 'easy').length;
  if (adjQuality < stdQuality && acwrStatus === 'safe') {
    // Only report if not already covered by ACWR annotation
    changes.push(`Quality sessions: ${adjQuality} (down from ${stdQuality})`);
  }

  // 4. Total volume difference
  const adjTotal = adjusted.reduce((sum, i) => sum + i.totalMinutes, 0);
  const stdTotal = standard.reduce((sum, i) => sum + i.totalMinutes, 0);
  if (stdTotal > 0) {
    const volDiff = Math.round(((adjTotal - stdTotal) / stdTotal) * 100);
    if (Math.abs(volDiff) >= 5 && eMult >= 0.97 && eMult <= 1.03) {
      // Only show if not already covered by effort multiplier annotation
      changes.push(`Total session time ${volDiff > 0 ? 'up' : 'down'} ${Math.abs(volDiff)}%`);
    }
  }

  // 5. Long run difference
  const adjLong = adjusted.find(i => i.slot === 'long');
  const stdLong = standard.find(i => i.slot === 'long');
  if (adjLong && stdLong && adjLong.totalMinutes !== stdLong.totalMinutes) {
    const diff = adjLong.totalMinutes - stdLong.totalMinutes;
    if (Math.abs(diff) >= 3) {
      changes.push(`Long run ${diff < 0 ? 'reduced' : 'increased'} by ${Math.abs(diff)} min`);
    }
  }

  return changes;
}

// ─── Step 3 Handlers ─────────────────────────────────────────────────────────

function _wireStep3Handlers(
  weekNum: number,
  effortScore: number | null,
  mode: 'complete' | 'review',
  visiblyDifferent: boolean,
): void {
  // Cancel
  document.getElementById('debrief-cancel')?.addEventListener('click', () => {
    document.getElementById('week-debrief-modal')?.remove();
  });

  // Plan toggle
  if (visiblyDifferent) {
    let showingAdjusted = true;

    const btnAdj = document.getElementById('plan-toggle-adjusted');
    const btnStd = document.getElementById('plan-toggle-standard');
    const planAdj = document.getElementById('plan-adjusted');
    const planStd = document.getElementById('plan-standard');

    const setToggle = (adjusted: boolean) => {
      showingAdjusted = adjusted;
      if (btnAdj) {
        btnAdj.style.background = adjusted ? 'var(--c-black)' : 'transparent';
        btnAdj.style.color = adjusted ? '#fff' : 'var(--c-muted)';
      }
      if (btnStd) {
        btnStd.style.background = adjusted ? 'transparent' : 'var(--c-black)';
        btnStd.style.color = adjusted ? 'var(--c-muted)' : '#fff';
      }
      if (planAdj) planAdj.style.display = adjusted ? 'block' : 'none';
      if (planStd) planStd.style.display = adjusted ? 'none' : 'block';
    };

    btnAdj?.addEventListener('click', () => setToggle(true));
    btnStd?.addEventListener('click', () => setToggle(false));
  }

  // Accept
  document.getElementById('debrief-accept')?.addEventListener('click', () => {
    // Apply pacing adjustment if effort was significantly off
    if (effortScore != null && (effortScore > 1.0 || effortScore < -1.0)) {
      _applyPacingAdj(effortScore);
    }
    _closeAndRecord(weekNum, mode);
  });
}

// ─── Shared helpers (unchanged from original) ────────────────────────────────

function _applyPacingAdj(effortScore: number): void {
  const s = getMutableState() as any;
  const adj = Math.max(-0.5, Math.min(0.5, -effortScore * 0.25));
  s.rpeAdj = (s.rpeAdj ?? 0) + adj;
  saveState();
}

function _closeAndRecord(weekNum: number, mode: 'complete' | 'review'): void {
  const s = getMutableState() as any;
  s.lastDebriefWeek = weekNum;
  s.lastDebriefShownDate = new Date().toISOString().split('T')[0];
  if (mode === 'complete') {
    // Only mark week as fully debriefed (with plan preview) in complete mode.
    // This is what gates advanceWeekToToday — review-only doesn't count.
    s.lastCompleteDebriefWeek = weekNum;
  }
  saveState();
  document.getElementById('week-debrief-modal')?.remove();
  if (mode === 'complete') {
    next(); // triggers setOnWeekAdvance callback → re-renders plan view
  } else {
    import('@/ui/plan-view').then(({ renderPlanView }) => renderPlanView());
  }
}

// ─── Just-Track retrospective ─────────────────────────────────────────────────

/**
 * Minimal week-end summary for Just-Track users.
 *
 * No plan-adherence language, no "next week" preview. Just this-week-vs-
 * last-week deltas on the things a tracker cares about: volume, sessions,
 * load (TSS), CTL drift, recovery average.
 *
 * Dismiss closes the modal and records the debrief so it doesn't fire
 * again this week.
 */
function showTrackOnlyRetrospective(weekNum: number): void {
  const s = getState() as any;
  const wk = s.wks?.[weekNum - 1];
  const prev = weekNum > 1 ? s.wks?.[weekNum - 2] : null;
  if (!wk) return;

  const unit: 'km' | 'mi' = s.unitPref ?? 'km';

  function weekStats(w: any): { km: number; sessions: number; tss: number } {
    if (!w) return { km: 0, sessions: 0, tss: 0 };
    let km = 0, sessions = 0;
    for (const actual of Object.values(w.garminActuals ?? {}) as any[]) {
      km += actual.distanceKm || 0;
      sessions++;
    }
    for (const wo of (w.adhocWorkouts ?? []) as any[]) {
      const d = wo.garminDistKm ?? wo.distanceKm;
      if (typeof d === 'number') km += d;
      sessions++;
    }
    const tss = Math.round(computeWeekRawTSS(w, w.rated ?? {}, s.planStartDate));
    return { km, sessions, tss };
  }

  const cur = weekStats(wk);
  const lst = weekStats(prev);

  const ctlNow = s.ctlBaseline ?? 0;
  // CTL delta via fitness model — last full entry minus 7 days back
  const metrics = computeFitnessModel(s.wks ?? [], s.w, ctlNow, s.planStartDate, ctlNow);
  const ctlEnd = metrics[metrics.length - 1]?.ctl ?? ctlNow;
  const ctlStart = metrics[Math.max(0, metrics.length - 8)]?.ctl ?? ctlEnd;
  const ctlDelta = Math.round((ctlEnd - ctlStart) * 10) / 10;

  // Recovery average — mean sleep score across the last 7 days of physiologyHistory.
  const recent = (s.physiologyHistory ?? []).slice(-7);
  const scores = recent.map((p: any) => p.sleepScore).filter((v: any) => typeof v === 'number');
  const recoveryAvg = scores.length ? Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length) : null;

  function deltaChip(cur: number, prev: number, unit?: string): string {
    if (prev === 0 && cur === 0) return '';
    const d = cur - prev;
    if (Math.abs(d) < 0.01) return '<span style="font-size:11px;color:#94A3B8">flat</span>';
    const sign = d > 0 ? '+' : '−';
    const color = d > 0 ? '#10b981' : '#dc2626';
    const abs = unit === 'km' ? formatKm(Math.abs(d), unit as 'km' | 'mi')
              : Math.abs(d).toFixed(0) + (unit ? ` ${unit}` : '');
    return `<span style="font-size:11px;font-weight:600;color:${color}">${sign}${abs}</span>`;
  }

  const row = (label: string, value: string, delta: string) => `
    <div style="display:flex;align-items:baseline;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
      <span style="font-size:13px;color:#475569">${label}</span>
      <span style="display:flex;align-items:baseline;gap:10px">
        <span style="font-size:17px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${value}</span>
        ${delta}
      </span>
    </div>`;

  const modal = document.createElement('div');
  modal.id = 'week-debrief-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:20px;max-width:440px;width:100%;padding:26px 22px;box-shadow:0 16px 48px rgba(0,0,0,0.25)">
      <div style="font-size:11px;font-weight:600;color:#64748B;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:4px">Week ${wk.w}</div>
      <div style="font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0F172A;margin-bottom:18px">Week summary</div>
      ${row('Distance', formatKm(cur.km, unit), deltaChip(cur.km, lst.km, unit))}
      ${row('Sessions', String(cur.sessions), deltaChip(cur.sessions, lst.sessions))}
      ${row('Load (TSS)', String(cur.tss), deltaChip(cur.tss, lst.tss))}
      ${row('Fitness (CTL)', ctlEnd.toFixed(1), ctlDelta === 0 ? '<span style="font-size:11px;color:#94A3B8">flat</span>' : `<span style="font-size:11px;font-weight:600;color:${ctlDelta > 0 ? '#10b981' : '#dc2626'}">${ctlDelta > 0 ? '+' : ''}${ctlDelta}</span>`)}
      ${recoveryAvg != null ? row('Recovery average', String(recoveryAvg), '') : ''}
      <button id="tdebrief-close" class="m-btn-glass" style="width:100%;margin-top:20px">Done</button>
    </div>`;
  document.body.appendChild(modal);

  const close = () => {
    const ms = getMutableState() as any;
    ms.lastDebriefWeek = Math.max(ms.lastDebriefWeek ?? 0, weekNum);
    ms.lastDebriefShownDate = new Date().toISOString().split('T')[0];
    saveState();
    modal.remove();
  };
  modal.querySelector('#tdebrief-close')?.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
}

// ─── Dev helper ──────────────────────────────────────────────────────────────
// Expose a quick way to preview a genuinely different adjusted plan without
// waiting for real hard weeks to accumulate. In the devtools console:
//   __previewAdjustedPlan()              → effort=2.5, acwr=caution
//   __previewAdjustedPlan(3, 'high')     → max effort, acwr=high (deload)
if (typeof window !== 'undefined') {
  (window as any).__previewAdjustedPlan = (
    effort: number = 2.5,
    acwrStatus: 'safe' | 'caution' | 'high' = 'caution',
  ) => {
    showWeekDebrief(undefined, 'complete', { effort, acwrStatus });
  };
}
