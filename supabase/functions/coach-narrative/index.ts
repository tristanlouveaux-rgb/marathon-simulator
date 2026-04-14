/**
 * coach-narrative — Supabase Edge Function (hardened)
 * ====================================================
 * Accepts structured CoachSignals, calls Claude Haiku, returns a 2-3 sentence
 * coaching paragraph in the direct, factual tone used throughout the app.
 *
 * Security layers:
 *   1. JWT authentication (Supabase auth)
 *   2. Per-user rate limiting (3 calls/day, server-enforced)
 *   3. Global daily spend cap ($10/day circuit breaker)
 *   4. Input validation (field allowlist, string truncation)
 *   5. 3-second timeout on Anthropic API call
 *   6. Restricted CORS (app origins only)
 *   7. No prompt/response content in logs
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MAX_CALLS_PER_DAY = 3
const DAILY_SPEND_CAP_CENTS = 1000 // $10/day
const ANTHROPIC_TIMEOUT_MS = 3000  // 3 seconds
const MAX_PAYLOAD_BYTES = 4000     // reject oversized requests
const MAX_STRING_LENGTH = 100      // truncate any string field

// ─── CORS (restricted — not open to the world) ──────────────────────────────

const ALLOWED_ORIGINS = [
  'http://localhost',         // Vite dev server
  'http://localhost:5173',
  'capacitor://localhost',    // iOS Capacitor
  'http://localhost',         // Android Capacitor
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
function sanitiseString(val: unknown): string | null {
  if (typeof val !== 'string') return null
  return val.replace(/[\n\r]/g, ' ').slice(0, MAX_STRING_LENGTH).trim() || null
}

/** Only extract known, expected fields. Everything else is dropped. */
function sanitiseSignals(raw: Record<string, unknown>): Record<string, unknown> {
  // Numeric fields — pass through if they're numbers, drop otherwise
  const numericKeys = [
    'readinessScore', 'tsb', 'ctlNow', 'acwr', 'acwrSafeUpper',
    'sleepLastNight', 'sleepAvg7d', 'hrv', 'hrvBaseline', 'sleepBankHours',
    'weekTSS', 'plannedTSS', 'weekNumber', 'totalWeeks', 'recoveryScore',
  ]
  // String fields — sanitise and truncate
  const stringKeys = [
    'readinessLabel', 'readinessSentence', 'tsbZone', 'ctlTrend', 'acwrStatus',
    'weekRPE', 'hrDrift', 'phase', 'todayWorkoutName', 'todayWorkoutType',
    'injuryLocation', 'illnessSeverity', 'athleteTier',
  ]
  // Boolean fields
  const boolKeys = ['injuryActive', 'illnessActive']

  const clean: Record<string, unknown> = {}

  for (const k of numericKeys) {
    if (typeof raw[k] === 'number' && isFinite(raw[k] as number)) {
      clean[k] = raw[k]
    }
  }
  for (const k of stringKeys) {
    const v = sanitiseString(raw[k])
    if (v) clean[k] = v
  }
  for (const k of boolKeys) {
    if (typeof raw[k] === 'boolean') clean[k] = raw[k]
  }

  return clean
}

// Haiku pricing (per token, in cents) — used for spend tracking
// Input: $1.00/MTok = 0.0001 cents/token. Output: $5.00/MTok = 0.0005 cents/token.
function estimateCostCents(inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * 0.0001 + outputTokens * 0.0005)
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req)

  // ── Preflight ──────────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  try {
    // ── 1. Check API key exists ────────────────────────────────────────────
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) {
      console.error('[coach-narrative] ANTHROPIC_API_KEY not configured')
      return jsonResponse({ error: 'service_unavailable' }, 500, cors)
    }

    // ── 2. Authenticate user (JWT verification) ────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return jsonResponse({ error: 'unauthorized' }, 401, cors)
    }

    // User-scoped client (respects RLS — can only read user's own rows)
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authErr } = await supabaseUser.auth.getUser()
    if (authErr || !user) {
      return jsonResponse({ error: 'unauthorized' }, 401, cors)
    }
    const userId = user.id

    // Service-role client (bypasses RLS — for writing to rate limit / spend tables)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // ── 3. Per-user rate limit (3 calls/day) ───────────────────────────────
    const today = new Date().toISOString().split('T')[0]

    const { data: usageRow } = await supabaseAdmin
      .from('coach_narrative_usage')
      .select('call_count')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle()

    const currentCount = usageRow?.call_count ?? 0

    if (currentCount >= MAX_CALLS_PER_DAY) {
      console.log(`[coach-narrative] Rate limited: user ${userId.slice(0, 8)} (${currentCount} calls today)`)
      return jsonResponse({
        error: 'rate_limited',
        message: 'Daily coaching insights limit reached. Check back tomorrow.',
        callsUsed: currentCount,
        callsMax: MAX_CALLS_PER_DAY,
      }, 429, cors)
    }

    // ── 4. Global spend cap (circuit breaker) ──────────────────────────────
    const { data: spendRow } = await supabaseAdmin
      .from('llm_spend_tracker')
      .select('estimated_cost_cents')
      .eq('date', today)
      .maybeSingle()

    if ((spendRow?.estimated_cost_cents ?? 0) >= DAILY_SPEND_CAP_CENTS) {
      console.warn(`[coach-narrative] Global spend cap reached (${spendRow?.estimated_cost_cents}c)`)
      return jsonResponse({
        error: 'service_busy',
        message: 'Coach insights are temporarily unavailable. Try again later.',
      }, 503, cors)
    }

    // ── 5. Parse + validate input ──────────────────────────────────────────
    const rawBody = await req.text()

    if (rawBody.length > MAX_PAYLOAD_BYTES) {
      return jsonResponse({ error: 'payload_too_large' }, 413, cors)
    }

    let rawSignals: Record<string, unknown>
    try {
      rawSignals = JSON.parse(rawBody)
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400, cors)
    }

    if (typeof rawSignals !== 'object' || rawSignals === null || Array.isArray(rawSignals)) {
      return jsonResponse({ error: 'invalid_payload' }, 400, cors)
    }

    const signals = sanitiseSignals(rawSignals)

    // ── 6. Build prompt ────────────────────────────────────────────────────
    const systemPrompt = `You are a concise, factual running coach. You write in a direct, no-nonsense style.

How the numbers you receive are computed:

READINESS SCORE (0-100): Weighted composite. With wearable data: freshness 35% + load safety 30% + recovery 35%. Without: freshness 55% + safety 45%. Hard floors override the composite: sleep < 45 caps at 59, ACWR above caution threshold caps at 59, HRV drop > 30% caps at 59, sleep bank deficit > 2.5h caps at 59.
Labels: >= 80 "Ready to Push", 60-79 "On Track", 40-59 "Manage Load", < 40 "Ease Back".

TSB (Training Stress Balance = CTL - ATL): Reported as a WEEKLY value. Divide by 7 for daily-equivalent. Daily TSB of -2 is actually quite fresh. Daily > 0 = fresh, -10 to 0 = recovering, -25 to -10 = fatigued, < -25 = overtrained.

ACWR (Acute:Chronic Workload Ratio): 7-day load / 28-day weekly average. Safe thresholds are tier-dependent: beginner safe <= 1.2, trained <= 1.4, elite <= 1.6. Caution = safe + 0.2. "caution" status means approaching the limit for this athlete's tier, not necessarily dangerous. "high" means genuine overreaching risk.

RECOVERY SCORE (sleep + HRV, RHR override): Composite of HRV (55%) and Sleep (45%). HRV scored via z-score against 28-day personal baseline (not absolute value). A 42ms HRV is fine if baseline is 44ms but concerning if baseline is 60ms. Sleep uses device score directly. RHR is NOT a weighted input — it acts as a hard floor when elevated >= 2 SD above personal baseline (caps score at 55 for 2 SD, 40 for 2.5 SD, 25 for 3+ SD). If recovery score seems capped despite good HRV and sleep, RHR elevation is likely the cause.

SLEEP BANK: Rolling 7-night surplus/deficit vs personal sleep need (65th percentile of recent history, load-adjusted). Negative = accumulated debt.

CTL TREND: Direction of chronic training load (42-day EMA). "rising" = building fitness, "falling" = detraining or taper, "stable" = maintenance.

WEEK TSS vs PLANNED TSS: Percentage of planned weekly training stress completed so far. > 100% means overshot. < 50% midweek is normal if key sessions are later.

Rules for your response:
- Exactly 2-3 sentences. No more.
- Lead with the most important signal. State the fact, then the implication.
- Never start with "You". Never use "your body". Never use motivational filler.
- No emoji. No em-dashes. Short sentences. Active voice.
- Inline-bold key numbers using **bold** markdown.
- Reference the specific training context (phase, today's workout, week in plan).
- If injury or illness is active, focus entirely on recovery — do not mention training load.
- Never recommend medical treatment, medication, or diagnose conditions.
- When interpreting TSB, always divide the reported value by 7 to get the daily-equivalent before judging freshness.
- When interpreting ACWR, consider the athlete's tier — 1.35 is caution for a beginner but safe for a trained athlete.`

    const userPrompt = buildUserPrompt(signals)

    // ── 7. Call Anthropic with timeout ──────────────────────────────────────
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
          max_tokens: 200,
          system: systemPrompt,
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
        message: 'Coach insights temporarily unavailable.',
      }, 504, cors)
    }
    clearTimeout(timeout)

    if (!anthropicResponse.ok) {
      // Log status but NOT the response body (may contain sensitive info)
      console.error(`[coach-narrative] Anthropic returned ${anthropicResponse.status}`)
      return jsonResponse({
        error: 'llm_error',
        message: 'Coach insights temporarily unavailable.',
      }, 502, cors)
    }

    const data = await anthropicResponse.json()
    const narrative = data.content?.[0]?.text ?? ''
    const inputTokens = data.usage?.input_tokens ?? 0
    const outputTokens = data.usage?.output_tokens ?? 0

    // ── 8. Record usage (rate limit + spend tracking) ───────────────────────
    // These are fire-and-forget — don't block the response on DB writes.
    // If they fail, the user still gets their narrative. Next call will
    // re-check and the counts will be slightly behind (safe direction).

    const costCents = estimateCostCents(inputTokens, outputTokens)

    // Increment per-user counter
    supabaseAdmin
      .rpc('increment_narrative_usage', { p_user_id: userId, p_date: today })
      .then(({ error }) => {
        if (error) console.error('[coach-narrative] Failed to increment user usage:', error.message)
      })

    // Increment global spend
    supabaseAdmin
      .rpc('increment_spend_tracker', {
        p_date: today,
        p_input_tokens: inputTokens,
        p_output_tokens: outputTokens,
        p_cost_cents: costCents,
      })
      .then(({ error }) => {
        if (error) console.error('[coach-narrative] Failed to increment spend tracker:', error.message)
      })

    // ── 9. Return narrative ─────────────────────────────────────────────────
    // Log only: truncated user ID, token counts, cost. Never the narrative text.
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

// ─── PROMPT BUILDER ──────────────────────────────────────────────────────────

function buildUserPrompt(s: Record<string, unknown>): string {
  const lines: string[] = []

  if (s.injuryActive) {
    lines.push(`STATUS: Injury active — location: ${s.injuryLocation ?? 'unspecified'}.`)
  }
  if (s.illnessActive) {
    lines.push(`STATUS: Illness active — severity: ${s.illnessSeverity ?? 'unknown'}.`)
  }

  lines.push(`Plan context: Week ${s.weekNumber ?? '?'} of ${s.totalWeeks ?? '?'}, phase: ${s.phase ?? 'unknown'}. Athlete tier: ${s.athleteTier ?? 'unknown'}.`)
  if (s.todayWorkoutName) {
    lines.push(`Today's planned workout: ${s.todayWorkoutName}${s.todayWorkoutType ? ` (${s.todayWorkoutType})` : ''}.`)
  }

  lines.push(`Readiness: ${s.readinessScore ?? '?'}/100 (${s.readinessLabel ?? '?'}). ${s.readinessSentence ?? ''}`)
  lines.push(`Freshness: ${s.tsbZone ?? '?'} (TSB ${typeof s.tsb === 'number' && s.tsb > 0 ? '+' : ''}${s.tsb ?? '?'}). Fitness trend: ${s.ctlTrend ?? '?'}.`)
  lines.push(`Load safety (ACWR): ${s.acwr ?? '?'} — ${s.acwrStatus ?? '?'}${s.acwrSafeUpper != null ? ` (safe threshold for this tier: ${s.acwrSafeUpper})` : ''}.`)

  if (s.sleepLastNight != null) lines.push(`Sleep last night: ${s.sleepLastNight}/100.`)
  if (s.sleepAvg7d != null) lines.push(`7-day sleep average: ${s.sleepAvg7d}/100.`)
  if (s.hrv != null) {
    const vs = s.hrvBaseline != null ? ` vs baseline ${s.hrvBaseline}ms` : ''
    lines.push(`HRV: ${s.hrv}ms${vs}.`)
  }
  if (s.sleepBankHours != null) {
    const dir = (s.sleepBankHours as number) < 0 ? 'deficit' : 'surplus'
    lines.push(`7-day sleep bank: ${Math.abs(s.sleepBankHours as number)}h ${dir}.`)
  }

  if (s.weekTSS != null && s.plannedTSS != null) {
    const pct = Math.round(((s.weekTSS as number) / (s.plannedTSS as number)) * 100)
    lines.push(`This week's load: ${s.weekTSS} TSS (${pct}% of the planned ${s.plannedTSS} TSS).`)
  }
  if (s.recoveryScore != null) lines.push(`Recovery score: ${s.recoveryScore}/100 (composite of HRV, sleep, RHR vs personal baselines).`)
  if (s.weekRPE) lines.push(`Workout effort this week: ${s.weekRPE}.`)
  if (s.hrDrift) lines.push(`Aerobic efficiency: ${s.hrDrift}.`)

  lines.push('\nWrite the coaching paragraph now (2-3 sentences, direct, no filler):')
  return lines.join('\n')
}
