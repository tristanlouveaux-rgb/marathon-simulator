/**
 * One easy-pace source for tri run pace tokens.
 *
 * Regression (review of the a2 fixes): an accepted suggestion that changed a tri
 * run's type retargeted its rep paces from gp(s.v, s.lt).e when a VDOT was set
 * but from the live pace table (s.pac, built from effective VDOT) when not,
 * while the generator wrote the session from the run skill estimate in that
 * case. So the same session stepped to the same type showed rep paces from a
 * different anchor than the paces already in its description.
 * triRunEasyPaceSec is now the one source, pinned here against generated runs.
 */
import { describe, it, expect } from 'vitest';
import { triRunEasyPaceSec } from './tri-run-pace';
import { generateTriathlonPlan } from './plan_engine.triathlon';
import { retargetDescriptionPace } from './workout-scaling';
import { applyTriSuggestions } from '@/calculations/tri-suggestion-apply';
import type { TriSuggestionMod } from '@/calculations/tri-suggestion-aggregator';
import { getDefaultState } from '@/state/store';
import type { SimulatorState, Workout } from '@/types/state';

function plan(opts: { v?: number; runSkill?: number }): SimulatorState {
  const s = {
    ...getDefaultState(),
    eventType: 'triathlon',
    w: 1,
    tw: 20,
    v: opts.v,
    // A live pace table that disagrees with the generator's anchor, as it does
    // whenever effective VDOT differs from s.v.
    pac: { e: 320, t: 270, i: 250, m: 295, r: 220 },
    wks: [],
    triConfig: {
      distance: '70.3',
      timeAvailableHoursPerWeek: 12,
      volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: opts.runSkill ?? 3 },
      bike: { hasPowerMeter: true, ftp: 220 },
      swim: { cssSecPer100m: 100 },
      weeksToRace: 20,
    },
  } as unknown as SimulatorState;
  s.wks = generateTriathlonPlan(s);
  return s;
}

const firstRun = (s: SimulatorState, t: string): Workout =>
  s.wks.flatMap(wk => wk.triWorkouts ?? []).find(w => w.discipline === 'run' && w.t === t)!;

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}/km`;

describe('triRunEasyPaceSec', () => {
  for (const [label, opts] of [
    ['VDOT 50', { v: 50 }],
    ['no VDOT, run skill 3', { runSkill: 3 }],
    ['no VDOT, run skill 5', { runSkill: 5 }],
  ] as const) {
    it(`is the easy pace generated easy runs are written at (${label})`, () => {
      const s = plan(opts);
      expect(firstRun(s, 'easy').d).toContain(`@ ${fmt(triRunEasyPaceSec(s))}`);
    });
  }
});

describe('an accepted run downgrade retargets from the generator easy pace', () => {
  const downgrade = (w: Workout): TriSuggestionMod => ({
    id: `readiness_${w.id}`, source: 'readiness', discipline: 'run',
    headline: 'h', body: 'b', severity: 'caution', targetWorkoutId: w.id, action: 'downgrade_today',
  });

  for (const [label, opts] of [
    ['VDOT 50', { v: 50 }],
    ['no VDOT', { runSkill: 3 }],
  ] as const) {
    it(`threshold -> marathon pace, reps at the generator anchor, not s.pac (${label})`, () => {
      const s = plan(opts);
      const w = firstRun(s, 'threshold');
      const genDesc = w.d!;
      applyTriSuggestions(s, [downgrade(w)]);
      expect(w.t).toBe('marathon_pace');
      const anchor = triRunEasyPaceSec(s);
      expect(anchor).not.toBe(s.pac!.e);
      expect(w.d).toBe(retargetDescriptionPace(genDesc, 'marathon_pace', anchor));
      expect(w.d).not.toBe(retargetDescriptionPace(genDesc, 'marathon_pace', s.pac!.e));
      // The warm-up keeps the easy pace the generator wrote.
      expect(w.d).toContain(`warm up @ ${fmt(anchor)}`);
    });
  }
});
