import type { SimulatorState } from '@/types';
import type { TrainingPhase } from '@/types/training';
import { generateWeekWorkouts, calculateWorkoutLoad } from '@/workouts';

/**
 * Canonical "shape of the generated plan" derivations.
 *
 * Single source of truth for per-week prescribed running km, the phase
 * structure, and the session-type mix. Both the Stats forecast charts and the
 * onboarding "how your plan works" page read from here, so the numbers they
 * show can never diverge (the "two surfaces, one source" rule).
 *
 * Everything is derived from the REAL generated plan (`generateWeekWorkouts`
 * per week, keyed off each week's stored phase), never synthesised.
 */

/** Non-running workout types that don't count toward running volume. */
const NON_RUN_TYPES = new Set(['cross', 'strength', 'rest', 'gym']);

/** Parse running km from a workout description string ("12 km", "5 x 1 km", "8 x 400 m"). */
export function parseDistanceKm(d: string): number {
  if (!d) return 0;
  if (/^\d+min\s/i.test(d) && !d.includes('km')) return 0;
  const simple = d.match(/^(\d+(?:\.\d+)?)\s*km/i);
  if (simple) return parseFloat(simple[1]);
  const intKm = d.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*km/i);
  if (intKm) return parseInt(intKm[1]) * parseFloat(intKm[2]);
  const intM = d.match(/(\d+)\s*x\s*(\d+)\s*m\b/i);
  if (intM) return parseInt(intM[1]) * parseInt(intM[2]) / 1000;
  return 0;
}

/** Generate the actual prescribed workouts for one plan week (running mode). */
function generatePlanWeek(s: SimulatorState, wkIdx: number): ReturnType<typeof generateWeekWorkouts> {
  const wk = s.wks?.[wkIdx];
  if (!wk) return [];
  return generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities, s.onboarding?.experienceLevel,
    undefined, s.pac?.e, wkIdx + 1, s.tw, s.v, s.gs,
    undefined, undefined, undefined,
    s.onboarding?.weeklyTrainingHours, s.onboarding?.runningExcludedWorkouts,
  );
}

/**
 * Running km for one workout. Distance-stated runs ("16km @ ...") parse directly;
 * minute-prescribed quality work ("26min @ MP", "5×4min @ VO2") reports 0 km from
 * string parsing, so we convert its `estimatedDurationMin` to km at easy pace.
 * (Most of a quality session — warmup, cooldown, recoveries — runs easy; the work
 * portion is a touch faster, so this slightly under-counts, which is acceptable
 * and far better than counting it as zero.)
 */
export function plannedWorkoutKm(w: { d: string; estimatedDurationMin?: number }, easyPaceSecPerKm?: number): number {
  const explicit = parseDistanceKm(w.d);
  if (explicit > 0) return explicit;
  const mins = w.estimatedDurationMin ?? 0;
  if (mins > 0) return Math.round(mins * 60 / (easyPaceSecPerKm || 360));
  return 0;
}

/** Sum planned running km for a future week using the actual generated workouts. */
export function plannedWeekKm(s: SimulatorState, wkIdx: number): number {
  let km = 0;
  for (const w of generatePlanWeek(s, wkIdx)) {
    if (NON_RUN_TYPES.has(w.t)) continue;
    km += plannedWorkoutKm(w, s.pac?.e);
  }
  return km;
}

/** A run of consecutive same-phase weeks. */
export interface PhaseSegment {
  ph: TrainingPhase;
  weeks: number;
}

/** Consolidate the per-week phases into contiguous segments for a phase ribbon. */
export function planPhaseSegments(s: SimulatorState): PhaseSegment[] {
  const segs: PhaseSegment[] = [];
  for (const wk of s.wks ?? []) {
    const last = segs[segs.length - 1];
    if (last && last.ph === wk.ph) last.weeks++;
    else segs.push({ ph: wk.ph, weeks: 1 });
  }
  return segs;
}

/** Display buckets for the session-type mix. Threshold vs VO2 are kept distinct
 *  so the runner-type bias (more threshold for speed runners, more VO2 for
 *  endurance runners) is visible in the breakdown. */
const BUCKET_OF: Record<string, 'easy' | 'long' | 'tempo' | 'speed'> = {
  easy: 'easy', recovery: 'easy',
  long: 'long',
  threshold: 'tempo', marathon_pace: 'tempo', progressive: 'tempo', race_pace: 'tempo', float: 'tempo', mixed: 'tempo',
  vo2: 'speed', intervals: 'speed', hill_repeats: 'speed',
};
const BUCKET_LABEL: Record<string, string> = {
  easy: 'Easy & recovery',
  long: 'Long runs',
  tempo: 'Tempo & threshold',
  speed: 'Speed & VO2',
};
const BUCKET_ORDER = ['easy', 'long', 'tempo', 'speed'] as const;

export interface SessionBucket {
  key: string;
  label: string;
  count: number;
}

/** Session-type composition for one training phase. */
export interface PhaseMix {
  ph: TrainingPhase;
  buckets: SessionBucket[];  // counts of each type within this phase
  total: number;
}

/** Canonical bucket order + labels, exported so renderers share one legend. */
export const SESSION_BUCKETS = BUCKET_ORDER.map((key) => ({ key, label: BUCKET_LABEL[key] }));

/** The full shape of the generated plan, derived in a single pass over the weeks. */
export interface PlanShape {
  weeks: number;
  weeklyKm: number[];        // prescribed running km per week
  weeklyTss: number[];       // prescribed weekly training load (canonical TSS) — the honest
                             // volume currency (km under-counts minute-prescribed quality work)
  phasePerWeek: TrainingPhase[];
  peakKm: number;
  totalKm: number;
  peakTss: number;
  phases: PhaseSegment[];
  mix: SessionBucket[];      // session-type counts across the whole plan
  mixByPhase: PhaseMix[];    // session-type composition per phase (base→taper order of appearance)
}

export function derivePlanShape(s: SimulatorState): PlanShape {
  const n = s.wks?.length ?? 0;
  const weeklyKm: number[] = [];
  const weeklyTss: number[] = [];
  const phasePerWeek: TrainingPhase[] = [];
  const counts: Record<string, number> = {};
  // Per-phase bucket counts, keyed by phase, in order of first appearance.
  const phaseCounts = new Map<TrainingPhase, Record<string, number>>();
  const phaseOrder: TrainingPhase[] = [];

  for (let i = 0; i < n; i++) {
    const ph = s.wks![i].ph;
    if (!phaseCounts.has(ph)) { phaseCounts.set(ph, {}); phaseOrder.push(ph); }
    const pc = phaseCounts.get(ph)!;
    let km = 0;
    let tss = 0;
    for (const w of generatePlanWeek(s, i)) {
      // Training load (TSS) is the honest weekly currency: it counts minute-
      // prescribed quality work that km-parsing misses. Sum every session.
      tss += calculateWorkoutLoad(w.t, w.d, (w.r ?? 5) * 10, s.pac?.e).total;
      if (NON_RUN_TYPES.has(w.t)) continue;
      km += plannedWorkoutKm(w, s.pac?.e);
      const b = BUCKET_OF[w.t] ?? 'tempo';
      counts[b] = (counts[b] ?? 0) + 1;
      pc[b] = (pc[b] ?? 0) + 1;
    }
    weeklyKm.push(Math.round(km));
    weeklyTss.push(Math.round(tss));
    phasePerWeek.push(ph);
  }

  const toBuckets = (c: Record<string, number>): SessionBucket[] =>
    BUCKET_ORDER.filter((b) => (c[b] ?? 0) > 0).map((b) => ({ key: b, label: BUCKET_LABEL[b], count: c[b] }));

  const mix = toBuckets(counts);
  const mixByPhase: PhaseMix[] = phaseOrder.map((ph) => {
    const buckets = toBuckets(phaseCounts.get(ph)!);
    return { ph, buckets, total: buckets.reduce((a, b) => a + b.count, 0) };
  });

  return {
    weeks: n,
    weeklyKm,
    weeklyTss,
    phasePerWeek,
    peakKm: weeklyKm.length ? Math.max(...weeklyKm) : 0,
    totalKm: weeklyKm.reduce((a, b) => a + b, 0),
    peakTss: weeklyTss.length ? Math.max(...weeklyTss) : 0,
    phases: planPhaseSegments(s),
    mix,
    mixByPhase,
  };
}
