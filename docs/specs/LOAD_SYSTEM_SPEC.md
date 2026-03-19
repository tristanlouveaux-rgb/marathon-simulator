# Load System Rebuild — Full Specification

**Status:** Phase A ✅ · Phase B ✅ · Phase B v2 ✅ · Phase B v3 backend ✅ · Phase B v3 UI ✅ · Phase C1 backend ✅ · Phase C1 UI ✅ · Phase C2 ✅ · Phase C3 ✅ · ACWR-aware week generation ✅ · iTRIMP calibration from Strava labels ✅
**Date:** 2026-03-02
**Scope:** TSS unification, ACWR injury risk, Strava history → smarter plans, athlete tier detection, HR zone matching for cross-training replacement, Volume ACWR bar.

> **UX design phase: complete.** No further UX redesign work is planned. All remaining items below are backend or product logic gaps.

---

## 0. Remaining Gaps (not yet built)

The phase-level milestones above are complete, but the following sub-features within those phases were never implemented:

| # | Section | Gap | Priority |
|---|---------|-----|----------|
| 1 | §12.9 | ~~**Load History Chart**~~ ✅ Done — stacked area chart (aerobic/anaerobic split), time range selector (8w/16w/all). See §12.9. | High |
| 2 | §5.6 | ~~**Minimum running km floors**~~ ✅ Done — goal-time-scaled floor, linear ramp, 2-week nudge in volume bar | High |
| 3 | §8 | ~~**5-rule plain language reduction logic**~~ ✅ Done — all 5 rules in ACWR modal header (intensity spike / km spike / cross-training spike / consecutive / trailing zone) | Medium |
| 4 | §6.5 | ~~**"Already completed" + "no matching run" modal flows**~~ ✅ Done — edge case panels with [Apply to next week] / [Log load only] buttons | Medium |
| 5 | §6.3 | **Stage 2 ongoing iTRIMP refinement** — update thresholds from each confirmed planned workout with Strava match (Stage 1 calibration from labelled history is done) | Low |
| 6 | §2 | **Athlete tier auto-update suggestion** — surface "Your training suggests you may be [Tier] — update?" when CTL sits above/below tier range for 3+ consecutive weeks | Low |
| 7 | §13 | **Phase E: History-aware plan initialisation** — use `ctlBaseline` and `historicWeeklyZones` to suggest `rw` (runs/week) and intensity distribution at plan start. Currently only weekly km (`wkm`) is seeded from history; runs/week and zone balance are not. See §13 below. | Medium |

### Supabase deployment required (your action)

The `calibrate` edge function mode (iTRIMP threshold calibration from workout names) depends on an `activity_name` column that was added in migration `supabase/migrations/20260302_activity_name.sql`. This migration has **not been applied** to the production database. Until deployed:
- `calibrate` mode returns no results
- `s.intensityThresholds` stays at defaults (70/95 TSS/hr)
- Stage 1 iTRIMP calibration silently no-ops

The `history` mode (8-week training load pull, plan seeding) reads from existing `garmin_activities` rows — **no migration needed**, works as soon as the edge function is deployed.

---

## 1. Overview & Goals

The current system has three incompatible load scales (FCL / universal load / TL), no injury risk signal, and a plan that ignores the athlete's actual training history. This rebuild fixes all three in sequential phases.

**Goals:**
1. One unified load unit (TSS) across every screen
2. An injury risk indicator driven by Acute:Chronic Workload Ratio (ACWR)
3. Strava history used to personalise plan volume, ramp rate, and load thresholds
4. Athlete tier auto-detected from history, surfaced to user, used throughout
5. HR zone matching (via iTRIMP) for cross-training replacement decisions
6. Volume ACWR (running km) as second injury signal — mechanical stress
7. Multi-sport support without making athletes feel "behind" on running
8. Update this file when features are complete and output following the completion of a section should tell user what to see and test

**Principles:**
- Always show reasoning — every load decision the app makes is explained in plain language
- Users can always override — "See details" and "Reduce this week" are always accessible
- Beautiful > clever — clear labels, coloured bars, plain English over abbreviations
- Multi-sport first — cross-training is a full citizen, not an afterthought
- This will be an iOS app — mobile-first UX throughout
- Push back and discuss when needed but accept final decision comes from user

---

## 2. Athlete Tier System

Derived from CTL computed across the Strava history window. Used to personalise ACWR thresholds, plan ramp rates, and week volume.

| Tier | CTL range | Label shown to user | Plain-English explanation | ACWR safe upper | Weekly ramp cap |
|---|---|---|---|---|---|
| `beginner` | < 30 | "New to structured training" | "You're building your fitness base. We'll keep load increases gentle to protect against injury." | 1.2 | 8% |
| `recreational` | 30–60 | "Recreational runner" | "You train regularly with some structure. Your body handles moderate load increases well." | 1.3 | 10% |
| `trained` | 60–90 | "Trained runner" | "You're consistently trained. Your body adapts quickly to increased load." | 1.4 | 12% |
| `performance` | 90–120 | "Performance athlete" | "You have a high training base. You can handle significant load increases with good recovery." | 1.5 | 15% |
| `high_volume` | 120+ | "High-volume athlete" | "Your chronic training load is very high. Your body is adapted to sustained heavy training." | 1.6 | 18% |

**Tier explanation always shown inline** when tier is displayed or updated. User can manually override (`athleteTierOverride`). Shown as a badge with a `[?]` that expands the explanation.

**Auto-update:** When incoming Strava data shows CTL consistently above/below tier range for 3+ weeks, surface: "Your training suggests you may be a [Tier] runner — update?" User confirms or dismisses.

---

## 3. Phase A — TSS rename + 3-zone display ✅ COMPLETE

*Self-contained. No new data required.*

### 3.1 What changed
- `TL` → `TSS` everywhere
- 3-zone split: Base (Z1+Z2), Threshold (Z3), Intensity (Z4+Z5)
- `LOAD_PROFILES` extended to 3-zone fractions
- Zone split uses `garminActuals.hrZones` when available, `LOAD_PROFILES` fallback
- "TSS: X" on activity cards with zone sublabels
- 3-zone bars in "This Week" panel
- `computeWeekTL` → `computeWeekTSS` (alias exported for backward compat)
- `actualTL` → `actualTSS` on `Week` state

### 3.2 LOAD_PROFILES (3-zone)
```typescript
LOAD_PROFILES: {
  easy:           { base: 0.95, threshold: 0.04, intensity: 0.01 },
  long:           { base: 0.90, threshold: 0.09, intensity: 0.01 },
  marathon_pace:  { base: 0.65, threshold: 0.30, intensity: 0.05 },
  threshold:      { base: 0.25, threshold: 0.60, intensity: 0.15 },
  vo2:            { base: 0.15, threshold: 0.35, intensity: 0.50 },
  intervals:      { base: 0.10, threshold: 0.30, intensity: 0.60 },
  hill_repeats:   { base: 0.15, threshold: 0.30, intensity: 0.55 },
  progressive:    { base: 0.45, threshold: 0.40, intensity: 0.15 },
  mixed:          { base: 0.45, threshold: 0.35, intensity: 0.20 },
  gym:            { base: 0.10, threshold: 0.20, intensity: 0.70 },
}
```

---

## 4. Phase B — ACWR Injury Risk ✅ COMPLETE

### 4.1 What was built
- `computeACWR(wks, currentWeek, athleteTier?)` → `{ ratio, safeUpper, status, atl, ctl }`
- CTL decay = e^(-7/42) ≈ 0.847/week; ATL decay = e^(-7/7) ≈ 0.368/week
- ACWR bar in Training tab with colour-coded gradient, safe-threshold marker, status text
- "Reduce this week" button (caution/high status)
- Lightened-week banner when `weekAdjustmentReason` set
- `acwrStatus?` param on plan generator — caution → -1 quality session; high → -2 + cap long run
- Excess load card retired; ACWR bar is the unified signal
- Stats page PMC section: CTL/ATL/TSB grid, ACWR ratio, tier badge

### 4.2 Known gaps (fixed in Phase B v2)
- "Reduce this week" only appears on caution/high — blind for first 3 weeks (no history). Fix: also trigger on raw actual TSS > plan × 1.20.
- `acwrStatus` not yet wired into `events.ts` week-advance call.
- Override tracking not yet built.

---

## 5. Phase B v2 — Gaps + Override Debt + Volume ACWR ✅ COMPLETE

### 5.1 Wire acwrStatus into week-advance (events.ts)

In the `next()` function in `src/ui/events.ts`, where `generateWeekWorkouts()` is called:
```typescript
const tier = s.athleteTierOverride ?? s.athleteTier;
const acwr = computeACWR(s.wks, s.w, tier);
// pass acwr.status as last arg to generateWeekWorkouts()
```
One change, low risk.

### 5.2 "Reduce this week" — trigger on over-plan % (gap fix)

When `acwrStatus` is `unknown` (< 3 weeks history) or `safe`, still show button if:
```
actual TSS > planned TSS × 1.20
```
Button text changes to: "This week is 28% above your plan" instead of "Load spike detected."

### 5.3 Override debt + escalating injury risk

Add `Week.acwrOverridden?: boolean` to state. When user dismisses "Reduce this week":
- Record `acwrOverridden: true` on the week
- ATL numerator for ACWR computation gets a synthetic debt added (treats them as if load was slightly higher)
- Escalation logic:

**Injury Risk label** — sits below the ACWR bar, escalates independently:
```
(no override, ACWR safe)   → hidden or "Risk: Low" grey
(ACWR caution)             → "Risk: Moderate" amber
(ACWR high)                → "Risk: High" red
(1 override week)          → "Risk: High — you overrode a reduction recommendation"
(2 consecutive overrides)  → "Risk: Very High — we strongly advise reducing load"
(3+ consecutive overrides) → "Risk: Extreme — injury window open" (persistent, high-contrast)
```

The ACWR ratio bar always shows accurately. The risk label is a separate semantic layer. The "Reduce this week" button reappears more urgently after each consecutive override.

### 5.4 Zone carry tracking

When actual TSS > planned TSS, track by zone:

```typescript
// src/types/state.ts — add to Week
carriedTSS?: { base: number; threshold: number; intensity: number };
acwrOverridden?: boolean;
```

**Display — collapsed:**
An amber banner above the week workouts when `carriedTSS` is non-zero:
> "Carrying +72 TSS · intensity-heavy ▾"
Coloured dot: intensity = red-tinted, threshold = amber, base = blue.

**Display — expanded (tap to expand):**
```
Week 6  ██████░░  +42 TSS  (intensity)   [×0.85 decay]
Week 7  ████░░░░  +30 TSS  (threshold)   [×1.00]
──────────────────────────────────────────────────
Total   +66 TSS  (intensity dominant)
```

**Stacking logic:** Apply CTL decay (×0.85/week) to each contributing week's debt. Stop showing a week's contribution when it drops below 8 TSS (negligible). Banner disappears entirely when total decayed carry < 8 TSS.

**Reset:** Automatic via decay math — no manual reset needed. A genuinely easy week causes the carried debt to fade.

### 5.5 Volume ACWR bar — running km + cross-training

**Two clearly labelled bars** in the Training tab "This Week" panel:

**Bar 1 — Training Load (TSS):**
```
Training Load                     180 / 250 TSS planned
[████████████░░░░░░░░]
 ↑ running (blue) ↑ cross-training (purple)    ◆ baseline
```
Colour-split within the bar: running TSS (blue) + cross-training TSS (purple). Baseline marker (◆) shows their 42-day CTL in TSS terms. Plan target shown as text "250 TSS planned."

This bar fills with BOTH running and cross-training — a cyclist who barely ran still sees a mostly-full bar. No deficit feeling if total load is healthy.

**Bar 2 — Running Volume (km):**
```
Running Volume
20km run  +  11km via cross-training (GPS sports)
[████████░░░░░░░░░░░░] 35km planned  ◆ 28km baseline
```
Running km (blue) + GPS cross-training km (lighter blue/grey) displayed in a compact row. "GPS sports" means activities with actual distance data from Strava (football, rugby, field sports). Non-GPS sports (cycling, swimming) contribute TSS but not km here.

**Baseline vs plan:** The 42-day baseline sits BELOW the plan during marathon buildup (this is expected — CTL lags a progressive plan). Above baseline but below plan = normal. Only flag if below the marathon minimum floor for their goal.

**Injury risk signal:** Only trigger a Volume ACWR warning when:
- Actual running km > plan running km × 1.30 (unexpected spike beyond plan)
- OR actual running km < minimum floor AND this is 2+ consecutive weeks

**Not alarming when:** Athlete is following plan and baseline just lags behind (expected during buildup). No red indicators, no guilt.

### 5.6 Minimum running km floors (marathon-specific)

Scaled to goal time and plan phase (lower in early weeks, higher at peak):

| Goal | Minimum at peak | Minimum early |
|---|---|---|
| Sub 3:30 | 35km/week | 20km/week |
| 3:30–4:30 | 25km/week | 15km/week |
| 4:30+ / finish | 18km/week | 10km/week |

Floor scales linearly with plan week (early → peak). Below floor for 2+ weeks → nudge: "Consider adding a short easy run to boost your running conditioning." App can add a suggested easy run as a pending entry (user confirms or dismisses). Tone is always a suggestion, never an alarm.

### 5.7 sport-specific km in Volume bar

Sports with GPS km data from Strava (field sports, trail hiking, etc.) contribute to the km bar at a sport-specific `volumeTransfer` coefficient (distinct from `runSpec` which is cardiovascular):

| Sport | volumeTransfer | Notes |
|---|---|---|
| touch_rugby / football | 0.7 | Short explosive sprints, COD; different from sustained running but loads similar structures |
| trail_running | 1.0 | Full credit |
| road_running | 1.0 | Full credit |
| hiking | 0.4 | Low-impact, slow km |
| cycling / swimming / padel | 0 | No km credit (not ground-impact running) |

Add `volumeTransfer?: number` to `SportProfile` in `src/constants/sports.ts`.

### 5.8 Files changed — Phase B v2

| File | Change |
|---|---|
| `src/types/state.ts` | Add `Week.carriedTSS?`, `Week.acwrOverridden?` |
| `src/ui/events.ts` | Wire `acwrStatus` into week-advance `generateWeekWorkouts()` call |
| `src/ui/main-view.ts` | Volume ACWR bar (2-bar display), carry banner, injury risk label |
| `src/calculations/fitness-model.ts` | Override debt: synthetic ATL debt when `acwrOverridden` |
| `src/constants/sports.ts` | Add `volumeTransfer` to `SportProfile` and `SPORTS_DB` entries |
| `src/state/persistence.ts` | Persist `carriedTSS`, `acwrOverridden` |

---

## 6. Phase B v3 — HR Zone Matching for Replacement Decisions ✅ BACKEND COMPLETE · UI waiting on UX redesign agent

*This is the main engineering task. Upgrades `buildCrossTrainingPopup` from sport-label matching to data-driven iTRIMP classification.*

### 6.1 Background

`buildCrossTrainingPopup` in `src/cross-training/suggester.ts` exists and works. It already passes `hrZones` to `computeUniversalLoad`. The gap: `buildCandidates()` uses load magnitude for similarity scoring, not zone profile. We're replacing one part of this with iTRIMP-based type classification.

### 6.2 iTRIMP classification

**When to use iTRIMP vs zone distribution:**

Use iTRIMP as the primary classifier when ANY of these are true:
- Sport is known-intermittent (football, rugby, basketball — flagged in `SPORTS_DB` as `intermittent: true`)
- `(z4+z5) / total_zone_seconds > 0.15` — significant high-HR spike proportion
- Activity has < 20min total zone data (too short for distribution to be reliable)

Use zone distribution (z1–z5 ratios) for steady-state sports (cycling, padel, easy swimming) where none of the above apply.

**iTRIMP → workout type classification:**

Normalisation: `normalizeiTrimp(itrimp) = (itrimp * 100) / 15000`
(≈55 TSS for easy 60min, ≈85 TSS for tempo 60min, ≈120+ TSS for intervals)

Classifier uses normalised TSS/hour:

| TSS/hr (normalised) | Workout type | Maps to |
|---|---|---|
| < 70 | Easy | `easy` or `long` |
| 70–95 | Tempo / threshold | `threshold` or `marathon_pace` |
| > 95 | Interval / VO2 | `vo2` or `intervals` |

**These are default thresholds.** They are personalised from user's Strava history (Stage 1 learning — see §6.3).

**Zone distribution classifier (steady-state fallback):**
```
baseRatio      = (z1+z2) / total_zone_seconds
threshRatio    = z3 / total_zone_seconds
intensityRatio = (z4+z5) / total_zone_seconds

if baseRatio > 0.80      → easy profile
if threshRatio > 0.40    → tempo/threshold profile
if intensityRatio > 0.30 → interval/VO2 profilenod
```

### 6.3 Learning iTRIMP thresholds from user data

**Stage 1 — Calibrate from Strava labelled runs (onboarding / Phase C2):**

When pulling Strava history, look at activities with recognised run type labels ("Tempo Run", "Interval", "Easy Run", "Long Run"). Compute normalised TSS/hour for each. Store personal thresholds:

```typescript
// src/types/state.ts — add to SimulatorState
intensityThresholds?: {
  easy: number;       // TSS/hr upper bound for easy (default 70)
  tempo: number;      // TSS/hr upper bound for tempo (default 95)
  // above tempo = interval
  calibratedFrom?: number;  // number of labelled activities used
};
```

**Stage 2 — Ongoing refinement:**
Every confirmed planned workout with both a known type AND Strava data updates the thresholds. After 4+ data points per zone, thresholds are well-tuned.

**Fallback:** Use defaults (70/95) until 3+ data points per zone. Show in UI: "Intensity calibration improving — X more sessions to personalise."

**Transparency:** Show calibration status on Stats page. "Your intensity zones are calibrated from 12 training sessions."

### 6.4 Running equivalent load

After classifying the workout type, compute running-equivalent TSS:
```
running_equiv_TSS = activity_TSS × sport.runSpec
```
(`runSpec` already exists in `SPORTS_DB` — cardiovascular transferability to running fitness.)

Compare to planned run's TSS from `LOAD_PROFILES[plannedWorkoutType]`. Match criteria:
- Zone profile matches (both easy, or both tempo, or both interval)
- `|running_equiv_TSS - planned_TSS| < 20%`

If full match → offer full replace. If zone profile mismatches → partial credit, flag the mismatch.

### 6.5 Replacement modal UX

When a cross-training activity matches a planned run, the modal shows:

**Header (always):**
```
⚽ Football session · 68min · iTRIMP classified: Tempo
Peak speed: 28km/h · HR-based load: 84 TSS
```
(Speed shown when available from Strava GPS data — feels personal and validates the app's understanding.)

**Matched run:**
```
Matched to: Tuesday tempo run (8km threshold)
Cardiovascular load: covered (running-equivalent 78 TSS vs 82 TSS planned — 95% match)
Running km impact: you'd be 8km below your running volume target this week
```

**Options:**
```
[Replace]  Removes your tempo run. Running volume: 22km this week (target 30km).
           Recommended if: you're above your minimum running floor (18km).

[Reduce]   Shortens tempo to 20min. Keeps running-specific conditioning.
           Recommended if: you're below your weekly running volume target.

[Keep]     Keeps your full plan. Total load will be high this week.
```

**Recommendation is highlighted** based on current running km position vs goal-scaled floor. App suggests, user decides.

**If tempo run was already completed earlier that week:**
> "Your football session matches your tempo run — but you already completed it on Monday. Your session contributes to your weekly load (ACWR updated). Apply the load credit to next week's tempo run?"
> [Apply to next week] [Log load only]

**If no matching run type exists this week:**
> "No matching planned run this week. Apply this session's load credit to next week?"
> [Match to next week's [run type]] [Log as load only]

### 6.6 Files changed — Phase B v3

| File | Change |
|---|---|
| `src/cross-training/suggester.ts` | Add `classifyByITrimp()`, `classifyByZones()`; update `buildCandidates()` to use zone-profile matching |
| `src/constants/sports.ts` | Add `intermittent: boolean`, `volumeTransfer: number` to `SportProfile` |
| `src/types/state.ts` | Add `intensityThresholds?` to `SimulatorState` |
| `src/ui/suggestion-modal.ts` | Update modal header with sport info, speed, match quality, km impact |
| `src/cross-training/universalLoad.ts` | Expose `classifyWorkoutType()` based on iTRIMP/zone input |

---

## 7. Phase C — Strava History → Smarter Plans

### 7.1 Phase C1 — Historic load chart ✅ BACKEND COMPLETE · UI waiting on UX redesign agent

**New edge function mode: `history`**

```typescript
// Request body: { mode: 'history', weeks: 8 }
interface HistorySummaryRow {
  weekStart: string;
  totalTSS: number;
  runningKm: number;
  zoneBase: number;
  zoneThreshold: number;
  zoneIntensity: number;
  sportBreakdown: { sport: string; durationMin: number; tss: number }[];
}
```

TSS for non-running sports weighted by `runSpec`. Running sports get full TSS.

**UI:** 8-week sparkline on Training tab (below ACWR bar). Full chart on Stats page with running km overlay. Tapping sparkline opens Stats page.

### 7.2 Phase C2 — History-informed onboarding

After Strava connect in wizard: "Analysing your training history…" spinner → summary screen:
```
We found 8 weeks of training history

Avg weekly load       62 TSS/week
Avg running volume    38 km/week
Training profile      Mostly aerobic base (72%), some threshold (23%)
Sports detected       Running, Cycling, Football

Based on this, you're a Trained runner.
Your plan will start at 38 km/week and ramp from here.

[Use this — Recommended]   [I'll enter manually]
```

Also runs iTRIMP threshold calibration from labelled history. Sets `intensityThresholds` on state.

### 7.3 Phase C3 — Adaptive plan rebuild

"Rebuild plan with Strava data" button on Account view. Re-runs history analysis, rebuilds plan from current training level. ACWR-aware generation ongoing.

### 7.4 New state fields

```typescript
// SimulatorState additions
athleteTier?: 'beginner' | 'recreational' | 'trained' | 'performance' | 'high_volume';
athleteTierOverride?: typeof athleteTier;
ctlBaseline?: number;
detectedWeeklyKm?: number;
historicWeeklyTSS?: number[];
historicWeeklyKm?: number[];
stravaHistoryFetched?: boolean;
intensityThresholds?: { easy: number; tempo: number; calibratedFrom?: number };

// Week additions
weekAdjustmentReason?: string;
carriedTSS?: { base: number; threshold: number; intensity: number };
acwrOverridden?: boolean;
```

---

## 8. Reduction Logic — Plain Language Rules

These rules drive both the suggestion modal pre-selection and the future week generator.

**Rule 1 — ACWR elevated, intensity-heavy week:**
*"Your load jumped X% above baseline and most of it was high-intensity work. Cut intervals first — they're the biggest fatigue driver. Threshold sessions next."*

**Rule 2 — ACWR elevated, km-heavy week:**
*"Your running km spiked this week. Your heart rate load is fine — this is a mechanical risk (tendons, bones). Shorten the long run and one easy run rather than cutting intensity."*

**Rule 3 — ACWR elevated, cross-training caused the spike:**
*"A heavy [sport] session pushed your total load above baseline. Your running plan can stay mostly intact — reduce by replacing one easy run with a rest day or lighter session."*

**Rule 4 — 3+ consecutive weeks >40% intensity:**
*"Your last [N] weeks have been intensity-heavy. We've replaced one interval session with an easy run to protect your aerobic base."*

**Rule 5 — Trailing zone mix drives reduction target:**
Look at trailing 4-week zone distribution vs plan's intended distribution for this phase:
- User mostly base + light cross-training → protect quality session, cut easy run distance first
- User consistently intensity-heavy → intensity is the source, reduce there first
- Week with low-impact cross-training spike (padel, walking) → cut easy runs, long run survives

Not a fixed hierarchy. What caused this week's spike drives where we cut.

---

## 9. Build Order & Dependencies

```
Phase A  (TSS rename + 3-zone display)          ✅ COMPLETE
   ↓
Phase B  (ACWR bar + reduction flow)             ✅ COMPLETE
   ↓
Phase B v2  (wire acwrStatus + override debt + Volume ACWR bar)
   ↓
Phase B v3  (HR zone matching for replacement — main engineering task)
   ↓
Phase C1 (historic load chart — edge function + sparkline)
   ↓
Phase C2 (history-informed onboarding + iTRIMP calibration)
   ↓
Phase C3 (adaptive plan generation + rebuild button)
```

Each phase is independently shippable.

---

## 10. Known Risks & Open Questions

| Risk | Mitigation |
|---|---|
| `garmin_activities` may have < 8 weeks for most users | Show "building baseline" on ACWR bar; skip history analysis in onboarding if < 2 weeks |
| Athlete tier misclassification after injury/break | Always show tier badge with manual override |
| Plan rebuild is destructive | Modal warning: "Your logged activities and ratings are preserved, only the workout plan is rebuilt." Keep `garminActuals` and `rated` on existing weeks. |
| `computeFitnessModel()` starts from 0 CTL | Phase C fixes by seeding `ctlBaseline`. Until then ACWR is conservative for experienced athletes early in plan — acceptable. |
| Zone data absent for many activities (no Strava HR) | Falls back to `LOAD_PROFILES` — already designed for this |
| iTRIMP thresholds (70/95 TSS/hr) may not fit all athletes | Personalised from Strava labelled runs in Phase C2; defaults are reasonable starting point |
| Rugby/football HR averages to Z1/Z2 due to rest periods | iTRIMP classifier handles this correctly — exponential weighting makes Z5 bursts count properly |
| `after_timestamp` window 28 → 56 days doubles edge function load | Only on sync tap, not automatic. Acceptable. |

---

## 11. What We Are NOT Building

- Daily TSS granularity (weekly sufficient for injury prevention in a marathon app)
- A fully custom CTL/ATL chart with user-adjustable decay constants (too complex for UX)
- Automatic plan rebuilds without user confirmation (always prompt)
- Garmin-native zone data (use Strava HR for zone computation)
- Hard blocks on cross-training replacement (always flag and suggest, never gatekeep)
- Invented km for non-GPS sports (cycling km ≠ running km; only GPS sports contribute to volume bar)

---

## 12. UX Agent Wiring Guide

> **Context:** The load system backend is being built in parallel with a UX redesign. This section tells the UX agent exactly what data is available and how to surface it. Do NOT re-implement these calculations — they already exist. Just call the functions and render the results.

---

### 12.1 Data already computed — call these, don't rebuild them

**ACWR + fitness metrics:**
```typescript
import { computeACWR, computeFitnessModel } from '@/calculations/fitness-model';

const tier = s.athleteTierOverride ?? s.athleteTier;
const acwr = computeACWR(s.wks, s.w, tier);
// acwr.ratio      — current ACWR (e.g. 1.24)
// acwr.safeUpper  — tier-specific safe threshold (e.g. 1.3)
// acwr.status     — 'unknown' | 'safe' | 'caution' | 'high'
// acwr.atl        — acute training load (7-day)
// acwr.ctl        — chronic training load (42-day)

const fitness = computeFitnessModel(s.wks);
// fitness.ctl, fitness.atl, fitness.tsb
// fitness.actualTSS  — what they actually did this week
```

**Week TSS:**
```typescript
import { computeWeekTSS } from '@/calculations/fitness-model';
const { planned, actual } = computeWeekTSS(week);
```

**Cross-training classification (Phase B v3 — backend being built now):**
```typescript
import { classifyWorkoutType } from '@/cross-training/universalLoad';
// classifyWorkoutType({ iTrimp, durationMin, hrZones?, sport }) →
//   { type: 'easy'|'threshold'|'vo2', tss: number, method: 'itrimp'|'zones'|'profile' }
```

---

### 12.2 Training tab — "This Week" panel

Refer to spec §5.5 for bar designs. The data to drive them:

```typescript
// Bar 1 — Training Load (TSS)
const { planned, actual } = computeWeekTSS(week);
const runningTSS   = actual;           // blue segment
const crossTSS     = week.crossTSS ?? 0; // purple segment (if you track separately)
const ctlBaseline  = acwr.ctl;         // ◆ marker position

// Bar 2 — Running Volume (km)
// Running km: sum w.dist for all run-type workouts this week
// Cross-training km: from week.adhocWorkouts where sport.volumeTransfer > 0
//   km contribution = activity.durationMin * (speed_km_per_min) * sport.volumeTransfer
//   OR if no GPS speed: skip (don't invent km)
```

**ACWR bar colour logic:**
```
acwr.status === 'safe'    → green gradient  (ratio < safeUpper)
acwr.status === 'caution' → amber gradient  (ratio 1.0–1.3× safeUpper)
acwr.status === 'high'    → red gradient    (ratio > 1.3× safeUpper)
acwr.status === 'unknown' → grey            (< 3 weeks data)
```

**"Reduce this week" button** — show when:
```typescript
const showReduceBtn =
  acwr.status === 'caution' || acwr.status === 'high' ||
  (planned > 0 && actual > planned * 1.20);  // over-plan trigger even when safe/unknown
const overPct = Math.round((actual / planned - 1) * 100);
const btnLabel = acwr.status === 'safe' || acwr.status === 'unknown'
  ? `This week is ${overPct}% above your plan`
  : 'Load spike detected — reduce this week';
```

Button opens the suggestion modal: `showSuggestionModal(s, 'reduce', workouts, acwrModalContext)`.

**Injury risk label** (below ACWR bar):
```typescript
// consult week.acwrOverridden and consecutive override count
// see spec §5.3 for escalation labels: Moderate / High / Very High / Extreme
```

**Zone carry banner** (above workouts):
```typescript
// Read week.carriedTSS — already computed and stored
// Show amber collapsible banner when total decayed carry > 8 TSS
// Logic for decayed totals is in main-view.ts renderCarryBanner() — reuse or port
```

---

### 12.3 Stats page — Performance Management Chart

```typescript
const fitness = computeFitnessModel(s.wks);
// Display:
//   CTL: fitness.ctl   (chronic — "fitness")
//   ATL: fitness.atl   (acute — "fatigue")
//   TSB: fitness.tsb   (form = CTL - ATL)
//
// Athlete tier badge: s.athleteTier (auto-detected) or s.athleteTierOverride
// Tier labels: see spec §2 table
// ACWR: use computeACWR() as above — show ratio + coloured bar
```

**Intensity calibration status** (Phase B v3, show once backend is ready):
```typescript
// s.intensityThresholds?.calibratedFrom — number of sessions used
// If undefined or < 3: "Calibrating intensity zones — X more sessions to personalise"
// If >= 3: "Intensity zones calibrated from N sessions"
```

---

### 12.4 Cross-training replacement modal (Phase B v3 — backend being built now)

Once `classifyWorkoutType()` is available, the modal header should show (see spec §6.5):

```
⚽ Football session · 68min · iTRIMP classified: Tempo
Peak speed: 28km/h · HR-based load: 84 TSS
──────────────────────────────────────────
Matched to: Tuesday tempo run (8km threshold)
Cardiovascular load: covered (running-equivalent 78 TSS vs 82 TSS planned — 95% match)
Running km impact: you'd be 8km below your running volume target this week
```

The three buttons (Replace / Reduce / Keep) pre-select based on running volume vs minimum floor.
See spec §6.5 for exact copy and recommendation logic.

---

### 12.5 Files the load backend owns (don't rewrite these, just call them)

| File | Exports you need |
|---|---|
| `src/calculations/fitness-model.ts` | `computeACWR()`, `computeFitnessModel()`, `computeWeekTSS()`, `TIER_ACWR_CONFIG` |
| `src/cross-training/universalLoad.ts` | `classifyWorkoutType()` (Phase B v3), `computeUniversalLoad()` |
| `src/cross-training/suggester.ts` | `buildCrossTrainingPopup()`, `classifyByITrimp()`, `classifyByZones()` (Phase B v3) |
| `src/constants/sports.ts` | `SPORTS_DB` — has `volumeTransfer`, `intermittent`, `runSpec` per sport |
| `src/types/state.ts` | `Week.carriedTSS`, `Week.acwrOverridden`, `SimulatorState.athleteTier`, `SimulatorState.intensityThresholds` |

---

### 12.6 Phase completion status

All major phases are now complete. See §0 for remaining sub-feature gaps.

| Item | Status |
|------|--------|
| Phase B v3 UI — `suggestion-modal.ts` header (sport, effort type, matched run, km gap) | ✅ Done |
| Phase C1 UI — 8-week sparkline (Training tab) + full chart (Stats page) | ✅ Done |
| Phase C2 — history-informed onboarding wizard step (`strava-history.ts`) | ✅ Done |
| Phase C3 — adaptive plan rebuild button (Account view) | ✅ Done |
| Minimum running km floors (§5.6) | ❌ Not built |
| "Already completed" / "no matching run" modal flows (§6.5) | ❌ Not built |
| Stage 2 iTRIMP ongoing refinement (§6.3) | ❌ Not built |
| Tier auto-update suggestion (§2) | ❌ Not built |
| 5-rule plain language reduction copy (§8) | ❌ Not built |
| `activity_name` Supabase migration deployed | ⚠️ Pending — your action |

### 12.8 Phase C1 — wiring the sparkline and history chart (UX agent)

**Data is already on state after `fetchStravaHistory()` is called:**
```typescript
s.historicWeeklyTSS   // number[] — running-equiv TSS per week, oldest first
s.historicWeeklyKm    // number[] — running km per week, oldest first
s.ctlBaseline         // number — CTL seeded from history (replaces 0-start in computeACWR)
s.detectedWeeklyKm    // number — avg weekly km (last 4 weeks)
s.stravaHistoryFetched // boolean — true once loaded
```

**To trigger the fetch** (call once at startup when Strava is connected):
```typescript
import { fetchStravaHistory } from '@/data/stravaSync';
if (s.stravaConnected && !s.stravaHistoryFetched) {
  fetchStravaHistory(8).then(() => render());
}
```

**Training tab sparkline** (8 bars, mini chart below ACWR bar):
- Each bar = one week's `totalTSS`, coloured by zone split (base/threshold/intensity)
- Tap → navigates to Stats page
- Show "Building history…" placeholder when `!s.stravaHistoryFetched`

**Stats page full chart** (see spec §7.1):
- 8 bars with running km overlay (right axis)
- Current plan week highlighted with a marker
- Sport breakdown tooltip on tap

**CTL seeding fix** (pass `ctlBaseline` to `computeACWR`):
```typescript
// In fitness-model.ts computeACWR(), seed CTL with ctlBaseline if available
// This prevents the "0 CTL" problem for athletes starting a new plan
// Pass s.ctlBaseline as optional 4th param — implement when wiring
```

### 12.9 Phase D — Load History Chart ❌ NOT BUILT

A richer, scrollable load history chart on the Stats page. Replaces the current 8-bar block chart with smooth area curves that show fitness trends over time.

#### What it looks like

One chart, two layers:

```
TSS
 ▲
 │        ╭───╮
 │   ╭────╯   ╰────╮        ← Aerobic (base + threshold, blue area)
 │───╯              ╰───────
 │  ░░░░░░░░░░░░░░░░░░░░░░░  ← Anaerobic (intensity, orange area, stacked on top)
 │                            ← CTL curve (white/grey line, smooth)
 └────────────────────────── weeks
```

- **Aerobic area** (blue): `zoneBase + zoneThreshold` TSS per week — the sustainable fitness base
- **Anaerobic area** (orange, stacked on top): `zoneIntensity` TSS per week — hard efforts
- **CTL curve** (line overlay): rolling 42-day fitness trend — smooths over individual weeks
- **Running km** (optional secondary axis, dashed grey line): volume context alongside load
- **Now marker**: vertical line at the current plan week

All values are in TSS — the universal currency already used everywhere in the app.

#### Time range selector

Three buttons below the chart: **8 weeks · 16 weeks · All**

- 8 weeks: default, fast load (already cached in `historicWeeklyTSS`)
- 16 weeks: fetches with `{ mode: 'history', weeks: 16 }` — edge function already supports up to 52
- All: fetches with `weeks: 52` (or however far back Strava data goes)

Store the extended history separately from the 8-week default so the 8-week fetch stays fast on startup.

#### Tap interaction

Tapping any point on the chart shows a tooltip:
```
Week of Mar 3
Total TSS: 284
  Aerobic   218  ████████████████░░░░
  Anaerobic  66  ████░░░░░░░░░░░░░░░░
Running km: 52km
```

#### State additions

```typescript
// SimulatorState additions
historicWeeklyZones?: { base: number; threshold: number; intensity: number }[];  // parallel to historicWeeklyTSS
extendedHistoryWeeks?: number;         // how many weeks are loaded beyond the default 8
extendedHistoryTSS?: number[];         // longer window, loaded on demand
extendedHistoryKm?: number[];
extendedHistoryZones?: { base: number; threshold: number; intensity: number }[];
```

#### Edge function — no changes needed

The `history` mode already returns `zoneBase`, `zoneThreshold`, `zoneIntensity` per row. The client just needs to:
1. Store zone breakdown alongside `historicWeeklyTSS` (currently only total TSS is stored — minor addition to `fetchStravaHistory()`)
2. Add a `fetchExtendedHistory(weeks: 16 | 52)` function that calls the same edge function with a larger `weeks` param and stores to the `extended*` fields

#### Files to change

| File | Change |
|------|--------|
| `src/data/stravaSync.ts` | Store `historicWeeklyZones` from `zoneBase/zoneThreshold/zoneIntensity` in `fetchStravaHistory()`; add `fetchExtendedHistory(weeks)` |
| `src/types/state.ts` | Add `historicWeeklyZones?`, `extendedHistory*` fields |
| `src/ui/stats-view.ts` | Replace current 8-bar chart with stacked area SVG chart; add time range selector; tap tooltip |

#### Principles

- SVG-based (no chart library dependency — consistent with existing sparkline approach in the codebase)
- Mobile-first: chart fills screen width, touch-friendly tap targets
- "Building history…" placeholder until `stravaHistoryFetched` is true
- No data, no guilt: if fewer than 4 weeks of history exist, show a gentle "Keep training — your chart will fill in here" message rather than a sparse chart

---

### 12.7 Phase B v3 — what was built (backend complete 2026-02-27)

| File | What was added |
|---|---|
| `src/cross-training/universalLoad.ts` | `classifyByITrimp()`, `classifyByZones()`, `classifyWorkoutType()`, `WorkoutClassification`, `IntensityThresholds` types |
| `src/cross-training/suggester.ts` | `workoutTypeToZone()`, `ZONE_MATCH_BONUS`, `ZONE_MISMATCH_PENALTY`; `buildCandidates()` now takes optional `WorkoutClassification`; `buildCrossTrainingPopup()` computes and passes classification; `intensityThresholds?` on `AthleteContext` |
| `src/types/state.ts` | `SimulatorState.intensityThresholds?` |

**To wire the Phase B v3 UI** — see §6.5 for modal design. The data is in the `actClassification` log line (`[CrossTraining] Zone classification: ...`). For the modal header, call `classifyWorkoutType()` from `universalLoad.ts` with the activity's sport/iTrimp/hrZones and use the returned `type`, `tss`, and `method`.

---

## 13. Phase E — History-Aware Plan Initialisation

### Problem

When Strava history is accepted (`stravaHistoryAccepted = true`), the wizard seeds:
- `s.wkm` ← `detectedWeeklyKm` (weekly running km from history)

But it does **not** seed:
- `s.rw` (runs/week) — stays at the default from onboarding (usually 4–5)
- Intensity distribution — the plan generator always starts with the same zone balance regardless of the athlete's actual training style

This means a runner who trains 6 days/week at low intensity gets the same plan structure as one who runs 3 days/week with heavy interval work.

### What needs to be built

#### E1 — Infer `rw` from history

Given `historicWeeklyTSS`, `historicWeeklyKm`, and `detectedWeeklyKm`, estimate a plausible runs/week:

```
if wkm < 25 → rw = 3
if wkm < 40 → rw = 4
if wkm < 55 → rw = 5
if wkm < 70 → rw = 6
else        → rw = min(7, rw_current)
```

Apply only when `stravaHistoryAccepted` is true and `rw` has not been manually overridden in onboarding (check `onboarding.runsPerWeek !== undefined`).

Location: `src/ui/initialization.ts` after the `wkm` assignment.

#### E2 — Bias zone distribution from history

`historicWeeklyZones` gives a per-week `{base, threshold, intensity}` breakdown for the last 8 weeks. Average them to get the athlete's habitual zone balance, and store as:

```typescript
s.historicZoneProfile = { base: number, threshold: number, intensity: number }
// normalised to sum to 1.0
```

In `src/workouts/scheduler.ts` or `renderer.ts`, the first 2 weeks of the plan should match the athlete's habitual zone split (rather than the plan's prescribed intensity). Subsequent weeks follow the plan prescription.

This prevents "sudden load shock" on week 1 (e.g., a base-only runner immediately getting high-intensity sessions).

#### E3 — Strava history screen shows inferred `rw`

The `strava-history.ts` wizard step should display "We suggest starting at **N runs/week** based on your history" alongside the km and TSS summary, and allow the user to adjust before confirming.

### Files to touch

| File | Change |
|---|---|
| `src/ui/initialization.ts` | E1: infer `rw` from `detectedWeeklyKm` |
| `src/types/state.ts` | Add `historicZoneProfile?` field |
| `src/data/stravaSync.ts` | Compute and store `historicZoneProfile` in `fetchStravaHistory()` |
| `src/ui/wizard/steps/strava-history.ts` | E3: show inferred `rw` in history summary |
| `src/workouts/scheduler.ts` | E2: use `historicZoneProfile` to bias week-1/2 intensity |
