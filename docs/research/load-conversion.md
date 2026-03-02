Forecasting Running Workout Load & Cross-Sport Training Equivalents

Using a Unified Training Load Metric Across Sports

To compare training stress across different sports, it’s crucial to use a common load metric that accounts for intensity and duration. The best approach is to leverage heart-rate-based training load measures like Garmin’s Aerobic/Anaerobic Training Effect or the TRIMP (Training Impulse) score. Garmin’s system (built on Firstbeat analytics) uses heart rate and EPOC to accumulate a training load number for any activity – whether running, cycling, soccer, etc. . In other words, a hard game of football or an intense tennis match can register a similar training load to a run of equal cardiovascular strain, as long as heart rate data is captured . These internal load metrics serve as a “common currency” to quantify strain across sports . Research supports this approach: heart-rate-based load (like TRIMP) can be applied across sports to sum up weekly training stress objectively .

Fallback Measures: If precise device metrics aren’t available, we can estimate load via perceived effort. A well-known method is the Foster Score, which multiplies session RPE (Rating of Perceived Exertion on a 1–10 scale) by workout duration (minutes) . This “session RPE” approach provides a simple cross-sport load estimate without needing a heart rate monitor . For example, a 60-minute workout feeling like 8/10 effort would score 480 points. While not as fine-grained as HR-based TRIMP, it’s an empirically grounded proxy to compare, say, a tough 60′ spin class to a 60′ hard run. The key is that both heart-rate metrics and RPE-based load let us quantify any workout on a single scale, ensuring consistency in how we gauge stress from different sports. This avoids the mistake of naively equating sessions by time or distance alone – instead we’re using HR and intensity data to drive the comparison.

Forecasting the Load of Planned Runs

With a unified metric in hand, we can forecast the training load of planned running workouts by considering their intensity and duration. Each run type in the training plan – easy, long, tempo, intervals, etc. – has a typical intensity profile, which we can translate into an expected load. For instance:
	•	Easy Runs (Zone 1–2 aerobic) will accumulate load slowly. An easy run might produce on the order of ~1 TRIMP per minute or less. In Garmin terms, a short easy run often yields a low Aerobic Training Effect (e.g. TE 1.0–2.0) indicating a minor aerobic stimulus. For example, 40 minutes at an easy pace could be ~“Maintaining” fitness (Aerobic TE ~2.0–2.5) . If a runner’s typical 5 km easy run results in, say, 50 TRIMP, we expect a 10 km easy run to be roughly double that (assuming intensity stays low).
	•	Threshold or Tempo Runs (comfortably hard, near lactate threshold) generate higher load per minute. These runs elevate heart rate into Zone 4 (≈tempo effort) for a sustained period, so the training load accumulates faster. For example, a 45-minute tempo run might yield a TRIMP of ~100, which is a high load accomplished in relatively short time. (By comparison, 100 TRIMP spread over a 90-minute easy run would be a much lower intensity per minute .) In Garmin’s metric, a solid tempo run could show Aerobic TE in the 3.0–4.0 range (“improving” fitness) depending on how close it is to threshold. We can use the runner’s known threshold pace/HR to estimate this. If their threshold run pushes HR to ~85–90% max for 30–40 min, we predict a significant training load on par with a hard effort.
	•	VO₂max Intervals and Repetitions (very hard intervals with rest) put the heart rate near maximum in bursts. A classic interval session (e.g. 5×1000m at 5K pace) might have lower total minutes at high HR but extremely high intensity during work bouts. Such a session might produce a similar total load to a tempo run, but with more anaerobic contribution. Garmin’s Anaerobic TE would tick up alongside Aerobic TE. For example, interval workouts often yield Aerobic TE ~3.0+ and also notable Anaerobic TE if there are sprint elements . We can forecast that a planned VO₂ max workout will be one of the week’s highest-impact sessions in terms of load – perhaps equivalent to or exceeding a tempo run’s load, despite shorter duration, due to the intense HR spikes.

In practice, historical data can improve these forecasts. If the app has the user’s past workouts, it can learn that, say, a 8 km threshold run for this runner typically results in a load score of ~120, whereas a 8 km easy run is ~60. Lacking personal data, we rely on physiological averages: e.g. zone 4 time yields ~2× the TRIMP per minute of zone 2 time . Each planned run can be tagged with an expected load range. This is critical for adaptation – it lets the system compare the planned stress of a run with any cross-training the athlete does instead or in addition.

Cross-Sport Equivalents and Empirical Conversion Factors

To integrate other sports into a running plan, we need to establish equivalents between cross-training and running in terms of training stimulus. Rather than using a crude rule like “90 minutes of X = Y km running,” we anchor the equivalence on measurable load (HR or RPE) and then express it in running terms. Below we examine common cross-training modes and how they translate into running load, including some empirically-based constants from research and coaching practice:
	•	Cycling (Endurance Ride): Cycling is the classic running alternative, providing a strong aerobic workout with less impact. Because cycling is more efficient (and usually lower heart rate at a given power output than running at the same effort), you generally need more volume to equal a run. A well-known rule of thumb is that biking 2.5–3.5 miles equals about 1 mile of running effort, with the exact ratio depending on conditions and the athlete’s speed . In other words, the distance or time must be roughly 3x longer on the bike to stress you similarly to running, especially for slower paces . For example, one analysis noted 10 km of running (~42 min for a 6:45/mi runner) was as hard as ~40 km of cycling in 1 hour . This aligns with the 2.5–3.5× distance multiplier. Coaches like Jack Daniels have similarly suggested ~1:3 time ratios for run:bike at easy intensities. However, intensity trumps raw distance: a vigorous cycling session can absolutely rival a run. If you do a hard 60′ bike ride with hills/intervals, your heart rate might stay in Zone3-4 and Garmin will give a sizable load (for instance, Aerobic TE 3.5+). Garmin’s data confirms a hard ride can generate a high aerobic load much like a run . In practice, we’ve seen that, say, a 90-minute steady ride could partially substitute a long run – it might register a high “low aerobic” load indicating lots of Zone2 endurance work . Empirical constant: If no device data, one might assume ~1 minute of moderate cycling ≈ 0.5–0.6 minutes of easy running in training effect, and adjust for intensity (e.g. a very hard short ride can equal a longer easy ride). This aligns with Dick Brown’s advice that because cycling lacks pounding, you might do ~10% extra time to get equivalent training stimulus as running . (He suggests if a runner covers 6 miles in 50 min, they should bike ~55 min to “count” as 6 miles of running – effectively a ~1.1x time factor for non-impact cardio.) Overall, use heart rate to validate the equivalence: if your bike session hit similar average HR% as your easy runs, time can be compared directly; if it was lower intensity, it counts for less.
	•	Swimming: Swimming provides excellent aerobic conditioning with zero impact. The challenge is that maximal heart rates in swimming are often lower, and it engages the upper body, so the perceived effort might differ. Still, time spent swimming at moderate effort can be treated similarly to easy running time for aerobic benefit. For example, 40 minutes of steady lap swimming might yield a mid-range aerobic load – Garmin might record Aerobic Training Effect ~2.5 (“maintaining fitness”) which is similar to a 40 min easy run . Thus, we can roughly say 1 minute swimming ≈ 1 minute of running at equivalent intensity for aerobic development. Intense swim intervals (like a masters swim session) can drive HR into higher zones and yield higher load, though there’s a practical ceiling because you can’t sustain very high heart rates as easily in water. Empirically, some triathlon coaches use a 4:1 distance ratio (4 yards swimming ~ 1 yard running) but this is less useful than using time and HR. It’s better to note the Training Effect: a hard 30′ swim might produce TE 3.0+, indicating it was akin to a solid run workout for the heart. On the flip side, swims don’t fatigue the legs the same way. So in adjusting a plan, we often let swimming replace easy recovery runs or add aerobic volume, knowing it won’t help running-specific muscle conditioning but will boost cardio fitness without impact.
	•	Rowing/Elliptical: These modalities engage large muscle groups and can raise heart rate nearly as much as running. A vigorous 30-minute rowing session (ergometer or on-water) can produce a training load comparable to a tempo run of equal duration . In one example, a strong 30′ row might register, say, 100+ load points, similar to what a 30′ threshold run would do, because rowing recruits legs, core, and arms to drive HR up. Likewise, the elliptical trainer (especially at a high resistance) can mimic running’s movement with lower impact; many runners find their HR on the elliptical is within 10 bpm of an easy run if they don’t hold the handles. So we treat 10 minutes on the elliptical ≈ 10 minutes running at comparable effort, perhaps with a small discount. (Again, Dick Brown’s guidance of ~10% more time for cross-training applies here , which is a minor difference.) Ultimately, rowing and elliptical are great 1:1 substitutes in terms of aerobic minutes – if you log 45 min hard on the rower, it likely gave you a stimulus close to a 45 min run, which your Garmin load number will confirm.
	•	Team Sports (Soccer, Basketball, Rugby, etc.): Team sports are harder to quantify by duration because they involve stop-start dynamics – periods of sprinting and high effort interspersed with rest. However, if you wear a HR tracker, the internal load tells the story. For example, a competitive 90-minute soccer match can be a huge effort: an elite player might run ~10 km during the game with dozens of sprints . It effectively combines an easy run’s volume with interval bursts on top. Not surprisingly, Garmin would likely report a high Aerobic TE (e.g. 4.0 “highly improving”) plus significant Anaerobic effect for such a match . In training load terms, that soccer game might rack up, say, 300–400 load points – which is equivalent to a very hard running workout, possibly even a long run or intense track session . We’ve seen that a full-court basketball game or intense rugby match similarly can correspond to a tough interval workout (lots of Zone4/5 spikes). Empirically, it’s difficult to assign a simple “X minutes = Y miles” conversion here, but one could say a 90-min soccer game at high effort is roughly on par with a ~10–12 km hard run (since you get both volume and intensity). The key is to trust the load number: if your watch says your evening basketball game was as taxing as a 10k tempo run, believe it. In our system, we’d let a hard team-sport session replace one of the week’s hard runs. For instance, if the plan had a threshold run scheduled and you ended up playing a high-intensity soccer match, that match can serve as the week’s threshold workout – the training effect to your body is similar . In contrast, a light game of pick-up or an easy social sports game might be mostly Zone1-2; in that case it’s closer to an easy run or active recovery (and the plan might not need major adjustment).
	•	Strength Training and HIIT: Pure strength sessions (weightlifting) don’t register much on heart-rate-based load scales – e.g. 45 minutes of heavy lifting might only yield Aerobic TE ~0.5 and Anaerobic TE ~1.0 (minimal cardio load) . That doesn’t mean it’s not fatiguing; it stresses muscles, just not in a way that raises heart rate for long. Because Garmin’s load is cardio-focused, it “gives no points” for muscular fatigue . So we handle strength by other means: we ensure it doesn’t collide with key runs (e.g. do strength on hard run days or rest days) and note that it aids running economy and injury prevention but can’t replace running mileage. High-Intensity Interval Training (HIIT) classes, CrossFit, circuit training, etc. are a different story – they do spike heart rate and often produce substantial load. A 30-minute CrossFit WOD with minimal rest can yield a high Training Effect (Aerobic TE ~3.5, Anaerobic ~2.5) and a load score comparable to a hard interval run . Essentially, a tough MetCon or HIIT session is equivalent to a hard running workout in stress. Our plan treats them as such: if you do a brutal 30′ circuit that leaves you wiped, we’d likely adjust or skip the next day’s intense run. So, while strength/HIIT don’t add to “miles,” we account for their stress by adjusting the plan structure (e.g. avoid scheduling back-to-back hard days of heavy lifts and track intervals). The main constant to remember: traditional strength ≈ 0 in aerobic load (use it for neuromuscular benefits), whereas circuit/HIIT load ≈ running intervals if performed all-out.

Empirically-Defensible Constants for Conversion

While heart rate and measured load are ideal, it’s useful to set some conversion constants for guidance and for scenarios with limited data. Based on the above and available research, we can summarize a few defensible constants:
	•	Cycling: 1 mile of running ≈ 3 miles of cycling at similar effort (2.5–3.5 range) . Or, 10 minutes of running ≈ 30 minutes cycling. Intensity matters: match the HR or RPE to refine this.
	•	Elliptical: 1:1 with running time if similar effort (due to weight-bearing nature), or at most 1:1.1 (10% more time) .
	•	Swimming: ~10 minutes of running ≈ 10–12 minutes of moderate swimming (swimming can be slightly less efficient cardio, so perhaps +20% time). If intensity is high, treat minute-for-minute.
	•	Rowing: 1:1 with running by time at equivalent intensity. A hard 5k row (~20 min) can equal the load of a hard 20 min run.
	•	Soccer/Basketball: 90 min high-level soccer ≈ the load of a ~60 min hard run (tempo/interval mix). In general, 1 hour of intense team sport ≈ 1 hour intense run in load – but the sporadic nature means it’s like combining a few miles of easy running with a lot of sprints. We rely on the device load: e.g. Load 300 from a match = definitely a hard session (equivalent to one of your key runs) .
	•	Strength training: No direct endurance load equivalent (0 miles, since it doesn’t hit cardio). But account for fatigue in scheduling.
	•	HIIT/CrossFit: 30 min hard circuit ≈ 30–40 min of interval running (very high intensity) in training load. Essentially count it as a hard run in your week.

These constants are starting points. They are defensible in that they’re drawn from known physiological differences (e.g. energy cost of cycling vs running ) and coaching experience, rather than arbitrary guesses. Over time, as we gather user-specific data, we will refine these. The long-term vision is to have the system “learn” an individual’s response – but initially, these ratios ensure our adjustments and suggestions are grounded in reality.

Adjusting the Plan: Applying Cross-Sport Load and Guidance

With the ability to quantify each sport’s load, the app can make sensible adjustments to the running plan so that total load remains balanced. The fundamental principle is: count the load, don’t double-dip. If an athlete accumulates a large training load from a cross-training session, the system should treat that as if they had done an equivalent run, and adjust or replace workouts accordingly. For example, if the marathon plan called for an 8-mile (~13 km) threshold run mid-week but on Tuesday the user played an intense 90-minute soccer match, we consider that soccer session fulfilling the threshold workout’s role for that week . The plan could then swap Thursday’s tempo run for an easier run or rest, since the hard effort was already done. Likewise, if someone does a long aerobic bike ride that yields a high load, we might shorten or skip the week’s easy mileage run. This prevents stacking two hard sessions on top of each other inadvertently . The system will never completely wipe out key running elements (because some running is needed for muscle/bone adaptation), but it will make nuanced tweaks: e.g. downgrade a scheduled hard run to easy, trim an easy run’s length, or replace one easy run with the cross-training. The adjustments follow safety rules from our logic: we always keep a minimum number of runs for durability (at least 2 runs/week even in low-run plans) , and we protect the long run (that’s the last thing we’d cut) . In short, cross-training can substitute for aerobic conditioning but not for running-specific impact. This is echoed in our plan flags: e.g. we warn that even with heavy cross-training, a marathoner running <4x/week will have limited durability and we cap their performance forecasts .

User-Facing Guidance: We want these load-based adjustments to be transparent and understandable to the user. Thus, we present recommendations in relatable running terms. For example, the app might detect a big effort and show a popup: “We detected a heavy session. This is roughly similar to an easy 8–10 km run.” . This message converts the abstract load number into the language a runner understands (easy kilometers). We derive those equivalences from the same constants discussed – in that case, the system determined the session’s load was about what an 8–10k easy run would accrue. The guidance then continues with a suggestion: e.g. “Consider making tomorrow’s tempo run easier, and shortening Saturday’s run” . Over time, we can refine these suggestions with more data, but even initially they are grounded in the empirically-set constants and heart rate analysis (making them defensible). The user can then choose to apply the adjustment, do a lighter modification, or ignore it, but at least they’re aware that their Tuesday spin class or soccer match “counted” in their training load.

Finally, by maintaining a consistent load metric and clear equivalences, we ensure no sport “falls through the cracks.” Every effort – whether a long run, a cycle, a swim, or a CrossFit WOD – is accounted for in the training stress balance. This prevents inconsistencies like crediting 90 minutes of cycling arbitrarily as X km; instead, we use HR and load to credit it accurately. The approach is backed by both the literature and practical coaching: it acknowledges that a calorie or heart beat doesn’t care what sport caused it. By respecting total load, the training plan stays realistic and safe. In sum, we forecast each run’s expected load, track all sports with a unified measure, and adjust plans using empirically-derived conversion factors so that the athlete’s overall fatigue and fitness stay on target. This makes the plan truly multi-sport-aware, while still preserving the essential elements a runner needs to succeed.
  Below is (1) a structured natural-language spec (so a new engineer can grok what we’re building), and (2) a Claude-ready implementation prompt (with a parameter table + module boundaries + deterministic rules). I’m also folding in the research-backed pieces on load “currency” and how to compute aerobic vs anaerobic split from Garmin/HR/RPE.

Key research anchors (used in the design):
	•	Session-RPE load is a validated internal-load proxy and correlates well with HR-based load methods; but it needs guardrails when data quality is weak.  
	•	TRIMP family (Banister/Edwards/Lucia) is a standard way to compute internal load from HR time-in-zone / HR reserve.  
	•	Endurance training is often analyzed via 3-zone / threshold domain frameworks; we’ll use “below LT1 / between LT1–LT2 / above LT2” as the physiology basis for the aerobic/anaerobic split when HR is available.  

1) Natural-language spec (what we’re trying to do)

1.1 Goal

When a user logs an unplanned sport session (padel, soccer, cycling, etc.), the app should suggest how to adjust their current 7-day running plan so that:
	•	We avoid absurd outcomes (e.g., “90 min padel replaces 3.5 easy runs”).
	•	We preserve running specificity (you still need kms on legs, especially for HM/Marathon).
	•	We respect fatigue reality (a big session can warrant downgrading/reducing upcoming running).
	•	We support all data tiers:
	•	Tier A (Garmin): aerobic_load + anaerobic_load (+ HR if available)
	•	Tier B (Apple Watch / HR only): HR time series or time-in-zones (+ distance)
	•	Tier C (No watch): duration + RPE (+ sport type)
	•	UX is simple: one popup per logged activity with 3 options:
	•	Keep plan
	•	Apply suggestions (Replace/Reduce/Downgrade as recommended)
	•	Apply lighter version (Reduce only / no replacements)
…and user can revert/adjust later until the next workout (or week) boundary.

1.2 Non-negotiables (decisions we already made)
	•	Adjustments are suggestions, never forced.
	•	We never replace other sports (only planned runs).
	•	We operate on a strict WeekPlan 0..6; we can “peek” to next week only if needed to find a better match.
	•	Long run protection:
	•	Long run is last to go
	•	It should generally remain easy
	•	Minimum 10 km long run (you asked for this; we’ll surface pros/cons below)
	•	Preserve running: always keep at least 2 runs/week (even if heavily downgraded).
	•	Prefer downgrade/reduce before delete:
	•	Default path is reduction/downgrade; replacement only when confidence is high.
	•	Minimum easy run distance clamp:
	•	If we reduce an easy run, do not create silly 1–2 km jogs; clamp to ≥4 km, otherwise replace (and mark complete at expected RPE).
	•	Replacement chain logic (typical case):
	•	Replace 1 best-matched run, then maybe reduce 1 more if load is meaningfully higher.
	•	Edge cases can affect more, but they must be rare and clearly flagged.

1.3 The core technical concept: a “universal load currency”

We need one currency so we can compare:
	•	a logged sport session (any sport, any data tier)
vs
	•	a planned run session (easy/threshold/VO2/long/etc.)

Best-practice approach from the training-load literature is:
Internal load = function(duration × intensity), with intensity derived from:
	•	HR (TRIMP) if available  
	•	Session-RPE if not (validated, but noisier)  

So we define two load numbers per activity:
	•	FatigueCostLoad (FCL) = “how tiring was this on the body?”
	•	RunReplacementCredit (RRC) = “how much running stimulus does this substitute?”

This separation matters because:
	•	Rugby/soccer can be very fatiguing (high FCL) but not a perfect running substitute (lower RRC).
	•	Cycling can deliver a lot of aerobic stimulus (decent RRC) with lower musculoskeletal damage (lower FCL).

1.4 Aerobic vs anaerobic split (what you asked to research + implement)

We will compute an AerobicLoad and AnaerobicLoad for each activity and planned workout because your matcher uses “vibe” (anaerobic ratio).

How we estimate split depends on the best available tier:

Tier A (Garmin)
	•	If Garmin provides aerobic_load & anaerobic_load, use directly (highest trust).

Tier B (HR time in zones / HR series)
Compute internal load via a TRIMP variant, then split aerobic vs anaerobic by time in threshold domains:
	•	Let zones be either:
	•	Watch-provided zones (priority), OR
	•	derived zones from LT / maxHR / restHR fallback.
	•	Aerobic domain = time spent below LT2 / below high threshold zone
	•	Anaerobic domain = time spent ≥ LT2 (upper zones), optionally weighting Z5 more heavily.
This is aligned with the ventilatory/lactate threshold domain framing used in endurance literature and TRIMP variants that segment intensity into domains/zones.  

Tier C (RPE only)
	•	Use session-RPE load: Load ≈ duration × f(RPE), but apply:
	•	intermittency correction for stop-start sports (padel/tennis/soccer) so “90 min” isn’t treated as “90 min continuous tempo”
	•	uncertainty penalty so RPE-only sessions are conservative

Session-RPE is valid at the macro level, but noisier, so we explicitly add conservative guardrails.  

1.5 Why your current system can blow up with padel

The blow-up pattern (“90 min padel replaces many runs”) usually comes from one of these:
	•	Treating 90 minutes of intermittent play as continuous work at RPE 6 tempo (too high load/min for too long)
	•	Missing a saturation curve / diminishing returns on replacement credit
	•	Not separating fatigue (which may be high) from replacement credit (which should be lower for low-specificity or intermittent sports)
	•	Allowing too many modifications per activity without escalating conservatism/uncertainty

So we fix it by:
	•	Active-time fraction (intermittency)
	•	Conservative “RPE-only penalty”
	•	Saturation on replacement credit
	•	Default chain: replace ≤1, reduce ≤1 (rarely more)
	•	Long-run protection + 2-run minimum

1.6 Pros/cons of “min long run 10 km”

Pros
	•	Preserves essential durability + tissue conditioning for HM/Marathon.
	•	Keeps weekly anchor habit.

Cons
	•	For true beginners / heavy fatigue weeks, a strict 10 km can be too much.
	•	In extreme-load weeks, you may prefer 60–75 minutes easy instead of distance.

Implementation compromise:
	•	Keep min(10 km, 65% of planned long run), but allow time-based cap in future (not required now).
You are Claude Code inside an existing running-app codebase.

TASK:
Implement a production-ready “Universal Load Currency + Cross-Sport Plan Adjustment Suggester” that:
1) Converts logged activities (Garmin load, HR-only, or RPE-only) into ONE comparable load currency.
2) Computes BOTH:
   - FatigueCostLoad (how tiring)
   - RunReplacementCredit (how much running stimulus it substitutes)
3) Matches logged activity to the best planned run(s) in the current 7-day WeekPlan (0..6), with optional lookahead to next week if needed.
4) Generates a SINGLE UX suggestion payload with exactly 3 user options:
   A) Keep plan unchanged
   B) Apply recommended changes (may include replace + reduce/downgrade chain)
   C) Apply conservative changes (reduce/downgrade only; no replacements)
User must be able to revert edits until next workout completes (or week boundary; whichever occurs first).

IMPORTANT RULES / DECISIONS (DO NOT CHANGE):
- Only adjust PLANNED RUNS; never replace other sports.
- Trigger logic EVERY time a sport is logged that wasn’t planned.
- We store strict WeekPlan dayOfWeek 0..6 (Mon..Sun). We may peek into next week ONLY if current week has no good match OR only long run remains.
- Long run is last to go:
  - Never fully replace long run unless Injury Mode (ignore injury mode in this task unless already implemented).
  - Default long run is easy.
  - Minimum long run clamp: 10km (or 65% of planned if that is larger reduction; implement the 65% rule described below).
- Always preserve at least 2 runs/week; if only 2 runs/week scheduled, never delete—only reduce/downgrade.
- Prefer reduction/downgrade BEFORE deletions/replacements.
- Min easy-run clamp: if reduction makes easy run < 4.0km, either clamp to 4.0km OR replace it entirely (mark complete at expected RPE/load).
- Normal case: 1 replacement + maybe 1 additional reduction (chain). Edge cases allowed but must be rare and gated by “Extreme Session” triggers.
- Must support tiers:
  Tier A (Garmin): aerobic_load + anaerobic_load (and maybe HR)
  Tier B (HR-only): HR time series OR time-in-zones (+ user/watch zones priority)
  Tier C (RPE-only): duration + session RPE + sport type
- Priority order to avoid double counting:
  Garmin load > HR-based load > RPE-based load
  If Garmin load exists, DO NOT also add HR/RPE load (only use RPE for confidence checks).
- Watch zones priority: if a wearable provides zones, use those zones as the canonical zone mapping for HR-only load.

FILES / INTEGRATION CONSTRAINTS:
- Implement as a NEW MODULE with clean interfaces:
  - src/crossTraining/universalLoad.ts
  - src/crossTraining/suggester.ts
  - src/crossTraining/types.ts
- Integrate into existing week-plan flow (Week -> Workouts[]). Each Workout has dayOfWeek 0..6 and already has expected aerobic/anaerobic load computed at generation time.
- You must NOT break existing generator/load code. Only add modules + minimal integration points.

------------------------------------------------------------
A) UNIVERSAL LOAD CURRENCY SPEC
------------------------------------------------------------

1) Common Types
Create types:

ActivityInput:
  - id, sportKey, startTs, durationMin
  - dataTier: "GARMIN" | "HR" | "RPE"
  - optional: garminAerobic, garminAnaerobic
  - optional: hrSamples[] OR timeInZones{z1..z5}
  - optional: rpe (1..10)
  - optional: distanceKm
  - optional: watchZones (zone boundaries) OR derived zones (maxHR/restHR/LT)

UniversalLoadResult:
  - aerobicLoad: number
  - anaerobicLoad: number
  - fatigueCostLoad: number   (FCL)
  - runReplacementCredit: number (RRC)
  - anaerobicRatio: number
  - confidence: 0..1
  - explanation: string[] (human-readable reasons + uncertainty notes)

2) Compute Internal Load (baseLoad) by tier

Tier A (GARMIN):
  aerobicLoad = garminAerobic
  anaerobicLoad = garminAnaerobic
  baseLoad = aerobicLoad + anaerobicLoad
  confidence high (e.g., 0.9)

Tier B (HR-only):
  - Compute HR-based internal load using a zone-weighted TRIMP.
  - Use 5-zone Edwards-style weights:
      w = [1,2,3,4,5] for zones z1..z5 (minutes in each zone)
    baseLoad = Σ (minutesInZone[i] * w[i])
  - If only hrSamples exist, derive time-in-zones first.
  - Use watchZones if provided; else use derived zones:
      if maxHR+restHR: Karvonen
      else if maxHR only: %maxHR
      else estimate maxHR = 220 - age (only if age exists; otherwise require maxHR)
  - Split aerobic/anaerobic from HR zones:
      aerobicLoad = minutes(z1..z3) * weights(z1..z3)
      anaerobicLoad = minutes(z4..z5) * weights(z4..z5)
    (This is the “domain split”: below LT2 vs above LT2)
  - confidence medium-high (0.75–0.85 depending on inputs completeness)

Tier C (RPE-only):
  - Use session-RPE load style:
      raw = durationMin * LOAD_PER_MIN_BY_RPE[rpe]
    where LOAD_PER_MIN_BY_RPE is your existing mapping (1..10 -> 0.5..6.0)
  - Apply SPORT INTERMITTENCY active fraction (AF) by sport family:
      continuous endurance: AF=0.95 (cycling, steady swim, rowing, elliptical)
      mixed/stop-start: AF=0.55–0.75 (padel/tennis/soccer/basketball)
      strength/crossfit: AF=0.70 (but low run-specific)
    effective = raw * AF
  - Apply uncertainty penalty so RPE-only cannot nuke a week:
      effective = effective * 0.80
  - Split aerobic/anaerobic using RPE bands:
      rpe 1–4 => 95/5
      rpe 5–6 => 85/15
      rpe 7   => 70/30
      rpe 8   => 55/45
      rpe 9–10=> 40/60
    aerobicLoad = effective * aerobicPct
    anaerobicLoad = effective * anaerobicPct
  - confidence medium-low (0.55–0.70)

3) FatigueCostLoad vs RunReplacementCredit
We DO separate “fatigue” vs “replacement credit”:
- fatigueCostLoad (FCL) = baseLoad * recoveryMultiplier(sportKey)
- runReplacementCredit (RRC) = baseLoad * transferFactor(sportKey) * goalDistanceFactor
Where:
- recoveryMultiplier reflects musculoskeletal damage / recovery cost
- transferFactor reflects running-specific stimulus transfer
- goalDistanceFactor depends on user goal (5K/10K/HM/Marathon):
   Marathon/HM: higher transfer to easy/long aerobic work, lower transfer to speed
   5K/10K: slightly higher transfer of high-intensity stop-start sports to VO2/interval vibe
Keep your existing sport multipliers if present, but revise if missing:
  - soccer/rugby high recoveryMultiplier, moderate transferFactor
  - cycling/swim lower recoveryMultiplier, moderate/low transferFactor
  - padel/tennis moderate recoveryMultiplier, moderate transferFactor but intermittent AF applies heavily.

4) Saturation / Diminishing Returns on CREDIT (NOT on fatigue)
To prevent “100km cycle replaces entire week”, saturate ONLY RunReplacementCredit:
- Let rawCredit = RRC
- credit = creditMax * (1 - exp(-rawCredit / tau))
Use defaults:
  tau=800, creditMax=1500
(keep parameters configurable)

Extreme Session triggers (unlock more chain modifications, but still preserve 2 runs/week):
- if fatigueCostLoad >= 55% of plannedWeeklyRunLoad
  OR timeInZ2plus >= 150 minutes (2.5 hours) (HR tier only)
  OR (durationMin >= 120 AND rpe >= 7) (RPE tier)
Then set extremeMode=true.

------------------------------------------------------------
B) MATCHING + SUGGESTION ENGINE (suggester.ts)
------------------------------------------------------------

Inputs:
- weekPlan: Workouts[] for days 0..6 (planned runs only)
- nextWeekPlan: optional (for lookahead)
- activityLoad: UniversalLoadResult
- userGoal: "5k"|"10k"|"hm"|"marathon"
- runnerType: "speed"|"balanced"|"endurance"
- constraints: preserveMinRuns=2, easyMinKm=4, longMinKm=10

Step 1: Candidate scoring (“vibe matching”)
For each planned run candidate, compute:
- plannedWeighted = planned.aerobic + 1.5*planned.anaerobic  (or your existing anaerobic weight)
- activityWeighted = activity.aerobicLoad + 1.5*activity.anaerobicLoad
- anaerobicRatio similarity:
    ratioScore = 1 - abs(activity.anaerobicRatio - planned.anaerobicRatio)
- load proximity:
    loadScore = 1 / (1 + abs(activityWeighted - plannedWeighted) / 30)
- similarity = 0.6*ratioScore + 0.4*loadScore
Bonuses:
- same day bonus +0.15
Penalties:
- long run penalty -0.20 (harder to replace)
Disallow:
- long run cannot be REPLACED unless injuryMode (assume false here)

Step 2: Determine recommended action chain
We generate ONE recommended chain consisting of up to:
- 1 REPLACE (typical)
- + 1 REDUCE or DOWNGRADE (typical if credit exceeds first match)
Edge cases:
- In extremeMode, allow up to 3 modifications, but never below 2 runs/week and do not touch long run unless only option, then reduce/downgrade only.

We prioritize:
1) DOWNGRADE intensity (vo2 -> threshold -> easy) before reducing distance
2) REDUCE distance with min clamps
3) REPLACE only when RRC >= 0.95 * plannedWeighted AND confidence >= threshold (e.g., 0.75)

Distance reduction sizing:
- reduction should aim to remove equivalent fatigueCostLoad delta, not just km:
  newLoadTarget = plannedWeighted - remainingFatigueBudgetToRemove
  reduce distance proportionally but clamp:
    easy: >=4km
    long: >= max(10km, 0.65*plannedLongKm)
If you cannot reduce without violating min km, then recommend replace (mark complete at expected RPE/load).

Step 3: Output a single SuggestionPayload for UX
Payload includes:
- summary text explaining equivalence (e.g., “Your 90 min padel (RPE 6) is estimated to be similar fatigue to ~X km easy run; because data is RPE-only, we’re conservative.”)
- recommendedPlanEdits: list of edits with rationale
- optionB (apply recommended)
- optionC (apply conservative: downgrade/reduce only; no replacements)
- optionA keep

Edits are applied to the plan ONLY after user confirms.

Step 4: Revertability
Store pending suggestion + edits so user can revert until:
- next workout completes OR week boundary, whichever first.

------------------------------------------------------------
C) AEROBIC/ANAEROBIC FOR PLANNED RUNS (you must implement or validate)
------------------------------------------------------------

You must compute/validate planned aerobic vs anaerobic expected loads for each workout type.
Implement as deterministic mapping based on workoutType + intended intensity domain:

Option 1 (Preferred if your generator already produces aerobic/anaerobic):
- Use existing planned loads from generator as truth.

But you must ensure planned loads are consistent with activity loads by using the SAME internal-load currency concept:
- plannedWeighted = planned.aerobic + 1.5*planned.anaerobic (consistent with activity)
- planned anaerobicRatio should reflect workout type:
   easy ~0.05
   long ~0.10
   threshold ~0.30
   vo2 ~0.50
   intervals ~0.55
   hills ~0.60
   race_pace ~0.35
If existing values disagree materially, add a normalization layer that adjusts planned anaerobicRatio toward these targets while preserving plannedWeighted.

------------------------------------------------------------
D) PARAMETER TABLE (export constants)
------------------------------------------------------------

Export in src/crossTraining/constants.ts:

ANAEROBIC_WEIGHT = 1.5
SIM_RATIO_WEIGHT = 0.6
SIM_LOAD_WEIGHT = 0.4
LOAD_SMOOTHING = 30

REPLACE_THRESHOLD = 0.95
CONFIDENCE_REPLACE_MIN = 0.75

EASY_MIN_KM = 4.0
LONG_MIN_KM = 10.0
LONG_MIN_FRACTION = 0.65

MAX_MODS_NORMAL = 2
MAX_MODS_EXTREME = 3

EXTREME_FCL_WEEKLY_PCT = 0.55
EXTREME_Z2PLUS_MIN = 150
EXTREME_RPE_MINUTES = 120
EXTREME_RPE_LEVEL = 7

CREDIT_TAU = 800
CREDIT_MAX = 1500

RPE_ONLY_UNCERTAINTY_PENALTY = 0.80

INTERMITTENCY_ACTIVE_FRACTION defaults:
  padel: 0.60
  tennis: 0.65
  soccer: 0.70
  basketball: 0.70
  rugby: 0.75
  cycling: 0.95
  swimming: 0.90
  hiking: 0.85
  strength: 0.70
(ensure configurable + overrideable by future HR variance)

------------------------------------------------------------
E) DELIVERABLES
------------------------------------------------------------
1) Implement the modules + minimal integration.
2) Add unit tests:
   - 90 min padel RPE 6 should not propose replacing >1 run in normal mode.
   - huge session (e.g., 3h soccer RPE 8 or HR shows 160+ minutes z2+) triggers extremeMode but still preserves 2 runs + long run min.
3) Add logging/telemetry hooks (optional stubs) for later calibration:
   - activity tier, confidence, credit, suggested edits count, user chosen option.

OUTPUT:
- Provide the code in TypeScript.
- Provide brief inline comments for reasoning.
- Do NOT rewrite unrelated files.
- Keep deterministic behavior; no ML.

END.    You are Claude Code working inside an existing running-app codebase.

TASK:
Implement a production-ready “Universal Load Currency + Cross-Sport Plan Adjustment Suggester” that updates a 7-day WeekPlan (0..6) when a user logs an unplanned sport session.

You MUST integrate with the existing system and not break it.

--------------------------------------------
EXISTING INPUTS (DO NOT CHANGE)
--------------------------------------------

1) Sports database (already in code):
export const SPORTS_DB: Record<SportKey, SportConfig> = {
  soccer: { mult: 1.35, noReplace: ['long'], runSpec: 0.40, recoveryMult: 1.20 },
  rugby: { mult: 1.50, noReplace: ['long'], runSpec: 0.35, recoveryMult: 1.30 },
  basketball: { mult: 1.25, noReplace: ['long'], runSpec: 0.45, recoveryMult: 1.15 },
  tennis: { mult: 1.20, noReplace: [], runSpec: 0.50, recoveryMult: 1.10 },
  swimming: { mult: 0.65, noReplace: [], runSpec: 0.20, recoveryMult: 0.90 },
  cycling: { mult: 0.75, noReplace: [], runSpec: 0.55, recoveryMult: 0.95 },
  strength: { mult: 1.10, noReplace: [], runSpec: 0.30, recoveryMult: 1.00 },
  extra_run: { mult: 1.00, noReplace: [], runSpec: 1.00, recoveryMult: 1.00 },
  hiking: { mult: 0.80, noReplace: [], runSpec: 0.45, recoveryMult: 0.95 },
  rowing: { mult: 0.85, noReplace: [], runSpec: 0.35, recoveryMult: 0.95 },
  yoga: { mult: 0.40, noReplace: [], runSpec: 0.10, recoveryMult: 0.85 },
  martial_arts: { mult: 1.30, noReplace: ['long'], runSpec: 0.30, recoveryMult: 1.20 },
  climbing: { mult: 0.70, noReplace: [], runSpec: 0.15, recoveryMult: 1.00 },
  boxing: { mult: 1.40, noReplace: ['long'], runSpec: 0.25, recoveryMult: 1.20 },
  crossfit: { mult: 1.30, noReplace: [], runSpec: 0.40, recoveryMult: 1.20 },
  pilates: { mult: 0.45, noReplace: [], runSpec: 0.10, recoveryMult: 0.85 },
  dancing: { mult: 0.90, noReplace: [], runSpec: 0.35, recoveryMult: 1.00 },
  skiing: { mult: 0.90, noReplace: [], runSpec: 0.50, recoveryMult: 1.00 },
  skating: { mult: 0.75, noReplace: [], runSpec: 0.40, recoveryMult: 0.95 },
  elliptical: { mult: 0.80, noReplace: [], runSpec: 0.65, recoveryMult: 0.90 },
  stair_climbing: { mult: 0.85, noReplace: [], runSpec: 0.55, recoveryMult: 0.95 },
  jump_rope: { mult: 1.10, noReplace: [], runSpec: 0.50, recoveryMult: 1.05 },
  walking: { mult: 0.35, noReplace: [], runSpec: 0.30, recoveryMult: 0.80 },
  padel: { mult: 1.15, noReplace: [], runSpec: 0.45, recoveryMult: 1.05 },
};

2) Planned workouts already have expected aerobic/anaerobic loads assigned at generation time
(verify in generator: it calls calculateWorkoutLoad for each workout).

3) You have this function signature (use it as-is):
export function calculateWorkoutLoad(
  workoutType: string,
  durationDesc: number | string,
  intensityPct: number,
  easyPaceSecPerKm?: number
): WorkoutLoad

--------------------------------------------
REQUIRED UX BEHAVIOR (DO NOT CHANGE)
--------------------------------------------

When a user logs an unplanned sport activity, the app must produce ONE popup suggestion with exactly 3 options:
A) Keep plan unchanged
B) Apply recommended changes (may include replace + reduce/downgrade chain)
C) Apply conservative changes (reduce/downgrade only; no replacements)

Rules:
- Never force. Only suggest; apply only after user confirms.
- The user must be able to revert changes until the next workout completes OR week boundary (whichever occurs first).
- Never replace another sport; only adjust planned runs.

--------------------------------------------
GLOBAL TRAINING RULES (DO NOT CHANGE)
--------------------------------------------

- WeekPlan is 0..6 (Mon..Sun). We can peek into next week ONLY if current week has no good matches OR only long run remains.
- Preserve at least 2 runs/week:
  - If the runner only has 2 planned runs/week, do not delete/replace; only reduce/downgrade.
- Long run protection:
  - Long run is last to go.
  - Never fully replace long run unless Injury Mode (assume injury mode false for now).
  - Long run stays easy.
  - Clamp: long run minimum = 10km AND not below 65% of the originally planned long-run distance.
- Prefer downgrade/reduce before replace:
  - Default chain for one activity: affect up to 2 workouts (typically 1 replace + 1 reduce), edge cases up to 3 only in extreme sessions.
- Easy run minimum clamp:
  - If reduction makes an easy run < 4.0km, clamp to 4.0km OR recommend replacement (mark as complete at expected RPE).

--------------------------------------------
A) UNIVERSAL LOAD CURRENCY
--------------------------------------------

We need a single comparable “load currency” for:
- planned runs (already have aerobic/anaerobic expected loads)
- logged sports (Garmin load OR HR-only OR RPE-only)

We must compute for EACH logged activity:
- aerobicLoad
- anaerobicLoad
- fatigueCostLoad (FCL)  => drives reductions/downgrades
- runReplacementCredit (RRC) => drives replacements
- confidence 0..1
- explanation strings

Data tiers:
Tier A (GARMIN):
- If activity has garmin aerobic_load + anaerobic_load:
  aerobicLoad = garminAerobic
  anaerobicLoad = garminAnaerobic
  baseLoad = aerobicLoad + anaerobicLoad
  confidence = 0.90

Tier B (HR-only):
- If activity has time-in-zones OR HR samples:
  - Use watch-provided zones if present; else derive zones (maxHR/restHR/age fallback via existing zone calculator if available).
  - Compute internal load via a zone-weighted TRIMP-like score:
    weights z1..z5 = [1,2,3,4,5]
    aerobicLoad = Σ minutes(z1..z3) * weight
    anaerobicLoad = Σ minutes(z4..z5) * weight
    baseLoad = aerobicLoad + anaerobicLoad
  confidence 0.75–0.85 depending on completeness.

Tier C (RPE-only):
- If only duration + RPE:
  - Use your existing LOAD_PER_MIN_BY_INTENSITY mapping (or equivalent).
  - Raw = durationMin * LOAD_PER_MIN_BY_RPE[rpe]
  - Apply SPORT mult from SPORTS_DB to reflect intensity scaling:
      raw = raw * SPORTS_DB[sportKey].mult
  - Apply intermittency active fraction AF by sportKey to stop padel/tennis/soccer being treated as continuous tempo:
      AF defaults (can be tuned):
        padel 0.60
        tennis 0.65
        soccer 0.70
        rugby 0.75
        basketball 0.70
        martial_arts 0.75
        boxing 0.75
        crossfit 0.75
        climbing 0.55
        strength 0.70
        dancing 0.80
        walking 0.95
        cycling 0.95
        swimming 0.90
        rowing 0.95
        elliptical 0.95
        hiking 0.85
        skiing 0.85
        skating 0.85
        stair_climbing 0.85
        jump_rope 0.80
        default 0.75
      effective = raw * AF
  - Apply RPE-only uncertainty penalty:
      effective = effective * 0.80
  - Split aerobic/anaerobic based on RPE bands:
      rpe 1–4: 95/5
      rpe 5–6: 85/15
      rpe 7:   70/30
      rpe 8:   55/45
      rpe 9–10:40/60
    aerobicLoad = effective * aerobicPct
    anaerobicLoad = effective * anaerobicPct
    baseLoad = aerobicLoad + anaerobicLoad
  confidence 0.55–0.70

--------------------------------------------
B) FATIGUE VS REPLACEMENT (IMPORTANT)
--------------------------------------------

Use SPORTS_DB separation:
- fatigueCostLoad (FCL) = baseLoad * SPORTS_DB[sportKey].recoveryMult
- runReplacementCredit (RRC_raw) = baseLoad * SPORTS_DB[sportKey].runSpec

Apply goal-distance adjustment to RRC_raw (NOT to fatigue):
- If goal is marathon/hm: slightly increase credit for aerobic-dominant sessions, slightly reduce credit for anaerobic-heavy sessions.
- If goal is 5k/10k: allow slightly more credit for anaerobic-heavy sessions.
Implement as a simple multiplier based on anaerobicRatio:
  anaerobicRatio = anaerobicLoad / max(1e-9, baseLoad)
  if goal in {marathon, hm}:
     goalFactor = 1.05 - 0.20*anaerobicRatio   (ranges approx 0.85..1.05)
  else (5k/10k):
     goalFactor = 0.95 + 0.20*anaerobicRatio   (ranges approx 0.95..1.15)
RRC_raw = RRC_raw * goalFactor

Saturation curve on Replacement Credit ONLY:
- Prevent massive sessions from linearly deleting the week.
  credit = CREDIT_MAX * (1 - exp(-RRC_raw / TAU))
Defaults:
  TAU=800
  CREDIT_MAX=1500

Do NOT saturate fatigueCostLoad; fatigue should remain “real” so we can downgrade/reduce.

--------------------------------------------
C) EXTREME SESSION TRIGGERS
--------------------------------------------

Extreme session enables up to 3 modifications (still preserve 2 runs, protect long run).
Trigger extremeMode if ANY true:
- fatigueCostLoad >= 0.55 * plannedWeeklyRunWeightedLoad
- HR-only: time in zone2+ >= 150 minutes (2.5 hrs) (if available)
- RPE-only: durationMin >= 120 AND rpe >= 7

--------------------------------------------
D) MATCHER + SUGGESTER
--------------------------------------------

We match activity to planned runs based on “vibe similarity” using anaerobic ratio + load proximity:

Define plannedWeighted = planned.aerobic + ANAEROBIC_WEIGHT * planned.anaerobic
Define activityWeighted = aerobicLoad + ANAEROBIC_WEIGHT * anaerobicLoad
ANAEROBIC_WEIGHT default = 1.5

Similarity:
- ratioScore = 1 - abs(activityAnaerobicRatio - plannedAnaerobicRatio)
- loadScore = 1 / (1 + abs(activityWeighted - plannedWeighted) / 30)
- similarity = 0.6*ratioScore + 0.4*loadScore
Bonuses:
- +0.15 if same day
Penalties:
- -0.20 if long run (harder to replace)
Hard constraints:
- if workoutType in SPORTS_DB[sportKey].noReplace, do not REPLACE it (you may still REDUCE/downgrade if allowed).
- Never REPLACE long run unless injuryMode (assume false).

Action chain logic:
1) Use Replacement Credit to decide if we can REPLACE the best matched run:
   - Replace only if:
       credit >= 0.95 * plannedWeighted AND confidence >= 0.75
   - Default: replace at most 1 run.
2) Use Fatigue Cost to decide reductions/downgrades:
   - Always consider a downgrade/reduce if fatigueCostLoad is meaningful even if no replacement is done.
   - Typical: reduce/downgrade 1 run.
3) If credit remains after first replacement AND extremeMode is true, allow:
   - replace 1 + reduce/downgrade up to 2 more (max 3 total mods).
4) Prefer downgrade over distance reduction:
   - vo2 -> threshold -> easy
   - marathon_pace -> easy OR reduce the MP block (do not remove all running)
5) Distance reduction must respect clamps:
   - easy min 4km
   - long run min max(10km, 0.65*plannedLongKm)
   - preserve >=2 runs/week

Output: ONE SuggestionPayload with:
- summary explanation + equivalence statement (“Your 90 min padel (RPE 6, no watch) is estimated to be ~X km easy-run equivalent; because it’s RPE-only, we’re conservative.”)
- recommendedEdits (Option B)
- conservativeEdits (Option C: no replacements, downgrade/reduce only)
- keep (Option A)

IMPORTANT: do not produce run-by-run selection UI. The system chooses which run(s) are impacted and proposes the chain.

--------------------------------------------
E) IMPLEMENTATION FILES
--------------------------------------------

Implement new modules:

1) src/crossTraining/types.ts
- define ActivityInput, UniversalLoadResult, SuggestionPayload, PlanEdit types

2) src/crossTraining/constants.ts
- export all tunables:
  ANAEROBIC_WEIGHT=1.5
  REPLACE_THRESHOLD=0.95
  CONF_REPLACE_MIN=0.75
  EASY_MIN_KM=4
  LONG_MIN_KM=10
  LONG_MIN_FRAC=0.65
  MAX_MODS_NORMAL=2
  MAX_MODS_EXTREME=3
  EXTREME_WEEK_PCT=0.55
  EXTREME_Z2PLUS_MIN=150
  EXTREME_RPE_MIN=120
  EXTREME_RPE_LEVEL=7
  TAU=800
  CREDIT_MAX=1500
  RPE_UNCERTAINTY_PENALTY=0.80
  ACTIVE_FRACTION_BY_SPORT map (as above)

3) src/crossTraining/universalLoad.ts
- export computeUniversalLoad(activityInput, goalDistance, zonesConfig?) => UniversalLoadResult
- MUST use SPORTS_DB multipliers for Tier C.

4) src/crossTraining/suggester.ts
- export suggestAdjustments(weekPlan, nextWeekPlan?, activityLoad, userGoal, runnerType, preserveMinRuns=2) => SuggestionPayload

Integration point:
- wherever the app ingests a logged activity, call computeUniversalLoad then suggestAdjustments and return a SuggestionPayload to UI.
- plan edits only applied on user confirm.

--------------------------------------------
F) TESTS (REQUIRED)
--------------------------------------------

Add tests (Jest or your test framework):
1) 90 min padel, RPE 6, Tier C => should NOT recommend replacing >1 run in normal mode.
2) 3 hours soccer, RPE 8 Tier C => extremeMode true, but still preserves 2 runs and does not delete long run; at most 3 mods.
3) Garmin-tier activity with high anaerobic load => can match a quality run but still default to 1 replace + 1 reduce max unless extreme.
4) If week only has 2 planned runs => no replacements; only reduce/downgrade.

--------------------------------------------
OUTPUT REQUIREMENTS
--------------------------------------------

- Provide TypeScript code only.
- Do not rewrite unrelated files.
- Keep behavior deterministic and conservative under low-quality data.
- Add brief inline comments explaining key choices.
END.
