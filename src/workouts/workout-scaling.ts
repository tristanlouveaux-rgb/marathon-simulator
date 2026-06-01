/**
 * User-initiated per-workout scaling (running).
 *
 * Pure helpers behind the "Adjust" control on running workout cards. The user
 * scales a single session — shorter/longer duration, or easier/harder
 * intensity — for THIS session only. The result is persisted as a `WorkoutMod`
 * (see coach-tools.ts for the AI equivalent) which plan-view re-applies on every
 * render.
 *
 * Scaling model: a single scale factor in [0.50, 1.15] is applied to the WHOLE
 * session — every distance (km / m) and duration (min) token in the description
 * scales by the same factor, and so does the session's total minutes. Paces
 * (e.g. "3:52/km") are left untouched, since the point is to shrink/grow the
 * session, not re-pace it. This "scale everything proportionally" rule (confirmed
 * with Tristan, 2026-05-29) means the duration knob works for structured sessions
 * (tempo / intervals) too, not only simple distance runs.
 *
 * Scope: PLANNING side. It changes the prescription for one session. It never
 * recomputes the plan, weekly load targets, or the race prediction. Fitness/
 * prediction respond only to the activity the user actually completes (tracking).
 * Because the scaled session becomes the live `w.d` + `estimatedDurationMin`,
 * distance/time-based running adherence scores against the scaled target, not the
 * original — a deliberately trimmed run never reads as a "miss". The original is
 * preserved on the mod for display.
 *
 * Every constant here is anchored to an existing value in the codebase. None are
 * invented (per CLAUDE.md "No Made-Up Numbers").
 */

/** Ascending intensity ladder. Mirrors PACE_LADDER in cross-training/timing-check.ts:37
 *  (index 0 = easiest). Long runs step through their own sub-ladder below. */
export const INTENSITY_LADDER = ['easy', 'marathon', 'threshold', 'vo2'] as const;
export type LadderType = typeof INTENSITY_LADDER[number];

/** Expected RPE per run type. Identical to RPE_BY_TYPE in timing-check.ts:40-42. */
export const RPE_BY_TYPE: Record<string, number> = {
  easy: 4, marathon: 6, threshold: 7, vo2: 9, long: 6,
};

/** Scale-factor bounds, as a fraction of the prescribed session.
 *  Floor 0.50 is anchored to the taper long-run multiplier (~0.5, plan_engine.ts).
 *  Ceiling 1.15 is anchored to the effortMultiplier ceiling (1.15, plan_engine.ts).
 *  Confirmed with Tristan 2026-05-29. */
export const DURATION_SCALE_MIN = 0.50;
export const DURATION_SCALE_MAX = 1.15;

/** "Less time" preset target, as a fraction of prescribed.
 *  0.75 = the maximum cross-training reduction tier (getTier, timing-check.ts:65). */
export const LESS_TIME_FACTOR = 0.75;

/** Markers that indicate a structured session (intervals, rep sets, pace-target
 *  blocks, warm-up/cool-down, an explicit minutes block). For these there is no
 *  single honest "distance", so the card headlines time only. */
const STRUCTURED_HINT = /\d\s*[x×]\s*\d|@|interval|\brep\b|\bWU\b|\bCD\b|warm\s*up|cool\s*down|\bmin\b/i;

const clampFactor = (f: number) => Math.max(DURATION_SCALE_MIN, Math.min(DURATION_SCALE_MAX, f));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Parse the leading "<n>km" distance from a description. Returns null when there
 *  is no km token (e.g. a metres-only or minutes-only session). */
export function parseDistanceKm(desc: string | undefined): number | null {
  const m = /(\d+(?:\.\d+)?)\s*km/i.exec(desc ?? '');
  if (!m) return null;
  const km = parseFloat(m[1]);
  return Number.isFinite(km) && km > 0 ? km : null;
}

/** True when the description carries at least one token we can scale (km, min, or
 *  bare metres). Practically always true for a real run; false for an empty or
 *  pace-only string. */
export function hasScalableToken(desc: string | undefined): boolean {
  const d = desc ?? '';
  return /(\d+(?:\.\d+)?)\s*km/i.test(d)
    || /(\d+(?:\.\d+)?)\s*min/i.test(d)
    || /(\d+(?:\.\d+)?)\s*m(?![a-zA-Z])/.test(d);
}

/** Whether duration scaling applies. Now true for any session with a scalable
 *  token — including structured tempo/interval sessions, which scale
 *  proportionally. (Previously this gated structured sessions out.) */
export function supportsDurationScale(desc: string | undefined): boolean {
  return hasScalableToken(desc);
}

/** Whether the session reads primarily as a single distance (easy / long / MP /
 *  recovery), so the card can show "X km · Y min". Structured sessions
 *  (intervals, pace blocks, WU/CD, explicit minutes) return false and headline
 *  time only — this is what prevents a tempo from mis-displaying its warm-up
 *  distance ("2.0 km") as the whole session. */
export function isSimpleDistanceDesc(desc: string | undefined): boolean {
  const d = desc ?? '';
  if (STRUCTURED_HINT.test(d)) return false;
  return /^\s*\d+(?:\.\d+)?\s*km\b/i.test(d);
}

/** Scale every distance (km / bare metres) and duration (min) token in a
 *  description by `factor`, leaving paces (e.g. "3:52/km", "4:39/km+") untouched.
 *  This is the proportional "scale everything" rule. */
export function scaleDescriptionProportional(desc: string, factor: number): string {
  const f = clampFactor(factor);
  return (desc ?? '')
    .replace(/(\d+(?:\.\d+)?)\s*km/gi, (_m, n) => `${round1(parseFloat(n) * f)}km`)
    .replace(/(\d+(?:\.\d+)?)\s*min/gi, (_m, n) => `${Math.max(1, Math.round(parseFloat(n) * f))}min`)
    .replace(/(\d+(?:\.\d+)?)\s*m(?![a-zA-Z])/g, (_m, n) => `${Math.max(1, Math.round(parseFloat(n) * f))}m`);
}

/** Scale a total-minutes figure by `factor` (clamped), rounded to whole minutes. */
export function scaleDurationMin(baseMin: number, factor: number): number {
  return Math.max(1, Math.round(baseMin * clampFactor(factor)));
}

/** Step a run type one notch easier or harder along the ladder. Long runs are
 *  handled by their own sub-ladder: easier long -> 'easy'; there is no harder
 *  notch above a long run. Types not on the ladder are returned unchanged. */
export function stepIntensity(type: string, dir: 'easier' | 'harder'): string {
  if (type === 'long') {
    return dir === 'easier' ? 'easy' : 'long';
  }
  const idx = INTENSITY_LADDER.indexOf(type as LadderType);
  if (idx < 0) return type;
  const next = dir === 'easier' ? idx - 1 : idx + 1;
  if (next < 0 || next >= INTENSITY_LADDER.length) return type; // at a ladder end
  return INTENSITY_LADDER[next];
}

/** True when this run type can step further in the given direction. Used to
 *  disable the Easier/Harder buttons at the ladder ends. */
export function canStepIntensity(type: string, dir: 'easier' | 'harder'): boolean {
  return stepIntensity(type, dir) !== type;
}

/** Minimal shape a WorkoutMod needs for matching (avoids a type import here). */
interface ModKey { workoutId?: string; name: string; dayOfWeek?: number }

/** Find the regenerated workout a (non-timing) mod targets.
 *
 *  Running workouts are rebuilt every render and `assignDefaultDays` reshuffles
 *  `dayOfWeek` whenever the week's set changes between sessions, so matching on
 *  (name, dayOfWeek) loses the mod and a user's Adjust reverts. The stable slot
 *  `id` (`W{week}-{type}-{idx}`) survives that reshuffle, so it is the primary
 *  key. name+dayOfWeek remains as a fallback for mods written before the id was
 *  stored, and for cases where the id genuinely changed (run count shifted).
 *
 *  Single source of truth for every render-time mod re-application site
 *  (plan-view computeRenderedWorkouts, the today card, the km-nudge recompute). */
export function findWorkoutForMod<T extends { id?: string; n?: string; dayOfWeek?: number }>(
  workouts: T[], mod: ModKey,
): T | undefined {
  if (mod.workoutId) {
    const byId = workouts.find(w => w.id === mod.workoutId);
    if (byId) return byId;
  }
  return workouts.find(w => w.n === mod.name && (mod.dayOfWeek == null || w.dayOfWeek === mod.dayOfWeek));
}
