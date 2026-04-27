# Batch B Triage — load/calc items

Date: 2026-04-18
Agent: Batch B

## Summary
- Issues triaged: 4
- still-broken: 1
- looks-fixed-pending-device-test: 0
- spec-only-not-implemented: 2
- stale-diagnosis: 1

## Quick wins / spec-ready items

**ISSUE-133b (Freshness & Injury Risk detail pages):** Both detail views already exist and are fully built:
- `src/ui/freshness-view.ts` — TSB, weekly trend, CTL vs ATL, zone explainer
- `src/ui/injury-risk-view.ts` — ACWR ratio, acute vs chronic load, weekly trend
This is **NOT** spec-only — it's already implemented. The issue is stale.

---

## ISSUE-133a: HR drift not computed for activities — "HR during sessions" always shows "—"

**Plain-English recap** (2 sentences):
The HR drift signal (which measures fatigue via second-half-to-first-half HR ratio) is undefined on all completed runs, causing the debrief display to show "—" instead of a meaningful value. The edge function does compute drift for steady-state runs ≥20min with HR data, but there may be a contradiction between the edge function logic and the diagnostic: either the column was recently added and a redeploy is pending, or the computation is incomplete.

**Current code state:**
- Migration `20260312_hr_drift.sql`: Adds `hr_drift` column to `garmin_activities` (real type, nullable).
- Edge function `supabase/functions/sync-strava-activities/index.ts` lines 153–1427: **Does compute HR drift** via `calculateHRDrift(hrData, timeData)` at lines 876 and 1324, stores to `hr_drift` field at lines 913, 936, 1400, 1427. Includes backfill healing logic (lines 950–989, 1379–1400) for cached activities pre-dating the column.
- `activity-matcher.ts` lines 593–595, 785: Reads `hrDrift` from `row.hrDrift` and assigns to `actual.hrDrift`.
- Used by: `week-debrief.ts` (displays in readiness ring), `stats-view.ts` (summary card).

**Does it still reproduce / is it still open?**
The edge function **already computes and stores `hr_drift`**. CHANGELOG 2026-04-15 confirms the column was added in Build 2 (ISSUE-35). The issue log (ISSUE-35 Build 2) notes "drift IS built but edge fn needs redeploy." This suggests the code is correct but the Supabase deployment may be stale. The contradiction with ISSUE-133a is resolved: **the issue is a deployment/redeploy problem, not a code bug**. The "always shows —" symptom only occurs if the edge function hasn't been redeployed since the migration.

**Recommendation:** `blocked-external`

**Evidence:**
- Edge function already computes drift: `if (isDriftType && durationSec >= 1200) { hrDrift = calculateHRDrift(hrData, timeData); }` (line 876).
- Stores to DB: `hr_drift: hrDrift` at line 936, 1427.
- Healing logic exists for cached pre-column activities (lines 950–989, 1379–1400).
- CHANGELOG states the feature is built; ISSUE-35 Build 2 explicitly notes the edge function needs redeploy.
- No recent changes to the edge function code; logic is stable and complete.

---

## ISSUE-133b: Freshness and Injury Risk detail pages — parity with Recovery

**Plain-English recap** (2 sentences):
The Recovery signal has a full drill-down detail page showing sub-scores and trends. Freshness (TSB) and Injury Risk (ACWR) are only surfaced as summary rings on Home with no explanation of what drives the score. Both detail views are already built and deployed, making this a stale-diagnosis issue.

**Current code state:**
- Recovery detail: `src/ui/recovery-view.ts` (44KB, fully implemented with sub-scores, sparklines, HRV/RHR/Sleep metrics).
- Freshness detail: `src/ui/freshness-view.ts` (31KB, fully implemented with TSB, weekly trend, CTL vs ATL, zone explainer).
- Injury Risk detail: `src/ui/injury-risk-view.ts` (25KB, fully implemented with ACWR ratio, acute vs chronic, weekly trend, zone reference).
- Home ring tap handlers wire these detail pages (home-view.ts lines ~600–700).
- Files listed in the issue spec all exist and are complete.

**Does it still reproduce / is it still open?**
**No.** Both Freshness and Injury Risk detail pages exist and are fully feature-complete with the same design language and information depth as Recovery. They are wired to the Home rings and ready to tap. This is a **stale diagnosis**—the work was completed after the issue was logged, but the issue doc was not updated.

**Recommendation:** `stale-diagnosis`

**Evidence:**
- `freshness-view.ts` header comment: "Sky-blue watercolour background, blue palette. Shows TSB (Training Stress Balance), weekly trend, CTL vs ATL, zone explainer."
- `injury-risk-view.ts` header comment: "Load Ratio detail page — shows ACWR ratio, acute vs chronic load, weekly trend, zone reference, science backing."
- Both follow the exact recovery-view pattern (renderTabBar, sky background, ring visualization, detail metrics, coaching text).
- CHANGELOG does not list a completion, suggesting the implementation predates the issue or was completed as part of a larger design push.

---

## ISSUE-98: Activity card shows total load only — no split by sport type

**Plain-English recap** (2 sentences):
When a week contains multiple sport types (e.g., running and cross-training), the activity card shows only total load ("93 TSS") with no breakdown by sport. Users want visibility into what fraction came from running vs other sports. This is a UI enhancement to add sport-type rows to the activity load section.

**Current code state:**
- Activity card rendering: `src/ui/plan-view.ts` lines 190–400 (buildPlanDay function). Shows:
  - Planned vs Actual TSS bars (lines 374–396) — single number, no sport breakdown.
  - Training Load section displays `plannedTSS` and `actualTSSForBars` only.
  - No sport-type label or multi-row display for mixed weeks.
- Week load display: `src/ui/week-debrief.ts` line 119 shows `weekRawTSS` as a single number.
- Excess Load card: `src/ui/excess-load-card.ts` shows "cross-training" detection but no per-sport-type TSS breakdown.
- No sport-type filtering or bucketing logic in current activity card rendering.

**Does it still reproduce / is it still open?**
**Yes, still broken.** The activity card render logic displays only a single aggregate TSS number (lines 389, 395, 402 in plan-view.ts). There is no sport-type bucketing or multi-row display for weeks with multiple sport types. The feature is not implemented.

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
- Line 259: `if (actualTSS != null) statsArr.push(\`TSS ${actualTSS}\`);` — single append, no sport breakdown.
- Line 395: `<span style="...width:40px;text-align:right;flex-shrink:0" style="color:${actualColor}">${actualTSSForBars} TSS</span>` — single row, no loop over sport types.
- ISSUE-98 spec: "Add a sport-type breakdown row to the activity load card when the week contains multiple sport types." Not present in code.
- No `computeLoadBySpport` or similar function in activity-matcher.ts or fitness-model.ts.

---

## ISSUE-146: Activity matcher should suggest best-fit workout when no exact match

**Plain-English recap** (2 sentences):
When a completed run doesn't match any planned workout, it falls through as unmatched with no feedback. The feature requests a fallback scoring pass to suggest the "best-fit" planned session (scored by distance, pace, and HR similarity) with a one-tap confirm modal. This is spec-only; only basic distance-matching exists for GPS impromptu runs.

**Current code state:**
- GPS impromptu run handling: `src/gps/recording-handler.ts` lines 98–240. For recorded GPS runs without a matching workout:
  - Line 124: Calls `findRunByDistance(distKm, recording.averagePace, unratedRuns, ms.pac)` — matches by distance ±30% only.
  - Line 225: Shows a simple confirm modal ("Looks like [Workout Name] — assign to it?") for a **single best match**, not a list of candidates.
  - If no match or user declines: saves as adhoc and runs load through cross-training suggestion pipeline (lines 146–221).
- Strava/Garmin activity matching: No fallback scoring in `activity-matcher.ts`. Unmatched activities either become adhoc workouts or are added to the reduction bucket (lines 711–741 in activity-review.ts).
- Sync modal: `sync-modal.ts` shows a match proposal for high-confidence external activity matches, but only for activities already scored by the primary matcher.

**Does it still reproduce / is it still open?**
**Yes, still broken for most activity types.** The fallback scoring logic **only exists for GPS recordings** (distance ±30%), which is too narrow. For Strava/Garmin activities, there is no fallback. The spec requests (1) fallback scoring by distance + pace + HR, (2) presentation of multiple candidates ranked by score, and (3) one-tap confirm + "None of these" default. Only (1) distance-matching exists, and only for GPS impromptu runs. Strava/Garmin unmatched activities skip fallback entirely.

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
- GPS impromptu: `findRunByDistance` (gps/recording-handler.ts line 124) does distance ±30% only — no pace or HR scoring.
- Sync modal proposal is one-way suggest, not a ranked list. Line 225: shows single match, no alternatives.
- Activity review unmatched: Lines 315, 587 add items to reduction bucket with no fallback suggest (activity-review.ts).
- ISSUE-146 spec: "score by distance delta, avg pace vs target zone, avg HR vs expected zone. Present best-fit as 'Looks like this was your [Tempo]?' with one-tap confirm + 'None of these' default."
- No `scoreCandidate`, `bestFit`, or `fallback` functions in activity-matcher.ts.

---

