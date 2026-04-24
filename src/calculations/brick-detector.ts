/**
 * Brick detection — two sequential activities within a 30-minute gap become
 * a single brick (§18.1).
 *
 * Canonical pattern: bike activity → run activity within 30 min of
 * bike end. Other pairs (swim → bike, run → bike) are uncommon and not
 * flagged in v1.
 *
 * **Side of the line**: tracking. We describe what the athlete did.
 * The plan engine's `brickSegments` field is planning-side and
 * unaffected by this detector.
 */

import { BRICK_DETECTION_WINDOW_SEC } from '@/constants/triathlon-constants';

export interface DetectionActivity {
  id: string;
  sport: 'bike' | 'run' | 'swim' | string;  // Free-form — we pattern-match
  startTs: number;        // Unix seconds
  durationSec: number;
}

export interface DetectedBrick {
  bikeId: string;
  runId: string;
  gapSec: number;
}

/**
 * Scan a list of activities (all on the same calendar day, or even
 * straddling a day boundary) and return brick pairings. Input should
 * already be filtered to one athlete's activities and sorted by start
 * time.
 */
export function detectBricks(activities: DetectionActivity[]): DetectedBrick[] {
  if (!activities.length) return [];
  const sorted = [...activities].sort((a, b) => a.startTs - b.startTs);
  const bricks: DetectedBrick[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!isBike(a.sport) || !isRun(b.sport)) continue;

    const aEnd = a.startTs + a.durationSec;
    const gap = b.startTs - aEnd;
    if (gap < 0) continue;               // Overlap — not a brick
    if (gap > BRICK_DETECTION_WINDOW_SEC) continue;

    bricks.push({ bikeId: a.id, runId: b.id, gapSec: Math.round(gap) });
  }

  return bricks;
}

function isBike(sport: string): boolean {
  const s = sport.toLowerCase();
  return s.includes('bike') || s.includes('cycl') || s.includes('ride') || s === 'cycling';
}

function isRun(sport: string): boolean {
  const s = sport.toLowerCase();
  return s === 'run' || s.includes('running');
}
