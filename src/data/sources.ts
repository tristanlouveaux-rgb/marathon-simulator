/**
 * Wearable source accessors.
 *
 * Centralises the "which source is active?" logic so call sites don't branch
 * on `s.wearable` directly.  Backwards-compatible: reads `connectedSources`
 * first, falls back to the legacy `wearable` field for existing saved state.
 */

import type { SimulatorState } from '@/types/state';

// ── Types ────────────────────────────────────────────────────────────────────

export type ActivitySource = 'strava' | 'garmin' | 'apple' | 'polar' | 'phone';
export type PhysiologySource = 'garmin' | 'apple' | 'whoop' | 'oura';

// ── Activity source ──────────────────────────────────────────────────────────

/**
 * The primary activity source.  Strava always wins when connected because it
 * provides the best HR-stream quality regardless of which watch recorded it.
 */
export function getActivitySource(s: SimulatorState): ActivitySource {
  if (s.stravaConnected) return 'strava';

  const explicit = s.connectedSources?.activity;
  if (explicit) return explicit;

  // Legacy fallback
  if (s.wearable === 'apple') return 'apple';
  if (s.wearable === 'garmin') return 'garmin';
  if (s.wearable === 'strava') return 'strava';

  return 'phone';  // no wearable, no Strava
}

// ── Physiology source ────────────────────────────────────────────────────────

/**
 * The primary physiology source (sleep, HRV, resting HR, VO2max).
 * Returns undefined when no physiology-capable device is connected.
 */
export function getPhysiologySource(s: SimulatorState): PhysiologySource | undefined {
  const explicit = s.connectedSources?.physiology;
  if (explicit) return explicit;

  // Legacy fallback
  if (s.wearable === 'garmin') return 'garmin';
  if (s.wearable === 'apple') return 'apple';

  return undefined;
}

/**
 * Check whether a specific provider is the active physiology source.
 */
export function hasPhysiologySource(s: SimulatorState, provider: PhysiologySource): boolean {
  return getPhysiologySource(s) === provider;
}

// ── UI helpers ───────────────────────────────────────────────────────────────

const SYNC_LABELS: Record<string, string> = {
  strava: 'Sync Strava',
  garmin: 'Sync Garmin',
  apple: 'Sync Apple Watch',
  polar: 'Sync Polar',
  phone: 'Sync',
};

/** Label for the sync button. */
export function getSyncLabel(s: SimulatorState): string {
  return SYNC_LABELS[getActivitySource(s)] ?? 'Sync';
}
