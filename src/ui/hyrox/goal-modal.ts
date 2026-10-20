/**
 * HYROX goal modal: the race plan's goal step.
 *
 * Opened from the Forecast hero ("Set a goal ›") and the race plan
 * ("Change goal ›", openRacePlanGoalModal). The athlete enters a goal
 * finish; the modal shows one feasibility line from the goal
 * back-calculation (the race plan's own sentence, graded against the
 * Forecast hero's likely range) and a save lands on the race plan, which
 * carries the per-leg splits (the modal's own list of run and station targets
 * repeated them one tap earlier, rounded differently). Reads the existing
 * `targetFinishTimeSec` on `hyroxConfig` if set ("Change goal", with "Clear
 * goal"); otherwise offers the forecast ("Set a goal"). With no goal on
 * file and the input at the forecast the button does not save: it reads what
 * it does instead (the opener's keepForecast label, default "Keep forecast",
 * which closes; "Open race plan" where the view behind has no race clock) and
 * reads "Save goal" as soon as the input differs. The hero never grades the
 * athlete against a goal they did not choose.
 *
 * Per CLAUDE.md UI rules:
 *   - Vertically centered overlay (`flex items-center justify-center`)
 *   - No emoji, no em-dashes
 *   - Bordered pill CTAs, no `var(--c-accent)` colour
 *   - Modal closes back to the forecast view (not Home)
 */

import { getMutableState, getState } from '@/state/store';
import { saveState } from '@/state/persistence';
import type { HyroxPrediction } from '@/calculations/race-prediction.hyrox';
import { computeGoalBackCalc, type GoalBackCalcResult } from '@/calculations/hyrox-goal-back-calc';
import { hyroxGoalBackCalcOptions, hyroxGoalFeasibilityLine } from '@/calculations/hyrox-race-plan';
import { hyroxCohortForState, type HyroxResultsCohort } from '@/calculations/hyrox-results';
import { STATION_SEED_TIMES_SEC, HYROX_RUN_PACE_MIN_SEC_KM } from '@/constants/hyrox-benchmarks';
import { ftRounded } from '@/utils/format';

/**
 * Parse a target finish. Accepts mm:ss or h:mm:ss.
 *
 * A bare 2-part value is ambiguous: "1:00" reads literally as 1 min 0 sec, but
 * a user typing it almost always means 1 hour. Since no HYROX finishes below
 * the competitive population floor, we reinterpret a 2-part value as h:mm when
 * the mm:ss reading is impossibly fast AND the h:mm reading lands in a plausible
 * finish window (floor to 4 h). "1:00" → 1:00:00; "75:00" → 75 min (unchanged).
 * The live echo under the input always shows the resolved interpretation, so
 * even an unexpected guess is visible and correctable.
 */
export function parseHhMmSs(input: string, minPlausibleSec: number): number | null {
  const clean = input.trim().replace(/[^0-9:]/g, '');
  const parts = clean.split(':');
  if (parts.length === 2) {
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);
    if (Number.isNaN(a) || Number.isNaN(b) || b >= 60) return null;
    const asMmSs = a * 60 + b;        // minutes:seconds
    const asHhMm = a * 3600 + b * 60; // hours:minutes
    if (asMmSs < minPlausibleSec && asHhMm >= minPlausibleSec && asHhMm <= 4 * 3600) {
      return asHhMm;
    }
    return asMmSs;
  }
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseInt(parts[2], 10);
    if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s) || m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

/**
 * The parse-disambiguation threshold ("1:00" read as an hour when the
 * minutes reading is impossibly fast): the legacy pooled competitive seeds
 * and the run-pace minimum. Deliberately not the back-calc's cohort floors
 * (hyroxGoalBackCalcOptions): those sit above an hour for most fields (Open
 * Singles women 1:06), so "1:00" would read as one minute.
 */
function populationFloorSec(prediction: HyroxPrediction): number {
  const stationFloor = prediction.stations.reduce(
    (sum, l) => sum + (STATION_SEED_TIMES_SEC.competitive[l.station] ?? 0) * (l.teamRatio ?? 1),
    0,
  );
  return HYROX_RUN_PACE_MIN_SEC_KM * 8 + stationFloor + prediction.roxzoneSec;
}

/**
 * The feasibility line under the goal: one plain sentence, the race plan's
 * own (hyroxGoalFeasibilityLine), no list (the race plan carries the per-leg
 * splits), no tinted callout.
 */
export function renderResultBody(
  result: Pick<GoalBackCalcResult, 'feasibility' | 'likelyRangeSec'>,
  ctx: { goalSec: number; forecastSec: number; cohort: HyroxResultsCohort },
): string {
  const line = hyroxGoalFeasibilityLine({ feasibility: result.feasibility, likelyRangeSec: result.likelyRangeSec, ...ctx });
  return `<div data-goal-feasibility="${result.feasibility}" style="font-size:13px;color:var(--c-black);line-height:1.5">${line}</div>`;
}

/**
 * The echo under the input: the resolved goal, only when it reads
 * differently from what was typed ("1:00" read as 1:00:00, "75:00" as
 * 1:15:00). '' when the input already shows it.
 */
export function goalEchoText(input: string, sec: number): string {
  const resolved = ftRounded(sec);
  return input.trim() === resolved ? '' : `Goal: ${resolved}`;
}

/** The button's no-save state (no goal on file, input at the forecast). */
export interface HyroxKeepForecastAction {
  label: string;
  /** After the modal closes; nothing is written. Omitted: just close. */
  run?: () => void;
}

/** The save button's label: the keep action's while no goal is on file and
 *  the input is the forecast, else "Save goal". */
export function goalSaveLabel(hasGoal: boolean, sec: number | null, forecastSec: number, keepLabel: string): string {
  return !hasGoal && sec === forecastSec ? keepLabel : 'Save goal';
}

/**
 * `opts.onChange` runs after a save or clear, so the view that opened the
 * modal re-renders (default: the forecast view, which opens it from the
 * hero; the race plan passes its own). `opts.keepForecast` is the button
 * while no goal is on file and the input is the forecast (default "Keep
 * forecast", which closes).
 */
export function openHyroxGoalModal(
  prediction: HyroxPrediction,
  opts: { onChange?: () => void; keepForecast?: HyroxKeepForecastAction } = {},
): void {
  const existing = document.getElementById('hx-goal-modal');
  if (existing) existing.remove();

  const ms = getMutableState();
  const hasGoal = (ms.hyroxConfig?.targetFinishTimeSec ?? 0) > 0;
  // No goal yet: the forecast is offered as the goal (the race plan's own
  // default), never a made-up improvement.
  const forecastSec = Math.round(prediction.totalSec);
  const initialTarget = hasGoal ? ms.hyroxConfig!.targetFinishTimeSec! : forecastSec;
  const keep: HyroxKeepForecastAction = opts.keepForecast ?? { label: 'Keep forecast' };

  const overlay = document.createElement('div');
  overlay.id = 'hx-goal-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:24px;max-width:420px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,0.18)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div style="font-size:17px;font-weight:700;color:#0F172A">${hasGoal ? 'Change goal' : 'Set a goal'}</div>
        <button id="hx-goal-close" style="background:none;border:none;cursor:pointer;color:var(--c-faint);font-size:20px;line-height:1;padding:0">×</button>
      </div>
      <div style="font-size:12px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">Current forecast: ${ftRounded(prediction.totalSec)}. The race plan paces every leg to your goal.</div>
      <label style="display:block;font-size:12px;font-weight:600;color:#0F172A;margin-bottom:6px">Goal time (mm:ss or h:mm:ss)</label>
      <input
        id="hx-goal-input"
        type="text"
        value="${ftRounded(initialTarget)}"
        style="width:100%;box-sizing:border-box;border:1.5px solid rgba(0,0,0,0.15);border-radius:10px;padding:10px 12px;font-size:16px;font-family:var(--f);color:#0F172A;outline:none;margin-bottom:6px"
      />
      <div id="hx-goal-echo" style="display:none;font-size:12px;color:var(--c-muted);margin:2px 0 4px"></div>
      <div id="hx-goal-result" style="margin-top:10px"></div>
      <div style="display:flex;gap:10px;margin-top:14px">
        ${hasGoal ? '<button id="hx-goal-clear" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer">Clear goal</button>' : ''}
        <button id="hx-goal-save" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer">${goalSaveLabel(hasGoal, initialTarget, forecastSec, keep.label)}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const floorSec = populationFloorSec(prediction);

  const computeAndRender = () => {
    const inputEl = document.getElementById('hx-goal-input') as HTMLInputElement | null;
    const resultEl = document.getElementById('hx-goal-result');
    const echoEl = document.getElementById('hx-goal-echo');
    if (!inputEl || !resultEl) return;
    const sec = parseHhMmSs(inputEl.value, floorSec);
    const saveEl = document.getElementById('hx-goal-save');
    if (saveEl) saveEl.textContent = goalSaveLabel(hasGoal, sec, forecastSec, keep.label);
    if (sec == null) {
      if (echoEl) { echoEl.textContent = ''; echoEl.style.display = 'none'; }
      resultEl.innerHTML = `<div style="font-size:12px;color:#ef4444;padding:8px 0">Enter time as mm:ss (e.g. 75:00) or h:mm:ss (e.g. 1:15:00).</div>`;
      return;
    }
    // Echo the resolved interpretation when it reads differently from the
    // input, so an ambiguous entry like "1:00" (read as 1 hour) is visible
    // and correctable; an input that already shows it is not repeated.
    if (echoEl) {
      echoEl.textContent = goalEchoText(inputEl.value, sec);
      echoEl.style.display = echoEl.textContent ? 'block' : 'none';
    }
    const st = getState();
    const result = computeGoalBackCalc(prediction, sec, hyroxGoalBackCalcOptions(st, prediction, sec));
    resultEl.innerHTML = renderResultBody(result, { goalSec: sec, forecastSec: prediction.totalSec, cohort: hyroxCohortForState(st) });
  };
  computeAndRender();

  document.getElementById('hx-goal-input')?.addEventListener('input', computeAndRender);

  // Close handlers. Close back to forecast (i.e. don't navigate).
  const close = () => overlay.remove();
  // targetFinishTimeSec only feeds the forecast hero's delta chip (not the
  // prediction itself), and this modal sits over the forecast, so re-render it
  // after save/clear or the chip stays stale until the user navigates away.
  // Dynamic import: forecast-view imports this modal, so a static import here
  // would be circular.
  const refreshForecast = () => {
    if (opts.onChange) { opts.onChange(); return; }
    import('./forecast-view').then(({ renderHyroxForecastView }) => renderHyroxForecastView());
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.getElementById('hx-goal-close')?.addEventListener('click', close);

  document.getElementById('hx-goal-save')?.addEventListener('click', () => {
    const inputEl = document.getElementById('hx-goal-input') as HTMLInputElement | null;
    const sec = inputEl ? parseHhMmSs(inputEl.value, floorSec) : null;
    if (sec == null) return;
    if (!hasGoal && sec === forecastSec) {
      // The forecast, with no goal on file: the button reads the keep
      // action's label, and nothing is written.
      close();
      keep.run?.();
      return;
    }
    const ms2 = getMutableState();
    if (ms2.hyroxConfig) ms2.hyroxConfig.targetFinishTimeSec = sec;
    saveState();
    close();
    refreshForecast();
  });

  document.getElementById('hx-goal-clear')?.addEventListener('click', () => {
    const ms2 = getMutableState();
    if (ms2.hyroxConfig) ms2.hyroxConfig.targetFinishTimeSec = undefined;
    saveState();
    close();
    refreshForecast();
  });
}
