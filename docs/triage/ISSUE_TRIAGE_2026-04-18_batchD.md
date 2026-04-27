# Batch D Triage — UI copy / small features
**Date:** 2026-04-18
**Agent:** Batch D

## Summary
- Issues triaged: 5
- still-broken: 0
- spec-only-not-implemented: 4 (ISSUE-117, 118, 120, 61)
- stale-diagnosis: 1 (ISSUE-121 obsolete)
- blocked-external: 0

## Ready-to-implement (copy-only or small)
- **ISSUE-117** (P2, copy-only): add sub-label "Estimated from last week's load" to future week headers. Quick fix to `plan-view.ts:2254–2270`.
- **ISSUE-118** (P2, copy + optional logic): add 1–2 sentence explanation to matched activity cards. Optional: compute load delta if activity was >10% off plan.

## Worth revisiting design before implementing
- **ISSUE-120** (P3, medium scope): needs new state field (`dailyCheckin`), home-view UI, readiness integration.
- **ISSUE-61** (P3, high scope): race forecast is fixed, but bulk re-pacing is high-risk refactor.

## Obsolete
- **ISSUE-121**: Zone 2 section removed per ISSUE-84. Close.

---

## ISSUE-117: "Preview week" copy should say it will be based on last week

**Plain-English recap:**
Future week headers show only "Week X / Y" with load/km bars, implying the week is fully fixed. Users should understand that durations and pacing adapt based on how they actually trained last week.

**Current code state:**
- `plan-view.ts:2282` — Future week info card reads: "Draft. Final workouts depend on the preceding week's performance."
- Week header (`plan-view.ts:2254–2270`) shows only: "Week [viewWeek] / [total weeks]" + phase label + date range
- No sub-label or badge explaining "estimated from last week's load"

**Does it still reproduce?**
Yes. The "Draft" explanatory card exists but is tucked below the header, not integrated into the week title area. Users see a week header and assume fixed sessions, not adaptive ones.

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
`plan-view.ts:2282` — the draft card exists but is small. Per CLAUDE.md UI copy rules ("Direct and factual. Lead with the point."), a sub-label near the week number (e.g. "Estimated from last week's load") would be clearer.

---

## ISSUE-118: Be more explicit about load matching

**Plain-English recap:**
When a Strava/Garmin activity is matched to a planned session in the activity log, it shows only "Matched" badge with no explanation. Users don't know if the load counted, what impact the activity has on the plan, or whether it was over/under target.

**Current code state:**
- `plan-view.ts:592–607` — Matched activities show name + stats + date + slot name → badge "Matched" + chevron
- `plan-view.ts:601` — If matched to a slot: `→ ${slotName}` appears in sub-line
- No explanatory copy; no delta (e.g. "12% harder than planned") on the card
- Activity detail has "Coach's Notes" (ISSUE-35 Build 3) but not surfaced in the log

**Does it still reproduce?**
Yes. Badge + arrow + slot name give context but no user-facing explanation of what "matched" means. No load delta visible.

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
`plan-view.ts:592` — badge is a plain 9px pill with no supporting text. `plan-view.ts:601` — slot name shown but no sentence explaining the load was accepted. `activity-review.ts:420` mentions matching in a tutorial, not on the card itself.

---

## ISSUE-120: Check-in button — includes illness, injury, and general feeling

**Plain-English recap:**
No lightweight daily check-in exists for subjective wellbeing (illness, injury, or general mood). The app infers recovery only from HR and load data, missing soft signals that could inform readiness.

**Current code state:**
- No `dailyCheckin`/`dailyCheckIn` field in `types/state.ts`
- `checkin-overlay.ts` exists but wired to post-workout RPE rating (ISSUE-34), not pre-workout daily wellbeing
- `readiness.ts` has HRV/sleep/load signals but no subjective input
- ISSUE-82 fix removed mandatory "How are you feeling?" prompt on startup — that was RPE capture, not a daily pre-check-in
- `brain-view.ts` imports `renderFeelingPromptHTML` (ISSUE-130 Phase 2) but form doesn't save back to state yet

**Does it still reproduce?**
Yes. Post-workout RPE capture exists, but no lightweight daily pre-check-in for illness/injury/mood. State structure does not support it.

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
Grepped `types/state.ts` — no check-in fields. `checkin-overlay.ts` wired to RPE, not daily health. Design specifies: "Feeling good / okay / rough / ill / injured." Not implemented.

**Note:** Converges with ISSUE-130 Phase 2 (`todayFeeling`) — this could be built as part of that work.

---

## ISSUE-121: Zone 2 explainer — what Kipchoge's Z2 looks like and why it matters

**Plain-English recap:**
ISSUE-84 marked the standalone HR zones chart obsolete. Zone data is now shown only as compact inline bars in activity detail. This issue asked for a Zone 2 explainer in Stats HR zones chart, which no longer exists.

**Current code state:**
- No "Zone 2" section in `stats-view.ts` (grep: zero matches)
- ISSUE-84: "The standalone HR zones chart no longer exists in stats-view.ts."
- HR zones data rendered only in activity-detail

**Does it still reproduce?**
No — obsolete. The host section was removed as part of ISSUE-84 refactoring.

**Recommendation:** `stale-diagnosis`

**Evidence:**
`stats-view.ts` has no Zone 2 section. No place to add the ⓘ button. Close as obsolete.

---

## ISSUE-61: LT pace / VDOT improvement should update race forecast and plan

**Plain-English recap:**
When VDOT/LT improves, the race forecast now updates dynamically (via `blendPredictions`), but there's no mechanism to offer bulk re-pacing of future sessions. Users see improved forecast times but sessions stay unchanged.

**Current code state:**
- `plan-view.ts:2163` — `_effectiveVdot = (s.v ?? 0) + _wgAccum + (s.rpeAdj ?? 0) + (s.physioAdj ?? 0)`
- Race forecast (`forecastTime`) displayed in Stats — ISSUE-44 / ISSUE-62 fixed
- `blendPredictions()` in `predictions.ts` blends multiple sources — live/dynamic
- `rpeAdj` / `physioAdj` can be set (e.g. `week-debrief.ts:768`) but only via post-week RPE modal
- No mechanism to bulk-re-pace remaining sessions when VDOT improves
- `workoutMods` exists but only for manual or excess-load adjustments

**Does it still reproduce?**
Partial. Race forecast is fixed (dynamic). Missing: "offer to re-pace future sessions when VDOT changes >2pts" — confirmation-gated bulk adjustment.

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
`plan-view.ts` computes race forecast from `_effectiveVdot` (includes VDOT improvements). No trigger logic to detect VDOT change >2pts, compute new durations, or offer confirmation. `rpeAdj`/`physioAdj` are one-time adjustments, not bulk future re-pacing.
