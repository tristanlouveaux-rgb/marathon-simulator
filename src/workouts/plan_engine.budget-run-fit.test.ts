import { describe, it, expect } from 'vitest';
import { planWeekSessions, type PlanContext, type PlanWeekNotes } from './plan_engine';
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
