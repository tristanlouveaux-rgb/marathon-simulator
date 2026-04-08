/**
 * workout-insight.ts
 * Narrative coaching commentary for completed activities.
 * Gathers raw signals (pacing, HR, elevation, load, session-to-session delta)
 * then composes a connected 2-3 sentence paragraph — like a coach reviewing
 * your session, not a dashboard restating numbers already visible on screen.
 */

import type { GarminActual } from '@/types';
import { getHREffort } from '@/calculations/activity-matcher';

export interface HRProfileForInsight {
  maxHR?: number | null;
  restingHR?: number | null;
  onboarding?: { age?: number };
}

export interface InsightOptions {
  hrProfile?: HRProfileForInsight;
  /** Most recent previous completed run of the same plannedType. */
  prev?: GarminActual | null;
  unitPref?: 'km' | 'mi';
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isQualityType(t: string | null | undefined): boolean {
  if (!t) return false;
  return ['threshold', 'vo2', 'intervals', 'marathon_pace', 'race_pace', 'tempo', 'progressive', 'float'].includes(t);
}

function splitCV(splits: number[]): number | null {
  const valid = splits.filter(s => s > 60 && s < 1200);
  if (valid.length < 3) return null;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  if (mean <= 0) return null;
  const variance = valid.reduce((a, v) => a + (v - mean) ** 2, 0) / valid.length;
  return Math.sqrt(variance) / mean;
}

function lowZonePct(zones: { z1: number; z2: number; z3: number; z4: number; z5: number }): number {
  const total = zones.z1 + zones.z2 + zones.z3 + zones.z4 + zones.z5;
  if (total <= 0) return 0;
  return (zones.z1 + zones.z2) / total;
}

function fmtPace(secPerKm: number, pref: 'km' | 'mi' = 'km'): string {
  const sec = pref === 'mi' ? secPerKm * 1.60934 : secPerKm;
  const unit = pref === 'mi' ? '/mi' : '/km';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}${unit}`;
}

function splitHalfPace(splits: number[]): { first: number; second: number; diff: number } | null {
  const valid = splits.filter(s => s > 60 && s < 1200);
  if (valid.length < 4) return null;
  const mid = Math.floor(valid.length / 2);
  const first = Math.round(valid.slice(0, mid).reduce((a, b) => a + b, 0) / mid);
  const second = Math.round(valid.slice(mid).reduce((a, b) => a + b, 0) / (valid.length - mid));
  return { first, second, diff: second - first };
}

// ─── signal gathering ───────────────────────────────────────────────────────

interface Signals {
  isRun: boolean;
  quality: boolean;
  isEasy: boolean;
  isLong: boolean;
  effortMismatch: boolean;
  isTreadmill: boolean;
  isShort: boolean;

  // Pacing
  half: { first: number; second: number; diff: number } | null;
  fade: boolean;
  negative: boolean;
  even: boolean;
  hasSplits: boolean;

  // HR
  hrDrift: number | null;
  hrEffort: number | null;
  avgHR: number | null;

  // Context
  elevPerKm: number | null;
  tssActual: number | null;
  tssExpected: number | null;
  tssRatio: number | null;
  distOverKm: number | null;
  distanceKm: number;

  // Pace
  paceAdh: number | null;
  avgPace: number | null;

  // Zones
  lowZonePct: number | null;
  zonesSurprising: boolean;

  // Session-to-session delta
  prevPace: number | null;
  prevAvgHR: number | null;
  prevHrDrift: number | null;

  // Unit preference
  unitPref: 'km' | 'mi';
}

function gatherSignals(a: GarminActual, prev: GarminActual | null | undefined, unitPref: 'km' | 'mi'): Signals {
  const isRun = a.activityType === 'RUNNING' || a.plannedType != null;
  const quality = isQualityType(a.plannedType);
  const isEasyLabel = a.plannedType === 'easy' || a.plannedType === 'recovery' || (!a.plannedType && isRun);
  const isLong = a.plannedType === 'long';
  const isTreadmill = a.activityType === 'TREADMILL_RUNNING';
  const isShort = a.distanceKm < 2 || a.durationSec < 600;

  const hasHighZones = a.hrZones ? (1 - lowZonePct(a.hrZones)) > 0.40 : false;
  const hasHighHR = a.hrEffortScore != null && a.hrEffortScore >= 1.15;
  const effortMismatch = isEasyLabel && (hasHighZones || hasHighHR);
  const isEasy = isEasyLabel && !effortMismatch;

  const half = (a.kmSplits && a.kmSplits.length >= 4) ? splitHalfPace(a.kmSplits) : null;
  const fade = half ? half.diff > 10 : false;
  const negative = half ? half.diff < -10 : false;
  const cv = (a.kmSplits && a.kmSplits.length >= 6) ? splitCV(a.kmSplits) : null;
  const even = cv != null && cv < 0.03 && !fade && !negative;

  const rawElevPerKm = (a.elevationGainM != null && a.elevationGainM > 0 && a.distanceKm > 0)
    ? Math.round(a.elevationGainM / a.distanceKm) : null;

  const durMin = a.durationSec > 0 ? a.durationSec / 60 : 0;
  const tssActual = a.iTrimp != null && a.iTrimp > 0
    ? Math.round((a.iTrimp * 100) / 15000)
    : durMin > 0 ? Math.round(durMin * 0.92) : null;
  let tssExpected: number | null = null;
  if (a.plannedDistanceKm != null && a.plannedDistanceKm > 0) {
    const tssPerKm = quality ? 7 : isLong ? 5 : 4;
    tssExpected = Math.round(a.plannedDistanceKm * tssPerKm);
  }
  const tssRatio = (tssActual != null && tssExpected != null && tssExpected > 0)
    ? tssActual / tssExpected : null;

  const distOverKm = (a.plannedDistanceKm != null && a.plannedDistanceKm > 0 && a.distanceKm > 0)
    ? a.distanceKm - a.plannedDistanceKm : null;

  const lzp = a.hrZones ? lowZonePct(a.hrZones) : null;
  const zonesSurprising = (quality && lzp != null && lzp > 0.70)
    || (isEasy && lzp != null && (1 - lzp) > 0.25);

  const prevPace = (prev?.avgPaceSecKm && prev.avgPaceSecKm > 0) ? prev.avgPaceSecKm : null;
  const prevAvgHR = prev?.avgHR ?? null;
  const prevHrDrift = prev?.hrDrift ?? null;

  return {
    isRun, quality, isEasy, isLong, effortMismatch, isTreadmill, isShort,
    half, fade, negative, even, hasSplits: half != null,
    hrDrift: (a.hrDrift != null && a.durationSec > 1200) ? a.hrDrift : null,
    hrEffort: a.hrEffortScore ?? null,
    avgHR: a.avgHR,
    elevPerKm: (rawElevPerKm != null && rawElevPerKm >= 15) ? rawElevPerKm : null,
    tssActual, tssExpected, tssRatio, distOverKm,
    distanceKm: a.distanceKm,
    paceAdh: a.paceAdherence ?? null,
    avgPace: a.avgPaceSecKm ?? null,
    lowZonePct: lzp, zonesSurprising,
    prevPace, prevAvgHR, prevHrDrift,
    unitPref,
  };
}

// ─── narrative composition ──────────────────────────────────────────────────

function composeNarrative(s: Signals): string | null {
  if (!s.isRun) return composeCrossTraining(s);

  // Short runs: only comment if something is notably off
  if (s.isShort) {
    if (s.quality && s.paceAdh != null && s.paceAdh < 0.92) {
      return `${Math.round((1 - s.paceAdh) * 100)}% faster than target pace.`;
    }
    return null;
  }

  const sentences: string[] = [];
  const p = s.unitPref;

  // ── Lead sentence: the pacing story or pace adherence ─────────────────
  if (s.half && s.fade) {
    let lead = `First half averaged ${fmtPace(s.half.first, p)}, second half ${fmtPace(s.half.second, p)}.`;
    if (s.elevPerKm) {
      lead += ` ${s.elevPerKm}m/km of climbing likely contributed to the slowdown.`;
    } else if (s.half.diff >= 20) {
      lead += ` ${Math.round(s.half.diff)}s/km fade — the opening pace was not sustainable at this distance.`;
    } else {
      lead += ` ${Math.round(s.half.diff)}s/km fade through the run.`;
    }
    sentences.push(lead);
  } else if (s.half && s.negative) {
    let lead = `Negative split: ${fmtPace(s.half.first, p)} first half, ${fmtPace(s.half.second, p)} second half.`;
    if (s.quality) {
      lead += ' Controlled start into a strong finish.';
    } else {
      lead += ` ${Math.abs(Math.round(s.half.diff))}s/km faster in the back end.`;
    }
    sentences.push(lead);
  } else if (s.half && s.even) {
    let lead = `Consistent pacing: ${fmtPace(s.half.first, p)} to ${fmtPace(s.half.second, p)} across the run.`;
    if (s.hrDrift != null && s.hrDrift <= 3) {
      lead += ' HR stayed flat too. Well-controlled effort.';
    }
    sentences.push(lead);
  } else if (s.quality && s.paceAdh != null) {
    if (s.paceAdh < 0.92) {
      const pct = Math.round((1 - s.paceAdh) * 100);
      let lead = `${pct}% faster than target pace.`;
      if (s.hrEffort != null && s.hrEffort >= 1.15) {
        lead += ' HR confirms it — the body paid for the extra speed.';
      } else if (s.hrEffort != null && s.hrEffort <= 0.85) {
        lead += ' HR stayed low, so this may reflect a fitness gain rather than overreaching.';
      } else {
        lead += ' Going too hot on quality days can cost recovery later in the week.';
      }
      sentences.push(lead);
    } else if (s.paceAdh > 1.10) {
      const pct = Math.round((s.paceAdh - 1) * 100);
      let lead = `${pct}% slower than target pace.`;
      if (s.hrEffort != null && s.hrEffort >= 1.15) {
        lead += ' HR was elevated despite the slower pace — the body was working hard regardless.';
      } else {
        lead += ' The plan will adapt.';
      }
      sentences.push(lead);
    } else if (s.paceAdh >= 0.95 && s.paceAdh <= 1.05) {
      let lead = 'Pace was on target.';
      if (s.hrEffort != null && s.hrEffort >= 1.15) {
        lead += ' HR was higher than expected though — the session cost more than it looked.';
      } else if (s.hrEffort != null && s.hrEffort <= 0.85) {
        lead += ' HR was low, suggesting the effort felt comfortable. Room to push next time.';
      }
      sentences.push(lead);
    }
  } else if (s.isTreadmill && s.quality) {
    if (s.hrEffort != null && s.hrEffort >= 1.15) {
      sentences.push('HR was elevated relative to target. The session cost more than planned.');
    } else if (s.hrEffort != null && s.hrEffort <= 0.85) {
      sentences.push('HR was well under target. Either the effort was comfortable or the treadmill pace was conservative.');
    }
  }

  // ── Second sentence: HR context (if not already woven in) ─────────────
  const hrMentioned = sentences.some(t => t.includes('HR'));
  if (!hrMentioned) {
    if (s.hrDrift != null && s.hrDrift > 8 && s.fade) {
      sentences.push(`HR drifted ${s.hrDrift.toFixed(0)}% across the session, consistent with the pace drop.`);
    } else if (s.hrDrift != null && s.hrDrift > 8) {
      sentences.push(`HR drifted ${s.hrDrift.toFixed(0)}% from first to second half.`);
    } else if (s.quality && s.hrEffort != null && s.hrEffort >= 1.15) {
      sentences.push('HR was elevated relative to target. The session cost more than planned.');
    } else if (s.quality && s.hrEffort != null && s.hrEffort <= 0.85) {
      sentences.push('HR was well under target. Either the effort was comfortable or not quite enough to drive the intended stimulus.');
    } else if (s.isEasy && s.hrEffort != null && s.hrEffort >= 1.15) {
      sentences.push('HR was elevated for an easy effort. Common causes: fatigue, heat, or terrain.');
    } else if (s.elevPerKm && !sentences.some(t => t.includes('m/km'))) {
      sentences.push(`${s.elevPerKm}m/km average gradient. Accounts for some of the HR load independently of pace.`);
    }
  }

  // ── Third sentence: load context ──────────────────────────────────────
  if (s.tssRatio != null && s.tssActual != null) {
    if (s.tssRatio > 1.5) {
      sentences.push(`${s.tssActual} TSS — roughly ${s.tssRatio.toFixed(1)}x what the plan expected. Plan adjusted accordingly.`);
    } else if (s.tssRatio < 0.6 && s.tssExpected != null && s.tssExpected >= 30) {
      sentences.push(`${s.tssActual} TSS, well under the planned load. The plan adapts.`);
    }
  } else if (s.distOverKm != null && !sentences.some(t => t.includes('TSS'))) {
    if (s.distOverKm > 2) {
      sentences.push(`${s.distOverKm.toFixed(1)} km over planned distance. Extra load carried forward.`);
    } else if (s.distOverKm < -3 && (s.tssExpected ?? 0) >= 30) {
      sentences.push(`${Math.abs(s.distOverKm).toFixed(1)} km short of plan.`);
    }
  }

  // ── Session-to-session comparison ─────────────────────────────────────
  if (sentences.length < 3 && s.avgPace != null && s.prevPace != null && s.avgHR != null && s.prevAvgHR != null) {
    const paceDiff = Math.round(s.prevPace - s.avgPace); // positive = got faster
    const hrDiff = Math.round(s.avgHR - s.prevAvgHR);    // positive = higher HR
    const typeLabel = s.quality ? 'quality' : s.isLong ? 'long' : 'easy';

    if (paceDiff > 5 && hrDiff <= -2) {
      sentences.push(`${Math.abs(paceDiff)}s/km faster than the last ${typeLabel} session at ${Math.abs(hrDiff)} bpm lower average HR.`);
    } else if (paceDiff > 5 && hrDiff <= 3) {
      sentences.push(`${Math.abs(paceDiff)}s/km faster than the last session of this type at similar HR.`);
    } else if (Math.abs(paceDiff) <= 5 && hrDiff <= -3) {
      sentences.push(`Similar pace to last time but ${Math.abs(hrDiff)} bpm lower average HR. Aerobic efficiency improving.`);
    } else if (paceDiff < -8 && hrDiff > 3) {
      sentences.push(`${Math.abs(paceDiff)}s/km slower than last time at ${hrDiff} bpm higher HR. Fatigue, heat, or terrain may explain the difference.`);
    }
  } else if (sentences.length < 3 && s.hrDrift != null && s.prevHrDrift != null) {
    const driftDiff = s.hrDrift - s.prevHrDrift;
    if (driftDiff < -5 && s.hrDrift < 5) {
      sentences.push(`HR drift improved to ${s.hrDrift.toFixed(0)}% from ${s.prevHrDrift.toFixed(0)}% last session. Better aerobic control.`);
    }
  }

  // ── Zone surprise (only if nothing else said it) ──────────────────────
  if (s.zonesSurprising && sentences.length < 2) {
    if (s.quality && s.lowZonePct != null && s.lowZonePct > 0.70) {
      sentences.push('Mostly low HR zones on a quality session. The hard segments may not have been hard enough to drive adaptation.');
    } else if (s.isEasy && s.lowZonePct != null) {
      const above = Math.round((1 - s.lowZonePct) * 100);
      sentences.push(`${above}% of time above Z2. For easy runs, the target is mostly Z1-Z2.`);
    }
  }

  // ── Easy pace warning (genuine easy, not mismatch) ────────────────────
  if (s.isEasy && s.paceAdh != null && s.paceAdh < 0.88 && sentences.length === 0) {
    sentences.push('Pace was well under easy target. Easy days protect recovery for quality sessions.');
  }

  // ── Mismatch fallback ─────────────────────────────────────────────────
  if (s.effortMismatch && sentences.length === 0) {
    sentences.push('Higher effort than the planned slot. The extra load is accounted for.');
  }

  if (sentences.length === 0) return null;
  return sentences.slice(0, 3).join(' ');
}

function composeCrossTraining(s: Signals): string | null {
  if (s.hrEffort != null && s.hrEffort >= 1.20) {
    return 'High-effort session by heart rate. The extra load is accounted for in the plan.';
  }
  return null;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Generate 2-3 sentence coaching insight for a completed activity.
 * Returns null if there's not enough data to say anything useful.
 *
 * @param actual - The activity to analyse
 * @param opts - Optional: hrProfile for on-the-fly hrEffortScore, prev session
 *               for session-to-session comparison, unitPref for pace formatting.
 *               Also accepts a bare HRProfileForInsight for backward compat.
 */
export function generateWorkoutInsight(actual: GarminActual, opts?: HRProfileForInsight | InsightOptions): string | null {
  // Support legacy call signature (hrProfile directly) and new options object
  const isLegacy = opts != null && ('maxHR' in opts || 'restingHR' in opts || 'onboarding' in opts) && !('prev' in opts) && !('unitPref' in opts) && !('hrProfile' in opts);
  const hrProfile: HRProfileForInsight | undefined = isLegacy ? opts as HRProfileForInsight : (opts as InsightOptions)?.hrProfile;
  const prev = isLegacy ? undefined : (opts as InsightOptions)?.prev;
  const unitPref = isLegacy ? 'km' : ((opts as InsightOptions)?.unitPref ?? 'km');

  let enriched = actual;
  if (hrProfile && actual.hrEffortScore == null && actual.avgHR) {
    const isRun = actual.activityType === 'RUNNING' || actual.activityType?.includes('RUN') || actual.plannedType != null;
    const effectiveType = actual.plannedType ?? (isRun ? 'easy' : null);
    if (effectiveType) {
      const computed = getHREffort(actual.avgHR, effectiveType, hrProfile);
      if (computed != null) enriched = { ...actual, hrEffortScore: computed };
    }
  }
  const signals = gatherSignals(enriched, prev, unitPref);
  return composeNarrative(signals);
}

// ─── helper to find previous session of same type ───────────────────────────

/**
 * Search backwards through plan weeks for the most recent completed run
 * of the same plannedType. Returns null if none found.
 */
export function findPreviousSession(
  plannedType: string | null | undefined,
  currentGarminId: string,
  wks: Array<{ garminActuals?: Record<string, GarminActual> }>,
): GarminActual | null {
  if (!plannedType) return null;
  for (let i = wks.length - 1; i >= 0; i--) {
    const actuals = wks[i].garminActuals;
    if (!actuals) continue;
    for (const actual of Object.values(actuals)) {
      if (actual.garminId === currentGarminId) continue;
      if (actual.plannedType === plannedType && actual.avgPaceSecKm && actual.avgHR) {
        return actual;
      }
    }
  }
  return null;
}
