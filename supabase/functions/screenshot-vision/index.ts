/**
 * screenshot-vision — Supabase Edge Function (AI-vision fallback for imports)
 * ===========================================================================
 * The fallback engine of the hybrid screenshot-import path. On-device Apple
 * Vision OCR is the primary engine (free, private, iOS-only); when OCR
 * confidence is low or fields are missing — and always on web, which has no
 * native OCR — the client sends the screenshot here. A Claude vision model
 * reads the run summary and returns the `ParsedScreenshotActivity` JSON shape,
 * which the client maps via `parsedFromAIJson` in src/data/screenshotImport.ts.
 *
 * Two modes share the same auth + cap + transport plumbing:
 *   - `summary` (default): the full run-summary screenshot → activity fields.
 *     OCR runs first on iOS; this mode only fires when OCR is low confidence.
 *   - `hr_chart`: a screenshot of the HR-over-time chart → `{ hrSeries }`
 *     sampled at minute intervals. Always cloud-only (OCR cannot read a curve).
 *     Drives per-minute iTRIMP + HR zones for screenshot-sourced runs.
 *
 * This is a free utility (the import path is not gated behind a subscription),
 * so the protection is purely about cost and abuse:
 *   1. JWT authentication (Supabase auth) — signed-in users only
 *   2. Per-user daily cap (25/day, server-enforced via screenshot_vision_usage)
 *   3. Global daily spend cap ($10/day circuit breaker, shared llm_spend_tracker)
 *   4. Payload cap (2 MB — the client downscales before sending)
 *   5. media_type allowlist (jpeg / png / webp / gif)
 *   6. Restricted CORS (app origins only)
 *   7. 20-second timeout on the Anthropic call
 *   8. No image or response content in logs
 *
 * Model: claude-haiku-4-5-20251001 (vision-capable, cheap; Mosaic pays).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
const MAX_CALLS_PER_DAY = 25
const DAILY_SPEND_CAP_CENTS = 1000        // $10/day global circuit breaker
const ANTHROPIC_TIMEOUT_MS = 20_000
const MAX_PAYLOAD_BYTES = 2_000_000       // 2 MB — client downscales first
const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const ALLOWED_MODES = ['summary', 'hr_chart'] as const
type VisionMode = typeof ALLOWED_MODES[number]
/** Output token budget per mode. HR charts can emit ~60+ {tSec, hr} pairs for a
 *  long run, so they need more headroom than the summary path. */
const MAX_OUTPUT_TOKENS: Record<VisionMode, number> = {
  summary: 700,
  hr_chart: 1500,
}

// ─── CORS (restricted — not open to the world) ───────────────────────────────

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

// Haiku pricing: input $1.00/MTok = 0.0001 cents/token, output $5.00/MTok = 0.0005 cents/token.
function estimateCostCents(inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * 0.0001 + outputTokens * 0.0005)
}

// ─── SYSTEM PROMPTS ───────────────────────────────────────────────────────────
//
// Both modes return ONLY a JSON object. The client runs the result through
// the defensive coercers in src/data/screenshotImport.ts (parsedFromAIJson /
// parsedHrSeriesFromAIJson), so these prompts optimise for recall, not for
// schema-perfect output.

const SYSTEM_PROMPT_SUMMARY = `You read a single screenshot of a running activity summary (from Strava, Garmin Connect, Nike Run Club, Apple Fitness, Coros, or similar) and extract its numbers.

Return ONLY a JSON object, no prose, no markdown, no code fences. Use this exact shape:

{
  "distanceM": number | null,      // total distance in METRES (convert from km or miles)
  "durationSec": number | null,    // total moving or elapsed time in SECONDS
  "avgPaceSecKm": number | null,   // average pace in SECONDS PER KILOMETRE
  "avgHR": number | null,          // average heart rate, bpm
  "maxHR": number | null,          // max heart rate, bpm
  "splits": [                      // per-kilometre splits if a splits table is visible
    { "km": number, "paceSecKm": number | null, "hr": number | null }
  ]
}

Rules:
- Convert all units to the shape above. If the screenshot shows miles, convert distance to metres (1 mi = 1609.34 m) and pace to seconds per kilometre.
- A pace like "5:30 /km" is 330 seconds. A duration like "42:34" is 2554 seconds; "1:23:45" is 5025 seconds.
- If a value is not visible or you are unsure, use null. Do NOT guess or invent numbers.
- splits: include one entry per visible row of a splits/laps table. km is the split number (a trailing partial may be less than 1). Omit the array (use []) if there is no splits table.
- Only running activities are supported. If the screenshot is clearly not a run (a ride, a swim, a walk, a non-activity image), return all fields null and an empty splits array.
- Return the JSON object and nothing else.`

const SYSTEM_PROMPT_HR_CHART = `You read a single screenshot that contains a heart rate chart from a running activity (Strava, Garmin Connect, Nike Run Club, Apple Fitness, Coros, or similar) and you sample the curve at regular intervals to produce a time series.

Return ONLY a JSON object, no prose, no markdown, no code fences. Use this exact shape:

{
  "hrSeries": [
    { "tSec": number, "hr": number },
    ...
  ]
}

Rules:
- tSec is seconds since the START of the activity (the leftmost point of the chart is tSec = 0). hr is the heart rate in bpm at that point on the curve.
- Read the time axis to find the total duration, then sample the curve at roughly one point per minute (60-second spacing). For a 40-minute run that is ~40 points; for a 2-hour run that is ~120 points.
- Read the HR axis (vertical) to anchor your sampled values. HR axis labels are typically 100, 120, 140, 160, 180, 200 bpm.
- HR values are integers between 60 and 240 bpm. Drop any sample you cannot read confidently (do not invent a value).
- If the screenshot contains no HR chart, return { "hrSeries": [] }.
- If the chart shows multiple traces (HR + pace, HR + altitude), sample ONLY the heart rate trace. HR is usually a continuous line in red, pink, or orange; pace is jagged; altitude is filled.
- Sort the array by tSec ascending.
- Return the JSON object and nothing else.`

const SYSTEM_PROMPTS: Record<VisionMode, string> = {
  summary: SYSTEM_PROMPT_SUMMARY,
  hr_chart: SYSTEM_PROMPT_HR_CHART,
}

const USER_INSTRUCTIONS: Record<VisionMode, string> = {
  summary: 'Read this running activity screenshot and return the JSON.',
  hr_chart: 'Sample the HR curve in this chart at minute intervals and return the JSON.',
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req)

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405, cors)

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) {
      console.error('[screenshot-vision] ANTHROPIC_API_KEY not configured')
      return jsonResponse({ error: 'service_unavailable' }, 500, cors)
    }

    // ── Auth ───────────────────────────────────────────────────────────────
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

    // ── Parse + validate body ────────────────────────────────────────────────
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

    const imageBase64 = typeof body.image_base64 === 'string' ? body.image_base64 : ''
    const mediaType = typeof body.media_type === 'string' ? body.media_type : ''
    const rawMode = typeof body.mode === 'string' ? body.mode : 'summary'
    const mode: VisionMode = ALLOWED_MODES.includes(rawMode as VisionMode)
      ? (rawMode as VisionMode)
      : 'summary'
    if (!imageBase64) return jsonResponse({ error: 'missing_image' }, 400, cors)
    if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
      return jsonResponse({ error: 'unsupported_media_type' }, 415, cors)
    }
    // Basic base64 sanity: only base64 alphabet, plausible length.
    if (imageBase64.length < 64 || !/^[A-Za-z0-9+/=\s]+$/.test(imageBase64)) {
      return jsonResponse({ error: 'invalid_image' }, 400, cors)
    }

    const today = new Date().toISOString().split('T')[0]

    // ── Per-user daily rate limit ────────────────────────────────────────────
    const { data: usageRow } = await supabaseAdmin
      .from('screenshot_vision_usage')
      .select('call_count')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle()

    const currentCount = usageRow?.call_count ?? 0
    if (currentCount >= MAX_CALLS_PER_DAY) {
      console.log(`[screenshot-vision] Rate limited user=${userId.slice(0, 8)} (${currentCount} today)`)
      return jsonResponse({
        error: 'rate_limited',
        message: `You've hit today's screenshot-reading limit (${MAX_CALLS_PER_DAY}). Try again tomorrow, or enter the run manually.`,
      }, 429, cors)
    }

    // ── Global spend cap (circuit breaker) ───────────────────────────────────
    const { data: spendRow } = await supabaseAdmin
      .from('llm_spend_tracker')
      .select('estimated_cost_cents')
      .eq('date', today)
      .maybeSingle()

    if ((spendRow?.estimated_cost_cents ?? 0) >= DAILY_SPEND_CAP_CENTS) {
      console.warn(`[screenshot-vision] Global spend cap reached (${spendRow?.estimated_cost_cents}c)`)
      return jsonResponse({ error: 'service_busy' }, 503, cors)
    }

    // ── Call Anthropic vision with timeout ───────────────────────────────────
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
          model: ANTHROPIC_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS[mode],
          system: SYSTEM_PROMPTS[mode],
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64.replace(/\s/g, '') } },
              { type: 'text', text: USER_INSTRUCTIONS[mode] },
            ],
          }],
        }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      const isTimeout = (err as Error).name === 'AbortError'
      console.error(`[screenshot-vision] Anthropic ${isTimeout ? 'timeout' : 'fetch error'} user=${userId.slice(0, 8)}`)
      return jsonResponse({ error: isTimeout ? 'timeout' : 'llm_unavailable' }, 504, cors)
    }
    clearTimeout(timeout)

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text().catch(() => '')
      const safeErr = errText.replace(/sk-ant-[^\s"']*/g, '[key]')
      console.error(`[screenshot-vision] Anthropic error ${anthropicResponse.status} user=${userId.slice(0, 8)}: ${safeErr.slice(0, 200)}`)
      return jsonResponse({ error: 'llm_error' }, 502, cors)
    }

    const data = await anthropicResponse.json()
    const text = String(data.content?.[0]?.text ?? '')
    const inputTokens = data.usage?.input_tokens ?? 0
    const outputTokens = data.usage?.output_tokens ?? 0
    const costCents = estimateCostCents(inputTokens, outputTokens)

    const parsed = extractJson(text)
    if (!parsed) {
      console.error(`[screenshot-vision] Could not parse model JSON user=${userId.slice(0, 8)}`)
      return jsonResponse({ error: 'parse_failed' }, 502, cors)
    }

    // ── Account for usage + spend (fire-and-forget) ──────────────────────────
    supabaseAdmin
      .rpc('increment_screenshot_vision_usage', { p_user_id: userId, p_date: today })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) console.error('[screenshot-vision] usage rpc failed:', error.message)
      })

    supabaseAdmin
      .rpc('increment_spend_tracker', {
        p_date: today,
        p_input_tokens: inputTokens,
        p_output_tokens: outputTokens,
        p_cost_cents: costCents,
      })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) console.error('[screenshot-vision] spend rpc failed:', error.message)
      })

    console.log(`[screenshot-vision] OK user=${userId.slice(0, 8)} mode=${mode} in=${inputTokens} out=${outputTokens} cost=${costCents}c`)

    return jsonResponse({
      parsed,
      callsUsed: currentCount + 1,
      callsMax: MAX_CALLS_PER_DAY,
    }, 200, cors)

  } catch (err) {
    console.error('[screenshot-vision] Unhandled error:', (err as Error).message)
    return jsonResponse({ error: 'internal_error' }, 500, getCorsHeaders(req))
  }
})

/** Extract a JSON object from model output, tolerating stray prose or code
 *  fences. Returns null if no parseable object is found. */
function extractJson(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  // Try a direct parse first, then fall back to the first {...} block.
  const candidates = [stripped]
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(stripped.slice(start, end + 1))
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>
    } catch { /* try next */ }
  }
  return null
}
