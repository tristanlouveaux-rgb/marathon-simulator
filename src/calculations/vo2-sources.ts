/**
 * VO2max source comparison — collects all available VO2 estimates and flags
 * when they disagree significantly. Used to surface the conflict banner on
 * the VO2max detail page so the user can make an informed source choice.
 *
 * Comparison sources:
 *   - device:        s.vo2 from Garmin/Apple watch sync
 *   - hr-calibrated: s.hrCalibratedVdot (pace-vs-%HRR regression of steady runs)
 *   - pb-derived:    median VDOT across race-distance PBs
 *
 * The cardiac ceiling (Uth-Sørensen) is intentionally excluded — it's a
 * physiological upper bound, not a current-fitness estimate, and would trigger
 * constant false alarms.
 *
 * Conflict triggers (either condition):
 *   1. max(values) - min(values) ≥ 3 VDOT points
 *   2. Device reading is > 90 days old (s.vo2UpdatedAt)
 *
 * Pure — no state mutation, no I/O.
 */

import type { SimulatorState } from '@/types/state';
import { pbDerivedVdot } from './physiological-vdot';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A single VO2 estimate from a specific source. */
export interface Vo2SourceEntry {
  source: 'device' | 'hr-calibrated' | 'pb-derived';
  /** Human-readable label for UI. */
  label: string;
  /** Value in ml/kg/min (VDOT scale — same unit as s.vo2). */
  value: number;
  confidence: 'high' | 'medium' | 'low';
  /** Age of the reading in days, or null when no timestamp is available. */
  ageDays: number | null;
}

export interface Vo2ConflictResult {
  /** Whether a conflict worth surfacing was detected. */
  hasConflict: boolean;
  /** All available sources (≥ 2 for hasConflict to be true). */
  sources: Vo2SourceEntry[];
  /** Largest difference between any two source values. */
  maxDelta: number;
  /** True when the device reading is > 90 days old. */
  hasStaleDevice: boolean;
}

/** Threshold: surface banner when sources differ by this many VDOT points. */
export const VO2_CONFLICT_DELTA_THRESHOLD = 3;
/** Threshold: surface banner when device reading is older than this. */
export const VO2_DEVICE_STALENESS_DAYS = 90;

/**
 * Collect all available VO2 estimates and determine whether they conflict.
 */
export function getVo2Conflict(s: SimulatorState): Vo2ConflictResult {
  const empty: Vo2ConflictResult = { hasConflict: false, sources: [], maxDelta: 0, hasStaleDevice: false };
  const sources: Vo2SourceEntry[] = [];

  // 1. Device reading (Garmin or Apple Watch).
  if (s.vo2 != null && s.vo2 > 0) {
    const ageDays = s.vo2UpdatedAt
      ? (Date.now() - new Date(s.vo2UpdatedAt).getTime()) / DAY_MS
      : null;
    sources.push({
      source: 'device',
      label: 'Watch',
      value: s.vo2,
      confidence: 'high',
      ageDays,
    });
  }

  // 2. HR-calibrated VDOT (pace-vs-%HRR regression of steady runs).
  const hr = s.hrCalibratedVdot;
  if (hr?.vdot != null && hr.vdot > 0 && (hr.confidence === 'high' || hr.confidence === 'medium')) {
    sources.push({
      source: 'hr-calibrated',
      label: 'Pace/HR regression',
      value: hr.vdot,
      confidence: hr.confidence,
      ageDays: null,
    });
  }

  // 3. PB-derived VDOT (median across race-distance PBs).
  const pbVdot = pbDerivedVdot(s);
  if (pbVdot != null && pbVdot > 0) {
    sources.push({
      source: 'pb-derived',
      label: 'Race PBs',
      value: pbVdot,
      confidence: 'medium',
      ageDays: null,
    });
  }

  if (sources.length < 2) return { ...empty, sources };

  const values = sources.map(e => e.value);
  const maxDelta = Math.max(...values) - Math.min(...values);
  const deviceEntry = sources.find(e => e.source === 'device');
  const hasStaleDevice = deviceEntry != null
    && deviceEntry.ageDays != null
    && deviceEntry.ageDays > VO2_DEVICE_STALENESS_DAYS;

  return {
    hasConflict: maxDelta >= VO2_CONFLICT_DELTA_THRESHOLD || hasStaleDevice,
    sources,
    maxDelta,
    hasStaleDevice,
  };
}

/**
 * Build the conflict banner HTML for the VO2 detail page.
 * Returns empty string when no conflict exists.
 * Consultant tone — no emoji, no accent colours, no ALL-CAPS.
 */
export function buildVo2ConflictBanner(conflict: Vo2ConflictResult): string {
  if (!conflict.hasConflict) return '';

  const lines: string[] = [];

  if (conflict.maxDelta >= VO2_CONFLICT_DELTA_THRESHOLD) {
    const deviceEntry = conflict.sources.find(e => e.source === 'device');
    const altEntry = conflict.sources.find(e => e.source !== 'device');
    if (deviceEntry && altEntry) {
      const higher = deviceEntry.value > altEntry.value ? deviceEntry : altEntry;
      const lower  = deviceEntry.value > altEntry.value ? altEntry : deviceEntry;
      lines.push(
        `${higher.label} implies ${Math.round(higher.value)}, ${lower.label.toLowerCase()} implies ${Math.round(lower.value)} — a ${Math.round(conflict.maxDelta)}-point gap.`
      );
    } else if (conflict.sources.length >= 2) {
      lines.push(`Available sources disagree by ${Math.round(conflict.maxDelta)} points.`);
    }
    lines.push('Use the Source toggle to pick the reading that best reflects your fitness.');
  }

  if (conflict.hasStaleDevice) {
    const deviceEntry = conflict.sources.find(e => e.source === 'device');
    const ageDays = deviceEntry?.ageDays ?? null;
    if (ageDays != null) {
      const months = Math.round(ageDays / 30);
      lines.push(`Watch reading is ${months > 1 ? `${months} months` : 'over a month'} old — recent training data may be more current.`);
    }
  }

  if (lines.length === 0) return '';

  return `
    <div class="m-card" style="padding:12px 14px;margin-bottom:8px;border:1px solid var(--c-border)">
      <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:4px">Sources disagree</div>
      ${lines.map(l => `<div style="font-size:12px;color:var(--c-muted);line-height:1.5">${l}</div>`).join('')}
    </div>`;
}
