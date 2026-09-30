# Load Accounting Handoff

This brief is for a Claude Code session on Tristan's laptop. It continues an audit and fix plan built in a cloud session on 28–30 September 2026. That cloud session could only see what had been pushed to GitHub. Read this whole file before touching code.

Files in this folder:

| File | What it is |
|---|---|
| `HANDOFF.md` | This brief: state, decisions, order of work, pitfalls |
| `load-accounting-audit.md` | Full audit. 57 verified findings (A1–D5) with code references and verifier notes, plus traces of how sessions are cut |
| `load-fix-designs.md` | One diagnosis, design and adversarial review per fix. Three competing cut-sizing designs with a judge's recommendation. A ranked list of other concerns |

All line numbers in those two reports refer to `main` at `c3bb015` unless stated otherwise.

---

## 0. Establish the source of truth first

`main` is not the latest code. Here is what GitHub showed on 30 September:

| Branch | Tip | Relationship |
|---|---|---|
| `main` | `c3bb015`, 29 May | Common base `03a3072` (16 Apr) plus 1 commit (injury fix, ISSUE-248) |
| `triathlon-mvp` | `42825c9`, 12 May | `03a3072` plus 43 commits (triathlon MVP, iOS bootstrap, onboarding overhaul). OPEN_ISSUES runs to ISSUE-204 |
| `claude/hyrox-simulation-mini-session-rhqifh` | 1 Sep | `triathlon-mvp` plus 1 commit |
| `claude/bulk-missed-weeks-generation-tsogwb`, `claude/ux-loos-swipe-dismiss-494nng` | 1 Sep | `main` plus 1 commit each |
| `claude/strava-load-accounting-o94cbg` | this handoff | `main` plus these docs only |

Evidence that the laptop has newer work than GitHub:
- The `c3bb015` commit message says the ISSUE-248 fix "was absent from both main and feat/revenue-cat-iap". No `feat/revenue-cat-iap` branch exists on GitHub.
- The CHANGELOG on `main` describes functions that are not in `main`: `computeReadinessACWR`, `computeLiveSameSignalTSB`, `computeRenderedWorkouts`, `computeTodayStrainTSS`, `deriveAthleteTier`. All five are in `triathlon-mvp`.
- `npx tsc --noEmit` fails on `main` with 3 errors:
  - `@capacitor/haptics` is missing;
  - `@capacitor-community/keep-awake` is missing;
  - `GuidedCueLogEntry` is not exported from `@/types`.

  `triathlon-mvp` adds both packages to `package.json` and defines the type at `src/types/gps.ts:64`.

**Steps**
1. Run these:
   ```
   git status
   git branch -a --sort=-committerdate
   git log --all --oneline --graph --date-order | head -60
   ```
2. Identify the newest branch (likely `feat/revenue-cat-iap` or a descendant of `triathlon-mvp`) and confirm it with Tristan.
3. Commit any uncommitted work, then run `git push --all origin`. Before committing, check that no secrets (`.env` or similar) are staged.
4. Do all fix work on a new branch cut from the source of truth.
5. **Re-validate every finding on that branch before fixing it.** Some have already been fixed there.

**Already known about `triathlon-mvp`, checked 30 September:**
- **iTRIMP unit bug, partly fixed.** Commit `4e6c5d4` (1 May) converts iTRIMP to TSS in `computeTierAPlus` using the fixed 15000 normaliser. It does not use the athlete's personal normaliser.
- **Standalone cache select now includes `hr_drift`.** The standalone heal writes (`index.ts:2489`, `:2517`) are still `void supabase.from(...).update(...)`, and those never execute. The backfill drift heal (`:1934`) is awaited.
- **Still present:** the 40/25/50/30 caps in `suggester.ts` (:579, :659, :796, :824), p95 max HR, the Apple `window.Capacitor.platform` check and `appleExerciseTime`, planned easy/long runs at `rpe: 3`, fast-finish long runs typed `progressive` while the scheduler finds the long run via `t === 'long'`, review candidates built without `workoutMods`, and `resting_hr ?? 55` on the server.
- **UTC date keys in non-test `src`:** 73 × `toISOString().split('T')[0]` plus 43 × `toISOString().slice(0, 10)`. There are 4 more in `supabase/functions`.
- **ACWR 14-day guard gained an `archivedPlans` clause.** Re-check the zero-seed behaviour.
- **Cut sizes still do not scale with work.** Probe on `triathlon-mvp`:
  - Setup: cycling at RPE 5 and 60 TSS/h (iTRIMP = TSS × 150); a Balanced marathon runner with easy pace 330 s/km, ACWR caution, no km floor.
  - Week: 8 km easy, a plain 10 km threshold, 8 km easy, 20 km long. Easy and long runs at load intensity 30, threshold at 80 (`calculateWorkoutLoad`).

  | Ride | With HR, Reduce | No HR, Reduce |
  |---|---|---|
  | 20 min | −2.3 km | −3.2 km |
  | 60 min | −3.2 km | −3.2 km |
  | 120 min | −3.2 km | −5.0 km + threshold stepped down |
  | 240 min | −5.0 km + threshold stepped down | −3.2 km + threshold stepped down |

  An independent re-run with slightly different assumptions reproduced the pattern, with some cells different; at 5:30/km, 240 min without HR gave −6.4 km. The conclusion holds either way: cuts stay at about 2–6 km whatever the ride length.

---

## 1. Decisions Tristan has made

- **Max HR:** fix it now.
- **HR histogram:** store a per-activity heart-rate histogram (seconds per bpm, about 0.3–1.3 KB as JSON; the largest probe histogram had 142 bins and was 1,249 bytes). Approved in principle, "provided no foreseen issues". The foreseen issues, none blocking, are:
  - time order is lost (drift and splits must be computed at ingest);
  - existing rows need one re-download each against Strava's app-wide rate limit;
  - Strava API terms on storing derived data should be checked.
- **Cut sizing:**
  - One currency, TSS.
  - The cut must be proportional to the work done. Remove the hard 40%/25%/50%/30% caps as the sizing mechanism.
  - Keep the data-quality tiers (HR stream, then Garmin load, then zone minutes, then RPE × minutes), with every tier expressed in TSS.
- **Build suggestions from the updated plan:**
  - Plan changes must use the plan with existing `workoutMods` applied.
  - A new change replaces the existing change on the same workout. It does not stack a new mod.
- **Fix all of these:**
  - overflow sessions counted twice;
  - false high injury risk (ACWR);
  - Strava stream re-downloads;
  - Apple Watch sync;
  - deload and taper load targets;
  - fast-finish long run scheduling;
  - resting HR pass-through to the server;
  - UTC vs local dates.
- **Pause gaps in HR streams:** not a concern.
- **Resting HR:** as far as known, Strava's API does not expose resting HR. Use what the app already has (onboarding, Account, Garmin, Apple). Send it with each sync, the same way `max_hr_override` is sent. 55 stays as the fallback only when nothing is known.

### Pending: the recommended option applies unless Tristan says otherwise

Tristan was asked to reply "go with recommendations" and had not answered when this was written. Confirm with him before coding each one.

| # | Decision | Recommendation | Source of any number |
|---|---|---|---|
| a | Max HR estimator | p95 once there are 21 or more **deduplicated** sessions; median of the top 5 below that. A user-entered value always wins and is never overwritten | p95 and top-5 are both already in code or CHANGELOG. 21 is where `floor(0.95n)` stops returning the maximum |
| b | Price of planned easy and long runs | RPE 4 (`TL_PER_MIN[4]` = 0.92/min) instead of RPE 3 (0.65) | Easy runs at RPE 4 already appear in the Tier-1 trim (`activity-review.ts:1787`) and `main-view` `TYPE_RPE`. Long runs at 4 appear only in `TYPE_RPE` (`main-view.ts:2283`); `timing-check.ts` `RPE_BY_TYPE` has long at 6. So RPE 4 for long runs is Tristan's call |
| c | Floors after a cut | Easy: 30 minutes at easy pace. Long: 85% of the original while ACWR is safe or low, 60% while caution or high | `docs/specs/Load-Reduction-Methodology.md` :186, :250; 85% is in current code |
| d | Weekly cap on running displaced by cross-training | 30% of the week's planned running TSS, counted cumulatively | Tanaka 20–30% (`docs/research/running.md` §7.2); 0.30 exists unused in `sports.ts` `LOAD_BUDGET_CONFIG` |
| e | Quality sessions | Last rung only. Step one quality session down only when the TSS delta fits within the remaining budget | PRINCIPLES.md :67-76, :201 |
| f | ACWR with no seed | Fill pre-plan days with the athlete's own observed daily average, not 0 | No new constants |
| g | Stream heal budget | At most 10 Strava calls per sync for heals. Re-download legacy rows in the 28-day window once | 10 is the existing calories-heal cap |
| h | Apple workouts | Use them only when Strava is not connected ("Strava always wins", `sources.ts`). Check whether the Xcode HealthKit capability and Info.plist keys are already done (`triathlon-mvp` has `ios-plugins/health-extras`) | none |

---

## 2. What is wrong: verified findings to fix

Full detail is in `load-accounting-audit.md` and `load-fix-designs.md`. Line numbers are from `main`.

1. **Cut sizing is not proportional.**
   - **Raw iTRIMP used as load.** On `main`, `universalLoad.ts:106` still has `baseLoad = iTrimp * sportMult`, about 150× too large. Only `triathlon-mvp` has the fix (`4e6c5d4`, 1 May), which uses a fixed 15000.
   - **The caps set the cut size.** In `suggester.ts` they are at :579 (easy 0.40), :639 (long 0.25), :776 (easy replace 0.5) and :804 (long replace 0.3) on `main`.
   - **History (verified on the full, unshallowed history).**
     - The root commit `9af43b4` (3 Feb) was proportional:
       - easy: `reducePct = clamp(ratio * 0.3, 0.15, 0.40)`, with `ratio = remainingCredit / runLoad`;
       - replace when `ratio >= 0.8`;
       - long: a fixed 10% (≤25%);
       - long in Replace: 15% (≤30%).
     - Commit `e4488e7` (6 Feb, "Cross-training preview works without auto-apply") replaced this with `Math.min(budgetKm, runKm * cap)` and introduced the 0.5 cap. No doc records why.
     - (The designs doc says the caps were in the root commit. That came from a shallow clone and is wrong.)
   - **The unbuilt designs.** In the Python reference design (`docs/research/cross-training-replacement-code.md:530-536`), 40% was the *midpoint* of a proportional curve, not a ceiling. The proportional algorithm in `Load-Reduction-Methodology.md` §6 was never built.
   - Other scale errors:
     - The saturation curve (TAU 800, CREDIT_MAX 1500) amplifies normal sessions by up to 1.875×.
     - `EASY_LOAD_PER_KM = 12`, but planned easy runs are about 7.4 load/km.
     - Replace can delete quality sessions.
     - A cut long run is retyped to `'easy'`.
     - Downgrades keep the old RPE.
     - HIIT maps to gym and never reaches the suggester.

2. **Suggestions are built from the unmodified plan.**
   - `getWeekWorkoutsForReview` (`activity-review.ts:69-81`) and `getWeekWorkoutsForACWR` (`main-view.ts:2166-2191`) ignore `workoutMods`.
   - New mods are appended, and the renderer applies them last-wins. A later small session therefore undoes an earlier bigger cut.
   - Timing suggestions (`timing-check.ts` `mergeTimingMods`) are also built from the raw plan and override cross-training cuts.
   - `'Timing accepted:'` is not recognised by `isTimingMod`, so accepted suggestions come back.

3. **Overflow counted twice in Signal A.**
   - `computeWeekTSS` (`fitness-model.ts:382-392`) adds `unspentLoadItems` with no `garminId` dedup, on top of the full activity already counted.
   - Related: every synced cross-training session gets a `garminActuals` twin, and that twin is counted at full weight. So the runSpec discount never applies in Signal A (the "runSpec bypass").
   - `buildDailySignalBTSS` (`sleep-insights.ts:350-378`) double-counts twins.
   - `computeLoadBreakdown` (`home-view.ts:236-252`) adds surplus on top of the full run.
   - The design's rule is that unspent items are never load: one shared per-week activity iterator feeds every total.
   - **This must ship together with** the mixed-signal consumers: Home momentum (`home-view.ts:710-721`), coach `ctlTrend` (`daily-coach.ts:199-205`), and the Stats ACWR and TSB sparklines. Otherwise lowering Signal A creates a false high injury-risk chart.

4. **False high ACWR.** `computeRollingLoadRatio` fills pre-plan days with `signalBSeed/7 = 0` when there is no seed, from plan day 14. Steady training then reads 1.6–2.0 "high", and the week-3 advance strips two quality sessions. The approved fix is to fill from the athlete's own days. The review (in the designs doc) adds three required pieces:
   - in-plan days before a data source's coverage started must not count as rest;
   - the Apple lookback must go to 28 days;
   - the tests must use local-noon fake time.

5. **Strava stream re-download** (`supabase/functions/sync-strava-activities/index.ts`).
   - The drift heal re-streams every cached run of 20 minutes or more on every sync. On `main` this is because `hr_drift` is not selected.
   - The heal writes are `void`-ed, and postgrest builders only send inside `then()`, so they never execute.
   - Rows with no HR are re-streamed forever.
   - About 21 Strava calls per launch for a 5-runs-a-week user. Strava's limit is **per application**.
   - The fix:
     - a `stream_status` marker and a `detail_fetched_at` column;
     - an HR histogram column;
     - `await` every write;
     - process new activities first, then capped heals.
   - Review corrections to apply:
     - never null out existing zones or splits on error or budget paths;
     - heals must not silently rewrite stored iTRIMP;
     - preserve the response order;
     - a 403 is not terminal;
     - use `real`, not `smallint`, for the provenance columns.

6. **Max HR.**
   - The CHANGELOG 2026-04-07 "median of top 5" never shipped. Commit `45d18ea` shipped `floor(n*0.95)`, which returns the maximum for n ≤ 20. Standalone applies it to only 5 rows.
   - The client derives `s.maxHR` once and locks it (`stravaSync.ts:145`).
   - `physiologySync.ts:125-128` overwrites user-entered values.
   - Stored iTRIMP is never recomputed. **Changing max HR without rescoring history creates a false ACWR spike:** a 1.54× scale step gives 1.36.
   - The design:
     - per-activity HR histogram plus provenance columns (`itrimp_max_hr`, `itrimp_rest_hr`, `itrimp_sex`);
     - a DB-only rescore mode;
     - a source flag (`user | derived | age | default`);
     - an atomic switch;
     - re-run `fetchStravaHistory` after a rescore.
   - The review requires:
     - a new response field (old iOS builds read `maxHR` directly);
     - per-entry tuple stamps so rescored values don't leak early;
     - a histogram heal that reaches rows older than 28 days;
     - history mode normalised with the client normaliser;
     - a state migration for the existing `s.maxHR` source.

7. **Planned easy and long runs priced at RPE 3.**
   - `intent_to_workout.ts:54-55, 76-77` combined with `computePlannedDaySignalBTSS` means an on-plan easy run reads 115–180% of target, which gives "Ease Back".
   - **A max-HR spike currently hides this:** 99% of plan with max 216, 148% with true max 188.
   - **Ship this with or before the max HR fix.**
   - Reprice planned TSS only. Do not change `w.rpe`, because `rate()` compares against it.

8. **Apple Watch sync has never run.** It shipped with Capacitor 8 from the start. Three blockers:
   1. `isNativeiOS()` checks `window.Capacitor.platform`, which Capacitor 8 never sets. Use `isIOS()` from `src/utils/platform.ts`.
   2. `requestAuthorization` includes `appleExerciseTime`, which the plugin rejects, and omits `'workouts'`.
   3. The HealthKit entitlement and `NSHealthShareUsageDescription` are probably missing. Without them the app crashes on launch. `ios/` is gitignored.

   Once data flows there is more to fix: UTC date keys (a day early in UTC+), sleep before midnight dropped, HRV limited to the oldest 100 samples, values frozen after the first sync of the day, most workout types mapped to WALKING, no HR read, no post-sync `processPendingCrossTraining` or `mergeTimingMods`, and double counting against Strava. The full fix plan and device checklist are in the designs doc.

9. **Fast-finish long run.** It is typed `'progressive'`, so `assignDefaultDays` (`scheduler.ts`, `t === 'long'`) puts it in the quality pool. Every third week it lands on Tuesday with Sunday empty, and it loses all long-run protections. Fix: the generator marks the long-run slot, and the scheduler and protections use that mark.

10. **Deload and taper targets.** Nothing sets `ph = 'deload'`, so the deload multipliers (0.65–0.70) are unused. Every taper week targets 0.85 because every caller except Stats (`stats-view.ts:988`) leaves `weekInPhase` undefined. Following the plan exactly reads 10–40% under plan. `computeDecayedCarry` judges past weeks against the current week's target.

11. **Resting HR.** The edge function uses `daily_metrics.resting_hr ?? 55` (`index.ts:734, :1002`). The client never sends `s.restingHR`, so Strava-only and Apple users are always scored at 55: about ±10% on easy sessions.

12. **UTC vs local dates.** On `triathlon-mvp`, non-test `src` has 73 `toISOString().split('T')[0]` sites plus 43 `toISOString().slice(0, 10)` sites; there are 4 more in `supabase/functions`. Grep for both forms. The plan week comes from UTC while the weekday comes from local time. In the US, evening runs land on the next day; in Australia, Monday morning runs land in the previous week. Add one shared local-date helper and fix all sites in one pass (CLAUDE.md cross-cutting rule).

Other concerns, ranked, are in `load-fix-designs.md` §9: Home ring vs coach TSB mismatch, tier baseline under-read, female normaliser β, edge pagination `per_page=50`, and duplicate uploads.

---

## 3. Order of work and dependencies

1. **Source of truth** (§0). Re-validate the findings on it, and drop what is already fixed.
2. **Strava stream re-download.**
   - Migration first, then the edge function. **Run the migration before deploying the function**, or every activity re-streams in one burst.
   - Add the HR histogram column here: the max HR fix depends on it.
3. **Easy and long run pricing** (item 7), before or with max HR.
4. **Max HR**, with the resting HR pass-through (item 11): histogram rescore, source flag, atomic switch.
5. **Overflow double count and runSpec bypass** (item 3), with the momentum, ctlTrend and sparkline changes in the same pass.
6. **ACWR zero seed** (item 4). Must land before Apple.
7. **Cut sizing** (items 1 and 2). This needs 4 and 6 first (it reads ACWR status and the normaliser). Build from the plan with mods applied, and keep a ledger of which activity caused which cut so nothing is cut twice.
8. **Apple Watch** (item 8). Xcode HealthKit capability and Info.plist keys come before the JS platform fix.
9. **Fast-finish long run** (item 9), **deload and taper targets** (item 10), **UTC dates** (item 12).

---

## 4. Deploying (Tristan runs these; project ref from `docs/OPEN_ISSUES.md`)

```
supabase link --project-ref elnuiudfndsvtbfisaje
supabase migration list
supabase db push                                   # migrations first
supabase functions deploy sync-strava-activities --project-ref elnuiudfndsvtbfisaje
```

Edge functions update at once, but installed iOS builds carry their own JS. Keep edge responses backward-compatible (add fields; never change what an existing field means).

---

## 5. Rules for whoever implements this

- **CLAUDE.md applies in full:**
  - no invented constants (ask Tristan);
  - every model change gets a `docs/SCIENCE_LOG.md` entry;
  - update CHANGELOG, FEATURES and ARCHITECTURE;
  - an issue is not marked fixed until Tristan has confirmed it on a device.
- **Tristan's preferences:** only tell the truth, check your work, write like a consultant, never guess, ask first.
- **Verify with probes, not by reading.** Probe tests (`src/calculations/zz_probe_*.test.ts`, run with `npx vitest run <file>`, then deleted) confirmed most findings. Repeat them on the source-of-truth branch.
- **Comments and CHANGELOG entries are unreliable.** Several describe code that never shipped. Trust the code.
