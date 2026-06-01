# Cross-Mode Adaptive-Behaviour Parity Plan

**Created 2026-06-01.** Status: **planning — nothing in P1/P2/P3 built yet.**

## Why this doc exists

Today's illness/holiday work surfaced a pattern: the triathlon and HYROX plan surfaces were built as **visual clones** of running's, but only wired up a *subset* of running's adaptive behaviour. The banners and status chips made them look complete, so silent gaps went unnoticed (illness/holiday did nothing on tri/HYROX for a while — fixed today).

A 3-agent verification pass (effort scoring / per-session scaling / post-holiday return) produced the file:line-grounded gap map below. This doc is the roadmap to close the *real* gaps, in priority order, with every constant flagged for a decision rather than invented (per the "No Made-Up Numbers" rule).

---

## Confirmed solid — DO NOT rebuild

These were suspected gaps but verified working. Leave them alone.

- **Cycling effort scoring** — power adherence (primary) → HR fallback → RPE, fully consumed into next-week duration scaling. `tri-effort-scoring.ts` → `effort-multiplier.triathlon.ts:84-102` → `plan_engine.triathlon.ts:76,114`. Flagship, not a hole.
- **Per-session Adjust/scaling** — tri/cycling/HYROX all working via in-place mutation of the stored workout; adherence reads the scaled target (`tri-adherence.ts:58`, `effort-multiplier.triathlon.ts:66`). just-track has no plan (correct).

---

## P1 — Post-holiday return for tri / cycling / HYROX  ✅ SHIPPED (2026-06-01)

**Severity: high — correctness + athlete safety + app honesty.** Built per decisions below. Science in `SCIENCE_LOG §AS`, changelog 2026-06-01. NOT device-verified (docks + anchor-gate + bridge are integration-level).

**What shipped:** discipline-aware render-time comeback bridge (`applyBridgeModsAllDisciplines`, wired into tri + HYROX plan-views); shared `detrainingLossFraction` curve (10-day dead-zone + activity-while-away attenuation) docking VDOT/FTP/CSS on holiday return only; anchor-gate (`ftpDetrainAnchorISO`/`cssDetrainAnchorISO`) so a pre-holiday effort can't restore a docked benchmark; mode-aware welcome-back copy. **Key design pivot:** detraining is holiday-only, not effort-age (a compliant plan-follower must never see FTP silently fall). **Mechanism:** render-time bridge, not engine `forceDeload` (tri/HYROX render stored workouts, so the engine flag can't scale the displayed comeback week).

**Resolved decisions:** D1 = render-time bridge (not forceDeload — see mechanism note). D2 = reuse VDOT decay shape. Dead-zone = 10 days. D3 = stations/MTL do NOT detrain (strength detrains slower; bridge eases station volume regardless). Activity-while-away scaling = yes (via `classifyHolidayActivity` ratio).

<details><summary>Original problem statement (for reference)</summary>

**Severity: high — correctness + athlete safety + app honesty.**

### Problem (verified)
- Running builds 1–3 scaled "bridge" weeks on holiday end (`buildBridgeWeekMods`, `holiday-modal.ts:1122`; applied at render `plan-view.ts:2264`) and docks VDOT (`computeVdotLoss`, `holiday-modal.ts:1262`).
- Tri/cycling/HYROX get **no bridge**. `applyBridgeMods_renderTime` is run-only — it skips every non-run workout (`isNonRun`, `NON_RUN_TYPES`) and only scales `\d+km` strings, useless for watt/time/station sessions.
- The resume week never carries `forceDeload`, and the holiday render-gate goes false the moment `holiday.active` flips — so a tri/HYROX athlete returning from a 2-week holiday gets their **full, normal week-N prescription on day one**. That's the exact ACWR load spike the running bridge exists to prevent.
- **FTP and CSS are never detrained** anywhere (zero call sites). A cyclist returns from 2 weeks off with an unchanged FTP.
- The welcome-back modal copy ("the next 2 weeks bridge you back", "quality sessions return this week") describes **running-only behaviour** and is shown to tri/HYROX users too. The app is telling them something that doesn't happen.

### Scope
1. **Discipline-aware return ramp** for tri/cycling/HYROX. Two candidate mechanisms (see D1):
   - (a) engine `forceDeload` on the resume week(s) — reuses the wiring we added today, simplest; or
   - (b) a discipline-aware bridge-mod builder applied at render, mirroring `plan-view.ts:2264`.
2. **FTP / CSS detraining** on holiday end, proportional to time away and activity-while-away. Anchor on the existing `computeVdotLoss` decay shape rather than a new model (see D2).
3. **Mode-aware welcome-back copy** — only promise what each mode actually delivers.

### Science
- Detraining is real and fast: Mujika & Padilla (2000) short-term detraining — VO2max ~6% down in the first 3–4 weeks off, with measurable power/endurance loss. The running side already encodes this via `computeVdotLoss`; the defensible move is to **mirror that decay shape** onto the FTP and CSS scales, not invent a second model.

### Files
- `holiday-modal.ts` (return-ramp builder; mode-aware welcome-back copy)
- `welcome-back.ts` (sibling of `computeVdotLoss` for FTP/CSS)
- `triathlon/plan-view.ts` + `hyrox/plan-view.ts` (apply ramp at render, or set resume-week `forceDeload`)
- `main.ts` (holiday-end detraining dock for FTP/CSS, mirroring the VDOT dock)

### Tests
- Resume week after a 2-week holiday is scaled, not full, for tri/cycling/HYROX.
- FTP and CSS are docked by the expected amount for a given days-away + activity ratio.
- Welcome-back copy differs by mode (no bridge promise for modes without a bridge — or the bridge now exists, so the promise becomes true).

### Decisions needed
- **D1 — mechanism:** resume-week `forceDeload` ramp (simpler, reuses today's wiring) vs discipline-aware bridge-mods at render. *Lean: forceDeload ramp.*
- **D2 — detraining rates:** reuse the `computeVdotLoss` decay fraction applied to FTP/CSS scales, or discipline-specific numbers? (No new constant if we reuse the VDOT decay shape.)
- **D3 — HYROX markers:** do station benchmarks / MTL detrain on holiday too, or only the run/FTP/CSS markers?

</details>

---

## P2 — HYROX adapts to execution (effort→progression loop + station adherence)  ✅ RPE-PRIMARY SHIPPED (2026-06-01); objective blend DEFERRED

**D5b resolved: yes, HYROX should adapt** — volume/density is the right lever (race implements are fixed at division weight, so progression is work-capacity, and scaling the hours budget scales rounds). **Shipped:** `hyroxEffortMultiplier` (`effort-multiplier.hyrox.ts`) — trailing RPE across ALL HYROX sessions → `effectiveHours × effortMult` in `plan_engine.hyrox.ts`, mirroring running/tri (`1 − score × 0.05`, [0.85,1.15], under-duration guard, weeks ≥ current, non-compounding). Science `SCIENCE_LOG §AU`. 11 tests. NOT device-verified.

**Why RPE-primary, not the full blend (D4/D5 deferred):** a data map proved the objective station signal doesn't exist for synced activities (Strava/Garmin give only "station session" + total time — no per-station reps/times, ever) and would need a structured target-capture refactor for guided sessions. RPE is the only signal on every session. The objective 60/40 blend (needs D4 band + target capture) is a **guided-only enhancement, deferred**. HR rejected (lags intermittent station work).

**Open follow-ups:** (1) ✅ DONE — inline note on the HYROX plan-view current-week summary surfaces the load shift when ≥5% (no week-debrief to host it, so inline per the feature-reveal preference). (2) the objective station-adherence blend (D4 band + structured station targets) if/when we decide to capture them — still deferred.

<details><summary>Original problem statement + decisions (for reference)</summary>

**Severity: medium-high — structural. Biggest build, most decisions.**

### Problem (verified)
- `plan_engine.hyrox.ts` is **purely phase-driven** — it reads no per-session execution signal. Crush a session or bomb it, next week is identical. There is no HYROX analogue of `effortMultiplier` / `triEffortMultiplier`.
- Stations get a **benchmark/PB refresh** only (`strength-complete.ts:93` → `stationBenchmarks` → race prediction). There is **no adherence grade** and **no progression feedback**. `rep-adherence.ts` routes `'run' | 'bike'` only — stations never pass through it (confirms the "high reps" concern).
- HYROX run legs are summarised for display but not graded vs a session pace target.

### Scope
1. **Station adherence grade** — score a completed station session against its prescribed target (reps/weight/time vs benchmark), with a tolerance band analogous to `BIKE_ADHERENCE_BAND` (see D4).
2. **HYROX effort multiplier** — mirror `triTrailingEffortScore` → a `hyroxEffortMultiplier` feeding `plan_engine.hyrox.ts` next-week load.
3. *(optional)* HYROX run-leg adherence vs session pace target.

### Science / mirror-rule
- Tri blends an objective intensity signal + RPE into `triEffortMultiplier`. HYROX should mirror it. The station "intensity" signal is performance-vs-benchmark (reps/load/time), analogous to power adherence on the bike. Blend with RPE the same way.

### Files
- extend `rep-adherence.ts` to stations, or new `hyrox-effort-scoring.ts`
- new `effort-multiplier.hyrox.ts` mirroring `effort-multiplier.triathlon.ts`
- `plan_engine.hyrox.ts` (read the multiplier)
- `constants/` (station adherence band)

### Decisions needed
- **D4 — station adherence band:** the ± tolerance around benchmark before a session counts as "on target." Needs a number (mirror the bike band's structure, but the value is yours).
- **D5 — blend weights:** mirror bike's 60% objective / 40% RPE for HYROX (performance-vs-benchmark 60 / RPE 40)?
- **D5b — meta-question:** do we actually *want* HYROX plans to adapt to execution, or is the current phase + benchmark-driven-prediction model deliberately enough? (This is the one to settle before building — it's the difference between a real build and "leave it.")

</details>

---

## P3 — Contained correctness fixes  *(small, quick wins)*

### P3a — Swim progression asymmetry  ✅ SHIPPED (2026-06-01)
- `scoreSwimEffort` computed CSS pace adherence (`tri-effort-scoring.ts:169`) and the UI showed it, but `triTrailingEffortScore` treated swim as **RPE-only** for progression — the objective signal was computed-but-inert.
- **Fixed:** swim now blends pace-vs-CSS adherence 60 / RPE 40 (D6 = mirror bike), `swimObjectiveDev = (1 − paceAdherence) × 10` (sign inverted vs bike: lower pace = faster = harder). Pure-RPE fallback when no pace signal. Science `SCIENCE_LOG §AT`. Tests +4. NOT device-verified.

### P3b — Running matcher mod bugs  ✅ FIXED (2026-06-01)
- `activity-matcher.ts:366-377` applied `newDistance`/`newType`/`newRpe` but **omitted `estimatedDurationMin = mod.newDurationMin`** — a latent inconsistency with the renderer (which does apply it, `plan-view.ts:2237`).
- `activity-matcher.ts:361` keyed mods by fragile **name+day**, not the stable `workoutId` (`findWorkoutForMod`). This was the unfixed half of the documented "40→20→40 revert" bug — it could grade an activity against the wrong/original target after a same-week reshuffle.
- **Fixed:** matcher loop now calls `findWorkoutForMod` (id-keyed, name+day fallback) and applies `newDurationMin`/`originalDurationMin`, mirroring the renderer. No new constants. tsc clean, scaling+matcher suites green. NOT device-verified.

---

## Suggested sequencing

1. ~~**P1** — correctness + safety + honesty.~~ ✅ SHIPPED 2026-06-01.
2. ~~**P3b** — tiny, real bug, no decisions needed.~~ ✅ SHIPPED 2026-06-01.
3. ~~**P3a** — small, one weight decision (D6).~~ ✅ SHIPPED 2026-06-01.
4. ~~**P2** — biggest, most scientific.~~ ✅ RPE-primary SHIPPED 2026-06-01 (D5b = yes). Objective 60/40 blend (D4/D5) + week-debrief transparency surface DEFERRED.

## Consolidated decisions blocking work
| ID | Item | Question | Resolution |
|----|------|----------|------------|
| D1 | P1 | Return ramp via resume-week `forceDeload` vs render-time bridge mods | ✅ **render-time bridge** (forceDeload can't scale stored tri/HYROX workouts) |
| D2 | P1 | FTP/CSS detraining — reuse VDOT decay shape vs specific rates | ✅ **reuse VDOT shape** + 10-day dead-zone + activity attenuation |
| D3 | P1 | Do HYROX station markers / MTL detrain on holiday | ✅ **no** — only run/FTP/CSS; bridge eases station volume |
| D4 | P2 | Station adherence band tolerance (± around benchmark) | DEFERRED — only needed for the guided-only objective blend |
| D5 | P2 | HYROX effort blend weights (objective vs RPE) | DEFERRED — RPE-primary shipped; blend is later (lean bike 60/40) |
| D5b | P2 | Do we want HYROX to adapt to execution at all? | ✅ **yes** — RPE-driven volume multiplier shipped |
| D6 | P3a | Swim multiplier blend weights | ✅ **mirror bike 60/40** (pace-vs-CSS 60 / RPE 40) |

*P1, P3b, P3a, and P2 (RPE-primary, with inline transparency note) all shipped 2026-06-01 (not device-verified). Only remaining: P2's objective station-adherence blend (guided-only, needs D4 + structured station targets) — deferred pending a decision on capturing structured station targets.*
