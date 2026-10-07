import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { generateWeekWorkouts, initializeWeeks } from './generator';
import { raceWeekLayout, planTrainingWeeks } from './race-week-layout';
import { isQualityRun, applyRaceDayRules, PRIMER_MIN_DAYS_OUT, PRIMER_MAX_DAYS_OUT } from './race-day-rules';
import { planWeekSessions } from './plan_engine';
import { intentToWorkout } from './intent_to_workout';
import { assignDefaultDays } from './scheduler';
import { isLongRun } from './long-run';
import { addCalendarDays } from '@/utils/local-date';
import { updateState, resetState, getState } from '@/state';
import { debriefPreviewPlanInputs } from '@/ui/week-debrief';
import type { RaceDistance, SimulatorState, Workout, Week } from '@/types';

/**
 * Race-day placement through the REAL generateWeekWorkouts, for every race
 * weekday, 3 to 7 runs a week, with a gym session, a commute and a recurring
 * cross-training activity configured (M4 design v4, 4.7; review checklist 4):
 *   C1 nothing of any kind on or after race day;
 *   C2 no long run in the 6 days before race day;
 *   C3 exactly one primer, 3 to 5 days out;
 *   C4 no quality session other than the primer in the last 6 days, and no two
 *      hard sessions on consecutive days in the last 13 (within a week);
 *   a closing week (Monday to Wednesday race) holds nothing.
 */

const START = '2026-10-05'; // plan week 1 Monday
const NON_RUN = new Set(['cross', 'gym', 'strength', 'rest']);

function setupPlan(raceISO: string | null, rd: RaceDistance, runs: number, weeksIfNoRace?: number): { tw: number; train: number; R: number | null } {
  const layout = raceISO ? raceWeekLayout(START, raceISO)! : null;
  const train = layout ? layout.trainingWeeks : weeksIfNoRace!;
  const tw = layout ? layout.calendarWeeks : weeksIfNoRace!;
  const wks: Week[] = initializeWeeks(train, { raceDistance: rd });
  if (layout?.closingWeek) {
    wks.push({ w: wks.length + 1, ph: 'taper', raceClosing: true, rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0 } as Week);
  }
  updateState({
    rw: runs, rd, typ: 'Balanced', tw, v: 45, gs: 1, w: 1, wks,
    pac: { e: 330, t: 280, i: 255, m: 300, r: 240 },
    continuousMode: false, eventType: 'running', detectedWeeklyKm: 40,
    athleteArchetype: { archetype: 'consistent-runner' },
    onboarding: { experienceLevel: 'intermediate', customRaceDate: raceISO },
    planStartDate: START, planCreatedAt: START,
    sharpenBlock: train < (rd === 'marathon' ? 8 : 4)
      ? { v: 1, startLongMin: 100, startSource: 'history-30d', recentLongestMin: 100, noSignal: false, trainingWeeks: train, builtISO: START }
      : undefined,
  } as unknown as SimulatorState);
  return { tw, train, R: layout ? layout.raceDayIndex : null };
}

function gen(k: number, runs: number, rd: RaceDistance): Workout[] {
  const s = getState();
  return generateWeekWorkouts(
    s.wks[k - 1].ph, runs, rd, 'Balanced', [],
    { enabled: true, distanceKm: 5, isBidirectional: false, commuteDaysPerWeek: 2 },
    null, [{ sport: 'cycling', durationMin: 45, frequency: 1, intensity: 'easy' }],
    'intermediate', undefined, 330, k, s.tw, 45, 1,
  );
}

const planDay = (k: number, w: Workout) => (k - 1) * 7 + (w.dayOfWeek ?? 0);

describe('race-day rules through generateWeekWorkouts', () => {
  beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterAll(() => vi.restoreAllMocks());
  afterEach(() => resetState());

  // Race days in plan week 7 (block) and week 12 (full plan), Monday to Sunday.
  for (const [label, rd, firstRaceDay] of [
    ['marathon block', 'marathon', addCalendarDays(START, 42)],
    ['marathon full plan', 'marathon', addCalendarDays(START, 77)],
    ['half block', 'half', addCalendarDays(START, 14)],
  ] as Array<[string, RaceDistance, string]>) {
    for (let dow = 0; dow < 7; dow++) {
      const race = addCalendarDays(firstRaceDay, dow);
      for (const runs of [3, 4, 5, 6, 7]) {
        it(`${label}, race ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dow]} ${race}, ${runs} runs`, () => {
          const { tw, train, R } = setupPlan(race, rd, runs);
          const bad: string[] = [];
          let primers: Workout[] = [];
          for (let k = Math.max(1, train - 1); k <= tw; k++) {
            const ws = gen(k, runs, rd);
            if (k > train) {
              if (ws.length) bad.push(`closing week holds ${ws.map(w => w.n).join(', ')}`);
              continue;
            }
            for (const w of ws) {
              const out = R! - planDay(k, w);
              if (out <= 0) bad.push(`C1 wk${k} ${w.n} ${out} days out`);
              if (NON_RUN.has(w.t) || w.commute) continue;
              if (isLongRun(w) && out < 7) bad.push(`C2 wk${k} ${w.n} ${out} days out`);
              if (isQualityRun(w)) {
                if (k === train) primers.push(w);
                else if (out <= 6) bad.push(`C4 wk${k} ${w.n} ${out} days out`);
              }
            }
            // No back-to-back hard days in the last 13 (within the week).
            const hardDays = ws.filter(w => !NON_RUN.has(w.t) && !w.commute && (isLongRun(w) || isQualityRun(w)))
              .filter(w => R! - planDay(k, w) <= 13).map(w => w.dayOfWeek!).sort();
            for (let i = 1; i < hardDays.length; i++) if (hardDays[i] - hardDays[i - 1] <= 1) bad.push(`C4 wk${k} hard days ${hardDays}`);
          }
          expect(primers, 'C3 one primer').toHaveLength(1);
          const out = R! - planDay(train, primers[0]);
          expect(out, 'C3 primer 3 to 5 days out').toBeGreaterThanOrEqual(PRIMER_MIN_DAYS_OUT);
          expect(out).toBeLessThanOrEqual(PRIMER_MAX_DAYS_OUT);
          expect(bad).toEqual([]);
        });
      }
    }
  }

  it('a Sunday race keeps today\'s running week; only a session dated on race day itself goes', () => {
    for (const runs of [3, 4, 5, 6]) {
      const race = addCalendarDays(START, 83); // Sunday of week 12
      setupPlan(race, 'marathon', runs);
      const withRace = [11, 12].map(k => gen(k, runs, 'marathon'));
      resetState();
      setupPlan(null, 'marathon', runs, 12);
      const without = [11, 12].map(k => gen(k, runs, 'marathon'));
      const key = (ws: Workout[]) => ws.filter(w => !NON_RUN.has(w.t)).map(w => `${w.n}@${w.dayOfWeek}`);
      // Week 11 unchanged; race week loses only what the scheduler put on Sunday (race day).
      expect(key(withRace[0])).toEqual(key(without[0]));
      expect(key(withRace[1])).toEqual(key(without[1].filter(w => w.dayOfWeek !== 6)));
      // Race day (Sunday of week 12) holds nothing, cross-training included.
      expect(withRace[1].filter(w => w.dayOfWeek === 6)).toEqual([]);
    }
  });

  it('a race 2 days out (week 1): no primer, nothing on or after race day', () => {
    const { R } = setupPlan(addCalendarDays(START, 2), 'half', 4); // Wednesday, onboarding Monday
    const ws = gen(1, 4, 'half');
    expect(ws.filter(isQualityRun)).toHaveLength(0);
    for (const w of ws) expect(planDay(1, w)).toBeLessThan(R!);
  });
});

describe('week-debrief preview parity: race week lists exactly the generated sessions', () => {
  afterEach(() => resetState());
  for (let dow = 0; dow < 7; dow++) {
    it(`race ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dow]}`, () => {
      const race = addCalendarDays(START, 42 + dow);
      const { train } = setupPlan(race, 'marathon', 4);
      const s = getState();
      // The preview of race week (shown in the debrief of the week before it).
      const { baseCtx } = debriefPreviewPlanInputs(s, train - 1, 'review');
      const preview = applyRaceDayRules(
        assignDefaultDays(planWeekSessions(baseCtx).map(i => intentToWorkout(i, 'marathon', 'Balanced', 330))),
        { weekIndex: train, layout: raceWeekLayout(START, race)! },
      ).map(w => `${w.t}:${w.estimatedDurationMin}`).sort();
      const generated = generateWeekWorkouts(
        s.wks[train - 1].ph, 4, 'marathon', 'Balanced', [], undefined, null, undefined, 'intermediate',
        undefined, 330, train, s.tw, 45, 0,
      ).filter(w => !NON_RUN.has(w.t)).map(w => `${w.t}:${w.estimatedDurationMin}`).sort();
      expect(preview).toEqual(generated);
      expect(planTrainingWeeks(s)).toBe(train);
    });
  }
});
