/**
 * Stream Processor — Pure data processing for per-second workout timeseries.
 *
 * Extracts derived metrics (work segment, cardiac efficiency, steady-state flag)
 * from raw HR + pace stream data pulled from Garmin syncs.
 */

/** Single data point from per-second activity stream */
export interface StreamPoint {
  timestampSec: number;   // seconds from activity start
  heartRateBpm: number;
  paceSecPerKm: number;   // 0 if stopped
}

/** Full activity stream from a synced workout */
export interface ActivityStream {
  points: StreamPoint[];
  totalDurationSec: number;
  totalDistanceKm: number;
}

/** Analysis result from processing a stream */
export interface StreamAnalysis {
  workSegment: {
    startIdx: number;
    endIdx: number;
    durationSec: number;
    avgPaceSecPerKm: number;
    avgHeartRateBpm: number;
    paceCV: number;          // coefficient of variation — measures steadiness
  };
  cardiacEfficiency: number; // pace / HR (lower = more efficient)
  isSteadyState: boolean;    // paceCV < 0.08
  overallAvgHR: number;
  overallAvgPace: number;
}

/**
 * Compute cardiac efficiency index: pace / HR.
 * Lower value = more efficient (faster pace at same HR, or same pace at lower HR).
 */
export function computeCardiacEfficiency(paceSecPerKm: number, heartRateBpm: number): number {
  if (heartRateBpm <= 0) return 0;
  return paceSecPerKm / heartRateBpm;
}

/**
 * Extract the "work segment" from a stream — the longest contiguous block
 * where pace is within 15% of the median pace of the middle 50%.
 *
 * Fallback: strip first 15% and last 10% of points (warmup/cooldown heuristic).
 */
export function extractWorkSegment(stream: ActivityStream): {
  startIdx: number;
  endIdx: number;
} {
  const moving = stream.points.filter(p => p.paceSecPerKm > 0);
  if (moving.length < 10) {
    // Too few moving points — use fallback
    return fallbackSegment(stream.points.length);
  }

  // Compute median pace of middle 50%
  const sorted = [...moving].sort((a, b) => a.paceSecPerKm - b.paceSecPerKm);
  const q1Idx = Math.floor(sorted.length * 0.25);
  const q3Idx = Math.floor(sorted.length * 0.75);
  const middle50 = sorted.slice(q1Idx, q3Idx + 1);
  const medianPace = middle50[Math.floor(middle50.length / 2)].paceSecPerKm;

  // Find longest contiguous segment within 15% of median
  const tolerance = medianPace * 0.15;
  const lo = medianPace - tolerance;
  const hi = medianPace + tolerance;

  let bestStart = 0;
  let bestEnd = 0;
  let bestLen = 0;
  let curStart = -1;

  for (let i = 0; i < stream.points.length; i++) {
    const p = stream.points[i];
    const inRange = p.paceSecPerKm > 0 && p.paceSecPerKm >= lo && p.paceSecPerKm <= hi;

    if (inRange) {
      if (curStart === -1) curStart = i;
      const len = i - curStart + 1;
      if (len > bestLen) {
        bestStart = curStart;
        bestEnd = i;
        bestLen = len;
      }
    } else {
      curStart = -1;
    }
  }

  // If the best segment is too short (< 60 seconds), use fallback
  if (bestLen < 60) {
    return fallbackSegment(stream.points.length);
  }

  return { startIdx: bestStart, endIdx: bestEnd };
}

/** Fallback: strip first 15% and last 10% */
function fallbackSegment(totalPoints: number): { startIdx: number; endIdx: number } {
  const start = Math.floor(totalPoints * 0.15);
  const end = Math.floor(totalPoints * 0.90) - 1;
  return { startIdx: Math.max(0, start), endIdx: Math.max(start, end) };
}

/**
 * Analyze a full activity stream: extract work segment, compute stats.
 */
export function analyzeStream(stream: ActivityStream): StreamAnalysis {
  const { startIdx, endIdx } = extractWorkSegment(stream);
  const segment = stream.points.slice(startIdx, endIdx + 1);

  // Work segment stats
  const movingSegment = segment.filter(p => p.paceSecPerKm > 0 && p.heartRateBpm > 0);
  const n = movingSegment.length || 1;

  const avgPace = movingSegment.reduce((s, p) => s + p.paceSecPerKm, 0) / n;
  const avgHR = movingSegment.reduce((s, p) => s + p.heartRateBpm, 0) / n;

  // Pace coefficient of variation
  const paceMean = avgPace;
  const paceVariance = movingSegment.reduce((s, p) => s + (p.paceSecPerKm - paceMean) ** 2, 0) / n;
  const paceSD = Math.sqrt(paceVariance);
  const paceCV = paceMean > 0 ? paceSD / paceMean : 1;

  const durationSec = segment.length > 0
    ? segment[segment.length - 1].timestampSec - segment[0].timestampSec
    : 0;

  // Overall averages (all moving points)
  const allMoving = stream.points.filter(p => p.paceSecPerKm > 0 && p.heartRateBpm > 0);
  const totalN = allMoving.length || 1;
  const overallAvgHR = allMoving.reduce((s, p) => s + p.heartRateBpm, 0) / totalN;
  const overallAvgPace = allMoving.reduce((s, p) => s + p.paceSecPerKm, 0) / totalN;

  const cei = computeCardiacEfficiency(avgPace, avgHR);

  return {
    workSegment: {
      startIdx,
      endIdx,
      durationSec,
      avgPaceSecPerKm: avgPace,
      avgHeartRateBpm: avgHR,
      paceCV,
    },
    cardiacEfficiency: cei,
    isSteadyState: paceCV < 0.08,
    overallAvgHR,
    overallAvgPace,
  };
}
