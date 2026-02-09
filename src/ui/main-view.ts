import { getState, getMutableState } from '@/state/store';
import type { SimulatorState } from '@/types';
import { saveState } from '@/state/persistence';
import { render, attachTrackRunHandlers } from './renderer';
import { next, updateFitness, reset, editSettings, logActivity, setOnWeekAdvance, isBenchmarkWeek, findGarminRunForWeek, getBenchmarkOptions, getBenchmarkDefault, recordBenchmark, skipBenchmark } from './events';
import { setOnTrackingStart, setOnTrackingStop } from './gps-events';
import { attachRecordingsHandlers } from './gps-panel';
import { ft } from '@/utils/format';
import { openInjuryModal, renderInjuryBanner, isInjuryActive, markAsRecovered, getInjuryStateForDisplay } from './injury/modal';
import { applyPhaseRegression, recordMorningPain } from '@/injury/engine';
import { initializeSimulator } from '@/state/initialization';
import { computeRecoveryStatus, sleepQualityToScore } from '@/recovery/engine';
import type { RecoveryEntry, RecoveryLevel } from '@/recovery/engine';

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
  const maxViewableWeek = s.tw; // Unlimited access (trial cap removed)

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

/**
 * Calculate which 4-week block the current week belongs to (1-indexed)
 */
function getBlockNumber(currentWeek: number): number {
  return Math.floor((currentWeek - 1) / 4) + 1;
}

/**
 * Calculate which week within the current 4-week block (1-4)
 */
function getBlockWeek(currentWeek: number): number {
  return ((currentWeek - 1) % 4) + 1;
}

/**
 * Check if the current week is in the block cycling (pre-race) phase of a long plan
 */
function isInBlockCyclingPhase(s: any, weekOverride?: number): boolean {
  const week = weekOverride ?? s.w;
  return !s.continuousMode && s.racePhaseStart && week < s.racePhaseStart;
}

/**
 * Get the race-prep week number (1-indexed within the 16-week race block)
 */
function getRacePrepWeek(s: any, weekOverride?: number): number {
  const week = weekOverride ?? s.w;
  return week - (s.racePhaseStart - 1);
}

/**
 * Get the total race prep weeks (always 16 for long plans)
 */
function getRacePrepTotal(s: any): number {
  return s.tw - (s.racePhaseStart - 1);
}

/**
 * Header subtitle text (below plan name)
 */
function getHeaderSubtitle(s: any, blockNum: number): string {
  if (s.continuousMode) {
    return `Week ${s.w} — Block ${blockNum} · ${getPhaseLabel(s.wks?.[s.w - 1]?.ph, true)}`;
  }
  if (isInBlockCyclingPhase(s)) {
    return `Week ${s.w} — Block ${blockNum} · ${getPhaseLabel(s.wks?.[s.w - 1]?.ph, true)} (Race prep starts week ${s.racePhaseStart})`;
  }
  if (s.racePhaseStart) {
    const rpWeek = getRacePrepWeek(s);
    const rpTotal = getRacePrepTotal(s);
    return `Race Prep — Week ${rpWeek} of ${rpTotal} — ${getPhaseLabel(s.wks?.[s.w - 1]?.ph, false)}`;
  }
  return `Week ${s.w} of ${s.tw} — ${getPhaseLabel(s.wks?.[s.w - 1]?.ph, false)}`;
}

/**
 * Week navigator card title
 */
function getWeekNavigatorLabel(s: any, blockNum: number): string {
  if (s.continuousMode) {
    return `Week ${s.w} · Block ${blockNum}`;
  }
  if (isInBlockCyclingPhase(s)) {
    return `Week ${s.w} · Block ${blockNum}`;
  }
  if (s.racePhaseStart) {
    const rpWeek = getRacePrepWeek(s);
    const rpTotal = getRacePrepTotal(s);
    return `Race Prep ${rpWeek} of ${rpTotal}`;
  }
  return `Week ${s.w} of ${s.tw}`;
}

/**
 * Week counter label inside the prediction/phase panel
 */
function getWeekCounterLabel(s: any): string {
  if (isInBlockCyclingPhase(s)) {
    const blockNum = getBlockNumber(s.w);
    const blockWeek = getBlockWeek(s.w);
    return `Block ${blockNum} · Week ${blockWeek} of 4`;
  }
  if (s.racePhaseStart) {
    const rpWeek = getRacePrepWeek(s);
    const rpTotal = getRacePrepTotal(s);
    return `Race Prep · Week ${rpWeek} of ${rpTotal}`;
  }
  return `Week ${s.w} of ${s.tw}`;
}

function getMainViewHTML(s: any, maxViewableWeek: number): string {
  const injured = isInjuryActive();
  const headerBg = injured ? 'bg-amber-950 border-b border-amber-800' : 'bg-gray-900 border-b border-gray-800';
  const titleColor = injured ? 'text-amber-300' : 'text-white';
  const subtitleColor = injured ? 'text-amber-400/70' : 'text-gray-500';
  const blockNum = getBlockNumber(s.w);


  return `
    <div class="min-h-screen bg-gray-950">
      <!-- Header - Changes color when injured -->
      <div class="${headerBg}">
        <div class="max-w-7xl mx-auto px-4 py-4">
          <div class="flex items-center justify-between">
            <div>
              <h1 class="text-xl font-semibold ${titleColor}">${injured ? 'Recovery Mode' : `${s.onboarding?.name ? s.onboarding.name + "'s" : 'Your'} Adaptive Plan`}</h1>
              <p class="text-xs ${subtitleColor}">${injured ? 'Recovery Plan Active' : getHeaderSubtitle(s, blockNum)}</p>
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

        <!-- Recovery Pill -->
        ${renderRecoveryPill(s)}

        <!-- Morning Pain Check (shown when injured, once per day) -->
        ${renderMorningPainCheck(s)}

        <!-- Benchmark Check-in (shown on benchmark weeks for continuous mode) -->
        ${renderBenchmarkPanel(s)}

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">

          <!-- Left Column -->
          <div class="lg:col-span-1 space-y-4">

            <!-- Week Navigator -->
            <div class="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <div class="flex items-center justify-between mb-3">
                <h3 class="text-sm font-medium text-white">${getWeekNavigatorLabel(s, blockNum)}</h3>
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
                  <button id="btn-change-runner-type" class="flex items-center gap-1 px-2 py-0.5 bg-emerald-950/50 border border-emerald-800/50 rounded-full text-emerald-400 hover:bg-emerald-900/50 hover:text-emerald-300 transition-colors cursor-pointer">
                        <span>${s.typ}</span>
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                      </button>
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
                ${s.continuousMode ? `
                <div class="flex justify-between">
                  <span class="text-gray-400">Focus</span>
                  <span class="text-emerald-400">${s.onboarding?.trainingFocus === 'speed' ? 'Speed' : s.onboarding?.trainingFocus === 'endurance' ? 'Endurance' : 'Balanced'}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-400">Block</span>
                  <span class="text-white">${blockNum}</span>
                </div>
                ` : `
                <div class="flex justify-between">
                  <span class="text-gray-400">Expected Final</span>
                  <span class="text-emerald-400">${s.expectedFinal?.toFixed(1) || '-'}</span>
                </div>
                `}
              </div>
            </div>

            <!-- Recovery Log (last 7 days) -->
            ${renderRecoveryLog(s)}

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

            <!-- Prediction / Progress Box -->
            ${s.continuousMode ? renderContinuousProgressPanel(s) : `
            <div class="bg-gray-900 rounded-lg border border-gray-800 p-5">
              <!-- Phase Display (Big & Bold) -->
              <div class="mb-5 pb-5 border-b border-gray-800">
                <div class="text-xs text-gray-500 uppercase tracking-widest mb-1 font-semibold">Current Phase</div>
                <div id="phase-label" class="text-4xl font-bold text-white tracking-tight">${getPhaseLabel(s.wks?.[s.w - 1]?.ph, isInBlockCyclingPhase(s))}</div>
                <p id="week-counter" class="text-sm text-emerald-400 mt-1 font-medium">${getWeekCounterLabel(s)}</p>
              </div>

              <!-- Predictions -->
              <h3 class="font-medium text-sm mb-4 text-gray-400">Race Prediction</h3>
              <div id="pred" class="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div class="text-xs text-gray-500 mb-1">Initial</div>
                  <div class="text-lg font-medium text-gray-500" id="initial">${ft(s.initialBaseline || 0)}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500 mb-1 cursor-help" title="Your predicted time if you raced tomorrow (based on current fatigue).">Current</div>
                  <div class="text-xl font-bold text-white" id="cv">${ft(s.currentFitness || 0)}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500 mb-1">Forecast</div>
                  <div class="text-2xl font-bold text-emerald-400" id="fc">${ft(s.forecastTime || 0)}</div>
                </div>
              </div>
            </div>
            `}

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

/**
 * Render the progress panel for non-event (continuous mode) users.
 * Shows VDOT progress, current easy pace, and block progress bar instead of race times.
 */
function renderContinuousProgressPanel(s: any): string {
  // Calculate current VDOT from accumulated gains
  let wg = 0;
  for (let i = 0; i < Math.min(s.w - 1, s.wks?.length || 0); i++) wg += (s.wks[i]?.wkGain || 0);
  const currentVdot = (s.v || 0) + wg + (s.rpeAdj || 0);
  const vdotChange = currentVdot - (s.iv || s.v || 0);

  // Easy pace from current paces
  const easyPace = s.pac?.e;
  const easyPaceStr = easyPace
    ? `${Math.floor(easyPace / 60)}:${String(Math.round(easyPace % 60)).padStart(2, '0')}/km`
    : '—';

  // Block progress: which week within the current 4-week block
  const blockWeek = getBlockWeek(s.w);
  const blockNum = getBlockNumber(s.w);

  const blockPhaseLabels = ['Base', 'Build', 'Intensify', 'Deload'];
  const blockPhaseLbl = blockPhaseLabels[blockWeek - 1] || 'Base';

  // Count completed benchmarks
  const benchmarkCount = s.benchmarkResults?.filter((b: any) => b.source !== 'skipped').length || 0;

  // Get the actual phase from the week data
  const currentPhase = s.wks?.[s.w - 1]?.ph;

  return `
    <div class="bg-gray-900 rounded-lg border border-gray-800 p-5">
      <!-- Phase Display (Big & Bold) -->
      <div class="mb-5 pb-5 border-b border-gray-800">
        <div class="text-xs text-gray-500 uppercase tracking-widest mb-1 font-semibold">Current Phase</div>
        <div id="phase-label" class="text-4xl font-bold text-white tracking-tight">${getPhaseLabel(currentPhase, true)}</div>
        <p id="week-counter" class="text-sm text-emerald-400 mt-1 font-medium">Block ${blockNum} · Week ${blockWeek} of 4</p>
      </div>

      <h3 class="font-medium text-sm mb-3 text-white">Fitness Progress</h3>

      <!-- VDOT + Easy Pace -->
      <div id="pred" class="grid grid-cols-2 gap-4 text-center mb-4">
        <div>
          <div class="text-xs text-gray-500 mb-1">Current VDOT</div>
          <div class="text-2xl font-bold text-white">${currentVdot.toFixed(1)}</div>
          <div class="text-xs ${vdotChange >= 0 ? 'text-emerald-400' : 'text-red-400'} mt-0.5">
            ${vdotChange >= 0 ? '+' : ''}${vdotChange.toFixed(2)} from start
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Easy Pace</div>
          <div class="text-2xl font-bold text-emerald-400">${easyPaceStr}</div>
          <div class="text-xs text-gray-500 mt-0.5">${benchmarkCount > 0 ? `${benchmarkCount} check-in${benchmarkCount > 1 ? 's' : ''} logged` : 'No check-ins yet'}</div>
        </div>
      </div>

      <!-- Block Progress Bar -->
      <div class="bg-gray-800 rounded-lg p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs text-gray-400">Block ${blockNum} · Week ${blockWeek} of 4</span>
          <span class="text-xs font-medium ${blockWeek === 4 ? 'text-blue-400' : blockWeek === 3 ? 'text-orange-400' : 'text-emerald-400'}">${blockPhaseLbl}</span>
        </div>
        <div class="flex gap-1">
          ${[1, 2, 3, 4].map(i => `
            <div class="flex-1 h-2 rounded-full ${i < blockWeek ? 'bg-emerald-500' :
      i === blockWeek ? (i === 4 ? 'bg-blue-500' : i === 3 ? 'bg-orange-500' : 'bg-emerald-500') :
        'bg-gray-700'
    }"></div>
          `).join('')}
        </div>
        ${blockWeek === 4 ? '<p class="text-xs text-blue-400/80 mt-2">Deload week — lighter training + optional check-in</p>' : blockWeek === 3 ? '<p class="text-xs text-orange-400/80 mt-2">Intensify week — peak training load</p>' : ''}
      </div>
    </div>
  `;
}

/**
 * Render the optional benchmark check-in panel (shown on benchmark weeks for continuous mode users).
 * Uses the 4-tier benchmark system with smart defaults based on focus × experienceLevel.
 */
function renderBenchmarkPanel(s: any): string {
  if (!s.continuousMode) return '';
  if (!isBenchmarkWeek(s.w, true)) return '';

  // Check if benchmark already recorded/skipped for this week
  const existing = s.benchmarkResults?.find((b: any) => b.week === s.w);
  if (existing) {
    if (existing.source === 'skipped') {
      return `
        <div class="bg-gray-800/50 border border-gray-700 rounded-lg p-4 mb-4">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/>
            </svg>
            <p class="text-sm text-gray-400">Check-in skipped this block — no worries, keep training!</p>
          </div>
        </div>
      `;
    }
    // Show recorded result
    const resultDetails = formatBenchmarkResult(existing);
    return `
      <div class="bg-emerald-950/30 border border-emerald-800 rounded-lg p-4 mb-4">
        <div class="flex items-center gap-2 mb-1">
          <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
          </svg>
          <span class="text-sm font-medium text-emerald-300">Check-in Recorded</span>
          ${existing.source === 'garmin' ? '<span class="text-xs bg-orange-950/50 text-orange-300 px-2 py-0.5 rounded-full border border-orange-800/30">From watch</span>' : ''}
        </div>
        <p class="text-xs text-gray-400">${resultDetails}</p>
      </div>
    `;
  }

  const options = getBenchmarkOptions(s.onboarding?.trainingFocus, s.onboarding?.experienceLevel);
  const garminRun = findGarminRunForWeek(s.w);

  return `
    <div class="bg-blue-950/30 border border-blue-800 rounded-lg p-4 mb-4">
      <div class="flex items-start gap-3">
        <div class="flex-shrink-0 w-10 h-10 bg-blue-900/50 rounded-full flex items-center justify-center">
          <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
          </svg>
        </div>
        <div class="flex-1">
          <h3 class="text-sm font-semibold text-blue-300 mb-1">Optional Check-in</h3>
          <p class="text-xs text-blue-400/80 mb-3">See how your fitness is tracking. Totally optional — skip anytime.</p>

          ${garminRun ? `
            <div class="bg-orange-950/30 border border-orange-800/30 rounded-lg p-3 mb-3">
              <div class="flex items-center gap-2 mb-1">
                <svg class="w-4 h-4 text-orange-400" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/>
                </svg>
                <span class="text-xs font-medium text-orange-300">Run detected from watch</span>
              </div>
              <p class="text-xs text-gray-400">${garminRun.duration_min}min run · RPE ${garminRun.rpe}</p>
              <button id="btn-benchmark-auto" class="mt-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-colors">
                Use This Run as Check-in
              </button>
            </div>
          ` : ''}

          <!-- Benchmark options (smart default first) -->
          <div class="space-y-2 mb-3">
            ${options.map((opt, idx) => `
              <button class="btn-benchmark-option w-full text-left p-3 rounded-lg border transition-colors ${opt.recommended
      ? 'bg-blue-950/50 border-blue-700 hover:border-blue-500'
      : 'bg-gray-800/50 border-gray-700 hover:border-gray-500'
    }" data-bm-type="${opt.type}">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium ${opt.recommended ? 'text-blue-300' : 'text-gray-300'}">${opt.label}</span>
                  ${opt.recommended ? '<span class="text-xs bg-blue-900/50 text-blue-400 px-2 py-0.5 rounded-full">Recommended</span>' : ''}
                </div>
                <p class="text-xs text-gray-500 mt-0.5">${opt.description}</p>
              </button>
            `).join('')}
          </div>

          <button id="btn-benchmark-skip" class="w-full py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs font-medium rounded-lg transition-colors">
            Skip this check-in
          </button>
        </div>
      </div>
    </div>
  `;
}

/** Format a benchmark result for display */
function formatBenchmarkResult(result: any): string {
  switch (result.type) {
    case 'easy_checkin':
      return result.avgPaceSecKm
        ? `Easy check-in · ${Math.floor(result.avgPaceSecKm / 60)}:${String(Math.round(result.avgPaceSecKm % 60)).padStart(2, '0')}/km avg`
        : `Easy check-in · ${result.durationSec ? Math.round(result.durationSec / 60) + 'min' : 'logged'}`;
    case 'threshold_check':
      return result.avgPaceSecKm
        ? `Threshold check · ${Math.floor(result.avgPaceSecKm / 60)}:${String(Math.round(result.avgPaceSecKm % 60)).padStart(2, '0')}/km`
        : 'Threshold check · logged';
    case 'speed_check':
      return result.distanceKm
        ? `Speed check · ${result.distanceKm.toFixed(2)} km in 12 min`
        : 'Speed check · logged';
    case 'race_simulation':
      return result.distanceKm && result.durationSec
        ? `Race sim · ${result.distanceKm}km in ${Math.floor(result.durationSec / 60)}:${String(Math.round(result.durationSec % 60)).padStart(2, '0')}`
        : 'Race simulation · logged';
    default:
      return 'Check-in recorded';
  }
}

/**
 * Show manual benchmark entry modal for a specific benchmark type.
 */
function showBenchmarkEntryModal(bmType: string): void {
  const type = bmType as import('@/types/state').BenchmarkType;

  // Build the right input fields based on benchmark type
  let fieldsHTML = '';
  let title = '';
  let desc = '';

  switch (type) {
    case 'easy_checkin':
      title = 'Easy Check-in';
      desc = 'Log a 30-min steady run. Enter your average pace.';
      fieldsHTML = renderPaceInput();
      break;
    case 'threshold_check':
      title = 'Threshold Check';
      desc = 'Log your 20-min "comfortably hard" effort. Enter your average pace.';
      fieldsHTML = renderPaceInput();
      break;
    case 'speed_check':
      title = 'Speed Check (12-min test)';
      desc = 'How far did you run in 12 minutes?';
      fieldsHTML = `
        <label class="block text-xs text-gray-400 mb-1">Distance covered (km)</label>
        <input type="number" id="bm-distance" step="0.01" min="0.5" max="6"
          class="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm mb-4"
          placeholder="e.g. 2.80">
      `;
      break;
    case 'race_simulation':
      title = 'Race Simulation';
      desc = 'Log your time trial result.';
      fieldsHTML = `
        <label class="block text-xs text-gray-400 mb-1">Distance (km)</label>
        <input type="number" id="bm-distance" step="0.1" min="1" max="42.2"
          class="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm mb-3"
          placeholder="e.g. 5">
        <label class="block text-xs text-gray-400 mb-1">Time</label>
        <div class="flex gap-2 mb-4">
          <input type="number" id="bm-time-min" min="5" max="300"
            class="flex-1 bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm"
            placeholder="min">
          <span class="text-gray-500 self-center">:</span>
          <input type="number" id="bm-time-sec" min="0" max="59"
            class="flex-1 bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm"
            placeholder="sec">
        </div>
      `;
      break;
  }

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
  overlay.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-6">
      <h3 class="text-white font-semibold text-lg mb-2">${title}</h3>
      <p class="text-gray-400 text-sm mb-4">${desc}</p>
      ${fieldsHTML}
      <div class="flex flex-col gap-2">
        <button id="btn-bm-submit" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors text-sm">
          Save
        </button>
        <button id="btn-bm-cancel" class="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg transition-colors text-sm">
          Cancel
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#btn-bm-submit')?.addEventListener('click', () => {
    switch (type) {
      case 'easy_checkin':
      case 'threshold_check': {
        const m = +(document.getElementById('bm-pace-min') as HTMLInputElement)?.value || 0;
        const sec = +(document.getElementById('bm-pace-sec') as HTMLInputElement)?.value || 0;
        const paceSec = m * 60 + sec;
        if (paceSec < 120 || paceSec > 720) { alert('Enter a valid pace (min:sec per km)'); return; }
        overlay.remove();
        const dur = type === 'easy_checkin' ? 1800 : 1200; // 30 min / 20 min
        recordBenchmark(type, 'manual', undefined, dur, paceSec);
        break;
      }
      case 'speed_check': {
        const dist = +(document.getElementById('bm-distance') as HTMLInputElement)?.value;
        if (!dist || dist < 0.5) { alert('Enter a distance (km)'); return; }
        overlay.remove();
        recordBenchmark('speed_check', 'manual', dist, 720); // 12 min
        break;
      }
      case 'race_simulation': {
        const dist = +(document.getElementById('bm-distance') as HTMLInputElement)?.value;
        const m = +(document.getElementById('bm-time-min') as HTMLInputElement)?.value || 0;
        const sec = +(document.getElementById('bm-time-sec') as HTMLInputElement)?.value || 0;
        const totalSec = m * 60 + sec;
        if (!dist || dist < 1) { alert('Enter a distance'); return; }
        if (totalSec < 300) { alert('Enter a valid time'); return; }
        overlay.remove();
        const avgPace = totalSec / dist;
        recordBenchmark('race_simulation', 'manual', dist, totalSec, avgPace);
        break;
      }
    }
  });

  overlay.querySelector('#btn-bm-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

/** Reusable pace input HTML */
function renderPaceInput(): string {
  return `
    <label class="block text-xs text-gray-400 mb-1">Average pace (min:sec per km)</label>
    <div class="flex gap-2 mb-4">
      <input type="number" id="bm-pace-min" min="2" max="12"
        class="flex-1 bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm"
        placeholder="min">
      <span class="text-gray-500 self-center">:</span>
      <input type="number" id="bm-pace-sec" min="0" max="59"
        class="flex-1 bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm"
        placeholder="sec">
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Recovery UI
// ---------------------------------------------------------------------------

function renderRecoveryPill(s: any): string {
  const today = new Date().toISOString().split('T')[0];
  const history: RecoveryEntry[] = s.recoveryHistory || [];
  const todayEntry = history.find((e: RecoveryEntry) => e.date === today) || null;
  const alreadyPrompted = s.lastRecoveryPromptDate === today;

  const { level, shouldPrompt } = computeRecoveryStatus(todayEntry, history);

  if (!todayEntry) {
    // No data — prompt to log
    return `
      <button id="btn-recovery-log" class="inline-flex items-center gap-2 px-4 py-2 mb-4 rounded-full text-xs font-medium bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-gray-300 transition-colors">
        <span class="w-2 h-2 rounded-full bg-gray-500"></span>
        Recovery: Log today
      </button>
    `;
  }

  if (level === 'green') {
    return `
      <div class="inline-flex items-center gap-2 px-4 py-2 mb-4 rounded-full text-xs font-medium bg-emerald-950/30 border border-emerald-800/50 text-emerald-400">
        <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
        Recovery: Good
      </div>
    `;
  }

  if (shouldPrompt && !alreadyPrompted) {
    const colorMap: Record<RecoveryLevel, string> = {
      green: '',
      yellow: 'bg-amber-950/30 border-amber-800/50 text-amber-400',
      orange: 'bg-orange-950/30 border-orange-800/50 text-orange-400',
      red: 'bg-red-950/30 border-red-800/50 text-red-400',
    };
    const dotColor: Record<RecoveryLevel, string> = {
      green: '',
      yellow: 'bg-amber-500',
      orange: 'bg-orange-500',
      red: 'bg-red-500',
    };
    return `
      <button id="btn-recovery-adjust" class="inline-flex items-center gap-2 px-4 py-2 mb-4 rounded-full text-xs font-medium ${colorMap[level]} hover:brightness-110 transition-colors">
        <span class="w-2 h-2 rounded-full ${dotColor[level]}"></span>
        Recovery: Low — Tap to adjust
      </button>
    `;
  }

  // Already prompted today — small status dot only
  const dotColor: Record<RecoveryLevel, string> = {
    green: 'bg-emerald-500',
    yellow: 'bg-amber-500',
    orange: 'bg-orange-500',
    red: 'bg-red-500',
  };
  return `
    <div class="inline-flex items-center gap-2 px-3 py-1.5 mb-4 rounded-full text-xs text-gray-500">
      <span class="w-2 h-2 rounded-full ${dotColor[level]}"></span>
      Recovery logged
    </div>
  `;
}

function renderRecoveryLog(s: any): string {
  const history: RecoveryEntry[] = s.recoveryHistory || [];
  const last7 = history.slice(-7);

  const dotColor = (score: number): string => {
    if (score >= 70) return 'bg-emerald-500';
    if (score >= 50) return 'bg-amber-500';
    if (score >= 30) return 'bg-orange-500';
    return 'bg-red-500';
  };

  return `
    <div class="bg-gray-900 rounded-lg border border-gray-800 p-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-medium text-sm text-white">Recovery</h3>
        <button id="btn-recovery-log-panel" class="text-xs text-emerald-400 hover:text-emerald-300 transition-colors">Log Today</button>
      </div>
      <div class="flex gap-1.5 items-center">
        ${last7.length === 0
          ? '<span class="text-xs text-gray-500">No recovery data yet</span>'
          : last7.map((e: RecoveryEntry) => `
            <div class="flex flex-col items-center gap-1" title="${e.date}: Sleep ${e.sleepScore}/100">
              <span class="w-3 h-3 rounded-full ${dotColor(e.sleepScore)}"></span>
              <span class="text-[10px] text-gray-600">${e.date.slice(5)}</span>
            </div>
          `).join('')
        }
      </div>
    </div>
  `;
}

function showRecoveryInputModal(): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
  overlay.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-6">
      <h3 class="text-white font-semibold text-lg mb-1">How did you sleep?</h3>
      <p class="text-gray-400 text-sm mb-5">Quick check-in to optimize today's training.</p>
      <div class="flex flex-col gap-2">
        <button class="recovery-quality-btn w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors text-sm" data-quality="great">
          Great — Slept well
        </button>
        <button class="recovery-quality-btn w-full py-2.5 bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium rounded-lg transition-colors text-sm" data-quality="good">
          Good — Normal night
        </button>
        <button class="recovery-quality-btn w-full py-2.5 bg-amber-700 hover:bg-amber-600 text-white font-medium rounded-lg transition-colors text-sm" data-quality="poor">
          Poor — Restless/short
        </button>
        <button class="recovery-quality-btn w-full py-2.5 bg-red-700 hover:bg-red-600 text-white font-medium rounded-lg transition-colors text-sm" data-quality="terrible">
          Terrible — Barely slept
        </button>
        <button id="btn-recovery-skip" class="w-full py-2 text-gray-500 hover:text-gray-400 text-xs transition-colors mt-1">
          Skip
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelectorAll('.recovery-quality-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const quality = (btn as HTMLElement).dataset.quality as 'great' | 'good' | 'poor' | 'terrible';
      overlay.remove();
      handleRecoveryInput(quality);
    });
  });

  overlay.querySelector('#btn-recovery-skip')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function handleRecoveryInput(quality: 'great' | 'good' | 'poor' | 'terrible'): void {
  const s = getMutableState();
  const today = new Date().toISOString().split('T')[0];
  const score = sleepQualityToScore(quality);

  const entry: RecoveryEntry = { date: today, sleepScore: score, source: 'manual' };

  if (!s.recoveryHistory) s.recoveryHistory = [];

  // Replace if already logged today, else push
  const idx = s.recoveryHistory.findIndex((e: RecoveryEntry) => e.date === today);
  if (idx >= 0) {
    s.recoveryHistory[idx] = entry;
  } else {
    s.recoveryHistory.push(entry);
  }

  // Keep last 7 days
  if (s.recoveryHistory.length > 7) {
    s.recoveryHistory = s.recoveryHistory.slice(-7);
  }

  saveState();

  // If score < 70 → open adjustment modal
  if (score < 70) {
    showRecoveryAdjustModal(entry);
  } else {
    render();
    renderMainView();
  }
}

function showRecoveryAdjustModal(entry: RecoveryEntry): void {
  const s = getState();
  const history: RecoveryEntry[] = s.recoveryHistory || [];
  const { level, reasons } = computeRecoveryStatus(entry, history);

  // Get today's workouts to show what will be affected
  const { generateWeekWorkouts } = require('@/workouts') as typeof import('@/workouts');
  const wk = s.wks[s.w - 1];
  if (!wk) return;

  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig, null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v
  );

  // Find today's run workout (JS day → our day)
  const jsDay = new Date().getDay();
  const ourDay = jsDay === 0 ? 6 : jsDay - 1;
  const todayWorkout = workouts.find((w: any) =>
    w.dayOfWeek === ourDay && w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest'
  );

  const todayLabel = todayWorkout ? todayWorkout.n : 'No run planned today';

  const levelLabel: Record<RecoveryLevel, string> = {
    green: 'Good',
    yellow: 'Low',
    orange: 'Low',
    red: 'Very Low',
  };

  const levelColor: Record<RecoveryLevel, string> = {
    green: 'text-emerald-400',
    yellow: 'text-amber-400',
    orange: 'text-orange-400',
    red: 'text-red-400',
  };

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
  overlay.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-6">
      <div class="flex items-center gap-2 mb-3">
        <span class="text-sm font-semibold ${levelColor[level]}">Recovery: ${levelLabel[level]}</span>
      </div>
      <ul class="text-xs text-gray-400 mb-4 space-y-1">
        ${reasons.map(r => `<li>&#8226; ${r}</li>`).join('')}
      </ul>
      <p class="text-sm text-gray-300 mb-4">Today: <span class="text-white font-medium">${todayLabel}</span></p>

      ${todayWorkout ? `
        <div class="flex flex-col gap-2">
          <button id="btn-recovery-downgrade" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors text-sm text-left px-4">
            <div class="flex items-center justify-between">
              <span>Downgrade to Easy</span>
              ${level === 'red' || level === 'orange' ? '<span class="text-xs bg-emerald-800 px-2 py-0.5 rounded-full">Recommended</span>' : ''}
            </div>
            <p class="text-xs text-emerald-200/70 mt-0.5">Keep distance, lower intensity</p>
          </button>
          <button id="btn-recovery-reduce" class="w-full py-2.5 bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium rounded-lg transition-colors text-sm text-left px-4">
            <span>Reduce Distance</span>
            <p class="text-xs text-gray-400 mt-0.5">Cut by 20%, keep workout type</p>
          </button>
          <button id="btn-recovery-ignore" class="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-400 font-medium rounded-lg transition-colors text-sm">
            Keep plan unchanged
          </button>
        </div>
      ` : `
        <p class="text-xs text-gray-500 mb-3">No run workout scheduled today — no adjustments needed.</p>
        <button id="btn-recovery-dismiss" class="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg transition-colors text-sm">
          Dismiss
        </button>
      `}
    </div>
  `;
  document.body.appendChild(overlay);

  if (todayWorkout) {
    overlay.querySelector('#btn-recovery-downgrade')?.addEventListener('click', () => {
      overlay.remove();
      window.applyRecoveryAdjustment('downgrade', ourDay);
    });
    overlay.querySelector('#btn-recovery-reduce')?.addEventListener('click', () => {
      overlay.remove();
      window.applyRecoveryAdjustment('reduce', ourDay);
    });
    overlay.querySelector('#btn-recovery-ignore')?.addEventListener('click', () => {
      overlay.remove();
      markRecoveryPrompted();
    });
  } else {
    overlay.querySelector('#btn-recovery-dismiss')?.addEventListener('click', () => {
      overlay.remove();
      markRecoveryPrompted();
    });
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function markRecoveryPrompted(): void {
  const s = getMutableState();
  s.lastRecoveryPromptDate = new Date().toISOString().split('T')[0];
  saveState();
  renderMainView();
}

function getPhaseLabel(phase: string | undefined, isContinuousMode: boolean = false): string {
  if (isContinuousMode) {
    // Continuous mode: Base → Build → Intensify → Deload
    switch (phase) {
      case 'base': return 'Base';
      case 'build': return 'Build';
      case 'peak': return 'Intensify';
      case 'taper': return 'Deload';
      default: return 'Training';
    }
  } else {
    // Race mode: Base → Build → Peak → Taper
    switch (phase) {
      case 'base': return 'Base';
      case 'build': return 'Build';
      case 'peak': return 'Peak';
      case 'taper': return 'Taper';
      default: return 'Training';
    }
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
function showRunnerTypeModal(currentType: string, planStarted: boolean = false): void {
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
      ${planStarted ? `<div class="p-3 mb-4 bg-amber-950/30 border border-amber-800/50 rounded-lg text-xs text-amber-300 leading-relaxed">
        Changing your runner type will reset your current plan. Your training data will be preserved but your plan will be rebuilt from scratch.
      </div>` : ''}
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
      showStyledConfirm(
        'Are you sure?',
        'This will rebuild your entire plan from scratch and you will lose all completed runs.',
        'Yes, rebuild my plan',
        'Cancel'
      ).then(proceed => {
        if (proceed) applyRunnerTypeChange(newType);
      });
    });
  });
}

/**
 * Apply runner type change and recalculate plan
 */
function applyRunnerTypeChange(newType: string): void {
  const s = getMutableState();
  if (!s.onboarding) return;

  // Show rebuilding visual
  const overlay = document.createElement('div');
  overlay.id = 'rebuilding-overlay';
  overlay.className = 'fixed inset-0 bg-gray-950/95 flex items-center justify-center z-50';
  overlay.innerHTML = `
    <div class="text-center">
      <div class="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
      <h3 class="text-white font-semibold text-lg mb-1">Rebuilding Plan</h3>
      <p class="text-gray-400 text-sm">Recalculating your workouts...</p>
    </div>
  `;
  document.body.appendChild(overlay);

  s.onboarding.confirmedRunnerType = newType as any;
  s.onboarding.calculatedRunnerType = newType as any;
  saveState();

  setTimeout(() => {
    const result = initializeSimulator(s.onboarding!);
    if (result.success) {
      window.location.reload();
    } else {
      overlay.remove();
      showAdaptToast('Failed to recalculate: ' + (result.error || 'Unknown error'), false);
    }
  }, 1200);
}

function wireEventHandlers(): void {
  const s = getState();
  const isAdmin = s.isAdmin || false;
  const maxViewableWeek = s.tw; // Unlimited access (trial cap removed)

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
    const viewBlockNum = Math.floor((viewWeek - 1) / 4) + 1;
    // Create a temporary state-like object for label helpers
    const viewState = { ...s, w: viewWeek };
    if (headerWeek) headerWeek.textContent = getWeekNavigatorLabel(viewState, viewBlockNum);
    // Update phase label and week counter for viewed week
    const viewWk = s.wks?.[viewWeek - 1];
    const phaseLabel = document.getElementById('phase-label');
    if (phaseLabel && viewWk) phaseLabel.textContent = getPhaseLabel(viewWk.ph, s.continuousMode || isInBlockCyclingPhase(viewState));
    const weekCounter = document.getElementById('week-counter');
    if (weekCounter) {
      weekCounter.textContent = getWeekCounterLabel(viewState);
    }
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
  const planStarted = hasPlanStarted(s);
  document.getElementById('btn-change-runner-type')?.addEventListener('click', () => {
    showRunnerTypeModal(s.typ || 'Hybrid', planStarted);
  });

  // Edit profile button (also opens runner type modal)
  document.getElementById('btn-edit-profile')?.addEventListener('click', () => {
    showRunnerTypeModal(s.typ || 'Hybrid', planStarted);
  });

  // Benchmark buttons (continuous mode)
  document.getElementById('btn-benchmark-auto')?.addEventListener('click', () => {
    const garminRun = findGarminRunForWeek(s.w);
    if (garminRun) {
      // Auto-pull: use the smart default type and record from Garmin data
      const defaultBm = getBenchmarkDefault(s.onboarding?.trainingFocus, s.onboarding?.experienceLevel);
      recordBenchmark(defaultBm.type, 'garmin', undefined, garminRun.duration_min * 60);
    }
  });

  // Benchmark option buttons (the 4-tier menu)
  document.querySelectorAll('.btn-benchmark-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const bmType = (btn as HTMLElement).dataset.bmType;
      if (bmType) showBenchmarkEntryModal(bmType);
    });
  });

  document.getElementById('btn-benchmark-skip')?.addEventListener('click', () => {
    skipBenchmark();
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

  // Recovery buttons
  document.getElementById('btn-recovery-log')?.addEventListener('click', () => {
    showRecoveryInputModal();
  });
  document.getElementById('btn-recovery-log-panel')?.addEventListener('click', () => {
    showRecoveryInputModal();
  });
  document.getElementById('btn-recovery-adjust')?.addEventListener('click', () => {
    const today = new Date().toISOString().split('T')[0];
    const history: RecoveryEntry[] = s.recoveryHistory || [];
    const todayEntry = history.find((e: RecoveryEntry) => e.date === today);
    if (todayEntry) showRecoveryAdjustModal(todayEntry);
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
