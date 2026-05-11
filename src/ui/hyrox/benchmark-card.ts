/**
 * HYROX station benchmark calibration card.
 *
 * Appears in the plan view (weeks 1–4, current week only) when the user still
 * has stations using population estimates rather than personal times. Mirrors
 * the triathlon benchmark-tests-card.ts pattern.
 *
 * Protocol: complete each station at half the race distance/reps, record the
 * time. The system doubles it to estimate full-distance performance and stores
 * it in `hyroxConfig.stationBenchmarks`.
 *
 * Dismissed via `hyroxConfig.dismissedBenchmarkCard = true`. Per-station
 * "Done" marks that station and re-renders.
 */

import type { SimulatorState } from '@/types/state';
import type { HyroxStation } from '@/types/triathlon';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import {
  STATION_SEED_TIMES_SEC,
  STATION_DISPLAY,
  HYROX_STATION_ORDER,
} from '@/constants/hyrox-benchmarks';
import { appendStationTest, type HyroxFormat } from '@/calculations/hyrox-station-history';

/** Stations that can be calibrated — always available (no equipment dependency). */
const CALIBRATABLE: HyroxStation[] = [
  'row_erg', 'ski_erg', 'farmer_carry', 'sandbag_lunges', 'wall_balls',
  'burpee_broad_jumps', 'sled_push', 'sled_pull',
];

/** Half-distance protocol description per station. */
const HALF_PROTOCOL: Record<HyroxStation, string> = {
  ski_erg:            '500m',
  sled_push:          '25m',
  sled_pull:          '25m',
  burpee_broad_jumps: '40m (10 reps)',
  row_erg:            '500m',
  farmer_carry:       '100m',
  sandbag_lunges:     '50m',
  wall_balls:         '50 reps',
};

/** Read benchmarks from the format-specific slot, falling back to legacy pooled field. */
function readBenchmarks(hx: NonNullable<SimulatorState['hyroxConfig']>): Partial<Record<HyroxStation, number>> {
  const isDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  return (isDoubles ? hx.stationBenchmarksDoubles : hx.stationBenchmarksSingles) ?? hx.stationBenchmarks ?? {};
}

/** Which stations still use population estimates (no user data). */
function stationsNeedingCalibration(s: SimulatorState): HyroxStation[] {
  const hx = s.hyroxConfig;
  if (!hx) return [];
  const benchmarks = readBenchmarks(hx);
  const avail = CALIBRATABLE.filter(station => {
    if (station === 'ski_erg' && !hx.stationAccess.skiErg) return false;
    if (station === 'row_erg' && !hx.stationAccess.rowErg) return false;
    if ((station === 'sled_push' || station === 'sled_pull') && hx.stationAccess.sled === 'never') return false;
    return true;
  });
  return avail.filter(station => !benchmarks[station]);
}

/** Whether the benchmark card should show (current-week only, not dismissed, stations pending). */
export function shouldShowBenchmarkCard(s: SimulatorState, viewWeek: number): boolean {
  if (viewWeek !== s.w) return false;
  if ((s.hyroxConfig as any)?.dismissedBenchmarkCard) return false;
  return stationsNeedingCalibration(s).length > 0;
}

/** Render the benchmark card HTML. */
export function renderHyroxBenchmarkCard(s: SimulatorState): string {
  const pending = stationsNeedingCalibration(s);
  if (!pending.length) return '';
  if ((s.hyroxConfig as any)?.dismissedBenchmarkCard) return '';

  const band = s.hyroxConfig!.athleteBand;
  const count = pending.length;
  const label = count === CALIBRATABLE.filter(st => {
    const hx = s.hyroxConfig!;
    if (st === 'ski_erg' && !hx.stationAccess.skiErg) return false;
    if (st === 'row_erg' && !hx.stationAccess.rowErg) return false;
    if ((st === 'sled_push' || st === 'sled_pull') && hx.stationAccess.sled === 'never') return false;
    return true;
  }).length ? 'Using population benchmarks for all stations.' : `${count} station${count > 1 ? 's' : ''} still using population estimates.`;

  const stationRows = pending.slice(0, 4).map(station => {
    const display = STATION_DISPLAY[station];
    const seedSec = STATION_SEED_TIMES_SEC[band][station];
    const seedMin = Math.floor(seedSec / 60);
    const seedSecStr = String(seedSec % 60).padStart(2, '0');
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
        <div>
          <div style="font-size:13px;font-weight:600;color:#0F172A">${display.name}</div>
          <div style="font-size:11px;color:var(--c-muted)">Half test: ${HALF_PROTOCOL[station]}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:var(--c-faint)">Population: ${seedMin}:${seedSecStr}</div>
          <button data-hx-bench-station="${station}" style="margin-top:3px;font-size:11px;font-weight:600;color:#b8742c;background:none;border:1px solid rgba(184,116,44,0.3);border-radius:6px;padding:2px 10px;cursor:pointer">Enter time</button>
        </div>
      </div>
    `;
  }).join('');

  const moreCount = pending.length > 4 ? pending.length - 4 : 0;

  return `
    <div id="hx-benchmark-card" style="margin:0 20px 16px;background:#fff;border-radius:14px;padding:16px 18px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 6px 18px rgba(0,0,0,0.05)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px">
        <div>
          <div style="font-size:14px;font-weight:700;color:#0F172A;margin-bottom:3px">Calibrate your station times</div>
          <div style="font-size:12px;color:var(--c-muted)">${label}</div>
        </div>
        <button id="hx-bench-dismiss" style="background:none;border:none;cursor:pointer;color:var(--c-faint);font-size:18px;line-height:1;padding:0 0 0 8px">×</button>
      </div>
      <div style="font-size:12px;color:var(--c-muted);line-height:1.5;margin-bottom:12px">
        Complete each station at half the race distance, record your time. More accurate than population averages for forecasting and plan calibration.
      </div>
      ${stationRows}
      ${moreCount > 0 ? `<div style="margin-top:8px;font-size:11px;color:var(--c-faint)">+${moreCount} more station${moreCount > 1 ? 's' : ''}</div>` : ''}
    </div>
  `;
}

/** Wire the benchmark card's interaction handlers. */
export function wireHyroxBenchmarkCard(onUpdate: () => void): void {
  // Dismiss
  document.getElementById('hx-bench-dismiss')?.addEventListener('click', () => {
    const ms = getMutableState();
    if (ms.hyroxConfig) (ms.hyroxConfig as any).dismissedBenchmarkCard = true;
    saveState();
    onUpdate();
  });

  // "Enter time" per station → opens inline input
  document.querySelectorAll<HTMLElement>('[data-hx-bench-station]').forEach(btn => {
    btn.addEventListener('click', () => {
      const station = btn.getAttribute('data-hx-bench-station') as HyroxStation;
      if (!station) return;
      openStationTimeModal(station, onUpdate);
    });
  });
}

function openStationTimeModal(station: HyroxStation, onUpdate: () => void): void {
  const existing = document.getElementById('hx-bench-modal');
  if (existing) existing.remove();

  const display = STATION_DISPLAY[station];
  const protocol = HALF_PROTOCOL[station];

  const overlay = document.createElement('div');
  overlay.id = 'hx-bench-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:28px 24px;max-width:360px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,0.18)">
      <div style="font-size:17px;font-weight:700;color:#0F172A;margin-bottom:6px">${display.name}</div>
      <div style="font-size:13px;color:var(--c-muted);margin-bottom:20px;line-height:1.5">
        Complete <strong>${protocol}</strong> at race effort. Enter your time below.
        The system will estimate your full-distance performance.
      </div>
      <label style="display:block;font-size:12px;font-weight:600;color:#0F172A;margin-bottom:6px">Your half-test time (mm:ss)</label>
      <input
        id="hx-bench-time-input"
        type="text"
        placeholder="e.g. 2:30"
        style="width:100%;box-sizing:border-box;border:1.5px solid rgba(0,0,0,0.15);border-radius:10px;padding:10px 12px;font-size:16px;font-family:var(--f);color:#0F172A;outline:none;margin-bottom:16px"
      />
      <div style="display:flex;gap:10px">
        <button id="hx-bench-cancel" style="flex:1;padding:12px;border-radius:10px;border:1px solid rgba(0,0,0,0.1);background:transparent;font-size:14px;font-weight:600;color:var(--c-muted);cursor:pointer">Cancel</button>
        <button id="hx-bench-save" style="flex:1;padding:12px;border-radius:10px;border:none;background:#0F172A;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  (document.getElementById('hx-bench-time-input') as HTMLInputElement)?.focus();

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); }
  });
  document.getElementById('hx-bench-cancel')?.addEventListener('click', () => overlay.remove());
  document.getElementById('hx-bench-save')?.addEventListener('click', () => {
    const input = (document.getElementById('hx-bench-time-input') as HTMLInputElement)?.value ?? '';
    const sec = parseMmSs(input);
    if (sec == null) {
      const inp = document.getElementById('hx-bench-time-input') as HTMLInputElement;
      if (inp) inp.style.borderColor = '#ef4444';
      return;
    }
    // Double the half-distance time to estimate full-distance performance.
    const fullSec = sec * 2;
    const ms = getMutableState();
    if (ms.hyroxConfig) {
      const isDoubles = ms.hyroxConfig.format === 'open_doubles' || ms.hyroxConfig.format === 'pro_doubles';
      if (isDoubles) {
        ms.hyroxConfig.stationBenchmarksDoubles = ms.hyroxConfig.stationBenchmarksDoubles ?? {};
        ms.hyroxConfig.stationBenchmarksDoubles[station] = fullSec;
      } else {
        ms.hyroxConfig.stationBenchmarksSingles = ms.hyroxConfig.stationBenchmarksSingles ?? {};
        ms.hyroxConfig.stationBenchmarksSingles[station] = fullSec;
      }
      // Append to history so per-station progression and PR detection work.
      // The latest entry per station is the canonical "current" benchmark; the
      // scalar fields above remain authoritative for fast prediction-time reads.
      ms.hyroxConfig.stationBenchmarkHistory = ms.hyroxConfig.stationBenchmarkHistory ?? {};
      ms.hyroxConfig.stationBenchmarkHistory[station] = appendStationTest(
        ms.hyroxConfig.stationBenchmarkHistory[station],
        {
          dateISO: new Date().toISOString().slice(0, 10),
          sec: fullSec,
          source: 'half_test',
          format: ms.hyroxConfig.format as HyroxFormat,
          proWeights: !!ms.hyroxConfig.benchmarksAtProWeights,
        },
      );
    }
    saveState();
    overlay.remove();
    onUpdate();
  });
}

function parseMmSs(input: string): number | null {
  const clean = input.trim().replace(/[^0-9:]/g, '');
  const parts = clean.split(':');
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseInt(parts[1], 10);
    if (isNaN(m) || isNaN(s) || s >= 60) return null;
    return m * 60 + s;
  }
  if (parts.length === 1) {
    const s = parseInt(parts[0], 10);
    if (isNaN(s)) return null;
    return s;
  }
  return null;
}
