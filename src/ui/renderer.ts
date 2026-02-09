import type { Workout, Week } from '@/types';
import {
  getState, getMutableState
} from '@/state';
import {
  rdKm, tv, gp, getRunnerType,
  calculateLiveForecast
} from '@/calculations';
import { IMP } from '@/constants';
import {
  generateWeekWorkouts, parseWorkoutDescription,
  calculateWorkoutLoad, checkConsecutiveHardDays, assignDefaultDays
} from '@/workouts';
// applyCrossTrainingToWorkouts is intentionally NOT used here.
// Plan modifications must only happen via explicit user confirmation in events.ts.
import { ft, fp, formatPace, formatWorkoutTime, DAY_NAMES, DAY_NAMES_SHORT } from '@/utils';
import { SPORTS_DB, SPORT_LABELS } from '@/constants';
import { getActiveWorkoutName, getActiveGpsData, isTrackingActive } from './gps-events';
import { renderInlineGpsHtml, refreshRecordings } from './gps-panel';
import { findMatchingWorkout, type ExternalActivity } from '@/calculations/matching';
import { showMatchProposal } from './sync-modal';
import { showRPEHelp, showMPHelp } from './explanations';

// Expose explanation modals globally for onclick handlers
declare global {
  interface Window {
    Mosaic: {
      showRPEHelp: typeof showRPEHelp;
      showMPHelp: typeof showMPHelp;
    };
  }
}
window.Mosaic = { showRPEHelp, showMPHelp };

/**
 * Add log entry to training log
 */
export function log(message: string): void {
  const s = getState();
  const lgEl = document.getElementById('lg');
  if (!lgEl) return;

  const e = document.createElement('div');
  e.className = 'p-1.5 bg-gray-800 rounded border-l-2 border-gray-600 text-xs text-gray-300';
  e.innerHTML = `<span class="text-gray-500">W${s.w}</span> ${message}`;
  lgEl.insertBefore(e, lgEl.firstChild);
}

/**
 * Main render function - displays current week's workouts and predictions
 */
export function render(): void {
  const s = getMutableState();

  if (!s.wks || s.wks.length === 0) {
    console.error('ERROR: s.wks is empty or undefined!');
    return;
  }

  const wk = s.wks[s.w - 1];
  if (!wk) {
    console.error('ERROR: Could not find week', s.w);
    return;
  }

  // Calculate predictions
  const raceDistKm = rdKm(s.rd);

  // For predictions/forecast, always use the real training week, not the viewed week
  const realW = (s as any)._viewOnly ? (s as any)._realW : s.w;

  // VDOT tracking
  let wg = 0;
  for (let i = 0; i < realW - 1; i++) {
    wg += s.wks[i].wkGain;
  }
  const currentVDOT = s.v + wg + s.rpeAdj;

  // Current fitness
  let currentFitness: number;
  if (realW === 1 && wg === 0 && s.rpeAdj === 0) {
    currentFitness = s.initialBaseline || 0;
  } else {
    currentFitness = tv(currentVDOT, raceDistKm);
  }
  if (!(s as any)._viewOnly) s.currentFitness = currentFitness;

  // Forecast: at week 1 with no training, use stored forecast so dashboard
  // matches the assessment page exactly. Once training starts, recalculate live.
  let forecast: number;
  if (realW === 1 && wg === 0 && s.rpeAdj === 0 && s.forecastTime) {
    forecast = s.forecastTime;
  } else {
    const wr = s.tw - realW + 1;
    const { forecastTime: rawForecast } = calculateLiveForecast({
      currentVdot: currentVDOT,
      targetDistance: s.rd,
      weeksRemaining: wr,
      sessionsPerWeek: (s.epw || s.rw) + (s.commuteConfig?.enabled ? s.commuteConfig.commuteDaysPerWeek : 0),
      runnerType: getRunnerType(s.b),
      experienceLevel: s.onboarding?.experienceLevel || 'intermediate',
      weeklyVolumeKm: s.wkm,
      hmPbSeconds: s.pbs?.h || undefined,
      ltPaceSecPerKm: s.lt || undefined,
      adaptationRatio: s.adaptationRatio,
    });
    forecast = rawForecast;
    if (s.timp > 0) forecast += s.timp;

    // Guardrail
    const maxSlowdown = s.timp * 0.5;
    if (forecast > currentFitness + maxSlowdown) {
      forecast = currentFitness + maxSlowdown;
    }
  }

  // If user accepted a milestone challenge, lock forecast to that target
  const milestone = s.onboarding?.targetMilestone;
  const isTargetLocked = s.onboarding?.acceptedMilestoneChallenge && milestone;
  const displayForecast = isTargetLocked ? milestone!.time : forecast;

  // Update prediction display
  const initialEl = document.getElementById('initial');
  if (initialEl) initialEl.textContent = ft(s.initialBaseline || 0);
  const cvEl = document.getElementById('cv');
  if (cvEl) cvEl.textContent = ft(currentFitness);
  const fcEl = document.getElementById('fc');
  if (fcEl) {
    fcEl.textContent = ft(displayForecast);
    if (isTargetLocked) {
      fcEl.innerHTML = ft(displayForecast) + ' <span class="text-xs text-emerald-300 ml-1">Target</span>';
    }
  }
  const prEl = document.getElementById('pr');
  if (prEl) prEl.textContent = `${s.w}/${s.tw}`;

  const improvementSoFar = s.initialBaseline
    ? ((s.initialBaseline - currentFitness) / s.initialBaseline) * 100
    : 0;
  const impEl = document.getElementById('impSoFar');
  if (impEl) impEl.textContent = `${improvementSoFar >= 0 ? '+' : ''}${improvementSoFar.toFixed(1)}%`;

  const wnEl = document.getElementById('wn');
  if (wnEl) wnEl.textContent = String(s.w);
  const phEl = document.getElementById('ph');
  if (phEl) phEl.textContent = wk.ph.toUpperCase();

  // Stale data warning
  const staleWarning = document.getElementById('staleWarning');
  if (staleWarning) {
    if (s.rec && s.rec.t > 0) {
      staleWarning.classList.toggle('hidden', (s.rec.weeksAgo || 0) <= 6);
    } else {
      staleWarning.classList.remove('hidden');
    }
  }

  // Generate workouts
  const previousSkips = s.w > 1 ? s.wks[s.w - 2].skip : [];
  const injuryState = (s as any).injuryState || null;  // Get injury state for plan adaptation
  let wos = generateWeekWorkouts(
    wk.ph,
    s.rw,
    s.rd,
    s.typ,
    previousSkips,
    s.commuteConfig,
    injuryState,  // Pass injury state to generator
    s.recurringActivities,  // Pass recurring cross-training activities
    s.onboarding?.experienceLevel,  // Pass fitness level to rules engine
    // Build HR profile from available data
    (s.maxHR || s.restingHR || s.onboarding?.age)
      ? { lthr: undefined, maxHR: s.maxHR, restingHR: s.restingHR, age: s.onboarding?.age }
      : undefined,
    gp(currentVDOT, s.lt).e, // Pass runner's adjusted easy pace for this specific week
    s.w,   // weekIndex for plan engine
    s.tw,  // totalWeeks for plan engine
    currentVDOT // vdot for plan engine (includes RPE and training gains)
  );

  // Apply stored modifications
  if (wk.workoutMods && wk.workoutMods.length > 0) {
    for (const mod of wk.workoutMods) {
      // Match by both name and dayOfWeek for unique identification (handles duplicate names like "Easy Run")
      const workout = wos.find(w => w.n === mod.name && (mod.dayOfWeek == null || w.dayOfWeek === mod.dayOfWeek));
      if (workout) {
        workout.status = mod.status as any;
        workout.modReason = mod.modReason;
        workout.confidence = mod.confidence as any;
        if (mod.status === 'reduced' || mod.status === 'replaced') {
          workout.originalDistance = mod.originalDistance;
          workout.d = mod.newDistance;
          // Apply new type and RPE if provided (for downgrades)
          if (mod.newType) workout.t = mod.newType;
          if (mod.newRpe != null) {
            workout.rpe = mod.newRpe;
            workout.r = mod.newRpe;
          }
          const newLoads = calculateWorkoutLoad(workout.t, workout.d, (workout.rpe || workout.r || 5) * 10);
          workout.aerobic = newLoads.aerobic;
          workout.anaerobic = newLoads.anaerobic;
        }
      }
    }
  }

  // Append ad-hoc workouts (e.g. "Just Run")
  if (wk.adhocWorkouts) {
    wos = wos.concat(wk.adhocWorkouts);
  }

  // Apply manual moves
  if (wk.workoutMoves) {
    for (const workoutName in wk.workoutMoves) {
      const newDay = wk.workoutMoves[workoutName];
      const workout = wos.find(w => w.n === workoutName);
      if (workout) {
        workout.dayOfWeek = newDay;
        workout.dayName = DAY_NAMES[newDay];
      }
    }
  }

  // Deduplicate workout names for unique completion tracking
  const nameCounts: Record<string, number> = {};
  for (const w of wos) {
    nameCounts[w.n] = (nameCounts[w.n] || 0) + 1;
  }
  const nameIdx: Record<string, number> = {};
  for (const w of wos) {
    if (nameCounts[w.n] > 1) {
      nameIdx[w.n] = (nameIdx[w.n] || 0) + 1;
      if (!w.id) w.id = `${w.n} ${nameIdx[w.n]}`;
      w.n = `${w.n} ${nameIdx[w.n]}`;
    }
  }

  // NOTE: Cross-training modifications are NO LONGER auto-applied during render.
  // Plan changes must only happen via explicit user confirmation in the suggestion modal.
  // The logActivity() function in events.ts handles showing the modal and applying changes.
  //
  // This prevents the bug where logging an activity would silently mutate the plan
  // without user consent.

  // Build HTML
  let h = `<h3 class="font-bold mb-3 text-sm text-white">Week ${s.w} Workouts (${wos.length})</h3>`;

  // Warnings
  const warnings = checkConsecutiveHardDays(wos);
  if (warnings.length > 0) {
    h += `<div class="bg-red-950/50 border border-red-800 p-2 rounded mb-3">`;
    h += `<div class="text-xs font-bold text-red-400 mb-1">Training Plan Warnings:</div>`;
    for (const warn of warnings) {
      const color = warn.level === 'critical' ? 'text-red-400' : 'text-amber-400';
      h += `<div class="text-xs ${color} py-0.5">${warn.message}</div>`;
    }
    h += `</div>`;
  }

  // Cross-training bonus
  if (wk.crossTrainingBonus && wk.crossTrainingBonus > 0.01) {
    h += `<div class="bg-emerald-950/30 border border-emerald-800 p-2 rounded mb-2 text-xs text-emerald-300">`;
    h += `<strong>Fitness Bonus:</strong> +${wk.crossTrainingBonus.toFixed(2)} VDOT from unscheduled activities`;
    h += `</div>`;
  }

  // Cross-training summary
  if (wk.crossTrainingSummary && (wk.crossTrainingSummary.workoutsReplaced > 0 || wk.crossTrainingSummary.workoutsReduced > 0)) {
    const summary = wk.crossTrainingSummary;
    const replacementPct = Math.round(summary.budgetUtilization.replacement * 100);
    const adjustmentPct = Math.round(summary.budgetUtilization.adjustment * 100);

    h += `<div class="bg-gray-800 border border-gray-700 p-2 rounded mb-2 text-xs">`;
    h += `<div class="font-bold text-gray-200 mb-1">Cross-Training Impact</div>`;
    h += `<div class="grid grid-cols-2 gap-2">`;

    // Modifications
    h += `<div class="space-y-0.5">`;
    if (summary.workoutsReplaced > 0) {
      h += `<div class="text-emerald-400">${summary.workoutsReplaced} workout${summary.workoutsReplaced > 1 ? 's' : ''} replaced</div>`;
    }
    if (summary.workoutsReduced > 0) {
      h += `<div class="text-sky-400">${summary.workoutsReduced} workout${summary.workoutsReduced > 1 ? 's' : ''} reduced</div>`;
    }
    h += `</div>`;

    // Budget utilization
    h += `<div class="space-y-0.5 text-gray-400">`;
    h += `<div class="flex items-center gap-1">`;
    h += `<span>Replace:</span>`;
    h += `<div class="flex-1 bg-gray-700 rounded-full h-2">`;
    h += `<div class="bg-emerald-500 h-2 rounded-full" style="width: ${Math.min(replacementPct, 100)}%"></div>`;
    h += `</div>`;
    h += `<span class="w-8 text-right">${replacementPct}%</span>`;
    h += `</div>`;
    h += `<div class="flex items-center gap-1">`;
    h += `<span>Adjust:</span>`;
    h += `<div class="flex-1 bg-gray-700 rounded-full h-2">`;
    h += `<div class="bg-sky-500 h-2 rounded-full" style="width: ${Math.min(adjustmentPct, 100)}%"></div>`;
    h += `</div>`;
    h += `<span class="w-8 text-right">${adjustmentPct}%</span>`;
    h += `</div>`;
    h += `</div>`;

    h += `</div>`;

    // Overflow warning
    if (summary.totalLoadOverflow > 50) {
      h += `<div class="mt-1 text-amber-400 text-xs">`;
      h += `+${Math.round(summary.totalLoadOverflow)} load overflow (contributing to fitness bonus)`;
      h += `</div>`;
    }

    h += `</div>`;
  }

  // Calendar view
  h += renderCalendar(wos, wk, s.pac);

  // Separate Quick Run from planned workouts so it renders in the Just Run banner
  const quickRun = wos.filter(w => w.n === 'Quick Run');
  const plannedWos = wos.filter(w => w.n !== 'Quick Run')
    .sort((a, b) => (a.dayOfWeek ?? 99) - (b.dayOfWeek ?? 99));

  // Detailed workout list (without Quick Run, sorted Mon→Sun)
  h += renderWorkoutList(plannedWos, wk, s.rd, s.pac, s.tw, s.w);

  // Paces
  h += `<div class="mt-3 text-xs text-gray-400 mb-1">Your current paces</div>`;
  h += `<div class="grid grid-cols-2 gap-1 text-xs">`;
  h += `<div class="bg-gray-800 p-1.5 rounded text-gray-300">Easy (no faster than): <strong class="text-gray-100">${fp(s.pac.e)}</strong></div>`;
  h += `<div class="bg-gray-800 p-1.5 rounded text-gray-300">Threshold: <strong class="text-gray-100">${fp(s.pac.t)}</strong></div>`;
  h += `<div class="bg-gray-800 p-1.5 rounded text-gray-300">VO2 Builder: <strong class="text-gray-100">${fp(s.pac.i)}</strong></div>`;
  h += `<div class="bg-gray-800 p-1.5 rounded text-gray-300">Marathon: <strong class="text-gray-100">${fp(s.pac.m)}</strong></div></div>`;

  // Cross-training form
  h += renderCrossTrainingForm();

  const woEl = document.getElementById('wo');
  if (woEl) woEl.innerHTML = h;

  // Render Quick Run card inside the Just Run banner (only when expanded)
  const jrSlot = document.getElementById('just-run-workout');
  if (jrSlot) {
    if (quickRun.length > 0 && (window as any).__justRunExpanded) {
      jrSlot.innerHTML = `<div class="border-t border-emerald-700/50 px-4 pb-4 pt-3">
        <div class="flex justify-end mb-1">
          <button onclick="toggleJustRunPanel()" class="text-gray-500 hover:text-gray-300 transition-colors" title="Minimise">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/></svg>
          </button>
        </div>
        ${renderWorkoutList(quickRun, wk, s.rd, s.pac, s.tw, s.w)}</div>`;
      jrSlot.classList.remove('hidden');
    } else {
      jrSlot.innerHTML = '';
      jrSlot.classList.add('hidden');
    }
  }

  // Populate past GPS recordings
  refreshRecordings();

  // Update complete week button
  const tot = wos.length;
  const don = Object.keys(wk.rated).length;
  const bnEl = document.getElementById('bn') as HTMLButtonElement;
  if (bnEl) {
    bnEl.disabled = don < tot;
    bnEl.className = don >= tot
      ? 'w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2 rounded text-xs'
      : 'w-full bg-gray-800 text-gray-500 font-bold py-2 rounded text-xs cursor-not-allowed';
  }
  const stEl = document.getElementById('st');
  if (stEl) stEl.innerHTML = don >= tot ? `Complete ${don}/${tot}` : `Progress ${don}/${tot}`;
}

/**
 * Render calendar view
 */
function renderCalendar(wos: Workout[], wk: Week, paces: any): string {
  let h = `<details class="mb-4" open><summary class="cursor-pointer text-sm font-medium text-gray-400 hover:text-gray-200 mb-2">Weekly Calendar View</summary>`;
  h += `<div class="grid grid-cols-7 gap-1">`;

  // Headers
  for (const day of DAY_NAMES_SHORT) {
    h += `<div class="text-xs font-bold text-center py-1 bg-gray-800 rounded text-gray-400">${day}</div>`;
  }

  // Cells
  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const dayWorkouts = wos.filter(w => w.dayOfWeek === dayIdx);
    const hasHard = dayWorkouts.some(w => isHardWorkoutType(w.t));
    const borderColor = hasHard ? 'border-red-800' : 'border-gray-700';

    h += `<div class="border ${borderColor} rounded p-1 min-h-[120px] bg-gray-800/50" ondrop="window.drop(event,${dayIdx})" ondragover="window.allowDrop(event)">`;

    if (dayWorkouts.length === 0) {
      h += `<div class="text-xs text-gray-600 text-center py-4">Rest</div>`;
    } else {
      for (const w of dayWorkouts) {
        const rtd = w.id ? wk.rated[w.id] : wk.rated[w.n];
        const isModified = w.status && (w.status === 'replaced' || w.status === 'reduced');
        const isReplaced = w.status === 'replaced';
        const isSkipped = w.skipped === true;

        const wColors = getWorkoutColors(w.t);
        let cardBg = wColors.bg;
        let cardBorder = wColors.border;
        // User-completed = green; Load covered = cyan; Modified/shakeout = sky; Skipped = amber
        if (rtd) { cardBg = 'bg-emerald-950/50'; cardBorder = 'border-emerald-700'; }
        else if (isReplaced) { cardBg = 'bg-cyan-950/50'; cardBorder = 'border-cyan-700'; }
        else if (isModified) { cardBg = 'bg-sky-950/50'; cardBorder = 'border-sky-700'; }
        else if (isSkipped) { cardBg = 'bg-amber-950/30'; cardBorder = 'border-amber-700'; }

        // Status label for calendar card
        let statusLabel = '';
        if (rtd) statusLabel = ' Done';
        else if (isReplaced) statusLabel = ' Covered';
        else if (isModified) statusLabel = ' Modified';

        h += `<div class="${cardBg} border ${cardBorder} rounded p-1 mb-1 text-xs cursor-move text-gray-300" draggable="true" ondragstart="window.dragStart(event,'${w.n.replace(/'/g, "\\'")}')">`;
        h += `<div class="font-semibold text-gray-200">${w.n}${statusLabel}</div>`;
        h += `<div class="text-xs text-gray-400">${injectPaces(w.d, paces)}</div>`;
        h += `<div class="text-xs ${wColors.accent}">RPE ${w.rpe || w.r}</div>`;
        h += `</div>`;
      }
    }
    h += `</div>`;
  }

  h += `</div></details>`;
  return h;
}

/**
 * Render detailed workout list
 */
function renderWorkoutList(wos: Workout[], wk: Week, rd: string, paces: any, tw: number, currentWeek: number): string {
  let h = `<h4 class="font-semibold text-sm mb-2 mt-4 text-white">Workouts</h4><div class="space-y-2">`;

  for (const w of wos) {
    const rtd = w.id ? wk.rated[w.id] : wk.rated[w.n];
    const impByType = IMP[rd as keyof typeof IMP] || {};
    const imp = (impByType as Record<string, number>)[w.t] || 0.5;
    const loads = calculateWorkoutLoad(w.t, w.d, (w.rpe || w.r || 5) * 10);

    const isModified = w.status && (w.status === 'replaced' || w.status === 'reduced');
    const isReplaced = w.status === 'replaced';
    const isSkipped = w.skipped === true;

    // Detail cards: User-completed = green; Load covered = cyan; Modified/shakeout = sky; Skipped = amber
    let borderClass = 'border-gray-700 bg-gray-800';
    if (rtd) borderClass = 'border-emerald-700 bg-emerald-950/30';
    else if (isReplaced) borderClass = 'border-cyan-700 bg-cyan-950/30';
    else if (isModified) borderClass = 'border-sky-700 bg-sky-950/30';
    else if (isSkipped) borderClass = 'border-amber-700 bg-amber-950/20';

    h += `<div class="border-2 ${borderClass} p-2 rounded">`;

    // Modification banner
    if (isModified && w.modReason) {
      const modColor = isReplaced ? 'bg-cyan-950/30 border-cyan-800 text-cyan-300' : 'bg-sky-950/30 border-sky-800 text-sky-300';
      const modLabel = isReplaced ? 'LOAD COVERED' : 'LOAD DOWNGRADE';
      h += `<div class="mb-2 p-1.5 ${modColor} border rounded text-xs">`;
      h += `<div class="font-bold">${modLabel}</div>`;
      h += `<div class="text-gray-400 mt-0.5">${w.modReason}</div>`;
      if (w.originalDistance && !isReplaced) {
        h += `<div class="text-gray-500 mt-0.5">Original: ${w.originalDistance}</div>`;
      }
      h += `</div>`;
    }

    // Skip banner
    if (isSkipped) {
      const skipColor = (w.skipCount || 0) === 1 ? 'bg-amber-950/30 border-amber-700 text-amber-300' : 'bg-red-950/30 border-red-800 text-red-300';
      h += `<div class="mb-2 p-1.5 ${skipColor} border rounded text-xs font-bold">`;
      h += (w.skipCount || 0) === 1 ? 'SKIPPED - Complete now (no penalty)' : 'FINAL CHANCE - Skip again = penalty!';
      h += `</div>`;
    }

    // Header
    const isQuickRun = w.n === 'Quick Run';
    const dayLabel = w.dayOfWeek != null ? DAY_NAMES_SHORT[w.dayOfWeek] : '';
    h += `<div class="flex justify-between mb-1 text-xs">`;
    h += `<div>${dayLabel ? `<span class="text-gray-500 mr-1.5">${dayLabel}</span>` : ''}<strong>${w.n}</strong>`;
    if (w.commute) h += ` <span class="bg-gray-700 text-gray-400 px-1 py-0.5 rounded ml-1 text-xs">Commute</span>`;
    if (rtd && rtd !== 'skip') h += ` <span class="bg-emerald-600 text-white px-1 py-0.5 rounded ml-1">Done ${rtd}</span>`;

    h += `</div>`;
    if (!isQuickRun) h += `<span class="bg-gray-600 text-gray-300 px-1 py-0.5 rounded">RPE ${w.rpe || w.r} <button class="text-blue-400 hover:text-blue-300 ml-0.5" onclick="window.Mosaic.showRPEHelp()">(?)</button></span>`;
    h += `</div>`;

    // Description
    h += `<div class="text-xs text-gray-400 mb-1">${injectPaces(w.d, paces)}</div>`;
    h += `<div class="text-xs mb-1 text-gray-500">Forecast load: <span class="text-red-400">A${loads.aerobic}</span> / <span class="text-amber-400">An${loads.anaerobic}</span></div>`;

    // Pace info
    const workoutInfo = isReplaced ? { totalDistance: 0, totalTime: 0, avgPace: null } : parseWorkoutDescription(w.d, paces);
    if (workoutInfo.avgPace || workoutInfo.totalTime > 0) {
      const paceLabel = w.t === 'easy' ? 'No faster than' : 'Pace';
      h += `<div class="text-xs mb-1 text-sky-300 bg-gray-700/50 p-1 rounded">`;
      if (workoutInfo.avgPace) h += `${paceLabel}: ${formatPace(workoutInfo.avgPace)}`;
      if (workoutInfo.totalTime > 0) h += ` | Est: ${formatWorkoutTime(workoutInfo.totalTime)}`;
      h += `</div>`;
    }

    // HR target pill (conditional — only rendered if data exists)
    if (w.hrTarget) {
      h += `<div class="text-xs mb-1 px-2 py-1 rounded-full inline-flex items-center gap-1 bg-rose-950/40 border border-rose-800/50 text-rose-300">`;
      h += `<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"/></svg>`;
      h += `<span>${w.hrTarget.label}</span>`;
      h += `</div>`;
    }

    // Rating buttons
    if (!isReplaced) {
      const wId = w.id || w.n;
      h += `<div class="text-xs mb-1 text-gray-400">${rtd ? 'Re-rate RPE:' : 'RPE rating:'}</div><div class="grid grid-cols-10 gap-0.5">`;
      for (let r = 1; r <= 10; r++) {
        h += `<button onclick="window.rate('${wId.replace(/'/g, "\\'")}','${w.n.replace(/'/g, "\\'")}',${r},${w.rpe || w.r},'${w.t}',${isSkipped})" class="px-0.5 py-0.5 text-xs border border-gray-600 rounded hover:bg-gray-600 text-gray-300 bg-gray-700">${r}</button>`;
      }
      h += `</div>`;
    }

    // Track Run / inline GPS tracking (hide for cross-training/sport workouts)
    if (!isReplaced && w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest') {
      const tracking = isTrackingActive();
      if (tracking && getActiveWorkoutName() === w.n) {
        // This workout is being tracked — show inline GPS
        const gpsData = getActiveGpsData();
        if (gpsData) {
          h += renderInlineGpsHtml(gpsData);
        }
      } else if (tracking) {
        // Another workout is being tracked — disable button
        h += `<button class="w-full mt-1 text-xs bg-gray-700 text-gray-500 py-0.5 rounded font-medium cursor-not-allowed" disabled>Tracking in progress...</button>`;
      } else {
        h += `<button class="gps-track-btn w-full mt-1 text-xs bg-green-600 hover:bg-green-700 text-white py-1.5 rounded font-bold" data-name="${escapeAttr(w.n)}" data-desc="${escapeAttr(w.d)}">Start Run</button>`;
      }
    }

    // Skip button
    const skipId = w.id || w.n;
    h += `<button onclick="window.skip('${skipId.replace(/'/g, "\\'")}','${w.n.replace(/'/g, "\\'")}','${w.t}',${isSkipped},${w.skipCount || 0},'${w.d.replace(/'/g, "\\'")}',${w.rpe || w.r},${w.dayOfWeek},'${w.dayName || ''}')" class="w-full mt-1 text-xs ${isSkipped ? 'bg-red-900/50 hover:bg-red-800/50 text-red-300' : isReplaced ? 'bg-cyan-900/50 cursor-not-allowed text-cyan-400' : 'bg-gray-700 hover:bg-gray-600 text-gray-400'} py-0.5 rounded" ${isReplaced ? 'disabled' : ''}>${isSkipped ? 'Skip Again' : isReplaced ? 'Covered' : 'Skip'}</button>`;

    h += `</div>`;
  }

  h += `</div>`;

  // Past GPS recordings section
  h += `<div id="gps-recordings-section" class="mt-3"></div>`;

  return h;
}

/**
 * Render cross-training form
 */
function renderCrossTrainingForm(): string {
  let h = `<div id="crossForm" class="mt-3 p-3 bg-gray-800 rounded border border-gray-700">`;
  h += `<div class="font-bold text-sm mb-2 text-gray-200">Cross-Training & Extra Activities</div>`;
  h += `<div class="grid grid-cols-3 gap-1 mb-2">`;
  h += `<select id="crossSport" class="text-xs bg-gray-700 border border-gray-600 rounded px-1 py-1 text-gray-200">`;
  h += `<option value="">Select sport...</option>`;
  h += `<option value="generic_sport">Generic Sport</option>`;
  for (const key of Object.keys(SPORTS_DB)) {
    if (key === 'generic_sport' || key === 'hybrid_test_sport') continue;
    h += `<option value="${key}">${SPORT_LABELS[key as keyof typeof SPORT_LABELS] || key}</option>`;
  }
  h += `</select>`;
  h += `<input type="number" id="crossDur" placeholder="Duration (min)" class="text-xs bg-gray-700 border border-gray-600 rounded px-1 py-1 text-gray-200" min="1" max="600">`;
  h += `<div class="relative"><input type="number" id="crossRPE" placeholder="RPE (1-10)" class="text-xs bg-gray-700 border border-gray-600 rounded px-1 py-1 text-gray-200 w-full" min="1" max="10">`;
  h += `<span class="rpe-help absolute right-1 top-1 text-gray-500 hover:text-emerald-400 cursor-help text-xs" title="1-3: Easy conversation\n4-6: Short sentences\n7-8: 1-2 words\n9-10: Gasping/Max">(?)</span></div>`;
  h += `</div>`;
  h += `<div class="grid grid-cols-2 gap-1 mb-2">`;
  h += `<input type="number" id="crossAerobic" placeholder="Aerobic Load (optional)" class="text-xs bg-gray-700 border border-gray-600 rounded px-1 py-1 text-gray-200" min="0">`;
  h += `<input type="number" id="crossAnaerobic" placeholder="Anaerobic Load (optional)" class="text-xs bg-gray-700 border border-gray-600 rounded px-1 py-1 text-gray-200" min="0">`;
  h += `</div>`;
  h += `<button onclick="window.logActivity()" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-1.5 rounded text-xs font-bold">Add Activity</button>`;
  h += `</div>`;
  // Disable RPE for rest/recovery activities
  h += `<script>
    (function() {
      var sel = document.getElementById('crossSport');
      var rpe = document.getElementById('crossRPE');
      if (sel && rpe) {
        sel.addEventListener('change', function() {
          var v = sel.value.toLowerCase();
          var isRest = (v === 'rest' || v === 'physio' || v === 'stretch' || v === 'massage');
          rpe.disabled = isRest;
          if (isRest) { rpe.value = '1'; rpe.style.opacity = '0.5'; }
          else { rpe.style.opacity = '1'; }
        });
      }
    })();
  </script>`;
  return h;
}

function isHardWorkoutType(workoutType: string): boolean {
  return ['threshold', 'vo2', 'race_pace', 'marathon_pace', 'intervals', 'long', 'mixed', 'progressive'].includes(workoutType);
}

/** Get color classes for a workout type: { bg, border, accent } */
function getWorkoutColors(wt: string): { bg: string; border: string; accent: string } {
  switch (wt) {
    case 'easy':
      return { bg: 'bg-emerald-950/50', border: 'border-emerald-700', accent: 'text-emerald-400' };
    case 'long':
      return { bg: 'bg-blue-950/50', border: 'border-blue-700', accent: 'text-blue-400' };
    case 'threshold':
    case 'marathon_pace':
      return { bg: 'bg-purple-950/50', border: 'border-purple-700', accent: 'text-purple-400' };
    case 'vo2':
    case 'intervals':
      return { bg: 'bg-red-950/50', border: 'border-red-700', accent: 'text-red-400' };
    case 'race_pace':
      return { bg: 'bg-orange-950/50', border: 'border-orange-700', accent: 'text-orange-400' };
    case 'mixed':
    case 'progressive':
      return { bg: 'bg-amber-950/50', border: 'border-amber-700', accent: 'text-amber-400' };
    case 'cross':
    case 'strength':
    case 'rest':
    case 'test_run':
      return { bg: 'bg-gray-950', border: 'border-gray-600', accent: 'text-gray-400' };
    default:
      return { bg: 'bg-gray-800', border: 'border-gray-700', accent: 'text-gray-400' };
  }
}

/**
 * Set up listener for sync-activity custom events.
 * Call once after initial render. Matches incoming activities against the plan.
 */
let syncListenerAttached = false;
export function setupSyncListener(): void {
  if (syncListenerAttached) return;
  syncListenerAttached = true;

  window.addEventListener('sync-activity', ((e: CustomEvent<ExternalActivity>) => {
    const activity = e.detail;
    const s = getState();
    const wk = s.wks?.[s.w - 1];
    if (!wk) return;

    // Generate current workouts to match against
    const wos = generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig, null, s.recurringActivities,
      undefined, undefined, undefined, s.w, s.tw, s.v
    );

    // Filter out already-rated workouts
    const unrated = wos.filter(w => !(w.id ? wk.rated[w.id] : wk.rated[w.n]));
    const match = findMatchingWorkout(activity, unrated);
    if (!match) return;

    const matchedWorkout = unrated.find(w => w.n === match.workoutName);
    if (!matchedWorkout) return;

    showMatchProposal(activity, matchedWorkout, match, (decision) => {
      if (decision === 'match') {
        // Auto-rate with RPE 5 (moderate)
        if (window.rate) {
          window.rate(matchedWorkout.id || matchedWorkout.n, matchedWorkout.n, 5, matchedWorkout.rpe || matchedWorkout.r || 5, matchedWorkout.t, false);
        }
      } else if (decision === 'keep-both') {
        // Log as separate cross-training — dispatch back as unmatched
        window.dispatchEvent(new CustomEvent('sync-activity-unmatched', { detail: activity }));
      }
      // 'ignore' → do nothing
    });
  }) as EventListener);
}

/**
 * Inject actual pace values into workout description tokens.
 * Replaces "@ MP", "@ threshold", "@ 5K", etc. with the user's calculated pace.
 * Also expands progressive/fast-finish formats to show easy pace for the first portion.
 */
function injectPaces(description: string, paces: any): string {
  if (!paces) return description;

  // First, handle progressive/fast-finish format: "Xkm: last Y @ pace"
  // Convert to "Xkm: first Z @ easy (pace) + last Y @ pace (pace)"
  const progressiveMatch = description.match(/^(\d+\.?\d*)km:\s*last\s+(\d+\.?\d*)\s*@\s*(.+)$/i);
  if (progressiveMatch && paces.e) {
    const totalKm = parseFloat(progressiveMatch[1]);
    const fastKm = parseFloat(progressiveMatch[2]);
    const fastPaceToken = progressiveMatch[3].trim();
    const easyKm = totalKm - fastKm;

    if (easyKm > 0) {
      // Resolve the fast pace token
      let fastPace = '';
      const tokenLower = fastPaceToken.toLowerCase();
      if (tokenLower === 'mp' && paces.m) fastPace = formatPace(paces.m);
      else if ((tokenLower === 'threshold' || tokenLower === 'tempo') && paces.t) fastPace = formatPace(paces.t);
      else if (tokenLower === '5k' && paces.i) fastPace = formatPace(paces.i);
      else if (tokenLower === '10k' && paces.t) fastPace = formatPace(paces.t);
      else if (tokenLower === 'hm' && paces.m && paces.t) fastPace = formatPace((paces.m + paces.t) / 2);
      else if (tokenLower === 'vo2' && paces.i) fastPace = formatPace(paces.i);

      const easyPace = formatPace(paces.e);
      const fastLabel = fastPace ? `@ ${fastPace}` : `@ ${fastPaceToken}`;

      return `${totalKm}km: ${easyKm} @ easy (${easyPace}) + ${fastKm} ${fastLabel}`;
    }
  }

  // Standard token replacement for other formats
  return description
    .replace(/@ ?MP/g, paces.m ? `@ ${formatPace(paces.m)}` : '@ Marathon Pace')
    .replace(/@ ?threshold/gi, paces.t ? `@ ${formatPace(paces.t)}` : '@ threshold')
    .replace(/@ ?tempo/gi, paces.t ? `@ ${formatPace(paces.t)}` : '@ tempo')
    .replace(/@ ?5K/g, paces.i ? `@ ${formatPace(paces.i)}` : '@ 5K')
    .replace(/@ ?10K/g, paces.t ? `@ ${formatPace(paces.t)}` : '@ 10K')
    .replace(/@ ?HM/g, paces.m && paces.t ? `@ ${formatPace((paces.m + paces.t) / 2)}` : '@ HM')
    .replace(/@ ?VO2/gi, paces.i ? `@ ${formatPace(paces.i)}` : '@ VO2');
}

/** Escape a string for use in an HTML attribute value */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Attach delegated click handler for "Track Run" buttons.
 * Called once after the workouts panel is rendered.
 */
export function attachTrackRunHandlers(): void {
  const handler = (e: Event) => {
    const btn = (e.target as HTMLElement).closest('.gps-track-btn') as HTMLElement | null;
    if (!btn) return;
    const name = btn.dataset.name || '';
    const desc = btn.dataset.desc || '';
    if (window.trackWorkout) {
      window.trackWorkout(name, desc);
    }
  };

  const woEl = document.getElementById('wo');
  if (woEl) woEl.addEventListener('click', handler);

  const jrEl = document.getElementById('just-run-container');
  if (jrEl) jrEl.addEventListener('click', handler);
}
