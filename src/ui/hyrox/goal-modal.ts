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

import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import type { HyroxPrediction } from '@/calculations/race-prediction.hyrox';
import { computeGoalBackCalc, type GoalBackCalcResult } from '@/calculations/hyrox-goal-back-calc';
import { STATION_DISPLAY } from '@/constants/hyrox-benchmarks';

function fmtMmSs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function fmtHhMmSs(sec: number): string {
  if (sec < 3600) return fmtMmSs(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60).toString().padStart(2, '0');
  return `${h}:${m.toString().padStart(2, '0')}:${s}`;
}

function parseHhMmSs(input: string): number | null {
  const clean = input.trim().replace(/[^0-9:]/g, '');
  const parts = clean.split(':');
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseInt(parts[1], 10);
    if (Number.isNaN(m) || Number.isNaN(s) || s >= 60) return null;
    return m * 60 + s;
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

function renderResultBody(result: GoalBackCalcResult): string {
  if (result.feasibility === 'already_on_pace') {
    return `
      <div style="font-size:13px;color:var(--c-black);line-height:1.5;padding:14px;background:rgba(122,132,92,0.08);border-radius:10px;margin-bottom:14px">
        Your current forecast already beats this target. No changes to per-station targets needed.
      </div>
    `;
  }

  const headerCopy = result.feasibility === 'unrealistic'
    ? `<div style="font-size:13px;color:var(--c-black);line-height:1.5;padding:14px;background:rgba(0,0,0,0.04);border-radius:10px;margin-bottom:14px"><div style="font-weight:600;margin-bottom:4px">Target needs ~${result.shortfallSec}s more than the population floor.</div><div style="color:var(--c-muted);font-size:12px">${result.caveat ?? ''}</div></div>`
    : result.feasibility === 'stretch'
    ? `<div style="font-size:13px;color:var(--c-black);line-height:1.5;padding:14px;background:rgba(0,0,0,0.04);border-radius:10px;margin-bottom:14px"><div style="font-weight:600;margin-bottom:4px">Stretch target.</div><div style="color:var(--c-muted);font-size:12px">${result.caveat ?? ''}</div></div>`
    : `<div style="font-size:12px;color:var(--c-muted);margin-bottom:10px;line-height:1.5">Distributed proportional to each component's headroom against the band's competitive floor.</div>`;

  const runRow = result.runPaceTarget.deltaSecKm < -0.5 ? `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.05)">
      <span style="color:var(--c-black)">Run pace</span>
      <span style="display:flex;gap:14px;align-items:baseline">
        <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtMmSs(result.runPaceTarget.currentSecKm)} → ${fmtMmSs(result.runPaceTarget.targetSecKm)}</span>
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
            <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtMmSs(t.currentSec)} → ${fmtMmSs(t.targetSec)}</span>
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

export function openHyroxGoalModal(prediction: HyroxPrediction): void {
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
      <div style="font-size:12px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">Current forecast: ${fmtHhMmSs(prediction.totalSec)}. Enter a target and we'll back-calculate the per-station times you'd need.</div>
      <label style="display:block;font-size:12px;font-weight:600;color:#0F172A;margin-bottom:6px">Target time (mm:ss or h:mm:ss)</label>
      <input
        id="hx-goal-input"
        type="text"
        value="${fmtHhMmSs(initialTarget)}"
        style="width:100%;box-sizing:border-box;border:1.5px solid rgba(0,0,0,0.15);border-radius:10px;padding:10px 12px;font-size:16px;font-family:var(--f);color:#0F172A;outline:none;margin-bottom:16px"
      />
      <div id="hx-goal-result"></div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button id="hx-goal-clear" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer">Clear target</button>
        <button id="hx-goal-save" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer">Save target</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const computeAndRender = () => {
    const inputEl = document.getElementById('hx-goal-input') as HTMLInputElement | null;
    const resultEl = document.getElementById('hx-goal-result');
    if (!inputEl || !resultEl) return;
    const sec = parseHhMmSs(inputEl.value);
    if (sec == null) {
      resultEl.innerHTML = `<div style="font-size:12px;color:#ef4444;padding:8px 0">Enter time as mm:ss (e.g. 75:00) or h:mm:ss (e.g. 1:15:00).</div>`;
      return;
    }
    const result = computeGoalBackCalc(prediction, sec);
    resultEl.innerHTML = renderResultBody(result);
  };
  computeAndRender();

  document.getElementById('hx-goal-input')?.addEventListener('input', computeAndRender);

  // Close handlers — close back to forecast (i.e. don't navigate).
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.getElementById('hx-goal-close')?.addEventListener('click', close);

  document.getElementById('hx-goal-save')?.addEventListener('click', () => {
    const inputEl = document.getElementById('hx-goal-input') as HTMLInputElement | null;
    const sec = inputEl ? parseHhMmSs(inputEl.value) : null;
    if (sec == null) return;
    const ms2 = getMutableState();
    if (ms2.hyroxConfig) ms2.hyroxConfig.targetFinishTimeSec = sec;
    saveState();
    close();
  });

  document.getElementById('hx-goal-clear')?.addEventListener('click', () => {
    const ms2 = getMutableState();
    if (ms2.hyroxConfig) ms2.hyroxConfig.targetFinishTimeSec = undefined;
    saveState();
    close();
  });
}
