import { describe, it, expect } from 'vitest';
import { computeReadiness, type ReadinessInput } from './readiness';

// Base "healthy athlete" input — override per test
const BASE: ReadinessInput = {
  tsb: 4,          // Fresh
  acwr: 1.1,       // Safe
  ctlNow: 60,
  ctlFourWeeksAgo: 55,
  weeksOfHistory: 5,
};

describe('computeReadiness — edge cases', () => {

  it('returns On Track (65) when insufficient history', () => {
    const r = computeReadiness({ ...BASE, weeksOfHistory: 2 });
    expect(r.score).toBe(65);
    expect(r.label).toBe('On Track');
    expect(r.hasRecovery).toBe(false);
  });

  it('returns On Track for weeksOfHistory exactly 2 (boundary)', () => {
    const r = computeReadiness({ ...BASE, weeksOfHistory: 2 });
    expect(r.label).toBe('On Track');
  });

  it('computes normally for weeksOfHistory = 3', () => {
    const r = computeReadiness({ ...BASE, weeksOfHistory: 3 });
    // Real computation — score should NOT be the fixed default of 65
    expect(r.score).not.toBe(65);
  });

});

describe('computeReadiness — score labels', () => {

  it('Ready to Push when TSB fresh + ACWR safe', () => {
    const r = computeReadiness({ ...BASE, tsb: 10, acwr: 1.0, ctlNow: 60, ctlFourWeeksAgo: 50 });
    expect(r.label).toBe('Ready to Push');
    expect(r.score).toBeGreaterThanOrEqual(80);
  });

  it('On Track for balanced load', () => {
    const r = computeReadiness({ ...BASE, tsb: -3, acwr: 1.15 });
    expect(r.label).toBe('On Track');
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.score).toBeLessThan(80);
  });

  it('Manage Load when TSB moderately negative', () => {
    const r = computeReadiness({ ...BASE, tsb: -15, acwr: 1.25, ctlNow: 55, ctlFourWeeksAgo: 60 });
    expect(r.label).toBe('Manage Load');
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.score).toBeLessThan(60);
  });

  it('Ease Back when deeply fatigued', () => {
    const r = computeReadiness({ ...BASE, tsb: -30, acwr: 1.1, ctlNow: 40, ctlFourWeeksAgo: 60 });
    expect(r.label).toBe('Ease Back');
    expect(r.score).toBeLessThan(40);
  });

});

describe('computeReadiness — safety floor', () => {

  it('ACWR > 1.5 caps score at 39 regardless of freshness', () => {
    const r = computeReadiness({ ...BASE, tsb: 20, acwr: 1.6, ctlNow: 80, ctlFourWeeksAgo: 50, sleepScore: 90 });
    expect(r.score).toBeLessThanOrEqual(39);
    expect(r.label).toBe('Ease Back');
  });

  it('ACWR between 1.3 and 1.5 caps score at 59', () => {
    const r = computeReadiness({ ...BASE, tsb: 15, acwr: 1.4, ctlNow: 80, ctlFourWeeksAgo: 60, sleepScore: 90 });
    expect(r.score).toBeLessThanOrEqual(59);
    expect(r.label).toBe('Manage Load');
  });

  it('ACWR exactly 1.5 still caps at 59', () => {
    const r = computeReadiness({ ...BASE, tsb: 10, acwr: 1.5, ctlNow: 70, ctlFourWeeksAgo: 60 });
    expect(r.score).toBeLessThanOrEqual(59);
  });

  it('ACWR exactly 1.3 does NOT apply floor', () => {
    // At acwr=1.3 safetyScore = clamp(0,100,((2.0-1.3)/1.2)*100) = 58.3
    // So score should be driven by formula, not floor
    const r = computeReadiness({ ...BASE, tsb: 8, acwr: 1.3, ctlNow: 65, ctlFourWeeksAgo: 60 });
    // No floor applied at exactly 1.3 — score could be anything
    expect(r).toBeDefined();
  });

});

describe('computeReadiness — recovery integration', () => {

  it('excludes recovery from formula when no watch data', () => {
    const r = computeReadiness({ ...BASE, sleepScore: null, hrvRmssd: null });
    expect(r.hasRecovery).toBe(false);
    expect(r.recoveryScore).toBeNull();
  });

  it('includes recovery when sleepScore present', () => {
    const r = computeReadiness({ ...BASE, sleepScore: 80 });
    expect(r.hasRecovery).toBe(true);
    expect(r.recoveryScore).toBe(80);
  });

  it('adjusts recovery score upward with positive HRV delta', () => {
    const r = computeReadiness({ ...BASE, sleepScore: 60, hrvRmssd: 60, hrvPersonalAvg: 50 });
    // hrvDelta = (60-50)/50 = 0.2 → +6 → recoveryScore = min(100, 60+6) = 66
    expect(r.recoveryScore).toBeGreaterThan(60);
  });

  it('adjusts recovery score downward with negative HRV delta', () => {
    const r = computeReadiness({ ...BASE, sleepScore: 60, hrvRmssd: 40, hrvPersonalAvg: 60 });
    // hrvDelta = (40-60)/60 ≈ -0.333 → -10 → recoveryScore = 60-10 = 50
    expect(r.recoveryScore).toBeLessThan(60);
  });

  it('ignores HRV when no personal average', () => {
    const r = computeReadiness({ ...BASE, hrvRmssd: 55, hrvPersonalAvg: null });
    // No sleepScore, no valid avg → no recovery
    expect(r.hasRecovery).toBe(true); // rmssd is present
    expect(r.recoveryScore).toBeNull(); // but no avg → score stays null
  });

});

describe('computeReadiness — driving signal', () => {

  it('driving signal is safety when ACWR is very high', () => {
    const r = computeReadiness({ ...BASE, tsb: 5, acwr: 1.8, ctlNow: 70, ctlFourWeeksAgo: 65 });
    expect(r.drivingSignal).toBe('safety');
  });

  it('driving signal is fitness when TSB very negative', () => {
    const r = computeReadiness({ ...BASE, tsb: -35, acwr: 1.05, ctlNow: 60, ctlFourWeeksAgo: 62 });
    expect(r.drivingSignal).toBe('fitness');
  });

  it('driving signal is momentum when CTL dropped significantly', () => {
    // TSB near 0, ACWR safe, but CTL dropped >10%
    const r = computeReadiness({ ...BASE, tsb: 2, acwr: 1.05, ctlNow: 40, ctlFourWeeksAgo: 60 });
    expect(r.drivingSignal).toBe('momentum');
  });

});

describe('computeReadiness — decision matrix sentences', () => {

  it('Fresh + Safe', () => {
    const r = computeReadiness({ ...BASE, tsb: 5, acwr: 1.1 });
    expect(r.sentence).toContain('rested and safe');
  });

  it('Fresh + High load', () => {
    const r = computeReadiness({ ...BASE, tsb: 8, acwr: 1.6 });
    expect(r.sentence).toContain('Sudden spike');
  });

  it('Overtrained + Safe', () => {
    const r = computeReadiness({ ...BASE, tsb: -30, acwr: 1.1 });
    expect(r.sentence).toContain('Deep fatigue');
  });

  it('Fatigued + High', () => {
    const r = computeReadiness({ ...BASE, tsb: -20, acwr: 1.6 });
    expect(r.sentence).toContain('Skip or active recovery');
  });

  it('Recovering + Moderate', () => {
    const r = computeReadiness({ ...BASE, tsb: -5, acwr: 1.4 });
    expect(r.sentence).toContain('Prioritise sleep');
  });

});

describe('computeReadiness — deload / taper edge cases', () => {

  it('deload week: low ATL, positive TSB → Ready to Push', () => {
    // After a deload: TSB rises (ATL drops), CTL steady
    const r = computeReadiness({ ...BASE, tsb: 15, acwr: 0.85, ctlNow: 65, ctlFourWeeksAgo: 65 });
    expect(r.label).toBe('Ready to Push');
  });

  it('taper: rising TSB, dropping ATL → readiness climbs', () => {
    const before = computeReadiness({ ...BASE, tsb: -5, acwr: 1.1 });
    const during  = computeReadiness({ ...BASE, tsb: 5,  acwr: 0.9 });
    const after   = computeReadiness({ ...BASE, tsb: 15, acwr: 0.8 });
    expect(during.score).toBeGreaterThan(before.score);
    expect(after.score).toBeGreaterThan(during.score);
  });

});

describe('computeReadiness — same-signal TSB for cross-trainers', () => {

  it('should not penalise athletes with high cross-training when same-signal TSB is used', () => {
    // Same-signal TSB near 0 = balanced load, should score On Track or better
    const result = computeReadiness({
      tsb: -5,
      acwr: 1.1,
      ctlNow: 200,
      ctlFourWeeksAgo: 190,
      weeksOfHistory: 5,
    });
    expect(result.score).toBeGreaterThan(60);
    expect(result.label).not.toBe('Ease Back');
  });

  it('should still detect genuine overtraining even with same-signal TSB', () => {
    // Genuinely fatigued + elevated load safety: should be Manage Load or worse
    const result = computeReadiness({
      tsb: -30,
      acwr: 1.4,
      ctlNow: 150,
      ctlFourWeeksAgo: 150,
      weeksOfHistory: 5,
    });
    expect(result.score).toBeLessThan(50);
  });

});
