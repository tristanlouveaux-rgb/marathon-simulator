/**
 * VO2max reference norms. Real measured data.
 *
 * Source: Kaminsky LA, Arena R, Myers J. "Reference Standards for
 * Cardiorespiratory Fitness Measured With Cardiopulmonary Exercise Testing:
 * Data From the Fitness Registry and the Importance of Exercise National
 * Database (FRIEND)." Mayo Clin Proc. 2015;90(11):1515-1523.
 *
 * 7,783 maximal treadmill CPX tests (4,611 men, 3,172 women), aged 20-79,
 * free of known cardiovascular disease, from 8 US laboratories. These are
 * the reference standards behind current ACSM guidelines. Values verified
 * against the open-access PMC copy (PMC4919021) on 2026-06-03.
 *
 * A 2022 FRIEND update exists (Kaminsky et al., Mayo Clin Proc
 * 2022;97(2):285-293; 16,278 treadmill tests, ages 20-89) but its full
 * tables sit behind the publisher paywall. Swap these tables for the 2022
 * values if/when they can be verified against the published article.
 *
 * Mirrors `marathon-population-distributions.ts` in structure: each entry
 * `[vo2MlKgMin, percentile]`, sorted ascending. `percentile` = % of the
 * age/sex reference group at or below this VO2max.
 */

export type Vo2Sex = 'male' | 'female';

/** Age decade band ids in the published table. */
export type Vo2AgeBand = '20-29' | '30-39' | '40-49' | '50-59' | '60-69' | '70-79';

/** `[vo2MlKgMin, percentile]` ascending. Percentiles published: 5/10/25/50/75/90/95. */
export type Vo2PercentileTable = Array<[number, number]>;

/** Table 3, Kaminsky 2015 — treadmill VO2max (mL·kg⁻¹·min⁻¹), men. */
const MEN: Record<Vo2AgeBand, Vo2PercentileTable> = {
  '20-29': [[29.0, 5], [32.1, 10], [40.1, 25], [48.0, 50], [55.2, 75], [61.8, 90], [66.3, 95]],
  '30-39': [[27.2, 5], [30.2, 10], [35.9, 25], [42.4, 50], [49.2, 75], [56.5, 90], [59.8, 95]],
  '40-49': [[24.2, 5], [26.8, 10], [31.9, 25], [37.8, 50], [45.0, 75], [52.1, 90], [55.6, 95]],
  '50-59': [[20.9, 5], [22.8, 10], [27.1, 25], [32.6, 50], [39.7, 75], [45.6, 90], [50.7, 95]],
  '60-69': [[17.4, 5], [19.8, 10], [23.7, 25], [28.2, 50], [34.5, 75], [40.3, 90], [43.0, 95]],
  '70-79': [[16.3, 5], [17.1, 10], [20.4, 25], [24.4, 50], [30.4, 75], [36.6, 90], [39.7, 95]],
};

/** Table 3, Kaminsky 2015 — treadmill VO2max (mL·kg⁻¹·min⁻¹), women. */
const WOMEN: Record<Vo2AgeBand, Vo2PercentileTable> = {
  '20-29': [[21.7, 5], [23.9, 10], [30.5, 25], [37.6, 50], [44.7, 75], [51.3, 90], [56.0, 95]],
  '30-39': [[19.0, 5], [20.9, 10], [25.3, 25], [30.2, 50], [36.1, 75], [41.4, 90], [45.8, 95]],
  '40-49': [[17.0, 5], [18.8, 10], [22.1, 25], [26.7, 50], [32.4, 75], [38.4, 90], [41.7, 95]],
  '50-59': [[16.0, 5], [17.3, 10], [19.9, 25], [23.4, 50], [27.6, 75], [32.0, 90], [35.9, 95]],
  '60-69': [[13.4, 5], [14.6, 10], [17.2, 25], [20.0, 50], [23.8, 75], [27.0, 90], [29.4, 95]],
  '70-79': [[13.1, 5], [13.6, 10], [15.6, 25], [18.3, 50], [20.8, 75], [23.1, 90], [24.1, 95]],
};

/** One-line attribution for UI captions. */
export const VO2_NORMS_ATTRIBUTION = 'FRIEND registry, 7,783 treadmill tests (Kaminsky 2015)';

/**
 * Resolve the age decade band. Ages outside the published 20-79 range clamp
 * to the nearest band; the returned band label keeps the caption honest
 * ("men 20-29" for a 19-year-old states exactly what was compared).
 */
export function resolveVo2AgeBand(age: number): Vo2AgeBand {
  if (!isFinite(age)) return '20-29';
  const lo = Math.min(70, Math.max(20, Math.floor(age / 10) * 10));
  return `${lo}-${lo + 9}` as Vo2AgeBand;
}

export interface Vo2Placement {
  /** % of the age/sex reference group at or below this VO2max (5-95, interpolated). */
  percentile: number;
  /** The band actually compared against, e.g. "30-39". */
  bandLabel: Vo2AgeBand;
  /** Caption noun: "men" | "women". */
  sexLabel: 'men' | 'women';
}

/**
 * Real-table anchors for a position-bar scale: the band's published 5th,
 * 50th and 95th percentile VO2max values. Same refusal rules as the lookup.
 */
export function vo2BandAnchors(
  age: number | null | undefined,
  sex: 'male' | 'female' | 'prefer_not_to_say' | null | undefined,
): { p5: number; p50: number; p95: number } | null {
  if (sex !== 'male' && sex !== 'female') return null;
  if (age == null || !isFinite(age) || age <= 0) return null;
  const t = (sex === 'male' ? MEN : WOMEN)[resolveVo2AgeBand(age)];
  return { p5: t[0][0], p50: t[3][0], p95: t[t.length - 1][0] };
}

/**
 * Place a VO2max within the FRIEND age/sex reference distribution.
 * Returns null when sex is unknown or VO2 is non-positive — a percentile
 * claim must not be made against a guessed reference group.
 *
 * Interpolation mirrors `lookupDistanceAggregatePercentile`. Values outside
 * the published 5th-95th breakpoints clamp to 5/95 — the table carries no
 * information beyond them.
 */
export function lookupVo2Percentile(
  vo2MlKgMin: number,
  age: number | null | undefined,
  sex: 'male' | 'female' | 'prefer_not_to_say' | null | undefined,
): Vo2Placement | null {
  if (!isFinite(vo2MlKgMin) || vo2MlKgMin <= 0) return null;
  if (sex !== 'male' && sex !== 'female') return null;
  if (age == null || !isFinite(age) || age <= 0) return null;
  const bandLabel = resolveVo2AgeBand(age);
  const t = (sex === 'male' ? MEN : WOMEN)[bandLabel];
  const sexLabel = sex === 'male' ? 'men' : 'women';
  if (vo2MlKgMin <= t[0][0]) return { percentile: t[0][1], bandLabel, sexLabel };
  if (vo2MlKgMin >= t[t.length - 1][0]) return { percentile: t[t.length - 1][1], bandLabel, sexLabel };
  for (let i = 1; i < t.length; i++) {
    const [v0, p0] = t[i - 1];
    const [v1, p1] = t[i];
    if (vo2MlKgMin <= v1) {
      const frac = (vo2MlKgMin - v0) / (v1 - v0);
      return { percentile: Math.round(p0 + frac * (p1 - p0)), bandLabel, sexLabel };
    }
  }
  return { percentile: 95, bandLabel, sexLabel };
}
