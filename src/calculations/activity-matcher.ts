/**
 * Garmin Activity Matcher — matches synced Garmin activities to planned workouts
 * and auto-completes them, or logs unmatched activities as ad-hoc workouts.
 */

import { getMutableState, saveState } from '@/state';
import { gp } from '@/calculations/paces';
import { generateWeekWorkouts, calculateWorkoutLoad } from '@/workouts';
import { findMatchingWorkout, type ExternalActivity } from './matching';
import { calculateITrimpFromSummary } from './trimp';
import type { Workout, Week, GarminActual, GarminPendingItem, UnspentLoadItem } from '@/types';
import { log } from '@/ui/renderer';
import { TL_PER_MIN, IMPACT_PER_KM } from '@/constants';

/** Row shape returned by the sync-activities Edge Function */
export interface GarminActivityRow {
  garmin_id: string;
  activity_type: string;       // 'RUNNING', 'TREADMILL_RUNNING', 'STRENGTH_TRAINING', etc.
  start_time: string;          // ISO timestamp
  duration_sec: number;
  distance_m: number | null;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  calories: number | null;
  aerobic_effect: number | null;
  anaerobic_effect: number | null;
  garmin_rpe?: number | null;
  garmin_feeling?: string | null;
  iTrimp?: number | null;
  hrZones?: { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
}

/** Map Garmin activity type to app activity type */
function mapGarminType(garminType: string): ExternalActivity['type'] {
  switch (garminType) {
    // Running
    case 'RUNNING':
    case 'TREADMILL_RUNNING':
    case 'TRAIL_RUNNING':
    case 'VIRTUAL_RUN':
    case 'TRACK_RUNNING':
      return 'run';

    // Gym / strength — these match planned gym sessions
    case 'STRENGTH_TRAINING':
    case 'HIIT':
      return 'gym';

    // Generic fitness / sports / recreation — logged as cross-training, no gym-session matching
    case 'INDOOR_CARDIO':
    case 'FITNESS_EQUIPMENT':
    case 'CARDIO':
    case 'AEROBIC_TRAINING':
    case 'FUNCTIONAL_TRAINING':
    case 'CROSS_TRAINING':
    case 'YOGA':
    case 'PILATES':
    case 'AEROBICS':
    case 'DANCE':
    case 'BOULDERING':
    case 'INDOOR_CLIMBING':
    case 'ROCK_CLIMBING':
    case 'TENNIS':
    case 'TENNIS_V2':
    case 'RACKET_SPORTS':
    case 'SQUASH':
    case 'BADMINTON':
    case 'PICKLEBALL':
    case 'BOXING':
    case 'MARTIAL_ARTS':
    case 'BASKETBALL':
    case 'SOCCER':
    case 'VOLLEYBALL':
    case 'SOFTBALL':
    case 'CRICKET':
    case 'RUGBY':
    case 'FOOTBALL':
      return 'other';

    // Cycling
    case 'CYCLING':
    case 'INDOOR_CYCLING':
    case 'VIRTUAL_RIDE':
    case 'E_BIKE_FITNESS':
    case 'MOUNTAIN_BIKING':
      return 'ride';

    // Swimming
    case 'SWIMMING':
    case 'OPEN_WATER_SWIMMING':
    case 'LAP_SWIMMING':
      return 'swim';

    // Walking / low-intensity locomotion
    case 'WALKING':
    case 'HIKING':
    case 'WHEELCHAIR_PUSH_WALK':
    case 'WHEELCHAIR_PUSH_RUN':
    case 'PADDLEBOARDING':
    case 'ROWING':
    case 'KAYAKING':
    case 'CANOE_KAYAK':
    case 'GOLF':
      return 'walk';

    default:
      return 'other';
  }
}

/** Get day of week (0=Mon, 6=Sun) from a date */
function dayOfWeekFromDate(date: Date): number {
  const jsDay = date.getDay(); // 0=Sun, 6=Sat
  return jsDay === 0 ? 6 : jsDay - 1; // Convert to 0=Mon, 6=Sun
}

/**
 * Derive RPE from available data (priority chain).
 *
 * 1. Garmin RPE (from activityDetails enrichment — most accurate)
 * 2. HR zone mapping using Karvonen (requires HR profile; estimates max from age if needed)
 * 3. Garmin Training Effect aerobic value (0-5 scale → RPE)
 * 4. Activity type heuristic (walks are easy, strength is moderate)
 * 5. Default mid-range RPE
 */
export function deriveRPE(
  row: GarminActivityRow,
  plannedRPE: number,
  maxHR?: number,
  restingHR?: number,
  age?: number,
): number {
  // 1. Garmin RPE — use directly if available and in valid range
  if (row.garmin_rpe != null && row.garmin_rpe >= 1 && row.garmin_rpe <= 10) {
    return row.garmin_rpe;
  }

  // 2. HR zone mapping — estimate maxHR from age if not manually configured
  if (row.avg_hr != null) {
    const estimatedMax = maxHR || (age ? Math.round(220 - age) : null);
    const estimatedResting = restingHR || 55; // Conservative default
    if (estimatedMax && estimatedMax > estimatedResting + 20) {
      const hrReserve = estimatedMax - estimatedResting;
      const intensity = (row.avg_hr - estimatedResting) / hrReserve;
      if (intensity >= 0) {
        let rpe: number;
        if (intensity < 0.5) rpe = 3;        // Zone 1 (recovery)
        else if (intensity < 0.65) rpe = 4;  // Zone 2 (easy aerobic)
        else if (intensity < 0.75) rpe = 5;  // Zone 2-3 boundary
        else if (intensity < 0.82) rpe = 6;  // Zone 3 (tempo)
        else if (intensity < 0.89) rpe = 8;  // Zone 4 (threshold)
        else rpe = 9;                         // Zone 5 (VO2max+)
        return Math.max(1, Math.min(10, rpe));
      }
    }
  }

  // 3. Garmin Training Effect aerobic value as intensity proxy
  // TE scale: 0-1=none, 1-2=recovery, 2-3=maintaining, 3-4=improving, 4-5=highly improving
  if (row.aerobic_effect != null && row.aerobic_effect > 0) {
    const te = row.aerobic_effect;
    if (te < 1.5) return 3;
    if (te < 2.5) return 4;
    if (te < 3.2) return 5;
    if (te < 3.8) return 6;
    if (te < 4.5) return 8;
    return 9;
  }

  // 4. Activity type heuristic
  const type = row.activity_type;
  if (type === 'WALKING') return 3;
  if (type === 'HIKING') return 4;
  if (type === 'STRENGTH_TRAINING' || type === 'INDOOR_CARDIO') return 6;
  if (type === 'INDOOR_CYCLING') return 6;

  // 5. Default: use planned RPE or sensible default
  return Math.max(1, Math.min(10, plannedRPE || 5));
}

/**
 * Regenerate a specific week's workouts using the same sequence as renderer.ts
 * to get stable workout IDs for matching.
 *
 * @param weekIdx  1-based week index to generate for (may differ from s.w for historic weeks)
 */
function regenerateWeekWorkouts(s: ReturnType<typeof getMutableState>, wk: Week, weekIdx: number): Workout[] {
  // Compute currentVDOT at the given week (same as renderer)
  let wg = 0;
  for (let i = 0; i < weekIdx - 1; i++) {
    wg += s.wks[i].wkGain;
  }
  const currentVDOT = s.v + wg + s.rpeAdj + (s.physioAdj || 0);

  const previousSkips = weekIdx > 1 ? s.wks[weekIdx - 2].skip : [];
  const injuryState = (s as any).injuryState || null;

  // getTrailingEffortScore equivalent
  let trailingEffort = 0;
  const lookback = Math.min(3, weekIdx - 1);
  if (lookback > 0) {
    let total = 0;
    let count = 0;
    for (let i = weekIdx - 2; i >= weekIdx - 1 - lookback && i >= 0; i--) {
      if (s.wks[i].effortScore != null) {
        total += s.wks[i].effortScore!;
        count++;
      }
    }
    if (count > 0) trailingEffort = total / count;
  }

  let wos = generateWeekWorkouts(
    wk.ph,
    s.rw,
    s.rd,
    s.typ,
    previousSkips,
    s.commuteConfig,
    injuryState,
    s.recurringActivities,
    s.onboarding?.experienceLevel,
    (s.maxHR || s.restingHR || s.onboarding?.age)
      ? { lthr: undefined, maxHR: s.maxHR, restingHR: s.restingHR, age: s.onboarding?.age }
      : undefined,
    gp(currentVDOT, s.lt).e,
    weekIdx,
    s.tw,
    currentVDOT,
    s.gs,
    trailingEffort,
  );

  // Apply stored mods (before rename, same as renderer)
  if (wk.workoutMods && wk.workoutMods.length > 0) {
    for (const mod of wk.workoutMods) {
      const workout = wos.find(w => w.n === mod.name && (mod.dayOfWeek == null || w.dayOfWeek === mod.dayOfWeek));
      if (workout) {
        workout.status = mod.status as any;
        workout.modReason = mod.modReason;
        workout.confidence = mod.confidence as any;
        if (mod.status === 'reduced' || mod.status === 'replaced') {
          workout.originalDistance = mod.originalDistance;
          workout.d = mod.newDistance;
          if (mod.newType) workout.t = mod.newType;
          if (mod.newRpe != null) {
            workout.rpe = mod.newRpe;
            workout.r = mod.newRpe;
          }
          const newLoads = calculateWorkoutLoad(workout.t, workout.d, (workout.rpe || workout.r || 5) * 10);
          workout.aerobic = newLoads.aerobic;
          workout.anaerobic = newLoads.anaerobic;
        }
      }
    }
  }

  // Deduplicate names (same as renderer)
  const nameCounts: Record<string, number> = {};
  for (const w of wos) {
    nameCounts[w.n] = (nameCounts[w.n] || 0) + 1;
  }
  const nameIdx: Record<string, number> = {};
  for (const w of wos) {
    if (nameCounts[w.n] > 1) {
      nameIdx[w.n] = (nameIdx[w.n] || 0) + 1;
      if (!w.id) w.id = `${w.n} ${nameIdx[w.n]}`;
      w.n = `${w.n} ${nameIdx[w.n]}`;
    }
  }

  return wos;
}

/**
 * Determine which 1-based plan week index a given date falls in.
 * Returns null if the date is before the plan start or beyond the plan length.
 */
function weekIndexForDate(date: Date, s: ReturnType<typeof getMutableState>): number | null {
  if (!s.planStartDate) return null;
  const planStart = new Date(s.planStartDate);
  // Compare at day granularity in UTC to avoid timezone drift
  const planStartDay = Date.UTC(planStart.getUTCFullYear(), planStart.getUTCMonth(), planStart.getUTCDate());
  const actDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const daysDiff = Math.floor((actDay - planStartDay) / (1000 * 60 * 60 * 24));
  if (daysDiff < 0) return null;
  const idx = Math.floor(daysDiff / 7) + 1;
  if (idx < 1 || idx > s.wks.length) return null;
  return idx;
}

/**
 * Resolve iTRIMP for a Garmin activity row.
 * Uses the Strava-computed value when available (Tier 1/2); otherwise falls back
 * to the summary estimate from avg_hr + duration (Tier 3 — Banister formula).
 * Returns null when there is insufficient HR data to compute anything meaningful.
 */
function resolveITrimp(
  row: GarminActivityRow,
  restingHR: number | null | undefined,
  maxHR: number | null | undefined,
  biologicalSex: string | null | undefined,
): number | null {
  if (row.iTrimp != null) return row.iTrimp;
  if (row.avg_hr != null && restingHR && maxHR) {
    const sex = biologicalSex === 'male' || biologicalSex === 'female' ? biologicalSex : undefined;
    return calculateITrimpFromSummary(row.avg_hr, row.duration_sec, restingHR, maxHR, sex);
  }
  return null;
}

/**
 * Main entry point: match Garmin activities to planned workouts and auto-complete.
 *
 * Activities are distributed to their correct plan week based on planStartDate,
 * so a Feb-17 run correctly lands in week 3 even when the current week is week 4.
 *
 * - Current-week RUNS: Auto-completed with high-confidence matches (silent); else queued for review.
 * - Current-week CROSS-TRAINING: Queued in wk.garminPending for user decision via Activity Review.
 * - Past-week RUNS: Auto-matched where possible; unmatched → logged as adhoc in that week.
 * - Past-week CROSS-TRAINING: Logged as adhoc in that week (modal review not meaningful for done weeks).
 *
 * Returns { changed, pending } where pending is new current-week cross-training items.
 */
export function matchAndAutoComplete(rows: GarminActivityRow[]): {
  changed: boolean;
  pending: GarminPendingItem[];
} {
  const s = getMutableState();
  if (!s.wks || s.wks.length === 0) return { changed: false, pending: [] };

  // Build a global set of garmin IDs already processed in ANY week.
  // This prevents activities from a previous week reappearing after the week advances,
  // because only the current week's garminMatched was checked before.
  const globalProcessed = new Set<string>();
  for (const week of s.wks) {
    if (week.garminMatched) {
      for (const id of Object.keys(week.garminMatched)) {
        globalProcessed.add(id);
      }
    }
  }

  // Filter out already-processed activities (across all weeks)
  const newRows = rows.filter(r => !globalProcessed.has(r.garmin_id));
  if (newRows.length === 0) return { changed: false, pending: [] };

  // Group unprocessed activities by their correct plan week.
  // Activities outside the plan date range are skipped.
  const rowsByWeek = new Map<number, GarminActivityRow[]>();
  for (const row of newRows) {
    const weekIdx = weekIndexForDate(new Date(row.start_time), s);
    if (weekIdx === null) {
      console.log(`[ActivityMatcher] ${row.garmin_id} (${row.start_time}) outside plan range — skipping`);
      continue;
    }
    if (!rowsByWeek.has(weekIdx)) rowsByWeek.set(weekIdx, []);
    rowsByWeek.get(weekIdx)!.push(row);
  }
  if (rowsByWeek.size === 0) return { changed: false, pending: [] };

  const allPending: GarminPendingItem[] = [];
  let changed = false;

  for (const [weekIdx, weekRows] of rowsByWeek) {
    const wk = s.wks[weekIdx - 1];
    if (!wk) continue;

    // Initialize week state fields
    if (!wk.garminMatched) wk.garminMatched = {};
    if (!wk.rated) wk.rated = {};
    if (!wk.garminPending) wk.garminPending = [];

    const isPastWeek = weekIdx < s.w;

    // Migration: clear stale cross-training adhoc entries in this week that were
    // auto-logged before the slot engine existed. Only applies to current week
    // (past weeks' adhocs are intentionally direct-logged and should stay).
    if (!isPastWeek && wk.adhocWorkouts) {
      const rowIds = new Set(rows.map(r => r.garmin_id));
      const stale = wk.adhocWorkouts.filter(w => {
        if (!w.id?.startsWith('garmin-')) return false;
        if (w.t === 'easy') return false;
        const rawId = w.id.slice('garmin-'.length);
        const matched = wk.garminMatched?.[rawId];
        if (matched && matched !== '__pending__') return false;
        return rowIds.has(rawId) && mapGarminType(rows.find(r => r.garmin_id === rawId)?.activity_type ?? '') !== 'run';
      });
      for (const adhoc of stale) {
        const rawId = adhoc.id!.slice('garmin-'.length);
        wk.adhocWorkouts = wk.adhocWorkouts!.filter(w => w.id !== adhoc.id);
        delete wk.rated[adhoc.id!];
        delete wk.garminMatched![rawId];
        console.log(`[ActivityMatcher] Migration: cleared stale adhoc cross-training ${rawId} for slot reprocessing`);
      }
    }

    // Regenerate workouts for this specific week (uses weekIdx for correct VDOT / phase)
    const weekWorkouts = regenerateWeekWorkouts(s, wk, weekIdx);
    const unratedWorkouts = weekWorkouts.filter(w => {
      const key = w.id || w.n;
      return wk.rated![key] === undefined;
    });

    const plannedRunWorkouts = weekWorkouts.filter(
      w => w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest' && w.t !== 'gym'
    );
    const maxRunAutoCompletions = plannedRunWorkouts.length;
    let runAutoCompletions = 0;

    for (const row of weekRows) {
      const appType = mapGarminType(row.activity_type);

      if (appType !== 'run') {
        if (isPastWeek) {
          // Past week: log cross-training as adhoc directly — the plan for that week
          // is already done, so no point queuing for modal review.
          const id = `garmin-${row.garmin_id}`;
          const rpe = deriveRPE(row, 5, s.maxHR, s.restingHR, s.onboarding?.age);
          addAdhocWorkout(wk, row, appType === 'gym' ? 'gym' : 'cross', id, rpe);
          wk.garminMatched![row.garmin_id] = id;
          changed = true;
          console.log(`[ActivityMatcher] Past week ${weekIdx}: logged ${row.activity_type} as adhoc`);
        } else {
          // Current week: queue for user review via Activity Review screen
          const item: GarminPendingItem = {
            garminId: row.garmin_id,
            activityType: row.activity_type,
            appType,
            startTime: row.start_time,
            durationSec: row.duration_sec,
            distanceM: row.distance_m ?? null,
            avgHR: row.avg_hr ?? null,
            maxHR: row.max_hr ?? null,
            aerobicEffect: row.aerobic_effect ?? null,
            anaerobicEffect: row.anaerobic_effect ?? null,
            garminRpe: row.garmin_rpe ?? null,
            calories: row.calories ?? null,
            iTrimp: resolveITrimp(row, s.restingHR, s.maxHR, s.biologicalSex),
            hrZones: row.hrZones ?? null,
          };
          if (!wk.garminPending!.some(p => p.garminId === row.garmin_id)) {
            wk.garminPending!.push(item);
          }
          wk.garminMatched![row.garmin_id] = '__pending__';
          allPending.push(item);
          changed = true;
          console.log(`[ActivityMatcher] Queued ${row.activity_type} (${row.garmin_id}) for user decision`);
        }
        continue;
      }

      // Running activities: try to match against planned workouts
      const activity: ExternalActivity = {
        type: appType,
        distanceKm: (row.distance_m ?? 0) / 1000,
        durationMin: row.duration_sec / 60,
        dayOfWeek: dayOfWeekFromDate(new Date(row.start_time)),
        avgPaceSecPerKm: row.avg_pace_sec_km ?? undefined,
        avgHR: row.avg_hr ?? undefined,
      };

      const match = findMatchingWorkout(activity, unratedWorkouts);

      if (match && match.confidence === 'high' && runAutoCompletions < maxRunAutoCompletions) {
        runAutoCompletions++;
        const rpe = deriveRPE(row, match.matchedWorkout.rpe || match.matchedWorkout.r || 5, s.maxHR, s.restingHR, s.onboarding?.age);
        wk.rated![match.workoutId] = rpe;
        wk.garminMatched![row.garmin_id] = match.workoutId;

        if (!wk.garminActuals) wk.garminActuals = {};
        const actual: GarminActual = {
          garminId: row.garmin_id,
          startTime: row.start_time,
          distanceKm: (row.distance_m ?? 0) / 1000,
          durationSec: row.duration_sec,
          avgPaceSecKm: row.avg_pace_sec_km ?? null,
          avgHR: row.avg_hr ?? null,
          maxHR: row.max_hr ?? null,
          calories: row.calories ?? null,
          aerobicEffect: row.aerobic_effect ?? null,
          anaerobicEffect: row.anaerobic_effect ?? null,
          workoutName: match.workoutName || match.matchedWorkout?.n || undefined,
          iTrimp: resolveITrimp(row, s.restingHR, s.maxHR, s.biologicalSex),
          hrZones: row.hrZones ?? null,
        };
        wk.garminActuals[match.workoutId] = actual;

        // Compute TSS-calibrated Training Load for this matched run
        const runITrimp = resolveITrimp(row, s.restingHR, s.maxHR, s.biologicalSex);
        const runTL = (runITrimp != null && runITrimp > 0)
          ? (runITrimp * 100) / 15000
          : (actual.durationSec / 60) * (TL_PER_MIN[Math.round(rpe)] ?? 0.92);
        wk.actualTSS = (wk.actualTSS ?? 0) + runTL;

        // Musculoskeletal impact load (km-based for running)
        const runImpact = actual.distanceKm * (IMPACT_PER_KM[match.matchedWorkout.t] ?? 1.0);
        wk.actualImpactLoad = (wk.actualImpactLoad ?? 0) + runImpact;

        // Keep extraRunLoad for backward compat
        if (row.aerobic_effect != null) {
          wk.extraRunLoad = (wk.extraRunLoad || 0) + row.aerobic_effect;
        }

        // Surplus run: actual distance >30% over planned → create unspent load item
        const plannedKmMatch = (match.matchedWorkout.d || '').match(/(\d+\.?\d*)km/);
        const plannedKm = plannedKmMatch ? parseFloat(plannedKmMatch[1]) : 0;
        const actualDistKm = (row.distance_m ?? 0) / 1000;
        if (plannedKm > 0 && actualDistKm > plannedKm * 1.3) {
          const surplusKm = actualDistKm - plannedKm;
          const surplusLoads = calculateWorkoutLoad(
            match.matchedWorkout.t,
            surplusKm,
            rpe * 10,
            s.pac?.e,
          );
          const surplusItem: UnspentLoadItem = {
            garminId: row.garmin_id + '_surplus',
            displayName: `${match.matchedWorkout.n} +${surplusKm.toFixed(1)}km surplus`,
            sport: 'extra_run',
            durationMin: (surplusKm / actualDistKm) * (row.duration_sec / 60),
            aerobic: surplusLoads.aerobic,
            anaerobic: surplusLoads.anaerobic,
            date: row.start_time,
            reason: 'surplus_run',
          };
          wk.unspentLoadItems = [...(wk.unspentLoadItems ?? []), surplusItem];
          wk.unspentLoad = (wk.unspentLoad || 0) + surplusLoads.aerobic + surplusLoads.anaerobic;
          console.log(`[ActivityMatcher] Surplus run +${surplusKm.toFixed(1)}km → unspentLoad item (aero ${surplusLoads.aerobic}, anaero ${surplusLoads.anaerobic})`);
        }

        const idx = unratedWorkouts.findIndex(w => (w.id || w.n) === match.workoutId);
        if (idx >= 0) unratedWorkouts.splice(idx, 1);

        // Also store in garminPending so openActivityReReview() can find and un-rate this run.
        // garminMatched stays as workoutId (not '__pending__'), so it won't trigger the review.
        const pendingItem: GarminPendingItem = {
          garminId: row.garmin_id,
          activityType: row.activity_type,
          appType: 'run',
          startTime: row.start_time,
          durationSec: row.duration_sec,
          distanceM: row.distance_m ?? null,
          avgHR: row.avg_hr ?? null,
          maxHR: row.max_hr ?? null,
          aerobicEffect: row.aerobic_effect ?? null,
          anaerobicEffect: row.anaerobic_effect ?? null,
          garminRpe: row.garmin_rpe ?? null,
          calories: row.calories ?? null,
          iTrimp: resolveITrimp(row, s.restingHR, s.maxHR, s.biologicalSex),
          hrZones: row.hrZones ?? null,
        };
        if (!wk.garminPending!.some(p => p.garminId === row.garmin_id)) {
          wk.garminPending!.push(pendingItem);
        }

        changed = true;
        const distKm = ((row.distance_m ?? 0) / 1000).toFixed(1);
        log(`Garmin run: ${distKm}km, RPE ${rpe} → matched "${match.workoutName}" (week ${weekIdx})`);
        console.log(`[ActivityMatcher] Auto-completed "${match.workoutName}" week ${weekIdx} (RPE ${rpe}, ${match.reason})`);
      } else {
        if (isPastWeek) {
          // Past week unmatched run: log as adhoc (no modal for done weeks)
          const id = `garmin-${row.garmin_id}`;
          const rpe = deriveRPE(row, 5, s.maxHR, s.restingHR, s.onboarding?.age);
          addAdhocWorkout(wk, row, 'run', id, rpe);
          wk.garminMatched![row.garmin_id] = id;
          changed = true;
          const distKm2 = ((row.distance_m ?? 0) / 1000).toFixed(1);
          console.log(`[ActivityMatcher] Past week ${weekIdx}: logged unmatched run ${distKm2}km as adhoc`);
        } else {
          // Current week: queue for user review
          const item: GarminPendingItem = {
            garminId: row.garmin_id,
            activityType: row.activity_type,
            appType: 'run',
            startTime: row.start_time,
            durationSec: row.duration_sec,
            distanceM: row.distance_m ?? null,
            avgHR: row.avg_hr ?? null,
            maxHR: row.max_hr ?? null,
            aerobicEffect: row.aerobic_effect ?? null,
            anaerobicEffect: row.anaerobic_effect ?? null,
            garminRpe: row.garmin_rpe ?? null,
            calories: row.calories ?? null,
            iTrimp: resolveITrimp(row, s.restingHR, s.maxHR, s.biologicalSex),
            hrZones: row.hrZones ?? null,
          };
          if (!wk.garminPending!.some(p => p.garminId === row.garmin_id)) {
            wk.garminPending!.push(item);
          }
          wk.garminMatched![row.garmin_id] = '__pending__';
          allPending.push(item);
          changed = true;
          const distKm2 = ((row.distance_m ?? 0) / 1000).toFixed(1);
          const reason = runAutoCompletions >= maxRunAutoCompletions ? '[cap reached]' : match ? `[${match.confidence} confidence]` : '(no match)';
          console.log(`[ActivityMatcher] Queued run ${distKm2}km ${reason} for user review (week ${weekIdx})`);
        }
      }
    }
  }

  if (changed) {
    saveState();
  }

  return { changed, pending: allPending };
}

/** Format Garmin activity type for display — exported so activitySync.ts can use it */
export function formatActivityType(garminType: string): string {
  const map: Record<string, string> = {
    RUNNING: 'Run',
    TREADMILL_RUNNING: 'Treadmill Run',
    TRAIL_RUNNING: 'Trail Run',
    VIRTUAL_RUN: 'Virtual Run',
    TRACK_RUNNING: 'Track Run',
    STRENGTH_TRAINING: 'Strength',
    INDOOR_CARDIO: 'Indoor Cardio',
    HIIT: 'HIIT',
    FITNESS_EQUIPMENT: 'Fitness',
    CARDIO: 'Cardio',
    CROSS_TRAINING: 'Cross Training',
    WORKOUT: 'Workout',
    YOGA: 'Yoga',
    PILATES: 'Pilates',
    BOULDERING: 'Bouldering',
    INDOOR_CLIMBING: 'Climbing',
    ROCK_CLIMBING: 'Rock Climbing',
    TENNIS: 'Tennis',
    TENNIS_V2: 'Tennis',
    RACKET_SPORTS: 'Racket Sports',
    SQUASH: 'Squash',
    BADMINTON: 'Badminton',
    PICKLEBALL: 'Pickleball',
    BOXING: 'Boxing',
    KICKBOXING: 'Kickboxing',
    MARTIAL_ARTS: 'Martial Arts',
    ELLIPTICAL: 'Elliptical',
    STAIRSTEPPER: 'Stair Stepper',
    BASKETBALL: 'Basketball',
    SOCCER: 'Soccer',
    VOLLEYBALL: 'Volleyball',
    DANCE: 'Dance',
    CYCLING: 'Cycling',
    INDOOR_CYCLING: 'Indoor Cycling',
    VIRTUAL_RIDE: 'Virtual Ride',
    MOUNTAIN_BIKING: 'Mountain Bike',
    SWIMMING: 'Swimming',
    OPEN_WATER_SWIMMING: 'Open Water Swim',
    LAP_SWIMMING: 'Lap Swim',
    WALKING: 'Walk',
    HIKING: 'Hike',
    WHEELCHAIR_PUSH_RUN: 'Wheelchair Run',
    WHEELCHAIR_PUSH_WALK: 'Wheelchair Walk',
    PADDLEBOARDING: 'Paddleboard',
    ROWING: 'Rowing',
    KAYAKING: 'Kayaking',
    GOLF: 'Golf',
  };
  return map[garminType] || garminType.replace(/_/g, ' ').toLowerCase();
}

/** Map app activity type to a sport string recognised by the cross-training engine */
export function mapAppTypeToSport(appType: string): string {
  switch (appType) {
    case 'gym': return 'gym';
    case 'ride': return 'cycling';
    case 'swim': return 'swimming';
    case 'walk': return 'walking';
    case 'other': return 'generic_sport';
    default: return appType;
  }
}

// applyGarminCrossTraining() was removed — cross-training processing is now in
// activitySync.ts with user-facing modals. See processPendingCrossTraining().

/** Add a Garmin activity as an ad-hoc workout visible in the Garmin section */
function addAdhocWorkout(wk: Week, row: GarminActivityRow, appType: string, id: string, rpe: number): void {
  if (!wk.adhocWorkouts) wk.adhocWorkouts = [];

  const distKm = (row.distance_m ?? 0) / 1000;
  const durationMin = Math.round(row.duration_sec / 60);

  // Include date in the description so users can see when each activity happened
  const startDate = new Date(row.start_time);
  const dateStr = startDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const timeStr = startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const distPart = distKm > 0.1 ? `${distKm.toFixed(1)}km in ` : '';
  const description = `${distPart}${durationMin}min · ${dateStr} ${timeStr}`;

  const workout: Workout = {
    id,
    t: appType === 'run' ? 'easy' : appType === 'gym' ? 'gym' : 'cross',
    n: formatActivityType(row.activity_type),
    d: description,
    r: rpe,
    rpe,
  };

  // Store structured data for unified display in renderGarminSyncedSection
  (workout as any).garminTimestamp = row.start_time;
  (workout as any).garminDistKm = distKm;
  (workout as any).garminDurationMin = durationMin;
  (workout as any).garminAvgHR = row.avg_hr ?? null;
  (workout as any).garminCalories = row.calories ?? null;
  (workout as any).garminAvgPace = row.avg_pace_sec_km ?? null;

  wk.adhocWorkouts.push(workout);
}

/**
 * Add an ad-hoc Garmin workout from a GarminPendingItem.
 * Called by activitySync after the user decides 'keep' in the suggestion modal.
 */
export function addAdhocWorkoutFromPending(wk: Week, item: GarminPendingItem, id: string, rpe: number): void {
  if (!wk.adhocWorkouts) wk.adhocWorkouts = [];
  // Avoid duplicates
  if (wk.adhocWorkouts.some(w => w.id === id)) return;

  const distKm = (item.distanceM ?? 0) / 1000;
  const durationMin = Math.round(item.durationSec / 60);

  const startDate = new Date(item.startTime);
  const dateStr = startDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const timeStr = startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const distPart = distKm > 0.1 ? `${distKm.toFixed(1)}km in ` : '';
  const description = `${distPart}${durationMin}min · ${dateStr} ${timeStr}`;

  const workout: Workout = {
    id,
    t: item.appType === 'gym' ? 'gym' : 'cross',
    n: formatActivityType(item.activityType),
    d: description,
    r: rpe,
    rpe,
    aerobic: item.aerobicEffect ?? undefined,
    anaerobic: item.anaerobicEffect ?? undefined,
  };

  (workout as any).garminTimestamp = item.startTime;
  (workout as any).garminDistKm = distKm;
  (workout as any).garminDurationMin = durationMin;
  (workout as any).garminAvgHR = item.avgHR ?? null;
  (workout as any).garminCalories = item.calories ?? null;
  (workout as any).garminAvgPace = null; // pending items don't have avg pace
  wk.adhocWorkouts.push(workout);
}

