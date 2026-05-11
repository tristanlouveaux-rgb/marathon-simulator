/**
 * Unit tests for the calibration code.
 *
 * Covers:
 *   - parseTimeToSec (HH:MM:SS, MM:SS, integer, empty, garbage)
 *   - buildDistribution (binning, mean/SD, MIN_BIN_N gate)
 *   - validateAgainstDistribution (in-band, out-of-band, missing bin)
 *   - buildCourseFactors (IM fixed effects, 70.3 stratification, clamping, era)
 *   - lookupEmpiricalCourseFactors (runtime — hit, miss, clamped drop, normalisation)
 */

import { describe, it, expect } from 'vitest';
import { parseTimeToSec, type FinishRecord } from './dataset-loader';
import { buildDistribution, validateAgainstDistribution } from './distribution';
import { buildCourseFactors, RECENCY_WINDOW_YEARS } from './course-factors';
import { lookupEmpiricalCourseFactors } from '@/calculations/empirical-course-factors';

// ───────────────────────────────────────────────────────────────────────────
// parseTimeToSec
// ───────────────────────────────────────────────────────────────────────────

describe('parseTimeToSec', () => {
  it('parses integer seconds', () => {
    expect(parseTimeToSec('16514')).toBe(16514);
    expect(parseTimeToSec('0')).toBe(0);
  });

  it('parses HH:MM:SS', () => {
    expect(parseTimeToSec('8:03:13')).toBe(8 * 3600 + 3 * 60 + 13);
    expect(parseTimeToSec('12:00:00')).toBe(12 * 3600);
  });

  it('parses MM:SS', () => {
    expect(parseTimeToSec('48:19')).toBe(48 * 60 + 19);
    expect(parseTimeToSec('1:30')).toBe(90);
  });

  it('returns NaN for empty / DNF / undefined', () => {
    expect(Number.isNaN(parseTimeToSec(''))).toBe(true);
    expect(Number.isNaN(parseTimeToSec(undefined))).toBe(true);
    expect(Number.isNaN(parseTimeToSec('---'))).toBe(true);
    expect(Number.isNaN(parseTimeToSec('   '))).toBe(true);
  });

  it('returns NaN for non-numeric junk', () => {
    expect(Number.isNaN(parseTimeToSec('DNF'))).toBe(true);
    expect(Number.isNaN(parseTimeToSec('1:2:3:4'))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Synthetic FinishRecord helpers
// ───────────────────────────────────────────────────────────────────────────

let recCounter = 0;
function rec(
  o: Partial<FinishRecord> & Pick<FinishRecord, 'swimSec' | 'bikeSec' | 'runSec' | 'finishSec'>,
): FinishRecord {
  recCounter++;
  return {
    distance: o.distance ?? '70.3',
    eventLocation: o.eventLocation ?? 'Test Race',
    eventYear: o.eventYear ?? 2022,
    gender: o.gender ?? 'M',
    ageGroup: o.ageGroup ?? '40-44',
    athleteId: o.athleteId,
    country: o.country ?? 'XX',
    swimSec: o.swimSec,
    bikeSec: o.bikeSec,
    runSec: o.runSec,
    finishSec: o.finishSec,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// buildDistribution + validateAgainstDistribution
// ───────────────────────────────────────────────────────────────────────────

describe('buildDistribution + validateAgainstDistribution', () => {
  it('drops bins with too few records (MIN_BIN_N gate)', () => {
    // Only 5 records — should produce zero bins.
    const records = Array.from({ length: 5 }, () =>
      rec({ swimSec: 2000, bikeSec: 10000, runSec: 8000, finishSec: 20000 }),
    );
    const table = buildDistribution('70.3', records);
    expect(table.bins.length).toBe(0);
  });

  it('produces a bin with mean ≈ input fractions when records are homogeneous', () => {
    // 50 identical records at total 5:30:00 (19800s).
    // Splits: 10% swim (1980s), 50% bike (9900s), 35% run (6930s), 5% transitions.
    const records = Array.from({ length: 50 }, () =>
      rec({ swimSec: 1980, bikeSec: 9900, runSec: 6930, finishSec: 19800 }),
    );
    const table = buildDistribution('70.3', records);
    expect(table.bins.length).toBeGreaterThan(0);
    const bin = table.bins[0];
    expect(bin.n).toBe(50);
    expect(bin.swimFracMean).toBeCloseTo(0.10, 2);
    expect(bin.bikeFracMean).toBeCloseTo(0.50, 2);
    expect(bin.runFracMean).toBeCloseTo(0.35, 2);
    // Homogeneous data → SD ~0
    expect(bin.swimFracSD).toBeLessThan(0.001);
  });

  it('validateAgainstDistribution flags out-of-band legs', () => {
    // Build a tight distribution.
    const records = Array.from({ length: 50 }, () =>
      rec({ swimSec: 2000, bikeSec: 10000, runSec: 8000, finishSec: 20000 }),
    );
    const table = buildDistribution('70.3', records);

    // Prediction with massively elevated swim fraction (out of band).
    const result = validateAgainstDistribution(
      { swimSec: 4000, bikeSec: 8000, runSec: 8000, finishSec: 20000 },
      table,
    );
    expect(result.swim).not.toBeNull();
    expect(result.swim!.outOfBand).toBe(true);
    expect(result.anyOutOfBand).toBe(true);
  });

  it('validateAgainstDistribution returns null legs when total falls outside any bin', () => {
    const records = Array.from({ length: 50 }, () =>
      rec({ swimSec: 2000, bikeSec: 10000, runSec: 8000, finishSec: 20000 }),
    );
    const table = buildDistribution('70.3', records);

    // Total time of 30s — way outside any bin
    const result = validateAgainstDistribution(
      { swimSec: 5, bikeSec: 15, runSec: 10, finishSec: 30 },
      table,
    );
    expect(result.swim).toBeNull();
    expect(result.notes.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildCourseFactors — IM fixed effects
// ───────────────────────────────────────────────────────────────────────────

describe('buildCourseFactors — IM fixed effects', () => {
  it('flat-course factor ≈ 1.0 when athletes race identically at all locations', () => {
    const athletes = ['A1', 'A2', 'A3', 'A4', 'A5'];
    const records: FinishRecord[] = [];
    // Each athlete races at two locations with identical splits → factor = 1.0.
    // Need enough records for the MIN_BIN_N gate (≥ 50 per location for 'low').
    for (let i = 0; i < 50; i++) {
      for (const a of athletes) {
        records.push(rec({
          distance: 'ironman', athleteId: `${a}-${i}`,
          eventLocation: 'Flat City',
          swimSec: 4000, bikeSec: 18000, runSec: 14000, finishSec: 36500,
        }));
        records.push(rec({
          distance: 'ironman', athleteId: `${a}-${i}`,
          eventLocation: 'Another Flat',
          swimSec: 4000, bikeSec: 18000, runSec: 14000, finishSec: 36500,
        }));
      }
    }
    const table = buildCourseFactors('ironman', records);
    const flat = table.factors['Flat City'];
    expect(flat).toBeDefined();
    expect(flat.bikeFactor).toBeCloseTo(1.0, 2);
    expect(flat.swimFactor).toBeCloseTo(1.0, 2);
    expect(flat.runFactor).toBeCloseTo(1.0, 2);
  });

  it('hilly course returns bikeFactor > 1 when athletes go slower than personal average', () => {
    const athletes = ['A1', 'A2', 'A3', 'A4', 'A5'];
    const records: FinishRecord[] = [];
    // Each athlete races flat (fast) AND hilly (10% slower bike).
    // For balanced two-race per-athlete, the bike at hilly is 10% above mean (1.05 * baseline).
    for (let i = 0; i < 30; i++) {
      for (const a of athletes) {
        const aid = `${a}-${i}`;
        records.push(rec({
          distance: 'ironman', athleteId: aid,
          eventLocation: 'Flat',
          swimSec: 4000, bikeSec: 18000, runSec: 14000, finishSec: 36500,
        }));
        records.push(rec({
          distance: 'ironman', athleteId: aid,
          eventLocation: 'Hilly',
          swimSec: 4000, bikeSec: 19800, runSec: 14000, finishSec: 38300, // +10% bike
        }));
      }
    }
    const table = buildCourseFactors('ironman', records);
    const hilly = table.factors['Hilly'];
    expect(hilly).toBeDefined();
    // Athlete's mean bike = (18000 + 19800)/2 = 18900
    // Hilly ratio = 19800/18900 ≈ 1.048
    expect(hilly.bikeFactor).toBeGreaterThan(1.03);
    expect(hilly.bikeFactor).toBeLessThan(1.06);
    expect(hilly.swimFactor).toBeCloseTo(1.0, 2);
  });

  it('clamps and flags absurd factors', () => {
    const athletes = ['A1', 'A2', 'A3'];
    const records: FinishRecord[] = [];
    // Make "Cancelled" race have a 60% faster bike — should clamp to 0.75.
    for (let i = 0; i < 60; i++) {
      for (const a of athletes) {
        const aid = `${a}-${i}`;
        records.push(rec({
          distance: 'ironman', athleteId: aid,
          eventLocation: 'Normal', swimSec: 4000, bikeSec: 18000, runSec: 14000, finishSec: 36500,
        }));
        records.push(rec({
          distance: 'ironman', athleteId: aid,
          eventLocation: 'Cancelled',
          swimSec: 4000, bikeSec: 9000, runSec: 14000, finishSec: 27500, // 50% bike — extreme
        }));
      }
    }
    const table = buildCourseFactors('ironman', records);
    const cancelled = table.factors['Cancelled'];
    expect(cancelled).toBeDefined();
    expect(cancelled.clamped).toBe(true);
    expect(cancelled.bikeFactor).toBeGreaterThanOrEqual(0.75); // clamped to floor
  });

  it('marks era=recent when recent sample is sufficient, allTime otherwise', () => {
    const records: FinishRecord[] = [];
    const baseAthlete = 'persistentAthlete';
    // 30 athletes × 2 races each, ALL recent (last 5 years).
    // Latest year = 2024, so RECENCY_WINDOW_YEARS=5 includes 2020-2024.
    for (let i = 0; i < 250; i++) {
      const aid = `${baseAthlete}-${i}`;
      records.push(rec({
        distance: 'ironman', athleteId: aid, eventYear: 2023,
        eventLocation: 'Recent Race',
        swimSec: 4000, bikeSec: 18000, runSec: 14000, finishSec: 36500,
      }));
      records.push(rec({
        distance: 'ironman', athleteId: aid, eventYear: 2023,
        eventLocation: 'Other',
        swimSec: 4000, bikeSec: 18000, runSec: 14000, finishSec: 36500,
      }));
    }
    const table = buildCourseFactors('ironman', records);
    expect(table.factors['Recent Race']?.era).toBe('recent');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildCourseFactors — 70.3 stratified
// ───────────────────────────────────────────────────────────────────────────

describe('buildCourseFactors — 70.3 stratified', () => {
  it('produces ~1.0 factors when both locations have identical bucket means', () => {
    const records: FinishRecord[] = [];
    const ageGroups = ['25-29', '35-39', '45-49'];
    for (const ag of ageGroups) {
      for (const loc of ['Loc A', 'Loc B']) {
        for (let i = 0; i < 30; i++) {
          records.push(rec({
            distance: '70.3', eventLocation: loc, ageGroup: ag, gender: 'M',
            swimSec: 1800, bikeSec: 10000, runSec: 7000, finishSec: 19400,
          }));
        }
      }
    }
    const table = buildCourseFactors('70.3', records);
    const a = table.factors['Loc A'];
    expect(a).toBeDefined();
    expect(a.bikeFactor).toBeCloseTo(1.0, 2);
    expect(a.runFactor).toBeCloseTo(1.0, 2);
  });

  it('reflects slower legs at hard course relative to global bucket mean', () => {
    const records: FinishRecord[] = [];
    const ageGroups = ['25-29', '35-39', '45-49'];
    // Loc Easy: each bucket runs the global pace
    for (const ag of ageGroups) {
      for (let i = 0; i < 30; i++) {
        records.push(rec({
          distance: '70.3', eventLocation: 'Easy', ageGroup: ag,
          swimSec: 1800, bikeSec: 10000, runSec: 7000, finishSec: 19400,
        }));
      }
    }
    // Loc Hard: 8% slower bike across all buckets
    for (const ag of ageGroups) {
      for (let i = 0; i < 30; i++) {
        records.push(rec({
          distance: '70.3', eventLocation: 'Hard', ageGroup: ag,
          swimSec: 1800, bikeSec: 10800, runSec: 7000, finishSec: 20200,
        }));
      }
    }
    const table = buildCourseFactors('70.3', records);
    const hard = table.factors['Hard'];
    expect(hard).toBeDefined();
    // Hard bike vs global mean (averaged across two locations) =
    // 10800 / ((10000 + 10800) / 2) = 10800 / 10400 = 1.0385
    expect(hard.bikeFactor).toBeGreaterThan(1.03);
    expect(hard.bikeFactor).toBeLessThan(1.05);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// lookupEmpiricalCourseFactors — runtime
// ───────────────────────────────────────────────────────────────────────────

describe('lookupEmpiricalCourseFactors (runtime)', () => {
  const baseSec = { swimSec: 2400, bikeSec: 11000, runSec: 7200 };

  it('finds a known high-confidence race', () => {
    const res = lookupEmpiricalCourseFactors('IRONMAN Lanzarote', 'ironman', baseSec);
    expect(res).not.toBeNull();
    expect(res!.confidence).toBe('high');
    expect(res!.bikeMultiplier).toBeGreaterThan(1.0);  // Lanzarote is hilly
    expect(res!.n).toBeGreaterThan(100);
  });

  it('returns null for unknown races', () => {
    const res = lookupEmpiricalCourseFactors('IRONMAN Atlantis', 'ironman', baseSec);
    expect(res).toBeNull();
  });

  it('returns null for clamped (data-error) races', () => {
    // IM North Carolina was a 2016 weather-shortened race — clamped at calibration.
    const res = lookupEmpiricalCourseFactors('Ironman North Carolina', 'ironman', baseSec);
    expect(res).toBeNull();
  });

  it('normalises name prefix / case (case-insensitive, IRONMAN prefix stripped)', () => {
    const a = lookupEmpiricalCourseFactors('IRONMAN Lanzarote', 'ironman', baseSec);
    const b = lookupEmpiricalCourseFactors('ironman LANZAROTE', 'ironman', baseSec);
    const c = lookupEmpiricalCourseFactors('Lanzarote', 'ironman', baseSec);
    expect(a).not.toBeNull();
    expect(b?.bikeMultiplier).toBe(a!.bikeMultiplier);
    expect(c?.bikeMultiplier).toBe(a!.bikeMultiplier);
  });

  it('does not cross-pollinate between distances', () => {
    // "Texas" exists in both 70.3 and IM datasets with very different factors.
    const im = lookupEmpiricalCourseFactors('Ironman Texas', 'ironman', baseSec);
    const half = lookupEmpiricalCourseFactors('IRONMAN 70.3 Texas', '70.3', baseSec);
    expect(im).not.toBeNull();
    expect(half).not.toBeNull();
  });

  it('surfaces era field (recent | allTime)', () => {
    const res = lookupEmpiricalCourseFactors('IRONMAN Lanzarote', 'ironman', baseSec);
    expect(res).not.toBeNull();
    expect(['recent', 'allTime']).toContain(res!.era);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Recency window
// ───────────────────────────────────────────────────────────────────────────

describe('RECENCY_WINDOW_YEARS', () => {
  it('is 5', () => {
    expect(RECENCY_WINDOW_YEARS).toBe(5);
  });
});
