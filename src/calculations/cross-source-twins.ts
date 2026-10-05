/**
 * Cross-source twins: one real session recorded by two sources (an Apple Health
 * copy and a Strava copy of the same ride, run or gym session).
 *
 * **Side of the line**: tracking. Decides whether two activity records describe
 * the same session so it counts once. Strava is canonical, so the Strava copy
 * always survives.
 *
 * Same-session rule (the one `cleanupDbDuplicates` in stravaSync.ts already
 * applies to `garmin_activities`): start times within 10 minutes AND either the
 * same activity_type or durations within 15% of each other. Same type at any
 * duration counts as one session because HealthKit's workout duration excludes
 * pauses while Strava's `duration_sec` is elapsed time, so a paused ride differs
 * by more than 15% and is still one ride. The duration branch covers two sources
 * naming one session differently (Strava HIIT vs Apple CARDIO).
 *
 * Known limitation: two separate recordings started more than 10 minutes apart
 * that also differ in both type and duration are never matched.
 *
 * Pure module: reads and writes the state object passed in, never the network.
 * Must not import activity-matcher.ts at runtime (that file imports this one).
 */

import type { GarminActivityRow } from '@/calculations/activity-matcher';
import type { GarminActual, GarminPendingItem, SimulatorState, Week } from '@/types/state';

/** Start-time window. Same constant `cleanupDbDuplicates` groups DB rows with. */
export const TWIN_START_WINDOW_MS = 10 * 60 * 1000;
/** Duration tolerance (fraction of the longer duration, exclusive). Same constant
 *  `cleanupDbDuplicates` uses. */
export const TWIN_DURATION_TOLERANCE = 0.15;

/** The fields the same-session rule reads. */
export interface SessionRef {
  startMs: number;
  durationSec: number | null;
  activityType: string | null;
}

/** The canonical same-session predicate. */
export function isSameSession(a: SessionRef, b: SessionRef): boolean {
  if (!Number.isFinite(a.startMs) || !Number.isFinite(b.startMs)) return false;
  if (Math.abs(a.startMs - b.startMs) > TWIN_START_WINDOW_MS) return false;
  if (!!a.activityType && a.activityType === b.activityType) return true;
  if (a.durationSec && b.durationSec && a.durationSec > 0 && b.durationSec > 0) {
    const ratio = Math.abs(a.durationSec - b.durationSec) / Math.max(a.durationSec, b.durationSec);
    return ratio < TWIN_DURATION_TOLERANCE;
  }
  return false;
}

const isStravaId = (id: string | null | undefined): boolean => !!id && id.startsWith('strava-');
const isAppleId = (id: string | null | undefined): boolean => !!id && id.startsWith('apple-');
const SURPLUS_SUFFIX = '_surplus';

/** Apple ids are `apple-<source>-<HealthKit start ISO>` (appleHealthSync.ts
 *  workoutKey). Recover the start when no other record carries it. */
export function appleIdStartMs(appleId: string): number {
  const m = appleId.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)$/);
  return m ? Date.parse(m[1]) : NaN;
}

/** Raw activity type of an adhoc card. The actual stored under the same key is
 *  authoritative. A run adhoc (t 'easy') with no actual is RUNNING: the matcher
 *  writes t 'easy' only for rows it classed as runs, and both sources name a run
 *  RUNNING (Apple mapWorkoutType, Strava mapStravaType). */
function adhocActivityType(w: Record<string, unknown>, actual: GarminActual | undefined): string | null {
  if (actual?.activityType) return actual.activityType;
  if (typeof w.activityType === 'string' && w.activityType) return w.activityType;
  return w.t === 'easy' ? 'RUNNING' : null;
}

/** A Strava session found in state, with where it currently sits. */
interface StravaSession extends SessionRef {
  garminId: string;
  /** garminActuals keys (week index, key) carrying this Strava id. */
  actualKeys: Array<{ wi: number; key: string }>;
}

/** Every Strava session in `wks`, one entry per Strava id. */
function collectStravaSessions(wks: Week[]): StravaSession[] {
  const byId = new Map<string, StravaSession>();
  const upsert = (garminId: string, ref: SessionRef): StravaSession => {
    let rec = byId.get(garminId);
    if (!rec) {
      rec = { garminId, startMs: ref.startMs, durationSec: ref.durationSec, activityType: ref.activityType, actualKeys: [] };
      byId.set(garminId, rec);
    } else {
      if (!Number.isFinite(rec.startMs)) rec.startMs = ref.startMs;
      if (!rec.durationSec) rec.durationSec = ref.durationSec;
      if (!rec.activityType) rec.activityType = ref.activityType;
    }
    return rec;
  };
  wks.forEach((wk, wi) => {
    for (const [key, a] of Object.entries(wk.garminActuals ?? {})) {
      if (!isStravaId(a.garminId)) continue;
      const rec = upsert(a.garminId, {
        startMs: a.startTime ? Date.parse(a.startTime) : NaN,
        durationSec: a.durationSec ?? null,
        activityType: a.activityType ?? null,
      });
      rec.actualKeys.push({ wi, key });
    }
    for (const p of wk.garminPending ?? []) {
      if (!isStravaId(p.garminId)) continue;
      upsert(p.garminId, {
        startMs: p.startTime ? Date.parse(p.startTime) : NaN,
        durationSec: p.durationSec ?? null,
        activityType: p.activityType ?? null,
      });
    }
    for (const w of wk.adhocWorkouts ?? []) {
      const id = w.id ?? '';
      if (!id.startsWith('garmin-strava-')) continue;
      const wa = w as unknown as Record<string, unknown>;
      const ts = typeof wa.garminTimestamp === 'string' ? wa.garminTimestamp : null;
      upsert(id.slice('garmin-'.length), {
        startMs: ts ? Date.parse(ts) : NaN,
        durationSec: typeof wa.garminDurationMin === 'number' ? wa.garminDurationMin * 60 : null,
        activityType: adhocActivityType(wa, wk.garminActuals?.[id]),
      });
    }
  });
  return [...byId.values()].filter(r => Number.isFinite(r.startMs));
}

/** Every Apple session in `wks`, keyed by Apple id. Fields come from the richest
 *  record available: actual, then pending item, then adhoc card, then the id
 *  itself plus any excess record. */
function collectAppleSessions(wks: Week[]): Map<string, SessionRef> {
  const out = new Map<string, SessionRef>();
  const merge = (id: string, ref: SessionRef): void => {
    const cur = out.get(id);
    if (!cur) { out.set(id, { ...ref }); return; }
    if (!Number.isFinite(cur.startMs)) cur.startMs = ref.startMs;
    if (!cur.durationSec) cur.durationSec = ref.durationSec;
    if (!cur.activityType) cur.activityType = ref.activityType;
  };
  // Pass order = priority order (merge only fills gaps).
  for (const wk of wks) {
    for (const a of Object.values(wk.garminActuals ?? {})) {
      if (!isAppleId(a.garminId)) continue;
      merge(a.garminId, { startMs: a.startTime ? Date.parse(a.startTime) : NaN, durationSec: a.durationSec ?? null, activityType: a.activityType ?? null });
    }
  }
  for (const wk of wks) {
    for (const p of wk.garminPending ?? []) {
      if (!isAppleId(p.garminId)) continue;
      merge(p.garminId, { startMs: p.startTime ? Date.parse(p.startTime) : NaN, durationSec: p.durationSec ?? null, activityType: p.activityType ?? null });
    }
  }
  for (const wk of wks) {
    for (const w of wk.adhocWorkouts ?? []) {
      const id = w.id ?? '';
      if (!id.startsWith('garmin-apple-')) continue;
      const held = wk.garminActuals?.[id];
      // An adhoc the Strava upgrade rewrote in place is the Strava record now.
      if (held && !isAppleId(held.garminId)) continue;
      const wa = w as unknown as Record<string, unknown>;
      const ts = typeof wa.garminTimestamp === 'string' ? wa.garminTimestamp : null;
      merge(id.slice('garmin-'.length), {
        startMs: ts ? Date.parse(ts) : NaN,
        durationSec: typeof wa.garminDurationMin === 'number' ? wa.garminDurationMin * 60 : null,
        activityType: adhocActivityType(wa, held),
      });
    }
  }
  for (const wk of wks) {
    for (const u of wk.unspentLoadItems ?? []) {
      if (!isAppleId(u.garminId) || u.garminId.endsWith(SURPLUS_SUFFIX)) continue;
      merge(u.garminId, { startMs: appleIdStartMs(u.garminId), durationSec: u.durationMin > 0 ? u.durationMin * 60 : null, activityType: null });
    }
    for (const gid of Object.keys(wk.garminMatched ?? {})) {
      if (!isAppleId(gid)) continue;
      merge(gid, { startMs: appleIdStartMs(gid), durationSec: null, activityType: null });
    }
  }
  return out;
}

/** The Strava session that twins `ref`, nearest start first. */
function findTwin<T extends SessionRef>(ref: SessionRef, candidates: T[]): T | null {
  let best: T | null = null;
  let bestGap = Infinity;
  for (const c of candidates) {
    if (!isSameSession(ref, c)) continue;
    const gap = Math.abs(c.startMs - ref.startMs);
    if (gap < bestGap) { best = c; bestGap = gap; }
  }
  return best;
}

/**
 * Drop incoming Apple rows whose session Strava already holds, in state or in
 * the same batch. Strava wins, so the Apple copy never enters state. Used at the
 * top of `matchAndAutoComplete`, which every ingest path goes through. A no-op
 * for a user with no Strava records.
 */
export function dropAppleRowsWithStravaTwin(rows: GarminActivityRow[], wks: Week[] | undefined): GarminActivityRow[] {
  if (!rows.some(r => isAppleId(r.garmin_id))) return rows;
  const strava: SessionRef[] = collectStravaSessions(wks ?? []);
  for (const r of rows) {
    if (!isStravaId(r.garmin_id)) continue;
    strava.push({ startMs: Date.parse(r.start_time), durationSec: r.duration_sec ?? null, activityType: r.activity_type ?? null });
  }
  if (strava.length === 0) return rows;
  const kept = rows.filter(r => {
    if (!isAppleId(r.garmin_id)) return true;
    const ref = { startMs: Date.parse(r.start_time), durationSec: r.duration_sec ?? null, activityType: r.activity_type ?? null };
    return !strava.some(sr => isSameSession(ref, sr));
  });
  if (kept.length !== rows.length) {
    console.log(`[cross-source] Skipped ${rows.length - kept.length} Apple Health row(s) whose session Strava already holds`);
  }
  return kept;
}

/** Strava data for a session, from the richest record holding it. */
function stravaData(wks: Week[], stravaId: string): Partial<GarminActual> | null {
  for (const wk of wks) {
    for (const a of Object.values(wk.garminActuals ?? {})) {
      if (a.garminId === stravaId) return a;
    }
  }
  for (const wk of wks) {
    const p: GarminPendingItem | undefined = (wk.garminPending ?? []).find(x => x.garminId === stravaId);
    if (p) {
      return {
        startTime: p.startTime, durationSec: p.durationSec,
        distanceKm: p.distanceM != null ? p.distanceM / 1000 : undefined,
        avgPaceSecKm: p.avgPaceSecKm ?? null, avgHR: p.avgHR, maxHR: p.maxHR, calories: p.calories,
        iTrimp: p.iTrimp ?? null, hrZones: p.hrZones ?? null, polyline: p.polyline ?? null,
        kmSplits: p.kmSplits ?? null, activityType: p.activityType,
        averageWatts: p.averageWatts ?? null, normalizedPowerW: p.normalizedPowerW ?? null,
        maxWatts: p.maxWatts ?? null, deviceWatts: p.deviceWatts ?? null, kilojoules: p.kilojoules ?? null,
      };
    }
  }
  for (const wk of wks) {
    const w = (wk.adhocWorkouts ?? []).find(x => x.id === `garmin-${stravaId}`);
    if (w) {
      const wa = w as unknown as Record<string, any>;
      return {
        startTime: wa.garminTimestamp ?? null,
        durationSec: typeof wa.garminDurationMin === 'number' ? wa.garminDurationMin * 60 : undefined,
        distanceKm: wa.garminDistKm ?? undefined, avgHR: wa.garminAvgHR ?? null, maxHR: wa.garminMaxHR ?? null,
        calories: wa.garminCalories ?? null, iTrimp: wa.iTrimp ?? null, hrZones: wa.hrZones ?? null,
        polyline: wa.polyline ?? null, kmSplits: wa.kmSplits ?? null,
      };
    }
  }
  return null;
}

/** The plan-slot actual rebuilt from the Strava copy. Slot metadata (workout
 *  name, planned type, commute tag, logged lifts) stays from the slot; activity
 *  data comes from Strava where Strava has it. Same merge shape as the Strava
 *  upgrade loop in matchAndAutoComplete. */
function reboundActual(slot: GarminActual, stravaId: string, d: Partial<GarminActual>): GarminActual {
  return {
    ...slot,
    garminId: stravaId,
    startTime: d.startTime ?? slot.startTime,
    distanceKm: d.distanceKm ?? slot.distanceKm,
    durationSec: d.durationSec || slot.durationSec,
    avgPaceSecKm: d.avgPaceSecKm ?? slot.avgPaceSecKm,
    avgHR: d.avgHR ?? slot.avgHR,
    maxHR: d.maxHR ?? slot.maxHR,
    calories: d.calories ?? slot.calories,
    iTrimp: d.iTrimp ?? slot.iTrimp,
    hrZones: d.hrZones ?? slot.hrZones,
    polyline: d.polyline ?? slot.polyline,
    kmSplits: d.kmSplits ?? slot.kmSplits,
    kmHRSplits: d.kmHRSplits ?? slot.kmHRSplits,
    elevationGainM: d.elevationGainM ?? slot.elevationGainM,
    hrDrift: d.hrDrift ?? slot.hrDrift,
    ambientTempC: d.ambientTempC ?? slot.ambientTempC,
    averageWatts: d.averageWatts ?? slot.averageWatts,
    normalizedPowerW: d.normalizedPowerW ?? slot.normalizedPowerW,
    maxWatts: d.maxWatts ?? slot.maxWatts,
    deviceWatts: d.deviceWatts ?? slot.deviceWatts,
    kilojoules: d.kilojoules ?? slot.kilojoules,
    powerCurve: d.powerCurve ?? slot.powerCurve,
    stravaId: d.stravaId ?? slot.stravaId,
    activityType: d.activityType ?? slot.activityType,
    displayName: slot.displayName != null ? (d.displayName ?? slot.displayName) : slot.displayName,
  };
}

export interface TwinCollapseResult {
  /** Apple ids removed from state and tombstoned. */
  removed: string[];
  /** Plan slots whose completion moved from the Apple copy to the Strava copy. */
  rebound: number;
}

/**
 * Remove every Apple record that duplicates a Strava record in `s.wks`: actuals,
 * pending items, `garmin-apple-*` adhoc cards, excess records, and the
 * garminMatched / rated / review-choice entries pointing at them. Removed ids
 * go to `s.supersededGarminIds` so no later sync re-imports them. Apple-only
 * sessions (no Strava twin) stay.
 *
 * When the Apple copy completed a plan slot that the Strava copy did not, the
 * slot keeps its completion and now carries the Strava copy; the Strava copy's
 * own adhoc card and excess record go, so the session counts once. When both
 * copies completed slots, the Apple slot's completion was a phantom and is
 * cleared: running slots lose the actual and rating, triathlon / HYROX slots
 * (wk.triWorkouts) lose the match link and return to planned.
 *
 * Never touches `wk.actualTSS`. Idempotent: a second pass finds nothing.
 */
export function collapseAppleStravaTwins(s: SimulatorState): TwinCollapseResult {
  const wks = s.wks ?? [];
  const result: TwinCollapseResult = { removed: [], rebound: 0 };
  if (wks.length === 0) return result;

  const apple = collectAppleSessions(wks);
  if (apple.size === 0) return result;

  // Collected once, re-read only after a removal: a rebind or detach moves Strava
  // records. Apple-only sessions (the common case once twins are gone) then cost
  // one numeric scan each, which matters because matchAndAutoComplete runs this
  // after every batch that carries Strava rows.
  let strava = collectStravaSessions(wks);
  if (strava.length === 0) return result;
  for (const [appleId, ref] of apple) {
    const twin = findTwin(ref, strava);
    if (!twin) continue;
    if (removeAppleCopy(wks, appleId, twin)) result.rebound++;
    result.removed.push(appleId);
    strava = collectStravaSessions(wks);
  }

  if (result.removed.length > 0) {
    const removed = new Set(result.removed);
    s.supersededGarminIds = [...new Set([...(s.supersededGarminIds ?? []), ...result.removed])];
    // Per-activity records outside the weeks. The existing reconcile/ingest passes
    // add the Strava copy's own entry, so dropping the Apple one leaves one per session.
    if (s.recentLegLoads?.some(e => e.garminId && removed.has(e.garminId))) {
      s.recentLegLoads = s.recentLegLoads.filter(e => !e.garminId || !removed.has(e.garminId));
    }
    if (s.sessionImpactLog?.some(e => removed.has(e.garminId))) {
      s.sessionImpactLog = s.sessionImpactLog.filter(e => !removed.has(e.garminId));
    }
    console.log(`[cross-source] Removed ${result.removed.length} Apple Health copy(ies) of sessions Strava holds (${result.rebound} plan slot(s) moved to the Strava copy)`);
  }
  return result;
}

/** Removes one Apple copy. Returns true when a plan slot moved to the Strava copy. */
function removeAppleCopy(wks: Week[], appleId: string, twin: StravaSession): boolean {
  let rebound = false;
  const stravaId = twin.garminId;
  let stravaHoldsSlot = twin.actualKeys.some(k => !k.key.startsWith('garmin-'));
  /** Actual keys removed per week (for triathlon match links). */
  const removedKeys = new Map<number, Set<string>>();
  const noteRemoved = (wi: number, key: string) => {
    if (!removedKeys.has(wi)) removedKeys.set(wi, new Set());
    removedKeys.get(wi)!.add(key);
  };

  wks.forEach((wk, wi) => {
    // 1. Actuals carrying the Apple id.
    for (const [key, a] of Object.entries(wk.garminActuals ?? {})) {
      if (a.garminId !== appleId) continue;
      const isSlot = !key.startsWith('garmin-');
      if (isSlot && !stravaHoldsSlot) {
        const d = stravaData(wks, stravaId);
        if (d) {
          wk.garminActuals![key] = reboundActual(a, stravaId, d);
          detachStravaFromNonSlotPlaces(wks, stravaId);
          for (const w2 of wks) if (w2.garminMatched?.[stravaId] !== undefined) delete w2.garminMatched[stravaId];
          if (!wk.garminMatched) wk.garminMatched = {};
          wk.garminMatched[stravaId] = key;
          stravaHoldsSlot = true;
          rebound = true;
          console.log(`[cross-source] Slot ${key}: completion moved from ${appleId} to ${stravaId}`);
          continue;
        }
      }
      delete wk.garminActuals![key];
      if (wk.rated?.[key] !== undefined) delete wk.rated[key];
      if (isSlot && wk.workoutMods) {
        // Same scrub removeGarminActivity applies when a slot loses its activity.
        wk.workoutMods = wk.workoutMods.filter(m => !(m.name === key && m.modReason?.startsWith('Garmin:')));
      }
      if (wk.adhocWorkouts) wk.adhocWorkouts = wk.adhocWorkouts.filter(w => w.id !== key);
      noteRemoved(wi, key);
    }

    // 2. The Apple adhoc card, unless the Strava upgrade rewrote it in place.
    const adhocKey = `garmin-${appleId}`;
    if (wk.adhocWorkouts?.some(w => w.id === adhocKey)) {
      const held = wk.garminActuals?.[adhocKey];
      if (!held || held.garminId === appleId) {
        wk.adhocWorkouts = wk.adhocWorkouts.filter(w => w.id !== adhocKey);
        if (held) delete wk.garminActuals![adhocKey];
        if (wk.rated?.[adhocKey] !== undefined) delete wk.rated[adhocKey];
        noteRemoved(wi, adhocKey);
      }
    }

    // 3. Pending records and pointers.
    if (wk.garminPending?.some(p => p.garminId === appleId)) {
      wk.garminPending = wk.garminPending.filter(p => p.garminId !== appleId);
    }
    if (wk.garminMatched?.[appleId] !== undefined) delete wk.garminMatched[appleId];
    if (wk.garminReviewChoices?.[appleId] !== undefined) delete wk.garminReviewChoices[appleId];
  });

  // 4. Excess records (they can be carried into a later week, so every week).
  // An excess decision made for an adhoc the Strava upgrade rewrote in place
  // belongs to that record, so it moves to the Strava id when Strava has none.
  const upgradedInPlace = twin.actualKeys.some(k => k.key === `garmin-${appleId}`);
  const stravaHasExcess = wks.some(wk => (wk.unspentLoadItems ?? []).some(u => u.garminId === stravaId));
  const stravaInSlot = stravaHoldsSlot;
  for (const wk of wks) {
    if (!wk.unspentLoadItems?.length) continue;
    const next: typeof wk.unspentLoadItems = [];
    for (const u of wk.unspentLoadItems) {
      const base = u.garminId.endsWith(SURPLUS_SUFFIX) ? u.garminId.slice(0, -SURPLUS_SUFFIX.length) : u.garminId;
      if (base !== appleId) { next.push(u); continue; }
      if (upgradedInPlace && !stravaHasExcess && !stravaInSlot && !u.garminId.endsWith(SURPLUS_SUFFIX)) {
        next.push({ ...u, garminId: stravaId });
      }
    }
    wk.unspentLoadItems = next;
  }

  // 5. Triathlon and HYROX slots (wk.triWorkouts) whose completion rested on a
  // removed Apple key: a match link to it, or a direct bind under the slot's own
  // key. The link follows the Strava copy only when that copy is a free recording
  // in the same week: a `garmin-…` key that is neither another slot's own key nor
  // already linked by another slot, and the Strava copy completes no plan slot
  // anywhere (stravaHoldsSlot). Otherwise the Strava copy completes some
  // other slot (or sits in another week), so this slot's completion was the
  // phantom: clear the link and return the slot to planned, as
  // reconcileTriCompletions step 3 does for a stale link. One session then
  // completes one slot, the same outcome as running's phantom clear in step 1.
  for (const [wi, keys] of removedKeys) {
    const wk = wks[wi];
    if (!wk.triWorkouts?.length) continue;
    const slotIds = new Set(wk.triWorkouts.map(w => w.id ?? w.n));
    const stravaKey = Object.entries(wk.garminActuals ?? {}).find(([, a]) => a.garminId === stravaId)?.[0];
    for (const w of wk.triWorkouts) {
      const id = w.id ?? w.n;
      const linkRemoved = !!w.matchedActivityId && keys.has(w.matchedActivityId);
      const directBindRemoved = keys.has(id) && !wk.garminActuals?.[id];
      if (!linkRemoved && !directBindRemoved) continue;
      const stravaFree = !!stravaKey
        && !stravaHoldsSlot
        && stravaKey.startsWith('garmin-')
        && !slotIds.has(stravaKey)
        && !wk.triWorkouts.some(o => o !== w && o.matchedActivityId === stravaKey);
      if (stravaFree) {
        w.matchedActivityId = stravaKey;
      } else {
        delete w.matchedActivityId;
        if (w.status === 'completed') w.status = 'planned';
      }
    }
  }
  return rebound;
}

/** On a slot rebind the Strava copy's adhoc card and excess record go: the
 *  session now counts through the slot. Its pending record stays (re-review). */
function detachStravaFromNonSlotPlaces(wks: Week[], stravaId: string): void {
  for (const wk of wks) {
    for (const [key, a] of Object.entries(wk.garminActuals ?? {})) {
      if (a.garminId !== stravaId || !key.startsWith('garmin-')) continue;
      delete wk.garminActuals![key];
      if (wk.adhocWorkouts) wk.adhocWorkouts = wk.adhocWorkouts.filter(w => w.id !== key);
      if (wk.rated?.[key] !== undefined) delete wk.rated[key];
    }
    const adhocKey = `garmin-${stravaId}`;
    if (wk.adhocWorkouts?.some(w => w.id === adhocKey) && !wk.garminActuals?.[adhocKey]) {
      wk.adhocWorkouts = wk.adhocWorkouts.filter(w => w.id !== adhocKey);
      if (wk.rated?.[adhocKey] !== undefined) delete wk.rated[adhocKey];
    }
    if (wk.unspentLoadItems?.some(u => u.garminId === stravaId)) {
      wk.unspentLoadItems = wk.unspentLoadItems.filter(u => u.garminId !== stravaId);
    }
  }
}
