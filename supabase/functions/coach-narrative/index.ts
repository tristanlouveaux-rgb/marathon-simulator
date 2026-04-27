/**
 * coach-narrative — Supabase Edge Function (hardened, LLM-first)
 * ==============================================================
 * Accepts a compact `CoachNarrativePayload` and returns a 3-sentence coaching
 * note in the form: Verdict / Why / Action. The rules engine is the authority
 * (it already set `stance`) — this function only explains and prescribes.
 *
 * Security layers (unchanged from previous version):
 *   1. JWT authentication (Supabase auth)
 *   2. Per-user rate limiting (3 calls/day, server-enforced)
 *   3. Global daily spend cap ($10/day circuit breaker)
 *   4. Input validation (field allowlist, string truncation)
 *   5. 3-second timeout on Anthropic API call
 *   6. Restricted CORS (app origins only)
 *   7. No prompt/response content in logs
 *
 * New in 2026-04-17:
 *   • Signal-hash skip: identical canonical payload within 24h returns the
 *     stored narrative WITHOUT calling Anthropic and WITHOUT incrementing the
 *     per-user quota (it wasn't a real call).
 *   • `max_tokens` raised to 400 so the LLM can actually fit Verdict / Why /
 *     Action without being cut off.
 *   • Enriched payload: today's workout title + description + planned TSS +
 *     duration are passed so the Action sentence can be concrete.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MAX_CALLS_PER_DAY = 3
const DAILY_SPEND_CAP_CENTS = 1000       // $10/day
const ANTHROPIC_TIMEOUT_MS = 3000        // 3 seconds
const MAX_PAYLOAD_BYTES = 4000           // reject oversized requests
const MAX_STRING_LENGTH = 100            // truncate any string field
const SIGNAL_HASH_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// ─── CORS (restricted — not open to the world) ──────────────────────────────

const ALLOWED_ORIGINS = [
  'http://localhost',
  'http://localhost:5173',
  'capacitor://localhost',
  'http://localhost',
]

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o))
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function jsonResponse(body: Record<string, unknown>, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

/** Truncate a string and strip newlines (prevents prompt injection via string fields) */
function sanitiseString(val: unknown, maxLen = MAX_STRING_LENGTH): string | null {
  if (typeof val !== 'string') return null
  return val.replace(/[\n\r]/g, ' ').slice(0, maxLen).trim() || null
}

/**
 * Field-allowlisted sanitisation of the enriched payload. Shape matches
 * `CoachNarrativePayload` in src/calculations/daily-coach.ts. Unknown fields
 * are dropped.
 */
function sanitisePayload(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : null)
  const str = (v: unknown, len = MAX_STRING_LENGTH) => sanitiseString(v, len)

  out.stance = str(raw.stance, 16)
  out.readinessScore = num(raw.readinessScore)
  out.readinessLabel = str(raw.readinessLabel, 32)
  out.freshness = num(raw.freshness)
  out.loadSafety = num(raw.loadSafety)
  out.sleepLastNight = num(raw.sleepLastNight)
  out.sleep7dAvg = num(raw.sleep7dAvg)
  out.sleepBankHours = num(raw.sleepBankHours)
  out.hrvMs = num(raw.hrvMs)
  out.hrvPctVsBaseline = num(raw.hrvPctVsBaseline)
  out.weekTss = num(raw.weekTss)
  out.weekTssPlan = num(raw.weekTssPlan)
  out.weekTssPct = num(raw.weekTssPct)
  out.todayFeeling = str(raw.todayFeeling, 16)
  out.phase = str(raw.phase, 16)
  out.primaryMessageFallback = str(raw.primaryMessageFallback, 280)

  if (raw.injury && typeof raw.injury === 'object') {
    const inj = raw.injury as Record<string, unknown>
    out.injury = {
      bodyPart: str(inj.bodyPart, 40),
      severity: str(inj.severity, 16),
    }
  } else {
    out.injury = null
  }

  if (raw.illness && typeof raw.illness === 'object') {
    const ill = raw.illness as Record<string, unknown>
    out.illness = { severity: str(ill.severity, 16) }
  } else {
    out.illness = null
  }

  if (raw.todayWorkout && typeof raw.todayWorkout === 'object') {
    const w = raw.todayWorkout as Record<string, unknown>
    out.todayWorkout = {
      title: str(w.title, 60),
      description: str(w.description, 90),
      plannedTss: num(w.plannedTss),
      plannedDurationMin: num(w.plannedDurationMin),
    }
  } else {
    out.todayWorkout = null
  }

  return out
}

/**
 * Canonicalise the sanitised payload with sorted keys and compute a SHA-256
 * hex digest. Used for the 24h signal-hash skip — identical signals serve
 * cache without an Anthropic call.
 */
async function canonicalHash(obj: Record<string, unknown>): Promise<string> {
  const canonicalise = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(canonicalise)
    const keys = Object.keys(v as Record<string, unknown>).sort()
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = canonicalise((v as Record<string, unknown>)[k])
    return out
  }
  const json = JSON.stringify(canonicalise(obj))
  const buf = new TextEncoder().encode(json)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Haiku pricing: input $1.00/MTok = 0.0001 cents/token. Output $5.00/MTok = 0.0005 cents/token.
function estimateCostCents(inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * 0.0001 + outputTokens * 0.0005)
}

// ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────
//
// Three-part structure enforced: Verdict / Why / Action. Plain text only.
// The rules engine is the authority — the LLM narrates.

const SYSTEM_PROMPT = `You are a direct, concise running coach. The training decision is already made by a rules engine and is passed to you as "stance". Your job is to explain that decision and prescribe a concrete action for today. You do not override the stance.

Write exactly three sentences in this order:

1. VERDICT. One sentence. What today is. Use only the supplied readiness vocabulary: "Ready to Push", "On Track", "Manage Load", "Ease Back". Do not invent new stance words.
2. WHY. One sentence. Name the 1 or 2 signals that drive the verdict. Connect them (for example: "HRV 14% above baseline and sleep bank positive, recovery signals agree."). Do not list every signal. If the signals are unremarkable and the stance is normal, say that directly.
3. ACTION. One sentence. A concrete instruction for today, grounded in the planned workout. Example: "Keep threshold 5x5 as planned, start the first rep 10 sec/km slower than target." If there is no planned workout, prescribe the appropriate easy or rest default for the stance.

Hard rules:
- Output plain text only. No markdown. No headers. No bullet lists. No labels like "Verdict:" or "Why:".
- No em dashes. Use periods, commas, or the word "to" in ranges (for example "2 to 3 weeks").
- No emoji.
- Never say "listen to your body", "recovery is where the magic happens", "trust the process", "your body needs", or any motivational filler.
- No medical advice. No technique or form advice. No equipment advice. No nutrition or supplement advice. Stick to training load, intensity modulation, and session timing only.
- If all signals look fine and the stance is normal, state that directly. Do not manufacture concern.
- If injury or illness is active, the Action sentence is about rest or symptom resolution, not training.
- Never begin the output with "You". Use short sentences, active voice.

How to interpret the inputs:
- stance: the rules-engine decision. Always reflect it in Verdict.
- readinessScore (0 to 100): weighted composite. Label bands: 80+ "Ready to Push", 60 to 79 "On Track", 40 to 59 "Manage Load", under 40 "Ease Back".
- freshness: TSB daily-equivalent. Positive is fresh, negative to -10 is recovering, -10 to -25 is fatigued, below -25 is overtrained.
- loadSafety: ACWR. Tier-dependent. Above 1.5 is a genuine load spike.
- hrvPctVsBaseline: percent above or below personal 28-day baseline. Below -15 is suppressed, above +10 is elevated recovery.
- sleepBankHours: positive is surplus, negative is debt. Below -5 is heavy debt.
- weekTssPct: percent of planned weekly training stress completed.
- todayFeeling: the athlete's self-reported wellness tap for today. "struggling" is a red flag even if numbers look fine.
- todayWorkout: what is scheduled. Use its title and description to write the Action sentence precisely.`

// ─── USER-PROMPT BUILDER ────────────────────────────────────────────────────

function buildUserPrompt(p: Record<string, unknown>): string {
  const lines: string[] = []

  lines.push(`STANCE: ${p.stance ?? 'normal'}`)
  lines.push(`Readiness: ${p.readinessScore ?? '?'}/100 (${p.readinessLabel ?? '?'}).`)
  lines.push(`Phase: ${p.phase ?? '?'}.`)

  if (p.injury) {
    const inj = p.injury as Record<string, unknown>
    lines.push(`Injury active: ${inj.bodyPart ?? 'unspecified'} (${inj.severity ?? 'active'}).`)
  }
  if (p.illness) {
    const ill = p.illness as Record<string, unknown>
    lines.push(`Illness active: severity ${ill.severity ?? 'light'}.`)
  }
  if (p.todayFeeling) lines.push(`Today's feeling (self-report): ${p.todayFeeling}.`)

  if (p.freshness != null) lines.push(`Freshness (TSB, daily): ${p.freshness}.`)
  if (p.loadSafety != null) lines.push(`Load safety (ACWR): ${p.loadSafety}.`)

  if (p.sleepLastNight != null) lines.push(`Sleep last night: ${p.sleepLastNight}/100.`)
  if (p.sleep7dAvg != null) lines.push(`Sleep 7d avg: ${p.sleep7dAvg}/100.`)
  if (p.sleepBankHours != null) {
    const n = p.sleepBankHours as number
    lines.push(`Sleep bank: ${n >= 0 ? '+' : ''}${n}h.`)
  }
  if (p.hrvMs != null) lines.push(`HRV: ${p.hrvMs}ms.`)
  if (p.hrvPctVsBaseline != null) lines.push(`HRV vs baseline: ${p.hrvPctVsBaseline}%.`)

  if (p.weekTss != null && p.weekTssPlan != null) {
    lines.push(`This week: ${p.weekTss} of ${p.weekTssPlan} TSS (${p.weekTssPct ?? '?'}%).`)
  }

  if (p.todayWorkout) {
    const w = p.todayWorkout as Record<string, unknown>
    const bits: string[] = []
    if (w.title) bits.push(String(w.title))
    if (w.description) bits.push(String(w.description))
    if (w.plannedDurationMin != null) bits.push(`${w.plannedDurationMin} min`)
    if (w.plannedTss != null) bits.push(`${w.plannedTss} TSS`)
    lines.push(`Today's planned workout: ${bits.join(' | ')}.`)
  } else {
    lines.push(`Today's planned workout: rest day.`)
  }

  lines.push('')
  lines.push('Write the three-sentence response now (Verdict, Why, Action):')
  return lines.join('\n')
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req)

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) {
      console.error('[coach-narrative] ANTHROPIC_API_KEY not configured')
      return jsonResponse({ error: 'service_unavailable' }, 500, cors)
    }

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

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // ── Parse + validate input first so we can hash before checking quotas ──
    const rawBody = await req.text()
    if (rawBody.length > MAX_PAYLOAD_BYTES) {
      return jsonResponse({ error: 'payload_too_large' }, 413, cors)
    }

    let rawPayload: Record<string, unknown>
    try {
      rawPayload = JSON.parse(rawBody)
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400, cors)
    }
    if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
      return jsonResponse({ error: 'invalid_payload' }, 400, cors)
    }

    const payload = sanitisePayload(rawPayload)
    const signalsHash = await canonicalHash(payload)

    // ── Signal-hash skip: identical signals → serve cache, burn zero tokens ──
    const { data: cacheRow } = await supabaseAdmin
      .from('coach_narrative_cache')
      .select('signals_hash, narrative, created_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (cacheRow
        && cacheRow.signals_hash === signalsHash
        && cacheRow.narrative
        && (Date.now() - new Date(cacheRow.created_at).getTime()) < SIGNAL_HASH_TTL_MS) {
      console.log(`[coach-narrative] Cache hit (hash) user=${userId.slice(0, 8)}`)
      return jsonResponse({ narrative: cacheRow.narrative, cached: true }, 200, cors)
    }

    // ── Per-user daily rate limit ────────────────────────────────────────
    const today = new Date().toISOString().split('T')[0]

    const { data: usageRow } = await supabaseAdmin
      .from('coach_narrative_usage')
      .select('call_count')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle()

    const currentCount = usageRow?.call_count ?? 0
    if (currentCount >= MAX_CALLS_PER_DAY) {
      console.log(`[coach-narrative] Rate limited user=${userId.slice(0, 8)} (${currentCount} calls)`)
      // Serve stale cache if present.
      return jsonResponse({
        error: 'rate_limited',
        message: 'Daily coaching insights limit reached. Check back tomorrow.',
        narrative: cacheRow?.narrative ?? null,
        callsUsed: currentCount,
        callsMax: MAX_CALLS_PER_DAY,
      }, 429, cors)
    }

    // ── Global spend cap ──────────────────────────────────────────────────
    const { data: spendRow } = await supabaseAdmin
      .from('llm_spend_tracker')
      .select('estimated_cost_cents')
      .eq('date', today)
      .maybeSingle()

    if ((spendRow?.estimated_cost_cents ?? 0) >= DAILY_SPEND_CAP_CENTS) {
      console.warn(`[coach-narrative] Global spend cap reached (${spendRow?.estimated_cost_cents}c)`)
      return jsonResponse({
        error: 'service_busy',
        narrative: cacheRow?.narrative ?? null,
      }, 503, cors)
    }

    const userPrompt = buildUserPrompt(payload)

    // ── Call Anthropic with timeout ──────────────────────────────────────
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS)

    let anthropicResponse: Response
    try {
      anthropicResponse = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      const isTimeout = (err as Error).name === 'AbortError'
      console.error(`[coach-narrative] Anthropic ${isTimeout ? 'timeout' : 'fetch error'}`)
      return jsonResponse({
        error: 'llm_unavailable',
        narrative: cacheRow?.narrative ?? null,
      }, 504, cors)
    }
    clearTimeout(timeout)

    if (!anthropicResponse.ok) {
      console.error(`[coach-narrative] Anthropic returned ${anthropicResponse.status}`)
      return jsonResponse({
        error: 'llm_error',
        narrative: cacheRow?.narrative ?? null,
      }, 502, cors)
    }

    const data = await anthropicResponse.json()
    const narrative = String(data.content?.[0]?.text ?? '').trim()
    const inputTokens = data.usage?.input_tokens ?? 0
    const outputTokens = data.usage?.output_tokens ?? 0
    const costCents = estimateCostCents(inputTokens, outputTokens)

    // ── Persist narrative + hash for next call's skip check ───────────────
    supabaseAdmin
      .from('coach_narrative_cache')
      .upsert({
        user_id: userId,
        signals_hash: signalsHash,
        narrative,
        created_at: new Date().toISOString(),
      })
      .then(({ error }) => {
        if (error) console.error('[coach-narrative] cache upsert failed:', error.message)
      })

    supabaseAdmin
      .rpc('increment_narrative_usage', { p_user_id: userId, p_date: today })
      .then(({ error }) => {
        if (error) console.error('[coach-narrative] usage rpc failed:', error.message)
      })

    supabaseAdmin
      .rpc('increment_spend_tracker', {
        p_date: today,
        p_input_tokens: inputTokens,
        p_output_tokens: outputTokens,
        p_cost_cents: costCents,
      })
      .then(({ error }) => {
        if (error) console.error('[coach-narrative] spend rpc failed:', error.message)
      })

    console.log(`[coach-narrative] OK user=${userId.slice(0, 8)} in=${inputTokens} out=${outputTokens} cost=${costCents}c`)

    return jsonResponse({
      narrative,
      callsUsed: currentCount + 1,
      callsMax: MAX_CALLS_PER_DAY,
    }, 200, cors)

  } catch (err) {
    console.error('[coach-narrative] Unhandled error:', (err as Error).message)
    return jsonResponse({ error: 'internal_error' }, 500, getCorsHeaders(req))
  }
})
