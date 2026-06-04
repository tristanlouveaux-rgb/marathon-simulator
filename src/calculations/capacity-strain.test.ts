import { describe, it, expect } from 'vitest';
import { computeCapacityStrain, capacityStrainNote, postSessionSentence, injuryCapOvershootSentence, type CapacityStrain } from './capacity-strain';
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
  });
});

// capacityStrainNote priority: injury-cap overshoot wins over the strain tiers.
describe('capacityStrainNote — note priority', () => {
  const base: CapacityStrain = {
    todayTSS: 42, plannedDayTSS: 20, hasPlannedWorkout: true, loggedSessionToday: true,
    weeklyCtl: 317, anchorTSS: 45.3, pctPlan: 210, pctCapacity: 93,
    ctlAnchored: true, injuryCapOvershoot: true,
  };

  it('injury-cap overshoot beats the Good-training tier (dogfood case: 42 vs capped 20, 93% capacity)', () => {
    expect(capacityStrainNote(base)).toBe(
      '42 TSS logged against an injury-capped day of 20. Load is within your normal range, but well above the rehab cap.',
    );
  });

  it('without overshoot, falls through to the capacity tiers', () => {
    expect(capacityStrainNote({ ...base, injuryCapOvershoot: false }))
      .toBe("Good training today (42 TSS), most of a typical day's load.");
  });

  it('null below all tiers when no fallback is supplied (legacy contract)', () => {
    expect(capacityStrainNote({ ...base, injuryCapOvershoot: false, pctCapacity: 60 })).toBeNull();
  });

  // Trained-day acknowledgment (Tristan, 2026-06-04): a real logged session
  // below the strain tiers must not leave the commentary unphased — the
  // sentence leads with the factual load before the chronic copy.
  it('below the tiers with a fallback, leads with "X TSS logged today."', () => {
    expect(capacityStrainNote(
      { ...base, injuryCapOvershoot: false, pctCapacity: 60 },
      'Bike load is elevated relative to your baseline.',
    )).toBe('42 TSS logged today. Bike load is elevated relative to your baseline.');
  });

  it('no acknowledgment without a real logged session (passive steps only)', () => {
    expect(capacityStrainNote(
      { ...base, injuryCapOvershoot: false, pctCapacity: 60, loggedSessionToday: false },
      'Bike load is elevated relative to your baseline.',
    )).toBeNull();
  });

  it('tier sentences still win over the acknowledgment when they fire', () => {
    expect(capacityStrainNote(
      { ...base, injuryCapOvershoot: false },
      'Bike load is elevated relative to your baseline.',
    )).toBe("Good training today (42 TSS), most of a typical day's load.");
  });
});
