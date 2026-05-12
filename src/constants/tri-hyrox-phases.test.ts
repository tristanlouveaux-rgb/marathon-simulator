import { describe, it, expect } from 'vitest';
import { computeTriPlanPhases } from './triathlon-constants';
import { computeHyroxPlanPhases } from './hyrox-constants';

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

describe('computeTriPlanPhases — single arc', () => {
  it('70.3 default (20 weeks) reproduces canonical 8/6/4/2 split', () => {
    const weeks = computeTriPlanPhases('70.3', 20);
    expect(weeks).toHaveLength(20);
    const counts = countByPhase(weeks);
    expect(counts.base).toBe(8);
    expect(counts.build).toBe(6);
    expect(counts.peak).toBe(4);
    expect(counts.taper).toBe(2);
    expect(phaseSequence(weeks)).toEqual(['base', 'build', 'peak', 'taper']);
  });

  it('Ironman default (24 weeks) reproduces canonical 10/7/5/2 split', () => {
    const weeks = computeTriPlanPhases('ironman', 24);
    expect(weeks).toHaveLength(24);
    const counts = countByPhase(weeks);
    expect(counts.base).toBe(10);
    expect(counts.build).toBe(7);
    expect(counts.peak).toBe(5);
    expect(counts.taper).toBe(2);
  });

  it('70.3 short plan (12 weeks) stays single arc', () => {
    const weeks = computeTriPlanPhases('70.3', 12);
    expect(weeks).toHaveLength(12);
    expect(weeks.some(w => w.checkpoint)).toBe(false);
    expect(phaseSequence(weeks)).toEqual(['base', 'build', 'peak', 'taper']);
  });

  it('Ironman 27 weeks: just below threshold, single arc, capped phases', () => {
    const weeks = computeTriPlanPhases('ironman', 27);
    expect(weeks).toHaveLength(27);
    expect(weeks.some(w => w.checkpoint)).toBe(false);
    const counts = countByPhase(weeks);
    expect(counts.build).toBeLessThanOrEqual(8);
    expect(counts.peak).toBeLessThanOrEqual(5);
    expect(counts.taper).toBeLessThanOrEqual(2);
  });
});

describe('computeTriPlanPhases — double periodization (≥28 weeks)', () => {
  it('Ironman 30 weeks: two cycles, one checkpoint', () => {
    const weeks = computeTriPlanPhases('ironman', 30);
    expect(weeks).toHaveLength(30);
    const checkpoints = weeks.filter(w => w.checkpoint);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].ph).toBe('peak');
    expect(weeks[weeks.length - 1].ph).toBe('taper');
    expect(phaseSequence(weeks)).toEqual(['base', 'build', 'peak', 'taper', 'base', 'build', 'peak', 'taper']);
  });

  it('70.3 36 weeks: double periodization, checkpoint sits in first half', () => {
    const weeks = computeTriPlanPhases('70.3', 36);
    expect(weeks).toHaveLength(36);
    const checkpointIdx = weeks.findIndex(w => w.checkpoint);
    expect(checkpointIdx).toBeGreaterThan(0);
    expect(checkpointIdx).toBeLessThan(weeks.length / 2);
    // 2-week inter-cycle taper directly after checkpoint
    expect(weeks[checkpointIdx + 1].ph).toBe('taper');
    expect(weeks[checkpointIdx + 2].ph).toBe('taper');
    expect(weeks[checkpointIdx + 3].ph).toBe('base');
  });

  it('Ironman 40 weeks: race-week taper capped at 2', () => {
    const weeks = computeTriPlanPhases('ironman', 40);
    expect(weeks).toHaveLength(40);
    const finalTaperLen = (() => {
      let n = 0;
      for (let i = weeks.length - 1; i >= 0 && weeks[i].ph === 'taper'; i--) n++;
      return n;
    })();
    expect(finalTaperLen).toBeLessThanOrEqual(2);
    expect(weeks[weeks.length - 1].ph).toBe('taper');
  });
});

describe('computeHyroxPlanPhases — single arc', () => {
  it('default plan (18 weeks) reproduces canonical-ish 7/6/3/2 split', () => {
    const weeks = computeHyroxPlanPhases(18);
    expect(weeks).toHaveLength(18);
    const counts = countByPhase(weeks);
    expect(counts.base).toBe(7);
    expect(counts.build).toBe(6);
    expect(counts.peak).toBe(3);
    expect(counts.taper).toBe(2);
  });

  it('short plan (12 weeks) compresses cleanly', () => {
    const weeks = computeHyroxPlanPhases(12);
    expect(weeks).toHaveLength(12);
    expect(phaseSequence(weeks)).toEqual(['base', 'build', 'peak', 'taper']);
    // Hyrox peak cap is 3; for 12w this caps below the raw ratio
    const counts = countByPhase(weeks);
    expect(counts.peak).toBeLessThanOrEqual(3);
  });

  it('20 weeks: peak capped at 3', () => {
    const weeks = computeHyroxPlanPhases(20);
    const counts = countByPhase(weeks);
    expect(counts.peak).toBe(3);
    expect(weeks).toHaveLength(20);
  });
});

describe('computeHyroxPlanPhases — double periodization', () => {
  it('30 weeks: two cycles with one checkpoint', () => {
    const weeks = computeHyroxPlanPhases(30);
    expect(weeks).toHaveLength(30);
    const checkpoints = weeks.filter(w => w.checkpoint);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].ph).toBe('peak');
  });
});
