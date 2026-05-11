import { describe, expect, it } from 'vitest';
import { hyroxPhasesForLen, HYROX_PHASE_WEEKS } from './hyrox-constants';

describe('hyroxPhasesForLen — short-plan compression', () => {
  it('preserves total weeks at canonical length (16w default)', () => {
    const p = hyroxPhasesForLen(16);
    expect(p.base + p.build + p.peak + p.taper).toBe(16);
  });

  it('always preserves total weeks across 1–24', () => {
    for (let n = 1; n <= 24; n++) {
      const p = hyroxPhasesForLen(n);
      expect(p.base + p.build + p.peak + p.taper).toBe(n);
    }
  });

  it('floors taper at 1 week so race week is always tapered', () => {
    for (let n = 1; n <= 24; n++) {
      const p = hyroxPhasesForLen(n);
      expect(p.taper).toBeGreaterThanOrEqual(1);
    }
  });

  it('caps taper at 2 weeks (Mujika & Padilla 2003)', () => {
    for (let n = 2; n <= 30; n++) {
      const p = hyroxPhasesForLen(n);
      expect(p.taper).toBeLessThanOrEqual(2);
    }
  });

  it('floors peak at 1 whenever a non-taper week is available', () => {
    for (let n = 2; n <= 24; n++) {
      const p = hyroxPhasesForLen(n);
      expect(p.peak).toBeGreaterThanOrEqual(1);
    }
  });

  it('1-week plan is taper-only', () => {
    expect(hyroxPhasesForLen(1)).toEqual({ base: 0, build: 0, peak: 0, taper: 1 });
  });

  it('2-week plan: 1 peak + 1 taper (no base, no build)', () => {
    const p = hyroxPhasesForLen(2);
    expect(p.taper).toBe(1);
    expect(p.peak).toBe(1);
    expect(p.base + p.build).toBe(0);
  });

  it('7-week plan (the bug case) ends in a taper', () => {
    const p = hyroxPhasesForLen(7);
    expect(p.taper).toBeGreaterThanOrEqual(1);
    expect(p.peak).toBeGreaterThanOrEqual(1);
    expect(p.base + p.build + p.peak + p.taper).toBe(7);
  });

  it('clamps fractional/zero/negative inputs', () => {
    expect(hyroxPhasesForLen(0).taper).toBeGreaterThanOrEqual(1);
    expect(hyroxPhasesForLen(-3).taper).toBeGreaterThanOrEqual(1);
    expect(hyroxPhasesForLen(7.4).base + hyroxPhasesForLen(7.4).build + hyroxPhasesForLen(7.4).peak + hyroxPhasesForLen(7.4).taper).toBe(7);
  });

  it('canonical 16w split keeps peak shorter than base/build and lands a 2-week taper', () => {
    // 16w with taper=2 leaves 14 weeks; HYROX_PHASE_WEEKS sum = 15 → peak/build/base
    // distribute roughly proportionally. Canonical base=6 build=6 peak=3, so at
    // length the result should still treat peak as the smallest bucket.
    const p = hyroxPhasesForLen(16);
    expect(p.peak).toBeLessThanOrEqual(p.build);
    expect(p.peak).toBeLessThanOrEqual(p.base);
    expect(p.taper).toBe(2);
    // Sanity: HYROX_PHASE_WEEKS still represents canonical proportions.
    expect(HYROX_PHASE_WEEKS.base + HYROX_PHASE_WEEKS.build + HYROX_PHASE_WEEKS.peak).toBe(15);
  });
});
