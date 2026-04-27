# Issue Triage — Morning Summary
**Date:** 2026-04-18
**Scope:** 23 open issues (all non-✅ items, excluding `[ui-ux-pro-max]`, "To Be Discussed", and ON HOLD)
**Source reports:** `batchA.md` · `batchB.md` · `batchC.md` · `batchD.md` · `batchE.md` in this folder

---

## TL;DR

| Status | Count | Issues |
|---|---|---|
| **looks-fixed-pending-device-test** | 3 | ISSUE-137, 138, 135 |
| **still-broken** (ready to implement) | 2 | ISSUE-131, 90 |
| **stale-diagnosis** (close or re-investigate) | 3 | ISSUE-133b, 91, 121 |
| **blocked-external** | 2 | ISSUE-123, 133a |
| **spec-only-not-implemented** | 13 | 145, 98, 146, 92, 119, 122, 117, 118, 120, 61, 132, 130-Phase2, 11 |

---

## 🟢 Device-test these 3 — could close tomorrow

All three have code changes already landed and verified in-tree. Device test is the only gate.

1. **ISSUE-137** (Excess-load modal hides Reduce when a tempo remains)
   - Fix verified at `suggester.ts:535, 555` + `suggestion-modal.ts:390–445`. Tests pass.
   - Reproduction: 5 cross-training activities + tempo remaining on the plan. Open excess-load modal → Reduce should now appear.

2. **ISSUE-138** (Recovery workout tier — easy → recovery downgrade)
   - All 6 wiring sites verified. 210 cross-training tests pass.
   - Reproduction: easy-only week pushed over target → Reduce should offer easy → recovery.
   - Still provisional: `LOAD_PROFILES.recovery` constants (0.98/0.02/0.99/0.01/0) and pace multiplier `× 1.12`. Sign-off needed regardless.

3. **ISSUE-135** (Race prediction optimistic when VO2/LT stale)
   - Self-healing path confirmed: `predictFromLT` derives tier from LT pace, `blendPredictions` wired in both stats-view cards, `s.v` corruption migration in persistence.ts.
   - Reproduction: open Stats, check marathon forecast against a recently-updated physiology sync.

---

## 🔴 Close these — stale or obsolete

1. **ISSUE-133b** (Freshness + Injury Risk detail pages parity with Recovery)
   - Batch B found `freshness-view.ts` and `injury-risk-view.ts` **already fully implemented** with same design language as Recovery. Close as done.

2. **ISSUE-121** (Zone 2 explainer in Stats HR zones chart)
   - The HR zones chart was removed in ISSUE-84. No host section exists. Close as obsolete.

3. **ISSUE-91** (Plan restart nondeterminism) — *reclassify*
   - No `Math.random` in wizard. `softResetState` preserves `confirmedRunnerType`. Needs a targeted look at `state/initialization.ts` before close — the diagnosis in OPEN_ISSUES.md is stale. Recommend: drop priority or spin a 15-min investigation.

---

## 🟡 Ready to implement (no design questions)

Sorted by blast radius (smallest first):

1. **ISSUE-117** (Future-week copy) — *copy-only, single file*
   Add sub-label "Estimated from last week's load" to `plan-view.ts:2254–2270`. The existing "Draft" card already covers the intent but is buried.

2. **ISSUE-131** (Rolling-median RHR for iTRIMP) — *narrow, well-scoped*
   Pull 7-day median from `physiologyHistory` in `resolveITrimp` (`activity-matcher.ts:382–394`) before passing to `calculateITrimpFromSummary`. Infrastructure (state field) already exists.

3. **ISSUE-118** (Matched-activity copy + optional delta)
   Add 1–2 sentence explanation to matched cards in `plan-view.ts:592–607`. Optional: compute load delta if activity >10% off plan.

4. **ISSUE-90** (LT threshold setup guidance) — *copy + small UI*
   Add "where to find LT HR in Garmin" help text to `wizard/steps/physiology.ts:60–74`. Independent from ISSUE-123 auto-pull (which is blocked).

5. **ISSUE-146** (Best-fit activity matcher fallback)
   Add scoring fallback in `activity-matcher.ts` when primary match fails. Distance + pace + HR score. Present as "Looks like this was your [Tempo]?" with gate threshold + "None of these".

6. **ISSUE-98** (Activity card sport-type breakdown)
   Add sport-type row to activity load card in `activity-review.ts` / `excess-load-card.ts` when week has multiple sports.

7. **ISSUE-92** (Historic load scan before plan start) — *needs design sketch*
   After Strava backfill in `wizard/steps/initializing.ts`, show "We found X activities over N weeks · Avg Y TSS · Ramp Z%."

8. **ISSUE-119** (App explainer screen) — *copy + one new step*
   Add "Here's how it works" (3 bullets) between welcome and connect-strava.

---

## 🟠 Needs design discussion before implementing

1. **ISSUE-145** (Speed-profile marathon baseline) — **P1**, but 5 fix options a–e and per CLAUDE.md "no made-up constants". Needs your pick + literature backing. Dedicated science session.

2. **ISSUE-120** (Daily subjective check-in) — converges with **ISSUE-130 Phase 2** (`todayFeeling`). Build them together. Question: where does the prompt live — Home button or Brain sub-page entry?

3. **ISSUE-61** (Bulk re-pace on VDOT improvement) — forecast is already live. Missing: detect VDOT >2pt change + offer bulk workoutMods. High-risk refactor; decide UX first.

4. **ISSUE-122** (Training goals step) — 8 options in spec; goal drives plan tone + cross-training weighting. Confirm how goals actually affect plan generation before wiring.

5. **ISSUE-11** (Auto-slot cross-training on underload) — distinct from ISSUE-125's km floor nudge. Needs a design pass: when does the nudge fire, what does it suggest.

---

## 🔵 Blocked — not Claude work

- **ISSUE-123** (Garmin LT/zones auto-pull) — blocked on ISSUE-134 (Garmin dev portal userMetrics enablement).
- **ISSUE-133a** (HR drift edge-fn) — code exists in edge fn per Batch B; needs Supabase redeploy of `sync-strava-activities`. **Interesting:** ISSUE-35 Build 2 claimed drift was built but needed redeploy. Same blocker.

---

## 📝 Interesting findings from triage

1. **ISSUE-133b already shipped** — `freshness-view.ts` + `injury-risk-view.ts` exist with Recovery-parity design. OPEN_ISSUES.md hasn't caught up. Close tomorrow.

2. **Coach feature was refactored, not deleted** — the `D src/ui/coach-modal.ts` in git status looks alarming but it's replaced by `brain-view.ts` (sub-page with LLM narrative as hero). Phase 1 is functional; Phase 2 signals (`vdotHistory`, `todayFeeling`) have type defs + helpers but no write sites.

3. **ISSUE-132 is now a UI-only task** — ISSUE-136 (2026-04-14) fixed the webhook so `daily_metrics.steps` populates. The "blocked by Garmin steps pull" label in OPEN_ISSUES is out of date. What remains: steps → Signal B conversion + strain-view card.

4. **ISSUE-133 is numbered twice** — one for HR drift, one for Freshness/Injury parity. Please renumber or consolidate.

5. **ISSUE-91 diagnosis is stale** — no randomness in wizard code. If the bug is real, it's in `state/initialization.ts`, not the wizard. Worth a 15-min re-investigation rather than leaving open indefinitely.

---

## Suggested next-session agenda

**Morning quick wins** (all low-risk, ≤ 1 hour each):
1. Device-test ISSUE-137 → if it works, mark fixed
2. Device-test ISSUE-138 → sign off on provisional recovery-tier constants, mark fixed
3. Close ISSUE-133b and ISSUE-121 in OPEN_ISSUES.md
4. Renumber duplicate ISSUE-133

**Afternoon implementation** (pick 1–2):
- ISSUE-131 (rolling RHR) — highest-impact code-only item
- ISSUE-117 + ISSUE-118 (copy) — batch these together
- ISSUE-90 (LT setup guidance)

**Deferred until design session:**
- ISSUE-145 (marathon multipliers — needs literature)
- ISSUE-120 + ISSUE-130 Phase 2 (check-in + feeling — build together)
- ISSUE-122 (goals step — confirm plan-gen impact first)
