/**
 * HYROX per-station improvement potential.
 *
 * Side: tracking. For each calibrated station, computes how much time the
 * athlete could save by closing the gap to the next ability band's seed time.
 *
 * Outputs are forward-looking only — they do NOT auto-revise the current
 * predicted finish (that stays anchored on actual benchmarks). Surfaced as a
 * "biggest targets" panel in the forecast view.
 *
 * Methodology
 *   - Reference target = next-band-up seed (e.g. novice user → intermediate seed).
 *     Capped at 'competitive' for athletes already in that band.
 *   - Saving = max(0, currentSec - targetSec). Negative means already past target.
 *   - Confidence: low. Real improvement curves are S-shaped (steep early, plateau
 *     later) and depend on training response variance — see SCIENCE_LOG §Q.
 */

import type { HyroxStation, AbilityBand } from '@/types/triathlon';
import { STATION_SEED_TIMES_SEC, STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import type { HyroxStationLine } from './race-prediction.hyrox';

const BAND_PROGRESSION: AbilityBand[] = [
  'total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive',
];

export interface StationPotential {
  station: HyroxStation;
  label: string;
  currentSec: number;
  targetSec: number;
  /** Time savings in seconds (always ≥ 0). */
  savingSec: number;
  /** Reference band whose seed time is the target. */
  targetBand: AbilityBand;
  /** True if user is already faster than the next-band seed. */
  alreadyAhead: boolean;
}

export interface StationPotentialResult {
  stations: StationPotential[];
  /** Summed potential savings across all calibrated stations. */
  totalSavingSec: number;
  /** Top 3 sorted descending by saving. */
  topTargets: StationPotential[];
}

/** Get the band one step above the given band; clamped at 'competitive'. */
function nextBandUp(band: AbilityBand): AbilityBand {
  const idx = BAND_PROGRESSION.indexOf(band);
  if (idx < 0 || idx >= BAND_PROGRESSION.length - 1) return 'competitive';
  return BAND_PROGRESSION[idx + 1];
}

/**
 * Compute improvement potential per station for the calibrated subset.
 * Seed-only stations are skipped — we only project on benchmarks the user owns.
 */
export function computeStationPotential(
  athleteBand: AbilityBand,
  stations: HyroxStationLine[],
): StationPotentialResult {
  const targetBand = nextBandUp(athleteBand);
  const targetSeeds = STATION_SEED_TIMES_SEC[targetBand];

  const calibrated = stations.filter(l => l.source === 'calibrated');
  const result: StationPotential[] = calibrated.map(line => {
    const targetSec = targetSeeds[line.station];
    const savingSec = Math.max(0, line.baseSec - targetSec);
    return {
      station: line.station,
      label: STATION_DISPLAY[line.station]?.name ?? line.station,
      currentSec: Math.round(line.baseSec),
      targetSec,
      savingSec: Math.round(savingSec),
      targetBand,
      alreadyAhead: line.baseSec <= targetSec,
    };
  });

  const totalSavingSec = result.reduce((s, r) => s + r.savingSec, 0);
  const topTargets = result
    .filter(r => !r.alreadyAhead && r.savingSec > 0)
    .slice()
    .sort((a, b) => b.savingSec - a.savingSec)
    .slice(0, 3);

  return { stations: result, totalSavingSec, topTargets };
}
