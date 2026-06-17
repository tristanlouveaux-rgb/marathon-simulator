/**
 * ACWR ease-back — the "intelligent load reduction" applied when an athlete
 * chooses to wind down a week whose acute:chronic workload ratio has run hot
 * (ISSUE-295, 2026-06-17 decision with Tristan).
 *
 * The science. ACWR = acute ÷ chronic load, both canonical TSS (the Load
 * Currency Law). The safe ceiling is tier-specific and already sourced
 * (`TIER_ACWR_CONFIG.safeUpper`, Gabbett 2016 sweet-spot + Hulin 2016 chronic-
 * load protection). Chronic is the 28-day weekly-average TSS, and the upcoming
 * week IS essentially the acute window, so the most load we can plan next week
 * while holding ACWR at the ceiling is:
 *
 *     L_max  = safeUpper × chronic            (weekly TSS)
 *     shed   = standardWeekTSS − L_max        (TSS we must remove)
 *
 * The only constant is `safeUpper`, which already exists and is already
 * justified — the cut is exactly as large as the overshoot, nothing invented.
 *
 * The ladder (Tristan, 2026-06-17). Shed the most injury-relevant load first,
 * protect the goal-relevant stimulus last:
 *   1. Strip intensity — convert quality sessions (and a fast-finish long run's
 *      speed) to easy, keeping every distance. This removes the quality TSS
 *      premium, the part that actually spikes acute load, without touching
 *      weekly volume or the long-run endurance stimulus.
 *   2. Trim easy / midweek volume — only if stripping all intensity still
 *      leaves the week over L_max. The long run is untouched here.
 *   3. Reduce the long run distance — last resort, only if 1 + 2 are exhausted.
 *      Bottom of the pile: protected relative to everything else, not sacrosanct.
 *
 * Known limitation: the TSS model values a session by duration × its type rate
 * (`plannedTssPerMin`). It does not separately price a fast-finish long run's
 * surge, so downgrading the long run's speed in step 1 is an injury-risk action
 * that the model scores as ~0 TSS. The dominant ACWR-driving load (quality work
 * + total volume) is captured exactly; the long-run finish surge is a smaller
 * second-order effect addressed qualitatively. See SCIENCE_LOG §CF.
 */
import { plannedTssPerMin } from '@/constants';
import type { SessionIntent, SlotType } from '@/workouts/intent_to_workout';

/** ACWR ratio at/above which a prior keep-ramping choice is overridden and the choice re-raised.
 *  Tristan's absolute call (2026-06-17): "1.6 and up is very high." Sits on top of the tier-relative
 *  `high` band (safeUpper + 0.2). */
export const VERY_HIGH_ACWR = 1.6;
/** Consecutive high-ACWR weeks after which a prior keep choice is re-raised. Tristan: "3 back to back". */
export const ACWR_HIGH_STREAK_REPROMPT = 3;

export interface AcwrEpisodeDecision {
  /** Choice to stamp on the upcoming high week: a carried prior choice, or undefined (safe default + re-prompt). */
  acwrChoice: 'keep' | 'ease' | undefined;
  /** True when the week is very high or the streak is sustained — clear any prior keep and re-raise firmly. */
  forceReprompt: boolean;
  /** Count of consecutive high weeks ending at (and including) the upcoming week. */
  consecutiveHigh: number;
}

/**
 * Decide a high-ACWR week's ease-back choice + escalation (ISSUE-295). Only call when the upcoming
 * week is itself high. Carries a prior choice forward across an episode so the athlete is not
 * re-nagged every week, UNLESS the week is very high (ratio ≥ VERY_HIGH_ACWR) or this is the
 * ACWR_HIGH_STREAK_REPROMPT-th consecutive high week — then the choice is cleared so the safe
 * (eased) default returns and the debrief re-surfaces it firmly. Pure.
 *
 * @param priorStatuses scheduledAcwrStatus of the weeks BEFORE the upcoming one, in plan order (most recent last).
 * @param upcomingRatio the upcoming week's ACWR ratio.
 * @param prevChoice the immediately-preceding week's acwrChoice.
 */
export function resolveAcwrEpisodeChoice(
  priorStatuses: Array<string | undefined>,
  upcomingRatio: number,
  prevChoice: 'keep' | 'ease' | undefined,
): AcwrEpisodeDecision {
  let consecutiveHigh = 1; // the upcoming week is high by precondition
  for (let i = priorStatuses.length - 1; i >= 0; i--) {
    if (priorStatuses[i] === 'high') consecutiveHigh++;
    else break;
  }
  const forceReprompt = upcomingRatio >= VERY_HIGH_ACWR || consecutiveHigh >= ACWR_HIGH_STREAK_REPROMPT;
  const acwrChoice = !forceReprompt && prevChoice ? prevChoice : undefined;
  return { acwrChoice, forceReprompt, consecutiveHigh };
}

/** Slots that carry intensity above easy aerobic running. */
const QUALITY_SLOTS: ReadonlySet<SlotType> = new Set<SlotType>([
  'threshold', 'vo2', 'marathon_pace', 'progressive', 'float',
]);

/** Long-run variant ids that carry a speed surge (downgraded to steady on ease-back). */
const FAST_LONG_VARIANTS: ReadonlySet<string> = new Set(['long_fast_finish']);

export interface AcwrEaseBackOpts {
  /** 28-day weekly-average TSS (chronic load). */
  chronicWeeklyTSS: number;
  /** Tier ACWR ceiling, after any personal-recovery shift (getEffectiveSafeUpper). */
  safeUpper: number;
  /** Minimum easy-run minutes (plan_engine EASY_FLOOR_MIN). */
  easyFloorMin: number;
  /** Minimum long-run minutes (plan_engine LONG_SOFT_FLOOR_MIN). */
  longFloorMin: number;
}

export interface AcwrEaseBackResult {
  /** Eased-back intents (copies — inputs are never mutated). */
  intents: SessionIntent[];
  /** safeUpper × chronic — the week's TSS ceiling. */
  lMax: number;
  /** TSS of the unmodified (standard) week. */
  standardTSS: number;
  /** TSS of the eased-back week. */
  adjustedTSS: number;
  /** standardTSS − adjustedTSS. */
  shedTSS: number;
  /** Human-readable summary of each change (feeds the debrief "Adjustments" list). */
  steps: string[];
}

/** TSS of one session: work portion at its type rate + warm-up/cool-down at easy rate. */
export function intentTSS(i: SessionIntent): number {
  const work = i.workMinutes * plannedTssPerMin(i.slot);
  const aerobicPad = Math.max(0, i.totalMinutes - i.workMinutes) * plannedTssPerMin('easy');
  return work + aerobicPad;
}

function weekTSS(intents: SessionIntent[]): number {
  return intents.reduce((sum, i) => sum + intentTSS(i), 0);
}

/** Convert a quality intent into a steady easy run of the same duration. */
function toEasy(i: SessionIntent): SessionIntent {
  return {
    ...i,
    slot: 'easy',
    workMinutes: i.totalMinutes,
    reps: undefined,
    repMinutes: undefined,
    recoveryMinutes: undefined,
    variantId: 'easy_steady',
  };
}

/**
 * Apply the ease-back ladder to a standard week's intents. Returns copies; the
 * input array and its members are never mutated. When the week is already at or
 * under L_max, returns the intents unchanged with shedTSS 0.
 */
export function computeAcwrEaseBack(
  standardIntents: SessionIntent[],
  opts: AcwrEaseBackOpts,
): AcwrEaseBackResult {
  const { chronicWeeklyTSS, safeUpper, easyFloorMin, longFloorMin } = opts;
  const lMax = safeUpper * chronicWeeklyTSS;
  const standardTSS = weekTSS(standardIntents);

  // Work on deep copies so callers (and tests) keep the standard week intact.
  let intents = standardIntents.map(i => ({ ...i }));
  const steps: string[] = [];

  // chronic < 1 → no meaningful ceiling; nothing to do (caller guards this too).
  if (chronicWeeklyTSS < 1 || standardTSS <= lMax) {
    return { intents, lMax, standardTSS, adjustedTSS: standardTSS, shedTSS: 0, steps };
  }

  // ── Step 1: strip intensity (quality → easy, fast long run → steady) ─────────
  // Downgrade the highest-premium quality first so we shed the most per change.
  const qualityOrder = intents
    .map((i, idx) => ({ idx, premium: plannedTssPerMin(i.slot) - plannedTssPerMin('easy') }))
    .filter(q => QUALITY_SLOTS.has(intents[q.idx].slot) && q.premium > 0)
    .sort((a, b) => b.premium - a.premium);

  for (const { idx } of qualityOrder) {
    if (weekTSS(intents) <= lMax) break;
    const fromLabel = intents[idx].slot;
    intents[idx] = toEasy(intents[idx]);
    steps.push(`${labelSlot(fromLabel)} converted to easy (load elevated)`);
  }

  // Always neutralise a fast-finish long run's surge when easing back, even if
  // the TSS ceiling is already met by the quality downgrades — the point of
  // easing is to remove intensity, and the surge is the long run's intensity.
  const longIdx = intents.findIndex(i => i.slot === 'long');
  if (longIdx >= 0 && FAST_LONG_VARIANTS.has(intents[longIdx].variantId)) {
    intents[longIdx] = { ...intents[longIdx], variantId: 'long_steady' };
    steps.push('Long run held at steady pace (speed surge removed)');
  }

  // ── Step 2: trim easy / midweek volume (long run untouched) ──────────────────
  // Trim the longest easy runs first, down to the easy floor, until under L_max.
  // Snapshot easy minutes AFTER step 1 (which converts quality → easy) so the
  // reported trim measures volume removed, not intensity downgraded.
  const easyMinBeforeTrim = easyMin(intents);
  const easyRate = plannedTssPerMin('easy');
  // eslint-disable-next-line no-constant-condition
  while (weekTSS(intents) > lMax) {
    const trimmable = intents
      .map((i, idx) => ({ idx, mins: i.totalMinutes }))
      .filter(e => intents[e.idx].slot === 'easy' && e.mins > easyFloorMin)
      .sort((a, b) => b.mins - a.mins);
    if (trimmable.length === 0) break;

    const over = weekTSS(intents) - lMax;
    const { idx } = trimmable[0];
    const cur = intents[idx];
    const maxTrim = cur.totalMinutes - easyFloorMin;
    const want = Math.ceil(over / easyRate);
    const trim = Math.min(maxTrim, want);
    if (trim <= 0) break;
    const newMins = cur.totalMinutes - trim;
    intents[idx] = { ...cur, totalMinutes: newMins, workMinutes: newMins };
  }
  const easyTrimmed = Math.round(easyMinBeforeTrim - easyMin(intents));
  if (easyTrimmed > 0) steps.push(`Easy volume trimmed ${easyTrimmed} min`);

  // ── Step 3: reduce the long run distance (last resort) ───────────────────────
  if (weekTSS(intents) > lMax && longIdx >= 0) {
    const longRate = plannedTssPerMin('long');
    const cur = intents[longIdx];
    const over = weekTSS(intents) - lMax;
    const maxTrim = Math.max(0, cur.totalMinutes - longFloorMin);
    const trim = Math.min(maxTrim, Math.ceil(over / longRate));
    if (trim > 0) {
      const newMins = cur.totalMinutes - trim;
      intents[longIdx] = { ...cur, totalMinutes: newMins, workMinutes: newMins };
      steps.push(`Long run shortened ${trim} min (last resort, load still high)`);
    }
  }

  const adjustedTSS = weekTSS(intents);
  return { intents, lMax, standardTSS, adjustedTSS, shedTSS: standardTSS - adjustedTSS, steps };
}

function easyMin(intents: SessionIntent[]): number {
  return intents.filter(i => i.slot === 'easy').reduce((s, i) => s + i.totalMinutes, 0);
}

function labelSlot(slot: SlotType): string {
  const map: Partial<Record<SlotType, string>> = {
    threshold: 'Tempo', vo2: 'VO2', marathon_pace: 'Marathon-pace',
    progressive: 'Progression', float: 'Fartlek',
  };
  return map[slot] ?? slot;
}
