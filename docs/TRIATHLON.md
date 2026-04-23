# Triathlon Mode: Architecture and Implementation Plan

> Extending Mosaic from a marathon training simulator to support 70.3 (Half Ironman) and Ironman triathlon plans.

**Status**: Planning (not yet implemented)
**Target distances**: 70.3 (1.9km swim / 90km bike / 21.1km run), Ironman (3.8km swim / 180km bike / 42.2km run)
**Design principle**: Same adaptive engine, same UX patterns, three disciplines instead of one.

### Evidence Base

This document integrates findings from triathlon physiology (Millet & Vleck, 2000; Bentley et al., 2007), bike-to-run transition science (Hue et al., 1998; Hausswirth & Lehenaff, 2001; Bernard et al., 2003), concurrent training interference (Wilson et al., 2012; Beattie et al., 2023; Piacentini et al., 2013), training intensity distribution (Seiler & Kjerland, 2006; Stoggl & Sperlich, 2014), load quantification (Allen & Coggan, 2010; Coggan, 2003; Banister et al., 1975), and tapering (Bosquet et al., 2007; Mujika, 2009). Full bibliography in Appendix E. Confidence levels are annotated per section: **Strong** (well-established, multiple independent sources), **Moderate** (coaching consensus or limited controlled studies), **Emerging** (physiologically plausible, validation pending).

---

## Table of Contents

1. [Race Profiles](#1-race-profiles)
2. [Training Methodology](#2-training-methodology)
3. [Metrics and Load Model](#3-metrics-and-load-model)
4. [Architecture: What Changes, What Stays](#4-architecture-what-changes-what-stays)
5. [State Schema Changes](#5-state-schema-changes)
6. [New Types](#6-new-types)
7. [Plan Engine: Triathlon Generation](#7-plan-engine-triathlon-generation)
8. [Scheduler: Multi-Sport Week Layout](#8-scheduler-multi-sport-week-layout)
9. [Workout Library: Swim and Bike](#9-workout-library-swim-and-bike)
10. [Fitness Model: Per-Discipline Tracking](#10-fitness-model-per-discipline-tracking)
11. [Activity Sync and Matching](#11-activity-sync-and-matching)
12. [Wizard / Onboarding](#12-wizard--onboarding)
13. [UI Changes](#13-ui-changes)
14. [Strava/Garmin Data Availability](#14-stravagramin-data-availability)
15. [Rollout Plan](#15-rollout-plan)
16. [Open Questions](#16-open-questions)

---

## 1. Race Profiles

### Distances

| Race | Swim | Bike | Run |
|------|------|------|-----|
| **70.3** | 1.9 km | 90 km | 21.1 km (half marathon) |
| **Ironman** | 3.8 km | 180.2 km | 42.2 km (marathon) |

### Typical Finish Times

**70.3:**

| Level | Finish Time |
|-------|-------------|
| Elite/Pro | 3:30 to 4:00 |
| Strong age-grouper | sub-4:30 |
| Intermediate (male 35-39 avg) | ~5:30 |
| Intermediate (female 35-39 avg) | ~6:20 |
| Beginner / first-timer | 6:00 to 8:00 |
| **Cutoff** | **8:30** |

**Ironman:**

| Level | Finish Time |
|-------|-------------|
| Elite/Pro male | 8:00 to 9:00 |
| Strong age-grouper | 9:00 to 10:30 |
| Experienced age-grouper | 10:30 to 12:00 |
| Average all finishers (male) | ~12:38 |
| Beginner | 13:00 to 15:00 |
| **Cutoff** | **17:00** |

### Segment Cutoffs

- **70.3**: Swim 1:10, Swim+Bike 5:30, Overall 8:30
- **Ironman**: Swim 2:20, Swim+Bike 10:30, Overall 17:00

---

## 2. Training Methodology

> **Evidence summary:** Triathlon performance is primarily determined by VO2max, economy in each discipline, and lactate threshold (Millet & Vleck, 2000; Bentley et al., 2007). Training multiple endurance disciplines concurrently produces minimal interference on aerobic development when total volume is managed appropriately (Millet et al., 2002; Piacentini et al., 2013). The 80/20 intensity distribution (80% below LT1, 20% at or above LT2) is well-supported for endurance performance across all three disciplines independently (Seiler & Kjerland, 2006; Stoggl & Sperlich, 2014). Block periodization with emphasis cycling has demonstrated effectiveness in trained endurance athletes (Molmen et al., 2019; Ronnestad et al., 2014).

### 2.1 Periodisation

Triathlon uses the same macro phases as marathon training:

| Phase | 70.3 Duration | Ironman Duration | Focus |
|-------|---------------|------------------|-------|
| **Base** | 6 to 10 weeks | 8 to 12 weeks | Aerobic foundation across all 3 disciplines. Swim technique. Low intensity. Strength training 2x/week. |
| **Build** | 5 to 8 weeks | 6 to 10 weeks | Race-specific intensity introduced. Brick workouts weekly. Tempo/threshold sessions increase. Ironman: nutrition rehearsal starts. |
| **Peak** | 3 to 6 weeks | 4 to 6 weeks | Longest endurance sessions. Peak weekly hours. Race simulations. |
| **Taper** | 7 to 10 days | 2 to 3 weeks | Volume drops 40 to 60%. Intensity maintained. Race-pace touches every 72h (Bosquet et al., 2007; Mujika, 2009). |

**Total plan lengths:**
- 70.3: 16 to 24 weeks (20 typical)
- Ironman: 24 to 36 weeks (24 typical, 6 to 12 months for first-timers)

**Recovery weeks:** Every 3rd or 4th week within each phase. Volume reduction of 30 to 40%. Adaptation occurs during recovery from a training block, not during the block itself (Mujika, 2009).

**Confidence:** Strong for taper volume/intensity prescription (Bosquet et al., 2007 meta-analysis). Moderate for specific phase durations by distance (coaching consensus, limited controlled triathlon periodization studies).

### 2.2 Weekly Structure

**Sessions per discipline per week:**

| Level | Swim | Bike | Run | Strength | Total |
|-------|------|------|-----|----------|-------|
| Beginner | 2 | 2 | 2 to 3 | 1 | 8 to 9 |
| Intermediate | 2 to 3 | 2 to 3 | 3 | 1 | 9 to 11 |
| Advanced | 3 | 3 | 3 | 1 | 10 to 12 |

**Typical week layout (intermediate 70.3 build phase):**

| Day | AM | PM |
|-----|----|----|
| Mon | REST | -- |
| Tue | Swim (threshold) | Run (tempo/intervals) |
| Wed | Bike (intervals or sweet spot) | Strength |
| Thu | Swim (endurance) | Run (key session) |
| Fri | REST or technique swim | -- |
| Sat | Long Bike (2.5 to 4h, often with brick run) | -- |
| Sun | Long Run | -- |

### 2.3 Volume Distribution

Training time splits across disciplines:

| Discipline | % of Total Hours | Rationale |
|------------|------------------|-----------|
| Swim | 15 to 20% | Short race segment, technique-heavy. Swimming economy is more trainable and variable than running/cycling economy; technique improvements yield disproportionate time gains for non-swimmers (Toussaint & Beek, 1992). |
| Bike | 45 to 50% | Longest segment (50 to 55% of race time), lowest injury risk per hour, highest aerobic return per training hour (Bentley et al., 2007). |
| Run | 30 to 35% | Highest injury risk (Vleck & Garbutt, 1998), but most performance-sensitive. Run volume deliberately lower than standalone marathon training because cycling provides significant aerobic crossover (Millet et al., 2002). |

**Confidence:** Strong for cycling as primary volume driver and swim as smallest fraction (coaching consensus validated by race-time proportional analysis; Bentley et al., 2007). Moderate for precise percentage ranges (vary by coach and athlete).

### 2.4 Weekly Hours by Level

| Distance | Beginner | Intermediate | Advanced |
|----------|----------|-------------|----------|
| **70.3** | 6 to 9h (start), 10 to 12h (peak) | 8 to 12h, peak 12 to 14h | 12 to 16h |
| **Ironman** | 10 to 12h, peak 14 to 16h | 12 to 16h, peak 16 to 18h | 14 to 20h+ |

### 2.5 Volume Progression

- Base: start at 60 to 70% of target peak volume
- Build: progress to 80 to 90% of peak
- Peak: 100% of peak volume (2 to 3 biggest weeks)
- Taper (70.3): single-week 40 to 50% reduction
- Taper (Ironman): 75% -> 50% -> 25% over 3 weeks

**Weekly increase limit:** 5 to 10% per discipline per week.

### 2.6 Brick Workouts

> **Evidence summary:** Running performance is acutely impaired following cycling due to altered neuromuscular recruitment, glycogen depletion, cardiovascular drift, and biomechanical changes (Hue et al., 1998; Hausswirth & Lehenaff, 2001). Stride length is typically reduced and cadence increased in the first 5 to 15 minutes of the run-off-bike (Bernard et al., 2003). The magnitude of impairment is 4 to 6% for 70.3 and 10 to 12% for Ironman relative to standalone running (Bentley et al., 2007; Landers et al., 2008). Athletes who regularly perform brick sessions exhibit smaller bike-to-run performance decrements (Etxebarria et al., 2014; Suriano & Bishop, 2010).

A brick is training in one discipline immediately followed by another with no rest. Almost always bike-to-run.

**Frequency:** Weekly in build/peak phases. Every 1 to 2 weeks in base.

**Progression by phase:**

| Phase | Brick Format |
|-------|-------------|
| Base | 45 to 60 min bike + 15 to 20 min easy run |
| Build | 90 to 120 min bike + 30 to 45 min run at race effort |
| Peak | 3 to 5h bike + 45 to 90 min run simulating race conditions |

**Scheduling:** Usually Saturday (long bike + transition run). The run is shorter than a standalone long run.

**Confidence:** Strong for bike-to-run impairment existence and trainability (Hue et al., 1998; Etxebarria et al., 2014). Moderate for specific dosing protocols (coaching practice; limited dose-response studies).

*Translation to Mosaic logic: bricks are single Workout objects with a segments array (bike + run). Apply a fatigue-discount factor to run-off-bike predictions. Track brick frequency as a training quality metric. Progress one variable at a time (duration, then intensity, then run intensity).*

### 2.7 Key Scheduling Rules

- Never schedule back-to-back quality sessions in the same discipline
- Hard swim does not cause the same orthopedic stress as hard run. Swim can be paired more freely (Wanivenhaus et al., 2012).
- When two sessions share a day, swim before run is preferred because swimming imposes minimal lower-limb fatigue, preserving run quality (Cadore et al., 2012; Schumann et al., 2014).
- Hard bike followed by quality run next day should be avoided: cycling-induced quad fatigue degrades running mechanics (Suriano & Bishop, 2010).
- Long bike is the primary volume driver each week
- The 80/20 rule: 80% of training at low intensity (Zone 1 to 2), 20% at moderate to high. This polarised distribution produced superior endurance adaptations compared to threshold-heavy or pyramidal distributions in a controlled trial (Stoggl & Sperlich, 2014; Seiler & Kjerland, 2006). Applies within each discipline independently, not across total volume (Munoz et al., 2014).
- Run volume is deliberately lower than standalone marathon training (25 to 35% of total, not 100%). Cycling provides significant aerobic crossover: cycling training improves running VO2max (though not running economy), and vice versa (Millet et al., 2002).

**Confidence:** Strong for 80/20 intensity distribution (Seiler & Kjerland, 2006; Stoggl & Sperlich, 2014). Strong for cycling-running aerobic crossover (Millet et al., 2002). Moderate for session ordering preferences (most evidence from laboratory settings; Cadore et al., 2012).

*Translation to Mosaic logic: implement session ordering preferences in the scheduler. Enforce 80/20 distribution per discipline. Use cross-transfer coefficients to inform replacement decisions (bike can partially substitute for running aerobic development; swim cannot).*

### 2.8 Intensity Focus by Distance

- **70.3**: More threshold and VO2max work. Race effort is Zone 2 to low Zone 3. Target bike IF approximately 0.80 to 0.85 (Allen & Coggan, 2010).
- **Ironman**: More tempo and steady state. Race effort is low Zone 2. Target bike IF approximately 0.70 to 0.75 (Laursen et al., 2005). Nutrition as a "fourth discipline."

---

## 3. Metrics and Load Model

> **Evidence summary:** The Training Stress Score (TSS) framework normalises load across disciplines so that 100 TSS = one hour at threshold intensity in any sport (Coggan, 2003; Allen & Coggan, 2010). The impulse-response fitness/fatigue model (Banister et al., 1975; Busso, 2003) decomposes training adaptation into fitness (CTL, tau=42d) and fatigue (ATL, tau=7d) components. TSB = CTL - ATL. This model is directly applicable to all three triathlon disciplines using discipline-specific TSS inputs. Per-discipline threshold metrics (CSS for swimming, FTP for cycling, threshold pace for running) are each well-validated within their domain (Wakayoshi et al., 1992; Dekerle et al., 2002; Allen & Coggan, 2010; Skiba et al., 2006).

### 3.1 Discipline-Specific Thresholds

Each discipline needs its own threshold metric to anchor zones and calculate TSS:

| Discipline | Threshold Metric | How to Obtain |
|------------|-----------------|---------------|
| **Swim** | CSS (Critical Swim Speed) | 400m + 200m time trial. `CSS (sec/100m) = (T400 - T200) / 2` (Wakayoshi et al., 1992). CSS approximates the pace sustainable for approximately 30 minutes, analogous to FTP in cycling (Dekerle et al., 2002). Or estimate from race 1500m time. Retest every 6 to 8 weeks. |
| **Bike** | FTP (Functional Threshold Power) | 20-min test: FTP = 0.95 * avg 20-min power (Allen & Coggan, 2010). Or estimate from Strava power curve. Also: ramp test (FTP = 0.75 * peak 1-min power). FTP is the most widely used cycling threshold metric with decades of field validation. Retest every 6 to 8 weeks. |
| **Run** | Threshold Pace / VDOT | Already in the app. LTHR and threshold pace from PBs, Garmin, or manual entry. |

**Fallback hierarchy when threshold data is unavailable:**
1. Threshold metric (CSS / FTP / pace) -> proper TSS calculation
2. Heart rate + LTHR -> hrTSS (less accurate for variable efforts)
3. Duration + RPE -> estimated TSS (least accurate, used in current iTRIMP model)

### 3.2 TSS Calculation Per Discipline

**Cycling (with power meter):**
```
NP = Normalized Power (30s rolling average, 4th power, mean, 4th root)
IF = NP / FTP
TSS = (duration_sec * NP * IF) / (FTP * 3600) * 100
```

Strava provides `weighted_average_watts` (= NP) on the DetailedActivity object when power data exists. NP/IF/TSS is the industry standard with extensive validation (Coggan, 2003; Allen & Coggan, 2010). **Confidence:** Strong.

**Cycling (without power):**
```
hrTSS = (duration_min * IF^2) / 60 * 100
IF = avg_HR / LTHR
```

HR-based TSS under-represents variable efforts due to HR lag (Allen & Coggan, 2010). Acceptable for steady rides. Unreliable for intervals. Note: cycling LTHR is typically 5 to 10 bpm lower than running LTHR (Millet & Vleck, 2000). **Confidence:** Moderate.

**Swimming:**
Swimming TSS uses **cubed** intensity factor (water resistance increases with the cube of velocity, so metabolic cost rises faster with pace than in weight-bearing sports; Toussaint & Beek, 1992):
```
NSS = distance_m / duration_min          (Normalized Swim Speed)
FTPswim = 100 / (CSS_sec_per_100m / 60)  (m/min at threshold)
IF = NSS / FTPswim
sTSS = IF^3 * (duration_min / 60) * 100
```

**Confidence:** Moderate. The cubed model is physiologically grounded but less empirically validated than cycling TSS. CSS validity is strong in competitive swimmers (Dekerle et al., 2002), moderate in adult-onset swimmers with poor technique (pace may not reflect aerobic threshold due to high drag coefficient).

**Running:**
Already implemented via iTRIMP. With proper threshold data (Skiba et al., 2006):
```
NGP = Normalized Graded Pace (accounts for elevation)
IF = FTPace / NGP  (note: inverted because faster = higher intensity)
rTSS = (duration_sec * IF^2) / 3600 * 100
```

### 3.3 TSS Comparability Across Disciplines

All TSS variants are calibrated so that **100 TSS = 1 hour at threshold in that discipline**. This means:

- 60 min swim at CSS = 100 sTSS
- 60 min bike at FTP = 100 bTSS
- 60 min run at threshold = 100 rTSS

They are directly addable. A day with 50 sTSS + 80 bTSS + 40 rTSS = 170 total TSS (Coggan, 2003).

*Translation to Mosaic logic: implement discipline-specific TSS calculations using threshold metrics. When threshold data is unavailable, fall back to iTRIMP (current system). Store per-discipline TSS alongside combined totals.*

### 3.4 Combined vs Per-Discipline CTL/ATL/TSB

> **Model background:** The Banister impulse-response model (Banister et al., 1975; Busso, 2003) decomposes training adaptation into a positive (fitness/CTL) and negative (fatigue/ATL) component, each decaying exponentially. Standard time constants: tau_CTL = 42 days, tau_ATL = 7 days (Coggan, 2003). TSB = CTL - ATL represents "form" or readiness. This is the most widely used training load framework in endurance sport.

**Combined (single number):** Sum all TSS into one daily total, feed into existing 42-day/7-day EMA. This is what TrainingPeaks does. Useful for overall freshness and load monitoring.

**Per-discipline:** Track swim/bike/run CTL separately. Essential for adaptive plan generation ("your swim fitness is lagging, let's add a threshold swim session").

**Recommendation:** Both. The combined CTL feeds freshness/readiness. Per-discipline CTL feeds the plan engine. The existing fitness model math is identical for both cases, just applied separately.

**Per-discipline ACWR:** Compute ACWR per discipline (swimATL/swimCTL, bikeATL/bikeCTL, runATL/runCTL) to detect discipline-specific load spikes independently from overall load management (Gabbett, 2016). Note: ACWR as an absolute injury predictor is debated (Zouhal et al., 2021). Use primarily as a load-spike detector, not a threshold.

**Confidence:** Strong for the impulse-response model (Busso, 2003; Allen & Coggan, 2010). Moderate for applying identical time constants (42/7) across all three disciplines; swimming fatigue may decay faster due to lower musculoskeletal stress. Moderate for ACWR utility (Zouhal et al., 2021).

*Translation to Mosaic logic: extend fitness-model.ts to compute three parallel CTL/ATL/TSB tracks filtered by discipline, alongside the existing combined track. Athlete tier derives from combined CTL (not running-only CTL), correctly classifying high-volume triathletes.*

### 3.5 Zone Systems

Each discipline defines zones relative to its threshold:

**Swimming (CSS-based pace zones):**

| Zone | Pace vs CSS | Intent |
|------|-------------|--------|
| Z1 | CSS + 15 to 20s/100m | Recovery |
| Z2 | CSS + 8 to 12s/100m | Aerobic endurance |
| Z3 | CSS +/- 5s/100m | Threshold (race pace for 1500m) |
| Z4 | CSS - 5 to 10s/100m | VO2max |
| Z5 | CSS - 10s+/100m | Sprint/neuromuscular |

**Cycling (Coggan power zones, % FTP; Coggan, 2003; Allen & Coggan, 2010):**

| Zone | % FTP | Name |
|------|-------|------|
| Z1 | < 55% | Active Recovery |
| Z2 | 56 to 75% | Endurance |
| Z3 | 76 to 90% | Tempo |
| Z4 | 91 to 105% | Lactate Threshold |
| Z5 | 106 to 120% | VO2max |
| Z6 | > 120% | Anaerobic / Neuromuscular |

If no power meter, use HR zones anchored to cycling LTHR (typically 5 to 10 bpm lower than running LTHR; Millet & Vleck, 2000). Swimming max HR is approximately 10 to 15 bpm lower than running max HR due to supine position and cooling effect of water (Millet & Vleck, 2000).

**Running:** Already implemented. 5-zone system anchored to threshold pace and LTHR.

**Confidence:** Strong for Coggan cycling power zones (industry standard). Moderate for CSS-based swim zones (validated in competitive swimmers; less well-calibrated for recreational adult-onset swimmers). Strong for cross-discipline HR offsets.

### 3.6 Mapping to Existing Load Model

The current app uses a three-signal model:

| Signal | Current Use | Triathlon Adaptation |
|--------|-------------|---------------------|
| **Signal A** (run-equiv, runSpec-discounted) | Running Fitness CTL, race prediction | Becomes **per-discipline fitness**. No runSpec discount within a discipline. |
| **Signal B** (raw physiological, no discount) | ACWR, Total Load, Freshness | **Unchanged**. All TSS adds at full value regardless of discipline. Total physiological stress. |
| **Signal C** (impact load) | Injury risk | **Per-discipline impact**. Running impact >> cycling impact >> swimming impact. |

**Key insight:** For triathlon mode, Signal A splits into three parallel signals (swimCTL, bikeCTL, runCTL). Signal B stays unified. Signal C becomes a weighted combination where running carries most impact risk (Vleck & Garbutt, 1998).

> **Cross-discipline transfer evidence:** Cycling and running share significant aerobic crossover. Cycling training improves running VO2max (though not running economy), and vice versa (Millet et al., 2002). Swimming has minimal aerobic transfer to land-based sports due to different muscle group dominance and body position (Millet & Vleck, 2000). This supports treating swim/bike/run as partially independent fitness signals while sharing a common fatigue pool.

**Cross-discipline transfer coefficients (aerobic load transfer only):**
- Bike replacing run: 0.75 (strong aerobic crossover, no running economy benefit; Millet et al., 2002)
- Run replacing bike: 0.70 (aerobic crossover; no cycling-specific neuromuscular adaptation)
- Swim replacing run or bike: 0.30 (minimal aerobic crossover; Millet & Vleck, 2000)
- Bike or run replacing swim: 0.25 (no upper-body or technique transfer)

**Confidence:** Strong for cycling-running crossover (Millet et al., 2002). Strong for minimal swim-run crossover (Millet & Vleck, 2000). Moderate for specific coefficient values (derived from crossover evidence; not from direct substitution studies).

*Translation to Mosaic logic: implement a discipline-aware replacement matrix. Cross-discipline substitutions apply transfer penalties. Within-discipline substitutions follow existing DOWNGRADE logic.*

---

## 4. Architecture: What Changes, What Stays

### 4.1 Fully Reusable (No Changes)

| System | Why It Works |
|--------|-------------|
| **Recovery engine** | Sleep/HRV/readiness scoring is physiology-agnostic |
| **Injury system** | Six-phase progression works for any sport (would need sport-specific protocols later) |
| **Gym integration** | Phase-aware strength templates apply equally |
| **State management** | updateState/saveState/loadState pattern scales |
| **GPS tracking** | Already tracks any movement. Split scheme would need swim/bike variants eventually. |
| **Activity sync pipeline** | Already handles swim/bike/run from Strava. `GarminPendingItem` has `activityType`. |
| **Cross-training engine** | Still useful for activities outside the 3 disciplines (yoga, hiking, etc.) |
| **Excess load card** | Unchanged concept. Unspent load still handled the same way. |
| **Physiology sync** | Garmin/Apple biometrics (HRV, sleep, resting HR) are sport-agnostic |

### 4.2 Needs Refactoring

| System | Current State | What Changes | Effort |
|--------|--------------|-------------|--------|
| **Plan engine** (`plan_engine.ts`) | Generates running sessions only. Uses VDOT + phase to select workout types. | Needs parallel generation for swim/bike/run. Phase logic reusable but session selection is per-discipline. | HIGH |
| **Scheduler** (`scheduler.ts`) | Long run -> Sunday, quality -> Tue/Thu, easy fills gaps. | Needs multi-sport constraint solver. Brick support. No same-discipline quality back-to-back. | HIGH |
| **Workout generation** (`intent_to_workout.ts`, `generator.ts`) | Running workouts only. Descriptions in distance/pace format. | New swim workout builder (sets/intervals per 100m), new bike workout builder (duration/power). | HIGH |
| **Fitness model** (`fitness-model.ts`) | Single CTL/ATL/TSB track. | Add per-discipline tracks alongside combined. | MEDIUM |
| **Load calculation** (`load.ts`) | Parses running descriptions for duration. | Add swim/bike parsers. Different load profiles per discipline. | MEDIUM |
| **VDOT / race prediction** | VDOT from running PBs only. Predicts single race distance. | Need swim CSS and bike FTP as parallel fitness metrics. Race prediction becomes per-segment. | MEDIUM |
| **Wizard / onboarding** | Single-sport: race distance, PBs, runs/week. | Fork: detect mode early, then collect per-discipline data (swim ability, bike FTP, running PBs). | MEDIUM |
| **UI: Home/Plan views** | Running workout cards. Single-discipline week view. | Multi-sport day groupings. Swim/bike/run visual distinction. Brick workout cards. | MEDIUM |
| **Types** (`state.ts`, `training.ts`) | `RaceDistance` = '5k' through 'marathon'. `Workout` is running-centric. | Add `EventType`, `TriathlonDistance`, per-discipline thresholds, discipline field on Workout. | MEDIUM |
| **Constants** (`training-params.ts`, `workouts.ts`) | Running-specific phase multipliers, workout importance tables. | Per-discipline constants. Swim/bike workout templates. | MEDIUM |
| **Activity matcher** | Matches by day + distance + type. Run-focused scoring. | Add swim/bike matching (match by discipline + duration/distance). | LOW |

### 4.3 Risk Assessment

**Highest risk:** Plan engine and scheduler. These are the core of the adaptive system and currently assume a single discipline. The refactor needs to be clean enough that the running-only path is not broken.

**Mitigation:** Branch by `eventType` early. Running-only users never touch the new code paths. Triathlon plan engine is a new module (`plan_engine.triathlon.ts`) that calls into shared utilities where possible.

---

## 5. State Schema Changes

### 5.1 New Top-Level Fields on SimulatorState

```typescript
// Event type — determines which plan engine runs
eventType?: 'running' | 'triathlon';  // undefined = running (backward compat)

// Triathlon-specific config (only present when eventType === 'triathlon')
triConfig?: {
  distance: '70.3' | 'ironman';
  
  // Per-discipline thresholds
  swimCSS?: number;          // sec/100m (Critical Swim Speed)
  bikeFTP?: number;          // watts (Functional Threshold Power)
  bikeLTHR?: number;         // bpm (cycling-specific lactate threshold HR)
  // Running threshold already exists: s.lt, s.pac.t
  
  // Per-discipline volume preferences
  swimSessionsPerWeek: number;   // 2-3
  bikeSessionsPerWeek: number;   // 2-3
  runSessionsPerWeek: number;    // 2-3
  
  // Per-discipline experience
  swimLevel: 'beginner' | 'intermediate' | 'advanced';
  bikeLevel: 'beginner' | 'intermediate' | 'advanced';
  // Running level already derived from VDOT / PBs
  
  // Per-discipline CTL (42-day EMA of discipline-specific TSS)
  swimCTL?: number;
  bikeCTL?: number;
  runCTL?: number;
  
  // Per-discipline ATL (7-day EMA)
  swimATL?: number;
  bikeATL?: number;
  runATL?: number;
  
  // Swim PBs
  swimPBs?: {
    s100?: number;    // 100m time in seconds
    s400?: number;    // 400m time in seconds
    s1500?: number;   // 1500m time in seconds
  };
  
  // Bike metrics
  bikeWeight?: number;      // kg (for power/weight and TSS estimation without power meter)
  hasPowerMeter?: boolean;
  
  // Race target time (optional, for pacing)
  targetTime?: number;       // seconds
  targetSwimTime?: number;
  targetBikeTime?: number;
  targetRunTime?: number;
};
```

### 5.2 Workout Type Extension

```typescript
// Add discipline field to Workout interface
export interface Workout {
  // ... existing fields ...
  discipline?: 'swim' | 'bike' | 'run' | 'brick' | 'strength';
  
  // Brick workout: contains sub-segments
  segments?: Array<{
    discipline: 'swim' | 'bike' | 'run';
    description: string;
    durationMin?: number;
    distanceKm?: number;
  }>;
  
  // Swim-specific
  swimDistanceM?: number;       // total distance in metres
  swimSets?: string;            // e.g. "10x100m @ CSS, 15s rest"
  
  // Bike-specific
  bikeDurationMin?: number;
  bikeTargetPower?: number;     // watts (if FTP known)
  bikeTargetZone?: string;      // e.g. "Z2" or "Sweet Spot"
}
```

### 5.3 RaceDistance / EventType

```typescript
// Extend or add:
export type TriathlonDistance = '70.3' | 'ironman';
export type EventType = 'running' | 'triathlon';
// RaceDistance stays as-is for backward compat
```

### 5.4 Backward Compatibility

- `eventType` defaults to `'running'` when undefined
- All existing state fields remain unchanged
- `triConfig` is only present when `eventType === 'triathlon'`
- Running-only users see zero difference. The plan engine branches on `eventType` at the top.

---

## 6. New Types

### 6.1 Triathlon Workout Types

```typescript
// Swim workout types
type SwimWorkoutType =
  | 'swim_technique'      // drills, form work
  | 'swim_endurance'      // continuous aerobic
  | 'swim_threshold'      // CSS-pace intervals
  | 'swim_speed'          // short sprints
  | 'swim_open_water';    // continuous with sighting

// Bike workout types
type BikeWorkoutType =
  | 'bike_endurance'      // Zone 2 long ride
  | 'bike_tempo'          // 76-90% FTP
  | 'bike_sweet_spot'     // 88-95% FTP
  | 'bike_threshold'      // 95-105% FTP
  | 'bike_vo2'            // 120-130% FTP intervals
  | 'bike_hill';          // hill repeats

// Brick type
type BrickWorkoutType = 'brick';

// Existing run types remain unchanged
```

### 6.2 Session Intent (Triathlon)

```typescript
interface TriathlonSessionIntent {
  discipline: 'swim' | 'bike' | 'run' | 'brick' | 'strength';
  type: string;                   // swim_threshold, bike_endurance, etc.
  targetDurationMin?: number;
  targetDistanceKm?: number;      // for swim, in km (converted from metres for display)
  targetDistanceM?: number;       // swim distance in metres
  targetTSS?: number;
  intensity: 'low' | 'moderate' | 'hard';
  dayPreference?: number;         // preferred day of week
  isKeySession?: boolean;         // protects from reduction
  brickRunDurationMin?: number;   // for brick: the run-off-bike duration
}
```

---

## 7. Plan Engine: Triathlon Generation

### 7.1 Architecture

The triathlon plan engine generates workouts for all 3 disciplines in a coordinated way. It does **not** replace the running plan engine. Instead:

```
eventType === 'running'   → plan_engine.ts (existing, unchanged)
eventType === 'triathlon'  → plan_engine.triathlon.ts (new)
```

### 7.2 Generation Flow

```
generateTriathlonWeek(phase, weekIndex, totalWeeks, triConfig, fitnessModel)
  1. Determine target weekly hours for this phase + week
  2. Distribute hours across swim/bike/run (using volume split rules)
  3. Generate swim session intents (2-3 per week)
  4. Generate bike session intents (2-3 per week)
  5. Generate run session intents (2-3 per week)
  6. Generate brick intent (if build/peak phase and this isn't a recovery week)
  7. Generate strength intent (1 per week, 0 in taper)
  8. Pass all intents to triathlon scheduler
  9. Convert intents to Workout objects with descriptions
  10. Calculate load for each workout
  11. Return Workout[]
```

### 7.3 Session Selection by Phase

**Base phase:**
- Swim: 1 technique + 1 endurance (beginner: shorter sets, more drill). Add 1 threshold from week 4+.
- Bike: 1 endurance (long) + 1 tempo or endurance (shorter). Strength 2x.
- Run: 1 easy + 1 easy/steady + optional 1 easy (if 3 runs/week)
- Brick: 1x every 2 weeks (short: 45 min bike + 15 min run)

**Build phase:**
- Swim: 1 threshold (CSS intervals) + 1 endurance + optional 1 speed
- Bike: 1 endurance (long) + 1 sweet spot or threshold + optional 1 tempo
- Run: 1 easy + 1 quality (tempo/threshold) + optional 1 easy
- Brick: 1x weekly (90 min bike + 30 to 45 min run)

**Peak phase:**
- Swim: 1 threshold + 1 endurance (peak distance) + optional 1 race-pace
- Bike: 1 long ride (peak distance) + 1 threshold + optional 1 tempo
- Run: 1 long run (peak distance) + 1 quality + optional 1 easy
- Brick: 1x weekly (peak: 3 to 5h bike + 45 to 90 min run)

**Taper:**
- All disciplines: reduce volume 40 to 60% (70.3) or 20%/week (Ironman)
- Maintain 1 race-pace session per discipline every 72h
- Drop brick runs to 15 to 20 min
- Drop strength to activation only

### 7.4 Weekly Hours Calculation

```
baseHours = lookup(distance, level)  // from table in section 2.4
phaseMultiplier = {
  base: 0.65 to 0.85 (progressive within base),
  build: 0.85 to 0.95,
  peak: 1.0,
  taper: 0.50 to 0.75 (regressive)
}
recoveryWeekMultiplier = isRecoveryWeek ? 0.65 : 1.0
weeklyHours = baseHours * phaseMultiplier * recoveryWeekMultiplier
```

### 7.5 Adaptive Adjustments

The same adaptive mechanisms apply:

- **Readiness/recovery:** Orange/red recovery status -> reduce volume or drop quality sessions (same as running mode)
- **ACWR:** Per-discipline ACWR. If run ACWR > 1.3, reduce run volume first.
- **RPE feedback:** If rated efforts consistently high, reduce next week's volume. If low, allow progression.
- **Skip handling:** Same push-to-next-week logic. A skipped swim threshold gets pushed, not converted to a bike session.

---

## 8. Scheduler: Multi-Sport Week Layout

### 8.1 Constraint Rules

Hard constraints (must satisfy):
1. At least 1 rest day per week
2. No two quality sessions in the same discipline on consecutive days
3. Brick sessions on Saturday (or user-configured long day)
4. Long bike and long run not on the same day (unless brick)
5. No quality run the day after a long bike (legs are fatigued)

Soft constraints (prefer but can violate):
1. Swim before run on two-a-day days (lower fatigue interference)
2. Strength on a non-quality-run day
3. Space key sessions at least 48h apart within each discipline
4. Easy/recovery sessions adjacent to quality sessions

### 8.2 Default Template (3 swim / 3 bike / 3 run)

```
Mon: REST
Tue: Swim (quality) + Run (quality)
Wed: Bike (quality) + Strength
Thu: Swim (endurance) + Run (easy)
Fri: Swim (technique) or REST
Sat: Long Bike (+ brick run in build/peak)
Sun: Long Run
```

### 8.3 Two-a-Day Handling

Triathlon regularly schedules two sessions per day. The current app doesn't model this. Options:

**Option A: Two separate Workout objects on the same day.**
Pro: Simpler. Each workout is independently ratable, matchable, skippable.
Con: UI needs to show grouped days.

**Option B: Single Workout with segments.**
Pro: Reflects how athletes think about their day.
Con: Rating and matching becomes complex.

**Recommendation: Option A.** Two separate workouts sharing the same `dayOfWeek`. The scheduler assigns AM/PM slots. The UI groups them visually. This preserves all existing workout lifecycle logic (rating, matching, skipping, modification).

Add `timeSlot?: 'am' | 'pm'` to Workout for ordering within a day.

### 8.4 Brick Workout Representation

A brick is modelled as a **single Workout** with `discipline: 'brick'` and a `segments` array:

```typescript
{
  t: 'brick',
  n: 'Long Bike + Brick Run',
  discipline: 'brick',
  segments: [
    { discipline: 'bike', description: '3h @ Z2', durationMin: 180 },
    { discipline: 'run', description: '30min @ race effort', durationMin: 30 }
  ],
  d: '3h bike @ Z2, then 30min run @ race effort',
  dayOfWeek: 5,  // Saturday
  aerobic: 180,
  anaerobic: 20
}
```

Activity matching for bricks: Strava records bike and run as separate activities. The matcher would need to detect sequential bike+run activities within a short time window and associate both with the brick workout.

---

## 9. Workout Library: Swim and Bike

### 9.1 Swim Workouts

Swim workouts are described in **sets and intervals**, not just distance.

**Description format:**
```
Warm up: 200m easy
Main: 10x100m @ 1:40/100m (CSS), 15s rest
Cool down: 200m easy
Total: 1600m
```

**Key swim sessions:**

| Type | Base | Build | Peak |
|------|------|-------|------|
| Technique | 4x50m drills + 4x100m focus | 4x75m drills + 6x100m build | Reduced volume, same drills |
| Endurance | 3x400m, 20s rest | 2x800m + 4x200m | 1x1500m continuous |
| Threshold | 8x100m @ CSS, 15s rest | 10x100m @ CSS, 10s rest | 5x200m @ CSS, 15s rest |
| Speed | 8x50m fast, 30s rest | 6x75m fast, 20s rest | 4x50m race pace, 30s rest |
| Open water | 20 min continuous | 30 min with sighting | 15 min race-pace simulation |

**Session distances by level:**

| Level | Typical Session | Peak Session |
|-------|----------------|-------------|
| Beginner | 1500 to 2000m | 2500m |
| Intermediate | 2500 to 3000m | 3500m |
| Advanced | 3000 to 4000m | 5000m |

### 9.2 Bike Workouts

Bike workouts are described by **duration and intensity zone** (or power target if FTP known).

**Description format (with FTP):**
```
2h endurance @ Z2 (130-165W)
```

**Description format (without FTP):**
```
2h endurance @ easy effort (conversational)
```

**Key bike sessions:**

| Type | Base | Build | Peak |
|------|------|-------|------|
| Endurance (Z2) | 60 to 90 min | 90 to 120 min | 120 to 180 min (70.3) / 180 to 360 min (Ironman) |
| Tempo (Z3) | Not yet | 2x20 min @ 76-90% FTP | 3x20 min |
| Sweet Spot (Z3-4) | Not yet | 2x15 min @ 88-95% FTP | 3x15 min |
| Threshold (Z4) | Not yet | 2x10 min @ 95-105% FTP | 3x12 min |
| VO2max (Z5) | Not yet | 4x4 min @ 106-120% FTP | 5x4 min |
| Hill repeats | Not yet | 4x5 min hill | 6x5 min hill |

**Long ride targets:**
- 70.3: peak long ride 3 to 4 hours
- Ironman: peak long ride 5 to 6 hours

---

## 10. Fitness Model: Per-Discipline Tracking

### 10.1 Per-Discipline CTL/ATL/TSB

The existing fitness model calculates:
```
CTL_today = CTL_yesterday + (TSS_today - CTL_yesterday) / 42
ATL_today = ATL_yesterday + (TSS_today - ATL_yesterday) / 7
TSB = CTL - ATL
```

For triathlon, run this same calculation three times (swim/bike/run) using discipline-specific TSS, plus once for combined total.

**State tracks:**
```
triConfig.swimCTL, triConfig.swimATL  (swim fitness / fatigue)
triConfig.bikeCTL, triConfig.bikeATL  (bike fitness / fatigue)
triConfig.runCTL, triConfig.runATL    (run fitness / fatigue)
```

Combined CTL/ATL uses the sum of all TSS, same as current `ctlBaseline`.

### 10.2 Race Prediction (Triathlon)

Instead of a single race time prediction from VDOT, triathlon mode predicts per-segment:

```
Predicted swim time = f(CSS, swim_CTL, race_distance.swim)
Predicted bike time = f(FTP, bike_CTL, race_distance.bike, course_profile)
Predicted run time = f(threshold_pace, run_CTL, race_distance.run, fatigue_from_bike)
Predicted total = swim + T1 + bike + T2 + run
```

The run prediction needs a **fatigue discount** (4 to 6% for 70.3, 10 to 12% for Ironman) because running off the bike is slower than standalone running (Bentley et al., 2007; Landers et al., 2008). Elite triathletes show smaller decrements (2 to 4% for 70.3) than age-groupers due to greater neuromuscular resilience and pacing discipline (Millet & Vleck, 2000). Cycling IF directly predicts run quality: over-pacing the bike by even 5% IF degrades run performance disproportionately (Atkinson et al., 2007).

**Confidence:** Strong for fatigue discount direction and approximate magnitude (Hue et al., 1998; Bentley et al., 2007). Emerging for precise discount values for individual athletes (depends on training history, brick experience, pacing discipline).

### 10.3 VDOT Equivalent

VDOT remains the running fitness metric. For swim and bike:
- **Swim fitness** = CSS (sec/100m). Lower is better.
- **Bike fitness** = FTP (watts). Higher is better. Optionally FTP/kg (watts per kilogram).

These are not combined into a single "triathlon VDOT." Each discipline has its own progression tracking.

---

## 11. Activity Sync and Matching

### 11.1 Strava Activity Types

| Strava SportType | Discipline | Already Handled? |
|-----------------|------------|-----------------|
| `Run` | Run | Yes |
| `Ride` | Bike | Partially (currently cross-training) |
| `VirtualRide` | Bike | Partially |
| `MountainBikeRide` | Bike | Partially |
| `GravelRide` | Bike | Partially |
| `Swim` | Swim | Partially (currently cross-training) |
| `Walk` | -- | Yes (cross-training) |

**Key change:** In triathlon mode, Ride and Swim activities are no longer cross-training. They are primary plan activities that match against planned swim/bike workouts.

### 11.2 Matching Logic Changes

Current matcher: day proximity + distance + type (run-focused).

Triathlon matcher adds:
- **Discipline matching:** A swim activity can only match a swim workout. A ride can only match a bike workout.
- **Duration matching (swim/bike):** Since these are time-based more than distance-based, match on duration proximity.
- **Brick detection:** If a Ride and a Run occur on the same day within a 30-minute gap, attempt to match them as a brick workout.

### 11.3 Data Available Per Discipline

| Metric | Swim (pool) | Swim (open water) | Bike (power) | Bike (no power) | Run |
|--------|-------------|-------------------|--------------|-----------------|-----|
| Distance | Yes | Yes (GPS) | Yes | Yes | Yes |
| Duration | Yes | Yes | Yes | Yes | Yes |
| Pace/Speed | Yes | Yes | Yes | Yes | Yes |
| Heart Rate | Strap only | Strap only | Yes | Yes | Yes |
| Power | No | No | Yes | Estimated | No |
| Cadence | Stroke rate | Stroke rate | RPM | RPM | Steps/min |
| Elevation | No | No | Yes | Yes | Yes |
| SWOLF | Yes | No | -- | -- | -- |
| Splits | Per lap | Per km (GPS) | Per km | Per km | Per km |

---

## 12. Wizard / Onboarding

### 12.1 Flow Branching

The wizard adds a mode selection step early:

```
Step 1: What are you training for?
  [ ] Marathon / Half / 10K / 5K        → existing running flow
  [ ] Triathlon (70.3 or Ironman)       → triathlon flow
  [ ] General fitness (no race)         → existing continuous mode
```

### 12.2 Triathlon-Specific Wizard Steps

After selecting triathlon:

1. **Distance selection**: 70.3 or Ironman
2. **Race date** (optional): same as current event selection
3. **Experience level per discipline**:
   - Swimming: "Never done laps" / "Can swim 400m+" / "Regular pool swimmer" / "Competitive swimmer"
   - Cycling: "Casual / commute only" / "Regular cyclist" / "Own a road bike, ride weekly" / "Competitive cyclist"
   - Running: existing PB / experience flow
4. **Sessions per week**: How many total sessions? (8 to 12 slider). Suggested split shown.
5. **Thresholds** (optional, can skip):
   - CSS: "Do you know your Critical Swim Speed?" -> manual entry or "I'll test later"
   - FTP: "Do you have a recent FTP test result?" -> manual entry or "Estimate from Strava" or "I'll test later"
   - Running threshold: existing LT/PB flow
6. **Equipment**: Power meter on bike? (affects TSS calculation method)
7. **Wearable connection**: same as current (Garmin/Strava/Apple)
8. **Gym / strength**: same as current

### 12.3 Estimating Starting Fitness

When thresholds are unknown:

- **Swim CSS**: Estimate from 400m PB if provided. Or use level-based defaults:
  - Beginner: 2:30/100m
  - Intermediate: 1:50/100m
  - Advanced: 1:30/100m
- **Bike FTP**: Estimate from Strava power curve (95% of 20-min best). Or use level-based defaults:
  - Beginner: 150W
  - Intermediate: 220W
  - Advanced: 280W
  (**Decision needed**: these are made-up defaults. Per CLAUDE.md rules, need Tristan to confirm or provide these.)
- **Run threshold**: Already handled by VDOT system

---

## 13. UI Changes

### 13.1 Design Principle

Same UX patterns, same visual language. The triathlon UI is the running UI with multi-discipline awareness, not a new app.

### 13.2 Home View

Current: shows this week's workouts as cards.

Triathlon: same card layout, but:
- Each card has a discipline indicator (small coloured dot or icon: blue for swim, orange for bike, green for run)
- Days with two sessions show both cards stacked
- Brick workouts show as a single card with two segments
- Weekly summary shows hours/TSS per discipline

### 13.3 Plan View

Current: week-by-week running plan with phase labels.

Triathlon: same structure, but:
- Each week shows session count per discipline (e.g. "S2 B3 R3")
- Phase labels unchanged (base/build/peak/taper)
- Weekly volume shown as hours (not just km)
- Brick sessions marked with a link icon

### 13.4 Stats View

Current: CTL/ATL/TSB chart, weekly volume, zone distribution.

Triathlon: adds:
- Per-discipline CTL chart (swim/bike/run lines)
- Combined CTL/TSB for overall freshness
- Volume split pie chart (swim/bike/run hours)
- Per-discipline zone distribution
- Swim CSS trend, Bike FTP trend, Run VDOT trend

### 13.5 Activity Detail

Current: shows run metrics (pace, HR, splits, km).

Triathlon: adapts per discipline:
- Swim: pace/100m, SWOLF, stroke count, distance in metres
- Bike: avg power, NP, IF, TSS, avg speed, elevation, cadence
- Run: same as current

### 13.6 Colour Coding

Discipline colours (used for dots, chart lines, badges):

| Discipline | Colour | Rationale |
|------------|--------|-----------|
| Swim | Blue (`var(--c-swim)`) | Universal swim association |
| Bike | Orange (`var(--c-bike)`) | High visibility, standard triathlon colour |
| Run | Green (`var(--c-run)`) | Complements blue and orange, natural/outdoor |
| Brick | Split gradient or dual-dot | Visual combination |

These are accent indicators only (small dots, chart lines). Per UX_PATTERNS.md, no tinted card backgrounds.

---

## 14. Strava/Garmin Data Availability

### 14.1 Key Facts

- Strava has no "triathlon" or "multisport" activity type. Garmin multisport mode uploads as separate activities.
- Brick sessions appear as separate Ride + Run activities with sequential timestamps.
- Pool swim data includes splits per lap, stroke count, SWOLF. No GPS. HR only with chest strap.
- Open water swim has GPS track. No SWOLF/stroke count on Strava.
- Cycling `weighted_average_watts` on Strava DetailedActivity = Normalized Power (pre-calculated).
- Strava estimates power from speed + elevation + weight when no power meter. This is unreliable for TSS but usable as a rough signal.

### 14.2 Data Pipeline Changes

Current `sync-strava-activities` edge function fetches activities and computes iTRIMP from HR streams.

For triathlon:
- Same fetch pipeline. No changes to what we pull from Strava.
- **Classification change**: In triathlon mode, Ride and Swim are primary activities, not cross-training. The `mapGarminType()` / activity classification logic needs a mode-aware branch.
- **TSS calculation**: When FTP or CSS is known, calculate proper bTSS/sTSS instead of (or alongside) iTRIMP.
- **Brick detection**: After fetching all activities, scan for sequential Ride+Run pairs within a 30-min gap on the same day. Flag these as potential brick matches.

---

## 15. Rollout Plan

### Phase 0: Stabilise Running Mode (prerequisite)
Fix open P1 bugs (CTL 222, TSS percentages). These touch fitness-model.ts and load calculations that triathlon will build on.

### Phase 1: Types and State Schema
- Add `eventType`, `TriathlonDistance`, `triConfig` to types
- Add `discipline` field to Workout
- Add swim/bike workout types
- Ensure all existing tests pass (running mode unaffected)
- **No UI changes yet.**

### Phase 2: Wizard Fork
- Add mode selection step
- Build triathlon-specific onboarding steps
- Collect per-discipline data
- Store in `triConfig`
- Result: user can onboard as a triathlete, but sees empty plan

### Phase 3: Plan Engine (Triathlon)
- New `plan_engine.triathlon.ts`
- Swim session generator (technique, endurance, threshold, speed)
- Bike session generator (endurance, tempo, sweet spot, threshold, VO2)
- Run session generator (adapts existing running plan engine)
- Brick session generator
- Strength session (reuse existing gym.ts)
- Phase-appropriate session selection

### Phase 4: Scheduler
- Multi-sport constraint solver
- Two-a-day support
- Brick placement
- Day assignment respecting hard/soft constraints

### Phase 5: Load and Fitness Model
- Per-discipline TSS calculation (sTSS, bTSS, rTSS)
- Per-discipline CTL/ATL/TSB
- Combined CTL/ATL/TSB
- ACWR per discipline

### Phase 6: UI
- Home view: multi-discipline cards, day grouping
- Plan view: per-discipline session counts, volume in hours
- Stats view: per-discipline charts
- Activity detail: swim/bike-specific metrics

### Phase 7: Activity Matching
- Discipline-aware matching
- Brick detection from sequential activities
- Swim/bike activities match planned swim/bike workouts

### Phase 8: Race Prediction
- Per-segment time prediction
- Overall race time estimate
- Pacing strategy display

---

## 16. Open Questions

These need Tristan's input before implementation:

### Architecture
1. **Shared or separate plan engines?** Recommendation: separate (`plan_engine.triathlon.ts`) that reuses utility functions. Cleaner than branching throughout the existing engine.
2. **Per-discipline CTL + combined?** Recommendation: both. Combined for overall load, per-discipline for plan adaptation.

### UX
3. **Two-a-day display**: Two separate cards stacked on the same day? Or a grouped "morning/afternoon" view?
4. **Discipline colours**: Blue/orange/green for swim/bike/run? Or different?
5. **Stats view**: Separate tabs per discipline? Or unified view with toggle?
6. **Volume unit**: Hours (triathlon standard) vs km? Likely hours for overall, with discipline-specific units (metres for swim, km for bike, km for run).

### Training Model
7. **Default CSS/FTP for beginners**: Per CLAUDE.md, no made-up numbers. The section 12.3 defaults need confirmation.
8. **Volume splits**: 15-20% swim / 45-50% bike / 30-35% run. Confirm these are the right starting points.
9. **Recovery week pattern**: Every 3rd or 4th week? Should this match the running mode's deload logic?
10. **Power meter assumption**: Design for power-optional (fall back to HR-based bike TSS)?

### Data
11. **Strava brick detection window**: 30 minutes between bike end and run start? What threshold?
12. **FTP from Strava**: Should we automatically estimate from the power curve, or always ask the user?

### Scope
13. **Sprint and Olympic distances**: Support later? The architecture should allow it but we don't build for it now.
14. **Nutrition tracking**: Ironman nutrition is critical. Is this in scope or out?
15. **Transition practice**: Include T1/T2 practice sessions in the plan, or just notes?
16. **Open water vs pool swim**: Different workout types? Or just a user preference?

---

## 17. Integration Deep Dive: Problems, Solutions, and Options

This section walks through every stage of the user journey and identifies exactly where triathlon breaks the current system, what the options are, and what the recommended path is. File paths and function names are specific to the current codebase.

### 17.1 Onboarding / Wizard

**Current flow** (`src/ui/wizard/controller.ts`, `src/ui/wizard/renderer.ts`):
```
welcome → goals → background → volume → performance →
fitness → strava-history (conditional) → physiology →
initializing → runner-type → assessment → main-view
```

The wizard is a linear state machine. `nextStep()` advances, `previousStep()` goes back. Flow control and rendering are cleanly separated from data collection, which means the control flow itself is sport-agnostic. The problem is entirely in what data each step collects and how `initializeSimulator()` transforms it.

#### Step-by-step breakdown:

**Step 1: Welcome** (collects `name`)
- No changes needed.

**Step 2: Goals** (collects `trainingForEvent`, `raceDistance`, `selectedRace`/`customRaceDate`)
- **Problem**: `raceDistance` is `'5k' | '10k' | 'half' | 'marathon'`. No triathlon option. The race browser only shows marathon events.
- **Solution**: Add sport selection before distance selection. If triathlon, show `'70.3' | 'ironman'` instead of running distances. Race browser needs triathlon events or a custom-date-only path.
- **Options**:
  - **(A) Inline fork**: Add a "What are you training for?" card at the top of the goals step: Running / Triathlon. Then conditionally show running distances or triathlon distances. Minimal UI change.
  - **(B) New step**: Insert a `sport-selection` step before `goals`. Cleaner separation but adds a step.
  - **Recommendation**: Option A. One fewer step, less friction. The goals step already has conditional rendering for event vs continuous mode.

**Step 3: Background** (collects `experienceLevel`, `commuteConfig`, `activeLifestyle`)
- **Problem**: `experienceLevel` uses `RunnerExperience` enum (8 levels from `total_beginner` to `competitive`). The commute config assumes running.
- **Solution**: For triathlon, experience level should be per-discipline or a composite. Commute could be bike commute.
- **Options**:
  - **(A) Composite experience**: Single experience level applies to triathlon overall. Simplest. Misses the fact that someone can be a beginner swimmer and advanced cyclist.
  - **(B) Per-discipline experience**: Three separate selectors (swim/bike/run level). More data but more accurate.
  - **Recommendation**: Option B. It's 3 taps instead of 1. The plan engine needs this data to set session complexity (beginner swimmer gets technique drills, advanced cyclist gets sweet spot intervals). Commute: add "Do you bike commute?" alongside the existing run commute.

**Step 4: Volume** (collects `runsPerWeek`, `gymSessionsPerWeek`, `recurringActivities`)
- **Problem**: This is the biggest change. `runsPerWeek` is the primary planning variable. The step has no concept of swim or bike sessions as planned training.
- **Solution**: Replace single `runsPerWeek` with per-discipline counts.
- **Options**:
  - **(A) Total sessions + suggested split**: User picks total (8-12), app suggests "3 swim / 3 bike / 3 run" based on distance and level. User can adjust.
  - **(B) Per-discipline pickers**: Three separate sliders. More control, slightly more complex.
  - **(C) Presets**: "Beginner (8 sessions)", "Intermediate (10)", "Advanced (12)" with fixed splits.
  - **Recommendation**: Option A with editable split. Shows the recommended distribution but lets the user override. This mirrors how the current step works (pick runs/week, app suggests plan). The recurring activities list would exclude swim/bike/run since those are now primary disciplines, not cross-training.
  - **Key decision**: What happens to `gymSessionsPerWeek`? Rename to strength. Tri-specific strength is different (more core, less leg focus in base phase). The gym workout generator (`src/workouts/gym.ts`) would need tri-specific templates.

**Step 5: Performance** (collects `pbs`, `recentRace`)
- **Problem**: `PBs` interface is `{k5?, k10?, h?, m?}` (running only). `RecentRun` is a running race. Validation ranges are running-specific.
- **Solution**: Collect per-discipline benchmarks.
- **For swim**: CSS is the gold standard. Ask for 400m and 200m times (the CSS test), or a recent 1500m/400m swim time. Or "I don't know my swim pace" -> use level-based estimate.
- **For bike**: FTP is ideal. Ask for 20-min power test result, or "I don't know my FTP" -> estimate from Strava power curve or use level-based default.
- **For run**: Keep existing PB collection (unchanged).
- **Options**:
  - **(A) Minimal**: Just ask swim level + bike level + running PBs. Estimate CSS/FTP from level.
  - **(B) Guided tests**: In-app protocols ("Go to the pool and swim 400m all out, then 200m all out. Enter your times."). Better data but requires the user to go do something.
  - **(C) Full input**: CSS input, FTP input, running PBs. Most accurate for experienced triathletes.
  - **Recommendation**: Tiered approach. Start with level (A), offer optional precision inputs (C) for users who have the data. Show a "I have my CSS/FTP" toggle that reveals the input fields. Guided tests (B) can be offered later as in-app benchmark sessions.
  - **Validation ranges needed**: Swim 400m: 4:00 to 15:00. Swim 200m: 1:30 to 8:00. Bike FTP: 80W to 450W.

**Step 6: Fitness** (collects `hasSmartwatch`, `watchType`)
- **No changes needed.** Garmin and Apple Watch track all three disciplines. Strava syncs all activity types.

**Step 7: Strava History** (conditional, collects `historicWeeklyTSS`, `detectedWeeklyKm`, `athleteTier`)
- **Problem**: Currently analyzes running-only km and TSS. `detectedWeeklyKm` is running km. `athleteTier` is based on running CTL.
- **Solution**: Strava history should break down by discipline. Show swim hours, bike hours, run hours. Compute per-discipline starting fitness.
- **Edge function change**: The `history` mode of `sync-strava-activities` already processes all activity types. It just needs to return per-discipline breakdowns instead of aggregating to a single TSS.
- **New state fields**: `historicSwimTSS[]`, `historicBikeTSS[]`, `historicRunTSS[]`. Or a single array of `{swim, bike, run}` objects per week.
- **Display**: Show "Your training history: avg 2h swim, 5h bike, 3h run per week" instead of just "avg 45km running per week".

**Step 8: Physiology** (collects `biologicalSex`, `ltPace`, `vo2max`, `restingHR`, `maxHR`)
- **Problem**: `ltPace` is running-specific. `vo2max` is technically sport-agnostic but Garmin reports running VO2max and cycling VO2max separately.
- **Solution**: Keep existing fields for running. Add optional swim/bike thresholds.
- **New fields**: `swimCSS` (sec/100m), `bikeFTP` (watts), `bikeLTHR` (bpm, if no power meter).
- **Garmin sync**: `syncPhysiologySnapshot()` already pulls VO2max. Check if Garmin reports cycling VO2max separately (it does for some devices). If available, store both.

**Step 9: Initializing** (calls `initializeSimulator()`)
- **Problem**: `initializeSimulator()` in `src/state/initialization.ts` is entirely running-specific. It computes VDOT from PBs, derives paces, calculates fatigue exponent, builds phase schedule, forecasts race time.
- **Solution**: Fork. `initializeTriathlon(onboardingState)` runs when `eventType === 'triathlon'`.
- **What it computes**:
  1. Run fitness from PBs (reuse existing VDOT calculation)
  2. Swim fitness from CSS (or estimated from level)
  3. Bike fitness from FTP (or estimated from level)
  4. Per-discipline volume targets (from session counts + distance)
  5. Phase schedule (same 4 phases, different durations per distance)
  6. Per-discipline starting CTL (from Strava history if available)
  7. Race time forecast (per-segment)
- **Reusable**: `abilityBandFromVdot()`, `isDeloadWeek()`, `calculateForecast()` (with modifications for per-segment prediction).
- **Not reusable**: `blendPredictions()` (running-only), `getRunnerType()` (single-sport fatigue exponent), weekly km calculation.

**Step 10: Runner Type** (collects `confirmedRunnerType`)
- **Problem**: Speed/Balanced/Endurance classification is computed from the running fatigue exponent `b`. Meaningless for triathlon as a whole.
- **Options**:
  - **(A) Drop entirely for triathlon**: No athlete type classification. Simplest but loses personalization.
  - **(B) Per-discipline typing**: Show "Your swim: technique-focused. Your bike: endurance-focused. Your run: balanced." Three indicators instead of one.
  - **(C) Triathlon archetype**: Replace with tri-specific types: "Strong swimmer", "Strong cyclist", "Strong runner", "All-rounder". Derived from relative fitness across disciplines.
  - **Recommendation**: Option C. One classification that guides plan emphasis. If the user is a strong cyclist but weak swimmer, the plan allocates more swim technique work. This is analogous to how runner type currently biases workout selection (speed runners get more threshold, endurance runners get more VO2).

**Step 11: Assessment** (shows plan forecast, offers harder plan)
- **Problem**: Shows a single race time prediction and an option to upgrade runs/week.
- **Solution**: Show per-segment predictions (swim/bike/run/total). The "harder plan" option becomes more nuanced, could mean more sessions in any discipline.
- **Options**:
  - **(A) Simple**: Show total predicted time + per-segment breakdown. Single "more volume" toggle.
  - **(B) Per-discipline upgrade**: "Add a swim session? Add a bike session?" Three toggles.
  - **Recommendation**: Option A for MVP. Keep it simple. One upgrade toggle that adds the most impactful session (usually a bike session for 70.3/Ironman since bike is the longest segment).

---

### 17.2 Plan Generation

**Current system** (`src/workouts/plan_engine.ts` → `planWeekSessions()` → `SessionIntent[]`):
- Calculates ability band from VDOT
- Determines deload weeks
- Applies effort multiplier (adaptive scaling from RPE feedback)
- Caps quality sessions based on ability
- Fills slots greedily from a priority list (race-distance and phase dependent)

**Problems for triathlon:**

1. **Volume is single-sport**: `totalMinutes` is all running. No concept of swim/bike time budgets.
2. **Quality cap is global**: "Max 2 quality sessions" doesn't distinguish swim quality from run quality.
3. **Priority list is running-specific**: The priority ordering (threshold vs VO2 vs marathon pace) only makes sense for running.
4. **Long run is the anchor**: Currently Sunday is reserved for the long run. In triathlon, Saturday long bike is equally important.

**Solution: Parallel discipline planners**

The triathlon plan engine generates intents per discipline, then merges:

```
planTriathlonWeek(ctx) {
  1. Calculate total weekly hours for this phase/week
  2. Split hours: swim 15-20%, bike 45-50%, run 30-35%
  3. Generate swim intents: planSwimSessions(ctx, swimHours)
  4. Generate bike intents: planBikeSessions(ctx, bikeHours)
  5. Generate run intents: planRunSessions(ctx, runHours)  // reuses existing logic
  6. Generate brick intent (if build/peak, not recovery week)
  7. Merge all intents → pass to triathlon scheduler
}
```

**What's reusable from `planWeekSessions()`:**
- `abilityBandFromVdot()` — sport-agnostic
- `isDeloadWeek()` — sport-agnostic (same 3/4/5-week cycle)
- `effortMultiplier()` — sport-agnostic (RPE feedback scales any discipline)
- Quality cap logic — reusable per discipline (max 1 quality swim, max 2 quality bike, max 2 quality run)
- Slot-fill greedy algorithm — reusable per discipline with different priority lists

**What needs parallel implementation:**
- Volume budget functions: `swimWorkMinutes()`, `bikeWorkMinutes()` alongside existing run budgets
- Priority ordering per discipline:
  - Swim: threshold > endurance > technique > speed (build phase)
  - Bike: endurance > sweet spot > threshold > VO2 (build phase, Ironman)
  - Bike: threshold > VO2 > sweet spot > endurance (build phase, 70.3)
  - Run: same as current running mode (but with lower volume)
- Phase multipliers per discipline (swim volume doesn't taper as aggressively as run volume)

**Key integration point**: `src/workouts/generator.ts:generateWeekWorkouts()` (17 params). This orchestrates the full pipeline. It needs to branch on `eventType` before calling the plan engine:
```typescript
if (s.eventType === 'triathlon') {
  intents = planTriathlonWeek(triCtx);
} else {
  intents = planWeekSessions(ctx);
}
```

Everything after intent generation (load calculation, HR targets, injury adaptation, day assignment, stable IDs) flows through the same pipeline with minor extensions.

---

### 17.3 Intent-to-Workout Conversion

**Current system** (`src/workouts/intent_to_workout.ts`):
Converts `SessionIntent` → `Workout` with human-readable descriptions. Uses pace ratios derived from easy pace (VO2 = 0.809 * easy, threshold = easy / 1.15, etc.).

**Problems:**
1. **Pace ratios are running biomechanics**: Swimming effort-to-pace relationship is completely different (cubed, not squared, due to water resistance). Cycling uses power, not pace.
2. **Description format is running-specific**: "5.2km @ 5:00/km" doesn't work for swim ("10x100m @ 1:40/100m") or bike ("2h @ Z2, 130-165W").
3. **WU/CD logic assumes running**: Swim warm-up is "200m easy" not "1km warm-up".

**Solution**: Add parallel conversion functions:

```typescript
function swimIntentToWorkout(intent, swimCSS, swimLevel) → Workout
function bikeIntentToWorkout(intent, bikeFTP, hasPowerMeter) → Workout
function brickIntentToWorkout(bikeIntent, runIntent, ...) → Workout
// existing intentToWorkout() handles run intents (unchanged)
```

**Swim description format**:
```
Warm up: 200m easy
Main: 10x100m @ 1:40/100m (CSS), 15s rest
Cool down: 200m easy
Total: 1500m
```

**Bike description format (with power)**:
```
2h endurance @ Z2 (130-165W)
```
**Bike description format (without power)**:
```
2h endurance @ easy effort (HR 120-140)
```

**Reusable**: The description → load parsing pipeline in `load.ts` needs corresponding parsers for swim/bike formats.

---

### 17.4 Scheduler (Day Assignment)

**Current system** (`src/workouts/scheduler.ts:assignDefaultDays()`):
5-phase algorithm: categorize → space hard workouts → place commute → place easy → place cross-training → deconflict stacking.

**Problems:**

1. **No two-a-day support**: Triathlon regularly has 2 sessions per day (e.g., morning swim + evening run). Current scheduler puts max 1 workout per day, with stacking as a last resort.
2. **Hard-day detection is run-only**: `HARD_WORKOUT_TYPES` only includes running types. A hard swim followed by a hard bike on consecutive days would not be flagged.
3. **Long run = Sunday is hardcoded**: In triathlon, Saturday = long bike (often with brick run), Sunday = long run. Both anchors need to coexist.
4. **No cross-discipline recovery awareness**: A hard swim is low-impact and doesn't require the same recovery as a hard run. The scheduler should allow hard swim + easy run on consecutive days.

**Solution options:**

**(A) Extend existing scheduler**: Add swim/bike to `HARD_WORKOUT_TYPES`. Teach it about two-a-day slots. Mark long bike as Saturday anchor.
- Pro: Incremental change, less risk.
- Con: The algorithm wasn't designed for multi-sport constraints. Gets complex fast.

**(B) New scheduler for triathlon**: Template-based day assignment using proven triathlon weekly patterns (see section 8.2 of main doc). Then fine-tune with constraint checking.
- Pro: Cleaner, purpose-built. Uses known-good triathlon scheduling patterns.
- Con: Parallel code path to maintain.

**Recommendation**: Option B. The triathlon scheduler uses template patterns:
```
Template: 3S/3B/3R intermediate
Mon: REST
Tue: Swim (quality) + Run (quality)
Wed: Bike (quality) + Strength
Thu: Swim (endurance) + Run (easy)
Fri: Swim (technique) or REST
Sat: Long Bike (+brick run)
Sun: Long Run
```

Then applies constraint validation (`checkTriathlonConstraints()`):
- No two quality sessions in same discipline on consecutive days
- No quality run day after long bike (or brick)
- At least 1 full rest day
- Brick only on Saturday (or user-configured long day)

The existing `checkConsecutiveHardDays()` extends to cross-sport:
```typescript
const HARD_BY_DISCIPLINE = {
  swim: ['swim_threshold', 'swim_vo2', 'swim_speed'],
  bike: ['bike_threshold', 'bike_vo2', 'bike_sweet_spot', 'bike_hill'],
  run: ['threshold', 'vo2', 'race_pace', 'marathon_pace', 'intervals', 'long', ...],
};
// Rule: No consecutive days with hard sessions in overlapping muscle groups
// swim hard + run hard next day = OK (different muscle groups)
// bike hard + run hard next day = BAD (both legs)
// bike hard + swim hard next day = OK
```

**Two-a-day representation**: Two separate `Workout` objects with same `dayOfWeek`. Add `timeSlot?: 'am' | 'pm'` for ordering. No structural change to the `Workout` interface beyond this optional field.

---

### 17.5 Daily Interaction: Rating, Skipping, Moving

**Current system** (`src/ui/events.ts`):
- `rate(workoutId, name, rpe, expected, type, ...)`: Records RPE, computes VDOT adjustment (±0.15 per RPE band), applies HR efficiency shift, caps at ±0.3 VDOT/week.
- `skip(workoutId, ...)`: First skip → push to next week. Second skip → time penalty (race mode) or drop (continuous).
- `moveWorkout(name, newDay)`: Stores in `wk.workoutMoves`, applied on next render.

**Problems:**

1. **VDOT adjustment from RPE**: Currently, all workout RPE feeds a single VDOT number. For triathlon, a hard swim rating shouldn't adjust running VDOT.
2. **Time impact penalty**: Only makes sense for running races. Skipping a swim shouldn't penalize run race time.
3. **HR efficiency shift**: Assumes running HR zones. Swim HR is 10-15 bpm lower at the same effort. Bike HR is 5-10 bpm lower.
4. **LT auto-estimation** (from threshold workout HR): Only works for running threshold. Need separate CSS/FTP auto-estimation from swim/bike threshold sessions.

**Solutions:**

**Rating**: Add `discipline` to the rate function. Route adjustments to the correct fitness metric:
```
discipline === 'run'  → adjust running VDOT (existing logic)
discipline === 'swim' → adjust swimCSS (analogous logic, different units)
discipline === 'bike' → adjust bikeFTP estimate (analogous logic, watts)
```
The RPE-to-adjustment curve is sport-agnostic (how hard did it feel vs expected). The magnitude of adjustment is sport-specific.

**Skipping**: Same push-to-next-week logic for all disciplines. Time penalty only applies to the running segment of the triathlon prediction. Skipping a swim doesn't affect run prediction but does affect swim prediction.

**Moving**: No changes needed. `moveWorkout()` is day-based, sport-agnostic.

**HR efficiency shift**: Apply sport-specific HR zone corrections:
```typescript
if (discipline === 'swim') maxHR = s.maxHR - 12;  // typical swim HR discount
if (discipline === 'bike') maxHR = s.maxHR - 5;
```

---

### 17.6 Activity Sync and Matching

**Current system** (`src/data/activitySync.ts`, `src/calculations/activity-matcher.ts`):
- `syncStravaActivities()` → edge function → `matchAndAutoComplete()`
- Activities classified by `mapGarminType()`: runs → auto-match to plan. Everything else → cross-training queue.
- `findMatchingWorkout()` scores on: day proximity (0-3 pts) + distance match (0-3 pts, runs only) + type affinity (0-2 pts).
- Auto-completion: only runs get silent auto-match with high confidence. All cross-training goes to user review (`processPendingCrossTraining()`).

**Problems (this is the most complex integration point):**

1. **Swim/bike classified as cross-training**: `mapGarminType()` maps `SWIMMING` → `'swim'`, `CYCLING` → `'ride'`. Neither gets auto-matched to plan slots. Both go to the pending queue for user review as if they were incidental cross-training.
   - **Fix**: In triathlon mode, swim and bike activities are primary. They should auto-match to planned swim/bike workouts with the same confidence as run matching.
   - **Implementation**: Add `eventType` check in `matchAndAutoComplete()`. When `eventType === 'triathlon'`, treat swim/bike activities the same as run activities for matching purposes.

2. **Distance matching is run-only**: `findMatchingWorkout()` only computes distance ratio for runs. Swim activities have distance in metres, bike in km with very different ranges.
   - **Fix**: Add discipline-aware distance matching:
     - Swim: match on distance in metres (planned 1500m vs actual 1600m = within 15%)
     - Bike: match on duration (planned 2h vs actual 1:50 = within 15%). Distance is less reliable (flat vs hilly routes).
     - Run: unchanged (distance in km).

3. **Brick matching**: A brick is one planned workout. Strava records it as two separate activities (Ride + Run). Currently these would be two unmatched activities going to the review queue.
   - **Fix options**:
     - **(A) Pre-grouping**: Before matching, scan activities for sequential Ride+Run pairs within a 30-min gap. Group them as a candidate brick match. Try to match the group to a planned brick workout.
     - **(B) User assignment**: Show brick slots in the matching screen. User drags both the ride and the run onto the brick slot.
     - **(C) Post-match linking**: Match bike and run independently to the brick's segments. The brick is "completed" when both segments are matched.
   - **Recommendation**: Option A for auto-match, Option B as fallback in the matching screen. The `garminMatched` map needs to support multiple garmin IDs per workout: `garminMatched[garminId1] = 'W5-brick-0'` AND `garminMatched[garminId2] = 'W5-brick-0'`. This is already possible since it's a `Record<string, string>` (multiple keys can have the same value).

4. **Pace adherence**: Currently computed only for runs (`actualPace / targetPace`). Needs swim and bike equivalents.
   - Swim: `actualPace100m / targetCSS`
   - Bike: `actualNP / targetPower` (if power data) or `actualAvgHR / targetHR` (if HR only)

5. **RPE derivation**: Priority chain is `Garmin RPE → HR zone → Training Effect → heuristic → planned`. HR-zone-based RPE needs sport-specific zone tables.

6. **Load calculation for synced activities**: Currently uses iTRIMP with `runSpec` discount. In triathlon mode, swim/bike activities matched to planned swim/bike slots should use full TSS (runSpec = 1.0 within their discipline), not discounted.
   - **Fix**: When an activity matches a planned swim/bike workout (triathlon mode), skip the `runSpec` discount for Signal A per-discipline CTL. Signal B already uses full load.

---

### 17.7 Cross-Training Reclassification

**Current system** (`src/cross-training/suggester.ts`, `src/cross-training/planSuggester.ts`):
- Any non-run activity triggers the "Reduce/Replace/Keep" modal
- Load from cross-training can replace easy runs or downgrade quality runs
- `SPORTS_DB` has `runSpec` multipliers for every sport

**Problem**: In triathlon mode, swim and bike are no longer cross-training. They ARE the training. The suggestion modal should not fire for planned swim/bike activities.

**Fix**: The cross-training pipeline needs a mode-aware gate:
```typescript
function isCrossTraining(activityType: string, eventType: string): boolean {
  if (eventType === 'triathlon') {
    // In triathlon, swim/bike/run are all primary. Only other sports are cross-training.
    return !['run', 'swim', 'ride'].includes(activityType);
  }
  // In running mode, only runs are primary.
  return activityType !== 'run';
}
```

Activities that ARE planned (swim/bike) get matched to their slots. Activities that are genuinely cross-training (yoga, tennis, hiking) still go through the existing suggestion pipeline, but now they can reduce swim/bike workouts too, not just runs.

**Adjustment target expansion**: Currently `buildCandidates()` only considers run workouts as reduction/replacement candidates. In triathlon mode, easy swim and easy bike sessions are also candidates (with appropriate priority ordering: reduce easy swim before easy run, since swim has lower injury risk if overtrained).

---

### 17.8 Load and Fitness Model

**Current system** (`src/calculations/fitness-model.ts`):
- Signal A: `computeWeekTSS()` — applies `runSpec` discount
- Signal B: `computeWeekRawTSS()` — no discount (full physiological load)
- CTL = 42-day EMA of Signal A. ATL = 7-day EMA of Signal B.
- TSB = CTL - ATL.

**Problems:**

1. **Signal A is running-centric**: A triathlete's fitness is not just "how much running-equivalent load have I done." Their swim fitness and bike fitness are separate concerns.
2. **CTL uses Signal A, ATL uses Signal B**: This creates a deliberate divergence where cross-training fatigues you (ATL rises) but doesn't build running fitness (CTL stays flat). Correct for runners. Wrong for triathletes where swim/bike IS building fitness.
3. **Athlete tier from CTL**: `athleteTier` drives ACWR thresholds and plan ramp rate. A triathlete with high training volume but moderate running volume would be classified as "recreational" because their running CTL is low.

**Solution: Per-discipline CTL + combined Signal B**

```
swimCTL = 42-day EMA of swim TSS (from swim activities only)
bikeCTL = 42-day EMA of bike TSS (from bike activities only)
runCTL  = 42-day EMA of run TSS  (from run activities only, same as current Signal A)

combinedATL = 7-day EMA of total TSS (all disciplines, same as current Signal B)
combinedCTL = swimCTL + bikeCTL + runCTL  (for overall load assessment)

Per-discipline TSB:
  swimTSB = swimCTL - swimATL
  bikeTSB = bikeCTL - bikeATL
  runTSB  = runCTL  - runATL
  overallTSB = combinedCTL - combinedATL
```

**Athlete tier**: Derive from combined CTL (sum of all disciplines). This correctly classifies a triathlete doing 12h/week as "trained" even if only 4h of that is running.

**ACWR**: Compute per discipline AND combined:
- `swimACWR = swimATL / swimCTL` (is swim load spiking?)
- `runACWR = runATL / runCTL` (is run load spiking?)
- `overallACWR = combinedATL / combinedCTL` (overall overtraining risk)

The plan engine uses per-discipline ACWR to reduce that specific discipline's volume. The readiness system uses overall ACWR for general recovery assessment.

**Implementation**: `computeFitnessModel()` already loops through all weeks. Extend the loop to compute per-discipline CTL alongside the existing combined calculation. The math is identical, just applied to filtered TSS inputs.

---

### 17.9 Readiness and Daily Coaching

**Current system** (`src/calculations/readiness.ts`, `src/calculations/daily-coach.ts`):
- Readiness composite: 35% freshness (TSB) + 30% load safety (ACWR) + 35% recovery (HRV/sleep/RHR)
- Hard floors: ACWR > 1.5 → readiness ≤ 39. Sleep < 45 → readiness ≤ 59.
- Daily coach: stance (push/normal/reduce/rest) + blockers (injury/illness/overload/sleep)

**Problems:**

1. **Freshness from TSB**: Single TSB doesn't tell you if you're fresh for swimming but fatigued for running. A triathlete could have swimTSB = +15 (fresh) and runTSB = -20 (fatigued).
2. **Load safety from ACWR**: Single ACWR misses discipline-specific spikes. Run ACWR could be 0.9 (safe) while bike ACWR is 1.6 (overreaching) if you suddenly added bike volume.

**Solution: Discipline-aware readiness**

For the home view and daily coaching:
- **Overall readiness**: Use combined TSB and combined ACWR. This answers "should I train at all today?"
- **Discipline readiness**: Use per-discipline TSB and ACWR. This answers "what should I do today?" If run readiness is low but swim readiness is high, the coach suggests a swim day.

**Daily coach extension**:
```
stance = 'push' | 'normal' | 'reduce' | 'rest' | 'swap'

'swap' (new): "Your running load is high but you're fresh for swimming.
Today's planned threshold run could be swapped for a swim session."
```

Recovery sub-signals (HRV, sleep, RHR) remain discipline-agnostic. They reflect overall physiological recovery, which applies equally to all disciplines.

**Timing check** (`src/cross-training/timing-check.ts`): Currently flags hard sessions the day before a quality run. For triathlon:
- Hard bike → quality run next day: FLAG (legs fatigued)
- Hard swim → quality run next day: OK (different muscle groups)
- Hard run → quality bike next day: MILD FLAG (legs somewhat fatigued)
- Hard swim → quality bike next day: OK
- Hard bike → quality swim next day: OK
- Hard run → quality swim next day: OK

---

### 17.10 Stats and Progress Display

**Current system** (`src/ui/stats-view.ts`, `src/ui/home-view.ts`):
- Weekly load bar (Signal B actual vs planned)
- CTL/ATL/TSB chart (8/16-week history)
- Zone distribution (Z1+Z2 / Z3 / Z4+Z5)
- Running km trend
- VDOT trend

**Changes for triathlon:**

**Home view**:
- Weekly load bar: segmented by discipline (swim = blue, bike = orange, run = green). Total height = combined TSS.
- Readiness card: show overall readiness + per-discipline indicators as small dots (green/yellow/red per discipline).
- Today's strain: show completed activities with discipline icons.

**Stats view**:
- **Volume tab**: Weekly hours chart (stacked by discipline). Replace running-only km with per-discipline metrics (swim metres, bike km, run km).
- **Fitness tab**: Three CTL trend lines (swim/bike/run) on one chart, color-coded. Combined TSB as a separate indicator.
- **Zones tab**: Per-discipline zone distribution. Swim zones are pace-based. Bike zones are power or HR-based. Run zones unchanged.
- **Progress tab**: Per-discipline fitness trends (CSS improving? FTP increasing? VDOT climbing?). Plus combined race time prediction.

**Options for tab structure**:
- **(A) Discipline tabs**: Stats > Swim | Bike | Run | Combined. Four sub-views.
- **(B) Metric tabs with discipline breakdown**: Stats > Volume | Fitness | Zones | Progress. Each shows all three disciplines.
- **Recommendation**: Option B. Mirrors the current stats structure. Users think in terms of "how's my fitness?" not "show me my swim stats." Each metric view breaks down by discipline within it.

---

### 17.11 Injury System

**Current system** (`src/injury/engine.ts`):
Six-phase progression: acute → rehab → test_capacity → return_to_run → graduated_return → resolved.

**Problems:**

1. **Running-specific phases**: "return_to_run" and capacity tests assume running. A knee injury might mean "no running but keep swimming."
2. **Detraining model**: Negative VDOT gain per week in each injury phase. For triathlon, detraining should be per-discipline (injured knee → run fitness declines, swim fitness maintained if still swimming).

**Solution: Discipline-specific injury adaptation**

When an injury is reported, ask which disciplines are affected:
```
"Which activities are affected?"
[ ] Swimming  [ ] Cycling  [ ] Running
```

Affected disciplines follow the existing phase progression. Unaffected disciplines continue normally (possibly with reduced volume to avoid compensatory overload).

**Injury-to-discipline mapping (common patterns)**:
- Knee injury → Running affected, cycling may be affected, swimming OK
- Shoulder injury → Swimming affected, cycling/running OK
- Lower back → All affected but cycling most (position)
- Ankle → Running affected, cycling OK, swimming OK (but flip turns may hurt)

**Sport substitution**: When a run session is cancelled due to injury, the engine could suggest a swim or bike session at equivalent aerobic load. This is already conceptually what the cross-training system does, but inverted (injury removes a planned session, substitution fills the gap rather than the current "cross-training adds load, remove a run").

---

### 17.12 GPS Recording

**Current system** (`src/gps/`):
`GpsTracker` state machine (idle → acquiring → tracking → paused → stopped). Split detection parses running workout descriptions.

**For triathlon:**
- Run tracking: unchanged.
- Bike tracking: GPS works the same. Split scheme would need bike-specific logic (e.g., splits by time not distance, since bike segments are time-based).
- Swim tracking: GPS only works for open water. Pool swims have no GPS. The app would need to accept manual distance entry for pool swims, or pull from Garmin/Strava sync.
- **Recommendation**: GPS recording is low priority for triathlon MVP. Most triathletes use dedicated bike computers and swim watches. The sync pipeline handles all the data. GPS recording in-app is a nice-to-have for runs.

---

### 17.13 Renderer Lifecycle

**Current system** (`src/ui/renderer.ts:render()`):
```
1. Get state → compute currentVDOT → update paces
2. Compute forecast
3. Generate workouts (generateWeekWorkouts)
4. Apply mods (workoutMods)
5. Deduplicate names
6. Append adhoc workouts
7. Apply moves (workoutMoves)
8. Render calendar + workout list
```

**Changes for triathlon:**

Step 1: Additionally compute current CSS and FTP from per-discipline adjustments.
Step 2: Forecast per-segment (swim/bike/run times + total).
Step 3: `generateWeekWorkouts()` now returns swim/bike/run/brick workouts (with `discipline` field).
Steps 4-7: No changes. Mods, dedup, adhoc, moves all work on `Workout[]` regardless of discipline.
Step 8: Calendar renders discipline-colored indicators. Workout list groups by day, showing all disciplines.

**Deduplication**: Currently renames "Easy Run" → "Easy Run 1", "Easy Run 2". For triathlon, names include discipline ("Easy Swim", "Easy Bike", "Easy Run") so duplicates are less likely within a discipline. If there are two easy swims, "Easy Swim 1" and "Easy Swim 2".

**Workout cards**: Add a discipline badge (small colored dot or text label). Swim cards show distance in metres and pace/100m. Bike cards show duration and power/zone. Run cards unchanged.

---

### 17.14 Edge Cases and Potential Gotchas

1. **State migration**: Existing running-mode users should never see triathlon fields. `eventType` defaults to `'running'` when undefined. `triConfig` is only created during triathlon onboarding.

2. **Mixed-mode users**: Can a user switch from running mode to triathlon mode? This would require a re-onboarding flow. For MVP, no. Pick one mode at onboarding time. Mode switch = reset plan.

3. **Strava activity misclassification**: Strava sometimes labels indoor cycling as "Workout" or swim as "Other". The current `mapGarminType()` handles some of these, but triathlon mode is more sensitive to misclassification since swim/bike are primary activities. May need a "reclassify activity" option in the review screen.

4. **No-data disciplines**: User signs up for triathlon but has no swim history, no CSS, no FTP. Everything is estimated from level. The plan works but predictions are unreliable. First few weeks should include assessment sessions (CSS test swim, FTP test ride) to calibrate.

5. **Double-counting in load model**: A brick workout (1 planned workout) matched to 2 Strava activities must not double-count load. The deduplication in `computeWeekTSS()` uses `garminId` to prevent this, but the brick matching needs to correctly register both activities under one planned workout without inflating the planned TSS.

6. **Bike commute volume**: A triathlete who bike-commutes 30 min each way, 5 days/week, is doing 5h of Zone 1-2 cycling per week that's not in the plan. This is significant volume. The commute system needs bike-commute awareness (currently only handles run commutes).

7. **Indoor training**: Many triathletes do indoor swim (pool) and indoor bike (Zwift/TrainerRoad). These show up as different Strava activity types (`VirtualRide`, `Swim` vs `OpenWaterSwim`). Make sure all indoor variants map correctly.

8. **Nutrition tracking**: Ironman requires practicing race nutrition during long training sessions. This is out of scope for MVP but worth noting as a future feature. The workout description could include nutrition reminders ("Practice eating 60g carbs/hour during this ride").

---

## Appendix A: Reference Training Plans

### 20-Week 70.3 Plan (Intermediate, 10-12h/week peak)

| Week | Phase | Swim | Bike | Run | Total Hours |
|------|-------|------|------|-----|-------------|
| 1-4 | Base 1 | 2x (tech + endurance) | 2x (endurance) | 2x (easy) + 1x easy | 7-8h |
| 5-8 | Base 2 | 2x (tech + endurance) + 1x threshold | 2x (endurance + tempo) | 3x (easy + steady) | 8-9h |
| 9-10 | Build 1 | 3x (threshold + endurance + tech) | 3x (long + sweet spot + endurance) | 3x (easy + tempo + easy) + brick | 10-11h |
| 11-12 | Build 2 | 3x (threshold + endurance + speed) | 3x (long + threshold + tempo) | 3x (easy + threshold + easy) + brick | 11-12h |
| 13-14 | Peak 1 | 3x (threshold + endurance + race-pace) | 3x (long + threshold + tempo) | 3x (long + quality + easy) + brick | 12-14h |
| 15-16 | Peak 2 | 2x (threshold + endurance) | 3x (peak long + sweet spot + easy) | 3x (peak long + quality + easy) + brick | 12-14h |
| 17 | Recovery | 2x (easy) | 2x (easy) | 2x (easy) | 6-7h |
| 18-19 | Taper | 2x (race-pace touches) | 2x (short + race-pace) | 2x (short + race-pace) | 7-8h |
| 20 | Race | 1x (short shakeout) | 1x (short shakeout) | 1x (shakeout) | 3-4h |

### 24-Week Ironman Plan (Intermediate, 14-16h/week peak)

Similar structure with:
- Longer base phase (8 weeks)
- Longer peak rides (5-6h)
- Longer brick runs (60-90 min)
- 3-week taper instead of 10 days
- Nutrition rehearsal in every peak brick session

---

## Appendix B: Swim Workout Description Format

```
// Technique session
Warm up: 200m easy
Drill: 4x50m catch-up drill, 15s rest
Main: 6x100m @ 1:55/100m, 20s rest (focus: high elbow catch)
Cool down: 200m easy
Total: 1200m

// Threshold session  
Warm up: 300m easy
Main: 10x100m @ 1:40/100m (CSS), 15s rest
Cool down: 200m easy
Total: 1500m

// Endurance session
Warm up: 200m easy
Main: 3x400m @ 1:50/100m, 30s rest
Cool down: 200m easy
Total: 1600m
```

### Unit Display

- Swim distances: always in **metres** (not km). Display as "1500m", "200m", etc.
- Swim pace: always **per 100m**. Display as "1:40/100m".
- Bike distances: in **km** (or miles if unitPref === 'mi').
- Bike duration: in **hours and minutes**. Display as "2h30" or "90 min".
- Run: existing format (km and pace/km or miles and pace/mi).

---

## Appendix C: Key Numbers (To Be Confirmed)

**These are from research and coaching literature. Per CLAUDE.md, Tristan must confirm before they go into code.**

| Parameter | Value | Source |
|-----------|-------|--------|
| Volume split (swim/bike/run) | 15-20% / 45-50% / 30-35% | Coaching consensus; validated by race-time proportional analysis (Bentley et al., 2007) |
| Recovery week reduction | 30-40% | Mujika, 2009; coaching consensus |
| Weekly volume increase cap | 5-10% per discipline | 10% rule adapted; Gabbett, 2016 |
| ACWR safe range | 0.8 to 1.3 | Gabbett, 2016; debated (Zouhal et al., 2021) |
| 70.3 taper duration | 7 to 10 days | Bosquet et al., 2007; coaching consensus |
| Ironman taper duration | 2 to 3 weeks | Bosquet et al., 2007; Mujika, 2009 |
| 70.3 run fatigue discount | 4 to 6% slower than standalone | Bentley et al., 2007; Landers et al., 2008 |
| Ironman run fatigue discount | 10 to 12% slower than standalone | Bentley et al., 2007; Landers et al., 2008 |
| Swim TSS exponent | 3 (cubed IF, not squared) | Toussaint & Beek, 1992 (cubed water resistance); TrainingPeaks formula |
| Bike-run aerobic transfer | 0.75 (bike replacing run) | Millet et al., 2002 |
| Swim-run aerobic transfer | 0.30 (swim replacing run) | Millet & Vleck, 2000 |
| Brick detection time window | 30 min gap between activities | Proposed |
| CTL time constant | 42 days (same as running) | Banister et al., 1975; Coggan, 2003 |
| ATL time constant | 7 days (same as running) | Banister et al., 1975; Coggan, 2003 |
| Cycling LTHR offset vs running | -5 to -10 bpm | Millet & Vleck, 2000 |
| Swimming max HR offset vs running | -10 to -15 bpm | Millet & Vleck, 2000 |

---

## Appendix D: Glossary

| Term | Meaning |
|------|---------|
| **CSS** | Critical Swim Speed. Pace/100m at lactate threshold. Swim equivalent of FTP. |
| **FTP** | Functional Threshold Power. Max sustainable power (watts) for ~1 hour. Bike fitness benchmark. |
| **NP** | Normalized Power. Weighted average that accounts for variability in effort. |
| **IF** | Intensity Factor. NP/FTP (bike) or threshold pace/actual pace (run). 1.0 = threshold effort. |
| **TSS** | Training Stress Score. 100 = 1 hour at threshold. Comparable across disciplines when properly calculated. |
| **sTSS** | Swim TSS. Uses cubed IF (water resistance scales faster with speed). |
| **bTSS** | Bike TSS. Uses squared IF with Normalized Power. |
| **rTSS** | Run TSS. Uses squared IF with Normalized Graded Pace. |
| **hrTSS** | Heart Rate TSS. Fallback when no power/pace data. Less accurate for variable efforts. |
| **Brick** | Training in one discipline immediately followed by another. Almost always bike-to-run. |
| **T1** | Transition 1 (swim to bike). |
| **T2** | Transition 2 (bike to run). |
| **SWOLF** | Swim efficiency score: strokes per length + time per length. Lower is better. |
| **Sweet spot** | 88-95% FTP. High training stimulus with manageable fatigue. |
| **80/20** | Intensity distribution: 80% low intensity, 20% moderate-to-high. Evidence-backed for endurance sports (Seiler & Kjerland, 2006). |

---

## Appendix E: Bibliography

Allen, H., & Coggan, A. (2010). Training and Racing with a Power Meter. VeloPress. 2nd edition.

Atkinson, G., Peacock, O., & Passfield, L. (2007). Variable versus constant power strategies during cycling time-trials: prediction of time savings using an up-to-date mathematical model. Journal of Sports Sciences, 25(9), 1001-1009.

Banister, E. W., Calvert, T. W., Savage, M. V., & Bach, T. (1975). A systems model of training for athletic performance. Australian Journal of Sports Medicine, 7, 57-61.

Beattie, K., et al. (2023). Concurrent Strength and Endurance Training: A Systematic Review and Meta-Analysis on the Impact of Sex and Training Status. Sports Medicine. (PMC10933151).

Bentley, D. J., Cox, G. R., Green, D., & Laursen, P. B. (2007). Maximising performance in triathlon: applied physiological and nutritional aspects of elite and non-elite competitions. Journal of Science and Medicine in Sport, 11(4), 407-416.

Bernard, T., Vercruyssen, F., Grego, F., Hausswirth, C., Lepers, R., Vallier, J. M., & Brisswalter, J. (2003). Effect of cycling cadence on subsequent 3 km running performance in well-trained triathletes. British Journal of Sports Medicine, 37(2), 154-159.

Bosquet, L., Montpetit, J., Arvisais, D., & Mujika, I. (2007). Effects of tapering on performance: a meta-analysis. Medicine & Science in Sports & Exercise, 39(8), 1358-1365.

Busso, T. (2003). Variable dose-response relationship between exercise training and performance. Medicine & Science in Sports & Exercise, 35(7), 1188-1195.

Cadore, E. L., Izquierdo, M., Pinto, S. S., et al. (2012). Neuromuscular adaptations to concurrent training in the elderly: effects of intrasession exercise order. Age, 35(3), 891-903.

Coggan, A. (2003). Training and racing using a power meter: an introduction. Foundation of the TSS/NP/IF framework; widely cited.

Dekerle, J., Sidney, M., Hespel, J. M., & Pelayo, P. (2002). Validity and reliability of critical speed, critical stroke rate, and anaerobic capacity in relation to front crawl swimming performances. International Journal of Sports Medicine, 23(2), 93-98.

Etxebarria, N., Anson, J. M., Pyne, D. B., & Ferguson, R. A. (2014). Cycling attributes that enhance running performance after the cycle leg in triathlon. International Journal of Sports Physiology and Performance, 9(3), 502-509.

Gabbett, T. J. (2016). The training-injury prevention paradox: should athletes be training smarter and harder? British Journal of Sports Medicine, 50(5), 273-280.

Hausswirth, C., & Lehenaff, D. (2001). Physiological demands of running during long distance runs and triathlons. Sports Medicine, 31(9), 679-689.

Hue, O., Le Gallais, D., Chollet, D., Boussana, A., & Prefaut, C. (1998). The influence of prior cycling on biomechanical and cardiorespiratory response profiles during running in triathletes. European Journal of Applied Physiology, 77(1-2), 98-105.

Landers, G. J., Blanksby, B. A., Ackland, T. R., & Monson, R. (2008). Swim positioning and its influence on triathlon outcome. International Journal of Exercise Science, 1(3), 96-105.

Laursen, P. B., Knez, W. L., Shing, C. M., et al. (2005). Relationship between laboratory-measured variables and heart rate during an ultra-endurance triathlon. Journal of Sports Sciences, 23(10), 1111-1120.

Millet, G. P., & Vleck, V. E. (2000). Physiological and biomechanical adaptations to the cycle to run transition in Olympic triathlon: review and practical recommendations for training. British Journal of Sports Medicine, 34(5), 384-390.

Millet, G. P., Candau, R. B., Barbier, B., et al. (2002). Modelling the transfers of training effects on performance in elite triathletes. International Journal of Sports Medicine, 23(1), 55-63.

Molmen, K. S., Ofsteng, S., & Ronnestad, B. R. (2019). Block periodization of endurance training - a systematic review and meta-analysis. Open Access Journal of Sports Medicine. (PMC6802561).

Mujika, I. (2009). Tapering and Peaking for Optimal Performance. Human Kinetics.

Mujika, I., Padilla, S., Pyne, D., & Busso, T. (2004). Physiological changes associated with the pre-event taper in athletes. Sports Medicine, 34(13), 891-927.

Munoz, I., Seiler, S., Bautista, J., et al. (2014). Does polarized training improve performance in recreational runners? International Journal of Sports Physiology and Performance, 9(2), 265-272.

Piacentini, M. F., De Ioannon, G., Comotto, S., et al. (2013). Concurrent strength and endurance training effects on running economy in master endurance runners. Journal of Strength and Conditioning Research, 27(8), 2295-2303.

Ronnestad, B. R., Hansen, E. A., & Raastad, T. (2010). Effect of heavy strength training on thigh muscle cross-sectional area, performance determinants, and performance in well-trained cyclists. European Journal of Applied Physiology, 108(5), 965-975.

Ronnestad, B. R., Hansen, J., & Ellefsen, S. (2014). Block periodization of high-intensity aerobic intervals provides superior training effects in trained cyclists. Scandinavian Journal of Medicine & Science in Sports, 24(1), 34-42.

Schumann, M., Kuusmaa, M., Newton, R. U., et al. (2014). Fitness and lean mass increases during combined training independent of loading order. Medicine & Science in Sports & Exercise, 46(9), 1758-1768.

Seiler, K. S., & Kjerland, G. O. (2006). Quantifying training intensity distribution in elite endurance athletes: is there evidence for an "optimal" distribution? Scandinavian Journal of Medicine & Science in Sports, 16(1), 49-56.

Skiba, P. F., Chidnok, W., Vanhatalo, A., & Jones, A. M. (2006). Modelling the expenditure and reconstitution of work capacity above critical power. Medicine & Science in Sports & Exercise, 44(8), 1526-1532.

Stoggl, T. L., & Sperlich, B. (2014). Polarized training has greater impact on key endurance variables than threshold, high-intensity, or high-volume training. Frontiers in Physiology, 5, 33.

Suriano, R., & Bishop, D. (2010). Physiological attributes of triathletes. Journal of Science and Medicine in Sport, 13(3), 340-347.

Toussaint, H. M., & Beek, P. J. (1992). Biomechanics of competitive front crawl swimming. Sports Medicine, 13(1), 8-24.

Vleck, V. E., & Garbutt, G. (1998). Injury and training characteristics of male Elite, Development Squad, and Club triathletes. International Journal of Sports Medicine, 19(1), 38-42.

Wakayoshi, K., Ikuta, K., Yoshida, T., et al. (1992). Determination and validity of critical velocity as an index of swimming performance in the competitive swimmer. European Journal of Applied Physiology, 64(2), 153-157.

Wanivenhaus, F., Fox, A. J., Chaudhury, S., & Rodeo, S. A. (2012). Epidemiology of injuries and prevention strategies in competitive swimmers. Sports Health, 4(3), 246-251.

Wilson, J. M., et al. (2012). Concurrent training: a meta-analysis examining interference of aerobic and resistance exercises. Journal of Strength and Conditioning Research.

Zouhal, H., et al. (2021). Editorial: Acute:Chronic Workload Ratio: Is There Scientific Evidence? Frontiers in Physiology. (PMC8138569).

---

## 18. Locked Decisions (2026-04-23 spec review)

This section consolidates every decision reached in the spec-review session with Tristan. Where this section contradicts anything earlier in this doc, this section wins. Implementation should treat these as frozen unless revisited explicitly.

### 18.1 Architecture

- **Per-discipline CTL + combined CTL**. Track `ctlSwim`, `ctlBike`, `ctlRun` as independent 42-day EMAs. Combined CTL is a weighted sum derived from the per-discipline tracks.
- **Separate plan engine**: `plan_engine.triathlon.ts` (new file). Running engine (`plan_engine.ts`) stays untouched. Fork at the top-level generation call site based on `eventType`.
- **Power-optional**: onboarding asks whether the user has a power meter. If yes, ask for FTP. If no, bike TSS falls back to HR-based calculation (hrTSS). Same pattern as run (NGP-first, HR-fallback).
- **Brick detection window**: 30 minutes between the end of a bike activity and the start of a run activity.

### 18.2 Training model constants (blessed per CLAUDE.md "no made-up numbers" rule)

| Parameter | Value | Source |
|---|---|---|
| Swim TSS exponent | 3 (cubed IF) | Toussaint & Beek 1992; TrainingPeaks |
| CTL time constant | 42 days | Banister 1975 |
| ATL time constant | 7 days | Banister 1975 |
| 70.3 taper | 7 to 10 days | Bosquet 2007 meta-analysis |
| Ironman taper | 2 to 3 weeks | Bosquet 2007; Mujika 2009 |
| Volume split (recommended default) | 17.5% swim / 47.5% bike / 35% run | Midpoint of coaching consensus ranges. **User can adjust during onboarding** — split picker with the preset as default |
| Weekly volume cap per discipline | 10% | Gabbett 2016, upper bound of the 5–10% range |
| ACWR safe range | 0.8 to 1.3 | Gabbett 2016; matches running mode |
| 70.3 run fatigue discount (race prediction only) | 5% | Bentley 2007; Landers 2008 |
| IM run fatigue discount (race prediction only) | 11% | Bentley 2007; Landers 2008 |
| Cycling LTHR offset vs running LTHR | −7 bpm | Millet & Vleck 2000, midpoint of −5 to −10 |
| FTP detraining | 5–7% per 4 weeks off | Coyle 1984 |
| CSS detraining | 3–5% per 4 weeks off | Mujika 2010 — swim decays slower than bike/run due to technique retention |
| VDOT detraining | unchanged from current running mode | — |

Onboarding also collects a **time-available-per-week** input upstream of the split picker. Total weekly hours = time available. Per-discipline hours = total × split.

### 18.3 Transfer matrix (the multi-sport load model)

**Concept**: every activity contributes to its own discipline's CTL and ATL at 1.0, and to other disciplines' CTL and ATL at reduced weights. Transfers **add only** — they never subtract. The matrix replaces today's `runSpec` discount logic and generalises to all cross-training sports.

Directional contributions to each discipline's CTL/ATL (rows are *source activity*, columns are *destination discipline*):

| From ↓ / To → | Run | Bike | Swim |
|---|---|---|---|
| Run | 1.00 | 0.70 | 0.25 |
| Bike | 0.75 | 1.00 | 0.20 |
| Swim | 0.30 | 0.20 | 1.00 |
| Gym / strength | 0.10 | 0.10 | 0.10 |
| Padel / field sport | 0.35 | 0.20 | 0.00 |
| Ski touring / hiking | 0.55 | 0.40 | 0.00 |

**Key properties:**
- A 100 TSS padel session adds 35 TSS to running CTL and running ATL, 20 TSS to bike CTL/ATL, 0 to swim. Full 100 TSS lands on the combined CTL (Signal B).
- After any activity, readiness for any discipline is **worse** than before the activity (fatigue adds everywhere it transfers). The question is by how much relative to a dedicated session.
- Transfer values for padel/ski are proposals based on physiological overlap reasoning — validate and adjust after 3–6 months of multi-sport data.

### 18.4 Tracking vs Planning separation (foundational principle)

Promoted to `CLAUDE.md`. Some numbers apply only to one side of the line:
- **Tracking side**: 5% / 11% run-leg pace discount for race-time prediction. Transfer matrix values when analysing past training.
- **Planning side**: no training-load discount on brick runs (stimulus is full). Transfer matrix values when deciding whether missed-workout substitution is adequate.

When writing a new calculation, state explicitly which side of the line it sits on.

### 18.5 Replace-and-reduce flow extensions

The existing suggestion-modal pattern (Rules 1–5 in `suggestion-modal.ts` §8) is extended two ways for triathlon:
- **Per-discipline ACWR spikes**: if `swimACWR`, `bikeACWR`, or `runACWR` individually exceeds 1.3, the modal suggests dropping or downgrading a session in that discipline. User accepts or dismisses. No auto-apply.
- **Cross-discipline aggregate spikes**: if combined ATL is red AND the load is driven by non-plan activities (padel, gym, ski), the modal can suggest reducing a planned run or bike session to compensate. This closes the loop with the transfer matrix — high external load cascades into plan reduction via the suggestion flow.

### 18.6 Injury engine → discipline shift

When an injury is logged, the plan engine reallocates volume away from the restricted discipline and onto the others, preserving combined aerobic load:
- Runner's knee → run drops to injury protocol → bike + swim volume increases proportionally.
- Swimmer's shoulder → swim ↓ → run + bike ↑.
- Cyclist's knee (IT band) → bike ↓ → run + swim ↑.

The existing injury phase progression (rest → easy → hard) is preserved per-discipline. The new behaviour is the cross-discipline compensation, which prevents a triathlete from losing all aerobic fitness during a single-discipline injury.

### 18.7 Triathlete self-rating (replaces `s.typ` for triathlon users)

Onboarding shows three 1–5 sliders at the equivalent of the runner-type step:

> How strong do you feel in the swim? (1 = weakest, 5 = strongest)
> How strong do you feel on the bike?
> How strong do you feel in the run?

Translation into the plan engine:
- Low-scoring disciplines (1–2) receive proportionally more volume and more technique/fundamentals sessions.
- High-scoring disciplines (4–5) receive maintenance volume + polish intervals.
- The total hours envelope is fixed by the time-available input; the sliders only redistribute across disciplines.

### 18.8 UX

- **Discipline colours**: swim muted teal (`#5b8a8a`), bike warm clay (`#c08460`), run existing olive/sage. All sit in the existing nature palette.
- **Two-a-day display**: stacked discipline cards inside a single day container. No AM/PM header labels.
- **Race prediction**: headline total time, expandable into per-leg breakdown (swim, T1, bike, T2, run). Confidence band (±range) shown on total. Sprint + Olympic times shown as free side-effects when engine has CSS + FTP + VDOT. Targets (pace/power per leg) **editable** on the stats page — stored as `userTargets.{swim,bike,run}` overriding model output.
- **Plan adherence display**: headline "Overall X%", expandable to per-discipline breakdown.
- **Stats fitness chart**: default combined CTL + total TSS, toggle to three-line per-discipline view.
- **Two-a-day display**: stacked cards (not AM/PM).

### 18.9 Wizard

- **Per-discipline experience sliders** at onboarding (three, 1–5 each).
- **Bike commute** in scope for v1. Swim commute out of scope.
- **Unit formatting**: swim metres, bike km/mi + watts (if power meter), run unchanged.
- **Express onboarding path** in scope for v1: if Strava shows 8+ weeks of multi-sport activity history, offer a "use my history" flow that skips the manual per-discipline fitness step and pre-populates CSS / FTP / running PBs from detected activity data.

### 18.10 Scope

- **Triathlon is always race-mode**. No "general fitness triathlon". Users always target a specific 70.3 or IM event.
- **Sprint + Olympic distances**: not first-class race targets in v1 (target picker shows 70.3 and IM only). Predicted sprint/Olympic times appear as informational side-effects on the prediction page.
- **Nutrition tracking**: out of scope.
- **T1 / T2 practice sessions**: included as description notes on race-week sessions, not as their own workout types.
- **Open-water vs pool swim**: single workout type, user preference toggle re-labels sessions. Not two separate types.
- **Sport-specific injury protocols** (swimmer's shoulder progression, etc.): deferred to v2. v1 uses the generic injury progression extended with discipline-shift behaviour (§18.6).
- **Guided runs / voice cues for bike and swim**: deferred to v2. v1 keeps guided-run support running-only.
- **Skipped workout logic** (push to next week, drop on second skip): applies **per-discipline**. Missing a swim does not affect running schedule logic.

### 18.11 Deferred for later

- Block periodisation (Ronnestad 2014) — emphasis cycling, post-v1.
- Brick run fatigue discount on training load (currently no discount — §18.4). Revisit after real brick data exists.
- Per-discipline ACWR auto-downgrade (currently flag + suggest only — §18.5).
- CTL weighting for injury risk (bike and swim are non-impact; today's impact load stays run-only).
- Cross-sport transfer matrix values for padel / ski — treat as first approximations, validate with 3–6 months of data.

