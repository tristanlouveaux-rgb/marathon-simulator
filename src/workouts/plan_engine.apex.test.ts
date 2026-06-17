import { describe, it, expect } from 'vitest';
import { initializeWeeks, generateWeekWorkouts, calculateWorkoutLoad } from '@/workouts';
import type { RaceDistance } from '@/types';

/**
 * ISSUE-287 regression guard: the weekly LOAD apex must land in the PEAK phase.
 *
 * Before the fix, blind `(weekIndex - 1) % len` variant rotation scattered the
 * high-load workout variants (notably the `fast_finish` progressive long run)
 * across the plan, so the load apex could land in the BUILD phase — ahead of the
 * peak phase — especially in short plans with a single peak week. The coach-
 * contract chart then labelled a build week "Peak". Phase-aware variant selection
 * (peak draws the heaviest variants, base/deload the lightest) keeps the apex in
 * the peak phase. See plan_engine.ts `pickPhaseVariant`.
 */

function weeklyTss(rd: RaceDistance, tw: number): { tss: number[]; phases: string[] } {
  const wks = initializeWeeks(tw);
  const tss: number[] = [];
  const phases: string[] = [];
  for (let i = 0; i < wks.length; i++) {
    const ws = generateWeekWorkouts(
      wks[i].ph, 4, rd, 'Balanced', [], undefined, null, undefined, undefined,
      undefined, 360, i + 1, tw, 45, 0,
      undefined, undefined, undefined, undefined, undefined,
    );
    tss.push(ws.reduce((s, w) => s + calculateWorkoutLoad(w.t, w.d, (w.r ?? 5) * 10, 360).total, 0));
    phases.push(wks[i].ph);
  }
  return { tss, phases };
}

describe('ISSUE-287: load apex lands in the peak phase', () => {
  const distances: RaceDistance[] = ['10k', 'half', 'marathon'];
  const lengths = [9, 12, 16, 18];

  for (const rd of distances) {
    for (const tw of lengths) {
      it(`${rd} ${tw}wk peaks in the peak phase`, () => {
        const { tss, phases } = weeklyTss(rd, tw);
        const apexIdx = tss.indexOf(Math.max(...tss));
        expect(phases[apexIdx], `apex at wk${apexIdx + 1} was ${phases[apexIdx]}, tss=[${tss.map(Math.round)}]`).toBe('peak');
      });
    }
  }
});
