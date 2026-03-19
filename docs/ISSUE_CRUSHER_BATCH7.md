# Issue Crusher — Batch 7 (P1 Bug Fixes)

> **How to use**: `claude "Read docs/ISSUE_CRUSHER_BATCH7.md. Fix the issues in order."`
>
> **Prerequisites**: All previous batches merged.
> **Context**: P1 bugs blocking correct load numbers, week advancement, and Garmin data pipeline.

---

## MANDATORY READING

Read before writing code:
1. `CLAUDE.md` — Commands, conventions, doc maintenance rules
2. `docs/PRINCIPLES.md` — Signal model (A/B/C), protection hierarchy, D4 (one signal per context)
3. `docs/MODEL.md` — VDOT, CTL/ATL/TSB, iTRIMP, ACWR formulas
4. `docs/OPEN_ISSUES.md` — Current issue state

## RULES

1. **One issue at a time.** Fully fix, test, document, commit before the next.
2. **Don't scope-creep.** Log related bugs in OPEN_ISSUES.md, don't fix them now.
3. **Commit after EVERY issue.** Format: `fix(issue-XX): desc`
4. **Update docs**: OPEN_ISSUES.md, CHANGELOG.md, FEATURES.md after every issue.
5. **Quality gates**: `npx tsc --noEmit` + `npx vitest run` before every commit.
6. **Never modify test files to make tests pass.**
7. **Never change Signal A/B split without re-reading PRINCIPLES.md.**

---

## NO JARGON POLICY

| Internal | User-Facing |
|---|---|
| CTL | Running Fitness |
| ATL | Short-Term Training Load |
| TSB | Freshness |
| ACWR | Load Safety |

---

## 1. Kill "How are you feeling?" mandatory check-in (ISSUE-82)

**Symptom**: Every app open triggers `showRecoveryLogModal()` — a 10-point scale that blocks the UI. It fires even when there's no Garmin data, making it a mandatory gate on every launch.

**Root cause**: `checkRecoveryAndPrompt()` in `src/main.ts:216` runs after every Garmin backfill. When `todayPhysio` is null (no Garmin data for today — which is most of the time), it calls `showRecoveryLogModal()` unconditionally at line 229–231.

**Fix**:
1. In `src/main.ts`, find `checkRecoveryAndPrompt()` (line 216)
2. **Delete the `if (!todayPhysio)` branch** (lines 227–231) that shows the manual check-in modal when no Garmin data exists. When there's no physiology data, just `return` silently — don't prompt.
3. The function should ONLY prompt when actual Garmin data exists AND `status.shouldPrompt` is true (the existing path at lines 234–241 already handles this correctly).
4. Also remove the two `checkRecoveryAndPrompt(getState())` calls at lines 150 and 166 in `main.ts` entirely — this prompt should not fire on startup. If we keep it at all, gate it behind a user action (e.g. "Check in" button on Home), not auto-popup.

**Alternative (softer kill)**: If you want to preserve the check-in as an option, remove the auto-trigger and add a small "Check in" chip to the Home page that calls `showRecoveryLogModal()` on tap. But do NOT auto-show it.

**Files**: `src/main.ts`

---

## 2. CTL shows 222 "Elite" for a 3:12 marathoner (ISSUE-85)

**Symptom**: Running Fitness (CTL) displays 222, labelled "Elite". User runs a 3:12 marathon — should be ~60–90 CTL. This corrupts `athleteTier`, ACWR calculations, and `computePlannedWeekTSS`.

**This is the critical fix in this batch.** Every downstream number depends on CTL being correct.

**Investigation steps** (do these in order, log findings):

### Step 2a: Trace what feeds CTL
- Read `src/calculations/fitness-model.ts` — find `computeFitnessModel()` (line ~394)
- CTL EMA is at line ~422: `ctl = ctl * CTL_DECAY + weekTSS * (1 - CTL_DECAY)`
- What is `weekTSS` here? Is it Signal A (`computeWeekTSS`) or Signal B (`computeWeekRawTSS`)?
- What is `ctlSeed`? Where does the seed come from?

### Step 2b: Check `historicWeeklyTSS` scale
- `historicWeeklyTSS` is populated by `fetchStravaHistory` / `backfillStravaHistory`
- The edge function `sync-strava-activities` in history mode computes `equivTSS = (iTrimp * 100) / 15000 * rs`
- Check: are the values in `historicWeeklyTSS` reasonable? (A recreational runner doing 30-40km/week should have weekly TSS ~40-80, not 200+)
- If the values are inflated, the bug is in the edge function TSS formula or the `rs` (runSpec) multiplier

### Step 2c: Check `ctlBaseline` computation
- `ctlBaseline` is the EMA of `historicWeeklyTSS` (using `CTL_DECAY = e^(-7/42) ≈ 0.847`)
- If `historicWeeklyTSS` values are reasonable but `ctlBaseline` is 222, the EMA formula is wrong
- Check: is the EMA seeded with 0 and built up gradually, or is it seeded with a single large value?

### Step 2d: Check tier thresholds
- Current thresholds from stats-view: Beginner <40, Recreational 40–70, Trained 70–120, Competitive 120–180, Elite >180
- These thresholds should match the TSS scale that CTL is computed on
- If CTL uses Signal B (raw iTRIMP, no runSpec discount) but tier thresholds were designed for Signal A scale, that's the mismatch

### Step 2e: Fix
Most likely fix is one of:
- **Scale mismatch**: CTL is being computed from Signal B values but tier thresholds expect Signal A scale → either change CTL to use Signal A, or recalibrate tier thresholds
- **Missing normalisation**: Raw iTRIMP values (which can be 1000s) are being summed without the `/15000 * 100` conversion somewhere in the chain
- **Seed corruption**: `ctlBaseline` is initialised from a single anomalous week

**Files**: `src/calculations/fitness-model.ts`, `src/data/activitySync.ts` (or wherever `historicWeeklyTSS` is populated), `src/ui/stats-view.ts` (tier thresholds)

---

## 3. TSS shows 107% / 245/330 — Signal B scaling (ISSUE-83)

**Symptom**: "This Week" shows 245/330 TSS (107%). The planned baseline and actual values both seem too high.

**Dependency**: This likely shares a root cause with ISSUE-85. Fix ISSUE-85 first, then check if this resolves.

**If not resolved by ISSUE-85**:
1. Check `computePlannedWeekTSS()` in `fitness-model.ts` — it uses MEDIAN of `historicWeeklyTSS` as baseline
   - If `historicWeeklyTSS` is inflated (ISSUE-85), the planned baseline will be inflated too
2. Check `computeWeekRawTSS()` — the actual TSS for the current week
   - Is dedup working? Check `seenGarminIds` Set — are activities double-counted?
   - Are activities from adjacent weeks leaking in? Check week boundary calculation
3. Verify that the same signal is used on both sides of the comparison (PRINCIPLES.md D4)

**Files**: `src/calculations/fitness-model.ts`, `src/ui/home-view.ts`, `src/ui/stats-view.ts`

---

## 4. "Complete week" doesn't advance the week (week advancement bug)

**Symptom**: Pressing "Complete Week" doesn't move to the next week, despite `advanceWeekToToday()` working on launch.

**Context**: The "Complete Week" button in `main-view.ts:333` calls `next()` from `events.ts:732`. The `next()` function DOES increment `s.w++` at line 1019 and calls `saveState()` at line 1072. So the increment exists in code.

**Investigation steps**:

### Step 4a: Check if `next()` is being blocked before `s.w++`
The function has several early returns:
- Line 734: `if (s.w < 1 || s.w > s.wks.length) return` — is `s.w` already past `s.wks.length`?
- Line 755–757: `showCompletionModal` — if user clicks "Go Back", function returns without advancing
- Line 818–831: injury check — if injured and not checked in, returns without advancing

**Most likely cause**: `s.w > s.wks.length`. If `advanceWeekToToday()` on launch pushed `s.w` to the calendar week, but the `wks` array hasn't been extended to match (continuous mode block generation only happens inside `next()`), then `s.w` could exceed `s.wks.length`, hitting the guard at line 734.

### Step 4b: Check `advanceWeekToToday` interaction
- `advanceWeekToToday()` sets `s.w = Math.min(targetWeek, maxWeek)` where `maxWeek = s.tw || targetWeek`
- In continuous mode, `s.tw` only grows when `next()` appends blocks (lines 1039–1062)
- If `advanceWeekToToday()` sets `s.w = s.tw` (the last planned week), and `next()` checks `s.w > s.wks.length`, these should match... unless `s.wks.length !== s.tw`

### Step 4c: Fix
1. Add a `console.log` at the top of `next()` showing `s.w`, `s.wks.length`, `s.tw` to see which guard trips
2. The fix is likely: `advanceWeekToToday()` needs to also extend `s.wks` in continuous mode when it jumps forward (same block-generation logic as `next()` uses at lines 1039–1062), OR the guard at line 734 should be loosened
3. Remove logging before commit

**Files**: `src/ui/events.ts`, `src/ui/welcome-back.ts`

---

## 5. Garmin backfill data not visible (ISSUE-76 follow-up)

**Symptom**: Edge function `garmin-backfill` deployed successfully to `elnuiudfndsvtbfisaje`, but no sleep/HRV/recovery data appears in the app.

**The pipeline** (trace each link):

```
main.ts launch
  → triggerGarminBackfill(8)                    [supabaseClient.ts:114]
    → calls edge fn 'garmin-backfill'           [writes to daily_metrics + sleep_summaries in DB]
  → .finally() → syncPhysiologySnapshot(7)      [physiologySync.ts:67]
    → calls edge fn 'sync-physiology-snapshot'  [reads daily_metrics + sleep_summaries from DB]
    → stores results in s.physiologyHistory     [physiologySync.ts:128-145]
  → Recovery card / readiness reads s.physiologyHistory
```

**Investigation steps**:

### Step 5a: Is the backfill function being called?
- Check browser console for `[garmin-backfill] Done` or `[garmin-backfill] Failed` log
- If no log at all → the function call is not executing. Check if the Garmin auth path in `main.ts` is being reached (lines 145–170). Is the user on the Strava+Garmin path or Garmin-only path? Is `s.garminToken` / `s.garminUserId` set?

### Step 5b: Is the edge function returning data?
- Check Supabase dashboard → Edge Function logs for `garmin-backfill`
- Look for errors: expired token, missing user ID, Garmin API rate limit
- The function should log how many daily rows and sleep rows it upserted

### Step 5c: Is the physiology snapshot reading the data?
- Check if `syncPhysiologySnapshot(7)` is called (it's in `.finally()` after backfill)
- The edge function `sync-physiology-snapshot` reads from `daily_metrics` and `sleep_summaries`
- Check if it's reading the right user ID, right date range
- Check if `s.physiologyHistory` is populated after the call — add a `console.log` showing the array length

### Step 5d: Is the UI gated on minimum data?
- Recovery score card may require ≥3 days of `physiologyHistory` entries
- If backfill wrote data but only 1-2 days have complete fields, the UI may still show the placeholder

### Step 5e: Common failure mode — Garmin token expired
- Check if `s.garminToken` exists and is valid
- The `garmin-refresh-token` edge function may need to be called first
- Check `main.ts` startup: does it refresh the Garmin token before calling backfill?

**Fix**: Depends on which link is broken. The most likely issue is (a) Garmin token expired and not refreshed, or (b) `syncPhysiologySnapshot` edge function doesn't read from the tables that `garmin-backfill` writes to.

**Files**: `src/main.ts`, `src/data/supabaseClient.ts`, `src/data/physiologySync.ts`, `supabase/functions/garmin-backfill/index.ts`, `supabase/functions/sync-physiology-snapshot/index.ts`

---

## WHEN DONE

1. Run `npx tsc --noEmit` — clean
2. Run `npx vitest run` — all pass
3. Run `npx vite build` — must compile
4. Output summary table with issue, status, commit hash, notes
5. Update OPEN_ISSUES.md with ✅ status for each fixed issue
