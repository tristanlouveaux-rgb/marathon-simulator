/**
 * Cycling-only initialization path (V1).
 *
 * Called from `initializeSimulator` when `state.trainingMode === 'cycling'`.
 * Reuses the triathlon plan engine with `disciplines: ['bike']` so we get
 * the full pro-grade bike workout library, per-discipline CTL/ATL, and
 * Strava activity routing for free.
 *
 * Distance/time prediction is deferred — V1 ships training-only.
 */

import type { OnboardingState } from '@/types/onboarding';
import type { CalculationResult } from './initialization';
import { archiveCurrentWksIfPopulated, redistributeArchivedActivitiesToNewPlan } from './initialization';
import type { TriConfig } from '@/types/triathlon';
import { STATE_SCHEMA_VERSION } from '@/types/state';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { generateTriathlonPlan, TRI_GENERATOR_VERSION } from '@/workouts/plan_engine.triathlon';
import { deriveTriBenchmarksFromHistory } from '@/calculations/tri-benchmarks-from-history';
import { appendFtpSample } from '@/calculations/tri-benchmark-history';
import type { GarminActual } from '@/types/state';

// Default plan length matches cycling-setup defaults so wizard and engine agree.
type CyclingDistance = '50km' | '100km' | '160km' | '200km' | '300km';

const DEFAULT_PLAN_WEEKS_BY_DISTANCE: Record<CyclingDistance, number> = {
  '50km':  8,
  '100km': 12,
  '160km': 16,
  '200km': 20,
  '300km': 22,
};

const DEFAULT_HOURS_BY_DISTANCE: Record<CyclingDistance, number> = {
  '50km':  4,
  '100km': 6,
  '160km': 10,
  '200km': 14,
  '300km': 18,
};

export function initializeCyclingSimulator(state: OnboardingState): CalculationResult {
  try {
    const s = getMutableState();

    const cyclingDistance = state.cyclingDistance ?? '160km';
    const weeks = state.planDurationWeeks || DEFAULT_PLAN_WEEKS_BY_DISTANCE[cyclingDistance];
    const timeAvailable = state.triTimeAvailableHoursPerWeek ?? DEFAULT_HOURS_BY_DISTANCE[cyclingDistance];
    const weekdayHours = state.triWeekdayHoursPerWeek ?? Math.round(timeAvailable * 0.4 * 2) / 2;

    // Derive FTP from activity history if not user-entered. Cycling-only mode
    // skips swim/run derivation entirely — only bike paths matter.
    const activityLog = collectActivityLog(s);
    const derived = deriveTriBenchmarksFromHistory(activityLog, undefined, {});

    const bike = { ...(state.triBike ?? {}) };
    if (state.triBike?.ftp) {
      bike.ftpSource = 'user';
      bike.ftpConfidence = bike.twentyMinW ? 'high' : 'medium';
    }
    if (!bike.ftp && derived.ftp.ftpWatts) {
      bike.ftp = derived.ftp.ftpWatts;
      bike.ftpSource = 'derived';
      bike.ftpConfidence = derived.ftp.confidence;
      bike.hasPowerMeter = bike.hasPowerMeter ?? true;
    }
    if (bike.ftp) {
      appendFtpSample(bike, bike.ftp, bike.ftpSource ?? 'user', bike.ftpConfidence);
    }

    // 100% bike volume split. Plan engine reads triConfig.disciplines first
    // and skips swim/run generation entirely; the volumeSplit value is kept
    // consistent so any consumer that does its own volume math agrees.
    const triConfig: TriConfig = {
      // Distance is a placeholder. Cycling V1 stores its event distance on
      // state.cyclingDistance (via onboarding) since TriathlonDistance is a
      // tri-specific union ('70.3' | 'ironman'). Tri views key off this; for
      // cycling we route through `disciplines: ['bike']` so the placeholder
      // never feeds into swim/run leg logic.
      distance: '70.3',
      timeAvailableHoursPerWeek: timeAvailable,
      weekdayHoursPerWeek: weekdayHours,
      volumeSplit: { swim: 0, bike: 1.0, run: 0 },
      disciplines: ['bike'],
      bike,
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

    if (derived.ftp.ftpWatts || derived.fitness.activityCount > 0) {
      console.log('[cycling init] derived from history:',
        `FTP ${derived.ftp.ftpWatts ? `${derived.ftp.ftpWatts}W (from ${derived.ftp.bikeActivityCount} rides)` : '— (no power data)'}`,
        `CTL bike ${derived.fitness.bike.ctl} (from ${derived.fitness.activityCount} activities)`,
      );
    }

    // Plan-level state. We reuse `eventType: 'triathlon'` so existing tri
    // views render correctly — they're already discipline-aware and will
    // surface bike-only data when no swim/run actuals exist. The cycling
    // mode is identified upstream via state.onboarding.trainingMode.
    s.eventType = 'triathlon';
    s.triConfig = triConfig;
    s.trackOnly = false;
    s.continuousMode = false;
    s.w = 1;
    s.tw = weeks;
    const _planMonday = new Date();
    const _dow = _planMonday.getDay();
    _planMonday.setDate(_planMonday.getDate() - (_dow === 0 ? 6 : _dow - 1));
    s.planStartDate = _planMonday.toISOString().slice(0, 10);
    (s as any).lastCompleteDebriefWeek = 0;
    (s as any)._debriefGateV3 = true;
    s.rd = 'marathon';  // Placeholder — tri/cycling views ignore this.
    s.rw = 0;            // Bike-only — no run sessions.
    s.epw = 4;           // Approx weekly bike sessions (3-4 typical).
    s.gs = state.gymSessionsPerWeek || 0;
    s.wkm = 0;
    s.pbs = state.pbs || {};
    s.rec = state.recentRace ?? null;
    s.schemaVersion = STATE_SCHEMA_VERSION;

    if (state.biologicalSex) s.biologicalSex = state.biologicalSex;
    if (state.bodyWeightKg) s.bodyWeightKg = state.bodyWeightKg;
    s.onboarding = state;

    s.selectedMarathon = undefined;

    archiveCurrentWksIfPopulated();
    s.wks = generateTriathlonPlan(s);

    s.initialBaseline = null;
    s.currentFitness = null;
    s.forecastTime = null;

    redistributeArchivedActivitiesToNewPlan();
    saveState();
    return { success: true };
  } catch (err) {
    console.error('[cycling init] failed', err);
    return { success: false, error: 'Cycling initialization failed' };
  }
}

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
