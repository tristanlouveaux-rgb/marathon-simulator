/**
 * Running Monte Carlo cone card. Sits on the running Forecast tab between
 * the fingerprint chip grid and the disclaimer footnote.
 *
 * Mirror of `src/ui/triathlon/race-forecast-cone-card.ts` (per CLAUDE.md
 * mirror rule). Differences vs the tri version:
 *   - Calls `runForecastSim` (running engine) instead of `runTriForecastSim`.
 *   - Reads/writes the goal from `s.raceGoalTimeSec` (running's goal field)
 *     rather than `triConfig.targetFinishTimeSec`. Falls back to
 *     `s.initialBaseline` (the initial-plan prediction) if no user goal set.
 *   - Feeds a history line into the cone derived from `vdotHistory` so the
 *     actual per-week race-time progression overlays on the band. Tri has
 *     no equivalent per-week historical series.
 *
 * Every number sources from the engine: `runForecastSim(s, 2000, goalSec)`.
 * Goal-difficulty thresholds (95/70/40/15 % probability) recovered from
 * the pre-regression dist bundle, NOT invented.
 */

import type { SimulatorState } from '@/types/state';
import { runMarathonForecastSim as runForecastSim } from '@/calculations/race-forecast-simulation';
import { buildForecastCone, type ConeHistoryPoint } from '@/ui/forecast-cone';
import { tv, rdKm } from '@/calculations/vdot';
import { ft, fmtProbPct } from '@/utils/format';

// ── Design tokens (match tri cone card) ──────────────────────────────────────

const TEXT_M  = '#0F172A';
const TEXT_S  = '#64748B';
const TEXT_L  = '#94A3B8';
const BAND_HI = 'rgba(100,116,139,0.30)';
const DASH    = '#64748B';
const GOAL    = '#C48A3A';
const CARD    = 'background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)';

const PROB_LIGHT     = 95;
const PROB_REALISTIC = 70;
const PROB_HONEST    = 40;
const PROB_AMBITIOUS = 15;

// ── Helpers ──────────────────────────────────────────────────────────────────

function goalCaption(probPct: number, medianSec: number, goalSec: number): string {
  const deltaSec = goalSec - medianSec;
  const absMin = Math.max(1, Math.round(Math.abs(deltaSec) / 60));
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
      <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:18px;height:2px;background:#64748B"></span><span>Actual</span></span>
      <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:18px;height:2px;background:${GOAL};opacity:0.7"></span><span>Goal</span></span>
    </div>`;
}

function buildOutcomeTile(label: string, outcomeSec: number, tagline: string, goalSec: number | null, isSelected: boolean): string {
  const delta = outcomeDeltaLabel(outcomeSec, goalSec);
  const deltaColor = delta.tone === 'on-goal' ? '#16A34A' : delta.tone === 'under' ? '#16A34A' : '#B45309';
  const border = isSelected ? '1.5px solid #94A3B8' : '1px solid rgba(0,0,0,0.06)';
  const bg = isSelected ? '#F1F5F9' : '#fff';
  return `
    <button class="run-cone-outcome" data-outcome-sec="${Math.round(outcomeSec)}" style="
      flex:1;min-width:0;text-align:center;background:${bg};border:${border};border-radius:12px;padding:12px 10px;cursor:pointer;font:inherit;-webkit-tap-highlight-color:transparent
    ">
      <div style="font-size:11px;color:${TEXT_S};font-weight:500;margin-bottom:6px">${label}</div>
      <div style="font-size:18px;font-weight:700;color:${TEXT_M};letter-spacing:-0.01em;font-variant-numeric:tabular-nums">${ft(outcomeSec)}</div>
      <div style="font-size:11px;color:${TEXT_L};margin-top:4px">${tagline}</div>
      ${delta.text ? `<div style="font-size:11px;font-weight:600;color:${deltaColor};margin-top:4px;font-variant-numeric:tabular-nums">${delta.text}</div>` : ''}
    </button>`;
}

// Build per-week actual race-time history from vdotHistory. Each completed
// week with a recorded VDOT yields one point: time = tv(vdot, raceDistKm).
function buildHistory(s: SimulatorState): ConeHistoryPoint[] {
  const distKm = rdKm(s.rd ?? 'marathon');
  const currentWeek = Math.max(1, s.w ?? 1);
  const weekMap = new Map<number, number>();
  for (const h of s.vdotHistory ?? []) {
    if (!h.vdot || h.vdot <= 0) continue;
    if (h.week < 1 || h.week > currentWeek) continue;
    weekMap.set(h.week, tv(h.vdot, distKm));
  }
  return Array.from(weekMap.entries())
    .map(([week, timeSec]) => ({ week, timeSec }))
    .sort((a, b) => a.week - b.week);
}

// ── Public render ────────────────────────────────────────────────────────────

export function renderRunConeCard(s: SimulatorState): string {
  // Goal: user-set wins, otherwise fall back to the initial-plan baseline so
  // the line still shows something meaningful. `raceGoalTimeSec` was previously
  // unreferenced anywhere in the codebase; this restores it as the goal source.
  const goalSec = (s.raceGoalTimeSec && s.raceGoalTimeSec > 0)
    ? s.raceGoalTimeSec
    : (s.initialBaseline && s.initialBaseline > 0 ? s.initialBaseline : null);

  const sim = runForecastSim(s, 2000, goalSec);
  if (!sim) return '';

  const totalWeeks = s.tw ?? (s.wks?.length ?? 16);
  const currentWeek = Math.max(1, Math.min(totalWeeks, s.w ?? 1));
  const history = buildHistory(s);

  const coneSvg = buildForecastCone(sim, goalSec ?? 0, history, totalWeeks, currentWeek);
  const legend = buildLegend();
  const medianSec = sim.raceDay.p50;

  // Chance bar OR set-goal CTA. The fallback to initialBaseline above means
  // we usually have a goal; the "set" CTA only fires for plans without an
  // initial prediction (rare).
  let goalBlock = '';
  const isUserGoal = !!(s.raceGoalTimeSec && s.raceGoalTimeSec > 0);
  if (goalSec && sim.goalProbability != null) {
    const probPct = sim.goalProbability * 100;
    const caption = goalCaption(probPct, medianSec, goalSec);
    const goalLabel = isUserGoal ? 'your goal' : 'your initial prediction';
    goalBlock = `
      <div style="background:rgba(148,163,184,0.10);border-radius:12px;padding:14px;margin-top:18px">
        <div style="font-size:13px;color:${TEXT_M};margin-bottom:6px">Chance of beating ${goalLabel} of ${ft(goalSec)}</div>
        <div style="display:flex;align-items:flex-start;gap:14px">
          <div style="font-size:28px;font-weight:700;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${fmtProbPct(probPct)}</div>
          <div style="font-size:12px;color:${TEXT_S};line-height:1.5;flex:1">${caption}</div>
        </div>
        <button id="run-cone-edit-goal" type="button" style="margin-top:12px;font-size:12px;color:${TEXT_S};background:none;border:none;cursor:pointer;padding:0;font:inherit;text-decoration:underline">${isUserGoal ? 'Edit goal time' : 'Set your own goal time'}</button>
      </div>`;
  } else {
    goalBlock = `
      <div style="background:rgba(148,163,184,0.10);border-radius:12px;padding:14px;margin-top:18px;text-align:center">
        <div style="font-size:13px;color:${TEXT_M};margin-bottom:8px">Set a goal time to see your chance of beating it.</div>
        <button id="run-cone-set-goal" type="button" style="font-size:13px;color:${TEXT_M};background:#fff;border:1px solid rgba(0,0,0,0.12);border-radius:999px;padding:8px 16px;cursor:pointer;font:inherit;font-weight:500">Set a goal time</button>
      </div>`;
  }

  const optimistic = sim.raceDay.p10;
  const conservative = sim.raceDay.p90;
  const selectedTol = 30;
  const isSelected = (sec: number) => goalSec != null && Math.abs(sec - goalSec) <= selectedTol;
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
    <div class="rfc-fade" style="animation-delay:0.16s;padding:0 16px;margin-bottom:14px">
      <div style="${CARD};padding:20px">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:14px;color:${TEXT_M};font-weight:600">Race-time progression</div>
          <div style="font-size:11px;color:${TEXT_L}">Lower is faster</div>
        </div>
        <div style="font-size:12px;color:${TEXT_S};line-height:1.55;margin-bottom:14px">
          ${sim.trialCount.toLocaleString()} simulated builds of the remaining ${Math.max(1, totalWeeks - currentWeek)} weeks. The band is the realistic spread, factoring adherence, training response, and race-day form. The solid line is your actual race-time progression so far.
        </div>
        ${coneSvg}
        ${legend}
        ${goalBlock}
        ${tilesBlock}
      </div>
    </div>`;
}

// ── Public wiring ────────────────────────────────────────────────────────────

export function wireRunConeCard(): void {
  const open = (preSec?: number) => {
    void import('./goal-time-overlay').then(m => {
      if (typeof m.openRunGoalOverlay === 'function') m.openRunGoalOverlay(preSec);
    }).catch(() => { /* overlay not yet built; silent */ });
  };
  document.getElementById('run-cone-edit-goal')?.addEventListener('click', () => open());
  document.getElementById('run-cone-set-goal')?.addEventListener('click', () => open());
  document.querySelectorAll<HTMLButtonElement>('.run-cone-outcome').forEach(btn => {
    btn.addEventListener('click', () => {
      const sec = Number(btn.dataset.outcomeSec);
      if (Number.isFinite(sec) && sec > 0) open(Math.round(sec));
    });
  });
}
