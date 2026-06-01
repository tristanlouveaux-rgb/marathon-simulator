# Mosaic AI Strategy

## Update — 2026-06-01 (CRITICAL: Strava's new API Policy bans AI use of Strava data)

Strava's June 2026 Developer Program overhaul shipped a new API Policy with a broad anti-AI clause. As read on 2026-06-01 (verify exact section numbers before quoting):

- **§5.3** — "You may not use the Strava API Materials or Strava Data, directly or indirectly, in connection with the development, training, evaluation, or **operation of any AI Application.**" This explicitly extends to data **derived, aggregated, or anonymised from Strava Data**, and explicitly covers **"ingestion into a context window or working memory"** (i.e. inference, not just training).
- **§5.10** — may not disclose Strava Data to any third party; names **AI providers** specifically.
- Only AI carve-out: Strava's own MCP, **personal use only**.

**What this means for Mosaic.** The AI Coach feeds Strava-derived data to the LLM (`coach-chat-client.ts:63-69`: `recent_activities` last 4 weeks pace/HR/splits, `benchmarks` FTP/CSS/VDOT). For a Strava-connected user, that data — and everything derived from it — is Strava Data. So the Coach as built cannot serve Strava-connected users under this policy.

**DECISION (Tristan, 2026-06-01): Strava wins.** Strava is the *only* viable activity pipe for Garmin users (Garmin's own API is closed to us; the aggregator fallback was killed by the same overhaul; the Garmin→Apple Health bridge drops splits). It is non-negotiable for the user base. Therefore **the AI Coach must not use Strava data**, which in practice means **the Coach is unavailable to Strava-connected users**. It may only serve users whose data is Apple-Health-only or manual-entry.

**Status:** NOT a live violation today — the Coach is allowlist/entitlement-gated server-side (`coach-chat-client.ts:5`, `entitlement.ts`); it does not serve general or Strava users. Even Tristan's own allowlisted use technically touches Strava data (fine for dev, do not roll out).

**Monetisation implication:** the serious Garmin/Strava athletes are exactly the cohort most likely to pay for the Coach, and they're the cohort it can no longer serve. The Tier-2 (£4.99/mo IAP) Coach economics below were written before this constraint and need re-evaluation.

**Open avenue (not assumed safe):** BYOK (user supplies their own Anthropic key) *might* be a narrower "personal use" path, but Mosaic still builds/operates the pipeline that ingests Strava data into an AI, so it does not clearly exempt us. Worth a written question to developers@strava.com before relying on it. Tracked as ISSUE-252.

**Required before any Coach GA:** gate the Coach off for Strava-connected users (or strictly exclude Strava-derived data, which for those users is effectively all of it). See ISSUE-252.

## Update — 2026-05-28

Two material changes have landed since the original strategy below was written. The sections further down still capture the reasoning, but the live state is:

1. **Payment is RevenueCat IAP, not Stripe web.** Tier 2 ships as Apple In-App Purchase via RevenueCat. Web/Android users get entitlement via the `subscription_active` Supabase row that the RevenueCat webhook writes. The Stripe-web sections below are historical context, not current truth.
2. **Live pricing**: £4.99/month, £49.99/year. Annual SKU exists.
3. **Brain-generated workouts (On-Demand mode)** are a new Tier 2 capability. See `## Brain-Generated Workouts (Tier 2)` below for design and economics.

## Current State (May 2026)

BYOK (Bring Your Own Key) AI Coach is live. Users provide their own Anthropic API key, stored in iOS Keychain. Mosaic pays $0. The coach reads 4 weeks of pacing, HR, readiness, and plan data, streams a coaching brief, and can propose workout changes (swap / reduce / skip / intensity cap) via Apply cards. Chat follow-up is supported. Session persists within the same plan week.

**What the AI coach does now:**
- Streams a 4-6 sentence coaching brief based on real training data
- Proposes specific plan modifications that require user confirmation (Apply)
- Answers follow-up questions in context
- Exports training snapshots for use in any external LLM (claude.ai, ChatGPT, etc.)

**What it does not do:**
- Persistent memory across weeks (each week starts fresh from state)
- Medical, nutrition, or technique advice (hard rules in system prompt)
- Autonomous plan changes (Apply always required)

---

## Tier Model

### Tier 0 — Free (current default)
Rules-based coach. Identical data, no LLM. No cost to Mosaic. No friction for the user. The "Connect AI Coach" setup card is visible in the coach view for every free user. Export snapshot is available so users can take their data to any external LLM.

### Tier 1 — BYOK (live)
User provides their own Anthropic API key. Full AI coach experience. Zero cost to Mosaic. Friction: requires Anthropic account, API key, payment method. Target user: technical early adopters who already have Anthropic access.

### Tier 2 — Mosaic AI Coach subscription (next to build)
Mosaic pays for the API. User pays Mosaic a monthly subscription. Seamless — no key required. This is the primary monetisation vehicle for AI coaching.

**Target price**: $4.99/month

**Economics at $4.99/month (using claude-haiku-4-5):**
- Cost per session: ~$0.005 (8K input tokens + 1.5K output at Haiku pricing)
- 3 sessions/day cap per user x 30 days: ~$0.45/month max API cost
- Margin at full cap usage: ~$4.54/user/month
- Margin at typical usage (1 session/day): ~$4.84/user/month
- Break-even: user would need to run >996 sessions/month to cost more than $4.99

**Rate limit for Tier 2**: 5 sessions/day (generous — most users do 1-2). At Haiku pricing, 5/day cap means $0.075/day max cost = $2.25/month at ceiling. Margin holds even at heavy use.

**Why Haiku not Sonnet for Tier 2**: Haiku is 10x cheaper and is genuinely capable for structured coaching tasks — it reads known data fields, applies hard rules, uses a fixed tool schema. The coaching quality difference vs Sonnet is real but acceptable at $4.99/month. BYOK users keep Sonnet (their cost, their choice).

### Tier 3 — Full app subscription (long-term)
Charge for the full app (training plans, readiness, GPS tracking). AI coaching becomes an add-on on top of the base subscription.

**Suggested structure (long-term):**
- Base app: $9.99/month or $79.99/year (plan generation, readiness, GPS, all current features)
- AI Coach add-on: +$4.99/month

This is a standard "platform + intelligence" model. The base app is defensible without AI. The AI layer amplifies it.

---

## Tier 2 — Technical Implementation

The edge function architecture already supports this. Changes needed:

### 1. Switch API key source
`supabase/functions/coach-chat/index.ts` currently reads `X-Anthropic-Key` from the request header (BYOK). For Tier 2, remove that header requirement and use `Deno.env.get('ANTHROPIC_API_KEY')` (Mosaic's key stored in Supabase Vault). The pattern already exists in `coach-narrative/index.ts`.

Add a request header: `X-Mosaic-Tier: 'byok' | 'subscription'`. Edge function branches:
- `byok`: uses `X-Anthropic-Key` (current behaviour)
- `subscription`: uses Vault key, checks entitlement, applies tighter rate limit (5/day)

### 2. Entitlement check
Add a `subscriptions` table (or extend the existing `coach_chat_usage` table):

```sql
create table subscription_active (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier    text not null default 'free',  -- 'free' | 'ai_coach' | 'full_app'
  valid_until timestamptz
);
```

The edge function reads this on every request (service role, no RLS). If `tier = 'free'` and mode is `subscription`, reject with `{ error: 'subscription_required' }`.

### 3. Payment — Stripe
- Stripe Checkout for subscription creation
- Stripe webhook → Supabase edge function (`stripe-webhook`) that upserts `subscription_active`
- Customer portal link for cancellation / upgrade
- Supabase stores `stripe_customer_id` on the user record

### 4. Client changes
- `src/types/state.ts`: add `aiCoachSubscriptionActive?: boolean`
- Coach view: if no BYOK key and no subscription, show subscription CTA instead of (or alongside) the BYOK setup card
- Account view: subscription status card with manage/cancel link
- `src/data/supabaseClient.ts`: add `checkAiSubscription()` that reads `subscription_active` on launch and sets the state flag

### 5. Model for Tier 2
Change the edge function for subscription mode to use `claude-haiku-4-5-20251001` (not Sonnet). BYOK users keep Sonnet — it's their key.

---

## Brain-Generated Workouts (Tier 2)

Premium capability shipped 2026-05-28 alongside the On-Demand mode rename. Sits next to the free rule-based "Generate" button on the On-Demand home and plan tab as a second CTA: "Generate with Coach".

**What it does**: reads recent training context (CTL, TSB, ACWR, readiness, last 10 sessions, week-vs-typical TSS, VDOT, phase) plus a free-text intent ("50 min on hills", "feeling tired"), an optional injury note, and a time budget. Returns a structured workout via Anthropic tool_use, plus a 2–3 sentence narrative grounded in real signals. User can Accept, regenerate with tweaked intent, or cancel.

**Why behind the paywall**: differentiates from the rule-based generator (which stays free and unchanged) by adding context awareness and natural-language intent. The free path remains the default; Coach is the upgrade for users who want their training context taken into account.

**Pipeline**: client → edge function (`supabase/functions/coach-generate-workout/`) → Anthropic Haiku `claude-haiku-4-5-20251001` with forced `propose_workout` tool call → structured JSON → client renders proposal → on Accept, materialise as `Workout` and push to `wk.adhocWorkouts`.

**Economics**: same Haiku pricing as coach-narrative. Per-call cost ~$0.005 (slightly higher than narrative because tool_use adds tokens). Per-user cap 5/day = $0.025/day max = $0.75/month at ceiling. Shares the global `llm_spend_tracker` $10/day cap.

**Scope limit (V1)**: running sessions only. Slots match the existing `SESSION_TYPES` in `src/ui/session-generator.ts` (easy / long / threshold / vo2 / marathon_pace / progressive / vibes). Strength sessions excluded — the strength-detail schema is owned by a parallel workstream; extend the tool definition when that lands.

**Future**: when the brain prompt + contract are validated on On-Demand, the same engine can be wired into (a) the race-plan workout-tweak flow (brain proposes an adjustment to a prescribed session) and (b) cross-training suggestions inside the suggestion modal. Both are separate sessions of work.

---

## Snapshot Export (live)

The "Export training snapshot" button downloads a `.txt` file containing the full system prompt and training data JSON. Users paste it into claude.ai, ChatGPT, or any LLM. The AI gives coaching text but cannot modify the plan (no tool schema, no Apply cards).

This is the zero-friction free tier. It drives awareness of what the AI Coach does and gives a natural upgrade prompt: "Want this to actually change your plan? Connect AI Coach."

---

## What the AI Coach "Learns"

The AI Coach does **not** learn in the machine learning sense. It does not retain memory between sessions or fine-tune on user data. Anthropic does not train on API usage.

What improves over time: richer context. As users train more, there are more weeks of activity history, more HRV data points, more plan adherence signals. The same LLM with more data produces better synthesis. This is "more context" not "learning."

The separate Adaptive Recovery feature (`src/calculations/adaptive-recovery.ts`) **does** learn — it fits the personal recovery time-constant `k_user` from check-in history. This is a different system. The onboarding slide "Learns how you recover" refers to this, not the AI Coach.

Copy distinction:
- Adaptive Recovery: "Learns how you recover"
- AI Coach: "Reads your full training history"

---

## Privacy and Security

**Data sent to Anthropic per session:**
- Last 4 weeks of activity data (distance, pace, HR, splits)
- Readiness signals (HRV, sleep, TSB, ACWR)
- This week's planned workouts
- Athlete benchmarks (VDOT, FTP, CSS, PBs)

**Not sent:**
- Name, email, or any identifier
- GPS traces or location data
- Garmin / Strava account credentials
- Payment information

**Storage:**
- BYOK: user's API key stored in iOS Keychain (`@capacitor/preferences`). Never in state, never logged.
- Tier 2: Mosaic's key in Supabase Vault. Never touches the client.

**Injection defence:**
- All user-controlled strings (activity names, workout descriptions) pass through `sanitizeField()` before prompt inclusion.
- Tool parameters validated against actual plan state before Apply card renders.
- Apply required before any state mutation.

---

## Pending Decisions (session closed 2026-05-07)

Four decisions need Tristan's sign-off before Tier 2 can be built. Pick up here next session.

| # | Decision | Options | Recommendation | Status |
|---|----------|---------|----------------|--------|
| 1 | Payment platform | Stripe web vs Apple IAP | **Stripe web** — web app at `mosaic-theta-lac.vercel.app` confirmed, keeps full $4.99 | Resolved — web app exists |
| 2 | Price | Monthly only vs monthly + annual | **$4.99/month + $39.99/year** — annual LTV and annual cohort retention are significantly better | Pending |
| 3 | Model for Tier 2 | Haiku vs Sonnet | **Haiku** — 10x cheaper, economics work at any usage level, BYOK users keep Sonnet | Pending |
| 4 | Free trial | None vs 7-day | **7-day free trial** — costs ~$0.04 per trial at Haiku pricing, standard conversion driver | Pending |
| 5 | Build timing | Now vs after BYOK validation | **Test BYOK first** — 3-4 weeks, if 15-20% of active users try to connect a key, build it | Pending |

**When decisions are confirmed, the Tier 2 build is one session:** Stripe products, Supabase `stripe-webhook` edge function, `subscription_active` table, subscription check on launch, Subscribe CTA in Coach view, subscribe page on the web app.

**Apple IAP note**: not needed now. If Mosaic eventually sells in the App Store with in-app subscriptions, Apple takes 30% (15% after year one). At $4.99 that leaves $3.49. Reprice to $6.99 if IAP is added. The Stripe web approach is App Store-compliant as long as the app doesn't link to external payment from within the app UI — users find the web page themselves.

---

## Roadmap

| Phase | What | Effort |
|-------|------|--------|
| Now | BYOK live, snapshot export, session persistence, inline setup | Done |
| Next | Tier 2 subscription (Stripe + entitlement + Haiku) | ~2 weeks |
| Later | Tier 3 full app subscription | 1 sprint after Tier 2 validated |
| Later | Onboarding glass panel introducing AI Coach | 1 day |
| Future | Session memory across weeks (store last 3 briefs in state, include in context) | 1 day |
| Future | Coach-initiated proactive alerts ("Your long run HR has been drifting — here's why") | 1 week |

---

## Key Decisions Needed Before Tier 2

1. **Price point**: $4.99/month confirmed? Or bundle differently?
2. **Trial period**: free trial (7 days, no card) or straight to payment?
3. **BYOK preserved**: BYOK stays as an escape hatch for users who prefer it?
4. **App store**: in-app purchase (Apple takes 30%) vs web checkout (Stripe direct)? IAP is required for App Store subscriptions on iOS. This affects margin meaningfully at $4.99.

Apple IAP take on $4.99 = $1.50, leaving $3.49 revenue. At $0.075/month API cost (5 sessions/day cap), margin is $3.42. Still viable but tighter. Consider $6.99 if going IAP route.
