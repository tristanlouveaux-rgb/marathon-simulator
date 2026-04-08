# Bevel: Competitive Analysis & Feature Inspiration

> Reference doc for tracking what Bevel does well, what Mosaic should build in response,
> and UX patterns worth adopting or improving on.

---

## What Bevel Is

Bevel is a **data aggregation layer** built on top of Apple Watch / Garmin / Oura Ring.
It reads wearable data and adds:

- Recovery/readiness scoring (sleep, HRV, strain)
- Nutrition logging + glucose tracking (CGM integration with Dexcom, FreeStyle Libre)
- A plain-English AI "coaching" layer that narrates what the data means
- Strength Builder (700+ exercises, custom plan generation)
- Energy Bank = a single blended daily score

Its real moat is **vendor independence** — one app that works regardless of which wearable
you own. Raised $10M Series A (Oct 2025, General Catalyst).

**Their own words**: "Your body as a system with inputs (sleep, food, stress), processing
(biology), and outputs (performance). We optimise the system daily."

---

## Bevel vs Mosaic — Quick Map

| Capability | Bevel | Mosaic |
|---|---|---|
| Structured running plans | None | Phase-aware VDOT-driven plan |
| Race time prediction | None | Live-updating, horizon-aware |
| Workout specificity | "Train or rest" | "6×800m @ 3:32/km on Tuesday" |
| Multi-sport fatigue model | Generic strain score | Signal A/B/C, runSpec, iTRIMP |
| Cross-training substitution | None | Replace/reduce runs from padel/gym |
| Injury recovery system | None | 6-phase clinical protocol |
| Periodisation | None | ACWR lightening, quality caps, taper |
| **Recovery score** | Headline daily metric | Exists but buried |
| **Sleep stage detail** | REM / Deep / Light breakdown + quality labels | Aggregated score only |
| **Sleep Bank** | Running surplus/deficit vs sleep need | Not built |
| **Daily narrative** | "Bevel Intelligence" — plain-English why | Coach notes per activity only |
| **Strain score** | Daily total strain as % of capacity | Not surfaced as a concept |
| **HRV trend insight** | Multi-day HRV pattern + correlation (e.g. caffeine) | Point-in-time only |
| **AI chatbot** | Conversational plan generation | Not built |
| Nutrition | Full meal log + CGM | Not relevant — don't build |

---

## Features We Want to Build

### 1. Sleep Analysis — Full Detail View

**What Bevel shows** (see Sleep screenshot):
- Quality ring (e.g. 75%)
- Time in bed vs Time asleep side-by-side
- Sleep stage breakdown: REM / Deep / Light — each rated Good / Excellent / Poor
- Heart rate dip (how much HR dropped during sleep — indicator of recovery quality)
- Wind-down time + Target bedtime
- Plain-English insight card at the top

**Data availability confirmed**: Garmin pushes REM, Deep, and Light sleep seconds to
`sleep_summaries` table. ISSUE-126 (field name mismatch) was fixed 2026-03-20.
REM data is available and verified flowing.

**What we want**:
- Full sleep detail page in the Readiness section of Stats (tapping the sleep sparkline)
- Per-stage breakdown: REM / Deep / Light from `sleep_summaries` (`rem_sec`, `deep_sec`,
  `light_sec`) — confirmed available
- Quality label (Good / Excellent / Poor) per stage based on population norms
- Heart rate dip: `(average_daytime_rhr - sleep_min_hr) / average_daytime_rhr × 100`
- Consultant-tone insight: "REM was below your 7-day average. Threshold run today carries
  higher central fatigue risk."

**What we don't want from Bevel's sleep UX**:
- The dark purple starry background — too wellness/app-store
- "Let's turn this around" phrasing — too motivational
- Wind-down / target bedtime reminders — not our product

---

### 2. Sleep Bank

**What Bevel shows**:
- "Sleep Bank" card with surplus/deficit in hours + a trend chart (orange/blue lines)
- Shows rolling accumulated debt or surplus vs sleep need

**What we want**:
- 7-day rolling sleep bank: sum of (actual_sleep - sleep_need) for the week
- Shown as ±Xh Xm surplus or deficit
- Fed into the recovery model — a 3h sleep debt this week inflates ATL and flags that hard
  sessions will not produce full adaptation
- Surface on the Readiness detail page alongside the sleep sparkline

**Sleep need**: default 8h (configurable in onboarding or account). Garmin sometimes
provides a sleep need estimate — use it if available.

---

### 3. Daily Headline Narrative

**What Bevel shows** (Recovery screen insight card):
> "Feeling ready to move. With a resting HRV of 65.1 ms and resting heart rate at 49.1 bpm
> your recovery is **higher than normal**. You can take advantage of this energy for a
> strong session today."

**What the HRV insight image shows** (Bevel cross-metric analysis):
> "Late caffeine, lower recovery. It seems like your HRV has been **decreasing significantly
> for the last 7 days**. Your sleep looks fine to me, but I've noticed that you recently
> started caffeine late into the afternoon which could have impacted your sleep restfulness."

This is cross-metric pattern detection: HRV trend + sleep + lifestyle habit = one sentence.

**What we want**:
- A single-paragraph coaching insight generated on each app open (or each day)
- Synthesises: HRV, sleep score, RHR, recovery debt, last 3 days' training, planned workout
- Direct, factual, no preamble — consultant tone (see CLAUDE.md writing style)
- Placed prominently on the Home tab — above the plan cards, below the readiness ring
- Example outputs:
  - "HRV 12% below 7-day baseline. Padel session yesterday added 45 TSS. Your threshold
    run today carries higher injury risk — consider moving it to Thursday."
  - "Sleep 6h 20m, fourth consecutive night under baseline. Quality sessions this week
    should be treated as moderate — full adaptation unlikely."
  - "HRV at 7-day high. Resting HR down 3 bpm. Conditions are good for today's long run."

**Rules engine** (not LLM — deterministic to start):
- Input signals: `recoveryDebt`, `wk.actualTSS`, `todayWorkout.type`, `physiologyHistory`
  (HRV, sleep, RHR for last 7 days)
- Priority ranking: recovery debt → HRV trend → sleep debt → load spike → neutral
- Max 2 sentences. One fact, one implication.

**Long-term**: Replace or augment with LLM call to Claude API, passing the signal values
as structured context. The LLM writes the sentence; the rules engine picks which signals
to pass. See Chatbot section below.

---

### 4. Strain Score

**What Bevel shows** (Strain screenshot):
- Circular strain ring (0–100%), colour-coded orange/yellow
- Duration + total energy (kcal)
- Plain-English insight: "You've been on a roll lately, consistently hitting solid strain
  levels... Today you hit your target strain of 50–60%, so now give your body time to recover."
- "Strain Performance" card: shows % above/below personal strain target with "Within target"
  label
- Heart rate zones bar beneath activities
- Activity timeline

**Strain vs Freshness — they are not the same metric**:

| Concept | Bevel name | Mosaic equivalent | What it measures |
|---|---|---|---|
| Today's load | Strain % | Today's Signal B TSS / (daily baseline) | How hard you worked today vs your norm |
| Accumulated fatigue | — | ATL (7-day Signal B EMA) | Rolling recent load — the input to strain |
| Form / readiness | Recovery % | TSB = CTL − ATL (Freshness) | How fresh you are after accumulated strain |

Freshness/TSB is the *inverse* of cumulative strain — it answers "how recovered am I from
all recent work", not "how hard was today". Bevel's Recovery ring (73% recovered) maps
to our TSB concept. Their Strain ring maps to daily acute load — not yet surfaced in Mosaic.

**What we want**:
- Daily strain = `today_signal_b_tss / (signalBBaseline / 7) × 100`
  - 100% = hit your average day's load
  - >100% = above baseline
  - Label: "At target" / "Above target" / "Below target"
- Surface on Home tab — compact metric row alongside readiness ring
- Weekly strain trend already exists as ATL bar in Stats → Readiness — keep it there

**Naming**: Rename user-facing label from "Strain" to "Today's Load". Internal variable
stays Signal B / ATL. Code variable names unchanged.

**Visual**: Circular ring is fine and preferred — it works as a visual hook on the home
screen and on the detail page. Orange/terracotta colour is acceptable (existing brand colour,
not a Whoop clone since our overall aesthetic is clearly different). Do NOT add a second
ring alongside it (no stacked rings pattern).

**Steps as future input**: When Garmin steps data is available, daily step count should
feed into Today's Load as a low-intensity background load signal. A sedentary rest day
and an 18,000-step rest day are meaningfully different physiological states. Placeholder
card to be shown in the detail page until data is available.

---

### 5. HRV Analysis — Trend + Pattern Detection

**What Bevel shows**:
- HRV as a single today's number (ms) with up/down trend arrow
- Multi-day HRV trend analysis: "decreasing significantly for the last 7 days"
- Cross-metric correlation: links HRV trend to a lifestyle change

**What we want**:
- HRV sparkline already exists in Stats → Readiness — good
- Add 7-day trend label: "+8% vs baseline", "−12% vs baseline", "Stable"
- Trend classification: `>+10%` = elevated, `<−10%` = suppressed, else stable
- In the daily headline (see §3): reference HRV trend, not just today's value
- Don't build lifestyle correlation (caffeine, etc.) — we don't have that data

---

### 6. Recovery Screen — Dedicated View

**What Bevel shows** (Image 1 — the best UX of the set):
- Date with tap-to-change (historical browsing)
- Large circular recovery ring (73% recovered) — clean, white background, green arc
- Two stat tiles side by side: Resting HRV (ms) + Resting HR (bpm), each with trend arrow
- Plain-English insight card — the most important element
- "View Recovery insights" CTA
- Timeline: shows sleep session(s) as tappable entries

**What we want**:
- Tapping the Readiness card on Home (or the readiness ring) → dedicated Recovery detail page
- Layout:
  - Recovery score ring (using our existing `computeRecoveryStatus()` output)
  - Two tiles: HRV + RHR with 7-day trend arrows
  - Insight card (from the daily headline engine — §3)
  - "Recovery trend" sparkline (7-day)
  - Sleep session entry (primary sleep last night — duration, quality)
- Keep the Mosaic aesthetic: white/light background, athletic not wellness

**The trend arrows**: up = improving vs 7-day avg. Use `▲` (green) / `▼` (red) / `→` (neutral).
Simple span elements, not SVG — consistent with existing coach notes.

---

### 7. AI Coaching Chatbot (Long-term)

**What Bevel shows** (chatbot screenshot):
- Conversational interface: user types a request, gets a structured response
- "Help me generate a workout plan to focus on upper body. I only have 30 minutes."
- Response includes a named template with exercise list and sets

**What we want (longer-term, post-MVP)**:
- A "Coach" tab or slide-over panel with chat interface
- Full context passed: current VDOT, week's workouts, recovery status, injury state,
  weeks to race, recent load
- Use Claude API (claude-sonnet-4-6 or claude-haiku-4-5 for cost)
- Capabilities:
  - "What should I do today given how I'm feeling?"
  - "Can I move my long run to Saturday?"
  - "Why is my pace getting slower?"
  - "I have 30 minutes — what's the best use of it?"
- Responses are suggestions, not mutations — user taps to apply
- NOT a free-form chatbot about general health. Scoped to training decisions only.

**Positioning**: Bevel's chatbot is about general workout generation. Ours is a
**training assistant** with full context of your marathon plan, load history, and physiology.
That's a much stronger product.

---

## UX Notes from Bevel Screens

### What to adopt

1. **Recovery screen layout** (Image 1 — the best screen in the set):
   - Large ring is the right hero element for a daily readiness score
   - Two horizontal metric tiles (HRV + RHR) is a clean, scannable pattern
   - The insight card — rounded rect, slightly tinted background, 2–3 lines — is a
     reusable pattern we should use for daily narrative across Home and Recovery screens
   - Timeline below the insight feels natural — "here's what fed into this score"

2. **Insight card anatomy** (from both Recovery and HRV screens):
   - Short bold headline (3–6 words)
   - 2–3 sentences below — direct, data-driven
   - Key metrics bolded inline (e.g. "HRV of **65.1 ms**")
   - Expand arrow top-right for full detail
   - Subtle background tint (not a full card shadow — more like `bg-neutral-50` or `bg-blue-50`)
   - This is the pattern for our daily headline feature

3. **Sleep stage breakdown card** (from Sleep screen side panel):
   - Simple labeled rows: "Time asleep", "REM sleep", "Deep sleep", "Heart rate dip"
   - Each row has a quality label right-aligned: Good / Excellent / Poor — in colour
   - Full-width progress bar beneath each label
   - No icons, no emoji — just text + bar. Clean.

4. **Trend arrows on metric tiles**:
   - Small upward/downward triangle next to the number
   - Green up = improving, red/amber down = declining vs baseline
   - Simple and effective — we can use `▲`/`▼` characters

5. **Strain performance card** (from Strain screen):
   - "-13% · Within target" — a single comparative label does a lot of work
   - The equivalent in Mosaic: "Week load at 94% of planned · On track"
   - A small sparkline beneath it adds trend context without taking space

### What not to adopt

1. **Dark purple/starry background on Sleep screen** — too wellness/app-store.
   Mosaic's aesthetic is light, factual, athletic. Keep light backgrounds throughout.

2. **Emoji in insight headlines** ("Feeling ready to move 🌿") — Mosaic copy rules
   explicitly ban emoji in body copy and headlines. The insight card should be text-only.

3. **Circular orange/yellow strain ring** — reads as Whoop clone. We already have our
   zone-bar pattern. Use that.

4. **"Let's turn this around"** phrasing — motivational padding. Not our voice.

5. **Three circular rings on the dashboard** (Strain / Recovery / Sleep) — the dark-theme
   last image shows this pattern. It's busy and the rings compete with each other.
   Our readiness ring is one ring, and it leads into detail — cleaner.

6. **Separate "Strain" tab** — Bevel has strain as its own top-level screen. For Mosaic,
   strain is one signal inside Load, not a primary view. Training plan is primary.

---

## What NOT to Chase

- **Nutrition / meal logging** — not relevant to performance-focused runners. Bevel owns
  this space. We don't need it.
- **Glucose / CGM** — niche, adds complexity, not a runner need.
- **Wearable agnosticism as a marketing feature** — Mosaic already handles Garmin +
  Apple Watch + Strava. Table stakes, not a moat.
- **Social features** — not mentioned by Bevel but a common competitor trap. Skip.

---

## Priority Order for Building

| Priority | Feature | Effort | Data available? |
|---|---|---|---|
| P1 | Daily headline narrative (rules-based) | Medium | Yes — all signals in state |
| P1 | Recovery detail screen | Medium | Yes — `physiologyHistory` |
| P2 | Sleep detail view (stage breakdown) | Medium | Yes — REM/Deep/Light confirmed (ISSUE-126 fixed) |
| P2 | Sleep Bank (rolling 7-day debt) | Small | Yes — need to store sleep need |
| P2 | HRV 7-day trend label | Small | Yes — `physiologyHistory` |
| P2 | Strain daily metric | Small | Yes — Signal B TSS + `signalBBaseline` |
| P3 | Recovery screen historical browsing | Medium | Yes |
| Long-term | AI coaching chatbot | Large | Yes — needs Claude API integration |
