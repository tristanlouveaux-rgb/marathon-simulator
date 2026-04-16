import { describe, it, expect } from 'vitest';
import { GuideEngine, type CueEvent } from './engine';
import { buildTimeline } from './timeline';
import type { Workout, Paces, GpsLiveData } from '@/types';

const paces: Paces = { e: 360, m: 280, t: 255, i: 240, r: 230 };

function wk(d: string, t = 'threshold'): Workout {
  return { n: 'test', d, r: 5, t };
}

function live(
  elapsed: number,
  dist: number,
  status: GpsLiveData['status'] = 'tracking',
  currentPace: number | null = null,
): GpsLiveData {
  return {
    status,
    totalDistance: dist,
    elapsed,
    currentPace,
    currentSplit: null,
    completedSplits: [],
    points: 0,
    accuracy: null,
  };
}

function collect(engine: GuideEngine): CueEvent[] {
  const events: CueEvent[] = [];
  engine.onCue((e) => events.push(e));
  return events;
}

describe('GuideEngine', () => {
  it('emits stepStart on first update', () => {
    const tl = buildTimeline(wk('3×3min @ threshold, 60s'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('stepStart');
    expect((events[0] as any).step.repIdx).toBe(1);
  });

  it('advances to next step when duration elapses', () => {
    const tl = buildTimeline(wk('3×3min @ threshold, 60s'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    engine.update(live(180, 0));     // end of first 3min rep
    engine.update(live(181, 0));     // recovery step begins

    const types = events.map((e) => e.type);
    expect(types).toContain('stepEnd');
    // Next stepStart should be for recovery
    const starts = events.filter((e) => e.type === 'stepStart');
    expect(starts).toHaveLength(2);
    expect((starts[1] as any).step.type).toBe('recovery');
  });

  it('emits halfway cue at ~50% through a duration step', () => {
    const tl = buildTimeline(wk('5min @ threshold'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    engine.update(live(149, 0));   // pre-halfway
    expect(events.some((e) => e.type === 'stepHalfway')).toBe(false);
    engine.update(live(151, 0));   // past halfway (300s/2 = 150)
    expect(events.some((e) => e.type === 'stepHalfway')).toBe(true);
  });

  it('emits silent 5-4-3-2-1 countdown before step end', () => {
    const tl = buildTimeline(wk('3×3min @ threshold, 60s'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    // Tick every second from 175s to 180s (work step ends at 180).
    for (let t = 175; t <= 180; t++) engine.update(live(t, 0));

    const counts = events.filter((e) => e.type === 'stepCountdown').map((e: any) => e.secondsLeft);
    expect(counts).toEqual([5, 4, 3, 2, 1]);
  });

  it('emits stepNextPreview for recovery steps at T-30s', () => {
    const tl = buildTimeline(wk('3×3min @ threshold, 90s'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    // Advance through first work step.
    engine.update(live(0, 0));
    engine.update(live(180, 0));  // end work
    engine.update(live(181, 0));  // recovery begins at elapsed=181, duration 90
    // Preview should fire at recovery-elapsed = 60 (remaining = 30).
    engine.update(live(181 + 60, 0));

    const previews = events.filter((e) => e.type === 'stepNextPreview');
    expect(previews).toHaveLength(1);
    expect((previews[0] as any).nextStep.type).toBe('work');
    expect((previews[0] as any).nextStep.repIdx).toBe(2);
  });

  it('does not advance while paused', () => {
    const tl = buildTimeline(wk('5min @ threshold'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    engine.update(live(60, 0, 'paused'));
    engine.update(live(60, 0, 'paused'));

    const halfway = events.filter((e) => e.type === 'stepHalfway');
    expect(halfway).toHaveLength(0);
  });

  it('emits timelineComplete after the last step finishes', () => {
    const tl = buildTimeline(wk('1min @ threshold'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    engine.update(live(60, 0));

    expect(events.some((e) => e.type === 'timelineComplete')).toBe(true);
  });

  it('skipStep advances without completing naturally', () => {
    const tl = buildTimeline(wk('3×3min @ threshold, 60s'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    engine.skipStep();
    engine.update(live(30, 0));

    const starts = events.filter((e) => e.type === 'stepStart');
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect((starts[1] as any).step.type).toBe('recovery');
  });

  it('advances distance-based steps by tracker distance', () => {
    const tl = buildTimeline(wk('8×400 @ 5k, 60s'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));           // rep 1 start
    engine.update(live(90, 399));        // not done
    engine.update(live(91, 401));        // past 400m → stepEnd
    engine.update(live(92, 401));        // recovery stepStart fires here

    expect(events.some((e) => e.type === 'stepEnd')).toBe(true);
    const starts = events.filter((e) => e.type === 'stepStart');
    expect((starts[1] as any).step.type).toBe('recovery');
  });

  it('emits kmSplit with on-pace status when split is within ±5 sec/km', () => {
    const tl = buildTimeline(wk('5km @ MP'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    // Target MP is 280 sec/km. Cross km 1 at 283s (+3 sec/km) = on pace.
    engine.update(live(283, 1001));

    const splits = events.filter((e) => e.type === 'kmSplit');
    expect(splits).toHaveLength(1);
    expect((splits[0] as any).kmIdx).toBe(1);
    expect((splits[0] as any).status).toBe('onPace');
  });

  it('emits kmSplit with fast status when split is >5 sec/km faster', () => {
    const tl = buildTimeline(wk('5km @ MP'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    // Cross km 1 at 270s (10 sec/km faster than 280 target).
    engine.update(live(270, 1001));

    const split = events.find((e) => e.type === 'kmSplit') as any;
    expect(split.status).toBe('fast');
    expect(split.deviationSec).toBe(-10);
  });

  it('emits kmSplit with slow status when split is >5 sec/km slower', () => {
    const tl = buildTimeline(wk('5km @ MP'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    engine.update(live(290, 1001));  // 10 sec/km slow

    const split = events.find((e) => e.type === 'kmSplit') as any;
    expect(split.status).toBe('slow');
    expect(split.deviationSec).toBe(10);
  });

  it('fires one kmSplit per km boundary', () => {
    const tl = buildTimeline(wk('5km @ MP'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    engine.update(live(280, 1001));
    engine.update(live(560, 2001));
    engine.update(live(840, 3001));

    const splits = events.filter((e) => e.type === 'kmSplit');
    expect(splits.map((s: any) => s.kmIdx)).toEqual([1, 2, 3]);
  });

  it('emits mid-rep paceCheck on short intervals when off target', () => {
    const tl = buildTimeline(wk('5×3min @ threshold, 60s'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    // Short rep duration is 180s; mid-rep check fires ≥30% (54s).
    // target pace 255; currentPace 245 → 10 sec fast
    engine.update(live(60, 0, 'tracking', 245));

    const checks = events.filter((e) => e.type === 'paceCheck');
    expect(checks).toHaveLength(1);
    expect((checks[0] as any).status).toBe('fast');
    expect((checks[0] as any).deviationSec).toBe(-10);
  });

  it('does not emit paceCheck on short rep when within tolerance', () => {
    const tl = buildTimeline(wk('5×3min @ threshold, 60s'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    engine.update(live(60, 0, 'tracking', 253));   // 2 sec fast, within ±5

    expect(events.filter((e) => e.type === 'paceCheck')).toHaveLength(0);
  });

  it('does not emit paceCheck on long continuous steps', () => {
    const tl = buildTimeline(wk('20min @ threshold'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    engine.update(live(400, 0, 'tracking', 240));  // well into step, off pace

    expect(events.filter((e) => e.type === 'paceCheck')).toHaveLength(0);
  });

  it('paceCheck fires at most once per short rep', () => {
    const tl = buildTimeline(wk('5×3min @ threshold, 60s'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    engine.update(live(60, 0, 'tracking', 240));
    engine.update(live(120, 0, 'tracking', 240));

    expect(events.filter((e) => e.type === 'paceCheck')).toHaveLength(1);
  });

  it('extendCurrentStep adds seconds to the active duration step', () => {
    const tl = buildTimeline(wk('1min @ threshold'), paces);
    const engine = new GuideEngine(tl);
    const events = collect(engine);
    engine.start();
    engine.update(live(0, 0));
    engine.extendCurrentStep(30);     // now 90s instead of 60s
    engine.update(live(65, 0));       // would have ended at 60
    expect(events.some((e) => e.type === 'stepEnd')).toBe(false);
    engine.update(live(91, 0));       // now past 90
    expect(events.some((e) => e.type === 'stepEnd')).toBe(true);
  });
});
