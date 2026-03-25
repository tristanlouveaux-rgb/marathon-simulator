/**
 * Sleep data poller.
 *
 * Garmin pushes sleep data to our webhook on their own schedule — typically
 * 1–3 hours after the watch syncs in the morning. This poller re-checks the
 * DB every 3 minutes so the app picks up the data as soon as it arrives,
 * without requiring the user to relaunch.
 *
 * Usage: call startSleepPollerIfNeeded() once after the initial physiology
 * sync on launch. The poller is a no-op if today's sleep score is already
 * in state, and self-terminates after 6 hours or when data arrives.
 */

import { getState } from '@/state';
import { syncPhysiologySnapshot } from '@/data/physiologySync';

const POLL_INTERVAL_MS = 3 * 60 * 1000;       // 3 minutes
const MAX_POLL_DURATION_MS = 6 * 60 * 60 * 1000; // stop after 6 h

let pollTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

function hasTodaySleep(): boolean {
  return !!(getState().physiologyHistory?.find(d => d.date === todayStr())?.sleepScore);
}

/** True while we are actively polling for today's sleep data. */
export function isSleepDataPending(): boolean {
  return pollTimer !== null;
}

/** Start polling if today's sleep score is not yet in state. Safe to call multiple times. */
export function startSleepPollerIfNeeded(): void {
  if (started) return;
  if (hasTodaySleep()) {
    console.log('[sleepPoller] Today\'s sleep already in state — not polling');
    return;
  }

  console.log('[sleepPoller] Today\'s sleep missing — starting background poll every 3 min');
  started = true;
  const deadline = Date.now() + MAX_POLL_DURATION_MS;

  pollTimer = setInterval(() => {
    void (async () => {
      if (Date.now() > deadline) {
        stopPoller();
        return;
      }

      console.log('[sleepPoller] Polling for today\'s sleep…');
      await syncPhysiologySnapshot(7);

      if (hasTodaySleep()) {
        console.log('[sleepPoller] Today\'s sleep arrived — stopping poll');
        stopPoller();
        // Re-render whichever view is currently on screen
        if (document.getElementById('stats-card-readiness')) {
          const { renderStatsView } = await import('@/ui/stats-view');
          renderStatsView();
        } else if (document.getElementById('home-tss-row')) {
          const { renderHomeView } = await import('@/ui/home-view');
          renderHomeView();
        }
      }
    })();
  }, POLL_INTERVAL_MS);
}

function stopPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
