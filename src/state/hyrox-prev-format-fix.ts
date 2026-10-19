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
  HYROX_MTL_CAP,
  computeDoublesCap,
} from '@/constants/hyrox-constants';
import { ensureHyroxChronicSeed, generateHyroxPlan } from '@/workouts/plan_engine.hyrox';
import { archiveCurrentWksIfPopulated, redistributeArchivedActivitiesToNewPlan } from '@/state/initialization';
import { hyroxPlanningBandFor } from '@/calculations/hyrox-planning-band';
import { isHyroxProFormat } from '@/calculations/hyrox-division';

type HyroxFormat = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

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
 * changed. Returns `changed: false` and is a no-op.
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
            // A race split takes the corrected race's weights too.
            return e.source === 'race'
              ? { ...e, format: newFormat, proWeights: isHyroxProFormat(newFormat) }
              : { ...e, format: newFormat };
          }
          return e;
        });
      }
    }
  } else if (oldFormat != null && hx.stationBenchmarkHistory) {
    // Open ↔ Pro on the same axis: the previous race's split entries carry the
    // corrected format and weights, so the predictor reads their weight regime
    // right (race-prediction.hyrox.ts reads a race split's proWeights).
    for (const k of Object.keys(hx.stationBenchmarkHistory)) {
      const station = k as keyof typeof hx.stationBenchmarkHistory;
      const entries = hx.stationBenchmarkHistory[station];
      if (!entries) continue;
      hx.stationBenchmarkHistory[station] = entries.map(e =>
        e.source === 'race' && e.format === oldFormat
          ? { ...e, format: newFormat, proWeights: isHyroxProFormat(newFormat) }
          : e,
      );
    }
  }

  // Re-derive the planning band (hyroxPlanningBandFor): the previous time is
  // the same effort whichever format it is filed under, but its Open Singles
  // equivalent depends on that format's loads and pairing.
  let rebanded = false;
  const prevTimeSec = hx.previousHyroxTimeSec;
  if (prevTimeSec != null) {
    const targetIsDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
    const newBand = hyroxPlanningBandFor(prevTimeSec, newFormat, s.biologicalSex, hx.division);
    if (newBand !== hx.athleteBand) {
      hx.athleteBand = newBand;
      const baseCap = HYROX_MTL_CAP[newBand];
      hx.mtlCap = targetIsDoubles ? computeDoublesCap(baseCap) : baseCap;
      rebanded = true;
    }
  }

  // Regenerate the plan when band shifted. Workout intensities, weekly volume,
  // and progression curve all key off the band. Archive the existing wks first
  // so completed activities aren't lost; the redistributor reattaches them by
  // date.
  if (rebanded) {
    archiveCurrentWksIfPopulated();
    // Same plan, same start: it keeps the chronic seed stored when it was
    // created (D4), or stores one now if it predates them.
    ensureHyroxChronicSeed(s);
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
