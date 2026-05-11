/**
 * computeHyroxStaleness tests.
 *
 * Confirms time-based decay across categories (fresh/aging/stale/very_stale)
 * and physiology mitigation (current VDOT + MTL CTL + Strava CTL pulling
 * weights back toward 1.0 when the athlete has clearly held fitness).
 */

import { describe, it, expect } from 'vitest';
import { computeHyroxStaleness, bandFromVdot } from './hyrox-staleness';
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
  mtlCTL?: number | null;
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
      mtlCTL: opts.mtlCTL ?? undefined,
      runsPerWeek: 3,
      stationSessionsPerWeek: 1,
      bricksPerWeek: 1,
      weeklyHoursAvailable: 8,
      hyroxPreviousRaceDate: dateOffset != null ? dateNDaysAgo(dateOffset * 30.44) : undefined,
      hyroxPreviousTimeRaceId: opts.raceId,
    },
  } as unknown as SimulatorState;
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
    const withPhys = computeHyroxStaleness(buildState({
      raceDateOffsetMonths: 18, band: 'intermediate',
      vdot: 50,                 // above intermediate-implied 45
      mtlCTL: 130,              // above 70% × cap / 7 anchor
      ctlBaseline: 80,          // strong Strava signal
    }));
    expect(withPhys.physiologyMitigation).toBeGreaterThan(noPhys.physiologyMitigation);
    expect(withPhys.bandWeight).toBeGreaterThan(noPhys.bandWeight);
  });

  it('confidence cap remains low for stale even with strong physiology', () => {
    // Mitigation only adjusts weights, not the confidence cap. UI still shows
    // "stale" chip when the data is stale.
    const r = computeHyroxStaleness(buildState({
      raceDateOffsetMonths: 14, vdot: 60, mtlCTL: 200, ctlBaseline: 90,
    }));
    expect(r.confidenceCap).toBe('low');
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
