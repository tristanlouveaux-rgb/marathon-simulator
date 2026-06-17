import { describe, it, expect, afterEach } from 'vitest';
import { derivePlanShape } from './plan-shape';
import { initializeWeeks } from '@/workouts';
import { updateState, resetState } from '@/state';
import type { SimulatorState } from '@/types';

/**
 * Bug 2 guard: the per-phase session mix must carry LOAD, and the aerobic-vs-
 * quality split must be derivable from load so low-frequency continuous plans
 * (1 easy + 1 quality every phase) still show a phase shift instead of a flat
 * 50/50. See plan-shape.ts SessionBucket.load + coach-contract renderSessionShift.
 */
function continuousState(rw: number): SimulatorState {
  const tw = 16;
  const wks = initializeWeeks(tw);
  const blockPhases = ['base', 'build', 'peak', 'taper'] as const;
  for (let i = 0; i < wks.length; i++) wks[i].ph = blockPhases[i % 4];
  return {
    rw, rd: '10k', typ: 'Balanced', tw, v: 45, gs: 0,
    pac: { e: 360 }, wks, continuousMode: true, wkm: rw * 6,
  } as unknown as SimulatorState;
}

const qualityLoadPct = (buckets: { key: string; load: number }[]): number => {
  let aer = 0, qual = 0;
  for (const b of buckets) (b.key === 'easy' || b.key === 'long' ? (aer += b.load) : (qual += b.load));
  return Math.round((qual / (aer + qual || 1)) * 100);
};

describe('derivePlanShape: load-weighted session mix', () => {
  afterEach(() => resetState());

  it('every bucket carries a load figure', () => {
    const s = continuousState(4);
    updateState(s);
    const shape = derivePlanShape(s);
    expect(shape.mix.length).toBeGreaterThan(0);
    for (const b of shape.mix) expect(b.load).toBeGreaterThan(0);
  });

  it('load-weighted quality% rises base → peak even at 3 runs/wk (count would be flatter)', () => {
    const s = continuousState(3);
    updateState(s);
    const shape = derivePlanShape(s);
    const byPhase = Object.fromEntries(shape.mixByPhase.map((pm) => [pm.ph, qualityLoadPct(pm.buckets)]));
    // The peak phase is more quality-dominated than the base phase by load.
    expect(byPhase.peak).toBeGreaterThan(byPhase.base);
    // And the split is genuinely differentiated (not a flat 50/50 collapse).
    expect(byPhase.peak - byPhase.base).toBeGreaterThanOrEqual(10);
  });
});
