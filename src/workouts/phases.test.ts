import { describe, it, expect } from 'vitest';
import { computePlanPhases } from './phases';

function countByPhase(weeks: { ph: string }[]): Record<string, number> {
  return weeks.reduce((acc, w) => {
    acc[w.ph] = (acc[w.ph] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

function phaseSequence(weeks: { ph: string }[]): string[] {
  const out: string[] = [];
  for (const w of weeks) {
    if (out[out.length - 1] !== w.ph) out.push(w.ph);
  }
  return out;
}

describe('computePlanPhases', () => {
  it('returns empty for zero or negative length', () => {
    expect(computePlanPhases(0)).toEqual([]);
    expect(computePlanPhases(-3)).toEqual([]);
  });

  it('4-week sharpening block has no base', () => {
    const weeks = computePlanPhases(4);
    expect(weeks).toHaveLength(4);
    const counts = countByPhase(weeks);
    expect(counts.base ?? 0).toBe(0);
    expect(counts.build).toBeGreaterThanOrEqual(1);
    expect(counts.peak).toBeGreaterThanOrEqual(1);
    expect(counts.taper).toBeGreaterThanOrEqual(1);
  });

  it('8-week plan produces a sensible single arc', () => {
    const weeks = computePlanPhases(8);
    expect(weeks).toHaveLength(8);
    expect(phaseSequence(weeks)).toEqual(['base', 'build', 'peak', 'taper']);
  });

  it('16-week plan: base ≈ 6, build ≈ 6, peak ≤ 4, taper ≤ 3', () => {
    const weeks = computePlanPhases(16);
    expect(weeks).toHaveLength(16);
    const counts = countByPhase(weeks);
    expect(counts.base).toBeGreaterThanOrEqual(5);
    expect(counts.build).toBeGreaterThanOrEqual(5);
    expect(counts.peak).toBeLessThanOrEqual(4);
    expect(counts.taper).toBeLessThanOrEqual(3);
    expect(phaseSequence(weeks)).toEqual(['base', 'build', 'peak', 'taper']);
  });

  it('20-week plan caps build at 8 and taper at 3', () => {
    const weeks = computePlanPhases(20);
    expect(weeks).toHaveLength(20);
    const counts = countByPhase(weeks);
    expect(counts.build).toBeLessThanOrEqual(8);
    expect(counts.taper).toBeLessThanOrEqual(3);
    expect(counts.peak).toBeLessThanOrEqual(4);
    expect(phaseSequence(weeks)).toEqual(['base', 'build', 'peak', 'taper']);
  });

  it('32-week plan stays a single arc (no checkpoint)', () => {
    const weeks = computePlanPhases(32);
    expect(weeks).toHaveLength(32);
    expect(weeks.some(w => w.checkpoint)).toBe(false);
    expect(phaseSequence(weeks)).toEqual(['base', 'build', 'peak', 'taper']);
    const counts = countByPhase(weeks);
    expect(counts.build).toBeLessThanOrEqual(8);
    expect(counts.peak).toBeLessThanOrEqual(4);
    expect(counts.taper).toBeLessThanOrEqual(3);
    // Base absorbs the remainder
    expect(counts.base).toBeGreaterThanOrEqual(15);
  });

  it('33-week plan switches to double periodization with one checkpoint and two tapers', () => {
    const weeks = computePlanPhases(33);
    expect(weeks).toHaveLength(33);
    const checkpoints = weeks.filter(w => w.checkpoint);
    expect(checkpoints).toHaveLength(1);
    // Checkpoint sits on a peak week
    expect(checkpoints[0].ph).toBe('peak');
    // Sequence: two complete arcs, transition between cycles labelled 'taper'
    const seq = phaseSequence(weeks);
    expect(seq).toEqual(['base', 'build', 'peak', 'taper', 'base', 'build', 'peak', 'taper']);
  });

  it('cycle 1 ends in a 2-week taper immediately after the checkpoint week', () => {
    const weeks = computePlanPhases(40);
    const checkpointIdx = weeks.findIndex(w => w.checkpoint);
    expect(checkpointIdx).toBeGreaterThan(0);
    // The two weeks immediately after the checkpoint must be taper (inter-cycle recovery)
    expect(weeks[checkpointIdx + 1]?.ph).toBe('taper');
    expect(weeks[checkpointIdx + 2]?.ph).toBe('taper');
    // The week after that should be base (start of cycle 2)
    expect(weeks[checkpointIdx + 3]?.ph).toBe('base');
  });

  it('50-week plan: two cycles, single checkpoint, ends on taper, checkpoint in first half', () => {
    const weeks = computePlanPhases(50);
    expect(weeks).toHaveLength(50);
    const checkpoints = weeks.filter(w => w.checkpoint);
    expect(checkpoints).toHaveLength(1);
    // The plan ends on a taper week (race week)
    expect(weeks[weeks.length - 1].ph).toBe('taper');
    // Cycle 2 taper (the final segment) is capped at 3 weeks
    const finalTaperLen = (() => {
      let n = 0;
      for (let i = weeks.length - 1; i >= 0 && weeks[i].ph === 'taper'; i--) n++;
      return n;
    })();
    expect(finalTaperLen).toBeLessThanOrEqual(3);
    // Checkpoint sits in the first half of the plan (cycle 1)
    const checkpointIdx = weeks.findIndex(w => w.checkpoint);
    expect(checkpointIdx).toBeLessThan(weeks.length / 2);
  });

  it('checkpoint sits on the last peak week of cycle 1', () => {
    const weeks = computePlanPhases(40);
    const checkpointIdx = weeks.findIndex(w => w.checkpoint);
    expect(checkpointIdx).toBeGreaterThan(0);
    // The week after the checkpoint must not be a peak (cycle 1 ends here)
    expect(weeks[checkpointIdx + 1]?.ph).not.toBe('peak');
    // The checkpoint week itself is a peak
    expect(weeks[checkpointIdx].ph).toBe('peak');
  });

  it('50-week plan has exactly two taper segments', () => {
    const weeks = computePlanPhases(50);
    const seq = phaseSequence(weeks);
    const taperSegments = seq.filter(s => s === 'taper').length;
    expect(taperSegments).toBe(2);
  });

  it('every length from 4 to 52 produces totalWeeks weeks', () => {
    for (let n = 4; n <= 52; n++) {
      expect(computePlanPhases(n)).toHaveLength(n);
    }
  });
});
