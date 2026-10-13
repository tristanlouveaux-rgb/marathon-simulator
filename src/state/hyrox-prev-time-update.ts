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
} from '@/constants/hyrox-constants';
import type { AbilityBand, HyroxConfig, HyroxStation } from '@/types/triathlon';
import { generateHyroxPlan } from '@/workouts/plan_engine.hyrox';
import { archiveCurrentWksIfPopulated, redistributeArchivedActivitiesToNewPlan } from '@/state/initialization';
import { refreshHyroxPersonalRunPaceOffset } from '@/calculations/hyrox-run-pace';
import { getHyroxEventById } from '@/data/hyrox-events';
import { hyroxBandingTimeSec } from '@/calculations/hyrox-doubles';
import { upsertRaceSplitEntry } from '@/calculations/hyrox-station-history';
import { isHyroxProFormat } from '@/calculations/hyrox-division';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { localDateKey } from '@/utils/local-date';

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
    // One history entry per split, source 'race', with the race's format and
    // weights, so the entry describes the slot value it wrote. Without it a
    // doubles race split logged after a half test read as a solo time and was
    // scaled by the doubles ratio a second time (review 2026-10-12: 300 s
    // became 212.8 s). The entry's proWeights also keeps a Pro race split from
    // getting the Pro multiplier on top, without touching
    // benchmarksAtProWeights, which describes station tests.
    // Re-logging the same race (same date and format) replaces its earlier
    // entries (upsertRaceSplitEntry) rather than duplicating them.
    const raceDateISO = hx.hyroxPreviousRaceDate ?? localDateKey(new Date());
    hx.stationBenchmarkHistory = hx.stationBenchmarkHistory ?? {};
    for (const st of HYROX_STATION_ORDER) {
      const sec = update.stationSplits[st];
      if (sec == null) continue;
      hx.stationBenchmarkHistory[st] = upsertRaceSplitEntry(hx.stationBenchmarkHistory[st], {
        dateISO: raceDateISO,
        sec,
        source: 'race',
        format: update.format,
        proWeights: isHyroxProFormat(update.format),
      });
    }
  }

  const targetIsDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  // Band on the previous time in singles terms (hyroxBandingTimeSec), the
  // same rule as onboarding.
  const newBand = bandFromTime(hyroxBandingTimeSec(update.timeSec, update.format, hx.format));
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
