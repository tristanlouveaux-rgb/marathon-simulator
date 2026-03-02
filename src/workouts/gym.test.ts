import { describe, it, expect } from 'vitest';
import { generateGymWorkouts } from './gym';
import type { InjuryState } from '@/types/injury';

// ---------------------------------------------------------------------------
// Minimal injury state factory
// ---------------------------------------------------------------------------

function makeInjuryState(overrides: Partial<InjuryState> = {}): InjuryState {
  return {
    active: true,
    type: 'overuse',
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

describe('generateGymWorkouts — injury filtering', () => {
  it('returns empty during acute phase', () => {
    const injury = makeInjuryState({ injuryPhase: 'acute' });
    expect(generateGymWorkouts('base', 2, 'intermediate', undefined, undefined, undefined, injury)).toHaveLength(0);
  });

  it('returns empty during rehab phase', () => {
    const injury = makeInjuryState({ injuryPhase: 'rehab' });
    expect(generateGymWorkouts('base', 2, 'intermediate', undefined, undefined, undefined, injury)).toHaveLength(0);
  });

  it('returns empty during test_capacity phase', () => {
    const injury = makeInjuryState({ injuryPhase: 'test_capacity' });
    expect(generateGymWorkouts('base', 2, 'intermediate', undefined, undefined, undefined, injury)).toHaveLength(0);
  });

  it('returns empty in return_to_run when level < 5', () => {
    const injury = makeInjuryState({ injuryPhase: 'return_to_run', returnToRunLevel: 4 });
    expect(generateGymWorkouts('base', 2, 'intermediate', undefined, undefined, undefined, injury)).toHaveLength(0);
  });

  it('returns a Return Strength session in return_to_run at level >= 5', () => {
    const injury = makeInjuryState({ injuryPhase: 'return_to_run', returnToRunLevel: 5 });
    const result = generateGymWorkouts('base', 2, 'intermediate', undefined, undefined, undefined, injury);
    expect(result).toHaveLength(1);
    expect(result[0].n).toBe('Return Strength');
    expect(result[0].r).toBeLessThanOrEqual(4); // Light session
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
