import { describe, it, expect } from 'vitest';
import { composePhrase } from './voice';
import type { CueEvent } from './engine';
import type { Step } from './timeline';

function step(partial: Partial<Step>): Step {
  return {
    idx: 0,
    type: 'work',
    label: 'Threshold rep 1 of 5',
    durationSec: 180,
    targetPaceSec: 255,
    targetZone: 'threshold',
    repIdx: 1,
    repTotal: 5,
    ...partial,
  };
}

const opts = { splitAnnouncements: true };
const optsOff = { splitAnnouncements: false };

describe('composePhrase', () => {
  it('work stepStart includes "Go", label, duration and pace', () => {
    const s = step({});
    const p = composePhrase(
      { type: 'stepStart', step: s, nextStep: null },
      opts,
    );
    expect(p).toBe('Go. Threshold rep 1 of 5. 3 minutes at 4:15 per kilometre.');
  });

  it('recovery stepStart says Recover with seconds', () => {
    const s = step({ type: 'recovery', label: 'Recovery 1 of 4', durationSec: 90, repIdx: undefined, repTotal: undefined });
    const p = composePhrase(
      { type: 'stepStart', step: s, nextStep: null },
      opts,
    );
    expect(p).toBe('Recover. 90 seconds easy.');
  });

  it('warmup stepStart formats km', () => {
    const s = step({ type: 'warmup', label: 'Warmup', distanceM: 2000, durationSec: undefined, targetPaceSec: 360, repIdx: undefined, repTotal: undefined });
    const p = composePhrase(
      { type: 'stepStart', step: s, nextStep: null },
      opts,
    );
    expect(p).toBe('Warm-up. 2 kilometres easy.');
  });

  it('stepNextPreview announces the upcoming step', () => {
    const current = step({ type: 'recovery', durationSec: 90, repIdx: undefined });
    const next = step({ label: 'Threshold rep 2 of 5', repIdx: 2 });
    const p = composePhrase(
      { type: 'stepNextPreview', step: current, nextStep: next, remainingSec: 30 },
      opts,
    );
    expect(p).toBe('Thirty seconds. Next up: Threshold rep 2 of 5, 3 minutes at 4:15 per kilometre.');
  });

  it('countdown returns null (silent)', () => {
    const s = step({});
    const p = composePhrase({ type: 'stepCountdown', step: s, secondsLeft: 3 }, opts);
    expect(p).toBeNull();
  });

  it('timelineComplete announces completion', () => {
    const p = composePhrase({ type: 'timelineComplete' }, opts);
    expect(p).toBe('Workout complete.');
  });

  it('kmSplit on paced work, on-pace includes the time and "on pace"', () => {
    const s = step({});
    const evt: CueEvent = {
      type: 'kmSplit',
      step: s,
      kmIdx: 3,
      splitTimeSec: 255,
      splitPaceSec: 255,
      targetPaceSec: 255,
      deviationSec: 0,
      status: 'onPace',
    };
    expect(composePhrase(evt, opts)).toBe('Kilometre 3. 4:15. On pace.');
  });

  it('kmSplit fast includes "ease this one"', () => {
    const s = step({});
    const evt: CueEvent = {
      type: 'kmSplit',
      step: s,
      kmIdx: 3,
      splitTimeSec: 248,
      splitPaceSec: 248,
      targetPaceSec: 255,
      deviationSec: -7,
      status: 'fast',
    };
    expect(composePhrase(evt, opts)).toBe('Kilometre 3. 4:08. 7 seconds fast. Ease this one.');
  });

  it('kmSplit slow uses neutral "behind target"', () => {
    const s = step({});
    const evt: CueEvent = {
      type: 'kmSplit',
      step: s,
      kmIdx: 3,
      splitTimeSec: 262,
      splitPaceSec: 262,
      targetPaceSec: 255,
      deviationSec: 7,
      status: 'slow',
    };
    expect(composePhrase(evt, opts)).toBe('Kilometre 3. 4:22. 7 seconds behind target.');
  });

  it('kmSplit on easy step stays silent when on pace or slow', () => {
    const easy = step({ type: 'easy', label: '10 km easy', targetPaceSec: 360, distanceM: 10000, durationSec: undefined, repIdx: undefined, repTotal: undefined });
    const onPace: CueEvent = {
      type: 'kmSplit', step: easy, kmIdx: 2, splitTimeSec: 360,
      splitPaceSec: 360, targetPaceSec: 360, deviationSec: 0, status: 'onPace',
    };
    const slow: CueEvent = { ...onPace, splitTimeSec: 380, splitPaceSec: 380, deviationSec: 20, status: 'slow' };
    expect(composePhrase(onPace, opts)).toBeNull();
    expect(composePhrase(slow, opts)).toBeNull();
  });

  it('kmSplit on easy step speaks when too fast', () => {
    const easy = step({ type: 'easy', label: '10 km easy', targetPaceSec: 360, distanceM: 10000, durationSec: undefined, repIdx: undefined, repTotal: undefined });
    const fast: CueEvent = {
      type: 'kmSplit', step: easy, kmIdx: 2, splitTimeSec: 340,
      splitPaceSec: 340, targetPaceSec: 360, deviationSec: -20, status: 'fast',
    };
    expect(composePhrase(fast, opts)).toBe('Kilometre 2. 5:40. 20 seconds fast. Ease this one.');
  });

  it('kmSplit is silent entirely when splitAnnouncements disabled', () => {
    const s = step({});
    const evt: CueEvent = {
      type: 'kmSplit', step: s, kmIdx: 1, splitTimeSec: 255,
      splitPaceSec: 255, targetPaceSec: 255, deviationSec: 0, status: 'onPace',
    };
    expect(composePhrase(evt, optsOff)).toBeNull();
  });

  it('paceCheck fast says "Ease back"', () => {
    const s = step({});
    const evt: CueEvent = {
      type: 'paceCheck', step: s,
      currentPaceSec: 245, targetPaceSec: 255, deviationSec: -10, status: 'fast',
    };
    expect(composePhrase(evt, opts)).toBe('Ease back.');
  });

  it('paceCheck slow says "Pick it up"', () => {
    const s = step({});
    const evt: CueEvent = {
      type: 'paceCheck', step: s,
      currentPaceSec: 265, targetPaceSec: 255, deviationSec: 10, status: 'slow',
    };
    expect(composePhrase(evt, opts)).toBe('Pick it up.');
  });
});
