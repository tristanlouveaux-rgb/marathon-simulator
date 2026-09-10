import { describe, it, expect } from 'vitest';
import { mergeManualSleepHistory } from './sleep-insights';
import { computeRecoveryScore } from './readiness';
import type { PhysiologyDayEntry } from '@/types/state';

/** ISO date `n` days before the real system clock. computeRecoveryScore gates on
 * a >3-day staleness window (real Date.now(), no injectable override), so these
 * fixtures must be date-relative or they age out and return hasData:false. */
function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

describe('mergeManualSleepHistory', () => {
  it('folds manual recovery nights into physiology history, date-sorted', () => {
    const physio: PhysiologyDayEntry[] = [
      { date: '2026-06-10', sleepScore: 80 },
      { date: '2026-06-12', sleepScore: 75 },
    ];
    const recovery = [
      { date: '2026-06-11', sleepScore: 30, source: 'manual' },
      { date: '2026-06-13', sleepScore: 25, source: 'manual' },
    ];
    const merged = mergeManualSleepHistory(physio, recovery);
    expect(merged.map(e => e.date)).toEqual(['2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13']);
    expect(merged.find(e => e.date === '2026-06-11')?.sleepScore).toBe(30);
    expect(merged.find(e => e.date === '2026-06-13')?.sleepScore).toBe(25);
  });

  it('device sleep wins per date — manual does not overwrite a device sleepScore', () => {
    const physio: PhysiologyDayEntry[] = [{ date: '2026-06-11', sleepScore: 85, hrvRmssd: 60 }];
    const recovery = [{ date: '2026-06-11', sleepScore: 20, source: 'manual' }];
    const merged = mergeManualSleepHistory(physio, recovery);
    expect(merged).toHaveLength(1);
    expect(merged[0].sleepScore).toBe(85);
    expect(merged[0].hrvRmssd).toBe(60);
  });

  it('manual fills a device row that has no sleepScore', () => {
    const physio: PhysiologyDayEntry[] = [{ date: '2026-06-11', hrvRmssd: 55 }];
    const recovery = [{ date: '2026-06-11', sleepScore: 40, source: 'manual' }];
    const merged = mergeManualSleepHistory(physio, recovery);
    expect(merged[0].sleepScore).toBe(40);
    expect(merged[0].hrvRmssd).toBe(55);
  });

  it('ignores non-manual recovery entries (they already live in physiology)', () => {
    const recovery = [
      { date: '2026-06-11', sleepScore: 70, source: 'garmin' },
      { date: '2026-06-12', sleepScore: 30, source: 'manual' },
    ];
    const merged = mergeManualSleepHistory([], recovery);
    expect(merged.map(e => e.date)).toEqual(['2026-06-12']);
  });
});

describe('manual sleep reaches the recovery score for a no-watch user', () => {
  // Three manual nights with no physiology data at all. Before the merge fix,
  // computeRecoveryScore never saw these (history came from physiologyHistory),
  // so a manual-only user never cleared the 3-night floor for a real score.
  it('three manual bad nights produce a low recovery score', () => {
    const recovery = [
      { date: isoDaysAgo(2), sleepScore: 30, source: 'manual' },
      { date: isoDaysAgo(1), sleepScore: 28, source: 'manual' },
      { date: isoDaysAgo(0), sleepScore: 25, source: 'manual' },
    ];
    const merged = mergeManualSleepHistory([], recovery);
    const result = computeRecoveryScore(merged, { manualSleepScore: 25 });
    expect(result.hasData).toBe(true);
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeLessThan(45); // Poor zone — a bad night registers
  });

  it('a good manual night scores higher than a bad one', () => {
    const bad = computeRecoveryScore(
      mergeManualSleepHistory([], [
        { date: isoDaysAgo(2), sleepScore: 30, source: 'manual' },
        { date: isoDaysAgo(1), sleepScore: 28, source: 'manual' },
        { date: isoDaysAgo(0), sleepScore: 25, source: 'manual' },
      ]),
      { manualSleepScore: 25 },
    );
    const good = computeRecoveryScore(
      mergeManualSleepHistory([], [
        { date: isoDaysAgo(2), sleepScore: 85, source: 'manual' },
        { date: isoDaysAgo(1), sleepScore: 88, source: 'manual' },
        { date: isoDaysAgo(0), sleepScore: 90, source: 'manual' },
      ]),
      { manualSleepScore: 90 },
    );
    expect(good.score!).toBeGreaterThan(bad.score!);
  });
});
