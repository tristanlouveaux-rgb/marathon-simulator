/**
 * coach-narrative — Supabase Edge Function
 * =========================================
 * Accepts structured CoachSignals, calls Claude Haiku, returns a 2–3 sentence
 * coaching paragraph in the direct, factual tone used throughout the app.
 *
 * Rate limiting: handled client-side (localStorage, 3 calls/day).
 * This function trusts the client's call budget.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      })
    }

    const signals = await req.json()

    const systemPrompt = `You are a concise, factual running coach. You write in a direct, no-nonsense style.

Rules for your response:
- Exactly 2–3 sentences. No more.
- Lead with the most important signal. State the fact, then the implication.
- Never start with "You". Never use "your body". Never use motivational filler.
- No emoji. No em-dashes. Short sentences. Active voice.
- Inline-bold key numbers using **bold** markdown.
- Reference the specific training context (phase, today's workout, week in plan).
- If injury or illness is active, focus entirely on recovery — do not mention training load.

Examples of good copy:
"Sleep score of **52** on a threshold day is a bad combination — consider an easy run instead. Last week's effort was above target; adding intensity today compounds fatigue."
"Three consecutive nights above **75** and ACWR sitting at **0.9** — conditions are ideal for a hard session. Aerobic efficiency has been tracking well this week."`

    const userPrompt = buildUserPrompt(signals)

    const response = await fetch(ANTHROPIC_API_URL, {
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
    })

    if (!response.ok) {
      const err = await response.text()
      console.error('[coach-narrative] Anthropic error:', err)
      return new Response(JSON.stringify({ error: 'LLM call failed', detail: err }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 502,
      })
    }

    const data = await response.json()
    const narrative = data.content?.[0]?.text ?? ''

    return new Response(JSON.stringify({ narrative }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[coach-narrative] Error:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})

function buildUserPrompt(s: Record<string, unknown>): string {
  const lines: string[] = []

  // Status overrides
  if (s.injuryActive) {
    lines.push(`STATUS: Injury active — location: ${s.injuryLocation ?? 'unspecified'}.`)
  }
  if (s.illnessActive) {
    lines.push(`STATUS: Illness active — severity: ${s.illnessSeverity ?? 'unknown'}.`)
  }

  // Plan context
  lines.push(`Plan context: Week ${s.weekNumber} of ${s.totalWeeks}, phase: ${s.phase}.`)
  if (s.todayWorkoutName) {
    lines.push(`Today's planned workout: ${s.todayWorkoutName}${s.todayWorkoutType ? ` (${s.todayWorkoutType})` : ''}.`)
  }

  // Readiness
  lines.push(`Readiness: ${s.readinessScore}/100 (${s.readinessLabel}). ${s.readinessSentence}`)

  // Freshness
  lines.push(`Freshness: ${s.tsbZone} (TSB ${s.tsb > 0 ? '+' : ''}${s.tsb}). Fitness trend: ${s.ctlTrend}.`)

  // Load safety
  lines.push(`Load safety (ACWR): ${s.acwr} — ${s.acwrStatus}.`)

  // Recovery
  if (s.sleepLastNight != null) {
    lines.push(`Sleep last night: ${s.sleepLastNight}/100.`)
  }
  if (s.sleepAvg7d != null) {
    lines.push(`7-day sleep average: ${s.sleepAvg7d}/100.`)
  }
  if (s.hrv != null) {
    const vs = s.hrvBaseline != null ? ` vs baseline ${s.hrvBaseline}ms` : ''
    lines.push(`HRV: ${s.hrv}ms${vs}.`)
  }
  if (s.sleepBankHours != null) {
    const dir = s.sleepBankHours < 0 ? 'deficit' : 'surplus'
    lines.push(`7-day sleep bank: ${Math.abs(s.sleepBankHours as number)}h ${dir}.`)
  }

  // Week signals
  if (s.weekTSS != null && s.plannedTSS != null) {
    const pct = Math.round((s.weekTSS as number / s.plannedTSS as number) * 100)
    lines.push(`This week's load: ${s.weekTSS} TSS (${pct}% of the planned ${s.plannedTSS} TSS).`)
  }
  if (s.weekRPE) {
    lines.push(`Workout effort this week: ${s.weekRPE}.`)
  }
  if (s.hrDrift) {
    lines.push(`Aerobic efficiency: ${s.hrDrift}.`)
  }

  lines.push('\nWrite the coaching paragraph now (2–3 sentences, direct, no filler):')

  return lines.join('\n')
}
