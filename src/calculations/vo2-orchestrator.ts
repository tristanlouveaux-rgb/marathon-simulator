/**
 * Cross-Modal VO2max Orchestrator
 *
 * Computes per-modality VO2max estimates and a single headline figure.
 *
 * Design decision (2026-05-02): no cardiac-ceiling lift. Earlier versions of
 * this module added `lifted = max(direct, cardiac × peripheral_transfer)` for
 * each modality, intending to let cross-training cardiac fitness raise the
 * displayed running/cycling number. That was a double-count: the running
 * VDOT regression already captures cardiac contribution implicitly because a
 * heart trained by padel still pumps at the lower HR-for-pace observed during
 * runs. The lift was layering cardiac-via-HR on top of cardiac-already-
 * inside-pace-vs-HR, inflating numbers in a way users couldn't reconcile
 * with their watch. See SCIENCE_LOG.md → "Cross-Modal VO2max — lift removed
 * 2026-05-02" for the full rejection rationale.
 *
 * What remains:
 *   - running:  Daniels VDOT regressed from pace + HR (effort-calibrated)
 *               with `getPhysiologicalVdot()` fallback (LT-back-derived,
 *               PB-median, Tanda) when HR data is sparse
 *   - cycling:  ACSM `10.8 × W/kg + 7` from FTP and body weight

 *   - cardiac:  Uth-Sørensen `15.3 × HRmax/HRrest` — aerobic upper bound,
 *               not a measure of current fitness. Surfaced as a ceiling so
 *               users can see the headroom above their measured numbers.
 *               Never blended into modality values.
 *
 * Headline fallback chain (anti-decay across cross-training switches):
 *   1. max(running-direct, cycling-direct)  — measured peripheral fitness
 *   2. cardiac ceiling                       — when no per-modality signal
 *   3. `getPhysiologicalVdot()` chain        — final floor (LT/PB/Tanda)
 *
 * Cross-training credit flows through the existing Signal A iTRIMP discount
 * model (rs-discounted load), which is the right place for "padel contributes
 * to your run-equivalent CTL". VO2max display has no special cross-training
 * mechanism — and doesn't need one.
 *
 * Pure — no state mutation, fully testable.
 */

import type { SimulatorState, VO2Estimate, VO2Confidence } from '@/types';
import { computeHRCalibratedVdot } from './effort-calibrated-vdot';
import { computeCardiacCeiling, type ActivityHRSample } from './cardiac-ceiling';
import { computeCrossTrainingVO2, type CrossTrainingActivitySample } from './cross-training-vo2';
import { computeCyclingVO2 } from './cycling-vo2';
import { getPhysiologicalVdot } from './physiological-vdot';
import { normalizeSport } from '@/cross-training/activities';

export interface VO2OrchestratorResult {
  running: VO2Estimate;
  cycling: VO2Estimate;
  cardiac: VO2Estimate;
  crossTraining: VO2Estimate;
  headline: { value: number | null; confidence: VO2Confidence; sport: 'running' | 'cycling' | 'cardiac' | null };
  computedAt: string;
}

/** Convert VDOT (Daniels) to VO2max (ml/kg/min). VDOT is a Daniels-pace
 *  proxy for VO2max already calibrated in the same units, so this is identity
 *  for our purposes. */
function vdotToVO2(vdot: number | null): number | null {
  return vdot;
}

/** Minimal activity shape the orchestrator needs. Subset of GarminActual that
 *  also matches the rows returned by `loadActivitiesFromDB` in tri mode. */
export interface OrchestratorActivity {
  startTime?: string | null;
  durationSec: number;
  distanceKm?: number;
  avgHR?: number | null;
  maxHR?: number | null;
  hrDrift?: number | null;
  activityType?: string | null;
  manualSport?: string | null;
}

/** Build per-modality activity samples — flatten weeks' garminActuals
 *  (Strava-suppressed, source-of-truth) plus any extra activity rows passed
 *  in. The `extra` channel exists for tri mode, where canonical activity
 *  history lives in the DB and not in `s.wks[].garminActuals` — the LT/FTP
 *  deriver sees it via `loadActivitiesFromDB` and we want the orchestrator
 *  to see the same set so HR regression has enough points to fire.
 *
 *  De-duplication: when the same activity appears in both wks and extra, the
 *  wks copy wins (it carries `hrDrift` and `manualSport` overrides). Match by
 *  startTime to the second.
 */
function collectActivitySamples(
  s: SimulatorState,
  extra: OrchestratorActivity[] = [],
): {
  runs: Parameters<typeof computeHRCalibratedVdot>[0];
  hrSamples: ActivityHRSample[];
  crossTraining: CrossTrainingActivitySample[];
} {
  const runs: Parameters<typeof computeHRCalibratedVdot>[0] = [];
  const hrSamples: ActivityHRSample[] = [];
  const crossTraining: CrossTrainingActivitySample[] = [];
  const seenStartTimes = new Set<string>();

  const ingest = (a: OrchestratorActivity) => {
    if (!a.startTime || !a.durationSec) return;
    // Normalise to minute precision so timezone suffix variants ("Z" vs "+00:00")
    // and millisecond noise don't defeat the dedup check.
    const startKey = a.startTime.slice(0, 16);
    if (seenStartTimes.has(startKey)) return;
    seenStartTimes.add(startKey);

    const rawSport = a.manualSport
      ?? (a.activityType ? normalizeSport(a.activityType) : null);
    const sport = rawSport ?? null;

    const isRun = sport === 'running' || sport === 'extra_run'
      || (a.activityType ?? '').toUpperCase().includes('RUNNING');

    if (isRun && (a.distanceKm ?? 0) > 0 && a.avgHR != null && a.avgHR > 0) {
      runs.push({
        startTime: a.startTime,
        distKm: a.distanceKm as number,
        durSec: a.durationSec,
        avgHR: a.avgHR,
        hrDrift: a.hrDrift ?? null,
      });
    }

    if (a.maxHR != null && a.maxHR > 0) {
      hrSamples.push({
        startTime: a.startTime,
        durationSec: a.durationSec,
        maxHR: a.maxHR,
        sport,
      });
    }

    // Cross-training feeder — needs avgHR and a sport label, and the
    // estimator itself filters out run/bike. Pass everything qualifying;
    // the calculation module handles run/bike exclusion and aerobic gate.
    if (a.avgHR != null && a.avgHR > 0) {
      crossTraining.push({
        startTime: a.startTime,
        durationSec: a.durationSec,
        avgHR: a.avgHR,
        sport,
      });
    }
  };

  for (const wk of s.wks ?? []) {
    if (!wk.garminActuals) continue;
    for (const id in wk.garminActuals) {
      ingest(wk.garminActuals[id] as OrchestratorActivity);
    }
  }
  for (const a of extra) ingest(a);

  return { runs, hrSamples, crossTraining };
}

/**
 * Compute the full cross-modal VO2max picture from state.
 *
 * @param s      SimulatorState (read-only).
 * @param now    Anchor time for the 8-week window.
 * @param extra  Additional activities (e.g. tri-mode `loadActivitiesFromDB`
 *               results) to merge into the orchestrator's view. Necessary in
 *               tri mode because the canonical activity log lives in the DB,
 *               not in `s.wks[].garminActuals`.
 */
export function computeVO2Estimates(
  s: SimulatorState,
  now: Date = new Date(),
  extra: OrchestratorActivity[] = [],
): VO2OrchestratorResult {
  const { runs, hrSamples, crossTraining: ctSamples } = collectActivitySamples(s, extra);

  // ─── Direct per-modality estimates ───────────────────────────────────────

  // Running — effort-calibrated VDOT (Daniels' VO2max-units output) is the
  // primary path. When it can't fire (sparse HR data, missing RHR/maxHR),
  // back-fall to `getPhysiologicalVdot()` which already picks the best of
  // device VO2 / HR-calibrated / LT-back-derived / PB-median / Tanda. This
  // matters because the LT pipeline produces a confident VDOT for users with
  // established threshold/PB data even when our HR regression hasn't
  // accumulated enough qualifying runs yet.
  const hrRun = computeHRCalibratedVdot(runs, s.restingHR, s.maxHR, now);
  let running: VO2Estimate;
  if (hrRun.vdot != null) {
    running = {
      value: vdotToVO2(hrRun.vdot),
      confidence: hrRun.confidence,
      source: 'effort-calibrated',
      n: hrRun.n,
      detail: `Calibrated from ${hrRun.n} steady run${hrRun.n === 1 ? '' : 's'}`,
    };
  } else {
    // Skip BOTH mosaic-running (would loop on stored prior result) and device
    // (s.vo2 is the watch reading the toggle picks between, not part of our
    // own estimate). Result: this is genuinely a Mosaic-derived value the
    // user can compare against their watch.
    const physio = getPhysiologicalVdot(s, { now, skipMosaic: true, skipDevice: true });
    if (physio.vdot != null && physio.source !== 'none') {
      running = {
        value: physio.vdot,
        confidence: physio.confidence,
        source: 'effort-calibrated',
        n: 0,
        detail: physio.detail,
      };
    } else {
      running = { value: null, confidence: 'none', source: 'none', n: 0 };
    }
  }

  // Cycling — ACSM W/kg formula. FTP comes from triConfig.bike (tri mode)
  // or unset (running-only mode → no cycling estimate). Falls through cleanly.
  const ftpW = s.triConfig?.bike?.ftp ?? null;
  const ftpConfidence = s.triConfig?.bike?.ftpConfidence ?? null;
  const cyc = computeCyclingVO2({
    ftpW,
    bodyWeightKg: s.bodyWeightKg ?? null,
    biologicalSex: s.biologicalSex ?? null,
    ftpConfidence,
  });
  const cycling: VO2Estimate = {
    value: cyc.vo2,
    confidence: cyc.confidence,
    source: cyc.vo2 != null ? 'acsm-ftp' : 'none',
    n: ftpW ? 1 : 0,
    detail: cyc.vo2 != null
      ? (cyc.usedDefaultWeight
          ? `From your FTP (using default body weight — set yours in account for accuracy)`
          : `From your FTP (${Math.round(ftpW!)} W ÷ ${cyc.weightKgUsed} kg)`)
      : undefined,
  };

  // Cardiac ceiling — Uth-Sørensen across all aerobic activity. Informational
  // only: surfaced as cardiovascular potential, never blended into running or
  // cycling, claims the headline only when neither direct estimate has signal.
  // Pass athlete's stored maxHR so sensor-spike readings (e.g., a 216 bpm
  // reading from a user whose true max is 193) don't inflate the ceiling.
  const cc = computeCardiacCeiling(hrSamples, s.restingHR, now, s.maxHR);
  const cardiac: VO2Estimate = {
    value: cc.vo2,
    confidence: cc.confidence,
    source: cc.vo2 != null ? 'uth-sorensen' : 'none',
    n: cc.n,
    detail: cc.vo2 != null
      ? `Peak HR ${cc.hrMaxObserved} ÷ resting HR ${cc.restingHR}, across ${cc.n} sessions${cc.distinctSports >= 2 ? ` and ${cc.distinctSports} sports` : ''}`
      : undefined,
  };

  // Cross-training VO2max — sustained-HR aerobic capacity from non-run, non-bike
  // sport. Anchored to cardiac ceiling: the athlete's modality-agnostic VO2max
  // upper bound, scaled by the demonstrated %HRR fraction and duration sustained.
  // Hidden (value=null) when fewer than 3 qualifying sessions in the 8-week
  // window — see SCIENCE_LOG → "Cross-Training VO2max" for rationale.
  // Does NOT lift running or cycling (additive, not blended) and never claims
  // headline; the running VDOT regression already credits cardiac contribution.
  const ct = computeCrossTrainingVO2(ctSamples, s.restingHR, s.maxHR, cc.vo2, now);
  const crossTraining: VO2Estimate = {
    value: ct.vo2,
    confidence: ct.confidence,
    source: ct.vo2 != null ? 'sustained-hr-cross-training' : 'none',
    n: ct.n,
    detail: ct.vo2 != null
      ? `Sustained-HR estimate from ${ct.n} non-run/non-bike session${ct.n === 1 ? '' : 's'}${ct.distinctSports >= 2 ? ` across ${ct.distinctSports} sports` : ''}`
      : undefined,
  };

  // ─── Headline fallback chain ──────────────────────────────────────────────
  //
  // Tier 1: max(running, cycling) — directly measured per-modality fitness.
  //         Anti-decay because cycling carries when running drops and vice versa.
  // Tier 2: cardiac ceiling — when neither direct estimate has signal. HR
  //         ratios are stable physiological markers, so this doesn't decay
  //         fast even if all activity stops for weeks.
  // Tier 3: getPhysiologicalVdot() final floor — LT-back-derived → PB-median
  //         → Tanda. Catches users with PBs/LT on file but no recent activity.

  const measuredCandidates: Array<{ key: 'running' | 'cycling'; est: VO2Estimate }> = [
    { key: 'running', est: running },
    { key: 'cycling', est: cycling },
  ].filter(c => c.est.value != null) as Array<{ key: 'running' | 'cycling'; est: VO2Estimate }>;

  let headline: VO2OrchestratorResult['headline'];
  if (measuredCandidates.length > 0) {
    measuredCandidates.sort((a, b) => (b.est.value ?? 0) - (a.est.value ?? 0));
    const top = measuredCandidates[0];
    headline = { value: top.est.value, confidence: top.est.confidence, sport: top.key };
  } else if (cardiac.value != null) {
    // Cardiac claims headline only when nothing else can. Honest fallback
    // for HR-only-sport athletes (padel, tennis, football) and for users
    // whose direct-modality data has aged out.
    headline = { value: cardiac.value, confidence: cardiac.confidence, sport: 'cardiac' };
  } else {
    const physio = getPhysiologicalVdot(s, { now, skipMosaic: true });
    if (physio.vdot != null && physio.source !== 'none') {
      headline = { value: physio.vdot, confidence: physio.confidence, sport: 'running' };
    } else {
      headline = { value: null, confidence: 'none', sport: null };
    }
  }

  return {
    running,
    cycling,
    cardiac,
    crossTraining,
    headline,
    computedAt: now.toISOString(),
  };
}
