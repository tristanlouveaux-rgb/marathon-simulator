import { describe, it, expect, afterEach } from 'vitest';
import { initializeWeeks } from '@/workouts';
import { derivePlanShape } from '@/calculations/plan-shape';
import { updateState, resetState } from '@/state';
import type { SimulatorState } from '@/types';

/**
 * Continuous-mode "ramps in circles" regression guard.
 *
 * Endless/continuous plans repeat a Base→Build→Peak→Taper block via `i % 4`.
 * Before the fix the weekly load looped at the same low peak every cycle — no
 * progressive overload — because the geometric volume-budget ramp only engages
 * when a baseline + archetype are present, which a continuous user who hasn't
 * synced lacks. generator.ts now falls back to the plan's own starting volume
 * (`s.wkm`) + the neutral `'unknown'` archetype for continuous mode, so the ramp
 * climbs the per-cycle peak toward the readiness ceiling (Reilly/Gabbett slope).
 *
 * Note: at 2 runs/week a 10K plan's sessions are already at their physiological
 * caps (long run ~63 min, single quality session), so there is no room to add
 * volume and the climb is correctly negligible — progressive overload needs ≥3
 * sessions to express. This guard therefore asserts the climb at 3 and 4 runs.
 */
function continuousState(rw: number): SimulatorState {
  const tw = 16;
  const wks = initializeWeeks(tw);
  const blockPhases = ['base', 'build', 'peak', 'taper'] as const;
  for (let i = 0; i < wks.length; i++) wks[i].ph = blockPhases[i % 4];
  return {
    rw, rd: '10k', typ: 'balanced', tw, v: 45, gs: 0,
    pac: { e: 360 }, wks, continuousMode: true, wkm: rw * 6,
  } as unknown as SimulatorState;
}

describe('continuous mode: per-cycle peak climbs (no ramps-in-circles)', () => {
  afterEach(() => resetState());

  for (const rw of [3, 4]) {
    it(`rw=${rw}: each block's peak-phase week climbs toward the ceiling`, () => {
      const s = continuousState(rw);
      updateState(s);
      const shape = derivePlanShape(s);
      // Peak-phase week of each 4-week block (index 2, 6, 10, 14).
      const peaks = [2, 6, 10, 14].map(i => shape.weeklyTss[i]);
      // Monotonic non-decreasing (plateau at the ceiling is allowed)...
      for (let i = 1; i < peaks.length; i++) {
        expect(peaks[i], `cycle ${i + 1} peak ${peaks[i]} < cycle ${i} peak ${peaks[i - 1]} (peaks=${peaks})`)
          .toBeGreaterThanOrEqual(peaks[i - 1]);
      }
      // ...and the last cycle is meaningfully above the first (real overload, not a loop).
      expect(peaks[peaks.length - 1]).toBeGreaterThan(peaks[0]);
    });
  }
});
