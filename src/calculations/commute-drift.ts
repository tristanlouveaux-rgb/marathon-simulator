import type { Week, CommuteConfig } from '@/types';

/**
 * End-of-week drift learning for the commute baseline.
 *
 * The user declares their commute pattern at onboarding (or via Settings):
 * one-way distance, bidirectional flag, days/week. That declaration is a
 * stated intent. Real behaviour drifts — life happens, weather happens, the
 * user changes office or starts driving on Wednesdays. If we don't trail the
 * actuals, the commute-aware plan engine keeps prescribing as if the user is
 * still doing 5 days/week when they're really doing 2, and the runner ends
 * up with a thinner plan than their body can actually handle.
 *
 * Mosaic's pattern (mirrors VDOT auto-refresh, CSS/FTP marker bumps, the
 * effort multiplier): trailing-window observation drives an automatic
 * baseline adjustment when the pattern is robust. The user sees a small
 * note; no popup.
 *
 * Rule
 * ----
 * Look at the last `WINDOW` fully-rolled-over weeks. Count tagged commute
 * actuals per week. If at least `THRESHOLD` of those weeks fell short of
 * the declared `commuteDaysPerWeek` by ≥ 1, reduce the declared baseline
 * to the median observed count (rounded to the nearest day, floored at 1).
 *
 * We don't *raise* the declared count automatically — if a user is doing
 * more than they declared, that's their own elective effort and the plan
 * engine's substitution math still works (it floors at zero spare easy
 * mileage). Raising would shrink the plan, which is the wrong direction.
 *
 * Why median, not max
 * -------------------
 * Median is robust against the "I did 5 one week to make up for the rest"
 * outlier. Using max would re-introduce the over-declaration that triggered
 * the drift in the first place. Using mean would smooth toward declared on
 * a single big week. Median floors honestly at the typical week.
 */

const WINDOW = 4;
const THRESHOLD = 3;

export interface CommuteDriftResult {
  /** Old declared value before adjustment. */
  oldDays: number;
  /** New declared value after adjustment (always < oldDays when set). */
  newDays: number;
  /** Per-week observed commute counts feeding the decision, oldest first. */
  observed: number[];
}

/**
 * Inspect recent weeks for sustained under-logging of commute actuals.
 * Returns the proposed adjustment, or `null` when no change is warranted.
 *
 * Caller is responsible for applying the change to state and surfacing
 * a notification.
 */
export function detectCommuteDrift(
  weeks: Week[],
  currentWeekNumber: number,
  commuteConfig: CommuteConfig | undefined,
): CommuteDriftResult | null {
  if (!commuteConfig?.enabled) return null;
  if (!commuteConfig.commuteDaysPerWeek || commuteConfig.commuteDaysPerWeek <= 1) {
    // Already at the floor — nothing to reduce to.
    return null;
  }

  // Take the last WINDOW *completed* weeks. The current week (currentWeekNumber)
  // is in-progress and would unfairly skew the observation downward — exclude.
  const startIdx = Math.max(0, currentWeekNumber - 1 - WINDOW);
  const endIdx = currentWeekNumber - 1; // exclusive
  if (endIdx - startIdx < WINDOW) {
    // Not enough history yet — wait for a fuller window before adjusting.
    return null;
  }

  const observed: number[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const wk = weeks[i];
    if (!wk) {
      observed.push(0);
      continue;
    }
    const actuals = wk.garminActuals ? Object.values(wk.garminActuals) : [];
    const commuteCount = actuals.filter(a => a.commute === true).length;
    observed.push(commuteCount);
  }

  const declared = commuteConfig.commuteDaysPerWeek;
  const shortfallWeeks = observed.filter(c => c < declared).length;
  if (shortfallWeeks < THRESHOLD) return null;

  // Median of observed
  const sorted = [...observed].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];

  const newDays = Math.max(1, Math.min(median, declared - 1));
  if (newDays >= declared) return null;

  return { oldDays: declared, newDays, observed };
}
