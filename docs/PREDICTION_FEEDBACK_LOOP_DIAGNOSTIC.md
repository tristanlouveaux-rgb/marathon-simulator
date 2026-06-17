# Diagnostic: race predictions bury a strong engine and aren't reproducible (ISSUE-297)

**Status:** OPEN — diagnosed 2026-06-16 (Tristan dogfooding). NOT fixed. Self-contained handoff: another agent can act on this without the originating conversation.
**Owner area:** running prediction / blended-fitness subsystem — `src/calculations/blended-fitness.ts`, `src/calculations/predictions.ts`, `src/calculations/physiological-vdot.ts`. **Caution: these are the files a parallel agent was actively rewriting (cross-trained forecast §BV/§BX + demonstrated-PB floor / ISSUE-285). Coordinate before editing — see "Collision note".**

---

## TL;DR

A runner who enters a **20:00 5K and nothing else** (8 km/wk, marathon target, 20 weeks) is shown a marathon prediction of **~3:50–4:00**, and **a different number every time the engine recomputes** (observed 3:33, 3:50; probes reproduce 3:11 / 3:36 / 3:50 depending on path). A 20:00 5K is VDOT ≈ 49.8 — a ~3:11 marathon at full fitness, and genuinely faster than ~95% of male runners.

Three linked root causes, one theme — **the prediction is not a pure function of the athlete's real inputs**:

1. **Capacity ≠ readiness conflation.** The volume-penalized *marathon* prediction is converted back into the athlete's *global engine* number (`s.v`), collapsing a VDOT-50 engine to ~40. (`blended-fitness.ts:583` + `:603`)
2. **Feedback loop → non-determinism.** Because `s.v` (and `s.lt`, recomputed from it) are written back to state and read on the next refresh, the result is path-dependent — re-running with identical inputs yields a different answer.
3. **Deleted PBs resurrect.** PBs merge `Math.min(s.pbs, onboarding.pbs)` (fastest-wins), so deleting a time from one store leaves it winning from the other — e.g. enter a 2:00:00 marathon, delete it, the plan stays anchored sub-2. (`physiological-vdot.ts` `effectivePhysiologyPbs`)

The "faster than 95% of runners" row and the "3:50 marathon" sit on the same screen because the placement reads `getPhysiologicalVdot` (PB-median ≈ 50) while the prediction reads the buried `s.v` (≈ 40).

### Second confirmed case (2026-06-16) — with real-world ground truth

A **40:00 10K**, minimal history, 3 runs/wk, plan peaks at **52 km/wk** → predicted **3:40** marathon.
- `cv(10000, 2400) = VDOT 51.9` → capacity marathon **3:04**; a fair *trained* result ≈ 3:10–3:25.
- `3:40 ⇒ VDOT 42.1` — the engine is again buried ~20%.
- **Ground truth:** Tristan has a 40:00 10K and *actually ran 3:10*. The app predicts this athlete **30 min slower than a real runner with the identical 10K**.
- The plan **builds them to 52 km/wk** — so the race-day FORECAST should assume that volume and land ≈3:10–3:25. Predicting 3:40 proves the forecast inherits the penalized-today engine instead of projecting from capacity + planned volume. **This is the forecast-side facet of RC1:** `calculateForecast(currentVdot=s.v)` reads the buried `s.v`, so "assume the plan is done" silently becomes "assume you stay at today's low volume."

---

## Symptoms (all observed)

| Symptom | What the user sees |
|---|---|
| Slow marathon off a fast 5K | 20:00 5K → ~3:50–4:00 marathon |
| Non-reproducible | Same input, re-run → 3:33 one time, 4:00 another |
| Internal contradiction | "Faster than 95% of male runners" next to a ~4:00 marathon |
| Forecast doesn't credit training | 20-week race-day forecast barely faster than "today" (3:40 vs 3:50) |
| Deleted PB sticks | Enter a 2:00:00 marathon, delete it → plan still targets sub-2 |

---

## Reproduction

`cv(5000, 1200) = 49.8` (correct — the raw 5K→VDOT conversion is fine), `tv(49.8, 42.195) = 3:11`. The bug is everything downstream. Drop this in `src/calculations/_probe.test.ts`, run, then delete:

```ts
// @vitest-environment jsdom
import { it } from 'vitest';
import { seedReviewerDemo } from '@/state/demo-data';
import { getMutableState } from '@/state/store';
import { refreshBlendedFitness } from '@/calculations/blended-fitness';

it('same input, repeated refresh — watch s.v collapse and the result drift by path', () => {
  seedReviewerDemo();
  const s = getMutableState();
  s.rd = 'marathon'; s.tw = 20; s.rw = 2;
  s.pbs = { k5: 1200 };                       // 20:00 5K, nothing else
  if (s.onboarding) s.onboarding.pbs = { k5: 1200 };
  s.detectedWeeklyKm = 8;
  s.vo2 = null as any; s.lt = null; s.ltSource = undefined as any;
  s.v = 49.8;                                  // start from TRUE capacity
  for (let i = 0; i <= 5; i++) {
    if (i > 0) refreshBlendedFitness(s);
    const sec = s.blendedRaceTimeSec ?? 0;
    console.log(`run ${i}: VDOT ${Math.round((s.v ?? 0)*10)/10}  marathon ${Math.floor(sec/3600)}:${String(Math.floor((sec%3600)/60)).padStart(2,'0')}  lt ${s.lt ?? 'null'}`);
  }
});
```

Observed:
```
run 0: VDOT 49.8  marathon 3:11   (true capacity)
run 1: VDOT 43.1  marathon 3:36   ← first refresh buries the engine
run 2-5: VDOT 43.1 marathon 3:36  (converges here)
```
The full onboarding path (`initializeSimulator`) lands at VDOT **39.9 → 3:50** instead — i.e. **different code paths reach different fixed points from the same input.** That path-dependence is the non-reproducibility.

---

## Root cause 1 — capacity/readiness conflation (`s.v` writeback)

`refreshBlendedFitness` (`blended-fitness.ts`):
1. `blendPredictions(...)` extrapolates the 5K to the marathon and **slows it for low volume** — `lowVolumeDiscount` (`predictions.ts:599`) + `marathonSpecificityPenalty` (`predictions.ts:851`). This is *correct for a race-day-readiness prediction*: you cannot run a great marathon off 8 km/wk.
2. `s.blendedRaceTimeSec = durabilityAdjustedBlend` (`:582`) — the penalized marathon time (~3:50). Fine.
3. **The bug:** `s.blendedEffectiveVdot = cv(targetDistM, durabilityAdjustedBlend)` (`:583`) — it back-derives a VDOT from the *penalized marathon time* (~40), then `s.v = s.blendedEffectiveVdot` (`:603`).

So a **race-readiness** adjustment (volume penalty) is written into the athlete's **global engine** number. Everything downstream then reads the buried `s.v`: training paces, plan generation, and the race-day forecast (`calculateForecast(currentVdot=...)`, `predictions.ts:404/461`) — which is why the 20-week forecast barely improves on "today".

**The conceptual error:** "engine size" (VO2/VDOT capacity, proven by the 5K) and "marathon readiness" (capacity × volume/durability/specificity) are different quantities. The system collapses them into one number, anchored to the *most penalized* distance (the marathon).

## Root cause 2 — feedback loop → non-determinism

`s.v` is written back (`:603`) **and** `recomputeLT(s)` runs each refresh (`:486`), deriving `s.lt` from the (now degraded) `s.v`. On the next refresh:
- `getPhysiologicalVdot` may resolve via the **lt-derived tier** (`physiological-vdot.ts:304`) *before* the pb-median tier (`:320`), returning the degraded value;
- the blend re-reads the lowered `s.v`/`s.lt` as seeds.

Result: the output depends on the prior stored state, so repeated runs (or different entry paths) converge to different fixed points. This is the "degraded VDOT loop" already described in SCIENCE_LOG §BO — but §BO's fixes (`effectivePhysiologyPbs`, demonstrated-PB floor) only stop *same-distance* regression; they do not stop a 5K-derived engine from being buried by a marathon-readiness penalty.

## Root cause 3 — deleted PBs resurrect (fastest-wins)

`effectivePhysiologyPbs` (`physiological-vdot.ts`) returns, per distance, `Math.min(s.pbs[k], s.onboarding.pbs[k])` (fastest wins). Two consequences:
- Deleting a PB from one store (e.g. `s.pbs`) leaves the value alive in the other (`s.onboarding.pbs`) — it keeps winning.
- Even within one store there is no "deleted" tombstone, and fastest-wins means a value can never be *raised* (slowed) by an edit.

So: enter a 2:00:00 marathon → `pbs.m = 7200` → VDOT spikes → `s.v` + goal anchor to sub-2 → delete it → `effectivePhysiologyPbs` still returns 7200 from the surviving store → plan stays sub-2. **Deletion handlers to audit** (must clear *both* stores, and trigger a `refreshBlendedFitness`): `manual-entry.ts`, `account-view.ts`, `review.ts`, `runner-type.ts`, `forecast-chip-detail-view.ts`.

---

## The fix (direction — deliberate, NOT yet implemented)

**Principle: separate the engine from race readiness.** Volume/durability/specificity penalties belong on the *prediction*, never on the global capacity `s.v`.

1. **Stop the `s.v` writeback from using the penalized race time.** Derive the engine `s.v` from a *capacity* signal — the blend **before** the marathon-specificity/durability penalties, or directly the demonstrated-capacity tiers (PB-median / device / HR-calibrated). At minimum, **floor the `s.v` writeback at the PB-derived capacity** (`pbDerivedVdot`, `physiological-vdot.ts:120`) absent detraining evidence — the VDOT-level analogue of the existing `demonstratedPBFloor`.
   - **Do NOT over-correct:** a genuinely detrained athlete (recent slow runs, low real volume) *should* still see a lower engine. The floor must yield to real evidence (recent-run pace, measured low volume), exactly as `demonstratedPBFloor` does. The trigger to suppress is a *missing-data / cross-distance volume penalty*, not demonstrated recent slowness.
2. **Keep the race prediction honest.** `blendedRaceTimeSec` ("today, off 8 km/wk") can stay realistic/slow; the **forecast** (`calculateForecast`) must then build from the *true* capacity so 20 weeks of training projects toward ~3:10–3:20, not 3:40.
3. **Deletion fix.** Clear deleted PBs from `s.pbs` *and* `s.onboarding.pbs` (and any goal anchor), then `refreshBlendedFitness`. Consider whether `effectivePhysiologyPbs`'s fastest-wins needs a tombstone so an explicit delete can lower the value.

## Test plan (add as guards)

- **Determinism:** `refreshBlendedFitness` × N on fixed inputs returns a stable `s.v` and `blendedRaceTimeSec`, and equals the `initializeSimulator` path (no path-dependence).
- **Capacity floor:** 20:00 5K, 8 km/wk, marathon → `s.v` ≈ 49–50 (not 40); "today" marathon may be slow but the **forecast** projects materially faster than today.
- **No regression (detrained):** PB 20:00 5K but recent runs at 25:00-equivalent + real <30 km/wk → engine *is* allowed below PB capacity (evidence-based).
- **Delete:** enter then delete a 2:00:00 marathon → `effectivePhysiologyPbs.m` is undefined and `s.v`/goal revert.

## Collision note

`blended-fitness.ts` / `predictions.ts` / `physiological-vdot.ts` are the parallel agent's active domain (cross-trained forecast §BV/§BX, demonstrated-PB floor / ISSUE-285, `lowVolumeDiscount`). Do **not** edit mid-flight. Land this when that work is committed and settled, then build on `demonstratedPBFloor` rather than around it (the `s.v` capacity-floor is its VDOT-level sibling).
