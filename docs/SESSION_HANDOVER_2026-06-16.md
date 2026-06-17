# Session handover — 2026-06-16 (plan engine + prediction calibration)

Self-contained handover. Read this first, then the linked diagnostics. Written because the originating session got long; another agent is taking over.

---

## 1. Repo state RIGHT NOW (read before touching anything)

- **Branch:** `feat/revenue-cat-iap`. **Never pushed** (no upstream on origin).
- **Last commit / known-good reference:** `dbcadf1` — *"checkpoint: marathon plan engine fix + cross-trained forecast"*. At that commit: **tsc clean, full suite green (3371), the marathon fix verified.** Treat dbcadf1 as the safe restore point.
- **Working tree is a live two-agent mix.** Since dbcadf1 there are ~25 uncommitted `src/` changes that are **NOT from this session** (a parallel agent: hyrox forecast, appleHealthSync, several wizard steps, styles.css, feature-flags, etc.) plus **this session's doc edits** (the two diagnostics + OPEN_ISSUES/SCIENCE_LOG). Do **not** assume the current working tree is green — only dbcadf1 is verified. If you need green, diff against dbcadf1.
- **Backups (nothing can be lost):** `/tmp/mosaic_checkpoint_20260616_110022/` (tracked.patch + untracked.tgz + base-commit) and a fresh one taken at handover time. The branch itself is the only copy of 99 commits — see push blocker below.
- **Multi-agent caution:** the parallel agent owns the **prediction/forecast files** (`predictions.ts`, `blended-fitness.ts`, `physiological-vdot.ts`) and **onboarding** (`manual-entry.ts`, `review.ts`). Coordinate / expect churn there. Issue numbers **288–296** are theirs (persona-QA batch); **297** is this session's.

## 2. Shipped this session (in dbcadf1) — ISSUE-286 marathon plan fix

A real 18-wk marathon plan was under-built (peak at wk 2, long run ~18 km, jagged load). Three root causes fixed in `src/workouts/plan_engine.ts`, all verified across plan length × frequency × ability via a scenario sweep (NOT device-verified):
- **RC1** — marathon long run now ramps from a 90-min week-1 anchor to a distance-aware readiness ceiling (`longRunCapMin`: beginner 150 / novice-intermediate 165 / advanced-elite 180 min ≈ 30 km). Was topping ~95 min. Other distances unchanged.
- **RC2** — `effectiveWeeklyBudgetMin` periodises under a tight hours cap (cap the peak, ramp toward it) instead of pinning flat.
- **RC3** — marathon `easyCount` floored at 1 when `runsPerWeek ≥ 3` in `computePeakWeeklyKm`.
- Also fixed a latent `load-currency-anchors.test.ts` fixture bug (`raceType` → canonical `distance`).
- A phase-position volume envelope was **built and reverted** — it was the wrong tool (see ISSUE-287). Don't re-add it.
- Docs: `docs/MARATHON_PLAN_DIAGNOSTIC.md` (status: FIX APPLIED, not device-verified), SCIENCE_LOG §BW, CHANGELOG, ISSUE-286.
- **Still pending:** Tristan device-confirms before ISSUE-286 is marked FIXED.

## 3. Open threads (priority order)

### ISSUE-297 (P1) — predictions bury a strong engine + aren't reproducible ← THE BIG ONE
**Full diagnostic + repro + file:line + test plan: `docs/PREDICTION_FEEDBACK_LOOP_DIAGNOSTIC.md`.** This is the root cause of every "weird prediction" Tristan hit:
- 20:00 5K → 4:00 marathon (should be ~3:11 capacity / ~3:15-3:30 trained).
- 40:00 10K, 52 km/wk peak plan → 3:40 (Tristan has a 40:00 10K and *actually ran 3:10* — ground truth).
- Same input gives different answers on re-run (3:33 vs 4:00) — non-deterministic.
- "Faster than 95%" next to a slow marathon on the same screen.

**Mechanism:** the volume-penalized *marathon* time is written back into the global engine `s.v` (`blended-fitness.ts:583` `cv(targetDist, penalizedBlend)` → `:603` `s.v = ...`), collapsing VDOT 50→40. Then `recomputeLT` + the next refresh read the buried value → path-dependence. Forecast (`calculateForecast(currentVdot)`) inherits the buried `s.v`, so "assume the plan is done" silently means "assume you stay at today's volume." Deleted PBs resurrect via `effectivePhysiologyPbs` fastest-wins (`Math.min` of two stores). `demonstratedPBFloor` (ISSUE-285) doesn't help — it's same-distance only.

**Fix direction:** floor the `s.v` writeback at PB-derived capacity (`pbDerivedVdot`) absent real detraining evidence (VDOT-level sibling of `demonstratedPBFloor`); build the forecast from capacity; clear deleted PBs from both stores. **Needs careful tests:** determinism (refresh×N stable), capacity-floor, and a no-regression test so genuinely detrained runners still read lower. **Hot files (parallel agent) — coordinate.**

**Pending decision (Tristan, not yet answered):** sequence ISSUE-297 fix now vs the mandate-volume slider. He paused to request this handover. Recommended: ISSUE-297 first — it fixes all the calibration complaints; the slider doesn't (the 40:00-10K case has volume + a 52 km plan and still breaks).

### Mandate-volume slider (the no-data safety fix) — DECISIONS MADE, not started
When onboarding finds **no background data** (`detectedWeeklyKm` empty → "Weekly volume: --"), the volume budget's gentle ACWR ramp never engages, so a thin-data beginner can get a too-hard plan (probe: 36 km in week 1). Tristan's decision: **mandate** weekly volume entry, "an estimate is good enough."
- **UX decided:** glass slider (`.m-slider-glass`), **hard gate** (Continue disabled until moved, **no default** — no anchoring), only when no data.
- **Where:** the "Weekly volume" card is `renderVolumeRow` (`review.ts:1658`); its editor writes `s.detectedWeeklyKm` (`review.ts:2647`); the review CTA calls `nextStep()` (`review.ts:2634`) with **no built-in guard** — gate it there (block the call + reveal/scroll to the slider when volume is mandatory-but-unset). Set `weeklyVolumeConfirmed` too so the ramp engages.
- UI pre-flight required (UX_PATTERNS + copy rules). Existing slider models: `goal-time-overlay.ts`, `account-view.ts`.

### ISSUE-287 (P2) — short plans front-load the LOAD peak to ~wk 5
Intensity-placement artifact (post-deload + build-phase bounce), NOT volume — a volume envelope can't fix it (confirmed by building+reverting one). Real lever: concentrate quality in the peak phase / damp the early bounce (`qualityCap`/`workoutPriority`). **Plus** Tristan wants an **onboarding flag** warning users a short (≤12 wk) plan is compressed. Details in OPEN_ISSUES ISSUE-287 + SCIENCE_LOG §BW.

### Thread A — intensity-dose provenance (resolved-ish)
The tempo/VO2/MP work-minute doses ARE documented (SCIENCE_LOG "Plan Engine: Session Budgets", ~line 5400) and match code. The *structure* is well-sourced (Seiler/Bompa/Daniels); the *exact base minutes* are medium-confidence coaching defaults, not data-derived. **Verdict: defensible, leave as-is** unless Tristan wants a calibration pass against Pfitzinger/Daniels session tables (he leaned leave).

## 4. Repo hygiene (separate tasks)

- **Push is blocked.** `git push` failed: `.git` is **1.2 GB** (large binaries in 99-commit history) → GitHub `remote end hung up`. Off-machine backup needs a deliberate cleanup task (gitignore + history strip, or Git LFS, or a squashed orphan branch of just the current tree). Until then the work is local-only.
- **Uncommitted docs** (this session's diagnostics + OPEN_ISSUES/SCIENCE_LOG) are not yet committed — entangled with the parallel agent's `src/` WIP in the same tree. Recommend committing the doc files selectively (safe, additive) and leaving the parallel `src/` changes to that agent.

## 5. Hard-won lessons (don't repeat my mistakes)

- **The volume-budget subsystem only runs when BOTH `state.detectedWeeklyKm > 0` AND `state.athleteArchetype` are set** (read live in `generateWeekWorkouts`; archetype set at launch by `detectArchetype`, volume from Strava/typed). A bare `initializeSimulator`/`seedReviewerDemo` test does NOT set them → budget code silently no-ops. **Test budget changes with both populated** or you'll "verify" nothing (I did, twice).
- **`derivePlanShape` derives plan length from `s.wks.length`, not `s.tw`.** To test plan length, rebuild via `initializeSimulator({planDurationWeeks})`, don't just set `s.tw`.
- **Predictions are path-dependent** (ISSUE-297) — re-running mutates state, so probes must reset/control prior `s.v`/`s.lt`.
- Device verification is the real "done" bar; nothing this session is device-verified.
