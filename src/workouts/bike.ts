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

  const desc = describeBikeSession(kind, targetMinutes, ftp, hasPowerMeter);
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

function describeBikeSession(
  kind: BikeSessionKind,
  minutes: number,
  ftp: number | undefined,
  hasPower: boolean | undefined
): string {
  const pw = (pct: number) => ftp ? `${Math.round(ftp * pct)}W` : `${Math.round(pct * 100)}% FTP`;
  const hr = (zone: string) => ` (HR Z${zone})`;
  const usePower = !!hasPower && !!ftp;

  switch (kind) {
    case 'endurance': {
      // Z2 steady
      const tgt = usePower ? `${pw(0.65)}` : `Z2 endurance${hr('2')}`;
      return `${minutes}min steady @ ${tgt}. Conversational effort.`;
    }
    case 'tempo': {
      // Z3 continuous or long blocks
      const reps = minutes >= 75 ? 2 : 1;
      const repMin = Math.round((minutes - 20) / reps);
      const tgt = usePower ? `${pw(0.82)}` : `tempo${hr('3')}`;
      return `15min WU, ${reps}×${repMin}min @ ${tgt}, 5min CD.`;
    }
    case 'sweet_spot': {
      // 88-94% FTP, manageable stimulus
      const mainMin = minutes - 20;
      const reps = mainMin >= 40 ? 3 : mainMin >= 24 ? 2 : 1;
      const repMin = Math.round(mainMin / reps) - 2;  // account for recoveries
      const tgt = usePower ? `${pw(0.90)}` : `sweet spot (88-94%)`;
      return `15min WU, ${reps}×${repMin}min @ ${tgt}, 5min rec between, 5min CD.`;
    }
    case 'threshold': {
      const reps = minutes >= 75 ? 3 : 2;
      const repMin = Math.round((minutes - 25) / reps) - 3;
      const tgt = usePower ? `${pw(1.00)}` : `threshold${hr('4')}`;
      return `15min WU, ${reps}×${repMin}min @ ${tgt}, 4min rec between, 10min CD.`;
    }
    case 'vo2': {
      const reps = minutes >= 60 ? 6 : 5;
      const repMin = 3;
      const tgt = usePower ? `${pw(1.15)}` : `VO2 pace${hr('5')}`;
      return `20min WU, ${reps}×${repMin}min @ ${tgt}, 3min rec between, 10min CD.`;
    }
    case 'hills': {
      const reps = minutes >= 60 ? 8 : 6;
      return `20min WU, ${reps}×2min climbs hard seated + 30s standing, 2min rec, 10min CD.`;
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
