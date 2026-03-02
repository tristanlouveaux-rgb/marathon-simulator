import { describe, it, expect } from 'vitest';
import { calculateIntensityScore, calculateEfficiencyShift } from './heart-rate';

describe('RPE + HR Fusion Logic', () => {
    describe('calculateIntensityScore', () => {
        const target = { min: 140, max: 150, label: '140-150 bpm', zone: 'Zone 2' };

        it('should return 1.0 for midpoint', () => {
            expect(calculateIntensityScore(145, target)).toBe(1.0);
        });

        it('should return 0.5 for min boundary', () => {
            expect(calculateIntensityScore(140, target)).toBe(0.5);
        });

        it('should return 1.5 for max boundary', () => {
            expect(calculateIntensityScore(150, target)).toBe(1.5);
        });

        it('should return < 0.5 for below range', () => {
            expect(calculateIntensityScore(135, target)).toBeLessThan(0.5);
        });

        it('should return > 1.5 for above range', () => {
            expect(calculateIntensityScore(155, target)).toBeGreaterThan(1.5);
        });
    });

    describe('calculateEfficiencyShift', () => {
        it('should return positive shift (Pure Efficiency) for Low RPE + Low HR', () => {
            // Expected RPE 3, actual 2 (rpeDelta = -1, felt easier)
            // HR intensity 0.75 (clearly below center — hrDelta = -0.25)
            // Branch: rpeDelta < 0 and hrDelta < -0.2 → shift = 0.3 * rpeMag
            // rpeMag = min(1/3, 1) ≈ 0.333 → shift ≈ 0.1
            const shift = calculateEfficiencyShift(2, 3, 0.75, 'easy');
            expect(shift).toBeCloseTo(0.1, 5);
        });

        it('should return negative shift (Cardiovascular Strain) for Low RPE + High HR', () => {
            // Expected RPE 3, actual 2 (rpeDelta = -1, felt easier)
            // HR intensity 1.4 (high — hrDelta = +0.4)
            // Branch: rpeDelta < 0 and hrDelta > 0.2 → shift = -0.25 * rpeMag
            // rpeMag ≈ 0.333 → shift ≈ -0.0833
            const shift = calculateEfficiencyShift(2, 3, 1.4, 'easy');
            expect(shift).toBeCloseTo(-0.0833, 3);
        });

        it('should return negative shift (Struggle) for High RPE + High HR', () => {
            // Expected RPE 3, actual 5 (rpeDelta = +2, felt harder)
            // HR intensity 1.25 (clearly above center — hrDelta = +0.25)
            // Branch: rpeDelta > 0 and hrDelta > 0.2 → shift = -0.15 * rpeMag
            // rpeMag = min(2/3, 1) ≈ 0.667 → shift ≈ -0.1
            const shift = calculateEfficiencyShift(5, 3, 1.25, 'easy');
            expect(shift).toBeCloseTo(-0.1, 5);
        });

        it('should return negative shift (Suppression) for High RPE + Low Peak HR (Intervals)', () => {
            // Interval session. Expected RPE 8, actual 9 (rpeDelta = +1)
            // HR intensity 0.6 (very low for target — hrDelta = -0.4)
            // Branch: rpeDelta > 0 and hrDelta < -0.2 and isInterval → shift = -0.35 * rpeMag
            // rpeMag ≈ 0.333 → shift ≈ -0.1167
            const shift = calculateEfficiencyShift(9, 8, 0.6, 'intervals');
            expect(shift).toBeCloseTo(-0.1167, 3);
        });

        it('should return 0 for neutral results', () => {
            const shift = calculateEfficiencyShift(3, 3, 1.0, 'easy');
            expect(shift).toBe(0);
        });
    });
});
