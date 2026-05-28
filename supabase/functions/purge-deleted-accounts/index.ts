/**
 * purge-deleted-accounts — Supabase Edge Function (cron-only)
 * ===========================================================
 * Hard-deletes accounts that have been soft-deleted for at least 30 days.
 * Triggered nightly by pg_cron (see migration 20260517000002_purge_deleted_accounts_cron.sql).
 *
 * Selection criterion:
 *   user_plan_settings.deleted_at IS NOT NULL
 *   AND deleted_at < now() - interval '30 days'
 *
 * For each selected user_id:
 *   1. Delete rows from every table that holds user data and is NOT covered
 *      by ON DELETE CASCADE from auth.users (defensive belt-and-braces).
 *   2. Call auth.admin.deleteUser(user_id) — cascades to user_plan_settings,
 *      strava_tokens, garmin_tokens (per `ON DELETE CASCADE` in those
 *      table definitions referencing auth.users(id)).
 *
 * Failure mode is per-user: a single user's delete failing does not stop the
 * batch. Errors are logged with the user_id prefix so they can be re-run
 * manually if needed. The cron simply re-runs the next night and picks up
 * anything still pending.
 *
 * Auth:
 *   Cron calls with `x-cron-secret` header; function rejects everything else.
 *   No JWT auth — this runs server-side only.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GRACE_DAYS = 30
const BATCH_LIMIT = 50

// Tables that may hold user-keyed rows. `auth.admin.deleteUser` cascades to
// every table with `ON DELETE CASCADE` against `auth.users(id)`; this list is
// the belt-and-braces fallback for tables that don't have the cascade or
// where the FK is not on `auth.users` directly.
const USER_DATA_TABLES = [
  'daily_metrics',
  'sleep_summaries',
  'activity_details',
  'garmin_activities',
  'coach_chat_usage',
  'coach_narrative_cache',
  'route_safety_ratings',
  'physiology_snapshots',
  'best_efforts',
  'power_curve_points',
]

Deno.serve(async (req: Request) => {
  // Cron-only — reject anything without the shared secret. The secret is
  // stored in Supabase Vault and injected by pg_cron via the http_post call.
  const cronSecret = req.headers.get('x-cron-secret')
  const expected = Deno.env.get('PURGE_CRON_SECRET') ?? ''
  if (!expected || cronSecret !== expected) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Find users whose grace window has elapsed.
  const { data: targets, error: selectErr } = await admin
    .from('user_plan_settings')
    .select('user_id, deleted_at')
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff)
    .limit(BATCH_LIMIT)

  if (selectErr) {
    return new Response(JSON.stringify({ error: 'select_failed', detail: selectErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const results: Array<{ user_id: string; status: 'purged' | 'failed'; reason?: string }> = []

  for (const row of targets ?? []) {
    const userId = (row as { user_id: string }).user_id
    if (!userId) continue
    const prefix = userId.slice(0, 8)

    try {
      // Defensive deletes — most cascade automatically, but if a table lacks
      // the cascade FK this catches it. Failures here are non-fatal because
      // the auth.users delete below cascades anyway.
      for (const table of USER_DATA_TABLES) {
        const { error } = await admin.from(table).delete().eq('user_id', userId)
        if (error) {
          console.warn(`[purge:${prefix}] non-fatal delete error on ${table}:`, error.message)
        }
      }

      // Final cascade — removes auth.users row + every CASCADE-FK child.
      const { error: authErr } = await admin.auth.admin.deleteUser(userId, false)
      if (authErr) {
        results.push({ user_id: userId, status: 'failed', reason: authErr.message })
        console.error(`[purge:${prefix}] auth.admin.deleteUser failed:`, authErr.message)
        continue
      }

      results.push({ user_id: userId, status: 'purged' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      results.push({ user_id: userId, status: 'failed', reason: msg })
      console.error(`[purge:${prefix}] exception:`, msg)
    }
  }

  return new Response(
    JSON.stringify({
      processed: results.length,
      purged: results.filter(r => r.status === 'purged').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
})
