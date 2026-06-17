# Handover — Triathlon run/bike/swim prediction accuracy (2026-06-17)

Branch: `feat/revenue-cat-iap` (NEVER pushed to git remote — 1.2GB .git bloat; "push to TestFlight" = native iOS build, not git push). TestFlight push is **HELD** pending device verification — do not upload without Tristan's go.

Multiple agents commit to this branch concurrently. `SCIENCE_LOG.md` / `OPEN_ISSUES.md` get edited externally mid-session — **re-read before editing** (you'll hit "file modified since read"; don't hammer Edit, re-read first).

---

## 1. The problem we were solving (the dogfood)

A triathlete ("Alex") with a real 70.3 result — swim 1.9km **36:00** (~1:54/100m), bike 90km **2:29** (~36 km/h), run 21.1km **1:55** (5:27/km) — and an Apple Watch VO2max of **56**, was shown nonsense:
- easy pace **4:45/km**, threshold **3:58/km**, projected marathon **3:33** (all far too fast)
- Ironman bike leg **6:34** (super slow — ~27 km/h, vs his real 36 km/h)
- swim projected **1:41/100m** (faster than his actual 1:54)
- 12-hour Ironman total

**Root theme (one sentence):** the app trusted generic models and a cross-trained watch VO2max over the athlete's *actual race result*. A watch VO2max is built by cycling + swimming, so for a triathlete it overstates *running* fitness (VDOT 56 ≈ sub-19 5K; his 1:55 half is VDOT ~43). The bike used a generic FTP→speed model that ignored his demonstrated 36 km/h. The swim treated his recent race-derived CSS as "detrained".

Tristan's clinching framing: *"You and Alex have the same watch VO2max (56), but you run 3:10 and he runs 4:00 — only running evidence tells them apart."*

---

## 2. What I built (all committed, full test suite green, NOT device-verified)

### Commits (mine, interleaved with other agents' tri commits — no conflicts)
- `ae0545e` — race-validated run VDOT anchor + `review.ts` caption fix (also captured prior-session WIP in the tree).
- `05941b5` — cold-start skill-slider cap.
- `3f88131` — watch VO2max capped at running-specific evidence (the "evidence ceiling").
- `6f59d2d` — bike + swim race-split anchors.

### The run-fitness model now (priority order for resolved VDOT)
`getPhysiologicalVdot` (`src/calculations/physiological-vdot.ts`):
`override → mosaic-running (standalone runs, high/med conf) → **race-validated (NEW)** → device(watch) → hr-calibrated → lt-derived → pb-median → tanda-fallback`

Two more layers that actually drive the *predictions* (the displayed VO2max is just the chain above):
1. **`effectiveVo2max(s, now)`** — the VO2 value fed into EVERY `blendPredictions` call. Now caps the watch (TRI ONLY, gated on `s.triConfig != null`) at the **max of running-specific evidence**: race anchor (`raceAnchorVdot`), PB-median (`pbDerivedVdot`), medium+ HR-pace calibration (`hrCalibratedVdot`). Because it's the *max*, a recent fast run / fresh PB *raises* the ceiling — a genuinely fast runner with the same watch is NOT capped (PBs aren't a ceiling). Running mode untouched (no triConfig → watch trusted, since there it's run-specific).
2. **`refreshBlendedFitness`** (`blended-fitness.ts`) — after the existing PB-capacity floor:
   - **Race-anchor floor/cap**: engine VDOT floored at the race anchor, and a watch-inflated engine capped DOWN to it unless PBs / a recent run corroborate higher.
   - **Cold-start skill cap**: if NO running-specific signal at all (no PB, no race, no recent run, no medium+ HR calibration), cap the engine at the run skill-slider self-assessment (`estimateRunPaceFromSkill`, existing per-level table). Tri only (`s.triConfig?.skillRating?.run`).

`s.v` is the chokepoint: `getEffectiveVdot = s.v + rpeAdj + physioAdj` drives all training paces; the tri run leg reads `state.v`; the marathon forecast comes off `s.v`. So fixing `s.v` + `effectiveVo2max` fixes paces, the tri run leg, and the forecast together.

### State fields added (`src/types/state.ts`, both optional/fresh-install-safe)
- `raceRunVdot?: { vdot, dateISO, distance, source }` — fatigue-discounted fresh-run-equivalent VDOT from a race run leg.
- `raceBikeKph?: { kph, raceDistance, dateISO, source }` — demonstrated bike speed from a race bike leg.

Both seeded at TWO entry points:
- **Onboarding** — `src/state/initialization.triathlon.ts` `derivePastRaceBenchmarks` + the seed block (~line 226). Reads `state.onboarding.triPastRace`.
- **Logged race** — `src/calculations/tri-race-outcome.ts` `detectAndLogRaceOutcome` (after `appendRaceOutcome`). Most-recent-wins guard (`raceDate >= prev.dateISO`).

Helpers (`physiological-vdot.ts`): `raceRunLegToVdot(runSec, runDistM, fatigueDiscount)`, `raceAnchorVdot(s, now)` (recency-gated 365d via `RACE_VDOT_ANCHOR_MAX_AGE_DAYS`, reusing `RUN_PB_RECENCY_BANDS` strong band). dateISO may be `YYYY-MM` (onboarding) or `YYYY-MM-DD`.

### Bike (`src/calculations/race-prediction.triathlon.ts`)
- `raceBikeAnchorKph(state)` helper (recency-gated 365d).
- New top-priority branch in `estimateBikeSpeed`: **CdA path** when FTP + body weight + bike weight set (reverse-solve personal CdA via `solveCdA` from the demonstrated ride at power = FTP × the anchor race's IF, then `solveSpeed` at the target leg's IF); else **speed-scaling** `kph × (targetIF/raceIF)^⅓` (speed ∝ power^⅓; Martin 1998). Uses `RACE_INTENSITY_BY_DISTANCE` (sprint .88 / olympic .83 / t100 .76 / 70.3 .78 / ironman .70).

### Swim (`race-prediction.triathlon.ts`)
- `buildProjection` gained `cssFromRecentRace?: boolean`; the swim detraining penalty (`CSS_DETRAINING_PER_4WK`) is skipped when it's true, exactly like a user-set CSS. Call site passes `cssFromRecentRace: raceBikeAnchorKph(state) != null` (a recent race ⇒ they swam recently ⇒ not detrained). Fixes the "1:41 faster than his real 1:54" inversion (the penalty was inflating the race-derived CSS, then the horizon improved off the inflated baseline and undercut his actual swim).

### Other
- `review.ts` — added a `race-validated` case to the onboarding VO2max caption `switch` (it has no `default`, so a missing case silently showed generic "estimate from your recent harder runs"). Caught during self-review.
- Tests: `physiological-vdot.test.ts` (race tier; effectiveVo2max evidence ceiling — caps at PB, no cap when evidence exceeds watch, running-mode untouched, override never capped, stale stands down), `blended-fitness.test.ts` (race anchors s.v; no-anchor watch-driven; stale stands down), `tri-race-outcome.test.ts` (seeding), `race-prediction.triathlon.test.ts` (bike anchor faster than generic; stale stands down; recent-race swim not detrained).
- Docs: `SCIENCE_LOG.md §CC` + addenda; `CHANGELOG.md` (2026-06-17); `OPEN_ISSUES.md`; `FEATURES.md` (run anchor only — bike/swim not yet added to FEATURES); memory `project_race_validated_vdot_anchor.md`.

---

## 3. Verified numbers (watch VO2max 56; via throwaway temp tests, deleted)

| Scenario | Result | Was |
|---|---|---|
| Run, 70.3 race anchor | VDOT 43, marathon 3:36, easy 5:40 | — |
| Run, no race, cold-start skill-3 | 44.3 / 3:31 | 50.7 / 3:08 (and getPhysiologicalVdot alone gave 56 / 2:53) |
| Run, pulled 1:55 half PB | 47.3 / open marathon 3:19 | 49.3 / 3:13 |
| Run, fast runner same watch + 16:00 5K | 64.6 (uncapped) | — |
| Bike, 70.3 anchor 36.2 km/h | base 34.9 km/h ≈ 5:10; rendered leg 5:55 | generic 27 km/h / 6:34→7:30 |
| Swim, recent race-derived CSS | not detrain-inflated | inflated ×1.125 |

Repro pattern: build a `SimulatorState`, call `refreshBlendedFitness(s)` then read `getEffectiveVdot(s)`, or `predictTriathlonRace(s)` and read `.bikeSec`/`.swimSec`/`.runSec`. `vt(km, vdot)` for time, `gp(vdot).e/.t/.m` for paces. Use a temp `*.tmp.test.ts` and delete it.

---

## 4. THE BIG REMAINING ITEM — forecast-volume / durability (the fragile one)

**Plain English:** the race-day forecast is pessimistic for beginners because it judges fitness off *current* (week-1, often empty) volume instead of the volume the plan *builds to*. This is why Alex's bike still shows 5:55 not 5:10, and why the no-data onboarding screen showed "+0" next to every "Add Training" lever.

**Two penalties, both judged off current volume, both suppress the PROJECTED leg:**
- **Durability cap** (`applyDurabilityCap`, `durability-cap.ts`) — "can you hold this pace for 180km / 42km?" A beginner with no long rides logged gets penalised. This is the MAIN lever on Alex's bike (34.9→30.4 km/h even for a same-distance target).
- **Readiness penalty** (`computeTriRaceReadiness` → `specific-endurance-penalty.ts`, read at `race-prediction.triathlon.ts:~265`) — reads `recentHoursByDiscipline` (current volume).

**How running mode already solved it (mirror this):** `blended-fitness.ts:728–795` computes `computePeakWeeklyKm` (the plan's own peak), re-runs the prediction pipeline at that peak, and publishes `s.forecastBlendAnchorSec` so display surfaces read the peak-based number, not the penalised today-time. See `docs/TRIATHLON_PREDICTION_LESSONS.md` (Tristan's lessons doc) — Lesson 1 (forecast at planned PEAK volume) and Lesson 2 (audit every forecast DISPLAY surface, not just the predictor — running's bug was a display surface recomputing off today's time).

**The tri fix (proposed, NOT built):** for the PROJECTED leg only, feed the durability cap + readiness penalty the planned PEAK per-discipline volume (and planned longest session), not current. Tri has per-discipline volume so you need a per-discipline peak helper (the tri analogue of `computePeakWeeklyKm`). Keep current volume for the "today" number. Validate the RENDERED leg times across all 5 distances, not just the function return.

**WARNING:** this is the change that took the running side several rounds. It's the most fragile part of the predictor. Do it carefully, mirror the proven running approach, do not invent constants, and check rendered numbers. I deliberately did NOT rush it at the tail of a long session.

**What I tried and REVERTED (don't repeat):** I extended `readTriRaceRecencyDays` (specific-endurance-penalty.ts) to count the onboarding `triPastRace` toward the race-recency penalty reduction. It typechecked but moved NO rendered number (even same-distance), because the bike's lever is the **durability cap**, not the race-recency-reducible readiness penalty. Reverted cleanly (no diff) per "don't ship a fix you can't show working." A recent race relaxing the readiness penalty is still correct in principle, but it's not the bike's bottleneck.

---

## 5. Other open items (lower priority)
- **tri-past-race onboarding ASK-fallback** — running PBs ALREADY auto-pull from Strava/Apple `best_efforts` via `applyPBsFromRows` (`appleHealthSync.ts:1778`) into `s.pbs`, and those flow to the tri run blend. So connected users are anchored without asking. The explicit "enter a recent run/PB" prompt on the `tri-past-race` step (pre-filled from any pulled PB, prompt only if none) is NOT built. Lower priority because pull covers most.
- **Marathon-specificity residual** — open-marathon VDOT-equivalent off a half PB (3:19) is aggressive vs a real age-grouper marathon (~4:00). Separate from the watch bug; it's how a half extrapolates to a full. Lower priority.
- **Run readiness penalty** is not relaxed by a tri past race (only the run *engine* / s.v is, via the VDOT anchor). `readRunPbAgeDays` reads run PBs, not the tri race run leg.
- **FEATURES.md** — bike/swim anchors not yet documented there (only the run anchor is, ~line 185).

---

## 6. Tristan's decisions (so you don't re-litigate)
- A recent race wins over a watch VO2max — for ALL THREE disciplines.
- The watch is capped at running-specific evidence, never gutted: "VO2max is still important" — it stays a weighted blend factor, just can't exceed demonstrated running evidence. Cold-start handled "soft" (skill-slider).
- Bike: "both" — CdA when weights known, else speed-scaling.
- "Pull rather than ask is amazing" — prefer auto-pull over onboarding prompts.
- Validate the RENDERED number, not just the function (the lessons-doc meta-rule). Don't ship fixes you can't demonstrate.

---

## 7. Gotchas / traps
- `effectiveVo2max`'s cap is gated on `s.triConfig != null`. **Do not remove the gate** — it would cap runners' watch values too and could regress running mode.
- `raceRunVdot` / `raceBikeKph` are only ever set in tri paths. The race-anchor logic in `blended-fitness.ts` is NOT gated on triConfig (it keys off the anchor presence), so it's implicitly tri-only.
- The full test suite occasionally shows 2–3 failures that are PRE-EXISTING / environmental, not regressions: `demo-data.test.ts` (a hardcoded future date went stale — date-bomb), `plan_engine.triathlon.test.ts §CB` (a strict-`>` tie 197 vs 197, bike-side, from yesterday's uncommitted hours-cap work), `coach-tools.test.ts` (passes alone, fails under concurrent load — isolation flake; coach path imports neither `physiological-vdot` nor `blended-fitness`). Clean runs: **3448 pass / 0 fail**.
- "6:34 bike" was NOT a units/formatting bug (I initially misdiagnosed it as a `targetPaceSecPerKm` leaking onto a bike target). It's the bike-leg TIME from the linear FTP→speed fallback. Corrected.
- `git stash` / `git checkout -- <file>` are FORBIDDEN here (CLAUDE.md git-safety). To revert your own edit, use Edit to reverse it (I did this for the recency revert).

## 8. Commands
- Typecheck: `npx tsc --noEmit`
- Tests: `npx vitest run` (full) or `npx vitest run <file>`
- UI lint: `npm run lint:ui`
