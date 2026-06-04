import type { SimulatorState } from '@/types';
import { generateWeekWorkouts } from '@/workouts';
import { getTrailingEffortScore } from '@/calculations/fitness-model';
import { findWorkoutForMod, modDisplayDescription } from '@/workouts/workout-scaling';
import { applyIllnessMods } from '@/calculations/illness-rules';
import { applyHolidayMods, isWeekInHoliday, getHolidayDaysForWeek, applyBridgeMods_renderTime } from './holiday-modal';
import { isTimingMod } from '@/cross-training/timing-check';

/**
 * Canonical resolver for a running-mode week's workout list.
 *
 * Produces the fully-resolved set of workouts for `viewWeek` with EVERY
 * render-time modifier applied, in the same order the Plan tab applies them:
 *   1. base generation (generateWeekWorkouts, honouring forceDeload)
 *   2. adhoc / holiday-injected sessions
 *   3. workoutMods (stable-id match via findWorkoutForMod; timing mods by name)
 *   4. workoutMoves (drag-and-drop day reorders)
 *   5. illness suppression (current week only)
 *   6. holiday suppression (weeks inside the holiday window)
 *   7. comeback-bridge scaling
 *
 * This is the single source of truth for "what is this week's plan?". Both the
 * Plan tab (plan-view.computeRenderedWorkouts) and the Home Today card read from
 * it so the two surfaces can never disagree about what the next workout is.
 * See CLAUDE.md → "Two numbers that mean the same thing must come from the same
 * source": the Home "Next:" line and the Plan tab once diverged because Home
 * re-implemented only a fraction of this (moves only), skipping intermediate
 * sessions that mods/adhoc/illness/holiday had added or reshaped.
 */
export function resolveWeekWorkouts(s: SimulatorState, viewWeek: number): any[] {
  const wk = s.wks?.[viewWeek - 1];
  const isCurrentWeek = viewWeek === s.w;
  // injuryState is threaded so an active running injury renders its adapted
  // week (acute/rehab/return-to-run) instead of the healthy plan. The generator
  // gates this forward-only via injuryAppliesToWeek (past weeks never rewritten),
  // and the activity matcher already regenerates with injuryState for matching
  // (activity-matcher.ts) — without this the Plan tab rendered a different week
  // than the one actuals were matched against. ISSUE-261.
  const workouts = wk
    ? generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
      s.injuryState ?? null, s.recurringActivities,
      s.onboarding?.experienceLevel, undefined, s.pac?.e, viewWeek, s.tw, s.v, s.gs,
      getTrailingEffortScore(s.wks, viewWeek), wk.scheduledAcwrStatus, (wk as any).forceDeload,
      s.onboarding?.weeklyTrainingHours, s.onboarding?.runningExcludedWorkouts,
    )
    : [];

  if (wk?.adhocWorkouts) {
    for (const aw of wk.adhocWorkouts) {
      if ((aw.id || '').startsWith('holiday-') || (aw.id || '').startsWith('adhoc-')) {
        workouts.push(aw);
      }
    }
  }

  if (wk?.workoutMods) {
    for (const mod of wk.workoutMods) {
      const w = isTimingMod(mod.modReason)
        ? workouts.find((wo: any) => wo.n === mod.name)
        : findWorkoutForMod(workouts as any[], mod);
      if (w) {
        (w as any).modReason = mod.modReason;
        if (mod.autoReduceNote != null) (w as any).autoReduceNote = mod.autoReduceNote;
        if (!isTimingMod(mod.modReason)) {
          if (mod.originalDistance != null) (w as any).originalDistance = mod.originalDistance;
          // User intensity changes re-derive their pace live (heals pre-pacing
          // mods, tracks marker updates like freshly-generated sessions do).
          (w as any).d = modDisplayDescription(mod, s.pac?.e);
          (w as any).status = mod.status;
          if (mod.newType) (w as any).t = mod.newType;
          if (mod.newRpe != null) (w as any).rpe = mod.newRpe;
          if (mod.userScaledAt) (w as any).userScaledAt = mod.userScaledAt;
          if (mod.newDurationMin != null) (w as any).estimatedDurationMin = mod.newDurationMin;
          if (mod.originalDurationMin != null) (w as any).originalDurationMin = mod.originalDurationMin;
        }
      }
    }
  }

  if (wk?.workoutMoves) {
    for (const [workoutId, newDay] of Object.entries(wk.workoutMoves)) {
      const w = workouts.find((wo: any) => (wo.id || wo.n) === workoutId);
      if (w) (w as any).dayOfWeek = newDay;
    }
  }

  const _illness = (s as any).illnessState;
  if (_illness?.active && isCurrentWeek) {
    applyIllnessMods(workouts, _illness);
  }

  const _holiday = s.holidayState;
  const _today = new Date().toISOString().split('T')[0];
  if (_holiday?.active && _today >= _holiday.startDate && _today <= _holiday.endDate
      && s.planStartDate && isWeekInHoliday(viewWeek, s.planStartDate, _holiday)) {
    const holidayDays = getHolidayDaysForWeek(viewWeek, s.planStartDate, _holiday);
    applyHolidayMods(workouts, _holiday.canRun, holidayDays);
  }

  if (wk) applyBridgeMods_renderTime(workouts, wk);

  return workouts;
}
