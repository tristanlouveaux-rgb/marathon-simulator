import type { Workout, Week, GarminActual } from '@/types';
import {
  getState, getMutableState, saveState
} from '@/state';
import {
  rdKm, tv, gp, getRunnerType,
  calculateLiveForecast
} from '@/calculations';
import { IMP, TL_PER_MIN, LOAD_PER_MIN_BY_INTENSITY } from '@/constants';
import {
  generateWeekWorkouts, parseWorkoutDescription,
  calculateWorkoutLoad, checkConsecutiveHardDays, assignDefaultDays
} from '@/workouts';
// applyCrossTrainingToWorkouts is intentionally NOT used here.
// Plan modifications must only happen via explicit user confirmation in events.ts.
import { ft, fp, formatPace, formatWorkoutTime, DAY_NAMES, DAY_NAMES_SHORT } from '@/utils';
import { SPORTS_DB, SPORT_LABELS, LOAD_PROFILES } from '@/constants';
import { computeACWR } from '@/calculations/fitness-model';
import { getActiveWorkoutName, getActiveGpsData, isTrackingActive } from './gps-events';
import { renderInlineGpsHtml, refreshRecordings } from './gps-panel';
import { loadGpsRecording } from '@/gps/persistence';
import { openGpsRecordingDetail } from './gps-completion-modal';
import { findMatchingWorkout, type ExternalActivity } from '@/calculations/matching';
import { showMatchProposal } from './sync-modal';
import { showRPEHelp, showMPHelp } from './explanations';
import { storeWorkoutStream } from './events';

// Expose explanation modals globally for onclick handlers
declare global {
  interface Window {
    Mosaic: {
      showRPEHelp: typeof showRPEHelp;
      showMPHelp: typeof showMPHelp;
      clearGarmin: () => void;
    };
    undoWorkoutMod: (workoutName: string, dayOfWeek: number | null) => void;
    unrateWorkout: (wId: string) => void;
    deleteGpsRun: (wId: string) => void;
  }
}

/** Returns true if a modReason was created by the cross-training suggestion system */
function isCrossTrainingMod(modReason: string | undefined): boolean {
  if (!modReason) return false;
  return modReason.startsWith('Garmin:')
    || modReason.startsWith('Downgraded from')
    || modReason.startsWith('Reduced due to')
    || modReason.startsWith('Replaced by')
    || modReason.startsWith('Converted to shakeout')
    || modReason.includes(' due to ');
}

function clearGarminAndResync(): void {
  const s = getMutableState();
  for (const wk of s.wks || []) {
    const matched = wk.garminMatched || {};
    for (const workoutId of Object.values(matched)) {
      if (workoutId && workoutId !== '__pending__') delete wk.rated[workoutId];
    }
    wk.garminMatched = {};
    wk.garminActuals = {};
    wk.garminPending = [];
    wk.garminReviewChoices = {};
    wk.unspentLoadItems = [];
    wk.unspentLoad = 0;
    if (wk.adhocWorkouts) {
      wk.adhocWorkouts = wk.adhocWorkouts.filter(w => !w.id || !w.id.startsWith('garmin-'));
    }
    // Remove all cross-training sourced workout modifications (Garmin and manual)
    if (wk.workoutMods) {
      wk.workoutMods = wk.workoutMods.filter(m => !isCrossTrainingMod(m.modReason));
    }
  }
  saveState();
  alert('Garmin data cleared. Reloading to re-sync...');
  window.location.reload();
}

if (typeof window !== 'undefined') {
  window.Mosaic = { showRPEHelp, showMPHelp, clearGarmin: clearGarminAndResync };

  // Undo a specific workout mod by name + day (for manually-logged cross-training mods)
  window.undoWorkoutMod = (workoutName: string, dayOfWeek: number | null) => {
    const s = getMutableState();
    const wk = s.wks?.[s.w - 1];
    if (!wk?.workoutMods) return;
    wk.workoutMods = wk.workoutMods.filter(
      m => !(m.name === workoutName && (dayOfWeek === null || m.dayOfWeek === dayOfWeek)),
    );
    saveState();
    render();
  };

  // Remove the done/rated status from a planned workout
  window.unrateWorkout = (wId: string) => {
    const s = getMutableState();
    const wk = s.wks?.[s.w - 1];
    if (!wk) return;
    delete wk.rated[wId];
    // Remove garmin actuals so the slot no longer shows as garmin-matched
    if (wk.garminActuals?.[wId]) {
      const garminId = wk.garminActuals[wId].garminId;
      delete wk.garminActuals[wId];
      // Reset garmin match to pending so it can be re-reviewed if desired
      if (garminId && wk.garminMatched?.[garminId]) {
        wk.garminMatched[garminId] = '__pending__';
      }
    }
    saveState();
    render();
  };

  // Delete a GPS-tracked run: removes rating, GPS recording link, and adhoc entry
  window.deleteGpsRun = (wId: string) => {
    if (!confirm('Delete this run?')) return;
    const s = getMutableState();
    const wk = s.wks?.[s.w - 1];
    if (!wk) return;
    delete wk.rated[wId];
    if (wk.gpsRecordings?.[wId]) delete wk.gpsRecordings[wId];
    if (wk.adhocWorkouts) {
      wk.adhocWorkouts = wk.adhocWorkouts.filter(w => (w.id || w.n) !== wId);
    }
    saveState();
    render();
  };
}

/**
 * Log a training/sync message to the browser console.
 */
export function log(message: string): void {
  const s = getState();
  console.log(`[W${s.w}] ${message}`);
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

  // Cleanup: purge Quick Run placeholders and skip carry-overs from all weeks.
  // These were created by the justRun() flow before it was fixed. Runs every render
  // but is a no-op (no save) once state is clean.
  {
    let dirty = false;
    for (const wk of s.wks) {
      if (wk.adhocWorkouts?.some(a => !a.id && a.n === 'Quick Run')) {
        wk.adhocWorkouts = wk.adhocWorkouts.filter(a => !(!a.id && a.n === 'Quick Run'));
        dirty = true;
      }
      if (wk.skip?.some(sk => sk.workout?.n === 'Quick Run')) {
        wk.skip = wk.skip.filter(sk => sk.workout?.n !== 'Quick Run');
        dirty = true;
      }
    }
    if (dirty) saveState();
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
  const currentVDOT = s.v + wg + s.rpeAdj + (s.physioAdj || 0);

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
      fcEl.innerHTML = ft(displayForecast) + ' <span class="text-xs ml-1" style="color:var(--c-ok)">Target</span>';
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
  const trailingEffort = getTrailingEffortScore(s.wks, s.w);
  const acwrForRender = computeACWR(s.wks ?? [], s.w, s.athleteTierOverride ?? s.athleteTier, s.ctlBaseline ?? undefined);
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
    currentVDOT, // vdot for plan engine (includes RPE and training gains)
    s.gs,  // gym sessions per week
    trailingEffort, // effort score for adaptive scaling
    acwrForRender.status === 'unknown' ? undefined : acwrForRender.status // acwrStatus — reduces quality sessions when elevated
  );

  // 1. Apply stored modifications BEFORE renaming duplicates.
  // Mods store the original generator name (e.g. "Easy Run") + dayOfWeek,
  // so they must match before the rename step turns them into "Easy Run 1" etc.
  if (wk.workoutMods && wk.workoutMods.length > 0) {
    for (const mod of wk.workoutMods) {
      // Match by both name and dayOfWeek for unique identification
      const workout = wos.find(w => w.n === mod.name && (mod.dayOfWeek == null || w.dayOfWeek === mod.dayOfWeek));
      if (workout) {
        workout.status = mod.status as any;
        workout.modReason = mod.modReason;
        workout.confidence = mod.confidence as any;
        if (mod.status === 'reduced' || mod.status === 'replaced') {
          workout.originalDistance = mod.originalDistance;
          workout.d = mod.newDistance;
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

  // 2. Deduplicate workout names for unique completion tracking
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

  // 3. Append ad-hoc workouts — exclude Garmin-synced ones (separate section) and GPS
  //    impromptu runs (they're shown in the GPS recordings panel, not the plan list).
  //    Two cases to exclude:
  //    a) GPS-linked entries (id present in gpsRecordings)
  //    b) No-id placeholders added by justRun() that have a completed GPS sibling
  if (wk.adhocWorkouts) {
    // Names that already have a GPS-linked entry (GPS run completed)
    const completedGpsNames = new Set(
      wk.adhocWorkouts
        .filter(w => w.id && wk.gpsRecordings?.[w.id])
        .map(w => w.n),
    );
    wos = wos.concat(wk.adhocWorkouts.filter(w => {
      if (w.id?.startsWith('garmin-')) return false;            // Garmin-synced → own section
      if (w.id && wk.gpsRecordings?.[w.id]) return false;      // GPS-linked → recordings panel
      if (!w.id && w.n === 'Quick Run') return false;           // justRun() placeholder
      if (!w.id && completedGpsNames.has(w.n)) return false;   // Other orphaned placeholders
      return true;
    }));
  }

  // 3b. Append passed capacity tests saved on this week (so they persist in history)
  if (wk.passedCapacityTests && wk.passedCapacityTests.length > 0) {
    const testNames: Record<string, string> = {
      single_leg_hop: 'Single Leg Hop Test',
      pain_free_walk: '30-Minute Walk Test',
      isometric_hold: 'Isometric Hold Test',
      stair_test: 'Stair Test',
      squat_test: 'Squat Test',
    };
    for (const testType of wk.passedCapacityTests) {
      // Only add if not already in the workout list (avoid duplicates during test_capacity phase)
      if (!wos.some(w => (w as any).testType === testType)) {
        wos.push({
          t: 'capacity_test',
          n: testNames[testType] || testType,
          d: 'Completed',
          r: 3,
          rpe: 3,
          status: 'passed',
          testType,
        } as any);
      }
    }
  }

  // 4. Apply manual moves
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

  // NOTE: Cross-training modifications are NO LONGER auto-applied during render.
  // Plan changes must only happen via explicit user confirmation in the suggestion modal.
  // The logActivity() function in events.ts handles showing the modal and applying changes.
  //
  // This prevents the bug where logging an activity would silently mutate the plan
  // without user consent.

  // --- Training Stats ---
  // Km this week: sum completed (rated, non-skip) run workouts using actual Garmin distances
  let weekKm = 0;
  for (const wo of wos) {
    if (wo.t === 'cross' || wo.t === 'strength' || wo.t === 'rest' || wo.t === 'gym') continue;
    const wId = wo.id || wo.n;
    if (!wk.rated[wId] || wk.rated[wId] === 'skip') continue;
    if (wo.status === 'replaced') continue;
    const actual = wk.garminActuals?.[wId];
    if (actual?.distanceKm) {
      weekKm += actual.distanceKm;
    } else {
      const kmMatch = wo.d.match(/(\d+\.?\d*)km/);
      if (kmMatch) weekKm += parseFloat(kmMatch[1]);
    }
  }
  // GPS impromptu runs are excluded from wos but still count toward weekly km
  for (const wo of (wk.adhocWorkouts || [])) {
    if (!wo.id || !wk.gpsRecordings?.[wo.id]) continue;
    if (wo.t === 'cross' || wo.t === 'strength' || wo.t === 'rest' || wo.t === 'gym') continue;
    const wId = wo.id;
    if (!wk.rated[wId] || wk.rated[wId] === 'skip') continue;
    const rec = loadGpsRecording(wk.gpsRecordings[wId]);
    if (rec?.totalDistance) {
      weekKm += rec.totalDistance / 1000;
    } else {
      const kmMatch = wo.d.match(/(\d+\.?\d*)km/);
      if (kmMatch) weekKm += parseFloat(kmMatch[1]);
    }
  }
  const kmEl = document.getElementById('stat-km');
  if (kmEl) kmEl.textContent = weekKm > 0 ? weekKm.toFixed(1) : '0';

  // Planned km for the week (from workout descriptions)
  let plannedKm = 0;
  for (const wo of wos) {
    if (wo.t === 'cross' || wo.t === 'strength' || wo.t === 'rest' || wo.t === 'gym') continue;
    if (wo.status === 'replaced') continue;
    const kmMatch = wo.d.match(/(\d+\.?\d*)km/i);
    if (kmMatch) plannedKm += parseFloat(kmMatch[1]);
  }
  const kmPlannedEl = document.getElementById('stat-km-planned');
  if (kmPlannedEl) kmPlannedEl.textContent = plannedKm > 0 ? plannedKm.toFixed(1) : '—';
  const kmBarEl = document.getElementById('stat-km-bar');
  if (kmBarEl && plannedKm > 0) {
    const pct = Math.min(100, Math.round((weekKm / plannedKm) * 100));
    kmBarEl.style.width = `${pct}%`;
    kmBarEl.className = `h-full rounded-full transition-all`;
    kmBarEl.style.background = 'var(--c-ok)';
  }

  // VO2 Max display
  const vo2El = document.getElementById('stat-vo2');
  const vo2DeltaEl = document.getElementById('stat-vo2-delta');
  if (vo2El) {
    if (s.vo2) {
      vo2El.textContent = `${s.vo2.toFixed(1)}`;
      const initialVO2 = s.onboarding?.vo2max;
      if (vo2DeltaEl && initialVO2 && Math.abs(s.vo2 - initialVO2) >= 0.1) {
        const delta = s.vo2 - initialVO2;
        vo2DeltaEl.textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
        vo2DeltaEl.className = `text-xs`;
        vo2DeltaEl.style.color = delta >= 0 ? 'var(--c-ok)' : 'var(--c-warn)';
      }
    } else {
      vo2El.textContent = '—';
    }
  }

  // LT Pace display
  const ltEl = document.getElementById('stat-lt');
  const ltDeltaEl = document.getElementById('stat-lt-delta');
  if (ltEl) {
    if (s.lt) {
      const ltMin = Math.floor(s.lt / 60);
      const ltSec = Math.floor(s.lt % 60);
      ltEl.textContent = `${ltMin}:${String(ltSec).padStart(2, '0')}/km`;
      const initialLT = s.onboarding?.ltPace; // sec/km
      if (ltDeltaEl && initialLT && Math.abs(s.lt - initialLT) >= 1) {
        const delta = initialLT - s.lt; // Positive = faster (improvement)
        const dSec = Math.round(delta);
        ltDeltaEl.textContent = `${dSec >= 0 ? '-' : '+'}${Math.abs(dSec)}s`;
        ltDeltaEl.className = `text-xs`;
        ltDeltaEl.style.color = dSec >= 0 ? 'var(--c-ok)' : 'var(--c-warn)';
      }
    } else {
      ltEl.textContent = '—';
    }
  }

  // LT source indicator
  const ltSourceEl = document.getElementById('stat-lt-source');
  if (ltSourceEl) {
    const lastEst = s.ltEstimation?.estimates?.length
      ? s.ltEstimation.estimates[s.ltEstimation.estimates.length - 1]
      : null;
    if (lastEst) {
      const sourceLabels: Record<string, string> = {
        threshold_direct: 'Auto (threshold)',
        cardiac_efficiency: 'Auto (efficiency)',
        manual: 'Manual',
        benchmark: 'Benchmark',
      };
      ltSourceEl.textContent = sourceLabels[lastEst.source] || lastEst.source;
      ltSourceEl.className = 'text-xs';
      ltSourceEl.style.color = 'var(--c-faint)';
    } else if (s.lt) {
      ltSourceEl.textContent = 'Manual';
      ltSourceEl.className = 'text-xs';
      ltSourceEl.style.color = 'var(--c-faint)';
    } else {
      ltSourceEl.textContent = '';
    }
  }

  // Build HTML
  let h = `<h3 class="font-bold mb-3 text-sm" style="color:var(--c-black)">Week ${s.w} Workouts (${wos.length})</h3>`;

  // Adaptive note for future weeks
  if ((s as any)._viewOnly && s.w > ((s as any)._realW || 0)) {
    h += `<div class="text-xs italic mb-3" style="color:var(--c-faint)">Workout plans are adaptive and will change based on previous weeks' training.</div>`;
  }

  // LT pending confirmation banner
  if (s.ltEstimation?.pendingConfirmation) {
    const pc = s.ltEstimation.pendingConfirmation;
    const fmtP = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
    h += `<div class="p-3 rounded mb-3 text-xs border" style="background:rgba(245,158,11,0.06);border-color:rgba(245,158,11,0.35)">`;
    h += `<div class="font-bold mb-1" style="color:var(--c-caution)">LT Change Detected (${pc.deviationPct.toFixed(1)}%)</div>`;
    h += `<div class="mb-2" style="color:var(--c-muted)">Estimated LT: ${fmtP(pc.estimate.ltPaceSecPerKm)}/km (current: ${fmtP(pc.currentLT)}/km)</div>`;
    h += `<div class="flex gap-2">`;
    h += `<button onclick="window.acceptLTUpdate()" class="px-3 py-1.5 rounded font-medium" style="background:var(--c-ok);color:white">Accept</button>`;
    h += `<button onclick="window.dismissLTUpdate()" class="px-3 py-1.5 rounded" style="background:rgba(0,0,0,0.06);color:var(--c-muted)">Dismiss</button>`;
    h += `</div></div>`;
  }

  // Warnings
  const warnings = checkConsecutiveHardDays(wos);
  if (warnings.length > 0) {
    h += `<div class="p-2 rounded mb-3 border" style="background:rgba(239,68,68,0.06);border-color:rgba(239,68,68,0.3)">`;
    h += `<div class="text-xs font-bold mb-1" style="color:var(--c-warn)">Training Plan Warnings:</div>`;
    for (const warn of warnings) {
      const color = warn.level === 'critical' ? 'var(--c-warn)' : 'var(--c-caution)';
      h += `<div class="text-xs py-0.5" style="color:${color}">${warn.message}</div>`;
    }
    h += `</div>`;
  }

  // Cross-training bonus
  if (wk.crossTrainingBonus && wk.crossTrainingBonus > 0.01) {
    h += `<div class="p-2 rounded mb-2 text-xs border" style="background:rgba(34,197,94,0.06);border-color:rgba(34,197,94,0.25);color:var(--c-ok)">`;
    h += `<strong>Fitness Bonus:</strong> +${wk.crossTrainingBonus.toFixed(2)} VDOT from unscheduled activities`;
    h += `</div>`;
  }

  // Cross-training summary
  if (wk.crossTrainingSummary && (wk.crossTrainingSummary.workoutsReplaced > 0 || wk.crossTrainingSummary.workoutsReduced > 0)) {
    const summary = wk.crossTrainingSummary;
    const replacementPct = Math.round(summary.budgetUtilization.replacement * 100);
    const adjustmentPct = Math.round(summary.budgetUtilization.adjustment * 100);

    h += `<div class="p-2 rounded mb-2 text-xs border" style="background:var(--c-surface);border-color:var(--c-border)">`;
    h += `<div class="font-bold mb-1" style="color:var(--c-black)">Cross-Training Impact</div>`;
    h += `<div class="grid grid-cols-2 gap-2">`;

    // Modifications
    h += `<div class="space-y-0.5">`;
    if (summary.workoutsReplaced > 0) {
      h += `<div style="color:var(--c-ok)">${summary.workoutsReplaced} workout${summary.workoutsReplaced > 1 ? 's' : ''} replaced</div>`;
    }
    if (summary.workoutsReduced > 0) {
      h += `<div style="color:var(--c-accent)">${summary.workoutsReduced} workout${summary.workoutsReduced > 1 ? 's' : ''} reduced</div>`;
    }
    h += `</div>`;

    // Budget utilization
    h += `<div class="space-y-0.5" style="color:var(--c-muted)">`;
    h += `<div class="flex items-center gap-1">`;
    h += `<span>Replace:</span>`;
    h += `<div class="flex-1 rounded-full h-2" style="background:rgba(0,0,0,0.08)">`;
    h += `<div class="h-2 rounded-full" style="width: ${Math.min(replacementPct, 100)}%;background:var(--c-ok)"></div>`;
    h += `</div>`;
    h += `<span class="w-8 text-right">${replacementPct}%</span>`;
    h += `</div>`;
    h += `<div class="flex items-center gap-1">`;
    h += `<span>Adjust:</span>`;
    h += `<div class="flex-1 rounded-full h-2" style="background:rgba(0,0,0,0.08)">`;
    h += `<div class="h-2 rounded-full" style="width: ${Math.min(adjustmentPct, 100)}%;background:var(--c-accent)"></div>`;
    h += `</div>`;
    h += `<span class="w-8 text-right">${adjustmentPct}%</span>`;
    h += `</div>`;
    h += `</div>`;

    h += `</div>`;

    // Overflow warning
    if (summary.totalLoadOverflow > 50) {
      h += `<div class="mt-1 text-xs" style="color:var(--c-caution)">`;
      h += `+${Math.round(summary.totalLoadOverflow)} load overflow (contributing to fitness bonus)`;
      h += `</div>`;
    }

    h += `</div>`;
  }

  // LT auto-update banner
  if (wk.ltAutoUpdate) {
    const ltu = wk.ltAutoUpdate;
    const fmtP = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
    const bannerStyle = ltu.confidence === 'high'
      ? 'background:rgba(34,197,94,0.06);border-color:rgba(34,197,94,0.25);color:var(--c-ok)'
      : 'background:rgba(78,159,229,0.06);border-color:rgba(78,159,229,0.25);color:var(--c-accent)';
    const sourceLabel = ltu.source === 'threshold_direct' ? 'threshold run' : 'efficiency trend';
    h += `<div class="border p-2 rounded mb-2 text-xs" style="${bannerStyle}">`;
    h += `<strong>LT Auto-Updated:</strong> ${fmtP(ltu.newLT)}/km`;
    if (ltu.previousLT) h += ` (was ${fmtP(ltu.previousLT)}/km)`;
    h += ` — via ${sourceLabel}, ${ltu.confidence} confidence`;
    h += `</div>`;
  }

  // Calendar view
  h += renderCalendar(wos, wk, s.pac);

  const allPlannedWos = wos.slice().sort((a, b) => (a.dayOfWeek ?? 99) - (b.dayOfWeek ?? 99));

  const isViewOnly = !!(s as any)._viewOnly;

  // Split into pending (unrated) and completed (rated) sections
  const completedWos: Workout[] = [];
  const pendingWos: Workout[] = [];
  for (const w of allPlannedWos) {
    const rtd = w.id ? wk.rated[w.id] : wk.rated[w.n];
    if (rtd && rtd !== 'skip') completedWos.push(w);
    else pendingWos.push(w);
  }

  // Planned section (unrated workouts)
  if (pendingWos.length > 0) {
    h += `<h4 class="font-semibold text-sm mb-2 mt-4" style="color:var(--c-black)">This Week's Plan</h4>`;
    h += renderWorkoutList(pendingWos, wk, s.rd, s.pac, s.tw, s.w, isViewOnly);
  }

  // Completed section (rated workouts)
  if (completedWos.length > 0) {
    h += `<h4 class="font-semibold text-sm mb-2 mt-4" style="color:var(--c-ok)">Completed</h4>`;
    h += renderWorkoutList(completedWos, wk, s.rd, s.pac, s.tw, s.w, isViewOnly);
  }

  // GPS recordings section (populated by refreshRecordings() below)
  h += `<div id="gps-recordings-section" class="mt-3"></div>`;

  // Paces
  h += `<div class="mt-3 text-xs mb-1" style="color:var(--c-muted)">Your current paces</div>`;
  h += `<div class="grid grid-cols-2 gap-1 text-xs">`;
  h += `<div class="p-1.5 rounded" style="background:var(--c-surface);color:var(--c-muted)">Easy (no faster than): <strong style="color:var(--c-black)">${fp(s.pac.e)}</strong></div>`;
  h += `<div class="p-1.5 rounded" style="background:var(--c-surface);color:var(--c-muted)">Threshold: <strong style="color:var(--c-black)">${fp(s.pac.t)}</strong></div>`;
  h += `<div class="p-1.5 rounded" style="background:var(--c-surface);color:var(--c-muted)">VO2 Builder: <strong style="color:var(--c-black)">${fp(s.pac.i)}</strong></div>`;
  h += `<div class="p-1.5 rounded" style="background:var(--c-surface);color:var(--c-muted)">Marathon: <strong style="color:var(--c-black)">${fp(s.pac.m)}</strong></div></div>`;

  // Garmin synced activities section (separate from plan, below paces)
  h += renderGarminSyncedSection(wk);

  // Cross-training form
  h += renderCrossTrainingForm();

  const woEl = document.getElementById('wo');
  if (woEl) woEl.innerHTML = h;


  // Populate past GPS recordings
  refreshRecordings();

  // Update complete week button
  // Only count ratings that match current workout IDs.
  // Excludes: stale keys from pre-injury workouts, Garmin ad-hoc entries (id starts with "garmin-").
  const tot = wos.length;
  const currentWorkoutIds = new Set(wos.map(w => w.id || w.n));
  const don = Object.keys(wk.rated).filter(k => currentWorkoutIds.has(k) && !k.startsWith('garmin-')).length;
  const bnEl = document.getElementById('bn') as HTMLButtonElement;
  if (bnEl) {
    bnEl.disabled = don < tot;
    bnEl.className = don >= tot
      ? 'w-full font-bold py-2 rounded text-xs'
      : 'w-full font-bold py-2 rounded text-xs cursor-not-allowed';
  bnEl.style.background = don >= tot ? 'var(--c-ok)' : 'rgba(0,0,0,0.06)';
  bnEl.style.color = don >= tot ? 'white' : 'var(--c-faint)';
  }
  const stEl = document.getElementById('st');
  if (stEl) stEl.innerHTML = don >= tot ? `Complete ${don}/${tot}` : `Progress ${don}/${tot}`;
}

/**
 * Compute trailing effort score from the last 2 completed weeks with effort data.
 * Skips injury weeks. Returns 0 when no data available.
 */
function getTrailingEffortScore(weeks: Week[], currentWeekIdx: number): number {
  const completed: number[] = [];
  for (let i = currentWeekIdx - 2; i >= 0 && completed.length < 2; i--) {
    const w = weeks[i];
    if (w.effortScore != null && !w.injuryState?.active) {
      completed.push(w.effortScore);
    }
  }
  if (completed.length === 0) return 0;
  return completed.reduce((a, b) => a + b, 0) / completed.length;
}

/**
 * Render calendar view
 */
function renderCalendar(wos: Workout[], wk: Week, paces: any): string {
  let h = `<details class="mb-4" open><summary class="cursor-pointer text-sm font-medium mb-2" style="color:var(--c-muted)">Weekly Calendar View</summary>`;
  h += `<div class="grid grid-cols-7 gap-1">`;

  // Headers
  for (const day of DAY_NAMES_SHORT) {
    h += `<div class="text-xs font-bold text-center py-1 rounded" style="background:var(--c-surface);color:var(--c-muted)">${day}</div>`;
  }

  // Cells
  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const dayWorkouts = wos.filter(w => w.dayOfWeek === dayIdx);
    const hasHard = dayWorkouts.some(w => isHardWorkoutType(w.t));
    const cellBorderColor = hasHard ? 'rgba(239,68,68,0.4)' : 'var(--c-border)';

    h += `<div class="border rounded p-1 min-h-[120px]" style="border-color:${cellBorderColor};background:var(--c-bg)" ondrop="window.drop(event,${dayIdx})" ondragover="window.allowDrop(event)">`;

    if (dayWorkouts.length === 0) {
      h += `<div class="text-xs text-center py-4" style="color:var(--c-border)">Rest</div>`;
    } else {
      for (const w of dayWorkouts) {
        const rtd = w.id ? wk.rated[w.id] : wk.rated[w.n];
        const isModified = w.status && (w.status === 'replaced' || w.status === 'reduced');
        const isReplaced = w.status === 'replaced';
        const isSkipped = w.skipped === true;

        const wColors = getWorkoutColors(w.t);
        let cardBgStyle = wColors.bgStyle;
        let cardBorderColor = wColors.borderColor;
        // User-completed = green; Replaced = cyan; Modified/shakeout = sky; Skipped easy = green; Skipped hard = amber
        if (rtd) { cardBgStyle = 'rgba(34,197,94,0.08)'; cardBorderColor = 'rgba(34,197,94,0.4)'; }
        else if (isReplaced) { cardBgStyle = 'rgba(6,182,212,0.08)'; cardBorderColor = 'rgba(6,182,212,0.4)'; }
        else if (isModified) { cardBgStyle = 'rgba(78,159,229,0.08)'; cardBorderColor = 'rgba(78,159,229,0.4)'; }
        else if (isSkipped && w.t === 'easy') { cardBgStyle = 'rgba(34,197,94,0.05)'; cardBorderColor = 'rgba(34,197,94,0.4)'; }
        else if (isSkipped) { cardBgStyle = 'rgba(245,158,11,0.05)'; cardBorderColor = 'rgba(245,158,11,0.4)'; }

        // Status label for calendar card
        const calGarmin = wk.garminActuals?.[w.id || w.n];
        let statusLabel = '';
        if (rtd && calGarmin) {
          // For gym/cross slots: show the matched activity name instead of the generic Garmin dot
          if ((w.t === 'gym' || w.t === 'cross') && calGarmin.displayName) {
            statusLabel = ` → ${calGarmin.displayName}`;
          } else {
            statusLabel = ' <span style="color:#F97316">&#9673;</span>';
          }
        }
        else if (rtd) statusLabel = ' Done';
        else if (isReplaced) {
          const actName = w.modReason ? w.modReason.replace(/^Garmin:\s*/i, '').trim() : '';
          statusLabel = actName ? ` → ${actName}` : ' Replaced';
        }
        else if (isModified) statusLabel = ' Modified';

        h += `<div class="border rounded p-1 mb-1 text-xs cursor-move" style="background:${cardBgStyle};border-color:${cardBorderColor};color:var(--c-muted)" draggable="true" ondragstart="window.dragStart(event,'${w.n.replace(/'/g, "\\'")}')">`;
        h += `<div class="font-semibold" style="color:var(--c-black)">${w.n}${statusLabel}</div>`;
        if (w.t !== 'gym') {
          if (isReplaced) {
            // Replaced: show original description struck through
            const origDesc = w.originalDistance || w.d;
            const origLine = injectPaces(origDesc, paces).split(/\n/)[0];
            h += `<div class="text-xs line-through" style="color:var(--c-faint)">${origLine}</div>`;
            h += `<div class="text-xs" style="color:var(--c-accent)">${w.modReason ? w.modReason.replace(/^Garmin:\s*/i, '').trim() : 'Replaced'}</div>`;
          } else if (isModified) {
            // Modified (graduated return): short format — just key info
            const descLines = injectPaces(w.d, paces).split(/\n/);
            const mainLine = descLines.length >= 3 ? descLines[1] : descLines[0];
            // Strip paces, distance hints, recovery — just show structure
            const shortDesc = mainLine
              .replace(/@\s*[^,\n]+/g, '')       // strip everything after @
              .replace(/\s*\(~[^)]+\)/g, '')     // strip distance hints
              .replace(/,\s*\d+\s*min\s*recovery.*/gi, '') // strip recovery
              .replace(/\s+/g, ' ').trim();
            h += `<div class="text-xs" style="color:var(--c-accent)">${shortDesc || mainLine.split(',')[0]}</div>`;
            h += `<div class="text-xs" style="color:${wColors.accentColor}">RPE ${w.rpe || w.r}</div>`;
          } else {
            let calDesc = '';
            if (w.t === 'cross') {
              // Strip sport name from description to avoid duplication with w.n
              calDesc = w.d.replace(new RegExp('^' + w.n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '');
            } else if (w.t === 'vo2' || w.t === 'threshold') {
              const descLines = injectPaces(w.d, paces).split(/\n/);
              const mainLine = descLines.length >= 3 ? descLines[1] : descLines[0];
              calDesc = mainLine.replace(/\s*\(~[^)]+\)/g, '').replace(/\/km/g, '');
            } else {
              calDesc = injectPaces(w.d, paces).split(/\n/)[0];
            }
            h += `<div class="text-xs" style="color:var(--c-muted)">${calDesc}</div>`;
            h += `<div class="text-xs" style="color:${wColors.accentColor}">RPE ${w.rpe || w.r}</div>`;
          }
        }
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
function renderWorkoutList(wos: Workout[], wk: Week, rd: string, paces: any, tw: number, currentWeek: number, viewOnly: boolean = false): string {
  let h = `<div class="space-y-2">`;

  for (const w of wos) {
    const rtd = w.id ? wk.rated[w.id] : wk.rated[w.n];

    // Detect Garmin-synced activities that can be removed
    // Case 1: Ad-hoc activity with id like "garmin-<id>"
    const isGarminAdhoc = (w.id || '').startsWith('garmin-');
    const garminAdhocRawId = isGarminAdhoc ? (w.id || '').slice('garmin-'.length) : '';
    // Case 2: Slot matched to Garmin via garminActuals (gym, cross, or run slot)
    const garminActualsData = !isGarminAdhoc ? wk.garminActuals?.[w.id || w.n] : undefined;
    const garminActualsId = garminActualsData?.garminId ?? '';
    // Case 3: Cross-training slot reduced/replaced by Garmin (legacy workoutMod path)
    const garminSlotId = !isGarminAdhoc && !garminActualsId && wk.garminMatched
      ? Object.entries(wk.garminMatched).find(([, wid]) => wid === (w.id || w.n) &&
          wk.workoutMods?.some(m => m.name === wid && m.modReason?.startsWith('Garmin:'))
        )?.[0]
      : undefined;
    const garminId = garminAdhocRawId || garminActualsId || garminSlotId || '';
    const isGarminActivity = !viewOnly && !!garminId;

    // --- Gym workouts: simplified card with collapsible exercise list ---
    if (w.t === 'gym') {
      const gymGarminActual = wk.garminActuals?.[w.id || w.n];
      const gymDisplayName = gymGarminActual?.displayName;
      let gymBorderColor = 'var(--c-border)';
      let gymBgStyle = 'var(--c-surface)';
      if (rtd) { gymBorderColor = 'rgba(34,197,94,0.4)'; gymBgStyle = 'rgba(34,197,94,0.06)'; }

      h += `<div class="border-2 p-2 rounded" style="border-color:${gymBorderColor};background:${gymBgStyle}">`;

      // Header — show matched activity name if garmin-matched
      const dayLabel = w.dayOfWeek != null ? DAY_NAMES_SHORT[w.dayOfWeek] : '';
      h += `<div class="flex justify-between mb-1 text-xs">`;
      h += `<div>${dayLabel ? `<span class="mr-1.5" style="color:var(--c-faint)">${dayLabel}</span>` : ''}`;
      h += `<strong>${gymDisplayName || w.n}</strong>`;
      if (gymDisplayName) h += ` <span class="font-normal" style="color:var(--c-faint)">← ${w.n}</span>`;
      if (rtd && rtd !== 'skip') h += ` <span class="px-1 py-0.5 rounded ml-1" style="background:var(--c-ok);color:white">Done</span>`;
      h += `</div>`;
      h += `<div class="flex items-center gap-1">`;
      if (isGarminActivity) h += `<button onclick="window.removeGarminActivity('${garminId}')" class="transition-colors ml-1 text-base leading-none" style="color:var(--c-faint)" title="Remove Garmin activity">&times;</button>`;
      h += `</div>`;
      h += `</div>`;

      // If garmin-matched, show duration/HR summary before exercise list
      if (gymGarminActual && gymDisplayName) {
        const dur = Math.round(gymGarminActual.durationSec / 60);
        let statLine = `${dur} min`;
        if (gymGarminActual.avgHR) statLine += ` · Avg HR ${gymGarminActual.avgHR}`;
        if (gymGarminActual.calories) statLine += ` · ${gymGarminActual.calories} kcal`;
        h += `<div class="text-xs mb-1" style="color:rgba(249,115,22,0.8)">${statLine}</div>`;
      }

      // Collapsible exercise list
      const lines = w.d.split('\n').filter(l => l.trim());
      const exercises = lines.filter(l => !l.startsWith('Stretch'));
      const stretchTip = lines.find(l => l.startsWith('Stretch'));

      h += `<details class="mb-1"><summary class="text-xs cursor-pointer" style="color:var(--c-muted)">View exercises</summary>`;
      h += `<ol class="mt-1.5 ml-4 space-y-1.5 text-xs list-decimal" style="color:var(--c-muted)">`;
      for (const ex of exercises) {
        h += `<li>${ex}</li>`;
      }
      h += `</ol>`;
      if (stretchTip) {
        h += `<div class="mt-1.5 text-xs italic" style="color:var(--c-faint)">${stretchTip}</div>`;
      }
      h += `</details>`;

      // Gym: simple mark as done (no RPE needed)
      if (!viewOnly) {
        const wId = w.id || w.n;
        if (rtd) {
          const unrateId = (w.id || w.n).replace(/'/g, "\\'");
          h += `<button onclick="window.unrateWorkout('${unrateId}')" class="w-full mt-1 text-xs py-0.5 rounded" style="background:rgba(0,0,0,0.06);color:var(--c-muted)">Unmark as done</button>`;
        } else {
          h += `<button onclick="window.rate('${wId.replace(/'/g, "\\'")}','${w.n.replace(/'/g, "\\'")}',${w.rpe || w.r},${w.rpe || w.r},'${w.t}',false)" class="w-full mt-1 py-1.5 text-xs rounded font-medium" style="background:var(--c-ok);color:white">Mark as done</button>`;
        }
      } else if (viewOnly && rtd) {
        h += `<div class="text-xs" style="color:var(--c-ok)">Done</div>`;
      }

      // Skip button — only for unrated (planned) gym sessions
      if (!viewOnly && !rtd) {
        const skipId = w.id || w.n;
        h += `<button onclick="window.skip('${skipId.replace(/'/g, "\\'")}','${w.n.replace(/'/g, "\\'")}','${w.t}',false,0,'${w.d.replace(/'/g, "\\'").replace(/\n/g, ' ')}',${w.rpe || w.r},${w.dayOfWeek},'${w.dayName || ''}')" class="w-full mt-1 text-xs py-0.5 rounded" style="background:rgba(0,0,0,0.06);color:var(--c-muted)">Skip</button>`;
      }

      h += `</div>`;
      continue;
    }

    // --- Normal (non-gym) workout card ---
    const impByType = IMP[rd as keyof typeof IMP] || {};
    const imp = (impByType as Record<string, number>)[w.t] || 0.5;
    const loads = calculateWorkoutLoad(w.t, w.d, (w.rpe || w.r || 5) * 10);

    const isModified = w.status && (w.status === 'replaced' || w.status === 'reduced');
    const isReplaced = w.status === 'replaced';
    const isSkipped = w.skipped === true;

    // Detail cards: User-completed = green; Load covered = cyan; Modified/shakeout = sky; Skipped easy = green; Skipped hard = amber
    let cardDetailBorderColor = 'var(--c-border)';
    let cardDetailBgStyle = 'var(--c-surface)';
    if (rtd) { cardDetailBorderColor = 'rgba(34,197,94,0.4)'; cardDetailBgStyle = 'rgba(34,197,94,0.06)'; }
    else if (isReplaced) { cardDetailBorderColor = 'rgba(6,182,212,0.4)'; cardDetailBgStyle = 'rgba(6,182,212,0.06)'; }
    else if (isModified) { cardDetailBorderColor = 'rgba(78,159,229,0.4)'; cardDetailBgStyle = 'rgba(78,159,229,0.06)'; }
    else if (isSkipped && w.t === 'easy') { cardDetailBorderColor = 'rgba(34,197,94,0.4)'; cardDetailBgStyle = 'rgba(34,197,94,0.04)'; }
    else if (isSkipped) { cardDetailBorderColor = 'rgba(245,158,11,0.4)'; cardDetailBgStyle = 'rgba(245,158,11,0.04)'; }

    h += `<div class="border-2 p-2 rounded" style="border-color:${cardDetailBorderColor};background:${cardDetailBgStyle}">`;

    // Garmin-matched slot banner (cross/run slots matched via garminActuals)
    if (garminActualsData?.displayName && !isModified && (w.t === 'cross' || w.t === 'run' || w.t === 'easy' || w.t === 'long' || w.t === 'threshold' || w.t === 'vo2' || w.t === 'marathon_pace')) {
      const actName = garminActualsData.displayName;
      const dur = Math.round(garminActualsData.durationSec / 60);
      let statLine = `${dur} min`;
      if (garminActualsData.avgHR) statLine += ` · HR ${garminActualsData.avgHR}`;
      if (garminActualsData.distanceKm > 0.1) statLine += ` · ${garminActualsData.distanceKm.toFixed(1)} km`;
      h += `<div class="mb-2 p-1.5 border rounded text-xs" style="background:rgba(249,115,22,0.06);border-color:rgba(249,115,22,0.3);color:#F97316">`;
      h += `<div class="font-semibold">Matched: ${actName}</div>`;
      h += `<div class="mt-0.5" style="color:rgba(249,115,22,0.7)">${statLine}</div>`;
      h += `</div>`;
    }

    // Modification banner
    if (isModified && w.modReason) {
      const activityName = w.modReason.replace(/^Garmin:\s*/i, '').trim();
      const modStyleAttr = isReplaced
        ? 'background:rgba(6,182,212,0.06);border-color:rgba(6,182,212,0.3);color:var(--c-accent)'
        : 'background:rgba(78,159,229,0.06);border-color:rgba(78,159,229,0.3);color:var(--c-accent)';
      const modLabel = isReplaced ? `Replaced by ${activityName}` : `Reduced — ${activityName}`;
      const isGarminMod = w.modReason.startsWith('Garmin:') || !!garminActualsData;
      const undoOnclick = isGarminMod
        ? `window.openActivityReReview()`
        : `window.undoWorkoutMod('${w.n.replace(/'/g, "\\'")}',${w.dayOfWeek ?? null})`;
      h += `<div class="mb-2 p-1.5 border rounded text-xs flex items-start justify-between gap-2" style="${modStyleAttr}">`;
      h += `<div>`;
      h += `<div class="font-semibold">${modLabel}</div>`;
      if (w.originalDistance && !isReplaced) {
        h += `<div class="mt-0.5" style="color:var(--c-faint)">Was: ${w.originalDistance}</div>`;
      }
      h += `</div>`;
      h += `<button onclick="${undoOnclick}" class="text-xs whitespace-nowrap shrink-0 underline" style="color:var(--c-faint)">Undo</button>`;
      h += `</div>`;
    }

    // Skip banner
    if (isSkipped) {
      if (w.t === 'easy' && w.n?.includes('(was')) {
        // Downgraded makeup: friendly green banner
        h += `<div class="mb-2 p-1.5 border rounded text-xs font-bold" style="background:rgba(34,197,94,0.06);border-color:rgba(34,197,94,0.35);color:var(--c-ok)">`;
        h += 'MAKEUP — Downgraded to easy to protect recovery';
        h += `</div>`;
      } else {
        const skipStyleAttr = (w.skipCount || 0) === 1
          ? 'background:rgba(245,158,11,0.06);border-color:rgba(245,158,11,0.35);color:var(--c-caution)'
          : 'background:rgba(239,68,68,0.06);border-color:rgba(239,68,68,0.3);color:var(--c-warn)';
        h += `<div class="mb-2 p-1.5 border rounded text-xs font-bold" style="${skipStyleAttr}">`;
        h += (w.skipCount || 0) === 1 ? 'SKIPPED - Complete now (no penalty)' : 'FINAL CHANCE - Skip again = penalty!';
        h += `</div>`;
      }
    }

    // Header
    // Only suppress RPE/load for true "no physical activity" rest (acute RICE protocol)
    const isCompleteRest = w.t === 'rest' && (w.d?.includes('RICE') || w.d?.includes('No physical activity') || w.d?.includes('Complete rest'));
    // Running workouts need RPE; non-running (cross, strength, rest) just need "done"
    const isRunWorkout = w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest';
    const dayLabel = w.dayOfWeek != null ? DAY_NAMES_SHORT[w.dayOfWeek] : '';
    const workoutInfo = isReplaced ? { totalDistance: 0, totalTime: 0, avgPace: null } : parseWorkoutDescription(w.d, paces);
    const timeRange = workoutInfo.totalTime > 0 ? fmtTimeRange(workoutInfo.totalTime, w.t) : '';
    h += `<div class="flex justify-between mb-1 text-xs">`;
    h += `<div>${dayLabel ? `<span class="mr-1.5" style="color:var(--c-faint)">${dayLabel}</span>` : ''}<strong>${w.n}</strong>`;
    if (w.commute) h += ` <span class="px-1 py-0.5 rounded ml-1 text-xs" style="background:rgba(0,0,0,0.06);color:var(--c-muted)">Commute</span>`;
    const garminActual = wk.garminActuals?.[w.id || w.n];
    if (garminActual) h += ` <span class="px-1 py-0.5 rounded ml-1 text-xs border" style="background:rgba(249,115,22,0.08);color:#F97316;border-color:rgba(249,115,22,0.25)">Garmin</span>`;
    const hasStravaPair = garminActual?.stravaId || garminActual?.garminId?.startsWith('strava-');
    if (hasStravaPair) h += ` <span class="px-1 py-0.5 rounded ml-1 text-xs border" style="background:rgba(168,85,247,0.08);color:#A855F7;border-color:rgba(168,85,247,0.25)">Strava</span>`;
    if (isCompleteRest && rtd) h += ` <span class="px-1 py-0.5 rounded ml-1" style="background:var(--c-ok);color:white">Done</span>`;
    else if (rtd && rtd !== 'skip') h += ` <span class="px-1 py-0.5 rounded ml-1" style="background:var(--c-ok);color:white">${isRunWorkout ? `Done ${rtd}` : 'Done'}</span>`;

    h += `</div>`;
    if (!isCompleteRest) {
      h += `<div class="flex items-center gap-1.5">`;
      if (timeRange) h += `<span class="text-xs" style="color:var(--c-muted)">${timeRange}</span>`;
      if (isRunWorkout) h += `<span class="px-1 py-0.5 rounded" style="background:rgba(0,0,0,0.06);color:var(--c-muted)">RPE ${w.rpe || w.r} <button class="ml-0.5" style="color:var(--c-accent)" onclick="window.Mosaic.showRPEHelp()">(?)</button></span>`;
      if (isGarminActivity) h += `<button onclick="window.removeGarminActivity('${garminId}')" class="transition-colors text-base leading-none" style="color:var(--c-faint)" title="Remove Garmin activity">&times;</button>`;
      else if (!viewOnly && wk.gpsRecordings?.[w.id || w.n] && rtd) {
        const gpsDeleteId = (w.id || w.n).replace(/'/g, "\\'");
        h += `<button onclick="window.deleteGpsRun('${gpsDeleteId}')" class="transition-colors text-base leading-none" style="color:var(--c-faint)" title="Delete run">&times;</button>`;
      }
      h += `</div>`;
    }
    h += `</div>`;

    // Return-to-run level indicator
    if (w.t === 'return_run' && w.modReason) {
      const levelMatch = w.modReason.match(/Return Level (\d+)\/8/);
      if (levelMatch) {
        const lvl = parseInt(levelMatch[1]);
        h += `<div class="text-xs mb-1 px-2 py-1 rounded border inline-block" style="background:rgba(78,159,229,0.08);border-color:rgba(78,159,229,0.35);color:var(--c-accent)">Level ${lvl}/8</div> `;
      }
    }

    // Description — for replaced workouts, show original distance instead of "0km (replaced)"
    if (isReplaced && w.originalDistance) {
      const origDesc = injectPaces(w.originalDistance, paces).replace(/\n/g, '<br>');
      h += `<div class="text-xs mb-1" style="color:var(--c-muted)"><s>${origDesc}</s> <span style="color:var(--c-accent)">(replaced)</span></div>`;
    } else {
      h += `<div class="text-xs mb-1" style="color:var(--c-muted)">${injectPaces(w.d, paces).replace(/\n/g, '<br>')}</div>`;
    }
    if (!isCompleteRest && !isReplaced) {
      if (rtd) {
        const rpeVal = typeof rtd === 'number' ? rtd : (w.rpe || w.r || 5);
        const hasITrimp = garminActual && garminActual.iTrimp != null && garminActual.iTrimp > 0;
        const actualTSSVal = hasITrimp
          ? Math.round((garminActual!.iTrimp! * 100) / 15000)
          : garminActual && garminActual.durationSec > 0
            ? Math.round((garminActual.durationSec / 60) * (TL_PER_MIN[Math.round(rpeVal)] ?? 0.92))
            : null;
        // Data tier badge
        const hasGarminTE = garminActual && (garminActual.aerobicEffect != null || garminActual.anaerobicEffect != null);
        const dataTierLabel = hasITrimp ? '<span style="color:rgba(34,197,94,0.6)">Strava HR</span>'
          : hasGarminTE ? '<span style="color:rgba(78,159,229,0.6)">Garmin TE</span>'
          : garminActual ? '<span style="color:var(--c-faint)">RPE est.</span>'
          : '';
        if (actualTSSVal != null) {
          // Zone breakdown — use real hrZones if available, else fall back to workout type profile
          let zBase = 0, zThreshold = 0, zIntensity = 0;
          const hz = garminActual?.hrZones;
          const hzTotal = hz ? (hz.z1 + hz.z2 + hz.z3 + hz.z4 + hz.z5) : 0;
          if (hz && hzTotal > 0) {
            zBase      = Math.round(actualTSSVal * (hz.z1 + hz.z2) / hzTotal);
            zThreshold = Math.round(actualTSSVal * hz.z3 / hzTotal);
            zIntensity = actualTSSVal - zBase - zThreshold; // avoid rounding gap
          } else {
            const prof = LOAD_PROFILES[w.t] ?? { base: 0.80, threshold: 0.15, intensity: 0.05 };
            zBase      = Math.round(actualTSSVal * (prof.base      ?? 0.80));
            zThreshold = Math.round(actualTSSVal * (prof.threshold ?? 0.15));
            zIntensity = actualTSSVal - zBase - zThreshold;
          }
          const hasHR = hz && hzTotal > 0;
          h += `<div class="text-xs mb-0.5" style="color:var(--c-faint)">TSS: <span class="font-medium" style="color:var(--c-ok)">${actualTSSVal}</span>${dataTierLabel ? ` · ${dataTierLabel}` : ''}${!hasHR ? ` · <span style="color:rgba(202,138,4,0.6)">Estimated</span>` : ''}</div>`;
          const zoneDefs = [
            { label: 'Base',      val: zBase,      colStyle: 'rgba(59,130,246,0.7)' },
            { label: 'Threshold', val: zThreshold, colStyle: 'rgba(245,158,11,0.7)' },
            { label: 'Intensity', val: zIntensity, colStyle: 'rgba(249,115,22,0.7)' },
          ];
          // Scale bars relative to the largest zone so the dominant zone always hits 100%
          const maxZoneVal = Math.max(zBase, zThreshold, zIntensity, 1);
          h += `<div class="space-y-0.5 mb-1">`;
          for (const zd of zoneDefs) {
            if (zd.val <= 0) continue;
            const pct = Math.round((zd.val / maxZoneVal) * 100);
            h += `<div class="flex items-center gap-1 text-xs"><span class="w-14 shrink-0" style="color:var(--c-border)">${zd.label}</span><div class="h-1 rounded-full w-16 overflow-hidden" style="background:rgba(0,0,0,0.08)"><div class="h-full rounded-full" style="width:${pct}%;background:${zd.colStyle}"></div></div><span style="color:var(--c-muted)">${zd.val}</span></div>`;
          }
          h += `</div>`;
          if (!hasHR) {
            h += `<div class="text-[10px] mb-1" style="color:rgba(202,138,4,0.4)">Zone split estimated — HR stream data unavailable.</div>`;
          }
        }
        // Garmin Training Effect aerobic/anaerobic split (0-5 scale, separate from TL)
        if (hasGarminTE) {
          const ae = garminActual!.aerobicEffect != null ? garminActual!.aerobicEffect.toFixed(1) : '—';
          const ane = garminActual!.anaerobicEffect != null ? garminActual!.anaerobicEffect.toFixed(1) : '—';
          h += `<div class="text-xs mb-1" style="color:var(--c-border)">Training Effect: <span style="color:rgba(239,68,68,0.7)">${ae} aerobic</span> · <span style="color:rgba(245,158,11,0.7)">${ane} anaerobic</span></div>`;
        }
      } else {
        // Show planned TSS (converted from FCL scale) with 3-zone breakdown
        // Zones are derived first; total is their sum to avoid rounding mismatches
        const rpeVal = w.rpe || w.r || 5;
        const scale = (TL_PER_MIN[Math.round(rpeVal)] ?? 1.0) / (LOAD_PER_MIN_BY_INTENSITY[Math.round(rpeVal)] ?? 2.0);
        const pBase      = loads.base      != null ? Math.round(loads.base      * scale) : null;
        const pThreshold = loads.threshold != null ? Math.round(loads.threshold * scale) : null;
        const pIntensity = loads.intensity != null ? Math.round(loads.intensity * scale) : null;
        // If zone data available, sum zones for total so numbers always add up
        const plannedTSS = (pBase != null)
          ? (pBase ?? 0) + (pThreshold ?? 0) + (pIntensity ?? 0)
          : Math.round(loads.total * scale);
        const zoneParts: string[] = [];
        if (pBase      != null && pBase      > 0) zoneParts.push(`<span style="color:rgba(59,130,246,0.8)">${pBase} base</span>`);
        if (pThreshold != null && pThreshold > 0) zoneParts.push(`<span style="color:rgba(245,158,11,0.8)">${pThreshold} threshold</span>`);
        if (pIntensity != null && pIntensity > 0) zoneParts.push(`<span style="color:rgba(249,115,22,0.8)">${pIntensity} intensity</span>`);
        const zoneStr = zoneParts.length ? ` <span style="color:var(--c-border)">·</span> ${zoneParts.join(' <span style="color:var(--c-border)">·</span> ')}` : '';
        h += `<div class="text-xs mb-1" style="color:var(--c-faint)">Planned TSS: <span class="font-medium" style="color:var(--c-muted)">${plannedTSS}</span>${zoneStr}</div>`;
      }
    }

    // Pace info
    if (workoutInfo.avgPace) {
      const paceLabel = w.t === 'easy' ? 'No faster than' : 'Pace';
      h += `<div class="text-xs mb-1 p-1 rounded" style="color:var(--c-accent);background:rgba(78,159,229,0.06)">`;
      h += `${paceLabel}: ${formatPace(workoutInfo.avgPace)}`;
      h += `</div>`;
    }

    // Garmin actual vs planned comparison
    if (garminActual) {
      h += renderGarminActuals(garminActual, workoutInfo);

      // Strava detail panel (HR zones, km splits, route map) — shown on expand
      if (garminActual.hrZones || garminActual.kmSplits?.length || garminActual.polyline) {
        const detailId = 'gd-' + escapeAttr(w.id || w.n);
        h += `<button onclick="window.toggleStravaDetail('${detailId}')" class="flex items-center gap-1 text-[11px] mt-1.5 transition-colors" style="color:var(--c-faint)">`;
        h += `<svg id="${detailId}-chevron" class="w-3 h-3 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>`;
        h += `Strava details</button>`;
        h += `<div id="${detailId}" class="hidden mt-1.5 space-y-2.5">`;

        if (garminActual.hrZones) {
          const z = garminActual.hrZones;
          const total = z.z1 + z.z2 + z.z3 + z.z4 + z.z5;
          if (total > 0) {
            const pct = (v: number) => ((v / total) * 100).toFixed(1);
            h += `<div>`;
            h += `<div class="text-[10px] mb-1 font-medium uppercase tracking-wide" style="color:var(--c-muted)">HR Zones</div>`;
            h += `<div class="flex rounded overflow-hidden h-2.5 w-full">`;
            if (z.z1 > 0) h += `<div style="width:${pct(z.z1)}%;background:#3B82F6" title="Z1 ${fmtZoneTime(z.z1)}"></div>`;
            if (z.z2 > 0) h += `<div style="width:${pct(z.z2)}%;background:#22C55E" title="Z2 ${fmtZoneTime(z.z2)}"></div>`;
            if (z.z3 > 0) h += `<div style="width:${pct(z.z3)}%;background:#FACC15" title="Z3 ${fmtZoneTime(z.z3)}"></div>`;
            if (z.z4 > 0) h += `<div style="width:${pct(z.z4)}%;background:#F97316" title="Z4 ${fmtZoneTime(z.z4)}"></div>`;
            if (z.z5 > 0) h += `<div style="width:${pct(z.z5)}%;background:#EF4444" title="Z5 ${fmtZoneTime(z.z5)}"></div>`;
            h += `</div>`;
            h += `<div class="flex gap-2 mt-1 flex-wrap">`;
            const zoneDefs = [
              { k: 'z1' as const, label: 'Z1', dotColor: '#3B82F6' },
              { k: 'z2' as const, label: 'Z2', dotColor: '#22C55E' },
              { k: 'z3' as const, label: 'Z3', dotColor: '#FACC15' },
              { k: 'z4' as const, label: 'Z4', dotColor: '#F97316' },
              { k: 'z5' as const, label: 'Z5', dotColor: '#EF4444' },
            ];
            for (const { k, label, dotColor } of zoneDefs) {
              const sec = z[k];
              if (sec > 0) h += `<span class="flex items-center gap-0.5 text-[10px]" style="color:var(--c-muted)"><span class="inline-block w-2 h-2 rounded-sm" style="background:${dotColor}"></span>${label} ${fmtZoneTime(sec)}</span>`;
            }
            h += `</div></div>`;
          }
        }

        if (garminActual.kmSplits && garminActual.kmSplits.length > 0) {
          h += `<div>`;
          h += `<div class="text-[10px] mb-1 font-medium uppercase tracking-wide" style="color:var(--c-muted)">Km Splits</div>`;
          h += `<div class="grid grid-cols-4 gap-x-3 gap-y-0.5">`;
          for (let i = 0; i < garminActual.kmSplits.length; i++) {
            h += `<div class="flex justify-between text-[11px]">`;
            h += `<span style="color:var(--c-faint)">${i + 1}</span>`;
            h += `<span class="font-mono" style="color:var(--c-black)">${formatPace(garminActual.kmSplits[i])}</span>`;
            h += `</div>`;
          }
          h += `</div></div>`;
        }

        if (garminActual.polyline) {
          const splitsAttr = garminActual.kmSplits?.length
            ? ` data-km-splits="${escapeAttr(JSON.stringify(garminActual.kmSplits))}"`
            : '';
          h += `<div>`;
          h += `<div class="text-[10px] mb-1 font-medium uppercase tracking-wide" style="color:var(--c-muted)">Route</div>`;
          h += `<canvas id="${detailId}-map" class="w-full rounded" height="200" style="background:var(--c-surface)" data-polyline="${escapeAttr(garminActual.polyline)}"${splitsAttr}></canvas>`;
          h += `</div>`;
        }

        h += `</div>`; // end detail panel
      }
    }

    // HR target pill (conditional — only rendered if data exists and workout not yet done)
    if (w.hrTarget && !rtd) {
      h += `<div class="text-xs mb-1 px-2 py-1 rounded-full inline-flex items-center gap-1 border" style="background:rgba(239,68,68,0.06);border-color:rgba(239,68,68,0.3);color:var(--c-warn)">`;
      h += `<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"/></svg>`;
      h += `<span>${w.hrTarget.label}</span>`;
      h += `</div>`;
    }

    // Rating buttons (disabled when viewing non-current week)
    if (!isReplaced && !viewOnly) {
      const wId = w.id || w.n;
      if (isCompleteRest) {
        // Complete rest (RICE / no physical activity): simple complete button, no RPE needed
        if (rtd) {
          h += `<div class="flex items-center gap-2 py-1.5">`;
          h += `<span class="w-5 h-5 rounded-full flex items-center justify-center" style="background:var(--c-ok)"><svg class="w-3 h-3" style="color:white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span>`;
          h += `<span class="text-xs font-semibold" style="color:var(--c-ok)">Complete</span>`;
          h += `</div>`;
        } else {
          h += `<button onclick="window.rate('${wId.replace(/'/g, "\\'")}','${w.n.replace(/'/g, "\\'")}',1,1,'${w.t}',false)" class="w-full mt-1 py-1.5 text-xs rounded font-medium" style="background:var(--c-ok);color:white">Complete Rest Day</button>`;
        }
      } else if (w.t === 'capacity_test' && (w as any).testType) {
        if (w.status === 'passed') {
          h += `<div class="flex items-center gap-2 py-1.5">`;
          h += `<span class="w-5 h-5 rounded-full flex items-center justify-center" style="background:var(--c-ok)"><svg class="w-3 h-3" style="color:white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span>`;
          h += `<span class="text-xs font-semibold" style="color:var(--c-ok)">PASSED</span>`;
          h += `</div>`;
        } else {
          h += `<div class="text-xs mb-1" style="color:#A855F7">Physio Test Status:</div>`;
          h += `<div class="grid grid-cols-2 gap-2">`;
          h += `<button onclick="window.rateCapacityTest('${(w as any).testType}', false)" class="px-2 py-1.5 text-xs border rounded" style="border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.06);color:var(--c-warn)">Had Pain</button>`;
          h += `<button onclick="window.rateCapacityTest('${(w as any).testType}', true)" class="px-2 py-1.5 text-xs border rounded font-bold" style="border-color:rgba(34,197,94,0.4);background:rgba(34,197,94,0.06);color:var(--c-ok)">Pain-Free!</button>`;
          h += `</div>`;
        }
      } else if (!isRunWorkout) {
        // Non-running (cross, strength, rest): simple mark as done, no RPE needed
        if (rtd) {
          h += `<button onclick="window.unrateWorkout('${wId.replace(/'/g, "\\'")}')" class="w-full mt-1 text-xs py-0.5 rounded" style="background:rgba(0,0,0,0.06);color:var(--c-muted)">Unmark as done</button>`;
        } else {
          h += `<button onclick="window.rate('${wId.replace(/'/g, "\\'")}','${w.n.replace(/'/g, "\\'")}',${w.rpe || w.r},${w.rpe || w.r},'${w.t}',${isSkipped})" class="w-full mt-1 py-1.5 text-xs rounded font-medium" style="background:var(--c-ok);color:white">Mark as done</button>`;
        }
      } else {
        // Running: ask for RPE (always same label; highlight current selection)
        const currentRpe = rtd ? parseInt(String(rtd)) : 0;
        h += `<div class="text-xs mb-1" style="color:var(--c-muted)">RPE:</div><div class="grid grid-cols-10 gap-0.5">`;
        for (let r = 1; r <= 10; r++) {
          const sel = r === currentRpe;
          const btnStyle = sel
            ? 'border-color:var(--c-ok);background:var(--c-ok);color:white;font-weight:bold'
            : 'border-color:var(--c-border);background:rgba(0,0,0,0.04);color:var(--c-muted)';
          h += `<button onclick="window.rate('${wId.replace(/'/g, "\\'")}','${w.n.replace(/'/g, "\\'")}',${r},${w.rpe || w.r},'${w.t}',${isSkipped})" class="px-0.5 py-0.5 text-xs border rounded" style="${btnStyle}">${r}</button>`;
        }
        h += `</div>`;
        if (rtd) {
          h += `<button onclick="window.unrateWorkout('${wId.replace(/'/g, "\\'")}')" class="w-full mt-1 text-xs py-0.5 rounded" style="background:rgba(0,0,0,0.06);color:var(--c-muted)">Unmark as done</button>`;
        }
      }
    } else if (!isReplaced && viewOnly && rtd) {
      if (isCompleteRest) {
        h += `<div class="text-xs" style="color:var(--c-ok)">Rested</div>`;
      } else if (!isRunWorkout) {
        h += `<div class="text-xs" style="color:var(--c-ok)">Done</div>`;
      } else {
        h += `<div class="text-xs" style="color:var(--c-faint)">Rated RPE ${rtd}</div>`;
      }
    }

    // Track Run / inline GPS tracking (hide for cross-training/sport/gym workouts, disabled when viewing)
    if (!isReplaced && w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest' && w.t !== 'gym') {
      const gpsRecId = wk.gpsRecordings?.[w.id || w.n];
      if (gpsRecId && rtd) {
        // Completed with GPS — show "View Run" button
        h += `<button class="gps-view-btn w-full mt-1 text-xs py-1 rounded font-medium" style="background:var(--c-ok);color:white" data-recid="${escapeAttr(gpsRecId)}">View Run</button>`;
      } else if (!viewOnly && !rtd) {
        const tracking = isTrackingActive();
        if (tracking && getActiveWorkoutName() === w.n) {
          const gpsData = getActiveGpsData();
          if (gpsData) {
            h += renderInlineGpsHtml(gpsData);
          }
        } else if (tracking) {
          h += `<button class="w-full mt-1 text-xs py-0.5 rounded font-medium cursor-not-allowed" style="background:rgba(0,0,0,0.06);color:var(--c-faint)" disabled>Tracking in progress...</button>`;
        } else {
          h += `<button class="gps-track-btn w-full mt-1 text-xs py-1.5 rounded font-bold" style="background:var(--c-ok);color:white" data-name="${escapeAttr(w.n)}" data-desc="${escapeAttr(w.d)}">Start Run</button>`;
        }
      }
    }

    // Skip button — only for unrated (planned) workouts
    if (!viewOnly && !rtd) {
      const skipId = w.id || w.n;
      const skipBtnStyle = isSkipped
        ? 'background:rgba(239,68,68,0.12);color:var(--c-warn)'
        : isReplaced
          ? 'background:rgba(6,182,212,0.08);color:var(--c-accent);cursor:not-allowed'
          : 'background:rgba(0,0,0,0.06);color:var(--c-muted)';
      h += `<button onclick="window.skip('${skipId.replace(/'/g, "\\'")}','${w.n.replace(/'/g, "\\'")}','${w.t}',${isSkipped},${w.skipCount || 0},'${w.d.replace(/'/g, "\\'")}',${w.rpe || w.r},${w.dayOfWeek},'${w.dayName || ''}')" class="w-full mt-1 text-xs py-0.5 rounded" style="${skipBtnStyle}" ${isReplaced ? 'disabled' : ''}>${isSkipped ? 'Skip Again' : isReplaced ? 'Covered' : 'Skip'}</button>`;
    }

    h += `</div>`;
  }

  h += `</div>`;

  return h;
}

/**
 * Render a dedicated section for Garmin-synced activities that are NOT planned workouts.
 * These are ad-hoc entries (id starts with "garmin-") stored in wk.adhocWorkouts.
 * They appear here rather than in the main workout list so they don't inflate the
 * completion counter or mislead the user into thinking they have unrated planned workouts.
 */

/** Convert an internal workout key (e.g. "W1-easy-0") to a human label ("Easy Run"). */
function cleanGarminKeyName(key: string): string {
  const TYPE_LABELS: Record<string, string> = {
    easy: 'Easy Run', long: 'Long Run', threshold: 'Threshold Run',
    vo2: 'VO2 Run', marathon_pace: 'Marathon Pace Run', intervals: 'Intervals',
    cross: 'Cross Training', gym: 'Gym', strength: 'Strength Training',
    rest: 'Rest', recovery: 'Recovery Run', progressive: 'Progressive Run',
    hill_repeats: 'Hill Repeats', race_pace: 'Race Pace Run', tempo: 'Tempo Run',
  };
  const typeKey = key.replace(/^W\d+-/, '').replace(/-\d+$/, '');
  return TYPE_LABELS[typeKey] || typeKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Format zone time as M:SS */
function fmtZoneTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Derive the activity source label from the garmin_id prefix.
 * strava-NNN → 'Strava', apple-NNN → 'Apple Watch', numeric/other → 'Garmin'
 */
function getActivitySource(garminId?: string | null): 'Strava' | 'Apple Watch' | 'Garmin' {
  if (!garminId) return 'Garmin';
  if (garminId.startsWith('strava-')) return 'Strava';
  if (garminId.startsWith('apple-')) return 'Apple Watch';
  return 'Garmin';
}

/** Render a source badge pill */
function sourceBadge(source: 'Strava' | 'Apple Watch' | 'Garmin'): string {
  if (source === 'Strava') {
    return `<span class="px-1 py-0.5 rounded text-[10px] border" style="background:rgba(168,85,247,0.08);color:#A855F7;border-color:rgba(168,85,247,0.25)">Strava</span>`;
  }
  if (source === 'Apple Watch') {
    return `<span class="px-1 py-0.5 rounded text-[10px] border" style="background:rgba(0,0,0,0.05);color:var(--c-muted);border-color:var(--c-border)">Apple Watch</span>`;
  }
  return `<span class="px-1 py-0.5 rounded text-[10px] border" style="background:rgba(249,115,22,0.08);color:#F97316;border-color:rgba(249,115,22,0.25)">Garmin</span>`;
}

/** Format a date string as "24 Feb" */
function fmtActivityDate(isoString?: string | null): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

function renderGarminSyncedSection(wk: Week): string {
  // Matched activities: everything in garminActuals
  const actuals = wk.garminActuals || {};
  const matchedRows = Object.entries(actuals).map(([workoutId, a]: [string, any]) => {
    const displayName: string | undefined = a.displayName !== 'General Sport' ? a.displayName : undefined;
    const name: string = a.workoutName || displayName || cleanGarminKeyName(workoutId);
    return {
      name,
      workoutId,
      garminId: a.garminId as string | undefined,
      startTime: a.startTime as string | null | undefined,
      distanceKm: a.distanceKm as number,
      avgPaceSecKm: a.avgPaceSecKm as number | null,
      avgHR: a.avgHR as number | null,
      durationSec: a.durationSec as number,
      calories: a.calories as number | null,
      hrZones: a.hrZones as { z1: number; z2: number; z3: number; z4: number; z5: number } | null | undefined,
      kmSplits: a.kmSplits as number[] | null | undefined,
      polyline: a.polyline as string | null | undefined,
    };
  });

  // Unmatched adhoc activities: id starts with "garmin-", sorted chronologically
  const adhocGarmin = (wk.adhocWorkouts || [])
    .filter(w => w.id?.startsWith('garmin-'))
    .slice()
    .sort((a, b) => {
      const ta = (a as any).garminTimestamp ?? '';
      const tb = (b as any).garminTimestamp ?? '';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

  // Pending items: in garminPending but not yet reviewed (garminMatched === '__pending__')
  const garminMatched = wk.garminMatched || {};
  const pendingItems = (wk.garminPending || []).filter(p => garminMatched[p.garminId] === '__pending__');

  if (matchedRows.length === 0 && adhocGarmin.length === 0 && pendingItems.length === 0) return '';

  let h = `<div class="mt-3 p-3 rounded border" style="background:var(--c-surface);border-color:rgba(249,115,22,0.25)">`;
  h += `<div class="font-bold text-sm mb-2 flex items-center justify-between gap-2" style="color:#F97316">`;
  h += `<div class="flex items-center gap-2">`;
  h += `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`;
  h += `Synced activities`;
  h += `</div>`;
  h += `<button onclick="window.openActivityReReview()" class="text-xs transition-colors font-normal" style="color:var(--c-muted)">Review</button>`;
  h += `</div>`;
  h += `<div class="space-y-1.5">`;

  // ── Matched plan slot activities ──
  for (const row of matchedRows) {
    const source = getActivitySource(row.garminId);
    const distStr = row.distanceKm > 0 ? `${row.distanceKm.toFixed(1)} km` : '';
    const paceStr = row.avgPaceSecKm ? formatPace(row.avgPaceSecKm) : '';
    const hrStr = row.avgHR ? `HR ${row.avgHR}` : '';
    const durStr = !distStr && row.durationSec > 0 ? `${Math.round(row.durationSec / 60)} min` : '';
    const calStr = row.calories ? `${row.calories} kcal` : '';
    const dateStr = fmtActivityDate(row.startTime);
    const meta = [distStr || durStr, paceStr, hrStr, dateStr, calStr].filter(Boolean).join(' · ');

    const hasDetail = row.hrZones != null || (row.kmSplits?.length ?? 0) > 0 || !!row.polyline;
    const expandId = `sd-${escapeAttr(row.garminId ?? row.workoutId)}`;

    h += `<div class="border rounded text-xs overflow-hidden" style="background:rgba(0,0,0,0.03);border-color:var(--c-border)">`;

    // Summary row
    h += `<div class="flex items-center justify-between px-2 py-1.5${hasDetail ? ' cursor-pointer transition-colors' : ''}"`;
    if (hasDetail) h += ` onclick="window.toggleStravaDetail('${expandId}')"`;
    h += `>`;
    h += `<div class="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">`;
    h += sourceBadge(source);
    h += `<span class="font-medium" style="color:var(--c-black)">${row.name}</span>`;
    if (meta) h += `<span style="color:var(--c-muted)">${meta}</span>`;
    h += `</div>`;
    if (hasDetail) h += `<svg id="${expandId}-chevron" class="w-3 h-3 transition-transform flex-shrink-0 mr-1" style="color:var(--c-faint)" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>`;
    if (row.garminId) h += `<button onclick="event.stopPropagation();window.removeGarminActivity('${escapeAttr(row.garminId)}')" class="text-xs transition-colors px-1 flex-shrink-0" style="color:var(--c-faint)" title="Remove">&times;</button>`;
    h += `</div>`;

    // Expanded detail panel (HR zones, km splits, route map)
    if (hasDetail) {
      h += `<div id="${expandId}" class="hidden px-2 pb-2 pt-2 space-y-2.5 border-t" style="border-color:var(--c-border)">`;

      if (row.hrZones) {
        const z = row.hrZones;
        const total = z.z1 + z.z2 + z.z3 + z.z4 + z.z5;
        if (total > 0) {
          const pct = (s: number) => ((s / total) * 100).toFixed(1);
          h += `<div>`;
          h += `<div class="text-[10px] mb-1 font-medium uppercase tracking-wide" style="color:var(--c-muted)">HR Zones</div>`;
          h += `<div class="flex rounded overflow-hidden h-2.5 w-full">`;
          if (z.z1 > 0) h += `<div style="width:${pct(z.z1)}%;background:#3B82F6" title="Z1 ${fmtZoneTime(z.z1)}"></div>`;
          if (z.z2 > 0) h += `<div style="width:${pct(z.z2)}%;background:#22C55E" title="Z2 ${fmtZoneTime(z.z2)}"></div>`;
          if (z.z3 > 0) h += `<div style="width:${pct(z.z3)}%;background:#FACC15" title="Z3 ${fmtZoneTime(z.z3)}"></div>`;
          if (z.z4 > 0) h += `<div style="width:${pct(z.z4)}%;background:#F97316" title="Z4 ${fmtZoneTime(z.z4)}"></div>`;
          if (z.z5 > 0) h += `<div style="width:${pct(z.z5)}%;background:#EF4444" title="Z5 ${fmtZoneTime(z.z5)}"></div>`;
          h += `</div>`;
          h += `<div class="flex gap-2 mt-1 flex-wrap">`;
          const zoneDefs = [
            { k: 'z1' as const, label: 'Z1', dotColor: '#3B82F6' },
            { k: 'z2' as const, label: 'Z2', dotColor: '#22C55E' },
            { k: 'z3' as const, label: 'Z3', dotColor: '#FACC15' },
            { k: 'z4' as const, label: 'Z4', dotColor: '#F97316' },
            { k: 'z5' as const, label: 'Z5', dotColor: '#EF4444' },
          ];
          for (const { k, label, dotColor } of zoneDefs) {
            const sec = z[k];
            if (sec > 0) h += `<span class="flex items-center gap-0.5 text-[10px]" style="color:var(--c-muted)"><span class="inline-block w-2 h-2 rounded-sm" style="background:${dotColor}"></span>${label} ${fmtZoneTime(sec)}</span>`;
          }
          h += `</div></div>`;
        }
      }

      if (row.kmSplits && row.kmSplits.length > 0) {
        h += `<div>`;
        h += `<div class="text-[10px] mb-1 font-medium uppercase tracking-wide" style="color:var(--c-muted)">Km Splits</div>`;
        h += `<div class="grid grid-cols-4 gap-x-3 gap-y-0.5">`;
        for (let i = 0; i < row.kmSplits.length; i++) {
          h += `<div class="flex justify-between text-[11px]">`;
          h += `<span style="color:var(--c-faint)">${i + 1}</span>`;
          h += `<span class="font-mono" style="color:var(--c-black)">${formatPace(row.kmSplits[i])}</span>`;
          h += `</div>`;
        }
        h += `</div></div>`;
      }

      if (row.polyline) {
        const splitsAttr = row.kmSplits?.length
          ? ` data-km-splits="${escapeAttr(JSON.stringify(row.kmSplits))}"`
          : '';
        h += `<div>`;
        h += `<div class="text-[10px] mb-1 font-medium uppercase tracking-wide" style="color:var(--c-muted)">Route</div>`;
        h += `<canvas id="${expandId}-map" class="w-full rounded" height="200" style="background:var(--c-surface)" data-polyline="${escapeAttr(row.polyline)}"${splitsAttr}></canvas>`;
        h += `</div>`;
      }

      h += `</div>`; // end detail panel
    }

    h += `</div>`; // end card
  }

  // ── Ad-hoc (unmatched) activities ──
  for (const w of adhocGarmin) {
    const rawId = w.id!.slice('garmin-'.length);
    const source = getActivitySource(rawId);
    const distKm = (w as any).garminDistKm as number | undefined;
    const avgHR = (w as any).garminAvgHR as number | null | undefined;
    const calories = (w as any).garminCalories as number | null | undefined;
    const avgPace = (w as any).garminAvgPace as number | null | undefined;
    const timestamp = (w as any).garminTimestamp as string | undefined;
    const durationMin = (w as any).garminDurationMin as number | undefined;

    const distStr = distKm && distKm > 0.1 ? `${distKm.toFixed(1)} km` : '';
    const durStr = !distStr && durationMin ? `${durationMin} min` : '';
    const paceStr = avgPace ? formatPace(avgPace) : '';
    const hrStr = avgHR ? `HR ${avgHR}` : '';
    const calStr = calories ? `${calories} kcal` : '';
    const dateStr = fmtActivityDate(timestamp);
    // Fallback: parse description if structured fields not available (legacy adhocs)
    const meta = [distStr || durStr, paceStr, hrStr, dateStr, calStr].filter(Boolean).join(' · ')
      || w.d || '';

    h += `<div class="flex items-center justify-between border rounded px-2 py-1.5 text-xs" style="background:rgba(0,0,0,0.03);border-color:var(--c-border)">`;
    h += `<div class="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">`;
    h += sourceBadge(source);
    h += `<span class="font-medium" style="color:var(--c-black)">${w.n}</span>`;
    if (meta) h += `<span style="color:var(--c-muted)">${meta}</span>`;
    h += `</div>`;
    h += `<button onclick="window.removeGarminActivity('${rawId}')" class="text-xs transition-colors px-1 flex-shrink-0" style="color:var(--c-faint)" title="Remove">&times;</button>`;
    h += `</div>`;
  }

  // ── Pending (unreviewed) items ──
  for (const p of pendingItems) {
    const source = getActivitySource(p.garminId);
    const distStr = p.distanceM && p.distanceM > 0 ? `${(p.distanceM / 1000).toFixed(1)} km` : '';
    const durStr = !distStr && p.durationSec ? `${Math.round(p.durationSec / 60)} min` : '';
    const hrStr = p.avgHR ? `HR ${p.avgHR}` : '';
    const calStr = p.calories ? `${p.calories} kcal` : '';
    const dateStr = fmtActivityDate(p.startTime);
    const meta = [distStr || durStr, hrStr, dateStr, calStr].filter(Boolean).join(' · ');
    // Use formatActivityType mapping for the label
    const label = p.activityType
      ? (p.activityType.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()))
      : 'Activity';

    h += `<div class="flex items-center justify-between border rounded px-2 py-1.5 text-xs" style="background:rgba(245,158,11,0.05);border-color:rgba(245,158,11,0.3)">`;
    h += `<div class="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">`;
    h += sourceBadge(source);
    h += `<span class="font-medium" style="color:var(--c-caution)">${label}</span>`;
    h += `<span class="text-[10px]" style="color:rgba(245,158,11,0.7)">pending review</span>`;
    if (meta) h += `<span style="color:var(--c-muted)">${meta}</span>`;
    h += `</div>`;
    h += `</div>`;
  }

  h += `</div>`;
  h += `</div>`;
  return h;
}

/**
 * Render cross-training form
 */
function renderCrossTrainingForm(): string {
  const inputStyle = 'background:var(--c-bg);border:1px solid var(--c-border);color:var(--c-black)';
  let h = `<div id="crossForm" class="mt-3 p-3 rounded border" style="background:var(--c-surface);border-color:var(--c-border)">`;
  h += `<div class="font-bold text-sm mb-2" style="color:var(--c-black)">Manual upload</div>`;
  h += `<div class="grid grid-cols-3 gap-1 mb-2">`;
  h += `<select id="crossSport" class="text-xs rounded px-1 py-1" style="${inputStyle}">`;
  h += `<option value="generic_sport">Activity</option>`;
  h += `<option value="run">Run</option>`;
  h += `<option value="cycling">Cycling</option>`;
  h += `<option value="swimming">Swimming</option>`;
  h += `<option value="elliptical">Elliptical</option>`;
  h += `<option value="yoga">Yoga</option>`;
  h += `<option value="gym">Strength</option>`;
  h += `<option value="hiking">Hiking</option>`;
  h += `<option value="rowing">Rowing</option>`;
  h += `<option value="rest">Rest/Recovery</option>`;
  h += `</select>`;
  h += `<input type="number" id="crossDur" placeholder="Duration (min)" class="text-xs rounded px-1 py-1" style="${inputStyle}" min="1" max="600">`;
  h += `<div class="relative"><input type="number" id="crossRPE" placeholder="RPE (1-10)" class="text-xs rounded px-1 py-1 w-full" style="${inputStyle}" min="1" max="10">`;
  h += `<span class="rpe-help absolute right-1 top-1 cursor-help text-xs" style="color:var(--c-faint)" title="1-3: Easy conversation\n4-6: Short sentences\n7-8: 1-2 words\n9-10: Gasping/Max">(?)</span></div>`;
  h += `</div>`;
  h += `<button onclick="window.logActivity()" class="w-full py-1.5 rounded text-xs font-bold" style="background:var(--c-ok);color:white">Add Activity</button>`;
  h += `</div>`;
  return h;
}

function isHardWorkoutType(workoutType: string): boolean {
  return ['threshold', 'vo2', 'race_pace', 'marathon_pace', 'intervals', 'long', 'mixed', 'progressive'].includes(workoutType);
}

/** Get color styles for a workout type: { bgStyle, borderColor, accentColor } */
function getWorkoutColors(wt: string): { bgStyle: string; borderColor: string; accentColor: string; bg: string; border: string; accent: string } {
  // Legacy class fields kept for any remaining references; primary values are inline style fields
  switch (wt) {
    case 'easy':
      return { bgStyle: 'rgba(34,197,94,0.06)', borderColor: 'rgba(34,197,94,0.35)', accentColor: 'var(--c-ok)', bg: '', border: '', accent: '' };
    case 'long':
      return { bgStyle: 'rgba(59,130,246,0.06)', borderColor: 'rgba(59,130,246,0.35)', accentColor: 'var(--c-accent)', bg: '', border: '', accent: '' };
    case 'threshold':
    case 'marathon_pace':
      return { bgStyle: 'rgba(168,85,247,0.06)', borderColor: 'rgba(168,85,247,0.35)', accentColor: '#A855F7', bg: '', border: '', accent: '' };
    case 'vo2':
    case 'intervals':
      return { bgStyle: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.35)', accentColor: 'var(--c-warn)', bg: '', border: '', accent: '' };
    case 'race_pace':
      return { bgStyle: 'rgba(249,115,22,0.06)', borderColor: 'rgba(249,115,22,0.35)', accentColor: '#F97316', bg: '', border: '', accent: '' };
    case 'mixed':
    case 'progressive':
      return { bgStyle: 'rgba(245,158,11,0.06)', borderColor: 'rgba(245,158,11,0.35)', accentColor: 'var(--c-caution)', bg: '', border: '', accent: '' };
    case 'return_run':
      return { bgStyle: 'rgba(78,159,229,0.06)', borderColor: 'rgba(78,159,229,0.35)', accentColor: 'var(--c-accent)', bg: '', border: '', accent: '' };
    case 'gym':
      return { bgStyle: 'rgba(139,92,246,0.06)', borderColor: 'rgba(139,92,246,0.35)', accentColor: '#8B5CF6', bg: '', border: '', accent: '' };
    case 'cross':
    case 'strength':
    case 'rest':
    case 'test_run':
      return { bgStyle: 'var(--c-bg)', borderColor: 'var(--c-border)', accentColor: 'var(--c-muted)', bg: '', border: '', accent: '' };
    default:
      return { bgStyle: 'var(--c-surface)', borderColor: 'var(--c-border)', accentColor: 'var(--c-muted)', bg: '', border: '', accent: '' };
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

    // Cache stream data for LT estimation if present
    if (activity.stream && activity.name) {
      storeWorkoutStream(activity.name, activity.stream);
    }

    // Generate current workouts to match against
    const wos = generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig, null, s.recurringActivities,
      undefined, undefined, undefined, s.w, s.tw, s.v, s.gs
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
          window.rate(matchedWorkout.id || matchedWorkout.n, matchedWorkout.n, 5, matchedWorkout.rpe || matchedWorkout.r || 5, matchedWorkout.t, false, activity.avgHR);
        }
      } else if (decision === 'keep-both') {
        // Log as separate cross-training — dispatch back as unmatched
        window.dispatchEvent(new CustomEvent('sync-activity-unmatched', { detail: activity }));
      }
      // 'ignore' → do nothing
    });
  }) as EventListener);
}

/** Format a time range string from estimated seconds. ±10% for short runs, longer runs get 5-10 min slack at the top. */
function fmtTimeRange(totalSec: number, workoutType: string): string {
  const totalMin = totalSec / 60;
  const lowMin = Math.round(totalMin * 0.9);
  // For longer runs (easy, long, progressive, marathon_pace), allow 5-10 min extra at the top
  const isLongType = ['easy', 'long', 'progressive', 'marathon_pace'].includes(workoutType);
  const extraTop = isLongType && totalMin >= 40 ? Math.min(10, Math.max(5, Math.round(totalMin * 0.15))) : 0;
  const highMin = Math.round(totalMin * 1.1) + extraTop;
  return `${lowMin}-${highMin} min`;
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

/** Render Garmin actual vs planned comparison */
function renderGarminActuals(actual: GarminActual, planned: { totalDistance: number; totalTime: number; avgPace: number | null }): string {
  let h = `<div class="text-xs mt-1 mb-1 p-2 border rounded" style="background:rgba(249,115,22,0.06);border-color:rgba(249,115,22,0.25)">`;
  h += `<div class="font-medium mb-1" style="color:#F97316">Actual (Garmin)</div>`;
  h += `<div class="grid grid-cols-2 gap-x-4 gap-y-0.5">`;

  // Distance: actual vs planned
  if (actual.distanceKm > 0) {
    const plannedKm = planned.totalDistance > 0 ? (planned.totalDistance / 1000) : 0;
    h += `<div style="color:var(--c-muted)">Distance</div>`;
    h += `<div style="color:var(--c-black)">${actual.distanceKm.toFixed(1)}km`;
    if (plannedKm > 0) {
      const diff = actual.distanceKm - plannedKm;
      const diffColor = Math.abs(diff) < 0.5 ? 'var(--c-faint)' : diff > 0 ? 'var(--c-ok)' : 'var(--c-caution)';
      h += ` <span style="color:${diffColor}">(${diff >= 0 ? '+' : ''}${diff.toFixed(1)})</span>`;
    }
    h += `</div>`;
  }

  // Pace: actual vs planned
  if (actual.avgPaceSecKm != null && actual.avgPaceSecKm > 0) {
    h += `<div style="color:var(--c-muted)">Avg Pace</div>`;
    h += `<div style="color:var(--c-black)">${formatPace(actual.avgPaceSecKm)}`;
    if (planned.avgPace != null && planned.avgPace > 0) {
      const diff = actual.avgPaceSecKm - planned.avgPace;
      // For pace, faster (negative diff) is good
      const diffColor = Math.abs(diff) < 5 ? 'var(--c-faint)' : diff < 0 ? 'var(--c-ok)' : 'var(--c-caution)';
      const diffSec = Math.round(Math.abs(diff));
      h += ` <span style="color:${diffColor}">(${diff < 0 ? '-' : '+'}${diffSec}s)</span>`;
    }
    h += `</div>`;
  }

  // Duration
  if (actual.durationSec > 0) {
    const durMin = Math.round(actual.durationSec / 60);
    h += `<div style="color:var(--c-muted)">Duration</div>`;
    h += `<div style="color:var(--c-black)">${durMin} min</div>`;
  }

  // Avg HR
  if (actual.avgHR != null) {
    h += `<div style="color:var(--c-muted)">Avg HR</div>`;
    h += `<div style="color:var(--c-black)">${actual.avgHR} bpm</div>`;
  }

  h += `</div>`;

  // Lap splits (if available)
  if (actual.laps && actual.laps.length > 1) {
    h += `<details class="mt-1.5"><summary class="cursor-pointer" style="color:var(--c-muted)">Lap splits (${actual.laps.length})</summary>`;
    h += `<div class="mt-1 space-y-0.5">`;
    for (const lap of actual.laps) {
      const lapDistKm = (lap.distanceM / 1000).toFixed(2);
      h += `<div class="flex justify-between" style="color:var(--c-muted)">`;
      h += `<span>Lap ${lap.index}</span>`;
      h += `<span>${formatPace(lap.avgPaceSecKm)} · ${lapDistKm}km${lap.avgHR ? ` · ${lap.avgHR}bpm` : ''}</span>`;
      h += `</div>`;
    }
    h += `</div></details>`;
  }

  h += `</div>`;
  return h;
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
    const trackBtn = (e.target as HTMLElement).closest('.gps-track-btn') as HTMLElement | null;
    if (trackBtn) {
      const name = trackBtn.dataset.name || '';
      const desc = trackBtn.dataset.desc || '';
      if (window.trackWorkout) {
        window.trackWorkout(name, desc);
      }
      return;
    }

    const viewBtn = (e.target as HTMLElement).closest('.gps-view-btn') as HTMLElement | null;
    if (viewBtn) {
      const recId = viewBtn.dataset.recid || '';
      if (recId) {
        const rec = loadGpsRecording(recId);
        if (rec) openGpsRecordingDetail(rec);
      }
    }
  };

  const woEl = document.getElementById('wo');
  if (woEl) woEl.addEventListener('click', handler);

}
