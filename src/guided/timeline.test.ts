import { describe, it, expect } from 'vitest';
import { buildTimeline } from './timeline';
import type { Workout, Paces } from '@/types';

const paces: Paces = {
  e: 360,
  m: 280,
  t: 255,
  i: 240,
  r: 230,
};

function wk(d: string, t = 'easy'): Workout {
  return { n: 'test', d, r: 5, t };
}

describe('buildTimeline', () => {
  it('simple distance becomes a single easy step', () => {
    const tl = buildTimeline(wk('8km'), paces);
    expect(tl.steps).toHaveLength(1);
    expect(tl.steps[0].type).toBe('easy');
    expect(tl.steps[0].distanceM).toBe(8000);
    expect(tl.steps[0].targetPaceSec).toBe(360);
    expect(tl.isStructured).toBe(false);
  });

  it('long run marked as long when >= 18km', () => {
    const tl = buildTimeline(wk('22km', 'long'), paces);
    expect(tl.steps[0].type).toBe('long');
  });

  it('time-based intervals emit work + recovery steps', () => {
    const tl = buildTimeline(wk('5×3min @ threshold, 90s', 'threshold'), paces);
    // 5 work + 4 recovery
    expect(tl.steps).toHaveLength(9);
    expect(tl.steps[0].type).toBe('work');
    expect(tl.steps[0].durationSec).toBe(180);
    expect(tl.steps[0].targetPaceSec).toBe(255);
    expect(tl.steps[0].repIdx).toBe(1);
    expect(tl.steps[0].repTotal).toBe(5);
    expect(tl.steps[1].type).toBe('recovery');
    expect(tl.steps[1].durationSec).toBe(90);
    expect(tl.steps[8].type).toBe('work');
    expect(tl.steps[8].repIdx).toBe(5);
    expect(tl.isStructured).toBe(true);
  });

  it('time-intervals with min-rest (3×10min @ threshold, 2min)', () => {
    const tl = buildTimeline(wk('3×10min @ threshold, 2min', 'threshold'), paces);
    expect(tl.steps).toHaveLength(5);
    expect(tl.steps[0].durationSec).toBe(600);
    expect(tl.steps[1].durationSec).toBe(120);
  });

  it('distance intervals in meters (8×800 @ 5k, 90s)', () => {
    const tl = buildTimeline(wk('8×800 @ 5k, 90s', 'vo2'), paces);
    expect(tl.steps).toHaveLength(15);
    expect(tl.steps[0].type).toBe('work');
    expect(tl.steps[0].distanceM).toBe(800);
    expect(tl.steps[0].targetPaceSec).toBe(paces.i);
    expect(tl.steps[1].durationSec).toBe(90);
  });

  it('long intervals in km (2×10km @ MP, 2min)', () => {
    const tl = buildTimeline(wk('2×10km @ MP, 2min', 'marathon_pace'), paces);
    expect(tl.steps).toHaveLength(3);
    expect(tl.steps[0].distanceM).toBe(10000);
    expect(tl.steps[0].targetPaceSec).toBe(paces.m);
    expect(tl.steps[1].durationSec).toBe(120);
    expect(tl.steps[2].distanceM).toBe(10000);
  });

  it('wraps warmup and cooldown around the main set', () => {
    const desc = '2km warm up\n5×3min @ threshold, 90s\n2km cool down';
    const tl = buildTimeline(wk(desc, 'threshold'), paces);
    expect(tl.steps[0].type).toBe('warmup');
    expect(tl.steps[0].distanceM).toBe(2000);
    expect(tl.steps[tl.steps.length - 1].type).toBe('cooldown');
    expect(tl.steps[tl.steps.length - 1].distanceM).toBe(2000);
    // 1 warmup + 5 work + 4 recovery + 1 cooldown
    expect(tl.steps).toHaveLength(11);
  });

  it('progressive run splits easy + fast finish', () => {
    const tl = buildTimeline(wk('21km: last 5 @ HM', 'progressive'), paces);
    expect(tl.steps).toHaveLength(2);
    expect(tl.steps[0].type).toBe('easy');
    expect(tl.steps[0].distanceM).toBe(16000);
    expect(tl.steps[1].type).toBe('work');
    expect(tl.steps[1].distanceM).toBe(5000);
  });

  it('distance at pace (20km @ MP)', () => {
    const tl = buildTimeline(wk('20km @ MP', 'marathon_pace'), paces);
    expect(tl.steps).toHaveLength(1);
    expect(tl.steps[0].distanceM).toBe(20000);
    expect(tl.steps[0].targetPaceSec).toBe(paces.m);
  });

  it('time at zone (20min @ threshold)', () => {
    const tl = buildTimeline(wk('20min @ threshold', 'threshold'), paces);
    expect(tl.steps).toHaveLength(1);
    expect(tl.steps[0].durationSec).toBe(1200);
    expect(tl.steps[0].targetPaceSec).toBe(paces.t);
  });

  it('explicit pace continuous (13min @ 4:05/km)', () => {
    const tl = buildTimeline(wk('13min @ 4:05/km', 'threshold'), paces);
    expect(tl.steps).toHaveLength(1);
    expect(tl.steps[0].durationSec).toBe(780);
    expect(tl.steps[0].targetPaceSec).toBe(245);
  });

  it('mixed paces emit one step per segment', () => {
    const tl = buildTimeline(wk('10@MP, 4@10K, 5@HM', 'mixed'), paces);
    expect(tl.steps).toHaveLength(3);
    expect(tl.steps[0].distanceM).toBe(10000);
    expect(tl.steps[1].distanceM).toBe(4000);
    expect(tl.steps[2].distanceM).toBe(5000);
  });

  it('totals reflect sum of step durations and distances', () => {
    const tl = buildTimeline(wk('3×10min @ threshold, 2min', 'threshold'), paces);
    // 3*10min work + 2*2min rest = 34 min
    expect(tl.totalDurationSec).toBe(34 * 60);
  });

  it('unparseable descriptions return empty step list', () => {
    const tl = buildTimeline(wk('freestyle swim', 'cross' as unknown as string), paces);
    expect(tl.steps).toHaveLength(0);
    expect(tl.isStructured).toBe(false);
  });

  it('steps receive sequential idx', () => {
    const tl = buildTimeline(wk('3×3min @ threshold, 60s', 'threshold'), paces);
    tl.steps.forEach((s, i) => expect(s.idx).toBe(i));
  });
});
