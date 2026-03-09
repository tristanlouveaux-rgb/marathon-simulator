# How the Training Model Works

> Plain-English reference for Tristan. Use this to sanity-check when numbers look wrong.
> Last updated: 2026-03-04

---

## 1. VDOT — Your Fitness Score

VDOT is a single number that represents your current running fitness. Higher = faster across all distances. A VDOT of 45 ≈ 4:00 marathon pace. A VDOT of 55 ≈ 3:20 marathon pace.

### What it's made of

```
Current VDOT = s.v  +  wkGain  +  rpeAdj  +  physioAdj
```

| Component | What it is | Can it go negative? |
|---|---|---|
| `s.v` | Your starting VDOT, set at plan creation | No — fixed forever |
| `wkGain` | Points earned by completing weeks | No — clamped to 0+ |
| `rpeAdj` | Adjustments from rating runs hard/easy | Yes |
| `physioAdj` | Correction from measured LT or efficiency data | Yes (capped at −5.0) |

### What moves each component

**wkGain** accumulates as you advance weeks. Each week contributes `perWeekGain × adherence`. Adherence = completed runs ÷ planned runs per week. Missing runs = less gain that week, but never negative.

**rpeAdj** adjusts when you rate a run harder or easier than the planned effort. Rate a run 2 RPE points harder than expected → small negative adjustment (−0.03 to −0.15 VDOT). Rate it easier → small positive. Each week is capped at ±0.3 VDOT. Only run workouts affect this — gym, cross-training, and rest have no effect.

**physioAdj** is the problematic one. It fires from three sources:
1. Threshold run analysis — when a GPS threshold run is rated and the work segment meets criteria (≥15 min, HR in Z4), the measured LT pace is converted to a VDOT-equivalent and physioAdj closes the gap between that and the current model prediction.
2. **Cardiac Efficiency Trend** — fires automatically every time you advance a week (if ≥3 easy/long run data points exist). Computes a running efficiency score from pace:HR ratio. ⚠️ Currently buggy — see Section 6.
3. Benchmark check-ins — manual performance tests.

### When VDOT looks wrong

- **Dropped suddenly?** → physioAdj went negative. Most likely the Cardiac Efficiency Trend misfired. Use "Reset VDOT calibration" in Account → Advanced to set physioAdj = 0.
- **Not rising despite good training?** → wkGain may be limited by adherence (missed runs), or physioAdj is cancelling out the gains.
- **Way too high?** → Starting VDOT `s.v` may have been set too optimistically at plan creation.

---

## 2. Training Load — Three Signals

The app tracks load three ways. **Do not conflate them.** Each answers a different question.

### Signal A — Running-equivalent load (run fitness)

> "How much did this build your running?"

Computed as iTRIMP × runSpec multiplier. See Section 3 for iTRIMP. runSpec discounts non-running activities:

| Activity | runSpec | Meaning |
|---|---|---|
| Running | 1.0 | Full credit |
| Backcountry skiing | 0.75 | 75% credit |
| Cycling / Mountain biking | 0.55 | 55% credit |
| Walking | 0.40 | 40% credit |
| HIIT / Boxing / heavy load sports | 0.30 | 30% credit |
| Swimming | 0.20 | 20% credit |

Used for: CTL (running fitness), race time prediction, replace/reduce decisions.

### Signal B — Total physiological load (what your body experienced)

> "How hard was your body working across everything?"

Same iTRIMP but **no runSpec discount**. A Hyrox session at 300 iTRIMP counts as 300, not 90.

Used for: ACWR (injury risk), the main 8-week chart, "This Week" card, fatigue tracking.

### Signal C — Impact load (injury risk, day-to-day)

> "How much pounding did your legs take?"

Tracks mechanical stress — running and high-impact activities only. Does not count cycling or swimming. Used internally for day-before injury risk warnings. Not yet fully surfaced in the UI.

---

## 3. iTRIMP — How Each Session's Load is Calculated

iTRIMP (impulse-training) is the raw physiological load of a single session. It's computed from HR data when available (Garmin/Strava sync), or estimated from duration + RPE when not.

**With HR data:**
```
iTRIMP = duration_min × avg_HR × HR_zone_multiplier
```
Zone multipliers increase non-linearly — Z4/Z5 effort counts for much more than Z1/Z2.

**Without HR data (RPE estimate):**
```
estimated_TSS = duration_min × intensity_factor
```
Where intensity comes from the activity type (running estimated from VDOT-derived pace, gym from a fixed moderate-intensity assumption).

**equivTSS** (what you see on charts) = `(iTRIMP × 100) / 15000 × runSpec`

The constant 15000 normalises to a 0–100+ weekly scale where a typical easy running week ≈ 50–80 TSS and a hard week ≈ 100–150 TSS.

---

## 4. CTL and ATL — Fitness and Fatigue

### CTL (Chronic Training Load) = Fitness

A 42-day exponential moving average of your weekly Signal A (run-equivalent TSS).

```
CTL_new = CTL_old × decay + weekTSS × (1 − decay)
decay = e^(−7/42) ≈ 0.846
```

In plain terms: last week's training counts for ~85% as much as this week's. Training from 6 weeks ago barely registers. CTL responds slowly — it takes months to build meaningfully.

**CTL tiers (weekly TSS units):**
- Building: 0–30
- Foundation: 30–60
- Trained: 60–90
- Performance: 90–120
- Elite: 120+

These tiers match PRINCIPLES.md D3 (canonical source).

### ATL (Acute Training Load) = Fatigue

A 7-day exponential moving average of weekly Signal B (total physiological TSS, no runSpec discount).

ATL responds fast — a big week immediately spikes ATL. It drops within 1–2 weeks of rest.

### TSB (Training Stress Balance) = Form

```
TSB = CTL − ATL
```

Positive TSB = fresh (more fitness than fatigue). Negative TSB = fatigued. Near race day, you want TSB to be positive — this is what tapering achieves.

---

## 5. ACWR — Injury Risk

ACWR (Acute:Chronic Workload Ratio) compares recent load to baseline load.

```
ACWR = ATL (this week, Signal B) ÷ CTL (42-day average, Signal A)
```

Note the deliberate asymmetry: **ATL uses Signal B** (total load, gym counts) and **CTL uses Signal A** (run-equivalent). This means a heavy gym week spikes the numerator without affecting the denominator — correctly flagging elevated injury risk even if running volume was low.

**Risk zones by athlete tier:**

| Status | ACWR range | Meaning |
|---|---|---|
| Safe | 0.8–1.3 | Normal training range |
| Caution | 1.3–1.5 | Load spike — monitor |
| High | > 1.5 | Overreach — consider reducing |
| Low | < 0.8 | Undertraining or deload week |

The safe upper ceiling adjusts by athlete tier — a high-volume athlete can tolerate a higher ACWR than a beginner before injury risk rises.

---

## 6. Known Issues in the Model

### ⚠️ Cardiac Efficiency Trend — currently unreliable

**What it should do**: Detect changes in running economy by tracking your pace:HR ratio over time. If you run the same pace but your HR is rising week-on-week, fitness is declining. If HR is falling, fitness is improving.

**What it currently does wrong**: It may read "slower pace on an easy run" as "declining efficiency" without correctly normalising for HR. An easy run at 6:00/km at 130bpm is *better* efficiency than 5:30/km at 140bpm — but the algorithm may not correctly identify this. The result: a chill recovery week can mistakenly drag physioAdj negative and drop VDOT by 1–3 points.

**Current mitigation**: physioAdj is now capped at −5.0, and a reset button exists in Account → Advanced.

**Proper fix (ISSUE-48)**: Rewrite the estimator to use pace:HR ratio explicitly, require statistical significance, and only use Z2 HR data points. Later: use detailed HR stream data for per-kilometre efficiency analysis.

### ⚠️ No run rating prompt

rpeAdj adjustments only apply when a run is rated. Currently there is no automatic prompt after completing a run, so rpeAdj is effectively frozen for most users. This means VDOT is not getting the feedback signal it was designed for. (ISSUE-34 — planned feature: force RPE capture after runs.)

---

## 7. How It All Connects

```
Session completed
      ↓
HR data (Garmin/Strava) or RPE estimate
      ↓
iTRIMP calculated
      ↓
Signal A (× runSpec)          Signal B (raw)
      ↓                               ↓
Weekly CTL (42d avg)          Weekly ATL (7d avg)
      ↓                               ↓
VDOT (CTL shapes wkGain)      ACWR = ATL ÷ CTL
      ↓                               ↓
Race time prediction           Injury risk + reduce/replace trigger
```

The key tension: Signal A and Signal B diverge whenever you do significant cross-training. A week of heavy gym + little running looks "light" to Signal A (low CTL impact, VDOT barely moves) but "heavy" to Signal B (high ATL, ACWR spikes). This is correct — your running fitness didn't build much, but your body was under real physiological stress.

---

## 8. Quick Reference — "Why does X look wrong?"

| Symptom | Most likely cause | Check |
|---|---|---|
| VDOT dropped | physioAdj went negative | Account → Reset VDOT calibration |
| VDOT not rising | Low adherence (missed runs) | Check session completion rate |
| ACWR red despite easy week | Heavy gym/cross-training (Signal B) | Expected — gym counts at full weight |
| Chart shows 0 for today | Session was RPE-logged (non-Garmin) | Fixed in v2 — should now appear |
| CTL looks too high | Weekly TSS units, not daily — 182 is correct for your volume | See tier table above |
| -74% on Tuesday | Partial week vs full baseline | Fixed — now prorated by day of week |
