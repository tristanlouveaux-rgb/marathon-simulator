# Lessons for triathlon prediction/forecast, from the running ISSUE-297 fix (2026-06-17)

We just fixed a family of running prediction/forecast bugs (ISSUE-297: engine buried by low volume, forecast not crediting the plan ramp, deleted PBs resurrecting, and a forecast-DISPLAY facet). Triathletes are reportedly struggling with plans too, and the mirror rule says evaluate tri whenever running's prediction/adaptation changes. These are the transferable lessons, grounded in a quick scan of the tri code — **apply the principles, don't copy the running code** (tri's predictor is per-leg and uses a different penalty model: Friel volume targets in `specific-endurance-penalty.ts`, not running's Coyle detraining model).

You're already mid-fix on the engine-accuracy facet (the `race-validated` / `raceRunVdot` tier so a cross-training-inflated watch VO2max doesn't overstate run capacity). That's the tri analogue of running's RC1 — good. The two below are the ones that took us several rounds to find and that a core-logic fix alone misses.

## Lesson 1 (highest value) — the FORECAST must evaluate the volume penalty at PLANNED PEAK volume, not current

> **✅ ADDRESSED 2026-06-17 (SCIENCE_LOG §CG).** The tri forecast was sampling its dose from a fixed next-4-week look-ahead, which early in a plan sits in the low-volume base phase and under-credits the build (the projected bike/run got dragged by the durability cap). Fixed with the exact two-term decomposition below: the fitness-gain horizon now reads the **build-phase mean** (`plannedBuildDoseByDiscipline`), and the specific-endurance / race-readiness penalty closure reads the **peak the plan holds** (`plannedPeakDoseByDiscipline`). Both read straight from `state.wks[w].triWorkouts` — no invented constants. Taper excluded from both; the taper invariant (projected per-leg == current inside the taper window) is preserved. Probe-verified propagation (`bikeExecutionFactor` 0.60 → 0.86 on a week-1 ramping 70.3). Guards: `tri-volume-by-discipline.test.ts` +10. **NOT device-verified** — Lesson 2 (the on-screen DISPLAY check) still applies.

`specific-endurance-penalty.ts:188` computes `baseVolumeRatio = weeklyVolumeActual / bandTarget.weeklyVolume`. That is correct for **today's** prediction (describe current readiness). It is **wrong for the race-day forecast** if the forecast also feeds it `weeklyVolumeActual` — because by race day the plan has ramped the athlete up, so the penalty should shrink in proportion to the volume the plan *delivers*, per discipline.

This was the core of running's forecast bug: today (off 8 km/wk) was correctly slow, but the forecast inherited that same penalty instead of projecting from the plan's peak volume. A 40:00-10K / 52 km-plan athlete was forecast 3:40 when the truth was ~3:10.

**Two-term decomposition that fixed it (apply per discipline):**
- *Cumulative training dose → engine/fitness gain* → use the **build-phase mean** volume (the dose integral over the block).
- *Race-approach sustained volume → specific-endurance penalty* → evaluate at the **peak** the plan holds (the tri analogue of running's `computePeakWeeklyKm` — find/derive the per-discipline peak the tri plan ramps toward).

**Verify:** does the tri forecast call `computeSpecificEndurancePenalty` (or equivalent) with *current* per-discipline volume? If so, that's the bug. Feed it the planned peak for the forecast; keep current volume only for the "today" number.

## Lesson 2 (the one that slipped through) — audit every forecast DISPLAY surface, not just the core predictor

In running, the engine and the canonical `refreshBlendedFitness` path were *correct*, but two surfaces that **recompute the forecast live** still anchored on the penalised today-time (`renderer.ts`, `plan-preview-v2.ts`), so the user saw a buried forecast (3:54 instead of 3:13) even though the stored value was right. Our earlier validation swept the *compute* path and gave false confidence — the bug was only visible on screen.

Fix pattern: **publish the correct anchor on state once** (running added `s.forecastBlendAnchorSec`, the peak-volume blend) and make every recomputing surface read that, never the penalised today-time.

**Verify in tri:** grep every tri forecast surface for a recompute that anchors on a "today" value:
- `src/ui/wizard/steps/tri-plan-forecast.ts`
- `src/ui/triathlon/` (forecast views, `benchmark-detail-pages.ts`)
- any caller of the tri forecast/projection that rebuilds rather than reads the stored projection.
For each, confirm it reads the *stored, peak-anchored* projection (the tri equivalent of `s.forecastTime` / `forecastBlendAnchorSec`), not a live recompute off current volume. **Validate via the rendered number on each surface, not just the predictor's return value.**

## Supporting principles (cheaper, same class)

3. **Engine vs readiness separation (RC1).** Demonstrated benchmarks (FTP, CSS, race-run VDOT) are *capacity*; low volume limits *readiness*, not capacity. Never write a volume-penalised prediction back into the FTP/CSS/VDOT benchmark. Your `race-validated` tier is the right instinct — also confirm `race-prediction.triathlon.ts` (`out.runVdot.current`, the CSS/FTP baselines ~615-679) never persists a penalised projection into the stored benchmark. Low volume should move the prediction/forecast, not the benchmark. Only *demonstrated recent slowness* (a real recent effort below capacity) lowers the engine.

4. **Tracking vs planning.** Today's number describes current readiness (penalise current volume). The forecast prescribes the trajectory (credit the planned ramp). Same line, per discipline.

5. **No invented constants.** Running's whole fix added zero constants — it just fed each existing term the volume it's a function of. Reuse the Friel/Coggan thresholds already in `specific-endurance-penalty.ts` / triathlon-constants.

6. **Deleted/edited benchmarks resurrecting (RC3).** Running found deleted PBs resurrecting via `Math.min(store A, store B)` fastest-wins + auto-fill re-detection; fixed with a per-distance deletion tombstone (`s.deletedPbs` + `isPbTombstoned`). Check whether deleting/editing an FTP/CSS/swim benchmark in tri can resurrect from a second store or a sync auto-fill. (No tombstone found in `src/ui/triathlon/` on scan — likely unhandled.) Lower priority than 1 & 2.

7. **Known parity debt:** the CTL-gap re-anchor shipped running-only with a pending tri/HYROX mirror (see `memory/project_ctl_gap_reanchor.md`).

## How to start the tri session well

Get a concrete repro, the way the running bugs surfaced (Tristan dogfooding): a specific input → wrong output, e.g. "Olympic distance, FTP 250 / CSS 1:45 / run 40:00-10K, 16 weeks, low recent volume → predicted X, expected Y." A repro tells you which facet (engine, forecast-volume, or display-surface) is firing. The running bug looked like one thing (engine buried) and was actually another (display surface) — only the on-screen number disambiguated it.
