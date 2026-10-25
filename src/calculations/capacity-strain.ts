/**
 * Canonical capacity-anchored strain for the readiness engine.
 *
 * Every surface that feeds `strainPct` into `computeReadiness` (Home card,
 * Readiness detail page, daily-coach stance) MUST call `computeCapacityStrain`
 * instead of hand-rolling the percent, and every post-session sentence must
 * come from `postSessionNote`.
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

import type { SimulatorState, Week } from '@/types';
import { computeDayStrainTSS, computeLiveSameSignalTSB, computeTodaySignalBTSS } from './fitness-model';
import { getPlannedDayTSSContext } from '@/ui/planned-day-tss';
import { localDateKey, isOnLocalDay } from '@/utils/local-date';

export interface CapacityStrain {
  /** Today's completed Signal B TSS (sessions + passive), same number the Strain ring shows. */
  todayTSS: number;
  /**
   * Today's Signal B TSS from logged sessions alone (computeTodaySignalBTSS
   * with no passive input, the quantity hasTrainedOnDay reads). The post-session
   * verdict (tier word, injury-cap overshoot) reads this, so passive step load
   * never turns a partial session into a finished-session verdict.
   */
  sessionTSS: number;
  /** Canonical mode-aware planned TSS for today (planned-day-tss.ts). */
  plannedDayTSS: number;
  hasPlannedWorkout: boolean;
  /** A real logged session exists today (garminActuals or Garmin-imported adhoc). Anchors an unplanned day against CTL/7. */
  loggedSessionToday: boolean;
  /**
   * A training session was logged today (hasTrainedOnDay: the day's Signal B
   * TSS from its activities alone is above 0; passive step load never counts).
   * Gates every post-session sentence (postSessionNote), D8.
   */
  trainedToday: boolean;
  /** Weekly-equivalent CTL. Tri = swim+bike+run+cross EMAs; running = live same-signal CTL. */
  weeklyCtl: number;
  /** max(plannedDayTSS, weeklyCtl/7); 0 when nothing valid anchors. */
  anchorTSS: number;
  /** Today vs plan (legacy strain-ring semantics; 0 when no plan). */
  pctPlan: number;
  /** Today vs capacity anchor — feed THIS to computeReadiness.strainPct. */
  pctCapacity: number;
  /** Today's session TSS (sessionTSS) vs the same capacity anchor. Picks the post-session tier (postSessionNote); never feeds computeReadiness. */
  sessionPctCapacity: number;
  /** The capacity anchor is CTL-dominated (CTL/7 ≥ planned) — session is done, not mid-plan. */
  ctlAnchored: boolean;
  /** Injury active, a session logged today, and today's session load (sessionTSS) exceeded the capped plan by the 1.3 "Load exceeded" margin. */
  injuryCapOvershoot: boolean;
}

/**
 * A training session was logged on the local day `day`: the day's Signal B TSS
 * from its activities alone (computeTodaySignalBTSS with no passive input) is
 * above 0. Passive step and active-minute load is strain, not a session, so it
 * never makes a day "trained": a morning walk before an evening Tempo Run left
 * Home reading "Light session was the right call." (ISSUE-406 (c)). The one
 * source for "a session was logged today" on every surface, every mode
 * (StrainContext.trainedToday, CapacityStrain.trainedToday). Tracking side.
 */
export function hasTrainedOnDay(wk: Week, day: string): boolean {
  return computeTodaySignalBTSS(wk, day) > 0;
}

export function computeCapacityStrain(s: SimulatorState): CapacityStrain {
  const wk = (s.wks ?? [])[s.w - 1];
  // The strain day is the athlete's local calendar day: synced activities are
  // filed by their local start day (isOnLocalDay), physiology entries are keyed
  // by local day, and plan weekdays are local. computeDayStrainTSS reads the
  // activities and that day's physiology entry together, the call the strain
  // view makes.
  const strainDay = localDateKey(new Date());
  const todayTSS = wk ? computeDayStrainTSS(wk, strainDay, s.physiologyHistory, s.tssPerActiveMinute) : 0;
  const todayDayOfWeek = (new Date(strainDay + 'T12:00:00').getDay() + 6) % 7;

  const plannedCtx = getPlannedDayTSSContext(s, s.w);
  const plannedDayTSS = wk ? plannedCtx.plannedTSSForDay(todayDayOfWeek) : 0;
  const hasPlannedWorkout = plannedDayTSS > 0;

  // A real logged session today. todayTSS alone includes passive step /
  // active-minute TSS — a long walk on a rest day must not anchor against
  // CTL/7 and crater the score. adhocWorkouts covers Garmin imports that
  // bypass garminActuals.
  const loggedSessionToday =
    Object.values(wk?.garminActuals ?? {}).some(a => isOnLocalDay(a.startTime, strainDay))
    || (wk?.adhocWorkouts ?? []).some((w: any) => isOnLocalDay(w.garminTimestamp as string | undefined, strainDay));
  // Session-only Signal B: the day's activities with no passive input. One
  // call feeds the trained-today gate (hasTrainedOnDay's rule) and the
  // post-session verdict.
  const sessionTSS = wk ? computeTodaySignalBTSS(wk, strainDay) : 0;
  const trainedToday = sessionTSS > 0;

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
  // The post-session verdict's percent: the session alone over the same
  // anchor. pctCapacity (strain, steps included) stays the readiness input.
  const sessionPctCapacity = anchorTSS > 0 && sessionTSS > 0 ? (sessionTSS / anchorTSS) * 100 : 0;
  const ctlAnchored = dailyCtl >= plannedDayTSS;

  // Injury-cap overshoot: the 1.3 margin is the existing "Load exceeded"
  // strain-ring threshold, not a new constant. Compares the session alone
  // (sessionTSS) with the capped plan: a capped session plus a long walk is
  // not a rehab-cap breach, and steps alone never print it (D8).
  const injuryCapOvershoot = !!s.injuryState?.active && hasPlannedWorkout && trainedToday
    && sessionTSS > plannedDayTSS * 1.3;

  return {
    todayTSS, sessionTSS, plannedDayTSS, hasPlannedWorkout, loggedSessionToday, trainedToday,
    weeklyCtl, anchorTSS, pctPlan, pctCapacity, sessionPctCapacity, ctlAnchored, injuryCapOvershoot,
  };
}

/**
 * The tier copy (Big / Solid / Good training) for a strain percent. Callers go
 * through `postSessionNote`, which picks the percent and the gate; this is the
 * wording only.
 *
 * `ctlAnchored` marks the capacity-dominated case (CTL/7 ≥ planned — adhoc
 * days and small-plan days). There the session is finished, so 80–99% earns
 * acknowledgment too (Tristan, 2026-06-03: "if strain is high from 80% up, we
 * say good training"). When the planned dose dominates, 80–99% can mean a
 * session still in progress — that case keeps the caller's "Nearly at today's
 * target" copy, so the tier is gated off by default.
 *
 * `dayTSS` is the day's strain TSS, the number the Strain ring beside the
 * sentence shows (sessions plus passive step and active-minute load,
 * computeDayStrainTSS). The copy states it as the day's logged load, not as the
 * session's own figure (2026-10-22: the card showed two numbers for today when
 * the sentence quoted session TSS beside the ring).
 *
 * Rounds before comparing so the threshold matches the displayed percent.
 * Returns null below the active threshold.
 */
export function postSessionSentence(dayTSS: number, strainPct: number, opts?: { ctlAnchored?: boolean }): string | null {
  const pct = Math.round(strainPct);
  if (pct >= 130)
    return `Big session today. ${Math.round(dayTSS)} TSS logged. Rest up and prioritise recovery for the next 24 hours.`;
  if (pct >= 100)
    return `Solid session today. ${Math.round(dayTSS)} TSS logged. Rest up and recover.`;
  if (opts?.ctlAnchored && pct >= 80)
    return `Good training today. ${Math.round(dayTSS)} TSS logged, most of a typical day's load.`;
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
 * The one post-session sentence for today, every surface and every mode: Home
 * (running and HYROX through the coach line, triathlon and cycling through
 * capacityStrainNote), the coach page (derivePrimaryMessage), the Readiness
 * page's hero sentence and its Today's Strain card.
 *
 * - Gate: a session was logged today (`trainedToday`, D8). Steps alone never
 *   print a session line.
 * - Injury-cap overshoot first (its own gate in computeCapacityStrain: the
 *   session alone over the capped plan by the 1.3 "Load exceeded" margin).
 * - Then the tier word from ONE percent, `sessionPctCapacity`: today's
 *   session TSS (Signal B from the day's activities, no passive input) over
 *   the capacity anchor max(planned, CTL/7) that computeReadiness.strainPct
 *   uses. "Big session ... prioritise recovery" is a recovery prescription,
 *   defensible only when the session exceeds both the planned dose and the
 *   sustainable daily load (SCIENCE_LOG §BJ). The numerator is the session
 *   alone because passive step load is strain, not a session: with the
 *   strain numerator, a session at half the plan plus 20,000 steps read
 *   "Solid session today ... Rest up and recover." before the planned
 *   session was done (ISSUE-406 (c) class). Before 2026-10-22 the coach line
 *   read session TSS over plan and the Readiness card read strain TSS over
 *   plan, so one session read "Solid" on Home and "Big" on Readiness.
 * - The number quoted is the Strain ring's (`todayTSS`), so the sentence and
 *   the ring beside it show one number for the day.
 *
 * Null when nothing fires; the caller falls through to its own sentence.
 * Tracking side.
 */
export function postSessionNote(cs: CapacityStrain): string | null {
  if (!cs.trainedToday) return null;
  if (cs.injuryCapOvershoot) {
    return injuryCapOvershootSentence(cs.todayTSS, cs.plannedDayTSS, cs.sessionPctCapacity);
  }
  return postSessionSentence(cs.todayTSS, cs.sessionPctCapacity, { ctlAnchored: cs.ctlAnchored });
}

/**
 * The rest-day overreach sentence (isRestDayOverreached: logged sessions over
 * the plan's per-session average on a rest day). Shared by the coach line and
 * the triathlon Home and Readiness sentences, so every mode leads with it.
 */
export const REST_DAY_OVERREACH_SENTENCE = 'High load on a rest day. Recovery for upcoming sessions is impaired.';

/**
 * The triathlon readiness sentence's post-session form: postSessionNote, else
 * (with a `fallback`, the caller's chronic sentence) the trained-day
 * acknowledgment "X TSS logged today. <fallback>" on any day with a logged
 * session that lands below the tiers (Tristan, 2026-06-04: "the day you've
 * trained the commentary should at least reflect that"). Gated on
 * `trainedToday`, so passive step load never triggers it. Callers that don't
 * pass a fallback keep the tiers-or-null contract.
 */
export function capacityStrainNote(cs: CapacityStrain, fallback?: string | null): string | null {
  const note = postSessionNote(cs);
  if (note) return note;
  if (cs.trainedToday && cs.todayTSS > 0 && fallback) {
    return `${Math.round(cs.todayTSS)} TSS logged today. ${fallback}`;
  }
  return null;
}
