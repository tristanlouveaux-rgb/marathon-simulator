import { describe, it, expect } from 'vitest';
import { computePlanPhases, computeRunningPlanPhases, isSharpeningBlock, FULL_BUILD_WEEKS } from './phases';
import { computeTriPlanPhases } from '@/constants/triathlon-constants';
import { computeHyroxPlanPhases } from '@/constants/hyrox-constants';
import type { RaceDistance } from '@/types';

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

describe('taper-first allocation for plans shorter than one week of each phase', () => {
  // Before: a 1-week plan was [build] and a 2-week plan [build, peak] (no taper),
  // because the phases were truncated from the end. The race needs the taper.
  it('generic single arc: 1 = taper, 2 = peak + taper, 3 unchanged', () => {
    expect(computePlanPhases(1).map(w => w.ph)).toEqual(['taper']);
    expect(computePlanPhases(2).map(w => w.ph)).toEqual(['peak', 'taper']);
    expect(computePlanPhases(3).map(w => w.ph)).toEqual(['build', 'peak', 'taper']);
  });

  it('triathlon (every distance) and HYROX end 1- and 2-week plans in a taper week', () => {
    for (const d of ['sprint', 'olympic', '70.3', 'ironman'] as const) {
      expect(computeTriPlanPhases(d, 1).map(w => w.ph), d).toEqual(['taper']);
      expect(computeTriPlanPhases(d, 2).map(w => w.ph), d).toEqual(['peak', 'taper']);
    }
    expect(computeHyroxPlanPhases(1).map(w => w.ph)).toEqual(['taper']);
    // HYROX tapers 2 weeks at every length that holds them (HYROX_TAPER_WEEKS_MIN,
    // 2026-10-12), as the running marathon's 2-week block does.
    expect(computeHyroxPlanPhases(2).map(w => w.ph)).toEqual(['taper', 'taper']);
    expect(computeHyroxPlanPhases(3).map(w => w.ph)).toEqual(['peak', 'taper', 'taper']);
    for (let n = 3; n <= 24; n++) {
      expect(computeHyroxPlanPhases(n).filter(w => w.ph === 'taper'), `${n} weeks`).toHaveLength(2);
    }
  });

  it('plans of 3 or more weeks are unchanged in every format', () => {
    // The ratio split already fits from 3 weeks: one build, one peak, one taper.
    for (let n = 3; n <= 52; n++) {
      expect(computePlanPhases(n)).toHaveLength(n);
      expect(computePlanPhases(n)[n - 1].ph).toBe('taper');
    }
  });
});

describe('running race plans (computeRunningPlanPhases)', () => {
  const seq = (n: number, rd: RaceDistance, noSignal = false) =>
    computeRunningPlanPhases(n, rd, { noSignal }).map(w => w.ph);

  it('FULL_BUILD_WEEKS: marathon 8, every other distance 4', () => {
    expect(FULL_BUILD_WEEKS).toEqual({ '5k': 4, '10k': 4, half: 4, marathon: 8 });
  });

  it('isSharpeningBlock: marathon under 8 weeks, half under 4; never 5K or 10K', () => {
    for (let n = 1; n <= 7; n++) expect(isSharpeningBlock('marathon', n)).toBe(true);
    expect(isSharpeningBlock('marathon', 8)).toBe(false);
    for (let n = 1; n <= 3; n++) expect(isSharpeningBlock('half', n)).toBe(true);
    expect(isSharpeningBlock('half', 4)).toBe(false);
    expect(isSharpeningBlock('10k', 2)).toBe(false);
    expect(isSharpeningBlock('5k', 1)).toBe(false);
    expect(isSharpeningBlock('marathon', 0)).toBe(false);
    expect(isSharpeningBlock(null, 3)).toBe(false);
  });

  it('marathon block: taper first (2 weeks from 2 weeks out), then one peak week, then build, no base', () => {
    expect(seq(1, 'marathon')).toEqual(['taper']);
    expect(seq(2, 'marathon')).toEqual(['taper', 'taper']);
    expect(seq(3, 'marathon')).toEqual(['peak', 'taper', 'taper']);
    expect(seq(4, 'marathon')).toEqual(['build', 'peak', 'taper', 'taper']);
    expect(seq(5, 'marathon')).toEqual(['build', 'build', 'peak', 'taper', 'taper']);
    expect(seq(6, 'marathon')).toEqual(['build', 'build', 'build', 'peak', 'taper', 'taper']);
    expect(seq(7, 'marathon')).toEqual(['build', 'build', 'build', 'build', 'peak', 'taper', 'taper']);
  });

  it('half block: 1 = race week, 2 = peak + race week, 3 = build + peak + race week; 4 is the full build', () => {
    expect(seq(1, 'half')).toEqual(['taper']);
    expect(seq(2, 'half')).toEqual(['peak', 'taper']);
    expect(seq(3, 'half')).toEqual(['build', 'peak', 'taper']);
    expect(seq(4, 'half')).toEqual(['build', 'build', 'peak', 'taper']);
  });

  it('the 8-week marathon gets the 2-week taper (one base week fewer)', () => {
    expect(seq(8, 'marathon')).toEqual(['base', 'base', 'build', 'build', 'build', 'peak', 'taper', 'taper']);
  });

  it('full plans are otherwise unchanged: marathon from 9 weeks, half/10K/5K at every length', () => {
    for (let n = 9; n <= 52; n++) expect(seq(n, 'marathon'), `marathon ${n}`).toEqual(computePlanPhases(n).map(w => w.ph));
    for (const rd of ['half', '10k', '5k'] as RaceDistance[]) {
      for (let n = 4; n <= 52; n++) expect(seq(n, rd), `${rd} ${n}`).toEqual(computePlanPhases(n).map(w => w.ph));
    }
  });

  it('no real fitness signal: a block has no peak week; full plans keep theirs', () => {
    expect(seq(7, 'marathon', true)).toEqual(['build', 'build', 'build', 'build', 'build', 'taper', 'taper']);
    expect(seq(3, 'marathon', true)).toEqual(['build', 'taper', 'taper']);
    expect(seq(2, 'half', true)).toEqual(['build', 'taper']);
    expect(seq(12, 'marathon', true)).toEqual(seq(12, 'marathon'));
  });

  it('every length 1 to 52 produces exactly that many weeks, ending in a taper', () => {
    for (const rd of ['marathon', 'half', '10k', '5k'] as RaceDistance[]) {
      for (let n = 1; n <= 52; n++) {
        const s = seq(n, rd);
        expect(s, `${rd} ${n}`).toHaveLength(n);
        expect(s[n - 1], `${rd} ${n}`).toBe('taper');
      }
    }
  });
});
