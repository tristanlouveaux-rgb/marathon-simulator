/**
 * HYROX division and load tier. The one canonical mapping from (format,
 * athlete sex, division) to the station loads an athlete races.
 *
 * Side: both. Planning reads the tier for station external loads in MTL
 * (stationExternalLoadKg); tracking copy (setup Pro note, division hint) reads
 * the same tier so the loads shown and the loads used never disagree.
 *
 * Rules (HYROX 26/27 Singles rulebook s4.1 and s8.8; Doubles rulebook s4.1 and
 * s8.8; no load changed from 25/26):
 *   Singles   Women Open = W-Open    Men Open = M-Open
 *             Women Pro  = M-Open    Men Pro  = M-Pro
 *   Doubles   Women = W-Open   Men = M-Open   Mixed = M-Open for both partners
 *             Women Pro = M-Open   Men Pro = M-Pro   (no Pro Mixed division)
 *   Wall-ball target by the thrower's own sex: 2.70 m women (Women Pro
 *   included), 3.00 m men. In Mixed Doubles the woman throws to 2.70 m and the
 *   man to 3.00 m.
 * Relay (Open loads by each athlete's sex) is not a supported format.
 *
 * Sex: rankings use biological sex at birth, so for singles `biologicalSex`
 * wins and the division pick only fills the gap when it is unset or
 * 'prefer_not_to_say'. For doubles the division is the pair's category, so the
 * pick wins and biological sex only supplies the default.
 */

import type { HyroxConfig, HyroxDivision, HyroxLoadTier, HyroxStation } from '@/types/triathlon';
import { HYROX_LOAD_TIER_KG, WALL_BALL_TARGET_M } from '@/constants/hyrox-benchmarks';

type HyroxFormat = HyroxConfig['format'];
type BiologicalSex = 'male' | 'female' | 'prefer_not_to_say' | null | undefined;
export type HyroxAthleteSex = 'female' | 'male';

/**
 * Tier used when neither biological sex nor a division pick is known (a saved
 * state from before divisions existed, or a HYROX brick added outside HYROX
 * mode). Men Open is the middle of the three rulebook tiers, so the error is at
 * most one tier either way. The setup screen asks for the division whenever sex
 * is unknown, so new HYROX plans do not reach this fallback.
 */
export const HYROX_DEFAULT_LOAD_TIER: HyroxLoadTier = 'M-Open';

export function isHyroxDoublesFormat(format: HyroxFormat | undefined): boolean {
  return format === 'open_doubles' || format === 'pro_doubles';
}

export function isHyroxProFormat(format: HyroxFormat | undefined): boolean {
  return format === 'pro_singles' || format === 'pro_doubles';
}

function divisionFromSex(sex: BiologicalSex): 'women' | 'men' | null {
  if (sex === 'female') return 'women';
  if (sex === 'male') return 'men';
  return null;
}

/**
 * Divisions the setup screen offers for a format, or null when no Division row
 * is shown. Doubles always asks (Women / Men / Mixed; Mixed only in Open, as
 * there is no Pro Mixed). Singles asks (Women / Men) only when biological sex
 * is unset or 'prefer_not_to_say'.
 */
export function hyroxDivisionOptions(
  format: HyroxFormat,
  biologicalSex: BiologicalSex,
): HyroxDivision[] | null {
  if (isHyroxDoublesFormat(format)) {
    return isHyroxProFormat(format) ? ['women', 'men'] : ['women', 'men', 'mixed'];
  }
  return divisionFromSex(biologicalSex) ? null : ['women', 'men'];
}

/**
 * The division in force. Doubles: a valid explicit pick, else the division
 * biological sex implies ('mixed' under a Pro doubles format is invalid and
 * falls back to sex). Singles: biological sex, else the pick. null = unknown.
 */
export function resolveHyroxDivision(
  format: HyroxFormat,
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): HyroxDivision | null {
  const sexDivision = divisionFromSex(biologicalSex);
  if (isHyroxDoublesFormat(format)) {
    if (division === 'mixed') return isHyroxProFormat(format) ? sexDivision : 'mixed';
    if (division === 'women' || division === 'men') return division;
    return sexDivision;
  }
  if (sexDivision) return sexDivision;
  if (division === 'women' || division === 'men') return division;
  return null;
}

/** The athlete's own sex for sex-keyed rules (wall-ball target). Biological sex
 *  first, then a single-sex division pick. null when unknown (including a Mixed
 *  pair with no biological sex on file). */
export function resolveHyroxAthleteSex(
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): HyroxAthleteSex | null {
  if (biologicalSex === 'female' || biologicalSex === 'male') return biologicalSex;
  if (division === 'women') return 'female';
  if (division === 'men') return 'male';
  return null;
}

/** Load tier for (format, biological sex, division). Unknown division falls
 *  back to HYROX_DEFAULT_LOAD_TIER. */
export function hyroxLoadTier(
  format: HyroxFormat,
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): HyroxLoadTier {
  const d = resolveHyroxDivision(format, biologicalSex, division);
  if (d == null) return HYROX_DEFAULT_LOAD_TIER;
  if (d === 'mixed') return 'M-Open';
  const pro = isHyroxProFormat(format);
  if (d === 'women') return pro ? 'M-Open' : 'W-Open';
  return pro ? 'M-Pro' : 'M-Open';
}

/** Wall-ball target height (metres) for the athlete, or null when sex is unknown. */
export function hyroxWallBallTargetM(
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): number | null {
  const sex = resolveHyroxAthleteSex(biologicalSex, division);
  return sex ? WALL_BALL_TARGET_M[sex] : null;
}

/** Minimal state shape the state-level helpers read. */
export interface HyroxDivisionStateInput {
  biologicalSex?: BiologicalSex;
  hyroxConfig?: Pick<HyroxConfig, 'format' | 'division'> | null;
}

/** Load tier for the current state. Without a HYROX config (a HYROX brick
 *  added from another mode) the athlete is treated as Open singles. */
export function hyroxLoadTierForState(state: HyroxDivisionStateInput): HyroxLoadTier {
  const format = state.hyroxConfig?.format ?? 'open_singles';
  return hyroxLoadTier(format, state.biologicalSex, state.hyroxConfig?.division);
}

/** Division name for copy, e.g. "Women Pro", "Doubles Mixed", "Doubles Men Pro".
 *  null when the division is unknown. */
export function hyroxDivisionLabel(
  format: HyroxFormat,
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): string | null {
  const d = resolveHyroxDivision(format, biologicalSex, division);
  if (d == null) return null;
  const sexWord = d === 'women' ? 'Women' : d === 'men' ? 'Men' : 'Mixed';
  const pro = isHyroxProFormat(format) ? ' Pro' : '';
  return isHyroxDoublesFormat(format) ? `Doubles ${sexWord}${pro}` : `${sexWord}${pro}`;
}

/**
 * One-line list of a tier's loads for copy, e.g. "sled push 152 kg, sled pull
 * 103 kg, farmers carry 2 × 24 kg, sandbag 20 kg, wall ball 6 kg to 2.70 m".
 * Sled weights include the sled (rulebook). With no target height the
 * wall-ball clause gives both heights.
 */
export function hyroxLoadsSentence(tier: HyroxLoadTier, wallBallTargetM: number | null): string {
  const t = HYROX_LOAD_TIER_KG[tier];
  const target = wallBallTargetM != null
    ? `to ${wallBallTargetM.toFixed(2)} m`
    : `to ${WALL_BALL_TARGET_M.female.toFixed(2)} m (women) or ${WALL_BALL_TARGET_M.male.toFixed(2)} m (men)`;
  return `sled push ${t.sledPush} kg, sled pull ${t.sledPull} kg, farmers carry 2 × ${t.farmerPerHand} kg, sandbag ${t.sandbag} kg, wall ball ${t.wallBall} kg ${target}`;
}

/** A load tier's name for copy: "Women Open", "Men Open", "Men Pro". */
export function hyroxLoadTierName(tier: HyroxLoadTier): string {
  return tier === 'W-Open' ? 'Women Open' : tier === 'M-Open' ? 'Men Open' : 'Men Pro';
}

/**
 * One station's load at a tier, for copy, with no distance (a half test runs
 * half the race distance): "152 kg incl. sled", "2 × 24 kg", "20 kg
 * sandbag", "6 kg ball to 2.70 m". Null for a station with no load (SkiErg,
 * row, burpee broad jumps). Sled weights include the sled (rulebook).
 */
export function hyroxStationLoadPhrase(
  station: HyroxStation,
  tier: HyroxLoadTier,
  wallBallTargetM: number | null,
): string | null {
  const t = HYROX_LOAD_TIER_KG[tier];
  switch (station) {
    case 'sled_push':      return `${t.sledPush} kg incl. sled`;
    case 'sled_pull':      return `${t.sledPull} kg incl. sled`;
    case 'farmer_carry':   return `2 × ${t.farmerPerHand} kg`;
    case 'sandbag_lunges': return `${t.sandbag} kg sandbag`;
    case 'wall_balls': {
      const target = wallBallTargetM != null
        ? `to ${wallBallTargetM.toFixed(2)} m`
        : `to ${WALL_BALL_TARGET_M.female.toFixed(2)} m (women) or ${WALL_BALL_TARGET_M.male.toFixed(2)} m (men)`;
      return `${t.wallBall} kg ball ${target}`;
    }
    default: return null;
  }
}

/**
 * One station's race standard for the athlete's tier, for copy (26/27 Singles
 * rulebook s8.1, s8.2, s8.5, s8.8; no change from 25/26): SkiErg and row at
 * damper 6 in every division, sleds as 4 × 12.5 m lanes with the sled weight
 * included, wall balls to the thrower's target. Distances in metres, as the
 * rulebook and STATION_DISPLAY state them.
 */
export function hyroxStationRaceStandard(
  station: HyroxStation,
  tier: HyroxLoadTier,
  wallBallTargetM: number | null,
): string {
  const t = HYROX_LOAD_TIER_KG[tier];
  switch (station) {
    case 'ski_erg':            return '1000m, damper 6';
    case 'row_erg':            return '1000m, damper 6';
    case 'sled_push':          return `4 × 12.5m lanes, ${t.sledPush} kg incl. sled`;
    case 'sled_pull':          return `4 × 12.5m lanes, ${t.sledPull} kg incl. sled`;
    case 'burpee_broad_jumps': return '80m';
    case 'farmer_carry':       return `200m, 2 × ${t.farmerPerHand} kg`;
    case 'sandbag_lunges':     return `100m, ${t.sandbag} kg sandbag`;
    case 'wall_balls': {
      const target = wallBallTargetM != null
        ? `to ${wallBallTargetM.toFixed(2)} m`
        : `to ${WALL_BALL_TARGET_M.female.toFixed(2)} m (women) or ${WALL_BALL_TARGET_M.male.toFixed(2)} m (men)`;
      return `100 reps, ${t.wallBall} kg ${target}`;
    }
  }
}
