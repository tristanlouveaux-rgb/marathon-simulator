import type { RaceDistance, RunnerType, TrainingPhase, AbilityBand } from '@/types';
import type { SessionIntent, SlotType } from './intent_to_workout';
import { weekVolumeBudgetKm, type Archetype } from '@/calculations/athlete-archetype';

export interface PlanContext {
  runsPerWeek: number;
  raceDistance: RaceDistance;
  runnerType: RunnerType;
  phase: TrainingPhase;
  fitnessLevel: string;
  weekIndex: number;   // 1-based
  totalWeeks: number;
  vdot: number;
  effortScore?: number;  // Trailing effort score from recent weeks (used for adaptive scaling)
  acwrStatus?: 'safe' | 'caution' | 'high' | 'unknown'; // ACWR injury risk. Reduces quality sessions when elevated
  /** CTL adherence ratio for the just-completed week: actual chronic load ÷ plan-expected
   *  chronic load (see fitness-model.ctlAdherenceRatio). < 1 means the athlete fell behind the
   *  plan's load; the prescription is re-anchored DOWN in proportion (reduce-only). Omit on the
   *  vanilla/standard plan. Suppressed by the caller on deload weeks and after multi-week detraining. */
  ctlRatio?: number;
  forceDeload?: boolean; // Holiday week. Treated as deload regardless of cycle position
  /** Peak weekly hours target from onboarding. Easy and long sessions are scaled to fit;
   *  quality sessions (threshold / VO2 / marathon-pace) are never shortened below their
   *  minimum effective duration. */
  weeklyHoursTarget?: number;
  /** Slot types the user opted out of on the workout-preview step. Filtered from
   *  the quality priority list before slot allocation. */
  excludedSlots?: string[];
  /** Current baseline weekly running km (s.detectedWeeklyKm). When present together
   *  with `archetype`, week-1 volume is anchored to baseline and ramps toward
   *  ability-driven peak per the archetype-specific slope. Omit to keep legacy
   *  ability-driven behaviour (consistent runner at race-target volume). */
  baselineKm?: number;
  /** Athlete archetype (s.athleteArchetype.archetype). Gates the ramp slope —
   *  detrained-with-history ramps faster than cross-trained-no-impact. Required
   *  alongside `baselineKm` for the ramp to fire. */
  archetype?: Archetype;
  /** Easy pace in seconds per km, used to convert the km budget into a minute
   *  budget. Falls back to 360 s/km (6:00/km) when omitted. Matches
   *  intent_to_workout.minutesToKm. */
  easyPaceSecPerKm?: number;
}

// ---------------------------------------------------------------------------
// Variant rotation arrays (ported from Python)
// ---------------------------------------------------------------------------

export const VO2_VARIANTS = [
  { id: 'vo2_5x3', reps: 5, repMin: 3, recMin: 2 },
  { id: 'vo2_6x2', reps: 6, repMin: 2, recMin: 2 },
  { id: 'vo2_5x4', reps: 5, repMin: 4, recMin: 2.5 },
  { id: 'vo2_12x1', reps: 12, repMin: 1, recMin: 1 },
];

export const THRESH_VARIANTS = [
  { id: 'thr_20cont', workMin: 20 },                                    // continuous
  { id: 'thr_3x8', reps: 3, repMin: 8, recMin: 2 },
  { id: 'thr_2x12', reps: 2, repMin: 12, recMin: 3 },
  { id: 'thr_cruise_5x5', reps: 5, repMin: 5, recMin: 1 },
];

export const LONG_VARIANTS = [
  { id: 'long_steady' },
  { id: 'long_fast_finish' },
  { id: 'long_with_blocks' },
];

// Float fartlek variants. Hard reps at 10K/HM effort, "float" recovery at ~MP
// Science: moderate-effort recovery trains MCT1/MCT4 lactate transporters (Brooks 2009).
// Sustained blood lactate at 2–3 mmol/L during float segments forces aerobic adaptation
// under mild acidosis. Mimicking the metabolic profile of marathon racing (Coyle 2007).
export const FLOAT_VARIANTS = [
  { id: 'float_6x3_2', reps: 6, repMin: 3, floatMin: 2 },   // 30min main set, classic Hudson format
  { id: 'float_5x4_2', reps: 5, repMin: 4, floatMin: 2 },   // longer reps, sustained clearance
  { id: 'float_8x2_2', reps: 8, repMin: 2, floatMin: 2 },   // shorter/sharper, more transitions
  { id: 'float_4x5_3', reps: 4, repMin: 5, floatMin: 3 },   // Canova-style longer blocks
];

// ---------------------------------------------------------------------------
// Ability band
// ---------------------------------------------------------------------------

export function abilityBandFromVdot(vdot: number, experience: string): AbilityBand {
  // VDOT-based band
  let vdotBand: AbilityBand;
  if (vdot < 30) vdotBand = 'beginner';
  else if (vdot < 40) vdotBand = 'novice';
  else if (vdot < 50) vdotBand = 'intermediate';
  else if (vdot < 60) vdotBand = 'advanced';
  else vdotBand = 'elite';

  // Experience can cap upward
  const expCap: Record<string, AbilityBand> = {
    total_beginner: 'beginner',
    beginner: 'novice',
    novice: 'novice',
    intermediate: 'intermediate',
    returning: 'intermediate',
    hybrid: 'intermediate',
    advanced: 'advanced',
    competitive: 'elite',
  };

  const cap = expCap[experience] || 'intermediate';
  const order: AbilityBand[] = ['beginner', 'novice', 'intermediate', 'advanced', 'elite'];
  const vIdx = order.indexOf(vdotBand);
  const cIdx = order.indexOf(cap);
  return order[Math.min(vIdx, cIdx)];
}

// ---------------------------------------------------------------------------
// Deload
// ---------------------------------------------------------------------------

export function isDeloadWeek(weekIndex: number, ability: AbilityBand): boolean {
  // No deload on week 1
  if (weekIndex <= 1) return false;
  const cycle =
    ability === 'beginner' || ability === 'novice' ? 3 :
    ability === 'intermediate' ? 4 :
    ability === 'advanced' ? 5 : 6;
  return weekIndex % cycle === 0;
}

export function deloadMultiplier(ability: AbilityBand): number {
  switch (ability) {
    case 'beginner': return 0.80;
    case 'novice': return 0.80;
    case 'intermediate': return 0.85;
    case 'advanced': return 0.87;
    case 'elite': return 0.90;
  }
}

// ---------------------------------------------------------------------------
// Effort multiplier (within-band adaptive scaling)
// ---------------------------------------------------------------------------

export function effortMultiplier(score: number): number {
  return Math.max(0.85, Math.min(1.15, 1 - score * 0.05));
}

/**
 * CTL-gap re-anchor multiplier — reduce-only.
 *
 * `ctlRatio` is actualCTL ÷ expectedCTL for the just-completed week (see
 * fitness-model.ctlAdherenceRatio). The next week's prescribed volume scales in DIRECT
 * proportion to the chronic load the athlete actually carries versus what the plan assumed.
 * This is the foundational ACWR / ramp-rate principle: progress load relative to your CURRENT
 * chronic load, not an aspirational one (Gabbett 2016). When the athlete is on or above plan
 * (ratio ≥ 1) this is a no-op — increasing the prescription off the back of under-training is
 * the effort multiplier's job (for the sessions actually done) and ACWR's job (when acute load
 * spikes), never this lever's. The combined floor is applied at the application site.
 */
export function ctlGapMultiplier(ctlRatio: number): number {
  if (!Number.isFinite(ctlRatio) || ctlRatio >= 1) return 1.0;
  return Math.max(0, ctlRatio);
}

// ---------------------------------------------------------------------------
// Quality cap
// ---------------------------------------------------------------------------

export function qualityCap(ability: AbilityBand, experience: string, runsPerWeek: number): number {
  let base: number;
  switch (ability) {
    case 'beginner': base = 1; break;
    case 'novice': base = 1; break;
    case 'intermediate': base = 2; break;
    case 'advanced': base = 2; break;
    case 'elite': base = 3; break;
  }
  // Can't have more quality than runs - 1 (need at least one easy)
  return Math.min(base, Math.max(0, runsPerWeek - 1));
}

// ---------------------------------------------------------------------------
// Time-based session budgets
// ---------------------------------------------------------------------------

export function longRunMinutes(
  weekIndex: number, totalWeeks: number, ability: AbilityBand,
  race: RaceDistance, phase: TrainingPhase
): number {
  // Base long run by race
  const baseLong: Record<RaceDistance, number> = {
    '5k': 50, '10k': 60, half: 80, marathon: 90,
  };
  let base = baseLong[race];

  // Progressive: ramp from 80% to 100% over plan
  const progress = Math.min(1, weekIndex / (totalWeeks * 0.75));
  base = base * (0.80 + 0.20 * progress);

  // Phase caps
  if (phase === 'taper') base *= 0.65;
  else if (phase === 'peak') base *= 1.05;

  // Ability caps
  const cap: Record<AbilityBand, number> = {
    beginner: 90, novice: 100, intermediate: 120, advanced: 150, elite: 180,
  };
  return Math.round(Math.min(base, cap[ability]));
}

export function easyRunMinutes(ability: AbilityBand, race: RaceDistance, phase: TrainingPhase): number {
  const base: Record<AbilityBand, number> = {
    beginner: 30, novice: 35, intermediate: 40, advanced: 45, elite: 50,
  };
  let mins = base[ability];
  // Race multiplier
  if (race === 'marathon') mins *= 1.15;
  else if (race === 'half') mins *= 1.05;
  // Phase
  if (phase === 'taper') mins *= 0.70;
  return Math.round(mins);
}

export function thresholdWorkMinutes(
  ability: AbilityBand, phase: TrainingPhase,
  weekIndex: number, totalWeeks: number
): number {
  const base: Record<AbilityBand, number> = {
    beginner: 12, novice: 15, intermediate: 20, advanced: 25, elite: 30,
  };
  let mins = base[ability];

  // Progressive
  const progress = Math.min(1, weekIndex / (totalWeeks * 0.8));
  mins = mins * (0.75 + 0.25 * progress);

  // Phase
  if (phase === 'base') mins *= 0.85;
  else if (phase === 'build') mins *= 1.0;
  else if (phase === 'peak') mins *= 1.05;
  else if (phase === 'taper') mins *= 0.60;

  return Math.round(mins);
}

export function vo2WorkMinutes(ability: AbilityBand, phase: TrainingPhase): number {
  const base: Record<AbilityBand, number> = {
    beginner: 8, novice: 10, intermediate: 14, advanced: 18, elite: 22,
  };
  let mins = base[ability];
  if (phase === 'base') mins *= 0.6;
  else if (phase === 'build') mins *= 0.9;
  else if (phase === 'peak') mins *= 1.1;
  else if (phase === 'taper') mins *= 0.5;
  return Math.round(mins);
}

export function mpWorkMinutes(
  race: RaceDistance, ability: AbilityBand, phase: TrainingPhase
): number {
  // Marathon pace only for marathon (and optionally half)
  if (race !== 'marathon' && race !== 'half') return 0;
  if (phase === 'base' || phase === 'taper') return 0;

  const base: Record<AbilityBand, number> = {
    beginner: 15, novice: 20, intermediate: 30, advanced: 40, elite: 50,
  };
  let mins = base[ability];
  if (race === 'half') mins *= 0.6;
  if (phase === 'build') mins *= 0.85;
  // peak: 1.0
  return Math.round(mins);
}

/**
 * Float fartlek work minutes (hard rep time only, not counting float recovery).
 * Only for half/marathon, build/peak phases, intermediate+ ability.
 * Replaces one quality slot per week when conditions are met.
 */
export function floatWorkMinutes(
  race: RaceDistance, ability: AbilityBand, phase: TrainingPhase
): number {
  // Float only for half/marathon. Shorter races don't benefit (race effort is above LT)
  if (race !== 'marathon' && race !== 'half') return 0;
  // Build and peak only. Base is aerobic development, taper clears fatigue
  if (phase !== 'build' && phase !== 'peak') return 0;
  // Intermediate+ only. Requires pacing discipline to hold float (not jog, not tempo)
  const eligible: AbilityBand[] = ['intermediate', 'advanced', 'elite'];
  if (!eligible.includes(ability)) return 0;

  const base: Record<AbilityBand, number> = {
    beginner: 0, novice: 0, intermediate: 18, advanced: 22, elite: 26,
  };
  let mins = base[ability];
  if (race === 'half') mins *= 0.8;
  if (phase === 'build') mins *= 0.90;
  // peak: 1.0
  return Math.round(mins);
}

// ---------------------------------------------------------------------------
// Workout priority by race + phase (ported from Python)
// ---------------------------------------------------------------------------

function workoutPriority(race: RaceDistance, phase: TrainingPhase): SlotType[] {
  if (race === 'marathon') {
    if (phase === 'base') return ['threshold', 'vo2', 'marathon_pace'];
    if (phase === 'build') return ['marathon_pace', 'float', 'threshold', 'vo2'];
    if (phase === 'peak') return ['marathon_pace', 'float', 'vo2', 'threshold'];
    return ['threshold']; // taper
  }
  if (race === 'half') {
    if (phase === 'base') return ['threshold', 'vo2'];
    if (phase === 'build') return ['threshold', 'float', 'vo2', 'marathon_pace'];
    if (phase === 'peak') return ['vo2', 'float', 'threshold'];
    return ['threshold'];
  }
  if (race === '10k') {
    if (phase === 'base') return ['threshold', 'vo2'];
    if (phase === 'build') return ['vo2', 'threshold'];
    if (phase === 'peak') return ['vo2', 'threshold'];
    return ['threshold'];
  }
  // 5k
  if (phase === 'base') return ['threshold', 'vo2'];
  if (phase === 'build') return ['vo2', 'threshold'];
  if (phase === 'peak') return ['vo2', 'threshold'];
  return ['vo2'];
}

function applyRunnerTypeBias(priority: SlotType[], runnerType: RunnerType): SlotType[] {
  if (runnerType === 'Balanced') return priority;
  // Speed runners: promote endurance work (threshold up)
  // Endurance runners: promote speed work (vo2 up)
  const boost: SlotType = runnerType === 'Speed' ? 'threshold' : 'vo2';
  const idx = priority.indexOf(boost);
  if (idx > 0) {
    const arr = [...priority];
    arr.splice(idx, 1);
    arr.unshift(boost);
    return arr;
  }
  return priority;
}

// ---------------------------------------------------------------------------
// Session-duration floors (single source for the budget logic and the
// volume-aware quality cap). An easy run below EASY_FLOOR_MIN is not worth
// prescribing; the long run keeps a two-tier floor.
// ---------------------------------------------------------------------------
const EASY_FLOOR_MIN = 25;
const LONG_STD_FLOOR_MIN = 40;
const LONG_SOFT_FLOOR_MIN = 30;

/**
 * The effective weekly minute budget = the tighter of the archetype ramp
 * budget (km anchored to the athlete's current volume) and the user's weekly
 * hours target. `Infinity` when neither is set (legacy generous behaviour).
 * Single source so the quality cap and `applyHoursBudget` agree.
 */
function effectiveWeeklyBudgetMin(ctx: PlanContext): number {
  let budget = Infinity;
  if (ctx.baselineKm != null && ctx.archetype != null && ctx.baselineKm > 0) {
    const peakKm = computePeakWeeklyKm(ctx);
    const weekKm = weekVolumeBudgetKm(ctx.weekIndex, ctx.baselineKm, peakKm, ctx.archetype);
    const easyPaceSecPerKm = ctx.easyPaceSecPerKm ?? 360;
    budget = Math.min(budget, Math.round((weekKm * easyPaceSecPerKm) / 60));
  }
  if (ctx.weeklyHoursTarget != null && ctx.weeklyHoursTarget > 0) {
    budget = Math.min(budget, ctx.weeklyHoursTarget * 60);
  }
  return budget;
}

// ---------------------------------------------------------------------------
// Main entry: planWeekSessions
// ---------------------------------------------------------------------------

export function planWeekSessions(ctx: PlanContext): SessionIntent[] {
  const {
    runsPerWeek, raceDistance, runnerType, phase, fitnessLevel,
    weekIndex, totalWeeks, vdot, acwrStatus,
  } = ctx;
  const excludedSlots = new Set(ctx.excludedSlots ?? []);

  const ability = abilityBandFromVdot(vdot, fitnessLevel);
  const deload = ctx.forceDeload || isDeloadWeek(weekIndex, ability);
  const eMult = ctx.effortScore != null ? effortMultiplier(ctx.effortScore) : 1.0;
  // CTL-gap re-anchor: reduce volume when the athlete fell behind the plan's load. Suppressed on
  // deload weeks (already a planned reduction — re-anchoring a deload down would double up the same
  // "go easy"). Effort and CTL-gap both scale duration, so THESE TWO adaptive levers have their
  // COMBINED effect clamped to the effort band (no lower than the ability deload, no higher than
  // +15%) — they cannot stack past what either alone may do. When ctlRatio is absent, adaptive ===
  // eMult and dMult is byte-identical to the effort-only path.
  const cMult = (!deload && ctx.ctlRatio != null) ? ctlGapMultiplier(ctx.ctlRatio) : 1.0;
  const adaptive = cMult === 1.0
    ? eMult
    : Math.max(deloadMultiplier(ability), Math.min(1.15, eMult * cMult));
  // deload × effort IS allowed to compound (deloadMult × eMult, e.g. 0.85 × 0.85 ≈ 0.72). This is
  // intentional autoregulation, not the stacking the clamp above prevents: a deload week where
  // recent sessions were rated harder than prescribed signals accumulated fatigue, and a deeper
  // recovery week is the correct response (RPE-based autoregulation, Helms 2018). The clamp scopes
  // only the two volume-re-anchor levers (effort + CTL-gap), which CAN measure the same shortfall.
  const dMult = (deload ? deloadMultiplier(ability) : 1.0) * adaptive;

  const intents: SessionIntent[] = [];
  let maxQuality = qualityCap(ability, fitnessLevel, runsPerWeek);

  // Volume-aware quality cap. A quality session only earns its slot if the
  // weekly volume budget can also seat a long run and at least one easy run at
  // their floors. Low-volume weeks (early ramp, deload, taper) therefore carry
  // fewer quality sessions, climbing to the ability cap as volume grows — this
  // keeps the intensity distribution near 80/20 (Seiler 2010) instead of
  // stacking intervals on a small base, and scales correctly with plan length
  // (a short plan ramps volume faster, so the cap lifts sooner). Derived from
  // the existing floors and the threshold-session cost — no new constants.
  // Floored at 1 so a fit athlete keeps one quality session for intensity
  // retention even at the lowest volume (the residual overflow is accepted and
  // surfaced by the plan-view budget banner).
  const weeklyBudgetMin = effectiveWeeklyBudgetMin(ctx);
  if (Number.isFinite(weeklyBudgetMin)) {
    const approxQualityMin = thresholdWorkMinutes(ability, phase, weekIndex, totalWeeks) + 20;
    const aerobicReserve = LONG_SOFT_FLOOR_MIN + EASY_FLOOR_MIN;
    const affordable = Math.floor((weeklyBudgetMin - aerobicReserve) / Math.max(1, approxQualityMin));
    maxQuality = Math.max(1, Math.min(maxQuality, affordable));
  }

  // ACWR-driven quality session reduction
  // caution: drop one quality session; high: drop two and cap long run.
  // Orthogonal to the CTL-gap re-anchor above: ACWR trims INTENSITY (swaps hard sessions for easy)
  // when acute load spiked HIGH, whereas CTL-gap trims DURATION when chronic load fell LOW. They
  // act on different axes and opposite triggers, so co-firing (rare — skipping collapses ATL, which
  // moves ACWR toward 'safe') just composes conservatively rather than double-counting.
  const acwrNote = acwrStatus === 'high'
    ? 'ACWR elevated — intensity reduced (high risk)'
    : acwrStatus === 'caution'
    ? 'ACWR caution — one quality session replaced with easy'
    : '';
  if (acwrStatus === 'caution') maxQuality = Math.max(0, maxQuality - 1);
  if (acwrStatus === 'high')    maxQuality = Math.max(0, maxQuality - 2);

  // For 1 run/week: single combined session
  if (runsPerWeek <= 1) {
    const mins = Math.round(longRunMinutes(weekIndex, totalWeeks, ability, raceDistance, phase) * dMult);
    intents.push({
      dayIndex: 0,
      slot: 'long',
      totalMinutes: mins,
      workMinutes: mins,
      variantId: 'long_steady',
      notes: deload ? 'Deload week' : '',
    });
    return intents;
  }

  // Place long run (last slot) for half/marathon or >= 3 runs
  const needsLong = raceDistance === 'half' || raceDistance === 'marathon' || runsPerWeek >= 3;
  let slotsRemaining = runsPerWeek;

  if (needsLong) {
    let longMins = Math.round(longRunMinutes(weekIndex, totalWeeks, ability, raceDistance, phase) * dMult);
    // ACWR high: cap long run at previous week's equivalent (≈ no progression this week)
    if (acwrStatus === 'high' && weekIndex > 1) {
      const prevLongMins = Math.round(longRunMinutes(weekIndex - 1, totalWeeks, ability, raceDistance, phase) * dMult);
      longMins = Math.min(longMins, prevLongMins);
    }
    const longVar = LONG_VARIANTS[Math.max(0, (weekIndex - 1)) % LONG_VARIANTS.length];
    const longNote = acwrNote || (deload ? 'Deload week' : '');
    intents.push({
      dayIndex: runsPerWeek - 1, // last day
      slot: 'long',
      totalMinutes: longMins,
      workMinutes: longMins,
      variantId: longVar.id,
      notes: longNote,
    });
    slotsRemaining--;
  }

  // Fill quality sessions. Filter any slots the user has opted out of
  let qualityFilled = 0;
  const rawPriority = applyRunnerTypeBias(workoutPriority(raceDistance, phase), runnerType);
  // Base-first periodisation: no VO2 intervals in the base phase. The aerobic
  // and musculoskeletal base is built at lower intensity first; VO2 work enters
  // in build/peak (Daniels; Bompa). This makes the base quality session a
  // tempo, which is both gentler on a low-volume base and the right stimulus.
  const priority = rawPriority.filter(s => !excludedSlots.has(s) && !(phase === 'base' && s === 'vo2'));
  let dayIdx = 0;

  for (const slot of priority) {
    if (qualityFilled >= maxQuality || slotsRemaining <= 0) break;
    // Reserve at least 1 slot for easy (unless we're the last slot)
    if (slotsRemaining <= 1 && qualityFilled > 0) break;

    const qualityNote = acwrNote || (deload ? 'Deload week' : '');

    if (slot === 'threshold') {
      const workMins = Math.round(thresholdWorkMinutes(ability, phase, weekIndex, totalWeeks) * dMult);
      const variant = THRESH_VARIANTS[Math.max(0, (weekIndex - 1)) % THRESH_VARIANTS.length];
      const totalMins = variant.reps
        ? Math.round(variant.reps * (variant.repMin! + variant.recMin!) + 15) // warmup/cooldown
        : workMins + 20; // continuous: warmup + cooldown
      intents.push({
        dayIndex: dayIdx++,
        slot: 'threshold',
        totalMinutes: Math.round(totalMins * dMult),
        workMinutes: workMins,
        reps: variant.reps,
        repMinutes: variant.repMin,
        recoveryMinutes: variant.recMin,
        variantId: variant.id,
        notes: qualityNote,
      });
    } else if (slot === 'vo2') {
      const workMins = Math.round(vo2WorkMinutes(ability, phase) * dMult);
      const variant = VO2_VARIANTS[Math.max(0, (weekIndex - 1)) % VO2_VARIANTS.length];
      const totalMins = Math.round(variant.reps * (variant.repMin + variant.recMin) + 15);
      intents.push({
        dayIndex: dayIdx++,
        slot: 'vo2',
        totalMinutes: Math.round(totalMins * dMult),
        workMinutes: workMins,
        reps: variant.reps,
        repMinutes: variant.repMin,
        recoveryMinutes: variant.recMin,
        variantId: variant.id,
        notes: qualityNote,
      });
    } else if (slot === 'marathon_pace') {
      const workMins = Math.round(mpWorkMinutes(raceDistance, ability, phase) * dMult);
      if (workMins <= 0) continue; // skip if not applicable
      intents.push({
        dayIndex: dayIdx++,
        slot: 'marathon_pace',
        totalMinutes: workMins + 20,
        workMinutes: workMins,
        variantId: 'mp_continuous',
        notes: qualityNote,
      });
    } else if (slot === 'float') {
      const workMins = Math.round(floatWorkMinutes(raceDistance, ability, phase) * dMult);
      if (workMins <= 0) continue; // skip if not eligible (beginner/novice, base/taper, 5K/10K)
      const variant = FLOAT_VARIANTS[Math.max(0, (weekIndex - 1)) % FLOAT_VARIANTS.length];
      const totalMins = Math.round(variant.reps * (variant.repMin + variant.floatMin) + 15);
      intents.push({
        dayIndex: dayIdx++,
        slot: 'float',
        totalMinutes: Math.round(totalMins * dMult),
        workMinutes: workMins,
        reps: variant.reps,
        repMinutes: variant.repMin,
        recoveryMinutes: variant.floatMin,
        variantId: variant.id,
        notes: qualityNote,
      });
    }

    qualityFilled++;
    slotsRemaining--;
  }

  // Fill remaining with easy
  while (slotsRemaining > 0) {
    const easyMins = Math.round(easyRunMinutes(ability, raceDistance, phase) * dMult);
    intents.push({
      dayIndex: dayIdx++,
      slot: 'easy',
      totalMinutes: easyMins,
      workMinutes: easyMins,
      variantId: 'easy_steady',
      notes: deload ? 'Deload week' : '',
    });
    slotsRemaining--;
  }

  // Fit the sessions into the effective weekly budget — the tighter of the
  // archetype ramp budget (km anchored to the athlete's current volume, ramping
  // geometrically toward the ability-driven peak) and the user's weekly hours
  // target. Easy runs are consolidated and the long run trimmed to its floors;
  // quality minutes are preserved (stimulus depends on work-interval duration,
  // Seiler 2010 / Billat 2001). `Infinity` (no ramp, no target) is a no-op.
  if (Number.isFinite(weeklyBudgetMin)) {
    applyHoursBudget(intents, weeklyBudgetMin);
  }

  return intents;
}

/**
 * Peak weekly km the plan is ramping toward. Derived from the ability-driven
 * minute budgets and easy pace. Matches the volume an established consistent
 * runner would see today (which is why their plan generation looks the same:
 * baseline ≥ peak → ramp clamps at peak from week 1).
 *
 * Mirrors the shape of `getPlanPrescribedMeanWeeklyKm` but at the peak point
 * of the plan rather than the build-phase mean.
 */
function computePeakWeeklyKm(ctx: PlanContext): number {
  const ability = abilityBandFromVdot(ctx.vdot, ctx.fitnessLevel);
  const easyPaceSecPerKm = ctx.easyPaceSecPerKm ?? 360;
  // Long-run peak: ability cap (intermediate marathon = 120 min, etc.)
  const longCap: Record<AbilityBand, number> = {
    beginner: 90, novice: 100, intermediate: 120, advanced: 150, elite: 180,
  };
  const longMin = longCap[ability];
  const easyMin = easyRunMinutes(ability, ctx.raceDistance, 'peak');
  // Quality minutes (rough estimate, used as a constant): threshold + vo2 + mp.
  const qualityMin = thresholdWorkMinutes(ability, 'peak', ctx.totalWeeks, ctx.totalWeeks)
    + 20 // continuous threshold has warm/cool 20m baked in
    + vo2WorkMinutes(ability, 'peak') + 15
    + mpWorkMinutes(ctx.raceDistance, ability, 'peak') + 20;
  const easyCount = Math.max(0, ctx.runsPerWeek - 2 - (ctx.raceDistance === 'marathon' || ctx.raceDistance === 'half' ? 1 : 0));
  const totalMin = longMin + qualityMin + easyMin * easyCount;
  // km at easy pace (quality reps cover less ground per minute, but the integral
  // assumption is close enough for a budget heuristic. The goal here is a
  // realistic peak that an intermediate marathoner trains at, ~70-80 km).
  return (totalMin * 60) / easyPaceSecPerKm;
}

/**
 * Fit flexible sessions (easy, then long) into a weekly minute budget.
 * Quality sessions (threshold, vo2, marathon_pace, float) are never trimmed —
 * their stimulus depends on work-interval duration (Seiler 2010, Billat 2001).
 *
 * Easy-run policy (2026-06-02): a single floor, `EASY_FLOOR_MIN = 25` min. An
 * easy run below 25 min is not worth prescribing — the aerobic stimulus is
 * negligible relative to the fixed per-session overhead. When the budget
 * cannot give every planned easy run-day at least the floor, we CONSOLIDATE:
 * drop run-days and lengthen the survivors, rather than shrink them all into
 * 15-min fragments. At equal weekly volume, fewer longer easy runs deliver
 * more aerobic stimulus than many short ones — the continuous-duration
 * adaptations (mitochondrial density, capillarisation, fat oxidation) are
 * non-linear near the low end. The dropped run-days return automatically as
 * the volume budget ramps; the plan-view note surfaces the reduction.
 *
 * We never consolidate to ZERO easy runs: at least one survives (at the floor)
 * even when that overflows the budget. A week of intervals + a long run alone
 * is too little easy aerobic volume; the easy base matters more than a tidy
 * total. The volume-aware quality cap upstream keeps that overflow small by
 * limiting how much budget the quality sessions can claim.
 *
 * The long run keeps its two-tier floor (40 min standard, 30 min soft). Past
 * all floors we accept the residual overflow; the plan-view budget banner is
 * the user-facing surface for it.
 */
function applyHoursBudget(intents: SessionIntent[], budgetMin: number): void {
  const EASY_MIN = EASY_FLOOR_MIN;
  const STD_LONG_MIN = LONG_STD_FLOOR_MIN;
  const SOFT_LONG_MIN = LONG_SOFT_FLOOR_MIN;
  const qualitySlots = new Set(['threshold', 'vo2', 'marathon_pace', 'float']);

  const total = () => intents.reduce((s, i) => s + i.totalMinutes, 0);
  if (total() <= budgetMin) return;

  // ── Consolidate easy runs ──────────────────────────────────────────────────
  // Compute the budget left for easy running after the untrimmable quality
  // sessions and (for now) the full long run. Then choose the FEWEST easy
  // run-days such that each survivor lands within [EASY_MIN, naturalEasyMin],
  // dropping the rest. Never shrink an easy run below the floor.
  const easyIntents = intents.filter(i => i.slot === 'easy');
  if (easyIntents.length > 0) {
    const nonEasyTotal = intents
      .filter(i => i.slot !== 'easy')
      .reduce((s, i) => s + i.totalMinutes, 0);
    const easyBudget = budgetMin - nonEasyTotal;
    // All easy intents share the same natural length (easyRunMinutes).
    const naturalEasyMin = Math.max(...easyIntents.map(i => i.totalMinutes));
    const desired = easyIntents.length;

    let finalCount: number;
    if (easyBudget < EASY_MIN) {
      // Not enough budget for even one floor-length easy run, but keep ONE
      // anyway (sized to the floor below): a week needs some dedicated easy
      // aerobic running. The resulting overflow is accepted and surfaced.
      finalCount = 1;
    } else {
      // Fewest runs keeping each survivor ≤ natural; capped so each ≥ floor.
      const fewestAtNatural = Math.max(1, Math.ceil(easyBudget / naturalEasyMin));
      const mostAboveFloor = Math.floor(easyBudget / EASY_MIN);
      finalCount = Math.min(desired, fewestAtNatural, mostAboveFloor);
    }

    // Remove the dropped easy intents (keep the earliest `finalCount`).
    let toRemove = desired - finalCount;
    for (let i = intents.length - 1; i >= 0 && toRemove > 0; i--) {
      if (intents[i].slot === 'easy') { intents.splice(i, 1); toRemove--; }
    }
    // Size the survivors: split the easy budget evenly, clamped to the floor
    // and the natural length.
    if (finalCount > 0) {
      const per = Math.min(naturalEasyMin, Math.max(EASY_MIN, Math.round(easyBudget / finalCount)));
      for (const e of intents) {
        if (e.slot === 'easy') { e.totalMinutes = per; e.workMinutes = per; }
      }
    }
  }

  if (total() <= budgetMin) return;

  // ── Trim the long run (unchanged two-tier floor) ────────────────────────────
  const longIntent = intents.find(i => i.slot === 'long');
  if (longIntent) {
    const nonLongTotal = intents.filter(i => i.slot !== 'long').reduce((s, i) => s + i.totalMinutes, 0);
    const longBudget = Math.max(STD_LONG_MIN, budgetMin - nonLongTotal);
    if (longBudget < longIntent.totalMinutes) {
      longIntent.totalMinutes = longBudget;
      longIntent.workMinutes = longBudget;
    }
  }

  if (total() <= budgetMin) return;

  if (longIntent && longIntent.totalMinutes > SOFT_LONG_MIN) {
    longIntent.totalMinutes = SOFT_LONG_MIN;
    longIntent.workMinutes = SOFT_LONG_MIN;
  }

  if (total() <= budgetMin) return;

  // Past all floors. Accept the overflow rather than compress further. The
  // plan-view budget banner reads the actual total vs. budget on render and
  // lets the user pick a resolution.
  const qualityTotal = intents.filter(i => qualitySlots.has(i.slot)).reduce((s, i) => s + i.totalMinutes, 0);
  if (qualityTotal > budgetMin) {
    console.warn(`[planWeekSessions] Quality sessions alone (${qualityTotal}min) exceed budget (${budgetMin}min). Budget not enforced on quality sessions.`);
  }
}
