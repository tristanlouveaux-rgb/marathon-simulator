# Load Accounting Audit

Mosaic, 29 September 2026. Covers the Strava ingest edge function, activity matching, the fitness model, the cross-training engine, the timing check, and the Garmin and Apple ingest paths. No code was changed.

## How this was checked

- **Six earlier claims re-checked.** Each one was reviewed by three independent reviewers told to disprove it.
- **Sweep for new issues.** Six finders searched separate parts of the pipeline. A completeness check then found four areas nobody had covered, and four more finders swept those.
- **Rule for reporting a finding.** It survives only if at least two of its three reviewers did not refute it.
  - Result: 57 of 59 survived, so the reviewers were not strict.
  - "Partially confirmed" means the defect is real but the finder over- or under-stated it. The reviewer's corrected wording is what appears below.
- **Independent checks by Claude.** Claude checked these findings directly, by running the code or reading it line by line:
  - A1 (raw iTRIMP)
  - B1 (missing seed)
  - B3 (easy-run pricing)
  - B4 (overflow double count)
  - C1 (rate limit)
  - D1 (Apple platform check)
  - the cross-training Signal A bypass
  - max HR
- **The rest are verified by reviewers only.** Treat each one as a strong lead to confirm before fixing it.
- **Severity is the finder's label.** It is not a triaged priority.

## Earlier claims: final verdicts

| Claim | Verdict | What actually holds |
|---|---|---|
| Cross-training not discounted in Signal A | Confirmed, wider than stated | Every sync path gives synced cross-training a `garminActuals` twin, which is counted at full weight. The discounted copy is always skipped. Overflow items are counted a second time via `unspentLoadItems`. Walks, hikes and rows can also fill a planned run slot. Inflates the CTL / "Running Fitness" charts, TSB and ACWR trend charts, the week debrief and the coach. Does not affect VDOT, race predictions, athlete tier or the live ACWR. |
| Normaliser mismatch (history vs live) | Partially confirmed | Only affects Strava users whose Garmin supplies an LT heart rate. The size depends on the athlete: about 6% for a typical profile, and up to 20 to 30% either way. The largest effect is the excess-load comparison, which decides whether runs get cut. |
| Max HR pinned by a sensor spike | Confirmed, with corrections | See the max HR section below. |
| Pause gaps in the HR stream | Confirmed, but minor | On the stream path, pause time is credited at the heart rate on resuming. That is roughly what a watch recording through the stop would give. The larger pause effect is on the average-HR fallback. |
| Elapsed time used for duration | Partially confirmed | A documented, deliberate choice (ISSUE-13). It inflates only the fallback estimates (average-HR or no-HR), typically by 5 to 30%. The main stream-based number is unaffected. |
| runSpec defined twice | Partially confirmed | The two tables differ for about 30 sports. That matters much less than the bypass in row 1: live weeks count cross-training at 100% while history counts it at 10 to 75%, so CTL jumps at plan start. |

## Max HR

Tristan remembered a fix. The changelog records one on 7 April ("median of the top 5"), but that fix never reached committed code.

- **Before the fix:** the code used the single all-time peak.
- **8 April, commit `45d18ea`:** introduced a "95th percentile" rule.
  - For 20 or fewer samples, that rule returns the maximum.
  - The Strava sync applies it to only 5 rows, so it always returns the peak.

What each type of user actually gets:

- **Strava plus Garmin.** Max HR is overwritten on every physiology sync with the 95th percentile across all stored activities.
  - Garmin and Strava copies of the same session are both counted, so one spike is dropped only after about 21 sessions.
  - This sync also silently overwrites a max HR the user typed in.
- **Strava only, or Strava plus Apple Watch.** Max HR is derived once, from the last 28 days.
  - With 20 or fewer HR sessions in that window, it is the single highest reading, and the only filter is "below 230".
  - It is never derived again, so one spike becomes permanent.
- **First sync with no max HR set.** The server uses a hard-coded 190 when there is no data, and those scores are stored permanently.
- **Stored iTRIMP is never recalculated when max HR changes.** Old sessions stay on whatever max HR applied when they were first processed.

Size of the effect: a 216 spike against a true 188 cuts every session's load by 32 to 38% for users on the default normaliser (Strava only, Apple, or Garmin without an LT heart rate). For Garmin users with an LT heart rate, the error mostly cancels, but only while the stored iTRIMP and the current normaliser use the same max HR.

## How sessions are adjusted down

Short answer: **iTRIMP decides whether a cut happens. It does not decide how big the cut is.**

1. **Detection uses iTRIMP converted to TSS (Signal B).**
   - The week's actual Signal B is compared with a target.
   - More than 15 TSS over target shows the "Adjust plan" prompt.
   - Up to 15 over leads to a silent trim of the first easy run: excess ÷ 5.52 km.
2. **Sizing goes through the cross-training engine (`universalLoad.ts`, `suggester.ts`).**
   - The engine turns the activity into a "fatigue cost" and a "run replacement credit".
   - Fatigue cost ÷ the week's planned run load sets how many runs are touched: 1, 2 or 3.
3. **The unit error in step 2.** With HR data, the engine uses raw iTRIMP (thousands) instead of TSS. Planned-run load is on a scale of tens to hundreds.
   - **With HR:** a 60-minute ride worth 60 TSS scores 6,750 against a whole week of planned runs worth about 394. It is "extreme", so 3 runs are changed, and the modal shows "≈ 25 km easy equivalent".
   - **Without HR:** the same ride scores 92, which is "light", so 1 run is changed.
4. **Fixed caps set the actual cut, not the load.**
   - Easy runs: −40% (reduce) or −50% (replace), floor 4 km.
   - Long runs: −25% or −30%.
   - Quality sessions: one step down in intensity.
   - In the worked example, the cuts used 7% of the available credit.
5. **The day-before timing check is separate.** It uses TSS on a fixed 15,000 normaliser.
   - 50 or more TSS the day before a threshold, VO2 or long run suggests a downgrade.
   - It never covers marathon-pace, float or fast-finish sessions.
   - It suggests running an easy long run at marathon pace, which increases intensity.
6. **Automatic weekly changes at week advance.** None of these size a cut from iTRIMP.
   - **ACWR status:** caution removes one quality session; high removes two and caps the long run. It reads rolling Signal B.
   - **Effort score:** minutes × 0.85 to 1.15. It reads RPE and HR effort.
   - **Deload weeks:** minutes × 0.80 to 0.90, on a fixed calendar.

The full traces, with a worked example, are in Appendices 1 and 2.

## Findings, by area

The full detail for all 57 findings is below. These are the ones most likely to change what a user sees or does:

- **A1.** Raw iTRIMP is used for cut sizing: every HR-tracked session is "extreme" (reproduced).
- **A2 / A3.** Suggestions are built from the unmodified plan, so a later small session can undo an earlier cut, and timing suggestions can reverse cross-training cuts.
- **A4.** The timing check misses about 45% of hard sessions in a Balanced marathon plan and makes the long run harder.
- **B1.** Users with no Strava history get a false "high" ACWR on plan days 14 to 20. That removes 2 quality sessions in week 3 (checked in code).
- **B2.** Easy and long runs are planned at the recovery rate, so running them as prescribed reads 115 to 180% of target and triggers "Ease Back" (checked in code).
- **B3.** Overflow cross-training is counted twice in Signal A (reproduced).
- **B4.** The coach and the Home ring use different week boundaries, so they can contradict each other on the same screen (59 "On Track" against 82 "Primed").
- **C1.** Every app launch re-downloads HR streams for all recent runs. Strava's rate limit is per app, so a few dozen launches can block syncing for every user (checked in code).
- **C2.** Removing Strava as a Garmin user counts the last 28 days twice.
- **D1.** Apple Watch workout sync appears never to run on the current Capacitor 8 build. The code checks a property Capacitor 8 does not set (checked in code; needs a device test). When it does run, strength, HIIT, yoga and team sports are recorded as walks.

## Index of all 57 findings

Format: label (finder severity; verifier votes) title.

**A. How sessions are cut (cross-training engine, timing check, excess load)**

- A1 (high; confirmed, confirmed, confirmed) Cross-training reduction engine (Tier A+) uses raw iTRIMP as its load, about 75 to 150x too large, so every HR-tracked session is rated 'extreme' and gets near-maximum credit
- A2 (high; confirmed, confirmed, confirmed) Review and ACWR flows build suggestions from the unmodified plan and append new mods, so a later small session can undo or resurrect earlier reductions
- A3 (high; partially, partially, partially) Timing suggestions are computed from the raw plan, then override cross-training reductions and replacements
- A4 (high; confirmed, confirmed, confirmed) QUALITY_TYPES misses most marathon build/peak hard sessions; long-run '1-step downgrade' raises intensity to marathon pace
- A5 (high; partially, confirmed, confirmed) The RRC 'saturation' curve amplifies credit by up to 1.875x at the scale of real Tier B/C inputs, which cancels the runSpec discount
- A6 (medium; confirmed, confirmed, confirmed) Severity denominator and km floor use only the remaining unrated runs as if they were the whole week
- A7 (medium; confirmed, partially, partially) Easy-to-recovery downgrade is a no-op when applied, and its load reduction comes purely from a pace-basis mismatch
- A8 (medium; confirmed, partially, partially) Long-run adjustments retype the week's long run to 'easy'. This strips all long-run protections, so later light sessions can cut it below LONG_MIN_KM.
- A9 (medium; confirmed, confirmed, confirmed) Silent auto-reduce (Tier 1) and the excess card (Tier 2) judge the same excess against different targets
- A10 (medium; partially, partially, partially) Decayed carry judges past weeks against the current week's phase target and today's date, creating phantom excess in a taper done exactly to plan
- A11 (medium; confirmed, confirmed, confirmed) Planned Signal B target never steps down through the taper and ignores deload weeks
- A12 (low; confirmed, confirmed, confirmed) Combined-activity RPE depends on how many items there are, not how hard they were, because it thresholds a summed field that mixes Training Effect defaults and load units
- A13 (low; partially, partially, partially) Re-review and remove leave the Tier-1 'Auto:' easy-run reduction in place
- A14 (medium; confirmed, confirmed, partially) Distance 'reduction' rewrites the warm-up (1 km becomes 3 km) and writes 'X km', which the planned-TSS parser cannot read
- A15 (medium; confirmed, confirmed, confirmed) Accepted suggestion comes back on the next sync; on a moved session Apply is dropped in Plan/Home but applied in Strain; no dismiss exists
- A16 (medium; partially, partially, partially) 'Yesterday's load' is measured differently from the Strain view: per-day max instead of sum, DST-shifted week start drops the prior-Sunday carry-over, adhoc entries always count 0

**B. Load totals, fitness, fatigue and ACWR**

- B1 (high; confirmed, confirmed, partially) No Signal B seed: rolling ACWR fills pre-plan days with 0 from plan day 14, so steady training reads as a load spike and the next week's intensity is cut
- B2 (high; confirmed, confirmed, confirmed) Planned easy and long run TSS uses RPE 3 (0.65/min), so running on the app's own HR target scores 115-140% of plan
- B3 (medium; confirmed, confirmed, confirmed) Signal A counts every Excess Load / overflow activity twice (garminActuals plus unspentLoadItems)
- B4 (high; partially, partially, partially) Weekly EMAs fold the in-progress week in as a full week, and callers disagree on s.w vs s.w-1, so coach readiness contradicts the Home ring on the same screen
- B5 (medium; confirmed, confirmed, confirmed) ctlBaseline is an EMA seeded at 0 over only the fetched rows, so it under-reads steady load and the athlete tier depends on whether the 8- or 16-week fetch ran last
- B6 (medium; confirmed, partially, confirmed) History-mode rows omit zero-activity weeks and start with a partial week, but the client treats the array as consecutive calendar weeks
- B7 (medium; partially, confirmed, partially) ATL inflation for dismissed reductions and recovery debt never reaches the ACWR that drives the plan
- B8 (medium; confirmed, confirmed, confirmed) A scheduled benchmark check-in counts as completed load before it is run, then again when the real activity syncs
- B9 (medium; confirmed, confirmed, confirmed) In-app GPS runs and manual 'Mark as done' sessions are invisible to Signal A and to the rolling ACWR; GPS runs get a flat 30-min estimate in weekly Signal B
- B10 (medium; confirmed, partially, partially) Home strain actual includes passive active-minute TSS, but the plan-derived target does not, and the Readiness page leaves it out
- B11 (medium; confirmed, partially, partially) Day targets handle accepted plan changes inconsistently, and a replaced run becomes a 1-TSS training day
- B12 (medium; partially, partially, partially) iTRIMP-to-TSS normaliser ignores sex, so female TSS is about 19% low
- B13 (medium; confirmed, confirmed, confirmed) Stats 16w/All load chart plots Signal A x 1.4 (an unsourced constant) while 8w shows Signal B, and the extended-history fetch never runs
- B14 (low; confirmed, confirmed, confirmed) Daily Signal B (rolling ACWR and strain) ignores the rated RPE for no-HR activities
- B15 (low; confirmed, confirmed, confirmed) Float-session recoveries not parsed, so planned float TSS and load are undercounted
- B16 (low; confirmed, partially, partially) Coach modal and LLM compare a partial week's Signal A with a full-week target on a different basis from the Plan bar
- B17 (low; partially, partially, partially) Stats trend charts and the Rolling Load drill-down use a different signal or seed than the headline above them (Rolling Load seeds Signal B ACWR with a Signal A baseline)
- B18 (medium; partially, partially, partially) wk.actualTSS is add-only: it double-counts on re-review and in the modal path, misses review-matched sessions, and sizes holiday bridge weeks; the sleep insight reads the wrong weeks
- B19 (low; confirmed, partially, partially) Surplus-run excess items are duplicated on each re-review, unmark or re-match and are never cleaned up
- B20 (low; partially, partially, partially) The per-sport load breakdown counts surplus running on top of the full matched run

**C. Getting activities in (Strava, Garmin, dedup)**

- C1 (high; confirmed, confirmed, confirmed) Standalone sync burns the app-wide Strava rate limit on every launch: hr_drift is never selected, so the drift heal re-fetches the stream for every cached run, and rows with null zones are re-streamed forever
- C2 (high; confirmed, confirmed, confirmed) Removing Strava re-ingests 28 days of Garmin webhook copies, so every recent session counts twice
- C3 (medium; confirmed, confirmed, confirmed) Connecting Strava as a Garmin-only user re-ingests the last 28 days as strava- copies (and the OAuth boot runs both syncs)
- C4 (medium; confirmed, confirmed, confirmed) Two Strava uploads of one session (two devices/apps) are both counted in plan weeks, though history mode treats them as one
- C5 (medium; confirmed, partially, confirmed) Activities are keyed by UTC start_date, but plan weeks advance, weekdays are read and 'today' is expected in local time, so near-midnight sessions land in the wrong plan week or day and can rate the wrong week's slot
- C6 (medium; confirmed, confirmed, confirmed) Standalone sync fetches a single page of 50 activities with no pagination; for high-volume users the newest activities never reach the plan on time
- C7 (medium; partially, partially, partially) Strava sport identity collapses to appType buckets before load sizing: unplanned runs fall back to runSpec 0.35, rowing/kayak/hiking are costed as walking, and soccer/yoga/tennis/elliptical/skiing as generic_sport
- C8 (low; partially, partially, partially) The edge function computes iTRIMP with resting HR from the newest daily_metrics row or a hard 55, ignoring the athlete's known RHR that the client uses everywhere else
- C9 (low; partially, partially, confirmed) The edge function computes time-in-zone as %maxHR (60/70/80/90), but the app's zones are LTHR/Karvonen based, so easy cross-training is classified 'threshold'
- C10 (medium; partially, partially, partially) Garmin run subtypes (and road/gravel cycling, machine cardio) fall through mapGarminType to 'other', so a run is handled as cross-training and never completes its plan slot
- C11 (medium; partially, confirmed, confirmed) Garmin multisport parent and child summaries are all ingested, so a brick or multisport session is counted about twice
- C12 (low; confirmed, confirmed, confirmed) hr_zones is always null for Garmin rows, so the Rolling Load '4-Week Load Focus' buckets each session by avgHR/%HRmax: anaerobic reads about 0 and easy runs read as High Aerobic
- C13 (low; confirmed, confirmed, partially) Garmin iTRIMP is always the avg-HR summary estimate (Jensen under-read). Measured: 5-7% low for quality sessions, not 16%. The stored stream is never used.
- C14 (low; partially, confirmed, partially) Every sync rewrites the last 28 days of Garmin iTRIMP using today's single-day RHR and the current p95 maxHR; older weeks keep old values
- C15 (high; confirmed, confirmed, confirmed) 'Rebuild Plan from Strava Data' puts preserved activities into the wrong plan weeks and drops some of them
- C16 (medium; partially, partially, partially) Removing an activity with × is undone on the next sync

**D. Apple Watch path**

- D1 (high; partially, partially, partially) Apple sync never opens the review queue, so this week's non-run sessions and off-plan runs count as zero load
- D2 (high; partially, partially, partially) Apple mapWorkoutType turns strength, HIIT, yoga and team sports into WALKING (its strength case can never fire)
- D3 (high; confirmed, confirmed, confirmed) 'walk' is matched as a run, so an Apple strength or yoga session can take a planned run slot and then drops out of daily load
- D4 (medium; partially, confirmed, partially) Apple heart rate is never read, so every Apple session is costed as minutes x a fixed rate and runs read as exactly what was planned
- D5 (low; partially, partially, refuted) Apple lookback is 14 days, not the 28 used elsewhere, so sessions older than that at the next sync are lost
# Full findings

## A. How sessions are cut (cross-training engine, timing check, excess load)

### A1. Cross-training reduction engine (Tier A+) uses raw iTRIMP as its load, about 75 to 150x too large, so every HR-tracked session is rated 'extreme' and gets near-maximum credit

- **Finder severity:** high
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/cross-training/universalLoad.ts:99-119 (baseLoad = iTrimp * sportMult at :106), :274-285 (Tier A+ chosen whenever iTrimp>0), :330, :336-344, :369-372; contrast universalLoad.ts:495 (classifyByITrimp does normalise: iTrimp*100/15000); src/cross-training/suggester.ts:285-297 (:291 relativeLoad>=0.55 -> extreme), :359-363, :922-959 (FCL vs computeWeeklyRunLoad), :1031-1047, :1231-1232; src/cross-training/universal-load-constants.ts:83-86 (CREDIT_MAX 1500, TAU 800), :228-231; planned run loads from calculateWorkoutLoad at src/workouts/generator.ts:201, :227; raw iTRIMP enters via src/ui/activity-review.ts:1938-1940 (buildCombinedActivity sums raw item.iTrimp into createActivity), :1222 and :1845 (buildCrossTrainingPopup with no maxReductionTSS cap); src/ui/main-view.ts:2237-2263, :2312; src/ui/excess-load-card.ts:296-322, :332 (synthetic iTrimp = excess*150), :370
- **Independent check:** Reproduced by Claude (probe: 60-TSS ride scores base load 6,750 with HR vs 92 without).

**What the code does (verifier wording):** computeTierAPlus (src/cross-training/universalLoad.ts:106) uses raw Banister iTRIMP (seconds x HRR x e^(bHRR)) times sportMult as the base load, with no x100/15000 step. Every other consumer, including classifyByITrimp in the same file (:495), divides by 150 first. Tier A+ is chosen whenever iTrimp > 0 (:274). For a sync-derived activity that means any activity with an HR stream OR just an average HR, because resolveITrimp falls back to the summary formula. The resulting FCL and RRC are about 150x too large compared with the same session normalised to TSS scale, and about 80 to 100x the Tier C estimate. They are compared against planned-run loads from calculateWorkoutLoad (roughly 40 to 150 per run, about 416 for a 4-run week). So FCL/weeklyRunLoad is far above 0.55, severity is always 'extreme' ('Very heavy training load'), RRC saturates near CREDIT_MAX, and equivalentEasyKm is pinned at 25. A 20-min easy spin and a 3-h ride produce identical adjustments. Both uncapped Activity Review calls are fully affected. The ACWR and excess-card paths are hit too, but the overshoot cap there drops them to a single adjustment, so their km impact is small. The inflated severity headline and the 25 km equivalence still show.

**Scenario:** Probes using the real functions, since deleted. (1) 45 min ride, avg HR 140 (RHR 55, max 190), iTRIMP 5695 (38 TSS). Without iTRIMP: base 51, FCL 49, RRC 53, 4.4 km eq, light, popup proposes easy 6->4 km. With iTRIMP: base 4271, FCL 4057, RRC 1425, 25 km eq, extreme. Popup proposes easy 6->4, easy 8->4.8, long 20->15, or replace easy 6->0 plus cut easy 8->4 and long 20->14. (2) 60 min ride at HR 135, iTRIMP 7012 (47 TSS): tier=itrimp, base 5259, FCL 4996, RRC 1462, 'Very heavy training load', Easy 8->4.8, Float downgraded, Long 14->10.5. Without HR: tier=rpe, base 68, light, 'Sport session logged'. (3) Build-week marathon plan, weekly run load 411. A 20-min easy ride with HR (iTRIMP 1950, about 13 TSS) scores FCL 1389, RRC 962, eqKm 25, extreme, 'about 25 km easy running equivalent'. Replace deletes the 7 km easy run and downgrades the long-run fast finish and the float fartlek. A 3-h ride (iTRIMP 30000, about 200 TSS) produces the identical 3 adjustments. Reached whenever a Strava user with an HR strap or watch syncs cross-training in the current week and goes through the Activity Review reduce/replace modal (activity-review.ts:1222/1845, no overshoot cap). The ACWR and excess-card paths (main-view.ts:2263/2312, excess-load-card.ts:321/332/370) also hit Tier A+ but are bounded by maxReductionTSS: a 20 TSS overshoot yields a budget of 214 load, about 5x the overshoot.

**Reachable in practice:** Yes, in the main Strava flow.

1. **Sync.** A Strava sync with an HR-bearing cross-training activity (stream, or avg HR plus profile RHR/maxHR) in the current week goes into garminPending with raw iTrimp (activity-matcher.ts:703-716).
2. **Activity Review, applyReview.** If the user picks 'integrate' and the activity does not fill a planned cross slot (activity-review.ts:909, :1183-1192), buildCombinedActivity (:1938-1940) feeds the uncapped popup at :1222. Result: always extreme, 3 adjustments, and a replace option that deletes a run.
3. **Auto-processing.** For a single same-day activity, autoProcessActivities reaches the uncapped popup at :1845 only when ACWR is caution or high, or when forceModal is set (:1821-1831).
4. **Capped paths.** The 'Adjust week' / ACWR reduction (main-view.ts:2312) and the excess-load card (excess-load-card.ts:370) also run through Tier A+. The overshoot cap sets adjustmentSeverity to 'light' when capFraction <= 0.35 (suggester.ts:1037-1041) and suppresses replacements (:1060-1062). So these paths propose 1 modest cut, but the headline and 25 km equivalence are still inflated. main-view passes overshootTSS only when computePlannedSignalB returns a value; otherwise that path is uncapped too.

Not affected:
- Manual cross-training logging in events.ts (:1633, :1721) and GPS recording (recording-handler.ts:152) call createActivity without iTrimp, so they use Tier C.
- planSuggester.suggestAdjustments (:589) is exported but never called in src.

**Impact:** For any HR-tracked cross-training session on the uncapped Activity Review path:
- Severity is 'extreme' ('Very heavy training load') regardless of size. In the probe, FCL/weekly load was 3.3x for a 13 TSS spin and 9.7x for a 38 TSS ride; the threshold is 0.55x.
- The equivalence line always reads about 25 km easy running.
- The proposal is 3 adjustments on a 4-run marathon week: easy 8->4.8 km, easy 6->4 km, and long 20->15 km downgraded to easy. That is about 9.2 km cut for a session worth about 2.5 to 4 km easy equivalent.
- The Replace option deletes a whole 6 km easy run and cuts two more.
- Without HR, the same 45-min ride is 'light' with one 2 km trim.
- Session size stops mattering: a 20-min 13 TSS spin and a 3-h 152 TSS ride get identical proposals.

On the capped ACWR and excess-card paths, the budget is about 10 load units per TSS of overshoot instead of about 2.2 (a 20 TSS overshoot gives about 206 load units). The single-adjustment dampening limits the real change to one easy-run cut (8->4.8 versus 6->4 without HR), but the headline and 25 km text are still wrong.

On the user's question about how current sessions are adjusted down: yes, when the activity carries iTRIMP, Tier A+ sizes the reduction budget and severity. Because the raw value saturates every cap, the adjustments are in practice set by CREDIT_MAX, the 25 km clamp, per-run floors and the max-adjustment count, not by how hard the session was.

### A2. Review and ACWR flows build suggestions from the unmodified plan and append new mods, so a later small session can undo or resurrect earlier reductions

- **Finder severity:** high
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/ui/activity-review.ts:69-81 (getWeekWorkoutsForReview applies no workoutMods), :1205-1209, :1252-1263 (applyReview), ~:1842-1872 (autoProcessActivities); src/ui/main-view.ts:2166-2191 (getWeekWorkoutsForACWR, no mods), :2267, :2392-2398; mods applied in order, last wins: src/ui/renderer.ts:297-316, src/ui/plan-view.ts:1573-1583, :1933-1945; src/ui/excess-load-card.ts:41-65 applies d/t/status but never recomputes aerobic/anaerobic

**What the code does (verifier wording):** Four flows build the suggester's weekRuns from a freshly generated plan and ignore wk.workoutMods: applyReview's overflow modal, autoProcessActivities (the silent Tier-1 auto-reduce and the ACWR-gated modal) and triggerACWRReduction. Each then runs applyAdjustments on that same unmodified plan and pushes a new WorkoutMod keyed by name and dayOfWeek. A run that was already replaced therefore reaches the suggester as 'planned' at full distance and full load, and so does a run that was already reduced. The renderers apply mods in array order and the last one wins. Nothing deduplicates mods when they are written. As a result a later, smaller adjustment overwrites an earlier, larger one, and a 'reduced' mod can un-replace a replaced run. The exact km in the report (6.2) depends on context: with a real generated plan the probe gave 4.8 km, but the mechanism is the same. The excess-load-card path is different. It does apply mods and it filters out replaced runs, so it cannot resurrect a run. It does keep the pre-mod w.aerobic/anaerobic, so a reduced run carries its full-distance load. That inflates runLoad and loadPerKm, but the effect is secondary.

**Scenario:** Probe. Session 1: a 90-min ride at RPE 5 without HR; the user picks Replace and 'Easy Run' (8 km, day 0) becomes '0km (replaced)'. Session 2, a 20-min spin, goes through the same review path; the suggester sees Easy Run as planned 8 km and proposes a reduction from 8 to 6.2 km. wk.workoutMods now holds [replaced, '6.2km (was 8km)'], and the plan renders a 6.2 km easy run. The smaller second activity has added 6.2 km back to the week.

**Reachable in practice:** Yes, through normal sync flows. stravaSync calls processPendingCrossTraining (activitySync.ts:113-167), which routes as follows:
- **Batch review:** if there are 3 or more pending items, any run in the batch, or the oldest item is over 24h old (isBatchSync, lines 96-104), the batch goes to showActivityReview and then applyReview. There every activity defaults to 'integrate' (activity-review.ts:292-295). Any cross-training that does not fill a generic cross slot always opens the modal. A spin synced the next morning takes this path.
- **Single same-day activity:** this goes to autoProcessActivities. Its silent Tier-1 auto-reduce (signalBBaseline > 0 and excess 0 to 15 TSS) always reduces the first unrated easy run from its original distance. Repeated small activities therefore overwrite each other's reductions, or un-replace a replaced easy run, with no modal shown.
- **autoProcessActivities modal:** fires only when ACWR is caution or high. forceModal is effectively dead because openAdjustWeekModal has no callers.
- **triggerACWRReduction:** reachable from the ACWR reduce buttons (home-view.ts:2068, main-view.ts:2545).
- **Excess-load card:** plan-view.ts:2550/2642 call triggerExcessLoadAdjustment. This path applies mods, so it only has the stale-load issue.
- **Recovery:** re-review (openActivityReReview) strips all 'Garmin:' mods and reprocesses together, which masks the stacking. Tier-1 'Auto:' and 'ACWR:' mods are not stripped.

**Impact:** - **Resurrection:** in the probe, a replaced 8 km easy run came back as 4.8 km after a 20-min spin was processed. The week gains 4.8 km of running, about 30 aerobic load units, from an activity that should have removed load. With mods applied, the suggester would instead have downgraded the threshold session.
- **Reduce then smaller reduce:** a 60-min ride cut the run to 4.8 km. A later 5 to 15-min spin raised it to 6.0–7.3 km, a net gain of 1.2–2.5 km per occurrence. The Tier-1 silent path has the same effect, capped at origKm − 1.
- **Stale load (excess-load-card path):** for a run reduced to 4.8 km, weighted runLoad is 59.5 against a correct 33, so loadPerKm is inflated about 1.8x (12.4 vs 6.9). Later Reduce decisions cut about 45% fewer km per unit of budget, and the Replace check (remainingLoad < runLoad) is harder to pass. These runs are already ranked last (alreadyDowngraded −0.5 and excluded from weeklyRunLoad), so this effect is secondary.

### A3. Timing suggestions are computed from the raw plan, then override cross-training reductions and replacements

- **Finder severity:** high
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/cross-training/timing-check.ts:169, :185, :234-241, :254-268; src/ui/plan-view.ts:229-241, :1932-1952, :2662-2690; src/ui/home-view.ts:1545-1550, :1568; src/ui/events.ts:1739-1751, :1856-1873, :1937-1939, :2317-2327; src/gps/recording-handler.ts:155-165; src/ui/main-view.ts:1149-1157; src/cross-training/suggester.ts:423, :1234-1235; src/ui/activity-review.ts:1263-1274

**What the code does (verifier wording):** The central defect is real. mergeTimingMods rebuilds 'Timing:' suggestions from the raw generateWeekWorkouts output, skips a run only when wk.rated holds a positive number, and appends the suggestions after every non-timing mod. A quality run (long, threshold or vo2) that a Garmin/Strava review has already reduced or replaced therefore still gets a 'Timing:' mod. That mod carries status 'planned' and the raw-plan newType and newDistance. Four reachable paths are affected: (a) The Plan card shows the suggestion box on the already-reduced card. Apply then writes the raw-plan-derived distance and type after the cross-training mod, which reverses the reduction. The reduced label and Undo button are also hidden. (b) The Home 'today' hero overwrites d and status with the suggestion. A replaced run reappears as today's workout at the suggestion distance. (c) applyRecoveryAdjustment (from the Plan and Home recovery modals) re-applies every mod, so the recovery change is computed from the timing values. (d) The GPS impromptu-run suggester re-applies every mod, so a replaced or reduced run becomes a fresh 'planned' candidate that is not counted as downgraded. Three parts of the report are wrong. The manual cross-training suggester in events.ts (logActivity, :1739-1751 and :1856-1873, including the re-apply block at :1855 and the unrated note at :1937-1939) is unreachable. So is main-view.ts:1149-1157. The suggester also does not see 13.5 km: '13.5 km' (with a space) fails both distance parsers, so the distance falls back to aerobic/35.

**Scenario:** Probe (deleted): a 4-run Balanced marathon plan, week 6, 15 km Sunday long run. A Saturday ride (iTRIMP 12000) is reviewed and the long run is reduced to 10 km ('Garmin: Cycling' mod, status reduced). On the next sync, mergeTimingMods appends 'Timing:' newType 'marathon', newDistance '13.5 km' (from the raw 15 km). The Plan card still shows 10 km, with 'Consider marathon pace · −10% distance'. On Apply, the card becomes 'marathon' 13.5 km, so the cross-training cut is reversed (+3.5 km). Before Apply, the events.ts suggester already sees this run as marathon, 13.5 km, status 'planned'. If the run had been replaced, the Home hero (home-view.ts:1568 filter) shows it again as today's workout, at the suggestion's distance. Reachable in normal use: a hard cross-training day before a long run or quality session triggers both the review reduction and, on the next sync or drag, the timing check on the same session.

**Reachable in practice:** Yes, in normal use. Current-week cross-training (for example a Strava ride) is queued, then reviewed, and the user picks Reduce or Replace on a long, threshold or vo2 run scheduled the next day. On the next Strava or Garmin sync (every app open or refresh), or on any Plan move or drag, mergeTimingMods appends the Timing mod after the cross-training mod. Then: the Plan tab shows the suggestion with Apply. The Home tab's 'today' hero shows the suggestion distance and resurrects a replaced run. The Plan and Home recovery modals apply their change on top of the timing values. A free GPS recording that doesn't distance-match a planned run treats the run as fresh. The run must be unrated and the previous day must have at least 50 Signal B TSS, i.e. iTrimp of about 7500 or more at the fixed /15000 scale (the file uses no personal normalizer). Not reachable: the events.ts logActivity manual form (legacy #wo container never rendered) and main-view.ts showRecoveryAdjustModal (dead code).

**Impact:** In the probe scenario (15 km long run, 80 TSS ride the day before):
- **Reduced long run (reported scenario):** the review cuts it to 10 km. Apply sets it to 13.5 km at marathon effort (+3.5 km), and to a harder type if the review had downgraded it to easy. The suggestion then reappears after the next sync.
- **Home hero:** before any Apply, it shows 13.5 km instead of 10 km. A replaced run, which should be 0 km and hidden, reappears as a 13.5 km planned workout on its day.
- **Recovery 'Reduce Distance':** on that run it parses '13.5 km' as 0 km (regex needs 'km' with no space) and writes '3km (was 0km)'. 'Downgrade' writes '13.5 km @ easy effort'. Both are appended after the cross-training mod, so they replace the 10 km reduction.
- **Tier with 50–74 TSS the day before:** newDistance is the raw '15km', so every override restores the full 15 km.
- **GPS extra-run suggester:** a replaced or reduced run is offered again as a fresh, non-downgraded candidate.
- **Scope:** only plan display and workoutMods change. CTL/ATL/ACWR are computed from actual activities and are not affected directly.

### A4. QUALITY_TYPES misses most marathon build/peak hard sessions; long-run '1-step downgrade' raises intensity to marathon pace

- **Finder severity:** high
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/cross-training/timing-check.ts:29, :37, :41, :52-55, :166, :182, :187; src/workouts/intent_to_workout.ts:61-70, :73-78, :129-136, :141-148, :151-175; src/workouts/scheduler.ts:42-44; docs/PRINCIPLES.md:170

**What the code does (verifier wording):** The claim is correct in substance and I could not refute it. The timing check only covers workouts typed threshold, vo2 or long (timing-check.ts:29, :166). The plan engine also emits marathon_pace, float and progressive sessions, and it types the fast-finish long run as 'progressive'. All of these are skipped, even though the scheduler and renderer class them as hard. In a 16-week intermediate or advanced Balanced marathon at rw 3–6, 94 of 170 hard sessions are covered (55%): build 16 of 66, peak 4 of 22. Speed and Endurance marathon plans cover 126 of 170 (74%). Every race distance loses protection on the fast-finish long run in weeks 2, 5, 8, 11 and 14.

For a normal long run at 50–99 prior-day TSS, the "downgrade" suggests 'marathon pace' (newType 'marathon', newRpe 6). The generated long run is RPE 3 at easy pace, so the suggestion raises intensity. This contradicts PRINCIPLES.md line 172 (the report says 170). The ladder's 'marathon' type is also emitted by the 1-step threshold downgrade, and no type-keyed function recognises it. Three small corrections:
- The doc rule is at line 172, not 170.
- newRpe 6 lives only on the suggestion mod. The accept handler writes newType and newDistance but not newRpe (plan-view.ts:2679-2688), so after accepting, the long run keeps RPE 3 and just changes to the unknown type 'marathon'. The harm is mainly the suggestion text ("Consider marathon pace today", "Apply: marathon pace ↓") plus the unrecognised type after accepting.
- Related bug (not in the report): the scheduler finds the long run by t === 'long' (scheduler.ts:41). The fast-finish long run is typed 'progressive', so it gets placed on a quality day (Tue) and Sunday is left empty.

**Scenario:** Probe over 16-week plans, rw 3–6, all 12 week-by-week combinations: Balanced marathon covers only 94 of 170 hard sessions (55%): build 16 of 66, peak 4 of 22. Speed and Endurance marathon cover 74%. Half and 10K plans still miss every progressive or float session. Week 8 (build) of a Balanced marathon is progressive@Tue, marathon_pace@Thu, float@Sat. A 120-TSS day before any of them produces no suggestion. Long-run case: a 60-TSS Saturday before a 15 km RPE-3 long run produces mod {newType:'marathon', newRpe:6, label:'marathon pace'} with no distance cut, which asks for a harder long run.

**Reachable in practice:** Yes, in normal use. mergeTimingMods regenerates the current week through the plan-engine path (timing-check.ts:229-253) and runs:
- after every Strava sync (stravaSync.ts:160-164),
- after every Garmin or Apple activity sync (activitySync.ts:50-54),
- on every manual workout move or drag (plan-view.ts:2482, :2807, :2841).
The suggestion banner and "Apply" button appear in the expanded plan card (plan-view.ts:229-243).

Any marathon or half user in build or peak who logs a hard day (Signal B of at least 50, e.g. football, a hard ride, or an extra run) the day before a Marathon Pace, Float or Fast-Finish long run gets no suggestion. Every user in weeks 2, 5, 8, 11 and 14 has an unprotected long run.

The long-run 'marathon pace' suggestion appears whenever the prior day scores 50–99 TSS before a plain long run, which is the common Sunday case in the other weeks. It is only a suggestion until the user taps Apply. After that the workout type becomes the unrecognised 'marathon', and RPE stays at 3 because the accepted mod omits newRpe.

**Impact:** Share of hard sessions the timing check can see (16-week plan, rw 3–6):
- Balanced marathon, intermediate or advanced: 55% overall, 24% in build (16/66), 18% in peak (4/22).
- Speed or Endurance marathon: 74%.
- Novice Balanced marathon: 59%.
- Half: 74–85%.
- 10K and 5K: 88%. The missing 12% is all the fast-finish long runs.

The fast-finish long run (5 of 16 weeks) never gets a suggestion, even at 120+ TSS the day before.

For a normal 13–16 km RPE-3 easy long run, a prior day of 50–74 TSS produces "Consider marathon pace today" with no distance cut. 75–99 TSS produces "marathon pace, −10% distance". Both ask for a faster long run, the opposite of a downgrade. Only 100+ TSS gives the intended easy-pace, shorter long run.

After accepting, threshold-to-'marathon' and long-to-'marathon' workouts get the generic Z2-3 HR target and an easy-pace duration estimate. The intended marathon_pace handling is Z4 and 0.87x easy pace.

### A5. The RRC 'saturation' curve amplifies credit by up to 1.875x at the scale of real Tier B/C inputs, which cancels the runSpec discount

- **Finder severity:** high
- **Verifier votes:** partially_confirmed, confirmed, confirmed
- **Code:** src/cross-training/universalLoad.ts:60-62, :336-344; src/cross-training/universal-load-constants.ts:83-86 (TAU 800, CREDIT_MAX 1500); same curve duplicated at src/cross-training/suggester.ts:165-166, :232-235 and src/cross-training/load-matching.ts:35-39

**What the code does (verifier wording):** The only live saturation curve is `saturateCredit` at universalLoad.ts:60-62, applied at :344. Its slope at the origin is CREDIT_MAX/TAU = 1.875. Credit exceeds the raw RRC for every raw value below about 1,139. Tier C inputs (and Tier B, which is rarely reached) produce raw RRC of roughly 10 to 150, so the curve multiplies RRC by about 1.71 to 1.86x instead of capping it. The reported numbers are exact:
- A 60-min ride at RPE 4 with no HR: baseLoad 54.7, FCL 52, raw 31.3, RRC 57.6.
- A 60-min `extra_run` at RPE 4: baseLoad 76.8, RRC 142.5.

In the live `buildCrossTrainingPopup` path, that amplified RRC is the replace budget. So a Tier C 60-min easy ride makes "Replace" delete a planned 7 km easy run (runLoad 52.5). The unamplified raw value of 31.3 could not do this.

Corrections to the report:
1. The copies of the curve at suggester.ts:165-166/232-235 and load-matching.ts:35-39 are dead code in production.
2. SCIENCE_LOG does not clearly contradict the code on "50-70% credit". Its own example (rawRRC 500 gives ~662) already shows credit above raw, so "50-70%" most plausibly means a share of CREDIT_MAX. Measured that way the code gives 46% at raw 500 and 63% at raw 800. What SCIENCE_LOG gets wrong is the input scale, since real Tier B/C raw is about 10 to 150, not 500 to 800. Its example numbers are also off: actual values are 697, 1070 and 1377, where it says 662, 948 and 1328.
3. When the activity has an HR stream, it takes the iTRIMP tier (Tier A+), not Tier B/C. There raw RRC is in the thousands, and the curve genuinely compresses it (0.69x at raw 2000).
4. The unamplified credit is 31.3, not 32.6.

**Scenario:** Probe. A 60-min easy ride without HR (manual log, or Strava without HR) gives baseLoad 54.7 and FCL 52, but RRC 57.6: the credit exceeds the session's own load. Replace deletes the 7 km easy run outright (run load 52.5 is at most 57.6). With the unamplified credit of about 32.6 it could only have been trimmed. A GPS-recorded 60-min run at RPE 4 ('extra_run') gets RRC 142.5 against its own base load of 76.8.

**Reachable in practice:** Yes. Tier C inputs (no iTRIMP, no HR zones, not Garmin) reach `buildCrossTrainingPopup` through four live flows:
1. **Strava/Garmin cross-training with no HR.** The edge function stores itrimp as null when there is no HR (sync-strava-activities/index.ts:859, :906, :1222). `buildCombinedActivity` (activity-review.ts:1936-1940) then passes `iTrimp` as undefined, and activity-review.ts:1222 calls the popup.
2. **Impromptu GPS run not matched to a plan slot**, or a match the user declines. This creates `createActivity('extra_run', ...)` (recording-handler.ts:152) and calls the popup at :174.
3. **Manual "Add Activity" log.** renderer.ts:1557 calls `logActivity` in events.ts:1633/1721, which calls the popup at :1756/:1882. The form is rendered into `#wo` in main-view.ts:551.
4. **Excess-load and ACWR "Reduce" flows** (excess-load-card.ts:290/370, main-view.ts:2234/2312) when the source items lack iTRIMP.

Tier B is effectively unreachable in the Strava flow. HR zones come from the same HR stream as iTRIMP, and `computeUniversalLoad` checks iTRIMP first (universalLoad.ts:269). HR-recorded sessions therefore take the iTRIMP tier, where this amplification does not apply; a different mis-scaling does (RRC around 1,400 against run loads of 50 to 200).

The deletion only happens if the user taps "Replace". But the amplification is what makes the Replace option appear: suggestion-modal.ts:141 shows it only when a replace adjustment exists.

**Impact:** For Tier C sessions, the replacement budget and the "≈ X km easy" figure are inflated by 1.71 to 1.86x:
- A 60-min RPE 4 ride shows 4.8 km instead of about 2.6 km. RRC is 57.6 instead of 31.3, which is higher than its own FCL of 52.
- A 60-min RPE 4 run shows 11.9 km instead of about 6.7 km. RRC is 142.5 instead of 79.9.

Effective credit per unit of baseLoad is:
- cycling: about 1.05 (57.6 / 54.7), where the configured runSpec is 0.55
- `extra_run`: about 1.86 (142.5 / 76.8)

In the probe week, the no-HR ride offered "Replace", which deletes the whole 7 km easy run (load 52.5). At raw credit (31.3 < 52.5) no replace would be possible; only a reduction would be offered. The Reduce option was the same either way in the probe (4.8 km), because the 40% per-run cap applies first.

For `extra_run` at light severity (one adjustment, cheapest run first), the 7 km run is replaced even without amplification (79.9 ≥ 52.5). The amplification matters when the cheapest replaceable run costs more than the raw credit. For example, a 60-min run can wipe a planned easy run with load up to 142.5 (about 19 km) instead of about 80 (about 10.7 km).

At heavy or extreme severity (2 to 3 adjustments), the inflated budget lets one session replace more runs. The limits are still `preserveMin` (suggester.ts:841) and the km floor.

In the excess-load flow, the overshoot cap partly offsets the inflation. It divides by a TSS figure derived from `equivalentEasyKm` (suggester.ts:1031-1038), and that figure is inflated by the same factor.

### A6. Severity denominator and km floor use only the remaining unrated runs as if they were the whole week

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/cross-training/suggester.ts:359-363, :948, :953-959, :1060, :500-525, :714-722, :585, :646, :780, :808, :847; callers pass unrated-only lists: src/ui/activity-review.ts:1205-1209, src/ui/excess-load-card.ts:73-84 and :342-345, src/ui/main-view.ts:2267-2268; floorKm is a weekly floor from src/calculations/fitness-model.ts:1225-1237

**What the code does (verifier wording):** In buildCrossTrainingPopup, severity is FCL / computeWeeklyRunLoad(weekRuns). That function sums only runs with status 'planned' (suggester.ts:359-363). The floor check uses allPlannedKm = sum(weekRuns) against the weekly floorKm (suggester.ts:1059-1060, 499-525, 713-722). The four cited call sites (activity-review.ts:1205-1209 and :1838-1840, excess-load-card.ts:346-348, main-view.ts:2267-2268) pass only the week's unrated workouts. So both the severity denominator and the floor total cover only the runs still to do. They shrink as runs are completed, not as calendar days pass: missed past-day runs stay in the list (excess-load-card.ts:79-88). The same session therefore escalates light to heavy late in the week, which unlocks long-run cuts (the gate is severity !== 'light' at :633 and :800) and more adjustments. The weekly floor binds against the remaining km only, even when the whole week is far above it. workoutsToPlannedRuns also parses the float fartlek main set as 0 km, so the whole session counts as 2 km (warm-up and cool-down only), which shrinks the km total further. One correction: "every caller" is overstated. events.ts:1755 and :1879 (logActivity) and recording-handler.ts:169 pass the whole generated week, including rated runs.

**Scenario:** Probe, base week of easy 8 km, threshold, VO2 and long 13 km. A 60-min ride at RPE 4 without HR on Monday (all runs remaining) is light and trims the easy run from 8 to 4.8 km. The same ride on Saturday, with only the long run unrated, shows 'Heavy training load' and cuts the long run from 13 to 10 km. Floor case: with floorKm 20 and 13.2 km remaining (long run done), slack is 0. Easy and long distance cuts and replacements are blocked, and easy runs are diverted to the recovery-downgrade path.

**Reachable in practice:** Yes, in normal use.
- **applyReview (activity-review.ts:1222):** a Strava or Garmin cross-training activity that fills no cross slot goes to buildCrossTrainingPopup with unrated runs and no budget cap. The modal is always shown, with the floor on whenever ACWR is safe or low.
- **Auto path (activity-review.ts:1845):** the modal shows only when ACWR is caution or high, or when forceModal is set. In the first case the floor is off, so only the severity half applies.
- **triggerExcessLoadAdjustment (excess-load-card.ts:370):** fired from the plan-view excess card at plan-view.ts:2550 and :2642. ACWR can be safe, so the floor is on. maxReductionTSS=excess damps adjustmentSeverity only when capFraction <= 0.35. The headline severity is never damped.
- **triggerACWRReduction (main-view.ts:2312):** reachable from readiness-adjust-btn when there is unspent load, even with ACWR safe (home-view.ts:2064-2068). It forces light only when ACWR is at most 5% above the ceiling.

Two call sites do not show the shrinking behaviour: events.ts logActivity (legacy "Add Activity" form, renderer.ts:1557) and recording-handler.ts. They pass the full week, rated runs included.

**Impact:** Same session, same week, different outcome depending on how many runs are completed:
- **Base week:** Monday is light and trims the easy run by 3.2 km. With only the long run left it becomes "Heavy training load" and cuts the 14 km long run by 3.5 to 4 km (25 to 29%). The denominator falls from about 478 to about 101 load units, about 4.7x smaller.
- **Floor on (ACWR safe):** the same late-week case offers no adjustment at all. The week is 33.5 km against a 15.67 km floor, but only the 14 km still to run is compared with the floor.
- **Build week:** once the 13 km long run is done, slack drops to 0 even though the week totals about 26 km as parsed (about 32 km in reality) against a 19 km floor. Easy trims and replacements are blocked, and a quality session gets downgraded instead.
- **Float fartlek:** counted as 2 km instead of about 8 km, which removes about 6 km from the floor total.
- **Escalation to heavy:** the adjustment cap goes from 1 to 2, and long-run cuts become possible.

### A7. Easy-to-recovery downgrade is a no-op when applied, and its load reduction comes purely from a pace-basis mismatch

- **Finder severity:** medium
- **Verifier votes:** confirmed, partially_confirmed, partially_confirmed
- **Code:** src/cross-training/suggester.ts:585-601, :464-471 (computeWorkoutWeightedLoad passes no easy pace), :1258-1266 (paceForType returns the literal 'recovery'), :1079-1082, :1343 (t kept as 'easy'), :1356-1361 (recalc without easy pace); src/workouts/load.ts:25, :69; src/workouts/generator.ts:201 (stored loads use the runner's easy pace); also src/ui/renderer.ts:313

**What the code does (verifier wording):** Confirmed, with three small corrections. The easy-to-recovery fallback (suggester.ts:582-601) takes runLoad from the workout's stored aerobic/anaerobic, which the generator computed at the runner's easy pace. It subtracts computeWorkoutWeightedLoad('recovery', km, 3), which never gets an easy pace, so it prices recovery at 5.5 x 1.12 min/km. applyAdjustments then keeps t='easy' (line 1343) and leaves RPE at 3. It writes d='<km>km @ recovery (easy)' and modReason 'Downgraded from easy to easy due to <sport>'. The only change to the planned load is the recalculation at line 1358, which runs at the default 5.5 min/km.

Correction 1, the threshold. The raw reduction turns positive at an easy pace of about 5:56 to 6:11/km, depending on distance. But the downgrade is only offered when the reduction exceeds 5 load units (line 588). That starts at about 6:48/km for 6 km, 6:39 for 8 km, 6:22 to 6:24 for 10 to 12 km, and 6:56 for 5 km. It is not "about 6:10".

Correction 2, the modal text. 'run at easy instead' exists only in reduceOutcome.description, and nothing renders it. The modal actually shows 'Downgrade: Keep 6 km, drop to lower intensity' (suggestion-modal.ts:107-117).

Correction 3, which workouts shift. The pace-basis shift fully affects workouts whose recalculated description is distance-based: easy reduces, recovery downgrades, and progressive runs turned into plain km. Time-based quality downgrades ('20min @ ...', 'NxMmin') shift only through their warm-up and cool-down km (load.ts:44).

**Scenario:** Probe: easy pace 7:00/km, floorKm 20, two 6 km easy runs remaining. Reduce offers two 'downgrade to recovery' adjustments with lr=8 each. After applyAdjustments: t=easy, rpe 3, d '6km @ recovery (easy)', and load drops from 48/3 to 38/2, purely because it is recomputed at 5.5 min/km.

**Reachable in practice:** Yes. Every live suggestion flow passes floorKm (from computeRunningFloorKm, 10 to 35 km/week) and an ACWR status:
- excess-load-card.ts:356 and :457
- events.ts:1654, used at :1762 and :1888 (manual cross-training log and excess-duration re-log)
- activity-review.ts:1219 and :1844 (Strava/Garmin sync review)
- main-view.ts:2304
- recording-handler.ts:180

The floor applies whenever ACWR is safe, low or unknown (suggester.ts:500-501). In the excess-load-card flow ('Reduce' on the week-overload card), allPlannedKm counts only the remaining unrated workouts (filterRemainingWorkouts, excess-load-card.ts:338-348). So mid-week the floor binds whenever the remaining km are at or below the whole-week floor, which is common. The recovery downgrade then appears only for runners whose stored easy pace is slower than about 6:20 to 6:55/km, depending on run length.

For faster runners, lr <= 0 when the floor binds, so no easy run is touched at all. The pace-basis shift on reduce and downgrade loads applies to every applied mod, for every runner whose easy pace is not 5:30.

**Impact:** For a runner at 7:00/km, a 'Downgrade to recovery' of a 6 km easy run lowers that workout's planned weighted load from 52.5 to 41 (-22%; aerobic/anaerobic 48/3 to 38/2). For 10 km it goes from 86 to 67.5. All of that change comes from swapping 7:00 for the 5.5 min/km base. In the model, the type (easy), RPE (3) and distance are unchanged, so recomputed at the runner's own pace the change is 0.

Cards that display load via renderer.ts:896 price both the original and the downgraded run at 5.5 min/km, so they show no change at all. The user does see an instruction of '6km @ recovery (easy)' and the reason 'Downgraded from easy to easy'.

On reductions, the load actually removed differs from the budgeted loadReduction by pace.
- 4:30 runner cutting 8 to 4.8 km: 11 is removed against 17.6 budgeted, and a 1 km cut can remove nothing.
- 7:00 runner: 35.5 is removed against 27.4 budgeted.

These stored loads feed plannedAerobic/runLoad for later suggestions (suggester.ts:1232).

### A8. Long-run adjustments retype the week's long run to 'easy'. This strips all long-run protections, so later light sessions can cut it below LONG_MIN_KM.

- **Finder severity:** medium
- **Verifier votes:** confirmed, partially_confirmed, partially_confirmed
- **Code:** src/cross-training/suggester.ts:632-673 (long reduce, newType 'easy' at :666), :799-825 (:819), :1344-1354 (applyAdjustments sets workout.t = adj.newType at :1353), :1307-1315 (fast-finish downgrade sets t='easy', rpe 3), :315, :431, :633, :643, :800; persisted as newType in src/ui/activity-review.ts:1263-1272 and re-applied by src/ui/renderer.ts:309

**What the code does (verifier wording):** The defect is real, but it has a narrower reach than the report implies.

A long-run distance reduction always emits newType 'easy' (suggester.ts:666 reduce path, :819 replace path). applyAdjustments writes it into workout.t (:1353), and the week mod stores newType = mw.t (activity-review.ts:1272, excess-load-card.ts:404, main-view.ts:2401, events.ts, recording-handler.ts).

A fast-finish long run is generated as t='progressive' (intent_to_workout.ts:62-67). A downgrade of it is proposed and shown as "marathon pace", but the /last\s+\d/ branch (:1308-1314) applies it as a plain '13km' run with t='easy' and rpe 3. The guard at :1343 then keeps it 'easy'. The reported loadReduction is 30.5, while the applied change is 118 on the suggester's own load basis (76.5 on stored plan loads).

Once a run's type is 'easy', every long-specific rule stops applying:
- LONG_PENALTY (:431)
- race priority, which goes from 0 to 7 for a marathon (:324-332)
- the heavy/extreme-only gate (:633, :800)
- the 25%/30% caps (:639, :804)
- the MIN_LONG_KM floor (:643, :806)
- the replace exclusion (:315, :731, :734)

Instead the run gets the easy-run rules: a 40% cut in the reduce path (:579) or 50% in the replace path (:776), a 4 km floor, and eligibility at 'light' severity.

The one remaining protection is that status 'reduced' marks the run alreadyDowngraded (:1235). That costs -0.50 in the ranking (:438) and moves it to pass 2 (:519, :595). So it is only cut when no fresh candidate takes the adjustment, which in practice means late in the week when the long run is the only unrated run left.

The cascade only happens in flows whose suggester input re-applies the stored mods:
- the plan-view "Adjust week" button and carry-over card (excess-load-card.ts:54-62)
- the manual "Add Activity" form (events.ts:1856-1873, 1735-1752)
- the unplanned GPS run flow (recording-handler.ts:150-163)

It does not happen in the Strava/Garmin activity-review suggestion modals (activity-review.ts:1205, 1839) or in triggerACWRReduction (main-view.ts:2266). Those regenerate the week without mods (getWeekWorkoutsForReview at activity-review.ts:69-81, getWeekWorkoutsForACWR at main-view.ts:2166-2191), so they still see the original t='long' run.

For the fast-finish case, the long-run protections never applied in the first place, because the run is 'progressive' from generation. What changes after the downgrade is that the run goes from downgrade-only to cuttable in km.

**Scenario:** Probe. With only the 13 km long run left, a 60-min ride rates heavy and reduces the long run from 13 to 10 km; it is now t=easy. A following 30-min easy spin (light) then cuts it from 10 to 7 km. The same spin against an untouched long run proposes nothing. Fast-finish case: the downgrade reports lr=28, but the applied change drops the weighted load from 165.5 to 81. A 30-min spin then cuts the 12 km long run to 9 km, below LONG_MIN_KM 10.

**Reachable in practice:** Yes, but through specific flows:

1. **Plan-view "Adjust week" button or carry-over card** (plan-view.ts:2550, 2642 → triggerExcessLoadAdjustment). This is the main route. Its getWeekWorkouts re-applies mods, so a long run shortened earlier in the week by the Strava activity-review modal appears as a reduced easy run. The late-week Adjust week then cuts it at light severity.
2. **Unplanned GPS run recording** (recording-handler.ts:146 runLoadLogic).
3. **Legacy main-view "Add Activity" manual form** (events.ts logActivity). This is only reachable in the post-onboarding main view.

Not affected: the Strava/Garmin sync review modals (activity-review.ts:1222, 1845) and the ACWR "Reduce this week" flow (main-view.ts:2312). They rebuild the week without mods. The Tier-1 auto-reduce (activity-review.ts:1775-1810) also uses mod-free workouts.

Conditions for the cascade:
- No fresh unrated candidate absorbs the adjustment. This is typical late in the week, since the long run is on day 6.
- The km floor is inactive (ACWR caution, high or 'unknown'), or the remaining planned km sit above the floor. When the floor is active with slack 0, the ex-long run is downgraded to recovery pace instead of being cut in km.

**Impact:** - **Steady long run:**
  - First cut: 12 km to 10 km.
  - A second, light session (30-min easy spin) then cuts it to 7–7.6 km, a total cut of 37–42% of the week's long run. The long-run rules would have stopped this: capped at 25–30%, floored at 10 km, and not touched at light severity.
  - The synthetic 'Week overload' adjustment from the excess card cuts it to 6 km, a total cut of 50%, where the untouched long run would get no change.
- **Fast-finish long run (every third week):**
  - The popup says "run at marathon pace instead", but the plan shows a plain easy run at RPE 3.
  - The budget is charged 30.5 load units while about 76–118 units are actually removed, so the suggestion removes 2.5–4 times its load budget.
  - A later light session can then cut it by up to 40% (13 km to 10 km in the probe; a 12 km one would go to about 9 km).

### A9. Silent auto-reduce (Tier 1) and the excess card (Tier 2) judge the same excess against different targets

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/ui/activity-review.ts:1774-1812; compare src/ui/excess-load-card.ts:109-115 and src/ui/plan-view.ts:1860-1868

**What the code does (verifier wording):** Tier 1 auto-reduce (activity-review.ts:1776-1779) measures the week's Signal B plus carry against s.signalBBaseline. It decays the carry against that same baseline. s.signalBBaseline is the flat median of historic raw weekly TSS: no phase multiplier and no split of the cross-training budget. Every other excess or target surface uses computePlannedSignalB: the plan load bar, the Adjust-week strip in plan-view, triggerExcessLoadAdjustment and the week-advance settlement. So one excess decision runs on two thresholds, and both can reduce the plan in the same week.

One correction to the report: the amber "excess card" (renderExcessLoadCard, excess-load-card.ts:124) is dead code. Nothing calls it. The live Tier 2 surface is the plan-view Adjust-week strip (plan-view.ts:1856-1890, rendered at 2246). It shows "N TSS excess" and an "Adjust plan" link that calls triggerExcessLoadAdjustment (plan-view.ts:2641-2642), which uses computeTotalWeekExcess (excess-load-card.ts:108-116). The dead card had a guard that hid it once a Tier 1 "Auto:" mod existed (excess-load-card.ts:128). The live strip has no such guard, so Tier 1 and Tier 2 can both act on the same week.

**Scenario:** Historic Signal A median 300 made of 267 running + 33 (one 60-raw ride x 0.55), so signalBBaseline = 327. Build-phase plannedB = 267 x 1.08 + 60 = 348. At a week total of 335, Tier 1 sees 8 TSS excess and silently cuts about 1.4 km from an easy run, while the plan bar shows the week 13 TSS under target. In taper, plannedB = 0.85 x 267 + 60 = 287. At 320, Tier 1 sees no excess, but the excess card reports 33 TSS and offers a reduction.

**Reachable in practice:** Yes, for Strava-connected users. s.signalBBaseline is only set by fetchStravaHistory: the onboarding step wizard/steps/strava-history.ts:52 and the startup backfill at main.ts:489. For Garmin-only users it stays undefined, and the `_signalBBaseline > 0` guard at activity-review.ts:1777 disables Tier 1.

The path:
1. Strava sync puts a current-week cross-training activity into wk.garminPending (activity-matcher.ts:715-741).
2. processPendingCrossTraining (activitySync.ts:113) sends it to autoProcessActivities when it is 1-2 non-run items under 24 h old. isBatchSync is at activitySync.ts:95-104.
3. The item does not fit a generic cross slot, so it overflows.
4. Tier 1 runs (forceModal=false) as long as an unrated easy run of 2 km or more exists.

This is the normal "did a ride today, opened the app" flow. The Adjust-week strip is evaluated on every Plan render of the current week. Its "Adjust plan" link opens the reduction modal via triggerExcessLoadAdjustment.

**Impact:** For the reported athlete (recreational, 267 running + 60 cycling raw), the gap between the two thresholds is 327 − plannedB:
- base: +8 TSS
- build: −21 TSS
- peak: −27 TSS
- deload: +80 TSS
- taper (first week): +40 TSS

Effects:
- Build or peak: a week total 1-21 TSS above 327 makes Tier 1 cut up to about 2.7 km (15/5.52) from an easy run, while the plan bar shows the week under target.
- Taper or deload: Tier 1 never fires, even though plannedB is already exceeded. At 320 in taper the strip reports 33 TSS excess and offers a reduction.
- Base: both can fire in the same week (8 TSS → 1.4 km auto-cut, then the strip shows 16 TSS excess).
- The carry fed to each system differs as well: 14 vs 5 vs 33 TSS in the probe.

The cut size is capped at 15 TSS, about 2.7 km per event. The wrong direction (a cut while under target, or no cut while over) scales with the phase multiplier.

### A10. Decayed carry judges past weeks against the current week's phase target and today's date, creating phantom excess in a taper done exactly to plan

- **Finder severity:** medium
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/calculations/fitness-model.ts:659-690 (:670 nowMs = today; :681 getWeeklyExcess(prevWk, plannedBaseline) uses the caller's current-week target for every lookback week; :684-686); callers src/ui/excess-load-card.ts:109-115, :139; src/ui/plan-view.ts:1860-1866, :2055 (current week only); src/ui/main-view.ts:2274-2281; src/ui/load-taper-view.ts:318-329 (:329 adds carry for any viewWeek); src/ui/home-view.ts:605-611

**What the code does (verifier wording):** computeDecayedCarry (fitness-model.ts:662-690) recomputes each of the previous 3 weeks' excess as getWeeklyExcess(prevWk, plannedBaseline) (:681). plannedBaseline is whatever target the caller passes, and every phase-sensitive caller passes the viewed week's phase-multiplied computePlannedSignalB. When the phase target drops (peak 1.10 or build 1.08 to taper 0.85), earlier weeks that exactly met their own targets produce phantom carry. That carry reaches the live Plan-tab surfaces: the current-week "This Week" TSS bar, the ">15 TSS excess" strip with its "Adjust plan" button, the reduction size in triggerExcessLoadAdjustment, and the overshoot calculation in the main-view ACWR reduction. Separately, load-taper-view passes any viewWeek. For a future week this counts the in-progress current week at decay 1.0, against the future week's target. The report is wrong about one thing: the "Excess Activity Load" card (excess-load-card.ts:124-165, the 15-40 band at :139) is dead code and never renders. Also, in a taper done strictly to plan, the strip usually only trips after the last session, so it shows as a label with no reduce-sessions button.

**Scenario:** Probe (recreational tier, history median 400): build target 432, taper 340. Weeks 1-3 hit 432 and week 4 (taper) hits exactly 340 by Sunday. computeDecayedCarry gives 33, which falls in the 15-40 band at excess-load-card.ts:139, so the 'Excess Activity Load' card appears and offers to reduce sessions in a taper executed perfectly; plan-view's _hasPendingExcess (>15) also turns on. Probe (baseline 300): a peak week that hit its own 330 target exactly gives a carry of 55 TSS the next Monday under the 255 taper target, and 23 by Sunday. Viewed on the Tuesday of a week at 400/330, next week's Load & Taper ring shows 70 TSS 'actual' before it starts, while the Plan bar shows 0.

**Reachable in practice:** - **Race plans:** every one hits peak then taper, so the first taper week always carries phantom carry.
- **Continuous-mode users:** hit it every 4th week, the deload labelled 'taper', after base, build and peak weeks.
- **Visible symptoms:**
  - The Plan tab, current week: the "This Week" TSS row (buildProgressBars) shows e.g. "78 / 340 TSS" on Monday morning before any training.
  - Once the week's own raw load reaches the target, the strip shows "33 TSS excess (33 from last week)". It is only a label unless workouts remain.
  - The "Adjust plan" reduce/replace modal appears only when raw + carry > target + 15 while sessions remain. For a strictly to-plan taper that means about 90% of the weekly target done by Thursday, which is unlikely. So "offers to reduce sessions in a perfectly executed taper" mostly does not happen as stated.
  - If any extra activity is logged in the taper week, the phantom carry makes the strip and button appear sooner. It also inflates the excess passed to buildCrossTrainingPopup (excess-load-card.ts:370) and the main-view overshoot (2296), so recommended cuts are larger.
- **Future-week mismatch:** Plan tab, navigate to a future week, tap its Week Load bar. The Load & Taper ring shows carry-derived "actual" TSS, while the Plan bar shows only "N planned".
- **Not reachable:** the "Excess Activity Load" amber card the report cites is dead code.

**Impact:** - **Recreational athlete, median 400, following plan exactly:**
  - In the first taper week, or every continuous-mode deload week, the Plan-tab TSS row starts at about 78-84 of 340 on Monday (23-25% of the target) with zero training done.
  - It ends about 33-36 TSS "over" on Sunday, and the ">15 TSS excess" strip is shown.
  - With baseline 300: about 42 on Monday and 18 on Sunday (strip still shown).
- **Extra activity in the taper week:** any real excess gets an extra 33-84 TSS of phantom excess added to the reduction budget, depending on the day.
- **Future-week Load & Taper view:** the ring shows (current week raw − next week target) plus older carry, e.g. 145 TSS "actual" for a week that has not started. The Plan bar for that week shows 0 actual.
- **Reverse effect:** after a phase-target rise (base 388 to build 432), genuine base-week overshoot of up to 44 TSS is hidden from carry. This is under-reporting, not a false alarm.
- **Unaffected:** the Tier 1 auto-reduce in activity-review uses the phase-independent signalBBaseline.

### A11. Planned Signal B target never steps down through the taper and ignores deload weeks

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/calculations/fitness-model.ts:764-779 (PHASE_MULTIPLIERS.deload :764-770, taperMultiplier :775-779), :822-831, :883-885; src/types/training.ts:50 (TrainingPhase has no 'deload'); src/workouts/plan_engine.ts:88-97, :309-311 (deload weeks keep ph='build' but sessions are scaled 0.80-0.90); src/workouts/generator.ts:264-268; src/state/initialization.ts:143-146 (continuous mode uses 'taper' as the deload week); callers passing undefined for weekInPhase/totalPhaseWeeks: src/ui/main-view.ts:2274-2277, src/ui/events.ts:1079-1086 (:1084 week-end settle clears unspentLoadItems when under planned), src/ui/plan-view.ts:524-527, :1860-1863, :2044-2053, src/ui/excess-load-card.ts:109-112, :361-364, src/ui/load-taper-view.ts:318-327, src/ui/home-view.ts:605-609, src/ui/week-debrief.ts:119-121, src/state/persistence.ts:361-392; src/calculations/daily-coach.ts:264-270 also omits them; only src/ui/stats-view.ts:972-977, :984-997 passes them (1-indexed)

**What the code does (verifier wording):** The core defect holds. Nothing ever sets Week.ph to 'deload'. TrainingPhase is 'base'|'build'|'peak'|'taper' (src/types/training.ts:50). The only writes to ph are initialization.ts:145/159/177, persistence.ts:87, welcome-back.ts:123/307 and holiday-modal.ts:973, and none of them writes 'deload'. So the PHASE_MULTIPLIERS deload row (0.65–0.70, fitness-model.ts:764-770) is dead code.

Plan-engine deload weeks (isDeloadWeek, plan_engine.ts:89-97) keep whatever phase they fall in, and computePlannedWeekTSS gives them that phase's multiplier. The report says they fall only in build or peak, but they can land in base too. Example: a 16-week intermediate plan deloads weeks 4 (base, 0.97), 8 and 12 (build, 1.08) and 16 (taper). Continuous mode and the pre-race blocks of plans over 16 weeks use ph='taper' as the deload week (initialization.ts:144-146, :157-160). Those weeks get taperMultiplier(0,3) = 0.85.

Every caller except the Stats forecast passes weekInPhase and totalPhaseWeeks as undefined. The default then gives 0.85 for every taper week, race week included, whatever the real taper length. Stats passes 1-indexed values (stats-view.ts:975, :986-996), so the same week shows two planned numbers. For a 2-week taper, Stats shows 0.70 then 0.55 while Plan, Home, the load-taper view, the debrief, the excess card, Adjust week, the week-end settle and persistence all use 0.85.

Corrections to the stated impact:
- **Taper length.** On the onboarding path a race taper is only 1 or 2 weeks (initialization.ts:124-126 for plans of 16 weeks or less, :164 for longer plans). The "week 3 of 3" and "31% too high" figures need a 3-week taper, which only the legacy setup form can produce (events.ts:325). Realistic race-week inflation is 0.85/0.70 = +21% if weekInTaper is 0-indexed as the docstring says, or 0.85/0.55 = +55% under Stats' 1-indexed convention.
- **Deload depth.** "Deload should target 280" is not supported by the code. The plan engine's deload scales sessions by only 0.80–0.90 (plan_engine.ts:99-107), so the unused 0.65–0.70 row disagrees with the prescribed deload. A runner who follows a deload runs about 10–20% less than in a normal week, not the stated 20–35%.
- **Taper sessions.** Taper sessions are scaled 0.50–0.70 (plan_engine.ts:153, 172, 193, 206) and never step down within the taper. The 0.85 target is inflated relative to the prescribed sessions in every taper week, not only in race week.

**Scenario:** Probe, history median 400: a deload week targets 432 instead of 280; every taper week targets 340, while week 3 of 3 would be 260. Probe, baseline 300: base 291, build 324, peak 330, taper 255 every taper week; Stats for a 2-week taper shows 210 then 165. Median 310: race week target is 31% too high, and a deload week targets 335 instead of 217. Effects: a runner who ignores the deload gets no excess signal; a runner who follows it sees about -20 to -35% vs plan on the load bars and in the debrief tssPct; in taper and race week, cross-training is absorbed up to 85% of a normal week with no reduction offered, the excess card, Adjust week, week-end settle and persistence carry-over all use the inflated target, and about 60 TSS of race-week cross-training counts as under plan.

**Reachable in practice:** Yes, in normal use.
- **Race plans:** every plan has 1 or 2 taper weeks. Plan-view's week load bar (plan-view.ts:2044, shown for every week including future ones), the Home "TSS / plan" bar (home-view.ts:652), the load-taper view's Target (load-taper-view.ts:430) and the week-debrief "% vs plan" (week-debrief.ts:122, :287) all show the 0.85 target. Stats' forecast shows 0.70/0.55 for the same weeks.
- **Excess and carry-over:** excess detection (plan-view.ts:529, excess-load-card.ts:115), the Adjust-week reduction budget (main-view.ts:2279, excess-load-card.ts:365) and the week-end settle (events.ts:1084-1088, on every week advance) use the same inflated taper target. So does persistence carry-over on app load (persistence.ts:366-383).
- **Plan-engine deloads:** these fire on a fixed cycle (every 3, 4, 5 or 6 weeks by ability) in every plan, so every user hits a deload week that is targeted at base/build/peak level.
- **Continuous mode and long plans:** users in continuous mode, and anyone with a race plan over 16 weeks, hit ph='taper' deload weeks at 0.85 every 4th week.
- **Not reachable:** a 3-week taper does not occur on the onboarding path.

**Impact:** All figures below are for the recreational tier with no cross-training baselines.

**2-week taper, running median 400:**
- Both taper weeks target 340. Stats' forecast shows 280 then 220 for the same weeks.
- Under the docstring's 0-indexed intent the targets would be 340 then 280. Race week is 60 TSS too high (+21%), or 120 TSS (+55%) against Stats' convention.
- Cross-training up to that gap counts as under plan and triggers no excess card or reduction. The week-end settle clears unspentLoadItems whenever the actual is at or under 340.

**1-week taper (plans of 8 weeks or less):** the target is 340 against 280 in Stats.

**Deload weeks, running median 400:**
- A plan-engine deload in build still targets 432. A base-phase deload targets 388.
- Following the deload cuts running about 10–20% (dMult 0.80–0.90), so the bars and debrief show roughly 10–20% under plan. The report's -20 to -35% is overstated.
- The dead 'deload' row would give 280. That is itself about 20 points deeper than the engine's own deload, so "correct = 280" is not supported by the code.

**Continuous mode and pre-race blocks:** deload weeks target 0.85 × baseline (340 at 400). Stats shows 0.70 (280) for those weeks.

**Caveat on race week:** the race itself is not a generated workout. If the race activity syncs into the final week, it dominates that week's actual TSS whatever the target.

### A12. Combined-activity RPE depends on how many items there are, not how hard they were, because it thresholds a summed field that mixes Training Effect defaults and load units

- **Finder severity:** low
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/ui/excess-load-card.ts:288-289, :300-318; src/ui/main-view.ts:2212, :2233, :2241-2261; src/ui/activity-review.ts:718-719 (aerobicEffect ?? 1.5); supabase/functions/sync-strava-activities/index.ts:858, :905, :1220, :1245 (Strava TE always null); src/calculations/activity-matcher.ts:811-823; src/cross-training/suggester.ts:292

**What the code does (verifier wording):** In the two on-demand adjustment paths, triggerExcessLoadAdjustment (excess-load-card.ts:288-289) and triggerACWRReduction (main-view.ts:2212, 2233), the popup activity's RPE comes from the SUM of UnspentLoadItem.aerobic, not from any per-activity intensity. The two paths use different thresholds. excess-load-card maps a sum above 3.5 to RPE 7, above 2.5 to RPE 5, otherwise RPE 4. main-view maps a sum above 3.5 to RPE 7, otherwise RPE 5 (it has no RPE 4 band). For Strava overflow items, aerobic is always the 1.5 default, because the edge function writes aerobic_effect null on every path and populateUnspentLoadItems falls back to 1.5. So the RPE depends only on how many items there are: in the excess card, 1, 2 and 3 or more items give RPE 4, 5 and 7; in the ACWR path, 1 or 2 items give RPE 5 and 3 or more give RPE 7. The RPE sets the Tier C load, and through `hasHR = tier !== 'rpe'` it also decides the no-HR 'extreme' rule. Both apply only when no item's iTRIMP is found. Surplus items (garminId + '_surplus') can never be found by the iTRIMP lookup. Their aerobic field holds calculateWorkoutLoad units. Review-path surpluses (minutes) are almost always above 3.5. Auto-matched surpluses (km passed as minutes) are often only 2 to 4, so "almost always RPE 7" overstates that case. The immediate overflow modal (activity-review.ts buildCombinedActivity, :1931-1936) uses a duration-weighted deriveItemRPE and does NOT have this defect.

**Scenario:** Not probed; arithmetic from the code. Three 45-min no-HR Strava walks in the excess list: summed aerobic 4.5 gives RPE 7. The Tier C base load is 135 x 3.5 x 0.35 x 0.95 x 0.8 = 126, against 39.5 at RPE 3. Duration 135 min at RPE 7 or higher triggers severity 'extreme' through suggester.ts:292, so up to 3 adjustments are offered for three easy walks.

**Reachable in practice:** This is reachable in normal use for Strava users. Here is the path I traced:
1. A cross-training or walking activity syncs in the current week. activity-matcher.ts:715-739 queues it as a pending item.
2. processPendingCrossTraining (activitySync.ts:156-168) sends it to autoProcessActivities.
3. With no named or generic cross slot, it becomes overflow (activity-review.ts ~1735). populateUnspentLoadItems then stores aerobic=1.5.
4. If ACWR is not caution or high, no modal fires (activity-review.ts:1820-1830) and the items stay on the week. They pile up over several days.
5. The user taps "Adjust week" or the carry-over card (plan-view.ts:2550, 2642; excess-load-card.ts:181), or the ACWR reduce button (main-view.ts:2545, home-view.ts:2068).
The bug only affects load when none of the listed items resolves to iTRIMP, for example phone-recorded walks without HR, or a list made only of surplus-run items. If any item has iTRIMP, the Tier A+ path is used and the RPE no longer matters. Garmin users get real TE values instead of 1.5, but summing TE across items is equally meaningless. Batch sync (3 or more items at once, or items older than 24h) goes through the review screen. There, walks of 45 min or less default to log-only (activity-review.ts:130-132), so the exact three-45-minute-walks scenario is most likely when the walks arrive one per day.

**Impact:** Same total load (135 min of easy no-HR walking), split into 3 items instead of 1:
- Tier C base load roughly doubles: 125.7 at RPE 7 vs 57.5 at RPE 4. Against the claim's RPE 3 baseline of 39.5, it is 3.2x.
- Fatigue cost goes from 46 to 100.5.
- Run replacement credit goes from 33.2 to 68.4.
- The displayed easy-running equivalent goes from 2.8 km to 5.7 km.
- The headline changes from "Sport session logged" to "Very heavy training load".
- The adjustment cap rises from 1 to 3. When the week's excess is at least about 65% of the full-RRC TSS, the user is offered 3 changes (a threshold downgrade, an easy run cut by 3.2 km, a long run cut by 2 km) instead of 1.
In the ACWR path, 3 or more HR-less items likewise jump from RPE 5 to RPE 7. The multi-item summary TSS text ("155 TSS", computed as duration x TL_PER_MIN[5]) ignores the chosen RPE, so the 2-item and 3-item cases show the same TSS but a different severity.

### A13. Re-review and remove leave the Tier-1 'Auto:' easy-run reduction in place

- **Finder severity:** low
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/ui/activity-review.ts:1797-1806, src/ui/activity-review.ts:246-248, src/ui/events.ts:2457-2460, src/ui/excess-load-card.ts:128

**What the code does (verifier wording):** The mechanism is real, but the stated consequences are wrong. The Tier-1 'Auto: <sport>' easy-run mod is never removed by openActivityReReview, by applyReview, by removeGarminActivity or by clearGarminAndResync. Only the per-card "Undo" button on the reduced run removes it. Two parts of the failure scenario do not hold. (1) Moving the ride into a slot does not remove the excess. getWeeklyExcess measures total week raw load against the baseline, so the ride still counts wherever it is placed. (2) The "Tier-2 card suppressed" consequence is dead code: renderExcessLoadCard has no callers, and the live "Adjust week" strip does not check for Auto: mods. The consequence that can actually happen is a double response. If the user re-reviews and leaves the ride unmatched, applyReview always opens the reduce/replace modal, and it builds that modal from the unmodified workouts. Accepting a reduction adds a 'Garmin:' mod while the stale 'Auto:' reduction stays, so the plan responds twice to the same ride.

**Scenario:** A single same-day ride overflows. Tier 1 silently cuts Thursday's easy run from 8 to 6 km. The user opens Review and places the ride in the planned cross slot, so there is no excess any more, but Thursday stays at 6 km. If a later session pushes the week 30 TSS over, the Tier-2 excess card never appears because the stale 'Auto:' mod suppresses it.

**Reachable in practice:** Tier 1 runs in normal Strava use. stravaSync.ts:182 calls processPendingCrossTraining, and for 1-2 non-run items under 24h old (activitySync.ts:95-104, 159-168) that calls autoProcessActivities. signalBBaseline is set from history (stravaSync.ts:272). The window is narrow: week raw TSS must be 0-15 over baseline.

Re-review is always reachable for the current week: Plan tab → Activity Log "Review" (plan-view.ts:544, 2700-2709), which calls openActivityReReview once nothing is pending. Home's unmatched rows also open it (home-view.ts:2115-2119).

The remove path in the claim is effectively unreachable for the overflow ride. In plan-view the × button only renders on garminActuals (slot-matched) rows (plan-view.ts:283, 608), not on adhoc "Excess" rows (plan-view.ts:617-653). The adhoc × buttons live only in the legacy renderer.ts #wo list inside main-view, which is reached after the onboarding wizard.

The Tier-2 card suppression cannot happen because renderExcessLoadCard is never called. The flow that does cause harm: Tier 1 → Review → leave the ride unmatched → the reduce/replace modal appears unconditionally → Accept. That applies a second reduction for the same ride.

**Impact:** The Tier-1 cut is at most round(15 / (TL_PER_MIN[4]=0.92 × 6 = 5.52 TSS/km), 1) = 2.7 km, and never below 1 km remaining. So a stale Auto: mod over-reduces one easy run by 0.5 to 2.7 km. The claimed "8 → 6 km" cut would need about 11 TSS of excess.

Whether keeping that cut after re-review is wrong depends on the user's choice. If they choose Log-only, re-slot, or leave the ride as is, the model's excess is unchanged (probe: 10 → 10, or 10 → 19 when slotting drops iTrimp), so keeping the cut is consistent with how the model defines excess. The real over-response is the double-reduction case. There the modal adds a second reduction (typically several km on another run) for load that Tier 1 already absorbed. The user can remove the Auto: part with the "Undo" link on the card.

The claimed "Tier-2 excess card never appears" has no user-facing effect. That card is dead code, and the live "X TSS excess · Adjust plan" strip ignores Auto: mods. One side note: removeGarminActivity leaves the ride's unspentLoadItems entry, so a removed overflow ride keeps adding durationMin × 1.15 TSS to week excess (probe: 19 TSS still counted). That is a separate bug.

### A14. Distance 'reduction' rewrites the warm-up (1 km becomes 3 km) and writes 'X km', which the planned-TSS parser cannot read

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, partially_confirmed
- **Code:** src/cross-training/timing-check.ts:72-79 (regex :74, 3 km floor :77, space in output :78); src/ui/plan-view.ts:196, :2680-2689; src/calculations/fitness-model.ts:594-595, :606, :612, :630-639

**What the code does (verifier wording):** The defect is real, and the probe reproduces the reported numbers exactly. Three details were overstated. (1) applyDistReduction (timing-check.ts:72-79) rewrites the first "<n> km" token it finds. Most generated threshold and VO2 sessions start with "1km warm up": Threshold 3x8, 2x12 and 5x5, and VO2 5x3, 6x2 and 12x1. Threshold Tempo starts with "2km warm up". So a 10/15/25% cut lands on the warm-up and the 3 km floor (:77) raises it to 3 km. The main set is untouched. VO2 5x4 has no warm-up (its main set is 30 min, so wucdKm returns 0), and its first km token is either absent ("~900m", so nothing changes although the button says "-X% distance") or the per-rep annotation ("~1km" becomes "~3 km"). (2) The rewrite emits "X km" with a space. estimateWorkoutDurMin cannot read it. The warm-up regex /^(\d+\.?\d*)km/ is at fitness-model.ts:591-592, not 594-595. The main-set regex /(\d+\.?\d*)km/ is at :603, not :606. The 40-min default is at :615, not :612. So a rewritten warm-up counts as 0 km, and a rewritten plain long run ("13.5 km") falls to 40 min. (3) The accept handler (plan-view.ts:2662-2692, mod pushed at :2679-2688) stores newType and newDistance but no newRpe. The render-time apply at plan-view.ts:1942-1948 only overrides rpe when mod.newRpe != null, so the original RPE is kept (7 for threshold, 8 for VO2, 3 for long). The planned-TSS error does not reach every day target. Only the plan card (plan-view.ts:196, via mods applied at :1932-1950) and the Strain view apply accepted mods: the day target at strain-view.ts:234-246 and :248, and the week bars at :438-450 and :459. The Home strain target (home-view.ts:760-776), Readiness (readiness-view.ts:155-169) and the daily coach (daily-coach.ts:129-143) rebuild raw generated workouts without workoutMods. They keep the original, un-downgraded target, so after an accept they disagree with the plan card.

**Scenario:** Probe: a 107-TSS day before 'Threshold 3×8' produces newDistance '3 km warm up (5:30/km+) / 3×8min … / 1km cool down'. The displayed session is 2 km longer. Planned TSS falls from 69 to 60 because the unparsed '3 km' warm-up counts as 0. Long run 15 km with a 75–99 TSS day before, accepted: newDistance '13.5 km' matches no pattern, so duration is the 40-min default and planned day TSS drops from 55 to 26. The athlete is simultaneously told to run 13.5 km at marathon pace, which is roughly 90 TSS.

**Reachable in practice:** Yes, in normal use. mergeTimingMods runs after every Strava sync (stravaSync.ts:162) and every activity sync (activitySync.ts:52), and from three plan-view handlers (:2482, :2807, :2841). It builds workouts through the plan-engine path of generateWeekWorkouts (wk.w and s.tw passed), which yields the descriptions shown above.

The flow: a synced activity with Signal B of 75 or more the day before an unrated threshold, VO2 or long session. Signal B is iTrimp*100/15000 (timing-check.ts:89), so this means an iTRIMP of at least 11,250, which is a solid 75 to 90 min run or a long ride. The plan card then shows "Suggestion — hard session yesterday". Expanding the card shows the "Apply: easy pace · −15% distance ↓" button (plan-view.ts:228-243). Tapping Apply triggers the bug.

Before accept, the suggestion mod is display-only, because timing mods are not applied at plan-view.ts:1941. So the damage happens only after the user taps Apply.

Caveats that limit reach:
(a) If the session had been drag-moved, the accepted mod stores the moved day. getPlanHTML applies mods before moves (:1932 vs :1954), so the accepted mod may not match on the plan card at all.
(b) The Home, Readiness and daily-coach day targets never see the accepted mod.
(c) On the next sync, mergeTimingMods re-adds a Timing: suggestion for the same session. getPlanHTML then resets modReason (:1940), and the suggestion banner reappears on top of the already-accepted change.

**Impact:** At easy pace 5:30/km:
- Accepting a 75+ TSS timing downgrade on a threshold interval session lengthens the prescribed warm-up from 1 km to 3 km, adding 2 km (about 11 min) of running to a session labelled "shorter". The work set is unchanged.
- At the same time, the planned TSS on the plan card and in the Strain view falls by about 10 (69 → 60, 68 → 58, 71 → 61), and by 14 for Threshold Tempo (64 → 50). The un-parsed warm-up counts as zero and RPE stays 7 even though the session is now labelled "easy". With the intended RPE 4, a correctly parsed session would be roughly 20 to 45 TSS, depending on how the distance is handled.
- For plain long runs (2 of every 3 weeks; the fast-finish variant is typed 'progressive' and is skipped), any distance-cut accept makes the duration fall back to 40 min. The planned day TSS goes from 55 to 26 at every tier. A correct parse would give 48 (−10%), 46 (−15%) or 40 (−25%) at RPE 3.
- At the 75-99 tier the long run is also retyped 'marathon' while RPE stays 3. Correctly parsed at the intended RPE 6 it would be about 108 TSS by this function (easy-pace duration), or about 98 at true marathon pace. That is well above the reported "roughly 90" and far above the 26 displayed.
- The Strain view's "% of target" for that day is therefore computed against a target that is 10 to 29 TSS too low. The Home, Readiness and coach target still shows the original un-downgraded value, so the two surfaces disagree.
- For VO2 5x4, the "−X% distance" label does nothing at 5:30/km easy pace. At easy paces faster than about 4:56/km it turns the per-rep annotation "~1km" into "~3 km".

### A15. Accepted suggestion comes back on the next sync; on a moved session Apply is dropped in Plan/Home but applied in Strain; no dismiss exists

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/cross-training/timing-check.ts:234-253, :254-268, :274-276; src/ui/plan-view.ts:229-241, :807, :954, :1932-1952, :1955-1960, :2482, :2662-2690; src/ui/home-view.ts:1545-1557; src/ui/strain-view.ts:428-449

**What the code does (verifier wording):** Confirmed, with two small corrections. (1) After Apply, the stored mod reads 'Timing accepted: ...' (plan-view.ts:2683). isTimingMod only matches the prefix 'Timing:' (timing-check.ts:32, 274-276), so the accepted mod is counted as a non-timing mod. The next mergeTimingMods call rebuilds the raw plan (timing-check.ts:234-249), which ignores mods. The session is still unrated, so a fresh 'Timing:' mod is generated. oldTiming is now empty, so the change check fails (0 vs 1) and the fresh mod is appended after the accepted one (timing-check.ts:254-268). mergeTimingMods runs on every sync (stravaSync.ts:160-164, activitySync.ts:49-54) and on every move (plan-view.ts:2482, 2807, 2841). In getPlanHTML the fresh mod is applied last and overwrites modReason (plan-view.ts:1936-1941). The card still carries the accepted type and distance, but it shows 'Suggestion — hard session yesterday' and the Apply button again (plan-view.ts:229-241, 954). isReduced is false (plan-view.ts:807), so the header distance falls back to w.km (the original distance) instead of the reduced value (814-817). Each further Apply adds another accepted mod, so duplicates pile up. (2) When the session has been moved, the Apply button's data-day is the moved day, because cards are built after moves are applied (plan-view.ts:240, 1955-1960, 2253). getPlanHTML and home-view apply non-timing mods against the DEFAULT day, before moves (plan-view.ts:1937-1938, home-view.ts:1545-1557). So the accepted mod matches nothing and the Plan and Home cards stay unchanged. strain-view applies moves first (strain-view.ts:428-449, 228-243), so it does apply the accepted mod. There is no dismiss control; the only timing handler is .plan-timing-accept (plan-view.ts:2662). Corrections: the suggestion does not only return 'until the day passes'. There is no date check (timing-check.ts:162-211), so it comes back until the session is rated or the week advances. Also, a dragged session is one real trigger, not demonstrably 'the common' one. Any activity of 50 TSS or more (Signal B) on the day before an unmoved threshold, vo2 or long session triggers it too.

**Scenario:** Probe: accept on Threshold 3×8 (Tue, after an 80-TSS Monday), then the next sync: workoutMods = ['Timing accepted' reduced/marathon, 'Timing:' planned/marathon], and mergeTimingMods returned changed=true. So the suggestion re-renders on every sync until the day passes. Moved case: VO2 moved from Thu to Sat after a Friday ride, then Apply. The Plan card still shows 'vo2', '1km warm up…', with no mod and no suggestion. Strain-view's planned-TSS path uses 'threshold', '3 km warm up…' for Saturday. The Plan card and the day target disagree, and the suggestion reappears at the next sync.

**Reachable in practice:** Yes, in normal use.
- Unmoved path: a Strava user logs a hard activity (Signal B of 50 TSS or more) on the day before a threshold, vo2 or long session. Base and build weeks commonly contain these; enumeration found threshold, vo2 or long in most generated weeks. The user opens the card and taps Apply. At the next app launch, syncStravaActivities runs (main.ts:402). It calls mergeTimingMods whenever the 28-day window has at least one activity, which is effectively always for an active user. The suggestion then comes back. Moving any session also re-runs mergeTimingMods (plan-view.ts:2482/2807/2841), so the suggestion returns even without a sync.
- Moved path: the user moves a quality session with the move buttons or drag and drop onto the day after a hard day. mergeTimingMods runs immediately and shows the suggestion on the moved card. The user taps Apply. The Plan and Home cards do not change, while strain-view's planned-TSS bars do.
- Dismiss: there is no dismiss control. The only way to clear a suggestion is to move the session away, rate or complete it, or wait for the week to roll over.

**Impact:** Probe numbers:
- Unmoved 13 km long run after an 80-TSS ride: accepting sets marathon effort at 11.7 km. After the next sync, the Plan card shows the 'Suggestion' label and the Apply button again. Because isReduced is false, the header falls back to w.km, the original 13 km, while the detail still carries 11.7 km. The 'Adjusted' status and reduced badge are lost. Each extra Apply adds another duplicate 'Timing accepted' mod, and the pile is never cleaned up within the week.
- Moved threshold session: Plan and Home keep threshold effort (2 km warm-up, 13 min at threshold pace, 2 km cool-down). Strain-view computes Saturday's planned Signal B TSS as a marathon-type session with a 3 km warm-up. So the Plan card and the daily target disagree on both intensity and distance, and the suggestion reappears at the next sync or move.
- The suggestion persists until the session is rated or the week ends, not just until its day passes.
- Adjacent bug: Home shows the suggested reduced distance before the user accepts anything.

### A16. 'Yesterday's load' is measured differently from the Strain view: per-day max instead of sum, DST-shifted week start drops the prior-Sunday carry-over, adhoc entries always count 0

- **Finder severity:** medium
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/cross-training/timing-check.ts:83-96, :98-107, :115-134 (max :118, adhoc :128-131), :154-158, :218-222; src/calculations/fitness-model.ts:506-519; src/gps/recording-handler.ts:127-137

**What the code does (verifier wording):** The 'N TSS yesterday' figure in the timing check (src/cross-training/timing-check.ts) is not the Strain view's number for that day, for three confirmed reasons. (1) It takes the single largest session per day (:118), where Strain adds them all up (fitness-model.ts:507-520). (2) No-HR sessions use 0.92/min (:90) against Strain's 1.15/min (fitness-model.ts:518). iTRIMP is divided by a fixed 15000 (:89), where Strain uses the athlete's own normaliser from setAthleteNormalizer (main.ts:146). (3) weekStartISO (:218-222) shifts week starts back to Sunday once a plan crosses a spring-forward DST change. That breaks the carry-over of the previous Sunday's load onto a Monday quality session (:154-158). Part (3) of the claim is overstated. `dur` is indeed never set to a non-zero value on any adhoc, so the adhoc branch (:128-131) and its private RPE table (:83-86) are dead code. But Strava/Garmin adhoc activities never reach that branch because they have no dayOfWeek. They are counted through their mirrored garminActuals entry. The only adhocs that do reach it are planned generator and benchmark sessions, and counting those as 0 is correct. GPS-recorded runs are skipped because they have no dayOfWeek, not because of `dur`. Strain skips them too, so they are a blind spot in both views rather than a difference between them.

**Scenario:** Probe: two sessions on Monday (AM run and PM spin), each iTRIMP 6500 (43 TSS). Strain sums them to 86. The timing check sees 43, so Tuesday's threshold gets no suggestion. DST probe: plan started Monday 2026-03-02, threshold moved to Monday, previous Sunday long run of 120 TSS. With TZ=UTC every week gets a 2-step suggestion. With TZ=Europe/London or Europe/Paris, week 6 (prev Sunday 2026-04-05, after the 29 March change) gets none. With TZ=America/New_York, weeks 3–6 all get none, because the US change on 8 March shifts every week start to a Sunday. A GPS-recorded 2 h run the day before a VO2 session never triggers.

**Reachable in practice:** (1) Common. Any day with two synced activities, for example a run plus a Strava ride or gym session, or a double run. Both get garminActuals entries. mergeTimingMods runs on every Strava sync (stravaSync.ts:162), on activity sync (activitySync.ts:52), and on plan-view moves (plan-view.ts:2482, 2807, 2841). (4) Hits every user with an LTHR, restingHR and maxHR profile (the normaliser differs from 15000), and every no-HR activity. (2) Needs three things: a quality session the user has moved or dragged onto Monday (the default plan never puts one there), a DST time zone, and a plan that began before a spring-forward change. That covers winter-started spring-marathon plans in the UK/EU/US from late March, and southern-hemisphere plans from October. It lasts until the matching fall-back. Every Monday after the change loses the Sunday carry-over, not only week 6. (3) The `dur` bug itself has no practical effect: the only adhocs that reach that branch are planned sessions, which should count as 0. The GPS-run miss is real (in-app GPS recording of an unplanned run, handleImpromptuRun). But Strain has the same miss, so it is not a timing-vs-Strain divergence.

**Impact:** Max vs sum: two 43-TSS sessions show as 43 in the timing check against 87 in Strain, so no suggestion fires where Strain would call it a 75-99 tier day. Two 53-TSS sessions give a 1-step/0% suggestion where the summed 107 would give 2 steps/-15%. No-HR: a 60-min session is 55 in the timing check against 69 in Strain (-20%). Normaliser: with LTHR 160, RHR 60 and max 195 the personal norm is about 11057. iTRIMP 6000 is then 40 TSS in the timing check (no trigger) against 54 in Strain, a 36% under-read. With LTHR 170, RHR 45 and max 185 (norm about 17848) the timing check over-reads by 19%. DST: a Monday quality session after a 120-TSS Sunday long run gets no suggestion at all instead of 2 steps down and -25% distance, for every affected week. Adhoc/`dur`: 0 impact in practice, since only planned sessions reach that branch. A GPS-recorded 2 h run the day before a VO2 session gives 0 in both the timing check and Strain. Two further divergences found while checking, not part of the original claim: the timing check ignores wk.unspentLoadItems, which Strain counts (fitness-model.ts:554-561). QUALITY_TYPES (:29) covers only threshold, vo2 and long. The default generator output for a build or peak week 5 of 16 contained only progressive, marathon_pace and float quality types, so the timing check would suggest nothing in those weeks.


## B. Load totals, fitness, fatigue and ACWR

### B1. No Signal B seed: rolling ACWR fills pre-plan days with 0 from plan day 14, so steady training reads as a load spike and the next week's intensity is cut

- **Finder severity:** high
- **Verifier votes:** confirmed, confirmed, partially_confirmed
- **Code:** src/calculations/fitness-model.ts:940-966 (seedDaily=0; the only guard at :944/:958), :1151-1169 (rolling branch of computeACWR); src/data/stravaSync.ts:268-277 (the only place signalBBaseline is set; left undefined when there is no history); src/main.ts:386-396, :452-480 (Apple-only and Garmin-only paths never call fetchStravaHistory); src/ui/events.ts:1094-1108 (week advance writes scheduledAcwrStatus and 'intensity reduced'); src/workouts/plan_engine.ts:323-324, :347-351; src/calculations/readiness.ts:363-365, :419; src/calculations/daily-coach.ts:455-461; src/ui/activity-review.ts:1826 (Tier-3 modal escalation)
- **Independent check:** Code read by Claude: fill = signalBSeed/7 = 0 with no seed; rolling path active from day 14.

**What the code does (verifier wording):** When s.signalBBaseline is undefined, computeRollingLoadRatio returns null only while daysSincePlanStart < 14. From plan day 14 (the Monday of week 3) it fills every pre-plan day in the 28-day window with 0 and still divides the 28-day sum by 4. With steady load, the ratio is about 28 / (plan days in the window): about 1.7 to 2.0 on day 14, about 1.5 to 1.6 on day 17, about 1.3 on day 21, and 1.0 only by day 27 or 28. Because planStartDate is set, computeACWR's rolling branch returns this value, and the weekly-EMA fallback that enforces "unknown until 3 weeks" is never reached. signalBBaseline is written only by fetchStravaHistory, so Garmin-only, Apple and phone users never have a seed. Neither do Strava users whose history fetch fails or returns no week with positive TSS. The plan intensity cut for week 3 happens only when the week-2 advance (next()) runs on day 14 or later. That is the pending-debrief path on app open on Monday or later. If the user wraps up week 2 on Sunday (day 13) from the Plan view, ACWR is still 'unknown' and nothing is scheduled. The Home ring cap, the coach "Load spike" line and the activity-review modal escalation apply on days 14 to about 17 or 20 either way. The ring cap additionally needs s.w >= 3.

**Scenario:** Probe, steady 60 TSS/day from plan day 0, evaluated on day 14: no seed gives acute 360, chronic 210, ratio 1.71 'high'. Seed 420 gives chronic 405, ratio 0.89 'safe'. Probe, steady 360 TSS/week (4 runs + 2 rides, recreational tier, no seed): day 13 0.00 'unknown', day 14 1.67 'high', day 15 1.54 'caution', day 17 1.60 'high', day 20 1.18 'safe'. The same data with a 360 seed gives 0.86 to 1.02, all 'safe'. The week-2 debrief CTA calls next() on day 14 to 17, which sets nextWk.scheduledAcwrStatus='high' with 'Load spike detected (1.67x baseline), intensity reduced for safety'. planWeekSessions then removes 2 quality sessions and caps the long run for all of week 3. On the same days the Home ring is capped at 34 or below with the label 'Overreaching', the coach says 'Load spike (1.67x). Reduce or skip today.', and activity-review escalates to the Tier-3 reduce/replace modal.

**Reachable in practice:** Yes, by default for every Garmin-only and Apple Watch user: onboarding skips the Strava history step, and the startup sync never calls fetchStravaHistory. It is also reached by Strava users whose history fetch failed, or who had no completed week with positive TSS before onboarding. Seeded Strava users are not affected. Phone-only users mostly get 'unknown', because rated plan workouts without device data are not counted by computeTodaySignalBTSS (fitness-model.ts:492-572), so chronic stays below 1.

The week-3 plan cut needs the week-2 debrief to be completed on day 14 or later. That happens by default for anyone who does not open the Plan tab on Sunday: the pending debrief auto-opens on Monday's app launch and its CTA calls next(). The Home ring cap applies on days 14 to about 17 once s.w >= 3, whichever day the advance happened. The coach "Load spike" line applies on those days even before the advance. The activity-review modal escalation fires whenever an overflow activity is synced in that window.

For a genuine beginner with no training before the plan, the zero fill is arguably accurate. For the typical marathon-plan user who was already running, it is a false spike. It also contradicts the code's own documented "unknown until 3 weeks" rule.

**Impact:** With steady training and no seed, the ACWR reads about 1.7 to 2.0 on plan day 14, where the seeded value is about 0.9 to 1.0. It stays 'high' until about day 16 or 17 and 'caution' until about day 18 (day 21 for the beginner tier at 1.30). It only converges to the seeded value around day 27 or 28.

If the week-2 advance happens on day 14 to 17, week 3 is saved with scheduledAcwrStatus 'high' and the reason text "Load spike detected (1.7 to 2.0x baseline), intensity reduced for safety". planWeekSessions then drops 2 quality sessions (caution drops 1) and freezes long-run progression for that week.

On the same days:
- The Home readiness ring is capped at 34 and labelled 'Overreaching' (or capped at 54 on caution days), when s.w >= 3.
- The daily coach says "Load spike (1.7x). Reduce or skip today."
- A synced overflow activity opens the blocking reduce/replace modal instead of the silent toast.

Advancing week 3 on day 20 or 21 gives about 1.18 to 1.33: 'safe' for recreational and above, 'caution' for beginners on day 21, which removes one quality session in week 4.

### B2. Planned easy and long run TSS uses RPE 3 (0.65/min), so running on the app's own HR target scores 115-140% of plan

- **Finder severity:** high
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/workouts/intent_to_workout.ts:54-55, 76-77, 185-186 (easy/long/default emitted with rpe:3); src/calculations/fitness-model.ts:630-639 (computePlannedDaySignalBTSS = durMin x TL_PER_MIN[rpe]); consumers src/ui/home-view.ts:776-784, 805-808, 838, 894-896; src/ui/strain-view.ts:248, 531, 363; src/calculations/readiness.ts:402-411 (strain floor); src/ui/plan-view.ts:192-212, 366-381 (per-workout Planned vs Actual bar); no-HR actual fallback fitness-model.ts:518 uses TL_PER_MIN[5]; elsewhere easy is RPE 4: src/ui/main-view.ts:2284 (TYPE_RPE easy:4, long:4)
- **Independent check:** Code read by Claude: easy/long emitted with rpe 3; planned day TSS = minutes x TL_PER_MIN[3] = 0.65.

**What the code does (verifier wording):** Every generated easy and long run carries rpe 3. The day-level planned Signal B TSS (computePlannedDaySignalBTSS) therefore prices them at TL_PER_MIN[3] = 0.65/min, which is about 39 TSS/h. The actual they are compared with comes from iTRIMP normalised so that 1 h at LTHR = 100. At the app's own Z2 HR target that works out to about 0.74 to 1.1/min. With no HR, computeTodaySignalBTSS uses TL_PER_MIN[5] = 1.15/min. So executing the plan as prescribed reads as 114% (bottom of Z2), about 140% (Z2 midpoint) or about 170% (top of Z2) of target, and 176 to 181% with no HR. This pushes Home readiness to 'Ease Back' and triggers the 'well exceeded' copy from the Z2 midpoint up. Two corrections to the report:
- The per-workout Planned vs Actual bar in plan-view does NOT show 177% for no-HR runs. Its fallback uses the rated RPE, which deriveRPE sets to the planned 3, so it reads about 100%.
- That bar also uses a fixed /15000 normaliser instead of the personal one.
Every other code path treats easy as RPE 4, which makes the generator's rpe 3 the outlier.

**Scenario:** Probe: LTHR 168, rest 50, max 190. Easy '8km' plans 31 TSS (target 26-36). Running it at the bottom of the app's own Z2 target (134 bpm) gives 36 (116%). At the Z2 midpoint (142 bpm) it gives 44 (142%). Long '14km' plans 56 and gives 64 to 79 (114-141%). At 142% the Home readiness strain floor drops to 34, so the label becomes 'Ease Back'. The coach message reads 'Daily load well exceeded target. Additional training raises injury risk.' The Strain view shows 'Load exceeded ... Avoid additional training today.' The per-workout Actual bar turns red (ratio >1.15). For a run without HR, actual = dur x 1.15 against plan dur x 0.65, which is 177% every time.

**Reachable in practice:** This is reached every day in normal use. Home (home-view.ts:758-776), the Strain view (strain-view.ts:192, 248), the daily coach (daily-coach.ts:127-143) and readiness-view (readiness-view.ts:153-169) all regenerate the current week with generateWeekWorkouts(weekIndex = s.w). They get rpe-3 easy and long runs and compare them against computeTodaySignalBTSS over today's garminActuals, which is where a Strava/Garmin run lands after matchAndAutoComplete.

Any user who runs an easy or long session at the Z2 HR the app displays hits it. The readiness strain floor applies only once weeksOfHistory ≥ 3 (readiness.ts:258); before that readiness returns On Track, but the strain % and the coach and strain-view copy are still affected.

The magnitude depends on the zone method:
- LTHR or Karvonen zones: Z2 midpoint ≈ 140%.
- Max-HR-only zones, when no resting HR is set: Z2 is 60–70% of max, which scores about 85–108%, so the bias mostly disappears.

With stream-based iTRIMP and variable HR, convexity makes actual iTRIMP ≥ the summary estimate, so the probe numbers are a lower bound.

**Impact:** Profile: LTHR 168 / rest 50 / max 190, easy pace 5:30/km.

Easy 8 km (plan 29 TSS, target 25–33):
- At 134 bpm (bottom of Z2) it scores 33 (114%). That still reads 'Target reached' on Home and 'Manage Load', the same as 100%.
- At 142 bpm (Z2 midpoint) it scores 40 (138%). Readiness is capped at 34, so the label becomes 'Ease Back'. The coach says 'Daily load well exceeded target. Additional training raises injury risk.' Home and Strain both show 'Load exceeded', and the plan-view Actual bar is red.
- At 150 bpm (top of Z2) it scores 49 (169%).
- With no HR it scores 51 (176%) on Home and Strain. The plan-view bar reads ~100% because of its RPE fallback.

Long 15 km (plan 55):
- 63 / 77 / 94 TSS (115 / 140 / 171%) at the same three HRs, and 98 (178%) with no HR.

Overall, planned easy and long load is about 30% low. It is priced at about 39 TSS/h against about 55 TSS/h, the table's own RPE 4 easy calibration. So on-plan easy days are routinely flagged as overreaching.

### B3. Signal A counts every Excess Load / overflow activity twice (garminActuals plus unspentLoadItems)

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/calculations/fitness-model.ts:382-395 (unspentLoadItems loop in computeWeekTSS has no seenGarminIds check) vs :466-475 (computeWeekRawTSS dedups), :1265, :1278; src/ui/activity-review.ts:350-353, :580-584, :708-731, :913-919, :1754-1760, :1889-1893; src/calculations/activity-matcher.ts:1136-1163 (garminActuals twin); src/ui/excess-load-card.ts:412; src/calculations/daily-coach.ts:261-273; src/state/persistence.ts:376-392; src/ui/week-debrief.ts:110-115; src/ui/home-view.ts:715
- **Independent check:** Reproduced by Claude and all 3 verifiers (138 vs 100 while overflow unresolved).

**What the code does (verifier wording):** Confirmed, with one small correction to the numbers. Every Excess Load or overflow cross-training activity is stored three times: in unspentLoadItems (garminId X), in adhocWorkouts ('garmin-X') and in garminActuals['garmin-X'] (garminId X). computeWeekTSS (Signal A) counts it once through garminActuals at full normalised iTRIMP. The adhoc copy is correctly skipped by its dedup check. The unspentLoadItems loop has no garminId dedup, so it adds durationMin x 1.15 x runSpec a second time. computeWeekRawTSS (Signal B) does dedup, so Signal A ends up above Signal B for these weeks. The copies stay in state after the ACWR-safe early return, the Tier-1 silent reduce, a dismissed modal, the matching-screen Excess bucket, and the excess card's 'Keep'. Any non-null decision in the autoProcess modal clears them, and so does Reduce/Replace on the excess card. The correction: tennis maps to appType 'other', which becomes sport 'generic_sport' with runSpec 0.40. So a 60-min tennis session at iTRIMP 9000 gives Signal A 88, not 95. The ride figures are exact.

**Scenario:** Probes: a 60-min ride with iTRIMP 12000 in the Excess Load bucket gives computeWeekRawTSS 80 and computeWeekTSS 118 (80 once unspentLoadItems is emptied; the extra 38 = 60 x 1.15 x 0.55). A 60-min tennis session with iTRIMP 9000 gives Signal A 95 and Signal B 60. A 60-min ride with iTRIMP 9000 gives Signal A 98 against Signal B 60. Signal A ends up above Signal B. computeFitnessModel(s.wks, s.w) includes the current week, so CTL on Home, daily-coach readiness, the week-debrief CTL delta and Stats are inflated, as is daily-coach weekTSS/tssPct against plan. On the next launch after a week advance, persistence.ts moves or clears the previous week's unspent items, so that week's Signal A drops back retroactively and CTL history changes after a reload. Weeks where the items were never cleared stay inflated permanently.

**Reachable in practice:** This is the normal Strava flow for any current-week cross-training (ride, tennis, swim, etc.) or unmatched run that finds no plan slot, which is typical for a run-only plan with no cross slots. stravaSync calls matchAndAutoComplete, which queues the activity as __pending__. processPendingCrossTraining then calls autoProcessActivities for a single or same-day item, and the item goes to overflow. In the default case ACWR is not caution/high and signalBBaseline is 0 or the excess is above 15, so the function returns early without a modal and the duplicate stays. A batch or backlog of more than 24h with 2 or more integrate choices goes to the matching screen. Anything left in the Excess Load bucket is duplicated the same way. The duplicate is removed only when the user makes a decision in the auto-process modal (shown only when ACWR is elevated or on 'Adjust week'), picks Reduce/Replace on the excess card, or the week advances (persistence.ts carry and clear, events.ts under-plan clear). After the advance, that week's Signal A drops retroactively. Gym overflow (activity-review.ts:1655-1661) does not go through populateUnspentLoadItems, so strength sessions are not affected.

**Impact:** Signal A is inflated by durationMin x 1.15 x runSpec per excess activity. A 60-min ride adds +38 TSS (118 vs 80). A 60-min tennis or other sport adds +28 (generic_sport, runSpec 0.40). A 90-min ride adds about +57. As a result, weekly Signal A (actualTSS) exceeds Signal B for the week (118 vs 80), which should never happen. CTL for the current week is inflated by (1 - CTL_DECAY) x 38. In the probe from a zero seed, week-1 CTL was 18.1 against about 12.3 without the duplicate. This feeds the week-debrief CTL delta and display, and it feeds daily-coach weekTSS/tssPct against plan (for example 118/plan instead of 80/plan). After a reload following a week advance, persistence.ts moves or clears the previous week's items, so that week's Signal A and CTL history drop back after the fact. Home momentum (home-view.ts:715-718) uses only the previous weeks' metrics, so it is affected only by past weeks whose items were never cleared.

### B4. Weekly EMAs fold the in-progress week in as a full week, and callers disagree on s.w vs s.w-1, so coach readiness contradicts the Home ring on the same screen

- **Finder severity:** high
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/calculations/fitness-model.ts:1261-1283, :1308-1330 (loop i < currentWeek; full-week ATL_DECAY = e^-1 applied to a partial week); src/calculations/daily-coach.ts:199-206 (s.w; ctlNow Signal B compared with Signal A metrics[len-5]); src/ui/stats-view.ts:699-706 (s.w; s.athleteTier without override at :701), :2678; src/ui/home-view.ts:709-715, :863-864 (s.w-1); src/ui/readiness-view.ts:82-112, :213 (s.w-1 plus intra-week daily decay); src/ui/freshness-view.ts:266-305 vs :579-586; src/calculations/readiness.ts:258

**What the code does (verifier wording):** The core defect is real and I reproduced it. computeSameSignalTSB and computeFitnessModel both loop i < min(currentWeek, wks.length) and apply the full-week decays to each wks[i]: CTL_DECAY = e^(-7/42) and ATL_DECAY = e^(-7/7) = 0.368. In normal use wks[s.w-1] is the in-progress calendar week. Any caller that passes s.w therefore treats the load so far this week as a full 7-day week. ATL loses 63% and CTL 15% at the start of every week, which pushes same-signal TSB strongly positive early in the week.

Callers disagree:
- computeDailyCoach passes s.w to both functions.
- The Home ring passes s.w-1 to computeSameSignalTSB and s.w to computeFitnessModel. It has no intra-week decay.
- The Readiness and Freshness pages pass s.w-1 to both, then apply day-by-day decay.

As a result:
- The coach's readiness score, label, stance and primaryMessage come from a different TSB than the Home ring. The Home ring's sentence is coach.primaryMessage, and the Readiness page also uses computeDailyCoach(s).primaryMessage. So the page can show a 68 'On Track' ring above a 'Primed' coach sentence.
- The coach modal, opened from Home's coach button, draws its own ring from coach.readiness.score. It also sends that score, tsb and ctlTrend to coach-narrative.
- weeksOfHistory is s.w on Home and in the coach, but s.w-1 on the Readiness and Freshness pages. In week 3 Home computes a real score while the Readiness page returns the 65 placeholder.
- The Freshness ring animation uses week-end TSB while the label uses live TSB.

Corrections to the report:
1. The stats-view sites (buildReadinessCard_Opening :697-706 and buildFreshnessCard :2677) are dead code and no user sees them. renderStatsView renders buildStatsSummary, which never calls them. buildReadinessDetailPage and buildStatsScroll, their only callers, are never called either.
2. "ctlTrend reads 'up' whenever B > A" is too simple. ctlNow is partial-week Signal-B CTL, compared with Signal-A CTL from full weeks. That biases the trend both ways: 'down' for a steady pure runner through most of the week, and 'up' when Signal-B CTL exceeds Signal-A CTL. For a cross-trainer that happens because cross-training counts at full weight in Signal B but is discounted in Signal A, and because the two use different seeds (signalBBaseline vs ctlBaseline).
3. fitnessFrac does not clamp at +27/day. It is 0.945.

**Scenario:** Probe: 4 weeks at 400 TSS, then Monday of week 5 with no load. computeSameSignalTSB(s.w) gives CTL 339, ATL 147, TSB +191 (+27/day, 'fresh', fitnessFrac clamps to about 1). computeSameSignalTSB(s.w-1) gives TSB 0. Probe on Tuesday of week 6 at a steady 360 TSS/week, TSB/7: Home 0.0, Readiness/Freshness -0.9, coach and Stats +20.5. computeReadiness then gives Home ring 59 'On Track', Readiness page 58, coach 82 'Primed' with stance 'push'. Home draws the 59 ring with coach.primaryMessage from the 82/Primed state beneath it. coach-modal sends tsb +20, readinessScore 82 and a biased ctlTrend to coach-narrative. In week 3 Home computes a real score (weeksOfHistory 3) while the Readiness page returns the default 65 (weeksOfHistory 2). The Freshness label uses live TSB, but its ring animation uses week-end TSB.

**Reachable in practice:** Yes, on every app open in normal use.

Once the week's debrief is complete, s.w is the current calendar week, and wks[s.w-1] holds only the activities synced so far. Opening Home shows the readiness ring (s.w-1, no intra-week decay) with computeDailyCoach's primaryMessage beneath it (s.w). Tapping the coach button opens the coach modal, whose ring and LLM payload also come from s.w. Tapping into Readiness or Freshness shows a third TSB (s.w-1 plus daily decay).

The contradiction is largest on Monday or Tuesday before much load is logged, and it shrinks to about zero by Sunday once the week is complete. In weeks 1 to 3, the weeksOfHistory mismatch makes Home show a computed score while the Readiness page shows the placeholder 65.

If the debrief is incomplete, main.ts:171-174 holds s.w back, so wks[s.w-1] is a finished week. The s.w callers are then accidentally right and the s.w-1 callers drop a full week, so the screens still disagree.

The cited Stats readiness and freshness cards are unreachable dead code. The reachable Stats Fitness detail and CTL chart do show the Monday CTL dip.

**Impact:** Coach TSB is inflated by about 0.847·CTL − 0.368·ATL − 0.785·(week load so far) relative to week-end TSB. At a steady weekly load L before any training this week, that is about +0.48·L. For L = 360 to 400 the displayed TSB is +25 to +27 per day, where Home shows 0.

Probe results with identical recovery and ACWR:
- Home ring 68 'On Track'.
- Readiness page 66.
- Coach 81 to 82 'Primed' with stance 'push'. The coach modal ring shows 81 and the sentence under the Home ring says "Well recovered."
- The fitness sub-score is 78 in the coach vs 38.8 on Home, a gap of 39 points. With 35% weighting that moves the composite by about 13 points, enough to cross the 75 'Primed' boundary.
- ctlTrend reads 'down' for a steady pure runner mid-week, and 'up' when Signal-B CTL exceeds Signal-A CTL (the cross-trainer case). This changes the "Fitness is building" or "Fitness has dipped" copy and the LLM narrative input.
- In week 3, Home computes 69 while the Readiness page shows the placeholder 65.
- The Freshness ring fill and its numeric label can disagree mid-week. In S2, week-end TSB/7 was 0 while live was -2.3.
- The reachable Stats CTL value drops by a factor of 0.847, about 15%, every Monday.

### B5. ctlBaseline is an EMA seeded at 0 over only the fetched rows, so it under-reads steady load and the athlete tier depends on whether the 8- or 16-week fetch ran last

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/data/stravaSync.ts:251-263 (EMA starts at ctl=0), :264-277, :283-298, :307-315 (tier thresholds 140/280/455/630, described as TrainingPeaks CTL x 7), :574-596 (backfill cuts historicWeeklyTSS to 8 but keeps the 16-week ctlBaseline, signalBBaseline, sportBaselineByType and historicWeeklyRawTSS); src/ui/wizard/steps/strava-history.ts:52 (8 weeks); src/main.ts:486-490 (16-week refresh only if fewer than 8 rows); src/ui/account-view.ts:803-816 (Fetch/Refresh history); consumers src/calculations/fitness-model.ts:1258 (CTL seed), :848-887 (crossTrainingBudget)

**What the code does (verifier wording):** I could not refute this. fetchStravaHistory() computes ctlBaseline as a weekly EMA that starts at 0 and runs only over the completed history rows the edge function returns. That is at most 8 rows for the wizard fetch and at most 16 for backfill, and weeks with no activity are left out rather than counted as zero. For a steady weekly Signal A of W, the stored value is W x (1 - e^(-n/6)): 0.736W at n=8 and 0.917 to 0.930W at n=15 to 16. The oldest bucket is also a partial week, which pulls the value a little lower still. The tier cut-offs 140/280/455/630 are steady-state values (TrainingPeaks CTL x 7), so the tier reads low: about one full band at 8 rows and about 8% low at 16 rows. ctlBaseline has one writer (stravaSync.ts:263), and a later fetch simply overwrites it. So the stored tier depends on which fetch ran last: wizard fetch(8), startup backfill(16) when fewer than 8 weeks are cached, or Account Load / "Sync History (last 16 weeks)". The fetch window is "now minus N weeks" and has nothing to do with planStartDate, so a refresh mid-plan feeds plan weeks into both the pre-plan CTL seed and the historicWeeklyTSS median. Four corrections to the report: (1) steady 350/week gives 258, not 257. (2) For a brand-new Strava-only user the wizard fetch(8) usually finds no database rows and writes nothing, so the first stored value is the 16-week one. The 8-week value is written only when garmin_activities already has rows: Garmin-webhook users who connect Strava, users re-onboarding, or users with previously synced Strava data. (3) computePlannedWeekTSS falls back to ctlBaseline only when historicWeeklyTSS has fewer than 3 non-zero entries. (4) The early CTL rise also mixes in a normalizer mismatch (the edge function divides by a fixed 15000, the client uses the athlete's own normalizer), so it is not purely EMA convergence.

**Scenario:** Probe, steady 300 TSS/week for 8 weeks: ctlBaseline 221, tier 'recreational' instead of 'trained' (280 to 455). Steady 350/week (TrainingPeaks CTL 50): 257 with 8 rows, so 'recreational', safeUpper 1.35 instead of 1.40 and build multiplier 1.08 instead of 1.10; with 15 rows the effective thresholds are still about 9% high. Steady 330/week: 8-week fetch 243 'recreational', 16-week fetch 307 'trained'. CTL starts low and climbs, so the week debrief and Stats show early 'fitness gains' that are only EMA convergence. A user with fewer than 8 active weeks in the last 16 triggers backfill(16) on every launch, so all baselines are recomputed from a sliding window that increasingly consists of plan weeks.

**Reachable in practice:** The zero-seed under-read happens on every path that writes ctlBaseline, so every Strava user with history is affected. A fresh Strava-only user normally gets their first value from the startup backfill(16) on the second app launch, because the wizard fetch(8) finds an empty table after the OAuth return. That leaves them at about 0.92 to 0.93W. The 0.736W value from the wizard is written for users whose garmin_activities already has rows: Garmin-webhook users who then connect Strava, users re-onboarding after a reset, or users whose Strava data was synced before. That value stays until one of three things happens. First, launch finds fewer than 8 cached weeks, which triggers backfill(16). Second, the user taps Account "Sync History (last 16 weeks)" or Load. Third, the user set athleteTierOverride with "Change" in the wizard; this pins the tier only for consumers that read the override, while stats-view, rolling-load-view, daily-coach and sleep-view read s.athleteTier directly. The mid-plan double count is reached two ways: the Account Sync History button, and every launch for a user with fewer than 8 active weeks in the last 16. For such a user the sliding window fills more and more with plan weeks, which then sit in both the CTL seed and the historicWeeklyTSS median.

**Impact:** - **Steady 350 TSS/week (TrainingPeaks CTL 50, 'trained' band):**
  - The 8-row fetch stores 258 and classifies the athlete as 'recreational'.
  - The effects are:
    - safeUpper 1.35 instead of 1.40.
    - Phase multipliers base 0.97, build 1.08, peak 1.10 instead of 1.00, 1.10, 1.13; deload 0.70 instead of 0.68.
    - Planned build target 378 instead of 385.
    - The wizard summary shows "Safe load increase: up to 35%" instead of 40%.
  - The debrief shows fitness starting at 36.9 and rising about 1 to 1.5 a week (to 45.1 after 6 weeks) on unchanged load.
- **Steady 330/week:** the tier flips from 'recreational' (243) to 'trained' (307) when a 16-week backfill replaces the 8-week value, and the user is not told.
- **16-row fetch:** the stored value is still 7 to 8% low, so each cut-off effectively sits about 8 to 9% higher. For example, 'trained' needs about 301 to 305/week instead of 280.
- **Partial oldest week:** this lowers the 8-row value by up to about 4% of W, depending on the weekday of the fetch.
- **Fallback path** (fewer than 3 history weeks): computePlannedWeekTSS uses ctlBaseline directly, so the planned build target is 279 instead of 385, about 28% low.
- **Refresh mid-plan:** plan weeks count twice in the CTL seed. The planned weekly target becomes median(the last 8 active plan weeks) x the phase multiplier, a feedback loop on the user's own recent plan load.

### B6. History-mode rows omit zero-activity weeks and start with a partial week, but the client treats the array as consecutive calendar weeks

- **Finder severity:** medium
- **Verifier votes:** confirmed, partially_confirmed, confirmed
- **Code:** supabase/functions/sync-strava-activities/index.ts:446-448 (historyStart = now - N*7 days, not Monday-aligned, so the oldest bucket is partial), :482-492 and :557-574 (a week bucket exists only if it contains an activity); src/data/stravaSync.ts:251-263 (EMA over array positions), :281-298 (sessionsPerWeek = sessions / rows.length at :296, which includes the partial current week and excludes gap weeks); src/ui/stats-view.ts:235-262, :283-310 (positional week labels and backfill); consumers src/calculations/fitness-model.ts:1258, :848-887

**What the code does (verifier wording):** Confirmed, with three refinements. History mode only creates a week bucket when that week has at least one stored activity. Its window starts at now minus N×7 days, not on a Monday, so the oldest bucket is partial. The client treats the returned array as consecutive calendar weeks.
(1) ctlBaseline runs its EMA over array positions (stravaSync.ts:257-263), so middle and trailing weeks with no activity never decay the value, and athleteTier is derived from it. Leading gaps (before the first activity) do no harm because the EMA starts at 0.
(2) sessionsPerWeek divides by rows.length (:296). That is the number of non-empty weeks, plus the current partial week if it has any activity, plus the partial oldest week. The rate is inflated only when entire weeks have no activity of any sport. With no gaps it is slightly deflated instead, because the current week sits in the denominator.
(3) signalBBaseline (:268) and the median in computePlannedWeekTSS (fitness-model.ts:808) already filter out zero weeks on purpose, so gap-dropping does not affect them.
The partial oldest bucket is real but small in effect: its EMA weight is about 4.8% of one week at 8w and about 1.3% at 16w. The Stats charts label positions as consecutive weeks back from today, so every bar older than a dropped week is dated too recently. The same positional assumption also misaligns the plan-week backfill in getChartData, and that backfill can never fill a dropped week. Two extra consumers are affected: detectedWeeklyKm (the last 4 positions) and the wizard's "We found N weeks" and "Avg weekly load".

**Scenario:** A runner who did 5 weeks at 300 then 3 weeks off (injury): the true calendar EMA is 103, but the gap-dropped array gives 170. Six weeks at 300 then 2 off: correct 136 ('beginner'), client 190 ('recreational'). On return, the CTL seed and tier reflect pre-injury fitness. Every Stats bar older than a missing week is labelled one or more weeks too recent.

**Reachable in practice:** Yes, for every Strava-connected user.
- The onboarding step strava-history is in STEP_ORDER (wizard/controller.ts:15) and calls fetchStravaHistory(8) (wizard/steps/strava-history.ts:52).
- On startup, main.ts:486-489 runs backfillStravaHistory(16) → fetchStravaHistory(16) whenever history has not been fetched or historicWeeklyTSS.length < 8. Gap weeks make that array shorter, so users with gaps get the baseline recomputed on every launch.
- The account resync does the same (account-view.ts:806, :813).
- The bug triggers whenever a calendar week inside the window has no stored activity of any sport: injury, illness, holiday, or a watch that did not sync. It is most harmful when the gap is recent (trailing), e.g. a runner onboarding or relaunching after time off.
- The partial oldest bucket occurs on every fetch except when run on a Monday at 00:00 UTC. It is worst on Sunday, when only one day of that week is inside the window.

**Impact:** - ctlBaseline (CTL seed for computeFitnessModel and computeACWR): 170 vs 103 (+65%) for 5 weeks on / 3 weeks off. 190 vs 136 (+40%) for 6 on / 2 off. The daily-equivalent CTL shown is 24 vs 15, and 27 vs 19.
- athleteTier: recreational instead of beginner in both scenarios. The ACWR safeUpper becomes 1.35 instead of 1.30, and the tier-specific PHASE_MULTIPLIERS change.
- ATL seed = ctlBaseline × gym factor, so it is equally inflated.
- sportBaselineByType sessionsPerWeek: 1.7 vs 1.25/wk in the probe, which raises the planned Signal B cross-training budget from about 75 to 102 rawTSS/wk (+27) and so under-detects excess load.
- detectedWeeklyKm ("Your plan starts at X km/week") reflects pre-gap weeks.
- The wizard's "We found N weeks" and "Avg weekly load" silently exclude zero weeks.
- Stats Progress load and km charts: every point older than k dropped weeks is dated k weeks too recent. The <5-TSS plan-week backfill pulls from the wrong plan week after a gap, and a dropped week can never be backfilled.
- The partial oldest bucket shifts ctlBaseline by at most about 0.05 × that week's missing TSS. It is negligible for the EMA, but it shows as a low first bar in the 16w chart.
- Separate note: fetchExtendedHistory (stravaSync.ts:615-622) expects a plain array but the edge fn returns a {rows,_debug} envelope, so the on-demand 16w fetch at stats-view.ts:3099 is a no-op.

### B7. ATL inflation for dismissed reductions and recovery debt never reaches the ACWR that drives the plan

- **Finder severity:** medium
- **Verifier votes:** partially_confirmed, confirmed, partially_confirmed
- **Code:** src/calculations/fitness-model.ts:1152-1170 (rolling path, no multipliers) vs :1172-1194 and :1269-1276 / :1321-1326 (multipliers exist only in the weekly-EMA code); src/ui/main-view.ts:2388-2390, 2546-2549 (acwrOverridden set on Keep/Dismiss); src/main.ts:549-555 (recoveryDebt set)

**What the code does (verifier wording):** The acwrOverridden 1.15x ATL multiplier never reaches the ACWR used by the app in normal use. computeACWR takes the rolling 7d/28d path, which never reads the flag, so Keep or Dismiss leaves ratio and status exactly as they were. The multiplier only changes the same-signal and weekly-EMA TSB/ATL numbers, and readiness/freshness only pick it up after that week is completed. The recoveryDebt part of the report is wrong in a different way. recoveryDebt is never set in production, because checkRecoveryAndPrompt has no callers. So the 1.10x and 1.20x multipliers move nothing at all, TSB included. The claim that the weekly-EMA fallback never applies a multiplier is slightly overstated. It can apply 1.15x in one rare case: no signalBBaseline, fewer than 14 days since planStartDate, and s.w pushed to week 4 or later ahead of the calendar.

**Scenario:** The user taps Dismiss on the ACWR reduce prompt (main-view.ts:2549), or chooses Keep in the suggestion modal. FEATURES.md:689 says 'ACWR stays elevated even after load drops'. In fact the next computeACWR call returns the same ratio and status as before the dismissal, so the escalation does not happen: next-week scheduledAcwrStatus at events.ts:1096, the suggester's acwrStatus, and the Tier-3 modal gating. An orange or red recovery-debt check-in also leaves ACWR unchanged.

**Reachable in practice:** - Keep path, reachable: Home, readiness 'Adjust' button (home-view.ts:2058-2068, readiness <= 59 and ACWR caution/high or unspent items), then triggerACWRReduction, then the suggestion modal, then Keep (suggestion-modal.ts:511/514/531 close('keep')), which sets acwrOverridden (main-view.ts:2390). After that, every computeACWR caller returns the unchanged ratio.
- Dismiss path: acwr-dismiss-btn (main-view.ts:536/2546) sits in the legacy renderMainView. Only the wizard reaches that view (wizard/renderer.ts:163/182, the transition or 'Return to plan'), so it is rarely reachable.
- recoveryDebt: not reachable. checkRecoveryAndPrompt is dead code, so no check-in ever sets the flag.
- Fallback edge case: needs s.signalBBaseline null/0 (no Strava history seed), planStartDate < 14 days ago, and s.w >= 4. That only happens if the user advances weeks ahead of the calendar via the legacy 'Complete Week' button (next(), events.ts:752/1098) or '__editThisWeek' (main-view.ts:2615). Not a normal flow.

**Impact:** - After Keep or Dismiss, ACWR ratio and status are bit-for-bit identical (probe: 1.00 -> 1.00, 'safe' -> 'safe').
- The next-week scheduledAcwrStatus (events.ts:1096-1108), the suggester acwrStatus and maxAdjustments (main-view.ts:2303-2311), and the caution/high modal gating do not escalate because of an override. The FEATURES.md:689 statement 'ACWR stays elevated even after load drops' is false for the live code.
- The 15% ATL debt does move same-signal TSB. With 200 TSS/week steady load over 6 weeks, all weeks overridden, TSB went +18 -> -22 and ATL 200 -> 240. For a single overridden week the effect is about 0.15 x 200 x (1 - ATL_DECAY) of ATL. On Home and Readiness, which use completedWeek = s.w-1, it only appears once that week is completed.
- The recoveryDebt 1.10x and 1.20x multipliers have zero effect anywhere, because the flag is never set.

### B8. A scheduled benchmark check-in counts as completed load before it is run, then again when the real activity syncs

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/calculations/fitness-model.ts:440-455 (only 'holiday-'/'adhoc-' skipped), :524-551 (non-garmin adhoc counted by dayOfWeek), :1046-1069; src/ui/benchmark-overlay.ts:71-94 (id 'benchmark-…', dayOfWeek=today, pushed to adhocWorkouts when chosen)

**What the code does (verifier wording):** I tried to refute this and could not. When a continuous-mode athlete picks a post-deload check-in, the app adds a workout with id 'benchmark-<type>-<ts>' to wks[s.w-1].adhocWorkouts. Its dayOfWeek is set to the day it was chosen. The three Signal B functions skip only the 'holiday-' and 'adhoc-' prefixes, so they count this entry at once as done load: computeWeekRawTSS, computeTodaySignalBTSS (and therefore computeRollingLoadRatio) and getDailyLoadHistory. The load is estimated as the first 'Nmin' in the description (30 min if there is none) times TL_PER_MIN[rpe]. Signal A (computeWeekTSS) ignores it, because it only reads 'garmin-' adhocs. Nothing in the code ever removes, deletes or rates the benchmark entry. When the athlete actually runs it, the Strava activity is matched separately to a planned slot (garminActuals) or becomes a 'garmin-' adhoc or pending item. The benchmark entry has no garminId, so it is never deduplicated and the session is counted twice in Signal B. Weekly ATL, same-signal CTL/ATL, excess, rolling ACWR, today's strain, the daily coach and the Home load breakdown all see the phantom plus the real iTRIMP.

**Scenario:** Probe: choosing 'threshold_check' (d = '1km warm up…\n20min @ …') immediately adds 36 TSS to today's strain, the rolling ACWR acute window and weekly Signal B, with Signal A at 0. 'race_simulation' (d='7km', so the 30-min fallback applies) adds 20. Once the athlete runs it and Strava syncs, that week's Signal B, excess and ACWR include both the phantom estimate and the real iTRIMP.

**Reachable in practice:** This is reachable in a normal flow, but only for continuous-mode users. Those are athletes who answered 'not training for an event' at onboarding (initialization.ts:240-243 sets continuousMode = true). It happens on post-deload weeks 5, 9, 13 and so on (events.ts:2086-2090, benchmark-overlay.ts:181).

The overlay opens by itself every time the Plan view renders (plan-view.ts:2376 → benchmark-overlay.ts:177-189). It can also be opened with "Choose" on the Plan or Home panel (plan-view.ts:2375, main-view.ts:2751). Tapping any option adds the phantom immediately. The panel then says "results will be recorded automatically from your watch", but no code does that.

It is worse than the report says:
1. addBenchmarkToWeek never writes to benchmarkResults, and maybeTriggerBenchmarkOverlay checks only benchmarkResults. The overlay therefore reopens 400 ms after every renderPlanView, including the one that runs straight after a selection. Each further tap pushes another 'benchmark-' entry with a new Date.now() id, so the phantoms stack. The only way to stop it reopening is "Skip". The panel then shows "Check-in skipped", but the phantom stays.
2. plan-view.ts:1923-1929 merges only 'holiday-'/'adhoc-' adhocs into the week card list. The benchmark workout does not show as a card in the Plan view and has no delete button. The athlete cannot see or remove the load that is being counted.

Race-plan users (continuousMode false) never reach this path.

**Impact:** Each selection adds these amounts of Signal B, with zero Signal A:

| Check-in | Signal B added | How it is estimated |
|---|---|---|
| threshold_check | +36 TSS | 20 min × 1.78 |
| speed_check | +27 TSS | 12 min × 2.22 |
| easy_checkin | +20 TSS | 30-min fallback × 0.65 |
| race_simulation | +20 TSS | 30-min fallback × 0.65; a 5k time trial is estimated at easy RPE 3 |

The load lands immediately on the day it was chosen, in:
- today's strain
- the 7-day acute sum of the rolling ACWR (and 1/4 of it in the chronic side)
- weekly Signal B, which feeds excess, ATL and same-signal TSB

Once the session is run and Strava syncs, that week's Signal B holds the phantom plus the real iTRIMP. In the probe this was 76 vs 40 for threshold, about 1.9x for that session. If the athlete runs on a different day from the one they chose it, two days show load.

Because ATL (Signal B) rises while CTL (Signal A) does not, TSB is pushed further negative. The error is permanent: it stays in the 28-day ACWR window for 4 weeks and in CTL/ATL history indefinitely. If the overlay is tapped more than once, the error multiplies, because each tap adds one more phantom.

### B9. In-app GPS runs and manual 'Mark as done' sessions are invisible to Signal A and to the rolling ACWR; GPS runs get a flat 30-min estimate in weekly Signal B

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/calculations/fitness-model.ts:341-342 (Signal A counts only 'garmin-' adhocs), :448-454 + :294-297 (d='21.1km' has no 'min', so 30-min fallback; rpe from w.r=5), :543 (no dayOfWeek, so skipped daily); src/gps/recording-handler.ts:64-75, 131-143, 224-232; src/ui/events.ts:413-450 (rate() writes wk.rated only); src/ui/plan-view.ts:2489-2499, src/ui/renderer.ts:877,1206,1217 (Mark as done)

**What the code does (verifier wording):** Confirmed as stated, with two refinements. (1) In-app GPS runs and 'Mark as done' taps never write garminActuals, iTrimp or a duration. rate() writes only wk.rated, ratedChanges, rpeAdj, paces and predictions. So a GPS run that is name-matched or distance-matched and confirmed, and any 'Mark as done' session, adds 0 to Signal A, weekly Signal B, today's strain, the rolling 7d/28d ACWR, CTL and ATL. (2) An impromptu GPS run the user logs as extra (no match, or they decline the match) is saved as adhoc {id:'gps_<ts>', d:'X.Xkm', r:5, t:'easy'} with no dayOfWeek. In that case Signal A is 0, daily and rolling Signal B are 0, and weekly Signal B (and so weekly ATL/TSB and computeSameSignalTSB) is a flat 30 min x TL_PER_MIN[5] = 34.5, shown as 35. That value ignores both distance and the user's RPE, because the adhoc branch reads w.rpe ?? w.r (r:5 hardcoded) and never the ratedMap. Partial mitigation: the impromptu path does open a cross-training suggestion modal built from the real duration and RPE (recording-handler.ts:152-186), so a one-off plan reduction can be offered. The load signals themselves still do not see the run.

**Scenario:** Probe: an impromptu 21.1 km in-app GPS run rated RPE 6 gives Signal A 0, weekly Signal B 35 (30 min × TL_PER_MIN[5], whatever the distance or RPE), and today's strain and every rolling-ACWR day 0. A GPS run started from a workout card (name-matched) or a 'Mark as done' tap gives 0 in all signals. A user who records long runs in-app therefore shows falsely low acute load (under-read ACWR, so no spike protection) and falsely low CTL.

**Reachable in practice:** Yes, in the default UI for every user who logs runs without Strava. There are three routes:
(a) Record tab -> 'Start Run' (justRun, named 'Quick Run'). This is never name-matched. It goes to handleImpromptuRun, which either distance-matches a planned run within a 0.70 to 1.35 ratio (if the user taps 'Yes, assign', the run counts 0 everywhere) or saves the flat-35 adhoc.
(b) Plan view -> 'Start Workout' on a card. This name-matches through generateWeekWorkouts and counts 0 everywhere. If the name fails to match, for example because of a duplicate-name suffix, it falls through to (a).
(c) Plan view 'Mark as Done' on any run or gym card, current or past week. This counts 0 everywhere.
The only way such a session gets counted is if the same activity later arrives through Strava sync. Then activity-matcher routes it through garminActuals or a garmin- adhoc, because the planned slot is already rated. A user who records only in-app, with no Strava, never gets it counted.

**Impact:** Take a 21.1 km run at about 2 h, RPE 6. The app's own no-HR fallback for garminActuals (durationSec/60 x TL_PER_MIN[rpe], fitness-model.ts:430-432) would give about 120 x 1.45 = 174 TSS.
- Logged as extra (impromptu adhoc): Signal A 0, weekly Signal B 35 (about 20% of 174), today's strain 0, all 7 rolling-ACWR days 0.
- Assigned to the plan (name-matched, distance-matched and confirmed, or 'Mark as done'): 0 of 174 in every signal.
For a user who records most runs in-app, acute load in computeACWR reads near 0. The ratio drops below 0.8 and status is 'low' (the probe shows status 'low', atl 0). ACWR-driven reductions and the caution/high flags never trigger, and CTL (Signal A) decays toward 0 even though they are training. Weekly ATL/TSB undercounts by about 80% for each impromptu long run and by 100% for each assigned run. The one-off cross-training suggestion modal on the impromptu path is the only moment the real duration and RPE are used.

### B10. Home strain actual includes passive active-minute TSS, but the plan-derived target does not, and the Readiness page leaves it out

- **Finder severity:** medium
- **Verifier votes:** confirmed, partially_confirmed, partially_confirmed
- **Code:** src/ui/home-view.ts:758 (computeTodaySignalBTSS(..., todayPhysio)), :797, :805-808, :838, :847; src/calculations/fitness-model.ts:563-570 (adds passiveActiveMin x 0.45); src/ui/readiness-view.ts:150-153 (no physio; comment says it must match home); src/calculations/daily-coach.ts:127 (no physio); targets from computePlannedDaySignalBTSS / computeDayTargetTSS contain no passive component (fitness-model.ts:107-139, 630-639)

**What the code does (verifier wording):** Home passes today's physiology entry into computeTodaySignalBTSS, so its "actual" includes max(0, activeMinutes - loggedWorkoutMinutes) x 0.45 TSS. It compares that total against targets built only from planned run sessions: plannedDayTSS on training days, perSessionAvg x 0.30 as the rest-day target, and perSessionAvg x 0.33 as the overreach threshold. The Readiness page (readiness-view) and daily-coach.deriveStrainContext (used by the Coach modal and by the Readiness page's message) call computeTodaySignalBTSS without physio, so they compute 0 passive load. The mismatch drives the strain floor, the rest-day overreach flag, the ring label and the coach sentence. It happens before any training, from walking or commuting alone. A 2026-04-15 CHANGELOG entry says a shared helper, computeTodayStrainTSS, fixed this. That helper does not exist in src: commit 03a3072 added only the doc text. One nuance: Home and the Readiness page already compute different TSB, ctlNow and weeksOfHistory (Home has no intra-week decay; Readiness applies live decay). So passive load is an extra cause of the score gap, not the only one. It is the dominant cause whenever the strain floor binds.

**Scenario:** Probe with the generated build week (per-session average 53, so the rest-day threshold is 17.5 TSS). On a rest day, 40 active minutes of walking with no workout gives Home 18 TSS, so isRestDayOverreaching=true, 'High for rest day', and 'High load on a rest day. Recovery for upcoming sessions is impaired.' Readiness-view computes 0. On an easy-run day before running, 90 active minutes gives 41 TSS against a 31 plan (132%). Home's readiness strain floor drops to 34 ('Ease Back') before any training. The Readiness page shows no strain floor.

**Reachable in practice:** **Apple Watch users: yes, from committed code.** syncAppleHealthPhysiology(28) runs on launch (main.ts:390/408). It sets entry.activeMinutes = Apple Exercise-ring minutes for today (appleHealthSync.ts:277-279). Home reads that entry on every render. Brisk walking counts toward Exercise minutes.

**Garmin users: depends on the deployed edge function.**
- syncTodaySteps (main.ts:421/461/613) reads daily_metrics.active_minutes (sync-today-steps/index.ts:52-65).
- In this repo, garmin-webhook handleDailies (index.ts:178-213) never writes active_minutes. Only steps comes from d.totalSteps, and no other supabase file writes it.
- OPEN_ISSUES ISSUE-136 and CHANGELOG say a deployed version writes moderate + vigorous intensity minutes ("confirmed on-device"). That code is also doc-only in git (commit 7f8f030 touched only docs).
- So the Garmin passive path is live only if production is ahead of the repo.

**Users who see the mismatch:**
- Every user with a physiology source sees Home's ring, label, readiness score and coach sentence include passive load.
- Tapping the readiness ring (home-view.ts:2027) opens the Readiness page, which excludes it.
- The Coach modal also excludes it.
- The fitness-model.ts:30 comment calls 30-60 active min typical for an office worker and 90-120 for a commuter. So the rest-day flag and the pre-run strain floor are ordinary-day events, not edge cases.

**Impact:** **Rest day** (plan with perSessionAvg about 48-64, so an overreach threshold of 16-21 TSS):
- 36-47 active minutes with no workout push Home past the threshold: the ring shows the warn colour and 'High for rest day'.
- The primary message becomes 'High load on a rest day. Recovery for upcoming sessions is impaired.'
- The Readiness page shows 0 TSS, hides the strain card, and gives a different coach sentence.

**Easy-run day before running** (planned about 29 TSS):
- About 65 active minutes gives 29 TSS, which is 100%. The readiness floor drops to 54 (Manage Load), and Home says 'Daily load target reached. Training is complete for today.' before the run has happened.
- About 85-90 active minutes gives 38-41 TSS, which is 130% or more. The floor drops to 34 (Ease Back), and Home says 'Daily load well exceeded target.'
- The Readiness page shows no strain floor. In the probe baseline that means 61, On Track, against Home's 34, Ease Back.

**Knock-on effects:**
- Home's Ease Back label also scales the strain target by 0.80 (computeDayTargetTSS :125), which compounds the "over target" reading.
- After a workout, passive minutes on top of a completed plan push strainPct above 100%. So hitting the planned session exactly while also walking reads as 'Above target' or 'Manage Load'.
- The score gap between Home and the Readiness page also has a separate cause: different TSB/ctlNow (no intra-week decay on Home versus live decay on Readiness). The strain-floor gap described here adds on top of that.

### B11. Day targets handle accepted plan changes inconsistently, and a replaced run becomes a 1-TSS training day

- **Finder severity:** medium
- **Verifier votes:** confirmed, partially_confirmed, partially_confirmed
- **Code:** src/ui/home-view.ts:760-775, src/ui/readiness-view.ts:154-167, src/calculations/daily-coach.ts:129-142 (only workoutMoves applied); src/ui/strain-view.ts:234-248, 444 (workoutMods applied); src/calculations/fitness-model.ts:606-612 (kmMatch '0km' -> Math.max(0,1)=1 min), no 'replaced' guard unlike src/workouts/load.ts:20-22; replaced description src/cross-training/suggester.ts:1383, stored as newDistance at activity-review.ts:1271

**What the code does (verifier wording):** The core defect is real. Home (strain ring, readiness strainPct), the Readiness view, and daily-coach's deriveStrainContext rebuild today's planned target from freshly generated workouts. They apply only wk.workoutMoves and ignore wk.workoutMods, so accepted reductions, downgrades and replacements do not change the target. The Strain view (getStrainForDate and the week bars) does apply workoutMods. It has no 'replaced' guard, so a fully replaced run keeps its generated description '0km (replaced)' and is parsed by estimateWorkoutDurMin as a 1-minute run. That gives planned day TSS = round(1 x TL_PER_MIN[rpe]) = 1 (2 for RPE 7+), target {lo:1, mid:1, hi:1}, and the day still counts as a training day. It also adds a near-zero day to perSessionAvg, which lowers the average. One correction to the failure scenario: the quoted copy "Daily load exceeded target. 47 TSS logged against 1 TSS planned. Avoid additional training today." never appears. strain-view.ts coachingText() (line 335) is dead code with no callers. What the Strain view actually shows is "47 TSS / Target 1 TSS / Load exceeded" in red. The replaced description comes from applyAdjustments at suggester.ts:1295 in the live path. suggester.ts:1383 is the legacy applySuggestionChoice.

**Scenario:** Probe: computePlannedDaySignalBTSS on a '0km (replaced)' workout returns 1, and computeDayTargetTSS returns {lo:1, mid:1, hi:1}. If the user accepts 'Replace' for Wednesday's easy run and logs the 47-TSS ride that day, the Strain view says 'Daily load exceeded target. 47 TSS logged against 1 TSS planned. Avoid additional training today.' Home still uses the original 31-TSS easy run as the target. After a 'Reduce long run 20->14 km', Home's ring and readiness strain % are measured against 20 km while the Strain view uses 14 km.

**Reachable in practice:** Yes, in normal use. Any accepted Reduce or Replace on a cross-training or excess-load suggestion writes wk.workoutMods: the activity-review.ts:1258 Strava/Garmin review flow, the excess-load-card.ts:397 "unspent load" card, plan-view, events, and holiday-modal. The replace path with newDistanceKm = 0 comes from suggester.ts:852 (easy runs within the volume floor) and planSuggester.ts:484. After that, Home's strain ring and readiness score, the Readiness view, and the coach message all still use the unmodified planned session. The Strain view is opened by tapping the strain ring (home-view.ts:2012, readiness-view.ts:533, activity-detail.ts:421). It uses the modded workouts and shows the replaced day as a 1-TSS training day, both on the ring for any past or present date and in the week bars. Reduce mods such as "14km (was 20km)" parse to 14 km in the Strain view and stay at the generated distance on Home and Readiness.

**Impact:** Replaced easy run on the probe plan: the Strain view target for that day becomes 1 TSS (range 1-1) instead of treating it as a rest or ad-hoc day. Home still targets 29 TSS (25-33). A 47-TSS ride logged that day shows as "Load exceeded" in red against "Target 1 TSS" in the Strain view. On Home it reads "Load exceeded" only because 47 > 33 x 1.3 = 42.9; a 40-TSS ride would read "Above target". In the Strain view, perSessionAvg falls from 53.5 to 46.5 (-13%). That lowers the rest-day target and the overreach threshold for every other day that week, because the replaced day still counts as a training day. For reduce mods, Home and Readiness strainPct uses the pre-reduction distance as its denominator. For example, a long run cut from 20 to 14 km has a denominator about 43% too large, which understates strain % in the readiness floor. The Strain view uses 14 km, so the two screens disagree. The dead-code coaching sentence quoted in the report is never shown. The visible symptom is the status label and the "Target 1 TSS" text.

### B12. iTRIMP-to-TSS normaliser ignores sex, so female TSS is about 19% low

- **Finder severity:** medium
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/calculations/fitness-model.ts:265-271 (beta = 1.92 hard-coded), :284-286; src/main.ts:146 (setAthleteNormalizer without sex); iTRIMP uses beta 1.67 for female: src/calculations/trimp.ts:23, supabase/functions/sync-strava-activities/index.ts:44, 66

**What the code does (verifier wording):** computeAthleteNormalizer (src/calculations/fitness-model.ts:265-271) always uses beta = 1.92 and takes no sex argument, and none of the setAthleteNormalizer calls (src/main.ts:146, 393, 411, 428, 467) pass sex. iTRIMP itself uses beta 1.67 when biologicalSex === 'female' (trimp.ts:23, edge function index.ts:44, 66, with sex passed through at index.ts:435-436, 815-889, 1132-1164, stravaSync.ts:35 and :553, and activity-matcher.ts:393 and :1069). So for a female athlete with a Garmin-supplied LTHR, the fitness-model.ts normalizeiTrimp sites score one hour at LTHR at about 81 TSS, not the 100 the code documents. That is a uniform factor of e^(-0.25 x HRR_LT), roughly 0.81, on every session. The claim goes too far in three places. (a) Only the roughly 11 normalizeiTrimp call sites in fitness-model.ts use the LTHR normaliser. About 25 other sites hard-code /15000 and are not affected by it. (b) Tier placement never touches the LTHR normaliser: it comes from ctlBaseline built in edge-function history mode with a fixed 15000. (c) ACWR is a ratio, so a uniform scale mostly cancels out. The real mismatches are against sex-neutral RPE x TL_PER_MIN numbers: the daily planned strain target, per-session planned TSS, and no-HR duration fallbacks. Separately, the fixed 15000 constant is also sex-neutral, so female TSS is depressed by about 17-19% even without LTHR, through a different line of code.

**Scenario:** Probe: LTHR 168, rest 50, max 190, one hour at LTHR. Male scores 100.0 TSS, female 81.0 TSS. A female athlete's HR-tracked sessions all read about 19% below their RPE-based plan and below no-HR sessions of the same effort. CTL/ATL and tier placement are depressed by the same factor.

**Reachable in practice:** This is reached only for users who picked Female at the onboarding physiology step and whose physiology source is Garmin. Garmin must also report a lactate-threshold HR (syncPhysiologySnapshot, called from main.ts:421-428 for Strava plus Garmin physiology, main.ts:465-467 for Garmin-only, and the onboarding "Sync from Garmin" button). restingHR and maxHR must be set, with rest < LTHR < max. Strava-only and Apple Health users never get s.ltHR, so they always use the 15000 fallback and never hit the LTHR normaliser path. They are still affected by the same sex mismatch through the fixed 15000 constant, which is a separate code location. Users who chose Male, Prefer not to say, or no answer are unaffected (beta 1.92 on both sides).

**Impact:** For an affected female Garmin-LTHR user, every HR-based session in the fitness-model.ts paths reads about 17-19% low, depending on the HR profile (81.0 TSS instead of 100 for 1 h at LTHR in the probe). Those paths are weekly Signal A/B TSS, today's Signal B strain, CTL/ATL/TSB and the rolling load ratio.
- The comparisons that actually go wrong are against sex-neutral TL_PER_MIN numbers: the daily strain target (computePlannedDaySignalBTSS), per-session planned TSS, and no-HR or RPE-fallback sessions in the same week. A female threshold hour at 81 TSS sits below its RPE-based plan value.
- Weekly plan targets are not a clean sex-neutral comparison. They come from history-mode TSS (fixed 15000, female beta), which is also depressed, to about 82.7 for 1 h at LT. The in-plan and baseline scales differ by only about 2% (81 vs 82.7).
- ACWR ratio: the uniform scale largely cancels, apart from the roughly 2% seed mismatch and any no-HR sessions mixed in.
- Tier placement: not affected by this normaliser at all. It is depressed about 17-19% by the sex-neutral 15000 used in history mode (stravaSync.ts:306-315 with index.ts:497-503). That applies to all female users, not only those with LTHR.
- About 25 UI and matcher sites that hard-code /15000 (plan-view session TSS, home-view, strain-view, activity-matcher excess checks) never see the LTHR normaliser. They show about 82-83% of the male-equivalent value, for the same underlying reason: a sex-neutral denominator.

### B13. Stats 16w/All load chart plots Signal A x 1.4 (an unsourced constant) while 8w shows Signal B, and the extended-history fetch never runs

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/data/stravaSync.ts:581-596 (:588-592 backfill stores only totalTSS, although the edge function returns rawTSS per week), :615-630 (fetchExtendedHistory expects an array); supabase/functions/sync-strava-activities/index.ts:577-583 (history mode returns an envelope {rows,_debug}); src/ui/stats-view.ts:235-240 (16w/All uses extendedHistoryTSS x 1.4), :3097-3100 (the only caller)

**What the code does (verifier wording):** The claim holds, with one small correction. fetchExtendedHistory casts the edge-function response to an array (src/data/stravaSync.ts:617-621). The edge function's history mode always returns the envelope {rows,_debug} (supabase/functions/sync-strava-activities/index.ts:577-583). So Array.isArray(rows) is false and the function always returns early. Nothing ever calls fetchExtendedHistory(52), so 'All' can never hold more than the 16 weeks written by backfillStravaHistory(16). Only backfillStravaHistory(weeks>=16) fills extendedHistoryTSS (stravaSync.ts:580-596), and it stores r.totalTSS, which is Signal A, not r.rawTSS. On 16w or All, whenever extendedHistoryTSS is non-empty, getChartData plots extendedHistoryTSS x 1.4 (stats-view.ts:235-240). On 8w it plots historicWeeklyRawTSS, which is Signal B. The current-week bar is computeWeekRawTSS, also Signal B (stats-view.ts:232). The correction is that the 1.4 is not completely absent from the docs. OPEN_ISSUES.md:540 (ISSUE-52) calls it a "conservative proxy" and CHANGELOG.md:1793 calls it "PRINCIPLES.md sanctioned". Neither gives a derivation, SCIENCE_LOG.md has no entry for it, and PRINCIPLES.md:276 actually forbids it ("Do NOT apply a multiplier proxy (x 1.4 or any constant)"). There is also an aggravating point: after backfill(16), fetchStravaHistory(16) has already stored the full 16 weeks of Signal B in historicWeeklyRawTSS (stravaSync.ts:253, not re-sliced by backfill at :594-596). The correct data is in state but the 16w/All path ignores it.

**Scenario:** A pure runner at 300 TSS/week (Signal A = Signal B) sees the same historic week at 300 on 8w and 420 on 16w/All. A heavy cross-trainer (Signal B well above 1.4 x Signal A) sees history understated relative to the current week. 'All' never loads 52 weeks. Tapping 16w before any backfill has run shows 'Loading…' and then the same 8 weeks as the 8w view.

**Reachable in practice:** Yes, it is reached in normal use. Stats tab, then the Progress card (stats-view.ts:3288 tapHandler 'stats-card-progress', then renderProgressDetail at :3189, which wires the range buttons at :3196), then tap '16w' or 'All' on the Total Load chart. extendedHistoryTSS gets filled for Strava users in three ways: automatically at startup (src/main.ts:486-490) when stravaConnected && (!stravaHistoryFetched || historicWeeklyTSS.length<8), from Account > Fetch/Refresh history (account-view.ts:806, :813), and via cross-device restore (planSettingsSync.ts:24-29 syncs extendedHistoryTSS and resets stravaHistoryFetched). Once it is filled, every 16w/All view shows Signal A x 1.4. Users whose backfill never ran (for example, the wizard's fetchStravaHistory(8) already returned 8 or more completed weeks, so the startup backfill is skipped) see "Loading…" on 16w, then the same 8 weeks as 8w. 'All' never loads 52 weeks on any path. One caveat: this assumes the deployed edge function matches the repo source. The repo's history mode only ever emits the envelope.

**Impact:** For a pure runner, every historic week reads 40% higher on 16w/All than on 8w (300 becomes 420). The current-week bar stays at real Signal B, so the chart shows a false drop into the current week of about 29% (420 to 300 at equal training). For a runner who cycles heavily (B/A about 1.8 for the cycling share), history is understated. In the probe, a 500-TSS Signal B week shows as 420 on 16w (-16%), and all-cycling weeks would show about 23% low (0.55 x 1.4 = 0.77). The current week then looks like a spike. The 'All' range can never show more than 16 weeks, and before a backfill it shows at most the 8 wizard weeks. This only affects what the Stats Progress Total Load chart displays for 16w/All. It does not feed ACWR, CTL or plan adjustments, which use historicWeeklyTSS, historicWeeklyRawTSS, ctlBaseline and signalBBaseline. There is a separate, smaller scale mismatch on all ranges: history TSS uses a fixed 15000 normalizer (index.ts:500-507), while the current-week computeWeekRawTSS uses the personal normalizer (fitness-model.ts:263-281).

### B14. Daily Signal B (rolling ACWR and strain) ignores the rated RPE for no-HR activities

- **Finder severity:** low
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/calculations/fitness-model.ts:507-519 and :1033-1038 (TL_PER_MIN[5] fixed) vs :426-433 (weekly uses ratedMap RPE); src/calculations/activity-matcher.ts:760-761 (derived RPE); edge function stores itrimp=null for no-HR activities (supabase/functions/sync-strava-activities/index.ts)

**What the code does (verifier wording):** When a plan-matched activity (a `garminActuals` entry) has no iTRIMP, the two Signal B paths score it differently. `computeTodaySignalBTSS` and the `getDailyLoadHistory` per-activity breakdown always charge `TL_PER_MIN[5]` (1.15/min). `computeWeekRawTSS` charges `TL_PER_MIN[wk.rated[workoutId]]`. For a no-HR Strava run, `wk.rated` holds the RPE `deriveRPE` produced, and for such a row that is simply the planned workout's RPE, because every HR/Garmin signal is null. It holds the user's own rating only if the user entered one. So the rolling 7d/28d ACWR, today's strain and the rolling-load chart use RPE 5, while the weekly Signal B totals use the planned or rated RPE. The adhoc and unspent-load paths are consistent between daily and weekly. Only the `garminActuals` path diverges.

**Scenario:** Probe: a 60-min no-HR run rated RPE 8 gives weekly Signal B 133 and daily 69, so rolling ACWR and today's strain under-read hard no-HR sessions by about 48%, while easy no-HR sessions rated below 5 are over-read.

**Reachable in practice:** Yes, but only for activities with no heart-rate data that land in `garminActuals`. That means a Strava activity recorded without an HR sensor (phone-only GPS, manual entry, treadmill with no strap), or a Garmin activity with no HR, that is then matched to a planned slot. Matching happens either by `matchAndAutoComplete` (auto-match for high-confidence runs, activity-matcher.ts:755-787, plus the other `garminActuals` writes at :498/:555/:694/:1140) or by the user confirming a match in Activity Review (activity-review.ts:953, 1054, 1096, 1154, 1587, 1635, 1682, 1721). Both the auto-match (activity-matcher.ts:761) and the Activity Review confirm paths write the RPE into `wk.rated`, so the weekly totals always have a non-default RPE to use. The daily and rolling paths never read it. Users whose watch always records HR get an iTRIMP (the edge function computes one from summary `avgHR` too), so they never hit this.

**Impact:** Per minute of a no-HR matched session, daily Signal B charges 1.15. Weekly charges TL_PER_MIN[RPE]: 0.65 at RPE 3, 0.92 at RPE 4, 1.78 at RPE 7, 2.22 at RPE 8, 2.75 at RPE 9.

For a 60-min session:
- RPE 8: daily 69 vs weekly 133, so daily under-reads by about 48%.
- RPE 9: 69 vs 165 (about -58%).
- RPE 3 easy: 69 vs 39, so daily over-reads by about 77%.
- RPE 4: 69 vs 55 (+25%).

Because the derived RPE for a no-HR Strava run is the planned session's RPE, a no-HR runner on a typical plan sees these effects in the numbers below:
- Rolling ACWR acute and chronic, which drives injury-risk status.
- Today's strain.
- The rolling-load chart.

Easy runs are over-counted and hard sessions under-counted. The same week's Signal B total on Plan, Stats and Debrief uses the other value, so the two views disagree for the same activity.

### B15. Float-session recoveries not parsed, so planned float TSS and load are undercounted

- **Finder severity:** low
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/workouts/intent_to_workout.ts:157 (', 2min float @ MP'); src/calculations/fitness-model.ts:595-601; src/workouts/load.ts:48-56 (both only match 'min recovery')

**What the code does (verifier wording):** Float fartlek sessions from the plan engine have descriptions like 'N×Mmin @ pace, Rmin float @ MP'. Both duration parsers match recovery only with the regex /(\d+\.?\d*)\s*min\s*recovery/, so they drop every float recovery minute. The 8×2 variant is parsed as 16 min when it really takes 30, and gets 28 planned TSS against about 53. The three variants with a warm-up and cool-down lose 8 to 10 min (for example 29 to 32 min parsed against 38 to 41 real), about 20 to 25% too low. This low figure feeds planned day TSS (strain target, strain %, the readiness strain floor), the planned TSS shown per workout on the Plan view, and w.aerobic/w.anaerobic from the generator. The "exceeded" and 34-floor effects reliably show up only for the 8×2 variant, not the variants with a warm-up.

**Scenario:** Probe: '8×2min @ 5:02/km, 2min float @ MP' gives 16 min against the real 30. The warm-up variant '1km WU / 6×3min ... 2min float / 1km CD' gives 30 min against 40. Planned day TSS for the no-warm-up case is 16 x 1.78 = 28, while a normally executed 30-min float session scores well above 130%. That triggers the same 'exceeded' labels and readiness strain floor as the easy/long RPE 3 finding.

**Reachable in practice:** Yes, on the default plan path. generateWeekWorkouts takes the planWeekSessions → intentToWorkout path whenever weekIndex and totalWeeks are passed (generator.ts:50-67). daily-coach.ts:129-131 and the home, readiness and strain views pass s.w and s.tw.

A float slot is generated when all of these hold:
- race is marathon or half (plan_engine.ts:236)
- phase is build or peak (238)
- ability is intermediate or higher, meaning VDOT ≥ 40 and experience is not beginner or novice (57-80, 240-241)
- the float slot falls within the quality cap in the priority list (257-281)

That means float appears every build/peak week for a Balanced marathon runner, a Balanced half runner, and a Speed runner in half build (priority MP then float, or threshold then float, with a cap of 2 needing at least 3 runs per week). Speed or Endurance marathon runners get it only if their ability band is elite (cap 3).

The severe case, the 8×2 variant with no warm-up (the variant for weeks 3, 7, 11, 15, ...), shows up in about 1 of every 4 float weeks. On those days, completing the session as prescribed (HR or Strava sync, iTRIMP to Signal B) gives strain above 130%. The result is the 'Exceeded' / 'Load exceeded' label and readiness capped at 34 (Ease Back). The other three variants are undercounted by about 20 to 25%, which inflates strain % but normally will not cross 130%. The legacy library strings in constants/workouts.ts:53-103 use the same wording but are only used on the fallback path with no week context.

**Impact:** - 8×2 float day: planned Signal B shows 28 TSS instead of about 53, 47% too low. A prescribed 30-min session scores about 38 to 46 TSS, so strain reads 134 to 165%. That triggers 'Exceeded' / 'Load exceeded' and the readiness strain floor of 34, and the coach says to avoid further training, even though the runner did exactly what was planned. The Plan view shows 28 planned TSS for the workout. Generator loads are aerobic 36 / anaerobic 20 against 68 / 37, so cross-training replacement matching works from a target about half its real size.
- Float variants with a warm-up (3 of 4 weeks): planned day TSS is 50 to 57 against 68 to 73, and duration 29 to 32 min against 38 to 41. That is about 20 to 25% too low, so strain % is inflated by the same factor (for example, a correctly executed session reads about 120% instead of about 95%), usually below the 130% trigger. Planned week TSS / perSessionAvg (daily-coach.ts:160-162) is also slightly too low on float weeks, by 15 to 25 TSS per week.

### B16. Coach modal and LLM compare a partial week's Signal A with a full-week target on a different basis from the Plan bar

- **Finder severity:** low
- **Verifier votes:** confirmed, partially_confirmed, partially_confirmed
- **Code:** src/calculations/daily-coach.ts:261-273 (computeWeekTSS vs computePlannedWeekTSS, s.athleteTier without override); src/ui/coach-modal.ts:202-212 (caution if <60% or >110%); supabase/functions/coach-narrative/index.ts:358-361

**What the code does (verifier wording):** The claim holds, with three corrections. (1) The Coach modal's "Week load" row and the LLM prompt use week-to-date Signal A: computeWeekTSS, runSpec-discounted, with no decayed carry. They compare it to computePlannedWeekTSS, a full-week Signal A target with no cross-training budget, using s.athleteTier and ignoring athleteTierOverride. The row turns caution-coloured below 60% or above 110%. The LLM receives "X TSS (Y% of the planned Z TSS)" with no weekday or days-elapsed field. Home "This Week" and the Plan "Week Load" bar use computeWeekRawTSS plus computeDecayedCarry against computePlannedSignalB, with the tier override applied. (2) The Coach comparison is internally same-signal (A vs A), so it is not a cross-signal bug. It differs from Home and Plan only when the user cross-trains, has set a tier override, or is carrying excess from a prior overshoot week. For a pure runner with none of these, the Coach numbers match Home exactly. What remains in that case is the caution colour on an on-plan partial week. (3) The LLM system prompt does include a generic caveat ("completed so far... < 50% midweek is normal if key sessions are later"). This softens the under-training risk but does not remove it, because the model is never told the day. The "about 30%" figure depends on the plan. A 4-run week probes at 44% on a Tuesday, still in caution.

**Scenario:** On a Tuesday after two on-plan runs, the Coach tile shows about 30% of plan in caution colour, and the LLM prompt says the week is at 30% of planned load, which invites an under-training narrative. A user who cross-trains sees a different load number and % on Coach than on Home 'This Week' for the same week.

**Reachable in practice:** Yes. Every user who taps "Coach" on Home, or on the Plan current week, hits openCoachModal, then computeDailyCoach, then the Week load row. The same numbers go to the coach-narrative LLM call, up to 3 calls a day, cached. The caution colour appears for an on-plan runner from Monday until most of the week's load is done. The probe showed caution Monday through Thursday or Friday, clearing only once 3 of 4 runs were logged. Divergence from the Home and Plan numbers is reachable for any Strava user with cross-training: sportBaselineByType is populated in stravaSync.ts around line 291, and cross-training lands in adhocWorkouts or unspentLoadItems. It is also reachable for anyone with athleteTierOverride set, and in any week after a week whose Signal B exceeded plan (decayed carry, current week only).

**Impact:** Pure runner, no override, no prior overshoot: the numbers are identical to Home. The only defect is presentational: an on-plan partial week shows in caution colour (e.g. 44% on a Tuesday, 0% on Monday morning), where Home shows the same value in neutral grey. The LLM gets the % with no weekday. The system prompt's "<50% midweek is normal" caveat partly guards against an under-training narrative, but the model cannot know whether it is midweek.

Cross-trainer (one 90-min ride): Coach 171/291 (59%, caution) vs Home 207/366 (57%). Both the load number and the target differ.

After an overshoot week: Coach 44% vs Home 62%, an 18-point gap from carry alone.

Tier override (performance, build): target 324 vs 336, about 4% lower on Coach. The LLM is told tier "performance" while the target was computed with recreational multipliers.

Separate issue noticed in passing, not part of this claim: daily-coach.ts:353 already divides TSB by 7 before sending it, yet coach-narrative/index.ts:212 tells the LLM the TSB value is weekly and to divide it by 7 again.

### B17. Stats trend charts and the Rolling Load drill-down use a different signal or seed than the headline above them (Rolling Load seeds Signal B ACWR with a Signal A baseline)

- **Finder severity:** low
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/ui/stats-view.ts:2137-2166 (TSB chart: computeFitnessModel with CTL on Signal A and ATL on Signal B, weekly units, no atlSeed, reference bands at +15/0/-10), :2279-2287 (ACWR trend: mixed-signal atl/ctl, includes the partial week) vs headlines at :2678 and :2727; src/ui/rolling-load-view.ts:279-283, :293, :297, :486-487 (signalBSeed = atlSeed; uses s.athleteTier, not the override); every other caller passes s.signalBBaseline: src/ui/injury-risk-view.ts:91-111, :276, src/ui/home-view.ts:704; src/calculations/fitness-model.ts:931-945 (seed used as the pre-plan daily fill)

**What the code does (verifier wording):** Only the Rolling Load half of the claim holds. The Stats-view half is about dead code.

1. rolling-load-view.ts passes atlSeed (ctlBaseline, which is Signal A, times 1 + 0.1*gs, capped at 1.3) as computeACWR's signalBSeed. Every other caller passes s.signalBBaseline. The seed is only used to fill the pre-plan days of the 7d/28d Signal B window. So for about the first 27 days of a plan, the drill-down's "7-day TSS", "28d avg", ring and High/Normal/Low label disagree with the Readiness "7-Day Rolling Load" card that links to it, and with the Injury Risk, Home and Readiness ACWR. Because ctlBaseline is usually well below signalBBaseline, the drill-down's chronic value is lower and its ratio higher.

2. The Stats Freshness and Injury Risk (Load Ratio) cards, with their mixed-signal TSB and ACWR trend charts, are never rendered. No user sees them.

3. The use of s.athleteTier instead of the override in rolling-load-view has no visible effect.

**Scenario:** Probe (Tuesday of week 6, 4 runs + 2 rides per week): the Freshness headline reads +20.5 while its chart plots -66, -85, -88, -86, -82, +74. The Injury Risk headline reads 0.87 while its trend sits at 1.26 to 1.33, above the 1.3 caution line, with a last point of 0.70. Probe 3 days into a plan (signalBBaseline 350, ctlBaseline 250, gs 2): Injury Risk gives chronic 300 and acute 150; Rolling Load gives 257 and 129. In week 2 (ctlBaseline 176, gs 2, signalBBaseline 360) the Rolling Load drill-down shows ratio 1.21 (chronic 248) while the Readiness page linking to it shows 0.86 (chronic 349). For a cross-trainer, the Rolling Load 'High' label (acute > 1.3 x chronic) fires earlier than the Injury Risk view.

**Reachable in practice:** Rolling Load half: reachable. The path is Home, then the Readiness view, then a tap on the "7-Day Rolling Load" card. The only entry is readiness-view.ts:536-537. The card shows whenever acwr.atl > 0, which is nearly always during the first weeks because the seed fills pre-plan days.

The mismatch exists only while the 28-day window still contains pre-plan days, which is plan days 0 to 26. It also needs ctlBaseline*(gym factor) to differ from signalBBaseline, which it does for any user with Strava history: ctlBaseline is a Signal A EMA that starts from 0, while signalBBaseline is a raw-TSS median.

Users with no Strava history have both baselines undefined, so atlSeed is 0 and seedDaily is 0 on both paths, and no mismatch appears.

Stats-view chart half: not reachable. buildFreshnessCard, buildInjuryRiskCard, buildTSBLineChart and buildACWRTrendChart sit only under two unused builders (buildReadinessDetailPage, buildStatsScroll), and the live Stats page never renders them. The athleteTierOverride point has no user-visible path.

**Impact:** These effects apply only during the first 4 weeks of a plan for users with Strava history.

The Rolling Load drill-down's "28d avg" is lower than on the Readiness card that links to it. The gap is about 17% for a pure runner at day 3 (271 vs 350 TSS) and about 40% for a cross-trainer with 2 gym sessions at day 3 (269 vs 450). The drill-down's implied ratio is correspondingly higher:
- Pure runner at steady load: 1.15 to 1.20 vs 1.00 in weeks 1 to 2.
- Pure runner with +20% load in week 2: 1.33 vs 1.12. The drill-down says "High" while the Readiness card says "Normal".
- Cross-trainer: 1.33 to 1.43 ("High", red ring) vs 1.00 ("Normal") in weeks 1 to 2.

The gap shrinks linearly and is gone from plan day 27. It affects display only: no plan adjustment, readiness score or ACWR-driven reduction reads the rolling-load-view numbers. Every such caller uses signalBBaseline.

The Stats Freshness and Load Ratio chart mismatches affect no user-facing number, because that code is dead.

### B18. wk.actualTSS is add-only: it double-counts on re-review and in the modal path, misses review-matched sessions, and sizes holiday bridge weeks; the sleep insight reads the wrong weeks

- **Finder severity:** medium
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/ui/activity-review.ts:217-243 (undo without decrement), :945-1012, :1278-1296, :1579-1736, :1880-1904; src/ui/plan-view.ts:2519-2533; src/ui/renderer.ts:96-110; src/calculations/activity-matcher.ts:521, :794, :1052, :1158-1163; src/ui/holiday-modal.ts:384-390, :912-932 (classifyHolidayActivity feeds buildBridgeWeekMods); src/ui/events.ts:1023; src/ui/main-view.ts:1921-1926, :2004-2017; src/ui/sleep-view.ts:221; src/calculations/daily-coach.ts:300-303

**What the code does (verifier wording):** The field is add-only, and re-review does double-count. Nothing ever lowers wk.actualTSS. The undo paths (openActivityReReview, Unmark as Done / unrateWorkout, removeGarminActivity) remove the adhoc entry or the slot match without subtracting its TSS. Any item that ends up as adhoc (Log only, Excess load, gym overflow) is then added again at raw iTRIMP x100/15000 when it is re-applied. Runs, gym and cross sessions matched to plan slots in applyReview or autoProcessActivities add nothing. Runs auto-matched with high confidence in matchAndAutoComplete do add. So the field mixes three things: raw TSS at a fixed 15000 normalizer, nothing at all, and an extra runSpec-discounted term. It matches neither Signal A nor Signal B.

The field has one live, user-facing consumer: the holiday welcome-back classification. It uses wk.actualTSS for the pre-holiday snapshot and for the holiday-week average, which picks 1, 2 or 3 bridge weeks.

Parts of the claim are overstated:
- The raw-plus-crossTL double add in applyReview (activity-review.ts:1278-1296) is unreachable in the live review flow. The matching screen turns every item without a slot into 'log'.
- The same double add in autoProcessActivities (activity-review.ts:1880-1904) is live only in one case: a single same-day non-run activity with no slot, while ACWR is caution or high, and not absorbed by the Tier-1 easy-run trim.
- events.ts:1023 (carriedTSS) and main-view.ts:1921-1926 / 2004-2017 have no user-facing effect, because all their readers are dead code.
- The sleep-view bug is real: it reads the last 4 plan weeks.
- daily-coach does pass stale pre-plan historicWeeklyTSS, but CoachState.sleepInsight is never read, so that has no effect.

**Scenario:** Probe: a ride logged via review gave wk.actualTSS = 80; after two re-reviews with unchanged choices it was 240, while Signal B stayed at 80. Pre-holiday week 300; during the holiday the user logs 150 raw TSS of hiking per week through review; the field records 150 x 1.45 = 217, so the ratio is 0.72 ('veryActive', 1 bridge week at 85%) instead of 0.50 ('moderate', 2 bridge weeks at 60% easy then 80%). A pre-holiday week whose runs were matched through review is under-counted. The classifyHolidayActivity 0.30 / 0.70 thresholds are crossed wrongly, so buildBridgeWeekMods applies 1, 2 or 3 bridge weeks on inflated or deflated numbers. The sleep-view 'Hard training week' insight cannot fire until the final plan weeks.

**Reachable in practice:** Re-review inflation is reachable. It happens when the user presses Review on the Plan view (plan-view.ts:2708, renderer.ts:935/1377, home-view.ts:2118 call openActivityReReview) and confirms again. Each confirm adds the raw TSS again for every item left as Log only or Excess load. It also adds again an auto-matched run that is moved to Excess.

Remove (x) on an adhoc activity followed by the next sync re-imports the activity and adds it again.

Under-counting is reachable in any week where at least one item is added (a logged or excess activity, or a high-confidence auto-matched run) while other runs, gym or cross sessions were slot-matched through the review screen.

The only live consumer that changes the plan is the post-holiday welcome back, which runs on app start after a holiday of at least the minimum length ends. The 1.45x crossTL double add needs the narrow autoProcessActivities case: a single same-day non-run activity with no slot, while ACWR is caution or high. That is unlikely during a holiday; hikes batched after 24 hours go through the matching screen and are recorded at raw x1.0.

The Zone Carry value (events.ts:1023) and the main-view load and ACWR code never reach the screen. The sleep-view "Hard training week" insight is live but reads the final plan week. The daily-coach sleepInsight is never displayed.

**Impact:** Re-review: each confirm adds the week's logged or excess raw TSS again. The probe went from 80 to 160 to 240 while Signal B stayed at 80.

Holiday bridge, pre-holiday week: 4 review-matched runs (320) plus one logged 80 TSS ride gives a snapshot of 80 against a true 400 (computeWeekTSS). Any holiday average above 56/week then gives a ratio above 0.70, classified 'veryActive': 1 bridge week at 85%. Without the error, a moderate holiday load would get 2 weeks (60% easy, then 80%) and a low one 3 weeks (50%, 70%, 85%).

Holiday weeks: re-reviewing a holiday week, or the rare modal path, inflates the average. For example, 150 raw becomes 300 after one re-review, or 217 via the x1.45 modal path. That can move sedentary or moderate up to veryActive.

The claim's own 217 example requires the ACWR-gated autoProcessActivities modal. The typical batched-review path records 150 (x1.0).

No numeric effect from events.ts:1023, main-view.ts or daily-coach.ts, because none of their outputs are rendered. The sleep-view hard-week message (thresholds 250 / 350 TSS) can fire only when the final plan week holds that much load, so it is effectively never shown during the plan.

### B19. Surplus-run excess items are duplicated on each re-review, unmark or re-match and are never cleaned up

- **Finder severity:** low
- **Verifier votes:** confirmed, partially_confirmed, partially_confirmed
- **Code:** src/ui/activity-review.ts:235-237, src/ui/activity-review.ts:999-1010, src/calculations/activity-matcher.ts:817-828, src/ui/excess-load-card.ts:281-306, src/ui/excess-load-card.ts:336-356

**What the code does (verifier wording):** Confirmed, with some details narrowed. Surplus items are keyed `${garminId}_surplus`. The re-review undo removes only items whose garminId equals the raw id, so surplus items survive it. Every later applyReview for the same run appends another surplus item with no duplicate check. This happens after a re-review (Review button) or after 'Unmark as done' followed by Review. The appended item also adds to wk.unspentLoad.

Unmark (plan-view and renderer) and the × remove on a slot-matched run never touch these items. They set garminMatched to '__pending__', which makes the next Review add another copy.

The duplicate-free append in activity-matcher is only re-reached when garminMatched[id] has been deleted. That happens only on the adhoc branch of removeGarminActivity, so this path is narrow. Matcher-created surplus items still get duplicated by the ordinary re-review path.

The duplicates inflate what the adjust-plan modals show: the item count, the TSS summary (duration × TL_PER_MIN[5], because `_surplus` ids never match an actual's garminId) and the severity headline. They also inflate the carry-over card count, but only if the week ends over its planned Signal B.

The duplicates do not reach Signal A/B, CTL, ATL or ACWR, which skip surplus_run items. The inflated wk.unspentLoad has no live consumer.

**Scenario:** Probe: a 20 km run was matched to the 8 km 'W1-easy-0' slot, creating one surplus item of 72 min (unspentLoad 108). After two re-reviews confirming the same slot there were three identical surplus items (unspentLoad 324). Tapping Adjust Plan then sizes a 216-min 'extra running' activity (reduction still capped by excess), shows about 248 TSS from 3 activities, and the carry-over card counts three carried items.

**Reachable in practice:** Yes, in ordinary use.

**Common trigger.** A Strava run is matched to a plan slot, either by the auto-matcher (high confidence) or by the user in Activity Review. Its distance is over 1.3× the first "Nkm" in the slot description. That is common for long easy runs, and for almost every threshold or vo2 session because the regex reads the warm-up distance. The run also has to be in the current week: openActivityReReview on a past week (isPreviousWeek) returns early and never runs the undo or applyReview.

**Flows that then add a duplicate:**
- (a) Tap Review in the Plan activity log or on Home after everything is processed. That calls openActivityReReview, and confirming the matching screen adds one more surplus item. It repeats on every re-review.
- (b) Tap 'Unmark as Done' on the matched slot, then Review, and confirm. That adds one more.
- (c) Tap × on a slot-matched run. It goes back to pending and the surplus stays; the next Review adds another.
- (d) Rarer: the run is logged as adhoc, then removed with ×. The next sync re-imports it, and if it auto-matches again the matcher adds another surplus item.

**Where the user sees it:**
- The Adjust Plan modal (from the excess card, the 'Adjust week' button or the carry-over card).
- The Home readiness 'Adjust' button, which calls triggerACWRReduction whenever any unspent item exists.
- The carry-over card, but only if the week ends over its planned Signal B.

**Impact:** **Growth per action.** Each re-review or unmark-then-review adds one full copy of the surplus. In the probe (20 km run in an 8 km easy slot), each copy is 66 min, about 76 TSS in the modal text (66 × 1.15).

**Modal text and severity.** After 2 re-reviews the modal changes:
- from "66 min extra run", severity heavy,
- to "228 TSS from 3 extra activities, equivalent to 25 km easy running", severity extreme.

The reported figure of 248 TSS for 3 × 72 min is consistent with the same arithmetic (216 × 1.15).

**Proposed reductions.** These are capped by the week-level Signal B overshoot, which excludes surplus_run items. So the actual plan change is usually unchanged; it was identical in the probe. The inflated load raises the uncapped budget only when:
- the overshoot is larger than one copy's replacement budget, or
- in triggerACWRReduction when plannedB is null, in which case there is no cap at all.

**Carry-over card.** It shows N 'cross-training activities' (one per duplicate) if the week closes over target.

**Stale items.** Unmarked or removed runs leave their surplus items in place. The modal and carry-over card can therefore still offer to cut sessions for load from a run that is no longer counted.

**What is not affected.** CTL, ATL, TSB, ACWR, and weekly Signal A/B TSS. The inflated wk.unspentLoad (99 → 396 in the probe) has no live consumer.

### B20. The per-sport load breakdown counts surplus running on top of the full matched run

- **Finder severity:** low
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/ui/home-view.ts:236-254, src/calculations/fitness-model.ts:383, src/calculations/fitness-model.ts:467, src/ui/load-taper-view.ts:346, src/ui/home-view.ts:263-285

**What the code does (verifier wording):** The core defect is real. computeLoadBreakdown (src/ui/home-view.ts:148) has no `reason === 'surplus_run'` skip. The first surplus item for a matched run adds durationMin x 1.15 TSS, plus its minutes, to the 'Running' segment, on top of the full run already counted from garminActuals. computeWeekRawTSS and computeWeekTSS skip these items. The duplicate sub-claim is refuted: duplicate surplus items share the garminId `<id>_surplus`, and computeLoadBreakdown's own seenGarminIds check drops every copy after the first. Duplicates therefore add nothing further to the breakdown. The only path that creates surplus items in practice is the Activity Review flow (activity-review.ts). The matcher's surplus branch cannot fire for standard 'Nkm' descriptions.

**Scenario:** A 20 km run (iTRIMP 20000, so 133 TSS) is matched to an 8 km slot, creating a 72-min surplus item. The Load & Taper breakdown and the plan load sheet total show Running at about 216 TSS (133 + 83), while computeWeekRawTSS for the week is 133. Duplicate surplus items from re-review add another 83 each.

**Reachable in practice:** Yes, through the normal current-week flow. A run synced from Strava or Garmin for the current week is queued for review when the matcher's confidence is below 'high' (activity-matcher.ts:885-900). The user then integrates it in Activity Review. applyReview accepts matchCache matches at 'medium' confidence, or any slot the user confirms (activity-review.ts:933-941). A 20 km run on the same day as an 8 km easy slot scores 4, which is 'medium', so it is matched. Because 20 > 8 x 1.3, a surplus item is created (activity-review.ts:995-1010).

The item stays on the current week until an excess-load 'adjust' action clears it (excess-load-card.ts:412/443/487, main-view.ts:2409). If the user keeps the load or ignores the card, it stays. Opening Load & Taper from Home (home-view.ts:2082) or Plan (plan-view.ts:2274/2284) then shows the inflated Running row.

The plan load sheet over completed weeks is hit much less often. At week advance, items are cleared if the week was under plan (events.ts:1085-1087). Otherwise, on the next launch, they are moved to the current week (persistence.ts:376-389). Once moved, their prior-week date makes computeLoadBreakdown skip them (home-view.ts:237-241). Completed weeks keep surplus items only in narrow windows: after an over-plan advance and before the next launch, or in weeks skipped by a multi-week jump.

**Impact:** Claim scenario: a 20 km run in 120 min with iTRIMP 20000, matched through review to an 8 km slot.
- Load & Taper Running row: 216 TSS and 3h 12m.
- Ring or header value (computeWeekRawTSS + carry): 133 TSS, plus any carry.
- The Running bar segment is therefore about 1.6x the headline number, and the stacked bar can exceed 100% width.

In general, the Running row is inflated by (surplusKm/actualKm) x durationMin x 1.15 TSS for each distinct matched run over 130% of its planned km. Only one surplus item per run counts. The claim's "another 83 each" for duplicates is wrong: duplicates add 0.

The plan load sheet is rarely affected, because surplus items are usually cleared from completed weeks or moved and then date-filtered. No model number changes: CTL, ATL, ACWR and TSB use computeWeekTSS and computeWeekRawTSS, which skip surplus items. The error is display-only, in the per-sport breakdown.


## C. Getting activities in (Strava, Garmin, dedup)

### C1. Standalone sync burns the app-wide Strava rate limit on every launch: hr_drift is never selected, so the drift heal re-fetches the stream for every cached run, and rows with null zones are re-streamed forever

- **Finder severity:** high
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** supabase/functions/sync-strava-activities/index.ts:1026-1040 (select omits hr_drift; cachedMap has no hr_drift), :1104 (cached.hr_drift is always undefined), :1186-1203 (drift-heal stream fetch for every cached RUNNING >=20 min, every sync), :1099 and :1116-1155 (any row with hr_zones null is re-fetched each sync: stream plus detail call for runs), :1171-1182 (cached runs without splits re-fetch detail); list call :971 throws on 429 and returns 500 at :1261-1262; client swallows it at src/data/stravaSync.ts:186-188; backfill adds 2 calls per run for up to 99 runs, :759-774 and :803-841
- **Independent check:** Code read by Claude: cache select omits hr_drift; heal condition always true; heal write is `void`-ed so never sent.

**What the code does (verifier wording):** Every standalone sync (each cold launch, and each press of the manual sync buttons) makes about one Strava call per cached run in the 28-day window, even when there is nothing new. The core claim holds, and it is worse than reported because the heal's DB write never runs at all. Two defects combine:
(1) The cache select at index.ts:1028 omits hr_drift. So `cached.hr_drift == null` at :1186 is always true, and every cached run with zones and elapsed time of 20 min or more is re-streamed on every sync (:1186-1203).
(2) The heal writes with `void supabase.from(...).update(...).eq().eq()` at :1197 (and the km_splits heal at :1177). postgrest-js only sends the request inside `.then()`, so these updates are never sent. Adding hr_drift to the select alone would not stop the loop for rows whose hr_drift is null. The same applies to the splits heal: cached runs with null km_splits re-fetch detail on every sync forever.
Separately, any row with hr_zones null (no HR stream: manual or phone-only activities) takes the else branch (:1116-1162) on every sync. That costs one stream call, plus one detail call for runs (or when calories are null).
One small correction: the re-computed drift is not unused. It goes back to the client in the response row (:1195, pushed into rows). What never happens is persisting it or reading it back.
Failure mode (a) is confirmed: a 429 on the list call gives HTTP 500 and syncStravaActivities returns {processed:0}.
Failure mode (b) is confirmed but transient. The newest activity gets the avg-HR iTRIMP estimate and no zones for that sync only. The next unthrottled sync re-streams it, because hr_zones is null, and activity-matcher.ts:577-579 overwrites actual.iTrimp for matched items.

**Scenario:** A runner with 5 runs of 20 min or more per week costs about 21 Strava calls per app launch with nothing new to fetch; a runner without HR costs 2 calls per run. A handful of launches across all users in 15 minutes, or about 50 launches a day, exhausts the app quota. After that, (a) the /athlete/activities call returns 429, the edge function returns 500, and syncStravaActivities silently returns {processed:0}, so no user's new load reaches the plan until the window resets. Or (b) the newest activity's stream call fails, and it is stored with the avg-HR iTRIMP estimate (lower than the stream value for interval sessions) and no zones.

**Reachable in practice:** Yes, in normal use for every Strava-connected user.

Where the standalone sync runs:
- Every cold launch: src/main.ts:398-402, after isStravaConnected() succeeds.
- The main-view "Sync" button: src/ui/main-view.ts:2685.
- Both account-view Strava sync buttons: src/ui/account-view.ts:1148 and :1167.
- After the Strava connect redirect: src/main.ts:378.

Foreground resume does not trigger it (src/main.ts:605-623 handles physiology only). On web, every page reload counts as a launch.

The drift heal needs no special data, just ordinary runs of 20 min or more that have an HR stream. The no-HR path is hit by manual entries and phone-only runs.

On launch, the backfill (src/main.ts:486-489) also fires whenever fewer than 8 completed weeks have activity. History only emits weeks that have data (index.ts:482-487), so a user with gaps can trigger it on every launch. A first backfill can cost up to 99 × 2 calls plus up to 15 calorie-heal detail calls (index.ts:759-774, :803-841, :919-931), which alone exceeds 100 per 15 min.

Two points I could not verify from the code:
- The rate-limit scope. developers.strava.com is blocked here. Strava documents its limits per application, with default read limits of 100 per 15 min and 1,000 per day, and the code's own comment at :1023 assumes 100 per 15 min. The app's actual approved limits and user count are unknown. If the Strava app is still single-athlete, the shared-quota amplification does not apply, but one user can still exhaust it alone.
- The ascending list order when `after` is used. This is Strava behaviour, not code. The claim that "the newest activity is reached last" depends on it.

**Impact:** Measured by the probe:
- Runner with HR and 5 runs of 20 min or more per week: 21 Strava calls per sync with nothing new (1 list + 20 streams), every sync.
- Runner without HR: 1 + 2 per run (41 for 20 runs).

At Strava's default read limits (100 per 15 min, 1,000 per day):
- About 5 syncs in 15 min (100/21 = 4.8) exhaust the window.
- About 48 syncs a day (1000/21) exhaust the daily quota.
- For a no-HR user: about 2 syncs in 15 min and 24 a day.
The 20 extra calls also run in sequence, adding several seconds to each launch sync.

Once the list call returns 429, the sync returns 500 and the client silently returns {processed:0}. No new activity load reaches garminActuals or the plan until the window resets. The UI still reports success: account-view shows "Sync complete" and the main-view button shows "Synced", because syncStravaActivities swallows the error.

If the limit hits mid-loop, the newest activity gets the avg-HR iTRIMP. That is lower for variable-HR sessions, because x·e^(βx) is convex: 9214 vs 9744 (-5.4%) in the probe's alternating-HR run. It also gets no zones. This is transient: the next unthrottled sync restores the stream value and zones for matched runs (activity-matcher.ts:577-579).

Fix note: fixing the select alone is not enough. The `void` updates at :1177 and :1197 must also be awaited, or the heal loops forever for rows whose hr_drift or km_splits are null.

Related (not probed): list order is ascending with `after` and per_page is 50 with no pagination (:971-974). If that ordering holds, a user with more than 50 activities in 28 days never syncs the newest ones.

### C2. Removing Strava re-ingests 28 days of Garmin webhook copies, so every recent session counts twice

- **Finder severity:** high
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/ui/account-view.ts:173-176,203-204,335-352,1121-1139; src/data/sources.ts:22-31; src/main.ts:384,397,450-457; src/ui/account-view.ts:944-957; src/ui/main-view.ts:2689-2692; src/data/activitySync.ts:26-47; supabase/functions/sync-activities/index.ts:20-28; supabase/functions/garmin-webhook/index.ts:149-166; src/calculations/activity-matcher.ts:422-429,605,681-713,714-742,865-873,874-904,441-527; src/calculations/fitness-model.ts:321-328,416-425,506-541

**What the code does (verifier wording):** Confirmed, with two corrections. When a Garmin-physiology user (Garmin connected, Strava added as the wizard requires) taps Strava "Remove", the next Garmin-path sync loads numeric Garmin webhook rows from the last 28 days. Each is the twin of a session already ingested as strava-<id>. matchAndAutoComplete dedups only by garmin_id, so each twin is added a second time:
- Past-week runs and cross-training become adhoc (cross-training also gets a garminActuals entry).
- Current-week twins go to garminPending. Every review outcome adds load, and an unreviewed twin is auto-logged as adhoc once the week advances.
- Weekly Signal A and B, daily Signal B, CTL and ATL all count the session twice.

Correction 1: "the user cannot reject a duplicate" is too strong. A remove button (×) exists (removeGarminActivity), but the removal does not stick: the next sync re-ingests the twin.

Correction 2: the 7d/28d rolling ACWR does not reliably "spike". computeRollingLoadRatio divides a 7-day sum by a 28-day average, and sync-activities also looks back 28 days. When the whole window is doubled, both numerator and denominator double and the ratio is roughly unchanged. It spikes only when part of the 28-day window is undoubled, for example seed-filled days before plan start or twins still pending. Afterwards it drifts low as new single-counted days replace doubled ones. The weekly EWMA ATL (7-day time constant) rises faster than CTL (42-day), so TSB (freshness) does drop.

**Scenario:** Probe (deleted), with plan weeks first filled by Strava rows and then a Garmin-path sync that returns strava-1/strava-2 plus numeric 15500000001/15500000002 at identical start_time. Past week: Signal B went 60 -> 115. The current-week numeric twin was queued as pending. Left unreviewed, it was auto-logged as adhoc when s.w advanced, and that week went 60 -> 112 in both Signal A and Signal B. Daily Signal B for the session day also doubles (computeTodaySignalBTSS 52 -> 107), so the 7d/28d rolling ACWR reads a spike. The plan then cuts intensity, while CTL, ATL and the weekly load bars all show about 2x for the last 4 weeks. The server's history mode still collapses these rows within 2 minutes (sync-strava-activities/index.ts:461-477), so ctlBaseline/historicWeeklyTSS stay single and disagree with the plan-week numbers.

**Reachable in practice:** Yes, in a real user flow, but it needs a deliberate action.

Preconditions:
- The user onboarded with watchType 'garmin'. Every such user also has Strava, because the wizard blocks Continue without it.
- Garmin OAuth is actually connected, so the webhook is writing numeric activity rows and isGarminConnected() returns true.

Trigger: the user taps the red "Remove" on the Strava row in Account. After that, the next app launch, the Account Garmin "Sync" or the Home "Sync" runs syncActivities(). It re-ingests the numeric twin of every Garmin-recorded session from the last 28 days that falls inside the plan dates.

Not affected:
- Sessions recorded on another device (no webhook twin).
- Anything older than 28 days.
- Users who never completed Garmin OAuth.

The same mechanism should also hit the reverse flow: removing Strava, then reconnecting it, ingests strava- twins of sessions logged during the Garmin-only gap. I inferred this from the code and did not probe it.

**Impact:** Every twinned session in the last 28 days counts about twice (the twin's TSS is not identical because its iTRIMP is estimated from average HR). This affects:
- plan-week Signal A and Signal B loads and the weekly load bars;
- daily Signal B (strain);
- CTL and ATL.

Probe numbers:
- A past week went from 113 to 221 Signal B.
- A session day went from 60 to 118 daily Signal B.
- The current week went from 60 to 110 once its unreviewed twin auto-logged at week advance.

Because ATL (7-day time constant) reacts faster than CTL (42-day), TSB drops, so the app reads more fatigue than is real.

The 7d/28d rolling ACWR is mostly unchanged at the moment of ingestion, because both windows are doubled. It spikes only if the plan is under about 4 weeks old (seed-filled days are not doubled) or once pending current-week twins are logged. After that it drifts low for up to 4 weeks as single-counted days replace doubled ones.

Two side effects:
- A twin run can also auto-complete a different unrated planned run on the same or an adjacent day, falsely marking it done (activity-matcher.ts:747-761).
- The Strava history baseline (ctlBaseline) is not refreshed after removal (main.ts:487 requires stravaConnected), so the server-side single-counted history disagrees with the doubled plan-week numbers.

Removing a duplicate with × is undone at the next sync.

### C3. Connecting Strava as a Garmin-only user re-ingests the last 28 days as strava- copies (and the OAuth boot runs both syncs)

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/ui/account-view.ts:204,335-352,1096-1118; src/main.ts:143,366-380,384,397,450-457; src/data/stravaSync.ts:27-38,52; src/calculations/activity-matcher.ts:422-429,605,681-713,714-742,756-758,865-873

**What the code does (verifier wording):** When a user whose plan weeks already hold numeric Garmin-webhook activities connects Strava, the first Strava sync ingests Strava's copy of every activity from the last 28 days as a new activity. Nothing on the client or in the edge function de-duplicates by start_time. The matcher and all TSS functions de-duplicate by garmin_id only, and 'strava-{id}' never equals the numeric Garmin id. Past-week copies become adhoc entries. Past-week cross-training copies also get a garminActuals entry. Current-week copies go to garminPending and the Activity Review. Load for those weeks roughly doubles. The OAuth boot also runs both syncs: the stale `state` makes launchApp take the Garmin-only branch, and the setTimeout starts syncStravaActivities 500 ms later.

Reachability is narrower than "any Garmin user". The onboarding wizard makes Strava mandatory, so only two groups hit this: legacy users who onboarded before Strava was required, and users who pressed Remove on the Strava row. For Remove users the problem starts before reconnecting. The next boot takes the Garmin-only path, and sync-activities returns every garmin_activities row with no source filter. The numeric Garmin copies of activities already ingested as strava-{id} are therefore not in globalProcessed and get ingested a second time. Reconnecting then duplicates, in the other direction, the sessions recorded while disconnected.

**Scenario:** Probe (deleted): a week-2 easy run (48 min, avg HR 150) was ingested as Garmin 15512345678 and matched 'Easy Run', giving Signal A = Signal B = 52. The next call with strava-99887766 at the same start_time logged garmin-strava-99887766 as adhoc, raising Signal A and B to 107 and that day's Signal B to 107. A current-week copy was queued as pending (r.pending=['strava-55554444']). A Garmin-only user who taps Connect therefore sees about 2x load for up to 4 plan weeks, an inflated rolling ACWR, and a review queue full of runs they already completed.

**Reachable in practice:** Yes, but only for users without an active Strava connection who have Garmin webhook activity rows. The first group is legacy Garmin-only users who onboarded before the wizard made Strava mandatory. They see 'Not connected. Add for accurate load' with a Connect button, tap it, return with ?strava=connected, and the 500 ms syncStravaActivities ingests the duplicates. The second group is any Strava+Garmin user who taps Remove on the Strava row. The next launch, or the 'Sync' button (account-view.ts:952-956, main-view.ts:2683-2691), takes the Garmin path, and sync-activities returns numeric rows for activities already ingested as strava-*, so they are duplicated in the reverse direction. Tapping Connect again duplicates, via strava- copies, the sessions logged while disconnected. New users who onboard today cannot be Garmin-only, because the wizard blocks Continue until Strava is connected.

**Impact:** Every activity from the 28-day window, capped at the 50 Strava activities per page, is counted twice in Signal A and Signal B for the plan weeks it falls in. That is typically 4 to 5 plan weeks. In the probe, week-2 load went from 104 to 212 TSS, then settled at 209 after the enrich pass gave the adhoc copy its iTRIMP. Past-week run copies at first carry no iTrimp: addAdhocWorkout (:1013-1053) does not copy it, so they count at duration × TL_PER_MIN[rpe] until the next sync. The inflated Signal B raises the ATL, 7d/28d rolling ACWR and today's Signal B when the copy is dated today. CTL (Signal A) is also inflated for those weeks. Each current-week run the user already completed and matched shows up again in Activity Review (isBatchSync sends runs there), with its planned slot already rated. Either the user dismisses it manually or accepts it as a duplicate adhoc.

### C4. Two Strava uploads of one session (two devices/apps) are both counted in plan weeks, though history mode treats them as one

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/calculations/activity-matcher.ts:605,613-622,681-713,865-873; supabase/functions/sync-strava-activities/index.ts:461-477,971-974,1062-1255; src/calculations/fitness-model.ts:416-425

**What the code does (verifier wording):** The claim holds, with two corrections. First, the "about 2x" only applies to a week where every session is doubled. In general, each duplicated session adds its own TSS a second time. Second, the problem is not only in past weeks. In the current week both copies are queued for review, and every review choice still adds load: "Integrate" does, and so does "Log Only", which creates an adhoc entry. The core claim is right. The server's history mode folds rows that start within 2 minutes of each other into one activity. Standalone mode returns every Strava activity unfiltered. The client matcher, computeWeekRawTSS, computeTodaySignalBTSS and computeWeekTSS only dedupe by garminId. So two Strava IDs for one session are both counted in plan weeks, and the history-derived numbers (historicWeekly*TSS, ctlBaseline, signalBBaseline) count it once. The user cannot fix this durably by hand. Removing the adhoc copy deletes its garminMatched key, so the next sync (28-day window) imports it again.

**Scenario:** Probe (deleted): strava-7001 and strava-7002, two 60-min rides starting 5 s apart with iTRIMP 7000/6800, were fed in one call. Both were logged as adhoc, and week Signal B was 92 against 46-47 for one copy. History mode would count that week once, so plan-week CTL/ATL and ACWR read about 2x relative to the ctlBaseline built from the same Strava data.

**Reachable in practice:** Yes, in the normal Strava flow. syncStravaActivities (standalone mode) runs at startup (main.ts:378, :402), on the main-view refresh (main-view.ts:2685) and on manual sync (account-view.ts:1148, :1167). It covers the last 28 days, and Strava is always the activity source when connected (stravaSync.ts header).

The trigger is Strava holding two activities, with two IDs, for one session. Examples are Zwift or Peloton plus a watch or bike computer, or a watch plus a phone app, each auto-uploading. That depends on Strava's own duplicate detection not catching them. I could not check Strava's behaviour from the code. It is commonly reported for recordings from two different devices. When it happens, no code path on the client collapses the pair.

- Past-week activities are logged automatically as adhoc, with no user interaction.
- Current-week activities show up twice in Activity Review. Both review choices add load.
- The × removal only holds until the next sync inside the 28-day window.

**Impact:** Each duplicated session adds its full TSS a second time to that plan week's Signal B (ATL, the 7-day acute window of the rolling ACWR, strain). If it is a run, or a past-week cross-training activity (because of the garminActuals path), it also adds to Signal A (CTL).

Probe numbers:
- One duplicated 60-minute ride: week Signal B went from 47 to 92.
- One duplicated ride plus one duplicated run: week Signal B went from about 99 to 195-213. That is about 2x only because every session in that week was duplicated.
- In computeFitnessModel with seed 100, the week-2 ATL came out at 148 where the deduplicated input would give roughly 100.

The same weeks are then reported differently on the history side:
- The stats chart uses deduplicated historicWeeklyRawTSS for completed weeks (stats-view.ts:236-240) and the doubled computeWeekRawTSS for the current week (:232).
- ctlBaseline and signalBBaseline come from deduplicated data. Those baselines then feed getWeeklyExcess (fitness-model.ts:699-707) and the pre-plan fill of the rolling ACWR (fitness-model.ts:940, 958).

Effect on the user: inflated ACWR, excess-load flags and TSB, which can trigger reduce-load advice when training was actually normal. The size scales with how often the user double-records. For a habitual Zwift-plus-watch cyclist, every ride would be doubled.

### C5. Activities are keyed by UTC start_date, but plan weeks advance, weekdays are read and 'today' is expected in local time, so near-midnight sessions land in the wrong plan week or day and can rate the wrong week's slot

- **Finder severity:** medium
- **Verifier votes:** confirmed, partially_confirmed, confirmed
- **Code:** supabase/functions/sync-strava-activities/index.ts:851, :898, :1065, :1238 (start_time = start_date, UTC; start_date_local is never read); src/calculations/activity-matcher.ts:366-377 (weekIndexForDate uses getUTC* day) vs :118-121 and :751 (dayOfWeekFromDate uses local getDay()), :614-621, :756-762 (run auto-match does not check past/current/future week), :767; src/state/persistence.ts:141-147 (plan weeks anchored to UTC Monday); src/calculations/matching.ts:76-89 (same-day +3 score); src/ui/welcome-back.ts:30-47, :152-160 (s.w advances at local midnight); daily keying: src/calculations/fitness-model.ts:503-508, :531, :945-951, :1004-1010, :1027, :1052 (startTime.startsWith(dateStr) with dateStr = toISOString() date); src/ui/home-view.ts:727 (today = toISOString date)

**What the code does (verifier wording):** Strava activities keep only the UTC start_date, and the code never reads start_date_local. The matcher then picks the plan week from the UTC calendar date (weekIndexForDate, getUTC*) but matches the workout slot on the local weekday (getDay). The result: for users west of UTC, a Sunday-evening session goes into the next plan week. For users east of UTC, a Monday-morning session goes into the previous week. There it can be auto-rated against that week's slot for the same local weekday: nothing in the run auto-match branch checks whether the week is past, current or future. That session's load is then counted in the wrong week's Signal A and B. The daily paths (today's strain, rolling 7d/28d, getDailyLoadHistory, the recent-days list in fitness-model) bucket activities by the prefix of the UTC ISO string, and 'today' is itself new Date().toISOString() (a UTC date). So the day boundary is UTC midnight. One detail in the claim is wrong: s.w does not advance simply at local midnight. It only advances once the 'complete' debrief is done (welcome-back.ts:103-110, main.ts:173-175), and that debrief is offered on Sunday (plan-view.ts:2716-2719, 2879-2881). This does not change the defect, because the week an activity lands in never depends on s.w. s.w only decides the past, current or future branch.

**Scenario:** Probe TZ=America/Los_Angeles, current week 2: a Sunday 18:00 local long run (Monday 01:00Z) was assigned to week 3 and rated 'W3-long-0' before that week started; this week's long run shows as missed and computeWeekTSS(N) lacks it. A New York Sunday 21:00 run (Monday 01:00Z) does the same. A Sunday-evening cross-training session is instead queued __pending__ in a future week and cannot be reviewed until then. Probe TZ=Australia/Sydney: a Monday 07:00 local run (Sunday 21:00Z) went to week 1, auto-matched and rated 'W1-easy-0' (last week's Monday easy run), leaving this week's Monday slot unrated; any Monday activity before 10:00 is affected. Probe LA: a 19:30 local run (02:30Z next day) gives today's strain 0 and lands on the next day in the acute window. UK users hit this only for 00:00 to 01:00 BST activities, which is why it rarely shows up in local testing.

**Reachable in practice:** This is the normal Strava flow: app launch or foreground calls syncStravaActivities, then the edge function in standalone mode, then matchAndAutoComplete. No setting or edge case is needed, only a non-UTC device timezone.
- West of UTC: any activity after 17:00 PDT (16:00 PST) or 20:00 EDT (19:00 EST) on Sunday goes into the next plan week. A run that matches the next week's Sunday slot on distance (±30%) is auto-rated there. Other runs and cross-training go to '__pending__' in that week.
- East of UTC: Monday activities before 10:00 AEST (11:00 AEDT) go into the previous week. Monday-morning easy runs are common, and they get auto-rated against last week's Monday slot.
- UK: only 00:00 to 01:00 BST.
- Mid-week near-midnight sessions stay in the right week but shift one day in the daily paths.
- For US users, 'today' (toISOString) flips to tomorrow at 17:00 to 20:00 local, so on every evening today's strain changes day early.
The wrong week and slot happen whatever the value of s.w. If the user has already wrapped up on Sunday (s.w=3), the LA run still rates W3-long-0, a week early.

**Impact:** The whole session moves to the adjacent plan week. For a Sunday-evening long run (usually the biggest session of the week) in LA or NY:
- Week N's long run shows as missed.
- computeWeekTSS and computeWeekRawTSS for week N drop by that session's full TSS. In the probe, W2 went from 13 to 0 and W3 went from 0 to 13.
- Week N+1's long-run slot is already used up before the week starts.
- Week N's debrief, adherence and Signal A/B, and through them CTL, ATL and ACWR, are understated for week N and overstated for week N+1.
For a Sydney Monday-morning run, the previous week's Monday easy slot is rated, the current week's Monday slot stays unrated, and the load moves back one week.
Cross-training that moves into a future week stays '__pending__' and cannot be reviewed until s.w reaches that week.
Daily views put near-midnight sessions on the neighbouring day. In the probe, today's strain for W2 on '2026-09-21' was 0 while s.w=2. The 7-day acute window can gain or lose a session at its edge.
The total load across weeks is conserved: nothing is double-counted or lost. The problem is misplacement by one week or one day.

### C6. Standalone sync fetches a single page of 50 activities with no pagination; for high-volume users the newest activities never reach the plan on time

- **Finder severity:** medium
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** supabase/functions/sync-strava-activities/index.ts:971-974 (per_page=50&after=..., no page loop), compared with backfill which paginates at :656-668; client window src/data/stravaSync.ts:27-38 (28 days); only the standalone rows feed matchAndAutoComplete (stravaSync.ts:52), while backfill/history only write DB and history arrays

**What the code does (verifier wording):** For Strava-connected users, the only path that feeds activities into matchAndAutoComplete is the standalone call. It asks Strava for one page of 50 activities with `after` set to now minus 28 days, and never requests a second page. When `after` is used, Strava returns activities oldest first. So once a user has more than 50 activities in the trailing 28 days, the newest (N − 50) are left off every sync. They are not lost for good. Each one is delayed until it is older than about 28 × (1 − 50/N) days, and it is then filed into the plan week that matches its date. By then it is often a past week, where cross-training goes straight to an adhoc entry with no review step and no plan adjustment. Users with 50 or fewer activities in 28 days are not affected.

**Scenario:** A triathlete, bike commuter, or a user whose watch auto-uploads walks, with N=60 activities in 28 days. The newest 10 (about the last 4.7 days) are omitted on every sync. Each activity only becomes visible once it is older than 28x(1-50/N) days. By then the plan week has usually advanced, so it is logged as a past-week adhoc (activity-matcher.ts:683-713/865-873). Current-week load, ACWR and Strain miss it, and no review or plan adjustment is triggered.

**Reachable in practice:** This is reached on every Strava sync: at app launch (main.ts:397-405), from the Sync button (main-view.ts:2683-2686), from the Account screen (account-view.ts:1148/1167), and right after connecting Strava (main.ts:378). It only triggers when a user has more than 50 Strava activities in 28 days, which is more than about 12.5 per week.
- Who hits it:
  - triathletes
  - bike commuters (10 commutes plus training per week)
  - runners doing double days with strength sessions logged
  - watches that auto-upload walks
- Who does not: a typical marathon plan user with 5 to 7 runs and 1 to 2 gym sessions a week, about 25 to 40 activities per 28 days.
- A Strava webhook would be an alternative path. There is no strava-webhook function under supabase/functions/, so none exists.

**Impact:** Assume activities are spread evenly and the user is in steady state. The most recent 28 × (1 − 50/N) days of activities are missing from state at every sync.
| Activities in 28 days (N) | Newest days missing | Share of the last 7 days visible | Share of the 28-day window in state |
|---|---|---|---|
| 55 | 2.5 | about 64% | 91% |
| 60 | 4.7 | about 33% | 83% |
| 67 or more (about 17 a week or more) | 7 or more | none | 50/N |
| 100 | 14 | none | 50% |
- Because the acute window is under-counted much more than the chronic one, ACWR is biased low. It would not flag a real spike.
- Today's strain never includes today's activity for any N above 50.
- Take a Mon to Sun week with N = 60. Any activity from roughly Wednesday afternoon onwards only shows up after the week has rolled over. It is then logged as a past-week adhoc, so the reduce/replace/keep review never fires and the current week is never adjusted for it.
- Activities are eventually written into their correct week, so historical week totals and the long-run CTL catch up. The damage is to the real-time numbers and decisions: acute load, ACWR, strain, and adjustments to the current week.

### C7. Strava sport identity collapses to appType buckets before load sizing: unplanned runs fall back to runSpec 0.35, rowing/kayak/hiking are costed as walking, and soccer/yoga/tennis/elliptical/skiing as generic_sport

- **Finder severity:** medium
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** supabase/functions/sync-strava-activities/index.ts:229-275 (:239, :244, :254; emits ROWING, KAYAKING, PADDLEBOARDING, WALKING for Hike/Snowshoe, NORDIC/BACKCOUNTRY/ALPINE_SKIING, YOGA, SOCCER, RUGBY, BOXING); src/calculations/activity-matcher.ts:40-111 (mapGarminType; :56-84, :100-113 ROWING/KAYAKING/PADDLEBOARDING/GOLF/WALKING -> 'walk', sports and skiing -> 'other'), :998-1007 (mapAppTypeToSport: 'run' passes through, walk->walking, other->generic_sport); src/ui/activity-review.ts:720 (UnspentLoadItem.sport), :1253-1256, :1289-1295 (crossTL runSpec), :1618-1620, :1866, :1929 (combinedActivity.sport); src/ui/excess-load-card.ts:284, :329 and src/ui/main-view.ts:2216, :2229 ('cross_training', 'running'); src/constants/sports.ts:47-48, :55-57, :60, :64, :69, :71, :271-374 (no 'run', 'running' or 'cross_training' key or alias); src/cross-training/universalLoad.ts:79-87 (fallback); src/cross-training/universal-load-constants.ts:126

**What the code does (verifier wording):** The mechanism is real. The Strava-to-plan-adjustment path does not pass the actual sport to the cross-training engine. It passes mapAppTypeToSport(appType), so:
- ROWING, KAYAKING and PADDLEBOARDING become 'walking'.
- Yoga, Pilates, tennis, soccer, rugby, boxing, climbing, INDOOR_CARDIO (which is where Strava's elliptical lands) and all three ski types become 'generic_sport'.
- An unmatched current-week run becomes 'run', which is neither a SPORTS_DB key nor an alias. It therefore gets the fallback values: mult 1.0, runSpec 0.35, recoveryMult 1.0, active fraction 0.75.

Signal A's adhoc loop resolves the sport from the display name instead, so the two paths disagree for rowing (0.35 vs 0.30), yoga (0.10 vs 0.40), tennis (0.50 vs 0.40), rock climbing (0.15 vs 0.40) and boxing (0.25 vs 0.40). The claimed Tier C FCL/RRC numbers reproduce exactly.

Three corrections to the report:
1. **Long-run replacement is wrong.** Losing noReplace ['long'] cannot cause a long run to be proposed for replacement. The suggester already blocks 'long' in canReplaceWorkout and also filters it out of both replace pools unconditionally.
2. **Hikes and snowshoes are mis-attributed.** They collapse to WALKING in the edge function, not in mapGarminType. Signal A also sees 'Walk', so the two paths do not disagree for hikes.
3. **The size of the plan change is overstated for HR-equipped activities, which is the normal Strava case.** These go through Tier A+ using raw iTRIMP times mult. RRC saturates and equivalentEasyKm is capped at 25, so in the probe the proposed plan changes were identical for rowing vs walking, soccer vs generic_sport and run vs extra_run. The large differences only matter for activities with no HR at all (Tier C).

**Scenario:** Probes (Tier C). A 45 min RPE 6 session as rowing gives FCL 74.6 and RRC 51.6; mapped to walking, FCL 25.9 and RRC 18.4 (-65%), so a hard erg or kayak session barely adjusts the plan. Soccer gives FCL 110.2; as generic_sport, 65.6 (-40%), and soccer/rugby/boxing lose noReplace ['long'], so a match can be proposed as a long-run replacement. A 60-min yoga class at RPE 3 as generic_sport gives FCL 35.6 and RRC 27.5, versus 9 and 2.1 as yoga (13x more credit). A 3-h hike at RPE 4 as walking gives FCL 61 and RRC 44, versus 149 and 131 as hiking. An unmatched 60-min run at RPE 4 overflowing in autoProcessActivities (activity-review.ts:1618-1620) as 'run' gets RRC 38.8 (3.2 km equivalent), versus 142.5 (11.9 km) as extra_run.

**Reachable in practice:** **The path is reached in normal use.** Strava sync goes stravaSync.ts:52 → matchAndAutoComplete, which queues current-week cross-training and unmatched runs. From there, activitySync.ts:158/164/204 sends them to showActivityReview or autoProcessActivities. Overflow goes to populateUnspentLoadItems, and from there either:
- the excess-load card or the ACWR "Adjust week" flow, or
- buildCombinedActivity, which opens the reduce/replace modal when ACWR is caution/high or on forceModal from openAdjustWeekModal.

**How much the sport matters depends on the data tier.** The edge function stores iTRIMP only when there is HR (stream or average). With no HR it stores null (index.ts:1138-1164, :1222), and there is no per-sport-rate fallback in this path.
- **Tier C, where the full error applies:** Strava activities with no HR at all, such as rowing erg or yoga without a strap, or manual entries.
- **HR-equipped activities, the normal case:** computeUniversalLoad takes Tier A+ with raw iTRIMP times mult (universalLoad.ts:98-120, :251-262). This saturates RRC and pins equivalentEasyKm at 25, so the sport mismatch mostly washes out of the proposed adjustments. It still changes:
  - FCL, via mult × recoveryMult
  - wk.actualTSS cross-training credit via runSpec (activity-review.ts:1289-1295): yoga ×0.40 instead of ×0.10
  - recordLegLoad: rowing 0.35/min becomes walking 0.05/min; soccer 0.15/min becomes 0 because generic_sport has no legLoadPerMin
  - the intermittent-sport classifier branch (universalLoad.ts:550) for soccer, rugby and boxing
  - Signal A's unspent-item runSpec (fitness-model.ts:388-391)

**Unmatched runs** reach the 'run' fallback only when a current-week run fails both matchAndAutoComplete's high-confidence match and autoProcessActivities' findMatchingWorkout, for example an extra run once all planned runs are already rated.

**Long-run replacement is unreachable** by construction.

**Impact:** **No-HR (Tier C) activities, where the claim holds numerically:**

| Case | Correct sport | Collapsed sport | Change |
|---|---|---|---|
| 45 min RPE 6 row | FCL 74.6, RRC 51.6 | FCL 25.9, RRC 18.4 | -65% |
| 45 min soccer | FCL 110.2 | FCL 65.6 | -40% |
| 60 min yoga RPE 3 | RRC 2.1 | RRC 27.5 | about 13x more credit |
| 3 h hike | FCL 148.8 | FCL 61.3 | -59% |
| 60 min unmatched run | 11.9 km equivalent | 3.2 km equivalent | -73% |

In the proposed plan change for a four-run week, this showed up as:
- A rowing session trimming an 8 km easy run to 6 km instead of 4.8 km.
- Yoga-as-generic trimming an easy run by 3 km instead of downgrading a threshold session.
- An unmatched run offering a 4 km reduction instead of a full replacement.

**HR-equipped Strava activities (the common case):** the proposed adjustments were identical in the probe for rowing vs walking, soccer vs generic and run vs extra_run, because raw-iTRIMP Tier A+ saturates RRC and caps equivalentEasyKm at 25. The residual effects are on recorded load bookkeeping rather than the plan change: actualTSS runSpec (yoga credited 4x too much), leg-load tracking (rowing 7x too low, soccer zero), and Signal A unspent-item runSpec.

**The "match proposed as a long-run replacement" consequence has no impact.** It is refuted by suggester.ts:315 and :731/:734.

### C8. The edge function computes iTRIMP with resting HR from the newest daily_metrics row or a hard 55, ignoring the athlete's known RHR that the client uses everywhere else

- **Finder severity:** low
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** supabase/functions/sync-strava-activities/index.ts:720-734 and :985-1002 (latest row, no resting_hr IS NOT NULL filter, default 55); client never sends it: src/data/stravaSync.ts:31-37 and :551-554 (only biological_sex and max_hr_override); Apple RHR lives only in state: src/data/appleHealthSync.ts:305; the normaliser and client fallback use s.restingHR: src/main.ts:393/411/428/467, src/calculations/fitness-model.ts:265-291, src/calculations/activity-matcher.ts:385-396; a daily_metrics row can exist without resting_hr: supabase/functions/garmin-webhook/index.ts:356-364 (handleHrv writes only hrv_rmssd)

**What the code does (verifier wording):** The core defect is real. sync-strava-activities computes every new activity's iTRIMP with the resting HR from the newest daily_metrics row. It does not filter for a non-null resting_hr and falls back to a hard-coded 55. The client never sends the athlete's resting HR, so s.restingHR (from onboarding, manual entry in Account, Apple HealthKit or Garmin) is ignored for all Strava-sourced iTRIMP.

- **Strava-only and Strava + Apple Watch users:** the edge always uses 55, unless stale Garmin rows are left over from an earlier Garmin connection.
- **Strava + Garmin users:** the edge uses Garmin's daily RHR. It falls back to 55 only when the newest daily_metrics row has resting_hr null. physiologySync keeps the previous value in that case.

The claim's mechanism ("two RHR bases", with the iTRIMP at RHR 55 divided by a normaliser built on s.restingHR) is overstated.
- The per-athlete normaliser needs s.ltHR. s.ltHR is set only from Garmin physiology_snapshots. So Strava-only and Strava + Apple users always get the fixed 15000 normaliser, which does not use RHR at all.
- The client's avg-HR fallback (resolveITrimp) uses s.restingHR only when the edge returned iTrimp null. That happens only when there is no HR or the computed iTRIMP is 0 or less. It is rarely hit for Strava rows.

The accurate statement: Strava iTRIMP uses RHR 55 instead of the athlete's known RHR. For Strava-only and Apple users this biases the iTRIMP numerator over the fixed 15000 normaliser. A true numerator/normaliser mismatch occurs only for Strava + Garmin users with an LTHR, during the window when the newest daily_metrics row lacks resting_hr. The iTRIMP stored at first sync is then cached permanently.

**Scenario:** Probe (since deleted), athlete with RHR 45, LTHR 170, max 190. One hour at HR 130 scores 40.0 TSS when computed consistently, but 35.8 as the edge's RHR-55 iTRIMP over the client's RHR-45 normaliser (-10.5%). At HR 145: -7.6%. At LTHR: -3%. Easy-heavy weeks are understated by roughly 8 to 10%, which feeds CTL, ACWR, Strain and the history baselines. Users with RHR above 55 are overstated.

**Reachable in practice:** Yes, with a split by user type.

1. **Strava-only users:** hit on every sync of every new HR-bearing activity (standalone sync at app launch and after connecting, plus backfill). RHR is always 55, whatever they entered in onboarding or Account. The normaliser is 15000, so there is no numerator/normaliser mismatch. The bias is purely the wrong RHR in the Banister numerator. If they entered no RHR, the client default is also 55 (activity-matcher.ts:228) and nothing is inconsistent.
2. **Strava + Apple Watch physiology users (main.ts:396-412):** the same as Strava-only. HealthKit RHR lands in s.restingHR but never reaches the edge. The normaliser is still 15000, because Apple provides no LTHR.
3. **Strava + Garmin users:** normally consistent, because the edge and physiologySync read the same Garmin daily RHR. The divergence the claim describes (edge 55, normaliser at the real RHR with Garmin LTHR) happens only if a new activity is first synced while the newest daily_metrics row has resting_hr null. That can happen when HRV is pushed before dailies for a new date, or when a dailies or backfill upsert carries a null RHR. The code cannot show how often this happens, since it depends on Garmin push ordering. It is a race window, not the steady state.
4. **Garmin-only and Apple-only (no Strava) users** never call this edge function. Their iTRIMP is computed client-side with s.restingHR, so they are unaffected.

**Impact:** For an athlete whose true RHR is 45 bpm (max 190), per-session iTRIMP-derived TSS from Strava comes out lower than a Banister computation with their real RHR:
- about -10.6% for easy running at HR 130
- about -7.5% at HR 145
- about -4.8% at HR 160
- about -3% at threshold

For an athlete with RHR 65 it is overstated by +14.4%, +9.6%, +5.9% and +3.7% at the same HRs. The error scales with the gap between the true RHR and 55 and is largest for easy sessions. Easy-dominated weeks for low-RHR runners are therefore understated by roughly 8 to 10%, and high-RHR runners are overstated by roughly 10 to 14%. The bias flows into Signal A and Signal B weekly TSS, CTL, ATL, ACWR and the history baselines (history mode divides the stored iTRIMP by 15000).

These percentages are the same whether the normaliser is 15000 or LTHR-based. The reported -10.5% is numerically right, but its framing as a numerator/normaliser mismatch applies only to the Garmin race-window case. For Strava-only and Strava + Apple users, the correct framing is that the known RHR is ignored in the iTRIMP numerator over a population-constant normaliser. That normaliser's own calibration is approximate (docs/SCIENCE_LOG.md:1537), so the "true" absolute TSS is itself uncertain.

Because iTRIMP is cached at first sync (index.ts:1097-1101), fixing the RHR input will not correct past activities unless they are recomputed.

A separate, smaller inconsistency not in the claim: the normaliser always uses beta 1.92 (fitness-model.ts:270), while the edge uses 1.67 for female athletes.

### C9. The edge function computes time-in-zone as %maxHR (60/70/80/90), but the app's zones are LTHR/Karvonen based, so easy cross-training is classified 'threshold'

- **Finder severity:** low
- **Verifier votes:** partially_confirmed, partially_confirmed, confirmed
- **Code:** supabase/functions/sync-strava-activities/index.ts:79-97 (pct = hr/maxHR), stored as hr_zones at :862/:1223; client zones src/calculations/heart-rate.ts:42-75 (LTHR: Z2 = 80-89% LTHR); consumers src/cross-training/universalLoad.ts:505-528 and :555-576 (zones decide type when Z4+Z5 <= 15%), suggester.ts:962-975 (classification drives candidate ranking); history zone split index.ts:517-528; daily zone load fitness-model.ts:1076-1085

**What the code does (verifier wording):** The core defect holds, and a probe reproduced it end to end. The edge function sorts HR samples into zones by fixed %maxHR bands (60/70/80/90). classifyByZones then calls any session with more than 40% of its time in the 70 to 80% maxHR band (Z3) 'threshold'. That band is Z2 under the app's own LTHR zones and under its Karvonen zones. It is also Z3 'Tempo' on the app's activity detail screen and 'Aerobic' in Garmin's scheme. So steady, non-intermittent cross-training of 20 minutes or more at easy aerobic HR is classified 'threshold'. The same ride is classified 'easy' when it goes through the iTRIMP path. When the activity reaches the suggester with hrZones attached, the +0.20 same-zone bonus goes to threshold and marathon-pace runs, so those quality sessions are downgraded before easy runs are cut. Z3 is also counted as 'threshold' in the Home load chart zone bars (main-view updateLoadChart) and in the week-end carriedTSS split, and as 'High Aerobic' in the rolling-load zone balance. Three parts of the original claim are wrong. (a) The history-mode zone split (index.ts:517-528) never reaches a visible chart. stats-view getChartData builds `zones` but no caller reads them, and historicWeeklyZones is only used by main-view Rule 4, which looks at Z4+Z5 only. (b) The bars that show the ride as threshold are the Home/main-view load bars, not a Stats chart. (c) A spike-inflated maxHR raises the %max bands, which reduces this particular bias. An underestimated maxHR, or zones cached from an earlier low maxHR, makes it worse.

**Scenario:** A 60 min steady ride at 140 to 150 bpm (easy by the user's LTHR zones) with less than 15% above 152 bpm gives threshRatio above 0.4, so it is classified 'threshold'. buildCandidates then preferentially targets the week's threshold/tempo run for reduction instead of an easy run. The Stats zone bars show the ride as threshold load.

**Reachable in practice:** Yes, for Strava users whose activity came through stream processing (hrZones stored). The classification path is hit when the cross-training modal is built from pending items by activity-review buildCombinedActivity (activity-review.ts:1945-1953 aggregates hrZones). That happens in three flows:
(1) Batch sync: activitySync.ts:157 showActivityReview, then applyReview, then buildCrossTrainingPopup at activity-review.ts:1222. The modal is always shown for overflow cross-training.
(2) Flowing-week auto-process (activitySync.ts:164, autoProcessActivities): the modal at activity-review.ts:1845 appears only when ACWR is caution or high (:1822-1831).
(3) The 'Adjust week' button (activitySync.ts:204, forceModal=true).
The Home ACWR reduction (main-view.ts:2233-2312), excess-load-card (:290-370) and manual logging in events.ts do not attach hrZones. They fall back to iTRIMP, which classifies the same ride 'easy', so targeting depends on which entry point opened the modal. The zone-bar and carry misbucketing affect every stream-processed activity, runs included, not only cross-training. The suggestion-modal header classification (suggestion-modal.ts:249) is dead code, because no caller passes crossTrainingCtx.

**Impact:** With maxHR 190, edge Z3 is 133 to 152 bpm, while the app's LTHR-170 Z2 is 136 to 151 and its Karvonen (rest 55) Z2 is 136 to 150. A typical LTHR of about 0.9 x maxHR shifts the edge scheme down one zone. Any steady ride, swim or row of 20 minutes or more that spends more than 40% of its time in that band and at most 15% above 152 bpm is labelled 'threshold' instead of 'easy'.
In the probe the reduce plan changed from cutting two easy runs (-6.4 km) and the long run (-5 km) to downgrading MP Fri (12 km, to easy) and Threshold Tue (10 km, to MP), and cutting one easy run. The workout type the user sees on screen changes; the load budget (RRC) does not.
On the Home load bars, 100% of such a ride's TSS (about 58 TSS for a 60 min ride at 140-150 bpm) goes to Threshold instead of Base. In the rolling-load view the same TSS counts as High Aerobic, which pushes the diagnosis toward 'High Aer. Surplus' or 'Low Aer. Shortage'.
Easy runs at LTHR-Z2 HR are misbucketed on the Home bars the same way.
The history-mode zone split has no visible effect.

### C10. Garmin run subtypes (and road/gravel cycling, machine cardio) fall through mapGarminType to 'other', so a run is handled as cross-training and never completes its plan slot

- **Finder severity:** medium
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/calculations/activity-matcher.ts:40-111 (switch lists only RUNNING, TREADMILL_RUNNING, TRAIL_RUNNING, VIRTUAL_RUN, TRACK_RUNNING; default 108-109 returns 'other'); activity-matcher.ts:680-741 (non-run is queued as pending, or logged as 'cross' adhoc in a past week); src/calculations/matching.ts:52-63,148 ('other' only matches w.t==='cross' by name, min score 5); src/ui/activity-review.ts:130-132 (defaults to 'log' when there is no match), 1701-1739 (fills a generic cross slot or goes to overflow), 1754 plus 708-731 (unspentLoadItems sport = mapAppTypeToSport('other') = 'generic_sport', activity-matcher.ts:998-1004), 1776-1800 (Tier-1 silent easy-run cut); src/ui/plan-view.ts:2012-2023 (km bar run-type set also omits these) vs src/ui/stats-view.ts:215-223 (counts any type containing 'RUN'); src/data/appleHealthSync.ts:79,81 (emits ELLIPTICAL and STAIR_CLIMBING, neither in the switch); supabase/functions/garmin-webhook/index.ts:47-67 (no handler for manually-updated activities, so a type fixed later in Garmin Connect never reaches the app)

**What the code does (verifier wording):** The mapping gap is real, and a probe reproduces it. mapGarminType treats only RUNNING, TREADMILL_RUNNING, TRAIL_RUNNING, VIRTUAL_RUN and TRACK_RUNNING as runs. ULTRA_RUN, STREET_RUNNING, INDOOR_RUNNING and OBSTACLE_RUN all return 'other'. A run with one of these types is queued as cross-training. It cannot auto-match a run slot, and the manual matching screen cannot assign it to one either. So the planned run stays unrated. The overflow is sized as generic_sport.

Three parts of the report are overstated.

1. Reach is narrow. Only raw Garmin-webhook rows (the sync-activities path) can carry these strings, and that path runs only when state.stravaConnected is falsy. Strava rows are always normalised to 'RUNNING' before they reach the client, so no Strava user is affected.

2. The machine-cardio part is not a behavioural defect. ELLIPTICAL, STAIR_CLIMBING and INDOOR_ROWING fall to 'other', which is the same bucket as the explicitly listed INDOOR_CARDIO. So appleHealthSync emitting ELLIPTICAL and STAIR_CLIMBING does not show that the gap causes harm. Road, gravel and cyclocross cycling going to 'other' instead of 'ride' has only minor effects: sport generic_sport (runSpec 0.40) instead of cycling (runSpec 0.55), and a different integrate default.

3. "Sized as generic_sport (runSpec 0.40)" applies only to the unspentLoadItems copy. The garminActuals copy is counted in Signal A at full iTRIMP with no discount, and the unspent copy is then added on top.

**Scenario:** Reach: this path runs only for users whose activities come from the Garmin webhook. Onboarding requires Strava (src/ui/wizard/steps/fitness.ts:26-31,129-131), and main.ts:397 routes any stravaConnected user to Strava. The Garmin path in main.ts:450-455, main-view.ts:2692 and account-view.ts:956 is therefore reached after Account > Disconnect Strava (account-view.ts:1120-1136) or on legacy pre-Strava state. Example: the user records a 22 km long run with the watch's Ultra Run profile (activityType ULTRA_RUN) on the long-run day. The row is queued with appType 'other'. autoProcessActivities finds no name-matched cross slot, so the run fills a generic cross slot or becomes overflow. Overflow adds an unspentLoadItem (generic_sport) plus an adhoc 'cross' entry. The planned long run stays unrated and shows as not done, and the plan km bar shows 0 of 22 km. The session is also counted as surplus cross-training load, so Tier-1 silently shortens the next easy run, or the excess card proposes cuts. In a past week, the run is logged as 'cross' adhoc and the long-run slot stays missed.

**Reachable in practice:** Narrow. The raw-Garmin path (syncActivities, which calls sync-activities) is called only when state.stravaConnected is falsy:
- main.ts:397 versus the else branch at 450-455, which is also gated on isGarminConnected()
- main-view.ts:2683-2692
- account-view.ts:952-956
- sources.ts:22-23: Strava always wins when connected

Onboarding cannot finish without Strava. fitness.ts:30 and 129-131 disable Continue until Strava connects, and :231 sets stravaConnected.

The users who reach this path are:
- a Garmin-physiology user who later taps Account > Disconnect Strava (account-view.ts:1121-1136). Their wearable stays 'garmin', so getActivitySource returns 'garmin'.
- legacy accounts from before Strava was required, with wearable 'garmin'.

A revoked Strava token does not trigger a fallback, because main.ts:399-400 just returns.

Within that group, the bug fires only when the watch profile records a subtype. Examples: the Ultra Run app gives ULTRA_RUN, and a Road Bike profile gives ROAD_BIKING. The default Run and Treadmill profiles record RUNNING and TREADMILL_RUNNING, which map correctly.

The Apple path (appleHealthSync.ts:106) has the same gating. Its only defaulted types, ELLIPTICAL and STAIR_CLIMBING, behave exactly as if they were listed explicitly.

Strava users, the default population, cannot hit this path.

**Impact:** For an affected user who records a 22 km long run as ULTRA_RUN, STREET_RUNNING, INDOOR_RUNNING or OBSTACLE_RUN:

- **Plan slot:** the long-run slot stays unrated (probe: rated {}), so the week shows it as not done. There is no RPE prompt, no hrEffortScore and no paceAdherence.
- **Km bar:** the plan-view Running bar adds 0 km for it. The stats-view weekly km chart adds 22 km in the overflow and past-week paths.
- **Current-week load:** the run either fills a generic cross slot (counted once at full iTRIMP, the same load as a RUNNING match, but in the wrong slot) or becomes overflow. On overflow:
  - the unspent copy adds 132 min x 1.15 x 0.40, about 61 TSS, to Signal A on top of the full-iTRIMP garminActuals copy.
  - the excess engine sees a 132-min generic_sport item.
- **Tier-1 easy-run cut:** this fires only if 0 < weekly excess <= 15 TSS (activity-review.ts:1779). A 2 h+ session will usually exceed that, so the likely outcome is the ACWR-gated modal or a silent pending adjust-week item rather than the cut.
- **Past week:** the run is logged as a 'cross' adhoc, and the long run stays missed.

For ELLIPTICAL, INDOOR_ROWING and STAIR_CLIMBING the practical impact is nil versus the intended 'other' bucket. For ROAD_BIKING, GRAVEL_CYCLING and CYCLOCROSS the only effect is the unspent sport sizing, runSpec 0.40 instead of 0.55: a 90 min ride has its unspent load item sized at about 41 TSS instead of 57. Both still fill only cross slots.

Side finding, out of scope and affecting Strava users too: every overflow cross-training item is double-counted in Signal A (computeWeekTSS, fitness-model.ts:382-392, has no garminId dedup). Its garminActuals copy is also counted undiscounted. Probe: Signal A = 138 against Signal B = 100 for a single 60-min ride; about 55 was expected. This inflates CTL and is worth its own verification pass.

### C11. Garmin multisport parent and child summaries are all ingested, so a brick or multisport session is counted about twice

- **Finder severity:** medium
- **Verifier votes:** partially_confirmed, confirmed, confirmed
- **Code:** supabase/functions/garmin-webhook/index.ts:127-166 (every item in body.activities is upserted by activityId; isParent and parentSummaryId are never read); src/calculations/activity-matcher.ts:40-111 ('MULTI_SPORT' falls to default 'other'), 603-741 (parent and children processed as independent activities); no isParent/parentSummaryId/MULTI_SPORT handling anywhere in src or supabase (grep)

**What the code does (verifier wording):** For a Garmin-webhook-only user (no Strava), the app has no parent/child or time-overlap dedup for Garmin activities. If Garmin delivers a MULTI_SPORT parent summary plus its child leg summaries, each with its own activityId, all of them become separate garmin_activities rows and are processed as separate activities. The parent is typed 'other' and the legs 'ride'/'run'. Signal B for that session comes out about 2x. The code gap is certain. That Garmin delivers both parent and child summaries is supported by the Garmin Health API schema (MULTI_SPORT parent, CYCLING child linked by parentSummaryId), but I could not open the spec page from this sandbox to check the exact wording. So the defect is real at the code level, and whether it fires depends on the Garmin feed.

**Scenario:** A Garmin-webhook-only user (reach as in the first finding) records a brick with the Multisport profile: 60 min bike plus 30 min run. The webhook stores a MULTI_SPORT row (90 min, avg HR over both legs), a CYCLING row (60 min) and a RUNNING row (30 min). The RUNNING child fills the run slot. The CYCLING child and the MULTI_SPORT parent both go through cross-training review. Their avg-HR iTRIMPs sum to roughly the whole session again. That day's Signal B, the 7-day rolling load, strain and ACWR read about 2x. The excess-load path then proposes cutting later runs.

**Reachable in practice:** Only Garmin-only users, meaning no Strava connected, on the main.ts:450 else-branch. They get there on app boot, from the Sync Now button on the main view, or from Account > Sync Now. The user must record with a Garmin Multisport or Triathlon profile, for example a bike-run brick. Garmin Health API must also push the parent and child summaries, which its documented isParent/parentSummaryId schema implies but I could not confirm from here.

Strava-connected users are not affected. Standalone mode returns only strava-* rows to the client, and history mode's 2-minute start-time dedup collapses the parent with the first leg.

For a marathon-focused user this is a rare flow. It becomes more relevant if triathlon mode (docs/TRIATHLON.md) ships for Garmin-only users.

**Impact:** In the probe, a 90-minute brick (60 min bike plus 30 min run) produced 190 Signal B TSS instead of about 96. The session's day strain, weekly Signal B, 7-day rolling load and ACWR all get about 94 extra TSS, roughly 2x for that session.

In the current week, both the parent and the bike leg go into cross-training review. Neither can be discarded ('Log Only' still counts the load). Unslotted items become unspentLoadItems and drive the excess-load path: a silent easy-run reduction when the excess is 15 TSS or less, otherwise the reduce/replace modal. So the plan can cut later runs because of phantom load.

In a past week, the parent is logged straight in as adhoc load with no user prompt. Signal A inflation is smaller, because MULTI_SPORT maps to generic_sport and gets a runSpec discount.

Transition legs, if Garmin sends them as children, would add a little more on top.

### C12. hr_zones is always null for Garmin rows, so the Rolling Load '4-Week Load Focus' buckets each session by avgHR/%HRmax: anaerobic reads about 0 and easy runs read as High Aerobic

- **Finder severity:** low
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** supabase/functions/garmin-webhook/index.ts:149-166 (no hr_zones or itrimp written); only writer of hr_zones/itrimp is supabase/functions/sync-strava-activities/index.ts:859-862,906-907,1222-1223; supabase/functions/sync-activities/index.ts:26,33-37 (passes a null hrZones through); src/calculations/fitness-model.ts:1072-1096 (fallback: avgHR/maxHR >= 0.90 -> anaerobic, >= 0.70 -> highAerobic, else lowAerobic, whole session TSS to one bucket); src/ui/rolling-load-view.ts:194-240 (diagnosis vs targets 40-55/30-40/10-20%), 273 (footnote claims unzoned activities 'are attributed to Low Aerobic'), 297; src/cross-training/universalLoad.ts:561-574 (classifier uses the iTRIMP method when zones are absent, so it is not affected)

**What the code does (verifier wording):** For Garmin-only users (no Strava), every garmin_activities row comes from the Garmin webhook, which never writes hr_zones or itrimp. Every such activity that has an avg_hr, when s.maxHR is set, therefore takes the avgHR/%HRmax fallback in getDailyLoadHistory. That fallback puts the whole session's TSS into one bucket: at least 90% HRmax is Anaerobic, at least 70% is High Aerobic, anything lower is Low Aerobic. As a result, only sessions averaging at least 90% HRmax count as Anaerobic. That essentially means races or time trials, never an interval session averaged over its warm-up and recoveries. Easy runs at the app's own Karvonen Z2 target (60 to 70% HRR, which is 70.5 to 78% HRmax at 190/50) all count as High Aerobic. The footnote saying unzoned activities "are attributed to Low Aerobic" is wrong whenever avgHR and maxHR exist.

Minor corrections to the report:
(a) At maxHR 190, the highest integer avgHR that buckets as Low is 132, not 130. The cut is at 133.
(b) "Never reach 90%" is overstated. A 5K or 10K race can average 90% or more.
(c) If s.maxHR is null, the fallback is skipped and everything goes to Low Aerobic. For Garmin users s.maxHR is normally set from the 95th percentile of activity max HR.
(d) Easy runs showing as High Aerobic is not unique to Garmin. The Strava stream path uses the same 70% HRmax cut, time-weighted. What only Garmin users get is the whole-session lumping, and therefore about 0 Anaerobic.
(e) The 85-90% High Aerobic figure depends on the scenario. It assumes the athlete's easy runs average at least 70% HRmax.

**Scenario:** Probe with maxHR 190 and RHR 50. avgHR 135, 140, 145 and 148 (HRR 61-70%, easy to steady) all bucket as highAerobic. avgHR 130 is the highest that buckets as lowAerobic. A VO2 session (avg ~149) is highAerobic. Result for a Garmin-webhook-only user on an 80/20 plan: 4-Week Load Focus shows High Aerobic around 85-90%, Low around 10% and Anaerobic 0% against targets of 30-40/40-55/10-20. The diagnosis reads 'High Aer. Surplus', and the footnote under it says unzoned sessions were put in Low Aerobic.

**Reachable in practice:** Yes, for any Garmin-only user, meaning Garmin connected and Strava not connected: main.ts:450 triggers syncActivities, then sync-activities, then matchAndAutoComplete, which puts rows into garminActuals with hrZones null. The page is reached from the Readiness view via the 7-Day Rolling Load card (readiness-view.ts:467-480, click at 536-538), which opens renderRollingLoadView. The 4-Week Load Focus and the daily zone bars render whenever any zoneLoad is above 0 (rolling-load-view.ts:301-303,416-420). This requires s.maxHR, which Garmin users normally get automatically from sync-physiology-snapshot (the 95th percentile of their activity max_hr) or from a manual entry. Without it, everything falls to Low Aerobic instead. Users with Strava connected do not hit this path; their stream-computed zones share the 70% HRmax cut but not the whole-session lumping. The earlier "Max HR fix" (outlier-robust percentile) changed only the denominator, not the 70%/90% HRmax cut-offs. If anything, a 95th-percentile maxHR below true max pushes more sessions over 70% and makes this worse.

**Impact:** Example with maxHR 190 and RHR 50: any session averaging 133 bpm or more (≥70% HRmax) books 100% of its TSS as High Aerobic. That includes the whole Karvonen Z2 easy band (134-148 bpm), long runs, tempo and VO2 sessions (a VO2 session averaging about 149 bpm is High). Only sessions averaging 171 bpm or more (≥90%) count as Anaerobic, which in practice means races only. Only recovery-pace runs and low-HR cross-training averaging 132 bpm or less count as Low. For a Garmin-only runner whose easy runs sit at the app's own Z2 target, the 4-Week Load Focus will show about 0% Anaerobic and a High Aerobic share near the running share of load (roughly 80-90%) against a 30-40% target. The heading reads "High Aer. Surplus" (or "Low Aer. Shortage"), and the footnote says "0 of N activities have HR zone data... attributed to Low Aerobic", which is false. A runner whose easy runs average under 70% HRmax would instead see them correctly as Low, so how large the error is depends on the individual. The Anaerobic ≈ 0 outcome holds for every Garmin-only user who does not race. This is a display and diagnosis problem only: zoneLoad does not feed ACWR, CTL/ATL, readiness or plan adjustments. getDailyLoadHistory is called only from rolling-load-view.ts.

### C13. Garmin iTRIMP is always the avg-HR summary estimate (Jensen under-read). Measured: 5-7% low for quality sessions, not 16%. The stored stream is never used.

- **Finder severity:** low
- **Verifier votes:** confirmed, confirmed, partially_confirmed
- **Code:** src/calculations/activity-matcher.ts:385-397 (resolveITrimp: row.iTrimp is always null for Garmin, so it always calls calculateITrimpFromSummary), src/calculations/trimp.ts:99-111; trimp.ts:36-58 (calculateITrimp) and 70-87 (calculateITrimpFromLaps) have no production caller in src; supabase/functions/garmin-webhook/index.ts:378-401 (full activityDetails payload saved to activity_details.json_data); src/data/activitySync.ts:235-292 (syncLapDetails reads only raw.laps, only for current-week garminActuals, display only; nothing reads samples); null path is transient: activity-matcher.ts:1066-1097 healMissingITrimp called at src/main.ts:179

**What the code does (verifier wording):** For Garmin-only users (Strava not connected, source not Apple), every Garmin-webhook activity gets its iTRIMP from one average HR through calculateITrimpFromSummary. No code path ever writes garmin_activities.itrimp for a Garmin-webhook row. HR samples from the Garmin activityDetails push, if received, are stored in activity_details.json_data but nothing reads them. The function x*e^(beta*x) is convex, so the single-average estimate is always less than or equal to the stream value (Jensen's inequality). The shortfall is about 0% on steady runs, 2 to 3% on marathon-pace and long runs, 5 to 7% on threshold and VO2 sessions, and 16% only for an idealised 50/50 step. Two limits apply. First, "the stream is stored" holds only if Garmin's activityDetails push is enabled for the app. The handler exists, but its payload cannot be verified from code. Second, a Garmin-only user who once had Strava can still get stream-based iTRIMP on old "strava-*" rows, because sync-activities does not filter by source.

**Scenario:** A Garmin-webhook-only user's week has 3 easy runs, 1 threshold 2x20 and 1 VO2 6x3. Signal A and Signal B read about 9 TSS low (about 2.5% of the week). Quality-day strain and the easy/hard load split skew toward easy. Steady runs are essentially exact. Fix direction: compute calculateITrimp from json_data.samples. Garmin's published schema has per-sample heartRate and timerDurationInSeconds; using timer time also avoids the pause-dt problem. Unverified here: Garmin activityDetails laps may carry only startTimeInSeconds, so calculateITrimpFromLaps is not a usable fallback, and syncLapDetails' lap HR/pace display may be empty.

**Reachable in practice:** Yes, for every Garmin-only user.
- getActivitySource (src/data/sources.ts:22-33) returns 'garmin' when stravaConnected is false and the source is not Apple.
- On launch, main.ts:447-455 (the else branch) calls syncActivities() → sync-activities → matchAndAutoComplete. The manual "Sync" button does the same (main-view.ts:2692).
- Every run and cross-training session from the Garmin webhook takes the summary path.

Not affected:
- Users with Strava connected. Their activities come from sync-strava-activities with stream iTRIMP, including Garmin wearers who also link Strava.
- Apple users.

Edge cases:
- If avg_hr is null, the session falls to the RPE and duration fallback.
- strava-* rows left over from a past Strava connection still carry stream iTRIMP.

Unverified from code:
- Whether Garmin is actually set up to push activityDetails. docs/GARMIN.md:48 says it is.
- The claim that Garmin laps carry only startTimeInSeconds, which would leave calculateITrimpFromLaps and the lap display empty.

**Impact:** Per session (probe; exact size depends on how variable the session's HR is):
- Steady easy and long runs: 0 to 0.5% low (under 1 TSS).
- Marathon-pace long runs: about 2% low (about -2.5 TSS).
- Threshold, interval, VO2 and HIIT sessions: 5 to 7% low (-3 to -5 TSS each).
- Irregular gym circuits: about 2 to 3% low.

Per week:
- A week of 3 easy runs, 1 threshold and 1 VO2 session reads about 8 to 10 TSS low, roughly 2 to 3% of Signal A and Signal B.

What it skews:
- Absolute CTL, ATL and weekly TSS all read low.
- The share of load from quality sessions, and per-session strain on hard days, is understated.
- Ratios (ACWR, the 7-day/28-day rolling ratio, same-signal TSB) largely cancel, because CTL and ATL draw from the same biased iTRIMP.
- Real wrist-HR noise adds variance, which widens the gap further.

The one factor that could partly offset this is not verifiable from code: if Garmin's durationInSeconds includes paused time that its average HR excludes, the summary could read high instead.

The error is systematic, always in the low direction, and small next to a wrong maxHR or the fallback normaliser of 15000.

### C14. Every sync rewrites the last 28 days of Garmin iTRIMP using today's single-day RHR and the current p95 maxHR; older weeks keep old values

- **Finder severity:** low
- **Verifier votes:** partially_confirmed, confirmed, partially_confirmed
- **Code:** src/calculations/activity-matcher.ts:529-601 (enrich loop: resolveITrimp with the current s.restingHR/s.maxHR at 536; overwrite whenever the value differs at 577-579); src/data/activitySync.ts:26-32 (28-day fetch window bounds which rows get rewritten); src/data/physiologySync.ts:118-128 (s.restingHR = newest daily row's resting_hr; s.maxHR = envelope maxHR); supabase/functions/sync-physiology-snapshot/index.ts:141-151 (p95 of all activity max_hr, median when fewer than 5)

**What the code does (verifier wording):** The mechanism is real. For Garmin-webhook rows, garmin_activities.itrimp is never written, so every Garmin-only sync recomputes the iTRIMP of each already-matched activity in the 28-day fetch window from the current s.restingHR and s.maxHR. It overwrites the stored value whenever the two differ. Activities older than 28 days keep the iTRIMP from their last in-window sync.

The claimed effect on displayed TSS and CTL is right only for users with no LTHR, where the normalizer is fixed at 15000. When Garmin supplies an LTHR, the global normalizer uses the same current RHR and maxHR and is applied to every week. In-window rewrites then largely cancel, at about 1 to 2 percent. The weeks that move the most are the frozen weeks older than 28 days, up to about 9 to 20 percent for a 5 to 10 bpm maxHR change. So the real defect is mixed profiles across the 28-day boundary. It is not that the window moves while older weeks stay fixed.

**Scenario:** A Garmin-webhook-only user opens the app on a day when the watch reports RHR 46 after a rest day; the next morning it reports 54 after a hard session. Every session in the last 28 days is rewritten about 4-5% up, then about 4-5% down. Last week's Plan/Stats TSS and the weekly EMAs shift with no new training. A new max_hr outlier moves the p95 by 5 bpm, and the whole 4-week window shifts about 8%, while week 5 and older are unchanged. The 7d/28d ratio mostly cancels, but CTL/ATL (weekly EMA) and the displayed weekly totals do not.

**Reachable in practice:** Yes, for Garmin-only users: stravaConnected false and activity source not Apple.
- **Every launch:** main.ts:449-455 calls syncActivities(), which calls matchAndAutoComplete.
- **Every manual Sync press:** main-view.ts:2692 and account-view.ts:956.

s.restingHR changes on most physiology syncs, because each one takes the newest daily RHR. s.maxHR changes whenever a new activity max_hr shifts the p95, and with 20 or fewer activities any new peak does.

Not reachable for Strava-sourced rows (resolveITrimp returns the DB value, line 391), or for Apple Health rows (avg_hr is always null, appleHealthSync.ts:409, so resolveITrimp returns null).

Partly reachable for a Garmin user who once had Strava connected: their Strava rows are stable and their Garmin rows are rewritten.

**Impact:** Garmin-only user with no LTHR (normalizer fixed at 15000):
- The claim holds. All sessions in the last 28 days scale together by about ±2 to 3% for a ±4 bpm RHR day-to-day change, and about ±8 to 9% for a 5 bpm maxHR move.
- Weeks older than 28 days do not move.
- Completed weeks' TSS in Plan and Stats changes between launches, for example 150 to 145 or 156 for maxHR ±5. Earlier weeks do not change, so CTL and ATL mix profiles.

Garmin user whose watch reports LTHR (normalizer personal):
- The claim's magnitudes and direction are wrong. In-window weeks move only about 1 to 2%, because the rewrite offsets the normalizer shift.
- Weeks older than 28 days carry the full normalizer shift: about 9% for maxHR ±5 and 18 to 20% for ±10, with iTRIMP frozen at an old profile.
- Either way the two segments of CTL use different profiles, and both move between launches without new training.

The 7d/28d ratio is mostly unaffected because its whole window is rewritten consistently.

The retroactive rewrite on its own is a moderate error, about 1 to 3% from typical RHR noise. The larger swings come from maxHR changes, made worse by the "p95" being the absolute maximum when there are 20 or fewer activities. They also come from the global normalizer, which already rescales all history by the current profile regardless of this loop.

### C15. 'Rebuild Plan from Strava Data' puts preserved activities into the wrong plan weeks and drops some of them

- **Finder severity:** high
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/ui/account-view.ts:504, :841-846, :861-869; src/state/initialization.ts:114, :134, :235; src/calculations/activity-matcher.ts:422-429, :605; src/calculations/fitness-model.ts:953-961

**What the code does (verifier wording):** Confirmed, with three small corrections. The rebuild handler (account-view.ts:823-872) saves only garminActuals, garminMatched, actualTSS and rated. It then calls initializeSimulator, which sets s.w = 1 (initialization.ts:114), replaces s.wks (:134) and resets planStartDate to this Monday (:235). The saved fields are copied back by array index (account-view.ts:861-869), so for any user in week 2 or later, old week i lands in a new week i that covers different dates. adhocWorkouts, garminPending and unspentLoadItems are never saved. garminMatched is restored only for weeks that had at least one garminActual (:863). Those IDs go into the global processed set (activity-matcher.ts:422-429), so the activities are never moved to the right week. A '__pending__' entry in such a week loses its garminPending item, and nothing processes it again. Corrections: (a) The adhoc Workout objects are lost, but for activities inside the 28-day sync window the enrich loop (activity-matcher.ts:531-556) rebuilds a garminActuals entry for 'garmin-' adhoc items. Their load comes back, but in the wrong week. (b) For weeks with no garminActuals, garminMatched is not restored. Their activities are re-imported on the next sync: this week's go into the correct new week 1, earlier ones are skipped as outside the plan range (activity-matcher.ts:366-377, 583-590). (c) Acute load is not zero. Days before the new plan start are filled with signalBBaseline/7 (fitness-model.ts:957-959). Only real activity TSS in the current week drops to 0.

**Scenario:** A user in week 6 taps Rebuild (account-view.ts:504). The new week 1 is this calendar week, but it now holds old week 1's runs from 5 weeks ago. computeWeekTSS and computeWeekRawTSS for the current week return that old load. The rated keys 'W1-...' mark this week's new sessions as done. The runs actually done this week sit in new week 6, a future week. computeRollingLoadRatio only looks in wks[weekIdx] for each date, so it never sees them. Acute load for this week drops to 0 real TSS and ACWR falls. Pending cross-training from before the rebuild is gone for good.

**Reachable in practice:** Yes, in normal use. The Training History group is rendered whenever s.stravaConnected || s.stravaHistoryFetched (account-view.ts:213). The Rebuild button appears once history has been fetched (:465-476, :504). stravaHistoryFetched is set by fetchStravaHistory (stravaSync.ts:243), which runs during the onboarding Strava-history step (wizard/steps/strava-history.ts:52) and the startup backfill (main.ts:489). So any Strava user who opens Account, taps "Rebuild Plan from Strava Data" and confirms is affected. The confirm dialog (:834-835) and footnote (:509) say "Your logged activities and ratings will be preserved." The week misplacement needs s.w >= 2 at rebuild time, meaning the old planStartDate is before this Monday. A user still in week 1 only loses adhoc, pending and unspent data. There is no self-heal: loadState only re-derives planStartDate when it is missing (persistence.ts:258-270), and the 28-day sync never relocates matched IDs.

**Impact:** Probe user in week 6: signalBBaseline 280, one 60-TSS run per week, and this week a run, a pending ride, an adhoc swim and an unspent item. Current-week Signal B TSS showed 60 instead of 162, and the 60 came from a run 5 weeks old. Seed filling alone would be expected once history is reset. Beyond that, this week's real activity TSS falls from 162 to 0 in the 7-day acute window. ACWR went from 1.90 to 0.77, a "low" status instead of "high", so load warnings and reductions are suppressed. New week 1 sessions show as completed based on old week-1 ratings and actuals. This week's real runs sit in week 6 and reappear 5 weeks from now in that week's totals and plan cards. The pending cross-training item is never offered for review again. Unspent-load items are dropped for good. Every week w carries week w's data from the old plan, so all weekly charts and CTL/ATL walks are shifted by (old s.w - 1) weeks.

### C16. Removing an activity with × is undone on the next sync

- **Finder severity:** medium
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/ui/events.ts:2472-2479, src/ui/plan-view.ts:2538-2544, src/calculations/activity-matcher.ts:422-429, src/calculations/activity-matcher.ts:605, src/data/stravaSync.ts:27-29

**What the code does (verifier wording):** The mechanism is real: if removeGarminActivity's adhoc branch runs, the next sync re-imports the activity. Nothing records removed IDs, the dedupe looks only at garminMatched keys, and every sync re-sends the full 28-day Strava window. A probe reproduced it. But the user flow in the claim cannot happen in the current UI. No live screen shows an × on an adhoc (Logged/Excess) Strava activity. Every live × goes to a plan-slot match, which takes the wasSlotMatched branch: it sets '__pending__' and keeps the activity by design. So the adhoc branch is effectively dead code today. One related case is reachable. Pressing × on a slot-matched activity in a past week makes the stale-pending resolver re-log it as adhoc on the next sync. Its Signal B load comes back, which fits the intent of that branch, and wk.actualTSS is added a second time.

**Scenario:** Probe: a 60-min walk in past week 1 was logged as adhoc (Signal B 20). Replicating the removeGarminActivity adhoc branch took computeWeekRawTSS to 0. The next matchAndAutoComplete call with the same row re-created 'garmin-strava-5', Signal B went back to 20, and wk.actualTSS went from 20 to 40. A user removing a duplicate recording or a GPS glitch sees it return, with its load, on the next launch.

**Reachable in practice:** The claimed flow cannot be triggered: a user removing an adhoc Strava activity (a duplicate or GPS glitch) with ×. In the live Plan view, adhoc Logged/Excess rows have no ×, and the only × buttons that exist for them (renderer.ts:1500 and nearby) render into #wo, which is never mounted. The practical gap is the opposite of the claim: a duplicate adhoc activity cannot be removed at all.

The reachable relative: Plan view, navigate to a past week, then press × on a matched activity, either in the expanded card or on a Matched row in the Activity Log. It becomes pending. On the next launch or manual sync (which needs a non-empty Strava response), stravaSync then matchAndAutoComplete auto-logs it as an adhoc Logged entry in that week. The comment at events.ts:2467-2469 says this branch is meant to keep the activity, so the load returning is intended behaviour; only the second actualTSS addition is a defect. In the current week, × returns the item to review, which is the documented behaviour.

**Impact:** Claimed adhoc flow: no user-facing effect today, because it cannot be reached. It is a latent defect that will surface as soon as anyone adds an × to adhoc rows.

Reachable sibling: Signal A/B, ACWR and CTL/ATL come out correct. computeWeekTSS and computeWeekRawTSS recompute from garminActuals and adhocWorkouts and ignore wk.actualTSS (fitness-model.ts:308-393, 408-475), and the re-logged adhoc restores the same load that was there before the × (20 to 0 to 20 in the probe). The only numeric error is that wk.actualTSS for that past week is counted twice (20 to 40 in the probe). A past week's actualTSS is read by sleep-view.ts:221 (the last 4 weeks' actualTSS feeds the sleep insight) and by main-view.ts:1921 and 2004. Those main-view functions (updateLoadChart, updateACWRBar) belong to the legacy main view and look unreachable, though I did not trace their callers. events.ts:1023 reads actualTSS only when the current week advances, so a past week's inflated value is not read there again. The fact that × never subtracts actualTSS applies to both branches, but it does not reach Signal A, Signal B or ACWR.


## D. Apple Watch path

### D1. Apple sync never opens the review queue, so this week's non-run sessions and off-plan runs count as zero load

- **Finder severity:** high
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/main.ts:386-396; src/data/appleHealthSync.ts:98-114; src/ui/account-view.ts:976-980; src/ui/main-view.ts:2689-2690; src/calculations/activity-matcher.ts:715-738, 875-898, 443; src/data/activitySync.ts:47-71, 113-170; src/data/stravaSync.ts:162-182; src/ui/plan-view.ts:2695-2712; src/calculations/fitness-model.ts:324-338, 421-434, 505-519
- **Independent check:** Code read by Claude: isNativeiOS checks window.Capacitor.platform, which Capacitor 8 core and native bridge never set. Needs a device check.

**What the code does (verifier wording):** The mechanism is real but cannot run today. syncAppleHealth() never calls processPendingCrossTraining() or mergeTimingMods(). So if Apple workouts reached matchAndAutoComplete, this week's non-run sessions and off-plan runs would stay '__pending__' in wk.garminPending, which no load function reads. That part matches the claim. But on the current Capacitor 8 build, isNativeiOS() (appleHealthSync.ts:40-42) tests `window.Capacitor.platform === 'ios'`. Capacitor 8 never sets `.platform`; it only provides getPlatform(). So syncAppleHealth() returns at appleHealthSync.ts:99 on a real iPhone, and no Apple workout is ever imported, pending or matched. syncAppleHealthPhysiology() stops at the same check (:158). What users actually hit is a bigger bug: every Apple Watch workout adds zero load, not only the ones in the review queue. The review-queue gap only becomes reachable once the platform check is fixed, for example by using isIOS() from src/utils/platform.ts. Also, only two Apple sync entry points are live, not three. The main-view.ts:2690 handler sits inside wireEventHandlers() (main-view.ts:2521), which nothing calls, and renderMainView() (main-view.ts:54-57) just hands off to the plan view.

**Scenario:** Probe run through the real matchAndAutoComplete. Plan week 3 starts Mon 28 Sep. On Tuesday an Apple user does a 60-min strength session and a 40-min run on a day with no planned run. Result: both are '__pending__'. Tuesday's daily Signal B (strain ring, rolling 7d/28d ACWR) = 0. Weekly Signal A = Signal B = 31, which is only Monday's matched easy run. The Home ring, ACWR and weekly bar show no load for Tuesday. No reduce/replace suggestion is made. Timing mods are not recomputed. This lasts until the user finds and taps Review. If they never do, the load only reaches last week's totals after the next sync following the week rollover.

**Reachable in practice:** Not reachable as described. An Apple-only user is someone without Strava whose activity source resolves to 'apple' (sources.ts:22-30). At boot (main.ts:388) and on the Account Sync button (account-view.ts:978), syncAppleHealth() runs, but isNativeiOS() is false on a real iPhone under Capacitor 8. It returns before querying HealthKit, so nothing reaches matchAndAutoComplete and nothing is ever queued as '__pending__'. The Account button then reports "Sync complete — activities, sleep, and recovery updated." (account-view.ts:981) even though nothing happened. Strava-connected users never use the Apple activity path. The claimed gap (no processPendingCrossTraining or mergeTimingMods after Apple matching) becomes live the moment the platform check is fixed, and should be fixed at the same time.

**Impact:** Today, for an Apple-only user, every Apple Watch workout adds 0 to all load numbers: weekly Signal A and B, daily Signal B (strain ring, rolling 7d/28d ACWR, daily load chart) and CTL/ATL. That includes runs that would have been high-confidence matches. In the claimed scenario (Mon easy run, Tue 60-min strength plus 40-min off-plan run), the week would read 0 TSS, not the 31 the report claims. Tuesday reads 0 as the report says, but for a different reason. No reduce or replace suggestion is made and timing mods are not recomputed, because no activity data exists. Apple physiology (sleep, HRV, RHR, steps, exercise minutes) also never syncs, because syncAppleHealthPhysiology has the same check at :158. That also hits Strava users whose physiology source is Apple (main.ts:406-414), and it means Apple passive strain never reaches the Home ring. Once the platform check is fixed, the claimed behaviour appears as reported. This week's pending non-runs and off-plan runs would then count 0 until the user taps Review (plan view, Account alert or Home unmatched row), or until the week rolls over and a later sync logs them as past-week adhoc entries.

### D2. Apple mapWorkoutType turns strength, HIIT, yoga and team sports into WALKING (its strength case can never fire)

- **Finder severity:** high
- **Verifier votes:** partially_confirmed, partially_confirmed, partially_confirmed
- **Code:** src/data/appleHealthSync.ts:72-86; node_modules/@capgo/capacitor-health/ios/Sources/HealthPlugin/Health.swift:103-147 (115-117, 146-147); src/calculations/activity-matcher.ts:101, 259, 1001-1009; src/calculations/matching.ts:60; src/ui/activity-review.ts:131-132, 720, 1917-1935; src/cross-training/universalLoad.ts:194-240

**What the code does (verifier wording):** The core defect holds. With @capgo/capacitor-health 8.2.16, HealthKit traditionalStrengthTraining comes back as 'strengthTraining'. Every type outside the plugin's list (HIIT, functionalStrengthTraining, coreTraining, pilates, dance and so on) comes back as 'other'. mapWorkoutType handles neither string, nor yoga, tennis, soccer, basketball, americanFootball, baseball, the water sports or wrestling. All of these fall to the default 'WALKING' and are labelled 'Walk'. The case 'traditionalStrengthTraining' can never fire. Only Apple 'crossTraining' becomes STRENGTH_TRAINING/gym.

Knock-ons that hold: (a) the session is never proposed for or matched to a planned gym slot. (b) RPE comes out as 3. (c) The cross-training engine sizes it as 'walking' in Tier C. (d) The Excess Load item carries sport 'walking'.

Knock-ons that are wrong or overstated:
- (e) is unreachable. defaultsToIntegrate is used only by showReviewScreen, and nothing live calls that. The live path starts every item as 'integrate'.
- The soccer baseline of 82 is wrong. A correctly typed SOCCER row would go SOCCER -> 'other' -> 'generic_sport' at RPE 5, which gives 48.6, not the 'soccer' sport key.
- The 60-minute strength baseline of 100 is mostly moot. In the auto-process path and the unconfirmed applyReview path, a correctly typed gym session with no slot is logged and never sent to the reduction engine. In the live review screen, a gym item left unassigned is filed as Excess Load, so it can reach reduction there.
- "Effectively never suggests cutting a run" is false. A walking-typed session still produces a smaller cut, for example easy 8 km to 6.5 km instead of to 4.8 km.

Missed, and worse: the matcher treats 'walk' as a run (matching.ts:52, 59). A mistyped Apple strength, HIIT or sport session on the same day as an unrated planned run scores 4 (same day plus type), which clears the run threshold of 3. autoProcessActivities never checks confidence, so it auto-completes that run with RPE 3. The live review screen proposes the same pairing.

**Scenario:** Probe using the real computeUniversalLoad. A 45-min soccer match from Apple gives fatigue-cost load 11 (walking, RPE 3). The same match typed as soccer without HR gives 82. A 60-min strength session gives 14 against 100 when typed as gym at RPE 6. A 30-min HIIT gives 7 against 37. The reduction engine therefore sees 13 to 20% of the load and effectively never suggests cutting a run after a hard team-sport or HIIT session. The planned gym session stays unticked all week, and the session is labelled 'Walk'.

**Reachable in practice:** The bug is reachable on native iOS only (isNativeiOS, appleHealthSync.ts:40). It needs a user who picked Apple Watch in onboarding and has not connected Strava. In that case fitness.ts:178 sets wearable 'apple', and getActivitySource returns 'apple' (sources.ts:22-29). syncAppleHealth then runs on launch (main.ts:386-388) and from the Sync buttons (main-view.ts:2690, account-view.ts:978).

Once Strava is connected, getActivitySource returns 'strava' and Apple workouts are not read at all. Those users are unaffected.

Pending items surface in two ways:
- The Plan review button calls showActivityReview, which runs the matching screen and proposeMatchings.
- account-view's review button calls processPendingCrossTraining, which runs autoProcessActivities for 1 or 2 same-day items.

In both flows the item is typed 'walk', so the gym slot is never proposed. A same-day unrated planned run can be proposed or auto-completed by the gym session. The ios/ folder is gitignored, so none of this could be verified on a device.

**Impact:** Every Apple strength, HIIT, yoga and team-sport session shows up as 'Walk' at RPE 3.

Load compared with what a correctly typed row would get through this pipeline (same Tier C, no HR):
| Session | Walk-typed | Correctly typed |
|---|---|---|
| 45 min soccer | 10.5 FCL | 48.6 as generic_sport, about 22% (not 82) |
| 60 min strength | 14 FCL | 99.8 as gym at RPE 6 |
| 30 min HIIT | 7 FCL | 37 as gym at RPE 5 |

Weekly Signal B (ATL/ACWR) for a 60-minute strength session is 39 TSS instead of 87. For 45 minutes of soccer it is 29 instead of 52.

The reduction engine still proposes a cut, just a smaller one, for example 1.5 km off an easy run instead of 3.2 km. It is not the case that no cut is suggested.

The planned gym slot is never matched, so it stays unticked. If a run is planned the same day and still unrated, the auto-process path marks it complete at RPE 3 using the strength session. This is not in the original report and is arguably the most user-visible effect.

The toggle-screen default of 'Log only' for walks under 45 minutes, claim (e), is dead code and has no effect.

### D3. 'walk' is matched as a run, so an Apple strength or yoga session can take a planned run slot and then drops out of daily load

- **Finder severity:** high
- **Verifier votes:** confirmed, confirmed, confirmed
- **Code:** src/calculations/matching.ts:52, 59, 125; src/ui/activity-review.ts:293, 378-389, 1364, 1395-1398, 1079-1104; src/ui/matching-screen.ts:423-433; src/calculations/fitness-model.ts:324-338, 508

**What the code does (verifier wording):** findMatchingWorkout treats appType 'walk' as a run (matching.ts:52) and only considers run slots (matching.ts:59, :125). A same-day 'walk' scores 3 + 1 = 4, which clears the run minimum of 3 (matching.ts:136). On the Apple Health source, HealthKit strength ('strengthTraining'), yoga, HIIT ('.other'), functional strength and team sports all fall to the default in mapWorkoutType and become WALKING (appleHealthSync.ts:84). mapGarminType then turns WALKING into 'walk' (activity-matcher.ts:100-110). Garmin and Strava walks, hikes, rows, kayaking and golf also become 'walk' (activity-matcher.ts:100-110; sync-strava-activities/index.ts:239, 255-263).

Batch review path: in batch review these items are cross items (activity-review.ts:1364). The cached run-slot match is proposed as a 'sport' pairing (:1395-1398) and pre-assigned (matching-screen.ts:432) without the screen's own isCompatible check. That check (matching-screen.ts:64-73) would refuse a manual tap of a walk onto a run slot. On confirm, applyReview's cross branch rates the run slot (activity-review.ts:1079) and writes a garminActuals entry with no startTime and no iTrimp (:1084-1092). computeTodaySignalBTSS skips it (fitness-model.ts:508), and so does the rolling ACWR built on it (fitness-model.ts:961, 1152).

Corrections and extensions:
(a) The pairing is not limited to easy runs. Any unrated run-type slot on the same day qualifies: Threshold, VO2, Long. A walk of roughly matching distance can pair on an adjacent day, and can even score 'high'.
(b) Strava and Garmin users mostly hit it silently. For a single same-day item, processPendingCrossTraining (activitySync.ts:97-104, 163) routes to autoProcessActivities. That function pairs the walk to the run slot with no screen at all (activity-review.ts:1675-1695). This path keeps startTime but also drops iTrimp.
(c) For Strava users, the missing startTime is back-filled on the next Strava sync (stravaSync.ts:94). The daily-load loss is permanent only for Apple Health and Garmin-webhook users.
(d) 'Counts as a full run in Signal A' is true but not a delta. The adhoc alternative is also undiscounted, because addAdhocWorkoutFromPending writes a garminActuals twin (activity-matcher.ts:1129-1148). computeWeekTSS counts that twin first and dedups the runSpec-discounted adhoc entry. The run-slot pairing therefore lowers weekly A and B from 52 to 29, because rated RPE 3 replaces the default 5.
(e) Every cross pairing confirmed through the matching screen goes through this branch, so all of them lack startTime. That includes named sport-slot matches and generic cross-slot matches, because Step 3b is disabled when confirmedMatchings is set (activity-review.ts:1128-1130).

**Scenario:** Monday's easy run is not yet done. An Apple user does a 45-min strength session on Monday and opens Review. It is proposed as 'Easy Run' (probe: findMatchingWorkout returns Easy Run, medium confidence, 'same day, type match (run)'), and the user confirms. The easy run is now marked done. Probe on the resulting shape: weekly Signal A and B = 29, because the garminActuals path applies no runSpec, so a strength session counts as a full run in Signal A. Daily Signal B = 0, because computeTodaySignalBTSS skips actuals without a startTime (fitness-model.ts:508), so the session is gone from ACWR and the strain ring. If the user runs that evening, the run finds no slot and goes to excess load. The same 45-min session reads 52 in every signal if logged as adhoc instead.

**Reachable in practice:** Yes, on normal flows.

- **Apple Health users:** syncAppleHealth (main.ts:388) only queues pending items. They review through the Plan "N pending · Review" banner (plan-view.ts:544-557), which calls showActivityReview (plan-view.ts:2705), then showMatchingEntryScreen. That is the batch path in the claim. Any strength, yoga, HIIT or team-sport session on a day with an unrated run slot is pre-assigned to that run. One tap on Save commits it with no startTime. The run slot is marked done and the session is missing from daily strain and ACWR permanently.
- **Strava users:** processPendingCrossTraining runs after every sync. A single same-day walk, hike, row or kayak goes to autoProcessActivities, which fills the run slot with no user interaction. Batches of 3 or more items, items older than 24h, or batches containing a run take the claimed review path. There, startTime is back-filled on the next Strava sync.
- **Garmin-webhook users:** the same routing as Strava, but with no back-fill.
- **Re-review:** openActivityReReview saves the slot assignment and re-proposes it with 'high' confidence (activity-review.ts:299-305), so the wrong pairing sticks.
- **Not reachable:** a 'walk' on a non-adjacent day with no distance match does not pair, and neither does one where the day's run slot is already rated or is claimed by a real run in the same batch.

**Impact:** - **Apple example, 45-min strength session on a run day, confirmed in review:**
  - The planned run is marked complete with rated RPE 3.
  - Weekly Signal A and Signal B are both 29, against 52 if logged as adhoc.
  - Daily Signal B is 0 instead of 52, so the session is missing from the strain ring. It also leaves 52 TSS out of the 7-day acute sum and 13/week out of the 28-day chronic average in rolling ACWR, for up to 28 days.
- **Plan effect:**
  - The real run done later that day finds no free slot and defaults to the tray, then Excess Load on Save. It was null against the remaining slots in the probe week.
  - Plan adherence shows the run done when no running occurred.
- **Quality sessions:** the same pairing can consume a Threshold, VO2 or Long Run slot, not only an easy run.
- **Strava and Garmin auto-process path:** there is no daily loss, since daily B = 52 because TL_PER_MIN[5] is used. Weekly load is still 29, and the HR-stream iTrimp is dropped. main.ts:179 later recomputes a summary iTrimp only when avgHR exists.
- **Strava review path:** daily load returns on the next sync.

### D4. Apple heart rate is never read, so every Apple session is costed as minutes x a fixed rate and runs read as exactly what was planned

- **Finder severity:** medium
- **Verifier votes:** partially_confirmed, confirmed, partially_confirmed
- **Code:** src/data/appleHealthSync.ts:45-49, 393-415 (409-410); src/calculations/activity-matcher.ts:385-396, 760, 265, 521-540; src/calculations/fitness-model.ts:324-338, 421-434, 510-519; node_modules/@capgo/capacitor-health/dist/esm/definitions.d.ts:1, 145

**What the code does (verifier wording):** The core defect is real. HealthKit workouts never carry heart rate. heartRate is authorised but never read, and every row gets avg_hr=null, max_hr=null and no iTrimp. So every session that enters through syncAppleHealth() is costed by duration only:
- An auto-matched run is rated at the plan's RPE, 3 for easy and long. Weekly A/B = min x TL_PER_MIN[planned RPE]; daily B = min x 1.15.
- Past-week non-runs and unmatched runs are costed at min x 1.15 in weekly A, weekly B and daily B. The adhoc RPE (3 walk, 6 strength) and runSpec are both ignored, because the garminActuals entry has no rated key and it shadows the adhoc entry.
- Current-week non-runs and unmatched runs sit at '__pending__' with 0 load.

Three parts of the claim need correcting:
1. "Every Apple session" is overstated. The current onboarding requires Strava, and getActivitySource returns 'strava' whenever stravaConnected is set. Apple Watch workouts that arrive through Strava are costed from HR (iTRIMP). The HealthKit workout path runs only in two cases. (a) Any Apple-physiology user on iOS taps Account > Apple Watch > Sync. That button calls syncAppleHealth() even when Strava is connected, and it then duplicates Strava's copy of the same session. (b) An Apple user without Strava, a legacy state, hits launch sync or Home sync.
2. "7 for threshold, 8 for VO2" is mostly unreachable. Generated threshold and VO2 descriptions parse to 1 km (the warm-up "1km"), so a real 8 to 10 km session never reaches high-confidence matching. It becomes an adhoc run at RPE 5 in a past week (min x 1.15), or pending in the current week.
3. Apple yoga, soccer, HIIT ('other') and 'strengthTraining' are all mapped to WALKING (appleHealthSync.ts:86). They are labelled "Walk", but the load is still min x 1.15.

**Scenario:** Probe comparing each Apple row with the same session carrying average HR (RHR 50, max 190, normaliser 15000). A 48-min planned easy run gives Apple weekly 31 and daily 55 at any effort. HR-based gives 37, 54 and 76 at 135, 150 and 165 bpm. A 50-min planned threshold run done easy (140 bpm) gives Apple 89 against 44 from HR. For adhoc sessions, Apple against HR: 60-min yoga 69 vs 12; 60-min strength 69 vs 23; 90-min zone-2 ride 103 vs 70; 45-min soccer 52 vs 67; 30-min HIIT 35 vs 41. Apple load cannot show that a session was run harder or easier than planned. ACWR and fatigue for Apple users follow duration only, and the same 45-min session reads 29, 52 or 0 depending on which path logged it.

**Reachable in practice:** Reachable only on the native iOS build. isNativeiOS() gates syncAppleHealth, and ios/ is gitignored but exists as a Capacitor target.

**Path 1: Account > Apple Watch > Sync (btn-sync-apple).** This is the main live path for current users. Anyone who picked Apple Watch in onboarding sees the button, and it calls syncAppleHealth() even though Strava is connected, so HealthKit copies of sessions already ingested from Strava are processed a second time:
- Past-week duplicates become adhoc entries costed at min x 1.15.
- Current-week duplicates queue as pending.
- A duplicate run can also auto-complete another unrated slot.

**Path 2: launch sync and Home "Sync".** These run syncAppleHealth only when stravaConnected is false and the wearable is Apple. The current wizard makes Strava mandatory, so this is limited to legacy states from before that rule. An Apple user also cannot reach the Strava "Remove" button, because the Apple row replaces the Strava row in Account.

**Not affected: normal launch for new Apple Watch users.** Launch uses Strava, and Strava activities carry HR-stream iTRIMP. That flow does not have this defect.

**Other limits:**
- Structured threshold and VO2 sessions essentially never auto-match (the 1 km parse), so the "rated 7/8" case is rare. Easy and long runs do auto-match at RPE 3.
- Current-week non-runs stay at 0 until the user opens Account > Review. syncAppleHealth ignores the returned pending list and never calls processPendingCrossTraining (appleHealthSync.ts:104-105). Once the week rolls over, they resolve to min x 1.15 (activity-matcher.ts:441-517).

**Impact:** For sessions that come in through HealthKit, load tracks duration only and cannot reflect effort.

**Easy and long runs** (auto-matched, rated 3):
- Weekly load is 0.65/min: 44 min gives 29, against 34 to 70 from HR at 135 to 165 bpm.
- Daily strain is 1.15/min: 44 min gives 51.
- The same run therefore reads 29 in weekly load and 51 in daily strain, a 1.77x mismatch between weekly and daily for one session.

**Past-week non-runs and unmatched runs:** 1.15/min everywhere, with no runSpec discount in Signal A:
- 60-min walk or yoga reads 69 vs about 17 from HR.
- 90-min ride reads 103 vs about 62.
- Hard 30 to 45 min sessions read low: 35 vs 48, 52 vs 64.

**Current-week pending items:** 0 until reviewed.

**One 45-min session, three readings:** 29 (matched easy), 52 (adhoc) or 0 (pending), depending on the path.

**The larger practical effect, not in the claim:** for Strava-connected Apple users, tapping Account Sync double-counts sessions. In the probe, weekly Signal B went from 43 to 94 for one run. That inflates ACWR and ATL.

The claim's own figures differ slightly from mine: 37/54/76 at 48 min vs my 34/50/70 at 44 min, and 12/70/67/41 for the HR-based adhoc sessions vs my 17/62/64/48. The Apple-side figures match. The HR-side differences come only from different assumed heart rates. Duration scaling of the easy run agrees.

### D5. Apple lookback is 14 days, not the 28 used elsewhere, so sessions older than that at the next sync are lost

- **Finder severity:** low
- **Verifier votes:** partially_confirmed, partially_confirmed, refuted
- **Code:** src/data/appleHealthSync.ts:118-132 (122); src/data/stravaSync.ts:27-29; src/data/activitySync.ts:25-27; src/calculations/activity-matcher.ts:614-625

**What the code does (verifier wording):** The 14-day window is real but cannot currently cause the reported loss. fetchRecentWorkouts (appleHealthSync.ts:118-132) does query HealthKit from now minus 14 days (line 122), while Strava (stravaSync.ts:27-28) and Garmin (activitySync.ts:26-27) look back 28 days. Apple also has no history or baseline mode. But fetchRecentWorkouts is never reached. syncAppleHealth returns at line 99 because isNativeiOS() checks `window.Capacitor.platform === 'ios'` (line 41), and the installed Capacitor 8 never sets a `platform` property. So today an Apple-activity-source user loses all of their workouts, not only those older than 14 days. The 14-day window is a latent inconsistency. It only starts losing data (days 15 to 28 after a gap) once the isNativeiOS gate is fixed to use Capacitor.getPlatform().

**Scenario:** An Apple user does not open the app for 18 days, for example while travelling. On return, only the last 14 days of workouts are fetched. The runs and cross-training from days 15 to 18 never reach wk.garminActuals or adhocWorkouts, so those plan weeks show under-completed with low load. CTL decays as if the user had not trained, and the next ACWR reads the returning load as a spike. A Strava or Garmin user with the same gap would have all 18 days ingested.

**Reachable in practice:** Not reachable as described. On every flow the Apple workout sync returns early at appleHealthSync.ts:99 under Capacitor 8, so no Apple workout of any age reaches matchAndAutoComplete. This covers:
- launch (main.ts:388)
- the Plan/Home "Sync" button (main-view.ts:2690)
- the Account "Apple Watch → Sync" pill (account-view.ts:970-978)

Even with the gate fixed, the Apple activity branch only runs for users who are not Strava-connected. Onboarding requires Strava, so that means users who later disconnected Strava, or legacy wearable='apple' users. Normal onboarded Apple Watch users get activities through Strava's 28-day path.

A related latent issue appears once the gate is fixed: account-view.ts:174 shows the Apple row (with its Sync button) whenever the physiology source is 'apple', and that includes Strava-connected users. Its handler calls syncAppleHealth() unconditionally. The resulting `apple-<id>` rows (appleHealthSync.ts:403) have no cross-source dedup against `strava-<id>` rows in activity-matcher.ts, so each session would be counted twice.

**Impact:** Current impact of the reported defect is zero, because it is masked by a larger live bug. For an Apple-activity-source user, 100% of Apple Watch workouts are never ingested at any age:
- wk.garminActuals and adhocWorkouts stay empty from this source
- Signal A/B, CTL/ATL and ACWR get nothing from it

HealthKit physiology (sleep, HRV, resting HR) is also skipped, since syncAppleHealthPhysiology hits the same gate at line 158.

Latent impact after the gate is fixed: after a gap of G days, workouts from days 15 to min(G, 28) would be missed, where a Strava or Garmin user would capture them. In the 18-day example, that is 4 days of sessions (about 15% of a 28-day chronic window), which lowers CTL and inflates the next ACWR. Gaps over 28 days lose data on all three sources, so the 14-day window only matters for gaps of 15 to 28 days.

# Appendix 1. Trace: how cross-training cuts runs

## How a completed cross-training session cuts this week's runs

## Short answer

- **Is iTRIMP used?** Yes. For any activity with heart-rate data it is the first choice, Tier A+ (`src/cross-training/universalLoad.ts:274`). But it goes in as the **raw iTRIMP number, not converted to TSS**. At `universalLoad.ts:106`, `baseLoad = iTrimp × sportMult`. That number is then compared against planned-run "load" from `src/workouts/load.ts`, which is on a much smaller scale (roughly minutes × 1–6). The result is a scale error of about 75×. This is reachable on every Strava or Garmin activity that has HR.
- **Which number decides how much a run is cut?** Mostly none of the load numbers. The suggester spends a budget (RRC, "run replacement credit"), but for any session longer than about 20–25 minutes that budget is bigger than the hard-coded per-run caps. So the caps decide the size of each cut:
  - easy runs: −40% on Reduce, −50% on Replace, never below 4 km
  - long runs: −25% on Reduce, −30% on Replace
  - quality sessions: one step down in intensity
  
  The load numbers decide three other things: **how many** runs are touched (the severity, from FCL ÷ planned weekly run load), **whether a Replace is offered** (RRC ≥ the run's load), and the headline.
- **Normalised iTRIMP (converted to TSS)** is used in three other places: the silent small-excess trim, the "Adjust plan" trigger and its cap, and the day-before timing check.

**Abbreviations:** FCL = fatigue cost load. RRC = run replacement credit. "Signal B" = raw weekly TSS from all activities. "Load units" = the planned-run scale from `load.ts`.

---

## 1. Entry points and whether each is reachable

| # | Path | Trigger | Currency | Reached? |
|---|---|---|---|---|
| P1 | Silent Tier 1 trim (`activity-review.ts:1774-1816`) | One same-day item goes to `autoProcessActivities`, doesn't fill a slot, and the week's Signal B excess is between 0 and 15 TSS | Signal B TSS | Yes |
| P2 | Uncapped modal from auto-processing (`activity-review.ts:1818-1845`) | Same as P1, but ACWR is caution or high | Suggester (FCL/RRC) | Yes |
| P3 | Uncapped modal from the Activity Review screen (`activity-review.ts:1195-1229`) | A cross item the user chose to integrate doesn't fill a slot. No ACWR gate | Suggester | Yes |
| P4 | Capped modal from the plan-view "Adjust plan" row (`plan-view.ts:1866`, `:2641` → `excess-load-card.ts:256-370`) | Week Signal B excess > 15 TSS | Suggester, budget scaled by excess TSS | Yes |
| P5 | Capped modal from `triggerACWRReduction` (`main-view.ts:2193-2312`) | Home readiness action (`home-view.ts:2068`) or `acwr-reduce-btn` | Suggester, capped by overshoot TSS | Yes |
| P6 | Day-before timing check (`timing-check.ts`), run on every sync (`stravaSync.ts:162`, `activitySync.ts:52`) | ≥ 50 TSS the day before a threshold, VO2 or long run | Signal B TSS (fixed ÷15000) | Yes, suggestion only |

**Never reached in production** (only tests or re-exports use them): `matcher.ts`, `load-matching.ts`, `planSuggester.ts`, `isExtremeSession`, `renderExcessLoadCard`/`wireExcessLoadCard`, `_triggerCarryoverToNextWeek`, `openAdjustWeekModal` (`activitySync.ts:176`), and the modal's `crossTrainingCtx` header.

**HIIT never reaches the suggester.** Strava `hiit` becomes `"HIIT"` (edge function `index.ts:243`). `mapGarminType` turns that into `'gym'` (`activity-matcher.ts:52-53`). Gym overflow is logged as a standalone activity with no plan impact (`activity-review.ts:1658-1665`, `:1175-1184`). HIIT only reduces runs indirectly, in two ways:
- It adds to Signal B. That can trip P4, which then builds a synthetic activity: `iTrimp = excess × 150`, sport `cross_training` (`excess-load-card.ts:329-333`).
- It can trigger the P6 timing check.

---

## 2. Step-by-step trace (Strava ride)

| Step | Function (file:line) | Input currency | Formula / constants | Output |
|---|---|---|---|---|
| 1 | Edge function standalone mode (`sync-strava-activities/index.ts:1129-1164`) | HR stream | Banister iTRIMP = Σ seconds × HRR × e^(β·HRR). Falls back to avg HR × duration (`trimp.ts:99-111`). **No HR means `iTrimp = null`** | `row.iTrimp`, raw |
| 2 | `resolveITrimp` (`activity-matcher.ts:385-397`) | raw iTRIMP | Uses the row value, else the summary formula | raw iTRIMP |
| 3 | `matchAndAutoComplete` (`activity-matcher.ts:714-742`) | raw iTRIMP | Current-week non-run activity goes to `garminPending`, marked `__pending__`. **Nothing is cut here.** | pending item |
| 4 | `processPendingCrossTraining` (`activitySync.ts:113-169`) | none | Batch (≥3 items, any run, or >24h old) goes to the Review screen (P3). Otherwise to `autoProcessActivities` | routing |
| 5 | `autoProcessActivities` (`activity-review.ts:1667-1760`) | none | Try a named recurring slot, then the nearest generic cross slot. Otherwise the item is **overflow**: logged as a standalone activity (`addAdhocWorkoutFromPending`, which adds raw TSS to `wk.actualTSS`, `activity-matcher.ts:1159-1163`) and added to `unspentLoadItems` with `aerobic = aerobicEffect ?? 1.5`, `anaerobic = anaerobicEffect ?? 0.5` (`activity-review.ts:719-720`). **These fallbacks are Garmin Training Effect values (0–5 scale), not loads.** | overflow |
| 6 (P1) | Tier 1 (`activity-review.ts:1777-1815`) | Signal B TSS: `computeWeekRawTSS` uses iTRIMP×100/personal normaliser (`fitness-model.ts:289,449`), or `min × TL_PER_MIN[rpe]` | excess = week Signal B + carried load − `s.signalBBaseline`. If 0 < excess ≤ 15: first unrated easy run loses `round(excess / 5.52, 1)` km (5.52 = `TL_PER_MIN[4]` × 6 min/km) | easy km cut |
| 7 | `buildCombinedActivity` (`activity-review.ts:1918-1956`) | raw iTRIMP | Sums raw iTRIMP across items. Calls `createActivity(..., iTrimp)` **with no Garmin loads**, so `fromGarmin = false` (`activities.ts:106`) and Tier A is unreachable | CrossActivity |
| 8 | `computeUniversalLoad` (`universalLoad.ts:256-400`) | **Tier A+: raw iTRIMP**. Tier B: zone minutes × [1..5]. Tier C: `min × LOAD_PER_MIN_BY_RPE[rpe] × mult × activeFrac × 0.8` | A+: `base = iTRIMP × mult`, split 85/15. `FCL = base × recoveryMult`. `RRC = 1500·(1−e^(−base·runSpec·goalFactor/800))`. `goalFactor` for marathon = 1.05 − 0.2·anaerobicRatio (`universal-load-constants.ts:216`). `eqKm = min(25, RRC/12)` | FCL, RRC, eqKm |
| 9 | Planned-run load (`generator.ts:201` → `load.ts:95-101`) | planned min × `LOAD_PER_MIN_BY_INTENSITY[r]` (`sports.ts:165`) | aerobic/anaerobic by workout profile. Suggester weights anaerobic ×1.5 (`suggester.ts:223`) | load units |
| 10 | `computeSeverity` (`suggester.ts:277-301`) | FCL ÷ Σ planned weighted load | ≥0.55 extreme (3 changes), ≥0.25 heavy (2), else light (1). Without HR, ≥90 min at RPE ≥6 also counts as heavy | number of changes |
| 11 | `classifyWorkoutType` (`universalLoad.ts:540-590`) | iTRIMP/15000 as TSS/h, or zone split | Only used to rank candidates (+0.20 same zone, −0.10 opposite, `suggester.ts:441-449`) | ranking |
| 12 | Budget (`suggester.ts:1024-1047`) | RRC in load units, mixed with TSS | `effectiveRRC = RRC + min(RRC·(recMult−1), 20·15)`. If a TSS cap is passed: `× min(1, maxReductionTSS / (eqKm × easyPaceMin × 0.92))`. Cap fraction ≤0.35 forces light; ≤0.65 turns extreme into heavy; Replace is disabled whenever the severity was dampened | budget |
| 13 | `buildReduceAdjustments` (`suggester.ts:478-685`) | load units | Easy: `min(budget/(load/km), 40%, floorSlack)`, floor 4 km. Long (heavy/extreme only): 25%, floor 10 km, or 85% of the run if the km floor is active. Quality: one step down (`downgradeType`, `:339-353`). The km floor applies only when ACWR is safe or low (`:500`) | changes |
| 14 | `buildReplaceAdjustments` (`suggester.ts:691-881`) | load units | Replace the cheapest non-long run if budget ≥ its load, alternating with a reduce (easy 50%, long 30%) | changes |
| 15 | `showSuggestionModal` → `applyAdjustments` (`suggestion-modal.ts:323-331`, `suggester.ts:1243-1365`) | none | The user picks Replace, Reduce or Keep. Changes are stored as `workoutMods`. The P2/P3 callback then **adds `iTRIMP/15000 × runSpec` to `wk.actualTSS` a second time** (`activity-review.ts:1293-1296`, `:1901-1904`) | plan changed |
| 16 (P6) | `applyTimingDowngradesFromWorkouts` (`timing-check.ts:142-214`) | iTRIMP×100/**15000** (fixed), or `min × 0.92` whatever the RPE (`:88-91`) | Day before: 50–74 TSS → 1 step; 75–99 → 1 step −10%; 100–124 → 2 steps −15%; 125+ → 2 steps −25% | suggestion |

---

## 3. Worked example (marathon goal, easy pace 5:30/km)

I checked these numbers with a temporary vitest probe calling the real functions. The probe file has been deleted and `git status` is clean.

**Planned week** (easy and long runs are RPE 3 and threshold is RPE 7, from `intent_to_workout.ts:54,76,90`):

| Run | Minutes × rate | Aerobic / anaerobic | Weighted load |
|---|---|---|---|
| Easy 8 km | 44 × 1.2 | 50 / 3 | 54.5 (6.81 per km) |
| Threshold "2 km WU / 27 min @ 4:30 / 2 km CD" (parses to 8.9 km) | 49 × 3.5 | 120 / 51 | 196.5 |
| Long 20 km | 113.3 × 1.2 | 122 / 14 | 143 |
| **Weekly run load** | | | **394** |

### A. 60-minute ride with HR, iTRIMP 9000

Signal B: 9000 × 100 / 15000 = **60 TSS**.

Tier A+ (cycling: mult 0.75, runSpec 0.55, recoveryMult 0.95):
- base = 9000 × 0.75 = **6750** (aerobic 5737.5 / anaerobic 1012.5)
- FCL = 6750 × 0.95 = **6412.5**
- raw credit = 6750 × 0.55 × 1.02 = 3786.8, so RRC = 1500 × (1 − e^(−4.73)) = **1486.8**
- eqKm = min(25, 123.9) = **25 km**. The modal shows "≈ 25 km easy running equivalent" for a 60-TSS ride.
- Severity: 6412.5 / 394 = **16.3**, so **extreme** (3 changes).

Candidate order: easy (0.606), long (0.574), threshold (0.473).

| Path | Reduce | Replace |
|---|---|---|
| P2 (ACWR caution, km floor off) | Easy 8 → **4.8 km** (40% cap). Long 20 → **15 km** (25% cap). Threshold → **"steady"** (MP type at 5:00/km) | Easy **replaced (0 km)**. Long 20 → **14 km**. Threshold → steady |
| P3 (ACWR safe, floor 26 km active) | Easy → 4.8. Long → **17 km** (85% floor). Threshold → steady | Easy replaced. Long → 17.1. Threshold → steady |

The changes use 99.6 of a 1486.8 budget (7%), so the caps did all the work.

### B. The same ride with no HR, RPE 6

Tier C:
- 60 × 2.7 × 0.75 × 0.95 × 0.8 = **92.3** (aerobic 78.5 / anaerobic 13.8)
- FCL = **87.7**
- RRC = 1500 × (1 − e^(−51.8/800)) = **94.1**, which is higher than both FCL and the base load
- eqKm = **7.8**
- Severity: 87.7 / 394 = **0.22**, so **light** (1 change)

Result: **Reduce** = easy 8 → 4.8 km only. **Replace** = easy run replaced (54.5 ≤ 94.1).

In practice `deriveRPE` gives a Strava ride without HR **RPE 5**, not 6 (`activity-matcher.ts:264`). At RPE 5: RRC 70.2, eqKm 5.9, same outcome.

**Same ride, with vs without HR: 3 sessions changed vs 1.** The only reason is the missing unit conversion.

### C. P4 "Adjust plan" with 30 TSS excess (ACWR safe)

- **With HR:** cap-TSS = 25 × 5.5 × 0.92 = 126.5, so the fraction is 0.237 and the budget is 352.6. Severity drops to light and Replace is suppressed. Result: easy 8 → 4.8 km, which removes about 11 TSS (at `TL_PER_MIN[3]`) for a 30-TSS excess. The number of runs touched goes up in steps of excess: ≤ 44 TSS → 1 run, 44–82 → 2, > 82 → 3 with Replace allowed again.
- **Without HR:** `avgRPE` comes from the summed Training Effect fallback 1.5, which gives RPE 4 (`excess-load-card.ts:289`). RRC is 57.6, the cap fraction is 1 (no cap), and the result is easy → 4.8 km, or Replace the easy run.

### D. P1 silent trim

If the ride leaves the week 10 TSS over `signalBBaseline`, the easy run loses 10 / 5.52 = **1.8 km** (8 → 6.2 km).

### E. P6 timing check

- Ride on Wednesday (60 TSS with HR, or 55 TSS without HR because 60 × 0.92) → Thursday's threshold gets the suggestion **"marathon pace"**.
- Ride on Saturday → Sunday's 20 km **easy** long run gets the suggestion **"marathon pace", RPE 6**. That raises the intensity (see bug B1 below).

---

## 4. Unit inconsistencies (most serious first)

1. **Raw iTRIMP is treated as load units** (`universalLoad.ts:106`). It is about 75× the Tier C and planned-run scale. Consequences:
   - Any HR-tracked cycling session over about 4 minutes counts as "extreme".
   - The 25 km equivalent is always shown.
   - Replace is always affordable.
   - The synthetic path makes the same mistake: `iTrimp = excess × 150` converts TSS back into raw iTRIMP (`excess-load-card.ts:332`).
   - No test covers Tier A+ or the suggester with iTRIMP. The iTRIMP tests only exercise `classifyWorkoutType`.
   - The fix needs a conversion factor (iTRIMP → TSS → load units). The code's own tables imply about 1.8–2 load units per TSS (`LOAD_PER_MIN_BY_INTENSITY` vs `TL_PER_MIN`), but no such constant exists in the code yet. Tristan should set it.
2. **The saturation curve amplifies small credits.** `CREDIT_MAX/TAU` = 1500/800 = 1.875 is the slope at zero, so every normal-sized session gets RRC ≈ 1.8 × raw (94.1 from 51.8). In practice this cancels the cycling runSpec discount (0.55 × 1.82 ≈ 1.0). `SCIENCE_LOG.md:748` says a "typical hard session" is 500–800 raw RRC, but Tier C never produces that (60 min at RPE 6 gives 52).
3. **`EASY_LOAD_PER_KM = 12`** (`universal-load-constants.ts:228`), but the real planned easy load is 6.8 per km. On top of that, the 25 km clamp breaks the TSS cap: the cap fraction is computed from the clamped km but applied to the unclamped RRC (`suggester.ts:1031-1038`).
4. **Hard-coded conversions in the suggester:** 0.92 TSS per minute (`suggester.ts:1033`) and `20 × 15` "load units per TSS" (`:1025`).
5. **Different iTRIMP→TSS normalisers.** Signal B uses the personal LTHR normaliser (`fitness-model.ts:289`). Timing (`timing-check.ts:89`), `actualTSS` (`activity-matcher.ts:519,792,1050,1161`), `activity-review.ts:1294,1902`, `excess-load-card.ts:222,367` and `classifyByITrimp` (`universalLoad.ts:495`) all use a fixed 15000.
6. **No-HR TSS depends on which path you're in.** For the same ride: 55 (timing: 0.92/min), 69 or 87 (Signal B: `TL_PER_MIN[rpe]`), 69 (unspent items at `TL_PER_MIN[5]`, `fitness-model.ts:476`).
7. **Training Effect values used as loads or RPE.** For Strava, where Training Effect is null, the RPE is picked from the **number** of activities: 1 → 4, 2 → 5, 3+ → 7 (`excess-load-card.ts:288-289`; `main-view.ts:2233` uses >3.5 → 7, else 5).
8. **Tier 1 assumes 5.52 TSS/km** (6:00/km at RPE 4), but the planned easy run is RPE 3 at the athlete's own pace (about 3.6 TSS/km). So Tier 1 removes only about 65% of the excess.
9. **Minor table drift.** `LOAD_PER_MIN_BY_RPE` vs `LOAD_PER_MIN_BY_INTENSITY` differ at RPE 3, 4, 6 and 9. Anaerobic weight is 1.5 in `suggester.ts:162` but 1.15 in `sports.ts:160`.

---

## 5. Other bugs found on these paths

- **B1 (confirmed by probe):** the timing check "steps down" an easy long run to `'marathon'` with RPE 6 (`timing-check.ts:52-55,41`), which raises its intensity. `'marathon'` is also not the workout type used everywhere else (`marathon_pace`).
- **B2 (likely):** accepting a timing suggestion saves `originalDistance: newDistance` (`plan-view.ts:2685-2686`). Also, `mergeTimingMods` rebuilds suggestions from the unmodified workouts. `'Timing accepted:'` doesn't match `isTimingMod`, so the suggestion comes back on the next sync (`timing-check.ts:234-268`).
- **B3:** `getWeekWorkoutsForReview` (`activity-review.ts:69-81`) and `getWeekWorkoutsForACWR` (`main-view.ts:2166-2190`) ignore existing `workoutMods`. A second session in the same week is judged against the original plan, and its change overwrites the first one (`plan-view.ts:1932-1950`, last change wins). Reductions never stack on P2, P3 and P5. P4 does apply existing changes (`excess-load-card.ts:54-62`).
- **B4:** `wk.actualTSS` is double-counted after a modal decision on P2/P3 (step 15). It feeds the main-view "Reduce this week" button trigger (`main-view.ts:2004-2017`) and the week-end zone carry (`events.ts:1023`).
- **B5:** P3's context has no `runnerType` (`activity-review.ts:1214-1221`), so Speed runners get intensity-first cuts on that path.
- **B6:** P1 compares against `s.signalBBaseline` (median of history, `stravaSync.ts:272`), while P4's row compares against `computePlannedSignalB`. The two can disagree about whether there is any excess.
# Appendix 2. Every other mechanism that adjusts sessions down

### How current sessions are adjusted down: full map

### Short answer to "is it iTRIMP?"
Only partly, and never directly. No mechanism shortens a session in proportion to iTRIMP.

- **Automatic changes:** the only ones that happen without the user tapping anything are in the plan engine: the ACWR status frozen at week advance, the effort score and deload weeks. ACWR is the only one of these that reads iTRIMP, through daily Signal B TSS. The effort score reads RPE and HR effort. Deload is a fixed calendar cycle.
- **Detection:** iTRIMP-based Signal B decides whether the excess-load and ACWR prompts appear, and whether a timing suggestion is raised.
- **Sizing:** once an excess prompt fires, the size of the cut is not proportional to iTRIMP. The suggester uses raw iTRIMP without normalising it, so the value saturates (bug 1 below).
- **Readiness:** sleep and HRV lower the daily target ring (display only) and unlock an "Adjust" button. They never change a session by themselves.

### Summary table

| # | Mechanism | Trigger | Signal | What changes | Auto or accepted | Live today? |
|---|---|---|---|---|---|---|
| 1 | ACWR at week advance | Debrief "complete" calls `next()` (week-debrief.ts:781). `computeACWR` runs at events.ts:1096 and sets `nextWk.scheduledAcwrStatus` (1103–1112). Caution is above the tier safe limit (1.30–1.50); high is above safe + 0.2 (fitness-model.ts:1164–1167) | Signal B, rolling 7d vs 28d; iTRIMP over personal normalizer where HR exists | Caution: one fewer quality session. High: two fewer, and the long run is capped at last week's minutes (plan_engine.ts:318–350). Frozen for the whole week | Automatic, silent | Yes |
| 2 | Effort score | `wk.effortScore` is computed at week advance (events.ts:944–991). The last 2 weeks are averaged (fitness-model.ts:234–244) | RPE deviation (user or HR-derived), blended 60/40 with HR effort | All session minutes × clamp(1 − 0.05×score, 0.85–1.15) (plan_engine.ts:113–115, 310–311) | Automatic, silent | Yes |
| 3 | Deload cycle | Every 3rd, 4th, 5th or 6th week by ability band (plan_engine.ts:89–97) | Calendar only | All minutes × 0.80–0.90 (99–107). Stacks with taper and effort | Automatic, silent | Yes |
| 4 | Holiday forced deload | Future holiday: weeks flagged `forceDeload` (holiday-modal.ts:409–418) | None | Same as #3 | Automatic | Plan tab only (plan-view.ts:1918) |
| 5 | Holiday render mods | Holiday active today (plan-view.ts:1974–1978) | None | No → rest. Maybe → optional run. Yes → quality becomes easy at 70% (holiday-modal.ts:506–557) | Automatic | Plan tab only |
| 6 | Post-holiday bridge | `showHolidayWelcomeBack` | Holiday-week TSS ÷ pre-holiday TSS | 1–3 weeks scaled 50–85%, quality removed, phase set to base | Automatic after the flow | Only via "End holiday early" (bug 6) |
| 7 | Illness | `illnessState.active` and current week (plan-view.ts:1964–1967) | None | Light: quality → easy at 50%, others 60%. Resting: all rest (illness-modal.ts:87–120) | Automatic | Plan tab only, buggy (bug 4) |
| 8 | Injury engine | `applyInjuryAdaptations` (generator.ts:222–231) | Pain / phase | Rehab or return-to-run replaces the plan | Automatic | **Not in Plan or Home** (bug 2) |
| 9 | Excess-load strip → modal | Signal B week + decayed carry − planned Signal B > 15 (plan-view.ts:1856–1885, 1867). Opens `triggerExcessLoadAdjustment` (excess-load-card.ts:256) | Signal B (iTRIMP); recovery trend × 1.0–1.5 (readiness.ts:487–500) | Suggester downgrades or reduces; "Garmin:" mods | User-accepted | Yes |
| 10 | Tier 1 auto-reduce | 1–2 non-run items ≤24h overflow, and 0 < excess ≤ 15 against `signalBBaseline` (activity-review.ts:1776–1816) | Signal B | First unrated easy run cut by excess ÷ 5.52 TSS/km | Automatic, with undo | Yes |
| 11 | Home "Adjust" button, ACWR branch | Readiness ≤ 59 (home-view.ts:1099), then ACWR caution/high or unspent items (2066) → `triggerACWRReduction` (main-view.ts:2193) | Signal B ACWR; synthetic activity | Suggester modal; "ACWR:" mods | User-accepted | Yes (bugs 5, 7) |
| 12 | Home "Adjust" button, recovery branch | Same button, other signals → `showRecoveryAdviceSheet` (home-view.ts:2219) | Readiness: sleep, HRV, TSB, strain | Convert to easy, run by feel, or move day (`applyRecoveryAdjustment`, events.ts:2304) | User-accepted | Yes (bug 3) |
| 13 | Timing downgrade | After each sync (stravaSync.ts:162, activitySync.ts:52): yesterday's single activity ≥ 50 TSS before a threshold, VO2 or long run | iTRIMP ÷ **fixed 15000** (timing-check.ts:88–96) | 1–2 steps down, 0/10/15/25% shorter (64–69) | Suggestion; user taps Apply (plan-view.ts:2662) | Yes (bug 8) |
| 14 | Skip / missed carry | Skip button (events.ts:723), or unrated runs at week end (events.ts:776–836) | None | Up to 2 carried. A hard carry becomes easy ≤8 km if next week already has ≥4 hard. The rest add a race-time penalty | Automatic | Makeups never shown (bug 9) |
| 15 | GPS extra run | In-app recording not matched to the plan (recording-handler.ts:173–215) | RPE / duration | Suggester modal; "GPS:" mods | User-accepted | Yes |
| 16 | 3+ week gap | `advanceWeekToToday` (welcome-back.ts:122–124) | Calendar | Landing week phase set to base | Automatic | Yes; VDOT loss is effectively dead (see below) |

**Ruled out, display-only or dead:**
- **Daily target (`computeDayTargetTSS`, fitness-model.ts:107–142):** ×0.80 on Ease Back, ×0.75 on Overreaching. It only moves the target ring (home-view.ts:878, strain-view.ts:278). No session changes.
- **Coach stance "reduce" (daily-coach.ts:336–345):** text only.
- **Leg-load decay (readiness.ts:40–110):** produces a note only. It is recorded only after the cross-training modal resolves, and stamped with `Date.now()` rather than the activity time (activity-review.ts:1298, 1906).
- **Check-in recovery debt:** `checkRecoveryAndPrompt` (main.ts:525) is never called, so `wk.recoveryDebt` is never written. The check-in overlay only offers Injured, Ill or Holiday.
- **Plan-tab recovery pill and "Reduce distance 20%" modal:** `buildRecoveryPill` (plan-view.ts:1334) is never rendered.
- **Other dead code:** `showWelcomeBackModal`, `generateRehabWeek`, `renderExcessLoadCard`, `_triggerCarryoverToNextWeek`.
- **`weekAdjustmentReason` ACWR banner:** only rendered in the legacy main-view (main-view.ts:2147). `renderMainView` now delegates to plan-view (main-view.ts:54).
- **Silent reductions:** intent `notes` ("Deload week", "ACWR caution…") are dropped by `intentToWorkout` (intent_to_workout.ts:29). So #1–#3 change sessions with no label anywhere in the live UI.

### Bugs found, most severe first

1. **Excess-load cuts don't scale with the excess.** `computeTierAPlus` sets base load to raw iTRIMP × sport multiplier, not TSS (universalLoad.ts:106). Credit then saturates at 1500, and equivalent km caps at 25. Every HR-tracked activity is rated "extreme". The overshoot cap uses the capped 25 km (suggester.ts:1033–1041), so it misfires.
   - Probe: a synthetic 20, 30 or 40 TSS excess (the excess-load card path with no unspent items, excess-load-card.ts:332) produced the same single cut every time: one easy run 8 → 4.8 km.
   - Separately, the target is `computePlannedSignalB` (history median × phase multiplier, fitness-model.ts:848–898). It is not the sum of the planned sessions, so doing exactly the plan can still register as "excess".

2. **The injury plan is not shown.** Plan (plan-view.ts:1914–1919) and Home (home-view.ts:1537–1542) pass `injuryState = null`. An injured user sees the normal plan plus a banner. Meanwhile the matcher (activity-matcher.ts:283, 300–307) and `next()` do apply injury adaptations, so workout IDs diverge.

3. **"Convert to easy" deletes most quality sessions.** `applyRecoveryAdjustment` reads the first "N km" in the description (events.ts:2353–2366). Probe over a 16-week plan:
   - Threshold, VO2 and float sessions with a warm-up line become **"1km @ easy"**.
   - Marathon-pace and float 8×2 sessions become "…@ MP… @ easy effort".
   - Separately, the easy-run name match picks the first "Easy Run" of the week (events.ts:2336–2341), so "Run by feel" can land on the wrong day.
   - "Rest today" only closes the sheet, although its copy says the session is carried (home-view.ts:2388–2391).

4. **Illness "Still running" does not do what its copy says.** Probe over 16 weeks:
   - Every marathon-pace session is untouched.
   - VO2 5×4 and float 8×2 are untouched.
   - Other VO2 sessions and fast-finish long runs keep their hard type.
   - Every converted quality session collapses to 2 km.
   - The cause is `QUALITY_TYPES` and the unanchored `…km` regex (illness-modal.ts:72, 77, 104). Home, the matcher and `next()` never see illness at all.

5. **ACWR ID divergence.** The matcher's `regenerateWeekWorkouts` omits `acwrStatus` (activity-matcher.ts:300–319). Probe with caution status: the Plan tab shows W6-easy-2 and no float. The matcher's list has W6-float-0 and no easy-2. Strava runs can match a session that isn't displayed, and one displayed easy run can never auto-match.

6. **The post-holiday bridge never fires when a holiday ends naturally.** main.ts:203–216 deletes `holidayState` whenever today is past the end date. That happens before `checkHolidayEnd()` runs at main.ts:307, which needs `holidayState.active`. So the bridge and holiday detraining only run via "End holiday early" (holiday-modal.ts:800–866).

7. **ACWR-modal mods can be silently lost.**
   - `getWeekWorkoutsForACWR` includes last week's makeup sessions, injury state and a different VDOT (main-view.ts:2166–2190). A makeup shifts every session's day (probe: marathon pace Tue→Mon, float Thu→Wed). Plan-view matches mods by name and default day (plan-view.ts:1938), so the mod never applies.
   - If projected load is under target, the button silently returns with nothing shown (main-view.ts:2292–2295).
   - All accept handlers call the legacy `render()`, which only writes to `#wo` (renderer.ts:524). Home and Plan are not refreshed after accepting. This last point is from reading code, not tested on device.

8. **Timing-suggestion problems:**
   - Marathon pace, float and fast-finish long runs (`progressive`) are never checked (timing-check.ts:29).
   - An accepted suggestion is lost if the session was dragged to another day. The button stores the moved day (plan-view.ts:240); matching happens before moves are applied (1938 vs 1956).
   - Home shows the shortened distance of a suggestion the user has not accepted (home-view.ts:1546–1548).
   - It uses a fixed 15000 normalizer instead of the personal one.
   - It can produce a new type `'marathon'`, which has no load profile.

9. **Skipped sessions vanish.** "Skip (moved to next week)" is never rendered, because Plan and Home pass `[]` for previous skips (plan-view.ts:1915). `next()` includes them anyway (events.ts:761), so these invisible makeups get carried again or penalised at week end.

10. **The debrief "Suggested plan" is not the plan the user gets.** The preview reads `nextWk.scheduledAcwrStatus` (week-debrief.ts:508) before `next()` sets it (events.ts:1105). So ACWR never appears in the preview. The effort score it uses also leaves out the week being closed.

11. **Systematic effort bias.** Auto-RPE from HR (activity-matcher.ts:226–240) rates any easy run above 50% HRR as ≥4, but easy and long runs are planned at RPE 3. Probe: HR 125–140 gives RPE 4, 145–150 gives 5. Users who accept the prefilled auto-RPE drift toward effort +0.5 to +1.5, which shortens all sessions by 2.5–7.5%. The matcher and the ACWR list use a 3-week effort lookback where Plan uses 2.

### Also noted
- **Home and Plan show different distances during `forceDeload` weeks**, because only plan-view passes the flag.
- **Tier 1 auto-reduce and the excess strip use different targets** (`signalBBaseline` vs `computePlannedSignalB`).
- **The taper excess target is fixed at 0.85** because callers never pass the week-in-taper.
- **The 3+ week gap sets the landing week to base on every launch**, even a taper week. The VDOT loss in `advanceWeekToToday` never applies, because the debrief cap keeps the actual advance at 0 (welcome-back.ts:104–119).
- **`rpeAdj` from `rate()`** only moves in the live UI via in-app GPS runs. Plan "mark done" passes the planned RPE, so it has no effect (plan-view.ts:2498). Strava and the RPE prompt write `wk.rated` directly.
- **Max HR in this path:** it enters through `deriveRPE`, which uses `s.maxHR || 220 − age` and resting HR defaulting to 55. `s.maxHR` is derived from the 95th percentile of Strava max HR only when it is unset (stravaSync.ts:144–156). So the 220 − age fallback still drives auto-RPE, and therefore the effort multiplier, for users with fewer than 3 HR activities. Once any max HR is set, it is never refreshed.

The probe results come from a temporary test, `src/calculations/zz_probe_adjustdown_7db4f2.test.ts`, which I have deleted; the working tree is clean. No other files were modified.
# Appendix 3. Verifier detail on the six earlier claims

### signalA-crosstrain (confirmed, confirmed, confirmed)

**Verifier 1:** Confirmed, and it is broader than stated. Every path that turns a synced non-run activity into a 'garmin-<id>' adhoc also writes wk.garminActuals['garmin-<id>'] carrying the same garminId. These are:
- review "Log only"
- gym overflow
- suggestion-modal keep/reduce/replace
- autoProcess overflow
- stale-pending resolution
- the past-week auto-log in matchAndAutoComplete, which the claim did not list and which is the path used for all history and backfill
- the enrich self-heal

computeWeekTSS counts garminActuals first at full iTRIMP with no runSpec, then its seenGarminIds dedup skips the adhoc copy. That makes the adhoc runSpec branch dead code for synced cross-training, so for these activities Signal A is the same as Signal B.

Cross-training matched to a planned cross or gym slot is also stored in garminActuals[slotId], so it is also counted at full weight.

It gets worse in one case. When the overflow is still sitting in unspentLoadItems, computeWeekTSS adds duration x 1.15 x runSpec on top, because it has no garminId dedup in that loop. Signal A then comes out higher than Signal B.

Rides and swims can never fill a planned run slot. Walk-class activities can: WALKING, HIKING, ROWING, KAYAKING, GOLF and PADDLEBOARDING map to appType 'walk'. These are treated as runs by findMatchingWorkout and can auto-complete a planned run in autoProcessActivities, where they land in garminActuals[runSlotId] at full weight.

*Reach:* This is hit by every normal Strava flow.
- **Past-week history and backfill:** every non-run activity auto-logs at activity-matcher.ts:689-712 and gets a garminActuals entry.
- **Current week, one same-day activity:** autoProcessActivities (activitySync.ts:163-168). No free cross slot sends the activity to overflow, which writes garminActuals, adhoc and unspentLoadItems. When ACWR is not caution or high (1818-1829), or on the Tier-1 silent reduction (1778-1812), the unspentLoadItems stay, so Signal A gets the +runSpec x 1.15 x duration extra. They stay until the excess-load card, Adjust week, or week-advance migration clears them.
- **Batch review (3 or more items, or older than 24h):** "Log only", gym overflow and the reduce/replace/keep modal all go through addAdhocWorkoutFromPending.
- **Planned cross or gym slot filled by a synced session:** stored at full weight.
- **Walk, hike, row, kayak, golf on the same day as a planned run (single-activity flow):** auto-completes the run slot at full weight.
- **Sessions predating these code paths:** the enrich path back-fills garminActuals for older 'garmin-' adhocs on the next sync, so historical weeks are converted too.

The only synced cross-training that still gets a runSpec discount in Signal A is a 'garmin-' adhoc whose DB row has neither iTrimp nor hrZones and was never given an actual. That is rare.

*Impact:* Per session, Signal A equals Signal B. The runSpec discount is lost:

| Session | Signal A with bug | Intended Signal A | Inflation |
|---|---|---|---|
| Cycling | 100 | 55 | +82% |
| Swimming (runSpec 0.20) | 100 | 20 | 5x |
| Yoga (runSpec 0.10) | 100 | 10 | 10x |
| Strength (runSpec 0.35) | 100 | 35 | ~2.9x |

While overflow sits unresolved in unspentLoadItems, a 60-min ride counts 138 in Signal A, which is above its Signal B of 100.

Probe of a cycling-only athlete, 3 x 60 min per week for 12 weeks, seed 0:

| Measure | With bug | Intended |
|---|---|---|
| Running Fitness (CTL/7) | 37.1 | 20.4 (+82%) |
| Stats TSB trend chart | -40.6 | -157.3 |
| ACWR trend chart | 1.16 | 2.10 |

Other user-facing effects:
- For mixed runners, the inflation scales with their cross-training share, and the week-debrief fitness value and delta move with it.
- Daily-coach tssPct is overstated relative to a planned value built from runSpec-discounted history.
- CTL has a step at plan start. The ctlBaseline seed from the edge function is discounted, but in-plan weeks are not, so a cross-trainer's Running Fitness climbs even at constant training.
- A walk or hike can mark a planned run done and count its full load as running fitness.

Not affected: VDOT, race predictions, athlete tier, the headline rolling ACWR and the Signal B readiness TSB.

**Verifier 2:** The claim holds, and the problem is wider than stated. Signal A (computeWeekTSS) counts every garminActuals entry at full weight, with no runSpec and no look at activityType. Every current code path that accepts a synced non-run activity writes a garminActuals entry that carries garminId. So the runSpec branch in the adhoc loop is effectively dead for Strava-synced cross-training: the adhoc copy is always deduped away. Three additions: (1) the most common path is the past-week auto-log inside matchAndAutoComplete, which the claim does not list; (2) slot-matched cross-training goes only into garminActuals[slotId], with no adhoc copy at all; (3) in the auto-process overflow path the activity is counted twice in Signal A, because the unspentLoadItems loop has no garminId dedup. matchAndAutoComplete never matches a non-run to a planned run. The one path that does is walks and hikes, which findMatchingWorkout treats as runs, so they fill and complete a planned run slot in autoProcessActivities and applyReview. Rides and swims never match run slots. VDOT, race predictions and athlete tier are NOT affected.

*Reach:* Yes, in every normal Strava flow.

1. Any sync that includes activities from earlier plan weeks (first connect or backfill when planStartDate is in the past, or the first sync after the week rolls over) auto-logs every ride, swim, gym or yoga session in those weeks through activity-matcher.ts 683-712. That path always writes the full-weight garminActuals entry.

2. Current week, single same-day activity: processPendingCrossTraining (activitySync.ts 163-167) sends it to autoProcessActivities.
   - A ride fills the nearest planned cross slot at full weight (activity-review.ts 1700-1721).
   - With no slot, it becomes overflow and is counted twice while the unspent item remains. That is the default case when ACWR is safe, because no modal is shown.
   - A walk or hike on the same day as a planned run fills that run slot, marks the run completed, and counts at full weight.

3. Batch of 3 or more, or older than 24h: showActivityReview then applyReview. Log only, slot match and the reduce/replace/keep modal all end in garminActuals.

4. Week advances with an unreviewed pending item: stale-pending resolution (activity-matcher.ts 440-515) or activity-review.ts 186.

The enrich pass (548-573) retroactively adds garminActuals copies to older adhoc-only cross-training on every sync whose rows include them. The only Strava non-runs that still get runSpec in Signal A are legacy adhoc entries whose row has no iTrimp or zones, or whose row is no longer returned.

*Impact:* Each accepted non-run adds TSS × (1 − runSpec) of extra Signal A.

Per-activity examples:
- 60-min ride at iTRIMP 15000: Signal A 100 instead of 55, so +45.
- Swim: +80% of its TSS. Yoga or pilates: +90%.
- Auto-process overflow while the unspent item remains: 138 instead of 55 for the same ride.
- Slot-matched ride with no iTrimp, RPE 5: 69 instead of 38.

Weekly example (probe E): 300 run TSS plus two such rides per week, from a 0 seed.
- Weekly Signal A: 500 instead of 410 (+22%).
- After 8 weeks, "Running Fitness" (CTL/7): 52.6 instead of 43.1 (+22%). Steady state: about 71 instead of 59.
- Stats TSB chart (weekly units): -131.6 instead of -197.9, about -19 instead of -28 daily-equivalent. The chart looks fresher than the model intends.
- Stats ACWR trend chart: 1.36 instead of 1.66. That can hide a caution or high reading on that chart. The live ACWR used for plan decisions is Signal B and is unaffected.

The week debrief "Running fitness" delta, the home momentum arrow and the daily-coach tssPct and ctlTrend are inflated or biased in the same direction.

VDOT, race-time predictions, athlete tier, the readiness score, freshness and the rolling ACWR used for plan adjustments do not change.

Separate side issue: the walk/hike to run-slot match also marks the planned run completed and adds the walk's km to week distance (week-debrief.ts ~124 sums garminActuals distanceKm).

**Verifier 3:** The claim is correct, and the problem is wider than it says. In computeWeekTSS (Signal A), the garminActuals loop runs first and counts every entry at full iTRIMP, or at full duration × TL_PER_MIN when there is no HR. It never applies runSpec and never checks the activity type. The adhoc copy, which is the only place Signal A applies runSpec to a synced activity, is then skipped by the seenGarminIds dedup. Every current flow that finishes a synced non-run activity writes a garminActuals entry, so synced cross-training is effectively never discounted in Signal A. Three additions: (1) cross-training matched to a planned slot (gym, named sport, or generic cross slot) is written only to garminActuals[slotId], with no adhoc copy, so it was never going to be discounted; (2) when a non-run activity is both logged as adhoc and put in unspentLoadItems (auto-process overflow, or the review "reduction" bucket), Signal A counts it twice: full iTRIMP, plus a runSpec-discounted duration estimate from unspentLoadItems, which computeWeekTSS does not dedup; (3) walk-type activities (walking, hiking, rowing, kayaking, paddleboarding, golf) can auto-complete a planned run slot and land in garminActuals at full weight. Cycling and swimming can never match a run slot.

*Reach:* This path runs in normal use. Every Strava cross-training activity in the current week follows this route: matchAndAutoComplete queues it as __pending__ (activity-matcher.ts:713-735), then processPendingCrossTraining (activitySync.ts:113-170) sends it to one of two places:
- autoProcessActivities: the default for a single activity from the same day.
- showActivityReview → applyReview: used for batches of 3 or more, or activities older than 24h.

Every outcome of both routes (slot match, log-only, gym overflow, overflow/reduction, accepting the suggestion modal) ends in a garminActuals entry. Past-week activities go straight to garminActuals (:693). On every sync, the enrich pass retrofits entries onto older adhocs within the 28-day sync window (stravaSync.ts:27-28, :51).

Only these escape the bug:
- Legacy adhocs older than the sync window with no actual entry.
- Manually added adhocs whose id doesn't start with 'garmin-'. computeWeekTSS ignores these completely (:342).

The walk-to-run-slot case needs a walk, hike, row or similar either on the same day as a planned run or within 15% of its distance. It also marks the planned run as completed (wk.rated).

*Impact:* Per activity, Signal A is inflated by 1/runSpec: cycling 1.82× (100 instead of 55), swimming 5× (100 instead of 20), strength 2.9×, walking 3.3×. For a cycling overflow item that also sits in unspentLoadItems, add +38 on top (138 instead of 55).

Worked example: 3 × 60-min rides/week at iTRIMP ~15k add about +135 weekly Signal A. The weekly EMA converges to that, so CTL/7 rises by about +19 points. That is enough to move the stats CTL card up about one band on its 20/40/58/75/95 daily-scale thresholds.

What is inflated:
- stats-view: CTL line chart (:1222), CTL metric page (:1851), CTL card with "Building…Elite" labels (:2929), fitness detail page (:1776).
- TSB chart (:2138): less negative for cross-trainers.
- ACWR trend chart (:2281): atl/ctl is understated.
- Week debrief CTL value and delta (week-debrief.ts:110-118).
- Home momentum history (home-view.ts:715-719) and daily-coach ctlTrend (:203-206). Both compare a Signal-B ctlNow against Signal-A history.
- daily-coach tssPct (:261-273): Signal A week TSS against planned.
- The computeACWR fallback path (fitness-model.ts:1186), used only when rolling data is unavailable and no Signal B seed exists.

What is not affected:
- The main ACWR, which uses the rolling Signal B.
- Readiness, freshness and same-signal TSB, which use Signal B.
- Athlete tier and ctlBaseline. These come from the edge function's historic totalTSS, which does apply runSpec (sync-strava-activities/index.ts:500-510; stravaSync.ts:257-316). This also means the seed and the in-plan weeks disagree, so CTL steps up at plan start for cross-trainers.
- VDOT and race predictions. Nothing outside fitness-model.ts and daily-coach.ts reads CTL.
- events.ts:1023 and holiday-modal.ts:388/919 mostly. They read wk.actualTSS first and only fall back to computeWeekTSS.


### normaliser-mismatch (partially_confirmed, partially_confirmed, partially_confirmed)

**Verifier 1:** The core claim holds, but only for users who have a Garmin LT heart rate. The history baselines (ctlBaseline, signalBBaseline, historicWeeklyTSS, sportBaselineByType) are always built with a fixed divisor of 15000. Every live plan-week number goes through normalizeiTrimp() without a norm argument, so it uses the module-level _athleteNorm. _athleteNorm differs from 15000 only when s.ltHR, s.restingHR and s.maxHR are all set, with rest < LT < max. s.ltHR is set in exactly one place, the Garmin physiology sync. Strava-only and Apple users always get 15000, so they see no mismatch. The sub-claim about the norm parameter is true in the code but has no effect today. The garminActuals branches of computeWeekTSS, computeWeekRawTSS, computeTodaySignalBTSS and getDailyLoadHistory ignore `norm`, while the adhoc branches use it. No production caller passes `norm`, so both branches resolve to _athleteNorm. The listed client 15000 sites (the matcher's wk.actualTSS, the enrich sanity check, calibrate) are real, but they do not feed CTL, ATL or ACWR. computeWeekTSS and computeWeekRawTSS recompute from raw data and never read wk.actualTSS. The mismatch matters more than the claim says in one place: the weekly excess-load check compares a personal-scale actual with a 15000-scale target, and that check is what reduces the remaining sessions. The size and the direction depend on the HR profile. It is not a fixed ~6%.

*Reach:* This is hit only by Garmin-connected users whose Garmin account has reported an LT heart rate. There are two routes. Garmin-only users get it via main.ts:449-467. Strava users with Garmin physiology get it via main.ts:419-428. Both call syncPhysiologySnapshot, which sets s.ltHR at physiologySync.ts:158. resting HR (physiologySync.ts:118) and max HR (physiologySync.ts:125) come from the same sync. Once they are persisted, main.ts:146 applies the personal normaliser on every launch. From then on every plan-week Signal A/B figure (Home, Plan, Stats, Readiness, Freshness, Injury Risk, the excess-load card) uses it. ctlBaseline, signalBBaseline, historicWeeklyTSS and sportBaselineByType keep the 15000 scale. They are rebuilt only at onboarding (strava-history.ts:52), when history is thin or was never fetched (main.ts:486-489), or on a manual backfill (account-view.ts:806/813). Strava-only users never get ltHR. Apple users never get it either: setAthleteNormalizer is imported in appleHealthSync.ts but never called. Both groups stay at 15000 with no mismatch. The branch inconsistency around the `norm` parameter is never hit, because no production caller passes `norm`.

*Impact:* The factor applies only to activities with HR-based iTRIMP. Duration fallbacks do not go through the normaliser.

For LTHR 170, rest 50, max 190: norm = 15,999. Live weeks come out at 0.938× the history scale, so the baselines are 6.7% high relative to live.

1. Rolling ACWR during the first 28 plan days, for identical training: ratio about 0.952 at plan day 7 and 0.968 at day 14. It is correct from day 28.
2. CTL seed: starts 6.7% high. The offset decays by 0.847 per week, so about 51% of it remains after 4 weeks and 14% after 12 weeks. Same-signal TSB is biased positive by about 3% of a week's load in week 1.
3. Excess load: for the same training as history, actual = 0.938 × plannedB. With plannedB = 350, about 22 TSS of real excess is hidden, which is more than the whole ≤15 TSS silent-reduction band.

The direction flips with the profile, and the break-even is hrr = 0.836:
- LT 160/50/190: live 1.17×. A history-equivalent 350 TSS week reads as 411, a phantom 61 TSS excess that can trigger session reductions.
- LT 155/60/185: 1.27×, a phantom excess of about 96 TSS on 350.
- An underestimated p95 max HR pushes hrr up and live down: LT 170/55/180 gives 0.77×, with about 80 TSS of real excess hidden on 350.

Female athletes with LTHR get about 19% less TSS than male athletes for the same threshold hour (80.7 vs 100 intended), because of the beta mismatch.

**Verifier 2:** The core mismatch is real, but only for one group of users. History-mode baselines are always computed with a fixed divisor of 15000: the edge fn totalTSS/rawTSS become s.historicWeeklyTSS, historicWeeklyRawTSS, ctlBaseline, signalBBaseline and sportBaselineByType. Live plan-week iTRIMP is divided by the module global _athleteNorm. That global differs from 15000 only when s.ltHR, s.restingHR and s.maxHR are all set, and s.ltHR is written in exactly one place: the Garmin physiology sync. So the mismatch affects Strava-connected users whose physiology source is Garmin and whose Garmin has pushed an LTHR. For Strava-only and Apple users the normaliser stays 15000 and there is no mismatch.

The effect is largest in the excess-load comparisons, not in the ACWR pre-plan fill. getWeeklyExcess compares live computeWeekRawTSS (personal scale) against computePlannedSignalB or signalBBaseline (15000 scale) in every week of the plan.

The sub-claims about the norm parameter and the other hardcoded 15000 sites need correcting:
(a) The garminActuals branch does ignore `norm` while the adhoc branch uses it. But no production caller ever passes `norm`, so both branches fall back to _athleteNorm. The inconsistency is latent, with no effect today.
(b) The stravaSync calibrate paths divide by 15000, and so does their only consumer, classifyByITrimp. They agree with each other, so there is no baseline mismatch.
(c) The enrich check at activity-matcher.ts:538 is only a coarse gate (more than 3 TSS/min). It does not scale load.
(d) wk.actualTSS is on the 15000 scale, but computeWeekTSS and computeWeekRawTSS ignore it. It never reaches CTL, ATL or ACWR.

*Reach:* The mismatch needs two things. First, Strava must be connected, because fetchStravaHistory is the only thing that sets the baselines (main.ts:487-489, the wizard strava-history step, and account-view.ts:806/813). Second, the physiology source must be Garmin and Garmin must have pushed an LTHR (main.ts:415-428). This is the Strava-plus-Garmin-watch setup.

Pure Strava users have no ltHR, so the normaliser stays 15000 and there is no mismatch. The same holds for Apple Watch users. Garmin-only users get the personal normaliser but no history baselines, so the two scales are never compared.

For affected users, the mismatch is hit on every render of these views:
- Home: excess and plan bar, same-signal TSB, ACWR.
- Readiness, freshness, injury risk and stats.
- The plan-view excess strip and the excess-load card.
- The activity-review overflow excess check.

The norm-parameter inconsistency is not reachable: no production call site passes norm. The enrich check and the calibrate paths do not create a baseline-vs-live scale mismatch.

*Impact:* Only iTRIMP-derived TSS is rescaled. Duration and RPE fallbacks ignore the normaliser.

For the example athlete (LTHR 170, rest 50, max 190), the normaliser is 15,999, so live weeks read 6.2% below the history-scale baselines. A 400 TSS history week reads as 375 live. The athlete must train about 6.7% above baseline before any excess registers.

The result is sensitive to max HR, and for Garmin users physiologySync sets max HR from the 95th percentile of per-activity max HR:
- Max HR 185: live reads 14.9% low.
- Max HR 180: live reads 23.3% low (400 becomes 307), so excess and "reduce sessions" prompts are suppressed until the week is about 30% above baseline.

In the other direction, a lower LTHR fraction inflates live weeks. LTHR 160/rest 55/max 185 reads 9.4% high, and LTHR 155/rest 50/max 190 reads 31.6% high, which produces phantom excess and low TSB.

The 15000 fallback corresponds to LTHR at about 83.6% of heart-rate reserve.

How long each effect lasts:
- Excess vs planned Signal B: every plan week, no decay.
- CTL seeds (Signal A ctlBaseline and same-signal signalBBaseline): the seed's weight decays ×0.847 per week, so it is still about 27% after 8 weeks.
- ACWR chronic pre-plan fill: only the first 4 weeks of a plan.

Separate, larger mismatch found while scanning: for activities without HR, history uses 0.70 TSS/min for running (edge fn getDurationFallbackTSS/getRawFallbackTSS). Live weeks use TL_PER_MIN[5] = 1.15/min (constants/sports.ts:16), which is 1.64× higher. This hits every user with no-HR activities, whatever the normaliser.

**Verifier 3:** Mostly right, but narrower than stated. The pre-plan baselines are always on the fixed 15000 scale. Live plan-week Signal A and Signal B use the module global _athleteNorm. That global differs from 15000 only when state.ltHR, restingHR and maxHR are all set, and in this code ltHR only ever comes from the Garmin physiology sync. So the mismatch only reaches users who have both Strava connected (the only source of ctlBaseline, signalBBaseline and historicWeeklyTSS) and a Garmin device supplying LTHR. Strava-only and Apple Watch users stay on 15000 everywhere and see no mismatch.

The hardcoded 15000 sites in activity-matcher (wk.actualTSS, the enrich sanity gate) and in stravaSync calibration do exist. None of them feeds the baselines or live CTL/ATL/ACWR, and the calibration path is internally consistent: its thresholds are compared by universalLoad, which also uses 15000.

The computeWeekTSS asymmetry is real: the garminActuals branches ignore `norm` and the adhoc branches honour it. No production caller passes `norm`, though, so both branches resolve to _athleteNorm and the asymmetry has zero current effect. It is a latent bug only.

*Reach:* The baseline-vs-live mismatch is reachable, but only for one group: users with stravaConnected (main.ts:487-490 backfill, then fetchStravaHistory sets the baselines) and a Garmin physiology source that delivers lt_heart_rate (main.ts:417-430 Strava+Garmin branch, or the Garmin-only branch at :465-467). ltHR also persists in state, so from the next launch main.ts:146 applies the personal normaliser immediately. For these users every ACWR, TSB, CTL and excess-load view is affected: home, readiness, plan strip, excess card, injury-risk and stats.

Strava-only and Apple Watch users never get ltHR, so _athleteNorm stays at 15000 and no mismatch occurs.

The garminActuals-ignores-norm asymmetry is not reachable today, because no caller passes norm. The wk.actualTSS, enrich and calibrate 15000 sites do not affect the baselines or live CTL/ATL/ACWR.

*Impact:* For the example profile (LTHR 170, rest 50, max 190) the normaliser is 15,999, so live weekly Signal A and B read 6.2% lower than the history scale for identical training (423 vs 451 TSS per week in the probe).
- Rolling ACWR is biased down by up to about 4 points (0.957 vs 0.996 around 10 days into the plan). The bias fades to zero once 28 days of plan data fill the window.
- CTL seeded from ctlBaseline drifts down by about 5% over 12 weeks, toward 94% of the seed. Displayed fitness declines slowly even though training is unchanged.
- Excess-load and reduction triggers compare the live week against a plannedB built from 15000-scale history. With a normaliser of 16k, the athlete has to exceed plan by about 6.7% more real load before excess registers.
- The direction flips with the profile. LTHR 160/45/185 gives a normaliser of 14,316, so live reads 4.8% high, which produces phantom excess and a higher ACWR.

The effect is much larger when maxHR sits close to LTHR. physiologySync.ts:125-128 unconditionally overwrites s.maxHR with the 95th percentile of activity max HR (sync-physiology-snapshot/index.ts:141-151), and this also replaces any manual entry. At LTHR 170 and rest 50, a maxHR of 180 gives a normaliser of 19,554 and live at 0.767× history (-23%). A maxHR of 172 gives 23,405 and 0.641× (-36%). If maxHR falls to or below LTHR, the normaliser silently reverts to 15000.

Related inconsistencies found while scanning, outside the literal claim:
- About 20 display sites hardcode 15000, so for personal-normaliser users per-activity TSS does not sum to the weekly totals. Examples: home-view.ts:136 and :214, strain-view.ts:151, :195 and :643, plan-view.ts:252 and :368, activity-detail.ts:102, renderer.ts:1018, main-view.ts:1614, :1676, :1697 and :2325, excess-load-card.ts:222 and :367, activity-review.ts:1294 and :1902, workout-insight.ts:136, sleep-insights.ts:358 and :372, timing-check.ts:89 and :94.
- The no-HR fallback also differs by scale. History uses 0.70 TSS/min for runs (index.ts:334 and :353). Live uses TL_PER_MIN[5] = 1.15 at the default RPE (fitness-model.ts:335-336 and :431-432, constants/sports.ts:16), so live reads 1.64× history. This hits Strava-only users too.
- rolling-load-view.ts:280-283, :297 and :487 pass atlSeed (ctlBaseline × gym multiplier) as signalBSeed. Every other computeACWR caller passes s.signalBBaseline, so the Rolling Load page can show a different ACWR from home and readiness during the first 28 days.


### max-hr (partially_confirmed, confirmed, partially_confirmed)

**Verifier 1:** The core claim is right, with corrections to the history and to when each path runs.

1. **History.** The code before commit 45d18ea did not use "median of top 5". It used the single all-time peak (`.limit(1)`). 45d18ea changed standalone mode to `.limit(5)` plus a p95 index. On 5 rows that index is 4, which is the single peak again. So the median-of-top-5 fix described in CHANGELOG 2026-04-07 was never in committed code, and standalone mode behaves the same as before the "fix".

2. **When the standalone fallback runs.** It is only used when `s.maxHR` is unset at the time of the call. When the client sends `max_hr_override`, that value wins in both standalone and backfill mode.

3. **Which max HR each user type gets.**
   - **Strava+Garmin:** p95 over every `garmin_activities` row. Each activity is stored twice (Garmin webhook row plus `strava-` row), so dropping one spike needs at least 41 rows, about 21 activities. Established users are protected; new users are not.
   - **Strava+Apple Watch and Strava-only:** `s.maxHR` is derived once, on the client, from the last 28 days. p95 equals the maximum whenever there are 20 or fewer HR activities, and the only filter is `< 230`. The value is never derived again, so one spike of 200–229 in the first 28 days stays in place until the user edits it.

4. **User-entered max HR.** It is overwritten on every physiology sync for Garmin users. It is not overwritten for Apple or Strava-only users.

5. **Stored iTRIMP.** It is never recomputed when max HR changes.

6. **First-ever sync.** If `garmin_activities` is empty and no max HR is set, the fallback is the latest `daily_metrics.max_hr` (a whole-day max) or else 190. The iTRIMPs from that sync are cached permanently.

7. **Where the error cancels.** For Garmin users with LTHR, the in-app TSS largely cancels a spike, because the normalizer uses the same max HR. History-mode TSS always divides by 15000, so the error passes straight through there.

*Reach:* **Strava+Garmin**
- Normal launches send `s.maxHR` as the override. That value is the p95 from the previous physiology sync, over all rows including duplicates.
- A single spike dominates only while the user has fewer than about 21 activities with a max HR stored.
- On the very first sync, before any physiology sync, `s.maxHR` is unset. Standalone then uses the top-5 maximum (the single peak), or `daily_metrics.max_hr` or 190 if there are no rows yet.
- A user-entered max HR lasts only until the next physiology sync. That happens on the next launch, a sync-button tap, or the sleep poller, which fires every 3 min while today's sleep is missing.

**Strava+Apple Watch and Strava-only**
- Physiology sync returns early at physiologySync.ts:97, so `s.maxHR` comes only from the wizard, the Account page, or the one-time client derivation.
- The first launch after onboarding fires backfill and standalone concurrently while `garmin_activities` is empty. Both fall back to 190, since these users have no `daily_metrics` rows. Every activity from 16 weeks of history is cached with that value.
- The client then derives `s.maxHR` from the last 28 days. That is the single highest reading under 230 whenever the user has 20 or fewer HR activities, which is typical at 3–5 sessions a week. The value is never re-derived.
- If a user has fewer than 3 HR activities in 28 days, `s.maxHR` stays unset and every standalone sync uses the top-5 maximum, which is the all-time single peak.
- A user entry is kept for these users, but it does not fix activities that are already cached.

**All users:** once an activity's iTRIMP is stored with zones, no later change to max HR ever corrects it.

*Impact:* Probe setup: male β=1.92, resting HR 50, true max 188, spike 216, 60-minute session.

| Avg HR | TSS, fixed 15000 normalizer (true → spike) | Ratio |
|---|---|---|
| 135 | 48.2 → 32.8 | 0.68 |
| 150 | 69.9 → 46.0 | 0.66 |
| 165 | 99.1 → 62.9 | 0.64 |
| 175 | 123.7 → 76.7 | 0.62 |

- **Under-count size:** a spike under-counts load by 32–38%, and the gap is largest on hard sessions. This applies to all Strava-only and Apple users (no LTHR, so the normalizer is 15000) and to history-mode TSS for every user, which feeds `ctlBaseline`, `historicWeeklyTSS` and `extendedHistoryTSS`.
- **Garmin users with LTHR:** when both the iTRIMP and the normalizer use the spiked value, in-app TSS ratios are 1.09, 1.05, 1.01 and 0.99, so the error mostly cancels.
- **Mismatched values:** if the iTRIMP was cached with the spike but the normalizer uses the current p95, the ratio is back to 0.62–0.68.
- **190 default when the true max is 175:** resting HR 55, iTRIMP ratio 0.74–0.78, meaning 22–26% under-count for history backfilled on first launch.
- **HR zones:** the same inflated max HR also pushes time into lower zones in the stored `hr_zones`.

The deployed edge functions could not be checked against the repo; this analysis assumes they match it.

**Verifier 2:** Every fact in the claim checks out in the code. The practical picture differs from what the claim implies, though. (1) The standalone top-5 path, which always returns the single highest value, only runs when the client sends no max HR, and that is uncommon. (2) The path users actually hit is the client-side derivation in stravaSync.ts:145-156. For Strava-only and Strava+Apple Watch users it sets s.maxHR to the single highest activity max HR of the last 28 days whenever that window has 20 or fewer HR activities. The value is then locked in and sent as max_hr_override on every later sync. (3) For Strava+Garmin users, s.maxHR is overwritten on every launch, and by the sleep poller, with the edge p95 over all garmin_activities rows. Once there are more than 20 rows a single spike is excluded, but a spike is still picked if spikes make up more than about 5% of activities. This overwrite also silently replaces a max HR the user typed in. (4) Stored iTRIMP is never recomputed when max HR changes. Activities processed under the old all-time-peak logic (before 2026-04-07) keep their compressed values permanently. For Garmin users the LTHR normalizer does follow the current max HR, so old and new activities end up on different scales.

*Reach:* STRAVA ONLY
- If max HR was entered at onboarding, that value is sent as the override for good. Physiology sync is not run at launch.
- If it was not entered, the first launch fires standalone sync and the 16-week backfill concurrently (main.ts:378/402 and :489) with no override. If the DB is empty, the edge function uses 190 (:750 and :1017; there are no daily_metrics rows for non-Garmin users). Those iTRIMPs are cached permanently. If rows already exist, it is race-dependent: the median below 5 rows, the maximum between 5 and 20.
- stravaSync.ts:145 then sets s.maxHR to the highest activity max in the last 28 days whenever there are 20 or fewer. A spike up to 229 is accepted and becomes the override for every future activity.
- Tapping Sync on the Readiness view recovery card calls sync-physiology-snapshot. That replaces s.maxHR, including a manually entered value, with the all-rows p95.

STRAVA + APPLE WATCH
- Same as Strava only. Physiology comes from HealthKit, which never sets maxHR.
- The Readiness Sync button appears only on days without a sleep score today.

STRAVA + GARMIN
- Launch runs syncStravaActivities with the previously persisted s.maxHR as override. At the same time, syncPhysiologySnapshot(28) overwrites s.maxHR with the all-rows p95. Garmin webhook rows and strava-* rows are both counted, so each activity appears twice.
- The sleep poller re-overwrites every 3 minutes until sleep data arrives.
- A manually entered max HR survives only until the next launch or poll.
- With 16 weeks of rows, a single spike is excluded; frequent spikes (more than 5% of activities) are not. The query is unordered and subject to the default 1000-row PostgREST cap (no max_rows in supabase/config.toml).

TOP-5 STANDALONE REGRESSION
- Hit only when s.maxHR is falsy: before the first derivation, when there are fewer than 3 HR activities in 28 days (derivation skipped on every sync), or when local state has been lost.
- In those cases every new activity gets the all-time highest DB value.

RELATED (race-dependent)
- A Strava+Garmin user with no override and no garmin_activities rows gets max HR from the latest daily_metrics.max_hr. That is that single day's peak (garmin-backfill/index.ts:189). On a rest day it can be well below true max, which would inflate every iTRIMP in the 16-week backfill.

SIDE FINDING
- Standalone selects "garmin_id, itrimp, hr_zones, km_splits, calories" (:1028) without hr_drift. So cached.hr_drift is always undefined, and :1172 re-fetches the HR stream for every cached run of 20 minutes or more on every sync. That eats into the Strava 100-request-per-15-minute limit.

*Impact:* Probe with resting HR 55, male, and the summary formula (the stream formula scales the same way). True max 186 against a 216 spike:
- 60 min at avg 150: iTRIMP 10506 vs 6595 (-37%). TSS at the 15000 normalizer: 70.0 vs 44.0.
- 60 min at avg 140: -35.5% (TSS 54.1 vs 34.9).
- 40 min at avg 165: -39.7%.
- Female: -33.5% to -37.3%.
- The 190 fallback against a true 186: -6 to -7.5%.

Strava-only and Apple users have no LTHR, so they take the full 35-40% compression of iTRIMP, CTL, ATL and ACWR inputs on every activity processed after a spike is locked in.

Garmin users with LTHR 170 get partial cancellation when stored iTRIMP and the normalizer use the same max HR (61.6 vs 65.1 TSS, about +6%). The problem is a mismatch. The normalizer follows the current s.maxHR, but cached iTRIMP keeps the max HR it was processed with:
- iTRIMP stored at 216, normalized at 186: 38.7 TSS instead of 61.6 (-37%). This is the case for rows processed before the 2026-04-07 fix.
- iTRIMP stored at 186, normalized at 216: 103.7 TSS (+68%).

So a max HR change splits history into two scales. That depresses CTL from old activities relative to new ones and biases ACWR upward, until old rows age out of the window. The fix never applied retroactively.

**Verifier 3:** The mechanism is real, but it hits user types differently. (1) Every p95 selector in the pipeline returns the single highest value whenever the pool has 20 or fewer rows (floor(0.95n) = n-1 for n <= 20). The standalone Strava edge-function path only ever sees 5 rows, so it always returns the all-time peak. That path only runs when the client sends no max_hr_override, meaning s.maxHR is unset (first sync or syncs). (2) Strava + Apple Watch and Strava-only users are the real exposure. s.maxHR is derived once, on the first sync where it is unset, as p95 of at most 50 activities from the last 28 days. For a typical runner (20 or fewer HR activities) that is the single highest reading. It is then fixed permanently because the derivation only runs when s.maxHR is falsy. If the DB is empty on the very first standalone or backfill call, the edge function uses a hardcoded 190. (3) Strava + Garmin users get s.maxHR overwritten on every physiology sync with p95 over ALL garmin_activities rows. Garmin webhook rows and strava-* rows for the same activity are both counted and never deduplicated. So a spike survives until there are more than 20 rows, or more than 40 if the spiked activity is stored twice. After the 16-week backfill it is normally rejected. (4) Physiology sync does overwrite a user-entered max HR for Strava + Garmin users. It does not for Apple or Strava-only users because of an early return. (5) Stored iTRIMP is never recomputed when max HR changes. The only exception is a guard for physically impossible values (above 3 TSS/min).

*Reach:* STRAVA + APPLE WATCH and STRAVA-ONLY (most exposed). If max HR was not entered in onboarding (the fitness-data step is optional), the first syncStravaActivities call (main.ts:402, or main.ts:378 on connect) sends no override. On an empty DB the edge function then computes every activity it processes with maxHR=190 and restingHR=55. The first standalone call and the 16-week backfill (main.ts:489) usually both run before any row exists, so a whole 16-week history can be computed with 190. The client then derives s.maxHR from the 28-day rows. With 20 or fewer HR activities that is the single highest reading, and it is fixed permanently (stravaSync.ts:145). Every later sync and backfill passes it as the override. Physiology sync cannot overwrite it (early return at physiologySync.ts:97), except for users who previously had Garmin, whose physiology_snapshots row still exists.

STRAVA + GARMIN. s.maxHR is refreshed on every launch, Sync tap and sleep-poll tick from the physiology p95 over all garmin_activities rows (duplicates included). A single spike dominates only while the pool has 20 or fewer rows (40 or fewer if double-stored). The startup 16-week Strava backfill usually lifts n well above that within the first session, so steady-state users are mostly protected. A user-entered max HR in Account is overwritten on the next launch or sync whenever data.maxHR is non-null. Standalone's top-5 path only runs for this group if s.maxHR is still unset, e.g. a brand-new user with no garmin_activities rows. In that case, 0 rows falls back to the latest single day's Garmin daily max HR.

ALL USERS: iTRIMP for any activity already stored with hr_zones is frozen at the max HR in force when it was first processed. Later corrections (user edit, larger pool) only affect new activities.

*Impact:* Probe, Banister male beta, rest 55, true max 188 vs spike 205, 60 min:
- iTRIMP ratio spike/true is 0.772 at 140 bpm, 0.759 at 150, 0.741 at 165 and 0.729 at 175. That is 23-27% low.
- With the fixed 15000 normalizer (Apple, Strava-only, or Garmin without LTHR): TSS 52.3 to 40.4 at 140 bpm, 67.6 to 51.3 at 150, 97.1 to 71.9 at 165, 122.4 to 89.2 at 175. CTL, ATL, ACWR and weekly load are understated by roughly a quarter.
- With a Garmin LTHR normalizer (LTHR 170) and the same max HR used consistently, the spike mostly cancels: 47.9 to 50.3 at 140, 89.0 to 89.7 at 165.
- The stale mix (iTRIMP stored at 205, normalizer later recomputed at 188) gives 47.9 to 37.0 at 140 and 89.0 to 65.9 at 165, so 23-26% low. This is exactly what happens when physiology p95 later drops but cached rows keep the old iTRIMP.
- The 190 fallback for a runner whose real max is 175 inflates the HRR denominator the same way. For one whose real max is above 190, it deflates it.
- The worst case is the daily-max fallback with a low value, e.g. maxHR=120: a 150 bpm run gives TSS 580 vs a true 68. The client guard does catch that on the next re-enrich, but a max HR of 150 gives 120 vs 52, which does NOT trip the guard (threshold 180).
- The HR zones stored alongside (calculateHRZones, % of max) shift toward lower zones by the same factor and are also frozen.


### stream-pause-dt (confirmed, confirmed, confirmed)

**Verifier 1:** Neither calculateITrimp in the edge function (supabase/functions/sync-strava-activities/index.ts:37-57) nor the copy in src/calculations/trimp.ts:36-58 limits dt. Each HR sample i is weighted by dt = time[i] - time[i-1]. If the Strava time stream jumps across a pause, the first HR sample after the pause gets credited for the whole gap. The only exception is when that sample's HR is at or below resting HR, in which case line 50 skips it. No cap exists anywhere in the pipeline.

The "moving" stream is not requested for non-runs; the request is just "heartrate,time". For runs it is requested, but it only feeds calculateKmSplits and never reaches calculateITrimp. So pauses are not excluded from iTRIMP for any sport.

Two corrections to the claim's framing:
1. The stream-based calculateITrimp in src/calculations/trimp.ts is dead code in production. Only its tests call it. The client imports calculateITrimpFromSummary alone. The live path is the inlined edge-function copy, which has identical logic.
2. A related and larger pause effect is certain from code alone: the avg-HR summary fallback uses elapsed_time, which includes pauses, as duration. It therefore credits the whole pause at average HR. The stream path credits it at the resume HR, which is usually lower.

*Reach:* **Stream path.** It runs for every Strava activity with HR that is not yet cached:
- Standalone mode, the normal Strava sync via src/data/stravaSync.ts: index.ts:1116-1139.
- Backfill mode, for up to 99 of the most recent uncached activities that have average_heartrate: index.ts:759-774 and 803-815.

It applies to all sport types. The inflation only happens if the Strava time stream actually jumps across a pause, and the code cannot show whether it does.

**Summary fallback.** Reachable whenever:
- the stream fetch fails (lines 842 and 1161),
- the stream lacks HR/time or their lengths differ (lines 821 and 1137),
- backfill is over its 99-stream budget or the user has no HR monitor flag (lines 768-773 and 888),
- or the client heals or resolves a null iTRIMP (activity-matcher.ts:394, 1076, 1089).

Every one of these uses elapsed_time, so any activity with a pause over-credits load. This part is certain from code.

**Cannot be determined from code alone:**
1. Whether Strava's time stream has gaps where the device auto-paused or was manually paused, or whether Strava fills or resamples those periods. The requests pass no resolution or series_type parameter.
2. What HR value the first post-resume sample carries. This is device-dependent: it could be the current HR, or a stale last-known value, which gives scenario D.
3. Whether Strava's average_heartrate is averaged over moving time or elapsed time.
4. Normal inter-sample spacing under Garmin smart recording (commonly 1 to 10 s). Any fix would need a cap chosen so it does not truncate ordinary samples. Per CLAUDE.md, no such cap value exists in the codebase and it would need Tristan's sign-off.
5. How often real users pause mid-activity. Watches with auto-pause off record through stops, which gives no gap. In that case HR is logged at its true, decaying value, which is physiologically fair.

*Impact:* **Stream path.** The size is bounded by the HR of the resume sample. Probe numbers (rest 55, max 190, normalizer 15000, 60-min easy run = 57.5 TSS):
- Traffic-light stop (60 s, resume 130 bpm): +0.6 TSS, about 1%. Negligible.
- 20-min cafe stop with a low resume HR (100 bpm): +5 TSS, about 9%.
- 20-min stop where the resume sample is still 145 bpm (a stale or elevated first sample): +19 TSS, about 33%.

Both Signal A (CTL, computeWeekTSS) and Signal B (ATL, ACWR, rolling load) use the stored itrimp, so the inflation flows into CTL, ATL, ACWR and the load-driven session reductions. hr_zones also gains the full gap, mostly in z1.

**Summary fallback.** It inflates by the ratio elapsed/moving at average HR. In the probe, a 20-min pause on a 60-min run gives 76.7 vs 57.5 TSS (+33%). This is a deterministic over-count whenever that path is used and the activity had a pause. For typical short stops on streamed activities, the stream-path error is small.

**Verifier 2:** The code facts in the claim all hold. The edge function's calculateITrimp (supabase/functions/sync-strava-activities/index.ts:37-57) weights each HR sample by dt = time[i] - time[i-1] and never caps it. Its only guard is `dt <= 0 → skip`. So when the Strava time stream jumps across a gap, the HR of the first sample after the gap (end-of-interval HR, hrSamples[i]) is credited for the whole gap. No dt cap exists anywhere in the repo. src/calculations/trimp.ts:49-56 has the same uncapped loop, but that calculateITrimp is not used in production: only trimp.test.ts imports it, and production imports only calculateITrimpFromSummary (activity-matcher.ts:10). The "moving" stream key is requested only for runs (index.ts:803, 1120). Non-runs request "heartrate,time", and the drift-heal fetch also requests only "heartrate,time" (1189). Even for runs, movingData goes only to calculateKmSplits (825, 1158) and never to calculateITrimp or calculateHRZones. calculateHRZones (86-95) has the same uncapped dt, so gap time is also added to the zone of the resume sample.

Correction to the implied severity: because the rule uses end-of-interval HR, the gap is credited at the resume HR. That HR has usually already recovered, so the stream path is close to what a device recording straight through the stop would produce (elapsed-time TRIMP). It adds modest load compared with moving time only. The larger pause inflation is in the summary fallback, which multiplies elapsed_time (pauses included) by average HR.

*Reach:* Yes, on the main sync path.
- Standalone mode: syncStravaActivities (stravaSync.ts:31-38) runs on app launch (main.ts:378, 402), from main-view.ts:2685 and from account-view.ts:1148/1167. For every Strava activity not yet cached with hr_zones, the edge function fetches the stream and calls calculateITrimp (index.ts:1116-1132).
- Backfill mode (stravaSync.ts:552): the 99 most recent HR activities take the same path (index.ts:759-815).
- The result is stored in garmin_activities.itrimp and reused from cache on later syncs (index.ts:1099-1101). A gap-inflated value is therefore permanent and flows through normalizeiTrimp into Signal A/B, CTL/ATL and ACWR.
- The gap only arises when the time stream actually jumps. That is expected for device-paused recordings (manual pause or auto-pause), which apply mainly to runs and rides. Runs have the moving stream available but unused for iTRIMP. Non-runs do not request it at all.
- The summary fallback, which uses elapsed_time, is hit for backfill activities beyond the 99-stream budget (index.ts:889), for stream-fetch failures (843, 1163), for activities with avgHR but no HR stream (821, 1137), and on the client when a row has no itrimp (activity-matcher.ts:394).

Cannot be determined from code alone:
- Whether Strava's time stream contains a jump across paused sections, or keeps samples with moving=false. This is device and app dependent: Garmin FIT pauses stop recording, while phone apps without auto-pause keep recording.
- Whether Strava resamples streams when no resolution parameter is sent.
- How HR-strap dropouts appear: as time gaps, zeros (zeros are skipped by `hr <= restingHR`, index.ts:50) or carried-forward values.
- Whether Strava's average_heartrate excludes paused time.
- That Strava's elapsed_time includes pause time. This matches Strava's documented semantics but is not verifiable in this repo.

*Impact:* Stream path, relative to counting moving time only, using the illustrative inputs above:
- A 10-min paused stop in a 60-min run adds about +4 to +9 TSS (+6% to +13%), depending on resume HR (110 to 140).
- A 45-min paused cafe stop in a 90-min ride adds about +11 to +24 TSS (+17% to +38%).
- Relative to a device that records HR straight through the stop, the stream path is roughly equal: 71.4 vs 70.2 TSS for the 10-min stop. In the stream path this behaves like elapsed-time TRIMP rather than a gross error.
- hr_zones also gets the whole gap added to the resume sample's zone, typically Z1/Z2, which skews the displayed zone distribution toward easy.

Summary fallback (avgHR × elapsed_time): this is where pauses inflate load most.
- The 10-min stop costs +11 TSS (+17%).
- The 45-min cafe stop costs +31 TSS (+50%).
- It applies to every backfill activity beyond the 99 most recent HR activities, and to any activity whose HR stream fetch fails.

A per-sample cap is not a free fix. Normal Garmin smart recording spaces samples several seconds apart, and those intervals must still be credited (5 s sampling gives 67.6 TSS, the same as 1 Hz). Gating on the moving stream is the cleaner lever, but it is requested only for runs today.

**Verifier 3:** Neither calculateITrimp in supabase/functions/sync-strava-activities/index.ts nor the one in src/calculations/trimp.ts limits dt. Each interval (t[i-1], t[i]] is credited at hr[i]. If the time stream jumps across a pause, the whole gap is credited at the first HR sample after the pause. No cap or pause handling exists anywhere in the iTRIMP path.

The edge-function copy is the only one that runs in production. The trimp.ts version of calculateITrimp is imported only by its test file.

The stream request asks for 'moving' only for runs (keys=heartrate,time,distance,moving). Non-runs request only heartrate,time. Even for runs, the moving array only feeds calculateKmSplits and never reaches calculateITrimp or calculateHRZones.

A related gap has the same cause and is larger: the summary fallback multiplies avg HR by elapsed_time, not moving_time, so pause time is credited at average HR.

*Reach:* The code path runs on every normal Strava sync.

- Standalone mode: syncStravaActivities (src/data/stravaSync.ts:31-37) calls it. Each activity not yet cached with hr_zones gets its stream fetched (index.ts:1116-1139).
- Backfill mode: stravaSync.ts:552-553 calls it for up to 99 recent HR activities (index.ts:759-815).

Once written, the inflated itrimp is stored in garmin_activities. Standalone reuses cached.itrimp and does not recompute it (index.ts:1099-1101), so the value persists.

Whether a real inflation happens depends on the recording device and on Strava, which the code cannot show:
1. Whether Strava's time stream is elapsed-since-start with jumps across auto-pause or manual-pause periods, or keeps 1 s samples through the stop.
2. Whether the watch records HR while paused. If it does, there is no jump and the pause is credited at its actual, lower HR, which is physiologically reasonable.
3. Whether Strava resamples or downsamples streams by default (no resolution or series_type parameter is sent; see index.ts:218-224).
4. How often "smart recording" devices legitimately produce gaps of several seconds. Any cap must not clip those.
5. Whether Strava's average_heartrate is computed over moving time or elapsed time. This affects how wrong the elapsed_time summary fallback is.

A pause does not always inflate the number. When HR during the gap would have been above resting, crediting the gap at the resume HR partly approximates real recovery load. The distortion is largest after long stops with a high resume HR.

*Impact:* Per-activity iTRIMP, and therefore Signal A/B TSS, CTL/ATL and ACWR, rises in proportion to (pause seconds × resume-HR weight). The probe shows:
- About +5% for one 10 min stop in a 70 min run with recovered resume HR (110). That is about +4 TSS (78.8 to 82.7) at the default normalizer of 15000.
- About +11% if the resume HR is still elevated (140).
- About +7% for a 30 min café stop on a 3 h ride.

The summary fallback has a larger effect because it credits avg HR over elapsed_time: +16.7% for 10 min of pause in 70 min elapsed. This applies to activities outside the 99-stream budget, activities without an HR monitor flag, and activities whose stream fetch failed.

HR zone seconds (calculateHRZones) are inflated by the same gap, all put into the resume sample's zone.

The trimp.ts copy has no production impact because nothing outside its test file calls it.


### elapsed-time (partially_confirmed, partially_confirmed, partially_confirmed)

**Verifier 1:** Every Strava write path stores duration_sec as Strava elapsed_time: the standalone, backfill-stream and backfill-avg-HR loops all do it. moving_time is used only for pace. This is a documented, deliberate choice (docs/OPEN_ISSUES.md:346-348 says "elapsed_time for iTRIMP (correct — total physiological time)"). It does not touch the main HR-stream iTRIMP, which adds up the stream's own time gaps and never reads duration_sec.

Where duration_sec does feed load math, elapsed time pushes the numbers up in three places:
(1) the avg-HR × duration iTRIMP fallback, both in the edge function and on the client;
(2) every no-HR per-minute fallback;
(3) the unspentLoadItems term, which always counts by duration.

Two parts of the claim are wrong:
- **Planned-vs-actual duration comparisons:** none exist for Strava data. The run matcher uses only day and distance. The only duration comparisons are in dead code or in the manual-entry form.
- **Passive strain:** subtracting elapsed time takes away more minutes and steps. That lowers passive strain slightly; it does not inflate load.

*Reach:* **Duration stored as elapsed_time:** hit on every Strava sync. syncStravaActivities runs at launch (main.ts:378, :402) and on pull-to-refresh (main-view.ts:2685). Backfill runs at launch only if history was never fetched or is thin (main.ts:486-490), plus the Account "fetch/refresh history" buttons (account-view.ts:806, :813).

**Avg-HR × elapsed fallback:**
- Backfill: every HR activity outside the 99 most recent uncached ones. That applies to users with more than about 6 activities a week over 16 weeks, or anyone doing the 52-week backfill. Those rows are older than 28 days, so standalone sync never replaces them with stream values. They persist until another backfill and feed history mode (historicWeeklyTSS / extendedHistoryTSS, the CTL/ACWR baselines).
- Standalone: only on a stream fetch failure such as a Strava 429. That heals on the next sync, because the row is stored with hr_zones null, which triggers a stream refetch; the client Enrich loop (activity-matcher.ts:545-575) then overwrites iTrimp.
- Client healMissingITrimp: only actuals with avgHR but no iTRIMP.

**No-HR per-minute fallbacks:** users without an HR strap or watch, or individual activities with no HR. This covers history mode, week TSS, today's strain and timing-check.

**unspentLoadItems duration term:** every current-week cross-training overflow item, whether or not it has HR.

**Cross-training suggester:** every overflow cross-training review. Load comes from iTRIMP when present, but impactLoad and intensity classification use elapsed minutes.

**Passive subtraction:** Home, Strain and Readiness views whenever physiology activeMinutes or steps exist.

**Planned-vs-actual duration comparison:** not reachable from Strava. The run matcher never reads duration; the only duration comparisons are dead code (applyCrossTrainingToWorkouts) or the manual logActivity form.

*Impact:* Load is inflated by roughly the pause share of the session, but only on fallback paths. HR-stream users on recent activities are essentially unaffected.

**Avg-HR fallback, per activity:**
- Against avg-HR × moving time: +10% for a run with 6 of 66 min stopped, +17% for 10 of 70 min, +25% for a 30-min café stop on a 2.5 h ride, +33% for a 4 h hike with 1 h stopped.
- Against a model that counts the pause at 95 bpm: +8% to +16%.
- Example: a 60/70-min run reads 76 TSS instead of about 65-67.

**No-HR fallback:** scales exactly with elapsed/moving. A 60/70-min run gives 81 TSS instead of 69 in computeWeekRawTSS. In history mode the same run gives 0.70 × 70 = 49 instead of 42 TSS.

**unspentLoadItems:** 1.15 TSS per minute × elapsed minutes × runSpec, so each paused minute adds about 1.15 raw TSS.

**Passive strain:** goes down, not up. 10 paused minutes remove about 4.5 TSS (0.45 per minute), or about 1.7 TSS through steps. Probe: 27→23 passive TSS and 92→88 today's Signal B.

**Intensity classification:** longer elapsed time lowers TSS/hr and can shift a session from threshold to easy (80 TSS over 60 vs 75 min). This is partly offset because calibrate thresholds are also computed on elapsed time.

**Planned-vs-actual duration comparisons:** no effect, because none exist in the Strava flow.

**Primary HR-stream iTRIMP:** independent of the elapsed/moving choice. Pause gaps are counted at the first HR sample after the pause, a small effect.

**Verifier 2:** Every Strava activity's `duration_sec`/`durationSec` is Strava `elapsed_time`, in standalone, backfill and every client consumer. `moving_time` is only used to compute avg pace and is never stored or sent to the client. Because of this, pauses inflate three things linearly by the elapsed/moving ratio: (a) the avg-HR iTRIMP fallback, on the edge and on the client; (b) every no-HR duration fallback, on the client and in edge history mode; and (c) the passive-strain subtraction, which lowers passive TSS. The claim needs four corrections. First, no load path compares planned and actual duration for Strava activities. The real consumers are the planned-vs-actual TSS bars and the insight TSS ratio, and duration only matters there when there is no iTRIMP. Second, this is a documented, deliberate design choice (OPEN_ISSUES ISSUE-13), not an oversight. It holds up for real HR samples but not for the avg-HR or no-HR extrapolations. Third, the main HR-stream path counts pause time too, through uncapped dt across recording gaps. Switching `duration_sec` to `moving_time` alone would not make load moving-only. Fourth, per-minute calibrations divide by elapsed, so those numbers are deflated, not inflated.

*Reach:* - Every Strava sync writes elapsed time as duration: normal app-open sync (main.ts:378/402, main-view.ts:2685 → standalone) and first-connect or thin-history backfill (main.ts:486-489, account-view.ts:806/813).
- The effect only matters when elapsed > moving: outdoor GPS activities with auto-pause, traffic-light stops, standing interval recoveries, or café stops. Indoor or no-GPS sessions usually have equal times (Strava behaviour, not verifiable in the repo).
- The avg-HR × elapsed fallback is actually hit in three cases:
  1. Backfill: the older HR activities beyond the 99 most-recent uncached ones, which is common with 16 weeks of 6+ sessions/week. Activities in the 28-day standalone window that lack hr_zones get re-streamed on the next sync (index.ts:1099 else-branch). Older ones keep the avg-HR estimate permanently and feed history-mode weekly TSS, CTL seeding and baselines.
  2. Standalone when the stream fetch fails, e.g. Strava rate limiting (1162-1165).
  3. When avg_heartrate exists but the HR stream is missing or mismatched (1137-1138).
- The client-side resolveITrimp/healMissingITrimp fallback is rarely hit for Strava rows, because the edge already fills iTrimp. It mostly matters when the edge returned null.
- The no-HR duration fallback applies to every activity of users without an HR sensor, in weekly TSS, ACWR, today's strain, plan-view planned-vs-actual bars and cross-training TL/impact.
- The passive subtraction only applies to users with Garmin epochs or Apple Watch activeMinutes/steps (home-view.ts:758, strain-view.ts:192-214).
- The stream-gap inflation applies to every HR-stream activity with auto-pause gaps. That is the main path, so fixing the fallback alone would not remove pause time from load.

*Impact:* - Fallback paths scale exactly with elapsed/moving:
  - Typical urban run with 5–15% stopped time: +5–15% TSS per activity (probe: 60/70 min run at avg HR 150 goes from 65 to 76 TSS).
  - Long ride with a 45-min stop: +25% (116 to 145 TSS).
  - No-HR run at RPE5: 69 to 80.5 TSS.
- These feed Signal A (CTL) and Signal B (ATL, ACWR, today's strain) equally, so ACWR is only biased when the elapsed/moving ratio differs between the acute and chronic windows. Absolute CTL, ATL, weekly TSS and cross-training excess (which drives run reductions) are biased upward.
- The stream path is inflated less and depends on the HR at resume: +5 to +13% for one 10-min gap in a 60-min session.
- Passive strain moves the other way: about −5 TSS per 10 min of pause on wearable days (probe: 14 to 9). This partly offsets the upward bias in today's strain.
- Personal per-minute calibrations are biased low by the same ratio: tssPerActiveMinute, cross-training TSS/min and the iTRIMP zone thresholds.
- A planned-vs-actual duration comparison error does not exist for Strava activities. The visible symptoms are elapsed minutes shown as "Duration" and the TSS bars and insight ratio in no-HR cases.
- Separate from load: the autoProcess run path shows elapsed pace and computes pace adherence from it (activity-review.ts:1592-1603). Race forecasts use the elapsed time of the latest run (stats-view.ts:120-139), so predicted times come out slower in proportion to the pauses.

**Verifier 3:** Every Strava write path stores `duration_sec` as Strava `elapsed_time`, which includes pauses. `moving_time` is used only for pace. That elapsed value feeds four things: (a) the avg-HR iTRIMP fallback, on the server and the client; (b) every no-HR duration × rate fallback, plus the RPE-only cross-training load (Tier C) and impact load; (c) the passive-strain subtraction, which subtracts too much and so under-counts passive TSS; (d) several per-minute rates, which it pushes down rather than up. It does NOT touch the main load number for HR users when the stream fetch succeeds. There is no live planned-vs-actual DURATION comparison for Strava activities. The closest real comparisons are paceAdherence in autoProcessActivities, which works out pace from elapsed time, and the TSS ratio in workout-insight, which uses elapsed time only when there is no HR.

*Reach:* - **duration_sec = elapsed_time:** every Strava activity for every Strava user, in standalone sync on app open and in backfill (main.ts:489, account-view.ts:806/813, stats-view.ts:3099).
- **Avg-HR fallback:** reached in these cases:
  - Backfill, for HR activities beyond the 99 most recent uncached ones (:759-773).
  - Backfill, whenever the stream call throws. stravaGet throws on any non-OK status (:222). Each run costs a stream call plus a detail call, so a first 16- or 52-week backfill can hit Strava's rate limit partway through and drop later activities into the catch at :842-845.
  - Standalone, only when the stream fetch fails or the stream has no HR.
  - Client heal (healMissingITrimp), for actuals that have avgHR but no iTRIMP.
- **Main load path:** for a normal HR user whose stream fetch succeeds, iTRIMP comes from the stream, and duration_sec does not affect load at all.
- **No-HR fallbacks:** only activities with no HR (no monitor, or manual entries). For manual, treadmill, gym and indoor activities, elapsed and moving time are usually equal, so there is no effect.
- **Passive subtraction:** users who have Garmin or Apple activeMinutes/steps in physiologyHistory, viewed through the Strain view and today's Signal B.
- **Duration comparisons:** no live Strava flow compares planned and actual duration.
- **paceAdherence:** the elapsed-pace version is reached for current-week runs that matchAndAutoComplete did not auto-match and that then go through processPendingCrossTraining → autoProcessActivities (activitySync.ts:164/204).

*Impact:* - **Scaling:** every duration-based figure scales linearly with the elapsed/moving ratio. In the load math, duration is always a multiplier, and in the summary formula iTRIMP is exactly proportional to duration.
- **Easy urban run with 10% stopped time (60 vs 66 min):**
  - Avg-HR fallback: about +5.8 TSS (57.5 → 63.3).
  - No-HR fallback: +7 TSS (69 → 76).
  - Today's Signal B strain with 150 active minutes: 3 TSS lower (98 → 95), because passive time is over-subtracted.
- **Long run with a 20 min stop (120 vs 140 min):**
  - Avg-HR fallback: +19 TSS (+17%).
  - No-HR fallback: +23 TSS.
  - Today's Signal B: -9 TSS.
  - computePassiveTSS: 14 → 5.
- **Stream-computed iTRIMP** (the dominant path for HR users): 0 change, because it does not read duration_sec and already counts pause gaps through the time stream.
- **Per-minute rates** (TSS/hr intensity class, calibrated tssPerActiveMinute, and the cross-training TSS/min used for planned cross-training TSS): biased low by the same ratio, e.g. about 9% lower at 66/60, not higher.
- **Threshold gates:** elapsed time can also push activities over duration gates that change behaviour:
  - defaultsToIntegrate needs more than 45 min (activity-review.ts:132).
  - The no-HR severity levels need at least 90 or 120 min (suggester.ts:292/298).
- **paceAdherence:** for runs reviewed through autoProcessActivities, it is computed from elapsed pace. That makes the run look slower than it was, e.g. about 30 s/km slower at 10% stopped time on a 5:00/km run, and the value is never corrected.


### runspec-duplication (partially_confirmed, partially_confirmed, partially_confirmed)

**Verifier 1:** The duplication is real, and the two tables differ for most non-running sports. The claim is wrong about how the client uses runSpec, though. For Strava or Garmin cross-training that has been synced, computeWeekTSS applies no runSpec at all. Every sync path writes a garminActuals entry that carries the garminId. The garminActuals loop counts that entry first at full iTRIMP weight (effectively runSpec 1.0). The dedup check then skips the adhoc entry, and the adhoc branch is the only place that looks up SPORTS_DB. So live Signal A counts cross-training at 100%, while history-mode Signal A (ctlBaseline, historicWeeklyTSS) discounts it with getRunSpec. SPORTS_DB.runSpec only reaches computeWeekTSS in two cases: (a) unspentLoadItems, keyed by a third mapping (mapAppTypeToSport), which also double-counts because it is not deduped; (b) legacy adhoc entries that have no garminActuals entry. The two tables meet directly in computePlannedSignalB, which subtracts SPORTS_DB.runSpec from history totals that were discounted with getRunSpec. The no-HR fallbacks are not consistent with the client. The edge uses fixed per-sport rates that ignore RPE, from 0.15 to 0.70 TSS/min. The client uses TL_PER_MIN[RPE], which defaults to 1.15/min at RPE 5.

*Reach:* - **History path:** runs for every Strava-connected user. fetchStravaHistory is called on startup and in onboarding (stravaSync.ts:214). It sets ctlBaseline, historicWeeklyTSS, extendedHistoryTSS, signalBBaseline, sportBaselineByType and athleteTier, all using getRunSpec and the edge fallbacks.
- **Live path:** computeFitnessModel (fitness-model.ts:1265) calls computeWeekTSS for every plan week. All cross-training synced from Strava or Garmin goes through matchAndAutoComplete or Activity Review, which always creates a garminActuals entry. So in normal use the SPORTS_DB adhoc branch is effectively dead, and cross-training counts at 100% in live Signal A.
- **SPORTS_DB runSpec in normal use** is reached only in two places:
  - unspentLoadItems from the Activity Review reduction bucket or overflow (activity-review.ts:353, :584, :1754). This double-counts.
  - computePlannedSignalB, which drives the planned-TSS bar and excess detection in main-view, events, plan-view, week-debrief, excess-load-card, load-taper-view and home-view.
- **Adhoc branch reachability:** it is hit only for legacy state saved before the garminActuals entries were added, or for non-garmin-prefixed adhoc entries, which the branch skips anyway at :340.
- **No-HR fallbacks:** hit whenever garmin_activities.itrimp is null (edge history) or iTrimp is null on the client. That means activities with no HR, or a missing resting/max HR.

*Impact:* - **Biggest effect is the runSpec bypass, not the table differences.**
  - Example: a runner doing 180 raw TSS/week of HR-tracked cycling.
  - History Signal A counts it as 99/week (×0.55). Live computeWeekTSS counts it as 180/week.
  - Live weeks therefore feed CTL about 81 TSS/week more than the ctlBaseline seed assumed for the same behaviour. Because the CTL is a weekly EMA, CTL steps upward after plan start. The tier thresholds of 140, 280 and so on at stravaSync.ts:302-306 are only computed from the history side.
- **Table-only differences are smaller:**
  - 2 h/week nordic skiing at 60 raw TSS/h: history Signal A 90 vs 60 if SPORTS_DB skiing 0.50 were applied, a difference of 30/week.
  - Walking: 0.40 vs 0.30/0.35, about 10 per 100 raw TSS.
  - Strength: 0.30 vs 0.35, about 5 per 100.
  - Climbing: 0.40 vs 0.15, about 25 per 100.
- **computePlannedSignalB:** subtracts the wrong discount from the history baseline. Pilates is labelled "other" by the edge and discounted at 0.10 there, but the client subtracts 0.35. Skiing is discounted at 0.75/0.55 by the edge but subtracted at 0.50. Walking is discounted at 0.40 but subtracted at 0.30. This moves the planned-TSS target by a few to about 20 TSS/week, depending on volume.
- **No-HR fallbacks:** the client gives 69 TSS per hour at RPE 5 against the edge's 42 for a run (+64%). For cycling on the actuals path the client gives 69 against the edge's 24 (Signal A) or 36 (Signal B), roughly 2 to 3 times higher.
- **Overflow double count:** an overflow or reduction cross-training session is counted about 1.4× in live Signal A while the item sits in unspentLoadItems (1 h cycling: 138 vs 100).

**Verifier 2:** The runSpec values do live in two tables that disagree: getRunSpec() in supabase/functions/sync-strava-activities/index.ts and SPORTS_DB in src/constants/sports.ts. They differ for about 30 of the 53 Strava sport types. The edge function's no-HR fallbacks are also not consistent with the client's TL_PER_MIN fallbacks. They are a different model: a fixed per-sport rate with no RPE input, at 0.15 to 0.70 TSS/min. The client uses RPE-indexed TL_PER_MIN, which is 1.15/min at the default RPE 5. However, the claim that computeWeekTSS applies SPORTS_DB runSpec to live weeks is misleading in practice. Every Strava or Garmin cross-training activity the matcher logs as an adhoc workout also gets a garminActuals entry with the same garminId. computeWeekTSS counts the garminActuals entry first with no runSpec at all (effectively 1.0) and then skips the adhoc entry, which is where SPORTS_DB runSpec would have been applied. So live Signal A counts synced cross-training at full weight, while history Signal A (which feeds ctlBaseline) counts it at 0.10 to 0.75. SPORTS_DB runSpec is only actually applied to unspentLoadItems, through a coarse appType mapping, and to legacy adhoc entries that have no garminActuals entry. Overflow items that are also in unspentLoadItems are counted twice in Signal A.

*Reach:* Fully reachable for any Strava user who does cross-training.

1. History mode: fetchStravaHistory runs at onboarding and after backfill. It sets ctlBaseline and historicWeeklyTSS from the edge getRunSpec and fallback values.
2. Live weeks: every non-run activity from stravaSync goes through matchAndAutoComplete.
   - Past weeks go to addAdhocWorkout plus a garminActuals entry.
   - Current-week items go through Activity Review to addAdhocWorkoutFromPending, which creates both entries. Overflow is additionally pushed to unspentLoadItems.
   So computeWeekTSS counts synced cross-training in Signal A at full weight, with no runSpec at all rather than the SPORTS_DB values. computeFitnessModel (fitness-model.ts:1265) seeds CTL from the history value and continues it with computeWeekTSS, so both inconsistent sources feed the same CTL series.
3. The SPORTS_DB-vs-getRunSpec table difference itself only bites in two places:
   - unspentLoadItems, which exist until the excess-load card clears them
   - computePlannedSignalB, which feeds the plan bar, home, excess-load card and debrief targets through sportBaselineByType
4. The no-HR fallback mismatch applies to activities with no HR at all: no average HR and no stream.

*Impact:* - **Regular cyclist:** 3 x 60 min rides/week at iTRIMP 9000 each (60 raw TSS). History Signal A (edge) counts 3 x 33 = 99 TSS/week for them; live computeWeekTSS counts 180 TSS/week, 82% more. Because CTL is a weekly EMA (decay 0.847), CTL steps up toward about +81 once the plan starts, with nothing having changed physiologically. For a runner with 250 TSS/week of running, that is +23% (349 to 430).
- **No-HR ride, 60 min:** history Signal A = 24 and Signal B = 36; live A = B = 69, 2.9x on A.
- **No-HR easy run, 60 min:** 42 in history vs 55 to 69 live, +31% to +64%.
- **Nordic or backcountry skiing:** 0.75 in history vs 0.35 if SPORTS_DB were used (-53%). It is actually 1.0 live via garminActuals (+33% vs history).
- **Climbing:** 0.40 vs 0.15.
- **Overflow cross-training:** additionally double-counted in live Signal A, e.g. a 60-TSS ride shows as 98 (+63%) until the unspent items are cleared.
- **Normalizer:** history also uses a fixed 15000 normalizer (index.ts:501, :507), while live weeks use the personal LTHR normalizer when ltHR, restingHR and maxHR are set (main.ts:146). This adds a further boundary offset unrelated to runSpec.

**Verifier 3:** The core claim holds. runSpec is defined independently in the edge function (getRunSpec, sync-strava-activities/index.ts:307-326) and in SPORTS_DB (src/constants/sports.ts:47-71). The values differ for many sports, both table-to-table and, more often, because each side resolves activity types to a sport differently. The no-HR fallbacks are also inconsistent: the edge uses fixed per-sport rates, the client uses RPE-indexed TL_PER_MIN.

One part of the framing is wrong. The claim says SPORTS_DB is "used by computeWeekTSS for live weeks". For synced cross-training that is mostly false. Every client path that logs a cross-training activity also writes a garminActuals "twin" with the same garminId. computeWeekTSS processes garminActuals first with no runSpec at all, then skips the adhoc entry on the garminId dedup. The live-week Signal A runSpec for synced cross-training is therefore effectively 1.0, not SPORTS_DB and not getRunSpec.

SPORTS_DB runSpec in computeWeekTSS is only reached in three cases. (a) unspentLoadItems, keyed by a coarse appType-level sport and also double-counted. (b) Adhoc entries that have no twin. (c) computePlannedSignalB, which subtracts cross-training from edge-built historicWeeklyTSS using SPORTS_DB runSpec keyed by edge getSportLabel labels, so the subtraction does not match what was added.

*Reach:* Both paths run for every Strava user.

- **History (edge getRunSpec and edge fallbacks):** runs on startup via main.ts:486-489 whenever history was never fetched or has fewer than 8 weeks. It also runs from the onboarding wizard (strava-history.ts:52) and the account-view backfill (account-view.ts:806, :813). It sets historicWeeklyTSS, ctlBaseline and sportBaselineByType.
- **Live weeks (computeWeekTSS):** runs on every Strava sync through matchAndAutoComplete, for past-week cross-training, and through the Activity Review flow for current-week items. Both create garminActuals twins, so synced cross-training always takes the no-runSpec branch.
- **SPORTS_DB runSpec inside computeWeekTSS** is only hit in three cases:
  - unspentLoadItems from the review "excess load" overflow, with sport = mapAppTypeToSport(appType), i.e. cycling/swimming/walking/gym/generic_sport. These items are double-counted.
  - Legacy adhoc entries without a twin.
  - computePlannedSignalB, which feeds the plan-bar and excess target whenever sportBaselineByType exists.
- **Rare cases:**
  - WHEELCHAIR_PUSH_RUN and the Garmin *_WS ski types come only from the Garmin webhook.
  - Strava Basketball/Volleyball/Dance/Cricket fall through mapStravaType as upper-cased raw strings.

*Impact:* Per 100 raw TSS (iTRIMP 15000), Signal A comes out as follows:

| Activity | History (edge) | Real live flow | SPORTS_DB path if it were reached |
|---|---|---|---|
| Cycling | 55 | 100 | 55 |
| Nordic/backcountry ski | 75 | 100 | 35 |
| Strava hike (stored as WALKING) | 40 | 100 | 35 |
| Rock climbing | 40 | 100 | 15 |
| Elliptical | 40 | 100 | 35 via Strava, 65 via Garmin |

Worked example: an athlete doing 4 x 60-min rides of 100 raw TSS each. Their pre-plan history gives 220/week of cross-training Signal A. Once the plan starts, the same training counts 400/week. CTL (weekly EMA, alpha about 0.153) therefore climbs by about 28/week toward a level 180 higher. That is a spurious CTL jump at the plan boundary, not a fitness change.

Overflow items are counted twice in Signal A. A 60-min ride that goes to excess load counts 138 in Signal A versus 100 in Signal B.

No-HR fallback, 60-min ride: live 69 A / 69 B vs history 24 A / 36 B, roughly 2.9x and 1.9x. No-HR 60-min run: live 55-69 vs history 42.

computePlannedSignalB leaves residual cross-training in the "running-only" baseline because it subtracts at different rates than the edge added:
- 100 raw ski TSS/week: added 75, subtracted 50, so 25 TSS/week is misattributed to running.
- 90 raw walking TSS/week: added 36, subtracted 27, so 9 TSS/week remains.
- Pilates: added 10, subtracted 35 against the "other" label. That under-subtracts in the opposite direction, clamped at 0.

For the plain runSpec-table differences alone, the largest gaps are nordic/backcountry ski (0.75 vs 0.35), rock climbing and bouldering (0.40 vs 0.15), CARDIO (0.55 vs 0.35) and Garmin elliptical (0.40 vs 0.65). Cycling, swimming, yoga, soccer, rugby and rowing match.
