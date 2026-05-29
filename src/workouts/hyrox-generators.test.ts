import { describe, it, expect } from 'vitest';
import { generateHyroxStation, type StationParams } from './hyrox-generators';
import type { AbilityBand, HyroxConfig } from '@/types/triathlon';

const FULL_ACCESS: HyroxConfig['stationAccess'] = { sled: 'always', skiErg: true, rowErg: true };

function stationParams(over: Partial<StationParams> = {}): StationParams {
  return {
    kind: 'station_density',
    targetMinutes: 55,
    band: 'intermediate',
    stationAccess: FULL_ACCESS,
    phase: 'build',
    slotIndex: 0,
    ...over,
  };
}

/** Reconstruct the prescribed seconds from the workout's encoded structure:
 *  station work x rounds + inter-station rests + inter-round rests. This is the
 *  number the headline duration must agree with (issue 1: "55m doesn't add up").  */
function prescribedSeconds(w: ReturnType<typeof generateHyroxStation>): number {
  const comps = (w.hyroxComponents ?? []).filter(c => c.type !== 'run');
  const rounds = w.hyroxRounds ?? 1;
  const work = comps.reduce((s, c) => s + (c.durationSec ?? 0), 0) * rounds;
  const interStation = comps.reduce((s, c) => s + (c.restAfterSec ?? 0), 0);
  // last station of each round uses inter-round rest instead of inter-station
  const lastRest = comps.length ? (comps[comps.length - 1].restAfterSec ?? 0) : 0;
  const withinRoundRest = (interStation - lastRest) * rounds;
  const roundRest = Math.max(0, rounds - 1) * (w.hyroxRoundRestSec ?? 0);
  return work + withinRoundRest + roundRest;
}

describe('generateStationDensity', () => {
  it('is always a multi-round circuit (never the old "two sets of two")', () => {
    const w = generateHyroxStation(stationParams({ kind: 'station_density', targetMinutes: 55 }));
    expect(w.hyroxRounds).toBeGreaterThanOrEqual(2);
  });

  it('fills the allocated slot (duration lands near the budget, not under by half)', () => {
    const target = 55;
    const w = generateHyroxStation(stationParams({ targetMinutes: target }));
    // Nearest-round fill: the session fills the slot within roughly half a round.
    expect(w.estimatedDurationMin!).toBeGreaterThanOrEqual(target * 0.75);
    expect(w.estimatedDurationMin!).toBeLessThanOrEqual(target * 1.25);
  });

  it('caps rounds at the band coach dose ceiling', () => {
    const beginner = generateHyroxStation(stationParams({ band: 'total_beginner', targetMinutes: 200 }));
    expect(beginner.hyroxRounds!).toBeLessThanOrEqual(4);

    const elite = generateHyroxStation(stationParams({ band: 'competitive', targetMinutes: 300 }));
    expect(elite.hyroxRounds!).toBeLessThanOrEqual(8);
  });

  it('headline duration agrees with the prescribed work (no phantom 55m)', () => {
    const w = generateHyroxStation(stationParams({ targetMinutes: 55 }));
    const expectedMin = Math.round(prescribedSeconds(w) / 60);
    expect(w.estimatedDurationMin).toBe(expectedMin);
  });

  it('encodes inter-station rest on each station component and inter-round rest on the workout', () => {
    const w = generateHyroxStation(stationParams());
    const stations = (w.hyroxComponents ?? []).filter(c => c.type !== 'run');
    expect(stations.length).toBeGreaterThanOrEqual(2);
    expect(stations.every(c => c.restAfterSec === 30)).toBe(true);
    expect(w.hyroxRoundRestSec).toBe(120);
  });
});

describe('generateStationTechnique', () => {
  it('fills the budget and encodes 60s/3min rest', () => {
    const w = generateHyroxStation(stationParams({ kind: 'station_technique', targetMinutes: 55 }));
    expect(w.hyroxRounds).toBeGreaterThanOrEqual(2);
    const stations = (w.hyroxComponents ?? []).filter(c => c.type !== 'run');
    expect(stations.every(c => c.restAfterSec === 60)).toBe(true);
    expect(w.hyroxRoundRestSec).toBe(180);
  });

  it('headline duration = station work+rest + run finish', () => {
    const w = generateHyroxStation(stationParams({ kind: 'station_technique', targetMinutes: 55 }));
    const runMatch = w.d?.match(/Then\s+(\d+)\s+min easy run/);
    const runMin = runMatch ? parseInt(runMatch[1], 10) : 0;
    const expected = Math.round(prescribedSeconds(w) / 60) + runMin;
    expect(w.estimatedDurationMin).toBe(expected);
  });
});
