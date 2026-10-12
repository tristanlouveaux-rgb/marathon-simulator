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
import { runSkillVdot } from './tri-run-skill';
import { computePredictionInputs, collectRunsFromState, measuredWeeklyKm, type PredictionInputs } from './prediction-inputs';
import { raceEffortHrFloorForState } from './heart-rate';

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
 *  while recent. We reuse the one-year anchor (365 days) of the PB-recency rule
 *  the marathon-specificity penalty uses to credit recent full-distance capability
 *  (see RUN_PB_RECENCY_ANCHORS / SCIENCE_LOG "PB-recency scaling"). Beyond a year,
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

// ─── PB age (model weight only; stored and displayed PBs never change) ───

export type PbKey = 'k5' | 'k10' | 'h' | 'm';
/** Per-distance model weight of each PB by its age (`pbAgeWeight`). A missing
 *  key weighs 1. */
export type PbAgeWeights = Partial<Record<PbKey, number>>;

const PB_KEYS: readonly PbKey[] = ['k5', 'k10', 'h', 'm'];

/**
 * Half-life (years) of a PB's model weight (`pbAgeWeight`): SCIENCE_LOG
 * 2026-04-24 (pbAgeDecay), Tanaka & Seals 2008. Single source for the model
 * weight and every label that names it.
 */
export const PB_AGE_HALF_LIFE_YEARS = 3;

/**
 * The model weight of a PB by its age: a smooth half-life (decided by Tristan,
 * 2026-10-11, replacing the 2026-10-09 step bands of SCIENCE_LOG §T5):
 *
 *   weight = exp(-years x ln 2 / PB_AGE_HALF_LIFE_YEARS)
 *
 * with a 3-year half-life, the PB decay already in SCIENCE_LOG (2026-04-24,
 * "Effort-Calibrated VDOT from HR": pbAgeDecay), from the masters VO2max
 * decline literature (Tanaka & Seals 2008; Fitzgerald et al. 1997 for the
 * exponential rather than linear shape). 1 year 0.79, 2 years 0.63, 3 years
 * 0.50, 4 years 0.40, 5 years 0.31. PBs are displayed as entered or synced and
 * aged internally; the weight says how much a PB still speaks for current
 * capacity. It is continuous in the PB's age, so the weight adds no step on a
 * PB's anniversary, and it never reaches 0, so an old PB keeps some say. (The
 * low-volume PB-recency factor on the specificity penalties,
 * pbRecencyPenaltyFactor, is a separate rule, fully stale at three years, and is
 * continuous too: pb-age-continuity.test.ts.)
 *
 * No date, an unparseable one or a future one: 1.0 ("if absent, full recency
 * is assumed", §T5). PB dates exist for PBs auto-filled from Strava or Apple
 * history; a typed PB drops its date, so a manual PB never ages. `dateISO` may
 * be `YYYY-MM` or a full ISO date. Ages are in 365.25-day years.
 */
export function pbAgeWeight(dateISO: string | null | undefined, now: Date = new Date()): number {
  const years = pbAgeYears(dateISO, now);
  if (years == null || years <= 0) return 1;
  return Math.exp(-years * Math.LN2 / PB_AGE_HALF_LIFE_YEARS);
}

/**
 * Age of a PB in years (365.25-day years) from its date, or null without a
 * usable date. A future date reads as age 0 or less (callers treat it as fresh).
 */
export function pbAgeYears(dateISO: string | null | undefined, now: Date = new Date()): number | null {
  if (!dateISO) return null;
  const ts = Date.parse(dateISO.length === 7 ? dateISO + '-01' : dateISO);
  if (!Number.isFinite(ts)) return null;
  return (now.getTime() - ts) / (365.25 * DAY_MS);
}

/** Set only inside withPbAgeingSuspended (below). */
let pbAgeingSuspended = false;

/**
 * Age weights for the PBs in `pbs`. PB dates are stored beside the onboarding
 * PBs (`onboarding.pbDates` with `onboarding.pbs`), so a date belongs to a PB
 * only while that PB's time equals the onboarding time it was stored with. A
 * PB from elsewhere (a faster time in `s.pbs`, a legacy form) has no known date
 * and weighs 1.
 */
export function pbAgeWeightsFor(
  pbs: { k5?: number; k10?: number; h?: number; m?: number } | null | undefined,
  s: { onboarding?: { pbs?: { k5?: number; k10?: number; h?: number; m?: number }; pbDates?: Partial<Record<PbKey, string>> } | null },
  now: Date = new Date(),
): PbAgeWeights {
  const out: PbAgeWeights = {};
  if (!pbs) return out;
  const datedPbs = s.onboarding?.pbs ?? {};
  const dates = s.onboarding?.pbDates ?? {};
  for (const k of PB_KEYS) {
    const t = pbs[k];
    if (!(t != null && t > 0)) continue;
    const date = !pbAgeingSuspended && datedPbs[k] === t ? dates[k] : undefined;
    out[k] = pbAgeWeight(date, now);
  }
  return out;
}

/**
 * Run `fn` as if no PB had aged: every PB weighs 1 in pbAgeWeightsFor, as an
 * undated PB does. pbAgeWeightsFor is the source of PB age weights for the
 * run fitness model (the gated model weights, PB capacity, the LT derivation,
 * the blend, the floors), so there `fn` sees the unaged model. Two readers of
 * PB dates sit outside it and still age inside `fn`: the PB-recency factor
 * (pbRecencyPenaltyFactor reads the dates itself, by design) and the Ironman
 * marathon-depth credit (computeMarathonDepthMultiplier,
 * race-prediction.triathlon.ts, and its drill-down label call pbAgeWeight
 * directly). So for an Ironman with a dated marathon PB the counterfactual
 * still carries the depth credit's ageing. For the PB-age caption's
 * counterfactual (does ageing change a displayed number?, pb-age-caption.ts).
 * Synchronous; the previous setting is restored when `fn` returns or throws.
 */
export function withPbAgeingSuspended<T>(fn: () => T): T {
  const prev = pbAgeingSuspended;
  pbAgeingSuspended = true;
  try {
    return fn();
  } finally {
    pbAgeingSuspended = prev;
  }
}

/** Age weights for the PBs the physiology chain reads (`effectivePhysiologyPbs`). */
export function modelPbAgeWeights(s: SimulatorState, now: Date = new Date()): PbAgeWeights {
  return pbAgeWeightsFor(effectivePhysiologyPbs(s), s, now);
}

/**
 * PB age weights for every model use (the age-weighted PB median, the blend's
 * PB weight, the same-distance PB floor, the §BZ engine floor, the LT's PB
 * weights), or undefined when there is no measured weekly volume
 * (`measuredWeeklyKm`, prediction-inputs.ts: a synced window or a typed weekly
 * km). With no running data an old PB keeps full weight (§BV), and a PB's
 * anniversary moves nothing. Single gate for every caller: the refresh,
 * onboarding, the physiology chain (`pbCapacityForState`), the standard
 * forecast, the triathlon run-leg blend, the LT derivation and the Stats
 * race-estimates card, so a typed weekly km ages PBs on every surface or on
 * none.
 */
export function modelPbAgeWeightsIfMeasured(
  pbs: { k5?: number; k10?: number; h?: number; m?: number } | null | undefined,
  s: {
    onboarding?: { pbs?: { k5?: number; k10?: number; h?: number; m?: number }; pbDates?: Partial<Record<PbKey, string>> } | null;
    detectedWeeklyKm?: number | null;
  },
  inputs: Pick<PredictionInputs, 'weeklyKm' | 'weeksCovered'>,
  now: Date = new Date(),
): PbAgeWeights | undefined {
  return measuredWeeklyKm(inputs, s.detectedWeeklyKm) != null ? pbAgeWeightsFor(pbs, s, now) : undefined;
}

/**
 * Whether PB age currently changes the model for these PBs: a volume-gated
 * weight below 1 (`modelPbAgeWeightsIfMeasured`). Every age use, the weighted
 * PB median included, reads those gated weights, so this is the one test.
 * Drives the inline caption on the Stats race estimates (feature-reveal order:
 * inline caption first), so the caption shows exactly when the estimates rely
 * less on an old PB than its displayed time suggests.
 */
export function pbAgeingActive(
  pbs: { k5?: number; k10?: number; h?: number; m?: number } | null | undefined,
  s: {
    onboarding?: { pbs?: { k5?: number; k10?: number; h?: number; m?: number }; pbDates?: Partial<Record<PbKey, string>> } | null;
    detectedWeeklyKm?: number | null;
  },
  inputs: Pick<PredictionInputs, 'weeklyKm' | 'weeksCovered'>,
  now: Date = new Date(),
): boolean {
  const gated = modelPbAgeWeightsIfMeasured(pbs, s, inputs, now);
  return gated != null && Object.values(gated).some(w => w != null && w < 1);
}

/**
 * The §BZ engine floor for PB capacity, with PB age (SCIENCE_LOG §DC).
 *
 * A fresh or undated median PB (weight 1), or no measured volume
 * (`ageWeightsApply` false), floors the engine at PB capacity exactly as
 * before. An aged median PB (weight w below 1) floors it at the w-weighted
 * mean of PB capacity and the current capacity evidence, a medium+ HR-vs-pace
 * fit, capped at PB capacity: w x capacity + (1 - w) x min(HR fit, capacity).
 * With no such evidence the PB is the only capacity figure and the floor stays
 * at capacity. Easy-run paces and the race-readiness penalties on the blend
 * (durability, marathon specificity, low volume) are not capacity evidence
 * (§BZ, §CY), so the floor never pulls toward the penalised blend. That also
 * makes the floor the same at onboarding and after a refresh: both compute
 * the HR fit from the same runs, while their penalised blends differ (the
 * refresh has a PB-derived LT predictor and the HR fit in the blend).
 */
export function pbEngineFloorVdot(
  capacity: { vdot: number; weight: number },
  opts: { ageWeightsApply: boolean; hrFit: { vdot: number | null; confidence: string } | null | undefined },
): number {
  const w = capacity.weight;
  if (!opts.ageWeightsApply || !(w < 1)) return capacity.vdot;
  if (!isUsableHrFit(opts.hrFit)) return capacity.vdot;
  const current = Math.min(opts.hrFit.vdot, capacity.vdot);
  return w * capacity.vdot + (1 - w) * current;
}

/**
 * PB capacity: the age-weighted median VDOT across the race-distance PBs, and
 * the age weight at that median.
 *
 * Median (not max) because PB profiles are often imbalanced. A fast 5K
 * specialist with weak endurance shouldn't have their 5K alone drive the
 * estimate, and a marathoner with a slow 5K shouldn't lose theirs to it.
 * The median collapses both biases.
 *
 * With age weights (`modelPbAgeWeightsIfMeasured`, on the measured-volume
 * gate) the median is the weighted median with linear interpolation, the
 * weighted percentile at 0.5: each PB sits at the midpoint of its own weight
 * on the cumulative-weight scale, and the median is read where that scale
 * reaches half the total weight, interpolating linearly between neighbouring
 * PBs. With equal weights it is the plain median (Hyndman & Fan 1996,
 * definition 5, at p = 0.5), and the plain branch below computes it exactly as
 * before. It is continuous in the weights, so a PB weighted w keeps a share of
 * the say in proportion to w, and a PB's anniversary moves the median by a
 * bounded step. For two PBs it is their weight-weighted mean. With two or more
 * distinct PBs it stays strictly inside their range, so ageing never turns it
 * into the max (or the min). `weight` is the age weight interpolated at the
 * same point (the mean of the two middle weights when the plain median falls
 * between them); the §BZ engine floor uses it (`pbEngineFloorVdot`).
 */
export function pbCapacity(
  pbs: { k5?: number; k10?: number; h?: number; m?: number } | null | undefined,
  weights?: PbAgeWeights,
): { vdot: number; weight: number } | null {
  if (!pbs) return null;
  const items: Array<{ v: number; w: number }> = [];
  const push = (k: PbKey, distM: number) => {
    const t = pbs[k];
    if (t && t > 0) items.push({ v: cv(distM, t), w: weights?.[k] ?? 1 });
  };
  push('k5', 5000);
  push('k10', 10000);
  push('h', 21097.5);
  push('m', 42195);
  if (items.length === 0) return null;
  items.sort((a, b) => a.v - b.v);
  const mid = Math.floor(items.length / 2);
  if (items.every(it => it.w === items[0].w)) {
    // Plain median (identical to the pre-ageing computation).
    return items.length % 2 === 0
      ? { vdot: (items[mid - 1].v + items[mid].v) / 2, weight: items[0].w }
      : { vdot: items[mid].v, weight: items[0].w };
  }
  // Weighted median with linear interpolation between PB midpoints.
  const total = items.reduce((acc, it) => acc + it.w, 0);
  const half = total / 2;
  let cum = 0;
  const pos = items.map(it => {
    const p = cum + it.w / 2;
    cum += it.w;
    return p;
  });
  if (half <= pos[0]) return { vdot: items[0].v, weight: items[0].w };
  for (let i = 0; i + 1 < items.length; i++) {
    if (half <= pos[i + 1]) {
      const f = (half - pos[i]) / (pos[i + 1] - pos[i]);
      return {
        vdot: items[i].v + f * (items[i + 1].v - items[i].v),
        weight: items[i].w + f * (items[i + 1].w - items[i].w),
      };
    }
  }
  const last = items[items.length - 1];
  return { vdot: last.v, weight: last.w };
}

/**
 * `pbCapacity` for the PBs the physiology chain reads, with their age weights
 * on the measured-volume gate (`modelPbAgeWeightsIfMeasured`, over the same
 * runs as the refresh: `collectRunsFromState`). With no measured weekly volume
 * it is the plain median. The volume is read only when some PB is aged.
 */
export function pbCapacityForState(s: SimulatorState, now: Date = new Date()): { vdot: number; weight: number } | null {
  const pbs = effectivePhysiologyPbs(s);
  const weights = pbAgeWeightsFor(pbs, s, now);
  if (!Object.values(weights).some(w => w != null && w < 1)) return pbCapacity(pbs);
  const inputs = computePredictionInputs(collectRunsFromState(s), now, raceEffortHrFloorForState(s));
  return pbCapacity(pbs, modelPbAgeWeightsIfMeasured(pbs, s, inputs, now));
}

/**
 * PB capacity VDOT for the state (`pbCapacityForState`): the age-weighted
 * median across race-distance PBs. Drives the pb-median tier of
 * `getPhysiologicalVdot` (and so the LT input), the §BZ engine floor and the
 * triathlete running-evidence ceiling.
 */
export function pbDerivedVdot(s: SimulatorState, now: Date = new Date()): number | null {
  return pbCapacityForState(s, now)?.vdot ?? null;
}

/**
 * PB capacity VDOT from a raw PBs object (optionally age-weighted). Split out
 * from `pbDerivedVdot` so callers that hold a PBs object directly — e.g.
 * `initializeSimulator`, where `s.pbs` is not committed to state yet — can
 * compute the same demonstrated-capacity number without going through
 * `SimulatorState`. Single source for the median (`pbCapacity`).
 */
export function pbMedianVdot(
  pbs: { k5?: number; k10?: number; h?: number; m?: number } | null | undefined,
  weights?: PbAgeWeights,
): number | null {
  return pbCapacity(pbs, weights)?.vdot ?? null;
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

  // Running-specific evidence ceiling (TRIATHLETES ONLY). A watch VO2max is built
  // by cycling and swimming too, so for a triathlete it overstates RUNNING fitness:
  // two athletes with the SAME watch VO2max of 56 can be a 3:10 and a 4:00
  // marathoner — only running evidence tells them apart. The watch must therefore
  // not pull the blend's VO2 predictor ABOVE what running-specific evidence
  // supports: a recent race run leg, the athlete's race PBs, or an HR-vs-pace
  // calibration from real runs. A recent fast run / fresh PB / HR calibration
  // RAISES this ceiling (it's the max of the evidence), so a genuinely improving
  // runner is never trapped — PBs aren't a ceiling, only an uncorroborated
  // cross-trained watch is capped. Running mode (no triConfig) is untouched: there
  // the watch is run-specific and trusted as-is.
  const ceiling = triathleteRunEvidenceCeiling(s, now);
  if (ceiling != null && device > ceiling) return ceiling;  // watch exceeds running evidence → cap to it
  return device;
}

/** True when the HR-vs-pace calibration is usable as running evidence (medium+). */
function isUsableHrFit<T extends { vdot: number | null; confidence: string }>(hr: T | null | undefined): hr is T & { vdot: number } {
  return hr?.vdot != null && (hr.confidence === 'high' || hr.confidence === 'medium');
}

/**
 * The synced race effort that counts as a triathlete's running evidence: the
 * newest run in the 8-week window that passes the race test
 * (`computePredictionInputs` recentRun: more than 15% faster than the window's
 * median pace and, with HR, at or above the middle of Z4). Where HR rules
 * exist (the athlete has HR zones: `raceEffortHrFloorForState` is set), the run
 * must carry an average HR: a tempo-paced run with no HR passes the pace test
 * but says nothing about effort, so it must not lift the cold-start cap or set
 * the watch ceiling (Tristan, 2026-10-11, ISSUE-376). With no HR zones at all
 * the pace test stands alone. Null when no such run exists.
 */
export function triRunEvidenceRaceEffort(
  s: SimulatorState,
  now: Date = new Date(),
): { d: number; t: number; weeksAgo: number } | null {
  const recent = computePredictionInputs(
    collectRunsFromState(s), now, raceEffortHrFloorForState(s), { requireHr: true },
  ).recentRun;
  return recent != null && recent.t > 0 && recent.d > 0 ? recent : null;
}

/**
 * The running-specific evidence ceiling on a triathlete's watch VO2max: the max
 * of a recent race run leg (`raceAnchorVdot`), the race-PB median
 * (`pbDerivedVdot`), a medium+ HR-vs-pace calibration and a synced race effort
 * (`triRunEvidenceRaceEffort`, at its own distance: cv(d, t)). Null outside
 * triathlon (`s.triConfig` unset; running mode trusts the watch as
 * run-specific) or when no such evidence exists. Single source for the
 * ceiling in `effectiveVo2max` (the blend's VO2 predictor), in
 * `ltDanielsInputVdot` (the LT derivation's Daniels input) and for the
 * cold-start gate (`triColdStartRunCapVdot`: the cap applies exactly when this
 * is null), so the blend and the training paces hold the watch to the same
 * figure.
 *
 * The race effort (Tristan, 2026-10-11, ISSUE-376, approved as the natural
 * reading of "cap until real running evidence exists"): a synced race effort
 * lifts the cold-start cap, and before it was not in this ceiling, so the raw
 * watch returned to s.lt (70.3, watch 62, run skill 3: s.lt 288 to 220 after
 * one tempo). The watch is now held at the run that lifted the cap.
 */
export function triathleteRunEvidenceCeiling(s: SimulatorState, now: Date = new Date()): number | null {
  if (s.triConfig == null) return null;
  const ceilings: number[] = [];
  const race = raceAnchorVdot(s, now);
  if (race != null) ceilings.push(race.vdot);
  const pb = pbDerivedVdot(s, now);
  if (pb != null) ceilings.push(pb);
  if (isUsableHrFit(s.hrCalibratedVdot)) ceilings.push(s.hrCalibratedVdot.vdot);
  const effort = triRunEvidenceRaceEffort(s, now);
  if (effort != null) ceilings.push(cv(effort.d * 1000, effort.t));
  return ceilings.length > 0 ? Math.max(...ceilings) : null;
}

/**
 * Triathlon cold-start run cap (SCIENCE_LOG §CY "Triathlon cold-start cap").
 *
 * A triathlete with no running-specific evidence (no race PB, no race anchor,
 * no synced race effort, no medium+ HR-vs-pace calibration: exactly when
 * `triathleteRunEvidenceCeiling` is null) has only a watch VO2max, which
 * cycling and swimming build too, so it overstates RUNNING fitness. Such an
 * athlete is held at their own run skill-slider self-assessment
 * (`runSkillVdot`, 44.3 at run skill 3) until real running evidence lands.
 * Returns that VDOT when the cap applies, else null (running mode and
 * cycling-only mode have no `triConfig.skillRating.run`).
 *
 * Single source for the cap on the engine VDOT (`refreshBlendedFitness`) and on
 * the LT derivation's Daniels input (`ltDanielsInputVdot`). The synced race
 * effort is `triRunEvidenceRaceEffort`: where HR rules exist, a run without HR
 * is not evidence (2026-10-11). The HR fit is read from `s.hrCalibratedVdot`,
 * which `refreshBlendedFitness` writes before both reads.
 */
export function triColdStartRunCapVdot(
  s: SimulatorState,
  opts: { now?: Date } = {},
): number | null {
  const skill = s.triConfig?.skillRating?.run;
  if (!skill) return null;
  if (triathleteRunEvidenceCeiling(s, opts.now ?? new Date()) != null) return null;
  return runSkillVdot(skill as 1 | 2 | 3 | 4 | 5);
}

/**
 * The VDOT the LT derivation's Daniels method reads (`buildLTInputs`,
 * `recomputeLT` in ltSync.ts). Training paces come from `s.lt` whenever it is
 * set (`gp`, paces.ts), so this input decides a triathlete's run paces.
 *
 * It is `getPhysiologicalVdot(s).vdot`, except for a triathlete whose value
 * comes from the watch ('device') or the engine fallback ('tanda-fallback'):
 * the same figures that already hold the blend and the engine apply here.
 *   1. Running evidence exists (race anchor, race PB, medium+ HR fit): the
 *      watch is capped at `triathleteRunEvidenceCeiling`, as `effectiveVo2max`
 *      caps the blend's VO2 predictor.
 *   2. No running-specific signal (cold start, `triColdStartRunCapVdot`): the
 *      watch is capped at the run skill-slider VDOT, as `refreshBlendedFitness`
 *      caps `s.v`. With no fresh watch the chain falls to 'tanda-fallback',
 *      which is `s.v` itself; the input is then the run skill-slider VDOT. `s.v`
 *      is not running evidence there: it is the blend of the previous `s.lt`
 *      (the LT predictor) under the readiness penalties, so feeding it back
 *      compounds those penalties every refresh. Measured at 81d38f7 (70.3, run
 *      skill 3, no watch, PB or runs): `s.v` 44.3, 39.1, 34.0, 29.3, then 25.0
 *      (the Daniels floor), `s.lt` 261 to 402 s/km.
 * A synced race effort lifts the cold-start cap and is in the ceiling itself
 * (2026-10-11, ISSUE-376), so the watch is held at the run that lifted it.
 *
 * The displayed VO2max (`getPhysiologicalVdot`, the Stats card) still shows the
 * watch. Running and HYROX (no `triConfig`) read `getPhysiologicalVdot`
 * unchanged. Cycling-only mode has a `triConfig` but no run skill rating, so
 * only step 1 can apply there, as it already does in `effectiveVo2max`;
 * cycling plans prescribe no runs.
 */
export function ltDanielsInputVdot(
  s: SimulatorState,
  opts: { now?: string | Date } = {},
): number | null {
  return resolveLtDanielsInput(s, opts).vdot;
}

/**
 * `ltDanielsInputVdot` with whether the triathlon cold-start cap lowered it.
 * `coldStartCapped` is true only when the input was replaced by the run skill
 * VDOT: a watch reading ABOVE the skill rating ('device'), or the engine
 * fallback ('tanda-fallback', which is `s.v` itself). A watch at or below the
 * skill rating is used as it is and reports false. `source` is the chain tier
 * (`getPhysiologicalVdot`) and `uncappedVdot` its value before any triathlete
 * cap. `refreshBlendedFitness` reads all three for the cold-start engine hold:
 * where a watch was capped, the engine stays what the blend gives with the
 * uncapped LT input, capped at the skill VDOT; where the engine fallback was
 * replaced, the engine is held at the skill VDOT.
 */
export function resolveLtDanielsInput(
  s: SimulatorState,
  opts: { now?: string | Date } = {},
): { vdot: number | null; coldStartCapped: boolean; source: PhysiologicalVdotSource; uncappedVdot: number | null } {
  const now = opts.now
    ? (opts.now instanceof Date ? opts.now : new Date(opts.now))
    : new Date();
  const resolved = getPhysiologicalVdot(s, { now });
  const v = resolved.vdot;
  const base = { source: resolved.source, uncappedVdot: v };
  const uncapped = { vdot: v, coldStartCapped: false, ...base };
  if (v == null || s.triConfig == null) return uncapped;
  if (resolved.source !== 'device' && resolved.source !== 'tanda-fallback') return uncapped;
  const ceiling = triathleteRunEvidenceCeiling(s, now);
  if (ceiling != null) return { vdot: Math.min(v, ceiling), coldStartCapped: false, ...base };
  const cap = triColdStartRunCapVdot(s, { now });
  if (cap == null) return uncapped;
  if (resolved.source === 'device') {
    return v > cap ? { vdot: cap, coldStartCapped: true, ...base } : uncapped;
  }
  return { vdot: cap, coldStartCapped: true, ...base };
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

  // 4. PB-median across race PBs (age-weighted median, pbCapacity).
  const pbVdot = pbDerivedVdot(s, now);
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
