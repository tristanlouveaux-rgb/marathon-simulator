import { getState, getMutableState } from '@/state/store';
import type { SimulatorState } from '@/types';
import { saveState } from '@/state/persistence';
import { render, attachTrackRunHandlers } from './renderer';
import { next, updateFitness, reset, editSettings, logActivity, setOnWeekAdvance, isBenchmarkWeek, findGarminRunForWeek, getBenchmarkOptions, getBenchmarkDefault, recordBenchmark, skipBenchmark } from './events';
import { setOnTrackingStart, setOnTrackingStop } from './gps-events';
import { attachRecordingsHandlers } from './gps-panel';
import { ft } from '@/utils/format';
import { openInjuryModal, renderInjuryBanner, isInjuryActive, markAsRecovered, getInjuryStateForDisplay } from './injury/modal';
import { recordMorningPain, getReturnToRunLevelLabel } from '@/injury/engine';
import type { MorningPainResponse } from '@/types/injury';
import { initializeSimulator } from '@/state/initialization';
import { computeRecoveryStatus, sleepQualityToScore } from '@/recovery/engine';
import type { RecoveryEntry, RecoveryLevel } from '@/recovery/engine';
import { generateWeekWorkouts, calculateWorkoutLoad } from '@/workouts';
import { isDeloadWeek, abilityBandFromVdot } from '@/workouts/plan_engine';
import { TL_PER_MIN, LOAD_PROFILES, LOAD_PER_MIN_BY_INTENSITY, SPORT_ALIASES, SPORTS_DB } from '@/constants';
import { syncActivities } from '@/data/activitySync';
import { syncStravaActivities } from '@/data/stravaSync';
import { syncPhysiologySnapshot } from '@/data/physiologySync';
import { computeACWR, computeWeekTSS } from '@/calculations/fitness-model';
import { SUPABASE_URL } from '@/data/supabaseClient';
import { normalizeSport, buildCrossTrainingPopup, workoutsToPlannedRuns, applyAdjustments, createActivity } from '@/cross-training';
import { showSuggestionModal, type ACWRModalContext } from '@/ui/suggestion-modal';
import { gp } from '@/calculations/paces';
import type { WorkoutMod } from '@/types';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { isSimulatorMode } from '@/main';

/** Persists the viewed week across renderMainView() re-renders. Null = use current week. */
let _persistedViewWeek: number | null = null;

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
  // Delegate to the new Plan view
  import('./plan-view').then(({ renderPlanView }) => renderPlanView());
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

/** Parse distance in km from a workout description string */
function parseDistanceKm(d: string): number {
  if (!d) return 0;
  if (/^\d+min\s/i.test(d) && !d.includes('km')) return 0;
  const simple = d.match(/^(\d+(?:\.\d+)?)\s*km/i);
  if (simple) return parseFloat(simple[1]);
  const intKm = d.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*km/i);
  if (intKm) return parseInt(intKm[1]) * parseFloat(intKm[2]);
  const intM = d.match(/(\d+)\s*x\s*(\d+)\s*m\b/i);
  if (intM) return parseInt(intM[1]) * parseInt(intM[2]) / 1000;
  return 0;
}

/** Compute total running km from completed workouts across all weeks */
function computeTotalKm(s: any): number {
  try {
    return _computeTotalKm(s);
  } catch {
    return 0;
  }
}

function _computeTotalKm(s: any): number {
  let total = 0;
  if (!s.wks) return 0;

  for (let i = 0; i < s.wks.length; i++) {
    const wk = s.wks[i];
    if (!wk.rated || Object.keys(wk.rated).length === 0) continue;

    // Past weeks: use stored completedKm (set on week advance, prefers garmin actuals)
    if (i < s.w - 1 && wk.completedKm != null) {
      total += wk.completedKm;
      continue;
    }

    const workouts = generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
      null, s.recurringActivities,
      s.onboarding?.experienceLevel, undefined, s.pac?.e,
      i + 1, s.tw, s.v, s.gs
    );

    if (wk.workoutMods) {
      for (const mod of wk.workoutMods) {
        const w = workouts.find((wo: any) => wo.n === mod.name && (mod.dayOfWeek == null || wo.dayOfWeek === mod.dayOfWeek));
        if (w) w.d = mod.newDistance;
      }
    }

    for (const w of workouts) {
      if (w.t === 'cross' || w.t === 'strength' || w.t === 'rest' || w.t === 'gym') continue;
      const wId = w.id || w.n;
      const rated = wk.rated[wId] ?? wk.rated[w.n];
      if (rated !== undefined && rated !== 'skip') {
        const actual = wk.garminActuals?.[wId];
        if (actual?.distanceKm) total += actual.distanceKm;
        else total += parseDistanceKm(w.d);
      }
    }

    if (wk.adhocWorkouts) {
      for (const w of wk.adhocWorkouts) {
        if (w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest' && w.t !== 'gym') {
          total += parseDistanceKm(w.d);
        }
      }
    }
  }

  return Math.round(total);
}

/**
 * Returns "Mon 17 Feb – Sun 23 Feb" for the given week, derived from planStartDate.
 * Returns null if planStartDate is not yet set (legacy users before migration).
 */
function getWeekDateLabel(s: any, weekNum: number): string | null {
  if (!s.planStartDate) return null;
  const weekStart = new Date(s.planStartDate);
  weekStart.setDate(weekStart.getDate() + (weekNum - 1) * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${fmt(weekStart)} – ${fmt(weekEnd)}`;
}

/**
 * Header subtitle text (below plan name)
 */
function getHeaderSubtitle(s: any, blockNum: number): string {
  const dateLabel = getWeekDateLabel(s, s.w);
  const dateSuffix = dateLabel ? ` · ${dateLabel}` : '';
  if (s.continuousMode) {
    return `Week ${s.w} — Block ${blockNum} · ${getPhaseLabel(s.wks?.[s.w - 1]?.ph, true)}${dateSuffix}`;
  }
  if (isInBlockCyclingPhase(s)) {
    return `Week ${s.w} — Block ${blockNum} · ${getPhaseLabel(s.wks?.[s.w - 1]?.ph, false)} (Race prep starts week ${s.racePhaseStart})${dateSuffix}`;
  }
  if (s.racePhaseStart) {
    const rpWeek = getRacePrepWeek(s);
    const rpTotal = getRacePrepTotal(s);
    return `Race Prep — Week ${rpWeek} of ${rpTotal} — ${getPhaseLabel(s.wks?.[s.w - 1]?.ph, false)}${dateSuffix}`;
  }
  return `Week ${s.w} of ${s.tw} — ${getPhaseLabel(s.wks?.[s.w - 1]?.ph, false)}${dateSuffix}`;
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
  const headerBg = injured ? 'border-b' : 'border-b';
  const titleStyle = injured ? 'color:var(--c-caution)' : 'color:var(--c-black)';
  const subtitleStyle = injured ? 'color:color-mix(in srgb,var(--c-caution) 70%,transparent)' : 'color:var(--c-faint)';
  const blockNum = getBlockNumber(s.w);
  const totalKm = computeTotalKm(s);


  return `
    <div class="min-h-screen pb-16" style="background:var(--c-bg)">
      <!-- Header - Changes color when injured -->
      <div class="${headerBg}" style="background:${injured ? 'rgba(245,158,11,0.08)' : 'var(--c-surface)'}">
        <div class="max-w-7xl mx-auto px-4 py-4">
          <div class="flex items-center justify-between">
            <div>
              <h1 class="text-xl font-semibold" style="${titleStyle}">${injured ? 'Recovery Mode' : `${s.onboarding?.name ? s.onboarding.name + "'s" : 'Your'} ${getPlanName(s)}`}</h1>
              <p class="text-xs" style="${subtitleStyle}">${injured ? 'Recovery Plan Active' : getHeaderSubtitle(s, blockNum)}</p>
            </div>
            <div class="flex items-center gap-3">
              ${renderStravaButton(s.stravaConnected)}
              ${injured ? `
                <button id="btn-recovered" class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors" style="background:var(--c-ok);color:white">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                  </svg>
                  I'm Recovered
                </button>
              ` : ''}
              <button id="btn-report-injury" class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors" style="${injured ? 'background:var(--c-caution);color:white' : 'background:rgba(0,0,0,0.08);color:var(--c-black)'}">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                </svg>
                ${injured ? 'Update Injury' : 'Report Injury'}
              </button>
              ${isSimulatorMode() ? '<span class="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style="background:rgba(245,158,11,0.12);color:var(--c-caution)">SIM</span>' : ''}
            </div>
          </div>
        </div>
      </div>

      <div class="max-w-7xl mx-auto px-4 py-6">

        <!-- Injury Alert Banner -->
        ${renderInjuryBanner()}

        <!-- Recovery Pill -->
        ${renderRecoveryPill(s)}

        <!-- Morning Pain Check (shown when injured, once per day) -->
        ${renderMorningPainCheck(s)}

        <!-- Medical Disclaimer (shown during return_to_run phase) -->
        ${renderMedicalDisclaimer(s)}

        <!-- Benchmark Check-in (shown on benchmark weeks for continuous mode) -->
        ${renderBenchmarkPanel(s)}

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">

          <!-- Left Column -->
          <div class="lg:col-span-1 space-y-4">

            <!-- Week Navigator -->
            <div class="rounded-lg border p-4" style="background:var(--c-surface);border-color:var(--c-border)">
              <div class="flex items-center justify-between mb-3">
                <div>
                  <h3 class="text-sm font-medium" style="color:var(--c-black)">${getWeekNavigatorLabel(s, blockNum)}</h3>
                  <p id="week-date-label" class="text-xs mt-0.5" style="color:var(--c-faint)">${getWeekDateLabel(s, s.w) ?? ''}</p>
                </div>
                <div class="flex gap-2">
                  <button id="week-prev" class="p-2 rounded transition-colors ${s.w <= 1 ? 'opacity-50 cursor-not-allowed' : ''}" style="background:rgba(0,0,0,0.05)">
                    <svg class="w-4 h-4" style="color:var(--c-muted)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
                    </svg>
                  </button>
                  <button id="week-next" class="p-2 rounded transition-colors ${s.w >= maxViewableWeek ? 'opacity-50 cursor-not-allowed' : ''}" style="background:rgba(0,0,0,0.05)" title="${s.w >= maxViewableWeek ? 'Last viewable week' : 'Next week'}">
                    <svg class="w-4 h-4" style="color:var(--c-muted)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                    </svg>
                  </button>
                </div>
              </div>

              <!-- Week slider -->
              <input type="range" id="week-slider" min="1" max="${maxViewableWeek}" value="${s.w}"
                     class="w-full h-2 rounded-lg appearance-none cursor-pointer" style="background:rgba(0,0,0,0.10);accent-color:var(--c-ok)">

              <div id="view-week-indicator" class="hidden mt-2 p-2 rounded text-xs text-center" style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25)"></div>

              ${!s.isAdmin && maxViewableWeek < s.tw ? `
                <div class="mt-3 p-2 rounded text-xs" style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);color:var(--c-caution)">
                  Free trial: ${maxViewableWeek} weeks visible. Upgrade for full ${s.tw}-week plan.
                </div>
              ` : ''}

              <div class="mt-3 space-y-2">
                <button id="btn-complete-week" class="w-full font-medium py-2 rounded text-sm transition-colors" style="background:var(--c-ok);color:white">
                  Complete Week
                </button>
                ${SUPABASE_URL ? `
                <button id="btn-sync-now" class="w-full py-2 rounded text-sm transition-colors flex items-center justify-center gap-2" style="background:rgba(0,0,0,0.05);color:var(--c-muted)">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                  ${s.stravaConnected ? 'Sync Strava' : s.wearable === 'apple' ? 'Sync Apple Watch' : 'Sync Garmin'}
                </button>
                ` : ''}
              </div>
              <div id="st" class="mt-2 text-xs" style="color:var(--c-faint)"></div>
            </div>


            <!-- Recovery Log (last 7 days) -->
            ${renderRecoveryLog(s)}


          </div>

          <!-- Right Column -->
          <div class="lg:col-span-2 space-y-4">

            <!-- Strava Banner (only shown when not yet connected) -->
            ${!s.stravaConnected ? `
            <div class="rounded-lg p-4" style="background:rgba(249,115,22,0.07);border:1px solid rgba(249,115,22,0.20)">
              <div class="flex items-center gap-3">
                <svg class="w-6 h-6" style="color:#F97316" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/>
                </svg>
                <div class="flex-1">
                  <p class="text-sm font-medium" style="color:#F97316">Automatic workout logging</p>
                  <p class="text-xs" style="color:var(--c-muted)">Workouts are automatically logged from Strava but feel free to manually add workouts too.</p>
                </div>
              </div>
            </div>
            ` : ''}

            <!-- Prediction / Progress Box -->
            ${s.continuousMode ? renderContinuousProgressPanel(s) : (injured ? renderRecoveryProgressPanel(s) : `
            <div class="rounded-lg border p-5" style="background:var(--c-surface);border-color:var(--c-border)">
              <!-- Phase Display (Big & Bold) -->
              <div class="mb-5 pb-5 border-b" style="border-color:var(--c-border)">
                <div class="text-xs uppercase tracking-widest mb-1 font-semibold" style="color:var(--c-faint)">Current Phase</div>
                <div id="phase-label" class="text-4xl font-bold tracking-tight" style="color:var(--c-black)">${getPhaseLabel(s.wks?.[s.w - 1]?.ph, s.continuousMode)}</div>
                <p id="week-counter" class="text-sm mt-1 font-medium" style="color:var(--c-ok)">${getWeekCounterLabel(s)}</p>
              </div>

              <!-- Predictions -->
              <h3 class="font-medium text-sm mb-4" style="color:var(--c-muted)">Race Prediction</h3>
              <div id="pred" class="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div class="text-xs mb-1" style="color:var(--c-faint)">Initial</div>
                  <div class="text-lg font-medium" style="color:var(--c-faint)" id="initial">${ft(s.initialBaseline || 0)}</div>
                </div>
                <div>
                  <div class="text-xs mb-1 cursor-help" style="color:var(--c-faint)" onclick="this.nextElementSibling?.nextElementSibling?.classList.toggle('hidden')" title="Click for details">Current</div>
                  <div class="text-xl font-bold" style="color:var(--c-black)" id="cv">${ft(s.currentFitness || 0)}</div>
                  <div class="hidden text-xs mt-1 rounded px-2 py-1" style="color:var(--c-muted);background:rgba(0,0,0,0.05)">Our prediction if you were to run today</div>
                </div>
                <div>
                  <div class="text-xs mb-1" style="color:var(--c-faint)">Forecast</div>
                  <div class="text-2xl font-bold" style="color:var(--c-ok)" id="fc">${ft(s.forecastTime || 0)}</div>
                </div>
              </div>
            </div>
            `)}

            <!-- Week Progress -->
            <div class="rounded-lg border p-4" style="background:var(--c-surface);border-color:var(--c-border)">
              <h3 class="text-xs font-semibold uppercase tracking-wide mb-3" style="color:var(--c-faint)">This Week</h3>
              <div class="space-y-3">
                <div>
                  <div class="flex items-baseline justify-between mb-1.5">
                    <span class="text-xs" style="color:var(--c-faint)">Km</span>
                    <div class="flex items-baseline gap-1">
                      <span class="text-lg font-bold" style="color:var(--c-black)" id="stat-km">0</span>
                      <span class="text-xs" style="color:var(--c-faint)">/ <span id="stat-km-planned">—</span> planned</span>
                    </div>
                  </div>
                  <div class="h-1.5 rounded-full overflow-hidden" style="background:rgba(0,0,0,0.08)">
                    <div id="stat-km-bar" class="h-full rounded-full transition-all" style="width:0%;background:var(--c-ok)"></div>
                  </div>
                </div>
                ${s.onboarding?.hasSmartwatch ? `
                <div>
                  <!-- Training Load (TSS) — split bar: running (blue) + cross-training (purple) -->
                  <div class="flex items-baseline justify-between mb-1.5">
                    <div class="flex items-center gap-1">
                      <span class="text-xs" style="color:var(--c-faint)">Training Load</span>
                      <button id="tss-info-btn" class="text-[10px] leading-none rounded-full w-3.5 h-3.5 flex items-center justify-center transition-colors" style="color:var(--c-faint);border:1px solid var(--c-border)">?</button>
                    </div>
                    <div class="flex items-baseline gap-1">
                      <span class="text-lg font-bold" style="color:var(--c-black)" id="stat-load-actual">—</span>
                      <span class="text-xs" style="color:var(--c-faint)">/ <span id="stat-load-planned">—</span> TSS planned</span>
                    </div>
                  </div>
                  <!-- Training Load — zoned bar -->
                  <!-- Parent background = danger zone colour; zone bands draw on top from left -->
                  <div class="relative h-3 rounded-full overflow-hidden mb-1" style="background:rgba(239,68,68,0.10)">
                    <!-- Zone bands (updated by updateLoadChart) -->
                    <div class="absolute inset-0 flex">
                      <div id="zone-load-baseline" class="h-full shrink-0 transition-all" style="width:0%;background:rgba(0,0,0,0.12)"></div>
                      <div id="zone-load-target"   class="h-full shrink-0 transition-all" style="width:0%;background:rgba(34,197,94,0.18)"></div>
                      <div id="zone-load-caution"  class="h-full shrink-0 transition-all" style="width:0%;background:rgba(245,158,11,0.18)"></div>
                    </div>
                    <!-- Actual fill: run (blue) + cross (purple), on top of zones -->
                    <div class="absolute inset-0 flex overflow-hidden">
                      <div id="stat-load-bar-run"   class="h-full transition-all shrink-0" style="width:0%;background:rgba(59,130,246,0.7)"></div>
                      <div id="stat-load-bar-cross" class="h-full transition-all shrink-0" style="width:0%;background:rgba(168,85,247,0.7)"></div>
                    </div>
                    <!-- Plan target line -->
                    <div id="stat-load-plan-line" class="absolute top-0 bottom-0 w-0.5 hidden transition-all" style="left:71%;background:rgba(0,0,0,0.20)"></div>
                  </div>
                  <!-- Zone axis labels -->
                  <div id="stat-load-axis" class="relative mb-1.5" style="height:11px">
                    <!-- populated by updateLoadChart -->
                  </div>
                  <div class="flex items-center gap-3 mb-0.5">
                    <span id="stat-load-pct" class="text-[10px] flex-1" style="color:var(--c-faint)"></span>
                    <div class="flex items-center gap-2 text-[9px]" style="color:var(--c-faint)">
                      <span class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full inline-block" style="background:var(--c-accent)"></span>Run</span>
                      <span class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full inline-block" style="background:#A855F7"></span>Cross</span>
                    </div>
                  </div>
                  <!-- Running Volume — zoned bar -->
                  <div class="mt-2 pt-2 border-t" style="border-color:var(--c-border)">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-[10px]" style="color:var(--c-faint)">Running Volume</span>
                      <div class="flex items-baseline gap-1 text-[10px]">
                        <span class="font-medium" style="color:var(--c-black)" id="stat-vol-run">—</span>
                        <span style="color:var(--c-faint)">km run</span>
                        <span class="mx-0.5" style="color:var(--c-faint)">+</span>
                        <span class="font-medium" style="color:var(--c-muted)" id="stat-vol-cross">0</span>
                        <span style="color:var(--c-faint)">km GPS sports</span>
                      </div>
                    </div>
                    <div class="relative h-3 rounded-full overflow-hidden mb-1" style="background:rgba(239,68,68,0.10)">
                      <div class="absolute inset-0 flex">
                        <div id="zone-vol-baseline" class="h-full shrink-0 transition-all" style="width:0%;background:rgba(0,0,0,0.12)"></div>
                        <div id="zone-vol-target"   class="h-full shrink-0 transition-all" style="width:0%;background:rgba(34,197,94,0.18)"></div>
                        <div id="zone-vol-caution"  class="h-full shrink-0 transition-all" style="width:0%;background:rgba(245,158,11,0.18)"></div>
                      </div>
                      <div class="absolute inset-0 flex overflow-hidden">
                        <div id="stat-vol-bar-run"   class="h-full transition-all shrink-0" style="width:0%;background:rgba(59,130,246,0.7)"></div>
                        <div id="stat-vol-bar-cross" class="h-full transition-all shrink-0" style="width:0%;background:rgba(147,197,253,0.5)"></div>
                      </div>
                      <div id="stat-vol-plan-line" class="absolute top-0 bottom-0 w-0.5 hidden" style="left:71%;background:rgba(0,0,0,0.20)"></div>
                    </div>
                    <div id="stat-vol-axis" class="relative mb-0.5" style="height:11px">
                      <!-- populated by updateLoadChart -->
                    </div>
                    <div class="flex items-center justify-between">
                      <span id="stat-vol-note" class="text-[10px]" style="color:var(--c-faint)"></span>
                      <span class="text-[9px]" style="color:var(--c-faint)">/ <span id="stat-vol-planned">—</span> km planned</span>
                    </div>
                    <div id="stat-km-floor-nudge" class="text-[10px] mt-1" style="color:var(--c-caution);display:none"></div>
                  </div>
                  <p class="text-[10px] mt-2 mb-1" style="color:var(--c-faint)">Zone progress vs plan</p>
                  <div class="space-y-1" id="zone-bars-container">
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] w-14 shrink-0" style="color:var(--c-accent)">Base</span>
                      <div class="flex-1 rounded-full h-1.5 overflow-hidden" style="background:rgba(0,0,0,0.08)">
                        <div id="zone-bar-base" class="h-full rounded-full transition-all" style="width:0%;background:var(--c-accent)"></div>
                      </div>
                      <span class="text-[10px] w-12 text-right" style="color:var(--c-accent)" id="stat-load-base-label"></span>
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] w-14 shrink-0" style="color:var(--c-caution)">Threshold</span>
                      <div class="flex-1 rounded-full h-1.5 overflow-hidden" style="background:rgba(0,0,0,0.08)">
                        <div id="zone-bar-threshold" class="h-full rounded-full transition-all" style="width:0%;background:var(--c-caution)"></div>
                      </div>
                      <span class="text-[10px] w-12 text-right" style="color:var(--c-caution)" id="stat-load-threshold-label"></span>
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] w-14 shrink-0" style="color:#F97316">Intensity</span>
                      <div class="flex-1 rounded-full h-1.5 overflow-hidden" style="background:rgba(0,0,0,0.08)">
                        <div id="zone-bar-intensity" class="h-full rounded-full transition-all" style="width:0%;background:#F97316"></div>
                      </div>
                      <span class="text-[10px] w-12 text-right" style="color:#F97316" id="stat-load-intensity-label"></span>
                    </div>
                  </div>

                  <!-- ACWR Injury Risk bar -->
                  <div class="pt-3 border-t mt-3" style="border-color:var(--c-border)">
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-xs" style="color:var(--c-faint)">Injury Risk</span>
                      <button id="acwr-info-btn" class="text-[10px] leading-none rounded-full w-3.5 h-3.5 flex items-center justify-center transition-colors" style="color:var(--c-faint);border:1px solid var(--c-border)">?</button>
                    </div>
                    <div id="acwr-bar-container">
                      <!-- Populated by updateACWRBar() -->
                      <p class="text-[10px]" style="color:var(--c-faint)">Building baseline…</p>
                    </div>
                    <!-- Escalating injury risk label — populated by updateACWRBar() -->
                    <div id="acwr-risk-label" class="hidden mt-1.5"></div>
                    <div class="flex gap-2 mt-2">
                      <button id="acwr-reduce-btn"
                              class="hidden flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors" style="background:rgba(245,158,11,0.15);color:var(--c-caution)">
                        Reduce this week
                      </button>
                      <button id="acwr-dismiss-btn"
                              class="hidden py-1.5 px-3 text-xs rounded-lg transition-colors" style="background:rgba(0,0,0,0.05);color:var(--c-faint)">
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
                ` : ''}
              </div>
            </div>

            <!-- Workouts -->
            <div class="rounded-lg border p-4" style="background:var(--c-surface);border-color:var(--c-border)">
              <div id="acwr-lightened-banner"></div>
              <div id="acwr-carry-banner"></div>
              <div id="wo">
                <!-- Workouts rendered here by render() -->
              </div>
            </div>


          </div>
        </div>
      </div>
      ${renderTabBar('plan', isSimulatorMode())}
    </div>
  `;
}

function renderStravaButton(connected: boolean): string {
  if (connected) {
    return `
      <div class="flex items-center gap-2 px-3 py-1.5 rounded-full" style="background:rgba(249,115,22,0.08);border:1px solid rgba(249,115,22,0.20)">
        <div class="w-2 h-2 rounded-full" style="background:var(--c-ok)"></div>
        <span class="text-xs" style="color:#F97316">Strava Connected</span>
      </div>
    `;
  }

  return `
    <button id="btn-connect-strava" class="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-colors" style="background:#F97316;color:white">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/>
      </svg>
      Connect Strava
    </button>
  `;
}

/**
 * Render recovery progress panel (replaces prediction panel when injured).
 * Shows phase, return-to-run level, and weeks in recovery — no forecast numbers.
 */
function renderRecoveryProgressPanel(s: any): string {
  const injuryState = getInjuryStateForDisplay();
  const phase = injuryState.injuryPhase;
  const rehabWeeks = s.rehabWeeksDone || 0;

  const phaseLabels: Record<string, { label: string; colorStyle: string }> = {
    acute: { label: 'Acute (Rest)', colorStyle: 'color:var(--c-warn)' },
    rehab: { label: 'Rehabilitation', colorStyle: 'color:var(--c-caution)' },
    test_capacity: { label: 'Capacity Testing', colorStyle: 'color:#A855F7' },
    return_to_run: { label: 'Return to Run', colorStyle: 'color:var(--c-accent)' },
    graduated_return: { label: 'Graduated Return', colorStyle: 'color:#06B6D4' },
    resolved: { label: 'Resolved', colorStyle: 'color:var(--c-ok)' },
  };
  const phaseInfo = phaseLabels[phase] || { label: 'Recovery', colorStyle: 'color:var(--c-muted)' };

  const levelInfo = phase === 'return_to_run'
    ? `<div class="text-sm mt-2" style="color:var(--c-muted)">${getReturnToRunLevelLabel(injuryState.returnToRunLevel || 1)}</div>`
    : phase === 'graduated_return'
      ? `<div class="text-sm mt-2" style="color:var(--c-muted)">Week ${2 - (injuryState.graduatedReturnWeeksLeft || 0) + 1} of 2</div>`
      : '';

  const painDisplay = injuryState.currentPain === 0
    ? `<span class="font-bold" style="color:var(--c-ok)">0</span>`
    : `<span class="font-bold" style="${injuryState.currentPain <= 2 ? 'color:var(--c-caution)' : 'color:var(--c-warn)'}">${injuryState.currentPain}</span>`;

  return `
    <div class="rounded-lg border p-5" style="background:var(--c-surface);border-color:var(--c-border)">
      <div class="mb-5 pb-5 border-b" style="border-color:var(--c-border)">
        <div class="text-xs uppercase tracking-widest mb-1 font-semibold" style="color:var(--c-faint)">Recovery Phase</div>
        <div class="text-4xl font-bold tracking-tight" style="${phaseInfo.colorStyle}">${phaseInfo.label}</div>
        ${levelInfo}
      </div>

      <div class="grid grid-cols-3 gap-4 text-center">
        <div>
          <div class="text-xs mb-1" style="color:var(--c-faint)">Pain</div>
          <div class="text-xl font-bold">${painDisplay}<span class="text-sm" style="color:var(--c-faint)">/10</span></div>
        </div>
        <div>
          <div class="text-xs mb-1" style="color:var(--c-faint)">Weeks in Recovery</div>
          <div class="text-xl font-bold" style="color:var(--c-black)">${rehabWeeks}</div>
        </div>
        <div>
          <div class="text-xs mb-1" style="color:var(--c-faint)">Can Run</div>
          <div class="text-xl font-bold" style="${injuryState.canRun === 'yes' ? 'color:var(--c-ok)' : injuryState.canRun === 'limited' ? 'color:var(--c-caution)' : 'color:var(--c-warn)'}">${injuryState.canRun === 'yes' ? 'Yes' : injuryState.canRun === 'limited' ? 'Limited' : 'No'}</div>
        </div>
      </div>

      <div class="mt-4 pt-4 border-t" style="border-color:var(--c-border)">
        <p class="text-xs text-center" style="color:var(--c-faint)">Race predictions are paused during recovery. They'll return when you're back to full training.</p>
      </div>
    </div>
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
  const currentVdot = (s.v || 0) + wg + (s.rpeAdj || 0) + (s.physioAdj || 0);
  const vdotChange = currentVdot - (s.iv || s.v || 0);
  const vdotPct = (s.iv || s.v) ? (vdotChange / (s.iv || s.v)) * 100 : 0;

  // LT and VO2 stats
  const ltCurrent = s.lt || s.ltPace;
  const ltInitial = s.initialLT;
  const ltPct = (ltCurrent && ltInitial) ? ((ltInitial - ltCurrent) / ltInitial) * 100 : 0;
  const ltPaceStr = ltCurrent
    ? `${Math.floor(ltCurrent / 60)}:${String(Math.round(ltCurrent % 60)).padStart(2, '0')}/km`
    : '—';

  const vo2Current = s.vo2;
  const vo2Initial = s.initialVO2;
  const vo2Pct = (vo2Current && vo2Initial) ? ((vo2Current - vo2Initial) / vo2Initial) * 100 : 0;

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
    <div class="rounded-lg border p-5" style="background:var(--c-surface);border-color:var(--c-border)">
      <!-- Phase Display (Big & Bold) -->
      <div class="mb-5 pb-5 border-b" style="border-color:var(--c-border)">
        <div class="text-xs uppercase tracking-widest mb-1 font-semibold" style="color:var(--c-faint)">Current Phase</div>
        <div id="phase-label" class="text-4xl font-bold tracking-tight" style="color:var(--c-black)">${getPhaseLabel(currentPhase, true)}</div>
        <p id="week-counter" class="text-sm mt-1 font-medium" style="color:var(--c-ok)">Block ${blockNum} · Week ${blockWeek} of 4</p>
      </div>

      <h3 class="font-medium text-sm mb-4" style="color:var(--c-black)">Fitness Progress</h3>

      <!-- Fitness Metrics Grid -->
      <div id="pred" class="grid grid-cols-3 gap-2 mb-6">
        <!-- VDOT -->
        <div class="rounded-lg p-3 border" style="background:rgba(0,0,0,0.03);border-color:var(--c-border)">
          <div class="text-[10px] uppercase tracking-wider mb-1" style="color:var(--c-faint)">VDOT</div>
          <div class="text-xl font-bold" style="color:var(--c-black)">${currentVdot.toFixed(1)}</div>
          ${vdotPct !== 0 ? `
            <div class="inline-flex items-center px-1.5 py-0.5 mt-1 rounded text-[10px] font-medium" style="${vdotPct > 0 ? 'background:rgba(34,197,94,0.10);color:var(--c-ok)' : 'background:rgba(239,68,68,0.10);color:var(--c-warn)'}">
              ${vdotPct > 0 ? '↑' : '↓'} ${Math.abs(vdotPct).toFixed(1)}%
            </div>
          ` : '<div class="h-4"></div>'}
        </div>

        <!-- LT Threshold -->
        <div class="rounded-lg p-3 border" style="background:rgba(0,0,0,0.03);border-color:var(--c-border)">
          <div class="text-[10px] uppercase tracking-wider mb-1" style="color:var(--c-faint)">LT Pace</div>
          <div class="text-xl font-bold" style="color:var(--c-ok)">${ltPaceStr}</div>
          ${ltPct !== 0 ? `
            <div class="inline-flex items-center px-1.5 py-0.5 mt-1 rounded text-[10px] font-medium" style="${ltPct > 0 ? 'background:rgba(34,197,94,0.10);color:var(--c-ok)' : 'background:rgba(239,68,68,0.10);color:var(--c-warn)'}">
              ${ltPct > 0 ? '↑' : '↓'} ${Math.abs(ltPct).toFixed(1)}%
            </div>
          ` : '<div class="h-4"></div>'}
        </div>

        <!-- VO2max -->
        <div class="rounded-lg p-3 border" style="background:rgba(0,0,0,0.03);border-color:var(--c-border)">
          <div class="text-[10px] uppercase tracking-wider mb-1" style="color:var(--c-faint)">VO2max</div>
          <div class="text-xl font-bold" style="color:var(--c-accent)">${vo2Current?.toFixed(1) || '—'}</div>
          ${vo2Pct !== 0 ? `
            <div class="inline-flex items-center px-1.5 py-0.5 mt-1 rounded text-[10px] font-medium" style="${vo2Pct > 0 ? 'background:rgba(34,197,94,0.10);color:var(--c-ok)' : 'background:rgba(239,68,68,0.10);color:var(--c-warn)'}">
              ${vo2Pct > 0 ? '↑' : '↓'} ${Math.abs(vo2Pct).toFixed(1)}%
            </div>
          ` : '<div class="h-4"></div>'}
        </div>
      </div>

      <!-- Block Progress Bar -->
      <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs" style="color:var(--c-muted)">Block ${blockNum} · Week ${blockWeek} of 4</span>
          <span class="text-xs font-medium" style="${blockWeek === 4 ? 'color:var(--c-accent)' : blockWeek === 3 ? 'color:#F97316' : 'color:var(--c-ok)'}">${blockPhaseLbl}</span>
        </div>
        <div class="flex gap-1">
          ${[1, 2, 3, 4].map(i => `
            <div class="flex-1 h-2 rounded-full" style="background:${i < blockWeek ? 'var(--c-ok)' :
      i === blockWeek ? (i === 4 ? 'var(--c-accent)' : i === 3 ? '#F97316' : 'var(--c-ok)') :
        'rgba(0,0,0,0.10)'
    }"></div>
          `).join('')}
        </div>
        ${blockWeek === 4 ? `<p class="text-xs mt-2" style="color:var(--c-accent)">Deload week — lighter training + optional check-in</p>` : blockWeek === 3 ? `<p class="text-xs mt-2" style="color:#F97316">Intensify week — peak training load</p>` : ''}
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
  // Never suggest hard efforts on deload/recovery weeks
  const ability = abilityBandFromVdot(s.v ?? 40, s.onboarding?.experienceLevel ?? 'intermediate');
  if (isDeloadWeek(s.w, ability)) return '';

  // Check if benchmark already recorded/skipped for this week
  const existing = s.benchmarkResults?.find((b: any) => b.week === s.w);
  if (existing) {
    if (existing.source === 'skipped') {
      return `
        <div class="rounded-lg p-4 mb-4" style="background:rgba(0,0,0,0.04);border:1px solid var(--c-border)">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4" style="color:var(--c-faint)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/>
            </svg>
            <p class="text-sm" style="color:var(--c-muted)">Check-in skipped this block — no worries, keep training!</p>
          </div>
        </div>
      `;
    }
    // Show recorded result
    const resultDetails = formatBenchmarkResult(existing);
    return `
      <div class="rounded-lg p-4 mb-4" style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.30)">
        <div class="flex items-center gap-2 mb-1">
          <svg class="w-4 h-4" style="color:var(--c-ok)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
          </svg>
          <span class="text-sm font-medium" style="color:var(--c-ok)">Check-in Recorded</span>
          ${existing.source === 'garmin' ? '<span class="text-xs px-2 py-0.5 rounded-full" style="background:rgba(249,115,22,0.10);color:#F97316;border:1px solid rgba(249,115,22,0.20)">From watch</span>' : ''}
        </div>
        <p class="text-xs" style="color:var(--c-muted)">${resultDetails}</p>
      </div>
    `;
  }

  const options = getBenchmarkOptions(s.onboarding?.trainingFocus, s.onboarding?.experienceLevel);
  const garminRun = findGarminRunForWeek(s.w);

  return `
    <div class="rounded-lg p-4 mb-4" style="background:rgba(78,159,229,0.06);border:1px solid rgba(78,159,229,0.30)">
      <div class="flex items-start gap-3">
        <div class="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center" style="background:rgba(78,159,229,0.12)">
          <svg class="w-5 h-5" style="color:var(--c-accent)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
          </svg>
        </div>
        <div class="flex-1">
          <h3 class="text-sm font-semibold mb-1" style="color:var(--c-accent)">Optional Check-in</h3>
          <p class="text-xs mb-3" style="color:var(--c-muted)">See how your fitness is tracking. Totally optional — skip anytime.</p>

          ${garminRun ? `
            <div class="rounded-lg p-3 mb-3" style="background:rgba(249,115,22,0.07);border:1px solid rgba(249,115,22,0.20)">
              <div class="flex items-center gap-2 mb-1">
                <svg class="w-4 h-4" style="color:#F97316" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/>
                </svg>
                <span class="text-xs font-medium" style="color:#F97316">Run detected from watch</span>
              </div>
              <p class="text-xs" style="color:var(--c-muted)">${garminRun.duration_min}min run · RPE ${garminRun.rpe}</p>
              <button id="btn-benchmark-auto" class="mt-2 px-4 py-2 text-xs font-medium rounded-lg transition-colors" style="background:var(--c-ok);color:white">
                Use This Run as Check-in
              </button>
            </div>
          ` : ''}

          <!-- Benchmark options (smart default first) -->
          <div class="space-y-2 mb-3">
            ${options.map((opt, _idx) => `
              <button class="btn-benchmark-option w-full text-left p-3 rounded-lg border transition-colors" style="${opt.recommended
      ? 'background:rgba(78,159,229,0.08);border-color:rgba(78,159,229,0.40)'
      : 'background:rgba(0,0,0,0.03);border-color:var(--c-border)'
    }" data-bm-type="${opt.type}">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium" style="${opt.recommended ? 'color:var(--c-accent)' : 'color:var(--c-black)'}">${opt.label}</span>
                  ${opt.recommended ? '<span class="text-xs px-2 py-0.5 rounded-full" style="background:rgba(78,159,229,0.12);color:var(--c-accent)">Recommended</span>' : ''}
                </div>
                <p class="text-xs mt-0.5" style="color:var(--c-faint)">${opt.description}</p>
              </button>
            `).join('')}
          </div>

          <button id="btn-benchmark-skip" class="w-full py-2 text-xs font-medium rounded-lg transition-colors" style="background:rgba(0,0,0,0.05);color:var(--c-muted)">
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
        <label class="block text-xs mb-1" style="color:var(--c-muted)">Distance covered (km)</label>
        <input type="number" id="bm-distance" step="0.01" min="0.5" max="6"
          class="w-full rounded-lg px-3 py-2 text-sm mb-4" style="background:rgba(0,0,0,0.05);border:1px solid var(--c-border);color:var(--c-black)"
          placeholder="e.g. 2.80">
      `;
      break;
    case 'race_simulation':
      title = 'Race Simulation';
      desc = 'Log your time trial result.';
      fieldsHTML = `
        <label class="block text-xs mb-1" style="color:var(--c-muted)">Distance (km)</label>
        <input type="number" id="bm-distance" step="0.1" min="1" max="42.2"
          class="w-full rounded-lg px-3 py-2 text-sm mb-3" style="background:rgba(0,0,0,0.05);border:1px solid var(--c-border);color:var(--c-black)"
          placeholder="e.g. 5">
        <label class="block text-xs mb-1" style="color:var(--c-muted)">Time</label>
        <div class="flex gap-2 mb-4">
          <input type="number" id="bm-time-min" min="5" max="300"
            class="flex-1 rounded-lg px-3 py-2 text-sm" style="background:rgba(0,0,0,0.05);border:1px solid var(--c-border);color:var(--c-black)"
            placeholder="min">
          <span class="self-center" style="color:var(--c-faint)">:</span>
          <input type="number" id="bm-time-sec" min="0" max="59"
            class="flex-1 rounded-lg px-3 py-2 text-sm" style="background:rgba(0,0,0,0.05);border:1px solid var(--c-border);color:var(--c-black)"
            placeholder="sec">
        </div>
      `;
      break;
  }

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
  overlay.innerHTML = `
    <div class="rounded-xl max-w-sm w-full p-6" style="background:var(--c-surface);border:1px solid var(--c-border)">
      <h3 class="font-semibold text-lg mb-2" style="color:var(--c-black)">${title}</h3>
      <p class="text-sm mb-4" style="color:var(--c-muted)">${desc}</p>
      ${fieldsHTML}
      <div class="flex flex-col gap-2">
        <button id="btn-bm-submit" class="w-full py-2.5 font-medium rounded-lg transition-colors text-sm" style="background:var(--c-ok);color:white">
          Save
        </button>
        <button id="btn-bm-cancel" class="w-full py-2.5 font-medium rounded-lg transition-colors text-sm" style="background:rgba(0,0,0,0.05);color:var(--c-muted)">
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
    <label class="block text-xs mb-1" style="color:var(--c-muted)">Average pace (min:sec per km)</label>
    <div class="flex gap-2 mb-4">
      <input type="number" id="bm-pace-min" min="2" max="12"
        class="flex-1 rounded-lg px-3 py-2 text-sm" style="background:rgba(0,0,0,0.05);border:1px solid var(--c-border);color:var(--c-black)"
        placeholder="min">
      <span class="self-center" style="color:var(--c-faint)">:</span>
      <input type="number" id="bm-pace-sec" min="0" max="59"
        class="flex-1 rounded-lg px-3 py-2 text-sm" style="background:rgba(0,0,0,0.05);border:1px solid var(--c-border);color:var(--c-black)"
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
      <button id="btn-recovery-log" class="inline-flex items-center gap-2 px-4 py-2 mb-4 rounded-full text-xs font-medium transition-colors" style="background:rgba(0,0,0,0.05);border:1px solid var(--c-border);color:var(--c-muted)">
        <span class="w-2 h-2 rounded-full" style="background:var(--c-faint)"></span>
        Recovery: Log today
      </button>
    `;
  }

  if (level === 'green') {
    return `
      <div class="inline-flex items-center gap-2 px-4 py-2 mb-4 rounded-full text-xs font-medium" style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.30);color:var(--c-ok)">
        <span class="w-2 h-2 rounded-full" style="background:var(--c-ok)"></span>
        Recovery: Good
      </div>
    `;
  }

  if (shouldPrompt && !alreadyPrompted) {
    const colorStyle: Record<RecoveryLevel, string> = {
      green: '',
      yellow: 'background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.30);color:var(--c-caution)',
      orange: 'background:rgba(249,115,22,0.08);border:1px solid rgba(249,115,22,0.30);color:#F97316',
      red: 'background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.30);color:var(--c-warn)',
    };
    const dotStyle: Record<RecoveryLevel, string> = {
      green: '',
      yellow: 'background:var(--c-caution)',
      orange: 'background:#F97316',
      red: 'background:var(--c-warn)',
    };
    return `
      <button id="btn-recovery-adjust" class="inline-flex items-center gap-2 px-4 py-2 mb-4 rounded-full text-xs font-medium transition-colors" style="${colorStyle[level]}">
        <span class="w-2 h-2 rounded-full" style="${dotStyle[level]}"></span>
        Recovery: Low — Tap to adjust
      </button>
    `;
  }

  // Already prompted today — small status dot only
  const dotStyle: Record<RecoveryLevel, string> = {
    green: 'background:var(--c-ok)',
    yellow: 'background:var(--c-caution)',
    orange: 'background:#F97316',
    red: 'background:var(--c-warn)',
  };
  return `
    <div class="inline-flex items-center gap-2 px-3 py-1.5 mb-4 rounded-full text-xs" style="color:var(--c-faint)">
      <span class="w-2 h-2 rounded-full" style="${dotStyle[level]}"></span>
      Recovery logged
    </div>
  `;
}

function renderPhysiologyCard(s: any): string {
  const history: import('@/types').PhysiologyDayEntry[] = s.physiologyHistory || [];
  const latest = history.length > 0 ? history[history.length - 1] : null;

  // Rolling helpers — day-to-day HR is noisy; averages are more meaningful
  const numVals = (vals: (number | undefined)[]) => vals.filter((v): v is number => v !== undefined);
  const rollAvg = (vals: (number | undefined)[]) => { const n = numVals(vals); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null; };
  const rollPeak = (vals: (number | undefined)[]) => { const n = numVals(vals); return n.length ? Math.max(...n) : null; };

  const rhr    = rollAvg(history.map(h => h.restingHR)) ?? s.restingHR ?? null;
  const maxHR  = rollPeak(history.map(h => h.maxHR)) ?? s.maxHR ?? null;
  const hrv    = rollAvg(history.map(h => h.hrvRmssd));
  const vo2    = latest?.vo2max ?? s.vo2;
  const ltPace = latest?.ltPace ?? s.lt;
  const ltHR   = latest?.ltHR ?? s.ltHR;

  if (!rhr && !maxHR && hrv == null && !vo2 && !ltPace && !ltHR) return '';

  // sec/km → M:SS/km
  const fmtPace = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s2 = sec % 60;
    return `${m}:${String(s2).padStart(2, '0')}/km`;
  };

  // Compare latest vs prev-N average; returns coloured arrow or empty string
  const trendArrow = (vals: (number | undefined)[], higherIsBetter: boolean): string => {
    const nums = vals.filter((v): v is number => v !== undefined);
    if (nums.length < 2) return '';
    const last = nums[nums.length - 1];
    const avg  = nums.slice(0, -1).reduce((a, b) => a + b, 0) / (nums.length - 1);
    const diff = last - avg;
    if (Math.abs(diff) < 0.5) return '';
    const good = higherIsBetter ? diff > 0 : diff < 0;
    return `<span style="font-size:10px;margin-right:4px;color:${good ? 'var(--c-ok)' : 'var(--c-warn)'}">${diff > 0 ? '↑' : '↓'}${Math.abs(diff).toFixed(0)}</span>`;
  };

  // Dot sparkline — size encodes relative position in range
  const dots = (vals: (number | undefined)[], colorFn: (v: number) => string): string => {
    const nums = vals.filter((v): v is number => v !== undefined);
    if (nums.length === 0) return '';
    const lo = Math.min(...nums), hi = Math.max(...nums), range = hi - lo || 1;
    return vals.map((v, i) => {
      if (v === undefined) return `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:rgba(0,0,0,0.1)"></span>`;
      const size = 5 + ((v - lo) / range) * 5;
      return `<span style="display:inline-block;border-radius:50%;background:${colorFn(v)};width:${size}px;height:${size}px;vertical-align:middle" title="${history[i]?.date?.slice(5) ?? ''}: ${v}"></span>`;
    }).join(' ');
  };

  // SVG line chart shown when metric row is expanded
  const miniChart = (vals: (number | undefined)[], color: string): string => {
    const nums = vals.filter((v): v is number => v !== undefined);
    if (nums.length < 3) return `<span style="font-size:11px;color:var(--c-faint)">Building history…</span>`;
    const W = 220, H = 36;
    const lo = Math.min(...nums), hi = Math.max(...nums), range = hi - lo || 1;
    const step = W / Math.max(vals.length - 1, 1);
    const pts = vals
      .map((v, i) => v !== undefined ? `${(i * step).toFixed(1)},${(H - ((v - lo) / range) * H).toFixed(1)}` : null)
      .filter(Boolean).join(' ');
    const circles = vals.map((v, i) => v !== undefined
      ? `<circle cx="${(i * step).toFixed(1)}" cy="${(H - ((v - lo) / range) * H).toFixed(1)}" r="2.5" fill="${color}"/>`
      : '').join('');
    const d0 = history[0]?.date?.slice(5) ?? '';
    const d1 = history[history.length - 1]?.date?.slice(5) ?? '';
    return `<svg width="${W}" height="${H + 14}" viewBox="0 0 ${W} ${H + 14}" style="display:block;max-width:100%;margin-top:6px;overflow:visible">
      <polyline points="${pts}" stroke="${color}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
      ${circles}
      <text x="0" y="${H + 12}" font-size="9" fill="var(--c-faint)">${d0}</text>
      <text x="${W}" y="${H + 12}" font-size="9" fill="var(--c-faint)" text-anchor="end">${d1}</text>
    </svg>`;
  };

  type M = {
    label: string; display: string; unit: string;
    vals: (number | undefined)[]; color: string;
    colorFn: (v: number) => string; higherIsBetter: boolean;
  };
  const metrics: M[] = ([
    rhr ? {
      label: 'Resting HR', display: String(Math.round(rhr)), unit: 'bpm',
      vals: history.map(h => h.restingHR), color: '#EF4444', higherIsBetter: false,
      colorFn: (v: number) => v <= 45 ? 'var(--c-ok)' : v <= 55 ? '#4ADE80' : v <= 65 ? 'var(--c-caution)' : 'var(--c-warn)',
    } : null,
    maxHR ? {
      label: 'Peak HR (7d)', display: String(Math.round(maxHR as number)), unit: 'bpm',
      vals: history.map(h => h.maxHR), color: '#F97316', higherIsBetter: false,
      colorFn: (_: number) => '#F97316',
    } : null,
    hrv != null ? {
      label: 'HRV (RMSSD)', display: String(Math.round(hrv)), unit: 'ms',
      vals: history.map(h => h.hrvRmssd), color: '#A855F7', higherIsBetter: true,
      colorFn: (v: number) => v >= 60 ? 'var(--c-ok)' : v >= 40 ? '#4ADE80' : v >= 25 ? 'var(--c-caution)' : 'var(--c-warn)',
    } : null,
    vo2 ? {
      label: 'VO2max', display: (vo2 as number).toFixed(1), unit: '',
      vals: history.map(h => h.vo2max), color: 'var(--c-ok)', higherIsBetter: true,
      colorFn: (v: number) => v >= 55 ? 'var(--c-ok)' : v >= 45 ? '#4ADE80' : v >= 35 ? 'var(--c-caution)' : 'var(--c-warn)',
    } : null,
    ltPace ? {
      label: 'LT Pace', display: fmtPace(ltPace as number), unit: '',
      vals: history.map(h => h.ltPace), color: 'var(--c-accent)', higherIsBetter: false,
      colorFn: (_: number) => 'var(--c-accent)',
    } : null,
    ltHR ? {
      label: 'LT Heart Rate', display: String(Math.round(ltHR as number)), unit: 'bpm',
      vals: history.map(h => h.ltHR), color: '#06B6D4', higherIsBetter: false,
      colorFn: (_: number) => '#06B6D4',
    } : null,
  ] as (M | null)[]).filter((m): m is M => m !== null);

  if (metrics.length === 0) return '';

  const rows = metrics.map((m, idx) => `
    <details style="${idx > 0 ? 'border-top:1px solid var(--c-border);padding-top:8px' : ''}">
      <summary style="list-style:none;display:block;cursor:pointer;-webkit-appearance:none">
        <div style="display:flex;justify-content:space-between;align-items:center${m.vals.some(v => v !== undefined) ? ';margin-bottom:4px' : ''}">
          <span style="font-size:12px;color:var(--c-muted)">${m.label}</span>
          <div style="display:flex;align-items:center">
            ${trendArrow(m.vals, m.higherIsBetter)}
            <span style="font-size:14px;font-weight:500;color:var(--c-black)">${m.display}${m.unit ? `<span style="font-size:11px;color:var(--c-faint);margin-left:2px">${m.unit}</span>` : ''}</span>
          </div>
        </div>
        ${m.vals.some(v => v !== undefined) ? `<div style="display:flex;align-items:center;gap:4px">${dots(m.vals, m.colorFn)}</div>` : ''}
      </summary>
      <div style="padding:8px 0 2px;border-top:1px solid var(--c-border);margin-top:6px">
        ${miniChart(m.vals, m.color)}
      </div>
    </details>
  `).join('');

  return `
    <div class="rounded-lg border p-4" style="background:var(--c-surface);border-color:var(--c-border)">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-medium text-sm" style="color:var(--c-black)">Physiology</h3>
        <span class="text-xs" style="color:rgba(249,115,22,0.6)">Garmin · tap to expand</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${rows}
      </div>
    </div>
  `;
}

function renderRecoveryLog(s: any): string {
  const history: RecoveryEntry[] = s.recoveryHistory || [];
  const last7 = history.slice(-7);

  const dotColorStyle = (score: number): string => {
    if (score >= 70) return 'var(--c-ok)';
    if (score >= 50) return 'var(--c-caution)';
    if (score >= 30) return '#F97316';
    return 'var(--c-warn)';
  };

  return `
    <div class="rounded-lg border p-4" style="background:var(--c-surface);border-color:var(--c-border)">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-medium text-sm" style="color:var(--c-black)">Recovery</h3>
        <button id="btn-recovery-log-panel" class="text-xs transition-colors" style="color:var(--c-ok)">Log Today</button>
      </div>
      <div class="flex gap-1.5 items-center">
        ${last7.length === 0
      ? `<span class="text-xs" style="color:var(--c-faint)">No recovery data yet</span>`
      : last7.map((e: RecoveryEntry) => `
            <div class="flex flex-col items-center gap-1" title="${e.date}: Sleep ${e.sleepScore}/100">
              <span class="w-3 h-3 rounded-full" style="background:${dotColorStyle(e.sleepScore)}"></span>
              <span class="text-[10px]" style="color:var(--c-faint)">${e.date.slice(5)}</span>
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
    <div class="rounded-xl max-w-sm w-full p-6" style="background:var(--c-surface);border:1px solid var(--c-border)">
      <h3 class="font-semibold text-lg mb-1" style="color:var(--c-black)">How did you sleep?</h3>
      <p class="text-sm mb-5" style="color:var(--c-muted)">Quick check-in to optimize today's training.</p>
      <div class="flex flex-col gap-2">
        <button class="recovery-quality-btn w-full py-2.5 font-medium rounded-lg transition-colors text-sm" style="background:var(--c-ok);color:white" data-quality="great">
          Great — Slept well
        </button>
        <button class="recovery-quality-btn w-full py-2.5 font-medium rounded-lg transition-colors text-sm" style="background:rgba(0,0,0,0.07);color:var(--c-black)" data-quality="good">
          Good — Normal night
        </button>
        <button class="recovery-quality-btn w-full py-2.5 font-medium rounded-lg transition-colors text-sm" style="background:var(--c-caution);color:white" data-quality="poor">
          Poor — Restless/short
        </button>
        <button class="recovery-quality-btn w-full py-2.5 font-medium rounded-lg transition-colors text-sm" style="background:var(--c-warn);color:white" data-quality="terrible">
          Terrible — Barely slept
        </button>
        <button id="btn-recovery-skip" class="w-full py-2 text-xs transition-colors mt-1" style="color:var(--c-faint)">
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
  const wk = s.wks[s.w - 1];
  if (!wk) return;

  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig, null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
    undefined, wk.scheduledAcwrStatus,
  );

  // Re-apply existing workoutMods so we see the true state
  if (wk.workoutMods && wk.workoutMods.length > 0) {
    for (const mod of wk.workoutMods) {
      const w = workouts.find(wo => wo.n === mod.name && (mod.dayOfWeek == null || wo.dayOfWeek === mod.dayOfWeek));
      if (w) {
        w.status = mod.status as any;
        w.d = mod.newDistance;
        if (mod.newType) w.t = mod.newType;
      }
    }
  }

  // Find today's run workout (JS day → our day: 0=Mon, 6=Sun)
  const jsDay = new Date().getDay();
  const ourDay = jsDay === 0 ? 6 : jsDay - 1;

  // Filter to run workouts not already replaced
  const runWorkouts = workouts.filter((w: any) =>
    w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest' &&
    w.status !== 'replaced'
  );

  // Try matching by dayOfWeek first, then fall back to first available run
  let todayWorkout = runWorkouts.find((w: any) => w.dayOfWeek === ourDay);
  if (!todayWorkout && runWorkouts.length > 0) {
    // No exact day match — offer the first unrated run workout
    const unrated = runWorkouts.filter((w: any) => !wk.rated[w.id || w.n]);
    todayWorkout = unrated[0] || runWorkouts[0];
  }

  const todayLabel = todayWorkout ? todayWorkout.n : 'No run planned today';

  const levelLabel: Record<RecoveryLevel, string> = {
    green: 'Good',
    yellow: 'Low',
    orange: 'Low',
    red: 'Very Low',
  };

  const levelColorStyle: Record<RecoveryLevel, string> = {
    green: 'color:var(--c-ok)',
    yellow: 'color:var(--c-caution)',
    orange: 'color:#F97316',
    red: 'color:var(--c-warn)',
  };

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
  overlay.innerHTML = `
    <div class="rounded-xl max-w-sm w-full p-6" style="background:var(--c-surface);border:1px solid var(--c-border)">
      <div class="flex items-center gap-2 mb-3">
        <span class="text-sm font-semibold" style="${levelColorStyle[level]}">Recovery: ${levelLabel[level]}</span>
      </div>
      <ul class="text-xs mb-4 space-y-1" style="color:var(--c-muted)">
        ${reasons.map(r => `<li>&#8226; ${r}</li>`).join('')}
      </ul>
      <p class="text-sm mb-4" style="color:var(--c-muted)">Today: <span style="color:var(--c-black);font-weight:500">${todayLabel}</span></p>

      ${todayWorkout ? `
        <div class="flex flex-col gap-2">
          ${todayWorkout.t === 'easy' || todayWorkout.t === 'long' ? `
            <button id="btn-recovery-easy-flag" class="w-full py-2.5 font-medium rounded-lg transition-colors text-sm text-left px-4" style="background:var(--c-ok);color:white">
              <div class="flex items-center justify-between">
                <span>Run by feel</span>
                ${level === 'red' || level === 'orange' ? '<span class="text-xs px-2 py-0.5 rounded-full" style="background:rgba(255,255,255,0.20)">Recommended</span>' : ''}
              </div>
              <p class="text-xs mt-0.5" style="color:rgba(255,255,255,0.70)">Ignore pace targets, just get the run in</p>
            </button>
            <button id="btn-recovery-reduce" class="w-full py-2.5 font-medium rounded-lg transition-colors text-sm text-left px-4" style="background:rgba(0,0,0,0.06);color:var(--c-black)">
              <span>Reduce Distance</span>
              <p class="text-xs mt-0.5" style="color:var(--c-muted)">Cut by 20%, keep it short</p>
            </button>
          ` : `
            <button id="btn-recovery-downgrade" class="w-full py-2.5 font-medium rounded-lg transition-colors text-sm text-left px-4" style="background:var(--c-ok);color:white">
              <div class="flex items-center justify-between">
                <span>Downgrade to Easy</span>
                ${level === 'red' || level === 'orange' ? '<span class="text-xs px-2 py-0.5 rounded-full" style="background:rgba(255,255,255,0.20)">Recommended</span>' : ''}
              </div>
              <p class="text-xs mt-0.5" style="color:rgba(255,255,255,0.70)">Keep distance, lower intensity</p>
            </button>
            <button id="btn-recovery-reduce" class="w-full py-2.5 font-medium rounded-lg transition-colors text-sm text-left px-4" style="background:rgba(0,0,0,0.06);color:var(--c-black)">
              <span>Reduce Distance</span>
              <p class="text-xs mt-0.5" style="color:var(--c-muted)">Cut by 20%, keep workout type</p>
            </button>
          `}
          <button id="btn-recovery-ignore" class="w-full py-2.5 font-medium rounded-lg transition-colors text-sm" style="background:rgba(0,0,0,0.04);color:var(--c-muted)">
            Keep plan unchanged
          </button>
        </div>
      ` : `
        <p class="text-xs mb-3" style="color:var(--c-faint)">No run workout scheduled today — no adjustments needed.</p>
        <button id="btn-recovery-dismiss" class="w-full py-2.5 font-medium rounded-lg transition-colors text-sm" style="background:rgba(0,0,0,0.05);color:var(--c-muted)">
          Dismiss
        </button>
      `}
    </div>
  `;
  document.body.appendChild(overlay);

  if (todayWorkout) {
    const workoutDay = todayWorkout.dayOfWeek ?? ourDay;
    const workoutName = todayWorkout.n;
    overlay.querySelector('#btn-recovery-downgrade')?.addEventListener('click', () => {
      overlay.remove();
      window.applyRecoveryAdjustment('downgrade', workoutDay, workoutName);
    });
    overlay.querySelector('#btn-recovery-easy-flag')?.addEventListener('click', () => {
      overlay.remove();
      window.applyRecoveryAdjustment('easyflag', workoutDay, workoutName);
    });
    overlay.querySelector('#btn-recovery-reduce')?.addEventListener('click', () => {
      overlay.remove();
      window.applyRecoveryAdjustment('reduce', workoutDay, workoutName);
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

function getPlanName(s: any): string {
  if (s.continuousMode) return 'Fitness Plan';
  const labels: Record<string, string> = {
    '5k': '5K Plan',
    '10k': '10K Plan',
    half: 'Half Marathon Plan',
    marathon: 'Marathon Plan',
  };
  return labels[s.rd] || 'Training Plan';
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
    <div id="morning-pain-check" class="rounded-lg p-4 mb-4" style="background:rgba(78,159,229,0.07);border:1px solid rgba(78,159,229,0.30)">
      <div class="flex items-start gap-3">
        <div class="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center" style="background:rgba(78,159,229,0.12)">
          <svg class="w-5 h-5" style="color:var(--c-accent)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>
          </svg>
        </div>
        <div class="flex-1">
          <h3 class="text-sm font-semibold mb-1" style="color:var(--c-accent)">Morning Pain Check</h3>
          <p class="text-xs mb-3" style="color:var(--c-muted)">
            Is your pain worse than yesterday morning? (Current: ${currentPain}/10)
          </p>
          <div class="flex gap-2">
            <button id="btn-morning-pain-worse" class="px-4 py-2 text-xs font-medium rounded-lg transition-colors" style="background:var(--c-warn);color:white">
              Worse
            </button>
            <button id="btn-morning-pain-same" class="px-4 py-2 text-xs font-medium rounded-lg transition-colors" style="background:var(--c-accent);color:white">
               Same
            </button>
            <button id="btn-morning-pain-better" class="px-4 py-2 text-xs font-medium rounded-lg transition-colors" style="background:var(--c-ok);color:white">
              Better
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render medical disclaimer banner during return_to_run phase
 */
function renderMedicalDisclaimer(s: any): string {
  const injuryState = (s as any).injuryState;
  if (!injuryState?.active || injuryState.injuryPhase !== 'return_to_run') return '';

  return `
    <div class="rounded-lg p-3 mb-4" style="background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.25)">
      <div class="flex items-start gap-2">
        <svg class="w-4 h-4 flex-shrink-0 mt-0.5" style="color:var(--c-caution)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
        </svg>
        <p class="text-xs leading-relaxed" style="color:var(--c-caution)">
          This plan is not medical advice. If pain persists or worsens, consult a sports medicine specialist or physiotherapist. Never push through sharp or worsening pain.
        </p>
      </div>
    </div>
  `;
}

/**
 * Handle morning pain check response.
 * Records to morningPainResponses[] for weekly gate evaluation.
 * No immediate phase regression — data feeds into weekly check-in.
 */
function handleMorningPainResponse(response: 'worse' | 'same' | 'better'): void {
  const s = getMutableState();
  const injuryState = (s as any).injuryState;

  if (!injuryState) return;

  // Record today's date
  const today = new Date().toISOString().split('T')[0];
  s.lastMorningPainDate = today;

  // Record morning pain response for weekly gate
  const morningEntry: MorningPainResponse = {
    date: today,
    response,
    painLevel: injuryState.currentPain || 0,
  };
  if (!injuryState.morningPainResponses) injuryState.morningPainResponses = [];
  injuryState.morningPainResponses.push(morningEntry);

  // Adjust pain level (keep existing logic for same/better)
  if (response === 'same') {
    const updatedState = recordMorningPain(injuryState, injuryState.currentPain);
    (s as any).injuryState = updatedState;
  } else if (response === 'better') {
    const improvedPain = Math.max(0, (injuryState.currentPain || 1) - 1);
    const updatedState = recordMorningPain(injuryState, improvedPain);
    (s as any).injuryState = updatedState;
  } else {
    // Worse — record pain but no immediate regression
    const worsePain = Math.min(10, (injuryState.currentPain || 1) + 1);
    const updatedState = recordMorningPain(injuryState, worsePain);
    (s as any).injuryState = updatedState;
  }

  saveState();

  // Show inline feedback instead of reloading
  const feedbackMessages = {
    worse: 'Logged — pain worse. This will factor into your weekly check-in.',
    same: 'Logged — pain unchanged. Noted for your weekly review.',
    better: 'Logged — pain improving! This will be reflected in your weekly check-in.',
  };

  const container = document.getElementById('morning-pain-check');
  if (container) {
    const colorStyle = response === 'worse'
      ? 'color:var(--c-warn);background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.30)'
      : response === 'better'
      ? 'color:var(--c-ok);background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.30)'
      : 'color:var(--c-accent);background:rgba(78,159,229,0.08);border:1px solid rgba(78,159,229,0.30)';
    container.innerHTML = `
      <div style="${colorStyle}" class="rounded-lg p-4 mb-4">
        <p class="text-sm font-medium">${feedbackMessages[response]}</p>
      </div>
    `;
  }
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
    <div class="rounded-xl max-w-sm w-full p-5" style="background:var(--c-surface);border:1px solid var(--c-border)">
      <h3 class="font-semibold text-lg mb-1" style="color:var(--c-black)">Change Runner Type</h3>
      <p class="text-xs mb-4" style="color:var(--c-muted)">This will recalculate your entire training plan.</p>
      ${planStarted ? `<div class="p-3 mb-4 rounded-lg text-xs leading-relaxed" style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);color:var(--c-caution)">
        Changing your runner type will reset your current plan. Your training data will be preserved but your plan will be rebuilt from scratch.
      </div>` : ''}
      <div class="space-y-2">
        ${types.map(t => `
          <button class="runner-type-option w-full text-left p-3 rounded-lg border transition-colors" style="${t === currentType ? 'background:rgba(34,197,94,0.08);border-color:rgba(34,197,94,0.40);color:var(--c-ok)' : 'background:rgba(0,0,0,0.04);border-color:var(--c-border);color:var(--c-black)'}" data-type="${t}">
            <div class="font-medium text-sm">${t} ${t === currentType ? '(current)' : ''}</div>
            <div class="text-xs mt-0.5" style="color:var(--c-faint)">${descriptions[t]}</div>
          </button>
        `).join('')}
      </div>
      <button id="btn-cancel-runner-type" class="w-full mt-3 py-2 text-xs transition-colors" style="color:var(--c-muted)">Cancel</button>
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
  overlay.className = 'fixed inset-0 flex items-center justify-center z-50';
  overlay.style.cssText = 'background:rgba(253,252,247,0.95)';
  overlay.innerHTML = `
    <div class="text-center">
      <div class="w-12 h-12 border-4 border-t-transparent rounded-full animate-spin mx-auto mb-4" style="border-color:var(--c-ok);border-top-color:transparent"></div>
      <h3 class="font-semibold text-lg mb-1" style="color:var(--c-black)">Rebuilding Plan</h3>
      <p class="text-sm" style="color:var(--c-muted)">Recalculating your workouts...</p>
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

/**
 * Populate the Weekly Load chart bars and the Load History section.
 * Uses planned workout loads vs actual Garmin run loads for the current week,
 * and extraRunLoad as a proxy for historical weeks.
 */
function updateLoadChart(s: SimulatorState): void {
  if (!s.onboarding?.hasSmartwatch) return;

  const wk = s.wks?.[s.w - 1];
  const easyPace = s.pac?.e;

  // --- Generate planned workouts for current week (same pattern as excess-load-card.ts) ---
  let wg = 0;
  for (let i = 0; i < s.w - 1; i++) wg += s.wks[i].wkGain;
  const currentVDOT = s.v + wg + s.rpeAdj + (s.physioAdj || 0);
  const previousSkips = s.w > 1 ? s.wks[s.w - 2].skip : [];
  let trailingEffort = 0;
  const lookback = Math.min(3, s.w - 1);
  if (lookback > 0) {
    let total = 0; let count = 0;
    for (let i = s.w - 2; i >= s.w - 1 - lookback && i >= 0; i--) {
      if (s.wks[i].effortScore != null) { total += s.wks[i].effortScore!; count++; }
    }
    if (count > 0) trailingEffort = total / count;
  }
  const plannedWorkouts = wk ? generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, previousSkips, s.commuteConfig,
    (s as any).injuryState || null, s.recurringActivities,
    s.onboarding?.experienceLevel,
    (s.maxHR || s.restingHR || s.onboarding?.age)
      ? { lthr: undefined, maxHR: s.maxHR, restingHR: s.restingHR, age: s.onboarding?.age }
      : undefined,
    easyPace, s.w, s.tw, currentVDOT, s.gs, trailingEffort, wk.scheduledAcwrStatus,
  ) : [];

  // Sum planned loads in TL units (scale FCL output by TL_PER_MIN/LOAD_PER_MIN ratio)
  let plannedAero = 0, plannedAnaero = 0;
  let plannedBase = 0, plannedThreshold = 0, plannedIntensity = 0;
  for (const w of plannedWorkouts) {
    if (w.t === 'rest' || w.t === 'gym') continue;
    const rpe = w.rpe || w.r || 5;
    const fcl = calculateWorkoutLoad(w.t, w.d, rpe * 10, easyPace);
    const scale = (TL_PER_MIN[Math.round(rpe)] ?? 1.15) / (LOAD_PER_MIN_BY_INTENSITY[Math.round(rpe)] ?? 2.0);
    // Apply sport runSpec for cross-training — prevents tennis/cycling/etc from inflating the planned target
    let sportRunSpec = 1.0;
    if (w.t === 'cross' && w.n) {
      const raw = w.n.toLowerCase().trim().replace(/ /g, '_');
      const sportKey = (SPORT_ALIASES as Record<string, string>)[raw] ?? raw;
      sportRunSpec = (SPORTS_DB as any)[sportKey]?.runSpec ?? 0.40;
    }
    plannedAero += fcl.aerobic * scale * sportRunSpec;
    plannedAnaero += fcl.anaerobic * scale * sportRunSpec;
    plannedBase      += (fcl.base      ?? 0) * scale * sportRunSpec;
    plannedThreshold += (fcl.threshold ?? 0) * scale * sportRunSpec;
    plannedIntensity += (fcl.intensity ?? 0) * scale * sportRunSpec;
  }

  // Sum actual loads from matched Garmin runs (TSS units — same scale as individual card display)
  let actualAero = 0, actualAnaero = 0;
  let actualBase = 0, actualThreshold = 0, actualIntensity = 0;
  if (wk?.garminActuals) {
    for (const [workoutId, actual] of Object.entries(wk.garminActuals)) {
      const plannedW = plannedWorkouts.find(w => (w.id || w.n) === workoutId);
      const type = plannedW?.t || 'easy';
      const ratedRpe = wk.rated?.[workoutId];
      const rpe = typeof ratedRpe === 'number' ? ratedRpe : 5;
      let tl: number;
      if (actual.iTrimp != null && actual.iTrimp > 0) {
        tl = (actual.iTrimp * 100) / 15000;
      } else {
        const durMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
        tl = durMin * (TL_PER_MIN[Math.round(rpe)] ?? 0.92);
      }
      const profile = LOAD_PROFILES[type] ?? { aerobic: 0.80, anaerobic: 0.20, base: 0.70, threshold: 0.20, intensity: 0.10 };
      // If hrZones available, split by actual zone time; otherwise use workout-type profile
      if (actual.hrZones && (actual.hrZones.z1 + actual.hrZones.z2 + actual.hrZones.z3 + actual.hrZones.z4 + actual.hrZones.z5) > 0) {
        const totalSec = actual.hrZones.z1 + actual.hrZones.z2 + actual.hrZones.z3 + actual.hrZones.z4 + actual.hrZones.z5;
        actualBase      += tl * (actual.hrZones.z1 + actual.hrZones.z2) / totalSec;
        actualThreshold += tl * actual.hrZones.z3 / totalSec;
        actualIntensity += tl * (actual.hrZones.z4 + actual.hrZones.z5) / totalSec;
      } else {
        actualBase      += tl * (profile.base      ?? profile.aerobic * 0.80);
        actualThreshold += tl * (profile.threshold ?? profile.aerobic * 0.20);
        actualIntensity += tl * (profile.intensity ?? profile.anaerobic);
      }
      actualAero += tl * profile.aerobic;
      actualAnaero += tl * profile.anaerobic;
    }
  }

  // Add cross-training unspent load items (all aerobic; runSpec 0.35 = generic cross-training default)
  if (wk?.unspentLoadItems) {
    for (const item of wk.unspentLoadItems) {
      const crossTl = item.durationMin * (TL_PER_MIN[5] ?? 1.15) * 0.35;
      actualAero += crossTl;
      actualBase += crossTl; // Cross-training treated as base-zone for display
    }
  }

  const plannedTotal = plannedAero + plannedAnaero;
  const actualTotal  = actualAero  + actualAnaero;
  const max = Math.max(plannedTotal, actualTotal, 1);

  const setHeight = (id: string, pct: number) => {
    const el = document.getElementById(id);
    if (el) el.style.height = `${pct}%`;
  };
  setHeight('bar-plan-aero',    Math.min(100, Math.round((plannedAero   / max) * 100)));
  setHeight('bar-actual-aero',  Math.min(100, Math.round((actualAero    / max) * 100)));
  setHeight('bar-plan-anaero',  Math.min(100, Math.round((plannedAnaero / max) * 100)));
  setHeight('bar-actual-anaero',Math.min(100, Math.round((actualAnaero  / max) * 100)));

  const loadExpected = document.getElementById('load-expected');
  if (loadExpected) loadExpected.textContent = Math.round(plannedTotal).toString();
  const loadActual = document.getElementById('load-actual');
  if (loadActual) loadActual.textContent = Math.round(actualTotal).toString();

  // ── Separate running vs cross-training TSS ───────────────────────────
  // Running TSS = garminActuals for run-type workouts (easy, long, threshold, vo2, marathon_pace, etc.)
  // Cross-training TSS = garminActuals for non-run adhoc + unspent items
  const RUN_TYPES = new Set(['easy', 'long', 'marathon_pace', 'threshold', 'vo2', 'intervals', 'hill_repeats', 'progressive', 'mixed', 'race_pace']);
  let actualRunTSS = 0, actualCrossTSS = 0;
  if (wk?.garminActuals) {
    for (const [workoutId, actual] of Object.entries(wk.garminActuals)) {
      const plannedW = plannedWorkouts.find(w => (w.id || w.n) === workoutId);
      const type = plannedW?.t || 'easy';
      const ratedRpe = wk.rated?.[workoutId];
      const rpe = typeof ratedRpe === 'number' ? ratedRpe : 5;
      let tl: number;
      if (actual.iTrimp != null && actual.iTrimp > 0) {
        tl = (actual.iTrimp * 100) / 15000;
      } else {
        const durMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
        tl = durMin * (TL_PER_MIN[Math.round(rpe)] ?? 0.92);
      }
      if (RUN_TYPES.has(type)) { actualRunTSS += tl; } else { actualCrossTSS += tl; }
    }
  }
  // Add unspent cross-training to cross bucket
  if (wk?.unspentLoadItems) {
    for (const item of wk.unspentLoadItems) {
      actualCrossTSS += item.durationMin * (TL_PER_MIN[5] ?? 1.15) * 0.35;
    }
  }
  // Adhoc Garmin cross-training (not matched to plan slot)
  for (const wo of wk?.adhocWorkouts ?? []) {
    if (!wo.id?.startsWith('garmin-')) continue;
    const sport = normalizeSport(wo.n.replace(' (Garmin)', '').toLowerCase());
    const cfg = (SPORTS_DB as any)[sport];
    const runSpec = cfg?.runSpec ?? 0.35;
    if (wo.iTrimp != null && wo.iTrimp > 0) {
      actualCrossTSS += (wo.iTrimp * 100) / 15000 * runSpec;
    } else {
      const rpe = wo.rpe ?? 5;
      const durMatch = wo.d?.match(/(\d+)min/);
      const durMin = durMatch ? parseInt(durMatch[1]) : 30;
      actualCrossTSS += durMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15) * runSpec;
    }
  }

  // ── TSS split bar ─────────────────────────────────────────────────────
  const tssTotalActual  = actualRunTSS + actualCrossTSS;

  // Fixed scale: plannedTotal × 1.4. Plan line sits at ~71%; bar clips at 100% when over.
  // Avoids outlier weeks compressing the scale (507 TSS at 146% over plan → clips to 100%).
  const barMax = Math.max(plannedTotal * 1.4, tssTotalActual * 1.1, 1);
  const runPct   = Math.min(100, Math.round((actualRunTSS   / barMax) * 100));
  const crossPct = Math.min(100, Math.round((actualCrossTSS / barMax) * 100));

  const loadActualEl = document.getElementById('stat-load-actual');
  if (loadActualEl) loadActualEl.textContent = tssTotalActual > 0 ? Math.round(tssTotalActual).toString() : '—';
  const loadPlannedEl = document.getElementById('stat-load-planned');
  if (loadPlannedEl) loadPlannedEl.textContent = plannedTotal > 0 ? Math.round(plannedTotal).toString() : '—';

  const runBarEl   = document.getElementById('stat-load-bar-run');
  const crossBarEl = document.getElementById('stat-load-bar-cross');
  if (runBarEl)   runBarEl.style.width   = `${runPct}%`;
  if (crossBarEl) crossBarEl.style.width = `${Math.min(100 - runPct, crossPct)}%`;

  // Zone band widths — background behind the actual fill
  // Gray = 0→CTL (your chronic baseline); Green = CTL→plan (the target zone);
  // Amber = plan→plan×1.2 (acceptable overrun); Red = beyond that (fills rest).
  const acwrData = computeACWR(s.wks ?? [], s.w, s.athleteTierOverride ?? s.athleteTier, s.ctlBaseline ?? undefined, s.planStartDate);
  const ctlWeeklyEquiv = acwrData.ctl;
  const ctlPctOfBar    = barMax > 0 ? Math.min(100, (ctlWeeklyEquiv / barMax) * 100) : 0;
  const planPctOfBar   = barMax > 0 ? Math.min(100, (plannedTotal    / barMax) * 100) : 71;
  const cautionWidth   = barMax > 0 ? Math.min(100, (plannedTotal * 0.2 / barMax) * 100) : 0; // 20% overrun band
  const targetWidth    = Math.max(0, planPctOfBar - ctlPctOfBar);
  const setW = (id: string, pct: number) => { const el = document.getElementById(id); if (el) el.style.width = `${Math.max(0, pct).toFixed(1)}%`; };
  setW('zone-load-baseline', ctlPctOfBar);
  setW('zone-load-target',   targetWidth);
  setW('zone-load-caution',  cautionWidth);

  // Plan target line (boundary between green and amber)
  const planLineEl = document.getElementById('stat-load-plan-line');
  if (planLineEl) {
    planLineEl.style.left = `${planPctOfBar.toFixed(1)}%`;
    planLineEl.classList.remove('hidden');
  }

  // Axis labels below the bar
  const axisEl = document.getElementById('stat-load-axis');
  if (axisEl) {
    const labels: string[] = [];
    if (ctlWeeklyEquiv > 5) {
      labels.push(`<span class="absolute text-[9px]" style="left:${Math.min(92, ctlPctOfBar).toFixed(1)}%;transform:translateX(-50%);color:var(--c-faint)">◆ ${Math.round(ctlWeeklyEquiv)}</span>`);
    }
    if (plannedTotal > 0) {
      const planLabelLeft = Math.min(96, planPctOfBar);
      labels.push(`<span class="absolute text-[9px]" style="left:${planLabelLeft.toFixed(1)}%;transform:translateX(-50%);color:var(--c-muted)">${Math.round(plannedTotal)}</span>`);
    }
    axisEl.innerHTML = labels.join('');
  }

  // Load % label
  const loadSubEl = document.getElementById('stat-load-pct');
  if (loadSubEl && plannedTotal > 0) {
    const rawPct = Math.round((tssTotalActual / plannedTotal) * 100);
    if (rawPct > 110) {
      loadSubEl.textContent = `+${rawPct - 100}% over plan`;
      loadSubEl.className = 'text-[10px] flex-1';
      loadSubEl.style.color = '#F97316';
    } else if (rawPct < 80 && tssTotalActual > 0) {
      loadSubEl.textContent = `${rawPct}% of plan`;
      loadSubEl.className = 'text-[10px] flex-1';
      loadSubEl.style.color = 'var(--c-faint)';
    } else {
      loadSubEl.textContent = '';
    }
  }

  // ── Volume (km) bar ───────────────────────────────────────────────────
  // Running km from garminActuals for run-type workouts
  let actualRunKm = 0, actualGpsKm = 0;
  if (wk?.garminActuals) {
    for (const [workoutId, actual] of Object.entries(wk.garminActuals)) {
      const plannedW = plannedWorkouts.find(w => (w.id || w.n) === workoutId);
      const type = plannedW?.t || 'easy';
      if (RUN_TYPES.has(type)) {
        actualRunKm += actual.distanceKm ?? 0;
      }
    }
  }
  // GPS cross-training km from adhoc workouts (volumeTransfer coefficient)
  for (const wo of wk?.adhocWorkouts ?? []) {
    if (!wo.id?.startsWith('garmin-')) continue;
    const actual = wk?.garminActuals?.[wo.id.replace('garmin-', '')];
    const sport = normalizeSport(wo.n.replace(' (Garmin)', '').toLowerCase());
    const cfg = (SPORTS_DB as any)[sport];
    const vt = cfg?.volumeTransfer ?? 0;
    if (vt > 0) {
      const distKm = actual?.distanceKm;
      if (distKm) actualGpsKm += distKm * vt;
    }
  }
  // Planned running km
  let plannedRunKm = 0;
  for (const wo of plannedWorkouts) {
    if (!RUN_TYPES.has(wo.t)) continue;
    const m = wo.d?.match(/(\d+\.?\d*)\s*km/);
    if (m) plannedRunKm += parseFloat(m[1]);
  }
  // 42-day baseline km (average of past weeks' completedKm)
  const pastKmWeeks = (s.wks ?? []).slice(0, s.w - 1).filter(hw => hw.completedKm != null);
  const baselineKm42 = pastKmWeeks.length >= 3
    ? pastKmWeeks.slice(-6).reduce((a, hw) => a + (hw.completedKm ?? 0), 0) / Math.min(pastKmWeeks.slice(-6).length, 6)
    : 0;

  // Fixed scale: plannedRunKm × 1.4 so plan line sits at ~71% of the bar
  const volMax = Math.max(plannedRunKm * 1.4, actualRunKm + actualGpsKm, 1);
  const volRunPct   = Math.min(100, Math.round((actualRunKm   / volMax) * 100));
  const volCrossPct = Math.min(100, Math.round((actualGpsKm   / volMax) * 100));

  const volRunEl   = document.getElementById('stat-vol-bar-run');
  const volCrossEl = document.getElementById('stat-vol-bar-cross');
  if (volRunEl)   volRunEl.style.width   = `${volRunPct}%`;
  if (volCrossEl) volCrossEl.style.width = `${Math.min(100 - volRunPct, volCrossPct)}%`;

  // Volume zone bands
  const volCtlPct    = (baselineKm42 > 0 && volMax > 0) ? Math.min(100, (baselineKm42 / volMax) * 100) : 0;
  const volPlanPct   = (plannedRunKm  > 0 && volMax > 0) ? Math.min(100, (plannedRunKm / volMax) * 100) : 71;
  const volTargetW   = Math.max(0, volPlanPct - volCtlPct);
  const volCautionW  = plannedRunKm > 0 ? Math.min(100, (plannedRunKm * 0.2 / volMax) * 100) : 0;
  setW('zone-vol-baseline', volCtlPct);
  setW('zone-vol-target',   volTargetW);
  setW('zone-vol-caution',  volCautionW);

  const volPlanLineEl = document.getElementById('stat-vol-plan-line');
  if (volPlanLineEl && plannedRunKm > 0) {
    volPlanLineEl.style.left = `${volPlanPct.toFixed(1)}%`;
    volPlanLineEl.classList.remove('hidden');
  }

  // Volume axis labels
  const volAxisEl = document.getElementById('stat-vol-axis');
  if (volAxisEl) {
    const labels: string[] = [];
    if (baselineKm42 > 0) {
      labels.push(`<span class="absolute text-[9px]" style="left:${Math.min(92, volCtlPct).toFixed(1)}%;transform:translateX(-50%);color:var(--c-faint)">◆ ${baselineKm42.toFixed(0)}km</span>`);
    }
    if (plannedRunKm > 0) {
      const planLabelLeft = Math.min(96, volPlanPct);
      labels.push(`<span class="absolute text-[9px]" style="left:${planLabelLeft.toFixed(1)}%;transform:translateX(-50%);color:var(--c-muted)">${Math.round(plannedRunKm)}km</span>`);
    }
    volAxisEl.innerHTML = labels.join('');
  }

  const volRunNumEl  = document.getElementById('stat-vol-run');
  const volCrossNumEl = document.getElementById('stat-vol-cross');
  const volPlannedEl = document.getElementById('stat-vol-planned');
  const volNoteEl    = document.getElementById('stat-vol-note');
  if (volRunNumEl)  volRunNumEl.textContent  = actualRunKm > 0 ? actualRunKm.toFixed(1) : '—';
  if (volCrossNumEl) volCrossNumEl.textContent = actualGpsKm > 0 ? actualGpsKm.toFixed(1) : '0';
  if (volPlannedEl) volPlannedEl.textContent  = plannedRunKm > 0 ? Math.round(plannedRunKm).toString() : '—';
  if (volNoteEl && actualCrossTSS > 0 && actualRunKm === 0) {
    volNoteEl.textContent = 'Cross-training covering fitness load — consider a short run for conditioning';
    volNoteEl.className = 'text-[10px]';
    volNoteEl.style.color = 'var(--c-caution)';
  } else if (volNoteEl) {
    volNoteEl.textContent = '';
  }

  // §5.6 — Minimum running km floor nudge
  // Derive goal tier from marathon pace (sec/km)
  const marathonTimeSec = (s.pac?.m ?? 360) * 42.195;
  const floorTier = marathonTimeSec < 3.5 * 3600 ? 'fast'        // sub 3:30
                  : marathonTimeSec < 4.5 * 3600 ? 'mid'         // 3:30–4:30
                  :                                 'finish';     // 4:30+
  const peakFloor = floorTier === 'fast' ? 35 : floorTier === 'mid' ? 25 : 18;
  const earlyFloor = floorTier === 'fast' ? 20 : floorTier === 'mid' ? 15 : 10;
  const totalWeeks = s.tw ?? 16;
  const currentWeek = s.w ?? 1;
  const floorKm = earlyFloor + (peakFloor - earlyFloor) * Math.min(1, (currentWeek - 1) / (totalWeeks - 1));

  // Check past 2 weeks for consecutive below-floor
  const prevWeeks = (s.wks ?? []).slice(Math.max(0, currentWeek - 3), currentWeek - 1);
  const consecutiveBelow = prevWeeks.length >= 2 &&
    prevWeeks.every(pw => (pw.completedKm ?? 0) > 0 && (pw.completedKm ?? 0) < floorKm);

  const kmFloorNudgeEl = document.getElementById('stat-km-floor-nudge');
  if (kmFloorNudgeEl) {
    if (consecutiveBelow && actualRunKm < floorKm) {
      kmFloorNudgeEl.textContent = `Running km has been below ${Math.round(floorKm)}km for 2+ weeks — consider adding a short easy run`;
      kmFloorNudgeEl.style.display = 'block';
    } else {
      kmFloorNudgeEl.style.display = 'none';
    }
  }

  // 3-zone TSS breakdown — progress vs planned per zone
  const setZoneProgress = (
    barId: string, labelId: string,
    actual: number, planned: number,
    normalColor: string, overColor: string
  ) => {
    const barEl = document.getElementById(barId) as HTMLElement | null;
    const labelEl = document.getElementById(labelId);
    const isOver = planned > 0 && actual > planned;
    const pct = planned > 0 ? Math.min(100, Math.round((actual / planned) * 100)) : (actual > 0 ? 100 : 0);
    if (barEl) {
      barEl.style.width = `${pct}%`;
      barEl.style.background = isOver ? overColor : normalColor;
      barEl.className = `h-full rounded-full transition-all`;
    }
    if (labelEl) {
      if (actual < 1) {
        labelEl.textContent = planned > 0 ? `0/${Math.round(planned)}` : '';
      } else if (planned > 0) {
        labelEl.textContent = `${Math.round(actual)}/${Math.round(planned)}`;
      } else {
        labelEl.textContent = `${Math.round(actual)}`;
      }
    }
  };
  setZoneProgress('zone-bar-base',      'stat-load-base-label',      actualBase,      plannedBase,      'var(--c-accent)', 'var(--c-warn)');
  setZoneProgress('zone-bar-threshold', 'stat-load-threshold-label', actualThreshold, plannedThreshold, 'var(--c-caution)', 'var(--c-warn)');
  setZoneProgress('zone-bar-intensity', 'stat-load-intensity-label', actualIntensity, plannedIntensity, '#F97316',         'var(--c-warn)');

  // --- Load History chart (last 6 weeks, using extraRunLoad as proxy) ---
  const historyContainer = document.getElementById('load-history-chart');
  if (!historyContainer || !s.wks) return;

  const startIdx = Math.max(0, s.w - 6);
  const histWeeks = s.wks.slice(startIdx, s.w); // includes current week

  if (histWeeks.length === 0) {
    historyContainer.innerHTML = '<p class="text-xs self-center" style="color:var(--c-faint)">No history yet</p>';
    return;
  }

  const histLoads = histWeeks.map(hw => hw.actualTSS ?? hw.extraRunLoad ?? 0);
  const histMax = Math.max(...histLoads, 1);

  const bars = histWeeks.map((hw, i) => {
    const weekAbsIdx = startIdx + i; // 0-based absolute index
    const load = hw.actualTSS ?? hw.extraRunLoad ?? 0;
    const pct = Math.min(100, Math.round((load / histMax) * 100));
    const isCurrentWeek = weekAbsIdx === s.w - 1;
    const barColor = load === 0 ? 'rgba(0,0,0,0.10)'
      : load < histMax * 0.7 ? 'var(--c-caution)' : 'var(--c-ok)';
    const ringStyle = isCurrentWeek ? `;outline:1px solid var(--c-ok);outline-offset:1px` : '';
    return `<div class="flex-1 flex flex-col items-center justify-end h-full">
      <div class="w-full rounded-t transition-all${load > 0 ? ' min-h-[2px]' : ''}" style="height:${pct}%;background:${barColor}${ringStyle}"></div>
    </div>`;
  }).join('');

  historyContainer.innerHTML = bars;
}

// ---------------------------------------------------------------------------
// ACWR bar — populated after DOM is ready
// ---------------------------------------------------------------------------

function updateACWRBar(s: SimulatorState): void {
  const container = document.getElementById('acwr-bar-container');
  const reduceBtn = document.getElementById('acwr-reduce-btn') as HTMLButtonElement | null;
  const dismissBtn = document.getElementById('acwr-dismiss-btn') as HTMLButtonElement | null;
  const riskLabelEl = document.getElementById('acwr-risk-label');
  if (!container) return;

  const tier = s.athleteTierOverride ?? s.athleteTier;
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate);

  if (acwr.status === 'unknown' && acwr.ratio === 0) {
    const histLen = (s.historicWeeklyTSS ?? []).length;
    const baselineMsg = histLen < 3
      ? 'Building baseline — check back after 3 weeks'
      : 'Not enough recent data to compute load ratio';
    container.innerHTML = `<p class="text-[10px]" style="color:var(--c-faint)">${baselineMsg}</p>`;
    if (reduceBtn) reduceBtn.classList.add('hidden');
    if (dismissBtn) dismissBtn.classList.add('hidden');
    if (riskLabelEl) riskLabelEl.classList.add('hidden');
    updateLightenedWeekBanner(s);
    return;
  }

  const ratio = acwr.ratio;
  const safeUpper = acwr.safeUpper;

  // Compute bar fill width: map 0 → safeUpper+0.4 range to 0–100%
  const barRange = safeUpper + 0.4;
  const fillPct  = Math.min(100, Math.round((ratio / barRange) * 100));
  const safePct  = Math.round((safeUpper / barRange) * 100);

  const statusColor = acwr.status === 'high'
    ? { fillStyle: 'background:var(--c-warn)', textStyle: 'color:var(--c-warn)' }
    : acwr.status === 'caution'
    ? { fillStyle: 'background:var(--c-caution)', textStyle: 'color:var(--c-caution)' }
    : { fillStyle: 'background:var(--c-ok)', textStyle: 'color:var(--c-ok)' };

  const statusMsg = acwr.status === 'high'
    ? `Load spike detected (${ratio.toFixed(2)}× baseline) — reduce this week`
    : acwr.status === 'caution'
    ? `Load increasing quickly (${ratio.toFixed(2)}× baseline) — consider easing off`
    : acwr.status === 'unknown'
    ? `Deload / low activity (${ratio.toFixed(2)}×)`
    : `Load well-managed (${ratio.toFixed(2)}× baseline)`;

  container.innerHTML = `
    <div class="relative h-1.5 rounded-full overflow-hidden mb-1" style="background:rgba(0,0,0,0.08)">
      <div class="h-full rounded-full transition-all" style="${statusColor.fillStyle};width:${fillPct}%"></div>
      <div class="absolute top-0 bottom-0 w-px" style="left:${safePct}%;background:rgba(0,0,0,0.25)"></div>
    </div>
    <div class="flex justify-between text-[10px] mb-1" style="color:var(--c-faint)">
      <span>Low</span><span>Safe ≤${safeUpper.toFixed(1)}×</span><span>High</span>
    </div>
    <p class="text-[10px]" style="${statusColor.textStyle}">${statusMsg}</p>
  `;

  // ── Over-plan % trigger (§5.2) ────────────────────────────────────────
  // Show "Reduce this week" even when ACWR is safe/unknown, if actual TSS > planned × 1.20
  const wk = s.wks?.[s.w - 1];
  const actualTSSNow = wk?.actualTSS ?? 0;
  // Re-use updateLoadChart's planned total if we have it; approximate here from wk
  // We sum planned TSS from the same weekKm proxy used elsewhere
  let showReduceBtn = acwr.status === 'caution' || acwr.status === 'high';
  let reduceBtnText = 'Reduce this week';

  // Check over-plan % threshold when ACWR is safe/unknown
  if (!showReduceBtn && actualTSSNow > 0) {
    // We need plannedTSS — compute a quick estimate from the week's planned km
    // Use the same weekWos call as getWeekWorkoutsForACWR
    // (cheaper: just check wk.actualTSS vs s.wkm * rough load factor)
    const roughPlannedTSS = (s.wkm ?? 30) * 5; // ≈ 5 TSS/km as rough baseline
    if (actualTSSNow > roughPlannedTSS * 1.20) {
      const overPct = Math.round((actualTSSNow / roughPlannedTSS - 1) * 100);
      showReduceBtn = true;
      reduceBtnText = `This week is ${overPct}% above your plan`;
    }
  }

  if (reduceBtn) {
    if (showReduceBtn) {
      reduceBtn.classList.remove('hidden');
      reduceBtn.textContent = reduceBtnText;
    } else {
      reduceBtn.classList.add('hidden');
    }
  }
  if (dismissBtn) {
    if (showReduceBtn) {
      dismissBtn.classList.remove('hidden');
    } else {
      dismissBtn.classList.add('hidden');
    }
  }

  // ── Escalating injury risk label (§5.3) ──────────────────────────────
  if (riskLabelEl) {
    const consecutiveOverrides = computeConsecutiveOverrides(s.wks ?? [], s.w);
    let riskHtml = '';
    if (consecutiveOverrides >= 3) {
      riskHtml = `<p class="text-[10px] font-medium" style="color:var(--c-warn)">Risk: Extreme — injury window open (${consecutiveOverrides} consecutive overrides)</p>`;
    } else if (consecutiveOverrides === 2) {
      riskHtml = `<p class="text-[10px]" style="color:var(--c-warn)">Risk: Very High — we strongly advise reducing load</p>`;
    } else if (consecutiveOverrides === 1) {
      riskHtml = `<p class="text-[10px]" style="color:var(--c-caution)">Risk: High — you overrode a reduction recommendation</p>`;
    } else if (acwr.status === 'high') {
      riskHtml = `<p class="text-[10px]" style="color:var(--c-warn)">Risk: High</p>`;
    } else if (acwr.status === 'caution') {
      riskHtml = `<p class="text-[10px]" style="color:var(--c-caution)">Risk: Moderate</p>`;
    }
    if (riskHtml) {
      riskLabelEl.innerHTML = riskHtml;
      riskLabelEl.classList.remove('hidden');
    } else {
      riskLabelEl.classList.add('hidden');
    }
  }

  // ── Zone carry banner ─────────────────────────────────────────────────
  updateCarryBanner(s);

  // Update lightened week banner
  updateLightenedWeekBanner(s);
}

/** Count consecutive weeks (ending before currentWeek) where acwrOverridden is true */
function computeConsecutiveOverrides(wks: import('@/types').Week[], currentWeek: number): number {
  let count = 0;
  for (let i = currentWeek - 2; i >= 0; i--) {
    if (wks[i]?.acwrOverridden) { count++; } else { break; }
  }
  return count;
}

/** Zone carry banner — amber banner when prior weeks had excess TSS that hasn't decayed yet */
function updateCarryBanner(s: SimulatorState): void {
  const bannerEl = document.getElementById('acwr-carry-banner');
  if (!bannerEl) return;

  const CTL_DECAY = Math.exp(-7 / 42); // ≈ 0.847
  const MIN_SHOW = 8; // TSS

  let totalBase = 0, totalThresh = 0, totalIntens = 0;
  const rows: { week: number; base: number; threshold: number; intensity: number; decay: number }[] = [];

  for (let i = 0; i < s.w - 1; i++) {
    const wk = s.wks[i];
    if (!wk?.carriedTSS) continue;
    const ageWeeks = (s.w - 1) - i;
    const decay = Math.pow(CTL_DECAY, ageWeeks - 1);
    const b = wk.carriedTSS.base * decay;
    const t = wk.carriedTSS.threshold * decay;
    const intens = wk.carriedTSS.intensity * decay;
    if (b + t + intens < MIN_SHOW) continue;
    totalBase += b; totalThresh += t; totalIntens += intens;
    rows.push({ week: wk.w, base: Math.round(b), threshold: Math.round(t), intensity: Math.round(intens), decay });
  }

  const totalCarry = Math.round(totalBase + totalThresh + totalIntens);
  if (totalCarry < MIN_SHOW) {
    bannerEl.innerHTML = '';
    return;
  }

  // Dominant zone
  const dominant = totalIntens >= totalBase && totalIntens >= totalThresh ? 'intensity'
    : totalThresh >= totalBase ? 'threshold' : 'base';
  const domColorStyle = dominant === 'intensity' ? 'color:#F97316' : dominant === 'threshold' ? 'color:var(--c-caution)' : 'color:var(--c-accent)';
  const domDotStyle   = dominant === 'intensity' ? 'background:#F97316' : dominant === 'threshold' ? 'background:var(--c-caution)' : 'background:var(--c-accent)';

  bannerEl.innerHTML = `
    <div class="mb-2">
      <button id="carry-expand-btn" class="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-left" style="background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.20)">
        <span class="flex items-center gap-1.5" style="color:rgba(245,158,11,0.80)">
          <span class="w-1.5 h-1.5 rounded-full inline-block" style="${domDotStyle}"></span>
          Carrying +${totalCarry} TSS · ${dominant}-heavy
        </span>
        <span class="text-[10px]" style="color:var(--c-faint)" id="carry-chevron">▾</span>
      </button>
      <div id="carry-detail" class="hidden px-3 py-2 rounded-b-lg text-[10px] space-y-1 mt-0.5" style="background:rgba(0,0,0,0.03);border:1px solid rgba(245,158,11,0.15);border-top:none">
        ${rows.map(r => {
          const rowTotal = r.base + r.threshold + r.intensity;
          const dom = r.intensity >= r.base && r.intensity >= r.threshold ? 'intensity' : r.threshold >= r.base ? 'threshold' : 'base';
          const dcStyle = dom === 'intensity' ? 'color:#F97316' : dom === 'threshold' ? 'color:var(--c-caution)' : 'color:var(--c-accent)';
          return `<div class="flex items-center justify-between"><span style="color:var(--c-faint)">Week ${r.week}</span><span style="${dcStyle}">+${rowTotal} TSS (${dom})</span><span style="color:rgba(0,0,0,0.20)">×${r.decay.toFixed(2)} decay</span></div>`;
        }).join('')}
        <div class="border-t pt-1 flex justify-between" style="border-color:var(--c-border)"><span style="color:var(--c-muted)">Total</span><span style="${domColorStyle}">+${totalCarry} TSS</span></div>
      </div>
    </div>
  `;

  document.getElementById('carry-expand-btn')?.addEventListener('click', () => {
    const detail = document.getElementById('carry-detail');
    const chevron = document.getElementById('carry-chevron');
    if (detail) detail.classList.toggle('hidden');
    if (chevron) chevron.textContent = detail?.classList.contains('hidden') ? '▾' : '▴';
  });
}

function updateLightenedWeekBanner(s: SimulatorState): void {
  const bannerEl = document.getElementById('acwr-lightened-banner');
  if (!bannerEl) return;
  const wk = s.wks?.[s.w - 1];
  const reason = wk?.weekAdjustmentReason;
  if (!reason) {
    bannerEl.innerHTML = '';
    return;
  }
  bannerEl.innerHTML = `
    <div class="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg text-xs" style="background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.20)">
      <svg class="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style="color:var(--c-caution)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z"/>
      </svg>
      <span style="color:rgba(245,158,11,0.80)">Week ${s.w} was lightened — ${reason}</span>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// ACWR reduction trigger (absorbed from retired excess-load-card.ts)
// ---------------------------------------------------------------------------

function getWeekWorkoutsForACWR(s: ReturnType<typeof getMutableState>) {
  const wk = s.wks?.[s.w - 1];
  if (!wk) return [];
  let wg = 0;
  for (let i = 0; i < s.w - 1; i++) wg += s.wks[i].wkGain;
  const currentVDOT = s.v + wg + s.rpeAdj + (s.physioAdj || 0);
  const previousSkips = s.w > 1 ? s.wks[s.w - 2].skip : [];
  let trailingEffort = 0;
  const lookback = Math.min(3, s.w - 1);
  if (lookback > 0) {
    let total = 0; let count = 0;
    for (let i = s.w - 2; i >= s.w - 1 - lookback && i >= 0; i--) {
      if (s.wks[i].effortScore != null) { total += s.wks[i].effortScore!; count++; }
    }
    if (count > 0) trailingEffort = total / count;
  }
  return generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, previousSkips, s.commuteConfig,
    (s as any).injuryState || null, s.recurringActivities,
    s.onboarding?.experienceLevel,
    (s.maxHR || s.restingHR || s.onboarding?.age)
      ? { lthr: undefined, maxHR: s.maxHR, restingHR: s.restingHR, age: s.onboarding?.age }
      : undefined,
    gp(currentVDOT, s.lt).e, s.w, s.tw, currentVDOT, s.gs, trailingEffort, wk.scheduledAcwrStatus,
  );
}

export function triggerACWRReduction(): void {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk) return;

  const tier = s.athleteTierOverride ?? s.athleteTier;
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate);

  // Build popup source: use unspent items if present, else synthesise from planned load
  let durationMin: number;
  let aerobic: number;
  let anaerobic: number;
  let sport: string;
  let sportLabel: string;

  if (wk.unspentLoadItems?.length) {
    const items = wk.unspentLoadItems;
    durationMin  = items.reduce((sum, i) => sum + i.durationMin, 0);
    aerobic      = items.reduce((sum, i) => sum + i.aerobic, 0);
    anaerobic    = items.reduce((sum, i) => sum + i.anaerobic, 0);
    sport        = items[0]?.sport ?? 'cross-training';
    sportLabel   = items.length === 1
      ? (items[0].displayName || items[0].sport?.replace(/_/g, ' ') || 'cross-training')
      : 'cross-training load';
  } else {
    // Synthesise from the excess ACWR. Approximate: excess = (ratio - 1) * CTL weekly equiv.
    const excessFraction = Math.max(0, acwr.ratio - acwr.safeUpper);
    const estimatedWeeklyTSS = Math.max(50, acwr.ctl); // rough weekly TSS proxy
    const excessTSS = excessFraction * estimatedWeeklyTSS;
    // Convert TSS → approximate minutes at easy pace (≈ 55 TSS/60min easy)
    durationMin = Math.max(20, Math.round((excessTSS / 55) * 60));
    aerobic     = 3.5;
    anaerobic   = 0.5;
    sport       = 'running';
    sportLabel  = 'Training load';
  }

  const avgRPE = aerobic > 3.5 ? 7 : 5;
  const combinedActivity = createActivity(sport, Math.round(durationMin), avgRPE, undefined, undefined, s.w);
  combinedActivity.dayOfWeek = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;

  const freshWorkouts  = getWeekWorkoutsForACWR(s).filter(w => wk.rated[w.id || w.n] === undefined);
  const weekRuns       = workoutsToPlannedRuns(freshWorkouts, s.pac);
  const ctx            = { raceGoal: s.rd, plannedRunsPerWeek: s.rw, injuryMode: !!(s as any).injuryState, easyPaceSecPerKm: s.pac?.e, runnerType: s.typ as 'Speed' | 'Endurance' | 'Balanced' | undefined };
  const popup          = buildCrossTrainingPopup(ctx, weekRuns, combinedActivity);

  // Compute intensity % for ACWR context header
  const plannedThreshold = freshWorkouts.filter(w => w.t === 'threshold' || w.t === 'marathon_pace').length;
  const plannedIntensity = freshWorkouts.filter(w => w.t === 'vo2' || w.t === 'intervals').length;
  const intensityPct     = freshWorkouts.length > 0
    ? Math.round(((plannedThreshold + plannedIntensity) / freshWorkouts.length) * 100)
    : 0;

  // Compute rule-driving fields for the 5-rule plain language advice
  // Rule 2 — km spike
  let actualRunKmForRule = 0;
  const plannedRunKmForRule = (getWeekWorkoutsForACWR(s) as any[])
    .filter((w: any) => ['easy','long','marathon_pace','threshold','vo2','intervals','progressive','mixed'].includes(w.t))
    .reduce((sum: number, w: any) => { const m = (w.d ?? '').match(/(\d+\.?\d*)\s*km/); return sum + (m ? parseFloat(m[1]) : 0); }, 0);
  if (wk.garminActuals) {
    for (const [wId, act] of Object.entries(wk.garminActuals)) {
      const pw = getWeekWorkoutsForACWR(s).find((w: any) => (w.id || w.n) === wId);
      if (pw && ['easy','long','marathon_pace','threshold','vo2','intervals','progressive','mixed'].includes((pw as any).t)) {
        actualRunKmForRule += (act as any).distanceKm ?? 0;
      }
    }
  }
  const kmSpiked = plannedRunKmForRule > 0 && actualRunKmForRule > plannedRunKmForRule * 1.3;
  // Rule 3 — cross-training cause
  const crossTrainingCause = (wk.unspentLoadItems?.length && sport !== 'running')
    ? (wk.unspentLoadItems[0]?.sport ?? undefined)
    : undefined;
  // Rule 4 — consecutive intensity-heavy weeks from historicWeeklyZones
  const histZones = s.historicWeeklyZones ?? [];
  let consecutiveIntensityWeeks = 0;
  for (let i = histZones.length - 1; i >= 0; i--) {
    const z = histZones[i];
    const total = z.base + z.threshold + z.intensity;
    if (total > 0 && z.intensity / total > 0.40) { consecutiveIntensityWeeks++; } else { break; }
  }

  const acwrCtx: ACWRModalContext | undefined = (acwr.status === 'caution' || acwr.status === 'high')
    ? { ratio: acwr.ratio, status: acwr.status, safeUpper: acwr.safeUpper, intensityPct,
        kmSpiked, crossTrainingCause, consecutiveIntensityWeeks: consecutiveIntensityWeeks >= 3 ? consecutiveIntensityWeeks : undefined }
    : undefined;

  showSuggestionModal(popup, sportLabel, (decision) => {
    if (!decision) return;
    const s3  = getMutableState();
    const wk3 = s3.wks?.[s3.w - 1];
    if (!wk3) return;

    if (decision.choice === 'keep') {
      // User saw the recommendation but chose to keep full load — record override
      wk3.acwrOverridden = true;
    } else if (decision.adjustments.length > 0) {
      const freshW   = getWeekWorkoutsForACWR(s3);
      const modified = applyAdjustments(freshW, decision.adjustments, normalizeSport(sport), s3.pac);
      if (!wk3.workoutMods) wk3.workoutMods = [];
      for (const adj of decision.adjustments) {
        const mw = modified.find(w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex);
        if (!mw) continue;
        wk3.workoutMods.push({
          name: mw.n, dayOfWeek: mw.dayOfWeek, status: mw.status || 'reduced',
          modReason: `ACWR: ${sportLabel}`, confidence: mw.confidence,
          originalDistance: mw.originalDistance, newDistance: mw.d, newType: mw.t, newRpe: mw.rpe || mw.r,
        } as WorkoutMod);
      }
    }

    // Clear unspent items if they were the source
    if (wk3.unspentLoadItems?.length) {
      wk3.unspentLoadItems = [];
      wk3.unspentLoad = 0;
    }

    saveState();
    render();
  }, acwrCtx);
}

function showACWRInfoSheet(): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 bg-black/70 flex items-end justify-center';
  overlay.innerHTML = `
    <div class="rounded-t-2xl w-full max-w-lg" style="background:var(--c-surface);padding-bottom: env(safe-area-inset-bottom, 0px)">
      <div class="px-4 pt-4 pb-3 border-b flex items-center justify-between" style="border-color:var(--c-border)">
        <h2 class="font-semibold" style="color:var(--c-black)">Injury Risk (ACWR)</h2>
        <button id="acwr-sheet-close" class="text-xl leading-none" style="color:var(--c-muted)">✕</button>
      </div>
      <div class="px-4 py-4 space-y-4 text-sm">
        <p style="color:var(--c-muted)"><span style="color:var(--c-black);font-weight:500">ACWR</span> (Acute:Chronic Workload Ratio) compares your recent training load to your long-term baseline. A ratio near 1.0 means your current week matches your 6-week average — safe territory.</p>
        <div class="rounded-lg p-3 space-y-2" style="background:rgba(0,0,0,0.04)">
          <p class="text-xs font-medium uppercase tracking-wide" style="color:var(--c-faint)">Zones</p>
          <div class="flex items-center gap-2 text-xs"><div class="w-2 h-2 rounded-full shrink-0" style="background:var(--c-ok)"></div><span style="color:var(--c-ok)">Safe (0.8–threshold)</span><span style="color:var(--c-muted)" class="ml-1">— load increase is manageable</span></div>
          <div class="flex items-center gap-2 text-xs"><div class="w-2 h-2 rounded-full shrink-0" style="background:var(--c-caution)"></div><span style="color:var(--c-caution)">Caution</span><span style="color:var(--c-muted)" class="ml-1">— consider reducing one hard session</span></div>
          <div class="flex items-center gap-2 text-xs"><div class="w-2 h-2 rounded-full shrink-0" style="background:var(--c-warn)"></div><span style="color:var(--c-warn)">High risk</span><span style="color:var(--c-muted)" class="ml-1">— significantly above baseline, injury risk elevated</span></div>
        </div>
        <p class="text-xs" style="color:var(--c-faint)">The safe threshold varies by your training history — experienced athletes tolerate higher ratios. Your threshold adjusts as you build history.</p>
        <p class="text-xs" style="color:var(--c-faint)">The ratio needs at least 3 completed weeks to become meaningful.</p>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#acwr-sheet-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

function showTSSInfoSheet(): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 bg-black/70 flex items-end justify-center';
  overlay.innerHTML = `
    <div class="rounded-t-2xl w-full max-w-lg overflow-y-auto" style="background:var(--c-surface);max-height:85vh;padding-bottom: env(safe-area-inset-bottom, 0px)">
      <div class="px-4 pt-4 pb-3 border-b flex items-center justify-between" style="border-color:var(--c-border)">
        <h2 class="font-semibold" style="color:var(--c-black)">Training Load</h2>
        <button id="tss-sheet-close" class="text-xl leading-none" style="color:var(--c-muted)">✕</button>
      </div>
      <div class="px-4 py-4 space-y-5 text-sm">

        <div>
          <p class="text-xs font-medium uppercase tracking-wide mb-2" style="color:var(--c-faint)">What is TSS?</p>
          <p style="color:var(--c-muted)">TSS (Training Stress Score) measures how much stress your body absorbed from a session. It combines <span style="color:var(--c-black);font-weight:500">duration</span> and <span style="color:var(--c-black);font-weight:500">intensity</span> — a hard 30-minute run scores higher than an easy 60-minute one.</p>
          <div class="rounded-lg p-3 space-y-2 mt-3" style="background:rgba(0,0,0,0.04)">
            <div class="flex justify-between text-xs"><span style="color:var(--c-muted)">Easy 60 min run</span><span style="color:var(--c-black);font-weight:500">≈ 55 TSS</span></div>
            <div class="flex justify-between text-xs"><span style="color:var(--c-muted)">Threshold 45 min</span><span style="color:var(--c-black);font-weight:500">≈ 80 TSS</span></div>
            <div class="flex justify-between text-xs"><span style="color:var(--c-muted)">Race effort 60 min</span><span style="color:var(--c-black);font-weight:500">≈ 100 TSS</span></div>
          </div>
        </div>

        <div>
          <p class="text-xs font-medium uppercase tracking-wide mb-2" style="color:var(--c-faint)">Fitness, Fatigue & Form</p>
          <div class="space-y-3">
            <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
              <div class="flex items-center gap-2 mb-1">
                <div class="w-2 h-2 rounded-full shrink-0" style="background:var(--c-ok)"></div>
                <span class="font-medium text-xs" style="color:var(--c-ok)">Fitness (CTL)</span>
              </div>
              <p class="text-xs" style="color:var(--c-muted)">Your 6-week rolling average of weekly TSS. This represents how much your body has adapted to training. It rises slowly with consistent work and falls slowly during rest. The ◆ marker on the load bar shows your current fitness baseline.</p>
            </div>
            <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
              <div class="flex items-center gap-2 mb-1">
                <div class="w-2 h-2 rounded-full shrink-0" style="background:var(--c-warn)"></div>
                <span class="font-medium text-xs" style="color:var(--c-warn)">Fatigue (ATL)</span>
              </div>
              <p class="text-xs" style="color:var(--c-muted)">Your 1-week rolling average. Fatigue rises quickly after hard sessions and drops within days of rest. A big gap between Fatigue and Fitness means your body needs recovery time.</p>
            </div>
            <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
              <div class="flex items-center gap-2 mb-1">
                <div class="w-2 h-2 rounded-full shrink-0" style="background:var(--c-accent)"></div>
                <span class="font-medium text-xs" style="color:var(--c-accent)">Form (TSB = Fitness − Fatigue)</span>
              </div>
              <p class="text-xs" style="color:var(--c-muted)">How ready you are to perform. Negative = accumulated fatigue, normal during hard training blocks. Positive = you're fresh. Best race form is TSB around 0 to +10 — fit but rested. During taper, TSB should climb toward this range.</p>
            </div>
          </div>
        </div>

        <div>
          <p class="text-xs font-medium uppercase tracking-wide mb-2" style="color:var(--c-faint)">Bar zones</p>
          <div class="space-y-1.5">
            <div class="flex items-center gap-2 text-xs"><div class="w-3 h-2 rounded shrink-0" style="background:rgba(0,0,0,0.15)"></div><span style="color:var(--c-muted)"><span style="color:var(--c-black)">Gray</span> — your fitness baseline (◆). Load below this is recovery.</span></div>
            <div class="flex items-center gap-2 text-xs"><div class="w-3 h-2 rounded shrink-0" style="background:rgba(34,197,94,0.25)"></div><span style="color:var(--c-muted)"><span style="color:var(--c-black)">Green</span> — the planned target zone. Aim for this range.</span></div>
            <div class="flex items-center gap-2 text-xs"><div class="w-3 h-2 rounded shrink-0" style="background:rgba(245,158,11,0.25)"></div><span style="color:var(--c-muted)"><span style="color:var(--c-black)">Amber</span> — up to 20% above plan. Manageable if short-term.</span></div>
            <div class="flex items-center gap-2 text-xs"><div class="w-3 h-2 rounded shrink-0" style="background:rgba(239,68,68,0.25)"></div><span style="color:var(--c-muted)"><span style="color:var(--c-black)">Red</span> — significantly over plan. Injury risk rises here.</span></div>
          </div>
        </div>

        <div>
          <p class="text-xs font-medium uppercase tracking-wide mb-2" style="color:var(--c-faint)">Zone breakdown</p>
          <div class="space-y-1.5">
            <div class="flex items-center gap-2 text-xs"><div class="w-2 h-2 rounded-full shrink-0" style="background:var(--c-accent)"></div><span class="font-medium" style="color:var(--c-accent)">Base (Z1–Z2)</span><span style="color:var(--c-muted)">— easy aerobic, fat-burning, recovery</span></div>
            <div class="flex items-center gap-2 text-xs"><div class="w-2 h-2 rounded-full shrink-0" style="background:var(--c-caution)"></div><span class="font-medium" style="color:var(--c-caution)">Threshold (Z3)</span><span style="color:var(--c-muted)">— comfortably hard, lactate threshold</span></div>
            <div class="flex items-center gap-2 text-xs"><div class="w-2 h-2 rounded-full shrink-0" style="background:#F97316"></div><span class="font-medium" style="color:#F97316">Intensity (Z4–Z5)</span><span style="color:var(--c-muted)">— hard intervals, VO2max, race pace</span></div>
          </div>
        </div>

        <p class="text-xs" style="color:var(--c-faint)">When your Strava HR data is available, TSS is calculated from actual heart rate (iTRIMP). Otherwise it's estimated from your RPE rating. Planned TSS for cross-training may look higher than actual — the plan estimates by duration; real HR data captures the lower running-specific stress of cycling, tennis, etc.</p>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#tss-sheet-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

function wireEventHandlers(): void {
  const s = getState();
  const isAdmin = s.isAdmin || false;
  const maxViewableWeek = s.tw; // Unlimited access (trial cap removed)

  // Tab bar navigation
  wireTabBarHandlers((tab: TabId) => {
    if (tab === 'home') {
      import('./home-view').then(({ renderHomeView }) => renderHomeView());
    } else if (tab === 'account') {
      import('./account-view').then(({ renderAccountView }) => renderAccountView());
    } else if (tab === 'record') {
      import('./record-view').then(({ renderRecordView }) => renderRecordView());
    } else if (tab === 'stats') {
      import('./stats-view').then(({ renderStatsView }) => renderStatsView());
    }
    // 'plan' is already active
  });

  // TSS info button
  document.getElementById('tss-info-btn')?.addEventListener('click', showTSSInfoSheet);

  // ACWR info + reduce + dismiss buttons
  document.getElementById('acwr-info-btn')?.addEventListener('click', showACWRInfoSheet);
  document.getElementById('acwr-reduce-btn')?.addEventListener('click', triggerACWRReduction);
  document.getElementById('acwr-dismiss-btn')?.addEventListener('click', () => {
    const s2 = getMutableState();
    const wk2 = s2.wks?.[s2.w - 1];
    if (wk2) { wk2.acwrOverridden = true; }
    saveState();
    updateACWRBar(getState());
  });

  // Complete week button
  document.getElementById('btn-complete-week')?.addEventListener('click', next);

  // Edit Settings button
  document.getElementById('btn-edit-settings')?.addEventListener('click', editSettings);

  // Reset button
  document.getElementById('btn-reset')?.addEventListener('click', reset);

  // Week navigation with viewWeek — restore persisted position across re-renders
  let viewWeek = (_persistedViewWeek !== null && _persistedViewWeek >= 1 && _persistedViewWeek <= maxViewableWeek)
    ? _persistedViewWeek
    : s.w;

  const updateViewWeek = (newWeek: number) => {
    viewWeek = Math.max(1, Math.min(newWeek, maxViewableWeek));
    _persistedViewWeek = viewWeek;
    const sliderEl = document.getElementById('week-slider') as HTMLInputElement;
    if (sliderEl) sliderEl.value = String(viewWeek);
    const wnEl = document.getElementById('wn');
    if (wnEl) wnEl.textContent = String(viewWeek);
    const headerWeek = document.querySelector('h3.text-sm.font-medium');
    const viewBlockNum = Math.floor((viewWeek - 1) / 4) + 1;
    const viewState = { ...s, w: viewWeek };
    if (headerWeek) headerWeek.textContent = getWeekNavigatorLabel(viewState, viewBlockNum);
    const dateLabelEl = document.getElementById('week-date-label');
    if (dateLabelEl) dateLabelEl.textContent = getWeekDateLabel(s, viewWeek) ?? '';
    const viewWk = s.wks?.[viewWeek - 1];
    const phaseLabel = document.getElementById('phase-label');
    if (phaseLabel && viewWk) phaseLabel.textContent = getPhaseLabel(viewWk.ph, s.continuousMode);
    const weekCounter = document.getElementById('week-counter');
    if (weekCounter) {
      weekCounter.textContent = getWeekCounterLabel(viewState);
    }

    const isViewing = viewWeek !== s.w;

    // Show/hide viewing indicator
    const viewIndicator = document.getElementById('view-week-indicator');
    if (viewIndicator) {
      if (isViewing) {
        viewIndicator.innerHTML = `
          <div class="flex items-center justify-between gap-2">
            <span><span style="color:var(--c-caution)">Viewing Week ${viewWeek}</span> · <span style="color:var(--c-muted)">You are on Week ${s.w}</span></span>
            <button onclick="window.__editThisWeek()" class="px-2 py-1 rounded text-xs font-medium transition-colors" style="background:var(--c-caution);color:white">Edit this week</button>
          </div>
        `;
        viewIndicator.classList.remove('hidden');

        // Wire up edit-this-week action (closure captures current viewWeek)
        // Simply sets the current week pointer back to the viewed week and reloads.
        // All existing activity pairings, ratings, and plan state are preserved.
        // The activity review will only fire if there are genuinely unprocessed (__pending__)
        // items — it won't fire for activities that are already paired.
        (window as any).__editThisWeek = () => {
          const ms = getMutableState();
          ms.w = viewWeek;
          ms.hasCompletedOnboarding = true;
          saveState();
          location.reload();
        };
      } else {
        viewIndicator.classList.add('hidden');
      }
    }

    // Disable Complete Week button when viewing non-current week
    const completeBtn = document.getElementById('btn-complete-week') as HTMLButtonElement;
    if (completeBtn) {
      if (isViewing) {
        completeBtn.disabled = true;
        completeBtn.className = 'w-full font-medium py-2 rounded text-sm cursor-not-allowed';
        completeBtn.style.cssText = 'background:rgba(0,0,0,0.05);color:var(--c-faint)';
        completeBtn.textContent = 'Viewing — Return to current week';
      } else {
        completeBtn.disabled = false;
        completeBtn.className = 'w-full font-medium py-2 rounded text-sm transition-colors';
        completeBtn.style.cssText = 'background:var(--c-ok);color:white';
        completeBtn.textContent = 'Complete Week';
      }
    }

    // Update mutable state temporarily for render
    const ms = getMutableState();
    const savedW = ms.w;
    ms.w = viewWeek;
    (ms as any)._viewOnly = isViewing;
    (ms as any)._realW = savedW;
    render();
    ms.w = savedW;
    delete (ms as any)._viewOnly;
    delete (ms as any)._realW;

    // Update load chart for the viewed week (ACWR bar always shows current week)
    updateLoadChart({ ...getState(), w: viewWeek });
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

  // Sync watch button
  document.getElementById('btn-sync-now')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sync-now') as HTMLButtonElement;
    if (!btn || btn.disabled) return;
    const s2 = getState();
    const syncLabel = s2.stravaConnected ? 'Sync Strava' : s2.wearable === 'apple' ? 'Sync Apple Watch' : 'Sync Garmin';
    const svgSync = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>`;
    btn.disabled = true;
    btn.innerHTML = `<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Syncing...`;
    try {
      if (s2.stravaConnected) {
        // Strava for activities; also sync Garmin biometrics if wearable is Garmin
        const syncs: Promise<unknown>[] = [syncStravaActivities()];
        if (s2.wearable === 'garmin') syncs.push(syncPhysiologySnapshot(7));
        await Promise.all(syncs);
      } else {
        await Promise.all([syncActivities(), syncPhysiologySnapshot(7)]);
      }
      render();
      btn.innerHTML = `<svg class="w-4 h-4" style="color:var(--c-ok)" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Synced`;
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = `${svgSync} ${syncLabel}`;
      }, 2000);
    } catch {
      btn.disabled = false;
      btn.innerHTML = `<svg class="w-4 h-4" style="color:var(--c-warn)" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg> Sync Failed`;
      setTimeout(() => {
        btn.innerHTML = `${svgSync} ${syncLabel}`;
      }, 2000);
    }
  });

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

  // Initial render at the correct view week (handles both current week and persisted future week)
  updateViewWeek(viewWeek);

  // Populate load chart and ACWR bar after DOM is ready
  updateLoadChart(s);
  updateACWRBar(s);
}

/**
 * Reusable styled confirm modal.
 */
function showStyledConfirm(title: string, message: string, confirmLabel: string, cancelLabel: string): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
    overlay.innerHTML = `
      <div class="rounded-xl max-w-sm w-full p-6" style="background:var(--c-surface);border:1px solid var(--c-border)">
        <h3 class="font-semibold text-lg mb-2" style="color:var(--c-black)">${title}</h3>
        <p class="text-sm mb-5" style="color:var(--c-muted)">${message}</p>
        <div class="flex flex-col gap-2">
          <button id="btn-styled-confirm" class="w-full py-2.5 font-medium rounded-lg transition-colors text-sm" style="background:var(--c-ok);color:white">
            ${confirmLabel}
          </button>
          <button id="btn-styled-cancel" class="w-full py-2.5 font-medium rounded-lg transition-colors text-sm" style="background:rgba(0,0,0,0.05);color:var(--c-muted)">
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
  toast.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 px-6 py-3 rounded-xl shadow-lg text-sm font-medium z-50 transition-opacity';
  toast.style.cssText = 'background:var(--c-ok);color:white';
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
