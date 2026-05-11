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
import { PAST_TRI_LEG_DISTANCES } from '@/types/onboarding';
import type { CalculationResult } from './initialization';
import { archiveCurrentWksIfPopulated, redistributeArchivedActivitiesToNewPlan } from './initialization';
import type { TriConfig } from '@/types/triathlon';
import { STATE_SCHEMA_VERSION } from '@/types/state';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { generateTriathlonPlan, TRI_GENERATOR_VERSION } from '@/workouts/plan_engine.triathlon';
import {
  DEFAULT_VOLUME_SPLIT,
  PLAN_WEEKS_DEFAULT,
  DEFAULT_WEEKLY_PEAK_HOURS,
  RUN_FATIGUE_DISCOUNT_70_3,
  RUN_FATIGUE_DISCOUNT_IRONMAN,
} from '@/constants/triathlon-constants';
import { deriveTriBenchmarksFromHistory } from '@/calculations/tri-benchmarks-from-history';
import { appendFtpSample, appendCssSample } from '@/calculations/tri-benchmark-history';
import type { GarminActual } from '@/types/state';
import { cv } from '@/calculations/vdot';

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
    const derived = deriveTriBenchmarksFromHistory(activityLog, undefined, {
      swim400Sec: state.triSwim?.pbs?.m400,
      swim200Sec: state.triSwim?.pbs?.m200,
    });

    // Derive benchmarks from a past race result entered during onboarding.
    // Only fills gaps — wizard-entered CSS/FTP still takes priority below.
    const pastRaceBench = derivePastRaceBenchmarks(state);

    // Merge user-entered benchmarks with history-derived ones. User input
    // always wins — derivation only fills in fields the user left blank.
    // Tag derived values with `*Source: 'derived'` so the launch-time refresh
    // can overwrite them when fresh data is available; user-entered values
    // (or pre-provenance ones) are preserved unconditionally.
    const bike = { ...(state.triBike ?? {}) };
    // Set source to 'user' for any user-entered FTP from the wizard. Derived
    // values get 'derived' below if they overwrite.
    if (state.triBike?.ftp) {
      bike.ftpSource = 'user';
      // Wizard-entered FTP without a 20-min test on file is medium-confidence
      // (it's an estimate the user typed). With the test, treat as 'high'.
      bike.ftpConfidence = bike.twentyMinW ? 'high' : 'medium';
    }
    if (!bike.ftp && derived.ftp.ftpWatts) {
      bike.ftp = derived.ftp.ftpWatts;
      bike.ftpSource = 'derived';
      bike.ftpConfidence = derived.ftp.confidence;
      bike.hasPowerMeter = bike.hasPowerMeter ?? true;
    }
    const swim = { ...(state.triSwim ?? {}) };
    if (state.triSwim?.cssSecPer100m) {
      swim.cssSource = 'user';
      // Wizard-entered CSS with paired m400+m200 PBs = paired-TT result = high.
      // Without the pair = medium (a single-source estimate the user typed).
      const hasPair = !!(swim.pbs?.m400 && swim.pbs?.m200);
      swim.cssConfidence = hasPair ? 'high' : 'medium';
    }
    if (!swim.cssSecPer100m && pastRaceBench.cssSecPer100m) {
      swim.cssSecPer100m = pastRaceBench.cssSecPer100m;
      swim.cssSource = 'derived';
      swim.cssConfidence = pastRaceBench.cssConfidence ?? 'medium';
      console.log(`[TriInit] CSS seeded from past race: ${swim.cssSecPer100m.toFixed(1)}s/100m`);
    }
    if (!swim.cssSecPer100m && derived.css.cssSecPer100m) {
      swim.cssSecPer100m = derived.css.cssSecPer100m;
      swim.cssSource = 'derived';
      swim.cssConfidence = derived.css.confidence;
    }

    // Seed history with whatever value we ended up with — gives the trend
    // charts on the Progress detail page a starting point for new users.
    if (bike.ftp) {
      appendFtpSample(bike, bike.ftp, bike.ftpSource ?? 'user', bike.ftpConfidence);
    }
    if (swim.cssSecPer100m) {
      appendCssSample(swim, swim.cssSecPer100m, swim.cssSource ?? 'user', swim.cssConfidence);
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
      fitnessHistory: derived.fitnessHistory.slice(-52),
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
    // Anchor the plan to this Monday so weekIndexForDate and advanceWeekToToday
    // both have a reliable reference point. Without this, persistence migration
    // derives planStartDate from s.w (which is reset to 1), producing a moving
    // anchor that shifts every time the wizard is re-entered.
    const _planMonday = new Date();
    const _dow = _planMonday.getDay();
    _planMonday.setDate(_planMonday.getDate() - (_dow === 0 ? 6 : _dow - 1));
    s.planStartDate = _planMonday.toISOString().slice(0, 10);
    // Triathlon doesn't use the running debrief gate — seed lastCompleteDebriefWeek
    // so advanceWeekToToday can advance freely without waiting for a plan-preview.
    (s as any).lastCompleteDebriefWeek = 0;
    (s as any)._debriefGateV3 = true;
    s.rd = 'marathon';  // Placeholder — triathlon views read triConfig.distance
    s.rw = 3;            // Runs per week — refined by plan engine in Phase 3
    s.epw = 9;           // Placeholder total sessions (3 swim + 3 bike + 3 run)
    s.gs = state.gymSessionsPerWeek || 0;
    s.wkm = 0;           // Triathlon uses hours, not km. Shared stats views must be guarded.
    s.pbs = state.pbs || {};
    s.rec = state.recentRace ?? null;
    s.schemaVersion = STATE_SCHEMA_VERSION;

    // Personal physiology for iTRIMP, max-HR estimates, FTP/kg tier derivation.
    if (state.biologicalSex) s.biologicalSex = state.biologicalSex;
    if (state.bodyWeightKg) s.bodyWeightKg = state.bodyWeightKg;
    s.onboarding = state;

    // Clear running-mode race selection so tri views don't show stale
    // marathon-mode race data (title, countdown caption).
    s.selectedMarathon = undefined;

    // Archive existing wks (running plan, track-only buckets, or a previous
    // triathlon plan) so daily history survives mode switches.
    archiveCurrentWksIfPopulated();
    // Plan generation — replaces any previously-stored running weeks.
    s.wks = generateTriathlonPlan(s);

    // Seed run VDOT from past race when no other signal is available.
    if (!s.v && pastRaceBench.vdot) {
      s.v = pastRaceBench.vdot;
      console.log(`[TriInit] VDOT seeded from past race run leg: ${s.v.toFixed(1)}`);
    }

    // Seed prediction caches. Phase 4 computes real values.
    s.initialBaseline = null;
    s.currentFitness = null;
    s.forecastTime = null;

    redistributeArchivedActivitiesToNewPlan();
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

/**
 * Derive CSS and run-VDOT from a past race entered during onboarding.
 *
 * Swim → CSS: race swim pace ≈ CSS for 70.3 (1.9 km) and IM (3.8 km).
 * Confidence is 'high' for those distances because the race duration
 * (25–40 min for 70.3, 55–80 min for IM) sits in the same severe-intensity
 * domain that CSS is defined for (Dekerle 2002). Sprint and Olympic swims
 * are shorter and faster than CSS — race pace alone is an overestimate of
 * CSS so we mark confidence 'medium'.
 *
 * Run → VDOT: back-calculate a "fresh equivalent" run time using the
 * published bike-to-run fatigue discounts (5% for 70.3, 11% for IM) that
 * are already used in race-time prediction. Sprint/Olympic use the 70.3
 * discount as a conservative approximation (shorter events have less
 * cumulative fatigue — the 5% is slightly pessimistic, not optimistic).
 * Confidence: 'medium' because the discount is population-average, not
 * individual-specific.
 *
 * Bike time alone cannot derive FTP without watts — left for the FTP field
 * on the triathlon-setup screen.
 */
function derivePastRaceBenchmarks(state: OnboardingState): {
  cssSecPer100m?: number;
  cssConfidence?: 'high' | 'medium' | 'low';
  vdot?: number;
} {
  const past = state.triPastRace;
  if (!past?.perLeg) return {};

  const legs = past.perLeg;
  const legDist = PAST_TRI_LEG_DISTANCES[past.distance];
  const result: { cssSecPer100m?: number; cssConfidence?: 'high' | 'medium' | 'low'; vdot?: number } = {};

  // CSS from swim leg
  if (legs.swim > 0 && legDist.swimM > 0) {
    result.cssSecPer100m = (legs.swim / legDist.swimM) * 100;
    result.cssConfidence = (past.distance === '70.3' || past.distance === 'ironman') ? 'high' : 'medium';
  }

  // VDOT from run leg (back-calculate fresh-run equivalent)
  if (legs.run > 0 && legDist.runKm > 0) {
    const discount = past.distance === 'ironman' ? RUN_FATIGUE_DISCOUNT_IRONMAN : RUN_FATIGUE_DISCOUNT_70_3;
    const freshRunSec = legs.run * (1 - discount);  // fewer seconds = faster = remove fatigue penalty
    const runDistM = legDist.runKm * 1000;
    const vdot = cv(runDistM, freshRunSec);
    if (vdot > 20 && vdot < 90) result.vdot = vdot;  // sanity guard
  }

  return result;
}
