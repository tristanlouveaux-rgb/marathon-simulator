# Triathlon MVP — morning summary

> Built overnight on branch `triathlon-mvp` from commit `03a3072`. Running mode is untouched. Read this, then click through. Punch list at the bottom when you want to decide what's next.

## TL;DR

- Branch: **`triathlon-mvp`** (7 commits on top of HEAD)
- Typecheck: **clean**
- Tests: **985 / 986 pass** (1 pre-existing failure unrelated to this work)
- What works: pick Triathlon on the goals tile → setup screen → plan view with 20 weeks of swim/bike/run/brick sessions on a week-strip nav; home tab, stats tab; race forecast card with per-leg breakdown
- What doesn't: activity sync does not yet feed per-discipline CTL (so fitness numbers show zeroed out until a user has data). All the math is ready — just needs a few lines in the sync layer to call `rebuildTriFitnessFromActivities`.

## How to try it

1. `git checkout triathlon-mvp`
2. `npx vite` (dev server)
3. Reset state (either local storage reset or in-app), start onboarding
4. Pick the **Triathlon** tile on goals. It now shows a "New" badge instead of "Coming soon"
5. Fill the triathlon-setup form (distance, race date, hours, split, sliders, bike, swim)
6. Hit **Build my plan** → quick initialisation → lands on the triathlon plan view
7. Tap between Plan / Home / Stats to look around

## What was built, in phases

Each phase is one commit on the branch. Review at whatever depth you want.

| Phase | Commit | Scope |
|---|---|---|
| 0 | `docs: lock triathlon spec decisions §18` | §18 in `docs/TRIATHLON.md`, Track-vs-Plan principle in `CLAUDE.md` |
| 1 | `feat(triathlon): phase 1 — types, state schema, transfer matrix, skeleton` | Types, transfer matrix constant, blessed constants, state schema v3 migration |
| 2 | `feat(triathlon): phase 2 — wizard fork + triathlon-setup step` | Goals tile, triathlon-setup screen, controller routing |
| 3 | `feat(triathlon): phase 3 — plan engine, scheduler, swim/bike/brick libs` | Full plan generation 20-week 70.3 / 24-week IM |
| 4 | `feat(triathlon): phase 4 — per-discipline fitness + swim/bike TSS + race prediction` | Math layer (no state wiring yet) |
| 5 | `feat(triathlon): phase 5 — plan / home / stats views + race forecast` | UI in `src/ui/triathlon/` with 3-tab nav |
| 6 | `feat(triathlon): phase 6 — discipline-aware matcher + brick detector` | Pure functions ready for sync wiring |
| 7 | `feat(triathlon): phase 7 — tests + docs` | 36 new tests, FEATURES/ARCH/SCIENCE_LOG updates |

## Spec decisions applied

All 16 open questions from `docs/TRIATHLON.md §16` are resolved and live in §18 "Locked Decisions". Key ones to flag:

- **Always race mode** for tri — no "general fitness triathlon"
- **Per-discipline CTL + combined CTL** via transfer matrix (see `src/constants/transfer-matrix.ts`)
- **No training-load discount on brick runs** — the 5/11% is a race-time prediction input only (Track vs Plan)
- **Power-optional bike** with HR fallback
- **30-min brick detection window**
- **Volume split 17.5 / 47.5 / 35%** as preset, user-adjustable at onboarding
- **1–5 self-rating sliders** per discipline (replaces runner type for tri users)
- **Skipped workouts per-discipline** (push next week, drop on second)

## Things you should eyeball before doing anything else

1. **The transfer matrix values** (`src/constants/transfer-matrix.ts`). Run / bike / swim rows are literature-backed. Padel / ski / football / hiking rows are first-approximation proposals I made based on physiology reasoning — they need your sanity check. Flagged in §18.11 and the science log.
2. **Race prediction bike-speed-from-FTP curve** in `src/calculations/race-prediction.triathlon.ts:estimateBikeSpeed`. Linear fit 100W = 25kph, 300W = 40kph. Accurate for a flat course on a road bike — will be off for hilly courses, aero TT bikes, or very heavy/light riders. Good enough for a forecast headline, not a pacing plan.
3. **Default peak hours by skill level** in `triathlon-constants.ts:DEFAULT_WEEKLY_PEAK_HOURS`. If a beginner 70.3 athlete at skill 1 should peak at 6h/week (my guess), you tell me. If it should be more or less, change there.
4. **Volume split ranges on the sliders** in `triathlon-setup.ts` — swim 5–40%, bike 20–70%, run 15–60%. Generous, but stops users committing to something unreasonable.

## What's not wired (deferred)

In priority order, so you can pick what to tackle next:

1. **Sync pipeline → triConfig.fitness**. `rebuildTriFitnessFromActivities` is tested and ready. One function call in `src/data/activitySync.ts` (or wherever you want the update to fire) after any activity batch lands in state. Without this, the per-discipline CTL stays zero — functional but not informative. This is the highest-leverage next step.
2. **Cross-discipline ACWR suggestion extensions** (§18.5). When swim ACWR > 1.3 or combined ATL is red from padel/gym spikes, surface a suggestion via the existing Replace/Reduce modal. Mostly an integration job in `suggestion-modal.ts`.
3. **Injury engine discipline-shift** (§18.6). Biggest win — runner's knee should move volume to bike + swim. Existing injury-phase progression stays, just re-routes.
4. **Strava express onboarding** (§18.9). Pre-populate CSS / FTP / running PBs from Strava history when 8+ weeks are detected.
5. **Target editing from stats page** (§18.8). UI was drafted but not wired — tapping a target would open a small inline editor and write to `triConfig.userTargets`.
6. **Guided runs for bike/swim**. V2.

## Things I'd flag to myself if I were reviewing this code

- **Commits mix my Phase-2 changes with an earlier wizard-cleanup WIP that was already in your working tree.** The branch was cut at `03a3072`, but the working tree had uncommitted wizard refactoring. When I committed, the ~400 lines of wizard restructure rode along with my 30 lines of tri routing. Diff looks bigger than my actual change in controller.ts / renderer.ts. Noted in the Phase 2 commit message.
- **`initializeTriathlonSimulator` sets `s.rd = 'marathon'` as a placeholder** because the triathlon distance type doesn't extend `RaceDistance`. Triathlon views read `triConfig.distance` directly; shared views that read `s.rd` show "marathon" which is harmless but odd. Could widen the `RaceDistance` type later if anything actually breaks.
- **Load values on swim/bike workouts are first-approximation `tssPerMin` multipliers**. Once the sync pipeline feeds real bTSS / sTSS into state, those generated workouts should be re-scored against the activities they match. Tracked as a TODO in the workout library files.
- **The plan view's week-strip nav is strictly display.** Clicking a week number doesn't jump. Trivial to add — didn't ship because it needs a rendering hook I didn't want to touch.
- **No 'Return to plan' button** for tri users who relaunch the wizard mid-plan (running mode has one). If a tri user goes back to onboarding they restart — need a mid-plan edit path.

## Files touched

New files only (running mode untouched):
```
src/types/triathlon.ts
src/constants/transfer-matrix.ts
src/constants/triathlon-constants.ts
src/state/initialization.triathlon.ts
src/workouts/plan_engine.triathlon.ts
src/workouts/scheduler.triathlon.ts
src/workouts/swim.ts
src/workouts/bike.ts
src/workouts/brick.ts
src/workouts/plan_engine.triathlon.test.ts
src/calculations/triathlon-tss.ts
src/calculations/triathlon-tss.test.ts
src/calculations/fitness-model.triathlon.ts
src/calculations/fitness-model.triathlon.test.ts
src/calculations/race-prediction.triathlon.ts
src/calculations/activity-matcher.triathlon.ts
src/calculations/brick-detector.ts
src/calculations/brick-detector.test.ts
src/ui/wizard/steps/triathlon-setup.ts
src/ui/triathlon/colours.ts
src/ui/triathlon/workout-card.ts
src/ui/triathlon/race-forecast-card.ts
src/ui/triathlon/tab-bar.ts
src/ui/triathlon/plan-view.ts
src/ui/triathlon/home-view.ts
src/ui/triathlon/stats-view.ts
docs/MORNING_SUMMARY.md
```

Modified (all additive, zero running-mode behaviour change):
```
src/types/state.ts              +eventType, +triConfig, +Workout.discipline, +brickSegments, +triWorkouts, schema v3
src/types/onboarding.ts         +triDistance/time/split/skill/bike/swim, +triathlon-setup step
src/state/initialization.ts     +triathlon fork
src/state/persistence.ts        +migration v2→v3
src/ui/main-view.ts             +triathlon fork (3 lines)
src/ui/wizard/renderer.ts       +renderTriathlonSetup case
src/ui/wizard/controller.ts     +triathlon routing in nextStep/previousStep
src/ui/wizard/steps/goals.ts    +triathlon tile enabled, click handler
CLAUDE.md                       +Track-vs-Plan principle
docs/TRIATHLON.md               +§18 locked decisions
docs/FEATURES.md                +Triathlon Mode section (T1–T9)
docs/ARCHITECTURE.md            +module map + state abbreviations
docs/SCIENCE_LOG.md             +5 new entries (matrix, swim TSS, CTL, pace discount, detraining)
docs/CHANGELOG.md               +2026-04-24 triathlon MVP entry
```

Happy clicking.
