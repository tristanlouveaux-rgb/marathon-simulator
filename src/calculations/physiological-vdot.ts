/**
 * Physiological VDOT Resolution. Single source of truth for "what's this
 * athlete's best available estimate of aerobic capacity right now?"
 *
 * Anchors the Daniels T-pace formula (LT engine), the VO2 stats card, and the
 * onboarding fitness row. Before this lived as a single function, three
 * surfaces independently picked from `s.vo2`, `s.hrCalibratedVdot`,
 * `deriveVdotFromLT(s.lt)`, PB-derived VDOT and `s.v` with subtly different
 * priorities and confidence semantics. The same athlete saw different VDOTs
 * across Stats / LT detail / onboarding by several points.
 *
 * This module returns one number, plus the source it came from and a short
 * caption, so every surface displays the same value with the same provenance.
 *
 * Distinct from `getEffectiveVdot(s)` in `effective-vdot.ts`, which adds
 * `rpeAdj + physioAdj` for race-time prediction and pace-zone prescription.
 * Those adjustments answer "what could you race today". They don't belong
 * on a physiology number that should answer "what's your aerobic capacity"
 * (capacity doesn't shift when the user clicks an RPE dial).
 *
 * Pure. No state mutation, no I/O.
 */

import type { SimulatorState } from '@/types';
import { cv } from './vdot';
import { deriveVdotFromLT } from './lt-derivation';
import { getEffectiveVdot } from './effective-vdot';

// ─── Types ────────────────────────────────────────────────────────────────

export type PhysiologicalVdotSource =
  | 'override'        // s.vo2Override, user-set lab/test value. Top priority
  | 'race-validated'  // s.raceRunVdot, recent real race run leg (above device)
  | 'device'          // s.vo2, fresh
  | 'mosaic-running'  // s.vo2Estimates.running (cross-modal lift), medium+ confidence
  | 'hr-calibrated'   // s.hrCalibratedVdot, medium+ confidence
  | 'lt-derived'      // deriveVdotFromLT(s.lt). Only when LT was observation-based
  | 'pb-median'       // median of cv() across race-distance PBs
  | 'tanda-fallback'  // s.v, last resort
  | 'none';           // nothing usable

export type PhysiologicalVdotConfidence = 'high' | 'medium' | 'low' | 'none';

export interface PhysiologicalVdotResult {
  /** Resolved VDOT, or null when no source provided a usable value. */
  vdot: number | null;
  /** Which tier of the priority chain produced the value. */
  source: PhysiologicalVdotSource;
  /** Confidence in the value. Inherited from the source where applicable. */
  confidence: PhysiologicalVdotConfidence;
  /** Short human caption for UI. e.g. "From your watch", "Calibrated from 6 steady runs". */
  detail: string;
  /** True when we used `s.vo2` and it was within the freshness window. */
  isDeviceFresh: boolean;
  /** Days since the most recent device VO2 reading, when known. Null when no
   *  history is available (legacy state) or when no device value exists. */
  deviceAgeDays: number | null;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Freshness window for `s.vo2`. Matches the existing 60-day Garmin-LT window's
 *  intent (use device readings while they reflect current physiology). 90 days
 *  is the user-chosen default for VO2; longer than LT because VO2max drifts
 *  more slowly than LT pace. Beyond this window, fall through to derived
 *  sources rather than pin a stale device value. */
const DEVICE_FRESHNESS_DAYS = 90;

/** Recency window for the race-validated run-VDOT anchor. A real race run leg
 *  demonstrates running capability directly, so it outranks the watch VO2max
 *  while recent. We reuse the "strong" PB-recency band (365 days) already used
 *  by the marathon-specificity penalty to credit recent full-distance capability
 *  (see RUN_PB_RECENCY_BANDS / SCIENCE_LOG "PB-recency scaling"). Beyond a year,
 *  the race is no longer fresher evidence than a current watch reading, so the
 *  anchor stands down and the normal chain (device → derived) resumes. */
const RACE_VDOT_ANCHOR_MAX_AGE_DAYS = 365;

/** LT-derived VDOT only fires when LT itself came from observation, not from
 *  Daniels. Otherwise we'd back-derive a number we just forward-derived
 *  (perfectly circular) or partially circular (the `'blended'` case includes
 *  Daniels at 0.35 weight). Trusted sources: empirical (steady runs),
 *  critical-speed (PBs), garmin (watch), override (user-entered). */
const TRUSTED_LT_SOURCES = new Set(['empirical', 'critical-speed', 'garmin', 'override']);

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── PB-derived VDOT (relocated from ltSync.ts so VDOT-source logic lives in one file) ───

/**
 * PBs as the physiology chain should see them: per-key fastest of the
 * committed plan PBs (`s.pbs`) and the in-progress wizard PBs
 * (`s.onboarding.pbs`).
 *
 * Why: `s.pbs` is only written at onboarding FINALIZE, so every mid-wizard
 * physiology consumer (LT derivation, PB-median VDOT → Daniels T-pace, the
 * review screen's LT row) previously read the PREVIOUS plan's PBs and
 * ignored what the user just typed. Real case, 2026-06-04: a runner with
 * freshly-typed 17:38/39:20/1:31:30/3:09 PBs was shown LT 4:56/km
 * "blended from your PBs, high confidence" because the derivation saw a
 * stale single-PB state and a degraded VDOT from a prior broken pass.
 *
 * Fastest-wins per key (lower seconds = better) so a stale wizard snapshot
 * can never regress a fresher post-plan PB (post-finalize, `s.onboarding`
 * is the stored reference and Strava auto-PB refreshes write to `s.pbs`).
 */
/**
 * Is a candidate PB time suppressed by a user deletion tombstone? (ISSUE-297 RC3)
 *
 * A tombstone records the time the user explicitly deleted for a distance. The
 * candidate is suppressed unless it is genuinely FASTER than the deleted time
 * (a real improvement), so a deleted PB cannot passively resurrect — neither
 * from the other store via `effectivePhysiologyPbs`'s fastest-wins merge, nor
 * from a Strava/Apple auto-fill re-detecting the same effort. An explicit user
 * re-entry clears the tombstone (see `clearPbTombstone`), so re-adding a PB
 * after deleting it always works.
 */
export function isPbTombstoned(
  deletedPbs: Partial<Record<keyof NonNullable<SimulatorState['pbs']>, number>> | undefined,
  key: keyof NonNullable<SimulatorState['pbs']>,
  candidateSec: number,
): boolean {
  const t = deletedPbs?.[key];
  return t != null && candidateSec >= t;
}

export function effectivePhysiologyPbs(s: SimulatorState): NonNullable<SimulatorState['pbs']> {
  const base = s.pbs ?? {};
  const wizard = s.onboarding?.pbs ?? {};
  const keys = ['k5', 'k10', 'h', 'm'] as const;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const a = (base as Record<string, number | undefined>)[k];
    const b = (wizard as Record<string, number | undefined>)[k];
    const best = a != null && a > 0
      ? (b != null && b > 0 ? Math.min(a, b) : a)
      : (b != null && b > 0 ? b : undefined);
    // Honour a deletion tombstone: a value that is not a genuine improvement
    // over the deleted time is a resurrection from the surviving store — drop it.
    if (best != null && !isPbTombstoned(s.deletedPbs, k, best)) out[k] = best;
  }
  return out;
}

/**
 * Record an explicit user deletion of a PB (ISSUE-297 RC3). Sets the tombstone
 * to the deleted time, then clears the key from BOTH stores (`s.pbs` and
 * `s.onboarding.pbs`) plus their PB dates, so nothing survives to resurrect via
 * fastest-wins. Callers must trigger `refreshBlendedFitness` afterwards so the
 * engine/prediction recompute without the deleted time.
 */
export function recordPbDeletion(s: SimulatorState, key: keyof NonNullable<SimulatorState['pbs']>): void {
  const prev = (s.pbs as Record<string, number | undefined> | undefined)?.[key]
    ?? (s.onboarding?.pbs as Record<string, number | undefined> | undefined)?.[key];
  if (prev != null && prev > 0) {
    s.deletedPbs = { ...(s.deletedPbs ?? {}), [key]: prev };
  }
  if (s.pbs) delete (s.pbs as Record<string, number | undefined>)[key];
  if (s.onboarding?.pbs) delete (s.onboarding.pbs as Record<string, number | undefined>)[key];
  if (s.onboarding?.pbDates) delete (s.onboarding.pbDates as Record<string, unknown>)[key];
}

/**
 * Clear a PB tombstone (ISSUE-297 RC3). Called when the user explicitly enters
 * a PB for a distance, so an intentional re-entry of a previously-deleted time
 * is honoured rather than suppressed.
 */
export function clearPbTombstone(s: SimulatorState, key: keyof NonNullable<SimulatorState['pbs']>): void {
  if (s.deletedPbs && s.deletedPbs[key] != null) {
    const next = { ...s.deletedPbs };
    delete next[key];
    s.deletedPbs = next;
  }
}

/**
 * Median VDOT across the user's race-distance PBs (5K / 10K / HM / marathon).
 *
 * Median (not max) because PB profiles are often imbalanced. A fast 5K
 * specialist with weak endurance shouldn't have their 5K alone drive the
 * estimate, and a marathoner with a slow 5K shouldn't lose theirs to it.
 * The median collapses both biases.
 */
export function pbDerivedVdot(s: SimulatorState): number | null {
  return pbMedianVdot(effectivePhysiologyPbs(s));
}

/**
 * Median VDOT from a raw PBs object. Split out from `pbDerivedVdot` so callers
 * that hold a PBs object directly — e.g. `initializeSimulator`, where `s.pbs`
 * is not committed to state yet — can compute the same demonstrated-capacity
 * number without going through `SimulatorState`. Single source for the median.
 */
export function pbMedianVdot(
  pbs: { k5?: number; k10?: number; h?: number; m?: number } | null | undefined,
): number | null {
  if (!pbs) return null;
  const candidates: number[] = [];
  if (pbs.k5 && pbs.k5 > 0) candidates.push(cv(5000, pbs.k5));
  if (pbs.k10 && pbs.k10 > 0) candidates.push(cv(10000, pbs.k10));
  if (pbs.h && pbs.h > 0) candidates.push(cv(21097.5, pbs.h));
  if (pbs.m && pbs.m > 0) candidates.push(cv(42195, pbs.m));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a - b);
  const mid = Math.floor(candidates.length / 2);
  return candidates.length % 2 === 0
    ? (candidates[mid - 1] + candidates[mid]) / 2
    : candidates[mid];
}

/**
 * Convert a real race run-leg time into a "fresh-run-equivalent" VDOT.
 *
 * Race run legs are run on fatigued legs (after the swim + bike), so the raw
 * split understates fresh running capability. We remove the population-average
 * bike-to-run fatigue penalty (the same discount used in tri race-time
 * prediction: 5% for 70.3, 11% for IM) to recover the fresh equivalent, then
 * back-derive VDOT via `cv()`. Pure: callers pass the run-leg distance and the
 * discount for their event, keeping this free of any distance-enum coupling.
 *
 * Single source for "race run leg → run VDOT" — both the onboarding past-race
 * seed (`derivePastRaceBenchmarks`) and the post-race outcome logger
 * (`detectAndLogRaceOutcome`) call this so the two never diverge.
 */
export function raceRunLegToVdot(
  runSec: number,
  runDistM: number,
  fatigueDiscount: number,
): number | null {
  if (!(runSec > 0) || !(runDistM > 0)) return null;
  const freshRunSec = runSec * (1 - fatigueDiscount);  // fewer seconds = faster
  const vdot = cv(runDistM, freshRunSec);
  return vdot > 20 && vdot < 90 ? vdot : null;  // sanity guard, mirrors derivePastRaceBenchmarks
}

/**
 * The recency-gated race-validated run VDOT anchor, or null when none is usable.
 *
 * Reads the persisted `s.raceRunVdot` (seeded from a real race run leg, already
 * fatigue-discounted by `raceRunLegToVdot`). Returns the value only while the
 * race is within `RACE_VDOT_ANCHOR_MAX_AGE_DAYS`; beyond that, fitness drift
 * means the race is no longer fresher evidence than a current watch reading and
 * the anchor stands down. `dateISO` may be `YYYY-MM` (onboarding month) or a
 * full `YYYY-MM-DD`.
 */
export function raceAnchorVdot(
  s: SimulatorState,
  now: Date = new Date(),
): { vdot: number; ageDays: number } | null {
  const anchor = s.raceRunVdot;
  if (!anchor || !(anchor.vdot > 0) || !anchor.dateISO) return null;
  const ts = Date.parse(anchor.dateISO.length === 7 ? anchor.dateISO + '-01' : anchor.dateISO);
  if (!Number.isFinite(ts)) return null;
  const ageDays = (now.getTime() - ts) / DAY_MS;
  if (ageDays < 0 || ageDays > RACE_VDOT_ANCHOR_MAX_AGE_DAYS) return null;
  return { vdot: anchor.vdot, ageDays };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Days since `s.vo2` was last written by a sync path.
 *
 * Prefers `s.vo2UpdatedAt` (stamped by both Garmin + Apple sync since
 * 2026-05-07) because `physiologyHistory[].vo2max` comes from
 * `daily_metrics.vo2max`. A generic Garmin cardio estimate that updates
 * from cycling. A triathlete who stops running but keeps cycling would
 * have a recent `physiologyHistory` vo2max entry from cycling while
 * `s.vo2` (from `physiology_snapshots.vo2_max_running`) could be months
 * stale. The `vo2UpdatedAt` field tracks the actual `s.vo2` write time.
 *
 * Falls back to `physiologyHistory` scan when `vo2UpdatedAt` is absent
 * (legacy state). Same "treat missing timestamp as fresh" policy as before
 * to avoid dropping a valid value on a missing-timestamp technicality.
 */
function deviceVo2AgeDays(s: SimulatorState, now: Date): number | null {
  if (s.vo2UpdatedAt) {
    const ageMs = now.getTime() - new Date(s.vo2UpdatedAt).getTime();
    return isFinite(ageMs) ? ageMs / DAY_MS : null;
  }
  // Legacy fallback: scan physiologyHistory for most recent vo2max entry.
  const hist = s.physiologyHistory;
  if (!hist || hist.length === 0) return null;
  let mostRecent: string | null = null;
  for (const entry of hist) {
    if (entry.vo2max == null) continue;
    if (mostRecent == null || entry.date > mostRecent) mostRecent = entry.date;
  }
  if (mostRecent == null) return null;
  const ageMs = now.getTime() - new Date(mostRecent).getTime();
  return ageMs / DAY_MS;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

/**
 * Resolve the best available physiological VDOT for `s`. Walks a fixed
 * priority chain and returns the first source that yields a usable value.
 *
 * Priority:
 *   0. `s.vo2Override`. Manual user override. Top priority. Mirrors the LT
 *      override pattern. The launch-time refresh in main.ts auto-clears the
 *      override when a derived estimate clearly beats it (≥ 3 ml/kg/min,
 *      medium+ confidence) per the "Manually-set Benchmarks Yield to
 *      Improvements" rule in CLAUDE.md.
 *   0b. Mosaic-running estimate (`s.vo2Estimates.running`) at medium+ confidence,
 *      when the source toggle is 'mosaic'. Derived from actual standalone runs,
 *      so it supersedes both the race anchor and the watch.
 *   0c. Race-validated run VDOT (`s.raceRunVdot`), when within
 *      {RACE_VDOT_ANCHOR_MAX_AGE_DAYS}. A real race run leg outranks the watch
 *      VO2max, which is inflated for triathletes by cycling/swimming.
 *   1. `s.vo2` (device-direct), when within {DEVICE_FRESHNESS_DAYS} of the
 *      most recent `physiologyHistory` reading. Watch is a strong estimate, but
 *      it yields to a recent race or a standalone-run-derived estimate above.
 *   2. `s.hrCalibratedVdot.vdot`, when confidence is 'high' or 'medium'.
 *      Pace-vs-%HRR regression of recent qualifying runs.
 *   3. `deriveVdotFromLT(s.lt)`, when `s.ltSource` is one of the trusted
 *      observation-based sources (empirical / critical-speed / garmin /
 *      override). Skipped for daniels/blended to avoid circularity.
 *   4. PB-median VDOT. Median of `cv()` across the user's race PBs.
 *   5. `s.v` (Tanda-blended), as a last resort. This number is volume-
 *      discounted and under-states aerobic capacity for triathletes who cut
 *      back on running; we use it only when none of the more-direct sources
 *      are available.
 *
 * Returns `{ vdot: null, source: 'none' }` when nothing is usable.
 */
/**
 * The VO2max value to feed the prediction blend's VO2 predictor, honouring the
 * manual override. Returns the override if set, else the device VO2max, else
 * null.
 *
 * This exists because every `blendPredictions` call historically read `s.vo2`
 * directly — which holds only the device value and silently misses
 * `s.vo2Override`. As a result a manual VO2max change on the stats view never
 * reached race predictions. Call sites must read THIS instead of `s.vo2`.
 *
 * Deliberately does NOT fall through to HR-calibrated or mosaic estimates:
 * those are separate signals in the blend (the HR slot, and the overall VDOT),
 * so feeding them into the VO2 slot would double-count. Freshness is not gated
 * here either, to preserve the prior `s.vo2`-direct behaviour for device values.
 *
 * Race-validated cap: the watch VO2max overstates RUNNING fitness for triathletes
 * (cycling and swimming build it too). When a recent race run leg demonstrates a
 * lower run VDOT, the blend's VO2 predictor is capped to it — UNLESS the athlete's
 * standalone running PBs corroborate the higher watch value. Because every blend
 * call path reads this helper (training-pace refresh, the tri run-leg race time in
 * `blendOpenRunRaceTime`, the standard-distance forecast, session generation), the
 * cap can't be bypassed by a surface that recomputes the blend off `s.vo2` directly.
 * This is the predictor-input twin of the `race-validated` tier in
 * `getPhysiologicalVdot` (which governs the resolved/display VDOT). The VO2max
 * stats card still shows the true device number — only the run PREDICTIONS yield.
 */
export function effectiveVo2max(s: SimulatorState, now: Date = new Date()): number | null {
  if (s.vo2Override && s.vo2Override.value > 0) return s.vo2Override.value;
  const device = s.vo2 != null && s.vo2 > 0 ? s.vo2 : null;
  if (device == null) return null;
  const race = raceAnchorVdot(s, now);
  if (race != null && device > race.vdot) {
    const pbCapacity = pbDerivedVdot(s);
    if (pbCapacity == null || pbCapacity < race.vdot) {
      return race.vdot;  // un-corroborated watch lift → cap to race-validated VDOT
    }
  }
  return device;
}

export function getPhysiologicalVdot(
  s: SimulatorState,
  opts: { now?: string | Date; skipMosaic?: boolean; skipDevice?: boolean } = {},
): PhysiologicalVdotResult {
  const now = opts.now
    ? (opts.now instanceof Date ? opts.now : new Date(opts.now))
    : new Date();

  const deviceAgeDays = deviceVo2AgeDays(s, now);
  const isDeviceFresh = s.vo2 != null && s.vo2 > 0
    && (deviceAgeDays == null || deviceAgeDays <= DEVICE_FRESHNESS_DAYS);

  // 0. Manual override. Top priority. Mirrors `s.ltOverride` semantics: the
  // launch-time refresh auto-clears it when a derived estimate clearly
  // improves on it. Until then, this value pins the resolved VDOT and flows
  // to all consumers. Race predictions, training paces, blended fitness.
  if (s.vo2Override && s.vo2Override.value > 0) {
    return {
      vdot: s.vo2Override.value,
      source: 'override',
      confidence: 'high',
      detail: 'Manually set',
      isDeviceFresh: false,
      deviceAgeDays,
    };
  }

  // Source toggle. Default = 'mosaic' (preferred when our estimate has
  // medium+ confidence, otherwise fall back to device). 'device' pins the
  // chain to the watch reading regardless of our estimate quality.
  // `skipMosaic` is set by the cross-modal orchestrator when it calls this
  // function for its own fallback. Including the mosaic-running tier there
  // would create a stale-state loop where last launch's stored estimate
  // pre-empts a freshly-improved LT or PB.
  const vo2Source = s.vo2Source ?? 'mosaic';
  const mosaicRunning = s.vo2Estimates?.running;
  const mosaicUsable = !opts.skipMosaic
    && mosaicRunning?.value != null
    && (mosaicRunning.confidence === 'high' || mosaicRunning.confidence === 'medium');

  // 1a. Mosaic running estimate, when toggle = 'mosaic' AND our confidence
  //     is high enough to displace the device value. This wins over device
  //     so users who don't trust their watch get our regression-derived value.
  if (vo2Source === 'mosaic' && mosaicUsable) {
    const n = mosaicRunning!.n;
    const detail = n > 0
      ? `Calibrated from ${n} steady run${n === 1 ? '' : 's'}`
      : (mosaicRunning!.detail ?? 'Estimated from your running fitness');
    return {
      vdot: mosaicRunning!.value!,
      source: 'mosaic-running',
      confidence: mosaicRunning!.confidence,
      detail,
      isDeviceFresh: false,
      deviceAgeDays,
    };
  }

  // 1a-bis. Race-validated run VDOT. A real race run leg (fatigue-discounted to
  // a fresh equivalent by raceRunLegToVdot) is the strongest race-validated
  // running signal — it outranks the watch VO2max, which for triathletes is
  // inflated by cycling and swimming and routinely overstates running-specific
  // fitness. Ranks ABOVE device while recent. A higher-confidence standalone
  // signal still wins: mosaic-running (tier 1a, derived from actual standalone
  // runs) sits above this, so a "better event" supersedes the race. Deliberately
  // NOT gated by skipDevice/skipMosaic — the race is watch-independent, so it
  // belongs in the orchestrator's own watch-free fallback estimate too, and is
  // freshly recomputed from persisted race data (no stale-estimate feedback loop).
  const race = raceAnchorVdot(s, now);
  if (race != null) {
    return {
      vdot: race.vdot,
      source: 'race-validated',
      confidence: 'high',
      detail: 'From your recent race',
      isDeviceFresh: false,
      deviceAgeDays,
    };
  }

  // 1b. Device-direct, fresh. Skipped when the orchestrator is computing its
  // own "Mosaic" running estimate. That path needs a value derived purely
  // from our own methods, not the device value, otherwise toggling Mosaic
  // vs Device would surface the same number.
  if (isDeviceFresh && !opts.skipDevice) {
    return {
      vdot: s.vo2 as number,
      source: 'device',
      confidence: 'high',
      detail: 'From your watch',
      isDeviceFresh: true,
      deviceAgeDays,
    };
  }

  // 2. HR-calibrated regression at medium+ confidence.
  const hr = s.hrCalibratedVdot;
  if (hr?.vdot != null && (hr.confidence === 'high' || hr.confidence === 'medium')) {
    const runWord = hr.n === 1 ? 'run' : 'runs';
    return {
      vdot: hr.vdot,
      source: 'hr-calibrated',
      confidence: hr.confidence,
      detail: `Calibrated from ${hr.n} steady ${runWord}`,
      isDeviceFresh: false,
      deviceAgeDays,
    };
  }

  // 3. LT-back-derived, only when LT was observation-based (avoid circularity).
  if (s.lt && s.ltSource && TRUSTED_LT_SOURCES.has(s.ltSource)) {
    const ltVdot = deriveVdotFromLT(s.lt);
    if (ltVdot != null && ltVdot >= 25) {
      const conf: PhysiologicalVdotConfidence = s.ltConfidence ?? 'medium';
      return {
        vdot: ltVdot,
        source: 'lt-derived',
        confidence: conf,
        detail: 'Derived from your LT pace',
        isDeviceFresh: false,
        deviceAgeDays,
      };
    }
  }

  // 4. PB-median across race PBs.
  const pbVdot = pbDerivedVdot(s);
  if (pbVdot != null) {
    return {
      vdot: pbVdot,
      source: 'pb-median',
      confidence: 'medium',
      detail: 'From your race-distance PBs',
      isDeviceFresh: false,
      deviceAgeDays,
    };
  }

  // 5. Tanda-blended fallback (volume-discounted, last resort).
  if (s.v != null && s.v > 0) {
    return {
      vdot: s.v,
      source: 'tanda-fallback',
      confidence: 'low',
      detail: 'Estimated from recent training',
      isDeviceFresh: false,
      deviceAgeDays,
    };
  }

  return {
    vdot: null,
    source: 'none',
    confidence: 'none',
    detail: '',
    isDeviceFresh: false,
    deviceAgeDays,
  };
}

/**
 * The single resolved running-fitness VDOT every fitness surface should read.
 *
 * Resolves the physiological chain (`getPhysiologicalVdot`), falling back to the
 * blended/onboarding effective VDOT (`s.v + adjustments`) for the rare case where
 * the chain returns 'none' but a bare baseline exists. This mirrors the inline
 * `getPhysiologicalVdot(s).vdot ?? computeCurrentVDOT(s)` chain the Stats card
 * used, lifted into one helper so the Stats "VO2 Max" bar and the no-target-race
 * Forecast grid resolve the SAME number. Returns null when there is no usable
 * running-fitness value at all.
 */
export function resolveRunningVdot(s: SimulatorState): number | null {
  const physio = getPhysiologicalVdot(s).vdot;
  if (physio != null && physio > 0) return physio;
  const eff = getEffectiveVdot(s);
  return eff > 0 ? eff : null;
}

/**
 * THE canonical "do we have enough running-fitness data to show a number?" gate.
 *
 * True iff `resolveRunningVdot` yields a usable value. Both the Stats "VO2 Max"
 * bar and the Forecast standard-distance grid gate on this, so a thin-data
 * athlete can never see contradictory answers (e.g. a VO2 bar on Stats but
 * "No predictions yet" on Forecast). See CLAUDE.md: "Two numbers that mean the
 * same thing must come from the same source." Per-distance race times are still
 * physically distinct from the VDOT itself; only the show/hide gate is shared.
 */
export function hasRunningFitnessSignal(s: SimulatorState): boolean {
  return resolveRunningVdot(s) != null;
}

/**
 * Stricter sibling of `hasRunningFitnessSignal`: true only when the resolved
 * VDOT comes from a REAL measured source, not the bare `s.v` baseline.
 *
 * `hasRunningFitnessSignal` is true for ANY non-null VDOT, including the default
 * `s.v` (50) or a stale value carried in state — so it answers "is there a
 * number to resolve", not "have we actually measured this athlete". Surfaces
 * that make a CLAIM off the number (a race-time projection, a population
 * percentile, a VO2max fitness-zone bar) must gate on this instead: showing
 * "you could run a 1:48 half" or "faster than 81%" off the baseline reads as a
 * confident statement about a runner we know nothing about.
 *
 * Real iff `getPhysiologicalVdot` resolves above the `tanda-fallback` tier:
 * `override` / `race-validated` / `device` / `mosaic-running` / `hr-calibrated` /
 * `lt-derived` / `pb-median`. The moment a race result / PB / device VO2 / HR
 * calibration / observed LT lands, the chain ranks above the fallback and this
 * flips true.
 */
export function hasRealRunningFitnessSignal(s: SimulatorState): boolean {
  const src = getPhysiologicalVdot(s).source;
  return src !== 'tanda-fallback' && src !== 'none';
}
