/**
 * State access for remembered exercise swaps (equipment substitutions).
 *
 * A swap is a standing preference: once the user swaps "Trap-Bar Deadlift" for
 * "Deadlift" before a session, every future session that prescribes Trap-Bar
 * Deadlift auto-shows Deadlift instead. The swap stays visible and re-editable
 * in the pre-session modal, and can be reverted (which clears the preference).
 *
 * Thin wrapper over `applyStrengthSwaps` (the pure logic) + the global state.
 */

import type { Workout } from '@/types';
import { getState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { applyStrengthSwaps, swapKeyForName, type StrengthSwapMap, type StrengthSwapEntry } from '@/calculations/strength-alternatives';

/** The remembered swap map (swap-key -> { from, to }). */
export function getStrengthSwaps(): StrengthSwapMap {
  return getState().strengthSwaps ?? {};
}

/** Remember a swap from one movement to a substitute, by display name, and
 *  persist. */
export function setStrengthSwap(originalName: string, substituteName: string): void {
  const s = getState();
  const map = { ...(s.strengthSwaps ?? {}) };
  map[swapKeyForName(originalName)] = { from: originalName, to: substituteName };
  s.strengthSwaps = map;
  saveState();
}

/** Forget the swap for a movement (revert to its original prescription) and
 *  persist. */
export function clearStrengthSwap(originalName: string): void {
  const s = getState();
  if (!s.strengthSwaps) return;
  const map = { ...s.strengthSwaps };
  delete map[swapKeyForName(originalName)];
  s.strengthSwaps = map;
  saveState();
}

/** All remembered swaps, sorted by original name, for a review/manage surface. */
export function listStrengthSwaps(): StrengthSwapEntry[] {
  return Object.values(getState().strengthSwaps ?? {})
    .slice()
    .sort((a, b) => a.from.localeCompare(b.from));
}

/** How many swaps are currently remembered. */
export function countStrengthSwaps(): number {
  return Object.keys(getState().strengthSwaps ?? {}).length;
}

/** Forget every remembered swap (revert all movements) and persist. */
export function clearAllStrengthSwaps(): void {
  const s = getState();
  if (!s.strengthSwaps) return;
  s.strengthSwaps = {};
  saveState();
}

/** Apply the user's remembered swaps to a workout (no-op for HYROX / non-strength
 *  / no matching lines). Call at every entry point that displays or starts a
 *  gym session so the swap is honoured everywhere. */
export function applyRememberedSwaps(workout: Workout): Workout {
  return applyStrengthSwaps(workout, getState().strengthSwaps);
}
