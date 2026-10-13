/**
 * HYROX Doubles partner comparison: fair station leads (same setup, no pair
 * times; every value already at the athlete's solo loads in the race through
 * lane H3b's per-sex Open/Pro conversions) and the pair forecast (equal split
 * of each partner's own doubles forecast lines, the slower run pace and
 * Roxzone), withheld with what is missing and from whom.
 */
import { describe, it, expect } from 'vitest';
import { getDefaultState } from '@/state/store';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { HYROX_HOURS_RANGE, HYROX_MTL_CAP, HYROX_WEEKLY_SESSIONS } from '@/constants/hyrox-constants';
import { predictHyroxRace } from './race-prediction.hyrox';
import { HYROX_LOADED_STATIONS } from './hyrox-results';
import { buildHyroxPartnerSnapshot, type HyroxPartnerSnapshot } from './hyrox-partner-snapshot';
import { compareHyroxPartners, hyroxPairSetup, isTierIndependentStation, pairForecastLoadGaps } from './hyrox-partner-compare';
import type { HyroxConfig, HyroxLoadTier, HyroxStation } from '@/types/triathlon';
import type { SimulatorState } from '@/types/state';

const allStations = <T>(v: T) => Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, v])) as Record<HyroxStation, T>;

function snap(over: Partial<HyroxPartnerSnapshot> = {}, tier: HyroxLoadTier = 'M-Open'): HyroxPartnerSnapshot {
  return {
    format: 'open_doubles',
    division: 'men',
    raceTier: tier,
    initials: 'AB',
    stationSec: {
      ski_erg: 270, sled_push: 200, sled_pull: 260, burpee_broad_jumps: 300,
      row_erg: 290, farmer_carry: 110, sandbag_lunges: 280, wall_balls: 430,
    },
    stationTier: allStations(tier),
    teamStations: [],
    forecastStationSec: {
      ski_erg: 275, sled_push: 205, sled_pull: 265, burpee_broad_jumps: 305,
      row_erg: 295, farmer_carry: 115, sandbag_lunges: 285, wall_balls: 435,
    },
    runPaceSecKm: 300,
    roxzoneSec: 420,
    ...over,
  };
}

/** A real athlete's state: intermediate, VDOT 50, station tests in the
 *  singles slot logged under Open Singles (so a Mixed woman's are at Women
 *  Open loads, the toggle's convention). */
function athleteState(sex: 'male' | 'female' | undefined, hx: Partial<HyroxConfig>, tests: Partial<Record<HyroxStation, number>>): SimulatorState {
  const band = 'intermediate' as const;
  const s: SimulatorState = getDefaultState();
  s.eventType = 'hyrox';
  s.v = 50;
  s.biologicalSex = sex;
  const today = new Date().toISOString().slice(0, 10);
  s.hyroxConfig = {
    format: 'open_doubles', division: 'mixed', athleteBand: band, hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0, mtlCap: HYROX_MTL_CAP[band], mtlHistory: [],
    runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
    stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
    bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
    weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
    stationBenchmarksSingles: { ...tests },
    stationBenchmarkHistory: Object.fromEntries(Object.entries(tests).map(([st, sec]) => [st, [
      { dateISO: today, sec: sec!, source: 'full_test' as const, format: 'open_singles' as const, proWeights: false },
    ]])),
    ...hx,
  };
  return s;
}

const HIS_TESTS: Record<HyroxStation, number> = {
  ski_erg: 262, sled_push: 196, sled_pull: 251, burpee_broad_jumps: 288,
  row_erg: 281, farmer_carry: 104, sandbag_lunges: 266, wall_balls: 412,
};
/** Her Women Open tests: lighter loads, so raw times near his. */
const HER_TESTS: Record<HyroxStation, number> = {
  ski_erg: 275, sled_push: 205, sled_pull: 262, burpee_broad_jumps: 300,
  row_erg: 292, farmer_carry: 108, sandbag_lunges: 255, wall_balls: 395,
};

describe('tier-independent stations', () => {
  it('are SkiErg, Row Erg and Burpee Broad Jumps, from the rulebook standards', () => {
    expect(HYROX_STATION_ORDER.filter(isTierIndependentStation).sort())
      .toEqual(['burpee_broad_jumps', 'row_erg', 'ski_erg']);
  });
});

describe('station leads', () => {
  it('names the faster partner and the whole-second lead', () => {
    const you = snap();
    const partner = snap({ stationSec: { ...you.stationSec, ski_erg: 282, sled_push: 192, row_erg: 290 } });
    const cmp = compareHyroxPartners(you, partner);
    const by = Object.fromEntries(cmp.stations.map(c => [c.station, c]));
    expect(by.ski_erg).toEqual({ station: 'ski_erg', status: 'you', leadSec: 12 });
    expect(by.sled_push).toEqual({ station: 'sled_push', status: 'partner', leadSec: 8 });
    expect(by.row_erg).toEqual({ station: 'row_erg', status: 'level' });
    expect(cmp.stations.map(c => c.station)).toEqual(HYROX_STATION_ORDER);
  });

  it('a missing benchmark on either side is not comparable, with the side named', () => {
    const you = snap({ stationSec: { ...snap().stationSec, ski_erg: undefined, sled_push: undefined } });
    const partner = snap({ stationSec: { ...snap().stationSec, ski_erg: undefined, sled_pull: undefined } });
    const by = Object.fromEntries(compareHyroxPartners(you, partner).stations.map(c => [c.station, c]));
    expect(by.ski_erg).toMatchObject({ status: 'not_comparable', reason: 'missing_both' });
    expect(by.sled_push).toMatchObject({ status: 'not_comparable', reason: 'missing_you' });
    expect(by.sled_pull).toMatchObject({ status: 'not_comparable', reason: 'missing_partner' });
    expect(by.ski_erg.leadSec).toBeUndefined();
  });

  it('a doubles race split (a pair time) is not comparable', () => {
    const you = snap({ teamStations: ['wall_balls'] });
    const by = Object.fromEntries(compareHyroxPartners(you, snap()).stations.map(c => [c.station, c]));
    expect(by.wall_balls).toMatchObject({ status: 'not_comparable', reason: 'team_time' });
    const back = Object.fromEntries(compareHyroxPartners(snap(), you).stations.map(c => [c.station, c]));
    expect(back.wall_balls).toMatchObject({ status: 'not_comparable', reason: 'team_time' });
  });

  it('a loaded station with no known tier is not comparable, as load not known', () => {
    const tiers = allStations<HyroxLoadTier>('M-Open') as Partial<Record<HyroxStation, HyroxLoadTier>>;
    delete tiers.sled_push;
    delete tiers.ski_erg;
    const by = Object.fromEntries(compareHyroxPartners(snap({ stationTier: tiers }), snap()).stations.map(c => [c.station, c]));
    expect(by.sled_push).toMatchObject({ status: 'not_comparable', reason: 'tier_unknown' });
    // Erg standards are the same at every tier: still compared.
    expect(by.ski_erg.status).toBe('level');
  });
});

describe('Mixed Doubles: both partners race Men Open loads', () => {
  const man = buildHyroxPartnerSnapshot(athleteState('male', {}, HIS_TESTS))!;
  const woman = buildHyroxPartnerSnapshot(athleteState('female', {}, HER_TESTS))!;

  it('her Women Open tests arrive at Men Open loads: every station compares', () => {
    expect(woman.raceTier).toBe('M-Open');
    for (const st of HYROX_LOADED_STATIONS) {
      expect(woman.stationTier[st]).toBe('M-Open');
      // Converted with the women's Open-to-Pro conversion (the Women Pro tier is M-Open).
      expect(woman.stationSec[st]!).toBeGreaterThan(HER_TESTS[st]);
    }
    const cmp = compareHyroxPartners(man, woman);
    expect(cmp.pairTier).toBe('M-Open');
    for (const c of cmp.stations) {
      expect(c.status).not.toBe('not_comparable');
      const lead = woman.stationSec[c.station]! - man.stationSec[c.station]!;
      if (lead > 0) expect(c).toEqual({ station: c.station, status: 'you', leadSec: lead });
      else if (lead < 0) expect(c).toEqual({ station: c.station, status: 'partner', leadSec: -lead });
      else expect(c.status).toBe('level');
    }
  });

  it('the pair forecast shows, from both sides, with the same total', () => {
    const fromHim = compareHyroxPartners(man, woman);
    const fromHer = compareHyroxPartners(woman, man);
    expect(fromHim.forecastWithheld).toBeNull();
    expect(fromHim.withheldFor).toBeNull();
    expect(fromHim.forecast).not.toBeNull();
    expect(fromHer.forecast!.totalSec).toBe(fromHim.forecast!.totalSec);
  });

  it('the pair forecast is each partner\'s own doubles forecast lines, equal split', () => {
    const hisPred = predictHyroxRace(athleteState('male', {}, HIS_TESTS))!;
    const herPred = predictHyroxRace(athleteState('female', {}, HER_TESTS))!;
    const f = compareHyroxPartners(man, woman).forecast!;
    const stations = HYROX_STATION_ORDER.reduce((a, st) =>
      a + (hisPred.stations.find(l => l.station === st)!.baseSec + herPred.stations.find(l => l.station === st)!.baseSec) / 2, 0);
    // Whole-second rounding of 16 lines, halved: at most 4 s.
    expect(Math.abs(f.stationsSec - stations)).toBeLessThanOrEqual(4);
    expect(f.roxzoneSec).toBe(Math.max(Math.round(hisPred.roxzoneSec), Math.round(herPred.roxzoneSec)));
  });

  it('no biological sex on file: her numbers sit at no single tier, so the forecast waits on her', () => {
    const unknown = buildHyroxPartnerSnapshot(athleteState(undefined, {}, HER_TESTS))!;
    expect(unknown.raceTier).toBe('M-Open');
    const cmp = compareHyroxPartners(man, unknown);
    expect(cmp.forecastWithheld).toBe('loads_unknown');
    expect(cmp.withheldFor).toBe('partner');
    expect(cmp.stations.find(c => c.station === 'sled_push')).toMatchObject({ reason: 'tier_unknown' });
    expect(cmp.stations.find(c => c.station === 'ski_erg')!.status).not.toBe('not_comparable');
    expect(compareHyroxPartners(unknown, man).withheldFor).toBe('you');
  });

  it('no sex on file and no benchmarks: the seeded forecast lines carry no tier either', () => {
    const seedsOnly = buildHyroxPartnerSnapshot(athleteState(undefined, {}, {}))!;
    expect(seedsOnly.stationSec).toEqual({});
    const cmp = compareHyroxPartners(man, seedsOnly);
    expect(cmp.forecastWithheld).toBe('loads_unknown');
    expect(cmp.withheldFor).toBe('partner');
  });
});

describe('a row whose loaded values sit at another tier (written outside this builder)', () => {
  const man = snap({ division: 'mixed' }, 'M-Open');
  const offTier = snap({
    division: 'mixed',
    raceTier: 'M-Open',
    stationTier: allStations<HyroxLoadTier>('W-Open'),
    stationSec: { ...snap().stationSec, ski_erg: 290, sled_push: 180 },
  });

  it('loaded stations are not comparable; ergs still compare', () => {
    const cmp = compareHyroxPartners(man, offTier);
    expect(cmp.pairTier).toBe('M-Open');
    const by = Object.fromEntries(cmp.stations.map(c => [c.station, c]));
    for (const st of HYROX_LOADED_STATIONS) {
      expect(by[st]).toMatchObject({ status: 'not_comparable', reason: 'tier' });
    }
    expect(by.ski_erg).toEqual({ station: 'ski_erg', status: 'you', leadSec: 20 });
  });

  it('the pair forecast is withheld, naming whose times', () => {
    const cmp = compareHyroxPartners(man, offTier);
    expect(cmp.forecast).toBeNull();
    expect(cmp.forecastWithheld).toBe('loads');
    expect(cmp.withheldFor).toBe('partner');
    expect(compareHyroxPartners(offTier, man).withheldFor).toBe('you');
    expect(cmp.stations).toHaveLength(8);
  });

  it('one off-tier loaded station is enough, even when the partner has no benchmark there', () => {
    const oneOff = snap({
      division: 'mixed', raceTier: 'M-Open',
      stationTier: { ...allStations<HyroxLoadTier>('M-Open'), sled_push: 'W-Open' },
    });
    const manNoSledPush = snap({ division: 'mixed', stationSec: { ...snap().stationSec, sled_push: undefined } });
    const cmp = compareHyroxPartners(manNoSledPush, oneOff);
    expect(cmp.stations.find(c => c.station === 'sled_push')).toMatchObject({ reason: 'missing_you' });
    expect(cmp.forecastWithheld).toBe('loads');
    expect(pairForecastLoadGaps(manNoSledPush, oneOff, 'M-Open')).toEqual({ offTier: 'partner', unknown: null });
  });

  it('off-tier erg values do not withhold it; an unstated loaded tier says so', () => {
    const ergsOff = snap({ division: 'mixed', stationTier: { ...allStations<HyroxLoadTier>('M-Open'), ski_erg: 'W-Open', row_erg: 'W-Open', burpee_broad_jumps: 'W-Open' } });
    expect(compareHyroxPartners(man, ergsOff).forecastWithheld).toBeNull();
    const unknownTier = allStations<HyroxLoadTier>('M-Open') as Partial<Record<HyroxStation, HyroxLoadTier>>;
    delete unknownTier.wall_balls;
    const cmp = compareHyroxPartners(man, snap({ division: 'mixed', stationTier: unknownTier }));
    expect(cmp.forecastWithheld).toBe('loads_unknown');
    expect(cmp.withheldFor).toBe('partner');
    expect(cmp.stations.find(c => c.station === 'wall_balls')).toMatchObject({ reason: 'tier_unknown' });
  });

  it('a known off-tier value outranks an unstated one, and both partners can be named', () => {
    const unknownTier = allStations<HyroxLoadTier>('M-Open') as Partial<Record<HyroxStation, HyroxLoadTier>>;
    delete unknownTier.wall_balls;
    const cmp = compareHyroxPartners(snap({ division: 'mixed', stationTier: unknownTier }), offTier);
    expect(cmp.forecastWithheld).toBe('loads');
    expect(cmp.withheldFor).toBe('partner');
    expect(compareHyroxPartners(offTier, { ...offTier }).withheldFor).toBe('both');
  });
});

describe('Pro pair with tests at Open weights', () => {
  it('both partners\' values arrive at Men Pro (men\'s conversion): rows compare and the forecast shows', () => {
    const a = buildHyroxPartnerSnapshot(athleteState('male', { format: 'pro_doubles', division: 'men' }, HIS_TESTS))!;
    const b = buildHyroxPartnerSnapshot(athleteState('male', { format: 'pro_doubles', division: 'men' }, { ...HIS_TESTS, sled_push: 211 }))!;
    expect(a.stationTier.sled_push).toBe('M-Pro');
    expect(a.stationSec.sled_push!).toBeGreaterThan(HIS_TESTS.sled_push);
    const cmp = compareHyroxPartners(a, b);
    expect(cmp.pairTier).toBe('M-Pro');
    expect(cmp.forecastWithheld).toBeNull();
    expect(cmp.forecast).not.toBeNull();
    expect(cmp.stations.find(c => c.station === 'sled_push')).toMatchObject({ status: 'you' });
  });
});

describe('pair setup', () => {
  it('needs the same doubles format, division and race tier', () => {
    expect(hyroxPairSetup(snap(), snap())).toEqual({ pairFormat: 'open_doubles', pairTier: 'M-Open' });
    // Men and Mixed share M-Open loads but are different races.
    expect(hyroxPairSetup(snap(), snap({ division: 'mixed' }))).toEqual({ pairFormat: 'open_doubles', pairTier: null });
    expect(hyroxPairSetup(snap({ division: null }), snap({ division: null }))).toEqual({ pairFormat: 'open_doubles', pairTier: null });
    expect(hyroxPairSetup(snap(), snap({}, 'W-Open'))).toEqual({ pairFormat: 'open_doubles', pairTier: null });
    expect(hyroxPairSetup(snap(), snap({ format: 'pro_doubles' }))).toEqual({ pairFormat: null, pairTier: null });
    expect(hyroxPairSetup(snap({ format: 'open_singles' }), snap({ format: 'open_singles' }))).toEqual({ pairFormat: null, pairTier: null });
    expect(hyroxPairSetup(snap({ raceTier: null }), snap({ raceTier: null }))).toEqual({ pairFormat: 'open_doubles', pairTier: null });
  });

  it('different setups: loaded stations not comparable, ergs compared, no pair forecast', () => {
    const cmp = compareHyroxPartners(snap(), snap({ stationTier: allStations<HyroxLoadTier>('W-Open') }, 'W-Open'));
    expect(cmp.pairTier).toBeNull();
    expect(cmp.forecast).toBeNull();
    expect(cmp.forecastWithheld).toBe('setup');
    expect(cmp.withheldFor).toBeNull();
    const by = Object.fromEntries(cmp.stations.map(c => [c.station, c]));
    expect(by.sled_push.reason).toBe('setup');
    expect(by.row_erg.status).toBe('level');
  });
});

describe('pair forecast', () => {
  it('runs at the slower partner\'s pace', () => {
    const cmp = compareHyroxPartners(snap({ runPaceSecKm: 290 }), snap({ runPaceSecKm: 315 }));
    expect(cmp.run).toEqual({ paceSecKm: 315, setBy: 'partner' });
    expect(cmp.forecast!.runSec).toBe(8 * 315);
    expect(compareHyroxPartners(snap({ runPaceSecKm: 320 }), snap({ runPaceSecKm: 315 })).run.setBy).toBe('you');
    expect(compareHyroxPartners(snap(), snap()).run.setBy).toBe('both');
  });

  it('stations are the mean of the two partners\' lines; Roxzone is the slower line', () => {
    const you = snap();
    const partner = snap({ forecastStationSec: Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, you.forecastStationSec[st] + 20])) as Record<HyroxStation, number> });
    const meanSum = HYROX_STATION_ORDER.reduce((a, st) => a + (you.forecastStationSec[st] + partner.forecastStationSec[st]) / 2, 0);
    const f = compareHyroxPartners(you, partner).forecast!;
    expect(f.stationsSec).toBe(Math.round(meanSum));
    const f2 = compareHyroxPartners(you, snap({ roxzoneSec: 450 })).forecast!;
    expect(f2.roxzoneSec).toBe(450);
    expect(compareHyroxPartners(snap({ roxzoneSec: 460 }), snap()).forecast!.roxzoneSec).toBe(460);
    expect(f.totalSec).toBe(Math.round(meanSum + f.runSec + f.roxzoneSec));
  });

  it('two identical partners reproduce the athlete\'s own doubles forecast stations and Roxzone', () => {
    const band = 'intermediate' as const;
    const s: SimulatorState = getDefaultState();
    s.eventType = 'hyrox';
    s.v = 50;
    s.biologicalSex = 'male';
    s.hyroxConfig = {
      format: 'open_doubles', division: 'men', athleteBand: band, hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0, mtlCap: HYROX_MTL_CAP[band], mtlHistory: [],
      runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
      stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
      bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
      weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
      stationBenchmarksSingles: { ski_erg: 270, sled_push: 200, sled_pull: 260, burpee_broad_jumps: 300 },
    };
    const me = buildHyroxPartnerSnapshot(s)!;
    const pred = predictHyroxRace(s)!;
    const f = compareHyroxPartners(me, { ...me }).forecast!;
    const ownStations = pred.stations.reduce((a, l) => a + l.baseSec, 0);
    // Whole-second rounding of eight station lines moves the sum by at most 4 s.
    expect(Math.abs(f.stationsSec - ownStations)).toBeLessThanOrEqual(4);
    expect(f.roxzoneSec).toBe(Math.round(pred.roxzoneSec));
  });
});
