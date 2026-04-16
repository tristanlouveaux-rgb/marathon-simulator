import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuideController } from './controller';
import type { Workout, Paces, GpsLiveData } from '@/types';
import type { CueEvent } from './engine';

const paces: Paces = { e: 360, m: 280, t: 255, i: 240, r: 230 };

const workout: Workout = {
  n: 'Threshold',
  d: '3×3min @ threshold, 60s',
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

describe('GuideController', () => {
  beforeEach(() => {
    // jsdom has no speechSynthesis — stub it so VoiceCoach.speak is a no-op.
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.speechSynthesis = {
      speak: vi.fn(),
      cancel: vi.fn(),
    };
  });

  it('relays cue events to UI listeners', () => {
    const ctrl = new GuideController(workout, paces, { voice: false, haptics: false });
    const received: CueEvent[] = [];
    ctrl.onCue((e) => received.push(e));
    ctrl.start();
    ctrl.update(live(0, 0));
    expect(received.some((e) => e.type === 'stepStart')).toBe(true);
  });

  it('skipStep advances timeline', () => {
    const ctrl = new GuideController(workout, paces, { voice: false, haptics: false });
    ctrl.start();
    ctrl.update(live(0, 0));
    const first = ctrl.currentStep();
    ctrl.skipStep();
    const next = ctrl.currentStep();
    expect(next?.idx).not.toBe(first?.idx);
  });

  it('destroy stops voice and detaches listeners', () => {
    const ctrl = new GuideController(workout, paces);
    const received: CueEvent[] = [];
    ctrl.onCue((e) => received.push(e));
    ctrl.start();
    ctrl.destroy();
    ctrl.update(live(0, 0));
    expect(received).toHaveLength(0);
  });
});
