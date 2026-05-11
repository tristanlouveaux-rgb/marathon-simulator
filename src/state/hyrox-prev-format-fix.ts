/**
 * Repair path for `hyroxPreviousTimeFormat` corrections.
 *
 * Background: an earlier wizard render lit up a previous-format pill matching
 * the *target* format whenever the user hadn't picked one explicitly. Users
 * never realised the question was unanswered, so doubles previous times got
 * filed against the singles slot (and vice versa). Init then derived the
 * ability band off an unconverted time and seeded benchmarks into the wrong
 * slot, which the predictor read at full weight.
 *
 * This module exposes one function: `applyHyroxPrevFormatChange(newFormat)`.
 * It updates the format flag, moves benchmark slots when the singles/doubles
 * axis flips, rewrites format on the per-station history entries, re-derives
 * the ability band using the cross-format factor, regenerates the plan, and
 * persists. The forecast-view banner calls this when the user confirms a
 * format change in the verify-format modal.
 */

import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import {
  SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES,
  SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES,
  HYROX_TIME_TO_BAND_THRESHOLDS,
  HYROX_MTL_CAP,
  computeDoublesCap,
} from '@/constants/hyrox-constants';
import type { AbilityBand } from '@/types/triathlon';
import { generateHyroxPlan } from '@/workouts/plan_engine.hyrox';
import { archiveCurrentWksIfPopulated, redistributeArchivedActivitiesToNewPlan } from '@/state/initialization';

type HyroxFormat = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

function bandFromTime(sec: number): AbilityBand {
  for (const { maxSec, band } of HYROX_TIME_TO_BAND_THRESHOLDS) {
    if (sec < maxSec) return band;
  }
  return 'beginner';
}

export interface PrevFormatChangeResult {
  /** Whether anything changed. False when the new format equals the existing one. */
  changed: boolean;
  /** True when the singles/doubles axis flipped — benchmarks moved between slots. */
  axisFlipped: boolean;
  /** Band shifted because the cross-format factor re-banded the previous time. */
  rebanded: boolean;
}

/**
 * Apply a corrected previous-race format. Safe to call when nothing actually
 * changed — returns `changed: false` and is a no-op.
 *
 * Important: regenerates the training plan when band changes. Call sites should
 * confirm with the user before invoking if they're mid-plan; for first-week
 * users this is non-destructive because there's no completed history yet.
 */
export function applyHyroxPrevFormatChange(newFormat: HyroxFormat): PrevFormatChangeResult {
  const s = getMutableState();
  const hx = s.hyroxConfig;
  if (!hx) return { changed: false, axisFlipped: false, rebanded: false };

  const oldFormat = hx.hyroxPreviousTimeFormat;
  if (oldFormat === newFormat) {
    return { changed: false, axisFlipped: false, rebanded: false };
  }

  const wasDoubles = oldFormat === 'open_doubles' || oldFormat === 'pro_doubles';
  const isDoubles = newFormat === 'open_doubles' || newFormat === 'pro_doubles';
  const axisFlipped = oldFormat != null && wasDoubles !== isDoubles;

  hx.hyroxPreviousTimeFormat = newFormat;

  if (axisFlipped) {
    if (isDoubles) {
      // Singles → Doubles: existing Singles slot was filled with what is now
      // known to be doubles data. Move it.
      hx.stationBenchmarksDoubles = hx.stationBenchmarksSingles;
      hx.stationBenchmarksSingles = undefined;
    } else {
      hx.stationBenchmarksSingles = hx.stationBenchmarksDoubles;
      hx.stationBenchmarksDoubles = undefined;
    }
    if (hx.stationBenchmarkHistory) {
      for (const k of Object.keys(hx.stationBenchmarkHistory)) {
        const station = k as keyof typeof hx.stationBenchmarkHistory;
        const entries = hx.stationBenchmarkHistory[station];
        if (!entries) continue;
        hx.stationBenchmarkHistory[station] = entries.map(e => {
          const eWasDoubles = e.format === 'open_doubles' || e.format === 'pro_doubles';
          if (eWasDoubles === wasDoubles) {
            return { ...e, format: newFormat };
          }
          return e;
        });
      }
    }
  }

  // Re-derive the band against the cross-format factor. The previous time is
  // physiologically the same effort regardless of which slot it lives in, but
  // its banding meaning differs across formats — a 60-min doubles is a 73-min
  // singles. Apply the factor before banding when the previous race format
  // disagrees with the *target* format.
  let rebanded = false;
  const prevTimeSec = hx.previousHyroxTimeSec;
  if (prevTimeSec != null) {
    const targetIsDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
    const adjusted = isDoubles && !targetIsDoubles
      ? Math.round(prevTimeSec * SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES)
      : !isDoubles && targetIsDoubles
      ? Math.round(prevTimeSec * SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES)
      : prevTimeSec;
    const newBand = bandFromTime(adjusted);
    if (newBand !== hx.athleteBand) {
      hx.athleteBand = newBand;
      const baseCap = HYROX_MTL_CAP[newBand];
      hx.mtlCap = targetIsDoubles ? computeDoublesCap(baseCap) : baseCap;
      rebanded = true;
    }
  }

  // Regenerate the plan when band shifted — workout intensities, weekly volume,
  // and progression curve all key off the band. Archive the existing wks first
  // so completed activities aren't lost; the redistributor reattaches them by
  // date.
  if (rebanded) {
    archiveCurrentWksIfPopulated();
    s.wks = generateHyroxPlan(s);
    redistributeArchivedActivitiesToNewPlan();
  }

  console.log(
    `[hyrox prev-format fix] ${oldFormat ?? '(unset)'} → ${newFormat}`,
    `axis flipped: ${axisFlipped}, rebanded: ${rebanded}, new band: ${hx.athleteBand}`,
  );

  saveState();
  return { changed: true, axisFlipped, rebanded };
}
