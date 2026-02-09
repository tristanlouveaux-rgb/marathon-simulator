import { describe, it, expect } from 'vitest';
import { computeRecoveryStatus, sleepQualityToScore, createGarminRecoveryEntry } from './engine';
import type { RecoveryEntry } from './engine';

describe('computeRecoveryStatus', () => {
  it('returns green with no data', () => {
    const result = computeRecoveryStatus(null, []);
    expect(result.level).toBe('green');
    expect(result.shouldPrompt).toBe(false);
  });

  it('good sleep → green', () => {
    const entry: RecoveryEntry = { date: '2025-01-15', sleepScore: 85, source: 'manual' };
    const result = computeRecoveryStatus(entry, []);
    expect(result.level).toBe('green');
    expect(result.shouldPrompt).toBe(false);
  });

  it('poor sleep → yellow', () => {
    const entry: RecoveryEntry = { date: '2025-01-15', sleepScore: 55, source: 'manual' };
    const result = computeRecoveryStatus(entry, []);
    expect(result.level).toBe('yellow');
    expect(result.shouldPrompt).toBe(true);
  });

  it('very poor sleep → red', () => {
    const entry: RecoveryEntry = { date: '2025-01-15', sleepScore: 20, source: 'manual' };
    const result = computeRecoveryStatus(entry, []);
    expect(result.level).toBe('red');
    expect(result.shouldPrompt).toBe(true);
  });

  it('trend escalation: 2 of last 3 days low → orange', () => {
    const today: RecoveryEntry = { date: '2025-01-15', sleepScore: 55, source: 'manual' };
    const history: RecoveryEntry[] = [
      { date: '2025-01-14', sleepScore: 40, source: 'manual' },
      { date: '2025-01-13', sleepScore: 45, source: 'manual' },
      { date: '2025-01-12', sleepScore: 80, source: 'manual' },
    ];
    const result = computeRecoveryStatus(today, history);
    expect(result.level).toBe('orange');
    expect(result.reasons).toContain('2 of last 3 days low');
  });

  it('no trend escalation: only 1 of last 3 days low → stays yellow', () => {
    const today: RecoveryEntry = { date: '2025-01-15', sleepScore: 55, source: 'manual' };
    const history: RecoveryEntry[] = [
      { date: '2025-01-14', sleepScore: 80, source: 'manual' },
      { date: '2025-01-13', sleepScore: 45, source: 'manual' },
      { date: '2025-01-12', sleepScore: 85, source: 'manual' },
    ];
    const result = computeRecoveryStatus(today, history);
    expect(result.level).toBe('yellow');
  });

  it('strained HRV → red', () => {
    const entry: RecoveryEntry = {
      date: '2025-01-15', sleepScore: 75, hrvStatus: 'strained', source: 'garmin'
    };
    const result = computeRecoveryStatus(entry, []);
    expect(result.level).toBe('red');
    expect(result.shouldPrompt).toBe(true);
  });

  it('low readiness → orange', () => {
    const entry: RecoveryEntry = {
      date: '2025-01-15', sleepScore: 75, readiness: 35, source: 'garmin'
    };
    const result = computeRecoveryStatus(entry, []);
    expect(result.level).toBe('orange');
    expect(result.shouldPrompt).toBe(true);
  });

  it('low HRV → orange', () => {
    const entry: RecoveryEntry = {
      date: '2025-01-15', sleepScore: 75, hrvStatus: 'low', source: 'garmin'
    };
    const result = computeRecoveryStatus(entry, []);
    expect(result.level).toBe('orange');
  });

  it('good sleep with good readiness → green', () => {
    const entry: RecoveryEntry = {
      date: '2025-01-15', sleepScore: 80, readiness: 65, source: 'garmin'
    };
    const result = computeRecoveryStatus(entry, []);
    expect(result.level).toBe('green');
    expect(result.shouldPrompt).toBe(false);
  });
});

describe('sleepQualityToScore', () => {
  it('maps great → 90', () => expect(sleepQualityToScore('great')).toBe(90));
  it('maps good → 70', () => expect(sleepQualityToScore('good')).toBe(70));
  it('maps poor → 45', () => expect(sleepQualityToScore('poor')).toBe(45));
  it('maps terrible → 25', () => expect(sleepQualityToScore('terrible')).toBe(25));
});

describe('createGarminRecoveryEntry', () => {
  it('creates a valid entry with all fields', () => {
    const entry = createGarminRecoveryEntry('2025-01-15', 72, 58, 'balanced');
    expect(entry.source).toBe('garmin');
    expect(entry.sleepScore).toBe(72);
    expect(entry.readiness).toBe(58);
    expect(entry.hrvStatus).toBe('balanced');
  });
});
