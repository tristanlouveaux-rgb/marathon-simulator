// @vitest-environment jsdom
/**
 * The Plan tab's run-count line (Tristan 2026-10-08). When the weekly budget
 * consolidates easy runs so a week holds fewer runs than the runner chose, one
 * line says why. The plan engine reports it (PlanWeekNotes.budgetRunFit) and the
 * resolver drops it when injury, illness, a holiday bridge or a partial first
 * week shapes the week instead. It replaces the run-day ramp note, which counted
 * rendered runs against s.rw in the UI and so also fired for weeks short of runs
 * for other reasons.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
vi.mock('@/state/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));

import { renderPlanView } from './plan-view';
import { resolveWeekWorkouts } from './week-resolve';
import { budgetRunFitLine } from './budget-run-fit-line';
import { getDefaultState, setState, resetState } from '@/state/store';
import { initializeWeeks } from '@/workouts/generator';
import { createDefaultInjuryState } from '@/types/injury';
import type { PlanWeekNotes } from '@/workouts/plan_engine';
import type { SimulatorState } from '@/types/state';

const LINE = 'Building from 15 km a week, this week\'s volume fits 2 of your 4 runs. Each stays at a useful length.';

/** Marathon 7 weeks out (a sharpening block), 4 runs a week, 15 km a week, longest
 *  run of the last 30 days 60 min, 2-hour weekly target, viewing week `w`. */
function lowVolumeBlock(w: number, over: Partial<SimulatorState> = {}): SimulatorState {
  const tw = 7;
  const s = {
    ...getDefaultState(),
    eventType: 'running', hasCompletedOnboarding: true,
    rw: 4, rd: 'marathon', typ: 'Balanced', tw, v: 45, gs: 0, w,
    pac: { e: 330 }, wks: initializeWeeks(tw, { raceDistance: 'marathon' }), continuousMode: false,
    detectedWeeklyKm: 15, athleteArchetype: { archetype: 'consistent-runner' },
    onboarding: { experienceLevel: 'intermediate', weeklyTrainingHours: 2 },
    sharpenBlock: { v: 1, startLongMin: 60, startSource: 'history-30d', recentLongestMin: 60, noSignal: false, trainingWeeks: tw, builtISO: '2026-09-07' },
    planStartDate: '2026-09-07',
    unitPref: 'km',
    ...over,
  } as unknown as SimulatorState;
  return s;
}

function render(s: SimulatorState): string {
  setState(s);
  renderPlanView();
  return document.getElementById('plan-budget-run-fit')?.textContent?.trim() ?? '';
}

const RUN_TYPES = new Set(['easy', 'long', 'threshold', 'vo2', 'marathon_pace', 'float', 'progressive']);
const runCount = (ws: any[]) => ws.filter(w => RUN_TYPES.has(w.t)).length;

beforeEach(() => {
  resetState();
  document.body.innerHTML = '<div id="app-root"></div>';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('Plan tab: the run-count line', () => {
  it('15 km a week, 60-min longest, 4 runs, 2-hour target: week 1 holds 2 runs and shows the line', () => {
    const s = lowVolumeBlock(1);
    setState(s);
    expect(runCount(resolveWeekWorkouts(s, 1))).toBe(2);
    expect(render(s)).toBe(LINE);
  });

  it('the peak week (week 5) shows it too', () => {
    expect(render(lowVolumeBlock(5))).toBe(LINE);
  });

  it('the deload week (week 4) and race week (week 7) hold 2 runs and show no line', () => {
    for (const w of [4, 7]) {
      const s = lowVolumeBlock(w);
      setState(s);
      expect(runCount(resolveWeekWorkouts(s, w)), `week ${w}`).toBe(2);
      expect(render(s), `week ${w}`).toBe('');
    }
  });

  it('the taper week (week 6) shows no line', () => {
    expect(render(lowVolumeBlock(6))).toBe('');
  });

  it('a normal week (40 km a week, 100-min longest, no target) holds 4 runs and shows no line', () => {
    const s = lowVolumeBlock(1, {
      detectedWeeklyKm: 40,
      onboarding: { experienceLevel: 'intermediate' } as any,
      sharpenBlock: { v: 1, startLongMin: 100, startSource: 'history-30d', recentLongestMin: 100, noSignal: false, trainingWeeks: 7, builtISO: '2026-09-07' } as any,
    });
    setState(s);
    expect(runCount(resolveWeekWorkouts(s, 1))).toBe(4);
    expect(render(s)).toBe('');
  });

  it('a past week shows no line; a future week does', () => {
    const s = lowVolumeBlock(3);
    expect(render(s)).toBe(LINE); // current week 3
    const line = () => document.getElementById('plan-budget-run-fit')?.textContent?.trim() ?? '';
    const goTo = (k: number) => document.querySelector<HTMLElement>(`[data-plan-week-nav="${k}"]`)!.click();
    goTo(1);                      // past: the engine still reports the fit, the view hides it
    const notes: PlanWeekNotes = {};
    resolveWeekWorkouts(s, 1, { planNotes: notes });
    expect(notes.budgetRunFit).toBeDefined();
    expect(line()).toBe('');
    goTo(5);                      // future peak week
    expect(line()).toBe(LINE);
    goTo(3);                      // back to the current week (resets the view week)
  });

  it('miles: the current volume is shown in the runner\'s unit', () => {
    expect(render(lowVolumeBlock(1, { unitPref: 'mi' }))).toBe(
      'Building from 9 mi a week, this week\'s volume fits 2 of your 4 runs. Each stays at a useful length.',
    );
  });

  it('nothing synced or entered: the block ramps from the runs-a-week estimate (s.wkm) and the line states no km', () => {
    const s = lowVolumeBlock(1, { detectedWeeklyKm: undefined, wkm: 15 });
    setState(s);
    expect(runCount(resolveWeekWorkouts(s, 1))).toBe(2);
    expect(render(s)).toBe('This week\'s volume fits 2 of your 4 runs. Each stays at a useful length.');
  });

  it('a CTL-gap week whose 3-hour target fits all 4 runs: the lever drops one and the line does not blame the target', () => {
    // 40 km a week, 80-min longest, 3-hour target: week 1 holds 4 runs (180 min).
    // A CTL ratio of 0.8 scales the block budget down and week 1 holds 3.
    const mid = (): SimulatorState => lowVolumeBlock(1, {
      detectedWeeklyKm: 40,
      onboarding: { experienceLevel: 'intermediate', weeklyTrainingHours: 3 } as any,
      sharpenBlock: { v: 1, startLongMin: 80, startSource: 'history-30d', recentLongestMin: 80, noSignal: false, trainingWeeks: 7, builtISO: '2026-09-07' } as any,
    });
    const plain = mid();
    setState(plain);
    expect(runCount(resolveWeekWorkouts(plain, 1))).toBe(4);
    expect(render(plain)).toBe('');
    const gap = mid();
    (gap.wks[0] as any).ctlRatio = 0.8;
    setState(gap);
    expect(runCount(resolveWeekWorkouts(gap, 1))).toBe(3);
    expect(render(gap)).toBe('');
  });

  it('with the Time budget banner above it, the line sits apart from the banner card', () => {
    // 12-week half, 4 runs, 1-hour target: the week totals 88 min (banner) and holds 3 runs (line).
    const s = lowVolumeBlock(1, {
      tw: 12, rd: 'half', wks: initializeWeeks(12, { raceDistance: 'half' }),
      sharpenBlock: undefined, detectedWeeklyKm: undefined, athleteArchetype: undefined,
      onboarding: { experienceLevel: 'intermediate', weeklyTrainingHours: 1 } as any,
    });
    expect(render(s)).toBe('The 1 h weekly target fits 3 of your 4 runs this week. Each stays at a useful length.');
    const banner = document.getElementById('budget-banner-card')!;
    const line = document.getElementById('plan-budget-run-fit')!;
    expect(banner).not.toBeNull();
    expect(banner.nextElementSibling).toBe(line);
    // Vertical margins between the two block siblings collapse to the larger one.
    const gapPx = Math.max(parseFloat(banner.style.marginBottom) || 0, parseFloat(line.style.marginTop) || 0);
    expect(gapPx).toBeGreaterThan(0);
  });
});

describe('resolver: weeks short of runs for another reason carry no note', () => {
  const notesFor = (s: SimulatorState, w: number) => {
    setState(s);
    const notes: PlanWeekNotes = {};
    resolveWeekWorkouts(s, w, { planNotes: notes });
    return notes.budgetRunFit;
  };

  it('baseline: week 1 carries it', () => {
    expect(notesFor(lowVolumeBlock(1), 1)).toEqual({ chosenRuns: 4, fittedRuns: 2, binding: 'volume', hoursTarget: 2, currentWeeklyKm: 15 });
  });

  it('active injury', () => {
    const start = new Date(Date.now() - 10 * 86400000).toISOString();
    const injuryState = {
      ...createDefaultInjuryState(), active: true, type: 'shin_splints', location: 'shin', injuryPhase: 'return_to_run',
      currentPain: 2, canRun: 'limited', startDate: start, acutePhaseStartDate: start, phaseTransitions: [],
      capacityTestsPassed: [], returnToRunLevel: 1, zeroPainWeeks: 0, graduatedReturnWeeksLeft: 2,
    } as any;
    expect(notesFor(lowVolumeBlock(1, { injuryState }), 1)).toBeUndefined();
  });

  it('illness in the current week', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(notesFor(lowVolumeBlock(1, { illnessState: { startDate: today, severity: 'light', active: true } as any }), 1)).toBeUndefined();
  });

  it('a post-holiday bridge week', () => {
    const s = lowVolumeBlock(2);
    (s.wks[1] as any)._holidayBridgeScale = 0.8;
    expect(notesFor(s, 2)).toBeUndefined();
  });

  it('a partial first week (onboarded mid-week)', () => {
    expect(notesFor(lowVolumeBlock(1, { planCreatedAt: '2026-09-09' } as any), 1)).toBeUndefined();
  });
});

describe('budgetRunFitLine wording', () => {
  it('hours target binds', () => {
    expect(budgetRunFitLine({ chosenRuns: 4, fittedRuns: 2, binding: 'hours', hoursTarget: 2, currentWeeklyKm: 40 }, 'km'))
      .toBe('The 2 h weekly target fits 2 of your 4 runs this week. Each stays at a useful length.');
  });

  it('volume binds with no known current volume', () => {
    expect(budgetRunFitLine({ chosenRuns: 5, fittedRuns: 3, binding: 'volume' }, 'km'))
      .toBe('This week\'s volume fits 3 of your 5 runs. Each stays at a useful length.');
  });

  it('copy rules: no em dash', () => {
    for (const fit of [
      { chosenRuns: 4, fittedRuns: 2, binding: 'hours' as const, hoursTarget: 2.5 },
      { chosenRuns: 4, fittedRuns: 2, binding: 'volume' as const, currentWeeklyKm: 15 },
    ]) expect(budgetRunFitLine(fit, 'km')).not.toContain('—');
  });
});
