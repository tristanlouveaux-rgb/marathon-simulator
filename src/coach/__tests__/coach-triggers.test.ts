/**
 * Unit tests for the proactive coach trigger detector.
 * Network-free; runs as part of the default `npm test`.
 *
 * The HRV crash trigger requires a fully shaped state for `computeDailyCoach`
 * to compute readiness signals. We test the easier deterministic triggers
 * here (race week, marker bumps) and the queue helpers. HRV coverage is
 * left to the live eval scenarios.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateCoachTriggers,
  markInsightSeen,
  topUnseenInsight,
} from '../coach-triggers';
import { getDefaultState } from '../../state/store';
import type { SimulatorState } from '../../types/state';

/** Build a minimal but valid SimulatorState that won't throw inside the
 *  triggers' try/catch on the HRV branch. Tests override fields as needed. */
function fixture(overrides: Partial<SimulatorState> = {}): SimulatorState {
  const s = getDefaultState();
  s.coachInsightQueue = [];
  return { ...s, ...overrides };
}

describe('evaluateCoachTriggers — base case', () => {
  it('returns an empty list when nothing fires', () => {
    const s = fixture();
    expect(evaluateCoachTriggers(s)).toEqual([]);
  });

  it('does not double-fire when the triggerId is already in queue', () => {
    const s = fixture();
    s.triConfig = {
      ...(s.triConfig ?? ({} as any)),
      raceDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
    } as any;
    const first = evaluateCoachTriggers(s);
    expect(first.length).toBeGreaterThan(0);
    s.coachInsightQueue = first.map(i => ({ ...i, seen: false }));
    const second = evaluateCoachTriggers(s);
    expect(second).toEqual([]);
  });
});

describe('race-week trigger', () => {
  it('fires when race is within 7 days', () => {
    const s = fixture();
    const inFive = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    s.triConfig = { ...(s.triConfig ?? ({} as any)), raceDate: inFive } as any;
    const result = evaluateCoachTriggers(s);
    const found = result.find(i => i.triggerId.startsWith('race_week_'));
    expect(found).toBeDefined();
    expect(found?.headline.toLowerCase()).toContain('race week');
  });

  it('does NOT fire when race is more than 7 days away', () => {
    const s = fixture();
    const inThirty = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    s.triConfig = { ...(s.triConfig ?? ({} as any)), raceDate: inThirty } as any;
    const result = evaluateCoachTriggers(s);
    expect(result.find(i => i.triggerId.startsWith('race_week_'))).toBeUndefined();
  });

  it('does NOT fire when race date is in the past', () => {
    const s = fixture();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    s.triConfig = { ...(s.triConfig ?? ({} as any)), raceDate: yesterday } as any;
    const result = evaluateCoachTriggers(s);
    expect(result.find(i => i.triggerId.startsWith('race_week_'))).toBeUndefined();
  });
});

describe('FTP marker-bump trigger', () => {
  it('fires when FTP delta ≥ 5W', () => {
    const s = fixture();
    s.triConfig = {
      ...(s.triConfig ?? ({} as any)),
      bike: { ftp: 260 },
      notifiedMarkers: { ftp: 250 },
    } as any;
    const result = evaluateCoachTriggers(s);
    const ftpInsight = result.find(i => i.triggerId.startsWith('ftp_bump_'));
    expect(ftpInsight).toBeDefined();
    expect(ftpInsight?.headline).toContain('+10');
  });

  it('fires on a downward delta too (absolute ≥5)', () => {
    const s = fixture();
    s.triConfig = {
      ...(s.triConfig ?? ({} as any)),
      bike: { ftp: 240 },
      notifiedMarkers: { ftp: 250 },
    } as any;
    const result = evaluateCoachTriggers(s);
    const ftpInsight = result.find(i => i.triggerId.startsWith('ftp_bump_'));
    expect(ftpInsight).toBeDefined();
    expect(ftpInsight?.headline).toContain('-10');
  });

  it('does NOT fire when delta is less than 5W', () => {
    const s = fixture();
    s.triConfig = {
      ...(s.triConfig ?? ({} as any)),
      bike: { ftp: 253 },
      notifiedMarkers: { ftp: 250 },
    } as any;
    const result = evaluateCoachTriggers(s);
    expect(result.find(i => i.triggerId.startsWith('ftp_bump_'))).toBeUndefined();
  });
});

describe('VDOT marker-bump trigger', () => {
  it('fires when VDOT delta ≥ 1 point', () => {
    const s = fixture();
    s.v = 49;
    s.triConfig = {
      ...(s.triConfig ?? ({} as any)),
      notifiedMarkers: { vdot: 47.5 },
    } as any;
    const result = evaluateCoachTriggers(s);
    expect(result.find(i => i.triggerId.startsWith('vdot_bump_'))).toBeDefined();
  });

  it('does NOT fire on sub-1-point delta', () => {
    const s = fixture();
    s.v = 47.5;
    s.triConfig = {
      ...(s.triConfig ?? ({} as any)),
      notifiedMarkers: { vdot: 47.2 },
    } as any;
    const result = evaluateCoachTriggers(s);
    expect(result.find(i => i.triggerId.startsWith('vdot_bump_'))).toBeUndefined();
  });
});

describe('queue helpers', () => {
  it('markInsightSeen flips the matching entry', () => {
    const s = fixture();
    s.coachInsightQueue = [
      { triggerId: 'a', headline: 'A', primer: 'p', createdISO: '' },
      { triggerId: 'b', headline: 'B', primer: 'p', createdISO: '' },
    ];
    markInsightSeen(s, 'a');
    expect(s.coachInsightQueue?.[0].seen).toBe(true);
    expect(s.coachInsightQueue?.[1].seen).toBeUndefined();
  });

  it('markInsightSeen is a no-op when triggerId is missing', () => {
    const s = fixture();
    s.coachInsightQueue = [{ triggerId: 'a', headline: 'A', primer: 'p', createdISO: '' }];
    markInsightSeen(s, 'unknown');
    expect(s.coachInsightQueue[0].seen).toBeUndefined();
  });

  it('topUnseenInsight returns null when queue is empty', () => {
    const s = fixture();
    expect(topUnseenInsight(s)).toBeNull();
  });

  it('topUnseenInsight returns null when all entries are seen', () => {
    const s = fixture();
    s.coachInsightQueue = [
      { triggerId: 'a', headline: 'A', primer: 'p', createdISO: '', seen: true },
      { triggerId: 'b', headline: 'B', primer: 'p', createdISO: '', seen: true },
    ];
    expect(topUnseenInsight(s)).toBeNull();
  });

  it('topUnseenInsight returns the first unseen entry', () => {
    const s = fixture();
    s.coachInsightQueue = [
      { triggerId: 'a', headline: 'A', primer: 'p', createdISO: '', seen: true },
      { triggerId: 'b', headline: 'B', primer: 'p', createdISO: '' },
      { triggerId: 'c', headline: 'C', primer: 'p', createdISO: '' },
    ];
    expect(topUnseenInsight(s)?.triggerId).toBe('b');
  });
});
