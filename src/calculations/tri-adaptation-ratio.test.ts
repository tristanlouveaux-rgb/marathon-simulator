/**
 * Tests for `computeTriAdaptationRatios` — the per-discipline live adaptation
 * ratio that scales the horizon adjuster's projected gain.
 */

import { describe, it, expect } from 'vitest';
import { computeTriAdaptationRatios } from './tri-adaptation-ratio';
import {
  ADAPT_RATIO_MIN, ADAPT_RATIO_MAX,
  ADAPT_WEIGHTS_SWIM, ADAPT_WEIGHTS_BIKE, ADAPT_WEIGHTS_RUN,
} from '@/constants/triathlon-adaptation-params';
import type { SimulatorState } from '@/types/state';

function emptyState(): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 0,
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
