import type { SimulatorState, CrossActivity, RunnerType } from '@/types';
import { savePlanSettings } from '@/data/planSettingsSync';
import { STATE_SCHEMA_VERSION, RUNNER_TYPE_SEMANTICS_FIX_VERSION } from '@/types/state';
import { defaultOnboardingState } from '@/types/onboarding';
import { setState, setCrossActivities, getState, getCrossActivities } from './store';
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
    (loaded.wks && loaded.tw && loaded.wks.length !== loaded.tw); // Week array length mismatch

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

    const loaded = JSON.parse(saved) as SimulatorState;

    if (!validateState(loaded)) {
      localStorage.removeItem(STATE_KEY);
      localStorage.removeItem(CROSS_KEY);
      alert('Detected corrupted data. Please re-initialize your plan.');
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
      const isRunKey = (k: string) => !NON_RUN_KW.some(kw => k.toLowerCase().includes(kw));
      let fixedKm = false;
      for (let i = 0; i < (migrated.w || 1) - 1; i++) {
        const wk = migrated.wks?.[i];
        if (!wk) continue;
        const entries = Object.entries((wk as any).garminActuals || {}) as Array<[string, { distanceKm?: number }]>;
        const runEntries = entries.filter(([k]) => isRunKey(k));
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

    // Carry over unresolved excess load from the previous week into the current week.
    // This ensures that if the user advanced weeks without resolving excess load,
    // it still appears on the Training tab (excess load card) for the current week.
    {
      const currW = migrated.w;
      if (currW > 1) {
        const prevWk = migrated.wks?.[currW - 2];
        const currWk = migrated.wks?.[currW - 1];
        if (prevWk?.unspentLoadItems?.length && currWk) {
          // Only carry items forward if the previous week was genuinely over its planned load.
          // If the week finished at or under target, the activities were already absorbed — don't flag.
          const prevPlannedB = computePlannedSignalB(
            migrated.historicWeeklyTSS ?? [], migrated.ctlBaseline ?? 0,
            prevWk.ph ?? 'base', migrated.athleteTierOverride ?? migrated.athleteTier ?? 'recreational',
            migrated.rw ?? 4, undefined, undefined, migrated.sportBaselineByType,
          );
          const prevExcess = getWeeklyExcess(prevWk, prevPlannedB, migrated.planStartDate);
          if (prevExcess <= 0) {
            // Week was under target — clear the items, nothing to carry
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
              // Clear carried items from previous week to avoid double-display on back-navigation
              prevWk.unspentLoadItems = prevWk.unspentLoadItems.filter(i => existingIds.has(i.garminId));
              localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
              console.log(`  Carried ${toCarry.length} unresolved excess load items from week ${currW - 1} → week ${currW}`);
            }
          }
        }
      }
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

  // Atomic write: build fresh state with preserved onboarding, write in one go
  const freshState: Partial<SimulatorState> = {
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
