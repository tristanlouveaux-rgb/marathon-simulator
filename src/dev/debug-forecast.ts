/**
 * window.__debugForecast() — recomputes the live race forecast for the current
 * state and prints all inputs, the horizon-model components, and the final
 * times. Use to verify that the displayed forecast matches what the model
 * actually produces from current state (catches stale forecasts and silent
 * clamps).
 */

import { getState } from '@/state';
import { calculateLiveForecast } from '@/calculations/predictions';
import {
  getPlanPrescribedMeanWeeklyKm,
  applyTrainingHorizonAdjustment,
} from '@/calculations/training-horizon';
import { applyRunningCourseFactors } from '@/calculations/course-factors-running';
import { MARATHON_COURSE_PROFILES } from '@/data/marathon-course-profiles';
import { getAbilityBand } from '@/calculations/fatigue';
import { TAPER_NOMINAL } from '@/constants';
import { ft } from '@/utils/format';
import { tv } from '@/calculations/vdot';
import { getRunnerType } from '@/calculations/fatigue';

export function installDebugForecast(): void {
  (window as any).__debugForecast = () => {
    const s = getState();
    if (!s.rd) {
      console.warn('[debugForecast] no race distance set');
      return;
    }
    const distKm = s.rd === '5k' ? 5
      : s.rd === '10k' ? 10
      : s.rd === 'half' ? 21.0975
      : 42.195;

    const weeksRemaining = Math.max(1, (s.tw ?? 0) - ((s.w ?? 1) - 1));
    const sessionsForHorizon = (s.epw || s.rw || 0)
      + (s.commuteConfig?.enabled ? s.commuteConfig.commuteDaysPerWeek : 0);
    const planMeanKm = getPlanPrescribedMeanWeeklyKm(sessionsForHorizon, s.rd);
    const abilityBand = getAbilityBand(s.v ?? 0);

    console.group('%c[debugForecast]', 'color:#2563eb;font-weight:bold');

    console.log('Inputs:', {
      vdot: s.v,
      ability_band: abilityBand,
      target_distance: s.rd,
      weeks_remaining: weeksRemaining,
      sessions_per_week: sessionsForHorizon,
      plan_mean_km: planMeanKm,
      wkm_state: s.wkm,
      runner_type: s.typ,
      experience_level: s.onboarding?.experienceLevel ?? 'intermediate',
      adaptation_ratio: s.adaptationRatio,
      hm_pb_sec: s.pbs?.h,
      lt_pace_sec_per_km: s.lt,
      blended_anchor_sec: s.blendedRaceTimeSec,
      timp: s.timp,
    });

    const horizon = applyTrainingHorizonAdjustment({
      baseline_vdot: s.v ?? 0,
      target_distance: s.rd,
      weeks_remaining: weeksRemaining,
      sessions_per_week: sessionsForHorizon,
      runner_type: getRunnerType(s.b ?? 0),
      ability_band: abilityBand,
      taper_weeks: TAPER_NOMINAL[s.rd] ?? 2,
      experience_level: s.onboarding?.experienceLevel || 'intermediate',
      weekly_volume_km: planMeanKm ?? s.wkm,
      hm_pb_seconds: s.pbs?.h || undefined,
      lt_pace_sec_per_km: s.lt || undefined,
    });

    console.log('Horizon model output:', {
      improvement_pct: horizon.improvement_pct.toFixed(2) + '%',
      vdot_gain: horizon.vdot_gain.toFixed(2),
      week_factor: horizon.components.week_factor.toFixed(3),
      session_factor: horizon.components.session_factor.toFixed(3),
      type_modifier: horizon.components.type_modifier.toFixed(3),
      undertrain_penalty: horizon.components.undertrain_penalty.toFixed(2),
      taper_bonus: horizon.components.taper_bonus.toFixed(2),
    });

    const live = calculateLiveForecast({
      currentVdot: s.v ?? 0,
      targetDistance: s.rd,
      weeksRemaining,
      sessionsPerWeek: sessionsForHorizon,
      runnerType: getRunnerType(s.b ?? 0),
      experienceLevel: s.onboarding?.experienceLevel || 'intermediate',
      weeklyVolumeKm: planMeanKm ?? s.wkm,
      hmPbSeconds: s.pbs?.h || undefined,
      ltPaceSecPerKm: s.lt || undefined,
      adaptationRatio: s.adaptationRatio,
      blendedAnchorSec: s.blendedRaceTimeSec ?? s.initialBaseline ?? undefined,
    });

    const profile = s.selectedMarathon?.profile
      ?? (s.selectedMarathon?.id ? MARATHON_COURSE_PROFILES[s.selectedMarathon.id] : undefined);
    const todayAtVenue = s.blendedRaceTimeSec && profile
      ? applyRunningCourseFactors(s.blendedRaceTimeSec, profile, distKm).adjustedSec
      : s.blendedRaceTimeSec ?? 0;
    const forecastAtVenue = profile
      ? applyRunningCourseFactors(live.forecastTime, profile, distKm).adjustedSec
      : live.forecastTime;

    console.log('Times:', {
      bare_today_from_vdot: ft(tv(s.v ?? 0, distKm)),
      blended_today_flat: s.blendedRaceTimeSec ? ft(s.blendedRaceTimeSec) : 'unset',
      blended_today_at_venue: ft(todayAtVenue),
      forecast_flat_recomputed: ft(live.forecastTime),
      forecast_at_venue_recomputed: ft(forecastAtVenue),
    });

    console.log('Stored state values (what UI displays):', {
      s_forecastTime: s.forecastTime ? ft(s.forecastTime) : 'unset',
      s_forecastTimeAdjusted: s.forecastTimeAdjusted ? ft(s.forecastTimeAdjusted) : 'unset',
      s_initialBaseline: s.initialBaseline ? ft(s.initialBaseline) : 'unset',
      s_currentFitness: s.currentFitness ? ft(s.currentFitness) : 'unset',
    });

    const driftSec = Math.round(forecastAtVenue - (s.forecastTimeAdjusted ?? live.forecastTime));
    if (Math.abs(driftSec) > 30) {
      console.warn(
        `[drift] Recomputed forecast differs from stored by ${driftSec}s — stored value is stale or was computed with different inputs.`,
      );
    } else {
      console.log(`[drift] Recomputed forecast matches stored (Δ ${driftSec}s).`);
    }

    console.log('Training-vs-today delta:',
      `${Math.round((forecastAtVenue - todayAtVenue) / 60)} min`,
    );

    console.groupEnd();
  };
}
