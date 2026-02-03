import type { Workout, RaceDistance, RunnerType } from '@/types';

/** Workout slot type for plan engine */
export type SlotType = 'easy' | 'long' | 'threshold' | 'vo2' | 'marathon_pace' | 'progressive';

/** Time-based session intent from plan engine */
export interface SessionIntent {
  dayIndex: number;
  slot: SlotType;
  totalMinutes: number;
  workMinutes: number;
  reps?: number;
  repMinutes?: number;
  recoveryMinutes?: number;
  variantId: string;
  notes: string;
}

/**
 * Convert a time-based SessionIntent into a Workout with a description string
 * that matches our existing parser formats (simple, time_at_pace, intervals_time, progressive).
 */
export function intentToWorkout(
  intent: SessionIntent,
  raceDistance: RaceDistance,
  runnerType: RunnerType,
  easyPaceSecPerKm?: number
): Workout {
  const { slot, totalMinutes, workMinutes, reps, repMinutes, recoveryMinutes, variantId } = intent;

  switch (slot) {
    case 'easy': {
      const km = minutesToKm(totalMinutes, easyPaceSecPerKm);
      return {
        t: 'easy',
        n: nameForSlot(slot, intent),
        d: `${km}km`,
        r: 3,
        rpe: 3,
      };
    }

    case 'long': {
      const km = minutesToKm(totalMinutes, easyPaceSecPerKm);
      // Fast-finish long run → progressive format
      if (variantId === 'long_fast_finish') {
        const fastKm = Math.max(2, Math.round(km * 0.2));
        return {
          t: 'progressive',
          n: 'Long Run (Fast Finish)',
          d: `${km}km: last ${fastKm} @ MP`,
          r: 5,
          rpe: 5,
        };
      }
      return {
        t: 'long',
        n: 'Long Run',
        d: `${km}km`,
        r: 3,
        rpe: 3,
      };
    }

    case 'threshold': {
      if (reps && repMinutes && recoveryMinutes) {
        // intervals_time format: "3×8min @ threshold, 2 minute break"
        return {
          t: 'threshold',
          n: nameForSlot(slot, intent),
          d: `${reps}×${fmtMin(repMinutes)}min @ threshold, ${fmtMin(recoveryMinutes)} minute break`,
          r: 7,
          rpe: 7,
        };
      }
      // continuous: time_at_pace format: "20min @ threshold"
      return {
        t: 'threshold',
        n: nameForSlot(slot, intent),
        d: `${workMinutes}min @ threshold`,
        r: 7,
        rpe: 7,
      };
    }

    case 'vo2': {
      if (reps && repMinutes && recoveryMinutes) {
        return {
          t: 'vo2',
          n: nameForSlot(slot, intent),
          d: `${reps}×${fmtMin(repMinutes)}min @ 5K, ${fmtMin(recoveryMinutes)} minute break`,
          r: 8,
          rpe: 8,
        };
      }
      return {
        t: 'vo2',
        n: nameForSlot(slot, intent),
        d: `${workMinutes}min @ 5K`,
        r: 8,
        rpe: 8,
      };
    }

    case 'marathon_pace': {
      return {
        t: 'marathon_pace',
        n: 'Marathon Pace',
        d: `${workMinutes}min @ MP`,
        r: 6,
        rpe: 6,
      };
    }

    case 'progressive': {
      const km = minutesToKm(totalMinutes, easyPaceSecPerKm);
      const workKm = Math.max(2, Math.round(minutesToKm(workMinutes, easyPaceSecPerKm)));
      return {
        t: 'progressive',
        n: 'Progressive Run',
        d: `${km}km: last ${workKm} @ MP`,
        r: 5,
        rpe: 5,
      };
    }

    default: {
      const km = minutesToKm(totalMinutes, easyPaceSecPerKm);
      return {
        t: 'easy',
        n: 'Easy Run',
        d: `${km}km`,
        r: 3,
        rpe: 3,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert minutes to km using easy pace (default ~6:00/km = 360s/km) */
function minutesToKm(minutes: number, easyPaceSecPerKm?: number): number {
  const paceSecPerKm = easyPaceSecPerKm || 360;
  return Math.round(minutes * 60 / paceSecPerKm);
}

/** Format minutes — drop decimal if integer */
function fmtMin(m: number): string {
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
}

/** Generate a workout name from slot + variant */
function nameForSlot(slot: SlotType, intent: SessionIntent): string {
  switch (slot) {
    case 'easy': return 'Easy Run';
    case 'long': return 'Long Run';
    case 'threshold': {
      if (intent.reps) return `Threshold ${intent.reps}×${fmtMin(intent.repMinutes!)}`;
      return 'Threshold Tempo';
    }
    case 'vo2': {
      if (intent.reps) return `VO2 Builder ${intent.reps}×${fmtMin(intent.repMinutes!)}`;
      return 'VO2 Builder';
    }
    case 'marathon_pace': return 'Marathon Pace';
    case 'progressive': return 'Progressive Run';
    default: return 'Run';
  }
}
