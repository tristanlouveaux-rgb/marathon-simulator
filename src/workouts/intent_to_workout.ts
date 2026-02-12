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

  // Derive actual paces from easy pace for readable descriptions
  const fmtPace = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const vo2PaceSec = easyPaceSecPerKm ? easyPaceSecPerKm * 0.809 : 0;
  const thresholdPaceSec = easyPaceSecPerKm ? easyPaceSecPerKm / 1.15 : 0;
  const vo2Pace = easyPaceSecPerKm ? fmtPace(vo2PaceSec) : null;   // ~VO2max/5K pace
  const thresholdPace = easyPaceSecPerKm ? fmtPace(thresholdPaceSec) : null;  // ~LT pace
  const mpPace = easyPaceSecPerKm ? fmtPace(easyPaceSecPerKm * 0.913) : null;     // ~Marathon pace
  const hmPace = easyPaceSecPerKm ? fmtPace(easyPaceSecPerKm * 0.87) : null;      // ~HM pace

  // Zone labels with actual pace when available
  const easyLabel = easyPaceSecPerKm ? `${fmtPace(easyPaceSecPerKm)}/km` : 'easy pace';
  const vo2Label = vo2Pace ? `${vo2Pace}/km` : 'VO2 pace';
  const thresholdLabel = thresholdPace ? `${thresholdPace}/km` : 'threshold';
  const mpLabel = mpPace ? `MP (${mpPace}/km)` : 'MP';
  const hmLabel = hmPace ? `HM pace (${hmPace}/km)` : 'HM pace';

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
          d: `${km}km: last ${fastKm} @ ${mpLabel}`,
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
        const mainSet = `${reps}×${fmtMin(repMinutes)}min @ ${thresholdLabel} (~${fmtDist(repMinutes, thresholdPaceSec)}), ${fmtMin(recoveryMinutes)} min recovery between sets`;
        const sessionMin = reps * repMinutes + (reps - 1) * recoveryMinutes;
        const wucd = wucdKm(sessionMin, easyPaceSecPerKm);
        return {
          t: 'threshold',
          n: nameForSlot(slot, intent),
          d: wucd ? `${wucd}km warm up (${easyLabel}+)\n${mainSet}\n${wucd}km cool down (${easyLabel}+)` : mainSet,
          r: 7,
          rpe: 7,
        };
      }
      const mainSet = `${workMinutes}min @ ${thresholdLabel} (~${fmtDist(workMinutes, thresholdPaceSec)})`;
      const wucd = wucdKm(workMinutes, easyPaceSecPerKm);
      return {
        t: 'threshold',
        n: nameForSlot(slot, intent),
        d: wucd ? `${wucd}km warm up (${easyLabel}+)\n${mainSet}\n${wucd}km cool down (${easyLabel}+)` : mainSet,
        r: 7,
        rpe: 7,
      };
    }

    case 'vo2': {
      if (reps && repMinutes && recoveryMinutes) {
        const mainSet = `${reps}×${fmtMin(repMinutes)}min @ ${vo2Label} (~${fmtDist(repMinutes, vo2PaceSec)}), ${fmtMin(recoveryMinutes)} min recovery between sets`;
        const sessionMin = reps * repMinutes + (reps - 1) * recoveryMinutes;
        const wucd = wucdKm(sessionMin, easyPaceSecPerKm);
        return {
          t: 'vo2',
          n: nameForSlot(slot, intent),
          d: wucd ? `${wucd}km warm up (${easyLabel}+)\n${mainSet}\n${wucd}km cool down (${easyLabel}+)` : mainSet,
          r: 8,
          rpe: 8,
        };
      }
      const mainSet = `${workMinutes}min @ ${vo2Label} (~${fmtDist(workMinutes, vo2PaceSec)})`;
      const wucd = wucdKm(workMinutes, easyPaceSecPerKm);
      return {
        t: 'vo2',
        n: nameForSlot(slot, intent),
        d: wucd ? `${wucd}km warm up (${easyLabel}+)\n${mainSet}\n${wucd}km cool down (${easyLabel}+)` : mainSet,
        r: 8,
        rpe: 8,
      };
    }

    case 'marathon_pace': {
      return {
        t: 'marathon_pace',
        n: 'Marathon Pace',
        d: `${workMinutes}min @ ${mpLabel}`,
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
        d: `${km}km: last ${workKm} @ ${mpLabel}`,
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

/** Warm-up/cool-down km (each side) to bring session to ≥30 min. Returns 0 if already ≥30. */
function wucdKm(sessionMinutes: number, easyPaceSecPerKm?: number): number {
  if (sessionMinutes >= 30 || !easyPaceSecPerKm) return 0;
  const deficitPerSide = (30 - sessionMinutes) / 2;
  const kmPerSide = deficitPerSide * 60 / easyPaceSecPerKm;
  return Math.ceil(kmPerSide);
}

/** Format distance from minutes at a given pace — e.g. "800m" or "3.2km" */
function fmtDist(minutes: number, paceSecPerKm: number): string {
  if (!paceSecPerKm) return '?';
  const km = minutes * 60 / paceSecPerKm;
  if (km < 1) return `${Math.round(km * 100) * 10}m`;
  const rounded = Math.round(km * 10) / 10;
  return `${rounded}km`;
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
