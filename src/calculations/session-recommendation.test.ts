import { describe, it, expect, beforeEach } from 'vitest';
import { buildSessionRecommendation } from './session-recommendation';
import { setState } from '@/state/store';
import type { SimulatorState, Week } from '@/types';

// ─── Minimal state factory ───────────────────────────────────────────────────
// Mirrors `src/calculations/daily-coach.test.ts`. Keeps weeksOfHistory < 3 so
// the readiness composite short-circuits to its safe default ("On Track",
// score 65) — letting each test vary one knob without combinatorial setup.

function makeWeek(w: number, overrides: Partial<Week> = {}): Week {
  return {
    w,
    ph: 'build' as any,
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
    garminActuals: {},
    ...overrides,
  } as Week;
}

function makeState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    w: 2,
    tw: 12,
    v: 45,
    iv: 45,
    rpeAdj: 0,
    expectedFinal: 48,
    rd: 'marathon' as any,
    epw: 5,
    rw: 4,
    wkm: 50,
    pbs: {} as any,
    rec: null,
    lt: null,
    vo2: null,
    initialLT: null,
    initialVO2: null,
    initialBaseline: null,
    currentFitness: null,
    forecastTime: null,
    typ: 'balanced' as any,
    b: 1.06,
    wks: [makeWeek(1), makeWeek(2)],
    pac: { e: 330 } as any,
    skip: [],
    timp: 0,
    physiologyHistory: [],
    historicWeeklyTSS: [],
    ctlBaseline: 40,
    signalBBaseline: 40,
    ...overrides,
  } as SimulatorState;
}

// `buildInjuryCaption` reads injury state from the global store, not from the
// passed-in state — so tests have to mutate the store rather than just pass
// state. This is a coupling we inherit from `src/ui/injury/modal.ts`.
beforeEach(() => {
  setState(makeState());
});

describe('buildSessionRecommendation — no injury, default history', () => {
  it('returns a caption with the readiness score and sentence', () => {
    const s = makeState();
    setState(s);
    const r = buildSessionRecommendation(s);
    expect(r.caption).toMatch(/Readiness \d+/);
    expect(r.readinessScore).not.toBeNull();
    expect(typeof r.readinessScore).toBe('number');
  });

  it('recommends "steady" for a default-readiness (score ~65) athlete', () => {
    const s = makeState();
    setState(s);
    const r = buildSessionRecommendation(s);
    // Default short-circuit gives score 65 — sits in the steady band [45, 75).
    expect(r.recommendedSlot).toBe('steady');
  });
});

describe('buildSessionRecommendation — injury overrides', () => {
  it('prepends the injury caption when a discipline is blocked', () => {
    const injuredState = makeState({
      injuryState: {
        active: true,
        location: 'knee',
        type: 'overuse',
        severity: 'moderate',
        startDate: '2026-05-20',
        phase: 'rehab',
        runCapacity: 0, bikeCapacity: 100, swimCapacity: 100,
      } as any,
    });
    setState(injuredState);
    const r = buildSessionRecommendation(injuredState);
    expect(r.caption.toLowerCase()).toContain('blocked by injury');
  });

  it('keeps the readiness sentence after the injury line', () => {
    const injuredState = makeState({
      injuryState: {
        active: true,
        location: 'knee',
        type: 'overuse',
        severity: 'moderate',
        startDate: '2026-05-20',
        phase: 'rehab',
        runCapacity: 0, bikeCapacity: 100, swimCapacity: 100,
      } as any,
    });
    setState(injuredState);
    const r = buildSessionRecommendation(injuredState);
    expect(r.caption).toMatch(/Readiness \d+/);
  });

  it('never recommends "hard" when injured, even if readiness would allow it', () => {
    // Force a high-score path: enough physiology history + fresh TSB shape.
    const injuredHighReadiness = makeState({
      wks: [makeWeek(1), makeWeek(2), makeWeek(3), makeWeek(4)],
      injuryState: {
        active: true,
        location: 'foot',
        type: 'overuse',
        severity: 'moderate',
        startDate: '2026-05-20',
        phase: 'rehab',
        runCapacity: 50, bikeCapacity: 100, swimCapacity: 100,
      } as any,
    });
    setState(injuredHighReadiness);
    const r = buildSessionRecommendation(injuredHighReadiness);
    expect(['easy', 'steady']).toContain(r.recommendedSlot);
  });
});

describe('buildSessionRecommendation — slot thresholds', () => {
  it('caption stays user-facing (no internal jargon)', () => {
    const s = makeState();
    setState(s);
    const r = buildSessionRecommendation(s);
    // No raw TSB / ACWR / ratios leaking into the caption.
    expect(r.caption).not.toMatch(/tsb|acwr|ratio/i);
  });

  it('returns recommendedSlot in {easy, steady, hard}', () => {
    const s = makeState();
    setState(s);
    const r = buildSessionRecommendation(s);
    expect(['easy', 'steady', 'hard']).toContain(r.recommendedSlot);
  });
});

describe('buildSessionRecommendation — graceful degradation', () => {
  it('does not throw when wks is empty', () => {
    const empty = makeState({ wks: [] });
    setState(empty);
    expect(() => buildSessionRecommendation(empty)).not.toThrow();
  });

  it('does not throw when physiologyHistory is missing', () => {
    const noPhys = makeState({ physiologyHistory: undefined as any });
    setState(noPhys);
    expect(() => buildSessionRecommendation(noPhys)).not.toThrow();
  });
});
