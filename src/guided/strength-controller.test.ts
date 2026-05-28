import { describe, it, expect } from 'vitest';
import { StrengthGuideController, type StrengthCueEvent, type Ticker } from './strength-controller';
import { parseStrengthSession } from './strength-model';
import type { Workout } from '@/types';

/** Test ticker: never auto-fires — tests drive `controller.tick(d)` manually. */
const noopTicker: Ticker = () => () => {};

const session = (lines: string[]) =>
  parseStrengthSession({ t: 'gym', n: 'Strength', d: lines.join('\n') } as Workout)!;

function harness(lines: string[]) {
  const events: StrengthCueEvent[] = [];
  const s = session(lines);
  const c = new StrengthGuideController(s, { ticker: noopTicker, onCue: e => events.push(e) });
  return { c, s, events, typesOf: () => events.map(e => e.type) };
}

describe('StrengthGuideController — start + completion', () => {
  it('emits setStart for the first set on start()', () => {
    const { c, events } = harness(['2x10 Squat (45s rest)', '2x8 Plank (30s rest)']);
    c.start();
    expect(events[0].type).toBe('setStart');
    expect(events[0].set?.exerciseName).toBe('Squat');
    expect(c.phase).toBe('active');
  });

  it('walks set -> rest -> next set -> rest -> ... -> complete on the last set', () => {
    const { c, typesOf } = harness(['2x10 Squat (5s rest)', '2x8 Plank (5s rest)']);
    c.start();
    // 4 sets total. Each completeSet (except last) -> rest; rest hits 0 -> next setStart.
    c.completeSet();           // set 1/4 done -> rest 5s
    expect(c.phase).toBe('resting');
    expect(c.restRemainingSec).toBe(5);
    for (let i = 0; i < 5; i++) c.tick(1);  // rest finishes
    expect(c.phase).toBe('active');
    expect(c.currentSet()?.exerciseName).toBe('Squat');
    expect(c.currentSet()?.setIndex).toBe(1);

    c.completeSet();           // set 2/4 done -> rest
    for (let i = 0; i < 5; i++) c.tick(1);
    expect(c.currentSet()?.exerciseName).toBe('Plank');
    expect(c.currentSet()?.setIndex).toBe(0);

    c.completeSet();           // set 3/4 done -> rest
    for (let i = 0; i < 5; i++) c.tick(1);
    c.completeSet();           // set 4/4: no rest -> complete
    expect(c.phase).toBe('done');
    expect(typesOf().filter(t => t === 'complete')).toHaveLength(1);
    expect(typesOf().filter(t => t === 'setStart')).toHaveLength(4);
  });

  it('skips the rest screen when the set has restSec=0', () => {
    const { c, typesOf } = harness(['2x10 Squat (0s rest)']);
    c.start();
    c.completeSet();   // restSec=0 -> advance straight to next set
    expect(typesOf().filter(t => t === 'restStart')).toHaveLength(0);
    expect(c.currentSet()?.setIndex).toBe(1);
  });

  it('suppresses the rest after the final set (just finishes)', () => {
    const { c, typesOf } = harness(['1x10 Squat (60s rest)']);
    c.start();
    c.completeSet();   // last set: no rest, just finish
    expect(c.phase).toBe('done');
    expect(typesOf().filter(t => t === 'restStart')).toHaveLength(0);
  });
});

describe('StrengthGuideController — rest controls', () => {
  it('skipRest() ends the countdown immediately', () => {
    const { c } = harness(['2x10 Squat (30s rest)']);
    c.start();
    c.completeSet();
    expect(c.phase).toBe('resting');
    c.skipRest();
    expect(c.phase).toBe('active');
    expect(c.currentSet()?.setIndex).toBe(1);
  });

  it('extendRest(30) adds to the remaining countdown', () => {
    const { c } = harness(['2x10 Squat (30s rest)']);
    c.start();
    c.completeSet();
    c.extendRest(30);
    expect(c.restRemainingSec).toBe(60);
  });

  it('ignores rest controls when not resting', () => {
    const { c } = harness(['2x10 Squat (30s rest)']);
    c.start();
    expect(c.phase).toBe('active');
    c.skipRest();             // no-op
    c.extendRest(30);         // no-op
    expect(c.phase).toBe('active');
    expect(c.restRemainingSec).toBe(0);
  });
});

describe('StrengthGuideController — elapsed clock', () => {
  it('accumulates elapsedSec on every tick, in any non-idle phase', () => {
    const { c } = harness(['2x10 Squat (5s rest)']);
    c.start();
    c.tick(2); c.tick(3);          // active, +5
    c.completeSet();               // -> resting (5s)
    c.tick(2); c.tick(3);          // rest finishes; +5 elapsed
    expect(c.elapsedSec).toBe(10);
  });

  it('does not tick after finish()', () => {
    const { c } = harness(['1x10 Squat (0s rest)']);
    c.start();
    c.completeSet();
    expect(c.phase).toBe('done');
    c.tick(10);
    expect(c.elapsedSec).toBe(0);
  });
});

describe('StrengthGuideController — completedSets progress', () => {
  it('reports sets completed so far', () => {
    const { c } = harness(['2x10 Squat (5s rest)']);
    c.start();
    expect(c.completedSets).toBe(0);
    c.completeSet();                  // set 1 done -> resting (counts as done)
    expect(c.completedSets).toBe(1);
    c.skipRest();                      // -> next set, still 1 done
    expect(c.completedSets).toBe(1);
    c.completeSet();                   // set 2 done -> finish
    expect(c.completedSets).toBe(2);
    expect(c.totalSets).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Per-set time records (logged for all workouts, used by HYROX prediction
// updates and the finish-summary breakdown).
// ────────────────────────────────────────────────────────────────────────────

describe('StrengthGuideController — per-set time records', () => {
  it('captures the elapsed-since-set-start duration on completeSet', () => {
    const { c } = harness(['2x10 Squat (5s rest)']);
    c.start();
    c.tick(7);             // 7s on set 1
    c.completeSet();
    c.skipRest();          // start set 2
    c.tick(11);            // 11s on set 2
    c.completeSet();       // last -> finish
    const recs = c.setRecords;
    expect(recs).toHaveLength(2);
    expect(recs[0].durationSec).toBe(7);
    expect(recs[1].durationSec).toBe(11);
    expect(recs[0].exerciseName).toBe('Squat');
    expect(recs[1].setIndex).toBe(1);
  });

  it('exposes the last record while resting (for the rest-screen display)', () => {
    const { c } = harness(['2x10 Squat (5s rest)']);
    c.start();
    c.tick(4);
    c.completeSet();
    expect(c.lastRecord()?.durationSec).toBe(4);
    expect(c.phase).toBe('resting');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Manual-advance (HYROX): unbounded rest, user taps to start the next station.
// ────────────────────────────────────────────────────────────────────────────

function harnessManual(lines: string[]) {
  const events: StrengthCueEvent[] = [];
  const s = session(lines);
  const c = new StrengthGuideController(s, { ticker: noopTicker, onCue: e => events.push(e), manualAdvance: true });
  return { c, events, typesOf: () => events.map(e => e.type) };
}

describe('StrengthGuideController — manual-advance (HYROX)', () => {
  it('enters paused, not resting, on completeSet', () => {
    const { c, typesOf } = harnessManual(['1x100 Wall Balls (0s rest)', '1x50 Sled Push (0s rest)']);
    c.start();
    c.tick(120);
    c.completeSet();
    expect(c.phase).toBe('paused');
    expect(typesOf()).toContain('pauseStart');
    expect(typesOf()).not.toContain('restStart');
  });

  it('does not auto-advance when ticking in paused (rest is unbounded)', () => {
    const { c } = harnessManual(['1x100 Wall Balls (0s rest)', '1x50 Sled Push (0s rest)']);
    c.start();
    c.tick(60);
    c.completeSet();
    c.tick(600);   // user takes 10 min off
    expect(c.phase).toBe('paused');
    expect(c.currentSet()?.exerciseName).toBe('Wall Balls'); // still on station 1 until startNextSet
  });

  it('startNextSet() exits paused and begins the next station', () => {
    const { c } = harnessManual(['1x100 Wall Balls (0s rest)', '1x50 Sled Push (0s rest)']);
    c.start();
    c.tick(30);
    c.completeSet();
    c.startNextSet();
    expect(c.phase).toBe('active');
    expect(c.currentSet()?.exerciseName).toBe('Sled Push');
  });

  it('per-station times are isolated (the long rest does not bleed into station 2)', () => {
    const { c } = harnessManual(['1x100 Wall Balls (0s rest)', '1x50 Sled Push (0s rest)']);
    c.start();
    c.tick(40);
    c.completeSet();         // station 1: 40s
    c.tick(300);             // long rest, paused
    c.startNextSet();
    c.tick(25);
    c.completeSet();         // station 2: 25s
    const recs = c.setRecords;
    expect(recs[0].durationSec).toBe(40);
    expect(recs[1].durationSec).toBe(25);
  });

  it('elapsed clock keeps running while paused so total session time stays honest', () => {
    const { c } = harnessManual(['1x100 Wall Balls (0s rest)', '1x50 Sled Push (0s rest)']);
    c.start();
    c.tick(40);
    c.completeSet();
    c.tick(120);    // 2 min paused
    expect(c.elapsedSec).toBe(160);
  });

  it('pauseElapsedSec ticks up while paused, resets to 0 once the next station starts', () => {
    const { c } = harnessManual(['1x100 Wall Balls (0s rest)', '1x50 Sled Push (0s rest)']);
    c.start();
    c.tick(40);
    c.completeSet();
    c.tick(45);
    expect(c.pauseElapsedSec).toBe(45);
    c.startNextSet(0);    // skip countdown -> active
    expect(c.pauseElapsedSec).toBe(0);
  });
});

describe('StrengthGuideController — pre-station countdown', () => {
  it('startNextSet(5) enters countdown, not active', () => {
    const { c, typesOf } = harnessManual(['1x100 Wall Balls (0s rest)', '1x50 Sled Push (0s rest)']);
    c.start();
    c.tick(30);
    c.completeSet();
    c.startNextSet(5);
    expect(c.phase).toBe('countdown');
    expect(c.countdownRemainingSec).toBe(5);
    expect(typesOf()).toContain('countdownStart');
  });

  it('decrements the countdown on tick and advances to active at zero', () => {
    const { c } = harnessManual(['1x100 Wall Balls (0s rest)', '1x50 Sled Push (0s rest)']);
    c.start();
    c.tick(30);
    c.completeSet();
    c.startNextSet(5);
    c.tick(1); c.tick(1); c.tick(1); c.tick(1);
    expect(c.phase).toBe('countdown');
    expect(c.countdownRemainingSec).toBe(1);
    c.tick(1);
    expect(c.phase).toBe('active');
    expect(c.currentSet()?.exerciseName).toBe('Sled Push');
  });

  it('countdown seconds do not bleed into the next set duration', () => {
    const { c } = harnessManual(['1x100 Wall Balls (0s rest)', '1x50 Sled Push (0s rest)']);
    c.start();
    c.tick(60);
    c.completeSet();        // Wall Balls: 60s
    c.startNextSet(5);
    for (let i = 0; i < 5; i++) c.tick(1);
    c.tick(20);             // 20s of Sled Push
    c.completeSet();
    const recs = c.setRecords;
    expect(recs[0].durationSec).toBe(60);
    expect(recs[1].durationSec).toBe(20);
  });

  it('startNextSet(0) skips the countdown and goes straight to active', () => {
    const { c, typesOf } = harnessManual(['1x100 Wall Balls (0s rest)', '1x50 Sled Push (0s rest)']);
    c.start();
    c.tick(30);
    c.completeSet();
    c.startNextSet(0);
    expect(c.phase).toBe('active');
    expect(typesOf()).not.toContain('countdownStart');
  });
});
