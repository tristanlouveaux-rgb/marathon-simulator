import type { Workout, Paces } from '@/types';
import { getPaceForZone } from '@/calculations/paces';

export type StepType =
  | 'warmup'
  | 'work'
  | 'recovery'
  | 'cooldown'
  | 'easy'
  | 'long';

export interface Step {
  idx: number;
  type: StepType;
  label: string;
  durationSec?: number;
  distanceM?: number;
  targetPaceSec?: number;
  targetZone?: string;
  repIdx?: number;
  repTotal?: number;
  /** Original durationSec before any user extensions — set lazily by the engine on first extend. */
  originalDurationSec?: number;
  /**
   * Optional role tag for steps that belong to a composed pattern. Currently
   * used to mark the two halves of a progressive run so downstream consumers
   * (e.g. SplitScheme) can emit pattern-specific labels without re-sniffing
   * the step shape.
   */
  role?: 'progressive-easy' | 'progressive-fast';
}

export interface Timeline {
  steps: Step[];
  totalDurationSec: number;
  totalDistanceM: number;
  workoutType: string;
  isStructured: boolean;
}

interface MainSet {
  steps: Omit<Step, 'idx'>[];
  isStructured: boolean;
}

function zoneLabel(zone: string): string {
  const z = zone.toLowerCase();
  const map: Record<string, string> = {
    easy: 'Easy',
    e: 'Easy',
    threshold: 'Threshold',
    tempo: 'Tempo',
    t: 'Threshold',
    '5k': '5K',
    i: '5K',
    r: 'Repetition',
    '10k': '10K',
    hm: 'Half marathon',
    mp: 'Marathon',
    m: 'Marathon',
  };
  return map[z] ?? zone;
}

function parseDistanceToMeters(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u === 'm') return value;
  if (u === 'mi') return value * 1609;
  if (u === 'km' || u === 'k') return value * 1000;
  return value;
}

/**
 * Resolve a pace zone name OR a literal "m:ss/km" pace string to sec/km.
 * e.g. "4:49/km" → 289, "threshold" → paces.t, "MP" → paces.m.
 */
function resolvePace(token: string, paces: Paces): number {
  const literal = token.match(/^(\d+):(\d{2})(?:\/km)?$/);
  if (literal) return parseInt(literal[1]) * 60 + parseInt(literal[2]);
  return getPaceForZone(token, paces);
}

/** Strip a trailing "(...)" parenthetical (e.g. "(~790m)") off a zone token. */
function stripParen(token: string): string {
  return token.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function parseMainSet(desc: string, paces: Paces): MainSet {
  const line = desc.trim();

  const intervalDist = line.match(
    /^(\d+)×(\d+\.?\d*)(m|mi|km|k)?\s*@\s*([\w\-]+),?\s*(\d+)(?:-(\d+))?\s*(s|min)?/i,
  );
  if (intervalDist) {
    const reps = parseInt(intervalDist[1]);
    const dist = parseFloat(intervalDist[2]);
    const unit = intervalDist[3] ?? 'm';
    const zone = intervalDist[4];
    const restA = parseInt(intervalDist[5]);
    const restB = intervalDist[6] ? parseInt(intervalDist[6]) : restA;
    const restUnit = intervalDist[7] ?? 's';
    const distPerRep = parseDistanceToMeters(dist, unit);
    const pace = getPaceForZone(zone, paces);
    const restSec = ((restA + restB) / 2) * (restUnit === 'min' ? 60 : 1);

    const steps: Omit<Step, 'idx'>[] = [];
    for (let i = 1; i <= reps; i++) {
      steps.push({
        type: 'work',
        label: `${zoneLabel(zone)} rep ${i} of ${reps}`,
        distanceM: distPerRep,
        targetPaceSec: pace,
        targetZone: zone,
        repIdx: i,
        repTotal: reps,
      });
      if (i < reps && restSec > 0) {
        steps.push({
          type: 'recovery',
          label: `Recovery ${i} of ${reps - 1}`,
          durationSec: restSec,
          targetZone: 'easy',
          targetPaceSec: paces.e,
          repIdx: i,
          repTotal: reps - 1,
        });
      }
    }
    return { steps, isStructured: true };
  }

  // Time-based intervals. Zone token accepts either a word ("threshold") or a
  // literal pace ("4:49/km"). An optional "(~790m)" parenthetical between the
  // zone and the recovery value is tolerated so we can parse descriptions
  // emitted by intent_to_workout. Recovery trailer may be bare ("90s"/"2min")
  // or "... min recovery between sets".
  const intervalTime = line.match(
    /^(\d+)×(\d+\.?\d*)min\s*@\s*([\w\-:./]+)\s*(?:\([^)]*\))?,?\s*(\d+\.?\d*)\s*(min|s)/i,
  );
  if (intervalTime) {
    const reps = parseInt(intervalTime[1]);
    const workMin = parseFloat(intervalTime[2]);
    const zone = intervalTime[3];
    const restVal = parseFloat(intervalTime[4]);
    const restUnit = intervalTime[5].toLowerCase();
    const restSec = restUnit === 'min' ? restVal * 60 : restVal;
    const pace = resolvePace(zone, paces);

    const steps: Omit<Step, 'idx'>[] = [];
    for (let i = 1; i <= reps; i++) {
      steps.push({
        type: 'work',
        label: `${zoneLabel(zone)} rep ${i} of ${reps}`,
        durationSec: workMin * 60,
        targetPaceSec: pace,
        targetZone: zone,
        repIdx: i,
        repTotal: reps,
      });
      if (i < reps && restSec > 0) {
        steps.push({
          type: 'recovery',
          label: `Recovery ${i} of ${reps - 1}`,
          durationSec: restSec,
          targetZone: 'easy',
          targetPaceSec: paces.e,
          repIdx: i,
          repTotal: reps - 1,
        });
      }
    }
    return { steps, isStructured: true };
  }

  const longInterval = line.match(/^(\d+)×(\d+\.?\d*)km\s*@\s*(\w+),?\s*(\d+)min/i);
  if (longInterval) {
    const reps = parseInt(longInterval[1]);
    const distKm = parseFloat(longInterval[2]);
    const zone = longInterval[3];
    const restMin = parseInt(longInterval[4]);
    const pace = getPaceForZone(zone, paces);

    const steps: Omit<Step, 'idx'>[] = [];
    for (let i = 1; i <= reps; i++) {
      steps.push({
        type: 'work',
        label: `${zoneLabel(zone)} rep ${i} of ${reps}`,
        distanceM: distKm * 1000,
        targetPaceSec: pace,
        targetZone: zone,
        repIdx: i,
        repTotal: reps,
      });
      if (i < reps && restMin > 0) {
        steps.push({
          type: 'recovery',
          label: `Recovery ${i} of ${reps - 1}`,
          durationSec: restMin * 60,
          targetZone: 'easy',
          targetPaceSec: paces.e,
          repIdx: i,
          repTotal: reps - 1,
        });
      }
    }
    return { steps, isStructured: true };
  }

  const timeAtExplicit = line.match(/^(\d+)min\s*@\s*(\d+):(\d+)\/km/i);
  if (timeAtExplicit) {
    const minutes = parseInt(timeAtExplicit[1]);
    const pace = parseInt(timeAtExplicit[2]) * 60 + parseInt(timeAtExplicit[3]);
    return {
      steps: [
        {
          type: 'work',
          label: `${minutes} minutes at target pace`,
          durationSec: minutes * 60,
          targetPaceSec: pace,
        },
      ],
      isStructured: true,
    };
  }

  // Continuous time @ pace/zone. Accepts zone words or literal paces, and
  // tolerates an optional trailing parenthetical (e.g. "(~3.2km)").
  const timeAtPace = line.match(/^(\d+)min\s*@\s*([\w\-:./]+(?:\s*\([^)]*\))?)/i);
  if (timeAtPace) {
    const minutes = parseInt(timeAtPace[1]);
    const zone = stripParen(timeAtPace[2]);
    const pace = resolvePace(zone, paces);
    const label = /^\d+:\d{2}/.test(zone)
      ? `${minutes} min at ${zone}`
      : `${minutes} min ${zoneLabel(zone).toLowerCase()}`;
    return {
      steps: [
        {
          type: 'work',
          label,
          durationSec: minutes * 60,
          targetPaceSec: pace,
          targetZone: zone,
        },
      ],
      isStructured: true,
    };
  }

  const progressive = line.match(/^(\d+\.?\d*)km:?\s*last\s*(\d+\.?\d*)\s*@\s*(\w+)/i);
  if (progressive) {
    const totalKm = parseFloat(progressive[1]);
    const fastKm = parseFloat(progressive[2]);
    const zone = progressive[3];
    const easyKm = totalKm - fastKm;
    return {
      steps: [
        {
          type: 'easy',
          label: `Easy ${easyKm} km`,
          distanceM: easyKm * 1000,
          targetPaceSec: paces.e,
          targetZone: 'easy',
          role: 'progressive-easy',
        },
        {
          type: 'work',
          label: `Last ${fastKm} km at ${zoneLabel(zone).toLowerCase()}`,
          distanceM: fastKm * 1000,
          targetPaceSec: getPaceForZone(zone, paces),
          targetZone: zone,
          role: 'progressive-fast',
        },
      ],
      isStructured: true,
    };
  }

  // Distance @ pace/zone. Accepts zone words or literal paces.
  const distAtPace = line.match(/^(\d+\.?\d*)km\s*@\s*([\w\-:./]+)/i);
  if (distAtPace) {
    const km = parseFloat(distAtPace[1]);
    const zone = distAtPace[2];
    const label = /^\d+:\d{2}/.test(zone)
      ? `${km} km at ${zone}`
      : `${km} km at ${zoneLabel(zone).toLowerCase()}`;
    return {
      steps: [
        {
          type: 'work',
          label,
          distanceM: km * 1000,
          targetPaceSec: resolvePace(zone, paces),
          targetZone: zone,
        },
      ],
      isStructured: true,
    };
  }

  const mixedSegments = Array.from(line.matchAll(/(\d+\.?\d*)@(\w+)/gi));
  if (mixedSegments.length > 1) {
    const steps: Omit<Step, 'idx'>[] = mixedSegments.map((m) => {
      const km = parseFloat(m[1]);
      const zone = m[2];
      return {
        type: 'work',
        label: `${km} km at ${zoneLabel(zone).toLowerCase()}`,
        distanceM: km * 1000,
        targetPaceSec: getPaceForZone(zone, paces),
        targetZone: zone,
      };
    });
    return { steps, isStructured: true };
  }

  const modified = line.match(/^(\d+\.?\d*)km\s*\(was/i);
  if (modified) {
    const km = parseFloat(modified[1]);
    return {
      steps: [
        {
          type: 'easy',
          label: `${km} km easy`,
          distanceM: km * 1000,
          targetPaceSec: paces.e,
          targetZone: 'easy',
        },
      ],
      isStructured: false,
    };
  }

  // "8km", "8km easy", "5km warmup jog" — an unstructured easy run. The
  // trailing descriptor words (if any) are purely prose and don't change
  // semantics; we always pace at easy.
  const simple = line.match(/^(\d+\.?\d*)km(?:\s+[\w\s]+)?$/i);
  if (simple) {
    const km = parseFloat(simple[1]);
    const isLong = km >= 18;
    return {
      steps: [
        {
          type: isLong ? 'long' : 'easy',
          label: isLong ? `Long run ${km} km` : `${km} km easy`,
          distanceM: km * 1000,
          targetPaceSec: paces.e,
          targetZone: 'easy',
        },
      ],
      isStructured: false,
    };
  }

  return { steps: [], isStructured: false };
}

function parseWarmupCooldownKm(line: string): number | null {
  const match = line.match(/^(\d+\.?\d*)km/);
  return match ? parseFloat(match[1]) : null;
}

function stepDuration(step: Omit<Step, 'idx'>): number {
  if (step.durationSec != null) return step.durationSec;
  if (step.distanceM != null && step.targetPaceSec != null) {
    return (step.distanceM / 1000) * step.targetPaceSec;
  }
  return 0;
}

function stepDistance(step: Omit<Step, 'idx'>): number {
  if (step.distanceM != null) return step.distanceM;
  if (step.durationSec != null && step.targetPaceSec != null) {
    return (step.durationSec / step.targetPaceSec) * 1000;
  }
  return 0;
}

/**
 * Build a Timeline from a raw workout description string. Convenience wrapper
 * around `buildTimeline` for callers that only have a description (e.g. the
 * SplitScheme adapter) and don't otherwise need a Workout object.
 */
export function buildTimelineFromDesc(desc: string, paces: Paces): Timeline {
  return buildTimeline({ n: '', d: desc, r: 0, t: 'structured' }, paces);
}

export function buildTimeline(workout: Workout, paces: Paces): Timeline {
  const desc = (workout.d ?? '').trim();
  const rawSteps: Omit<Step, 'idx'>[] = [];
  let isStructured = false;

  const lines = desc.split('\n').map((l) => l.trim()).filter(Boolean);
  const hasWarmup = lines.length >= 2 && /warm\s*up/i.test(lines[0]);
  const hasCooldown = lines.length >= 2 && /cool\s*down/i.test(lines[lines.length - 1]);

  if (hasWarmup) {
    const wuKm = parseWarmupCooldownKm(lines[0]);
    if (wuKm != null && wuKm > 0) {
      rawSteps.push({
        type: 'warmup',
        label: `Warmup ${wuKm} km easy`,
        distanceM: wuKm * 1000,
        targetPaceSec: paces.e,
        targetZone: 'easy',
      });
    }
  }

  const mainLine = hasWarmup || hasCooldown
    ? lines.slice(hasWarmup ? 1 : 0, hasCooldown ? -1 : undefined).join(' ')
    : desc;

  const main = parseMainSet(mainLine, paces);
  rawSteps.push(...main.steps);
  isStructured = main.isStructured || rawSteps.length > 1;

  if (hasCooldown) {
    const cdKm = parseWarmupCooldownKm(lines[lines.length - 1]);
    if (cdKm != null && cdKm > 0) {
      rawSteps.push({
        type: 'cooldown',
        label: `Cooldown ${cdKm} km easy`,
        distanceM: cdKm * 1000,
        targetPaceSec: paces.e,
        targetZone: 'easy',
      });
    }
  }

  const steps: Step[] = rawSteps.map((s, i) => ({ ...s, idx: i }));
  const totalDurationSec = steps.reduce((acc, s) => acc + stepDuration(s), 0);
  const totalDistanceM = steps.reduce((acc, s) => acc + stepDistance(s), 0);

  return {
    steps,
    totalDurationSec,
    totalDistanceM,
    workoutType: workout.t,
    isStructured,
  };
}
