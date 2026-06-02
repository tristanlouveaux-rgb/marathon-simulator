import { describe, it, expect } from 'vitest';
import { detectStrengthPrs, snapshotNotifiedStrengthPrs } from './strength-marker-bumps';
import type { SimulatorState } from '@/types/state';
import type { StrengthLiftEntry } from '@/types/strength-log';

function mkState(lifts: StrengthLiftEntry[], notifiedPr?: Record<string, number>): SimulatorState {
  const map: Record<string, StrengthLiftEntry> = {};
  for (const l of lifts) map[l.key] = l;
  return { strengthLog: { lifts: map, notifiedPr } } as unknown as SimulatorState;
}

const lift = (key: string, est1rmKg: number, name = key): StrengthLiftEntry => ({
  key, displayName: name, lastWeightKg: 100, lastReps: '5', lastDate: '2026-01-01', est1rmKg,
});

describe('detectStrengthPrs', () => {
  it('returns nothing on first observation (no prior snapshot)', () => {
    const s = mkState([lift('back-squat', 116)]);
    expect(detectStrengthPrs(s)).toEqual([]);
  });

  it('surfaces a PR when est1RM beats the snapshot by >= threshold', () => {
    const s = mkState([lift('back-squat', 120, 'Back Squat')], { 'back-squat': 116 });
    const prs = detectStrengthPrs(s);
    expect(prs).toHaveLength(1);
    expect(prs[0].key).toBe('back-squat');
    expect(prs[0].toastText).toContain('Back Squat 1RM');
  });

  it('ignores sub-threshold improvements', () => {
    const s = mkState([lift('back-squat', 117)], { 'back-squat': 116 }); // +1 < 2.5
    expect(detectStrengthPrs(s)).toEqual([]);
  });

  it('is silent on regressions', () => {
    const s = mkState([lift('back-squat', 110)], { 'back-squat': 116 });
    expect(detectStrengthPrs(s)).toEqual([]);
  });

  it('handles no strengthLog', () => {
    expect(detectStrengthPrs({} as SimulatorState)).toEqual([]);
  });
});

describe('snapshotNotifiedStrengthPrs', () => {
  it('captures current est1RM for every lift', () => {
    const s = mkState([lift('back-squat', 120), lift('deadlift', 150)]);
    snapshotNotifiedStrengthPrs(s);
    expect(s.strengthLog!.notifiedPr).toEqual({ 'back-squat': 120, 'deadlift': 150 });
  });

  it('after snapshot, the same value no longer fires', () => {
    const s = mkState([lift('back-squat', 120)], { 'back-squat': 116 });
    expect(detectStrengthPrs(s)).toHaveLength(1);
    snapshotNotifiedStrengthPrs(s);
    expect(detectStrengthPrs(s)).toEqual([]);
  });
});
