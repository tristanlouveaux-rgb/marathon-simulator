/**
 * Triathlon Monte Carlo cone card. Sits on the Forecast tab between the
 * fingerprint chip grid and the methodology link.
 *
 * Data flow (every number here comes from the engine, none are invented):
 *   1. runTriForecastSim(s, 2000, goalSec) -> ForecastSimResult
 *        - sim.weeks[]     per-week percentiles, fed to buildForecastCone
 *        - sim.raceDay     final race-day percentiles, drive the outcome tiles
 *        - sim.goalProbability  fraction of trials at or under goalSec
 *        - sim.pointEstimate    deterministic projection (the headline match)
 *   2. buildForecastCone draws the nested p10-p90 / p25-p75 band + dashed
 *      median + optional goal line + current-week marker + X-axis.
 *   3. Goal-difficulty copy uses the threshold ladder recovered from the
 *      pre-regression build (95 / 70 / 40 / 15 % probability). NOT invented.
 *
 * Without a goal time, the chance bar is replaced by a "Set a goal time"
 * CTA and the cone draws without a goal line.
 */

import type { SimulatorState } from '@/types/state';
import { runTriForecastSim } from '@/calculations/race-forecast-simulation.triathlon';
import { buildForecastCone, type ConeHistoryPoint } from '@/ui/forecast-cone';
import { ft, fmtProbPct } from '@/utils/format';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';

// ── Design tokens ────────────────────────────────────────────────────────────

const TEXT_M  = '#0F172A';
const TEXT_S  = '#64748B';
const TEXT_L  = '#94A3B8';
const BAND_LO = 'rgba(148,163,184,0.18)';
const BAND_HI = 'rgba(100,116,139,0.30)';
const DASH    = '#64748B';
const GOAL    = '#C48A3A';
const CARD    = 'background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)';

// Goal probability -> qualitative caption. Thresholds recovered from the
// pre-regression dist bundle; do not change without a corresponding update
// to SCIENCE_LOG and tests.
const PROB_LIGHT     = 95;
const PROB_REALISTIC = 70;
const PROB_HONEST    = 40;
const PROB_AMBITIOUS = 15;

// ── Helpers ──────────────────────────────────────────────────────────────────

function goalCaption(probPct: number, medianSec: number, goalSec: number): string {
  const deltaSec = goalSec - medianSec;
  const absMin = Math.max(1, Math.round(Math.abs(deltaSec) / 60));
  // f = goal - median. f > 0 means goal is slower than median => median is "faster".
  const medianRel = deltaSec > 0 ? 'faster' : 'slower';
  if (probPct >= PROB_LIGHT) {
    return `Your goal looks light. Median is about ${absMin} min ${medianRel}. Consider a stretch goal.`;
  }
  if (probPct >= PROB_REALISTIC) return 'Realistic, on the safe side of the cone.';
  if (probPct >= PROB_HONEST)    return 'Honest stretch. Median lands close to this.';
  if (probPct >= PROB_AMBITIOUS) return 'Ambitious. The plan would need to land near the optimistic end.';
  return `Aggressive. Median is about ${absMin} min ${medianRel}. Only the optimistic tail beats it.`;
}

function outcomeDeltaLabel(outcomeSec: number, goalSec: number | null): { text: string; tone: 'on-goal' | 'over' | 'under' } {
  if (!goalSec || goalSec <= 0) return { text: '', tone: 'on-goal' };
  const deltaMin = Math.round((outcomeSec - goalSec) / 60);
  if (deltaMin === 0) return { text: 'on goal', tone: 'on-goal' };
  if (deltaMin < 0)   return { text: `${deltaMin} min vs goal`, tone: 'under' };
  return { text: `+${deltaMin} min vs goal`, tone: 'over' };
}

function buildLegend(): string {
  const swatch = (style: string) => `<span style="display:inline-block;width:18px;height:8px;border-radius:2px;${style}"></span>`;
  return `
    <div style="display:flex;align-items:center;gap:14px;margin-top:14px;font-size:11px;color:${TEXT_S};flex-wrap:wrap">
      <span style="display:inline-flex;align-items:center;gap:6px">${swatch(`background:${BAND_HI}`)}<span>Likely range</span></span>
      <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:18px;height:2px;background:repeating-linear-gradient(to right,${DASH} 0 4px,transparent 4px 7px);opacity:0.85"></span><span>Median</span></span>
      <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:18px;height:2px;background:${GOAL};opacity:0.7"></span><span>Goal</span></span>
    </div>`;
}

function buildOutcomeTile(label: string, outcomeSec: number, tagline: string, goalSec: number | null, isSelected: boolean): string {
  const delta = outcomeDeltaLabel(outcomeSec, goalSec);
  const deltaColor = delta.tone === 'on-goal' ? '#16A34A' : delta.tone === 'under' ? '#16A34A' : '#B45309';
  const border = isSelected ? '1.5px solid #94A3B8' : '1px solid rgba(0,0,0,0.06)';
  const bg = isSelected ? '#F1F5F9' : '#fff';
  return `
    <button class="tri-cone-outcome" data-outcome-sec="${Math.round(outcomeSec)}" style="
      flex:1;min-width:0;text-align:center;background:${bg};border:${border};border-radius:12px;padding:12px 10px;cursor:pointer;font:inherit;-webkit-tap-highlight-color:transparent
    ">
      <div style="font-size:11px;color:${TEXT_S};font-weight:500;margin-bottom:6px">${label}</div>
      <div style="font-size:18px;font-weight:700;color:${TEXT_M};letter-spacing:-0.01em;font-variant-numeric:tabular-nums">${ft(outcomeSec)}</div>
      <div style="font-size:11px;color:${TEXT_L};margin-top:4px">${tagline}</div>
      ${delta.text ? `<div style="font-size:11px;font-weight:600;color:${deltaColor};margin-top:4px;font-variant-numeric:tabular-nums">${delta.text}</div>` : ''}
    </button>`;
}

// ── Public render ────────────────────────────────────────────────────────────

export function renderTriConeCard(s: SimulatorState): string {
  const tri = s.triConfig;
  if (!tri) return '';
  const goalSec = tri.targetFinishTimeSec && tri.targetFinishTimeSec > 0 ? tri.targetFinishTimeSec : null;
  const sim = runTriForecastSim(s, 2000, goalSec);
  if (!sim) return '';

  const totalWeeks = s.tw ?? (s.wks?.length ?? 20);
  const currentWeek = Math.max(1, Math.min(totalWeeks, s.w ?? 1));

  // Triathlon has no per-week historical race-time series the way running's
  // VDOT progression does, so the actual-line history is empty. The cone
  // anchors at currentWeek and fans forward.
  const history: ConeHistoryPoint[] = [];

  const coneSvg = buildForecastCone(sim, goalSec ?? 0, history, totalWeeks, currentWeek);
  const legend = buildLegend();

  const medianSec = sim.raceDay.p50;

  // Chance bar OR set-goal CTA
  let goalBlock = '';
  if (goalSec && sim.goalProbability != null) {
    const probPct = sim.goalProbability * 100;
    const caption = goalCaption(probPct, medianSec, goalSec);
    goalBlock = `
      <div style="background:rgba(148,163,184,0.10);border-radius:12px;padding:14px;margin-top:18px">
        <div style="font-size:13px;color:${TEXT_M};margin-bottom:6px">Chance of beating your goal of ${ft(goalSec)}</div>
        <div style="display:flex;align-items:flex-start;gap:14px">
          <div style="font-size:28px;font-weight:700;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${fmtProbPct(probPct)}</div>
          <div style="font-size:12px;color:${TEXT_S};line-height:1.5;flex:1">${caption}</div>
        </div>
        <button id="tri-cone-edit-goal" type="button" style="font:inherit;margin-top:12px;font-size:12px;color:${TEXT_S};background:none;border:none;cursor:pointer;padding:0;text-decoration:underline">Edit goal time</button>
      </div>`;
  } else {
    goalBlock = `
      <div style="background:rgba(148,163,184,0.10);border-radius:12px;padding:14px;margin-top:18px;text-align:center">
        <div style="font-size:13px;color:${TEXT_M};margin-bottom:8px">Set a goal time to see your chance of beating it.</div>
        <button id="tri-cone-set-goal" type="button" style="font:inherit;font-size:13px;color:${TEXT_M};background:#fff;border:1px solid rgba(0,0,0,0.12);border-radius:999px;padding:8px 16px;cursor:pointer;font-weight:500">Set a goal time</button>
      </div>`;
  }

  // Outcome tiles. p10 = fastest 10% of trials (Optimistic).
  // p50 = median. p90 = slowest 10% (Conservative).
  const optimistic = sim.raceDay.p10;
  const conservative = sim.raceDay.p90;
  const selectedTol = 30; // sec; matches the rounding tolerance for the "on goal" label
  const isSelected = (s: number) => goalSec != null && Math.abs(s - goalSec) <= selectedTol;
  const tilesBlock = `
    <div style="margin-top:18px">
      <div style="text-align:center;font-size:12px;color:${TEXT_S};margin-bottom:10px">Tap an outcome to set it as your goal</div>
      <div style="display:flex;gap:8px">
        ${buildOutcomeTile('Optimistic', optimistic, 'top 10%', goalSec, isSelected(optimistic))}
        ${buildOutcomeTile('Median', medianSec, 'most likely', goalSec, isSelected(medianSec))}
        ${buildOutcomeTile('Conservative', conservative, 'bottom 10%', goalSec, isSelected(conservative))}
      </div>
    </div>`;

  return `
    <div class="hf" data-delay="0.12" style="margin-top:14px">
      <div style="${CARD};padding:20px">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:14px;color:${TEXT_M};font-weight:600">Race-time progression</div>
          <div style="font-size:11px;color:${TEXT_L}">Lower is faster</div>
        </div>
        <div style="font-size:12px;color:${TEXT_S};line-height:1.55;margin-bottom:14px">
          ${sim.trialCount.toLocaleString()} simulated builds across all three legs. The band is the realistic spread of where the next ${Math.max(1, totalWeeks - currentWeek)} weeks could land, factoring adherence, training response, and race-day form.
        </div>
        ${coneSvg}
        ${legend}
        ${goalBlock}
        ${tilesBlock}
      </div>
    </div>`;
}

// ── Public wiring ────────────────────────────────────────────────────────────
//
// The goal-edit overlay is a separate module (rebuilt in task #3). Until it
// lands, the buttons surface as no-ops; this keeps the card self-contained
// and lets the overlay swap in without a card re-render. Outcome tiles call
// into the same opener so tapping an outcome sets it as the goal.

export function wireTriConeCard(): void {
  // "Edit goal time" / "Set a goal time" open the editor overlay.
  const open = (preSec?: number) => {
    void import('./goal-time-overlay').then(m => {
      if (typeof m.openTriGoalOverlay === 'function') m.openTriGoalOverlay(preSec);
    }).catch(() => { /* overlay not yet built; silent */ });
  };
  document.getElementById('tri-cone-edit-goal')?.addEventListener('click', () => open());
  document.getElementById('tri-cone-set-goal')?.addEventListener('click', () => open());

  // Outcome tiles set the goal directly in one tap (no overlay): tapping
  // Optimistic / Median / Conservative jumps the goal to that time, then
  // re-renders so the goal line, chance %, and selected-tile highlight update.
  document.querySelectorAll<HTMLButtonElement>('.tri-cone-outcome').forEach(btn => {
    btn.addEventListener('click', () => {
      const sec = Number(btn.dataset.outcomeSec);
      if (!Number.isFinite(sec) || sec <= 0) return;
      const ms = getMutableState();
      if (!ms.triConfig) return;
      ms.triConfig.targetFinishTimeSec = Math.round(sec);
      saveState();
      void import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
    });
  });
}
