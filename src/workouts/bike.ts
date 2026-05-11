/**
 * Bike workout library.
 *
 * Generates structured bike sessions by phase. Targets expressed as % FTP
 * when power meter is present; otherwise HR zones. Coggan zone system
 * (§18.1 / §3.5):
 *   Z1 <55% FTP   recovery
 *   Z2 56-75%     endurance
 *   Z3 76-90%     tempo
 *   Z4 91-105%    threshold
 *   Z5 106-120%   VO2
 *   Z6 >120%      anaerobic / sprint
 *
 * Sweet spot is 88-95% FTP — the band between tempo and threshold that
 * delivers high stimulus with manageable fatigue (Seiler-adjacent).
 */

import type { Workout } from '@/types/state';
import type { TrainingPhase } from '@/types/training';
import type { Discipline, TriSkillSlider, TriWorkoutType } from '@/types/triathlon';
import { BIKE_ADHERENCE_BAND } from '@/constants/triathlon-constants';

export type BikeSessionKind =
  | 'endurance'
  | 'tempo'
  | 'sweet_spot'
  | 'threshold'
  | 'vo2'
  | 'hills'
  | 'over_under'   // Coggan & Allen 2019 Ch.7 — alternating 105/95% FTP at threshold
  | 'vo2_micros'   // Billat 2001 — 30s on / 30s off accumulates time at VO2max
  | 'vlamax';      // Coggan Z6 neuromuscular — short max sprints, full recovery

interface BikeSessionInput {
  phase: TrainingPhase;
  skill: TriSkillSlider;
  weekIndex: number;
  totalWeeks: number;
  targetMinutes: number;
  kind: BikeSessionKind;
  ftp?: number;                // Watts; enables power-based targets when present
  hasPowerMeter?: boolean;
  /** Slot index within the week (0-based). Rotates variants so same-kind
   * back-to-backs don't render identical. */
  slotIndex?: number;
  /** Explicit variant index (0-based). When set, overrides the
   * weekIndex+slotIndex rotation. Used by the ad-hoc session generator
   * when the user picks a specific structure. */
  variantIndex?: number;
}

/** Number of variants per bike kind. Source of truth for the picker drill-down. */
export const BIKE_VARIANT_COUNT: Record<BikeSessionKind, number> = {
  endurance: 3, tempo: 3, sweet_spot: 3, threshold: 3, vo2: 3,
  hills: 3, over_under: 3, vo2_micros: 3, vlamax: 3,
};

const bikeTypeMap: Record<BikeSessionKind, TriWorkoutType> = {
  endurance:  'bike_endurance',
  tempo:      'bike_tempo',
  sweet_spot: 'bike_sweet_spot',
  threshold:  'bike_threshold',
  vo2:        'bike_vo2',
  hills:      'bike_hills',
  over_under: 'bike_over_under',
  vo2_micros: 'bike_vo2_micros',
  vlamax:     'bike_vlamax',
};

/**
 * Substitute an excluded kind with the closest in-tier sibling, walking down
 * the intensity ladder when needed. Endurance is the universal fallback —
 * if it gets excluded along with everything else, we ignore the exclusion
 * to avoid producing an empty plan.
 */
function substituteExcluded(kind: BikeSessionKind, excluded: Set<string>): BikeSessionKind {
  if (!excluded.has(kind)) return kind;
  // Substitution chain — same energetic system first, then step down a tier.
  const chain: Record<BikeSessionKind, BikeSessionKind[]> = {
    vlamax:     ['hills', 'vo2', 'threshold', 'sweet_spot', 'tempo', 'endurance'],
    vo2_micros: ['vo2', 'threshold', 'sweet_spot', 'tempo', 'endurance'],
    vo2:        ['vo2_micros', 'threshold', 'sweet_spot', 'tempo', 'endurance'],
    over_under: ['threshold', 'sweet_spot', 'tempo', 'endurance'],
    threshold:  ['over_under', 'sweet_spot', 'tempo', 'endurance'],
    sweet_spot: ['tempo', 'endurance'],
    hills:      ['tempo', 'sweet_spot', 'endurance'],
    tempo:      ['endurance'],
    endurance:  [],  // No substitute — endurance always wins if excluded.
  };
  for (const candidate of chain[kind]) {
    if (!excluded.has(candidate)) return candidate;
  }
  return kind;  // Everything excluded — ignore and keep original.
}

export function pickBikeKind(
  phase: TrainingPhase,
  slotIndex: number,
  weekIndex: number = 0,
  excluded: Set<string> = new Set(),
): BikeSessionKind {
  // Week parity used to rotate the new pro-grade kinds in alongside the
  // classic ones, so a 4-week build cycle exposes the rider to both
  // sweet-spot and over-unders at slot 0 (rather than the same kind every
  // week). Endurance slots stay stable — recovery rides shouldn't rotate.
  const evenWeek = weekIndex % 2 === 0;
  const triWeek = weekIndex % 3 === 0;

  let pick: BikeSessionKind;
  if (phase === 'base') {
    // Aerobic foundation. No supra-threshold work; tempo stays tempo.
    pick = slotIndex === 0 ? 'endurance' : slotIndex === 1 ? 'endurance' : 'tempo';
  } else if (phase === 'build') {
    if (slotIndex === 0) pick = evenWeek ? 'sweet_spot' : 'over_under';
    else if (slotIndex === 1) pick = 'endurance';
    else pick = evenWeek ? 'tempo' : 'vo2_micros';
  } else if (phase === 'peak') {
    if (slotIndex === 0) pick = evenWeek ? 'threshold' : 'over_under';
    else if (slotIndex === 1) pick = 'endurance';
    // Three-way rotation across the secondary quality slot.
    else pick = triWeek ? 'vlamax' : evenWeek ? 'vo2' : 'vo2_micros';
  } else {
    // taper — keep neuromuscular sharpness without volume
    pick = slotIndex === 0 ? 'tempo' : 'endurance';
  }
  return substituteExcluded(pick, excluded);
}

export function generateBikeSession(input: BikeSessionInput): Workout {
  const { phase, kind, targetMinutes, ftp, hasPowerMeter } = input;

  const desc = describeBikeSession(kind, targetMinutes, ftp, hasPowerMeter, input.weekIndex, input.slotIndex ?? 0, input.variantIndex);
  const rpe = rpeForBike(kind, phase);
  const { aerobic, anaerobic } = loadForBike(kind, targetMinutes);

  const t: TriWorkoutType = bikeTypeMap[kind];
  const discipline: Discipline = 'bike';

  return {
    n: nameForBike(kind),
    d: desc,
    r: rpe,
    t,
    discipline,
    rpe,
    aerobic,
    anaerobic,
    estimatedDurationMin: Math.max(20, Math.round(targetMinutes)),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function nameForBike(kind: BikeSessionKind): string {
  switch (kind) {
    case 'endurance':  return 'Endurance ride';
    case 'tempo':      return 'Tempo ride';
    case 'sweet_spot': return 'Sweet spot';
    case 'threshold':  return 'Threshold intervals';
    case 'vo2':        return 'VO2 intervals';
    case 'hills':      return 'Hill repeats';
    case 'over_under': return 'Over-unders';
    case 'vo2_micros': return 'VO2 micro-intervals';
    case 'vlamax':     return 'Neuromuscular sprints';
  }
}

function pwLabel(ftp: number | undefined, hasPower: boolean | undefined, pct: number, workoutType?: string): string {
  if (hasPower && ftp) {
    const band = workoutType != null ? (BIKE_ADHERENCE_BAND[workoutType] ?? 0.07) : 0.07;
    const lo = Math.round(ftp * pct * (1 - band));
    const hi = Math.round(ftp * pct * (1 + band));
    return `${lo}–${hi}W`;
  }
  // No power meter: render HR-zone label rather than "% FTP" (which is
  // meaningless when the user can't read watts on their head unit). Maps
  // %FTP intensity bands to bike HR zones — anchored to Coggan & Allen Ch.4
  // training-zone table.
  return `${pctFtpToHrZoneLabel(pct)} (≈${Math.round(pct * 100)}% FTP)`;
}

/**
 * Map %FTP target intensity → bike HR-zone label. Used by `pwLabel` when no
 * power meter present so workout descriptions show "Z3 tempo" instead of an
 * unreadable "82% FTP". Bike zones are 7 bpm lower than running per
 * `BIKE_LTHR_OFFSET_VS_RUN` (Millet & Vleck 2000) — the user reads them on
 * their HR strap, the math accounts for the offset.
 */
function pctFtpToHrZoneLabel(pct: number): string {
  if (pct < 0.55) return 'Z1 recovery';
  if (pct < 0.75) return 'Z2 endurance';
  if (pct < 0.85) return 'Z3 tempo';
  if (pct < 0.95) return 'Z4 threshold';
  if (pct < 1.05) return 'Z4 / sub-threshold';
  return 'Z5 VO2';
}

/** Round to nearest 5 min for anything ≥ 30 min — matches the §4 decision. */
function rnd(mins: number): number {
  return mins >= 30 ? Math.round(mins / 5) * 5 : Math.round(mins);
}

/** Pretty "2h 30min" / "45min" format. */
function pretty(mins: number): string {
  const r = rnd(mins);
  const h = Math.floor(r / 60);
  const m = r % 60;
  if (h > 0 && m > 0) return `${h}h ${m}min`;
  if (h > 0) return `${h}h`;
  return `${m}min`;
}

/**
 * Variant rotation per kind. Rotated by `weekIndex`. Same energetic system,
 * different interval structures so the plan doesn't feel repetitive.
 */
export function describeBikeSession(
  kind: BikeSessionKind,
  minutes: number,
  ftp: number | undefined,
  hasPower: boolean | undefined,
  weekIndex: number,
  slotIndex: number = 0,
  explicitVariantIndex?: number,
): string {
  const hr = (zone: string) => ` (HR Z${zone})`;
  const idx = explicitVariantIndex != null
    ? explicitVariantIndex
    : Math.abs((weekIndex - 1) + slotIndex * 2);
  // Local helper — passes the session's workout type so pwLabel can look up
  // the per-kind tolerance band and render a range (e.g. "135–155W").
  const wt = bikeTypeMap[kind];
  const pw = (pct: number) => pwLabel(ftp, hasPower, pct, wt);

  switch (kind) {
    case 'endurance': {
      const variants = [
        () => `${pretty(minutes)} steady @ ${hasPower && ftp ? pw(0.65) : `Z2 endurance${hr('2')}`}. Conversational throughout.`,
        () => `${pretty(minutes)} rolling endurance — stay in Z2 on the flats, allow Z3 spikes on climbs. Recover on descents.`,
        () => `${pretty(minutes)} fasted endurance (optional) @ ${pw(0.60)}. Low intensity, long duration — aerobic base.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'tempo': {
      const variants = [
        () => {
          const reps = minutes >= 75 ? 2 : 1;
          const repMin = rnd((minutes - 20) / reps);
          return `15min Warm up. Main: ${reps}×${repMin}min @ ${pw(0.82)}, 5min easy between. 5min Cool down.`;
        },
        () => `15min Warm up. Main: 3×10min @ ${pw(0.85)}, 3min easy. 5min Cool down.`,
        () => `15min Warm up. Main: ${rnd(Math.max(20, minutes - 25))}min continuous tempo @ ${pw(0.80)}. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'sweet_spot': {
      const variants = [
        () => {
          const mainMin = minutes - 20;
          const reps = mainMin >= 40 ? 3 : mainMin >= 24 ? 2 : 1;
          const repMin = rnd(Math.max(6, Math.round(mainMin / reps) - 2));
          return `15min Warm up. Main: ${reps}×${repMin}min @ ${pw(0.90)}, 5min recovery. 5min Cool down.`;
        },
        () => `15min Warm up. Main: 4×8min @ ${pw(0.92)}, 2min recovery. 10min Cool down.`,
        () => `15min Warm up. Main: 2×20min @ ${pw(0.88)}, 5min recovery. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'threshold': {
      const variants = [
        () => {
          const reps = minutes >= 75 ? 3 : 2;
          const repMin = rnd(Math.max(6, Math.round((minutes - 25) / reps) - 3));
          return `15min Warm up. Main: ${reps}×${repMin}min @ ${pw(1.00)}, 4min recovery. 10min Cool down.`;
        },
        () => `15min Warm up. Main: 5×6min @ ${pw(1.02)}, 3min recovery. 10min Cool down.`,
        () => `15min Warm up. Main: 2×15min @ ${pw(0.98)}, 5min recovery. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'vo2': {
      const variants = [
        () => `20min Warm up. Main: ${minutes >= 60 ? 6 : 5}×3min @ ${pw(1.15)}, 3min recovery. 10min Cool down.`,
        () => `20min Warm up. Main: 8×2min @ ${pw(1.20)}, 2min recovery. 10min Cool down.`,
        () => `20min Warm up. Main: 4×4min @ ${pw(1.12)}, 4min recovery. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'hills': {
      const variants = [
        () => `20min Warm up. Main: ${minutes >= 60 ? 8 : 6}×2min climbs hard seated + 30s standing, 2min recovery. 10min Cool down.`,
        () => `20min Warm up. Main: 5×4min climbs @ ${pw(0.95)}, 4min descend. 10min Cool down.`,
        () => `20min Warm up. Main: 10×30s max efforts on climb, 90s recovery. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'over_under': {
      // Coggan & Allen 2019 Ch.7: alternating sub/supra-threshold reps train
      // lactate clearance at high intensity. Three variants span the spectrum
      // from classic over-unders (3min/3min) to criss-cross (1min/1min).
      const variants = [
        () => `15min Warm up. Main: 3×(3min @ ${pw(1.05)} → 3min @ ${pw(0.95)}) continuous, 5min easy between sets. 10min Cool down.`,
        () => `15min Warm up. Main: 2×(5×1min @ ${pw(1.10)} / 1min @ ${pw(0.85)}) criss-cross, 5min easy between blocks. 10min Cool down.`,
        () => `15min Warm up. Main: 4×(2min @ ${pw(1.05)} → 1min @ ${pw(0.95)}) continuous, 4min easy between. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'vo2_micros': {
      // Billat 2001 — 30/30s at vVO2max accumulates more time at VO2max than
      // longer reps, with lower lactate accumulation per minute of work.
      // Adapted to bike: 30s @ 115-120% FTP / 30s easy.
      const variants = [
        () => `20min Warm up. Main: 2×(10×30s @ ${pw(1.20)} / 30s easy), 5min easy between blocks. 10min Cool down.`,
        () => `20min Warm up. Main: 15×(30s @ ${pw(1.18)} / 30s @ ${pw(0.50)}). 10min Cool down.`,
        () => `20min Warm up. Main: 3×(8×40s @ ${pw(1.15)} / 20s easy), 4min easy between blocks. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'vlamax': {
      // Coggan Z6 / neuromuscular power. Short max efforts with full recovery
      // (3-5min) target PCr resynthesis and glycolytic ceiling without
      // accumulating fatigue. Total work volume kept low.
      const variants = [
        () => `20min Warm up. Main: 8×10s max sprint @ ${pw(1.60)}+, 3min easy spin between. 10min Cool down.`,
        () => `20min Warm up. Main: 6×15s max @ ${pw(1.50)}+ standing start, 4min full recovery. 10min Cool down.`,
        () => `20min Warm up. Main: 3×(4×6s seated max sprint, 90s easy), 5min easy between blocks. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
  }
}

function rpeForBike(kind: BikeSessionKind, phase: TrainingPhase): number {
  const base: Record<BikeSessionKind, number> = {
    endurance: 4,
    tempo: 6,
    sweet_spot: 7,
    threshold: 8,
    vo2: 9,
    hills: 8,
    over_under: 8,   // Threshold-spec'd, with overshoots that bite
    vo2_micros: 9,   // Same energetic cost as VO2 reps
    vlamax: 8,       // High effort per rep but long rests keep average down
  };
  let rpe = base[kind];
  if (phase === 'taper') rpe = Math.max(3, rpe - 1);
  return rpe;
}

function loadForBike(kind: BikeSessionKind, minutes: number): { aerobic: number; anaerobic: number } {
  // Rough TSS-per-minute values — Phase 4 replaces with real bTSS.
  const tssPerMin: Record<BikeSessionKind, number> = {
    endurance: 0.85,
    tempo: 1.25,
    sweet_spot: 1.5,
    threshold: 1.7,
    vo2: 1.9,
    hills: 1.65,
    over_under: 1.65,  // Slightly above threshold — overshoots compound load
    vo2_micros: 1.75,  // Below classic VO2 because work:rest is 1:1, not 3:3
    vlamax: 1.10,      // Total work is small (≤2min); rest dominates session
  };
  const anaerobicShare: Record<BikeSessionKind, number> = {
    endurance: 0.05,
    tempo: 0.15,
    sweet_spot: 0.25,
    threshold: 0.40,
    vo2: 0.60,
    hills: 0.45,
    over_under: 0.45,  // Lactate-shuttling at threshold + overs
    vo2_micros: 0.55,  // Repeated VO2 spikes — high anaerobic, but rest clears partially
    vlamax: 0.75,      // PCr/glycolytic dominant — almost entirely anaerobic
  };
  const total = tssPerMin[kind] * minutes;
  return {
    aerobic: Math.round(total * (1 - anaerobicShare[kind])),
    anaerobic: Math.round(total * anaerobicShare[kind]),
  };
}
