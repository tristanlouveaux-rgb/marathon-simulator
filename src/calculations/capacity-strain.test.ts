import { describe, it, expect } from 'vitest';
import { computeCapacityStrain, capacityStrainNote, postSessionNote, postSessionSentence, injuryCapOvershootSentence, type CapacityStrain } from './capacity-strain';
import type { SimulatorState } from '@/types/state';

// computeCapacityStrain over minimal state: no weeks → all zeros, nothing anchors.
describe('computeCapacityStrain — minimal state', () => {
  it('returns zeros when there is no current week', () => {
    const s = { w: 1, wks: [], eventType: 'running' } as unknown as SimulatorState;
    const cs = computeCapacityStrain(s);
    expect(cs.todayTSS).toBe(0);
    expect(cs.pctCapacity).toBe(0);
    expect(cs.pctPlan).toBe(0);
    expect(cs.anchorTSS).toBe(0);
    expect(cs.injuryCapOvershoot).toBe(false);
    expect(cs.trainedToday).toBe(false);
  });
});

// postSessionNote: the one post-session sentence every surface prints
// (2026-10-22). One gate (a logged session), one percent (the session's own
// TSS over the capacity anchor, sessionPctCapacity), the ring's number quoted.
describe('postSessionNote — one gate, one percent, the ring\'s number', () => {
  const day: CapacityStrain = {
    todayTSS: 58, sessionTSS: 58, plannedDayTSS: 40, hasPlannedWorkout: true, loggedSessionToday: true, trainedToday: true,
    weeklyCtl: 140, anchorTSS: 40, pctPlan: 145, pctCapacity: 145, sessionPctCapacity: 145,
    ctlAnchored: false, injuryCapOvershoot: false,
  };

  it('the tier reads the session over the capacity anchor, not pctPlan', () => {
    expect(postSessionNote(day)).toBe('Big session today. 58 TSS logged. Rest up and prioritise recovery for the next 24 hours.');
    // Plan 40, CTL/7 50: the same 58 TSS is 116% of capacity, a Solid session.
    expect(postSessionNote({ ...day, weeklyCtl: 350, anchorTSS: 50, pctCapacity: 116, sessionPctCapacity: 116 }))
      .toBe('Solid session today. 58 TSS logged. Rest up and recover.');
  });

  it('passive step load never lifts a partial session into a tier', () => {
    // A 20 TSS session on a 40 TSS plan plus 38 TSS of steps: the strain
    // percent is 145, the session's own percent 50. No verdict yet.
    expect(postSessionNote({ ...day, sessionTSS: 20, sessionPctCapacity: 50 })).toBeNull();
    // A finished session quotes the ring's number (steps included).
    expect(postSessionNote({ ...day, sessionTSS: 44, sessionPctCapacity: 110 }))
      .toBe('Solid session today. 58 TSS logged. Rest up and recover.');
  });

  it('steps alone never print a session line, whatever the percent', () => {
    expect(postSessionNote({ ...day, trainedToday: false, loggedSessionToday: false })).toBeNull();
    expect(capacityStrainNote({ ...day, trainedToday: false, loggedSessionToday: false }, 'Chronic.')).toBeNull();
  });

  it('injury-cap overshoot comes first', () => {
    expect(postSessionNote({ ...day, injuryCapOvershoot: true }))
      .toBe('58 TSS logged against an injury-capped day of 40. That exceeds both the rehab cap and your typical daily load. Rest up and recover.');
  });
});

// capacityStrainNote priority: injury-cap overshoot wins over the strain tiers.
describe('capacityStrainNote — note priority', () => {
  const base: CapacityStrain = {
    todayTSS: 42, sessionTSS: 42, plannedDayTSS: 20, hasPlannedWorkout: true, loggedSessionToday: true, trainedToday: true,
    weeklyCtl: 317, anchorTSS: 45.3, pctPlan: 210, pctCapacity: 93, sessionPctCapacity: 93,
    ctlAnchored: true, injuryCapOvershoot: true,
  };

  it('injury-cap overshoot beats the Good-training tier (dogfood case: 42 vs capped 20, 93% capacity)', () => {
    expect(capacityStrainNote(base)).toBe(
      '42 TSS logged against an injury-capped day of 20. Load is within your normal range, but well above the rehab cap.',
    );
  });

  it('without overshoot, falls through to the capacity tiers', () => {
    expect(capacityStrainNote({ ...base, injuryCapOvershoot: false }))
      .toBe("Good training today. 42 TSS logged, most of a typical day's load.");
  });

  it('null below all tiers when no fallback is supplied (legacy contract)', () => {
    expect(capacityStrainNote({ ...base, injuryCapOvershoot: false, pctCapacity: 60, sessionPctCapacity: 60 })).toBeNull();
  });

  // Trained-day acknowledgment (Tristan, 2026-06-04): a real logged session
  // below the strain tiers must not leave the commentary unphased — the
  // sentence leads with the factual load before the chronic copy.
  it('below the tiers with a fallback, leads with "X TSS logged today."', () => {
    expect(capacityStrainNote(
      { ...base, injuryCapOvershoot: false, pctCapacity: 60, sessionPctCapacity: 60 },
      'Bike load is elevated relative to your baseline.',
    )).toBe('42 TSS logged today. Bike load is elevated relative to your baseline.');
  });

  it('no acknowledgment without a real logged session (passive steps only)', () => {
    expect(capacityStrainNote(
      { ...base, injuryCapOvershoot: false, pctCapacity: 60, sessionPctCapacity: 60, loggedSessionToday: false, trainedToday: false },
      'Bike load is elevated relative to your baseline.',
    )).toBeNull();
  });

  it('tier sentences still win over the acknowledgment when they fire', () => {
    expect(capacityStrainNote(
      { ...base, injuryCapOvershoot: false },
      'Bike load is elevated relative to your baseline.',
    )).toBe("Good training today. 42 TSS logged, most of a typical day's load.");
  });
});
