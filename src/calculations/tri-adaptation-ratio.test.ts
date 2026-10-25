/**
 * Tests for `computeTriAdaptationRatios`. The per-discipline live adaptation
 * ratio that scales the horizon adjuster's projected gain.
 */

import { describe, it, expect } from 'vitest';
import { computeTriAdaptationRatios, efDecouplingPct } from './tri-adaptation-ratio';
import {
  ADAPT_RATIO_MIN, ADAPT_RATIO_MAX,
  ADAPT_WEIGHTS_SWIM, ADAPT_WEIGHTS_BIKE, ADAPT_WEIGHTS_RUN,
} from '@/constants/triathlon-adaptation-params';
import type { SimulatorState } from '@/types/state';

function emptyState(): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 1,
    wks: [],
    triConfig: { distance: 'ironman' },
  } as unknown as SimulatorState;
}

describe('blend weights — must sum to 1.0', () => {
  it('swim weights sum to 1.0', () => {
    const s = ADAPT_WEIGHTS_SWIM.hrv + ADAPT_WEIGHTS_SWIM.rpe + ADAPT_WEIGHTS_SWIM.cssSd;
    expect(s).toBeCloseTo(1.0, 6);
  });
  it('bike weights sum to 1.0', () => {
    const s = ADAPT_WEIGHTS_BIKE.hrv + ADAPT_WEIGHTS_BIKE.rpe
            + ADAPT_WEIGHTS_BIKE.hrAtPower + ADAPT_WEIGHTS_BIKE.pahr;
    expect(s).toBeCloseTo(1.0, 6);
  });
  it('run weights sum to 1.0', () => {
    const s = ADAPT_WEIGHTS_RUN.hrv + ADAPT_WEIGHTS_RUN.rpe + ADAPT_WEIGHTS_RUN.pahr;
    expect(s).toBeCloseTo(1.0, 6);
  });
});

describe('no signal data → ratios all 1.0', () => {
  it('empty state returns neutral ratios', () => {
    const r = computeTriAdaptationRatios(emptyState());
    expect(r.swim).toBe(1.0);
    expect(r.bike).toBe(1.0);
    expect(r.run).toBe(1.0);
    expect(r.signals.hrv).toBeNull();
    expect(r.signals.rpeSwim).toBeNull();
    expect(r.signals.hrAtPower).toBeNull();
  });
});

describe('HRV signal', () => {
  it('rising HRV (recent 7d > 28d baseline) → positive adjustment', () => {
    const s = emptyState();
    const today = new Date();
    const hist: SimulatorState['physiologyHistory'] = [];
    // 28 days back: lower HRV
    for (let i = 28; i >= 8; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      hist.push({ date: d.toISOString().split('T')[0], hrvRmssd: 50 });
    }
    // Recent 7 days: higher HRV
    for (let i = 7; i >= 1; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      hist.push({ date: d.toISOString().split('T')[0], hrvRmssd: 55 });
    }
    s.physiologyHistory = hist;
    const r = computeTriAdaptationRatios(s);
    expect(r.signals.hrv).not.toBeNull();
    expect(r.signals.hrv!).toBeGreaterThan(0);
    expect(r.swim).toBeGreaterThan(1.0);
    expect(r.bike).toBeGreaterThan(1.0);
    expect(r.run).toBeGreaterThan(1.0);
  });

  it('falling HRV → negative adjustment', () => {
    const s = emptyState();
    const today = new Date();
    const hist: SimulatorState['physiologyHistory'] = [];
    for (let i = 28; i >= 8; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      hist.push({ date: d.toISOString().split('T')[0], hrvRmssd: 60 });
    }
    for (let i = 7; i >= 1; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      hist.push({ date: d.toISOString().split('T')[0], hrvRmssd: 55 });
    }
    s.physiologyHistory = hist;
    const r = computeTriAdaptationRatios(s);
    expect(r.signals.hrv!).toBeLessThan(0);
    expect(r.run).toBeLessThan(1.0);
  });
});

describe('RPE-vs-expected signal', () => {
  it('actual RPE consistently lower than expected → positive adjustment', () => {
    const s = emptyState();
    s.w = 4;
    const wks: any[] = [];
    for (let w = 0; w < 4; w++) {
      const wk: any = { rated: {}, triWorkouts: [] };
      // Two run workouts with planned RPE 7, actual 5 (felt 2 points easier)
      wk.triWorkouts.push({ id: `r${w}a`, t: 'easy', r: 7, rpe: 7, discipline: 'run' });
      wk.triWorkouts.push({ id: `r${w}b`, t: 'threshold', r: 8, rpe: 8, discipline: 'run' });
      wk.rated[`r${w}a`] = 5;
      wk.rated[`r${w}b`] = 6;
      wks.push(wk);
    }
    s.wks = wks;
    const r = computeTriAdaptationRatios(s);
    expect(r.signals.rpeRun).not.toBeNull();
    expect(r.signals.rpeRun!).toBeGreaterThan(0);
    expect(r.run).toBeGreaterThan(1.0);
  });

  it('actual RPE consistently higher than expected → negative adjustment', () => {
    const s = emptyState();
    s.w = 4;
    const wks: any[] = [];
    for (let w = 0; w < 4; w++) {
      const wk: any = { rated: {}, triWorkouts: [] };
      wk.triWorkouts.push({ id: `b${w}a`, t: 'bike_endurance', r: 5, rpe: 5, discipline: 'bike' });
      wk.triWorkouts.push({ id: `b${w}b`, t: 'bike_threshold', r: 7, rpe: 7, discipline: 'bike' });
      wk.rated[`b${w}a`] = 7;
      wk.rated[`b${w}b`] = 9;
      wks.push(wk);
    }
    s.wks = wks;
    const r = computeTriAdaptationRatios(s);
    expect(r.signals.rpeBike!).toBeLessThan(0);
    expect(r.bike).toBeLessThan(1.0);
  });

  it("'skip' rated entries are ignored, not counted as RPE 0", () => {
    const s = emptyState();
    s.w = 3;
    const wks: any[] = [];
    for (let w = 0; w < 3; w++) {
      const wk: any = { rated: {}, triWorkouts: [] };
      wk.triWorkouts.push({ id: `s${w}`, t: 'swim_threshold', r: 7, rpe: 7, discipline: 'swim' });
      wk.rated[`s${w}`] = 'skip';
      wks.push(wk);
    }
    s.wks = wks;
    const r = computeTriAdaptationRatios(s);
    expect(r.signals.rpeSwim).toBeNull();
  });
});

describe('HR-at-power signal (bike)', () => {
  it('HR dropping over weeks at same power → positive adjustment', () => {
    const s = emptyState();
    s.w = 6;
    s.triConfig!.bike = { ftp: 250 };
    const wks: any[] = [];
    // Weeks 0..5; HR drops 2 bpm/week at 220 W (88% of FTP)
    for (let w = 0; w < 6; w++) {
      const wk: any = { garminActuals: {} };
      wk.garminActuals[`b${w}`] = {
        garminId: `b${w}`,
        distanceKm: 40,
        durationSec: 3600,
        avgPaceSecKm: null,
        avgHR: 160 - w * 2,
        maxHR: null,
        calories: null,
        activityType: 'CYCLING',
        averageWatts: 220,
      };
      wks.push(wk);
    }
    s.wks = wks;
    const r = computeTriAdaptationRatios(s);
    expect(r.signals.hrAtPower).not.toBeNull();
    expect(r.signals.hrAtPower!).toBeGreaterThan(0);
    expect(r.bike).toBeGreaterThan(1.0);
  });

  it('no FTP → no signal', () => {
    const s = emptyState();
    s.triConfig!.bike = {};
    const r = computeTriAdaptationRatios(s);
    expect(r.signals.hrAtPower).toBeNull();
  });
});

describe('Pa:Hr decoupling signal', () => {
  it('decoupling shrinking week-over-week → positive adjustment', () => {
    const s = emptyState();
    s.w = 6;
    const wks: any[] = [];
    for (let w = 0; w < 6; w++) {
      const wk: any = { garminActuals: {} };
      wk.garminActuals[`r${w}`] = {
        garminId: `r${w}`,
        distanceKm: 15,
        durationSec: 3600,
        avgPaceSecKm: 240,
        avgHR: 150,
        maxHR: null,
        calories: null,
        activityType: 'RUNNING',
        hrDrift: 10 - w,  // 10% → 5% over 6 weeks
      };
      wks.push(wk);
    }
    s.wks = wks;
    const r = computeTriAdaptationRatios(s);
    expect(r.signals.pahrRun).not.toBeNull();
    expect(r.signals.pahrRun!).toBeGreaterThan(0);
    expect(r.run).toBeGreaterThan(1.0);
  });

  it('real EF decoupling from kmSplits + kmHRSplits is preferred over hrDrift', () => {
    const s = emptyState();
    s.w = 6;
    const wks: any[] = [];
    // EF decoupling shrinks 8% → 2% over the window, while hrDrift is flat at
    // 20%. If EF is used, slope is negative (improving) and adjustment > 0.
    // If hrDrift were used, slope would be ~0 and adjustment ~0.
    for (let w = 0; w < 6; w++) {
      const wk: any = { garminActuals: {} };
      // Build 10-km run (50 min, above 45-min filter) with pace constant at
      // 300 s/km but HR rising in the 2nd half by `(8 - w)`%. Gives an EF
      // decoupling close to `(8 - w)`%.
      const kmSplits = Array(10).fill(300);
      const baseHr = 150;
      const liftPct = (8 - w) / 100;  // 8% → 3%
      const liftedHr = Math.round(baseHr * (1 + liftPct));
      const kmHRSplits = [
        baseHr, baseHr, baseHr, baseHr, baseHr,
        liftedHr, liftedHr, liftedHr, liftedHr, liftedHr,
      ];
      wk.garminActuals[`r${w}`] = {
        garminId: `r${w}`,
        distanceKm: 10,
        durationSec: 10 * 300,
        avgPaceSecKm: 300,
        avgHR: 158,
        maxHR: null,
        calories: null,
        activityType: 'RUNNING',
        hrDrift: 20,  // flat. Would give ~0 slope if used
        kmSplits,
        kmHRSplits,
      };
      wks.push(wk);
    }
    s.wks = wks;
    const r = computeTriAdaptationRatios(s);
    expect(r.signals.pahrRun).not.toBeNull();
    expect(r.signals.pahrRun!).toBeGreaterThan(0);
  });

  it('falls back to hrDrift when kmHRSplits is missing', () => {
    const s = emptyState();
    s.w = 6;
    const wks: any[] = [];
    // Same shape as the canonical test but without kmHRSplits. Must still
    // produce a positive signal via the hrDrift fallback.
    for (let w = 0; w < 6; w++) {
      const wk: any = { garminActuals: {} };
      wk.garminActuals[`r${w}`] = {
        garminId: `r${w}`,
        distanceKm: 15,
        durationSec: 3600,
        avgPaceSecKm: 240,
        avgHR: 150,
        maxHR: null,
        calories: null,
        activityType: 'RUNNING',
        hrDrift: 10 - w,
        kmSplits: [240, 240, 240, 240, 240, 240, 240, 240],
        // kmHRSplits intentionally absent
      };
      wks.push(wk);
    }
    s.wks = wks;
    const r = computeTriAdaptationRatios(s);
    expect(r.signals.pahrRun).not.toBeNull();
    expect(r.signals.pahrRun!).toBeGreaterThan(0);
  });
});

describe('efDecouplingPct helper', () => {
  it('returns null for fewer than 4 valid kms', () => {
    expect(efDecouplingPct([300, 300, 300], [150, 150, 150])).toBeNull();
    expect(efDecouplingPct(null, null)).toBeNull();
    expect(efDecouplingPct([300, 300, 300, 300], [150, 0, 150, 150])).toBeNull();
  });

  it('flat HR + flat pace → ~0% decoupling', () => {
    const result = efDecouplingPct(
      [300, 300, 300, 300, 300, 300, 300, 300],
      [150, 150, 150, 150, 150, 150, 150, 150],
    );
    expect(result).not.toBeNull();
    expect(Math.abs(result!)).toBeLessThan(0.01);
  });

  it('HR rises in second half → positive decoupling', () => {
    // EF_1st ≈ (1/300)/150, EF_2nd ≈ (1/300)/165. Drops ~9.1%.
    const result = efDecouplingPct(
      [300, 300, 300, 300, 300, 300, 300, 300],
      [150, 150, 150, 150, 165, 165, 165, 165],
    );
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(8);
    expect(result!).toBeLessThan(10);
  });

  it('pace slows in second half at same HR → positive decoupling', () => {
    // EF_1st = (1/300)/150, EF_2nd = (1/330)/150 → drops ~9.1%.
    const result = efDecouplingPct(
      [300, 300, 300, 300, 330, 330, 330, 330],
      [150, 150, 150, 150, 150, 150, 150, 150],
    );
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(8);
    expect(result!).toBeLessThan(10);
  });

  it('mismatched array lengths use the shorter', () => {
    // 6 kmSplits, 4 kmHRSplits → only 4 paired kms, half-split = 2 + 2.
    // First half EF ≈ (1/300)/150, second half EF ≈ (1/300)/165 → ~9% drop.
    const r = efDecouplingPct(
      [300, 300, 300, 300, 999, 999],
      [150, 150, 165, 165],
    );
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(8);
    expect(r!).toBeLessThan(10);
  });
});

describe('clamp to [0.70, 1.30]', () => {
  it('extreme positive signals do not exceed 1.30', () => {
    const s = emptyState();
    s.w = 6;
    s.triConfig!.bike = { ftp: 250 };
    // Maxed-out HRV and HR-at-power signals.
    const today = new Date();
    const hist: SimulatorState['physiologyHistory'] = [];
    for (let i = 28; i >= 8; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      hist.push({ date: d.toISOString().split('T')[0], hrvRmssd: 30 });
    }
    for (let i = 7; i >= 1; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      hist.push({ date: d.toISOString().split('T')[0], hrvRmssd: 100 });
    }
    s.physiologyHistory = hist;
    const wks: any[] = [];
    for (let w = 0; w < 6; w++) {
      const wk: any = { garminActuals: {}, rated: {}, triWorkouts: [] };
      wk.garminActuals[`b${w}`] = {
        garminId: `b${w}`, distanceKm: 40, durationSec: 3600,
        avgPaceSecKm: null, avgHR: 180 - w * 10,  // huge drop
        maxHR: null, calories: null, activityType: 'CYCLING',
        averageWatts: 220,
      };
      wks.push(wk);
    }
    s.wks = wks;
    const r = computeTriAdaptationRatios(s);
    expect(r.bike).toBeLessThanOrEqual(ADAPT_RATIO_MAX);
    expect(r.bike).toBeGreaterThanOrEqual(ADAPT_RATIO_MIN);
  });
});

describe('current week is wks[s.w - 1], not next week', () => {
  // s.w is 1-based (store default w: 1; tri and cycling init set s.w = 1).
  // Every signal used to start its walk at wks[s.w], next week. Each test
  // plants contradicting data in next week's slot: it must not move the signal.

  function tempoRide(id: string, avgHR: number) {
    return {
      garminId: id, distanceKm: 40, durationSec: 3600, avgPaceSecKm: null,
      avgHR, maxHR: null, calories: null, activityType: 'CYCLING', averageWatts: 220,
    };
  }

  function longRun(id: string, hrDrift: number) {
    return {
      garminId: id, distanceKm: 15, durationSec: 3600, avgPaceSecKm: 240,
      avgHR: 150, maxHR: null, calories: null, activityType: 'RUNNING', hrDrift,
    };
  }

  it('HR-at-power ignores a ride stored in next week', () => {
    const build = (withNextWeek: boolean) => {
      const s = emptyState();
      s.w = 3; // current week = wks[2]
      s.triConfig!.bike = { ftp: 250 };
      const wks: any[] = [158, 156, 154].map((hr, i) => ({ garminActuals: { [`b${i}`]: tempoRide(`b${i}`, hr) } }));
      if (withNextWeek) wks.push({ garminActuals: { b3: tempoRide('b3', 190) } });
      s.wks = wks;
      return computeTriAdaptationRatios(s).signals.hrAtPower;
    };
    const clean = build(false);
    expect(clean).not.toBeNull();
    expect(clean!).toBeGreaterThan(0);
    expect(build(true)).toBe(clean);
  });

  it('Pa:Hr decoupling ignores a run stored in next week', () => {
    const build = (withNextWeek: boolean) => {
      const s = emptyState();
      s.w = 3;
      const wks: any[] = [10, 9, 8].map((drift, i) => ({ garminActuals: { [`r${i}`]: longRun(`r${i}`, drift) } }));
      if (withNextWeek) wks.push({ garminActuals: { r3: longRun('r3', 20) } });
      s.wks = wks;
      return computeTriAdaptationRatios(s).signals.pahrRun;
    };
    const clean = build(false);
    expect(clean).not.toBeNull();
    expect(clean!).toBeGreaterThan(0);
    expect(build(true)).toBe(clean);
  });

  it('CSS pace SD ignores a threshold swim stored in next week', () => {
    const swimWeek = (id: string, kmSplits: number[]) => ({
      triWorkouts: [{ id, t: 'swim_threshold', n: 'Threshold swim', d: '45min', r: 7, discipline: 'swim' }],
      garminActuals: { [id]: { garminId: id, durationSec: 2700, activityType: 'SWIMMING', kmSplits } },
    });
    const build = (withNextWeek: boolean) => {
      const s = emptyState();
      s.w = 3;
      const wks: any[] = [
        swimWeek('s0', [90, 100, 110]),
        swimWeek('s1', [95, 100, 105]),
        swimWeek('s2', [98, 100, 102]),
      ];
      if (withNextWeek) wks.push(swimWeek('s3', [70, 100, 130]));
      s.wks = wks;
      return computeTriAdaptationRatios(s).signals.cssSd;
    };
    const clean = build(false);
    expect(clean).not.toBeNull();
    expect(clean!).toBeGreaterThan(0);
    expect(build(true)).toBe(clean);
  });

  it('RPE-vs-expected ignores ratings stored in next week', () => {
    const ratedWeek = (prefix: string, actual: number) => ({
      triWorkouts: [
        { id: `${prefix}a`, t: 'easy', r: 7, rpe: 7, discipline: 'run' },
        { id: `${prefix}b`, t: 'threshold', r: 7, rpe: 7, discipline: 'run' },
      ],
      rated: { [`${prefix}a`]: actual, [`${prefix}b`]: actual },
    });
    const build = (withNextWeek: boolean) => {
      const s = emptyState();
      s.w = 1; // current week = wks[0]
      const wks: any[] = [ratedWeek('r0', 5)];
      if (withNextWeek) wks.push(ratedWeek('r1', 9));
      s.wks = wks;
      return computeTriAdaptationRatios(s).signals.rpeRun;
    };
    const clean = build(false);
    expect(clean).not.toBeNull();
    expect(clean!).toBeGreaterThan(0);
    expect(build(true)).toBe(clean);
  });

  it('the HR-at-power window is 8 plan weeks ending at the current week', () => {
    const signalAt = (w: number) => {
      const s = emptyState();
      s.w = w;
      s.triConfig!.bike = { ftp: 250 };
      const wks: any[] = Array.from({ length: w }, () => ({ garminActuals: {} }));
      // Tempo rides in wks[1..3] only.
      [158, 156, 154].forEach((hr, i) => { wks[i + 1].garminActuals[`b${i}`] = tempoRide(`b${i}`, hr); });
      s.wks = wks;
      return computeTriAdaptationRatios(s).signals.hrAtPower;
    };
    // w: 9 → current wks[8], window wks[1..8]: all three ride weeks.
    expect(signalAt(9)).not.toBeNull();
    // w: 10 → window wks[2..9]: wks[1] has left it, two points are too few.
    expect(signalAt(10)).toBeNull();
  });
});

describe('current week at the plan edges (week 1 and the last week)', () => {
  const ratedWeek = (prefix: string, actual: number) => ({
    triWorkouts: [
      { id: `${prefix}a`, t: 'easy', r: 7, rpe: 7, discipline: 'run' },
      { id: `${prefix}b`, t: 'threshold', r: 7, rpe: 7, discipline: 'run' },
    ],
    rated: { [`${prefix}a`]: actual, [`${prefix}b`]: actual },
  });

  it('week 1: ratings in the week in progress (wks[0]) are read', () => {
    const s = emptyState();
    s.w = 1;
    s.wks = [ratedWeek('r0', 5), {}, {}] as any;
    expect(computeTriAdaptationRatios(s).signals.rpeRun).not.toBeNull();
  });

  it('last week: ratings in the final plan week are read and nothing past it is', () => {
    const s = emptyState();
    s.w = 4; // current week = wks[3], the last
    s.wks = [{}, {}, {}, ratedWeek('r3', 5)] as any;
    const last = computeTriAdaptationRatios(s).signals.rpeRun;
    expect(last).not.toBeNull();
    // The same ratings one week earlier (mid-plan, w: 3) give the same signal.
    const mid = emptyState();
    mid.w = 3;
    mid.wks = [{}, {}, ratedWeek('r2', 5), {}] as any;
    expect(computeTriAdaptationRatios(mid).signals.rpeRun).toBe(last);
  });
});
