/**
 * Triathlon goal-time overlay. Sets triConfig.targetFinishTimeSec.
 *
 * Triggered from the cone card on the Forecast tab (the "Edit goal time"
 * link, the "Set a goal time" CTA, or by tapping one of the Optimistic /
 * Median / Conservative outcome tiles).
 *
 * Behaviour:
 *   - Slider with prediction-relative bounds (predicted * 0.8 to * 1.8,
 *     snapped to 5-minute increments) so the range scales with race
 *     distance without hardcoded buckets.
 *   - Live "chance of beating" recompute on every drag: re-runs the
 *     Monte Carlo with the same seed so the 2000 trials are identical,
 *     only the goal probability changes. Cost is ~5-10 ms per tick.
 *   - Glass dialog (page-flair atmosphere + backdrop-filter), per
 *     UX_PATTERNS Mosaic Visual System.
 *
 * Per CLAUDE.md UI rules:
 *   - Vertically centered overlay (flex items-center justify-center)
 *   - No emoji, no em-dashes
 *   - Dark CTA for the save action, muted text link for the clear action
 *   - Closes back to the forecast view (not Home)
 */

import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { runTriForecastSim } from '@/calculations/race-forecast-simulation.triathlon';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { fmtProbPct } from '@/utils/format';

// ── Format helpers ───────────────────────────────────────────────────────────

function fmtHm(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}

// Snap a seconds value to the nearest multiple of `stepSec`.
function snap(sec: number, stepSec: number): number {
  return Math.round(sec / stepSec) * stepSec;
}

// ── Range derivation ─────────────────────────────────────────────────────────
//
// Bounds derived from the deterministic prediction so the range scales with
// race distance: a Sprint (~1:15) gets ~1:00-2:15, a 70.3 (~5:00) gets
// ~4:00-9:00, an Iron (~10:00) gets ~8:00-18:00. Snapped to 5-min.

function deriveBounds(predictedSec: number): { minSec: number; maxSec: number; stepSec: number } {
  const STEP = 60; // 1 minute, matches the HH:MM display
  const SNAP_END = 5 * 60; // snap min/max to nearest 5 min for clean labels
  const minSec = Math.max(STEP, snap(predictedSec * 0.8, SNAP_END));
  const maxSec = Math.max(minSec + 30 * STEP, snap(predictedSec * 1.8, SNAP_END));
  return { minSec, maxSec, stepSec: STEP };
}

// ── Goal caption ladder ─────────────────────────────────────────────────────
//
// Same constants as race-forecast-cone-card.ts. Recovered from the
// pre-regression dist bundle; do not change without updating both surfaces
// and SCIENCE_LOG.

const PROB_LIGHT     = 95;
const PROB_REALISTIC = 70;
const PROB_HONEST    = 40;
const PROB_AMBITIOUS = 15;

function liveTone(probPct: number): string {
  if (probPct >= PROB_REALISTIC) return '#16A34A'; // realistic or better
  if (probPct >= PROB_HONEST)    return '#65A30D'; // honest stretch
  if (probPct >= PROB_AMBITIOUS) return '#B45309'; // ambitious
  return '#B91C1C';                                // aggressive
}

function liveLabel(probPct: number): string {
  if (probPct >= PROB_LIGHT)     return 'Looks light';
  if (probPct >= PROB_REALISTIC) return 'Realistic';
  if (probPct >= PROB_HONEST)    return 'Honest stretch';
  if (probPct >= PROB_AMBITIOUS) return 'Ambitious';
  return 'Aggressive';
}

// ── Public ───────────────────────────────────────────────────────────────────

export function openTriGoalOverlay(preSec?: number): void {
  const existing = document.getElementById('tri-goal-overlay');
  if (existing) existing.remove();

  const ms = getMutableState();
  const tri = ms.triConfig;
  if (!tri) return;

  // Derive the predicted total from the same source the cone card uses
  // (predictTriathlonRace), not the stored tri.prediction. The stored copy
  // can be missing or stale, and reading it directly silently no-oped every
  // entry point (edit-goal link, set-goal CTA, all three outcome tiles).
  const pred = predictTriathlonRace(ms);
  const predictedSec = (pred?.totalSec && pred.totalSec > 0)
    ? pred.totalSec
    : (tri.prediction?.totalSec ?? 0);
  if (predictedSec <= 0) return;

  const { minSec, maxSec, stepSec } = deriveBounds(predictedSec);

  const initialSec = preSec && preSec > 0
    ? Math.min(maxSec, Math.max(minSec, snap(preSec, stepSec)))
    : (tri.targetFinishTimeSec && tri.targetFinishTimeSec > 0
        ? Math.min(maxSec, Math.max(minSec, snap(tri.targetFinishTimeSec, stepSec)))
        : Math.min(maxSec, Math.max(minSec, snap(predictedSec * 0.95, stepSec))));

  const overlay = document.createElement('div');
  overlay.id = 'tri-goal-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;
    background:rgba(15,23,42,0.42);backdrop-filter:blur(12px) saturate(1.1);-webkit-backdrop-filter:blur(12px) saturate(1.1);
    overflow-y:auto;
  `;
  overlay.innerHTML = `
    <div id="tri-goal-card" style="
      background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
      border:1px solid rgba(255,255,255,0.6);border-radius:24px;padding:24px;max-width:420px;width:100%;
      max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(15,23,42,0.18),0 0 0 1px rgba(15,23,42,0.04);
    ">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
        <div style="font-size:18px;font-weight:700;color:#0F172A;letter-spacing:-0.01em">Set your goal time</div>
        <button id="tri-goal-close" aria-label="Close" style="background:none;border:none;cursor:pointer;color:#94A3B8;font-size:22px;line-height:1;padding:0">×</button>
      </div>
      <div style="font-size:13px;color:#64748B;line-height:1.5;margin-bottom:22px">Your race-day target. The forecast will show your chance of beating it.</div>

      <div style="text-align:center;margin-bottom:6px">
        <div id="tri-goal-time" style="font-size:44px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${fmtHm(initialSec)}</div>
        <div style="font-size:12px;color:#94A3B8;margin-top:6px;font-weight:500">hours : minutes</div>
      </div>

      <div style="margin:18px 0 6px">
        <input
          id="tri-goal-slider"
          type="range"
          min="${minSec}"
          max="${maxSec}"
          step="${stepSec}"
          value="${initialSec}"
          style="width:100%;-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer"
        />
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#94A3B8;font-variant-numeric:tabular-nums;margin-bottom:18px">
        <span>${fmtHm(minSec)}</span>
        <span>${fmtHm(maxSec)}</span>
      </div>

      <div id="tri-goal-chance" style="
        background:rgba(148,163,184,0.10);border-radius:12px;padding:12px 14px;margin-bottom:18px;
        display:flex;align-items:center;justify-content:space-between;gap:14px
      "></div>

      <button id="tri-goal-save" type="button" style="
        width:100%;padding:14px;border:none;border-radius:999px;background:#0F172A;color:#fff;
        font-size:15px;font-weight:600;cursor:pointer;font:inherit;font-weight:600
      ">Save goal time</button>

      <button id="tri-goal-clear" type="button" style="
        width:100%;padding:12px 0 0;background:none;border:none;color:#64748B;font-size:13px;
        cursor:pointer;font:inherit;text-align:center;margin-top:6px
      ">Clear goal</button>
    </div>

    <style id="tri-goal-slider-style">
      #tri-goal-slider::-webkit-slider-runnable-track {
        height:4px;background:#E2E8F0;border-radius:2px;
      }
      #tri-goal-slider::-webkit-slider-thumb {
        -webkit-appearance:none;appearance:none;width:24px;height:24px;border-radius:50%;
        background:#fff;border:1px solid rgba(15,23,42,0.18);box-shadow:0 2px 6px rgba(15,23,42,0.18);
        margin-top:-10px;cursor:pointer;
      }
      #tri-goal-slider::-moz-range-track {
        height:4px;background:#E2E8F0;border-radius:2px;
      }
      #tri-goal-slider::-moz-range-thumb {
        width:24px;height:24px;border-radius:50%;background:#fff;
        border:1px solid rgba(15,23,42,0.18);box-shadow:0 2px 6px rgba(15,23,42,0.18);cursor:pointer;
      }
    </style>
  `;
  document.body.appendChild(overlay);

  // Compute live chance % by re-running the seeded sim with the new goal.
  // Same seed -> identical trials, only goalProbability changes. ~5-10 ms.
  const renderChance = (goalSec: number): void => {
    const sim = runTriForecastSim(getMutableState(), 2000, goalSec);
    const chanceEl = document.getElementById('tri-goal-chance');
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

  const timeEl = document.getElementById('tri-goal-time');
  const slider = document.getElementById('tri-goal-slider') as HTMLInputElement | null;

  // Throttle chance recompute to the next animation frame so dragging stays smooth.
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
  document.getElementById('tri-goal-close')?.addEventListener('click', close);

  const refreshForecast = () => {
    void import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
  };

  document.getElementById('tri-goal-save')?.addEventListener('click', () => {
    if (!slider) return;
    const sec = Number(slider.value);
    if (!Number.isFinite(sec) || sec <= 0) return;
    const ms2 = getMutableState();
    if (!ms2.triConfig) return;
    ms2.triConfig.targetFinishTimeSec = sec;
    saveState();
    close();
    refreshForecast();
  });

  document.getElementById('tri-goal-clear')?.addEventListener('click', () => {
    const ms2 = getMutableState();
    if (!ms2.triConfig) return;
    ms2.triConfig.targetFinishTimeSec = undefined;
    saveState();
    close();
    refreshForecast();
  });
}
