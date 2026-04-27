# The Brain — Coaching Intelligence Design

> **Status (2026-04-24): the Brain is the rules layer.** The original thesis
> for this doc — that signals were scattered across files and needed a central
> coordinator — has been delivered by `src/calculations/daily-coach.ts`. It
> aggregates every signal into a single `CoachState` (stance, blockers,
> primaryMessage, sessionNote, workoutMod) and is the authoritative read on
> today's coaching stance. The UI surface is `src/ui/coach-view.ts` (opens from
> the Coach button on Home and Plan).
>
> **LLM work is deferred.** The "Option C hybrid" (rules layer + LLM narrative
> paragraph) and the full roadmap below remain as design reference. Nothing
> ships to production until there are paying users — the infra cost (GDPR
> consent, subscription plumbing, server-side rate limiting, spend cap,
> Anthropic TOS review) is not justified pre-revenue, and the rules layer
> already delivers the synthesis the LLM was meant to provide.
>
> **What comes next on the LLM side is "Ask the coach" (chatbot)**, not the
> narrative paragraph. A chatbot that explains plans, recovery, and the
> coaching rationale is a different product from restating the rules layer in
> prose. Revisit when the app has ~100 paying users and real questions to
> answer, per the Phase 6 guidance at the bottom of this doc.
>
> Everything below is preserved as design reference — not active scope.

---

## The Problem

The app collects a lot of signal. Right now that signal fires in isolation:

- `readiness.ts` scores TSB + sleep + HRV — but doesn't know about injury or illness
- `coach-insight.ts` computes RPE × load for the week — but doesn't know about sleep
- `sleep-insights.ts` spots post-hard-week patterns — but can't affect the plan
- `illness-modal.ts` captures illness flag — wired to nothing downstream
- `workout-insight.ts` analyses HR drift and splits per workout — not aggregated across the week
- `injury/engine.ts` manages injury state — isolated from readiness score

No single function answers: "Given everything we know right now — what is the actual coaching stance for today?"

---

## Signal Map (what exists, where it lives)

| Signal | Source | Currently fed into |
|---|---|---|
| Sleep score / duration | `physiologyHistory[]` | `readiness.ts`, `sleep-insights.ts` |
| HRV (RMSSD) | `physiologyHistory[]` | `readiness.ts` |
| Sleep bank (7-day debt) | `physiologyHistory[]` | `readiness.ts` |
| REM % *(coming)* | `physiologyHistory[]` | nothing yet |
| TSB (Freshness) | `fitness-model.ts` | `readiness.ts` |
| ACWR (Load Safety) | `fitness-model.ts` | `readiness.ts` |
| CTL trend | `fitness-model.ts` | `readiness.ts`, `coach-insight.ts` |
| Weekly TSS % of plan | `fitness-model.ts` | `coach-insight.ts` |
| RPE (effort score) | `wk.rated[]` | `coach-insight.ts` |
| HR drift (aerobic efficiency) | `wk.garminActuals` | `coach-insight.ts` (weekly avg), `workout-insight.ts` (per session) |
| Pace adherence / splits | `wk.garminActuals` | `workout-insight.ts` (per session) |
| Injury state | `s.injuryState` | `injury/engine.ts` only |
| Illness flag | `illness-modal.ts` | **nothing** |
| Check-in (how are you feeling?) | `checkin-overlay.ts` | **nothing** |
| VDOT trend | computed once from Strava | no history stored |

---

## Architecture Decision

Three options were considered:

**Option A — Rules-based coordinator only**
`daily-coach.ts` as a pure TypeScript function. All signals → deterministic decision tree → `CoachState`. Fast, offline, no cost, fully testable. The logic is hand-written, so unusual signal combinations may produce flat or generic copy.

**Option B — Full LLM agent**
Send all signals to Claude/GPT on every load. Get back natural language copy + a recommended action. Richer reasoning over unusual combinations, but: requires network on every open, adds API cost per user, harder to test, latency on every load.

**Option C — Hybrid (chosen)**
Rules-based coordinator handles all hard logic: stance, blockers, injury/illness overrides, ACWR limits. LLM called only for the narrative paragraph — turning the structured `CoachSignals` into a 2–3 sentence coaching note. The deterministic layer stays fast and testable; the LLM layer is cosmetic and optional.

**Why C:** The rules layer is the foundation and must be correct first. The LLM copy is the differentiator — it can reason over unusual combinations (e.g. "suppressed HRV on a threshold day after a hard week") in a way no decision tree can match. Separating them means the coaching stance is always reliable even if the LLM call fails.

**Paywall**: The LLM narrative (coach-narrative edge function) is a premium feature. It should be gated behind a paid plan. The rules-based `CoachState` (stance, signal rows, blockers) is free — always computed and shown. The narrative card only renders for paid users; free users see the readiness sentence from `readiness.ts` in its place.

---

## The Central Brain — `daily-coach.ts`

A single function called on every app load that collates all signals and returns a structured `CoachState` object. This is the authoritative source for:

- What today's coaching stance is
- Whether the plan should be modified
- What the user should see on the Brain tab

```ts
interface CoachState {
  stance: 'push' | 'normal' | 'reduce' | 'rest';
  readiness: ReadinessResult;           // existing
  weekSignals: WeekSignals;             // existing
  sleepInsight: string | null;          // existing
  workoutMod: 'none' | 'downgrade' | 'skip';
  alertLevel: 'ok' | 'caution' | 'warning';
  primaryMessage: string;               // single highest-priority sentence
  secondaryMessages: string[];          // supporting context (2-3 max)
  blockers: Array<'injury' | 'illness' | 'overload' | 'sleep'>;
}
```

### Priority hierarchy for `primaryMessage`

Highest priority wins:

1. **Injury active** — overrides everything regardless of other signals
2. **Illness flag set** — rest is mandatory, block quality sessions
3. **ACWR > 1.5** — load safety critical, immediate risk
4. **Sleep + ACWR combined bad** — compounding recovery + load collision
5. **HRV suppressed + high load** — physiological stress signal
6. **Post-hard-week + poor sleep** — carry-forward from previous week RPE
7. **Normal coach copy** — default readiness narrative

### How it affects the plan

`workoutMod` is an instruction to the plan renderer:

- `'none'` — show workout as-is
- `'downgrade'` — show workout with pace/intensity reduced (e.g. threshold → steady, steady → easy)
- `'skip'` — surface a "consider rest day" prompt

The plan should read `CoachState.workoutMod` before rendering today's card. This replaces the current scattered inline logic in `home-view.ts` and `plan-view.ts`.

---

## The Brain Tab

A dedicated tab that surfaces everything in one place. Not a dashboard of widgets — a single coherent read on where the athlete is right now.

### Structure

```
┌─────────────────────────────────────────────┐
│  Today's stance: [REDUCE / NORMAL / PUSH]   │  ← large, dominant
│  "Hard week on limited sleep. Back off       │
│   intensity today."                          │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  ▸ HRV 30% below 7-day average             │  ← bold headline
│  Hard sessions on suppressed HRV produce    │  ← plain body copy
│  lower adaptation and carry higher injury   │
│  risk. Consider moving Threshold 5×5 by     │
│  24 hours.                                  │
└─────────────────────────────────────────────┘
  ↑ Brain commentary card. LLM-generated narrative
    from coach-narrative edge function. Single bordered
    card, no tint. Headline is the highest-priority
    signal (from CoachState priority hierarchy).
    Body is 1-2 sentences of actionable coaching copy.
    Sits between stance hero and the data sections.

TRAINING READINESS                               ← section label

┌── This week ────────────────────────────────┐
│  Effort: Hard   Load: Below plan            │  ← existing signal pills
│  "Last week's effort was high but volume    │
│   came in below target..."                  │
└─────────────────────────────────────────────┘

┌── Recovery ─────────────────────────────────┐
│  Readiness: 58 — Manage Load                │
│  Sleep last night: 62  7-day avg: 71        │
│  HRV: 42ms  (−8ms vs baseline)             │
│  Sleep bank: −3.5h this week                │
└─────────────────────────────────────────────┘

┌── Fitness ──────────────────────────────────┐
│  Running fitness: 31.3  ↓ from 33.1        │
│  Training load: 63 TSS (32% of plan)        │
│  Trend: 4-week CTL down 2.1 pts             │
└─────────────────────────────────────────────┘

┌── Status ───────────────────────────────────┐
│  [Injury: none]  [Illness: none]            │
│  [Check in →]                               │
└─────────────────────────────────────────────┘
```

The stance block is the hero. Everything else is supporting evidence for why the stance is what it is.

### Design rules

- Max 2 non-neutral colours. Red for warning/blocker, amber for caution. Green only for readiness label.
- Sections are plain rows, no tinted cards, no decorative gradients.
- "Check in →" is the only CTA. Opens `checkin-overlay.ts`.
- The stance label uses the same vocabulary as the readiness label: **Ready to Push / On Track / Manage Load / Ease Back** — do not invent new terms.

---

## Build Status

### Phase 1 — Wire existing signals ✅ BUILT (2026-03-22)

1. ✅ **`src/calculations/daily-coach.ts`** — `computeDailyCoach(state)` aggregates all signals into `CoachState` with `stance`, `blockers`, `alertLevel`, and `CoachSignals` payload.
2. ✅ **Illness state** — `s.illnessState` already existed on `SimulatorState`. Read as blocker in `daily-coach.ts`.
3. ✅ **`supabase/functions/coach-narrative/index.ts`** — Haiku LLM call. System prompt enforces direct/factual tone. Rate limit: 3 calls/day, 4h cache in localStorage.
4. ✅ **`src/ui/coach-modal.ts`** — Coach overlay with readiness ring, 5 signal rows, LLM narrative card.
5. ✅ **Coach button** — added to Home header and Plan header (current week only), same pill style as Check-in.

**Pending before Phase 1 is live:**
- Deploy edge function: `supabase functions deploy coach-narrative`
- Set secret: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`

### Phase 2 — Add missing data points (not started)

6. **Subjective daily feeling** — "How do you feel today?" 4-option tap (`Struggling / Ok / Good / Great`) → `s.todayFeeling` on state. Drops/raises stance by one level. Expires end of day.
7. **VDOT history sparkline** — `vdotHistory` already stored on state (`{week, vdot, date}[]`). Need to surface "fitness direction" as a real trend in `CoachSignals` rather than just 4-week CTL delta.
8. **Weekly aerobic efficiency trend** — aggregate `hrDrift` across `garminActuals` for the past 4 weeks. Detects aerobic efficiency decline before VDOT changes.
9. **REM %** — once Garmin/Apple surface this in `physiologyHistory`, slots into `readiness.ts` as a sub-signal on sleep quality.
10. **Previous-week carry-forward** — if last week's `CoachState.stance` was `'reduce'` or `'rest'`, this week's base readiness starts discounted. Prevents whiplash.

---

## What the Check-In Feeds

The check-in (currently: Injured / Ill / Holiday) should expand to include a daily subjective rating. This is the cheapest possible signal — one tap, zero sensor required.

Proposed flow on app open (or from the Brain tab):

```
How do you feel today?
  [ Struggling ]  [ Ok ]  [ Good ]  [ Great ]
```

Maps to a modifier on `CoachState.stance`:
- **Struggling** → drops stance one level (Push → Normal, Normal → Reduce, Reduce → Rest)
- **Good / Great** → slight positive modifier on readiness score (not enough to override hard limits)
- **Ok** → no change

This is stored as `s.todayFeeling: 'struggling' | 'ok' | 'good' | 'great' | null` and expires at end of day.

---

## What Connects to What (target state)

```
physiologyHistory  ──→  readiness.ts  ──┐
s.injuryState      ──────────────────────┤
s.illnessFlag      ──────────────────────┤
s.todayFeeling     ──────────────────────┤──→  daily-coach.ts  ──→  CoachState
fitness-model.ts   ──→  TSB/ACWR/CTL  ──┤                              │
wk.rated           ──→  coach-insight ──┤                              │
wk.garminActuals   ──→  hrDrift/RPE   ──┘                              │
                                                                        │
                                          ┌─────────────────────────────┘
                                          ↓
                                    Brain tab (read)
                                    home-view.ts (today's workout card)
                                    plan-view.ts (workout mod badge)
                                    week-debrief.ts (weekly summary)
```

---

## Open Questions for Tristan

Before building the Brain tab:

1. **Tab position** — does Brain replace Stats, sit alongside it, or is it a sub-page off Home?
2. **Stance vocabulary** — use the existing readiness labels (Ready to Push / On Track / Manage Load / Ease Back) or introduce a simpler set (Push / Normal / Back Off / Rest)?
3. **Subjective check-in** — do you want the daily feeling prompt on app open, or only accessible from the Brain tab?
4. **Illness severity** — should illness always force `stance = 'rest'`, or only above a severity threshold (mild illness = reduce, moderate/severe = rest)?
5. **LLM narrative** — rules-based copy only for now, or do you want an LLM call for the `primaryMessage`? (Option C from our earlier discussion)

---

## LLM Coaching Layer — Full Design

### What the LLM Does (and Doesn't)

**Does:**
- Receives structured, pre-computed `CoachSignals` (readiness, HRV, sleep, load, ACWR, phase, today's workout)
- Writes a 2-3 sentence coaching paragraph connecting multiple signals
- Handles unusual signal combinations better than any decision tree

**Doesn't:**
- Make training decisions (stance, workout mods, blockers are all rules-based in `daily-coach.ts`)
- Access raw user data, PII, or credentials
- Store anything or have memory between calls (stateless)
- Modify the plan or state

**If the LLM goes down, the app works perfectly.** The narrative card disappears; everything else is unchanged. The worst case of a hallucination is a weird paragraph — it cannot change the plan, skip a workout, or modify state.

---

### Multi-Sport Considerations (Triathlon, Hyrox)

The architecture stays the same across sports. What changes is the signal context sent to the LLM.

| Signal | Running | Triathlon | Hyrox |
|---|---|---|---|
| Sport context | Always running | swim/bike/run, brick sessions | Roxzone stations + running |
| Today's workout | "Threshold 5x5min" | "Bike 90min Z2 + Run 30min off the bike" | "8 stations + 8x1km runs" |
| Load model | Signal A (run-equivalent) | Signal A per discipline + combined Signal B | Signal B dominant (full-body) |
| Fatigue pattern | Legs + cardio | Swim fatigue ≠ run fatigue; brick-specific | Upper body + grip + cardio |
| Injury profile | IT band, shin, achilles | + shoulder (swim), saddle sores | + lower back, grip, shoulder |

**Implementation:** One edge function with a sport-aware prompt. A `sport` field in `CoachSignals` selects an addendum block in the system prompt with sport-specific knowledge (e.g. "brick sessions target neuromuscular adaptation, not cardiovascular load"; "Hyrox station fatigue is dominated by grip and posterior chain").

**Risk:** LLM gives technique advice it isn't qualified for. System prompt must include: "Advise on training load, recovery, and session timing only. Do not advise on technique, form, or equipment."

---

### Data Privacy

**What leaves the device:**

| Data point | Sensitive? | Mitigation |
|---|---|---|
| HRV, sleep score, sleep bank | Health data (GDPR special category) | Anonymised: no user ID in prompt payload to Anthropic |
| Readiness score | Derived health data | Same |
| Injury location ("left knee") | Health data | Same |
| Illness state | Health data | Same |
| TSS, ACWR, CTL | Training metrics | Low sensitivity but still personal |
| Workout description | Not sensitive | None needed |
| User ID / email / name | PII | **Never sent to Anthropic** |
| Strava token | Credential | **Never sent anywhere beyond sync functions** |

**Anthropic's API data policy:** API inputs are not used for training and are retained for 30 days for trust and safety, then deleted. Confirm current terms before launch.

**Required actions:**

1. **Consent gate** — one-time disclosure before first LLM call: "Coach insights are generated by an AI service. Training metrics (sleep, HRV, training load) are sent anonymously. No name, email, or location is included." Store consent as `s.coachNarrativeConsent: boolean`.
2. **Server-side field allowlisting** — edge function must destructure only known fields, not forward raw `req.json()`. If someone adds `email` to `CoachSignals` later, it won't leak.
3. **No prompt/response logging** — production logs record only: hashed user ID, timestamp, response status, token count. Never the prompt or narrative text.
4. **Privacy policy update** — disclose AI processing of health-adjacent data by a third-party provider.
5. **Apple privacy nutrition label** — add AI processing of health data to the App Store disclosure.
6. **Right to withdraw** — user can disable coach insights; app stops sending data.

**GDPR note:** HRV/sleep/injury is "special category data" (health). Processing requires explicit consent, not just legitimate interest. Cross-border transfer (Supabase on Deno Deploy, Anthropic in US) needs Standard Contractual Clauses or equivalent in place.

---

### Cost Control — Defence in Depth

**Current gap:** The edge function has zero server-side rate limiting. It trusts the client. A modified client, a bug, or a replay attack can generate unlimited API calls.

**Layer 1 — Server-side per-user rate limit (MANDATORY)**

```sql
CREATE TABLE coach_narrative_usage (
  user_id UUID REFERENCES auth.users NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  call_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
```

On each request: read `call_count` for today. If >= daily cap, return 429 + last cached narrative. Else increment and proceed.

**Layer 2 — Client-side cache (UX optimisation, not security)**

4-hour TTL in localStorage. Prevents redundant calls on repeated app opens. Already sketched in Phase 1.

**Layer 3 — Global spend cap (CRITICAL)**

```sql
CREATE TABLE llm_spend_tracker (
  date DATE PRIMARY KEY DEFAULT CURRENT_DATE,
  total_input_tokens INT NOT NULL DEFAULT 0,
  total_output_tokens INT NOT NULL DEFAULT 0,
  estimated_cost_cents INT NOT NULL DEFAULT 0
);
```

After each API call, increment with token counts from Anthropic's response (`usage.input_tokens`, `usage.output_tokens`). If `estimated_cost_cents > DAILY_CAP_CENTS`, return fallback for all users until midnight. Fallback = rules-based `primaryMessage` from `CoachState`.

**Layer 4 — max_tokens** — already set to 200. Caps output cost per call.

**Layer 5 — Input validation** — payload must be valid JSON, no field exceeds 100 chars for strings, total serialised prompt under 2000 chars.

**Layer 6 — Alerting** — notify if: daily spend > 50% of cap, any user hits rate limit 3 days running, error rate from Anthropic > 10%.

**Projected costs:**

| DAU | Calls/day | Monthly cost (Haiku) |
|---|---|---|
| 100 | 200 | ~$12 |
| 1,000 | 2,000 | ~$120 |
| 10,000 | 20,000 | ~$1,200 |
| 50,000 | 100,000 | ~$6,000 |

At $5/month subscription with $0.12/month LLM cost per user, margin is ~97%.

---

### Security Threats

**Prompt injection:** Malicious user crafts a `CoachSignals` payload with injection text in a string field. Mitigated by: field allowlisting, string truncation (100 chars), stripping newlines, output rendered as plain text (not HTML). Worst case is a weird paragraph.

**API key theft:** Key in Supabase secrets (env var), not in code. Set up Anthropic usage alerts. Rotate periodically.

**Authentication bypass:** Current edge function does not verify the JWT. Must be fixed before launch. Use `supabase.auth.getUser()` with the request's Authorization header.

**Replay attacks:** Server-side rate limiting (Layer 1) handles this. Even with replayed valid JWTs, the user hits their daily cap.

**Denial of wallet:** Attacker creates many accounts to burn API budget. Mitigated by: LLM feature only for paid users (creating accounts costs money), global spend cap as hard stop. If a free trial is offered, limit to 3-5 total calls (not per day).

**CORS:** Current `Allow-Origin: *` must be replaced with the actual app domain before launch.

---

### Reliability and Failure Modes

| Failure | Handling |
|---|---|
| Anthropic API down | Return fallback (rules-based message). No error shown to user. |
| Anthropic API slow (>3s) | 3-second timeout on fetch, then fallback. |
| Edge function crash | Client catches error, shows fallback. |
| Supabase down | App works offline with cached state. Narrative card hidden. |
| Bad LLM output (hallucination) | `max_tokens: 200` limits damage. Reject output if >300 chars or contains code blocks. |
| Rate limit hit | Show last cached narrative. Don't tell user they're rate limited. |

**Key principle:** The LLM narrative is always optional. Never block app load waiting for it. Never store it in state that other features depend on. Never use it to derive training decisions.

---

### Quality Control

**Prompt testing:** Before launch, build ~20 signal combinations covering edge cases (injury + high readiness, perfect recovery + taper, suppressed HRV + threshold day, triathlon brick, Hyrox competition week). Run each through the edge function and grade output quality.

**Tone drift:** LLMs drift toward generic wellness language. Monitor for "listen to your body" or "recovery is where the magic happens". If detected, tighten the system prompt.

**Model versioning:** Currently pinned to `claude-haiku-4-5-20251001`. When Anthropic releases a new Haiku, upgrade deliberately after testing, not automatically.

**Multi-sport prompt quality:** Add sport-specific addendum blocks to the system prompt based on `signals.sport`, rather than relying on the LLM to infer from context.

---

### Legal and Compliance

**Medical advice disclaimer:** Terms of service must state: "Mosaic provides training guidance based on your data. It is not medical advice." The system prompt must include: "Never recommend medical treatment, medication, or diagnose conditions."

**Liability:** The rules engine is the authority, not the LLM. If rules say `stance: reduce`, the UI shows that prominently. The LLM narrative is secondary commentary with a footer: "AI-generated insight based on your metrics."

**App Store review:** Disclose AI-generated content in the app description. Add AI processing to the privacy nutrition label. Have the data flow documented for Apple's review team.

**GDPR:** Explicit consent before first call. Data processing agreement with Anthropic. Privacy policy names the AI processor. Right to withdraw consent.

---

### Paywall Design

**Free tier:** Full rules-based `CoachState` (stance, readiness, signals, workout mods). Brain tab with all data sections. Generic one-liner from rules engine.

**Pro tier:** LLM coaching paragraph. Weekly narrative summary. Post-workout LLM analysis (future). "Ask the coach" (future, separate risk profile).

**Enforcement:** Server-side subscription check in the edge function. Client shows/hides the card for UX speed, but the edge function is the enforcer.

**Free trial:** 3-5 total LLM calls (not per day). Tracked in `trial_calls_used`. After exhaustion, show upsell.

```sql
CREATE TABLE user_subscriptions (
  user_id UUID REFERENCES auth.users PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',  -- 'free' | 'pro'
  stripe_customer_id TEXT,
  current_period_end TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'cancelled' | 'past_due'
  trial_calls_used INT NOT NULL DEFAULT 0
);
```

---

### "Ask the Coach" — Future Risk Assessment

Free-text conversation with the LLM is the most dangerous feature to build:

- **Expensive** — multi-turn conversations are 10-50x the cost of a single narrative call
- **Prompt injection prone** — user-typed text goes directly into the prompt
- **Liability-heavy** — users might ask health/medical questions
- **Hard to rate limit** — "3 messages/day" frustrates; unlimited burns money

**If built, isolate it:** Separate edge function, separate rate limits, separate spend cap. Aggressive input sanitisation. System prompt hard-refuses medical, dietary, and supplement questions. Conversation stored server-side with max 5-message context window. Higher subscription tier or token-based pricing.

**Recommendation:** Don't build until the single-narrative feature is proven and profitable.

---

### Decisions Required

> See next section — each decision has context and a recommendation.

---

## Key Decisions

### DECISION 1 — Daily call limit per user

**Options:**
- A) 2 calls/day — very conservative, minimal cost risk
- B) 3 calls/day — reasonable for morning check + midday re-check + evening
- C) 5 calls/day — generous, higher cost

**Recommendation:** B (3/day). Covers the realistic use pattern (morning open, post-workout check, evening review). Combined with 4h client cache, most users will hit the API 1-2 times anyway.

### DECISION 2 — Global daily spend cap

**Options:**
- A) $10/day — safe for <1K DAU, will trigger circuit breaker early at scale
- B) $50/day — comfortable up to ~10K DAU
- C) Scale dynamically: $0.01 x paid_user_count per day

**Recommendation:** Start with A ($10/day) now. Move to C when you have real usage data. The cap is a safety net, not a throttle. If it triggers, investigate why.

### DECISION 3 — Free trial of LLM coaching

**Options:**
- A) No trial — paywall from day one
- B) 3 free calls total — enough to experience it, not enough to abuse
- C) 7-day unlimited trial — more generous, higher risk

**Recommendation:** B (3 free calls). Low cost risk. Users get a taste. The upsell appears after the third call with the fallback message: "You've used your free coaching insights. Upgrade for daily AI coaching."

### DECISION 4 — Consent UX

**Options:**
- A) Modal on first Brain tab visit: "Coach insights use AI. Your metrics are sent anonymously. [Enable / Not now]"
- B) Toggle in Settings, off by default
- C) Inline consent within the narrative card area (less intrusive)

**Recommendation:** A. GDPR requires explicit, informed consent for health data processing. A modal is the clearest way to prove you obtained it. Store the timestamp of consent.

### DECISION 5 — What to show free users where the narrative card would be

**Options:**
- A) Nothing — the card simply doesn't exist for free users
- B) A blurred/placeholder card with "Unlock AI coaching" CTA
- C) The rules-based `primaryMessage` in the same card style, with a subtle "Upgrade for deeper insights" link

**Recommendation:** C. Free users still get value from the Brain tab. The `primaryMessage` is already computed. Showing it in the narrative card position keeps the layout consistent and makes the upgrade feel like an enhancement, not a gate.

### DECISION 6 — Sport-specific system prompt strategy

**Options:**
- A) One universal prompt, include sport context in the user message
- B) Sport-specific addendum blocks appended to the system prompt
- C) Completely separate system prompts per sport

**Recommendation:** B. One base prompt handles tone, format, and constraints. A short addendum (3-5 lines) adds sport-specific knowledge. Easier to maintain than C, more reliable than A.

### DECISION 7 — Where to store the narrative cache

**Options:**
- A) localStorage only (current approach) — fast, no cost, lost on app reinstall
- B) Supabase DB — persists across devices, enables weekly summaries, but adds a write per call
- C) Both — localStorage for fast reads, DB for persistence and analytics

**Recommendation:** C long-term, A for now. DB storage enables "last 7 narratives" in the weekly debrief and helps you monitor output quality at scale. But it's not needed for launch.

### DECISION 8 — Subscription pricing

Not a technical decision, but affects architecture (how many tiers, what goes where).

**Options:**
- A) Single Pro tier ($5/month) — all LLM features
- B) Two tiers: Pro ($5/month, narrative only) + Premium ($10/month, + ask the coach)
- C) Token-based: buy N coaching credits

**Recommendation:** A for now. One tier is simpler to build, market, and support. Add a second tier only when "Ask the coach" is ready and proven.

### DECISION 9 — Fallback behaviour when LLM is unavailable

**Options:**
- A) Hide the narrative card entirely
- B) Show the rules-based `primaryMessage` in its place
- C) Show a "Coach is thinking..." skeleton indefinitely

**Recommendation:** B. The user should never notice the LLM is down. The rules-based message is already good. The card looks the same, the content is just less rich.

### DECISION 10 — Prompt injection defence level

**Options:**
- A) Minimal: field allowlisting + string truncation (sufficient for structured-only input)
- B) Moderate: A + regex scan for common injection patterns
- C) Heavy: A + B + separate LLM call to classify input as safe/unsafe (expensive)

**Recommendation:** A for now. You control the input — it's structured JSON from your own code, not user-typed text. If you add "Ask the coach" later, upgrade to B. C is overkill unless you're processing adversarial free-text.

---

## Roadmap

### Phase 0 — Harden the edge function (before any user sees it)

**Goal:** Make `coach-narrative` production-ready with auth, rate limiting, and cost controls.

- [ ] Add JWT verification (`supabase.auth.getUser()`)
- [ ] Add server-side per-user rate limiting (DB table + check)
- [ ] Add subscription/plan check (reject non-pro users)
- [ ] Add input validation (field allowlist, string length caps, payload size cap)
- [ ] Add global daily spend tracking + circuit breaker
- [ ] Add 3-second timeout on Anthropic API call with fallback
- [ ] Tighten CORS to app domain only
- [ ] Strip prompt/response content from logs
- [ ] Create `user_subscriptions` and `coach_narrative_usage` tables

**No UI changes.** This is infrastructure.

### Phase 1 — Ship the narrative to paid users *(already partially built)*

**Goal:** Paid users see the LLM coaching paragraph on the Brain tab / Coach modal.

- [ ] Deploy hardened edge function
- [ ] Set `ANTHROPIC_API_KEY` secret
- [ ] Add consent modal (first Brain tab visit)
- [ ] Show rules-based `primaryMessage` for free users in the narrative card position
- [ ] Show LLM narrative for paid users (with loading skeleton + fallback)
- [ ] Add "Upgrade" CTA for free users below the `primaryMessage` card
- [ ] Free trial: 3 total calls, tracked in `user_subscriptions.trial_calls_used`
- [ ] Test with ~20 signal combinations for quality

### Phase 2 — Weekly narrative summary

**Goal:** At the end of each week (or in the week debrief), generate a paragraph summarising the full week.

- [ ] New edge function endpoint or mode: `coach-narrative?mode=weekly`
- [ ] Input: full week's signals (daily readiness array, total load, planned vs actual, completed workouts, sleep trend)
- [ ] Called once at week advance, cached in DB
- [ ] Surfaced in the week debrief modal
- [ ] Same rate limit and cost tracking infrastructure

### Phase 3 — Multi-sport prompt expansion

**Goal:** Coaching narrative works well for triathlon and Hyrox users.

- [ ] Add `sport` field to `CoachSignals` (`'running' | 'triathlon' | 'hyrox'`)
- [ ] Write sport-specific system prompt addendums
- [ ] Add discipline-level signals for triathlon (swim/bike/run split, brick context)
- [ ] Add station-level signals for Hyrox (station fatigue, grip/posterior chain)
- [ ] Test with ~10 sport-specific signal combinations per sport
- [ ] Review LLM output for technique advice leakage (must not happen)

### Phase 4 — Narrative history + DB caching

**Goal:** Store narratives for analytics, quality monitoring, and "what did the coach say last week?"

- [ ] Store each narrative in DB: `coach_narratives(user_id, date, signals_hash, narrative, tokens_used)`
- [ ] Surface "last 7 days" in Brain tab (expandable)
- [ ] Build admin dashboard: daily call volume, cost, error rate, top-triggered signals
- [ ] Monitor for tone drift (periodic manual review of random narratives)

### Phase 5 — Post-workout analysis (stretch)

**Goal:** After an activity syncs, generate a paragraph analysing the session.

- [ ] New edge function mode: `coach-narrative?mode=workout`
- [ ] Input: planned workout, actual splits, HR drift, pace adherence, RPE
- [ ] Surfaced on the activity detail page
- [ ] Separate rate limit (1 per synced activity)
- [ ] Only for paid users

### Phase 6 — "Ask the coach" (high risk, build last)

**Goal:** Free-text conversation with the coaching LLM.

- [ ] Separate edge function with its own rate limits and spend cap
- [ ] 5 messages/day cap per user
- [ ] Input sanitisation + prompt injection defence (regex scan)
- [ ] System prompt hard-refuses medical, dietary, supplement, and technique questions
- [ ] Server-side conversation storage, max 5-message context window
- [ ] Possibly a higher subscription tier
- [ ] **Do not build until Phases 0-2 are proven and profitable**

---

## Pre-Launch Checklist

- [ ] Anthropic API terms reviewed — confirm no-training policy still applies
- [ ] Data processing agreement with Anthropic in place (or confirm API terms suffice)
- [ ] Privacy policy updated — names AI processor, describes data sent, states retention
- [ ] Terms of service updated — "not medical advice" disclaimer, limitation of liability
- [ ] Apple privacy nutrition label updated — AI processing of health data
- [ ] Consent modal implemented and tested
- [ ] Edge function deployed with all Phase 0 hardening
- [ ] 20-scenario prompt quality test passed
- [ ] Global spend cap tested (simulate hitting it, verify fallback)
- [ ] Rate limit tested (simulate 4th call, verify 429 + cached response)
- [ ] Auth bypass tested (call without JWT, verify 401)
- [ ] Subscription check tested (call as free user, verify 403)
