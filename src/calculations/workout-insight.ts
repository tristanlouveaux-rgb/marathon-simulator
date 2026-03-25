/**
 * workout-insight.ts
 * Rules-based workout commentary — coaching/direct tone, 2-3 sentences.
 * Consumes GarminActual fields (hrEffortScore, paceAdherence, hrDrift, hrZones,
 * kmSplits, avgHR, durationSec, plannedType) and returns a short insight string.
 */

import type { GarminActual } from '@/types';
import { getHREffort } from '@/calculations/activity-matcher';

export interface HRProfileForInsight {
  maxHR?: number | null;
  restingHR?: number | null;
  onboarding?: { age?: number };
}

/** Is this a quality workout type where pace matters significantly? */
function isQualityType(workoutType: string | null | undefined): boolean {
  if (!workoutType) return false;
  return ['threshold', 'vo2', 'intervals', 'marathon_pace', 'race_pace', 'tempo', 'progressive'].includes(workoutType);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Coefficient of variation of km splits (0–1 scale). Lower = more even. */
function splitCV(splits: number[]): number | null {
  if (!splits || splits.length < 3) return null;
  const valid = splits.filter(s => s > 60 && s < 1200);
  if (valid.length < 3) return null;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  if (mean <= 0) return null;
  const variance = valid.reduce((a, v) => a + (v - mean) ** 2, 0) / valid.length;
  return Math.sqrt(variance) / mean;
}

/** Did splits show negative split pattern (second half faster)? */
function isNegativeSplit(splits: number[]): boolean {
  if (!splits || splits.length < 4) return false;
  const valid = splits.filter(s => s > 60 && s < 1200);
  if (valid.length < 4) return false;
  const mid = Math.floor(valid.length / 2);
  const firstAvg = valid.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const secondAvg = valid.slice(mid).reduce((a, b) => a + b, 0) / (valid.length - mid);
  return secondAvg < firstAvg * 0.98; // at least 2% faster
}

/** Did splits blow up at the end (last 20% much slower)? */
function fadedLate(splits: number[]): boolean {
  if (!splits || splits.length < 5) return false;
  const valid = splits.filter(s => s > 60 && s < 1200);
  if (valid.length < 5) return false;
  const tailStart = Math.floor(valid.length * 0.8);
  const bodyAvg = valid.slice(0, tailStart).reduce((a, b) => a + b, 0) / tailStart;
  const tailAvg = valid.slice(tailStart).reduce((a, b) => a + b, 0) / (valid.length - tailStart);
  return tailAvg > bodyAvg * 1.08; // 8%+ slower in last 20%
}

/** Dominant HR zone label */
function dominantZone(zones: { z1: number; z2: number; z3: number; z4: number; z5: number }): string | null {
  const total = zones.z1 + zones.z2 + zones.z3 + zones.z4 + zones.z5;
  if (total <= 0) return null;
  const entries: [string, number][] = [
    ['Z1', zones.z1], ['Z2', zones.z2], ['Z3', zones.z3], ['Z4', zones.z4], ['Z5', zones.z5],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

/** % of time in Z4+Z5 */
function highZonePct(zones: { z1: number; z2: number; z3: number; z4: number; z5: number }): number {
  const total = zones.z1 + zones.z2 + zones.z3 + zones.z4 + zones.z5;
  if (total <= 0) return 0;
  return (zones.z4 + zones.z5) / total;
}

/** % of time in Z1+Z2 */
function lowZonePct(zones: { z1: number; z2: number; z3: number; z4: number; z5: number }): number {
  const total = zones.z1 + zones.z2 + zones.z3 + zones.z4 + zones.z5;
  if (total <= 0) return 0;
  return (zones.z1 + zones.z2) / total;
}

// ─── insight candidates ──────────────────────────────────────────────────────

interface Candidate {
  priority: number; // lower = more important
  text: string;
}

function collectCandidates(a: GarminActual): Candidate[] {
  const out: Candidate[] = [];
  const isRun = a.activityType === 'RUNNING' || a.plannedType != null;
  const quality = isQualityType(a.plannedType);
  const isEasy = a.plannedType === 'easy' || a.plannedType === 'recovery' || (!a.plannedType && isRun);
  const isLong = a.plannedType === 'long';

  // ── Pace adherence (runs only) ──────────────────────────────────────────
  if (a.paceAdherence != null && isRun) {
    const pa = a.paceAdherence;
    if (quality) {
      if (pa >= 0.95 && pa <= 1.05) {
        out.push({ priority: 2, text: 'Pacing was right on the money for this session. That discipline pays off on race day.' });
      } else if (pa < 0.92) {
        out.push({ priority: 1, text: `You pushed harder than planned — ${Math.round((1 - pa) * 100)}% faster than target pace. Make sure this was intentional; going too hot on quality days can cost you later in the week.` });
      } else if (pa < 0.95) {
        out.push({ priority: 3, text: 'Slightly quicker than target. Not a problem, but try to stay closer to plan on threshold sessions.' });
      } else if (pa > 1.10) {
        out.push({ priority: 1, text: `Pace was ${Math.round((pa - 1) * 100)}% slower than target. If you were struggling, that's good data — your plan will adapt. If conditions were tough, no stress.` });
      } else if (pa > 1.05) {
        out.push({ priority: 3, text: 'A touch slower than planned. Close enough — keep the effort honest and the pace will follow.' });
      }
    } else if (isEasy || isLong) {
      if (pa < 0.88) {
        out.push({ priority: 1, text: 'This was meant to be easy, but your pace says otherwise. Easy days build your aerobic base — save the speed for quality sessions.' });
      } else if (pa < 0.93) {
        out.push({ priority: 3, text: 'Slightly faster than easy pace. Not the end of the world, but genuine easy running is where the magic happens.' });
      }
      // Don't comment on slow easy runs — that's fine
    }
  }

  // ── HR effort score ─────────────────────────────────────────────────────
  if (a.hrEffortScore != null) {
    const hr = a.hrEffortScore;
    if (quality && isRun) {
      if (hr >= 1.15) {
        out.push({ priority: 2, text: 'Heart rate was running hot — your body found this harder than planned. Future sessions will account for that.' });
      } else if (hr <= 0.85) {
        out.push({ priority: 2, text: 'HR was well under target. Either this felt comfortable or the pace wasn\'t pushing enough. Both are useful to know.' });
      }
    } else if ((isEasy || isLong) && isRun) {
      if (hr >= 1.15) {
        out.push({ priority: 1, text: 'Heart rate was higher than expected for an easy run. Common causes: fatigue, heat, humidity, or uneven terrain such as trails or sand.' });
      }
    } else if (!isRun) {
      // Cross-training
      if (hr >= 1.20) {
        out.push({ priority: 3, text: 'This was a tough session by heart rate standards. Your plan accounts for the extra load.' });
      } else if (hr <= 0.80) {
        out.push({ priority: 4, text: 'Light effort on this one — good for active recovery.' });
      }
    }
  }

  // ── HR drift (runs only, already filtered to steady-state > 20min) ─────
  if (a.hrDrift != null && isRun) {
    const drift = a.hrDrift;
    if ((isEasy || isLong) && drift > 8) {
      out.push({ priority: 2, text: `Heart rate drifted ${drift.toFixed(0)}% from first to second half. That's a sign your aerobic system was working hard — hydration and fueling can help, especially on longer runs.` });
    } else if (quality && drift > 12) {
      out.push({ priority: 3, text: `Notable HR drift of ${drift.toFixed(0)}% — your body was accumulating fatigue through the session. Normal for hard efforts, but worth tracking over time.` });
    } else if ((isEasy || isLong) && drift <= 3 && a.durationSec > 2400) {
      out.push({ priority: 4, text: 'Very stable heart rate throughout — a sign of good aerobic fitness at this pace.' });
    }
  }

  // ── Splits consistency (runs only) ──────────────────────────────────────
  if (a.kmSplits && a.kmSplits.length >= 3 && isRun) {
    const cv = splitCV(a.kmSplits);

    if (isNegativeSplit(a.kmSplits) && (isLong || quality)) {
      out.push({ priority: 3, text: 'Nice negative split — finishing faster than you started. That\'s the kind of pacing that wins races.' });
    } else if (fadedLate(a.kmSplits) && (isLong || quality)) {
      out.push({ priority: 2, text: 'Pace dropped off in the final kilometres. If that wasn\'t planned, consider starting a touch more conservatively next time.' });
    } else if (cv != null && cv < 0.03 && a.kmSplits.length >= 5 && isEasy) {
      const hasNegativeSignal = out.some(c => c.priority <= 2);
      if (!hasNegativeSignal) out.push({ priority: 4, text: 'Very even splits throughout. Good discipline on the pacing.' });
    }
  }

  // ── Distance adherence ─────────────────────────────────────────────────
  if (a.plannedDistanceKm != null && a.plannedDistanceKm > 0 && a.distanceKm > 0) {
    const ratio = a.distanceKm / a.plannedDistanceKm;
    const diff = a.distanceKm - a.plannedDistanceKm;
    if (isRun) {
      if (ratio >= 1.12) {
        out.push({ priority: 2, text: `You ran ${diff.toFixed(1)}km over the planned distance. The extra load has been carried forward to balance your upcoming sessions.` });
      } else if (ratio >= 1.06) {
        out.push({ priority: 4, text: `A little extra distance today — ${diff.toFixed(1)}km over plan. Good bonus mileage if energy allows.` });
      } else if (ratio <= 0.80 && a.plannedDistanceKm >= 8) {
        out.push({ priority: 3, text: `Distance came in ${Math.abs(diff).toFixed(1)}km short of plan. If it was a rough day, that's fine — the plan adapts.` });
      } else if (ratio >= 0.94 && ratio <= 1.06) {
        out.push({ priority: 5, text: 'Distance was right on target. Solid execution.' });
      }
    }
  }

  // ── Zone distribution ──────────────────────────────────────────────────
  if (a.hrZones) {
    const zones = a.hrZones;
    const total = zones.z1 + zones.z2 + zones.z3 + zones.z4 + zones.z5;
    if (total > 0) {
      const nonEasyPct = Math.round((1 - lowZonePct(zones)) * 100);
      if (isEasy && (1 - lowZonePct(zones)) > 0.25) {
        out.push({ priority: 2, text: `${nonEasyPct}% of this run was in Z3 or above. For an easy run, the target is mostly Z1-Z2. Common causes: heat, humidity, or terrain such as sand or trails.` });
      } else if (quality && lowZonePct(zones) > 0.70) {
        out.push({ priority: 3, text: 'Most of this session was in low HR zones. Quality sessions need enough stimulus — make sure the hard portions are genuinely hard.' });
      } else if (isLong && lowZonePct(zones) > 0.85) {
        out.push({ priority: 5, text: 'Great zone discipline on the long run — staying aerobic builds your endurance engine.' });
      }
    }
  }

  return out;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Generate 2-3 sentence coaching insight for a completed activity.
 * Returns null if there's not enough data to say anything useful.
 * Pass hrProfile to compute hrEffortScore on-the-fly if not stored on the actual.
 */
export function generateWorkoutInsight(actual: GarminActual, hrProfile?: HRProfileForInsight): string | null {
  let enriched = actual;
  if (hrProfile && actual.hrEffortScore == null && actual.avgHR) {
    const isRun = actual.activityType === 'RUNNING' || actual.activityType?.includes('RUN') || actual.plannedType != null;
    const effectiveType = actual.plannedType ?? (isRun ? 'easy' : null);
    if (effectiveType) {
      const computed = getHREffort(actual.avgHR, effectiveType, hrProfile);
      if (computed != null) enriched = { ...actual, hrEffortScore: computed };
    }
  }
  const candidates = collectCandidates(enriched);
  if (candidates.length === 0) return null;

  // Sort by priority (lower = more important), take top 2-3
  candidates.sort((a, b) => a.priority - b.priority);
  const picked = candidates.slice(0, Math.min(3, candidates.length));

  return picked.map(c => c.text).join(' ');
}
