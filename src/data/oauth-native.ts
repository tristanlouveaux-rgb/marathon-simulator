/**
 * Native iOS OAuth via ASWebAuthenticationSession (the `@mosaic/web-auth`
 * plugin).
 *
 * History: we first tried navigating the whole WKWebView to the provider
 * (`window.location.href = authorizeUrl`) — fragile, the bounce back to
 * `capacitor://localhost` strands the user. Then `@capacitor/browser`
 * (SFSafariViewController) + a `mosaic://oauth` deep link via `appUrlOpen` —
 * which hit two iOS/Supabase walls (2026-06-15): SFSafariViewController refuses
 * to follow a 302 to a custom scheme ("address is invalid"), and the Supabase
 * edge gateway force-rewrites responses to text/plain so the JS-redirect HTML
 * workaround renders as raw source.
 *
 * ASWebAuthenticationSession sidesteps both. You hand it the authorize URL and
 * the callback scheme ("mosaic"); it monitors navigation (including the 302),
 * intercepts the first `mosaic://...` URL, dismisses itself, and returns the
 * full callback URL to JS. No deep-link round-trip, no `appUrlOpen` listener,
 * no HTML page. Everything here is a safe no-op on web.
 *
 * Gated behind `NATIVE_OAUTH_ENABLED` at the call sites.
 */

import { registerPlugin } from '@capacitor/core';
import { isNativeiOS } from './appleHealthSync';

/** The deep link the OAuth callback redirects to. Registered as a URL scheme in
 *  `ios/App/App/Info.plist` (CFBundleURLTypes). Passed to the `*-auth-start`
 *  edge function as `appOrigin` so the callback's `pickRedirectTarget` returns
 *  it (the function's allowlist must include this exact value). */
export const NATIVE_OAUTH_RETURN_URL = 'mosaic://oauth';

/** The bare scheme handed to ASWebAuthenticationSession's `callbackURLScheme`.
 *  Must match the scheme of NATIVE_OAUTH_RETURN_URL and the Info.plist entry. */
const RETURN_SCHEME = 'mosaic';

interface WebAuthPlugin {
  /** Open the provider authorize page in ASWebAuthenticationSession. Resolves
   *  with the intercepted callback URL (e.g. "mosaic://oauth?strava=connected"),
   *  or rejects with code "cancelled" if the user dismisses the sheet. */
  start(options: {
    url: string;
    callbackScheme: string;
    prefersEphemeralWebBrowserSession?: boolean;
  }): Promise<{ url: string }>;
}

const WebAuth = registerPlugin<WebAuthPlugin>('WebAuth');

/**
 * Run the full native OAuth handshake: open the authorize page in
 * ASWebAuthenticationSession and wait for the `mosaic://oauth?...` return.
 * Returns the callback's query params, or null if the user cancelled / it
 * failed. Caller feeds the params into the existing `?strava=connected` /
 * `?garmin=connected` return handler.
 *
 * `prefersEphemeralWebBrowserSession` is false so the session shares Safari's
 * cookies — if the user is already logged into Strava/Garmin in Safari they skip
 * re-entering credentials.
 */
export async function runNativeOAuth(authorizeUrl: string): Promise<URLSearchParams | null> {
  if (!isNativeiOS()) return null;
  try {
    const result = await WebAuth.start({
      url: authorizeUrl,
      callbackScheme: RETURN_SCHEME,
      prefersEphemeralWebBrowserSession: false,
    });
    const url = result?.url ?? '';
    const qIndex = url.indexOf('?');
    return new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : '');
  } catch {
    // Cancelled or failed. The redirect-independent self-heal
    // (recoverPendingStravaOAuth) still completes the connection on the next
    // render if the token actually landed server-side.
    return null;
  }
}
