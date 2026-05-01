import { describe, it, expect } from 'vitest';
import { computeTriDisciplineConfidence } from './tri-discipline-confidence';
import type { SimulatorState } from '@/types/state';

function state(currentWeek: number, weeks: any[]): SimulatorState {
  return {
    eventType: 'triathlon',
    w: currentWeek,
    wks: weeks,
    triConfig: { distance: 'ironman' },
  } as unknown as SimulatorState;
}

describe('computeTriDisciplineConfidence', () => {
  it('empty state → all disciplines none', () => {
    const r = computeTriDisciplineConfidence(state(0, []));
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
    const r = computeTriDisciplineConfidence(state(11, wks), 12);
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
      const r = computeTriDisciplineConfidence(state(11, wks), 12);
      expect(r.bike.confidence, `weeks=${c.weeks}`).toBe(c.expected);
    }
  });
});
