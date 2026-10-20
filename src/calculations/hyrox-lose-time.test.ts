import { describe, expect, it } from 'vitest';
import {
  analyzeHyroxLoseTime,
  compareWithPeers,
  fmtLostTime,
  hyroxLoseTimeHeadline,
  hyroxPastRaceSplits,
  hyroxTopLostSegment,
  HYROX_LOSE_TIME_MATERIAL_SEC,
  type HyroxLoseTimeSegment,
  type HyroxPastRaceSplits,
} from './hyrox-lose-time';
import {
  HYROX_PEER_SEGMENTS,
  hyroxPeerResidualWeights,
  hyroxPeerSplitsAt,
  hyroxResultsTable,
  secondsAtPercentileIn,
  type HyroxResultsCohort,
} from './hyrox-results';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { HYROX_S89_BAND_SEEDS } from '@/data/hyrox-results-s79';
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
    // 8 stations, Running (the 8 legs together) and the Roxzone.
    expect(segs).toHaveLength(10);
    for (const s of segs) expect(Math.abs(s.lostSec)).toBeLessThan(1e-6);
    const run = segs.find(s => s.key === 'run_total')!;
    expect(run.legs!.map(l => l.leg)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const l of run.legs!) expect(Math.abs(l.lostSec)).toBeLessThan(1e-6);
  });

  it('every cohort: an athlete at the band\'s own segment medians, with the medians\' gap on the skewed segments, reads Running (and every segment) level', () => {
    const cohorts: HyroxResultsCohort[] = [
      OS_W, { format: 'open_singles', sex: 'male' },
      { format: 'pro_singles', sex: 'female' }, { format: 'pro_singles', sex: 'male' },
      { format: 'open_doubles', sex: 'female' }, { format: 'open_doubles', sex: 'male' }, { format: 'open_doubles', sex: 'mixed' },
      { format: 'pro_doubles', sex: 'female' }, { format: 'pro_doubles', sex: 'male' },
    ];
    for (const cohort of cohorts) {
      const w = hyroxPeerResidualWeights(cohort)!;
      for (const band of ['competitive', 'advanced', 'intermediate', 'novice', 'beginner'] as const) {
        const m = HYROX_S89_BAND_SEEDS[cohort.format][cohort.sex]![band]!.medians;
        const gap = m.total - HYROX_PEER_SEGMENTS.reduce((a, seg) => a + m[seg], 0);
        const at = (seg: (typeof HYROX_PEER_SEGMENTS)[number]) => m[seg] + gap * w[seg];
        const segs = compareWithPeers(cohort, m.total, {
          stations: Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, at(st)])) as Record<HyroxStation, number>,
          runTotalSec: at('run_total'),
          roxzoneSec: at('roxzone'),
        });
        expect(segs).toHaveLength(10);
        const run = segs.find(sg => sg.key === 'run_total')!;
        expect(Math.abs(run.lostSec)).toBeLessThan(HYROX_LOSE_TIME_MATERIAL_SEC);
        for (const sg of segs) expect(Math.abs(sg.lostSec)).toBeLessThan(0.5);
      }
    }
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

  it('running is ranked whole: a uniformly slower runner\'s headline names Running', () => {
    // Every leg +22 s (176 s in all), one station +60 s, the Roxzone gives the
    // rest back so the finish holds.
    const total = 5400;
    const base = peerResult(OS_W, total);
    const r: HyroxPastRaceSplits = {
      stations: { ...base.stations, sled_push: base.stations.sled_push! + 60 },
      runLegsSec: base.runLegsSec!.map(v => v! + 22),
      roxzoneSec: base.roxzoneSec! - 236,
    };
    const segs = compareWithPeers(OS_W, total, r);
    expect(segs.filter(s => s.key === 'run_total')).toHaveLength(1);
    expect(segs.some(s => /^Run \d/.test(s.label))).toBe(false);
    expect(segs[0].key).toBe('run_total');
    expect(segs[0].lostSec).toBeCloseTo(176, 6);
    const lt = analyzeHyroxLoseTime(stateWith({
      previousHyroxTimeSec: total, hyroxPreviousTimeFormat: 'open_singles',
      hyroxPreviousStationSplits: r.stations, hyroxPreviousRunSplitsSec: r.runLegsSec, hyroxPreviousRoxzoneSec: r.roxzoneSec,
    }));
    expect(lt.headline).toBe('Most time lost on Running: 2:56 slower than athletes finishing in 1:30:00');
  });

  it('the Running segment keeps its legs in race order', () => {
    const base = peerResult(OS_W, 5400);
    const legs = base.runLegsSec!.map((v, i) => v! + (i === 6 ? 40 : 5));
    const segs = compareWithPeers(OS_W, 5400, { ...base, runLegsSec: legs, roxzoneSec: base.roxzoneSec! - 75 });
    const run = segs.find(s => s.key === 'run_total')!;
    expect(run.legs!.map(l => l.leg)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(run.legs![6].lostSec).toBeCloseTo(40, 6);
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

  it('some legs only: one Running segment over those legs against the same peer legs, nothing implied', () => {
    const legs: Array<number | null> = [full.runLegsSec![0]! + 10, null, full.runLegsSec![2]! + 10, null, null, null, null, null];
    const segs = compareWithPeers(OS_W, 6000, { stations: full.stations, runLegsSec: legs });
    const run = segs.filter(s => s.key === 'run_total');
    expect(run).toHaveLength(1);
    expect(run[0].partialLegs).toBe(2);
    expect(run[0].legs!.map(l => l.leg)).toEqual([1, 3]);
    expect(run[0].lostSec).toBeCloseTo(20, 6);
    expect(segs.some(s => s.implied)).toBe(false);
  });

  it('some legs, the Roxzone and all 8 stations: Running is implied from the finish, the legs stay as detail', () => {
    const legs: Array<number | null> = [full.runLegsSec![0], null, null, null, null, null, null, full.runLegsSec![7]];
    const segs = compareWithPeers(OS_W, 6000, { stations: full.stations, runLegsSec: legs, roxzoneSec: full.roxzoneSec });
    const run = segs.find(s => s.key === 'run_total')!;
    expect(run.implied).toBe(true);
    expect(run.partialLegs).toBeUndefined();
    expect(run.legs!.map(l => l.leg)).toEqual([1, 8]);
    expect(Math.abs(run.lostSec)).toBeLessThan(1e-6);
  });

  it('the run total and the Roxzone: no leg detail', () => {
    const runTotalSec = full.runLegsSec!.reduce((a, b) => a! + b!, 0)!;
    const segs = compareWithPeers(OS_W, 6000, { stations: full.stations, runTotalSec, roxzoneSec: full.roxzoneSec });
    expect(segs).toHaveLength(10);
    expect(segs.find(s => s.key === 'run_total')!.legs).toBeUndefined();
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
  const seg = (key: HyroxLoseTimeSegment['key'], label: string, lostSec: number): HyroxLoseTimeSegment =>
    ({ key, label, athleteSec: 300 + lostSec, peerSec: 300, lostSec, implied: false });

  it('names the segment, the seconds and the finish in full', () => {
    const base = peerResult(OS_W, 5070);
    const segs = compareWithPeers(OS_W, 5070, {
      ...base,
      stations: { ...base.stations, wall_balls: base.stations.wall_balls! + 72 },
      roxzoneSec: base.roxzoneSec! - 72,
    });
    const losses = segs.filter(s => Math.round(s.lostSec) >= HYROX_LOSE_TIME_MATERIAL_SEC);
    expect(hyroxLoseTimeHeadline(losses, [], 'open_singles', 5070))
      .toBe('Most time lost on Wall Balls: 1:12 slower than athletes finishing in 1:24:30');
  });

  it('doubles compare with pairs; under a minute reads in seconds', () => {
    expect(hyroxLoseTimeHeadline([seg('sled_push', 'Sled Push', 40)], [], 'open_doubles', 4400))
      .toBe('Most time lost on Sled Push: 40s slower than pairs finishing in 1:13:20');
  });

  it('no material loss: the most gained, else level everywhere', () => {
    expect(hyroxLoseTimeHeadline([], [seg('run_total', 'Running', -29)], 'open_singles', 5400))
      .toBe('Most time gained on Running: 29s faster than athletes finishing in 1:30:00');
    expect(hyroxLoseTimeHeadline([], [], 'pro_singles', 3480))
      .toBe('Within 15s of athletes finishing in 58:00 on every segment');
  });

  it('formats', () => {
    expect(fmtLostTime(72.4)).toBe('1:12');
    expect(fmtLostTime(-40)).toBe('40s');
  });

  it('the Roxzone reads "in the Roxzone", lost or gained', () => {
    expect(hyroxLoseTimeHeadline([seg('roxzone', 'Roxzone', 63)], [], 'open_singles', 5071))
      .toBe('Most time lost in the Roxzone: 1:03 slower than athletes finishing in 1:24:31');
    expect(hyroxLoseTimeHeadline([], [seg('roxzone', 'Roxzone', -41)], 'open_singles', 5071))
      .toBe('Most time gained in the Roxzone: 41s faster than athletes finishing in 1:24:31');
  });

  it('no em dash', () => {
    const h = hyroxLoseTimeHeadline([seg('roxzone', 'Roxzone', 100)], [], 'open_singles', 6000);
    expect(h).not.toMatch(/\u2014/);
  });
});

describe('materiality', () => {
  it('a segment inside the band is level, neither lost nor gained', () => {
    const base = peerResult(OS_W, 5400);
    const lt = analyzeHyroxLoseTime(stateWith({
      previousHyroxTimeSec: 5400, hyroxPreviousTimeFormat: 'open_singles',
      hyroxPreviousStationSplits: { ...base.stations, ski_erg: base.stations.ski_erg! + 40, burpee_broad_jumps: base.stations.burpee_broad_jumps! + 6, row_erg: base.stations.row_erg! - 46 } as Record<HyroxStation, number>,
      hyroxPreviousRunSplitsSec: base.runLegsSec,
      hyroxPreviousRoxzoneSec: base.roxzoneSec,
    }));
    expect(lt.losses.map(s => s.key)).toEqual(['ski_erg']);
    expect(lt.gains.map(s => s.key)).toEqual(['row_erg']);
    expect(lt.level.map(s => s.key)).toContain('burpee_broad_jumps');
    expect(lt.losses.length + lt.gains.length + lt.level.length).toBe(lt.segments.length);
    // Level segments read in race order: the running, the stations, the Roxzone.
    expect(lt.level.map(s => s.key)).toEqual(['run_total', 'sled_push', 'sled_pull', 'burpee_broad_jumps', 'farmer_carry', 'sandbag_lunges', 'wall_balls', 'roxzone']);
  });

  it('the band is the method\'s measured uncertainty, 15 s', () => {
    expect(HYROX_LOSE_TIME_MATERIAL_SEC).toBe(15);
  });

  it('the top lost segment is the biggest material loss, Running and the Roxzone included', () => {
    const l = (key: HyroxLoseTimeSegment['key'], lostSec: number) => ({ key, label: String(key), athleteSec: 1, peerSec: 1, lostSec, implied: false });
    expect(hyroxTopLostSegment({ losses: [l('run_total', 90), l('roxzone', 50), l('wall_balls', 30)] })?.key).toBe('run_total');
    expect(hyroxTopLostSegment({ losses: [l('wall_balls', 30)] })?.key).toBe('wall_balls');
    expect(hyroxTopLostSegment({ losses: [] })).toBeNull();
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

  it('a doubles result reads the division it was raced in; without one, the current division, flagged', () => {
    const splits = { hyroxPreviousStationSplits: { sled_push: 200, wall_balls: 300 } };
    // Raced Mixed Doubles, now trains singles.
    const recorded = analyzeHyroxLoseTime(stateWith({
      previousHyroxTimeSec: 4800, hyroxPreviousTimeFormat: 'open_doubles', hyroxPreviousTimeDivision: 'mixed', ...splits,
    }, 'male'));
    expect(recorded.cohort).toEqual({ format: 'open_doubles', sex: 'mixed' });
    expect(recorded.divisionAssumed).toBe(false);
    const assumed = analyzeHyroxLoseTime(stateWith({
      previousHyroxTimeSec: 4800, hyroxPreviousTimeFormat: 'open_doubles', ...splits,
    }, 'male'));
    expect(assumed.cohort).toEqual({ format: 'open_doubles', sex: 'male' });
    expect(assumed.divisionAssumed).toBe(true);
    // Singles results never carry the flag.
    expect(analyzeHyroxLoseTime(stateWith({
      previousHyroxTimeSec: 5400, hyroxPreviousTimeFormat: 'open_singles', hyroxPreviousStationSplits: { sled_push: 200 },
    })).divisionAssumed).toBe(false);
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
