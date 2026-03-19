# Issue Crusher — Batch 5

> **How to use**: `claude "Read docs/ISSUE_CRUSHER_BATCH5.md. Fix the issues in order."`
>
> **Prerequisites**: Batch 4 merged.
> **Context**: Stats page restructure, planned load model, quick fixes from 9th March testing.

---

## MANDATORY READING

Read before writing code:
1. `docs/PRINCIPLES.md` — Signal model, protection hierarchy, D4 (one signal per context), **Planned Load Model** (new)
2. `docs/OPEN_ISSUES.md` — Issues 71–79
3. `CLAUDE.md`

## RULES (same as previous batches)

1. **One issue at a time.** Fully fix, test, document, commit before the next.
2. **Don't scope-creep.** Log related bugs in OPEN_ISSUES.md, don't fix them now.
3. **Commit after EVERY issue.** Format: `fix(issue-XX): desc` or `feat(issue-XX): desc`
4. **Update docs**: OPEN_ISSUES.md, CHANGELOG.md, FEATURES.md after every issue.
5. **Quality gates**: `npx tsc --noEmit` + `npx vitest run` before every commit.
6. **Never modify test files to make tests pass.**
7. **Never auto-cancel quality sessions.**
8. **Never change Signal A/B split without re-reading PRINCIPLES.md.**
9. **ASK before implementing UX/labelling/layout decisions.**
10. **Show testable output at every step.**

---

## PART A — QUICK WINS (do these first, one at a time)

### 1. ISSUE-71: Remove "Simulate Race" button
**What**: Delete `buildRaceSimulatorEntry()` and its click handler from stats-view.ts.
**Files**: `src/ui/stats-view.ts`
**Test**: Stats page loads without the button. Typecheck clean.

---

### 2. ISSUE-74: Fix info (i) buttons on Stats
**What**: The (i) buttons next to Running Fitness and VDOT don't fire their click handlers.
**Debug**: Check `wireStatsEventHandlers()` for `.stats-info-btn` delegation. Ensure `data-info-id` handler shows tooltip/sheet from `INFO_TEXTS`.
**Files**: `src/ui/stats-view.ts`
**Test**: Tap (i) next to Running Fitness → info text appears. Same for VDOT.

---

### 3. ISSUE-77: Sort activities by time (most recent first)
**What**: In `buildWorkoutCards()`, sort `dayWorkouts` by `garminActual.startTime` descending within each day.
**Files**: `src/ui/plan-view.ts`
**Test**: Current week shows most recent activity at top of each day column.

---

### 4. ISSUE-75: VDOT gain should only count running workouts
**What**: In `events.ts:854-859`, `completedCount` counts all rated workouts including gym/cross-training. Only running should contribute to `wkGain`.
**Fix**: Filter `ratedNames` to exclude gym/cross-training/rest types before computing `adherence`.
**Files**: `src/ui/events.ts`
**Test**: A week with 3 gym sessions and 0 runs → wkGain = 0.

---

## PART B — PLANNED LOAD MODEL (ISSUE-79 + ISSUE-78)

### 5. Create `computePlannedWeekTSS()` in fitness-model.ts

New function:
```typescript
export function computePlannedWeekTSS(
  ctlBaseline: number,
  phase: string,
  weekInPhase?: number,
  totalPhaseWeeks?: number,
): number
```

- Source: `ctlBaseline` (42-day Signal A chronic load)
- Phase multipliers from PRINCIPLES.md:
  - base: 0.95–1.00
  - build: 1.05–1.10
  - peak: 1.10–1.15
  - deload: 0.70–0.75
  - taper: linear ramp 0.85 → 0.55
- Fallback when no CTL: `runs/week × 50` (last resort only)
- Returns rounded integer TSS

**Tests**: New tests in `fitness-model.test.ts`:
- CTL 195 + build → ~205–215
- CTL 195 + deload → ~140–145
- CTL 0 + any phase → fallback
- Taper week 1 vs taper week 4 → decreasing

---

### 6. Wire `computePlannedWeekTSS()` into all display sites

Replace every `plannedTSS` fallback:
- `stats-view.ts:977` — Advanced section bar
- `stats-view.ts:483-489` — "This Week" card (ISSUE-78: change from prorated deviation to "X% of weekly target complete")
- `home-view.ts:103` — Home training load bar
- `plan-view.ts:1896` — Plan week header

**ISSUE-78 fix** (integrated here): "This Week" card shows:
- "72 / 205" (actual / planned)
- "35% complete" (progress toward full week target)
- NOT "+952%" (prorated deviation — delete this logic)

**Files**: `src/calculations/fitness-model.ts`, `src/ui/stats-view.ts`, `src/ui/home-view.ts`, `src/ui/plan-view.ts`

---

## PART C — STATS PAGE RESTRUCTURE (ISSUE-72 + ISSUE-73)

### 7. Kill "Dig Deeper" — promote charts to main area

Move distance/zone charts from the collapsed "Dig Deeper" section into the main chart card as additional tabs alongside 8w/16w/Full. New tab bar:
- Load (default) | Distance | Zones | 8w | 16w | Full

Or: keep 8w/16w/Full as range, and Load/Distance/Zones as chart type. **ASK user which layout.**

Delete `buildDigDeeper()` function entirely.

**Files**: `src/ui/stats-view.ts`

---

### 8. Split "Your Numbers" into two cards

Replace the single "Your Numbers" card with:

**Card 1: "Load & Recovery"**
- Short-Term Load (ATL) bar
- Freshness (TSB) bar
- Load Safety (ACWR) bar

**Card 2: "Running Progress"**
- Running Fitness (CTL) bar
- VDOT bar

Each bar is tappable → opens info sheet with explanation + current value + zone.

**Files**: `src/ui/stats-view.ts`

---

## PART D — GARMIN HISTORIC BACKFILL (ISSUE-76)

### 9. New edge function: `garmin-backfill`

Pulls last 8 weeks of:
- `/wellness-api/rest/dailies` → `daily_metrics`
- `/wellness-api/rest/sleeps` → `sleep_summaries`

Uses the stored `access_token` from `garmin_tokens` (refreshed by ISSUE-70).
Called from client after successful token refresh.

**Files**:
- `supabase/functions/garmin-backfill/index.ts` (new)
- `src/data/physiologySync.ts` — add `backfillGarminHistory()` client function
- `src/main.ts` — call after Garmin connect check succeeds

---

## EXECUTION ORDER

1. Issue 71 (remove button) — commit
2. Issue 74 (info buttons) — commit
3. Issue 77 (activity sort) — commit
4. Issue 75 (VDOT gain) — commit
5. Issue 79+78 (planned load) — commit
6. Issue 73 (kill Dig Deeper) — commit
7. Issue 72 (split Your Numbers) — commit
8. Issue 76 (Garmin backfill) — commit

## WHEN DONE

1. `npx tsc --noEmit` — clean
2. `npx vitest run` — all pass
3. `npx vite build` — must compile
4. Output summary table with issue, status, commit hash, notes
