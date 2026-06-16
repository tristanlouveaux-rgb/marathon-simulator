/**
 * Mosaic Training Simulator
 * Entry point - initializes the application
 */

import './styles.css';
import { loadState, getState, getMutableState, saveState, clearState } from '@/state';
import { restorePlanFromSupabase, getLocalStateOwner, setLocalStateOwner } from '@/data/planSettingsSync';
import { isSimulatorMode, trackStartupTask, signalLaunchAppComplete } from '@/app/runtime';
import { initWizard } from '@/ui/wizard/controller';
import { renderMainView } from '@/ui/main-view';
import { renderHomeView } from '@/ui/home-view';
import { advanceWeekToToday, assertPlanAnchorConsistent, reconcilePlanAnchorToEarliestActivity, recordAppOpen, isWeekPendingDebrief } from '@/ui/welcome-back';
import { checkHolidayEnd, showHolidayWelcomeBack } from '@/ui/holiday-modal';
import { renderAdminPanel, toggleAdminMode } from '@/ui/admin/master-overview';
import { syncPhysiologySnapshot, buildRecoveryEntryFromPhysio, syncTodaySteps } from '@/data/physiologySync';
import { refreshVO2Estimates } from '@/data/vo2Sync';
import { backfillIntensityBands, closeOutObservedRecovery, fitKUser, ingestNewActualsAsImpacts } from '@/calculations/adaptive-recovery';
import { syncActivities, processPendingCrossTraining } from '@/data/activitySync';
import { healMissingITrimp, reconcileCrossSourceDuplicates } from '@/calculations/activity-matcher';
import { setAthleteNormalizer, calibrateTssPerActiveMinute, normalizeiTrimp } from '@/calculations/fitness-model';
import { plannedTssPerMin } from '@/constants';
import { calculateWorkoutLoad } from '@/workouts';
import { syncStravaActivities, fetchStravaHistory, backfillStravaHistory, deriveAthleteTier, fetchEarliestActivityDate, restoreHistoryFromServer, cleanupDbDuplicates } from '@/data/stravaSync';
import { STRAVA_ENABLED, NATIVE_OAUTH_ENABLED } from '@/constants/feature-flags';
import { READINESS_LONGEST_WINDOW_WEEKS } from '@/constants/race-readiness-targets';
import { supabase, isGarminConnected, isStravaConnected, resetStravaCache, triggerGarminBackfill, refreshRecentSleepScores, resetGarminBackfillGuard, resetGarminCache } from '@/data/supabaseClient';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { renderAuthView } from '@/ui/auth-view';
import { syncAppleHealth, syncAppleHealthPhysiology, subscribeToWorkoutObserver, subscribeToForegroundResume } from '@/data/appleHealthSync';
import { startSleepPollerIfNeeded } from '@/data/sleepPoller';
import { getActivitySource, hasPhysiologySource } from '@/data/sources';
import { runVO2Diagnostic, printVO2Diagnostic } from '@/calculations/vo2-diagnostic';
import { initRevenueCat, identifyRevenueCatUser } from '@/coach/revenuecat-client';
import { isNative } from '@/utils/platform';
import { installWebOverscrollBounce } from '@/ui/web-overscroll-bounce';
import { initSharedFileIntake } from '@/data/shared-file-intake';
import { mergeEnrichmentsFromServer } from '@/data/enrichmentSync';
import { installPageSwipeNav } from '@/ui/page-swipe-nav';
import '@/ui/strava-detail';

// Console-callable VO2max diagnostic: run `diagnoseVO2()` in the browser console
// to see every available VO2max signal computed from the current state, plus
// the HR-regression's internal points and HRR distribution. Read-only.
// Dev-only. Never attached in production builds so it's not discoverable via
// Safari Web Inspector on the shipped iOS bundle.
if (import.meta.env.DEV) {
  (window as any).diagnoseVO2 = (): unknown => {
    const d = runVO2Diagnostic();
    printVO2Diagnostic(d);
    return d;
  };
}

// `isSimulatorMode`, `trackStartupTask`, `signalLaunchAppComplete` and
// `awaitStartupSyncs` now live in the leaf module `@/app/runtime` (imported
// above). They were moved out of this entry module so that the views and the
// onboarding `review` step that need them no longer import `main.ts` — which
// auto-runs `bootstrap()` at module load and previously created a circular
// import that crashed the wizard with a `STEP_ORDER` temporal-dead-zone error.
// See src/app/runtime.ts for the full rationale.

// Tracks the userId active when launchApp() last ran.
// Suppresses the duplicate SIGNED_IN that Supabase fires for an already-valid session on page load.
let launchedUserId: string | null = null;

/**
 * Debounced home-view refresh. Multiple async syncs land on startup (Strava
 * activities, physiology snapshot, today's steps, sleep refresh) and each
 * used to trigger its own full re-render, causing 3–5 visible flickers.
 * Calls within the debounce window collapse to a single render on the trailing
 * edge. The initial launch render still goes through renderHomeView() directly.
 */
let _homeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleHomeRefresh(): void {
  if (!document.getElementById('home-tss-row')) return;
  if (_homeRefreshTimer) return;
  _homeRefreshTimer = setTimeout(() => {
    _homeRefreshTimer = null;
    scheduleHomeRefresh();
  }, 150);
}

/**
 * Global safety net: if any uncaught error or unhandled promise rejection
 * happens after launch, tear down any full-screen overlays so the user is
 * never left staring at a blank backdrop. This is a defence-in-depth measure
 * for the class of bug where a sync routine opens an overlay and then crashes
 * mid-render. The silent .catch() handlers in fire-and-forget syncs would
 * otherwise hide the failure entirely.
 *
 * IDs listed here are full-viewport overlays that, if orphaned, would obscure
 * the home view. The list is intentionally narrow. Modals like check-in or
 * coach are user-initiated and should not be force-closed.
 */
const FULLSCREEN_OVERLAY_IDS = ['activity-review-overlay'];
function teardownOrphanedOverlays(): void {
  for (const id of FULLSCREEN_OVERLAY_IDS) {
    document.getElementById(id)?.remove();
  }
}
function installGlobalErrorSafetyNet(): void {
  window.addEventListener('error', (e) => {
    console.error('[GlobalError]', e.error || e.message);
    teardownOrphanedOverlays();
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[UnhandledRejection]', e.reason);
    teardownOrphanedOverlays();
  });
}
installGlobalErrorSafetyNet();

/**
 * Initialize application on DOM ready
 */
/**
 * Pinch-zoom policy. The static viewport meta in index.html locks scaling off
 * (`maximum-scale=1.0, user-scalable=no`). Correct for the native iOS app,
 * where a zoomable web-view feels broken and inputs jump on focus. On the
 * web/desktop build there's no such expectation and zoom is an accessibility
 * baseline, so relax the meta at runtime for non-native platforms only. Native
 * keeps the locked behaviour untouched.
 */
function applyWebViewportPolicy(): void {
  if (isNative()) return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
}

async function bootstrap(): Promise<void> {
  applyWebViewportPolicy();
  installWebOverscrollBounce();
  installPageSwipeNav();
  // Register the global the native "Share to Mosaic" file handler calls.
  initSharedFileIntake();
  // On foreground, pull enrichments done on another device (throttled to 5 min
  // inside). Catches a web-app enrich while the phone was suspended.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void mergeEnrichmentsFromServer();
  });

  // Dev: install window.__debugForecast() for prediction-stack diagnostics.
  const { installDebugForecast } = await import('@/dev/debug-forecast');
  installDebugForecast();

  // After Garmin re-auth, the callback redirects back with ?garmin=connected.
  // Clear the backfill throttle guard so the next launch pulls fresh data
  // instead of sitting on a stale 12h skip from the broken-auth period.
  const params = new URLSearchParams(window.location.search);
  if (params.get('garmin') === 'connected') {
    resetGarminBackfillGuard();
    resetGarminCache();
    params.delete('garmin');
    const clean = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (clean ? `?${clean}` : ''));
  }

  // Simulator mode: skip auth entirely for local dev/testing
  if (isSimulatorMode()) {
    await launchApp();
    return;
  }

  // Check for existing Supabase session
  let { data: { session } } = await supabase.auth.getSession();

  // If session exists but is expired, try refresh. How a refresh failure is
  // handled depends on WHY it failed — a network blip must never destroy a
  // valid refresh token (that used to silently convert real accounts into
  // anonymous guests, and the owner-mismatch check then wiped local state).
  if (session) {
    const expiresAt = session.expires_at ?? 0;
    if (expiresAt <= Math.floor(Date.now() / 1000) + 60) {
      const { data: refreshed, error } = await supabase.auth.refreshSession();
      if (refreshed.session) {
        session = refreshed.session;
      } else if (isAuthRetryableFetchError(error)) {
        // Network-shaped failure (offline, DNS, 5xx). The refresh token is
        // still good — launch with the stale session. Per-call getValidSession
        // throws (all callers catch) and the SDK auto-refreshes when the
        // network returns.
        console.warn('[auth] Session refresh failed (network), launching with stale session', error);
      } else if (!session.user.is_anonymous) {
        // Genuinely invalid token on a real account: honest logout to the
        // sign-in screen (email prefilled from last sign-in). Never downgrade
        // a real account to an anonymous guest.
        console.warn('[auth] Refresh token invalid for signed-in account, showing sign-in', error);
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
        renderAuthView();
        setupAuthListener();
        return;
      } else {
        console.warn('[auth] Stale anonymous session could not refresh, clearing and signing in anonymously');
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
        session = null;
      }
    }
  }

  if (!session) {
    // No session. Silently create an anonymous user. No auth UI during onboarding.
    // Users can upgrade to a real account later from Account settings.
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.session) {
      // ISSUE-228: do NOT dump the user to an auth screen on auth failure.
      // Apple's review network is famously flaky; a reviewer on poor Wi-Fi
      // would see a blank/unrecoverable auth view. Instead, launch the app
      // in offline-bootstrap mode: localStorage drives the wizard + UI; sync
      // is deferred until the network returns and the retry below succeeds.
      console.warn('[auth] Anonymous sign-in failed — launching in offline mode, will retry on reconnect', error);
      await launchApp();
      scheduleOfflineAuthRetry();
      setupAuthListener();
      return;
    }
    session = data.session;
  }

  // Authenticated (anon or real). Proceed with app
  await launchApp();
  const { data: { user: launchedUser } } = await supabase.auth.getUser();
  launchedUserId = launchedUser?.id ?? null;
  // RevenueCat IAP. No-op on web/Android and when SDK key isn't pasted yet.
  // Identifies the user so webhook events arrive with the Supabase user_id.
  void initRevenueCat(launchedUserId);
  setupAuthListener();
}

/**
 * Retry anonymous sign-in when network connectivity is restored after the
 * initial bootstrap failed. Wired by ISSUE-228. The offline fallback path.
 * Idempotent and self-cleaning: once sign-in succeeds the listener is removed
 * and the auth-state-change subscription takes over.
 */
function scheduleOfflineAuthRetry(): void {
  let retryInFlight = false;
  const attempt = async (): Promise<void> => {
    if (retryInFlight) return;
    retryInFlight = true;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        window.removeEventListener('online', onOnline);
        return;
      }
      const { data, error } = await supabase.auth.signInAnonymously();
      if (!error && data.session) {
        console.log('[auth] Offline retry succeeded — anonymous session created');
        window.removeEventListener('online', onOnline);
      } else {
        console.warn('[auth] Offline retry failed, will try again on next online event', error);
      }
    } catch (err) {
      console.warn('[auth] Offline retry threw', err);
    } finally {
      retryInFlight = false;
    }
  };
  const onOnline = (): void => { void attempt(); };
  window.addEventListener('online', onOnline);
  // Also attempt once after a short delay in case the original failure was
  // transient (DNS hiccup) rather than a hard offline state.
  setTimeout(() => { void attempt(); }, 5000);
}

/**
 * Listen for auth state changes (login/logout)
 *
 * SIGNED_IN here only fires on explicit sign-in via the auth form (the
 * anonymous bootstrap sign-in happens before this listener is attached, so
 * its event is missed by design). On explicit sign-in, the user expects
 * their account's plan to load. But launchApp's default path checks
 * localStorage first and skips restore-from-Supabase if anything is there.
 * That left users seeing the previous (anon / signed-out) session's state.
 *
 * On SIGNED_IN: try restorePlanFromSupabase first; only overwrite local
 * state if the cloud backup actually exists. If no backup, keep whatever
 * was in localStorage so we don't strand a user mid-wizard.
 *
 * Upgrade-guest flow uses updateUser → USER_UPDATED, not SIGNED_IN, so
 * guest data is preserved on that path.
 */
function setupAuthListener(): void {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') {
      void (async () => {
        const { data: { user } } = await supabase.auth.getUser();
        const newUserId = user?.id;
        // Supabase fires SIGNED_IN for the already-valid session on page load,
        // not only for explicit user sign-ins. Suppress the duplicate to avoid
        // running launchApp() twice on every page load.
        if (newUserId && newUserId === launchedUserId) return;
        // On explicit sign-in, the user expects their account's plan. The
        // localStorage state may belong to a previous (anonymous or
        // signed-out) session. Owner_id stamped by save/restore tells us
        // whose data is on disk. If owner mismatches the new user, wipe it
        // before restore so we never show one user another's plan.
        // If restore returns false (no cloud backup), launchApp falls
        // through to the wizard. The right outcome for a fresh account.
        const owner = getLocalStateOwner();
        if (newUserId && owner && owner !== newUserId) {
          clearState();
          setLocalStateOwner(null);
        }
        await restorePlanFromSupabase();
        await launchApp();
        launchedUserId = newUserId ?? null;
        void identifyRevenueCatUser(newUserId ?? null);
      })();
    } else if (event === 'SIGNED_OUT') {
      launchedUserId = null;
      void identifyRevenueCatUser(null);
      renderAuthView();
    }
  });
}

/**
 * Launch the main app (called after authentication is confirmed)
 */
async function launchApp(): Promise<void> {
  // Try to load saved state
  let hasState = loadState();

  // If localStorage is empty and user is authenticated, silently restore from Supabase backup
  if (!hasState && !isSimulatorMode()) {
    const restored = await restorePlanFromSupabase();
    if (restored) {
      hasState = loadState();
    }
  }
  const state = getState();

  // Refresh isGuestAccount from the live session. is_anonymous is true for users
  // auto-created via signInAnonymously above. Long-term anonymous users are at
  // risk of data loss on app reinstall / device change. The home banner and
  // Account view surface a "Save your account" prompt off this flag.
  if (!isSimulatorMode()) {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const ms = getMutableState();
      const wasGuest = ms.isGuestAccount === true;
      ms.isGuestAccount = !!user?.is_anonymous;
      // If the user just upgraded, clear the dismiss flag so the Account view
      // section reflects the new state cleanly.
      if (wasGuest && !ms.isGuestAccount) ms.guestBannerDismissed = false;
      if (hasState) saveState();
    } catch { /* swallow — banner just won't fire if we can't read auth */ }

    // Pending account-deletion check. If the user previously triggered
    // self-serve deletion (Account view → Delete account) and signed back
    // in within the 30-day grace window, surface a banner with the cancel
    // path. Non-blocking. Read via edge fn since the SELECT policy on
    // user_plan_settings hides soft-deleted rows from the user.
    void import('@/ui/pending-deletion-banner').then(({ checkAndShowPendingDeletion }) => {
      void checkAndShowPendingDeletion();
    });
  }

  // One-time cleanup: the weekly-hours onboarding slider was removed (2026-06-01).
  // Existing state may still carry weeklyTrainingHours / weekdayTrainingHours,
  // which keep the plan-engine hours cap (applyHoursBudget) active and squeeze
  // sessions below their natural race-plan length. Clear them so the plan runs
  // uncapped — the live Adjust feature now handles per-session time trims. Also
  // drops the now-orphaned budgetAcceptedAtHours (banner dismissal marker).
  // Idempotent: deletes only if present, so it self-disables after one launch.
  if (
    hasState && state.onboarding &&
    (state.onboarding.weeklyTrainingHours != null ||
     state.onboarding.weekdayTrainingHours != null ||
     state.onboarding.budgetAcceptedAtHours != null)
  ) {
    const ms = getMutableState();
    if (ms.onboarding) {
      delete ms.onboarding.weeklyTrainingHours;
      delete ms.onboarding.weekdayTrainingHours;
      delete ms.onboarding.budgetAcceptedAtHours;
      console.log('[launch] Cleared deprecated weekly-hours budget (slider removed; plan now runs at natural length, Adjust handles time trims).');
      saveState();
    }
  }

  // Self-heal stravaConnected flag. Users who connected Strava from the tri
  // setup page (or via any path that didn't land on ?strava=connected) have
  // tokens in strava_tokens but the state flag is false. Which gates the
  // auto-backfill and leaves their rides without power data. Fix by
  // asking the DB directly and flipping the flag on when tokens exist.
  if (STRAVA_ENABLED && !isSimulatorMode() && hasState && !state.stravaConnected) {
    try {
      const tokensExist = await isStravaConnected();
      if (tokensExist) {
        console.log('[launch] Self-healing stravaConnected flag (tokens found, state flag was false)');
        const ms = getMutableState();
        ms.stravaConnected = true;
        saveState();
        state.stravaConnected = true;
      }
    } catch { /* swallow — worst case backfill doesn't auto-fire this launch */ }
  }

  // Self-heal physiology source. If Garmin credentials exist in the DB but
  // state has no physiology source (typical after a localStorage wipe /
  // corrupt-state recovery), launch-time sync gates fail and the user sees
  // no sleep / HRV / RHR. Flip the flag so syncPhysiologySnapshot can fire.
  if (
    !isSimulatorMode()
    && hasState
    && !state.connectedSources?.physiology
    && state.wearable !== 'garmin'
    && state.wearable !== 'apple'
  ) {
    try {
      const garminOk = await isGarminConnected();
      if (garminOk) {
        console.log('[launch] Self-healing physiology source to garmin (credentials found)');
        const ms = getMutableState();
        ms.connectedSources = { ...(ms.connectedSources ?? {}), physiology: 'garmin' };
        if (!ms.wearable) ms.wearable = 'garmin';
        saveState();
      }
    } catch { /* swallow — sleep reloads next launch */ }
  }

  // Set per-athlete iTRIMP normalizer (LTHR-based, Coggan hrTSS standard)
  setAthleteNormalizer(state.ltHR, state.restingHR, state.maxHR);

  // Cross-modal VO2max. Refresh per-discipline estimates + cardiac ceiling
  // from the last 8 weeks of activity. Cheap (~2ms), pure local computation.
  //
  // Tri mode skips this launch-top call: the canonical activity log lives in
  // the DB, not `s.wks[].garminActuals`, so a wks-only orchestrator run
  // produces a different result than the post-benchmark-derive run a few
  // hundred ms later (different HRmax sample, different point count). Firing
  // once here and once after benchmarks made the headline visibly flap
  // between two values within a single launch. Tri mode runs it once after
  // `loadActivitiesFromDB` resolves. See line ~530.
  if (state.eventType !== 'triathlon') {
    refreshVO2Estimates();
  }

  // Calibrate personal TSS-per-active-minute from logged activities
  const calibrated = calibrateTssPerActiveMinute(state.wks);
  if (calibrated != null) {
    const ms0 = getMutableState();
    ms0.tssPerActiveMinute = calibrated;
    saveState();
  }

  // Triathlon: regenerate the plan if the generator version has bumped since
  // the plan was last built, AND refresh benchmarks (CSS / FTP / per-
  // discipline CTL) from the latest activity history so predictions track
  // fitness as it evolves. Never overwrites user-entered CSS/FTP. Only
  // fills blanks.
  if (hasState && state.eventType === 'triathlon' && state.triConfig) {
    try {
      const { TRI_GENERATOR_VERSION, generateTriathlonPlan } = await import('@/workouts/plan_engine.triathlon');
      const { deriveTriBenchmarksFromHistory } = await import('@/calculations/tri-benchmarks-from-history');
      const { loadActivitiesFromDB } = await import('@/data/tri-activity-loader');
      const { appendFtpSample, appendCssSample } = await import('@/calculations/tri-benchmark-history');
      const mutable = getMutableState();

      // One-time migration: any existing FTP/CSS without a source field is
      // tagged 'derived'. Reasoning: the auto-fill feature just shipped, so
      // any existing value is almost certainly auto-derived rather than
      // user-entered. This unblocks the refresh path from preserving stale
      // estimates produced by earlier (worse) algorithms. Users who genuinely
      // typed their own benchmarks at onboarding land back as 'user' next
      // time they go through the wizard.
      if (mutable.triConfig?.bike?.ftp && !mutable.triConfig.bike.ftpSource) {
        mutable.triConfig.bike.ftpSource = 'derived';
      }
      if (mutable.triConfig?.swim?.cssSecPer100m && !mutable.triConfig.swim.cssSource) {
        mutable.triConfig.swim.cssSource = 'derived';
      }

      // Load activities directly from Supabase. The state.wks array is
      // triathlon-shaped (fresh empty weeks) so in-memory mirrors lose the
      // pre-onboarding activity history. Database query sees everything
      // including unmatched rides/swims.
      let activityLog = await loadActivitiesFromDB(500);

      // Tri onboarding skips the Strava connection step. If the DB is
      // empty but the user has Strava tokens, pull a 16-week backfill
      // before deriving. Otherwise new tri users would see CTL 0 until
      // they manually press sync.
      if (activityLog.length === 0 && !isSimulatorMode()) {
        const stravaOk = STRAVA_ENABLED && await isStravaConnected();
        if (stravaOk) {
          console.log('[tri] DB empty + Strava connected — triggering backfill (52w)');
          try {
            await backfillStravaHistory(52);
            activityLog = await loadActivitiesFromDB(500);
            console.log(`[tri] Post-backfill: ${activityLog.length} activities loaded`);
          } catch (err) {
            console.warn('[tri] Backfill failed', err);
          }
        } else {
          console.log('[tri] DB empty and Strava not connected — benchmarks will stay skill-slider based');
        }
      }

      // Persist a slim per-discipline activity summary so swim/bike weekly
      // volume + longest-session survive a fresh sign-in. `garminActuals` is
      // empty until activities re-match forward, and unlike run (which falls
      // back to `onboardingRunHistory`) swim/bike had no resilient source —
      // the Endurance readiness card collapsed to 0 across every discipline.
      // Cap to the readiness longest-session window; store only the fields the
      // volume/longest helpers read (no polylines/splits) to keep the snapshot
      // small. The DB log is the canonical source and already deduped.
      {
        const cutoffMs = Date.now() - READINESS_LONGEST_WINDOW_WEEKS * 7 * 24 * 60 * 60 * 1000;
        mutable.recentDisciplineActivity = activityLog
          .filter(a => a.startTime && (a.durationSec ?? 0) > 0
            && Date.parse(a.startTime) >= cutoffMs)
          .map(a => ({
            activityType: a.activityType ?? '',
            startTime: a.startTime as string,
            durationSec: a.durationSec ?? 0,
            distanceKm: a.distanceKm ?? 0,
          }));
        console.log(`[tri] recentDisciplineActivity: persisted ${mutable.recentDisciplineActivity.length} activities (last ${READINESS_LONGEST_WINDOW_WEEKS}w) for sign-in-resilient readiness`);
      }

      const derived = deriveTriBenchmarksFromHistory(activityLog, undefined, {
        swim400Sec: state.triConfig?.swim?.pbs?.m400,
        swim200Sec: state.triConfig?.swim?.pbs?.m200,
      }, state.triConfig?.swim?.defaultOwSwimEnvironment);
      // ALSO compute the DIRECT (no transfer matrix) per-discipline fitness
      // for the user-facing display. The matrix-adjusted version (above) goes
      // to race prediction internals because cross-training transfer is real
      // physiology; the direct version is what the user sees because they
      // expect "swim load" to mean what they did in the pool.
      const { estimateDirectPerDisciplineCTLFromActivities, manualDoneTriActivities } = await import('@/calculations/tri-benchmarks-from-history');
      // Manually-completed sessions (rated, no synced activity) deposit their
      // planned load into CTL so the Adjust Harder/Easier choice has a fitness
      // consequence even without a watch. Fitness-only (not benchmark derivation);
      // a real matched activity overrides the estimate (handled in the helper).
      const manualDoneActs = manualDoneTriActivities(state.wks, state.planStartDate);
      const directFitness = estimateDirectPerDisciplineCTLFromActivities([...activityLog, ...manualDoneActs]);

      // Diagnostic. Once-per-launch so we can see why Training Load might be
      // zero. Activity count, derived fitness per discipline, and how many
      // historical weeks have non-zero CTL.
      const { classifyActivity } = await import('@/calculations/tri-benchmarks-from-history');
      const swimActivities = activityLog
        .filter(a => classifyActivity(a.activityType) === 'swim')
        .map(a => ({ type: a.activityType, date: a.startTime?.slice(0, 10), distKm: a.distanceKm }));
      console.log('[tri:fitness-diag]', {
        activityCount: activityLog.length,
        swimDirectCount: directFitness.swim.directCount ?? 0,
        swimCtl: directFitness.swim.ctl,
        bikeCtl: directFitness.bike.ctl,
        runCtl:  directFitness.run.ctl,
        combinedCtl: derived.fitness.combinedCtl,
        historyLen: derived.fitnessHistory.length,
        swimActivities,
      });

      // Update per-discipline fitness every boot so CTL reflects what's
      // actually been trained since last load. Display values use DIRECT
      // (no transfer matrix) so a user with 0 swims sees swim CTL = 0, not
      // the 8.4 cross-training spillover. The matrix-adjusted version stays
      // available via combinedCtl (which is a meaningful aggregate).
      if (mutable.triConfig) {
        mutable.triConfig.fitness = {
          swim: directFitness.swim,
          bike: directFitness.bike,
          run:  directFitness.run,
          combinedCtl: derived.fitness.combinedCtl,  // matrix-aggregate stays
          crossTrainingAtl: directFitness.crossTrainingAtl,
          crossTrainingCtl: directFitness.crossTrainingCtl,
        };
        mutable.triConfig.fitnessHistory = derived.fitnessHistory.slice(-52);
        // Fill or refresh CSS / FTP. Per CLAUDE.md "Manually-set Benchmarks
        // Yield to Improvements": user-entered values are preserved UNLESS the
        // derived estimate clearly improves on them with sufficient
        // confidence. Auto-derived values are refreshed every launch so a
        // smarter algorithm or new training data updates the estimate.
        // Pre-provenance values (no source set) are treated as user-entered.
        const swim = mutable.triConfig.swim;
        const swimSrc = swim?.cssSource;
        const currentCss = swim?.cssSecPer100m;
        const derivedCss = derived.css.cssSecPer100m;
        const cssBlank = !currentCss;
        const cssDerivedRefresh = swimSrc === 'derived';
        // CSS lower = better. Derived estimate already includes a +5s/100m
        // buffer (see estimateCSSFromSwimActivities), so any improvement over
        // a user value is a real signal. Require ≥2 sustained swims for the
        // override path so a single hot session can't clobber a test result.
        const cssUserBeaten =
          swimSrc === 'user' &&
          currentCss != null &&
          derivedCss != null &&
          derivedCss < currentCss &&
          (derived.css.swimActivityCount ?? 0) >= 2;
        // Holiday-detrain anchor gate: while a return dock is active, a swim dated on or
        // before the dock (the holiday end) cannot IMPROVE (lower) the docked CSS — a
        // pre-return swim is not evidence of recovery. A swim after the dock supersedes it
        // and clears the anchor. See showHolidayWelcomeBack / cssDetrainAnchorISO.
        const cssAnchor = swim?.cssDetrainAnchorISO;
        const cssEvidencePostAnchor =
          !cssAnchor || (derived.css.sourceActivityISO != null && derived.css.sourceActivityISO > cssAnchor);
        const cssBlockedByAnchor =
          !cssEvidencePostAnchor && derivedCss != null && currentCss != null && derivedCss < currentCss;
        if ((cssBlank || cssDerivedRefresh || cssUserBeaten) && derivedCss && !cssBlockedByAnchor) {
          if (cssUserBeaten) {
            console.log(`[tri] CSS auto-improved: user ${currentCss}s/100m → derived ${derivedCss}s/100m`);
          }
          mutable.triConfig.swim = {
            ...(swim ?? {}),
            cssSecPer100m: derivedCss,
            cssSource: 'derived',
            cssConfidence: derived.css.confidence,
            // A post-return swim cleared the detrain dock; drop the anchor.
            cssDetrainAnchorISO: cssEvidencePostAnchor ? undefined : swim?.cssDetrainAnchorISO,
          };
          appendCssSample(mutable.triConfig.swim, derivedCss, 'derived', derived.css.confidence);
        } else if (cssBlockedByAnchor) {
          console.log(`[tri] CSS held by holiday-detrain anchor (${cssAnchor}): derived ${derivedCss}s/100m is from a pre-return swim, keeping docked ${currentCss}s/100m.`);
        } else if (swimSrc === 'user' && swim?.cssSecPer100m) {
          // User-set CSS. Confidence is 'high' if they did the paired-TT test
          // (both m400 and m200 PBs present), 'medium' if they typed a single
          // value without backing test data. Refresh on every launch so users
          // who later complete the paired test see their tier upgrade.
          const hasPair = !!(swim.pbs?.m400 && swim.pbs?.m200);
          mutable.triConfig.swim = {
            ...swim,
            cssConfidence: hasPair ? 'high' : 'medium',
          };
        }

        const bike = mutable.triConfig.bike;
        const bikeSrc = bike?.ftpSource;
        const currentFtp = bike?.ftp;
        const currentConf = bike?.ftpConfidence;
        const derivedFtp = derived.ftp.ftpWatts;
        const ftpConf = derived.ftp.confidence;
        const ftpBlank = !currentFtp;
        // FTP higher = better. Require medium/high confidence so a low-signal
        // estimate cannot overwrite a deliberate test value. Require ≥3W
        // improvement to ignore noise from rounding/normalisation.
        const ftpUserBeaten =
          bikeSrc === 'user' &&
          currentFtp != null &&
          derivedFtp != null &&
          derivedFtp >= currentFtp + 3 &&
          (ftpConf === 'high' || ftpConf === 'medium');
        // Derived → derived: ratchet up only. A saved derived FTP should
        // never be replaced by a *lower* derived value within the same
        // session. That's the regression class where a curve-based 295W
        // gets clobbered by a fallback 193W when the curve temporarily
        // disappears (Strava re-processed, etc). The correct "FTP went
        // down" path is the user manually entering a lower value, which
        // flips ftpSource to 'user'.
        //
        // Exception: if the new derivation has *higher* confidence (e.g.
        // we previously had 'low' fallback and now have 'high' curve),
        // accept it even if the value is slightly lower. Better data
        // wins over a stale higher number.
        const confRank = (c: typeof ftpConf | undefined): number =>
          c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0;
        const ftpDerivedRefresh =
          bikeSrc === 'derived' &&
          derivedFtp != null &&
          (
            currentFtp == null ||
            derivedFtp >= currentFtp ||
            confRank(ftpConf) > confRank(currentConf)
          );
        // Holiday-detrain anchor gate: while a return dock is active, a ride dated on or
        // before the dock (the holiday end) cannot RAISE the docked FTP — a pre-return ride
        // is not evidence of recovery. A ride after the dock supersedes it and clears the
        // anchor. See showHolidayWelcomeBack / ftpDetrainAnchorISO.
        const ftpAnchor = bike?.ftpDetrainAnchorISO;
        const ftpEvidencePostAnchor =
          !ftpAnchor || (derived.ftp.sourceRideISO != null && derived.ftp.sourceRideISO > ftpAnchor);
        const ftpBlockedByAnchor =
          !ftpEvidencePostAnchor && derivedFtp != null && currentFtp != null && derivedFtp > currentFtp;
        if ((ftpBlank || ftpDerivedRefresh || ftpUserBeaten) && derivedFtp && !ftpBlockedByAnchor) {
          if (ftpUserBeaten) {
            console.log(`[tri] FTP auto-improved: user ${currentFtp}W → derived ${derivedFtp}W (${ftpConf} conf)`);
          } else if (ftpDerivedRefresh && currentFtp != null && derivedFtp > currentFtp) {
            console.log(`[tri] FTP auto-improved: derived ${currentFtp}W → ${derivedFtp}W (${ftpConf} conf)`);
          } else if (ftpDerivedRefresh && currentFtp != null && derivedFtp < currentFtp) {
            console.log(`[tri] FTP refreshed with higher-confidence derivation: ${currentFtp}W (${currentConf}) → ${derivedFtp}W (${ftpConf})`);
          }
          mutable.triConfig.bike = {
            ...(bike ?? {}),
            ftp: derivedFtp,
            ftpSource: 'derived',
            ftpConfidence: ftpConf,
            hasPowerMeter: true,
            // A post-return ride cleared the detrain dock; drop the anchor.
            ftpDetrainAnchorISO: ftpEvidencePostAnchor ? undefined : bike?.ftpDetrainAnchorISO,
          };
          appendFtpSample(mutable.triConfig.bike, derivedFtp, 'derived', ftpConf);
        } else if (ftpBlockedByAnchor) {
          console.log(`[tri] FTP held by holiday-detrain anchor (${ftpAnchor}): derived ${derivedFtp}W is from a pre-return ride, keeping docked ${currentFtp}W.`);
        } else if (bikeSrc === 'derived' && currentFtp != null && derivedFtp != null && derivedFtp < currentFtp) {
          // Saved derived value was held; the new derivation produced a
          // *lower* number with same-or-worse confidence. Log the rejection
          // so future "why didn't FTP update?" is one log line away.
          console.log(`[tri] FTP held: derived path returned ${derivedFtp}W (${ftpConf}) but saved is ${currentFtp}W (${currentConf}) — ratchet-up rule, will not regress.`);
        } else if (bikeSrc === 'user' && bike?.ftp) {
          // User-set FTP. 'high' if they actually ran the 20-min test,
          // 'medium' otherwise. Refresh every launch so completing the test
          // later upgrades the tier.
          mutable.triConfig.bike = {
            ...bike,
            ftpConfidence: bike.twentyMinW ? 'high' : 'medium',
          };
        }
      }

      // Plan regeneration when the generator version bumps.
      const savedVersion = state.triConfig.generatorVersion ?? 0;
      if (savedVersion < TRI_GENERATOR_VERSION) {
        const freshWeeks = generateTriathlonPlan(mutable);
        if (freshWeeks.length > 0) {
          for (let i = 0; i < Math.min(mutable.wks.length, freshWeeks.length); i++) {
            // Replacing the array wholesale drops USER-ADDED sessions (session
            // generator / accepted suggestions / holiday bridges live in the
            // same triWorkouts array with adhoc-/holiday- ids). Real incident
            // 2026-06-03: the v18 regen wiped an added Tuesday gym session.
            // Carry them over; only generator-owned slots are replaced.
            const userAdded = (mutable.wks[i].triWorkouts ?? []).filter(
              (w: any) => typeof w.id === 'string' && (w.id.startsWith('adhoc-') || w.id.startsWith('holiday-')),
            );
            mutable.wks[i].triWorkouts = [...freshWeeks[i].triWorkouts!, ...userAdded];
            mutable.wks[i].ph = freshWeeks[i].ph;
          }
          if (mutable.triConfig) mutable.triConfig.generatorVersion = TRI_GENERATOR_VERSION;
          console.log(`[tri] plan regenerated (generator v${savedVersion} → v${TRI_GENERATOR_VERSION})`);
        }
      }

      saveState();

      // FTP / CSS may have just been auto-derived from the activity backfill.
      // Re-run the cross-modal VO2 orchestrator with the DB activity log so:
      //  (a) cycling estimator picks up fresh FTP this launch
      //  (b) running HR-regression sees ALL activities, not just those that
      //      ended up in `wks[].garminActuals`. Closing the gap with running
      //      mode where the same activities are co-located in wks.
      const orchestratorActivities = activityLog.map(a => ({
        startTime: a.startTime ?? null,
        durationSec: a.durationSec ?? 0,
        distanceKm: a.distanceKm ?? 0,
        avgHR: a.avgHR ?? null,
        maxHR: a.maxHR ?? null,
        hrDrift: a.hrDrift ?? null,
        activityType: a.activityType ?? null,
        manualSport: a.manualSport ?? null,
      }));
      refreshVO2Estimates(orchestratorActivities);

      // Re-render the current view so fitness/CTL values surface immediately
      // after the async backfill. Without this, the stats view that rendered
      // pre-backfill keeps showing zeros until a manual reload.
      if (document.getElementById('tri-bike-setup-btn')) {
        const { renderTriathlonStatsView } = await import('@/ui/triathlon/stats-view');
        renderTriathlonStatsView();
      } else if (document.getElementById('tri-progress-back')) {
        const { renderTriProgressDetailView } = await import('@/ui/triathlon/progress-detail-view');
        renderTriProgressDetailView();
      } else if (document.getElementById('tri-fcd-view')) {
        // Forecast chip detail (e.g. Endurance) is open. Re-render the SAME
        // chip so the just-persisted `recentDisciplineActivity` (per-discipline
        // volume + longest) surfaces immediately. Without this, a cold sign-in
        // that lands on this page shows 0 until a manual navigate-away/back,
        // because the page rendered before the background distillation wrote.
        const chip = document.getElementById('tri-fcd-view')?.getAttribute('data-chip');
        if (chip) {
          const { renderTriForecastChipDetail } = await import('@/ui/triathlon/forecast-chip-detail-view');
          renderTriForecastChipDetail(chip as Parameters<typeof renderTriForecastChipDetail>[0]);
        }
      } else if (document.getElementById('tri-fc-account-btn')) {
        const { renderTriathlonForecastView } = await import('@/ui/triathlon/forecast-view');
        renderTriathlonForecastView();
      } else if (document.getElementById('home-tss-row')) {
        scheduleHomeRefresh();
      }

      const ftpDetail = derived.ftp.ftpWatts
        ? `${derived.ftp.ftpWatts}W (${derived.ftp.confidence} conf, ${derived.ftp.contributingRideCount ?? 0} rides, newest ${derived.ftp.newestContributingRideWeeksOld ?? '?'}w old)`
        : `— (${derived.ftp.confidence})`;
      console.log('[tri] benchmarks refreshed from history:',
        `CSS ${derived.css.cssSecPer100m ? `${derived.css.cssSecPer100m}s/100m` : '—'}`,
        `FTP ${ftpDetail}`,
        `CTL swim/bike/run ${derived.fitness.swim.ctl}/${derived.fitness.bike.ctl}/${derived.fitness.run.ctl} (${derived.fitness.activityCount} activities)`,
      );
    } catch (err) {
      console.warn('[tri] benchmark/plan refresh failed', err);
    }
  }

  // HYROX: refresh MTL CTL/ATL from planned weeks on every launch.
  if (hasState && state.eventType === 'hyrox' && state.hyroxConfig) {
    // ── Format & benchmark migration (one-time, idempotent) ─────────────────
    // 1. Old format values (open/pro/doubles) → new 4-value format.
    // 2. Legacy stationBenchmarks (pooled) → format-specific Singles/Doubles slot.
    try {
      const mutable = getMutableState();
      const hx = mutable.hyroxConfig!;
      const oldFormat = hx.format as string;
      if (oldFormat === 'open')         hx.format = 'open_singles' as any;
      else if (oldFormat === 'pro')     hx.format = 'pro_singles' as any;
      else if (oldFormat === 'doubles') hx.format = 'open_doubles' as any;

      const isDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
      const hasLegacy = hx.stationBenchmarks != null && Object.keys(hx.stationBenchmarks).length > 0;
      const hasSingles = hx.stationBenchmarksSingles != null && Object.keys(hx.stationBenchmarksSingles).length > 0;
      const hasDoubles = hx.stationBenchmarksDoubles != null && Object.keys(hx.stationBenchmarksDoubles).length > 0;
      if (hasLegacy && !hasSingles && !hasDoubles) {
        if (isDoubles) {
          hx.stationBenchmarksDoubles = { ...hx.stationBenchmarks };
        } else {
          hx.stationBenchmarksSingles = { ...hx.stationBenchmarks };
        }
        console.log(`[hyrox migration] copied legacy stationBenchmarks → ${isDoubles ? 'Doubles' : 'Singles'} slot (${Object.keys(hx.stationBenchmarks!).length} stations)`);
      }

      // 3. Doubles-in-singles repair: pre-fix init logic keyed slot off the
      //    target format. Users who entered doubles splits got them stored in
      //    the Singles slot. Detection condition is sharp (prev fmt = doubles
      //    AND singles populated AND doubles empty). Idempotent on already-
      //    correct state.
      const prevFmt = hx.hyroxPreviousTimeFormat;
      const prevIsDoubles = prevFmt === 'open_doubles' || prevFmt === 'pro_doubles';
      const refreshedSingles = hx.stationBenchmarksSingles
        && Object.keys(hx.stationBenchmarksSingles).length > 0;
      const refreshedDoublesEmpty = !hx.stationBenchmarksDoubles
        || Object.keys(hx.stationBenchmarksDoubles).length === 0;
      if (prevIsDoubles && refreshedSingles && refreshedDoublesEmpty) {
        hx.stationBenchmarksDoubles = { ...hx.stationBenchmarksSingles };
        hx.stationBenchmarksSingles = undefined;
        console.log(`[hyrox migration] moved ${Object.keys(hx.stationBenchmarksDoubles!).length} stations Singles→Doubles slot (prev race was ${prevFmt})`);
      }

      // 4. Backfill stationBenchmarkHistory for users with existing benchmarks
      //    but no history records (existing users from before history landed).
      //    Seeds one entry per station with today's date and source 'manual'.
      //    The actual test was older; today is a pragmatic anchor for future
      //    PR comparisons. Idempotent: skipped when history already has entries
      //    for the station.
      const fmt = hx.format as 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
      const isDouble = fmt === 'open_doubles' || fmt === 'pro_doubles';
      const currentBenchmarks = isDouble
        ? hx.stationBenchmarksDoubles
        : hx.stationBenchmarksSingles;
      if (currentBenchmarks && Object.keys(currentBenchmarks).length > 0) {
        hx.stationBenchmarkHistory = hx.stationBenchmarkHistory ?? {};
        const today = new Date().toISOString().slice(0, 10);
        let backfilled = 0;
        for (const [station, sec] of Object.entries(currentBenchmarks)) {
          if (sec == null) continue;
          const existingForStation = hx.stationBenchmarkHistory[station as keyof typeof hx.stationBenchmarkHistory];
          if (existingForStation && existingForStation.length > 0) continue;
          hx.stationBenchmarkHistory[station as keyof typeof hx.stationBenchmarkHistory] = [{
            dateISO: today,
            sec: sec as number,
            source: 'manual' as const,
            format: fmt,
            proWeights: !!hx.benchmarksAtProWeights,
          }];
          backfilled += 1;
        }
        if (backfilled > 0) {
          console.log(`[hyrox migration] backfilled stationBenchmarkHistory for ${backfilled} station${backfilled > 1 ? 's' : ''}`);
        }
      }

      saveState();
    } catch (err) {
      console.warn('[hyrox] format/benchmark migration failed', err);
    }

    // Plan regeneration when the HYROX generator version bumps. Mirrors the
    // triathlon path at the top of this file. Without this, every bump of
    // HYROX_GENERATOR_VERSION was a silent no-op for existing users. The
    // header comment claimed regen-on-launch but the wiring was never built.
    try {
      const { generateHyroxPlan, HYROX_GENERATOR_VERSION } = await import('@/workouts/plan_engine.hyrox');
      const mutable = getMutableState();
      const savedVersion = mutable.hyroxConfig?.generatorVersion ?? 0;
      if (savedVersion < HYROX_GENERATOR_VERSION && mutable.hyroxConfig) {
        const freshWeeks = generateHyroxPlan(mutable);
        if (freshWeeks.length > 0) {
          for (let i = 0; i < Math.min(mutable.wks.length, freshWeeks.length); i++) {
            // Mirror of the tri regen: preserve user-added sessions (adhoc-/
            // holiday- ids) — wholesale replacement deletes them.
            const userAdded = (mutable.wks[i].triWorkouts ?? []).filter(
              (w: any) => typeof w.id === 'string' && (w.id.startsWith('adhoc-') || w.id.startsWith('holiday-')),
            );
            mutable.wks[i].triWorkouts = [...freshWeeks[i].triWorkouts!, ...userAdded];
            mutable.wks[i].ph = freshWeeks[i].ph;
          }
          mutable.hyroxConfig.generatorVersion = HYROX_GENERATOR_VERSION;
          console.log(`[hyrox] plan regenerated (generator v${savedVersion} → v${HYROX_GENERATOR_VERSION})`);
          saveState();
        }
      }
    } catch (err) {
      console.warn('[hyrox] plan regeneration failed', err);
    }

    try {
      const { computeMTLFitnessFatigue, computeMTLFitnessFatigueByDiscipline } = await import('@/calculations/mtl');
      const mutable = getMutableState();
      const weeks = mutable.wks ?? [];
      const currentIdx = Math.max(0, (mutable.w ?? 1) - 1);
      const { mtlCTL, mtlATL } = computeMTLFitnessFatigue(weeks, currentIdx);
      const split = computeMTLFitnessFatigueByDiscipline(weeks, currentIdx);
      if (mutable.hyroxConfig) {
        mutable.hyroxConfig.mtlCTL = mtlCTL;
        mutable.hyroxConfig.mtlATL = mtlATL;
        mutable.hyroxConfig.runMtlCTL     = split.runMtlCTL;
        mutable.hyroxConfig.runMtlATL     = split.runMtlATL;
        mutable.hyroxConfig.stationMtlCTL = split.stationMtlCTL;
        mutable.hyroxConfig.stationMtlATL = split.stationMtlATL;
        mutable.hyroxConfig.brickMtlCTL   = split.brickMtlCTL;
        mutable.hyroxConfig.brickMtlATL   = split.brickMtlATL;
        // weeklyMTL = current week's planned MTL (for display / cap enforcement)
        const { computeWeekMTL } = await import('@/calculations/mtl');
        mutable.hyroxConfig.weeklyMTL = computeWeekMTL(weeks[currentIdx] ?? { triWorkouts: [] } as any);
        console.log(`[hyrox] MTL CTL/ATL refreshed: CTL=${mtlCTL.toFixed(1)} ATL=${mtlATL.toFixed(1)} ACWR=${mtlCTL > 0 ? (mtlATL / mtlCTL).toFixed(2) : '—'} · run=${split.runMtlCTL.toFixed(1)} station=${split.stationMtlCTL.toFixed(1)} brick=${split.brickMtlCTL.toFixed(1)}`);
      }
      saveState();
    } catch (err) {
      console.warn('[hyrox] MTL refresh failed', err);
    }

    // HYROX run pace yield-to-improvements. Auto-derive from VDOT and overwrite
    // hx.hyroxRunPaceSecKm when the derived value is meaningfully faster than
    // the stored user value. Mirrors triathlon's marker-bump pattern. Toast
    // surfacing happens inside the forecast view on next render.
    try {
      const { applyHyroxRunPaceDerivation, detectHyroxMarkerBumps, snapshotHyroxNotifiedMarkers }
        = await import('@/calculations/hyrox-marker-bumps');
      const mutable = getMutableState();
      // Order matters: detect BEFORE apply. detectHyroxMarkerBumps re-derives
      // from current state and gates on `result.source === 'derived'`. If apply
      // ran first, it would have already written derived→hyroxRunPaceSecKm,
      // making the next derive call see userVal === derived and return
      // source='user'. Bump never fires. See hyrox-marker-bumps.test.ts.
      const bumps = detectHyroxMarkerBumps(mutable);
      const wrote = applyHyroxRunPaceDerivation(mutable);
      for (const b of bumps) {
        console.log(`[hyrox marker-bump] ${b.toastText}`);
      }
      snapshotHyroxNotifiedMarkers(mutable);
      if (wrote || bumps.length > 0) saveState();
    } catch (err) {
      console.warn('[hyrox] marker-bump pass failed', err);
    }

    // Boot-time: compute the initial personal run-pace offset for existing
    // HYROX users who pre-date the v2 (CP-anchored) model. Idempotent —
    // skips when the offset has already been populated. Without this,
    // existing users wouldn't see the Bayesian personalisation until they
    // re-onboard. See SCIENCE_LOG §AA.
    try {
      const { refreshHyroxPersonalRunPaceOffset } = await import('@/calculations/hyrox-run-pace');
      const mutable = getMutableState();
      if (refreshHyroxPersonalRunPaceOffset(mutable)) saveState();
    } catch (err) {
      console.warn('[hyrox] personal run-pace offset refresh failed', err);
    }
  }

  // Check if onboarding is complete
  if (hasState && state.hasCompletedOnboarding) {
    // Record app open (used for debrief timing), then go straight to home
    // Correct a planStartDate that drifted later than the earliest logged
    // activity (backfill arrived after the anchor was derived) BEFORE advancing,
    // so s.w recomputes from the right anchor.
    if (reconcilePlanAnchorToEarliestActivity()) saveState();
    advanceWeekToToday(); // silently advances week + applies detraining if behind calendar
    assertPlanAnchorConsistent(); // tripwire: warn loudly if s.w and planStartDate disagree

    // Boot-time: commute drift. If recent completed weeks logged consistently
    // fewer commute days than declared, trim the baseline so the plan stops
    // over-prescribing commute slots. Runs BEFORE the forecast refresh below so
    // the same-launch forecast uses the trimmed commute count. Only ever
    // reduces; converges (next launch sees the lower declared and won't
    // re-fire). CLAUDE.md → Adaptation transparency: small change → small toast.
    try {
      const { detectCommuteDrift } = await import('@/calculations/commute-drift');
      const ms = getMutableState();
      if (ms.commuteConfig?.enabled) {
        const drift = detectCommuteDrift(ms.wks ?? [], ms.w ?? 1, ms.commuteConfig);
        if (drift) {
          ms.commuteConfig.commuteDaysPerWeek = drift.newDays;
          console.log(`[commute-drift] baseline ${drift.oldDays} → ${drift.newDays} day(s)/week (observed ${drift.observed.join(',')})`);
          saveState();
          const { showMarkerBumpToast } = await import('@/ui/toast');
          const dayLabel = drift.newDays === 1 ? 'day' : 'days';
          showMarkerBumpToast([`Commute baseline trimmed to ${drift.newDays} ${dayLabel}/week. Recent weeks logged fewer commute runs than declared.`]);
        }
      }
    } catch (err) {
      console.warn('[commute-drift] pass failed', err);
    }

    // Boot-time migration: refresh blended VDOT so existing users (who have
    // wkGain deprecated) see current fitness, not Week-1 baseline.
    try {
      const { refreshBlendedFitness } = await import('@/calculations/blended-fitness');
      refreshBlendedFitness(getMutableState());
    } catch {}

    // Boot-time: refresh course-factor adjusted forecast so users who picked
    // a race before this feature shipped see the new adjustment immediately.
    try {
      const { refreshForecastCourseFactors } = await import('@/calculations/course-factors-running');
      refreshForecastCourseFactors(getMutableState());
    } catch {}

    // One-time migration (v2): wipe sportNameMappings entirely. Name-keyed
    // propagation of user reclassifications is unsafe because Strava reuses
    // generic names ("Workout", "Morning Activity") across unrelated sessions —
    // one correction would flip every same-named activity. Reclassification now
    // writes only per-activity manualSport (preserved across this migration).
    // v2 supersedes v1 (which still allowed mapping writes for ambiguous types).
    {
      const _ms = getMutableState() as any;
      if (!_ms._sportNameMappingsResetV2) {
        _ms.sportNameMappings = {};
        _ms._sportNameMappingsResetV2 = true;
        saveState();
      }
    }

    // If s.w advanced past a week that never had a full debrief (with plan preview),
    // roll back so the debrief fires in 'complete' mode.
    {
      const _ms = getMutableState() as any;
      // One-time migration (v3): reseed lastCompleteDebriefWeek from lastDebriefWeek - 1
      // so previously "stuck" users whose step-3 click was inadvertent get their debrief back.
      if (!_ms._debriefGateV3) {
        _ms.lastCompleteDebriefWeek = Math.max(0, ((_ms.lastDebriefWeek ?? _ms.w) ?? 1) - 1);
        _ms._debriefGateV3 = true;
        saveState();
      }
      // Triathlon users are exempt from the debrief gate. No plan-preview debrief exists.
      const lastComplete = _ms.lastCompleteDebriefWeek ?? 0;
      if (_ms.eventType !== 'triathlon' && _ms.w > lastComplete + 1) {
        _ms.w = lastComplete + 1;
        saveState();
      }
    }

    if (healMissingITrimp()) saveState(); // back-fill iTrimp for actuals synced before profile HR was set

    // Back-fill recentLegLoads for runs and cross-training synced before this pass.
    // Required for Leg Fatigue to reflect runs that landed via auto-match without
    // passing through the activity-review write path. Idempotent.
    {
      const { reconcileRecentLegLoads } = await import('@/ui/sport-picker-modal');
      if (reconcileRecentLegLoads()) saveState();
    }

    // Recompute athleteTier from current ctlBaseline. State may be stale from
    // an earlier CTL value (e.g. pre-fix readings) and the tier only updates
    // when fetchStravaHistory runs, which is cache-skipped on most launches.
    {
      const _ms = getMutableState();
      const expected = deriveAthleteTier(_ms.ctlBaseline ?? 0, {
        vdot: _ms.v,
        ftpWatts: _ms.onboarding?.triBike?.ftp,
      });
      if (_ms.athleteTier !== expected) {
        _ms.athleteTier = expected;
        saveState();
      }
    }

    // One-time cleanup: wk1 contained dummy test data (rawTSS ~1309) that inflates CTL.
    // Clear garminActuals and adhocWorkouts from wk1 so the EMA seed is the only baseline.
    const ms = getMutableState();
    const wk1 = ms.wks?.[0];
    if (wk1 && !(wk1 as any)._dummyDataCleared) {
      const { computeWeekRawTSS } = await import('@/calculations/fitness-model');
      const wk1TSS = computeWeekRawTSS(wk1, wk1.rated ?? {}, ms.planStartDate);
      if (wk1TSS > 800) {
        console.log(`[Cleanup] wk1 rawTSS=${wk1TSS} — clearing dummy data`);
        wk1.garminActuals = {};
        wk1.adhocWorkouts = [];
        wk1.unspentLoadItems = [];
        wk1.rated = {};
        (wk1 as any)._dummyDataCleared = true;
        saveState();
      }
    }
    // Cleanup: if holidayState exists with active=true but endDate has passed, force-clear it.
    // This handles interrupted end flows from before the fix.
    // Scrub during-holiday artifacts (adhoc sessions, forceDeload) but PRESERVE
    // post-holiday bridge mods (_holidayBridgeScale, weekAdjustmentReason, __holiday_bridge__)
    // which were deliberately written by showHolidayWelcomeBack and need to persist.
    {
      const hs = ms.holidayState;
      const nowISO = new Date().toISOString().split('T')[0];
      const isActiveAndValid = hs?.active && hs.endDate && nowISO <= hs.endDate;
      if (hs && !isActiveAndValid) {
        delete (ms as any).holidayState;
        for (const wk of (ms.wks || [])) {
          if (wk.adhocWorkouts?.length) {
            wk.adhocWorkouts = wk.adhocWorkouts.filter((w: any) => !(w.id || '').startsWith('holiday-'));
          }
          delete (wk as any).forceDeload;
        }
        saveState();
      }
    }

    // One-time repair: reverse VDOT docking + bridge mods from a same-day cancelled holiday.
    // The old code triggered welcome-back even for holidays that lasted 0 days.
    if (!(ms as any)._holidayRepairDone) {
      const hh = ms.holidayHistory;
      if (hh?.length) {
        const last = hh[hh.length - 1];
        const daysActive = Math.round((new Date(last.endDate + 'T12:00:00').getTime() - new Date(last.startDate + 'T12:00:00').getTime()) / 86400000) + 1;
        if (daysActive < 3) {
          // This was a trivially short holiday. Undo VDOT loss (add back ~0.6)
          // and clear any bridge mods it wrote
          if (ms.v) ms.v = Math.round((ms.v + 0.6) * 10) / 10;
          for (const wk of (ms.wks || [])) {
            wk.workoutMods = (wk.workoutMods || []).filter(m => !m.modReason?.startsWith('Post-holiday'));
            if ((wk as any)._holidayBridgeScale) delete (wk as any)._holidayBridgeScale;
            if ((wk as any)._holidayBridgeDowngrade) delete (wk as any)._holidayBridgeDowngrade;
            if (wk.weekAdjustmentReason?.startsWith('Post-holiday')) wk.weekAdjustmentReason = undefined;
          }
          hh.pop(); // remove the bad history entry
          console.log('[Cleanup] Reversed VDOT docking from same-day cancelled holiday');
        }
      }
      (ms as any)._holidayRepairDone = true;
      saveState();
    }
    // One-time cleanup: remove spurious holiday adhoc sessions (holiday-* IDs)
    // that were added by the old silent "Generate session" button before the chooser was built.
    if (!(ms as any)._holidayAdhocCleaned) {
      for (const wk of (ms.wks || [])) {
        if (wk.adhocWorkouts?.length) {
          wk.adhocWorkouts = wk.adhocWorkouts.filter((w: any) => !(w.id || '').startsWith('holiday-'));
        }
      }
      (ms as any)._holidayAdhocCleaned = true;
      saveState();
    }
    // One-time cleanup: remove strava-test-* entries injected by test-rpe.js
    // that were not fully cleaned (garminActuals, rated, unspentLoadItems were missed).
    if (!(ms as any)._testDataCleaned3) {
      let cleaned = 0;
      for (const wk of (ms.wks || [])) {
        if (wk.garminActuals) {
          for (const key of Object.keys(wk.garminActuals)) {
            if (key.includes('strava-test-')) {
              delete wk.garminActuals[key];
              cleaned++;
            }
          }
        }
        if (wk.adhocWorkouts?.length) {
          const before = wk.adhocWorkouts.length;
          wk.adhocWorkouts = wk.adhocWorkouts.filter((w: any) => !(w.id || '').includes('strava-test-'));
          cleaned += before - wk.adhocWorkouts.length;
        }
        if (wk.garminPending?.length) {
          wk.garminPending = wk.garminPending.filter((p: any) => !(p.garminId || '').includes('strava-test-'));
        }
        if (wk.garminMatched) {
          for (const k of Object.keys(wk.garminMatched)) {
            if (k.includes('strava-test-')) delete wk.garminMatched[k];
          }
        }
        if (wk.rated) {
          for (const k of Object.keys(wk.rated)) {
            if (k.includes('strava-test-')) delete wk.rated[k];
          }
        }
        if (wk.unspentLoadItems?.length) {
          const before = wk.unspentLoadItems.length;
          wk.unspentLoadItems = wk.unspentLoadItems.filter((item: any) => !(item.garminId || '').includes('strava-test-'));
          cleaned += before - wk.unspentLoadItems.length;
        }
      }
      // Also fix surplus unspentLoadItems that leaked workout descriptions as displayName
      for (const wk of (ms.wks || [])) {
        for (const item of (wk.unspentLoadItems ?? [])) {
          if ((item as any).reason === 'surplus_run' && item.displayName !== 'Running') {
            item.displayName = 'Running';
            cleaned++;
          }
        }
      }
      (ms as any)._testDataCleaned3 = true;
      if (cleaned > 0) console.log(`[Cleanup] Cleaned ${cleaned} stale entries`);
      saveState();
    }
    recordAppOpen();

    // Evaluate proactive coach triggers (HRV crash, marker bump, race week) and
    // append any newly fireable insights to the queue. Pure state logic. No
    // LLM call is made here; the call only happens if the user taps the Home
    // insight card. Wrapped in try/catch so a detector bug never blocks launch.
    try {
      const { evaluateCoachTriggers } = await import('@/coach/coach-triggers');
      const ms2 = getMutableState();
      const newInsights = evaluateCoachTriggers(ms2);
      if (newInsights.length > 0) {
        if (!ms2.coachInsightQueue) ms2.coachInsightQueue = [];
        ms2.coachInsightQueue.push(...newInsights);
        // Cap the queue at 5. Overflow means a trigger bug, drop the oldest.
        if (ms2.coachInsightQueue.length > 5) {
          ms2.coachInsightQueue.splice(0, ms2.coachInsightQueue.length - 5);
        }
        saveState();
      }
    } catch (err) {
      console.warn('[coach-triggers] evaluation failed:', err);
    }

    // Check if holiday ended while the app was closed. Show welcome-back before home
    if (checkHolidayEnd()) {
      showHolidayWelcomeBack(() => {
        renderHomeView();
        const pendingDebrief2 = isWeekPendingDebrief();
        import('@/ui/week-debrief').then(({ fireDebriefIfReady }) => {
          fireDebriefIfReady(pendingDebrief2);
        });
      });
    } else {
      renderHomeView();
      // Auto-fire week-end debrief if a week just completed (once per week, after home renders)
      // If calendar is ahead of s.w (advance was held pending debrief), show in 'complete' mode
      // so the user gets the full flow: summary → animation → plan preview → advance.
      // fireDebriefIfReady defers when a matching screen is open or activities are still
      // unassigned. The retry fires from activitySync.ts after the user saves matching.
      const pendingDebrief = isWeekPendingDebrief();
      import('@/ui/week-debrief').then(({ fireDebriefIfReady }) => {
        fireDebriefIfReady(pendingDebrief);
      });
    }

    // Health disclaimer. App Store §1.4. One-time acknowledgement for existing users.
    // New users hit this after wizard completes via the same call inside initWizard.
    import('@/ui/health-disclaimer').then(({ maybeShowHealthDisclaimer }) => {
      void maybeShowHealthDisclaimer();
    });
  } else {
    // Show onboarding wizard
    initWizard();
  }

  // Render admin panel if enabled
  const adminPanel = document.getElementById('admin-panel');
  if (adminPanel && state.isAdmin) {
    adminPanel.innerHTML = renderAdminPanel();
    wireAdminHandlers();
  }

  // Admin mode toggle: Ctrl+Shift+A
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      toggleAdminMode();
    }
  });

  // Native iOS OAuth return is handled by ASWebAuthenticationSession inside
  // startStravaConnect/startGarminConnect (the @mosaic/web-auth plugin): it
  // intercepts the mosaic://oauth?... callback and the connect flow re-enters
  // the app with that query string itself. No appUrlOpen listener needed — the
  // `?strava=connected` / `?garmin=connected` handlers below do the rest.

  // Handle OAuth redirects.
  // Only route to account-view when the user is actually on main-view. A user
  // mid-wizard (e.g. editing goals after having completed onboarding once) has
  // hasCompletedOnboarding=true but a non-main-view currentStep. Routing them
  // to account-view drops them out of the wizard flow.
  const params = new URLSearchParams(window.location.search);
  const onMainView = hasState && state.hasCompletedOnboarding
    && (!state.onboarding || state.onboarding.currentStep === 'main-view');

  if (params.get('garmin') === 'connected') {
    window.history.replaceState({}, '', window.location.pathname);
    // Mark Garmin as the physiology source so launch-time sync (hasPhysiologySource
    // check in the Strava branch below) picks it up on the next reload, and so the
    // Account view flips out of Strava-standalone mode.
    if (state.wearable !== 'garmin') {
      import('@/state').then(({ updateState, saveState }) => {
        updateState({ wearable: 'garmin' });
        saveState();
      });
    }
    showGarminConnectedToast();
    if (onMainView) {
      import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
    }
    // Mid-wizard: toast shows and wizard continues.
  }

  if (STRAVA_ENABLED && params.get('strava') === 'connected') {
    // Read the athlete profile the callback passed back BEFORE we strip the query
    // string. Strava sends sex ('M'/'F') and weight (kg) so onboarding can pre-fill
    // them (about-you). Strava exposes no birthdate, so age is still asked.
    const stravaSex = params.get('sex');
    const stravaWeight = params.get('weight');
    // Fork guard (ISSUE-270): the callback counted activities this Strava
    // athlete holds under PRIOR user accounts (anonymous-auth forks). > 0 means
    // history exists to reclaim via strava-claim-history.
    const existingCount = Number(params.get('existing') ?? '0') || 0;
    window.history.replaceState({}, '', window.location.pathname);
    import('@/state').then(({ updateState, saveState }) => {
      updateState({ stravaConnected: true });
      // Pre-fill onboarding profile from the Strava athlete, without clobbering
      // anything the user already entered.
      const ob = state.onboarding;
      if (ob) {
        const patch: Partial<typeof ob> = {};
        if (!ob.biologicalSex && (stravaSex === 'M' || stravaSex === 'F')) {
          patch.biologicalSex = stravaSex === 'M' ? 'male' : 'female';
        }
        const w = stravaWeight ? Number(stravaWeight) : NaN;
        if (!ob.bodyWeightKg && Number.isFinite(w) && w > 0) {
          patch.bodyWeightKg = Math.round(w * 10) / 10;
        }
        if (Object.keys(patch).length > 0) {
          updateState({ onboarding: { ...ob, ...patch } });
        }
      }
      saveState();
    });
    resetStravaCache();
    showStravaConnectedToast();
    // Always kick off the sync after OAuth. The wizard's review step reads from
    // the DB and needs activities there before it can decide to show vs divert.
    // When prior-account history exists (fork guard), reunite it FIRST so the
    // sync + review/benchmarks see the full record:
    //   - mid-wizard: claim silently — it is the user's own data and the
    //     onboarding numbers are strictly better with it
    //   - main view: confirm via overlay — an established plan exists, the
    //     user decides when their history merges in
    const runStravaSync = () => syncStravaActivities().catch(() => {});
    if (existingCount > 0 && !onMainView) {
      setTimeout(() => {
        import('@/data/strava-claim')
          .then(({ claimStravaHistory }) => claimStravaHistory())
          .then((result) => {
            // Visible, not silent: fresh-starters should see their history return.
            if (result && result.moved > 0) showHistoryImportedToast(result.moved);
          })
          .catch(() => null)
          .finally(runStravaSync);
      }, 500);
    } else if (existingCount > 0 && onMainView) {
      setTimeout(() => {
        import('@/ui/history-claim-overlay')
          .then(({ openHistoryClaimOverlay }) => openHistoryClaimOverlay(existingCount, runStravaSync))
          .catch(runStravaSync);
      }, 500);
    } else {
      setTimeout(runStravaSync, 500);
    }
    if (onMainView) {
      import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
    }
    // Mid-wizard: the connect-data step detects the return directly from the live
    // ?strava=connected URL (it renders in initWizard, before this handler strips the
    // query string), so no extra flag is needed. An earlier sessionStorage flag set
    // here was never cleared and made connect-data auto-skip on every later visit.
  }

  // ── ISSUE-263 one-time load-currency migration ─────────────────────────────
  // Local-state migration: MUST run on every launch path, including simulator
  // mode (it was originally placed inside the !isSimulatorMode() sync block and
  // silently skipped on the dev server — caught in device verification).
  // Workouts saved before 2026-06-04 carry pre-canonical load stamps:
  // tri/cycling plan sessions on the old ~60/h-easy engine scale, and synced
  // adhoc cross sessions with Garmin Training Effect (0–5) on w.aerobic
  // (SEV-1). Running-mode workouts regenerate every render, so only stored
  // workouts need healing. PLANNED tri run sessions are restamped from the
  // canonical type-keyed valuation; adhoc TE relics are restamped from
  // iTRIMP (personal normalizer) or duration. Completed sessions keep their
  // historical values (the freeze-check accounts for them).
  if (!state.loadCurrencyV2) {
    let restamped = 0;
    const TRI_RUN_SHARES: Record<string, { a: number; an: number }> = {
      easy: { a: 0.95, an: 0.05 }, long: { a: 0.88, an: 0.12 }, threshold: { a: 0.77, an: 0.23 },
    };
    for (const wk of state.wks ?? []) {
      for (const w of (wk as any).triWorkouts ?? []) {
        if (w.discipline !== 'run') continue;
        if (w.status === 'completed' || (w as any).matchedActivityId) continue;
        const shares = TRI_RUN_SHARES[w.t ?? ''];
        const durMin = w.estimatedDurationMin;
        if (!shares || !durMin || durMin <= 0) continue;
        const total = durMin * plannedTssPerMin(w.t ?? '');
        const newAero = Math.round(total * shares.a);
        if (w.aerobic === newAero) continue;
        w.aerobic = newAero;
        w.anaerobic = Math.round(total * shares.an);
        restamped++;
      }
      for (const w of wk.adhocWorkouts ?? []) {
        const wa = w as any;
        // TE relic detection: synced item whose stamped load is on the 0–5
        // scale. Real TSS loads for any session are ≥ ~10.
        if (!wa.garminTimestamp) continue;
        const total = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
        if (total <= 0 || total > 10) continue;
        if (wa.iTrimp != null && wa.iTrimp > 0) {
          const tss = normalizeiTrimp(wa.iTrimp);
          w.aerobic = Math.round(tss * 0.85);
          w.anaerobic = Math.round(tss * 0.15);
          restamped++;
        } else if (wa.garminDurationMin > 0) {
          const loads = calculateWorkoutLoad(w.t ?? 'cross', wa.garminDurationMin, (w.rpe ?? w.r ?? 5) * 10);
          w.aerobic = loads.aerobic;
          w.anaerobic = loads.anaerobic;
          restamped++;
        }
      }
    }
    state.loadCurrencyV2 = true;
    saveState();
    console.log(`[load-currency] one-time migration ran: restamped ${restamped} workout load(s) to canonical TSS`);
  }

  // Sync wearable data on launch (skip in simulator mode. No auth)
  if (!isSimulatorMode()) {
    // Fork-convergence check (ISSUE-270): once a day, ask whether this Strava
    // athlete has history stranded under prior accounts (a fork can form while
    // this device is idle). Main view + Strava connected only; the OAuth
    // return path handles the connect moment itself.
    if (onMainView && state.stravaConnected) {
      setTimeout(() => {
        import('@/data/strava-claim').then(m => m.maybeOfferClaimOnLaunch()).catch(() => {});
      }, 3000);
    }
    const activitySrc = getActivitySource(state);
    const hasGarminPhysio = hasPhysiologySource(state, 'garmin');
    // Apple Health is a SUPPLEMENTARY source. It can run alongside a Garmin/Strava
    // primary, not just as the sole source. `appleHealthConnected` is the device-local
    // "HealthKit authorized here" flag; the legacy check covers users whose physiology
    // primary is already Apple.
    const appleConnected = !!state.appleHealthConnected || hasPhysiologySource(state, 'apple');

    // Collapse any same-session duplicates already sitting in local state BEFORE
    // the network syncs run. The per-sync dedup only fires when a sync completes;
    // if syncActivities errors (revoked token, RLS) the duplicates persist across
    // loads. Running it here is network-independent, so a dev-account user who
    // receives each session from both Garmin webhook and Strava sees one copy
    // immediately on launch. Idempotent; re-render only when it changed something.
    if (reconcileCrossSourceDuplicates()) { saveState(); scheduleHomeRefresh(); }

    // Pull any activity enrichments done on another device (e.g. a Strava file
    // uploaded on the web app) into this device's thin copies. Independent of
    // the full-snapshot backup; safe to run every launch. Fire-and-forget.
    void mergeEnrichmentsFromServer({ force: true });


    // ── ACTIVITIES ────────────────────────────────────────────────────────────
    if (activitySrc === 'apple') {
      // Apple Watch primary: activities via HealthKit (iOS only. No-op on web)
      syncAppleHealth()
        .then(() => {
          // Register the HealthKit observer + background delivery so any
          // workout that lands in HealthKit after this point (Apple Watch,
          // Strava-to-Health, Garmin-Connect-to-Health) wakes the app and
          // triggers an incremental sync without requiring a manual launch.
          subscribeToWorkoutObserver().catch(() => {});
        })
        .catch(() => {});
      // Belt-and-braces: re-sync on foreground if the observer dropped a
      // background push while the app was suspended. Registers a listener once;
      // throttled to once per 5 min via appleHistoryLastRefreshedAt.
      subscribeToForegroundResume();
    } else if (STRAVA_ENABLED && state.stravaConnected) {
      // Strava is the activity source for any user who has it connected.
      isStravaConnected().then((stravaOk) => {
        if (!stravaOk) return;
        syncStravaActivities().then(() => {
          // After Strava sync, also run the DB sync so the upgrade loop in matchAndAutoComplete
          // can replace any Garmin-sourced actuals that now have Strava counterparts in DB.
          // sync-strava-activities skips cached-with-zones rows in its response, so without
          // this second pass the upgrade loop never sees them.
          syncActivities().catch(() => {});
          // Re-render home view if it's still active so TSS reflects post-sync state
          scheduleHomeRefresh();
          // Triathlon prediction refresh. Runs only when in triathlon mode.
          refreshTriPredictionAfterSync().catch(() => {});
          // Running + HYROX race-outcome detection. Mirrors the tri logger
          // above so post-race results are captured across all three modes.
          detectRaceOutcomeAfterSync().catch(() => {});
        }).catch(() => {});
      }).catch(() => {});
    } else {
      // Garmin-only: activities from Garmin webhook
      isGarminConnected().then((connected) => {
        if (!connected) return;
        syncActivities().then(() => {
          scheduleHomeRefresh();
        }).catch(() => {});
        processPendingCrossTraining();
      }).catch(() => {});
    }

    // Supplementary Apple Health activity source. A Garmin/Strava user who has
    // also connected Apple Health gets their workouts pulled from HealthKit too,
    // carrying the HR stream, zones, route and km splits the Garmin webhook
    // summary lacks. For users with no Strava/Garmin API access this is the only
    // automatic activity path. Runs IN ADDITION to the primary source above;
    // matchAndAutoComplete dedups so Strava > Apple Health > Garmin-webhook-summary
    // for the same activity. Gated on Apple Health being authorized on this device
    // so we never surprise-prompt a user who hasn't opted in.
    if (activitySrc !== 'apple' && appleConnected) {
      syncAppleHealth()
        .then(() => { subscribeToWorkoutObserver().catch(() => {}); })
        .catch(() => {});
      subscribeToForegroundResume();
    }

    // ── PHYSIOLOGY (additive: Garmin primary, Apple fills the gaps) ─────────────
    // Both providers can contribute. Both merge per-day/per-field now: Garmin's
    // syncPhysiologySnapshot overwrites only the fields it has data for, and the
    // Apple sync prefers existing (Garmin) values. Garmin still runs first so it
    // stays the primary; Apple gap-fills any night Garmin missed.
    // syncAppleHealthPhysiology is a no-op on web, so this is safe on localhost.
    const syncAllPhysiology = async (): Promise<void> => {
      if (hasGarminPhysio) {
        const garminOk = await isGarminConnected().catch(() => false);
        if (garminOk) {
          // Backfill first (idempotent), then snapshot so state reflects fresh DB data.
          await triggerGarminBackfill(8).catch(() => {});
          // Fetch today's steps immediately (fast. Single epoch window).
          syncTodaySteps().then(() => scheduleHomeRefresh()).catch(() => {});
          await syncPhysiologySnapshot(90).catch(() => {});
          const ps = getState();
          setAthleteNormalizer(ps.ltHR, ps.restingHR, ps.maxHR);
          refreshVO2Estimates();
          // Close out + refit k_user against the freshly-synced physiology.
          refreshAdaptiveRecovery();
          scheduleHomeRefresh();
          // If today's sleep score is still missing, re-fetch. Garmin computes
          // scores 1–4h after waking so the webhook may fire before it's ready.
          const todayStr = new Date().toISOString().split('T')[0];
          const todaySleep = getState().physiologyHistory?.find(d => d.date === todayStr);
          if (!todaySleep?.sleepScore) {
            await refreshRecentSleepScores().then(() => syncPhysiologySnapshot(7)).catch(() => {});
            scheduleHomeRefresh();
          }
          // Background poll: keep checking until Garmin pushes today's sleep.
          startSleepPollerIfNeeded();
        }
      }

      // Apple Health gap-fill runs LAST so its merge sits on top of fresh Garmin
      // data. Fills any night Garmin lacks; never overwrites a Garmin sleep score.
      if (appleConnected) {
        const updated = await syncAppleHealthPhysiology(90).catch(() => false);
        if (updated) {
          const ps = getState();
          setAthleteNormalizer(ps.ltHR, ps.restingHR, ps.maxHR);
          scheduleHomeRefresh();
        }
      }

      // Diagnostic: surfaces in the Xcode console on launch so a device build can
      // be told apart from localhost at a glance.
      const hist = getState().physiologyHistory ?? [];
      const todayStr = new Date().toISOString().split('T')[0];
      const todayHasSleep = !!hist.find(d => d.date === todayStr)?.sleepScore;
      console.log(`[Startup] physiology: ${hist.length} days, todaySleep=${todayHasSleep} (activity=${activitySrc}, garminPhysio=${hasGarminPhysio}, appleConnected=${appleConnected})`);
    };
    void syncAllPhysiology();
  }

  // Backfill Strava history: run if never fetched, fewer than 8 weeks cached,
  // or last refresh > 7 days old (so historicWeeklyTSS / signalBBaseline /
  // ctlBaseline track recent training instead of freezing at first-sync values).
  // Extended history (52w) is populated by backfillStravaHistory so the stats
  // "16w" tab works AND so the athlete-archetype classifier can detect
  // "detrained-with-history" (current 18 km/wk but ran 50 km/wk last summer).
  // Repeat-run cost is bounded by the DB cache skip-list. Only NEW activities
  // since last sync get re-processed.
  // Also triggers once post-migration to heal the new ambient_temp_c column on historical rows.
  const thinHistory = (state.historicWeeklyTSS?.length ?? 0) < 8;
  const needsTempHeal = !state.ambientTempHealDone;
  const lastRefreshMs = state.historicLastRefreshedAt
    ? new Date(state.historicLastRefreshedAt).getTime()
    : 0;
  const ageDays = lastRefreshMs > 0 ? (Date.now() - lastRefreshMs) / 86400000 : Infinity;
  const baselineStale = ageDays > 7;
  if (STRAVA_ENABLED && !isSimulatorMode() && state.stravaConnected && (!state.stravaHistoryFetched || thinHistory || needsTempHeal || baselineStale)) {
    console.log(`[Startup] Triggering Strava backfill (historyFetched=${state.stravaHistoryFetched}, weeks=${state.historicWeeklyTSS?.length ?? 0}, needsTempHeal=${needsTempHeal}, baselineAgeDays=${ageDays === Infinity ? 'never' : ageDays.toFixed(1)})`);
    // Tracked so `awaitStartupSyncs()` (e.g. the onboarding review pipeline)
    // can wait for this DB write to land before reading.
    trackStartupTask(backfillStravaHistory(52).then(() => {
      const mut = getMutableState();
      mut.ambientTempHealDone = true;
      saveState();
    }).catch(() => {}));
  } else if (!state.athleteArchetype && (state.historicWeeklyKm?.length ?? 0) > 0) {
    // Backfill was skipped (recent enough), but athleteArchetype was added in
    // a later release and isn't on existing state. Detect it from the cached
    // history so the ramp + plan-view caption show without forcing a full
    // Strava resync. One-shot. Once `athleteArchetype` exists, the regular
    // weekly refresh keeps it updated.
    import('@/calculations/athlete-archetype').then(({ detectArchetype }) => {
      const mut = getMutableState();
      mut.athleteArchetype = detectArchetype(mut);
      saveState();
      console.log(`[Startup] Archetype back-fill: ${mut.athleteArchetype.archetype} (${mut.athleteArchetype.confidence}) — currentWk=${mut.athleteArchetype.evidence.currentWeeklyKm}km peak52=${mut.athleteArchetype.evidence.peakWeeklyKmPast52}km longest=${mut.athleteArchetype.evidence.longestRunPast12moKm}km`);
    });
  }

  // DB duplicate cleanup: scan `garmin_activities` for rows that share the same
  // ±10-min start time + matching type/duration, keep the richest one (Strava >
  // Garmin, then iTRIMP > polyline > duration), delete the rest. Runs on first
  // launch and re-runs every 30 days so duplicates that slipped past the
  // matcher's in-state dedup don't keep poisoning baselines.
  //
  // Not gated on Strava: the dedup logic groups any rows within ±10 min and ranks
  // them. It works equally well for Garmin-only users whose webhook fired twice
  // for the same activity. Strava-vs-Garmin shadowing is just one of the cases
  // it cleans up.
  if (!isSimulatorMode()) {
    const dedupAt = state.dbDedupCompletedAt
      ? new Date(state.dbDedupCompletedAt).getTime()
      : 0;
    const dedupAgeDays = dedupAt > 0 ? (Date.now() - dedupAt) / 86400000 : Infinity;
    if (dedupAgeDays > 30) {
      // Tracked so the review pipeline waits for the dedup to land before
      // reading. Otherwise `loadActivitiesFromDB` could see duplicates
      // mid-deletion.
      trackStartupTask(cleanupDbDuplicates(90).catch(() => {}));
    }
  }

  // Auto-restore the day-level activity archive from `garmin_activities` so
  // long-term users self-heal whenever localStorage is cleared, browsers swap,
  // or state validation wipes the local cache. Strava is the source of truth;
  // `s.previousPlanWks` is a derived hot cache. 24h idempotency guard so this
  // doesn't fire on every tab refocus, only once per day.
  if (STRAVA_ENABLED && !isSimulatorMode() && (state as any).stravaConnected) {
    // Boot-time migration: if any archive has weeks that overlap the live plan
    // window, truncate them. Catches users whose previous-plan continuousMode
    // tail was archived before today's truncate-on-redistribute fix shipped —
    // without this they keep seeing "Past plan · Week N · same dates as the
    // new plan's week 1" with every workout marked Missed.
    if ((state as any).planStartDate && state.wks?.length) {
      const liveStartMs = new Date((state as any).planStartDate + 'T00:00:00').getTime();
      const liveArchives = ((state as any).previousPlanWks ?? []) as any[];
      let truncatedAny = false;
      for (const archive of liveArchives) {
        if (!archive?.weeks?.length || !archive.planStartDate) continue;
        const archStartMs = new Date(archive.planStartDate + 'T00:00:00').getTime();
        let firstOverlapIdx = -1;
        for (let i = 0; i < archive.weeks.length; i++) {
          if (archStartMs + i * 7 * 86400 * 1000 >= liveStartMs) {
            firstOverlapIdx = i;
            break;
          }
        }
        if (firstOverlapIdx >= 0 && firstOverlapIdx < archive.weeks.length) {
          const dropped = archive.weeks.length - firstOverlapIdx;
          archive.weeks.length = firstOverlapIdx;
          console.log(`[Startup] Truncated ${dropped} overlapping week(s) from archive ${archive.planStartDate} to match live plan boundary`);
          truncatedAny = true;
        }
      }
      if (truncatedAny) {
        const { saveState: persist } = await import('@/state');
        persist();
      }
    }

    const lastIso = (state as any).lastHistoryAutoRestoreISO;
    const ageMs = lastIso ? (Date.now() - new Date(lastIso).getTime()) : Infinity;
    const archives = ((state as any).previousPlanWks ?? []) as any[];
    const archiveEmpty = archives.length === 0
      || archives.every(a => !a.weeks || a.weeks.length === 0);
    const stale = ageMs > 24 * 3600 * 1000;
    // Schema sniff: archive entries built before today's fix stripped kmSplits
    // and hrZones to save space. The activity-detail popup needs both, so
    // detecting an archived activity that has iTrimp data but no zone/split
    // info means we're holding a legacy archive. Force a re-fetch.
    const hasLegacyStrippedSchema = archives.some(arc =>
      (arc.weeks ?? []).some((wk: any) =>
        Object.values(wk?.garminActuals ?? {}).some((a: any) =>
          a && a.iTrimp != null && a.iTrimp > 0
          && a.hrZones === undefined
          && a.kmSplits === undefined
        ),
      ),
    );
    if (archiveEmpty || stale || hasLegacyStrippedSchema) {
      console.log(`[Startup] Auto-restoring activity history from server (archives=${archives.length}, stale=${stale}, empty=${archiveEmpty}, legacy=${hasLegacyStrippedSchema})`);
      // 180 days covers ~2 plans of typical history. Bigger windows risk
      // localStorage quota. Quota fail surfaces as a saveState exception.
      // Tracked so `awaitStartupSyncs()` waits for this archive write.
      trackStartupTask(restoreHistoryFromServer(180).catch((err) => {
        console.warn('[Startup] Auto-restore failed:', err);
      }));
    }
  }

  // Strength PRs. All modes. Surface a toast for any lift whose estimated-1RM
  // beat its last-notified best, then snapshot. No-op when no weights logged.
  await maybeShowStrengthPrToast();

  console.log('Mosaic Training Simulator initialized');
  // Signal that launchApp's task-collection phase is complete. Any caller
  // awaiting `awaitStartupSyncs()` was blocked on this. Now they can
  // proceed to wait for the tracked tasks themselves to settle.
  signalLaunchAppComplete();
}

/**
 * Wire up admin panel event handlers
 */
/**
 * Recompute the live triathlon race prediction after activity sync. Runs only
 * when the user is in triathlon mode and has a triConfig. Fetches the earliest
 * Strava activity date once (drives years-of-training → experience-level in
 * the horizon adjuster). Persists the prediction to `triConfig.prediction`.
 *
 * No-op when in running mode or when the prediction returns null.
 */
async function refreshTriPredictionAfterSync(): Promise<void> {
  const { getMutableState, saveState } = await import('@/state');
  const s = getMutableState();
  if (s.eventType !== 'triathlon' || !s.triConfig) return;

  // One-time earliest-activity fetch.
  if (s.firstStravaActivityISO == null) {
    const iso = await fetchEarliestActivityDate();
    s.firstStravaActivityISO = iso;
    saveState();
  }

  // Wire the discipline-aware activity matcher so synced swim/bike/run
  // sessions land against planned `triWorkouts` with `status='completed'`
  // and per-discipline effort scores. The matcher itself is pure; this is
  // the call site that mutates state.
  await runTriActivityMatching();

  const { predictTriathlonRace } = await import('@/calculations/race-prediction.triathlon');
  const prediction = predictTriathlonRace(s);
  if (prediction) {
    s.triConfig.prediction = prediction;
    saveState();
    scheduleHomeRefresh();
  }

  // Race-outcome logging. Runs once per race when the race date passes and
  // race-day activities have synced. Idempotent.
  try {
    const { detectAndLogRaceOutcome } = await import('@/calculations/tri-race-outcome');
    const outcome = detectAndLogRaceOutcome(s);
    if (outcome) {
      // Recompute calibration immediately after a new race is logged.
      const { computeTriCalibration } = await import('@/calculations/tri-calibration');
      const cal = computeTriCalibration(s.triConfig?.raceLog);
      if (s.triConfig) s.triConfig.calibration = cal;
      console.log('[tri:calibration] tier', cal.tier, 'from', cal.basedOnRaceCount, 'races');
      saveState();
      console.log('[tri:race-outcome] logged', {
        date: outcome.dateISO,
        predicted: outcome.predictedTotalSec,
        actual: outcome.actualTotalSec,
        gap: outcome.predictedTotalSec - outcome.actualTotalSec,
      });
    } else if (s.triConfig?.raceLog?.length && !s.triConfig.calibration) {
      // First launch after raceLog has entries but calibration was never computed
      // (e.g. user upgraded from a pre-WS-1 build with existing race history).
      const { computeTriCalibration } = await import('@/calculations/tri-calibration');
      const cal = computeTriCalibration(s.triConfig.raceLog);
      s.triConfig.calibration = cal;
      console.log('[tri:calibration] backfilled tier', cal.tier, 'from', cal.basedOnRaceCount, 'races');
      saveState();
    }
  } catch (e) {
    console.warn('[tri:race-outcome] detection failed', e);
  }

  // Marker bumps. Surface a small toast when CSS / FTP / VDOT crossed the
  // meaningful-improvement threshold since the last notification. CLAUDE.md
  // → Adaptation transparency rule.
  await maybeShowMarkerBumpToast();

  // Surface plan-modification suggestions (volume-ramp, RPE-blown, readiness
  // gate) as a single accept/dismiss modal. Skipped silently if no triggers
  // fired or the user is mid-onboarding.
  await maybeShowTriSuggestionModal();
}

/**
 * Running + HYROX race-outcome detection. Runs after activity sync so any
 * race-day activities that just landed are visible to the detector. Both
 * detectors no-op when the user is in another mode, so the cost is a single
 * dynamic import per launch and a few state reads. Mirrors the tri logger
 * baked into refreshTriPredictionAfterSync above.
 */
async function detectRaceOutcomeAfterSync(): Promise<void> {
  const { getMutableState, saveState } = await import('@/state');
  const s = getMutableState();
  try {
    if (s.eventType === 'hyrox' && s.hyroxConfig) {
      const { detectAndLogHyroxRaceOutcome } = await import('@/calculations/hyrox-race-outcome');
      const outcome = detectAndLogHyroxRaceOutcome(s);
      if (outcome) {
        saveState();
        console.log('[hyrox:race-outcome] logged', {
          date: outcome.dateISO,
          target: outcome.targetTotalSec,
          actual: outcome.actualTotalSec,
        });
      }
    } else if (!s.eventType || s.eventType === 'running') {
      const { detectAndLogRunRaceOutcome } = await import('@/calculations/run-race-outcome');
      const outcome = detectAndLogRunRaceOutcome(s);
      if (outcome) {
        saveState();
        console.log('[run:race-outcome] logged', {
          date: outcome.dateISO,
          predicted: outcome.predictedTotalSec,
          actual: outcome.actualTotalSec,
          gap: outcome.predictedTotalSec - outcome.actualTotalSec,
        });
      }
    }
  } catch (e) {
    console.warn('[race-outcome] detection failed', e);
  }
}

/**
 * Refresh adaptive recovery state: close out any session impact entries whose
 * 96h observation window has elapsed, then refit `k_user` from all closed
 * evidence. Cheap (bounded by the 90-day rolling log) so it can run on every
 * launch after physiology sync. No need to gate on week rollover.
 *
 * Surfaces a one-line console note when confidence first crosses medium/high
 * so we have a paper trail of when the personalisation kicked in.
 */
function refreshAdaptiveRecovery(): void {
  const ms = getMutableState();
  const before = ms.adaptiveRecovery?.confidence ?? 'none';
  const { added, addedHistorical } = ingestNewActualsAsImpacts(ms as any);
  // Retrofit intensity bands onto pre-existing entries (ISSUE-256 redesign) so
  // the new intensity-banded fit applies to the user's existing 90-day log.
  backfillIntensityBands(ms as any);
  const closed = closeOutObservedRecovery(ms);
  const fitted = fitKUser(ms);
  if (fitted.confidence !== before && (fitted.confidence === 'medium' || fitted.confidence === 'high')) {
    console.log(`[AdaptiveRecovery] Confidence → ${fitted.confidence}; k_user=${fitted.kUserHours} (n=${fitted.sessionsObserved}; ingested=${added} live+historical=${addedHistorical}, closed this pass=${closed})`);
  }
  saveState();
}

/**
 * Compare current markers against last-notified snapshot. Surface a small
 * toast for any that crossed the improvement threshold; always update the
 * snapshot so we don't re-pop on every launch.
 */
async function maybeShowMarkerBumpToast(): Promise<void> {
  const { getMutableState, saveState } = await import('@/state');
  const s = getMutableState();
  if (s.eventType !== 'triathlon' || !s.triConfig) return;

  const { detectMarkerBumps, snapshotNotifiedMarkers } = await import('@/calculations/tri-marker-bumps');
  const bumps = detectMarkerBumps(s);

  if (bumps.length > 0) {
    const { showMarkerBumpToast } = await import('@/ui/toast');
    showMarkerBumpToast(bumps.map(b => b.toastText));
  }

  // Always snapshot. Even when no bumps fired. So first-launch baseline
  // gets seeded silently and subsequent comparisons are against fresh values.
  snapshotNotifiedMarkers(s);
  saveState();
}

/**
 * Strength PR toast (all modes). Mirrors maybeShowMarkerBumpToast: compares each
 * lift's estimated-1RM against the last-notified snapshot, toasts improvements,
 * then snapshots so the same PR doesn't re-pop. No-op when no weights logged.
 */
async function maybeShowStrengthPrToast(): Promise<void> {
  const { getMutableState, saveState } = await import('@/state');
  const s = getMutableState();
  if (!s.strengthLog?.lifts) return;

  const { detectStrengthPrs, snapshotNotifiedStrengthPrs } = await import('@/calculations/strength-marker-bumps');
  const prs = detectStrengthPrs(s);

  if (prs.length > 0) {
    const { showMarkerBumpToast } = await import('@/ui/toast');
    showMarkerBumpToast(prs.map(p => p.toastText));
  }

  snapshotNotifiedStrengthPrs(s);
  saveState();
}

/**
 * For each completed activity in this week's `garminActuals`, find a
 * matching planned `triWorkout` and mark it as completed. Pure side-effect
 * mutation: sets `Workout.status='completed'` and stores per-discipline
 * effort scores on the actual.
 */
async function runTriActivityMatching(): Promise<void> {
  const { getMutableState, saveState } = await import('@/state');
  const s = getMutableState();
  const wk = s.wks?.[(s.w ?? 1) - 1];
  if (!wk?.triWorkouts || !wk.garminActuals) return;

  const { matchTriathlonWeek, reconcileTriCompletions } = await import('@/calculations/activity-matcher.triathlon');
  const { detectBricks } = await import('@/calculations/brick-detector');
  const { scoreTriEffort, hrProfileFromState } = await import('@/calculations/tri-effort-scoring');
  const { classifyActivity } = await import('@/calculations/tri-benchmarks-from-history');
  const hrProfile = hrProfileFromState(s);

  // Split actuals into three groups. The previous version fed EVERY actual —
  // including recordings the user explicitly placed as extra/excess sessions on
  // the matching screen — through the fuzzy matcher, whose any-day fallback then
  // claimed plan slots on the wrong weekday and overrode user decisions
  // ("Excess Load" ride re-appearing as a Logged Tuesday ride).
  const slotKeys = new Set(wk.triWorkouts.map(w => w.id ?? w.n));
  const ratedMap = wk.rated ?? {};
  const matchedMap = wk.garminMatched ?? {};

  type TriMatchLite = { activityId: string; workoutId?: string; matched: boolean };
  const directMatches: TriMatchLite[] = [];
  const fuzzyActivities: { id: string; sport: string; startTs: number; durationSec: number; distanceM: number }[] = [];
  for (const [id, a] of Object.entries(wk.garminActuals)) {
    // Direct-bound: stored under a slot's own key — the matching screen put it
    // there. Bind 1:1; never re-match.
    if (slotKeys.has(id)) {
      directMatches.push({ activityId: id, workoutId: id, matched: true });
      continue;
    }
    // User-decided placement (extra / excess / log-only, or moved onto a slot
    // whose copy direct-binds above): respect the decision. Only recordings with
    // no decided placement at all remain fuzzy-matchable.
    const decided = a.garminId ? matchedMap[a.garminId] : undefined;
    if (id.startsWith('garmin-') && decided && decided !== '__pending__') continue;
    fuzzyActivities.push({
      id,
      sport: a.activityType ?? '',
      startTs: a.startTime ? Math.floor(Date.parse(a.startTime) / 1000) : Math.floor(Date.now() / 1000),
      durationSec: a.durationSec,
      distanceM: a.distanceKm * 1000,
    });
  }

  // Fuzzy pool: only slots that aren't already spoken for.
  const fuzzyPool = wk.triWorkouts.filter(w => {
    const wid = w.id ?? w.n;
    if (wk.garminActuals?.[wid]?.garminId) return false;                               // direct-bound
    if (w.matchedActivityId && wk.garminActuals?.[w.matchedActivityId]) return false;  // live link
    if (typeof ratedMap[wid] === 'number') return false;                               // user marked done
    return true;
  });

  const matches: TriMatchLite[] = [...directMatches, ...matchTriathlonWeek(fuzzyActivities, fuzzyPool)];
  let changed = false;
  for (const m of matches) {
    if (!m.matched || !m.workoutId) continue;
    const workout = wk.triWorkouts.find(x => (x.id ?? x.n) === m.workoutId);
    const actual = wk.garminActuals[m.activityId];
    if (!workout || !actual) continue;
    if (workout.status !== 'completed') {
      workout.status = 'completed';
      changed = true;
    }
    // Store the match link so the effort multiplier can read per-actual signals.
    workout.matchedActivityId = m.activityId;
    const discipline = classifyActivity(actual.activityType);
    if (discipline === 'swim' || discipline === 'bike' || discipline === 'run') {
      const scores = scoreTriEffort(
        discipline,
        actual,
        workout,
        {
          ftp: s.triConfig?.bike?.ftp,
          cssSecPer100m: s.triConfig?.swim?.cssSecPer100m,
        },
        hrProfile,
      );
      if (scores.paceAdherence != null) actual.paceAdherence = scores.paceAdherence;
      if (discipline === 'bike') {
        // Power adherence feeds the effort multiplier blend (60% power / 40% RPE).
        if (scores.powerAdherence != null) actual.powerAdherence = scores.powerAdherence;
        // HR is the objective fallback when no power meter is present.
        if (scores.hrEffortScore != null && actual.hrEffortScore == null) {
          actual.hrEffortScore = scores.hrEffortScore;
        }
      }
    }
  }

  // Brick detection. Pair bike→run within 30 min so the run leg of a brick
  // workout gets `status='completed'` even when matched alone. Activity-side.
  const actualsForBrick = Object.values(wk.garminActuals)
    .filter(a => a.startTime)
    .map(a => ({
      id: a.garminId,
      sport: a.activityType ?? '',
      startTs: Math.floor(Date.parse(a.startTime!) / 1000),
      durationSec: a.durationSec,
    }));
  const bricks = detectBricks(actualsForBrick);
  if (bricks.length > 0) {
    // Mark the brick-workout as completed if BOTH segments matched.
    for (const brick of bricks) {
      const bikeMatch = matches.find(m => m.activityId === brick.bikeId && m.matched);
      const runMatch  = matches.find(m => m.activityId === brick.runId  && m.matched);
      if (!bikeMatch || !runMatch) continue;
      // Find any brick triWorkout this week and mark it completed.
      const brickWorkout = wk.triWorkouts.find(w => w.t === 'brick');
      if (brickWorkout && brickWorkout.status !== 'completed') {
        brickWorkout.status = 'completed';
        changed = true;
      }
    }
  }

  // Stale-link cleanup + day shift: completed slots move to the weekday the
  // session actually happened; links the re-review undid are cleared.
  const reconciled = reconcileTriCompletions(wk);

  if (changed || reconciled) saveState();
}

async function maybeShowTriSuggestionModal(): Promise<void> {
  const { getState } = await import('@/state');
  const s = getState();
  if (s.eventType !== 'triathlon' || !s.triConfig) return;
  // Don't show if anything else is open (activity review, etc.).
  if (document.getElementById('activity-review-overlay')) return;
  if (document.getElementById('tri-suggestion-overlay')) return;

  const { collectTriSuggestions } = await import('@/calculations/tri-suggestion-aggregator');
  const bundle = collectTriSuggestions(s);
  if (bundle.mods.length === 0) return;

  const { showTriSuggestionModal } = await import('@/ui/triathlon/tri-suggestion-modal');
  const applied = await showTriSuggestionModal(bundle);
  if (applied > 0) {
    // Re-render the current view so accepted mods reflect immediately.
    if (document.getElementById('tri-bike-setup-btn')) {
      const { renderTriathlonStatsView } = await import('@/ui/triathlon/stats-view');
      renderTriathlonStatsView();
    } else {
      scheduleHomeRefresh();
    }
  }
}

function wireAdminHandlers(): void {
  document.getElementById('admin-simulate-week')?.addEventListener('click', () => {
    import('@/ui/events').then(({ next }) => {
      next();
    });
  });

  document.getElementById('admin-reset-onboarding')?.addEventListener('click', () => {
    import('@/ui/wizard/controller').then(({ resetOnboarding }) => {
      resetOnboarding();
      window.location.reload();
    });
  });

  document.getElementById('admin-view-all-weeks')?.addEventListener('click', () => {
    import('@/state').then(({ updateState, saveState }) => {
      updateState({ isAdmin: true });
      saveState();
      window.location.reload();
    });
  });
}

/**
 * After physiology sync, check today's recovery data and prompt if needed.
 * One prompt per day (guarded by s.lastRecoveryPromptDate).
 */
async function checkRecoveryAndPrompt(s: ReturnType<typeof import('@/state').getState>): Promise<void> {
  const today = new Date().toISOString().split('T')[0];

  // One prompt per day guard
  if ((s as any).lastRecoveryPromptDate === today) return;

  const physioHistory: Array<{ date: string; sleepScore?: number; hrvRmssd?: number; stressAvg?: number; restingHR?: number; vo2max?: number }> =
    (s as any).physiologyHistory ?? [];

  const todayPhysio = physioHistory.find(p => p.date === today);

  if (!todayPhysio) {
    // No Garmin data for today. Silently skip (ISSUE-82: don't auto-prompt)
    return;
  }

  const { buildRecoveryEntryFromPhysio: build } = await import('@/data/physiologySync');
  const { computeRecoveryStatus } = await import('@/recovery/engine');

  const entry = build(todayPhysio as any);
  const history: typeof entry[] = ((s as any).recoveryHistory ?? []);
  const status = computeRecoveryStatus(entry, history);

  if (!status.shouldPrompt) return;

  // Set recoveryDebt on current week for ATL inflation
  const wks: any[] = (s as any).wks ?? [];
  const currentWeek: number = (s as any).w ?? 1;
  const wk = wks[currentWeek - 1];
  if (wk) {
    wk.recoveryDebt = status.level as 'orange' | 'red';
  }

  // Persist entry to recoveryHistory (cap at 30)
  const mutable = (await import('@/state')).getMutableState() as any;
  if (!mutable.recoveryHistory) mutable.recoveryHistory = [];
  const idx = mutable.recoveryHistory.findIndex((e: any) => e.date === today);
  if (idx >= 0) mutable.recoveryHistory[idx] = entry;
  else mutable.recoveryHistory.push(entry);
  if (mutable.recoveryHistory.length > 30) mutable.recoveryHistory = mutable.recoveryHistory.slice(-30);
  mutable.lastRecoveryPromptDate = today;
  (await import('@/state')).saveState();

  const { showRecoveryAdjustModal } = await import('@/ui/plan-view');
  showRecoveryAdjustModal(entry);
}

function showGarminConnectedToast(): void {
  const toast = document.createElement('div');
  toast.className = 'fixed top-4 right-4 z-50 bg-emerald-600 text-white px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-opacity duration-500';
  toast.textContent = 'Garmin connected successfully!';
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 500);
  }, 3000);
}

function showStravaConnectedToast(): void {
  const toast = document.createElement('div');
  toast.className = 'fixed top-4 right-4 z-50 bg-orange-600 text-white px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-opacity duration-500';
  toast.textContent = 'Strava connected — syncing activities…';
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 500);
  }, 3500);
}

/**
 * Visibility for the silent onboarding history claim (ISSUE-270): a returning
 * athlete whose prior-session activities were just reunited should see it
 * happen, not discover old sessions in their log. Neutral styling — this is
 * information, not a Strava-branded event.
 */
function showHistoryImportedToast(count: number): void {
  const toast = document.createElement('div');
  toast.className = 'fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-opacity duration-500';
  toast.style.background = 'var(--c-black)';
  toast.style.color = '#FFFFFF';
  toast.textContent = `Imported ${count} activities from your training history.`;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 500);
  }, 4000);
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

// Re-sync physiology whenever the app comes back to the foreground.
// This keeps sleep/HRV/steps current without requiring a manual pull-to-refresh.
// Throttled to at most once every 5 minutes.
let _lastForegroundSync = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (now - _lastForegroundSync < 5 * 60 * 1000) return;
  _lastForegroundSync = now;
  const s = getState();

  if (hasPhysiologySource(s, 'garmin')) {
    syncTodaySteps().then(() => {
      scheduleHomeRefresh();
    }).catch(() => {});
    // Full physiology refresh, not just steps. On iOS the WKWebView stays
    // alive for days, so the launch-time syncPhysiologySnapshot(90) never
    // re-runs and sleep/HRV/RHR that Garmin delivered while the app was
    // backgrounded stay invisible until a cold launch. (On web every page
    // load IS a cold launch, which is why this gap only shows on device.)
    // syncPhysiologySnapshot merges by date, so the 7-day window cannot
    // truncate the 28-day baseline.
    syncPhysiologySnapshot(7).then(() => {
      const ps = getState();
      setAthleteNormalizer(ps.ltHR, ps.restingHR, ps.maxHR);
      scheduleHomeRefresh();
      // If today's sleep is still missing from the DB, ask Garmin directly
      // (cooldown-guarded) and restart the poller — its setInterval was
      // suspended while the app was backgrounded.
      const todayISO = new Date().toISOString().split('T')[0];
      const todaySleep = getState().physiologyHistory?.find(d => d.date === todayISO);
      if (!todaySleep?.sleepScore) {
        refreshRecentSleepScores()
          .then(() => syncPhysiologySnapshot(7))
          .then(() => scheduleHomeRefresh())
          .catch(() => {});
      }
      startSleepPollerIfNeeded();
    }).catch(() => {});
  } else if (hasPhysiologySource(s, 'apple')) {
    // HealthKit is local. Re-read on every foreground resume so new sleep/HRV
    // data that arrived while the app was backgrounded gets picked up immediately.
    syncAppleHealthPhysiology(7).then((updated) => {
      if (updated) scheduleHomeRefresh();
    }).catch(() => {});
  }
});
