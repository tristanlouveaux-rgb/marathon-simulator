/**
 * export-user-data — Supabase Edge Function
 * =========================================
 * GDPR Art. 15 (right of access) — returns a JSON file containing every row
 * Mosaic holds about the requesting user. Used by the in-app "Download my
 * data" button (Account view → Legal & data).
 *
 * GET /export-user-data
 *   → 200 application/json (Content-Disposition: attachment) on success
 *   → 401 if JWT is missing or invalid
 *
 * What's included:
 *   - user_plan_settings (the SimulatorState snapshot)
 *   - daily_metrics, sleep_summaries, activity_details, garmin_activities,
 *     coach_chat_usage, coach_narrative_cache, physiology_snapshots,
 *     best_efforts, power_curve_points, route_safety_ratings
 *
 * What's stripped:
 *   - strava_tokens / garmin_tokens (credentials — never exported)
 *   - service-internal counters (llm_spend_tracker)
 *   - any field flagged sensitive (none currently)
 *
 * Why server-side rather than client-side: many of these tables have RLS
 * SELECT policies but are also keyed via foreign tables (e.g.
 * activity_details by garmin_id). A single server-side query is simpler and
 * guarantees consistency.
 *
 * Auth: JWT required. user_id derived from auth.getUser server-side. The
 * service-role client is used for the actual reads to bypass RLS and gather
 * a complete export — but only for the authenticated user's rows.
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  }
}

// Tables to export. Each is keyed on `user_id` (some via a join to garmin_id
// — handled per-table below).
const EXPORT_TABLES = [
  'user_plan_settings',
  'daily_metrics',
  'sleep_summaries',
  'garmin_activities',
  'coach_chat_usage',
  'coach_narrative_cache',
  'physiology_snapshots',
  'best_efforts',
  'power_curve_points',
  'route_safety_ratings',
] as const

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userError } = await userClient.auth.getUser()
  if (userError || !userData?.user?.id) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  const userId = userData.user.id
  const userEmail = userData.user.email ?? null

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  const exported: Record<string, unknown> = {
    meta: {
      generated_at: new Date().toISOString(),
      user_id: userId,
      email: userEmail,
      app: 'Mosaic',
      note: 'This export contains every row Mosaic holds about you. Credentials (Strava/Garmin tokens) are intentionally excluded.',
    },
    tables: {},
  }

  const tables = exported.tables as Record<string, unknown>

  for (const table of EXPORT_TABLES) {
    try {
      const { data, error } = await admin.from(table).select('*').eq('user_id', userId)
      if (error) {
        tables[table] = { error: error.message }
      } else {
        tables[table] = data ?? []
      }
    } catch (err) {
      tables[table] = { error: err instanceof Error ? err.message : 'unknown' }
    }
  }

  // activity_details is keyed by garmin_id, not user_id — join through
  // garmin_activities to find the IDs that belong to this user.
  try {
    const ids = ((tables.garmin_activities as Array<{ garmin_id?: string }>) ?? [])
      .map(r => r.garmin_id)
      .filter((v): v is string => typeof v === 'string')
    if (ids.length > 0) {
      const { data, error } = await admin
        .from('activity_details')
        .select('*')
        .in('garmin_id', ids)
      tables.activity_details = error ? { error: error.message } : (data ?? [])
    } else {
      tables.activity_details = []
    }
  } catch (err) {
    tables.activity_details = { error: err instanceof Error ? err.message : 'unknown' }
  }

  const body = JSON.stringify(exported, null, 2)
  const filename = `mosaic-data-export-${new Date().toISOString().slice(0, 10)}.json`

  return new Response(body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})
