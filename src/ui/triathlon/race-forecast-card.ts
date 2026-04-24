/**
 * Race forecast card (§18.8).
 *
 * Headline total time + expandable per-leg breakdown. Shows confidence
 * band, sprint/Olympic side-effect predictions, and editable targets.
 * Targets live in `state.triConfig.userTargets` once the user clicks edit.
 */

import type { SimulatorState } from '@/types/state';
import type { TriRacePrediction } from '@/types/triathlon';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { DISCIPLINE_COLOURS } from './colours';

export function renderRaceForecastCard(state: SimulatorState): string {
  const tri = state.triConfig;
  if (!tri) return '';

  const p: TriRacePrediction | null = tri.prediction ?? predictTriathlonRace(state);
  if (!p) return '';

  const distLabel = tri.distance === 'ironman' ? 'Ironman' : '70.3';

  return `
    <div style="margin-bottom:20px">
      <h2 style="font-size:13px;font-weight:500;color:var(--c-muted);letter-spacing:0.08em;text-transform:uppercase;margin:0 0 10px">Race forecast</h2>
      <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px">
          <div>
            <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${distLabel} predicted time</div>
            <div style="font-size:32px;font-weight:300;color:var(--c-black);font-variant-numeric:tabular-nums;letter-spacing:-0.01em">${fmtDuration(p.totalSec)}</div>
            <div style="font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums;margin-top:2px">Range ${fmtDuration(p.totalRangeSec[0])} to ${fmtDuration(p.totalRangeSec[1])}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">
          ${legCell('Swim', p.swimSec, DISCIPLINE_COLOURS.swim.accent)}
          ${legCell('Bike', p.bikeSec, DISCIPLINE_COLOURS.bike.accent)}
          ${legCell('Run', p.runSec, DISCIPLINE_COLOURS.run.accent)}
        </div>

        <div style="display:flex;gap:12px;font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">
          <span>T1: ${fmtShort(p.t1Sec)}</span>
          <span>T2: ${fmtShort(p.t2Sec)}</span>
        </div>

        ${p.sprintTotalSec || p.olympicTotalSec ? `
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(0,0,0,0.06);font-size:12px;color:var(--c-muted);line-height:1.6">
            ${p.sprintTotalSec ? `Sprint: <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtDuration(p.sprintTotalSec)}</span>` : ''}
            ${p.sprintTotalSec && p.olympicTotalSec ? ' · ' : ''}
            ${p.olympicTotalSec ? `Olympic: <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtDuration(p.olympicTotalSec)}</span>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function legCell(label: string, sec: number, accent: string): string {
  return `
    <div style="background:rgba(255,255,255,0.6);border-left:2px solid ${accent};border-radius:8px;padding:10px 12px">
      <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${label}</div>
      <div style="font-size:16px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtDuration(sec)}</div>
    </div>
  `;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtShort(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
