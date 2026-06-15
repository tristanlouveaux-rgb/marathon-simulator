import { callEdgeFunction } from './supabaseClient';
import { NATIVE_OAUTH_ENABLED } from '@/constants/feature-flags';
import { isNativeiOS } from './appleHealthSync';
import { NATIVE_OAUTH_RETURN_URL, runNativeOAuth } from './oauth-native';

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
 *
 * Mirrors `startStravaConnect`: when `NATIVE_OAUTH_ENABLED` and on native iOS,
 * opens the authorize page in an in-app browser and returns via the mosaic://
 * deep link instead of a full-page redirect.
 */
export async function startGarminConnect(): Promise<void> {
  const native = NATIVE_OAUTH_ENABLED && isNativeiOS();
  const data = await callEdgeFunction<{ url?: string }>('garmin-auth-start', {
    appOrigin: native ? NATIVE_OAUTH_RETURN_URL : window.location.origin,
  });
  if (!data?.url) throw new Error('garmin-auth-start returned no url');
  if (native) {
    // ASWebAuthenticationSession returns the mosaic://oauth?... callback URL
    // directly. Re-enter with its query string so main.ts's `?garmin=connected`
    // return handler runs (same path as the web full-page redirect).
    const params = await runNativeOAuth(data.url);
    if (params && params.get('garmin') === 'connected') {
      const qs = params.toString();
      window.location.href = window.location.pathname + (qs ? `?${qs}` : '');
    }
    return;
  }
  window.location.href = data.url;
}
