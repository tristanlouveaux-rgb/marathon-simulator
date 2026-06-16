# Diagnostic: marathon plans are under-built (low volume, short long run, flat/front-loaded ramp)

**Status:** FIX APPLIED (in working tree, not device-verified) 2026-06-15 — all three RCs addressed. See SCIENCE_LOG §BW, CHANGELOG, ISSUE-286 for the implementation. Probe result after fix: peak wk 11→14, peak km 37→51, total 452→588, long run 18 km/89 min → 32 km/159 min. The notes below are the original diagnosis (kept for reference). Diagnosed 2026-06-15 from a real device plan ("T.", Amsterdam Marathon, 18 weeks).
**Owner area:** plan engine (`src/workouts/plan_engine.ts`, `src/calculations/athlete-archetype.ts`). NOT the onboarding/coach-contract page — that page faithfully *reports* the problem.

---

## TL;DR

A real 18-week marathon plan rendered on the coach-contract page as:
- **Peak weekly load at WEEK 2** (should be ~week 14-16).
- A jagged, no-arc "sawtooth" load line.
- **~34 km peak week / ~452 km total** — low for a marathon.

Investigation (config sweep + per-week dumps) shows the **chart is faithful** — it sums exactly what the engine prescribes. The plan itself is under-built for the marathon distance, from three compounding engine behaviours:

1. **Long run is time-capped too low for the marathon** (≈90-120 min ⇒ ~18-24 km; marathon prep wants ~28-32 km / 2.5-3 h).
2. **The weekly-volume ramp goes flat under a tight cap**, so the plan stops periodizing and the "peak" lands wherever weekly noise is highest (week 2) instead of building to a late peak.
3. **Low run frequency** (≈3 runs/wk) drops total volume hard and, for marathon, drives the easy-run count to **0** in the peak-week budget heuristic.

---

## Symptoms (device screenshot, the user's real plan)

- Header: "18 weeks, built in phases." Caption: "...peak around week 2 ... sheds about 55% in the taper ... About 452 km across 18 weeks, peaking near 34 km in your biggest week."
- Load line: violent up/down with no overall arc; "Peak · wk 2" pill.

## What is NOT the problem

- **The coach-contract chart is faithful.** `renderPhaseLoad` (`src/ui/wizard/steps/coach-contract.ts`) plots `derivePlanShape(s).weeklyTss`, which sums `calculateWorkoutLoad` over the *actually generated* sessions per week. Verified sane for a normal config (below).
- **The km undercount is already fixed.** `plannedWorkoutKm` (`src/calculations/plan-shape.ts`) now converts minute-prescribed quality work ("26min @ MP", "5×4min @ VO2" — which `parseDistanceKm` read as 0) to km via `estimatedDurationMin × easy pace`. Used by both `derivePlanShape` and `plannedWeekKm` (so the Stats forecast km chart is fixed too). Do **not** re-investigate km=0.

---

## Evidence

### Config sweep (16-wk marathon demo via `seedReviewerDemo`, varying one input)

| Config | Peak week | Peak km | Total km |
|---|---|---|---|
| Normal demo (5 runs/wk) | **wk 14** ✓ | 55 | 701 |
| `s.rw = 3` | wk 11 | **37** | **425** |
| `detectedWeeklyKm = 70` (start ≥ peak → flat budget) | wk 14 | 55 | 701 |
| `onboarding.weeklyTrainingHours = 4` (tight cap) | **wk 5** ⚠️ | 50 | 662 |

- `rw=3` reproduces the user's low volume (~37 km peak / ~425 km).
- A tight **weekly-hours cap front-loads the peak** (wk 5 here; wk 2 on the user's plan). This is the "no arc / peak early" failure.

Normal-config weekly TSS (healthy shape — progressive + deloads at wk 4/8/12, peak wk14, taper):
```
421,470,432,[342],470,439,439,[388],450,448,493,[359],448,[497],322,301
```

### Peak-km week breakdown (rw=3 marathon, the user-like config)

Biggest-km week = wk 11, **37 km total**:
| Session | Prescription | km | min |
|---|---|---|---|
| Long run (fast finish) | "18km: last 4 @ MP" | 18 | **89** |
| VO2 builder | "5×4min @ 3:57 (~1km)" | ~10 | 48 |
| Easy run | "9km @ 4:54" | 9 | 46 |
| (+ gym, + cycling 60', + swim 45' — not run km) | | — | |

**The marathon long run tops out at ~18 km / 89 min.** That is the headline coaching problem.

---

## Root causes (with file:line)

### RC1 — Long run time-capped too low for the marathon
- `longRunMinutes(...)` `src/workouts/plan_engine.ts:181-204`: marathon base **90 min**, ramps 80%→100% over `totalWeeks*0.75`, ×1.05 in peak, then `Math.min` against an ability cap: `{ beginner:90, novice:100, intermediate:120, advanced:150, elite:180 }`.
- Same caps repeated in `computePeakWeeklyKm` `src/workouts/plan_engine.ts:596-600`.
- Net: an **intermediate** marathoner's long run maxes at **120 min ≈ 18-24 km**. Marathon-specific endurance generally needs the long run to build to **~150-180 min / 28-32 km**. The cap is appropriate for the half, too short for the marathon.
- **Fix direction:** make the long-run cap (and base) distance-aware — raise it materially for `raceDistance === 'marathon'` (e.g. intermediate → ~150-165 min). Justify against SCIENCE_LOG and add the rationale there. Mind durability/injury caps for low-baseline athletes.

### RC2 — Volume ramp goes flat under a tight cap → no arc, early peak
- `weekVolumeBudgetKm(weekIndex, baselineKm, peakKm, archetype)` `src/calculations/athlete-archetype.ts:347`:
  ```
  start = startingWeeklyKm(baselineKm, archetype)   // athlete-archetype.ts:324
  if (start >= peakKm) return peakKm                 // ← FLAT every week, no ramp
  return min(peakKm, start * (1 + weeklyRampPct)^(weekIndex-1))
  ```
- The effective budget is the **min** of that ramp and the user's hours target: `effectiveWeeklyBudgetMin` `src/workouts/plan_engine.ts:356-368` (`budget = min(rampBudgetMin, weeklyHoursTarget*60)`).
- When `weeklyHoursTarget` (or a high baseline) pins the budget at a constant, every week gets the **same** minute budget. The only week-to-week variation left is deloads + the independent long-run/quality minute ramps — so there is **no rising arc**, and the global max lands on whatever week the session-mix noise peaks (week 2 for this user).
- **Fix direction:** ensure the plan still *periodizes within the cap*. The weekly target should rise toward the cap across base→build→peak (then taper), rather than sitting flat at the cap from week 1. I.e. apply a phase/progression envelope to the *capped* budget, not just to the uncapped ramp.

### RC3 — Low run frequency starves marathon volume (and zeroes easy runs)
- `computePeakWeeklyKm` `src/workouts/plan_engine.ts:607`:
  ```
  easyCount = max(0, runsPerWeek - 2 - (marathon||half ? 1 : 0))
  ```
  For a **marathon at rw=3**: `easyCount = 3 - 2 - 1 = 0`. The peak week is long + quality only, no easy aerobic volume → low total, and the aerobic base a marathon needs is missing.
- **Fix direction:** this may be acceptable *if* the plan intends a minimalist 3-run model (with cross-training carrying aerobic load), but for a marathon it likely warrants either a higher recommended frequency, or counting the recurring cross-training aerobic volume toward the "is this enough base?" check. Decide the intended model with Tristan.

---

## Why the chart looks "jagged" (not a bug, but worth knowing)

`renderPhaseLoad` scales the line so the area fills from the line down to a **zero baseline** (`y(0)=100`). When the plan has **no arc** (RC2), the deload dips (every 3-4 wks, `isDeloadWeek` `plan_engine.ts:115-123`) become the *only* feature, so the line reads as random sawtooth rather than "build → recover → build → peak → taper." Fixing RC2 (a real arc) will make the same chart read as intentional. The sharp (un-smoothed) line is deliberate per Tristan (wants real week-to-week variation visible); there is a "Why does it vary?" explainer under the chart.

---

## Reproduction (vitest, jsdom)

Drop this in `src/calculations/_probe.test.ts`, run `npx vitest run src/calculations/_probe.test.ts`, then delete it:

```ts
// @vitest-environment jsdom
import { it } from 'vitest';
import { seedReviewerDemo } from '@/state/demo-data';
import { getMutableState } from '@/state/store';
import { derivePlanShape, plannedWorkoutKm } from '@/calculations/plan-shape';
import { generateWeekWorkouts } from '@/workouts';

it('probe', () => {
  seedReviewerDemo();
  const s = getMutableState();
  s.rw = 3;                                  // low frequency (user-like)
  // s.onboarding!.weeklyTrainingHours = 4;  // tight cap → front-loaded peak
  const sh = derivePlanShape(s);
  console.log('peakWk', sh.weeklyTss.indexOf(sh.peakTss) + 1, 'peakKm', sh.peakKm, 'total', sh.totalKm);
  console.log('tss', sh.weeklyTss.join(','));
  const wi = sh.weeklyKm.indexOf(sh.peakKm);
  const ws = generateWeekWorkouts(
    s.wks![wi].ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined, null,
    s.recurringActivities, s.onboarding?.experienceLevel, undefined, s.pac?.e,
    wi + 1, s.tw, s.v, s.gs, undefined, undefined, undefined,
    s.onboarding?.weeklyTrainingHours, s.onboarding?.runningExcludedWorkouts,
  );
  for (const w of ws) console.log(w.t, '|', w.d, '|', plannedWorkoutKm(w, s.pac?.e), 'km', w.estimatedDurationMin, 'min');
});
```

---

## Recommended fix order

1. **RC1 (long run cap, distance-aware)** — highest user impact, smallest blast radius. Marathon long run should build to ~28-32 km. Update `longRunMinutes` + the `longCap` in `computePeakWeeklyKm`. Log rationale in SCIENCE_LOG.
2. **RC2 (periodize under the cap)** — gives the plan an arc and a late peak; fixes the "peak at week 2" and the "jagged/random" perception. Touches `effectiveWeeklyBudgetMin` / how the budget is shaped per week+phase.
3. **RC3 (frequency/volume model for marathon)** — product decision: minimum recommended runs/week for marathon, or credit cross-training base. Needs Tristan's input.

Verify each with the repro above (peak week should move late; peak km + long run should rise). Re-run the full suite; note the one pre-existing stochastic flake in `race-forecast-simulation.test.ts` ("monotonic and smooth") is unrelated.

## Already done this session (do not redo)
- `plannedWorkoutKm` km-undercount fix (`plan-shape.ts`) + shared into `plannedWeekKm`.
- coach-contract page redesign (running/tri/HYROX), abstract TSS y-axis removed, subhead hidden when not personalised. TestFlight build uploaded.
