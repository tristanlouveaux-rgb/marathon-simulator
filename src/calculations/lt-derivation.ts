/**
 * LT Derivation — blended lactate threshold estimator.
 *
 * Computes a single best-estimate LT pace + LTHR from three independent methods:
 *   1. Daniels T-pace from VDOT                (algorithmic, always available if VDOT exists)
 *   2. Critical Speed from race-distance PBs   (Jones/Vanhatalo 2-param model)
 *   3. Empirical detection from sustained efforts (aerobic decoupling <5%, Friel)
 *
 * The three are blended with confidence-weighted averaging, time-decayed toward
 * recent observations. Outlier-robust: excludes treadmill runs, hot-weather HR
 * inflation, sub-20min efforts, and out-of-band HR signatures.
 *
 * Science references + constants: docs/SCIENCE_LOG.md § Lactate Threshold Derivation.
 *
 * Pure functions — no state mutation.
 */

export type LTMethod = 'daniels' | 'critical-speed' | 'empirical' | 'override' | 'garmin';
export type LTConfidence = 'high' | 'medium' | 'low';

export interface LTDerivationResult {
  ltPaceSecKm: number | null;
  ltHR: number | null;
  source: LTMethod | 'blended';
  confidence: LTConfidence;
  methods: Array<{
    method: LTMethod;
    ltPaceSecKm: number;
    ltHR?: number | null;
    weight: number;
    detail: string;
  }>;
  /** One-line human summary for UI provenance caption. */
  provenance: string;
}

export interface BestEffortInput {
  /** Distance in meters (1609, 3000, 5000, 10000, 21097.5, 42195, etc.). */
  distanceM: number;
  /** Elapsed time in seconds. */
  elapsedSec: number;
  /** ISO date string — used to time-decay older efforts. */
  date?: string;
}

export interface SustainedEffortInput {
  /** ISO datetime. */
  startTime: string;
  /** Total running duration in seconds. */
  durationSec: number;
  /** Average running pace (sec/km). */
  avgPaceSecKm: number;
  /** Average HR across the effort. */
  avgHR: number | null;
  /** Per-km split paces (sec/km), length = full km count of the run. */
  kmSplits?: number[] | null;
  /** Per-km HR (bpm) if available. Not currently populated — reserved. */
  kmHR?: number[] | null;
  /** Activity subtype. 'treadmill', 'VirtualRun' etc. are excluded. */
  sportType?: string | null;
  /** Ambient temp °C. Activities >28°C are excluded (HR inflation). */
  ambientTempC?: number | null;
  /** Elevation gain in metres. Activities with >15 m/km are excluded (gradient decouples pace). */
  elevationGainM?: number | null;
}

export interface LTOverride {
  /** User-entered LT pace (sec/km). */
  ltPaceSecKm: number;
  /** Optional user-entered LTHR. */
  ltHR?: number;
  /** ISO datetime set at. */
  setAt: string;
}

export interface DeriveLTInput {
  vdot: number | null;
  maxHR: number | null;
  bestEfforts?: BestEffortInput[] | null;
  sustainedEfforts?: SustainedEffortInput[] | null;
  /** Latest Garmin LT values if present. Optional — we'll expose them as a separate method rather than blend. */
  garmin?: { ltPaceSecKm?: number | null; ltHR?: number | null; asOf?: string | null } | null;
  override?: LTOverride | null;
  /** ISO date — defaults to today. Used for time-decay weighting. */
  now?: string;
}

// ─── Constants (all sourced — see SCIENCE_LOG.md) ─────────────────────────

/** Daniels: T-intensity = 88% of vVO2max (Running Formula 3rd ed., Table 4.1). */
const DANIELS_T_FRACTION = 0.88;

/** CS is ~8% above MLSS in trained runners (Nixon et al. 2021, PMC8505327). */
const CS_TO_LT_RATIO = 0.93;

/** Aerobic decoupling threshold — Uphill Athlete / Friel. <5% = steady state. */
const MAX_DECOUPLING_PCT = 0.05;

/** LT2 HR band for empirical detection (Poole et al., Faude et al.). */
const EMPIRICAL_HR_MIN_FRAC = 0.85;
const EMPIRICAL_HR_MAX_FRAC = 0.92;

/** LTHR fallback when no empirical HR pair available. Midpoint of 85–92% band. */
const LTHR_FALLBACK_FRAC = 0.88;

/** Minimum effort duration for empirical detection (below this, no steady state possible). */
const MIN_EMPIRICAL_DURATION_SEC = 20 * 60;

/** Maximum ambient temp for empirical HR trust (heat inflates HR 5–20 bpm). */
const MAX_AMBIENT_TEMP_C = 28;

/** Maximum elevation gain per km for empirical pace trust. Beyond this, gradient dominates effort. */
const MAX_ELEV_GAIN_PER_KM = 15;

/** Time-decay constant for empirical efforts (days). τ=21 → 50% weight at 3 weeks. */
const EMPIRICAL_DECAY_TAU_DAYS = 21;

/** Max age for empirical efforts. Older than this = discarded. */
const EMPIRICAL_MAX_AGE_DAYS = 120;

/** Max age for best efforts in CS fit. */
const CS_MAX_AGE_DAYS = 365;

/** CS fit requires at least this many efforts of sufficiently different durations. */
const CS_MIN_EFFORTS = 2;

/** CS fit durations must span at least this many seconds (600s ≈ 10min range). */
const CS_MIN_DURATION_SPAN_SEC = 600;

/** Minimum VDOT to trust Daniels formula. Below this the athlete is pre-aerobic-base. */
const MIN_VDOT = 25;

/** Pace CV (coefficient of variation across splits) above which the run is not steady. */
const MAX_PACE_CV = 0.08;

// ─── Method 1: Daniels T-pace from VDOT ───────────────────────────────────

/**
 * Invert Daniels' VO2 cost-of-running equation to find vVO2max (m/min) for a given VDOT,
 * then scale to T-pace. Returns sec/km.
 *
 * Daniels cost equation: VO2 = -4.60 + 0.182258·v + 0.000104·v²   (v in m/min)
 * Solve for v at VO2 = VDOT (quadratic). Keep positive root.
 *
 * T-pace = vVO2max / DANIELS_T_FRACTION (slower pace → higher sec/km).
 */
export function deriveLTFromVdot(vdot: number | null): number | null {
  if (!vdot || vdot < MIN_VDOT) return null;

  // 0.000104·v² + 0.182258·v − (4.60 + VDOT) = 0
  const a = 0.000104;
  const b = 0.182258;
  const c = -(4.6 + vdot);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const v = (-b + Math.sqrt(disc)) / (2 * a); // m/min
  if (v <= 0) return null;

  const vVO2maxSecPerKm = (1000 / v) * 60;
  return vVO2maxSecPerKm / DANIELS_T_FRACTION;
}

// ─── Method 2: Critical Speed from best efforts ───────────────────────────

/**
 * Fit the 2-parameter hyperbolic CS model:  distance = CS·time + D'
 *
 * Linear regression of distance (y) on time (x). Intercept = D' (anaerobic
 * distance capacity, metres). Slope = CS (m/s).
 *
 * Returns null if insufficient efforts, poor duration spread, or physiologically
 * implausible fit (D' < 50m or > 500m).
 *
 * LT ≈ 0.93 × CS (Nixon et al. 2021). Converted to sec/km.
 */
export function deriveLTFromCriticalSpeed(
  bestEfforts: BestEffortInput[] | null | undefined,
  now: Date,
): { ltPaceSecKm: number; csMetersPerSec: number; dPrime: number; nEfforts: number } | null {
  if (!bestEfforts || bestEfforts.length < CS_MIN_EFFORTS) return null;

  // Filter by age, valid distance/time, and drop obvious cross-training.
  // Prefer unique distances — if same distance appears twice, keep the faster.
  const fresh = bestEfforts
    .filter((e) => e.distanceM > 0 && e.elapsedSec > 0)
    .filter((e) => {
      if (!e.date) return true;
      const ageDays = (now.getTime() - new Date(e.date).getTime()) / (1000 * 86400);
      return ageDays <= CS_MAX_AGE_DAYS;
    })
    // Drop ultra-short efforts (<2 min) — dominated by anaerobic capacity.
    // Drop ultra-long (>60 min) — glycogen/fuelling effects pull fit away from CS.
    // 60 min covers slow-runner 10K and most 15K race efforts; excludes half-marathon
    // and above where the fit starts to curve.
    .filter((e) => e.elapsedSec >= 120 && e.elapsedSec <= 3600);

  const byDist = new Map<number, BestEffortInput>();
  for (const e of fresh) {
    const prev = byDist.get(e.distanceM);
    if (!prev || e.elapsedSec / e.distanceM < prev.elapsedSec / prev.distanceM) {
      byDist.set(e.distanceM, e);
    }
  }
  const points = Array.from(byDist.values());
  if (points.length < CS_MIN_EFFORTS) return null;

  const durations = points.map((p) => p.elapsedSec);
  const span = Math.max(...durations) - Math.min(...durations);
  if (span < CS_MIN_DURATION_SPAN_SEC) return null;

  // OLS fit: d = CS·t + D'
  const n = points.length;
  const sumT = points.reduce((s, p) => s + p.elapsedSec, 0);
  const sumD = points.reduce((s, p) => s + p.distanceM, 0);
  const sumTT = points.reduce((s, p) => s + p.elapsedSec * p.elapsedSec, 0);
  const sumTD = points.reduce((s, p) => s + p.elapsedSec * p.distanceM, 0);
  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 1e-6) return null;

  const cs = (n * sumTD - sumT * sumD) / denom; // m/s
  const dPrime = (sumD - cs * sumT) / n;        // m

  if (cs <= 0) return null;
  // Physiologically plausible D' range (Jones & Vanhatalo 2017).
  if (dPrime < 50 || dPrime > 500) return null;

  const ltMetersPerSec = cs * CS_TO_LT_RATIO;
  const ltPaceSecKm = 1000 / ltMetersPerSec;

  return { ltPaceSecKm, csMetersPerSec: cs, dPrime, nEfforts: n };
}

// ─── Method 3: Empirical detection from sustained efforts ─────────────────

interface QualifyingEffort {
  ltPaceSecKm: number;
  hr: number;
  ageDays: number;
  decouplingPct: number;
}

/**
 * Scan recent sustained efforts for ones that exhibit LT steady-state behaviour:
 *   - duration ≥ 20 min
 *   - avgHR in 85–92% of HRmax band
 *   - pace CV < 8% (steady, not interval)
 *   - HR decoupling < 5% (Friel / Uphill Athlete)
 *   - not treadmill, not excessively hilly, not heat-affected
 *
 * Returns the time-decayed weighted mean pace and HR.
 */
export function deriveLTFromSustainedEfforts(
  efforts: SustainedEffortInput[] | null | undefined,
  maxHR: number | null,
  now: Date,
): { ltPaceSecKm: number; ltHR: number; nQualifying: number } | null {
  if (!maxHR || maxHR <= 0) return null;
  if (!efforts || efforts.length === 0) return null;

  const hrLo = maxHR * EMPIRICAL_HR_MIN_FRAC;
  const hrHi = maxHR * EMPIRICAL_HR_MAX_FRAC;

  const qualifying: QualifyingEffort[] = [];

  for (const e of efforts) {
    if (e.durationSec < MIN_EMPIRICAL_DURATION_SEC) continue;
    if (!e.avgHR) continue;
    if (e.avgHR < hrLo || e.avgHR > hrHi) continue;

    // Treadmill / virtual: pace unreliable.
    const sport = (e.sportType || '').toLowerCase();
    if (sport.includes('treadmill') || sport.includes('virtual')) continue;

    // Heat: HR inflated.
    if (e.ambientTempC != null && e.ambientTempC > MAX_AMBIENT_TEMP_C) continue;

    // Gradient: pace decoupled from effort.
    const km = e.durationSec / (e.avgPaceSecKm || 1);
    if (e.elevationGainM != null && km > 0) {
      if (e.elevationGainM / km > MAX_ELEV_GAIN_PER_KM) continue;
    }

    // Steady-state: pace CV check.
    if (e.kmSplits && e.kmSplits.length >= 3) {
      const mean = e.kmSplits.reduce((a, b) => a + b, 0) / e.kmSplits.length;
      const variance = e.kmSplits.reduce((a, b) => a + (b - mean) * (b - mean), 0) / e.kmSplits.length;
      const cv = Math.sqrt(variance) / mean;
      if (cv > MAX_PACE_CV) continue;
    }

    // Decoupling approximation: compare pace in second half vs first half (pace slowing at constant HR = aerobic decoupling).
    // Without per-km HR we use pace drift as a proxy — acceptable because steady HR in the band is already required.
    let decoupling = 0;
    if (e.kmSplits && e.kmSplits.length >= 4) {
      const half = Math.floor(e.kmSplits.length / 2);
      const firstAvg = e.kmSplits.slice(0, half).reduce((a, b) => a + b, 0) / half;
      const secondAvg = e.kmSplits.slice(half).reduce((a, b) => a + b, 0) / (e.kmSplits.length - half);
      if (firstAvg > 0) decoupling = (secondAvg - firstAvg) / firstAvg;
    }
    if (decoupling > MAX_DECOUPLING_PCT) continue;

    const ageDays = (now.getTime() - new Date(e.startTime).getTime()) / (1000 * 86400);
    if (ageDays < 0 || ageDays > EMPIRICAL_MAX_AGE_DAYS) continue;

    qualifying.push({
      ltPaceSecKm: e.avgPaceSecKm,
      hr: e.avgHR,
      ageDays,
      decouplingPct: decoupling,
    });
  }

  if (qualifying.length === 0) return null;

  // Time-decay weighted mean.
  let sumW = 0;
  let sumWPace = 0;
  let sumWHR = 0;
  for (const q of qualifying) {
    const w = Math.exp(-q.ageDays / EMPIRICAL_DECAY_TAU_DAYS);
    sumW += w;
    sumWPace += w * q.ltPaceSecKm;
    sumWHR += w * q.hr;
  }
  if (sumW <= 0) return null;

  return {
    ltPaceSecKm: sumWPace / sumW,
    ltHR: sumWHR / sumW,
    nQualifying: qualifying.length,
  };
}

// ─── LTHR fallback ─────────────────────────────────────────────────────────

/**
 * Derive LTHR when no empirical HR pair is available. Uses 88% of HRmax
 * (midpoint of the 85–92% LT2 band for trained runners).
 */
export function deriveLTHRFromMaxHR(maxHR: number | null): number | null {
  if (!maxHR || maxHR <= 0) return null;
  return Math.round(maxHR * LTHR_FALLBACK_FRAC);
}

// ─── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Compute a single blended LT estimate from all available inputs.
 *
 * Priority:
 *   1. User override (absolute precedence)
 *   2. Blended: empirical (if ≥1 qualifying effort) + CS + Daniels
 *   3. Falls back through available methods if any are missing
 *
 * Blend weights depend on what's available — see SCIENCE_LOG.md.
 */
export function deriveLT(input: DeriveLTInput): LTDerivationResult {
  const now = input.now ? new Date(input.now) : new Date();

  // Priority 1 — override wins outright.
  if (input.override) {
    const ovr = input.override;
    return {
      ltPaceSecKm: ovr.ltPaceSecKm,
      ltHR: ovr.ltHR ?? deriveLTHRFromMaxHR(input.maxHR),
      source: 'override',
      confidence: 'high',
      methods: [
        {
          method: 'override',
          ltPaceSecKm: ovr.ltPaceSecKm,
          ltHR: ovr.ltHR ?? null,
          weight: 1,
          detail: `User-entered LT set ${ovr.setAt.slice(0, 10)}`,
        },
      ],
      provenance: 'Manually set by you',
    };
  }

  // Priority 2 — derive from inputs.
  const daniels = deriveLTFromVdot(input.vdot);
  const cs = deriveLTFromCriticalSpeed(input.bestEfforts, now);
  const emp = deriveLTFromSustainedEfforts(input.sustainedEfforts, input.maxHR, now);

  const methods: LTDerivationResult['methods'] = [];

  // Determine weights based on what's available.
  const hasEmp = emp !== null;
  const hasCS = cs !== null;
  const hasDaniels = daniels !== null;

  let wEmp = 0,
    wCS = 0,
    wDan = 0;

  if (hasEmp && hasCS && hasDaniels) {
    wEmp = 0.5;
    wCS = 0.3;
    wDan = 0.2;
  } else if (hasEmp && hasCS) {
    wEmp = 0.6;
    wCS = 0.4;
  } else if (hasEmp && hasDaniels) {
    wEmp = 0.65;
    wDan = 0.35;
  } else if (hasCS && hasDaniels) {
    wCS = 0.6;
    wDan = 0.4;
  } else if (hasEmp) {
    wEmp = 1;
  } else if (hasCS) {
    wCS = 1;
  } else if (hasDaniels) {
    wDan = 1;
  }

  if (wEmp > 0 && emp) {
    methods.push({
      method: 'empirical',
      ltPaceSecKm: emp.ltPaceSecKm,
      ltHR: emp.ltHR,
      weight: wEmp,
      detail: `${emp.nQualifying} steady-state effort${emp.nQualifying === 1 ? '' : 's'} in last 120d`,
    });
  }
  if (wCS > 0 && cs) {
    methods.push({
      method: 'critical-speed',
      ltPaceSecKm: cs.ltPaceSecKm,
      weight: wCS,
      detail: `CS ${cs.csMetersPerSec.toFixed(2)}m/s, D′ ${Math.round(cs.dPrime)}m from ${cs.nEfforts} PBs`,
    });
  }
  if (wDan > 0 && daniels != null) {
    methods.push({
      method: 'daniels',
      ltPaceSecKm: daniels,
      weight: wDan,
      detail: `88% vVO2max from VDOT ${input.vdot?.toFixed(1)}`,
    });
  }

  if (methods.length === 0) {
    // Nothing available. Expose Garmin as last-resort if it exists.
    if (input.garmin?.ltPaceSecKm) {
      return {
        ltPaceSecKm: input.garmin.ltPaceSecKm,
        ltHR: input.garmin.ltHR ?? deriveLTHRFromMaxHR(input.maxHR),
        source: 'garmin',
        confidence: 'medium',
        methods: [
          {
            method: 'garmin',
            ltPaceSecKm: input.garmin.ltPaceSecKm,
            ltHR: input.garmin.ltHR ?? null,
            weight: 1,
            detail: `Garmin watch reading${input.garmin.asOf ? ` as of ${input.garmin.asOf.slice(0, 10)}` : ''}`,
          },
        ],
        provenance: 'Garmin watch reading',
      };
    }
    return {
      ltPaceSecKm: null,
      ltHR: null,
      source: 'blended',
      confidence: 'low',
      methods: [],
      provenance: 'Insufficient data to estimate LT',
    };
  }

  const blendedPace =
    methods.reduce((s, m) => s + m.ltPaceSecKm * m.weight, 0) /
    methods.reduce((s, m) => s + m.weight, 0);

  // LTHR: prefer empirical; else 0.88 × HRmax; else null.
  const ltHR = emp ? Math.round(emp.ltHR) : deriveLTHRFromMaxHR(input.maxHR);

  // Confidence logic:
  //   high  = empirical present AND (CS or Daniels) — triangulated
  //   medium = one method only, or empirical absent
  //   low = Daniels only
  let confidence: LTConfidence;
  if (hasEmp && (hasCS || hasDaniels)) {
    confidence = 'high';
  } else if (hasEmp || hasCS) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Provenance one-liner.
  const parts: string[] = [];
  if (hasEmp) parts.push(`${emp!.nQualifying} steady run${emp!.nQualifying === 1 ? '' : 's'}`);
  if (hasCS) parts.push(`critical speed from ${cs!.nEfforts} PBs`);
  if (hasDaniels) parts.push(`VDOT ${input.vdot!.toFixed(1)}`);
  const provenance =
    methods.length === 1
      ? `Derived from ${parts[0]}`
      : `Blended: ${parts.join(' + ')}`;

  return {
    ltPaceSecKm: blendedPace,
    ltHR,
    source: methods.length === 1 ? methods[0].method : 'blended',
    confidence,
    methods,
    provenance,
  };
}

/**
 * Selector: resolve the LT value the app should use, given state inputs.
 *
 * Priority: override > Garmin (if fresh) > derived > null
 *
 * Garmin is preferred over derived when the reading is <60 days old, because
 * when it *is* present it comes from the FirstBeat algorithm running
 * continuously on the watch — higher fidelity than any field-data estimator.
 * When stale or absent, our derived value takes over.
 */
export function resolveLT(input: DeriveLTInput): LTDerivationResult {
  if (input.override) return deriveLT(input);

  const derived = deriveLT(input);

  if (input.garmin?.ltPaceSecKm && input.garmin.asOf) {
    const now = input.now ? new Date(input.now) : new Date();
    const ageDays = (now.getTime() - new Date(input.garmin.asOf).getTime()) / (1000 * 86400);
    if (ageDays <= 60) {
      // Prefer Garmin when fresh. Return as a single-method result for provenance clarity.
      return {
        ltPaceSecKm: input.garmin.ltPaceSecKm,
        ltHR: input.garmin.ltHR ?? derived.ltHR,
        source: 'garmin',
        confidence: 'high',
        methods: [
          {
            method: 'garmin',
            ltPaceSecKm: input.garmin.ltPaceSecKm,
            ltHR: input.garmin.ltHR ?? null,
            weight: 1,
            detail: `Garmin watch (as of ${input.garmin.asOf.slice(0, 10)})`,
          },
        ],
        provenance: `Garmin watch reading, ${Math.round(ageDays)}d old`,
      };
    }
  }

  return derived;
}
