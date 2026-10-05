import { describe, it, expect } from 'vitest';
import { adaptWorkoutForInjury, applyInjuryAdaptations } from './engine';
import type { InjuryState } from '@/types/injury';
import type { Workout } from '@/types';

/**
 * Audit X5: the fast-finish long run is t:'progressive', so injury rules keyed
 * on t === 'long' skipped it. A protocol that bans long runs let a 24 km run
 * with a marathon-pace finish through, and graduated return treated it as a
 * plain progression (full distance) instead of the long-run rule (20% shorter).
 */

const FF: Workout = {
  t: 'progressive', n: 'Long Run (Fast Finish)', d: '24km: last 5 @ MP',
  r: 5, rpe: 5, dayOfWeek: 6, longRun: true,
};
const STEADY: Workout = { t: 'long', n: 'Long Run', d: '24km', r: 3, rpe: 3, dayOfWeek: 6, longRun: true };
const PLAIN_PROGRESSIVE: Workout = { t: 'progressive', n: 'Progressive Run', d: '10km: last 3 @ MP', r: 5, rpe: 5, dayOfWeek: 1 };

function injury(overrides: Partial<InjuryState>): InjuryState {
  return {
    active: true, type: 'general', location: 'knee', locationDetail: 'left', currentPain: 1,
    history: [], startDate: new Date().toISOString(), context: 'training',
    recoveryPhase: 'full_training', lastTestRunDate: null, testRunPainResult: null,
    emergencyShutdownUntil: null, rehabBlockStartDate: null, physioNotes: '',
    expectedDurationWeeks: 4, injuryPhase: 'resolved', painLatency: false,
    acutePhaseStartDate: new Date().toISOString(), capacityTestsPassed: [],
    capacityTestHistory: [], phaseTransitions: [], lastActivityDate: null,
    morningPainYesterday: null, canRun: 'yes', returnToRunLevel: 1,
    severityClass: 'moderate', morningPainResponses: [], holdCount: 0,
    preferredCrossTraining: null, zeroPainWeeks: 0, graduatedReturnWeeksLeft: 2,
    ...overrides,
  } as InjuryState;
}

describe('injury protocol long-run ban covers the fast-finish long run', () => {
  // Runner's knee bans 'long' (injury-protocols.ts).
  const knee = injury({ type: 'runners_knee' });

  it('replaces the fast-finish long run, like the steady long run', () => {
    const ff = adaptWorkoutForInjury(FF, knee);
    const steady = adaptWorkoutForInjury(STEADY, knee);
    expect(steady.adaptationType).toBe('replaced');
    expect(ff.adaptationType).toBe(steady.adaptationType);
    expect(ff.reason).toMatch(/^long banned/);
  });

  it('leaves an ordinary progressive run to the progressive rules', () => {
    const plain = adaptWorkoutForInjury(PLAIN_PROGRESSIVE, knee);
    expect(plain.reason).not.toMatch(/banned/);
  });
});

describe('graduated return applies the long-run rule to the fast-finish long run', () => {
  const state = injury({ injuryPhase: 'graduated_return', recoveryPhase: 'phase_2' });

  it('cuts it 20% and runs it steady, dropping the fast finish', () => {
    const [ff] = applyInjuryAdaptations([{ ...FF }], state, 330);
    const [steady] = applyInjuryAdaptations([{ ...STEADY }], state, 330);
    expect(steady.d).toMatch(/^19km @ steady/);
    expect(ff.d).toBe(steady.d);
    expect(ff.n).toBe('Long Run');
    expect(ff.modReason).toBe(steady.modReason);
  });
});
