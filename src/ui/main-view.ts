import { getState, getMutableState } from '@/state/store';
import type { SimulatorState } from '@/types';
import { saveState } from '@/state/persistence';
import { render, attachTrackRunHandlers } from './renderer';
import { next, updateFitness, reset, editSettings, logActivity, setOnWeekAdvance } from './events';
import { setOnTrackingStart, setOnTrackingStop } from './gps-events';
import { attachRecordingsHandlers } from './gps-panel';
import { ft } from '@/utils/format';
import { openInjuryModal, renderInjuryBanner, isInjuryActive, markAsRecovered, getInjuryStateForDisplay } from './injury/modal';
import { applyPhaseRegression, recordMorningPain } from '@/injury/engine';
import { initializeSimulator } from '@/state/initialization';

/**
 * Check if the training plan has started (any workout has been completed/rated)
 */
function hasPlanStarted(s: SimulatorState): boolean {
  if (!s.wks) return false;
  for (const wk of s.wks) {
    if (wk.rated && Object.keys(wk.rated).length > 0) {
      // Check if at least one workout is completed (not just 'skip')
      for (const val of Object.values(wk.rated)) {
        if (val !== 'skip') return true;
      }
    }
  }
  return false;
}

/**
 * Render the main workout view after onboarding is complete
 */
export function renderMainView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;

  const s = getState();
  const isAdmin = s.isAdmin || false;
  const maxViewableWeek = isAdmin ? s.tw : Math.min(3, s.tw); // 21 days = ~3 weeks for trial

  container.innerHTML = getMainViewHTML(s, maxViewableWeek);

  // Wire up event handlers
  wireEventHandlers();

  // Initial render of workouts
  render();

  // Delegated handlers for "Track Run" and recording delete buttons
  attachTrackRunHandlers();
  attachRecordingsHandlers();

  // Wire GPS tracking lifecycle to re-render
  setOnTrackingStart(() => render());
  setOnTrackingStop(() => render());

  // Re-render full dashboard when week advances so slider resets to new s.w
  setOnWeekAdvance(() => renderMainView());
}

function getMainViewHTML(s: any, maxViewableWeek: number): string {
  const injured = isInjuryActive();
  const headerBg = injured ? 'bg-amber-950 border-b border-amber-800' : 'bg-gray-900 border-b border-gray-800';
  const titleColor = injured ? 'text-amber-300' : 'text-white';
  const subtitleColor = injured ? 'text-amber-400/70' : 'text-gray-500';

  return `
    <div class="min-h-screen bg-gray-950">
      <!-- Header - Changes color when injured -->
      <div class="${headerBg}">
        <div class="max-w-7xl mx-auto px-4 py-4">
          <div class="flex items-center justify-between">
            <div>
              <h1 class="text-xl font-semibold ${titleColor}">${injured ? 'Recovery Mode' : `${s.onboarding?.name ? s.onboarding.name + "'s" : 'Your'} Adaptive Plan`}</h1>
              <p class="text-xs ${subtitleColor}">${injured ? 'Recovery Plan Active' : `Week ${s.w} of ${s.tw} - ${getPhaseLabel(s.wks?.[s.w - 1]?.ph)}`}</p>
            </div>
            <div class="flex items-center gap-3">
              ${renderStravaButton(s.stravaConnected)}
              ${injured ? `
                <button id="btn-recovered" class="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-full text-xs font-medium transition-colors">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                  </svg>
                  I'm Recovered
                </button>
              ` : ''}
              <button id="btn-report-injury" class="flex items-center gap-1.5 px-3 py-1.5 ${injured ? 'bg-amber-600 hover:bg-amber-500' : 'bg-gray-700 hover:bg-gray-600'} text-white rounded-full text-xs font-medium transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                </svg>
                ${injured ? 'Update Injury' : 'Report Injury'}
              </button>
              <button id="btn-settings" class="p-2 text-gray-400 hover:text-white transition-colors">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="max-w-7xl mx-auto px-4 py-6">
        <!-- Just Run Banner -->
        <div id="just-run-container" class="w-full mb-4 bg-emerald-900/40 border border-emerald-700/50 rounded-xl overflow-hidden">
          <button onclick="justRun()" class="w-full p-4 flex items-center gap-3 hover:bg-emerald-800/50 transition-colors group text-left">
            <div class="flex-1">
              <span class="text-white font-semibold group-hover:text-emerald-300 transition-colors">Just Run →</span>
              <p class="text-gray-400 text-sm mt-0.5">Unstructured run — we'll fit it in your plan</p>
            </div>
          </button>
          <div id="just-run-workout" class="hidden"></div>
        </div>

        <!-- Injury Alert Banner -->
        ${renderInjuryBanner()}

        <!-- Morning Pain Check (shown when injured, once per day) -->
        ${renderMorningPainCheck(s)}

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">

          <!-- Left Column -->
          <div class="lg:col-span-1 space-y-4">

            <!-- Week Navigator -->
            <div class="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <div class="flex items-center justify-between mb-3">
                <h3 class="text-sm font-medium text-white">Week ${s.w} of ${s.tw}</h3>
                <div class="flex gap-2">
                  <button id="week-prev" class="p-2 bg-gray-800 hover:bg-gray-700 rounded transition-colors ${s.w <= 1 ? 'opacity-50 cursor-not-allowed' : ''}">
                    <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
                    </svg>
                  </button>
                  <button id="week-next" class="p-2 bg-gray-800 hover:bg-gray-700 rounded transition-colors ${s.w >= maxViewableWeek ? 'opacity-50 cursor-not-allowed' : ''}" title="${s.w >= maxViewableWeek ? 'Last viewable week' : 'Next week'}">
                    <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                    </svg>
                  </button>
                </div>
              </div>

              <!-- Week slider -->
              <input type="range" id="week-slider" min="1" max="${maxViewableWeek}" value="${s.w}"
                     class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-emerald-500">

              ${!s.isAdmin && maxViewableWeek < s.tw ? `
                <div class="mt-3 p-2 bg-amber-950/30 border border-amber-800/50 rounded text-xs text-amber-300">
                  Free trial: ${maxViewableWeek} weeks visible. Upgrade for full ${s.tw}-week plan.
                </div>
              ` : ''}
            </div>

            <!-- Controls -->
            <div class="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <h3 class="font-medium text-sm mb-3 text-white">Controls</h3>
              <div class="space-y-2">
                <button id="btn-complete-week" class="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2 rounded text-sm transition-colors">
                  Complete Week
                </button>
                <button id="btn-edit-settings" class="w-full bg-gray-700 hover:bg-gray-600 text-gray-300 py-2 rounded text-sm transition-colors">
                  Edit Settings
                </button>
                <button id="btn-reset" class="w-full bg-gray-700 hover:bg-gray-600 text-gray-300 py-2 rounded text-sm transition-colors">
                  Reset Plan
                </button>
              </div>
              <div id="st" class="mt-3 text-xs text-gray-500"></div>
            </div>

            <!-- Profile Summary (Interactive) -->
            <div class="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <div class="flex items-center justify-between mb-3">
                <h3 class="font-medium text-sm text-white">Profile</h3>
                <button id="btn-edit-profile" class="text-xs text-emerald-400 hover:text-emerald-300 transition-colors">Edit</button>
              </div>
              <div class="space-y-2 text-xs">
                <div class="flex justify-between items-center">
                  <span class="text-gray-400">Runner Type</span>
                  ${hasPlanStarted(s)
                    ? `<span class="flex items-center gap-1 px-2 py-0.5 bg-gray-800 border border-gray-700 rounded-full text-gray-400">
                        <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/></svg>
                        <span>${s.typ}</span>
                      </span>`
                    : `<button id="btn-change-runner-type" class="flex items-center gap-1 px-2 py-0.5 bg-emerald-950/50 border border-emerald-800/50 rounded-full text-emerald-400 hover:bg-emerald-900/50 hover:text-emerald-300 transition-colors cursor-pointer">
                        <span>${s.typ}</span>
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                      </button>`
                  }
                </div>
                <div>
                  <div class="flex justify-between items-center">
                    <span class="text-gray-400 cursor-pointer" id="vdot-toggle">Est. VDOT <span class="text-gray-600">(?)</span></span>
                    <span class="text-white">${s.v?.toFixed(1) || '-'}</span>
                  </div>
                  <div id="vdot-info" class="hidden mt-2 p-2 bg-blue-950/30 border border-blue-900/50 rounded text-xs text-blue-300 leading-relaxed">
                    ${s.onboarding?.trainingForEvent === false ? 'VDOT is a running fitness metric estimated from your running performance. It represents your aerobic capacity and is used to calculate training paces and performance forecasts. Higher = fitter.' : 'VDOT is a running fitness metric estimated from your race times. It represents your aerobic capacity and is used to calculate training paces and race predictions. Higher = fitter.'}
                  </div>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-400">Expected Final</span>
                  <span class="text-emerald-400">${s.expectedFinal?.toFixed(1) || '-'}</span>
                </div>
              </div>
            </div>

            <!-- Load Tracker Tab - Bar Chart (smartwatch only) -->
            ${s.onboarding?.hasSmartwatch ? `
            <div class="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <div class="flex items-center justify-between mb-3">
                <h3 class="font-medium text-sm text-white">Weekly Load</h3>
                <span id="load-status" class="text-xs px-2 py-1 rounded bg-emerald-950/50 text-emerald-400">On track</span>
              </div>
              <!-- Legend -->
              <div class="flex gap-3 text-xs mb-3">
                <span class="flex items-center gap-1"><span class="w-2 h-2 rounded bg-red-500 inline-block"></span> Plan Aerobic</span>
                <span class="flex items-center gap-1"><span class="w-2 h-2 rounded bg-red-300 inline-block"></span> Actual Aerobic</span>
                <span class="flex items-center gap-1"><span class="w-2 h-2 rounded bg-amber-500 inline-block"></span> Plan Anaerobic</span>
                <span class="flex items-center gap-1"><span class="w-2 h-2 rounded bg-amber-300 inline-block"></span> Actual Anaerobic</span>
              </div>
              <!-- Bar chart -->
              <div class="flex items-end gap-2 h-24" id="load-chart">
                <div class="flex-1 flex gap-0.5 items-end h-full">
                  <div class="flex flex-col items-center flex-1">
                    <div id="bar-plan-aero" class="w-full bg-red-500 rounded-t transition-all" style="height: 0%"></div>
                    <span class="text-xs text-gray-500 mt-1">PA</span>
                  </div>
                  <div class="flex flex-col items-center flex-1">
                    <div id="bar-actual-aero" class="w-full bg-red-300 rounded-t transition-all" style="height: 0%"></div>
                    <span class="text-xs text-gray-500 mt-1">AA</span>
                  </div>
                  <div class="flex flex-col items-center flex-1">
                    <div id="bar-plan-anaero" class="w-full bg-amber-500 rounded-t transition-all" style="height: 0%"></div>
                    <span class="text-xs text-gray-500 mt-1">PAn</span>
                  </div>
                  <div class="flex flex-col items-center flex-1">
                    <div id="bar-actual-anaero" class="w-full bg-amber-300 rounded-t transition-all" style="height: 0%"></div>
                    <span class="text-xs text-gray-500 mt-1">AAn</span>
                  </div>
                </div>
              </div>
              <div class="flex justify-between text-xs mt-2">
                <span class="text-gray-400">Expected: <span id="load-expected" class="text-white">-</span></span>
                <span class="text-gray-400">Actual: <span id="load-actual" class="text-white">-</span></span>
              </div>
            </div>
            ` : ''}

          </div>

          <!-- Right Column -->
          <div class="lg:col-span-2 space-y-4">

            <!-- Strava Banner -->
            <div class="bg-gradient-to-r from-orange-950/30 to-gray-900 border border-orange-800/30 rounded-lg p-4">
              <div class="flex items-center gap-3">
                <svg class="w-6 h-6 text-orange-500" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/>
                </svg>
                <div class="flex-1">
                  <p class="text-sm text-orange-300 font-medium">Automatic workout logging</p>
                  <p class="text-xs text-gray-400">Workouts are automatically logged from Strava but feel free to manually add workouts too.</p>
                </div>
              </div>
            </div>

            <!-- Prediction Box -->
            <div class="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <h3 class="font-medium text-sm mb-3 text-white">${s.onboarding?.trainingForEvent === false ? 'Performance Forecast' : 'Race Prediction'}</h3>
              <div id="pred" class="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div class="text-xs text-gray-500 mb-1">Initial</div>
                  <div class="text-lg font-medium text-gray-500" id="initial">${ft(s.initialBaseline || 0)}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500 mb-1 cursor-help" title="${s.onboarding?.trainingForEvent === false ? 'Your predicted time if you time-trialed today (based on current fatigue).' : 'Your predicted time if you raced tomorrow (based on current fatigue).'}">Current</div>
                  <div class="text-xl font-bold text-white" id="cv">${ft(s.currentFitness || 0)}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500 mb-1">Forecast</div>
                  <div class="text-2xl font-bold text-emerald-400" id="fc">${ft(s.forecastTime || 0)}</div>
                </div>
              </div>
            </div>

            <!-- Workouts -->
            <div class="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <div id="wo">
                <!-- Workouts rendered here by render() -->
              </div>
            </div>

            <!-- Training Log -->
            <div class="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <h3 class="font-medium text-sm mb-3 text-white">Training Log</h3>
              <div id="lg" class="space-y-2 max-h-48 overflow-y-auto text-xs"></div>
            </div>

          </div>
        </div>
      </div>
    </div>
  `;
}

function renderStravaButton(connected: boolean): string {
  if (connected) {
    return `
      <div class="flex items-center gap-2 px-3 py-1.5 bg-orange-950/30 border border-orange-800/30 rounded-full">
        <div class="w-2 h-2 rounded-full bg-emerald-500"></div>
        <span class="text-xs text-orange-300">Strava Connected</span>
      </div>
    `;
  }

  return `
    <button id="btn-connect-strava" class="flex items-center gap-2 px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white rounded-full text-xs font-medium transition-colors">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/>
      </svg>
      Connect Strava
    </button>
  `;
}

function getPhaseLabel(phase: string | undefined): string {
  switch (phase) {
    case 'base': return 'Base Phase';
    case 'build': return 'Build Phase';
    case 'peak': return 'Peak Phase';
    case 'taper': return 'Taper Phase';
    default: return 'Training';
  }
}

/**
 * Render Morning Pain Check card (appears once per day when injured)
 */
function renderMorningPainCheck(s: any): string {
  const injured = isInjuryActive();
  if (!injured) return '';

  // Check if already answered today
  const today = new Date().toISOString().split('T')[0];
  if (s.lastMorningPainDate === today) {
    return ''; // Already checked today
  }

  const injuryState = getInjuryStateForDisplay();
  const currentPain = injuryState.currentPain || 0;

  return `
    <div id="morning-pain-check" class="bg-blue-950/50 border border-blue-800 rounded-lg p-4 mb-4">
      <div class="flex items-start gap-3">
        <div class="flex-shrink-0 w-10 h-10 bg-blue-900/50 rounded-full flex items-center justify-center">
          <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>
          </svg>
        </div>
        <div class="flex-1">
          <h3 class="text-sm font-semibold text-blue-300 mb-1">Morning Pain Check</h3>
          <p class="text-xs text-blue-400/80 mb-3">
            Is your pain worse than yesterday morning? (Current: ${currentPain}/10)
          </p>
          <div class="flex gap-2">
            <button id="btn-morning-pain-worse" class="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg transition-colors">
              Worse
            </button>
            <button id="btn-morning-pain-same" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors">
               Same
            </button>
            <button id="btn-morning-pain-better" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-colors">
              Better
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Handle morning pain check response
 */
function handleMorningPainResponse(response: 'worse' | 'same' | 'better'): void {
  const s = getMutableState();
  const injuryState = (s as any).injuryState;

  if (!injuryState) return;

  // Record today's date
  const today = new Date().toISOString().split('T')[0];
  s.lastMorningPainDate = today;

  if (response === 'worse') {
    // Pain is worse - trigger regression
    const updatedState = applyPhaseRegression(injuryState, 'Morning pain check: pain worse than yesterday');
    (s as any).injuryState = updatedState;
    showAdaptToast('Pain increased — recovery plan adjusted to a previous phase.');
  } else if (response === 'same') {
    // Pain same - maintenance
    const updatedState = recordMorningPain(injuryState, injuryState.currentPain);
    (s as any).injuryState = updatedState;
  } else {
    // Pain better - log and encourage
    const improvedPain = Math.max(0, (injuryState.currentPain || 1) - 1);
    const updatedState = recordMorningPain(injuryState, improvedPain);
    (s as any).injuryState = updatedState;
    showAdaptToast('Good recovery! Keep it up.');
  }

  saveState();
  // showAdaptToast handles the reload after a short delay
}

/**
 * Show runner type selection modal
 */
function showRunnerTypeModal(currentType: string): void {
  const types = ['Speed', 'Balanced', 'Endurance'];
  const descriptions: Record<string, string> = {
    'Speed': 'Strong at shorter, faster efforts. Training emphasises building aerobic endurance and long-run durability.',
    'Balanced': 'Even performance across distances. Training blends speed and endurance work in roughly equal measure.',
    'Endurance': 'Maintains pace better over long distances. Training emphasises speed development and neuromuscular work.',
  };

  const overlay = document.createElement('div');
  overlay.id = 'runner-type-modal';
  overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';
  overlay.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-5">
      <h3 class="text-white font-semibold text-lg mb-1">Change Runner Type</h3>
      <p class="text-xs text-gray-400 mb-4">This will recalculate your entire training plan.</p>
      <div class="space-y-2">
        ${types.map(t => `
          <button class="runner-type-option w-full text-left p-3 rounded-lg border transition-colors ${t === currentType ? 'bg-emerald-950/50 border-emerald-700 text-emerald-300' : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'}" data-type="${t}">
            <div class="font-medium text-sm">${t} ${t === currentType ? '(current)' : ''}</div>
            <div class="text-xs text-gray-500 mt-0.5">${descriptions[t]}</div>
          </button>
        `).join('')}
      </div>
      <button id="btn-cancel-runner-type" class="w-full mt-3 py-2 text-gray-400 hover:text-gray-300 text-xs transition-colors">Cancel</button>
    </div>
  `;

  document.body.appendChild(overlay);

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // Cancel button
  overlay.querySelector('#btn-cancel-runner-type')?.addEventListener('click', () => overlay.remove());

  // Type selection
  overlay.querySelectorAll('.runner-type-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const newType = (btn as HTMLElement).dataset.type;
      if (!newType || newType === currentType) {
        overlay.remove();
        return;
      }
      overlay.remove();
      applyRunnerTypeChange(newType);
    });
  });
}

/**
 * Apply runner type change and recalculate plan
 */
function applyRunnerTypeChange(newType: string): void {
  const s = getMutableState();
  if (!s.onboarding) return;

  s.onboarding.confirmedRunnerType = newType as any;
  s.onboarding.calculatedRunnerType = newType as any;
  saveState();

  const result = initializeSimulator(s.onboarding);
  if (result.success) {
    window.location.reload();
  } else {
    showAdaptToast('Failed to recalculate: ' + (result.error || 'Unknown error'), false);
  }
}

function wireEventHandlers(): void {
  const s = getState();
  const isAdmin = s.isAdmin || false;
  const maxViewableWeek = isAdmin ? s.tw : Math.min(3, s.tw);

  // Complete week button
  document.getElementById('btn-complete-week')?.addEventListener('click', next);

  // Edit Settings button
  document.getElementById('btn-edit-settings')?.addEventListener('click', editSettings);

  // Reset button
  document.getElementById('btn-reset')?.addEventListener('click', reset);

  // Week navigation with viewWeek
  let viewWeek = s.w;

  const updateViewWeek = (newWeek: number) => {
    viewWeek = Math.max(1, Math.min(newWeek, maxViewableWeek));
    const sliderEl = document.getElementById('week-slider') as HTMLInputElement;
    if (sliderEl) sliderEl.value = String(viewWeek);
    const wnEl = document.getElementById('wn');
    if (wnEl) wnEl.textContent = String(viewWeek);
    const headerWeek = document.querySelector('h3.text-sm.font-medium.text-white');
    if (headerWeek) headerWeek.textContent = `Week ${viewWeek} of ${s.tw}`;
    // Update mutable state temporarily for render
    const ms = getMutableState();
    const savedW = ms.w;
    ms.w = viewWeek;
    (ms as any)._viewOnly = viewWeek !== savedW;
    (ms as any)._realW = savedW;
    render();
    ms.w = savedW;
    delete (ms as any)._viewOnly;
    delete (ms as any)._realW;
  };

  document.getElementById('week-prev')?.addEventListener('click', () => {
    if (viewWeek > 1) updateViewWeek(viewWeek - 1);
  });

  document.getElementById('week-next')?.addEventListener('click', () => {
    if (viewWeek < maxViewableWeek) updateViewWeek(viewWeek + 1);
  });

  // Week slider
  const slider = document.getElementById('week-slider') as HTMLInputElement;
  if (slider) {
    slider.addEventListener('input', () => {
      updateViewWeek(parseInt(slider.value, 10));
    });
  }

  // Connect Strava button
  document.getElementById('btn-connect-strava')?.addEventListener('click', () => {
    showAdaptToast('Strava sync coming soon! For now, log workouts manually.', false);
  });

  // Report Injury button
  document.getElementById('btn-report-injury')?.addEventListener('click', () => {
    openInjuryModal();
  });

  // Injury details button (in banner)
  document.getElementById('btn-injury-details')?.addEventListener('click', () => {
    openInjuryModal();
  });

  // I'm Recovered button
  document.getElementById('btn-recovered')?.addEventListener('click', () => {
    showStyledConfirm(
      'Mark as Recovered?',
      'This will restore your normal training plan. Make sure you are fully ready to resume.',
      'Yes, I\'m Recovered',
      'Not Yet'
    ).then(proceed => { if (proceed) markAsRecovered(); });
  });

  // VDOT info toggle
  document.getElementById('vdot-toggle')?.addEventListener('click', () => {
    document.getElementById('vdot-info')?.classList.toggle('hidden');
  });

  // Runner Type change button
  document.getElementById('btn-change-runner-type')?.addEventListener('click', () => {
    showRunnerTypeModal(s.typ || 'Hybrid');
  });

  // Edit profile button (also opens runner type modal)
  document.getElementById('btn-edit-profile')?.addEventListener('click', () => {
    showRunnerTypeModal(s.typ || 'Hybrid');
  });

  // Morning Pain Check buttons
  document.getElementById('btn-morning-pain-worse')?.addEventListener('click', () => {
    handleMorningPainResponse('worse');
  });

  document.getElementById('btn-morning-pain-same')?.addEventListener('click', () => {
    handleMorningPainResponse('same');
  });

  document.getElementById('btn-morning-pain-better')?.addEventListener('click', () => {
    handleMorningPainResponse('better');
  });
}

/**
 * Reusable styled confirm modal.
 */
function showStyledConfirm(title: string, message: string, confirmLabel: string, cancelLabel: string): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
    overlay.innerHTML = `
      <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-6">
        <h3 class="text-white font-semibold text-lg mb-2">${title}</h3>
        <p class="text-gray-400 text-sm mb-5">${message}</p>
        <div class="flex flex-col gap-2">
          <button id="btn-styled-confirm" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors text-sm">
            ${confirmLabel}
          </button>
          <button id="btn-styled-cancel" class="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg transition-colors text-sm">
            ${cancelLabel}
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#btn-styled-confirm')?.addEventListener('click', () => { overlay.remove(); resolve(true); });
    overlay.querySelector('#btn-styled-cancel')?.addEventListener('click', () => { overlay.remove(); resolve(false); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

/**
 * Show a toast notification then reload after a short delay.
 */
function showAdaptToast(message: string, reload: boolean = true): void {
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-emerald-600 text-white px-6 py-3 rounded-xl shadow-lg text-sm font-medium z-50 transition-opacity';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => {
      toast.remove();
      if (reload) window.location.reload();
    }, 400);
  }, 2200);
}
