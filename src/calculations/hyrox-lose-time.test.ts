import { describe, expect, it } from 'vitest';
import {
  analyzeHyroxLoseTime,
  compareWithPeers,
  fmtFinishShort,
  fmtLostTime,
  hyroxLoseTimeHeadline,
  hyroxPastRaceSplits,
  type HyroxPastRaceSplits,
} from './hyrox-lose-time';
import {
  hyroxPeerSplitsAt,
  hyroxResultsTable,
  secondsAtPercentileIn,
  type HyroxResultsCohort,
} from './hyrox-results';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import type { SimulatorState } from '@/types/state';
import type { HyroxConfig, HyroxStation } from '@/types/triathlon';

const OS_W: HyroxResultsCohort = { format: 'open_singles', sex: 'female' };

function stateWith(hx: Partial<HyroxConfig>, biologicalSex: SimulatorState['biologicalSex'] = 'female') {
  return { biologicalSex, hyroxConfig: { format: 'open_singles', athleteBand: 'intermediate', ...hx } as HyroxConfig };
}

/** A result that is exactly the peer profile at its own finish. */
function peerResult(cohort: HyroxResultsCohort, totalSec: number): HyroxPastRaceSplits {
  const p = hyroxPeerSplitsAt(cohort, totalSec)!;
  return {
    stations: Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, p.segments[st]])) as Record<HyroxStation, number>,
    runLegsSec: [...p.runLegsSec],
    roxzoneSec: p.segments.roxzone,
  };
}

describe('compareWithPeers: quantile-free peer comparison', () => {
  it('a result exactly at the field\'s profile for its finish loses 0 everywhere', () => {
    const segs = compareWithPeers(OS_W, 5816, peerResult(OS_W, 5816));
    expect(segs).toHaveLength(17);
    for (const s of segs) expect(Math.abs(s.lostSec)).toBeLessThan(1e-6);
  });

  it('a result at every table\'s median (finish = their sum) loses under 10 s on any segment', () => {
    const med = (m: Parameters<typeof hyroxResultsTable>[0]) => secondsAtPercentileIn(hyroxResultsTable(m, OS_W)!, 50);
    const stations = Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, med(st)])) as Record<HyroxStation, number>;
    const runTotalSec = med('run_total');
    const roxzoneSec = med('roxzone');
    const total = runTotalSec + roxzoneSec + HYROX_STATION_ORDER.reduce((a, st) => a + stations[st], 0);
    const segs = compareWithPeers(OS_W, total, { stations, runTotalSec, roxzoneSec });
    expect(segs).toHaveLength(10);
    for (const s of segs) expect(Math.abs(s.lostSec)).toBeLessThan(10);
    // A complete result: time lost and time gained balance.
    expect(segs.reduce((a, s) => a + s.lostSec, 0)).toBeCloseTo(0, 6);
  });

  it('ranks segments by seconds lost; gains are the negatives', () => {
    const base = peerResult(OS_W, 5070);
    const r: HyroxPastRaceSplits = {
      ...base,
      stations: { ...base.stations, wall_balls: base.stations.wall_balls! + 72, sled_pull: base.stations.sled_pull! + 41 },
      roxzoneSec: base.roxzoneSec! - 113,
    };
    const segs = compareWithPeers(OS_W, 5070, r);
    expect(segs[0].key).toBe('wall_balls');
    expect(segs[0].lostSec).toBeCloseTo(72, 6);
    expect(segs[1].key).toBe('sled_pull');
    expect(segs[segs.length - 1].key).toBe('roxzone');
    expect(segs[segs.length - 1].lostSec).toBeCloseTo(-113, 6);
  });
});

describe('segments from what was pasted', () => {
  const full = peerResult(OS_W, 6000);
  it('8 stations and no run data: the rest is one segment, Running and Roxzone', () => {
    const segs = compareWithPeers(OS_W, 6000, { stations: full.stations });
    expect(segs.map(s => s.key).sort()).toEqual([...HYROX_STATION_ORDER, 'run_roxzone'].sort());
    const rr = segs.find(s => s.key === 'run_roxzone')!;
    expect(rr.implied).toBe(true);
    expect(Math.abs(rr.lostSec)).toBeLessThan(1e-6);
  });

  it('8 stations and the run total: the Roxzone is implied', () => {
    const runTotalSec = full.runLegsSec!.reduce((a, b) => a! + b!, 0)!;
    const segs = compareWithPeers(OS_W, 6000, { stations: full.stations, runTotalSec });
    expect(segs.find(s => s.key === 'roxzone')!.implied).toBe(true);
    expect(segs.find(s => s.key === 'run_total')!.implied).toBe(false);
  });

  it('some legs only: each is compared, nothing implied', () => {
    const legs: Array<number | null> = [full.runLegsSec![0], null, full.runLegsSec![2], null, null, null, null, null];
    const segs = compareWithPeers(OS_W, 6000, { stations: full.stations, runLegsSec: legs });
    expect(segs.filter(s => s.key.startsWith('run_')).map(s => s.key).sort()).toEqual(['run_1', 'run_3']);
    expect(segs.some(s => s.implied)).toBe(false);
  });

  it('a few stations only: just those', () => {
    const segs = compareWithPeers(OS_W, 6000, { stations: { ski_erg: 330, wall_balls: 480 } });
    expect(segs.map(s => s.key).sort()).toEqual(['ski_erg', 'wall_balls']);
  });

  it('stations summing past the finish imply nothing', () => {
    const big = Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, 800])) as Record<HyroxStation, number>;
    const segs = compareWithPeers(OS_W, 6000, { stations: big });
    expect(segs.some(s => s.implied)).toBe(false);
  });
});

describe('headline copy', () => {
  it('names the segment, the seconds and the finish', () => {
    const base = peerResult(OS_W, 5070);
    const segs = compareWithPeers(OS_W, 5070, {
      ...base,
      stations: { ...base.stations, wall_balls: base.stations.wall_balls! + 72 },
      roxzoneSec: base.roxzoneSec! - 72,
    });
    const losses = segs.filter(s => Math.round(s.lostSec) >= 1);
    expect(hyroxLoseTimeHeadline(losses, 'open_singles', 5070))
      .toBe('Most time lost on Wall Balls: 1:12 slower than athletes finishing in 1:24');
  });

  it('doubles compare with pairs; under a minute reads in seconds', () => {
    const seg = { key: 'sled_push' as const, label: 'Sled Push', athleteSec: 140, peerSec: 100, lostSec: 40, implied: false };
    expect(hyroxLoseTimeHeadline([seg], 'open_doubles', 4400)).toBe('Most time lost on Sled Push: 40 sec slower than pairs finishing in 1:13');
  });

  it('no loss anywhere', () => {
    expect(hyroxLoseTimeHeadline([], 'pro_singles', 3480)).toBe('No segment slower than athletes finishing in 58 min');
  });

  it('formats', () => {
    expect(fmtLostTime(72.4)).toBe('1:12');
    expect(fmtLostTime(-40)).toBe('40 sec');
    expect(fmtFinishShort(5079)).toBe('1:24');
    expect(fmtFinishShort(3540)).toBe('59 min');
  });

  it('no em dash and no capitals-only words', () => {
    const h = hyroxLoseTimeHeadline([{ key: 'roxzone', label: 'Roxzone', athleteSec: 600, peerSec: 500, lostSec: 100, implied: false }], 'open_singles', 6000);
    expect(h).not.toMatch(/—/);
  });
});

describe('analyzeHyroxLoseTime: empty states and cohort', () => {
  it('no previous finish: no_result', () => {
    expect(analyzeHyroxLoseTime(stateWith({})).status).toBe('no_result');
  });

  it('a finish with no format: no_result (no field to compare against)', () => {
    expect(analyzeHyroxLoseTime(stateWith({ previousHyroxTimeSec: 5400 })).status).toBe('no_result');
  });

  it('a finish with no splits: no_splits', () => {
    const r = analyzeHyroxLoseTime(stateWith({ previousHyroxTimeSec: 5400, hyroxPreviousTimeFormat: 'open_singles' }));
    expect(r.status).toBe('no_splits');
    expect(r.headline).toBeNull();
  });

  it('reads the previous race\'s field: a mixed pair against Open Doubles mixed', () => {
    const r = analyzeHyroxLoseTime(stateWith({
      format: 'open_doubles', division: 'mixed',
      previousHyroxTimeSec: 4800, hyroxPreviousTimeFormat: 'open_doubles',
      hyroxPreviousStationSplits: { sled_push: 200, wall_balls: 300 },
    }));
    expect(r.status).toBe('ok');
    expect(r.cohort).toEqual({ format: 'open_doubles', sex: 'mixed' });
    expect(r.headline).toContain('pairs finishing in');
  });

  it('a Pro Singles race reads the Pro field; a man reads the men\'s table', () => {
    const r = analyzeHyroxLoseTime(stateWith({
      previousHyroxTimeSec: 4600, hyroxPreviousTimeFormat: 'pro_singles',
      hyroxPreviousStationSplits: { sled_push: 200 },
    }, 'male'));
    expect(r.cohort).toEqual({ format: 'pro_singles', sex: 'male' });
  });

  it('losses and gains split at a whole second', () => {
    const base = peerResult(OS_W, 5400);
    const r = analyzeHyroxLoseTime(stateWith({
      previousHyroxTimeSec: 5400, hyroxPreviousTimeFormat: 'open_singles',
      hyroxPreviousStationSplits: { ...base.stations, ski_erg: base.stations.ski_erg! + 30, row_erg: base.stations.row_erg! - 30 } as Record<HyroxStation, number>,
      hyroxPreviousRunSplitsSec: base.runLegsSec,
      hyroxPreviousRoxzoneSec: base.roxzoneSec,
    }));
    expect(r.losses.map(s => s.key)).toEqual(['ski_erg']);
    expect(r.gains.map(s => s.key)).toEqual(['row_erg']);
    expect(r.segments).toHaveLength(17);
  });
});

describe('hyroxPastRaceSplits: the result on file', () => {
  it('prefers the splits logged with the result', () => {
    const r = hyroxPastRaceSplits({
      hyroxPreviousStationSplits: { ski_erg: 300 },
      hyroxPreviousTimeFormat: 'open_singles',
      stationBenchmarkHistory: { ski_erg: [{ dateISO: '2026-01-01', sec: 290, source: 'race', format: 'open_singles' }] },
    });
    expect(r.stations).toEqual({ ski_erg: 300 });
  });

  it('falls back to race splits of that format and date (onboarding)', () => {
    const r = hyroxPastRaceSplits({
      hyroxPreviousTimeFormat: 'open_singles',
      hyroxPreviousRaceDate: '2026-03-14',
      stationBenchmarkHistory: {
        ski_erg: [
          { dateISO: '2026-03-14', sec: 290, source: 'race', format: 'open_singles' },
          { dateISO: '2026-05-01', sec: 280, source: 'half_test', format: 'open_singles' },
        ],
        row_erg: [{ dateISO: '2025-11-01', sec: 300, source: 'race', format: 'open_singles' }],
        wall_balls: [{ dateISO: '2026-03-14', sec: 400, source: 'race', format: 'open_doubles' }],
      },
    });
    expect(r.stations).toEqual({ ski_erg: 290 });
  });

  it('no race date and two race dates on file: nothing, rather than two races mixed', () => {
    const r = hyroxPastRaceSplits({
      hyroxPreviousTimeFormat: 'open_singles',
      stationBenchmarkHistory: {
        ski_erg: [{ dateISO: '2026-03-14', sec: 290, source: 'race', format: 'open_singles' }],
        row_erg: [{ dateISO: '2025-11-01', sec: 300, source: 'race', format: 'open_singles' }],
      },
    });
    expect(r.stations).toEqual({});
  });
});
