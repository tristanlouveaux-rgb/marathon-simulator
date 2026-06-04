import { describe, it, expect } from 'vitest';
import {
  runSpeedPlacement,
  vo2maxPlacement,
  ftpPlacement,
  hyroxPlacement,
  ageGradeForTime,
  ageGradeForFitness,
  wmaKeyForRaceDist,
  runnerFieldPlacement,
  runnerFieldPlacementForFitness,
} from '@/calculations/fitness-placement';
import { lookupVo2Percentile, resolveVo2AgeBand, vo2BandAnchors } from '@/data/vo2max-norms';
import { ageGrade } from '@/data/wma-age-grading';
import { tv } from '@/calculations/vdot';
import { lookupDistanceAggregatePercentile, DISTANCE_AGGREGATE_PERCENTILE_TABLES } from '@/data/marathon-population-distributions';

describe('vo2max norms (FRIEND)', () => {
  it('returns the published percentile at an exact breakpoint', () => {
    // Kaminsky 2015, men 20-29, 50th percentile = 48.0
    const p = lookupVo2Percentile(48.0, 25, 'male');
    expect(p).not.toBeNull();
    expect(p!.percentile).toBe(50);
    expect(p!.bandLabel).toBe('20-29');
    expect(p!.sexLabel).toBe('men');
  });

  it('interpolates between breakpoints', () => {
    // Men 30-39: p50 = 42.4, p75 = 49.2. Midpoint vo2 → ~p62-63.
    const p = lookupVo2Percentile((42.4 + 49.2) / 2, 35, 'male');
    expect(p!.percentile).toBeGreaterThanOrEqual(62);
    expect(p!.percentile).toBeLessThanOrEqual(63);
  });

  it('clamps to the published 5th/95th outside the table', () => {
    expect(lookupVo2Percentile(80, 25, 'male')!.percentile).toBe(95);
    expect(lookupVo2Percentile(10, 25, 'male')!.percentile).toBe(5);
  });

  it('uses the women table for female athletes', () => {
    // Women 40-49, 50th percentile = 26.7
    const p = lookupVo2Percentile(26.7, 44, 'female');
    expect(p!.percentile).toBe(50);
    expect(p!.sexLabel).toBe('women');
    expect(p!.bandLabel).toBe('40-49');
  });

  it('refuses to place without a known sex or age', () => {
    expect(lookupVo2Percentile(48, 25, null)).toBeNull();
    expect(lookupVo2Percentile(48, 25, 'prefer_not_to_say')).toBeNull();
    expect(lookupVo2Percentile(48, null, 'male')).toBeNull();
    expect(lookupVo2Percentile(0, 25, 'male')).toBeNull();
  });

  it('clamps ages outside 20-79 to the nearest band and says so', () => {
    expect(resolveVo2AgeBand(18)).toBe('20-29');
    expect(resolveVo2AgeBand(85)).toBe('70-79');
    expect(resolveVo2AgeBand(52)).toBe('50-59');
    expect(lookupVo2Percentile(48, 18, 'male')!.bandLabel).toBe('20-29');
  });
});

describe('runSpeedPlacement', () => {
  it('returns null without a usable VDOT', () => {
    expect(runSpeedPlacement(null)).toBeNull();
    expect(runSpeedPlacement(0)).toBeNull();
    expect(runSpeedPlacement(NaN)).toBeNull();
  });

  it('derives the marathon equivalent from the Daniels curve', () => {
    const place = runSpeedPlacement(45)!;
    expect(place).not.toBeNull();
    expect(Math.abs(place.marathonEquivSec - tv(45, 42.195))).toBeLessThan(1);
  });

  it('matches the canonical aggregate lookup (two-numbers rule)', () => {
    const place = runSpeedPlacement(50)!;
    const cum = lookupDistanceAggregatePercentile('marathon', place.marathonEquivSec)!;
    expect(place.fasterThanPct).toBe(100 - cum);
  });

  it('is monotonic: fitter athletes beat more of the field', () => {
    const slow = runSpeedPlacement(35)!;
    const fast = runSpeedPlacement(55)!;
    expect(fast.fasterThanPct).toBeGreaterThan(slow.fasterThanPct);
  });

  it('carries real provenance for the caption', () => {
    const place = runSpeedPlacement(45)!;
    expect(place.finisherCount).toBeGreaterThan(800_000);
    expect(place.venues.length).toBeGreaterThanOrEqual(5);
  });
});

describe('wma age grading', () => {
  it('grades the open-class standard at exactly 100%', () => {
    // Male 5K open plateau (ages ~18-30): standard = 769s
    const g = ageGrade('k5', 769, 27, 'male')!;
    expect(g.gradePct).toBe(100);
    expect(g.ageStandardSec).toBe(769);
    expect(g.openStandardSec).toBe(769);
    expect(g.bandLabel).toBe('World class');
  });

  it('applies the published interpretation bands', () => {
    // Male 30, 5K: standard 769s. 18:10 (1090s) → 70.6% regional class.
    const g = ageGrade('k5', 1090, 30, 'male')!;
    expect(g.gradePct).toBeCloseTo(70.6, 1);
    expect(g.bandLabel).toBe('Regional class');
    // Slow time → below 60% → no band.
    expect(ageGrade('k5', 2400, 30, 'male')!.bandLabel).toBeNull();
  });

  it('uses the female table for female athletes', () => {
    const g = ageGrade('marathon', 7796, 27, 'female')!;
    expect(g.gradePct).toBe(100);
  });

  it('standards rise with age through the masters range', () => {
    // Same 10K time grades higher at 60 than at 35 (male).
    const at35 = ageGrade('k10', 2545, 35, 'male')!;
    const at60 = ageGrade('k10', 2545, 60, 'male')!;
    expect(at60.gradePct).toBeGreaterThan(at35.gradePct);
  });

  it('refuses to grade without age and binary sex', () => {
    expect(ageGrade('k5', 1090, null, 'male')).toBeNull();
    expect(ageGrade('k5', 1090, 30, 'prefer_not_to_say')).toBeNull();
    expect(ageGrade('k5', 1090, 30, null)).toBeNull();
    expect(ageGrade('k5', 0, 30, 'male')).toBeNull();
  });

  it('clamps ages outside the published 5-100 range', () => {
    expect(ageGrade('k5', 1090, 110, 'male')).not.toBeNull();
    expect(ageGrade('k5', 1090, 110, 'male')!.ageStandardSec)
      .toBe(ageGrade('k5', 1090, 100, 'male')!.ageStandardSec);
  });
});

describe('ageGradeForFitness / ageGradeForTime', () => {
  it('fitness grade equals grading the Daniels-projected time', () => {
    const vdot = 50;
    const viaFitness = ageGradeForFitness('k10', vdot, 30, 'male')!;
    const viaTime = ageGradeForTime('k10', tv(vdot, 10), 30, 'male')!;
    expect(viaFitness.gradePct).toBe(viaTime.gradePct);
    expect(Math.abs(viaFitness.timeSec - tv(vdot, 10))).toBeLessThan(1);
  });

  it('maps app race-distance keys to WMA keys', () => {
    expect(wmaKeyForRaceDist('5k')).toBe('k5');
    expect(wmaKeyForRaceDist('10k')).toBe('k10');
    expect(wmaKeyForRaceDist('half')).toBe('half');
    expect(wmaKeyForRaceDist('marathon')).toBe('marathon');
    expect(wmaKeyForRaceDist('ultra')).toBeNull();
    expect(wmaKeyForRaceDist(null)).toBeNull();
  });

  it('returns null without usable inputs', () => {
    expect(ageGradeForFitness('k10', null, 30, 'male')).toBeNull();
    expect(ageGradeForTime('k10', null, 30, 'male')).toBeNull();
  });
});

describe('runnerFieldPlacement (population percentile)', () => {
  it('places a 17:39 5K male at the elite end of the field', () => {
    // Real-feedback case (Tristan, 2026-06-03): male p1 = 17:30, so 17:39
    // must read "faster than ~99%", not the 73% the age grade implied.
    const p = runnerFieldPlacement('k5', 17 * 60 + 39, 'male')!;
    expect(p.fasterThanPct).toBeGreaterThanOrEqual(98);
    expect(p.sexUsed).toBe('male');
  });

  it('places the median at 50', () => {
    // Male 5K p50 breakpoint = 1888s
    expect(runnerFieldPlacement('k5', 1888, 'male')!.fasterThanPct).toBe(50);
  });

  it('falls back to the overall table when sex is unknown', () => {
    const p = runnerFieldPlacement('k10', 3728, null)!;
    expect(p.sexUsed).toBe('all');
    expect(p.fasterThanPct).toBe(50);
    expect(runnerFieldPlacement('k10', 3728, 'prefer_not_to_say')!.sexUsed).toBe('all');
  });

  it('clamps at the published table ends', () => {
    // Faster than the p1 breakpoint → claim caps at 99, never 100.
    expect(runnerFieldPlacement('k5', 800, 'male')!.fasterThanPct).toBe(99);
    // Slower than the p90 breakpoint → floor at 10.
    expect(runnerFieldPlacement('k5', 4000, 'male')!.fasterThanPct).toBe(10);
  });

  it('is monotonic and carries real scale anchors', () => {
    const fast = runnerFieldPlacement('half', 5500, 'female')!;
    const slow = runnerFieldPlacement('half', 9000, 'female')!;
    expect(fast.fasterThanPct).toBeGreaterThan(slow.fasterThanPct);
    expect(fast.scale.fastSec).toBeLessThan(fast.scale.medianSec);
    expect(fast.scale.medianSec).toBeLessThan(fast.scale.slowSec);
  });

  it('fitness variant grades the Daniels-projected time', () => {
    const vdot = 50;
    const viaFitness = runnerFieldPlacementForFitness('k10', vdot, 'male')!;
    const viaTime = runnerFieldPlacement('k10', tv(vdot, 10), 'male')!;
    expect(viaFitness.fasterThanPct).toBe(viaTime.fasterThanPct);
    expect(runnerFieldPlacementForFitness('k10', null, 'male')).toBeNull();
  });
});

describe('placement scale anchors', () => {
  it('run-speed scale anchors come from the real table breakpoints', () => {
    const place = runSpeedPlacement(45)!;
    const t = DISTANCE_AGGREGATE_PERCENTILE_TABLES.marathon;
    expect(place.scale.fastSec).toBe(t.find(([, p]) => p === 5)![0]);
    expect(place.scale.medianSec).toBe(t.find(([, p]) => p === 50)![0]);
    expect(place.scale.slowSec).toBe(t.find(([, p]) => p === 95)![0]);
  });

  it('hyrox scale anchors are present and ordered', () => {
    const p = hyroxPlacement('open_singles', 5338)!;
    expect(p.scale.fastSec).toBeLessThan(p.scale.medianSec);
    expect(p.scale.medianSec).toBeLessThan(p.scale.slowSec);
  });

  it('vo2 band anchors are the published 5th/50th/95th values', () => {
    const a = vo2BandAnchors(25, 'male')!;
    expect(a).toEqual({ p5: 29.0, p50: 48.0, p95: 66.3 });
    expect(vo2BandAnchors(25, 'prefer_not_to_say')).toBeNull();
  });
});

describe('ftpPlacement', () => {
  it('requires a real bodyweight (no sex-default fallback)', () => {
    expect(ftpPlacement(250, null)).toBeNull();
    expect(ftpPlacement(250, 0)).toBeNull();
    expect(ftpPlacement(null, 74)).toBeNull();
  });

  it('returns the Coggan band for FTP and weight', () => {
    // 250 W / 74 kg = 3.38 W/kg → "Moderate" (3.01-3.40 band)
    const p = ftpPlacement(250, 74)!;
    expect(p.wkg).toBeCloseTo(3.38, 2);
    expect(p.label).toBe('Moderate');
  });
});

describe('hyroxPlacement', () => {
  it('returns null for formats without ingested data', () => {
    expect(hyroxPlacement('pro_doubles', 5000)).toBeNull();
  });

  it('places the open singles median at ~50', () => {
    // open_singles p50 breakpoint = 5338s
    const p = hyroxPlacement('open_singles', 5338)!;
    expect(p.fasterThanPct).toBe(50);
  });

  it('is monotonic: faster times beat more of the field', () => {
    const fast = hyroxPlacement('open_singles', 4200)!;
    const slow = hyroxPlacement('open_singles', 7000)!;
    expect(fast.fasterThanPct).toBeGreaterThan(slow.fasterThanPct);
  });

  it('rejects unusable times', () => {
    expect(hyroxPlacement('open_singles', null)).toBeNull();
    expect(hyroxPlacement('open_singles', -10)).toBeNull();
  });
});
