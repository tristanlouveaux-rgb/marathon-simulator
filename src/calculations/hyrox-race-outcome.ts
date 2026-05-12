/**
 * HYROX race-outcome logging — capture actual race-day finish time.
 * Mirrors `tri-race-outcome.ts` and `run-race-outcome.ts` for cross-mode
 * parity per the CLAUDE.md mirror rule.
 *
 * HYROX-specific notes:
 *   - The "predicted" slot is the user's manually-set `targetFinishTimeSec`
 *     because HYROX does not continuously cache a live race prediction the
 *     way triathlon does. If no target is set, the entry still logs (actual
 *     only) so we have the data point for future retrospective surfaces.
 *   - Race-day activities are identified by start time falling inside the
 *     ±race-day window; we sum durations of all activities in that window
 *     because a HYROX session is typically a single bracketed activity.
 *
 * **Side of the line**: tracking.
 */

import type { SimulatorState } from '@/types/state';
import type { HyroxRaceLogEntry } from '@/types/triathlon';

/**
 * Append a race outcome to the log. Idempotent on `dateISO`. Caller must
 * `saveState()` after.
 */
export function appendHyroxRaceOutcome(state: SimulatorState, entry: HyroxRaceLogEntry): boolean {
  if (!state.hyroxConfig) return false;
  const log = state.hyroxConfig.raceLog ?? [];
  if (log.some(e => e.dateISO === entry.dateISO)) return false;
  state.hyroxConfig.raceLog = [...log, entry];
  return true;
}

/**
 * Detect and log a HYROX race outcome. Run once per launch in HYROX mode.
 *   1. Skip if no race date set, or race date in the future.
 *   2. Skip if `raceLog` already has an entry for this date.
 *   3. Sum activity durations in the race-day window.
 *   4. Log target (if set) as "predicted".
 *
 * Returns the appended entry, or null if nothing to log.
 */
export function detectAndLogHyroxRaceOutcome(state: SimulatorState): HyroxRaceLogEntry | null {
  if (state.eventType !== 'hyrox') return null;
  const hx = state.hyroxConfig;
  if (!hx?.raceDate) return null;

  const raceTs = Date.parse(hx.raceDate + 'T00:00:00Z');
  if (!Number.isFinite(raceTs)) return null;

  const nowTs = Date.now();
  if (raceTs + 6 * 3600 * 1000 > nowTs) return null;

  // Idempotent guard.
  const existing = (hx.raceLog ?? []).find(e => e.dateISO === hx.raceDate);
  if (existing) return null;

  // Window: 6h before midnight to 12h after — HYROX races are bounded.
  const winStart = raceTs - 6 * 3600 * 1000;
  const winEnd = raceTs + 12 * 3600 * 1000;

  let actualTotalSec = 0;
  for (const wk of state.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      if (!actual?.startTime) continue;
      const aTs = Date.parse(actual.startTime);
      if (!Number.isFinite(aTs) || aTs < winStart || aTs > winEnd) continue;
      actualTotalSec += actual.durationSec ?? 0;
    }
  }
  if (actualTotalSec === 0) return null;

  const entry: HyroxRaceLogEntry = {
    dateISO: hx.raceDate,
    format: hx.format,
    targetTotalSec: hx.targetFinishTimeSec,
    actualTotalSec,
    raceEventId: hx.raceEventId,
  };

  if (!appendHyroxRaceOutcome(state, entry)) return null;
  return entry;
}
