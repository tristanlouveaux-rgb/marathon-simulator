/**
 * Week-End Debrief
 *
 * A focused modal that fires once at the end of each training week.
 * Replaces the welcome-back modal (ISSUE-81).
 *
 * Trigger paths:
 *   1. User taps "Finish week" button in the current week header (plan-view)
 *   2. Auto: on app open on Monday after week advance (guarded by lastDebriefWeek)
 *
 * Content (one screen):
 *   - Load % vs planned
 *   - Distance completed
 *   - Running Fitness (CTL) delta
 *   - Effort trend — if effortScore significantly off, offer one pacing adjustment
 *   - Next week preview (phase + planned TSS)
 *
 * Internal names (ATL/CTL/TSB/rpeAdj) must NOT appear in user-facing copy.
 */

import { getState, getMutableState, saveState } from '@/state';
import { computeFitnessModel, computeWeekTSS, computePlannedWeekTSS } from '@/calculations/fitness-model';
import { renderHomeView } from '@/ui/home-view';

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
 * Check if the week-end debrief should fire automatically.
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
 * Show the week-end debrief for the just-completed week.
 * `forWeek` defaults to s.w - 1 (auto) or can be passed explicitly (manual "Finish week" tap).
 */
export function showWeekDebrief(forWeek?: number): void {
  const s = getState() as any;
  const weekNum = forWeek ?? (s.w ?? 1) - 1;
  if (weekNum < 1 || !s.wks?.[weekNum - 1]) return;

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

  const actualTSS = wk.actualTSS ?? computeWeekTSS(wk, wk.rated ?? {}, s.planStartDate);
  const plannedTSS = computePlannedWeekTSS(
    s.historicWeeklyTSS, s.ctlBaseline, wk.ph, tier, s.rw, undefined, undefined,
  );
  const tssPct = plannedTSS > 0 ? Math.round((actualTSS / plannedTSS) * 100) : null;
  const distanceKm = wk.completedKm ?? null;

  const effortScore: number | null = wk.effortScore ?? null;
  const effortHigh  = effortScore != null && effortScore >  1.0;
  const effortLow   = effortScore != null && effortScore < -1.0;
  const showPacing  = effortHigh || effortLow;

  // Next week preview
  const nextPhase    = nextWk?.ph ?? null;
  const nextPlanned  = nextWk ? computePlannedWeekTSS(
    s.historicWeeklyTSS, s.ctlBaseline, nextWk.ph, tier, s.rw,
  ) : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  const tssColor = tssPct == null ? 'var(--c-muted)'
    : tssPct >= 100 ? 'var(--c-warn)'
    : tssPct >= 80  ? 'var(--c-ok)'
    : 'var(--c-caution)';

  const tssLabel = tssPct == null ? '—'
    : tssPct >= 100 ? `${tssPct}% — above plan`
    : tssPct >= 80  ? `${tssPct}% of planned`
    : `${tssPct}% of planned`;

  const ROW = 'display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--c-border)';
  const LABEL_STYLE = 'font-size:14px;color:var(--c-muted);font-weight:500';
  const VALUE_STYLE = 'font-size:14px;font-weight:600;letter-spacing:-0.01em';

  const ctlLine = ctlDelta == null ? ''
    : ctlDelta > 0
      ? `<div style="${ROW}"><span style="${LABEL_STYLE}">Running Fitness</span><span style="${VALUE_STYLE};color:var(--c-ok)">↑ ${ctlDelta} pts</span></div>`
      : ctlDelta < 0
        ? `<div style="${ROW}"><span style="${LABEL_STYLE}">Running Fitness</span><span style="${VALUE_STYLE};color:var(--c-warn)">↓ ${Math.abs(ctlDelta)} pts</span></div>`
        : `<div style="${ROW}"><span style="${LABEL_STYLE}">Running Fitness</span><span style="${VALUE_STYLE};color:var(--c-muted)">Holding steady</span></div>`;

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

  const html = `
    <div id="week-debrief-modal" style="position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.45);display:flex;align-items:flex-end;justify-content:center">
      <div style="width:100%;max-width:480px;background:var(--c-surface);border-radius:20px 20px 0 0;padding:24px 20px 40px;box-shadow:0 -4px 32px rgba(0,0,0,0.15)">
        <div style="width:36px;height:4px;background:var(--c-border);border-radius:2px;margin:0 auto 20px"></div>

        <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px">
          ${wk.ph ? phaseBadge(wk.ph) : ''}
          <span style="font-size:18px;font-weight:700;letter-spacing:-0.02em">Week ${weekNum} complete</span>
        </div>

        <div>
          <div style="${ROW}">
            <span style="${LABEL_STYLE}">Training load</span>
            <span style="${VALUE_STYLE};color:${tssColor}">${tssLabel}</span>
          </div>
          ${distanceKm != null ? `
          <div style="${ROW}">
            <span style="${LABEL_STYLE}">Distance</span>
            <span style="${VALUE_STYLE}">${distanceKm} km</span>
          </div>` : ''}
          ${ctlLine}
        </div>

        ${effortBlock}
        ${nextWeekBlock}

        <button id="debrief-continue" style="margin-top:24px;width:100%;padding:14px;border-radius:12px;border:none;background:var(--c-accent);color:#fff;font-size:16px;font-weight:600;cursor:pointer;font-family:var(--f);letter-spacing:-0.01em">Continue →</button>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', html);
  _wireHandlers(weekNum, effortScore, showPacing);
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

function _wireHandlers(weekNum: number, effortScore: number | null, showPacing: boolean): void {
  document.getElementById('debrief-continue')?.addEventListener('click', () => {
    // Apply pacing adjustment if user left the toggle checked
    if (showPacing) {
      const toggle = document.getElementById('debrief-pacing-toggle') as HTMLInputElement | null;
      if (toggle?.checked && effortScore != null) {
        _applyPacingAdj(effortScore);
      }
    }
    _closeAndRecord(weekNum);
  });
}

/**
 * Apply a small rpeAdj change proportional to effortScore.
 * Cap at ±0.5 VDOT per adjustment to prevent overcorrection.
 * Positive effortScore = harder than expected → reduce paces (rpeAdj −).
 * Negative effortScore = easier than expected → increase paces (rpeAdj +).
 */
function _applyPacingAdj(effortScore: number): void {
  const s = getMutableState() as any;
  const adj = Math.max(-0.5, Math.min(0.5, -effortScore * 0.25));
  s.rpeAdj = (s.rpeAdj ?? 0) + adj;
  saveState();
}

function _closeAndRecord(weekNum: number): void {
  const s = getMutableState() as any;
  s.lastDebriefWeek = weekNum;
  saveState();
  document.getElementById('week-debrief-modal')?.remove();
  renderHomeView();
}
