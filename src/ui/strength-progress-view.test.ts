import { describe, it, expect } from 'vitest';
import { hasStrengthData, buildStrengthProgressCard, buildStrengthProgressBody } from './strength-progress-view';
import type { SimulatorState } from '@/types';

const recentDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const olderDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

function squatLift() {
  return {
    'back-squat': {
      key: 'back-squat', displayName: 'Back Squat',
      lastWeightKg: 80, lastReps: '5', lastDate: recentDate,
      est1rmKg: 93.3, est1rmReps: 5,
      est1rmHistory: [{ date: olderDate, value: 88 }, { date: recentDate, value: 93.3 }],
    },
  };
}

function stateWith(lifts: any): SimulatorState {
  return { strengthLog: { lifts }, wks: [], w: 4, continuousMode: true } as any;
}

describe('strength-progress-view', () => {
  it('hasStrengthData is false for empty state', () => {
    expect(hasStrengthData({} as any)).toBe(false);
  });

  it('hasStrengthData is true once a lift is tracked', () => {
    expect(hasStrengthData(stateWith(squatLift()))).toBe(true);
  });

  it('the card is an empty string when strength is neither done nor planned', () => {
    expect(buildStrengthProgressCard({} as any)).toBe('');
  });

  it('the card shows an invite when strength is planned but not yet logged', () => {
    const html = buildStrengthProgressCard({ strengthLog: { lifts: {} }, wks: [], gs: 2 } as any);
    expect(html).toContain('stats-strength-card');
    expect(html).toContain('Track your strength progress');
  });

  it('the card surfaces a recent PR headline', () => {
    const html = buildStrengthProgressCard(stateWith(squatLift()));
    expect(html).toContain('stats-strength-card');
    expect(html).toContain('new best');          // 88 → 93.3 = +5.3kg ≥ 2.5, within recency
    expect(html).toContain('Back Squat');
  });

  it('the body lists the PR jump and the lift', () => {
    const body = buildStrengthProgressBody(stateWith(squatLift()));
    expect(body).toContain('New bests this block');
    expect(body).toContain('Back Squat');
    expect(body).toContain('Lifts');
  });

  it('a lighter, older-only history does not mint a PR in the body', () => {
    // Single sample → no jump to celebrate, but the lift still shows under Lifts.
    const s = stateWith({
      'deadlift': {
        key: 'deadlift', displayName: 'Deadlift', lastWeightKg: 100, lastReps: '5',
        lastDate: recentDate, est1rmKg: 116.7, est1rmReps: 5,
        est1rmHistory: [{ date: recentDate, value: 116.7 }],
      },
    });
    const body = buildStrengthProgressBody(s);
    expect(body).not.toContain('New bests this block');
    expect(body).toContain('Deadlift');
  });

  it('empty-state body invites the first session', () => {
    const body = buildStrengthProgressBody({ strengthLog: { lifts: {} }, wks: [] } as any);
    expect(body).toContain('Log a gym session');
  });

  it('a watch-matched HIIT counts toward sessions (no weights needed)', () => {
    const s = {
      strengthLog: { lifts: {} },
      w: 2,
      wks: [
        { garminActuals: { a: { activityType: 'HIIT', startTime: `${recentDate}T08:00:00` } } },
        {},
      ],
    } as any;
    expect(hasStrengthData(s)).toBe(true);   // counts even with no tracked lifts
    const body = buildStrengthProgressBody(s);
    expect(body).toContain('Consistency');
    expect(body).toContain('1');             // 1 session logged
    expect(body).not.toContain('total moved'); // HIIT carries no weights → no tonnage
  });

  it('a run is not counted as a gym session', () => {
    const s = {
      strengthLog: { lifts: {} },
      w: 2,
      wks: [{ garminActuals: { a: { activityType: 'RUNNING', startTime: `${recentDate}T08:00:00` } } }, {}],
    } as any;
    expect(hasStrengthData(s)).toBe(false);
  });
});
