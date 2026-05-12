/**
 * Running race-outcome logging — capture predicted vs actual after a target
 * marathon/half/10k/5k. Mirrors `tri-race-outcome.ts` for parity with the
 * CLAUDE.md mirror rule ("Race-outcome logging must be in both running and
 * triathlon").
 *
 * v1 contract:
 *   - LOG every race outcome (positive AND negative gap) so the data is there
 *     for future calibration.
 *   - SURFACE retrospectively only when the athlete beat the prediction.
 *     Asymmetric on purpose: positive surprise = celebrate; negative surprise
 *     = don't punish a bad day.
 *
 * Detection runs once per race on launch: if the race date is in the past AND
 * no log entry exists for that date, attempt to compute the actual from
 * race-day running activities and the predicted from the blended cache.
 *
 * **Side of the line**: tracking. Pure logic + a state-mutating wrapper.
 */

import type { SimulatorState, RunRaceLogEntry } from '@/types/state';
import type { RaceDistance } from '@/types/training';

const RUNNING_ACTIVITY_TYPES = new Set([
  'RUNNING',
  'TREADMILL_RUNNING',
  'TRAIL_RUNNING',
  'TRACK_RUNNING',
  'VIRTUAL_RUN',
]);

export interface RunRaceRetroDisplay {
  display: boolean;
  headline?: string;
  body?: string;
  entry?: RunRaceLogEntry;
}

/**
 * Decide whether to surface a retrospective race-outcome card. Returns
 * `display: true` only when the latest logged race beat the prediction by
 * a meaningful margin (≥ 60 s — same intuition as the tri threshold scaled
 * to single-discipline). Negative outcomes are stored but never surfaced.
 */
export function getRunRaceOutcomeRetro(state: SimulatorState): RunRaceRetroDisplay {
  const log = state.runRaceLog;
  if (!log || log.length === 0) return { display: false };
  const latest = log[log.length - 1];
  const gap = latest.predictedTotalSec - latest.actualTotalSec;
  if (gap < 60) return { display: false };

  const fmtTime = (sec: number): string => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.round(sec % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  };
  const fmtGap = (sec: number): string => {
    const m = Math.floor(sec / 60);
    return m === 1 ? `1 min` : `${m} min`;
  };

  return {
    display: true,
    headline: `You beat your prediction by ${fmtGap(gap)}`,
    body: `Predicted ${fmtTime(latest.predictedTotalSec)}, actual ${fmtTime(latest.actualTotalSec)}.`,
    entry: latest,
  };
}

/**
 * Append a race outcome to the log. Idempotent on `dateISO`. Caller must
 * `saveState()` after.
 */
export function appendRunRaceOutcome(state: SimulatorState, entry: RunRaceLogEntry): boolean {
  const log = state.runRaceLog ?? [];
  if (log.some(e => e.dateISO === entry.dateISO)) return false;
  state.runRaceLog = [...log, entry];
  return true;
}

/**
 * Detect and log a running race outcome. Run once per launch in running mode.
 *   1. Skip if no race date set, or race date in the future.
 *   2. Skip if `runRaceLog` already has an entry for this date.
 *   3. Find the longest running activity in the ±race-day window.
 *   4. Pull predicted from `state.blendedRaceTimeSec` cache.
 *   5. Append.
 *
 * Returns the appended entry, or null if nothing to log.
 */
export function detectAndLogRunRaceOutcome(state: SimulatorState): RunRaceLogEntry | null {
  // Only run in running mode. Tri/hyrox have their own detectors.
  if (state.eventType && state.eventType !== 'running') return null;

  const raceDate = state.selectedMarathon?.date || state.onboarding?.customRaceDate;
  if (!raceDate) return null;
  const raceTs = Date.parse(raceDate + 'T00:00:00Z');
  if (!Number.isFinite(raceTs)) return null;

  // Skip if race is still in the future (6h grace for time-zone slip).
  const nowTs = Date.now();
  if (raceTs + 6 * 3600 * 1000 > nowTs) return null;

  // Idempotent guard.
  const existing = (state.runRaceLog ?? []).find(e => e.dateISO === raceDate);
  if (existing) return null;

  // Window: 6h before midnight to 30h after — covers any single-day race
  // including ultra-marathon edge cases.
  const winStart = raceTs - 6 * 3600 * 1000;
  const winEnd = raceTs + 30 * 3600 * 1000;

  let bestRun: { durationSec: number; distanceKm: number } | null = null;
  for (const wk of state.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      if (!actual?.startTime) continue;
      const aTs = Date.parse(actual.startTime);
      if (!Number.isFinite(aTs) || aTs < winStart || aTs > winEnd) continue;
      const type = actual.activityType ?? '';
      if (!RUNNING_ACTIVITY_TYPES.has(type)) continue;
      const dur = actual.durationSec ?? 0;
      if (dur <= 0) continue;
      if (!bestRun || dur > bestRun.durationSec) {
        bestRun = { durationSec: dur, distanceKm: actual.distanceKm ?? 0 };
      }
    }
  }
  if (!bestRun) return null;

  const predictedTotalSec = state.blendedRaceTimeSec;
  if (!predictedTotalSec || predictedTotalSec <= 0) return null;

  const entry: RunRaceLogEntry = {
    dateISO: raceDate,
    distance: state.rd as RaceDistance,
    predictedTotalSec,
    actualTotalSec: bestRun.durationSec,
    actualDistanceKm: bestRun.distanceKm > 0 ? bestRun.distanceKm : undefined,
    predictionVdotSnapshot: state.v ?? undefined,
    raceName: state.selectedMarathon?.name,
  };

  if (!appendRunRaceOutcome(state, entry)) return null;
  return entry;
}
