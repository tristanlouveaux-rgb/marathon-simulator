# Batch C Triage — Onboarding/Wizard
**Date:** 2026-04-18
**Agent:** Batch C

## Summary
- Issues triaged: 5
- still-broken: 2 (ISSUE-90, ISSUE-91 probably)
- spec-only-not-implemented: 3 (ISSUE-92, 119, 122)
- stale-diagnosis: 1 (ISSUE-91 — may be stale, needs plan-gen review)

## Wizard Architecture Snapshot
The wizard flows through 14 steps (welcome → goals → connect-strava → review → background/volume/performance/fitness/strava-history → physiology → initializing → runner-type → assessment → main-view). State stored in `src/types/onboarding.ts` (OnboardingState), persisted via `src/state/persistence.ts`. Controller (`src/ui/wizard/controller.ts`) manages navigation.

`softResetState()` (persistence.ts:479–502) clears the plan but preserves name, PBs, physiology (LT pace, VO2, HR), and `confirmedRunnerType`, restarting at 'goals' if name exists.

Garmin integration: `supabase/functions/sync-physiology-snapshot/index.ts` queries `physiology_snapshots` for `lactate_threshold_pace` + `lt_heart_rate`. Client sync (`src/data/physiologySync.ts`) hydrates `s.lt` and `s.ltHR`.

Initializing step (`src/ui/wizard/steps/initializing.ts`) shows only a progress animation with three substeps (PBs → Profile → Plan) — no backfill summaries.

## Ready-to-Implement Specs
- **ISSUE-92** (Show historic load scan)
- **ISSUE-119** (App explainer screen)
- **ISSUE-122** (Training goals step)

---

## ISSUE-90: LT Threshold not surfaced in setup; no Garmin auto-pull (P2)

**Plain-English recap:**
Users manually enter LT HR on the physiology step with no guidance on where to find it in Garmin. The app has infrastructure to auto-pull LT via `sync-physiology-snapshot`, but on-setup guidance is missing.

**Current code state:**
- `src/ui/wizard/steps/physiology.ts:60–74` — LT pace input fields with minimal help text
- `supabase/functions/sync-physiology-snapshot/index.ts:57–71, 135–162` — Queries physiology_snapshots for LT
- `src/data/physiologySync.ts:158–187` — Syncs LT pace, applies VDOT sanity check, stores to `s.lt` and `s.ltHR`
- `src/ui/wizard/steps/physiology.ts:48–58` — "Sync from Garmin" button functional

**Does it still reproduce?**
Yes, still open. Sync button exists and works when Garmin has the metric, but users get no guidance on where to find LT HR. Fallback message "open Garmin Connect on your phone to force a sync" assumes knowledge of where LT lives.

**Recommendation:** `still-broken`

**Evidence:**
Physiology step (lines 62–63) labels field "Lactate Threshold Pace · Fastest pace you can sustain for ~1 hour" — no mention of Garmin or how to locate the metric. Plumbing is present but a help icon or expanded text pointing to Garmin's Physio True-Up is missing.

---

## ISSUE-91: Plan restart generates different running profile — nondeterministic (P2)

**Plain-English recap:**
Restarting the plan with identical inputs produces a different runner type and plan structure. Root cause unknown — possibly stale state carryover or non-deterministic plan generation.

**Current code state:**
- `src/state/persistence.ts:479–502` — `softResetState()` clears training plan (wks) but preserves name, PBs, physiology, and `confirmedRunnerType`
- `src/ui/wizard/controller.ts:220–227` — `resetOnboarding()` resets onboarding but does not call softResetState
- Grep: no `Math.random` calls in wizard folder

**Does it still reproduce?**
Unclear. No randomness in wizard code. softResetState() preserves `confirmedRunnerType`, so runner type should remain stable on restart. Nondeterminism likely originates either in plan generation (`state/initialization.ts`) or from stale state fields (e.g., `v`, `typ`, `tm`) that softReset leaves intact.

**Recommendation:** `stale-diagnosis` — needs a targeted look at `state/initialization.ts` before closure.

**Evidence:**
softResetState() lines 479–502 only clear training plan and onboarding. Main state fields (VDOT, runner type, target time) untouched. No Math.random in wizard/controller.

---

## ISSUE-92: Onboarding should display historic load scan before confirming plan (P3)

**Plain-English recap:**
After Strava backfill completes, the wizard never shows users proof their training history was understood (activities count, average load, ramp rate). Users should see a summary before the plan starts.

**Current code state:**
- `src/ui/wizard/steps/initializing.ts:18–82` — Loading animation with 3 steps (PBs → Profile → Plan), no backfill summary
- `runInitialization()` (lines 87–130) — Calls initializeSimulator but does not fetch or display Strava history summary

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
Initializing.ts renders only a spinner + 3-step checklist. No code attempts to show activity count, date range, TSS average, or ramp rate. Strava sync in `src/data/stravaSync.ts` not wired into initializing flow.

---

## ISSUE-119: Onboarding should be clearer about what the app actually does (P2)

**Plain-English recap:**
New users finish setup without understanding the app's core promise (personalised plan from history, weekly adaptation, watch integration). No intro screen is shown early in the wizard.

**Current code state:**
- `src/ui/wizard/steps/welcome.ts:8–80` — Shows brand "MOSAIC", tagline "Training that adapts", subheadline — but does not explain *how*
- `src/ui/wizard/steps/goals.ts` — Asks *what* to train for, not *why* the app matters
- No "Here's how it works" screen in step order

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
Welcome.ts subheadline (line 35–38) is generic: "Running, strength, sport, and recovery." No step file matches "how it works" or provides educational bullets.

---

## ISSUE-122: Onboarding should ask for training goals (P3)

**Plain-English recap:**
Onboarding asks for fitness level and race target but never asks *why* the user is training (lose weight, get fit, Hyrox, triathlon). This context is needed for plan customization.

**Current code state:**
- `src/types/onboarding.ts:17` — `'goals'` listed in OnboardingStep enum, but OnboardingState (lines 89–149) has no `goals` field
- `src/ui/wizard/steps/goals.ts:76–192` — `renderGoals()` implements *mode* selection (Running/Fitness), not *goal* selection
- Design spec lists 8 options (Run faster, Run further, Get fit, Just run, Build strength, Get in shape, Hyrox, Triathlon) — none implemented

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
Goals step file exists but renders mode tiles (Running/Hyrox/Triathlon/Fitness) and distance/focus selection, not the multi-select goal step specced. Requires extending OnboardingState with a `goals: string[]` field + new UI.

---

## Blockers & Cross-references
- **ISSUE-90 ↔ ISSUE-134:** If Garmin portal is down (ISSUE-134), auto-pull is effectively blocked-external. Current sync assumes it can reach Garmin.
- **ISSUE-91:** Needs targeted look at `state/initialization.ts` for plan-gen nondeterminism.
- **ISSUE-92 & ISSUE-119:** Both educational features — ready to build once designs finalized.
- **ISSUE-122:** Requires OnboardingState extension + new UI + possible plan-gen consumption.
