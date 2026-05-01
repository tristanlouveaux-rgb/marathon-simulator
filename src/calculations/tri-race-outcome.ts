/**
 * Race-outcome logging — pull predicted vs actual after a target race day.
 *
 * v1 contract:
 *   - LOG every race outcome (positive AND negative gap) so the data is there
 *     for v2 calibration.
 *   - SURFACE retrospectively only when the athlete beat their prediction
 *     by ≥ TRI_RACE_OUTCOME_POSITIVE_THRESHOLD_SEC. The asymmetry is
 *     deliberate user-trust: positive surprise = celebrate the plan;
 *     negative surprise = don't punish a bad day.
 *
 * Detection runs once per race: on launch, if `triConfig.raceDate` is in
 * the past AND the most recent log entry's date doesn't match, attempt to
 * compute actuals from race-day activities.
 *
 * **Side of the line**: tracking. Pure logic + a state-mutating wrapper.
 */

import type { SimulatorState } from '@/types/state';
import type { TriRaceLogEntry } from '@/types/triathlon';
import { classifyActivity } from './tri-benchmarks-from-history';
import { TRI_RACE_OUTCOME_POSITIVE_THRESHOLD_SEC } from '@/constants/triathlon-constants';

export interface RetroDisplay {
  display: boolean;
  /** When `display === true`, headline copy ready to render. */
  headline?: string;
  body?: string;
  entry?: TriRaceLogEntry;
}

/**
 * Decide whether to render a retrospective race-outcome card on the stats
 * page. Reads from the LATEST entry in `triConfig.raceLog`. Returns
 * `display: false` unless the latest entry shows the athlete beat the
 * prediction by ≥ threshold.
 */
export function getRaceOutcomeRetro(state: SimulatorState): RetroDisplay {
  const log = state.triConfig?.raceLog;
  if (!log || log.length === 0) return { display: false };
  const latest = log[log.length - 1];
  const gap = latest.predictedTotalSec - latest.actualTotalSec;  // positive = beat prediction
  if (gap < TRI_RACE_OUTCOME_POSITIVE_THRESHOLD_SEC) return { display: false };

  const fmtTime = (sec: number): string => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.round(sec % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
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
 * Append a race outcome to the log. Pure mutation — caller must `saveState()`.
 *
 * Idempotent guard: if a log entry already exists for the same `dateISO` we
 * don't append a duplicate.
 */
export function appendRaceOutcome(state: SimulatorState, entry: TriRaceLogEntry): boolean {
  if (!state.triConfig) return false;
  const log = state.triConfig.raceLog ?? [];
  if (log.some(e => e.dateISO === entry.dateISO)) return false;
  state.triConfig.raceLog = [...log, entry];
  return true;
}

/**
 * Detect and log a race outcome. Run once per launch in tri mode.
 *   1. Skip if no `triConfig.raceDate` set, or race date in the future.
 *   2. Skip if `raceLog` already has an entry for this race date.
 *   3. Sum swim + bike + run actual durations from the race-day activities
 *      (within ±6 hours of midnight on the race date — IM range).
 *   4. Pull predicted from the cached `triConfig.prediction`.
 *   5. Append to `raceLog`.
 *
 * Returns the appended entry, or null if nothing to log.
 */
export function detectAndLogRaceOutcome(state: SimulatorState): TriRaceLogEntry | null {
  const tri = state.triConfig;
  if (!tri?.raceDate) return null;
  const raceDate = tri.raceDate;  // YYYY-MM-DD
  const raceTs = Date.parse(raceDate + 'T00:00:00Z');
  if (!Number.isFinite(raceTs)) return null;

  // Skip if race is still in the future (with 6h grace for time-zone slip).
  const nowTs = Date.now();
  if (raceTs + 6 * 3600 * 1000 > nowTs) return null;

  // Idempotent: skip if a log entry already exists for this date.
  const existing = (tri.raceLog ?? []).find(e => e.dateISO === raceDate);
  if (existing) return null;

  // Sum activities within race-day window across all weeks.
  const wks = state.wks ?? [];
  const winStart = raceTs - 6 * 3600 * 1000;
  const winEnd = raceTs + 30 * 3600 * 1000;  // up to 30h post-midnight covers IM finishers
  const actualPerLeg = { swim: 0, bike: 0, run: 0 };
  for (const wk of wks) {
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      if (!actual?.startTime) continue;
      const aTs = Date.parse(actual.startTime);
      if (!Number.isFinite(aTs)) continue;
      if (aTs < winStart || aTs > winEnd) continue;
      const sport = classifyActivity(actual.activityType);
      if (sport !== 'swim' && sport !== 'bike' && sport !== 'run') continue;
      actualPerLeg[sport] += actual.durationSec ?? 0;
    }
  }
  const actualTotalSec = actualPerLeg.swim + actualPerLeg.bike + actualPerLeg.run;
  if (actualTotalSec === 0) return null;  // no race-day activities found

  // Pull predicted from cache. If absent, no log entry — we don't fabricate.
  const pred = tri.prediction;
  if (!pred) return null;

  const entry: TriRaceLogEntry = {
    dateISO: raceDate,
    distance: tri.distance,
    predictedTotalSec: pred.totalSec,
    predictedPerLeg: {
      swim: pred.swimSec,
      bike: pred.bikeSec,
      run:  pred.runSec,
    },
    actualTotalSec,
    actualPerLeg,
    predictedAtISO: pred.computedAtISO,
    raceId: state.onboarding?.selectedTriathlonId ?? undefined,
  };

  if (!appendRaceOutcome(state, entry)) return null;
  return entry;
}
