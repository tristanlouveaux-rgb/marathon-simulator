import { describe, it, expect } from 'vitest';
import { predictFromVolume, blendPredictions } from './predictions';

describe('predictFromVolume (Tanda 2011)', () => {
  it('returns null for non-marathon distances', () => {
    expect(predictFromVolume(5000, 60, 300)).toBeNull();
    expect(predictFromVolume(10000, 60, 300)).toBeNull();
    expect(predictFromVolume(21097, 60, 300)).toBeNull();
  });

  it('returns null when inputs missing or out of range', () => {
    expect(predictFromVolume(42195, undefined, 300)).toBeNull();
    expect(predictFromVolume(42195, 60, undefined)).toBeNull();
    expect(predictFromVolume(42195, 3, 300)).toBeNull();        // K < 4
    expect(predictFromVolume(42195, 130, 300)).toBeNull();      // K > 120
    expect(predictFromVolume(42195, 60, 170)).toBeNull();       // P < 3:00
    expect(predictFromVolume(42195, 60, 500)).toBeNull();       // P > 8:20
  });

  // Tanda reference sanity points. The paper's formula is:
  //   T = 11.03 + 98.46×exp(−0.0053×K) + 0.387×P
  // Verify at three realistic training profiles.
  it('matches Tanda formula at 80 km/wk, 5:00/km training pace', () => {
    // K=80, P=300 → T = 11.03 + 98.46×exp(−0.424) + 0.387×300
    //   = 11.03 + 64.5 + 116.1 ≈ 191.6 min (~3:11:40)
    const sec = predictFromVolume(42195, 80, 300)!;
    expect(sec / 60).toBeGreaterThan(189);
    expect(sec / 60).toBeLessThan(194);
  });

  it('penalises low-volume runners correctly', () => {
    // Same pace (5:00/km), but low-volume (15 km/wk) vs high (90 km/wk)
    const lowVol = predictFromVolume(42195, 15, 300)!;
    const highVol = predictFromVolume(42195, 90, 300)!;
    expect(lowVol).toBeGreaterThan(highVol);
    // The gap should be meaningful (minutes, not seconds)
    expect((lowVol - highVol) / 60).toBeGreaterThan(10);
  });

  it('rewards faster training pace at same volume', () => {
    const slow = predictFromVolume(42195, 60, 360)!;  // 6:00/km
    const fast = predictFromVolume(42195, 60, 270)!;  // 4:30/km
    expect(fast).toBeLessThan(slow);
  });
});

describe('blendPredictions Tanda gating', () => {
  const pbs = { m: 200 * 60 }; // 3:20 marathon PB
  const b = 1.06;

  it('gates Tanda out when weeksCovered < 4', () => {
    const withTanda = blendPredictions(
      42195, pbs, null, null, b, 'Balanced', null, undefined,
      60, 300,
      { weeksCovered: 8, paceConfidence: 'high', isStale: false },
    );
    const gated = blendPredictions(
      42195, pbs, null, null, b, 'Balanced', null, undefined,
      60, 300,
      { weeksCovered: 2, paceConfidence: 'high', isStale: false },
    );
    expect(withTanda).not.toBeNull();
    expect(gated).not.toBeNull();
    // Gated prediction should differ because Tanda (30% weight) is removed
    expect(withTanda).not.toBe(gated);
  });

  it('gates Tanda out when paceConfidence is low or none', () => {
    const high = blendPredictions(
      42195, pbs, null, null, b, 'Balanced', null, undefined,
      60, 300,
      { weeksCovered: 8, paceConfidence: 'high', isStale: false },
    );
    const low = blendPredictions(
      42195, pbs, null, null, b, 'Balanced', null, undefined,
      60, 300,
      { weeksCovered: 8, paceConfidence: 'low', isStale: false },
    );
    expect(high).not.toBe(low);
  });

  it('gates Tanda out when data is stale', () => {
    const fresh = blendPredictions(
      42195, pbs, null, null, b, 'Balanced', null, undefined,
      60, 300,
      { weeksCovered: 8, paceConfidence: 'high', isStale: false },
    );
    const stale = blendPredictions(
      42195, pbs, null, null, b, 'Balanced', null, undefined,
      60, 300,
      { weeksCovered: 8, paceConfidence: 'high', isStale: true },
    );
    expect(fresh).not.toBe(stale);
  });

  it('allows Tanda when volumeMeta is omitted (backwards compat)', () => {
    const t = blendPredictions(
      42195, pbs, null, null, b, 'Balanced', null, undefined,
      60, 300,
    );
    expect(t).not.toBeNull();
  });
});
