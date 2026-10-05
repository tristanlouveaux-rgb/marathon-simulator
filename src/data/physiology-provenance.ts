/**
 * Which source wrote each field of a PhysiologyDayEntry (tracking side).
 *
 * Apple Health is a supplementary physiology source when Garmin is primary:
 * it fills fields Garmin left empty and may refresh the values it filled
 * itself, but must never overwrite a value Garmin wrote. `appleValues` on the
 * entry records what Apple last wrote. A field counts as Apple's only while
 * its current value still equals the recorded one.
 *
 * Kept free of plugin and sync imports so the Garmin writers
 * (physiologySync.ts) and the Apple writer (appleHealthSync.ts) share one
 * definition without pulling each other's module graph in.
 */

import type { PhysiologyDayEntry, ApplePhysiologyField } from '@/types';

/** Fields the Apple Health physiology sync writes into a PhysiologyDayEntry. */
export const APPLE_PHYSIOLOGY_FIELDS: readonly ApplePhysiologyField[] = [
  'sleepScore', 'sleepDurationSec', 'sleepDeepSec', 'sleepRemSec',
  'sleepLightSec', 'sleepAwakeSec', 'restingHR', 'hrvRmssd', 'steps',
  'respiratoryRate', 'spo2',
];

/**
 * Return `entry` with Apple's claim removed from every field another source
 * has just written. Call it from every non-Apple writer, after applying that
 * writer's values.
 *
 * Without it, a Garmin value that happens to equal the Apple value (a resting
 * HR of 52 from both, which is common when Garmin Connect also writes to Apple
 * Health) would still look Apple-owned, and the next Apple read would
 * overwrite the primary source.
 *
 * Returns a new object when anything changes; never mutates `entry` or its
 * `appleValues`.
 */
export function releaseAppleOwnership(
  entry: PhysiologyDayEntry,
  writtenFields: Iterable<string>,
): PhysiologyDayEntry {
  if (!entry.appleValues) return entry;
  const kept: Partial<Record<ApplePhysiologyField, number>> = { ...entry.appleValues };
  let removed = false;
  for (const f of writtenFields) {
    if (f in kept) {
      delete kept[f as ApplePhysiologyField];
      removed = true;
    }
  }
  if (!removed) return entry;
  const out: PhysiologyDayEntry = { ...entry };
  if (Object.keys(kept).length > 0) out.appleValues = kept;
  else delete out.appleValues;
  return out;
}
