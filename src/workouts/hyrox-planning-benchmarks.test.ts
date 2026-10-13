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
 * second.
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
import { HYROX_STATION_ORDER, STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import { resolveHyroxStationBenchmarks, hyroxPlanningStationBenchmarks } from '@/calculations/race-prediction.hyrox';
import { hyroxBenchmarkLedger } from '@/ui/hyrox/stats-view';
import { openHyroxAddSessionModal } from '@/ui/hyrox/add-session-modal';
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

/** Every station component of the plan's race-pace density circuits: their
 *  durationSec is the station's target time. */
function densityComponents(wks: Week[]): HyroxComponent[] {
  return wks.flatMap(wk => (wk.triWorkouts ?? []))
    .filter(w => w.t === 'hyrox_station_density')
    .flatMap(w => ((w as any).hyroxComponents ?? []) as HyroxComponent[])
    .filter(c => c.type !== 'run');
}

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
        expect(comp.durationSec).toBe(targets[st]);
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
      expect(comp.durationSec).not.toBe(seeds[st]);
      expect(comp.durationSec).toBe(Math.round(DOUBLES_SPLITS[st] / resolved.stationRatio));
    }
  });
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
      expect(comp.durationSec).toBe(targets[comp.type as HyroxStation]);
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
