/**
 * Beta access codes that unlock the live "Connect Strava" path in onboarding.
 *
 * Strava's Standard Tier caps us at 10 connected athletes (see `STRAVA_ENABLED`
 * in feature-flags.ts). Until Extended Access approval lands, the Strava connect
 * button is gated behind one of these codes so public users don't consume the
 * 10 slots. The Garmin onboarding tile asks for a code; a valid one reveals the
 * Strava connect button, an invalid/absent one falls through to the manual path.
 *
 * NOTE: these ship in the client bundle, so a determined user could read them.
 * That's acceptable for a cap-limited beta gate. The worst case is a stranger
 * burning one of 10 Strava slots, not a security breach. Replace with a
 * Supabase-backed, server-validated list when we move past beta scale.
 *
 * Matching is case-insensitive and whitespace-trimmed (see isValidAccessCode),
 * so "Benjamin", "benjamin", and " BENJAMIN " all unlock the Strava path.
 */
export const VALID_ACCESS_CODES: readonly string[] = [
  'BENJAMIN',
];

/** Case-insensitive, whitespace-trimmed check against the beta allowlist. */
export function isValidAccessCode(code: string): boolean {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return false;
  return VALID_ACCESS_CODES.some(c => c.toUpperCase() === normalized);
}

/**
 * App Store reviewer code. Entered in the same access-code field on the connect-data
 * step; instead of unlocking Strava it seeds a complete sample account and drops the
 * reviewer straight into a populated app (see seedReviewerDemo). Documented in the
 * App Store reviewer notes so a fresh-install reviewer can evaluate the full app
 * without any watch/Strava data of their own.
 */
export const REVIEWER_ACCESS_CODE = 'REVIEW';

/** Case-insensitive, whitespace-trimmed check for the reviewer demo code. */
export function isReviewerCode(code: string): boolean {
  return code.trim().toUpperCase() === REVIEWER_ACCESS_CODE;
}
