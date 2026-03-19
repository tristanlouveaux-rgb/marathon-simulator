# Issue Crusher — Batch 6

> **How to use**: `claude "Read docs/ISSUE_CRUSHER_BATCH6.md. Fix the issues in order."`
>
> **Prerequisites**: Batches 1–5 merged.
> **Context**: Recovery data pipeline, week-end debrief (kills welcome-back), UX polish.

---

## MANDATORY READING

Read before writing code:
1. `docs/PRINCIPLES.md` — Signal model, D4 (one signal per context), No Hardcoded Splits
2. `docs/OPEN_ISSUES.md` — full issue list with fix status
3. `docs/MODEL.md` — VDOT, CTL/ATL/TSB, iTRIMP, ACWR
4. `CLAUDE.md`

## RULES (same as previous batches)

1. **One issue at a time.** Fully fix, test, document, commit before the next.
2. **Don't scope-creep.** Log related bugs in OPEN_ISSUES.md, don't fix them now.
3. **Commit after EVERY issue.** Format: `fix(issue-XX): desc` or `feat(issue-XX): desc`
4. **Update docs**: OPEN_ISSUES.md, CHANGELOG.md, FEATURES.md after every issue.
5. **Quality gates**: `npx tsc --noEmit` + `npx vitest run` before every commit.
6. **Never modify test files to make tests pass.**
7. **Never auto-cancel quality sessions.**
8. **Never change Signal A/B split without re-reading PRINCIPLES.md.**
9. **No hardcoded splits or fabricated data.** Grey + "needs data" when unavailable.
10. **PROBE before UX decisions.** If 2+ reasonable interpretations exist, ask.

---

## NO JARGON POLICY

| Internal | User-Facing |
|---|---|
| CTL | Running Fitness |
| ATL | Short-Term Training Load |
| TSB | Freshness |
| ACWR | Load Safety |
| effortScore | Effort trend |

Technical terms only in info sheets / advanced panels, in parentheses after the human name.

---

## OVERVIEW — 4 Groups

| Group | Issues | Theme | Effort |
|---|---|---|---|
| A | ISSUE-76, ISSUE-80 | Recovery data pipeline + Stats Recovery card | Medium |
| B | ISSUE-81, ISSUE-60 (+ ISSUE-34 merged) | Kill welcome-back, build week-end debrief | Medium |
| C | ISSUE-19, ISSUE-08, ISSUE-30 | Home + Stats UX polish | Small |
| D | ISSUE-20 | Activity card redesign | Medium |

**Deferred to future batch** (P3 / blocked / large scope):
- ISSUE-33 (2 workouts/day)
- ISSUE-35, ISSUE-41 (HR analysis pipeline) — large scope
- ISSUE-36 (Garmin sleep edge fn) — overlaps ISSUE-76
- ISSUE-37 (Illness mode)
- ISSUE-38 (Race simulator entry) — sandbox is the proper solution
- ISSUE-47 (What-if sandbox) — fully scoped, defer to dedicated session
- ISSUE-61 (LT/VDOT → update plan)
- ISSUE-63 (HR-based ATL inflation)
- ISSUE-06, ISSUE-07 — tagged `[ui-ux-pro-max]`, defer to dedicated session

---

## GROUP A — Recovery Data Pipeline (ISSUE-76 + ISSUE-80)

**Goal**: Pull real Garmin recovery data and surface it in the Stats Recovery card.

### A1. ISSUE-76: Garmin historic backfill edge function

**What**: New edge function `garmin-backfill` that pulls 8 weeks of historic dailies + sleep
from Garmin Health API and stores in `daily_metrics` + `sleep_summaries`.

**Design**:
- Accepts: user JWT + optional `weeks` param (default 8)
- Calls Garmin Health API endpoints:
  - `GET /wellness-api/rest/dailies` — resting HR, max HR, stress score
  - `GET /wellness-api/rest/hrv` — HRV RMSSD
  - `GET /wellness-api/rest/sleeps` — sleep score, duration, stages
- Upserts into `daily_metrics` + `sleep_summaries` (idempotent)
- Called once in `main.ts` after successful Garmin token refresh
- After backfill: call existing `loadPhysiologyHistory()` to populate `s.physiologyHistory`

**Files**:
- `supabase/functions/garmin-backfill/index.ts` (new)
- `src/main.ts` — call backfill after Garmin token refresh succeeds

**Verification**: After running, `s.physiologyHistory` should have entries for recent weeks.
Recovery & Physiology folded section in Stats should show real charts.

---

### A2. ISSUE-80: Recovery Score bar in Stats Recovery card

**What**: Add a Recovery Score position bar at the top of `buildRecoveryCard()`, with
clickable sub-bars for Sleep, HRV, and Resting HR below it.

**Recovery Score computation** (provisional weights — easy to tune once data flows):
- HRV (RMSSD) trend vs personal baseline: **45%** *(primary — strongest scientific signal)*
- Sleep score: **35%** *(context + quality gate)*
- Resting HR trend vs baseline: **20%** *(secondary — noisier day-to-day)*

**Note on weights**: These are provisional. HRV is weighted highest per sports science consensus
(roughly 2× RHR in academic models). Flag in code comments as `// TODO: tune weights with real data`.

**Sub-bars** (each individually clickable to expand a mini chart):
- Sleep: 0–100 scale, zones Poor/Fair/Good/Excellent
- HRV: relative to user's personal 28-day baseline (shown as % of baseline)
- RHR: inverted scale (lower = better), relative to user's baseline

**Gate**: Only show Recovery Score + sub-bars when `s.physiologyHistory` has ≥3 days of data.
When no data: show a single placeholder row — "Connect a watch for recovery data" in grey.
**No hardcoded values.** All computed from actual `physiologyHistory` entries.

**Click behaviour**: Each sub-bar is a `<details>` element — tapping expands a mini sparkline
chart of the last 14 days for that metric. Same pattern as the existing Recovery & Physiology
folded section in `buildFoldedRecovery()`.

**Files**:
- `src/ui/stats-view.ts` — `buildRecoveryCard()` updated
- `src/calculations/readiness.ts` — add `computeRecoveryScore(history)` function

---

## GROUP B — Kill Welcome-Back + Week-End Debrief (ISSUE-81 + ISSUE-60)

**Goal**: Remove the intrusive welcome-back modal. Replace its purpose with a focused
week-end debrief that fires at the *right* time — end of the current week.

### B1. ISSUE-81: Remove welcome-back modal

**What**: Delete the welcome-back trigger. It fires on every new week open and is too frequent.

**Fix**:
- In `main.ts` (or wherever `checkAndShowWelcomeBack()` is called), remove the call entirely
- The week-end debrief (B2) replaces its purpose
- Keep the `lastWelcomeWeek` state field for now if debrief needs it, else remove from types
- Delete `src/ui/welcome-back.ts` or at minimum disable it

**Files**: `src/main.ts`, `src/ui/welcome-back.ts`

---

### B2. ISSUE-60 (+ ISSUE-34 merged): Week-end debrief

**What**: A single clean modal/sheet that fires when the user finishes their week.
Surfaces what happened, flags effort drift, offers one pacing adjustment.

**Trigger**: Two paths:
1. User taps a "Finish week" button (to be added to the plan page week header for the current week)
2. Auto-trigger: on app open on Monday of a new week (replaces welcome-back, but only fires once per week advance)

**Content** (one screen, no sub-screens):
```
[Phase badge] Week N complete

Load       245 TSS  ·  72% of planned     [green/amber/grey pill]
Distance   38 km
Fitness    Running Fitness ↑ 3 pts

[If effortScore > 1.0]:
"Your runs felt harder than planned this week.
 Adjust pacing down for next week?"  [toggle]  [Confirm]

[If effortScore < -1.0]:
"Your runs felt easier than planned.
 Adjust pacing up slightly?"  [toggle]  [Confirm]

Next week: Build phase · ~280 TSS planned

[Continue →]
```

**RPE infrastructure already built** — do NOT re-build:
- `wk.effortScore` already stores avg(actual − expected RPE) for run workouts (`events.ts:928`)
- `wo.rpe` / `wo.r` already hold expected RPE per workout
- `s.rpeAdj` already feeds effort delta into VDOT/pacing
- Just READ `wk.effortScore` and surface it here

**Pacing adjustment**: If user confirms → apply a small `rpeAdj` change proportional to
`effortScore`. Cap at ±0.5 VDOT per week to prevent overcorrection. Use existing `rpeAdj`
mechanism — do not build a new system.

**Files**:
- `src/ui/week-debrief.ts` (new — single file, ~150 lines)
- `src/ui/plan-view.ts` — add "Finish week" button to current week header
- `src/main.ts` — auto-trigger on Monday (replaces welcome-back logic)

---

## GROUP C — Home + Stats UX Polish (ISSUE-19 + ISSUE-08 + ISSUE-30)

**Goal**: Make numbers self-explanatory. Check what's already fixed before writing code.

### C1. ISSUE-08: Training Load vs Plan bar — verify first

**Action**: Load the app and check the "More detail" section on Stats. The Total Load vs Plan
bar now shows `currentTSS / Math.round(plannedTSS)` as a label. If that's clear enough, mark
ISSUE-08 as resolved. Only add copy if it's still confusing.

### C2. ISSUE-30: Load metrics no reference — verify first

**Action**: Check if the position bars (with zone labels like "Trained", "Fresh", "Safe")
already provide enough context. If yes, mark resolved. If not, add one contextual sentence
below each bar: "Your fitness is in the Trained range — typical for runners doing 4–5 sessions/week."

### C3. ISSUE-19: Home page load bars — label and contextualise

**What**: The home load bars have no labels, no reference, no scale.

**Fix**:
- Add explicit label + value to each bar: "Training load · 245 TSS"
- Add progress context: "72% of weekly target"
- Reference line at 100% of weekly target
- Colour: green (≤100%), amber (100–120%), red (>120%)
- If no baseline: "Keep logging sessions to build your baseline" grey state

**Files**: `src/ui/home-view.ts`

---

## GROUP D — Activity Card Redesign (ISSUE-20)

**Goal**: Clean, honest activity detail cards. No fake data.

### D1. ISSUE-20: Activity card UX

**What**: Maps too zoomed out, HR zones in confusing format, km splits ugly, planned vs actual unclear.

**Design**:
- **Summary grid**: TSS, distance, duration, avg pace, avg HR — 2×3 clean grid. Show `—` for missing fields.
- **HR zones**: Horizontal stacked bar (base/threshold/intensity, same colours as Stats zones chart). Time-in-zone labels. **Only show if real HR zone data exists** — no hardcoded percentages.
- **Km splits**: Horizontal pace bars, colour-coded by effort zone (easy/threshold/hard). Only show if splits data exists.
- **Map**: Zoom to route bounding box. If no GPS data, don't show map at all.
- **No fabricated data**: Every field follows the "—" or grey placeholder convention.

**Files**:
- `src/ui/activity-detail.ts` — main redesign
- `src/ui/plan-view.ts` — activity card expand/collapse wiring

---

## EXECUTION ORDER

1. **B1 first** — kill welcome-back (one-line change, low risk, immediate improvement)
2. **A1** — Garmin backfill (data source for A2)
3. **A2** — Recovery Score bar (depends on A1 data)
4. **B2** — Week-end debrief (standalone, can go after or parallel with A)
5. **C1/C2** — verify and close quickly; C3 only if genuinely needed
6. **D** — standalone, last

## VERIFICATION

After each issue:
- `npx tsc --noEmit` + `npx vitest run` + `npx vite build`
- Update OPEN_ISSUES.md (`✅ FIXED`), CHANGELOG.md, FEATURES.md
- Commit: `fix(issue-XX): desc`

After all:
- Welcome-back gone — no modal on week open
- Week-end debrief appears with real load/effort data
- Recovery card shows real data (or clean placeholder)
- Home bars have labels and context
- Activity cards are clean and honest
