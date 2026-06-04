/**
 * Runner population distributions across standard road distances. Real
 * aggregated outcome data — answers "faster than X% of all runners".
 *
 * Source: RunRepeat percentile calculator ("Compare Running Finish Times"),
 * runrepeat.com/how-do-you-masure-up-the-runners-percentile-calculator.
 * Methodology per the page: "Results are based on 35 million results
 * collected in the last 20 years from more than 28,000 races."
 * Tables extracted from the published page on 2026-06-03 (the percentile
 * tables are server-rendered into the article body; times converted to
 * seconds verbatim).
 *
 * Each entry: `[finishTimeSec, percentile]` sorted ascending by time.
 * `percentile` = % of runners FASTER than or at this time (1 = elite end),
 * so "faster than X%" = `100 - percentile`. Same convention as
 * `marathon-population-distributions.ts`.
 *
 * Published breakpoints: 1/10/20/30/40/50/60/70/80/90. The table carries no
 * information beyond p1/p90; lookups clamp there (max claim "faster than
 * 99%", min "faster than 10%").
 */

export type RunnerPopDistance = 'k5' | 'k10' | 'half' | 'marathon';
export type RunnerPopSex = 'all' | 'male' | 'female';

export const RUNNER_POP_ATTRIBUTION = '35 million results from 28,000 races over 20 years';
export const RUNNER_POP_SOURCE = 'RunRepeat percentile calculator, extracted 2026-06-03';

type Table = Array<[number, number]>;

export const RUNNER_POPULATION_TABLES: Record<RunnerPopDistance, Record<RunnerPopSex, Table>> = {
  k5: {
    all:    [[1120, 1], [1520, 10], [1693, 20], [1826, 30], [1949, 40], [2077, 50], [2218, 60], [2388, 70], [2619, 80], [3004, 90]],
    female: [[1299, 1], [1704, 10], [1869, 20], [1999, 30], [2121, 40], [2248, 50], [2387, 60], [2556, 70], [2783, 80], [3144, 90]],
    male:   [[1050, 1], [1406, 10], [1564, 20], [1678, 30], [1781, 40], [1888, 50], [2008, 60], [2155, 70], [2361, 80], [2743, 90]],
  },
  k10: {
    all:    [[2178, 1], [2891, 10], [3167, 20], [3363, 30], [3545, 40], [3728, 50], [3938, 60], [4208, 70], [4605, 80], [5278, 90]],
    female: [[2472, 1], [3215, 10], [3481, 20], [3662, 30], [3830, 40], [4014, 50], [4238, 60], [4536, 70], [4966, 80], [5594, 90]],
    male:   [[2064, 1], [2711, 10], [2977, 20], [3148, 30], [3290, 40], [3435, 50], [3602, 60], [3823, 70], [4153, 80], [4761, 90]],
  },
  half: {
    all:    [[5039, 1], [6430, 10], [6972, 20], [7368, 30], [7734, 40], [8099, 50], [8502, 60], [8988, 70], [9665, 80], [10758, 90]],
    female: [[5755, 1], [7021, 10], [7558, 20], [7945, 30], [8290, 40], [8643, 50], [9044, 60], [9545, 70], [10231, 80], [11301, 90]],
    male:   [[4717, 1], [6035, 10], [6553, 20], [6903, 30], [7096, 40], [7188, 50], [7798, 60], [8191, 70], [8757, 80], [9768, 90]],
  },
  marathon: {
    all:    [[10248, 1], [12706, 10], [13793, 20], [14576, 30], [15309, 40], [15993, 50], [16710, 60], [17538, 70], [18660, 80], [20505, 90]],
    female: [[11495, 1], [13762, 10], [14818, 20], [15624, 30], [16281, 40], [16929, 50], [17617, 60], [18456, 70], [19600, 80], [21391, 90]],
    male:   [[9858, 1], [12160, 10], [13213, 20], [13987, 30], [14627, 40], [15269, 50], [15933, 60], [16706, 70], [17733, 80], [19526, 90]],
  },
};

/**
 * Look up the population percentile for a finish time. Linear interpolation
 * between breakpoints, clamped at the published p1/p90 ends. Mirrors
 * `lookupDistanceAggregatePercentile`.
 */
export function lookupRunnerPopPercentile(
  distance: RunnerPopDistance,
  sex: RunnerPopSex,
  timeSec: number,
): number | null {
  const t = RUNNER_POPULATION_TABLES[distance][sex];
  if (!t || t.length === 0) return null;
  if (timeSec <= t[0][0]) return t[0][1];
  if (timeSec >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (let i = 1; i < t.length; i++) {
    const [t0, p0] = t[i - 1];
    const [t1, p1] = t[i];
    if (timeSec <= t1) {
      const frac = (timeSec - t0) / (t1 - t0);
      return Math.round(p0 + frac * (p1 - p0));
    }
  }
  return t[t.length - 1][1];
}
