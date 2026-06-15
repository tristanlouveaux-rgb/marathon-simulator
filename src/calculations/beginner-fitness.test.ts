import { describe, it, expect } from 'vitest';
import { levelAllowsEstimatedStart, seedStartingPbs, cappedBeginnerStartWeeklyKm } from './beginner-fitness';
import { cv } from './vdot';

describe('beginner-fitness seed', () => {
  it('allows estimated start only for no-PB-plausible levels', () => {
    expect(levelAllowsEstimatedStart('beginner')).toBe(true);
    expect(levelAllowsEstimatedStart('total_beginner')).toBe(true);
    expect(levelAllowsEstimatedStart('hybrid')).toBe(true);
    // Levels that imply a known time still require a real PB.
    expect(levelAllowsEstimatedStart('novice')).toBe(false);
    expect(levelAllowsEstimatedStart('intermediate')).toBe(false);
    expect(levelAllowsEstimatedStart('advanced')).toBe(false);
    expect(levelAllowsEstimatedStart('returning')).toBe(false);
    expect(levelAllowsEstimatedStart(null)).toBe(false);
    expect(levelAllowsEstimatedStart(undefined)).toBe(false);
  });

  it('seeds beginner at the documented band floor (VDOT ~28)', () => {
    const pbs = seedStartingPbs('beginner');
    expect(pbs?.k5).toBeGreaterThan(0);
    // The seeded 5K time must round-trip to ~VDOT 28 (Daniels cv()).
    const vdot = cv(5000, pbs!.k5!);
    expect(vdot).toBeGreaterThan(27.4);
    expect(vdot).toBeLessThan(28.6);
  });

  it('seeds hybrid one band higher (novice floor, VDOT ~35)', () => {
    const pbs = seedStartingPbs('hybrid');
    const vdot = cv(5000, pbs!.k5!);
    expect(vdot).toBeGreaterThan(34.4);
    expect(vdot).toBeLessThan(35.6);
  });

  it('returns null for levels that imply a known time', () => {
    expect(seedStartingPbs('novice')).toBeNull();
    expect(seedStartingPbs('intermediate')).toBeNull();
    expect(seedStartingPbs(null)).toBeNull();
  });

  it('seeds only a 5K (single anchor, conservative)', () => {
    const pbs = seedStartingPbs('beginner')!;
    expect(Object.keys(pbs)).toEqual(['k5']);
  });
});

describe('cappedBeginnerStartWeeklyKm (30 min/run, C25K)', () => {
  it('caps a true beginner below the runs×10 default', () => {
    // easy 7:30/km (450s) → 30min ≈ 4 km/run → 12 km/wk at 3 runs (< 30 default)
    expect(cappedBeginnerStartWeeklyKm('beginner', 3, 450, 30)).toBe(12);
  });

  it('auto-scales by pace — a faster hybrid covers more in 30 min', () => {
    // easy 6:00/km (360s) → 5 km/run → 15 km/wk
    expect(cappedBeginnerStartWeeklyKm('hybrid', 3, 360, 30)).toBe(15);
  });

  it('does not apply to levels that imply a known time', () => {
    expect(cappedBeginnerStartWeeklyKm('intermediate', 3, 450, 30)).toBeNull();
    expect(cappedBeginnerStartWeeklyKm('novice', 3, 450, 30)).toBeNull();
  });

  it('never raises volume above the default (returns null when cap >= default)', () => {
    // fast easy pace 4:00/km (240s) → 7.5 km/run × 3 = 22.5 → 23, which is > 20 default
    expect(cappedBeginnerStartWeeklyKm('beginner', 3, 240, 20)).toBeNull();
  });

  it('guards bad inputs', () => {
    expect(cappedBeginnerStartWeeklyKm('beginner', 0, 450, 30)).toBeNull();
    expect(cappedBeginnerStartWeeklyKm('beginner', 3, 0, 30)).toBeNull();
  });
});
