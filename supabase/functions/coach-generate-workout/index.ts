/**
 * coach-generate-workout — Supabase Edge Function
 * ================================================
 * Premium AI Coach surface for On-Demand mode. Reads recent training context
 * and a free-text intent, returns a structured workout proposal plus a short
 * "why this session today" narrative.
 *
 * Output is produced via Anthropic tool_use so the response is a typed JSON
 * object the client can feed straight into `intentToWorkout()` — the same
 * pipeline the free rule-based generator uses. Schema matches `SessionIntent`
 * in `src/workouts/intent_to_workout.ts`.
 *
 * Security mirrors `coach-narrative`:
 *   1. JWT auth
 *   2. Premium entitlement check (subscription_active row)
 *   3. Per-user rate limit (5/day — slightly higher than narrative because
 *      users may re-roll a proposal)
 *   4. Global daily spend cap (shared llm_spend_tracker)
 *   5. Input validation (allowlist, string truncation)
 *   6. 5s Anthropic timeout (tool_use round-trip is slower than plain text)
 *   7. Restricted CORS
 *
 * V1 scope: running sessions only (slots match SESSION_TYPES in
 * src/ui/session-generator.ts). Strength sessions deliberately excluded —
 * the strength-detail schema is owned by a parallel workstream. When that
 * lands, add a second tool variant with the exercise array shape.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MAX_CALLS_PER_DAY = 5
const DAILY_SPEND_CAP_CENTS = 1000        // $10/day shared cap
const ANTHROPIC_TIMEOUT_MS = 5000         // tool_use is slower than plain text
const MAX_PAYLOAD_BYTES = 6000            // recent-sessions array adds bulk
const MAX_STRING_LENGTH = 160             // intent text can be a short sentence
const RECENT_SESSIONS_MAX = 10            // last 10 sessions max

const ALLOWED_ORIGINS = [
  'capacitor://localhost',
  'https://mosaicrunning.run',
]

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function jsonResponse(body: Record<string, unknown>, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

function sanitiseString(val: unknown, maxLen = MAX_STRING_LENGTH): string | null {
  if (typeof val !== 'string') return null
  return val.replace(/[\n\r]/g, ' ').slice(0, maxLen).trim() || null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null
}

// Haiku pricing: input $1.00/MTok, output $5.00/MTok.
function estimateCostCents(inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * 0.0001 + outputTokens * 0.0005)
}

// ─── INPUT PAYLOAD ───────────────────────────────────────────────────────────

interface RecentSession {
  daysAgo: number
  type: string
  distanceKm: number | null
  durationMin: number | null
  perceivedEffort: number | null
}

function sanitisePayload(raw: Record<string, unknown>): {
  intent: string | null
  focus: string | null
  injuryNote: string | null
  preferredDurationMin: number | null
  vdot: number | null
  phase: string | null
  ctlWeekly: number | null
  tsbDaily: number | null
  acwr: number | null
  readinessScore: number | null
  weekTssActual: number | null
  weekTssTypical: number | null
  recentSessions: RecentSession[]
} {
  const recent = Array.isArray(raw.recentSessions) ? raw.recentSessions : []
  const recentSessions: RecentSession[] = recent
    .slice(0, RECENT_SESSIONS_MAX)
    .map((r: unknown) => {
      const row = (r as Record<string, unknown>) ?? {}
      return {
        daysAgo: num(row.daysAgo) ?? 0,
        type: sanitiseString(row.type, 24) ?? 'unknown',
        distanceKm: num(row.distanceKm),
        durationMin: num(row.durationMin),
        perceivedEffort: num(row.perceivedEffort),
      }
    })

  return {
    intent: sanitiseString(raw.intent),
    focus: sanitiseString(raw.focus, 16),
    injuryNote: sanitiseString(raw.injuryNote, 60),
    preferredDurationMin: num(raw.preferredDurationMin),
    vdot: num(raw.vdot),
    phase: sanitiseString(raw.phase, 16),
    ctlWeekly: num(raw.ctlWeekly),
    tsbDaily: num(raw.tsbDaily),
    acwr: num(raw.acwr),
    readinessScore: num(raw.readinessScore),
    weekTssActual: num(raw.weekTssActual),
    weekTssTypical: num(raw.weekTssTypical),
    recentSessions,
  }
}

// ─── ANTHROPIC TOOL DEFINITION ───────────────────────────────────────────────
// Force structured output. The model MUST call propose_workout; the result is
// a JSON object that maps 1:1 onto SessionIntent fields.

const TOOL_DEFINITION = {
  name: 'propose_workout',
  description: 'Propose a single running workout for the athlete to do today, with a short reasoning narrative explaining why this session fits their current context.',
  input_schema: {
    type: 'object',
    required: ['slot', 'totalMinutes', 'workMinutes', 'narrative', 'targetEffort'],
    properties: {
      slot: {
        type: 'string',
        enum: ['easy', 'long', 'threshold', 'vo2', 'marathon_pace', 'progressive', 'vibes'],
        description: 'Session type. easy = aerobic Z2. long = extended easy. threshold = LT intervals. vo2 = VO2max intervals. marathon_pace = sustained MP. progressive = easy-to-MP build. vibes = run-by-feel, no targets (use this when athlete is tired or wants flexibility).',
      },
      totalMinutes: {
        type: 'integer',
        minimum: 15,
        maximum: 180,
        description: 'Total session duration including warm-up and cool-down.',
      },
      workMinutes: {
        type: 'integer',
        minimum: 5,
        maximum: 180,
        description: 'Minutes of work effort within the session. For easy/long/vibes this equals totalMinutes. For intervals this is total time at target intensity.',
      },
      reps: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'Number of intervals. Only set for threshold or vo2 slots.',
      },
      repMinutes: {
        type: 'number',
        minimum: 0.5,
        maximum: 30,
        description: 'Minutes per interval rep. Only set for threshold or vo2 slots.',
      },
      recoveryMinutes: {
        type: 'number',
        minimum: 0.5,
        maximum: 10,
        description: 'Minutes of recovery between reps. Only set for threshold or vo2 slots.',
      },
      targetEffort: {
        type: 'string',
        enum: ['easy', 'steady', 'hard'],
        description: 'Overall effort target. easy = Z1-Z2. steady = Z3. hard = Z4-Z5.',
      },
      narrative: {
        type: 'string',
        maxLength: 320,
        description: 'Two to three short sentences. Explain why this session fits today. Reference specific signals from the context (recent sessions, freshness, recovery, stated intent). No motivational filler. No em dashes. Consultant tone.',
      },
    },
  },
}

// ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a direct running coach building one session for the athlete to do today. You receive their recent training, recovery state, and stated intent. You return a single structured workout via the propose_workout tool.

How to think about each input:
- intent: the athlete's free-text request. Treat this as the primary anchor. If they say "50 min hills", propose a 50-minute steady-to-hard session. If they say "feeling tired", lean towards easy or vibes.
- preferredDurationMin: their rough time budget. Match it within ±10 min unless the intent overrides.
- vdot: aerobic fitness. Use to size interval pace bands when proposing threshold or vo2.
- phase: where they are in their general training arc (base, build, peak, taper). On-Demand users may have no phase — fall back to "base" thinking.
- ctlWeekly: chronic load (training peaks daily-equivalent is ctlWeekly/7). Higher CTL = bigger sessions are appropriate.
- tsbDaily: form. Negative = fatigued, positive = fresh. Strongly negative (<-15) means easy or vibes only.
- acwr: load safety. >1.5 = recent spike; never propose hard intervals in this state.
- readinessScore (0-100): composite recovery signal. <50 = easy only. 50-79 = moderate intensity okay. 80+ = any intensity.
- weekTssActual vs weekTssTypical: where they are in the current week. If they're already at 110% of typical, lean lighter.
- recentSessions: last 10 sessions. Look for: back-to-back hard days (avoid another hard one), missing easy mileage (propose easy), repeated session types (vary it).
- injuryNote: if present, honour it. Never propose a session that would aggravate it. If the body part is incompatible with running (e.g. plantar fascia flare), propose vibes with a short conservative duration.

Output rules:
- Always call propose_workout. Never reply in plain text.
- One session only.
- The narrative is 2-3 sentences, consultant tone. Direct. Concrete. Reference real signals from the input. No "your body needs", no "trust the process", no motivational padding. No em dashes (use periods or commas instead). No emoji.
- Match the intent. If the athlete asked for hills and the data suggests easy, acknowledge the conflict in the narrative and either honour the intent with a softer prescription or propose vibes and explain why.
- For threshold or vo2 slots you MUST also set reps, repMinutes, and recoveryMinutes. For easy / long / progressive / marathon_pace / vibes, leave those fields unset.`

function buildUserPrompt(p: ReturnType<typeof sanitisePayload>): string {
  const lines: string[] = []

  lines.push(`Intent: ${p.intent ?? '(no specific intent — propose what fits)'}.`)
  if (p.preferredDurationMin != null) lines.push(`Preferred duration: ~${p.preferredDurationMin} min.`)
  if (p.focus) lines.push(`Focus hint: ${p.focus}.`)
  if (p.injuryNote) lines.push(`Injury / soreness note: ${p.injuryNote}.`)

  lines.push('')
  lines.push('CONTEXT:')
  if (p.vdot != null) lines.push(`- VDOT (aerobic fitness): ${p.vdot.toFixed(1)}.`)
  if (p.phase) lines.push(`- Training phase: ${p.phase}.`)
  if (p.ctlWeekly != null) lines.push(`- CTL (weekly): ${p.ctlWeekly.toFixed(0)} TSS  (daily-equivalent ${(p.ctlWeekly / 7).toFixed(0)}).`)
  if (p.tsbDaily != null) lines.push(`- TSB (daily form): ${p.tsbDaily.toFixed(1)}.`)
  if (p.acwr != null) lines.push(`- ACWR (load safety): ${p.acwr.toFixed(2)}.`)
  if (p.readinessScore != null) lines.push(`- Readiness: ${p.readinessScore}/100.`)
  if (p.weekTssActual != null && p.weekTssTypical != null) {
    const pct = p.weekTssTypical > 0 ? Math.round((p.weekTssActual / p.weekTssTypical) * 100) : null
    lines.push(`- This week: ${p.weekTssActual.toFixed(0)} TSS done, typical week is ${p.weekTssTypical.toFixed(0)}${pct != null ? ` (${pct}%)` : ''}.`)
  }

  if (p.recentSessions.length > 0) {
    lines.push('')
    lines.push('RECENT SESSIONS (most recent first):')
    for (const s of p.recentSessions) {
      const bits: string[] = [`${s.daysAgo}d ago`, s.type]
      if (s.distanceKm != null) bits.push(`${s.distanceKm.toFixed(1)}km`)
      if (s.durationMin != null) bits.push(`${Math.round(s.durationMin)}min`)
      if (s.perceivedEffort != null) bits.push(`RPE ${s.perceivedEffort}`)
      lines.push(`- ${bits.join(' · ')}`)
    }
  }

  lines.push('')
  lines.push('Propose a single workout via the propose_workout tool now.')
  return lines.join('\n')
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) {
      console.error('[coach-workout] ANTHROPIC_API_KEY not configured')
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

    // ── Premium entitlement gate ─────────────────────────────────────────
    const { data: sub } = await supabaseAdmin
      .from('subscription_active')
      .select('tier, status, valid_until')
      .eq('user_id', userId)
      .maybeSingle()

    const validUntilOk = !sub?.valid_until || new Date(sub.valid_until) > new Date()
    const entitled = !!sub
      && sub.tier !== 'free'
      && validUntilOk
      && (sub.status === 'active' || sub.status === 'in_trial' || sub.status === 'in_grace' || sub.status === 'cancelled')

    if (!entitled) {
      return jsonResponse({ error: 'subscription_required' }, 402, cors)
    }

    // ── Parse + validate input ────────────────────────────────────────────
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

    // ── Per-user daily rate limit ────────────────────────────────────────
    const today = new Date().toISOString().split('T')[0]

    const { data: usageRow } = await supabaseAdmin
      .from('coach_workout_usage')
      .select('call_count')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle()

    const currentCount = usageRow?.call_count ?? 0
    if (currentCount >= MAX_CALLS_PER_DAY) {
      return jsonResponse({
        error: 'rate_limited',
        message: `Daily limit reached (${MAX_CALLS_PER_DAY} workouts). Use the free Generate button or wait until tomorrow.`,
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
      console.warn(`[coach-workout] Global spend cap reached (${spendRow?.estimated_cost_cents}c)`)
      return jsonResponse({ error: 'service_busy' }, 503, cors)
    }

    const userPrompt = buildUserPrompt(payload)

    // ── Call Anthropic with tool_use forced output ────────────────────────
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
          max_tokens: 600,
          system: SYSTEM_PROMPT,
          tools: [TOOL_DEFINITION],
          tool_choice: { type: 'tool', name: 'propose_workout' },
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      const isTimeout = (err as Error).name === 'AbortError'
      console.error(`[coach-workout] Anthropic ${isTimeout ? 'timeout' : 'fetch error'}`)
      return jsonResponse({ error: 'llm_unavailable' }, 504, cors)
    }
    clearTimeout(timeout)

    if (!anthropicResponse.ok) {
      console.error(`[coach-workout] Anthropic returned ${anthropicResponse.status}`)
      return jsonResponse({ error: 'llm_error' }, 502, cors)
    }

    const data = await anthropicResponse.json()
    const inputTokens = data.usage?.input_tokens ?? 0
    const outputTokens = data.usage?.output_tokens ?? 0
    const costCents = estimateCostCents(inputTokens, outputTokens)

    // Extract the tool_use block.
    const toolBlock = Array.isArray(data.content)
      ? data.content.find((b: { type: string }) => b.type === 'tool_use')
      : null

    if (!toolBlock || toolBlock.name !== 'propose_workout' || !toolBlock.input) {
      console.error('[coach-workout] Missing or invalid tool_use block')
      return jsonResponse({ error: 'llm_invalid_response' }, 502, cors)
    }

    const proposal = toolBlock.input as Record<string, unknown>

    // ── Increment usage + spend tracker (fire-and-forget) ─────────────────
    supabaseAdmin.rpc('increment_workout_usage', { p_user_id: userId, p_date: today })
      .then(({ error }) => { if (error) console.error('[coach-workout] usage RPC failed:', error.message) })
    supabaseAdmin.rpc('increment_spend_tracker', {
      p_date: today,
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
      p_cost_cents: costCents,
    }).then(({ error }) => { if (error) console.error('[coach-workout] spend RPC failed:', error.message) })

    return jsonResponse({
      proposal,
      callsUsed: currentCount + 1,
      callsMax: MAX_CALLS_PER_DAY,
    }, 200, cors)
  } catch (err) {
    console.error('[coach-workout] unexpected error:', (err as Error).message)
    return jsonResponse({ error: 'internal_error' }, 500, cors)
  }
})
