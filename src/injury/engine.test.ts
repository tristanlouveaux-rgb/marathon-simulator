import { describe, it, expect } from 'vitest';
import {
  recordPainLevel,
  analyzeTrend,
  canProgressFromAcute,
  applyPhaseRegression,
  applyPhaseProgression,
  evaluatePhaseTransition,
} from './engine';
import type { InjuryState } from '@/types/injury';

// ---------------------------------------------------------------------------
// Minimal state factory
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<InjuryState> = {}): InjuryState {
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
// recordPainLevel
// ---------------------------------------------------------------------------

describe('recordPainLevel', () => {
  it('records pain and appends to history', () => {
    const state = makeState({ history: [] });
    const next = recordPainLevel(state, 5);
    expect(next.currentPain).toBe(5);
    expect(next.history).toHaveLength(1);
    expect(next.history[0].pain).toBe(5);
  });

  it('clamps pain above 10 to 10', () => {
    const next = recordPainLevel(makeState(), 15);
    expect(next.currentPain).toBe(10);
  });

  it('clamps pain below 0 to 0', () => {
    const next = recordPainLevel(makeState(), -3);
    expect(next.currentPain).toBe(0);
  });

  it('does not mutate the original state', () => {
    const state = makeState({ currentPain: 2, history: [] });
    recordPainLevel(state, 7);
    expect(state.currentPain).toBe(2);
    expect(state.history).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeTrend
// ---------------------------------------------------------------------------

describe('analyzeTrend', () => {
  it('returns stable trend with insufficient data', () => {
    const state = makeState({ history: [], currentPain: 3 });
    const result = analyzeTrend(state);
    expect(result.trend).toBe('stable');
  });

  it('detects acute spike when pain jumps > 2 in 24h', () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const state = makeState({
      currentPain: 7,
      history: [
        { date: twoHoursAgo.toISOString(), pain: 2 },
        { date: now.toISOString(), pain: 7 },
      ],
    });
    const result = analyzeTrend(state);
    expect(result.trend).toBe('acute_spike');
    expect(result.recommendation.action).toBe('emergency_shutdown');
  });

  it('returns stable trend when pain is unchanged', () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const state = makeState({
      currentPain: 3,
      history: [
        { date: yesterday.toISOString(), pain: 3 },
        { date: now.toISOString(), pain: 3 },
      ],
    });
    const result = analyzeTrend(state);
    expect(result.trend).toBe('stable');
  });
});

// ---------------------------------------------------------------------------
// canProgressFromAcute
// ---------------------------------------------------------------------------

describe('canProgressFromAcute', () => {
  it('returns false if current pain > 3', () => {
    const state = makeState({
      injuryPhase: 'acute',
      currentPain: 4,
      history: [{ date: new Date().toISOString(), pain: 3 }, { date: new Date().toISOString(), pain: 4 }],
      acutePhaseStartDate: new Date().toISOString(),
    });
    expect(canProgressFromAcute(state)).toBe(false);
  });

  it('returns true when history.length >= 2 AND pain <= 3 (simulated week gate)', () => {
    const state = makeState({
      injuryPhase: 'acute',
      currentPain: 2,
      acutePhaseStartDate: new Date().toISOString(),
      history: [
        { date: new Date().toISOString(), pain: 3 },
        { date: new Date().toISOString(), pain: 2 },
      ],
    });
    expect(canProgressFromAcute(state)).toBe(true);
  });

  it('returns false if not in acute phase', () => {
    const state = makeState({ injuryPhase: 'rehab', currentPain: 1, history: [{ date: '', pain: 1 }, { date: '', pain: 1 }] });
    expect(canProgressFromAcute(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyPhaseRegression / applyPhaseProgression
// ---------------------------------------------------------------------------

describe('applyPhaseRegression', () => {
  it('moves return_to_run back to test_capacity', () => {
    const state = makeState({ injuryPhase: 'return_to_run', phaseTransitions: [] });
    const next = applyPhaseRegression(state, 'test reason');
    expect(next.injuryPhase).toBe('test_capacity');
  });

  it('moves test_capacity back to rehab', () => {
    const state = makeState({ injuryPhase: 'test_capacity', phaseTransitions: [] });
    const next = applyPhaseRegression(state, 'test reason');
    expect(next.injuryPhase).toBe('rehab');
  });

  it('records the transition in phaseTransitions', () => {
    const state = makeState({ injuryPhase: 'return_to_run', phaseTransitions: [] });
    const next = applyPhaseRegression(state, 'pain spike');
    expect(next.phaseTransitions).toHaveLength(1);
    expect(next.phaseTransitions[0].wasRegression).toBe(true);
  });

  it('does not mutate original state', () => {
    const state = makeState({ injuryPhase: 'return_to_run', phaseTransitions: [] });
    applyPhaseRegression(state, 'reason');
    expect(state.injuryPhase).toBe('return_to_run');
  });
});

describe('applyPhaseProgression', () => {
  it('moves acute to rehab', () => {
    const state = makeState({ injuryPhase: 'acute', phaseTransitions: [] });
    const next = applyPhaseProgression(state, 'pain resolved');
    expect(next.injuryPhase).toBe('rehab');
  });

  it('moves rehab to test_capacity', () => {
    const state = makeState({ injuryPhase: 'rehab', phaseTransitions: [] });
    const next = applyPhaseProgression(state, 'rehab complete');
    expect(next.injuryPhase).toBe('test_capacity');
  });

  it('marks active=false when reaching resolved', () => {
    const state = makeState({ injuryPhase: 'graduated_return', phaseTransitions: [] });
    const next = applyPhaseProgression(state, 'fully recovered');
    expect(next.injuryPhase).toBe('resolved');
    expect(next.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluatePhaseTransition — pain regression rules
// ---------------------------------------------------------------------------

describe('evaluatePhaseTransition — pain regression', () => {
  it('pain >= 7 in rehab → regression to acute', () => {
    const state = makeState({
      injuryPhase: 'rehab',
      currentPain: 7,
      phaseTransitions: [],
    });
    const next = evaluatePhaseTransition(state);
    expect(next.injuryPhase).toBe('acute');
  });

  it('pain >= 7 in return_to_run → regression to acute', () => {
    const state = makeState({
      injuryPhase: 'return_to_run',
      currentPain: 8,
      phaseTransitions: [],
    });
    const next = evaluatePhaseTransition(state);
    expect(next.injuryPhase).toBe('acute');
  });

  it('pain >= 7 → resets capacity tests and returnToRunLevel', () => {
    const state = makeState({
      injuryPhase: 'return_to_run',
      currentPain: 9,
      returnToRunLevel: 5,
      capacityTestsPassed: ['pain_free_walk'],
      phaseTransitions: [],
    });
    const next = evaluatePhaseTransition(state);
    expect(next.injuryPhase).toBe('acute');
    expect(next.returnToRunLevel).toBe(1);
    expect(next.capacityTestsPassed).toHaveLength(0);
  });

  it('pain >= 4 in test_capacity → one phase back (to rehab)', () => {
    const state = makeState({
      injuryPhase: 'test_capacity',
      currentPain: 5,
      phaseTransitions: [],
    });
    const next = evaluatePhaseTransition(state);
    expect(next.injuryPhase).toBe('rehab');
  });

  it('pain >= 4 in graduated_return → one phase back (to return_to_run)', () => {
    const state = makeState({
      injuryPhase: 'graduated_return',
      currentPain: 4,
      phaseTransitions: [],
    });
    const next = evaluatePhaseTransition(state);
    expect(next.injuryPhase).toBe('return_to_run');
  });

  it('pain < 4 in advanced phase → no regression', () => {
    const state = makeState({
      injuryPhase: 'test_capacity',
      currentPain: 2,
      painLatency: false,
      phaseTransitions: [],
    });
    const next = evaluatePhaseTransition(state);
    // Should not regress — pain is low
    expect(['test_capacity', 'return_to_run']).toContain(next.injuryPhase);
  });
});
