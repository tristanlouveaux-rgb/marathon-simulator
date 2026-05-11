/**
 * coach-chat — Supabase Edge Function (BYOK, streaming, tool use)
 * ================================================================
 * Accepts a conversation payload and proxies to the Anthropic API using the
 * user's own API key (BYOK). The key is passed in the X-Anthropic-Key header,
 * used once per request, and never logged or stored.
 *
 * Security layers:
 *   1. JWT authentication (Supabase auth)
 *   2. Per-user rate limit: 30 calls/day (server-enforced via coach_chat_usage table)
 *   3. Payload size cap: 32KB
 *   4. Input sanitization: field-allowlisted messages, string truncation
 *   5. X-Anthropic-Key never appears in any console.log call
 *   6. Restricted CORS (app origins only)
 *   7. Streaming SSE response (text/event-stream)
 *   8. 30-second timeout on Anthropic call
 *
 * Key differences from coach-narrative:
 *   - Uses X-Anthropic-Key header (user's key) not Deno.env ANTHROPIC_API_KEY
 *   - Streaming response (not JSON)
 *   - Supports multi-turn conversation history
 *   - Supports tool use (workout modifications)
 *   - No global spend cap (user's key, user's cost)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_MODEL = 'claude-sonnet-4-6'
const MAX_CALLS_PER_DAY = 30
const ANTHROPIC_TIMEOUT_MS = 30_000
const MAX_PAYLOAD_BYTES = 32_768  // 32KB
const MAX_STRING_LENGTH = 200
const MAX_MESSAGES = 20           // client enforces too

// ─── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'http://localhost',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'capacitor://localhost',
]

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o))
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-anthropic-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

function sanitiseStr(val: unknown, maxLen = MAX_STRING_LENGTH): string | null {
  if (typeof val !== 'string') return null
  return val.replace(/[\n\r]/g, ' ').slice(0, maxLen).trim() || null
}

/** Validate and sanitize a messages array. Returns null on invalid shape. */
function sanitiseMessages(raw: unknown): Array<{ role: 'user' | 'assistant'; content: string }> | null {
  if (!Array.isArray(raw)) return null
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const item of raw.slice(0, MAX_MESSAGES)) {
    if (typeof item !== 'object' || item === null) continue
    const role = (item as any).role
    const content = sanitiseStr((item as any).content, 2000)
    if ((role !== 'user' && role !== 'assistant') || !content) continue
    out.push({ role, content })
  }
  // Must start with user message
  if (out.length === 0 || out[0].role !== 'user') return null
  return out
}

/** Validate tool definitions array (pass-through with basic type check). */
function sanitiseTools(raw: unknown): unknown[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > 10) return null  // reasonable max
  return raw
}

// ─── JSON response helper ─────────────────────────────────────────────────────

function jsonResponse(body: Record<string, unknown>, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req)

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405, cors)

  try {
    // ── Auth ─────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return jsonResponse({ error: 'unauthorized' }, 401, cors)

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: { user }, error: authErr } = await supabaseUser.auth.getUser()
    if (authErr || !user) return jsonResponse({ error: 'unauthorized' }, 401, cors)
    const userId = user.id

    // ── BYOK key (NEVER log this value) ──────────────────────────────────────
    const userApiKey = req.headers.get('X-Anthropic-Key')
    if (!userApiKey || !userApiKey.startsWith('sk-ant-')) {
      return jsonResponse({ error: 'missing_api_key', message: 'Provide your Anthropic API key in X-Anthropic-Key header.' }, 400, cors)
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    const rawBody = await req.text()
    if (rawBody.length > MAX_PAYLOAD_BYTES) {
      return jsonResponse({ error: 'payload_too_large' }, 413, cors)
    }

    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody)
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400, cors)
    }

    const messages = sanitiseMessages(body.messages)
    if (!messages) return jsonResponse({ error: 'invalid_messages' }, 400, cors)

    const systemPrompt = sanitiseStr(body.system_prompt, 8000)
    if (!systemPrompt) return jsonResponse({ error: 'missing_system_prompt' }, 400, cors)

    const tools = sanitiseTools(body.tools) ?? []
    const maxTokens = Math.min(
      typeof body.max_tokens === 'number' ? body.max_tokens : 1024,
      2048,
    )

    // ── Rate limit ───────────────────────────────────────────────────────────
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const today = new Date().toISOString().split('T')[0]

    const { data: usageRow } = await supabaseAdmin
      .from('coach_chat_usage')
      .select('call_count')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle()

    const currentCount = usageRow?.call_count ?? 0
    if (currentCount >= MAX_CALLS_PER_DAY) {
      console.log(`[coach-chat] Rate limited user=${userId.slice(0, 8)} (${currentCount} calls today)`)
      return jsonResponse({
        error: 'rate_limited',
        message: `Daily coaching limit reached (${MAX_CALLS_PER_DAY} sessions). Check back tomorrow.`,
      }, 429, cors)
    }

    // ── Call Anthropic with streaming ─────────────────────────────────────────
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS)

    const anthropicBody: Record<string, unknown> = {
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      stream: true,
    }

    if (tools.length > 0) {
      anthropicBody.tools = tools
    }

    let anthropicResponse: Response
    try {
      anthropicResponse = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          // SECURITY: userApiKey is used here and NEVER appears in any log
          'x-api-key': userApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(anthropicBody),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      const isTimeout = (err as Error).name === 'AbortError'
      console.error(`[coach-chat] Anthropic ${isTimeout ? 'timeout' : 'fetch error'} user=${userId.slice(0, 8)}`)
      return jsonResponse({ error: isTimeout ? 'timeout' : 'llm_unavailable' }, 504, cors)
    }
    clearTimeout(timeout)

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text().catch(() => '')
      // Strip any potential key echo from Anthropic error messages
      const safeErr = errText.replace(/sk-ant-[^\s"']*/g, '[key]')
      console.error(`[coach-chat] Anthropic error ${anthropicResponse.status} user=${userId.slice(0, 8)}: ${safeErr.slice(0, 200)}`)

      if (anthropicResponse.status === 401) {
        return jsonResponse({ error: 'invalid_api_key', message: 'Your Anthropic API key is invalid or expired.' }, 400, cors)
      }
      return jsonResponse({ error: 'llm_error' }, 502, cors)
    }

    // ── Increment usage (fire-and-forget) ─────────────────────────────────────
    supabaseAdmin
      .rpc('increment_coach_chat_usage', { p_user_id: userId, p_date: today })
      .then(({ error }) => {
        if (error) console.error('[coach-chat] usage rpc failed:', error.message)
      })

    console.log(`[coach-chat] streaming user=${userId.slice(0, 8)} msgs=${messages.length}`)

    // ── Pipe streaming response ────────────────────────────────────────────────
    // Pipe Anthropic's SSE stream directly to the client.
    return new Response(anthropicResponse.body, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    })

  } catch (err) {
    console.error('[coach-chat] Unhandled error:', (err as Error).message)
    return jsonResponse({ error: 'internal_error' }, 500, getCorsHeaders(req))
  }
})
