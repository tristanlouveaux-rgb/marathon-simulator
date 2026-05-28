import { describe, it, expect } from 'vitest';
import { injuryStrengthDecision } from './injury-strength';
import type { InjuryState, InjuryLocation, InjuryPhase } from '@/types/injury';

function makeInjury(overrides: Partial<InjuryState> = {}): InjuryState {
  return {
    active: true,
    type: 'general',
    location: 'knee',
    locationDetail: '',
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
    injuryPhase: 'rehab',
    painLatency: false,
    acutePhaseStartDate: null,
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

const decideFor = (location: InjuryLocation, phase: InjuryPhase = 'rehab') =>
  injuryStrengthDecision(makeInjury({ location, injuryPhase: phase }));

describe('injuryStrengthDecision — passthrough', () => {
  it('returns normal when no injury', () => {
    expect(injuryStrengthDecision(undefined).kind).toBe('normal');
    expect(injuryStrengthDecision(makeInjury({ active: false })).kind).toBe('normal');
  });

  it('returns normal once resolved', () => {
    expect(injuryStrengthDecision(makeInjury({ injuryPhase: 'resolved' })).kind).toBe('normal');
  });
});

describe('injuryStrengthDecision — phase gating', () => {
  it('loads the unaffected region even in the acute phase (region-specific rest)', () => {
    // Acute knee injury: legs rest, upper body can still train.
    const d = decideFor('knee', 'acute');
    expect(d.kind).toBe('adapted');
    if (d.kind === 'adapted') {
      expect(d.workout.n.toLowerCase()).toContain('upper-body');
      expect(d.workout.rpe ?? 99).toBeLessThanOrEqual(3); // lightest in acute
    }
  });

  it('adapts across every recovery phase', () => {
    for (const phase of ['acute', 'rehab', 'test_capacity', 'return_to_run', 'graduated_return'] as InjuryPhase[]) {
      expect(decideFor('knee', phase).kind).toBe('adapted');
    }
  });

  it('still pauses entirely for a both-regions-blocked injury, even acute', () => {
    expect(decideFor('back', 'acute').kind).toBe('none');
  });
});

describe('injuryStrengthDecision — region substitution by location', () => {
  it('leg injury (knee) → upper-body + core, lower-body paused', () => {
    const d = decideFor('knee');
    expect(d.kind).toBe('adapted');
    if (d.kind === 'adapted') {
      expect(d.workout.n.toLowerCase()).toContain('upper-body');
      expect(d.workout.n.toLowerCase()).toContain('core');
      expect(d.workout.n.toLowerCase()).not.toContain('lower-body');
      expect((d.workout.modReason ?? '').toLowerCase()).toContain('lower-body loading paused');
    }
  });

  it('shoulder injury → lower-body + core, upper-body paused', () => {
    const d = decideFor('shoulder');
    expect(d.kind).toBe('adapted');
    if (d.kind === 'adapted') {
      expect(d.workout.n.toLowerCase()).toContain('lower-body');
      expect(d.workout.n.toLowerCase()).not.toContain('upper-body');
      expect((d.workout.modReason ?? '').toLowerCase()).toContain('upper-body loading paused');
    }
  });

  it('back injury → strength paused entirely (both regions blocked)', () => {
    expect(decideFor('back').kind).toBe('none');
  });

  it('trunk injury (neck) excludes the core block', () => {
    // neck → upper 50, lower 100, both loadable, but core (anti-rotation) is omitted.
    const d = decideFor('neck');
    expect(d.kind).toBe('adapted');
    if (d.kind === 'adapted') {
      expect(d.workout.n.toLowerCase()).not.toContain('core');
      expect(d.workout.n.toLowerCase()).toContain('lower-body');
      expect(d.workout.n.toLowerCase()).toContain('upper-body');
    }
  });

  it('foot injury keeps both regions, with a shorter (scaled) lower block', () => {
    // foot → lower 50, upper 100.
    const full = decideFor('hip'); // hip: lower 0 → upper-only (control)
    const foot = decideFor('foot');
    expect(foot.kind).toBe('adapted');
    if (foot.kind === 'adapted') {
      expect(foot.workout.n.toLowerCase()).toContain('lower-body');
      expect(foot.workout.n.toLowerCase()).toContain('upper-body');
    }
    // hip is lower-blocked so it should be upper-only
    if (full.kind === 'adapted') {
      expect(full.workout.n.toLowerCase()).not.toContain('lower-body');
    }
  });
});

describe('injuryStrengthDecision — explicit slider overrides location', () => {
  it('HYROX-style upper=0 override blocks upper even for a leg location', () => {
    const d = injuryStrengthDecision(makeInjury({
      location: 'knee',          // location would allow upper
      upperLoadCapacity: 0,      // but the slider blocks it
      lowerLoadCapacity: 100,    // and allows lower
    }));
    expect(d.kind).toBe('adapted');
    if (d.kind === 'adapted') {
      expect(d.workout.n.toLowerCase()).toContain('lower-body');
      expect(d.workout.n.toLowerCase()).not.toContain('upper-body');
    }
  });
});

describe('injuryStrengthDecision — exercises avoid the injured area', () => {
  const desc = (location: InjuryLocation): string => {
    const d = injuryStrengthDecision(makeInjury({ location, injuryPhase: 'rehab' }));
    return d.kind === 'adapted' ? (d.workout.d ?? '').toLowerCase() : '';
  };

  it('shoulder injury excludes every shoulder-loading exercise', () => {
    const d = desc('shoulder');
    expect(d).not.toContain('plank');        // front + side plank load the shoulder
    expect(d).not.toContain('pallof');       // arm/shoulder press-out
    expect(d).not.toContain('goblet');       // racked hold
    expect(d).not.toContain('glute bridge'); // shoulders bear load on the floor
    expect(d).not.toContain('push-up');
    expect(d).not.toContain('bird dog');     // hand weight-bears
    // and it still prescribes safe leg + core work
    expect(d).toContain('squat'); // bodyweight squat is shoulder-free
    expect(d.length).toBeGreaterThan(0);
  });

  it('wrist injury excludes loaded-grip and weight-bearing-hand exercises', () => {
    const d = desc('wrist');
    expect(d).not.toContain('plank');     // wrist weight-bears
    expect(d).not.toContain('carry');     // loaded grip
    expect(d).not.toContain('curl');      // grip
    expect(d).not.toContain('dumbbell row');
  });

  it('knee injury prescribes upper-body + core (no knee-loading lower work)', () => {
    const d = desc('knee');
    expect(d).not.toContain('squat');
    expect(d).not.toContain('lunge');
    expect(d).not.toContain('wall sit');
    expect(d).not.toContain('step-up');
    // upper + core remain
    expect(d).toContain('pull-apart');
    expect(d).toContain('dead bug');
  });
});

describe('injuryStrengthDecision — submaximal load', () => {
  it('keeps RPE submaximal (<= 5) across recovery phases', () => {
    for (const phase of ['rehab', 'test_capacity', 'return_to_run', 'graduated_return'] as InjuryPhase[]) {
      const d = decideFor('shoulder', phase);
      if (d.kind === 'adapted') expect(d.workout.rpe ?? d.workout.r ?? 99).toBeLessThanOrEqual(5);
    }
  });
});
