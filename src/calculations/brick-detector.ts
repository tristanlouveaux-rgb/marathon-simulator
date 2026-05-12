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

import { BRICK_DETECTION_WINDOW_SEC, BRICK_FULL_ADAPT_COUNT } from '@/constants/triathlon-constants';

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

// Half-life for recency weighting: a brick 4 weeks ago counts as half a current brick.
// Captures that recent bricks matter more for race-day adaptation than distant ones.
const BRICK_HALF_LIFE_WEEKS = 4;

/**
 * Compute a brick adaptation score (0–1) for use in the run-leg fatigue discount.
 *
 * Returns 0 when no bricks are detected in the lookback window, rising toward 1
 * as the athlete accumulates recency-weighted brick sessions. Uses an exponential
 * decay so recent bricks count more than old ones (half-life = 4 weeks).
 *
 * Calibration: BRICK_FULL_ADAPT_COUNT weighted sessions = score 1.0 (fully adapted).
 * Millet & Vleck 2000 — 10–15 bricks saturate the running-economy adaptation.
 *
 * @param detectedBricks - Output of detectBricks()
 * @param activities     - Same DetectionActivity[] passed to detectBricks() — needed for timestamps
 * @param nowMs          - Current time in ms (defaults to Date.now())
 * @param lookbackWeeks  - How far back to look (default 12 weeks)
 */
export function computeBrickAdaptation(
  detectedBricks: DetectedBrick[],
  activities: DetectionActivity[],
  nowMs: number = Date.now(),
  lookbackWeeks: number = 12,
): number {
  if (!detectedBricks.length) return 0;

  const idToStartTs = new Map<string, number>();
  for (const a of activities) idToStartTs.set(a.id, a.startTs);

  const nowSec = nowMs / 1000;
  const lookbackSec = lookbackWeeks * 7 * 86400;

  let weightedCount = 0;
  for (const brick of detectedBricks) {
    const startTs = idToStartTs.get(brick.bikeId);
    if (startTs == null) continue;
    const ageSec = nowSec - startTs;
    if (ageSec < 0 || ageSec > lookbackSec) continue;
    const ageWeeks = ageSec / (7 * 86400);
    weightedCount += Math.exp(-ageWeeks / BRICK_HALF_LIFE_WEEKS);
  }

  return Math.min(weightedCount / BRICK_FULL_ADAPT_COUNT, 1.0);
}

function isBike(sport: string): boolean {
  const s = sport.toLowerCase();
  return s.includes('bike') || s.includes('cycl') || s.includes('ride') || s === 'cycling';
}

function isRun(sport: string): boolean {
  const s = sport.toLowerCase();
  return s === 'run' || s.includes('running');
}
