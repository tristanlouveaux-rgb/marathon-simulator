import { describe, it, expect } from 'vitest';
import { intentToWorkout, type SessionIntent } from './intent_to_workout';

const EASY = 370; // 6:10/km

const intent = (slot: SessionIntent['slot'], totalMinutes = 45): SessionIntent => ({
  dayIndex: 0, slot, totalMinutes, workMinutes: totalMinutes,
  variantId: `${slot}_default`, notes: '',
});

describe('intentToWorkout pace targets (every run carries its pacing)', () => {
  it('easy runs embed the easy pace', () => {
    const w = intentToWorkout(intent('easy'), 'marathon', 'Balanced', EASY);
    expect(w.d).toBe('7km @ 6:10/km');
  });

  it('long runs embed the easy pace', () => {
    const w = intentToWorkout(intent('long', 90), 'marathon', 'Balanced', EASY);
    expect(w.d).toMatch(/^\d+km @ 6:10\/km$/);
  });

  it('falls back to bare distance when easy pace is unknown', () => {
    const w = intentToWorkout(intent('easy'), 'marathon', 'Balanced', undefined);
    expect(w.d).toMatch(/^\d+km$/);
  });

  it('threshold sessions keep their derived work pace (unchanged behaviour)', () => {
    const w = intentToWorkout(intent('threshold', 40), 'marathon', 'Balanced', EASY);
    expect(w.d).toContain('@ 5:08/km'); // 370 / 1.2
  });
});
