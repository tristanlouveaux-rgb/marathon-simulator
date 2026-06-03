# Leg-Load Flow — Design Doc

**Status:** ✅ BUILT (2026-06-02). Write side (all modes) + readiness floor + nudge. Running/HYROX read the ledger via `computeReadiness`; tri floor threaded into the **run discipline only** in `computeTriReadiness` (end-to-end trace found tri was previously invisible — fixed). Shared `gymLegLoadNudgeForWorkout` nudge on both running + tri gym cards. Science self-determined (Tristan delegated D1/D2), logged in SCIENCE_LOG §BE. 20 tests (strength-leg-load 18 + tri-readiness 2), full suite green (2925). NOT device-verified. Deferred: legFeel synced fallback, per-lift RIR, eccentric tiers, HYROX *stations* → MTL (D5).
**Date:** 2026-06-02
**Scope agreed:** derive gym leg load from exercises (not a subjective tag as the primary path); surface it + suggest the user reduce intensity (no auto-mutation of the plan); design doc first.

**Resolved decisions (Tristan delegated the science):** D1 `K_STRENGTH = 0.9` (anchored to the canonical hard leg day ≈ 16 units). D2 `intensityMult = clamp(%1RM / 0.80, 0.5, 1.25)`, `effortMult = clamp(RPE / 7, 0.6, 1.25)` (session RPE chosen over per-lift RIR — always available, validated sRPE). D3 trigger = planned raw ≥ `STRENGTH_LEG_LOAD_MODERATE_RAW` (7) AND decayed total ≥ `LEG_LOAD_MODERATE` (20). D4 onboarding capture: out (deferred). D5 HYROX MTL: deferred.

---

## 1. Problem

The gym program now mandates leg-based exercises (squats, deadlifts, lunges, split squats — see `strength-muscle-groups.ts`). But the gym is invisible to the app's leg-fatigue model, in **both** directions:

- **Write side:** a heavy leg day contributes **zero** to recovery. `SPORTS_DB.strength` has no `legLoadPerMin`, and `recordLegLoad` is never called for strength sessions (`strength-complete.ts` logs the actual but adds no leg-load entry). So a 5×5 squat session does not move readiness at all.
- **Read side:** the strength engine (`strength-progression.ts`) is phase-gated only. It never reads `recentLegLoads`, so it will prescribe a heavy leg day on top of yesterday's 30 km long run with no awareness that the legs are already cooked.

## 2. Key insight — there is already a single leg-load ledger

This is **not** a new system. `s.recentLegLoads` (`state.ts:1127`) is a working, canonical leg-fatigue ledger that already:

- captures **running** leg load — `distanceKm × RPE-impact-multiplier` (`sport-picker-modal.ts`)
- captures **cross-training** leg load — `durationMin × SPORTS_DB[sport].legLoadPerMin` (`activity-review.ts:56`)
- decays each entry on a **48 h half-life** (Clarkson & Hubal 2002) with sport-specific `recoveryMult`, and applies **Repeated Bout Effect** discounting at write time (`readiness.ts:45–176`)
- drives **readiness hard floors** — decayed total ≥ `LEG_LOAD_MODERATE` (20) caps the score at 54 ("Manage Load"), ≥ `LEG_LOAD_HEAVY` (60) caps at 34 ("Ease Back") (`readiness.ts:637–654`)
- has its own drill-down (`leg-load-view.ts`) and reconciliation pass (`reconcileRecentLegLoads`, `sport-picker-modal.ts:229`)

There is even a **scaffolded but unwired hook** for the gym: `legFeel?: 'none' | 'moderate' | 'heavy'` (`state.ts:465–469`), documented down to its load-per-minute mapping, but **never written or read anywhere**. Someone teed up the subjective path and never finished it.

**The design is therefore: make the gym both a writer and a reader of the existing ledger.** No parallel fatigue model, no new decay/floor constants.

---

## 3. Write side — deriving gym leg load from exercises (D1, D2)

### 3.1 What data we have per completed gym session

- `GarminActual.loggedLifts[]` (`state.ts:393`): `{ exerciseName, weightKg?, reps, estimatedOneRmKg?, liftKey? }`
- `GarminActual.workedMuscleGroups[]` (`state.ts:389`)
- `deriveWorkedMuscleGroups(session)` (`strength-muscle-groups.ts:109`): returns per-leg-group `score = Σ (primary=1 | secondary=0.5) × sets`. **A leg day scores high on quads/glutes/hams/calves; an upper/core day scores ~0 on legs.** This already exists and already distinguishes leg work from non-leg work automatically.
- `StrengthLog` (`strength-log.ts`): per-lift `lastWeightKg`, `lastRir` (`reps-left | about-right | barely`), `est1rmKg`. Lets us read relative intensity and proximity to failure.

### 3.2 The model (proposed — MVP)

```
legScore        = Σ over leg groups {quads, glutes, hamstrings, calves} of score   // from deriveWorkedMuscleGroups; core/back excluded
intensityMult   = f(meanPctOneRm)        // relative mechanical tension, %1RM = weightKg / est1rmKg
rirMult         = g(lastRir)             // proximity to failure → more eccentric damage
legLoadRaw      = K_strength × legScore × intensityMult × rirMult
```

Then it goes straight into the **existing** machinery, with no new constants on that side:

- written via the existing write path (`recordLegLoad` / reconcile) as a `recentLegLoads` entry with `sport: 'strength'`, keyed by `garminId`
- `recoveryMultOverride` set so a heavy leg day decays slower (the scaffold already specifies heavy → half-life ×1.20)
- RBE discounting applies automatically (same-sport prior session within 14 d → ×0.6)
- readiness floors (`LEG_LOAD_MODERATE=20`, `LEG_LOAD_HEAVY=60`) consume it unchanged

### 3.3 Why this is defensible

- **Mechanical tension / eccentric exposure** is the driver of exercise-induced muscle damage and the functional-force deficit that the leg-load floor models (Clarkson & Hubal 2002; the same basis already cited in `readiness.ts`). Volume of leg-muscle work (`legScore`), relative load (`%1RM`), and proximity to failure (`RIR`) are the three standard, literature-backed determinants of that tension/damage. We are not inventing the axes.
- `legScore` reuses an existing, already-reviewed anatomy lookup — not a new guess.
- The leg-load → readiness link is **tracking** ("the legs are tired"), not **planning** (it does not add to CTL/ATL or change prescribed load). This respects the CLAUDE.md tracking/planning separation. Gym TSS is already counted separately via the RPE-TSS path; leg load is an orthogonal axis, so there is **no double-count** with Signal-B TSS.

### 3.4 Synced-strength fallback

When a strength session has no parsed exercises (e.g. a bare Garmin/Strava "Strength" activity, duration + HR only), we cannot derive `legScore`. **Fallback = finish the `legFeel` scaffold**: optionally prompt none/moderate/heavy and use the documented per-minute mapping. Derived-from-exercises is primary; `legFeel` is the fallback, and the two are **mutually exclusive per session** (never write both entries for one `garminId`).

### 3.5 Integration traps (implementation notes)

1. **Reconcile must know about gym.** `reconcileRecentLegLoads` (`sport-picker-modal.ts:229`) rebuilds entries from `garminActuals`; if it doesn't compute the gym derivation it will **drop** strength entries on the next leg-load-view open. The gym derivation must live in the shared write helper used by `recordLegLoad`, reconcile, and the `main.ts` backfill (`main.ts:1052`).
2. **One entry per session**, keyed by `garminId`, idempotent (mirror the existing cross-training reconcile contract).
3. **No new CTL/ATL contribution** — leg load stays out of the load/TSS path.

---

## 4. Read side — surface + suggest reduce intensity (D3)

Agreed behaviour: **surface, and suggest the user reduces intensity. No auto-mutation of the plan.** This follows the suggestion/acceptance contract and the adaptation-transparency "small but meaningful → note, don't pop" rule.

- **Estimate the planned leg day's load** with the same model, using prescribed sets + `strengthLog.lastWeightKg` + the `@X% 1RM` marker, so we can reason about an upcoming session, not only completed ones.
- **Trigger:** the upcoming/today gym session is leg-heavy (its estimated `legScore` share is above a threshold) **and** the current decayed `recentLegLoads` total ≥ `LEG_LOAD_MODERATE` (20).
- **Surface:** a note on the gym / plan-view current-week card and in the guided-strength-overlay pre-session screen. Copy (consultant tone, no emoji, no accent colour on the nudge — bordered pill per CLAUDE.md UI rules), e.g.:
  > "Legs are carrying load from {Sunday's long run}. Consider backing off today's leg work — drop a set or reduce load about 10%."
- **No plan mutation.** If the user wants to actually scale it, route them to the existing per-workout **Adjust** overlay (`workout-adjust-overlay.ts`) — reuse, don't build a parallel reducer.

This nudge sits on the planning side of the tracking/planning line, but it is **suggest-only and user-actioned**, so it does not violate "describe vs prescribe" — it surfaces a fact and offers the existing adjustment tool.

---

## 5. Mode parity (Mirror rule)

- **Running + triathlon:** use `recentLegLoads` (this design). Tri's run leg already feeds the same ledger, so gym in tri mode writes there too — consistent.
- **HYROX:** already has its **own** eccentric-load model — `musculoTendonLoad` CTL/ATL with an `mtlAcwr` readiness floor (`mtl.ts`, `readiness.ts:622–635`). Gym leg work in HYROX mode should feed **MTL**, not `recentLegLoads`, to avoid a second parallel ledger. **Phase 1 = running + tri only.** HYROX MTL integration is a deferred follow-up with one hard guard: **never write the same session to both ledgers** (double-count). Flagged here so the Mirror rule is addressed, not silently skipped.

---

## 6. Onboarding / settings capture (D4 — optional, lower priority)

The original ask mentioned "asks about leg load for gym stuff for other activities." Optional capture, deferred unless Tristan wants it in Phase 1:

- a wizard/Account question about existing out-of-app leg training (leg-day frequency, typical squat/DL volume) to **seed** baseline leg load and avoid a cold-start where the floor never fires for someone already doing heavy legs.
- Lower priority because the derived model self-populates from logged sessions within ~1 week.

---

## 7. Open decisions (need Tristan)

The structure above introduces **as few new constants as possible** by reusing the decay/RBE/floor machinery wholesale. The genuinely new numbers — which per "No Made-Up Numbers" I will not invent — are:

- **D1 — `K_strength` calibration anchor.** Proposed method: calibrate `K_strength` so a *canonical hard leg day* (a real prescribed session, e.g. 5×5 back squat @ ~80% 1RM + 3×8 RDL + 3×12 split squat) produces ≈ **16 raw leg-load units** — matching the already-accepted `legFeel: 'heavy'` scaffold (≈ 0.35 load/min × ~45 min). This reproduces the existing accepted scale and lets the model vary objectively around it. One anchor, derived against existing values. **Confirm the anchor session and the ~16-unit target, or give a different anchor.**
- **D2 — `intensityMult(%1RM)` and `rirMult(RIR bucket)` shapes.** Proposed: intensity flat-ish around typical 70–85% 1RM and rising toward 1RM; RIR `barely` > `about-right` > `reps-left`. These are the real "new model" knobs. **Need agreed values or a curve.** (I'll propose literature-anchored starting values for review, not commit them.)
- **D3 — Read-side trigger thresholds.** Reuse `LEG_LOAD_MODERATE`/`HEAVY` for the load side; agree the "leg-heavy session" `legScore`-share cutoff.
- **D4 — Onboarding capture in/out of Phase 1?** Default: out.
- **D5 — HYROX MTL integration now or deferred?** Default: deferred (Phase 1 = run + tri).

## 8. Build plan once decisions land

1. Shared `deriveStrengthLegLoad(session | loggedLifts, strengthLog)` helper (pure, unit-tested) → raw leg-load units.
2. Wire into the write path: `recordLegLoad`-equivalent on strength completion + `reconcileRecentLegLoads` + `main.ts` backfill, keyed by `garminId`, with `recoveryMultOverride` for heavy days. `legFeel` fallback for exercise-less synced strength.
3. Read side: planned-session estimate + trigger + note on gym/plan card + guided-overlay pre-session, linking to the existing Adjust overlay.
4. Tests: leg vs upper day discrimination, intensity/RIR scaling, RBE same-session-twice, reconcile idempotency, floor crossing when stacked with a long run.
5. Docs: SCIENCE_LOG **§BD** (next free letter — §BB is missing and §BA/§BC exist; parallel-agent collision hazard, verify head before writing), FEATURES.md, CHANGELOG.md, ARCHITECTURE.md leg-load entry.

---

## Citations / existing basis
- Leg-load decay, RBE, floors, `recoveryMult`: `readiness.ts:45–176`, `637–654` (Clarkson & Hubal 2002; McHugh 2003; Nosaka & Clarkson 1995).
- Muscle-group attribution: `strength-muscle-groups.ts`.
- Strength tracking data: `strength-log.ts`, `state.ts:393` (`loggedLifts`).
- `legFeel` scaffold: `state.ts:465–469`.
- Write/reconcile paths: `activity-review.ts:56`, `sport-picker-modal.ts:229`, `main.ts:1052`.
