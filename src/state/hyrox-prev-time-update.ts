/**
 * Apply a "Log a previous HYROX time" update to the existing hyroxConfig.
 *
 * Used post-onboarding from the forecast chip-detail "You" page when the
 * user wants to anchor the prediction against a real race result. Mirrors
 * the effect that the wizard step has on state: re-derives band, refreshes
 * the personal run-pace offset, and regenerates the plan if the band shifts.
 */

import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import {
  HYROX_TIME_TO_BAND_THRESHOLDS,
  HYROX_MTL_CAP,
  computeDoublesCap,
  SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES,
  SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES,
} from '@/constants/hyrox-constants';
import type { AbilityBand, HyroxConfig, HyroxStation } from '@/types/triathlon';
import { generateHyroxPlan } from '@/workouts/plan_engine.hyrox';
import { archiveCurrentWksIfPopulated, redistributeArchivedActivitiesToNewPlan } from '@/state/initialization';
import { refreshHyroxPersonalRunPaceOffset } from '@/calculations/hyrox-run-pace';
import { getHyroxEventById } from '@/data/hyrox-events';

type HyroxFormat = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

export interface HyroxPrevTimeUpdate {
  timeSec: number;
  format: HyroxFormat;
  raceEventId?: string;
  raceDateISO?: string;
  stationSplits?: Partial<Record<HyroxStation, number>>;
}

export interface HyroxPrevTimeUpdateResult {
  rebanded: boolean;
  planRegenerated: boolean;
}

function bandFromTime(sec: number): AbilityBand {
  for (const { maxSec, band } of HYROX_TIME_TO_BAND_THRESHOLDS) {
    if (sec < maxSec) return band;
  }
  return 'beginner';
}

export function applyHyroxPrevTimeUpdate(update: HyroxPrevTimeUpdate): HyroxPrevTimeUpdateResult {
  const s = getMutableState();
  const hx = s.hyroxConfig as HyroxConfig | undefined;
  if (!hx) return { rebanded: false, planRegenerated: false };

  const oldBand = hx.athleteBand;

  hx.previousHyroxTimeSec = update.timeSec;
  hx.hyroxPreviousTimeFormat = update.format;
  hx.hyroxPreviousTimeRaceId = update.raceEventId;
  hx.hyroxPreviousRaceDate =
    (update.raceEventId && getHyroxEventById(update.raceEventId)?.date) || update.raceDateISO;

  if (update.stationSplits && Object.keys(update.stationSplits).length > 0) {
    (hx as { hyroxPreviousStationSplits?: Partial<Record<HyroxStation, number>> }).hyroxPreviousStationSplits = {
      ...update.stationSplits,
    };
    const isPrevDoubles = update.format === 'open_doubles' || update.format === 'pro_doubles';
    if (isPrevDoubles) {
      hx.stationBenchmarksDoubles = {
        ...(hx.stationBenchmarksDoubles ?? {}),
        ...update.stationSplits,
      } as HyroxConfig['stationBenchmarksDoubles'];
    } else {
      hx.stationBenchmarksSingles = {
        ...(hx.stationBenchmarksSingles ?? {}),
        ...update.stationSplits,
      } as HyroxConfig['stationBenchmarksSingles'];
    }
  }

  const targetIsDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  const isPrevDoubles = update.format === 'open_doubles' || update.format === 'pro_doubles';
  const adjusted =
    isPrevDoubles && !targetIsDoubles
      ? Math.round(update.timeSec * SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES)
      : !isPrevDoubles && targetIsDoubles
        ? Math.round(update.timeSec * SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES)
        : update.timeSec;
  const newBand = bandFromTime(adjusted);
  const rebanded = newBand !== oldBand;
  if (rebanded) {
    hx.athleteBand = newBand;
    const baseCap = HYROX_MTL_CAP[newBand];
    hx.mtlCap = targetIsDoubles ? computeDoublesCap(baseCap) : baseCap;
  }

  hx.personalRunPaceOffsetSec = undefined;
  hx.personalRunPaceOffsetUpdatedAtISO = undefined;
  hx.personalRunPaceOffsetConfidence = undefined;
  refreshHyroxPersonalRunPaceOffset(s);

  let planRegenerated = false;
  if (rebanded) {
    archiveCurrentWksIfPopulated();
    s.wks = generateHyroxPlan(s);
    redistributeArchivedActivitiesToNewPlan();
    planRegenerated = true;
  }

  console.log(
    `[hyrox log-prev-time] band: ${oldBand} → ${hx.athleteBand}, plan regenerated: ${planRegenerated}`,
  );
  saveState();
  return { rebanded, planRegenerated };
}
