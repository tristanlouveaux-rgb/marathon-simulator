import { callEdgeFunction } from './supabaseClient';

/**
 * Begin the Garmin Connect OAuth handshake. POSTs to the `garmin-auth-start` edge
 * function and redirects the browser to Garmin's authorize page. On approval Garmin
 * bounces back to the app origin with `?garmin=connected` (handled in main.ts).
 *
 * Garmin direct connect delivers physiology (sleep, HRV, resting HR) and activity
 * summaries, but NOT per-km splits (only Strava carries those — see CLAUDE.md). The
 * whole flow is gated behind `GARMIN_CONNECT_ENABLED` (currently false: Garmin's
 * webhook is approved for a single developer account only). Shared by the Account
 * connect button and the onboarding connect-data step so both use one code path.
 */
export async function startGarminConnect(): Promise<void> {
  const data = await callEdgeFunction<{ url?: string }>('garmin-auth-start', {
    appOrigin: window.location.origin,
  });
  if (data?.url) {
    window.location.href = data.url;
    return;
  }
  throw new Error('garmin-auth-start returned no url');
}
