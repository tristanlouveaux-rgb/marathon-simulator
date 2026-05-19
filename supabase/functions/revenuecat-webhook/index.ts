/**
 * revenuecat-webhook — Supabase Edge Function
 * =============================================
 * Receives subscription lifecycle events from RevenueCat and upserts the
 * `subscription_active` row that gates AI Coach access.
 *
 * Security:
 *   - Authorization header must match REVENUECAT_WEBHOOK_AUTH env var exactly.
 *     This is a shared secret set in both RevenueCat's dashboard and Supabase
 *     edge function secrets. RevenueCat sends the entire header value as the
 *     Authorization header on every event.
 *   - Service role used for the DB upsert; RLS denies all client writes.
 *   - last_event_id dedup so retried events don't double-write.
 *
 * Event types handled (per https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields):
 *   INITIAL_PURCHASE      — first-time purchase, including trial-only signups
 *   RENEWAL               — periodic auto-renewal
 *   PRODUCT_CHANGE        — user upgraded/downgraded between monthly and annual
 *   NON_RENEWING_PURCHASE — one-time purchase (not used by Mosaic but handled)
 *   UNCANCELLATION        — user re-enabled auto-renew after cancelling
 *   CANCELLATION          — auto-renew off but still entitled until expiry
 *   EXPIRATION            — sub ended, no longer entitled
 *   BILLING_ISSUE         — Apple couldn't charge; grace window starts
 *   SUBSCRIBER_ALIAS      — informational; we ignore (we use app_user_id directly)
 *   TRANSFER              — sub moved between users; we ignore for now (rare)
 *
 * Any unhandled event type still returns 200 so RevenueCat doesn't retry.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── Types (subset of RevenueCat webhook payload) ────────────────────────────

interface RevenueCatEvent {
  id: string
  type: string
  app_user_id: string
  product_id?: string
  entitlement_ids?: string[]
  purchased_at_ms?: number
  expiration_at_ms?: number
  store?: string
  period_type?: string
  cancel_reason?: string
}

interface RevenueCatWebhookBody {
  event: RevenueCatEvent
  api_version?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function msToIso(ms: number | undefined): string | null {
  if (!ms || typeof ms !== 'number') return null
  return new Date(ms).toISOString()
}

/** Map a RevenueCat event type to the subscription_active row shape. Returns
 *  null when the event doesn't change entitlement state (e.g. SUBSCRIBER_ALIAS). */
function deriveRowFromEvent(event: RevenueCatEvent): {
  tier: string
  status: string
  product_id: string | null
  entitlement_id: string | null
  platform: string
  valid_until: string | null
} | null {
  const productId = event.product_id ?? null
  const entitlementId = event.entitlement_ids?.[0] ?? null
  const platform = event.store === 'APP_STORE' ? 'app_store'
    : event.store === 'PLAY_STORE' ? 'play_store'
    : event.store === 'STRIPE' ? 'stripe'
    : 'unknown'
  const validUntil = msToIso(event.expiration_at_ms)

  switch (event.type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
    case 'NON_RENEWING_PURCHASE': {
      const inTrial = event.period_type === 'TRIAL' || event.period_type === 'INTRO'
      return {
        tier: 'ai_coach',
        status: inTrial ? 'in_trial' : 'active',
        product_id: productId,
        entitlement_id: entitlementId,
        platform,
        valid_until: validUntil,
      }
    }
    case 'CANCELLATION':
      // User cancelled auto-renew but still has access until valid_until.
      return {
        tier: 'ai_coach',
        status: 'cancelled',
        product_id: productId,
        entitlement_id: entitlementId,
        platform,
        valid_until: validUntil,
      }
    case 'BILLING_ISSUE':
      // Apple's billing retry window. Still entitled during grace.
      return {
        tier: 'ai_coach',
        status: 'in_grace',
        product_id: productId,
        entitlement_id: entitlementId,
        platform,
        valid_until: validUntil,
      }
    case 'EXPIRATION':
      // Subscription has ended. Flip back to free.
      return {
        tier: 'free',
        status: 'expired',
        product_id: null,
        entitlement_id: null,
        platform,
        valid_until: null,
      }
    case 'SUBSCRIBER_ALIAS':
    case 'TRANSFER':
    case 'TEST':
      // Informational / handled separately. Acknowledge with 200 so RevenueCat
      // doesn't retry, but make no row change.
      return null
    default:
      // Unknown event type — log + ack. Returning null avoids accidental writes.
      console.warn(`[revenuecat-webhook] unhandled event type: ${event.type}`)
      return null
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405)

  try {
    // ── Auth ─────────────────────────────────────────────────────────────────
    const expected = Deno.env.get('REVENUECAT_WEBHOOK_AUTH')
    if (!expected) {
      console.error('[revenuecat-webhook] REVENUECAT_WEBHOOK_AUTH env var not set')
      return jsonResponse({ error: 'server_misconfigured' }, 500)
    }
    const provided = req.headers.get('Authorization') ?? ''
    if (provided !== expected) {
      console.warn(`[revenuecat-webhook] auth mismatch (provided=${provided.slice(0, 12)}…)`)
      return jsonResponse({ error: 'unauthorized' }, 401)
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    let body: RevenueCatWebhookBody
    try {
      body = await req.json()
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400)
    }
    const event = body.event
    if (!event || !event.id || !event.type || !event.app_user_id) {
      return jsonResponse({ error: 'invalid_event' }, 400)
    }

    // ── Service-role DB client ────────────────────────────────────────────────
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // ── Dedup: ignore retries of an event we've already applied ──────────────
    const { data: existing } = await supabaseAdmin
      .from('subscription_active')
      .select('last_event_id')
      .eq('user_id', event.app_user_id)
      .maybeSingle()
    if (existing?.last_event_id === event.id) {
      console.log(`[revenuecat-webhook] duplicate event ${event.id} for user ${event.app_user_id.slice(0, 8)} — ignored`)
      return jsonResponse({ ok: true, deduped: true }, 200)
    }

    // ── Derive row shape from event ──────────────────────────────────────────
    const row = deriveRowFromEvent(event)
    if (!row) {
      // Informational event — ack but don't write.
      return jsonResponse({ ok: true, noop: true }, 200)
    }

    // ── Upsert ───────────────────────────────────────────────────────────────
    const { error: upsertErr } = await supabaseAdmin
      .from('subscription_active')
      .upsert({
        user_id: event.app_user_id,
        tier: row.tier,
        status: row.status,
        product_id: row.product_id,
        entitlement_id: row.entitlement_id,
        platform: row.platform,
        valid_until: row.valid_until,
        last_event_id: event.id,
        updated_at: new Date().toISOString(),
      })

    if (upsertErr) {
      console.error(`[revenuecat-webhook] upsert failed: ${upsertErr.message}`)
      // Return 500 so RevenueCat retries — the row write is the entire job.
      return jsonResponse({ error: 'db_write_failed' }, 500)
    }

    console.log(`[revenuecat-webhook] ${event.type} user=${event.app_user_id.slice(0, 8)} tier=${row.tier} status=${row.status}`)
    return jsonResponse({ ok: true }, 200)
  } catch (err) {
    console.error('[revenuecat-webhook] unhandled error:', (err as Error).message)
    return jsonResponse({ error: 'internal_error' }, 500)
  }
})
