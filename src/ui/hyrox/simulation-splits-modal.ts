/**
 * HYROX simulation split entry sheet.
 *
 * Opened from the simulation session's detail modal once the athlete has run
 * it. Captures the eight station splits and the total run-leg time in one pass,
 * then hands them to `hyrox-simulation-splits` to write into the calibration
 * fields the race forecast reads.
 *
 * All calibration logic lives in `@/calculations/hyrox-simulation-splits`;
 * this module is the DOM layer only.
 */

import type { HyroxStation } from '@/types/triathlon';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import {
  STATION_DISPLAY,
  STATION_RACE_VOLUME,
  STATION_HALF_VOLUME,
  HYROX_STATION_ORDER,
} from '@/constants/hyrox-benchmarks';
import {
  applySplitsToConfig,
  simulationLegDistanceM,
  type SplitEntryResult,
} from '@/calculations/hyrox-simulation-splits';

const MODAL_ID = 'hx-sim-splits-modal';

/** Persist entered splits to app state. */
export function applySimulationSplits(
  stationInputs: Partial<Record<HyroxStation, string>>,
  runTotalInput: string,
  isHalf: boolean,
): SplitEntryResult {
  const hx = getMutableState().hyroxConfig;
  if (!hx) return { stationsUpdated: 0, runPaceUpdated: false, rejected: [] };
  const result = applySplitsToConfig(
    hx, stationInputs, runTotalInput, isHalf, new Date().toISOString().slice(0, 10),
  );
  if (result.stationsUpdated > 0 || result.runPaceUpdated) saveState();
  return result;
}

/** Open the split entry sheet for a completed simulation. */
export function openSimulationSplitsModal(isHalf: boolean, onSaved: () => void): void {
  document.getElementById(MODAL_ID)?.remove();

  const volumes = isHalf ? STATION_HALF_VOLUME : STATION_RACE_VOLUME;
  const legDistanceM = simulationLegDistanceM(isHalf);
  const totalRunKm = (legDistanceM * HYROX_STATION_ORDER.length) / 1000;

  const rows = HYROX_STATION_ORDER.map(station => {
    const display = STATION_DISPLAY[station];
    const vol = volumes[station];
    const volStr = vol.reps ? `${vol.reps} reps` : `${vol.distanceM}m`;
    return `
      <div style="display:grid;grid-template-columns:1fr 96px;gap:12px;align-items:center;padding:9px 0;border-top:1px solid rgba(0,0,0,0.05)">
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:600;color:#0F172A">${display.name}</div>
          <div style="font-size:11px;color:var(--c-muted)">${volStr}</div>
        </div>
        <input
          data-hx-split="${station}"
          type="text"
          inputmode="numeric"
          placeholder="m:ss"
          style="width:100%;box-sizing:border-box;border:1px solid rgba(0,0,0,0.15);border-radius:9px;padding:8px 10px;font-size:15px;font-family:var(--f);color:#0F172A;outline:none;text-align:right;font-variant-numeric:tabular-nums"
        />
      </div>`;
  }).join('');

  const scaleNote = isHalf
    ? 'Half-distance times are doubled to estimate your full-distance benchmark.'
    : 'Times are stored as entered, at full race distance.';

  const overlay = document.createElement('div');
  overlay.id = MODAL_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:210;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto';
  overlay.innerHTML = `
    <div style="background:#FAF9F6;border-radius:20px;width:100%;max-width:440px;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.25)">
      <div style="padding:20px 22px 14px;border-bottom:1px solid rgba(0,0,0,0.06)">
        <div style="font-size:18px;font-weight:700;color:#0F172A;letter-spacing:-0.01em">Record your splits</div>
        <div style="font-size:12px;color:var(--c-muted);margin-top:5px;line-height:1.5">
          ${scaleNote} Anything left blank is skipped.
        </div>
      </div>

      <div style="padding:6px 22px 4px">
        ${rows}
      </div>

      <div style="padding:14px 22px 4px">
        <div style="display:grid;grid-template-columns:1fr 96px;gap:12px;align-items:center;padding-top:12px;border-top:1px solid rgba(0,0,0,0.08)">
          <div>
            <div style="font-size:13px;font-weight:600;color:#0F172A">Total run time</div>
            <div style="font-size:11px;color:var(--c-muted)">All 8 legs, ${totalRunKm} km</div>
          </div>
          <input
            id="hx-split-run-total"
            type="text"
            inputmode="numeric"
            placeholder="mm:ss"
            style="width:100%;box-sizing:border-box;border:1px solid rgba(0,0,0,0.15);border-radius:9px;padding:8px 10px;font-size:15px;font-family:var(--f);color:#0F172A;outline:none;text-align:right;font-variant-numeric:tabular-nums"
          />
        </div>
      </div>

      <div id="hx-split-error" style="padding:0 22px;font-size:11px;color:var(--c-muted);min-height:16px;margin-top:8px"></div>

      <div style="display:flex;gap:8px;padding:10px 18px 18px">
        <button id="hx-split-cancel" style="flex:1;padding:11px;border-radius:12px;border:1px solid rgba(0,0,0,0.10);background:transparent;color:var(--c-muted);font-size:14px;cursor:pointer">Cancel</button>
        <button id="hx-split-save" style="flex:2;padding:11px;border-radius:12px;border:none;background:#0F172A;color:#FDFCF7;font-size:14px;font-weight:600;cursor:pointer">Save splits</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#hx-split-cancel')?.addEventListener('click', () => overlay.remove());

  overlay.querySelector('#hx-split-save')?.addEventListener('click', () => {
    const stationInputs: Partial<Record<HyroxStation, string>> = {};
    overlay.querySelectorAll<HTMLInputElement>('[data-hx-split]').forEach(input => {
      const station = input.getAttribute('data-hx-split') as HyroxStation;
      if (station) stationInputs[station] = input.value;
    });
    const runTotal = (overlay.querySelector('#hx-split-run-total') as HTMLInputElement | null)?.value ?? '';

    const result = applySimulationSplits(stationInputs, runTotal, isHalf);
    const errorEl = overlay.querySelector('#hx-split-error') as HTMLElement | null;

    if (result.stationsUpdated === 0 && !result.runPaceUpdated) {
      if (errorEl) {
        errorEl.textContent = result.rejected.length
          ? `Could not read: ${result.rejected.join(', ')}. Use m:ss.`
          : 'Enter at least one split.';
      }
      return;
    }

    overlay.remove();
    onSaved();
  });
}
