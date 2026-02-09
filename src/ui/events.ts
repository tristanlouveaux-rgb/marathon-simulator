import type { RaceDistance, SimulatorState, Week, Workout, BenchmarkResult } from '@/types';
import {
  getState, getMutableState, updateState,
  getCrossActivities, addCrossActivity,
  saveState, clearState
} from '@/state';
import {
  cv, rd, rdKm, tv, calculateFatigueExponent, gt, getRunnerType,
  gp, blendPredictions, getExpectedPhysiology,
  initializePhysiologyTracking, recordMeasurement, assessAdaptation
} from '@/calculations';
import { IMP, TIM, EXPECTED_GAINS } from '@/constants';
import { initializeWeeks } from '@/workouts';
import { createActivity, getWeeklyLoad, normalizeSport, buildCrossTrainingPopup, workoutsToPlannedRuns, applyAdjustments } from '@/cross-training';
import { generateWeekWorkouts, calculateWorkoutLoad } from '@/workouts';
import { render, log } from './renderer';
import { showSuggestionModal } from './suggestion-modal';
import { ft, fp } from '@/utils';
import { calculateLiveForecast } from '@/calculations/predictions';


// Drag and drop state
let draggedWorkout: string | null = null;

// Callback for full re-render after week advance (set by main-view to avoid circular import)
let onWeekAdvanceCb: (() => void) | null = null;

/** Register a callback invoked after the week advances. */
export function setOnWeekAdvance(cb: () => void): void {
  onWeekAdvanceCb = cb;
}

/**
 * Handle recent run type change
 */
export function handleRecentRunChange(): void {
  const rtSelect = document.getElementById('rt') as HTMLSelectElement;
  const val = rtSelect?.value;
  const rtdDiv = document.getElementById('rtd');
  const rtdShort = document.getElementById('rtdShort');
  const rtdLong = document.getElementById('rtdLong');

  if (rtdDiv) {
    rtdDiv.classList.toggle('hidden', !val);
  }
  if (val) {
    const isLong = val === '21.1' || val === '42.2';
    rtdShort?.classList.toggle('hidden', isLong);
    rtdLong?.classList.toggle('hidden', !isLong);
  }
}

/**
 * Initialize training plan
 */
export function init(): void {
  const s = getMutableState();

  // Clear old cross-training activities
  const crossActivities = getCrossActivities();
  crossActivities.length = 0;

  // Collect PBs
  const p: { k5?: number; k10?: number; h?: number; m?: number } = {};
  const p5m = +(document.getElementById('p5m') as HTMLInputElement)?.value || 0;
  const p5s = +(document.getElementById('p5s') as HTMLInputElement)?.value || 0;
  if (p5m || p5s) p.k5 = p5m * 60 + p5s;

  const p10m = +(document.getElementById('p10m') as HTMLInputElement)?.value || 0;
  const p10s = +(document.getElementById('p10s') as HTMLInputElement)?.value || 0;
  if (p10m || p10s) p.k10 = p10m * 60 + p10s;

  const phh = +(document.getElementById('phh') as HTMLInputElement)?.value || 0;
  const phm = +(document.getElementById('phm') as HTMLInputElement)?.value || 0;
  const phs = +(document.getElementById('phs') as HTMLInputElement)?.value || 0;
  if (phh || phm || phs) p.h = phh * 3600 + phm * 60 + phs;

  const pmh = +(document.getElementById('pmh') as HTMLInputElement)?.value || 0;
  const pmm = +(document.getElementById('pmm') as HTMLInputElement)?.value || 0;
  const pms = +(document.getElementById('pms') as HTMLInputElement)?.value || 0;
  if (pmh || pmm || pms) p.m = pmh * 3600 + pmm * 60 + pms;

  if (!Object.keys(p).length) {
    alert('Enter 1+ PB!');
    return;
  }

  // Validate PBs (prevent seconds-as-minutes entry)
  // World Records: 5k ~12:35, 10k ~26:11, HM ~57:30, M ~2:00:35
  if (p.k5 && p.k5 < 750) { // < 12:30
    alert('5k PB is too fast (World Record is ~12:35). Did you enter seconds instead of minutes?');
    return;
  }
  if (p.k10 && p.k10 < 1560) { // < 26:00
    alert('10k PB is too fast (World Record is ~26:11). Did you enter seconds instead of minutes?');
    return;
  }
  if (p.h && p.h < 3480) { // < 58:00
    alert('Half Marathon PB is too fast (World Record is ~57:31). Did you enter seconds instead of minutes?');
    return;
  }
  if (p.m && p.m < 7200) { // < 2:00:00
    alert('Marathon PB is too fast (World Record is ~2:00:35). Did you enter seconds instead of minutes?');
    return;
  }

  // Recent run
  const rv = (document.getElementById('rt') as HTMLSelectElement)?.value;
  let rec = null;
  if (rv) {
    const isLong = rv === '21.1' || rv === '42.2';
    let rtime = 0;
    if (isLong) {
      const rh = +(document.getElementById('rh') as HTMLInputElement)?.value || 0;
      const rm2 = +(document.getElementById('rm2') as HTMLInputElement)?.value || 0;
      const rs2 = +(document.getElementById('rs2') as HTMLInputElement)?.value || 0;
      rtime = rh * 3600 + rm2 * 60 + rs2;
    } else {
      const rm = +(document.getElementById('rm') as HTMLInputElement)?.value || 0;
      const rs = +(document.getElementById('rs') as HTMLInputElement)?.value || 0;
      rtime = rm * 60 + rs;
    }
    if (rtime > 0) {
      const weeksAgo = +(document.getElementById('rweeks') as HTMLInputElement)?.value || 0;
      rec = { d: +rv, t: rtime, weeksAgo };
    }
  }

  // LT and VO2
  const ltm = +(document.getElementById('ltm') as HTMLInputElement)?.value || 0;
  const lts = +(document.getElementById('lts') as HTMLInputElement)?.value || 0;
  const ltTotalSec = (ltm || lts) ? ltm * 60 + lts : null;
  const vo2 = +(document.getElementById('vo2') as HTMLInputElement)?.value || null;

  // Calculate fatigue exponent and runner type
  const b = calculateFatigueExponent(p);
  const typ = gt(b);

  // Get target race
  const targetDist = rd((document.getElementById('rd') as HTMLSelectElement)?.value || 'half');

  // 3-predictor blend
  const blendedTime = blendPredictions(targetDist, p, ltTotalSec, vo2, b, typ, rec);

  if (!blendedTime || isNaN(blendedTime) || blendedTime <= 0) {
    alert('Error calculating race prediction. Check your inputs and try again.');
    return;
  }

  // Convert to VDOT
  const curr = cv(targetDist, blendedTime);
  const pac = gp(curr, ltTotalSec);

  // Update state
  s.w = 1;
  s.tw = +(document.getElementById('tw') as HTMLInputElement)?.value || 16;
  s.v = curr;
  s.iv = curr;
  s.rpeAdj = 0;
  s.rd = (document.getElementById('rd') as HTMLSelectElement)?.value as RaceDistance || 'half';
  s.epw = +(document.getElementById('epw') as HTMLSelectElement)?.value || 5;
  s.rw = Math.min(s.epw, 7);
  s.wkm = s.rw <= 3 ? s.rw * 10 : s.rw === 4 ? 40 : s.rw === 5 ? 50 : s.rw === 6 ? 60 : 70;
  s.pbs = p;
  s.rec = rec;
  s.lt = ltTotalSec;
  s.ltPace = ltTotalSec;
  s.vo2 = vo2;
  s.typ = typ.charAt(0).toUpperCase() + typ.slice(1) as any;
  s.b = b;
  s.pac = pac;
  s.wks = initializeWeeks(s.tw);
  s.skip = [];
  s.timp = 0;

  // Read commute config from setup form (before prediction so volume is accounted for)
  const commuteEnabled = (document.getElementById('commuteEnabled') as HTMLInputElement)?.checked;
  if (commuteEnabled) {
    const commuteDistance = +(document.getElementById('commuteDistance') as HTMLInputElement)?.value || 5;
    const commuteBidirectional = (document.getElementById('commuteBidirectional') as HTMLInputElement)?.checked;
    const commuteDays = +(document.getElementById('commuteDays') as HTMLInputElement)?.value || 5;
    s.commuteConfig = {
      enabled: true,
      distanceKm: commuteDistance,
      isBidirectional: commuteBidirectional,
      commuteDaysPerWeek: Math.min(Math.max(commuteDays, 1), 5),
    };
    // Add commute volume to weekly km
    const commuteKmPerDay = commuteBidirectional ? commuteDistance * 2 : commuteDistance;
    s.wkm += commuteKmPerDay * s.commuteConfig.commuteDaysPerWeek;
  } else {
    s.commuteConfig = undefined;
  }

  // Store initial physiology
  s.initialLT = ltTotalSec;
  s.initialVO2 = vo2;
  s.initialBaseline = blendedTime;
  s.currentFitness = blendedTime;

  // Calculate expected final via centralized forecast model
  const { forecastVdot, forecastTime } = calculateLiveForecast({
    currentVdot: s.v,
    targetDistance: s.rd,
    weeksRemaining: s.tw,
    sessionsPerWeek: s.epw,
    runnerType: s.typ as any,
    experienceLevel: s.onboarding?.experienceLevel || 'intermediate',
  });
  s.expectedFinal = forecastVdot;
  s.forecastTime = forecastTime;

  // Show UI panels
  document.getElementById('ctrl')?.classList.remove('hidden');
  document.getElementById('pb')?.classList.remove('hidden');
  document.getElementById('lb')?.classList.remove('hidden');
  document.getElementById('prof')?.classList.remove('hidden');
  document.getElementById('curfit')?.classList.remove('hidden');

  const typeEl = document.getElementById('type');
  if (typeEl) typeEl.textContent = s.typ;
  const bvalEl = document.getElementById('bval');
  if (bvalEl) bvalEl.textContent = s.b.toFixed(3);
  const vvalEl = document.getElementById('vval');
  if (vvalEl) vvalEl.textContent = s.v.toFixed(1);
  const expecEl = document.getElementById('expec');
  if (expecEl) expecEl.textContent = s.expectedFinal.toFixed(1);
  const twnEl = document.getElementById('twn');
  if (twnEl) twnEl.textContent = String(s.tw);

  // Populate current physiology inputs
  if (ltTotalSec) {
    const curltm = document.getElementById('curltm') as HTMLInputElement;
    const curlts = document.getElementById('curlts') as HTMLInputElement;
    if (curltm) curltm.value = String(Math.floor(ltTotalSec / 60));
    if (curlts) curlts.value = String(ltTotalSec % 60);
  }
  if (vo2) {
    const curvo2 = document.getElementById('curvo2') as HTMLInputElement;
    if (curvo2) curvo2.value = String(vo2);
  }

  log(`Init: ${s.typ}, Start ${curr.toFixed(1)}, Expected ${s.expectedFinal.toFixed(1)} (+${(forecastVdot - s.v).toFixed(2)})`);
  saveState();
  render();
}

/**
 * Rate a workout
 * @param workoutId - Stable workout ID (e.g., "W1-easy-0")
 * @param name - Display name for logging
 */
export function rate(workoutId: string, name: string, rpe: number, expected: number, workoutType: string, isSkipped: boolean): void {
  const s = getMutableState();
  if (s.w < 1 || s.w > s.wks.length) return;
  const wk = s.wks[s.w - 1];

  // If skipped workout being completed, remove from previous week
  if (isSkipped && s.w > 1) {
    const pw = s.wks[s.w - 2];
    if (pw) {
      pw.skip = pw.skip.filter(x => x.workout.id !== workoutId);
      log(`${name} completed (was skipped from previous week)`);
    }
  }

  // Remove old adjustment if re-rating
  const oldRPE = wk.ratedChanges?.[workoutId];
  if (oldRPE !== undefined) s.rpeAdj -= oldRPE;

  wk.rated[workoutId] = rpe;
  const dif = rpe - expected;
  let ch = 0;
  if (dif <= -3) ch = 0.15;
  else if (dif <= -2) ch = 0.08;
  else if (dif >= 3) ch = -0.15;
  else if (dif >= 2) ch = -0.08;

  const imp = IMP[s.rd]?.[workoutType as keyof typeof IMP[typeof s.rd]] || 0.5;
  const wch = ch * imp;

  if (!wk.ratedChanges) wk.ratedChanges = {};
  wk.ratedChanges[workoutId] = wch;
  s.rpeAdj += wch;

  log(Math.abs(dif) <= 1 ? `${name} RPE${rpe}` : `${ch > 0 ? 'Strong' : 'Hard'} ${name}: ${wch >= 0 ? '+' : ''}${wch.toFixed(2)}`);

  // Update paces and predictions
  let wg = 0;
  for (let i = 0; i < s.w - 1; i++) wg += s.wks[i].wkGain;
  const currentVDOT = s.v + wg + s.rpeAdj;
  s.pac = gp(currentVDOT, s.lt);

  // Update Current prediction (what you'd race today)
  const raceDistKm = rdKm(s.rd);
  s.currentFitness = tv(currentVDOT, raceDistKm);

  // Update Forecast (end-of-plan projection)
  const totalExpectedGain = s.expectedFinal - s.iv;
  const weeksCompleted = s.w - 1;
  const remainingGain = totalExpectedGain > 0
    ? totalExpectedGain * ((s.tw - weeksCompleted) / s.tw)
    : 0;
  s.forecastTime = tv(currentVDOT + remainingGain, raceDistKm);

  saveState();
  render();
}

/**
 * Skip a workout
 * @param workoutId - Stable workout ID (e.g., "W1-easy-0")
 * @param name - Display name for logging
 */
export function skip(
  workoutId: string,
  name: string,
  workoutType: string,
  isAlreadySkipped: boolean,
  currentSkipCount: number,
  desc: string,
  rpe: number,
  dayOfWeek: number,
  dayName: string
): void {
  const s = getMutableState();
  const wk = s.wks[s.w - 1];

  // Warn before skipping a long run
  if (workoutType === 'long' && !isAlreadySkipped) {
    showLongRunSkipWarning().then(proceed => {
      if (proceed) skipInner(workoutId, name, workoutType, isAlreadySkipped, currentSkipCount, desc, rpe, dayOfWeek, dayName);
    });
    return;
  }

  skipInner(workoutId, name, workoutType, isAlreadySkipped, currentSkipCount, desc, rpe, dayOfWeek, dayName);
}

function skipInner(
  workoutId: string, name: string, workoutType: string, isAlreadySkipped: boolean,
  currentSkipCount: number, desc: string, rpe: number,
  dayOfWeek: number, dayName: string
): void {
  const s = getMutableState();
  const wk = s.wks[s.w - 1];

  if (isAlreadySkipped) {
    // Second skip - apply penalty
    let totalSkips = 0;
    for (let i = 0; i < s.w; i++) {
      if (s.wks[i].rated) {
        totalSkips += Object.values(s.wks[i].rated).filter(v => v === 'skip').length;
      }
    }

    const weeksRemaining = s.tw - s.w + 1;
    const basePenalty = TIM[s.rd]?.[workoutType as keyof typeof TIM[typeof s.rd]] || 20;
    const penalty = Math.round(basePenalty * 1.5);
    s.timp += penalty;

    // Remove from previous week's skip list
    if (s.w > 1) {
      const pw = s.wks[s.w - 2];
      if (pw) pw.skip = pw.skip.filter(x => x.workout.id !== workoutId);
    }

    wk.rated[workoutId] = 'skip';
    log(`${name} skipped AGAIN: +${penalty}s penalty`);
  } else {
    // First skip - move to next week
    if (wk.rated[workoutId]) delete wk.rated[workoutId];
    wk.rated[workoutId] = 'skip';

    wk.skip.push({
      n: name,
      t: workoutType,
      workout: {
        id: workoutId,
        n: name,
        t: workoutType,
        d: desc || '',
        rpe: rpe || 5,
        r: rpe || 5,
        dayOfWeek: dayOfWeek !== undefined ? dayOfWeek : undefined,
        dayName: dayName || undefined
      },
      skipCount: 1
    });

    log(`${name} skipped (moved to ${dayName || 'next week'}, no penalty)`);
  }

  saveState();
  render();
}

/**
 * Move to next week
 *
 * INJURY PAUSE LOGIC: If injury is active, we freeze the plan pointer
 * and increment rehabWeeksDone instead of advancing the training week.
 */
export async function next(): Promise<void> {
  const s = getMutableState();
  if (s.w < 1 || s.w > s.wks.length) return;
  const wk = s.wks[s.w - 1];

  // Completion gating: check for unrated run workouts
  const ratedCount = Object.keys(wk.rated).length;
  // Use actual run workout count from the current week's generated workouts
  const runWorkoutCount = s.rw || 3;
  // Only count run workouts as required (not cross-training, commute, or strength)
  if (ratedCount < runWorkoutCount) {
    const incomplete = runWorkoutCount - ratedCount;
    const proceed = await showCompletionModal(incomplete);
    if (!proceed) return;
  }

  // Check for active injury - save history but freeze plan pointer
  const injuryState = (s as any).injuryState;
  if (injuryState && injuryState.active) {
    // INJURY PAUSE: Run history saving but do NOT increment s.w
    s.rehabWeeksDone = (s.rehabWeeksDone || 0) + 1;

    // Save week history (user feels "Week Done")
    wk.wkGain = 0; // No VDOT gain during injury
    wk.injuryState = { ...injuryState }; // Snapshot injury state
    // Reset ratings for the frozen week so next rehab week starts clean
    wk.rated = {};
    wk.ratedChanges = {};

    // Freeze: s.w stays the same
    const frozenWeek = s.w;
    s.w = frozenWeek; // Explicitly keep week frozen

    log(`Rehab Week ${s.rehabWeeksDone} completed (Plan frozen at Week ${s.w})`);

    saveState();
    if (onWeekAdvanceCb) onWeekAdvanceCb(); else render();
    return;
  }

  // Normal progression (no injury)
  // Calculate per-week VDOT gain from training horizon model instead of flat 0.06
  const totalExpectedVdotGain = (s.expectedFinal || s.iv) - s.iv;
  const perWeekGain = s.tw > 0 ? totalExpectedVdotGain / s.tw : 0;
  // Apply adherence modifier: scale by what fraction of workouts were completed
  const ratedNames = Object.keys(wk.rated);
  const completedCount = ratedNames.filter(n => wk.rated[n] !== 'skip').length;
  const expectedCount = s.rw || 3;
  const adherence = expectedCount > 0 ? Math.min(completedCount / expectedCount, 1) : 1;
  wk.wkGain = Math.max(0, perWeekGain * adherence);
  log(`Week ${s.w}: +${wk.wkGain.toFixed(3)} VDOT (${Math.round(adherence * 100)}% adherence)`);
  s.w++;

  if (s.w > s.tw) {
    // Continuous mode: append a new 4-week block instead of completing
    if (s.continuousMode) {
      const BLOCK_SIZE = 4;
      s.blockNumber = (s.blockNumber || 1) + 1;

      // Append 4 weeks: Base → Build → Intensify → Deload (evidence-backed mesocycle)
      // Map to existing phase types:
      // base = Base week, build = Build week, peak = Intensify week, taper = Deload week
      const blockPhases: Array<import('@/types').TrainingPhase> = ['base', 'build', 'peak', 'taper'];
      for (let i = 0; i < BLOCK_SIZE; i++) {
        s.wks.push({
          w: s.tw + i + 1,
          ph: blockPhases[i],
          rated: {},
          skip: [],
          cross: [],
          wkGain: 0,
          workoutMods: [],
          adjustments: [],
          unspentLoad: 0,
          extraRunLoad: 0,
        });
      }
      s.tw += BLOCK_SIZE;
      log(`Block ${s.blockNumber} started (Weeks ${s.tw - BLOCK_SIZE + 1}–${s.tw})`);
    } else {
      complete();
      return;
    }
  }

  saveState();
  if (onWeekAdvanceCb) onWeekAdvanceCb(); else render();
}

/**
 * Complete training plan
 */
function complete(): void {
  const s = getState();
  let wg = 0;
  for (let i = 0; i < s.tw; i++) wg += s.wks[i].wkGain;

  const fv = s.v + wg + s.rpeAdj;
  const dk = rdKm(s.rd);
  let fin = tv(fv, dk);
  if (s.timp > 0) fin += s.timp;

  let h = `<div class="text-center py-10"><h2 class="text-2xl font-bold mb-4 text-white">Training Complete</h2>`;
  h += `<div class="bg-emerald-700 text-white p-6 rounded-lg inline-block mb-4"><div class="text-xs mb-2">Final</div>`;
  h += `<div class="text-4xl font-bold">${ft(fin)}</div></div>`;
  h += `<div class="grid grid-cols-3 gap-3 max-w-md mx-auto text-sm">`;
  h += `<div class="bg-gray-800 p-3 rounded border border-gray-700"><div class="text-xs text-gray-400">Start</div><div class="text-xl font-bold text-white">${s.v.toFixed(1)}</div></div>`;
  h += `<div class="bg-emerald-950/30 p-3 rounded border border-emerald-800"><div class="text-xs text-gray-400">Final</div><div class="text-xl font-bold text-emerald-400">${fv.toFixed(1)}</div></div>`;
  h += `<div class="bg-gray-800 p-3 rounded border border-gray-700"><div class="text-xs text-gray-400">Expected</div><div class="text-xl font-bold text-white">${s.expectedFinal.toFixed(1)}</div></div></div></div>`;

  const woEl = document.getElementById('wo');
  if (woEl) woEl.innerHTML = h;
}

/**
 * Reset training plan
 */
export function reset(): void {
  showResetModal().then(proceed => {
    if (proceed) {
      clearState();
      location.reload();
    }
  });
}

function showResetModal(): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
    overlay.innerHTML = `
      <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-6">
        <h3 class="text-white font-semibold text-lg mb-2">Reset All Data?</h3>
        <p class="text-gray-400 text-sm mb-5">
          This will clear your entire training plan, history, and settings. This cannot be undone.
        </p>
        <div class="flex flex-col gap-2">
          <button id="btn-confirm-reset" class="w-full py-2.5 bg-red-600 hover:bg-red-500 text-white font-medium rounded-lg transition-colors text-sm">
            Reset Everything
          </button>
          <button id="btn-cancel-reset" class="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg transition-colors text-sm">
            Cancel
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#btn-confirm-reset')?.addEventListener('click', () => {
      overlay.remove();
      resolve(true);
    });
    overlay.querySelector('#btn-cancel-reset')?.addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });
  });
}

/**
 * Show a styled completion modal instead of native confirm().
 */
function showCompletionModal(incompleteCount: number): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
    overlay.innerHTML = `
      <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-6">
        <h3 class="text-white font-semibold text-lg mb-2">Incomplete Workouts</h3>
        <p class="text-gray-400 text-sm mb-5">
          You have <span class="text-white font-medium">${incompleteCount}</span> workout${incompleteCount > 1 ? 's' : ''} not yet completed.
          They'll be marked as skipped and may carry forward to next week.
        </p>
        <div class="flex flex-col gap-2">
          <button id="btn-skip-continue" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors text-sm">
            Skip & Continue
          </button>
          <button id="btn-go-back" class="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg transition-colors text-sm">
            Go Back
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#btn-skip-continue')?.addEventListener('click', () => {
      overlay.remove();
      resolve(true);
    });
    overlay.querySelector('#btn-go-back')?.addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });
  });
}

/**
 * Show a choice modal when a logged sport has a planned slot but duration
 * is outside 40% range and a generic slot is also available.
 */
function showSlotChoiceModal(
  slotName: string,
  plannedDur: number,
  loggedDur: number,
  sportName: string
): Promise<'sport' | 'generic'> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
    overlay.innerHTML = `
      <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-6">
        <h3 class="text-white font-semibold text-lg mb-2">Match Activity</h3>
        <p class="text-gray-400 text-sm mb-5">
          You logged <span class="text-white font-medium">${loggedDur}min ${sportName}</span>
          but your planned ${slotName} is <span class="text-white font-medium">${plannedDur}min</span>.
          Which slot should this fill?
        </p>
        <div class="flex flex-col gap-2">
          <button id="btn-match-sport" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors text-sm">
            Replace planned ${slotName}
          </button>
          <button id="btn-match-generic" class="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg transition-colors text-sm">
            Fill a Generic Sport slot instead
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#btn-match-sport')?.addEventListener('click', () => {
      overlay.remove();
      resolve('sport');
    });
    overlay.querySelector('#btn-match-generic')?.addEventListener('click', () => {
      overlay.remove();
      resolve('generic');
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve('sport'); }
    });
  });
}

/**
 * Show a styled warning modal before skipping a long run.
 */
function showLongRunSkipWarning(): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
    overlay.innerHTML = `
      <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-6">
        <h3 class="text-white font-semibold text-lg mb-2">Skip Long Run?</h3>
        <p class="text-gray-400 text-sm mb-5">
          Skipping a Long Run creates a "Super Week" next week with high injury risk.
          Consider shortening the run instead.
        </p>
        <div class="flex flex-col gap-2">
          <button id="btn-skip-longrun" class="w-full py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg transition-colors text-sm">
            Skip Anyway
          </button>
          <button id="btn-keep-longrun" class="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg transition-colors text-sm">
            Keep It
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#btn-skip-longrun')?.addEventListener('click', () => {
      overlay.remove();
      resolve(true);
    });
    overlay.querySelector('#btn-keep-longrun')?.addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });
  });
}

/**
 * Navigate back to the assessment step to edit settings.
 * Preserves all state — only changes the wizard step pointer.
 */
export function editSettings(): void {
  const s = getMutableState();
  if (s.onboarding) {
    s.onboarding.currentStep = 'assessment';
  }
  saveState();
  location.reload();
}

/**
 * Update fitness from physiology inputs
 * Uses physiology-tracker module for comparing expected vs observed values
 * and computing adaptation ratio.
 */
export function updateFitness(): void {
  const s = getMutableState();
  if (!s.wks.length) {
    alert('Initialize plan first!');
    return;
  }

  const curLTm = +(document.getElementById('curltm') as HTMLInputElement)?.value || 0;
  const curLTs = +(document.getElementById('curlts') as HTMLInputElement)?.value || 0;
  const curVO2 = +(document.getElementById('curvo2') as HTMLInputElement)?.value || 0;

  if (!curLTm && !curLTs && !curVO2) {
    alert('Enter at least one current physiology value (LT or VO2)');
    return;
  }

  const newLT = (curLTm || curLTs) ? curLTm * 60 + curLTs : null;
  const newVO2val = curVO2 || null;

  // Initialize physiology tracking state if needed
  let trackingState = s.physiologyTracking
    ? {
      initialLT: s.initialLT,
      initialVO2: s.initialVO2,
      baselineVdot: s.v,
      measurements: s.physiologyTracking.measurements || [],
      currentAdaptationRatio: s.adaptationRatio || 1.0,
      lastAssessment: null,
    }
    : initializePhysiologyTracking(s.initialLT, s.initialVO2, s.v);

  // Record new measurement
  const measurement = {
    week: s.w,
    ltPaceSecKm: newLT,
    vo2max: newVO2val,
    source: 'manual' as const,
    timestamp: new Date().toISOString(),
  };

  trackingState = recordMeasurement(trackingState, measurement);

  // Get assessment
  const assessment = assessAdaptation(trackingState, s.w);

  // Update state with new values
  if (newLT) s.lt = newLT;
  if (newVO2val) s.vo2 = newVO2val;
  s.adaptationRatio = trackingState.currentAdaptationRatio;

  // Store tracking state
  s.physiologyTracking = {
    measurements: trackingState.measurements,
    lastAssessmentStatus: assessment.status,
    lastAssessmentMessage: assessment.message,
  };

  // Build status messages for display
  const statusMessages: string[] = [];

  // Add deviation info if available
  if (assessment.hasSufficientData) {
    if (assessment.ltAdaptationRatio !== null) {
      const ltPct = (assessment.ltAdaptationRatio - 1) * 100;
      if (Math.abs(ltPct) > 1.5) {
        statusMessages.push(`LT: ${ltPct > 0 ? '+' : ''}${ltPct.toFixed(1)}% vs expected`);
      } else {
        statusMessages.push('LT: On track');
      }
    }
    if (assessment.vo2AdaptationRatio !== null) {
      const vo2Pct = (assessment.vo2AdaptationRatio - 1) * 100;
      if (Math.abs(vo2Pct) > 1.5) {
        statusMessages.push(`VO2: ${vo2Pct > 0 ? '+' : ''}${vo2Pct.toFixed(1)}% vs expected`);
      } else {
        statusMessages.push('VO2: On track');
      }
    }
    statusMessages.push(`Adaptation: ${s.adaptationRatio.toFixed(2)}x`);
    statusMessages.push(assessment.message);
  } else {
    statusMessages.push(assessment.message);
  }

  // Update paces with new physiology
  let wg = 0;
  for (let i = 0; i < s.w - 1; i++) wg += s.wks[i].wkGain;
  s.pac = gp(s.v + wg + s.rpeAdj, newLT);

  // Display status with color based on assessment status
  const statusEl = document.getElementById('fitStatus');
  const statusTextEl = document.getElementById('fitStatusText');
  if (statusEl && statusTextEl) {
    statusEl.classList.remove('hidden');
    const colorMap: Record<string, string> = {
      excellent: 'bg-emerald-950/30 border border-emerald-800 text-emerald-300',
      good: 'bg-emerald-950/30 border border-emerald-800 text-emerald-300',
      onTrack: 'bg-sky-950/30 border border-sky-800 text-sky-300',
      slow: 'bg-amber-950/30 border border-amber-800 text-amber-300',
      concerning: 'bg-red-950/30 border border-red-800 text-red-300',
      needsData: 'bg-gray-800/30 border border-gray-700 text-gray-400',
    };
    const bgColor = colorMap[assessment.status] || colorMap.onTrack;
    statusEl.className = `mt-2 text-xs p-2 rounded ${bgColor}`;
    statusTextEl.innerHTML = statusMessages.join('<br>');
  }

  log(`Fitness Update [Week ${s.w}]:` + statusMessages.map(m => `\n  ${m}`).join(''));
  saveState();
  render();
}

/**
 * Move workout to a different day
 */
export function moveWorkout(workoutName: string, newDay: number): void {
  const s = getMutableState();
  const wk = s.wks[s.w - 1];
  if (!wk) return;

  if (!wk.workoutMoves) wk.workoutMoves = {};
  wk.workoutMoves[workoutName] = newDay;

  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  log(`Moved ${workoutName} to ${dayNames[newDay]}`);
  saveState();
  render();
}

/**
 * Log a cross-training activity
 */
export function logActivity(): void {
  const s = getMutableState();
  if (!s.wks?.length) {
    alert('Initialize plan first!');
    return;
  }

  if (s.w > s.tw) {
    alert('Training plan completed!');
    return;
  }

  const sportSelect = document.getElementById('crossSport') as HTMLSelectElement;
  const durInput = document.getElementById('crossDur') as HTMLInputElement;
  const rpeInput = document.getElementById('crossRPE') as HTMLInputElement;
  const aerobicInput = document.getElementById('crossAerobic') as HTMLInputElement;
  const anaerobicInput = document.getElementById('crossAnaerobic') as HTMLInputElement;

  const sport = sportSelect?.value;
  let dur = +durInput?.value;
  let rpe = +rpeInput?.value;
  const aerobic = aerobicInput ? +aerobicInput.value : 0;
  const anaerobic = anaerobicInput ? +anaerobicInput.value : 0;

  if (!sport) {
    alert('Please select a sport/activity!');
    return;
  }
  if (isNaN(dur) || dur <= 0) {
    alert('Please enter duration!');
    return;
  }
  dur = Math.min(dur, 600);
  // Default RPE to 1 for rest/recovery activities
  const restSports = ['rest', 'physio', 'stretch', 'massage'];
  if (restSports.includes(sport.toLowerCase())) {
    rpe = 1;
  } else if (isNaN(rpe) || rpe < 1 || rpe > 10) {
    alert('Please enter RPE 1-10!');
    return;
  }

  // Determine target week
  const currentWeek = s.wks[s.w - 1];
  const totalWorkouts = s.rw || 3;
  const completedWorkouts = currentWeek ? Object.keys(currentWeek.rated).length : 0;
  const weekComplete = completedWorkouts >= totalWorkouts;
  const activityWeek = (weekComplete && s.w < s.tw) ? s.w + 1 : s.w;

  const activity = createActivity(
    sport,
    dur,
    rpe,
    aerobic > 0 ? aerobic : undefined,
    anaerobic > 0 ? anaerobic : undefined,
    activityWeek
  );

  // Generate current workouts to build suggestions
  const wk = s.wks[activityWeek - 1];
  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig, null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, activityWeek, s.tw, s.v
  );

  // -----------------------------------------------------------------------
  // Cross-training slot matching: pair logged sport with planned slots
  // Priority: 1) matching sport slot, 2) generic sport slot, 3) run suggestions
  // -----------------------------------------------------------------------
  const sportNorm = normalizeSport(sport);

  // Find unfilled planned slots that match this sport (e.g., logged Cycling → planned "Cycling")
  const matchingSlots = workouts.filter(w =>
    w.t === 'cross' &&
    !w.n.startsWith('Generic Sport') &&
    normalizeSport(w.n.replace(/ \d+$/, '')) === sportNorm &&
    !wk.rated[w.n] &&
    !wk.workoutMods?.some(m => m.name === w.n)
  );

  // Find unfilled generic sport slots
  const genericSlots = workouts.filter(w =>
    w.t === 'cross' &&
    w.n.startsWith('Generic Sport') &&
    !wk.rated[w.n] &&
    !wk.workoutMods?.some(m => m.name === w.n)
  );

  // Helper: fill a cross-training slot (records the mod but does NOT return early)
  // Returns the planned duration of the filled slot (0 if unparseable).
  const fillSlot = (slot: typeof workouts[0], reason: string): number => {
    if (!wk.workoutMods) wk.workoutMods = [];
    wk.workoutMods.push({
      name: slot.n,
      dayOfWeek: slot.dayOfWeek,
      status: 'replaced',
      modReason: reason,
      confidence: 'high',
      originalDistance: slot.d,
      newDistance: `${dur}min ${sportNorm}`,
      newType: 'cross',
      newRpe: rpe,
    });
    wk.rated[slot.n] = rpe;

    // Parse planned duration from slot description (e.g., "45min swimming")
    const durMatch = slot.d.match(/(\d+)min/);
    return durMatch ? parseInt(durMatch[1]) : 0;
  };

  // Helper: after filling a slot, handle excess duration or finalise
  const handleSlotFillResult = (plannedDur: number, reason: string) => {
    const excessMin = plannedDur > 0 ? dur - plannedDur : 0;

    // If excess is small (≤10min or ≤20% over), just log and finish
    if (excessMin <= 10 || (plannedDur > 0 && excessMin / plannedDur <= 0.2)) {
      activity.applied = true;
      addCrossActivity(activity);
      sportSelect.value = '';
      durInput.value = '';
      rpeInput.value = '';
      if (aerobicInput) aerobicInput.value = '';
      if (anaerobicInput) anaerobicInput.value = '';
      const wLoad = getWeeklyLoad(getCrossActivities(), s.w);
      log(`${sportNorm}: ${dur}min, RPE${rpe}, Load: ${wLoad.toFixed(0)} (${reason})`);
      saveState();
      render();
      return;
    }

    // Significant excess: create a remainder activity and run it through the suggester
    // so the extra load can reduce/replace runs appropriately
    const excessActivity = createActivity(
      sport, excessMin, rpe,
      aerobic > 0 ? aerobic * (excessMin / dur) : undefined,
      anaerobic > 0 ? anaerobic * (excessMin / dur) : undefined,
      activityWeek
    );

    // Mark the slot fill in workouts so suggester sees true state
    const slotW = workouts.find(w => w.t === 'cross' && wk.workoutMods?.some(
      m => m.name === w.n && m.dayOfWeek === w.dayOfWeek
    ));
    if (slotW) {
      slotW.status = 'replaced';
      slotW.d = 'Activity Replaced';
    }

    // Re-apply existing modifications so suggester knows true state
    if (wk.workoutMods && wk.workoutMods.length > 0) {
      for (const mod of wk.workoutMods) {
        const w = workouts.find(w => w.n === mod.name && w.dayOfWeek === mod.dayOfWeek);
        if (w) {
          w.status = mod.status as any;
          w.d = mod.newDistance;
          w.t = mod.newType;
          w.modReason = mod.modReason || '';
          w.confidence = mod.confidence as any;
          const rpeVal = (mod.newRpe || 5) * 10;
          const loads = calculateWorkoutLoad(w.t, w.d, rpeVal);
          w.aerobic = loads.aerobic;
          w.anaerobic = loads.anaerobic;
        }
      }
    }

    const plannedRuns = workoutsToPlannedRuns(workouts, s.pac);
    const popup = buildCrossTrainingPopup(
      {
        raceGoal: s.rd,
        plannedRunsPerWeek: s.rw,
        injuryMode: !!(s as any).injuryState?.active,
      },
      plannedRuns,
      excessActivity,
      undefined
    );

    // Override summary to explain this is excess load from an over-duration session
    popup.summary = `Your additional ${excessMin} mins ${sportNorm.replace(/_/g, ' ')} has further impact on your training load. ${popup.summary}`;

    sportSelect.value = '';
    durInput.value = '';
    rpeInput.value = '';
    if (aerobicInput) aerobicInput.value = '';
    if (anaerobicInput) anaerobicInput.value = '';

    const weeklyLoad = getWeeklyLoad(getCrossActivities(), s.w);
    const hasAdjustments = popup.reduceOutcome.adjustments.length > 0 ||
      popup.replaceOutcome.adjustments.length > 0;

    // Always record the full activity (not the excess) in the activity log
    activity.applied = true;
    addCrossActivity(activity);

    if (hasAdjustments) {
      showSuggestionModal(popup, sportNorm, (decision) => {
        if (decision && decision.choice !== 'keep' && decision.adjustments.length > 0) {
          const modifiedWorkouts = applyAdjustments(workouts, decision.adjustments, sportNorm);
          if (!wk.workoutMods) wk.workoutMods = [];
          for (const adj of decision.adjustments) {
            const modified = modifiedWorkouts.find(w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex);
            if (!modified) continue;
            wk.workoutMods.push({
              name: modified.n,
              dayOfWeek: modified.dayOfWeek,
              status: modified.status || 'reduced',
              modReason: modified.modReason || '',
              confidence: modified.confidence,
              originalDistance: modified.originalDistance,
              newDistance: modified.d,
              newType: modified.t,
              newRpe: modified.rpe || modified.r,
            });
          }
          log(`${sportNorm}: ${dur}min, RPE${rpe}, Load: ${weeklyLoad.toFixed(0)} (${reason} + ${decision.choice}d plan for ${excessMin}min excess)`);
        } else {
          log(`${sportNorm}: ${dur}min, RPE${rpe}, Load: ${weeklyLoad.toFixed(0)} (${reason} + kept plan for excess)`);
        }
        saveState();
        render();
      });
    } else {
      log(`${sportNorm}: ${dur}min, RPE${rpe}, Load: ${weeklyLoad.toFixed(0)} (${reason}, ${excessMin}min excess — no run adjustments needed)`);
      saveState();
      render();
    }
  };

  if (matchingSlots.length > 0) {
    const slot = matchingSlots[0];
    // Parse planned duration from description (e.g., "60min cycling")
    const slotDurMatch = slot.d.match(/^(\d+)min/);
    const plannedDur = slotDurMatch ? parseInt(slotDurMatch[1]) : 0;
    const withinRange = plannedDur > 0 && Math.abs(dur - plannedDur) / plannedDur <= 0.4;

    if (withinRange || genericSlots.length === 0) {
      // Duration close enough (or no generic fallback) → auto-pair
      const filledDur = fillSlot(slot, `matched planned ${slot.n}`);
      handleSlotFillResult(filledDur, `matched planned ${slot.n}`);
      return;
    }

    // Duration mismatch + generic slots available → let user choose
    showSlotChoiceModal(slot.n, plannedDur, dur, sportNorm).then(choice => {
      if (choice === 'sport') {
        const filledDur = fillSlot(slot, `matched planned ${slot.n}`);
        handleSlotFillResult(filledDur, `matched planned ${slot.n}`);
      } else {
        const filledDur = fillSlot(genericSlots[0], `filled Generic Sport slot`);
        handleSlotFillResult(filledDur, `filled Generic Sport slot`);
      }
    });
    return;
  }

  if (genericSlots.length > 0 && sport !== 'generic_sport') {
    const filledDur = fillSlot(genericSlots[0], `filled Generic Sport slot`);
    handleSlotFillResult(filledDur, `filled Generic Sport slot`);
    return;
  }

  // NEW: Re-apply existing modifications so suggester knows true state (prevents double-spending runs)
  if (wk.workoutMods && wk.workoutMods.length > 0) {
    for (const mod of wk.workoutMods) {
      const w = workouts.find(w => w.n === mod.name && w.dayOfWeek === mod.dayOfWeek);
      if (w) {
        w.status = mod.status as any;
        w.d = mod.newDistance;
        w.t = mod.newType;
        w.modReason = mod.modReason || '';
        w.confidence = mod.confidence as any;
        // If replaced, marking as autoCompleted prevents it from showing as "Missed"
        // but status='replaced' is enough for suggester to ignore it.

        // Recalculate load for the modified workout
        // (Replaced runs with "0km" will get 0 load, preventing them from being targeted again)
        const rpe = (mod.newRpe || 5) * 10;
        const loads = calculateWorkoutLoad(w.t, w.d, rpe);
        w.aerobic = loads.aerobic;
        w.anaerobic = loads.anaerobic;
      }
    }
  }

  // Convert to PlannedRun format for suggester (pass paces for robust distance parsing)
  const plannedRuns = workoutsToPlannedRuns(workouts, s.pac);

  // Build suggestion popup
  const popup = buildCrossTrainingPopup(
    {
      raceGoal: s.rd,
      plannedRunsPerWeek: s.rw,
      injuryMode: !!(s as any).injuryState?.active,
    },
    plannedRuns,
    activity,
    undefined // TODO: could pass previous week run load
  );

  // Clear form immediately
  sportSelect.value = '';
  durInput.value = '';
  rpeInput.value = '';
  if (aerobicInput) aerobicInput.value = '';
  if (anaerobicInput) anaerobicInput.value = '';

  const weeklyLoad = getWeeklyLoad(getCrossActivities(), s.w);

  // Show modal if there are suggestions, otherwise just log and continue
  const hasAdjustments = popup.reduceOutcome.adjustments.length > 0 ||
    popup.replaceOutcome.adjustments.length > 0;

  if (hasAdjustments) {
    showSuggestionModal(popup, normalizeSport(sport), (decision) => {
      // Add activity to state and mark as applied (prevents re-processing)
      activity.applied = true;
      addCrossActivity(activity);

      // Apply adjustments based on user choice
      if (decision && decision.choice !== 'keep' && decision.adjustments.length > 0) {
        // Apply the adjustments to workouts
        const modifiedWorkouts = applyAdjustments(workouts, decision.adjustments, normalizeSport(sport));

        // Store workout modifications in the week
        if (!wk.workoutMods) wk.workoutMods = [];

        for (const adj of decision.adjustments) {
          // Match by both name and dayOfWeek for unique identification
          const modified = modifiedWorkouts.find(w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex);
          if (!modified) continue;

          wk.workoutMods.push({
            name: modified.n,
            dayOfWeek: modified.dayOfWeek,  // Store for unique matching in renderer
            status: modified.status || 'reduced',
            modReason: modified.modReason || '',
            confidence: modified.confidence,
            originalDistance: modified.originalDistance,
            newDistance: modified.d,
            newType: modified.t,  // Store downgraded type (e.g., 'easy')
            newRpe: modified.rpe || modified.r,  // Store matching RPE
          });

          // NOTE: Do NOT mark replaced workouts in wk.rated.
          // wk.rated is for USER-completed workouts only.
          // The workout's status='replaced' is tracked via workoutMods.
        }

        log(`${normalizeSport(sport)}: ${dur}min, RPE${rpe}, Load: ${weeklyLoad.toFixed(0)} (${decision.choice}d plan)`);
      } else {
        // User chose "keep" - activity is logged but no plan changes applied
        log(`${normalizeSport(sport)}: ${dur}min, RPE${rpe}, Load: ${weeklyLoad.toFixed(0)} (kept plan)`);
      }

      saveState();
      render();
    });
  } else {
    // No suggestions needed, just add activity (mark as applied)
    activity.applied = true;
    addCrossActivity(activity);
    log(`${normalizeSport(sport)}: ${dur}min, RPE${rpe}, Load: ${weeklyLoad.toFixed(0)}`);
    saveState();
    render();
  }
}

// Drag and drop handlers
export function dragStart(event: DragEvent, workoutName: string): void {
  draggedWorkout = workoutName;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/html', workoutName);
  }
  (event.target as HTMLElement).style.opacity = '0.5';
}

export function dragEnd(event: DragEvent): void {
  (event.target as HTMLElement).style.opacity = '';
}

export function allowDrop(event: DragEvent): boolean {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
  return false;
}

export function drop(event: DragEvent, targetDay: number): boolean {
  event.preventDefault();
  if (draggedWorkout) {
    moveWorkout(draggedWorkout, targetDay);
    draggedWorkout = null;
  }
  return false;
}

// Whether the Quick Run panel is expanded in the UI
function setJustRunExpanded(v: boolean): void {
  (window as any).__justRunExpanded = v;
}

/** Toggle the Quick Run panel visibility */
export function toggleJustRunPanel(): void {
  setJustRunExpanded(!(window as any).__justRunExpanded);
  render();
}

/**
 * Start an unstructured "Just Run" — adds an ad-hoc workout to the week
 * and begins GPS tracking, just like any planned workout.
 */
export function justRun(): void {
  const s = getMutableState();
  if (s.w < 1 || s.w > s.wks.length) return;
  const wk = s.wks[s.w - 1];

  const name = 'Quick Run';

  // Don't add a duplicate if one already exists and hasn't been rated
  if (!wk.adhocWorkouts) wk.adhocWorkouts = [];
  const existing = wk.adhocWorkouts.find(w => w.n === name && !wk.rated[name]);
  if (!existing) {
    wk.adhocWorkouts.push({ n: name, d: 'Easy pace', r: 5, t: 'easy' });
    saveState();
  }

  setJustRunExpanded(true);

  // Start GPS tracking (same as clicking "Start Run" on any workout)
  if (window.trackWorkout) {
    window.trackWorkout(name, 'Easy pace');
  } else {
    // No GPS available — just re-render so the workout card appears for manual rating
    render();
  }
}

// Make functions globally available for onclick handlers
declare global {
  interface Window {
    rate: (workoutId: string, name: string, rpe: number, expected: number, workoutType: string, isSkipped: boolean) => void;
    skip: (workoutId: string, name: string, workoutType: string, isAlreadySkipped: boolean, currentSkipCount: number, desc: string, rpe: number, dayOfWeek: number, dayName: string) => void;
    moveWorkout: typeof moveWorkout;
    logActivity: typeof logActivity;
    dragStart: typeof dragStart;
    dragEnd: typeof dragEnd;
    allowDrop: typeof allowDrop;
    drop: typeof drop;
    justRun: typeof justRun;
    toggleJustRunPanel: typeof toggleJustRunPanel;
    recordBenchmark: typeof recordBenchmark;
    skipBenchmark: typeof skipBenchmark;
    applyRecoveryAdjustment: typeof applyRecoveryAdjustment;
  }
}

/**
 * Toggle commute setup options visibility in the setup form
 */
export function toggleCommuteSetup(): void {
  const enabled = (document.getElementById('commuteEnabled') as HTMLInputElement)?.checked;
  const optionsDiv = document.getElementById('commuteSetupOptions');
  if (optionsDiv) {
    optionsDiv.classList.toggle('hidden', !enabled);
  }
}

/**
 * Update the running/cross-training breakdown display when exercises/wk changes
 */
export function updateExerciseBreakdown(): void {
  const epw = +(document.getElementById('epw') as HTMLSelectElement)?.value || 5;
  const runSessions = Math.min(epw, 7);
  const crossSessions = Math.max(0, epw - 7);

  const rwDisplay = document.getElementById('rwDisplay');
  if (rwDisplay) rwDisplay.textContent = String(runSessions);
  const ctDisplay = document.getElementById('ctDisplay');
  if (ctDisplay) ctDisplay.textContent = String(crossSessions);
}


/**
 * Check if the given week is a benchmark week (every 4th week within continuous mode).
 */
export function isBenchmarkWeek(weekNumber: number, continuousMode: boolean): boolean {
  return continuousMode && weekNumber > 0 && weekNumber % 4 === 0;
}

/**
 * Find a Garmin/Strava running activity for the given week from cross activities.
 * Returns the first matching activity or null.
 */
export function findGarminRunForWeek(week: number): import('@/types/activities').CrossActivity | null {
  const activities = getCrossActivities();
  return activities.find(a =>
    a.week === week &&
    a.fromGarmin === true &&
    (a.sport === 'extra_run' || a.sport === 'running' || a.sport === 'run')
  ) || null;
}

/** All benchmark options with descriptions */
const BENCHMARK_OPTIONS: Record<import('@/types/state').BenchmarkType, { label: string; description: string }> = {
  easy_checkin: {
    label: 'Easy Check-in',
    description: 'A steady 30-min run. We\'ll track if your pace improves at the same effort — low stress.',
  },
  threshold_check: {
    label: 'Threshold Check',
    description: '20 minutes "comfortably hard". Great fitness signal without an all-out race.',
  },
  speed_check: {
    label: 'Speed Check',
    description: 'Short and sharp — 12-minute test. Run as far as you can; we\'ll estimate VO2.',
  },
  race_simulation: {
    label: 'Race Simulation',
    description: 'A 5k time trial. Highest accuracy, highest fatigue — only if you\'re fresh and keen.',
  },
};

/**
 * Get all benchmark options for the user, with a smart default marked as recommended.
 * Selection logic: focus × experienceLevel from the GPT design doc.
 */
export function getBenchmarkOptions(
  focus: string | null | undefined,
  experienceLevel: string | undefined,
): import('@/types/state').BenchmarkOption[] {
  const exp = experienceLevel || 'intermediate';
  const isBeginner = ['total_beginner', 'beginner', 'novice'].includes(exp);
  const isAdvanced = ['advanced', 'competitive'].includes(exp);

  // Determine the recommended default
  let recommended: import('@/types/state').BenchmarkType;
  if (isBeginner) {
    recommended = 'easy_checkin';
  } else if (isAdvanced) {
    recommended = focus === 'speed' ? 'speed_check' : 'threshold_check';
  } else {
    // intermediate / returning / hybrid
    recommended = focus === 'speed' ? 'speed_check' : 'threshold_check';
  }

  // Build options list — recommended first, race_simulation only for intermediate+
  const types: import('@/types/state').BenchmarkType[] = ['easy_checkin', 'threshold_check', 'speed_check'];
  if (!isBeginner) types.push('race_simulation');

  // Sort: recommended first
  types.sort((a, b) => (a === recommended ? -1 : b === recommended ? 1 : 0));

  return types.map(type => ({
    type,
    label: BENCHMARK_OPTIONS[type].label,
    description: BENCHMARK_OPTIONS[type].description,
    recommended: type === recommended,
  }));
}

/**
 * Convenience: get just the smart default benchmark for the user.
 */
export function getBenchmarkDefault(
  focus: string | null | undefined,
  experienceLevel: string | undefined,
): import('@/types/state').BenchmarkOption {
  return getBenchmarkOptions(focus, experienceLevel)[0];
}

/**
 * Record a benchmark result (from Garmin auto-detect or manual entry).
 * Triggers existing updateFitness flow via physiology tracker.
 *
 * Scoring by type:
 *   easy_checkin     → track pace trend (LT proxy if pace provided)
 *   threshold_check  → LT pace update (avgPaceSecKm ≈ threshold)
 *   speed_check      → VO2max estimate from Cooper formula
 *   race_simulation  → full VDOT recalculation from distance + time
 */
export function recordBenchmark(
  type: import('@/types/state').BenchmarkType,
  source: 'garmin' | 'manual',
  distanceKm?: number,
  durationSec?: number,
  avgPaceSecKm?: number,
): void {
  const s = getMutableState();
  if (!s.continuousMode) return;

  if (!s.benchmarkResults) s.benchmarkResults = [];
  s.benchmarkResults.push({
    week: s.w,
    blockNumber: s.blockNumber || 1,
    focus: s.onboarding?.trainingFocus || 'both',
    type,
    distanceKm,
    durationSec,
    avgPaceSecKm,
    source,
    timestamp: new Date().toISOString(),
  });

  // --- Derive physiology signals from the benchmark type ---
  let estimatedVO2: number | null = null;
  let estimatedLT: number | null = null;

  if (type === 'speed_check' && distanceKm) {
    // Cooper 12-min test: VO2max ≈ (distance_m - 504.9) / 44.73
    estimatedVO2 = Math.round(((distanceKm * 1000) - 504.9) / 44.73 * 10) / 10;
  } else if (type === 'threshold_check' && avgPaceSecKm) {
    // 20-min comfortably hard ≈ threshold pace
    estimatedLT = avgPaceSecKm;
  } else if (type === 'easy_checkin' && avgPaceSecKm) {
    // Easy check-in: lighter signal — still record as LT proxy (weaker confidence)
    estimatedLT = avgPaceSecKm;
  } else if (type === 'race_simulation' && distanceKm && durationSec) {
    // Full TT: compute VDOT directly from time + distance
    estimatedVO2 = Math.round(cv(distanceKm, durationSec) * 10) / 10;
  }

  // Record as physiology measurement if we have data
  if (estimatedVO2 || estimatedLT) {
    if (!s.physiologyTracking) {
      s.physiologyTracking = {
        measurements: initializePhysiologyTracking(s.initialLT, s.initialVO2, s.v).measurements,
      };
    }

    const measurement = {
      week: s.w,
      ltPaceSecKm: estimatedLT,
      vo2max: estimatedVO2,
      source: 'test' as const,
      timestamp: new Date().toISOString(),
    };

    const trackingState = {
      initialLT: s.initialLT,
      initialVO2: s.initialVO2,
      baselineVdot: s.v,
      measurements: s.physiologyTracking.measurements || [],
      currentAdaptationRatio: s.adaptationRatio || 1.0,
      lastAssessment: null,
    };
    const updated = recordMeasurement(trackingState, measurement);
    s.physiologyTracking.measurements = updated.measurements;
    s.adaptationRatio = updated.currentAdaptationRatio;
  }

  const typeLabel = BENCHMARK_OPTIONS[type]?.label || type;
  log(`Benchmark recorded: ${typeLabel} (${source})${estimatedVO2 ? ` VO2≈${estimatedVO2}` : ''}${estimatedLT ? ` LT≈${Math.floor(estimatedLT / 60)}:${String(Math.round(estimatedLT % 60)).padStart(2, '0')}/km` : ''}`);
  saveState();
  render();
}

/**
 * Skip a benchmark check-in. No penalty — plan continues normally.
 */
export function skipBenchmark(): void {
  const s = getMutableState();
  if (!s.continuousMode) return;

  if (!s.benchmarkResults) s.benchmarkResults = [];
  const defaultBm = getBenchmarkDefault(s.onboarding?.trainingFocus, s.onboarding?.experienceLevel);
  s.benchmarkResults.push({
    week: s.w,
    blockNumber: s.blockNumber || 1,
    focus: s.onboarding?.trainingFocus || 'both',
    type: defaultBm.type,
    source: 'skipped',
    timestamp: new Date().toISOString(),
  });

  log('Benchmark skipped — no penalty');
  saveState();
  render();
}

/**
 * Apply a recovery-based adjustment to today's workout.
 * Reuses the cross-training adjustment path (workoutMods).
 *
 * @param type - 'downgrade' (keep distance, lower to easy) or 'reduce' (cut distance by 20%)
 * @param dayOfWeek - Our day index (0=Mon, 6=Sun)
 */
export function applyRecoveryAdjustment(type: 'downgrade' | 'reduce', dayOfWeek: number): void {
  const s = getMutableState();
  const wk = s.wks[s.w - 1];
  if (!wk) return;

  // Generate this week's workouts
  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig, null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v
  );

  // Re-apply existing workoutMods so we don't double-modify
  if (wk.workoutMods && wk.workoutMods.length > 0) {
    for (const mod of wk.workoutMods) {
      const w = workouts.find(wo => wo.n === mod.name && wo.dayOfWeek === mod.dayOfWeek);
      if (w) {
        w.status = mod.status as any;
        w.d = mod.newDistance;
        if (mod.newType) w.t = mod.newType;
        w.modReason = mod.modReason || '';
        w.confidence = mod.confidence as any;
      }
    }
  }

  // Find today's run workout (exclude cross/strength/rest/replaced)
  const todayRun = workouts.find(w =>
    w.dayOfWeek === dayOfWeek &&
    w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest' &&
    w.status !== 'replaced'
  );

  if (!todayRun) {
    log('Recovery: No run workout found for today');
    s.lastRecoveryPromptDate = new Date().toISOString().split('T')[0];
    saveState();
    render();
    return;
  }

  // Parse current distance
  const kmMatch = todayRun.d.match(/(\d+\.?\d*)km/);
  const currentKm = kmMatch ? parseFloat(kmMatch[1]) : 0;

  if (!wk.workoutMods) wk.workoutMods = [];

  if (type === 'downgrade') {
    wk.workoutMods.push({
      name: todayRun.n,
      dayOfWeek: todayRun.dayOfWeek,
      status: 'reduced',
      modReason: 'Recovery: downgraded to easy',
      confidence: 'high',
      originalDistance: todayRun.d,
      newDistance: currentKm > 0 ? `${currentKm}km @ easy` : `${todayRun.d} @ easy effort`,
      newType: 'easy',
      newRpe: 4,
    });
    log(`Recovery: ${todayRun.n} downgraded to easy`);
  } else {
    // Reduce by 20%, min 3km
    const newKm = Math.max(3, Math.round(currentKm * 0.8 * 10) / 10);
    wk.workoutMods.push({
      name: todayRun.n,
      dayOfWeek: todayRun.dayOfWeek,
      status: 'reduced',
      modReason: 'Recovery: distance reduced',
      confidence: 'high',
      originalDistance: todayRun.d,
      newDistance: `${newKm}km (was ${currentKm}km)`,
      newType: todayRun.t,
      newRpe: todayRun.rpe || todayRun.r,
    });
    log(`Recovery: ${todayRun.n} reduced to ${newKm}km`);
  }

  s.lastRecoveryPromptDate = new Date().toISOString().split('T')[0];
  saveState();
  render();
}

window.applyRecoveryAdjustment = applyRecoveryAdjustment;
window.justRun = justRun;
window.toggleJustRunPanel = toggleJustRunPanel;
window.rate = rate;
window.skip = skip;
window.moveWorkout = moveWorkout;
window.logActivity = logActivity;
window.dragStart = dragStart;
window.dragEnd = dragEnd;
window.allowDrop = allowDrop;
window.drop = drop;
window.recordBenchmark = recordBenchmark;
window.skipBenchmark = skipBenchmark;
