# Strain Ring Redesign — Target Strain + Passive Strain

**Status**: Built — Pieces 1-7 implemented. Ring redesign, target TSS, passive strain, calibration, Apple Watch exercise minutes all wired.
**Date**: 2026-04-09

---

## Summary

The strain ring changes from "actual as % of plan" to a **total load ring** with a **target marker**. Passive activity (steps, active minutes from unlogged movement) now contributes to actual strain. The target adjusts based on readiness label. Auto-scaling ring never overflows.

---

## Piece 1 — Ring redesign (`strain-view.ts`)

**Current**: ring fills 0-100% where 100% = planned session TSS.

**New**: ring shows absolute TSS with a target marker.

- **Ring scale**: `ringMax = max(2 x target, actual x 1.25)` — auto-scales so the ring never overflows
- **Target marker**: white dot on the ring arc at the target TSS position. Amber on Manage Load, red on Ease Back/Overreaching. Hidden on rest days with no target.
- **Inner content**: actual TSS number (not %) + "Target X TSS" label below
- **Coaching text**: minimal changes (already uses TSS numbers)
- **Below target**: target marker sits at ~50% of ring (2x target = full ring). Clear visual gap to fill.
- **Exceeding target**: ring fills past the marker. Auto-scales if actual > 2x target (20% visual headroom beyond current fill).

## Piece 2 — Target TSS formula (new function in `fitness-model.ts`)

```
computeDayTargetTSS(plannedDayTSS, readinessLabel, perSessionAvg, isRestDay) -> number
```

### Training days

| Readiness       | Score    | Target                | Visual        |
|-----------------|----------|-----------------------|---------------|
| Ready to Push   | >= 80    | plannedDayTSS         | White marker  |
| On Track        | 60-79    | plannedDayTSS         | White marker  |
| Manage Load     | 40-59    | plannedDayTSS         | Amber marker  |
| Ease Back       | < 40     | plannedDayTSS x 0.80  | Red marker    |
| Overreaching    | ACWR     | plannedDayTSS x 0.75  | Red marker    |

Science: Buchheit & Laursen (2013) autoregulation; Halson (2014) 20-30% load reduction on suppressed recovery markers; Gabbett (2016) ACWR spike model.

On unplanned/adhoc days: use `perSessionAvg` as the base target instead of `plannedDayTSS`.

### Rest days

```
restDayTarget = perSessionAvg x 0.30
```

Science: Menzies (2010) — active recovery at ~30% of training load improves next-day performance vs complete rest. Overreach threshold stays at `perSessionAvg x 0.33` (Whoop ~33% recovery-day cap, Seiler Zone 1 ≈ 25-35% of hard session).

## Piece 3 — Apple Watch exercise minutes sync (`appleHealthSync.ts`)

Add HealthKit `appleExerciseTime` (Exercise ring) to the physiology sync. One extra `Health.queryAggregated` call. Store as `activeMinutes` in `physiologyHistory` (same field Garmin epoch data uses).

Apple Watch exercise minutes = periods where HR was in exercise zone. Consistent across logged/unlogged activities (no epoch sampling issue like Garmin).

## Piece 4 — Passive TSS calculation (new function in `fitness-model.ts`)

```
computePassiveTSS(date, physiologyHistory, garminActuals, tssPerActiveMinute) -> number
```

**Two signals, take the higher:**

### Signal A — passive steps (all devices)
- `totalSteps = physiologyHistory[date].steps`
- Subtract logged workout steps: `loggedSteps = sum(activity.durationMin x cadence)` where cadence = 170 spm running (Cavanagh & Kram 1989), 110 spm walking (Himann 1988), 0 for cycling
- `passiveSteps = max(0, totalSteps - loggedSteps)`
- `passiveTssFromSteps = passiveSteps / 1000` (1 TSS per 1,000 passive steps — Banister TRIMP derivation at Zone 1 HR, documented in SCIENCE_LOG)

### Signal B — passive active minutes (all devices)
- `totalActiveMin = physiologyHistory[date].activeMinutes`
- Subtract logged workout duration: `loggedMin = sum(activity.durationSec / 60)`
- `passiveActiveMin = max(0, totalActiveMin - loggedMin)`
- `passiveTssFromMinutes = passiveActiveMin x tssPerActiveMinute`

### Combined
```
passiveTSS = max(passiveTssFromSteps, passiveTssFromMinutes)
```

- Steps catch low-intensity movement (long walk, errands)
- Active minutes catch high-intensity unlogged activity (dancing, yoga)
- No calorie subtraction anywhere — eliminates double-counting risk

### Signal B total for display
```
totalStrainTSS = loggedActivitySignalBTSS + passiveTSS
```

Passive TSS feeds into Signal B (ACWR, readiness, freshness). The smoothing layers (42-day CTL EMA, rolling ACWR) dampen daily step noise.

## Piece 5 — Personal TSS-per-minute calibration (new function + state field)

```
calibrateTssPerActiveMinute(wks, normalizer) -> number | null
```

- Scans `garminActuals` with `iTrimp > 0` AND `durationSec > 900`
- Computes `tss_i = normalizeiTrimp(iTrimp_i)` and `ratio_i = tss_i / (durationSec_i / 60)`
- Returns `median(ratio_i)` if >= 5 samples, else null
- Existing pattern: mirrors `computeCrossTrainTSSPerMin`
- Called on startup + after each activity sync
- Stored as `s.tssPerActiveMinute`

Fallback if insufficient data: use `TL_PER_MIN` constant already in codebase.

## Piece 6 — State additions (`types/state.ts`)

```typescript
tssPerActiveMinute?: number;   // personal TSS per active minute, calibrated from logged activities
```

`physiologyHistory[].activeMinutes` already exists for Garmin.
Apple Watch: `activeMinutes` populated by Piece 3.

## Piece 7 — Double-counting prevention

No calorie subtraction anywhere. Only two subtractions:
1. **Steps**: `passiveSteps = totalSteps - loggedWorkoutSteps` (cadence x duration estimate — worst case off by ~2-3 TSS)
2. **Minutes**: `passiveMinutes = totalActiveMinutes - loggedWorkoutMinutes` (simple duration subtraction — reliable)

Both subtractions are floored at 0. Errors are small and bounded.

---

## Files touched

| File | Change |
|---|---|
| `src/data/appleHealthSync.ts` | Add `appleExerciseTime` query, write to `activeMinutes` |
| `src/types/state.ts` | Add `tssPerActiveMinute` |
| `src/calculations/fitness-model.ts` | Add `computeDayTargetTSS`, `computePassiveTSS`, `calibrateTssPerActiveMinute` |
| `src/ui/strain-view.ts` | Ring redesign, target marker, auto-scale, passive TSS in totals |
| `src/main.ts` | Call `calibrateTssPerActiveMinute` on startup + after sync |
| `docs/SCIENCE_LOG.md` | Document all formulas and constants |
| `docs/FEATURES.md` | Update strain feature entry |
| `docs/CHANGELOG.md` | Add session entry |
| `docs/ARCHITECTURE.md` | Add new state fields |

---

## Constants requiring sign-off

| Constant | Value | Source |
|---|---|---|
| Ease Back multiplier | 0.80 | Halson (2014) |
| Overreaching multiplier | 0.75 | Gabbett (2016) |
| Rest day target | perSessionAvg x 0.30 | Menzies (2010) |
| Steps per 1000 → TSS | 1.0 | Banister TRIMP Zone 1 derivation |
| Running cadence (for subtraction) | 170 spm | Cavanagh & Kram (1989) |
| Walking cadence (for subtraction) | 110 spm | Himann (1988) |
| Min calibration samples | 5 | Pragmatic threshold |
