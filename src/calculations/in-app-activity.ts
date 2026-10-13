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
 * forecast as if they were measured. A bike, swim or row erg marked done
 * (triathlon, cycling, Just-Track, HYROX cross sessions) also leaves
 * activityType null and carries its sport as a `manualSport` tag instead
 * (buildPlannedSessionActual), so it is weighted at its own sport's runSpec and
 * never read as a run.
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
 * Plan weeks: the matcher files a synced row by its local calendar day
 * (weekIndexForDate, decision 2026-10-06), while an in-app GPS run sits in
 * s.wks[s.w - 1] and a Mark as Done record in its card's week. A session done
 * on another day than planned across a week boundary, or any session while s.w
 * is held back by the debrief gate, puts the two copies in different weeks.
 * The recorded and same-day checks are bounded in time (start within 4 h, or
 * the same local calendar day), so the matcher runs them over every plan week
 * (findInAppRunToSupersedeAcrossWeeks; findInAppGymSessionAcrossWeeks for the
 * HYROX station and guided-strength upgrades) and supersedes the record in the
 * week that holds it. The cross-day 'completion' check stays in the row's own
 * week.
 *
 * Sport: a synced activity of a different sport never supersedes, overwrites
 * or drops an in-app record. The windows above are timing rules only, so each
 * check that applies them to an in-app record carries a sport gate:
 *   - the matcher's run supersede runs for run rows only (mapGarminType(...)
 *     === 'run') and matches in-app RUN records only (isInAppRunActual); its
 *     ride and swim supersede runs for 'ride' / 'swim' rows only and matches
 *     a bike or swim marked done of that family only
 *     (findInAppSessionToSupersedeAcrossWeeks);
 *   - the guided-strength and HYROX station upgrades keep their own gates:
 *     the guided-strength upgrade takes gym-bucket rows (mapGarminType 'gym')
 *     onto a strength in-app record (isStrengthActual), and the HYROX station
 *     upgrade takes HIIT rows or a HYROX-named row onto an in-app HYROX record
 *     (isInAppHyroxSession). Both search every plan week with the bounded
 *     windows first (findInAppGymSessionAcrossWeeks), then their own wider
 *     same-week rules;
 *   - the Strava upgrade loop and the cross-source reconcile passes use
 *     isSameSportAsInApp.
 *
 * Plan slots: a manual-completion record (`guided-manual-`: a run-card Mark as
 * Done or a HYROX session quick done) is stamped at planned-day noon, so a
 * timing collision with an activity that fills ANOTHER plan slot is no evidence
 * of one session. The reconcile drops it only for a synced extra
 * (isExtraActivityKey), never for another slot's activity.
 */

import type { GarminActual, GpsRecording, SportKey, Week, Workout } from '@/types';
import { parseDistanceKm, isErgActivityType } from '@/calculations/matching';
import {
  isStrengthActual, isGymSessionActual, resolveActualSport, isRunSport,
  deriveSportFromActivityType, deriveSportFromLabel, isInAppHyroxSession,
} from '@/cross-training/activities';
import { localDateKey } from '@/utils/local-date';
import { isPlannedAdhocId } from '@/workouts/planned-adhoc';
import { isHyroxEasyErg } from '@/workouts/hyrox-easy-erg';
import { collectActivityAliases, scrubExcessRecords } from '@/calculations/excess-records';

/** garminId prefix of every in-app record (strength-complete.ts convention). */
export const IN_APP_GARMIN_ID_PREFIX = 'guided-';
/** In-app GPS recording ids are `gps_<ts>` (gps-events.ts), so their actual is `guided-gps_<ts>`. */
const GPS_GARMIN_ID_PREFIX = `${IN_APP_GARMIN_ID_PREFIX}gps_`;
/**
 * Manual completions carry `guided-manual-<ts>`: a run-card Mark as Done and a
 * HYROX session quick done (strength-complete.ts logQuickHyroxActivity). Both
 * hold planned numbers stamped at planned-day noon, nothing measured.
 */
const MANUAL_GARMIN_ID_PREFIX = `${IN_APP_GARMIN_ID_PREFIX}manual-`;

/** garminId for a new manual-completion record. */
export function manualInAppGarminId(nowMs: number = Date.now()): string {
  return `${MANUAL_GARMIN_ID_PREFIX}${nowMs}`;
}

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

/**
 * True for a manual-completion record (run-card Mark as Done, HYROX session
 * quick done): planned numbers stamped at planned-day noon, nothing measured.
 */
export function isManualInAppActual(a: { garminId?: string | null } | null | undefined): boolean {
  return !!a?.garminId && a.garminId.startsWith(MANUAL_GARMIN_ID_PREFIX);
}

/**
 * True for an in-app RUN record (GPS run or a run marked done), the entries a
 * synced run may supersede. Strength and HYROX in-app sessions carry their own
 * activityType and have their own upgrade paths in the matcher. A bike or swim
 * marked done (triathlon, cycling, Just-Track) carries no activityType either,
 * so its `manualSport` tag is what keeps it out of the run family.
 */
export function isInAppRunActual(a: GarminActual | null | undefined): boolean {
  if (!a || !isInAppActual(a)) return false;
  if (isStrengthActual(a)) return false;
  if (a.manualSport && !isRunSport(a.manualSport)) return false;
  const t = (a.activityType ?? '').toUpperCase();
  return t === '' || t.includes('RUN');
}

type SportFamily = 'run' | 'gym' | 'bike' | 'swim' | 'row' | 'other';

/**
 * Sport families a synced recording can supersede an in-app record within, by
 * the matcher's supersede windows (findInAppSessionToSupersedeAcrossWeeks):
 * runs (GPS or marked done) and bikes, swims or rows marked done.
 */
export type EnduranceFamily = 'run' | 'bike' | 'swim' | 'row';

/** Family of a SportKey: the run, gym, bike, swim and row buckets the supersede rules compare. */
function familyOfSport(sport: SportKey): SportFamily {
  if (isRunSport(sport)) return 'run';
  if (sport === 'strength') return 'gym';
  if (sport === 'cycling') return 'bike';
  if (sport === 'swimming') return 'swim';
  if (sport === 'rowing') return 'row';
  return 'other';
}

/**
 * The non-run endurance family a SYNCED row of this activity type supersedes a
 * session marked done within, or null: rides, swims and rows, by the canonical
 * activityType → sport rule (deriveSportFromActivityType). The matcher's run
 * supersede handles runs by mapGarminType. A row erg needs this rule: its
 * Garmin types (ROWING, INDOOR_ROWING) map to the matcher's 'walk' / 'other'
 * buckets, not to a sport of their own.
 */
export function syncedCrossEnduranceFamily(activityType: string | null | undefined): 'bike' | 'swim' | 'row' | null {
  const family = familyOfSport(deriveSportFromActivityType(activityType));
  return family === 'bike' || family === 'swim' || family === 'row' ? family : null;
}

/**
 * Sport family of an in-app record. A GPS run or a run marked done is 'run'.
 * A guided or quick-done strength session (STRENGTH_TRAINING) or HYROX session
 * ('hyrox') is 'gym': the matcher's gym bucket (mapGarminType sends
 * STRENGTH_TRAINING and HIIT there), where the guided-strength upgrade and the
 * HYROX station upgrade (HIIT rows) look for the watch copy. A bike, swim or
 * row erg marked done is 'bike' / 'swim' / 'row' from its `manualSport` tag.
 */
function inAppSportFamily(a: GarminActual): SportFamily {
  if (isInAppRunActual(a)) return 'run';
  if (isGymSessionActual(a) || isInAppHyroxSession(a)) return 'gym';
  if (a.manualSport) return familyOfSport(a.manualSport);
  return 'other';
}

/**
 * Triathlon discipline of an in-app record, or null: a run (GPS or marked done)
 * is 'run', a bike or swim marked done is 'bike' / 'swim' from its sport tag.
 * These records carry no activityType, so the tri readers that classify stored
 * activities by activityType (week debrief, plan adherence, progress) call this
 * to count a ticked session in its own discipline, as its load already counts.
 */
export function inAppRecordDiscipline(a: GarminActual | null | undefined): 'swim' | 'bike' | 'run' | null {
  if (!a || !isInAppActual(a)) return null;
  const family = inAppSportFamily(a);
  return family === 'run' || family === 'bike' || family === 'swim' ? family : null;
}

/**
 * True for an in-app record the matcher's main loop supersedes by sport and
 * time window, across plan weeks: a run (GPS or marked done) or a bike or swim
 * marked done. The Strava upgrade loop leaves these to it.
 */
export function isInAppEnduranceActual(a: GarminActual | null | undefined): boolean {
  if (!a || !isInAppActual(a)) return false;
  const family = inAppSportFamily(a);
  return family === 'run' || family === 'bike' || family === 'swim' || family === 'row';
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
  return familyOfSport(resolveActualSport(key, a));
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

/**
 * True when the actual at `key` in `wk.garminActuals` has no plan slot behind
 * it: a standalone synced activity (`garmin-<id>`), or an actual kept under a
 * done (non-planned) adhoc id, such as an impromptu in-app GPS run's record or
 * the watch copy that superseded it. Planned adhoc ids (isPlannedAdhocId) are
 * plan slots. collectWeekActivities reads its Logged badge from this rule.
 */
export function isExtraActivityKey(wk: Week, key: string): boolean {
  if (key.startsWith('garmin-')) return true;
  return (wk.adhocWorkouts ?? []).some(w => {
    const id = (w.id || w.n) as string;
    return id === key && !isPlannedAdhocId(id);
  });
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
  return buildPlannedSessionActual(w, opts);
}

/**
 * Actual for a session marked done with no recording, any sport: the planned
 * duration at the rated RPE (fitness-model values it at
 * `durationMin × TL_PER_MIN[rated]`, as for a run marked done).
 *
 * `manualSport` tags a bike ('cycling'), swim ('swimming') or row erg
 * ('rowing'). activityType
 * stays null, as on a run record, so FTP / CSS / pace readers that filter on
 * activityType never take planned numbers as measured. The tag is what
 * resolveActualSport reads first, so Signal A weights the session at its own
 * sport's runSpec (SPORTS_DB cycling 0.55, swimming 0.20, rowing 0.35) and the
 * matcher and reconcile passes compare it with synced rides, swims and rows. A
 * tagged record carries no distance: a planned ride's kilometres are not
 * measured and must not reach distance totals that do not filter by sport.
 */
export function buildPlannedSessionActual(
  w: Pick<Workout, 'n' | 't' | 'd'>,
  opts: { rpe: number; startTime: string; durationMin: number; nowMs?: number; manualSport?: SportKey },
): GarminActual {
  const distanceKm = opts.manualSport ? 0 : parseDistanceKm(w.d || '');
  return {
    garminId: manualInAppGarminId(opts.nowMs),
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
    ...(opts.manualSport ? { manualSport: opts.manualSport } : {}),
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

/**
 * Sport of a triathlon, cycling, Just-Track or HYROX session for its Mark as
 * Done record, from the session's own discipline: 'run' for a run record (no
 * tag, as on a running plan card), 'cycling' for a bike, 'swimming' for a swim.
 * A brick carries discipline 'bike' (brick.ts: it "belongs to" bike), so it
 * records as one bike session for its full bike + run duration. A Just-Track
 * run generated outside triathlon carries no discipline, so its run type
 * decides (isPlanCardRunType).
 *
 * An injury cross-training session with no discipline lane (the row erg
 * offer, capability-substitution buildAerobicOffer: "Row erg: aerobic
 * maintenance") takes its sport from its label, by the canonical label rule
 * (deriveSportFromLabel): 'rowing' for the erg. Its bike and swim offers carry
 * a discipline. A HYROX easy erg session (SkiErg or row erg, discipline
 * 'station') records as 'rowing' (review 2026-10-13: it recorded nothing, so
 * a done erg was missing from every load surface and from the HYROX forecast's
 * adherence count). Rowing is the nearest sport the load model holds for
 * either erg (SPORTS_DB has no SkiErg entry; its runSpec and leg load are
 * rowing's, an open question). Anything else (gym and strength complete
 * through completeStrengthSession, HYROX station / brick, rest) gets no
 * record.
 */
export function plannedSessionRecordSport(
  w: Pick<Workout, 't' | 'discipline'> & Partial<Pick<Workout, 'n'>>,
): 'run' | 'cycling' | 'swimming' | 'rowing' | null {
  if (isHyroxEasyErg(w)) return 'rowing';
  if (!w.discipline && w.t === 'cross_training') {
    const sport = deriveSportFromLabel(w.n);
    return sport === 'cycling' || sport === 'swimming' || sport === 'rowing' ? sport : null;
  }
  const disc = w.discipline ?? (isPlanCardRunType(w.t) ? 'run' : undefined);
  if (disc === 'run') return 'run';
  if (disc === 'bike') return 'cycling';
  if (disc === 'swim') return 'swimming';
  return null;
}

/**
 * True when an activity other than an in-app record at the slot key already
 * completes the plan session at `key`, so a Mark as Done record would count the
 * session a second time. Tracking side. Two triathlon completions leave nothing
 * at the slot key:
 *   - the launch fuzzy matcher (main.ts runTriActivityMatching) links a synced
 *     recording stored under another key: `matchedActivityId` names a live
 *     actual that is not the slot's own;
 *   - brick detection sets a brick `status: 'completed'` with no link and no
 *     record when the ride and the run each matched.
 *
 * Not "completed by an activity", so a record may be written:
 *   - the slot's own key is the completion (`matchedActivityId === key`, set
 *     when reconcileTriCompletions direct-binds a record there). A synced actual
 *     at the key is kept by writeInAppActual; an in-app one is the session's
 *     own record, which a re-tick rewrites;
 *   - the link names an actual that no longer exists (the linked activity was
 *     removed), so nothing else carries the session's load.
 *
 * Reads the live session in `wk` (triWorkouts, then adhocWorkouts) when one
 * sits at `key`, since a caller may hold a resolved copy; `w` otherwise.
 */
export function isSessionCompletedByActivity(
  wk: Week,
  key: string,
  w: Partial<Pick<Workout, 'status' | 'matchedActivityId'>>,
): boolean {
  const live = [...(wk.triWorkouts ?? []), ...(wk.adhocWorkouts ?? [])]
    .find(x => ((x as { id?: string }).id ?? x.n) === key);
  const session = live ?? w;
  const link = session.matchedActivityId;
  if (link) return link !== key && !!wk.garminActuals?.[link];
  return session.status === 'completed' && !isInAppActual(wk.garminActuals?.[key]);
}

/**
 * Mark as Done on a triathlon, cycling, Just-Track or HYROX session card (audit
 * B9, decision 2026-10-06): store the session's planned load as its activity
 * record, or return null and write nothing. Tracking side. Mirrors
 * recordPlannedRunDone: the planned duration at the rated RPE, stamped on the
 * planned day, valued by fitness-model at `durationMin × TL_PER_MIN[rated]`,
 * so the session counts once in the Home strain ring, the week debrief, the
 * holiday return and every other load surface. A bike or swim is tagged with
 * its sport (buildPlannedSessionActual). A watch copy that syncs later
 * supersedes the record in place (matchAndAutoComplete, Strava wins).
 *
 * Writes nothing when:
 *   - the session has no record sport (plannedSessionRecordSport);
 *   - `key` is an activity rather than a plan slot (a synced extra opened from
 *     Recent: isExtraActivityKey). Its own record already counts;
 *   - a synced activity already completes the session without sitting at its
 *     key (isSessionCompletedByActivity: a fuzzy-matched triathlon link, or a
 *     brick completed by brick detection). That activity carries the load; the
 *     tap only rewrites the rating, as before;
 *   - the session sits in a future week (the matcher would not find the record
 *     when today's watch copy syncs, as on a running plan card);
 *   - the slot is not rated, or has no planned duration.
 *
 * A HYROX easy erg slot claims a synced erg row of its planned day instead of
 * writing a record, when one sits unmatched in the week (claimSyncedErgRow).
 *
 * `durationMin` is the caller's canonical planned duration: estimateTriWorkoutMin
 * (the dose the tri card and getPlannedDayTSSContext price), or for a
 * Just-Track run with no stored duration the running card's estimateWorkoutDurMin.
 */
export function recordPlannedSessionDone(
  wk: Week,
  key: string,
  w: Pick<Workout, 'n' | 't' | 'd' | 'dayOfWeek' | 'discipline'> & Partial<Pick<Workout, 'status' | 'matchedActivityId'>>,
  opts: {
    rpe: number;
    durationMin: number;
    planStartDate: string | null | undefined;
    weekNum: number;
    currentWeek: number;
    nowMs?: number;
  },
): GarminActual | null {
  const sport = plannedSessionRecordSport(w);
  if (!sport) return null;
  if (isExtraActivityKey(wk, key)) return null;
  if (isSessionCompletedByActivity(wk, key, w)) return null;
  if (opts.weekNum > opts.currentWeek) return null;
  if (typeof wk.rated?.[key] !== 'number') return null;
  if (!(opts.durationMin > 0)) return null;
  if (isHyroxEasyErg(w)) {
    const claimed = claimSyncedErgRow(wk, key, w, opts);
    if (claimed) return claimed;
  }
  return writeInAppActual(wk, key, buildPlannedSessionActual(w, {
    rpe: opts.rpe,
    startTime: manualCompletionStartIso(opts.planStartDate, opts.weekNum, w.dayOfWeek, opts.nowMs),
    durationMin: opts.durationMin,
    nowMs: opts.nowMs,
    ...(sport === 'run' ? {} : { manualSport: sport }),
  }));
}

/** Local calendar day (YYYY-MM-DD) of a plan session: plan start + week and
 *  weekday offsets, or '' when either is unknown. */
function plannedSessionDayKey(planStartDate: string | null | undefined, weekNum: number, dayOfWeek: number | null | undefined): string {
  const parts = (planStartDate ?? '').slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n)) || dayOfWeek == null || !(weekNum >= 1)) return '';
  const [y, m, d] = parts;
  return localDateKey(new Date(y, m - 1, d + (weekNum - 1) * 7 + dayOfWeek, 12, 0, 0, 0));
}

/**
 * Mark as Done on a HYROX easy erg slot with a synced erg row of the slot's
 * planned day sitting unmatched in the week: the row moves onto the slot and
 * no record is written (review 2026-10-13: the row, an adhoc 'Rowing' in a
 * past week or an item awaiting review in the current one, and the Mark as
 * Done record counted the session twice, 95 TSS for one 43-min erg). Tracking
 * side. The tap says the session was done, so any erg row of that day is it,
 * whatever its length; the nearest to the planned duration wins. An erg row
 * (isErgActivityType) is:
 *   - awaiting review (garminPending, garminMatched '__pending__'): its record
 *     goes on the slot, and its review item stays as the re-review record, as
 *     the matcher's slot matches keep it;
 *   - logged as an adhoc activity (garminMatched `garmin-<id>`): its record
 *     moves to the slot, and the adhoc card, its rating and any excess-load
 *     record of it leave (scrubExcessRecords).
 * The slot keeps the athlete's rating and a synced record already on it. Null
 * when there is no such row.
 */
function claimSyncedErgRow(
  wk: Week,
  key: string,
  w: Pick<Workout, 'n' | 't' | 'dayOfWeek'>,
  opts: { durationMin: number; planStartDate: string | null | undefined; weekNum: number },
): GarminActual | null {
  const existing = wk.garminActuals?.[key];
  if (existing && !isInAppActual(existing)) return null;
  const day = plannedSessionDayKey(opts.planStartDate, opts.weekNum, w.dayOfWeek);
  if (!day) return null;
  type Candidate = { garminId: string; actual: GarminActual; adhocId?: string };
  const candidates: Candidate[] = [];
  for (const p of wk.garminPending ?? []) {
    if (wk.garminMatched?.[p.garminId] !== '__pending__') continue;
    if (!isErgActivityType(p.activityType) || localDateKey(p.startTime) !== day) continue;
    candidates.push({
      garminId: p.garminId,
      actual: {
        garminId: p.garminId,
        startTime: p.startTime,
        distanceKm: (p.distanceM ?? 0) / 1000,
        durationSec: p.durationSec,
        avgPaceSecKm: p.avgPaceSecKm ?? null,
        avgHR: p.avgHR ?? null,
        maxHR: p.maxHR ?? null,
        calories: p.calories ?? null,
        aerobicEffect: p.aerobicEffect ?? null,
        anaerobicEffect: p.anaerobicEffect ?? null,
        iTrimp: p.iTrimp ?? null,
        hrZones: p.hrZones ?? null,
        polyline: p.polyline ?? null,
        kmSplits: p.kmSplits ?? null,
        averageWatts: p.averageWatts ?? null,
        normalizedPowerW: p.normalizedPowerW ?? null,
        maxWatts: p.maxWatts ?? null,
        deviceWatts: p.deviceWatts ?? null,
        kilojoules: p.kilojoules ?? null,
        activityType: p.activityType,
      },
    });
  }
  for (const [garminId, matched] of Object.entries(wk.garminMatched ?? {})) {
    if (matched !== `garmin-${garminId}`) continue;
    const a = wk.garminActuals?.[matched];
    if (!a || isInAppActual(a) || !isErgActivityType(a.activityType) || !a.startTime || localDateKey(a.startTime) !== day) continue;
    candidates.push({ garminId, actual: a, adhocId: matched });
  }
  if (candidates.length === 0) return null;
  const gap = (c: Candidate) => Math.abs(c.actual.durationSec / 60 - opts.durationMin);
  const pick = candidates.reduce((best, c) => (gap(c) < gap(best) ? c : best));
  if (!wk.garminActuals) wk.garminActuals = {};
  if (!wk.garminMatched) wk.garminMatched = {};
  const { displayName: _adhocName, ...measured } = pick.actual;
  const aliases = collectActivityAliases(wk, pick.garminId);
  wk.garminActuals[key] = { ...measured, workoutName: w.n, plannedType: w.t ?? null };
  wk.garminMatched[pick.garminId] = key;
  scrubExcessRecords([wk], aliases);
  if (pick.adhocId) {
    delete wk.garminActuals[pick.adhocId];
    wk.adhocWorkouts = (wk.adhocWorkouts ?? []).filter(x => x.id !== pick.adhocId);
    if (wk.rated) delete wk.rated[pick.adhocId];
  }
  return wk.garminActuals[key];
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
  mode: SupersedeMode,
): string | null {
  return findInAppSessionToSupersede(wk, synced, mode, 'run');
}

/**
 * findInAppRunToSupersede for any endurance family: the in-app record of
 * `family` in `wk` that a synced recording of that sport supersedes, or null.
 * A bike, swim or row record is only ever a manual completion (no in-app
 * recorder exists for them), so all three modes apply to it as to a run marked
 * done.
 */
export function findInAppSessionToSupersede(
  wk: Week,
  synced: { startTime: string; durationSec: number },
  mode: SupersedeMode,
  family: EnduranceFamily,
): string | null {
  return nearestInAppSession(wk, synced, mode, family)?.key ?? null;
}

type SupersedeMode = 'recorded' | 'same-day-completion' | 'completion';

function nearestInAppSession(
  wk: Week,
  synced: { startTime: string; durationSec: number },
  mode: SupersedeMode,
  family: EnduranceFamily,
): { key: string; gap: number } | null {
  const syncedMs = new Date(synced.startTime).getTime();
  const syncedDay = mode === 'same-day-completion' ? localDateKey(synced.startTime) : '';
  let bestKey: string | null = null;
  let bestGap = Infinity;
  for (const [key, a] of Object.entries(wk.garminActuals ?? {})) {
    if (!isInAppActual(a) || inAppSportFamily(a) !== family) continue;
    if (mode !== 'recorded' && !isManualInAppActual(a)) continue;
    if (mode === 'same-day-completion' && (!a.startTime || !syncedDay || localDateKey(a.startTime) !== syncedDay)) continue;
    const same = mode === 'recorded'
      ? isSameRecordedSession(a, synced)
      : isSameCompletedSession(a, synced);
    if (!same) continue;
    const gap = a.startTime ? Math.abs(syncedMs - new Date(a.startTime).getTime()) : Infinity;
    if (bestKey == null || gap < bestGap) { bestKey = key; bestGap = gap; }
  }
  return bestKey == null ? null : { key: bestKey, gap: bestGap };
}

/**
 * findInAppRunToSupersede over several plan weeks: the in-app run record with
 * the nearest start among `weeks`, and the week that holds it. Weeks are
 * searched in order and a tie keeps the earlier one, so the caller passes the
 * synced row's own week first.
 *
 * For 'recorded' and 'same-day-completion' the matcher passes every plan week.
 * Those windows are bounded in time (start within 4 h, or the same local
 * calendar day), so a wider search can only reach the same session filed in
 * another week: weekIndexForDate files the row by its local day, a GPS run
 * sits in s.wks[s.w - 1] (s.w can trail the calendar by more than one week
 * while a debrief is pending, welcome-back.ts debriefCap) and a Mark as Done
 * record in its card's week.
 */
export function findInAppRunToSupersedeAcrossWeeks(
  weeks: readonly (Week | null | undefined)[],
  synced: { startTime: string; durationSec: number },
  mode: SupersedeMode,
): { week: Week; key: string } | null {
  return findInAppSessionToSupersedeAcrossWeeks(weeks, synced, mode, 'run');
}

/**
 * In-app records the matcher's gym-bucket upgrades replace with a synced
 * gym-bucket row: 'hyrox' is a HYROX station or brick session recorded in the
 * app, guided or quick done (isInAppHyroxSession); 'strength' is a guided or
 * quick-done strength session (isStrengthActual).
 */
export type InAppGymKind = 'hyrox' | 'strength';

/**
 * The in-app `kind` record across `weeks` that a synced gym-bucket row is the
 * same session as, and the week that holds it, by bounded windows only:
 *   - the recorded window (isSameRecordedSession: start within 4 h, duration
 *     within 15 %), or
 *   - on the row's own local calendar day, the completion window
 *     (isSameCompletedSession; `entryFallbackMin` is the duration to assume
 *     for an entry with none, the upgrade paths' 30 min).
 * A guided record's start is its completion moment and a quick done's is
 * planned-day noon, neither a recorded start, so both take the same-day
 * completion window, as a run marked done does. Both windows are bounded in
 * time, so searching every plan week reaches only the same session filed in
 * another week (findInAppRunToSupersedeAcrossWeeks' rule for runs): a session
 * done on another day than planned across a week boundary, or a record in its
 * card's week while the row sits in the week of its own day. Nearest start
 * wins; a tie keeps the earlier week, so pass the row's own week first.
 */
export function findInAppGymSessionAcrossWeeks(
  weeks: readonly (Week | null | undefined)[],
  synced: { startTime: string; durationSec: number },
  kind: InAppGymKind,
  entryFallbackMin: number,
): { week: Week; key: string } | null {
  const syncedMs = new Date(synced.startTime).getTime();
  const syncedDay = localDateKey(synced.startTime);
  let best: { week: Week; key: string; gap: number } | null = null;
  for (const week of weeks) {
    if (!week) continue;
    for (const [key, a] of Object.entries(week.garminActuals ?? {})) {
      if (!isInAppActual(a) || isGpsInAppActual(a)) continue;
      if (kind === 'hyrox' ? !isInAppHyroxSession(a) : !isStrengthActual(a)) continue;
      const sameDay = !!a.startTime && !!syncedDay && localDateKey(a.startTime) === syncedDay;
      const same = isSameRecordedSession(a, synced)
        || (sameDay && isSameCompletedSession(a, synced, entryFallbackMin));
      if (!same) continue;
      const gap = a.startTime ? Math.abs(syncedMs - new Date(a.startTime).getTime()) : Infinity;
      if (best == null || gap < best.gap) best = { week, key, gap };
    }
  }
  return best ? { week: best.week, key: best.key } : null;
}

/**
 * findInAppRunToSupersedeAcrossWeeks for any endurance family. The matcher
 * runs it for synced rides, swims and rows against the same sessions marked
 * done in triathlon, cycling, Just-Track and HYROX (cross-training), with the
 * same bounded windows as runs.
 */
export function findInAppSessionToSupersedeAcrossWeeks(
  weeks: readonly (Week | null | undefined)[],
  synced: { startTime: string; durationSec: number },
  mode: SupersedeMode,
  family: EnduranceFamily,
): { week: Week; key: string } | null {
  let best: { week: Week; key: string; gap: number } | null = null;
  for (const week of weeks) {
    if (!week) continue;
    const hit = nearestInAppSession(week, synced, mode, family);
    if (hit && (best == null || hit.gap < best.gap)) best = { week, key: hit.key, gap: hit.gap };
  }
  return best ? { week: best.week, key: best.key } : null;
}
