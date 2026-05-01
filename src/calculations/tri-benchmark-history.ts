/**
 * Tri benchmark history — append-only logs of FTP and CSS samples that power
 * the trend charts on the tri Progress detail page (`progress-detail-view`).
 *
 * Rules:
 *  - One entry per day, latest wins (so launch-time refreshes don't pile up).
 *  - Skip the append when the value is unchanged from the most recent entry
 *    (avoids stale-source flips spamming the log).
 *  - Pure tracking — no calculation reads from these arrays.
 *
 * Bounded at 256 entries so a launch-loop bug can't grow state unboundedly.
 */

import type { BikeBenchmarks, SwimBenchmarks } from '@/types/triathlon';

const MAX_HISTORY = 256;

type FtpSample = NonNullable<BikeBenchmarks['ftpHistory']>[number];
type CssSample = NonNullable<SwimBenchmarks['cssHistory']>[number];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Append (or replace today's entry on) the FTP history. Mutates `bike`. */
export function appendFtpSample(
  bike: BikeBenchmarks,
  value: number,
  source: 'user' | 'derived',
  confidence?: 'high' | 'medium' | 'low' | 'none',
): void {
  if (!Number.isFinite(value) || value <= 0) return;
  const date = todayISO();
  const list: FtpSample[] = bike.ftpHistory ? [...bike.ftpHistory] : [];

  const last = list[list.length - 1];
  if (last && last.date === date) {
    // Replace today's entry — represents the latest read-out of FTP for the day.
    list[list.length - 1] = { date, value, source, confidence };
  } else if (last && last.value === value && last.source === source) {
    // Same value, different day, but no new test — skip to keep the chart sparse.
    return;
  } else {
    list.push({ date, value, source, confidence });
  }

  bike.ftpHistory = list.slice(-MAX_HISTORY);
}

/** Append (or replace today's entry on) the CSS history. Mutates `swim`. */
export function appendCssSample(
  swim: SwimBenchmarks,
  value: number,
  source: 'user' | 'derived',
  confidence?: 'high' | 'medium' | 'low' | 'none',
): void {
  if (!Number.isFinite(value) || value <= 0) return;
  const date = todayISO();
  const list: CssSample[] = swim.cssHistory ? [...swim.cssHistory] : [];

  const last = list[list.length - 1];
  if (last && last.date === date) {
    list[list.length - 1] = { date, value, source, confidence };
  } else if (last && last.value === value && last.source === source) {
    return;
  } else {
    list.push({ date, value, source, confidence });
  }

  swim.cssHistory = list.slice(-MAX_HISTORY);
}
