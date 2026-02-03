import type { OnboardingState } from '@/types/onboarding';
import { MILESTONE_THRESHOLDS, MILESTONE_LABELS } from '@/types/onboarding';
import type { RunnerType, RaceDistance } from '@/types/training';
import {
  cv, rd, rdKm, tv, calculateFatigueExponent, gt,
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

const TYPE_DESCRIPTIONS: Record<string, string> = {
  Speed:
    'Speed runners typically have faster 5K times relative to their marathon. Training emphasises building aerobic endurance and long-run durability.',
  Endurance:
    'Endurance runners typically maintain pace better over long distances. Training emphasises speed development and neuromuscular work.',
  Balanced:
    'Balanced runners show even performance across distances. Training blends speed and endurance work in roughly equal measure.',
};

/**
 * Render the Assessment step (post-init, pre-dashboard).
 * Shows runner type confirmation and volume gap analysis.
 */
export function renderAssessment(container: HTMLElement, state: OnboardingState): void {
  const pbs = state.pbs;
  if (!Object.keys(pbs).length) {
    nextStep();
    return;
  }

  // Compute runner type
  const b = calculateFatigueExponent(pbs);
  const typ = gt(b);
  const assessedType = (typ.charAt(0).toUpperCase() + typ.slice(1)) as RunnerType;
  const runnerType = (state.confirmedRunnerType || assessedType) as RunnerType;

  // Compute baseline VDOT
  const targetDistStr = (state.raceDistance || 'half') as RaceDistance;
  const targetDistMeters = rd(targetDistStr);
  const blendedTime = blendPredictions(
    targetDistMeters, pbs,
    state.ltPace || null, state.vo2max || null,
    b, typ, state.recentRace
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

  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(7, 7)}

      <div class="max-w-xl w-full">
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Runner Profile Assessment
        </h2>
        <p class="text-gray-400 text-center mb-8">
          Based on your PBs, we assessed you as <span id="type-heading" class="text-white font-medium">${assessedType}</span>.
        </p>

        <div class="space-y-6">

          <!-- SECTION 1: RUNNER PROFILE -->
          <div class="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <div class="grid grid-cols-3 gap-2 mb-4" id="runner-type-toggle">
              ${(['Speed', 'Balanced', 'Endurance'] as const).map(t => `
                <button data-type="${t}"
                  class="type-btn py-2.5 rounded-lg border text-sm text-center transition-all
                    ${t === runnerType
                      ? 'border-emerald-600 bg-emerald-600/20 text-emerald-400 font-medium'
                      : 'border-gray-700 text-gray-400 hover:bg-gray-800'}">
                  ${t}
                </button>
              `).join('')}
            </div>

            <div id="type-description" class="bg-gray-800/50 rounded-lg p-4">
              <p class="text-sm text-gray-400 leading-relaxed">
                ${TYPE_DESCRIPTIONS[runnerType] || TYPE_DESCRIPTIONS.Balanced}
              </p>
            </div>
          </div>

          <!-- SECTION 2: PLAN SELECTION -->
          <div class="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h3 class="text-lg font-medium text-white mb-1">Plan Outcome</h3>
            <p class="text-xs text-gray-500 mb-5">
              Forecasts are adaptive and will evolve based on your actual training execution.
            </p>

            ${target && showUpgrade && upgrade && upgrade.hitsTarget && !current.hitsTarget ? `
              <div class="p-3 mb-4 bg-emerald-950/30 border border-emerald-800/50 rounded-lg text-xs text-emerald-300 leading-relaxed">
                You're close to a <span class="text-white font-medium">${target.label}</span> finish. Adding ${upgrade.runs - state.runsPerWeek} more run${upgrade.runs - state.runsPerWeek > 1 ? 's' : ''} per week could get you there.
              </div>
            ` : ''}

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
                <!-- Card A: Current Plan (clickable) -->
                <button id="btn-select-current" class="w-full text-left flex items-center justify-between p-4 rounded-lg bg-gray-800/50 border ${current.hitsTarget ? 'border-emerald-700' : 'border-gray-700'} hover:bg-gray-700/50 transition-colors cursor-pointer">
                  <div>
                    <div class="text-sm text-gray-300 font-medium flex items-center gap-2">
                      Current Plan
                      ${current.hitsTarget ? '<span class="text-xs text-emerald-400">Hits Target</span>' : ''}
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
                  <button id="btn-select-harder" class="w-full text-left flex items-center justify-between p-4 rounded-lg bg-gray-800/50 border ${upgrade.hitsTarget ? 'border-emerald-700' : 'border-gray-700'} hover:bg-gray-700/50 transition-colors cursor-pointer">
                    <div>
                      <div class="text-sm text-gray-300 font-medium flex items-center gap-2">
                        Harder Plan
                        ${upgrade.hitsTarget ? '<span class="text-xs text-emerald-400">Hits Target</span>' : ''}
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
  // Runner type toggle buttons
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const selected = (btn as HTMLElement).dataset.type as RunnerType;

      // Update button visuals
      document.querySelectorAll('.type-btn').forEach(b => {
        b.classList.remove('border-emerald-600', 'bg-emerald-600/20', 'text-emerald-400', 'font-medium');
        b.classList.add('border-gray-700', 'text-gray-400');
      });
      btn.classList.remove('border-gray-700', 'text-gray-400');
      btn.classList.add('border-emerald-600', 'bg-emerald-600/20', 'text-emerald-400', 'font-medium');

      // Update description box
      const descEl = document.querySelector('#type-description p');
      if (descEl) descEl.textContent = TYPE_DESCRIPTIONS[selected] || TYPE_DESCRIPTIONS.Balanced;

      updateOnboarding({ confirmedRunnerType: selected });
    });
  });

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

  // Find milestone using the best (fastest) forecast time across all options
  const bestTime = Math.min(...options.map(o => o.forecastTime));
  const target = findReachableTarget(bestTime, raceDistance);
  const targetTime = target?.time ?? Infinity;

  // Now mark which options actually hit the target
  for (const opt of options) {
    opt.hitsTarget = opt.forecastTime <= targetTime;
  }

  return { options, target };
}

/**
 * Find the nearest milestone that the best forecast option can actually hit.
 * Uses time-based comparison instead of VDOT gaps to avoid misleading nudges.
 *
 * @param bestForecastTime - the fastest forecast time across all plan options
 * @param raceDistance - target race distance
 * @returns milestone if bestForecastTime beats it, null otherwise
 */
function findReachableTarget(
  bestForecastTime: number,
  raceDistance: RaceDistance,
): { time: number; label: string } | null {
  const thresholds = MILESTONE_THRESHOLDS[raceDistance];
  const labels = MILESTONE_LABELS[raceDistance];
  if (!thresholds) return null;

  // Find the fastest milestone the best plan option actually beats
  // Iterate fastest → slowest, return the first one the forecast clears
  for (let i = thresholds.length - 1; i >= 0; i--) {
    if (bestForecastTime <= thresholds[i]) {
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
