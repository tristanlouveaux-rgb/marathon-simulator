/**
 * Adaptation card — surfaces the per-discipline adaptation ratio on the
 * triathlon stats page. Shows whether the athlete is responding to training
 * faster, slower, or about as expected.
 *
 * Data comes from `state.triConfig.prediction.adaptation` (computed by
 * `computeTriAdaptationRatios` and stored on the prediction during sync).
 *
 * Tone: direct, factual. No motivational padding (CLAUDE.md UI Copy rules).
 */

import type { SimulatorState } from '@/types/state';
import { DISCIPLINE_COLOURS, DISCIPLINE_LABEL } from './colours';

export function renderTriAdaptationCard(state: SimulatorState): string {
  const adaptation = state.triConfig?.prediction?.adaptation;
  if (!adaptation) return '';

  const someSignal =
    adaptation.signals.hrv != null ||
    adaptation.signals.rpeSwim != null ||
    adaptation.signals.rpeBike != null ||
    adaptation.signals.rpeRun != null ||
    adaptation.signals.hrAtPower != null ||
    adaptation.signals.pahrBike != null ||
    adaptation.signals.pahrRun != null ||
    adaptation.signals.cssSd != null;

  if (!someSignal) return '';

  return `
    <div class="tri-stats-card hf" data-delay="0.12">
      <div class="tri-stats-label">Adaptation</div>
      ${(['swim', 'bike', 'run'] as const).map(d => renderRow(d, adaptation[d])).join('')}
      ${renderSignalsLine(adaptation.signals)}
    </div>
  `;
}

function renderRow(discipline: 'swim' | 'bike' | 'run', ratio: number): string {
  const c = DISCIPLINE_COLOURS[discipline];
  const deltaPct = (ratio - 1) * 100;
  const onTrack = Math.abs(deltaPct) < 5;
  const verdict = onTrack
    ? 'on track'
    : deltaPct > 0
      ? `adapting ${deltaPct.toFixed(0)}% faster than expected`
      : `adapting ${Math.abs(deltaPct).toFixed(0)}% slower than expected`;
  const colour = onTrack ? '#7a845c' : deltaPct > 0 ? '#5a8050' : '#a06050';
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:8px;background:${c.bg};border:1px solid ${c.border};margin-bottom:6px">
      <span style="font-size:13px;font-weight:600;color:#0F172A">${DISCIPLINE_LABEL[discipline]}</span>
      <span style="font-size:12px;color:${colour};font-variant-numeric:tabular-nums">${verdict}</span>
    </div>
  `;
}

function renderSignalsLine(s: NonNullable<NonNullable<SimulatorState['triConfig']>['prediction']>['adaptation'] extends infer T ? T extends { signals: infer S } ? S : never : never): string {
  const parts: string[] = [];
  if (s.hrv != null) parts.push(`HRV ${fmtPct(s.hrv)}`);
  if (s.rpeSwim != null) parts.push(`Swim RPE ${fmtPct(s.rpeSwim)}`);
  if (s.rpeBike != null) parts.push(`Bike RPE ${fmtPct(s.rpeBike)}`);
  if (s.rpeRun != null) parts.push(`Run RPE ${fmtPct(s.rpeRun)}`);
  if (s.hrAtPower != null) parts.push(`Bike HR/W ${fmtPct(s.hrAtPower)}`);
  if (s.pahrBike != null) parts.push(`Bike Pa:Hr ${fmtPct(s.pahrBike)}`);
  if (s.pahrRun != null) parts.push(`Run Pa:Hr ${fmtPct(s.pahrRun)}`);
  if (s.cssSd != null) parts.push(`Swim SD ${fmtPct(s.cssSd)}`);
  if (parts.length === 0) return '';
  return `
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,0.06);font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums;line-height:1.5">
      ${parts.join(' &middot; ')}
    </div>
  `;
}

function fmtPct(v: number): string {
  const pct = (v * 100).toFixed(1);
  return v > 0 ? `+${pct}%` : `${pct}%`;
}
