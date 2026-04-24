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

export type BikeSessionKind = 'endurance' | 'tempo' | 'sweet_spot' | 'threshold' | 'vo2' | 'hills';

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
}

const bikeTypeMap: Record<BikeSessionKind, TriWorkoutType> = {
  endurance:  'bike_endurance',
  tempo:      'bike_tempo',
  sweet_spot: 'bike_sweet_spot',
  threshold:  'bike_threshold',
  vo2:        'bike_vo2',
  hills:      'bike_hills',
};

export function pickBikeKind(phase: TrainingPhase, slotIndex: number): BikeSessionKind {
  if (phase === 'base') {
    return slotIndex === 0 ? 'endurance' : slotIndex === 1 ? 'endurance' : 'tempo';
  }
  if (phase === 'build') {
    return slotIndex === 0 ? 'sweet_spot' : slotIndex === 1 ? 'endurance' : 'tempo';
  }
  if (phase === 'peak') {
    return slotIndex === 0 ? 'threshold' : slotIndex === 1 ? 'endurance' : 'vo2';
  }
  // taper
  return slotIndex === 0 ? 'tempo' : 'endurance';
}

export function generateBikeSession(input: BikeSessionInput): Workout {
  const { phase, kind, targetMinutes, ftp, hasPowerMeter } = input;

  const desc = describeBikeSession(kind, targetMinutes, ftp, hasPowerMeter, input.weekIndex, input.slotIndex ?? 0);
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
  }
}

function pwLabel(ftp: number | undefined, hasPower: boolean | undefined, pct: number): string {
  if (hasPower && ftp) return `${Math.round(ftp * pct)}W`;
  return `${Math.round(pct * 100)}% FTP`;
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
function describeBikeSession(
  kind: BikeSessionKind,
  minutes: number,
  ftp: number | undefined,
  hasPower: boolean | undefined,
  weekIndex: number,
  slotIndex: number = 0
): string {
  const hr = (zone: string) => ` (HR Z${zone})`;
  const idx = Math.abs((weekIndex - 1) + slotIndex * 2);

  switch (kind) {
    case 'endurance': {
      const variants = [
        () => `${pretty(minutes)} steady @ ${hasPower && ftp ? pwLabel(ftp, hasPower, 0.65) : `Z2 endurance${hr('2')}`}. Conversational throughout.`,
        () => `${pretty(minutes)} rolling endurance — stay in Z2 on the flats, allow Z3 spikes on climbs. Recover on descents.`,
        () => `${pretty(minutes)} fasted endurance (optional) @ Z1–Z2. Low intensity, long duration — aerobic base.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'tempo': {
      const variants = [
        () => {
          const reps = minutes >= 75 ? 2 : 1;
          const repMin = rnd((minutes - 20) / reps);
          return `15min Warm up. Main: ${reps}×${repMin}min @ ${pwLabel(ftp, hasPower, 0.82)}, 5min easy between. 5min Cool down.`;
        },
        () => `15min Warm up. Main: 3×10min @ ${pwLabel(ftp, hasPower, 0.85)}, 3min easy. 5min Cool down.`,
        () => `15min Warm up. Main: ${rnd(Math.max(20, minutes - 25))}min continuous tempo @ ${pwLabel(ftp, hasPower, 0.80)}. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'sweet_spot': {
      const variants = [
        () => {
          const mainMin = minutes - 20;
          const reps = mainMin >= 40 ? 3 : mainMin >= 24 ? 2 : 1;
          const repMin = rnd(Math.max(6, Math.round(mainMin / reps) - 2));
          return `15min Warm up. Main: ${reps}×${repMin}min @ ${pwLabel(ftp, hasPower, 0.90)}, 5min recovery. 5min Cool down.`;
        },
        () => `15min Warm up. Main: 4×8min @ ${pwLabel(ftp, hasPower, 0.92)}, 2min recovery. 10min Cool down.`,
        () => `15min Warm up. Main: 2×20min @ ${pwLabel(ftp, hasPower, 0.88)}, 5min recovery. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'threshold': {
      const variants = [
        () => {
          const reps = minutes >= 75 ? 3 : 2;
          const repMin = rnd(Math.max(6, Math.round((minutes - 25) / reps) - 3));
          return `15min Warm up. Main: ${reps}×${repMin}min @ ${pwLabel(ftp, hasPower, 1.00)}, 4min recovery. 10min Cool down.`;
        },
        () => `15min Warm up. Main: 5×6min @ ${pwLabel(ftp, hasPower, 1.02)}, 3min recovery. 10min Cool down.`,
        () => `15min Warm up. Main: 2×15min @ ${pwLabel(ftp, hasPower, 0.98)}, 5min recovery. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'vo2': {
      const variants = [
        () => `20min Warm up. Main: ${minutes >= 60 ? 6 : 5}×3min @ ${pwLabel(ftp, hasPower, 1.15)}, 3min recovery. 10min Cool down.`,
        () => `20min Warm up. Main: 8×2min @ ${pwLabel(ftp, hasPower, 1.20)}, 2min recovery. 10min Cool down.`,
        () => `20min Warm up. Main: 4×4min @ ${pwLabel(ftp, hasPower, 1.12)}, 4min recovery. 10min Cool down.`,
      ];
      return variants[idx % variants.length]();
    }
    case 'hills': {
      const variants = [
        () => `20min Warm up. Main: ${minutes >= 60 ? 8 : 6}×2min climbs hard seated + 30s standing, 2min recovery. 10min Cool down.`,
        () => `20min Warm up. Main: 5×4min climbs @ ${pwLabel(ftp, hasPower, 0.95)}, 4min descend. 10min Cool down.`,
        () => `20min Warm up. Main: 10×30s max efforts on climb, 90s recovery. 10min Cool down.`,
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
  };
  const anaerobicShare: Record<BikeSessionKind, number> = {
    endurance: 0.05,
    tempo: 0.15,
    sweet_spot: 0.25,
    threshold: 0.40,
    vo2: 0.60,
    hills: 0.45,
  };
  const total = tssPerMin[kind] * minutes;
  return {
    aerobic: Math.round(total * (1 - anaerobicShare[kind])),
    anaerobic: Math.round(total * anaerobicShare[kind]),
  };
}
