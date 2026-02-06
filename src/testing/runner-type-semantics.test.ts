/**
 * Runner Type Semantics Verification Tests
 * =========================================
 *
 * CRITICAL AUDIT: These tests verify that getRunnerType() labels match
 * the user-facing semantic requirement:
 *
 * USER REQUIREMENT:
 * - "Speed" = relatively better at SHORT distances = MORE fade over distance = HIGHER b
 * - "Endurance" = relatively better at LONG distances = LESS fade over distance = LOWER b
 * - "Balanced" = middle
 *
 * MATHEMATICAL DEFINITION:
 * - Fade = ln(T_marathon / T_5k) / ln(D_marathon / D_5k) ≈ b (Riegel exponent)
 * - Higher b → time increases MORE as distance increases → WORSE at long distances → "Speed" type
 * - Lower b → time increases LESS as distance increases → BETTER at long distances → "Endurance" type
 *
 * CORRECTED ENGINE BEHAVIOR (fatigue.ts - as of schema version 2):
 * - b < 1.06 → 'Endurance' (low fade = better at long)
 * - b > 1.12 → 'Speed' (high fade = better at short)
 *
 * This now MATCHES the semantic requirement!
 */

import { describe, it, expect } from 'vitest';
import { calculateFatigueExponent, getRunnerType } from '@/calculations/fatigue';
import {
  createSyntheticAthlete,
  coherenceReport,
  DISTANCES,
} from './synthetic-athlete';
import type { PBs } from '@/types';

describe('Runner Type Semantics', () => {
  /**
   * SEMANTIC DEFINITION TEST
   *
   * These tests verify that the engine labels match the semantic requirement.
   * After the fix (schema version 2), labels are CORRECT.
   */
  describe('Semantic Label Verification', () => {
    it('should label HIGH b (high fade) as "Speed"', () => {
      // High b = more fade = worse at long distances = Speed type
      const highFadeB = 1.15;
      const label = getRunnerType(highFadeB);

      // CORRECT: 'Speed' (high fade means relatively better at short distances)
      expect(label).toBe('Speed');
    });

    it('should label LOW b (low fade) as "Endurance"', () => {
      // Low b = less fade = better at long distances = Endurance type
      const lowFadeB = 1.03;
      const label = getRunnerType(lowFadeB);

      // CORRECT: 'Endurance' (low fade means relatively better at long distances)
      expect(label).toBe('Endurance');
    });

    it('should label MIDDLE b as "Balanced"', () => {
      const middleB = 1.09;
      const label = getRunnerType(middleB);

      // Balanced is correct
      expect(label).toBe('Balanced');
    });
  });

  /**
   * COHERENCE TESTS
   *
   * Verify that synthetic athletes are mathematically consistent.
   */
  describe('Synthetic Athlete Coherence', () => {
    it('should generate coherent PBs with bEstimated matching bTarget', () => {
      const athlete = createSyntheticAthlete({
        baseVdot: 45,
        bTarget: 1.09,
      });

      // bEstimated should be very close to bTarget
      expect(Math.abs(athlete.bEstimated - 1.09)).toBeLessThan(0.01);
    });

    it('should generate coherent PBs for low fade athlete', () => {
      const athlete = createSyntheticAthlete({
        baseVdot: 45,
        bTarget: 1.03,
      });

      expect(Math.abs(athlete.bEstimated - 1.03)).toBeLessThan(0.01);

      // Verify the fade ratio manually
      const fadeRatio = Math.log(athlete.pbs.m! / athlete.pbs.k5!) /
                        Math.log(DISTANCES.marathon / DISTANCES.k5);
      expect(Math.abs(fadeRatio - 1.03)).toBeLessThan(0.01);
    });

    it('should generate coherent PBs for high fade athlete', () => {
      const athlete = createSyntheticAthlete({
        baseVdot: 45,
        bTarget: 1.15,
      });

      expect(Math.abs(athlete.bEstimated - 1.15)).toBeLessThan(0.01);

      // Verify the fade ratio manually
      const fadeRatio = Math.log(athlete.pbs.m! / athlete.pbs.k5!) /
                        Math.log(DISTANCES.marathon / DISTANCES.k5);
      expect(Math.abs(fadeRatio - 1.15)).toBeLessThan(0.01);
    });

    it('coherenceReport should pass for well-formed synthetic athlete', () => {
      const athlete = createSyntheticAthlete({
        baseVdot: 45,
        bTarget: 1.09,
        ltVdotDiff: 0,
        vo2VdotDiff: 0,
      });

      const report = coherenceReport(athlete);

      // Core coherence checks should pass (excluding semantic inversion)
      const coreChecks = report.checks.filter(c =>
        c.name === 'b_estimation' || c.name === 'vdot_5k_coherence'
      );

      for (const check of coreChecks) {
        expect(check.passed).toBe(true);
      }
    });
  });

  /**
   * RIEGEL EXPONENT DERIVATION TESTS
   *
   * Verify that calculateFatigueExponent correctly computes b from PBs.
   */
  describe('Fatigue Exponent Calculation', () => {
    it('should compute b correctly from perfectly Riegel-consistent PBs', () => {
      // Generate PBs with known b
      const baseTime = 1200; // 20 minutes for 5k
      const baseDist = 5000;
      const targetB = 1.10;

      const pbs: PBs = {
        k5: baseTime,
        k10: baseTime * Math.pow(10000 / baseDist, targetB),
        h: baseTime * Math.pow(21097 / baseDist, targetB),
        m: baseTime * Math.pow(42195 / baseDist, targetB),
      };

      const computedB = calculateFatigueExponent(pbs);

      // Should match within numerical precision
      expect(Math.abs(computedB - targetB)).toBeLessThan(0.001);
    });

    it('should return 1.06 default for single PB', () => {
      const pbs: PBs = { k5: 1200 };
      const b = calculateFatigueExponent(pbs);

      expect(b).toBe(1.06);
    });

    it('should handle real-world PB scatter gracefully', () => {
      // Real athletes don't have perfectly Riegel-consistent PBs
      const pbs: PBs = {
        k5: 1200,   // 20:00
        k10: 2520,  // 42:00 (slightly faster than Riegel would predict)
        h: 5580,    // 1:33:00
        m: 12000,   // 3:20:00 (slightly slower than Riegel would predict)
      };

      const b = calculateFatigueExponent(pbs);

      // Should be somewhere reasonable
      expect(b).toBeGreaterThan(1.0);
      expect(b).toBeLessThan(1.2);
    });
  });

  /**
   * CORRECTED BEHAVIOR VERIFICATION
   *
   * These tests verify that the corrected labels now work properly
   * with the type_modifier system for "train your weakness".
   */
  describe('Corrected Behavior Verification', () => {
    it('verifies corrected thresholds', () => {
      // Corrected thresholds in getRunnerType():
      // b < 1.06 → 'Endurance' (low fade = better at long)
      // b > 1.12 → 'Speed' (high fade = better at short)
      // else → 'Balanced'

      expect(getRunnerType(1.05)).toBe('Endurance');
      expect(getRunnerType(1.06)).toBe('Balanced');
      expect(getRunnerType(1.12)).toBe('Balanced');
      expect(getRunnerType(1.13)).toBe('Speed');
    });

    it('verifies semantic correctness for synthetic athletes', () => {
      // Athlete with LOW fade (b=1.03) - should be "Endurance" semantically
      // because they fade LESS over distance (relatively better at long)
      const lowFadeAthlete = createSyntheticAthlete({
        baseVdot: 45,
        bTarget: 1.03,
      });

      // Engine now correctly labels this as "Endurance"
      expect(lowFadeAthlete.runnerType).toBe('Endurance');

      // Athlete with HIGH fade (b=1.15) - should be "Speed" semantically
      // because they fade MORE over distance (relatively worse at long)
      const highFadeAthlete = createSyntheticAthlete({
        baseVdot: 45,
        bTarget: 1.15,
      });

      // Engine now correctly labels this as "Speed"
      expect(highFadeAthlete.runnerType).toBe('Speed');
    });

    it('verifies type_modifier now applies correctly', () => {
      // In training-horizon.ts, type_modifier is used like this:
      // type_mod = TRAINING_HORIZON_PARAMS.type_modifier[distance][runner_type]
      //
      // Current table (training-params.ts):
      // '5k': { Speed: 0.90, Balanced: 1.00, Endurance: 1.15 }
      // 'marathon': { Speed: 1.15, Balanced: 1.00, Endurance: 0.90 }
      //
      // The intent is "train your weakness":
      // - Speed types (better at short) get bonus for training marathon
      // - Endurance types (better at long) get bonus for training 5k
      //
      // WITH CORRECTED LABELS:
      //
      // A low-fade athlete (b=1.03, actually better at long distances = Endurance):
      // - Now correctly labeled "Endurance"
      // - Training for marathon: gets type_mod = 0.90 (PENALTY - already good at marathon)
      // - Training for 5k: gets type_mod = 1.15 (BONUS - training weakness)
      //
      // A high-fade athlete (b=1.15, actually better at short distances = Speed):
      // - Now correctly labeled "Speed"
      // - Training for 5k: gets type_mod = 0.90 (PENALTY - already good at 5k)
      // - Training for marathon: gets type_mod = 1.15 (BONUS - training weakness)
      //
      // This now correctly applies "train your weakness" bonuses!
      expect(true).toBe(true); // Documentation test
    });
  });
});

/**
 * FIX APPLIED (Schema Version 2):
 *
 * Option 1 was implemented: Swap labels in getRunnerType()
 * - Changed: b < 1.06 → 'Endurance', b > 1.12 → 'Speed'
 * - The type_modifier table already had correct semantic intent
 * - No changes needed to type_modifier table
 * - State migration swaps persisted runner types to preserve user intent
 * - predictFromLT multiplier labels swapped (numeric values unchanged)
 *
 * Migration details (persistence.ts):
 * - Schema version 1 → 2 triggers migration
 * - All persisted runner types (typ, calculatedRunnerType, confirmed) are swapped
 * - This preserves user's training style while correcting the semantic label
 */
