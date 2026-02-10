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
        it('should return 0.5 (Pure Efficiency) for Low RPE + Low HR', () => {
            // Steady state easy run
            // Expected RPE 3, actual 2 (rpeDelta = -1)
            // HR intensity 0.8 (below center)
            const shift = calculateEfficiencyShift(2, 3, 0.8, 'easy');
            expect(shift).toBe(0.5);
        });

        it('should return -0.4 (Cardiovascular Strain) for Low RPE + High HR', () => {
            // Expected RPE 3, actual 2 (rpeDelta = -1)
            // HR intensity 1.4 (high)
            const shift = calculateEfficiencyShift(2, 3, 1.4, 'easy');
            expect(shift).toBe(-0.4);
        });

        it('should return -0.2 (Struggle) for High RPE + High HR', () => {
            // Expected RPE 3, actual 5 (rpeDelta = 2)
            // HR intensity 1.2 (above center)
            const shift = calculateEfficiencyShift(5, 3, 1.2, 'easy');
            expect(shift).toBe(-0.2);
        });

        it('should return -0.6 (Suppression) for High RPE + Low Peak HR (Intervals)', () => {
            // Interval session
            // Expected RPE 8, actual 9 (rpeDelta = 1)
            // HR intensity 0.6 (very low for target)
            const shift = calculateEfficiencyShift(9, 8, 0.6, 'intervals');
            expect(shift).toBe(-0.6);
        });

        it('should return 0 for neutral results', () => {
            const shift = calculateEfficiencyShift(3, 3, 1.0, 'easy');
            expect(shift).toBe(0);
        });
    });
});
