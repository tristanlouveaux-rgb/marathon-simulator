/**
 * HYROX Doubles partner snapshot: the whitelist, and that every number in it
 * is the app's own canonical value (Stats ledger, forecast, run pace).
 */
import { describe, it, expect } from 'vitest';
import { getDefaultState } from '@/state/store';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { HYROX_HOURS_RANGE, HYROX_MTL_CAP, HYROX_WEEKLY_SESSIONS } from '@/constants/hyrox-constants';
import { predictHyroxRace, resolveHyroxStationBenchmarks, stationSinglesEquivalentSec } from './race-prediction.hyrox';
import { deriveHyroxRunPace } from './hyrox-run-pace';
import {
  buildHyroxPartnerSnapshot,
  hyroxPartnerInitials,
  hyroxSinglesRunPaceSecKm,
  isValidHyroxPartnerInitials,
  recordedStationTier,
  HYROX_PARTNER_SNAPSHOT_KEYS,
} from './hyrox-partner-snapshot';
import type { SimulatorState } from '@/types/state';
import type { HyroxConfig, HyroxStation } from '@/types/triathlon';

const today = new Date().toISOString().slice(0, 10);

const SINGLES_TIMES: Record<HyroxStation, number> = {
  ski_erg: 270, sled_push: 200, sled_pull: 260, burpee_broad_jumps: 300,
  row_erg: 290, farmer_carry: 110, sandbag_lunges: 280, wall_balls: 430,
};
const DOUBLES_SPLITS: Record<HyroxStation, number> = {
  ski_erg: 200, sled_push: 140, sled_pull: 190, burpee_broad_jumps: 210,
  row_erg: 220, farmer_carry: 80, sandbag_lunges: 200, wall_balls: 320,
};

type HistorySource = 'race' | 'full_test';
const history = (times: Record<HyroxStation, number>, format: HyroxConfig['format'], source: HistorySource) =>
  Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, [
    { dateISO: today, sec: times[st], source, format, proWeights: format.startsWith('pro') },
  ]])) as HyroxConfig['stationBenchmarkHistory'];

function hyroxState(hx: Partial<HyroxConfig>, over: Partial<SimulatorState> = {}): SimulatorState {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.w = 1;
  s.tw = 16;
  s.v = 50;
  s.hyroxConfig = {
    format: 'open_doubles',
    athleteBand: band,
    hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0,
    mtlCap: HYROX_MTL_CAP[band],
    mtlHistory: [],
    runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
    stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
    bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
    weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
    ...hx,
  };
  Object.assign(s, over);
  return s;
}

describe('partner snapshot whitelist', () => {
  it('holds exactly the whitelisted keys', () => {
    const s = hyroxState({ stationBenchmarksSingles: { ...SINGLES_TIMES } }, { biologicalSex: 'male' });
    const snap = buildHyroxPartnerSnapshot(s)!;
    expect(snap).not.toBeNull();
    expect(Object.keys(snap).sort()).toEqual([...HYROX_PARTNER_SNAPSHOT_KEYS].sort());
    for (const k of Object.keys(snap.stationSec)) expect(HYROX_STATION_ORDER).toContain(k);
    for (const k of Object.keys(snap.stationTier)) expect(HYROX_STATION_ORDER).toContain(k);
    expect(Object.keys(snap.forecastStationSec).sort()).toEqual([...HYROX_STATION_ORDER].sort());
  });

  it('carries no health, identity or activity data from a state full of it', () => {
    // Sentinel values that cannot occur in any race number.
    const s = hyroxState(
      { stationBenchmarksSingles: { ...SINGLES_TIMES } },
      {
        biologicalSex: 'female',
        onboarding: { name: 'Zelda Quartz' } as SimulatorState['onboarding'],
        restingHR: 41_111,
        maxHR: 42_222,
        lt: 43_333,
        vo2: 44.4444,
        physiologyHistory: [{ date: today, restingHR: 45_555, maxHR: 46_666, hrvRmssd: 47_777, sleepScore: 48_888 }],
        sleepHistory: [{ date: today, score: 49_999, durationSec: 51_111 }],
        hrvHistory: [{ date: today, rmssd: 52_222 }],
        bodyMassKg: 53.333,
      } as unknown as Partial<SimulatorState>,
    );
    const snap = buildHyroxPartnerSnapshot(s)!;
    const json = JSON.stringify(snap);
    for (const sentinel of ['41111', '42222', '43333', '44.4444', '45555', '46666', '47777', '48888', '49999', '51111', '52222', '53.333', 'Zelda', 'Quartz', 'female', 'male']) {
      expect(json).not.toContain(sentinel);
    }
    // The name reaches the snapshot only as the header initials.
    expect(snap.initials).toBe('ZQ');
  });

  it('is null without a HYROX config', () => {
    const s = getDefaultState();
    expect(buildHyroxPartnerSnapshot(s)).toBeNull();
  });
});

describe('partner snapshot numbers are the canonical values', () => {
  it('station seconds are the Stats ledger values, to the whole second', () => {
    const s = hyroxState(
      { stationBenchmarksDoubles: { ...DOUBLES_SPLITS }, stationBenchmarkHistory: history(DOUBLES_SPLITS, 'open_doubles', 'race') },
      { biologicalSex: 'male' },
    );
    const snap = buildHyroxPartnerSnapshot(s)!;
    for (const b of resolveHyroxStationBenchmarks(s)!.stations) {
      expect(snap.stationSec[b.station]).toBe(Math.round(b.sec!));
    }
    // Doubles race splits are pair times: flagged so nobody reads them as a head-to-head.
    expect([...snap.teamStations].sort()).toEqual([...HYROX_STATION_ORDER].sort());
  });

  it('forecast stations are the forecast lines in singles terms', () => {
    const s = hyroxState({ stationBenchmarksSingles: { ...SINGLES_TIMES } }, { biologicalSex: 'male' });
    const snap = buildHyroxPartnerSnapshot(s)!;
    const pred = predictHyroxRace(s)!;
    expect(pred.doubles).toBeDefined();
    for (const line of pred.stations) {
      expect(snap.forecastStationSec[line.station]).toBe(Math.round(stationSinglesEquivalentSec(line)));
    }
    // Roxzone in singles terms: the forecast's doubles Roxzone ÷ its ratio.
    expect(snap.roxzoneSec).toBe(Math.round(pred.roxzoneSec / pred.doubles!.roxzoneRatio));
  });

  it('run pace is the singles pace, without the doubles run ratio', () => {
    const s = hyroxState({ stationBenchmarksSingles: { ...SINGLES_TIMES } }, { biologicalSex: 'male' });
    const singles = hyroxState({ format: 'open_singles', stationBenchmarksSingles: { ...SINGLES_TIMES } }, { biologicalSex: 'male' });
    expect(hyroxSinglesRunPaceSecKm(s)).toBe(Math.round(deriveHyroxRunPace(singles).paceSecKm));
    expect(buildHyroxPartnerSnapshot(s)!.runPaceSecKm).toBe(Math.round(deriveHyroxRunPace(singles).paceSecKm));
  });

  it('an auto-derived stored pace (doubles terms) is re-derived; a hand-entered pace is kept', () => {
    const doublesPace = deriveHyroxRunPace(hyroxState({}, { biologicalSex: 'male' })).paceSecKm;
    const singlesPace = deriveHyroxRunPace(hyroxState({ format: 'open_singles' }, { biologicalSex: 'male' })).paceSecKm;
    const derived = hyroxState({ hyroxRunPaceSecKm: doublesPace, hyroxRunPaceSource: 'derived' }, { biologicalSex: 'male' });
    expect(hyroxSinglesRunPaceSecKm(derived)).toBe(Math.round(singlesPace));
    // A hand-entered pace faster than the derived one (a slower one yields to
    // the derived value under the yield-to-improvements rule).
    const entered = Math.round(singlesPace) - 10;
    const manual = hyroxState({ hyroxRunPaceSecKm: entered, hyroxRunPaceSource: 'user' }, { biologicalSex: 'male' });
    expect(hyroxSinglesRunPaceSecKm(manual)).toBe(entered);
  });
});

describe('recorded station tier', () => {
  const tierOf = (s: SimulatorState, st: HyroxStation) => buildHyroxPartnerSnapshot(s)!.stationTier[st];

  it('a man in Open doubles: singles-slot times are at Men Open', () => {
    const s = hyroxState({ division: 'men', stationBenchmarksSingles: { ...SINGLES_TIMES } }, { biologicalSex: 'male' });
    expect(tierOf(s, 'sled_push')).toBe('M-Open');
    expect(tierOf(s, 'wall_balls')).toBe('M-Open');
  });

  it('a woman in Mixed doubles: singles-slot times are at Women Open, doubles-slot tests at Men Open', () => {
    const singles = hyroxState({ division: 'mixed', stationBenchmarksSingles: { ...SINGLES_TIMES } }, { biologicalSex: 'female' });
    expect(tierOf(singles, 'sled_push')).toBe('W-Open');
    const tests = hyroxState(
      { division: 'mixed', stationBenchmarksDoubles: { ...SINGLES_TIMES }, stationBenchmarkHistory: history(SINGLES_TIMES, 'open_doubles', 'full_test') },
      { biologicalSex: 'female' },
    );
    expect(tierOf(tests, 'sled_push')).toBe('M-Open');
    expect(buildHyroxPartnerSnapshot(tests)!.teamStations).toEqual([]);
  });

  it('a woman in Women doubles: doubles-slot tests at Women Open', () => {
    const s = hyroxState(
      { division: 'women', stationBenchmarksDoubles: { ...SINGLES_TIMES }, stationBenchmarkHistory: history(SINGLES_TIMES, 'open_doubles', 'full_test') },
      { biologicalSex: 'female' },
    );
    expect(tierOf(s, 'sandbag_lunges')).toBe('W-Open');
  });

  it('a Pro target reading Open-weight times: the converted value counts at the Pro tier, as in the solo forecast', () => {
    const s = hyroxState({ format: 'pro_doubles', division: 'men', stationBenchmarksSingles: { ...SINGLES_TIMES } }, { biologicalSex: 'male' });
    const snap = buildHyroxPartnerSnapshot(s)!;
    // stationSec is the converted (Pro-weight) value the Stats ledger shows.
    expect(snap.stationSec.sled_push).toBeGreaterThan(SINGLES_TIMES.sled_push);
    expect(snap.stationTier.sled_push).toBe('M-Pro');
    expect(recordedStationTier({ sec: 200, slot: 'singles', recordedAtProWeights: false }, 'pro_doubles', 'female', 'women')).toBe('M-Open');
    // The reverse direction too: Pro-weight times read by an Open target.
    expect(recordedStationTier({ sec: 200, slot: 'singles', recordedAtProWeights: true }, 'open_doubles', 'male', 'men')).toBe('M-Open');
  });

  it('unknown sex in a singles slot: no tier', () => {
    expect(recordedStationTier({ sec: 200, slot: 'singles', recordedAtProWeights: false }, 'open_doubles', undefined, 'mixed')).toBeNull();
    expect(recordedStationTier({ sec: 200, slot: 'singles', recordedAtProWeights: false }, 'open_doubles', 'female', 'mixed')).toBe('W-Open');
    expect(recordedStationTier({ sec: 200, slot: 'singles', recordedAtProWeights: true }, 'pro_doubles', 'female', 'women')).toBe('M-Open');
    // A doubles-slot value read by a singles target: the division it was set in is unknown.
    expect(recordedStationTier({ sec: 200, slot: 'doubles', recordedAtProWeights: false }, 'open_singles', 'male', undefined)).toBeNull();
    expect(recordedStationTier({ sec: undefined, slot: 'singles', recordedAtProWeights: false }, 'open_doubles', 'male', 'men')).toBeNull();
  });

  it('race tier follows hyroxLoadTier; unknown division shares no tier', () => {
    expect(buildHyroxPartnerSnapshot(hyroxState({ division: 'mixed' }, { biologicalSex: 'female' }))!.raceTier).toBe('M-Open');
    expect(buildHyroxPartnerSnapshot(hyroxState({ division: 'women' }, { biologicalSex: 'female' }))!.raceTier).toBe('W-Open');
    const unknown = buildHyroxPartnerSnapshot(hyroxState({ division: undefined }, { biologicalSex: undefined }))!;
    expect(unknown.division).toBeNull();
    expect(unknown.raceTier).toBeNull();
  });
});

describe('partner initials', () => {
  it('first letter of up to two name words, upper case', () => {
    expect(hyroxPartnerInitials('Tristan Louveaux')).toBe('TL');
    expect(hyroxPartnerInitials('  anna  ')).toBe('A');
    expect(hyroxPartnerInitials('Émile Zola Third')).toBe('ÉZ');
    expect(hyroxPartnerInitials('')).toBeNull();
    expect(hyroxPartnerInitials(undefined)).toBeNull();
  });

  it('never yields markup, digits or punctuation', () => {
    expect(hyroxPartnerInitials('<script> alert')).toBe('A');
    expect(hyroxPartnerInitials('4ever Young')).toBe('Y');
    expect(hyroxPartnerInitials('"quoted" &amp')).toBeNull();
    expect(isValidHyroxPartnerInitials('<B')).toBe(false);
    expect(isValidHyroxPartnerInitials('ABC')).toBe(false);
    expect(isValidHyroxPartnerInitials('ab')).toBe(false);
    expect(isValidHyroxPartnerInitials('TL')).toBe(true);
  });
});
