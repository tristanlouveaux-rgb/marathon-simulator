import { describe, it, expect } from 'vitest';
import {
  computePerDisciplineFitness,
  perDisciplineACWR,
  rebuildTriFitnessFromActivities,
} from './fitness-model.triathlon';

describe('Per-discipline fitness — transfer matrix application', () => {
  it('A pure run activity fans out to all three CTL tracks', () => {
    const fit = computePerDisciplineFitness([
      { sport: 'run', rawTSS: 100, dayIndex: 0 },
    ]);
    expect(fit.run.ctl).toBeGreaterThan(0);
    expect(fit.bike.ctl).toBeGreaterThan(0);   // transfer = 0.70
    expect(fit.swim.ctl).toBeGreaterThan(0);   // transfer = 0.25
    // Run CTL should be highest (1.00 multiplier)
    expect(fit.run.ctl).toBeGreaterThan(fit.bike.ctl);
    expect(fit.bike.ctl).toBeGreaterThan(fit.swim.ctl);
  });

  it('Padel contributes 35% to run, 20% to bike, 0% to swim', () => {
    const fit = computePerDisciplineFitness([
      { sport: 'padel', rawTSS: 100, dayIndex: 0 },
    ]);
    expect(fit.run.ctl).toBeGreaterThan(0);
    expect(fit.bike.ctl).toBeGreaterThan(0);
    expect(fit.swim.ctl).toBe(0);              // padel → swim transfer is 0
  });

  it('Combined CTL is raw EMA across ALL activities (no transfer weighting)', () => {
    // §8 feedback: combined CTL is full fatigue — every activity counts at 1.0
    // regardless of sport, so padel/gym/hiking contribute at full weight too.
    const fit = computePerDisciplineFitness([
      { sport: 'run',   rawTSS: 100, dayIndex: 0 },
      { sport: 'padel', rawTSS: 100, dayIndex: 0 },
    ]);
    // Run CTL < 200 (only gets 1.0 from run + 0.35 from padel)
    // Combined CTL reflects the full 200 raw TSS
    expect(fit.combinedCtl).toBeGreaterThan(fit.run.ctl);
  });

  it('Combined CTL includes contributions from non-discipline sports', () => {
    const justPadel = computePerDisciplineFitness([
      { sport: 'padel', rawTSS: 100, dayIndex: 0 },
    ]);
    // Swim CTL for padel is 0 via transfer matrix, but combined still rises
    expect(justPadel.swim.ctl).toBe(0);
    expect(justPadel.combinedCtl).toBeGreaterThan(0);
  });

  it('Older activities decay: 21 days ago contributes less than today', () => {
    const todayOnly = computePerDisciplineFitness([
      { sport: 'run', rawTSS: 100, dayIndex: 0 },
    ]);
    const threeWeeksAgoOnly = computePerDisciplineFitness([
      { sport: 'run', rawTSS: 100, dayIndex: 21 },
    ]);
    // Both contribute to CTL because CTL is 42-day EMA, but today's is larger
    expect(todayOnly.run.ctl).toBeGreaterThan(threeWeeksAgoOnly.run.ctl);
  });

  it('TSB = CTL - ATL', () => {
    const fit = computePerDisciplineFitness([
      { sport: 'run', rawTSS: 100, dayIndex: 0 },
      { sport: 'run', rawTSS: 100, dayIndex: 14 },
    ]);
    expect(fit.run.tsb).toBeCloseTo(fit.run.ctl - fit.run.atl, 1);
  });
});

describe('perDisciplineACWR', () => {
  it('returns ATL/CTL ratio when CTL is meaningful', () => {
    expect(perDisciplineACWR({ ctl: 60, atl: 72, tsb: -12 })).toBe(1.2);
    expect(perDisciplineACWR({ ctl: 50, atl: 40, tsb: 10 })).toBe(0.8);
  });

  it('returns undefined when CTL is too small', () => {
    expect(perDisciplineACWR({ ctl: 5, atl: 6, tsb: -1 })).toBeUndefined();
  });
});

describe('rebuildTriFitnessFromActivities', () => {
  it('walks activities and returns a fresh fitness snapshot', () => {
    const today = '2026-04-24';
    const fit = rebuildTriFitnessFromActivities([
      { sport: 'bike', rawTSS: 80, dateISO: '2026-04-24' },
      { sport: 'run',  rawTSS: 60, dateISO: '2026-04-23' },
      { sport: 'swim', rawTSS: 45, dateISO: '2026-04-22' },
    ], today);

    expect(fit.swim.ctl).toBeGreaterThan(0);
    expect(fit.bike.ctl).toBeGreaterThan(0);
    expect(fit.run.ctl).toBeGreaterThan(0);
    expect(fit.combinedCtl).toBeGreaterThan(0);
  });

  it('ignores activities beyond the 120-day window', () => {
    const today = '2026-04-24';
    const fit = rebuildTriFitnessFromActivities([
      { sport: 'run', rawTSS: 100, dateISO: '2025-01-01' },  // way old
    ], today);
    expect(fit.run.ctl).toBe(0);
  });

  it('ignores activities with zero TSS', () => {
    const today = '2026-04-24';
    const fit = rebuildTriFitnessFromActivities([
      { sport: 'run', rawTSS: 0, dateISO: '2026-04-24' },
    ], today);
    expect(fit.run.ctl).toBe(0);
  });
});
