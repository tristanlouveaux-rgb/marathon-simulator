/**
 * Canonical capacity-anchored strain for the readiness engine.
 *
 * Every surface that feeds `strainPct` into `computeReadiness` (Home card,
 * Readiness detail page, daily-coach stance) MUST call `computeCapacityStrain`
 * instead of hand-rolling the percent, and every post-session sentence must
 * come from `capacityStrainNote`.
 *
 * Why this module exists (2026-06-04 incident): the Home card and the
 * Readiness detail page each assembled their own strain percent. Home moved to
 * the capacity anchor (42 TSS / max(planned 20, CTL/7 45) = 93% → score 61)
 * while the detail page kept plan-anchored 42/20 = 210% → strain floor 10.
 * Same athlete, same moment, ring said 61 on Home and 10 "Ease Back" one tap
 * deeper. Duplicated input assembly is why "identical" surfaces can disagree;
 * this helper makes the strain input impossible to compute two ways.
 *
 * Science (SCIENCE_LOG §BJ): anchor = max(plannedDayTSS, weeklyCTL / 7).
 * An athlete is only "overreached" when today's load exceeds BOTH the planned
 * dose and the sustainable daily load (Banister CTL as the sustainable-load
 * proxy). Ring = capacity; the injury-cap overshoot message is a sentence-layer
 * concern (`injuryCapOvershootSentence`), per the standing ring-semantics
 * ruling (§BG).
 *
 * **Side of the line**: tracking. Pure function over state.
 */

import type { SimulatorState } from '@/types/state';
import { computeTodayStrainTSS, computeLiveSameSignalTSB } from './fitness-model';
import { getPlannedDayTSSContext } from '@/ui/planned-day-tss';

export interface CapacityStrain {
  /** Today's completed Signal B TSS (sessions + passive), same number the Strain ring shows. */
  todayTSS: number;
  /** Canonical mode-aware planned TSS for today (planned-day-tss.ts). */
  plannedDayTSS: number;
  hasPlannedWorkout: boolean;
  /** A real logged session exists today (garminActuals or Garmin-imported adhoc). */
  loggedSessionToday: boolean;
  /** Weekly-equivalent CTL. Tri = swim+bike+run+cross EMAs; running = live same-signal CTL. */
  weeklyCtl: number;
  /** max(plannedDayTSS, weeklyCtl/7); 0 when nothing valid anchors. */
  anchorTSS: number;
  /** Today vs plan (legacy strain-ring semantics; 0 when no plan). */
  pctPlan: number;
  /** Today vs capacity anchor — feed THIS to computeReadiness.strainPct. */
  pctCapacity: number;
  /** The capacity anchor is CTL-dominated (CTL/7 ≥ planned) — session is done, not mid-plan. */
  ctlAnchored: boolean;
  /** Injury active and today's load exceeded the capped plan by the 1.3 "Load exceeded" margin. */
  injuryCapOvershoot: boolean;
}

export function computeCapacityStrain(s: SimulatorState): CapacityStrain {
  const today = new Date().toISOString().split('T')[0];
  const wk = (s.wks ?? [])[s.w - 1];
  const todayPhysio = (s.physiologyHistory ?? []).find(e => e.date === today);
  const todayTSS = wk ? computeTodayStrainTSS(wk, today, todayPhysio, s.tssPerActiveMinute) : 0;
  const todayDayOfWeek = (new Date(today + 'T12:00:00').getDay() + 6) % 7;

  const plannedCtx = getPlannedDayTSSContext(s, s.w);
  const plannedDayTSS = wk ? plannedCtx.plannedTSSForDay(todayDayOfWeek) : 0;
  const hasPlannedWorkout = plannedDayTSS > 0;

  // A real logged session today. todayTSS alone includes passive step /
  // active-minute TSS — a long walk on a rest day must not anchor against
  // CTL/7 and crater the score. adhocWorkouts covers Garmin imports that
  // bypass garminActuals.
  const loggedSessionToday =
    Object.values(wk?.garminActuals ?? {}).some(a => a.startTime?.startsWith(today))
    || (wk?.adhocWorkouts ?? []).some((w: any) => ((w.garminTimestamp as string | undefined) ?? '').startsWith(today));

  // Weekly-equivalent CTL. Tri = per-discipline weekly EMAs + crossTrainingCtl
  // (the numerator counts ALL sports — excluding cross made every routine HIIT
  // day read as a massive overshoot). Running ctlNow is already
  // weekly-equivalent (computeLiveSameSignalTSB feeds dayTSS × 7).
  const triFit = s.eventType === 'triathlon' ? s.triConfig?.fitness : null;
  const weeklyCtl = triFit
    ? triFit.run.ctl + triFit.bike.ctl + triFit.swim.ctl + (triFit.crossTrainingCtl ?? 0)
    : computeLiveSameSignalTSB(
        s.wks ?? [], s.w, s.signalBBaseline ?? undefined, s.ctlBaseline ?? undefined,
        s.planStartDate, (s as any).previousPlanWks ?? undefined,
      ).ctl;

  // Weekly CTL < 10 is too noisy to anchor on (mirrors perDisciplineACWR's guard).
  const dailyCtl = weeklyCtl >= 10 ? weeklyCtl / 7 : 0;
  const anchorTSS = hasPlannedWorkout
    ? Math.max(plannedDayTSS, dailyCtl)
    : (loggedSessionToday ? dailyCtl : 0);

  const pctPlan = hasPlannedWorkout && todayTSS > 0 ? (todayTSS / plannedDayTSS) * 100 : 0;
  const pctCapacity = anchorTSS > 0 && todayTSS > 0 ? (todayTSS / anchorTSS) * 100 : 0;
  const ctlAnchored = dailyCtl >= plannedDayTSS;

  // Injury-cap overshoot: the 1.3 margin is the existing "Load exceeded"
  // strain-ring threshold, not a new constant.
  const injuryCapOvershoot = !!s.injuryState?.active && hasPlannedWorkout
    && todayTSS > plannedDayTSS * 1.3;

  return {
    todayTSS, plannedDayTSS, hasPlannedWorkout, loggedSessionToday,
    weeklyCtl, anchorTSS, pctPlan, pctCapacity, ctlAnchored, injuryCapOvershoot,
  };
}

/**
 * Post-session sentence shown when today's strain has reached its anchor.
 * Single source for running mode (`derivePrimaryMessage` Tier 1), the
 * tri-mode readiness-sentence override, and the Readiness detail page, so the
 * copy never diverges between surfaces.
 *
 * `ctlAnchored` marks the capacity-dominated case (CTL/7 ≥ planned — adhoc
 * days and small-plan days). There the session is finished, so 80–99% earns
 * acknowledgment too (Tristan, 2026-06-03: "if strain is high from 80% up, we
 * say good training"). When the planned dose dominates, 80–99% can mean a
 * session still in progress — that case keeps the caller's "Nearly at today's
 * target" copy, so the tier is gated off by default.
 *
 * Rounds before comparing so the threshold matches the displayed percent.
 * Returns null below the active threshold.
 */
export function postSessionSentence(actualTSS: number, strainPct: number, opts?: { ctlAnchored?: boolean }): string | null {
  const pct = Math.round(strainPct);
  if (pct >= 130)
    return `Big session today (${Math.round(actualTSS)} TSS). Rest up and prioritise recovery for the next 24 hours.`;
  if (pct >= 100)
    return `Solid session today (${Math.round(actualTSS)} TSS). Rest up and recover.`;
  if (opts?.ctlAnchored && pct >= 80)
    return `Good training today (${Math.round(actualTSS)} TSS), most of a typical day's load.`;
  return null;
}

/**
 * Sentence for a session that exceeded an injury-capped planned day by the
 * "Load exceeded" margin (actual > planned × 1.3). The readiness ring stays
 * capacity-based (ring = capacity ruling, §BG) — this sentence is the layer
 * that carries the rehab-cap message. `capacityPct` picks the second clause:
 * below 100% the load itself is normal; at 100%+ it exceeded capacity too.
 */
export function injuryCapOvershootSentence(actualTSS: number, plannedTSS: number, capacityPct: number): string {
  const lead = `${Math.round(actualTSS)} TSS logged against an injury-capped day of ${Math.round(plannedTSS)}.`;
  return Math.round(capacityPct) >= 100
    ? `${lead} That exceeds both the rehab cap and your typical daily load. Rest up and recover.`
    : `${lead} Load is within your normal range, but well above the rehab cap.`;
}

/**
 * The canonical post-session readiness sentence for a CapacityStrain —
 * injury-cap overshoot wins over the strain tiers. Null when nothing fires
 * (caller falls through to its normal chronic-load / coach sentence).
 */
export function capacityStrainNote(cs: CapacityStrain): string | null {
  if (cs.injuryCapOvershoot) {
    return injuryCapOvershootSentence(cs.todayTSS, cs.plannedDayTSS, cs.pctCapacity);
  }
  return postSessionSentence(cs.todayTSS, cs.pctCapacity, { ctlAnchored: cs.ctlAnchored });
}
