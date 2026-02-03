import type { Paces } from '@/types';
import { vt } from './vdot';

/**
 * Get pace zones from VDOT or LT pace
 * @param vdot - VDOT value
 * @param ltPace - LT pace in seconds per km (optional)
 * @returns Paces object
 */
export function gp(vdot: number, ltPace?: number | null): Paces {
  if (ltPace) {
    return {
      e: ltPace * 1.15,      // Easy: 15% slower than LT
      m: ltPace * 1.05,      // Marathon: 5% slower than LT
      t: ltPace,             // Threshold: at LT
      i: ltPace * 0.93,      // Interval: 7% faster than LT
      r: ltPace * 0.88       // Repetition: 12% faster than LT
    };
  }

  // Fallback: Derived from VDOT
  const t5 = vt(5, vdot);      // 5K time
  const t10 = vt(10, vdot);    // 10K time
  const tm = vt(42.2, vdot);   // Marathon time

  return {
    e: (t5 / 5) * 1.25,        // Easy: 25% slower than 5K pace
    m: tm / 42.2,              // Marathon pace
    t: t10 / 10,               // Threshold: ~10K pace (Fallback: Derived from VDOT)
    i: t5 / 5,                 // Interval: 5K pace
    r: (t5 / 5) * 0.97         // Repetition: 3% faster than 5K pace
  };
}

/**
 * Get pace for a specific zone
 * @param zone - Zone identifier
 * @param paces - Paces object
 * @returns Pace in seconds per km
 */
export function getPaceForZone(zone: string, paces: Paces): number {
  const zoneMap: Record<string, number> = {
    'easy': paces.e,
    'e': paces.e,
    'threshold': paces.t,
    'tempo': paces.t,
    't': paces.t,
    '5k': paces.i,
    '5K': paces.i,
    'i': paces.i,
    'r': paces.r,
    '10k': paces.m * 0.95,     // Slightly faster than marathon
    '10K': paces.m * 0.95,
    'hm': paces.m * 1.05,      // Half marathon pace (slightly slower than full)
    'HM': paces.m * 1.05,
    'mp': paces.m,
    'MP': paces.m,
    'm': paces.m
  };

  const normalizedZone = zone.toLowerCase().trim();
  return zoneMap[normalizedZone] || paces.e; // Default to easy if unknown
}
