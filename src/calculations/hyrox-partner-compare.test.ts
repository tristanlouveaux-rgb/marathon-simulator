/**
 * HYROX Doubles partner comparison: fair station leads (same tier, no pair
 * times, no cross-tier conversion beyond the app's Open/Pro convention) and
 * the pair forecast (slower run pace, the data-driven doubles mapping on the
 * equal-split station means), withheld with what is missing and from whom.
 */
import { describe, it, expect } from 'vitest';
import { getDefaultState } from '@/state/store';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { HYROX_HOURS_RANGE, HYROX_MTL_CAP, HYROX_PRO_STATION_MULTIPLIER, HYROX_WEEKLY_SESSIONS } from '@/constants/hyrox-constants';
import { doublesRatioAt } from './hyrox-doubles';
import { predictHyroxRace } from './race-prediction.hyrox';
import { buildHyroxPartnerSnapshot, type HyroxPartnerSnapshot } from './hyrox-partner-snapshot';
import { compareHyroxPartners, hyroxPairSetup, isTierIndependentStation, pairForecastLoadGaps } from './hyrox-partner-compare';
import type { HyroxLoadTier, HyroxStation } from '@/types/triathlon';
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
  const man = snap({ division: 'mixed' }, 'M-Open');
  const womanSinglesTimes = snap({
    division: 'mixed',
    raceTier: 'M-Open',
    stationTier: allStations<HyroxLoadTier>('W-Open'),
    stationSec: { ...snap().stationSec, ski_erg: 290, sled_push: 180 },
  });

  it('her Women Open station times are not converted to Men Open: loaded stations not comparable', () => {
    const cmp = compareHyroxPartners(man, womanSinglesTimes);
    expect(cmp.pairTier).toBe('M-Open');
    const by = Object.fromEntries(cmp.stations.map(c => [c.station, c]));
    for (const st of ['sled_push', 'sled_pull', 'farmer_carry', 'sandbag_lunges', 'wall_balls'] as HyroxStation[]) {
      expect(by[st]).toMatchObject({ status: 'not_comparable', reason: 'tier' });
    }
    expect(by.ski_erg).toEqual({ station: 'ski_erg', status: 'you', leadSec: 20 });
  });

  it('her times measured at Men Open loads compare directly', () => {
    const womanAtMenOpen = { ...womanSinglesTimes, stationTier: allStations<HyroxLoadTier>('M-Open') };
    const cmp = compareHyroxPartners(man, womanAtMenOpen);
    const by = Object.fromEntries(cmp.stations.map(c => [c.station, c]));
    expect(by.sled_push).toEqual({ station: 'sled_push', status: 'partner', leadSec: 20 });
    expect(cmp.forecastWithheld).toBeNull();
    expect(cmp.forecast).not.toBeNull();
  });

  it('pair forecast withheld while her loaded stations are at Women Open (until per-sex conversions, lane H3b)', () => {
    const cmp = compareHyroxPartners(man, womanSinglesTimes);
    expect(cmp.forecast).toBeNull();
    expect(cmp.forecastWithheld).toBe('loads');
    expect(cmp.withheldFor).toBe('partner');
    // Seen from her side, the missing times are her own.
    expect(compareHyroxPartners(womanSinglesTimes, man).withheldFor).toBe('you');
    // Station rows still show.
    expect(cmp.stations).toHaveLength(8);
  });

  it('one off-tier loaded benchmark is enough, even when the partner has none there', () => {
    const womanOneOff = snap({
      division: 'mixed', raceTier: 'M-Open',
      stationTier: { ...allStations<HyroxLoadTier>('M-Open'), sled_push: 'W-Open' },
    });
    const manNoSledPush = snap({ division: 'mixed', stationSec: { ...snap().stationSec, sled_push: undefined } });
    const cmp = compareHyroxPartners(manNoSledPush, womanOneOff);
    expect(cmp.stations.find(c => c.station === 'sled_push')).toMatchObject({ reason: 'missing_you' });
    expect(cmp.forecastWithheld).toBe('loads');
    expect(pairForecastLoadGaps(manNoSledPush, womanOneOff, 'M-Open')).toEqual({ offTier: 'partner', unknown: null });
  });

  it('off-tier erg times do not withhold it (one race standard at every tier); an unknown loaded tier says so', () => {
    const ergsOff = snap({ division: 'mixed', stationTier: { ...allStations<HyroxLoadTier>('M-Open'), ski_erg: 'W-Open', row_erg: 'W-Open', burpee_broad_jumps: 'W-Open' } });
    expect(compareHyroxPartners(man, ergsOff).forecastWithheld).toBeNull();
    const unknownTier = allStations<HyroxLoadTier>('M-Open') as Partial<Record<HyroxStation, HyroxLoadTier>>;
    delete unknownTier.wall_balls;
    const cmp = compareHyroxPartners(man, snap({ division: 'mixed', stationTier: unknownTier }));
    expect(cmp.forecastWithheld).toBe('loads_unknown');
    expect(cmp.withheldFor).toBe('partner');
    expect(cmp.stations.find(c => c.station === 'wall_balls')).toMatchObject({ reason: 'tier_unknown' });
  });

  it('a known off-tier value outranks an unknown one, and both partners can be named', () => {
    const unknownTier = allStations<HyroxLoadTier>('M-Open') as Partial<Record<HyroxStation, HyroxLoadTier>>;
    delete unknownTier.wall_balls;
    const cmp = compareHyroxPartners(snap({ division: 'mixed', stationTier: unknownTier }), womanSinglesTimes);
    expect(cmp.forecastWithheld).toBe('loads');
    expect(cmp.withheldFor).toBe('partner');
    const both = compareHyroxPartners(womanSinglesTimes, { ...womanSinglesTimes });
    expect(both.withheldFor).toBe('both');
  });
});

describe('Pro pair with tests at Open weights', () => {
  it('converted values count at the Pro tier, as in the solo forecast: rows compare and the forecast shows', () => {
    // Both partners' snapshots as the builder now writes them for Open-weight
    // tests under a Men Pro doubles target (the Open/Pro convention).
    const you = snap({ format: 'pro_doubles' }, 'M-Pro');
    const partner = snap({ format: 'pro_doubles', stationSec: { ...snap().stationSec, sled_push: 215 } }, 'M-Pro');
    const cmp = compareHyroxPartners(you, partner);
    expect(cmp.pairTier).toBe('M-Pro');
    expect(cmp.forecastWithheld).toBeNull();
    expect(cmp.forecast).not.toBeNull();
    expect(cmp.stations.find(c => c.station === 'sled_push')).toEqual({ station: 'sled_push', status: 'you', leadSec: 15 });
  });
});

describe('pair setup', () => {
  it('needs the same doubles format and race tier', () => {
    expect(hyroxPairSetup(snap(), snap())).toEqual({ pairFormat: 'open_doubles', pairTier: 'M-Open' });
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

  it('maps the equal-split station means through the data-driven doubles ratio', () => {
    const you = snap();
    const partner = snap({ forecastStationSec: Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, you.forecastStationSec[st] + 20])) as Record<HyroxStation, number> });
    const meanSum = HYROX_STATION_ORDER.reduce((a, st) => a + (you.forecastStationSec[st] + partner.forecastStationSec[st]) / 2, 0);
    const ratio = doublesRatioAt('stations', meanSum).ratio;
    const f = compareHyroxPartners(you, partner).forecast!;
    expect(f.stationRatio).toBeCloseTo(ratio, 10);
    expect(f.stationsSec).toBe(Math.round(meanSum * ratio));
    // Roxzone: the slower partner's singles Roxzone × the Roxzone ratio.
    const rox = Math.max(you.roxzoneSec, 450);
    const f2 = compareHyroxPartners(you, snap({ roxzoneSec: 450 })).forecast!;
    expect(f2.roxzoneSec).toBe(Math.round(rox * doublesRatioAt('roxzone', rox).ratio));
    expect(f.totalSec).toBe(Math.round(meanSum * ratio + f.runSec + f.roxzoneSec));
  });

  it('a Pro pair reads the ratio at Open-weight times, as the doubles forecast does', () => {
    const you = snap({ format: 'pro_doubles' }, 'M-Pro');
    const partner = snap({ format: 'pro_doubles' }, 'M-Pro');
    const openSum = HYROX_STATION_ORDER.reduce((a, st) => a + you.forecastStationSec[st] / (HYROX_PRO_STATION_MULTIPLIER[st] ?? 1), 0);
    expect(compareHyroxPartners(you, partner).forecast!.stationRatio).toBeCloseTo(doublesRatioAt('stations', openSum).ratio, 10);
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
    // Whole-second rounding of eight singles stations moves the sum by at most 4 s × ratio.
    expect(Math.abs(f.stationsSec - ownStations)).toBeLessThanOrEqual(4);
    expect(Math.abs(f.roxzoneSec - pred.roxzoneSec)).toBeLessThanOrEqual(1);
  });
});
