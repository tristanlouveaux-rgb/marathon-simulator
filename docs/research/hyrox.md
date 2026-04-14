Title

Integrating HYROX into Mosaic: A Research-Grade, Three-Dimensional Load Framework and Adaptive Training Blueprint for Year-Round Hybrid Fitness and Event Performance

Abstract

HYROX is a running-focused high-intensity functional fitness (HIFT) format combining repeated 1-km run intervals with strength-endurance stations. To extend Mosaic’s endurance-centric adaptive engine to HYROX, we propose (i) a physiology-grounded demand model, (ii) a periodized training architecture across ability bands, (iii) a “third currency” capturing musculoskeletal/tendon strain not explained by aerobic/anaerobic load, and (iv) explicit REPLACE/REDUCE/DOWNGRADE logic for hybrid sessions in a three-dimensional similarity space. Evidence from a full simulated HYROX event indicates sustained high cardiovascular and metabolic strain with station-specific spikes in heart rate, blood lactate, and perceived exertion, particularly at wall balls (Brandt et al., 2025). Concurrent training literature suggests interference effects are typically small but modulated by sex, training status, and endurance modality, motivating emphasis blocks and careful hard-day separation (Beattie et al., 2023; Wilson et al., 2012). For tapering, endurance meta-analysis supports ~2-week exponential volume reductions of ~41–60% without reducing intensity/frequency, while HIFT field data (elite CrossFit) show shorter tapers (~5–7 days) with substantial volume reductions, informing HYROX-specific taper prescriptions (Bosquet et al., 2007; Pritchard et al., 2020). We translate findings into implementable app logic: component-based HYROX workouts, a station taxonomy with 3D load coefficients, a measurable third-currency computation using session-RPE principles, and a replacement matrix with specificity penalties.

1. Introduction

Mosaic currently plans and adapts running and cross-training using a universal load model (aerobicLoad, anaerobicLoad, fatigueCostLoad, runReplacementCredit) and an adaptation engine that can REPLACE sessions, REDUCE volume/intensity, or DOWNGRADE difficulty based on “vibe matching” and a credit-budget paradigm. HYROX integration must preserve this architecture while adding hybrid-specific physiology, station specificity, and musculoskeletal fatigue management.

HYROX performance is best represented by finish time (primary KPI) with optional decomposition into run-segment and station splits. Athlete profiles (total_beginner → competitive, returning, hybrid) and athlete bias detection (“quick but weak” vs “strong but slow”) must be preserved. Therefore, the system needs: (i) a demand model of HYROX that maps to load currencies, (ii) periodization that blends endurance and strength-endurance, (iii) a third load dimension capturing peripheral/tissue strain, and (iv) explicit substitution and adaptation rules suitable for an adaptive training engine.

2. Methods (Evidence Sourcing Approach)

A targeted literature approach was used with priority to peer-reviewed HYROX/HIFT physiology and determinants, then concurrent training and periodization evidence, then load quantification and tapering science, and finally applied “brick/transition” evidence from triathlon as a structured analogue for repeated modality transitions. Core evidence anchors include a full simulated HYROX physiology study (Brandt et al., 2025), concurrent training meta-analysis (Beattie et al., 2023; Wilson et al., 2012), block periodization systematic review/meta-analysis (Mølmen et al., 2019), session-RPE training load synthesis (Haddad et al., 2017), critiques of acute:chronic workload ratio as an injury-risk heuristic (Zouhal et al., 2021), taper meta-analysis in endurance sport (Bosquet et al., 2007), and elite CrossFit tapering practices as a mixed-modal competition analogue (Pritchard et al., 2020). Brick/transition logic was informed by cycling→running impairment evidence in triathlon contexts (Olcina et al., 2019).

3. Results and System Blueprint

3.1 Physiological Demand Model of HYROX

Empirical HYROX race demands. A simulated HYROX event demonstrated sustained high internal load across the race: heart rate, blood lactate, and RPE remain elevated, with stations producing higher lactate and RPE than runs and wall balls showing the highest heart rate, lactate, and RPE (Brandt et al., 2025). The same study reported that run segments accounted for the largest fraction of total time, supporting a run-dominant pacing and economy requirement under accumulating peripheral fatigue (Brandt et al., 2025). Performance correlates included VO₂max, endurance training volume, and lower body fat percentage (Brandt et al., 2025), consistent with a high aerobic dependency layered with repeated anaerobic spikes and local muscular endurance limitations.

HYROX demand profile across domains.
	•	Aerobic demand: high (dominant). Sustained hard effort across ~60–90 minutes, with run segments being the primary time driver (Brandt et al., 2025).
	•	Anaerobic/metabolic demand: moderate–high. Stations induce metabolic surges (higher lactate and RPE than runs) and repeated high-intensity transitions (Brandt et al., 2025).
	•	Musculoskeletal/tendon/neuromuscular demand: high. Loaded carries, sled work, lunges, burpee broad jumps, and wall balls impose eccentric and bracing-heavy stress that is not well represented by metabolic load alone (Brandt et al., 2025).

Justification for a third load currency. Internal-load-only approaches (e.g., HR, lactate, aerobic/anaerobic TRIMP-like constructs) inadequately represent tissue-specific mechanical strain and peripheral fatigue, particularly relevant to injury risk and “next-run quality” in hybrid formats. Additionally, simple workload ratios (e.g., ACWR) are debated and may misrepresent mechanical/tissue stress, reinforcing the need for a modality- and tissue-aware third dimension (Zouhal et al., 2021).

Station taxonomy by fatigue signature (for engine use).
	•	Heavy grind / bracing-dominant: sled push, sled pull
	•	Eccentric quad + gait disruption: burpee broad jumps, sandbag lunges, wall balls
	•	Cyclical erg power-endurance: SkiErg, RowErg
	•	Grip + trunk stiffness / loaded carry: farmer’s carry
This taxonomy supports (i) targeted weakness development, (ii) replacement penalties, and (iii) third-currency weighting (Brandt et al., 2025).

Confidence level:
	•	Strong: sustained high intensity, station>run lactate/RPE, wall balls as a peak limiter (Brandt et al., 2025).
	•	Moderate: station-by-station “limiter ranking” beyond wall balls (limited HYROX-specific cohorts).

Translation to Mosaic system logic: HYROX workouts should be represented as ordered components: run_segment + station_component (+ optional transition). Each component emits (aerobicLoad, anaerobicLoad) plus the new third-currency load described in §3.3.

3.2 Periodization for Hybrid Endurance + Strength-Endurance

Concurrent training implications. A recent meta-analysis indicates concurrent training produces small interference effects in some outcomes, notably blunted lower-body strength adaptations in males; VO₂max interference was more evident in untrained endurance individuals but not in trained/highly trained endurance athletes (Beattie et al., 2023). Earlier evidence suggests the magnitude of interference depends on endurance modality, frequency, and duration (Wilson et al., 2012). Therefore, HYROX periodization should not attempt to “avoid concurrency,” but rather manage it with emphasis blocks, hard-day separation, and appropriate dosage to preserve quality in both running and station work.

Block periodization evidence. Block periodization has support as an alternative organization strategy in trained athletes, with promising performance-related outcomes though implementation varies (Mølmen et al., 2019). For HYROX, this supports cycling emphases (e.g., run-economy emphasis vs station-specific emphasis) while maintaining minimal doses of the other quality.

Recommended continuous year-round block structures (4-week cycles)
A) total_beginner / beginner
	•	Goal: consistency, movement skill, tissue tolerance, basic aerobic density
	•	Cycle: 2 build weeks → 1 consolidate → 1 deload (–25–40% total load)
	•	Weekly frequency: runs 2; stations 2; bricks 1 (controlled)

B) novice / intermediate
	•	Goal: threshold/tempo development + station economy + running under peripheral fatigue
	•	Cycle: 2 build → 1 selective overload → 1 deload
	•	Weekly frequency: runs 3; stations 2; bricks 1–2

C) advanced / competitive / hybrid
	•	Goal: specificity, high-quality bricks, sharpen transitions, protect run pace under fatigue
	•	Cycle: 2 build → 1 specific overload → 1 deload (taper-like)
	•	Weekly frequency: runs 3–4; stations 2–3; bricks 2

Race build phases (HYROX-specific)
	•	Base (6–10w): aerobic density + station technique + tissue tolerance
	•	Build (4–8w): increased bricks; threshold work; station density progression
	•	Peak (2–3w): race-specific compromised sessions; reduce novelty and eccentric overload
	•	Taper (5–14d): shorter than marathon taper (see §3.7)

Confidence level:
	•	Strong: concurrent training interference exists and is dose/modality dependent (Beattie et al., 2023; Wilson et al., 2012).
	•	Moderate: block-periodization rationale for emphasis blocks in hybrid contexts (Mølmen et al., 2019).

Translation to Mosaic system logic: Add a hyrox_phase state and phase-specific target distributions for weekly (aerobicLoad, anaerobicLoad, thirdCurrency). Implement “hard-day separation” constraints that factor in third-currency spikes from eccentric/bracing stations.

3.3 The “Third Currency”: Definition and Computation

Rationale. Session-RPE (sRPE) is validated as an ecologically useful method to quantify internal training load across sports and modalities using session duration × perceived intensity (Haddad et al., 2017). However, a HYROX engine also requires a dimension that more directly reflects peripheral musculoskeletal/tendon strain and mechanical loading patterns that drive soreness, readiness, and injury risk—elements not captured by aerobic/anaerobic load alone and not reliably inferred from ACWR-style heuristics (Zouhal et al., 2021).

Candidate definitions
Candidate A (recommended): MusculoTendon Load (MTL)
A third currency designed to represent eccentric damage, bracing-heavy work, loaded carries, and impact/plyometric exposure that materially affects subsequent running quality and recovery.

Candidate B: Neuromuscular Strain Units (NSU)
A third currency designed to represent central/neuromuscular fatigue from high power outputs, heavy lifting near failure, or high velocity loss, where available. Autoregulation constructs (RPE/RIR) are commonly used to reflect readiness and fatigue in resistance training and could support NSU when the app has richer lifting data (Paulsen et al., 2025; Huang et al., 2025).

Selection and justification
Select Candidate A (MTL) as the default third currency because it has stronger compatibility with: (i) wearable + manual inputs, (ii) HYROX station fatigue signatures, and (iii) injury-risk and recovery management concerns in hybrid programming (Haddad et al., 2017; Zouhal et al., 2021).

Computation logic (engine-ready)
At the component level (run segment or station component):
	•	Base internal load (IL):
IL = duration_minutes × sRPE (Haddad et al., 2017)
	•	Third currency (MTL):
MTL = IL × modalityFactor × impactFactor × (1 + externalLoadFactor)

Suggested defaults (tuneable):
	•	modalityFactor (examples):
	•	easy run 0.6; threshold run 0.8; intervals 1.0
	•	Ski/Row erg 0.5
	•	sled push/pull 1.2
	•	farmer carry 1.0
	•	lunges/wall balls 1.1
	•	burpee broad jumps 1.3
	•	impactFactor: erg 0.7; run 1.0; bounding/jumps 1.2–1.4
	•	externalLoadFactor: when known, scale by load relative to bodyweight and cap (e.g., min(0.6, (load_kg/bodyweight_kg)×k); set k by station type)

	•	Saturation / diminishing returns curve (weekly):
To prevent “infinite benefit” from excessive MTL, transform:
effectiveMTL = MTL_cap × (1 − exp(−MTL / MTL_cap))
Set MTL_cap by ability band (lower for beginners, higher for competitive).

Validation strategy (in-app)
Compare prediction and adaptation quality between:
	•	2D model: (aerobicLoad, anaerobicLoad)
	•	3D model: (aerobicLoad, anaerobicLoad, MTL)
Outcomes: HYROX finish time, run pace decay across the 8×1 km, station split stability, and user-reported soreness/readiness.

Confidence level: Moderate (mechanistically justified and measurable; empirical validation requires Mosaic cohort data).
Translation to Mosaic logic: add musculoTendonLoad to universal load outputs and incorporate it into similarity, budgeting, and hard-day separation.

3.4 Replacement & Adaptation Mapping (REPLACE / REDUCE / DOWNGRADE)

Specificity and transferability. Concurrent training evidence supports that modality choices and volume/frequency influence adaptations, making replacement decisions non-trivial (Wilson et al., 2012; Beattie et al., 2023). HYROX physiology indicates stations impose higher lactate and RPE than runs, so substitutions must preserve both metabolic and peripheral fatigue signatures where possible (Brandt et al., 2025).

Definitions (for Mosaic)
REPLACE (HYROX): Substitute a planned session with another that maximizes similarity in 3D load space (aerobicLoad, anaerobicLoad, MTL) while applying a specificity penalty when movement pattern or station signature diverges.
REDUCE: Keep the session type but reduce one of: total volume, intensity target, station reps/rounds, or brick length, preserving session “purpose.”
DOWNGRADE: Shift the workout to an easier tier (interval→tempo→easy; full brick→mini brick→station technique; heavy sled→moderate resistance).

Protected elements (minimal)
In race build only, preserve (or reduce/downgrade rather than replace):
	•	One key brick/week
	•	One quality run/week
Rationale: run segments are the largest portion of race time and performance correlates include aerobic/VO₂max-related capacity (Brandt et al., 2025).

Replacement matrix (examples; with penalties)
Penalties are multipliers applied to “credits” and similarity scoring.
	•	Run intervals ↔ row/bike intervals: 0.85
	•	Run tempo ↔ Ski/Row tempo: 0.80
	•	Easy run ↔ easy bike/elliptical: 0.75
	•	Sled push → hill push / treadmill incline push: 0.90
	•	Sled push → heavy drag/backward drag: 0.80
	•	Sled push → high-resistance bike climb: 0.65
	•	Sled pull → rope pulls/cable row intervals: 0.75 (lower trunk/bracing specificity)
	•	Wall balls → thrusters: 0.85
	•	Wall balls → squat-to-press EMOM: 0.80
	•	Burpee broad jumps → burpee + step-ups: 0.75
	•	Burpee broad jumps → row sprint + burpees: 0.70
	•	Farmer carry → suitcase/DB/trap-bar carry: 0.95
	•	Sandbag lunges → DB walking lunges: 0.90; → split squats high-rep 0.80

3D vibe-matching extension
Represent sessions as vectors V = [aerobicLoad, anaerobicLoad, MTL].
Similarity: sim = cosine_similarity(Vplanned, Vcandidate) × specificityPenalty.
Choose candidate maximizing sim under constraints.

Confidence level: Moderate (grounded in specificity/interference principles + HYROX physiology; station-level transfer trials are limited).
Translation: implement a “substitute library” with 3D load estimates and penalties.

3.5 Brick Sessions: Best Practices & Dosing

Brick training addresses performance impairment in a subsequent modality caused by preceding fatigue; this is documented in triathlon cycling→running contexts and supports the principle of practicing transitions and “compromised” running (Olcina et al., 2019). HYROX effectively repeats transitions eight times, making brick sessions a core specificity tool.

Dosing (numeric guidance)
	•	Beginners: 1 brick/week; 2–4 rounds of (400–800 m easy run + 1 station technique set), RPE 5–7
	•	Novice/Intermediate: 1–2 bricks/week; key brick 4–6 rounds of (800 m–1 km moderate + station RPE 7–8)
	•	Advanced/Competitive: 2 bricks/week; key brick 6–8 rounds and include at least one eccentric-tax station (lunges, wall balls, burpee broad jumps)

Progression rules
Progress one variable at a time: rounds ↑ → run intensity ↑ → station density ↑ (less rest) → external load ↑.

Confidence level: Moderate (supported by transition impairment evidence; HYROX-specific brick trials are limited).
Translation: bricks are structured as component sequences with explicit 3D load targets.

3.6 Benchmarks (Optional)

Benchmarks enable calibration of station fitness, compromised running tolerance, and forecasting. Recommended cadence: every 4–6 weeks for intermediate, 6–10 weeks for advanced (avoid excessive MTL).
	•	Beginner “baby sim”: short run total + 2 stations scaled
	•	Intermediate partial sim: 4×1 km runs + 4 stations
	•	Advanced: 6–8 km and 6–8 stations; full sim sparingly

Confidence level: Emerging (field practice; limited controlled validation).
Translation: benchmarks become datapoints for finish-time model and bias detection.

3.7 Tapering for HYROX

Endurance taper evidence suggests a ~2-week taper with exponential volume reduction of ~41–60% while maintaining intensity and frequency can maximize performance (Bosquet et al., 2007). Mixed-modal elite CrossFit athletes tend to use shorter tapers (~5–7 days) with substantial volume reductions (~40%+), suggesting HYROX may benefit from a shorter taper than marathon training while maintaining neuromuscular “touch” (Pritchard et al., 2020).

Recommended taper windows:
	•	Beginner/Novice: 7–10 days; volume –30–45%
	•	Intermediate: ~7 days; volume –40–55%
	•	Competitive/Hybrid: 5–7 days; volume –40–60%
Maintain intensity touchpoints; avoid novel eccentric overload close to race.

Confidence level: Moderate (endurance taper evidence strong; HYROX-specific taper evidence limited).
Translation: taper is an automatic phase rule altering weekly target distributions and limiting high-MTL exposures.

4. Engine Artifacts Required by Mosaic

4.1 Station Taxonomy with 3D Load Coefficients (relative, 0–10)

(Used as “shape weights,” scaled by duration×sRPE and external load.)
	•	SkiErg: aerobic 7 / anaerobic 5 / MTL 3
	•	Sled push: 5 / 7 / 9
	•	Sled pull: 5 / 7 / 8
	•	Burpee broad jumps: 7 / 7 / 10
	•	Row: 7 / 6 / 3
	•	Farmer carry: 5 / 4 / 8
	•	Sandbag lunges: 6 / 6 / 9
	•	Wall balls: 7 / 7 / 9 (noted peak limiter) (Brandt et al., 2025)

4.2 Third Currency Proposal

Two candidates (MTL vs NSU) → select MTL → compute via IL×(factors), saturate weekly, validate with finish time/splits and next-run quality (Haddad et al., 2017; Zouhal et al., 2021).

4.3 HYROX Adaptation Logic

Explicit REPLACE/REDUCE/DOWNGRADE defined in §3.4, implemented by 3D similarity scoring plus specificity penalties.

4.4 Sample Weeks (illustrative templates)

total_beginner (year-round):
	•	Mon easy run + optional mobility
	•	Tue station technique (scaled)
	•	Thu mini brick (short run + erg)
	•	Sat easy run

novice (race build):
	•	Mon easy run + strides
	•	Tue key brick (1 km + station repeats)
	•	Thu station emphasis (wall balls/lunges scaled)
	•	Sat tempo/threshold blend

intermediate (race build):
	•	Mon easy run
	•	Tue key brick (6×1 km + mixed stations, last runs faster)
	•	Thu stations (wall balls/lunges + limited burpee exposure)
	•	Sat tempo with race-pace touches

competitive/hybrid (race build):
	•	Mon easy run
	•	Tue key brick (7–8 rounds)
	•	Thu secondary brick (lighter flow)
	•	Sat run sharpening (short intervals + station touch)

4.5 Forecasting Model

MVP: Total time = 8×(predicted fatigued 1 km) + Σ station times
Where “fatigued 1 km” is derived from running fitness (existing Mosaic anchors) multiplied by a fatigue factor computed from preceding MTL + anaerobic spikes + athlete bias.
Advanced: multi-output model predicting each run split + station split using features: running anchors, station benchmarks, MTL capacity, recent brick pace decay, and acute MTL spike flags.

5. Discussion

The core engineering insight is that HYROX is not simply “running + strength.” It is repeated running under station-induced peripheral fatigue. The evidence indicates stations drive higher lactate and RPE than runs and wall balls are a consistent late-race limiter, implying a key role for muscular endurance and fatigue resistance beyond aerobic fitness (Brandt et al., 2025). Concurrent training research supports hybrid periodization using emphasis blocks and careful dosing to minimize interference and preserve quality, especially where lower-body strength gains are a priority (Beattie et al., 2023; Wilson et al., 2012). The proposed third currency (MTL) operationalizes musculoskeletal/tendon strain using session-RPE as a scalable base, addressing limitations of simplistic workload ratios and enabling more robust adaptation decisions (Haddad et al., 2017; Zouhal et al., 2021).

6. Conclusion (Deliverable Synthesis)

We propose a HYROX mode for Mosaic that (i) models HYROX as component-based sessions, (ii) periodizes year-round training with race-specific phases across ability bands, (iii) introduces MusculoTendon Load (MTL) as a third currency alongside aerobic/anaerobic load, and (iv) extends REPLACE/REDUCE/DOWNGRADE to hybrid workouts via three-dimensional vibe matching with specificity penalties. This design is evidence-grounded, measurable with wearable + minimal manual inputs, and directly implementable in Mosaic’s existing adaptive training engine.

Bibliography (copy/paste)

Beattie, K., et al. (2023). Concurrent Strength and Endurance Training: A Systematic Review and Meta-Analysis on the Impact of Sex and Training Status. Sports Medicine. (PMC10933151).  

Bosquet, L., Montpetit, J., Arvisais, D., & Mujika, I. (2007). Effects of tapering on performance: a meta-analysis. Medicine & Science in Sports & Exercise, 39(8), 1358–1365.  

Brandt, T., et al. (2025). Acute physiological responses and performance determinants in Hyrox© – a new running-focused high intensity functional fitness trend. Frontiers in Physiology. (PMC11994925).  

Haddad, M., Stylianides, G., Djaoui, L., Dellal, A., & Chamari, K. (2017). Session-RPE Method for Training Load Monitoring: Validity, Ecological Usefulness, and Influencing Factors. Frontiers in Neuroscience, 11, 612.  

Huang, Z., et al. (2025). Autoregulated resistance training for maximal strength enhancement: A systematic review and network meta-analysis. (PMC12336695).  

Mølmen, K. S., Øfsteng, S., & Rønnestad, B. R. (2019). Block periodization of endurance training – a systematic review and meta-analysis. Open Access Journal of Sports Medicine. (PMC6802561).  

Olcina, G., et al. (2019). Effects of cycling on subsequent running performance, stride length and muscle oxygen saturation in triathletes. Sports, 7(5).  

Paulsen, G., et al. (2025). Exercise type, training load, velocity loss threshold, and sets to failure: considerations for fatigue and strength adaptations. (PMC12360324).  

Pritchard, H. J., Keogh, J. W., & Winwood, P. W. (2020). Tapering practices of elite CrossFit athletes. International Journal of Sports Science & Coaching.  

Wilson, J. M., et al. (2012). Concurrent training: a meta-analysis examining interference of aerobic and resistance exercises. Journal of Strength and Conditioning Research.  

Zouhal, H., et al. (2021). Editorial: Acute:Chronic Workload Ratio: Is There Scientific Evidence? Frontiers in Physiology. (PMC8138569).  

Task 2: Rules for the HYROX training programme (engine rules)

A. Planning rules (weekly structure)
	•	Minimum viable HYROX week (by band):

	•	total_beginner/beginner: 2 runs + 2 stations + 1 mini brick
	•	novice/intermediate: 3 runs + 2 stations + 1–2 bricks
	•	advanced/competitive/hybrid: 3–4 runs + 2–3 stations + 2 bricks

	•	Hard-day separation rule (global): no more than 2 high-intensity days in any rolling 3-day window, where “high-intensity” is defined as either:

	•	anaerobicLoad above threshold OR
	•	MTL above threshold (eccentric/heavy day)

	•	Race-build protection rule: in race build, preserve (reduce/downgrade first):

	•	1 key brick
	•	1 quality run

B. Session composition rules (component-based)
	•	HYROX sessions are sequences of components; a brick is defined as ≥2 run segments + ≥2 station components.
	•	Stations are usually components, not standalone sessions, unless:

	•	user is “quick but weak” (add station-only strength-endurance)
	•	a station is a bottleneck (e.g., wall balls), or
	•	equipment constraints require station skill time.

C. Progression rules
	•	Progress one variable at a time week-to-week in bricks:
rounds → run intensity → station density (rest ↓) → external load.
	•	Weekly deload every 4th week: reduce total 3D load by 25–40%, keep one short intensity touch.

D. Bias detection rules (“quick but weak” vs “strong but slow”)
	•	Compute two indices from benchmarks (or inferred performance):

	•	Run index: predicted fatigued 1 km pace vs actual in bricks
	•	Station index: station completion times vs expected for band
Classify:
	•	quick-but-weak: run index good, station index poor, big pace decay after stations
	•	strong-but-slow: station index good, run index poor, pace poor even early

	•	Bias response rules:

	•	quick-but-weak → add 1 station emphasis session weekly; reduce run intensity density slightly
	•	strong-but-slow → keep station dose but shift one station day to lower MTL; increase run quality (threshold/interval) focus

E. Adaptation rules (REPLACE/REDUCE/DOWNGRADE)
	•	REPLACE rule: maximize 3D similarity × specificity penalty; apply replacement penalties as credit multipliers.
	•	REDUCE rule: cut volume 15–40% or remove 1 station component from a brick or reduce run intensity tier, preserving session purpose.
	•	DOWNGRADE rule: full brick→mini brick→technique; intervals→tempo→easy; heavy sled→moderate.

F. Taper rules
	•	Taper length by band: competitive 5–7d; intermediate ~7d; beginner/novice 7–10d. Reduce volume 40–60% (competitive) or 30–55% (others), maintain intensity touchpoints (Bosquet et al., 2007; Pritchard et al., 2020).

G. Safety / tissue rules (MTL governance)
	•	Enforce weekly MTL caps by ability band; if user exceeds cap via other sports, automatically REDUCE/DOWNGRADE next high-MTL session.
	•	Avoid introducing “novel eccentric overload” (burpee BJ density, high lunge volume, high wall-ball density) in the final 5–10 days pre-race.

Questions (only if you want the programme rules to be fully specified rather than “defaults”)
	•	Are you targeting HYROX Open or Pro (men/women/mixed doubles), and do you want rules to handle doubles strategy?
	•	What equipment can Mosaic assume for most users (sled access is the big one): always / sometimes / rarely?
	•	Do you want station prescriptions in time-cap format (e.g., 3’ AMRAP) or fixed reps by default?

---

# Part 2: Architecture and Implementation Plan

> Extending Mosaic from a running/triathlon training simulator to support HYROX race preparation and year-round hybrid fitness.

**Status**: Planning (not yet implemented)
**Target formats**: HYROX Open (Rx weights), HYROX Pro (heavier weights)
**Design principle**: Same adaptive engine, same UX patterns, component-based hybrid sessions using the three-dimensional load model defined in Part 1.

---

## 7. State Schema Changes

### 7.1 New Top-Level Fields on SimulatorState

```typescript
// Event type — determines which plan engine runs
eventType?: ‘running’ | ‘triathlon’ | ‘hyrox’;  // undefined = running (backward compat)

// HYROX-specific config (only present when eventType === ‘hyrox’)
hyroxConfig?: {
  format: ‘open’ | ‘pro’;              // Open (Rx weights) vs Pro (heavier)
  athleteBand: AbilityBand;             // total_beginner through competitive (reuse existing)
  hyroxPhase: ‘base’ | ‘build’ | ‘peak’ | ‘taper’;  // per §3.2

  // Equipment availability
  stationAccess: {
    sled: ‘always’ | ‘sometimes’ | ‘never’;
    skiErg: boolean;
    rowErg: boolean;
    wallBallTarget: boolean;
  };

  // Third currency tracking
  weeklyMTL: number;                    // current week’s accumulated MusculoTendon Load
  mtlCap: number;                       // per-band cap (from §3.3)
  mtlHistory: number[];                 // trailing weekly MTL values

  // Athlete bias detection (from §D)
  athleteBias?: ‘quick_but_weak’ | ‘strong_but_slow’ | ‘balanced’;

  // Station benchmarks (optional, seconds to complete)
  stationBenchmarks?: {
    skiErg?: number;
    sledPush?: number;
    sledPull?: number;
    burpeeBroadJumps?: number;
    rowErg?: number;
    farmerCarry?: number;
    sandbagLunges?: number;
    wallBalls?: number;
  };

  // Race PBs
  hyroxPB?: number;                     // total finish time in seconds
  runSplitPBs?: number[];               // 8 x 1km split times
  stationSplitPBs?: Partial<Record<string, number>>;

  // Race target
  targetFinishTime?: number;            // seconds

  // Sessions per week
  runsPerWeek: number;                  // 2-4
  stationSessionsPerWeek: number;       // 2-3
  bricksPerWeek: number;                // 1-2
};
```

### 7.2 Workout Type Extension

```typescript
// Add discipline field to Workout interface
export interface Workout {
  // ... existing fields ...
  discipline?: ‘run’ | ‘station’ | ‘brick_hyrox’ | ‘swim’ | ‘bike’ | ‘brick’;

  // HYROX component-based structure
  hyroxComponents?: Array<{
    type: ‘run_segment’ | ‘station’;
    stationType?: HyroxStation;
    durationMin?: number;
    distanceKm?: number;
    reps?: number;
    loadKg?: number;
    targetRPE?: number;
  }>;

  // 3D load outputs
  musculoTendonLoad?: number;   // MTL for this workout (per §3.3)
}

// Station enum matching taxonomy in §3.1
type HyroxStation =
  | ‘ski_erg’
  | ‘sled_push’
  | ‘sled_pull’
  | ‘burpee_broad_jumps’
  | ‘row_erg’
  | ‘farmer_carry’
  | ‘sandbag_lunges’
  | ‘wall_balls’;
```

### 7.3 New Types

```typescript
// HYROX workout types
type HyroxWorkoutType =
  | ‘hyrox_brick’              // run segments + station components (the core specificity session)
  | ‘hyrox_station_technique’  // station skill work, low load
  | ‘hyrox_station_density’    // station work for time / AMRAP
  | ‘hyrox_run_intervals’      // running intervals (standard)
  | ‘hyrox_run_tempo’          // threshold/tempo run
  | ‘hyrox_easy_run’           // easy aerobic run
  | ‘hyrox_mini_brick’;        // shortened brick (2-3 rounds)

// Session intent for HYROX plan engine
interface HyroxSessionIntent {
  type: HyroxWorkoutType;
  discipline: ‘run’ | ‘station’ | ‘brick_hyrox’;
  targetDurationMin?: number;
  targetAerobicLoad?: number;
  targetAnaerobicLoad?: number;
  targetMTL?: number;
  intensity: ‘low’ | ‘moderate’ | ‘hard’;
  stations?: HyroxStation[];        // which stations are included
  rounds?: number;                  // for bricks: number of run+station rounds
  isKeySession?: boolean;           // protected from replacement
  biasResponse?: ‘station_emphasis’ | ‘run_emphasis’;  // from §D bias rules
}
```

### 7.4 Backward Compatibility

- `eventType` defaults to `’running’` when undefined
- All existing state fields remain unchanged
- `hyroxConfig` is only present when `eventType === ‘hyrox’`
- Running-only users see zero difference. The plan engine branches on `eventType` at the top.

---

## 8. Plan Engine: HYROX Generation

### 8.1 Architecture

The HYROX plan engine generates workouts using the component-based model and three-dimensional load targeting defined in Part 1. It does **not** replace the running plan engine. Instead:

```
eventType === ‘running’    → plan_engine.ts (existing, unchanged)
eventType === ‘triathlon’  → plan_engine.triathlon.ts (separate)
eventType === ‘hyrox’      → plan_engine.hyrox.ts (new)
```

### 8.2 Generation Flow

```
generateHyroxWeek(ctx: HyroxPlanContext)
  1. Determine target weekly 3D load budget: [aerobicTarget, anaerobicTarget, mtlTarget]
     based on phase, week index, ability band, and deload status (per §3.2)
  2. Check athlete bias (§D) → adjust session distribution
  3. Generate run intents (2-4/week depending on band)
  4. Generate station intents (2-3/week)
  5. Generate brick intent(s) (1-2/week, key specificity session)
  6. Validate total 3D load against budget; scale if needed
  7. Enforce MTL cap (§G safety rules)
  8. Pass all intents to HYROX scheduler
  9. Convert intents to Workout objects with component-based descriptions
  10. Calculate 3D load for each workout
  11. Return Workout[]
```

### 8.3 Session Selection by Phase (per §3.2)

**Base phase:**
- Runs: 2 easy + optional strides
- Stations: 2 technique sessions (scaled loads, focus on movement quality)
- Brick: 1 mini brick every 2 weeks (2-3 rounds, short run + erg stations)
- MTL: low. Prioritise tissue tolerance over load.

**Build phase:**
- Runs: 1 easy + 1 quality (tempo or intervals)
- Stations: 1 technique + 1 density (higher RPE, time-capped sets)
- Brick: 1 key brick/week (4-6 rounds with mixed stations)
- MTL: moderate. Introduce eccentric stations (lunges, wall balls) progressively.

**Peak phase:**
- Runs: 1 easy + 1 quality (race-pace intervals or threshold)
- Stations: 1 density + 1 race-simulation set
- Brick: 1 key brick (6-8 rounds, include eccentric-tax stations) + 1 mini brick
- MTL: high but within cap. Last runs at race pace under station fatigue.

**Taper phase (per §3.7, §F):**
- All session volumes reduced 40-60% (competitive) or 30-55% (beginner/novice)
- Maintain 1 race-pace intensity touch per type (run, station, brick)
- No novel eccentric overload in final 5-10 days (§G)

### 8.4 Bias-Responsive Session Selection (per §D)

```
if (bias === ‘quick_but_weak’) {
  // Add 1 station emphasis session weekly
  // Reduce run intensity density slightly
  // Focus on wall balls, lunges, sled — the stations that slow them down
}

if (bias === ‘strong_but_slow’) {
  // Keep station dose but shift one station day to lower MTL (erg-focused)
  // Increase run quality focus (threshold/interval)
  // Protect key run sessions from reduction
}
```

### 8.5 Adaptive Adjustments

Same mechanisms as running mode, extended to 3D:

- **Readiness/recovery:** Orange/red recovery status → reduce volume or drop quality sessions
- **ACWR (per-dimension):** If run ACWR > 1.3, reduce run volume. If MTL ACWR spike, reduce station density.
- **RPE feedback:** Consistently high RPE → reduce next week’s volume. Low RPE → allow progression.
- **MTL cap enforcement (§G):** If weekly MTL exceeds band cap from any source (HYROX + other sports), automatically REDUCE/DOWNGRADE next high-MTL session.

### 8.6 Weekly Load Calculation

```
weeklyTarget = {
  aerobicLoad: bandBase.aerobic × phaseMultiplier × recoveryWeekMultiplier,
  anaerobicLoad: bandBase.anaerobic × phaseMultiplier × recoveryWeekMultiplier,
  mtl: bandBase.mtl × phaseMultiplier × recoveryWeekMultiplier
}
```

Recovery week multiplier: 0.60 to 0.75 (per §C: reduce total 3D load by 25-40%).

**Key integration point:** `src/workouts/generator.ts:generateWeekWorkouts()` (17 params). This orchestrates the full pipeline. It needs to branch on `eventType` before calling the plan engine:
```typescript
if (s.eventType === ‘hyrox’) {
  intents = planHyroxWeek(hyroxCtx);
} else if (s.eventType === ‘triathlon’) {
  intents = planTriathlonWeek(triCtx);
} else {
  intents = planWeekSessions(ctx);
}
```

**Reusable from `planWeekSessions()` (`src/workouts/plan_engine.ts`):**
- `abilityBandFromVdot()` — sport-agnostic
- `isDeloadWeek()` — sport-agnostic (same 3/4/5-week cycle, per §C)
- `effortMultiplier()` — sport-agnostic (RPE feedback scaling)
- Quality cap logic — reusable (max hard days per rolling 3-day window, per §A)

---

## 9. Scheduler: HYROX Week Layout

### 9.1 Hard Constraints (per §A)

1. No more than 2 high-intensity days in any rolling 3-day window, where “high-intensity” = anaerobicLoad above threshold OR MTL above threshold
2. At least 1 full rest day per week
3. Key brick on Saturday (or user-configured long day)
4. No high-MTL session the day before a quality run (eccentric fatigue impairs running mechanics, per brick/transition evidence in §3.5)

### 9.2 Soft Constraints

1. Station variety across the week (don’t repeat same station category back-to-back)
2. Erg stations (low MTL) preferred adjacent to quality runs
3. Eccentric-heavy stations (lunges, wall balls, burpee BJ) spaced at least 48h apart
4. Easy run as “bookend” session around harder days

### 9.3 Default Templates by Band (per §4.4)

**total_beginner (year-round):**
```
Mon: easy run + optional mobility
Tue: station technique (scaled)
Wed: rest
Thu: mini brick (short run + erg)
Fri: rest
Sat: easy run
Sun: rest
```

**novice (race build):**
```
Mon: easy run + strides
Tue: key brick (1km + station repeats, 4-5 rounds)
Wed: rest
Thu: station emphasis (wall balls/lunges scaled)
Fri: rest or easy run
Sat: tempo/threshold blend
Sun: rest
```

**intermediate (race build):**
```
Mon: easy run
Tue: key brick (6x1km + mixed stations, last runs faster)
Wed: rest or easy run
Thu: stations (wall balls/lunges + limited burpee exposure)
Fri: rest
Sat: tempo with race-pace touches
Sun: rest or station technique
```

**competitive/hybrid (race build):**
```
Mon: easy run
Tue: key brick (7-8 rounds)
Wed: rest or easy run
Thu: secondary brick (lighter flow, 3-4 rounds)
Fri: rest
Sat: run sharpening (short intervals + station touch)
Sun: rest
```

### 9.4 Scheduler Implementation

The existing `src/workouts/scheduler.ts:assignDefaultDays()` uses a 5-phase algorithm. For HYROX:

**Option A: Extend existing scheduler.** Add station/brick to `HARD_WORKOUT_TYPES`. Teach it MTL-aware spacing.
**Option B: Template-based scheduler for HYROX.** Use the templates above, then apply constraint validation.

**Recommendation:** Option B. The HYROX week structure is different enough from pure running that a template approach is cleaner:
```typescript
function scheduleHyroxWeek(intents: HyroxSessionIntent[], band: AbilityBand): Workout[] {
  const template = HYROX_TEMPLATES[band];
  // Place key brick first (anchored day)
  // Fill station and run slots from template
  // Validate against hard constraints (rolling 3-day window, MTL spacing)
  // Adjust if constraints violated
}
```

---

## 10. Workout Library: Stations and Bricks

### 10.1 Station Workout Description Format

HYROX workouts are component-based. Each station component has:
```
Station: Wall Balls (20 reps @ 6kg/9kg)
Station: Sled Push (50m @ Open/Pro weight)
Station: SkiErg (1000m)
```

### 10.2 Brick Workout Format

```
HYROX Brick (5 rounds)
---
Round 1: 1km run @ easy-moderate + SkiErg 1000m
Round 2: 1km run @ moderate + Sled Push 50m
Round 3: 1km run @ moderate + Sled Pull 50m
Round 4: 1km run @ moderate-hard + Burpee Broad Jumps 80m
Round 5: 1km run @ hard + Row 1000m
---
Target: ~55-65 min total | RPE 7-8
```

### 10.3 Station Technique Session Format

```
Station Technique (3 stations, 3 rounds each)
---
Wall Balls: 3x10 @ 50% race weight, focus on rhythm
Farmer Carry: 3x25m @ race weight, focus on trunk stiffness
SkiErg: 3x250m @ moderate, focus on catch timing
---
Target: ~25-30 min | RPE 5-6
```

### 10.4 Station Density Session Format

```
Station Density (AMRAP-style)
---
4 min AMRAP: Wall Balls @ race weight
Rest 2 min
4 min AMRAP: Sandbag Lunges @ race weight
Rest 2 min
4 min AMRAP: Burpee Broad Jumps
---
Target: ~25-30 min | RPE 7-8
```

### 10.5 Progression Rules (per §C)

Progress one variable at a time week-to-week in bricks:
1. **Rounds** (add 1 round per week)
2. **Run intensity** (easy → moderate → race pace for later rounds)
3. **Station density** (increase rest reduction, time-cap sets)
4. **External load** (scale from 50% to race weight over build phase)

### 10.6 Intent-to-Workout Conversion

Parallel to `src/workouts/intent_to_workout.ts:intentToWorkout()`:

```typescript
function hyroxIntentToWorkout(intent: HyroxSessionIntent, config: HyroxConfig): Workout {
  if (intent.type === ‘hyrox_brick’) {
    return buildBrickWorkout(intent.rounds, intent.stations, config);
  }
  if (intent.type === ‘hyrox_station_technique’) {
    return buildStationTechniqueWorkout(intent.stations, config);
  }
  // ... etc
}
```

**Reusable:** `intentToWorkout()` handles run intents unchanged (easy, tempo, threshold, intervals). Only station and brick intents need new conversion functions.

---

## 11. Fitness Model: Three-Dimensional Tracking

### 11.1 How MTL Integrates with Existing Load Signals

The current app uses three signals (`src/calculations/fitness-model.ts`):

| Signal | Current | HYROX Adaptation |
|--------|---------|-----------------|
| **Signal A** (run-equiv, runSpec-discounted) | Running Fitness CTL | Unchanged for run sessions. Station/brick sessions contribute via runSpec discount (HYROX stations ≈ 0.30 runSpec). |
| **Signal B** (raw physiological, no discount) | ACWR, Total Load, Freshness | Unchanged. All TSS adds at full value. Station sRPE × duration feeds Signal B. |
| **Signal C** (impact load) | Day-before injury risk | Extended: station components contribute impact load based on station taxonomy (§4.1). |
| **MTL (new)** | N/A | Third currency per §3.3. Tracks peripheral musculoskeletal/tendon strain. |

### 11.2 Weekly MTL Computation (per §3.3)

For each workout component:
```
componentMTL = IL × modalityFactor × impactFactor × (1 + externalLoadFactor)
where IL = duration_minutes × sRPE
```

Weekly MTL = sum of all component MTLs, then apply saturation:
```
effectiveMTL = MTL_cap × (1 − exp(−rawMTL / MTL_cap))
```

MTL cap by ability band (values to be confirmed by Tristan):
```
total_beginner: MTL_cap = [TBD]
beginner: MTL_cap = [TBD]
novice: MTL_cap = [TBD]
intermediate: MTL_cap = [TBD]
advanced: MTL_cap = [TBD]
competitive: MTL_cap = [TBD]
```

### 11.3 MTL in ACWR

Compute MTL-specific ACWR alongside existing aerobic/anaerobic ACWR:
```
mtlACWR = mtlATL / mtlCTL
```
Where mtlATL and mtlCTL use the same decay constants (7d / 42d) applied to daily MTL values.

If mtlACWR > 1.3, flag for station volume reduction (same escalation logic as existing ACWR system).

### 11.4 Implementation

`src/calculations/fitness-model.ts` already has:
- `computeWeekTSS()` (Signal A) and `computeWeekRawTSS()` (Signal B)
- `CTL_DECAY = Math.exp(-7/42)` and `ATL_DECAY = Math.exp(-7/7)`

For HYROX, add:
```typescript
export function computeWeekMTL(wk: Week): number {
  // Sum MTL across all completed workouts in the week
  // Apply saturation curve
  // Return effectiveMTL
}

export function computeMTLFitnessFatigue(weeks: Week[]): { mtlCTL: number; mtlATL: number } {
  // Same EMA logic as existing CTL/ATL, applied to weekly MTL values
}
```

---

## 12. Activity Sync and Matching

### 12.1 How HYROX Activities Appear in Strava

HYROX training sessions typically appear in Strava as:
- **Run segments:** Normal `Run` activities
- **Station-only sessions:** `Workout`, `WeightTraining`, or `CrossFit` activity types
- **Full HYROX race:** Sometimes `Run` (if recorded on running watch), sometimes `Workout`
- **Bricks (run + stations):** Typically a single `Workout` or `Run` activity covering the full session

The current `mapGarminType()` in `src/calculations/activity-matcher.ts` maps `HIIT` and `CROSSFIT` to cross-training. In HYROX mode, these should be treated as primary training activities.

### 12.2 Matching Logic Changes

Current matcher (`matchAndAutoComplete()`, line 411): scores on day proximity + distance + type affinity.

HYROX matcher adds:
- **Discipline matching:** Station activities (Workout/CrossFit/WeightTraining) can match station or brick workouts. Run activities match run or brick workouts.
- **Duration matching for stations:** Since station sessions are time-based, match on duration proximity (planned 30 min vs actual 35 min = within 20%).
- **Brick matching:** If a Run and a Workout/CrossFit activity occur on the same day, attempt to match them as a brick.

### 12.3 Load Calculation for Synced Activities

For HYROX activities matched to planned workouts:
- Run activities: existing iTRIMP pipeline, unchanged
- Station activities: `sRPE × duration` for Signal B. Apply station taxonomy factors (§4.1) for MTL.
- When no HR data (common for gym-based station work): use planned RPE as fallback.

### 12.4 Cross-Training Reclassification

In HYROX mode, station work is primary training. The cross-training gate needs a mode-aware branch:
```typescript
function isCrossTraining(activityType: string, eventType: string): boolean {
  if (eventType === ‘hyrox’) {
    // In HYROX mode, runs and station-type activities are primary
    return ![‘run’, ‘crossfit’, ‘workout’, ‘weight_training’, ‘hiit’].includes(activityType);
  }
  // Running mode: only runs are primary
  return activityType !== ‘run’;
}
```

---

## 13. Wizard / Onboarding

### 13.1 Flow Branching

The wizard adds a mode selection step early:

```
Step 1: What are you training for?
  [ ] Marathon / Half / 10K / 5K          → existing running flow
  [ ] Triathlon (70.3 or Ironman)         → triathlon flow
  [ ] HYROX                              → HYROX flow
  [ ] General fitness (no race)           → existing continuous mode
```

### 13.2 HYROX-Specific Wizard Steps

After selecting HYROX:

1. **Format selection:** Open or Pro
2. **Race date** (optional): same as current event selection
3. **Experience level:** Map to ability band
   - “Never done a HYROX or similar” → total_beginner/beginner
   - “Done 1-2 HYROX events” → novice
   - “Regular HYROX competitor” → intermediate
   - “Competitive (sub-70 min)” → advanced/competitive
4. **Recent HYROX time** (optional): if known, refines ability band and enables finish-time prediction
5. **Running background:** existing PB / experience flow (reused from running mode)
6. **Equipment access:**
   - “Do you have regular access to a sled?” → always / sometimes / never
   - “SkiErg and/or RowErg available?” → checkboxes
   - “Wall ball target?” → yes / no
   This drives station substitution (§3.4 replacement matrix): if no sled, plan uses hill pushes / treadmill incline.
7. **Sessions per week:** How many total sessions? (4-8). Suggested split shown based on band.
8. **Wearable connection:** same as current
9. **Gym / strength:** reuse existing

### 13.3 Estimating Starting Fitness

When HYROX finish time is known:
- Map to ability band using finish time thresholds
- Derive run fitness from run split PBs (feed into existing VDOT pipeline)
- Station fitness from station splits (if available) or estimated from band

When no HYROX time:
- Use running PBs for run fitness (existing pipeline)
- Use experience level for station fitness (band-based defaults)
- Station benchmarks recommended in first 4-6 weeks (§3.6)

### 13.4 Initialization

`initializeHyrox(onboardingState)` runs when `eventType === ‘hyrox’`:
1. Run fitness from PBs (reuse existing VDOT calculation)
2. Set ability band from HYROX time or experience level
3. Set phase schedule (base/build/peak/taper per §3.2)
4. Set MTL cap for band (§3.3)
5. Set station access and configure replacement matrix (§3.4)
6. Set weekly session targets per band (§A)
7. Finish-time forecast (§4.5, if enough data)

---

## 14. UI Changes

### 14.1 Design Principle

Same UX patterns, same visual language. The HYROX UI is the running UI with component-based session awareness, not a new app.

### 14.2 Home View

Current: shows this week’s workouts as cards.

HYROX: same card layout, but:
- **Brick cards** show component breakdown (run segments + station list)
- **Station cards** show station names and load/reps
- **Weekly load bar** shows 3D load: aerobic (blue), anaerobic (amber), MTL (red/orange)
- **MTL budget indicator** shows weekly MTL vs cap (progress bar)

### 14.3 Plan View

Current: week-by-week running plan with phase labels.

HYROX: same structure, but:
- Each week shows session type counts (e.g., “R3 S2 B1” for 3 runs, 2 stations, 1 brick)
- Phase labels from §3.2 (base/build/peak/taper)
- Weekly volume shown as total 3D load
- Brick sessions marked with a component icon

### 14.4 Stats View

Current: CTL/ATL/TSB chart, weekly volume, zone distribution.

HYROX: adds:
- **3D load chart:** stacked area showing aerobic + anaerobic + MTL over time
- **Station benchmark progress:** per-station time chart (if benchmarks recorded)
- **Run pace trend** (unchanged from running mode)
- **Athlete bias indicator:** “Quick but weak” / “Strong but slow” / “Balanced” with trending

### 14.5 Station Detail Cards

When tapping a station workout, show:
- Station name and load/reps
- 3D load contribution (how much aerobic/anaerobic/MTL this station adds)
- Technique cues (e.g., “Wall balls: full squat depth, push the ball from the chest, find a rhythm”)
- Replacement options (what to do if equipment unavailable)

### 14.6 Colour Coding

Session type colours (small indicators only, per UX_PATTERNS.md):

| Type | Colour | Rationale |
|------|--------|-----------|
| Run | Green (`var(--c-run)`) | Consistent with triathlon mode |
| Station | Orange | Functional fitness association |
| Brick | Split gradient or dual-dot | Combination indicator |

These are accent indicators only (small dots, chart lines). Per UX_PATTERNS.md, no tinted card backgrounds.

---

## 15. Rollout Plan

### Phase 0: Stabilise Running Mode (prerequisite)
Fix open P1 bugs (CTL 222, TSS percentages). These touch `fitness-model.ts` and load calculations that HYROX will build on.

### Phase 1: Types and State Schema
- Add `’hyrox’` to `eventType`
- Add `HyroxConfig`, `HyroxStation`, `HyroxSessionIntent` types
- Add `hyroxComponents` and `musculoTendonLoad` to `Workout`
- Ensure all existing tests pass (running mode unaffected)
- **No UI changes yet.**

### Phase 2: Wizard Fork
- Add HYROX option to mode selection
- Build HYROX-specific onboarding steps
- Equipment survey
- Store in `hyroxConfig`
- Result: user can onboard for HYROX, but sees empty plan

### Phase 3: Plan Engine (HYROX)
- New `plan_engine.hyrox.ts`
- Run session generator (reuses existing run intents)
- Station session generator (technique, density)
- Brick session generator (component-based)
- Phase-appropriate session selection (§3.2)
- Bias detection and response (§D)

### Phase 4: Scheduler
- Template-based HYROX week layout
- MTL-aware hard-day separation
- Station variety constraints
- Brick placement logic

### Phase 5: Load Model (MTL Integration)
- `computeWeekMTL()` function
- MTL saturation curve (§3.3)
- MTL cap enforcement (§G)
- MTL-aware ACWR
- 3D load output on each workout

### Phase 6: UI
- Home view: component-based workout cards, 3D load bars
- Plan view: session type counts, phase labels
- Stats view: 3D load chart, station benchmarks
- Station detail cards

### Phase 7: Activity Matching
- Mode-aware activity classification
- Station activity matching (duration-based)
- Brick detection from sequential activities
- MTL calculation for synced activities

### Phase 8: Race Prediction
- Finish time model (§4.5): Total = 8×(fatigued 1km) + Σ station times
- Bias-aware prediction (station bottleneck identification)
- Training response tracking (finish time trend)

---

## 16. Deep Integration Walkthrough

This section walks through every stage of the user journey and identifies exactly where HYROX breaks the current system.

### 16.1 Onboarding / Wizard

**Current flow** (`src/ui/wizard/controller.ts`, `src/ui/wizard/renderer.ts`):
```
welcome → goals → background → volume → performance →
fitness → strava-history (conditional) → physiology →
initializing → runner-type → assessment → main-view
```

**Step 2: Goals** — `raceDistance` is `’5k’ | ‘10k’ | ‘half’ | ‘marathon’`. No HYROX option.
- **Fix:** Add sport selection card: Running / Triathlon / HYROX. If HYROX, show format selection (Open/Pro) instead of running distances. Race browser needs HYROX events or custom-date-only path.

**Step 3: Background** — `experienceLevel` uses `RunnerExperience` enum (running-specific).
- **Fix:** For HYROX, experience maps to ability band (§3.2). Running experience is still collected separately to feed VDOT. Add: “HYROX experience” selector (never/1-2 events/regular/competitive).

**Step 4: Volume** — `runsPerWeek` is the primary planning variable.
- **Fix:** Replace with total sessions. Suggested split: “3 runs + 2 stations + 1 brick” for novice. User can adjust per category.

**Step 5: Performance** — `PBs` interface is running-only.
- **Fix:** Add optional HYROX finish time and station split inputs. Running PBs still collected for VDOT pipeline.

**Step 9: Initializing** — `initializeSimulator()` is entirely running-specific.
- **Fix:** Fork. `initializeHyrox(onboardingState)` runs when HYROX selected (see §13.4).

**Step 10: Runner Type** — Speed/Balanced/Endurance from running fatigue exponent.
- **Options:**
  - **(A) Drop for HYROX.** Simplest.
  - **(B) HYROX archetype.** Replace with bias detection: “Quick but weak” / “Strong but slow” / “Balanced” (§D).
- **Recommendation:** Option B. Directly maps to plan adaptation rules.

### 16.2 Plan Generation

**Current system** (`src/workouts/plan_engine.ts:planWeekSessions()`):
Calculates ability band → determines deload → applies effort multiplier → caps quality → fills slots greedily from priority list.

**Problems for HYROX:**
1. **Volume is single-sport:** `totalMinutes` is all running. No concept of station or brick time.
2. **Quality cap is global:** “Max 2 quality sessions” doesn’t distinguish station quality from run quality.
3. **Priority list is running-specific:** Threshold vs VO2 vs marathon pace ordering only makes sense for running.
4. **No 3D load budgeting:** Current system budgets aerobic/anaerobic only.

**Solution:** Parallel HYROX planner that generates intents by type (run/station/brick), then merges. Reuses `abilityBandFromVdot()`, `isDeloadWeek()`, `effortMultiplier()`. Adds 3D load budgeting and MTL cap enforcement.

### 16.3 Intent-to-Workout Conversion

**Current system** (`src/workouts/intent_to_workout.ts`):
Converts `SessionIntent` → `Workout` with human-readable descriptions using pace ratios.

**Problems:**
1. **No component-based descriptions:** Stations need “SkiErg 1000m + Sled Push 50m” format, not “5.2km @ 5:00/km”.
2. **No 3D load output:** Current `calculateWorkoutLoad()` returns aerobic/anaerobic only.

**Solution:** Add `hyroxIntentToWorkout()` for station and brick intents. Run intents reuse existing `intentToWorkout()` unchanged. Add `musculoTendonLoad` calculation using station taxonomy factors from §4.1.

### 16.4 Scheduler

**Current system** (`src/workouts/scheduler.ts:assignDefaultDays()`):
5-phase algorithm. `HARD_WORKOUT_TYPES` only includes running types.

**Problems:**
1. **No MTL-aware spacing:** A high-MTL station session (lunges, wall balls) followed by a quality run is problematic.
2. **Hard-day detection is run-only.**
3. **No brick anchoring.**

**Solution:** Template-based HYROX scheduler (§9.4). Apply hard-day separation using both anaerobic AND MTL thresholds per §A.

### 16.5 Daily Interaction: Rating, Skipping, Moving

**Current system** (`src/ui/events.ts`):
- `rate()`: Records RPE, computes VDOT adjustment.
- `skip()`: First skip → push to next week. Second skip → drop.

**For HYROX:**
- **Rating:** RPE for the whole session (not per-component). Feed into effort multiplier unchanged. VDOT adjustment only from run sessions.
- **Skipping:** Same push-to-next-week logic. If a brick is skipped, push the full brick (not split into run + station).
- **MTL impact of skipping:** If a high-MTL session is skipped, the weekly MTL drops. No compensatory MTL increase next week (avoid eccentric overload spikes).

### 16.6 Activity Sync

**Current system** (`src/data/activitySync.ts`, `src/calculations/activity-matcher.ts`):
Activities classified by `mapGarminType()`. Runs auto-match. Everything else → cross-training queue.

**Problems:**
1. Station activities (Workout/CrossFit/HIIT) classified as cross-training.
2. No component-level matching.

**Fix:** In HYROX mode, treat station-type activities as primary. Auto-match to station/brick slots by day proximity + duration. Cross-training modal does not fire for station activities.

### 16.7 Load and Fitness Model

**Current system** (`src/calculations/fitness-model.ts`):
- Signal A: `computeWeekTSS()` (runSpec discount)
- Signal B: `computeWeekRawTSS()` (full physiological load)
- CTL/ATL/TSB from these signals.

**Problems:**
1. **No MTL tracking.** Station mechanical strain not captured.
2. **Station work gets heavy runSpec discount (0.30).** For HYROX athletes, station work IS the training.

**Solution:**
- Signal A: Station work keeps existing runSpec (0.30) for running fitness CTL. HYROX athletes’ running fitness is still primarily built through running.
- Signal B: Unchanged. All load at full value.
- MTL (new): Computed per §3.3, with its own CTL/ATL track.
- Athlete tier: For HYROX, derive from combined CTL (Signal B) not running-only CTL, so high-volume HYROX athletes are correctly classified.

### 16.8 Readiness and Daily Coaching

**Current system** (`src/calculations/readiness.ts`):
Readiness composite: 35% freshness (TSB) + 30% load safety (ACWR) + 35% recovery (HRV/sleep/RHR).

**For HYROX:**
- **Overall readiness:** Use combined TSB and ACWR (unchanged).
- **MTL-aware coaching:** If MTL is spiking (mtlACWR > 1.3), coach suggests reducing station density or switching to erg-based (low-MTL) stations.
- **Pre-race eccentric warning:** In the final 5-10 days, flag any planned session with high-MTL stations (lunges, wall balls, burpee BJ). Suggest DOWNGRADE to technique-only or erg-based alternatives per §G.

### 16.9 Stats and Progress

**Current system** (`src/ui/stats-view.ts`):
Weekly load bar, CTL/ATL/TSB chart, zone distribution, running km trend, VDOT trend.

**HYROX additions:**
- **3D load chart:** Stacked area showing aerobic (blue) + anaerobic (amber) + MTL (red) over time. Replaces the single-dimension load bar.
- **Station benchmark tracking:** If the user records station benchmark times (§3.6), show per-station time trends.
- **Finish time projection:** Based on §4.5 forecasting model. Show predicted total time with run/station split breakdown.
- **Bias indicator:** Show current classification (quick-but-weak / strong-but-slow / balanced) and how it’s trending based on recent benchmarks.

---

## 17. Open Questions

These need Tristan’s input before implementation:

### Architecture
1. **Shared or separate plan engines?** Recommendation: separate (`plan_engine.hyrox.ts`). Same rationale as triathlon.
2. **MTL cap values by band?** The research doc defines the saturation curve formula but not the specific cap values per ability band.

### UX
3. **Component-based workout cards:** Show full round breakdown or summarised? (“5 rounds: 1km run + mixed stations” vs listing each round)
4. **3D load visualisation:** Stacked bar, stacked area, or three separate bars?
5. **Station benchmarks:** In-app benchmark protocol or manual entry only?

### Training Model
6. **Default MTL cap values by band:** Per CLAUDE.md, no made-up numbers. The saturation curve formula is from the research doc but specific caps need confirmation.
7. **Station load coefficients (§4.1):** The research doc provides relative 0-10 values. These need validation against real HYROX training data.
8. **modalityFactor / impactFactor / externalLoadFactor defaults:** Listed in §3.3 as “tuneable.” Confirm starting values.

### Data
9. **Station detection from Strava:** Can we infer station type from HR patterns in a Workout activity? Or always manual?
10. **HYROX race result parsing:** Any structured format available from HYROX timing systems?

### Scope
11. **Doubles strategy:** Support HYROX Doubles (shared workload)? Architecture should allow but not build now.
12. **Gym/strength integration:** How does existing `gym.ts` interact with HYROX station work? Are they separate or does station work replace gym sessions?
13. **HYROX Relay:** Different event format with single-station specialisation. Out of scope for now?

---

## Appendix A: Glossary

| Term | Meaning |
|------|---------|
| **HYROX** | Standardised fitness race: 8 x 1km run + 8 functional workout stations, always in the same order. |
| **HYROX Open** | Standard format with Rx (prescribed) weights. |
| **HYROX Pro** | Heavier station weights for competitive athletes. |
| **HIFT** | High-Intensity Functional Training. The broader category HYROX belongs to (Brandt et al., 2025). |
| **MTL** | MusculoTendon Load. The third load currency (alongside aerobic and anaerobic) capturing eccentric damage, bracing stress, loaded carries, and impact/plyometric exposure (§3.3). |
| **sRPE** | Session RPE. Perceived exertion for the entire session on a 1-10 scale. Base unit for internal load: IL = duration_min x sRPE (Haddad et al., 2017). |
| **IL** | Internal Load. duration_minutes x sRPE. The base input to all load calculations. |
| **modalityFactor** | Multiplier reflecting how much musculoskeletal strain a given modality produces per unit of internal load. E.g., easy run 0.6, sled push 1.2, burpee broad jumps 1.3 (§3.3). |
| **impactFactor** | Multiplier for ground-contact / plyometric stress. Erg 0.7, run 1.0, bounding/jumps 1.2 to 1.4 (§3.3). |
| **externalLoadFactor** | Scaling factor for external weight relative to bodyweight. Capped. Applies to loaded stations like sled, farmer carry, lunges (§3.3). |
| **MTL cap** | Per-band weekly ceiling on effective MTL. Prevents excessive peripheral strain accumulation. Uses saturation curve: effectiveMTL = MTL_cap x (1 - exp(-rawMTL / MTL_cap)) (§3.3). |
| **3D load** | The three-dimensional load vector: [aerobicLoad, anaerobicLoad, MTL]. Used for session similarity scoring and weekly budgeting. |
| **Specificity penalty** | Multiplier (0 to 1) applied when substituting a planned session with a less-specific alternative. E.g., sled push replaced by hill push = 0.90 penalty (§3.4). |
| **Brick (HYROX)** | A session with 2+ run segments interleaved with 2+ station components, simulating race structure. The core specificity session. |
| **Station taxonomy** | Classification of the 8 HYROX stations by fatigue signature: heavy grind/bracing (sled), eccentric quad + gait disruption (lunges, wall balls, burpee BJ), cyclical erg (SkiErg, Row), grip + trunk stiffness (farmer carry) (§3.1). |
| **ACWR** | Acute:Chronic Workload Ratio. ATL / CTL. Used as a load-spike detector. Debated as an absolute injury predictor (Zouhal et al., 2021). |
| **CTL** | Chronic Training Load. 42-day exponential moving average of training load. Represents fitness. |
| **ATL** | Acute Training Load. 7-day exponential moving average. Represents fatigue. |
| **TSB** | Training Stress Balance. CTL minus ATL. Positive = fresh, negative = fatigued. |
| **Quick but weak** | Athlete bias where run splits are good but station times are poor and pace decays sharply after stations (§D). |
| **Strong but slow** | Athlete bias where station times are good but run pace is poor even early in the race (§D). |
| **Eccentric overload** | High volume of lengthening-under-load contractions (lunges, wall balls, burpee BJ). Causes delayed muscle soreness and impairs subsequent running. Novel eccentric exposure avoided in final 5 to 10 days pre-race (§G). |
| **AMRAP** | As Many Reps/Rounds As Possible. A time-capped station density format. |
| **EMOM** | Every Minute On the Minute. A pacing format for station work. |
| **Compromised running** | Running under station-induced peripheral fatigue. The defining performance challenge of HYROX (§5). |

