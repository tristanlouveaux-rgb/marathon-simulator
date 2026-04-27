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
  /** All completed activities across all weeks — used for TSS and HR historical comparison. */
  allActuals?: GarminActual[];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isQualityType(t: string | null | undefined): boolean {
  if (!t) return false;
  return ['threshold', 'vo2', 'intervals', 'marathon_pace', 'race_pace', 'tempo', 'progressive', 'float'].includes(t);
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

/**
 * Fit a linear regression to km splits.
 * Returns slope (s/km per km), R², and regression-predicted paces at km 1 and km n.
 * Positive slope = fading; negative slope = picking up pace.
 */
function computeRegressionSlope(splits: number[]): {
  slope: number; r2: number; paceStart: number; paceEnd: number;
} | null {
  const valid = splits.filter(s => s > 60 && s < 1200);
  if (valid.length < 4) return null;
  const n = valid.length;
  const xs = Array.from({ length: n }, (_, i) => i + 1);
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = valid.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * valid[i], 0);
  const sumX2 = xs.reduce((acc, x) => acc + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  const ssTot = valid.reduce((acc, y) => acc + (y - meanY) ** 2, 0);
  const ssRes = valid.reduce((acc, y, i) => {
    const yHat = intercept + slope * xs[i];
    return acc + (y - yHat) ** 2;
  }, 0);
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope, r2, paceStart: intercept + slope, paceEnd: intercept + slope * n };
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

  // Pacing — regression-based
  slope: number | null;        // s/km per km; positive = fading
  slopeR2: number | null;      // goodness of fit (0–1)
  slopePaceStart: number | null; // regression-predicted pace at km 1
  slopePaceEnd: number | null;   // regression-predicted pace at last km
  hasSplits: boolean;

  // HR
  hrDrift: number | null;
  hrDriftAdjusted: number | null;
  ambientTempC: number | null;
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

  // HR relative to max
  hrPctMax: number | null;

  // TSS historical comparison: weeks since last run with TSS >= current
  weeksAgoHigherTSS: number | null;

  // HR historical comparison: weeks since last run with avgHR >= current
  weeksAgoHigherHR: number | null;

  // Unit preference
  unitPref: 'km' | 'mi';
}

function gatherSignals(a: GarminActual, prev: GarminActual | null | undefined, unitPref: 'km' | 'mi', opts?: InsightOptions): Signals {
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

  // Pacing: linear regression over all km splits
  const reg = a.kmSplits && a.kmSplits.length >= 4 ? computeRegressionSlope(a.kmSplits) : null;
  const slope = reg?.slope ?? null;
  const slopeR2 = reg?.r2 ?? null;
  const slopePaceStart = reg?.paceStart ?? null;
  const slopePaceEnd = reg?.paceEnd ?? null;
  const hasSplits = reg != null;

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

  const hrDrift = (a.hrDrift != null && a.durationSec > 1200) ? a.hrDrift : null;
  const ambientTempC = a.ambientTempC ?? null;
  const hrDriftAdjusted = (hrDrift != null && ambientTempC != null)
    ? hrDrift - 0.15 * Math.max(0, ambientTempC - 15)
    : null;

  // HR as % of max
  const maxHR = opts?.hrProfile?.maxHR ?? null;
  const hrPctMax = (a.avgHR != null && maxHR != null && maxHR > 0) ? a.avgHR / maxHR : null;

  const isRunActivity = (act: GarminActual) =>
    act.activityType === 'RUNNING' || (act.activityType?.includes('RUN') ?? false) || act.plannedType != null;

  const currentMs = a.startTime ? new Date(a.startTime).getTime() : Date.now();

  // TSS historical: weeks since last run with TSS >= tssActual
  let weeksAgoHigherTSS: number | null = null;
  if (tssActual != null && tssActual >= 80 && opts?.allActuals && opts.allActuals.length > 0) {
    const tssFor = (act: GarminActual): number | null => {
      const durMin = act.durationSec > 0 ? act.durationSec / 60 : 0;
      return act.iTrimp != null && act.iTrimp > 0
        ? Math.round((act.iTrimp * 100) / 15000)
        : durMin > 0 ? Math.round(durMin * 0.92) : null;
    };
    const priorHigherTSS = opts.allActuals
      .filter(act => {
        if (act.garminId === a.garminId || !act.startTime || !isRunActivity(act)) return false;
        const ms = new Date(act.startTime).getTime();
        if (isNaN(ms) || ms >= currentMs) return false;
        const t = tssFor(act);
        return t != null && t >= tssActual!;
      })
      .sort((x, y) => new Date(y.startTime!).getTime() - new Date(x.startTime!).getTime());

    if (priorHigherTSS.length > 0) {
      const mostRecentMs = new Date(priorHigherTSS[0].startTime!).getTime();
      const weeksAgo = Math.round((currentMs - mostRecentMs) / (7 * 24 * 60 * 60 * 1000));
      if (weeksAgo >= 3) weeksAgoHigherTSS = weeksAgo;
    }
  }

  // HR historical: weeks since last run with avgHR >= current
  let weeksAgoHigherHR: number | null = null;
  if (a.avgHR != null && a.avgHR > 0 && opts?.allActuals && opts.allActuals.length > 0) {
    const priorHigherHR = opts.allActuals
      .filter(act => {
        if (act.garminId === a.garminId || !act.startTime || !isRunActivity(act)) return false;
        const ms = new Date(act.startTime).getTime();
        if (isNaN(ms) || ms >= currentMs) return false;
        return act.avgHR != null && act.avgHR >= a.avgHR!;
      })
      .sort((x, y) => new Date(y.startTime!).getTime() - new Date(x.startTime!).getTime());

    if (priorHigherHR.length > 0) {
      const mostRecentMs = new Date(priorHigherHR[0].startTime!).getTime();
      const weeksAgo = Math.round((currentMs - mostRecentMs) / (7 * 24 * 60 * 60 * 1000));
      if (weeksAgo >= 3) weeksAgoHigherHR = weeksAgo;
    }
  }

  return {
    isRun, quality, isEasy, isLong, effortMismatch, isTreadmill, isShort,
    slope, slopeR2, slopePaceStart, slopePaceEnd, hasSplits,
    hrDrift, hrDriftAdjusted, ambientTempC,
    hrEffort: a.hrEffortScore ?? null,
    avgHR: a.avgHR,
    elevPerKm: (rawElevPerKm != null && rawElevPerKm >= 15) ? rawElevPerKm : null,
    tssActual, tssExpected, tssRatio, distOverKm,
    distanceKm: a.distanceKm,
    paceAdh: a.paceAdherence ?? null,
    avgPace: a.avgPaceSecKm ?? null,
    lowZonePct: lzp, zonesSurprising,
    prevPace, prevAvgHR, prevHrDrift,
    hrPctMax,
    weeksAgoHigherTSS,
    weeksAgoHigherHR,
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

  // ── Lead sentence: pacing story ───────────────────────────────────────
  const isVeryHighHR = s.hrPctMax != null && s.hrPctMax >= 0.87;
  // Slope thresholds: > 4 s/km/km with R² > 0.12 = meaningful trend
  const isFading = s.slope != null && s.slopeR2 != null && s.slope > 4 && s.slopeR2 > 0.12;
  const isPickingUp = s.slope != null && s.slopeR2 != null && s.slope < -4 && s.slopeR2 > 0.12;
  // Show regression bookends only when the trend is clean (R² > 0.35)
  const cleanTrend = isFading && s.slopeR2! > 0.35 && s.slopePaceStart != null && s.slopePaceEnd != null;

  if (s.hasSplits && isFading) {
    const slopeRnd = Math.round(s.slope!);
    const hrHistCtx = s.weeksAgoHigherHR != null ? `, the highest average HR in ${s.weeksAgoHigherHR} weeks,` : '';
    let lead: string;

    if (isVeryHighHR && s.avgHR != null && s.hrPctMax != null && !s.elevPerKm) {
      const pct = Math.round(s.hrPctMax * 100);
      if (cleanTrend) {
        lead = `Pace slipped ${slopeRnd}s every kilometre: ${fmtPace(s.slopePaceStart!, p)} at the start to ${fmtPace(s.slopePaceEnd!, p)} by the end.`
             + ` Avg HR ${Math.round(s.avgHR)} bpm at ${pct}% of max${hrHistCtx} placed this at near-threshold intensity throughout; glycogen depletion drove the progressive slowdown, making the session harder than the pace reflects.`;
      } else {
        lead = `Pace faded at ~${slopeRnd}s every kilometre through the run.`
             + ` Avg HR ${Math.round(s.avgHR)} bpm at ${pct}% of max${hrHistCtx} confirms this ran at near-threshold intensity; the session was harder than the pace reflects.`;
      }
    } else {
      if (cleanTrend) {
        lead = `Pace slipped ${slopeRnd}s every kilometre: ${fmtPace(s.slopePaceStart!, p)} at the start to ${fmtPace(s.slopePaceEnd!, p)} by the end.`;
      } else {
        lead = `Pace faded at ~${slopeRnd}s every kilometre through the run.`;
      }
      if (s.elevPerKm) {
        lead += ` ${s.elevPerKm}m/km of climbing likely contributed.`;
      } else if (s.slope! > 8) {
        lead += ' The opening pace was not sustainable at this distance.';
      }
    }
    sentences.push(lead);

  } else if (s.hasSplits && isPickingUp) {
    const slopeRnd = Math.abs(Math.round(s.slope!));
    const cleanNeg = s.slopeR2! > 0.35 && s.slopePaceStart != null && s.slopePaceEnd != null;
    let lead: string;
    if (cleanNeg) {
      lead = `Negative split: ${fmtPace(s.slopePaceStart!, p)} at the start, ${fmtPace(s.slopePaceEnd!, p)} by the end.`;
      lead += s.quality ? ' Controlled start into a strong finish.' : ` Picking up ${slopeRnd}s every kilometre through the run.`;
    } else {
      lead = `Pace picked up through the run at ~${slopeRnd}s every kilometre.`;
      if (s.quality) lead += ' Controlled start into a strong finish.';
    }
    sentences.push(lead);

  } else if (s.hasSplits) {
    // Slope is flat or noisy — note consistent pacing; add HR qualifier when drift data exists
    const hrNote = (s.hrDrift != null && s.hrDrift <= 3) ? ' HR stayed flat too.' : '';
    sentences.push(`Consistent pacing throughout.${hrNote} Well-controlled effort.`);

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
  const hrMentioned = sentences.some(t => t.includes('HR') || t.includes('bpm'));
  if (!hrMentioned) {
    if (s.hrPctMax != null && s.hrPctMax >= 0.87 && s.avgHR != null) {
      const pct = Math.round(s.hrPctMax * 100);
      let hrLine = `Avg HR ${Math.round(s.avgHR)} bpm at ${pct}% of max`;
      if (s.weeksAgoHigherHR != null) {
        hrLine += `, the highest average HR in ${s.weeksAgoHigherHR} weeks`;
      }
      if (s.hrEffort != null && s.hrEffort >= 1.15) {
        hrLine += ` and ${Math.round((s.hrEffort - 1) * 100)}% above what this session type would normally cost`;
      }
      if (s.hrPctMax >= 0.90) {
        hrLine += '. This session was harder than the pace indicates. A race-grade cardiovascular stimulus.';
      } else {
        hrLine += '. High-zone effort throughout; the session was harder than the pace alone suggests.';
      }
      sentences.push(hrLine);
    } else if (!s.quality && s.hrDrift != null && s.hrDrift > 8 && isFading) {
      const hot = s.ambientTempC != null && s.ambientTempC >= 22;
      const adj = hot && s.hrDriftAdjusted != null
        ? ` Accounting for ${Math.round(s.ambientTempC!)}°C ambient heat, the heat-adjusted drift is ${s.hrDriftAdjusted.toFixed(0)}%, suggesting conditions carried most of the load.`
        : ' On an easy or long effort, rising HR at steady pace usually points to heat, dehydration, fatigue, or a pace that was too aggressive.';
      sentences.push(`HR drifted ${s.hrDrift.toFixed(0)}% across the session, consistent with the pace drop.${adj}`);
    } else if (!s.quality && s.hrDrift != null && s.hrDrift > 8) {
      const hot = s.ambientTempC != null && s.ambientTempC >= 22;
      const adj = hot && s.hrDriftAdjusted != null
        ? ` At ${Math.round(s.ambientTempC!)}°C, heat-adjusted drift is ${s.hrDriftAdjusted.toFixed(0)}% — the conditions explain most of the rise.`
        : ' On an easy or long effort, rising HR at steady pace usually points to heat, dehydration, fatigue, or a pace that was too aggressive.';
      sentences.push(`HR drifted ${s.hrDrift.toFixed(0)}% from start to finish.${adj}`);
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
    const paceDiff = Math.round(s.prevPace - s.avgPace);
    const hrDiff = Math.round(s.avgHR - s.prevAvgHR);
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

  // ── TSS historical high ───────────────────────────────────────────────
  if (sentences.length < 3 && s.weeksAgoHigherTSS != null && s.tssActual != null) {
    const highHRContext = sentences.some(t => t.includes('bpm') || t.includes('HR'));
    if (highHRContext) {
      sentences.push(`At ${s.tssActual} TSS, the heaviest run in ${s.weeksAgoHigherTSS} weeks. The physiological cost sits well above what pace or distance alone would imply.`);
    } else {
      sentences.push(`At ${s.tssActual} TSS, the heaviest run in ${s.weeksAgoHigherTSS} weeks.`);
    }
  }

  // ── Recovery guidance for genuinely hard sessions ─────────────────────
  const recoveryMentioned = sentences.some(t => t.includes('easy day') || t.includes('easy running') || t.includes('recover'));
  if (!recoveryMentioned && isVeryHighHR && s.tssActual != null && s.tssActual >= 80 && sentences.length < 3) {
    sentences.push('Allow at least one easy day before the next quality session. The recovery demand here is higher than the pace makes it look.');
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
    if (isVeryHighHR && s.avgHR != null && s.hrPctMax != null) {
      const pct = Math.round(s.hrPctMax * 100);
      let line = `HR at ${pct}% of max on a session planned at easy intensity`;
      if (s.weeksAgoHigherHR != null) {
        line += `, the highest average HR in ${s.weeksAgoHigherHR} weeks`;
      }
      if (s.hrEffort != null && s.hrEffort >= 1.15) {
        line += ` and ${Math.round((s.hrEffort - 1) * 100)}% above what an easy effort would normally cost`;
      }
      line += '. This was harder than the pace reflects. The extra load is accounted for.';
      sentences.push(line);
    } else {
      sentences.push('Higher effort than the planned slot. The extra load is accounted for.');
    }
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
  const resolvedOpts: InsightOptions | undefined = isLegacy ? undefined : (opts as InsightOptions | undefined);
  const signals = gatherSignals(enriched, prev, unitPref, resolvedOpts);
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
