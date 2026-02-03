import { describe, it, expect } from 'vitest';
import { getCommuteDistance } from './commute';

describe('Commute', () => {
  describe('getCommuteDistance', () => {
    it('should return total distance for bidirectional commute', () => {
      const config = {
        enabled: true,
        distanceKm: 5,
        isBidirectional: true,
        commuteDaysPerWeek: 5,
      };
      expect(getCommuteDistance(config)).toBe(10);
    });

    it('should return one-way distance for non-bidirectional commute', () => {
      const config = {
        enabled: true,
        distanceKm: 7,
        isBidirectional: false,
        commuteDaysPerWeek: 3,
      };
      expect(getCommuteDistance(config)).toBe(7);
    });

    it('should return 0 when disabled', () => {
      const config = {
        enabled: false,
        distanceKm: 5,
        isBidirectional: true,
        commuteDaysPerWeek: 5,
      };
      expect(getCommuteDistance(config)).toBe(0);
    });
  });
});
