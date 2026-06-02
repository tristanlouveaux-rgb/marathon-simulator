import { describe, it, expect } from 'vitest';
import { generateGymWorkouts } from './gym';
import { parseStrengthSession } from '@/guided/strength-model';
import type { InjuryState } from '@/types/injury';

// ---------------------------------------------------------------------------
// Minimal injury state factory
// ---------------------------------------------------------------------------

function makeInjuryState(overrides: Partial<InjuryState> = {}): InjuryState {
  return {
    active: true,
    type: 'general',
    location: 'knee',
    locationDetail: 'left',
    currentPain: 3,
    history: [],
    startDate: new Date().toISOString(),
    context: 'training',
    recoveryPhase: 'phase_1',
    lastTestRunDate: null,
    testRunPainResult: null,
    emergencyShutdownUntil: null,
    rehabBlockStartDate: null,
    physioNotes: '',
    expectedDurationWeeks: 4,
    injuryPhase: 'acute',
    painLatency: false,
    acutePhaseStartDate: new Date().toISOString(),
    capacityTestsPassed: [],
    capacityTestHistory: [],
    phaseTransitions: [],
    lastActivityDate: null,
    morningPainYesterday: null,
    canRun: 'no',
    returnToRunLevel: 1,
    severityClass: 'moderate',
    morningPainResponses: [],
    holdCount: 0,
    preferredCrossTraining: null,
    zeroPainWeeks: 0,
    graduatedReturnWeeksLeft: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic generation
// ---------------------------------------------------------------------------

describe('generateGymWorkouts — basic', () => {
  it('returns empty array when gymSessionsPerWeek is 0', () => {
    const result = generateGymWorkouts('base', 0, 'intermediate');
    expect(result).toHaveLength(0);
  });

  it('all generated workouts have type "gym"', () => {
    const result = generateGymWorkouts('base', 2, 'intermediate');
    for (const w of result) {
      expect(w.t).toBe('gym');
    }
  });

  it('generates up to the requested session count', () => {
    const result = generateGymWorkouts('base', 3, 'intermediate');
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase scaling
// ---------------------------------------------------------------------------

describe('generateGymWorkouts — phase scaling', () => {
  it('base phase: returns full session count (up to 3)', () => {
    const result = generateGymWorkouts('base', 3, 'intermediate');
    expect(result).toHaveLength(3);
  });

  it('build phase: caps at 2 sessions even if 3 requested', () => {
    const result = generateGymWorkouts('build', 3, 'intermediate');
    expect(result).toHaveLength(2);
  });

  it('peak phase: always returns 1 session', () => {
    expect(generateGymWorkouts('peak', 3, 'intermediate')).toHaveLength(1);
    expect(generateGymWorkouts('peak', 1, 'intermediate')).toHaveLength(1);
  });

  it('taper phase: returns 1 if >= 2 requested, 0 if only 1', () => {
    expect(generateGymWorkouts('taper', 2, 'intermediate')).toHaveLength(1);
    expect(generateGymWorkouts('taper', 1, 'intermediate')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ability tiers
// ---------------------------------------------------------------------------

describe('generateGymWorkouts — ability tiers', () => {
  it('beginner templates have lower RPE (≤5) in base phase', () => {
    const result = generateGymWorkouts('base', 2, 'total_beginner');
    for (const w of result) {
      expect(w.r).toBeLessThanOrEqual(5);
    }
  });

  it('full/intermediate templates have higher RPE (≥6) in base phase', () => {
    const result = generateGymWorkouts('base', 2, 'intermediate');
    for (const w of result) {
      expect(w.r).toBeGreaterThanOrEqual(6);
    }
  });

  it('peak phase has lower RPE than base phase (maintenance)', () => {
    const baseRPE = generateGymWorkouts('base', 1, 'intermediate')[0].r;
    const peakRPE = generateGymWorkouts('peak', 1, 'intermediate')[0].r;
    expect(peakRPE).toBeLessThan(baseRPE);
  });
});

// ---------------------------------------------------------------------------
// Injury filtering
// ---------------------------------------------------------------------------

describe('generateGymWorkouts — injury adaptation (region-aware)', () => {
  const gen = (injury: InjuryState) =>
    generateGymWorkouts('base', 2, 'intermediate', undefined, undefined, undefined, injury);

  it('loads the unaffected region even in the acute phase (knee → upper-body + core)', () => {
    const injury = makeInjuryState({ injuryPhase: 'acute' });
    const result = gen(injury);
    expect(result).toHaveLength(1);
    expect(result[0].n.toLowerCase()).toContain('upper-body');
  });

  it('pauses strength entirely for a both-regions-blocked injury (back, acute)', () => {
    const injury = makeInjuryState({ injuryPhase: 'acute', location: 'back' });
    expect(gen(injury)).toHaveLength(0);
  });

  it('keeps upper-body + core for a knee injury in rehab (lower-body paused)', () => {
    // Default factory location is 'knee' → lower-load 0, upper-load 100.
    const injury = makeInjuryState({ injuryPhase: 'rehab' });
    const result = gen(injury);
    expect(result).toHaveLength(1);
    expect(result[0].n.toLowerCase()).toContain('upper-body');
    expect(result[0].n.toLowerCase()).not.toContain('lower-body');
    expect(result[0].r ?? 99).toBeLessThanOrEqual(5); // submaximal
  });

  it('keeps lower-body + core for a shoulder injury (upper-body paused)', () => {
    // shoulder → upper-load 0, lower-load 100.
    const injury = makeInjuryState({ injuryPhase: 'rehab', location: 'shoulder' });
    const result = gen(injury);
    expect(result).toHaveLength(1);
    expect(result[0].n.toLowerCase()).toContain('lower-body');
    expect(result[0].n.toLowerCase()).not.toContain('upper-body');
  });

  it('pauses loaded strength for a back injury (both regions blocked)', () => {
    // back → upper 0, lower 0.
    const injury = makeInjuryState({ injuryPhase: 'rehab', location: 'back' });
    expect(gen(injury)).toHaveLength(0);
  });

  it('adapts (does not drop) during test_capacity and return_to_run regardless of level', () => {
    const tc = makeInjuryState({ injuryPhase: 'test_capacity' });
    expect(gen(tc)).toHaveLength(1);
    const rtr = makeInjuryState({ injuryPhase: 'return_to_run', returnToRunLevel: 2 });
    expect(gen(rtr)).toHaveLength(1);
  });

  it('returns normal templates once resolved', () => {
    const injury = makeInjuryState({ injuryPhase: 'resolved', active: false });
    const result = gen(injury);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].n.toLowerCase()).not.toContain('& core');
  });
});

// ---------------------------------------------------------------------------
// Deload handling
// ---------------------------------------------------------------------------

describe('generateGymWorkouts — deload weeks', () => {
  it('deload week reduces session count by 1', () => {
    // Intermediate ability: deload cycle = 4 (weeks 4, 8, 12...)
    // weekIndex 1 = normal, weekIndex 4 = deload
    const normalResult = generateGymWorkouts('base', 3, 'intermediate', 1, 16);
    const deloadResult = generateGymWorkouts('base', 3, 'intermediate', 4, 16);
    expect(deloadResult.length).toBeLessThan(normalResult.length);
  });

  it('adds (Deload) suffix to workout names on deload week', () => {
    // Week 4 is a deload week for intermediate (cycle = 4)
    const result = generateGymWorkouts('base', 3, 'intermediate', 4, 16);
    for (const w of result) {
      expect(w.n).toContain('Deload');
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2: intermediate+ auto-gym uses the rotating running-strength pool
// ---------------------------------------------------------------------------

describe('generateGymWorkouts — intermediate uses the running-strength pool', () => {
  it('intermediate base sessions are the rotating pool (Running Strength), and parse', () => {
    const result = generateGymWorkouts('base', 3, 'intermediate', 1, 16);
    expect(result).toHaveLength(3);
    for (const w of result) {
      expect(w.n).toMatch(/^Running Strength/);
      expect(parseStrengthSession(w)).not.toBeNull();
    }
    // 3 distinct sessions in the week (different rotation slots).
    expect(new Set(result.map(w => w.d)).size).toBe(3);
  });

  it('the pool rotates week to week (deterministic by weekIndex)', () => {
    const w1 = generateGymWorkouts('base', 1, 'intermediate', 1, 16)[0];
    const w2 = generateGymWorkouts('base', 1, 'intermediate', 2, 16)[0];
    expect(w1.d).not.toBe(w2.d);
    // Same week => identical (determinism).
    const w1b = generateGymWorkouts('base', 1, 'intermediate', 1, 16)[0];
    expect(w1.d).toBe(w1b.d);
  });

  it('beginner/novice still get their bodyweight templates, not the pool', () => {
    const beg = generateGymWorkouts('base', 2, 'total_beginner', 1, 16);
    for (const w of beg) expect(w.n).not.toMatch(/^Running Strength/);
  });
});
