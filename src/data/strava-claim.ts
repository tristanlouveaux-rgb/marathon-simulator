/**
 * Client for the strava-claim-history edge function (ISSUE-270 fork guard).
 *
 * When a Strava connect returns with `?existing=N`, this athlete has activity
 * history under prior user accounts (anonymous-auth forks from reinstall /
 * device change). The function moves those rows to the current user and
 * retires the old token rows. Ownership proof is server-side (the caller's
 * own strava_tokens row); nothing is passed from the client but the JWT.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, getValidSession } from './supabaseClient';

export interface ClaimResult {
  claimable: number;
  moved: number;
  accounts: number;
}

/** Read-only: how many activities are claimable from prior accounts. */
export async function checkClaimableHistory(): Promise<{ claimable: number; accounts: number } | null> {
  try {
    const session = await getValidSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/strava-claim-history?status=1`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    });
    if (!res.ok) return null;
    return await res.json() as { claimable: number; accounts: number };
  } catch {
    return null;
  }
}

const CLAIM_CHECK_TS_KEY = 'mosaic_claim_check_ts';
const CLAIM_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Launch convergence check (ISSUE-270 two-device hardening): a fork can form
 * while THIS device sits idle (another anonymous session connects the same
 * Strava and accumulates rows). Once a day, ask the server whether claimable
 * history exists; when it does, surface the same confirm overlay the OAuth
 * return uses. Device-local throttle — each device checks independently.
 */
export async function maybeOfferClaimOnLaunch(): Promise<void> {
  try {
    const last = Number(localStorage.getItem(CLAIM_CHECK_TS_KEY) ?? '0');
    if (Date.now() - last < CLAIM_CHECK_INTERVAL_MS) return;
    localStorage.setItem(CLAIM_CHECK_TS_KEY, String(Date.now()));
    const status = await checkClaimableHistory();
    if (!status || status.claimable <= 0) return;
    const { openHistoryClaimOverlay } = await import('@/ui/history-claim-overlay');
    openHistoryClaimOverlay(status.claimable, () => {
      // Imported rows are in the DB; a sync re-derives matches and benchmarks.
      void import('@/data/stravaSync').then(m => m.syncStravaActivities()).catch(() => {});
    });
  } catch {
    /* never block launch */
  }
}

/** Move all prior-account activities for this Strava athlete to the current user. */
export async function claimStravaHistory(): Promise<ClaimResult | null> {
  try {
    const session = await getValidSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/strava-claim-history`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      console.warn('[strava-claim] claim failed', res.status, await res.text().catch(() => ''));
      return null;
    }
    const json = await res.json() as ClaimResult;
    console.log(`[strava-claim] moved ${json.moved} activities from ${json.accounts} prior account(s)`);
    return json;
  } catch (err) {
    console.warn('[strava-claim] claim errored', err);
    return null;
  }
}
