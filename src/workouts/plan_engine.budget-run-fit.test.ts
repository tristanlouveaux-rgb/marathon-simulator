import { describe, it, expect } from 'vitest';
import { planWeekSessions, planEngineStateInputs, type PlanContext, type PlanWeekNotes } from './plan_engine';
import { computeRunningPlanPhases } from './phases';

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

  it('full plan whose capped ramp is still climbing: the volume ramp binds until the week reaches the target', () => {
    // 12-week half, 5 runs, 40 km a week, 2.5-hour target: early weeks sit under 150 min.
    const rows = weeks({
      runsPerWeek: 5, raceDistance: 'half', runnerType: 'Balanced', fitnessLevel: 'intermediate',
      vdot: 45, easyPaceSecPerKm: 330, totalWeeks: 12, weeklyHoursTarget: 2.5, baselineKm: 40, archetype: 'consistent-runner',
    });
    expect(rows[0].fit?.binding, rows[0].label).toBe('volume');
    expect(rows[9].fit?.binding, rows[9].label).toBe('hours');
  });
});

describe('the live effort/CTL lever in a sharpening block', () => {
  // Marathon 7 weeks out, 4 runs a week, 40 km a week, 3-hour target, longest
  // run of the last 30 days 80 min. The lever (effort score above 0, or a CTL
  // ratio below 1) scales the block's budget below the 3-hour target.
  const MID: Ctx = { ...LOW, baselineKm: 40, weeklyHoursTarget: 3, sharpening: { startLongMin: 80, startSource: 'history-30d' } };

  it('no lever: week 1 holds all 4 runs (180 min) and carries no note', () => {
    const r = weeks(MID)[0];
    expect(r.runs, r.label).toBe(4);
    expect(r.fit, r.label).toBeUndefined();
  });

  it('effort score 1.5: week 1 holds 3 runs, but the 3-hour target fits 4, so no note (never "hours")', () => {
    const r = weeks({ ...MID, effortScore: 1.5 })[0];
    expect(r.runs, r.label).toBe(3);
    expect(r.fit, r.label).toBeUndefined();
  });

  it('CTL ratio 0.8: week 1 holds 3 runs and carries no note', () => {
    const r = weeks({ ...MID, ctlRatio: 0.8 })[0];
    expect(r.runs, r.label).toBe(3);
    expect(r.fit, r.label).toBeUndefined();
  });

  it('a lever week whose run count the target alone sets keeps the note (week 2: 3 runs with or without the lever)', () => {
    const plain = weeks(MID)[1];
    const levered = weeks({ ...MID, effortScore: 1.5 })[1];
    expect(plain.runs, plain.label).toBe(3);
    expect(levered.runs, levered.label).toBe(3);
    expect(levered.fit, levered.label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'hours', hoursTarget: 3, currentWeeklyKm: 40 });
  });

  it('2.5-hour target, 100-min longest: week 1 holds 3 runs without the lever (the target binds) and 2 with it (no note)', () => {
    const B: Ctx = { ...MID, weeklyHoursTarget: 2.5, sharpening: { startLongMin: 100, startSource: 'history-30d' } };
    const plain = weeks(B)[0];
    expect(plain.runs, plain.label).toBe(3);
    expect(plain.fit, plain.label).toEqual({ chosenRuns: 4, fittedRuns: 3, binding: 'hours', hoursTarget: 2.5, currentWeeklyKm: 40 });
    const levered = weeks({ ...B, effortScore: 1.5 })[0];
    expect(levered.runs, levered.label).toBe(2);
    expect(levered.fit, levered.label).toBeUndefined();
  });

  it('15 km a week: the lever leaves every loaded week at 2 runs, and the volume note stands', () => {
    for (const r of weeks({ ...LOW, effortScore: 1.5 }).filter(r => [1, 2, 3, 5].includes(r.k))) {
      expect(r.runs, r.label).toBe(2);
      expect(r.fit, r.label).toEqual({ chosenRuns: 4, fittedRuns: 2, binding: 'volume', hoursTarget: 2, currentWeeklyKm: 15 });
    }
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
