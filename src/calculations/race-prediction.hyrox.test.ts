import { describe, expect, it } from 'vitest';
import { predictHyroxRace } from './race-prediction.hyrox';
import type { SimulatorState } from '@/types/state';

const DAY_MS = 1000 * 60 * 60 * 24;
function dateNDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function buildState(
  overrides: Partial<SimulatorState['hyroxConfig']> = {},
  topLevel: Partial<SimulatorState> = {},
): SimulatorState {
  return {
    ...topLevel,
    hyroxConfig: {
      format: 'open_singles',
      athleteBand: 'intermediate',
      hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0,
      mtlCap: 1000,
      mtlHistory: [],
      runsPerWeek: 3,
      stationSessionsPerWeek: 1,
      bricksPerWeek: 1,
      weeklyHoursAvailable: 8,
      ...overrides,
    },
  } as unknown as SimulatorState;
}

describe('predictHyroxRace', () => {
  it('returns null when hyroxConfig is missing', () => {
    expect(predictHyroxRace({} as SimulatorState)).toBeNull();
  });

  it('produces a band-default prediction with no venue', () => {
    const state = buildState();
    const p = predictHyroxRace(state);
    expect(p).not.toBeNull();
    expect(p!.totalSec).toBeGreaterThan(0);
    expect(p!.courseFactors).toEqual([]);
    expect(p!.totalSec).toBe(p!.rawSec); // no venue → no adjustment
    expect(p!.runLegs.length).toBe(8);
    expect(p!.stations.length).toBe(8);
  });

  it('Mexico City venue applies a meaningful altitude penalty', () => {
    const sea = predictHyroxRace(buildState({ venueId: 'london-excel' }))!;
    const mexico = predictHyroxRace(buildState({ venueId: 'mexico-city-exh' }))!;
    // Mexico City is at 2240m. Substantial penalty on run + endurance stations.
    expect(mexico.totalSec).toBeGreaterThan(sea.totalSec);
    const altFactor = mexico.courseFactors.find(f => f.kind === 'altitude');
    expect(altFactor).toBeDefined();
    expect(altFactor!.deltaSec).toBeGreaterThan(60); // at least a minute
  });

  it('hard-loop venue (Paris) is slower than easy-loop venue (Birmingham)', () => {
    const paris = predictHyroxRace(buildState({ venueId: 'paris-portes' }))!;
    const birm = predictHyroxRace(buildState({ venueId: 'birmingham-nec' }))!;
    expect(paris.totalSec).toBeGreaterThan(birm.totalSec);
  });

  it('warm venue produces a positive temperature delta', () => {
    const madrid = predictHyroxRace(buildState({ venueId: 'madrid-ifema' }))!;
    const tempFactor = madrid.courseFactors.find(f => f.kind === 'temp');
    expect(tempFactor).toBeDefined();
    expect(tempFactor!.deltaSec).toBeGreaterThan(0);
  });

  it('user-supplied singles benchmarks override seed times', () => {
    const fastSki = 200; // way faster than intermediate seed (267)
    const baseline = predictHyroxRace(buildState())!;
    const calibrated = predictHyroxRace(buildState({
      stationBenchmarksSingles: { ski_erg: fastSki },
    }))!;
    expect(calibrated.totalSec).toBeLessThan(baseline.totalSec);
    const skiLine = calibrated.stations.find(l => l.station === 'ski_erg')!;
    expect(skiLine.source).toBe('calibrated');
    expect(skiLine.baseSec).toBe(fastSki);
  });

  it('cross-format: a doubles race split feeds a singles prediction in singles terms (÷ the station ratio)', () => {
    // No history entry: a race split written before race entries existed,
    // so the pair's time (doublesBenchmarkIsTeamTime).
    const doublesSki = 250;
    const calibrated = predictHyroxRace(buildState({
      format: 'open_singles',
      stationBenchmarksDoubles: { ski_erg: doublesSki },
    }))!;
    const skiLine = calibrated.stations.find(l => l.station === 'ski_erg')!;
    expect(skiLine.source).toBe('calibrated');
    expect(skiLine.teamTimeSplit).toBe(true);
    expect(skiLine.teamRatio).toBeUndefined();
    expect(calibrated.crossFormatConversion).toBe('doubles_to_singles');
    expect(calibrated.crossFormatStationRatio).toBeGreaterThan(0.6);
    expect(calibrated.crossFormatStationRatio).toBeLessThan(0.8);
    expect(skiLine.baseSec).toBeCloseTo(doublesSki / calibrated.crossFormatStationRatio!, 6);
    // One calibrated station: low by count, not by a cross-format cap.
    expect(calibrated.confidence).toBe('low');
  });

  it('singles benchmarks feed a doubles prediction through the doubles station ratio', () => {
    // The doubles model is singles station time × the percentile-matched
    // ratio (hyrox-doubles.ts), so singles times are its input: no seed
    // fallback. The station is flagged as converted from the other format.
    const singlesSki = 250;
    const calibrated = predictHyroxRace(buildState({
      format: 'open_doubles',
      stationBenchmarksSingles: { ski_erg: singlesSki },
    }))!;
    expect(calibrated.crossFormatConversion).toBe('singles_to_doubles');
    expect(calibrated.crossFormatStationRatio).toBe(calibrated.doubles!.stationRatio);
    const skiLine = calibrated.stations.find(l => l.station === 'ski_erg')!;
    expect(skiLine.source).toBe('calibrated');
    expect(skiLine.crossFormat).toBe(true);
    expect(skiLine.baseSec).toBeCloseTo(singlesSki * calibrated.doubles!.stationRatio, 6);
  });

  it('same-format: doubles target with doubles benchmarks uses them directly', () => {
    const doublesSki = 250;
    const calibrated = predictHyroxRace(buildState({
      format: 'open_doubles',
      stationBenchmarksDoubles: { ski_erg: doublesSki },
    }))!;
    expect(calibrated.crossFormatConversion).toBeUndefined();
    const skiLine = calibrated.stations.find(l => l.station === 'ski_erg');
    if (skiLine) {
      expect(skiLine.source).toBe('calibrated');
      expect(skiLine.baseSec).toBe(doublesSki);
    }
  });

  it('Pro singles is slower than Open singles for seed-only athletes (heavier weights)', () => {
    const open = predictHyroxRace(buildState({ format: 'open_singles' }))!;
    const pro  = predictHyroxRace(buildState({ format: 'pro_singles' }))!;
    expect(pro.stationsSec).toBeGreaterThan(open.stationsSec);
  });

  it('confidence is high when ≥6 stations calibrated and venue is set', () => {
    const benches = {
      ski_erg: 250, sled_push: 130, sled_pull: 140, burpee_broad_jumps: 240,
      row_erg: 280, farmer_carry: 90, sandbag_lunges: 180, wall_balls: 230,
    };
    const p = predictHyroxRace(buildState({
      stationBenchmarksSingles: benches,
      venueId: 'london-excel',
    }))!;
    expect(p.confidence).toBe('high');
    expect(p.calibratedCount).toBe(8);
  });

  it('confidence is low when no calibration', () => {
    const p = predictHyroxRace(buildState())!;
    expect(p.confidence).toBe('low');
  });

  it('per-leg run paces fade across the 8 legs (fatigue progression)', () => {
    const p = predictHyroxRace(buildState({ venueId: 'london-excel' }))!;
    // Leg 8 should be slower than leg 1 due to accumulated fatigue.
    expect(p.runLegs[7].paceSecKm).toBeGreaterThan(p.runLegs[0].paceSecKm);
  });

  // ── Pro ↔ Open format conversion (full matrix) ────────────────────────────
  // Storage has one slot per composition (Singles/Doubles) plus a
  // benchmarksAtProWeights flag. Converting between Pro and Open at predict
  // time must run in BOTH directions: Open→Pro multiplies by the Pro factor,
  // Pro→Open divides by it. Pre-fix only the Open→Pro direction was wired.

  describe('Pro ↔ Open conversion', () => {
    const SLED_PUSH_OPEN = 130;       // representative seconds at Open weights
    const PRO_MULT_SLED  = 1.15;      // from HYROX_PRO_STATION_MULTIPLIER
    const SLED_PUSH_PRO  = SLED_PUSH_OPEN * PRO_MULT_SLED; // ≈149.5

    it('Open benchmarks predicting Pro: applies Pro multiplier', () => {
      const open = predictHyroxRace(buildState({
        format: 'open_singles',
        stationBenchmarksSingles: { sled_push: SLED_PUSH_OPEN },
      }))!;
      const pro = predictHyroxRace(buildState({
        format: 'pro_singles',
        stationBenchmarksSingles: { sled_push: SLED_PUSH_OPEN },
      }))!;
      const sledOpen = open.stations.find(l => l.station === 'sled_push')!;
      const sledPro  = pro.stations.find(l => l.station === 'sled_push')!;
      expect(sledOpen.baseSec).toBeCloseTo(SLED_PUSH_OPEN, 0);
      expect(sledPro.baseSec).toBeCloseTo(SLED_PUSH_OPEN * PRO_MULT_SLED, 0);
    });

    it('Pro benchmarks predicting Pro (benchmarksAtProWeights): used as-is', () => {
      const pro = predictHyroxRace(buildState({
        format: 'pro_singles',
        stationBenchmarksSingles: { sled_push: SLED_PUSH_PRO },
        benchmarksAtProWeights: true,
      }))!;
      const sled = pro.stations.find(l => l.station === 'sled_push')!;
      expect(sled.baseSec).toBeCloseTo(SLED_PUSH_PRO, 0);
    });

    it('Pro benchmarks predicting Open: divides by Pro multiplier (the bug fix)', () => {
      const open = predictHyroxRace(buildState({
        format: 'open_singles',
        stationBenchmarksSingles: { sled_push: SLED_PUSH_PRO },
        benchmarksAtProWeights: true,
      }))!;
      const sled = open.stations.find(l => l.station === 'sled_push')!;
      // Pre-fix: sled.baseSec === SLED_PUSH_PRO (149.5). Wrong (Open should be faster).
      // Post-fix: sled.baseSec ≈ 130 (Pro time / 1.15).
      expect(sled.baseSec).toBeCloseTo(SLED_PUSH_OPEN, 0);
      expect(sled.baseSec).toBeLessThan(SLED_PUSH_PRO);
    });

    it('Open benchmarks predicting Open: identity (no conversion)', () => {
      const p = predictHyroxRace(buildState({
        format: 'open_singles',
        stationBenchmarksSingles: { sled_push: SLED_PUSH_OPEN },
      }))!;
      const sled = p.stations.find(l => l.station === 'sled_push')!;
      expect(sled.baseSec).toBeCloseTo(SLED_PUSH_OPEN, 0);
    });

    it('Erg/bodyweight stations have no Pro/Open weight effect', () => {
      // ski_erg has no Pro multiplier (weights don't change rep time).
      const SKI = 250;
      const open = predictHyroxRace(buildState({
        format: 'open_singles',
        stationBenchmarksSingles: { ski_erg: SKI },
      }))!;
      const pro = predictHyroxRace(buildState({
        format: 'pro_singles',
        stationBenchmarksSingles: { ski_erg: SKI },
      }))!;
      const skiOpen = open.stations.find(l => l.station === 'ski_erg')!;
      const skiPro  = pro.stations.find(l => l.station === 'ski_erg')!;
      expect(skiOpen.baseSec).toBe(SKI);
      expect(skiPro.baseSec).toBe(SKI);
    });
  });

  // ── Race-time staleness blend ─────────────────────────────────────────────
  // Per ISSUE-#: bandWeight + splitsWeight from hyrox-staleness must blend
  // the historic-anchored prediction with seed-anchored physiology fallback.
  // Fresh race → no blend. Very stale → meaningful blend toward seed.

  describe('staleness blend', () => {
    // Intermediate seed for ski_erg is 267s. Calibrated value 200 is much faster.
    const FAST_SKI = 200;
    const SKI_SEED_INTERMEDIATE = 267;

    it('fresh race (3 months ago) → no staleness blend, calibrated value used in full', () => {
      const fresh = predictHyroxRace(buildState({
        stationBenchmarksSingles: { ski_erg: FAST_SKI },
        hyroxPreviousRaceDate: dateNDaysAgo(90),
      }))!;
      const skiLine = fresh.stations.find(l => l.station === 'ski_erg')!;
      expect(skiLine.baseSec).toBe(FAST_SKI);
      expect(fresh.staleness?.category).toBe('fresh');
    });

    it('very stale race (30 months ago) + no physiology evidence → splits blend toward seed', () => {
      const veryStale = predictHyroxRace(buildState({
        stationBenchmarksSingles: { ski_erg: FAST_SKI },
        hyroxPreviousRaceDate: dateNDaysAgo(30 * 30.44),
      }))!;
      const skiLine = veryStale.stations.find(l => l.station === 'ski_erg')!;
      // splitsWeight at very_stale w/o physio mitigation = 0.6.
      // Expected: 0.6 × 200 + 0.4 × 267 = 226.8.
      expect(skiLine.baseSec).toBeGreaterThan(FAST_SKI);
      expect(skiLine.baseSec).toBeLessThan(SKI_SEED_INTERMEDIATE);
      expect(skiLine.baseSec).toBeCloseTo(226.8, 0);
      expect(veryStale.staleness?.category).toBe('very_stale');
    });

    it('band blend shifts seeds when VDOT crosses a threshold and mitigation is partial', () => {
      // Stored band 'total_beginner' (implied VDOT 28). VDOT 30 crosses into
      // 'beginner' but the ratio (30-28)/5=0.4 keeps signal f≈0.82. Partial
      // mitigation, not full. So bandWeight stays below 1.0 and the seed
      // blends between total_beginner and beginner. The prediction with the
      // stale race + slight VDOT lift should be FASTER than a fresh prediction
      // anchored entirely at total_beginner seeds.
      const stale = predictHyroxRace(buildState({
        athleteBand: 'total_beginner',
        hyroxPreviousRaceDate: dateNDaysAgo(30 * 30.44),
      }, {
        v: 30,
      }))!;
      const fresh = predictHyroxRace(buildState({
        athleteBand: 'total_beginner',
      }, {
        v: 30,
      }))!;
      // Both no-calibration paths. Fresh stays at total_beginner seeds; stale
      // blends toward beginner seeds (faster). Total time should be lower.
      expect(stale.totalSec).toBeLessThan(fresh.totalSec);
    });

    it('strong physiology mitigation pulls splitsWeight back toward 1.0 (less blend)', () => {
      // Stale race (15 months) + strong VDOT/CTL pulling mitigation high.
      // splitsWeight without mitigation = ~0.7; with strong physio it should
      // sit closer to 1.0, so the calibrated value dominates more.
      const noPhysio = predictHyroxRace(buildState({
        stationBenchmarksSingles: { ski_erg: FAST_SKI },
        hyroxPreviousRaceDate: dateNDaysAgo(15 * 30.44),
      }))!;
      const strongPhysio = predictHyroxRace(buildState({
        stationBenchmarksSingles: { ski_erg: FAST_SKI },
        hyroxPreviousRaceDate: dateNDaysAgo(15 * 30.44),
        mtlCTL: 100, // well above expected
      }, {
        v: 55, // strong VDOT for intermediate band
        ctlBaseline: 80,
      }))!;
      const noSki = noPhysio.stations.find(l => l.station === 'ski_erg')!;
      const strongSki = strongPhysio.stations.find(l => l.station === 'ski_erg')!;
      // Strong physio → blend less → result closer to FAST_SKI (200).
      expect(Math.abs(strongSki.baseSec - FAST_SKI))
        .toBeLessThan(Math.abs(noSki.baseSec - FAST_SKI));
    });
  });
});

describe('predictHyroxRace: Pro race splits are not multiplied twice', () => {
  it('splits flagged at Pro weights are used as is for a Pro target', () => {
    const p = predictHyroxRace(buildState({
      format: 'pro_singles',
      stationBenchmarksSingles: { sled_push: 260 },
      benchmarksAtProWeights: true,
    }))!;
    expect(p.stations.find(l => l.station === 'sled_push')!.baseSec).toBe(260);
  });
});

describe('predictHyroxRace: singles target from doubles benchmarks (one quantile mapping)', () => {
  const STATIONS = ['ski_erg', 'sled_push', 'sled_pull', 'burpee_broad_jumps', 'row_erg', 'farmer_carry', 'sandbag_lunges', 'wall_balls'] as const;
  const doublesSplits = { ski_erg: 200, sled_push: 140, sled_pull: 190, burpee_broad_jumps: 210, row_erg: 220, farmer_carry: 80, sandbag_lunges: 200, wall_balls: 320 };
  const raceHistory = Object.fromEntries(STATIONS.map(st => [st, [
    { dateISO: dateNDaysAgo(30), sec: doublesSplits[st], source: 'race' as const, format: 'open_doubles' as const, proWeights: false },
  ]]));

  it('8 doubles race splits: singles lines × the ratio give back the splits, with the doubles forecast\'s own ratio', () => {
    const cfg = { stationBenchmarksDoubles: doublesSplits, stationBenchmarkHistory: raceHistory } as Partial<SimulatorState['hyroxConfig']>;
    const singles = predictHyroxRace(buildState({ ...cfg, format: 'open_singles' }))!;
    const doubles = predictHyroxRace(buildState({ ...cfg, format: 'open_doubles' }))!;
    const r = singles.crossFormatStationRatio!;
    expect(r).toBeCloseTo(doubles.doubles!.stationRatio, 9);
    for (const st of STATIONS) {
      const s1 = singles.stations.find(l => l.station === st)!;
      const d1 = doubles.stations.find(l => l.station === st)!;
      expect(s1.source).toBe('calibrated');
      expect(s1.baseSec * r).toBeCloseTo(doublesSplits[st], 6);
      expect(d1.baseSec).toBeCloseTo(doublesSplits[st], 6);
    }
    // Fully calibrated, but every station is a cross-format estimate:
    // confidence caps at medium even with a venue (high needs it otherwise).
    expect(singles.calibratedCount).toBe(8);
    expect(singles.stations.every(l => l.crossFormat)).toBe(true);
    expect(singles.confidence).toBe('medium');
    expect(predictHyroxRace(buildState({ ...cfg, format: 'open_singles', venueId: 'london-excel' }))!.confidence).toBe('medium');
    // The doubles forecast reads its own race splits: no conversion, no cap.
    expect(doubles.crossFormatConversion).toBeUndefined();
    expect(predictHyroxRace(buildState({ ...cfg, format: 'open_doubles', venueId: 'london-excel' }))!.confidence).toBe('high');
  });

  it('a solo test in the doubles slot is one athlete\'s time: used as is, no conversion flag', () => {
    const singles = predictHyroxRace(buildState({
      format: 'open_singles',
      stationBenchmarksDoubles: { ski_erg: 270 },
      stationBenchmarkHistory: { ski_erg: [{ dateISO: dateNDaysAgo(5), sec: 270, source: 'half_test', format: 'open_doubles' }] },
    }))!;
    const ski = singles.stations.find(l => l.station === 'ski_erg')!;
    expect(ski.source).toBe('calibrated');
    expect(ski.teamTimeSplit).toBeUndefined();
    expect(ski.baseSec).toBe(270);
    expect(singles.crossFormatConversion).toBeUndefined();
  });

  it('per station: a singles value wins for its own station, the other 7 stay converted', () => {
    const singles = predictHyroxRace(buildState({
      format: 'open_singles',
      stationBenchmarksSingles: { row_erg: 260 },
      stationBenchmarksDoubles: doublesSplits,
      stationBenchmarkHistory: raceHistory,
    }))!;
    expect(singles.crossFormatConversion).toBe('doubles_to_singles');
    expect(singles.calibratedCount).toBe(8);
    const row = singles.stations.find(l => l.station === 'row_erg')!;
    expect(row.baseSec).toBe(260);
    expect(row.teamTimeSplit).toBeUndefined();
    const r = singles.crossFormatStationRatio!;
    for (const st of STATIONS.filter(x => x !== 'row_erg')) {
      const line = singles.stations.find(l => l.station === st)!;
      expect(line.teamTimeSplit).toBe(true);
      expect(line.baseSec * r).toBeCloseTo(doublesSplits[st], 6);
    }
  });

  it('a singles test equal to its converted value leaves the forecast where it was (review 2026-10-13)', () => {
    // Per slot, this test dropped the 7 other converted splits to seeds:
    // 8 calibrated / medium became 1 calibrated / low and the total moved by
    // minutes. Per station it adds no information, so nothing moves beyond
    // the station ratio's one refinement pass reading a slightly different
    // first-pass total.
    const cfg = { format: 'open_singles' as const, stationBenchmarksDoubles: doublesSplits, stationBenchmarkHistory: raceHistory };
    const before = predictHyroxRace(buildState(cfg))!;
    const skiConverted = before.stations.find(l => l.station === 'ski_erg')!.baseSec;
    const after = predictHyroxRace(buildState({
      ...cfg,
      stationBenchmarksSingles: { ski_erg: skiConverted },
      stationBenchmarkHistory: {
        ...raceHistory,
        ski_erg: [...raceHistory.ski_erg, { dateISO: dateNDaysAgo(2), sec: skiConverted, source: 'half_test' as const, format: 'open_singles' as const }],
      },
    }))!;
    expect(after.calibratedCount).toBe(8);
    expect(after.confidence).toBe(before.confidence);
    expect(after.stations.filter(l => l.teamTimeSplit)).toHaveLength(7);
    expect(Math.abs(after.totalSec - before.totalSec)).toBeLessThanOrEqual(2);
  });

  it('doubles target: a doubles value wins for its own station, singles values fill the other 7', () => {
    const singlesTimes = { ski_erg: 270, sled_push: 200, sled_pull: 260, burpee_broad_jumps: 300, row_erg: 290, farmer_carry: 110, sandbag_lunges: 280, wall_balls: 430 };
    const p = predictHyroxRace(buildState({
      format: 'open_doubles',
      stationBenchmarksSingles: singlesTimes,
      stationBenchmarksDoubles: { ski_erg: 200 },
      stationBenchmarkHistory: { ski_erg: raceHistory.ski_erg },
    }))!;
    expect(p.calibratedCount).toBe(8);
    const ski = p.stations.find(l => l.station === 'ski_erg')!;
    expect(ski.teamTimeSplit).toBe(true);
    expect(ski.baseSec).toBe(200);
    const row = p.stations.find(l => l.station === 'row_erg')!;
    expect(row.baseSec).toBeCloseTo(290 * p.doubles!.stationRatio, 6);
  });

  it('a Pro singles target reads a Pro doubles split at Pro weights, with no second Pro multiplier', () => {
    const proHistory = { sled_push: [{ dateISO: dateNDaysAgo(30), sec: 180, source: 'race' as const, format: 'pro_doubles' as const, proWeights: true }] };
    const pro = predictHyroxRace(buildState({
      format: 'pro_singles',
      stationBenchmarksDoubles: { sled_push: 180 },
      stationBenchmarkHistory: proHistory,
    }))!;
    const line = pro.stations.find(l => l.station === 'sled_push')!;
    expect(line.baseSec).toBeCloseTo(180 / pro.crossFormatStationRatio!, 6);
  });
});

describe('predictHyroxRace: converted stations cap confidence at medium, in both directions', () => {
  const singlesTimes = { ski_erg: 270, sled_push: 200, sled_pull: 260, burpee_broad_jumps: 300, row_erg: 290, farmer_carry: 110, sandbag_lunges: 280, wall_balls: 430 };

  it('doubles target, 8 singles benchmarks and a venue: medium, not high', () => {
    const p = predictHyroxRace(buildState({ format: 'open_doubles', stationBenchmarksSingles: singlesTimes, venueId: 'london-excel' }))!;
    expect(p.calibratedCount).toBe(8);
    expect(p.crossFormatConversion).toBe('singles_to_doubles');
    expect(p.stations.every(l => l.crossFormat)).toBe(true);
    expect(p.confidence).toBe('medium');
    // The cap is what holds it at medium.
    expect(p.crossFormatCapped).toBe(true);
  });

  it('crossFormatCapped is set only when the cap lowered high to medium: without a venue the same forecast is medium anyway', () => {
    const p = predictHyroxRace(buildState({ format: 'open_doubles', stationBenchmarksSingles: singlesTimes }))!;
    expect(p.crossFormatConversion).toBe('singles_to_doubles');
    expect(p.confidence).toBe('medium');
    expect(p.crossFormatCapped).toBeUndefined();
    const three = predictHyroxRace(buildState({ format: 'open_singles', venueId: 'london-excel',
      stationBenchmarksDoubles: { ski_erg: 200, row_erg: 220, wall_balls: 320 } }))!;
    expect(three.crossFormatConversion).toBe('doubles_to_singles');
    expect(three.confidence).toBe('medium');
    expect(three.crossFormatCapped).toBeUndefined();
  });

  it('the same times in the target format\'s own slot reach high with a venue', () => {
    const singles = predictHyroxRace(buildState({ format: 'open_singles', stationBenchmarksSingles: singlesTimes, venueId: 'london-excel' }))!;
    expect(singles.crossFormatConversion).toBeUndefined();
    expect(singles.confidence).toBe('high');
    expect(singles.crossFormatCapped).toBeUndefined();
    const doubles = predictHyroxRace(buildState({ format: 'open_doubles', stationBenchmarksDoubles: singlesTimes, venueId: 'london-excel',
      stationBenchmarkHistory: Object.fromEntries(Object.entries(singlesTimes).map(([st, sec]) => [st, [{ dateISO: dateNDaysAgo(3), sec, source: 'half_test' as const, format: 'open_doubles' as const }]])),
    }))!;
    expect(doubles.stations.some(l => l.crossFormat)).toBe(false);
    expect(doubles.confidence).toBe('high');
  });

  it('one converted station is enough to cap', () => {
    const p = predictHyroxRace(buildState({
      format: 'open_doubles',
      stationBenchmarksDoubles: { ...singlesTimes, ski_erg: undefined } as any,
      stationBenchmarksSingles: { ski_erg: 270 },
      stationBenchmarkHistory: Object.fromEntries(Object.entries(singlesTimes).filter(([st]) => st !== 'ski_erg').map(([st, sec]) => [st, [{ dateISO: dateNDaysAgo(3), sec, source: 'half_test' as const, format: 'open_doubles' as const }]])),
      venueId: 'london-excel',
    }))!;
    expect(p.stations.filter(l => l.crossFormat).map(l => l.station)).toEqual(['ski_erg']);
    expect(p.confidence).toBe('medium');
    expect(p.crossFormatCapped).toBe(true);
  });

  it('a solo test in the doubles slot read by a singles target is used as is: not converted, no cap', () => {
    const p = predictHyroxRace(buildState({
      format: 'open_singles',
      stationBenchmarksSingles: { ...singlesTimes, ski_erg: undefined } as any,
      stationBenchmarksDoubles: { ski_erg: 270 },
      stationBenchmarkHistory: { ski_erg: [{ dateISO: dateNDaysAgo(3), sec: 270, source: 'half_test', format: 'open_doubles' }] },
      venueId: 'london-excel',
    }))!;
    expect(p.calibratedCount).toBe(8);
    expect(p.stations.some(l => l.crossFormat)).toBe(false);
    expect(p.confidence).toBe('high');
  });
});
