# Strain Score

Design reference for the Strain ring on the Home tab. Read this before modifying the strain calculation, target logic, or readiness interaction.

---

## What is it?

Strain answers: "How much of today's planned physical output have you already done?"

It is a percentage — today's completed Signal B TSS divided by the day's target TSS.

- **0%** — no activity logged yet (or rest day with no baseline load either)
- **100%** — you've completed what was planned for today
- **> 100%** — went beyond plan (hard session, added cross-training, etc.)

It is displayed as a second SVG arc ring next to the Readiness ring on the Home page.

---

## Signal: Signal B (not Signal A)

Strain uses **Signal B** (raw physiological load, no runSpec discount). This means:

- A 60-minute padel session and a 60-minute easy run at the same intensity contribute equally.
- Cross-training, gym sessions, and runs all count at full physiological weight.
- This is the right signal for "how hard did your body work today" regardless of sport.

Signal A (run-equivalent, runSpec-discounted) is used for CTL/fitness. Do not use it here.

---

## Target TSS

**Primary target**: today's planned workout TSS, estimated from the generated week workouts.

`computePlannedDaySignalBTSS(workouts, dayOfWeek)` filters to workouts scheduled for today's day-of-week and sums: `RPE × TL_PER_MIN[RPE] × parsedDurationMin` for each. This is the same RPE fallback used in `computeTodaySignalBTSS` when no HR data is available.

**Fallback target**: `signalBBaseline ÷ 7` (weekly average load divided by 7). Used on rest days when no workouts are scheduled for today.

### Why this matters

Before this fix, the target was always `signalBBaseline ÷ 7` (a flat ~40 TSS for a typical recreational runner). On a planned long run day (120 TSS), this made strain read 300% before the session finished, flooring readiness at Ease Back incorrectly. Using the planned workout TSS as the target means 100% = "you did what was planned", which is the semantically correct interpretation.

---

## Readiness interaction

Strain applies a **floor** to the composite readiness score after all other sub-signals are computed.

| Strain % | Readiness floor |
|----------|----------------|
| 0–50%    | No effect (session hasn't reached the halfway point) |
| 50–100%  | Slides linearly: 100 → 59 (session in progress — getting close to target) |
| 100–130% | ≤ 59 (Manage Load — daily target hit, don't push more) |
| > 130%   | ≤ 39 (Ease Back — well exceeded target) |

### Sentence override

When training has occurred today, the TSB/ACWR matrix sentence is replaced with a strain-specific message:

| Condition | Sentence |
|-----------|----------|
| Strain ≥ 130% | "Daily load exceeded target. Additional training today raises injury risk." |
| Strain ≥ 100% | "Daily target hit. Training is complete for today." |
| Strain > 0% (any training) | "Session logged. Rest for the remainder of the day." |
| No training | TSB/ACWR matrix sentence (from `SENTENCES` map in `readiness.ts`) |

This prevents contradiction between a high readiness label (from TSB/ACWR) and a "session complete" state.

---

## Key files

| File | Role |
|------|------|
| `src/calculations/fitness-model.ts` | `computeTodaySignalBTSS(wk, today)` — actual load; `computePlannedDaySignalBTSS(workouts, dayOfWeek)` — target load |
| `src/calculations/readiness.ts` | `computeReadiness()` — strain floor logic (lines 224–236); `strainPct` input field |
| `src/ui/home-view.ts` | `buildReadinessRing()` — wires both functions, renders the strain ring SVG and sentence |

---

## Known gaps

### 1. ~~Passive strain not contributing to TSS~~ ✅ Wired in
Non-workout active minutes now contribute passive TSS via `PASSIVE_TSS_PER_ACTIVE_MIN = TL_PER_MIN[2] = 0.45` in `fitness-model.ts`.

**Data source**: Garmin epoch summaries (15-min windows) classify each period as SEDENTARY / ACTIVE / HIGHLY_ACTIVE. The edge function `sync-today-steps` sums `activeMinutes` and `highlyActiveMinutes` across all epochs. Called on launch and foreground resume.

**Double-counting prevention**: `computeTodaySignalBTSS` tracks total workout duration from garminActuals + adhocWorkouts. Passive active minutes = `max(0, activeMinutes - workoutMinutes)`. Only the non-workout remainder contributes passive TSS.

**Why active minutes, not steps**: Steps double-count (running generates ~170 steps/min that would be counted in both workout iTRIMP and step TSS). Active minutes can be cleanly subtracted from because workout duration is known.

| Passive active min | Passive TSS |
|-------------------|------------|
| 30 (office worker) | ~14 |
| 60 (light commuter) | ~27 |
| 90 (city walking) | ~41 |
| 120 (very active) | ~54 |

**Display**: strain ring shows `X steps · Ymin active` below the TSS number. Steps are display-only context; active minutes drive the TSS contribution.

### 2. ~~No logarithmic scaling~~ ✅ Fixed
Two strain percentages are now computed:
- **`strainPctLinear`** (actual/target × 100) — used for readiness floor thresholds, coach context, and colour/label logic. These are physiological decisions that need real load ratios.
- **`strainPctLog`** (log(1+actual)/log(1+target) × 100) — used for ring fill only. Early effort registers visually (20/100 TSS → ~38% fill), exceeding target grows slowly (130% linear → ~107% log fill).

The invariant is preserved: 0 actual → 0%, target actual → exactly 100%. Matches WHOOP/Bevel logarithmic strain display.

### 3. Planned workout TSS is estimated, not exact
`computePlannedDaySignalBTSS` uses the RPE × TL_PER_MIN × duration fallback. This is the same fallback used for actual training when no HR data is available — it's accurate to ±20%. For athletes with Garmin/Strava HR data, the actual TSS (iTRIMP-based) will differ from the planned estimate, causing the ring to read slightly above or below 100% even on a perfectly executed session.

Fix (future): once a session is completed with iTRIMP data, treat the actual iTRIMP as the target retroactively (i.e., the target adjusts to actual on completion). This would make 100% = "session matched its own effort level" rather than "matched the pre-session RPE estimate".

### 4. No tests for strain functions
`computeTodaySignalBTSS` and `computePlannedDaySignalBTSS` have no unit tests. The readiness strain floor has no dedicated test case either (covered only indirectly via integration through `computeReadiness`).

Fix: add to `src/calculations/fitness-model.test.ts` and `src/calculations/readiness.test.ts`.

### 5. ~~Rest days show 0% with no target context~~ ✅ Fixed
- Training day with nothing logged: shows the planned TSS target number prominently ("85 / TSS target / Not started").
- Rest day (`plannedDayTSS === 0`): shows "Rest / No sessions today" — clearly not a missed session.
