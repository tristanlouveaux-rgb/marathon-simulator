import type { Paces, SimulatorState } from '@/types';
import { vt } from './vdot';
import { getEffectiveVdot } from './effective-vdot';

/**
 * Get pace zones from VDOT or LT pace
 * @param vdot - VDOT value
 * @param ltPace - LT pace in seconds per km (optional)
 * @returns Paces object
 */
export function gp(vdot: number, ltPace?: number | null): Paces {
  if (ltPace) {
    return {
      e: ltPace * 1.20,      // Easy: 20% slower than LT (~65-70% VO2max, mid-Daniels E-pace band)
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
 * Keep the training-pace cache (s.pac) in step with the LT and the engine.
 *
 * s.pac is a cache of gp(getEffectiveVdot(s), s.lt). With an LT the paces are
 * fixed multiples of it (the threshold pace IS the LT); without one they come
 * from the effective VDOT. This is the one computation of that cache, and it
 * runs wherever s.lt or the engine moves: recomputeLT (ltSync), the end of
 * refreshBlendedFitness (every initializer and the launch run it, after
 * refreshVO2Estimates), refreshVO2Estimates and the LT update handlers. So the
 * LT page headline (s.lt) and its Training Paces Threshold card (s.pac.t) read
 * one number. Before 2026-10-12, s.pac was set only by the running
 * initializer and refreshVO2Estimates: triathlon, HYROX and Just-Track
 * onboarding left the store default (Threshold 5:00/km beside an LT headline
 * of 4:43), and a launch where the refresh moved s.lt across a half second
 * showed a headline of 4:17/km beside a 4:16/km card.
 *
 * With neither an LT nor a usable VDOT it leaves s.pac as it is.
 */
export function syncTrainingPaces(s: SimulatorState): void {
  const lt = s.lt != null && s.lt > 0 ? s.lt : null;
  const vdot = getEffectiveVdot(s);
  if (lt == null && !(Number.isFinite(vdot) && vdot > 0)) return;
  s.pac = gp(vdot, lt);
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
