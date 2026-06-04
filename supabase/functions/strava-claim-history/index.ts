/**
 * strava-claim-history — Supabase Edge Function
 * =============================================
 * Reunites a user with activity history that lives under OTHER user accounts
 * connected to the SAME Strava athlete (ISSUE-270: anonymous-by-default auth
 * forks data on reinstall / device change / storage eviction).
 *
 *   POST /strava-claim-history            → move the activities, retire old tokens
 *   GET  /strava-claim-history?status=1   → count what is claimable, change nothing
 *
 * Ownership proof: the caller's own `strava_tokens` row. It can only exist via
 * a completed Strava OAuth handshake, so the caller demonstrably controls that
 * Strava account; every other user_id holding tokens for the same
 * strava_athlete_id is a prior session of the same person.
 *
 * What moves: `garmin_activities.user_id` is rewritten to the caller for every
 * row owned by a same-athlete account. `garmin_id` is globally UNIQUE, so the
 * move can never collide — in fact that constraint is why a forked account can
 * NOT simply re-sync its history (the old account owns the rows).
 *
 * What retires: the old accounts' strava_tokens rows get deleted_at = now() so
 * the refresh cron stops keeping them alive and future fork-guard checks skip
 * them. Their auth users and plan settings are left untouched (the purge cron
 * and account deletion own those lifecycles).
 *
 * Security:
 *   1. JWT required (verify_jwt default + auth.getUser via user-scoped client)
 *   2. caller user_id and athlete id derived server-side, never from the body
 *   3. Service-role client for the cross-user writes (deliberate RLS bypass —
 *      the whole point is moving rows between users; scope is pinned by the
 *      athlete-id equality)
 *   4. Restricted CORS (delete-account pattern)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_ORIGINS = [
  'http://localhost',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'capacitor://localhost',
  'https://mosaicrunning.run',
]

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  }
}

function jsonResponse(body: Record<string, unknown>, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const url = new URL(req.url)
  const isStatus = url.searchParams.get('status') === '1'
  if (req.method !== 'POST' && !(req.method === 'GET' && isStatus)) {
    return jsonResponse({ error: 'method_not_allowed' }, 405, cors)
  }

  // Auth — derive the caller from the JWT, never from the request body.
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'unauthorized' }, 401, cors)
  }
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: userErr } = await userClient.auth.getUser()
  if (userErr || !user) {
    return jsonResponse({ error: 'unauthorized' }, 401, cors)
  }
  const callerId = user.id

  const admin = createClient(SUPABASE_URL, SERVICE_KEY)

  try {
    // 1. Caller's own Strava connection = proof of athlete ownership.
    const { data: ownToken, error: ownErr } = await admin
      .from('strava_tokens')
      .select('strava_athlete_id')
      .eq('user_id', callerId)
      .is('deleted_at', null)
      .maybeSingle()
    if (ownErr) {
      console.error('[strava-claim-history] own-token lookup failed', ownErr)
      return jsonResponse({ error: 'lookup_failed' }, 500, cors)
    }
    const athleteId = ownToken?.strava_athlete_id
    if (!athleteId) {
      return jsonResponse({ error: 'no_strava_connection' }, 400, cors)
    }

    // 2. Prior accounts: same athlete, different user_id, not already retired.
    const { data: priorTokens, error: priorErr } = await admin
      .from('strava_tokens')
      .select('user_id')
      .eq('strava_athlete_id', athleteId)
      .neq('user_id', callerId)
      .is('deleted_at', null)
    if (priorErr) {
      console.error('[strava-claim-history] prior-token lookup failed', priorErr)
      return jsonResponse({ error: 'lookup_failed' }, 500, cors)
    }
    const priorIds = (priorTokens ?? []).map((t: { user_id: string }) => t.user_id)
    if (priorIds.length === 0) {
      return jsonResponse({ claimable: 0, moved: 0, accounts: 0 }, 200, cors)
    }

    // 3. Count what's claimable.
    const { count: claimable, error: countErr } = await admin
      .from('garmin_activities')
      .select('id', { count: 'exact', head: true })
      .in('user_id', priorIds)
    if (countErr) {
      console.error('[strava-claim-history] count failed', countErr)
      return jsonResponse({ error: 'lookup_failed' }, 500, cors)
    }

    if (isStatus) {
      return jsonResponse({ claimable: claimable ?? 0, accounts: priorIds.length }, 200, cors)
    }

    // 4. Move the activities. garmin_id is globally unique and unchanged, so
    //    this cannot collide with the caller's existing rows.
    const { data: movedRows, error: moveErr } = await admin
      .from('garmin_activities')
      .update({ user_id: callerId })
      .in('user_id', priorIds)
      .select('id')
    if (moveErr) {
      console.error('[strava-claim-history] move failed', moveErr)
      return jsonResponse({ error: 'move_failed' }, 500, cors)
    }

    // 5. Retire the old token rows so the refresh cron stops resurrecting the
    //    forks and repeat claims are no-ops.
    const { error: retireErr } = await admin
      .from('strava_tokens')
      .update({ deleted_at: new Date().toISOString() })
      .in('user_id', priorIds)
    if (retireErr) {
      // Not fatal: activities moved; the next claim retires the tokens.
      console.error('[strava-claim-history] token retire failed', retireErr)
    }

    const moved = movedRows?.length ?? 0
    console.log(`[strava-claim-history] user ${callerId} claimed ${moved} activities from ${priorIds.length} prior account(s) (athlete ${athleteId})`)
    return jsonResponse({ claimable: claimable ?? 0, moved, accounts: priorIds.length }, 200, cors)
  } catch (e) {
    console.error('[strava-claim-history] unexpected', e)
    return jsonResponse({ error: 'internal_error' }, 500, cors)
  }
})
