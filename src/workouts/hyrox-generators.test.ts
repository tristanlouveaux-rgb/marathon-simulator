/**
 * HYROX station sessions and bricks (lane H2b part 1, generator v19): the
 * two station formats per tier, the race-pace volume progression, the
 * beginner loads, the bricks by tier, the prescriptions every description
 * carries (damper, lanes, the wall-ball target by division and sex, the
 * tier's loads, the doubles split) and the cuts the MTL cap and the ceilings
 * make. Parameter sheet of 2026-10-12, revised after its fact-check.
 */
import { describe, it, expect } from 'vitest';
import {
  generateHyroxStation, generateHyroxBrick, withHyroxRounds, withoutHyroxStation, hyroxStationToCut,
  hyroxMinRounds, hyroxStationRowText, hyroxSessionNotes, hyroxRoundsBreakdown, HYROX_EASY_PASS_TIME_FACTOR, MIN_CIRCUIT_ROUNDS,
  withHyroxStationLoads, generateHyroxAssessment,
  type StationParams, type BrickParams,
} from './hyrox-generators';
import { hyroxComponentSets, hyroxSessionDurationSec } from './hyrox-session-shape';
import { HYROX_STATION_SET_FRACTION } from './hyrox-station-dose';
import { hyroxStationSeedsAtTarget, type HyroxSeedStateInput } from '@/calculations/hyrox-results';
import { ECCENTRIC_HEAVY_STATIONS, RACE_WEEK_EXCLUDED_STATIONS } from '@/constants/hyrox-constants';
import type { HyroxComponent, HyroxConfig, HyroxStation } from '@/types/triathlon';
import type { Workout } from '@/types/state';

const FULL_ACCESS: HyroxConfig['stationAccess'] = { sled: 'always', skiErg: true, rowErg: true };
const WOMAN: HyroxSeedStateInput = { biologicalSex: 'female', hyroxConfig: { format: 'open_singles', athleteBand: 'beginner' } as HyroxConfig };
const MAN: HyroxSeedStateInput = { biologicalSex: 'male', hyroxConfig: { format: 'open_singles', athleteBand: 'intermediate' } as HyroxConfig };

function station(over: Partial<StationParams> = {}): Workout {
  return generateHyroxStation({
    kind: 'station_density', targetMinutes: 70, band: 'intermediate', stationAccess: FULL_ACCESS,
    phase: 'build', slotIndex: 0, ...over,
  });
}
function brick(over: Partial<BrickParams> = {}): Workout {
  return generateHyroxBrick({
    kind: 'brick', targetMinutes: 90, band: 'intermediate', stationAccess: FULL_ACCESS,
    phase: 'build', slotIndex: 0, ...over,
  });
}
const stationsOf = (w: Workout): HyroxComponent[] => (w.hyroxComponents ?? []).filter(c => c.type !== 'run');
const setsOf = (w: Workout, c: HyroxComponent) => hyroxComponentSets(c, w.hyroxRounds ?? 1);

describe('technique station session', () => {
  it('intermediate and advanced: 3 stations, 0.5 x race volume in 2 quarter-station sets, RPE 5, 2 min after every set', () => {
    for (const band of ['intermediate', 'competitive'] as const) {
      const w = station({ kind: 'station_technique', band });
      expect(w.n).toBe('Station Circuit');
      expect(w.rpe).toBe(5);
      expect(stationsOf(w)).toHaveLength(3);
      expect(w.hyroxRounds).toBe(2);
      for (const c of stationsOf(w)) {
        expect(setsOf(w, c)).toBe(2);
        expect(c.raceFraction).toBe(HYROX_STATION_SET_FRACTION);
        expect(c.restAfterSec).toBe(120);
      }
      expect(w.hyroxRoundRestSec).toBe(120);
      expect(w.hyroxSpec?.format).toBe('technique');
    }
  });

  it('a technique set is a quarter of the race split at the easy-pass factor (slower than race pace), and the duration is the walk', () => {
    const w = station({ kind: 'station_technique', band: 'intermediate' });
    const seeds = hyroxStationSeedsAtTarget({}, 'intermediate');
    for (const c of stationsOf(w)) {
      expect(c.durationSec).toBe(Math.round(seeds[c.type as HyroxStation] * HYROX_STATION_SET_FRACTION * HYROX_EASY_PASS_TIME_FACTOR));
    }
    expect(w.estimatedDurationMin).toBe(Math.round(hyroxSessionDurationSec(w) / 60));
    expect(w.d).toContain('Technique at RPE 5');
    expect(w.d).toContain('no time target');
    expect(w.d).not.toMatch(/easy run/); // the old run finish is gone
  });

  it('beginner: 4 stations rotated so each recurs every 2 weeks; sleds take 4 sets of one lane, the others 2', () => {
    const wk1 = station({ kind: 'station_technique', band: 'beginner', phase: 'build', slotIndex: 7 });
    const wk2 = station({ kind: 'station_technique', band: 'beginner', phase: 'build', slotIndex: 8 });
    expect(stationsOf(wk1)).toHaveLength(4);
    expect(stationsOf(wk2)).toHaveLength(4);
    const both = new Set([...stationsOf(wk1), ...stationsOf(wk2)].map(c => c.type));
    expect(both.size).toBe(8);
    const withSleds = [wk1, wk2].find(w => stationsOf(w).some(c => c.type === 'sled_push'))!;
    expect(withSleds.hyroxRounds).toBe(4);
    for (const c of stationsOf(withSleds)) {
      if (c.type === 'sled_push' || c.type === 'sled_pull') {
        expect(setsOf(withSleds, c)).toBe(4);
        expect(c.distanceM).toBe(12.5);
        expect(c.inRounds).toBeUndefined();
      } else {
        expect(setsOf(withSleds, c)).toBe(2);
        expect(c.inRounds).toEqual([1, 2]);
      }
    }
    expect(withSleds.d).toContain('Sled Push: 4 × 1 lane (12.5 m)');
    // The header says which rounds hold which stations, matching the lines
    // (lane H2b review: '4 rounds, one set of each station a round' read
    // against '2 ×' lines for the other stations).
    const others = stationsOf(withSleds).filter(c => c.type !== 'sled_push' && c.type !== 'sled_pull');
    expect(withSleds.d).not.toContain('one set of each station a round');
    expect(withSleds.d).toContain('4 rounds, 2 min rest after every set. Rounds 1 and 2: every station.');
    const sledNames = stationsOf(withSleds).filter(c => c.type === 'sled_push' || c.type === 'sled_pull').map(c => (c.type === 'sled_push' ? 'Sled Push' : 'Sled Pull'));
    expect(withSleds.d).toContain(`Rounds 3 and 4: ${sledNames.join(' and ')} only.`);
    expect(hyroxRoundsBreakdown(withSleds)).toBe(`Rounds 1 and 2: every station. Rounds 3 and 4: ${sledNames.join(' and ')} only.`);
    expect(others.length).toBeGreaterThan(0);
    // A session whose stations all run every round keeps the one-line shape.
    const noSleds = [wk1, wk2].find(w => w !== withSleds)!;
    expect(hyroxRoundsBreakdown(noSleds)).toBeNull();
    expect(noSleds.d).toContain('one set of each station a round');
  });

  it('beginner base holds none of the eccentric-heavy stations; race week none of them nor the sleds', () => {
    for (let slot = 0; slot < 8; slot++) {
      const base = station({ kind: 'station_technique', band: 'beginner', phase: 'base', slotIndex: slot });
      expect(stationsOf(base).some(c => ECCENTRIC_HEAVY_STATIONS.includes(c.type as HyroxStation))).toBe(false);
      expect(stationsOf(base).length).toBeGreaterThanOrEqual(2);
      const rw = station({ kind: 'station_technique', band: 'intermediate', phase: 'taper', slotIndex: slot, raceWeek: true });
      expect(stationsOf(rw).some(c => RACE_WEEK_EXCLUDED_STATIONS.includes(c.type as HyroxStation))).toBe(false);
    }
  });

  it('a target smaller than the dose takes whole rounds off, never under MIN_CIRCUIT_ROUNDS', () => {
    const big = station({ kind: 'station_technique', band: 'beginner', phase: 'build', slotIndex: 8 });
    const small = station({ kind: 'station_technique', band: 'beginner', phase: 'build', slotIndex: 8, targetMinutes: 1 });
    expect(big.hyroxRounds).toBeGreaterThan(MIN_CIRCUIT_ROUNDS);
    expect(small.hyroxRounds).toBe(MIN_CIRCUIT_ROUNDS);
    expect(small.estimatedDurationMin!).toBeLessThan(big.estimatedDurationMin!);
  });
});

describe('race-pace station session', () => {
  it('3 stations, the weakest first, race weight, RPE 7, 90 s after every set, a set target at the race split pro rata', () => {
    const w = station({ weakest: 'sled_pull', doseFraction: 1 });
    expect(w.n).toBe('Race-Pace Stations');
    expect(w.rpe).toBe(7);
    expect(stationsOf(w)).toHaveLength(3);
    expect(stationsOf(w)[0].type).toBe('sled_pull');
    expect(new Set(stationsOf(w).map(c => c.type)).size).toBe(3);
    const seeds = hyroxStationSeedsAtTarget({}, 'intermediate');
    for (const c of stationsOf(w)) {
      expect(c.restAfterSec).toBe(90);
      expect(c.durationSec).toBe(Math.round(seeds[c.type as HyroxStation] * HYROX_STATION_SET_FRACTION));
      expect(c.loadPct).toBeUndefined(); // race weight
    }
    expect(w.d).toContain('Race pace at RPE 7');
    expect(w.d).toMatch(/about \d+:\d\d a set/);
    expect(w.d).toContain("Sled Pull is the forecast's weakest station.");
    expect(hyroxSessionNotes(w)).toEqual(["Sled Pull is the forecast's weakest station."]);
  });

  it('the dose follows the week toward peak: 2, 3, then 4 sets (0.5 x, 0.75 x, 1.0 x), to the nearest quarter', () => {
    expect(station({ doseFraction: 0.6 }).hyroxRounds).toBe(2);
    expect(station({ doseFraction: 0.8 }).hyroxRounds).toBe(3);
    expect(station({ doseFraction: 0.92 }).hyroxRounds).toBe(4); // build: the sheet's 1.0 x
    expect(station({ doseFraction: 1 }).hyroxRounds).toBe(4);
    expect(station({}).hyroxRounds).toBe(4); // no fraction: the full dose
    const peak = station({ doseFraction: 1, weakest: 'wall_balls' });
    expect(peak.d).toContain('Wall Balls: 4 × 25 reps');
  });

  it('the week\'s size takes sets off (doseMinutes), never under the technique dose', () => {
    const full = station({ doseFraction: 1 });
    const fit = station({ doseFraction: 1, doseMinutes: full.estimatedDurationMin! - 1 });
    expect(fit.hyroxRounds).toBe(3);
    expect(station({ doseFraction: 1, doseMinutes: 1 }).hyroxRounds).toBe(2);
  });

  it('a weakest station the athlete cannot train is not held', () => {
    const w = station({ weakest: 'sled_push', stationAccess: { sled: 'never', skiErg: true, rowErg: true } });
    expect(stationsOf(w).some(c => c.type === 'sled_push')).toBe(false);
    expect(w.hyroxSpec?.weakest).toBeUndefined();
  });
});

describe('bricks by tier', () => {
  const runOf = (w: Workout) => (w.hyroxComponents ?? []).find(c => c.type === 'run')!;

  it('beginner: 3 x 400 m at goal race pace, no faster, into 1 station at 0.25 x, 30 s jog, 2 min between rounds', () => {
    const w = brick({ kind: 'mini_brick', band: 'beginner', slotIndex: 0 });
    expect(w.n).toBe('Mini Brick');
    expect(w.hyroxRounds).toBe(3);
    expect(runOf(w).distanceM).toBe(400);
    expect(stationsOf(w)).toHaveLength(1);
    expect(setsOf(w, stationsOf(w)[0])).toBe(3);
    expect(stationsOf(w)[0].raceFraction).toBe(0.25);
    expect(w.hyroxRoundRestSec).toBe(120);
    expect(w.hyroxSpec?.transitionSec).toBe(30);
    expect(w.d).toMatch(/^3 rounds: 400 m at HYROX race pace \(~\d+:\d\d\/km\), no faster, a 30 s jog to the station, then /);
    expect(w.d).toContain('2 min rest between rounds.');
  });

  it('intermediate: 4 x 800 m at goal race pace into 2 stations alternating, race weight', () => {
    const w = brick({ band: 'intermediate', slotIndex: 1 });
    expect(w.hyroxRounds).toBe(4);
    expect(runOf(w).distanceM).toBe(800);
    const [a, b] = stationsOf(w);
    expect(a.inRounds).toEqual([1, 3]);
    expect(b.inRounds).toEqual([2, 4]);
    expect(w.hyroxRoundRestSec).toBe(120);
    expect(w.rpe).toBe(7);
    expect(w.d).toContain('alternating:');
    expect(w.d).toContain('(rounds 1 and 3)');
  });

  it('advanced key brick: 6 x 800 m at race pace or faster, negative split, one eccentric station, the jog only', () => {
    for (let slot = 0; slot < 6; slot++) {
      const w = brick({ band: 'advanced', slotIndex: slot });
      expect(w.hyroxRounds).toBe(6);
      expect(w.hyroxRoundRestSec).toBe(0);
      const st = stationsOf(w).map(c => c.type as HyroxStation);
      expect(st).toHaveLength(2);
      expect(st.filter(s => ECCENTRIC_HEAVY_STATIONS.includes(s))).toHaveLength(1);
      expect(w.d).toContain('or faster, the last rounds fastest (negative split)');
      expect(w.d).toContain('No rest beyond the jog.');
    }
  });

  it('advanced secondary brick: 4 x 800 m easy into ergs, sleds or the farmers carry at technique effort, not a hard session', () => {
    for (let slot = 0; slot < 6; slot++) {
      const w = brick({ kind: 'mini_brick', band: 'advanced', phase: 'peak', slotIndex: slot, secondary: true });
      expect(w.n).toBe('Secondary Brick');
      expect(w.hyroxLight).toBe(true);
      expect(w.rpe).toBe(5);
      expect(w.hyroxRounds).toBe(4);
      expect(stationsOf(w).every(c => ['ski_erg', 'row_erg', 'sled_push', 'sled_pull', 'farmer_carry'].includes(c.type))).toBe(true);
      expect(w.d).toContain('800 m easy');
      expect(w.d).toContain('A lighter flow, not a hard session.');
      // Technique effort: no station above the technique dose (2 sets, 0.5 x).
      for (const c of stationsOf(w)) expect(setsOf(w, c)).toBeLessThanOrEqual(2);
    }
  });

  it('a secondary brick with one usable station keeps it to the technique dose (0.5 x), the other rounds run straight on', () => {
    // No ergs and no sled: the farmers carry is the only secondary station.
    const w = brick({ kind: 'mini_brick', band: 'advanced', phase: 'peak', slotIndex: 0, secondary: true, stationAccess: { sled: 'never', skiErg: false, rowErg: false } });
    expect(stationsOf(w).map(c => c.type)).toEqual(['farmer_carry']);
    const [fc] = stationsOf(w);
    expect(fc.inRounds).toEqual([1, 3]);
    expect(setsOf(w, fc)).toBe(2);
    expect(w.d).toContain('in rounds 1 and 3.');
    // The main brick's single-station formats keep a station every round.
    const b = brick({ kind: 'mini_brick', band: 'beginner', slotIndex: 0, stationAccess: { sled: 'never', skiErg: false, rowErg: false } });
    expect(setsOf(b, stationsOf(b)[0])).toBe(3);
  });

  it('the taper\'s brick takes the beginner structure on ergs', () => {
    const w = brick({ kind: 'mini_brick', band: 'intermediate', phase: 'taper', slotIndex: 3 });
    expect(w.hyroxRounds).toBe(3);
    expect(stationsOf(w).every(c => c.type === 'ski_erg' || c.type === 'row_erg')).toBe(true);
  });

  it('runs at the athlete\'s HYROX run pace when set', () => {
    const w = brick({ runPaceSecKm: 300 });
    expect(runOf(w).durationSec).toBe(240); // 800 m at 5:00/km
    expect(w.d).toContain('~5:00/km');
  });
});

describe('prescriptions: damper, lanes, the wall-ball target, loads, doubles', () => {
  const peak = (seed: HyroxSeedStateInput, loadTier: 'W-Open' | 'M-Open' | 'M-Pro', weakest: HyroxStation = 'wall_balls') =>
    station({ seed, loadTier, weakest, doseFraction: 1, band: 'intermediate' });

  it('SkiErg and row at damper 6; sleds counted in 12.5 m lanes', () => {
    const w = station({ kind: 'station_technique', band: 'intermediate', slotIndex: 0 }); // SkiErg, sled push, sled pull
    expect(w.d).toContain('SkiErg: 2 × 250 m, damper 6.');
    expect(w.d).toMatch(/Sled Push: 2 × 1 lane \(12\.5 m\), \d+ kg incl\. sled\./);
    const row = station({ kind: 'station_technique', band: 'intermediate', slotIndex: 1 });
    expect(row.d).toContain('Row Erg: 2 × 250 m, damper 6.');
  });

  it('women: 4 kg ball to 2.70 m; men: 6 kg to 3.00 m; Women Pro: 6 kg to 2.70 m; Men Pro: 9 kg to 3.00 m', () => {
    expect(peak(WOMAN, 'W-Open').d).toContain('Wall Balls: 4 × 25 reps, 4 kg ball to 2.70 m');
    expect(peak(MAN, 'M-Open').d).toContain('Wall Balls: 4 × 25 reps, 6 kg ball to 3.00 m');
    const womanPro: HyroxSeedStateInput = { biologicalSex: 'female', hyroxConfig: { format: 'pro_singles', athleteBand: 'intermediate' } as HyroxConfig };
    expect(peak(womanPro, 'M-Open').d).toContain('6 kg ball to 2.70 m');
    const manPro: HyroxSeedStateInput = { biologicalSex: 'male', hyroxConfig: { format: 'pro_singles', athleteBand: 'intermediate' } as HyroxConfig };
    expect(peak(manPro, 'M-Pro').d).toContain('9 kg ball to 3.00 m');
  });

  it('Mixed Doubles: the woman throws the Men Open 6 kg ball to 2.70 m, half of every station, said once', () => {
    const mixed: HyroxSeedStateInput = { biologicalSex: 'female', hyroxConfig: { format: 'open_doubles', division: 'mixed', athleteBand: 'novice' } as HyroxConfig };
    const w = peak(mixed, 'M-Open');
    expect(w.d).toContain('Wall Balls: 2 × 25 reps, 6 kg ball to 2.70 m');
    expect(w.hyroxRounds).toBe(2); // half the 4 race-pace sets
    expect(w.d.match(/Doubles: half of every station/g)).toHaveLength(1);
    const tech = station({ kind: 'station_technique', seed: mixed, loadTier: 'M-Open' });
    expect(tech.hyroxRounds).toBe(1);
    expect(hyroxMinRounds(tech)).toBe(1);
    expect(tech.d.match(/Doubles:/g)).toHaveLength(1);
  });

  it('unknown sex: both target heights', () => {
    expect(peak({}, 'M-Open').d).toContain('6 kg ball to 2.70 m (women) or 3.00 m (men)');
  });

  it('loads come from the athlete\'s load tier', () => {
    const sled = (loadTier: 'W-Open' | 'M-Open' | 'M-Pro') => station({ weakest: 'sled_push', doseFraction: 1, loadTier });
    expect(sled('W-Open').d).toContain('Sled Push: 4 × 1 lane (12.5 m), 102 kg incl. sled');
    expect(sled('M-Open').d).toContain('152 kg incl. sled');
    expect(sled('M-Pro').d).toContain('202 kg incl. sled');
    const carry = station({ weakest: 'farmer_carry', doseFraction: 1, loadTier: 'M-Pro' });
    expect(carry.d).toContain('Farmer Carry: 4 × 50 m, 2 × 32 kg');
  });

  it('a beginner\'s loads below race weight say so: the sled unloaded, 50%, and the implement\'s own share of race weight', () => {
    const loads = { sled_push: 0, sled_pull: 37.5, farmer_carry: 8, sandbag_lunges: 5, wall_balls: 2 };
    const a = station({ kind: 'station_technique', band: 'beginner', slotIndex: 8, seed: WOMAN, loadTier: 'W-Open', stationLoads: loads });
    const b = station({ kind: 'station_technique', band: 'beginner', slotIndex: 7, seed: WOMAN, loadTier: 'W-Open', stationLoads: loads });
    const text = `${a.d} ${b.d}`;
    expect(text).toContain('Sled Push: 4 × 1 lane (12.5 m), sled unloaded.');
    expect(text).toContain('Sled Pull: 4 × 1 lane (12.5 m), 37.5 kg incl. sled (48% of race weight).');
    expect(text).toContain('Farmer Carry: 2 × 50 m, 2 × 8 kg (50% of race weight).');
    expect(text).toContain('Sandbag Lunges: 2 × 25 m, 5 kg sandbag (50% of race weight).');
    expect(text).toContain('Wall Balls: 2 × 25 reps, 2 kg ball to 2.70 m (50% of race weight).');
    const carry = stationsOf(b).find(c => c.type === 'farmer_carry')!;
    expect(carry.loadKg).toBe(8);
    expect(carry.loadPct).toBeCloseTo(0.5, 9);
  });

  it('withHyroxStationLoads lowers a load to the week\'s own, never raises one, and recomputes the MTL (deload and taper copies, 2026-10-20)', () => {
    const stepped = { sled_push: 52.5, sled_pull: 40, farmer_carry: 12, sandbag_lunges: 10, wall_balls: 4 };
    const w = station({ kind: 'station_technique', band: 'beginner', slotIndex: 8, seed: WOMAN, loadTier: 'W-Open', stationLoads: stepped, bodyWeightKg: 65 });
    const own = { sled_push: 50, sled_pull: 37.5, farmer_carry: 8, sandbag_lunges: 5, wall_balls: 2 };
    const lowered = withHyroxStationLoads(w, own, 'W-Open', 65);
    for (const c of stationsOf(lowered)) {
      if (c.loadKg == null) continue;
      expect(c.loadKg).toBe(own[c.type as keyof typeof own]);
    }
    expect(lowered.musculoTendonLoad!).toBeLessThan(w.musculoTendonLoad!);
    expect(lowered.estimatedDurationMin).toBe(w.estimatedDurationMin);
    // Heavier loads than the session's are ignored.
    expect(withHyroxStationLoads(w, { sled_push: 100, farmer_carry: 16 }, 'W-Open', 65)).toBe(w);
    expect(withHyroxStationLoads(w, undefined, 'W-Open', 65)).toBe(w);
  });

  it('a beginner\'s week-1 assessment runs the sleds unloaded at the week\'s loads and says those times are not race times (2026-10-20)', () => {
    const own = { sled_push: 0, sled_pull: 0, farmer_carry: 8, sandbag_lunges: 5, wall_balls: 2 };
    const beginner = generateHyroxAssessment({ band: 'beginner', stationAccess: FULL_ACCESS, loadTier: 'W-Open', seed: WOMAN, stationLoads: own, bodyWeightKg: 65 });
    const raceWeight = generateHyroxAssessment({ band: 'beginner', stationAccess: FULL_ACCESS, loadTier: 'W-Open', seed: WOMAN, bodyWeightKg: 65 });
    const sled = beginner.hyroxComponents!.find(c => c.type === 'sled_push')!;
    expect(sled.loadKg).toBe(0);
    expect(beginner.hyroxComponents!.find(c => c.type === 'farmer_carry')!.loadKg).toBe(8);
    expect(beginner.hyroxComponents!.find(c => c.type === 'ski_erg')!.loadKg).toBeUndefined();
    expect(beginner.musculoTendonLoad!).toBeLessThan(raceWeight.musculoTendonLoad!);
    expect(beginner.d).toMatch(/the Sled Push, Sled Pull, Farmer Carry, Sandbag Lunges, Wall Balls times are not race times/);
    expect(raceWeight.hyroxComponents!.every(c => c.loadKg == null)).toBe(true);
    expect(raceWeight.d).not.toMatch(/not race times/);
    for (const w of [beginner, raceWeight]) expect(w.d).not.toMatch(/\u2014/);
  });

  it('no description holds an em dash', () => {
    const all = [
      station({ kind: 'station_technique', band: 'beginner' }), station({ weakest: 'wall_balls' }),
      brick({ band: 'beginner', kind: 'mini_brick' }), brick({ band: 'intermediate' }), brick({ band: 'advanced' }),
      brick({ band: 'advanced', kind: 'mini_brick', secondary: true }),
      brick({ band: 'novice', seed: { biologicalSex: 'female', hyroxConfig: { format: 'open_doubles', division: 'mixed', athleteBand: 'novice' } as HyroxConfig } }),
    ];
    for (const w of all) expect(w.d).not.toMatch(/—/);
  });

  it('doubles bricks: each station on every other one of its rounds, the rest the partner\'s turn', () => {
    const doubles: HyroxSeedStateInput = { biologicalSex: 'male', hyroxConfig: { format: 'open_doubles', division: 'men', athleteBand: 'intermediate' } as HyroxConfig };
    const w = brick({ seed: doubles });
    const [a, b] = stationsOf(w);
    expect(a.inRounds).toEqual([1]);
    expect(b.inRounds).toEqual([2]);
    expect(w.d).toContain("Rounds without a station are the partner's turn.");
  });

  it('the row text a session view shows: the sets and the prescription', () => {
    const w = station({ weakest: 'wall_balls', doseFraction: 1, seed: MAN, loadTier: 'M-Open' });
    const wb = stationsOf(w).find(c => c.type === 'wall_balls')!;
    expect(hyroxStationRowText(wb, w)).toMatch(/^4 × 25 reps, 6 kg ball to 3\.00 m, about \d+:\d\d a set$/);
  });
});

describe('cuts: rounds and stations', () => {
  it('withHyroxRounds keeps each station\'s first sets, scales its MTL and rewrites the text (beginner sleds 4 to 2 lanes)', () => {
    const w = station({ kind: 'station_technique', band: 'beginner', slotIndex: 8, phase: 'build' });
    expect(w.hyroxRounds).toBe(4);
    const cut = withHyroxRounds(w, 2);
    expect(cut.hyroxRounds).toBe(2);
    for (const c of stationsOf(cut)) expect(setsOf(cut, c)).toBe(2);
    const sled = stationsOf(w).find(c => c.type === 'sled_push')!;
    const sledCut = stationsOf(cut).find(c => c.type === 'sled_push')!;
    expect(sledCut.mtl).toBeCloseTo(sled.mtl / 2, 9);
    expect(cut.musculoTendonLoad!).toBeCloseTo(stationsOf(cut).reduce((a, c) => a + c.mtl, 0), 9);
    expect(cut.estimatedDurationMin).toBe(Math.round(hyroxSessionDurationSec(cut) / 60));
    expect(cut.d).toContain('Sled Push: 2 × 1 lane (12.5 m)');
    expect(cut.d).toContain('2 rounds,');
  });

  it('withoutHyroxStation shrinks the rounds to what the stations left hold', () => {
    const w = station({ kind: 'station_technique', band: 'beginner', slotIndex: 8, phase: 'build' }); // SkiErg, sleds, burpee broad jumps
    const noPush = withoutHyroxStation(w, 'sled_push');
    expect(noPush.hyroxRounds).toBe(4); // the pull still takes 4
    const noSleds = withoutHyroxStation(noPush, 'sled_pull');
    expect(noSleds.hyroxRounds).toBe(2);
    expect(noSleds.d).not.toContain('Sled');
    expect(noSleds.estimatedDurationMin!).toBeLessThan(noPush.estimatedDurationMin!);
  });

  it('a cut never takes a race-pace session\'s weakest station while another is left', () => {
    const w = station({ weakest: 'wall_balls', doseFraction: 1, seed: MAN, loadTier: 'M-Pro', bodyWeightKg: 75 });
    const heaviest = stationsOf(w).reduce((a, c) => (c.mtl > a.mtl ? c : a)).type;
    const cut = hyroxStationToCut(w)!;
    expect(cut).not.toBe('wall_balls');
    if (heaviest !== 'wall_balls') expect(cut).toBe(heaviest);
    const after = withoutHyroxStation(w, cut);
    expect(stationsOf(after)[0].type).toBe('wall_balls');
    expect(after.d).toContain("Wall Balls is the forecast's weakest station.");
  });

  it('a brick keeps its 2-round floor in doubles; a doubles station session\'s floor is its 1-round technique dose', () => {
    const doubles: HyroxSeedStateInput = { biologicalSex: 'male', hyroxConfig: { format: 'open_doubles', division: 'men', athleteBand: 'intermediate' } as HyroxConfig };
    expect(hyroxMinRounds(brick({ seed: doubles }))).toBe(MIN_CIRCUIT_ROUNDS);
    expect(hyroxMinRounds(station({ seed: doubles }))).toBe(1);
    expect(hyroxMinRounds(station({}))).toBe(MIN_CIRCUIT_ROUNDS);
  });
});
