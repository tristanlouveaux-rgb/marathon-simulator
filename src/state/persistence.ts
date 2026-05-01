import type { SimulatorState, CrossActivity, RunnerType } from '@/types';
import type { GarminPendingItem } from '@/types/state';
import { savePlanSettings } from '@/data/planSettingsSync';
import { STATE_SCHEMA_VERSION, RUNNER_TYPE_SEMANTICS_FIX_VERSION, TRIATHLON_FIELDS_VERSION, VO2_DEVICE_ONLY_VERSION } from '@/types/state';
import { defaultOnboardingState } from '@/types/onboarding';
import { setState, setCrossActivities, getState, getCrossActivities, getDefaultState } from './store';
import { ft } from '@/utils/format';
import { clearAllGpsData } from '@/gps/persistence';
import { getWeeklyExcess, computePlannedSignalB } from '@/calculations/fitness-model';

const STATE_KEY = 'marathonSimulatorState';
const CROSS_KEY = 'marathonSimulatorCross';

/**
 * Swap Speed↔Endurance for runner type migration.
 * Balanced stays unchanged.
 */
function swapRunnerTypeLabel(type: RunnerType | null | undefined): RunnerType | null {
  if (type === 'Speed') return 'Endurance';
  if (type === 'Endurance') return 'Speed';
  if (type === 'Balanced') return 'Balanced';
  return null;
}

/**
 * Migrate state from older schema versions to current.
 *
 * Version 2: Runner type semantics fix (Speed↔Endurance swap)
 * - Before: b < 1.06 → "Speed", b > 1.12 → "Endurance" (INVERTED)
 * - After: b < 1.06 → "Endurance", b > 1.12 → "Speed" (CORRECT)
 *
 * Persisted runner types need to be swapped to preserve user intent.
 */
function migrateState(loaded: SimulatorState): SimulatorState {
  const currentVersion = loaded.schemaVersion || 1;

  if (currentVersion >= STATE_SCHEMA_VERSION) {
    return loaded; // Already up to date
  }

  console.log(`Migrating state from version ${currentVersion} to ${STATE_SCHEMA_VERSION}`);

  // Migration to version 2: Fix runner type semantics inversion
  if (currentVersion < RUNNER_TYPE_SEMANTICS_FIX_VERSION) {
    console.log('Applying runner type semantics migration (Speed↔Endurance swap)');

    // Swap the main runner type
    if (loaded.typ === 'Speed' || loaded.typ === 'Endurance') {
      const oldType = loaded.typ;
      loaded.typ = swapRunnerTypeLabel(loaded.typ) as RunnerType;
      console.log(`  typ: ${oldType} → ${loaded.typ}`);
    }

    // Swap calculatedRunnerType if present
    if (loaded.calculatedRunnerType) {
      const oldCalc = loaded.calculatedRunnerType;
      loaded.calculatedRunnerType = swapRunnerTypeLabel(loaded.calculatedRunnerType) as RunnerType;
      console.log(`  calculatedRunnerType: ${oldCalc} → ${loaded.calculatedRunnerType}`);
    }

    // Migrate onboarding state if present
    if (loaded.onboarding) {
      if (loaded.onboarding.confirmedRunnerType) {
        const oldConfirmed = loaded.onboarding.confirmedRunnerType;
        loaded.onboarding.confirmedRunnerType = swapRunnerTypeLabel(loaded.onboarding.confirmedRunnerType);
        console.log(`  onboarding.confirmedRunnerType: ${oldConfirmed} → ${loaded.onboarding.confirmedRunnerType}`);
      }
      if (loaded.onboarding.calculatedRunnerType) {
        const oldOnboardCalc = loaded.onboarding.calculatedRunnerType;
        loaded.onboarding.calculatedRunnerType = swapRunnerTypeLabel(loaded.onboarding.calculatedRunnerType);
        console.log(`  onboarding.calculatedRunnerType: ${oldOnboardCalc} → ${loaded.onboarding.calculatedRunnerType}`);
      }
    }
  }

  // Migration: Fix continuous mode phases (Base → Build → Intensify → Deload)
  // Old pattern was: build, build, build, base (incorrect)
  // New pattern is: base, build, peak, taper (mapped to Base, Build, Intensify, Deload)
  if (loaded.continuousMode && loaded.wks && loaded.wks.length > 0) {
    console.log('Migrating continuous mode phases to Base → Build → Intensify → Deload pattern');
    const correctPhases: Array<'base' | 'build' | 'peak' | 'taper'> = ['base', 'build', 'peak', 'taper'];
    let changedCount = 0;

    for (let i = 0; i < loaded.wks.length; i++) {
      const correctPhase = correctPhases[i % 4];
      if (loaded.wks[i].ph !== correctPhase) {
        loaded.wks[i].ph = correctPhase;
        changedCount++;
      }
    }

    if (changedCount > 0) {
      console.log(`  Fixed ${changedCount} week phases`);
    }
  }

  // Migration: derive planStartDate for existing users who don't have it yet.
  // Approximate: today minus (currentWeek - 1) * 7 days.
  if (!loaded.planStartDate && loaded.w && loaded.w >= 1) {
    const approx = new Date();
    approx.setDate(approx.getDate() - (loaded.w - 1) * 7);
    loaded.planStartDate = approx.toISOString().slice(0, 10);
    console.log(`  Derived planStartDate: ${loaded.planStartDate} (from week ${loaded.w})`);
  }

  // Migration to version 3: Default existing users to running mode.
  // Triathlon mode opt-in only (wizard fork sets eventType = 'triathlon').
  if (currentVersion < TRIATHLON_FIELDS_VERSION) {
    if (loaded.eventType === undefined) {
      loaded.eventType = 'running';
      console.log('  eventType: (unset) → running (default for existing users)');
    }
  }

  // Migration to version 4: Drop possibly-non-running VO2 values.
  // Pre-v4, `s.vo2` and `physiologyHistory[].vo2max` could be sourced from
  // `daily_metrics.vo2max`, which is Garmin's generic cardio estimate and can
  // include cycling-derived values that diverge from the watch's "Running VO2
  // Max" screen. Clear them — physiology sync will repopulate strictly from
  // `physiology_snapshots.vo2_max_running` on next launch, or leave null and
  // fall through to estimated VDOT in the UI.
  if (currentVersion < VO2_DEVICE_ONLY_VERSION) {
    if (loaded.vo2 != null) {
      console.log(`  Clearing pre-v4 s.vo2=${loaded.vo2} (may have been sourced from daily_metrics.vo2max). Physiology sync will repopulate from physiology_snapshots.vo2_max_running.`);
      (loaded as { vo2?: number | null }).vo2 = null;
    }
    if (loaded.physiologyHistory && loaded.physiologyHistory.length > 0) {
      let clearedHistory = 0;
      for (const entry of loaded.physiologyHistory) {
        if (entry.vo2max != null) {
          entry.vo2max = undefined;
          clearedHistory++;
        }
      }
      if (clearedHistory > 0) {
        console.log(`  Cleared vo2max from ${clearedHistory} physiologyHistory entries (will repopulate on next sync from running-specific source).`);
      }
    }
  }

  // Update schema version
  loaded.schemaVersion = STATE_SCHEMA_VERSION;

  return loaded;
}

/**
 * Validate state data for corruption
 * @param loaded - Loaded state object
 * @returns True if data is valid
 */
function validateState(loaded: SimulatorState): boolean {
  // Version check - if data is broken, force reset
  const isBroken =
    (loaded.initialBaseline && loaded.initialBaseline < 300) || // Less than 5 minutes is broken
    (loaded.currentFitness && loaded.currentFitness < 300) ||
    (loaded.initialBaseline && loaded.initialBaseline > 30000) || // More than 8+ hours is broken
    (loaded.forecastTime && loaded.forecastTime < 0) || // Negative is broken
    (loaded.v && (loaded.v < 10 || loaded.v > 90)) || // VDOT out of human range
    (loaded.b && (isNaN(loaded.b) || loaded.b < 0.8 || loaded.b > 1.5)) || // Fatigue exponent out of range
    (loaded.w && loaded.tw && loaded.w > loaded.tw + 1) || // Week beyond plan length
    // Week array length mismatch — only flag once a plan has been generated.
    // An empty `wks` simply means onboarding hasn't built the plan yet, not corruption.
    (loaded.wks && loaded.wks.length > 0 && loaded.tw && loaded.wks.length !== loaded.tw);

  if (isBroken) {
    console.log('BROKEN DATA DETECTED - Auto-clearing localStorage');
    console.log(`  initialBaseline: ${loaded.initialBaseline}`);
    console.log(`  currentFitness: ${loaded.currentFitness}`);
    console.log(`  forecastTime: ${loaded.forecastTime}`);
    return false;
  }

  return true;
}

/** Return the UTC Monday on or before the given date. */
export function getMondayOf(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = d.getUTCDay(); // 0=Sun
  const toMonday = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + toMonday);
  return d;
}

/**
 * Derive planStartDate from actual Garmin activity timestamps when available,
 * so the week anchor reflects when the user first recorded activities rather
 * than an approximation from today's date.
 *
 * Strategy:
 *  1. Find the earliest Garmin timestamp stored in any week (garminPending or adhoc).
 *  2. planStartDate = Monday of that week − (currentWeek − 1) × 7 days.
 *  3. Fallback: Monday of the current calendar week − (currentWeek − 1) × 7 days.
 */
function derivePlanStartDate(s: SimulatorState): string {
  let earliestMs: number | null = null;

  for (const wk of s.wks || []) {
    // garminPending items carry startTime
    for (const item of (wk as any).garminPending || []) {
      if (item.startTime) {
        const t = new Date(item.startTime).getTime();
        if (!isNaN(t) && (earliestMs === null || t < earliestMs)) earliestMs = t;
      }
    }
    // adhoc workouts created from Garmin carry garminTimestamp
    for (const wo of (wk as any).adhocWorkouts || []) {
      if (wo.garminTimestamp) {
        const t = new Date(wo.garminTimestamp).getTime();
        if (!isNaN(t) && (earliestMs === null || t < earliestMs)) earliestMs = t;
      }
    }
  }

  const anchor = earliestMs !== null ? new Date(earliestMs) : new Date();
  const monday = getMondayOf(anchor);
  // monday is the start of the plan week that contains the earliest activity.
  // planStartDate = start of week 1 = that monday − (w−1) weeks.
  monday.setUTCDate(monday.getUTCDate() - (s.w - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

/**
 * Remove all Garmin-sourced data from every week so the next sync can
 * redistribute activities to the correct weeks via week-aware matching.
 *
 * Preserves manually entered RPE ratings (only removes ratings that were
 * auto-completed via Garmin by cross-referencing wk.garminMatched).
 */
function clearGarminData(s: SimulatorState): void {
  for (const wk of s.wks || []) {
    const matched = (wk as any).garminMatched as Record<string, string> | undefined;

    // Un-rate workouts that were auto-completed by Garmin
    if (matched && (wk as any).rated) {
      for (const workoutId of Object.values(matched)) {
        if (workoutId && workoutId !== '__pending__') {
          delete (wk as any).rated[workoutId];
        }
      }
    }

    (wk as any).garminMatched = {};
    (wk as any).garminActuals = {};
    (wk as any).garminPending = [];
    (wk as any).garminReviewChoices = {};
    (wk as any).unspentLoadItems = [];
    (wk as any).unspentLoad = 0;

    // Remove adhoc workouts that came from Garmin (id starts with 'garmin-')
    if ((wk as any).adhocWorkouts) {
      (wk as any).adhocWorkouts = (wk as any).adhocWorkouts.filter(
        (w: any) => !w.id?.startsWith('garmin-')
      );
    }
  }
}

/**
 * Load state from localStorage
 * @returns True if state was loaded successfully
 */
export function loadState(): boolean {
  try {
    const saved = localStorage.getItem(STATE_KEY);
    if (!saved) return false;

    const parsed = JSON.parse(saved) as Partial<SimulatorState>;
    // Defensive merge: an older soft-reset wrote a partial blob (just
    // `onboarding` + `hasCompletedOnboarding`), which used to wipe defaults
    // like `wks`, `v`, `pbs`, `lt`. Merging with defaults here recovers
    // any user still carrying that broken localStorage payload.
    const loaded = { ...getDefaultState(), ...parsed } as SimulatorState;

    if (!validateState(loaded)) {
      localStorage.removeItem(STATE_KEY);
      localStorage.removeItem(CROSS_KEY);
      console.warn('[persistence] Stored state failed validation — cleared localStorage and starting fresh.');
      return false;
    }

    // Apply migrations if needed
    const migrated = migrateState(loaded);

    // Save migrated state back to localStorage if version changed
    if (migrated.schemaVersion !== loaded.schemaVersion) {
      localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
      console.log('Saved migrated state to localStorage');
    }

    // Snap planStartDate to Monday if it isn't already (pre-fix users may have a mid-week anchor).
    if (migrated.planStartDate) {
      const snapped = getMondayOf(new Date(migrated.planStartDate)).toISOString().slice(0, 10);
      if (snapped !== migrated.planStartDate) {
        console.log(`  Snapping planStartDate ${migrated.planStartDate} → ${snapped} (Monday)`);
        migrated.planStartDate = snapped;
        localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
      }
    }

    // Always ensure planStartDate is set — independent of schema version,
    // because it was added after the v2 migration and existing v2 users
    // would have skipped the derivation via the early-return in migrateState.
    if (!migrated.planStartDate && migrated.w && migrated.w >= 1) {
      migrated.planStartDate = derivePlanStartDate(migrated);
      console.log(`  Derived planStartDate: ${migrated.planStartDate} (from week ${migrated.w})`);

      // Garmin data was matched without planStartDate so week assignment was wrong
      // (fell back to "last 7 days", dumping everything into the current week).
      // Clear it all so the next sync redistributes activities to the correct weeks.
      clearGarminData(migrated);
      console.log('  Cleared garmin data for week-aware re-sync');

      localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
    }

    // Clean up old-format workout mods created before the modReason prefix fix.
    // Before the fix, gymOverflow fell into the cross-training reduction path and created
    // modReasons like "Reduced due to strength" / "Downgraded from X to Y due to strength".
    // These can't be cleaned up by openActivityReReview (which requires the "Garmin:" prefix).
    {
      let cleanedMods = false;
      for (const wk of migrated.wks || []) {
        if (wk.workoutMods?.length) {
          const before = wk.workoutMods.length;
          wk.workoutMods = wk.workoutMods.filter(m =>
            !m.modReason?.includes('due to strength') && !m.modReason?.includes('due to gym'),
          );
          if (wk.workoutMods.length !== before) {
            cleanedMods = true;
            console.log(`  Removed ${before - wk.workoutMods.length} stale "due to strength/gym" workout mods in week ${wk.w}`);
          }
        }
      }
      if (cleanedMods) localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
    }

    // Retroactively fix completedKm for past weeks using garminActuals (runs only).
    // Old code stored planned km parsed from workout descriptions; actual Garmin distances
    // are already persisted in garminActuals and should take precedence.
    // Only sum run-type slots — exclude cross-training, gym, rest, etc. by key name.
    {
      const NON_RUN_KW = ['cross', 'gym', 'strength', 'rest', 'yoga', 'swim', 'bike', 'cycl', 'tennis', 'hiit', 'pilates', 'row', 'hik', 'elliptic', 'walk'];
      const isRunKey = (k: string, activityType?: string | null) => {
        if (activityType) { const t = activityType.toUpperCase(); return t === 'RUNNING' || t.includes('RUN'); }
        return !NON_RUN_KW.some(kw => k.toLowerCase().includes(kw));
      };
      let fixedKm = false;
      for (let i = 0; i < (migrated.w || 1) - 1; i++) {
        const wk = migrated.wks?.[i];
        if (!wk) continue;
        const entries = Object.entries((wk as any).garminActuals || {}) as Array<[string, { distanceKm?: number; activityType?: string | null }]>;
        const runEntries = entries.filter(([k, a]) => isRunKey(k, a.activityType));
        if (runEntries.length === 0) continue;
        const totalFromActuals = runEntries.reduce((sum, [, a]) => sum + (a.distanceKm || 0), 0);
        if (totalFromActuals > 0 && Math.abs(totalFromActuals - ((wk as any).completedKm || 0)) > 0.5) {
          (wk as any).completedKm = Math.round(totalFromActuals * 10) / 10;
          fixedKm = true;
        }
      }
      if (fixedKm) {
        localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
        console.log('  Retroactively fixed completedKm for past weeks from garminActuals (runs only)');
      }
    }

    // Fix adhoc workouts that were logged as cross (t='cross') but originated from a run.
    // Bug: addAdhocWorkoutFromPending always set t='cross' even for appType='run' items.
    // Fix: look up garminPending by garminId; if appType==='run', upgrade t to 'easy'.
    {
      let fixedRuns = 0;
      for (const wk of migrated.wks || []) {
        const pending: GarminPendingItem[] = (wk as any).garminPending || [];
        const runPendingIds = new Set(
          pending.filter(p => p.appType === 'run').map(p => p.garminId)
        );
        for (const w of (wk as any).adhocWorkouts || []) {
          if (w.t !== 'cross') continue;
          if (!w.id?.startsWith('garmin-')) continue;
          const rawId = w.id.slice('garmin-'.length);
          if (runPendingIds.has(rawId)) {
            w.t = 'easy';
            fixedRuns++;
          }
        }
      }
      if (fixedRuns > 0) {
        localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
        console.log(`  Fixed ${fixedRuns} adhoc run(s) that were incorrectly stored as t='cross'`);
      }
    }

    // Carry over unresolved excess load from the previous week into the current week.
    // This ensures that if the user advanced weeks without resolving excess load,
    // it still appears on the Training tab (excess load card) for the current week.
    {
      const currW = migrated.w;
      if (currW > 1) {
        const prevWk = migrated.wks?.[currW - 2];
        const currWk = migrated.wks?.[currW - 1];
        // Helper: compute excess for a given week vs its planned Signal B
        const prevPlannedB = prevWk ? computePlannedSignalB(
          migrated.historicWeeklyTSS ?? [], migrated.ctlBaseline ?? 0,
          prevWk.ph ?? 'base', migrated.athleteTierOverride ?? migrated.athleteTier ?? 'recreational',
          migrated.rw ?? 4, undefined, undefined, migrated.sportBaselineByType,
        ) : 0;
        const prevExcess = prevWk ? getWeeklyExcess(prevWk, prevPlannedB, migrated.planStartDate) : 0;

        // Retroactive cleanup: if currWk already has hasCarriedLoad but prev week
        // was actually under target, strip the items — they were already absorbed.
        if (currWk?.hasCarriedLoad && prevExcess <= 0) {
          currWk.hasCarriedLoad = false;
          currWk.unspentLoadItems = [];
          if (prevWk) prevWk.unspentLoadItems = [];
          localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
          console.log(`  Retroactive cleanup: week ${currW - 1} was under target — cleared false carry-over on week ${currW}`);
        } else if (prevWk?.unspentLoadItems?.length && currWk) {
          // Only carry items forward if the previous week was genuinely over its planned load.
          if (prevExcess <= 0) {
            prevWk.unspentLoadItems = [];
            localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
            console.log(`  Week ${currW - 1} was under planned load (excess ${Math.round(prevExcess)} TSS) — clearing unspentLoadItems`);
          } else {
            const existingIds = new Set((currWk.unspentLoadItems || []).map(i => i.garminId));
            const toCarry = prevWk.unspentLoadItems.filter(i => !existingIds.has(i.garminId));
            if (toCarry.length > 0) {
              if (!currWk.unspentLoadItems) currWk.unspentLoadItems = [];
              currWk.unspentLoadItems.push(...toCarry);
              currWk.hasCarriedLoad = true;
              prevWk.unspentLoadItems = prevWk.unspentLoadItems.filter(i => existingIds.has(i.garminId));
              localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
              console.log(`  Carried ${toCarry.length} unresolved excess load items from week ${currW - 1} → week ${currW}`);
            }
          }
        }
      }
    }

    // Repair s.v if it was corrupted by repeated detraining on a clamped plan.
    // Bug: advanceWeekToToday applied detraining using the full calendar gap even
    // when s.w was clamped to plan length, so every launch compounded the loss.
    // Repair: reset to s.iv, then apply one correct round of detraining for
    // inactive weeks (those with wkGain ≈ 0).
    if (migrated.iv && migrated.v && migrated.v < migrated.iv * 0.9) {
      const inactiveWeeks = (migrated.wks || [])
        .slice(0, (migrated.w || 1) - 1)
        .filter((wk: { wkGain: number }) => !wk.wkGain || wk.wkGain <= 0).length;
      // Inline computeVdotLoss: 1.2%/wk for first 2, 0.8%/wk after
      let loss = 0;
      for (let i = 0; i < inactiveWeeks; i++) {
        const rate = i < 2 ? 0.012 : 0.008;
        loss += (migrated.iv - loss) * rate;
      }
      loss = Math.round(loss * 10) / 10;
      const repaired = Math.max(Math.round((migrated.iv - loss) * 10) / 10, 20);
      console.log(`  Repairing corrupted s.v: ${migrated.v} → ${repaired} (s.iv=${migrated.iv}, ${inactiveWeeks} inactive weeks, loss=${loss})`);
      migrated.v = repaired;
      localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
    }

    setState(migrated);
    console.log('Loaded saved state from localStorage');
    console.log(`  Initial: ${ft(loaded.initialBaseline || 0)}, Current: ${ft(loaded.currentFitness || 0)}, Forecast: ${ft(loaded.forecastTime || 0)}`);

    // Load cross-training activities
    const savedCross = localStorage.getItem(CROSS_KEY);
    if (savedCross) {
      const activities = JSON.parse(savedCross) as CrossActivity[];
      // Convert date strings back to Date objects
      activities.forEach(a => {
        if (typeof a.date === 'string') {
          a.date = new Date(a.date);
        }
      });
      setCrossActivities(activities);
      console.log(`Loaded ${activities.length} cross-training activities`);
    }

    return true;
  } catch (e) {
    console.error('Error loading state:', e);
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(CROSS_KEY);
    alert('Error loading saved data. Please re-initialize your plan.');
    return false;
  }
}

/**
 * Save state to localStorage
 */
export function saveState(): void {
  try {
    const state = getState();
    const crossActivities = getCrossActivities();

    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    localStorage.setItem(CROSS_KEY, JSON.stringify(crossActivities));

    // Fire-and-forget Supabase backup — only runs if user is authenticated
    savePlanSettings();
  } catch (e) {
    console.error('Error saving state:', e);
  }
}

/**
 * Clear all saved state
 */
export function clearState(): void {
  localStorage.removeItem(STATE_KEY);
  localStorage.removeItem(CROSS_KEY);
  clearAllGpsData();
}

/**
 * Soft reset: clear training plan but preserve profile data (name, PBs, fitness, runner type).
 * After soft reset the wizard restarts at 'goals' (skipping welcome) if name exists.
 */
export function softResetState(): void {
  const current = getState();
  const ob = current.onboarding;

  // Build fresh onboarding state, preserving profile fields
  const preserved = {
    ...defaultOnboardingState,
    ...(ob ? {
      name: ob.name,
      age: ob.age,
      pbs: ob.pbs,
      recentRace: ob.recentRace,
      hasSmartwatch: ob.hasSmartwatch,
      ltPace: ob.ltPace,
      vo2max: ob.vo2max,
      restingHR: ob.restingHR,
      maxHR: ob.maxHR,
      confirmedRunnerType: ob.confirmedRunnerType,
      calculatedRunnerType: ob.calculatedRunnerType,
      experienceLevel: ob.experienceLevel,
    } : {}),
    // Skip welcome if name exists
    currentStep: ob?.name ? 'goals' as const : 'welcome' as const,
  };

  // Atomic write: build a COMPLETE fresh state (defaults + preserved onboarding).
  // Writing a partial blob here used to wipe `wks`, `v`, `pbs`, `lt`, etc. on
  // the next launch — loadState() does setState(migrated), which replaces the
  // in-memory state outright. The wizard then crashed at `rt.wks.length`.
  const freshState: SimulatorState = {
    ...getDefaultState(),
    onboarding: preserved,
    hasCompletedOnboarding: false,
  };

  localStorage.setItem(STATE_KEY, JSON.stringify(freshState));
  localStorage.removeItem(CROSS_KEY);
  clearAllGpsData();
}

/**
 * Check if there is saved state
 */
export function hasSavedState(): boolean {
  return localStorage.getItem(STATE_KEY) !== null;
}
