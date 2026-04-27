# Batch E Triage — Garmin / Coach
**Date:** 2026-04-18
**Agent:** Batch E

## Summary
- Issues triaged: 4
- still-broken: 0
- looks-fixed-pending-device-test: 0
- blocked-external: 1 (ISSUE-123)
- spec-only-not-implemented: 3 (ISSUE-132, ISSUE-130 Phase 2, ISSUE-11)
- stale-diagnosis: 0

## Coach feature status snapshot
Coach feature was **refactored, not removed**. `coach-modal.ts` was deleted in favor of a new `brain-view.ts` (dedicated sub-page with LLM narrative as hero content). Phase 1 (compute + edge function + routing) is wired in both home-view and plan-view. Phase 2 signals (`vdotHistory`, `todayFeeling`) have type definitions and helpers but are not yet populated from sources.

## Garmin pipeline status
ISSUE-136 (steps fix, 2026-04-14) **unblocked ISSUE-132 data flow** — steps now flow to `daily_metrics.steps` via webhook. UI integration (Signal B conversion, steps card in strain-view) still missing. ISSUE-123 remains **blocked on ISSUE-134** (Garmin userMetrics push not enabled in developer portal).

---

## ISSUE-123: HR zones / LT threshold should auto-pull from Garmin, not require manual input

**Plain-English recap:**
The app should auto-populate LT HR and zones from Garmin's physiology endpoint, but the Garmin userMetrics push (which contains `lactateThresholdBpm`) is not enabled in the developer portal. Currently no LT HR data flows in, and there is no UI to display or override Garmin-sourced values.

**Current code state:**
- `supabase/functions/sync-physiology-snapshot/index.ts:59,68` — reads `lt_heart_rate` and `lactate_threshold_pace` from `physiology_snapshots` (schema exists)
- `src/ui/account-view.ts` — no LT HR display, no override toggle, no source labelling
- `supabase/functions/garmin-webhook/index.ts:59` — `handleUserMetrics` exists but receives zero payloads

**Does it still reproduce?**
Yes. Design spec is clear but implementation is stalled. Blocker is external: Garmin developer portal access needed to enable **User Metrics** data type / push subscription. Once enabled, webhook receives payloads and physiology_snapshots populates. Then UI integration is straightforward.

**Recommendation:** `blocked-external`

**Evidence:**
ISSUE-134 (confirmed 2026-04-14): "Garmin webhook logs show only `dailies` and `stressDetails` pushes — zero `userMetrics` pushes have ever arrived." Portal access issue flagged by Tristan on 2026-04-14. Code is wired; data isn't flowing.

---

## ISSUE-132: Garmin daily steps as background load signal in Today's Load

**Plain-English recap:**
The app should pull daily step counts from Garmin and show them as a background load signal in the Today's Load detail page. ISSUE-136 fixed the webhook to flow steps into `daily_metrics.steps` (2026-04-14), unblocking the data, but the UI integration (Signal B conversion, steps card, placeholder) is not yet implemented.

**Current code state:**
- `supabase/functions/sync-physiology-snapshot/index.ts:46` — reads `steps` from daily_metrics merge
- `src/types/state.ts:546` — `PhysiologyDayEntry` has `steps?: number` field
- `src/ui/strain-view.ts` — no steps card, no placeholder, no Signal B conversion logic

**Does it still reproduce?**
Data flow is unblocked. Steps are now in state. However, UI layer is not wired: no card rendering, no TSS-per-step calculation, no integration into Signal B load display. The issue has shifted from `blocked-external` to `spec-only-not-implemented`.

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
ISSUE-136 (2026-04-14): "Confirmed on-device: steps flowing to strain view." However, no code in strain-view.ts converts steps to a load contribution or renders a steps card. The placeholder card specced ("Show as a 'Steps' placeholder card on the Today's Load detail page") doesn't exist.

---

## ISSUE-130: Coach Brain — deploy edge function + Phase 2 signals

**Plain-English recap:**
Coach modal was refactored into a dedicated Brain sub-page with the LLM narrative as the primary content. Phase 1 (daily coach computation, LLM edge function, routing) is fully built. Phase 2 signals (VDOT sparkline history, aerobic efficiency trend, subjective daily feeling) have state types and helpers but no data population logic.

**Current code state:**
- `src/calculations/daily-coach.ts` — `computeDailyCoach()` exists, exports `CoachState`, `CoachSignals`, `StrainContext`
- `supabase/functions/coach-narrative/index.ts` — hardened LLM edge function with rate limiting, signal caching, 400 max_tokens
- `src/ui/brain-view.ts` — new sub-page view with narrative hero + accordion signal details
- `src/ui/home-view.ts:1980` — Coach button wired (`home-coach-btn`)
- `src/ui/plan-view.ts:2265` — Coach button wired (`plan-coach-btn`, current week only)
- `src/ui/plan-view.ts:2346-2347` — Router calls `renderBrainView()` on click
- `src/types/state.ts:521,537` — `vdotHistory?: Array<{week, vdot, date}>`, `todayFeeling?: {value, date}`
- `src/calculations/daily-coach.ts:157-163` — `getTodayFeeling()` helper with date expiry check

**Does it still reproduce?**
Feature is not broken — it's in mid-phase. Git status shows `src/ui/coach-modal.ts` as deleted (D), which may alarm, but it was intentionally replaced by `brain-view.ts` with a better UX. Deployment status cannot be verified from code alone, but the edge function is production-hardened. Phase 2 signals are typed but not populated: no code writes to `vdotHistory` on week advance, no check-in form saves `todayFeeling`.

**Recommendation:** `spec-only-not-implemented` (Phase 2 signals)

**Evidence:**
- Brain-view exists and is routed correctly (plan-view:2347 imports it on Coach button click).
- Coach-modal.ts deletion is a refactor, not removal — brain-view.ts is the replacement.
- `vdotHistory` and `todayFeeling` type signatures exist (state.ts:521,537) but grep shows no write sites. No `s.vdotHistory.push()` or `s.todayFeeling = ...` in events.ts or initialization.ts. Feeling prompt UI exists (brain-view:30 imports `renderFeelingPromptHTML`), but the form doesn't save back to state yet.

---

## ISSUE-11: Auto-slot cross-training load before week completes

**Plain-English recap:**
When Signal B load is below the weekly target and the user has unused cross-training capacity, the app should suggest adding a session. This feature does not exist; ISSUE-125 (fixed 2026-04-08) addressed a similar underload case but only for running km floor, not cross-training TSS.

**Current code state:**
- `src/ui/plan-view.ts:1792-1891` — km floor nudge card applies to **running distance only**, not TSS/cross-training
- `src/ui/events.ts:1117-1133` — km nudge logic reads `floorKm`, suggests adding to easy runs
- No grep matches for `auto-slot`, `underload`, `suggest adding`, or `cross-training suggestion` in plan-view.ts or home-view.ts
- `plan-view.ts:2620-2688` — km nudge apply/dismiss handlers for running sessions only

**Does it still reproduce?**
Feature is not implemented. ISSUE-125's km floor nudge is **distinct**: running km shortfalls (distance), not Signal B TSS shortfalls (load). Cross-training capacity and TSS underload detection are not wired.

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
ISSUE-125 fix explicitly says "Green nudge card for km floor" — distance only. Km nudge applies only to running workouts. No code checks weekly Signal B target vs actual or scans for unused cross-training capacity slots. Design is in OPEN_ISSUES.md but no code matches the spec.
