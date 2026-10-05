/**
 * In-app completions as activity records (audit B9).
 *
 * TRACKING side. These helpers describe what the user did when the only record
 * of a session is the app itself: an in-app GPS recording, or a tap on Mark as
 * Done. Before this module both wrote `wk.rated` only (plus, for an impromptu
 * GPS run, an adhoc `{ d: 'X.Xkm', r: 5 }` with no duration), so the session
 * scored 0 in Signal A, a flat 30-minute default in weekly Signal B, and 0 in
 * the daily strain and rolling ACWR.
 *
 * The record is an ordinary `GarminActual` with a `guided-` garminId, the same
 * convention strength-complete.ts already uses for an in-app strength session.
 * Every load surface (computeWeekTSS, computeWeekRawTSS, computeTodaySignalBTSS
 * and everything built on them) already reads garminActuals once per garminId,
 * so writing the actual is enough for the session to count exactly once.
 *
 * Valuation stays in fitness-model: an actual with no iTRIMP is valued at
 * `durationMin × TL_PER_MIN[wk.rated]`, the same rule as a synced run with no
 * heart rate. Nothing here computes a TSS.
 *
 * Two shapes:
 *   - GPS run: the recording's own start, elapsed time and distance (measured).
 *   - Manual completion (Mark as Done): the session's planned duration and
 *     distance at its rated RPE, stamped on the planned day. Mirrors how
 *     triathlon manual-done deposits planned load (manualDoneTriActivities).
 *
 * Both leave `activityType` null. The load model still reads them as runs
 * (resolveActualSport: no activityType + a plan-slot workoutName = running; an
 * impromptu GPS run's display label, e.g. "Quick Run", derives a run the way a
 * synced extra's label does), but every fitness-inference reader that filters
 * on `activityType` containing RUN (race prediction inputs, durability, VO2,
 * race outcome) skips them, so planned numbers never feed back into the
 * forecast as if they were measured.
 *
 * Superseding: when the watch recorded the same session and it syncs later
 * (Strava, Apple Health or the Garmin webhook), the synced copy replaces the
 * in-app record in place. Two windows decide "same session", both taken from
 * existing code rather than invented here:
 *   - recorded window (reconcileCrossSourceDuplicates): start within 4 h and
 *     duration within 15 %, or start within 10 min when a duration is missing.
 *   - completion window (the guided-strength upgrade in matchAndAutoComplete):
 *     start within 36 h and duration ratio 0.5 to 2.0. Used only for manual
 *     completions, whose start is the planned day, not a recorded start.
 *
 * A manual completion stamped on the synced run's own calendar day is checked
 * BEFORE any planned slot can claim the run ('same-day-completion'): the user
 * already said that session happened that day, so an unrated slot on a
 * neighbouring day (the HYROX run branch accepts day ±1) must not take the
 * watch copy and count the session twice. Cross-day completions are checked
 * only after slot matching ('completion'), and only for a past week: in the
 * current week the synced run goes to Activity Review, which offers the
 * in-app slot, so the user decides whether it is the same session.
 *
 * Sport: a synced activity of a different sport never supersedes, overwrites
 * or drops an in-app record. The windows above are timing rules only, so every
 * check that applies them to an in-app record also requires the same sport
 * family (isSameSportAsInApp): the matcher's run-only supersede, the Strava
 * upgrade loop and the cross-source reconcile passes.
 */

import type { GarminActual, GpsRecording, Week, Workout } from '@/types';
import { parseDistanceKm } from '@/calculations/matching';
import {
  isStrengthActual, isGymSessionActual, resolveActualSport, isRunSport,
} from '@/cross-training/activities';
import { localDateKey } from '@/utils/local-date';

/** garminId prefix of every in-app record (strength-complete.ts convention). */
export const IN_APP_GARMIN_ID_PREFIX = 'guided-';
/** In-app GPS recording ids are `gps_<ts>` (gps-events.ts), so their actual is `guided-gps_<ts>`. */
const GPS_GARMIN_ID_PREFIX = `${IN_APP_GARMIN_ID_PREFIX}gps_`;
/** Manual completions (Mark as Done) carry `guided-manual-<ts>`. */
const MANUAL_GARMIN_ID_PREFIX = `${IN_APP_GARMIN_ID_PREFIX}manual-`;

// ── Same-session windows (single source; activity-matcher imports these) ─────

const HOUR_MS = 3600 * 1000;
/** reconcileCrossSourceDuplicates: two recordings more than 4 h apart are different sessions. */
const RECORDED_MAX_START_GAP_MS = 4 * HOUR_MS;
/** reconcileCrossSourceDuplicates: same session when durations differ by under 15 %. */
const RECORDED_MAX_DURATION_DIFF = 0.15;
/** reconcileCrossSourceDuplicates: fallback when a duration is missing. */
const RECORDED_NO_DURATION_MAX_GAP_MS = 10 * 60 * 1000;
/** Guided-strength upgrade: "same session ≈ same day: keep a generous ±36h window". */
const COMPLETION_MAX_START_GAP_MS = 36 * HOUR_MS;
/** Guided-strength upgrade: synced duration within 50–200 % of the in-app entry's. */
const COMPLETION_DURATION_RATIO_MIN = 0.5;
const COMPLETION_DURATION_RATIO_MAX = 2.0;

type Stamp = { startTime?: string | null; durationSec?: number | null };

/**
 * Two RECORDINGS of one session (each start is a real recorded start). The rule
 * reconcileCrossSourceDuplicates has always applied across Strava, Apple and
 * Garmin copies; moved here so the in-app supersede uses the identical window.
 */
export function isSameRecordedSession(a: Stamp, b: Stamp): boolean {
  if (!a.startTime || !b.startTime) return false;
  const timeDiff = Math.abs(new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  if (timeDiff > RECORDED_MAX_START_GAP_MS) return false;
  const aDur = a.durationSec ?? 0;
  const bDur = b.durationSec ?? 0;
  if (aDur > 0 && bDur > 0) {
    return Math.abs(aDur - bDur) / Math.max(aDur, bDur) < RECORDED_MAX_DURATION_DIFF;
  }
  return timeDiff < RECORDED_NO_DURATION_MAX_GAP_MS;
}

/**
 * A synced recording vs an IN-APP COMPLETION whose start is a tap time or the
 * planned day rather than a recorded start. The guided-strength upgrade's
 * window: start within 36 h (skipped when the entry has no start) and the
 * synced duration within 0.5–2.0× the entry's. `entryFallbackMin` is the
 * entry duration to assume when it has none (the strength path's 30 min).
 */
export function isSameCompletedSession(
  entry: Stamp,
  synced: { startTime: string; durationSec: number },
  entryFallbackMin?: number,
): boolean {
  if (entry.startTime) {
    const gap = Math.abs(new Date(synced.startTime).getTime() - new Date(entry.startTime).getTime());
    if (gap > COMPLETION_MAX_START_GAP_MS) return false;
  }
  const entryMin = (entry.durationSec ?? 0) > 0 ? (entry.durationSec as number) / 60 : entryFallbackMin;
  if (entryMin == null || entryMin <= 0) return false;
  const ratio = (synced.durationSec / 60) / entryMin;
  return !(ratio < COMPLETION_DURATION_RATIO_MIN || ratio > COMPLETION_DURATION_RATIO_MAX);
}

// ── Classification ────────────────────────────────────────────────────────────

/** True for any record written by the app itself (guided strength/HYROX, GPS, Mark as Done). */
export function isInAppActual(a: { garminId?: string | null } | null | undefined): boolean {
  return !!a?.garminId && a.garminId.startsWith(IN_APP_GARMIN_ID_PREFIX);
}

/** True for an in-app GPS recording's actual. */
export function isGpsInAppActual(a: { garminId?: string | null } | null | undefined): boolean {
  return !!a?.garminId && a.garminId.startsWith(GPS_GARMIN_ID_PREFIX);
}

/** True for a Mark as Done record: planned numbers, nothing measured. */
export function isManualInAppActual(a: { garminId?: string | null } | null | undefined): boolean {
  return !!a?.garminId && a.garminId.startsWith(MANUAL_GARMIN_ID_PREFIX);
}

/**
 * True for an in-app RUN record (GPS run or a run marked done), the entries a
 * synced run may supersede. Strength and HYROX in-app sessions carry their own
 * activityType and have their own upgrade paths in the matcher.
 */
export function isInAppRunActual(a: GarminActual | null | undefined): boolean {
  if (!a || !isInAppActual(a)) return false;
  if (isStrengthActual(a)) return false;
  const t = (a.activityType ?? '').toUpperCase();
  return t === '' || t.includes('RUN');
}

type SportFamily = 'run' | 'gym' | 'other';

/**
 * Sport family of an in-app record. A GPS run or a run marked done is 'run'.
 * A guided or quick-done strength session (STRENGTH_TRAINING) or HYROX session
 * ('hyrox') is 'gym': the matcher's gym bucket (mapGarminType sends
 * STRENGTH_TRAINING and HIIT there), where the guided-strength upgrade and the
 * HYROX station upgrade (HIIT rows) look for the watch copy.
 */
function inAppSportFamily(a: GarminActual): SportFamily {
  if (isInAppRunActual(a)) return 'run';
  if (isGymSessionActual(a) || (a.activityType ?? '').toLowerCase() === 'hyrox') return 'gym';
  return 'other';
}

/**
 * Sport family of a synced activity, from resolveActualSport (the resolver
 * Signal A uses to answer "what sport was this?"). Strength and HIIT both
 * resolve to strength there, matching the matcher's gym bucket.
 */
function syncedSportFamily(
  key: string,
  a: { activityType?: string | null; manualSport?: string; workoutName?: string; displayName?: string },
): SportFamily {
  const sport = resolveActualSport(key, a);
  if (isRunSport(sport)) return 'run';
  if (sport === 'strength') return 'gym';
  return 'other';
}

/**
 * True when a synced activity (stored at `syncedKey`, or a row keyed as the
 * adhoc it would become) is the same sport family as an in-app record, so a
 * timing match between them can mean the same session. The same-session
 * windows are timing rules only: without this check a same-day ride or walk
 * of similar length replaced or deleted a run marked done, and a same-day run
 * replaced a HYROX quick done.
 */
export function isSameSportAsInApp(
  inApp: GarminActual,
  syncedKey: string,
  synced: { activityType?: string | null; manualSport?: string; workoutName?: string; displayName?: string },
): boolean {
  const family = inAppSportFamily(inApp);
  return family !== 'other' && family === syncedSportFamily(syncedKey, synced);
}

// ── Builders ─────────────────────────────────────────────────────────────────

/**
 * Recorded start of a GPS run: the first accepted fix, else stop time minus
 * elapsed time (`date` is written at stop, gps-events.ts:stopTracking).
 */
export function gpsRecordingStartIso(rec: Pick<GpsRecording, 'route' | 'date' | 'totalElapsed'>): string {
  const first = rec.route?.[0]?.timestamp;
  if (typeof first === 'number' && Number.isFinite(first) && first > 0) return new Date(first).toISOString();
  const stopMs = Date.parse(rec.date);
  const base = Number.isFinite(stopMs) ? stopMs : Date.now();
  return new Date(base - Math.max(0, rec.totalElapsed || 0) * 1000).toISOString();
}

/**
 * Actual for an in-app GPS run. Distance and elapsed time are measured by the
 * recorder. The recorder captures no heart rate, so iTRIMP stays null and the
 * load model values the run at its rated RPE.
 *
 * `slot` is the planned workout the run completed. Leave it out for a run
 * recorded outside the plan: like a synced extra run it then carries only a
 * display name, so plan adherence does not count it as a planned completion
 * (computePlanAdherence: "ad-hoc entries have none of these") and its sport
 * comes from that label (resolveActualSport), as for any synced extra.
 */
export function buildGpsRunActual(
  rec: GpsRecording,
  opts: { rpe: number; name: string; slot?: { workoutName: string; plannedType?: string | null } },
): GarminActual {
  const distanceKm = Math.max(0, rec.totalDistance || 0) / 1000;
  return {
    garminId: `${IN_APP_GARMIN_ID_PREFIX}${rec.id}`,
    startTime: gpsRecordingStartIso(rec),
    distanceKm,
    durationSec: Math.max(0, Math.round(rec.totalElapsed || 0)),
    avgPaceSecKm: rec.averagePace > 0 ? Math.round(rec.averagePace) : null,
    avgHR: null,
    maxHR: null,
    calories: null,
    iTrimp: null,
    hrZones: null,
    activityType: null,
    plannedType: opts.slot?.plannedType ?? null,
    rpe: opts.rpe,
    ...(opts.slot ? { workoutName: opts.slot.workoutName } : {}),
    displayName: opts.slot?.workoutName ?? opts.name,
  };
}

/**
 * Start stamp for a manual completion: the session's planned day at local noon
 * (the same noon anchor plan-view and computeTodaySignalBTSS use for day
 * arithmetic), never later than now. Batch-ticking Tuesday's run on Thursday
 * keeps its load on Tuesday; ticking a session planned for later in the week
 * stamps it now, the latest moment it can have happened.
 *
 * `planStartDate` is parsed as local midnight by components, as plan-view's
 * weekStartDate does. `dayOfWeek` is 0 = Monday, the Workout convention.
 */
export function manualCompletionStartIso(
  planStartDate: string | null | undefined,
  weekNum: number,
  dayOfWeek: number | null | undefined,
  nowMs: number = Date.now(),
): string {
  const parts = (planStartDate ?? '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n)) || dayOfWeek == null || !(weekNum >= 1)) {
    return new Date(nowMs).toISOString();
  }
  const [y, m, d] = parts;
  const planned = new Date(y, m - 1, d, 12, 0, 0, 0);
  planned.setDate(planned.getDate() + (weekNum - 1) * 7 + dayOfWeek);
  const ms = planned.getTime();
  return new Date(Number.isFinite(ms) ? Math.min(ms, nowMs) : nowMs).toISOString();
}

/**
 * Actual for a session marked done with no recording: its planned duration
 * and planned distance at its rated RPE. `durationMin` comes from the caller's
 * canonical planned-duration source (estimateWorkoutDurMin for the running
 * plan, the session's estimatedDurationMin for HYROX), so the record carries
 * the same dose the plan card prices.
 */
export function buildPlannedRunActual(
  w: Pick<Workout, 'n' | 't' | 'd'>,
  opts: { rpe: number; startTime: string; durationMin: number; nowMs?: number },
): GarminActual {
  const distanceKm = parseDistanceKm(w.d || '');
  return {
    garminId: `${MANUAL_GARMIN_ID_PREFIX}${opts.nowMs ?? Date.now()}`,
    startTime: opts.startTime,
    distanceKm: distanceKm > 0 ? distanceKm : 0,
    durationSec: Math.max(0, Math.round(opts.durationMin * 60)),
    avgPaceSecKm: null,
    avgHR: null,
    maxHR: null,
    calories: null,
    iTrimp: null,
    hrZones: null,
    activityType: null,
    plannedType: w.t ?? null,
    rpe: opts.rpe,
    workoutName: w.n,
    displayName: w.n,
  };
}

// ── Week mutations ───────────────────────────────────────────────────────────

/**
 * Store an in-app record at `key`. A synced actual already there is richer and
 * is the same session (Strava canonical), so it is kept and the in-app record
 * dropped. Returns whichever actual now sits at the key.
 */
export function writeInAppActual(wk: Week, key: string, actual: GarminActual): GarminActual {
  if (!wk.garminActuals) wk.garminActuals = {};
  const existing = wk.garminActuals[key];
  if (existing && !isInAppActual(existing)) return existing;
  wk.garminActuals[key] = actual;
  return actual;
}

/**
 * Plan-card types that are not runs: the list plan-view's week effort score has
 * always skipped (events.ts and week-debrief.ts carry the same list). Covers
 * the injury plan's `cross_training` replacement ("Cross-Train: <sport>"), its
 * `strength` rehab session and its `capacity_test`, which the narrower
 * gym / cross / rest check used to treat as runs.
 */
export const PLAN_CARD_NON_RUN_TYPES: readonly string[] = ['cross', 'cross_training', 'strength', 'rest', 'capacity_test', 'gym'];

/** True when a plan card of this workout type is a run. */
export function isPlanCardRunType(type: string | null | undefined): boolean {
  return !!type && !PLAN_CARD_NON_RUN_TYPES.includes(type);
}

/**
 * Mark as Done on a running-plan card: store the run's planned load as its
 * activity record, or return null and write nothing.
 *
 * Writes nothing when:
 *   - the card is not a run (cross, injury cross-training, strength, capacity
 *     test, gym, rest). An in-app record with no activityType reads as a run
 *     in the load model, so a cross card would put bike or swim minutes into
 *     the running-specific Signal A. Those cards keep the rating only.
 *   - the slot is not rated (rate() refused it).
 *   - the card sits in a future week. A record there would be stamped now but
 *     stored in a week the matcher does not search for today's watch copy, so
 *     the session could count twice. The rating alone records the tick, as
 *     before audit B9.
 *
 * `durationMin` is the caller's canonical planned duration (plan-view passes
 * estimateWorkoutDurMin with the card's base pace).
 */
export function recordPlannedRunDone(
  wk: Week,
  key: string,
  w: Pick<Workout, 'n' | 't' | 'd' | 'dayOfWeek'>,
  opts: {
    rpe: number;
    durationMin: number;
    planStartDate: string | null | undefined;
    weekNum: number;
    currentWeek: number;
    nowMs?: number;
  },
): GarminActual | null {
  if (!isPlanCardRunType(w.t)) return null;
  if (opts.weekNum > opts.currentWeek) return null;
  if (typeof wk.rated?.[key] !== 'number') return null;
  if (!(opts.durationMin > 0)) return null;
  return writeInAppActual(wk, key, buildPlannedRunActual(w, {
    rpe: opts.rpe,
    startTime: manualCompletionStartIso(opts.planStartDate, opts.weekNum, w.dayOfWeek, opts.nowMs),
    durationMin: opts.durationMin,
    nowMs: opts.nowMs,
  }));
}

/** Remove the in-app record at `key`, if that is what sits there. Synced actuals are untouched. */
export function dropInAppActual(wk: Week | undefined, key: string): boolean {
  const a = wk?.garminActuals?.[key];
  if (!wk || !a || !isInAppActual(a)) return false;
  delete wk.garminActuals![key];
  return true;
}

/**
 * The in-app run record in `wk` that a synced run recording supersedes, or null.
 *
 *   - 'recorded': any in-app run (GPS or manual) inside the recorded window.
 *   - 'same-day-completion': manual completions stamped on the synced run's
 *     local calendar day, inside the completion window. The matcher checks
 *     this before any planned slot may claim the run.
 *   - 'completion': manual completions inside the completion window, any day.
 *     The matcher checks this only when no planned slot claimed the run, and
 *     only in a past week (the current week goes to Activity Review).
 *
 * GPS records never match the completion modes: their start is a real
 * recorded start, so a synced run outside the recorded window is a different
 * session. When several qualify, the nearest start wins.
 */
export function findInAppRunToSupersede(
  wk: Week,
  synced: { startTime: string; durationSec: number },
  mode: 'recorded' | 'same-day-completion' | 'completion',
): string | null {
  const syncedMs = new Date(synced.startTime).getTime();
  const syncedDay = mode === 'same-day-completion' ? localDateKey(synced.startTime) : '';
  let bestKey: string | null = null;
  let bestGap = Infinity;
  for (const [key, a] of Object.entries(wk.garminActuals ?? {})) {
    if (!isInAppRunActual(a)) continue;
    if (mode !== 'recorded' && !isManualInAppActual(a)) continue;
    if (mode === 'same-day-completion' && (!a.startTime || !syncedDay || localDateKey(a.startTime) !== syncedDay)) continue;
    const same = mode === 'recorded'
      ? isSameRecordedSession(a, synced)
      : isSameCompletedSession(a, synced);
    if (!same) continue;
    const gap = a.startTime ? Math.abs(syncedMs - new Date(a.startTime).getTime()) : Infinity;
    if (bestKey == null || gap < bestGap) { bestKey = key; bestGap = gap; }
  }
  return bestKey;
}
