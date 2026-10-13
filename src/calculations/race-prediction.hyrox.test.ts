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
    // fallback, no cross-format flag.
    const singlesSki = 250;
    const calibrated = predictHyroxRace(buildState({
      format: 'open_doubles',
      stationBenchmarksSingles: { ski_erg: singlesSki },
    }))!;
    expect(calibrated.crossFormatConversion).toBeUndefined();
    const skiLine = calibrated.stations.find(l => l.station === 'ski_erg')!;
    expect(skiLine.source).toBe('calibrated');
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
    // Fully calibrated: confidence follows the count, like singles benchmarks
    // feeding a doubles target (no cross-format cap).
    expect(singles.calibratedCount).toBe(8);
    expect(singles.confidence).toBe('medium');
    expect(predictHyroxRace(buildState({ ...cfg, format: 'open_singles', venueId: 'london-excel' }))!.confidence).toBe('high');
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

  it('a singles slot with values wins over the doubles slot (slot-level resolution)', () => {
    const singles = predictHyroxRace(buildState({
      format: 'open_singles',
      stationBenchmarksSingles: { row_erg: 260 },
      stationBenchmarksDoubles: doublesSplits,
      stationBenchmarkHistory: raceHistory,
    }))!;
    expect(singles.crossFormatConversion).toBeUndefined();
    expect(singles.calibratedCount).toBe(1);
    expect(singles.stations.find(l => l.station === 'row_erg')!.baseSec).toBe(260);
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
