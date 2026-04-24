/**
 * Triathlon initialization path.
 *
 * Called from `initializeSimulator` when `state.trainingMode === 'triathlon'`.
 * Keeps triathlon setup off the running-init critical path so that running
 * users are untouched.
 *
 * Phase 1 STATUS: sets up minimal triConfig skeleton + empty plan.
 * Phase 2 will fill in benchmarks from the wizard. Phase 3 populates the
 * week array by calling `generateTriathlonPlan`.
 */

import type { OnboardingState } from '@/types/onboarding';
import type { CalculationResult } from './initialization';
import type { TriConfig } from '@/types/triathlon';
import { STATE_SCHEMA_VERSION } from '@/types/state';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { generateTriathlonPlan, TRI_GENERATOR_VERSION } from '@/workouts/plan_engine.triathlon';
import {
  DEFAULT_VOLUME_SPLIT,
  PLAN_WEEKS_DEFAULT,
  DEFAULT_WEEKLY_PEAK_HOURS,
} from '@/constants/triathlon-constants';
import { deriveTriBenchmarksFromHistory } from '@/calculations/tri-benchmarks-from-history';
import type { GarminActual } from '@/types/state';

/**
 * Initialize the store for triathlon mode.
 * Mirrors the running initialisation as closely as possible so shared UI
 * (home load bar, readiness, stats) continues to work.
 */
export function initializeTriathlonSimulator(state: OnboardingState): CalculationResult {
  try {
    const s = getMutableState();

    const distance = state.triDistance ?? '70.3';
    const weeks = state.planDurationWeeks || PLAN_WEEKS_DEFAULT[distance];
    const skillRating = state.triSkillRating ?? { swim: 3, bike: 3, run: 3 };

    // Seed time-available from wizard, falling back to skill-based default.
    const avgSkill = Math.round((skillRating.swim + skillRating.bike + skillRating.run) / 3) as 1 | 2 | 3 | 4 | 5;
    const timeAvailable = state.triTimeAvailableHoursPerWeek
      ?? DEFAULT_WEEKLY_PEAK_HOURS[distance][avgSkill];

    const volumeSplit = state.triVolumeSplit ?? { ...DEFAULT_VOLUME_SPLIT };

    const weekdayHours = state.triWeekdayHoursPerWeek ?? Math.round(timeAvailable * 0.4 * 2) / 2;

    // Derive starting benchmarks from the in-memory activity log (what's
    // currently in state.wks). For a running-mode user switching to tri,
    // this has their history. For a fresh install it's empty and the
    // benchmarks come from main.ts's DB-backed refresh on next load.
    // We don't await a DB query here because initialization is sync.
    const activityLog = collectActivityLog(s);
    const derived = deriveTriBenchmarksFromHistory(activityLog);

    // Merge user-entered benchmarks with history-derived ones. User input
    // always wins — derivation only fills in fields the user left blank.
    const bike = { ...(state.triBike ?? {}) };
    if (!bike.ftp && derived.ftp.ftpWatts) {
      bike.ftp = derived.ftp.ftpWatts;
      bike.hasPowerMeter = bike.hasPowerMeter ?? true;
    }
    const swim = { ...(state.triSwim ?? {}) };
    if (!swim.cssSecPer100m && derived.css.cssSecPer100m) {
      swim.cssSecPer100m = derived.css.cssSecPer100m;
    }

    const triConfig: TriConfig = {
      distance,
      timeAvailableHoursPerWeek: timeAvailable,
      weekdayHoursPerWeek: weekdayHours,
      volumeSplit,
      skillRating,
      bike,
      swim,
      raceDate: state.customRaceDate ?? undefined,
      weeksToRace: weeks,
      fitness: {
        swim: derived.fitness.swim,
        bike: derived.fitness.bike,
        run:  derived.fitness.run,
        combinedCtl: derived.fitness.combinedCtl,
      },
      generatorVersion: TRI_GENERATOR_VERSION,
    };

    // Log a summary of what we derived so it's visible in console for debugging.
    if (derived.css.cssSecPer100m || derived.ftp.ftpWatts || derived.fitness.activityCount > 0) {
      console.log('[tri init] derived from history:',
        `CSS ${derived.css.cssSecPer100m ? `${derived.css.cssSecPer100m}s/100m (from ${derived.css.swimActivityCount} swims)` : '—'}`,
        `FTP ${derived.ftp.ftpWatts ? `${derived.ftp.ftpWatts}W (from ${derived.ftp.bikeActivityCount} rides)` : '— (no power data)'}`,
        `CTL swim ${derived.fitness.swim.ctl} / bike ${derived.fitness.bike.ctl} / run ${derived.fitness.run.ctl} (from ${derived.fitness.activityCount} activities)`,
      );
    }

    // Plan-level state — keep shape compatible with running state so shared UI
    // consumers don't crash. Race distance is set to 'marathon' as a harmless
    // placeholder; triathlon views ignore it and read triConfig.distance
    // instead. (Using 'marathon' avoids widening the RaceDistance type.)
    s.eventType = 'triathlon';
    s.triConfig = triConfig;
    s.trackOnly = false;
    s.continuousMode = false;
    s.w = 1;
    s.tw = weeks;
    s.rd = 'marathon';  // Placeholder — triathlon views read triConfig.distance
    s.rw = 3;            // Runs per week — refined by plan engine in Phase 3
    s.epw = 9;           // Placeholder total sessions (3 swim + 3 bike + 3 run)
    s.gs = state.gymSessionsPerWeek || 0;
    s.wkm = 0;           // Triathlon uses hours, not km. Shared stats views must be guarded.
    s.pbs = state.pbs || {};
    s.rec = state.recentRace ?? null;
    s.schemaVersion = STATE_SCHEMA_VERSION;

    // Clear running-mode race selection so tri views don't show stale
    // marathon-mode race data (title, countdown caption).
    s.selectedMarathon = undefined;

    // Plan generation — replaces any previously-stored running weeks.
    s.wks = generateTriathlonPlan(s);

    // Seed prediction caches. Phase 4 computes real values.
    s.initialBaseline = null;
    s.currentFitness = null;
    s.forecastTime = null;

    saveState();
    return { success: true };
  } catch (err) {
    console.error('[triathlon init] failed', err);
    return { success: false, error: 'Triathlon initialization failed' };
  }
}

/**
 * Flatten every synced activity off state into a single list. Walks both
 * `garminActuals` (matched) and `garminPending` (unmatched) across every
 * week — running-mode users who later switch to triathlon have their
 * historical bike/swim activities in `garminPending` because they never
 * matched a running workout. Both shapes get normalised to GarminActual.
 */
function collectActivityLog(s: {
  wks?: Array<{
    garminActuals?: Record<string, GarminActual>;
    garminPending?: Array<{ garminId: string; activityType: string; startTime: string; durationSec: number; distanceM: number | null; iTrimp?: number | null }>;
  }>;
}): GarminActual[] {
  const list: GarminActual[] = [];
  for (const wk of s.wks ?? []) {
    for (const id of Object.keys(wk.garminActuals ?? {})) {
      const a = (wk.garminActuals ?? {})[id];
      if (a) list.push(a);
    }
    for (const p of wk.garminPending ?? []) {
      // Normalise to GarminActual shape — only the fields derivation reads.
      list.push({
        garminId: p.garminId,
        activityType: p.activityType,
        startTime: p.startTime,
        durationSec: p.durationSec,
        distanceKm: (p.distanceM ?? 0) / 1000,
        avgPaceSecKm: null,
        avgHR: null,
        maxHR: null,
        calories: null,
        iTrimp: p.iTrimp ?? null,
      });
    }
  }
  return list;
}
