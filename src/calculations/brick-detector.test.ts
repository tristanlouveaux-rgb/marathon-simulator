import { describe, it, expect } from 'vitest';
import { detectBricks } from './brick-detector';

const HOUR = 3600;

describe('Brick detection (§18.1 — 30 min window)', () => {
  it('detects a bike → run brick with a 10-min gap', () => {
    const activities = [
      { id: 'a', sport: 'bike', startTs: 1_000_000, durationSec: 2 * HOUR },
      { id: 'b', sport: 'run',  startTs: 1_000_000 + 2 * HOUR + 10 * 60, durationSec: 30 * 60 },
    ];
    const bricks = detectBricks(activities);
    expect(bricks).toHaveLength(1);
    expect(bricks[0]).toMatchObject({ bikeId: 'a', runId: 'b' });
    expect(bricks[0].gapSec).toBe(600);
  });

  it('rejects pairs outside the 30-min window', () => {
    const activities = [
      { id: 'a', sport: 'bike', startTs: 1_000_000, durationSec: HOUR },
      { id: 'b', sport: 'run',  startTs: 1_000_000 + HOUR + 45 * 60, durationSec: 20 * 60 },  // 45 min gap
    ];
    expect(detectBricks(activities)).toHaveLength(0);
  });

  it('rejects run → bike (only bike → run is a brick in v1)', () => {
    const activities = [
      { id: 'a', sport: 'run',  startTs: 1_000_000, durationSec: 20 * 60 },
      { id: 'b', sport: 'bike', startTs: 1_000_000 + 20 * 60 + 10 * 60, durationSec: HOUR },
    ];
    expect(detectBricks(activities)).toHaveLength(0);
  });

  it('rejects overlapping activities', () => {
    const activities = [
      { id: 'a', sport: 'bike', startTs: 1_000_000, durationSec: HOUR },
      { id: 'b', sport: 'run',  startTs: 1_000_000 + HOUR - 5 * 60, durationSec: 20 * 60 },  // starts before bike ends
    ];
    expect(detectBricks(activities)).toHaveLength(0);
  });

  it('handles variant sport labels (cycling, running, ride)', () => {
    const activities = [
      { id: 'a', sport: 'cycling', startTs: 1_000_000, durationSec: HOUR },
      { id: 'b', sport: 'running', startTs: 1_000_000 + HOUR + 5 * 60, durationSec: 15 * 60 },
    ];
    expect(detectBricks(activities)).toHaveLength(1);
  });
});
