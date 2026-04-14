# Ultra / Trail Mode: Architecture and Implementation Plan

> Extending Mosaic from a marathon training simulator to support ultra marathon and trail running plans.

**Status**: Planning (not yet implemented)
**Target distances**: 50K, 50M, 100K, 100M, 200M+
**Target profiles**: Flat ultra, rolling trail, mountain ultra, technical trail
**Design principle**: Same adaptive engine, same UX patterns. Time-on-feet and vertical gain as first-class metrics alongside distance.

---

## Table of Contents

1. [Race Profiles](#1-race-profiles)
2. [Training Methodology](#2-training-methodology)
3. [Metrics and Load Model](#3-metrics-and-load-model)
4. [Architecture: What Changes, What Stays](#4-architecture-what-changes-what-stays)
5. [State Schema Changes](#5-state-schema-changes)
6. [New Types](#6-new-types)
7. [Plan Engine: Ultra Generation](#7-plan-engine-ultra-generation)
8. [Workout Library](#8-workout-library)
9. [Scheduler: Ultra Week Layout](#9-scheduler-ultra-week-layout)
10. [Fitness Model: Ultra-Specific Tracking](#10-fitness-model-ultra-specific-tracking)
11. [Activity Sync and Matching](#11-activity-sync-and-matching)
12. [Wizard / Onboarding](#12-wizard--onboarding)
13. [UI Changes](#13-ui-changes)
14. [Nutrition Engine](#14-nutrition-engine)
15. [Sleep Management and Race-Night Strategy](#15-sleep-management-and-race-night-strategy)
16. [Mental Training](#16-mental-training)
17. [Cross-Training for Ultra](#17-cross-training-for-ultra)
18. [Fat Adaptation and Metabolic Efficiency](#18-fat-adaptation-and-metabolic-efficiency)
19. [Crew, Pacers, and Drop Bags](#19-crew-pacers-and-drop-bags)
20. [Hydration Logistics](#20-hydration-logistics)
21. [Gear and Equipment](#21-gear-and-equipment)
22. [Altitude and Heat Protocols](#22-altitude-and-heat-protocols)
23. [Recovery and Season Planning](#23-recovery-and-season-planning)
24. [Integration Deep Dive](#24-integration-deep-dive)
25. [Rollout Plan](#25-rollout-plan)
26. [Open Questions](#26-open-questions)

---

## 1. Race Profiles

### Distances

| Category | Distance | Typical Winning Time | Mid-Pack Time | Cut-off |
|----------|----------|---------------------|---------------|---------|
| **50K** | 50 km / 31 mi | 3:00 to 3:30 | 5:30 to 7:00 | 8 to 10h |
| **50M** | 80.5 km / 50 mi | 5:30 to 6:30 | 9:00 to 12:00 | 13 to 16h |
| **100K** | 100 km / 62 mi | 6:30 to 8:00 | 11:00 to 16:00 | 16 to 24h |
| **100M** | 161 km / 100 mi | 14:00 to 16:00 | 24:00 to 30:00 | 30 to 36h |
| **200M+** | 200+ mi | 45:00 to 55:00 | 70:00 to 90:00 | 90 to 108h |

### Race Profile Types

**Flat Ultra** (e.g. Comrades, Spartathlon, Javelina Jundred)
- Elevation gain typically < 100m D+ per 10km
- More road-running transferable. Pacing is closer to marathon pacing extrapolated.
- Speed and sustained aerobic power matter more than climbing ability.
- Examples: Comrades (~1,500m D+ over 87km), Spartathlon (~1,200m over 246km)

**Rolling Trail Ultra** (e.g. Western States, Ultra-Trail Australia)
- 15 to 40m D+ per km
- Mix of runnable terrain with climbs. Hiking is strategic, not mandatory.
- Western States: 5,500m D+ / 7,000m D- over 161km
- UTA 100: ~4,400m D+ over 100km

**Mountain Ultra** (e.g. UTMB, Lavaredo, Hardrock)
- 40 to 70m D+ per km
- Significant above-treeline exposure, technical terrain, mandatory gear.
- UTMB: ~10,000m D+ over 171km (effectively 250km flat equivalent effort)
- Hardrock: ~10,200m D+ over 161km, average altitude 3,400m, highest point 4,282m
- Lavaredo Ultra Trail: ~5,800m D+ over 120km in the Dolomites

**Technical Trail** (e.g. Hardrock, Tor des Geants)
- Significant scrambling, exposed ridges, river crossings
- Pace is dictated by terrain, not fitness alone
- Tor des Geants: 330km, ~24,000m D+, continuous with sleep management

### Reference Races

| Race | Distance | D+ | Cut-off | Notes |
|------|----------|-----|---------|-------|
| UTMB | 171km | ~10,000m | 46:30 | The "championship" mountain ultra |
| Western States | 161km | 5,500m | 30:00 | Oldest 100-miler, hot canyons |
| Leadville 100 | 161km | 4,800m | 30:00 | Altitude (3,000 to 3,800m throughout) |
| Hardrock 100 | 161km | 10,200m | 48:00 | Most technical major 100 |
| Comrades | 87km | ~1,500m | 12:00 | World's largest ultra, road |
| Lavaredo Ultra Trail | 120km | 5,800m | 30:00 | Dolomites, technical |
| Ultra-Trail Australia | 100km | 4,400m | 28:00 | Blue Mountains |
| Tor des Geants | 330km | 24,000m | 150:00 | Multi-day mountain ultra |
| Barkley Marathons | ~210km | ~18,000m | 60:00 | Off-trail, navigation, <1% finish rate |
| Spartathlon | 246km | minimal | 36:00 | Athens to Sparta, road/flat |

### Vert-to-Distance Ratio (Planning Metric)

Used to classify a race and set training vert targets.

| Race Type | D+ per km | Example |
|-----------|-----------|---------|
| Flat ultra | 0 to 15 m/km | Comrades: ~17 m/km |
| Rolling trail | 15 to 40 m/km | Western States: ~34 m/km |
| Mountain ultra | 40 to 70 m/km | UTMB: ~58 m/km |
| Steep mountain | 70 to 100+ m/km | Hardrock: ~63 m/km |
| Vertical race | 150+ m/km | VK races |

### Cut-off Pacing Implications

Cut-offs force a fundamentally different pacing strategy than road races.

A 30-hour 100-miler cut-off means:
- Average pace must stay under ~11:10 min/km including all aid station time
- Aid station time budget: typically 5 to 10% of total time (1.5 to 3 hours)
- Plan to hike everything above 10 to 15% grade, run flats and descents
- Controlled positive split is expected. Negative split is almost never the strategy.
- "Bank time" on early runnable sections to allow for slowing in later miles

---

## 2. Training Methodology

### 2.1 Coaching Philosophies (Comparative)

The ultra training world has several distinct schools of thought. The app should draw from all of them, weighted by athlete profile.

**Jason Koop (Training Essentials for Ultrarunning)**
- Classic linear periodisation adapted for ultras: Base, Tempo/Threshold, VO2max, Race-Specific
- Every run has a purpose. Opposes "junk miles."
- Challenges the pure 80/20 model for ultras. Argues that ultra-specific intensity is at or below lactate threshold, so tempo is the primary quality session.
- Moderate volume. A 100-miler athlete might peak at 100 to 130 km/week.
- Criticism: Too road-influenced. Does not sufficiently prioritise time on feet or vert.

**Kilian Jornet's Approach**
- Massive vertical volume: 1,000 to 2,000m D+ per day in base training.
- Low-intensity dominance: 85 to 90% Zone 1 to 2.
- Ski mountaineering cross-training in winter builds identical muscle groups with less impact.
- Minimal structured intervals. Speed comes from terrain, not track sessions.
- 25 to 35 hours/week in peak phases (professional territory).
- Principle that scales down to amateurs: vert-heavy, terrain-specific. The volume does not scale.

**David Roche (SWAP Running)**
- "Happy athlete" principle: consistency matters more than any single workout.
- 3-week build / 1-week recovery cycles.
- Short speed work (strides, hill sprints) maintained year-round, even in ultra base phases. Neuromuscular power protects against ultra shuffling.
- Moderate long runs frequently (every weekend) rather than monster long runs occasionally. Prefers 2:30 to 3:30 most weeks with occasional 4 to 5 hour efforts.
- Back-to-backs as a regular feature, but the Sunday run is shorter and easier.
- Frequent racing. B races are training tools.
- Volume: 80 to 110 km/week for amateurs.

**Jeff Browning (100-Mile Specialist)**
- Time-on-feet focus. Peak weeks 15 to 20 hours.
- Back-to-back-to-back weekends: sometimes three consecutive days of long efforts in peak training.
- Night running integration in final 6 to 8 weeks.
- Structured uphill hiking sessions with target heart rate and vertical rate.
- Heavy emphasis on eccentric quad loading for downhill.
- Aid station simulation in long runs.

**Hal Koerner (Field Guide to Ultrarunning)**
- Three-tier system: Beginner, Intermediate, Advanced.
- The long run is the single most important workout.
- Gradual time-on-feet progression: increases long run duration by 15 to 20 min per week, cutback every 3 to 4 weeks.
- Cross-training counts. Not everything needs to be running.
- 50K plan peaks at 65 to 80 km/week, 100M plan peaks at 110 to 145 km/week.

**Uphill Athlete (Steve House / Scott Johnston)**
- Extremely long base-building periods (12 to 24 weeks).
- AeT (Aerobic Threshold) as primary metric. If AeT is more than 10% below AnT, the athlete needs more base before intensity.
- Programmes weekly vert, not distance. A week might be prescribed as "3,000m D+ in Zone 1 to 2."
- Structured max strength work (heavy, low-rep) maintained through base, then transitioned to muscular endurance.

### 2.2 What Existing Apps Get Wrong

This is the core differentiator for Mosaic Ultra mode.

1. **Too road-focused.** Most app plans are marathon plans stretched to more weeks with longer long runs. No terrain specificity.
2. **No vertical programming.** Ultra training must programme weekly D+ as a first-class metric. Apps that ignore this produce athletes who can run 100km flat but collapse on 2,000m of climbing.
3. **No time-on-feet focus.** A 30km trail run with 1,500m D+ takes 4 to 5 hours. A 30km road run takes 2.5 to 3 hours. Plans should prescribe duration, not distance, for trail.
4. **No hiking power training.** In mountain ultras, the fastest athletes are the fastest hikers. Power hiking is a distinct skill. No app programmes hiking sessions.
5. **No terrain specificity.** Running on technical single-track uses different muscles and skills than road. Proprioception, ankle stability, downhill technique are trainable.
6. **No nutrition training.** Ultra fuelling is a skill. Plans should include "nutrition rehearsal" runs.
7. **No back-to-back programming.** The back-to-back long run is the cornerstone ultra workout.
8. **No night running.** 100-milers involve running through the night. This must be practised.
9. **No pack running.** Mountain ultras require mandatory gear (1 to 3kg pack). Training should include pack runs.
10. **Recovery modelling too aggressive.** Standard 48-hour recovery models underestimate the muscular stress of vert and technical terrain.

### 2.3 Periodisation

Ultra periodisation differs from marathon in several ways: longer base, back-to-back long runs as the key workout, time-on-feet as the primary metric, and shorter tapers for some distances.

| Phase | Focus | Intensity Distribution |
|-------|-------|----------------------|
| **Base** | Aerobic threshold development, general strength, movement quality, vert introduction | 85 to 90% Zone 1 to 2 |
| **Build** | Race-specific fitness, terrain adaptation, vert capacity, back-to-backs begin | 80 to 85% Zone 1 to 2, introduce threshold |
| **Peak** | Race simulation, nutrition practice, night running, longest back-to-backs | Peak volume, 80/20 |
| **Taper** | Fatigue clearance, maintaining top-end fitness, mental prep | Volume drops 30 to 50%, short sharp sessions maintained |

### 2.4 Phase Durations

| Race | Base | Build | Peak | Taper | Total |
|------|------|-------|------|-------|-------|
| 50K (first timer) | 6 to 8w | 4 to 6w | 2 to 3w | 1 to 2w | 16 to 20w |
| 50K (experienced) | 4 to 6w | 3 to 5w | 2 to 3w | 1w | 12 to 16w |
| 100K | 6 to 8w | 5 to 7w | 3 to 4w | 2w | 20 to 24w |
| 100M (first timer) | 8 to 12w | 6 to 8w | 3 to 5w | 2 to 3w | 24 to 30w |
| 100M (experienced) | 6 to 8w | 5 to 7w | 3 to 4w | 2w | 20 to 24w |
| UTMB-type mountain | 10 to 14w | 6 to 8w | 4 to 5w | 2 to 3w | 28 to 36w |

### 2.5 Volume Targets (Weekly Peak, Competitive Amateur)

| Race | Distance/Week | Hours/Week | D+/Week |
|------|--------------|-----------|---------|
| 50K flat | 70 to 100 km | 7 to 10h | 500 to 1,500m |
| 50K mountain | 60 to 90 km | 8 to 12h | 1,500 to 3,000m |
| 100K flat | 90 to 130 km | 10 to 14h | 1,000 to 2,000m |
| 100K mountain | 80 to 120 km | 12 to 16h | 2,500 to 5,000m |
| 100M flat | 110 to 150 km | 12 to 18h | 1,500 to 3,000m |
| 100M mountain | 90 to 140 km | 15 to 22h | 4,000 to 8,000m |

### 2.6 Volume Progression

- Base: start at 60 to 70% of target peak volume
- Build: progress to 80 to 100% of peak
- Peak: 100% of peak volume (2 to 3 biggest weeks)
- Taper: see Section 2.10
- Weekly increase limit: 5 to 10% per week (both distance and vert independently)

### 2.7 Build:Recovery Week Ratios

- Standard: 3:1 (3 build weeks, 1 recovery week)
- Conservative (beginner or injury-prone): 2:1
- Aggressive (experienced, good recovery): 4:1
- Recovery week: 50 to 60% of preceding build week volume, maintain 1 quality session

### 2.8 Back-to-Back Long Runs

The single most important ultra-specific workout. Purpose:

1. Simulates racing on tired legs. The Sunday run teaches the body to perform when glycogen-depleted and muscle-damaged.
2. Trains fuelling under fatigue.
3. Builds mental resilience.
4. Reduces injury risk vs a single mega-long run. Two 3-hour runs on consecutive days creates similar adaptation to one 5-hour run with less acute injury risk.

**Scheduling:**
- Introduce 12 to 16 weeks before a 100K/100M race
- Frequency: Every 2 to 3 weeks during Build and Peak phases
- Structure: Saturday = long (70 to 80% of total weekend volume), Sunday = moderate (20 to 30%)
- Recovery week after every back-to-back weekend

**Volume by distance:**

| Race | Saturday | Sunday | Weekend Total |
|------|----------|--------|---------------|
| 50K | 2.5 to 3.5h | 1.5 to 2.5h | 4 to 6h |
| 100K | 3.5 to 5h | 2 to 3h | 6 to 8h |
| 100M | 4 to 6h | 2.5 to 4h | 7 to 10h |

### 2.9 Time on Feet vs Distance

A 30km run on technical mountain trail with 1,500m D+ takes 4 to 5 hours. A 30km road run takes 2.5 to 3 hours. The physiological stress correlates with time, not distance. Glycogen depletion, muscular fatigue, and metabolic stress are time-dependent.

**Programming implication:**
- Long runs prescribed in hours, not kilometres
- Weekly volume tracks distance, time, and vert (three metrics, not one)
- A "3-hour long run" on trails might be 20km. On road, 30km. Both are equally valid.

### 2.10 Taper

Ultra tapers are often shorter than marathon tapers because:
1. Ultra athletes carry more chronic fatigue, so even modest cutting feels dramatic
2. Muscular fitness for climbing/descending decays faster than aerobic fitness
3. Mountain-specific strength has a higher detraining risk with long tapers

| Distance | Taper Duration | Last Big Weekend | Last Hard Session |
|----------|---------------|-----------------|-------------------|
| 50K | 7 to 10 days | 2 weeks out | 10 days out |
| 50M | 10 to 14 days | 2 to 3 weeks out | 12 days out |
| 100K | 10 to 14 days | 2 to 3 weeks out | 12 days out |
| 100M | 14 to 21 days | 3 weeks out | 14 days out |
| 200M | 14 to 21 days | 3 to 4 weeks out | 14 to 18 days out |

**100M taper structure (3-week example):**

| Week | Volume | Key Sessions |
|------|--------|-------------|
| 3 weeks out | 70% of peak | Last back-to-back (shortened: 3h Sat / 1.5h Sun). One tempo session. Last mountain long run with full gear. |
| 2 weeks out | 50% of peak | Easy runs with short hill strides (6 to 8 x 20 seconds). One moderate trail run (1.5 to 2h) with race nutrition practice. Everything in race shoes. |
| Race week | 25 to 30% of peak | Mon/Tue 30 to 45 min easy. Wed/Thu 20 to 30 min with 4 to 6 strides. Fri rest or 15 min shakeout. |

### 2.11 Common Training Mistakes

These inform the adaptive engine's guardrails:

1. **Over-reliance on long slow runs.** Without intensity, aerobic ceiling stagnates. Fix: 1 to 2 quality sessions per week.
2. **Ignoring speed work.** Higher VO2max means lower relative intensity at ultra pace, which means better fat oxidation. Fix: weekly strides at minimum, 10 to 15% of training time at or above threshold.
3. **Not enough vert-specific training.** Climbing and descending use different muscle recruitment, different energy systems, different skills. Fix: programme weekly D+ targets.
4. **Training distance not time on feet.** Fix: programme in hours. Track both distance and time. Surface the ratio.
5. **Not practising nutrition.** GI distress is the #1 DNF reason in ultras. Fix: practice race nutrition in every long run for final 10 to 12 weeks.
6. **Ignoring strength training.** Quad failure from eccentric loading is the #1 physical limiter in mountain ultras. Fix: 2 strength sessions/week in base, 1 to 2/week in build, 1/week in peak.
7. **Going too hard in training races.** Destroys the training plan. Fix: B races at 80 to 85% effort, C races at 70 to 75%.
8. **No night running practice.** Fix: dedicated night runs 6 to 8 weeks before any race involving darkness.

---

## 3. Metrics and Load Model

### 3.1 Why TSS Alone Fails for Ultras

Standard TSS was designed for cycling and adapted for running using pace or heart rate as intensity factor. Five problems for ultras:

1. **Hiking is invisible.** TSS based on pace penalises hiking (very low pace = very low IF). But power hiking at Zone 3 heart rate on a 20% grade is genuinely hard training.
2. **Vertical load is uncaptured.** A 20km flat run and a 20km mountain run with 1,500m D+ might have similar hrTSS if heart rates are similar, but the muscular cost is vastly different.
3. **Eccentric stress is invisible.** Downhill running causes enormous muscular damage that does not register in heart rate or pace-based metrics.
4. **Time-based fatigue is non-linear.** The physiological cost of hour 5 is not proportional to hour 1. Glycogen depletion, core temperature accumulation, and muscular damage accelerate in later hours.
5. **Technical terrain cost.** Running on technical single-track requires constant proprioceptive engagement that does not appear in any metric.

### 3.2 Ultra Load Model: Three Signals

Extend the existing three-signal model with vert-awareness.

| Signal | Current (Marathon) | Ultra Adaptation |
|--------|-------------------|-----------------|
| **Signal A** (run-equiv, runSpec-discounted) | Running Fitness CTL, race prediction | Unchanged for flat ultras. For mountain ultras, add vert-adjusted component. |
| **Signal B** (raw physiological, no discount) | ACWR, Total Load, Freshness | Add vert-derived muscular load component. |
| **Signal C** (impact load) | Day-before injury risk | Add eccentric descent load as a distinct sub-signal. |
| **Signal D** (new: vert fitness) | N/A | Cumulative vertical fitness. Separate CTL track for climbing ability. |

### 3.3 Elevation-Adjusted TSS

**Recommended approach: Vert-adjusted multiplier on hrTSS.**

```
vertFactor = (D_plus + D_minus * 0.5) / (distance_km * 100)
adjustedTSS = hrTSS * (1 + vertFactor)
```

Rationale: ascent adds cardiovascular cost (captured partly by HR), descent adds muscular cost (at ~50% weighting because it is eccentrically expensive but cardiovascularly cheap).

**Alternative (with Stryd power data):**
Running power directly accounts for grade. TSS from power is inherently elevation-adjusted. Limitation: still does not capture eccentric loading from descent.

**Alternative (composite score):**
```
ultraLoad = hrTSS + (D_plus * ascentFactor) + (D_minus * descentFactor) + (techMinutes * techFactor)
```
Requires terrain classification which GPS + elevation data can approximate.

**Decision needed from Tristan**: Which approach to implement first. Vert-adjusted multiplier is simplest and needs no new hardware.

### 3.4 Muscular Stress vs Cardiovascular Stress

| Metric | Measures | Captures |
|--------|----------|----------|
| Heart rate / hrTSS | Cardiovascular load | Aerobic demand, climbing effort |
| Pace / pTSS | Locomotive cost | Running speed, flat efficiency |
| Vert (D+ / D-) | Muscular loading | Concentric (up) and eccentric (down) |
| Duration | Time-dependent fatigue | Glycogen, core temp, cumulative damage |

Key insight: cardiovascular recovery (24 to 48h) is faster than muscular recovery from heavy vert (48 to 96h). The recovery model must factor both signals independently.

### 3.5 Hiking Load in the Load System

- **Cardiovascular cost:** Heart rate during hiking is typically Zone 2 to 3 on steep terrain. hrTSS captures this reasonably well.
- **Muscular cost (ascent):** Concentric quad/glute work. Lower impact than running but sustained. ~0.6 to 0.8x the muscular cost of running per minute at similar heart rate.
- **Muscular cost (descent):** Eccentric quad loading. 0.5 to 0.7x the cardiovascular cost but 1.2 to 1.5x the muscular damage cost of flat running per minute.
- **runSpec for hiking:** 0.4 to 0.6 depending on grade and pack weight. Lower than running (1.0) because impact load is lower, higher than walking (0.3 to 0.4) because grade makes it genuinely demanding.

### 3.6 Longer CTL/ATL Windows

Standard Banister model: CTL 42-day, ATL 7-day.

For ultra athletes, several coaches argue for longer windows:
- CTL: 60 to 90 days (ultra fitness builds slowly and persists longer)
- ATL: 10 to 14 days (fatigue from vert accumulates longer than flat running)
- Rationale: A marathoner's fitness can peak in 12 to 16 weeks. An ultra runner's mountain fitness takes 6 to 12 months to fully develop.

**Recommendation:** Add a separate vert-CTL that tracks cumulative vertical fitness with a 60-day time constant. Keep the existing run CTL (42-day) for aerobic fitness. Combined freshness uses the longer ATL window (10 to 14 days) when `ultraMode` is active.

**Decision needed from Tristan**: Exact time constants for ultra CTL/ATL. The above ranges come from coaching literature but need calibration.

### 3.7 Time on Feet as a Tracked Metric

Weekly time on feet (total training duration) with targets by race distance:

| Race | Peak Weekly Hours |
|------|------------------|
| 50K | 8 to 12h |
| 100K | 12 to 16h |
| 100M | 15 to 22h |

Surface time progression alongside distance progression. Alert when time and distance diverge significantly (indicates more trail/vert work or less efficient terrain).

### 3.8 Key Metrics to Track (Beyond Standard Running)

1. **Weekly D+ (metres)** - first-class metric alongside distance and time
2. **Weekly D- (metres)** - eccentric loading indicator
3. **Time on feet (hours)** - primary endurance metric
4. **Longest session duration (hours)** - peak muscular endurance
5. **Back-to-back weekend volume (hours)** - ultra-specific readiness
6. **Vert rate on climbs (m/hr)** - hiking power progress (VAM)
7. **Descent pace (min/km on downhill)** - technical skill indicator
8. **Nutrition intake rate (cal/hr during long runs)** - fuelling competency
9. **Night running hours** - darkness readiness
10. **Pack-weighted sessions** - gear readiness

### 3.9 Vertical Ascent Rate (VAM) Benchmarks

| Level | VAM (m/hr) |
|-------|-----------|
| Beginner | 300 to 400 |
| Recreational | 400 to 600 |
| Competitive | 600 to 800 |
| Elite | 800 to 1,200 |
| Kilian Jornet racing | 1,400 to 1,800 |

### 3.10 ITRA Performance Index

The International Trail Running Association rates athletes. Useful as tier classification.

| ITRA Score | Level |
|------------|-------|
| < 300 | Finisher (near cut-off) |
| 300 to 400 | Recreational (mid-pack) |
| 400 to 500 | Competitive (top 25 to 40%) |
| 500 to 600 | National level (top 10%) |
| 600 to 700 | International level (top 5%) |
| 700 to 800 | Elite (top 1%) |
| 800+ | World class |

### 3.11 Equivalent Flat Distance (Naismith's Rule, Modified)

Used for race prediction and effort estimation:
- Add 1 minute per 10m ascent to flat pace time
- Add 1 minute per 20m descent (non-technical)
- 1km with 100m D+ is approximately 2.0 to 2.5 km flat equivalent
- UTMB's 171km with 10,000m D+ is approximately 250 to 280 km flat equivalent

---

## 4. Architecture: What Changes, What Stays

### 4.1 Fully Reusable (No Changes)

| System | Why It Works |
|--------|-------------|
| **Recovery engine** | Sleep/HRV/readiness scoring is physiology-agnostic |
| **Injury system** | Six-phase progression works for any sport (would need trail-specific protocols later) |
| **Gym integration** | Phase-aware strength templates apply equally (ultra adds eccentric emphasis) |
| **State management** | updateState/saveState/loadState pattern scales |
| **GPS tracking** | Already tracks any movement. GPS elevation data is already captured. |
| **Activity sync pipeline** | Already handles running from Strava. `GarminPendingItem` has elevation data. |
| **Physiology sync** | Garmin/Apple biometrics (HRV, sleep, resting HR) are sport-agnostic |
| **Cross-training engine** | Still useful for non-running activities (cycling, swimming, etc.) |

### 4.2 Needs Modification

| System | Current State | What Changes | Effort |
|--------|--------------|-------------|--------|
| **Plan engine** (`plan_engine.ts`) | Generates running sessions by pace/distance | Add time-on-feet sessions, vert targets, back-to-backs, power hike sessions, night runs | HIGH |
| **Workout generation** (`generator.ts`) | Running workouts with pace targets | New ultra workout types: vert intervals, power hike, technical trail, back-to-back, fatigue run | HIGH |
| **Scheduler** (`scheduler.ts`) | Long run Sunday, quality Tue/Thu | Back-to-back weekends, night run placement, pack run scheduling | MEDIUM |
| **Fitness model** (`fitness-model.ts`) | Single CTL/ATL/TSB track, 42/7-day windows | Add vert-CTL, extend ATL window for ultra, elevation-adjusted TSS | MEDIUM |
| **Load calculation** (`load.ts`) | Pace-based and HR-based TSS | Add vert-adjusted TSS multiplier, hiking load model | MEDIUM |
| **Wizard / onboarding** | Race distance limited to 5k through marathon | Add ultra distances, race profile selection, vert availability | MEDIUM |
| **Types** (`state.ts`) | `RaceDistance` = '5k' through 'marathon' | Add ultra distances, race profile type, vert tracking fields | MEDIUM |
| **UI: Home/Plan views** | Distance-focused workout cards | Add vert targets, time-on-feet display, back-to-back visual grouping | MEDIUM |
| **Activity matcher** | Matches by day + distance + type | Add vert matching, time-on-feet matching, back-to-back detection | LOW |
| **VDOT / race prediction** | Road-based VDOT from PBs | Add elevation-adjusted race prediction using Naismith's equivalent | LOW |

### 4.3 Risk Assessment

**Highest risk:** Plan engine. The ultra plan engine has fundamentally different session types (power hike, back-to-back, vert intervals, night runs) that don't exist in the running plan.

**Mitigation:** Branch by `eventType` early. Running-only users never touch the new code paths. Ultra plan engine is a new module (`plan_engine.ultra.ts`) that calls into shared utilities (deload detection, ability band, effort multiplier).

**Second risk:** Load model. The vert-adjusted TSS multiplier changes how ACWR, freshness, and planned load are calculated. Must be isolated behind the `ultraMode` flag so marathon users are unaffected.

---

## 5. State Schema Changes

### 5.1 New Top-Level Fields on SimulatorState

```typescript
// Event type extension
eventType?: 'running' | 'ultra' | 'triathlon';  // undefined = running (backward compat)

// Ultra-specific config (only present when eventType === 'ultra')
ultraConfig?: {
  distance: '50k' | '50m' | '100k' | '100m' | '200m';
  
  // Race profile
  raceProfile: 'flat' | 'rolling' | 'mountain' | 'technical';
  raceDPlus?: number;      // metres of total elevation gain
  raceDMinus?: number;     // metres of total elevation loss
  raceAltitudeMax?: number; // metres, highest point
  
  // Terrain availability (affects workout generation)
  terrainAccess: 'flat_only' | 'some_hills' | 'mountain_access' | 'lives_in_mountains';
  hasTrailAccess: boolean;
  
  // Vert fitness tracking
  vertCTL?: number;         // 60-day EMA of weekly D+
  vertATL?: number;         // 14-day EMA of weekly D+
  weeklyDPlus?: number[];   // rolling history of weekly D+ (metres)
  weeklyDMinus?: number[];  // rolling history of weekly D-
  weeklyTimeOnFeet?: number[]; // rolling history (minutes)
  
  // Ultra-specific preferences
  usePoles?: boolean;
  hasMandatoryGear?: boolean;
  nightRunningRequired?: boolean; // true for 100M+
  
  // Nutrition tracking
  nutritionTargetCalPerHr?: number;
  nutritionPracticed?: boolean;   // has the user done nutrition rehearsal runs
  
  // Experience
  ultraExperience: 'first_ultra' | 'done_50k' | 'done_100k' | 'done_100m' | 'experienced';
  longestRaceKm?: number;
  longestRaceTime?: number;     // seconds
  
  // Power hiking
  estimatedVAM?: number;         // m/hr on climbs
  
  // Season planning
  raceType: 'a_race' | 'b_race' | 'c_race';
};
```

### 5.2 Workout Type Extension

```typescript
// Add ultra-specific fields to Workout interface
export interface Workout {
  // ... existing fields ...
  
  // Ultra-specific
  targetDPlus?: number;          // metres of elevation gain target
  targetDMinus?: number;         // metres of descent target
  targetDurationMin?: number;    // time-on-feet target (minutes)
  isBackToBack?: boolean;        // part of a back-to-back weekend
  backToBackDay?: 'saturday' | 'sunday'; // which day of the B2B
  isNightRun?: boolean;
  isPackRun?: boolean;           // run with mandatory gear
  nutritionPractice?: boolean;   // nutrition rehearsal session
  isPowerHike?: boolean;         // hiking-specific session
  vertIntervals?: {              // for vert interval workouts
    reps: number;
    climbMetres: number;
    grade: string;               // e.g. "10 to 15%"
  };
}
```

### 5.3 Race Distance Extension

```typescript
export type UltraDistance = '50k' | '50m' | '100k' | '100m' | '200m';
export type RaceProfile = 'flat' | 'rolling' | 'mountain' | 'technical';

// RaceDistance stays as-is for backward compat
// UltraDistance is used when eventType === 'ultra'
```

### 5.4 Backward Compatibility

- `eventType` defaults to `'running'` when undefined
- All existing state fields remain unchanged
- `ultraConfig` is only present when `eventType === 'ultra'`
- Running-only users see zero difference

---

## 6. New Types

### 6.1 Ultra Workout Types

```typescript
type UltraWorkoutType =
  // Running (extended from existing)
  | 'trail_easy'            // easy run on trail terrain
  | 'trail_long'            // long trail run with vert targets
  | 'trail_tempo'           // marathon effort on trails (effort-based, not pace-based)
  | 'vert_intervals'        // hill repeats with hiking recovery
  | 'technical_trail'       // technical single-track for proprioception/downhill
  | 'downhill_repeats'      // eccentric quad loading, descent-focused
  | 'fatigue_run'           // quality session on tired legs (day after long run)
  
  // Hiking
  | 'power_hike'            // sustained uphill hiking at race effort
  | 'power_hike_intervals'  // vert intervals with hiking-only ascent
  
  // Ultra-specific
  | 'back_to_back_long'     // Saturday long of B2B weekend
  | 'back_to_back_moderate' // Sunday moderate of B2B weekend
  | 'night_run'             // practising running in darkness
  | 'pack_run'              // running with race gear/pack
  | 'nutrition_rehearsal'   // long run focused on practising race fuelling
  | 'aid_station_sim'       // long run with planned stops to simulate aid stations
  | 'mountain_long'         // long run prescribed by time AND vert
  | 'pole_training'         // run/hike with pole usage
  
  // Existing types still used
  | 'easy' | 'steady' | 'threshold' | 'tempo' | 'long'
  | 'intervals' | 'fartlek' | 'strides';
```

### 6.2 Session Intent (Ultra)

```typescript
interface UltraSessionIntent {
  type: string;                   // from UltraWorkoutType
  targetDurationMin?: number;     // time-on-feet target
  targetDistanceKm?: number;      // secondary to duration for trail sessions
  targetDPlus?: number;           // vert gain target (metres)
  targetDMinus?: number;          // vert loss target (metres)
  targetTSS?: number;
  intensity: 'recovery' | 'easy' | 'moderate' | 'hard';
  dayPreference?: number;
  isKeySession?: boolean;
  isBackToBack?: boolean;
  backToBackDay?: 'saturday' | 'sunday';
  isNightRun?: boolean;
  isPackRun?: boolean;
  nutritionPractice?: boolean;
  terrainType?: 'road' | 'fire_road' | 'trail' | 'technical' | 'mountain';
}
```

---

## 7. Plan Engine: Ultra Generation

### 7.1 Architecture

```
eventType === 'running'  -> plan_engine.ts (existing, unchanged)
eventType === 'ultra'    -> plan_engine.ultra.ts (new)
```

The ultra plan engine generates sessions using time-on-feet and vert as primary metrics, not distance and pace.

### 7.2 Generation Flow

```
generateUltraWeek(phase, weekIndex, totalWeeks, ultraConfig, fitnessModel)
  1. Determine target weekly hours for this phase + week
  2. Determine target weekly D+ for this phase + week
  3. Determine if this is a back-to-back weekend
  4. Generate long run / back-to-back intents (anchor sessions)
  5. Generate quality session intents (vert intervals, trail tempo, technical)
  6. Generate easy run intents (fill remaining volume)
  7. Generate special sessions (night run, pack run, nutrition rehearsal)
  8. Generate strength intent (1 to 2 per week)
  9. Pass all intents to ultra scheduler
  10. Convert intents to Workout objects with descriptions
  11. Calculate load (elevation-adjusted)
  12. Return Workout[]
```

### 7.3 Session Selection by Phase

**Base phase:**
- 1 long run (trail, building from 1.5h to 3h)
- 1 steady trail run (Zone 2, moderate vert)
- 1 to 2 easy runs (can be road or trail)
- 1 power hike session (if mountain race, introduced from week 4+)
- 2 strength sessions (eccentric emphasis)
- No back-to-backs yet
- Weekly strides in 1 to 2 easy runs

**Build phase:**
- 1 long trail run or back-to-back weekend (alternating weeks)
- 1 quality session (vert intervals OR trail tempo, alternating)
- 1 to 2 easy runs
- 1 power hike (mountain races)
- 1 strength session
- Night runs introduced for 100M+ (monthly, then biweekly)
- Pack runs start for mandatory-gear races
- Nutrition practice begins in all long runs

**Peak phase:**
- Back-to-back every 2 to 3 weeks (peak volume weekends)
- 1 quality session (vert intervals or fatigue run)
- 1 easy run
- 1 mountain long run (time + vert target)
- Night run (for 100M+)
- Full gear/pack in all long runs for mandatory-gear races
- 1 strength session (maintenance)
- Longest sessions of the plan (5 to 8 hours for 100M)
- Race simulation weekend ("dress rehearsal")

**Taper:**
- Volume drops 30 to 50%
- No back-to-backs
- Short hill strides (6 to 8 x 20 seconds) maintained
- One moderate trail run (1.5 to 2h) with race nutrition
- Final week: 30 to 45 min easy runs, strides, shakeout
- All sessions in race shoes and gear

### 7.4 Weekly Volume Calculation

```
targetHours = lookup(distance, terrainAccess, phase)  // from table in 2.5
phaseMultiplier = {
  base_early: 0.60 to 0.70,
  base_late: 0.75 to 0.85,
  build: 0.85 to 0.95,
  peak: 1.0,
  taper: 0.25 to 0.70 (regressive)
}
recoveryWeekMultiplier = isRecoveryWeek ? 0.55 : 1.0
weeklyHours = targetHours * phaseMultiplier * recoveryWeekMultiplier

// Vert target follows independently
targetDPlus = lookup(distance, raceProfile, phase)  // from vert table in 3.8
weeklyDPlus = targetDPlus * phaseMultiplier * recoveryWeekMultiplier
```

### 7.5 Adaptive Adjustments

Same adaptive mechanisms as running mode, plus:

- **Readiness/recovery:** Orange/red recovery status reduces volume or drops quality sessions
- **ACWR:** Uses vert-adjusted TSS. If ACWR > 1.3, reduce first.
- **Vert ACWR:** Separate ACWR for weekly D+. If vert is spiking relative to history, cap D+ even if time-on-feet ACWR is fine.
- **RPE feedback:** If rated efforts consistently high, reduce next week's volume.
- **Terrain availability:** If user marks sessions as "done on road" when trail was prescribed, the engine does not increase vert targets (recognises the user may not have trail access that week).
- **Skip handling:** Same push-to-next-week logic. A skipped back-to-back long gets shortened, not pushed as a full B2B.

### 7.6 Vert Programming

Weekly D+ targets by phase and race:

| Phase | 50K Mountain | 100K Mountain | 100M Mountain |
|-------|-------------|--------------|--------------|
| Base (early) | 500 to 1,000m | 1,000 to 1,500m | 1,500 to 2,500m |
| Base (late) | 1,000 to 1,500m | 1,500 to 2,500m | 2,500 to 4,000m |
| Build | 1,500 to 2,500m | 2,500 to 4,000m | 4,000 to 6,000m |
| Peak | 2,000 to 3,000m | 3,000 to 5,000m | 5,000 to 8,000m |
| Taper | 500 to 1,000m | 1,000 to 1,500m | 1,500 to 2,500m |

For flat ultras, D+ targets are significantly lower (10 to 30% of mountain values).

### 7.7 Flat Terrain Substitutions

When `terrainAccess === 'flat_only'` or `'some_hills'`:

1. **Treadmill incline sessions:** Set 10 to 15% grade, walk/hike at race power-hike effort. ~16 steps = ~3m of vert.
2. **Stair climbing:** Building stairs, stadium stairs. 1,000m D+ = ~5,300 steps = ~330 flights.
3. **Bridge/parking garage repeats:** Continuous climbing on ramps (typically 5 to 8% grade).
4. **Weighted hiking on flat:** 5 to 10kg pack on flat terrain partly simulates the cardiovascular demand of climbing.

Conversion factor: 100m of treadmill D+ at 12% is approximately 70 to 80% of the training stimulus of 100m on real mountain terrain (missing proprioception, varied grade, altitude).

---

## 8. Workout Library

### 8.1 Vert Intervals

**Purpose:** Build climbing power and efficiency at race-specific effort.

**Structure:**
- Sustained climb of 8 to 15% grade, 200 to 500m vertical gain per rep
- Hike up at race effort (power hike pace), run or walk down for recovery
- Heart rate target: Zone 3 to 4 on the climb
- 3 to 8 reps depending on climb length
- Total session D+: 600 to 2,000m
- Progression: increase reps before increasing pace

**Description format:**
```
Vert intervals: 5 x 300m D+ @ Zone 3-4, hike recovery descent
Total: ~1,500m D+, 2h
```

### 8.2 Power Hiking

**Purpose:** Power hiking is faster than running on steep terrain above ~15% grade. It is a distinct skill.

**Structure:**
- Sustained hiking on 15 to 25% grade
- Target vertical rate: 400 to 600 m/hr for trained athletes
- Heart rate: Zone 2 to 3 (sustainable for hours)
- With and without poles
- Short, quick steps. Active arm swing or pole placement rhythm.
- 30 to 90 minutes of continuous climbing

**Description format:**
```
Power hike: 60min sustained uphill @ Zone 2-3, target 500m D+
```

### 8.3 Technical Trail Runs

**Purpose:** Eccentric quad strength, proprioception, confidence on technical terrain.

**Structure:**
- Technical single-track with roots, rocks, varied surfaces
- Focus on foot placement, quick cadence, forward lean
- 30 to 60 minutes of technical terrain per session
- Include specific downhill repeats on steep (15 to 25%), technical descents

**Description format:**
```
Technical trail: 45min on single-track, focus on descending technique
```

### 8.4 Downhill Repeats

**Purpose:** Eccentric strength training disguised as running.

**Structure:**
- Find a 300 to 500m descent
- Run down at controlled pace, hike up for recovery
- 4 to 8 reps
- Focus on quad loading, not speed

**Description format:**
```
Downhill repeats: 6 x 400m descent @ controlled pace, hike recovery
```

### 8.5 Back-to-Back Long Runs

**Description format (Saturday):**
```
B2B Saturday: 4h trail run, 1,200m D+. Practice nutrition (250 cal/hr target).
```

**Description format (Sunday):**
```
B2B Sunday: 2.5h easy trail run on tired legs. Continue nutrition practice.
```

### 8.6 Fatigue Runs

**Purpose:** Quality on tired legs simulates the middle miles of an ultra.

**Structure:**
- Option A: Quality at the END of a long run (final 40 min at marathon effort)
- Option B: Moderate tempo the day AFTER a long run (45 min)

**Description format:**
```
Fatigue run: 50min trail tempo on tired legs (day after long run)
```

### 8.7 Trail Tempo

**Purpose:** Train the effort level sustained during the race.

**Structure:**
- Marathon effort to half-marathon effort on trails
- 40 to 90 minutes
- Rolling trail, not flat road
- Heart rate Zone 3 (steady, sustainable)
- Maintain effort (not pace) through climbs and descents

**Description format:**
```
Trail tempo: 60min @ marathon effort on rolling trail, ~400m D+
```

### 8.8 Mountain Long Runs

**Structure:**
- Prescribed by both time AND vertical gain
- 3 to 6 hours
- Full spectrum: hiking climbs, running flats, descending technical terrain
- Nutrition practice integrated (eat every 30 to 45 minutes)

**Description format:**
```
Mountain long run: 4h with 1,500m D+. Nutrition target: 250 cal/hr. Race gear.
```

### 8.9 Night Runs

**Structure:**
- Begin 6 to 8 weeks before race
- Start with 1 hour on familiar terrain, progress to 2 to 3 hours on varied terrain
- Practice with race headlamp setup
- At least one long run should include night hours

**Description format:**
```
Night run: 90min on trail after dark. Race headlamp. Practice eating in the dark.
```

### 8.10 Pole Training

**Structure (for races that allow/require poles):**
- Incorporate 8 to 12 weeks before race
- Start with uphill-only use, progress to full ascent/descent
- Practice collapsing and stowing quickly
- Train with poles on every long run in final 6 weeks

**Description format:**
```
Pole training: 2h mountain run with poles on all climbs. Practice stow transitions.
```

### 8.11 Strength Training for Ultra

**Eccentric quad loading (the single most important):**
1. Nordic hamstring curls: 3 x 5 to 8
2. Step-downs (slow eccentric): 3 x 8 to 12 per leg
3. Bulgarian split squats (slow eccentric): 3 x 8 to 10 per leg
4. Eccentric leg press (5-second lowering): 3 x 8 to 10

**Single-leg stability:**
1. Single-leg Romanian deadlift: 3 x 8 to 10 per leg
2. Single-leg squat progression: 3 x 5 to 8 per leg
3. Single-leg hop and stick: 3 x 8 per leg

**Hip and ankle:**
1. Banded clamshells: 3 x 15
2. Monster walks: 2 x 20 steps each direction
3. Eccentric calf raises (3-second lower): 3 x 15

**Core for pack running:**
1. Dead bugs: 3 x 10 per side
2. Pallof press: 3 x 10 per side
3. Farmer's carries: 3 x 40m

**Gym placement in week:**
- Base: 2x/week (Tue + Thu/Fri)
- Build: 1 to 2x/week (same day as hard run to keep easy days easy)
- Peak: 1x/week (maintenance: 2 sets instead of 3)
- Taper: No gym sessions (muscular damage takes 48 to 72h to resolve)

---

## 9. Scheduler: Ultra Week Layout

### 9.1 Constraint Rules

**Hard constraints:**
1. At least 1 rest day per week
2. No two quality sessions on consecutive days
3. Long run or B2B on weekend
4. No quality session the day before a long run
5. Strength not on the day before a long run

**Soft constraints:**
1. Back-to-back: Saturday long, Sunday moderate
2. Quality sessions spaced at least 48h apart
3. Night run not adjacent to another hard session
4. Pack runs placed on long/mountain run days
5. Easy runs adjacent to quality/long sessions

### 9.2 Default Templates

**50K Base (5 runs/week):**

| Day | Session |
|-----|---------|
| Mon | REST |
| Tue | Easy run + strides |
| Wed | Strength |
| Thu | Steady trail run (moderate vert) |
| Fri | REST or easy run |
| Sat | Long trail run |
| Sun | Easy run |

**100M Build (6 runs/week + strength, B2B week):**

| Day | Session |
|-----|---------|
| Mon | REST |
| Tue | Vert intervals or trail tempo |
| Wed | Easy run + strength |
| Thu | Easy trail run |
| Fri | REST |
| Sat | B2B long (4 to 5h, mountain, nutrition practice) |
| Sun | B2B moderate (2 to 3h, easy, tired legs) |

**100M Build (non-B2B week):**

| Day | Session |
|-----|---------|
| Mon | REST |
| Tue | Trail tempo |
| Wed | Easy run + strength |
| Thu | Power hike or technical trail |
| Fri | REST or easy |
| Sat | Mountain long run (3 to 4h) |
| Sun | Easy run |

**100M Peak (B2B week with night run):**

| Day | Session |
|-----|---------|
| Mon | REST |
| Tue | Vert intervals |
| Wed | Easy run |
| Thu | Night run (90min) |
| Fri | REST |
| Sat | B2B long (5 to 6h, full gear, nutrition, some night hours) |
| Sun | B2B moderate (3 to 4h, tired legs) |

### 9.3 Back-to-Back Scheduling

- Alternating: B2B weekend every 2 to 3 weeks in build/peak
- Non-B2B weekends: single long run (shorter than B2B Saturday)
- Recovery week: no B2B, shorter single long run
- B2B placement starts 12 to 16 weeks before 100K/100M

### 9.4 Night Run Placement

- For 100M+ races only (or races with known night sections)
- Introduced 6 to 8 weeks before race
- Schedule on a weekday evening (e.g. Thursday) or integrate into a weekend long run
- Not on consecutive days with other quality sessions
- Progress: 1h, then 1.5h, then 2 to 3h, then one long run with night hours

---

## 10. Fitness Model: Ultra-Specific Tracking

### 10.1 Vert-CTL (Vertical Fitness)

A separate CTL track for climbing ability.

```
vertCTL_today = vertCTL_yesterday + (weeklyDPlus_today - vertCTL_yesterday) / 60
vertATL_today = vertATL_yesterday + (weeklyDPlus_today - vertATL_yesterday) / 14
vertTSB = vertCTL - vertATL
```

Purpose: An athlete can have strong aerobic fitness (high run CTL) but poor vert fitness (low vert-CTL). The plan engine uses both to prescribe appropriate sessions.

### 10.2 Ultra Race Prediction

Road VDOT does not predict ultra performance. Ultra race prediction uses:

```
flatEquivKm = raceKm + (raceDPlus / 100) * 10 + (raceDMinus / 100) * 5
// Each 100m D+ adds ~10 "flat equivalent km", each 100m D- adds ~5

baseRunPace = f(VDOT)  // current running fitness
trailSlowFactor = lookup(raceProfile)  // flat: 1.0, rolling: 1.15, mountain: 1.35, technical: 1.50
fatigueFactor = lookup(distance)        // 50K: 1.05, 100K: 1.15, 100M: 1.30

predictedTime = flatEquivKm * baseRunPace * trailSlowFactor * fatigueFactor
```

Add time for:
- Aid station stops (5 to 10% of total time for 100M)
- Hiking sections (based on estimated VAM and total D+)
- Night slowdown (10 to 20% pace reduction for hours in darkness)

**Decision needed from Tristan**: Exact trail slow factors and fatigue factors. The above are derived from coaching literature but need calibration against real race data.

### 10.3 Descent Fitness

Track descent-specific fitness separately:
- Weekly D- (eccentric loading history)
- Descent pace improvement over time
- Recovery time after heavy descent sessions

This feeds the injury risk model: high D- with low eccentric training history = elevated risk.

### 10.4 Mapping to Existing Load Model

| Signal | Current Use | Ultra Adaptation |
|--------|-------------|-----------------|
| **Signal A** (run-equiv) | Running Fitness CTL, race prediction | Add vert-adjusted component for mountain ultras |
| **Signal B** (raw physiological) | ACWR, Total Load, Freshness | Add vert-derived muscular load: `adjustedTSS = hrTSS * (1 + vertFactor)` |
| **Signal C** (impact load) | Day-before injury risk | Add eccentric descent load as sub-signal |
| **Signal D** (new: vert fitness) | N/A | Vert-CTL / vert-ATL / vert-TSB (60/14-day windows) |

---

## 11. Activity Sync and Matching

### 11.1 Strava Data Availability for Ultra/Trail

| Metric | Available? | Source |
|--------|-----------|--------|
| Distance | Yes | GPS |
| Duration | Yes | Timer |
| Heart rate | Yes (with watch/strap) | Wearable |
| Elevation gain (D+) | Yes | GPS + barometric altimeter |
| Elevation loss (D-) | Yes | GPS + barometric altimeter |
| Pace | Yes | GPS |
| Cadence | Yes (with watch) | Accelerometer |
| Power | Only with Stryd | External sensor |
| Trail difficulty | No | N/A |
| Surface type | No | N/A |

**Key insight:** Strava provides D+ and D- on every activity. This is the critical data point for ultra mode that we already have access to.

### 11.2 Matching Logic Changes

Current matcher: day proximity + distance + type.

Ultra matcher adds:
- **Vert matching:** If a workout has `targetDPlus`, match activities with similar D+ (within 20% tolerance)
- **Duration matching:** For time-on-feet workouts, match on duration proximity (within 15% tolerance)
- **Back-to-back detection:** Two trail runs on consecutive days (Saturday + Sunday) with the Saturday being longer auto-associate with a B2B workout pair
- **Hiking detection:** Activities with very low pace but significant D+ classify as power hiking sessions

### 11.3 Elevation Data Quality

Strava D+ can be noisy (GPS elevation jitter on flat terrain). For activities with a watch barometric altimeter, Strava's D+ is reliable. For phone-only GPS, D+ may be inflated by 10 to 30%.

**Recommendation:** Trust Strava's D+ as-is for now. If the user reports consistently inflated vert, add a calibration offset in settings.

---

## 12. Wizard / Onboarding

### 12.1 Flow Branching

The wizard adds ultra options to the mode selection:

```
Step 1: What are you training for?
  [ ] Marathon / Half / 10K / 5K         -> existing running flow
  [ ] Ultra / Trail                       -> ultra flow
  [ ] Triathlon (70.3 or Ironman)        -> triathlon flow (future)
  [ ] General fitness (no race)          -> existing continuous mode
```

### 12.2 Ultra-Specific Wizard Steps

After selecting ultra:

**Step 1: Distance selection**
- 50K / 50M / 100K / 100M / 200M+

**Step 2: Race profile**
- Flat ultra / Rolling trail / Mountain ultra / Technical trail
- Optional: specific race selection (with known D+ and cut-off)
- If specific race selected: auto-populate raceDPlus, raceDMinus, raceAltitudeMax

**Step 3: Race date** (optional)
- Same as current event selection

**Step 4: Experience**
- "What's the longest race you've finished?"
  - No ultra experience / 50K / 50M / 100K / 100M
- "How long have you been trail running?" (affects terrain adaptation phase)

**Step 5: Current training**
- Runs per week (same as current)
- Weekly D+ estimate ("How much climbing do you typically do per week?")
  - < 500m / 500 to 1,500m / 1,500 to 3,000m / 3,000m+
- Trail access: "Do you regularly train on trails?"
  - Flat only / Some hills / Mountain access / Lives in mountains

**Step 6: Performance** (same as current)
- Running PBs (VDOT derivation)
- Recent race (optional)

**Step 7: Gear**
- "Does your race require mandatory gear?" (affects pack run programming)
- "Will you use trekking poles?" (affects pole training sessions)

**Step 8: Strava history** (conditional)
- Same as current, but additionally extract D+ history from past activities
- Compute starting vert-CTL from historical weekly D+

**Step 9: Physiology** (same as current)
- biologicalSex, ltPace, vo2max, restingHR, maxHR

**Step 10: Assessment**
- Show predicted race time (elevation-adjusted)
- Show plan overview: phases, peak volume, peak D+
- Offer harder/easier plan toggle

### 12.3 Estimating Starting Fitness

When vert history is unknown, estimate from terrain access:

| Terrain Access | Estimated Weekly D+ |
|---------------|-------------------|
| Flat only | 100 to 300m |
| Some hills | 300 to 800m |
| Mountain access | 800 to 2,000m |
| Lives in mountains | 2,000 to 4,000m |

**Decision needed from Tristan**: Confirm these defaults. Per CLAUDE.md rules, no made-up numbers.

---

## 13. UI Changes

### 13.1 Design Principle

Same UX patterns, same visual language. Ultra mode is the running mode with vert-awareness and time-on-feet prominence.

### 13.2 Home View

Current: shows this week's workouts as cards with distance and pace targets.

Ultra additions:
- Each card shows **time target** (primary) and **distance** (secondary)
- Vert target displayed: "1,200m D+" on long run cards
- Back-to-back weekends visually grouped (connected Saturday + Sunday cards)
- Night run cards have a moon/dark indicator
- Pack run cards note gear requirement
- Weekly summary shows three numbers: distance, time, D+

### 13.3 Plan View

Current: week-by-week running plan with phase labels.

Ultra additions:
- Weekly volume shown as hours and D+ (not just km)
- B2B weekends marked with a connecting indicator
- Vert progression visible alongside distance progression
- Phase labels unchanged (base/build/peak/taper)

### 13.4 Stats View

Current: CTL/ATL/TSB chart, weekly volume, zone distribution.

Ultra additions:
- **Vert chart**: Weekly D+ history as area chart (alongside existing volume chart)
- **Time on feet chart**: Weekly hours
- **Vert-CTL trend**: Vertical fitness progression
- **Descent volume**: Weekly D- (eccentric load indicator)
- **VAM trend**: Climbing rate progression over time
- **Back-to-back volume**: Weekend total hours when B2B was done

### 13.5 Workout Detail (Post-Activity)

Current: shows run metrics (pace, HR, splits, km).

Ultra additions:
- Elevation profile from GPS data
- D+ and D- totals
- Average climbing pace (VAM equivalent)
- Average descent pace
- Vert target vs actual (if workout had a vert target)
- Time target vs actual (if workout had a time target)
- Nutrition log (if nutrition practice was flagged)

### 13.6 No New Colour System

Per UX_PATTERNS.md, no tinted card backgrounds. Ultra mode uses the same neutral card design. The only visual difference is the additional metrics displayed (vert, time) and the B2B grouping.

---

## 14. Nutrition Engine

### 14.1 Why Nutrition Matters for Ultra

GI distress is the #1 DNF reason in ultras. Caloric expenditure (500 to 800 cal/hr) far exceeds maximum gastric absorption (~60 to 90g carbohydrate/hr, or 240 to 360 cal/hr from carbs). The caloric deficit is inevitable. Fat oxidation covers the gap.

The gut is adaptable. Regular practice increases gastric emptying rate, intestinal absorption capacity, and tolerance to eating under exertion.

### 14.2 Nutrition Sessions in the Plan

These are flags on existing workout types, not separate sessions:

1. **Fuelling long run** (weekly in build/peak): Flag on Saturday long run. Shows nutrition target (cal/hr).
2. **Calorie target run** (every 2 to 3 weeks): Specific cal/hr target displayed in workout description.
3. **Real food practice** (monthly): Note in workout description to eat solid food during run.
4. **Fasted long run** (monthly in base only): 60 to 90 min easy while fasted. Builds fat oxidation. Not for peak phase.
5. **Aid station simulation** (3 to 4 times in build/peak): Note to stop, eat a full 300 to 500 cal "meal", resume.

### 14.3 Nutrition Targets

| Effort Level | Target Intake (cal/hr) |
|-------------|----------------------|
| Easy / hiking | 150 to 250 |
| Moderate (race pace, flat ultra) | 200 to 300 |
| Hard (threshold on trail) | 100 to 200 (harder to eat) |
| Race pace ultra (steady) | 200 to 350 |

**Gut training progression (10 to 12 weeks before race):**
- Weeks 1 to 2: 100 to 150 cal/hr during long runs
- Weeks 3 to 4: 150 to 200 cal/hr
- Weeks 5 to 6: 200 to 250 cal/hr
- Weeks 7 to 8: 250 to 300 cal/hr
- Weeks 9 to 12: 250 to 350 cal/hr (race target)

### 14.4 Sodium/Electrolyte

- Average sweat sodium: ~800mg/L
- Hot conditions: sweat rate 1 to 2.5 L/hr
- Sodium target in heat: 500 to 1,500 mg/hr (highly individual)
- Hyponatremia is a real risk: runners who drink too much water without sodium

The app should display a sodium reminder in hot-weather long runs but not attempt to calculate individual sodium needs (requires a sweat test).

---

## 15. Sleep Management and Race-Night Strategy

### 15.1 Why Sleep Matters in Ultra

Sleep deprivation is one of the defining challenges of 100M+ racing. A 100-miler takes 20 to 30+ hours for most runners, meaning at least one full night without sleep. 200M+ races involve 3 to 4 nights. Performance degrades non-linearly with sleep loss.

**Circadian low (2:00 to 5:00 AM):**
- Core body temperature drops, reaction time slows, mood crashes
- Pace drops 15 to 25% even in well-trained athletes
- This is the #1 DNF window in 100-milers. Most dropouts happen between 2:00 and 5:00 AM.
- Cannot be trained away entirely, but can be managed with strategy and practice

### 15.2 Sleep Strategies During Racing

**Push-through strategy (most common for sub-24h 100M attempts):**
- No planned sleep stops
- Use caffeine strategically: save it for after midnight. 100 to 200mg at the circadian low.
- Accept the pace drop through the night. It recovers after sunrise.
- Best for: fast runners who will finish before the second night

**Planned power nap strategy (24 to 30h 100-milers and all 200M+):**
- Plan 15 to 20 minute naps at aid stations with cots/chairs
- Set an alarm. Sleeping longer than 20 minutes enters deep sleep, and waking from deep sleep causes severe grogginess (sleep inertia).
- Timing: first nap at or just before the circadian low (1:00 to 2:00 AM). Second if needed around 4:00 to 5:00 AM.
- Total sleep budget for a 100-miler: 20 to 40 minutes maximum
- For 200M+: plan 2 to 4 hours total sleep across the event, in 20 to 30 minute blocks

**Sleep inertia management:**
- After waking from a nap: 5 minutes walking before attempting to run
- Caffeine immediately on waking (takes 20 to 30 min to kick in)
- Cold water on face/neck
- First 10 minutes will feel terrible. It passes.

### 15.3 Sleep Training (Pre-Race)

**Sleep deprivation practice:**
- At least one training session through the night (for 100M+ racers)
- Best integrated into a long back-to-back weekend: start Saturday evening, run through the night, finish Sunday morning
- Practice the circadian low: experience the mood crash and pace drop in training so it is not a surprise on race day
- 2 to 3 night runs in the final 8 weeks (see Section 8.9) partially address this

**Sleep banking (race week):**
- Extra sleep in the week before a race improves endurance performance
- Target 8 to 9 hours/night in the final 7 to 10 days
- Napping is beneficial (20 to 30 minutes in the afternoon)
- Race-night insomnia is normal (anxiety + early start). Does not affect race performance if sleep was banked.

### 15.4 Caffeine Strategy

Caffeine is the single most effective legal performance aid for overnight ultras.

- **Do not use caffeine in the first 12 hours of a 100-miler.** Save it for when it matters.
- First dose: 100mg at sunset or when drowsiness starts
- Second dose: 100 to 200mg at the circadian low (2:00 to 4:00 AM)
- Maximum: 400 to 600mg total over the race (diminishing returns and GI risk above this)
- Form: caffeine pills are more reliable than coffee or gels for dosing
- If the athlete habitually uses caffeine: consider reducing intake in the final 5 to 7 days before the race to resensitise (controversial, some coaches disagree)

### 15.5 App Integration

- For 100M+ races: display sleep strategy guidance in race-week view
- Night run sessions in the plan already train circadian low tolerance
- Add a "race night plan" section to the race-week view: when to nap, when to caffeine, what to expect
- Sleep banking reminder in taper phase: "Target 8 to 9 hours/night this week"

---

## 16. Mental Training

### 16.1 Why Mental Training Matters

Past mile 60 of a 100-miler, the limiting factor is rarely aerobic fitness. It is the ability to keep moving when every signal says stop. Courtney Dauwalter has said the mental game is what separates finishers from DNFs. Research on ultra DNFs consistently identifies "loss of motivation" as a top-3 reason alongside GI distress and injury.

### 16.2 Techniques

**Chunking (aid station to aid station):**
- Never think about the total remaining distance
- Break the race into segments: "I just need to get to the next aid station" (typically 8 to 15km apart)
- In the app: race prediction can show per-segment ETAs, reinforcing the chunk mentality

**Process goals:**
- Replace outcome goals ("I need to finish in 28 hours") with process goals ("I will eat 250 cal every hour," "I will hike every climb over 10%," "I will leave every aid station within 5 minutes")
- The app's nutrition and pacing targets serve as built-in process goals

**"The pain cave" management (Dauwalter's concept):**
- Accept that there will be extended periods of suffering. They are temporary.
- Visualisation: imagine the low point in advance. Plan what you will do (not "if" but "when" it happens).
- Reframe: "This is what I trained for" not "I can't do this"

**Dissociation vs association:**
- Early miles: dissociation works (music, conversation, scenery)
- Late miles when pain is high: association works better (focus on form, breathing, foot placement)
- Night miles: association is essential (proprioception, safety)

**Mantra:**
- A short phrase repeated during low moments. Simple, personal, present-tense.
- Examples: "Relentless forward progress." "One more mile." "I chose this."
- The athlete should choose their own before race day

### 16.3 DNF Decision Framework

When to push through vs when to pull:

**Push through:**
- Nausea (usually resolves with walking, ginger, and time)
- Blisters (unless infection risk)
- Mood crash at 2:00 to 5:00 AM (this WILL pass after sunrise)
- "I just don't want to anymore" (sit for 10 minutes, eat, reassess)
- Sore muscles without sharp pain

**Pull out:**
- Structural injury: sharp pain that worsens with each step, inability to bear weight
- Rhabdomyolysis symptoms: dark brown urine, extreme swelling, inability to urinate
- Hypothermia or heat stroke signs
- Vomiting that cannot be controlled after 2+ hours (dehydration spiral)
- Heart rate wildly erratic or chest pain

**The 10-minute rule:** When you want to quit, sit down for 10 minutes, eat something, drink something. If you still want to quit after 10 minutes AND your reason is medical, then quit. If it is motivational, keep going.

### 16.4 App Integration

- Pre-race: display mental preparation checklist (choose mantra, visualise low point, set process goals)
- Race week view: "DNF decision framework" as reference material
- The existing process goals (nutrition targets, pacing targets, aid station time budgets) already serve the chunking strategy
- Post-race debrief for DNFs: "How far did you get? What happened? What was controllable?" This feeds the next training cycle.

---

## 17. Cross-Training for Ultra

### 17.1 Role of Cross-Training

Cross-training plays a larger role in ultra than in marathon training:

1. **Cycling for aerobic volume:** Builds aerobic base with zero impact. Critical for high-volume weeks and injury management. Many ultra coaches prescribe 2 to 4 hours/week of cycling, especially in base phase.
2. **Swimming for recovery:** Active recovery without load-bearing stress. Useful the day after a long run.
3. **Ski mountaineering/touring:** Identical muscle groups to mountain running (quads, glutes, hip flexors) with reduced impact. Kilian Jornet's winter base is almost entirely ski touring.
4. **Hiking (non-running):** Pure hiking counts as training for mountain ultras. A 4-hour hike with 1,500m D+ is legitimate training.

### 17.2 How Cross-Training Maps to the Load Model

| Activity | runSpec (Signal A) | Signal B (full) | Signal D (vert) |
|----------|-------------------|-----------------|-----------------|
| Cycling (flat) | 0.55 | 1.0 | 0 |
| Cycling (hilly) | 0.55 | 1.0 | Partial (0.3x vert) |
| Swimming | 0.20 | 1.0 | 0 |
| Hiking (with D+) | 0.50 | 1.0 | 1.0 (full vert credit) |
| Ski touring | 0.60 | 1.0 | 1.0 (full vert credit) |
| Strength training | 0.30 | 0.5 | 0 |

**Key difference from marathon mode:** In ultra mode, hiking and ski touring should receive **full vert credit** in Signal D (vert-CTL), because the climbing fitness transfer is nearly 1:1.

### 17.3 When to Prescribe Cross-Training

The plan engine should suggest cross-training in these scenarios:

1. **Injury management:** Runner flagged with lower-limb injury. Replace easy runs with cycling. Keep long runs but reduce volume.
2. **High-volume weeks:** In peak phase, if weekly hours exceed the runner's historical maximum, substitute one easy run with a bike ride to reduce impact load.
3. **Recovery days:** After a B2B weekend, Monday could be swimming or easy cycling instead of complete rest.
4. **Winter/off-season:** For mountain ultra runners, ski touring replaces running in winter months. The plan should recognise this and maintain vert-CTL.
5. **Flat terrain substitution:** If a runner has no hills but has a bike, hilly cycling partially substitutes for vert training (at 0.3x vert credit).

### 17.4 Interaction with Existing Cross-Training Engine

The current cross-training system (`src/cross-training/`) already handles non-running activities with `runSpec` discounting. For ultra mode:

- Hiking changes from pure cross-training to a **primary training activity** (like swimming in triathlon mode)
- Cycling remains cross-training but with a higher suggested frequency
- Ski touring is a new activity type that should be classified like hiking for vert purposes
- The suggestion engine should proactively suggest cycling when weekly running impact load is high

---

## 18. Fat Adaptation and Metabolic Efficiency

### 18.1 The Science

Ultra running at race pace relies heavily on fat oxidation. At marathon pace, carbohydrate provides ~60 to 80% of fuel. At ultra pace (Zone 1 to 2), fat provides 50 to 70%. An athlete who can oxidise fat at a higher rate at a given pace can spare glycogen, reducing the need for exogenous carbohydrate and lowering GI distress risk.

Fat oxidation rate is trainable. It increases with:
- Aerobic base training (months of Zone 1 to 2 work)
- Fasted training (training with low glycogen availability)
- Dietary periodisation (reducing carbohydrate availability around some sessions)

### 18.2 Approaches

**Fasted easy runs (well-supported):**
- Run easy (Zone 1 to 2 only) for 60 to 90 minutes before breakfast
- 1 to 2 times per week during base phase
- Enhances fat oxidation capacity
- Do NOT do this for hard sessions or long runs (compromises quality and recovery)

**"Train low, compete high" (moderate support):**
- Some training sessions with reduced carbohydrate availability (fasted, or after depleting glycogen the night before)
- All races and quality sessions with full carbohydrate availability
- Principle: the metabolic stress of low glycogen triggers adaptations (increased mitochondrial density, upregulated fat oxidation enzymes)
- Supported by research (Burke et al., Impey et al.) but requires careful implementation to avoid overtraining

**Full low-carb / keto adaptation (controversial):**
- Chronically low carbohydrate diet to maximise fat adaptation
- Some ultra runners (Zach Bitter, Jeff Browning at one point) have used this successfully
- Research shows it impairs high-intensity performance (threshold and above) while potentially benefiting ultra-endurance at low intensity
- NOT recommended as a default. Too risky, too individual, and impairs the speed work that even ultra runners need.

### 18.3 App Integration

**Recommended approach: Support fasted easy runs and train-low sessions as optional flags, not a full dietary programme.**

- In base phase: the plan engine can flag 1 to 2 easy runs per week as "fasted run (optional)" with a note: "Run before breakfast at easy effort. Zone 1 to 2 only. Builds fat oxidation capacity."
- In build/peak phase: drop fasted runs entirely. Full fuelling for all sessions.
- No dietary advice beyond session-level fuelling notes. Mosaic is a training app, not a nutrition app.
- The nutrition engine (Section 14) already handles race fuelling. Fat adaptation is the base-phase complement: train the body to burn fat, then race with full carbs.

### 18.4 State/Config

```typescript
// Optional addition to ultraConfig
fatAdaptationEnabled?: boolean;  // user opt-in for fasted run suggestions
```

When `true`, the plan engine marks 1 to 2 easy runs per week as `fastedRun: true` during base phase. The workout description includes the note. No other changes.

---

## 19. Crew, Pacers, and Drop Bags

### 19.1 Why This Matters for the App

Crew, pacers, and drop bags are not training, but they directly affect race execution strategy. The app's race-week view and race prediction model should account for them.

### 19.2 Crew

A crew is a support team that meets the runner at designated aid stations with personal supplies.

**Impact on training:**
- If crewed: train with less gear (crew carries extras). Pack runs can use a lighter load.
- If uncrewed: must carry everything. Pack weight training should match actual race carry weight.
- The onboarding or race-setup step should ask: "Will you have crew support?" This affects pack run load recommendations.

### 19.3 Pacers

A pacer runs alongside the athlete for designated sections (typically the final 30 to 60 miles of a 100-miler). Rules vary by race.

**Impact on pacing and prediction:**
- Runners with pacers typically maintain pace 5 to 10% better in late miles (motivation, safety, navigation assistance)
- Night sections with a pacer are significantly less demoralising
- The race prediction model could apply a small positive adjustment to late-race pace when pacer is flagged

**State/Config:**
```typescript
// Optional addition to ultraConfig
hasCrew?: boolean;
hasPacer?: boolean;
pacerStartKm?: number;  // km into race where pacer joins
```

### 19.4 Drop Bags

Drop bags are gear/nutrition bags the runner deposits at designated aid stations before the race.

**Impact on training and race plan:**
- Drop bags allow gear changes (dry socks, warmer layers for night, different shoes)
- Nutrition strategy depends on what is in drop bags vs what is carried
- Shoe changes can prevent blisters (fresh socks + shoes at mile 50 to 60)

**App integration:**
- Race-week view: drop bag checklist (what goes in each bag, which aid station)
- This is informational/checklist only, not programmed into the training plan
- Future feature: interactive drop bag planner linked to race aid station map

### 19.5 Aid Station Time Budget

Aid station stops add up. Modelling this is critical for accurate race prediction.

| Distance | Number of Aid Stations | Avg Time Per Stop | Total Aid Station Time |
|----------|----------------------|-------------------|----------------------|
| 50K | 3 to 5 | 2 to 5 min | 10 to 20 min |
| 100K | 6 to 10 | 3 to 8 min | 30 to 60 min |
| 100M | 10 to 20 | 5 to 15 min | 1.5 to 3 hours |
| 200M+ | 15 to 30 | 10 to 30 min | 3 to 8 hours |

Efficient aid station execution is a skill. The "aid station simulation" workout (Section 8.11 of workout library) trains this.

**Race prediction adjustment:**
```
aidStationTime = numberOfStops * avgTimePerStop
predictedRaceTime = movingTime + aidStationTime
```

The app should display both moving time and total time predictions.

---

## 20. Hydration Logistics

### 20.1 Water Carry Capacity

In mountain ultras, the distance between aid stations can be 10 to 25+ km with significant climbing. Runners must carry enough water for the longest unsupported stretch.

**Carry volumes:**

| Conditions | Carry Capacity Needed | Typical Setup |
|-----------|----------------------|---------------|
| Cool, aid every 10km | 500ml | Single soft flask |
| Moderate, aid every 15km | 1 to 1.5L | Two soft flasks |
| Hot, aid every 15 to 20km | 1.5 to 2L | Bladder or 2 large flasks |
| Remote mountain, 20 to 25km gaps | 2 to 3L | Bladder + flasks |

**Weight impact:** Water is 1kg per litre. Carrying 2L adds 2kg to pack weight. This significantly affects running economy and must be trained.

### 20.2 Hydration Rate

- General target: 400 to 800ml/hr depending on heat, altitude, and effort
- Overhydration is as dangerous as dehydration in ultras (hyponatremia)
- Thirst is a reasonable guide for experienced athletes, but novices tend to under-drink in early miles and over-drink later

### 20.3 Water Sources in Mountain Ultras

Some mountain ultras allow or require runners to filter water from streams. This is common in remote sections of Hardrock, Tor des Geants, and backcountry ultras.

**Training implication:**
- If the race requires water filtering: practice using the filter during training runs
- Weight of filter (30 to 60g) is negligible but the time cost of stopping to filter is not

### 20.4 App Integration

- **Race setup:** "What is the longest gap between aid stations?" This determines minimum carry capacity.
- **Pack run weight:** When `hasMandatoryGear === true`, pack weight should account for water carry weight on top of gear weight.
- **Hydration reminder** in long run descriptions: "Carry X litres for this session" based on duration and expected conditions.
- **Race-week view:** Show per-section water carry plan based on aid station map (if specific race is selected).

### 20.5 State/Config

```typescript
// Optional addition to ultraConfig
maxAidGapKm?: number;        // longest stretch between aid stations
waterCarryLitres?: number;   // calculated from maxAidGapKm + conditions
```

---

## 21. Gear and Equipment

### 21.1 Mandatory Gear and Pack Running

Mountain ultras (UTMB, Lavaredo, etc.) require mandatory gear:
- Waterproof jacket, thermal layer, headlamp (2), emergency blanket, whistle, cup, phone, minimum food
- Pack weight with mandatory gear: 2 to 4 kg
- This weight significantly affects running economy

**Training implication:**
- Run with race pack (loaded to race weight) at least once per week in final 8 to 10 weeks
- The plan engine sets `isPackRun: true` on long runs in build/peak phase when `hasMandatoryGear === true`

### 21.2 Poles

Poles save 15 to 20% energy on climbs above 15% grade (research-supported). But they add weight and require arm endurance.

**Training schedule:**
- 12 weeks out: introduce on long runs
- 8 weeks out: every hilly long run
- 4 weeks out: race simulation with full pole usage

**In the plan:** When `usePoles === true`, the engine adds a `pole_training` tag to appropriate sessions from 12 weeks out.

### 21.3 Shoe Rotation (Info Only)

Not programmed into the plan engine, but displayed as guidance:

| Terrain | Shoe Type |
|---------|-----------|
| Runnable trail/fire road | Moderate cushion trail shoe (20 to 25mm stack, 3 to 4mm lugs) |
| Technical single-track | Lightweight trail shoe (15 to 22mm stack, 5 to 6mm lugs) |
| Mountain/wet rock | Technical approach shoe (rock plate, sticky rubber) |
| Road-to-trail | Hybrid shoe (light lugs) |
| Flat ultra (road) | Road shoe with maximum cushion |

---

## 22. Altitude and Heat Protocols

### 22.1 Altitude

Effects on ultra performance:
- Above 1,500m: VO2max decreases ~3% per 300m of altitude gain
- At 3,000m: ~15% VO2max reduction
- At 4,000m (Hardrock): ~25% VO2max reduction

**Pre-acclimatisation guidance (displayed, not programmed):**
- Arrive 1 to 2 weeks before race if possible
- If not, arrive same day (before acclimatisation-related fatigue at 24 to 48h) or >7 days before
- The 2 to 5 day window is the worst time to race at altitude

When `raceAltitudeMax` is set and > 2,000m, the app displays altitude preparation guidance in the taper section.

### 22.2 Heat Adaptation

**Sauna protocol (post-exercise):**
- 20 to 30 minutes in sauna immediately after training
- 3 to 5 sessions per week for 7 to 14 days
- Benefits: increased plasma volume (5 to 12%), lower core temp at given effort, earlier sweating onset
- Translates to ~2 to 5% performance improvement in hot conditions

**Programming:** When the user flags a hot-weather race, the plan engine displays heat adaptation notes 10 to 14 days before race day. This is informational, not a separate session type.

---

## 23. Recovery and Season Planning

### 23.1 Post-Race Recovery Periods

| Race Distance | Minimum Recovery | Recommended Recovery | Full Training Resumes |
|--------------|-----------------|---------------------|----------------------|
| 50K | 1 to 2 weeks | 2 to 3 weeks | 3 to 4 weeks |
| 50M | 2 to 3 weeks | 3 to 4 weeks | 4 to 6 weeks |
| 100K | 2 to 3 weeks | 4 to 6 weeks | 6 to 8 weeks |
| 100M | 3 to 4 weeks | 6 to 8 weeks | 8 to 12 weeks |
| 200M+ | 4 to 6 weeks | 8 to 12 weeks | 12 to 16 weeks |

Rule of thumb (Hal Koerner): 1 easy day per mile raced. 100 miles = 100 easy days (~14 weeks).

**Recovery phases after a 100-miler:**
- Days 1 to 3: Complete rest or gentle walking only
- Days 4 to 7: Walking, swimming, easy cycling (no running)
- Week 2: Light jogging (20 to 30 min, flat, soft surface) if no pain
- Week 3 to 4: Easy running (30 to 45 min), no vert, no speed
- Week 5 to 6: Moderate running returns, light hills
- Week 7 to 8: Normal training volume at easy intensity
- Week 9 to 12: Full training resumes

### 23.2 Season Planning with Multiple Ultras

**Race tier system:**
- **A race**: Full preparation cycle, peak performance target, full taper, full recovery
- **B race**: Moderate preparation, used for race practice or qualifier, partial taper (1 week), moderate recovery
- **C race / training race**: Run within training, no taper, treat as a hard training day

**Spacing rules:**
- A race to A race: minimum 16 weeks (preferably 20+)
- A race to B race: minimum 8 weeks
- B race to A race: minimum 6 weeks (if B race is shorter)
- Training races: every 3 to 4 weeks during build phase

**Example season:**
- Jan to Feb: Base building
- March: B race (50K) as gear test / long run
- April to May: Build phase
- June: C race (30K trail) as training race, no taper
- July to August: Peak + taper
- September: A race (100M)
- October to November: Recovery + off-season
- December: Return to base

### 23.3 DNF Recovery

**Physical:** Recovery proportional to distance completed + effort level, not distance planned.

**In the app:** After a DNF, the plan should prompt: "How far did you get?" and "Were you injured?" Then apply recovery guidelines based on actual distance/effort, not the target race.

---

## 24. Integration Deep Dive

### 24.1 Onboarding / Wizard

**Current flow** (`src/ui/wizard/controller.ts`):
```
welcome -> goals -> background -> volume -> performance ->
fitness -> strava-history -> physiology -> initializing ->
runner-type -> assessment -> main-view
```

**Ultra fork point: Goals step.**

The goals step currently collects `raceDistance` from `'5k' | '10k' | 'half' | 'marathon'`. Add ultra distances and a race profile selector.

**Option A (recommended): Inline fork.**
Add "What are you training for?" at the top of the goals step: Running / Ultra-Trail. If ultra, show ultra distances and race profile. Minimal step count change.

**New wizard steps for ultra (after goals):**
1. **Ultra experience**: longest completed race, years on trail
2. **Terrain**: trail access, vert availability, terrain type
3. **Gear**: mandatory gear (Y/N), poles (Y/N)
4. **Volume**: same as current + weekly D+ estimate

Everything after (performance, fitness, strava-history, physiology) stays the same, with strava-history additionally extracting D+ history.

### 24.2 Plan Engine

**Branch point:** `src/workouts/generator.ts:generateWeekWorkouts()`

```typescript
if (s.eventType === 'ultra') {
  intents = planUltraWeek(ultraCtx);
} else {
  intents = planWeekSessions(ctx);
}
```

**What's reusable from `planWeekSessions()`:**
- `abilityBandFromVdot()` - sport-agnostic
- `isDeloadWeek()` - sport-agnostic (same build:recovery cycle)
- `effortMultiplier()` - sport-agnostic (RPE feedback scales any discipline)
- Quality cap logic - reusable (ultra has same "max 2 quality sessions" concept)

**What needs new implementation:**
- Volume budget in hours AND vert (not just minutes/km)
- Session type priority ordering (vert intervals > trail tempo > power hike for mountain races)
- Back-to-back weekend logic (alternate B2B and non-B2B weekends)
- Night run scheduling (final 6 to 8 weeks only)
- Pack run flagging (build/peak only, when mandatory gear)
- Nutrition practice flagging (all long runs in final 10 to 12 weeks)

### 24.3 Intent-to-Workout Conversion

**Current system** (`src/workouts/intent_to_workout.ts`):
Converts `SessionIntent` to `Workout` with description in distance/pace format.

**Ultra changes:**
- Primary format: time + vert, not distance + pace
- Trail sessions use effort zones (Zone 2 to 3), not pace targets (pace varies wildly on terrain)
- Long run descriptions include nutrition targets
- Back-to-back workouts include "on tired legs" context

**New conversion function:**
```typescript
function ultraIntentToWorkout(intent: UltraSessionIntent, config: UltraConfig): Workout
```

This sits alongside the existing `intentToWorkout()` for running.

### 24.4 Scheduler

**Current system** (`src/workouts/scheduler.ts:assignDefaultDays()`):
Long run Sunday, quality Tue/Thu, easy fills gaps.

**Ultra changes:**
- Back-to-back: Saturday long + Sunday moderate (when scheduled)
- Night run: weekday evening (Thu) or integrated into weekend
- Otherwise similar: quality mid-week, easy between, rest Mon

The existing scheduler's 5-phase algorithm (categorize, space hard, place easy, deconflict) extends naturally. The main addition is the B2B weekend handling.

**Recommended approach:** Extend existing scheduler with ultra-aware rules rather than building a parallel scheduler.

### 24.5 Load Calculation

**Current system** (`src/calculations/load.ts`):
Parses running descriptions for duration, computes iTRIMP from HR.

**Ultra changes:**
- Add `vertFactor` calculation from activity D+/D-/distance
- `adjustedTSS = hrTSS * (1 + vertFactor)`
- Feed adjusted TSS into existing CTL/ATL/TSB pipeline
- Additionally feed raw D+ into vert-CTL pipeline

**For planned workouts (no activity yet):**
- Estimate TSS from `targetDurationMin` + intensity level
- Add vert factor from `targetDPlus` / estimated distance

### 24.6 Daily Interaction: Rating, Skipping, Moving

**Rating:** Same as current. Ultra workouts are still running sessions. RPE adjusts VDOT as normal.

Additional data capture:
- "Did you hit your nutrition target?" (Y/N on flagged sessions)
- Actual D+ vs planned D+ (auto-captured from Strava)

**Skipping:** Same push-to-next-week logic. A skipped B2B long gets replaced by a single long run (do not push the full B2B).

**Moving:** No changes needed.

---

## 25. Rollout Plan

### Phase 0: Stabilise Running Mode (prerequisite)
Fix open P1 bugs. These touch fitness-model.ts and load calculations that ultra will build on.

### Phase 1: Types and State Schema
- Add `eventType: 'ultra'`, `UltraDistance`, `RaceProfile`, `ultraConfig` to types
- Add ultra-specific fields to `Workout` (targetDPlus, targetDurationMin, isBackToBack, etc.)
- Add ultra workout types
- Ensure all existing tests pass (running mode unaffected)
- No UI changes yet

### Phase 2: Wizard Fork
- Add ultra option to goals step
- Build ultra-specific onboarding steps (distance, profile, experience, terrain, gear)
- Collect vert availability and ultra experience
- Store in `ultraConfig`
- Extract D+ history from Strava
- Result: user can onboard as an ultra runner, but sees empty plan

### Phase 3: Load Model
- Implement vert-adjusted TSS (`adjustedTSS = hrTSS * (1 + vertFactor)`)
- Implement vert-CTL / vert-ATL (60/14-day windows)
- Feed D+ from Strava activities into vert fitness tracking
- No UI for this yet (internal calculation)

### Phase 4: Plan Engine (Ultra)
- New `plan_engine.ultra.ts`
- Time-on-feet + vert-based session generation
- Back-to-back weekend scheduling
- Ultra workout type library (vert intervals, power hike, trail tempo, etc.)
- Phase-appropriate session selection
- Strength sessions with eccentric emphasis

### Phase 5: Scheduler Extension
- B2B weekend handling
- Night run placement
- Pack run flagging
- Nutrition practice flagging

### Phase 6: Intent-to-Workout Conversion
- `ultraIntentToWorkout()` producing time + vert descriptions
- Effort-based zones instead of pace targets for trail sessions

### Phase 7: UI
- Home view: time + vert on cards, B2B grouping
- Plan view: weekly hours + D+ display
- Stats view: vert chart, time-on-feet chart, vert-CTL trend
- Workout detail: elevation profile, D+/D-, VAM

### Phase 8: Activity Matching
- Vert-aware matching (D+ tolerance)
- Duration-based matching (for time-on-feet sessions)
- B2B weekend detection
- Hiking activity classification

### Phase 9: Race Prediction
- Elevation-adjusted race time prediction
- Per-section estimates (flat km, climbing time, descent time)
- Aid station time budget (moving time + total time)
- Cut-off pace display
- Crew/pacer adjustments to late-race pace

### Phase 10: Race Week and Race Day
- Sleep strategy display (caffeine timing, nap plan, sleep banking reminders)
- Mental preparation checklist (mantra, process goals, DNF framework)
- Drop bag planner (checklist per aid station)
- Water carry guidance per section
- Crew/pacer meeting points

### Phase 11: Cross-Training and Metabolism
- Hiking reclassified as primary activity (full vert credit in Signal D)
- Cycling substitution suggestions when impact load is high
- Optional fasted easy run flagging in base phase
- Ski touring recognition for winter base building

### Phase 12: Post-Race
- DNF debrief flow (distance completed, reason, controllable factors)
- Recovery plan generation based on actual race distance/effort
- Season planning (A/B/C race spacing rules)

### Phase 13: Female Athlete and Age Adjustments
- RED-S warning flags in recovery/readiness engine
- Optional menstrual cycle tracking with luteal phase heat/nutrition adjustments
- Age-adjusted build:recovery ratios (2:1 for 45+, 3:1 for 30 to 44)
- Increased strength session frequency for masters athletes (40+)

### Phase 14: Race-Day Pacing and Qualification
- Section-by-section pacing strategy from course elevation profile
- Cut-off management: per-aid-station required pace with buffer display
- Hike vs run grade threshold (default 15%, adjustable by VAM)
- UTMB points / Western States qualifying tracker
- Qualifier B race performance targets

---

## 26. Open Questions

These need Tristan's input before implementation.

### Architecture
1. **Shared or separate plan engines?** Recommendation: separate (`plan_engine.ultra.ts`) that reuses utility functions. Same approach as triathlon doc.
2. **Vert-CTL time constants?** Recommended 60-day CTL, 14-day ATL for ultra. Different from standard 42/7. Confirm.
3. **Elevation-adjusted TSS formula?** `adjustedTSS = hrTSS * (1 + (D+ + D-*0.5) / (km * 100))`. Is this the right starting point, or should we start with a simpler linear vert bonus?

### UX
4. **Time vs distance primary display?** Recommendation: time primary for trail sessions, distance primary for road/flat sessions. Is this the right split?
5. **B2B visual grouping?** Two cards connected with a visual indicator? Or a single "weekend" card with two sub-sections?
6. **Vert chart placement?** Separate chart in stats, or integrated into the existing volume chart as a second axis?

### Training Model
7. **Default weekly D+ estimates by terrain access?** The Section 12.3 defaults need confirmation.
8. **Trail slow factors?** rolling: 1.15x, mountain: 1.35x, technical: 1.50x for race prediction. Confirm or provide alternatives.
9. **B2B frequency?** Every 2 to 3 weeks in build/peak. Is this right for all distances, or should 50K be less frequent?
10. **Night run threshold?** Currently proposed only for 100M+. Should 100K races with known night sections also get night runs?

### Nutrition
11. **How deep into nutrition?** Flag on workouts with cal/hr target? Or a full nutrition log with tracking?
12. **Gut training progression targets?** The Section 14.3 progression needs confirmation.

### Sleep and Mental
13. **Sleep strategy in race-week view?** Show caffeine timing, nap strategy, and sleep banking reminders? Or keep it minimal?
14. **Mental training integration?** Display-only guidance (pre-race checklist), or something more structured (mantra input, process goal setup)?
15. **DNF debrief flow?** After a race marked as DNF, prompt for distance completed + reason + what was controllable?

### Cross-Training and Metabolism
16. **Hiking as primary activity?** In ultra mode, should hiking with significant D+ auto-classify as a primary training session (full vert credit) instead of cross-training?
17. **Fat adaptation opt-in?** Offer fasted easy run suggestions in base phase as an opt-in toggle? Or leave nutrition entirely to the user?
18. **Cycling substitution?** When weekly impact load is high, should the engine proactively suggest replacing an easy run with a cycling session?

### Race Logistics
19. **Crew/pacer fields?** Add `hasCrew` and `hasPacer` to race setup? This affects pack weight recommendations and late-race pace prediction.
20. **Aid station time in predictions?** Show both moving time and total time (including aid station budget)?
21. **Water carry guidance?** Calculate recommended carry from longest aid gap + conditions? Or just informational?

### Female Athlete Considerations
22. **RED-S warning integration?** Ultra runners are high-risk for Relative Energy Deficiency in Sport due to chronic caloric deficit. Should the app flag warning signs (missed periods, declining performance despite consistent training, recurring stress injuries, low bone density indicators)? Could tie into the existing recovery/readiness engine.
23. **Menstrual cycle periodisation?** Luteal phase raises core body temperature (~0.3 to 0.5C) and reduces carbohydrate tolerance. Should the plan engine adjust heat/nutrition guidance by cycle phase? Could be an opt-in toggle with cycle tracking input.
24. **Pelvic floor stress?** 100M+ time on feet is significant pelvic floor load. Informational guidance only, or integrate pelvic floor exercises into the strength programme?
25. **Women close the gap at ultra distances.** At 200M+, the performance gap between men and women narrows significantly (Courtney Dauwalter, Jasmin Paris). Race prediction model should use distance-appropriate gender adjustment factors, not road-running ratios.

### Age-Adjusted Training
26. **Age-adjusted recovery?** Peak ultra performance age is 35 to 45 (a full decade later than road running), but recovery slows with age. Should the plan engine factor age into build:recovery ratios? Recommendation: 2:1 for 45+, 3:1 for 30 to 44, standard for under 30. Confirm thresholds.
27. **Volume caps by age?** Older athletes may need lower peak weekly hours but can sustain high volume over longer base periods. Should age affect peak volume targets or just recovery frequency?
28. **Masters-specific strength emphasis?** Athletes 40+ benefit disproportionately from eccentric and stability work (slower tissue repair, higher injury risk). Should the plan increase strength session frequency for older athletes?

### Race-Day Pacing Strategy
29. **Section-by-section pacing?** If a specific race is selected with a known course profile, should the app generate a section-by-section plan ("Hike everything above 15% grade, run flats at Zone 2, descend at X effort, leave aid stations within 5 minutes")? This is the race-week view killer feature.
30. **Cut-off management?** Display per-aid-station cut-off times and required pace to maintain buffer? e.g. "You need to reach aid station 6 by hour 18 to have 2 hours buffer."
31. **Hike vs run threshold?** At what grade should the plan recommend hiking over running? Research suggests ~15% grade is the crossover for most athletes. Should this be adjustable based on the athlete's VAM and running economy?

### Qualification Pathways
32. **UTMB points system?** UTMB requires ITRA running stones from qualifying races within the last 2 years. Should the app track qualifying points and recommend B races that earn the right number of points?
33. **Western States qualifying?** WS requires a qualifying 100-miler under a specific time (varies by age/gender). Should this affect race prediction display and B race target times?
34. **Qualifier as B race?** When a B race is also a mandatory qualifier, it needs a minimum performance standard, not just "80 to 85% effort." Should the plan engine adjust B race taper/effort based on whether it is a qualifier?

### Scope
35. **Season planning?** Build multi-race season support (A/B/C races with spacing rules) now, or just single-race plans?
36. **Altitude prep?** Informational notes only, or programmed acclimatisation sessions?
37. **Stryd power support?** Design for Stryd-optional from the start? This would replace vert-adjusted TSS with proper power-based TSS.
38. **Heat adaptation?** Informational notes or programmed sauna sessions?

---

## Appendix A: Injury Prevention Specific to Ultra

### Common Ultra Injuries

| Injury | Primary Cause | Prevention |
|--------|--------------|------------|
| ITBS | Downhill running, hip weakness | Hip strengthening, progressive descent training |
| Plantar fasciitis | Excessive volume, poor footwear | Calf eccentric work, shoe rotation |
| Ankle sprains | Technical terrain, fatigue-related proprioception loss | Ankle strength, appropriate footwear |
| Knee pain (anterior) | Eccentric loading from descent | Quad strengthening (eccentric), progressive descent volume |
| Achilles tendinopathy | Volume increase too fast, hill work | Eccentric calf work, 10% rule |
| Stress fractures | Overuse, under-fuelling | Gradual progression, rest days |
| Rhabdomyolysis (rare, serious) | Extreme eccentric loading in untrained individuals, heat, dehydration | Progressive eccentric training, hydration |

### Eccentric Loading Progression (12-Week Pre-Race)

**Weeks 1 to 4 (introduce):**
- 1 downhill session/week, 200 to 400m descent total
- 1 gym session/week with eccentric emphasis
- Expect DOMS initially. Diminishes with repeated bout effect.

**Weeks 5 to 8 (build tolerance):**
- 2 downhill-focused sessions/week, 400 to 800m descent total
- Increase pace on descents gradually
- DOMS should be minimal by week 6 to 8

**Weeks 9 to 12 (race-specific):**
- Long runs include full descent volume similar to race
- Technical downhill practice
- Gym eccentric work transitions to maintenance

### Terrain Adaptation Progression

- Week 1 to 2: Fire roads and smooth trails only
- Week 3 to 4: Introduce single-track with moderate roots/rocks
- Week 5 to 6: Technical single-track, some scrambling
- Week 7 to 8: Full race-similar terrain for long runs
- Week 9+: All long runs on race-type terrain

### When to Pull Back

Red flags requiring reduced training:
- Resting heart rate elevated >5 bpm for 3+ consecutive days
- HRV depressed >15% from baseline for 3+ days
- Any acute pain that alters gait
- Dark urine despite adequate hydration (rhabdomyolysis risk)
- Persistent fatigue not resolved by 2 rest days
- Loss of motivation combined with physical symptoms

**Rule:** It is always better to arrive at an ultra 10% undertrained than 1% overtrained. Undertrained, you finish slower. Overtrained, you DNF.

---

## Appendix B: Vertical Intensity Factor

Not all vert is equal.

| Grade | Mode | Relative Muscular Cost |
|-------|------|----------------------|
| 5 to 8% | Runnable uphill | 1.0x baseline |
| 8 to 12% | Run/hike transition | 1.3x |
| 12 to 20% | Power hiking | 1.5x |
| 20 to 30% | Steep hiking (hands on knees) | 1.8x |
| 30%+ | Scrambling | 2.0x+ |

**Descent cost:**
- Descent is cardiovascularly cheap but eccentrically expensive
- 1,000m of descent causes more muscle damage than 1,000m of ascent
- Downhill running at 10 to 15% grade for extended periods is the primary cause of quad failure in ultras
- DOMS from eccentric loading peaks at 48 to 72 hours, not immediately
