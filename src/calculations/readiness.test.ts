import { describe, it, expect } from 'vitest';
import { computeReadiness, type ReadinessInput } from './readiness';

// Base "healthy athlete" input — override per test
const BASE: ReadinessInput = {
  tsb: 4,          // Fresh
  acwr: 1.1,       // Safe
  ctlNow: 60,
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

describe('computeReadiness — score labels (non-linear curves)', () => {

  it('Primed when TSB very fresh + ACWR low + good recovery', () => {
    // Primed requires all three signals strong (non-linear curves compress scores).
    // daily TSB +15 (weekly 105), ACWR 0.85, recovery 85 → composite ~78
    const r = computeReadiness({ ...BASE, tsb: 105, acwr: 0.85, sleepScore: 85 });
    expect(r.label).toBe('Primed');
    expect(r.score).toBeGreaterThanOrEqual(75);
  });

  it('On Track for balanced load', () => {
    // daily TSB +4 (weekly 28), ACWR 1.0, recovery 75 → composite ~62
    const r = computeReadiness({ ...BASE, tsb: 28, acwr: 1.0, sleepScore: 75 });
    expect(r.label).toBe('On Track');
    expect(r.score).toBeGreaterThanOrEqual(55);
    expect(r.score).toBeLessThan(75);
  });

  it('Manage Load when TSB moderately negative', () => {
    // daily TSB ~-4 (weekly -30), ACWR 1.2 → compressed by non-linear curves
    const r = computeReadiness({ ...BASE, tsb: -30, acwr: 1.2, ctlNow: 55 });
    expect(r.label).toBe('Manage Load');
    expect(r.score).toBeGreaterThanOrEqual(35);
    expect(r.score).toBeLessThan(55);
  });

  it('Ease Back when deeply fatigued', () => {
    const r = computeReadiness({ ...BASE, tsb: -140, acwr: 1.1 });
    expect(r.label).toBe('Ease Back');
    expect(r.score).toBeLessThan(35);
  });

});

describe('computeReadiness — safety floor (recalibrated for non-linear)', () => {

  it('ACWR above cautionUpper caps score at 34 and labels Overreaching', () => {
    const r = computeReadiness({ ...BASE, tsb: 20, acwr: 1.6, ctlNow: 80, sleepScore: 90 });
    expect(r.score).toBeLessThanOrEqual(34);
    expect(r.label).toBe('Overreaching');
    expect(r.hardFloor).toBe('acwr');
  });

  it('ACWR between safeUpper and cautionUpper caps score at 54', () => {
    // Default safeUpper = 1.3, so ACWR 1.4 is above safe but below caution (1.5)
    const r = computeReadiness({ ...BASE, tsb: 15, acwr: 1.4, ctlNow: 80, sleepScore: 90 });
    expect(r.score).toBeLessThanOrEqual(54);
    expect(r.label).toBe('Manage Load');
  });

  it('ACWR exactly at cautionUpper caps at 54 (not 34)', () => {
    // Default safeUpper = 1.3, cautionUpper = 1.5. ACWR exactly 1.5 is NOT > cautionUpper.
    const r = computeReadiness({ ...BASE, tsb: 10, acwr: 1.5, ctlNow: 70 });
    expect(r.score).toBeLessThanOrEqual(54);
  });

  it('ACWR exactly at safeUpper does NOT apply floor', () => {
    // At acwr=1.3 (default safeUpper), no floor — score from formula only
    const r = computeReadiness({ ...BASE, tsb: 8, acwr: 1.3, ctlNow: 65 });
    expect(r.hardFloor).toBeNull();
  });

});

describe('computeReadiness — sleep floor', () => {

  it('sleep < 45 caps score at 54 regardless of freshness', () => {
    const r = computeReadiness({ ...BASE, tsb: 20, acwr: 0.9, ctlNow: 70, sleepScore: 40 });
    expect(r.score).toBeLessThanOrEqual(54);
  });

  it('sleep 45-59 caps score at 74 — prevents Primed on a bad night', () => {
    const r = computeReadiness({ ...BASE, tsb: 20, acwr: 0.9, ctlNow: 70, sleepScore: 54 });
    expect(r.score).toBeLessThanOrEqual(74);
    expect(r.label).not.toBe('Primed');
  });

  it('sleep >= 60 does not apply sleep floor', () => {
    // Sleep 60 = above the 45/60 thresholds, so no sleep floor.
    // Score may still be capped by recovery floor, but not by sleep floor.
    const r = computeReadiness({ ...BASE, tsb: 140, acwr: 0.9, ctlNow: 70, sleepScore: 60 });
    expect(r.hardFloor).not.toBe('sleep');
  });

  it('sleep floor overrides only when it is the binding constraint', () => {
    const r = computeReadiness({ ...BASE, tsb: 10, acwr: 1.4, ctlNow: 70, sleepScore: 40 });
    expect(r.score).toBeLessThanOrEqual(54);
  });

});

describe('computeReadiness — recovery integration', () => {

  it('excludes recovery from formula when no watch data', () => {
    const r = computeReadiness({ ...BASE, sleepScore: null, hrvRmssd: null });
    expect(r.hasRecovery).toBe(false);
    expect(r.recoveryScore).toBeNull();
  });

  it('includes recovery when sleepScore present — falls back to raw when no history', () => {
    const r = computeReadiness({ ...BASE, sleepScore: 80 });
    expect(r.hasRecovery).toBe(true);
    expect(r.recoveryScore).toBe(80);
  });

  it('sleep score passes through as-is from Garmin when history available', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ sleepScore: 85, date: `2026-02-${String(i + 1).padStart(2, '0')}` }));
    const r = computeReadiness({ ...BASE, sleepScore: 54, sleepHistory: history });
    expect(r.hasRecovery).toBe(true);
    expect(r.recoveryScore).toBeDefined();
  });

  it('good sleeper with average night: recovery score reflects Garmin score directly', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ sleepScore: 80, date: `2026-02-${String(i + 1).padStart(2, '0')}` }));
    const r = computeReadiness({ ...BASE, sleepScore: 80, sleepHistory: history });
    expect(r.hasRecovery).toBe(true);
    expect(r.recoveryScore).toBeGreaterThan(55);
  });

  it('HRV does not modify recoveryScore (HRV is a composite floor only)', () => {
    const rGoodHrv = computeReadiness({ ...BASE, sleepScore: 60, hrvRmssd: 60, hrvPersonalAvg: 50 });
    const rBadHrv  = computeReadiness({ ...BASE, sleepScore: 60, hrvRmssd: 40, hrvPersonalAvg: 60 });
    expect(rGoodHrv.recoveryScore).toBe(60);
    expect(rBadHrv.recoveryScore).toBe(60);
  });

  it('ignores HRV when no personal average', () => {
    const r = computeReadiness({ ...BASE, hrvRmssd: 55, hrvPersonalAvg: null });
    expect(r.hasRecovery).toBe(true);
    expect(r.recoveryScore).toBeNull();
  });

});

describe('computeReadiness — driving signal', () => {

  it('driving signal is safety when ACWR is very high', () => {
    const r = computeReadiness({ ...BASE, tsb: 5, acwr: 1.8, ctlNow: 70 });
    expect(r.drivingSignal).toBe('safety');
  });

  it('driving signal is fitness when TSB very negative', () => {
    const r = computeReadiness({ ...BASE, tsb: -35, acwr: 1.05 });
    expect(r.drivingSignal).toBe('fitness');
  });

  it('driving signal is fitness when TSB is moderate and ACWR is safe', () => {
    const r = computeReadiness({ ...BASE, tsb: 2, acwr: 1.05 });
    expect(r.drivingSignal).toBe('fitness');
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
    const r = computeReadiness({ ...BASE, tsb: -200, acwr: 1.1 });
    expect(r.sentence).toContain('Deep fatigue');
  });

  it('Fatigued + High', () => {
    const r = computeReadiness({ ...BASE, tsb: -105, acwr: 1.6 });
    expect(r.sentence).toContain('Skip or active recovery');
  });

  it('Recovering + Moderate', () => {
    const r = computeReadiness({ ...BASE, tsb: -5, acwr: 1.4 });
    expect(r.sentence).toContain('Prioritise sleep');
  });

});

describe('computeReadiness — deload / taper edge cases', () => {

  it('taper with very fresh TSB, low ACWR, good recovery → Primed', () => {
    const r = computeReadiness({ ...BASE, tsb: 105, acwr: 0.85, ctlNow: 65, sleepScore: 85 });
    expect(r.label).toBe('Primed');
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
    const result = computeReadiness({
      tsb: 14,
      acwr: 1.1,
      ctlNow: 200,
      weeksOfHistory: 5,
    });
    expect(result.score).toBeGreaterThanOrEqual(35);
    expect(result.label).not.toBe('Ease Back');
  });

  it('should still detect genuine overtraining even with same-signal TSB', () => {
    const result = computeReadiness({
      tsb: -30,
      acwr: 1.4,
      ctlNow: 150,
      weeksOfHistory: 5,
    });
    expect(result.score).toBeLessThan(50);
  });

});
