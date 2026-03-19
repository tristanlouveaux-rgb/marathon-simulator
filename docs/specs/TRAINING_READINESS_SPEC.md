# Training Readiness System — Design Spec v3 (Final)

> **Status**: Locked for build.

---

## Core Concept

A **composite Training Readiness score (0–100)** on the Home page. One ring gauge, one sentence, one number. Answers: **should I do today's workout as planned, dial back, or push?**

Click the ring → expands to show the sub-metrics that drive it.

**Plan-aware** — unlike Garmin's Training Readiness which only asks "Am I recovered?", ours answers "Should I do *today's specific planned workout* as-is?" and offers to swap/reduce if not.

---

## No Jargon Policy

> User-facing UI must NEVER show ATL, CTL, TSB, ACWR. Those are internal names only.

| Internal | User-Facing Label | Only in Advanced/Info sheets |
|---|---|---|
| CTL | Running Fitness | "CTL (Chronic Training Load)" |
| ATL | Short-Term Training Load | "ATL (Acute Training Load)" |
| TSB | Freshness | "TSB (Training Stress Balance)" |
| ACWR | Load Safety | "ACWR (Acute:Chronic Workload Ratio)" |

---

## How ATL Fits In

```
CTL = 42-day EMA of daily load → "Running Fitness" / how adapted you are
ATL = 7-day EMA of daily load → "Short-Term Load" / how tired you are
TSB = CTL − ATL → "Freshness" / how recovered
ACWR = ATL ÷ CTL → "Load Safety" / how fast you're ramping
```

ATL appears in both TSB and ACWR. No separate display needed.

---

## The Four Sub-Signals

| Signal | User-Facing Name | Weight (with recovery) | Weight (without) | Source |
|---|---|---|---|---|
| **Fitness Readiness** | Freshness | 35% | 40% | `computeFitnessModel().tsb` |
| **Load Safety** | Load Safety | 30% | 35% | `computeACWR().ratio` |
| **Training Momentum** | Momentum | 15% | 25% | CTL now vs 4 weeks ago |
| **Recovery** *(optional)* | Recovery | 20% | — (greyed out) | `physiologyHistory` |

> [!NOTE]
> **Recovery data already exists** in `PhysiologyDayEntry`: `sleepScore` (0–100), `hrvRmssd` (ms), `restingHR` (bpm). Flows via `physiologySync.ts`. When no watch connected → pill greyed out with "Connect watch to unlock." **No dummy defaults.** If unavailable, recovery is excluded entirely.

### Score formula

```typescript
const fitnessScore = clamp(0, 100, ((tsb + 40) / 70) * 100);
const safetyScore = clamp(0, 100, ((2.0 - acwr) / 1.2) * 100);
const momentumScore = ctlNow > ctlFourWeeksAgo ? 100
  : ctlNow > ctlFourWeeksAgo * 0.9 ? 65 : 30;

// Recovery: ONLY when real data exists
const hasRecovery = sleepScore != null || hrvRmssd != null;
let recoveryScore: number | null = null;
if (sleepScore != null) recoveryScore = sleepScore;
if (hrvRmssd != null) {
  const hrvDelta = (hrvRmssd - hrvPersonalAvg) / hrvPersonalAvg;
  recoveryScore = clamp(0, 100, (recoveryScore ?? 50) + hrvDelta * 30);
}

let readiness = hasRecovery && recoveryScore != null
  ? fitnessScore * 0.35 + safetyScore * 0.30 + momentumScore * 0.15 + recoveryScore * 0.20
  : fitnessScore * 0.40 + safetyScore * 0.35 + momentumScore * 0.25;

// ── SAFETY FLOOR ──────────────────────────────────────────────
// High ACWR is dangerous regardless of other signals.
if (acwr > 1.5) readiness = Math.min(readiness, 39);
if (acwr > 1.3 && acwr <= 1.5) readiness = Math.min(readiness, 59);
```

> [!IMPORTANT]
> **Safety floor**: A good night's sleep doesn't make a load spike safe. ACWR is a hard constraint. This prevents someone getting "On Track" when they have dangerous load ramping.

### Score → label

| Score | Label | Colour | Action |
|---|---|---|---|
| 80–100 | **Ready to Push** | Green | Full session. Add extra if you feel good. |
| 60–79 | **On Track** | Blue | Session as planned. |
| 40–59 | **Manage Load** | Amber | Suggestion card: consider reducing. Dismissable. |
| 0–39 | **Ease Back** | Red | Warning modal. Dismissable — user can push through. |

---

## Reduction Logic — All Suggestions, Never Forced

> **We never block the athlete.** They know their body. All reductions are suggestions.

| Readiness | Tier | What Happens |
|---|---|---|
| 80–100 | None | Full session as planned |
| 60–79 | Tier 1 (Silent) | Easy runs shortened. "Auto-adjusted" note. Can undo. |
| 40–59 | Tier 2 (Suggest) | Card with suggestion. User can dismiss. |
| 0–39 | Tier 3 (Warn) | Warning modal. **User can dismiss and push through.** |

### Metric-Specific Advice

The card/modal tells the user **why** readiness is low and suggests action accordingly:

| Driving Signal | Message | Suggested Action |
|---|---|---|
| **Load Safety** | "Your training load spiked this week" | Reduce session volume, or swap hard for easy |
| **Freshness** | "You've accumulated fatigue" | Swap for easy effort, or take rest day |
| **Recovery** | "Poor sleep — your body needs more time" | Lighter session, or postpone to tomorrow |
| **Momentum** | "Your fitness is dropping" | Maintain consistency, don't skip |

`ReadinessResult.drivingSignal` = the sub-metric with the lowest individual score.

### Session Swap Suggestions

When readiness is low, the system can suggest swapping today's session: e.g. "Do the easy run today instead of tempo." This reuses the existing `triggerACWRReduction()` machinery in `main-view.ts` — readiness becomes the **trigger**, the existing modal/adjustment logic is the **mechanism**.

---

## System Interaction Map

> Readiness **wraps** the existing reduction system, it doesn't replace it.

| Existing System | Location | What Happens |
|---|---|---|
| `triggerACWRReduction()` | main-view.ts | **Readiness calls this** with `drivingSignal` context |
| `updateACWRBar()` | main-view.ts (plan view) | **Stays** — plan view keeps ACWR bar |
| `renderExcessLoadCard()` | excess-load-card.ts | **No change** — plan-tab only |
| `updateCarryBanner()` | main-view.ts | **Stays** — carried TSS already inflates ATL → feeds readiness |
| `computeConsecutiveOverrides()` | main-view.ts | **Keep** — override tracking escalates warnings |
| `acwrOverridden` on Week | state.ts | **Keep** — feeds ATL inflation in computeFitnessModel |
| `recoveryDebt` on Week | state.ts | **Keep** — feeds ATL inflation → affects TSB → readiness |
| `carriedTSS` on Week | state.ts | **Keep** — decays via CTL formula, already inflates ATL |

---

## Decision Matrix

What the home page sentence says:

| | Load Safe (≤1.3) | Load Moderate (1.3–1.5) | Load High (>1.5) |
|---|---|---|---|
| **Fresh** (TSB > 0) | "You're rested and safe. Full session." | "Fresh but ramping — stick to the plan." | "Sudden spike. Go easy despite feeling fresh." |
| **Recovering** (−10 to 0) | "Good balance. Session as planned." | "Training hard. Prioritise sleep tonight." | "Back off. Shorten or swap for easy." |
| **Fatigued** (−25 to −10) | "Tired but adapted. Easy effort today." | "You need recovery. Reduce today." | "Skip or active recovery only." |
| **Overtrained** (< −25) | "Deep fatigue. Rest day." | "Rest. Multiple days off recommended." | "Rest. Stop until recovered." |

---

## Edge Cases

| Scenario | What Happens | Why It's Correct |
|---|---|---|
| Fresh + high ACWR (2 weeks off, big session) | Safety floor caps at 39 | Feeling fresh doesn't make a spike safe |
| Low fatigue + safe ACWR + poor sleep | "Manage Load" via recovery signal | Training-safe but body not recovered |
| Week 1-3 (no history) | Defaults to "On Track" | Safe default, insufficient data |
| Deload week | Low ATL, positive TSB → "Ready to Push" | Correct — you ARE ready |
| Taper | Rising TSB, dropping ATL → readiness climbs | Correct — peaking for race |
| No recovery data | 3-signal formula, recovery pill greyed out | No dummy scores |

---

## Home Page Layout

### Killed
- ~~Injury Risk bar~~ → folded into readiness (Load Safety sub-signal)
- ~~Sparkline / 8-week chart~~ → Stats page only

### Kept
- **This Week card** (sessions, distance, load progress bars)
- **Today's Workout** hero card
- **Recent Activities** (enhanced: HR, calories, time from Strava — hidden if unavailable)

### New: Training Readiness Ring

```
┌───────────────────────────────────┐
│       ╭────  73  ────╮           │
│      ╱    On Track    ╲          │
│     │  "Do today's     │         │
│     │   session as     │         │
│      ╲  planned"      ╱          │
│       ╰──────────────╯           │
│                                   │
│  ┌─────────┐┌─────────┐┌───────┐│ ← expandable pills
│  │Freshness││Load     ││Moment-││
│  │  +4     ││Safety:  ││ um ↗  ││
│  │         ││ Safe    ││       ││
│  └─────────┘└─────────┘└───────┘│
│  ┌─────────┐                     │
│  │Recovery │ ← greyed if no watch│
│  │  78     │   "Connect watch"   │
│  └─────────┘                     │
└───────────────────────────────────┘
```

---

## Stats Page — Horizontal Sub-Bars

All metrics as **horizontal bars with position markers** (Garmin endurance score style), not isolated ring gauges:

### 1. Running Fitness (CTL)
- Horizontal bar: Beginner → Recreational → Trained → Competitive → Elite
- Marker at current value: `142` + "Trained"

### 2. Short-Term Training Load (ATL)
- Bar zones: Low <60 → Moderate 60–100 → High 100–150 → Very High >150
- Marker: `89` + "Moderate"

### 3. Freshness (TSB)
- Bar: Overtrained → Fatigued → Recovering → Fresh → Peaked
- Marker: `+4` + "Fresh"

### 4. VDOT
- Bar: Beginner → Recreational → Trained → Competitive → Elite
- Marker: `48.2` + "Equivalent to ~3:28 marathon"

### 5. Load Safety (ACWR)
- Bar: Safe ≤1.3 → Moderate Risk 1.3–1.5 → High Risk >1.5
- Marker: `1.12×` + "Safe"

"Dig Deeper" + "Advanced" → merged into single **"Your Numbers"** section.

---

## Terminology Bible

All views must use these exact words:

| Metric | Zone 1 | Zone 2 | Zone 3 | Zone 4 |
|---|---|---|---|---|
| **Readiness** | Ready to Push | On Track | Manage Load | Ease Back |
| **Load Safety** | Safe | Moderate Risk | High Risk | — |
| **Short-Term Load** | Low | Moderate | High | Very High |
| **Freshness** | Peaked / Fresh | Recovering | Fatigued | Overtrained |

---

## Implementation Files

| File | Change |
|---|---|
| `src/calculations/readiness.ts` | **[NEW]** `computeReadiness()` — score, label, sentence, drivingSignal |
| `src/calculations/readiness.test.ts` | **[NEW]** Tests for all edge cases |
| `src/ui/home-view.ts` | Replace `buildSignalBars()` with readiness ring. Kill `buildSparkline()`. |
| `src/ui/stats-view.ts` | Horizontal sub-bars for 5 metrics. Merge sections. |
| `src/ui/main-view.ts` | Rename jargon labels in plan view info sheets |
| `src/utils/format.ts` | Add `formatReadinessLabel()` |

### Data dependencies (all ✅ already computed)
- TSB: `computeFitnessModel().tsb`
- ACWR: `computeACWR().ratio`
- CTL momentum: 4-week lookback on fitness model
- Recovery: `physiologyHistory[latest].sleepScore` / `hrvRmssd`
- Carried load: `carriedTSS` → ATL inflation → already in TSB/ACWR
- Strava activity data: `garminActuals` (HR, calories)

---

## Future Builds (parked)

- **Deeper recovery**: body battery trend, stress level, recovery time → enriches Recovery signal
- Race predictions → keep infrastructure
- Activity card zone split → design TBD
- Run safety features → separate spec
- Hyrox / Triathlon modes → future expansion
