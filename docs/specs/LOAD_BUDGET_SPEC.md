# Load Budget & Excess Detection — Specification

**Status:** Design complete · Not yet built
**Date:** 2026-03-12
**Depends on:** Load System Spec (LOAD_SYSTEM_SPEC.md), Principles (PRINCIPLES.md §Three-Signal Load Model)

---

## 1. Problem Statement

The current excess load system only detects load from **unmatched activities** — cross-training
that didn't fit a plan slot. But a user who is 22% over their week target (e.g. 201/165 TSS)
gets no reduction prompt if all their activities happened to match plan slots.

Additionally:
- The plan bar compares Signal B actual vs Signal A planned (cross-signal mismatch)
- Recovery data (sleep, HRV) exists but doesn't influence reduction decisions
- The planned TSS target doesn't include expected cross-training load

This spec replaces the unmatched-item-only excess model with a **total week budget** model
where excess is detected from the full Signal B picture, reductions are sized with Signal A,
and recovery trends modulate aggressiveness.

---

## 2. Composite Planned Week TSS (Signal B target)

The plan bar target must be Signal B — total expected physiological load for the week,
including both running and cross-training.

### Formula

```
plannedSignalB = runningPlanTSS + crossTrainingBudget
```

**Running plan TSS** — unchanged from `computePlannedWeekTSS()`: Signal A baseline × phase
multiplier. This is already running-specific (runSpec = 1.0 for all running).

**Cross-training budget** — derived from the user's Strava history, per category:

#### Declared specific sports (padel, cycling, etc.)

```
budget += sportBaselineByType[sport].avgSessionRawTSS × sessionsPerWeek
```

`sportBaselineByType` is already computed in `stravaSync.ts` from the edge function's
`sportBreakdown` data — per-sport average session raw TSS and frequency per week.

#### Declared "General Sport"

```
budget += median(all non-running session rawTSS where duration ≥ 20min) × declared sessions/week
```

The general sport median is a blended average across all cross-training activity types.
This self-corrects as activities come in via `computeCrossTrainTSSPerMin`.

#### Fallback (no Strava history)

40 TSS per declared cross-training session. Roughly a moderate 60-minute cardio session.
Conservative enough to avoid over-budgeting, replaced as soon as real data arrives.

### Rolling recalculation

Recalculate the cross-training budget each time Strava history refreshes (on sync).
The plan bar target updates accordingly — it's always grounded in recent data.

---

## 3. Signal B Baseline — Median Per-Session

The athlete's "normal" load level. Used for excess detection and the plan bar reference.

### Why not simple average?

A simple average of weekly TSS gets dragged down by injury/rest/travel weeks. A user
who normally does 180 TSS/week but had 3 injury weeks at 20 TSS would show a baseline
of ~120 — causing phantom excess alerts when they return to normal training.

### Formula

```
sessions = all activities across history where duration ≥ 20min
perSessionAvg = {
  running:  median(running session rawTSS)
  [sport]:  sportBaselineByType[sport].avgSessionRawTSS  (already median-like)
  general:  median(all non-running session rawTSS)
}
expectedSessions = plan runs this week + cross-training sessions/week from sportBaselineByType
signalBBaseline = Σ(perSessionAvg[category] × expectedSessions[category])
```

This means the baseline **scales with the plan structure** — a deload week with fewer
planned sessions has a proportionally lower baseline, so returning to full training
doesn't look like a spike.

### Minimum session duration

20 minutes. Shorter activities (commute walks, warm-ups) are excluded from the
per-session average to avoid diluting it.

---

## 4. Excess Detection — Total Week Signal B

### Current (broken)

```
excess = TSS from unspentLoadItems only
```

Matched activities are invisible to excess detection.

### New

```
excess = computeWeekRawTSS(wk) − plannedSignalB
```

Where `plannedSignalB` is the composite target from §2. This captures ALL sources of
overshoot: matched activities that were harder than expected, extra sessions, heavier
cross-training — everything.

### Three-tier response (unchanged thresholds, new trigger)

| Tier | Condition | Response |
|------|-----------|----------|
| 1 — Auto-adjust | Excess ≤ 15 TSS | Silently reduce nearest unrated easy run. Log note. No popup. |
| 2 — Nudge card | Excess 15–40 TSS | Amber card: "X TSS above your usual week · Adjust plan." |
| 3 — Blocking modal | Excess > 40 TSS or ACWR elevated | Full reduction modal fires. |

The tier system stays the same — only the input changes from "unmatched scraps" to
"total week excess."

---

## 5. Reduction Sizing — Signal A with Recovery Modulation

When excess is detected (any tier), the reduction to running workouts is computed as:

```
reductionTSS = excess × weightedRunSpec × recoveryMultiplier
```

### Weighted runSpec

The excess came from a mix of activity types. Weight the runSpec by each activity's
contribution to the excess:

```
weightedRunSpec = Σ(activity.rawTSS × activity.runSpec) / Σ(activity.rawTSS)
```

For activities already in the week. This ensures:
- Excess from cycling (runSpec 0.55) → smaller run reduction
- Excess from extra running (runSpec 1.0) → full run reduction
- Excess from gym (runSpec 0.35) → modest run reduction

### Protection hierarchy (unchanged)

Reductions follow the existing priority order:
1. Easy runs — reduce distance first
2. Long run — reduce distance before removing
3. Threshold — downgrade intensity (threshold → MP) before cutting distance
4. VO2/Intervals — absolute last resort, downgrade intensity only

---

## 6. Recovery Trend Multiplier

### Data source

`physiologyHistory` from Garmin/watch sync. Contains daily entries with:
- `sleepScore` (0–100)
- `hrvRmssd` (ms)
- `restingHR` (bpm)

Already consumed by `computeRecoveryScore()` in `readiness.ts`.

### 5-day rolling trend

```
recoveryTrend = computeRecoveryScore(physiologyHistory.slice(-5)).score
```

Uses the existing weighted composite (HRV 45%, Sleep 35%, RHR 20%) over the most
recent 5 days. A single bad night is diluted by 4 other days. Three bad nights
dominate the window.

### Multiplier mapping

| Recovery trend | Multiplier | Meaning |
|---------------|------------|---------|
| ≥ 70 | 1.00 | Normal — no extra reduction |
| 50–69 | 1.15 | Mildly suppressed recovery — reduce 15% more |
| 30–49 | 1.30 | Poor recovery trend — reduce 30% more |
| < 30 | 1.50 | Serious recovery deficit — reduce 50% more |

### Guardrail

Cap the recovery multiplier effect at **+20 TSS** of additional reduction beyond what
load excess alone would prescribe. Prevents catastrophic over-reduction from bad
recovery + large excess compounding.

### When recovery data is unavailable

Multiplier = 1.0. No penalty, no bonus. The system degrades gracefully for users
without a connected watch.

---

## 7. Plan Bar Display

The plan page bar becomes consistently Signal B:

```
WEEK LOAD (TSS) 201 / 270 →
[████████████░░░░░░░]
```

Where:
- **201** = `computeWeekRawTSS(wk)` — Signal B actual (unchanged)
- **270** = `plannedSignalB` — running plan + cross-training budget (§2)

Running km is already shown separately. The load bar answers "how hard is my body
working this week?" — honest, total, Signal B.

### Load breakdown sheet (tap the bar)

Already exists. Should show the composite breakdown:
- Running: X TSS (planned Y)
- Cross-training: X TSS (expected Y based on your history)
- Total: X / Y

---

## 8. Data Dependencies

| State field | Source | Status |
|-------------|--------|--------|
| `historicWeeklyRawTSS` | Strava edge fn `history` mode | ✅ Populated |
| `signalBBaseline` | Computed in `stravaSync.ts` | ✅ Exists — needs formula update (§3) |
| `sportBaselineByType` | Computed in `stravaSync.ts` | ✅ Exists — unused by plan bar |
| `physiologyHistory` | Garmin/watch sync | ✅ Populated |
| `computeRecoveryScore()` | `readiness.ts` | ✅ Exists — not wired to reductions |

No new edge functions required. No new Supabase migrations. All data is already on state.

---

## 9. Files to Change

| File | Change |
|------|--------|
| `src/calculations/fitness-model.ts` | New `computePlannedSignalB()` that combines running plan + cross-training budget. Update `getWeeklyExcess()` to use total Signal B excess. |
| `src/data/stravaSync.ts` | Update `signalBBaseline` computation to use per-session median (§3) instead of simple weekly average. |
| `src/ui/plan-view.ts` | Plan bar uses `computePlannedSignalB()` instead of `computePlannedWeekTSS()`. |
| `src/ui/excess-load-card.ts` | Excess card triggers from total excess, not just `unspentLoadItems`. |
| `src/cross-training/suggester.ts` | Accept `recoveryMultiplier` param, apply to reduction sizing. |
| `src/calculations/readiness.ts` | Export `computeRecoveryTrend(history, days=5)` → returns multiplier. |
| `src/ui/home-view.ts` | Load breakdown sheet shows composite planned breakdown. |

---

## 10. Future Work (not in this build)

- **"Baseline calibrated" notification**: One-time card after first Strava history pull —
  "We found 8 weeks of training. Your typical weekly load is ~X TSS across Y sports."
  Log as OPEN_ISSUES.
- **Per-sport excess detection**: When `sportBaselineByType` has enough data, detect
  excess per sport type rather than weekly-total-only (e.g. "your padel was unusually
  heavy this week").
- **Baseline trend display**: Show the athlete their Signal B baseline trend over time
  on the stats page, so they can see their "normal" shifting as fitness builds.

---

## 11. Design Principles (cross-reference)

- **Detect with Signal B, reduce with Signal A** — your body's fatigue is total, but
  running reductions should respect sport-specific transfer (PRINCIPLES.md §Three-Signal Model)
- **No cross-signal comparisons** — plan bar is Signal B vs Signal B (PRINCIPLES.md §D4)
- **Recovery modulates, doesn't dominate** — trend-based (5-day), capped, graceful
  degradation without watch data
- **Per-session median, not weekly average** — resistant to injury gaps, travel weeks,
  anomaly weeks; scales with plan structure
- **General Sport fallback** — blended median across all non-running activities;
  default 40 TSS/session when no history exists
