/**
 * revenuecat-client.ts
 * ====================
 * Thin wrapper around the RevenueCat Capacitor SDK. All Purchases.* calls live
 * here so the rest of the codebase can stay platform-agnostic.
 *
 * Lifecycle:
 *   - `initRevenueCat(userId)` — called once after the user is authenticated
 *     (from `main.ts`/`launchApp`). Configures the SDK and identifies the user
 *     so webhook events carry the right Supabase user_id.
 *   - `hasActiveCoachEntitlement()` — reads CustomerInfo, returns true if the
 *     `ai_coach` entitlement is currently active.
 *   - `getCoachOfferings()` — fetches the current offering for the paywall.
 *   - `purchaseCoachPackage(pkg)` — runs the StoreKit purchase flow.
 *   - `restoreCoachPurchases()` — re-syncs entitlements from Apple receipts.
 *
 * All functions no-op on non-iOS platforms (return safe defaults) so callers
 * don't need to wrap every call in a Capacitor platform check.
 */

import { Capacitor } from '@capacitor/core';
import {
  Purchases,
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOffering,
  type PurchasesPackage,
} from '@revenuecat/purchases-capacitor';

import { REVENUECAT_IOS_SDK_KEY, COACH_ENTITLEMENT_ID, COACH_OFFERING_ID, isRevenueCatConfigured } from './revenuecat-config';

let _initialized = false;
let _initPromise: Promise<void> | null = null;

/**
 * True when the current platform is iOS via Capacitor.
 * Web and Android builds skip RevenueCat entirely.
 */
function isIOS(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

/**
 * Configure RevenueCat with the public SDK key and identify the user.
 * Safe to call multiple times — only the first call actually initialises.
 *
 * `userId` is the Supabase auth user UUID. RevenueCat treats it as the
 * "App User ID", which means webhook events arrive with that UUID in the
 * `app_user_id` field, letting the backend upsert the right row.
 */
export async function initRevenueCat(userId: string | null): Promise<void> {
  if (!isIOS()) return;
  if (!isRevenueCatConfigured()) {
    console.warn('[revenuecat] SDK key not configured (TODO_PASTE_HERE) — IAP disabled until docs/REVENUECAT_SETUP.md Step 17 is complete');
    return;
  }
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      await Purchases.setLogLevel({ level: LOG_LEVEL.WARN });
      await Purchases.configure({
        apiKey: REVENUECAT_IOS_SDK_KEY,
        appUserID: userId ?? undefined,
      });
      _initialized = true;
    } catch (err) {
      console.error('[revenuecat] configure failed:', (err as Error).message);
      _initPromise = null;  // allow retry on next launch
    }
  })();

  return _initPromise;
}

/**
 * Tell RevenueCat the auth user has changed (sign-in, sign-out, account switch).
 * Re-identifying after sign-in is critical so webhooks carry the right user_id.
 */
export async function identifyRevenueCatUser(userId: string | null): Promise<void> {
  if (!isIOS() || !_initialized) return;
  try {
    if (userId) {
      await Purchases.logIn({ appUserID: userId });
    } else {
      await Purchases.logOut();
    }
  } catch (err) {
    console.error('[revenuecat] identify failed:', (err as Error).message);
  }
}

/**
 * Read CustomerInfo and return true if the AI Coach entitlement is active.
 * Returns false on non-iOS or if RevenueCat is unreachable.
 */
export async function hasActiveCoachEntitlement(): Promise<boolean> {
  if (!isIOS() || !_initialized) return false;
  try {
    const { customerInfo } = await Purchases.getCustomerInfo();
    return Boolean(customerInfo.entitlements.active[COACH_ENTITLEMENT_ID]);
  } catch (err) {
    console.warn('[revenuecat] getCustomerInfo failed:', (err as Error).message);
    return false;
  }
}

/**
 * Fetch the offering that powers the paywall. Returns null if the dashboard
 * isn't configured yet or RevenueCat can't reach the App Store.
 */
export async function getCoachOfferings(): Promise<PurchasesOffering | null> {
  if (!isIOS() || !_initialized) return null;
  try {
    const { current, all } = await Purchases.getOfferings();
    if (current) return current;
    // Fall back to the explicit identifier in case `current` isn't set.
    return all[COACH_OFFERING_ID] ?? null;
  } catch (err) {
    console.error('[revenuecat] getOfferings failed:', (err as Error).message);
    return null;
  }
}

/**
 * Run the StoreKit purchase flow for the supplied package.
 * Returns the updated CustomerInfo on success, or throws on cancellation/error.
 * Callers should catch and surface a toast on failure.
 */
export async function purchaseCoachPackage(pkg: PurchasesPackage): Promise<CustomerInfo> {
  if (!isIOS() || !_initialized) {
    throw new Error('RevenueCat not initialised');
  }
  const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg });
  return customerInfo;
}

/**
 * Re-sync entitlements from Apple's receipt server. Required by App Store
 * guidelines for any IAP — surface this on the Account view.
 */
export async function restoreCoachPurchases(): Promise<{ restored: boolean; customerInfo: CustomerInfo | null }> {
  if (!isIOS() || !_initialized) {
    return { restored: false, customerInfo: null };
  }
  try {
    const { customerInfo } = await Purchases.restorePurchases();
    const restored = Boolean(customerInfo.entitlements.active[COACH_ENTITLEMENT_ID]);
    return { restored, customerInfo };
  } catch (err) {
    console.error('[revenuecat] restore failed:', (err as Error).message);
    return { restored: false, customerInfo: null };
  }
}

/**
 * Subscribe to live CustomerInfo updates (e.g. webhook-driven entitlement
 * changes pushed back to the device). Callback fires whenever Apple or
 * RevenueCat reports a change.
 */
export function onCustomerInfoUpdate(cb: (info: CustomerInfo) => void): void {
  if (!isIOS() || !_initialized) return;
  Purchases.addCustomerInfoUpdateListener(cb);
}
