# AI Coach — Audit & Roadmap to the Best AI Coach We Can Ship

**Owner**: Tristan + Claude
**Last updated**: 2026-05-13
**Status**: Live for allowlisted users (Tristan only); paywall + Stripe deferred.

This audit captures every gap between the current AI Coach build and "the best AI product we can". Items are ranked P0 (ship blockers) / P1 (quality leaps) / P2 (polish). Each item has a current state, target state, and how to get there.

---

## North star

The AI Coach is the **explainability + tweakability layer** on top of Mosaic's deterministic plan engine. The plan engine is the source of truth for *what to do*; the coach explains *why* and proposes *what to change*. Every change reaches the plan via a confirmed tool call. Free-text is the fallback; chips and Apply cards are the primary interaction.

Three qualities to optimise for, in priority order:

1. **Trust** — the coach is honest about uncertainty, refuses scope cleanly, never makes a change without explicit user confirmation, never hallucinates numbers. The data it reads must match the data the user sees on the Plan/Stats screens.
2. **Usefulness** — it can explain the shape of the program, answer "why?" with real reasons (phase, recent training, race goal), and propose specific changes the user wouldn't have figured out themselves.
3. **Smoothness** — fast first response, no silent failures, every action has visible feedback, no contamination across sessions, easy reset.

A coach that says nice things but never changes the plan is a chatbot.
A coach that changes the plan without explaining is dangerous.
We want both, every turn.

---

## Audit findings (as of 2026-05-13)

### Block 1 — Apply path is fragile (P0)

The single most damaging bug class today. The user taps Apply, state mutates, but the plan view doesn't visibly change because the underlying mutation only updates internal fields (`estimatedDurationMin`, `status`) while the card reads from text fields (`w.d`, `w.n`).

- [x] **1.1 — Toast confirmation on Apply.** ✅ Shipped 2026-05-13. After Apply, a "Applied: … Open Plan to view." toast appears for 3s.
- [x] **1.2 — Scale `w.d` description on reduce_workout.** ✅ Shipped 2026-05-13. Metres, km, hours, and minute tokens are scaled by factor. Known to mis-scale exotic descriptions (P1 to deepen).
- [x] **1.3 — Tag `w.n` on reduce.** ✅ Shipped 2026-05-13. Workout name suffixed with "(reduced X%)" so the card is unambiguously different.
- [ ] **1.4 — Verify all four tools update visible fields**: swap, reduce, skip, adjust_intensity. Audit each Apply branch and confirm the plan card actually changes after Apply. Skip likely needs to hide or strikethrough the card.
- [ ] **1.5 — Recompute weekly TSS / planned hours after Apply.** Today the card might show 2310m but the week-load chip still shows the original TSS. Either trigger a recompute or stale-flag the load.
- [ ] **1.6 — Plan-view dirty refresh.** When Coach mutates the current week and the user navigates back to Plan, force a re-render so they don't see stale DOM from before the change.
- [ ] **1.7 — Undo Apply.** A small "Undo" link on the toast that reverses the last Apply. Snapshots the workout before mutation, restores on tap.

**Why P0**: the user lost trust in the entire feature when they tapped Apply and the swim card looked identical. Same for any future user.

### Block 2 — Tool-call reliability (P0)

The model has to *fire* tools, not narrate them. We had a recurring failure where Haiku described changes in prose and never emitted a tool_use block.

- [x] **2.1 — Per-day workout_index in context.** ✅ Shipped 2026-05-13. Each workout in `this_week_plan` carries the index the validator expects.
- [x] **2.2 — Name-based fallback in resolver.** ✅ Shipped 2026-05-13. If the index is wrong, the validator tries to match by `workout_name`, then falls back to "the only workout on that day if there's just one".
- [x] **2.3 — Aggressive tool-fire prompt rules.** ✅ Shipped 2026-05-13. Explicit "Describing a change in prose does nothing — it must be a tool call. Narrating a change without firing the tool is a failure mode."
- [ ] **2.4 — Add a `force_tool_use` mode**: if the user message exactly matches a directive pattern (regex: `^(reduce|cut|swap|skip|shorten).+(today|tuesday|wednesday|monday|thursday|friday|saturday|sunday|tomorrow)`), set `tool_choice: { type: "any" }` on the Anthropic call to force a tool. Falls back to "auto" for ambiguous chat.
- [ ] **2.5 — Few-shot tool-call examples in the system prompt.** Three concrete worked examples of input → tool call (with `day`, `workout_index`, `workout_name`, `reason`) so Haiku has a template.
- [ ] **2.6 — Surface "tool dropped" telemetry.** Log at the edge function any time `validateAndBuildPendingChange` returns null, with the tool name + reason. We can't fix what we can't measure.
- [ ] **2.7 — Test harness for tool calls.** ~20 representative user messages → expected tool. Run before any prompt change. Currently zero tests.

**Why P0**: when this fails, the entire product feels broken even if the model is doing 90% of the work correctly.

### Block 3 — Context completeness (P1)

The coach can only reason about what's in the context. Today the payload is ~3K tokens — adequate for this-week-detail but blind to the program shape.

- [ ] **3.1 — Plan skeleton (all weeks).** Per-week summary: phase, planned TSS, planned km/hours, key session names. ~50 chars per week × 16 weeks = ~800 tokens. Enables "why is this week threshold-heavy?" with real reasons.
- [ ] **3.2 — Next 2 weeks in full detail.** Workout list with paces/RPE for the next 14 days, not just this week. Prevents tool calls that cascade badly into a key session.
- [ ] **3.3 — Adaptation log.** Marker bump history, race-prediction trend (last 8 weekly entries), effort-multiplier evolution, plan-reset notes. Tells the coach "they've been chronically skipping easy days" or "marker just bumped 3% last week".
- [ ] **3.4 — Goal evolution.** Initial forecast vs current forecast vs goal. "You started predicted 3:20 marathon, you're now tracking 3:15, your goal is 3:10."
- [ ] **3.5 — Token-budget guard.** Warn (or truncate adaptation log first) if input exceeds 10K tokens.
- [ ] **3.6 — Context compression discipline.** Use short field codes for the plan skeleton (`p=build`, `t=148` for TSS) so 16 weeks fits in ~600 tokens. Reserve verbose fields for current + next 2 weeks only.

**Why P1**: this is the biggest single quality lever — moves the coach from "knows this week" to "knows the program".

### Block 4 — Conversation UX (P1)

Free-text typing is high-friction on mobile. The chip-suggested replies pattern (LLM emits `<choices>...</choices>`, UI renders tappable pills) gives the user one-tap responses without losing free-text flexibility.

- [ ] **4.1 — `<choices>` parser in stream client.** Extract `<choices>...</choices>` blocks from the streamed text and render below the assistant message.
- [ ] **4.2 — Chip rendering.** Tappable pills (canonical pattern from `docs/UX_PATTERNS.md`). Tapping sends the chip text as the next user message.
- [ ] **4.3 — Prompt rule for chip emission.** "End every assistant turn with 2-4 short replies the athlete might give next, wrapped in `<choices>...</choices>`. Keep each under 8 words. Omit only on purely informational turns."
- [ ] **4.4 — Tool-call follow-up chips.** After an Apply card, suggest "Apply", "Skip", or a variant ("Try 20% instead") as chips. Currently the user has to think about the next move.
- [ ] **4.5 — Markdown stripping in formatAsHTML.** ✅ Already shipped — strips `**`, `*`, `` ` ``, headings, bullets.
- [ ] **4.6 — Em-dash policing.** Haiku occasionally outputs em-dashes despite the prompt forbidding them. Defensive replace `—` → `,` in `formatAsHTML`.
- [ ] **4.7 — Stream typing indicator.** While waiting for the first text delta, show three pulsing dots instead of "Reviewing your week…". The animation is in the prompt design already.
- [ ] **4.8 — Auto-scroll thread on new content.** Currently the user has to scroll manually when the assistant reply pushes content below the fold.

**Why P1**: massively reduces friction. Most coaching turns can be one-tap.

### Block 5 — Onboarding & discoverability (P1)

- [x] **5.1 — One-time intro overlay on first open.** ✅ Shipped 2026-05-13. "Meet your Coach" with three sections (What I do / What to ask / What I won't do).
- [x] **5.2 — Persistent `?` help button.** ✅ Shipped 2026-05-13. Re-opens the intro overlay anytime.
- [x] **5.3 — Fresh-session `↻` button.** ✅ Shipped 2026-05-13. Discards thread, streams a new brief — kills contamination across turns.
- [ ] **5.4 — First-time tip on the input bar.** Tiny coachmark above the input: "Try: 'reduce Tuesday's swim by 20%'". Dismissed after first send.
- [ ] **5.5 — Reveal in Plan view.** A one-time toast on Plan view: "AI Coach can change these workouts. Open Coach to ask." Gated by `coachRevealSeen`.
- [ ] **5.6 — Settings entry-point.** Account view today shows "AI Coach — Coming soon" for non-allowlisted users. For allowlisted users, surface a small card: "AI Coach: active. Session resets on plan-week advance."

**Why P1**: zero onboarding means the user has no mental model of what to ask. Even good responses get under-used.

### Block 6 — Safety & abuse defence (P1)

Currently good for one trusted user. Needs hardening before paywall.

- [x] **6.1 — Refusal patterns in system prompt.** ✅ Shipped 2026-05-13. Explicit refusal + redirect for medical/nutrition/technique/equipment/role-play/jailbreak.
- [x] **6.2 — Don't reveal the system prompt.** ✅ Shipped 2026-05-13.
- [ ] **6.3 — Adversarial prompt test set.** 30 known jailbreak templates + 10 medical/nutrition questions. Run before every prompt change. Auto-fail any test that gets a non-refusal.
- [ ] **6.4 — Per-month spend cap per user.** Today: 30/day. Add monthly cap (e.g. 300/month) for sustained-abuse defence at paywall scale.
- [ ] **6.5 — Output content filter.** Defensive scan of assistant output for forbidden tokens (drug names, medical procedure terms) before delivery. Probably overkill at Mosaic scale but worth the 15 lines of code.
- [ ] **6.6 — Anthropic content moderation.** Use Anthropic's `messages-batches` content moderation endpoint on suspicious input. Free tier.
- [ ] **6.7 — Rate limit a user that gets refused 5 times in a session.** Temporary cooldown to discourage probing.

**Why P1**: before opening the paywall to real users, every one of these matters.

### Block 7 — Quality, evals, observability (P1)

- [ ] **7.1 — Eval harness.** A set of ~30 scenarios (signal × phase × directive) with expected behaviour. Run on every prompt change. Outputs a per-scenario pass/fail grid.
- [ ] **7.2 — Output telemetry.** Log: turn count per session, tool-call rate, refusal rate, mean response latency, p95 latency, mean tokens out. Aggregate in a Supabase view.
- [ ] **7.3 — User feedback loop.** Thumbs up/down on assistant messages. Store with the message hash. Use for prompt iteration.
- [ ] **7.4 — Cost dashboard.** Supabase view: tokens × users × day. Alert if any user's monthly cost > $1 (signals abuse or bug).
- [ ] **7.5 — Tone drift watch.** Periodic manual review of 10 random transcripts. Watch for "listen to your body" / "trust the process" creep.

**Why P1**: you can't improve what you don't measure.

### Block 8 — Tool surface (P2)

Today's four tools cover the most common cases but miss some natural directives.

- [ ] **8.1 — `move_workout` tool.** "Move Tuesday's swim to Wednesday." Shifts day-of-week. Validates against the user's commute / recurring schedule.
- [ ] **8.2 — `add_easy_session` tool.** "Add a 30-minute easy run on Friday." Only for empty days. Validates against weekly load budget.
- [ ] **8.3 — `bulk_reduce_week` tool.** "Cut this whole week 30%." Applies reduce_workout across every workout in the week. One Apply card, multi-workout effect.
- [ ] **8.4 — `set_intent` tool.** "I want to focus on bike this week." Sets a non-mutating flag the next plan-engine cycle reads as input.

**Why P2**: nice-to-have. Today's four tools cover ~80% of intent.

### Block 9 — Subscription / paywall (P2)

Deferred. Tracked here for completeness.

- [ ] **9.1 — Replace allowlist with `subscription_active` table.** Server reads the table per request.
- [ ] **9.2 — Stripe Checkout** for subscription creation (web app at `mosaic-theta-lac.vercel.app`).
- [ ] **9.3 — Stripe webhook** → upsert `subscription_active`.
- [ ] **9.4 — Client-side entitlement check** via `checkAiSubscription()` on launch, sets `s.aiCoachSubscriptionActive`.
- [ ] **9.5 — Subscription CTA** in Coach view for non-subscribers (replaces today's "coming soon").
- [ ] **9.6 — Cancel / manage** via Stripe customer portal link in Account view.

**Why P2**: real money but not the bar to a great product. Build only when Tier 1 validation says yes.

### Block 10 — Visual polish (P2)

- [ ] **10.1 — Avatar / icon for the coach.** A small consistent visual identity in the header instead of plain "Coach" text.
- [ ] **10.2 — Brief paragraph spacing.** Currently dense. 16px line-height with slightly larger paragraph gap reads better.
- [ ] **10.3 — Apply card visual hierarchy.** The headline / reason / button stack works but could carry the workout's icon (swim/bike/run) for context.
- [ ] **10.4 — Loading shimmer instead of "Reviewing your week…".** A canonical skeleton block in the brief area while streaming.
- [ ] **10.5 — Empty-state for the thread when no chat has happened.** Today it's a blank scroll area; a one-liner "Ask anything about this week" would help.

**Why P2**: doesn't change capability, but matters for App Store screenshots and first-impression.

---

## Sequencing

The aim is to get to a state where the coach feels excellent for Tristan dogfooding, *before* Stripe ships and real users arrive. Suggested order:

### Sprint 1 — "It always works" (P0 closure)
- 1.4 verify all tools update visible fields
- 1.5 recompute weekly TSS after Apply
- 1.6 plan-view dirty refresh
- 2.4 force_tool_use for clear directives
- 2.5 few-shot examples in prompt
- 2.6 surface tool-dropped telemetry

**Outcome**: never another silent failure. Every Apply produces a visible plan change.

### Sprint 2 — "It knows the program" (P1 quality leap)
- 3.1 plan skeleton in context
- 3.2 next 2 weeks in full
- 3.3 adaptation log
- 3.4 goal evolution
- 4.1–4.4 chip replies

**Outcome**: the coach can explain *why* and propose *what's next*. Conversation feels native to mobile.

### Sprint 3 — "It's safe to open" (paywall-ready)
- 5.4–5.5 first-time tips
- 6.3–6.7 abuse defence + adversarial test set
- 7.1–7.5 eval harness + telemetry
- 9.1–9.6 Stripe + subscription_active

**Outcome**: ready to open the paywall, with measurement in place to catch regressions.

### Sprint 4 — Polish (P2)
- 8.x richer tool surface
- 10.x visual polish

**Outcome**: App Store-worthy.

---

## What "best AI product" looks like in 12 weeks

A returning user opens Mosaic. Coach view shows:

- A 4-sentence brief that synthesises today's readiness, this week's plan, and an emerging pattern from the last 3 weeks ("you've under-shot easy runs three weeks running — the threshold sessions are still landing, so we'll leave them alone").
- Three tappable chips below: "Cut this week 20%", "Push the long run to Sunday", "Tell me about Saturday's bike".
- If they ask "why is this week threshold-heavy?", they get a real answer ("you're week 11 of 16, in sharpening phase, last block was aerobic base — this week's threshold mileage is the first race-specific intensity").
- If they tap "Cut this week 20%", an Apply card lists every affected workout. One tap applies all. Toast confirms. Plan view shows the new numbers immediately.
- If they ask anything outside training — supplements, recovery techniques, nutrition — the coach refuses cleanly and redirects them to a qualified professional.

That's the product. The list above is how we get there.
