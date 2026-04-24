/**
 * Mosaic Training Simulator
 * Entry point - initializes the application
 */

import './styles.css';
import { loadState, getState, getMutableState, saveState } from '@/state';
import { restorePlanFromSupabase } from '@/data/planSettingsSync';
import { initWizard } from '@/ui/wizard/controller';
import { renderMainView } from '@/ui/main-view';
import { renderHomeView } from '@/ui/home-view';
import { advanceWeekToToday, recordAppOpen, isWeekPendingDebrief } from '@/ui/welcome-back';
import { checkHolidayEnd, showHolidayWelcomeBack } from '@/ui/holiday-modal';
import { renderAdminPanel, toggleAdminMode } from '@/ui/admin/master-overview';
import { syncPhysiologySnapshot, buildRecoveryEntryFromPhysio, syncTodaySteps } from '@/data/physiologySync';
import { syncActivities, processPendingCrossTraining } from '@/data/activitySync';
import { healMissingITrimp } from '@/calculations/activity-matcher';
import { setAthleteNormalizer, calibrateTssPerActiveMinute } from '@/calculations/fitness-model';
import { syncStravaActivities, fetchStravaHistory, backfillStravaHistory, deriveAthleteTier } from '@/data/stravaSync';
import { supabase, isGarminConnected, isStravaConnected, resetStravaCache, triggerGarminBackfill, refreshRecentSleepScores, resetGarminBackfillGuard, resetGarminCache } from '@/data/supabaseClient';
import { renderAuthView } from '@/ui/auth-view';
import { syncAppleHealth, syncAppleHealthPhysiology } from '@/data/appleHealthSync';
import { startSleepPollerIfNeeded } from '@/data/sleepPoller';
import { getActivitySource, hasPhysiologySource } from '@/data/sources';
import '@/ui/strava-detail';

/** True when running in local simulator mode (no auth required) */
export function isSimulatorMode(): boolean {
  return localStorage.getItem('mosaic_simulator_mode') === '1';
}

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
 * mid-render — the silent .catch() handlers in fire-and-forget syncs would
 * otherwise hide the failure entirely.
 *
 * IDs listed here are full-viewport overlays that, if orphaned, would obscure
 * the home view. The list is intentionally narrow — modals like check-in or
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
async function bootstrap(): Promise<void> {
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

  // If session exists but is expired, try refresh; if that fails, treat as no session.
  if (session) {
    const expiresAt = session.expires_at ?? 0;
    if (expiresAt <= Math.floor(Date.now() / 1000) + 60) {
      const { data: refreshed, error } = await supabase.auth.refreshSession();
      if (error || !refreshed.session) {
        console.warn('[auth] Stale session could not refresh, clearing and signing in anonymously');
        await supabase.auth.signOut().catch(() => {});
        session = null;
      } else {
        session = refreshed.session;
      }
    }
  }

  if (!session) {
    // No session — silently create an anonymous user. No auth UI during onboarding.
    // Users can upgrade to a real account later from Account settings.
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.session) {
      console.error('[auth] Anonymous sign-in failed, falling back to auth view', error);
      renderAuthView();
      setupAuthListener();
      return;
    }
    session = data.session;
  }

  // Authenticated (anon or real) — proceed with app
  await launchApp();
  setupAuthListener();
}

/**
 * Listen for auth state changes (login/logout)
 */
function setupAuthListener(): void {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') {
      void launchApp();
    } else if (event === 'SIGNED_OUT') {
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

  // Set per-athlete iTRIMP normalizer (LTHR-based, Coggan hrTSS standard)
  setAthleteNormalizer(state.ltHR, state.restingHR, state.maxHR);

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
  // fitness as it evolves. Never overwrites user-entered CSS/FTP — only
  // fills blanks.
  if (hasState && state.eventType === 'triathlon' && state.triConfig) {
    try {
      const { TRI_GENERATOR_VERSION, generateTriathlonPlan } = await import('@/workouts/plan_engine.triathlon');
      const { deriveTriBenchmarksFromHistory } = await import('@/calculations/tri-benchmarks-from-history');
      const mutable = getMutableState();

      // Flatten matched (garminActuals) + unmatched (garminPending) activities
      // so we see the full picture. Pending items are normalised to the
      // GarminActual shape for just the fields derivation reads.
      const activityLog = Object.values(mutable.wks ?? []).flatMap((wk: any) => {
        const actuals = Object.values((wk?.garminActuals ?? {}) as Record<string, any>);
        const pending = (wk?.garminPending ?? []).map((p: any) => ({
          garminId: p.garminId,
          activityType: p.activityType,
          startTime: p.startTime,
          durationSec: p.durationSec,
          distanceKm: (p.distanceM ?? 0) / 1000,
          iTrimp: p.iTrimp ?? null,
        }));
        return [...actuals, ...pending];
      });
      const derived = deriveTriBenchmarksFromHistory(activityLog as any);

      // Update per-discipline fitness every boot so CTL reflects what's
      // actually been trained since last load.
      if (mutable.triConfig) {
        mutable.triConfig.fitness = {
          swim: derived.fitness.swim,
          bike: derived.fitness.bike,
          run:  derived.fitness.run,
          combinedCtl: derived.fitness.combinedCtl,
        };
        // Fill CSS / FTP only if the user never set them.
        if (!mutable.triConfig.swim?.cssSecPer100m && derived.css.cssSecPer100m) {
          mutable.triConfig.swim = { ...(mutable.triConfig.swim ?? {}), cssSecPer100m: derived.css.cssSecPer100m };
        }
        if (!mutable.triConfig.bike?.ftp && derived.ftp.ftpWatts) {
          mutable.triConfig.bike = { ...(mutable.triConfig.bike ?? {}), ftp: derived.ftp.ftpWatts, hasPowerMeter: true };
        }
      }

      // Plan regeneration when the generator version bumps.
      const savedVersion = state.triConfig.generatorVersion ?? 0;
      if (savedVersion < TRI_GENERATOR_VERSION) {
        const freshWeeks = generateTriathlonPlan(mutable);
        if (freshWeeks.length > 0) {
          for (let i = 0; i < Math.min(mutable.wks.length, freshWeeks.length); i++) {
            mutable.wks[i].triWorkouts = freshWeeks[i].triWorkouts;
            mutable.wks[i].ph = freshWeeks[i].ph;
          }
          if (mutable.triConfig) mutable.triConfig.generatorVersion = TRI_GENERATOR_VERSION;
          console.log(`[tri] plan regenerated (generator v${savedVersion} → v${TRI_GENERATOR_VERSION})`);
        }
      }

      saveState();
      console.log('[tri] benchmarks refreshed from history:',
        `CSS ${derived.css.cssSecPer100m ? `${derived.css.cssSecPer100m}s/100m` : '—'}`,
        `FTP ${derived.ftp.ftpWatts ? `${derived.ftp.ftpWatts}W` : '— (no power data)'}`,
        `CTL swim/bike/run ${derived.fitness.swim.ctl}/${derived.fitness.bike.ctl}/${derived.fitness.run.ctl} (${derived.fitness.activityCount} activities)`,
      );
    } catch (err) {
      console.warn('[tri] benchmark/plan refresh failed', err);
    }
  }

  // Check if onboarding is complete
  if (hasState && state.hasCompletedOnboarding) {
    // Record app open (used for debrief timing), then go straight to home
    advanceWeekToToday(); // silently advances week + applies detraining if behind calendar

    // Boot-time migration: refresh blended VDOT so existing users (who have
    // wkGain deprecated) see current fitness, not Week-1 baseline.
    try {
      const { refreshBlendedFitness } = await import('@/calculations/blended-fitness');
      refreshBlendedFitness(getMutableState());
    } catch {}

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
      const lastComplete = _ms.lastCompleteDebriefWeek ?? 0;
      if (_ms.w > lastComplete + 1) {
        _ms.w = lastComplete + 1;
        saveState();
      }
    }

    if (healMissingITrimp()) saveState(); // back-fill iTrimp for actuals synced before profile HR was set

    // Recompute athleteTier from current ctlBaseline — state may be stale from
    // an earlier CTL value (e.g. pre-fix readings) and the tier only updates
    // when fetchStravaHistory runs, which is cache-skipped on most launches.
    {
      const _ms = getMutableState();
      const expected = deriveAthleteTier(_ms.ctlBaseline ?? 0);
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
          // This was a trivially short holiday — undo VDOT loss (add back ~0.6)
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

    // Check if holiday ended while the app was closed — show welcome-back before home
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
      // unassigned — the retry fires from activitySync.ts after the user saves matching.
      const pendingDebrief = isWeekPendingDebrief();
      import('@/ui/week-debrief').then(({ fireDebriefIfReady }) => {
        fireDebriefIfReady(pendingDebrief);
      });
    }
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

  // Handle OAuth redirects.
  // Only route to account-view when the user is actually on main-view. A user
  // mid-wizard (e.g. editing goals after having completed onboarding once) has
  // hasCompletedOnboarding=true but a non-main-view currentStep — routing them
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

  if (params.get('strava') === 'connected') {
    window.history.replaceState({}, '', window.location.pathname);
    import('@/state').then(({ updateState, saveState }) => {
      updateState({ stravaConnected: true });
      saveState();
    });
    resetStravaCache();
    showStravaConnectedToast();
    // Always kick off the sync after OAuth — the wizard's review step reads from
    // the DB and needs activities there before it can decide to show vs divert.
    setTimeout(() => syncStravaActivities().catch(() => {}), 500);
    if (onMainView) {
      import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
    }
    // Mid-wizard: sync fires in the background; connect-strava auto-advances;
    // review page waits on the DB fetch and then decides.
  }

  // Sync wearable data on launch (skip in simulator mode — no auth)
  if (!isSimulatorMode()) {
    const activitySrc = getActivitySource(state);

    if (activitySrc === 'apple') {
      // Apple Watch: activities via HealthKit (iOS only — no-op on web)
      syncAppleHealth().catch(() => {});
      // Physiology: sleep, HRV, resting HR, steps from HealthKit
      syncAppleHealthPhysiology(28).then((updated) => {
        if (updated) {
          const ps = getState();
          setAthleteNormalizer(ps.ltHR, ps.restingHR, ps.maxHR);
          scheduleHomeRefresh();
        }
      }).catch(() => {});
    } else if (state.stravaConnected) {
      // Strava is the activity source for any user who has it connected.
      // Garmin wearable users also get a biometric sync (VO2max, LT, HRV, sleep).
      isStravaConnected().then((stravaOk) => {
        if (!stravaOk) return;
        syncStravaActivities().then(() => {
          // Re-render home view if it's still active so TSS reflects post-sync state
          scheduleHomeRefresh();
        }).catch(() => {});
        if (hasPhysiologySource(state, 'apple')) {
          // Apple Watch physiology: sleep, HRV, resting HR, steps from HealthKit
          syncAppleHealthPhysiology(28).then((updated) => {
            if (updated) {
              const ps = getState();
              setAthleteNormalizer(ps.ltHR, ps.restingHR, ps.maxHR);
              scheduleHomeRefresh();
            }
          }).catch(() => {});
        } else if (hasPhysiologySource(state, 'garmin')) {
          isGarminConnected().then((garminOk) => {
            if (garminOk) {
              // Backfill first (idempotent), then sync physiology so state reflects fresh DB data
              triggerGarminBackfill(8).catch(() => {}).finally(() => {
                // Fetch today's steps immediately (fast — single epoch window)
                syncTodaySteps().then(() => {
                  scheduleHomeRefresh();
                }).catch(() => {});

                syncPhysiologySnapshot(28).then(() => {
                  // Re-set normalizer in case physiology sync updated HR profile
                  const ps = getState();
                  setAthleteNormalizer(ps.ltHR, ps.restingHR, ps.maxHR);
                  // Re-render home view so sleep/HRV cards update without requiring
                  // manual navigation — physiology data lands in state after the view
                  // was first rendered, so we need an explicit refresh.
                  scheduleHomeRefresh();
                  // If today's sleep score is still missing, re-fetch — Garmin computes
                  // scores 1–4h after waking so the webhook may fire before it's ready.
                  const todayStr = new Date().toISOString().split('T')[0];
                  const todaySleep = getState().physiologyHistory?.find(d => d.date === todayStr);
                  if (!todaySleep?.sleepScore) {
                    refreshRecentSleepScores().then(() => syncPhysiologySnapshot(7)).then(() => {
                      scheduleHomeRefresh();
                    }).catch(() => {});
                  }
                  // Background poll: keep checking until Garmin pushes today's sleep
                  startSleepPollerIfNeeded();
                }).catch(() => {});
              });
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    } else {
      // Garmin-only: activities + biometrics from Garmin webhook
      isGarminConnected().then((connected) => {
        if (!connected) return;
        syncActivities().then(() => {
          scheduleHomeRefresh();
        }).catch(() => {});
        processPendingCrossTraining();
        // Backfill first (idempotent), then sync physiology so state reflects fresh DB data
        triggerGarminBackfill(8).catch(() => {}).finally(() => {
          // Fetch today's steps immediately (fast — single epoch window)
          syncTodaySteps().then(() => {
            scheduleHomeRefresh();
          }).catch(() => {});

          syncPhysiologySnapshot(28).then(() => {
            const ps2 = getState();
            setAthleteNormalizer(ps2.ltHR, ps2.restingHR, ps2.maxHR);
            scheduleHomeRefresh();
            const todayStr = new Date().toISOString().split('T')[0];
            const todaySleep = getState().physiologyHistory?.find(d => d.date === todayStr);
            if (!todaySleep?.sleepScore) {
              refreshRecentSleepScores().then(() => syncPhysiologySnapshot(7)).then(() => {
                scheduleHomeRefresh();
              }).catch(() => {});
            }
            // Background poll: keep checking until Garmin pushes today's sleep
            startSleepPollerIfNeeded();
          }).catch(() => {});
        });
      }).catch(() => {});
    }
  }

  // Backfill Strava history: run if never fetched OR if we have fewer than 8 weeks cached.
  // Extended history (16w) is populated by backfillStravaHistory so the stats "16w" tab works.
  // Also triggers once post-migration to heal the new ambient_temp_c column on historical rows.
  const thinHistory = (state.historicWeeklyTSS?.length ?? 0) < 8;
  const needsTempHeal = !state.ambientTempHealDone;
  if (!isSimulatorMode() && state.stravaConnected && (!state.stravaHistoryFetched || thinHistory || needsTempHeal)) {
    console.log(`[Startup] Triggering Strava backfill (historyFetched=${state.stravaHistoryFetched}, weeks=${state.historicWeeklyTSS?.length ?? 0}, needsTempHeal=${needsTempHeal})`);
    backfillStravaHistory(16).then(() => {
      const mut = getMutableState();
      mut.ambientTempHealDone = true;
      saveState();
    }).catch(() => {});
  }

  console.log('Mosaic Training Simulator initialized');
}

/**
 * Wire up admin panel event handlers
 */
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
    // No Garmin data for today — silently skip (ISSUE-82: don't auto-prompt)
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
  } else if (hasPhysiologySource(s, 'apple')) {
    // HealthKit is local — re-read on every foreground resume so new sleep/HRV
    // data that arrived while the app was backgrounded gets picked up immediately.
    syncAppleHealthPhysiology(7).then((updated) => {
      if (updated) scheduleHomeRefresh();
    }).catch(() => {});
  }
});
