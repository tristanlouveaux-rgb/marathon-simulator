import { describe, it, expect } from 'vitest';
import { checkExperienceLevelVsPBs } from './experience-level-validation';
import type { PBs } from '@/types/training';

describe('checkExperienceLevelVsPBs', () => {
  describe('consistency cases', () => {
    it('returns consistent when no PBs provided', () => {
      const result = checkExperienceLevelVsPBs('beginner', {});
      expect(result.isConsistent).toBe(true);
    });

    it('returns consistent when no level selected', () => {
      const result = checkExperienceLevelVsPBs(undefined, { m: 12000 });
      expect(result.isConsistent).toBe(true);
    });

    it('returns consistent when "returning" selected regardless of PBs', () => {
      const result = checkExperienceLevelVsPBs('returning', { k5: 1080 });
      expect(result.isConsistent).toBe(true);
    });

    it('returns consistent when "hybrid" selected regardless of PBs', () => {
      const result = checkExperienceLevelVsPBs('hybrid', { m: 10000 });
      expect(result.isConsistent).toBe(true);
    });

    it('returns consistent when selected level matches PB-derived band', () => {
      // 3:37 marathon ≈ VDOT 42 → intermediate band
      const result = checkExperienceLevelVsPBs('intermediate', { m: 3 * 3600 + 37 * 60 });
      expect(result.isConsistent).toBe(true);
      expect(result.pbDerivedVdot).toBeGreaterThan(40);
      expect(result.pbDerivedVdot).toBeLessThan(44);
    });

    it('returns consistent when selected level is HIGHER than PB-derived band (over-claiming is safe)', () => {
      // 30:00 5K ≈ VDOT 32 → beginner band. Selecting "intermediate" over-claims
      // but does NOT trigger the warning (over-claiming yields lower max_gain).
      const result = checkExperienceLevelVsPBs('intermediate', { k5: 30 * 60 });
      expect(result.isConsistent).toBe(true);
    });
  });

  describe('inconsistency cases (the ISSUE-145 sibling bug)', () => {
    it('flags Tristan-shape: 3:37 marathon PB + "beginner" label', () => {
      // The exact case that motivated this validator.
      const result = checkExperienceLevelVsPBs('beginner', { m: 3 * 3600 + 37 * 60 });
      expect(result.isConsistent).toBe(false);
      expect(result.suggested).toBe('intermediate');
      expect(result.reason).toMatch(/marathon/);
      expect(result.reason).toMatch(/beginner/);
    });

    it('flags sub-3 marathon + "novice" → suggests intermediate or better', () => {
      const result = checkExperienceLevelVsPBs('novice', { m: 2 * 3600 + 58 * 60 });
      expect(result.isConsistent).toBe(false);
      // VDOT for 2:58 marathon is ~54-55 → advanced band
      expect(['intermediate', 'advanced']).toContain(result.suggested!);
    });

    it('flags sub-18 5K + "beginner" → suggests advanced or higher', () => {
      // ISSUE-145 profile: 18:00 5K alone is VDOT ~56 → advanced band
      const result = checkExperienceLevelVsPBs('beginner', { k5: 18 * 60 });
      expect(result.isConsistent).toBe(false);
      expect(['intermediate', 'advanced', 'competitive']).toContain(result.suggested!);
    });

    it('flags 35:00 10K + "total_beginner"', () => {
      // 35:00 10K is VDOT ~60.7 → competitive band
      const result = checkExperienceLevelVsPBs('total_beginner', { k10: 35 * 60 });
      expect(result.isConsistent).toBe(false);
      expect(['intermediate', 'advanced', 'competitive']).toContain(result.suggested!);
    });

    it('prefers longest PB when multiple are available', () => {
      // k5 alone would suggest one band, marathon another. Marathon wins.
      const pbs: PBs = {
        k5: 18 * 60,                   // VDOT ~50 (intermediate)
        m: 4 * 3600 + 30 * 60,         // VDOT ~31 (beginner)
      };
      const result = checkExperienceLevelVsPBs('beginner', pbs);
      // Marathon PB is VDOT ~31 → beginner band → consistent with "beginner"
      expect(result.isConsistent).toBe(true);
      expect(result.pbUsed?.distM).toBe(42195);
    });
  });

  describe('VDOT/band edge cases', () => {
    it('returns approximate VDOT for diagnostic UI', () => {
      const result = checkExperienceLevelVsPBs('intermediate', { m: 3 * 3600 + 0 });
      // 3:00 marathon ≈ VDOT 54
      expect(result.pbDerivedVdot).toBeGreaterThan(50);
      expect(result.pbDerivedVdot).toBeLessThan(56);
    });

    it('reports which PB triggered the suggestion', () => {
      const result = checkExperienceLevelVsPBs('beginner', { k5: 18 * 60, k10: 38 * 60 });
      // Both present: prefers longer (10K)
      expect(result.pbUsed?.distM).toBe(10000);
    });
  });
});
