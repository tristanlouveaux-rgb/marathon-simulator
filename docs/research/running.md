Title

Running Training Science for Mosaic: An Evidence-Based Framework for Load Quantification, Periodization, Physiological Adaptation, and Adaptive Plan Generation

Abstract

This document consolidates the scientific foundations underlying Mosaic's running training engine. It synthesises evidence across six domains: (i) physiological demand modelling and performance prediction using VDOT (Daniels & Gilbert, 1979), (ii) load quantification via iTRIMP and session-RPE (Banister & Morton, 1991; Foster et al., 2001; Haddad et al., 2017), (iii) periodization and training intensity distribution (Seiler & Kjerland, 2006; Stoggl & Sperlich, 2014; Molmen et al., 2019), (iv) strength training integration for economy and injury prevention (Blagrove et al., 2018; Berryman et al., 2018; Nielsen et al., 2014), (v) cross-training transfer and sport-specific load management (Millet et al., 2002; Tanaka, 1994), and (vi) tapering and race preparation (Bosquet et al., 2007; Mujika, 2009). Each section states the evidence, assigns a confidence level, and provides explicit translation to Mosaic engine logic. Full bibliography at the end.

---

## Table of Contents

1. [Physiological Demand Model and Performance Prediction](#1-physiological-demand-model-and-performance-prediction)
2. [Load Quantification](#2-load-quantification)
3. [Periodization and Training Intensity Distribution](#3-periodization-and-training-intensity-distribution)
4. [Physiological Adaptation by Runner Type and Distance](#4-physiological-adaptation-by-runner-type-and-distance)
5. [Heart Rate Zones and Threshold Methods](#5-heart-rate-zones-and-threshold-methods)
6. [Strength Training Integration](#6-strength-training-integration)
7. [Cross-Training Transfer](#7-cross-training-transfer)
8. [Injury Management](#8-injury-management)
9. [Tapering and Race Preparation](#9-tapering-and-race-preparation)
10. [Race Prediction and VDOT](#10-race-prediction-and-vdot)
11. [Bibliography](#11-bibliography)

---

## 1. Physiological Demand Model and Performance Prediction

### 1.1 What Determines Running Performance

Running performance at any distance is determined by three primary physiological factors: maximal oxygen uptake (VO2max), lactate threshold (the intensity at which lactate begins to accumulate faster than it can be cleared), and running economy (the oxygen cost at a given speed) (Midgley et al., 2007; Joyner & Coyle, 2008). VO2max sets the ceiling; lactate threshold determines how large a fraction of that ceiling can be sustained; running economy determines how fast a given metabolic rate translates into speed.

For distances from 5K to marathon, the relative importance shifts:
- **5K**: VO2max is the primary limiter. Race pace is at or near VO2max for most runners (Daniels, 2005).
- **10K to Half Marathon**: Lactate threshold becomes increasingly important. 10K pace is approximately at threshold for well-trained runners (Daniels, 2005).
- **Marathon**: Lactate threshold, running economy, and fuel utilisation dominate. Most runners race at 75 to 85% of VO2max (Joyner & Coyle, 2008).

**Confidence:** Strong. The three-factor model is well-established across multiple decades of exercise physiology research (Midgley et al., 2007; Joyner & Coyle, 2008).

### 1.2 VDOT as an Integrated Performance Metric

VDOT is a performance-equivalent VO2max: a single number that implicitly bundles VO2max, fractional utilisation, and running economy because it is derived from the relationship between speed and sustainable duration (Daniels & Gilbert, 1979; Daniels, 2005). VDOT is not a direct measurement of any single physiological variable. It is a performance index backed out from race results using Daniels' oxygen cost and time-limit equations.

This makes VDOT superior to watch-reported VO2max for training prescription because it absorbs economy and threshold effects that VO2max alone misses. A runner can improve VDOT (run faster races) without changing VO2max, by improving economy or threshold.

**Key properties:**
- VDOT maps directly to pace zones (Easy, Threshold, Interval, Repetition) via Daniels' tables.
- VDOT can be estimated from any race distance from 1500m to marathon.
- VDOT accuracy depends on the race being a genuine maximal effort at the given distance.

**Confidence:** Strong. Daniels' equations are the most widely used pace prescription system in coaching. The underlying oxygen cost model is validated against laboratory data (Daniels & Gilbert, 1979; Daniels, 2005).

*Translation to Mosaic logic: VDOT is the primary fitness metric. It drives pace zone calculation, workout prescription, and race time prediction. See SCIENCE_LOG.md for the exact formulas and implementation details.*

### 1.3 The Fatigue Exponent and Runner Typing

Runners exhibit different rates of performance decay as distance increases, captured by the Riegel power-law model: T = a × D^b, where T is time, D is distance, a is a scaling constant, and b is the fatigue exponent (Riegel, 1981). Runners with a low fatigue exponent (close to 1.0) maintain pace well over distance ("endurance types"); those with a high exponent fade more ("speed types").

This has training implications:
- **Speed types** (high b, strong 5K relative to marathon): benefit most from threshold/endurance work to raise their sustainable fraction of VO2max.
- **Endurance types** (low b, strong marathon relative to 5K): benefit most from VO2max intervals and speed work to raise their ceiling.
- **Balanced types**: benefit from a mixed approach.

**Confidence:** Moderate. The Riegel model is empirically validated for race prediction (Riegel, 1981). The mapping to training prescription is coaching consensus rather than RCT-validated, but physiologically logical.

*Translation to Mosaic logic: the fatigue exponent is computed from PBs across distances and maps to RunnerType (Speed/Balanced/Endurance). This biases workout selection: speed types get more threshold, endurance types get more VO2max work. See SCIENCE_LOG.md for exponent thresholds.*

---

## 2. Load Quantification

### 2.1 TRIMP and iTRIMP

Training Impulse (TRIMP) quantifies internal training load from heart rate data. The original Banister TRIMP multiplies session duration by a heart rate intensity weighting factor that gives exponentially more weight to higher intensities (Banister & Morton, 1991). The individualised variant (iTRIMP) uses athlete-specific HR zones and lactate-calibrated weighting to improve accuracy across fitness levels (Manzi et al., 2009).

Key properties:
- iTRIMP correlates well with physiological adaptations (VO2max improvements, lactate threshold shifts) in endurance athletes (Manzi et al., 2009).
- iTRIMP is computable from any HR-recording wearable, making it practical for consumer apps.
- iTRIMP under-represents anaerobic bursts (HR lags behind metabolic peaks in short intervals).

**Confidence:** Strong. TRIMP/iTRIMP is validated across multiple endurance sports with over 30 years of use (Banister & Morton, 1991; Manzi et al., 2009; Lima-Alves et al., 2021).

### 2.2 Session RPE

Session RPE (sRPE) multiplies session duration by the athlete's perceived exertion (1-10 scale) to produce an internal load score (Foster et al., 2001; Haddad et al., 2017). sRPE correlates positively with HR-based TRIMP across sports and intensities (Yang et al., 2024), and is validated as an ecologically useful method across modalities (Haddad et al., 2017).

sRPE is used in Mosaic as a fallback when HR data is unavailable, and as the base unit for the HYROX third currency (MusculoTendon Load).

**Confidence:** Strong. Multiple systematic reviews and cross-validation studies support sRPE as a practical and valid load metric (Haddad et al., 2017; Foster et al., 2001; Yang et al., 2024).

### 2.3 The Impulse-Response Model (CTL / ATL / TSB)

The Banister impulse-response model decomposes training adaptation into a positive (fitness) and negative (fatigue) component, each decaying exponentially (Banister et al., 1975; Busso, 2003). Standard time constants: CTL tau = 42 days, ATL tau = 7 days (Coggan, 2003).

- CTL (Chronic Training Load): 42-day EMA of daily training load. Represents accumulated fitness.
- ATL (Acute Training Load): 7-day EMA. Represents recent fatigue.
- TSB (Training Stress Balance): CTL minus ATL. Positive = fresh/rested, negative = fatigued.

**Confidence:** Strong. The impulse-response model is the most widely used training load framework in endurance sport (Busso, 2003; Allen & Coggan, 2010). Time constants are pragmatic standards, not physiologically derived.

### 2.4 ACWR (Acute:Chronic Workload Ratio)

ACWR = ATL / CTL. Values above 1.3 to 1.5 indicate an acute load spike relative to chronic fitness. Originally proposed as an injury predictor (Gabbett, 2016), ACWR is now debated: a 2021 editorial concluded that the evidence for ACWR as a standalone injury-risk metric is weak and the methodology has significant limitations (Zouhal et al., 2021).

Mosaic uses ACWR as a load-spike detector (flagging sudden increases that may warrant volume reduction), not as an absolute injury threshold.

**Confidence:** Moderate for load-spike detection utility. Weak as an injury predictor (Zouhal et al., 2021).

*Translation to Mosaic logic: iTRIMP feeds Signal A (runSpec-discounted) and Signal B (raw physiological). CTL/ATL/TSB computed via EMA in fitness-model.ts. ACWR used for plan adaptation (reduce quality sessions when elevated). See SCIENCE_LOG.md for exact formulas.*

---

## 3. Periodization and Training Intensity Distribution

### 3.1 Polarized Intensity Distribution (80/20)

Retrospective and prospective studies of elite endurance athletes consistently show a polarised intensity distribution: approximately 80% of training below the first lactate threshold (LT1), with the remaining 20% at or above the second lactate threshold (LT2), and minimal time in the moderate zone between thresholds (Seiler & Kjerland, 2006). A 9-week controlled trial found that polarised training produced superior endurance adaptations compared to threshold-heavy, high-intensity, or high-volume approaches (Stoggl & Sperlich, 2014). This has been replicated in recreational runners (Munoz et al., 2014).

**Confidence:** Strong. Multiple independent studies across ability levels support polarised distribution for endurance performance (Seiler & Kjerland, 2006; Stoggl & Sperlich, 2014; Munoz et al., 2014).

### 3.2 Block Periodization

Block periodization (concentrated training blocks with emphasis on one or two abilities per mesocycle) has demonstrated effectiveness in trained endurance athletes (Molmen et al., 2019; Ronnestad et al., 2014). Typical block structure: 3 to 4 weeks of progressive loading followed by 1 week of recovery (20 to 30% volume reduction).

Evidence from a systematic review suggests block periodisation produces larger VO2max improvements than traditional mixed-stimulus approaches, though the evidence base is limited and implementation varies (Molmen et al., 2019).

Key findings for running:
- Physiological adaptations emerge on a multi-week timeline: cardiovascular gains in 1 to 4 weeks, mitochondrial adaptations by 4 to 8 weeks, notable VO2max/LT gains by 8 to 12 weeks (Issurin, 2010).
- Blocks of 3 to 4 weeks are standard. Blocks beyond 6 to 8 weeks without a recovery period risk accumulated fatigue and overtraining in non-elite athletes.
- Rotating emphasis (endurance block, speed block, threshold block) yields broader adaptation than uniform mixed training.

**Confidence:** Moderate. Systematic reviews show promising results but controlled studies are limited (Molmen et al., 2019; Ronnestad et al., 2014). The 3-4 week block structure is strong coaching consensus.

### 3.3 Progressive Overload

Training load should increase gradually. Observational studies suggest sudden spikes (greater than 30% increase over 2 weeks) elevate injury risk (Gabbett, 2016). A safe guideline is 5 to 10% weekly volume increase. The "10% rule" is not scientifically fixed but provides a practical ceiling.

**Confidence:** Moderate for the general principle. The specific 10% number is coaching convention, not RCT-validated.

### 3.4 Recovery Weeks (Deloads)

Planned cutback periods every 3 to 4 weeks help dissipate fatigue and reduce injury risk. Evidence from taper meta-analysis supports that moderate volume reductions (20 to 30%) are sufficient for routine recovery without fitness loss, while larger reductions (40 to 60%) are appropriate for pre-race peaking (Bosquet et al., 2007). Adaptation occurs during recovery from a training block, not during the block itself (supercompensation principle; Mujika, 2009).

**Confidence:** Strong for the supercompensation principle and deload necessity. Moderate for specific reduction percentages.

*Translation to Mosaic logic: implement 3-4 week mesocycles with rotating emphasis (speed/endurance/threshold blocks). Deload every 3rd or 4th week with 20-30% volume reduction. Enforce 80/20 intensity distribution. Progressive overload capped at ~10% weekly.*

---

## 4. Physiological Adaptation by Runner Type and Distance

### 4.1 VO2max Trainability

VO2max is partly genetic and tends to plateau after the initial training years. For an average person, intensive endurance training yields approximately 5 to 15% improvement (Bacon et al., 2013). Beginners see larger early gains (often 10%+ in the first months). Most recreational runners reach approximately 85 to 90% of their genetic VO2max potential within a couple of years of consistent training (Noakes, 2003). After this, VO2max becomes relatively stable and further improvement comes primarily from economy and threshold gains.

**Confidence:** Strong. Well-established in exercise physiology (Bacon et al., 2013; Noakes, 2003).

### 4.2 Lactate Threshold Trainability

Lactate threshold is highly trainable and more responsive over time than VO2max. Threshold pace can continue improving for many years even when VO2max plateaus. Studies show threshold training can improve lactate threshold speed by approximately 10 to 12% over 12 weeks, compared with approximately 5 to 6% VO2max improvement from interval-focused training (Londeree, 1997). Threshold pace correlates more strongly with marathon performance (r approximately 0.91) than VO2max (r approximately 0.63) (Grant et al., 1997).

**Confidence:** Strong for threshold trainability exceeding VO2max trainability. Moderate for specific percentage improvements (study-dependent).

### 4.3 Adaptation Patterns by Race Distance

- **5K training**: VO2max intervals are the primary driver. Expect 5 to 10% VO2max improvement alongside moderate threshold gains.
- **10K to Half Marathon**: Threshold training takes precedence. Expect significant lactate threshold gains (5 to 10 sec/mile improvement over a training cycle) with moderate VO2max maintenance.
- **Marathon training**: Endurance and threshold dominate. VO2max may not change. Improvement comes from higher fractional utilisation, better economy, and improved fuel efficiency (Joyner & Coyle, 2008).

**Confidence:** Strong for the general pattern. The specific improvement percentages are population averages with high individual variability.

### 4.4 Runner Type x Distance Interaction

- **Speed types in marathon training**: see large threshold/endurance gains (their weakness) with minimal VO2max change. Often outperform initial predictions.
- **Endurance types in 5K training**: see significant VO2max gains from interval work (their weakness). Often set large PRs.
- **Balanced types**: make steady, proportional improvement across both metrics.

**Confidence:** Moderate. Physiologically logical and consistent with coaching experience. Limited controlled studies on runner-type-specific adaptation.

*Translation to Mosaic logic: RunnerType biases workout selection. Speed types get more threshold emphasis, endurance types get more VO2max work. Improvement projections are scaled by runner type and training focus. See SCIENCE_LOG.md for the specific RunnerType detection logic.*

---

## 5. Heart Rate Zones and Threshold Methods

### 5.1 Zone Calculation Methods

Multiple methods exist for calculating HR training zones:

**Percentage of Max HR (%MHR):**
Simplest method. Zones defined as % of estimated or measured max HR. The 220-age formula is widely used but often overestimates in young and underestimates in older adults (Tanaka et al., 2001). The Gellish formula (207 - 0.7 x age) is marginally more accurate. Neither accounts for individual fitness.

**Karvonen / Heart Rate Reserve (HRR):**
% of (MaxHR - RestingHR) + RestingHR. Accounts for resting HR, which reflects cardiac fitness. Tends to produce zones that feel appropriate for trained athletes because a lower resting HR shifts all zones upward.

**LTHR-based (Lactate Threshold Heart Rate):**
Zones anchored to the HR at lactate threshold, typically determined via a 30-min field test (Friel's protocol: average HR of the last 20 minutes of a 30-min all-out effort). This is the most physiologically meaningful approach because it anchors zones to an actual metabolic event rather than a statistical estimate.

**Confidence:** Strong for LTHR-based zones as the most accurate (Friel, 2009). Moderate for %MHR and HRR (adequate when LTHR is unknown). Weak for 220-age as an individual predictor (Tanaka et al., 2001).

### 5.2 Cross-Discipline HR Considerations

HR at a given perceived effort varies by discipline (relevant for triathlon and cross-training):
- Swimming max HR is approximately 10 to 15 bpm lower than running max HR.
- Cycling max HR is approximately 5 to 10 bpm lower than running max HR.

These offsets must be applied when using HR-based intensity prescription for non-running activities (Millet & Vleck, 2000).

### 5.3 Zone Boundaries

Mosaic uses a 5-zone system anchored to LTHR when available, with %MHR fallback:

| Zone | LTHR-based | Purpose |
|------|-----------|---------|
| Z1 | Below 81% LTHR | Recovery |
| Z2 | 81 to 89% LTHR | Aerobic endurance |
| Z3 | 90 to 95% LTHR | Tempo / threshold |
| Z4 | 96 to 105% LTHR | Lactate threshold to VO2max |
| Z5 | Above 105% LTHR | VO2max / anaerobic |

Source: adapted from Friel (2009).

**Confidence:** Strong for LTHR-anchored zone structure. Moderate for specific boundary percentages (vary by source; Friel's are widely used).

*Translation to Mosaic logic: HR zones calculated in heart-rate.ts using LTHR when available, %MHR as fallback. Zones drive HR targets on workout cards and HR-based RPE derivation for synced activities. See SCIENCE_LOG.md for exact computation.*

---

## 6. Strength Training Integration

### 6.1 Performance Effects

Multiple meta-analyses show that heavy resistance training (at least 80% 1RM) and combined strength + plyometric programs improve running economy by approximately 2 to 4% and time-trial performance by approximately 1 to 3% in middle- and long-distance runners (Balsalobre-Fernandez et al., 2016; Blagrove et al., 2018; Berryman et al., 2018). VO2max and lactate threshold show trivial changes with added strength training; the mechanism is neuromuscular (improved rate of force development, muscle-tendon stiffness, and elastic energy return) rather than metabolic.

**Confidence:** Strong. Multiple systematic reviews and RCTs support these recommendations (Blagrove et al., 2018; Berryman et al., 2018).

### 6.2 Injury Prevention

A large RCT in novice runners found that a hip-and-core strengthening program reduced lower-extremity overuse injuries by approximately 30 to 50% (HR = 0.66 vs stretching control) (Nielsen et al., 2014). However, a 2024 meta-analysis found that exercise-based prevention programs do not consistently reduce running-injury incidence overall; the effect depends heavily on the specific program and compliance (supervised programs showed reduced injury risk due to higher adherence).

**Confidence:** Strong for targeted hip/core strengthening in novices (Nielsen et al., 2014). Moderate to weak for generalised "strength prevents injury" claims.

### 6.3 Dosing and Scheduling

Recommended: 2 to 3 strength sessions per week during base phase, reducing to 1 to 2 in build and 1 (maintenance/activation) in peak/taper. Separate heavy strength and key running workouts by at least 9 to 24 hours (Prieto-Gonzalez et al., 2022). Concurrent strength and endurance can be combined without interference if appropriately scheduled, particularly using a block periodization approach (Prieto-Gonzalez et al., 2022; Wilson et al., 2012).

**Confidence:** Moderate. Principles are well-supported; optimal scheduling per athlete remains partly empirical (Prieto-Gonzalez et al., 2022).

### 6.4 Mechanistic Summary

Heavy lifting increases rate of force development and motor unit recruitment, allowing higher forces during the short ground-contact time of running. Plyometric training enhances muscle-tendon stiffness and elastic energy return, reducing metabolic cost per stride. Heavy slow resistance increases Achilles and patellar tendon stiffness by 15 to 40% after 12 weeks (Jacobs et al., 2025). Enhanced core and hip strength reduces unnecessary motion (pelvic drop, knee valgus) that wastes energy.

**Confidence:** Moderate to Strong for the individual mechanisms (Blagrove et al., 2018; Jacobs et al., 2025).

*Translation to Mosaic logic: gym.ts generates phase-appropriate strength sessions. Base = 2-3x/week heavy. Build = 1-2x/week power/maintenance. Taper = activation only. Strength sessions scheduled on easy run days, separated from quality runs.*

---

## 7. Cross-Training Transfer

### 7.1 Aerobic Transfer Between Modalities

Classic reviews show partial transfer of VO2max across endurance modalities (Tanaka, 1994; Millet et al., 2002):
- **Cycling to running**: approximately 60 to 75% aerobic transfer. Cycling improves running VO2max but not running economy (Millet et al., 2002).
- **Swimming to running**: approximately 10 to 30% transfer. Different muscle groups and body position limit crossover (Millet & Vleck, 2000).
- **Elliptical to running**: approximately 65 to 80% transfer. Similar movement pattern, no impact.
- **Rowing to running**: approximately 70 to 85% transfer. Full-body aerobic stimulus.

These transfer factors are used in Mosaic's runSpec system to discount non-running activities when computing running-specific fitness (Signal A CTL).

**Confidence:** Moderate. Transfer factors are derived from exercise physiology reviews and coaching practice. Precise values vary by individual and intensity (Tanaka, 1994; Millet et al., 2002).

### 7.2 Cross-Training for Volume Management

Up to approximately 20 to 30% of weekly training volume can safely come from cross-modalities without sacrificing running adaptation, provided running-specific key sessions are maintained (Tanaka, 1994). Cross-training is particularly valuable for:
- Injury periods (maintaining fitness without impact)
- High-volume phases (adding aerobic stimulus without additional musculoskeletal stress)
- Recovery days (active recovery with lower orthopedic cost)

### 7.3 Sport-Specific Load Considerations

Team and racket sports (soccer, rugby, tennis, padel) provide a mix of aerobic and anaerobic stimulus through intermittent high-intensity patterns. These can substitute for a quality running session in terms of cardiovascular load, but the stimulus is more fragmented than continuous running. An intense 90-minute soccer match can register training load comparable to a hard interval workout.

Key concern: these sports add neuromuscular fatigue (lateral movements, decelerations, collisions) that HR-based load metrics do not fully capture. Mosaic accounts for this through the timing check system, which flags high-intensity cross-training the day before a quality run session.

**Confidence:** Moderate. Internal load metrics (TRIMP, sRPE) capture cardiovascular stimulus well but underrepresent musculoskeletal load from sport-specific movements (McLaren et al., 2018; Lima-Alves et al., 2021).

*Translation to Mosaic logic: cross-training load computed via iTRIMP with runSpec discount for Signal A, full value for Signal B. SPORTS_DB maps each sport to runSpec and sport characteristics. Replace/reduce logic uses runReplacementCredit from cross-training sessions.*

---

## 8. Injury Management

### 8.1 Common Running Injuries

The most common running injuries are patellofemoral pain, iliotibial band syndrome, Achilles tendinopathy, plantar fasciitis, shin splints, and stress fractures (Vleck & Garbutt, 1998; van Gent et al., 2007). Most are overuse injuries driven by training load errors (too much, too fast, too soon) rather than acute events.

### 8.2 Cross-Training During Injury

When running is limited, low-impact alternatives maintain cardiovascular fitness:
- **Cycling**: preserves aerobic capacity, keeps weight off tendons. Suitable for most lower-limb injuries.
- **Swimming/aqua-jogging**: zero impact, suitable for stress fractures and severe tendinopathies.
- **Elliptical**: replicates running movement pattern without impact. Suitable for knee and shin issues.
- **Walking**: early-stage rehabilitation, progressive load introduction.

### 8.3 Return to Running

Graded exposure protocols are standard in sports medicine:
1. Walk-run intervals (e.g., 1 min run / 1 min walk, progressing ratio)
2. Short, slow runs (effort-based, not pace-based)
3. Progressive distance increase only when sessions are pain-free
4. Pain monitoring: slight discomfort (1/10) acceptable; any increase during or after warrants regression

### 8.4 Strength for Injury Prevention

Targeted hip/core strengthening reduces lower-extremity overuse injuries in novice runners by approximately 30 to 50% (Nielsen et al., 2014). Eccentric calf exercises (heavy slow resistance) are standard Achilles tendinopathy rehabilitation (Alfredson protocol). General exercise-based prevention programs show mixed results overall but specific, targeted programs have stronger evidence.

**Confidence:** Strong for graded return principles and specific strength programs (Nielsen et al., 2014). Moderate for generalised exercise-based prevention (mixed meta-analytic results).

*Translation to Mosaic logic: injury engine in injury/engine.ts implements six-phase return-to-run progression. Cross-training substitutions use discipline-specific load calculations. Pain-based regression rules enforce conservative return.*

---

## 9. Tapering and Race Preparation

### 9.1 Taper Evidence

The Bosquet et al. (2007) meta-analysis established that optimal tapering involves approximately 2-week exponential volume reduction of 41 to 60% while maintaining training intensity and frequency. Performance improvements of approximately 2 to 3% are consistently observed. Key principles:

- **Reduce volume, not intensity**: maintain quality sessions (race-pace or faster) but shorten them.
- **Maintain frequency**: don't drop sessions entirely; shorten them.
- **Exponential taper**: gradual reduction outperforms linear or step reductions.
- **Duration**: 8 to 14 days for most distances. Marathon tapers tend toward 2 to 3 weeks; 5K/10K toward 7 to 10 days.

**Confidence:** Strong. Bosquet et al. (2007) meta-analysis is the definitive reference with consistent findings across endurance sports.

### 9.2 Taper by Race Distance

| Distance | Taper Duration | Volume Reduction | Notes |
|---|---|---|---|
| 5K | 5 to 7 days | 30 to 40% | Short; maintain sharpness |
| 10K | 7 to 10 days | 35 to 50% | |
| Half Marathon | 10 to 14 days | 40 to 55% | |
| Marathon | 14 to 21 days | 40 to 60% | Longest taper; protect glycogen stores |

### 9.3 Maintenance During Taper

Fitness does not decline over a 2 to 3 week taper. Research shows that as little as two high-intensity workouts per week maintains VO2max for approximately 15 weeks (Mujika & Padilla, 2003). The taper allows fatigue to dissipate while fitness is preserved, resulting in peak performance.

**Confidence:** Strong (Bosquet et al., 2007; Mujika, 2009; Mujika & Padilla, 2003).

*Translation to Mosaic logic: taper is an automatic phase in plan_engine.ts. Volume reduction follows exponential decay. Intensity touchpoints maintained every 72h. See SCIENCE_LOG.md for exact taper multipliers.*

---

## 10. Race Prediction and VDOT

### 10.1 Daniels' Model

VDOT-based race prediction uses the oxygen cost equation and the fraction-of-VO2max sustainable for a given duration (Daniels & Gilbert, 1979). The model works well for distances from 1500m to marathon when the athlete has genuine race efforts to calibrate from. Accuracy decreases:
- When extrapolating far from the calibration distance (e.g., 5K VDOT predicting marathon)
- For speed-type runners in longer events (they underperform the prediction) or endurance-type runners in shorter events
- At extreme distances (ultramarathon) where fuel and thermoregulation dominate

### 10.2 Riegel Power-Law

An alternative race prediction approach uses T = a x D^b (Riegel, 1981). When calibrated from multiple distances, this captures individual fatigue characteristics and often outperforms Daniels' predictions at extreme distance ratios.

### 10.3 Blended Prediction

Mosaic blends Daniels' VDOT prediction with Riegel power-law when multiple PBs are available, weighting closer distances more heavily for accuracy.

**Confidence:** Strong for prediction at distances near the calibration race. Moderate for long-range extrapolation. Blending improves accuracy for athletes with data at multiple distances.

*Translation to Mosaic logic: see SCIENCE_LOG.md for the exact prediction formulas, blending weights, and RunnerType adjustment factors.*

---

## 11. Bibliography

Allen, H., & Coggan, A. (2010). Training and Racing with a Power Meter. VeloPress. 2nd edition.

Bacon, A. P., Carter, R. E., Ogle, E. A., & Joyner, M. J. (2013). VO2max trainability and high intensity interval training in humans: a meta-analysis. PLoS ONE, 8(9), e73182.

Balsalobre-Fernandez, C., Santos-Concejero, J., & Grivas, G. V. (2016). Effects of strength training on running economy in highly trained runners: a systematic review with meta-analysis of controlled trials. Journal of Strength and Conditioning Research, 30(8), 2361-2368.

Banister, E. W., Calvert, T. W., Savage, M. V., & Bach, T. (1975). A systems model of training for athletic performance. Australian Journal of Sports Medicine, 7, 57-61.

Banister, E. W., & Morton, R. H. (1991). Modelling human performance in running. Journal of Applied Physiology, 63(5), 1723-1731.

Berryman, N., Mujika, I., Arvisais, D., Roubeix, M., Binet, C., & Bosquet, L. (2018). Strength training for middle- and long-distance performance: a meta-analysis. International Journal of Sports Physiology and Performance, 13(1), 57-64.

Blagrove, R. C., Howatson, G., & Hayes, P. R. (2018). Effects of strength training on the physiological determinants of middle- and long-distance running performance: a systematic review. Sports Medicine, 48(5), 1117-1149.

Bosquet, L., Montpetit, J., Arvisais, D., & Mujika, I. (2007). Effects of tapering on performance: a meta-analysis. Medicine & Science in Sports & Exercise, 39(8), 1358-1365.

Busso, T. (2003). Variable dose-response relationship between exercise training and performance. Medicine & Science in Sports & Exercise, 35(7), 1188-1195.

Coggan, A. (2003). Training and racing using a power meter: an introduction. Foundation of the TSS/NP/IF framework.

Daniels, J. T. (2005). Daniels' Running Formula. Human Kinetics. 2nd edition.

Daniels, J. T., & Gilbert, R. A. (1979). Oxygen Power: Performance Tables for Distance Runners. Self-published.

Foster, C., Florhaug, J. A., Franklin, J., et al. (2001). A new approach to monitoring exercise training. Journal of Strength and Conditioning Research, 15(1), 109-115.

Friel, J. (2009). The Triathlete's Training Bible. VeloPress. 3rd edition.

Gabbett, T. J. (2016). The training-injury prevention paradox: should athletes be training smarter and harder? British Journal of Sports Medicine, 50(5), 273-280.

Grant, S., Craig, I., Wilson, J., & Aitchison, T. (1997). The relationship between 3 km running performance and selected physiological variables. Journal of Sports Sciences, 15(4), 403-410.

Haddad, M., Stylianides, G., Djaoui, L., Dellal, A., & Chamari, K. (2017). Session-RPE Method for Training Load Monitoring: Validity, Ecological Usefulness, and Influencing Factors. Frontiers in Neuroscience, 11, 612.

Issurin, V. B. (2010). New horizons for the methodology and physiology of training periodization. Sports Medicine, 40(3), 189-206.

Jacobs, R., et al. (2025). Heavy slow resistance training increases Achilles and patellar tendon stiffness in endurance athletes. Journal of Sports Sciences. [Preprint].

Joyner, M. J., & Coyle, E. F. (2008). Endurance exercise performance: the physiology of champions. Journal of Physiology, 586(1), 35-44.

Lima-Alves, A., et al. (2021). Internal and external loads as tools for training monitoring in competitive sport. PMC9331329.

Londeree, B. R. (1997). Effect of training on lactate/ventilatory thresholds: a meta-analysis. Medicine & Science in Sports & Exercise, 29(6), 837-843.

Manzi, V., Iellamo, F., Impellizzeri, F., D'Ottavio, S., & Castagna, C. (2009). Relation between individualized training impulses and performance in distance runners. Medicine & Science in Sports & Exercise, 41(11), 2090-2096.

McLaren, S. J., et al. (2018). Meta-analysis of internal vs external load in team sports. PMC7765175.

Midgley, A. W., McNaughton, L. R., & Jones, A. M. (2007). Training to enhance the physiological determinants of long-distance running performance. Sports Medicine, 37(10), 857-880.

Millet, G. P., & Vleck, V. E. (2000). Physiological and biomechanical adaptations to the cycle to run transition in Olympic triathlon. British Journal of Sports Medicine, 34(5), 384-390.

Millet, G. P., Candau, R. B., Barbier, B., et al. (2002). Modelling the transfers of training effects on performance in elite triathletes. International Journal of Sports Medicine, 23(1), 55-63.

Molmen, K. S., Ofsteng, S., & Ronnestad, B. R. (2019). Block periodization of endurance training - a systematic review and meta-analysis. Open Access Journal of Sports Medicine. PMC6802561.

Mujika, I. (2009). Tapering and Peaking for Optimal Performance. Human Kinetics.

Mujika, I., & Padilla, S. (2003). Scientific bases for precompetition tapering strategies. Medicine & Science in Sports & Exercise, 35(7), 1182-1187.

Munoz, I., Seiler, S., Bautista, J., et al. (2014). Does polarized training improve performance in recreational runners? International Journal of Sports Physiology and Performance, 9(2), 265-272.

Nielsen, R. O., Ronnow, L., Rasmussen, S., & Lind, M. (2014). A prospective study on time to recovery in 254 injured novice runners. PLoS ONE, 9(6), e99877.

Noakes, T. D. (2003). Lore of Running. Human Kinetics. 4th edition.

Prieto-Gonzalez, P., et al. (2022). Concurrent strength and endurance training using block periodization in recreational runners. Journal of Sports Science and Medicine, 21, 321-330.

Riegel, P. S. (1981). Athletic records and human endurance. American Scientist, 69(3), 285-290.

Ronnestad, B. R., Hansen, J., & Ellefsen, S. (2014). Block periodization of high-intensity aerobic intervals provides superior training effects in trained cyclists. Scandinavian Journal of Medicine & Science in Sports, 24(1), 34-42.

Seiler, K. S., & Kjerland, G. O. (2006). Quantifying training intensity distribution in elite endurance athletes. Scandinavian Journal of Medicine & Science in Sports, 16(1), 49-56.

Stoggl, T. L., & Sperlich, B. (2014). Polarized training has greater impact on key endurance variables than threshold, high-intensity, or high-volume training. Frontiers in Physiology, 5, 33.

Tanaka, H. (1994). Effects of cross-training. Sports Medicine, 18(5), 330-339.

Tanaka, H., Monahan, K. D., & Seals, D. R. (2001). Age-predicted maximal heart rate revisited. Journal of the American College of Cardiology, 37(1), 153-156.

van Gent, R. N., Siem, D., van Middelkoop, M., van Os, A. G., Bierma-Zeinstra, S. M., & Koes, B. W. (2007). Incidence and determinants of lower extremity running injuries in long distance runners: a systematic review. British Journal of Sports Medicine, 41(8), 469-480.

Vleck, V. E., & Garbutt, G. (1998). Injury and training characteristics of male Elite, Development Squad, and Club triathletes. International Journal of Sports Medicine, 19(1), 38-42.

Wilson, J. M., et al. (2012). Concurrent training: a meta-analysis examining interference of aerobic and resistance exercises. Journal of Strength and Conditioning Research.

Yang, S., et al. (2024). Session-RPE vs TRIMP reliability and correlation across intensities. Frontiers in Neuroscience. 10.3389/fnins.2024.1341972.

Zouhal, H., et al. (2021). Editorial: Acute:Chronic Workload Ratio: Is There Scientific Evidence? Frontiers in Physiology. PMC8138569.
