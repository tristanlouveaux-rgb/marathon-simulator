/**
 * Integration cover for the bulk catch-up pass.
 *
 * The core guarantee: closing a gap in one pass must leave exactly the state
 * that walking the per-week cascade by hand would have left. Only the number of
 * prompts changes, never the arithmetic.
 *
 * Like the other `src/ui/` suites, this needs a `.env.local` with the
 * `VITE_SUPABASE_*` keys — `@/state` pulls in the Supabase client at import
 * time, which throws without them.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// `@/state` writes through to localStorage, which the node test env lacks.
if (!(globalThis as any).localStorage) {
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
}

import { getMutableState } from '@/state';
import { runCatchUp } from './catch-up';
import { computeCatchUpGap } from './catch-up-gap';
import { next } from './events';

/** Put the shared state singleton into a known mid-plan position. */
function seed(startWeek: number, totalWeeks = 16) {
  const s = getMutableState() as any;
  s.hasCompletedOnboarding = true;
  s.planStartDate = '2026-01-05';
  s.w = startWeek;
  s.tw = totalWeeks;
  s.rw = 4;
  s.rd = 'marathon';
  s.typ = 'balanced';
  s.gs = 0;
  s.v = 48;
  s.iv = 45;
  s.expectedFinal = 50;
  s.timp = 0;
  s.rpeAdj = 0;
  delete s.injuryState;
  delete s.lastCompleteDebriefWeek;
  delete s.lastDebriefWeek;
  s.wks = Array.from({ length: totalWeeks }, (_, i) => ({
    w: i + 1,
    ph: (['base', 'build', 'peak', 'taper'] as const)[i % 4],
    rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
  }));
  return s;
}

describe('runCatchUp', () => {
  beforeEach(() => { localStorage.clear?.(); });

  it('advances the whole gap in one pass', async () => {
    const s = seed(5);
    const gap = computeCatchUpGap({
      currentWeek: 5, calendarWeek: 8, totalWeeks: 16,
      generatedWeeks: 16, onboarded: true, injuryActive: false,
    })!;
    const summary = await runCatchUp(gap);

    expect(s.w).toBe(8);
    expect(summary.weeksAdvanced).toBe(3);
    expect(summary.toWeek).toBe(8);
    expect(summary.sessionsMissed).toBeGreaterThan(0);
  });

  it('records the debrief gate so the next launch does not roll the week back', async () => {
    // main.ts clamps s.w to lastCompleteDebriefWeek + 1 on every launch.
    const s = seed(5);
    await runCatchUp({ fromWeek: 5, toWeek: 8, weeks: 3 });

    expect(s.lastCompleteDebriefWeek).toBe(7);
    expect(s.lastDebriefWeek).toBe(7);
    expect(s.w).toBeLessThanOrEqual(s.lastCompleteDebriefWeek + 1);
  });

  it('applies detraining once for the whole gap', async () => {
    const s = seed(5);
    const summary = await runCatchUp({ fromWeek: 5, toWeek: 8, weeks: 3 });

    expect(summary.vdotBefore).toBe(48);
    expect(summary.vdotAfter!).toBeLessThan(48);
    expect(s.v).toBe(summary.vdotAfter);
  });

  it('lands on a Base week after 3+ weeks away', async () => {
    const s = seed(5);
    const summary = await runCatchUp({ fromWeek: 5, toWeek: 8, weeks: 3 });

    expect(summary.landedOnBaseWeek).toBe(true);
    expect(s.wks[7].ph).toBe('base');
  });

  it('leaves the landing week phase alone for a 2 week gap', async () => {
    const s = seed(5);
    const phaseBefore = s.wks[6].ph;
    const summary = await runCatchUp({ fromWeek: 5, toWeek: 7, weeks: 2 });

    expect(summary.landedOnBaseWeek).toBe(false);
    expect(s.wks[6].ph).toBe(phaseBefore);
  });

  it('produces the same state as walking the per-week cascade by hand', async () => {
    const cascadeState = seed(5);
    for (let i = 0; i < 3; i++) {
      await next({ autoResolveIncomplete: true, suppressRender: true });
    }
    const cascade = {
      w: cascadeState.w,
      timp: cascadeState.timp,
      wkGain: cascadeState.wks.map((x: any) => x.wkGain),
      rated: cascadeState.wks.map((x: any) => Object.keys(x.rated).sort()),
      completedKm: cascadeState.wks.map((x: any) => x.completedKm),
    };

    const bulkState = seed(5);
    await runCatchUp({ fromWeek: 5, toWeek: 8, weeks: 3 });
    const bulk = {
      w: bulkState.w,
      timp: bulkState.timp,
      wkGain: bulkState.wks.map((x: any) => x.wkGain),
      rated: bulkState.wks.map((x: any) => Object.keys(x.rated).sort()),
      completedKm: bulkState.wks.map((x: any) => x.completedKm),
    };

    expect(bulk).toEqual(cascade);
    expect(bulk.timp).toBeGreaterThan(0); // the run is actually exercising penalties
  });

  it('never advances past the end of the plan', async () => {
    const s = seed(14);
    const gap = computeCatchUpGap({
      currentWeek: 14, calendarWeek: 25, totalWeeks: 16,
      generatedWeeks: 16, onboarded: true, injuryActive: false,
    })!;
    const summary = await runCatchUp(gap);

    expect(s.w).toBe(16);
    expect(summary.weeksAdvanced).toBe(2);
  });

  it('refuses to batch while injured, leaving the week pointer untouched', async () => {
    const s = seed(5);
    s.injuryState = { active: true, injuryPhase: 'rehab' };
    const summary = await runCatchUp({ fromWeek: 5, toWeek: 8, weeks: 3 });

    expect(summary.weeksAdvanced).toBe(0);
    expect(s.w).toBe(5);
    expect(s.v).toBe(48); // detraining rolled back to zero weeks advanced
  });
});
