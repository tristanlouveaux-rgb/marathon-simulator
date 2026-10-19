// @vitest-environment jsdom
/**
 * HYROX planning reads the forecast's per-station benchmarks.
 *
 * The plan engine's station target times (plan_engine.hyrox.ts) and the
 * add-session modal used to read only the target format's slot. A singles
 * athlete whose station times came from doubles race splits (or a doubles
 * athlete with singles benchmarks) then trained to population seeds while the
 * Forecast, Stats and Account showed their converted times (review
 * 2026-10-13). Both now read hyroxPlanningStationBenchmarks, the
 * resolveHyroxStationBenchmarks values the Stats ledger shows, to the whole
 * second. Every value is one athlete's time over the full station, so a
 * doubles target's race split is prescribed as its solo equivalent, never as
 * the pair's time, and a session best moves the target faster.
 *
 * Real generator, real add-session modal (jsdom). saveState and the plan-view
 * re-render are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));
vi.mock('@/ui/hyrox/plan-view', () => ({ renderHyroxPlanView: vi.fn() }));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from './plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { doublesStationSoloSec } from '@/calculations/hyrox-doubles';
import { hyroxProToOpenSec } from '@/calculations/hyrox-results';
import { HYROX_STATION_ORDER, STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import { resolveHyroxStationBenchmarks, hyroxPlanningStationBenchmarks, hyroxCalibratedStationBenchmarks, hyroxStationSeedsForState, predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { hyroxBenchmarkLedger } from '@/ui/hyrox/stats-view';
import { openHyroxAddSessionModal } from '@/ui/hyrox/add-session-modal';
import { applyHyroxSessionBenchmarks } from '@/calculations/hyrox-session-benchmarks';
import { HYROX_STATION_SET_FRACTION } from './hyrox-station-dose';
import type { SetRecord } from '@/guided/strength-controller';
import type { SimulatorState, Week } from '@/types/state';
import type { HyroxComponent, HyroxStation } from '@/types/triathlon';

const PLAN_START = '2026-09-28'; // a Monday
const today = new Date().toISOString().slice(0, 10);

const DOUBLES_SPLITS: Record<HyroxStation, number> = {
  ski_erg: 200, sled_push: 140, sled_pull: 190, burpee_broad_jumps: 210,
  row_erg: 220, farmer_carry: 80, sandbag_lunges: 200, wall_balls: 320,
};
const SINGLES_TIMES: Record<HyroxStation, number> = {
  ski_erg: 270, sled_push: 200, sled_pull: 260, burpee_broad_jumps: 300,
  row_erg: 290, farmer_carry: 110, sandbag_lunges: 280, wall_balls: 430,
};
const raceHistory = (splits: Record<HyroxStation, number>, format: 'open_doubles' | 'open_singles') =>
  Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, [
    { dateISO: today, sec: splits[st], source: 'race' as const, format, proWeights: false },
  ]]));

function hyroxState(hx: Partial<NonNullable<SimulatorState['hyroxConfig']>>): SimulatorState {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = PLAN_START;
  s.w = 1;
  s.tw = 16;
  s.hyroxConfig = {
    format: 'open_singles',
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
    generatorVersion: HYROX_GENERATOR_VERSION,
    ...hx,
  };
  s.wks = generateHyroxPlan(s);
  return s;
}

/** Every station component of the plan's race-pace circuits: since lane H2b
 *  each is one quarter-station set, and its durationSec is the station's
 *  target time pro rata (setTarget). */
function densityComponents(wks: Week[]): HyroxComponent[] {
  return wks.flatMap(wk => (wk.triWorkouts ?? []))
    .filter(w => w.t === 'hyrox_station_density')
    .flatMap(w => ((w as any).hyroxComponents ?? []) as HyroxComponent[])
    .filter(c => c.type !== 'run');
}

/** One quarter-station set's target (s): the station's target time pro rata,
 *  to the whole second, as the race-pace generator prescribes it. */
const setTarget = (fullSec: number) => Math.round(fullSec * HYROX_STATION_SET_FRACTION);

const CASES = [
  {
    name: 'singles target from doubles race splits: the converted times',
    hx: { format: 'open_singles' as const, stationBenchmarksDoubles: { ...DOUBLES_SPLITS }, stationBenchmarkHistory: raceHistory(DOUBLES_SPLITS, 'open_doubles') },
  },
  {
    name: 'doubles target from singles benchmarks: the singles times as stored',
    hx: { format: 'open_doubles' as const, stationBenchmarksSingles: { ...SINGLES_TIMES } },
  },
  {
    name: 'singles target, own singles times: unchanged',
    hx: { format: 'open_singles' as const, stationBenchmarksSingles: { ...SINGLES_TIMES } },
  },
  {
    name: 'doubles target, own doubles race splits: the solo equivalent of each split',
    hx: { format: 'open_doubles' as const, stationBenchmarksDoubles: { ...DOUBLES_SPLITS }, stationBenchmarkHistory: raceHistory(DOUBLES_SPLITS, 'open_doubles') },
  },
];

beforeEach(() => {
  document.body.innerHTML = '<div id="app-root"></div>';
});

describe('plan engine station targets come from the forecast\'s per-station benchmarks', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const s = hyroxState(c.hx);
      const targets = hyroxPlanningStationBenchmarks(s);
      const ledger = hyroxBenchmarkLedger(s);
      // The targets are the Stats ledger values, to the whole second.
      for (const row of ledger.rows) {
        expect(row.sec).toBeDefined();
        expect(targets[row.station]).toBe(Math.round(row.sec!));
      }
      const comps = densityComponents(s.wks);
      expect(comps.length).toBeGreaterThan(0);
      for (const comp of comps) {
        const st = comp.type as HyroxStation;
        expect(comp.durationSec).toBe(setTarget(targets[st]!));
      }
    });
  }

  it('the converted case prescribes no population seed for a station the forecast calibrates', () => {
    const s = hyroxState(CASES[0].hx);
    const resolved = resolveHyroxStationBenchmarks(s)!;
    expect(resolved.stations.every(b => b.teamTimeSplit && b.sec != null)).toBe(true);
    const seeds = STATION_SEED_TIMES_SEC.intermediate;
    for (const comp of densityComponents(s.wks)) {
      const st = comp.type as HyroxStation;
      expect(comp.durationSec).not.toBe(setTarget(seeds[st]));
      // Each split converts at its own station's ratio (lane H3b).
      expect(comp.durationSec).toBe(setTarget(Math.round(DOUBLES_SPLITS[st] / resolved.stationRatios[st]!)));
      expect(comp.durationSec).toBe(setTarget(Math.round(doublesStationSoloSec(st, DOUBLES_SPLITS[st]))));
    }
  });
});

describe('untested stations: the plan prescribes the seed Stats and the forecast show (lane H3b)', () => {
  it('a Pro women\'s target with no tests trains to its own field\'s seeds at Pro weights, not Open pooled seeds', () => {
    const s = hyroxState({ format: 'pro_singles' });
    s.biologicalSex = 'female';
    s.wks = generateHyroxPlan(s);
    const seeds = hyroxStationSeedsForState(s);
    const targets = hyroxPlanningStationBenchmarks(s);
    for (const st of HYROX_STATION_ORDER) expect(targets[st]).toBe(Math.round(seeds[st]));
    const comps = densityComponents(s.wks);
    expect(comps.length).toBeGreaterThan(0);
    for (const comp of comps) expect(comp.durationSec).toBe(setTarget(Math.round(seeds[comp.type as HyroxStation])));
    // Heavier loads than the Open pooled default on the sled push.
    expect(targets.sled_push!).toBeGreaterThan(STATION_SEED_TIMES_SEC.intermediate.sled_push);
  });

  it('an untested station is not a benchmark a session best must beat', () => {
    const s = hyroxState({ format: 'open_singles', stationBenchmarksSingles: { row_erg: 290 } });
    expect(Object.keys(hyroxCalibratedStationBenchmarks(s))).toEqual(['row_erg']);
    expect(Object.keys(hyroxPlanningStationBenchmarks(s))).toHaveLength(8);
  });
});

describe('doubles target with doubles race splits: one number per station for Stats, the plan and session bests', () => {
  // Review 2026-10-13: the plan prescribed the pair's time as a solo,
  // full-distance target ('Row Erg (1000m, target 3:40)', about 30% too fast),
  // and a solo session best that beat the split's solo equivalent moved the
  // Stats row and the next plan's target from 3:40 to 5:00.
  const doublesCase = () => hyroxState(CASES[3].hx);

  it('the plan target is Math.round of the Stats row, the solo equivalent, never the pair\'s time', () => {
    const s = doublesCase();
    const resolved = resolveHyroxStationBenchmarks(s)!;
    const targets = hyroxPlanningStationBenchmarks(s);
    const ledger = hyroxBenchmarkLedger(s);
    for (const row of ledger.rows) {
      const b = resolved.stations.find(x => x.station === row.station)!;
      expect(row.basis).toBe('solo_of_doubles_race');
      expect(row.sec).toBe(b.sec);
      expect(targets[row.station]).toBe(Math.round(row.sec!));
      expect(targets[row.station]).toBe(Math.round(DOUBLES_SPLITS[row.station] / resolved.stationRatios[row.station]!));
      expect(targets[row.station]!).toBeGreaterThan(DOUBLES_SPLITS[row.station]);
    }
  });

  it('a solo improvement moves the Stats row and the next plan\'s target faster, never slower', () => {
    const s = doublesCase();
    const rowBefore = hyroxBenchmarkLedger(s).rows.find(r => r.station === 'row_erg')!.sec!;
    const targetBefore = hyroxPlanningStationBenchmarks(s).row_erg!;
    const best = targetBefore - 8;
    const session = { t: 'hyrox_station_density', n: 'X', d: '', hyroxRounds: 2, hyroxComponents: [{ type: 'row_erg', distanceM: 1000, mtl: 0 }] } as any;
    const rec = (setIndex: number, durationSec: number): SetRecord =>
      ({ exerciseName: 'x', exerciseIndex: 0, setIndex, setCount: 2, reps: '', durationSec });
    const applied = applyHyroxSessionBenchmarks(session, [rec(0, best + 5), rec(1, best)], s);
    expect(applied).toHaveLength(1);
    // The benchmark the round beat is the target the plan prescribed.
    expect(applied[0].fromSec).toBe(targetBefore);
    expect(applied[0].fromSec).toBe(Math.round(rowBefore));

    const rowAfter = hyroxBenchmarkLedger(s).rows.find(r => r.station === 'row_erg')!;
    expect(rowAfter.sec).toBe(best);
    expect(rowAfter.sec!).toBeLessThan(rowBefore);
    s.wks = generateHyroxPlan(s);
    const targetAfter = hyroxPlanningStationBenchmarks(s).row_erg!;
    expect(targetAfter).toBe(best);
    expect(targetAfter).toBeLessThan(targetBefore);
    for (const comp of densityComponents(s.wks).filter(c => c.type === 'row_erg')) {
      expect(comp.durationSec).toBe(setTarget(best));
    }
  });
});

describe('Open target with a Pro race split: plan, Stats and forecast read the Open equivalent', () => {
  // Review 2026-10-13: the resolver read a split at the weights it was stored
  // at. An Open Singles athlete with a 260 s Pro sled push split saw a
  // forecast row of 226.1 but a plan target of 260 at Open loads (about 15%
  // slow); a Pro Doubles split of 190 gave a forecast row of 232.4 and a plan
  // target of 267. The density circuits programme sled pull, so it is the
  // station checked here (same Pro multiplier as sled push).
  const proSplit = (format: 'pro_singles' | 'pro_doubles', sec: number) => hyroxState({
    format: 'open_singles',
    ...(format === 'pro_singles'
      ? { stationBenchmarksSingles: { sled_pull: sec } }
      : { stationBenchmarksDoubles: { sled_pull: sec } }),
    stationBenchmarkHistory: { sled_pull: [{ dateISO: today, sec, source: 'race' as const, format, proWeights: true }] },
  });

  for (const [format, sec] of [['pro_singles', 300], ['pro_doubles', 220]] as const) {
    it(`${format} sled pull split of ${sec} s: the plan target is Math.round of the forecast's Open-weight row`, () => {
      const s = proSplit(format, sec);
      const line = predictHyroxRace(s)!.stations.find(l => l.station === 'sled_pull')!;
      const target = hyroxPlanningStationBenchmarks(s).sled_pull!;
      expect(target).toBe(Math.round(line.baseSec));
      const row = hyroxBenchmarkLedger(s).rows.find(r => r.station === 'sled_pull')!;
      expect(row.sec!).toBeCloseTo(line.baseSec, 9);
      // Pro to Open per station from the results (difference in differences);
      // a Pro Doubles split first converts to the solo time in Pro Doubles.
      if (format === 'pro_singles') {
        expect(target).toBe(Math.round(hyroxProToOpenSec('sled_pull', sec, 'pooled')));
        expect(target).toBeLessThan(sec);
      } else {
        const proSolo = doublesStationSoloSec('sled_pull', sec, { singles: { format: 'pro_singles', sex: 'pooled' }, doubles: { format: 'pro_doubles', sex: 'pooled' } });
        expect(target).toBe(Math.round(hyroxProToOpenSec('sled_pull', proSolo, 'pooled')));
        expect(target).toBeLessThan(Math.round(proSolo));
      }
      const pulls = densityComponents(s.wks).filter(c => c.type === 'sled_pull');
      expect(pulls.length).toBeGreaterThan(0);
      for (const comp of pulls) expect(comp.durationSec).toBe(setTarget(target));
    });
  }
});

describe('the add-session modal prescribes the same station targets', () => {
  it('a station density session added in the app uses hyroxPlanningStationBenchmarks', () => {
    const s = hyroxState(CASES[0].hx);
    setState(s);
    const targets = hyroxPlanningStationBenchmarks(s);
    const before = s.wks[0].triWorkouts!.length;
    openHyroxAddSessionModal(() => {});
    (document.querySelector('.hx-add-opt[data-kind="station_density"]') as HTMLButtonElement).click();
    (document.querySelector('#hx-add-confirm') as HTMLButtonElement).click();
    const ms = getMutableState();
    expect(ms.wks[0].triWorkouts!.length).toBe(before + 1);
    const added = ms.wks[0].triWorkouts!.find(w => w.id?.startsWith('adhoc-'))!;
    const comps = ((added as any).hyroxComponents ?? []) as HyroxComponent[];
    expect(comps.length).toBeGreaterThan(0);
    for (const comp of comps) {
      expect(comp.durationSec).toBe(setTarget(targets[comp.type as HyroxStation]!));
    }
  });

  it('neither planning site reads a benchmark slot directly', () => {
    for (const f of ['plan_engine.hyrox.ts', join('..', 'ui', 'hyrox', 'add-session-modal.ts')]) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src, f).toContain('hyroxPlanningStationBenchmarks(');
      expect(src, f).not.toMatch(/stationBenchmarksSingles|stationBenchmarksDoubles|hx\.stationBenchmarks\b/);
    }
  });
});
