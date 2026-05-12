/**
 * VO2max diagnostic — runs every available estimator on the current state and
 * prints a side-by-side comparison so we can see which signals agree, which
 * disagree, and where the displayed headline number is coming from.
 *
 * Read-only, no state mutation. Intended for browser-console invocation via
 * `diagnoseVO2()` (wired in main.ts).
 *
 * Each row in the output answers "what would VO2max be if we used only this
 * signal?" — so you can spot the outliers visually rather than trusting a
 * single black-box estimator.
 */

import type { SimulatorState, GarminActual } from '@/types';
import { getState } from '@/state';
import { cv } from './vdot';
import { computeHRCalibratedVdot } from './effort-calibrated-vdot';
import { deriveVdotFromLT } from './lt-derivation';
import { pbDerivedVdot } from './physiological-vdot';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_WEEKS = 8;

/** Cooper 1968 — VO2max in ml/kg/min from distance covered in 12 minutes. */
function cooperVO2(distanceM: number): number {
  return (distanceM - 504.9) / 44.73;
}

interface RunRow {
  startTime: string;
  ageDays: number;
  distKm: number;
  durSec: number;
  avgPace: number;        // sec/km
  avgHR: number;
  maxHR: number | null;
  hrDrift: number | null;
  hrrFraction: number;    // (avgHR - RHR) / (maxHR_athlete - RHR)
  fastestKmPace: number | null;  // sec/km (best single-km split)
  splits: number[] | null;
  lapCount: number;
  lapsWithHR: number;
}

/** A single sub-run sample (per-lap or per-segment) used to fit the
 *  pace-vs-HR regression on within-run variation rather than run-level
 *  averages. */
interface LapPoint {
  runStartTime: string;
  lapIndex: number;
  distKm: number;
  durSec: number;
  paceSecKm: number;
  avgHR: number;
  hrrFraction: number;
}

function collectRuns(s: SimulatorState, now: Date): { runs: RunRow[]; lapPoints: LapPoint[] } {
  const out: RunRow[] = [];
  const lapPoints: LapPoint[] = [];
  const rhr = s.restingHR ?? 0;
  const maxHR = s.maxHR ?? 0;
  const cutoff = now.getTime() - WINDOW_WEEKS * 7 * DAY_MS;
  const hrrDenom = rhr > 0 && maxHR > rhr ? maxHR - rhr : null;

  for (const wk of s.wks ?? []) {
    if (!wk.garminActuals) continue;
    for (const id in wk.garminActuals) {
      const a = wk.garminActuals[id] as GarminActual;
      if (!a.startTime || !a.durationSec) continue;
      const isRun = (a.activityType ?? '').toUpperCase().includes('RUNNING')
        || a.manualSport === 'running';
      if (!isRun) continue;
      const startMs = new Date(a.startTime).getTime();
      if (!isFinite(startMs) || startMs < cutoff) continue;
      if (!a.distanceKm || a.distanceKm <= 0) continue;
      if (!a.avgHR || a.avgHR <= 0) continue;

      const avgPace = a.avgPaceSecKm ?? (a.durationSec / a.distanceKm);
      const hrr = hrrDenom != null ? (a.avgHR - rhr) / hrrDenom : NaN;
      const splits = a.kmSplits ?? null;
      const fastestKmPace = splits && splits.length > 0
        ? Math.min(...splits.filter(s => s > 0))
        : null;

      // Per-lap extraction. Each lap with valid HR + pace + ≥ 30 s duration
      // becomes a (paceSecKm, %HRR) point so that within-run variation —
      // e.g. an easy warmup followed by a tempo finish — feeds the regression
      // as separate signals instead of being averaged into one.
      const laps = a.laps ?? [];
      let lapsWithHR = 0;
      for (let i = 0; i < laps.length; i++) {
        const lap = laps[i];
        if (!lap.avgHR || lap.avgHR <= 0) continue;
        if (!lap.durationSec || lap.durationSec < 30) continue;
        if (!lap.avgPaceSecKm || lap.avgPaceSecKm < 120 || lap.avgPaceSecKm > 600) continue;
        if (hrrDenom == null) continue;
        const lapHRR = (lap.avgHR - rhr) / hrrDenom;
        if (!isFinite(lapHRR)) continue;
        lapsWithHR += 1;
        lapPoints.push({
          runStartTime: a.startTime,
          lapIndex: lap.index ?? i + 1,
          distKm: lap.distanceM / 1000,
          durSec: lap.durationSec,
          paceSecKm: lap.avgPaceSecKm,
          avgHR: lap.avgHR,
          hrrFraction: lapHRR,
        });
      }

      out.push({
        startTime: a.startTime,
        ageDays: Math.round((now.getTime() - startMs) / DAY_MS),
        distKm: a.distanceKm,
        durSec: a.durationSec,
        avgPace,
        avgHR: a.avgHR,
        maxHR: a.maxHR,
        hrDrift: a.hrDrift ?? null,
        hrrFraction: hrr,
        fastestKmPace,
        splits,
        lapCount: laps.length,
        lapsWithHR,
      });
    }
  }
  out.sort((a, b) => a.ageDays - b.ageDays);
  return { runs: out, lapPoints };
}

/** Weighted linear regression of pace on %HRR. Returns null when the fit is
 *  degenerate. Mirrors the math in `effort-calibrated-vdot.ts` so the lap-level
 *  result is directly comparable to the run-level one. */
function fitLapRegression(points: LapPoint[]): {
  alpha: number; beta: number; r2: number; paceAtVO2max: number; vdot: number;
} | null {
  if (points.length < 3) return null;
  let sumW = 0, sumWX = 0, sumWY = 0;
  for (const p of points) {
    sumW += p.durSec;
    sumWX += p.durSec * p.hrrFraction;
    sumWY += p.durSec * p.paceSecKm;
  }
  const meanX = sumWX / sumW;
  const meanY = sumWY / sumW;
  let num = 0, den = 0;
  for (const p of points) {
    const dx = p.hrrFraction - meanX;
    num += p.durSec * dx * (p.paceSecKm - meanY);
    den += p.durSec * dx * dx;
  }
  if (den <= 0) return null;
  const beta = num / den;
  const alpha = meanY - beta * meanX;
  if (beta >= 0) return null;
  let ssRes = 0, ssTot = 0;
  for (const p of points) {
    const pred = alpha + beta * p.hrrFraction;
    ssRes += p.durSec * (p.paceSecKm - pred) ** 2;
    ssTot += p.durSec * (p.paceSecKm - meanY) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const paceAtVO2max = alpha + beta * 1.0;
  // Use cv() at the inferred 3200 m time.
  // Inline since vo2-diagnostic already imports cv at module scope.
  const vdot = paceAtVO2max > 0 ? cv(3200, paceAtVO2max * 3.2) : NaN;
  return { alpha, beta, r2, paceAtVO2max, vdot };
}

/** Best contiguous N-second effort within a run, approximated from km splits.
 *  Walks the splits and finds the segment whose total time is closest to
 *  targetSec while distance is maximised. */
function bestNSecondEffort(
  splits: number[],
  targetSec: number,
): { distKm: number; timeSec: number } | null {
  if (!splits.length) return null;
  let best: { distKm: number; timeSec: number; pace: number } | null = null;
  for (let i = 0; i < splits.length; i++) {
    let acc = 0;
    for (let j = i; j < splits.length; j++) {
      acc += splits[j];
      if (acc >= targetSec) {
        const distKm = j - i + 1;
        const pace = acc / distKm;
        if (!best || pace < best.pace) best = { distKm, timeSec: acc, pace };
        break;
      }
    }
  }
  if (best) return { distKm: best.distKm, timeSec: best.timeSec };
  // Run never reached targetSec — return total if at least 80 % of target.
  const total = splits.reduce((a, b) => a + b, 0);
  if (total >= targetSec * 0.8) {
    return { distKm: splits.length, timeSec: total };
  }
  return null;
}

/** Best contiguous N-km effort within a run from km splits. */
function bestNKmEffort(splits: number[], n: number): number | null {
  if (splits.length < n) return null;
  let best = Infinity;
  for (let i = 0; i + n <= splits.length; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) acc += splits[i + j];
    if (acc < best) best = acc;
  }
  return isFinite(best) ? best : null;
}

interface VDOTSignal {
  label: string;
  vdot: number | null;
  detail: string;
}

export interface VO2Diagnostic {
  athlete: {
    restingHR: number | null;
    maxHR: number | null;
    bodyWeightKg: number | null;
    deviceVO2: number | null;
  };
  signals: VDOTSignal[];
  hrrHistogram: Array<{ bucket: string; n: number }>;
  hrrHistogramLap: Array<{ bucket: string; n: number }>;
  qualifyingRuns: RunRow[];
  hrRegressionDetail: {
    n: number;
    r2: number | null;
    paceAtVO2max: number | null;
    alpha: number | null;
    beta: number | null;
    points: Array<{ vo2r: number; paceSecKm: number; durationSec: number }>;
  };
  lapRegressionDetail: {
    n: number;
    r2: number | null;
    paceAtVO2max: number | null;
    alpha: number | null;
    beta: number | null;
    vdot: number | null;
    points: LapPoint[];
  };
  currentDisplay: {
    runningEstimate: number | null;
    runningSource: string | null;
    runningConfidence: string | null;
  };
}

export function runVO2Diagnostic(s: SimulatorState = getState(), now: Date = new Date()): VO2Diagnostic {
  const { runs, lapPoints } = collectRuns(s, now);

  // ─── Signal 1: PB-median VDOT ────────────────────────────────────────────
  const vdotPB = pbDerivedVdot(s);

  // ─── Signal 2: LT-derived VDOT ──────────────────────────────────────────
  const vdotLT = s.lt ? deriveVdotFromLT(s.lt) : null;

  // ─── Signal 3: Watch reading ────────────────────────────────────────────
  const vdotWatch = s.vo2 ?? null;

  // ─── Signal 4: HR regression (current orchestrator path) ────────────────
  // Mirrors vo2-orchestrator.ts: prefer per-km segments when both kmSplits
  // and kmHRSplits are populated on the activity; fall back to one run-level
  // (avgPace, avgHR) point per run otherwise.
  type RunInputArr = Parameters<typeof computeHRCalibratedVdot>[0];
  const hrRunInputs: RunInputArr = [];
  for (const wk of s.wks ?? []) {
    if (!wk.garminActuals) continue;
    for (const id in wk.garminActuals) {
      const a = wk.garminActuals[id];
      if (!a.startTime || !a.durationSec) continue;
      const isRun = (a.activityType ?? '').toUpperCase().includes('RUNNING')
        || a.manualSport === 'running';
      if (!isRun) continue;
      const startMs = new Date(a.startTime).getTime();
      if (!isFinite(startMs) || startMs < now.getTime() - WINDOW_WEEKS * 7 * DAY_MS) continue;
      if (!a.distanceKm || !a.avgHR || a.avgHR <= 0) continue;
      const splits = a.kmSplits ?? null;
      const hrSplits = a.kmHRSplits ?? null;
      let emitted = 0;
      if (splits && splits.length > 0 && hrSplits && hrSplits.length > 0) {
        const pairedLen = Math.min(splits.length, hrSplits.length);
        for (let i = 0; i < pairedLen; i++) {
          const paceSecKm = splits[i];
          const hr = hrSplits[i];
          if (!paceSecKm || paceSecKm <= 0 || !hr || hr <= 0) continue;
          hrRunInputs.push({
            startTime: a.startTime,
            distKm: 1.0,
            durSec: paceSecKm,
            avgHR: hr,
            isSegment: true,
          });
          emitted += 1;
        }
      }
      if (emitted === 0) {
        hrRunInputs.push({
          startTime: a.startTime,
          distKm: a.distanceKm,
          durSec: a.durationSec,
          avgHR: a.avgHR,
          hrDrift: a.hrDrift ?? null,
        });
      }
    }
  }
  const hrFit = computeHRCalibratedVdot(hrRunInputs, s.restingHR, s.maxHR, now);

  // ─── Signal 5: T-pace anchor (steady runs at 85–92 % HRmax) ─────────────
  // For each qualifying run, compute its implied T-pace VDOT directly.
  const TPACE_HRR_MIN = 0.80;
  const TPACE_HRR_MAX = 0.92;
  const tpaceVDOTs: number[] = [];
  const tpaceRuns: Array<{ pace: number; hrr: number; vdot: number }> = [];
  for (const r of runs) {
    if (r.durSec < 20 * 60) continue;
    if (r.hrrFraction < TPACE_HRR_MIN || r.hrrFraction > TPACE_HRR_MAX) continue;
    if (r.hrDrift != null && Math.abs(r.hrDrift) > 5) continue;
    // T-pace = vVO2max / 0.88 → vVO2max sec/km = T-pace × 0.88
    // Then VDOT from cv() at the inferred 3200m time.
    const vVO2maxSecKm = r.avgPace * 0.88;
    const vdot = cv(3200, vVO2maxSecKm * 3.2);
    tpaceVDOTs.push(vdot);
    tpaceRuns.push({ pace: r.avgPace, hrr: r.hrrFraction, vdot });
  }
  const vdotT = tpaceVDOTs.length > 0
    ? tpaceVDOTs.sort((a, b) => a - b)[Math.floor(tpaceVDOTs.length / 2)]
    : null;

  // ─── Signal 6: Billat 6-min vVO2max ─────────────────────────────────────
  // Best 6-min effort across all runs in window (from splits). Pace at 6 min
  // ≈ vVO2max (Billat 1996, 2001). Then convert to VDOT via cv(3200, pace×3.2).
  let bestBillatPace: number | null = null;
  for (const r of runs) {
    if (!r.splits) continue;
    const eff = bestNSecondEffort(r.splits, 360); // 6 min
    if (!eff) continue;
    const pace = eff.timeSec / eff.distKm;
    if (bestBillatPace == null || pace < bestBillatPace) bestBillatPace = pace;
  }
  const vdotBillat = bestBillatPace != null
    ? cv(3200, bestBillatPace * 3.2)
    : null;

  // ─── Signal 7: Cooper 12-min equivalent ─────────────────────────────────
  // Best 12-min distance. VO2max = (m - 504.9) / 44.73.
  let bestCooperDist: number | null = null;
  for (const r of runs) {
    if (!r.splits) continue;
    const eff = bestNSecondEffort(r.splits, 720); // 12 min
    if (!eff) continue;
    // Convert km-units back to metres. distKm here is integer km count,
    // so we'll scale to actual distance: (12*60 / pace) gives metres exactly.
    const pace = eff.timeSec / eff.distKm; // sec/km
    const distAt12min = (720 / pace) * 1000; // metres in 12 min at this pace
    if (bestCooperDist == null || distAt12min > bestCooperDist) bestCooperDist = distAt12min;
  }
  const vo2Cooper = bestCooperDist != null ? cooperVO2(bestCooperDist) : null;

  // ─── Signal 8: Best 5K within any run → Daniels VDOT ────────────────────
  let best5kSec: number | null = null;
  for (const r of runs) {
    if (!r.splits) continue;
    const t = bestNKmEffort(r.splits, 5);
    if (t == null) continue;
    if (best5kSec == null || t < best5kSec) best5kSec = t;
  }
  const vdot5kInRun = best5kSec != null ? cv(5000, best5kSec) : null;

  // ─── Signal 9: Best 10K within any run → Daniels VDOT ───────────────────
  let best10kSec: number | null = null;
  for (const r of runs) {
    if (!r.splits) continue;
    const t = bestNKmEffort(r.splits, 10);
    if (t == null) continue;
    if (best10kSec == null || t < best10kSec) best10kSec = t;
  }
  const vdot10kInRun = best10kSec != null ? cv(10000, best10kSec) : null;

  // ─── Signal 10: Critical Speed (CS) from 2-param hyperbolic fit ─────────
  // CS = asymptotic pace. Fit T = D/CS + AWC/CS where T,D are pairs of
  // (time, distance) from best efforts at different durations.
  // Use the best 1, 2, 5, 10 km efforts across all runs.
  const csPoints: Array<{ d: number; t: number }> = [];
  for (const n of [1, 2, 5, 10]) {
    let bestT: number | null = null;
    for (const r of runs) {
      if (!r.splits) continue;
      const t = bestNKmEffort(r.splits, n);
      if (t == null) continue;
      if (bestT == null || t < bestT) bestT = t;
    }
    if (bestT != null) csPoints.push({ d: n * 1000, t: bestT });
  }
  let vdotCS: number | null = null;
  let csDetail = 'insufficient efforts';
  if (csPoints.length >= 2) {
    // Linear regression of D on t: D = CS * t + AWC. Slope = CS (m/s).
    const n = csPoints.length;
    const sumT = csPoints.reduce((a, p) => a + p.t, 0);
    const sumD = csPoints.reduce((a, p) => a + p.d, 0);
    const sumTT = csPoints.reduce((a, p) => a + p.t * p.t, 0);
    const sumTD = csPoints.reduce((a, p) => a + p.t * p.d, 0);
    const denom = n * sumTT - sumT * sumT;
    if (denom > 0) {
      const cs = (n * sumTD - sumT * sumD) / denom; // m/s
      if (cs > 0) {
        const csSecPerKm = 1000 / cs;
        // CS ≈ LT2; back-derive VDOT through Daniels inverse.
        const vdotFromCS = deriveVdotFromLT(csSecPerKm);
        vdotCS = vdotFromCS;
        csDetail = `CS=${csSecPerKm.toFixed(0)}s/km from ${n} efforts`;
      }
    }
  }

  // ─── HRR coverage histogram (run-level) ─────────────────────────────────
  const buckets: Record<string, number> = {
    '<60%': 0, '60-70%': 0, '70-80%': 0, '80-90%': 0, '90-100%': 0,
  };
  for (const r of runs) {
    const f = r.hrrFraction;
    if (!isFinite(f)) continue;
    if (f < 0.60) buckets['<60%']++;
    else if (f < 0.70) buckets['60-70%']++;
    else if (f < 0.80) buckets['70-80%']++;
    else if (f < 0.90) buckets['80-90%']++;
    else buckets['90-100%']++;
  }
  const hrrHistogram = Object.entries(buckets).map(([bucket, n]) => ({ bucket, n }));

  // ─── HRR coverage histogram (lap-level) ─────────────────────────────────
  // Each qualifying lap (≥30s, valid HR) gets its own bucket entry, so a
  // negative-split long run contributes multiple high-HR points instead of
  // one averaged-out point. This is the within-run signal LT detection
  // already uses; we're surfacing it for VO2 estimation here.
  const lapBuckets: Record<string, number> = {
    '<60%': 0, '60-70%': 0, '70-80%': 0, '80-90%': 0, '90-100%': 0,
  };
  for (const lp of lapPoints) {
    const f = lp.hrrFraction;
    if (!isFinite(f)) continue;
    if (f < 0.60) lapBuckets['<60%']++;
    else if (f < 0.70) lapBuckets['60-70%']++;
    else if (f < 0.80) lapBuckets['70-80%']++;
    else if (f < 0.90) lapBuckets['80-90%']++;
    else lapBuckets['90-100%']++;
  }
  const hrrHistogramLap = Object.entries(lapBuckets).map(([bucket, n]) => ({ bucket, n }));

  // ─── Lap-level regression: pace-vs-HRR on within-run sub-segments ───────
  // Apply the same filter as the run-level regression (HRR 0.40–0.95) so the
  // result is directly comparable. Outlier removal is intentionally skipped
  // here — the goal is to see what the lap data says raw, before any cleanup.
  const lapPointsFiltered = lapPoints.filter(
    p => p.hrrFraction >= 0.40 && p.hrrFraction <= 0.95,
  );
  const lapFit = fitLapRegression(lapPointsFiltered);

  const signals: VDOTSignal[] = [
    { label: 'Race PBs (median)', vdot: vdotPB, detail: 'cv() across stored 5K/10K/HM/M PBs' },
    { label: 'LT pace → Daniels', vdot: vdotLT, detail: s.lt ? `LT=${Math.round(s.lt)}s/km, source=${s.ltSource ?? '?'}` : 'no LT' },
    { label: 'Watch (Firstbeat)', vdot: vdotWatch, detail: s.vo2 ? 'from device sync' : 'no device value' },
    { label: '↓ TRAINING-DERIVED ↓', vdot: null, detail: '' },
    { label: 'HR regression (current)', vdot: hrFit.vdot, detail: `${hrFit.confidence}, N=${hrFit.n}, R²=${hrFit.r2?.toFixed(2) ?? '—'}, paceAtVO2max=${hrFit.paceAtVO2max?.toFixed(0) ?? '—'}s/km` },
    { label: 'T-pace anchor (median)', vdot: vdotT, detail: tpaceVDOTs.length > 0 ? `${tpaceVDOTs.length} runs at 80–92% HRR` : 'no qualifying tempo runs' },
    { label: 'Billat 6-min vVO2max', vdot: vdotBillat, detail: bestBillatPace != null ? `best 6-min pace ${bestBillatPace.toFixed(0)}s/km` : 'no 6-min data' },
    { label: 'Cooper 12-min', vdot: vo2Cooper, detail: bestCooperDist != null ? `${Math.round(bestCooperDist)}m in 12 min` : 'no 12-min data' },
    { label: 'Best 5K-in-run', vdot: vdot5kInRun, detail: best5kSec != null ? `${Math.round(best5kSec)}s = ${Math.round(best5kSec/5)}s/km` : 'no run with ≥5km splits' },
    { label: 'Best 10K-in-run', vdot: vdot10kInRun, detail: best10kSec != null ? `${Math.round(best10kSec)}s = ${Math.round(best10kSec/10)}s/km` : 'no run with ≥10km splits' },
    { label: 'Critical Speed', vdot: vdotCS, detail: csDetail },
    {
      label: 'HR regression (LAP-LEVEL)',
      vdot: lapFit?.vdot ?? null,
      detail: lapFit
        ? `N=${lapPointsFiltered.length} laps, R²=${lapFit.r2.toFixed(2)}, paceAtVO2max=${lapFit.paceAtVO2max.toFixed(0)}s/km`
        : `${lapPointsFiltered.length} qualifying laps (need ≥3)`,
    },
  ];

  return {
    athlete: {
      restingHR: s.restingHR ?? null,
      maxHR: s.maxHR ?? null,
      bodyWeightKg: s.bodyWeightKg ?? null,
      deviceVO2: s.vo2 ?? null,
    },
    signals,
    hrrHistogram,
    hrrHistogramLap,
    qualifyingRuns: runs,
    hrRegressionDetail: {
      n: hrFit.n,
      r2: hrFit.r2,
      paceAtVO2max: hrFit.paceAtVO2max,
      alpha: hrFit.alpha,
      beta: hrFit.beta,
      points: hrFit.points ?? [],
    },
    lapRegressionDetail: {
      n: lapPointsFiltered.length,
      r2: lapFit?.r2 ?? null,
      paceAtVO2max: lapFit?.paceAtVO2max ?? null,
      alpha: lapFit?.alpha ?? null,
      beta: lapFit?.beta ?? null,
      vdot: lapFit?.vdot ?? null,
      points: lapPointsFiltered,
    },
    currentDisplay: {
      runningEstimate: s.vo2Estimates?.running.value ?? null,
      runningSource: s.vo2Estimates?.running.source ?? null,
      runningConfidence: s.vo2Estimates?.running.confidence ?? null,
    },
  };
}

/** Pretty-print to console as a table-friendly markdown report. */
export function printVO2Diagnostic(d: VO2Diagnostic = runVO2Diagnostic()): void {
  /* eslint-disable no-console */
  console.group('%cVO2max diagnostic', 'font-weight:bold;font-size:14px;color:#D97757');

  console.log('Athlete:', d.athlete);
  console.log('Currently displayed running estimate:', d.currentDisplay);

  console.group('Per-signal VDOT estimates');
  console.table(d.signals.map(s => ({
    Signal: s.label,
    VDOT: s.vdot != null ? Math.round(s.vdot * 10) / 10 : '—',
    Detail: s.detail,
  })));
  console.groupEnd();

  console.group('HRR distribution — RUN-LEVEL (current method)');
  console.table(d.hrrHistogram);
  console.groupEnd();

  console.group('HRR distribution — LAP-LEVEL (within-run signal)');
  console.table(d.hrrHistogramLap);
  console.groupEnd();

  console.group('Lap-level regression (proposed method)');
  if (d.lapRegressionDetail.r2 != null) {
    console.log('N qualifying laps:', d.lapRegressionDetail.n);
    console.log('R²:', d.lapRegressionDetail.r2.toFixed(2));
    console.log('α (intercept):', d.lapRegressionDetail.alpha?.toFixed(1), 's/km');
    console.log('β (slope):', d.lapRegressionDetail.beta?.toFixed(1), 's/km per unit HRR');
    console.log('paceAtVO2max:', d.lapRegressionDetail.paceAtVO2max?.toFixed(0), 's/km');
    console.log('VDOT:', d.lapRegressionDetail.vdot?.toFixed(1));
    console.table(d.lapRegressionDetail.points.map(p => ({
      Run: p.runStartTime.slice(5, 10),
      Lap: p.lapIndex,
      Km: p.distKm.toFixed(2),
      DurSec: Math.round(p.durSec),
      Pace: `${Math.floor(p.paceSecKm/60)}:${String(Math.round(p.paceSecKm%60)).padStart(2,'0')}`,
      AvgHR: p.avgHR,
      'HRR%': (p.hrrFraction * 100).toFixed(0),
    })));
  } else {
    console.log(`Insufficient lap data: ${d.lapRegressionDetail.n} qualifying laps (need ≥3).`);
  }
  console.groupEnd();

  console.group('HR-regression internals (RUN-LEVEL, current method)');
  console.log('N points used:', d.hrRegressionDetail.n);
  console.log('R²:', d.hrRegressionDetail.r2);
  console.log('α (intercept):', d.hrRegressionDetail.alpha?.toFixed(1), 's/km');
  console.log('β (slope):', d.hrRegressionDetail.beta?.toFixed(1), 's/km per unit HRR');
  console.log('paceAtVO2max (extrapolated to 100% HRR):', d.hrRegressionDetail.paceAtVO2max?.toFixed(0), 's/km');
  if (d.hrRegressionDetail.points.length > 0) {
    console.table(d.hrRegressionDetail.points.map(p => ({
      'HRR%': (p.vo2r * 100).toFixed(0),
      'Pace s/km': p.paceSecKm.toFixed(0),
      'Pace': `${Math.floor(p.paceSecKm/60)}:${String(Math.round(p.paceSecKm%60)).padStart(2,'0')}`,
      'Duration min': Math.round(p.durationSec / 60),
    })));
  }
  console.groupEnd();

  console.group('All qualifying runs (last 8 weeks)');
  console.table(d.qualifyingRuns.map(r => ({
    Date: r.startTime.slice(0, 10),
    AgeDays: r.ageDays,
    DistKm: r.distKm.toFixed(1),
    DurMin: Math.round(r.durSec / 60),
    AvgPace: `${Math.floor(r.avgPace/60)}:${String(Math.round(r.avgPace%60)).padStart(2,'0')}`,
    AvgHR: r.avgHR,
    MaxHR: r.maxHR,
    Drift: r.hrDrift?.toFixed(1) ?? '—',
    'HRR%': isFinite(r.hrrFraction) ? (r.hrrFraction * 100).toFixed(0) : '—',
    Laps: r.lapCount,
    LapsHR: r.lapsWithHR,
    FastestKm: r.fastestKmPace ? `${Math.floor(r.fastestKmPace/60)}:${String(Math.round(r.fastestKmPace%60)).padStart(2,'0')}` : '—',
  })));
  console.groupEnd();

  console.groupEnd();
  /* eslint-enable no-console */
}
