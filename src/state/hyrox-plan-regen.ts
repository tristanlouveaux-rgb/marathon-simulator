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
 *    session on the day its activity started; with no activity day to go on
 *    (a rating alone) or no session on that day, the entry stays under the name
 *    for the athlete to review, rather than guessing a slot.
 */

import type { SimulatorState, Week, Workout } from '@/types/state';
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
 * them. Entries already keyed by a session id, and keys that are not a session
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
  if (wk.garminActuals) {
    for (const key of Object.keys(wk.garminActuals)) {
      const target = resolve(key, wk.garminActuals[key]?.startTime);
      if (!target || wk.garminActuals[target]) continue;
      wk.garminActuals[target] = wk.garminActuals[key];
      delete wk.garminActuals[key];
      moved[key] = target;
    }
  }
  const targetFor = (key: string): string | null => moved[key] ?? resolve(key);

  if (wk.rated) {
    for (const key of Object.keys(wk.rated)) {
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
    rekeyNameKeyedHyroxSlots(wk);
  }
  hx.generatorVersion = HYROX_GENERATOR_VERSION;
  console.log(`[hyrox] plan regenerated (generator v${savedVersion} → v${HYROX_GENERATOR_VERSION})`);
  return true;
}
