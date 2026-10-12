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

import { paceSecPerKmForRunType, fmtDist } from './intent_to_workout';
import { fmtModelPaceKm } from '@/utils/format';

/** Ascending intensity ladder for the user's Adjust control (index 0 = easiest).
 *  Long runs step through their own sub-ladder below. Plan-change downgrades
 *  (timing check, cross-training suggester) use the canonical running ladder in
 *  constants/intensity-ladder.ts instead. */
export const INTENSITY_LADDER = ['easy', 'marathon', 'threshold', 'vo2'] as const;
export type LadderType = typeof INTENSITY_LADDER[number];

/** Expected RPE per run type for the Adjust control. Plan-change downgrades
 *  write the generator's RPE (RUN_GENERATOR_RPE, constants/intensity-ladder.ts). */
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
 *  0.75 = the maximum cross-training reduction tier (getTier, timing-check.ts). */
export const LESS_TIME_FACTOR = 0.75;

/** Markers that indicate a structured session (intervals, rep sets, pace-target
 *  blocks, warm-up/cool-down, an explicit minutes block). For these there is no
 *  single honest "distance", so the card headlines time only. */
const STRUCTURED_HINT = /\d\s*[x×]\s*\d|@|interval|\brep\b|\bWU\b|\bCD\b|warm\s*up|cool\s*down|\bmin\b/i;

/** A bare pace target appended to a distance run: "@ 6:10/km", "@ MP (4:55/km)",
 *  or the suggester's "@ 5:33/km (steady)" form. These don't make a session
 *  structured — "7km @ 6:10/km" is still a simple distance run. Mi variants are
 *  matched too since fmtDesc-converted strings occasionally round-trip. */
const PACE_TOKEN = /\s*@\s*(?:MP\s*\()?\d+:\d{2}\/(?:km|mi)\)?(?:\s*\((?:steady|easy|hard)\))?/gi;

/** Strip pace targets from a description, leaving the structural tokens. Used to
 *  classify simple-distance sessions and to render clean "Original: 8km" captions. */
export function stripPaceTokens(desc: string | undefined): string {
  return (desc ?? '').replace(PACE_TOKEN, '').replace(/\s{2,}/g, ' ').trim();
}

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
  // A pace target alone ("7km @ 6:10/km") doesn't make a run structured —
  // strip it before testing, so paced easy/long runs keep their km headline.
  const d = stripPaceTokens(desc);
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

// ── Intensity retargeting (descriptions stay truthful after Adjust) ──────────
// When the user steps a session Easier/Harder, the prescription numbers baked
// into the description must follow. Running paces come from the canonical
// RUN_PACE_FACTOR_VS_EASY map (intent_to_workout.ts) — the same factors
// generation uses. Bike watts scale by the intensity-ladder %FTP ratio; swim
// paces shift by the ladder's CSS-offset delta. No new constants.

// Model pace (from s.pac.e, unrounded): the whole second, as generation
// writes it (intent_to_workout), so an adjusted session reads the same pace.
const fmtPaceMSS = (sec: number) => fmtModelPaceKm(sec);

/**
 * Rewrite the work-pace targets in a running description for a new run type.
 * Handles the shapes our generators emit:
 *  - "7km @ 6:10/km"                        → pace replaced
 *  - "22min @ MP (4:55/km)"                 → MP label kept only for marathon
 *  - "5×6min @ 4:30/km (~1.3km), 1 min..."  → pace replaced, distance hint recomputed
 *  - "7km" (legacy, no pace)                → pace appended
 * Warm-up/cool-down paces ("(6:10/km+)") are easy-anchored and stay untouched.
 * Returns the description unchanged when the new type has no pace mapping or
 * easy pace is unknown.
 */
export function retargetDescriptionPace(desc: string, newType: string, easyPaceSecPerKm?: number): string {
  const paceSec = paceSecPerKmForRunType(newType, easyPaceSecPerKm);
  if (!paceSec || !desc) return desc;
  const isMp = newType === 'marathon' || newType === 'marathon_pace';
  const newLabel = isMp ? `MP (${fmtPaceMSS(paceSec)}/km)` : `${fmtPaceMSS(paceSec)}/km`;

  let out = desc;
  // Rep/continuous blocks with a distance hint: "6min @ 4:30/km (~1.3km)".
  // The hint is the rep duration at the work pace, so recompute it.
  out = out.replace(
    /(\d+(?:\.\d+)?)\s*min @ (?:MP\s*\()?\d+:\d{2}\/km\)?(?!\+)\s*\(~[^)]*\)/g,
    (_m, min) => `${min}min @ ${newLabel} (~${fmtDist(parseFloat(min), paceSec)})`,
  );
  // Remaining work-pace tokens, with or without the MP wrapper. A trailing
  // "(steady)"-style annotation from the suggester is dropped (it described
  // the old intensity). The triathlon generator writes its easy warm-up and
  // cool-down as "15min warm up @ 4:59/km"; those stay easy-anchored, like
  // the running generator's "(6:10/km+)" form.
  // No regex lookbehind: the app supports iOS 15 and WKWebView only parses
  // lookbehind from iOS 16.4, so one in a startup chunk blanks the app
  // (no-regex-lookbehind.test.ts). The warm-up / cool-down check reads the
  // text before each match instead.
  out = out.replace(
    /@\s*(?:MP\s*\()?\d+:\d{2}\/km\)?(?!\+)(\s*\((?:steady|easy|hard)\))?/g,
    (m: string, _ann: string | undefined, offset: number, str: string) =>
      /(?:[Ww]arm up|[Cc]ool down) $/.test(str.slice(Math.max(0, offset - 10), offset)) ? m : `@ ${newLabel}`,
  );
  // Legacy pace-less simple distance ("7km"): append the target.
  if (out === desc && !/@/.test(desc) && /^\s*\d+(?:\.\d+)?\s*km\s*$/i.test(desc)) {
    out = `${desc.trim()} @ ${newLabel}`;
  }
  return out;
}

/** The description a re-applied WorkoutMod should display. User-scale mods that
 *  changed intensity retarget their pace live from the current easy pace — this
 *  heals mods saved before paces were embedded in descriptions AND keeps an
 *  adjusted session's pace tracking marker updates, exactly like unadjusted
 *  sessions (which regenerate fresh every render). Non-user mods (timing /
 *  coach / auto) pass through untouched — their authors own their copy. */
export function modDisplayDescription(
  mod: { newDistance: string; newType?: string; userScaledAt?: string },
  easyPaceSecPerKm?: number,
): string;
export function modDisplayDescription(
  mod: { newDistance?: string; newType?: string; userScaledAt?: string },
  easyPaceSecPerKm?: number,
): string | undefined;
export function modDisplayDescription(
  mod: { newDistance?: string; newType?: string; userScaledAt?: string },
  easyPaceSecPerKm?: number,
): string | undefined {
  if (mod.newDistance && mod.userScaledAt && mod.newType) {
    return retargetDescriptionPace(mod.newDistance, mod.newType, easyPaceSecPerKm);
  }
  return mod.newDistance;
}

/**
 * Display-layer pace append for persisted simple-distance run descriptions that
 * predate pace embedding or were written by producers that only store distance:
 * ad-hoc sessions ("7km" objects in adhocWorkouts never regenerate), coach/auto
 * reductions ("4km (was 6.1km)"), km-nudge ("4km easy"). Returns the description
 * with the type's target pace appended — never mutates state, so the pace stays
 * live against the current easy pace. No-op when the description already carries
 * a target, isn't a simple distance shape, or the type has no pace mapping.
 */
export function displayDescWithPace(desc: string | undefined, type: string | undefined, easyPaceSecPerKm?: number): string {
  const d = (desc ?? '').trim();
  if (!d || !type) return d;
  if (/@|\d:\d{2}\//.test(d)) return d; // already carries a target
  const pace = paceSecPerKmForRunType(type, easyPaceSecPerKm);
  if (!pace) return d;
  // Simple distance shapes only: "7km", "4km easy", "4km (was 6.1km)".
  const m = /^(\d+(?:\.\d+)?\s*km)(\s+(?:easy|steady))?(\s*\(was [^)]+\))?$/i.exec(d);
  if (!m) return d;
  const isMp = type === 'marathon' || type === 'marathon_pace';
  const label = isMp ? `MP (${fmtPaceMSS(pace)}/km)` : `${fmtPaceMSS(pace)}/km`;
  return `${m[1]} @ ${label}${m[3] ?? ''}`;
}

/** Scale every "lo–hiW" watt range in a bike description by `ratio`
 *  (new rung %FTP ÷ original rung %FTP). Preserves the session's segment
 *  structure and per-kind tolerance band. */
export function scaleWattRanges(desc: string, ratio: number): string {
  if (!desc || !Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return desc;
  return desc.replace(/(\d+)–(\d+)\s*W/g, (_m, lo, hi) =>
    `${Math.round(parseInt(lo, 10) * ratio)}–${Math.round(parseInt(hi, 10) * ratio)}W`);
}

/** Replace every absolute "M:SS/100m" swim pace in a description with the
 *  target pace for the chosen intensity rung (CSS + the rung's offset). Direct
 *  replacement — not a relative shift — so the card always agrees with the
 *  detail modal's live Target line, which derives from the same rung. */
export function setSwimPaceTokens(desc: string, secPer100m: number): string {
  if (!desc || !Number.isFinite(secPer100m) || secPer100m <= 0) return desc;
  const sec = Math.round(secPer100m);
  const label = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}/100m`;
  // A trailing "(CSS)" annotation described the original pace — drop it, the
  // new pace is rung-relative, not CSS itself.
  return desc.replace(/\d+:\d{2}\/100m(\s*\(CSS\))?/g, label);
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
