/**
 * delete-account — Supabase Edge Function
 * =======================================
 * Self-serve account deletion with a 30-day grace period. Matches the promise
 * in public/privacy.html ("full account: deleted within 30 days").
 *
 * Three operations, all gated by Supabase JWT:
 *
 *   POST /delete-account            → schedule deletion (set deleted_at = now())
 *   POST /delete-account?cancel=1   → cancel a pending deletion (clear deleted_at)
 *   GET  /delete-account?status=1   → return current deletion state
 *
 * Side effects on schedule:
 *   - user_plan_settings.deleted_at  = now()
 *   - strava_tokens.deleted_at       = now()
 *   - garmin_tokens.deleted_at       = now()
 *   - HYROX Doubles partner rows deleted at once (not soft-deleted): the
 *     user's link (the mirror row cascades and the link trigger deletes both
 *     snapshots), their snapshot and their invite code. A linked partner stops
 *     reading this account's race numbers immediately. Not restored on cancel;
 *     the two athletes link again with a new code.
 *   - Strava OAuth revoke (synchronous, 5s timeout; result surfaced in
 *     response.strava_revoke; not fatal if it fails — cron purges row in 30d)
 *
 * The hard delete + auth.admin.deleteUser() happens in the daily
 * purge-deleted-accounts cron, so a user can sign back in within 30 days
 * to cancel.
 *
 * Security:
 *   1. JWT required (auth.getUser via the user-scoped client)
 *   2. user_id derived server-side — never trust client claims
 *   3. Service-role client used only for the writes; RLS bypassed deliberately
 *      because the SELECT policies filter out soft-deleted rows from the user
 *   4. Restricted CORS (mirrors coach-chat pattern)
 *   5. No payload body required; method + query params determine action
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── CORS ─────────────────────────────────────────────────────────────────────

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

// ─── Strava token revocation (synchronous with timeout) ─────────────────────
//
// Apple 5.1.1(v) expects clean third-party access revocation on account
// deletion. We attempt the deauthorize call synchronously with a 5s timeout
// so the request completes before we tell the client the deletion is
// scheduled. The 30-day grace + purge cron remains the safety net — even if
// Strava is unreachable here, the token row is marked deleted_at = now() and
// will be hard-deleted by the cron.

type StravaRevokeResult =
  | { kind: 'success'; status: number }
  | { kind: 'no_token' }
  | { kind: 'failed'; reason: string; status?: number }

async function revokeStravaToken(accessToken: string | null | undefined): Promise<StravaRevokeResult> {
  if (!accessToken) return { kind: 'no_token' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch('https://www.strava.com/oauth/deauthorize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    })
    if (res.ok) {
      return { kind: 'success', status: res.status }
    }
    return { kind: 'failed', reason: 'http_error', status: res.status }
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error'
    return { kind: 'failed', reason }
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  const url = new URL(req.url)
  const isCancel = url.searchParams.get('cancel') === '1'
  const isStatus = url.searchParams.get('status') === '1'

  if (req.method !== 'POST' && req.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, cors)
  }
  if (req.method === 'GET' && !isStatus) {
    return jsonResponse({ error: 'method_not_allowed' }, 405, cors)
  }

  // Auth — user-scoped client to extract auth.uid() from the JWT.
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
  const { data: userData, error: userError } = await userClient.auth.getUser()
  if (userError || !userData?.user?.id) {
    return jsonResponse({ error: 'unauthorized' }, 401, cors)
  }
  const userId = userData.user.id

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // ─── Status read ───────────────────────────────────────────────────────────
  if (isStatus) {
    const { data, error } = await admin
      .from('user_plan_settings')
      .select('deleted_at')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) return jsonResponse({ error: 'internal_error' }, 500, cors)
    const deletedAt = (data?.deleted_at as string | null) ?? null
    if (!deletedAt) return jsonResponse({ deleted_at: null, purge_date: null }, 200, cors)
    const purge = new Date(new Date(deletedAt).getTime() + 30 * 24 * 60 * 60 * 1000)
    return jsonResponse({ deleted_at: deletedAt, purge_date: purge.toISOString() }, 200, cors)
  }

  // ─── Cancel pending deletion ───────────────────────────────────────────────
  if (isCancel) {
    const cancelTs = new Date().toISOString()
    const updates = await Promise.all([
      admin.from('user_plan_settings').update({ deleted_at: null }).eq('user_id', userId),
      admin.from('strava_tokens').update({ deleted_at: null }).eq('user_id', userId),
      admin.from('garmin_tokens').update({ deleted_at: null }).eq('user_id', userId),
    ])
    if (updates.some(r => r.error)) {
      return jsonResponse({ error: 'internal_error' }, 500, cors)
    }
    return jsonResponse({ status: 'cancelled', at: cancelTs }, 200, cors)
  }

  // ─── Schedule deletion ─────────────────────────────────────────────────────
  const now = new Date()
  const purgeDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  const nowIso = now.toISOString()

  // Read Strava token before marking deleted so we can revoke at Strava.
  const { data: stravaRow } = await admin
    .from('strava_tokens')
    .select('access_token')
    .eq('user_id', userId)
    .maybeSingle()

  // Atomic-ish: mark all three rows. If one fails, we still proceed —
  // the daily cron will hard-delete every row referencing this user_id
  // via the auth.admin.deleteUser cascade as a final safety net.
  const writes = await Promise.all([
    admin.from('user_plan_settings').update({ deleted_at: nowIso }).eq('user_id', userId),
    admin.from('strava_tokens').update({ deleted_at: nowIso }).eq('user_id', userId),
    admin.from('garmin_tokens').update({ deleted_at: nowIso }).eq('user_id', userId),
  ])

  // user_plan_settings is the canonical row; we require its update to succeed.
  // If no row exists (e.g. user signed up but never saved state), upsert one
  // with a minimal snapshot so the cron picks them up.
  if (writes[0].error) {
    const { error: upsertErr } = await admin
      .from('user_plan_settings')
      .upsert({ user_id: userId, state_snapshot: {}, deleted_at: nowIso, updated_at: nowIso })
    if (upsertErr) {
      return jsonResponse({ error: 'internal_error' }, 500, cors)
    }
  }

  // HYROX Doubles partner: hard-delete now, link first (its trigger removes
  // both snapshots), then the user's own snapshot and invite. Non-fatal: the
  // auth.users purge cascades every partner row in 30 days regardless.
  const partnerCleanup: Array<[string, string]> = [
    ['hyrox_partner_links', 'user_id'],
    ['hyrox_partner_snapshots', 'user_id'],
    ['hyrox_partner_invites', 'owner_id'],
  ]
  for (const [table, key] of partnerCleanup) {
    const { error } = await admin.from(table).delete().eq(key, userId)
    if (error) console.warn('[delete-account] partner cleanup failed', JSON.stringify({ userId, table, error: error.message }))
  }

  // Synchronous Strava revoke with 5s timeout. Errors here are non-fatal —
  // the token row is already marked deleted_at and the cron will purge it in
  // 30 days. Result is logged + surfaced to the client so support can debug
  // if a reviewer flags incomplete revocation.
  const revokeResult = await revokeStravaToken((stravaRow as { access_token?: string } | null)?.access_token)
  console.log('[delete-account] strava revoke', JSON.stringify({ userId, ...revokeResult }))

  return jsonResponse(
    {
      status: 'scheduled',
      deleted_at: nowIso,
      purge_date: purgeDate.toISOString(),
      strava_revoke: revokeResult.kind,
    },
    200,
    cors,
  )
})
