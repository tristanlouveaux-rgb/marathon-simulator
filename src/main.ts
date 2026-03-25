/**
 * Mosaic Training Simulator
 * Entry point - initializes the application
 */

import './styles.css';
import { loadState, getState } from '@/state';
import { restorePlanFromSupabase } from '@/data/planSettingsSync';
import { initWizard } from '@/ui/wizard/controller';
import { renderMainView } from '@/ui/main-view';
import { renderHomeView } from '@/ui/home-view';
import { advanceWeekToToday, recordAppOpen } from '@/ui/welcome-back';
import { renderAdminPanel, toggleAdminMode } from '@/ui/admin/master-overview';
import { syncPhysiologySnapshot, buildRecoveryEntryFromPhysio } from '@/data/physiologySync';
import { syncActivities, processPendingCrossTraining } from '@/data/activitySync';
import { syncStravaActivities, fetchStravaHistory, backfillStravaHistory } from '@/data/stravaSync';
import { supabase, isGarminConnected, isStravaConnected, resetStravaCache, triggerGarminBackfill, refreshRecentSleepScores } from '@/data/supabaseClient';
import { renderAuthView } from '@/ui/auth-view';
import { syncAppleHealth } from '@/data/appleHealthSync';
import { startSleepPollerIfNeeded } from '@/data/sleepPoller';
import '@/ui/strava-detail';

/** True when running in local simulator mode (no auth required) */
export function isSimulatorMode(): boolean {
  return localStorage.getItem('mosaic_simulator_mode') === '1';
}

/**
 * Initialize application on DOM ready
 */
async function bootstrap(): Promise<void> {
  // Simulator mode: skip auth entirely for local dev/testing
  if (isSimulatorMode()) {
    await launchApp();
    return;
  }

  // Check for existing Supabase session
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    // No authenticated user — show login page
    renderAuthView();
    setupAuthListener();
    return;
  }

  // Authenticated — proceed with app
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

  // Check if onboarding is complete
  if (hasState && state.hasCompletedOnboarding) {
    // Record app open (used for debrief timing), then go straight to home
    advanceWeekToToday(); // silently advances week + applies detraining if behind calendar
    recordAppOpen();
    renderHomeView();
    // Auto-fire week-end debrief if a week just completed (once per week, after home renders)
    import('@/ui/week-debrief').then(({ shouldAutoDebrief, showWeekDebrief }) => {
      if (shouldAutoDebrief()) showWeekDebrief();
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

  // Handle OAuth redirects
  const params = new URLSearchParams(window.location.search);
  if (params.get('garmin') === 'connected') {
    // Clean up URL
    window.history.replaceState({}, '', window.location.pathname);
    showGarminConnectedToast();
    // Only navigate to account if onboarding is complete — otherwise stay in wizard
    if (hasState && state.hasCompletedOnboarding) {
      import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
    }
    // If still in wizard, toast shows and wizard continues — user can connect Garmin then finish setup
  }

  if (params.get('strava') === 'connected') {
    window.history.replaceState({}, '', window.location.pathname);
    // Persist stravaConnected flag
    import('@/state').then(({ updateState, saveState }) => {
      updateState({ stravaConnected: true });
      saveState();
    });
    resetStravaCache();
    showStravaConnectedToast();
    if (hasState && state.hasCompletedOnboarding) {
      import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
      // Kick off Strava activity sync after short delay (let account view mount first)
      setTimeout(() => syncStravaActivities().catch(() => {}), 500);
    }
  }

  // Sync wearable data on launch (skip in simulator mode — no auth)
  if (!isSimulatorMode()) {
    const wearable = state.wearable;

    if (wearable === 'apple') {
      // Apple Watch: activities + biometrics via HealthKit (iOS only — no-op on web)
      syncAppleHealth().catch(() => {});
    } else if (state.stravaConnected) {
      // Strava is the activity source for any user who has it connected.
      // Garmin wearable users also get a biometric sync (VO2max, LT, HRV, sleep).
      isStravaConnected().then((stravaOk) => {
        if (!stravaOk) return;
        syncStravaActivities().then(() => {
          // Re-render home view if it's still active so TSS reflects post-sync state
          if (document.getElementById('home-tss-row')) renderHomeView();
        }).catch(() => {});
        if (wearable === 'garmin') {
          isGarminConnected().then((garminOk) => {
            if (garminOk) {
              // Backfill first (idempotent), then sync physiology so state reflects fresh DB data
              triggerGarminBackfill(4).catch(() => {}).finally(() => {
                syncPhysiologySnapshot(28).then(() => {
                  // Re-render home view so sleep/HRV cards update without requiring
                  // manual navigation — physiology data lands in state after the view
                  // was first rendered, so we need an explicit refresh.
                  if (document.getElementById('home-tss-row')) renderHomeView();
                  // If today's sleep score is still missing, re-fetch — Garmin computes
                  // scores 1–4h after waking so the webhook may fire before it's ready.
                  const todayStr = new Date().toISOString().split('T')[0];
                  const todaySleep = getState().physiologyHistory?.find(d => d.date === todayStr);
                  if (!todaySleep?.sleepScore) {
                    refreshRecentSleepScores().then(() => syncPhysiologySnapshot(7)).then(() => {
                      if (document.getElementById('home-tss-row')) renderHomeView();
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
          if (document.getElementById('home-tss-row')) renderHomeView();
        }).catch(() => {});
        processPendingCrossTraining();
        // Backfill first (idempotent), then sync physiology so state reflects fresh DB data
        triggerGarminBackfill(4).catch(() => {}).finally(() => {
          syncPhysiologySnapshot(28).then(() => {
            if (document.getElementById('home-tss-row')) renderHomeView();
            const todayStr = new Date().toISOString().split('T')[0];
            const todaySleep = getState().physiologyHistory?.find(d => d.date === todayStr);
            if (!todaySleep?.sleepScore) {
              refreshRecentSleepScores().then(() => syncPhysiologySnapshot(7)).then(() => {
                if (document.getElementById('home-tss-row')) renderHomeView();
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
  const thinHistory = (state.historicWeeklyTSS?.length ?? 0) < 8;
  if (!isSimulatorMode() && state.stravaConnected && (!state.stravaHistoryFetched || thinHistory)) {
    console.log(`[Startup] Triggering Strava backfill (historyFetched=${state.stravaHistoryFetched}, weeks=${state.historicWeeklyTSS?.length ?? 0})`);
    backfillStravaHistory(16).catch(() => {});
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
