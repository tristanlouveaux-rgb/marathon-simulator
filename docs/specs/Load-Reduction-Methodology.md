# Load Reduction Methodology

> How Mosaic quantifies cross-training fatigue and translates it into proportional,
> mathematically-grounded reductions to planned running sessions.

---

## Philosophy

Three principles drive the system:

1. **Proportionality** — reductions are continuously proportional to actual fatigue, not bucketed into coarse severity tiers. A ratio of 0.18 produces a different outcome from 0.19.
2. **Physiological priority** — the reduction strategy respects training science: protect the most adaptive sessions, cut the cheapest load first, never destroy the long run.
3. **Transparency** — every user sees exactly what changed and why, with the numbers shown, and the ability to override the suggested approach.

---

## 1. Signal Hierarchy — How Fatigue Is Computed

FCL (Fatigue Cost Load) is computed from the best available data. The system always uses the highest available tier.

### Tier A — Garmin Training Effect + HR (most accurate)

When `aerobic_effect`, `anaerobic_effect`, and HR data are all present:

```
TRIMP = duration_min × karvonen_intensity × sport_transfer_factor

karvonen_intensity = (avg_hr − resting_hr) / (max_hr − resting_hr)

FCL = TRIMP × (aerobic_weight × aerobic_effect + anaerobic_weight × anaerobic_effect)
```

TRIMP (Training Impulse) is the standard physiological metric for session load — duration weighted by cardiovascular intensity. Garmin's Training Effect values calibrate the result.

### Tier B — HR only (no Garmin Training Effect)

When HR data is available but `aerobic_effect` / `anaerobic_effect` are null:

```
FCL = duration_min × karvonen_intensity × sport_transfer_factor × 0.92
```

The 0.92 factor is a small uncertainty discount for missing Training Effect data.

### Tier C — RPE only (estimated)

When only RPE is available (manual logging, no HR from Garmin):

```
FCL = duration_min × rpe_intensity_rate × sport_transfer_factor × 0.85
```

The 0.85 factor reflects higher uncertainty. The UI flags this to the user:
> *"Load estimate — no HR data available."*

---

## 2. Sport Transfer Factors

Not all cross-training stresses the running system equally. Transfer factors from `SPORTS_DB` represent how much of an activity's fatigue transfers into running-specific physiological systems (legs, cardiovascular, neuromuscular).

| Sport category | Transfer range | Rationale |
|----------------|---------------|-----------|
| Running (treadmill, trail, track) | 1.00 | Direct transfer |
| HIIT / functional training | 0.75–0.80 | High cardiovascular + leg recruitment |
| Cycling | 0.60–0.70 | Strong cardiovascular, low running-muscle specificity |
| Swimming | 0.50–0.60 | Cardiovascular yes, leg impact minimal |
| Racket sports (tennis, squash, padel, pickleball) | 0.40–0.55 | Mixed intensity, lateral movement, intermittent |
| Team sports (football, rugby, basketball) | 0.45–0.55 | Intermittent high intensity, variable |
| Yoga / pilates | 0.15–0.25 | Low cardiovascular demand |
| Walking / hiking | 0.20–0.35 | Low intensity, some leg load |

Example: 60 minutes of cycling produces roughly 60–70% of the FCL of 60 minutes of easy running.

---

## 3. Slot Matching — What Creates Overflow

**Load reduction only applies to overflow** — activities that could not be matched to a planned slot. The matching hierarchy runs silently before any load calculation:

| Priority | Activity type | Matched against |
|----------|--------------|-----------------|
| 1 | Runs | Planned run workouts (distance + day proximity) |
| 2 | HIIT / strength training | Planned gym sessions |
| 3 | Named sport (e.g. Tennis) | Matching recurring activity slot |
| 4 | Any sport | Generic cross slot (closest by day) |
| 5 | **Overflow** | → FCL calculated → load reduction applied |

Matched activities complete their planned slot silently. Only the overflow remainder enters the load reduction pipeline.

**In a flowing week** (single new activity, same day): matching is silent, load modal appears only if there is overflow. No review screen.

**Backlog** (≥3 unreviewed activities OR oldest activity >24h old, OR first sync): Activity Review screen for batch processing, then matching confirmation, then load modal for overflow.

---

## 4. FCL Ratio

The FCL ratio is the single number that drives all reductions:

```
FCL ratio = overflow_FCL / total_planned_weekly_run_load
```

Where:
- **overflow_FCL** = FCL from activities that didn't match any planned slot
- **total_planned_weekly_run_load** = sum of all planned run workout loads for the week (from `calculateWorkoutLoad()`)

### Zones (illustrative only — not hard boundaries in the code)

| Zone | FCL Ratio | Plain English |
|------|-----------|--------------|
| Trace | 0–15% | One tennis hit. Barely registers. |
| Moderate | 15–35% | Solid sport session. Real fatigue. |
| Significant | 35–55% | Heavy cross-training day. Plan adjustment needed. |
| Heavy | 55%+ | Multiple sessions or a tournament. Major restructure. |

These labels are used in user-facing communication only. The algorithm treats the ratio as fully continuous.

---

## 5. Runner Type × Sport Type Weight Matrix

The FCL ratio budget is split between **volume reduction** (cutting km) and **intensity reduction** (downgrading session quality). The split depends on two factors: runner type and the nature of the cross-training.

### Runner type base weights

| Runner type | Volume weight | Intensity weight | Rationale |
|-------------|--------------|-----------------|-----------|
| Endurance | 0.35 | 0.65 | Protect mileage base; downgrade intensity first |
| Speed | 0.65 | 0.35 | Protect quality sessions; cut easy volume first |
| Balanced | 0.50 | 0.50 | Equal priority |

### Sport type bias

The nature of the cross-training activity biases the weights further:

| Sport category | Volume bias | Intensity bias | Rationale |
|----------------|------------|---------------|-----------|
| High-intensity (HIIT, boxing, martial arts) | +0.15 | −0.15 | Neurological fatigue → protect quality |
| High-volume aerobic (cycling 60min+, swimming) | −0.15 | +0.15 | Cardiovascular fatigue → protect mileage |
| Mixed (padel, football, tennis, team sports) | 0 | 0 | No directional bias |

### Final weights

```
final_volume_weight   = clamp(runner_volume_weight + sport_volume_bias, 0.20, 0.80)
final_intensity_weight = 1 - final_volume_weight
```

### Communicating the mode

The UI shows the user which mode is active and why:

> *"As an endurance runner who just did a high-intensity session, we're focusing on maintaining your mileage base this week."*

The user can override to "balanced" mode via a tap — they are then treated as a balanced runner for this session only.

---

## 6. Proportional Reduction Algorithm

### Step 1: Compute load to remove

```
total_load_to_remove     = FCL_ratio × total_planned_run_load
volume_load_to_remove    = total_load_to_remove × final_volume_weight
intensity_load_to_remove = total_load_to_remove × final_intensity_weight
```

### Step 2: Volume reductions

Runs are processed in priority order (cheapest physiological cost first):

1. Easy runs
2. Long run (shortened only — see protection rules)
3. Quality sessions (only if volume budget still unmet after easy runs and long run)

For each run in order:

```
load_per_km  = run_load / planned_km
km_to_remove = volume_load_to_remove × (run_load / total_run_load) / load_per_km
new_km       = planned_km − km_to_remove
new_km       = max(new_km, 30min_at_easy_pace)   // 30-minute floor
new_km       = round(new_km × 2) / 2             // round to nearest 0.5km
```

If `new_km` would breach the 30-minute floor, the run becomes a **replacement candidate** (the cross-training activity substitutes for it entirely).

Short sessions that land near the floor are padded using the existing WU/CD logic to maintain minimum movement time.

### Step 3: Intensity reductions

**Pace ladder** (fastest → slowest):

```
VO2max → threshold → marathon pace* → steady → easy
```

*For non-marathon users: "marathon pace" is displayed as "long run pace." Internal type is unchanged.*

**Steady** is defined as the midpoint between marathon pace and easy pace:

```
steady_pace_sec_km = (marathon_pace_sec_km + easy_pace_sec_km) / 2
```

For each quality session targeted for intensity reduction:

```
step_load_delta = load_at_current_type − load_at_next_type_down
steps_needed    = intensity_load_to_remove / avg_step_delta
```

If `steps_needed` is a whole number: take exactly that many steps down the ladder.

If `steps_needed` is fractional (e.g. 1.3 steps):
- Take the whole part (1 full step, e.g. VO2 → threshold)
- Apply the fractional remainder (0.3) as a **session split**:

```
fraction_at_lower = 0.3   // 30% of session at the next step down
fraction_at_upper = 0.7   // 70% stays at the stepped-down pace
```

**For interval sessions:**

```
reps_at_lower = round(fraction_at_lower × total_reps)
reps_at_upper = total_reps − reps_at_lower

Display: "5×3min — first 3 reps at threshold (4:05/km), last 2 at marathon pace (4:28/km)"
```

**For continuous runs:**

```
km_at_lower = round(fraction_at_lower × total_km × 2) / 2   // 0.5km resolution
km_at_upper = total_km − km_at_lower

Display: "13km at marathon pace (4:17/km), last 5km at steady (4:48/km)"
```

Once a session has been stepped all the way to easy, it cannot be degraded further in quality. If intensity budget is still unmet, that session becomes a replacement candidate.

### Step 4: Protection rules (always enforced, override algorithm)

- **Long run**: shortened only. Floor at 60% of planned distance. Never replaced. Never degraded beyond one intensity step.
- **2 protected runs**: the long run plus the week's primary quality session receive at most one intensity step downgrade and no volume cut.
- **Easy runs**: not aggressively targeted — they are cheap aerobic mileage. Cut only after the volume budget demands it.
- **Minimum session**: no run drops below 30 minutes at easy pace equivalent.

### Step 5: Replacement (last resort only)

Replacement triggers only when:
- A run would breach the 30-minute floor to meet the volume budget, **or**
- A session has been stepped to easy and intensity budget is still unmet

When replaced: the cross-training activity substitutes for the run. The run is marked `status: 'replaced'`. The workout card shows *"Replaced by [activity name]"* with an undo button.

---

## 7. Pace Display Format

| Context | Display |
|---------|---------|
| Named pace, exact match | `"threshold (4:05/km)"` |
| Named pace, marathon runners | `"marathon pace (4:17/km)"` |
| Named pace, non-marathon runners | `"long run pace (4:17/km)"` |
| Easy runs | `"easy — no faster than 5:30/km"` |
| Steady (computed midpoint) | `"steady (4:48/km)"` |
| Blended between named paces | `"13km at marathon pace (4:17/km), last 5km steady (4:48/km)"` |
| Blended — fractional reps | `"3×400m at 3:00/km, 2×400m at 3:45/km"` |
| Custom / intermediate pace | `"4:52/km"` (no name label needed) |

---

## 8. Skip Cascade

When weeks are advanced past without completion (real-calendar gap detected via `planStartDate`):

| Gap | Action |
|----|--------|
| 1 week | Detraining `wkGain` applied (−0.03 to −0.08 depending on phase). All workouts marked skipped. Forecast recalculates. |
| 2 weeks | Same + "aerobic base reducing" flag shown in forecast. |
| 3 weeks | Detraining + 1 return week inserted (reduced volume, easy runs only, no quality sessions). |
| 4+ weeks | Detraining + 2-week return block. |

Return weeks are generated by the plan engine (not the injury engine — no pain protocol). Volume target: `detraining_model_output × 0.70`.

If historic Garmin data exists for skipped weeks: auto-pair silently, show a summary to the user, apply detraining reduction proportionally to the matched load.

---

## 9. Communication

### Progress (paces improving, VDOT trending up)

All experience levels see VDOT and load numbers. Wording adapts:

| Experience level | Message |
|-----------------|---------|
| Beginner / recreational | *"You're getting fitter — great work! Your sessions will keep progressing."* |
| Intermediate / advanced | *"Fitness trending up. Paces updated."* |
| Elite / hybrid / returning | *"VDOT +1.2 this week. Paces updated."* (data-first) |

### Overtraining signal

Fires when RPE is consistently above planned across multiple sessions AND physiological data (HR, HR drift, recovery scores) confirms the pattern:

> *"You've been pushing hard in training recently. We're pulling back slightly this week to let your body absorb the work."*

Load silently reduced. No alarm. No dwelling on it.

### Pace adjustment (downward)

Always silent for all experience levels. Paces simply update.

### Load reduction from cross-training

- Show runner type mode and why: *"As an endurance runner who did a high-intensity session, we're prioritising your mileage base."*
- Show the specific changes: *"Thursday threshold → steady (4:48/km) · Long Run 18km → 14km"*
- Allow override of mode to "balanced" for this session.
- Flag estimated load where applicable: *"Load estimate — no HR data available."*

---

## 10. `planStartDate` and Week Date Ranges

`planStartDate` (ISO date string) is stored on `SimulatorState` and set when the plan is initialised. Every week's date range is derived from it:

```
week_start = planStartDate + (week_number − 1) × 7 days
week_end   = week_start + 7 days
```

This replaces the previous race-date-derived calculation and works for both marathon plans and continuous mode users.

For users without a stored `planStartDate` (migration): derive as `today − (s.w − 1) × 7`.

---

## 11. Files

| File | Role |
|------|------|
| `src/cross-training/universalLoad.ts` | FCL calculation (Tier A/B/C), sport transfer factors |
| `src/cross-training/suggester.ts` | Proportional reduction algorithm, fractional blending, protection rules |
| `src/calculations/activity-matcher.ts` | Slot matching, auto-process vs batch detection |
| `src/ui/activity-review.ts` | Batch review screen (backlog path only) |
| `src/data/activitySync.ts` | Sync trigger, batch detection threshold |
| `src/state/initialization.ts` | `planStartDate` initialisation |
| `src/types/state.ts` | `planStartDate`, updated `Week` fields |
| `src/ui/renderer.ts` | Mon–Sun week header, workout card labels with `modReason` |
| `src/ui/suggestion-modal.ts` | Load summary display, named pace format, per-session overrides |
| `src/workouts/load.ts` | Pace ladder load deltas (used by intensity reduction) |
