/**
 * HYROX plan regeneration on a generator-version bump (main.ts launch path).
 *
 * Mirrors the triathlon regen in main.ts: when the stored
 * `hyroxConfig.generatorVersion` is older than HYROX_GENERATOR_VERSION, every
 * week's generator-owned sessions are replaced with fresh output while each
 * week's actuals / rated / skip arrays stay on the week.
 *
 * TRACKING side: nothing here prescribes. It keeps what the athlete already did
 * attached to the right session after the sessions are rebuilt.
 *
 * Two things the bare array swap lost:
 *  - User-added sessions. Sessions with an `adhoc-` / `holiday-` id are carried
 *    over. Sessions added before HYROX added sessions carried an id (the add
 *    modal tagged them `addedManually` only) get an `adhoc-` id and are carried
 *    too, instead of being deleted.
 *  - Name-keyed slot entries. Before generator v14 HYROX sessions had no ids,
 *    so every writer keyed by `workout.n`: `rated`, the `garminActuals` keys,
 *    the `garminMatched` values and `gpsRecordings`. The fresh sessions carry
 *    W{week}-{type}-{idx} ids, so those entries are re-keyed to the session's
 *    new id. When two sessions in the week share the name, an entry follows the
 *    session on the day its activity started. When no single session of that
 *    name is on the activity's day, the activity goes to Activity Review
 *    (`garminPending` + `garminMatched[id] = '__pending__'`) so the athlete
 *    picks the slot, rather than guessing one. Left under the name, it matched
 *    no session, never reached review (the matcher skips any activity whose
 *    `garminMatched` value is not '__pending__'), and still counted in load, so
 *    a later Mark as Done on either session counted the work twice. A rating
 *    with no activity behind it stays under the name: there is nothing to
 *    review and it carries no load.
 */

import type { GarminActual, GarminPendingItem, SimulatorState, Week, Workout } from '@/types/state';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';

/** True for a session the athlete added (its own id survives the regen). */
function hasUserAddedId(w: Workout): boolean {
  return typeof w.id === 'string' && (w.id.startsWith('adhoc-') || w.id.startsWith('holiday-'));
}

/**
 * User-added sessions to carry into the regenerated week. A legacy added
 * session (no id, `addedManually`) gets an `adhoc-` id, deterministic per week
 * and position so a repeated run gives the same key.
 */
function carriedUserSessions(wk: Week): Workout[] {
  const out: Workout[] = [];
  let legacyIdx = 0;
  for (const w of wk.triWorkouts ?? []) {
    if (hasUserAddedId(w)) { out.push(w); continue; }
    if (!w.id && (w as { addedManually?: boolean }).addedManually === true) {
      out.push({ ...w, id: `adhoc-W${wk.w}-${legacyIdx++}` });
    }
  }
  return out;
}

/** Day of week (0 = Mon … 6 = Sun) of an ISO start time, local, as the matcher reads it. */
function dayOfWeekOf(startTime: string | null | undefined): number | null {
  if (!startTime) return null;
  const d = new Date(startTime);
  if (Number.isNaN(d.getTime())) return null;
  const js = d.getDay();
  return js === 0 ? 6 : js - 1;
}

/**
 * Re-key the week's name-keyed slot entries (rated, garminActuals keys,
 * garminMatched values, gpsRecordings) to the id of the session that now owns
 * them. An activity under a name two sessions share, with neither (or both)
 * on its day, goes to Activity Review along with its rating (sendToReview).
 * Entries already keyed by a session id, and keys that are not a session
 * name in this week (adhoc activity ids, `garmin-…`, `__pending__`), are left as
 * they are. Never overwrites an entry already present under the target id.
 * Idempotent.
 */
export function rekeyNameKeyedHyroxSlots(wk: Week): void {
  const sessions = wk.triWorkouts ?? [];
  const ids = new Set(sessions.map(w => w.id).filter((id): id is string => !!id));
  const byName = new Map<string, Workout[]>();
  for (const w of sessions) {
    if (!w.id || !w.n) continue;
    const list = byName.get(w.n) ?? [];
    list.push(w);
    byName.set(w.n, list);
  }

  /** The id that owns name key `key`, or null to leave the entry where it is. */
  const resolve = (key: string, startTime?: string | null): string | null => {
    if (ids.has(key)) return null;
    const candidates = byName.get(key);
    if (!candidates?.length) return null;
    if (candidates.length === 1) return candidates[0].id!;
    const dow = dayOfWeekOf(startTime);
    if (dow == null) return null;
    const onDay = candidates.filter(w => w.dayOfWeek === dow);
    return onDay.length === 1 ? onDay[0].id! : null;
  };

  // garminActuals first: an actual's start time settles which same-named
  // session it belongs to, and the rating / match / recording follow it.
  const moved: Record<string, string> = {};
  const toReview = new Set<string>();
  if (wk.garminActuals) {
    for (const key of Object.keys(wk.garminActuals)) {
      const actual = wk.garminActuals[key];
      const target = resolve(key, actual?.startTime);
      if (target) {
        if (wk.garminActuals[target]) continue;
        wk.garminActuals[target] = actual;
        delete wk.garminActuals[key];
        moved[key] = target;
        continue;
      }
      // A name two or more sessions share, with no single one on the
      // activity's day: Activity Review decides the slot. An actual with no
      // start time has no day to show in review and stays where it is.
      const sameName = byName.get(key) ?? [];
      if (ids.has(key) || sameName.length < 2 || !actual?.garminId || !actual.startTime) continue;
      sendToReview(wk, key, actual, sameName[0].discipline === 'run' ? 'run' : 'gym');
      toReview.add(key);
    }
  }
  const targetFor = (key: string): string | null => moved[key] ?? resolve(key);

  if (wk.rated) {
    for (const key of Object.keys(wk.rated)) {
      // The rating belonged to the activity now in review; the review writes
      // a fresh one on the slot the athlete picks.
      if (toReview.has(key)) { delete wk.rated[key]; continue; }
      const target = targetFor(key);
      if (!target || wk.rated[target] !== undefined) continue;
      wk.rated[target] = wk.rated[key];
      delete wk.rated[key];
    }
  }

  if (wk.garminMatched) {
    for (const [garminId, slot] of Object.entries(wk.garminMatched)) {
      if (slot === '__pending__') continue;
      const target = targetFor(slot);
      if (target) wk.garminMatched[garminId] = target;
    }
  }

  if (wk.gpsRecordings) {
    for (const key of Object.keys(wk.gpsRecordings)) {
      const target = targetFor(key);
      if (!target || wk.gpsRecordings[target]) continue;
      wk.gpsRecordings[target] = wk.gpsRecordings[key];
      delete wk.gpsRecordings[key];
    }
  }
}

/**
 * Move a name-keyed activity that no single session can claim into Activity
 * Review: a pending record (reusing the matcher's re-review record when one is
 * there), `garminMatched` set to '__pending__', and the name-keyed actual
 * removed so it no longer counts as a completion or as load until assigned.
 * `appType` follows the HYROX matcher: 'run' for runs, 'gym' for station and
 * brick work. An in-app GPS route (`gpsRecordings`) stays under the name.
 */
function sendToReview(wk: Week, key: string, actual: GarminActual, appType: 'run' | 'gym'): void {
  const garminId = actual.garminId;
  wk.garminPending ??= [];
  if (!wk.garminPending.some(p => p.garminId === garminId)) {
    const item: GarminPendingItem = {
      garminId,
      activityType: actual.activityType ?? (appType === 'run' ? 'RUNNING' : key),
      appType,
      startTime: actual.startTime!,
      durationSec: actual.durationSec,
      distanceM: actual.distanceKm > 0 ? actual.distanceKm * 1000 : null,
      avgPaceSecKm: actual.avgPaceSecKm ?? null,
      avgHR: actual.avgHR ?? null,
      maxHR: actual.maxHR ?? null,
      aerobicEffect: actual.aerobicEffect ?? null,
      anaerobicEffect: actual.anaerobicEffect ?? null,
      garminRpe: null,
      calories: actual.calories ?? null,
      iTrimp: actual.iTrimp ?? null,
      hrZones: actual.hrZones ?? null,
      polyline: actual.polyline ?? null,
      kmSplits: actual.kmSplits ?? null,
    };
    wk.garminPending.push(item);
  }
  wk.garminMatched ??= {};
  wk.garminMatched[garminId] = '__pending__';
  delete wk.garminActuals![key];
}

/**
 * Regenerate the HYROX plan when the generator version has bumped. Mutates
 * `s` in place; returns true when it regenerated (the caller saves).
 */
export function applyHyroxGeneratorRegen(s: SimulatorState): boolean {
  const hx = s.hyroxConfig;
  if (!hx || !s.wks?.length) return false;
  const savedVersion = hx.generatorVersion ?? 0;
  if (savedVersion >= HYROX_GENERATOR_VERSION) return false;
  const freshWeeks = generateHyroxPlan(s);
  if (freshWeeks.length === 0) return false;
  for (let i = 0; i < Math.min(s.wks.length, freshWeeks.length); i++) {
    const wk = s.wks[i];
    wk.triWorkouts = [...(freshWeeks[i].triWorkouts ?? []), ...carriedUserSessions(wk)];
    wk.ph = freshWeeks[i].ph;
    // Race-week calendar layout (generator v15+): a Monday to Wednesday race's
    // own week is a closing week with no sessions; the flag follows the fresh plan.
    if (freshWeeks[i].raceClosing) wk.raceClosing = true;
    else delete wk.raceClosing;
    // The generator's notes on the week (sessions its rules changed) follow it.
    if (freshWeeks[i].hyroxPlanNotes) wk.hyroxPlanNotes = freshWeeks[i].hyroxPlanNotes;
    else delete wk.hyroxPlanNotes;
    rekeyNameKeyedHyroxSlots(wk);
  }
  hx.generatorVersion = HYROX_GENERATOR_VERSION;
  console.log(`[hyrox] plan regenerated (generator v${savedVersion} → v${HYROX_GENERATOR_VERSION})`);
  return true;
}
