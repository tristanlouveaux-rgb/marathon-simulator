/**
 * Per-lift estimated-1RM history. Append-only log powering the strength trend
 * chart, mirroring tri-benchmark-history.ts (FTP/CSS):
 *  - One entry per day, latest wins (launch/session refreshes don't pile up).
 *  - Skip the append when the value is unchanged from the most recent entry.
 *  - Bounded at MAX_HISTORY so a loop bug can't grow state unboundedly.
 *
 * Pure tracking. No calculation reads from these arrays.
 */

import type { StrengthLiftEntry } from '@/types/strength-log';

const MAX_HISTORY = 256;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Append (or replace today's entry on) a lift's est1RM history. Mutates `entry`.
 *  `reps` records the effort the best was set at (rep-aware display). */
export function appendEst1rmSample(entry: StrengthLiftEntry, value: number, reps?: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  const date = todayISO();
  const list = entry.est1rmHistory ? [...entry.est1rmHistory] : [];

  const last = list[list.length - 1];
  if (last && last.date === date) {
    list[list.length - 1] = { date, value, reps };
  } else if (last && last.value === value) {
    return;
  } else {
    list.push({ date, value, reps });
  }

  entry.est1rmHistory = list.slice(-MAX_HISTORY);
}
