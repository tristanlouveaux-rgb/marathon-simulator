import type { OnboardingState } from '@/types/onboarding';
import { MILESTONE_THRESHOLDS, MILESTONE_LABELS } from '@/types/onboarding';
import type { RunnerType, RaceDistance } from '@/types/training';
import {
  cv, rd, rdKm, tv, calculateFatigueExponent,
  blendPredictions
} from '@/calculations';
import { calculateForecast } from '@/calculations/predictions';
import { initializeSimulator } from '@/state/initialization';
import { getState } from '@/state/store';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/** Volume scenario for comparison */
interface VolumeOption {
  runs: number;
  totalSessions: number;
  forecastTime: number;
  hitsTarget: boolean;
}

/**
 * Render the Assessment step (post-runner-type, pre-dashboard).
 * Shows plan selection and volume gap analysis.
 */
export function renderAssessment(container: HTMLElement, state: OnboardingState): void {
  const pbs = state.pbs;
  if (!Object.keys(pbs).length) {
    nextStep();
    return;
  }

  // Use confirmed runner type from the runner-type step, or fall back to calculated/default
  const b = calculateFatigueExponent(pbs);
  const runnerType = (state.confirmedRunnerType || state.calculatedRunnerType || 'Balanced') as RunnerType;

  // Compute baseline VDOT
  const targetDistStr = (state.raceDistance || 'half') as RaceDistance;
  const targetDistMeters = rd(targetDistStr);
  const blendedTime = blendPredictions(
    targetDistMeters, pbs,
    state.ltPace || null, state.vo2max || null,
    b, runnerType, state.recentRace
  );

  if (!blendedTime || isNaN(blendedTime) || blendedTime <= 0) {
    nextStep();
    return;
  }

  const baselineVdot = cv(targetDistMeters, blendedTime);

  // Effective cross-training sessions
  const crossSessions = calcCrossSessions(state);
  const totalSessions = state.runsPerWeek + crossSessions;
  const isSafetyCapped = totalSessions >= 8;

  // Build volume options and find reachable milestone
  const { options, target } = buildVolumeOptions(
    state.runsPerWeek, crossSessions, baselineVdot,
    state.planDurationWeeks, targetDistStr, runnerType, state
  );

  const current = options[0];
  const upgrade = options[1] || null;

  // Show upgrade whenever an option exists and not safety capped
  const showUpgrade = !isSafetyCapped && upgrade !== null;

  // Forecast-only: no upgrade available (safety capped or max volume)
  const showForecastOnly = !showUpgrade;

  const isNonEvent = state.trainingForEvent === false;
  const focusLabel = state.trainingFocus === 'speed' ? 'Speed' : state.trainingFocus === 'endurance' ? 'Endurance' : 'Balanced';

  // Non-event users get a different page entirely
  if (isNonEvent) {
    container.innerHTML = `
      <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
        ${renderProgressIndicator(8, 8)}

        <div class="max-w-xl w-full">
          <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
            Your Training Plan
          </h2>
          <p class="text-gray-400 text-center mb-8">
            Continuous training with periodic check-ins to track your progress.
          </p>

          <div class="space-y-6">

            <!-- Training Structure -->
            <div class="bg-gray-900 rounded-xl p-6 border border-gray-800">
              <div class="space-y-4">
                <div class="flex items-center gap-3 p-4 rounded-lg bg-emerald-950/30 border border-emerald-800/50">
                  <div class="w-10 h-10 bg-emerald-900/50 rounded-full flex items-center justify-center flex-shrink-0">
                    <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                    </svg>
                  </div>
                  <div>
                    <div class="text-sm font-medium text-emerald-300">Continuous ${focusLabel} Training</div>
                    <div class="text-xs text-gray-400">4-week repeating blocks — 3 weeks training + 1 week recovery with optional check-in</div>
                  </div>
                </div>

                <div class="grid grid-cols-2 gap-3 text-center">
                  <div class="p-3 rounded-lg bg-gray-800/50 border border-gray-700">
                    <div class="text-xs text-gray-500 mb-1">Runs / Week</div>
                    <div class="text-lg font-medium text-white">${state.runsPerWeek}</div>
                  </div>
                  <div class="p-3 rounded-lg bg-gray-800/50 border border-gray-700">
                    <div class="text-xs text-gray-500 mb-1">Starting VDOT</div>
                    <div class="text-lg font-medium text-white">${baselineVdot.toFixed(1)}</div>
                  </div>
                </div>

                <p class="text-xs text-gray-500 leading-relaxed">
                  Your plan has no fixed end date. Every 4 weeks you'll get an optional fitness check-in.
                  Paces and workouts adjust automatically as you progress. Skip check-ins anytime — no penalty.
                </p>
              </div>

              <button id="btn-select-current"
                class="w-full mt-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition-all">
                Start Training
              </button>
            </div>

          </div>

        </div>
        ${renderBackButton(true)}
      </div>
    `;

    wireHandlers(state, runnerType, upgrade, showUpgrade);
    return;
  }

  // ---- Race/event users: plan selection ----
  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(8, 8)}

      <div class="max-w-xl w-full">
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Choose Your Plan
        </h2>
        <p class="text-gray-400 text-center mb-8">
          Your predicted race time based on your profile and training volume.
        </p>

        <div class="space-y-6">

          <!-- PLAN SELECTION -->
          <div class="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h3 class="text-lg font-medium text-white mb-1">Plan Outcome</h3>
            <p class="text-xs text-gray-500 mb-5">
              Forecasts are adaptive and will evolve based on your actual training execution.
            </p>

            ${showForecastOnly ? `
              <!-- Scenario C: Forecast Only -->
              <div class="p-4 rounded-lg bg-gray-800/50 border border-gray-700">
                <div class="flex items-center justify-between mb-3">
                  <div class="text-sm text-gray-300 font-medium">Current Forecast Time: ${formatTime(current.forecastTime)}</div>
                </div>
                <p class="text-xs text-gray-500 leading-relaxed">
                  This forecast is adaptive and will update as you train. Consistency is key.
                </p>
              </div>

              ${isSafetyCapped ? `
                <div class="mt-3 p-3 bg-amber-950/30 border border-amber-900/50 rounded-lg flex gap-3">
                  <svg class="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                  </svg>
                  <div class="text-xs text-amber-200">
                    Volume capped at 8 sessions/week to reduce injury risk.
                  </div>
                </div>
              ` : ''}

              <!-- Continue button (forecast only) -->
              <button id="btn-select-current"
                class="w-full mt-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition-all">
                Continue to Dashboard
              </button>
            ` : `
              <div class="space-y-3">
                <!-- Only show "Hits Target" when the plans straddle a milestone -->
                <!-- (i.e. one hits it and the other doesn't — otherwise it's noise) -->
                <!-- Card A: Current Plan (clickable) -->
                <button id="btn-select-current" class="w-full text-left flex items-center justify-between p-4 rounded-lg bg-gray-800/50 border ${current.hitsTarget && !(upgrade?.hitsTarget) ? 'border-emerald-700' : 'border-gray-700'} hover:bg-gray-700/50 transition-colors cursor-pointer">
                  <div>
                    <div class="text-sm text-gray-300 font-medium flex items-center gap-2">
                      Current Plan
                      ${current.hitsTarget && !(upgrade?.hitsTarget) ? '<span class="text-xs text-emerald-400">Hits Target</span>' : ''}
                    </div>
                    <div class="text-xs text-gray-500 mt-0.5">${state.runsPerWeek} runs / week</div>
                  </div>
                  <div class="text-right">
                    <div class="text-lg font-mono text-white">${formatTime(current.forecastTime)}</div>
                    <div class="text-[10px] text-gray-500 uppercase tracking-wider">Predicted</div>
                  </div>
                </button>

                ${showUpgrade && upgrade ? `
                  <!-- Card B: Harder Plan (clickable) -->
                  <button id="btn-select-harder" class="w-full text-left flex items-center justify-between p-4 rounded-lg bg-gray-800/50 border ${upgrade.hitsTarget && !current.hitsTarget ? 'border-emerald-700' : 'border-gray-700'} hover:bg-gray-700/50 transition-colors cursor-pointer">
                    <div>
                      <div class="text-sm text-gray-300 font-medium flex items-center gap-2">
                        Harder Plan
                        ${upgrade.hitsTarget && !current.hitsTarget ? '<span class="text-xs text-emerald-400">Hits Target</span>' : ''}
                      </div>
                      <div class="text-xs text-gray-500 mt-0.5">${upgrade.runs} runs / week</div>
                    </div>
                    <div class="text-right">
                      <div class="text-lg font-mono text-white">${formatTime(upgrade.forecastTime)}</div>
                      <div class="text-[10px] text-gray-500 uppercase tracking-wider">Predicted</div>
                    </div>
                  </button>

                  ${upgrade.totalSessions > 7 ? `
                    <div class="p-3 bg-amber-950/30 border border-amber-900/50 rounded-lg flex gap-3">
                      <svg class="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                      </svg>
                      <div class="text-xs text-amber-200">
                        ${upgrade.totalSessions} total sessions/wk including cross-training. Monitor recovery closely.
                      </div>
                    </div>
                  ` : ''}
                ` : ''}
              </div>
            `}
          </div>

        </div>

      </div>
      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers(state, runnerType, upgrade, showUpgrade);
}

function wireHandlers(
  state: OnboardingState,
  runnerType: RunnerType,
  upgrade: VolumeOption | null,
  showUpgrade: boolean
): void {
  // Select Current Plan / Continue
  document.getElementById('btn-select-current')?.addEventListener('click', () => {
    nextStep();
  });

  // Select Harder Plan
  if (showUpgrade && upgrade) {
    document.getElementById('btn-select-harder')?.addEventListener('click', () => {
      updateOnboarding({ runsPerWeek: upgrade.runs });
      // Only re-initialize if not mid-plan (avoid destroying progress)
      const currentState = getState();
      const isMidPlan = currentState.hasCompletedOnboarding && currentState.w > 1;
      if (!isMidPlan) {
        initializeSimulator({
          ...state,
          runsPerWeek: upgrade.runs,
          confirmedRunnerType: state.confirmedRunnerType || runnerType,
        });
      }
      nextStep();
    });
  }
}

/** Calculate effective cross-training sessions from state */
function calcCrossSessions(state: OnboardingState): number {
  const INTENSITY_FACTOR: Record<string, number> = { easy: 0.5, moderate: 0.7, hard: 0.9 };
  let cross = 0;
  if (state.recurringActivities && state.recurringActivities.length > 0) {
    for (const act of state.recurringActivities) {
      const iFactor = INTENSITY_FACTOR[act.intensity] || 0.7;
      cross += (act.durationMin / 60) * iFactor * act.frequency;
    }
  } else {
    cross = 0.5 * (state.sportsPerWeek || 0);
  }
  if (state.activeLifestyle) cross += 0.5;
  return cross;
}

/**
 * Build forecast options for current, +1, and +2 runs/week.
 * Uses applyTrainingHorizonAdjustment for forecast modelling.
 */
function buildVolumeOptions(
  runsPerWeek: number,
  crossSessions: number,
  baselineVdot: number,
  planWeeks: number,
  raceDistance: RaceDistance,
  runnerType: RunnerType,
  state: OnboardingState,
): { options: VolumeOption[]; target: { time: number; label: string } | null } {
  const options: VolumeOption[] = [];
  const maxTotal = 8;

  for (let extra = 0; extra <= 2; extra++) {
    const runs = runsPerWeek + extra;
    const total = runs + crossSessions;
    if (extra > 0 && total > maxTotal) break;

    const effectiveSessions = runs + crossSessions;

    // Use shared forecast with a temporary state override for runs
    const stateOverride = { ...state, runsPerWeek: runs };
    const forecast = calculateForecast(
      baselineVdot, effectiveSessions, stateOverride, runnerType
    );

    options.push({
      runs,
      totalSessions: Math.round(total),
      forecastTime: forecast.forecastTime,
      hitsTarget: false, // set below once we know the target
    });
  }

  // Find milestone that the options straddle (current misses, upgrade hits)
  const currentTime = options[0].forecastTime;
  const bestTime = options.length > 1
    ? Math.min(...options.slice(1).map(o => o.forecastTime))
    : currentTime;
  const target = findStraddledMilestone(currentTime, bestTime, raceDistance);
  const targetTime = target?.time ?? Infinity;

  // Mark which options hit the straddled target
  for (const opt of options) {
    opt.hitsTarget = opt.forecastTime <= targetTime;
  }

  return { options, target };
}

/**
 * Find a milestone that the current and best forecasts straddle.
 * Returns a target only when currentTime is above the threshold
 * but bestTime is at or below it — i.e., upgrading would cross the milestone.
 * If both plans beat (or both miss) every milestone, returns null.
 */
function findStraddledMilestone(
  currentTime: number,
  bestTime: number,
  raceDistance: RaceDistance,
): { time: number; label: string } | null {
  const thresholds = MILESTONE_THRESHOLDS[raceDistance];
  const labels = MILESTONE_LABELS[raceDistance];
  if (!thresholds) return null;

  // Find a milestone where current misses but best hits
  for (let i = 0; i < thresholds.length; i++) {
    if (currentTime > thresholds[i] && bestTime <= thresholds[i]) {
      return { time: thresholds[i], label: labels[i] };
    }
  }

  return null;
}

/** Format seconds to h:mm:ss or mm:ss */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
