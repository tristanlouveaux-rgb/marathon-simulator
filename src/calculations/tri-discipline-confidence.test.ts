import { describe, it, expect } from 'vitest';
import { computeTriDisciplineConfidence } from './tri-discipline-confidence';
import type { SimulatorState } from '@/types/state';

// `w` follows the store convention: 1-based, current week at wks[w - 1].
function state(w: number, weeks: any[]): SimulatorState {
  return {
    eventType: 'triathlon',
    w,
    wks: weeks,
    triConfig: { distance: 'ironman' },
  } as unknown as SimulatorState;
}

describe('computeTriDisciplineConfidence', () => {
  it('empty state → all disciplines none', () => {
    const r = computeTriDisciplineConfidence(state(1, []));
    expect(r.swim.confidence).toBe('none');
    expect(r.bike.confidence).toBe('none');
    expect(r.run.confidence).toBe('none');
  });

  it('counts distinct active weeks per discipline', () => {
    const wks: any[] = [];
    for (let w = 0; w < 12; w++) {
      const wk: any = { garminActuals: {} };
      // bike active in 8 of 12 weeks (skip 4)
      if (w !== 2 && w !== 5 && w !== 7 && w !== 10) {
        wk.garminActuals[`b${w}a`] = { garminId: `b${w}a`, durationSec: 3600, activityType: 'CYCLING' };
        wk.garminActuals[`b${w}b`] = { garminId: `b${w}b`, durationSec: 3600, activityType: 'CYCLING' };
      }
      // run active in 4 of 12 weeks
      if (w === 1 || w === 4 || w === 8 || w === 11) {
        wk.garminActuals[`r${w}`] = { garminId: `r${w}`, durationSec: 3600, activityType: 'RUNNING' };
      }
      // swim active in 1 of 12 weeks
      if (w === 6) {
        wk.garminActuals[`s${w}`] = { garminId: `s${w}`, durationSec: 1800, activityType: 'SWIMMING' };
      }
      wks.push(wk);
    }
    const r = computeTriDisciplineConfidence(state(12, wks), 12);
    expect(r.bike.weeksActive).toBe(8);
    expect(r.bike.sessions).toBe(16);
    expect(r.bike.confidence).toBe('high');
    expect(r.run.weeksActive).toBe(4);
    expect(r.run.sessions).toBe(4);
    expect(r.run.confidence).toBe('medium');
    expect(r.swim.weeksActive).toBe(1);
    expect(r.swim.sessions).toBe(1);
    expect(r.swim.confidence).toBe('low');
  });

  it('confidence buckets: high≥6, medium≥3, low≥1, none=0', () => {
    const cases = [
      { weeks: 0, expected: 'none' },
      { weeks: 1, expected: 'low' },
      { weeks: 2, expected: 'low' },
      { weeks: 3, expected: 'medium' },
      { weeks: 5, expected: 'medium' },
      { weeks: 6, expected: 'high' },
      { weeks: 12, expected: 'high' },
    ] as const;
    for (const c of cases) {
      const wks: any[] = [];
      for (let w = 0; w < 12; w++) {
        const wk: any = { garminActuals: {} };
        if (w < c.weeks) {
          wk.garminActuals[`b${w}`] = { garminId: `b${w}`, durationSec: 3600, activityType: 'CYCLING' };
        }
        wks.push(wk);
      }
      const r = computeTriDisciplineConfidence(state(12, wks), 12);
      expect(r.bike.confidence, `weeks=${c.weeks}`).toBe(c.expected);
    }
  });

  it('the 12-week window ends at the current week, wks[s.w - 1]', () => {
    const ride = (id: string) => ({ garminId: id, durationSec: 3600, activityType: 'CYCLING' });
    const run = (id: string) => ({ garminId: id, durationSec: 3600, activityType: 'RUNNING' });
    const wks: any[] = Array.from({ length: 13 }, () => ({ garminActuals: {} }));
    wks[0].garminActuals.b0 = ride('b0');     // oldest week of the window
    wks[11].garminActuals.b11 = ride('b11');  // the current week
    wks[12].garminActuals.r12 = run('r12');   // next week: outside the window
    const r = computeTriDisciplineConfidence(state(12, wks), 12);
    expect(r.bike.weeksActive).toBe(2);
    expect(r.bike.sessions).toBe(2);
    expect(r.run.weeksActive).toBe(0);
    expect(r.run.sessions).toBe(0);
  });

  it('with fitnessHistory, session counts use the same 12-week window', () => {
    const ride = (id: string) => ({ garminId: id, durationSec: 3600, activityType: 'CYCLING' });
    const run = (id: string) => ({ garminId: id, durationSec: 3600, activityType: 'RUNNING' });
    const wks: any[] = Array.from({ length: 13 }, () => ({ garminActuals: {} }));
    wks[0].garminActuals.b0 = ride('b0');
    wks[12].garminActuals.r12 = run('r12');
    const s = state(12, wks);
    (s.triConfig as any).fitnessHistory = [{ swimCtl: 0, bikeCtl: 40, runCtl: 0 }];
    const r = computeTriDisciplineConfidence(s, 12);
    expect(r.bike.sessions).toBe(1);
    expect(r.run.sessions).toBe(0);
  });
});

describe('discipline confidence at the plan edges (week 1 and the last week)', () => {
  const ride = (id: string) => ({ garminId: id, durationSec: 3600, activityType: 'CYCLING' });

  it('week 1: the week in progress counts, next week does not', () => {
    const wks: any[] = Array.from({ length: 16 }, () => ({ garminActuals: {} }));
    wks[0].garminActuals.b0 = ride('b0');
    wks[1].garminActuals.b1 = ride('b1'); // next week
    const r = computeTriDisciplineConfidence(state(1, wks), 12);
    expect(r.bike.weeksActive).toBe(1);
    expect(r.bike.sessions).toBe(1);
  });

  it('last week: the final plan week counts and the window is the 12 weeks ending there', () => {
    const wks: any[] = Array.from({ length: 16 }, () => ({ garminActuals: {} }));
    wks[3].garminActuals.b3 = ride('b3');   // 13 weeks before the end: outside
    wks[4].garminActuals.b4 = ride('b4');   // oldest week of the window
    wks[15].garminActuals.b15 = ride('b15'); // the last week, in progress
    const r = computeTriDisciplineConfidence(state(16, wks), 12);
    expect(r.bike.weeksActive).toBe(2);
    expect(r.bike.sessions).toBe(2);
  });
});
