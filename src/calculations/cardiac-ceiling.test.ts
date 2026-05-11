import { describe, it, expect } from 'vitest';
import { computeCardiacCeiling, type ActivityHRSample } from './cardiac-ceiling';

const NOW = new Date('2026-05-01T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString();

function mkActivity(opts: Partial<ActivityHRSample> & { maxHR: number; sport?: string; daysAgo?: number; durationSec?: number }): ActivityHRSample {
  return {
    startTime: daysAgo(opts.daysAgo ?? 1),
    durationSec: opts.durationSec ?? 1800,
    maxHR: opts.maxHR,
    sport: opts.sport ?? 'running',
  };
}

describe('cardiac ceiling — Uth-Sørensen', () => {
  it('returns null when restingHR is missing', () => {
    const r = computeCardiacCeiling([mkActivity({ maxHR: 180 })], null, NOW);
    expect(r.vo2).toBeNull();
    expect(r.reason).toBe('no-rhr');
  });

  it('returns null when no activities have HR', () => {
    const r = computeCardiacCeiling([], 50, NOW);
    expect(r.vo2).toBeNull();
    expect(r.reason).toBe('no-activity');
  });

  it('computes 15.3 × HRmax/HRrest', () => {
    const r = computeCardiacCeiling([mkActivity({ maxHR: 195 })], 50, NOW);
    expect(r.vo2).toBeCloseTo(15.3 * 195 / 50, 1);
    expect(r.hrMaxObserved).toBe(195);
  });

  it('takes peak across all sessions in window', () => {
    const r = computeCardiacCeiling([
      mkActivity({ maxHR: 170, daysAgo: 5 }),
      mkActivity({ maxHR: 195, daysAgo: 14 }),
      mkActivity({ maxHR: 180, daysAgo: 30 }),
    ], 50, NOW);
    expect(r.hrMaxObserved).toBe(195);
  });

  it('ignores sessions outside the 8-week window', () => {
    const r = computeCardiacCeiling([
      mkActivity({ maxHR: 195, daysAgo: 80 }),  // outside 8w
      mkActivity({ maxHR: 175, daysAgo: 10 }),
    ], 50, NOW);
    expect(r.hrMaxObserved).toBe(175);
    expect(r.n).toBe(1);
  });

  it('ignores sessions shorter than 60s (HR spike artefact filter)', () => {
    const r = computeCardiacCeiling([
      mkActivity({ maxHR: 200, durationSec: 30 }),
      mkActivity({ maxHR: 180, durationSec: 1800 }),
    ], 50, NOW);
    expect(r.hrMaxObserved).toBe(180);
  });

  it('high confidence requires ≥8 sessions and ≥2 sports', () => {
    const acts: ActivityHRSample[] = [];
    for (let i = 0; i < 8; i++) {
      acts.push(mkActivity({ maxHR: 180 + i, sport: i % 2 === 0 ? 'running' : 'padel', daysAgo: i * 3 }));
    }
    const r = computeCardiacCeiling(acts, 50, NOW);
    expect(r.confidence).toBe('high');
    expect(r.distinctSports).toBe(2);
  });

  it('drops to medium when only one sport even with many sessions', () => {
    const acts: ActivityHRSample[] = [];
    for (let i = 0; i < 8; i++) {
      acts.push(mkActivity({ maxHR: 180, sport: 'running', daysAgo: i * 3 }));
    }
    const r = computeCardiacCeiling(acts, 50, NOW);
    expect(r.confidence).toBe('medium');
  });

  it('low confidence with one or two sessions', () => {
    const r = computeCardiacCeiling([mkActivity({ maxHR: 180 })], 50, NOW);
    expect(r.confidence).toBe('low');
  });

  it('rejects when HRmax ≤ HRrest (sensor error)', () => {
    const r = computeCardiacCeiling([mkActivity({ maxHR: 50 })], 60, NOW);
    expect(r.vo2).toBeNull();
    expect(r.reason).toBe('no-hrmax');
  });
});
