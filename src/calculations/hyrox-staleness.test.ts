/**
 * computeHyroxStaleness tests.
 *
 * Confirms time-based decay across categories (fresh/aging/stale/very_stale)
 * and physiology mitigation (current VDOT + Strava CTL pulling weights back
 * toward 1.0 when the athlete has clearly held fitness). The MTL signal reads
 * the plan (chronic MTL against the plan's prescription) and is covered on
 * real plans in hyrox-mtl-vs-plan.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { computeHyroxStaleness, computePhysiologyMitigation, hyroxEntrySplitsWeight, bandFromVdot } from './hyrox-staleness';
import { predictHyroxRace } from './race-prediction.hyrox';
import type { HyroxStation } from '@/types/triathlon';
import type { SimulatorState } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';

const DAY_MS = 1000 * 60 * 60 * 24;

function dateNDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function buildState(opts: {
  raceDateOffsetMonths?: number | null;
  band?: AbilityBand;
  vdot?: number | null;
  ctlBaseline?: number | null;
  raceId?: string;
}): SimulatorState {
  const dateOffset = opts.raceDateOffsetMonths;
  return {
    v: opts.vdot ?? null,
    ctlBaseline: opts.ctlBaseline ?? undefined,
    hyroxConfig: {
      format: 'open_singles',
      athleteBand: opts.band ?? 'intermediate',
      hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0,
      mtlCap: 1300,
      mtlHistory: [],
      runsPerWeek: 3,
      stationSessionsPerWeek: 1,
      bricksPerWeek: 1,
      weeklyHoursAvailable: 8,
      hyroxPreviousRaceDate: dateOffset != null ? dateNDaysAgo(dateOffset * 30.44) : undefined,
      hyroxPreviousTimeRaceId: opts.raceId,
    },
  } as unknown as SimulatorState;
}

/** A measured runner: a watch VO2max is a real running-fitness signal, so
 *  computePhysiologyMitigation reads state.v. */
function measured(s: SimulatorState): SimulatorState {
  return { ...s, vo2: s.v } as SimulatorState;
}

describe('computeHyroxStaleness', () => {
  it('no race date → unknown, full trust', () => {
    const r = computeHyroxStaleness(buildState({}));
    expect(r.category).toBe('unknown');
    expect(r.bandWeight).toBe(1);
    expect(r.splitsWeight).toBe(1);
    expect(r.confidenceCap).toBeNull();
  });

  it('< 6 months ago → fresh, weights 1.0, no cap', () => {
    const r = computeHyroxStaleness(buildState({ raceDateOffsetMonths: 3 }));
    expect(r.category).toBe('fresh');
    expect(r.bandWeight).toBe(1);
    expect(r.splitsWeight).toBe(1);
    expect(r.confidenceCap).toBeNull();
  });

  it('9 months ago + neutral physiology → aging, partial decay, medium cap', () => {
    const r = computeHyroxStaleness(buildState({ raceDateOffsetMonths: 9 }));
    expect(r.category).toBe('aging');
    expect(r.bandWeight).toBeLessThan(1);
    expect(r.bandWeight).toBeGreaterThan(0.4);
    expect(r.splitsWeight).toBeGreaterThan(r.bandWeight); // splits decay slower
    expect(r.confidenceCap).toBe('medium');
  });

  it('14 months ago + neutral physiology → stale, low cap', () => {
    const r = computeHyroxStaleness(buildState({ raceDateOffsetMonths: 14 }));
    expect(r.category).toBe('stale');
    expect(r.bandWeight).toBeLessThan(0.6);
    expect(r.confidenceCap).toBe('low');
  });

  it('30 months ago → very_stale, bandWeight floor 0.2 + mitigation', () => {
    const r = computeHyroxStaleness(buildState({ raceDateOffsetMonths: 30 }));
    expect(r.category).toBe('very_stale');
    expect(r.confidenceCap).toBe('low');
    // Without physiology, mitigation = 0.5, so weights stay at base.
    expect(r.bandWeight).toBeLessThanOrEqual(0.25);
  });

  it('strong current VDOT lifts weights back toward 1.0 (mitigation working)', () => {
    const noPhys = computeHyroxStaleness(buildState({
      raceDateOffsetMonths: 18, band: 'intermediate',
    }));
    const withPhys = computeHyroxStaleness(measured(buildState({
      raceDateOffsetMonths: 18, band: 'intermediate',
      vdot: 50,                 // above intermediate-implied 45
      ctlBaseline: 80,          // strong Strava signal
    })));
    expect(withPhys.physiologyMitigation).toBeGreaterThan(noPhys.physiologyMitigation);
    expect(withPhys.bandWeight).toBeGreaterThan(noPhys.bandWeight);
  });

  it('a bare-baseline VDOT (no running-fitness signal) gives no mitigation; a measured one does', () => {
    // VDOT 50 on a beginner band (implied 32) scored the maximum, 1.0, and
    // released the stale-race penalty off the default value (2026-10-22).
    const bare = buildState({ raceDateOffsetMonths: 15, band: 'beginner', vdot: 50 });
    expect(computePhysiologyMitigation(bare)).toBe(0.5);
    expect(computePhysiologyMitigation(measured(bare))).toBe(1);
  });

  it('confidence cap remains low for stale even with strong physiology', () => {
    // Mitigation only adjusts weights, not the confidence cap. UI still shows
    // "stale" chip when the data is stale.
    const r = computeHyroxStaleness(buildState({
      raceDateOffsetMonths: 14, vdot: 60, ctlBaseline: 90,
    }));
    expect(r.confidenceCap).toBe('low');
  });
});

describe('hyroxEntrySplitsWeight (lane H3c: a station value decays by its own date)', () => {
  it('reads the race splits\' curve at the entry\'s age, with the same mitigation', () => {
    for (const months of [3, 9, 14, 30]) {
      const state = buildState({ raceDateOffsetMonths: months });
      const race = computeHyroxStaleness(state);
      expect(hyroxEntrySplitsWeight(dateNDaysAgo(months * 30.44), race.physiologyMitigation)).toBeCloseTo(race.splitsWeight, 2);
    }
  });
  it('a missing, unparseable or future date is full trust', () => {
    expect(hyroxEntrySplitsWeight(undefined, 0.5)).toBe(1);
    expect(hyroxEntrySplitsWeight('not a date', 0.5)).toBe(1);
    expect(hyroxEntrySplitsWeight(dateNDaysAgo(-30), 0.5)).toBe(1);
  });
});

describe('the forecast decays each station by its own date (lane H3c)', () => {
  // Times well away from the intermediate women's seeds, so the blend shows.
  const SLOT: Record<HyroxStation, number> = { ski_erg: 255, sled_push: 140, sled_pull: 240, burpee_broad_jumps: 270, row_erg: 275, farmer_carry: 105, sandbag_lunges: 250, wall_balls: 330 };
  const forecast = (o: { raceMonths?: number; source: 'full_test' | 'race'; entryMonths: number }) => {
    const hist: Record<string, unknown[]> = {};
    for (const [st, sec] of Object.entries(SLOT)) {
      hist[st] = [{ dateISO: dateNDaysAgo(o.entryMonths * 30.44), sec, source: o.source, format: 'open_singles', ...(o.source === 'race' ? { proWeights: false } : {}) }];
    }
    const s = buildState({ raceDateOffsetMonths: o.raceMonths ?? null, vdot: 45 });
    Object.assign(s.hyroxConfig!, { stationBenchmarksSingles: SLOT, stationBenchmarkHistory: hist });
    (s as { biologicalSex?: string }).biologicalSex = 'female';
    return { p: predictHyroxRace(s)!, s };
  };
  const line = (p: ReturnType<typeof predictHyroxRace>, st: HyroxStation) => p!.stations.find(l => l.station === st)!.baseSec;

  it('a station test from last week is used as is, whatever the race\'s age', () => {
    for (const raceMonths of [9, 18]) {
      const { p } = forecast({ raceMonths, source: 'full_test', entryMonths: 0.25 });
      for (const st of Object.keys(SLOT) as HyroxStation[]) expect(line(p, st)).toBeCloseTo(SLOT[st], 6);
    }
  });

  it('a race split still decays by the race\'s age', () => {
    const { p } = forecast({ raceMonths: 9, source: 'race', entryMonths: 9 });
    expect(line(p, 'wall_balls')).toBeGreaterThan(SLOT.wall_balls);
  });

  it('an old station test decays by its own age, with a recent race or none on file', () => {
    for (const raceMonths of [3, undefined]) {
      const { p, s } = forecast({ raceMonths, source: 'full_test', entryMonths: 15 });
      const w = hyroxEntrySplitsWeight(dateNDaysAgo(15 * 30.44), computePhysiologyMitigation(s));
      expect(w).toBeLessThan(1);
      expect(line(p, 'wall_balls')).toBeGreaterThan(SLOT.wall_balls);
    }
  });

  it('a test and the race on the same date blend exactly as before', () => {
    const test = forecast({ raceMonths: 9, source: 'full_test', entryMonths: 9 }).p;
    const race = forecast({ raceMonths: 9, source: 'race', entryMonths: 9 }).p;
    expect(test.totalSec).toBeCloseTo(race.totalSec, 0);
  });
});

describe('bandFromVdot', () => {
  it('VDOT 46 → intermediate', () => {
    expect(bandFromVdot(46)).toBe('intermediate');
  });
  it('VDOT 60 → competitive', () => {
    expect(bandFromVdot(60)).toBe('competitive');
  });
  it('VDOT 25 → total_beginner', () => {
    expect(bandFromVdot(25)).toBe('total_beginner');
  });
  it('null → null', () => {
    expect(bandFromVdot(null)).toBeNull();
    expect(bandFromVdot(undefined)).toBeNull();
  });
});
