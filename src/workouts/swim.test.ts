import { describe, it, expect } from 'vitest';
import { describeSwimSession } from './swim';

const CSS = 98; // 1:38/100m

describe('describeSwimSession pace targets', () => {
  it('speed reps show an absolute pace when CSS is known (CSS −5s)', () => {
    const d = describeSwimSession('speed', 1800, CSS, 3, 1, 0, 0);
    expect(d).toContain('@ 1:33/100m'); // 98 − 5
    expect(d).not.toContain('(CSS −5s/100m)');
  });

  it('speed reps fall back to the relative label without CSS', () => {
    const d = describeSwimSession('speed', 1800, undefined, 3, 1, 0, 0);
    expect(d).toContain('(CSS −5s/100m)');
  });

  it('threshold reps keep the CSS pace hint', () => {
    const d = describeSwimSession('threshold', 2000, CSS, 3, 1, 0, 0);
    expect(d).toContain('@ 1:38/100m (CSS)');
  });
});
