/**
 * Running goal-time overlay. Sets `s.raceGoalTimeSec`.
 *
 * Mirror of `src/ui/triathlon/goal-time-overlay.ts`. Differences:
 *   - Reads from `s.raceGoalTimeSec`, falls back to `s.initialBaseline`
 *     (the initial-plan prediction) if no user goal saved.
 *   - Re-runs `runForecastSim` (running engine) on every drag for the live
 *     chance % display. Same seed, only goalProbability changes.
 *   - Bounds derived from the deterministic running prediction (forecast or
 *     blended) the same way the tri version derives from totalSec.
 *   - Closes by re-rendering the running forecast view.
 */

import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { runMarathonForecastSim as runForecastSim } from '@/calculations/race-forecast-simulation';
import { fmtProbPct } from '@/utils/format';

// ── Format / snap helpers ────────────────────────────────────────────────────

function fmtHm(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}

function snap(sec: number, stepSec: number): number {
  return Math.round(sec / stepSec) * stepSec;
}

/**
 * Per-distance goal-slider granularity. `step` is the slider increment; `window`
 * is the +/- fraction of the prediction the slider spans. Short races need fine
 * steps (a 5K's realistic range is a few minutes, so a 60s step leaps across the
 * steep part of the probability curve); long races need coarse steps (a marathon
 * spans ~50 min, so 5s steps would be hundreds of notches). Tuned so every
 * distance lands at ~40-50 notches. UX granularity, not a model input.
 */
const GOAL_SLIDER_PARAMS: Record<string, { step: number; window: number }> = {
  '5k':       { step: 5,  window: 0.10 },
  '10k':      { step: 10, window: 0.10 },
  'half':     { step: 20, window: 0.12 },
  'marathon': { step: 30, window: 0.12 },
};

/**
 * `fastestSec` (optional) extends the fast end of the slider to cover a faster
 * achievable forecast — e.g. the onboarding overlay, where adding sessions pulls
 * the forecast faster than the base prediction. Pass the forecast at the max
 * addable session count so the range spans the whole add-session scenario from
 * the start, without the bounds shifting as the user taps +. The slow end stays
 * anchored to the base prediction.
 */
export function deriveBounds(predictedSec: number, rd?: string, fastestSec?: number): { minSec: number; maxSec: number; stepSec: number } {
  const p = GOAL_SLIDER_PARAMS[rd ?? ''] ?? { step: 15, window: 0.12 };
  const fastAnchor = (fastestSec && fastestSec > 0 && fastestSec < predictedSec) ? fastestSec : predictedSec;
  const minSec = Math.max(p.step, snap(fastAnchor * (1 - p.window), p.step));
  const maxSec = Math.max(minSec + 10 * p.step, snap(predictedSec * (1 + p.window), p.step));
  return { minSec, maxSec, stepSec: p.step };
}

// ── Goal caption ladder ─────────────────────────────────────────────────────

const PROB_LIGHT     = 95;
const PROB_REALISTIC = 70;
const PROB_HONEST    = 40;
const PROB_AMBITIOUS = 15;

export function liveTone(probPct: number): string {
  if (probPct >= PROB_REALISTIC) return '#16A34A';
  if (probPct >= PROB_HONEST)    return '#65A30D';
  if (probPct >= PROB_AMBITIOUS) return '#B45309';
  return '#B91C1C';
}

export function liveLabel(probPct: number): string {
  if (probPct >= PROB_LIGHT)     return 'Looks light';
  if (probPct >= PROB_REALISTIC) return 'Realistic';
  if (probPct >= PROB_HONEST)    return 'Honest stretch';
  if (probPct >= PROB_AMBITIOUS) return 'Ambitious';
  return 'Aggressive';
}

// ── Public ───────────────────────────────────────────────────────────────────

export function openRunGoalOverlay(preSec?: number): void {
  const existing = document.getElementById('run-goal-overlay');
  if (existing) existing.remove();

  const ms = getMutableState();
  const predictedSec = ms.forecastTimeAdjusted ?? ms.forecastTime ?? ms.blendedRaceTimeSec ?? 0;
  if (predictedSec <= 0) return;

  const { minSec, maxSec, stepSec } = deriveBounds(predictedSec, ms.rd);

  // Initial: explicit preSec > saved user goal > initial baseline > prediction * 0.95
  const baselineFallback = ms.initialBaseline && ms.initialBaseline > 0 ? ms.initialBaseline : predictedSec * 0.95;
  const initialSec = preSec && preSec > 0
    ? Math.min(maxSec, Math.max(minSec, snap(preSec, stepSec)))
    : (ms.raceGoalTimeSec && ms.raceGoalTimeSec > 0
        ? Math.min(maxSec, Math.max(minSec, snap(ms.raceGoalTimeSec, stepSec)))
        : Math.min(maxSec, Math.max(minSec, snap(baselineFallback, stepSec))));

  const overlay = document.createElement('div');
  overlay.id = 'run-goal-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;
    background:rgba(15,23,42,0.42);backdrop-filter:blur(12px) saturate(1.1);-webkit-backdrop-filter:blur(12px) saturate(1.1);
    overflow-y:auto;
  `;
  overlay.innerHTML = `
    <div id="run-goal-card" style="
      background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
      border:1px solid rgba(255,255,255,0.6);border-radius:24px;padding:24px;max-width:420px;width:100%;
      max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(15,23,42,0.18),0 0 0 1px rgba(15,23,42,0.04);
    ">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
        <div style="font-size:18px;font-weight:700;color:#0F172A;letter-spacing:-0.01em">Set your goal time</div>
        <button id="run-goal-close" aria-label="Close" style="background:none;border:none;cursor:pointer;color:#94A3B8;font-size:22px;line-height:1;padding:0">×</button>
      </div>
      <div style="font-size:13px;color:#64748B;line-height:1.5;margin-bottom:22px">Your race-day target. The forecast will show your chance of beating it.</div>

      <div style="text-align:center;margin-bottom:6px">
        <div id="run-goal-time" style="font-size:44px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${fmtHm(initialSec)}</div>
        <div style="font-size:12px;color:#94A3B8;margin-top:6px;font-weight:500">hours : minutes</div>
      </div>

      <div style="margin:18px 0 6px">
        <input
          class="m-slider-glass"
          id="run-goal-slider"
          type="range"
          min="${minSec}"
          max="${maxSec}"
          step="${stepSec}"
          value="${initialSec}"
        />
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#94A3B8;font-variant-numeric:tabular-nums;margin-bottom:18px">
        <span>${fmtHm(minSec)}</span>
        <span>${fmtHm(maxSec)}</span>
      </div>

      <div id="run-goal-chance" style="
        background:rgba(148,163,184,0.10);border-radius:12px;padding:12px 14px;margin-bottom:18px;
        display:flex;align-items:center;justify-content:space-between;gap:14px
      "></div>

      <button id="run-goal-save" type="button" style="
        font:inherit;width:100%;padding:14px;border:none;border-radius:999px;background:#0F172A;color:#fff;
        font-size:15px;font-weight:600;cursor:pointer
      ">Save goal time</button>

      <button id="run-goal-clear" type="button" style="
        font:inherit;width:100%;padding:12px 0 0;background:none;border:none;color:#64748B;font-size:13px;
        cursor:pointer;text-align:center;margin-top:6px
      ">Clear goal</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const renderChance = (goalSec: number): void => {
    const sim = runForecastSim(getMutableState(), 2000, goalSec);
    const chanceEl = document.getElementById('run-goal-chance');
    if (!chanceEl) return;
    if (!sim || sim.goalProbability == null) {
      chanceEl.innerHTML = `<div style="font-size:12px;color:#94A3B8">Forecast unavailable.</div>`;
      return;
    }
    const pct = sim.goalProbability * 100;
    const tone = liveTone(pct);
    const label = liveLabel(pct);
    chanceEl.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px">
        <span style="font-size:24px;font-weight:700;color:#0F172A;letter-spacing:-0.01em;font-variant-numeric:tabular-nums;line-height:1">${fmtProbPct(pct)}</span>
        <span style="font-size:12px;color:#64748B">chance of beating</span>
      </div>
      <div style="font-size:12px;font-weight:600;color:${tone}">${label}</div>
    `;
  };
  renderChance(initialSec);

  const timeEl = document.getElementById('run-goal-time');
  const slider = document.getElementById('run-goal-slider') as HTMLInputElement | null;

  let pending = false;
  let pendingSec = initialSec;
  const tick = () => {
    pending = false;
    renderChance(pendingSec);
  };
  slider?.addEventListener('input', () => {
    if (!slider) return;
    const sec = Number(slider.value);
    pendingSec = sec;
    if (timeEl) timeEl.textContent = fmtHm(sec);
    if (!pending) {
      pending = true;
      requestAnimationFrame(tick);
    }
  });

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.getElementById('run-goal-close')?.addEventListener('click', close);

  const refreshForecast = () => {
    void import('./race-forecast-view').then(({ renderRaceForecastView }) => renderRaceForecastView());
  };

  document.getElementById('run-goal-save')?.addEventListener('click', () => {
    if (!slider) return;
    const sec = Number(slider.value);
    if (!Number.isFinite(sec) || sec <= 0) return;
    const ms2 = getMutableState();
    ms2.raceGoalTimeSec = sec;
    saveState();
    close();
    refreshForecast();
  });

  document.getElementById('run-goal-clear')?.addEventListener('click', () => {
    const ms2 = getMutableState();
    ms2.raceGoalTimeSec = undefined;
    saveState();
    close();
    refreshForecast();
  });
}
