import { describe, it, expect } from 'vitest';
import { generateBikeSession, pickBikeKind, type BikeSessionKind } from './bike';

const baseInput = {
  phase: 'build' as const,
  skill: 3 as const,
  weekIndex: 1,
  totalWeeks: 12,
  targetMinutes: 60,
  ftp: 250,
  hasPowerMeter: true,
};

describe('bike workout library — pro-grade kinds', () => {
  describe('over_under', () => {
    it('produces a session with both over and under power targets', () => {
      const w = generateBikeSession({ ...baseInput, kind: 'over_under', slotIndex: 0 });
      expect(w.t).toBe('bike_over_under');
      expect(w.discipline).toBe('bike');
      // Description must reference both above-FTP and below-FTP work
      // (covers all three variants — classic over-under, criss-cross, 2:1 ratio)
      expect(w.d).toMatch(/W/); // power label rendered
      expect(w.aerobic).toBeGreaterThan(0);
      expect(w.anaerobic).toBeGreaterThan(0);
      // Anaerobic share for over-unders is ~45% — sits between sweet-spot and threshold
      const total = w.aerobic! + w.anaerobic!;
      expect(w.anaerobic! / total).toBeGreaterThan(0.35);
      expect(w.anaerobic! / total).toBeLessThan(0.55);
    });

    it('rotates through three variants by week+slot index', () => {
      const variants = new Set<string>();
      for (let week = 1; week <= 6; week++) {
        const w = generateBikeSession({ ...baseInput, kind: 'over_under', weekIndex: week, slotIndex: 0 });
        variants.add(w.d);
      }
      expect(variants.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe('vo2_micros', () => {
    it('produces 30/30-style structure with high-intensity targets', () => {
      const w = generateBikeSession({ ...baseInput, kind: 'vo2_micros', phase: 'peak', slotIndex: 2 });
      expect(w.t).toBe('bike_vo2_micros');
      expect(w.r).toBe(9); // peak phase, no taper discount
      // Description references 30s reps in at least two of three variants
      expect(w.d).toMatch(/30s|40s/);
      // Anaerobic share around 55%
      const total = w.aerobic! + w.anaerobic!;
      expect(w.anaerobic! / total).toBeGreaterThan(0.45);
      expect(w.anaerobic! / total).toBeLessThan(0.65);
    });

    it('renders HR-zone label when no power meter', () => {
      const w = generateBikeSession({
        ...baseInput,
        kind: 'vo2_micros',
        hasPowerMeter: false,
        ftp: undefined,
        slotIndex: 0,
      });
      expect(w.d).toMatch(/Z\d/); // HR-zone fallback present
    });
  });

  describe('vlamax', () => {
    it('produces low-volume, high-intensity sprint structure', () => {
      const w = generateBikeSession({ ...baseInput, kind: 'vlamax', phase: 'peak', slotIndex: 2 });
      expect(w.t).toBe('bike_vlamax');
      // Sprints in 6-15s window referenced
      expect(w.d).toMatch(/6s|10s|15s|max|sprint/i);
      // Total TSS lower than threshold/VO2 of same duration — most of the
      // session is recovery
      expect(w.aerobic! + w.anaerobic!).toBeLessThan(80);
    });

    it('has predominantly anaerobic load (~75%)', () => {
      const w = generateBikeSession({ ...baseInput, kind: 'vlamax', slotIndex: 0 });
      const total = w.aerobic! + w.anaerobic!;
      expect(w.anaerobic! / total).toBeGreaterThan(0.65);
    });
  });
});

describe('pickBikeKind phase rotation', () => {
  it('exposes both sweet_spot and over_under at slot 0 across build weeks', () => {
    const kinds = new Set<BikeSessionKind>();
    for (let week = 0; week < 6; week++) {
      kinds.add(pickBikeKind('build', 0, week));
    }
    expect(kinds.has('sweet_spot')).toBe(true);
    expect(kinds.has('over_under')).toBe(true);
  });

  it('exposes vo2, vo2_micros, and vlamax at slot 2 across peak weeks', () => {
    const kinds = new Set<BikeSessionKind>();
    for (let week = 0; week < 6; week++) {
      kinds.add(pickBikeKind('peak', 2, week));
    }
    expect(kinds.has('vo2_micros') || kinds.has('vo2') || kinds.has('vlamax')).toBe(true);
    // Across 6 weeks the rotation should hit at least 2 of the 3 kinds
    const intensityKinds = ['vo2', 'vo2_micros', 'vlamax'].filter(k => kinds.has(k as BikeSessionKind));
    expect(intensityKinds.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps base phase aerobic — no supra-threshold kinds', () => {
    for (let week = 0; week < 6; week++) {
      for (let slot = 0; slot < 3; slot++) {
        const kind = pickBikeKind('base', slot, week);
        expect(['endurance', 'tempo']).toContain(kind);
      }
    }
  });

  it('endurance slot stays stable across weeks (recovery rides do not rotate)', () => {
    for (const phase of ['build', 'peak'] as const) {
      const slot1Kinds = new Set<BikeSessionKind>();
      for (let week = 0; week < 6; week++) {
        slot1Kinds.add(pickBikeKind(phase, 1, week));
      }
      expect(slot1Kinds.size).toBe(1);
      expect(slot1Kinds.has('endurance')).toBe(true);
    }
  });
});
