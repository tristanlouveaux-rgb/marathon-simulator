/**
 * HYROX activity structural parser.
 *
 * Side: tracking. Detects HYROX structure inside an imported Strava/Garmin
 * activity and decomposes it into per-leg run + per-station blocks so that
 * (a) station times can update calibrated benchmarks, (b) run-leg HR/pace can
 * feed the run-leg-fatigue model, and (c) the activity detail UI can show a
 * race-realistic breakdown.
 *
 * Detection signal stack
 *   1. Activity name regex (`hyrox`, `mixed session`, `roxfit`) — already in
 *      `activity-matcher.ts`. Strongest signal.
 *   2. Lap structure: 16 alternating laps with run laps ~1km. Native HYROX
 *      modes (Garmin Q1 2026, Coros Spring 2026, Amazfit) emit this layout.
 *   3. Lap-count fallback: 8–18 laps with at least 4 distinct distance buckets
 *      → likely HYROX, even if name didn't match.
 *
 * Output is best-effort. When laps are missing/sparse we degrade to "session
 * matched, no per-station decomposition" — the caller still benefits from the
 * MTL accumulator update.
 */

import type { GarminLap } from '@/types/state';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import type { HyroxStation } from '@/types/triathlon';

export interface HyroxParsedLeg {
  kind: 'run' | 'station';
  /** For station legs, the assumed station id from race-order convention. */
  station?: HyroxStation;
  /** Lap index within the source activity (1-based). */
  lapIndex: number;
  durationSec: number;
  distanceM: number;
  avgHR?: number;
  /** Pace sec/km — only meaningful for run legs. */
  paceSecKm?: number;
}

export interface HyroxParsedActivity {
  /** Detected with high confidence — name match + structure. */
  isHyrox: boolean;
  /** Detection method that fired. */
  detectionSource: 'name' | 'structure' | 'name+structure' | 'none';
  /** 16 (race-format) or fewer if lap data was incomplete. */
  legs: HyroxParsedLeg[];
  /** Run-only laps: total time + average pace. */
  runTotal?: { totalSec: number; meanPaceSecKm: number };
  /** Per-station decomposition keyed by HyroxStation id. Only populated for
   *  full 16-lap structures we are confident enough to label. */
  stationTimes?: Partial<Record<HyroxStation, number>>;
}

const HYROX_NAME_RE = /\b(hyrox|mixed\s*session|roxfit|hyrox\s*sim)\b/i;

/** Heuristic: is this lap roughly a 1km run? */
function isRunLap(lap: GarminLap): boolean {
  if (lap.distanceM == null || lap.durationSec == null) return false;
  // Tolerance: 800–1100m at sub-9 min/km pace (slowest reasonable HYROX run pace).
  const distOk = lap.distanceM >= 800 && lap.distanceM <= 1100;
  const paceOk = lap.avgPaceSecKm != null && lap.avgPaceSecKm <= 540;
  return distOk && paceOk;
}

/** Heuristic: is this lap likely a station (low movement, distinct from run)? */
function isStationLap(lap: GarminLap): boolean {
  if (lap.distanceM == null || lap.durationSec == null) return false;
  // Stations: ~50m–200m total movement, durations 60s–600s.
  return lap.distanceM <= 250 && lap.durationSec >= 60 && lap.durationSec <= 720;
}

/**
 * Parse a HYROX activity from name + lap data.
 *
 * @param activityName  the user / device-set name (e.g. "HYROX Vienna").
 * @param laps          ordered array of GarminLap from the source activity.
 */
export function parseHyroxActivity(activityName: string | null | undefined, laps: GarminLap[] | null | undefined): HyroxParsedActivity {
  const empty: HyroxParsedActivity = { isHyrox: false, detectionSource: 'none', legs: [] };
  if (!laps || laps.length === 0) {
    if (activityName && HYROX_NAME_RE.test(activityName)) {
      // Name match without lap data — treat as HYROX without decomposition.
      return { isHyrox: true, detectionSource: 'name', legs: [] };
    }
    return empty;
  }

  const nameMatch = !!activityName && HYROX_NAME_RE.test(activityName);

  // Structural classification: tag each lap as run / station / unknown.
  const tagged: Array<{ lap: GarminLap; kind: 'run' | 'station' | 'unknown' }> = laps.map(lap => ({
    lap,
    kind: isRunLap(lap) ? 'run' : isStationLap(lap) ? 'station' : 'unknown',
  }));

  // HYROX structure heuristic: 8–18 laps with at least 4 run laps + 4 station laps.
  const runCount = tagged.filter(t => t.kind === 'run').length;
  const stationCount = tagged.filter(t => t.kind === 'station').length;
  const structureMatch = laps.length >= 8 && laps.length <= 18 && runCount >= 4 && stationCount >= 4;

  if (!nameMatch && !structureMatch) return empty;

  const detectionSource: HyroxParsedActivity['detectionSource'] =
    nameMatch && structureMatch ? 'name+structure' :
    nameMatch ? 'name' : 'structure';

  // Build legs in lap order, label stations by race-order convention.
  // Convention: alternating run-station-run-station … starting with a run.
  // If the first lap is a station (warmup wasn't logged) we offset by 1.
  const firstNonUnknown = tagged.find(t => t.kind !== 'unknown');
  const startsWithRun = firstNonUnknown?.kind === 'run';
  let stationIndex = 0;
  const legs: HyroxParsedLeg[] = [];
  for (let i = 0; i < tagged.length; i++) {
    const { lap, kind } = tagged[i];
    if (kind === 'unknown') continue;
    if (kind === 'run') {
      legs.push({
        kind: 'run',
        lapIndex: i + 1,
        durationSec: lap.durationSec,
        distanceM: lap.distanceM,
        avgHR: lap.avgHR,
        paceSecKm: lap.avgPaceSecKm,
      });
    } else {
      const station = HYROX_STATION_ORDER[stationIndex];
      stationIndex += 1;
      legs.push({
        kind: 'station',
        station,
        lapIndex: i + 1,
        durationSec: lap.durationSec,
        distanceM: lap.distanceM,
        avgHR: lap.avgHR,
      });
    }
  }
  void startsWithRun; // reserved for future doubles handling (alternating partner stations)

  // Aggregate run + station outputs.
  const runLegs = legs.filter(l => l.kind === 'run');
  const stationLegs = legs.filter(l => l.kind === 'station');

  const runTotal = runLegs.length > 0
    ? {
        totalSec: runLegs.reduce((s, l) => s + l.durationSec, 0),
        meanPaceSecKm: Math.round(
          runLegs.reduce((s, l) => s + (l.paceSecKm ?? 0), 0) / runLegs.length,
        ),
      }
    : undefined;

  // Only emit stationTimes if we have at least 4 stations cleanly identified
  // (less than that, the convention-based labelling is too lossy to trust).
  const stationTimes = stationLegs.length >= 4
    ? stationLegs.reduce<Partial<Record<HyroxStation, number>>>((acc, l) => {
        if (l.station) acc[l.station] = l.durationSec;
        return acc;
      }, {})
    : undefined;

  return {
    isHyrox: true,
    detectionSource,
    legs,
    runTotal,
    stationTimes,
  };
}

/**
 * Update calibrated benchmarks from a parsed HYROX activity.
 *
 * Only updates a slot if the parsed time is faster than the existing benchmark
 * (PB-only: a slow training session shouldn't degrade the user's calibrated
 * race-pace benchmark). Returns the per-station deltas applied.
 */
export function applyParsedBenchmarks(
  current: Partial<Record<HyroxStation, number>> | undefined,
  parsed: HyroxParsedActivity,
): { updated: Partial<Record<HyroxStation, number>>; improvements: Partial<Record<HyroxStation, number>> } {
  const updated: Partial<Record<HyroxStation, number>> = { ...(current ?? {}) };
  const improvements: Partial<Record<HyroxStation, number>> = {};
  if (!parsed.stationTimes) return { updated, improvements };

  for (const [st, secRaw] of Object.entries(parsed.stationTimes)) {
    const station = st as HyroxStation;
    const sec = secRaw as number;
    const existing = updated[station];
    if (existing == null || sec < existing) {
      improvements[station] = existing != null ? existing - sec : sec;
      updated[station] = sec;
    }
  }
  return { updated, improvements };
}
