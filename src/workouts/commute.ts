import type { CommuteConfig } from '@/types';

/**
 * Calculate single commute distance (total for one commute trip)
 * @param config - Commute configuration
 * @returns Total distance per commute in km
 */
export function getCommuteDistance(config: CommuteConfig): number {
  if (!config.enabled) return 0;

  return config.isBidirectional
    ? config.distanceKm * 2
    : config.distanceKm;
}
