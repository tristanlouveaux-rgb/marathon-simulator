/**
 * Strength PR detector. Pure logic, mirroring tri-marker-bumps.ts. Compares
 * each lift's current estimated-1RM against the last-notified snapshot stored
 * on `strengthLog.notifiedPr` and returns the lifts that improved by at least
 * STRENGTH_PR_THRESHOLD_KG.
 *
 * **Side of the line**: tracking. Pure function; the caller (main.ts) owns the
 * toast call AND the snapshot mutation. Two-step so a render error can't swallow
 * a PR delta. Only improvements surface — a regression is silent.
 *
 * Higher est1RM is better for every lift.
 */

import type { SimulatorState } from '@/types/state';
import { STRENGTH_PR_THRESHOLD_KG } from '@/constants/strength-constants';

export interface StrengthPr {
  key: string;
  displayName: string;
  /** Previous est1RM — null on first observation. */
  from: number | null;
  to: number;
  improvement: number;
  /** Pre-formatted toast text. */
  toastText: string;
}

/** Round to one decimal for display ("112.5kg"). */
function fmtKg(kg: number): string {
  return `${Math.round(kg * 10) / 10}kg`;
}

/**
 * Compare each lift's current est1RM against `strengthLog.notifiedPr` and
 * return any that crossed the PR threshold upward. Pure function.
 */
export function detectStrengthPrs(state: SimulatorState): StrengthPr[] {
  const log = state.strengthLog;
  if (!log?.lifts) return [];

  const notified = log.notifiedPr ?? {};
  const prs: StrengthPr[] = [];

  for (const entry of Object.values(log.lifts)) {
    const now = entry.est1rmKg;
    if (now == null || !(now > 0)) continue;
    const prev = notified[entry.key] ?? null;
    if (prev != null && now - prev >= STRENGTH_PR_THRESHOLD_KG) {
      prs.push({
        key: entry.key,
        displayName: entry.displayName,
        from: prev,
        to: now,
        improvement: now - prev,
        toastText: `${entry.displayName} 1RM ${fmtKg(prev)} → ${fmtKg(now)}`,
      });
    }
  }

  return prs;
}

/**
 * After surfacing PRs, snapshot the current est1RM of every lift onto
 * `strengthLog.notifiedPr` so we don't re-pop next launch. Mutates state.
 * Caller must saveState(). Always called even when no PR fired, so first
 * observation writes a baseline silently.
 */
export function snapshotNotifiedStrengthPrs(state: SimulatorState): void {
  const log = state.strengthLog;
  if (!log?.lifts) return;
  const snap: Record<string, number> = {};
  for (const entry of Object.values(log.lifts)) {
    if (entry.est1rmKg != null && entry.est1rmKg > 0) snap[entry.key] = entry.est1rmKg;
  }
  log.notifiedPr = snap;
}
