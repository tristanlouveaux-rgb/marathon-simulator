import { describe, it, expect } from 'vitest';
import { BIKE_INTENSITY_LADDER, SWIM_INTENSITY_LADDER } from './triathlon-constants';
import { intensityTargetLabel } from '@/ui/workout-adjust-overlay';
import type { Workout } from '@/types/state';

describe('intensity ladders', () => {
  it('bike ladder is monotonically harder (ascending %FTP)', () => {
    for (let i = 1; i < BIKE_INTENSITY_LADDER.length; i++) {
      expect(BIKE_INTENSITY_LADDER[i].pct).toBeGreaterThan(BIKE_INTENSITY_LADDER[i - 1].pct);
    }
  });
  it('swim ladder is monotonically faster (descending sec/100m offset)', () => {
    for (let i = 1; i < SWIM_INTENSITY_LADDER.length; i++) {
      expect(SWIM_INTENSITY_LADDER[i].cssOffsetSec).toBeLessThan(SWIM_INTENSITY_LADDER[i - 1].cssOffsetSec);
    }
  });
});

describe('intensityTargetLabel', () => {
  const w = (intensityLevel?: string): Workout => ({ t: 'cross_training', n: 'Bike', d: '60 min', intensityLevel } as Workout);

  it('returns null when no rung is set', () => {
    expect(intensityTargetLabel(w(undefined), 250, 95)).toBeNull();
  });

  it('renders a bike watt range from FTP at the rung pct', () => {
    // bike_threshold: pct 1.00, band 0.05 → 250*1.00*(0.95..1.05) = 238–263W
    expect(intensityTargetLabel(w('bike_threshold'), 250, undefined)).toBe('Threshold · 238–263W');
  });

  it('renders a harder rung as more watts than an easier one', () => {
    const endurance = intensityTargetLabel(w('bike_endurance'), 250, undefined)!;
    const vo2 = intensityTargetLabel(w('bike_vo2'), 250, undefined)!;
    const wattsOf = (s: string) => parseInt(s.match(/(\d+)–/)![1], 10);
    expect(wattsOf(vo2)).toBeGreaterThan(wattsOf(endurance));
  });

  it('renders a swim pace from CSS + the rung offset', () => {
    // swim_threshold offset 0, css 95 sec/100m → 1:35/100m
    expect(intensityTargetLabel(w('swim_threshold'), undefined, 95)).toBe('CSS intervals · 1:35/100m');
    // swim_speed offset -6 → 89s → 1:29/100m (faster)
    expect(intensityTargetLabel(w('swim_speed'), undefined, 95)).toBe('Speed · 1:29/100m');
  });

  it('returns null for a bike rung when FTP is missing', () => {
    expect(intensityTargetLabel(w('bike_threshold'), undefined, undefined)).toBeNull();
  });
});
