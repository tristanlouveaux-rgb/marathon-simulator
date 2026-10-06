import { describe, it, expect } from 'vitest';
import { loadForRung, loadForTriRun, TRI_RUN_LOAD_SHARES } from './rung-load';
import { loadForBike } from './bike';
import { loadForSwim } from './swim';
import { generateTriathlonPlan } from './plan_engine.triathlon';
import { LOAD_PROFILES, plannedTssPerMin } from '@/constants';
import type { SimulatorState } from '@/types/state';

describe('loadForRung', () => {
  it('prices bike and swim rungs with the generator helpers', () => {
    expect(loadForRung('bike_sweet_spot', 80)).toEqual(loadForBike('sweet_spot', 80));
    expect(loadForRung('swim_endurance', 45)).toEqual(loadForSwim('endurance', 45));
  });
  it('returns null for a non-rung key', () => {
    expect(loadForRung('threshold', 60)).toBeNull();
  });
});

describe('loadForTriRun', () => {
  it('total equals the canonical type-keyed rate x minutes', () => {
    for (const t of ['easy', 'long', 'threshold', 'vo2', 'marathon_pace', 'recovery']) {
      const l = loadForTriRun(t, 50)!;
      expect(l.aerobic + l.anaerobic).toBe(Math.round(50 * plannedTssPerMin(t)));
    }
  });
  it('types the tri generator never writes use the running load profile', () => {
    const l = loadForTriRun('marathon_pace', 60)!;
    const total = Math.round(60 * plannedTssPerMin('marathon_pace'));
    expect(l.aerobic).toBe(Math.round(total * LOAD_PROFILES.marathon_pace.aerobic));
  });
  it('returns null for an unknown type or no minutes', () => {
    expect(loadForTriRun('gym_circuit', 60)).toBeNull();
    expect(loadForTriRun('easy', 0)).toBeNull();
  });
});

describe('TRI_RUN_LOAD_SHARES pins the tri generator', () => {
  // The shares are copied from generateRunSessionForTri. Every generated run
  // leg of a tabled type must split its load with that share (within the
  // generator's per-component rounding), so the two cannot drift.
  it('matches the aerobic share of every generated run leg', () => {
    const checked = new Set<string>();
    for (const distance of ['sprint', '70.3', 'ironman'] as const) {
      const s = {
        eventType: 'triathlon', w: 1, tw: 20, v: 50, wks: [],
        triConfig: {
          distance, timeAvailableHoursPerWeek: 12,
          volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
          skillRating: { swim: 3, bike: 3, run: 3 },
          bike: { hasPowerMeter: true, ftp: 220 }, swim: { cssSecPer100m: 100 }, weeksToRace: 20,
        },
      } as unknown as SimulatorState;
      for (const wk of generateTriathlonPlan(s)) {
        for (const w of wk.triWorkouts ?? []) {
          if (w.discipline !== 'run') continue;
          const share = TRI_RUN_LOAD_SHARES[w.t];
          if (!share) continue;
          const total = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
          if (total < 20) continue; // rounding dominates tiny sessions
          expect(Math.abs((w.aerobic ?? 0) - total * share.aerobic)).toBeLessThanOrEqual(1);
          checked.add(w.t);
        }
      }
    }
    expect([...checked].sort()).toEqual(Object.keys(TRI_RUN_LOAD_SHARES).sort());
  });
});
