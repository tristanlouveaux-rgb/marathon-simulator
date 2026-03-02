# Phase B — Design Continuation Document

**Purpose:** Allow a new agent to continue this conversation seamlessly after context compaction.
**Date:** 2026-02-26
**Status:** Phase B coded and passing typecheck. Design discussion ongoing before Phase B v2 / Phase C.

---

## 1. What Phase B Built (Completed Code)

### Files changed
| File | What changed |
|---|---|
| `src/calculations/fitness-model.ts` | Added `computeACWR()`, `AthleteACWR` interface, `AthleteACWRStatus` type, `TIER_ACWR_CONFIG` (5 tiers) |
| `src/types/state.ts` | `SimulatorState.athleteTier?`, `.athleteTierOverride?`; `Week.weekAdjustmentReason?` |
| `src/workouts/plan_engine.ts` | `PlanContext.acwrStatus?`; caution → -1 quality session; high → -2 + cap long run |
| `src/workouts/generator.ts` | `acwrStatus?` param passed through to `planWeekSessions` |
| `src/ui/suggestion-modal.ts` | `ACWRModalContext` interface; optional 4th param renders ACWR context header |
| `src/ui/main-view.ts` | Excess load card **retired**; ACWR bar added to "This Week" panel; `updateACWRBar()`, `triggerACWRReduction()`, `showACWRInfoSheet()`, lightened-week banner |
| `src/ui/stats-view.ts` | PMC section expanded with ACWR ratio, bar, CTL/ATL/TSB grid, tier badge |

### What the ACWR bar shows
- Inside "This Week" panel, below zone bars
- Colour-coded ratio (safe green / caution amber / high red)
- Gradient bar with safe-threshold marker (varies by tier)
- Status text: "Load well-managed (1.1×)" / "Load increasing quickly (1.42×)" / "Load spike detected"
- "Reduce this week" button — **currently only appears when ACWR is caution/high**
- `[?]` → ACWR info bottom sheet

### Known gap introduced
**The excess load card was retired but the ACWR bar gates "Reduce this week" on caution/high status.** ACWR needs 3 weeks of plan history. So for the first 3 weeks (and for users whose ACWR is "unknown"), there is currently NO action offered even when actual TSS is 78%+ over plan. This is a priority fix. See §4.

### What is NOT yet wired
`generateWeekWorkouts()` callers in `events.ts` (week advance) and `main-view.ts` don't yet pass `acwrStatus`. Decision made to wire it — see §5 Q2.

---

## 2. Current System Architecture (Relevant to This Discussion)

### Load calculation chain
```
Strava HR stream → iTRIMP → normalizeiTrimp() → TSS (≈55 for easy 60min)
RPE × TL_PER_MIN → TSS fallback (no HR)
Cross-training: TSS × sport.runSpec (e.g. padel=0.50, cycling=0.35)
Zone split: hrZones (z1–z5 seconds) → base/threshold/intensity ratio OR LOAD_PROFILES[workoutType] fallback
```

### CTL/ATL decay constants (already implemented, scientifically grounded)
```
CTL decay = e^(-7/42) ≈ 0.847/week (42-day EMA = chronic fitness)
ATL decay = e^(-7/7)  = 0.368/week (7-day EMA = acute fatigue)
ACWR = ATL / CTL
```
- Old load decays exponentially — it never fully disappears but becomes negligible ~12 weeks after rest
- Different athlete tiers already have different ACWR safe thresholds (beginner 1.2× ... high_volume 1.6×)
- The user liked this and confirmed: **integrate CTL decay as-is, it's correct**
- User asked if different athletes have different recovery rates — yes, the tier thresholds capture this indirectly. Could be extended with tier-specific ATL decay constants in Phase C if needed.

### HR zone data available in state
- `GarminActual.hrZones?: { z1, z2, z3, z4, z5 }` — seconds per zone from Strava HR stream
- `GarminPendingItem.hrZones?` — same, available at time of replacement decision
- `CrossActivity.iTrimp?` — total iTRIMP from HR stream
- `LOAD_PROFILES[workoutType]` — fallback when no HR: `{ base, threshold, intensity }` fractions

### Sport multipliers (runSpec)
```
// src/constants/sports.ts — SPORTS_DB
runSpec: how much of a sport's TSS transfers to running fitness
  cycling: 0.35, swimming: 0.20, padel: 0.50, rugby (touch): ~0.60
```
Currently used when converting cross-training TSS to running-equivalent load. **Not currently used** in replacement decision logic — the replacement decision uses sport label, not actual HR zones.

### Replacement flow (existing, in activity-review.ts)
When a Garmin activity is synced mid-week:
1. `showActivityReview()` offers "Integrate" or "Log only"
2. If integrate: calls `buildCrossTrainingPopup()` → `showSuggestionModal()` → user picks Replace/Reduce/Keep
3. Replace: removes planned run, logs cross-training as completion
4. Reduce: downgrades planned run (distance cut)
5. Currently uses sport label + TSS magnitude, NOT HR zone distribution

---

## 3. Decisions Made in This Conversation

### ✅ Confirmed: CTL/ATL decay model is correct, keep as-is
The exponential decay is well-grounded. Load never fully disappears — it decays over time. This is the right model.

### ✅ Confirmed: Override with debt tracking (not week reset)
When user overrides a reduction recommendation:
- Record the override in state (`Week.acwrOverride?: boolean`)
- Add the "forgiven" load back into ACWR calculation as a debt (effectively raising ATL numerator)
- After 2 consecutive override weeks: escalate warning severity
- ACWR ratio still visible — only the "Reduce" button gets suppressed temporarily

### ✅ Confirmed: Zone carry tracking by dominant zone
When actual TSS > planned TSS:
- Track `Week.carriedTSS?: { base: number; threshold: number; intensity: number }`
- Display dominant zone in banner: "Carrying +50 intensity TSS from Week 8"
- User clicks to expand: shows full breakdown
- Multiple weeks stacking: cumulative sum shown, with oldest week fading (weighted by CTL decay — weeks further back count less)
- Stack display: sparkline of carried load per week, tapping shows breakdown

### ✅ Confirmed: Running km as second ACWR signal (replacing leg impact)
Replace the heuristic "leg impact units" with a scientifically defensible metric:
- **Volume ACWR** = running km this week / 42-day average running km/week
- Shown as a second bar or integrated into the existing ACWR bar
- Triggers: km spiked but load looks fine → shorten easy runs / long run, preserve quality
- This is the Gabbett et al. research basis — running volume spikes → stress fracture risk
- The user pushed back: **does playing lots of rugby/football count as "volume" for this metric?**
  - Decision pending — see §5 Q3 (leg load debate)

### ✅ Confirmed: Reduction priority matches user's trailing zone mix
NOT a fixed hierarchy. Look at trailing 4-week zone distribution:
- User doing mostly base + light cross-training → preserve their 1 quality session, cut easy run distance first
- User with consistently intensity-heavy weeks → intensity is the source, reduce there
- Walking/chill sports spiking → cut easy runs, long run survives
- The "what pushed this week above plan" drives where to cut

### ✅ Confirmed: Show "Reduce this week" button also when actual > 120% planned (not just ACWR caution/high)
Gap fix: ACWR is blind for first 3 weeks. Also trigger the button on raw over-plan % even without ACWR history.

### ✅ Confirmed: Wire acwrStatus into week-advance flow in events.ts
One-liner: compute ACWR at week advance time, pass status to `generateWeekWorkouts()`. User confirmed this should happen with user override option.

---

## 4. Immediate Priority Fixes (Phase B v2)

In priority order:

### 1. HR zone matching for replacement decisions (MOST IMPORTANT)
**Currently:** Replacement decision uses sport type label + TSS magnitude
**Should be:** Use `hrZones` from the activity to classify what TYPE of workout it was:
```typescript
// Classify cross-training activity from HR distribution
baseRatio      = (z1+z2) / total_zone_seconds
threshRatio    = z3 / total_zone_seconds
intensityRatio = (z4+z5) / total_zone_seconds

if (baseRatio > 0.80)      → maps to "easy run" profile
if (threshRatio > 0.40)    → maps to "threshold/tempo" profile
if (intensityRatio > 0.30) → maps to "interval/VO2" profile
```
Then apply `runSpec` (sport multiplier) to TSS for running-equivalent load.
Compare zone profile + adjusted TSS to planned run's `LOAD_PROFILES[type]`.
If match within 20% TSS AND similar zone profile → full replacement.
If zone mismatches significantly → partial credit + flag "this sport session was more [type] than planned."

**This means the decision is data-driven from actual HR, not sport label.** 90min padel with easy HR replaces easy run. Padel with high Z4 → replaces threshold. We don't care what sport it is, only what the body actually did.

### 2. Trigger "Reduce this week" button on raw over-plan % (gap fix)
When actual TSS > planned TSS × 1.20 AND ACWR status is 'unknown' or 'safe', still show the button. Text changes from "Load spike detected" to "This week exceeds your plan by X%."

### 3. Wire acwrStatus into week-advance flow
In `src/ui/events.ts`, where `generateWeekWorkouts()` is called for the new week:
```typescript
const tier = s.athleteTierOverride ?? s.athleteTier;
const acwr = computeACWR(s.wks, s.w, tier);
// pass acwr.status as last arg to generateWeekWorkouts()
```
This makes the plan automatically lighter next week when ACWR was elevated.

### 4. Zone carry tracking
Add `Week.carriedTSS?: { base: number; threshold: number; intensity: number }` to `src/types/state.ts`.
Populate it when actual exceeds planned by zone.
Display in training tab as expandable banner. Multi-week stacking shows cumulative with decay weighting.

### 5. Override with debt
Add `Week.acwrOverridden?: boolean`. When overridden: compute synthetic debt ATL, add to ACWR calculation. Escalate after 2 consecutive overrides.

---

## 5. Open Design Questions (Decisions Still Needed)

### Q1: Can a sport fully replace a marathon training run?

**Core project philosophy question.** The user's vision: training for a marathon by running BUT ALSO playing sports — make marathon training more accessible and fun. The question is how much cross-training can substitute for actual running km.

**The nuance:** For marathon specifically, tendons, bones, and connective tissue adapt to running-specific mechanical load. Cycling TSS ≠ running TSS for these adaptations, even if cardiovascular load matches. Missing running km consistently → reduced running-specific conditioning (relevant for marathon race day performance and injury prevention from running mechanics).

**User's instinct:** Yes, sports should be able to replace runs, but we should probably enforce a minimum running volume per week (TBD what that number is).

**Decision needed:**
- What is the minimum running km/week for a marathon trainee? (Likely 30–40km at peak as an absolute minimum for race-specific adaptation)
- When cross-training replaces a run: full substitution on load terms, but flag if weekly running km drops below threshold
- Should the app warn after X consecutive weeks with low running km?

**Rugby specifically:** User correctly noted no one wears a Garmin for real rugby. If Garmin shows "Rugby" it's almost certainly touch rugby. This is lighter intensity, shorter distances, still significant aerobic work. Should map via HR → likely tempo/easy, then apply runSpec ≈ 0.55.

### Q2: If HR-matched rugby (tempo) — replace tempo run or reduce it?

This is the key question for the replacement flow:

**Option A — Full replace:** Rugby with tempo HR → replaces the tempo run. User doesn't need to run the tempo. Keeps total load manageable.

**Option B — Reduce tempo run:** Rugby with tempo HR → reduces (shortens) the tempo run. User still runs but at reduced distance. Reasoning: running-specific adaptation matters, but the aerobic load is covered.

**Option C — Flag and let user decide:** Show "your rugby session matched a tempo run on HR. Replace your tempo? (Reduces running km by 8km) or Reduce to 15min?" Give the choice.

**User's lean:** Hasn't decided. The spirit of the project is "sports can replace runs" but the marathon training reality is that running km matters. Option C feels right for this project — give the user the information and the choice.

### Q3: Does rugby/football "volume" count toward the running km ACWR?

The leg impact → running km ACWR replacement debate: does intense multi-directional running in rugby/football count toward mechanical stress on tendons and bones?

**Argument for yes:** Directional running in field sports does load similar structures. Touch rugby at 8km of running is mechanically similar to a 8km easy run in terms of bone/tendon load.

**Argument for no:** Marathon-specific running mechanics are different (sustained pacing, foot strike patterns). Field sport running doesn't condition the same adaptations.

**Practical consideration:** We don't get GPS running distance data from "rugby" on a watch — just duration and HR. Without actual running km data from the session, we can't add it to a km-based ACWR directly. We could estimate from HR and sport type but this is speculative.

**Likely decision:** Keep running km ACWR as actual running km only (GPS-tracked). Cross-training doesn't add to km ACWR even if it's high-impact. Instead, high-impact cross-training reduces the "budget" for running km that week (more of the mechanical budget is used). This is complex — may be over-engineering.

**Simpler approach user may prefer:** Just show running km/week trend as a standalone metric without a complex second ACWR. "You've run 28km this week vs 35km planned." Let the user see it and decide.

### Q4: How to display multiple weeks of stacking carry load?

When week 6 carries +50i TSS, and week 7 also runs over (adds +30i more), by week 8 the user has accumulated debt from both weeks.

**Option A — Cumulative:** "Carrying +80 intensity TSS (from W6 +W7)" — simple but might feel overwhelming.

**Option B — Decayed:** Apply CTL-style decay to the carry. W6 debt at 0.85× after 1 week. W7 debt at 1.0×. Total ≈ 0.85×50 + 30 = 72.5i. More accurate to actual fatigue reality.

**Option C — Rolling window:** Only show carry from last 2 weeks, older debt assumed "absorbed."

User's preference: "have a think and get back to me." My leaning: **Option B** — use CTL decay on carried load for consistency with the underlying model. Display as sparkline showing per-week contribution (tappable).

---

## 6. The "How Your Plan Adapts" Principles Display

Agreed by both: a collapsible section somewhere accessible that explains the system in plain language. Draft principles:

> **Load matching:** We compare your actual training (from Strava HR) to what was planned. If you did a sport session that looks like a tempo run on heart rate, it can replace your tempo.
>
> **Replacement priority:** Long runs are preserved. Quality sessions (intervals, threshold) are protected unless your ACWR is high or you're consistently intensity-heavy. Easy runs are reduced first.
>
> **Carry forward:** If you train significantly over plan, the excess load carries into next week's calculations. You'll see what you're bringing forward.
>
> **Override:** Always your choice. We track your overrides — if you consistently override during high-risk weeks, we'll tell you.
>
> **Minimum run guarantee:** We always keep at least 2 run sessions per week for event training. No cross-training can reduce you below that.

**Question on priority:** User asked "is that the priority?" — meaning is building this display the priority vs the functional fixes in §4. Answer: No, the functional fixes in §4 come first. This is polish/explainability layer once the logic works correctly.

---

## 7. Things User Specifically Asked to Push Back On / Discuss

1. **"Different athletes have different recovery rates"** — yes, the tier system captures this via different ACWR safe thresholds. Could also be extended with tier-specific ATL decay constants (beginner: shorter 5-day ATL constant vs elite: 7-day). Not built yet, flagged for future consideration.

2. **"Rugby/football leg load should matter"** — the debate in Q3 above. Not resolved. User's concern: purely aerobic (cardiovascular) metrics miss the mechanical load from high-impact sports. Valid. The running km ACWR partially captures this for running sessions. For cross-training high-impact, it's an open question.

3. **"Padel replacing a run is at the core of the project"** — this is the fundamental philosophy debate in Q1/Q2. User wants people to be able to train for a marathon while playing sports they love. The tension is marathon-specific km requirements. Not resolved.

4. **Sport multiplier confusion** — user asked where `runSpec` is currently used. Answer: only in TSS calculation (cross-training TSS × runSpec = running-equivalent TSS for load tracking). It is NOT currently used in replacement decisions. The HR zone matching (§4 item 1) would be where it gets integrated into replacement logic: `(sport_TSS × runSpec)` vs `planned_run_TSS`.

---

## 8. Key File Locations for Next Agent

| Topic | Files |
|---|---|
| ACWR computation | `src/calculations/fitness-model.ts` — `computeACWR()`, `TIER_ACWR_CONFIG` |
| ACWR bar display | `src/ui/main-view.ts` — `updateACWRBar()`, `triggerACWRReduction()` |
| Cross-training replacement | `src/ui/activity-review.ts` — `showActivityReview()`, `buildCrossTrainingPopup()` |
| Sport multipliers | `src/constants/sports.ts` — `SPORTS_DB.runSpec` |
| HR zone data | `src/types/state.ts` — `GarminActual.hrZones`, `GarminPendingItem.hrZones` |
| Suggestion modal | `src/ui/suggestion-modal.ts` — `showSuggestionModal()`, `ACWRModalContext` |
| Plan lightening | `src/workouts/plan_engine.ts` — `planWeekSessions()`, `PlanContext.acwrStatus` |
| Week advance flow | `src/ui/events.ts` — search for `generateWeekWorkouts` call in `next()` function |
| Zone carry (to build) | `src/types/state.ts` — add `Week.carriedTSS?: {base, threshold, intensity}` |
| Override debt (to build) | `src/types/state.ts` — add `Week.acwrOverridden?: boolean` |
| Load profiles | `src/constants/workouts.ts` — `LOAD_PROFILES` (3-zone fractions per workout type) |
| Cross-training suggester | `src/cross-training/suggester.ts` — `buildCrossTrainingPopup()`, `applyAdjustments()` |

---

## 9. Next Session Starting Point

**Tell the next agent:** "Read `docs/PHASE_B_CONTINUATION.md` in full before doing anything. We are continuing from a design discussion about the ACWR/load/replacement system. The document contains all decisions made, all open questions, and the priority order for what to build next. Start by confirming you've read the document and summarising the open questions before writing any code."

**Priority for next session:**
1. Wire `acwrStatus` into `events.ts` week-advance flow (1 change, low risk)
2. Add "Reduce this week" trigger on raw over-plan % (not just ACWR)
3. Resolve Q1/Q2 (padel/rugby philosophy) — needs ~10min discussion before coding replacement logic
4. Build HR zone matching for replacement (§4 item 1) — main engineering task
5. Zone carry tracking (`Week.carriedTSS`) — straightforward state + display work

**Do NOT start coding §4 items 3–5 (zone carry, override debt) without first resolving Q1/Q2 — those decisions affect the data model.**
