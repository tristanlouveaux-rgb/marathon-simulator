# Mosaic Design Principles

> The "why" behind product and architectural decisions. Read before making changes to load
> calculation, plan adjustment logic, or stats display.

---

## The Founding Problem

Training apps like Runna treat athletes as running-only. They prescribe full running load
regardless of what else you've done that week — gym, tennis, Hyrox, football. Athletes who
play sports and train in the gym follow the plan, accumulate total load far above what their
body can recover from, and get injured.

**Mosaic's core contract**: be a running coach that respects a full sporting life. Help people
run faster without demanding mono-sport dedication, and never prescribe load that ignores what
the rest of their week looks like.

---

## The Three-Signal Load Model

There is no single "load" number. There are three distinct physiological signals, and
conflating them leads to wrong decisions.

### Signal A — Running Fitness (run-equivalent load)
- **Measured by**: iTRIMP × `runSpec` discount (RUNNING=1.0, CYCLING=0.55, HIIT=0.30, etc.)
- **What it captures**: How much this activity contributes to running-specific adaptation
  (cardiovascular economy, running neuromuscular patterns, tendon stiffness)
- **Used for**: Replace & Reduce decisions ("can this cycling session sub for a run?"),
  running CTL (chronic fitness baseline), race time prediction
- **Honest limitation**: A brutal Hyrox correctly scores low here if the running was replaced
  by cycling — it genuinely didn't build much running fitness

### Signal B — Systemic Fatigue (raw physiological load)
- **Measured by**: iTRIMP without runSpec discount (or duration × intensity estimate)
- **What it captures**: Total stress on cardiovascular system, hormonal system, CNS. Your
  body doesn't care if it was a bike or a treadmill — hard is hard.
- **Used for**: ACWR calculation, injury risk, weekly load charts, "should I reduce this week?"
- **Key insight**: This is the signal Runna was missing. A Hyrox sim the day before a long
  run is dangerous even if it contributes zero running fitness.

### Signal C — Musculoskeletal / Impact Load
- **Measured by**: `impactLoad` (already in codebase — km × intensity for running,
  duration × `impactPerMin` for cross-training)
- **What it captures**: Tendon, joint, and muscle stress. Running loads the Achilles and
  knees differently from cycling. Heavy squats load them differently again.
- **Used for**: Day-before protection (hard gym before long run = elevated injury risk),
  phase-level injury risk signal
- **Status**: Computed and stored on `wk.actualImpactLoad` but not yet surfaced in UI

---

## Decision Matrix

| Decision | Signal | Rationale |
|---|---|---|
| ACWR / injury risk | B (raw) | Body fatigue is total, not running-specific |
| Weekly load charts | B (raw) | Honest representation of what athlete actually did |
| Replace a run with cross-training? | A (run-equiv) | Running adaptation is what we're replacing |
| Which run to cut first? | A priority order | Protect quality, cut easy volume |
| Race time prediction | A (running CTL only) | Race fitness is running-specific |
| Day-before warning | C (impact) | Musculoskeletal risk is what matters |

---

## Protection Hierarchy (when load is high)

When Signal B ACWR is elevated and the plan must be lightened, the order of cuts:

1. **Easy runs** — first to reduce (volume cut: distance reduced). Least fitness cost.
2. **Long run** — reduce distance before removing entirely
3. **Threshold** — downgrade intensity (threshold → steady/MP) before cutting distance
4. **VO2 / Intervals** — absolute last resort; downgrade intensity only, never remove

Quality sessions (threshold, VO2) are the engine of race improvement. They should survive
nearly everything. Easy runs are the oil — important for recovery and aerobic base, but
reducible without meaningful fitness loss.

---

## Minimum Running Principle

Cross-training is complementary, never a complete substitute for running in a race plan.

- Each phase has a minimum weekly running dose below which race fitness stalls
- When Signal B fatigue is LOW and running volume is below minimum: suggest adding a run
  (don't announce it, just extend an existing easy run or add a short recovery run)
- When Signal B fatigue is LOW and running volume is adequate: leave plan unchanged
- When Signal B fatigue is HIGH: reduce regardless of running volume
- **Protected sessions**: Quality workouts are never auto-removed. They may be downgraded
  in intensity but they remain in the plan.

**Caution**: The trigger to add running must require BOTH low fatigue AND low running volume.
Never add running to someone who is already systemically fatigued, even if their running km
looks low. That is the Runna failure mode in reverse.

---

## Transparency Principle

Every plan change the app makes should be explainable in plain English.

- "Your Easy Run was reduced by 3km because of Wednesday's Hyrox (fatigue carry-over)"
- "Week 2 had 85 TSS of unresolved training load that still affects this week's plan"
- "Your threshold session is protected — easy run reduced instead"

Athletes who understand *why* their plan changed are more likely to trust it and follow it.
Opaque changes erode trust even when they're correct.

---

## Stats Display Philosophy

The stats page should answer three questions, in order:

1. **"How hard have I been training overall?"** → Signal B (raw physiological load)
   Primary chart. This is the honest answer. It includes gym, tennis, Hyrox.

2. **"How is my running fitness developing?"** → Running km trend + Signal A CTL
   Secondary section. Shows whether running-specific adaptation is building.

3. **"Am I at risk?"** → Signal B ACWR relative to Signal A chronic baseline
   The ratio of "how fatigued am I" to "what running load am I adapted to." This is
   the metric that catches the multi-sport athlete problem — high cross-training fatigue
   against a moderate running-adapted chronic → elevated risk.

---

## Resolved Design Decisions (2026-03-04)

### Cross-Training Load Management — Excess & Reduction Logic

> These decisions replace the previous ad-hoc "overflow → blocking modal" approach.
> Core principle: cross-training is a first-class citizen, not an exception case.

#### Signal B baseline as the reference point

Excess load is defined as **delta above the athlete's historic Signal B weekly average**, not
as "anything that doesn't fit a plan slot." An athlete who normally does 80 TSS/week of
cross-training should not be prompted every time they play their usual game of padel.

- `historicWeeklyRawTSS`: weekly sum of raw iTRIMP (no runSpec) from Strava history
  → populated by a new `sport-history` edge function query on `garmin_activities`
- `signalBBaseline`: 8-week EMA of `historicWeeklyRawTSS` — "what this athlete normally does"
- Excess = this week's Signal B to date minus `signalBBaseline`
- Plan initialisation shows a chart of this history so the user can see how the baseline
  was derived. Transparent, not black-box.

#### Three-tier response to excess load

| Tier | Condition | Response |
|---|---|---|
| 1 — Auto-adjust | Excess ≤ 15 TSS above baseline | Silently reduce the nearest unrated easy run by proportional km. Log note on activity: "Easy run reduced by 1.2km · 18 TSS accounted for." No popup. Undoable via the activity note. |
| 2 — Nudge card | Excess 15–40 TSS above baseline | Amber card on Training tab: "32 TSS of cross-training load waiting · Adjust week." No popup until user taps. Opens reduce/replace flow. |
| 3 — Blocking modal | ACWR caution or high zone | Existing blocking modal fires. Only at this tier. Not for mild overage. |

Tier 1 is auto because the math is clear and the consequence is small. Tier 2 requires
human judgement about which sessions matter. Tier 3 is urgent enough to interrupt.

#### Timing sensitivity: day-proximity overrides the weekly total

Weekly Signal B total is not enough. A 40 TSS football session on Wednesday affects
Thursday's threshold run regardless of where the week's total sits.

Rule: If a cross-training activity with Signal B ≥ 30 TSS occurred within **1 calendar day**
of a quality session (threshold, VO2, long run), that quality session is automatically
**downgraded in intensity** (not removed, not distance-cut).

- Threshold → Marathon Pace
- VO2/Interval → Threshold pace
- Long run → no pace downgrade, but distance reduced if Signal B is very high (≥ 50 TSS)

Explanation shown on the plan card: *"You trained hard yesterday. Today's session is
adjusted to marathon pace so your body can absorb the work."*

If the user moves the session to a different day (manual reschedule), the timing check
re-evaluates and the downgrade clears automatically.

This check is independent of the weekly excess check — it can fire even when total
Signal B is within the athlete's normal baseline.

#### High-intensity sport (football, basketball, court sports) — intensity matching

These sports do NOT substitute for a quality run session. A hard game of football is
high Signal B but low-to-moderate Signal A — it taxes the cardiovascular system and
muscles but does not deliver the specific neuromuscular stimulus of a threshold run.

Decision: **always preserve quality sessions; reduce easy volume first.** The
Protection Hierarchy (easy → long run distance → threshold intensity → VO2 intensity)
applies regardless of cross-training intensity type.

The timing check above (day-proximity → intensity downgrade) handles the case where
a hard sport session precedes a quality run. Quality runs are never cancelled; they
may be downgraded if proximity warrants it.

#### Quality session independence

Cross-training surplus and quality session presence are **two independent checks**:

1. "Is Signal B excess above baseline?" → drives Tier 1/2/3 response (volume + intensity)
2. "Are quality sessions complete this week?" → separate flag; drives separate prompt

Never cancel or silently drop a quality session because of cross-training surplus.
If the user has missed a threshold run and done football instead: log the football
normally, flag the quality session as missed, do not credit the football toward it.

#### Timing of "Adjust Week" moment

Two moments, both on-demand (not auto-triggered):

1. **During the week**: "Adjust Week" card appears on Training tab whenever unresolved
   excess or timing issues exist. Shows Signal B to date vs plan, remaining sessions,
   suggested adjustments. User approves or dismisses.

2. **At week start**: If excess load carried from the previous week, a summary card
   appears at the top of the Training tab: *"Last week had 28 TSS of unresolved
   cross-training load. Here's how it affects this week's plan."* Same adjust flow.

Neither fires as a blocking popup. Both are dismissable with one tap.

---

## Resolved Design Decisions (2026-03-03)

### ACWR model: Signal B acute, Signal A chronic
- Acute (ATL, 7-day): raw physiological TSS — what your body actually experienced
- Chronic (CTL, 42-day): running-equivalent TSS only — what your body is adapted to run
- Ratio = "how fatigued are you relative to your running base?"
- Cross-training fatigue correctly pushes ratio up; consistent running builds the chronic base

### Adding runs when fatigue is low
Trigger: Signal B fatigue LOW **and** running volume below phase minimum. Both required —
never add running to a fatigued athlete.
Presentation: non-blocking nudge card on week advance. One-tap dismiss reverts silently.
Extend existing sessions only — no new session days added.

### Leg strength gym work
- Signal A: ~0.35 runSpec — partial transfer via force production and injury resilience
- Signal B: full iTRIMP — heavy compound work genuinely depletes recovery capacity
- Signal C: HIGH impact — day-before-long-run warning trigger

---

## Resolved Design Decisions (2026-03-04) — Charts & Signal Consistency

### D1 — Training Load chart: total Signal B split aerobic/anaerobic

The Training Load chart shows **total physiological load (Signal B)** per week as a smooth
area chart. The area is split into two layers using real data from the Universal Load Model:

- **Aerobic layer (blue)**: sum of aerobic iTRIMP from each activity's HR zone analysis
  (Zone 1–3 cardiovascular work). For runs: easy + marathon pace effort. For cross-training:
  the aerobic output from `classifyWorkoutType()` / Garmin aerobic Training Effect.
- **Anaerobic layer (orange overhang)**: the anaerobic iTRIMP component on top
  (Zone 4–5 / high-intensity intervals / court sports with HR spikes).

**This split is always from real HR data — never a hardcoded percentage fallback.**
If aerobic/anaerobic breakdown is unavailable for an activity (e.g. RPE-only Tier C),
show the total load as a single colour with no split and mark the bar as "estimated"
(slightly desaturated). Remove it immediately when HR data syncs.

Running is not shown as a separate layer — the chart answers "how hard did your body work
and at what intensity?" not "which sport did you do?"

### D2 — Pre-plan history: no proxies, no fabrication

Pre-plan weeks (before plan start date) must use real Signal B data from the
`sport-history` edge function. This edge function queries `garmin_activities`, sums raw
iTRIMP (no runSpec discount) per week, and returns `{ weekStart, rawTSS, aerobic, anaerobic }`.

**Until the edge function is built:**
- Show pre-plan bars with Signal A from `historicWeeklyTSS` in a **muted grey** colour
- Add chart footnote: "Pre-plan bars show running load only — cross-training history
  loading…" with a sync icon
- Do NOT apply a multiplier proxy (× 1.4 or any constant). Show what we have, labelled honestly.
- Mark OPEN_ISSUES.md as P1 for the `sport-history` edge function build.

**`historicWeeklyRawTSS` is NOT optional.** It is load initialisation data. The plan's
aggressiveness targets, baseline excess detection, and onboarding chart all depend on it.

### D3 — Running Fitness chart: weekly Signal A bars + CTL fitness zone bar

The Running Fitness chart has two visual elements:

1. **Weekly Signal A bars** (green area, same shape as Training Load chart):
   `computeWeekTSS(wk, wk.rated, planStartDate)` for in-plan weeks. `historicWeeklyTSS`
   for pre-plan weeks. This gives the chart shape and shows week-to-week running variation.

2. **CTL fitness zone bar** (below the area chart, replacing the flat CTL line):
   A horizontal zone bar showing the athlete's current CTL as a score on a labelled scale,
   styled like Garmin's Endurance Score. Zones:

   | Zone | CTL range | Label |
   |---|---|---|
   | 1 | 0–30 | Building |
   | 2 | 30–60 | Foundation |
   | 3 | 60–90 | Trained |
   | 4 | 90–120 | Performance |
   | 5 | 120+ | Elite |

   The filled marker shows current CTL position. CTL value shown numerically top-right.
   Caption: "42-day running fitness · higher = better prepared for pace targets"

### D4 — One signal per display context — no cross-signal comparisons

**Every display that shows actual vs planned, actual vs target, or actual vs baseline
must use the same signal on both sides.** Cross-signal comparisons (Signal A actual vs
Signal B baseline, or Signal B actual vs Signal A plan) are forbidden — they produce
numbers that cannot be understood without a PhD explanation.

| Display | Actual signal | Plan/baseline signal |
|---|---|---|
| Home "Training Load" progress bar | Signal B (`computeWeekRawTSS`) | Signal B baseline (`signalBBaseline`) |
| Stats "This Week" card | Signal B | Signal B baseline (prorated from `signalBBaseline`) |
| Plan "Week load: X planned · Y so far" | Signal B (`computeWeekRawTSS`) | Signal B (`computePlannedSignalB` — running plan + cross-training budget, see `LOAD_BUDGET_SPEC.md` §2) |
| Stats Training Load chart | Signal B | Signal B (bars); Signal A CTL (reference line only, labelled) |
| Stats Running Fitness chart | Signal A | Signal A CTL zone bar |
| ACWR | ATL = Signal B | CTL = Signal A (asymmetry is intentional and documented) |

The ACWR asymmetry (Signal B ATL / Signal A CTL) is the single deliberate exception,
and it must always be labelled in the UI: "Fatigue from all training ÷ Running base."

---

## Initialization Principle

When a user starts a plan, their aerobic fitness is almost never zero — they cycle, play sports,
go to the gym. But the app initialises `ctlBaseline` from `historicWeeklyTSS` which is Signal A
(run-equivalent, with runSpec discounts applied by the Strava edge function). This correctly
reflects running-specific adaptation but under-estimates total aerobic fitness.

### The aerobic base gap

A user with 8 weeks of heavy cycling has Signal A CTL ≈ 25 (low running transfer) but
Signal B would be ≈ 55 (genuine cardiovascular fitness). They can sustain running load
faster than a true beginner but their connective tissue (Signal C) may not be ready for
full mileage immediately.

**Framing for the user**: "You have aerobic fitness from [cycling/gym/sports]. This plan
will help you convert that into running fitness over your first few weeks."

### Practical rule (pending Signal B history)

If `Signal B CTL / Signal A CTL > 1.5` (cross-training-heavy history), surface a note
during onboarding: "You've been active outside running. We'll ramp up running volume
carefully to protect your joints and tendons while building on your aerobic base."

### Code implication (deferred)

Initialization logic should compute a "raw aerobic baseline" alongside `ctlBaseline`
to seed plan aggressiveness. Signal B history from the edge function would be the
correct input. For now, `ctlBaseline` is Signal A only.

**TODO**: When Signal B history is available from the edge function, seed plan
aggressiveness from raw aerobic baseline, not just Signal A CTL.

### Signal B history gap — P1 priority

`historicWeeklyTSS` comes from the Strava edge function and applies runSpec discounts
(Signal A only). True Signal B history requires a new `historicWeeklyRawTSS` array
from the `sport-history` edge function (sums raw iTRIMP per week without runSpec).

**No proxies permitted** (see Resolved Design Decision D2). Until the edge function
exists, pre-plan bars show Signal A in muted grey with an honest label. This is a
P1 build item — the plan baseline, excess detection tiers, and onboarding load chart
all depend on real Signal B history.

---

## Planned Load Model (ISSUE-79) — TO BE IMPLEMENTED

The weekly `plannedTSS` must be grounded in the athlete's actual fitness, not a hardcoded
constant. The current fallback `runs/week × 50` is wrong for any athlete with a non-trivial
training history.

### Source of truth: CTL baseline

`plannedTSS` for any given week = `ctlBaseline × phaseMultiplier`.

`ctlBaseline` is the 42-day Signal A (running-equivalent) chronic load — it represents
what the athlete's body is adapted to. The plan should prescribe load relative to this.

### Phase multipliers

| Phase    | Multiplier | Rationale |
|----------|-----------|-----------|
| Base     | 0.95–1.00 | Maintain current fitness, build consistency |
| Build    | 1.05–1.10 | Progressive overload — 5–10% above chronic |
| Peak     | 1.10–1.15 | Maximum sustainable overreach |
| Deload   | 0.70–0.75 | Recovery week — 25–30% reduction |
| Taper    | Linear ramp from 0.85 → 0.55 over taper weeks |

### Weekly reset

`plannedTSS` is always for the current week. On Monday it represents the full week target.
The "X / Y" display should read as "done so far / this week's target". Percentage = progress
toward the week's goal, not deviation from a prorated midweek baseline.

### Cross-training inclusion — SUPERSEDED

> **This section is outdated.** The plan bar is now Signal B vs Signal B, with the planned
> target including a cross-training budget derived from Strava history. See
> `docs/specs/LOAD_BUDGET_SPEC.md` for the full design.
>
> Previous approach (Signal A vs Signal A, cross-training tracked separately) created a
> cross-signal mismatch on the plan bar and made cross-training feel like an unwanted
> overshoot rather than expected activity.

### Fallback when no CTL

New users without history: use the onboarding-derived fitness estimate (from race times or
declared activity level) to seed an initial CTL, then apply phase multipliers. The current
`runs/week × 50` fallback stays only as a last resort when no data is available at all.

---

## No Hardcoded Splits / Fabricated Data

**Never display fabricated percentages or splits.** If real data is not available, show a
single unsplit bar or a "needs HR data" message. Hardcoded splits (e.g. "60% base / 25%
threshold / 15% intensity") mislead users into thinking data is real when it's made up.

Rules:
- Zone breakdowns (aerobic/anaerobic, base/threshold/intensity) must come from actual HR zone
  data (`historicWeeklyZones`, `hr_zones` from Strava/Garmin, or `classifyWorkoutType()`)
- When zone data is unavailable: show a single grey bar with "Zone data requires HR — connect your watch"
- **Never** apply a hardcoded percentage proxy (60/25/15 or any constant ratio)
- This applies everywhere: charts, bars, pie charts, activity cards, week summaries
- If a value is estimated (e.g. TSS from RPE, not HR), label it as "estimated" — never present it as measured

This principle is non-negotiable. Fabricated precision erodes trust faster than missing data.

---

## Open Design Questions

1. **Where to surface Signal C (impact)**: Day-before warning card on plan view?
   Sub-score on home? Computed and stored (`wk.actualImpactLoad`) but not yet displayed.

2. **ACWR explanation when cross-training drives the spike**: Users may be confused
   ("I barely ran, why is risk elevated?"). Needs explicit attribution in UI:
   "Your heavy load sport contributed X TSS to this week's load." *(see also ISSUE-09)*

3. **Nudge card: extend vs new session**: Current decision is extend existing sessions only.
   Revisit when minimum running thresholds are fully specced per phase.

4. **Signal B baseline data dependency** — ✅ RESOLVED. `historicWeeklyRawTSS` and
   `sportBaselineByType` are populated from the Strava edge function. Signal B baseline
   is computed in `stravaSync.ts`. See `docs/specs/LOAD_BUDGET_SPEC.md` §3 for the
   updated per-session median formula (replaces simple weekly average).

5. **Per-sport calibration** — ✅ DATA EXISTS. `sportBaselineByType` already computes
   per-sport average session TSS and frequency. Used by the Load Budget spec for
   cross-training budget calculation. Per-sport excess detection is deferred (§10).

6. **Load Budget & Excess Detection redesign**: Full spec in
   `docs/specs/LOAD_BUDGET_SPEC.md`. Key changes: plan bar becomes Signal B vs Signal B,
   excess detected from total week overshoot (not just unmatched items), reductions
   sized with Signal A and modulated by 5-day recovery trend.
