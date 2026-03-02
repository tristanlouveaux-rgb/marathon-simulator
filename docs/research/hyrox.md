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

