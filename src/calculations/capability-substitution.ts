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
import { getDisciplineCapacity } from '@/injury/engine';
import { injuryStrengthDecision, RPE_BY_PHASE } from '@/workouts/injury-strength';

export interface CapabilityOffer {
  /** A ready-to-add safe session. */
  workout: Workout;
  /** One-line rationale for the nudge copy. */
  reason: string;
}

type AerobicSport = 'bike' | 'row_erg' | 'swim';

interface AerobicPick {
  sport: AerobicSport;
  label: string;
  /** discipline key whose capacity gates the substitute. */
  capacityKey: 'bike' | 'swim' | 'upperLoad';
}

/** Map the modal's `preferredCrossTraining` enum to an aerobic substitute. */
const PREFERRED_TO_PICK: Record<string, AerobicPick> = {
  cycling:  { sport: 'bike',    label: 'Bike',    capacityKey: 'bike' },
  rowing:   { sport: 'row_erg', label: 'Row erg', capacityKey: 'upperLoad' },
  swimming: { sport: 'swim',    label: 'Swim',    capacityKey: 'swim' },
};

/**
 * Choose the aerobic substitute by availability, honouring a saved preference.
 * Order when no usable preference: bike (non-impact, legs permitting) → row erg
 * (arm-driven, when arms are free) → swim. Returns null when nothing aerobic is
 * safe.
 */
export function pickAerobicSubstitute(inj: InjuryState): AerobicPick | null {
  const usable = (p: AerobicPick) => getDisciplineCapacity(inj, p.capacityKey) > 0;

  const preferred = inj.preferredCrossTraining
    ? PREFERRED_TO_PICK[inj.preferredCrossTraining]
    : undefined;
  if (preferred && usable(preferred)) return preferred;

  const order: AerobicPick[] = [
    { sport: 'bike',    label: 'Bike',    capacityKey: 'bike' },
    { sport: 'row_erg', label: 'Row erg', capacityKey: 'upperLoad' },
    { sport: 'swim',    label: 'Swim',    capacityKey: 'swim' },
  ];
  return order.find(usable) ?? null;
}

/** Run + brick (running-bearing) minutes in a week. */
function aerobicMinutes(wk: Week | null | undefined): number {
  const list = wk?.triWorkouts ?? [];
  let min = 0;
  for (const w of list) {
    const t = (w.t || '') as string;
    const isRun = t.startsWith('hyrox_run_') || (t === 'easy' && (w as { commute?: boolean }).commute === true);
    const isBrick = t === 'hyrox_brick' || t === 'hyrox_mini_brick';
    if (isRun || isBrick) min += (w as { estimatedDurationMin?: number }).estimatedDurationMin ?? 0;
  }
  return min;
}

/** Day-of-week of the first dropped aerobic session, for slotting the offer. */
function firstDroppedAerobicDay(ungated: Week | null, gatedDays: Set<number>): number | null {
  for (const w of ungated?.triWorkouts ?? []) {
    const t = (w.t || '') as string;
    const isAero = t.startsWith('hyrox_run_') || t === 'hyrox_brick' || t === 'hyrox_mini_brick';
    const day = (w as { dayOfWeek?: number }).dayOfWeek;
    if (isAero && typeof day === 'number' && !gatedDays.has(day)) return day;
  }
  return null;
}

/**
 * Aerobic training time the injury freed up in the current week, in minutes:
 * un-gated aerobic minutes minus what survived the gate. Computed from the real
 * generator (regenerate the week with the injury cleared) so the number is
 * sourced, not invented. Returns 0 when nothing was freed.
 */
async function freedAerobic(state: SimulatorState): Promise<{ minutes: number; day: number | null }> {
  const wkIndex = state.w ?? 1;
  const gated = state.wks?.[wkIndex - 1] ?? null;
  const { regenerateHyroxWeek } = await import('@/workouts/plan_engine.hyrox');
  const ungatedState = { ...state, injuryState: undefined } as SimulatorState;
  const ungated = regenerateHyroxWeek(ungatedState, wkIndex);

  const minutes = Math.max(0, aerobicMinutes(ungated) - aerobicMinutes(gated));
  // Days that still hold an aerobic session after gating (avoid double-booking).
  const gatedDays = new Set<number>();
  for (const w of gated?.triWorkouts ?? []) {
    const t = (w.t || '') as string;
    if (t.startsWith('hyrox_run_') || t === 'hyrox_brick' || t === 'hyrox_mini_brick') {
      const d = (w as { dayOfWeek?: number }).dayOfWeek;
      if (typeof d === 'number') gatedDays.add(d);
    }
  }
  return { minutes, day: firstDroppedAerobicDay(ungated, gatedDays) };
}

function shortAvoidLabel(inj: InjuryState): string {
  // Mirrors the strength generator's short location phrasing without importing it.
  const loc = inj.location || 'other';
  return loc.replace(/_/g, ' ');
}

/**
 * Build the safe-session offers for the current HYROX week. Returns [] when no
 * active injury or nothing safe is available. Pure (no state mutation).
 */
export async function buildHyroxCapabilityOffers(state: SimulatorState): Promise<CapabilityOffer[]> {
  const inj = state.injuryState;
  if (!inj?.active || inj.injuryPhase === 'resolved') return [];

  const offers: CapabilityOffer[] = [];

  // Aerobic substitute for freed run/brick time ("you can still pedal").
  const { minutes, day } = await freedAerobic(state);
  const aero = minutes > 0 ? pickAerobicSubstitute(inj) : null;
  if (aero && minutes > 0) {
    const rpe = RPE_BY_PHASE[inj.injuryPhase] ?? 4;
    const workout: Workout = {
      t: 'cross_training',
      n: `${aero.label}: aerobic maintenance`,
      d: `${minutes} min easy, conversational effort. Holds your aerobic engine while your ${shortAvoidLabel(inj)} recovers, with no impact on it.`,
      r: rpe,
      rpe,
      estimatedDurationMin: minutes,
      ...(day != null ? { dayOfWeek: day } : {}),
      modReason: `${aero.label} substitutes the running you can't currently do.`,
    } as Workout;
    offers.push({ workout, reason: `${aero.label.toLowerCase()} for the run time you can't use` });
  }

  // Region-safe strength (existing generator).
  const strength = injuryStrengthDecision(inj);
  if (strength.kind === 'adapted') {
    offers.push({ workout: strength.workout, reason: 'a strength session that avoids the injured area' });
  }

  return offers;
}
