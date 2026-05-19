/**
 * revenuecat-config.ts
 * ====================
 * Configuration constants for the RevenueCat IAP integration on iOS.
 *
 * The string `TODO_PASTE_HERE` marks values Tristan swaps in after completing
 * the RevenueCat dashboard setup. See `docs/REVENUECAT_SETUP.md` for the runbook.
 *
 * Anything in this file is safe to ship — the iOS SDK key is a *publishable*
 * key. RevenueCat's threat model assumes attackers see it.
 */

/**
 * Public iOS SDK key from RevenueCat → Project Settings → API Keys → Apple App Store.
 * Format: `appl_xxxxxxxxxxxxxxxxxxxxxxxx`.
 * See `docs/REVENUECAT_SETUP.md` Step 13.
 */
export const REVENUECAT_IOS_SDK_KEY = 'TODO_PASTE_HERE';

/**
 * Entitlement identifier configured in RevenueCat (Step 11).
 * Single entitlement gates AI Coach access; both monthly + annual products grant it.
 */
export const COACH_ENTITLEMENT_ID = 'ai_coach';

/**
 * Offering identifier configured in RevenueCat (Step 12).
 * The paywall calls `getOfferings()` and reads `current` (set at the project level)
 * or falls back to this string.
 */
export const COACH_OFFERING_ID = 'default';

/**
 * App Store Connect product IDs (Step 3 + Step 4 of the runbook).
 * The paywall doesn't reference these directly — it goes through RevenueCat
 * packages — but they're declared here so analytics/debug logs can show the
 * exact SKU the user bought.
 */
export const PRODUCT_ID_MONTHLY = 'mosaic_ai_coach_monthly_v1';
export const PRODUCT_ID_ANNUAL  = 'mosaic_ai_coach_annual_v1';

/**
 * True when the SDK key has been swapped in (i.e. RevenueCat dashboard is set up).
 * Other modules check this before attempting to init or query Purchases — keeps
 * the app silent on dev machines where Tristan hasn't completed the runbook yet.
 */
export function isRevenueCatConfigured(): boolean {
  const key = REVENUECAT_IOS_SDK_KEY as string;
  return key !== 'TODO_PASTE_HERE' && key.length > 0;
}
