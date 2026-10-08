import { describe, it, expect } from 'vitest';
import { planWeekSessions, planEngineStateInputs, EASY_FLOOR_MIN, type PlanContext, type PlanWeekNotes } from './plan_engine';
import { computeRunningPlanPhases } from './phases';
import { budgetRunFitLine } from '@/ui/budget-run-fit-line';

/**
 * The engine reports why a week holds fewer runs than the runner chose
 * (PlanWeekNotes.budgetRunFit; Tristan 2026-10-08): only on a loaded week whose
 * weekly budget consolidated easy runs, never on a deload, taper or race week.
 * The Plan tab words it as one line (budget-run-fit-line.ts).
 */

type Ctx = Omit<PlanContext, 'weekIndex' | 'phase'>;

function weeks(ctx: Ctx) {
  const phases = computeRunningPlanPhases(ctx.totalWeeks, ctx.raceDistance).map(p => p.ph);
  return phases.map((phase, i) => {
    const notes: PlanWeekNotes = {};
    const xs = planWeekSessions({ ...ctx, planPhases: phases, weekIndex: i + 1, phase }, notes);
    return { k: i + 1, phase, runs: xs.length, fit: notes.budgetRunFit, label: `wk${i + 1} ${phase} [${xs.map(x => `${x.slot}:${x.totalMinutes}`).join(' ')}]` };
  });
}

// Marathon 7 weeks out, 4 runs a week, 15 km a week, longest run of the last 30
// days 60 min, 2-hour weekly target: build x3, a deload, peak, taper, race week.
const LOW: Ctx = {
  runsPerWeek: 4, raceDistance: 'marathon', runnerType: 'Balanced', fitnessLevel: 'intermediate',
  vdot: 45, easyPaceSecPerKm: 330, totalWeeks: 7, baselineKm: 15, archetype: 'consistent-runner',
  weeklyHoursTarget: 2, sharpening: { startLongMin: 60, startSource: 'history-30d' },
};

// Marathon 7 weeks out, 4 runs a week, 40 km a week, 3-hour target, longest run
// of the last 30 days 80 min. The live lever (effort score above 0, or a CTL
// ratio below 1) scales the block's budget below the 3-hour target.
const MID: Ctx = { ...LOW, baselineKm: 40, weeklyHoursTarget: 3, sharpening: { startLongMin: 80, startSource: 'history-30d' } };

// 12-week half, 5 runs, 40 km a week synced, consistent runner, 2.5-hour target.
// The target caps the plan's volume destination, and weeks 1 to 3 climb toward it.
const CAPPED_HALF: Ctx = {
  runsPerWeek: 5, raceDistance: 'half', runnerType: 'Balanced', fitnessLevel: 'intermediate',
  vdot: 45, easyPaceSecPerKm: 330, totalWeeks: 12, weeklyHoursTarget: 2.5, baselineKm: 40, archetype: 'consistent-runner',
};

/** Total running minutes of a week, read from its label. */
const total = (label: string) => [...label.matchAll(/:(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);

/** The line a fit words to. A week no single ceiling holds names neither the
 *  hours target nor the volume ramp. */
const lineOf = (fit: PlanWeekNotes['budgetRunFit']) => (fit ? budgetRunFitLine(fit, 'km') : '');
const NAMES_NO_CEILING = (fitted: number, chosen: number) => `This week's volume fits ${fitted} of your ${chosen} runs. Each stays at a useful length.`;

describe('sharpening block: 15 km a week, 60-min longest, 4 runs, 2-hour target', () => {
  const rows = weeks(LOW);

  it('every loaded week holds 2 of the 4 runs and says so; the 15 km volume binds, not the 2-hour target', () => {
    for (const r of rows.filter(r => [1, 2, 3, 5].includes(r.k))) {
      expect(r.runs, r.label).toBe(2);
      expect(r.fit, r.label).toEqual({ chosenRuns: 4, fittedRuns: 2, binding: 'volume', hoursTarget: 2, currentWeeklyKm: 15 });
    }
  });

  it('the deload week (week 4), the taper week and race week hold 2 runs too, with no note', () => {
    expect(rows.map(r => r.phase)).toEqual(['build', 'build', 'build', 'build', 'peak', 'taper', 'taper']);
    for (const k of [4, 6, 7]) {
      const r = rows[k - 1];
      expect(r.runs, r.label).toBe(2);
      expect(r.fit, r.label).toBeUndefined();
    }
  });

  it('a holiday week (forced deload) carries no note', () => {
    const phases = computeRunningPlanPhases(7, 'marathon').map(p => p.ph);
    const notes: PlanWeekNotes = {};
    planWeekSessions({ ...LOW, planPhases: phases, weekIndex: 2, phase: 'build', forceDeload: true }, notes);
    expect(notes.budgetRunFit).toBeUndefined();
  });
});

describe('normal weeks carry no note', () => {
  it('40 km a week, 100-min longest, 4 runs: every week of the block holds its runs', () => {
    const rows = weeks({ ...LOW, baselineKm: 40, weeklyHoursTarget: undefined, sharpening: { startLongMin: 100, startSource: 'history-30d' } });
    expect(rows[0].runs, rows[0].label).toBe(4);
    for (const r of rows) expect(r.fit, r.label).toBeUndefined();
  });

  it('a reused notes object is cleared by a week that holds every run', () => {
    const phases = computeRunningPlanPhases(7, 'marathon').map(p => p.ph);
    const notes: PlanWeekNotes = {};
    planWeekSessions({ ...LOW, planPhases: phases, weekIndex: 1, phase: 'build' }, notes);
    expect(notes.budgetRunFit).toBeDefined();
    planWeekSessions({ ...LOW, baselineKm: 40, weeklyHoursTarget: undefined, sharpening: { startLongMin: 100, startSource: 'history-30d' }, planPhases: phases, weekIndex: 1, phase: 'build' }, notes);
    expect(notes.budgetRunFit).toBeUndefined();
  });
});

describe('the binding ceiling', () => {
  it('block, 40 km, 100-min longest, 2-hour target: the target binds (long run 95 + one 25-min easy run)', () => {
    const rows = weeks({ ...LOW, baselineKm: 40, sharpening: { startLongMin: 100, startSource: 'history-30d' } });
    expect(rows[0].fit, rows[0].label).toEqual({ chosenRuns: 4, fittedRuns: 2, binding: 'hours', hoursTarget: 2, currentWeeklyKm: 40 });
    expect(rows[3].fit, rows[3].label).toBeUndefined(); // deload
  });

  it('full plan, 14 km a week, 16-week marathon: base weeks hold 3 of 4 runs from the volume ramp; deloads, taper and race week carry no note', () => {
    const rows = weeks({ ...LOW, totalWeeks: 16, baselineKm: 14, weeklyHoursTarget: undefined, sharpening: undefined });
    expect(rows[0].runs, rows[0].label).toBe(3);
    expect(rows[0].fit, rows[0].label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'volume', currentWeeklyKm: 14 });
    expect(rows[3].runs, rows[3].label).toBe(3);   // deload week 4
    expect(rows[3].fit, rows[3].label).toBeUndefined();
    for (const r of rows.filter(r => r.phase === 'taper')) expect(r.fit, r.label).toBeUndefined();
    for (const r of rows) if (r.runs >= 4) expect(r.fit, r.label).toBeUndefined();
  });

  it('full plan, no volume ramp, 2-hour target (12-week half): the target binds', () => {
    const rows = weeks({
      runsPerWeek: 4, raceDistance: 'half', runnerType: 'Balanced', fitnessLevel: 'intermediate',
      vdot: 45, easyPaceSecPerKm: 330, totalWeeks: 12, weeklyHoursTarget: 2,
    });
    expect(rows[0].fit, rows[0].label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'hours', hoursTarget: 2 });
    expect(rows[3].fit, rows[3].label).toBeUndefined();   // deload
    expect(rows[10].fit, rows[10].label).toBeUndefined(); // taper
    expect(rows[11].fit, rows[11].label).toBeUndefined(); // race week
  });

  it('full plan whose capped ramp is still climbing: the line names no ceiling until the week reaches the target', () => {
    // Weeks 1 to 3 total 111, 118 and 127 min under the 150-min target. The budget
    // is the target's capped destination scaled down, so the 40 km ramp does not
    // set the count: without the target the same weeks seat all 5 runs.
    const rows = weeks(CAPPED_HALF);
    const uncapped = weeks({ ...CAPPED_HALF, weeklyHoursTarget: undefined });
    for (const k of [1, 2, 3]) {
      const r = rows[k - 1];
      expect(r.runs, r.label).toBe(3);
      expect(r.fit, r.label).toEqual({ chosenRuns: 5, fittedRuns: 3, binding: 'volume', hoursTarget: 2.5 });
      expect(lineOf(r.fit), r.label).toBe(NAMES_NO_CEILING(3, 5));
      expect(uncapped[k - 1].runs, uncapped[k - 1].label).toBe(5);
      expect(uncapped[k - 1].fit, uncapped[k - 1].label).toBeUndefined();
    }
    expect(total(rows[0].label), rows[0].label).toBe(111);
    // Week 10 (peak) reaches the 150-min target with no room for another run: the target binds.
    expect(total(rows[9].label), rows[9].label).toBe(150);
    expect(rows[9].fit, rows[9].label).toEqual({ chosenRuns: 5, fittedRuns: 4, binding: 'hours', hoursTarget: 2.5, currentWeeklyKm: 40 });
  });
});

describe('the live effort/CTL lever in a sharpening block', () => {
  it('no lever: week 1 holds all 4 runs (180 min) and carries no note', () => {
    const r = weeks(MID)[0];
    expect(r.runs, r.label).toBe(4);
    expect(r.fit, r.label).toBeUndefined();
  });

  it('effort score 1.5: week 1 holds 3 runs; the 3-hour target fits 4, so the note names neither the target nor the ramp', () => {
    const r = weeks({ ...MID, effortScore: 1.5 })[0];
    expect(r.runs, r.label).toBe(3);
    expect(r.fit, r.label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'volume', hoursTarget: 3 });
    expect(lineOf(r.fit)).toBe(NAMES_NO_CEILING(3, 4));
  });

  it('CTL ratio 0.8: week 1 holds 3 runs and the note names no ceiling', () => {
    const r = weeks({ ...MID, ctlRatio: 0.8 })[0];
    expect(r.runs, r.label).toBe(3);
    expect(r.fit, r.label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'volume', hoursTarget: 3 });
    expect(lineOf(r.fit)).toBe(NAMES_NO_CEILING(3, 4));
  });

  it('a lever week whose run count the target alone sets keeps the note (week 2: 3 runs with or without the lever)', () => {
    const plain = weeks(MID)[1];
    const levered = weeks({ ...MID, effortScore: 1.5 })[1];
    expect(plain.runs, plain.label).toBe(3);
    expect(levered.runs, levered.label).toBe(3);
    // 166 min: one more run at the 25-min floor would pass the 180-min target.
    expect(total(levered.label), levered.label).toBe(166);
    expect(levered.fit, levered.label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'hours', hoursTarget: 3, currentWeeklyKm: 40 });
  });

  it('a lever week with room under the 3-hour target for another run names no ceiling (week 2 at 153 min)', () => {
    // Long 72, MP 42, easy 39: 153 + 25 = 178 min, so a 4th run at the easy floor fits within 3 h.
    for (const lever of [{ effortScore: 3 }, { ctlRatio: 0.7 }]) {
      const r = weeks({ ...MID, ...lever })[1];
      expect(r.runs, r.label).toBe(3);
      expect(total(r.label), r.label).toBe(153);
      expect(r.fit, r.label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'volume', hoursTarget: 3 });
      expect(lineOf(r.fit), r.label).toBe(NAMES_NO_CEILING(3, 4));
    }
  });

  it('beginner block 5 weeks out, 25 km, 2-hour target, 40-min longest, CTL ratio 0.7: week 3 (95 min) names no ceiling', () => {
    const r = weeks({
      ...LOW, totalWeeks: 5, fitnessLevel: 'beginner', baselineKm: 25, weeklyHoursTarget: 2,
      sharpening: { startLongMin: 40, startSource: 'history-30d' }, ctlRatio: 0.7,
    })[2];
    expect(r.runs, r.label).toBe(3);
    expect(total(r.label), r.label).toBe(95);
    expect(r.fit, r.label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'volume', hoursTarget: 2 });
    expect(lineOf(r.fit), r.label).toBe(NAMES_NO_CEILING(3, 4));
  });

  it('2.5-hour target, 100-min longest: week 1 holds 3 runs without the lever (the target binds) and 2 with it (no ceiling named)', () => {
    const B: Ctx = { ...MID, weeklyHoursTarget: 2.5, sharpening: { startLongMin: 100, startSource: 'history-30d' } };
    const plain = weeks(B)[0];
    expect(plain.runs, plain.label).toBe(3);
    expect(plain.fit, plain.label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'hours', hoursTarget: 2.5, currentWeeklyKm: 40 });
    expect(lineOf(plain.fit)).toBe('The 2.5 h weekly target fits 3 of your 4 runs this week. Each stays at a useful length.');
    const levered = weeks({ ...B, effortScore: 1.5 })[0];
    expect(levered.runs, levered.label).toBe(2);
    expect(levered.fit, levered.label).toEqual({ chosenRuns: 4, fittedRuns: 2, binding: 'volume', hoursTarget: 2.5 });
    expect(lineOf(levered.fit)).toBe(NAMES_NO_CEILING(2, 4));
  });

  // Marathon 6 weeks out, 25 km a week synced, consistent runner, longest run of
  // the last 30 days 60 min, no hours target (main.ts clears weeklyTrainingHours
  // at launch, so this is the usual case). Week 3 (build).
  const NO_TARGET: Ctx = {
    runsPerWeek: 5, raceDistance: 'marathon', runnerType: 'Balanced', fitnessLevel: 'intermediate',
    vdot: 45, easyPaceSecPerKm: 330, totalWeeks: 6, baselineKm: 25, archetype: 'consistent-runner',
    sharpening: { startLongMin: 60, startSource: 'history-30d' },
  };

  it('no target, 5 runs: the budget alone merges runs (4 of 5); the lowered budget merges one more and the week keeps a line naming no ceiling', () => {
    const plain = weeks(NO_TARGET)[2];
    expect(plain.runs, plain.label).toBe(4);
    expect(lineOf(plain.fit)).toBe('Building from 25 km a week, this week\'s volume fits 4 of your 5 runs. Each stays at a useful length.');
    for (const lever of [{ effortScore: 1.5 }, { ctlRatio: 0.8 }]) {
      const r = weeks({ ...NO_TARGET, ...lever })[2];
      expect(r.runs, r.label).toBe(3);
      expect(r.fit, r.label).toEqual({ chosenRuns: 5, fittedRuns: 3, binding: 'volume' });
      expect(lineOf(r.fit)).toBe(NAMES_NO_CEILING(3, 5));
    }
  });

  it('no target, 4 runs: the week holds every run without the lever and 3 with it; the line names no ceiling', () => {
    const plain = weeks({ ...NO_TARGET, runsPerWeek: 4 })[2];
    expect(plain.runs, plain.label).toBe(4);
    expect(plain.fit, plain.label).toBeUndefined();
    const r = weeks({ ...NO_TARGET, runsPerWeek: 4, effortScore: 1.5 })[2];
    expect(r.runs, r.label).toBe(3);
    expect(r.fit, r.label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'volume' });
    expect(lineOf(r.fit)).toBe(NAMES_NO_CEILING(3, 4));
  });

  it('15 km a week: the lever leaves every loaded week at 2 runs, and the volume note stands', () => {
    for (const r of weeks({ ...LOW, effortScore: 1.5 }).filter(r => [1, 2, 3, 5].includes(r.k))) {
      expect(r.runs, r.label).toBe(2);
      expect(r.fit, r.label).toEqual({ chosenRuns: 4, fittedRuns: 2, binding: 'volume', hoursTarget: 2, currentWeeklyKm: 15 });
    }
  });
});

describe('the hours target is named only when the runs that fit fill it', () => {
  const HALF: Ctx = {
    runsPerWeek: 4, raceDistance: 'half', runnerType: 'Balanced', fitnessLevel: 'intermediate',
    vdot: 45, easyPaceSecPerKm: 330, totalWeeks: 12, weeklyHoursTarget: 1,
  };

  it('12-week half, 1-hour target: the 3 runs that fit total 88 min, so the note names no ceiling', () => {
    const r = weeks(HALF)[0];
    expect(r.runs, r.label).toBe(3);
    expect(total(r.label), r.label).toBe(88);
    expect(r.fit, r.label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'volume', hoursTarget: 1 });
    expect(lineOf(r.fit)).toBe(NAMES_NO_CEILING(3, 4));
  });

  it('with 40 km a week synced, once the capped ramp reaches the 1-hour target the note names neither the target nor the ramp', () => {
    const rows = weeks({ ...HALF, runsPerWeek: 5, baselineKm: 40, archetype: 'consistent-runner' });
    const r = rows[5]; // week 6: the budget is the 1-hour target, the runs total more
    expect(total(r.label), r.label).toBeGreaterThan(60);
    expect(r.fit, r.label).toEqual({ chosenRuns: 5, fittedRuns: 3, binding: 'volume', hoursTarget: 1 });
    expect(lineOf(r.fit)).toBe(NAMES_NO_CEILING(3, 5));
  });

  it('every week of these plans that names the target totals no more than it and has no room under it for another run', () => {
    const SMALL: Ctx = { ...LOW, totalWeeks: 5, fitnessLevel: 'beginner', baselineKm: 25, sharpening: { startLongMin: 40, startSource: 'history-30d' } };
    const cases: Ctx[] = [
      HALF, { ...HALF, weeklyHoursTarget: 1.5 }, { ...HALF, weeklyHoursTarget: 2 },
      { ...HALF, runsPerWeek: 5, baselineKm: 40, archetype: 'consistent-runner' },
      { ...LOW, baselineKm: 40, weeklyHoursTarget: 1, sharpening: { startLongMin: 100, startSource: 'history-30d' } },
      { ...LOW, baselineKm: 40, weeklyHoursTarget: 1.5, sharpening: { startLongMin: 100, startSource: 'history-30d' } },
      { ...LOW, baselineKm: 40, weeklyHoursTarget: 2, sharpening: { startLongMin: 100, startSource: 'history-30d' } },
      CAPPED_HALF,
      // The live effort/CTL lever: a sharpening block scales its budget, a full plan its sessions.
      MID, { ...MID, effortScore: 1.5 }, { ...MID, effortScore: 3 }, { ...MID, ctlRatio: 0.8 }, { ...MID, ctlRatio: 0.7 },
      SMALL, { ...SMALL, ctlRatio: 0.7 }, { ...SMALL, effortScore: 3 },
      { ...HALF, weeklyHoursTarget: 2, effortScore: 1.5 }, { ...HALF, weeklyHoursTarget: 2, effortScore: 3 },
      { ...HALF, weeklyHoursTarget: 2, ctlRatio: 0.7 },
      { ...CAPPED_HALF, effortScore: 3 }, { ...CAPPED_HALF, ctlRatio: 0.7 },
    ];
    let named = 0;
    for (const c of cases) {
      const targetMin = c.weeklyHoursTarget! * 60;
      for (const r of weeks(c)) {
        if (r.fit?.binding !== 'hours') continue;
        named++;
        expect(total(r.label), r.label).toBeLessThanOrEqual(targetMin);
        expect(total(r.label) + EASY_FLOOR_MIN, r.label).toBeGreaterThan(targetMin);
      }
    }
    expect(named).toBeGreaterThan(0);
  });
});

describe('an estimated baseline is never stated as current weekly running', () => {
  it('block on the runs-a-week estimate (nothing synced): the note leaves out the km', () => {
    const rows = weeks({ ...LOW, baselineKmIsEstimate: true });
    for (const r of rows.filter(r => [1, 2, 3, 5].includes(r.k))) {
      expect(r.fit, r.label).toEqual({ chosenRuns: 4, fittedRuns: 2, binding: 'volume', hoursTarget: 2 });
    }
  });

  it('planEngineStateInputs flags the s.wkm fallback as an estimate, a synced or entered volume as not', () => {
    const block = { sharpenBlock: { v: 1 } as any, wkm: 17, continuousMode: false, athleteArchetype: undefined };
    expect(planEngineStateInputs({ ...block, detectedWeeklyKm: undefined })).toEqual({ baselineKm: 17, archetype: 'unknown', baselineKmIsEstimate: true });
    expect(planEngineStateInputs({ ...block, detectedWeeklyKm: 15 })).toEqual({ baselineKm: 15, archetype: 'unknown', baselineKmIsEstimate: false });
    expect(planEngineStateInputs({ wkm: 17, continuousMode: true, detectedWeeklyKm: undefined, athleteArchetype: undefined }).baselineKmIsEstimate).toBe(true);
    // A full race plan with nothing synced has no baseline at all.
    expect(planEngineStateInputs({ wkm: 17, continuousMode: false, detectedWeeklyKm: undefined, athleteArchetype: undefined }))
      .toEqual({ baselineKm: undefined, archetype: undefined, baselineKmIsEstimate: false });
  });
});
