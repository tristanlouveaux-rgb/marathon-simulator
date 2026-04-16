import { describe, it, expect } from 'vitest';
import { summariseAdherence, classifyPace, categoriseSplit } from './adherence';
import type { GpsSplit } from '@/types';

function split(partial: Partial<GpsSplit>): GpsSplit {
  return {
    index: 0,
    label: 'Rep 1 of 5',
    distance: 400,
    elapsed: 100,
    pace: 250,
    targetPace: 250,
    ...partial,
  };
}

describe('categoriseSplit', () => {
  it('recognises warm-up, cool-down, recovery, and work reps', () => {
    expect(categoriseSplit('Warm Up')).toBe('warmup');
    expect(categoriseSplit('Cool Down')).toBe('cooldown');
    expect(categoriseSplit('Recovery 1')).toBe('recovery');
    expect(categoriseSplit('Rep 3 of 8')).toBe('work');
    expect(categoriseSplit('Tempo Block')).toBe('work');
    expect(categoriseSplit('km 1')).toBe('other');
  });
});

describe('classifyPace', () => {
  it('returns onPace when within ±5 sec/km', () => {
    expect(classifyPace(253, 250)).toBe('onPace');
    expect(classifyPace(247, 250)).toBe('onPace');
    expect(classifyPace(250, 250)).toBe('onPace');
  });

  it('returns fast when more than 5 sec/km faster (other kind)', () => {
    expect(classifyPace(240, 250)).toBe('fast');
  });

  it('returns slow when more than 5 sec/km slower (other kind)', () => {
    expect(classifyPace(260, 250)).toBe('slow');
  });

  it('applies tighter ±4 s/km tolerance for work reps', () => {
    expect(classifyPace(245, 250, 'work')).toBe('fast');       // -5 exceeds ±4
    expect(classifyPace(246, 250, 'work')).toBe('onPace');     // -4 still inside
    expect(classifyPace(254, 250, 'work')).toBe('onPace');     // +4 still inside
  });

  it('applies looser ±10 s/km tolerance for warmup / cooldown', () => {
    expect(classifyPace(360, 350, 'warmup')).toBe('onPace');
    expect(classifyPace(340, 350, 'cooldown')).toBe('onPace');
    expect(classifyPace(365, 350, 'warmup')).toBe('slow');      // +15 exceeds ±10
  });
});

describe('summariseAdherence', () => {
  it('counts paced, fast, slow, on-pace, and untimed splits', () => {
    const splits: GpsSplit[] = [
      split({ index: 0, label: 'Warm Up', pace: 360, targetPace: 360 }),          // onPace
      split({ index: 1, label: 'Rep 1 of 3', pace: 247, targetPace: 250 }),       // onPace (±4 work)
      split({ index: 2, label: 'Rep 2 of 3', pace: 238, targetPace: 250 }),       // fast
      split({ index: 3, label: 'Recovery 1', pace: 0, targetPace: null as unknown as number }), // untimed
      split({ index: 4, label: 'Rep 3 of 3', pace: 258, targetPace: 250 }),       // slow (>±4)
    ];
    const s = summariseAdherence(splits);
    expect(s.totalSplits).toBe(5);
    expect(s.paced).toHaveLength(4);
    expect(s.onPaceCount).toBe(2);
    expect(s.fastCount).toBe(1);
    expect(s.slowCount).toBe(1);
    expect(s.untimedCount).toBe(1);
    expect(s.hitRate).toBeCloseTo(0.5);
  });

  it('avgDeviationSec is the signed mean across paced splits', () => {
    const splits: GpsSplit[] = [
      split({ index: 0, label: 'Rep 1', pace: 245, targetPace: 250 }),  // -5
      split({ index: 1, label: 'Rep 2', pace: 260, targetPace: 250 }),  // +10
    ];
    const s = summariseAdherence(splits);
    expect(s.avgDeviationSec).toBeCloseTo(2.5);
  });

  it('returns nulls when no paced splits exist', () => {
    const splits: GpsSplit[] = [
      split({ label: 'Recovery 1', pace: 0, targetPace: null as unknown as number }),
    ];
    const s = summariseAdherence(splits);
    expect(s.paced).toHaveLength(0);
    expect(s.hitRate).toBeNull();
    expect(s.avgDeviationSec).toBeNull();
    expect(s.untimedCount).toBe(1);
  });

  it('excludes implausible pace values (0 or infinity)', () => {
    const splits: GpsSplit[] = [
      split({ label: 'Rep 1', pace: 0, targetPace: 250 }),
      split({ label: 'Rep 2', pace: Infinity, targetPace: 250 }),
      split({ label: 'Rep 3', pace: 250, targetPace: 250 }),
    ];
    const s = summariseAdherence(splits);
    expect(s.paced).toHaveLength(1);
    expect(s.untimedCount).toBe(2);
  });
});
