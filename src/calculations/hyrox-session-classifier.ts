/**
 * HYROX session classifier — single source of truth for "what kind of session
 * was this completed activity?" Lives here because the classification drives
 * both UI (Recent activities list, Training drill-down chart + mix card,
 * Unplanned-day card badges) and calculations could call it in future
 * (TSS-by-discipline aggregation, weekly-mix summaries).
 *
 * Two entry points:
 *
 * - `classifyHyroxSessionKind(actual, matched)` → `'run' | 'station' | 'brick' | 'other'`
 *   Lean call for counters / chart aggregations that only need the bucket.
 *
 * - `classifyHyroxActual(actual, matched)` → `{ kind, label }`
 *   Full call for surfaces that render the badge text alongside the colour.
 *   The label falls back through manualSport tag → effective sport → raw
 *   activity-type so a Garmin "Generic" tagged rugby reads as "Rugby" not
 *   "Activity".
 *
 * Both calls follow the same precedence:
 *   1. Matched planned slot's `discipline` wins (a strength session matched
 *      to a brick is still a brick — the plan defines the bucket).
 *   2. Strength detection (`isStrengthActual`) → station, so untagged gym
 *      uploads land in the right bucket.
 *   3. `classifyActivity` on the raw activityType → run if applicable.
 *   4. Everything else → other.
 */

import { isStrengthActual } from '@/cross-training/activities';
import { classifyActivity } from '@/calculations/tri-benchmarks-from-history';
import { getEffectiveSport } from '@/ui/sport-picker-modal';
import { SPORT_LABELS } from '@/constants';
import type { Workout } from '@/types/state';

export type HyroxSessionKind = 'run' | 'station' | 'brick' | 'other';

/** Lean classifier — kind only, for counting / aggregation. */
export function classifyHyroxSessionKind(actual: unknown, matchedSlot: Workout | null): HyroxSessionKind {
  if (matchedSlot) {
    const disc = (matchedSlot as { discipline?: string }).discipline;
    if (disc === 'station' || disc === 'brick' || disc === 'run') return disc;
  }
  if (actual == null) return 'other';
  if (isStrengthActual(actual as never)) return 'station';
  const sport = classifyActivity((actual as { activityType?: string }).activityType ?? '');
  if (sport === 'run') return 'run';
  return 'other';
}

/** Rich classifier — kind + label, for badge rendering. */
export function classifyHyroxActual(
  actual: unknown,
  matchedSlot: Workout | null,
): { kind: HyroxSessionKind; label: string } {
  if (matchedSlot) {
    const d = (matchedSlot as { discipline?: string }).discipline;
    if (d === 'station' || d === 'brick') {
      return { kind: d, label: d === 'station' ? 'Station' : 'Brick' };
    }
    if (d === 'run') return { kind: 'run', label: 'Run' };
  }
  if (actual == null) return { kind: 'other', label: 'Activity' };
  if (isStrengthActual(actual as never)) return { kind: 'station', label: 'Strength' };

  const sport = classifyActivity((actual as { activityType?: string }).activityType ?? '');
  if (sport === 'run') return { kind: 'run', label: 'Running' };

  const eff = getEffectiveSport(actual as never);
  const manualSport = (actual as { manualSport?: string }).manualSport;
  const manualLabel = manualSport
    ? (SPORT_LABELS as Record<string, string>)[manualSport]
    : null;
  const sportLabel = manualLabel
    ?? (eff && eff !== 'generic_sport' ? (SPORT_LABELS as Record<string, string>)[eff] : null);
  return {
    kind: 'other',
    label: sportLabel ?? formatActivityType((actual as { activityType?: string }).activityType ?? ''),
  };
}

/** Title-case a raw Garmin activityType (`'TRAIL_RUNNING'` → `'Trail running'`).
 *  Returns `'Activity'` for the empty case so the badge never blanks. */
export function formatActivityType(aType: string): string {
  if (!aType) return 'Activity';
  return aType.charAt(0) + aType.slice(1).toLowerCase().replace(/_/g, ' ');
}
