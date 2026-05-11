import { describe, expect, it } from 'vitest';
import { applyRunningCourseFactors } from './course-factors-running';
import type { CourseProfile } from '@/types/onboarding';

const MARATHON_KM = 42.195;
const FAST_MARATHON_SEC = 3 * 3600; // 3:00:00 baseline for these tests

describe('applyRunningCourseFactors', () => {
  it('returns identity when no profile is supplied', () => {
    const out = applyRunningCourseFactors(FAST_MARATHON_SEC, undefined, MARATHON_KM);
    expect(out.adjustedSec).toBe(FAST_MARATHON_SEC);
    expect(out.factors).toEqual([]);
    expect(out.multiplier).toBe(1);
  });

  it('returns near-identity for a flat-cool race (Berlin shape)', () => {
    const berlin: CourseProfile = {
      runElevationM: 60,    // genuinely flat; Minetti at 0.14% grade still adds ~+0.8% time
      runProfile: 'flat',
      climate: 'cool',      // reference baseline → no climate factor
      altitudeM: 34,        // below 500m floor → no altitude factor
    };
    const out = applyRunningCourseFactors(FAST_MARATHON_SEC, berlin, MARATHON_KM);
    // Climate cool + altitude < 500m both skipped — only the tiny elevation
    // factor remains. Minetti's polynomial credits any positive grade with
    // a small cost; 60m gain over 42km is ~+1.5min on a 3hr marathon.
    expect(out.adjustedSec).toBeGreaterThanOrEqual(FAST_MARATHON_SEC);
    expect(out.adjustedSec).toBeLessThan(FAST_MARATHON_SEC + 120); // < 2 minutes
    expect(out.factors.find(f => f.kind === 'climate')).toBeUndefined();
    expect(out.factors.find(f => f.kind === 'altitude')).toBeUndefined();
  });

  it('applies a heat penalty for hot-humid races (Dubai shape)', () => {
    const dubai: CourseProfile = {
      runElevationM: 30,
      runProfile: 'flat',
      climate: 'warm',  // ~+4% per literature (Ely 2007)
      altitudeM: 5,
    };
    const out = applyRunningCourseFactors(FAST_MARATHON_SEC, dubai, MARATHON_KM);
    const climate = out.factors.find(f => f.kind === 'climate');
    expect(climate).toBeDefined();
    expect(climate!.deltaSec).toBeCloseTo(FAST_MARATHON_SEC * 0.04, 0); // ~432s
    expect(out.adjustedSec).toBeGreaterThan(FAST_MARATHON_SEC + 300);
    expect(out.adjustedSec).toBeLessThan(FAST_MARATHON_SEC + 600);
  });

  it('applies an elevation penalty for net-uphill courses (Boston shape)', () => {
    const boston: CourseProfile = {
      runElevationM: 250,   // Newton hills + early descents net to +250m gain
      runProfile: 'rolling',
      climate: 'cool',
      altitudeM: 50,
    };
    const out = applyRunningCourseFactors(FAST_MARATHON_SEC, boston, MARATHON_KM);
    const elev = out.factors.find(f => f.kind === 'run-elevation');
    expect(elev).toBeDefined();
    // Average grade 250/42195 = 0.59%. Minetti cost at +0.6% is ~+12% energy.
    // For a 3hr marathon that lands somewhere in the +20-25min range — large
    // because the polynomial models pure-uphill cost; rolling courses with
    // descent recovery in reality see less. Sanity-check: penalty exists,
    // is positive, but bounded.
    expect(elev!.deltaSec).toBeGreaterThan(60);  // at least a minute
    expect(elev!.deltaSec).toBeLessThan(2400);   // less than 40 minutes
  });

  it('applies an altitude penalty above 500m', () => {
    const denver: CourseProfile = {
      runElevationM: 0,
      climate: 'cool',
      altitudeM: 1600,  // ~Denver
    };
    const out = applyRunningCourseFactors(FAST_MARATHON_SEC, denver, MARATHON_KM);
    const alt = out.factors.find(f => f.kind === 'altitude');
    expect(alt).toBeDefined();
    // 500-1500m: 0.20%/100m. So 1500m = +2%. 1600m = +2.4%.
    expect(alt!.multiplier).toBeGreaterThan(1.02);
    expect(alt!.multiplier).toBeLessThan(1.03);
  });

  it('skips altitude penalty below 500m floor', () => {
    const lowAlt: CourseProfile = { altitudeM: 400, climate: 'cool' };
    const out = applyRunningCourseFactors(FAST_MARATHON_SEC, lowAlt, MARATHON_KM);
    expect(out.factors.find(f => f.kind === 'altitude')).toBeUndefined();
  });

  it('compounds multiple factors multiplicatively', () => {
    // Hot-humid + altitude — combined penalty should be larger than either alone.
    const harsh: CourseProfile = {
      climate: 'hot-humid',  // +12%
      altitudeM: 1500,       // +2%
    };
    const out = applyRunningCourseFactors(FAST_MARATHON_SEC, harsh, MARATHON_KM);
    expect(out.factors.length).toBe(2);
    // Combined multiplier should be ~1.12 * 1.02 = 1.1424
    expect(out.multiplier).toBeCloseTo(1.12 * 1.02, 3);
  });

  it('returns identity for non-positive raw or distance inputs', () => {
    const profile: CourseProfile = { climate: 'hot' };
    expect(applyRunningCourseFactors(0, profile, MARATHON_KM).adjustedSec).toBe(0);
    expect(applyRunningCourseFactors(FAST_MARATHON_SEC, profile, 0).adjustedSec).toBe(FAST_MARATHON_SEC);
  });
});
