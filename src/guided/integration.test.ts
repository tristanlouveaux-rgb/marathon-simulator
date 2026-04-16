import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuideController } from './controller';
import { buildTimeline } from './timeline';
import { buildSplitScheme } from '@/gps/split-scheme';
import { summariseAdherence } from './adherence';
import type { CueEvent } from './engine';
import type { GpsLiveData, GpsSplit, Paces, Workout } from '@/types';

/**
 * End-to-end sanity checks for the guided-run pipeline: workout.d → buildTimeline
 * + buildSplitScheme → controller cues → adherence summary. These catch
 * divergences between the engine's Timeline and the tracker's SplitScheme.
 */

const paces: Paces = { e: 360, m: 280, t: 255, i: 240, r: 230 };

const intervalWorkout: Workout = {
  n: 'Intervals',
  d: '3×3min @ threshold, 2min',
  r: 5,
  t: 'threshold',
};

function live(elapsed: number, dist: number): GpsLiveData {
  return {
    status: 'tracking',
    totalDistance: dist,
    elapsed,
    currentPace: null,
    currentSplit: null,
    completedSplits: [],
    points: 0,
    accuracy: null,
  };
}

describe('guided pipeline — timeline vs split-scheme convergence', () => {
  beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.speechSynthesis = { speak: vi.fn(), cancel: vi.fn() };
  });

  it('timeline and split-scheme produce compatible segment counts for a structured interval', () => {
    const tl = buildTimeline(intervalWorkout, paces);
    const scheme = buildSplitScheme(intervalWorkout.d, paces);

    // Both representations must at least recognise the workout as structured.
    expect(tl.isStructured).toBe(true);
    expect(scheme.segments.length).toBeGreaterThan(0);

    // Work reps appear in both: three "rep" steps in the timeline, three paced
    // segments in the scheme. Recovery counts differ by convention (timeline
    // includes recoveries, scheme may or may not — test only the paced work).
    const workSteps = tl.steps.filter((s) => s.type === 'work');
    const pacedSegs = scheme.segments.filter((s) => s.targetPace != null);
    expect(workSteps.length).toBe(pacedSegs.length);
  });

  it('controller emits stepStart cues in order across the full timeline', () => {
    const ctrl = new GuideController(intervalWorkout, paces, { voice: false, haptics: false });
    const received: CueEvent[] = [];
    ctrl.onCue((e) => received.push(e));
    ctrl.start();

    // Drive the engine forward by advancing elapsed past each step boundary.
    // Use `skipStep` rather than simulating distance — we're testing sequencing,
    // not pace maths.
    const totalSteps = ctrl.getTimeline().steps.length;
    ctrl.update(live(0, 0));
    for (let i = 0; i < totalSteps; i++) {
      ctrl.skipStep();
      ctrl.update(live(1 + i, 10 * (i + 1)));
    }

    const starts = received.filter((e) => e.type === 'stepStart');
    expect(starts.length).toBe(totalSteps);
    // Indices are monotonically increasing.
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] as any).step.idx).toBeGreaterThan((starts[i - 1] as any).step.idx);
    }

    // Timeline should finish.
    expect(received.some((e) => e.type === 'timelineComplete')).toBe(true);
  });

  it('cue log captures every emitted event (last 100)', () => {
    const ctrl = new GuideController(intervalWorkout, paces, { voice: false, haptics: false });
    ctrl.start();
    ctrl.update(live(0, 0));
    const totalSteps = ctrl.getTimeline().steps.length;
    for (let i = 0; i < totalSteps; i++) {
      ctrl.skipStep();
      ctrl.update(live(1 + i, 10 * (i + 1)));
    }
    const log = ctrl.getCueLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((e) => typeof e.ts === 'number' && typeof e.type === 'string')).toBe(true);
  });

  it('split-scheme never diverges from timeline — single-parser invariant', () => {
    // Mirror of split-scheme.test.ts inputs. For every workout the split-scheme
    // recognises as non-empty, the timeline must also recognise it (so the two
    // views can never silently disagree). `isStructured` must be true for any
    // workout that contains interval reps; simple/distance runs are allowed to
    // be unstructured but must still emit at least one step.
    const splitPaces: Paces = { e: 330, t: 270, i: 240, m: 285, r: 210 };
    const cases: Array<{ d: string; structured: boolean; minSegments: number }> = [
      { d: '8×400m @ 5K, 90s', structured: true, minSegments: 1 },
      { d: '4×1km @ threshold, 2min', structured: true, minSegments: 1 },
      { d: '4×1mi @ 10K, 2min', structured: true, minSegments: 1 },
      { d: '3×10min @ threshold, 2min', structured: true, minSegments: 1 },
      { d: '3×3min @ threshold, 60s recovery', structured: true, minSegments: 1 },
      { d: '21km: last 5 @ HM', structured: true, minSegments: 1 },
      { d: '29km: last 10 @ MP', structured: true, minSegments: 1 },
      { d: '20km @ MP', structured: true, minSegments: 1 },
      { d: '8km', structured: false, minSegments: 1 },
      { d: '10.5km', structured: false, minSegments: 1 },
      { d: '5km warmup jog', structured: false, minSegments: 1 },
    ];
    for (const { d, structured, minSegments } of cases) {
      const tl = buildTimeline({ n: '', d, r: 0, t: 'structured' }, splitPaces);
      const scheme = buildSplitScheme(d, splitPaces);
      expect(tl.steps.length, `timeline empty for "${d}"`).toBeGreaterThanOrEqual(minSegments);
      expect(scheme.segments.length, `scheme empty for "${d}"`).toBeGreaterThan(0);
      if (structured) {
        expect(tl.isStructured, `expected "${d}" to be structured`).toBe(true);
        // Every paced segment in the scheme should correspond to a timeline
        // step whose pace matches. Unpaced (recovery) segments are ignored.
        const workStepPaces = tl.steps
          .filter((s) => s.type === 'work' || s.type === 'warmup' || s.type === 'cooldown' || s.type === 'easy' || s.type === 'long')
          .map((s) => s.targetPaceSec)
          .filter((p): p is number => p != null);
        const pacedSegPaces = scheme.segments
          .map((s) => s.targetPace)
          .filter((p): p is number => p != null);
        // Each unique pace in paced segments must appear in the timeline step paces.
        const uniqueSegPaces = Array.from(new Set(pacedSegPaces));
        for (const p of uniqueSegPaces) {
          expect(workStepPaces, `pace ${p} from "${d}" missing in timeline`).toContain(p);
        }
      }
    }
  });

  it('adherence summary from synthetic splits matches expected classifications', () => {
    // Simulate completed splits with kinds that map cleanly to work/warmup.
    const mk = (i: number, label: string, pace: number, target: number): GpsSplit => ({
      index: i, label, distance: 1000, pace, targetPace: target, elapsed: pace,
    });
    const splits: GpsSplit[] = [
      mk(0, 'Warm Up', 355, 360),       // warmup ±10 → onPace
      mk(1, 'Rep 1 of 3', 252, 255),    // work ±4 → onPace
      mk(2, 'Rep 2 of 3', 245, 255),    // -10 → fast
      mk(3, 'Rep 3 of 3', 265, 255),    // +10 → slow
    ];
    const summary = summariseAdherence(splits);
    expect(summary.totalSplits).toBe(4);
    expect(summary.paced).toHaveLength(4);
    expect(summary.onPaceCount).toBe(2); // warmup (±10) + rep 1
    expect(summary.fastCount).toBe(1);
    expect(summary.slowCount).toBe(1);
  });
});
