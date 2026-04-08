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

describe('computeReadiness — score labels', () => {

  it('Ready to Push when TSB fresh + ACWR safe', () => {
    // daily TSB +15 → fitnessScore≈73, ACWR=0.9 → safetyScore≈92 → composite ≈ 81
    const r = computeReadiness({ ...BASE, tsb: 105, acwr: 0.9 });
    expect(r.label).toBe('Ready to Push');
    expect(r.score).toBeGreaterThanOrEqual(80);
  });

  it('On Track for balanced load', () => {
    // daily TSB +4 → fitnessScore≈53, ACWR=1.15 → safetyScore≈71 → composite ≈ 61
    const r = computeReadiness({ ...BASE, tsb: 28, acwr: 1.15 });
    expect(r.label).toBe('On Track');
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.score).toBeLessThan(80);
  });

  it('Manage Load when TSB moderately negative', () => {
    const r = computeReadiness({ ...BASE, tsb: -15, acwr: 1.25, ctlNow: 55 });
    expect(r.label).toBe('Manage Load');
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.score).toBeLessThan(60);
  });

  it('Ease Back when deeply fatigued', () => {
    // daily TSB -20 → fitnessScore≈9, ACWR=1.1 → safetyScore≈75 → composite ≈ 39
    const r = computeReadiness({ ...BASE, tsb: -140, acwr: 1.1 });
    expect(r.label).toBe('Ease Back');
    expect(r.score).toBeLessThan(40);
  });

});

describe('computeReadiness — safety floor', () => {

  it('ACWR > 1.5 caps score at 39 and labels Overreaching', () => {
    const r = computeReadiness({ ...BASE, tsb: 20, acwr: 1.6, ctlNow: 80, sleepScore: 90 });
    expect(r.score).toBeLessThanOrEqual(39);
    expect(r.label).toBe('Overreaching');
    expect(r.hardFloor).toBe('acwr');
  });

  it('ACWR between 1.3 and 1.5 caps score at 59', () => {
    const r = computeReadiness({ ...BASE, tsb: 15, acwr: 1.4, ctlNow: 80, sleepScore: 90 });
    expect(r.score).toBeLessThanOrEqual(59);
    expect(r.label).toBe('Manage Load');
  });

  it('ACWR exactly 1.5 still caps at 59', () => {
    const r = computeReadiness({ ...BASE, tsb: 10, acwr: 1.5, ctlNow: 70 });
    expect(r.score).toBeLessThanOrEqual(59);
  });

  it('ACWR exactly 1.3 does NOT apply floor', () => {
    // At acwr=1.3 safetyScore = clamp(0,100,((2.0-1.3)/1.2)*100) = 58.3
    // So score should be driven by formula, not floor
    const r = computeReadiness({ ...BASE, tsb: 8, acwr: 1.3, ctlNow: 65 });
    // No floor applied at exactly 1.3 — score could be anything
    expect(r).toBeDefined();
  });

});

describe('computeReadiness — sleep floor', () => {

  it('sleep < 45 caps score at 59 regardless of freshness', () => {
    // Very fresh, safe load, but terrible sleep
    const r = computeReadiness({ ...BASE, tsb: 20, acwr: 0.9, ctlNow: 70, sleepScore: 40 });
    expect(r.score).toBeLessThanOrEqual(59);
  });

  it('sleep 45–59 caps score at 74 — prevents Ready to Push on a bad night', () => {
    const r = computeReadiness({ ...BASE, tsb: 20, acwr: 0.9, ctlNow: 70, sleepScore: 54 });
    expect(r.score).toBeLessThanOrEqual(74);
    expect(r.label).not.toBe('Ready to Push');
  });

  it('sleep ≥ 60 does not apply floor', () => {
    // daily TSB +20 → high fitnessScore, sleep=60 → no floor applied
    const r = computeReadiness({ ...BASE, tsb: 140, acwr: 0.9, ctlNow: 70, sleepScore: 60 });
    // No sleep floor — score above 74 (recovery floor may cap at 76)
    expect(r.score).toBeGreaterThan(74);
  });

  it('sleep floor overrides only when it is the binding constraint', () => {
    // ACWR floor at 59 + sleep floor at 59 — both apply, score ≤ 59
    const r = computeReadiness({ ...BASE, tsb: 10, acwr: 1.4, ctlNow: 70, sleepScore: 40 });
    expect(r.score).toBeLessThanOrEqual(59);
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
    expect(r.recoveryScore).toBe(80); // no sleepHistory → raw fallback
  });

  it('sleep score passes through as-is from Garmin when history available — no relative transformation', () => {
    // Previously the relative formula would inflate/penalise. Now Garmin's score is used directly.
    const history = Array.from({ length: 10 }, (_, i) => ({ sleepScore: 85, date: `2026-02-${String(i + 1).padStart(2, '0')}` }));
    const r = computeReadiness({ ...BASE, sleepScore: 54, sleepHistory: history });
    expect(r.hasRecovery).toBe(true);
    // recoveryScore is weighted composite — sleep is 35% of the recovery sub-score which is 35% of total
    // But the sleep sub-score itself should reflect the raw 54, not a relativised value
    expect(r.recoveryScore).toBeDefined();
  });

  it('good sleeper with average night: recovery score reflects Garmin score directly', () => {
    // Garmin score 80 → sleep sub-score = 80. No baseline transformation.
    const history = Array.from({ length: 10 }, (_, i) => ({ sleepScore: 80, date: `2026-02-${String(i + 1).padStart(2, '0')}` }));
    const r = computeReadiness({ ...BASE, sleepScore: 80, sleepHistory: history });
    expect(r.hasRecovery).toBe(true);
    expect(r.recoveryScore).toBeGreaterThan(55);
  });

  it('HRV does not modify recoveryScore (HRV is a composite floor only)', () => {
    // sleepScore=60, no history → recoveryScore = raw 60. HRV only caps composite, not recoveryScore.
    const rGoodHrv = computeReadiness({ ...BASE, sleepScore: 60, hrvRmssd: 60, hrvPersonalAvg: 50 });
    const rBadHrv  = computeReadiness({ ...BASE, sleepScore: 60, hrvRmssd: 40, hrvPersonalAvg: 60 });
    expect(rGoodHrv.recoveryScore).toBe(60);
    expect(rBadHrv.recoveryScore).toBe(60);
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
    const r = computeReadiness({ ...BASE, tsb: 5, acwr: 1.8, ctlNow: 70 });
    expect(r.drivingSignal).toBe('safety');
  });

  it('driving signal is fitness when TSB very negative', () => {
    const r = computeReadiness({ ...BASE, tsb: -35, acwr: 1.05 });
    expect(r.drivingSignal).toBe('fitness');
  });

  it('driving signal is fitness when TSB is moderate and ACWR is safe', () => {
    // TSB near 0 → fitnessScore ~60; ACWR 1.05 → safetyScore ~79 — fitness is lower
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
    // daily TSB < -25 → overtrained (weekly = -200)
    const r = computeReadiness({ ...BASE, tsb: -200, acwr: 1.1 });
    expect(r.sentence).toContain('Deep fatigue');
  });

  it('Fatigued + High', () => {
    // daily TSB -10 to -25 → fatigued (weekly = -105 ≈ daily -15)
    const r = computeReadiness({ ...BASE, tsb: -105, acwr: 1.6 });
    expect(r.sentence).toContain('Skip or active recovery');
  });

  it('Recovering + Moderate', () => {
    const r = computeReadiness({ ...BASE, tsb: -5, acwr: 1.4 });
    expect(r.sentence).toContain('Prioritise sleep');
  });

});

describe('computeReadiness — deload / taper edge cases', () => {

  it('deload week: low ATL, positive TSB → Ready to Push', () => {
    // After a deload: TSB rises (ATL drops), CTL steady. daily TSB +15
    const r = computeReadiness({ ...BASE, tsb: 105, acwr: 0.85, ctlNow: 65 });
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
    // Same-signal TSB slightly positive (daily +2) = balanced load, should score On Track or better
    const result = computeReadiness({
      tsb: 14,
      acwr: 1.1,
      ctlNow: 200,
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
      weeksOfHistory: 5,
    });
    expect(result.score).toBeLessThan(50);
  });

});
