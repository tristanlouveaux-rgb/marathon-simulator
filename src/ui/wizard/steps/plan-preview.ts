import type { OnboardingState, MilestoneTarget } from '@/types/onboarding';
import { findNearestMilestone } from '@/types/onboarding';
import { getState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { completeOnboarding, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { ft } from '@/utils/format';
import {
  getRunnerType,
  calculateLiveForecast
} from '@/calculations';

/**
 * Render the plan preview page (Step 9)
 * Shows target time with milestone detection
 */
export function renderPlanPreview(container: HTMLElement, state: OnboardingState): void {
  const s = getState();
  const initialTime = s.initialBaseline || 0;
  const raceDistance = s.rd;
  const totalWeeks = s.tw;

  // Recalculate forecast using the centralized function (single source of truth)
  const { forecastTime } = calculateLiveForecast({
    currentVdot: s.v || 50,
    targetDistance: s.rd,
    weeksRemaining: s.tw || 16,
    sessionsPerWeek: (s.epw || s.rw || 4) + (s.commuteConfig?.enabled ? s.commuteConfig.commuteDaysPerWeek : 0),
    runnerType: getRunnerType(s.b || 1.06),
    experienceLevel: s.onboarding?.experienceLevel || 'intermediate',
    weeklyVolumeKm: s.wkm,
    hmPbSeconds: s.pbs?.h || undefined,
    ltPaceSecPerKm: s.lt || undefined,
  });

  // Check for nearby milestone
  const milestone = findNearestMilestone(forecastTime, raceDistance, 0.05, state.experienceLevel || 'intermediate');
  const showMilestonePopup = milestone && !state.acceptedMilestoneChallenge && state.targetMilestone === null;

  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(10, 10)}

      <div class="max-w-lg w-full">
        <!-- Title -->
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Your Training Plan
        </h2>
        <p class="text-gray-400 text-center mb-8">
          ${totalWeeks} weeks to race day
        </p>

        <!-- Target Time Card -->
        <div class="bg-gradient-to-br from-emerald-900/30 to-gray-800 rounded-xl p-6 mb-6 border border-emerald-800/30">
          <div class="text-center">
            <div class="text-sm text-gray-400 mb-2">Predicted Finish Time</div>
            <div class="text-5xl font-bold text-emerald-400 mb-2">
              ${ft(state.targetMilestone ? state.targetMilestone.time : forecastTime)}
            </div>
            <div class="text-sm text-gray-500">
              ${getDistanceLabel(raceDistance)}
            </div>

            ${state.targetMilestone ? `
              <div class="mt-3 inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-950/50 rounded-full border border-emerald-700/50">
                <svg class="w-4 h-4 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/>
                </svg>
                <span class="text-sm text-emerald-300 font-medium">Targeting ${state.targetMilestone.label}</span>
              </div>
            ` : ''}
          </div>

          <!-- Improvement indicator -->
          <div class="mt-4 pt-4 border-t border-gray-700/50 flex justify-between text-sm">
            <div>
              <span class="text-gray-500">Current fitness:</span>
              <span class="text-gray-300 ml-1">${ft(initialTime)}</span>
            </div>
            <div class="text-emerald-400">
              ${formatImprovement(initialTime, state.targetMilestone ? state.targetMilestone.time : forecastTime)}
            </div>
          </div>
        </div>

        <!-- Disclaimer Banner -->
        <div class="bg-amber-950/20 border border-amber-800/30 rounded-xl p-4 mb-6">
          <div class="flex gap-3">
            <svg class="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
            </svg>
            <div>
              <p class="text-sm text-amber-300/90 font-medium">Adaptive prediction</p>
              <p class="text-xs text-gray-400 mt-1">
                This time will evolve as you train. The algorithm learns from your paces,
                heart rate data, and workout feedback to update your prediction weekly.
              </p>
            </div>
          </div>
        </div>

        <!-- Plan Summary -->
        <div class="bg-gray-800 rounded-xl p-4 mb-6">
          <h3 class="text-sm font-medium text-white mb-3">Plan Summary</h3>
          <div class="grid grid-cols-2 gap-3 text-sm">
            <div class="flex justify-between">
              <span class="text-gray-400">Runs per week</span>
              <span class="text-white">${s.rw}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">Weekly volume</span>
              <span class="text-white">~${s.wkm}km</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">Runner type</span>
              <span class="text-white">${s.typ}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">Starting VDOT</span>
              <span class="text-white flex items-center gap-1">
                ${s.v.toFixed(1)}
                <button id="vdot-info" class="text-gray-500 hover:text-emerald-400 transition-colors">
                  <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/>
                  </svg>
                </button>
              </span>
            </div>
            ${s.initialLT ? `
            <div class="flex justify-between">
              <span class="text-gray-400">LT Threshold</span>
              <span class="text-white">${formatLTPace(s.initialLT)}/km</span>
            </div>
            ` : ''}
            ${s.initialVO2 ? `
            <div class="flex justify-between">
              <span class="text-gray-400">VO2 Max</span>
              <span class="text-white">${s.initialVO2.toFixed(1)} ml/kg/min</span>
            </div>
            ` : ''}
          </div>
        </div>

        <!-- Start Training Button -->
        <button id="start-training"
          class="w-full py-4 bg-emerald-600 hover:bg-emerald-500
                 text-white font-medium text-lg rounded-xl transition-all
                 shadow-lg shadow-emerald-900/30">
          Start Training
        </button>
      </div>

      ${renderBackButton(true)}
    </div>

    <!-- Milestone Popup -->
    ${showMilestonePopup && milestone ? renderMilestonePopup(milestone, forecastTime) : ''}
  `;

  wireEventHandlers(state, milestone);
}

function renderMilestonePopup(milestone: MilestoneTarget, currentForecast: number): string {
  const timeDiff = currentForecast - milestone.time;
  const percentAway = ((timeDiff / milestone.time) * 100).toFixed(1);

  return `
    <div id="milestone-popup" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
      <div class="bg-gray-900 rounded-2xl p-6 max-w-sm w-full border border-emerald-800/50 shadow-2xl">
        <div class="text-center mb-6">
          <div class="w-16 h-16 bg-emerald-950/50 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg class="w-8 h-8 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/>
            </svg>
          </div>
          <h3 class="text-xl font-bold text-white mb-2">You're close to a milestone!</h3>
          <p class="text-gray-400 text-sm">
            You're only <span class="text-emerald-400 font-medium">${percentAway}%</span> away from
            <span class="text-white font-medium">${milestone.label}</span>
          </p>
        </div>

        <div class="bg-gray-800 rounded-xl p-4 mb-6">
          <div class="flex justify-between items-center mb-3">
            <span class="text-gray-400 text-sm">Current prediction</span>
            <span class="text-white font-medium">${ft(currentForecast)}</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-gray-400 text-sm">Milestone target</span>
            <span class="text-emerald-400 font-bold">${ft(milestone.time)}</span>
          </div>
        </div>

        <p class="text-xs text-gray-400 mb-6 text-center">
          ${milestone.extraWorkout}
        </p>

        <div class="flex gap-3">
          <button id="decline-milestone"
            class="flex-1 py-3 bg-gray-700 hover:bg-gray-600
                   text-gray-200 font-medium rounded-xl transition-all">
            No thanks
          </button>
          <button id="accept-milestone"
            class="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500
                   text-white font-medium rounded-xl transition-all">
            Let's go!
          </button>
        </div>
      </div>
    </div>
  `;
}

function getDistanceLabel(distance: string): string {
  switch (distance) {
    case '5k': return '5K';
    case '10k': return '10K';
    case 'half': return 'Half Marathon';
    case 'marathon': return 'Marathon';
    default: return distance;
  }
}

function formatImprovement(initial: number, forecast: number): string {
  const diff = initial - forecast;
  if (diff <= 0) return 'Maintain fitness';

  const minutes = Math.floor(diff / 60);
  const seconds = Math.floor(diff % 60);

  if (minutes > 0) {
    return `↓ ${minutes}m ${seconds}s improvement`;
  }
  return `↓ ${seconds}s improvement`;
}

function formatLTPace(secPerKm: number): string {
  const min = Math.floor(secPerKm / 60);
  const sec = Math.floor(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function showVDOTExplanation(): void {
  const popup = document.createElement('div');
  popup.id = 'vdot-popup';
  popup.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6';
  popup.innerHTML = `
    <div class="bg-gray-900 rounded-2xl p-6 max-w-md w-full border border-gray-700 shadow-2xl max-h-[80vh] overflow-y-auto">
      <div class="flex justify-between items-start mb-4">
        <h3 class="text-xl font-semibold text-white">What is VDOT?</h3>
        <button id="close-vdot" class="text-gray-500 hover:text-white">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="space-y-4 text-sm">
        <p class="text-gray-300">
          VDOT is a running performance metric developed by legendary coach
          <strong class="text-white">Jack Daniels</strong>. It represents your
          current running fitness level as a single number.
        </p>

        <div class="bg-gray-800 rounded-lg p-4">
          <h4 class="text-emerald-400 font-medium mb-2">How it works</h4>
          <p class="text-gray-400 text-xs">
            VDOT is calculated from your race times and correlates closely with
            VO2 max, but also accounts for running economy. A higher VDOT means
            better running fitness.
          </p>
        </div>

        <div class="bg-gray-800 rounded-lg p-4">
          <h4 class="text-emerald-400 font-medium mb-2">Example VDOT values</h4>
          <ul class="text-xs text-gray-400 space-y-1">
            <li><span class="text-white">30-35:</span> Beginner runners</li>
            <li><span class="text-white">40-45:</span> Recreational runners</li>
            <li><span class="text-white">50-55:</span> Competitive club runners</li>
            <li><span class="text-white">60-65:</span> Sub-elite / fast amateurs</li>
            <li><span class="text-white">70+:</span> Elite professionals</li>
          </ul>
        </div>

        <div class="bg-gray-800 rounded-lg p-4">
          <h4 class="text-emerald-400 font-medium mb-2">Why we use it</h4>
          <p class="text-gray-400 text-xs">
            Your VDOT determines your training paces across all zones (easy, tempo,
            interval, etc.). As your fitness improves and VDOT increases, your
            training paces are automatically adjusted.
          </p>
        </div>

        <p class="text-gray-500 text-xs italic">
          Reference: "Daniels' Running Formula" by Jack Daniels, PhD
        </p>
      </div>

      <button id="close-vdot-btn"
        class="mt-6 w-full py-3 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded-xl transition-all">
        Got it
      </button>
    </div>
  `;

  document.body.appendChild(popup);

  // Close handlers
  document.getElementById('close-vdot')?.addEventListener('click', () => popup.remove());
  document.getElementById('close-vdot-btn')?.addEventListener('click', () => popup.remove());
  popup.addEventListener('click', (e) => {
    if (e.target === popup) popup.remove();
  });
}

function wireEventHandlers(state: OnboardingState, milestone: MilestoneTarget | null): void {
  // Start training button
  document.getElementById('start-training')?.addEventListener('click', () => {
    completeOnboarding();
    // Transition to main view
    window.location.reload();
  });

  // VDOT info button
  document.getElementById('vdot-info')?.addEventListener('click', () => {
    showVDOTExplanation();
  });

  // Milestone popup handlers
  document.getElementById('accept-milestone')?.addEventListener('click', () => {
    if (milestone) {
      updateOnboarding({
        targetMilestone: milestone,
        acceptedMilestoneChallenge: true,
      });

      // Increase training intensity slightly
      const s = getState();
      updateState({
        rw: Math.min(s.rw + 1, 7),
        epw: Math.min(s.epw + 1, 10),
      });
      saveState();
    }
    closeMilestonePopup();
    rerender(state);
  });

  document.getElementById('decline-milestone')?.addEventListener('click', () => {
    updateOnboarding({ acceptedMilestoneChallenge: true });
    closeMilestonePopup();
  });
}

function closeMilestonePopup(): void {
  const popup = document.getElementById('milestone-popup');
  if (popup) {
    popup.remove();
  }
}


function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) {
        renderPlanPreview(container, currentState);
      }
    }
  });
}
