/**
 * HYROX goal-back-calculation modal.
 *
 * Triggered from the forecast hero. Lets the user enter a target finish time
 * and shows the per-station + run-pace targets they'd need to hit. Reads from
 * the existing `targetFinishTimeSec` on `hyroxConfig` if set; otherwise
 * defaults to a 5% improvement on current prediction.
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
import { hyroxGoalBackCalcOptions, hyroxGoalFloorSec } from '@/calculations/hyrox-race-plan';
import { STATION_DISPLAY, STATION_SEED_TIMES_SEC, HYROX_RUN_PACE_MIN_SEC_KM } from '@/constants/hyrox-benchmarks';
import { ftRounded, fmtModelPaceKm } from '@/utils/format';

// Times and paces here are fractional (the back-calculation distributes the
// gain proportionally), so they round to the whole second before the minute
// split, the way the forecast shows the same numbers: times through ftRounded
// (forecast hero and station rows), run pace through fmtModelPaceKm (forecast
// average run pace). Rounding only the seconds part printed 59.6 s as "0:60".

/** "56 min" / "1 min 20 sec" / "40 sec" — readable duration, never raw seconds. */
function fmtApproxDuration(sec: number): string {
  const total = Math.round(sec);
  if (total < 60) return `${total} sec`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m} min` : `${m} min ${s} sec`;
}

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
 * The fastest finish the back-calc floors allow for this prediction: the
 * parse-disambiguation threshold. Floors from the athlete's own field
 * (hyroxGoalFloorSec: the top-1% medians per format and sex or division, the
 * pair's times for doubles); the legacy pooled seed only without a field.
 */
function populationFloorSec(prediction: HyroxPrediction): number {
  const cohortFloor = hyroxGoalFloorSec(getState(), prediction);
  if (cohortFloor > 0) return cohortFloor;
  const stationFloor = prediction.stations.reduce(
    (sum, l) => sum + (STATION_SEED_TIMES_SEC.competitive[l.station] ?? 0) * (l.teamRatio ?? 1),
    0,
  );
  return HYROX_RUN_PACE_MIN_SEC_KM * 8 + stationFloor + prediction.roxzoneSec;
}

export function renderResultBody(result: GoalBackCalcResult): string {
  if (result.feasibility === 'already_on_pace') {
    return `
      <div style="font-size:13px;color:var(--c-black);line-height:1.5;padding:14px;background:rgba(122,132,92,0.08);border-radius:10px;margin-bottom:14px">
        Your current forecast already beats this target. No changes to per-station targets needed.
      </div>
    `;
  }

  const headerCopy = result.feasibility === 'unrealistic'
    ? `<div style="font-size:13px;color:var(--c-black);line-height:1.5;padding:14px;background:rgba(0,0,0,0.04);border-radius:10px;margin-bottom:14px"><div style="font-weight:600;margin-bottom:4px">About ${fmtApproxDuration(result.shortfallSec)} faster than realistic.</div><div style="color:var(--c-muted);font-size:12px">${result.caveat ?? ''}</div></div>`
    : result.feasibility === 'stretch'
    ? `<div style="font-size:13px;color:var(--c-black);line-height:1.5;padding:14px;background:rgba(0,0,0,0.04);border-radius:10px;margin-bottom:14px"><div style="font-weight:600;margin-bottom:4px">Stretch target.</div><div style="color:var(--c-muted);font-size:12px">${result.caveat ?? ''}</div></div>`
    : `<div style="font-size:12px;color:var(--c-muted);margin-bottom:10px;line-height:1.5">${result.floorSource === 'cohort'
      ? "Spread by each component's headroom to the top-1% median of your field."
      : "Distributed proportional to each component's headroom against the band's competitive floor."}</div>`;

  const runRow = result.runPaceTarget.deltaSecKm < -0.5 ? `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.05)">
      <span style="color:var(--c-black)">Run pace</span>
      <span style="display:flex;gap:14px;align-items:baseline">
        <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtModelPaceKm(result.runPaceTarget.currentSecKm)} → ${fmtModelPaceKm(result.runPaceTarget.targetSecKm)}</span>
        <span style="font-size:12px;color:#4f5a3b;font-weight:600;font-variant-numeric:tabular-nums;min-width:48px;text-align:right">${result.runPaceTarget.deltaSecKm.toFixed(1)}s/km</span>
      </span>
    </div>
  ` : '';

  const stationRows = result.stationTargets
    .filter(t => t.deltaSec < -0.5) // hide rows that don't need to change
    .sort((a, b) => a.deltaSec - b.deltaSec) // biggest gain first
    .map((t, i) => {
      const display = STATION_DISPLAY[t.station];
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;font-size:13px;border-top:${i === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'}">
          <span style="color:var(--c-black)">${display.name}</span>
          <span style="display:flex;gap:14px;align-items:baseline">
            <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${ftRounded(t.currentSec)} → ${ftRounded(t.targetSec)}</span>
            <span style="font-size:12px;color:#4f5a3b;font-weight:600;font-variant-numeric:tabular-nums;min-width:48px;text-align:right">${Math.round(t.deltaSec)}s</span>
          </span>
        </div>
      `;
    }).join('');

  return `
    ${headerCopy}
    <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Run + station targets</div>
    ${runRow}
    ${stationRows || (runRow === '' ? '<div style="font-size:12px;color:var(--c-faint);padding:10px 0">All components already at floor.</div>' : '')}
  `;
}

/**
 * `opts.onChange` runs after a save or clear, so the view that opened the
 * modal re-renders (default: the forecast view, which opens it from the
 * hero; the race plan passes its own).
 */
export function openHyroxGoalModal(prediction: HyroxPrediction, opts: { onChange?: () => void } = {}): void {
  const existing = document.getElementById('hx-goal-modal');
  if (existing) existing.remove();

  const ms = getMutableState();
  const initialTarget = ms.hyroxConfig?.targetFinishTimeSec
    ?? Math.round(prediction.totalSec * 0.95); // default 5% improvement

  const overlay = document.createElement('div');
  overlay.id = 'hx-goal-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:24px;max-width:420px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,0.18)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div style="font-size:17px;font-weight:700;color:#0F172A">Set a target finish</div>
        <button id="hx-goal-close" style="background:none;border:none;cursor:pointer;color:var(--c-faint);font-size:20px;line-height:1;padding:0">×</button>
      </div>
      <div style="font-size:12px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">Current forecast: ${ftRounded(prediction.totalSec)}. Enter a target and we'll back-calculate the per-station times you'd need.</div>
      <label style="display:block;font-size:12px;font-weight:600;color:#0F172A;margin-bottom:6px">Target time (mm:ss or h:mm:ss)</label>
      <input
        id="hx-goal-input"
        type="text"
        value="${ftRounded(initialTarget)}"
        style="width:100%;box-sizing:border-box;border:1.5px solid rgba(0,0,0,0.15);border-radius:10px;padding:10px 12px;font-size:16px;font-family:var(--f);color:#0F172A;outline:none;margin-bottom:6px"
      />
      <div id="hx-goal-echo" style="font-size:12px;color:var(--c-muted);min-height:16px;margin-bottom:14px"></div>
      <div id="hx-goal-result"></div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button id="hx-goal-clear" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer">Clear target</button>
        <button id="hx-goal-save" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer">Save target</button>
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
    if (sec == null) {
      if (echoEl) echoEl.textContent = '';
      resultEl.innerHTML = `<div style="font-size:12px;color:#ef4444;padding:8px 0">Enter time as mm:ss (e.g. 75:00) or h:mm:ss (e.g. 1:15:00).</div>`;
      return;
    }
    // Always echo the resolved interpretation so an ambiguous entry like "1:00"
    // (read as 1 hour) is visible and correctable.
    if (echoEl) echoEl.textContent = `Target: ${ftRounded(sec)}`;
    const result = computeGoalBackCalc(prediction, sec, hyroxGoalBackCalcOptions(getState(), prediction, sec));
    resultEl.innerHTML = renderResultBody(result);
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
