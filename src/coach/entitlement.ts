/**
 * entitlement.ts
 * ==============
 * Single source of truth for "does this user have AI Coach access?". Replaces
 * the legacy hard-coded UID allowlist with a real subscription check.
 *
 * Resolution order:
 *   1. On iOS. Read CustomerInfo from RevenueCat. This is authoritative because
 *      Apple's StoreKit is the source of truth for iOS purchases.
 *   2. On web / Android (or if RevenueCat isn't yet configured). Fall back to
 *      a Supabase `subscription_active` row read. The RevenueCat webhook writes
 *      this row on every purchase event, so it eventually reflects any iOS sale
 *      after a few seconds of webhook lag.
 *
 * Cached per session like the old allowlist; call `resetEntitlementCache()`
 * after auth changes or after a successful purchase / restore.
 */

import { Capacitor } from '@capacitor/core';
import { supabase } from '@/data/supabaseClient';
import { hasActiveCoachEntitlement } from './revenuecat-client';
import { isRevenueCatConfigured } from './revenuecat-config';

let _cachedResult: boolean | null = null;

/**
 * True when the currently signed-in user has an active AI Coach entitlement.
 * Falls through silently and returns false on any error so the UI can render
 * the paywall surface instead of crashing.
 */
export async function hasActiveCoachSubscription(): Promise<boolean> {
  if (_cachedResult !== null) return _cachedResult;

  try {
    // iOS path. Apple is the source of truth via RevenueCat.
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios' && isRevenueCatConfigured()) {
      const active = await hasActiveCoachEntitlement();
      _cachedResult = active;
      return active;
    }

    // Web / Android path. Read the subscription_active row that RevenueCat
    // webhook writes. RLS limits the SELECT to the user's own row.
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) {
      _cachedResult = false;
      return false;
    }

    const { data, error } = await supabase
      .from('subscription_active')
      .select('tier, status, valid_until')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) {
      _cachedResult = false;
      return false;
    }

    // Active = tier not 'free' AND (no expiry OR expiry in the future).
    // We treat both 'active' and 'in_trial' status values as entitled. A
    // 'cancelled' row remains entitled until valid_until passes. Apple lets
    // the user keep what they paid for through the end of the period.
    const validUntilOk = !data.valid_until || new Date(data.valid_until) > new Date();
    const entitled = data.tier !== 'free' && validUntilOk &&
      (data.status === 'active' || data.status === 'in_trial' || data.status === 'in_grace' || data.status === 'cancelled');

    _cachedResult = entitled;
    return entitled;
  } catch (err) {
    console.warn('[entitlement] check failed, defaulting to non-entitled:', (err as Error).message);
    _cachedResult = false;
    return false;
  }
}

/**
 * Clear the cached result. Call after:
 *   - The user signs in or out (auth state change)
 *   - A successful purchase or restore (so the next render reads the new state)
 *   - A push notification that hints an entitlement change happened server-side
 */
export function resetEntitlementCache(): void {
  _cachedResult = null;
}
