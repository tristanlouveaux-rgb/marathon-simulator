/**
 * Weekly load targets follow the plan through deload and taper weeks, and the
 * decayed carry judges each past week against its own target (audit A10/A11).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { SimulatorState, TrainingPhase, Week } from '@/types';
import { computePlannedSignalB, computePlannedWeekTSS, computeDecayedCarry } from './fitness-model';
import { computeAcwrReductionProjection } from './acwr-reduction-projection';
import {
  computePlannedWeekTarget,
  computeCurrentWeekCarry,
  resolvePlannedWeekPhase,
} from './planned-week-target';
import { computePlanPhases, computeRunningPlanPhases } from '@/workouts/phases';
import { buildCoachContext } from '@/coach/coach-context-builder';

// Median 400, so every multiplier reads straight off the target.
const HIST = [380, 390, 400, 410, 420];
const PLAN_START = '2026-01-05'; // a Monday

/** Same multiplier rows fitness-model uses, read back through its public API. */
function rowTarget(phase: string, tier: string, weekInPhase?: number, totalPhaseWeeks?: number): number {
  return computePlannedSignalB(HIST, 400, phase, tier, 4, weekInPhase, totalPhaseWeeks, undefined);
}

function makeWeeks(phases: TrainingPhase[]): Week[] {
  return phases.map((ph, i) => ({
    w: i + 1, ph, rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
  }) as unknown as Week);
}

/** 1-indexed plan week phases from the real phase generator. */
function racePhases(totalWeeks: number): TrainingPhase[] {
  return computePlanPhases(totalWeeks).map(p => p.ph);
}

function makeState(over: Partial<SimulatorState> & { phases: TrainingPhase[] }): SimulatorState {
  const { phases, ...rest } = over;
  return {
    w: 1,
    tw: phases.length,
    v: 55,
    rw: 4,
    onboarding: { experienceLevel: 'advanced' },
    eventType: 'running',
    continuousMode: false,
    historicWeeklyTSS: HIST,
    ctlBaseline: 400,
    athleteTier: 'recreational',
    planStartDate: PLAN_START,
    pac: { e: 330 },
    wks: makeWeeks(phases),
    ...rest,
  } as unknown as SimulatorState;
}

/** A RUNNING actual worth exactly `tss` raw TSS (RPE 5 row: 1.15 TSS/min). */
function setWeekLoad(wk: Week, tss: number): void {
  wk.garminActuals = {
    [`w${wk.w}-run`]: {
      garminId: `g-${wk.w}`,
      activityType: 'RUNNING',
      durationSec: (tss / 1.15) * 60,
      distanceKm: 10,
    },
  } as unknown as Week['garminActuals'];
}

/** Noon local time on day `dayOffset` (0 = Monday) of plan week `weekNum`. */
function setClock(weekNum: number, dayOffset: number): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 5 + (weekNum - 1) * 7 + dayOffset, 12, 0, 0));
}

afterEach(() => { vi.useRealTimers(); });

describe('Deload weeks target the deload multiplier', () => {
  it('a plan-engine deload week drops to the tier deload row instead of keeping its build target', () => {
    // 12-week plan: base 1-4, build 5-9, peak 10, taper 11-12. Intermediate
    // ability deloads every 4th week (plan_engine isDeloadWeek): weeks 4 and 8.
    const s = makeState({ phases: racePhases(12), v: 45, onboarding: { experienceLevel: 'intermediate' } as any });
    expect(s.wks[7].ph).toBe('build');
    expect(computePlannedWeekTarget(s, 7)).toBe(rowTarget('build', 'recreational'));
    expect(computePlannedWeekTarget(s, 8)).toBe(rowTarget('deload', 'recreational'));
    expect(computePlannedWeekTarget(s, 8)).toBeLessThan(computePlannedWeekTarget(s, 7));
    expect(computePlannedWeekTarget(s, 4)).toBe(rowTarget('deload', 'recreational'));
  });

  it('a holiday week (forceDeload) targets the deload row whatever its cycle position', () => {
    const s = makeState({ phases: racePhases(12) });
    (s.wks[5] as any).forceDeload = true; // week 6, build, not on the advanced 5-week cycle
    expect(computePlannedWeekTarget(s, 6)).toBe(rowTarget('deload', 'recreational'));
    expect(computePlannedWeekTarget(s, 7)).toBe(rowTarget('build', 'recreational'));
  });

  it('Just-Track weeks are never treated as deloads (no plan is generated)', () => {
    const s = makeState({ phases: ['base', 'base', 'base', 'base', 'base'], trackOnly: true, continuousMode: true });
    expect(computePlannedWeekTarget(s, 4)).toBe(rowTarget('base', 'recreational'));
  });

  it('the tier override drives the multiplier on every surface', () => {
    const s = makeState({ phases: racePhases(12), athleteTierOverride: 'performance' });
    expect(computePlannedWeekTarget(s, 5)).toBe(rowTarget('deload', 'performance')); // advanced cycle: week 5
    expect(computePlannedWeekTarget(s, 6)).toBe(rowTarget('build', 'performance'));
  });
});

describe('The race taper steps down week by week', () => {
  it('a 3-week race taper targets 0.75, 0.65, 0.55 of baseline, so race week reaches the 0.55 endpoint', () => {
    // 18 weeks: taper 16-18. Advanced ability deloads weeks 5/10/15, so no taper week is a deload.
    const s = makeState({ phases: racePhases(18) });
    expect(s.wks.slice(15).map(w => w.ph)).toEqual(['taper', 'taper', 'taper']);
    expect([16, 17, 18].map(w => resolvePlannedWeekPhase(s, w).weekInTaper)).toEqual([1, 2, 3]);
    const targets = [16, 17, 18].map(w => computePlannedWeekTarget(s, w));
    // Median 400: 0.75 / 0.65 / 0.55 (Tristan, 2026-10-05).
    expect(targets).toEqual([300, 260, 220]);
    expect(targets).toEqual([1, 2, 3].map(i => rowTarget('taper', 'recreational', i, 3)));
  });

  it('a 2-week race taper targets 0.70 then 0.55 of baseline', () => {
    // 12 weeks: taper 11-12. Advanced deloads weeks 5/10, so neither taper week is a deload.
    const s = makeState({ phases: racePhases(12) });
    expect(s.wks.slice(10).map(w => w.ph)).toEqual(['taper', 'taper']);
    expect([11, 12].map(w => resolvePlannedWeekPhase(s, w))).toMatchObject([
      { phase: 'taper', weekInTaper: 1, taperWeeks: 2, alsoDeload: false },
      { phase: 'taper', weekInTaper: 2, taperWeeks: 2, alsoDeload: false },
    ]);
    expect([11, 12].map(w => computePlannedWeekTarget(s, w))).toEqual([280, 220]);
  });

  it('a 1-week race taper is race week alone and targets 0.55 (was a 0.70 special case)', () => {
    // 8 weeks on the generic split: a single taper week (week 8).
    const s = makeState({ phases: racePhases(8) });
    expect(s.wks.map(w => w.ph).filter(ph => ph === 'taper')).toHaveLength(1);
    expect(resolvePlannedWeekPhase(s, 8)).toMatchObject({ phase: 'taper', weekInTaper: 1, taperWeeks: 1, alsoDeload: false });
    expect(computePlannedWeekTarget(s, 8)).toBe(220);
    // Same row as the race week of a 2-week taper.
    const two = makeState({ phases: racePhases(12) });
    expect(computePlannedWeekTarget(s, 8)).toBe(computePlannedWeekTarget(two, 12));
  });

  it('a race-taper week the engine also deloads takes the lower of the two targets', () => {
    // Intermediate: week 16 is both the first taper week and a 4-week-cycle deload.
    const s = makeState({ phases: racePhases(18), v: 45, onboarding: { experienceLevel: 'intermediate' } as any });
    expect(resolvePlannedWeekPhase(s, 16)).toMatchObject({ phase: 'taper', weekInTaper: 1, taperWeeks: 3, alsoDeload: true });
    expect(computePlannedWeekTarget(s, 16)).toBe(Math.min(rowTarget('taper', 'recreational', 1, 3), rowTarget('deload', 'recreational')));
    expect(computePlannedWeekTarget(s, 17)).toBe(rowTarget('taper', 'recreational', 2, 3));
  });

  it('the Signal A target (daily coach) resolves the same phase', () => {
    const s = makeState({ phases: racePhases(18) });
    expect(computePlannedWeekTarget(s, 18, 'A')).toBe(computePlannedWeekTSS(HIST, 400, 'taper', 'recreational', 4, 3, 3));
    expect(computePlannedWeekTarget(s, 18, 'A')).toBe(220);
  });

  it('triathlon and HYROX race tapers read the same 1-indexed ramp', () => {
    // Tri and HYROX tapers are 1 to 2 weeks (taperCap 2). Weeks 7-8 here.
    const phases: TrainingPhase[] = ['base', 'base', 'build', 'build', 'build', 'peak', 'taper', 'taper'];
    for (const eventType of ['triathlon', 'hyrox'] as const) {
      const s = makeState({ phases, eventType });
      expect([7, 8].map(w => computePlannedWeekTarget(s, w))).toEqual([280, 220]);
    }
  });

  it('with cross-training history, the ramp scales the running-only term and the cross-training budget stays whole', () => {
    // Signal B = round(runningOnly x multiplier) + budget (computePlannedSignalB). The budget
    // (sportBaselineByType) takes no phase multiplier in deload or taper weeks. That predates
    // ISSUE-317a and is an open decision for Tristan; this pins today's behaviour so any change
    // to it is deliberate. Signal A has no budget, so it keeps the full 0.55 step.
    const runner = makeState({
      phases: racePhases(18),
      sportBaselineByType: { cycling: { avgSessionRawTSS: 100, sessionsPerWeek: 3 } } as any,
    });
    // Budget 300 raw TSS. Running-only history = HIST - 300 x 0.55 (cycling runSpec): median 235.
    expect([16, 17, 18].map(w => computePlannedWeekTarget(runner, w))).toEqual([
      Math.round(235 * 0.75) + 300, Math.round(235 * 0.65) + 300, Math.round(235 * 0.55) + 300,
    ]);
    expect(computePlannedWeekTarget(runner, 18)).toBe(429);
    expect(computePlannedWeekTarget(runner, 1)).toBe(Math.round(235 * 0.97) + 300); // base week: 528
    expect(computePlannedWeekTarget(runner, 18, 'A')).toBe(220);

    // Triathlon and HYROX: Signal A median 385, cycling 3 x 100 and swimming 2 x 50 raw TSS.
    // Budget 400, running-only median 385 - (300 x 0.55 + 100 x 0.20) = 200.
    const phases: TrainingPhase[] = ['base', 'base', 'build', 'build', 'build', 'peak', 'taper', 'taper'];
    for (const eventType of ['triathlon', 'hyrox'] as const) {
      const s = makeState({
        phases,
        eventType,
        historicWeeklyTSS: [365, 375, 385, 395, 405],
        ctlBaseline: 385,
        sportBaselineByType: {
          cycling: { avgSessionRawTSS: 100, sessionsPerWeek: 3 },
          swimming: { avgSessionRawTSS: 50, sessionsPerWeek: 2 },
        } as any,
      });
      expect(computePlannedWeekTarget(s, 1)).toBe(594); // 200 x 0.97 + 400
      expect([7, 8].map(w => computePlannedWeekTarget(s, w))).toEqual([540, 510]); // 200 x 0.70 / 0.55 + 400
      expect(computePlannedWeekTarget(s, 8, 'A')).toBe(Math.round(385 * 0.55));
    }
  });

  it('triathlon and HYROX race week: the AI Coach context carries the 0.55 Signal A target, the only place those modes read it', () => {
    // Tri and HYROX Plan, Load, Stats and debrief views never read the weekly target, so the
    // Signal B figures above (594 / 540 / 510) appear on no tri or HYROX screen. The coach
    // context is where race week's lower target reaches these users.
    const phases: TrainingPhase[] = ['base', 'base', 'build', 'build', 'build', 'peak', 'taper', 'taper'];
    setClock(8, 2);
    for (const eventType of ['triathlon', 'hyrox'] as const) {
      const s = makeState({
        phases,
        eventType,
        w: 8,
        historicWeeklyTSS: [365, 375, 385, 395, 405],
        ctlBaseline: 385,
        sportBaselineByType: {
          cycling: { avgSessionRawTSS: 100, sessionsPerWeek: 3 },
          swimming: { avgSessionRawTSS: 50, sessionsPerWeek: 2 },
        } as any,
        ...(eventType === 'triathlon' ? { triConfig: { distance: '70.3' } as any } : {}),
      });
      const ctx = buildCoachContext(s) as { fitness_trend: { planned_week_tss: number | null } };
      // 385 x 0.55 = 212. The 0-indexed position gave 385 x 0.70 = 270.
      expect(ctx.fitness_trend.planned_week_tss).toBe(Math.round(385 * 0.55));
      expect(ctx.fitness_trend.planned_week_tss).toBe(computePlannedWeekTarget(s, 8, 'A'));
    }
  });
});

describe("'taper'-labelled recovery weeks are deloads, not a race taper", () => {
  it("continuous mode: each block's 4th week takes the deload row, the last block included", () => {
    const phases: TrainingPhase[] = Array.from({ length: 12 }, (_, i) => (['base', 'build', 'peak', 'taper'] as const)[i % 4]);
    // performance deload (0.65) differs from a 1-week race taper (0.55), so the two readings are distinguishable.
    const s = makeState({ phases, continuousMode: true, athleteTier: 'performance', v: 65, onboarding: { experienceLevel: 'competitive' } as any });
    for (const w of [4, 8, 12]) {
      expect(resolvePlannedWeekPhase(s, w).phase).toBe('deload');
      expect(computePlannedWeekTarget(s, w)).toBe(rowTarget('deload', 'performance'));
    }
    expect(rowTarget('deload', 'performance')).not.toBe(rowTarget('taper', 'performance', 1, 1));
  });

  it('double periodization: the inter-cycle recovery weeks are deloads, the final run is the race taper', () => {
    const phases = racePhases(36);
    const taperWeeks = phases.map((ph, i) => (ph === 'taper' ? i + 1 : 0)).filter(Boolean);
    const finalStart = taperWeeks.find((w, i) => taperWeeks.slice(i).every((x, j) => x === w + j) && taperWeeks[taperWeeks.length - 1] === phases.length)!;
    const midTaper = taperWeeks.filter(w => w < finalStart);
    expect(midTaper.length).toBeGreaterThan(0);
    const s = makeState({ phases, v: 65, onboarding: { experienceLevel: 'competitive' } as any });
    for (const w of midTaper) expect(resolvePlannedWeekPhase(s, w).phase).toBe('deload');
    const finalLen = phases.length - finalStart + 1;
    for (let i = 0; i < finalLen; i++) {
      expect(resolvePlannedWeekPhase(s, finalStart + i)).toMatchObject({ phase: 'taper', weekInTaper: i + 1, taperWeeks: finalLen });
    }
  });
});

describe('Triathlon and HYROX weeks use their own engine deload rule', () => {
  it('every 4th non-taper week deloads; the running ability cycle is ignored', () => {
    // v 28 would be a 3-week running cycle (beginner). The tri engine deloads on 4s.
    const phases: TrainingPhase[] = ['base', 'base', 'build', 'build', 'build', 'peak', 'taper', 'taper'];
    for (const eventType of ['triathlon', 'hyrox'] as const) {
      const s = makeState({ phases, eventType, v: 28, onboarding: { experienceLevel: 'beginner' } as any });
      expect(computePlannedWeekTarget(s, 3)).toBe(rowTarget('build', 'recreational'));
      expect(computePlannedWeekTarget(s, 4)).toBe(rowTarget('deload', 'recreational'));
      // Week 8 is a multiple of 4 but a taper week: the taper is its own reduction.
      expect(resolvePlannedWeekPhase(s, 8)).toMatchObject({ phase: 'taper', alsoDeload: false });
    }
  });
});

describe('Decayed carry judges each past week against its own target', () => {
  // 12 weeks: base 1-4, build 5-9, peak 10, taper 11-12. Elite ability deloads
  // weeks 6 and 12, so weeks 8-10 are plain build/build/peak.
  const phases = racePhases(12);
  const eliteState = () => makeState({ phases, w: 11, v: 65, onboarding: { experienceLevel: 'competitive' } as any });

  it('weeks done exactly to plan leave no carry on the first taper Monday', () => {
    const s = eliteState();
    // Each past week loaded to exactly its own phase target (built from the multiplier rows, not the helper).
    setWeekLoad(s.wks[7], rowTarget('build', 'recreational'));
    setWeekLoad(s.wks[8], rowTarget('build', 'recreational'));
    setWeekLoad(s.wks[9], rowTarget('peak', 'recreational'));
    setClock(11, 0);

    expect(computeCurrentWeekCarry(s, 11)).toBe(0);
    // The old single-target reading invented carry from the taper's lower target.
    const taperTarget = rowTarget('taper', 'recreational');
    expect(computeDecayedCarry(s.wks, 11, taperTarget, PLAN_START)).toBeGreaterThan(50);
  });

  it('the second taper week inherits nothing from peak and build weeks done to plan', () => {
    const s = eliteState();
    s.w = 12;
    setWeekLoad(s.wks[8], rowTarget('build', 'recreational'));
    setWeekLoad(s.wks[9], rowTarget('peak', 'recreational'));
    setWeekLoad(s.wks[10], rowTarget('taper', 'recreational', 1, 2));
    setClock(12, 0);
    expect(computeCurrentWeekCarry(s, 12)).toBe(0);
  });

  it('a first taper week loaded above its 0.70 target carries into race week, though it sat under the old 0.85 one', () => {
    // The live carry re-judges past taper weeks against their 1-indexed targets on every render,
    // so a mid-taper user can see carry appear that the 0-indexed reading did not produce.
    const s = eliteState();
    s.w = 12;
    expect(rowTarget('taper', 'recreational', 1, 2)).toBe(280);
    expect(rowTarget('taper', 'recreational', 0, 2)).toBe(340); // batch-1 reading of week 11
    setWeekLoad(s.wks[10], 310);
    setClock(12, 0);
    const carry = computeCurrentWeekCarry(s, 12);
    // 30 TSS over target, decayed about 3.5 to 4 days to Monday noon.
    expect(carry).toBeGreaterThan(30 * 0.5);
    expect(carry).toBeLessThan(30 * 0.7);
    const oldReading = (w: number) => (w === 11 ? rowTarget('taper', 'recreational', 0, 2) : computePlannedWeekTarget(s, w));
    expect(computeDecayedCarry(s.wks, 12, oldReading, PLAN_START)).toBe(0);
  });

  it('continuous mode: the base week after a block deload done to plan starts at zero carry', () => {
    const phases: TrainingPhase[] = ['base', 'build', 'peak', 'taper', 'base', 'build', 'peak', 'taper'];
    const s = makeState({ phases, continuousMode: true, w: 5, v: 65, onboarding: { experienceLevel: 'competitive' } as any });
    setWeekLoad(s.wks[1], rowTarget('build', 'recreational'));
    setWeekLoad(s.wks[2], rowTarget('peak', 'recreational'));
    setWeekLoad(s.wks[3], rowTarget('deload', 'recreational'));
    setClock(5, 0);
    expect(computeCurrentWeekCarry(s, 5)).toBe(0);
  });

  it('the ACWR reduction projection on an untrained taper Monday projects no phantom load', () => {
    const s = eliteState();
    setWeekLoad(s.wks[7], rowTarget('build', 'recreational'));
    setWeekLoad(s.wks[8], rowTarget('build', 'recreational'));
    setWeekLoad(s.wks[9], rowTarget('peak', 'recreational'));
    setClock(11, 0);

    const projection = computeAcwrReductionProjection(s, []);
    expect(projection).not.toBeNull();
    expect(projection!.projected).toBe(0);
    expect(projection!.target).toBe(rowTarget('taper', 'recreational', 1, 2));
  });

  it('a genuine overshoot still carries, decayed from that week', () => {
    const s = eliteState();
    const over = 100;
    setWeekLoad(s.wks[9], rowTarget('peak', 'recreational') + over);
    setClock(11, 0);
    const carry = computeCurrentWeekCarry(s, 11);
    // About 3.5 days from week 10's midpoint to Monday noon: e^(-3.5/7) ≈ 0.61.
    expect(carry).toBeGreaterThan(over * 0.5);
    expect(carry).toBeLessThan(over * 0.7);
  });

  it('carry only applies to the current week; past and future weeks read 0', () => {
    const s = eliteState();
    setWeekLoad(s.wks[9], rowTarget('peak', 'recreational') + 100);
    setClock(11, 1);
    expect(computeCurrentWeekCarry(s, 11)).toBeGreaterThan(0);
    expect(computeCurrentWeekCarry(s, 12)).toBe(0);
    expect(computeCurrentWeekCarry(s, 10)).toBe(0);
  });
});

describe('Anchor: one canonical weekly target', () => {
  it('no surface builds its own phase target or single-target carry', () => {
    const offenders: string[] = [];
    const root = path.join(__dirname, '..');
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        if (entry.name === 'fitness-model.ts' || entry.name === 'planned-week-target.ts') continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const [i, line] of src.split('\n').entries()) {
          const code = line.split('//')[0];
          if (/\b(computePlannedSignalB|computePlannedWeekTSS)\s*\(/.test(code)) {
            offenders.push(`${path.relative(root, full)}:${i + 1}`);
          }
          // computeDecayedCarry with a single number is only correct for a
          // phase-independent baseline (activity-review's signalBBaseline).
          if (/\bcomputeDecayedCarry\s*\(/.test(code) && entry.name !== 'activity-review.ts') {
            offenders.push(`${path.relative(root, full)}:${i + 1}`);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('sharpening block (marathon under 8 weeks, half under 4): target deloads follow the block rule', () => {
  const blockPhases = (n: number, noSignal = false) => computeRunningPlanPhases(n, 'marathon', { noSignal }).map(p => p.ph);

  it('a block build week on the ability cycle is a deload; peak and taper weeks never are', () => {
    // Intermediate 7-week block: build x4 (week 4 on the 4-week cycle), peak, taper x2.
    const s = makeState({ phases: blockPhases(7), rd: 'marathon', v: 45, onboarding: { experienceLevel: 'intermediate' } as any });
    expect(resolvePlannedWeekPhase(s, 4).phase).toBe('deload');
    expect(resolvePlannedWeekPhase(s, 5).phase).toBe('peak');
    expect(resolvePlannedWeekPhase(s, 7)).toMatchObject({ phase: 'taper', weekInTaper: 2, taperWeeks: 2, alsoDeload: false });
  });

  it('the week before the taper never deloads, even without a peak week (no fitness signal)', () => {
    // Novice 5-week no-signal block: build x3, taper x2. Week 3 is on the 3-week cycle.
    const s = makeState({ phases: blockPhases(5, true), rd: 'marathon', v: 38, onboarding: { experienceLevel: 'novice' } as any });
    expect(s.wks.map(w => w.ph)).toEqual(['build', 'build', 'build', 'taper', 'taper']);
    expect(resolvePlannedWeekPhase(s, 3).phase).toBe('build');
    // A full plan of the same shape would still deload it (unchanged behaviour outside blocks).
    const full = makeState({ phases: blockPhases(5, true), v: 38, onboarding: { experienceLevel: 'novice' } as any });
    expect(resolvePlannedWeekPhase(full, 3).phase).toBe('deload');
  });

  it('a block taper week is never also a deload, even in a holiday (forced deload) week', () => {
    const s = makeState({ phases: blockPhases(6), rd: 'marathon', v: 45, onboarding: { experienceLevel: 'intermediate' } as any });
    (s.wks[4] as Week & { forceDeload?: boolean }).forceDeload = true;
    expect(resolvePlannedWeekPhase(s, 5)).toMatchObject({ phase: 'taper', weekInTaper: 1, alsoDeload: false });
  });
});
