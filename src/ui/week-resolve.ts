import type { SimulatorState } from '@/types';
import { generateWeekWorkouts } from '@/workouts';
import { getTrailingEffortScore } from '@/calculations/fitness-model';
import { findWorkoutForMod, modDisplayDescription } from '@/workouts/workout-scaling';
import { applyIllnessMods } from '@/calculations/illness-rules';
import { applyHolidayMods, isWeekInHoliday, getHolidayDaysForWeek, applyBridgeMods_renderTime } from './holiday-modal';
import { isTimingMod } from '@/cross-training/timing-mod-reason';
import { calculateWorkoutLoad } from '@/workouts/load';
import { dropPreOnboardSessions } from './workout-status';
import { isPlannedAdhocId } from '@/workouts/planned-adhoc';
import { renderLayerOf } from '@/workouts/render-layer';

export interface ResolveWeekOptions {
  /**
   * Apply the render-time layers (illness, holiday, post-holiday bridge). Default
   * true: the week exactly as the Plan tab shows it. With false the week stops after
   * the plan layers (generation, planned adhoc sessions, accepted changes, moves,
   * pre-onboarding drop); each session a render layer would adjust is tagged with
   * that layer as `renderLayer` but keeps the values the plan prescribes. See
   * resolveWeekForPlanChanges.
   */
  renderLayers?: boolean;
}

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
 * Steps 5 to 7 are display only (pass `renderLayers: false`, or use
 * resolveWeekForPlanChanges, for a week a mod is written against).
 *
 * This is the single source of truth for "what is this week's plan?". Both the
 * Plan tab (plan-view.computeRenderedWorkouts) and the Home Today card read from
 * it so the two surfaces can never disagree about what the next workout is.
 * See CLAUDE.md → "Two numbers that mean the same thing must come from the same
 * source": the Home "Next:" line and the Plan tab once diverged because Home
 * re-implemented only a fraction of this (moves only), skipping intermediate
 * sessions that mods/adhoc/illness/holiday had added or reshaped.
 */
export function resolveWeekWorkouts(s: SimulatorState, viewWeek: number, opts: ResolveWeekOptions = {}): any[] {
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
    // Planned sessions injected into the plan (user-added, holiday, benchmark
    // check-in) render as cards. Synced activities stay out: they are actuals.
    for (const aw of wk.adhocWorkouts) {
      if (isPlannedAdhocId(aw.id)) {
        // A copy: the mod, move and illness passes below write onto these objects,
        // and the stored adhoc session must stay the unmodified plan.
        workouts.push({ ...aw });
      }
    }
  }

  if (wk?.workoutMods) {
    for (const mod of wk.workoutMods) {
      // Timing suggestions carry the session's stable id (so a drag-moved session
      // still matches, mods being applied before moves); legacy ones match by name.
      const w = isTimingMod(mod.modReason) && !mod.workoutId
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
          // A reduced or replaced session's aerobic/anaerobic load follows its new
          // prescription, priced exactly as the generator priced the original
          // (generator.ts, calculateWorkoutLoad(t, d, rpe × 10, easy pace)). The
          // cross-training suggester sizes cuts from these loads, so a cut session
          // must not keep its full pre-cut load.
          if (mod.status === 'reduced' || mod.status === 'replaced') {
            const loads = calculateWorkoutLoad((w as any).t, (w as any).d, ((w as any).rpe || (w as any).r || 5) * 10, s.pac?.e);
            (w as any).aerobic = loads.aerobic;
            (w as any).anaerobic = loads.anaerobic;
          }
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

  if (opts.renderLayers === false) {
    // Plan layers only. The render layers run on a copy so each session records
    // which layer would adjust it, without taking that layer's values.
    const shadow = workouts.map((w: any) => ({ ...w }));
    applyRenderLayers(s, viewWeek, isCurrentWeek, wk, shadow);
    workouts.forEach((w: any, i: number) => {
      const layer = renderLayerOf(shadow[i]);
      if (layer) w.renderLayer = layer;
    });
  } else {
    applyRenderLayers(s, viewWeek, isCurrentWeek, wk, workouts);
  }

  // Reduced partial first week: drop sessions on days before the user onboarded
  // (mid-week start), so week 1 begins today instead of showing uncompletable
  // earlier-day cards. No-op for established plans and Sat/Sun onboards.
  return dropPreOnboardSessions(workouts, s.planStartDate, viewWeek, s.w, s.planCreatedAt);
}

/**
 * Steps 5 to 7: illness (current week only), holiday (weeks inside the holiday
 * window) and comeback-bridge scaling. These are recomputed from live state on
 * every render, so their output is display only and never persisted into a mod.
 */
function applyRenderLayers(s: SimulatorState, viewWeek: number, isCurrentWeek: boolean, wk: any, workouts: any[]): void {
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
}

/**
 * The week a plan change is sized from and written against: the canonical resolver
 * with the plan layers only (resolveWeekWorkouts with renderLayers false).
 *
 * Every flow that WRITES a mod reads this (cross-training review and auto-process,
 * the silent Tier-1 trim, ACWR Reduce, the excess-load card, the GPS extra-run
 * suggester, manual log, timing suggestions, the readiness recovery change). The
 * illness, holiday and bridge layers are re-applied at render on top of every mod,
 * so a mod sized from their output was applied twice and kept the illness- or
 * bridge-scaled distance after the illness or holiday ended. A session such a
 * layer adjusts carries `renderLayer` (workouts/render-layer.ts) so a flow can
 * leave it alone. Matching and display keep the full resolver.
 *
 * Running mode only (hasRunningPlanWeek). In just-track, triathlon, cycling and
 * HYROX the running engine's week is shown nowhere, so this returns [] and every
 * flow above finds no session to cut and writes no mod. resolveWeekWorkouts itself
 * stays ungated: the activity matcher's regenerateWeekWorkouts reads it.
 */
export function resolveWeekForPlanChanges(s: SimulatorState, viewWeek: number): any[] {
  if (!hasRunningPlanWeek(s)) return [];
  return resolveWeekWorkouts(s, viewWeek, { renderLayers: false });
}

/**
 * True when the user's plan is the running engine's week, the only plan a running
 * plan change (wk.workoutMods) reaches. Just-track has no plan. Triathlon, cycling
 * (eventType 'triathlon') and HYROX store their plan in wk.triWorkouts, and
 * resolveTriWeekWorkouts never applies wk.workoutMods, so a running mod written
 * there changes nothing the user can see. Planning side.
 */
export function hasRunningPlanWeek(s: Pick<SimulatorState, 'trackOnly' | 'eventType'>): boolean {
  return !s.trackOnly && s.eventType !== 'triathlon' && s.eventType !== 'hyrox';
}
