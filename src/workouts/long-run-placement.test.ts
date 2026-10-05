import { describe, it, expect } from 'vitest';
import { initializeWeeks, generateWeekWorkouts, assignDefaultDays } from '@/workouts';
import { isLongRun } from './long-run';
import type { RaceDistance, Workout } from '@/types';

/**
 * Audit X5: the fast-finish long run ("Long Run (Fast Finish)", t:'progressive')
 * was scheduled into the quality pool on Tuesday, leaving the long-run day
 * (Sunday) without a long run in every fast-finish week. Every peak week is a
 * fast-finish week (pickPhaseVariant), so this hit the most important long runs
 * of the plan. The generator now stamps the long-run slot and the scheduler
 * places it via isLongRun.
 */

const FF_NAME = 'Long Run (Fast Finish)';

function planWeeks(rd: RaceDistance, rw: number, tw: number, fitness: string, vdot: number): Workout[][] {
  const wks = initializeWeeks(tw);
  return wks.map((wk, i) => generateWeekWorkouts(
    wk.ph, rw, rd, 'Balanced', [], undefined, null, undefined, fitness,
    undefined, 360, i + 1, tw, vdot, 0,
    undefined, undefined, undefined, undefined, undefined,
  ));
}

describe('fast-finish long run sits on the long-run day', () => {
  const distances: RaceDistance[] = ['marathon', 'half'];
  const runsPerWeek = [4, 5, 6];
  const profiles: Array<{ fitness: string; vdot: number }> = [
    { fitness: 'intermediate', vdot: 48 },
    { fitness: 'advanced', vdot: 58 },
  ];

  for (const rd of distances) {
    for (const rw of runsPerWeek) {
      for (const { fitness, vdot } of profiles) {
        it(`${rd} ${rw} runs/wk (${fitness}): every fast-finish week puts the run on the long-run day`, () => {
          const weeks = planWeeks(rd, rw, 16, fitness, vdot);

          // The long-run day is where the steady long run lands in ordinary weeks.
          const steadyDays = new Set(
            weeks.flat().filter(w => w.t === 'long').map(w => w.dayOfWeek),
          );
          expect([...steadyDays]).toEqual([6]);

          let ffWeeks = 0;
          weeks.forEach((ws, i) => {
            const ff = ws.filter(w => w.n === FF_NAME);
            if (ff.length === 0) return;
            ffWeeks++;
            expect(ff, `wk${i + 1}`).toHaveLength(1);
            // Title and format stay those of the fast-finish run.
            expect(ff[0].t).toBe('progressive');
            expect(ff[0].d).toMatch(/last \d+ @/);
            expect(ff[0].dayOfWeek, `wk${i + 1} fast finish on day ${ff[0].dayOfWeek}`).toBe(6);
          });
          // Peak weeks are always fast-finish weeks, so a 16-week plan has some.
          expect(ffWeeks).toBeGreaterThan(0);

          // Every week has exactly one long run, and it is on the long-run day.
          weeks.forEach((ws, i) => {
            const longs = ws.filter(isLongRun);
            expect(longs, `wk${i + 1}`).toHaveLength(1);
            expect(longs[0].dayOfWeek, `wk${i + 1}`).toBe(6);
          });
        });
      }
    }
  }
});

describe('scheduler long-run detection', () => {
  const week = (): Workout[] => [
    { t: 'easy', n: 'Easy Run', d: '8km', r: 3 },
    { t: 'progressive', n: FF_NAME, d: '24km: last 5 @ MP', r: 5, longRun: true },
    { t: 'marathon_pace', n: 'Marathon Pace', d: '30min @ MP', r: 6 },
    { t: 'easy', n: 'Easy Run', d: '8km', r: 3 },
  ];

  it('places a long-run-slot progressive on Sunday', () => {
    const ws = assignDefaultDays(week());
    expect(ws.find(w => w.n === FF_NAME)!.dayOfWeek).toBe(6);
    // The real quality session keeps the first quality day.
    expect(ws.find(w => w.t === 'marathon_pace')!.dayOfWeek).toBe(1);
  });

  it('keeps an ordinary progressive run (no long-run stamp) in the quality pool', () => {
    const ws = week();
    ws[1] = { t: 'progressive', n: 'Progressive Run', d: '10km: last 3 @ MP', r: 5 };
    ws.push({ t: 'long', n: 'Long Run', d: '22km', r: 3, longRun: true });
    const out = assignDefaultDays(ws);
    expect(out.find(w => w.n === 'Long Run')!.dayOfWeek).toBe(6);
    expect(out.find(w => w.n === 'Progressive Run')!.dayOfWeek).not.toBe(6);
  });
});

describe('isLongRun', () => {
  it('treats t:long as the long run with or without the stamp', () => {
    expect(isLongRun({ t: 'long' })).toBe(true);
    expect(isLongRun({ t: 'long', longRun: true })).toBe(true);
  });

  it('treats the stamped fast-finish run as the long run', () => {
    expect(isLongRun({ t: 'progressive', longRun: true })).toBe(true);
  });

  it('does not treat an unstamped progressive run as the long run', () => {
    expect(isLongRun({ t: 'progressive' })).toBe(false);
  });

  it('stops treating the slot as the long run once a mod rewrites its type, like t:long', () => {
    expect(isLongRun({ t: 'easy', longRun: true })).toBe(false);
    expect(isLongRun({ t: 'marathon', longRun: true })).toBe(false);
  });

  it('handles missing input', () => {
    expect(isLongRun(undefined)).toBe(false);
    expect(isLongRun(null)).toBe(false);
  });
});
