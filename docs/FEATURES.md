# Mosaic Features

Plain-English description of every feature, where to find the code, and test status.
Update the status column after running `npx vitest run`.

---

## Marketing-ready feature list

Short, user-facing descriptions for App Store copy, landing pages, social. Consultant tone, no superlatives. Engineering catalogue starts below the next divider.

### One app, every endurance goal
- Marathon, triathlon, cycling, and heavy-load sports in a single plan engine.
- On-Demand mode for athletes who don't want a fixed plan: generate a session whenever you want one. (The premium "let Coach build a context-aware workout" path is hidden for App Store v1; the free rule-based generator stays.)
- Mode switching preserves history. Train for a marathon this year, a 70.3 next year, without resetting.

### Plans that adapt to what you actually did
- Every week is regenerated from the sessions you completed, skipped, or pushed.
- Skipped sessions get pushed forward once, then drop with the prediction adjusted honestly.
- Holiday, illness, and injury modes reshape the plan around real life, not around the plan.
- Replace-and-reduce: swap a hard session for an easier one in two taps and the rest of the week rebalances.
- Every workout card shows its total time, and it updates live as you adjust. Distance runs show distance and time; structured sessions show time. (All modes.)
- Every workout carries its pacing (2026-06-04): easy and long runs show their easy-pace target ("7km @ 6:10/km") alongside the paces threshold/VO2/MP sessions always had; swim speed reps show an absolute fast pace when CSS is known; rolling bike endurance shows its Z2 watt range when a power meter is present. Run targets regenerate each render so they track marker updates automatically. (Sprint/max-effort items are intentionally target-less.) Pace factors live in one canonical map (`RUN_PACE_FACTOR_VS_EASY`, `src/workouts/intent_to_workout.ts`). ✅ tested, ❌ not device-verified.
- Adjust any session on the fly: a per-session slider scales the whole session up or down (easy runs, tempos, and intervals all shrink proportionally to the time you have). There's also an Easier/Harder intensity control: running steps the pace ladder (easy→marathon→threshold→VO2), bike steps a %FTP ladder (endurance→tempo→sweet-spot→threshold→VO2, showing the live watt target), and swim steps a CSS-pace ladder (showing the live pace target). One-tap "Got less time" presets too. The change applies to that session only. Your plan, targets, and race prediction stay put, and a deliberately shorter session is scored as done, not missed. **Available in all modes**: running, triathlon, cycling, and HYROX (run + bike/erg/swim sessions). HYROX stations/bricks have no intensity control (round/rep-structured). The adjustment **persists across reloads** — running scales re-attach to their session by a stable slot id (so a plan reshuffle can't lose them), and triathlon/cycling/HYROX scales are written straight onto the stored session object. HYROX stations/bricks and gym sessions (rep/round-structured) are deferred to a follow-up. **Targets follow the adjustment** (2026-06-04): stepping intensity rewrites the prescription numbers in the description — run paces retarget to the new ladder type from the live easy pace (`retargetDescriptionPace`), bike watt ranges scale by the ladder %FTP ratio (`scaleWattRanges`), swim paces become CSS + the new rung's offset (`setSwimPaceTokens`) — so the card, the detail modal's Target line, and the adherence grader all agree. Adjusted sessions saved before this build heal at render (`modDisplayDescription` at every mod re-apply site, canonical: `src/ui/week-resolve.ts`). (Code: `src/ui/workout-adjust-overlay.ts`, `src/workouts/workout-scaling.ts`; tri/HYROX entry points in their workout detail modals. ✅ helper-tested; running device-verified by Tristan 2026-06-01; retarget ❌ not device-verified.)

### Plans that start where you actually are
- Week 1 volume is anchored to your current weekly km — no cold-start jump from 18 km/wk to 50 km/wk.
- At low weekly volume the plan gives you a few longer runs rather than a scatter of pointless 15-min jogs. Easy runs never drop below 25 minutes; when the week's volume can't fill every run-day at that length, run-days are dropped and the survivors lengthened, climbing back to your chosen frequency as volume ramps. A short note on the Plan view explains the lower run-count in early weeks. (Code: `applyHoursBudget` in `src/workouts/plan_engine.ts`; `buildRunDayRampNote` in `src/ui/plan-view.ts`. ✅ tested; not device-verified.)
- The plan recognises seven athlete types: returning runner, consistent runner, cyclist learning to run, court-sport crossover, sedentary novice, and others. Each gets its own ramp slope.
- Bone and tendon adapt slower than cardio, so non-impact crossovers (cyclists, swimmers) ramp at 5%/week. Detrained runners with marathon history ramp at 10%/week to reflect muscle memory.
- The forecast reflects the actual ramp. A plan that takes 12 weeks to reach peak gets a smaller predicted improvement than one that's already there — honest about what you can deliver.
- Athletes heavier than the general-population average can opt into a size-tuned plan: some easy running is gently swapped for low-impact cross-training (bike, swim, elliptical) to keep cumulative joint load manageable without losing aerobic fitness. Opt-in at onboarding, off any time, framed as physics rather than a verdict on body type. From there the app adapts to you live from your HR and pace.

### Honest race predictions
- Marathon, triathlon, and HYROX finish times update weekly from your training.
- Triathlon predictions account for course profile, water type, expected temperature, and altitude.
- Heat penalty scales with body size. Larger athletes store heat faster, so their hot-weather forecast and hot-day training analysis account for the added strain (needs weight and height).
- HYROX predictions are anchored against 89,000 real finishers and your own station test results.
- Cross-training counts where the science says it should. If you're fit from other aerobic sport (cycling, rowing, swimming, team sport), the app trusts your fitness more for shorter races instead of assuming low running mileage has cost you, and your race-day forecast climbs faster because an existing aerobic engine converts to running quicker than building one from scratch. The marathon stays judged on long-run endurance, which cross-training does not replace. Mark it with the "Also fit from other sports" toggle at onboarding (auto-detected from your logged activity); the prediction page tells you when it moved your number. (Code: `crossTrainingPredictionCredit` in `predictions.ts`, `CROSS_TRAINED_FORECAST_PREMIUM` in `training-horizon.ts`; SCIENCE_LOG §BV/§BX. ✅ unit-tested, ❌ not device-verified.)
- Race-day outcomes feed back into the model so future predictions get sharper.

### Reads your recovery, not just your training
- Sleep quality, HRV, resting HR, and sleep debt all feed today's readiness score.
- Personal baselines, not population averages. Your "low HRV" is judged against your own 28-day norm.
- Leg fatigue tracked separately from cardiovascular load. Heavy eccentric days are flagged before they break you.
- Cumulative sleep debt is modelled with exponential decay, capped surplus credit, and a forward outlook.

### Built-in coaching
- AI Coach answers questions about your plan, your recovery, and what to do today. (Hidden for App Store v1 behind `AI_COACH_ENABLED`; see AI Coach v3 section.)
- A rules-based coach picks a stance every morning (Ready to Push, On Track, Manage Load, Ease Back) with a one-line explanation.
- Workout notes after every session: what went well, what was off, and what it means for the week.

### Numbers that update themselves
- FTP, CSS, VDOT, and threshold pace auto-update from your training when the evidence is strong enough.
- Manually entered values yield to better numbers, so the system never holds you to an old test.
- Per-station HYROX benchmarks and personal pace offsets calibrate from every race and every test.

### Real data, real safety
- Acute-to-chronic workload ratio enforced with continuous gradients, not arbitrary caps.
- Quality sessions are downgraded automatically when load climbs too fast.
- Triathlon adds per-discipline fitness, fatigue, and form so a hard bike week doesn't sabotage a run block.

### Works with what you already use
- Strava, Garmin, and Apple Watch sync automatically. Strava is treated as canonical when both report the same activity.
- Built-in GPS tracker for users who'd rather record in the app directly. Includes guided runs and live splits.
- Activity matching writes back to the plan, so a recorded session counts toward your week without manual logging.
- File upload (.fit, .gpx, .tcx) and full export (.zip) for users without live sync — your data, your portability right.
- Apple Health is the universal pipe: any watch that writes to it (Apple Watch directly; Garmin, COROS, Polar once the user enables Apple Health in that watch's own app) flows in without partner approval — our HealthKit query does not filter by source. Garmin via Apple Health arrives thin (avg HR + time, no route/zones), so any activity can be enriched by uploading its original file ("Add detail from Strava"), and a guided screen walks you through bringing your full Strava history. Discovery: users who are not Strava-connected and have ≥3 thin activities see a dismissible Home banner ("Add heart rate and splits to your runs") that drives the one-shot guided archive import, so the enrich path is found without digging into a single activity. The thin-activity test is the canonical `isThinActivity()` (`activity-enrich-merge.ts`), shared by the per-activity affordance and the banner. Single-file upload uses `ingestActivityFile()` (`fitImport.ts`): drop any one activity file and it auto-attaches to the matching thin run by timestamp (enrich in place, no duplicate) or imports as new — the user never has to find the run. A native "Share to Mosaic" seam (`window.__mosaicIngestSharedFile`, `shared-file-intake.ts`) lets an iOS share-sheet open call the same path; native wiring spec in `docs/SHARE_TO_MOSAIC.md` (pending rebuild). This matters only for non-Apple watch users outside the Strava beta — Apple Watch writes full data (route/HR stream) to Health, and Garmin bridges only average HR.
- Add a run from a screenshot: snap a summary from any run app, the on-device reader (iOS) or cloud reader (web) pulls out distance, time, splits, and HR.

---

## Engineering catalogue

The rest of this document is internal: every shipped feature with file paths, key functions, and test status.

---

## HYROX Mode (Phase 0 — foundation + wizard, behind `eventType === 'hyrox'`)

HYROX is a fully-separate mode for the hybrid run+functional-station racing format. Selected at onboarding (goals tile now active). Phase 0 delivers the complete onboarding wizard flow and state foundation; Phase 1 delivers the plan engine; Phase 2 delivers the full UI.

### H0. HYROX Foundation (Phase 0)
**What it ships**: Types (`AbilityBand`, `HyroxStation`, `HyroxConfig`, `HyroxSessionKind`), `EventType: 'hyrox'`, `Workout.musculoTendonLoad`, `SimulatorState.hyroxConfig`. Constants file (`hyrox-constants.ts`): MTL caps by band, time-to-band thresholds, station MTL factors (modality × impact), 3D load profiles, weekly session targets, plan duration table, eccentric-heavy station list. Mode detection helper (`isHyroxMode()`). MTL calculator (`computeComponentMTL`, `computeEffectiveMTL`).

**Onboarding wizard flow**: goals → connect-data → hyrox-setup → review → initializing → main-view. `hyrox-setup.ts` collects: competition format (Open/Pro), previous HYROX finish time (shows live ability band), race event (required — picked from `HYROX_WORLD_SERIES`; venue is derived from event id), weekly hours, sled/SkiErg/RowErg access. Picking an event sets `hyroxRaceEventId` + `customRaceDate` + `hyroxVenueId` together; the manual-date fallback shows a separate venue picker.

**Ability band derivation**: previous HYROX time maps to band via thresholds (sub-1h=competitive, 1–1:20=advanced, 1:20–1:40=intermediate, 1:40–2h=novice, 2h+=beginner). Falls back to experience level slider when no time given.

**Initializer** (`initialization.hyrox.ts`): derives band → MTL cap → session counts → plan duration → calls `generateHyroxPlan(s)` which populates `wk.triWorkouts` on every week.

**MTL model** (`mtl.ts`): `rawMTL = IL × modalityFactor × impactFactor × (1 + externalFactor)` where `IL = durationMin × sRPE`. Saturation curve: `effectiveMTL = cap × (1 - exp(-raw/cap))`. Station and run intensity factors from research doc §3.3.

**Key files**: `src/types/triathlon.ts` (types), `src/types/state.ts` (musculoTendonLoad, hyroxComponents), `src/types/onboarding.ts` (wizard step + HYROX fields), `src/constants/hyrox-constants.ts`, `src/constants/hyrox-benchmarks.ts` (population seed times), `src/calculations/hyrox-mode.ts`, `src/calculations/mtl.ts`, `src/ui/wizard/steps/hyrox-setup.ts`, `src/state/initialization.hyrox.ts`

### H1. HYROX Plan Engine (Phase 1)
**What it ships**: Full Week[] plan generation with real workouts (no more skeleton weeks).

**Population benchmarks** (`hyrox-benchmarks.ts`): Station seed times from HyroxDataLab (700k+ races), RoxLyfe elite/average analysis, Hyroxy.com Open averages. 6 bands × 8 stations. Run pace and RoxZone transition times by band. Key finding: Sled Pull, Wall Balls, Burpee BBJ = primary skill discriminators; SkiErg/RowErg compress the field.

**Plan engine** (`plan_engine.hyrox.ts`): Phase-based periodisation (base=0–40%, build=40–75%, peak=75–90%, taper=90–100% of plan). Volume ramping via phase multiplier (same pattern as triathlon engine: 0.55–0.85 base, 0.92 build, 1.0 peak, stepped taper). Deload every 4th week (×0.70). Weekly hours from `hyroxConfig.weeklyHoursAvailable` × multiplier, split 40/35/25 across runs/stations/bricks. Session mix progresses by phase: base=all easy+technique; build=adds tempo+density; peak=intervals+density dominant. MTL cap enforced by proportional scaling if weekly MTL exceeds band cap.

**Execution → next-week load (2026-06-01, P2 / SCIENCE_LOG §AU)**: HYROX is no longer purely phase-driven. `hyroxEffortMultiplier` (`effort-multiplier.hyrox.ts`) reads trailing RPE-vs-expected across **all** HYROX sessions (stations + bricks + runs) over the last 2 completed weeks and scales the weekly budget: `effectiveHours = hours × phaseMult × deload × effortMult`. Same formula/bounds as running and tri (`1 − score × 0.05`, [0.85, 1.15]), same under-duration guard, applied to weeks ≥ current only, non-compounding. RPE-primary (the objective station-adherence signal doesn't exist for synced activities and is a deferred guided-only enhancement; HR rejected for intermittent station work). Volume/density is the correct HYROX lever because race implements are fixed-weight. Surfaced inline on the plan-view current-week summary when the shift is ≥5% ("Load raised/eased N% this week after recent sessions were rated easier/harder than planned").

**Generators** (`hyrox-generators.ts`): 7 session kinds → `Workout` with `hyroxComponents[]`. **Round count fills the time budget** for all circuit sessions (SCIENCE_LOG §AO): rounds = `floor(budget ÷ roundDuration)` clamped to the band's coach range (beginner 2–4, novice/intermediate 4–6, advanced/competitive 6–8, from research §3.5), and the headline `estimatedDurationMin` is computed from the prescribed work+rest, not the raw slot. Station technique: up to 4 stations at 65% seed pace, 60s/3min rest, + easy run finish. Station density: 2 race-discriminator stations + 1 erg at race pace, 30s/2min rest (research §7.2 "station work for time"). Full brick: N rounds × (1km run + 1 key station). Mini brick: beginner variant (500m + erg). Rounds + rests are stored on the workout (`hyroxRounds`, `hyroxRoundRestSec`, `HyroxComponent.restAfterSec`) so the detail modal and guided player read one source. All sessions compute `musculoTendonLoad` via `computeComponentMTL` (now scaling with actual rounds).

**Week 1 Station Calibration Test** (`generateHyroxAssessment` in `hyrox-generators.ts:481`): Every HYROX user gets the assessment session in Week 1, replacing the first station slot (`plan_engine.hyrox.ts:255-260`). One easy pass through all accessible stations at RPE 4, low MTL by design. Times entered after the session calibrate `stationBenchmarks` for plan personalisation. Users with prior race-derived benchmarks still receive it as an optional re-test — they skip/replace it like any other workout if they don't want it.

**Scheduler** (`scheduler.hyrox.ts`): Constraint-based day assignment (not rigid template). Priority order: bricks first → intervals → density → tempo → technique → easy runs. Bricks → Saturday; high-intensity sessions spaced ≥2 days apart.

**Key files**: `src/workouts/plan_engine.hyrox.ts`, `src/workouts/hyrox-generators.ts`, `src/workouts/scheduler.hyrox.ts`, `src/constants/hyrox-benchmarks.ts`, `src/calculations/effort-multiplier.hyrox.ts` (execution→load multiplier)

**Test status**: ❌ No unit tests yet.

### H3. HYROX MTL Load Model (Phase 3)

**MTL fitness-fatigue** (`src/calculations/mtl.ts`): `computeWeekMTL(wk)` sums planned `musculoTendonLoad` across `wk.triWorkouts`. `computeMTLFitnessFatigue(weeks, currentWeekIndex)` applies Banister EMA (CTL τ=42d / ATL τ=7d). Returns `{ mtlCTL, mtlATL }` daily-equivalent. `HyroxConfig` stores `mtlCTL?` and `mtlATL?`.

**Launch refresh** (`src/main.ts`): `if (state.eventType === 'hyrox')` block recomputes MTL CTL/ATL on every boot. Stores on state, saves, logs `[hyrox] MTL CTL/ATL refreshed: CTL=X ATL=Y ACWR=Z`.

**MTL ACWR readiness floor** (`src/calculations/readiness.ts`): New `mtlAcwr?: number | null` on `ReadinessInput`. Hard floors: MTL ACWR >1.5 → readiness ≤34, >1.3 → ≤54. New `'mtlLoad'` on `hardFloor`/`DrivingSignal` unions. Transferable to any mode with eccentric data. Home view passes `mtlAcwr` for HYROX users.

**Taper eccentric warning** (`src/ui/hyrox/workout-card.ts`): Within 10 days of race, cards with burpee BBJ / sandbag lunges / wall balls show amber inline note. Informational only — no plan mutation.

**MusculoTendon Load drill-down** (`src/ui/mtl-load-view.ts`): Detail page mirroring leg-fatigue's structure. Hero ring shows this week's actual MTL (derived from matched workouts at render time) vs cap, coloured by ACWR zone. 12-week chronic + acute PMC chart reads `computeMTLFitnessFatigue(weeks, i)` — which iterates **completed** weekly MTL via `computeWeekActualMTL` (only workouts with a `matchedActivityId` contribute, mirroring how running CTL/ATL is fed by actual TSS). Cards: ACWR with zone verdict, discipline split (run / station / brick chronic share via `computeMTLFitnessFatigueByDiscipline`, also actuals-based), this-week contributors list (planned vs completed), explainer card. Two entry points: the MusculoTendon Load factor card on Readiness (`rdn-card-mtl`, click-through wired) and the MTL card on Hyrox Stats (`hx-stats-mtl-card`). All four numbers (actual, planned, chronic, acute) share one source convention.

**Key files**: `src/calculations/mtl.ts`, `src/calculations/readiness.ts`, `src/main.ts` (HYROX block), `src/ui/home-view.ts` (mtlAcwr wiring), `src/ui/hyrox/workout-card.ts` (taper warning), `src/ui/mtl-load-view.ts` (drill-down), `src/ui/readiness-view.ts` (factor card click-through), `src/ui/hyrox/stats-view.ts` (clickable MTL card)

**Test status**: ⚠️ Calculations covered (`mtl-by-discipline.test.ts` — 11 tests: planned and actual weekly MTL, discipline split, EMA fitness-fatigue from actuals, currentWeekIndex limit, fresh-user zero-state). No UI tests for the drill-down or readiness factor card.

### H2. HYROX UI (Phase 2)

**Plan view** (`src/ui/hyrox/plan-view.ts`): Full week-by-week plan layout. Scroll atmosphere background + sun glint (same visual system as triathlon plan). Race countdown pill (top-right). Weekly summary strip: hours / sessions / MTL load. Three discipline mini-bars: Run (green) / Station (amber) / Brick (slate-blue). Week navigation pills (scrollable). Draft banner on future weeks. Benchmark calibration card surfaces on current week. Day-by-day layout using `renderHyroxWorkoutCard` with interactive tap + touch DnD reorder (iOS drag arms after a 350ms long-press so scrolling doesn't reorder days; "Hold and drag to reorder" hint above Monday on the current week). Each card carries a status chip top-right (Logged/Done green, Missed orange, Today terracotta, Adjusted/Skipped/Replaced/Holiday/Added) via the shared `src/ui/workout-status.ts` helper, matching the running plan card. 4-tab navigation (Home / Plan / Forecast / Stats).

**Workout card** (`src/ui/hyrox/workout-card.ts`): Three discipline flavours (run/station/brick) with colour-coded badges. Station/brick cards show `hyroxComponents` list (station name + distance/reps). MTL chip alongside RPE. "Tap for details" CTA (detail modal in Phase 3). Card class `hyrox-workout-card` + `data-hx-workout-id` / `data-hx-day-of-week` for DnD.

**Benchmark calibration card** (`src/ui/hyrox/benchmark-card.ts`): Mirrors tri `benchmark-tests-card.ts`. Shows up to 4 uncalibrated stations on current week. "Enter time" modal with mm:ss input; system doubles half-distance time → `hyroxConfig.stationBenchmarks[station]`. Dismissible via ×. Disappears once all accessible stations are calibrated. Forecast view's "Sharpen this forecast" CTA banner deep-links here and un-dismisses the card so a previously-hidden card resurfaces.

**Forecast-view calibration CTA** (`src/ui/hyrox/forecast-view.ts`): The standalone "Sharpen this forecast" banner was folded into the hero's **Stations** factor chip (count `calibrated/total` + "Test stations" CTA on the chip detail page) when the forecast adopted the marathon-style chip hero. The benchmark calibration card still lives on the plan view; its un-dismiss path is now reached via the Stations chip detail's CTA and the performance radar's "Calibrate" prompt, both of which navigate to the plan view and un-dismiss the card.

**Station benchmark history** (`src/calculations/hyrox-station-history.ts`, state field `hyroxConfig.stationBenchmarkHistory`): Append-only `{dateISO, sec, source, format, proWeights?}` per station. Mirrors `ftpHistory` / `cssHistory` from triathlon mode. Source enum: `'half_test' | 'full_test' | 'race' | 'manual'`. Helpers expose latest entry, age in months, best time per format, PR detection (latest beats all priors), and improvement vs previous entry. Backfilled on launch from existing scalar benchmarks with `'manual'` source and today's date. Drives the per-station table's inline percentile chip, "New PR" badge, and "Tested N mo ago" caption (forecast-view.ts:99-128).

**Per-station detail sub-page** (`src/ui/hyrox/station-detail-view.ts`): Tap any row in the per-station forecast table to drill down. Hero with current adjusted time + percentile, sparkline of historical entries (oldest → newest, faster = top), stats card (best, latest, population estimate, improvement since first test, race-day fade %), full history list with "Best" badge, and "Test again" CTA that un-dismisses the benchmark card and navigates to plan view. Format-aware: only entries matching the current race format render in the chart.

**"Where to gain" card** (`src/calculations/hyrox-weakest-link.ts` + forecast view): Glass card between skills analysis and per-station table. Ranks stations by absolute `gainableSec` (current adjusted time minus projected race-day time from the per-class horizon model). Surfaces top 2 with their current → projected delta. No new constants — reuses `prediction.projection.stations[].improvementPct`. Hidden when no race date or no station has ≥ 1 sec gain.

**Goal-back-calculation modal** (`src/calculations/hyrox-goal-back-calc.ts` + `src/ui/hyrox/goal-modal.ts`): "Set a target finish ›" CTA on the forecast hero. User enters a target time (mm:ss or h:mm:ss), modal back-calculates per-station + run-pace targets needed using headroom-weighted distribution against the `competitive` band's seed floors and `HYROX_RUN_PACE_MIN_SEC_KM × 8`. Iterative allocator with cap-and-redistribute; converges in ≤ 9 iterations. Four feasibility tiers (`already_on_pace`, `achievable`, `stretch`, `unrealistic`) drive the caveat copy. Persists to existing `hyroxConfig.targetFinishTimeSec`.

**Home view** (`src/ui/home-view.ts`): `buildTodayWorkoutHyrox()` reads today's `wk.triWorkouts` by day. `buildHyroxSessionBlock()` renders each Run/Station/Brick/Strength/Cross-train session as its own glass card (shared `buildHeroSessionCard` — `backdrop-filter` + faint ring + light title, same material as the running hero) with a colour-coded discipline badge and an `RPE · MTL` footer; separate cards with clear air between them, the "DAY · Today" eyebrow on the top card only. Race forecast card suppressed in HYROX mode. `getHomePlanName()` returns `'HYROX {Band}'`. Each card keeps the `hx-hero-card` class + `data-hx-hero-workout-id` so taps open the workout detail modal.

**Forecast view** (`src/ui/hyrox/forecast-view.ts`): Full race-time prediction (fully built). **Marathon-style glass hero** — centred "HYROX forecast" title with "{Name}'s {City} HYROX — Week X of Y" sub-line, then a single glass card carrying: predicted finish time (54 px light weight), race-day delta beneath ("On pace vs target" / "+X min vs target" when target set, otherwise "Projected −X min by race day" when projection has ≥60 s gain), "Set a target finish ›" CTA (or "Target · Edit ›" when set), five HYROX-native factor chips (**You** / **Run pace** / **Stations** / **Training** / **Venue**), each tappable to a dedicated sub-page via `renderHyroxChipDetail(key)` (mirrors marathon mode via the parallel `src/ui/hyrox/forecast-chip-detail-view.ts`). Each sub-page leads with the headline number, follows with breakdown (band thresholds + prev race / VDOT + pace source / per-station list with status / phase + sessions bar chart + MTL / per-factor course-factor breakdown), and closes with a science caption. Stations and Venue pages carry their own CTAs (Test stations → plan view; Change format → forecast modal), a "Missing: X, Y. Fewer factors mean lower confidence" caption when any chip is absent, and a previous-race + format-change link under the chips when prior time exists. Confidence badge top-right of the card toggles a detail panel with calibration / staleness / cross-format / VDOT-source / venue-equivalent notes. Legacy "Sharpen this forecast" CTA banner, "Race-day projection" card, and "Course factors" card all removed — their signals fold into the Calibration chip, the hero delta line, and the Venue chip detail respectively. **Race Order card** (singles): bordered-pill segment control with two views, each doing one thing. **Race order** = passive pacing clock: 16 rows in actual race sequence (R1 → SkiErg → R2 → … → R8 → Wall Balls), each row shows the current split plus a cumulative **Total time** that builds top-to-bottom. No projection arrows, no slip delta column, no click-through on station rows (drill-down lives on the other tab). Run rows keep the in-race fatigue bar (green/amber/red by slip %) as a passive visual signal. **Station order** = where you'll gain: all 8 stations grouped first, then all 8 runs grouped, every row (station OR run) shows `now → race day` with race-day gain delta sourced from `HyroxProjectionMarkers.stations[]` (per-station horizon model) for stations and the run-discipline ratio for legs. Unified column meaning across the whole view — no in-race fatigue bar on runs, no +slip delta. No cumulative total (ordering is by discipline). Station rows here remain tappable for the per-station detail sub-page; preserve the PR badge and "Tested N mo ago" caption when stale (≥4 mo). Per-event roxzone+venue overhead distributed uniformly across all 16 events so the Race-order cumulative aligns with the headline projected finish. No percentile chips — comparison would be apples-to-oranges (benchmarks are max-effort fresh, population data is mid-race fatigued). Footer: "X.X sessions/wk for N.N weeks. Gain rates anchored on rowing, LME, and HIFT adaptation literature; **run rows are driven by the running VDOT horizon** (`applyTrainingHorizonAdjustment` at `target_distance: '10k'`, run sessions/wk + bricks at 0.5, taper handled by HYROX factor model, see SCIENCE_LOG §AH). Taper is gradiented (Mujika 2002): gains shrink toward race day." **Doubles format** still uses the legacy split layout (separate Run Legs + Your Stations cards) because the athlete only does 4 of 8 stations. Empty state when no time or benchmarks set. Venue is prescribed from the race event picked in onboarding. **Injury-aware projection** (2026-05-29, SCIENCE_LOG §AQ): an active injury debits each discipline's projection build weeks, stolen verbatim from the triathlon model. Run uses the `run` capacity; each station maps to a body region (`HYROX_STATION_REGION`: SkiErg=upper, Sled Push & Sandbag Lunges=lower, the rest full-body) and is debited by that region's `upperLoad`/`lowerLoad` recovery window (full-body stations take the worse of the two). A blocked region → no projected gain on its stations. Today's "race now" number is unchanged; only the race-day gain shrinks. The hero shows a one-line recovery note (`renderHyroxInjuryNote`, mirroring the tri marquee). When no explicit return-to-sport window was entered, the debit falls back to the injury protocol's typical-recovery midpoint (`injuryWithResumeFallback`, the same band the modal pre-fills), so the forecast responds to any restricted discipline. **Plan propagation**: the HYROX plan is gated only at generation time, so the injury modal save regenerates the current + future weeks (`regenerateHyroxWeek` → `applyHyroxInjuryGates`): blocked run drops runs, blocked upper/lower drops the mixed station circuits (`min(upper,lower)`), reduced scales durations. This also lowers the projection's planned-sessions input, so the forecast responds through both the per-discipline debit and reduced planned volume.

**Home view updates**: `getHomePlanName()` returns `'HYROX {Format} · {Month Year}'` (e.g. "HYROX Open · Jun 2026"). MTL ACWR suppressed when MTL CTL < 1.0 to prevent Week 1 infinite ratio.

**Onboarding additions**: Doubles format note; sessions-per-week slider (3–9); station splits accordion with paste-to-parse from hyrox.com results; band chip replaced with target-finish label; PBs section hidden for HYROX on review screen.

**Key files**: `src/ui/hyrox/plan-view.ts`, `src/ui/hyrox/workout-card.ts`, `src/ui/hyrox/benchmark-card.ts`, `src/ui/hyrox/forecast-view.ts`, `src/ui/home-view.ts`, `src/ui/wizard/steps/hyrox-setup.ts`, `src/calculations/training-horizon.hyrox.ts`, `src/constants/hyrox-horizon-params.ts`, `src/calculations/hyrox-volume.ts`

**Run-pace model v2 — Critical Pace anchor + Bayesian personalisation** (added 2026-05-12, see SCIENCE_LOG §AA): the previous run-pace derivation (`threshold × tier-ratio ≥ 1.05`) was structurally wrong for trained HYROXers — it implicitly assumed every athlete runs slower than threshold, when in fact trained athletes pace 1km HYROX legs at or faster than threshold because stations act as metabolic recovery. The v2 model anchors on **Critical Pace** (Hill 1923; Jones et al. 2010; Galbraith 2014), uses **continuous interpolation by VDOT** (no more discrete band steps), allows ratios < 1.0 for advanced/competitive tiers, and adds **format-specific pace conversion** for singles ↔ doubles (1.05–1.10 factor). Each logged HYROX race feeds a **Bayesian personal offset** that biases future predictions toward the athlete's actual observed pace, decaying linearly to 0 over 12 months without fresh evidence. **Critical Pace card** on Stats view surfaces the full derivation chain (VDOT → threshold → CP → format → personal offset → HYROX pace). Tapping it opens a **drill-down detail page** (not a modal) that leads with **critical pace over time** — a real curve re-derived from VDOT history via the same `gp(vdot, lt).t × cpRatioForVdot(vdot)` formula the card uses, so the latest point equals the headline — then the derivation breakdown, then an explanation of what critical pace is, why it matters, and the scientific rationale. Wiring: `src/calculations/hyrox-run-pace.ts`, `src/calculations/hyrox-personal-pace.ts`, `src/state/initialization.hyrox.ts` (initial offset from onboarding race data), `src/ui/hyrox/stats-view.ts`, `src/ui/hyrox/critical-pace-detail-view.ts`, `buildCpTrendChart` in `src/ui/triathlon/benchmark-charts.ts`.

**Test status**: ⚠️ Run-pace v2 has 28 unit tests in `hyrox-run-pace.test.ts` (cpRatio interpolation, format conversion round-trip, full pipeline w/ offset + decay) and 17 in `hyrox-personal-pace.test.ts` (back-computation, blend math, decay boundary). Trajectory horizon model has 22 unit tests (`training-horizon.hyrox.test.ts`, including two taper-invariant assertions). Forecast UI itself is manual-test only. Other HYROX test files: `hyrox-format-band.test.ts` (8), `hyrox-staleness.test.ts` (10), `hyrox-marker-bumps.test.ts` (14, two updated for v2 numerical ranges), `initialization.hyrox.test.ts` (10), `hyrox-boot-migration.test.ts` (6), `hyrox-injury.test.ts` (10 — station→region mapping, per-region build-week debit, full-body worst-of-two, blocked/reduced capacity, projection integration, no-injury invariance). Full suite: 2419 passing (28 skipped).

### H4. HYROX Activity Matching (Phase 4)

**Station matching** (`src/calculations/activity-matcher.ts`): In HYROX mode, station-type activities (`HIIT`, `STRENGTH_TRAINING`, `CROSS_TRAINING`, `FUNCTIONAL_TRAINING`, `CARDIO`, `AEROBIC_TRAINING`, `INDOOR_CARDIO`) bypass the cross-training path and are matched against planned station/brick `triWorkouts`. Matching criteria: same day of week (±1 day tolerance) and duration within 50–200% of planned. Auto-complete on match: writes `wk.rated`, `wk.garminActuals`, accumulates `hyroxConfig.weeklyMTL` from the matched workout's `musculoTendonLoad`. No match: past weeks → adhoc, current week → review queue.

**HYROX run matching**: Running activities in HYROX mode match against planned run-discipline `triWorkouts` (bypasses the running engine's `regenerateWeekWorkouts`). Match criteria: day (±1) + distance ±25% or duration ±30%. Matched actuals carry `hrEffortScore` and `paceAdherence` identical to running mode.

Both paths write `garminPending` entries so ActivityReview can surface them for re-rating.

**Key files**: `src/calculations/activity-matcher.ts` (lines ~890–1065 — HYROX guard blocks)

**Test status**: ❌ No unit tests (requires Garmin row fixtures — manual test with real sync).

---

## Triathlon Mode (MVP — behind `eventType === 'triathlon'` flag)

Triathlon is a fully-separate mode selected at onboarding. Running users are unaffected. See `docs/TRIATHLON.md` §18 for the canonical decisions backing this implementation.

### T1. Triathlon Onboarding (wizard fork)
**What it does**: New mode tile on the goals step routes triathlon users through a single consolidated `triathlon-setup` screen that collects distance (Sprint / Olympic / T100 / 70.3 / Ironman — all five plannable since 2026-06-15), race date, weekly hours, volume split across swim/bike/run (the default split is now **format-aware** — short course more swim-weighted, long course more bike-weighted), three self-rating sliders (1–5 per discipline), bike FTP + power-meter toggle, and swim CSS (or 400m test time that derives CSS). On completion, initialises `triConfig` and generates the plan. T100 offers the official PTO race calendar; Sprint/Olympic use a manual target-date path. ❌ not device-verified.

A follow-on `tri-past-race` step (inserted between `triathlon-setup` and `review`) asks whether the user completed a triathlon in the past year. If yes, they enter the distance (Sprint / Olympic / T100 / 70.3 / Ironman), month, total time, and optional per-leg splits. A "Scan Strava history" button auto-detects race days (swim+bike+run on same day in `garmin_activities`). Swim leg seeds CSS; run leg seeds VDOT (fatigue discount backed out via the `RUN_FATIGUE_DISCOUNT` table).

A `tri-workout-preview` step (inserted between `tri-past-race` and `review`) showcases the full session library across four sections — swim (4 kinds), bike (9 kinds, same as standalone cycling), run (3 kinds), brick (1 kind) — laid out in a responsive 2-column grid. Cards mirror the running/cycling preview visuals (glass spec, one-liner, example structure, science citation) but are **non-interactive**: per-card opt-out would create infeasible weeks for a multi-discipline plan. Pure confidence-builder before review.

A `tri-plan-forecast` step (inserted **after** `initializing`, before `main-view` — mirroring running's `initializing → plan-preview-v2`, since the plan + prediction must exist first) is the interactive forecast reveal. It shows the live projected finish, **three per-discipline session steppers** (swim / bike / run), and an optional **goal time** slider with a live chance-of-beating Monte Carlo. Each +1 in a discipline adds that discipline's representative session length and regenerates the plan in memory, so the forecast and each row's impact (`+1 ~45 min, M:SS faster`) update immediately; the per-discipline horizon model decides where it helps most (no invented weighting). The generator's 3-session cap bounds each stepper. Continue commits the chosen volume for real (writes onboarding split + hours, re-runs `initializeSimulator`) and pins the goal to `triConfig.targetFinishTimeSec`. This is the triathlon parity of running's onboarding goal-time + add-sessions control. Lever math lives in `src/calculations/tri-session-lever.ts` (pure: `computeBumpedVolume` / `applyTriSessionDelta` / `forecastTriWithDelta` / `goalChanceTriWithDelta`). SCIENCE_LOG §AZ. ⚠️ Not device-verified.
**Key files**: `src/ui/wizard/steps/goals.ts`, `src/ui/wizard/steps/triathlon-setup.ts`, `src/ui/wizard/steps/tri-past-race.ts`, `src/ui/wizard/steps/tri-workout-preview.ts`, `src/ui/wizard/steps/tri-plan-forecast.ts`, `src/calculations/tri-session-lever.ts`, `src/ui/wizard/controller.ts`, `src/state/initialization.triathlon.ts`
**Tests**: — (UI) ⚠️ Manual test only

### T2. Triathlon Plan Engine
**What it does**: Generates a full per-phase plan (base → build → peak → taper) with swim, bike, run, brick, and optional gym sessions for each week. Per-discipline hours derived from `triConfig.timeAvailable × phaseMultiplier × volumeSplit`. Sessions chosen by phase + skill.

The bike library covers nine session kinds: endurance, tempo, sweet-spot, threshold, VO2 long-rep, hills, plus three pro-grade kinds — **over-unders** (alternating 105/95% FTP for lactate clearance, Coggan & Allen 2019), **VO2 micro-intervals** (Billat 30/30s for time-at-VO2max accumulation), and **VLamax neuromuscular sprints** (short max efforts for PCr/glycolytic ceiling). Phase rotation alternates classic kinds with pro-grade kinds across consecutive weeks so a multi-week build exposes the rider to both stimulus shapes.
**Key files**: `src/workouts/plan_engine.triathlon.ts`, `src/workouts/scheduler.triathlon.ts`, `src/workouts/swim.ts`, `src/workouts/bike.ts`, `src/workouts/brick.ts`
**Tests**: `src/workouts/plan_engine.triathlon.test.ts` — ✅ Passing (8 tests); `src/workouts/bike.test.ts` — ✅ Passing (10 tests)

### T2b. Cycling-only mode (V1) — ⚠️ HIDDEN from picker (2026-05-29)
**Status**: The cycling tile is hidden from the onboarding mode picker via `HIDDEN_MODES` in `goals.ts` (parked: single-discipline V1, not a shipping priority, and no run leg so the commute model doesn't apply). All cycling code paths, the tile definition, and the routing branches are intact — re-enable by removing `'cycling'` from `HIDDEN_MODES`. Existing cycling-mode state continues to work. The rest of this section describes the (still-functional) path.

**What it does**: Standalone cycling plan path alongside running and triathlon. Goals screen has a four-tile mode picker; cycling users go through `connect-data → cycling-setup → workout-preview → review → initializing`. Cycling setup collects event distance (50/100/160/200/300 km Gran Fondo class), target date, weekly hours, and strength sessions. Workout-preview renders the 9 bike kinds with literature anchors as a research showcase before plan generation. Plan engine reuses `generateTriathlonPlan` with `triConfig.disciplines = ['bike']`; swim/run/brick generation is gated. Bike session cap lifts from 3 to 5 in single-discipline mode.

**Cycling finish-time prediction**: `predictCyclingEvent` (`src/calculations/race-prediction.cycling.ts`) computes finish time using FTP × distance-keyed intensity factor (IF from Allen & Coggan 2010: 50 km→0.88, 100 km→0.80, 160 km→0.74, 200 km→0.68, 300 km→0.62) and the Martin et al. 1998 bike physics engine. Uses full physics when aero profile + masses are set; falls back to a linear watts→kph approximation otherwise. Confidence range ±10% >4 weeks out, ±6% within 4 weeks. Card shown in Forecast tab via `renderCyclingFinishCard`.

**Cycling plan view**: discipline mini-bars show only the bike bar (full-width) in cycling mode, labelled "Hours this week". Week navigation pills let users preview future weeks without changing the live week. Future weeks show a draft banner and block workout card taps.

**Key files**: `src/ui/wizard/steps/cycling-setup.ts`, `src/ui/wizard/steps/workout-preview.ts`, `src/state/initialization.cycling.ts`, `src/workouts/plan_engine.triathlon.ts` (discipline gate), `src/ui/wizard/controller.ts` (cycling routing branch), `src/calculations/race-prediction.cycling.ts`, `src/ui/triathlon/race-forecast-card.ts` (`renderCyclingFinishCard`)
**Tests**: ⚠️ Manual test only (V1 — first dogfood pass to confirm wizard flow). See `docs/TESTER.md` Profiles A–C.

### T3. Multi-sport Transfer Matrix
**What it does**: Every activity contributes to its own discipline's CTL and ATL at 1.0, and to other disciplines at reduced weights (§18.3). Generalises the old `runSpec` discount to support any sport. Drives per-discipline CTL when a padel / ski / strength session lands on the activity log.
**Key files**: `src/constants/transfer-matrix.ts`, `src/calculations/fitness-model.triathlon.ts`
**Tests**: `src/calculations/fitness-model.triathlon.test.ts` — ✅ Passing (10 tests)

### T4. Per-discipline CTL / ATL / TSB
**What it does**: Independent 42-day CTL + 7-day ATL tracks for swim, bike, run. Combined CTL is a weighted sum (COMBINED_CTL_WEIGHTS). Per-discipline ACWR for discipline-specific overload detection. Same Banister 1975 exponential-decay EMAs as running mode.
**Key files**: `src/calculations/fitness-model.triathlon.ts`
**Tests**: covered in T3 tests ✅

### T5. Swim / Bike TSS
**What it does**: Swim TSS uses cubed IF (water drag ∝ v³; Toussaint & Beek 1992). Bike TSS uses squared IF when power meter present; HR-reserve fallback otherwise.
**Key files**: `src/calculations/triathlon-tss.ts`
**Tests**: `src/calculations/triathlon-tss.test.ts` — ✅ Passing (13 tests)

### T6. Triathlon Race Prediction
**What it does**: Predicts total race time and per-leg splits for all five formats (Sprint / Olympic / T100 / 70.3 / Ironman). Swim uses CSS + 5s/100m race-pace offset (Dekerle 2002). Bike derives speed from FTP × race IF (`RACE_INTENSITY_BY_DISTANCE`, per-format) or skill fallback. Run uses VDOT (Daniels) plus a per-format pace fatigue discount (`RUN_FATIGUE_DISCOUNT` table: sprint 2% / olympic 4% / t100 5% / 70.3 5% / IM 11%; Bentley 2007, Landers 2008, with the three short/middle values extrapolated — SCIENCE_LOG §BU). T1/T2 estimated from skill slider. Confidence band ±8–10%. Sprint and Olympic are now plannable targets in their own right; the predictor still also shows side-effect estimates at other distances. **Per-leg pace caption (added 2026-06-01)**: under each leg time the card shows the implied split — swim pace per 100m, bike speed (km/h or mph) plus the model's target watts (`p.bikeAvgWatts = ftp × RACE_INTENSITY_BY_DISTANCE`), run pace per km/mi. Speed/pace are derived from the *displayed* leg seconds so the caption always agrees with the time above it; watts come from the prediction so the figure isn't recomputed off a duplicated intensity constant. Unit-aware via `state.unitPref`. Single helper `legSplitLine()` lives in `race-forecast-card.ts` and is **shared by both per-leg surfaces**: the Stats marquee/cycling card (`race-forecast-card.ts` `legCell`) and the Forecast-tab marquee (`race-forecast-marquee.ts` `legCard`). When changing the split format, both call sites update from the one helper.

**Leg-breakdown drill-down (added 2026-06-01)**: tapping a Swim / Bike / Run leg on the Forecast-tab marquee opens a waterfall page (`src/ui/triathlon/race-forecast-leg-detail.ts`, `renderTriLegBreakdown(leg)`) that decomposes the projected leg time into ordered stages: base marker (CSS+5s / target watts / VDOT+brick-fatigue) → course factors → heat credit → durability cap → race-day readiness → past-race calibration. Each row shows the cumulative time and the delta the step applied; the last row reconciles to the leg time on the card because both read `prediction.legWaterfall` (built in `race-prediction.triathlon.ts` by `buildLegWaterfall` from intermediate stages emitted by `computeRaceTime`). Steps under 3s are hidden. The course-factors row carries provenance inline (`{Venue} course factors` + `Calibrated, {n} finishers` for empirical venues, or `Physical course model` otherwise) via `prediction.courseMeta`, so a big venue penalty reads as a calibrated number rather than a mystery. Factor rows (open water, course, heat, durability, calibration) deep-link to the matching forecast factor chip; the base row links to Capacity. Below the card, a plain-language course note for that leg (reuses the exported `legCommentary(leg, deltaSec, profile)` from `race-forecast-card.ts`) explains the character in words — e.g. swim "Open lake swim with exposed wind. Chop and sighting slow this leg." It is derived from the venue's physical attributes (swim type, profile, wind, climate, elevation) and the direction of the course delta, and returns '' rather than speculate when the attributes can't credibly explain the gap (no invented reputation claims). Same helper drives swim/bike/run. This is the leg-first cut of the same data the factor chips show factor-first, not a parallel computation. Page chrome mirrors the chip drill-down (`forecast-chip-detail-view.ts`). Reconciliation is unit-tested (`race-prediction.triathlon.test.ts`: last step == leg sec within rounding).

**Race-readiness penalty (added 2026-05-06, bike/swim recency extended 2026-05-07)**: per-discipline endurance-volume penalty applied to the *current* ("if you raced today") prediction. Recognises that fitness markers (FTP/CSS/VDOT) describe physiological capacity but don't account for the specific endurance preparation a long-course race requires. An athlete with strong markers but low recent swim/bike/run volume gets the today-prediction lowered (max 15% for IM, 10% for 70.3, 5% for Olympic, 3% for Sprint) — but the race-day projection is unchanged because by race day the plan has delivered the volume. Run discipline carries forward the existing PB-recency reduction (recent race PB → halved penalty). **Bike/swim extended 2026-05-07**: a recently completed triathlon reduces the bike and swim penalties via cross-distance credit weights (`TRI_DISTANCE_CROSS_CREDIT` in `race-readiness-targets.ts`) — an IM finish fully credits all distances; shorter races give partial credit upward. See SCIENCE_LOG "Triathlon Bike/Swim PB-Recency Cross-Credit 2026-05-07".

**Course-factors panel layout (updated 2026-05-11)**: empirical (calibrated) and physical (Tier-A fallback) course factors render with the same shape — one row per leg. Empirical mode shows a `legCommentary` description derived from the venue's published physical attributes (`swimType`, `bikeProfile`/`runProfile`, elevation, altitude, wind exposure, climate); commentary is honest where physics alone doesn't explain the empirical signal and stays quiet rather than speculate (no claims about field strength). Physical mode aggregates per-dimension entries (Climate, Run elevation, Bike elevation, Swim type, Wind) into a single per-leg delta with the contributing dimensions listed underneath ("Climate · Run elevation"); single-dimension legs show the raw value (e.g. "Climate · Hot-humid (~30°C)"). Negative deltas (faster) render in `var(--c-ok)` green, matching the per-leg breakdown card above. Below the rows: a quiet `N finishes from this venue.` footer (empirical mode only), plus an altitude-acclimatisation warning for venues ≥800 m (we don't track where the athlete trains, so we surface the venue altitude and let them weight it). The calibration caption at the bottom of the parent card distinguishes empirical vs physical-model venues honestly — empirical races cite the 1.3M-finish CoachCox/Kaggle calibration; physical-model races state the dataset doesn't cover that venue. Mode detection lives in a single `isEmpiricalFactors()` helper so the value-format contract is in one place.

**Swim-environment normalisation (added 2026-05-09)**: every swim activity carries a `swimEnvironment` tag (`pool` / `wetsuit-lake` / `non-wetsuit-lake` / `ocean` / `river`). CSS estimation normalises each swim's pace to a wetsuit-lake baseline by dividing by `SWIM_TYPE_MULTIPLIER[env]` before pooling, so pool-trained CSS and OW-trained CSS are pooled honestly into one number. Race-prediction then re-applies the course factor for the actual race environment without double-counting. Pool swims auto-tag from `activityType`; OW swims fall back to `triConfig.swim.defaultOwSwimEnvironment` (set once via the reveal modal). Pool coefficient = 1.00 — pool→OW penalty (~+5–10%) approximately cancels wetsuit benefit (~−5–6%), so a pool swim ≈ a wetsuit-lake swim at race effort. Cited in `triathlon-course-factors.ts:154` block (Toussaint 1989, Cordain 1991, de la Fuente Pacheco 2020, Baldassarre 2017, López-Belmonte 2024). One-time reveal modal (`src/ui/triathlon/swim-normalisation-reveal.ts`) explains the work to users on first visit to the forecast view and captures their OW default in the same dismissal. Tests: 3 new in `tri-benchmarks-from-history.test.ts` (61 total ✅).

**Race-readiness UI surface (added 2026-05-06)**: summary card on the triathlon Forecast page (between retro card and race-day-target card). Three discipline bars (swim/bike/run) with 0-100 readiness scores. Tap-through to detail view with per-discipline breakdown — volume actual vs target, longest session actual vs target, plain-tone coaching line ("Build weekly volume by ~3 hrs/wk to match the race target"), PB-recency note (run: from race PBs; bike/swim: from completed triathlons since 2026-05-07). Cards/bars/colours mirror the daily-readiness pattern in `src/ui/readiness-view.ts:479-512` for visual consistency.

**Key files**: `src/calculations/race-prediction.triathlon.ts`, `src/calculations/specific-endurance-penalty.ts`, `src/calculations/race-readiness.ts`, `src/constants/race-readiness-targets.ts`, `src/ui/triathlon/race-forecast-card.ts`, `src/ui/triathlon/race-readiness-card.ts`, `src/ui/triathlon/race-readiness-detail.ts`
**Tests**: `src/calculations/race-readiness.test.ts` — ✅ Passing (20 tests: per-discipline scoring, penalty bands, geometric mean, PB recency, aggregator); core race-prediction logic ⚠️ not yet covered

**Prediction calibration loop (added 2026-05-11)**: per-user systematic bias correction derived from `triConfig.raceLog`. Three-tier ladder: tier 0 (< 2 races) = no change; tier 1 (2+ races) = per-leg additive bias (median actual − predicted, ±8% cap); tier 2 (4+ races with `predictedRawPerLeg`) = Bayesian-shrunk readiness maxPenalty scale per leg; tier 3 (6+ races spanning 3+ distances) = dormant until sprint/olympic logging is added. Calibration updates after each logged race and backfills on first launch when raceLog exists without calibration. Forecast view shows a faint caption when tier ≥ 1. First tier-up surfaced once in the week-debrief plan-preview step. **Key file**: `src/calculations/tri-calibration.ts` ✅ 14 tests.

**Race-outcome logging across modes (added 2026-05-12)**: parity pass to mirror tri's race outcome logger into running and HYROX (CLAUDE.md mirror rule). Running stores entries on `state.runRaceLog[]` with predicted from `state.blendedRaceTimeSec`; HYROX stores on `hyroxConfig.raceLog[]` using `targetFinishTimeSec` as the "predicted" slot since HYROX has no continuously cached prediction. Both detectors run idempotently after Strava sync via a new `detectRaceOutcomeAfterSync()` dispatcher in `main.ts`. **Key files**: `src/calculations/run-race-outcome.ts`, `src/calculations/hyrox-race-outcome.ts`.

**Race-outcome retro UI (added 2026-05-18)**: small green-tinted "you beat your prediction/target by X" card on the Race Forecast page in running mode (`buildRunRaceOutcomeRetroCard` in `src/ui/race-forecast-view.ts`, above the hero ring) and on the Forecast tab in HYROX mode (`renderHyroxRaceOutcomeRetroCard` in `src/ui/hyrox/forecast-view.ts`, between page title and body). Mirrors tri's `renderRaceOutcomeRetroCard` pattern (`triathlon/forecast-view.ts:42`). Renders only when actual was ≥60s faster than predicted (running) or target (HYROX) — celebratory-only, same gate as tri. **Cycling-only retro** deferred as ISSUE-224 (needs its own `cyclingRaceLog` field). **HYROX station-level retro** deferred as ISSUE-223 (needs `HyroxRaceLogEntry` extension to capture per-station actuals). Running calibration loop (analogue of `tri-calibration.ts`) also still deferred.

### T7. Discipline-aware Activity Matcher + Brick Detection
**What it does**: Matches synced swim / bike / run activities to planned `triWorkouts` — discipline first, then same-day, then nearest duration. Brick detector flags bike → run pairs where the run starts within 30 min of bike end (§18.1). After matching, each workout stores `matchedActivityId` so the effort multiplier can look up objective signals on the matched actual.

**Bike effort scoring (post-match)**: `scoreTriEffort` computes power adherence (NP / (FTP × target IF)) with a per-session-type tolerance band (±5–10%) applied as a continuous soft gradient — maximum 50% attenuation at centre, zero at band edge, no discontinuity. Power adherence stored as `GarminActual.powerAdherence`. HR effort score computed as fallback for rides without a power meter.

**Watt prescription bands**: All bike workout descriptions show a target range (e.g. "135–155W") instead of a point. Band constants in `BIKE_ADHERENCE_BAND` (triathlon-constants.ts): ±10% endurance/vlamax, ±8% tempo/hills/VO2/micros, ±6% sweet spot, ±5% threshold/over-unders. Applies equally to standalone cycling and triathlon bike sessions.
**Key files**: `src/calculations/activity-matcher.triathlon.ts`, `src/calculations/brick-detector.ts`, `src/calculations/tri-effort-scoring.ts`
**Tests**: `src/calculations/tri-effort-scoring.test.ts` — ✅ Passing (14 tests: on-target, band attenuation, edge continuity, outside-band passthrough, null paths, HR fallback)

### T7b. Per-discipline Effort Multiplier (bike / swim / run adaptive scaling)
**What it does**: After each completed week, `triTrailingEffortScore` computes a trailing 2-week effort deviation per discipline. This scales the duration of upcoming sessions of that discipline (±15% cap), mirroring running's `effortMultiplier` in `plan_engine.ts`.

**Bike signal blend**: power adherence (60%) + RPE (40%) when a power meter is present; HR effort score (60%) + RPE (40%) as fallback; pure RPE when neither is available. All signals are converted to the same deviation scale as RPE (0.1 adherence offset ≈ 1 RPE point). This matches running's HR+RPE blend but promotes power as the primary signal since cycling HR lags interval power by 30–60s.

**Swim / run**: pure RPE for swim (no reliable real-time pace signal yet); run reuses the running-side HR+RPE blend from `events.ts`.

**Key files**: `src/calculations/effort-multiplier.triathlon.ts` (`triTrailingEffortScore`, `triEffortMultiplier`, `applyTriEffortMultipliers`)
**Tests**: `src/calculations/brick-detector.test.ts` — ✅ Passing (5 tests). Matcher ⚠️ not yet covered.

### T8. Triathlon UI (Plan / Home / Stats)
**What it does**: Three views with a dedicated minimal tab bar. Plan shows day-by-day cards with discipline-coloured stripes (swim teal, bike clay, run sage), and supports drag-and-drop reorder within the week — drop a card on another card to swap days, drop on the day-header strip to stack onto that day, or drop on an empty rest row to move there. On iOS the drag arms only after a 350ms long-press (`TOUCH_DRAG_HOLD_MS`) so scrolling doesn't reorder days by accident; a tiny "Hold and drag to reorder" hint sits above Monday on the current week. Bricks are atomic single workouts so they always move as one. The weekly summary strip at the top of the Plan view shows Weekly hours / Sessions / Week load with a small muted "X done" caption beneath each headline on the current and past weeks; each KPI now carries a 3px neutral progress bar (`renderKpiBar` in `plan-view.ts`) showing completed ÷ planned at a glance. The swim/bike/run pills underneath act as progress bars (fill = completed minutes ÷ planned minutes, right-side label `Xh / Yh`). **Missed sessions** on the current week (past day, not completed, no matched activity) show an amber "Missed" pill and, when tapped, open a detail modal with two CTAs: "Move to next week" (filled-black) and "Skip session" (transparent bordered). Move clones the workout to next week and marks the original `'skipped'`; Skip drops it with adherence penalty. A clone's `pushCount` carries forward so a lineage can be pushed at most once — after that only Skip is available. Future weeks render planned-only. Each day card now also carries a per-session status chip top-right (Logged/Done green, Missed orange, Today terracotta, Adjusted/Skipped/Replaced/Holiday/Added) via the shared `src/ui/workout-status.ts` helper, so a completed, missed, and upcoming session are distinguishable at a glance — matching the running plan card. Home shows today's workouts as separate glass cards (shared `buildHeroSessionCard` — `backdrop-filter` + faint ring + light title, same material as the running hero) with clear air between them; `buildTriathlonSessionBlock()` renders each swim/bike/run/strength session with its discipline badge and an `RPE · TSS` footer, the "DAY · Today" eyebrow on the top card only. Each card keeps the `tri-hero-card` class + `data-tri-workout-id` so taps open the workout detail modal. Home also shows per-discipline fitness bars with CTL/ATL readout, race forecast, and upcoming sessions. Stats mirrors the running stats summary → drill-down pattern: marquee race forecast card at the top (full per-leg breakdown + course factors + bike & aero entry), then a compact **Fitness summary card** (three rows showing Swim CSS · Bike FTP · Run LT pace with their tier label, tap → Fitness detail), then a **More stats →** link that opens the Progress detail page. Fitness detail (`src/ui/triathlon/fitness-detail-view.ts`) holds the "Your Numbers" zone-position bars for CSS / FTP / LT pace with per-discipline adaptation captions above each bar, three benchmark trend sparklines, and a Current Race Estimates card (Sprint / Olympic / target distance). Progress detail (`src/ui/triathlon/progress-detail-view.ts`) holds the per-discipline stat list (distance, sessions, longest, plan adherence, time, total TSS), Phase Timeline, per-discipline CTL chart, and a unified Weekly load (TSS) chart with Total + Swim/Bike/Run lines. Both charts walk archived `previousPlanWks` so the x-axis aligns. Per-discipline weekly km charts were removed as redundant (TSS already covers load); the Recent weeks drill-down keeps a per-week list of done vs planned hours / sessions / TSS.
**Key files**: `src/ui/triathlon/plan-view.ts`, `src/ui/triathlon/home-view.ts`, `src/ui/triathlon/stats-view.ts`, `src/ui/triathlon/fitness-detail-view.ts`, `src/ui/triathlon/progress-detail-view.ts`, `src/ui/triathlon/benchmark-charts.ts`, `src/ui/triathlon/tab-bar.ts`, `src/ui/triathlon/workout-card.ts`, `src/ui/triathlon/race-forecast-card.ts`, `src/ui/triathlon/colours.ts`, `src/calculations/plan-adherence.triathlon.ts`
**Tests**: — (UI) ⚠️ Manual test only

### T8a. Triathlon forecast fingerprint (chip-based factor view)
**What it does**: Six factor chips beneath the predicted finish time on the triathlon forecast page — parity with running's `forecast-fingerprint`. Chips: **You** (tier + PBs across swim/bike/run + race history), **Capacity** (current CSS · FTP · VDOT; race-day projection lives in drill-down), **Response** (per-discipline adaptation ratios + race-readiness scores + signals feeding the model), **Training** (planned sessions/hours per discipline + per-discipline confidence), **Venue** (course factors aggregated per leg with factor bars and source caption), **Race-day** (transitions, durability vs threshold per discipline, OW swim count). Tap any chip to open a full-page drill-down with per-discipline rows, sparklines for CSS/FTP/VDOT history, factor breakdown bars, and a "missing factors lower confidence" caption when not enough data is present. Per-leg breakdown (swim/bike/run gaps vs today) stays on the main card; projected-fitness-markers and course-factors panels have moved off the main card into their respective drill-downs.
**Key files**: `src/ui/triathlon/race-forecast-fingerprint.ts` (chip builders + wire), `src/ui/triathlon/forecast-chip-detail-view.ts` (6 drill-down pages), wired from `src/ui/triathlon/race-forecast-card.ts` + `src/ui/triathlon/forecast-view.ts`
**Tests**: — (UI) ⚠️ Manual test only

### T9. Benchmark test prompts + confidence-tiered estimators + auto-detection
**What it does**: "Refine your benchmarks" cards pinned to the top of the triathlon plan view surface a CSS test (paired 400m + 200m, Smith-Norris) and an FTP test (20-min Coggan) when the auto-derived value is low-confidence. Cards self-suppress when the user's swim or ride history already supports a `'medium'`-or-better estimate, so users with rich power/swim data aren't nagged. Each card opens a compact result modal that writes the entered times directly into `triConfig.{swim,bike}` with `cssSource/ftpSource = 'user'` and confidence `'high'` so the launch refresh never overwrites a real test result. Stats and account benchmark cells show an inline "estimate · do the test" hint when the persisted CSS/FTP confidence is low/none. Wizard review CSS row hedges its caption based on the same tier.

**Auto-detection**: `looksLikeCssTest` in `tri-benchmarks-from-history.ts` heuristically flags swim activities matching the 400+200m protocol (600–1400m total, pace < 150s/100m, Z4+Z5 > 25% of time when HR is available). Activity detail shows a "Use as CSS test?" prompt when detected. `looksLikeFtpTest` similarly flags powered bike rides; activity detail shows an opt-in pill button ("Use as FTP test") on any ride with `deviceWatts === true` and avg ≥ 80W — defaults OFF to avoid false-positive auto-apply.

**Inline plan refresh**: Saving CSS or FTP from any entry path (benchmark card, activity detail) immediately calls `generateTriathlonPlan` via dynamic import so workout descriptions update without a reload.

**Workout card chips**: Cards show a `No CSS` or `No FTP` chip when the discipline's benchmark is missing, making it clear which targets are estimated.

**Key files**: `src/ui/triathlon/benchmark-tests-card.ts` (test prompts + inline regen), `src/calculations/tri-benchmarks-from-history.ts` (`CssEstimate.confidence`, `FtpEstimate.confidence`, `looksLikeCssTest`, `looksLikeFtpTest`), `src/ui/activity-detail.ts` (CSS/FTP prompts + opt-in pill), `src/ui/triathlon/workout-card.ts` (No CSS/FTP chips), `src/main.ts` (launch-time refresh writes confidence), `src/state/initialization.triathlon.ts` (wizard write-path), `src/ui/account-view.ts` (benchmarks grid), `src/ui/wizard/steps/review.ts` (CSS / FTP captions)
**Tests**: `src/calculations/tri-benchmarks-from-history.test.ts` — ✅ Passing (52 tests including 12 new confidence-tier scenarios)

### T10. Triathlon Progress detail page
**What it does**: Mirrors the running stats Progress detail in tri mode. Opens from a "Progress" card on the tri stats page. Range toggle (4w / 12w / All / Forecast). Charts: per-discipline CTL lines (daily-equivalent ÷7), three separate weekly km charts (swim / bike / run), one weekly TSS chart with three lines (swim/bike/run colours from `colours.ts`), FTP trend, CSS trend. All-time tile shows lifetime swim/bike/run km plus session counts. Forecast tab extends km + TSS using `triWorkouts` from the next 8 weeks (dashed continuation). FTP/CSS history is captured via `appendFtpSample` / `appendCssSample` whenever main.ts auto-derives a new value or a user enters one in onboarding — one entry per day, latest wins, 256-entry cap. Tracking-only data; no calculation reads from these arrays.
**Key files**: `src/ui/triathlon/progress-detail-view.ts`, `src/ui/triathlon/stats-view.ts` (Progress card + wiring), `src/calculations/tri-benchmark-history.ts` (history append helpers), `src/types/triathlon.ts` (`BikeBenchmarks.ftpHistory`, `SwimBenchmarks.cssHistory`), `src/main.ts` and `src/state/initialization.triathlon.ts` (history capture sites)
**Tests**: — (UI) ⚠️ Manual test only

### T11. Not yet built (deferred)
- Discipline-aware sync pipeline (stravaSync/garminSync route swim/bike activities into `state.triConfig.fitness` via `rebuildTriFitnessFromActivities`). The calculation modules are ready; the write-side plumbing is the remaining hook.
- Suggestion-modal cross-discipline ACWR extensions (§18.5).
- Injury engine discipline-shift behaviour (§18.6).
- Express onboarding via Strava (pre-populate CSS/FTP/PBs from history — §18.9).
- Targets editing from the stats page UI (§18.8).
- Guided runs for bike/swim (v2).

---

## Fitness Calculations

---

### 1. VDOT Engine
**What it does**: Converts a race time (e.g. 5K in 22:00) into a single fitness number called VDOT. All training paces are derived from this number. Higher VDOT = fitter runner.

`currentVDOT = s.v + sum(wk.wkGain) + s.rpeAdj + (s.physioAdj || 0)`

`physioAdj` is clamped to `Math.max(-5.0, rawAdj)` at all write sites to prevent stale LT data from making VDOT implausibly low. A `vdotHistory` array (last 20 entries, `{week, vdot, date}`) is appended on every VDOT-changing event (RPE rating, LT auto-update, week advance, manual fitness update, benchmark).

**Key files**: `src/calculations/vdot.ts`, `src/ui/events.ts` (physioAdj + vdotHistory), `src/data/physiologySync.ts` (LT sanity check)
**Tests**: `src/calculations/vdot.test.ts` — ✅ Passing

---

### 2. Pace Generator
**What it does**: Turns a VDOT score into five training pace zones: easy, threshold, interval, marathon, and recovery. Every workout description references these paces.

**Key file**: `src/calculations/paces.ts`
**Tests**: `src/calculations/paces.test.ts` — ✅ Passing

---

### 3. Race Time Predictor
**What it does**: Forecasts your finish time for race day based on current fitness, weeks of training remaining, runner type, and historical data. Shows an "initial baseline" and a "live forecast" that updates as you complete workouts.

The blended prediction (`refreshBlendedFitness`) combines Tanda (2011) marathon regression, VDOT-from-PBs, LT pace, and VO2max into a single weighted race time. Confidence scales with how many recent runs fed the blend. The blended effective VDOT is written back to `s.v` so plan generation and pace derivation always use the live value (except in taper/deload weeks where `s.v` is held — Mujika & Padilla 2000). `getEffectiveVdot(s)` layers RPE and physio adjustments on top.

**Onboarding anchor parity (2026-06-04, §BN)**: `initializeSimulator` applies the same long-run durability cap the refresher applies (blend → cap → VDOT) before seeding `blendedRaceTimeSec` / `initialBaseline` / forecast anchor, and stores `s.runDurability` from day 1 — previously a thin-data onboarding (single typed PB, empty scrape) showed the raw Riegel extrapolation until the first backfill silently slowed it. The weekly-km signal feeding the blend is resolved by `resolveWeeklyKmSignal` (`prediction-inputs.ts`): history-derived when the 8-week window has coverage, falling back to the user's typed manual-entry volume (`detectedWeeklyKm`, which now survives a zero-row Strava aggregation and sets `weeklyVolumeConfirmed` so it also seeds the plan's starting `wkm`). Tests ✅ `initialization.durability.test.ts`, `prediction-inputs.test.ts`, `initialization.volume.test.ts`.

**Single canonical model** (refactored 2026-05-05): "Forecast finish" (end-of-plan projection) and "Current Race Estimate" (today's predicted race time) now share a single anchor. `calculateLiveForecast` and `calculateForecast` accept an optional `blendedAnchorSec`; when supplied, the horizon model's VDOT gain is converted to a seconds delta via Daniels' table on both ends and subtracted from the blend's view of today. Prior to this fix, the headline was bare `tv(currentVdot+gain, dist)` while "Current Race Estimate" was the `blendPredictions` blend — two different models on different scales that could disagree by minutes (a 3:12 marathoner saw a "Slightly behind" pill at Week 1 with zero training done because the bare-VDOT forecast was 3:21). The "Slightly behind / On track" pill on the stats card was killed at the same time — after the fix, `forecastTime ≤ blendedToday ≤ initialBaseline` whenever the horizon predicts any positive gain, so the pill carried no information.

**Course-factor adjustment** (added 2026-05-05): when the user has selected a known race, the predictor layers race-specific factors on top of the raw VDOT prediction — climate (Ely 2007), altitude (Bonetti 2009), and elevation gain (Minetti 2002). The adjusted finish becomes the headline number; the raw fitness pace and per-factor delta are shown beneath. Pre-loaded course profiles cover Berlin, Boston, NYC, Chicago, London, Tokyo, Paris and 18+ other major marathons / 17 halfs (`src/data/marathon-course-profiles.ts`). `s.forecastTimeAdjusted` and `s.forecastCourseFactors` populate alongside `s.forecastTime`.

**Goal time + Monte Carlo chance (running)**: the user sets a race-day target (`s.raceGoalTimeSec`) and the app shows the live **chance of beating it** via `runMarathonForecastSim(s, 2000, goalSec)` → `goalProbability`, with a tone/label ladder (`liveTone`/`liveLabel` in `goal-time-overlay.ts`: Looks light ≥95% / Realistic ≥70% / Honest stretch ≥40% / Ambitious ≥15% / Aggressive). Two entry points: (a) post-onboarding slider overlay on the Race Forecast page (`openRunGoalOverlay`); (b) **onboarding plan-ready screen** (`plan-preview-v2.ts`, added 2026-06-01) — a "Do you have a goal time?" button opens an overlay with a goal slider, an "Add quality sessions" stepper, **and (added 2026-06-02) an "Add strength sessions" stepper** — all re-running the sim live so predicted finish + chance slide together. Strength sessions move the forecast via the running-economy projection (§BC / Training Horizon Model); both steppers feed one combined forecast and the same Monte Carlo chance. Saving reframes the hero to "TARGET TIME · X% chance · On current plan {forecast}". Adding sessions there is real: `bumpSessionsAndGymAndRegen()` raises the onboarding `runsPerWeek` (cap 7) and `gymSessionsPerWeek` (cap 3) and re-runs `initializeSimulator` once for both (the single-lever `bumpSessionsAndRegen()` still serves the auto "MILESTONE NEARBY → Target it" popup).

**Coach contract (all 3 plan modes, added + redesigned 2026-06-15)**: a "here's how your plan works" beat that sits as the last step before entering the app, after the plan exists — running `plan-preview-v2 → coach-contract → workout-preview → main-view`; triathlon `tri-plan-forecast → coach-contract → main-view`; HYROX `initializing → coach-contract → main-view`. (Cycling and just-track skip this step entirely — straight to `main-view`.) Coach voice (a deliberate first-person departure from the consultant default). The CTA calls `nextStep()` so the controller routes per mode; the plan-ready button reads "See how it works", the coach button "See your sessions" (running) / "Start training" (tri/HYROX). Background uses the full page-flair system (ring background + atmosphere + sun glint) to match the other wizard pages.

**Premium redesign (2026-06-15)** — restrained palette, one strong data-derived visual per idea, premium features SHOWN (not listed) via faithful mini-mockups of the real UI:
- **RUNNING** (from `derivePlanShape()`): (1) an **editorial single-accent load arc** — phases as labelled baseline regions + a peak marker, honest TSS currency; (2) a **per-phase aerobic-vs-quality session shift** (Base → Build → Peak → Taper, two colours) carrying the real **runner-type bias** (`applyRunnerTypeBias`); (3) a **cross-training** card showing ALL recurring sports with REAL `computeUniversalLoad` numbers, honest framing + the impromptu-session connection.
- **TRIATHLON** (from the stored `triWorkouts`): a **load ramp stacked by discipline** (swim/bike/run, canonical tri colours, per-week aerobic+anaerobic) + a **"your three engines"** card (FTP / CSS / run threshold; only rows with real data render).
- **HYROX** (same per-week derivation): a **run-vs-stations** stacked load ramp + a **weakest-link** card (`predictHyroxRace` + `topWeakestLinks` + `STATION_DISPLAY`; renders only when a projection exists). Removed the confusing "Compromised running" swap option.
- **Shared "Built to flex around you" showcase** (all modes, mode-aware copy): a **readiness ring** (canonical glass ring + `readinessColorStops`, score 52 = Manage Load easing today's hard session), a **touchable Adjust slider** (real `m-slider-glass`, live-updates distance/time at the athlete's real easy pace via `wireAdjustSlider`), a session **swap**, the weekly **rebalance** (anchored on impromptu cross-training), and the injury **Recovery mode** banner. Rebalance copy says "runs" in running mode, "sessions" in tri/HYROX.

**Personalised from real data** — `commonKnowFragments()` gates shared clauses on real signals (`ctlBaseline ≥ 20`, `hrCalibratedVdot.confidence !== 'none'`, recurring sports, `commuteConfig.enabled`); absent signals fall back to honest generic phrasing. **Shared source**: `src/calculations/plan-shape.ts` (`plannedWeekKm` / `parseDistanceKm` / `derivePlanShape` / `planPhaseSegments`); tri/HYROX discipline load derived inline (`deriveDisciplineLoad`) over `s.wks[].triWorkouts`. **Tests**: `coach-contract.test.ts` (4, jsdom — all three modes render). ⚠️ Not device-verified; live screenshots pending Playwright reconnect; copy not final-reviewed. **Key files**: `src/ui/wizard/steps/coach-contract.ts`, `src/calculations/plan-shape.ts`, `src/ui/wizard/controller.ts`.

**Goal time + add-training (triathlon, added 2026-06-02)**: the triathlon parity of the running onboarding control, on the `tri-plan-forecast` step (see T1). Same chance ladder (`liveTone`/`liveLabel`, now exported from `triathlon/goal-time-overlay.ts`) and the same `triConfig.targetFinishTimeSec` goal field used by the post-onboarding Forecast tab. The "add sessions" lever is **per discipline** (swim / bike / run) rather than a single counter, because triathlon's plan is hours-budget-driven with no integer session count — each +1 adds a discipline's representative session length and regenerates the plan in memory via `forecastTriWithDelta` (clone → `generateTriathlonPlan` → `predictTriathlonRace`), with the goal chance from `runTriForecastSim` on the same clone. Committed for real on Continue. SCIENCE_LOG §AZ.

Three surfaces expose the prediction. (1) **Home race-forecast card** (race mode only): distance label, predicted finish time (course-adjusted when applicable), target time, and signed delta vs target. Tap opens the full-page forecast view. (2) **Race forecast full-page** (`src/ui/race-forecast-view.ts`): hero ring, Started/Now/Forecast stat row, "Where you sit" population card, **forecast fingerprint card** — 5 glass chips in a row (You / Capacity / Response / Training / Venue) showing how each factor cluster feeds the prediction. Training chip uses real `garminActuals` km (4-week trailing average) with `detectedWeeklyKm` as pre-plan fallback — never the runs-per-week lookup. Response chip is gated on ≥ 4 vdotHistory samples and shows "Building signal" below that. **Every chip is tappable and opens a full detail page** (`src/ui/forecast-chip-detail-view.ts`, added 2026-05-19) — tab-style chrome with back button, sky atmosphere, sun glint, and a visual-first body (VDOT sparkline on Capacity, VDOT history chart + adaptation bar on Response, 8-week km bar chart on Training, per-factor bars on Venue, PB list on You). Below the fingerprint: course-factors panel with itemised breakdown (Berlin → "Climate cool: −0s, Elevation +60m: +12s"), line chart of race-time progression with dashed projection. (3) **Plan race-prediction row** shows Initial · Forecast with the signed delta subline. (4) **Stats race-estimate table** repeats the signed delta inline.

**No-target-race forecast (added 2026-06-01)**: when there is no goal event (`continuousMode`, on-demand, or just-track with PBs, or any user whose `s.rd`/`s.initialBaseline` is unset), the Forecast tab no longer bounces back to Home. It now renders a **standard-distance prediction view** (`getStandardForecastHTML` in `race-forecast-view.ts`) — a 2×2 grid of live 5K / 10K / half / marathon finish times from current fitness, plus the **racing-shoes segmented toggle**. Toggling Standard ↔ Supershoes re-renders all four tiles in place (no full reload), each moving by the flat 3% carbon boost. Every tile comes from one canonical helper, `predictStandardDistances` in `blended-fitness.ts`, which runs the *same* pipeline as the targeted blend (calibration bias → long-run durability cap → shoe boost) so a distance shown here equals what the targeted forecast would show if it were the goal. **Shared show/hide gate (2026-06-03)**: the grid shows iff `hasRunningFitnessSignal(s)` (`physiological-vdot.ts`) — the *same* predicate the Stats "VO2 Max" bar gates on, so a thin-data athlete can never see a VO2 bar on Stats but "No predictions yet" here. To honour that wider gate, `buildStandardPredictionContext` now gates on the signal (not on PBs / `trackOnly`), and `predictDistanceStaged` falls back to predicting from the resolved VDOT alone (`predictFromVO2`, the inverse Daniels model) when the weighted blend has no PB/LT/recent/device/HR input — so a track-only athlete with a real VDOT but no PBs now gets predictions. Empty state appears only when there is genuinely no running-fitness signal (`s.v ≤ 0` and no tier) and offers an "Import run history" CTA. Rationale in SCIENCE_LOG §BF.

**Per-distance drill-down (`renderStdDistanceDetail` in `race-forecast-view.ts`)**: tapping a tile opens a detail page with (1) a hero showing the adjusted predicted finish plus its **target pace** (even pace for that time, unit-aware — defined at every distance, unlike a split-by-split plan), (2) a **predicted-time-over-time trend** (`buildPredictedTimeTrendChart`, inverted so faster reads as up) reconstructed from `vdotHistory` via `tv(vdot, distKm)` — the raw fitness trajectory, mirroring how the targeted forecast separates trajectory from the adjusted headline. The headline and delta are **finish-time formatted** (e.g. `18:27`, `−0:12 since first sample` / `No change yet` when flat), not raw seconds — a dedicated time wrapper, parallel to the LT/CSS/CP pace wrappers, replaced the raw-number `buildBenchmarkTrendChart` headline that previously showed `1107.1`. When the user has a plan to project along (`s.rw > 0` + a VDOT), this card instead becomes a **forward projection** ("Projected {dist} time if you hold the plan"), rendered with the **liquid-glass sparkline treatment** (glassy card, vertical gradient fill, layered glow stroke, glowing dot+halo marker on the projected endpoint — same recipe as the marathon population card). A **dashed** curve runs from **Now** to a selectable **4 / 8 / 12-week horizon** (`buildForecastTrajectoryChart`, segmented selector re-renders in place); both endpoints are labelled with their times (Now {hero} → +N wk {projected}) so the direction of change is unambiguous. The projected series comes from `getStandardForecastProjection` — `applyTrainingHorizonAdjustment` (the targeted forecast's VDOT-gain model) sampled per week with `taper_weeks: 0` (no race to taper into) and **plan-prescribed volume** (`getPlanPrescribedMeanWeeklyKm`, the same dose the targeted forecast uses) — with the **gain floored at 0** (holding a plan is at minimum maintenance; never project getting slower). Then **scaled multiplicatively so "Now" equals the adjusted hero** the user already sees (not a raw-VDOT time on a different scale). Headline shows the projected finish + improvement ("19:14 · −9s in 12 weeks"). The dose + floor fix the earlier bug where half/marathon projected getting *slower* with a week-1 cliff (recent-km dose tripped the model's volume-gated undertrain penalty); the curve is now monotonic-improving for every user and distance. The historical-only trend (gated behind ≥3 points / ≥7 days) is the fallback when there is no plan to project along (a just-track user with no sessions). Science in SCIENCE_LOG §BA. (3) a **"How we reach {hero}" waterfall** decomposing the adjusted finish into ordered stages — Capacity (the blend) → Race calibration → Durability → Supershoes → **Predicted finish** — each row showing the running cumulative time and the signed delta it applied (slower = red, faster = green). Steps under 1s are hidden; the final row equals the hero because every stage reads `detail.stages` (`StandardPredictionStages`) from one `predictDistanceStaged` call shared with the grid, so the waterfall reconciles to the headline by construction (CLAUDE.md: two numbers, one source). The **Durability** row is named per distance — `long-run shortfall` for half/marathon, `aerobic durability` for 5K/10K (a short race's deficit is economy, not a missing long run) — and carries a one-line hint: when no run of the threshold duration is on record it says the endurance base is unproven (the no-history case that maxes the penalty), otherwise it names the threshold the longest recent run fell under. (4) a **"What feeds your capacity" card** listing the raw signals behind the Capacity row: Aerobic capacity (VDOT), Lactate threshold pace, Training volume (km/wk), Race calibration status. (5) the **Standard/Supershoes toggle** (same `buildStdShoesCard` as the grid) re-renders the detail in place so hero, pace, and waterfall all move by the 3% boost. Threshold seconds + longest-run seconds are surfaced on `StandardForecastDetail` (`durabilityThresholdSec`, `durabilityLongestRunSec`) so the durability copy is honest rather than implying a measurement that didn't happen. Data assembled by `getStandardForecastDetail(s, dist)` in `blended-fitness.ts`; the grid and the drill-down share `buildStandardPredictionContext` + `predictDistanceStaged`, so hero = grid tile = waterfall total. **History fix**: `refreshBlendedFitness` records a `vdotHistory` point via `recordVdotHistoryPoint(s)` even when no race distance is set, so the trend fills in for just-training users. Tests in `blended-fitness.test.ts` (24: monotonic ordering, 0.97 shoe ratio, track-only-with-VDOT-predicts + no-running-signal null guard, hero=grid, trend reconstruction, no-race history recording, VO2-override flow-through, waterfall-stage reconciliation, supershoes-stage shift, projection point-count + monotonic-improvement + longer-horizon-faster + null gating), plus the canonical-gate helper tests in `physiological-vdot.test.ts` (`resolveRunningVdot` / `hasRunningFitnessSignal`).

**Key files**: `src/calculations/predictions.ts`, `src/calculations/course-factors-running.ts`, `src/data/marathon-course-profiles.ts`, `src/calculations/blended-fitness.ts`, `src/calculations/effective-vdot.ts`, `src/ui/race-forecast-view.ts`, `src/ui/race-forecast-fingerprint.ts`, `src/ui/forecast-chip-detail-view.ts`, `src/ui/marathon-population-card.ts`, `src/ui/home-view.ts` (`buildRaceForecastCard`)
**Tests**: `src/calculations/predictions.test.ts`, `src/calculations/debug-prediction.test.ts`, `src/calculations/forecast-profiles.test.ts` — ✅ Passing (course-factors integration ⚠️ no unit tests yet)

**Empirical population distributions (scaffolding added 2026-05-18, Phase 1 Wave 1)**: per-venue percentile tables for all 24 marathons + 18 halfs in the catalogue, plus per-distance aggregate fallback. Lookup helpers (`getMarathonFinishPercentile`) return `{fasterThanPct, source, provenance}` so the future UI surface (Phase 2) can render a "faster than X% of finishers at this venue" card with honest dataset attribution. Tables currently empty — populated via `node scripts/ingest-marathon-results.mjs <csv> <venue-id>` per Kaggle dataset; `isPopulationDataAvailable()` auto-derives from table contents. **Key files**: `src/data/marathon-population-distributions.ts`, `src/calculations/marathon-population.ts`, `scripts/ingest-marathon-results.mjs`. **Tests**: `src/calculations/marathon-population.test.ts` (17 tests, ✅). **Methodology**: `docs/SCIENCE_LOG.md §AF`.

---

### 4. Training Horizon Model
**What it does**: Limits how fast your VDOT can realistically grow over time — so the app doesn't predict unrealistic improvements. Takes into account starting fitness, weeks available, runner type, **and weekly training volume**. A 10 h/wk runner now sees a meaningfully larger predicted gain than a 3 h/wk runner with the same session count, because raw `sessions_per_week` is converted into `effective_sessions` via a dose multiplier (`actual_km_per_session ÷ ref_km_per_session`, clamped to [0.5, 1.3]). Reference km-per-session per distance comes from Daniels/Pfitzinger intermediate plans (`REF_KM_PER_SESSION` in `src/constants/training-params.ts`). Hours fallback (`HOURS_TO_KM_RATE = 10`) covers users with no run history. Same lever applies in triathlon — the run-leg adjuster passes `weekly_volume_km` to the same function.

**Strength → faster forecast (added 2026-06-02)**: planned strength sessions now contribute a projected running-economy gain to the forecast. Concurrent strength + plyometric work improves running economy (~2-4%) and race performance (~2-5%) over 8-12 weeks (Beattie & Blagrove 2018), so the horizon model adds `3% × (1 − e^(−weeks/10)) × min(sessions/2, 1)` to the projected improvement — a *future-projection* term (the strength in your plan will make you faster across the block), not a retroactive multiplier on current fitness (which would double-count the economy already baked into the current blend). Folded under the same `max_gain_cap_pct` clamp and VDOT-barrier guardrails as the run gain, so it can't push anyone through a time barrier. Gated on planned `gymSessionsPerWeek` (`s.gs`); `0` → no change for non-lifters. Onboarding's plan-preview shows a callout isolating the benefit ("Your N strength sessions are worth about X of the projected finish"). Magnitude (3% ceiling) signed off by Tristan; science in `SCIENCE_LOG.md → §BC`.

**Key files**: `src/calculations/training-horizon.ts`, `src/constants/training-params.ts`, `src/constants/strength-constants.ts`
**Tests**: `src/calculations/training-horizon.test.ts` — ✅ Passing (63 tests, incl. 7 volume-effect + 6 strength-contribution cases)

---

### 5. Fatigue Model
**What it does**: Models accumulated fatigue from training volume. Affects how much fitness gain you get each week — heavy weeks build fitness but also accumulate fatigue that reduces the gain from subsequent weeks.

**Key file**: `src/calculations/fatigue.ts`
**Tests**: `src/calculations/fatigue.test.ts` — ✅ Passing

---

### 6. Physiology Tracker
**What it does**: Tracks your lactate threshold (LT) pace and VO2max over the course of the plan, updating them based on workout feedback. These values feed into more precise pace targets and HR zones.

**Key file**: `src/calculations/physiology-tracker.ts`
**Tests**: `src/calculations/physiology-tracker.test.ts` — ✅ Passing

---

### 6a. Effort-Calibrated VDOT (per-segment HR regression)
**What it does**: Estimates current running VDOT from recent training by fitting a weighted linear regression of pace on %HRR (Swain & Leutholtz 1997 %HRR ≈ %VO2R), then mapping the projected pace at vVO2max to VDOT via Daniels' tables. Per-segment input (per-km from Strava `splits_metric`) means within-run variation — e.g. a tempo finish on a long run — feeds the regression as separate (pace, HR) points spanning the run's HRR range, instead of being averaged into one diluted point per run.

**Key files**: `src/calculations/effort-calibrated-vdot.ts`, `src/calculations/vo2-orchestrator.ts`, edge fn `supabase/functions/sync-strava-activities/index.ts` (per-km HR extraction)
**Tests**: `src/calculations/effort-calibrated-vdot.test.ts` — ✅ Passing (22 tests; 17 run-level + 5 segment-level)
**Science**: `docs/SCIENCE_LOG.md → Effort-Calibrated VDOT (2026-04-24)` + per-segment extension (2026-05-12)

---

### 6b. Lactate Threshold Derivation (own engine, decoupled from Garmin)
**What it does**: When Garmin's watch-side LT reading is missing, stale, or gated, the app derives its own LT pace + LTHR from three blended methods: Daniels T-pace from VDOT (88% vVO2max), Critical Speed from race-distance PBs (LT = 0.93 × CS), and empirical detection from sustained tempo efforts (20+ min runs, 85–92% HRmax band, decoupling <5%). Outlier guards exclude treadmill, hot weather, hilly runs, and unsteady pacing.

**State integration**: `recomputeLT(s)` runs after every physio + activity sync, and (2026-06-04, §BO) at onboarding finalize when the wizard supplied no measured LT — so `s.lt`/`ltSource`/`ltConfidence` are consistent from day 1. Priority chain: `s.ltOverride` > fresh Garmin reading (<60d) > blended derived. When Garmin and our derived value differ by >10s/km, a `s.ltSuggestion` is set so the LT detail page can prompt the user to choose; `s.lt` is not silently overwritten in that case. PBs feed the chain via `effectivePhysiologyPbs` (per-key fastest of `s.pbs` + in-progress wizard `s.onboarding.pbs`), so mid-wizard typed PBs are visible before finalize. The blended estimate is bounded by demonstrated performance: LT pace can never be slower than the average pace of a race PB longer than 60 minutes (clamped, provenance notes "Capped at your race-PB pace", confidence downgraded from high).

**Stats UI**: The LT metric detail page (Stats → LT card) shows the active value with provenance + confidence chip, a per-method breakdown (pace and weight contribution), the Garmin sparkline when present, the conflict-resolution prompt, and slider overrides for pace + LTHR with reset-to-derived.

**Workout pacing**: `s.lt` flows into `paces.gp(vdot, ltPace)` so threshold workouts and pace zones use the resolved value automatically.

**Key files**: `src/calculations/lt-derivation.ts`, `src/data/ltSync.ts`, `src/ui/stats-view.ts → buildLTMetricPage`
**Tests**: `src/calculations/lt-derivation.test.ts` — ✅ Passing (34 tests, incl. race-PB pace cap); finalize consistency in `src/state/initialization.physiology.test.ts`
**Science**: `docs/SCIENCE_LOG.md → Lactate Threshold Derivation` (Daniels, Jones & Vanhatalo, Nixon et al. 2021, Friel)

---

### 7. HR & Efficiency Scoring
**What it does**: When you log a workout with heart rate data, the app cross-checks your RPE (how hard it felt) against your HR to detect whether you're getting fitter, fatigued, or under cardiovascular stress. This nudges your future paces slightly up or down.

**Logic**: Low RPE + Low HR = efficiency signal (paces get a tiny bit faster). Low RPE + High HR = cardiovascular strain (dampens the easy-day signal). High RPE + High HR = struggle (slows future paces). High RPE + Low HR during intervals = central fatigue.

**Key file**: `src/calculations/heart-rate.ts`
**Tests**: `src/calculations/efficiency.test.ts` — ✅ Passing

### 7b. HR Effort + Pace Adherence → Plan Engine (ISSUE-35 Build 1)
**What it does**: Every synced run gets two objective scores: (1) HR effort score — how hard it was relative to the target HR zone (from Strava HR data), and (2) pace adherence — how close actual pace was to target pace from VDOT tables. These blend into the weekly `effortScore` alongside RPE, which the plan engine uses to scale future workout durations.

**Weighting**: Quality sessions (threshold, VO2, marathon pace) weight pace at 35% — missing pace targets on hard workouts is the strongest signal. Easy runs weight pace at only 15%. HR fills the gap between RPE and reality.

**User-facing**: Future weeks in the plan show an adaptive note explaining workouts will adjust, with context ("you missed pace targets on recent quality sessions").

**Key files**: `src/calculations/heart-rate.ts` (`computeHREffortScore`), `src/calculations/activity-matcher.ts` (`computePaceAdherence`, `getHREffort`, `getPaceAdherence`), `src/ui/events.ts` (blended effort score), `src/ui/plan-view.ts` (`buildAdaptiveNote`)
**Tests**: ⚠️ No dedicated tests yet — logic verified via existing 756 tests passing

---

### 7c. Workout Commentary — Coach's Notes (ISSUE-35 Build 3)
**What it does**: Every completed activity gets 2-3 sentences of coaching commentary on its detail screen. Rules-based — picks the most relevant insights from pace adherence, HR effort, HR drift, split patterns (negative split, late fade, evenness), and HR zone distribution.

**HR drift surfaces (added 2026-04-15)**:
- **Activity detail copy** (`workout-insight.ts`): drift >8% on easy/long runs (not quality) triggers a layman's explanation — heat, dehydration, fatigue, or pace too aggressive.
- **Pre-long-run nudge** (`daily-coach.ts → computeLongRunDriftNote`): when today is a long run and recent long runs have drifted, the coach suggests earlier fuelling and pace control. Surfaced under the coach message in Readiness view.
- **Easy-pace commentary** (`daily-coach.ts → detectEasyDriftPattern`): when easy runs over the last 3 weeks drift >5% on average, the week debrief adds a note that easy pace may be too close to aerobic threshold.
- **Aerobic Durability chart** (`stats-view.ts → buildDurabilityChart`): Stats → Progress card showing drift over last 12 weeks (easy/long only) with 4-session rolling mean and threshold bands.
- **Marathon fade-risk badge** (`stats-view.ts → computeMarathonFadeRisk`): Race Estimates card pill on the Marathon row — Low/Moderate/High based on long-run drift at goal MP.
- **Running Stats page** (2026-05-29 rebuild, `stats-view.ts → buildStatsSummary`): mirrors the triathlon stats opening. **Your Numbers card** (`buildRunningNumbersCard`): LT pace + VO2 Max as single-teal zone-position bars, each tapping straight into its metric detail page: **LT** → `buildLTMetricPage` (watch-history sparkline + override sliders); **VO2 Max** → the shared `buildVO2DetailPage` (`triathlon/benchmark-detail-pages.ts`), the same rich page triathlon uses (per-source breakdown, Mosaic/Watch/Manual source toggle, override slider, explainer; mode-agnostic, no `triConfig`). Back returns to the Stats opening. **Progress section** (`buildProgressSection`): a Recent-weeks summary card (last 5 weeks time/sessions/load, taps into the full Progress detail page) plus a running-load (CTL) trend chart. **Mint** page-flair background (was the blue `sky` palette). All zone bars, phase-timeline base/peak, sleep mid-tier, and HRV recoloured off blue/purple onto green/teal. The old Progress / Fitness / Readiness / Summary opening cards were removed — their content lives in the drilldowns. ⚠️ Built + tsc/lint/build clean; not yet device-verified.

**Tone**: Direct, coaching voice. Not robotic, not sycophantic. Praises good execution, flags issues with actionable context ("consider starting more conservatively"), explains how the plan adapts.

**Works for all activity types** — runs get pace/split/drift analysis, cross-training gets HR effort + load commentary.

---

### 7d. Per-rep interval analysis (run + bike) (2026-05-06)
**What it does**: For any structured interval session — `8×400m`, `6×800m`, `5×5min @ FTP`, `30×30s` — each rep is detected, scored against its target, and summarised on the activity-detail page with a one-line execution commentary. The same per-rep adherence drives the running effort blend (`events.ts`) and the bike effort multiplier (`effort-multiplier.triathlon.ts`) so progression next week reflects rep-level execution rather than whole-session averages.

**Two detection paths**:
1. **Strava `/laps`** — primary for run; clusters laps by pace and takes the fast cluster as reps. Uniform 1km/1mile auto-laps are rejected (CoV gate, since bike computers commonly auto-lap regardless of what the rider did).
2. **Stream-based fallback** — when laps are absent or auto-generated. Power stream is the *primary* signal for bike (more reliable than laps); pace stream is the fallback for run.

**Per-rep scoring**: `parseRepPrescription` extracts the rep pattern (`8×400m`, `5×5min`, etc.) from the workout description. Targets resolve via `gp()` for run (interval/threshold pace from VDOT or LT) and `BIKE_TARGET_IF × FTP` for bike. In-band tolerance: ±5% pace for run, per-session-type band for bike. Aggregate: `inBand`, `fadePct` (last-half vs first-half mean), `avgAdherence`. Power fade is sign-flipped so positive always = "got worse over the set".

**UI**: contextual rep block on `activity-detail.ts`, only renders when `repData` is present. Shows source ("Strava laps" / "Auto-detected"), per-rep table (rep#, distance, bar, in-band marker, HR, pace/watts), and a one-line commentary ("8/8 reps in target band, no fade — strong execution.", "First 4 held the band, last 4 faded 6.2%", "5/5 reps under target — undercooked set").

**DB**: new `garmin_activities.rep_data jsonb` column. Detection runs in the standalone edge-function path (one-time per new activity; cached results skip re-fetching).

**Key files**: `src/calculations/rep-detection.ts`, `src/calculations/rep-adherence.ts`, `src/types/state.ts` (`ActivityRep`, `ActivityRepData`), `supabase/functions/sync-strava-activities/index.ts`, `src/ui/activity-detail.ts`.
**Tests**: `rep-detection.test.ts` (12), `rep-adherence.test.ts` (22) — ✅ Passing.

**Key files**: `src/calculations/workout-insight.ts` (`generateWorkoutInsight`), `src/ui/activity-detail.ts` (renders "Coach's Notes" card)
**Tests**: ⚠️ No dedicated tests yet

---

## Training Plan

---

### 7d. On-Demand Mode (internally `trackOnly` / "Just-Track")
**Renamed 2026-06-01**: the user-facing label is now **"On demand"** (tile in `goals.ts`, focus option in `race-target.ts`), framed for athletes who want to train but have no event on the calendar. The internal flag stays `trackOnly` and code/comments still say "Just-Track". It is no longer tracking-only: On-demand users **generate sessions** (run / bike / swim / gym) via the session generator — see §15b. Self-correction note: an earlier read of this work assumed only running could be generated without benchmarks; in fact `generateBikeSession`/`generateSwimSession` take **optional** FTP/CSS and `generateGymWorkouts` needs neither, so all four disciplines work for a no-plan user.

**What it does**: Onboarding path for users with no training plan generated. The user picks the **"On demand"** tile on the mode picker (`goals.ts`), or the **"On demand"** option on the fitness focus picker (4th row, after Endurance / Speed / Balanced). Under the hood they get the same infrastructure as any non-event `continuousMode` user — one rolling week that extends on calendar advance — with plan generation suppressed and prescription UI hidden. Sync (Strava / Garmin / Apple), GPS recording, activity matching, physiology polling, readiness, CTL/ACWR all run unchanged. A prominent **"Generate a session"** card is the primary action on the On-demand home.

Upgrading to a plan later is a one-tap action from Home or Plan: `upgradeFromTrackOnly()` clears the flag, preserves accumulated CTL / synced activities / physiology, and relaunches the wizard at the goals step.

**What's hidden in track-only mode**: today-workout card, Coach/Check-in buttons, race-forecast card, week progress display, Stats Progress card (plan adherence), phase labels everywhere.

**What's kept**: readiness ring (informational), weekly volume card, recent activity feed, Stats Fitness card (CTL/VDOT — derived from actuals).

**Daily load target**: `CTL / 7 × readinessMultiplier` (readiness 80+ → ×1.3, 60–79 → ×1.0, 40–59 → ×0.7, <40 → ×0.3). Today's actual TSS rendered with Gabbett-band colour — green ≤1.3× CTL, amber 1.3–1.5, red >1.5 (Gabbett 2016 injury-risk sweet spot). Suppressed below `ctlBaseline < 20` with a "sync more history" empty state. Full rationale in `docs/SCIENCE_LOG.md → "Just-Track Daily Load Target"`.

**Plan tab**: retrospective log only — current week's activity-by-day detail plus a rolling history list of prior weeks (distance / sessions / TSS per row). No forward planning.

**Week debrief**: auto-triggers on Sunday / Monday as usual, but shows `showTrackOnlyRetrospective` — compact this-vs-last-week deltas on distance, sessions, TSS, CTL, recovery average. No plan-adherence language.

**Wizard flow**: welcome → goals (pick "On demand" tile directly) → connect-data → review → initializing (short-circuits, skips race-target / schedule / physiology / runner-type / plan-preview) → main-view. The "On demand" tile sets `onboarding.trackOnly=true` and `initializeSimulator` takes the trackOnly branch.

**Readiness + strain detail views**: opening the readiness ring or strain breakdown on track-only home renders without the plan-comparison section (`generateWeekWorkouts` gated on `!s.trackOnly`, and `coachingText` / status labels in strain-view adapt for trackOnly). The HRV / sleep / RHR composite still computes; `plannedDayTSS` stays 0.

**Account-view safety**: Change-Runner-Type button hidden for trackOnly. Reset-Plan relabels to "Reset tracking history". "Switch to tracking only" button in Advanced lets plan-mode users opt into track mode without losing CTL/history. "Recurring activities" row in Training section lets users remove sports post-onboarding.

**Plan → track transition**: race-complete banner on home when `selectedMarathon.date < today` offers a one-tap switch. `downgradeToTrackOnly()` in `wizard/controller.ts` is the underlying function (inverse of `upgradeFromTrackOnly`). Both mode flips go through the `initializing` step with a mode-change guard so `initializeSimulator` re-runs cleanly.

**Polish (2026-04-24)**: First-launch orientation line under hero when no data. Sleep-log affordance under readiness ring. "Create a plan" demoted from full-width button to muted link. Daily-target card: "target" → "sustainable" to de-prescribe. Unified empty-state copy: "Connect Strava or record a run" across all cards. Record tab copy branches: "Record a run" instead of "Just Run — we'll fit it into your plan".

**Key files**: `src/state/initialization.ts` (trackOnly branch), `src/ui/welcome-back.ts` (calendar extension), `src/ui/home-view.ts` (`getTrackOnlyHomeHTML`, `buildTrackOnlyDailyTarget`, "Tracking" pill), `src/ui/plan-view.ts` (`getTrackOnlyPlanHTML`), `src/ui/stats-view.ts` (track-only summary branch), `src/ui/readiness-view.ts` + `src/ui/strain-view.ts` (trackOnly guards on `generateWeekWorkouts`), `src/ui/account-view.ts` (button guards), `src/ui/events.ts` (`showResetModal` copy), `src/ui/week-debrief.ts` (`showTrackOnlyRetrospective`), `src/ui/wizard/controller.ts` (`upgradeFromTrackOnly`, trackOnly branches in `nextStep()`).
**State**: `s.trackOnly: boolean`, `s.onboarding.trackOnly: boolean`, `TrainingFocus` includes `'track'`.
**Tests**: Manual — typecheck passes, pre-existing test suite unchanged. End-to-end smoke path documented in `.claude/plans/dazzling-knitting-sun.md` — not yet browser-tested.

---

### 7d. Running Onboarding — Time Budget + Workout Preview

**What it does**: Two additions to the running onboarding wizard, ported from triathlon/cycling learnings:

1. **~~Weekly time budget~~ (removed 2026-06-01)**: The "Total training time per week" card (peak hours/week slider + Mon–Fri/weekend split) was cut from the schedule step. It manufactured a "Scheduled vs Target → fill the gap" homework framing while run lengths were always set by race + ability + phase, not the slider — the card had to apologise for itself ("Run lengths follow your race plan, not the hours slider"). With the live **Adjust** feature (lengthen/shorten any session from the plan), an upfront hours budget is no longer worth the friction. The `weeklyTrainingHours` / `weekdayTrainingHours` fields remain optional on `OnboardingState` and every consumer no-ops when absent (`applyHoursBudget` gated `!= null && > 0`; budget banner returns `''`; training-horizon falls back to neutral). The "Your Week" preview now shows per-session lengths + a single Weekly total, plus an Adjust reveal line: "Run lengths follow your race plan. You can lengthen or shorten any session later from your plan."

2. **Workout preview step** (`workout-preview.ts`): Shown after schedule, before review. Displays the session types in the user's plan — easy, long, threshold, VO2 intervals, fartlek, and marathon pace (half/marathon only) — with one-line descriptions and science citations. Easy is always locked ("Required"). Long is locked for half/marathon targets (foundational); unlockable for 5K/10K. User can tap other cards to opt out. Exclusions stored in `onboarding.runningExcludedWorkouts` and applied at plan generation.

**Plan engine wiring**: `PlanContext` gains `excludedSlots` (filtered from quality priority before allocation) and `weeklyHoursTarget` (post-processes intents via `applyHoursBudget` — scales easy sessions first, then long run; never shortens quality sessions). All plan-display `generateWeekWorkouts` calls pass these from `s.onboarding`. **Two-tier floors** (added 2026-05-05): standard floors (easy 20m / long 40m) used first; soft floors (easy 15m / long 30m) used when standard would overflow; below the soft floor, residual overflow is accepted and surfaced via the plan-view budget banner.

**Plan-view budget banner** (`src/ui/plan-view.ts` `buildBudgetBanner`): when this week's rendered plan exceeds the user's stated weekly hours by > 5 min, a notice card surfaces above the workout list with two CTAs — Accept shorter sessions (records dismissal at current hours value) or Increase to N h/week (auto-bumps the target and clears the dismissal). Banner re-arms whenever `weeklyTrainingHours` changes.

**Flow**: `goals → connect-data → race-target → schedule → workout-preview → review` (running). Cycling unchanged.

**Key files**: `src/ui/wizard/steps/schedule.ts`, `src/ui/wizard/steps/workout-preview.ts`, `src/ui/wizard/controller.ts`, `src/workouts/plan_engine.ts` (`applyHoursBudget`), `src/workouts/intent_to_workout.ts` (populates `estimatedDurationMin`), `src/ui/plan-view.ts` (`buildBudgetBanner`), `src/workouts/generator.ts`, `src/types/onboarding.ts`
**Tests**: ✅ All 1375 passing — 7 new soft-floor tests in `src/workouts/plan_engine.budget.test.ts`

### 7e. Onboarding Review — "Here's what we found" (confirm & edit)

**What it does**: The last wizard step before "Build my plan". Shows recent training volume, measured benchmarks (VO2max, LT pace; FTP/CSS in tri/cycling), athlete profile, and personal bests — every row editable inline so the user corrects anything before the plan generates.

- **Personal bests**: all four running distance rows (5K / 10K / HM / Marathon) always render in running mode, even when nothing synced — empty rows read "-- · Tap to add". Tap any row to type a time. The continue gate requires at least one PB (running-plan init fails otherwise), so the rows must always be present to be satisfiable.
- **VO2max** (editable, added 2026-05-29): tap to enter 20–85 ml/kg/min → `s.vo2Override`. Flows through to LT and paces via `recomputeLT`.
- **Lactate threshold pace** (editable, added 2026-05-29): tap to enter mm:ss → `s.ltOverride` → `recomputeLT`.
- Manual VO2max/LT values auto-yield to a clearly-better derived estimate on the next launch refresh (CLAUDE.md "Manually-set Benchmarks Yield to Improvements"). A "Revert to measured" link on the "Set manually" caption clears the override immediately (added 2026-06-03).
- **Fitness placement** (added 2026-06-03, SCIENCE_LOG §BK + §BL + §BM): each measured number carries a "where you sit" line plus a position scale (`placementScaleBar`, modeled on the Resting HRV tile's `baselineRangeBar`) derived from real reference data via `src/calculations/fitness-placement.ts`. VO2max row → FRIEND registry age/sex percentile with the band's p5/median/p95 as scale anchors ("Higher than 72% of men aged 30-39"; hidden when age or sex unknown). "Field position" row (running mode, any target distance) → current fitness projected to the user's own target distance and placed in the runner population ("Faster than 87% of male runners", 35M race results, sex-specific tables with overall fallback) with the age grade + WMA classification below the bar ("69% of world-record speed for your age, regional class"; bands 90/80/70/60 = world/national/regional/local class, dropping out below 60%). The scale's fast anchor is the WMA open standard (`openStandardSec`), which equals the road WR at these distances. PB rows → same population percentile + age-grade/band footer per filled PB. FTP row (tri + cycling) → Coggan W/kg band with a 2.0-5.6 W/kg scale, only with a real bodyweight. HYROX review → previous finish vs the real per-format field with time scale. LT deliberately carries no placement (restates the VO2 signal). FRIEND/WMA placements hide rather than guess when age or sex is missing; the population percentile falls back to the overall table. **No-signal gate (added 2026-06-15)**: both the Field position row and the VO2max FRIEND placement bar are suppressed when `getPhysiologicalVdot(s).source` is `tanda-fallback` or `none` — i.e. when the VDOT is the bare `s.v` baseline (default 50, or a stale carried value) rather than anything measured. A no-data runner no longer sees "Faster than 81%" / a projected race time / a population percentile; the VO2max value still shows with its "rough estimate, add a PB or sync HR to refine" caption. The rows reappear the moment a real source lands (a PB flips the chain to `pb-median`; device VO2 / HR calibration / observed LT all rank above the fallback).

**Key file**: `src/ui/wizard/steps/review.ts` (`renderTriPbsSection`, `renderVdotRow`, `renderLtRow`, `renderFieldPositionRow`, `placementScaleBar`, `commitEditing`, `refreshContinueGate`); placement helpers in `src/calculations/fitness-placement.ts`, FRIEND norms in `src/data/vo2max-norms.ts`, WMA standards in `src/data/wma-age-grading.ts`, population tables in `src/data/runner-population-distributions.ts`.
**Tests**: `src/calculations/fitness-placement.test.ts` — ✅ Passing. ⚠️ Screen not yet device-verified.

---

### 8. Plan Generator
**What it does**: Builds the full weekly workout schedule — which runs, at what pace, for how long — based on your training phase (base/build/peak/taper), runs per week, race distance, and runner type. Also accepts `weeklyHoursTarget` (scales session durations to fit the user's stated time budget) and `excludedSlots` (removes user-opted-out session types from generation).

**Key files**: `src/workouts/generator.ts`, `src/workouts/plan_engine.ts`
**Tests**: `src/workouts/generator.test.ts` — ✅ Passing

---

### 8.1 Plan Phasing
**What it does**: Assigns Base / Build / Peak / Taper labels to every week of a plan with a single rule that scales coherently from 4-week sharpening blocks up to 50-week double-periodization arcs. Shared across running, triathlon, and HYROX via a `PhaseConfig`-driven engine; each format supplies its own caps and ratios.

- **Very short (4–7w)**: sharpening block (no real base — fitness cannot be built in a month)
- **Single arc (8–32w running; 8–27w tri/hyrox)**: capped phases (running: taper ≤ 3w, peak ≤ 4w, build ≤ 8w; tri: taper ≤ 2w, peak ≤ 5w; hyrox: taper ≤ 2w, peak ≤ 3w). Base absorbs the remainder.
- **Double periodization (≥33w running; ≥28w tri/hyrox)**: cycle 1 (~45%) ends in a **Checkpoint** time-trial week, 2-week inter-cycle taper, cycle 2 (~55%) full Base → Build → Peak → Taper arc into the race. Phase Timeline shows the honest two-arc story.

When the current week is the checkpoint, the Phase Timeline shows a teal caption telling the user to race a parkrun or 10K time trial that Saturday. The result feeds VDOT/CSS/FTP auto-refresh through the existing activity matcher.

Format-specific configs preserve canonical splits at default plan lengths: running marathon 16w → 6/6/2/2; tri 70.3 / 20w → 8/6/4/2; tri Ironman / 24w → 10/7/5/2; HYROX / 18w → 7/6/3/2.

**Triathlon intensity distribution is race-distance-aware (2026-06-15)**: beyond volume, the *kind* of work adapts to the race format via `src/workouts/tri-intensity-profile.ts`. `TRI_QUALITY_SLOTS` sets how many weekly slots per discipline are quality (sprint/olympic intensity-led; Ironman a single quality slot in build/peak, the rest aerobic) and `TRI_QUALITY_FLAVOUR` sets which hard kind (short course = VO2/speed/anaerobic incl. a new `'vo2'` run; Ironman = sub-threshold sweet-spot/tempo/threshold only). Bricks scale by distance (`TRI_BRICK_POLICY`: sprint peak-only → Ironman build+peak with the largest run share). Seiler 80/20-by-time is preserved at every distance. SCIENCE_LOG §BV. ✅ tested (`tri-intensity-by-distance.test.ts`), ❌ not device-verified.

Replaces the legacy running-mode `>16w racePhaseStart` block-cycle prefix and extends double-periodization to tri/hyrox (neither had it before).

Science basis: Bompa & Buzzichelli 2018, Pfitzinger & Douglas 2009, Daniels 2014 (single-arc caps); Issurin 2010, Tønnessen et al. 2014 (double periodization); Mujika & Padilla 2003 (inter-cycle taper). Full derivation in `docs/SCIENCE_LOG.md §Z`.

**Key files**: `src/workouts/phases.ts` (`computePlanPhases`, `PhaseConfig`), `src/constants/triathlon-constants.ts` (`computeTriPlanPhases`), `src/constants/hyrox-constants.ts` (`computeHyroxPlanPhases`), `src/workouts/generator.ts` (`initializeWeeks`), `src/workouts/plan_engine.triathlon.ts`, `src/workouts/plan_engine.hyrox.ts`, `src/state/persistence.ts` (migration), `src/ui/stats-view.ts` (`buildPhaseTimeline` + checkpoint caption)
**Tests**: `src/workouts/phases.test.ts` (12) + `src/constants/tri-hyrox-phases.test.ts` (11) — ✅ Passing

---

### 8a. Running Plan View Shell (visual layout)
**What it does**: The Plan tab for running mode (5k / 10k / half / marathon) renders with the same visual shell as the triathlon Plan: page-flair atmosphere background (`buildScrollAtmosphereBackground('rp', 'blue')` + `buildSunGlint('low')`), big race-name hero (`Tristan's Berlin Marathon Plan` for named races, `Tristan's 5k` / `Tristan's Marathon` distance fallback, `Your …` when no profile name), phase + "Week N of N · date range" subtitle, race countdown pill in the top-right header (when `onboarding.customRaceDate` is in the future), 3-column weekly summary card (Sessions / Distance / Training Load — actual / planned for current+past, planned-only for future), and a horizontal week navigation pill strip (1 … N) below the summary. Whole summary card taps through to Load & Taper. Prev/next arrow buttons in the header are hidden by default and only appear when archived plans exist (or while viewing one), serving as the archive escape hatch.

**Key files**: `src/ui/plan-view.ts` (`getRunnerHeroName`, `getDistanceLabel`, `daysUntilRace`, `buildPlanWeekSummaryCard`, `countDoneSessionsForWeek`, `getPlanHTML`, `wirePlanHandlers`), `src/ui/page-flair.ts` (atmosphere helpers).
**Tests**: ❌ None yet (visual change only)

---

### 8b. Float Workouts
**What it does**: Adds float fartlek and float long run workouts to training plans for half-marathon and marathon distances. Float workouts use moderate-effort "float" recovery (at approximately marathon pace) instead of jogging between hard reps. This trains lactate clearance under sustained load, mimicking race-day metabolic demands.

**Who gets them**: Half-marathon and marathon plans, build and peak phases only, intermediate ability band or above. Endurance-type runners get a 1.15x priority bias (they benefit most from practicing moderate-effort running). Speed-type runners get 0.90x (lower priority). Hybrid athletes qualify at intermediate level.

**Formats**:
- Float fartlek: hard reps at 10K effort with float recovery at MP (e.g. 6x3min @ 10K, 2min float @ MP). Four rotating variants.
- Float long run (Balanced/Endurance marathon only): alternating MP and float segments over 24 to 28km.

**Science**: Moderate-effort recovery trains MCT1/MCT4 lactate transporters (Brooks 2009). Sustained blood lactate at 2 to 3 mmol/L during float segments forces aerobic adaptation under mild acidosis. Marathon specificity: fractional VO2max utilisation correlates with performance (Coyle 2007). Canova's "special block" approach for elite marathon prep.

**Key files**: `src/workouts/plan_engine.ts` (FLOAT_VARIANTS, floatWorkMinutes), `src/workouts/intent_to_workout.ts` (float case), `src/constants/workouts.ts` (library entries + load profile), `src/workouts/rules_engine.ts` (priority/bias/phase)
**Tests**: `src/workouts/generator.test.ts` — ✅ Passing

---

### 9. Workout Descriptions
**What it does**: Formats each workout into a human-readable description. Interval sessions get multi-line format with warm-up, main set, and cool-down. Easy/long runs get a single-line distance + pace. Descriptions drive load calculation and pace display.

**Key file**: `src/workouts/intent_to_workout.ts`
**Tests**: `src/workouts/parser.test.ts` — ✅ Passing

---

### 10. Workout Scheduler
**What it does**: Assigns each workout to a specific day of the week. Long runs go to Sunday, quality sessions (threshold, VO2) go to Tuesday/Thursday, easy runs fill the gaps. Prevents back-to-back hard days. Users can drag and drop to override (on iOS the drag arms after a 350ms long-press so scrolling doesn't reorder days; "Hold and drag to reorder" hint above Monday on the current week).

**Key file**: `src/workouts/scheduler.ts`
**Tests**: `src/workouts/scheduler.test.ts` — ✅ Passing

---

### 11. Workout Load Calculator
**What it does**: Scores each workout with an aerobic and anaerobic load number. These numbers are the "currency" used by the cross-training system to decide how much running a cross-training session can replace.

**Key file**: `src/workouts/load.ts`
**Tests**: `src/workouts/load.test.ts` — ✅ Passing

---

### 12. Workout Parser
**What it does**: Reads a workout description string (e.g. "5×3min @ 3:47/km") and extracts structured data: distance, pace, duration. Used by the load calculator, the cross-training suggester, and the injury system.

**Key file**: `src/workouts/parser.ts`
**Tests**: `src/workouts/parser.test.ts` — ✅ Passing

---

### 13. Run to Work (Commute)
**What it does**: A complete end-to-end commute model. Captured at onboarding (running, triathlon, HYROX, and just-track — cycling is excluded, no run leg) and editable from Account → Run to work. Drives the plan engine, the load model, and a self-tuning baseline. In just-track mode there is no plan, so the captured config only drives the per-activity tag + load-carriage adjustment (both mode-agnostic).

- **Capture**: one-way distance, bidirectional?, days/week, optional backpack kg.
- **Additive planning**: commute runs are appended on top of `runsPerWeek`, not substituted (revised 2026-05-20, see SCIENCE_LOG §AM). A user with 2 runs/week + 3 commutes gets the full prescribed plan (long + easy) plus 3 commute days. Mirrored across running, triathlon run leg, and HYROX easy-run filler.
- **Bidirectional commutes emit two slots/day**: a 3 km × 2 round-trip day shows as `Commute 1 (morning)` and `Commute 1 (evening)`, both 3 km, both on the same weekday. Unidirectional commutes emit one slot per day.
- **Alternating-day spacing**: scheduler prefers Mon/Wed/Fri for 3 commute days (Tue/Thu for 2, Mon/Tue/Thu/Fri for 4). Falls back to nearest free weekday if hard sessions collide.
- **Per-activity tag**: a "Run to work" toggle on the activity-detail page lets users mark a synced run as a commute with a per-activity backpack override. Auto-tags when a synced actual matches a Commute plan slot.
- **Load-carriage adjustment**: commute runs with a backpack apply a linear mass coefficient to musculoskeletal impact load (Signal C). Aerobic load (HR-based iTRIMP) is left alone since HR already captures the metabolic side. Coefficient: `(body + pack) / body`, clamped at 1.5.
- **Drift learning**: a boot-time pass (`main.ts`) counts distinct commute *days* (not trips, so a two-way commuter's morning+evening on one date counts as one day) across the last 4 completed weeks. If ≥3 fell short of the declared days, the baseline auto-reduces to the median observed count and a small toast fires. Only ever reduces; converges. Runs before the forecast refresh so the trimmed count flows into the same-launch prediction.

**Key files**: `src/ui/wizard/steps/commute.ts` (capture), `src/ui/account-view.ts` (Account row), `src/ui/activity-detail.ts` (per-activity tag), `src/workouts/generator.ts` (running, additive model), `src/workouts/plan_engine.triathlon.ts` (triathlon), `src/workouts/plan_engine.hyrox.ts` (HYROX), `src/workouts/scheduler.ts:preferredCommuteDays` (alternating-day spacing), `src/constants/load-carriage.ts` (backpack coefficient), `src/calculations/commute-drift.ts` (drift learning), `src/calculations/activity-matcher.ts:1351` (impact-load application + auto-tag), `src/types/state.ts:64` (CommuteConfig).
**Science**: `docs/SCIENCE_LOG.md §AM` (current additive + bidirectional split model), `§AC` (superseded substitution model), `§AD` (load-carriage, Knapik + Quesada), `§AE` (drift learning rule).
**Tests**: `src/workouts/commute.test.ts` (3) + `src/workouts/generator.test.ts` commute block (7) + `src/constants/load-carriage.test.ts` (9) + `src/calculations/commute-drift.test.ts` (10, incl. bidirectional same-day) = 29 tests. — ✅ Passing. Wizard step + Account row + activity-detail toggle not yet unit-tested.

---

### 14. Gym Integration
**What it does**: Generates running-specific strength sessions alongside your running plan. Templates are phase-aware (heavy lifting in base, explosive in build, maintenance in peak, activation in taper) and adapt to your ability level (beginner/novice/full gym).

**Account "Strength sessions" control (2026-06-03)**: a post-onboarding lever for weekly strength count. The wizard sets `gymSessionsPerWeek` once; this row (Account → "Strength sessions", `renderStrengthRow`/`showStrengthSessionsModal` in `account-view.ts`) lets the user change it later. A centered modal with 0–3 pills; saving writes `onboarding.gymSessionsPerWeek` and rebuilds the plan via `initializeSimulator` (spinner → reload, mirroring the runner-type editor — `initializeSimulator` dispatches by `trainingMode`, so it rebuilds the correct mode's plan and preserves history). Shown for running, triathlon, and cycling (all plan strength off `s.gs`); hidden for track-only (no plan) and HYROX (functional stations are the strength stimulus, `s.gs` is forced to 0). Closes the gap where a user who onboarded at gym=0 (e.g. a 70.3 athlete whose tri-setup slider defaulted to 0) had no way to add planned strength except the on-demand generator or an injury nudge.

**Bodyweight progression for beginners/novices (2026-06-03)**: weaker athletes train bodyweight movements that carry no load, so the weight-autoregulation that progresses lifters had nothing to act on and their templates repeated unchanged every week. A **ladder progression** now coaches them forward: per movement family (squat / lunge / hinge / calf / plank / step-up), an ordered set of rungs runs more reps → harder variant → light load, built only from movements/loads already in the beginner/novice templates. The app remembers the athlete's rung (`s.bodyweightProgress`) and advances it from the same one-tap RIR feedback the guided player collects: advance after 2 consecutive "reps-left" sessions, step DOWN a rung on "barely" (then re-earn it), hold on "about right", base/build only. Capture in `completeStrengthSession`; read-back in `generateGymWorkouts` (rewrites each beginner/novice line to the earned rung, no-op at level 0 so a fresh athlete is unchanged). The loaded top rungs hand off to weight-tracking. Code: `src/calculations/bodyweight-progression.ts`. Science: SCIENCE_LOG §BI. Tests: `bodyweight-progression.test.ts` (10). ⚠️ Not device-verified.

**Exercise swap — "I don't have that equipment" (2026-06-03)**: every gym session lets you swap a prescribed movement for one that trains the same pattern, before you start. In the pre-session detail modal (`strength-workout-detail-modal.ts`) each swappable row carries a muted "Swap exercise" link; tapping it shows same-pattern alternatives (Trap-Bar Deadlift → Deadlift, Front Squat, Back Squat), ordered closest-match-first by muscle-group overlap. Picking one substitutes that movement's own canonical prescription and **remembers the swap as a standing equipment preference** (`s.strengthSwaps`, keyed by the original movement's slug → `{ from, to }`), so every future session prescribing that movement auto-shows the substitute. The swap stays visible and re-editable in the modal ("Swapped from Trap-Bar Deadlift", "Change swap"), and "Keep {original}" reverts it. Because a standing preference applies invisibly from any start path, swaps are also reviewable in one place: **Account → "Exercise swaps"** (`renderExerciseSwapsRow`/`showExerciseSwapsModal` in `account-view.ts`, shown only when ≥1 swap exists) lists every "{substitute} replaces {original}" with a per-row **Revert** and a **Revert all**. No plan rebuild on revert — swaps apply at render time, so the Account view just refreshes (and the row disappears when the last swap is gone). Candidates come from the existing `RUNNING_POOL` functional categories (the generator already treats same-category variants as interchangeable picks) plus a movement-pattern classifier for gym-template movements not in the pool; movements with no functional peer (e.g. Wall Sit) offer no swap. Swaps auto-apply at both the detail modal and `openGuidedStrength` (so a swap is honoured from the running, tri, and HYROX detail modals and the home hero), are a no-op for HYROX (component-parsed) and weight-track correctly under the substitute's own lift key. Known simplification: the substitute lands at standard intensity, so an easier/harder session loses its ±10% load shift on a swapped line.

**Key file**: `src/workouts/gym.ts`; swap: `src/calculations/strength-alternatives.ts`, `src/state/strength-swaps.ts`, `src/ui/strength-workout-detail-modal.ts`, Account manage: `src/ui/account-view.ts`
**Tests**: `src/workouts/gym.test.ts`, `src/calculations/strength-alternatives.test.ts` (13 tests), `src/state/strength-swaps.test.ts` (6 tests) — ✅ Passing

---

### 14b. Strength Weight Tracking (2026-06-01)
**What it does**: Remembers the actual weight you lift on each loaded exercise, between sessions, so the prescription stops saying "@80% 1RM" (a percentage of a max you never set) and starts saying "Last time: 60kg × 8". Four parts:

- **Working-weight memory**. Each loaded lift (squat variants, deadlift/RDL/trap-bar/kettlebell, hip thrust, glute bridge, split squat, step-up, lunge) is keyed to a canonical slug and remembers its last weight, reps, and how the last set felt. Bodyweight, plyometric, and isometric movements (planks, jump squats, nordics) are correctly excluded — no weight prompt where it makes no sense. The "@X% 1RM" garnish is stripped from every display.
- **Easy input**. During a guided session a per-exercise stepper (type a number, ± 2.5kg nudge) pre-fills with the suggested weight; one tap after the last set logs how it felt ("had reps left / about right / barely"). A quick "Mark as done" routes through a skippable confirm-weights screen so non-guided logging still records.
- **Phase-aware ramp**. Strength serves the run/tri plan, so weight only climbs in base/build, and only when a session left ≥2 reps in reserve (RIR autoregulation). Peak holds; taper/deload holds; injury suppresses. Suggested bump is +2.5% of the working weight, rounded to a real plate.
- **Estimated-1RM benchmark + PRs**. Epley estimate per lift, charted over time (reuses the benchmark trend sparkline), with a launch toast and a quiet summary-card note when a lift's estimated 1RM beats its last best. Mirrors the FTP/CSS/VDOT benchmark treatment.

Removed the muscle-group body-map image from the post-session summary (kept the text "Worked" chips).

**Key files**: `src/calculations/strength-exercise-key.ts` (trackability + canonical key), `strength-progression.ts` (Epley + phase-gated `suggestNextWeight`), `strength-marker-bumps.ts` (PR detection), `src/guided/strength-log-persist.ts` (persistence), `src/types/strength-log.ts` (`s.strengthLog`), `src/constants/strength-constants.ts`. UI: `guided-strength-overlay.ts` (capture), `strength-workout-detail-modal.ts` (last/suggested + confirm-weights), `strength-lift-detail.ts` (trend drill-down), `strength-summary-card.ts` (recap).
**Tests**: `strength-progression.test.ts` (81), `strength-marker-bumps.test.ts` (7), `strength-log-persist.test.ts` (5), `strength-model.test.ts` (24) — ✅ Passing. ⚠️ Not device-verified (Tristan to test in-app).
**Science**: `docs/SCIENCE_LOG.md → §AW`.

---

### 14c. On-Demand Gym Session Generator (2026-06-02)
**What it does**: Lets a user generate the gym session they want, on demand, in any mode. "Gym" is now a discipline in the session generator (a tile in running mode; in the discipline picker for tri/on-demand). Flow: **Focus** (Running strength / **Plyometrics** / Lower / Upper / Full body / **HYROX**) → **Goal** (Strength ~4×5, Muscle ~3×10, General ~3×12 — for Upper/Full only) → **rest style** (straight sets / circuit) → preview → Add. The session drops into the current week as a planned activity and flows through the guided experience + weight tracking (§14b). Running-strength and Lower reuse the existing running-supportive templates; Upper and Full are composed from a tagged exercise pool; HYROX reuses `generateHyroxBrick` (a generated brick's card taps straight into the guided HYROX player). Equipment assumed full-gym for v1.

**Plyometrics focus (2026-06-03)**: a standalone explosive session drawn only from the existing plyo pool (`buildPlyometricsWorkout` in `running-pool.ts`). It surfaces what was previously buried — plyo sat last in the running-strength category order, so it only appeared inside a 60+ min session and as a single auto-picked move. The focus skips goal/rest straight to preview (like Running strength), and the existing **Easier / As prescribed / Harder** lever selects a difficulty **tier** instead of a load shift (plyo is bodyweight, so the load step is already a no-op): Easier is low-CNS only (pogos, box jumps, jump squats — never depth jumps or single-leg bounds), Harder leads with the high-CNS moves. **Time is a foot-contact dose** (updated 2026-06-03): a slider over a short window (12–30 min, since plyo is a short stimulus) maps to a total foot-contact target running from a literature floor (60) up to an ability-scaled ceiling (beginner/novice 100, intermediate 120, advanced/competitive 140). Both move count (3/4/5) and per-move sets scale to hit it, so the slider always changes the session; rep counts are fixed, sets (2–6) are the volume dial. No opt-in (a deliberate menu choice), no new exercises. The gym time control is now a slider for all focuses (plyo 12–30/60, others 20–90). **Power + Strength (2026-06-03)**: for intermediate+, the plyo slider extends to 60 min; the jumping dose stays capped at its contact ceiling and time past ~30 min appends strength work from the running-strength categories, placed AFTER the plyo (explosive first, while fresh). The session renames to "Power + Strength". Beginners stay capped at the pure 30-min plyo dose. **Ability**: low-intensity plyo is safe for everyone, so beginners/novices get the focus too but clamped to the Easier tier (unlike Running strength, which is intermediate+ only). **Injury**: suppressed when loaded strength is paused (plyo is higher-impact), falling through to the injury-adapted session. Bodyweight lines carry no load marker → not weight-tracked, but the session still logs and feeds leg-load like any gym session. Race predictions are unchanged: the forecast's strength→economy term (§BC) is already calibrated to plyo-inclusive training, and the head-to-head evidence (2022 *Sports Med – Open*) shows plyo-alone has a weaker economy effect than heavy resistance, so a separate plyo prediction term is not defensible.

**Key files**: `src/workouts/gym-pool.ts` (pool + `composeExerciseLine` + `buildPoolWorkout`), `src/workouts/gym.ts` (`generateGymWorkouts` + optional `focus`/`goal`/`restStyle`), `src/constants/strength-constants.ts` (`GYM_GOAL_SCHEMES`), `src/ui/session-generator.ts` (Focus/Goal/rest screens, gym dispatch, `saveTriAdhoc` non-tri routing).
**Tests**: `gym-pool.test.ts` (13) + `strength-progression.test.ts` upper-body additions (9) — ✅ Passing. ⚠️ Not device-verified.
**Science**: `docs/SCIENCE_LOG.md → §AY`.
**Running strength = a rotating evidence-based pool (2026-06-02)**: "Running strength" is no longer a fixed template — it's a rich, categorised, rotating pool (`src/workouts/running-pool.ts`) across 8 running-S&C categories (max strength, single-leg, posterior/hamstring, calf-soleus-Achilles, foot/tibialis, hip-stability/adductor, reactive plyo/tendon, anti-rotation core). Each session is balanced + varies by week; the time control scales the exercise count (20→4 … 90→9). Every exercise grounded in SCIENCE_LOG §BA. New tracked lift: tibialis-raise. **Onboarding** also nudges users toward ≥1 strength session (schedule step, Beattie & Blagrove 2018). Tests: `running-pool.test.ts` (29, incl. 8 for the standalone Plyometrics focus + 4 for the contrast power-block).

**Contrast power-block (2026-06-03)**: in **build phase**, intermediate+ running-strength gym sessions (both scheduled and on-demand) pair the heavy lead lift with a matched jump — Back/Front Squat → Jump Squat, Trap-Bar/Deadlift → Box Jumps — as a "power block" using post-activation potentiation. The pairing note rides the lead's cue (parser-safe, never a label line); the standalone plyo pick is dropped so there's never two jumps. **Default-on for intermediate+** with an off-switch in Account → "Plyometrics in gym" (`plyoInGymEnabled`). Gated three ways: opt-in × ability (intermediate+) × phase (build). Read at generation (on-demand immediate; plan on regen). Strict PAP rest timing intentionally not modelled. Science: SCIENCE_LOG §BH.

**Deferred**: per-exercise equipment substitution; full superset interleaving; beginner/novice Upper/Full tiers; a richer preview-detail screen for a generated HYROX brick (currently taps straight into the guided player); plan-engine auto-gym using the running pool (Phase 2).

### 14d. Gym Leg Load → Recovery (2026-06-02)
**What it does**: A strength/gym session now feeds the **same leg-fatigue ledger** (`s.recentLegLoads`) that runs and cross-training already feed, so a heavy leg day suppresses readiness the way a long run does — and a leg-heavy session on already-tired legs gets a "consider easing" nudge. Previously the gym was invisible to recovery (a squat day moved readiness by zero).

- **Write side (derive from exercises)**: `legLoadRaw = K_STRENGTH(0.9) × legScore × intensityMult × effortMult`. `legScore` = leg-muscle hard sets from the canonical `deriveWorkedMuscleGroups` (quads + glutes + hamstrings + calves; an upper/core day scores 0 and writes nothing). `intensityMult` from mean %1RM (logged weight ÷ est-1RM, ref 80%); `effortMult` from session RPE (ref 7). Stamped on the activity as `actual.legLoadRaw` at completion, then written into the ledger via the shared `buildStrengthLegLoadEntry` (RBE-discounted, heavy days decay slower). Calibrated so a canonical hard leg day ≈ 16 units, matching the prior `legFeel: 'heavy'` scaffold. Feeds the existing readiness leg-load floors (≥20 Manage Load, ≥60 Ease Back) unchanged. **Tracking only** — not added to CTL/ATL/TSS, so no double-count.
- **Read side (surface + suggest)**: a passive muted caption on the plan gym card (`buildGymLegLoadNudge`) — "Legs are still loaded from {source}. Consider easing today's leg session. Drop a set or back off the weight." — fires when the planned session is a real leg day (est. raw ≥ 7) and the decayed total is already ≥ 20. **Suggest-only, no plan mutation** (user can act via the Adjust overlay).
- **Mode scope**: running (full), triathlon (gym writes the ledger; the leg-load floor applies to the **run discipline only** in `computeTriReadiness` — swim is non-impact, bike tolerates tired legs; nudge on the tri gym card via the shared helper), and HYROX (plain gym sessions feed the same readiness model + floor; stations excluded). HYROX has no gym-card nudge. The leg-load *nudge* is one shared helper (`gymLegLoadNudgeForWorkout`) used by both running and tri plan-views so they can't drift.

**Key files**: `src/calculations/strength-leg-load.ts` (model + `buildStrengthLegLoadEntry` + `buildGymLegLoadNudge` + shared `gymLegLoadNudgeForWorkout`), `src/guided/strength-complete.ts` (stamp + immediate write + `dropSupersededStrengthEntries` dedupe), `src/ui/sport-picker-modal.ts` (`computeLegLoad` strength branch + reconcile), `src/ui/plan-view.ts` + `src/ui/triathlon/{plan-view,workout-card}.ts` (nudge caption), `src/calculations/tri-readiness.ts` (run-discipline leg-load floor), `src/types/state.ts` (`GarminActual.legLoadRaw`).
**Tests**: `strength-leg-load.test.ts` (18, incl. re-completion dedupe) + `tri-readiness.test.ts` (2, run-only floor) — ✅ Passing. ⚠️ Not device-verified.
**Science**: `docs/SCIENCE_LOG.md → §BE`. **Design**: `docs/LEG_LOAD_FLOW_DESIGN.md`.
- **Manual "Legs worked" tag (2026-06-03)**: synced sessions with no exercise detail (e.g. HIIT logged as "General Sport", or a synced strength row) can't be auto-classified, so the activity-detail page shows a None/Moderate/Heavy segmented control for `generic_sport`/`strength` activities. It writes the user's `legFeel` (`state.ts`) and converts duration → leg load at the documented rates (moderate 0.15/min ×1.05 decay, heavy 0.35/min ×1.20). Precedence in `computeLegLoad`: derived `legLoadRaw` (in-app exercises) > manual `legFeel` > sport rate, so an in-app gym session never needs the tag. This is the path for most real gym work, which arrives as ambiguous synced activities. Key: `activity-detail.ts` (control + handler), `strength-leg-load.ts` (`legFeelRawLoad`/`legFeelRecoveryMult`), `sport-picker-modal.ts` (`computeLegLoad` precedence + reconcile decay override).

**Deferred**: explicit per-lift RIR; eccentric-tier weighting for plyometrics; HYROX MTL integration.

---

### 12b. Running Plan Adherence
**What it does**: Tracks what percentage of planned runs have been completed across all completed weeks. A run counts as completed if a matched Strava activity covers ≥95% of the target distance (post-reduction if the run was reduced). Cross-training and ad-hoc runs are excluded. Current in-progress week is excluded entirely so the number doesn't drop every Monday. Pushed workouts are excluded from their source week and scored in the week they land in.

**Key file**: `src/calculations/plan-adherence.ts` (`computePlanAdherence`), `src/ui/home-view.ts` (`buildAdherenceRow`)
**Tests**: `src/calculations/plan-adherence.test.ts` — ✅ 7 passing

---

### 14e. Strength Progress / Celebration Surface (2026-06-03)

**What it does**: Makes strength work visible. A "Strength" marquee card on the Stats opening screen (running **and** triathlon), positioned **between the Your Numbers benchmark card and the Progress section** (strength reads as another benchmark, next to CSS/FTP/LT/VO2max), drills into a full strength-progress page with four sections: **New bests this block** (est-1RM PRs since plan start, "78 → 82.5kg"), **Strength is making you faster** (the forecast economy contribution §BC — "your N strength sessions are worth about X off your projected {distance}", computed by diffing the live forecast with strength 0 vs `s.gs`; **running-only**, hidden in tri/cycling/HYROX where the projected finish isn't a running race), **Lifts** (per-lift est-1RM + trending-up/holding + total gain, tap → the lift-detail trend chart), and **Consistency** (sessions logged, week streak, total tonnage moved). All derived from `s.strengthLog` (per-lift est-1RM + PB-staircase history) and completed gym `garminActuals` (`loggedLifts`, now carrying a `sets` count for tonnage) — no new state. Amber (`#F59E0B`) is the single accent; the card hides when there's no strength data; the page has an inviting empty state. The drill-down is shared (`openStrengthProgressDetail(s, { back, navigateTab, tabBar })`) so the back button returns to the opener's stats view; HYROX is the same one-line wiring (fast-follow).

**Manual 1RM entry (2026-06-03)**: an "Add a lift" / "Add or update a lift" action on the drill-down (`openManualLiftModal`) lets the athlete tell the app what they lift, for users whose gym work syncs in as ambiguous activities (HIIT / generic strength) that count toward Consistency but carry no per-lift weight data. The centered modal: pick a lift (curated headline list — squat/deadlift/bench/OHP/row/etc., every key real in `strength-exercise-key.ts`, plus any already-tracked lift), choose **Weight & reps** or **1RM**, see a live Epley-derived 1RM preview, Save. Writes via `seedManualLift` (`strength-log-persist.ts`): seeds `est1rmKg`/`est1rmReps`/`lastWeightKg`/`lastReps`, marks `est1rmSource: 'user'` (the field is now `'user' | 'derived'`, mirroring FTP/CSS/VDOT), appends a baseline history point. A manual entry is authoritative (overwrites in either direction) but a later logged set supersedes it via the `est1rmReps` comparability gate, flipping provenance back to `'derived'` on a real PR. A direct 1RM is stored as-is (not Epley'd — `estimate1RM(w,1)` inflates ~3%); only weight × reps gets the estimate. This also de-fragiles the loaded-workout prescription: a seeded 1RM lets future workouts target a real load instead of "@X% 1RM". A single seed fills the Lifts section but is not a "PR" (New bests still needs a logged advance).

**Key files**: `src/ui/strength-progress-view.ts` (card + body builders + derivations + shared drill-down render + manual-entry modal), `src/ui/stats-view.ts` + `src/ui/triathlon/stats-view.ts` (card placement + tap wiring), `src/guided/strength-log-persist.ts` (`summariseLoggedLifts` stamps `sets`; `seedManualLift` writes a manual 1RM)
**Tests**: `src/ui/strength-progress-view.test.ts` — ✅ 7 passing; `src/guided/strength-log-persist.test.ts` — ✅ 17 passing (5 `seedManualLift` cases). **Status: ⚠️ not device-verified.**

---

## Injury & Recovery

---

### 15. Injury System
**What it does**: A six-phase clinical recovery system. When you report an injury, the plan shifts to: Acute (complete rest) → Rehab (cross-training only) → Capacity Test (assess readiness) → Return to Run (graduated running) → Graduated Return (2-week bridge) → Resolved (back to full plan). Pain levels you report drive phase transitions — high pain regresses you back.

**Mode-aware capture (2026-05-26)**: The "Report injury" modal asks discipline-gate questions based on the active event mode:
- **Running** → "Can you run?" only (existing behaviour)
- **Triathlon** → "Can you run?" + "Can you bike?" + "Can you swim?"
- **HYROX** → "Can you run?" + "Upper-body load?" (wall ball / sandbag / carries / burpees) + "Lower-body load?" (sled / lunges)
- **Cycling-only** → "Can you bike?"
Each gate is tri-state (Yes / With pain / No). The body-part picker now includes upper-body locations (shoulder, upper arm, elbow, forearm, wrist, neck, chest/ribs). Defaults for every gate are computed from the selected body part (heuristic table in `src/ui/injury/modal.ts:LOCATION_GATE_DEFAULTS`) so a shoulder injury pre-selects `canSwim='no'` and `canBike='limited'` without forcing the user to opt-out of every discipline manually. The "Preferred rehab activity" dropdown hides any discipline the user just said `no` to.

**Continuous capacity sliders (2026-05-27, supersedes the tri-state gates above)**: each discipline now captures a 0–100 capacity instead of three buckets, so "light swimming OK" and "no swimming" are distinct rather than both reading as `limited`. `InjuryState` carries optional `runCapacity` / `bikeCapacity` / `swimCapacity` / `upperLoadCapacity` / `lowerLoadCapacity` numbers; the modal renders a slider per relevant discipline with a plain-language caption (`Cannot run` / `Very limited` / `Reduced` / `Slightly reduced` / `Full`, `src/ui/injury/modal.ts:capacityCaption`). `LOCATION_CAPACITY_DEFAULTS` (`src/injury/engine.ts`, the canonical physio map shared with the plan engines) seeds values per body part. `getDisciplineCapacity(injuryState, key)` (`src/injury/engine.ts`) is the single read path and maps the legacy enum gates (`no→0`, `limited→50`, `yes→100`) so older state still works. Plan downmix is continuous (`duration × cap/100`).

**Plan adaptation per capacity**: Triathlon and HYROX plan engines read `getDisciplineCapacity` per discipline (`plan_engine.triathlon.ts:424`, `plan_engine.hyrox.ts:406`):
- Triathlon (`src/workouts/plan_engine.triathlon.ts:applyTriInjuryGates`) — `no` drops the discipline entirely; `limited` collapses it to one easy/recovery session that preserves the modality; brick is dropped whenever either leg is gated.
- HYROX (`src/workouts/plan_engine.hyrox.ts:applyHyroxInjuryGates`) — classifies workouts by `t` prefix; `canRun` gates runs and commute runs, `canUpperLoad`/`canLowerLoad` gate stations (coarse since stations are mixed — per-component station gating is future work), `canRun` + upper + lower together gate bricks. Generator versions bumped (`TRI_GENERATOR_VERSION = 12`, `HYROX_GENERATOR_VERSION = 10`) so existing plans regenerate on launch.

**Region-aware strength during injury (2026-05-27, ISSUE-249)**: the strength session now adapts to the *injured body part*, not just whichever capacity slider the mode happens to show. Shared decision in `src/workouts/injury-strength.ts:injuryStrengthDecision`, driven by `bodyRegionLoadability` over the canonical location map:
- **Leg injury** (knee / hamstring / hip / foot / calf) → upper-body + core strength; lower-body loading paused.
- **Upper-body injury** (shoulder / arm / wrist / elbow) → lower-body + core strength; upper-body loading paused.
- **Trunk injury** (back / neck / chest-ribs) → core anti-rotation/plank work dropped (contraindicated); a both-regions-blocked location (back) pauses loaded strength entirely.
- **Relative rest is region-specific**: every active phase (including acute) loads the unaffected region — only the injured region is withheld. The acute phase is kept lightest (RPE 3); a shoulder injury keeps legs training from day one (PEACE & LOVE, Dubois & Esculier 2020). Loads stay submaximal (RPE ≤ 5) and pain-gated, normalising once resolved.
- **Exercise-level tailoring**: each exercise is tagged with the body areas it loads, and any exercise touching the injured area is excluded (`LOCATION_AVOID`). A shoulder injury keeps shoulder-free leg work (bodyweight squat, lunge, step-up) and shoulder-free core (dead bug, hollow hold), and drops planks, side planks, pallof press, goblet squats and glute bridges. A wrist injury drops loaded grip and weight-bearing-hand moves.
- **Card UX (all modes, 2026-05-29)**: strength cards show the session name + "N exercises · tap to view"; the per-exercise breakdown renders as clean rows (name + sets/reps, then cue/rest) in a shared tap modal (`src/ui/strength-workout-detail-modal.ts`, rows from `parseStrengthSession`, modelled on the HYROX detail modal). Running (`plan-view.ts`) and triathlon (`triathlon/workout-card.ts` + `triathlon/workout-detail-modal.ts`) both route to it; HYROX keeps its station-specific modal. Replaces the run-on description paragraph that previously rendered inline.
This fixes a bug where an injured **triathlete** still saw the full 45-min full-body session in the plan and the coach (it was gated only on `upperLoadCapacity <= 0`, a slider the tri modal never shows). **Running** uses the same shared builder (replacing the old "drop everything in acute/rehab" rule), and ~27 `generateWeekWorkouts` display call sites now pass `s.injuryState` so the plan view and AI coach match the load engine. Science in `SCIENCE_LOG.md → §AN`. Tests: `injury-strength.test.ts`, `gym.test.ts`. **Status: ⚠️ not device-verified.**

**"What you can still do" cross-training offers (HYROX + triathlon, hardened 2026-06-02)**: alongside the strength nudge, an injury that frees up aerobic time surfaces an aerobic substitute the athlete *can* still do (`buildCapabilityOffers` / `buildAerobicOffer`, `src/calculations/capability-substitution.ts`). Suggestion-only; nothing is added until accepted.
- **Substitute pick** (`pickAerobicSubstitute`, `src/injury/engine.ts`): bike → row erg → swim, gated by the capacity vector (only a discipline with capacity > 0 is offered). A set "preferred cross-training" sport is a **hard allow-list** — if the athlete named one sport and the injury blocks it, nothing aerobic is offered rather than substituting a sport they may not have access to.
- **Duration is 1:1** with the aerobic time the injury freed up this week (computed from the real generator with the injury cleared, so the number is sourced, not invented).
- **Intensity scales with capacity, duration does not**: a limited (e.g. 50%) discipline keeps the full minutes but is prescribed at proportionally lower RPE (`max(1, round(baseRPE × cap/100))`), with "kept very easy" copy. The aerobic-maintenance dose is preserved while load on the compromised area is reduced. Science: `SCIENCE_LOG.md → §BB`.
- Running routes its aerobic substitute through the phase rehab path instead (`generateRehabPhaseWorkouts`), sharing the same `pickAerobicSubstitute`, so the "you can still pedal" pick is identical across modes. Tests: `capability-substitution.test.ts` (24). **Status: ⚠️ not device-verified.**

**Per-discipline recovery windows + injury-aware projection (2026-05-27, ISSUE-247)**: each restricted discipline (capacity < 100) captures a "Back to full in N weeks" estimate in the injury modal, seeded from the protocol's `typicalRecoveryWeeks` midpoint (real clinical ranges) and adjustable per sport. Stored on `InjuryState.resumeWeeksByDiscipline`. This fixes a bug where an injured 70.3 forecast showed only ~6 min of improvement: the plan engine had zeroed swim/run for the *entire* macrocycle and the predictor extrapolated that, modelling a 2-week injury as a 15-week one. Now:
- **Plan** (`applyTriInjuryGates`): a discipline returns to full once the generated week reaches its resume week. Legacy injuries with no captured window keep the conservative freeze.
- **Forecast** (`predictTriathlonRace`): each discipline loses only its own recovery weeks of build time; the projected dose is sampled from after recovery. Bike (unrestricted) is unaffected. A caption on the forecast card explains the result ("Injury factored in. Swim and run resume in 2 weeks…"). Science in `SCIENCE_LOG.md → §AM`. **Status: ⚠️ not device-verified.**

**Capture rebuilt + running ramp + gym nudge (2026-05-29)**: a post-crash restore (`4b57684`) had reverted the modal to a single tri-state "Can you run?" pill, leaving the capacity sliders and resume-week capture above with no writer (state, plan engines, and tri predictor all still read them). Restored and extended:
- **Capture** (`src/ui/injury/modal.ts`): mode-aware per-discipline capacity sliders (running = run; triathlon = run/bike/swim; HYROX = run/upper-load/lower-load) via `disciplinesForMode`, each with a live caption (`capCaptionText`/`capValueLabel`) and a "Back to [discipline] in N weeks" field (seeded from `typicalRecoveryWeeks` midpoint; persisted only while capacity < 100). Save writes `*Capacity` + `resumeWeeksByDiscipline`; `canRun` is derived from the run slider so the return-to-run protocol and VDOT-freeze gate keep working.
- **Running forecast ramp** (`src/calculations/injury-recovery.ts`): running mode now mirrors the tri predictor. `injuryAdjustedBuildWeeks` debits the run recovery window (`resumeWeeks × (1 − capacity/100)`) from the forecast horizon at both forecast sites (`blended-fitness.ts`, `renderer.ts`), so the projection builds from the return date instead of crediting build during the injured weeks. The VDOT-freeze gate reads run capacity (not the raw `canRun` enum). Shared helper = one source for both modes (parity). Science in `SCIENCE_LOG.md → §AM`.
- **Gym compensation nudge**: after an injury update where a discipline is limited, the app offers one region-safe strength session (`injuryStrengthDecision`) as an accept/decline suggestion; accepted sessions go to `wk.adhocWorkouts`, dismissed do nothing, once per week (`Week.strengthNudgeSeen`). No invented load numbers. Tests: `src/calculations/injury-recovery.test.ts`. **Status: ⚠️ not device-verified.**

**Per-discipline return ramps (2026-05-26, Session 2)**: when a previously-blocked discipline (`canSwim`/`canBike`/`canRun`/`canUpperLoad`/`canLowerLoad`) transitions from `no` or `limited` to `yes`, the plan engine applies a 2-week downmix to that discipline before resuming full volume:
- Hard sessions (intervals / threshold / vo2 / sweet-spot etc.) become easy with RPE capped at 4; TSS load fields (aerobic / anaerobic) stripped so weekly TSS and ACWR math respect the ramp.
- Bricks are dropped while any constituent discipline is ramping.
- Sport-prefix preserved on downmixed types (`bike_threshold` → `bike_endurance`) so matcher / UI continue to classify the sport correctly.
- HYROX coarse: any `canUpperLoad` or `canLowerLoad` transition triggers a single `stations` ramp that suppresses `hyrox_station_density` → `hyrox_station_technique`.
- Week-aware: `weeksFromCurrent` parameter on `applyTriInjuryGates` / `applyHyroxInjuryGates` checks the ramp window per future week. A 2-week ramp at week 5 affects weeks 5–6 only.
- Counter decrements on every week-advance (in `welcome-back.ts:advanceWeekToToday` and `events.ts:next()`); cleared on `markAsRecovered`, fresh-injury reset, and mode switch via `clearStaleGatesForMode`.
- Banner surfaces "Returning: bike (2w left)"; LLM coach payload includes `returnRampWeeksLeft` so the agent can suggest discipline-appropriate effort caps.

**Injury surfacing on Home + Readiness (2026-05-28, supersedes the earlier note/chip)**: the standalone injury chip/banner is removed from both Home and Readiness. Injury context is now folded into the readiness caption itself via `buildInjuryCaption(s)` (`src/ui/injury/modal.ts`, exported), which returns a one-sentence summary like "Running and swimming blocked by injury. Cycling capped at 40%." prepended to whatever readiness sentence the surface would have shown. Same caption on both surfaces, so the user reads the dominant constraint before any systemic commentary (HRV, sleep, load). Mode-aware via the shared `DisciplineKey` lookup (HYROX run/upper-body work/lower-body work, tri/running run/bike/swim). The full management banner (phase, pain, Update/Recovered buttons) still lives only on the Plan tab.

**Discipline Readiness flags blocked state (2026-05-28)**: the tri-mode Discipline Readiness card's `makeBar` (`src/ui/readiness-view.ts:535`) now takes a capacity argument. Blocked disciplines (cap=0) hide the numeric score, render "Blocked" in `var(--c-warn)`, and fill the bar full-width at 45% opacity — a hard-stop signal rather than a recovery state. Reduced disciplines (0<cap<100) keep their score + readiness label but append "· capped X%" so the constraint is visible inline. Fixes the case where Run showed "52 Manage" alongside an injury that blocked running.

**Key files**: `src/injury/engine.ts` (`getDisciplineCapacity`, `LOCATION_CAPACITY_DEFAULTS`), `src/ui/injury/modal.ts` (`disciplinesForMode`, `capCaptionText`/`capValueLabel`, `maybeShowStrengthNudge`, `buildInjuryCaption`), `src/calculations/injury-recovery.ts` (shared run/tri recovery-debit math), `src/types/injury.ts` (added `runCapacity`/`bikeCapacity`/`swimCapacity`/`upperLoadCapacity`/`lowerLoadCapacity`/`canBike`/`canSwim`/`canUpperLoad`/`canLowerLoad`/`returnRampWeeksLeft` optional fields), `src/constants/injury-protocols.ts` (`getActivityGateLevel`/`isActivityAllowedForUser`)
**Tests**: `src/injury/engine.test.ts` — ✅ Passing

**Plan tab UI** (in `src/ui/plan-view.ts`):
- Injury header button: circular icon (healthy) or amber "In Recovery" pill (injured) top-right of header
- Full injury banner: gradient accent bar, phase label, pain level (colour-coded), can-run badge, medical disclaimer for return phases, Update / I'm Recovered buttons
- Morning pain check-in: shown once per day; Worse/Same/Better grid with animated in-place feedback
- Capacity test cards: "Had Pain" (red) / "Pain-Free!" (green) grid replaces normal rate/skip buttons on injury test workouts

---

### 15b. Illness Mode (v2 — schedule-driven, 2026-05-13)
**What it does**: When the user opens the Ill modal from the check-in overlay, the modal captures the symptom picture: **symptom location** (above the neck / below the neck / fever or body aches) and a **severity** (mild / moderate / severe). These map to the `classifyIllness()` inputs (illnessType + symptoms + severity 1–10), which derives a four-axis Classification (neckRule above/below, severityTier mild/moderate/severe, hasSystemic, rhrFlag normal/elevated/high) per the Friman/Schwellnus above-below neck rule. `buildSchedule()` then produces a forward-looking schedule of day-by-day plan modifications. (Day-of-symptoms defaults to "just started"; the RHR-delta refinement is deferred — no daily resting-HR history is wired to the modal yet, so `rhrFlag` stays normal. Neither affects below-neck strength suppression.)
- **Below-neck**: full rest for the acute window (7 days standard, 10 with systemic symptoms: fever or body aches), then graded return at 50%→70%→85%→100% volume.
- **Above-neck**: easy effort only at reduced volume (85% mild, 70% moderate, 60% severe) for the acute window; RHR ≥+10 bpm forces day 0 to rest.
- Day-of-symptoms shifts the schedule forward (a user reporting on day 4 doesn't get day-0 mods).

`applyIllnessMods` reads today's schedule entry and applies modifications: `rest` capacity replaces all sport workouts (run, bike, swim, strength) with rest; `easy_only` downgrades quality runs to easy and scales volume; `reduced` scales volume with an intensity ceiling. Below-neck classification suppresses strength sessions across the schedule (viral myocarditis risk). Mode-aware: same schedule applies across run/triathlon/cycling/hyrox, with workout kind classification (`run | bike | swim | strength | rest_like | other`) controlling per-discipline behaviour.

The banner on Home and Plan shows today's capacity ("Full rest", "Easy only", "Reduced", "Returning") with volume %, day number, and the "Recovered" CTA. A live "Mosaic's response" preview in the modal shows the classification + schedule summary before the user confirms. VDOT week-advance adherence multiplier is bypassed (treated as 100%) while `illnessState.active` is true. **Plan adherence is illness-aware** (2026-06-03): `computePlanAdherence` (running) subtracts full-rest days from each past week's denominator and `computeTriAdherence` skips rested sessions, reconstructing rest days from the persisted schedule via `wasIllnessRestDay` — so a rested week doesn't drop the adherence number (matching the banner's "skipped workouts don't count against adherence" promise). The status chip shows "Illness" (not "Missed") for those days.

The live illness modal (`illness-modal.ts`) now writes the **v2 shape** (classification + schedule), so below-neck strength suppression actually fires — wired 2026-06-02. Legacy `illnessState` shapes (just `severity: 'light'|'resting'`, from an illness reported before the upgrade) still work via a fallback path in `applyIllnessMods`, which now routes through `applyIllnessModsAllDisciplines` so bike/swim/strength are scaled too (the old run-only fallback left them at full load). All three plan-views (running/tri/HYROX) call the canonical `applyIllnessMods`.

**Mode wiring (2026-06-01)**: render-time suppression was only ever applied in running's `plan-view.ts`. Triathlon and HYROX plan-views now apply `applyIllnessModsAllDisciplines` (in `illness-rules.ts`), which runs the same severity tiers across every discipline via `classifyWorkoutKind` and scales the numeric `estimatedDurationMin`/`musculoTendonLoad` fields the tri/HYROX cards render from — so stations, bricks, bike, and swim are reduced/rested, not just the run legs.

**Key files**: `src/calculations/illness-rules.ts` (classifyIllness, buildSchedule, getTodayCapacity, summariseSchedule, shouldSuppressStrength), `src/ui/illness-modal.ts` (form + applyIllnessMods + clearIllness), `src/ui/plan-view.ts` + `src/ui/home-view.ts` (capacity-aware banners), `src/calculations/daily-coach.ts` (stance derived from today's capacity), `src/types/state.ts` (illnessState v2 fields)
**State (v2)**: `illnessState: { startDate, onsetDate?, severity, active, classification?, schedule?, symptoms?, illnessType?, severity1to10?, dayOfSymptoms?, userCapacityOverride?, rhrDeltaBpm?, rhrSource?, resolvedDate? }` — `startDate` is the current schedule anchor (rolls forward on re-report); `onsetDate` is the original first-report date (preserved across re-reports for "Day N" display).
**Science**: Friman & Wesslén — above/below neck rule. Schwellnus 2016 — return-to-train after viral illness. Hellard 2015 — RHR delta as objective severity marker. Full rationale + honest sourcing in `docs/SCIENCE_LOG.md §AB`.
**Tests**: ✅ `src/calculations/illness-rules.test.ts` — 26 cases covering classification (above/below neck derivation, systemic override, RHR flags, severity tiers), schedule shapes per branch, `dayOfSymptoms` shift, `getTodayCapacity` bounds, `summariseSchedule`, helpers. ✅ `daily-coach.test.ts` legacy + v2 paths.

---

### 15c. Holiday Mode
**What it does**: When the user reports a holiday via the check-in overlay, a multi-step questionnaire collects dates, running plans ("yes/maybe/no"), and holiday type (relaxation/active/working). The system then:
- Shifts quality sessions within 2 days of holiday start forward (pre-holiday shift)
- Replaces workouts during holiday with advisory text based on running plans (rest, optional easy run, or easy-only)
- Shows a blue banner on Home and Plan views with day count, run status, and "End holiday" / "Generate session" buttons
- "Generate session" creates an ad-hoc easy run at 60% of normal session distance
- On holiday end (by date or manual): welcome-back modal analyzes actual TSS logged during holiday, classifies activity level (very active >70%, moderate 30-70%, sedentary <30%), builds 1-3 bridge weeks with scaled workouts, applies detraining
- **Detraining + comeback bridge across all modes (2026-06-01, P1)**: returning tri/cycling/HYROX athletes used to get the full week-N prescription on day one. `applyBridgeModsAllDisciplines` now scales swim/bike/run-leg/station volume on the comeback weeks (not just runs), reading the same `_holidayBridgeScale` running uses. FTP, CSS and VDOT detrain on return via the shared `detrainingLossFraction` curve (~1.2%/wk wks 1-2, 0.8%/wk after; Mujika & Padilla 2000) with a **10-day dead-zone** (a normal week off costs nothing) and **activity-while-away attenuation** (kept training → less loss). **Holiday-only** — following the plan never lowers a benchmark. An **anchor** (`ftpDetrainAnchorISO`/`cssDetrainAnchorISO`) stops the launch refresh restoring a docked value from a pre-holiday effort; a post-return ride/swim clears it. Welcome-back copy is mode-aware. Science: `SCIENCE_LOG §AS`.
- Taper overlap: warned during questionnaire, taper weeks never modified by bridge rebuild
- Multiple holidays supported per training block via `holidayHistory`
- **Mode-aware, facility-access model (2026-06-01)**: running uses `applyHolidayMods` (run-only). Triathlon and HYROX use `applyHolidayModsAllDisciplines`, which models what you can actually train away rather than reducing everything uniformly: **running is the holiday spine** (honours the "can you run?" answer); **bike always rests** (no bike while travelling); **HYROX stations + bricks always rest** (no equipped box away); **swim is conditional** on a triathlon-only "Will you have a pool or open water?" question (`canSwim`) — easy reduced swim if yes, rest if no. The questionnaire adds the swim step (`renderStepSwim`) for tri only. The tri/HYROX engines also honour a holiday `forceDeload` week (`deload = forceDeload || isDeloadWeek`), matching running.

**Key files**: `src/ui/holiday-modal.ts` (questionnaire, mods, banners, welcome-back, `applyHolidayModsAllDisciplines`, `applyBridgeModsAllDisciplines`, detraining docks), `src/ui/welcome-back.ts` (`detrainingLossFraction` shared decay curve + `DETRAINING_DEADZONE_DAYS`), `src/ui/plan-view.ts` (running banner + mods), `src/ui/hyrox/plan-view.ts` + `src/ui/triathlon/plan-view.ts` (discipline-aware mods + comeback bridge), `src/ui/home-view.ts` (banner), `src/ui/checkin-overlay.ts` (wires Holiday button), `src/workouts/plan_engine.hyrox.ts` + `src/workouts/plan_engine.triathlon.ts` (forceDeload), `src/main.ts` (holiday end detection + FTP/CSS anchor-gate on launch), `src/types/state.ts` (holidayState + holidayHistory), `src/types/triathlon.ts` (`ftpDetrainAnchorISO`/`cssDetrainAnchorISO`)
**State**: `holidayState: { startDate, endDate, canRun, canSwim?, holidayType, active, preHolidayShifts?, welcomeBackShown?, preHolidayWeeklyTSS? }`, `holidayHistory: Array<{ startDate, endDate, holidayType, actualTSSRatio? }>`
**Tests**: ✅ `src/ui/holiday-modal.test.ts` — 27 tests covering parseKmFromDesc, isWeekInHoliday, getHolidayDaysForWeek, applyHolidayMods, applyBridgeMods_renderTime; ✅ `src/calculations/illness-holiday-disciplines.test.ts` — 16 tests covering discipline-aware illness + holiday mods (rest-all, scale stations/bike/swim, holiday-day gating) + `applyBridgeModsAllDisciplines` comeback ramp (scales all disciplines, run km, quality downgrade, no-op without scale, skips user-Adjust/adhoc); ✅ `src/ui/welcome-back.test.ts` — `detrainingLossFraction` dead-zone + activity attenuation, `computeVdotLoss` dead-zone inheritance

---

### 15b. Session Generator

Ad-hoc workout generation from plan view. Mode-aware modal — running/fitness uses a flat type picker, triathlon uses a discipline-first picker, HYROX jumps straight to Run by Feel.

**Running / fitness mode (incl. Just-Track)** — opens on a **Suggested vs Pick your own** chooser (2026-05-29), then a two-step modal: pick session type then set distance or time.
- **Suggested session**: a concrete typed session built from the recovery read — effort band from `buildSessionRecommendation().recommendedSlot`, type via `SUGGESTED_SLOT_BY_EFFORT` (easy → Easy Run, steady → Progressive Run, hard → Threshold; deliberately never VO2/Time Trial unprompted), duration from the type's own `defaultMinutes`. Card shows the type, duration/distance, the readiness caption, and a one-line "why this session". **Accept** commits it (mirrors the manual non-effort save path exactly); **Adjust** pre-selects the type and drops into its duration/effort step; **Back** returns to the chooser. With no recovery data yet, falls back to the lowest-risk option (Easy Run) rather than the band default. The chooser fronts the single-discipline run/fitness flow only — tri opens straight to its discipline picker, hyrox to Run by Feel.
- **Pick your own**: the existing flat type picker (run types). **Exception — On-demand mode** (`trackOnly`): "Pick your own" opens the discipline picker (Run / Bike / Swim / Gym) instead, so an athlete with no plan can generate in any discipline we support. See the On-demand block below.
- Session types: Easy, Long, Threshold, VO2 Intervals, Marathon Pace, Progressive, Time Trial, Run by Feel
- Distance/time toggle with slider, secondary estimate (time from distance or vice versa)
- Generates structured workouts via `intentToWorkout` (warm-up/cool-down, paces from VDOT, interval reps)
- Added as `adhoc-*` prefixed workout in current week's `adhocWorkouts`
- Also used by holiday banner "Generate session" button

**Triathlon mode** — discipline-first four-step flow.
- Step 0 — discipline picker: Swim / Bike / Run
- Step 1 — kind picker per discipline:
  - Swim: technique / endurance / CSS intervals / speed / **CSS test**
  - Bike: endurance / tempo / sweet spot / threshold / VO2 / hills / **FTP test**
  - Run: existing run-types (Easy / Long / Threshold / VO2 / Marathon Pace / Progressive / Time Trial / Run by Feel — Run by Feel tile has a one-shot entrance shimmer)
- Step 2 — duration slider (swim/bike) or distance/time picker (run). Includes:
  - Target band: watts for bike (`BIKE_ADHERENCE_BAND` × midpoint %FTP), sec/100m for swim (CSS offset table)
  - Per-kind duration caps (VO2 30–75min, threshold 45–90min etc.) — out-of-range durations not reachable
  - **What you'll do** preview line showing the full structured workout, refreshes on slider input
  - **Different structure →** link opens the variant drill-down (step 3)
  - Discipline-aware recovery line reading `triConfig.fitness.{discipline}.tsb`
  - All sliders use `m-slider-glass` (RPE-slider aesthetic)
- Step 3 — variant drill-down: lists all 3 variants for the chosen kind, each rendered at the kind's default duration. Picking one locks it on the duration step; rotation default (`weekIndex % count`) applies otherwise.
- **CSS test** and **FTP test** are fixed-protocol sub-flows (no slider, no variants). Coggan & Allen 2019 FTP protocol; Pierre Robson 400m CSS protocol. Tagged with the appropriate `t:` so post-hoc benchmark detection (`activity-detail.ts:503,520`) recognizes them.
- Swim sessions reuse `generateSwimSession()` (CSS-aware), bike sessions reuse `generateBikeSession()` (FTP-aware with HR fallback). Both accept optional `variantIndex` to honour the drill-down choice.
- All saves push into `wk.triWorkouts` with `discipline`, `dayOfWeek`, `dayName` (today). Day reposition via existing drag handler in `triathlon/plan-view.ts:351`.

**On-demand mode (`trackOnly`)** — reuses the tri discipline picker so a no-plan athlete can generate in any discipline (2026-06-01). Reached via the chooser's "Pick your own".
- Discipline picker shows **Run / Bike / Swim / Gym** (Gym tile is On-demand only; tri never sets `'gym'`). Bottom button is **Back** (returns to the Suggested/Pick chooser), not Cancel.
- **Run / Bike / Swim** reuse the exact tri renderers (`renderStep1`, `renderSwimKind/Duration`, `renderBikeKind/Duration`) — the `isTri` gates were generalised to `hasDisciplinePicker = isTri || isOnDemand`. The generators degrade gracefully without benchmarks (swim estimates distance from skill; bike uses RPE when no FTP).
- **Optional benchmark capture**: picking Bike with no FTP, or Swim with no CSS, shows a one-time skippable prompt (`renderBenchmarkPrompt`). Saving stores a `'user'`-sourced value on `triConfig.bike.ftp` / `triConfig.swim.cssSecPer100m` (the canonical benchmark home — cycling mode reuses it too). `eventType` stays non-triathlon so this never flips the user into triathlon UI. Skipping proceeds with RPE/duration targets.
- **Gym** (`renderGymSession`): single screen, no slider — calls `generateGymWorkouts(phase, 1, experienceLevel, week, totalWeeks, vdot, injuryState)` and shows the generated session. Injury-aware: when an injury pauses loaded strength the generator returns `[]` and the screen shows a rehab-focus message instead of a session.
- **Save path forks on mode**: `saveTriAdhoc` routes On-demand sessions (all four disciplines) into `wk.adhocWorkouts` + re-renders the main view (single store, like the running/fitness path), never `triWorkouts` / the tri plan view.
- **Entry surface**: a prominent "Generate a session" card sits at the top of the On-demand home (`getTrackOnlyHomeHTML`), naming run/bike/swim/gym. It's the primary action in a mode that has no plan.

**HYROX mode** — single-button shortcut.
- `+ Add session` opens directly into Run by Feel
- Saves into `wk.triWorkouts` (HYROX reads workouts from `triWorkouts`)

- Excluded from TSS calculations (suggestions, not completed activity)

**Readiness caption (2026-05-28)**: a one-line caption above the type / discipline picker reflects today's state — readiness composite score, the matrix sentence from `computeReadiness` (same one driving the home ring), and the injury caption if any blocked/capped disciplines apply. Caption-only: picker still accepts any choice. Built by `buildSessionRecommendation(state)` in `src/calculations/session-recommendation.ts`, which lifts the lean context payload from `src/ui/coach-workout-modal.ts` (the premium variant) and applies it deterministically — no LLM call. Slot heuristic: score < 45 → easy, ≥ 75 → hard, else steady; injury forces hard → steady.

**Key files**: `src/ui/session-generator.ts` (entrypoint + run/swim/bike sub-flows + tri save), `src/calculations/session-recommendation.ts` (caption + slot heuristic), `src/ui/triathlon/plan-view.ts` (header button), `src/ui/hyrox/plan-view.ts` (header button), `src/ui/plan-view.ts` (running header button), `src/workouts/swim.ts`, `src/workouts/bike.ts`
**Tests**: `src/calculations/session-recommendation.test.ts` (9 tests) — ✅ Passing. Session-generator UI itself: no tests yet.

---

### 15c. Run by Feel

Unstructured run with no pace target. Workout type `'vibes'` internally; user-facing name is "Run by Feel". Always purely additive (extra session, never replaces a planned workout). The product POV: Mosaic plans get prescriptive on purpose, but listening to your body is part of pacing too — this session is for practising that skill so plans don't blunt it.

- **Spec**: numbered two-step plan presented in the modal — (1) Run 5km at easy pace, put on good music, take photos of cool things, enjoy. (2) If at 5km you want to stop, stop. Otherwise keep running.
- **Available** in the session generator picker for running, HYROX, and triathlon modes (cycling is not a standalone mode). In tri mode the picker is filtered to show only this option for V1.
- **Visual cue**: warm sun-glint lighting (matching `buildSunGlint` palette) on the picker tile and modal — strong enough to read as "lit", subtle enough to fit the page-flair brand.
- **Discovery nudge**: build-phase only, surfaces a dismissable bonus card on plan view top. Once-per-plan (state-level `vibesRunNudgeDismissed`). Card has Try one / Dismiss / Tap-for-science actions. Mirrored on running and triathlon plan views.
- **Science explainer modal** ("Why Run by Feel works"): fartlek (Holmér), central governor (Noakes), flow states (Csikszentmihalyi), Born to Run (McDougall), self-determination theory (Deci & Ryan).
- **Load**: no special handling. TSS is computed retroactively from the actual when Strava/Garmin lands, like any other activity. Weekly TSS will go above plan target by design (user-elected extra).
- **Founder anecdote**: card and modal reference Tristan's half marathon PB on one of these.

**Key files**: `src/ui/session-generator.ts` (renderVibes + openVibesScienceModal), `src/ui/plan-view.ts` (buildVibesRunNudgeCard + handlers), `src/ui/triathlon/plan-view.ts` (mirrored card + Add session button), `src/types/training.ts` (`'vibes'` in WorkoutType), `src/workouts/intent_to_workout.ts` (`'vibes'` in SlotType)
**Tests**: ❌ None yet

---

### 16. Recovery Engine
**What it does**: Morning check-in system. Automatically reads Garmin sleep score, HRV (RMSSD → categorical status), and readiness (100 − stress). Falls back to 1–10 manual tap UI if no Garmin data. Scores → traffic light (green/yellow/orange/red). Orange or red triggers workout adjustment modal and inflates ATL for ACWR. One prompt per day (`lastRecoveryPromptDate` guard).

**Key files**: `src/recovery/engine.ts`, `src/data/physiologySync.ts`, `src/main.ts` (orchestration)
**Tests**: `src/recovery/engine.test.ts` — ✅ 17 passing (incl. 2 new `rmssdToHrvStatus` tests)

**Orchestration** (`main.ts → checkRecoveryAndPrompt`):
- After `syncPhysiologySnapshot(7)`: finds today's entry → `buildRecoveryEntryFromPhysio()` → `computeRecoveryStatus()`
- No Garmin data today: shows manual 1–10 check-in
- Orange/red status: sets `wk.recoveryDebt`, pushes to history, shows adjustment modal

**Plan tab UI** (in `src/ui/plan-view.ts`):
- Recovery log modal: 1–10 colour-graded tap buttons (red→green); maps score×10 to sleepScore
- Recovery adjust modal: bottom-sheet offering "Run by feel", "Downgrade to Easy", or "Reduce Distance" with recommended option highlighted

**Home tab UI** (`buildReadinessRing` in `home-view.ts`):
- Training Readiness ring (see §29) replaced `buildSignalBars` — HRV, sleep, and RHR data surface inside the Recovery pill there

**ATL inflation** (`fitness-model.ts`): `recoveryDebt='orange'` → 1.10× ATL; `recoveryDebt='red'` → 1.20× ATL (stacks with `acwrOverridden` 1.15×, takes max)

---

### 16b. Personal Recovery Rate (Adaptive Recovery)
**What it does**: Learns how fast the user recovers *relative to a typical person at the same relative intensity*, expressed as `k_user` (= 8 × recovery index; index 1.0 = typical). Scales the recovery-countdown and shifts the per-tier ACWR ceiling once confident. Falls back to 8 when evidence is thin.

**How the fit works** (redesigned 2026-06-03, ISSUE-256): `index = observedHours / expectedRecoveryHours`, aggregated in robust log space. `observedHours` = time for the HRV/RHR composite to return to the 28-day baseline. `expectedRecoveryHours` = literature anchor for the session's **intensity band** (easy 24h / moderate 36h / hard 54h, Stanley et al. 2013). Intensity is read from `GarminActual.hrZones` (Strava computes zones against the athlete's own HR zones → fitness-relative) via time-weighted mean zone, RPE fallback (Foster 2001). Only **clean-window** readings count (no intervening session inside the recovery window), so training through doesn't read as slow. `k_user = clamp(8 × index, [5, 13])`.

**Confidence bands** (N = clean-window readings):
- `none` (0–7): population default 8
- `low` (8–15): learning; not yet used
- `medium` (16+): used in the recovery countdown
- `high` (30+): also shifts the per-tier ACWR ceiling by ±0.10 max
- `densityLimited`: many sessions logged but few clean → card says "training too densely to read"

**Historical backfill**: on first run, walks `garminActuals` (current + archived plans) into `SessionImpactEntry`s for the last 90 days, classifying intensity from each activity's HR zones. `backfillIntensityBands` retrofits bands onto pre-existing entries so the redesign applies immediately. Historical entries weight at 0.7×.

**Onboarding hook**: 5th welcome slide pitches "Learns how you recover". Recovery pill on home view appends "Helps Mosaic learn how you recover" until confidence = high.

**Surface**: a card on the recovery detail page (inside Detailed Metrics, matching the HRV/RHR card width) leads with a plain verdict — "Recovers at a typical rate" / "…faster than typical" / "…slower than typical" — with the index as 1-decimal subtext ("1.0× the typical recovery time") and a caption explaining Mosaic uses it to set the recovery-countdown length (and weekly-load pacing at high confidence). The "typical" band is whatever rounds to 1.0× (within 5%). Density-limited and learning states have their own copy. Device-verified 2026-06-03: a fit athlete previously pinned at 1.63× now reads 1.02× ("typical").

**Fairness to fit / high-volume athletes** (the ISSUE-256 fix): the comparison is to a typical person *at the same relative intensity* (HR-zone matched), and only clean rest-gap windows are measured, so training hard and often no longer reads as slow recovery. A genuine never-rest athlete is intentionally unmeasurable (density-limited) rather than mislabelled. See SCIENCE_LOG `k_user` Addendum 2.

**Key files**: `src/calculations/adaptive-recovery.ts` (model + fitter), `src/calculations/fitness-model.ts` (consumes `k_user` in `computeToBaseline` and `computeACWR`), `src/main.ts` (`refreshAdaptiveRecovery` runs after physiology sync), `src/ui/recovery-view.ts` (`renderPersonalRecoveryCard`), `src/ui/wizard/steps/welcome.ts` (5th hero slide)
**State**: `adaptiveRecovery: { kUserHours, confidence, sessionsObserved, densityLimited?, lastFitAt, emaHalfLifeWeeks, history?, notifiedMilestones? }`, `sessionImpactLog: SessionImpactEntry[]` (now carries `intensityBand` + `expectedRecoveryHours`; capped at 90 days)
**Tests**: ✅ `src/calculations/adaptive-recovery.test.ts` — 46 tests covering intensity classification (HR-zone + RPE), expected-hours anchors, confidence bands, ceiling-shift bounds, typical/fast/slow index fits, log-space robustness to right-skew, clean-window filter (morning-aware) + density-limited, no-band exclusion, source-weight asymmetry, intensity-band retrofit, historical-backfill ingestion

---

## Cross-Training

---

### 17a. Double-Day Compounding (2026-05-19) ✅

**What it does**: When the athlete logs two or more activities on the same calendar day (each ≥20 min), the day-level Signal B aggregate gets a gap-scaled compounding bonus on the 2nd+ session's raw TSS. Two same-day sessions cost more recovery than the same total TSS spread across two days, so the day total reflects that.

**Multiplier bands** (`src/calculations/double-day.ts:doubleDayGapMultiplier`):
- <2h gap → ×1.20 on 2nd+ session
- 2–6h → ×1.15
- 6–12h → ×1.10
- ≥12h → ×1.05

**Gating**:
- Sessions <20 min ignored (filters short accessory work).
- Planned bricks (`brick`, `hyrox_brick`, `hyrox_mini_brick` on the same day) suppress the bonus — these have their own science.
- Unplanned bike→run within 30 min collapses to a single virtual session via `brick-detector`, so a transition run doesn't double-penalise.

**Where it applies**:
- `computeWeekRawTSS` — feeds ACWR, weekly raw TSS charts, fitness curves.
- `computeTodaySignalBTSS` — feeds the live Strain Score on Home.
- Per-activity TSS in Activity Review stays raw. The bonus is a *day-level recovery debt*, not a per-session intensity adjustment.

**UI surface** (running, triathlon, and HYROX plan-views):
- "Double day · +N TSS" pill on the day separator (bordered, no fill, muted text).
- "2nd session today. Day load adjusted." caption under the secondary activity's match row (running) or unplanned card (tri/hyrox).

**Tests**: 16 unit tests in `src/calculations/double-day.test.ts` covering gap bands, ≥20 min gate, brick suppression, unplanned brick collapse, and multi-day weekly sums.

**Science**: full rationale + literature in `docs/SCIENCE_LOG.md §AJ`.

### 17. Universal Load Model
**What it does**: Converts any cross-training activity (swimming, cycling, rugby, padel, etc.) into **canonical TSS** (1h@LT=100 — the app-wide load currency since 2026-06-04, SCIENCE_LOG §BP). Four tiers of accuracy, all emitting the same unit (pre-canonicalisation the tiers diverged up to 3.2× for one identical session):
- **Tier A+** (iTRIMP, 0.95 confidence): Second-by-second HR stream via Strava API. Individual TRIMP (Banister/Morton, HRR fraction, sex-specific β) → TSS via the plausibility-gated personal normalizer. No sport multiplier (measured).
- **Tier A** (Garmin raw Firstbeat load, 0.90): converted at ingest via the per-RPE `garminToTssRatio` (~1.63 easy → ~2.03 VO2). No sport multiplier (measured).
- **Tier B** (HR zones, 0.75–0.85): Time-in-zone × per-zone TSS/min anchored to the definition (Z4 = threshold zone = 100/h; hourly [25, 50, 75, 100, 125]). No sport multiplier (measured).
- **Tier C** (RPE only, 0.55–0.70): Duration × `TL_PER_MIN[rpe]` × sport multiplier × active fraction × 0.80 uncertainty discount (estimates are deliberately conservative).

**Saturation**: replacement credit = `TAU(1−e^(−raw/TAU))`, TAU=491 TSS — slope 1 at the origin so a session's credit can never exceed its own load (the old two-parameter curve amplified ×1.87).

**Impact load**: `computeUniversalLoad()` now returns `impactLoad = durationMin × sport.impactPerMin` (musculoskeletal/leg stress). Separate from cardiovascular FCL. Per-sport values live in `SPORTS_DB.impactPerMin`.

**Workout type classifier (Phase B v3)**: Three exported functions classify a cross-training activity's intensity profile:
- `classifyByITrimp(iTrimp, durationMin, thresholds?)` — normalises iTRIMP → TSS/hr and classifies as easy / threshold / vo2 using configurable thresholds (default: easy < 70, threshold 70–95, vo2 > 95 TSS/hr)
- `classifyByZones(hrZones)` — uses HR zone ratios for steady-state sports (base > 80% → easy; Z3 > 40% → threshold; Z4+Z5 > 30% → vo2)
- `classifyWorkoutType({ sport, durationMin, iTrimp?, hrZones?, thresholds? })` — decision tree: uses iTRIMP for intermittent sports (football, rugby, basketball), high-HR spike activities (>15% Z4+Z5), or short sessions (<20min zone data); uses zone distribution otherwise; falls back to profile. Returns `{ type, tss, runningEquivTSS, method }`.
- Personal intensity thresholds stored at `SimulatorState.intensityThresholds` — automatically calibrated from labelled Strava runs via `calibrateIntensityThresholds()` in `data/stravaSync.ts`. Strava workout names classified by keyword (e.g. "Tempo Run" → tempo zone; "Interval" → interval zone). 90th-percentile TSS/hr per zone, clamped to sane bounds. Requires ≥3 labelled sessions per zone to update from defaults (easy≤70, tempo≤95 TSS/hr). Calibration status shown in Stats → Advanced.

**How to test manually**: Plan tab → "+ Log activity" (current week only) → sport/duration/RPE → the suggestion modal fires through the full pipeline. The console will show `[CrossTraining] Zone classification: threshold (itrimp) — TSS 84.3, runEquiv 37.9` confirming method and type.

**Key file**: `src/cross-training/universalLoad.ts`, `src/cross-training/universal-load-types.ts`
**Tests**: `src/cross-training/universalLoad.test.ts` (48 tests including 15 classifier-specific), `src/cross-training/activities.test.ts` — ✅ Passing

---

### 18. Cross-Training Suggester
**What it does**: After you log a cross-training activity, the app calculates how much running it can replace and shows you three options: Keep (log it, keep full run plan), Reduce (soften some runs), Replace & Reduce (remove one run entirely, soften others). The suggestions are ordered by how similar the cross-training is to each planned run.

**Runner-type aware reduction**: Speed runners have volume cut first (easy runs before quality downgrades). Endurance/Balanced runners have intensity cut first (quality downgrades before volume). Controlled by `AthleteContext.runnerType`.

**Zone-profile matching (Phase B v3)**: `buildCandidates()` now uses `classifyWorkoutType()` to improve candidate ranking by intensity zone profile. A football session classified as "threshold" will rank your threshold run as a better candidate than your easy run, even if raw load similarity is similar. Scoring: +0.20 for zone profile match, −0.10 for opposite ends (e.g. vo2 activity vs easy run). Falls back to load-only ranking when no iTRIMP or HR data is available.

**Load modal (redesigned 2026-06-03)**: Glass overlay modelled on `goal-time-overlay.ts` — dim slate backdrop with blur, translucent glass card (`rgba(255,255,255,0.78)` + `blur(24px) saturate(1.4)`, 24px radius), top-right × close. Inner surfaces (option cards, ctx card, notes, edge panels) are frosted layers: white 0.66 + the `m-btn-glass--inset` two-layer shadow, no per-card backdrop-filter (stacked glass = perf cliff). Type scale is three sizes: 15/600 headings, 13 body, 12 secondary (11 only on the Recommended chip). Zero non-neutral colours (round 5, 2026-06-03: the tinted alert box with red title + 3px severity stripe was removed — it violated the "No tinted card backgrounds" rule; severity is carried by the title and copy). No decorative icons (warning triangle removed), no sport emoji, no per-option traffic-light colours, no coloured tier badges. Option cards (Replace & Reduce / Reduce / Push to next week / Keep plan) are frosted neutral; exactly one carries a dark 1.5px border + a muted "Recommended" chip, chosen by priority (replace → reduce → push → keep). Adjustment rows in the "View changes" expanders read "Tue · Easy Run" (day from `Adjustment.dayIndex`, Monday-first), action right-aligned, detail as a full-width second line; hairline separators, no panel box, rotating ▸ caret on the summary. **The header owns the ask** (round 9): the consequence sentence states the achievable trim — "You've been training harder than normal. This week is 140% above your usual load, so the remaining runs come down by ≈ 4.7 km." — where `askKm` is the recommended option's actual cut (`Σ loadReduction / runReplacementCredit` scaled by `equivalentEasyKm`, same currency, no new constants). Cards state only what they deliver: "Cuts ≈ 4.7 km from the remaining runs." Headlining the full physiological excess proved misleading (read as "needs 15.7, can only do 4.7 = failure"); the full excess and where the remainder goes (run minimums block deeper cuts; uncut load stays as fatigue and an over-target week starts the next one with a smaller budget via `wk.carriedTSS`) live in the See-details disclosure (`excessDetail`). **Reduce hides when not equivalent**: it exists to spread ≈ the same cut across runs without replacing one; when the floors stop it reaching ≥90% of Replace & Reduce's total it is not a real alternative and is not shown. Keep plan shows "Cuts nothing. The excess stays as fatigue." (the duplicate heavy-severity warning is dropped when this line is present; the extreme warning stays). The leg-impact label is tappable (dotted underline) with a one-line explainer (impact = ground-strike stress on bones/tendons, not muscular work — a hard ride correctly reads "No leg impact"); in the matched-activity header the "≈ X km easy running equivalent" label is tappable too (excess = training stress already done; reducing trades planned sessions for it, keeping carries it as fatigue). Edge-case panels (already-completed match, no matching run) use neutral cards with a dark primary pill + bordered secondary. The optional ACWR header is a plain title ("Heavy training week" / "Load building up") + the ask sentence + a quiet meta row (leg impact · "See details"); the disclosure holds the 5-rule plain-language advice (cross-training cause / km spike / consecutive intensity weeks), the full-excess accounting, and the raw ratio rows (intensity row reads "33% at threshold or above", no jargon). Option cards are keyboard-accessible: `div[role=button][tabindex=0]` with a `:focus-visible` ring and Enter/Space activation (`<details>` nested inside a real `<button>` is invalid HTML and broke tabbing). **Select-then-confirm**: tapping a card selects it (dark border + `aria-pressed`; recommended option pre-selected) and a primary dark Confirm pill applies it — a stray tap on a big card no longer mutates the plan. Confirming Replace/Reduce fires a transient toast summarising the change ("Plan updated: 1 run downgraded, 1 run reduced.") via `showSimpleToast`, covering all call sites from the modal. *(Note: an earlier doc entry claimed a 2026-05-18 rewrite; that code never landed in git — likely lost in the 2026-05 crash. This is the first shipped redesign.)*

**Undo from Home (2026-06-03)**: Confirming Replace/Reduce in the ACWR flow stamps the pushed `workoutMods` with `appliedAt` and stores `wk.acwrReductionUndo` (date, sport label, cleared `unspentLoadItems`). For the rest of that day the Home readiness card replaces "Reduce session load" with a "Session load reduced." caption + "Undo reduction" button → `undoACWRReduction()` (`main-view.ts`) removes exactly that day's ACWR mods (mods are a render-time layer, so the original sessions come back) and restores the cleared unspent items, with a confirmation toast. Same session also fixed a committed bug: the `readiness-adjust-btn` handler was missing an `else`, so an elevated-ACWR tap opened the reduction modal AND the recovery advice sheet together, and a non-elevated tap did nothing.

**How to test manually**: Log a high-intensity cross-training activity (e.g. 60min interval cycling with HR data). In the suggestion popup, check that the quality run (threshold/VO2) is ranked above easy runs in the candidate list. Console shows `[CrossTraining] Zone classification: ...` and the candidate similarity scores.

**Recovery tier (2026-04-15)**: Intensity ladder extends to a new `'recovery'` workout type (zone 1, RPE 3, easy pace + ~43 s/km, reduced load profile). When the km floor blocks a distance cut on an all-easy week, the suggester downgrades easy → recovery instead — preserves volume, absorbs excess load. Constants provisional pending Tristan sign-off (see `SCIENCE_LOG`).

**Budget-cap fix (2026-04-15, ISSUE-137)**: Previously, a tightly capped reduction budget (small overshoot vs. large RRC) could shrink `effectiveRRC` below `minLoadThreshold`, silently suppressing all Reduce adjustments — even when a tempo remained that could have been downgraded. Now guarantees at least one quality downgrade attempt; first adjustment records its true `loadReduction` even if it overshoots budget (controlled overshoot preferred to silent suppression). Modal copy also updated: explanation banner when no reductions are possible; "Recommended" green moves from Keep → Push when that path is available.

**Km floor nudge (plan-view card)**: When running km has been below the phase floor for 2+ weeks and ACWR is safe, a card shows at the top of the plan view. If cross-training reduced runs this week, the card explains the tension (load high, km low) and offers per-run buttons to partially restore reduced easy runs. Users choose which run to extend. Cap: never exceed original pre-reduction distance. Non-reduced easy runs can be extended up to 20% (1.5 to 5km). Gated by ACWR safe (injury prevention takes priority).

**Key files**: `src/cross-training/suggester.ts`, `src/ui/suggestion-modal.ts`, `src/ui/plan-view.ts` (km nudge card)
**Tests**: `src/cross-training/suggester.test.ts`, `src/cross-training/universalLoad.test.ts` (classifier tests), `src/cross-training/matcher.test.ts`, `src/cross-training/boxing-bug.test.ts`, `src/cross-training/km-budget.test.ts` — ✅ Passing

---

### 18b. Cross-Training Load Management v2 *(designed 2026-03-04 — partially built)*

> Replaces the current "overflow → blocking modal" pattern with a tiered,
> baseline-relative, timing-aware system. See PRINCIPLES.md for the "why."
>
> **Update 2026-03-12**: Signal B baseline data (`historicWeeklyRawTSS`,
> `signalBBaseline`, `sportBaselineByType`) is now populated from the Strava edge
> function. The plan bar and excess detection are being redesigned — see
> `docs/specs/LOAD_BUDGET_SPEC.md` for the full Load Budget specification which
> supersedes the baseline/excess sections below.

#### Signal B weekly baseline — ✅ DATA EXISTS

- `historicWeeklyRawTSS` — populated from Strava edge function `history` mode
- `signalBBaseline` — computed in `stravaSync.ts` as **median** of weekly rawTSS (resistant to injury gaps)
- `sportBaselineByType` — per-sport average session TSS + frequency/week
- No proxy fallbacks needed — real Signal B data flows from the edge function

#### Initialisation load graph

On plan start (or first load with Strava history available), the onboarding or welcome screen
shows an 8-week chart of the athlete's historic Signal B load with:
- A labelled baseline line ("Your usual weekly load: ~85 TSS")
- Sport breakdown annotations (hover/tap for per-sport contribution where data allows)
- Narrative: *"You've been consistently active. Your plan starts here and adds running load
  gradually on top of what you're already doing."*
- If `Signal B CTL / Signal A CTL > 1.5`: *"You have aerobic fitness from cross-training.
  We'll build running specificity carefully to protect your joints."*

**Key file to build**: onboarding or `welcome-back.ts` chart section.

#### Tier 1 — Auto-adjust (≤ 15 TSS excess)

- When a cross-training activity creates ≤ 15 TSS above `signalBBaseline` for the week:
  - Find the nearest **unrated easy run** in the current week
  - Reduce its distance proportionally (Signal A translation: excess TSS → easy km equivalent)
  - Apply as a `workoutMod` silently (no popup)
  - Show an inline note on the activity card: *"Easy run reduced by 1.2km · 18 TSS accounted for"*
  - Tap the note to see details or undo (restores original distance, re-queues as Tier 2)
- If no unrated easy run exists, excess moves to Tier 2 instead.

**Key files to modify**: `src/ui/activity-review.ts` (`autoProcessActivities`),
`src/data/activitySync.ts`, `src/calculations/fitness-model.ts` (TSS delta).

#### Tier 2 — Nudge card (15–40 TSS excess) — ✅ BUILT

- Amber card: *"32 TSS above your usual week · Adjust plan"*
- Detects from total week Signal B vs `computePlannedSignalB()` — matching irrelevant.
- [Adjust Plan] → reduce/replace modal with `reductionTSS = excess × weightedRunSpec × recoveryMultiplier`.
- [Dismiss] → two-tap; writes a suppression mod so card hides for the rest of the week.

**Key file**: `src/ui/excess-load-card.ts`.

#### Tier 3 — Blocking modal (ACWR caution/high only)

- Existing behaviour preserved. Fires only when ACWR enters caution or high zone.
- Not triggered by TSS overage alone.
- Existing `suggestion-modal.ts` + ACWR context header untouched.

#### Timing sensitivity: day-proximity → quality session downgrade

- After any activity syncs, run a **proximity check**:
  - For each remaining unrated quality session this week (threshold, VO2, long run):
    - Is there a completed cross-training or run activity with Signal B ≥ 30 TSS
      whose `startTime` is within 1 calendar day of this session's planned day?
    - If yes: apply a `workoutMod` with `status: 'downgraded'`
      - Threshold → Marathon Pace intensity
      - VO2/Interval → Threshold pace intensity
      - Long run → distance reduced by 15% if Signal B ≥ 50 TSS
    - Show explanation on the plan card: *"You trained hard yesterday — adjusted to
      marathon pace. Move this session if you want full intensity."*
  - If the user reschedules the session (moves to a different day): re-run proximity
    check; clear the downgrade if the new day is safe.
- Timing check is **independent** of Tier 1/2/3. Can fire inside baseline.

**Key files to build/modify**: `src/calculations/activity-matcher.ts` or new
`src/cross-training/timing-check.ts`; wired in `activitySync.ts` after match completes.

#### "Adjust Week" card + week-start carry-over

- **During the week**: If unresolved Tier 2 excess or timing downgrades exist, a persistent
  "Adjust Week" button appears on the Training tab (not a card — a button row beneath the
  session list). Taps into the existing reduce/replace flow with combined context.
- **At week start** (week advance): If `prevWk.unspentLoadItems` is non-empty OR
  excess carried from prev week, show a top-of-Training-tab card:
  *"Last week had 28 TSS of unresolved training load. Here's how it affects this week."*
  Card links to Adjust Week flow. Dismissable with one tap.

**Key files**: `src/ui/main-view.ts` (week-start card), `src/state/persistence.ts`
(carry-over already exists — needs copy update).

#### Quality session independence

- If a quality session was missed this week AND Signal B is not elevated:
  show a **separate** quiet flag on the plan view: *"Threshold run not yet done this week."*
- Do NOT credit cross-training surplus toward a missed quality session.
- Do NOT remove a quality session because of cross-training surplus.
- These are two independent signals surfaced separately.

#### Strava sport-history edge function — ✅ RESOLVED

The `history` mode on `sync-strava-activities` already returns both `totalTSS` (Signal A)
and `rawTSS` (Signal B) per week, plus `sportBreakdown` with per-sport raw TSS. No
separate `sport-history` mode needed.

**Tests to write**: timing check unit tests; baseline delta computation; Tier 1 auto-apply
distance reduction formula; Load Budget integration tests (per LOAD_BUDGET_SPEC §9).

**Status**: ❌ Not yet built

---

### 19. Activity Matcher
**What it does**: Matches an incoming activity (from Garmin or manual entry) to the most similar planned run in the current week. Scores matches by day, distance, and type. High-confidence matches auto-complete the planned run; low-confidence matches become ad-hoc entries.

**Key files**: `src/calculations/activity-matcher.ts`, `src/calculations/matching.ts`
**Tests**: `src/calculations/activity-matcher.test.ts` — ✅ Passing

---

## GPS Tracking

---

### 20. GPS Tracker
**What it does**: Live workout recording. State machine: idle → acquiring signal → tracking → paused → stopped. Computes distance in real time using Haversine math, filters GPS jitter, and stores the full route. Speed-based auto-pause stops the clock after 5s below 0.5 m/s and resumes after 3s above 1.5 m/s.

**Pre-run acquisition gate (2026-06-15)**: starting a run goes through an `arm()` → `confirmStart()` lifecycle (alongside the legacy auto-advancing `start()`). `arm()` begins searching for a fix without starting the clock or counting distance; the Record tab shows a Garmin-style "Acquiring GPS… → GPS ready" gate (`isGpsReady()` fires once a fix ≤ `ACCEPTABLE_ACCURACY_M` = 30 m arrives). The run begins only on the user's confirm tap (`confirmStart()`), so elapsed time and distance both start from a locked signal. Soft gate: "Start anyway" begins before lock; denied/unavailable location arms a timer-only fallback. `cancelArm()` tears the watch down if the user backs out. On iOS the native provider calls `changePace(true)` after `start()` so the transistorsoft SDK leaves its stationary state and emits locations immediately (see CHANGELOG 2026-06-15).

**Key files**: `src/gps/tracker.ts`, `src/gps/geo-math.ts`, `src/gps/providers/native-provider.ts`
**Tests**: `src/gps/tracker.test.ts` (incl. acquisition-gate block), `src/gps/geo-math.test.ts` — ✅ Passing

---

### 20b. Guided Strength Session (mode-agnostic)
**What it does**: Tap "Start session" on any strength workout (tri or running, gym-type) to launch a full-screen guided flow. Walks you exercise by exercise: big elapsed timer, current exercise with `sets×reps` and the feel cue, the "Complete set" button, then the **full workout list** beneath it (one row per exercise: done = ticked + dimmed, current = filled dot + "now", upcoming = hollow dot, prescription right-aligned). The list replaced the old 3-item "Up next" so the athlete sees the whole session, not just what's next (`renderWorkoutList`). Tap Complete set → auto rest countdown starts (skip or +30s), then auto-advances to the next set. Voice + haptic cues by default ("Next: Band Pull-Apart", buzz at rest-end), mute toggle in-session. Finish → duration summary + 1-tap RPE (1–10) → logs the session done (`wk.rated[id] = rpe`), clears "Missed".

**Overview before you start**: tapping a strength card opens a clean overview modal (per-exercise rows, prescription, cue + rest), not the run-on prose paragraph. Running/tri use `strength-workout-detail-modal.ts`; **HYROX-mode** strength sessions now render the same clean rows via `renderStrengthBreakdown` in `hyrox/workout-detail-modal.ts` (previously dumped `workout.d` as a `<p>`), matching the station-circuit overview's structure.

**Key files**: `src/guided/strength-model.ts` (parser), `src/guided/strength-controller.ts` (wall-clock state machine), `src/guided/strength-complete.ts` (mode-agnostic completion), `src/ui/guided-strength-overlay.ts` (overlay UI). Entry: `src/ui/triathlon/workout-detail-modal.ts` (tri), `src/ui/plan-view.ts` (running).
**Tests**: `src/guided/strength-model.test.ts` (19), `src/guided/strength-controller.test.ts` (23) — ✅ Passing.

Reuses the existing `VoiceCoach` and `keep-awake` primitives so cues and screen-on behave the same as for guided runs. Wall-clock + tap driven, not GPS-tick driven (strength has no pace/distance). Live BLE heart rate is out of scope; HR attaches post-hoc when a wearable strength activity syncs.

**HYROX support (2026-05-28, rounds + timed rest 2026-05-29)**: the same overlay powers HYROX station and brick workouts via an adapter (`parseHyroxSession`). The adapter **expands the component list by `workout.hyroxRounds`** into the full round × component walk, reusing the original component index as `exerciseIndex` so the GPS run bridge and the progress rings (which group by station) still resolve — each station accumulates `rounds` sets under one ring. Station names + race-standard targets come from `STATION_DISPLAY` (e.g. "Wall Balls · 100 reps"); run components show their distance ("1 km").

Rest between steps is **prescribed, not athlete-paced**: each component carries `restAfterSec` (inter-station rest, e.g. 30s density / 60s technique); the last component of each round uses the workout's `hyroxRoundRestSec` (e.g. 2–3 min); the final set has no rest. Only the calibration assessment (`hyrox_assessment`) keeps the unbounded "Take your time" pause for recording split times. Entry from `src/ui/hyrox/workout-detail-modal.ts`.

**Live dual timer (2026-05-29)**: the active screen shows both the total **session** clock and a live **current-station** clock (`StrengthGuideController.currentSetElapsedSec`), side by side, both ticking. Per-station totals across rounds still appear grouped in the end-of-session breakdown.

**Benchmark learning + session summary (2026-05-29, SCIENCE_LOG §AP)**: the end-of-session summary (`buildHyroxFinishSummary`) shows each station's **best round**, its **percentile vs the field**, and a "Benchmark updated" line when the session improved a benchmark. `src/calculations/hyrox-session-benchmarks.ts` (`summariseHyroxSession`, `applyHyroxSessionBenchmarks`) feeds measured times back into `hyroxConfig.stationBenchmarks*` + history: **race-pace sessions only** (density, brick — technique at 65% pace is shown but never learned from), **best round per station**, **PB-only** with calibration when no benchmark exists, and a **sanity floor** (elite seed) to reject timing slips. Conservative on fatigue (logs the raw fatigued best round). Wired from `completeStrengthSession`. New history source `'session'` ("Session best"). Replaces the earlier broken write that targeted the wrong config object and never updated the scalar benchmark. **Brick run legs**: `summariseHyroxRuns` lists each run leg in round order with time + pace (no benchmark; run fitness lives in pace/VDOT) above the station row, so fade across the brick is visible.

**Logged as a matchable activity (2026-05-29)**: finishing a guided HYROX session also writes a `GarminActual` to `wk.garminActuals[workoutId]` (`garminId` prefixed `'guided-'`), carrying duration + a `hyroxSession` recap (per-station best round + run legs). It therefore appears in activity history and `activity-detail` renders the recap for later review. When the watch/Strava recording of the same session syncs, the matcher (`activity-matcher.ts` HYROX block) treats the guided actual as an **upgrade candidate** and replaces it with the richer recording (HR, GPS) instead of creating a duplicate — mirroring the Strava-beats-Garmin rule — preserving the recap across the upgrade. Verified end-to-end (creation + sync-upgrade, no duplicate). The station benchmark a session writes feeds the predictor (`predictHyroxRace`): a faster session lowers the predicted finish.

**HYROX GPS auto-advance (2026-05-28)**: when the workout has at least one run component, the overlay spins up a standalone `GpsTracker` for the duration of the session. While a run set is active, a small block above the Complete-set button shows current distance / target and rolling pace; once `totalDistance - baseline` reaches the prescribed `distanceM`, `controller.completeSet()` fires automatically (same path the user's manual tap takes). Stations stay tap-to-end. Permission denials / no-lock / indoor scenarios fall through to the existing manual-tap flow with a hint line so the user knows what's happening. Per-station benchmark comparison now lands in the end-of-session summary (see Benchmark learning above); per-rep counters remain a follow-up.

### 20a. Guided Runs (phone coaching)
**What it does**: Voice and haptic coaching during a tracked structured run. Parses the workout into a step timeline (warm-up, work reps, recovery, cool-down), drives it forward from tracker ticks, and speaks cues: "Go. Threshold rep 1 of 5. 3 minutes at 4:15 per kilometre." Per-km splits are announced on paced work ("Kilometre 3. 4:15. On pace." / "… 7 seconds fast. Ease this one." / "… 7 seconds behind target."). A vertically centred rest overlay shows a big countdown, the next rep preview, and +30s / Skip rest buttons. Off by default; toggled in Account → Preferences.

**Key files**: `src/guided/timeline.ts`, `src/guided/engine.ts`, `src/guided/voice.ts`, `src/guided/haptics.ts`, `src/guided/controller.ts`, `src/guided/adherence.ts`, `src/ui/guided-overlay.ts`, `src/utils/wake-lock.ts`
**Tests**: `src/guided/*.test.ts` (65 tests), `src/utils/wake-lock.test.ts` (11 tests) — ✅ Passing

After a guided run, a "Pace adherence" summary card in the completion modal shows how many splits landed on pace (±5 sec/km), how many were fast or slow, and the average deviation in seconds.

**Keep screen on**: A Screen Wake Lock is acquired while guided mode is active so the browser does not throttle the 1s tick interval when the phone auto-locks. Toggled in Account → Preferences ("Keep screen on", default on; disabled with a "Not supported on this browser" sub-label when the API is missing, e.g. Safari pre-16.4). Web-only interim until the Capacitor shell gains `@capacitor-community/keep-awake`.

---

### 21. Split Detection
**What it does**: Reads the workout description to build a split scheme — e.g. "8×400m @ 5K pace" becomes 8 target splits of 400m each. The GPS tracker uses this to tell you when you've completed each rep and whether you're on pace. `buildSplitScheme` is a thin adapter over `buildTimeline` so the voice coach and on-screen splits can never disagree about what the workout contains.

**Key file**: `src/gps/split-scheme.ts` (derives from `src/guided/timeline.ts`)
**Tests**: `src/gps/split-scheme.test.ts` — ✅ Passing

---

### 22. Recording Persistence
**What it does**: Saves completed GPS recordings to local storage so you can review past runs. Includes the route, split times, pace, and HR data. Manages an index of recordings so old ones can be retrieved.

**Key file**: `src/gps/persistence.ts`
**Tests**: `src/gps/persistence.test.ts` — ✅ Passing

---

### 23. Record Tab — Live Run UI
**What it does**: The Record tab is the purpose-built live running screen. Any "Track Run" button (plan workout cards, Just Run, Record tab Start Run) arms GPS acquisition and navigates to this tab.

**Acquisition gate first (2026-06-15)**: before the live UI, the tab shows a pre-run gate while GPS locks — "Acquiring GPS" (amber pulse + live accuracy) flipping to "GPS ready" (green) with a "Start run" button. The real-time UI begins only after the user confirms (or "Start anyway"). The gate is rendered when `isArming()` is true, which is checked *before* the tracking branch because an armed tracker reports `acquiring` (counts as "active"). Leaving the tab mid-acquisition calls `cancelTracking()` to drop the watch. Once tracking, the UI updates every second without full re-renders.

Two layouts based on workout type:
- **Simple** (easy / long / unstructured / Just-Track): large elapsed time, 2×2 grid with distance, current pace, avg pace. **Lap + Pause + Stop** buttons. The Lap button (added 2026-05-28, no scheme active only) calls `GpsTracker.captureLap()` to push a free-form `Lap N` split at the current position, fires a 60ms haptic for tactile confirmation, and patches a "Last lap: m:ss · meters" readout above the control row. Lap reset segment counters so successive laps measure only their own ground.
- **Structured** (intervals / threshold / progressive): segment flow strip showing ✓ completed, ● current segment with km remaining + target pace, · upcoming. Elapsed, distance, and pace row below. Pause + Stop. **No Lap button** — splits are scheme-driven and a manual lap would conflict with the segment-advance contract.

Navigation away from the Record tab (via tab bar) deregisters the tick handler so there are no stale DOM updates.

**Key files**: `src/ui/record-view.ts`, `src/ui/gps-events.ts`, `src/gps/tracker.ts` (`captureLap`)
**Tests**: `src/gps/tracker.test.ts` includes 7 `captureLap` tests (null-paths, distance/elapsed/pace, sequential numbering, segment-counter reset, listener notification). Record-view UI itself: no tests.

---

## Data & Sync

---

### Account & Authentication

**What it does**: Mosaic uses Supabase Auth. New users are silently signed in via `supabase.auth.signInAnonymously()` on first launch — no auth wall during onboarding. Users can upgrade to a real email/password account later from a Home banner or the Account view.

**Anonymous-user data risk**: An anonymous Supabase session is tied to the device's `localStorage`. Uninstalling, switching phones, or clearing app data wipes the user — and with them all linked rows in `garmin_tokens`, `daily_metrics`, `sleep_summaries`, `garmin_activities`. There's no email to recover from.

**Guest-account upgrade prompt**: `s.isGuestAccount` is refreshed on every `launchApp()` from `supabase.auth.getUser().is_anonymous`.
- **Home banner** (`buildGuestAccountBanner` in `home-view.ts`): one-time, dismissible. Fires only when the user is a guest AND has at least one completed activity in the live plan. Dismiss flag (`s.guestBannerDismissed`) persists.
- **Account view section** (`renderGuestAccountSection` in `account-view.ts`): persistent. Visible whenever the user is a guest, regardless of dismiss state.
- Both CTAs route to `renderAuthView({ upgradeGuest: true })`.

**Auth view (`auth-view.ts`)** in upgrade mode:
- Defaults to sign-up; submits via `supabase.auth.updateUser({ email, password })` which converts the anonymous user **in place** — same `auth.users.id`, all data preserved. (`signUp()` would create a new user_id and orphan the guest data.)
- Sign-in tab shows a yellow warning that signing into an existing account leaves guest data behind.
- "Not now" cancel returns to Home without changing auth state.

**Remembered email (ISSUE-283, 2026-06-05)**: the last email that successfully signed in / signed up is stored in `localStorage` (`mosaic_last_email`, survives sign-out and state wipes) and prefilled into the email field, so a logged-out user only retypes their password. The plain auth view defaults to Sign in when a remembered email exists. The typed email also survives toggle/error re-renders (module-level `emailDraft`).

**"Already registered" auto-switch (2026-06-05)**: a sign-up (or guest save-account) attempt with an email that already has an account no longer dead-ends on the raw Supabase error. Detection is `error.code === 'email_exists' | 'user_already_exists'` or an "already registered" message match; the form switches to Sign in, keeps the email, focuses the password field, and shows "This email already has an account. Enter your password to sign in." In guest-upgrade mode the amber warning's "choose Sign up instead" advice would be wrong for that email, so it is suppressed (`emailExistsSwitch` flag) and the notice carries the guest-data caveat instead.

**Session-refresh resilience (ISSUE-283, 2026-06-05)**: token-refresh failures are classified via `isAuthRetryableFetchError` in both `getValidSession()` (`supabaseClient.ts`) and the boot path (`main.ts`). Network-shaped failures (offline, DNS, 5xx — routine on iOS resume) keep the session untouched and let the SDK auto-refresh retry. A genuinely invalid refresh token on a **real** account signs out locally (`scope:'local'`, other devices unaffected) to the sign-in screen with the email prefilled. The sign-out + `signInAnonymously()` fallback now fires only for anonymous sessions — a real account is never silently downgraded to a guest (the old behaviour, which also tripped the SIGNED_IN owner-mismatch `clearState()`).

**Save-account overlay at data connect (ISSUE-270, 2026-06-04)** (`src/ui/wizard/save-account-overlay.ts`): shown once per onboarding the moment a data source connects — Strava/Garmin OAuth return on connect-data, or the Continue tap for Apple Health / file-upload users. Same in-place `updateUser` upgrade; skippable ("Later", `onboarding.accountSaveOffered` flag); no-data skippers never see it. Closes the common fork case: a user with an email can recover their account on any device.

**Strava fork guard + history claim (ISSUE-270, 2026-06-04)**: `strava-auth-callback` counts activities held by other non-deleted accounts with the same `strava_athlete_id` and appends `existing=N` to the OAuth redirect. The client then reunites the history via the `strava-claim-history` edge function (`src/data/strava-claim.ts`): silently mid-wizard (benchmarks see the full record), via a confirm overlay on the main view (`src/ui/history-claim-overlay.ts`). Ownership proof is server-side (the caller's own token row, which only exists via completed OAuth); the move rewrites `garmin_activities.user_id` (collision-free — `garmin_id` is globally unique) and retires the old token rows so the refresh cron stops keeping forks alive.

**Test status**: ✅ — typecheck + suite green (3173); edge functions deployed 2026-06-04 (claim-history verify_jwt true, callback false); save-account + fork-guard flows NOT device-verified.

---

### 23. Wearable Activity Sync & Review (Garmin + Apple Watch + Strava)
**What it does**: On startup, syncs recent workouts and matches them to the current week's planned workouts. Matched activities are auto-completed with a derived RPE, then the user is prompted with an RPE slider (1-10) to rate how hard each matched run felt. The slider defaults to the auto-derived RPE; dismissing keeps the auto value. Overflow activities surface for manual plan adjustment.

**Data source strategy** — two separate concerns:
- **Activity source** (what happened): Strava if connected, otherwise Garmin webhook or Apple Watch
- **Biometric source** (physiology — VO2max, LT, HRV, sleep, resting HR): always the wearable (Garmin or Apple Watch), independent of Strava. Source routing uses `connectedSources` state field with accessor functions in `src/data/sources.ts`.

**Strava path** (`s.stravaConnected`): `syncStravaActivities()` → `sync-strava-activities` Edge Function. Fetches activity list + full HR streams; computes iTRIMP. Activity IDs namespaced as `"strava-{id}"`. Garmin users who also have Strava use this path for activities AND get a Garmin physiology sync in parallel. Apple Watch users who have Strava get Strava for activities AND HealthKit for physiology in parallel.

**Garmin-only path** (`!s.stravaConnected`, physiology source `'garmin'`): `syncActivities()` → `sync-activities` Edge Function (28-day lookback). Activities arrive via Garmin Health API webhook → Supabase `garmin_activities` table.

**Apple Watch activity path** ✅: `syncAppleHealth()` → `@capgo/capacitor-health` → `Health.queryWorkouts()` on-device (iOS native only; no-op on web). Workout IDs namespaced as `"apple-…"` to prevent dedup collisions. **First connection runs a 52-week HR-enriched backfill** (`appleHistoryFetched` flag-gated; subsequent launches use a 14-day incremental window). After the standard backfill, `syncAppleHealthDeepHistory()` runs once per install to walk HealthKit back in 1-year chunks to a 5-year cap (no HR enrichment — metadata only for PB surfacing), guarded by `appleDeepHistoryFetched`. Per-workout HR-stream enrichment (`Health.readSamples({ dataType: 'heartRate' })` inside each workout's window) computes `avg_hr`, `max_hr`, iTRIMP, and zone seconds — concurrency capped at 4, sample limit 6000. maxHR resolves via `s.maxHR > Tanaka(208 − 0.7×age) > null`; the write side (all three pipes — Apple, Strava, Garmin edge fn) feeds the canonical corroborated-max estimator (`src/calculations/max-hr-estimator.ts`, SCIENCE_LOG §BQ: highest session max witnessed within 5 bpm on a different day, ≥150/<230 gates, up-only ratchet — 2026-06-04, replaced the per-pipe p95 / raw-max mix). Weekly aggregation mirrors `fetchStravaHistory`: writes `historicWeeklyTSS`, `historicWeeklyRawTSS`, `historicWeeklyKm`, `historicWeeklyZones`, `ctlBaseline`, `signalBBaseline`, `detectedWeeklyKm`, and `athleteTier` so the plan engine, ACWR baseline, and athlete tier all work for an Apple-only user. Heavy backfill is **deferred to the review wizard step** so it runs after the user's age has been entered in about-you (otherwise iTRIMP integration has no maxHR fallback). Plugin limitations not addressable: no GPS polyline, no per-km splits, no `best_efforts` for PB auto-fill (manual entry path used instead).

**Apple Watch live sync** ✅: `subscribeToWorkoutObserver()` → `HealthExtras.startWorkoutObserver()` registers an `HKObserverQuery` for `HKWorkoutType` and calls `enableBackgroundDelivery(.workoutType, .immediate)`. When any app (Apple Watch, Strava-to-Health, Garmin Connect-to-Health, Nike Run Club, etc.) writes an HKWorkout to HealthKit, iOS wakes Mosaic (even when force-quit). The Swift handler uses an `HKAnchoredObjectQuery` against a persisted `HKQueryAnchor` (in `UserDefaults`) to fetch only the new samples, then emits a `workoutDidArrive` event. JS subscriber debounces 5s and triggers `syncAppleHealth()` — workout is matched and the plan adapts before the user opens the app. Requires `com.apple.developer.healthkit.background-delivery` entitlement.

**Apple Watch physiology path** ✅: `syncAppleHealthPhysiology()` → `@capgo/capacitor-health` → `Health.readSamples()` for sleep stages, HRV (SDNN), resting HR, steps. Converts to `PhysiologyDayEntry[]` and stores in `s.physiologyHistory`. Sleep score computed from stage breakdown (duration 55%, deep 25%, REM 20%). Runs on launch for Apple Watch users (both Apple-only and Strava+Apple Watch).

**Apple Health as a supplementary physiology source** ✅ (2026-05-27): a Garmin user can additionally connect Apple Health so it gap-fills any night Garmin missed, without losing Garmin's native sleep score. `connectAppleHealth()` sets the device-local `s.appleHealthConnected` flag and only claims the labelled primary if nothing else holds it, so connecting never demotes Garmin. On launch `syncAllPhysiology()` (`main.ts`) runs Garmin first then Apple last (both merge per-day/per-field since 2026-06-05: Garmin overwrites only the fields it has data for, Apple prefers existing Garmin values — so a short-window sync can no longer truncate the 28-day history). Post-onboarding entry point: Account → Connected Apps → Apple Health row (iOS-only, mirrors the Strava-enrich row); triggers the HealthKit permission sheet and shows a Settings-path hint if the user denies the sleep/HR scopes. Garmin gives a validated sleep score; Apple's is reconstructed from stage durations, so Garmin stays primary by design.

**Week filtering**: Only activities within the current plan week (`planStartDate + (w-1)*7` to `+7`) are presented. Cross-week bleed from re-syncs is suppressed.

**Choice persistence**: Integrate/Log choices are saved to `wk.garminReviewChoices` on every toggle. Re-opening the review (after refresh or re-review) restores previous choices automatically.

**Auto-process (≤2 activities, all same-day)**: Silently slot-matches each activity; shows an assignment toast at the bottom summarising what went where. Overflow items are added to `wk.unspentLoadItems` and the suggestion modal fires. On modal dismiss, the Excess Load Card lets the user adjust the plan later.

**Review flow (≥3 activities or any >24h old)**: routes through `openActivityReReview` (2026-06-04) — already-matched recordings are reconstituted into the tray pre-assigned to their slots and their slots un-rated, so the Matching Screen always shows the whole week's plan slots, not just the new items. Cancel restores the pre-review snapshot.

**Matching Screen** (`src/ui/matching-screen.ts`): tap-to-assign full-screen UI.
- Slot cards ordered Mon→Sun; show actual date ("Mon 23 Feb"). Week header shows "Week 4 of 10 · Mon 17 – Sun 23 Feb".
- Activity tray sorted runs → gym → cross/other. Only unassigned integrate items shown; log-only hidden.
- Assigned activities vanish from tray; tapping an occupied slot swaps the old activity back into the tray.
- Bucket contents (Excess Load, Log Only) shown as chips. Tap × to return an activity to the tray.
- Confirm returns confirmed matchings + bucket items to `applyReview`.

**Tri/cycling completion reconcile** ✅ (2026-06-04, `reconcileTriCompletions` in `src/calculations/activity-matcher.triathlon.ts`): canonical pass at launch and after every review apply. Slot-keyed actuals direct-bind to their slot; user decisions (Excess Load / Log Only) are never overridden by the launch fuzzy matcher; stale links cleared; **completed slots shift to the weekday the session actually happened**; missing `startTime` backfilled; orphaned adhoc twins dropped. Tests: `activity-matcher.triathlon.test.ts` — ✅ Passing.

**Excess Load Card** (`src/ui/excess-load-card.ts`): amber card on the Training tab when total week Signal B exceeds `computePlannedSignalB()` by 15–40 TSS (Tier 2). Detection is from the full week picture — whether activities matched plan slots or not is irrelevant. Shows TSS over target and [Adjust Plan] / [Dismiss] buttons. "Adjust Plan" triggers reduce/replace modal using total excess × weightedRunSpec × recoveryMultiplier. Tier 1 (≤15 TSS): auto-suppressed. Tier 3 (>40 TSS): blocking modal fires instead.

**UnspentLoadItem** (`src/types/state.ts`): `garminId`, `displayName`, `sport`, `durationMin`, `aerobic`, `anaerobic`, `date`, `reason`.

**Foreground-resume physiology refresh** ✅ (2026-06-05): the full physiology sync historically ran only at cold launch — fine on web (every page load is a cold launch), invisible-staleness on iOS where the WKWebView stays alive for days. The `visibilitychange` handler (`main.ts`) now refreshes the Garmin branch fully on each resume (throttled 5 min): `syncTodaySteps()` + `syncPhysiologySnapshot(7)` + normalizer refresh + `refreshRecentSleepScores()` when today's sleep is still missing + sleep-poller restart. The sleep poller (`src/data/sleepPoller.ts`) is restartable — its guard is "poll currently running", not "ever started" — because iOS suspends `setInterval` when backgrounded. Apple branch already re-synced on resume.

**Garmin token refresh**: `isGarminConnected()` checks `expires_at` from `garmin_tokens`. If expired, calls `refreshGarminToken()` → `garmin-refresh-token` edge function → Garmin OAuth2 refresh_token flow. Account page shows "Connected · Last sync: [date]" when healthy, "Token expired" when refresh fails. Webhook handlers (`handleDailies`, `handleSleeps`) log successful upserts.

**Key files**: `src/data/activitySync.ts`, `src/data/stravaSync.ts`, `src/data/supabaseClient.ts`, `src/calculations/activity-matcher.ts`, `src/ui/activity-review.ts`, `src/ui/matching-screen.ts`, `src/ui/excess-load-card.ts`, `src/ui/toast.ts`, `supabase/functions/garmin-refresh-token/index.ts`
**Tests**: `src/calculations/activity-matcher.test.ts` — ✅ Passing

---

### 23a. Single-file FIT / GPX / TCX Activity Import (STRAVALESS_PLAN.md §4)

**What it does**: User exports a run or ride from Garmin Connect (or any device) as a FIT, GPX, or TCX file and imports it via Account > Advanced > "Import activity file". The file is parsed in-browser and flows through the exact same enrichment pipeline as Apple Health and Strava activities.

**What it produces**: A fully enriched `GarminActivityRow` — iTRIMP, HR zones, polyline, km splits, best-efforts (for PB extraction), average/max watts, normalised power, mean-max power curve for cycling FTP estimation. The row is passed to `matchAndAutoComplete()` and assigned to plan slots like any other synced activity.

**Parser coverage**:
- **FIT** (binary): `fit-file-parser` npm package decodes records. Session message provides sport type, distance, and HR summary. Semicircle position fields converted to decimal degrees.
- **GPX** (XML): pure-regex extractor, no DOMParser, works in Node + browser. Handles `<gpxtpx:hr>`, `<ns3:hr>`, `<hr>`, `<power>`, `<ns3:Watts>` namespace variants. Distance computed via haversine chain.
- **TCX** (XML): same regex approach. Handles `<HeartRateBpm><Value>`, cumulative `<DistanceMeters>`, `<ns3:Watts>` power extension, `<Position>` lat/lng. Sport from `<Activity Sport="...">` attribute.

**Enrichment shared module**: `src/data/activityEnrichment.ts` — canonical implementations of `computeHREnrichment`, `computePowerStats`, `computeNPAndPowerCurve`, `resolveMaxHR`. Both `fitImport.ts` and the future Garmin activityDetails parser (item A) must import from here so there is one implementation of these computations in the codebase.

**ID prefix**: `import-` — distinct from `apple-`, `strava-`, `garmin-` so dedup keys never collide.

**UI**: Two entry points, both via the shared `openImportActivityModal()` (`src/ui/import-activity-modal.ts`): Account > Advanced ("Import activity file"), and the onboarding data-source step ("Upload your runs", added 2026-05-28). The modal's `<input>` accepts `.fit,.gpx,.tcx,.zip` — a `.zip` routes to `importActivityArchive()` (full Strava/Garmin export) with live "Reading archive… 12/340" progress; a single file routes to `importActivityFile()`. On success the status line and a toast show the summary. No navigation away; view stays in place. An optional `onComplete` callback lets onboarding reveal Continue and surface the guest-sync nudge after an import.

**Onboarding wiring (2026-05-28, restructured + same-day refinement)**: the data-source step (`connect-data.ts`, renamed from `connect-strava.ts`) is now a watch-first router with two picker tiles. Headline: "Show us where you're at" / "Mosaic learns from your training history. The more we see, the sharper your plan and race predictions get." Phase 1 shows two tiles — **Apple Watch** ("Sleep, HRV, resting HR, and runs sync through Apple Health. One tap.") and **Garmin or other** ("Garmin doesn't yet let us pull this automatically. Upload an export and we'll pull in your runs and heart rate."). Why-we-ask caption below the picker: "Heart rate calibrates your load. Sleep and HRV calibrate your recovery. Apple Health is the only path that delivers both automatically right now." The earlier 3-tile picker (Apple / Garmin / Other) was collapsed to 2 because Garmin and Other routed to the same screen — only Apple Health delivers physiology automatically, so it stands alone. Picking Apple Watch immediately calls `connectAppleHealth()` on iOS; on web it shows a strong iOS-install push with an inline "upload an export here" fallback. Picking Other reveals Phase 2 — a "Build your training history" panel with three uniform upload options (Strava .zip primary, Garmin .zip secondary, single .fit/.gpx/.tcx tertiary) all wired to `openImportActivityModal()`. **Continue is always visible at the bottom** with state-dependent styling: pre-action it's a muted underlined text link (demoted from a bordered pill on 2026-05-29 — it's a skip, not a CTA, so it now follows the "no colour on nav links" rule and stops competing with the two import tiles) with the caption "Your plan will start from PBs only. Less accurate, but you can add data anytime from Account."; post-action (after an upload or HealthKit connect) it morphs into the dark primary CTA with no caption. Coros and Polar were dropped from the second tile's label (2026-05-29) — we have no Coros/Polar-specific import path and can't ingest their sleep/HRV, so naming them over-promised; "or other" still covers them via single-file upload without implying a smooth path. The "Enter manually" link was removed — users read it as a downgrade; the same path is now Continue-without-uploading with an explicit consequence caption. `onboarding.chosenWatch` persists as `'apple' | 'other'` (legacy `'garmin'` is collapsed at render). Strava OAuth and Garmin OAuth remain deliberately absent because both APIs are dev-only at our current approval tier (Strava 1-user cap, Garmin single approved account); Strava OAuth still works for whitelisted accounts via Account view.

**Garmin panel → real Apple Health connect + deliberate skip (2026-06-02)**: while direct Garmin sync is gated off (`GARMIN_CONNECT_ENABLED: false`), the Garmin (Phase 2) panel previously showed a passive text card telling the user to navigate back and pick Apple Health themselves. It now shows a real **"Connect Apple Health"** button (`#cd-connect-apple-health`), mirroring the gated "Connect Garmin" card structure. One tap: on iOS it calls `triggerAppleHealth()` (HealthKit permission prompt); on web it surfaces an inline note ("Apple Health only connects in the Mosaic iPhone app … or upload an export below") since HealthKit can't run in a browser and the upload card is right below. The handler keeps `chosenWatch:'other'` so re-entry returns the user to this hub (to add Strava) rather than the Apple picker tile. Rationale: Garmin sleep/HRV/resting-HR flow through Apple Health on iPhone, so for Garmin users Apple Health is the recovery pipe — it should be one tap from the Garmin tile, not a back-navigation instruction. This holds across all five modes (every mode routes through `connect-data`). The panel subhead frames the two cards as complementary ("Two sources, both worth connecting: Apple Health for recovery, Strava for your runs and PBs") so a Garmin user connects both; the framing is flag-aware (drops the Apple Health line when `GARMIN_CONNECT_ENABLED` is on and the recovery card becomes "Connect Garmin"). **Connect-both, return-and-nudge**: after connecting one source the panel marks it done and nudges the other instead of treating the step as finished. `refreshHistoryConnectedState()` is the single owner of the cards' connected state — Apple Health connected swaps its button for "Apple Health connected. Recovery signals will sync. Add Strava below…"; Strava connected hides the code input/connect button (and the manual "Or upload your history" card `#cd-upload-card`, redundant once the live connection carries the full history) for "Strava connected. Runs and PBs are syncing. Add Apple Health above…" (the cross-nudge drops once both connect; the Apple-Health nudge only shows while `GARMIN_CONNECT_ENABLED` is off). Continue goes ready as soon as either lands. The **Strava OAuth return (`?strava=connected`) no longer auto-advances on iPhone** when Apple Health is still unconnected — it falls through to re-render the panel (Strava done, Apple Health nudged) so recovery can be added before moving on. It still auto-advances when nothing more is addable: on web (HealthKit unavailable), when Apple Health is already connected, or under `GARMIN_CONNECT_ENABLED` (Garmin direct gives runs + recovery in one). `markAppleHealthConnected()` routes the confirmation to the card's done line in the hub, or the global status line on the picker tile, depending on which phase is visible. **Apple Watch users are pushed through cleanly, not nudged for Strava**: a native Apple Watch user goes Apple tile → connect → **auto-advance** (2026-06-15). Once HealthKit connects there is nothing else to add on this step, so `markAppleHealthConnected()` (picker-tile branch) now mirrors the Strava/Garmin OAuth-return contract — it morphs Continue to the dark CTA, sets `skippedStrava:false`, then calls `maybeOfferAccountSave(() => nextStep())` to progress onwards immediately rather than leaving the user to hunt for the faint "Continue →" link (the old behaviour stranded Apple Watch users on the picker after a successful connect; Tristan, device report). The morph still fires first so the "Apple Health connected. Runs, heart rate, and recovery now sync automatically." status is visible behind the account-save overlay for anonymous users; non-anonymous sessions advance straight through. The hub branch (Garmin "connect both") is unchanged — it stays to nudge Strava, mirroring the Strava-return hold. The Back-into-step re-entry path (`renderConnectData`, `initialChoice==='apple'`) still calls `markContinueReady` directly, not `markAppleHealthConnected`, so backing into a step with Apple already connected does not bounce the user forward. Strava is deliberately not surfaced to them because HealthKit already carries the full picture for native Apple Watch workouts (GPS route → per-km splits, HR, sleep/HRV/resting HR, 5 yr history, PBs from run history); the Strava pairing exists only for Garmin users, whose Apple Health bridge drops the GPS route (`activityEnrichment.ts:277-280`). Strava stays reachable for the rare Apple-Watch-plus-old-Strava-history user only if they deliberately tap the Garmin tile. **Continue now requires a deliberate second tap to skip with no data source**: the first tap on the pre-state "Continue without uploading" arms the skip (`skipArmed`), rewrites the button to "Continue without data" and the caption to state the cost ("Without a watch connection or upload, the plan and predictions run on personal bests alone…"); the second tap proceeds. Connected/uploaded users (`hasData`) still advance on the first tap. The arm resets on re-render and on backing out to the picker (`resetContinueToPre`).

**No-watch row added to the picker (2026-06-15)**: the picker is now three tiles. A third row — **"No watch yet"** ("Connect Strava for your runs and PBs, or upload a .fit, .gpx, or .zip export. No watch needed.") — sits below Apple Watch and Garmin. It carries `data-watch="other"`, so it routes to the same Phase 2 "Build your training history" hub (Strava connect + file upload) as the Garmin tile, and is wired automatically by the existing `.cd-watch` handler. Rationale (Tristan): a watchless user can seed their whole history from Strava or an export, so they should not be stopped at the picker and routed straight to manual PB entry. Previously the upload hub was reachable only by tapping "Garmin", which a no-watch user had no reason to do — they hit "Continue without data" and skipped the upload offer entirely.

**Reuse targets**: The `streamsToActivityRow()` function in `fitImport.ts` is the canonical mapping layer. Item A (Garmin activityDetails JSON parser) and item D (Strava archive ZIP) should produce `{ summary, records }` and call it directly.

**Key files**: `src/data/fitImport.ts`, `src/data/activityEnrichment.ts`, `src/ui/import-activity-modal.ts`, `src/ui/account-view.ts`, `src/ui/wizard/steps/connect-data.ts`
**Tests**: `src/data/fitImport.test.ts` — ✅ 28/28 passing (mapFitSport, GPX parse, TCX parse, streamsToActivityRow mapping)

---

### 23c. Per-activity file enrichment + guided Strava history (2026-06-09)

**Why**: HealthKit is the universal iOS pipe (any watch syncing to Apple Health, no partner approval), but a Garmin watch arrives **thin** through Apple Health — average HR + duration only; HR zones, splits, route and iTRIMP drop at the boundary (`activityEnrichment.ts`). Strava is capped at 10 athletes so there's no live enrichment pipe for most users.

**Add detail from Strava (per-activity, in place)**: on a thin activity's detail page (`activity-detail.ts`) a muted "Add detail from Strava" action appears when the activity is not Strava-sourced and lacks HR zones / route / splits, and `STRAVA_ENRICH_UPLOAD_ENABLED` is on. The user uploads that activity's original file (Strava "Export Original" .fit — Export GPX strips HR) and the rich fields merge into the **existing** record. No duplicate: `garminId` provenance is preserved, so a later live Strava row still wins via the Strava-upgrade path in `activity-matcher.ts`.
- **Merge logic** (`src/data/activity-enrich-merge.ts`, pure): `enrichActualFromParsedRow(actual, row, {force?})` validates the file matches the activity using the same window as the Strava upgrade (±10 min start, ±15% duration), then fills only the fields the actual is missing (iTRIMP, HR zones, km splits, polyline, elevation, power block, reps), returning a patch + `added[]` summary. Rejects with `time-mismatch` / `duration-mismatch` (forceable after a confirm) or `no-new-data`.
- **Orchestrator** (`enrichActualFromFile` in `fitImport.ts`): parse → `streamsToActivityRow` → merge → `Object.assign` onto the live actual → `applyPBsFromRows` + `refreshBlendedFitness` (mirrors `importActivityFile`). Load self-corrects: TSS derives from `iTrimp` on read (`computeWeekRawTSS`, activity-detail `actualTSS`), so the canonical week load updates with no rescale; the non-canonical `wk.actualTSS` running total is left untouched on purpose to avoid a two-numbers divergence.
- **State**: new optional `GarminActual.enrichedFromFile` flips the detail caption to "… · enriched", hides the action once done, AND guards the matcher's re-enrich loop (`activity-matcher.ts:932`) so the next Apple Health sync — which re-delivers the same thin `apple-` row — cannot overwrite the stream-computed `iTrimp` with a crude avg-HR estimate. `hrZones`/`polyline`/`kmSplits` were already null-guarded; `iTrimp` was the one vulnerable field. Match guard requires start within ±10 min AND duration within ±15% (a timezone-less GPX timestamp that parses hours off therefore rejects and prompts an "enrich anyway?" confirm rather than silently matching the wrong session).

**Guided Strava history** (`src/ui/strava-history-guide.ts`): a linear three-step overlay (request export → wait for the emailed link → upload the .zip) that deep-links to Strava's archive page and funnels the zip into the existing `importActivityArchive`. Replaces the generic modal for the Strava-history path; reachable from onboarding ("Upload Strava .zip" in `connect-data.ts`) and Account → Strava History → "Import history from file".

**Garmin → Apple Health walkthrough** (`src/ui/garmin-apple-health-guide.ts`): simple instructions-only overlay (3 steps: Garmin Connect → More/Settings/Apple Health → enable + share activities/HR/sleep; COROS/Polar note). Opened from a "How do I enable this for Garmin?" link in the connect step's Apple Health card, so a Garmin user who never enabled the Apple Health write doesn't silently sync nothing.

**Deferred (phase 2)**: native iOS Share Sheet ("Open in Mosaic") — needs `@capacitor/app` + `CFBundleDocumentTypes` + a native rebuild; the existing file picker already reaches Files/iCloud.

**Key files**: `src/data/activity-enrich-merge.ts`, `src/data/fitImport.ts`, `src/ui/activity-detail.ts`, `src/ui/strava-history-guide.ts`, `src/constants/feature-flags.ts`
**Tests**: `src/data/activity-enrich-merge.test.ts` (12 pure: match window incl. start-AND-duration, NaN-reject, field-fill, purity, provenance preserved, no-overwrite, force, no-new-data, power block) + `src/data/activity-enrich.integration.test.ts` (3: real GPX→`streamsToActivityRow`→merge field alignment; `matchAndAutoComplete` re-enrich guard preserves enriched iTRIMP; control proves the loop would otherwise overwrite it). ✅ All green; full build (lint:ui + tsc + vite) clean.

---

### 23b. Screenshot Activity Import (hybrid OCR → AI vision + optional HR chart)
**What it does**: User screenshots a run summary from any activity app (Strava, Garmin Connect, Nike Run Club, Apple Fitness, Coros, etc.) and Mosaic reads the numbers off it. Distance, time, average pace, average / max HR, and per-km splits feed the same import pipeline as a FIT file (match + PBs + fitness refresh), minus the GPS track and per-second streams. An optional **second screenshot of the HR-over-time chart** adds per-minute HR — sampled by Claude vision and run through the same `computeHREnrichment` helper file imports use, so the run lands with real iTRIMP + HR zones rather than the coarse avgHR-only estimate.

**Two-engine summary pipeline** — the verified parser core is `src/data/screenshotImport.ts` (`parseScreenshotText`, `parsedFromAIJson`, `parsedHrSeriesFromAIJson`, `screenshotActivityToRow`, `commitScreenshotActivity`). It is fed by two engines that converge on the same `ParsedScreenshotActivity` contract:
1. **On-device Apple Vision OCR** (`ios-plugins/screenshot-ocr` Swift plugin, JS bridge `src/data/screenshotOcr.ts`). iOS-only, free, private. `VNRecognizeTextRequest` at `.accurate` with `usesLanguageCorrection` off. Observations are grouped into visual rows so splits-table cells reconstruct into parseable lines.
2. **Cloud AI vision fallback** (`supabase/functions/screenshot-vision`, Claude `haiku-4-5` vision). Fires when OCR confidence is low, fields are missing, or there is no on-device engine (web). Returns the `ParsedScreenshotActivity` JSON shape. Hardened the same way as the coach edge functions: JWT auth, per-user daily cap (25/day, `screenshot_vision_usage` table + RPC), global $10/day spend cap (shared `llm_spend_tracker`), 2 MB payload cap, media_type allowlist (jpeg / png / webp / gif), restricted CORS, 20s timeout.

**HR-chart mode** — the edge function gained a `mode: 'summary' | 'hr_chart'` field. The `hr_chart` system prompt asks Claude to read the HR-over-time chart's time + HR axes, sample the curve at roughly minute intervals, and return `{ hrSeries: [{tSec, hr}] }`. Output token budget bumped to 1500 (a 2-hour run can emit 120 points). The result feeds `screenshotActivityToRow` via an optional `ScreenshotEnrichmentContext` (resting HR / max HR / zones / sex from state), which runs the canonical `computeHREnrichment` — same helper used by FIT imports. Net effect: screenshot-sourced runs now compute load math at the same fidelity as file imports, just without the route map.

**Hybrid orchestration**: `src/data/screenshotCapture.ts` runs OCR first; if `decideNeedsAI(parsed)` (confidence < high), it calls the AI fallback. `pickBetterParse` chooses the result with fewer missing fields, then higher confidence, then more splits — ties go to AI. Engines are injected so the orchestration is unit-testable without a device or a network. Cost-conscious: the AI call is skipped entirely when on-device OCR is sufficient; the client downscales screenshots to ~1280 px JPEG @ q=0.6 before sending so even degraded calls land in the cents-per-call range.

**UI**: `openScreenshotImportModal()` (`src/ui/screenshot-import-modal.ts`) — three-step glass overlay modelled on `openImportActivityModal`. Step 1: image picker + two how-to collapsibles. Step 2: "Reading the screenshot…" while the hybrid runs. Step 3: confirm/edit screen showing the read-back summary (distance · time · pace · avg HR) plus editable fields (date, distance in km/mi per `unitPref`, duration mm:ss, avg HR). The confirm step also exposes an **optional "Add HR chart for per-minute detail" panel** with its own image picker — selecting a chart screenshot triggers the `hr_chart` edge-function call; the sampled series is stored in `activeHrSeries` and folded into the parsed activity at commit. Splits, max HR, and any avgPace the parser derived ride along unchanged. On confirm, runs `commitScreenshotActivity` and fires the optional `onComplete` callback (used by onboarding to reveal Continue + the guest-sync nudge).

**Entry points**: Account > Advanced ("Add from screenshot", `#btn-import-screenshot`). The onboarding screenshot CTA was removed on 2026-05-28 when the data-source step was restructured around a 3-option watch picker — screenshot import is still available post-onboarding via Account.

**Limitations** — surfaced honestly on the modal: a screenshot carries no GPS track and no second-by-second HR/pace data, so the route map and detailed traces will not appear for the imported run. The HR-chart sample is approximate (Claude reads a chart visually, not at sensor fidelity), but iTRIMP integration is robust to small per-point error. The cloud reader requires a signed-in account (auth gate on the edge function); guests on web fall through to a blank confirm form they can fill manually.

**Manual deploy steps**: (a) Xcode — `npx cap sync ios` then archive to pull in the new `MosaicScreenshotOCR` plugin. (b) Supabase — `supabase migration up` to apply `20260528000001_screenshot_vision_usage.sql`, then `supabase functions deploy screenshot-vision`.

**Key files**: `src/data/screenshotImport.ts` (verified core, built 2026-05-27), `src/data/screenshotCapture.ts` (hybrid orchestration), `src/data/screenshotOcr.ts` (JS bridge), `ios-plugins/screenshot-ocr/` (native plugin), `supabase/functions/screenshot-vision/index.ts` (AI fallback), `supabase/migrations/20260528000001_screenshot_vision_usage.sql`, `src/ui/screenshot-import-modal.ts`, `src/ui/account-view.ts`
**Tests**: `src/data/screenshotImport.test.ts` — ✅ 21/21 passing (parser core + 4 `parsedHrSeriesFromAIJson` coercion tests + 3 `screenshotActivityToRow` enrichment-path tests covering hrSeries → computeHREnrichment, no-context fallback, too-short-series fallback); `src/data/screenshotCapture.test.ts` — ✅ 11/11 passing (decideNeedsAI, pickBetterParse, runHybridParse — high-conf skip / poor-OCR AI promotion / AI-fail retains OCR / empty-OCR web path / downscaled-image plumbing)

---

### 24. Strava Integration + iTRIMP Training Load
**What it does**: Connects Strava to fetch second-by-second HR data for all activities. Computes iTRIMP (Individual TRIMP) using the Banister/Morton Heart Rate Reserve model, which is far more accurate than a single average HR for variable-intensity activities (padel, cycling, rugby, etc.). When Strava is connected it becomes the **primary activity source** for all users — including those who also have a Garmin wearable.

**Single mode** (`s.stravaConnected`): activities + full HR streams sync directly into the standard matching pipeline. Garmin/Apple wearable continues providing biometrics (VO2max, LT, HRV, sleep) in parallel via `syncPhysiologySnapshot()`.

**iTRIMP formula** (`src/calculations/trimp.ts`):
- Three fallback tiers: HR stream (1-sec) → lap avgHR → summary avgHR
- β = 1.92 (male/unknown) | 1.67 (female) — set in onboarding physiology step and Account tab

**iTRIMP plumbing** (end-to-end):
- `GarminActivityRow.iTrimp` → `GarminPendingItem.iTrimp` → `CrossActivity.iTrimp` → `computeUniversalLoad({ iTrimp })` → Tier A+
- `buildCombinedActivity()` in activity-review.ts sums iTRIMP across all pending items before passing to load calculator
- `crossActivityToInput()` in universal-load-types.ts maps `activity.iTrimp` through to the `ActivityInput`
- `biological_sex` passed to `sync-strava-activities` edge function so iTRIMP uses the correct β

**Onboarding (physiology step)**: Gender selector (Male / Female / Prefer not to say) at the top — labelled "Gender", stored as `onboarding.biologicalSex` / `s.biologicalSex`. All users (regardless of device) see a "Connect Strava (optional)" section after the HR fields — shows connected badge or Connect button. Strava is presented here rather than on the device step because it is an app, not a device.

**Account tab**: Strava card with Connect / Disconnect / Sync HR buttons. "Biological sex" selector (male / female / prefer not to say) for β coefficient selection. "Change" button next to Runner Type label → `showRunnerTypeModal()` bottom-sheet picker (Speed/Balanced/Endurance with descriptions; confirms before rebuilding plan when training is already underway; shows spinner overlay during rebuild via `initializeSimulator()`).

**Key files**: `src/calculations/trimp.ts`, `src/data/stravaSync.ts`, `supabase/functions/strava-auth-start/`, `supabase/functions/strava-auth-callback/`, `supabase/functions/sync-strava-activities/`
**Tests**: `src/calculations/trimp.test.ts` — ✅ Passing (20 tests)

---

### 24. Continuous Mode
**What it does**: For runners who aren't training toward a specific race. Instead of a fixed plan ending on race day, the app cycles through repeating 4-week blocks (base → build → intensify → deload). Optional benchmark check-ins at the start of each new block (post-deload, when freshest) measure progress.

**Key files**: `src/workouts/plan_engine.ts` (block cycling), `src/state/initialization.ts`
**Tests**: `src/ui/continuous-mode.test.ts` — ✅ Passing

**Benchmark check-in UI** (in `src/ui/benchmark-overlay.ts`): Centered overlay shown on post-deload weeks (week 5, 9, 13, ...). Selecting a check-in type generates a structured workout via `intentToWorkout` (same as session generator) and adds it to the week's plan. Four states in the plan-view card: prompt (open overlay), workout added (awaiting completion), recorded (from watch), skipped. No manual entry — results come from watch/Strava data after the workout is completed.

---

### 25. State Persistence
**What it does**: Saves and restores the entire app state (your plan, ratings, injury history, settings) to the device's local storage. Includes schema migrations so old saved states upgrade cleanly when the app updates.

**Supabase backup**: Every `saveState()` call also fires a background upsert to `user_plan_settings` (Supabase). On login, if localStorage is empty (wipe, reinstall, new device), the app silently restores from this backup before rendering — no user action required. Large re-fetchable arrays (`historicWeeklyTSS`, `physiologyHistory`, etc.) are excluded from the snapshot and rebuilt from Strava/Garmin on first sync.

**Key files**: `src/state/persistence.ts`, `src/data/planSettingsSync.ts`
**Tests**: `src/state/persistence.test.ts` — ✅ Passing

---

### 26. Missed Week Detection + Week-End Debrief (3-Step Flow)
**What it does**: On app open after a missed week, `detectMissedWeeks()` silently applies VDOT detraining and advances the plan pointer (no modal). At week end, a 3-step debrief flow fires (once per week, guarded by `lastDebriefWeek`):

**Step 1 — Week Summary**:
- Phase badge + "Week N complete"
- Training load % vs planned, distance km, Running Fitness delta (CTL direction)
- Coach signal pills (Effort, Load, Fitness, HR drift) + coach narrative copy
- CTA: "Generate next week" (complete mode) or "Continue" (review mode)

**Step 2 — Analysis Animation** (~2.5s):
- Progress bar fills across the modal top
- Stepped checklist ticks through: HR data, pace vs HR targets, RPE feedback, training load, recovery signals, plan generation
- Transitions to Step 3 on completion

**Step 3 — Suggested Plan**:
- Shows next week's generated sessions with type badges (Easy, Long, Tempo, VO2, MP)
- "Adjustments applied" card listing what changed: effort scaling, ACWR-driven quality reduction, long run capping, volume changes
- Toggle between "Adjusted plan" (with effort/ACWR context) and "Standard plan" (vanilla)
- **Behind-plan headline** (2026-06-09, SCIENCE_LOG §BR): when the athlete logged materially less than the plan prescribed last week, the old "tracking to plan" line is replaced with a factual, no-judgement headline — *"{pct}% of last week's planned training completed. Next week scales to your recent load."* This replaces the previous behaviour where a zero-training week still reported "tracking to plan" (the headline measured whether the *engine* adjusted, not whether the *athlete* kept up).
- Accept button proceeds to uncompleted session handling, then advances the week

Three trigger paths: user taps "Wrap up week" in the plan page, auto-trigger on Sunday, or auto-trigger on app open after week advance.

**CTL-gap re-anchor (2026-06-09, running mode, SCIENCE_LOG §BR)**: next week's prescribed volume now tracks the chronic load the athlete *actually carried*, not just how hard the sessions they did were rated. After each week, a one-step expected-vs-actual CTL ratio (`ctlAdherenceRatio` in `fitness-model.ts`) is stored on the upcoming week as `Week.ctlRatio` (mirror of `scheduledAcwrStatus`, set in `events.next()`), and `plan_engine.ctlGapMultiplier` scales the week's durations down in proportion when behind. Reduce-only and one-sided, so it never double-counts with the effort multiplier (intensity of sessions done), ACWR (acute-load spikes), or VDOT detraining (multi-week gaps, guarded by `Week.detrainApplied`); the combined effort + CTL effect is clamped to the effort band, floored at the ability deload, and suppressed on deload weeks. Single source for the engine signal and the debrief copy: `resolveCtlAdherence` (`planned-day-tss.ts`). **Mirrored to all planned modes (2026-06-09)**: HYROX uses a single `mtlRatio` (`resolveMtlAdherence` in `mtl.ts`, scales `effectiveHours` in `plan_engine.hyrox`) — engine-only, no copy surface yet (HYROX has no week-debrief). Triathlon uses **per-discipline** `ctlRatioByDiscipline` (`resolveTriDisciplineAdherence` in `fitness-model.triathlon.ts`, scales per-discipline durations in `applyTriEffortMultipliers`) so skipping swims re-anchors swim without touching the bike; the tri plan-preview debrief shows a per-discipline behind-plan headline. All three modes share the pure `ctlAdherenceRatio`, are reduce-only, and mutually exclusive by `eventType` in `events.next()`. Tests: `ctl-gap-mirror.test.ts` (8).

**Key files**: `src/ui/week-debrief.ts`, `src/ui/welcome-back.ts` (state logic + `detrainApplied` guard), `src/main.ts`, `src/workouts/plan_engine.ts` (plan generation + `effortMultiplier` + `ctlGapMultiplier`), `src/calculations/fitness-model.ts` (`ctlAdherenceRatio`), `src/ui/planned-day-tss.ts` (`resolveCtlAdherence`)
**Tests**: ⚠️ Debrief UI untested; CTL-gap engine covered by `src/workouts/ctl-gap.test.ts` (14 tests)

**Triathlon variant** (`src/ui/triathlon/tri-week-debrief.ts`): mirrors the 3-step flow for triathlon mode. Step 1 shows total training hours (vs planned), training load (TSS), tri fitness (CTL/7), and per-discipline rows (Swim/Bike/Run) styled as signal rows showing session completion and effort signal (power/pace/HR adherence). Step 2 is the same analysis animation. Step 3 shows the next week's stored `triWorkouts` sorted by day with discipline badges and effort-multiplier adjustment notes. Guards with same `lastDebriefWeek` field. Fires from `fireDebriefIfReady` → `fireTriDebriefIfReady`. Off-by-one bug in `runTriActivityMatching` (fixed 2026-05-04): used `s.w` (1-based) as 0-based index, so matching never wrote `status='completed'` on triWorkouts; debrief now also falls back to discipline-counting from `garminActuals`.
**Tests**: ✅ 3 passing (`tri-week-debrief.test.ts`)

---

### 27. Training Load (TL) + Performance Management Chart (PMC)
**What it does**: Computes Signal A (run-equivalent) and Signal B (raw physiological) TSS per week. Displays CTL/ATL/TSB (fitness/fatigue/form) in the Stats tab. CTL = Signal A (42-day EMA of run-equiv load); ATL = Signal B (7-day EMA of total load including cross-training at full weight). ACWR = Signal B ATL / Signal A CTL — correctly flags cross-training-heavy weeks.

**Three-signal model**:
- **Signal A** (`computeWeekTSS`): run-equivalent TSS with runSpec discount. Used for CTL, replace/reduce decisions, race prediction.
- **Signal B** (`computeWeekRawTSS`): raw physiological TSS, no runSpec discount. Used for ATL, ACWR injury risk, "This Week" load card.
- **Signal C** (`wk.actualImpactLoad`): musculoskeletal impact. Computed, not yet surfaced in UI.

**Stats Tab** (redesigned 2026-03-19 — three-pillar architecture: Progress · Fitness · Readiness):

**Opening screen** — five stacked sections, each card taps into a single-scroll detail page (no tabs inside detail pages):
- **Progress card**: Race mode → horizontal arc/timeline (plan start → race day) + forecast finish badge + on-track pill. General fitness mode → tier progress bar showing % to next tier (Building/Foundation/Trained/Well-Trained/Performance/Elite based on CTL daily-equivalent)
- **VO2max card** (✅, 2026-05-01, updated 2026-05-06): Cross-modal headline VO2max + per-source breakdown — Running, Cycling, Cardiac ceiling (all sports), and **Cross-training** (sustained-HR aerobic capacity from non-run, non-bike sport — Swain `%VO2R ≈ %HRR` × cardiac ceiling × duration credit, ≥ 20 min sessions, hidden until 3 qualifying sessions). Cross-training is additive, never lifts running/cycling, never claims headline. Headline = highest demonstrated across modalities. Cardiac ceiling captures *peak* cross-sport contribution; cross-training captures *sustained* aerobic capacity. Source toggle on Account view (Mosaic / Device). Taps into VO2max detail page with explainer + literature context. See `src/calculations/vo2-orchestrator.ts`, `src/calculations/cross-training-vo2.ts`, `src/ui/vo2max-card.ts`, `docs/SCIENCE_LOG.md → "Cross-Training VO2max"`.
- **Fitness card**: Compact VO2 Max sparkline + current value (device when available, VDOT fallback labelled "est.") + tier label; taps into Fitness detail
- **Readiness card**: Single Freshness scale bar (gradient zones) with properly positioned floating marker at actual TSB value; taps into Readiness detail
- **Summary** (flat, no tap-through): Race predictions (Marathon/Half/10K/5K from `vt()`) in race mode; Training paces (Easy/MP/Threshold/VO2max from `fp()`) in both modes

**Progress detail page** (single scroll):
- Phase Timeline bar (colour-coded Base/Build/Peak/Taper bands, dot at current week)
- Training Load line chart (Signal B TSS, 8w/16w/all toggle)
- Running Distance line chart (same toggle)
- CTL line chart (Signal A 42-day running fitness, same toggle)

**Fitness detail page** (single scroll):
- Scale bars: Running Fitness (CTL daily-equiv), VO2 Max (device preferred, VDOT fallback), Lactate Threshold — all with ⓘ info buttons
- VO2 Max trend line chart (8w/16w/all toggle)
- Race forecast detail, Forecast times, Training paces

**Readiness detail page** (single scroll):
- Scale bars (Training Load section): Freshness (TSB), Short-Term Load (ATL), Load Safety (ACWR), Fitness Momentum
- Freshness trend line chart with zone bands (8w/16w/all toggle)
- Recovery & Physiology (expanded — no accordion): Recovery Score bar, Sleep sparkline, HRV sparkline, RHR sparkline

**Scale bar marker fix**: marker is a `left: pct%` positioned vertical bar inside position:relative container. ⓘ info icon is next to the row title, not on the bar.

**Key functions**:
- `src/ui/stats-view.ts` — `buildProgressCard_Opening()`, `buildFitnessCard_Opening()`, `buildReadinessCard_Opening()`, `buildSummarySection()`, `buildProgressDetailPage()`, `buildFitnessDetailPage()`, `buildReadinessDetailPage()`

**Plan view**: Completed week headers show a muted `XX TSS` badge (Signal A).

**TL per session**:
- Runs (garminActuals): raw iTRIMP → TL (no runSpec) — same for both signals
- Cross-training (adhocWorkouts / unspentLoadItems): Signal A applies `runSpec`; Signal B uses full iTRIMP weight

**Impact Load**: km-based for running (intensity factor: easy=1.0, threshold=1.3, VO2=1.5); duration × `impactPerMin` for cross-training. Stored on `wk.actualImpactLoad` (not yet surfaced).

**Key files**:
- `src/calculations/fitness-model.ts` — `computeWeekTSS()` (Signal A), `computeWeekRawTSS()` (Signal B), `computeFitnessModel()`, `FitnessMetrics`
- `src/constants/sports.ts` — `TL_PER_MIN`, `IMPACT_PER_KM`, `SPORTS_DB` (strength runSpec=0.35)
- `src/ui/stats-view.ts` — `buildLoadHistoryChart()`, `buildRunningFitnessChart()`, `buildProgressCard()`, `buildRecoveryCard()`, `buildMoreDetailSection()`
- `src/calculations/activity-matcher.ts` — accumulates `wk.actualTL` and `wk.actualImpactLoad`
- `src/ui/activity-review.ts` — stores cross-training TL after user approves adjustments

**Tests**: ⚠️ No automated tests yet

---

### 28. ACWR Load Safety (Phase B)
**What it does**: Computes the Acute:Chronic Workload Ratio (ATL ÷ CTL) from weekly TSS history. Shows a colour-coded bar in the Training tab ("Load Safety" row inside "This Week" panel) and a "Reduce this week" button when risk is elevated. Automatically lightens the next week's plan when ACWR is caution or high.

**ACWR bar (Training tab)**:
- Green when ratio ≤ safe upper bound (varies by athlete tier)
- Amber when caution (0–0.2 above safe upper)
- Red when high (>0.2 above safe upper)
- Dashed marker at the tier's safe threshold
- Status text: "Load well-managed (1.1× baseline)" / "Load increasing quickly" / "Load spike detected"
- `[?]` button opens an ACWR info sheet

**Reduce this week button** (caution/high only):
- Opens the suggestion modal with an ACWR context header explaining the spike
- If `unspentLoadItems` exist, builds popup from those; otherwise synthesises from excess TSS
- Context header is collapsible ("See details ▾") and shows zone breakdown

**Plan lightening** (plan_engine.ts):
- `caution`: `maxQuality -= 1` — one quality session becomes easy
- `high`: `maxQuality -= 2` AND long run capped at previous week's distance
- A `weekAdjustmentReason` string is set on intents → surfaced as a banner above workouts

**Athlete tier** (for ACWR safe threshold):
- 5 tiers: beginner (1.2×), recreational (1.3×), trained (1.4×), performance (1.5×), high_volume (1.6×)
- `s.athleteTier` set automatically (currently defaulting to 'recreational'; Phase C will detect from Strava history)
- `s.athleteTierOverride` takes precedence and shows "Manually set" badge on stats page

**Stats page PMC section**: expanded with ACWR ratio (prominent number), colour-coded status, ratio bar, 3-metric grid (CTL/ATL/TSB), athlete tier badge.

**Key files**:
- `src/calculations/fitness-model.ts` — `computeACWR()`, `TIER_ACWR_CONFIG`, `AthleteACWR`, synthetic ATL debt for `acwrOverridden`
- `src/ui/main-view.ts` — `updateACWRBar()`, `updateLightenedWeekBanner()`, `triggerACWRReduction()`, `updateCarryBanner()`, `computeConsecutiveOverrides()`
- `src/ui/suggestion-modal.ts` — `ACWRModalContext`, `CrossTrainingModalContext`, `showSuggestionModal()` (4th+5th param)
- `src/workouts/plan_engine.ts` — `PlanContext.acwrStatus`, quality cap reduction
- `src/workouts/generator.ts` — `generateWeekWorkouts()` effortScore + acwrStatus params (wired from all call sites)
- `src/calculations/fitness-model.ts` — `getTrailingEffortScore()` shared helper (trailing RPE from last 2 weeks)
- `src/ui/renderer.ts`, `home-view.ts`, `plan-view.ts`, `events.ts`, `main-view.ts`, `activity-review.ts`, `recording-handler.ts`, `timing-check.ts` — all pass effortScore + acwrStatus to `generateWeekWorkouts`
- `src/ui/events.ts` — zone carry tracking + `weekAdjustmentReason` on week-advance
- `src/types/state.ts` — `Week.carriedTSS`, `Week.acwrOverridden`, `SimulatorState.athleteTier/athleteTierOverride`
- `src/types/activities.ts` — `SportConfig.volumeTransfer`, `SportConfig.intermittent`
- `src/constants/sports.ts` — `volumeTransfer` values for all sports

**Phase B v2 additions (2026-02-26)**:
- `acwrStatus` now wired into renderer — quality sessions reduced when ACWR is elevated
- "Reduce this week" triggers at actual TSS > plan × 1.20 even when ACWR is safe
- "Dismiss" button records `acwrOverridden`; "Keep" in modal also records it
- Escalating risk label (Safe/Moderate/High/VeryHigh/Extreme) based on ACWR + override streak
- Synthetic ATL debt (15%) for overridden weeks — ACWR stays elevated even after load drops
- Zone carry banner (collapsible, CTL-decay weighted) above workouts when prior-week excess > 8 TSS
- TSS bar splits running (blue) + cross-training (purple) with CTL baseline marker
- Running Volume bar shows running km + GPS cross-training km (weighted by `volumeTransfer`)
- `volumeTransfer` and `intermittent` fields added to all sports in `SPORTS_DB`

**Phase B v3 — HR Zone Matching for Replacement Decisions (backend complete 2026-02-27)**:
- `classifyWorkoutType()` wired into `buildCrossTrainingPopup()` — every activity is now classified before candidate scoring
- Zone-profile match now adjusts candidate similarity scores (see Feature #18 above)
- `AthleteContext.intensityThresholds?` added — populated from `s.intensityThresholds` (calibrated via `calibrateIntensityThresholds()` in `stravaSync.ts`)
- UI portion (modal header showing sport info, speed, match quality, km impact) is pending the UX redesign agent — see `docs/specs/LOAD_SYSTEM_SPEC.md §6.5` for the spec and `§12.7` for wiring instructions

**How to test Phase B v3**: Run `npx vitest run src/cross-training/universalLoad.test.ts` — 15 classifier tests at the bottom of the file cover all three classifier functions and the decision tree. For the end-to-end matching, trigger a cross-training popup and read the `[CrossTraining]` console lines.

**Tests**: ⚠️ Phase B/B v2 UI — no automated tests. Phase B v3 classifier — ✅ 15 tests passing (`src/cross-training/universalLoad.test.ts`)

---

### 29. Training Readiness Ring
**What it does**: Composite 0–100 score on the Home page answering "Should I do today's planned workout as-is?" One ring gauge, one label, one sentence. Replaces the old `buildSignalBars()` + `buildSparkline()` on the Home tab.

**Tri mode**: In triathlon mode the card branches at `buildReadinessRing` to use `computeTriReadiness(s)` (`src/calculations/tri-readiness.ts`) instead of the running composite. The ring shows the worst-discipline `ReadinessResult` (score + label + drivingSignal). The bottom sentence blends the worst-discipline note with systemic HRV / sleep-debt context (HRV drop ≥20% or sleep debt ≥2h above personal baseline appends or leads). Disciplines only appear in bars and sentence when `directCount > 0 AND ctl >= 1` — single decayed ghost activities are excluded. Sleep, Strain, and Physiology sub-rings are unchanged (sport-agnostic). Running mode is bit-for-bit unchanged.

**Discipline Readiness card** (`readiness-view.ts`, tri mode): per-discipline bars (swim/bike/run) plus a cross-training bar when `crossTrainingAtl > 0`. Cross-training readiness uses `crossTrainingCtl` (42d EMA of non-swim/bike/run activity TSS, tracked in `estimateDirectPerDisciplineCTLFromActivities`) and `crossTrainingAtl` (7d EMA), both stored in `triConfig.fitness` on launch. All bars are capped at the overall ring label — no bar can show a better label than the ring, preventing "Clear" bars alongside an "Ease Back" ring. Cross-training is only blamed in the coaching sentence when its own ACWR is Manage Load or worse (prevents normal consistent-sport volume from being called a problem). Card tap navigates to rolling-load-view.

**Cross-training Load card** (all non-tri modes): shown in Readiness detail when non-run activities in `garminActuals` produce `atl > 0`. ATL/CTL computed inline from `garminActuals` using `classifyActivity` and the same 7d/42d decay. Bar label capped at the overall ring label.

**Four sub-signals**:
- **Freshness** (35% / 40% without recovery) — TSB. Ranges from Overtrained → Peaked.
- **Load Safety** (30% / 35%) — ACWR. Safe / Moderate Risk / High Risk.
- **Momentum** (15% / 25%) — CTL now vs 4 weeks ago. Rising / Stable / Dropping.
- **Recovery** (20%, greyed out if no watch) — composite of HRV (50%), Last Night Sleep (25%), Sleep History 7d avg (25%). All sleep inputs z-scored against 28-day personal baseline internally; display shows raw Garmin/Apple scores. RHR acts as override only (cap when elevated >= 2 SD).

**Safety floors** (hard caps applied last, regardless of other signals):
- ACWR > 1.5 → score ≤ 39 (Ease Back); ACWR 1.3–1.5 → score ≤ 59 (Manage Load)
- Sleep < 45 → score ≤ 59; Sleep < 60 → score ≤ 74
- **Leg load >= 20** → score ≤ 54 (Manage Load — moderate eccentric/impact damage)
- **Leg load >= 60** → score ≤ 34 (Ease Back — heavy EIMD, 72-96h recovery window)
- **Strength sessions** contribute to leg load when the user taps the **Legs** chip on the activity-detail page (`none/moderate/heavy`). Moderate ≈ crossfit tier (0.15 load/min); heavy ≈ rowing tier (0.35 load/min) with a 1.20× half-life multiplier so a heavy squat day decays slower than the strength baseline. Untagged strength contributes 0 — the user is opt-in. Same surface lets the user tap an RPE chip to replace the (under-counting) HR-based strength TSS with a `durationMin × TL_PER_MIN[rpe] × runSpec` estimate. See `docs/SCIENCE_LOG.md §AG`.

**Continuous penalties** (no step-jumps — score reflects degree, not threshold crossings):
- **Strain 50–100%** → floor descends linearly 100→54 (approaching target)
- **Strain 100–180%** → floor continues linearly 54→10 (no jump at 100% or 130%)
- **Capacity strain anchor (2026-06-03)**: the floor's strain % anchors on `max(plannedDayTSS, weeklyCTL ÷ 7)` — overreached only when today exceeds BOTH the plan and sustainable daily load. Stops the score cratering on physiologically normal days with small plans (injury-capped, taper, easy). Guards: on unplanned days a real logged session must exist (passive step TSS alone never triggers it); weekly CTL ≥ 10. Tri weekly CTL includes `crossTrainingCtl`. Deliberate side effect: completing a sub-CTL/7 planned easy session no longer pins the floor at 54. Canonical module `src/calculations/capacity-strain.ts` (`computeCapacityStrain` + `capacityStrainNote`) — home-view, readiness-view, and daily-coach all read it; hand-rolling a strainPct for `computeReadiness` is forbidden (2026-06-04 incident: Home 61 vs detail page 10). See SCIENCE_LOG §BJ.
- **Sleep debt above personal 30d baseline** → −5 pts/hr excess, max −25 pts (Van Dongen 2003)
- **HRV drop > 15% below 28d avg** → gradient −(drop−15%)×100 pts, max −25 pts (Plews 2013)

**Today's Strain Score** (ring label renamed from "Strain"):
- Today's Signal B TSS ÷ day's target TSS × 100.
- Target = today's planned TSS from the canonical **mode-aware** `getPlannedDayTSSContext` (`src/ui/planned-day-tss.ts`, 2026-06-03): running reads `resolveWeekWorkouts` (RPE × TL_PER_MIN × duration per session); tri/cycling reads stored `wk.triWorkouts` aerobic + anaerobic (matches the plan card badge); HYROX uses duration × TL_PER_MIN[rpe]; just-track has no plan target. On rest days (planned sessions = 0), target is 0 — no baseline fallback applied. The same context feeds the Strain detail page, Readiness card, and daily-coach, so all surfaces agree with the Plan tab. ✅ tested (`planned-day-tss.test.ts`)
- Rest day: ring shows "Rest day" in grey; if any activity logged, shows "X TSS logged" sub-label. No % on rest days.
- 100% = you've completed what was planned. > 100% = went beyond plan. < 100% = session in progress.
- Colours: grey (rest/0%) → amber (partial) → green (on target) → red (exceeded).
- **Ring fill scale (2026-06-04)**: `target.hi` = full ring on BOTH the Home mini ring and the Strain detail ring ("Target reached" closes the ring, Apple-rings convention). Overshoot clamps at full; colour alone carries it — green up to `hi × 1.3` ("Above target"), red beyond ("Load exceeded"); both surfaces share the 1.3× tolerance band. No-target days (just-track / no plan) fall back to auto-scale (actual × 1.1 detail / × 1.25 home) so the arc stays partial.
- **Strain ring is tappable** → opens `src/ui/strain-view.ts` (full-screen detail page).

**Strain detail page** (`src/ui/strain-view.ts`) — answers "What did I do today and how hard was it?":
- Animated SVG ring (1.4s cubic-bezier). Rest days show "Rest day" with grey ring.
- **State-coloured background (2026-06-04)**: atmosphere + flowey waves follow the day's state — coral while working toward target, mint once target reached (lo to hi × 1.3), red beyond the band or on rest-day overreach. The `'red'` palette lives in `page-flair.ts` alongside the others. Background tracks the selected date (full re-render on date switch).
- 7-day week position bars: one row per day (Mon–Sun) of the current plan week. Each row shows day label, horizontal bar with actual TSS filled against planned TSS track, today highlighted in orange, future days show ghost track only.
- Activity timeline for the selected date (from `garminActuals`); tapping a row opens a detail overlay (duration, HR, TSS, kCal).
- Steps placeholder card: "Daily steps / — / Garmin steps coming soon".
- Date picker: tapping the header date reveals a scrollable row of the last 7 days.
- Info (`?`) button opens a strain explainer overlay (Signal B, thresholds table).
- Back button returns to Home. No tab bar on this page (iPhone sub-page pattern).

**Sentence logic (tri mode)**: tri mode bypasses `coach.primaryMessage` and shows the per-discipline `computeTriReadiness` sentence — except after a completed session. Priority: (1) **injury-cap overshoot** — injury active and actual > planned × 1.3 → `injuryCapOvershootSentence` ("42 TSS logged against an injury-capped day of 20. Load is within your normal range, but well above the rehab cap."; sterner variant when capacity is also exceeded). (2) `postSessionSentence()` (shared with running's Tier 1, `daily-coach.ts`): "Big session today (X TSS)…" at 130%+ of the capacity anchor, "Solid session today (X TSS)…" at 100%+, and — when the anchor is CTL-dominated — "Good training today (X TSS), most of a typical day's load." at 80%+. (3) **Trained-day acknowledgment (2026-06-04)**: any day with a real logged session (`loggedSessionToday`, passive steps excluded) below the tiers leads with the factual load before the chronic sentence: "42 TSS logged today. Bike load is elevated relative to your baseline." — the commentary never looks unphased on a trained day. Composed by `capacityStrainNote(cs, fallback)`; both Home and the Readiness detail page pass their chronic sentence as the fallback. Running mode's Tier-0 injury branch mirrors the overshoot call-out. Restored + extended 2026-06-03 — the original tri override ("Trained hard today.") was lost in the May crash; `isPostSessionState` had survived as dead code.

**Sentence logic**: A single `primaryMessage` from `computeDailyCoach()` replaces the old separate readiness sentence + HRV banner. Priority chain: injury/illness blockers → strain complete/exceeded → **leg-load hard floor (surfaces `readiness.legLoadNote`)** → ACWR spike → combined sleep + HRV → poor sleep → deep HRV drop → sleep debt → ACWR caution → moderate sleep/HRV → recovery driving signal → recent cross-training → session in progress → taper phase → HRV elevated → positive conditions (fresh/safe/good recovery with workout-aware copy) → CTL trend → week RPE → TSB/ACWR matrix fallback. Every tier produces workout-aware copy (references today's planned session name, hard vs easy). Hard-floor signals (leg-load, ACWR) are routed by `readiness.hardFloor` *before* sleep-debt copy, so the message always explains whatever is actually capping the score.

**Score → label**: 80–100 Ready to Push (green) · 60–79 On Track (blue) · 40–59 Manage Load (amber) · 0–39 Ease Back (red). When ACWR > 1.5 hard floor is active, label overrides to **Overreaching** (red).

**Home layout (triangle)**: Readiness ring top-centre (120px, larger), Sleep + Strain rings side by side below (100px each). Tapping Readiness ring opens `readiness-view.ts`. Tapping Sleep opens `sleep-view.ts`. Tapping Strain opens `strain-view.ts`. The Freshness/Load Ratio/Recovery pill row has been moved off the home page into `readiness-view.ts`.

**Drill-down affordance (added 2026-05-27)**: the whole readiness box carries a muted `›` chevron top-right and is itself tappable, landing on the Readiness detail page. The Sleep / Strain / Physiology sub-rings keep their own destinations (they `stopPropagation`); the box-level handler bails on the sub-rings, the Adjust button, and `#manual-sleep-card` so logging sleep never navigates away. The affordance mirrors the canonical drill-down chevron at `stats-view.ts:467`.

**Adjust button**: Shown below the sentence when readiness ≤ 59 **and** the click handler has something to do. For most driving signals: ACWR caution/high, unspent cross-training load, or at least one unrated run anywhere in the remaining week (the future-week check is needed because plan-engine moves can slide a hard session into today). For `legLoad` specifically: the remaining-run check tightens to an unrated *hard* session (`isHardWorkout(w.t)`) so the button only shows when there's a real impact target to defer or downgrade — otherwise "Protect the legs" has nothing to act on. Hidden when no target. Text varies by driving signal (Adjust plan / Reduce session load / Take it lighter today / Protect the legs / Keep consistency).

**Coach advisory note**: rendered on the **Plan today-row only** when `coach.workoutMod === 'downgrade'` or `'skip'`. Strict advisory copy — no claim that a change has been made to the plan, since the workout description is unchanged. `'downgrade'` → *"Go easier today."* + `coach.primaryMessage`; `'skip'` → *"Consider rest today."* + `coach.primaryMessage`. The Home today card no longer renders any note (removed 2026-06-03): the readiness-ring card directly below it already carries the full `primaryMessage` as its sentence plus a driving-signal CTA, so even the lead clause was double messaging — and it rendered as a detached floating pill between the two cards.

**Readiness detail page** (`src/ui/readiness-view.ts`): Opens from the Readiness ring. Sky-gradient design (same as recovery-view). Shows composite ring at top (animated, dynamic colour), readiness sentence, driving factor callout (when a hard floor is active, including a leg-fatigue callout linking to the detail page when `hardFloor === 'legLoad'`), and sub-signal cards: Freshness (TSB daily-equivalent + zone + "to baseline" hours pill using stacked session recovery), Load Ratio (ACWR ratio + status + acute/chronic TSS breakdown, highlighted when driving), Recovery (score/100 + explanation + "View detail" link to recovery-view). Back button returns to home. **Drill-down affordance (added 2026-05-27)**: the `card()` builder takes a `drillable = true` flag — every navigable card (Strain, Freshness, Leg Fatigue, Load Ratio, Physiology, Sleep History) renders a muted `›` chevron top-right; the display-only Cross-Training Load card passes `drillable = false` (no chevron, no `cursor:pointer`).

**Leg Fatigue** (card on Rolling Load, detail page): The mechanical/localised load signal, distinct from cardiovascular TSS. Cap and soft taper applied directly in `computeReadiness()`: `>= 60` → cap 34 (Ease Back), `>= 20` → cap 54 (Manage Load), linear soft taper across 10–20 so the threshold isn't a cliff. Always-visible card at the top of Rolling Load shows current decayed total, status (Fresh / Light / Moderate / Heavy), and a one-line interpretation. Tap opens the detail page.

**Running included in Leg Fatigue (added 2026-04-25)**: Runs now contribute to leg load via `distanceKm × effortMultiplier(rpe)` (RPE-tier multiplier reused from `IMPACT_PER_KM`). RPE comes from the logged `wk.rated[id]` if available, else HR-derived Karvonen mapping — handles bonked runs correctly. RBE discount is suppressed for hard runs (RPE ≥ 7) since maximal-effort EIMD is novel stress. Backfill runs through `reconcileRecentLegLoads()` on launch and after activity sync. See `docs/SCIENCE_LOG.md → Running Leg Load` for derivation.

**Leg Fatigue detail page** (`src/ui/leg-load-view.ts`, added 2026-04-15): Opens from the Leg Fatigue card on Rolling Load or from the Readiness callout banner. Bronze sky-gradient palette to distinguish from the other detail pages. Hero ring uses a piecewise mapping (MODERATE = 30%, HEAVY = 70%, extreme 120+ = 100%) so reload beyond HEAVY still reads as worse. Shows a 7-day decay timeline with MODERATE/HEAVY threshold zones and a 4-day forward projection, "floor releases" + "fully fresh" hour projections, a per-session contributors list (raw load, decayed-remaining, half-life, reload penalty), and an explainer of the EIMD-based model with constants and citations. Driven by the `computeLegLoadBreakdown()` helper exported from `readiness.ts`.

**No Jargon Policy**: ATL/CTL/TSB/ACWR never shown in user-facing copy. Info sheets use both: "Running Fitness (CTL)", "Freshness (TSB)", etc.

**Key files**:
- `src/calculations/readiness.ts` — `computeReadiness()`, `readinessColor()`, `drivingSignalLabel()`
- `src/calculations/daily-coach.ts` — `computeDailyCoach()`, `derivePrimaryMessage()` (unified sentence logic)
- `src/calculations/fitness-model.ts` — `computeTodaySignalBTSS()`, `computePlannedDaySignalBTSS()`, `computeDayTargetTSS()`, `computePassiveTSS()`, `calibrateTssPerActiveMinute()`
- `src/ui/home-view.ts` — `buildReadinessRing()`, ring tap handlers
- `src/ui/readiness-view.ts` — Readiness detail page (new)
- `src/ui/leg-load-view.ts` — Leg Fatigue detail page (new 2026-04-15) — decay timeline, contributors, projections
- `src/ui/rolling-load-view.ts` — hosts the permanent Leg Fatigue card
- `src/ui/rolling-load-view.ts` — Rolling Load detail page: 28-day angular chart + 7-day zone bars + zone balance
- `docs/strain.md` — strain design doc + gap register

**Tests**: ✅ 26 tests (`src/calculations/readiness.test.ts`) — all edge cases, safety floor, driving signal, recovery integration, deload/taper scenarios. ⚠️ No tests yet for `computeTodaySignalBTSS` or `computePlannedDaySignalBTSS`.

---

### 31. Sleep Detail View

**What it does**: Full-screen dark-theme sleep detail opened by tapping the sleep sparkline on Home or Stats. Shows last night's quality score, duration, stage breakdown (Deep / REM / Light / Awake), HRV + RHR metric tiles, a consultant-tone insight card, 7-night score trend, and a sleep bank.

**Stage quality labels**: Each stage row shows a quality label (Excellent / Good / Low / Normal / Elevated) derived from population norms:
- Deep (SWS): <13% Low, 13–20% Good, >20% Excellent
- REM: <15% Low, 15–22% Good, >22% Excellent
- Awake: ≤8% Normal, >8% Elevated
- Light: no label (residual stage)

**Stage vs 7-day insight** (`getStageInsight()`): Compares today's REM and Deep percentages to the 7-day rolling average from `physiologyHistory`. Falls back to population norms if < 3 prior nights with stage data. Example output: "REM 11% — below your 18% 7-day average. Central fatigue risk is elevated on quality sessions today."

**Sleep target** (`deriveSleepTarget()`): user-configured `sleepTargetSec` if set, otherwise the median of the last 30 nights, clamped to [7h, 9h]. Floor anchored to Van Dongen 2003; ceiling to NSF/Hirshkowitz 2015. Returns 7h fallback below 5 nights of history. Per-night target adds a load bonus (`+0.25 min/TSS`, tier-capped) on top of the base.

**Sleep Bank** (`getSleepBank()`): 7-night rolling sum of `(actual_sleep − sleep_target)`. Used internally as input to recovery and readiness scoring. Display surfaces use the cumulative debt instead.

**Cumulative sleep debt** (`computeSleepDebt()` / `computeSleepDebtSeries()`): exponential-decay debt with capped surplus credit. 7-day half-life, 0.5 surplus-credit ratio, 60-min/night surplus cap. Headline number on the Sleep page; tier classification (`classifySleepDebt()`) drives the colour gradient through emerald → slate → amber → orange → red.

**Sleep debt outlook** (`computeSleepDebtOutlook()`): turns the static debt number into a trajectory.
- Trend — debt vs 7 series-entries ago (clearing or growing)
- Days-to-clear — forward simulation using last-7-night avg actual sleep, returns days until debt drops into "on track" tier (< 45m), or null if not clearing
- Spike attribution — single nights with shortfall > 2h, contribution decayed via `shortfall × DEBT_DECAY^(days_since)` and capped at total debt
- Personal-norm comparison — 30-day rolling mean of debt series (≥14 entries required); today's debt classified `above`/`below`/`on_par` against this baseline using `max(30 min, 15% of typical)` tolerance. Independent relative colour (amber/emerald/slate) — lets chronic short-sleepers see whether *this* week is worse than *their* week, without conflating with the population-anchored absolute tier.
Surfaces in the cumulative-debt card as two lines under the headline:
1. **Status** (relative-coloured): personal-norm comparison — *"Above your typical 2h 23m — sleep is worse than usual."*
2. **Context** (slate): driver · trend · ETA combined with `·` separators. Driver phrasing adapts to the spike ratio: `> 0.7` reads "mostly from Sun's short night"; `0.3–0.7` quantifies as "1h 30m from 2 short nights"; `< 0.3` drops the driver segment so chronic gap is the story.

**Sleep bank floor on readiness**: Feeds into `computeReadiness()` as `sleepBankSec`. A 3h deficit caps readiness at 74; a 5h deficit caps at 59. Only applied when ≥ 3 nights of data available.

**Key files**:
- `src/calculations/sleep-insights.ts` — `stageQuality()`, `getSleepBank()`, `fmtSleepBank()`, `fmtSleepDebt()`, `deriveSleepTarget()`, `computeSleepDebt()`, `computeSleepDebtSeries()`, `computeSleepDebtOutlook()`, `classifySleepDebt()`, `getStageInsight()`, `buildSleepBankLineChart()`
- `src/ui/home-view.ts` — `showSleepSheet()` (full dark UI)
- `src/calculations/readiness.ts` — `sleepBankSec` floor in `computeReadiness()`

**Tests**: ⚠️ No unit tests for new functions yet.

---

### Coach

**What it does** (reframed 2026-04-24, rules-only): A "Coach" pill in the Home and Plan headers opens the Coach sub-page. The page leads with a stance pill (Ready to Push / On Track / Manage Load / Ease Back) and the single-sentence `primaryMessage` from the rules engine, followed by a "Why this call" card that translates blockers and key signals into short evidence bullets. Below that, stacked cards for Recovery (sleep, HRV, sleep debt), Fitness (CTL + trend, week TSS, 4-week trend), This week (effort + load pills), and Status (injury, illness, check-in). Optional session-drift and sleep-pattern narratives appear when relevant. The daily "How do you feel today?" prompt sits at the bottom. Sky-background palette varies by stance (mint / deepBlue / amber / rose) so the page colour signals state at a glance, matching the Sleep / Recovery / Readiness design language.

**Aggregator**: `computeDailyCoach(state)` gathers TSB/ACWR/sleep/HRV/RPE/week-load/injury/illness into a `CoachState` and derives a `stance` (`push | normal | reduce | rest`), `blockers` array, `primaryMessage`, `sessionNote`, `sleepInsight`, and `workoutMod` (`none | downgrade | skip`, derived from stance). Priority hierarchy: injury / resting illness override everything → ACWR overload → sleep deficit → readiness score. Stance uses the readiness-label vocabulary.

**Tiered illness**: `illnessState.severity === 'resting'` forces stance to `rest`; `'light'` caps stance at `reduce` (drops `push`/`normal` down, leaves `reduce`/`rest` alone). Illness cap is applied before the feeling modifier so a `good` feeling on a light illness day still returns `reduce`.

**Daily feeling modifier**: `s.todayFeeling` (one-tap `struggling | ok | good | great`, stored with today's ISO date, expires at end of day) shifts the base stance. `struggling` drops one level (push → normal → reduce → rest); `good`/`great` promote only `normal → push`, gated on `blockers.length === 0` AND `readiness.score >= 75` (Primed threshold sourced from `readiness.ts`). `ok` is a no-op. Science: athlete self-report is a well-validated fatigue indicator (Saw 2016 meta-analysis). See `docs/SCIENCE_LOG.md`.

**LLM narrative: deferred.** `supabase/functions/coach-narrative/index.ts` remains in the repo as dormant scaffolding (JWT auth, rate limiting, spend cap, field allowlisting already hardened) but is not deployed and not called from the client. The rules layer is the product's moat; the LLM narrative added cosmetic prose only. Next LLM scope, when revisited, is "Ask the coach" (a chatbot that explains plans and recovery), not the narrative paragraph. See `docs/BRAIN.md` for the preserved design reference.

**Key files**:
- `src/calculations/daily-coach.ts` — aggregator + `CoachState` / `CoachSignals` types
- `src/ui/coach-view.ts` — Coach sub-page (stance hero, "Why this call" explanation, stacked signal cards, feeling prompt)
- `supabase/functions/coach-narrative/index.ts` — dormant LLM edge function (do not deploy)

**Tests**: ✅ `src/calculations/daily-coach.test.ts` — 20 cases covering stance → workoutMod mapping, illness tiering (resting/light), daily feeling modifier transitions, and `getTodayFeeling` end-of-day expiry.

---

### Coach workout modifier (today's card)

**What it does**: When today's coach stance is `reduce` or `rest`, a muted bordered note appears on today's workout row on **Plan**. `reduce` shows "Go easier today." + `coach.primaryMessage`; `rest` shows "Consider rest today." + `coach.primaryMessage`. The workout content is not changed — the athlete sees the advisory and chooses whether to act on it. On `normal` or `push` stance the note is omitted. Only renders on today's row; past and future days are unaffected. Suppressed when the session is already rated, skipped, or replaced. **Home no longer renders this note** (removed 2026-06-03): it floated as a detached pill between the today card and the readiness-ring card, and the readiness card already carries `primaryMessage` plus a driving-signal CTA.

**Derivation**: `workoutMod` lives on `CoachState` and is computed inside `computeDailyCoach` from the final stance (`rest → skip`, `reduce → downgrade`, otherwise `none`), matching `docs/BRAIN.md §How it affects the plan`. Reason text comes from `coach.primaryMessage`, which the rules engine already writes as a user-ready sentence.

**Key files**:
- `src/ui/plan-view.ts` — `buildWorkoutCards` appends a bordered sub-row inside today's card

**Tests**: ⚠️ No automated tests

---

## Activity Detail Page

**What it does**: Full-page view for a single synced activity (Garmin or Strava). Shows a stats grid (distance, time, pace, avg HR, max HR, calories), HR zone bars with time breakdown, km splits with pace-coloured bar chart, and an OSM route map (if polyline is available). For cross-training activities, an "Activity" row sits between hero and stats and lets the user reclassify the sport when the auto-classification is wrong (most commonly generic "cardio" activities like kitesurfing, SUP, or sailing). Reclassify triggers a live delta on week load, impact, and leg fatigue, and saves a persistent name mapping so future syncs of same-named activities auto-apply. Accessible from:
- Plan tab → Activity Log rows (plan-matched activities)
- Plan tab → inline actMatchRow on workout cards
- Plan tab → "View full activity →" link in expanded card detail
- Home tab → Recent activity rows (garmin-backed only)

**Key file**: `src/ui/activity-detail.ts`
**Related**: `src/ui/strava-detail.ts` (`drawPolylineOnCanvas` now exported); `src/ui/sport-picker-modal.ts` (picker + `reclassifyActivity` + `resolveSportForActivity` used by sync)
**Tests**: ⚠️ No automated tests

---

## Activity Log (what you actually did, per week)

**What it does**: Shows the user's logged activities for a week — matched plan sessions, unplanned/extra logged activities, excess-load activities, and pending-review items — so the past-week plan page reflects what actually happened. Every surface reads one shared source so an activity can't appear on one screen and vanish on another (the bug that motivated this): `collectWeekActivities(wk)` gathers and dedups the three stores (`garminActuals`, `garmin-*` `adhocWorkouts`, `__pending__` `garminPending`), newest first. Each mode renders that list in its own style:
- **Running**: `buildActivityLog` (`plan-view.ts`) — neutral rows with muted Logged/Excess/Pending status label, tap to open detail. **Past weeks only** (mirrored onto the tri pattern 2026-06-04 — the current week's actuals show inline on the day cards and on Home → Recent, which carries the Review entry point; the old current-week card with its own Review button, pending banner and × unmatch restated the same data three ways).
- **Triathlon / cycling**: `buildCompletedEfforts` (`triathlon/plan-view.ts`) — discipline-coloured completed rows plus appended logged/excess/pending rows. Past weeks.
- **HYROX**: `buildHyroxActivityLog` (`hyrox/plan-view.ts`) — neutral rows with status label. Past weeks.
- **Home**: `buildRecentActivity` (`home-view.ts`) — current + previous week feed (its own gatherer; capped at 8). Shows only what actually happened: planned-but-not-done injected sessions (`adhoc-`/`holiday-`/`benchmark-` ids with no sync timestamp and no rating) are excluded in **all** modes (2026-06-04 — was track-only-gated, so running plan mode leaked generated sessions as undated "This week" rows); they live on the Plan tab instead.

**Key file**: `src/calculations/week-activity-log.ts` (`collectWeekActivities`, `disciplineFromType`)
**Tests**: ✅ `week-activity-log.test.ts` (8 tests — dedup, badges, discipline inference, sort)

---

## Workout Drag-and-Drop (within week)

**What it does**: Workout cards in the Plan tab are draggable. Drag card A onto card B to swap their assigned days for the current week. Day overrides are stored in `wk.workoutMoves` (already typed as `Record<string, number>` on `Week`) and applied when generating the week's workout list. Persists across re-renders; cleared when advancing to a new week.

**Key file**: `src/ui/plan-view.ts` — `wirePlanHandlers` drag-and-drop section; `getPlanHTML` workoutMoves application
**Tests**: ⚠️ No automated tests

---

## Historic Week Editing

**What it does**: Past weeks (before current week) now show an edit button in the header. Tapping a past-week workout card shows Mark Done / Skip buttons so you can retroactively log RPE or mark skips. Watch-synced sessions (Garmin/Strava matched via `garminActuals`) are read-only and display a "Synced from watch/Strava" label instead of action buttons. Activities with a `startTime` are placed in the day column matching when they were actually performed, not the originally planned day.

**Key file**: `src/ui/plan-view.ts` — `buildWorkoutExpandedDetail` (synced guard + past-week actions), `buildWorkoutCards` (effective day placement), `getPlanHTML` (edit button condition)
**Tests**: ⚠️ No automated tests

---

---

## AI Coach v3 (Mosaic-paid, allowlist gated)

> **HIDDEN for App Store v1 (2026-06-02).** Gated off behind `AI_COACH_ENABLED = false` (`src/constants/feature-flags.ts`). All entry points (the Coach hero buttons on running/triathlon/home plans, the Account "AI Coach" section) are buried, and `renderCoachView` hard-gates on the flag. The training-snapshot export is hidden with it. The deterministic daily-coach narration (`computeDailyCoach`) and the free rule-based workout generator are NOT affected and stay live. See `docs/AI_STRATEGY.md` (2026-06-02). The section below describes the feature as it stands behind the flag.

**What it does**: A Haiku-powered coaching surface that reads the *full* training program (every plan week, this-week detail, 4 weeks of activity history, adaptation log, athlete priorities, persistent memory) and streams a 4–6 sentence coaching brief. The coach proposes concrete workout changes via six tools — `swap_workout`, `reduce_workout`, `skip_workout`, `adjust_intensity`, plus `remember` and `forget` for persistent memory. Every tool call renders an Apply card requiring user confirmation. The coach also surfaces proactive insights on the Home view when state-detected triggers fire (HRV crash, marker bump, race week).

**Access (pre-launch)**: Server-side UID allowlist via the `ALLOWED_USER_IDS` env var on the edge function. The client mirrors the allowlist (`src/coach/allowlist.ts`) so the right surface renders on launch without an extra round-trip. Non-allowlisted users see a rules-based brief plus an "AI Coach — coming soon" card. The allowlist is a placeholder for the Stripe `subscription_active` check that will replace it.

**Modes**: Running, triathlon, and HYROX all supported. Tri uses `triConfig` (FTP / CSS / per-discipline CTL). HYROX uses `hyroxConfig` + MTL (musculo-tendon load). Running uses VDOT / LT pace / 8-week TSS. All three modes converge on the same six-tool surface and shared memory.

**Five v3 levers**:

1. **Persistent memory** (`coachMemory.facts[]`, cap 15). The coach calls `remember` when the athlete states a preference / constraint / training history fact. `forget` removes facts. Memory persists across sessions and plan weeks.
2. **Evals harness** (`src/coach/__tests__/eval-scenarios.test.ts`, 25 scenarios). Gated by `RUN_COACH_EVAL=1`; runs against live Haiku and asserts tool calls, refusals, evidence citation, confidence levels. Hard $1 cost ceiling.
3. **Evidence + confidence**. Every claim must cite a number from context. Every assistant turn ends with `<confidence>high|medium|low</confidence>`, rendered as a small dot+label pill below the message.
4. **Priorities weighting** (`coachPriorities`). Two-click flow on first open: priority (Hit the time / Just finish / Stay healthy / Have fun) × constraint (Time / Energy / Injury / None). Coach weights recommendations accordingly.
5. **Proactive insight card** (`coachInsightQueue`). State-driven triggers (HRV crash, FTP bump >=5W, VDOT bump >=1pt, race week T-7) surface a tappable card on Home. Tap → Coach opens with the primer prefilled.

**Security**: JWT auth on every call. Allowlist check before any Anthropic touch. Prompt sanitizer strips injection patterns from user strings. Tool calls validated against plan state before the Apply card renders. System prompt has hard refusal rules for medical/nutrition/technique/equipment/jailbreak. 30 calls/day per-user rate limit; $10/day global spend circuit breaker.

**Key files**:
- `src/coach/allowlist.ts` — client-side UID allowlist (keep in sync with server env)
- `src/coach/prompt-sanitizer.ts` — injection defence
- `src/coach/coach-context-builder.ts` — state serialization for running / tri / hyrox
- `src/coach/coach-tools.ts` — six tool definitions, validation, state mutation, undo
- `src/coach/coach-triggers.ts` — deterministic proactive trigger detector
- `src/coach/coach-chat-client.ts` — streaming SSE client + system prompt builder
- `supabase/functions/coach-chat/index.ts` — Mosaic-paid edge function (Haiku 4.5) with `force_tool_use` support
- `src/ui/coach-view.ts` — AI mode UI: brief stream, chat thread, Apply cards, chip replies, intro overlay, priorities modal, confidence pill
- `src/ui/home-view.ts` — `injectCoachInsightCard()` for proactive Home insight
- `src/ui/triathlon/workout-card.ts` + `src/ui/hyrox/workout-card.ts` — "Coach" badge when `aiModifiedAt` set

**Tests**: ✅ 68 unit tests (`src/coach/__tests__/coach-tools.test.ts`, `coach-triggers.test.ts`, `coach-view-helpers.test.ts`). ✅ 25 live-API eval scenarios (gated). Run unit tests with `npm test`; run live evals with `npm run coach:eval`.

---

## Route Safety Ratings (collection MVP)

Collects anonymous safety scores from runners after each GPS-tracked run, to power a future women's night-running safety map. Data is collection-only — no map UI yet.

**What it does**:
- After finishing a GPS-recorded outdoor run (>= 1km), the completion modal shows an optional safety slider (1–10, default N/A). RPE stays required; safety is skippable.
- Imported Strava/Garmin runs show a subtle "Rate run safety" pill in the top-right of the activity-detail page header. Tap opens the same slider modal; an in-modal info expand explains the community safety map vision before the privacy note.
- Routes are trimmed ~300m from start and end before storage to protect home/work locations.
- Ratings (score, trimmed polyline, bounds, gender of rater, source) land in Supabase `route_safety_ratings`. RLS: user-own rows only.

**Key files**:
- `src/ui/safety-slider.ts` — reusable slider component + standalone modal
- `src/gps/anonymize-route.ts` — `trimRouteEnds()`, `encodePolyline()`, `decodePolylineToLatLng()`
- `src/data/safetyRatingSync.ts` — `submitRouteSafetyRating()`, `hasRatedActivity()`
- `src/ui/gps-completion-modal.ts` — GPS run completion (RPE + safety block)
- `src/ui/activity-detail.ts` — imported run CTA
- `supabase/migrations/20260507000001_route_safety_ratings.sql` — schema + RLS

**Tests**: ✅ `src/gps/anonymize-route.test.ts` — 9 tests covering trim correctness, short-route null-return, edge cases, bounds/center, polyline roundtrip.

**Out of scope (Phase 2)**: map display, heatmap aggregation, retroactive batch rating, edit/delete existing rating.

---

## Top Overscroll Bounce (native on iOS, JS spring on web)

**Key files**: `ios/App/App/BounceViewController.swift` (native), `src/ui/web-overscroll-bounce.ts` (web)

Pulling past the top of any page produces an iOS-style elastic bounce. The two platforms get it from different mechanisms because a JS transform can't replicate native momentum physics — on a bottom-to-top fling the finger is already up and iOS owns the deceleration, which read clunky when faked in JS.

**iOS — real WKWebView rubber-band**: Capacitor hardcodes `webView.scrollView.bounces = false` (`CAPBridgeViewController.swift`, unconditional, no config flag). `BounceViewController` subclasses the bridge VC and re-enables it in `capacitorDidLoad()` (`bounces = true`, `alwaysBounceVertical = true`), giving true UIScrollView momentum + bounce. The scrollView background is set to `--c-bg` (#FAF9F6) so the few px revealed above the page during a top bounce match the off-white page edge; `position:fixed` elements (the tab bar) stay pinned during the rubber-band. Wired into the build via the storyboard `customClass` + four `project.pbxproj` registrations.

**Web — JS spring** (`installWebOverscrollBounce`, no-op on native via `isNative()`): the browser document doesn't rubber-band at the top, so this adds a matching elastic pull.
- Translates only the **in-flow children** of each page wrapper — the fixed tab bar and the atmosphere gradient stay anchored, so the gap at the top shows the gradient's sky end, never a white flash.
- Damped with Apple's UIScrollView curve (`c = 0.55`, capped 130px). Touch drag: 1:1 then spring back. Wheel/trackpad and momentum-glide arrival: impulse + per-frame decay.
- Skips gestures inside overlays/modals (outside `#app-root`).

**Companion fix — status-bar bleed (both platforms)**: `.mosaic-page` / `.safe-top-bleed` (styles.css) pull each page wrapper's background up behind the status bar (`margin-top: -env(safe-area-inset-top)` + matching padding) so the notch strip shows the page gradient, not the bare body colour. Any new full-page wrapper must use `.mosaic-page` or add `.safe-top-bleed`.

**Tests**: ⚠️ No tests — gesture/transform + native scroll behaviour, verified manually per platform. iOS app compile-verified (`xcodebuild ... BUILD SUCCEEDED`).

---

## Tab Entrance Animations (opacity-only, once per session)

**Key file**: `src/ui/page-flair.ts` (`shouldPlayEntrance`); consumed by every tab-level view (home, plan ×3 modes, forecast ×3, stats ×3, plus just-track variants)

Card entrance animations across the app are opacity-only fades — no `translateY`/`scale`. Moving a `backdrop-filter` glass card forces WKWebView to re-blur its backdrop every frame, which made the Forecast cards "jump" at ~30fps on device (2026-06-05 TestFlight dogfood). All 30+ `*FloatUp` keyframes were swept to pure fades; the wizard/auth/modal "Rise" animations (overlays on static scrims) intentionally keep their small translate.

Tab-level views play their entrance (card fade stagger, ring background entrance, drift ripple, chart draw-on, Home bar/arc sweeps) on the **first visit per session only**, gated by `shouldPlayEntrance('<view-key>')`. Revisits render settled — `opacity:1`, no animation, `entrance:'none', pulse:false` on `buildRingBackground` — so tab switching is instant and nothing moves behind glass. Drill-down/detail pages keep their per-open fade (cheap once opacity-only).

**Tests**: ⚠️ No unit tests — verified headless (Chromium + demo seed): first visit animates, revisits settled on all four tabs; first-visit Forecast entrance ~60fps. ❌ Not yet device-verified.

---

## Maintenance Notes

**How to update this file**:
1. Run `npx vitest run` to see current test status
2. Update any ✅/⚠️/❌ entries that changed
3. Add new features at the bottom of their section when they're built
4. Mark test status as ❌ if tests exist but are failing

**Status key**:
- ✅ Passing — tests exist and pass
- ⚠️ No tests — feature works but is untested automatically
- ❌ Failing — tests exist but are broken (needs fixing)
