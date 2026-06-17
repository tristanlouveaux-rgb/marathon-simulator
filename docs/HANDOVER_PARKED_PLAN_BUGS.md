# Handover — parked plan-periodisation + coach-contract display bugs (2026-06-16)

Self-contained handoff for a fresh agent. Three bugs Tristan parked while another agent (me) was fixing prediction calibration (ISSUE-297). They cluster into "plan periodisation + plan-shape display" and are independent of the prediction work. Read this top to bottom before touching code.

## Do I need to wait for the ISSUE-297 / RC3 agent?

**No.** That agent works the prediction/PB path (`blended-fitness.ts`, `predictions.ts`, `physiological-vdot.ts`, PB-deletion handlers). These bugs are plan-engine + plan-shape. The two files that appear in both areas — `initialization.ts` and `plan_engine.ts` — already have that agent's ISSUE-297 edits **committed to the working tree and finished** (engine-floor at `initialization.ts:~544`; `computePeakWeeklyKm` exported at `plan_engine.ts:~655`). Do **not** revert or rewrite those; just edit different functions.

**The real collision risk is the OTHER parallel agent** (text/UI / coach-contract / connect-data / plan-shape). Bug 2 below lives in *their* domain — coordinate or defer it. Bugs 1 and 3 are plan-engine, safe to take.

## Repo state
- Branch `feat/revenue-cat-iap`, never pushed (push blocked: 1.2 GB `.git`). Safe restore point: commit `dbcadf1`.
- Working tree is a multi-agent mix. Diff against `dbcadf1` if you need a known-good baseline. Back up before any destructive git op (see CLAUDE.md Git Safety).
- Verify: `npx tsc --noEmit`, `npx vitest run`, `npm run lint:ui`. Note: full-suite has pre-existing NON-deterministic flakes in the parallel agent's untracked `plan-shape-chart.ts` + `connect-data.test.ts` (they pass in isolation) — don't chase those; run your target test file in isolation to judge your own work.

---

## Bug 1 (P2) — Continuous mode "ramps in circles" (no progressive overload)

**Symptom (screenshot, coach-contract reveal).** Endless/continuous-mode plan shows the weekly-load chart cycling Base→Build→Peak→Taper four times with an identical low peak each cycle ("Peak · wk 2" every block), ~168 km total peaking ~17 km. It loops the mesocycle template without building cycle-over-cycle.

**Confirmed mechanism location.** `src/state/initialization.ts:~630-642` — for `state.trainingForEvent === false` it overrides phases to a repeating 4-week block via modulo:
```ts
const blockPhases = ['base','build','peak','taper'];
for (let i = 0; i < s.wks.length; i++) s.wks[i].ph = blockPhases[i % 4];
```
So phase resets every 4 weeks. The volume budget (`effectiveWeeklyBudgetMin` → `weekVolumeBudgetKm`, `plan_engine.ts:~402-430`) ramps on `weekIndex`, but phase-driven intensity/volume multipliers reset each block, producing the sawtooth-at-a-flat-level.

**Investigation needed (NOT yet root-caused).** Decide what "progressive overload across cycles" should mean for continuous mode and whether the peak should climb block-over-block. Likely the fix is in how continuous-mode weeks map phase + volume (the `i % 4` assignment and/or the budget ramp interaction). **Do not invent ramp constants** — confirm the intended continuous-mode progression model with Tristan first (CLAUDE.md "No Made-Up Numbers").

---

## Bug 2 (P2) — Coach-contract session-mix bars stuck at 50/50 (continuous-mode-specific)

**Symptom.** "How your sessions shift by phase" shows Base 50/50, Build 50/50, Peak 50/50 (easy/quality) — identical across phases, contradicting the copy above it ("easy carries early phases, quality near race day"). In a normal 10K/9-week plan the bars DO shift correctly (Base 62/38, Build 44/56), so this is **continuous-mode-specific**.

**Suspected location.** `derivePlanShape` in `src/ui/plan-shape.ts` — the per-phase session-mix derivation isn't differentiating phases when the plan is continuous (likely because continuous-mode phases cycle, so a single representative "phase" sample collapses to a flat mix). Tied to Bug 1.

**⚠️ COORDINATION REQUIRED.** `plan-shape.ts` / `plan-shape-chart.ts` are the **existing parallel agent's coach-contract domain** (untracked `plan-shape-chart.ts` is theirs). Do NOT edit these without coordinating, or defer Bug 2 until their coach-contract work is committed. Bug 1's fix may resolve Bug 2 for free (if the mix derives from real per-phase plan data once continuous phases progress).

---

## Bug 3 (P2) — Load peak lands in the BUILD phase, not the Peak phase (= ISSUE-287)

**Symptom (screenshot).** A 9-week 10K plan shows "Peak · wk 5" with the load apex under the "Build" label, before the actual "Peak" phase (Base/Build/Peak/Taper). 209 km / 9 wks, peaking ~30 km, taper sheds ~48%.

**Already triaged as ISSUE-287** (see `docs/OPEN_ISSUES.md`). Root cause per the prior session: an **intensity-placement** artifact (post-deload + build-phase bounce), NOT volume — a volume envelope was built and reverted because it's the wrong tool. Real lever: concentrate quality in the peak phase / damp the early build bounce via `qualityCap` / `workoutPriority` in `src/workouts/plan_engine.ts`. **Plus** Tristan wants an onboarding flag warning that a short (≤12 wk) plan is compressed. Full notes: `docs/OPEN_ISSUES.md` ISSUE-287 + `docs/SCIENCE_LOG.md` §BW.

---

## Suggested sequencing for the new agent
1. **Bug 1 first** (continuous-mode progression) — it's the clearest and may fix Bug 2 as a side effect. Confirm the intended progression model with Tristan before coding.
2. **Bug 2** — re-check after Bug 1; only touch `plan-shape.ts` after coordinating with the coach-contract agent.
3. **Bug 3 (ISSUE-287)** — separate, intensity-placement in `plan_engine.ts`; pairs with the short-plan onboarding warning.

Memory pointer: `memory/project_continuous_mode_ramps_in_circles.md` (all three, kept together). Prediction-side context (do not edit): `memory/project_prediction_feedback_loop_issue297.md`.
