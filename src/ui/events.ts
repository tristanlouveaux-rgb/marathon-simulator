import type { RaceDistance, SimulatorState, Week, Workout } from '@/types';
import {
  getState, getMutableState, updateState,
  getCrossActivities, addCrossActivity,
  saveState, clearState
} from '@/state';
import {
  cv, rd, rdKm, tv, calculateFatigueExponent, gt, getRunnerType,
  gp, blendPredictions, getExpectedPhysiology
} from '@/calculations';
import { IMP, TIM, EXPECTED_GAINS } from '@/constants';
import { initializeWeeks } from '@/workouts';
import { createActivity, getWeeklyLoad, normalizeSport, buildCrossTrainingPopup, workoutsToPlannedRuns, applyAdjustments } from '@/cross-training';
import { generateWeekWorkouts } from '@/workouts';
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
 */
export function rate(name: string, rpe: number, expected: number, workoutType: string, isSkipped: boolean): void {
  const s = getMutableState();
  if (s.w < 1 || s.w > s.wks.length) return;
  const wk = s.wks[s.w - 1];

  // If skipped workout being completed, remove from previous week
  if (isSkipped && s.w > 1) {
    const pw = s.wks[s.w - 2];
    if (pw) {
      pw.skip = pw.skip.filter(x => x.n !== name);
      log(`${name} completed (was skipped from previous week)`);
    }
  }

  // Remove old adjustment if re-rating
  const oldRPE = wk.ratedChanges?.[name];
  if (oldRPE !== undefined) s.rpeAdj -= oldRPE;

  wk.rated[name] = rpe;
  const dif = rpe - expected;
  let ch = 0;
  if (dif <= -3) ch = 0.15;
  else if (dif <= -2) ch = 0.08;
  else if (dif >= 3) ch = -0.15;
  else if (dif >= 2) ch = -0.08;

  const imp = IMP[s.rd]?.[workoutType as keyof typeof IMP[typeof s.rd]] || 0.5;
  const wch = ch * imp;

  if (!wk.ratedChanges) wk.ratedChanges = {};
  wk.ratedChanges[name] = wch;
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
 */
export function skip(
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
      if (proceed) skipInner(name, workoutType, isAlreadySkipped, currentSkipCount, desc, rpe, dayOfWeek, dayName);
    });
    return;
  }

  skipInner(name, workoutType, isAlreadySkipped, currentSkipCount, desc, rpe, dayOfWeek, dayName);
}

function skipInner(
  name: string, workoutType: string, isAlreadySkipped: boolean,
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
      if (pw) pw.skip = pw.skip.filter(x => x.n !== name);
    }

    wk.rated[name] = 'skip';
    log(`${name} skipped AGAIN: +${penalty}s penalty`);
  } else {
    // First skip - move to next week
    if (wk.rated[name]) delete wk.rated[name];
    wk.rated[name] = 'skip';

    wk.skip.push({
      n: name,
      t: workoutType,
      workout: {
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
    complete();
    return;
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
 * Compares against predicted trajectory — only adjusts prediction if deviating
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

  // Get expected trajectory values
  const expected = getExpectedPhysiology(s.initialLT, s.initialVO2, s.w, s.v);

  const statusMessages: string[] = [];
  let hasDeviation = false;

  // Compare LT against predicted
  if (newLT && expected.expectedLT) {
    const ltDiff = newLT - expected.expectedLT; // negative = faster than expected
    const ltPctDiff = (ltDiff / expected.expectedLT) * 100;

    if (Math.abs(ltPctDiff) > 1.0) {
      hasDeviation = true;
      if (ltDiff < 0) {
        statusMessages.push(`LT: Improving ${Math.abs(ltPctDiff).toFixed(1)}% faster than predicted`);
      } else {
        statusMessages.push(`LT: Improving ${ltPctDiff.toFixed(1)}% slower than predicted`);
      }
    } else {
      statusMessages.push('LT: On track with predicted trajectory');
    }
    s.lt = newLT;
  } else if (newLT) {
    s.lt = newLT;
    statusMessages.push('LT updated (no baseline for comparison)');
  }

  // Compare VO2 against predicted
  if (newVO2val && expected.expectedVO2) {
    const vo2Diff = newVO2val - expected.expectedVO2; // positive = better than expected
    const vo2PctDiff = (vo2Diff / expected.expectedVO2) * 100;

    if (Math.abs(vo2PctDiff) > 1.5) {
      hasDeviation = true;
      if (vo2Diff > 0) {
        statusMessages.push(`VO2: Improving ${vo2PctDiff.toFixed(1)}% faster than predicted`);
      } else {
        statusMessages.push(`VO2: Improving ${Math.abs(vo2PctDiff).toFixed(1)}% slower than predicted`);
      }
    } else {
      statusMessages.push('VO2: On track with predicted trajectory');
    }
    s.vo2 = newVO2val;
  } else if (newVO2val) {
    s.vo2 = newVO2val;
    statusMessages.push('VO2 updated (no baseline for comparison)');
  }

  // Adjust adaptation ratio if deviating from predicted trajectory
  if (hasDeviation && newLT && s.initialLT && expected.expectedLT) {
    const actualLTImprovement = s.initialLT - newLT;
    const expectedLTImprovement = s.initialLT - expected.expectedLT;
    if (expectedLTImprovement > 0) {
      s.adaptationRatio = actualLTImprovement / expectedLTImprovement;
      statusMessages.push(`Adaptation ratio: ${s.adaptationRatio.toFixed(2)}x`);
    }
  }

  // Update paces with new physiology
  let wg = 0;
  for (let i = 0; i < s.w - 1; i++) wg += s.wks[i].wkGain;
  s.pac = gp(s.v + wg + s.rpeAdj, newLT);

  // Display status
  const statusEl = document.getElementById('fitStatus');
  const statusTextEl = document.getElementById('fitStatusText');
  if (statusEl && statusTextEl) {
    statusEl.classList.remove('hidden');
    const bgColor = hasDeviation ? 'bg-amber-950/30 border border-amber-800 text-amber-300' : 'bg-emerald-950/30 border border-emerald-800 text-emerald-300';
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

  // Convert to PlannedRun format for suggester
  const plannedRuns = workoutsToPlannedRuns(workouts);

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
      // Add activity to state
      addCrossActivity(activity);

      // Apply adjustments based on user choice
      if (decision && decision.choice !== 'keep' && decision.adjustments.length > 0) {
        // Apply the adjustments to workouts
        const modifiedWorkouts = applyAdjustments(workouts, decision.adjustments, normalizeSport(sport));

        // Store workout modifications in the week
        if (!wk.workoutMods) wk.workoutMods = [];

        for (const adj of decision.adjustments) {
          const modified = modifiedWorkouts.find(w => w.n === adj.workoutId);
          if (!modified) continue;

          wk.workoutMods.push({
            name: modified.n,
            status: modified.status || 'reduced',
            modReason: modified.modReason || '',
            confidence: modified.confidence,
            originalDistance: modified.originalDistance,
            newDistance: modified.d,
          });

          // If replaced, mark as rated
          if (adj.action === 'replace') {
            wk.rated[modified.n] = modified.rpe || modified.r || 5;
          }
        }

        log(`${normalizeSport(sport)}: ${dur}min, RPE${rpe}, Load: ${weeklyLoad.toFixed(0)} (${decision.choice}d plan)`);
      } else {
        log(`${normalizeSport(sport)}: ${dur}min, RPE${rpe}, Load: ${weeklyLoad.toFixed(0)}`);
      }

      saveState();
      render();
    });
  } else {
    // No suggestions needed, just add activity
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
    rate: typeof rate;
    skip: typeof skip;
    moveWorkout: typeof moveWorkout;
    logActivity: typeof logActivity;
    dragStart: typeof dragStart;
    dragEnd: typeof dragEnd;
    allowDrop: typeof allowDrop;
    drop: typeof drop;
    justRun: typeof justRun;
    toggleJustRunPanel: typeof toggleJustRunPanel;
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
