/**
 * Injury capability substitution — "what can you still do".
 *
 * When an injury blocks part of a plan, the gates (applyHyroxInjuryGates) only
 * SUBTRACT: they drop or scale what the athlete cannot do. That can leave a
 * week with nothing prescribed (e.g. a knee blocks running AND lower-body
 * loading, so every mixed station circuit drops too). This module looks at the
 * full capacity vector (run / bike / swim / upperLoad / lowerLoad) and offers
 * the safe sessions the athlete CAN still do, so the freed time has somewhere
 * to go.
 *
 * **Suggestion only.** Offers are surfaced as an opt-in nudge (the user accepts
 * before anything is added to the plan). Nothing here mutates state. This keeps
 * us from silently inflating volume during injury (CLAUDE.md adaptation
 * transparency) while still answering "you can still pedal".
 *
 * **No invented numbers.** The aerobic substitute's duration is the training
 * time the injury freed up this week (un-gated minus gated aerobic minutes, both
 * from the real plan generator). Its RPE reuses the phase table the injury
 * strength generator already uses (`RPE_BY_PHASE`). The strength offer is the
 * existing `injuryStrengthDecision` output verbatim.
 *
 * **Scope**: HYROX first (the mode under test). Running, triathlon, and cycling
 * mirror this in a follow-up — the capacity vector and helpers are mode-neutral;
 * only `freedAerobicMinutes` (which reads HYROX weeks) is HYROX-specific today.
 */

import type { SimulatorState, Workout, Week } from '@/types/state';
import type { InjuryState } from '@/types/injury';
import { pickAerobicSubstitute, getDisciplineCapacity } from '@/injury/engine';
import { injuryStrengthDecision, RPE_BY_PHASE } from '@/workouts/injury-strength';

// Re-export so existing importers (and the unit tests) keep their path. The
// pick now lives in injury/engine.ts beside getDisciplineCapacity so running's
// rehab generator can share it without a circular import.
export { pickAerobicSubstitute };

export interface CapabilityOffer {
  /** A ready-to-add safe session. */
  workout: Workout;
  /** One-line rationale for the nudge copy. */
  reason: string;
}

type CapabilityMode = 'hyrox' | 'triathlon';

/** Is this an aerobic (engine-building) session for the mode? */
function isAerobic(w: Workout, mode: CapabilityMode): boolean {
  const t = (w.t || '') as string;
  if (mode === 'hyrox') {
    return t.startsWith('hyrox_run_') || t === 'hyrox_brick' || t === 'hyrox_mini_brick'
      || (t === 'easy' && (w as { commute?: boolean }).commute === true);
  }
  // triathlon: any swim/bike/run discipline session, or a brick.
  const disc = (w as { discipline?: string }).discipline;
  return disc === 'swim' || disc === 'bike' || disc === 'run' || t === 'brick';
}

/** Aerobic session minutes in a week, for the mode. */
function aerobicMinutes(wk: Week | null | undefined, mode: CapabilityMode): number {
  let min = 0;
  for (const w of wk?.triWorkouts ?? []) {
    if (isAerobic(w, mode)) min += (w as { estimatedDurationMin?: number }).estimatedDurationMin ?? 0;
  }
  return min;
}

/** Day-of-week of the first dropped aerobic session, for slotting the offer. */
function firstDroppedAerobicDay(ungated: Week | null, gatedDays: Set<number>, mode: CapabilityMode): number | null {
  for (const w of ungated?.triWorkouts ?? []) {
    if (!isAerobic(w, mode)) continue;
    const day = (w as { dayOfWeek?: number }).dayOfWeek;
    if (typeof day === 'number' && !gatedDays.has(day)) return day;
  }
  return null;
}

/**
 * Aerobic training time the injury freed up in the current week, in minutes:
 * un-gated aerobic minutes minus what survived the gate. Computed from the real
 * generator (regenerate the week with the injury cleared) so the number is
 * sourced, not invented. Returns 0 when nothing was freed. Mode-aware: HYROX
 * regenerates via the HYROX engine, triathlon via the triathlon engine.
 */
async function freedAerobic(state: SimulatorState, mode: CapabilityMode): Promise<{ minutes: number; day: number | null }> {
  const wkIndex = state.w ?? 1;
  const gated = state.wks?.[wkIndex - 1] ?? null;
  const ungatedState = { ...state, injuryState: undefined } as SimulatorState;
  const ungated = mode === 'hyrox'
    ? (await import('@/workouts/plan_engine.hyrox')).regenerateHyroxWeek(ungatedState, wkIndex)
    : (await import('@/workouts/plan_engine.triathlon')).regenerateTriathlonWeek(ungatedState, wkIndex);

  const minutes = Math.max(0, aerobicMinutes(ungated, mode) - aerobicMinutes(gated, mode));
  // Days that still hold an aerobic session after gating (avoid double-booking).
  const gatedDays = new Set<number>();
  for (const w of gated?.triWorkouts ?? []) {
    if (isAerobic(w, mode)) {
      const d = (w as { dayOfWeek?: number }).dayOfWeek;
      if (typeof d === 'number') gatedDays.add(d);
    }
  }
  return { minutes, day: firstDroppedAerobicDay(ungated, gatedDays, mode) };
}

/** Recovery clause for the aerobic-substitute description. Returns a body-part
 *  phrase ("while your knee recovers") when the injury has a real location, or a
 *  generic clause ("while you recover") when the location is unset or 'other' —
 *  avoids the "while your other recovers" copy glitch. */
function recoveryClause(inj: InjuryState): string {
  const loc = inj.location && inj.location !== 'other'
    ? inj.location.replace(/_/g, ' ')
    : null;
  return loc ? `while your ${loc} recovers` : 'while you recover';
}

/**
 * Build the aerobic-substitute offer for `minutes` of freed training time, or
 * null when no aerobic sport is safe. Pure and generator-free so the offer
 * shape (substitute pick, intensity scaling, duration, copy, discipline badge)
 * is unit-testable without standing up the week generator.
 *
 * Intensity, not duration, absorbs a limited discipline: the freed minutes stay
 * whole (the engine-maintenance stimulus is the point) and the prescribed RPE is
 * dialled down in proportion to how loadable the substitute is. A 50%-capacity
 * bike holds the same minutes at roughly half the RPE. Linear in capacity, no
 * invented constant.
 */
export function buildAerobicOffer(
  inj: InjuryState,
  minutes: number,
  day: number | null,
): CapabilityOffer | null {
  if (minutes <= 0) return null;
  const aero = pickAerobicSubstitute(inj);
  if (!aero) return null;

  const baseRpe = RPE_BY_PHASE[inj.injuryPhase] ?? 4;
  // pickAerobicSubstitute only returns a pick when capacity > 0, so cap is 1..100.
  const cap = getDisciplineCapacity(inj, aero.capacityKey);
  const rpe = Math.max(1, Math.round((baseRpe * cap) / 100));
  const limited = cap < 100;
  // Tag the discipline so the card renders natively (Bike / Swim badge in both
  // the tri and HYROX surfaces). Row erg has no discipline lane, so it keeps the
  // generic cross-training badge.
  const disciplineField =
    aero.sport === 'bike' ? { discipline: 'bike' as const } :
    aero.sport === 'swim' ? { discipline: 'swim' as const } : {};
  const description = limited
    ? `${minutes} min, very easy. Holds your aerobic engine ${recoveryClause(inj)}. Effort stays low while the area is only partly ready to load.`
    : `${minutes} min easy, conversational effort. Holds your aerobic engine ${recoveryClause(inj)}, without loading the injury.`;
  const workout: Workout = {
    t: 'cross_training',
    n: `${aero.label}: aerobic maintenance`,
    d: description,
    r: rpe,
    rpe,
    estimatedDurationMin: minutes,
    ...disciplineField,
    ...(day != null ? { dayOfWeek: day } : {}),
    modReason: `${aero.label} substitutes the training you can't currently do.`,
  } as Workout;
  return { workout, reason: `${aero.label.toLowerCase()} for the time you can't train` };
}

/**
 * Build the safe-session offers for the current week, for HYROX or triathlon
 * (running's aerobic substitute comes from its phase rehab path, so it is not
 * routed here). Returns [] when no active injury, an unsupported mode, or
 * nothing safe is available. Pure (no state mutation).
 */
export async function buildCapabilityOffers(state: SimulatorState): Promise<CapabilityOffer[]> {
  const inj = state.injuryState;
  if (!inj?.active || inj.injuryPhase === 'resolved') return [];
  const eventType = (state as { eventType?: string }).eventType;
  const mode: CapabilityMode | null =
    eventType === 'hyrox' ? 'hyrox' : eventType === 'triathlon' ? 'triathlon' : null;
  if (!mode) return [];

  const offers: CapabilityOffer[] = [];

  // Aerobic substitute for the training time the injury freed up ("you can
  // still pedal"). 1:1 minutes with the lost aerobic time, so it replaces rather
  // than inflates volume; intensity scales with capacity (see buildAerobicOffer).
  const { minutes, day } = await freedAerobic(state, mode);
  const aerobic = buildAerobicOffer(inj, minutes, day);
  if (aerobic) offers.push(aerobic);

  // Region-safe strength (existing generator).
  const strength = injuryStrengthDecision(inj);
  if (strength.kind === 'adapted') {
    offers.push({ workout: strength.workout, reason: 'a strength session that avoids the injured area' });
  }

  return offers;
}

/** Back-compat alias for the original HYROX-only entry point. */
export const buildHyroxCapabilityOffers = buildCapabilityOffers;
