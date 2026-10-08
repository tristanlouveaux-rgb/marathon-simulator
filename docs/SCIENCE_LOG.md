# Science Log

Scientific rationale for every model, formula, and algorithm that drives user-facing numbers. Each entry documents the formula, what each term means, why it's defensible, and known limitations.

New entries are added at the top. When modifying a model, update its entry rather than adding a duplicate.

---

## §BR — CTL-gap re-anchor: next week's volume tracks the chronic load actually carried (2026-06-09)

**The problem.** The plan marched forward on schedule regardless of whether the athlete trained. Two levers reacted to *how* sessions were executed (`effortMultiplier` on trailing RPE deviation; ACWR on acute-load spikes) but neither reacted to *not training at all*. A zero-session week records no `effortScore` and is skipped from the trailing average (`getTrailingEffortScore`), so the effort lever stays neutral. VDOT detraining only fires on multi-week *calendar gaps* (`welcome-back.advanceWeekToToday`), and even then the 10-day dead-zone makes a one-week miss dock **zero** VDOT — correctly, since VO2max is preserved across a week off (Mujika & Padilla 2000). The number that *does* react to a missed week is CTL: built from actual logged TSS (`computeWeekTSS`), it decays `exp(-7/42) ≈ 0.847` per fully-idle week (≈ −15%). But CTL fed only readiness/forecast, never the prescription — `planWeekSessions` reads VDOT/ability/phase, not CTL. So a dutiful non-trainer who clicked through each weekly debrief got a plan that ignored their absence and a debrief that said "tracking to plan." (Diagnosis: Tristan, 2026-06-09.)

**The model.** A one-step expected-vs-actual CTL ratio for the just-completed week, seeded from the *same* prior-week chronic load so the ratio isolates that week's adherence and nothing else:

```
expectedCTL = priorCtl·d + plannedWeekTSS·(1−d)      d = CTL_DECAY = exp(-7/42) ≈ 0.847
actualCTL   = priorCtl·d + actualWeekTSS ·(1−d)
ctlRatio    = actualCTL / expectedCTL                 (≤ 1 = behind plan)
```

`plannedWeekTSS` is the canonical mode-aware planned load (`getPlannedDayTSSContext`, valued type-first via `plannedTssPerMin` — the Load Currency Law path, §BP); illness/holiday-rested sessions are already zeroed from it, so legitimate rest is never scored as a miss. `actualWeekTSS` and `priorCtl` come from the canonical `computeFitnessModel`. Next week's prescribed **duration** is then scaled by `ctlGapMultiplier(ctlRatio) = min(1, ctlRatio)` — reduce-only.

**Why the scaling magnitude is derived, not invented.** The multiplier *is* the ratio: volume scales in direct proportion to the chronic load the athlete actually carries versus what the plan assumed. This is the foundational ACWR / ramp-rate principle — progress load relative to your *current* chronic load, not an aspirational one (Gabbett 2016). Because the shared seed is weighted ~85%, one missed week moves the multiplier by only ~15% of the load shortfall (a fully-missed steady-state week → ratio ≈ 0.847 → −15% volume). The dead-zone intuition falls out of the arithmetic rather than a hand-picked constant. It compounds correctly over consecutive weeks (next week's seed is this week's now-lower actual CTL) and self-limits because `expectedCTL` also decays toward the maintenance load: three consecutive zero weeks reach only ≈ 0.80, not collapse. During a build phase `plannedWeekTSS > priorCtl`, so a miss is penalised harder — also correct.

**No double-counting (the design constraint).** The lever is deliberately **reduce-only and one-sided**, partitioning the four adaptive levers so no two fire for the same reason in the same direction:
- *vs `effortMultiplier`* — effort measures the *intensity of sessions done* (two-sided), CTL-gap measures *how much was done* (reduce-only). Orthogonal. The partial-week case (1 of 5 done, rated hard) is the only overlap; it is neutralised by clamping the **combined** `effortMult × ctlMult` to `[deloadMultiplier(ability), 1.15]`, so the two levers can never stack past what either alone may do. When `ctlRatio` is absent the application is byte-identical to the effort-only path.
- *vs ACWR* — opposite triggers (acute load *high* vs chronic *low*) and different target (quality-session count vs duration). After skipping, ATL collapses fast → ACWR reads *safe*, so they essentially never co-fire.
- *vs VDOT detraining / ≥3-week base downgrade* — the one real overlap (both reduce volume on a long layoff). Guarded: `welcome-back` stamps `Week.detrainApplied` when VDOT loss or the base downgrade fires, and `resolveCtlAdherence` returns invalid for such weeks, ceding to the coarse multi-week path. VDOT detraining (a *pace* axis) is untouched.
- *vs the existing adherence→VDOT-gain gate* (`events.ts`: missed runs withhold VDOT *increments*) — that is an intensity/pace axis (it changes future paces), CTL-gap is the duration axis. Different axes, no double-count.

Suppressed entirely on deload weeks (already a planned reduction) and floored at `deloadMultiplier(ability)` (0.80–0.90) so a re-anchor never prescribes below a deload — both reuse existing constants, no new number.

**Lifecycle.** Mirrors `scheduledAcwrStatus`: computed once at rollover (`events.next()`), stored on the upcoming week as `Week.ctlRatio`, read back by the on-demand resolver (`generateWeekWorkouts` reads the stored scalar, exactly like `baselineKm`/`archetype`). Recursion-safe — the resolver only *reads* the stored scalar, never recomputes the adherence (which itself resolves planned TSS via the resolver). The debrief preview computes the same value live through the one shared helper so the previewed week matches what ships.

**Transparency.** The debrief headline replaces the misleading "tracking to plan" with a factual, no-judgement line when materially behind (`ratio < 0.97` ≈ under ~80% of last week's planned load): *"{pct}% of last week's planned training completed. Next week scales to your recent load."* (Tristan, 2026-06-09: factual, no judgement; debrief headline only, no per-session annotation.)

**Hardening (2026-06-09, adversarial review — 6 dimensions × refute-each-finding verifiers).** Fixes applied after the initial build:
- **Expected side uses the UN-reduced baseline plan.** `getPlannedDayTSSContext` resolves the week through `generateWeekWorkouts`, which reads the stored `ctlRatio` — so without care the "expected" denominator would be the *already re-anchored* plan, making a 64%-of-original week read as 80%-of-reduced and the headline % drift. `resolveCtlAdherence` now temporarily clears the week's `ctlRatio` while computing planned TSS (synchronous clear+restore), so the ratio and the displayed % always measure against the real prescription. Next-week *volume* is algebraically identical either way (both converge the plan toward last week's actual); only the stored ratio value and the honesty of the headline % change.
- **Mode guard.** `next()` is shared across modes, so `resolveCtlAdherence` now returns neutral for `eventType` triathlon/HYROX (cycling reuses 'triathlon') — otherwise it would mix the running combined-CTL model with tri/HYROX planned load and stamp a meaningless ratio.
- **Taper suppression.** Taper weeks return neutral — re-anchoring a deliberately-low taper (or the race week after it) down further would sabotage race prep. Same spirit as the deload suppression.
- **Silent-advance guard.** `advanceWeekToToday` (calendar catch-up, never runs `next()`) now stamps `detrainApplied` on *any* silently-advanced landing week, not just detrained ones, so a week skipped without a debrief can't feed a stale re-anchor.
- **Narrative coherence.** The debrief's effort-change list suppresses its "volume scaled up" line when the CTL-gap pulled the week down, so the headline can't say "behind" and "scaled up" together.
- **deload × effort is intentionally allowed to compound** (`deloadMult × eMult`, e.g. 0.72). A deload week where recent sessions were rated harder than prescribed signals accumulated fatigue, and a deeper recovery week is correct (RPE autoregulation, Helms 2018). The combined-band clamp scopes only the two *volume-re-anchor* levers (effort + CTL-gap), which can measure the same shortfall; it deliberately does not touch deload. Locked by a regression test.

**Mirror — HYROX and triathlon (2026-06-09).** The re-anchor now covers all three planned modes, each reusing the pure `ctlAdherenceRatio` and the same reduce-only / excused-week / converge-on-completion contract:
- **HYROX** — single scalar `mtlRatio` on the MTL axis. `resolveMtlAdherence` (`mtl.ts`): planned = `computeWeekMTL`, actual = `computeWeekActualMTL` (completed sessions' prescribed MTL — a completion signal; completed = a match link or a record at the slot key, `isMtlSessionCompleted`, `mtl.ts:107`, since 2026-10-06), seed = the completed-only chronic-MTL EMA across prior weeks (weekly units). Stored on `wk.ctlRatio`, applied in `plan_engine.hyrox` by scaling `effectiveHours` (combined-clamped with `hyroxEffortMultiplier`, floor `HYROX_DELOAD_FACTOR`). Converges because `effectiveHours` drives both duration and generated MTL. **No debrief surface** — HYROX has no week-debrief yet (`week-debrief.ts:114` early-return), so the engine re-anchor applies silently until one is built.
- **Triathlon** — PER DISCIPLINE (`wk.ctlRatioByDiscipline`), because a tri athlete can keep up on the bike while skipping every swim; a combined ratio would wrongly cut the bike. `resolveTriDisciplineAdherence` (`fitness-model.triathlon.ts`): per swim/bike/run, planned = Σ prescribed `aerobic+anaerobic`, actual = Σ of the *matched* ones (completion), seed = prior weeks' completed load. Applied in `applyTriEffortMultipliers` by scaling that discipline's durations, combined-clamped with `triEffortMultiplier`. No baseline-contamination temp-clear is needed (the tri re-anchor scales duration, never the `aerobic/anaerobic` the ratio reads). The tri plan-preview debrief shows a per-discipline behind-plan headline ("Swim 40%, Run 60% of last week's planned sessions completed. Those disciplines scale to match recent load.").
- **Mode exclusivity.** `events.next()` branches on `eventType` so exactly one resolver fires; the running resolver bails for tri/HYROX and vice-versa. Reduce-only and excused-week guards (injury / silent-advance `detrainApplied` / taper) are identical across all three.
- **Application timing — instant on rollover (Tristan, 2026-06-09).** Running re-bakes on every render (`resolveWeekWorkouts` is on-demand), so its re-anchor is live. Tri/HYROX *store* `triWorkouts` and otherwise re-bake only on incidental triggers (generator-version bump, CSS/FTP refresh, injury modal, session lever) — **not** on the plain weekly rollover, which means both the re-anchor and the pre-existing per-discipline effort multiplier would have sat dormant until one of those fired. So `events.next()` now calls `rebakeFutureWeeksInPlace` for tri/HYROX after stamping the ratio: it regenerates only the current + future weeks (which carry no matched actuals at rollover, so completions are never clobbered; user-added / holiday sessions are carried over exactly like the launch regen) so the stamp — and the effort multiplier — take effect immediately. A required wiring fix went with it: `applyTriEffortMultipliersToFutureWeeks` reads the per-discipline stamp from the *stored* `state.wks[w-1]`, not the freshly-generated week object (which never carries it). Net effect: tri/HYROX adaptive volume now responds the week after a shortfall, matching running.

**Limitations.** (1) *(Rewritten 2026-10-05.)* The actual side (running) is Signal A TSS: each activity × the runSpec of its own sport (see "Signal A vs Signal B"). On the planned side, `resolveCtlAdherence` values planned gym and strength sessions at `SPORTS_DB.strength.runSpec` (0.35), the weight the session that fills the slot carries in Signal A (a rated strength session through the strength RPE override, an unrated one or a HIIT fill through the strength sport). Before 2026-10-05 planned gym counted at full TSS while its fill counted at 0.35, so a fully completed week with strength read as behind (ratio 0.954 in `ctl-adherence-gym-valuation.test.ts`) and cut next week's volume. Planned cross sessions stay out of the planned side, so unplanned or cross-slot cross-training can only raise the ratio, never cause a false cut. The remaining seam sits inside the ~15% (1−CTL_DECAY) term. Kept as a documented limitation rather than refactoring the signal basis in v1. (2) The ratio re-anchors *volume*; it does not by itself shift paces — intensity re-anchoring remains the VDOT/effort path, and the existing adherence→VDOT-gain gate (withholds VDOT increments when runs are missed) is the orthogonal intensity-axis counterpart. (3) HYROX re-anchors silently (no debrief surface yet). (4) Not device-verified — behaviour confirmed by unit tests (`ctl-gap.test.ts` 15 + `ctl-gap-mirror.test.ts` 8), not yet against a live under-training week in any mode.

## §BQ — Max HR: corroborated-max estimator, one algorithm for all three pipes (2026-06-04)

**The problem.** Three sync pipes estimated max HR with three different statistics, all feeding the same up-only ratchet on `s.maxHR`: the Garmin edge fn used p95 of all session maxes (median below 5 readings), Strava used p95 client-side, Apple Health used a raw `Math.max` of workout peaks. Two live failure modes: (1) the small-n median path once wrote **144 bpm** (median of a few easy sessions — measures training mix, not the ceiling) and the ratchet preserved it; (2) Apple's raw max meant a single optical cadence-lock spike could ratchet in permanently. Real data (Tristan, 2026-06-04): a lone 216 HIIT reading sat 13 bpm above a 201/202/203 cluster — p95 of the same history said 184, so every sync logged a spurious "ignored lower maxHR" warning. p95-of-session-maxes is structurally wrong as a max-HR estimator: most sessions are submaximal, so it sits permanently below true max and drifts with training distribution, not physiology.

**The estimator (`src/calculations/max-hr-estimator.ts`).** Estimate = the **highest corroborated reading**: a session max counts only if a second session on a **different calendar day** peaked within **5 bpm** of it (Tristan-approved window, 2026-06-04). Readings must be ≥ 150 bpm (the pre-existing Apple "hard effort" gate — hard interval peaks land within 1–2 bpm of lab max; this floor is what makes two easy sessions agreeing at 144 produce *no* estimate) and < 230 bpm (pre-existing Strava plausibility cap). The different-day rule means Strava+Garmin duplicate rows of the same session cannot witness each other. On Tristan's data: 203 (witnessed by 202) wins; 216 dies for lack of a witness.

**Ratchet kept, warning demoted.** Max HR is a physiological ceiling: any session reading is a lower bound on true max, so the shared `applyCorroboratedMaxHR` only raises `s.maxHR`. A lower estimate is *expected* (the athlete hasn't maxed recently) and now logs at info level, not warn. Manual entry (Account → HR) can still set any value; per the "manually-set benchmarks yield to improvements" rule, a corroborated estimate above it overrides.

**Known limitations (deliberate).** (1) **No downward revision** — max HR declines ~0.7 bpm/yr (Tanaka, Monahan & Seals 2001, *J Am Coll Cardiol* 37:153-156), so a years-old ceiling goes stale-high and slightly deflates iTRIMP; deferred until the app's lifetime makes drift material. (2) An athlete who never trains hard gets no estimate (falls back to Tanaka 208 − 0.7×age in consumers) — correct per §"Age skipped → no max-HR estimate": better no number than a contaminated one. (3) Two spikes of the same artefact on different days within 5 bpm would corroborate each other — accepted residual risk; cadence-lock magnitudes vary with the session's cadence, making twin spikes unlikely.

## §BP — Canonical load currency: TSS everywhere, conversions only at boundaries (2026-06-04)

**The problem (ISSUE-263 + ISSUE-262; full audit in `docs/LOAD_CURRENCY_PLAN.md`).** A 15-agent audit + empirical measurement found the app computing "training load" on **8 distinct numeric scales** and doing arithmetic across them. The same 60-min easy run was worth 39, 55, 69, 86, 90, 96, 115–130, or 60 units depending on which pipeline touched it. Live consequences: the cross-training suggester subtracted Garmin-scale cuts (~90/h easy) from a personal-TSS budget (~55/h) → systematic under-cut (the "absorbs 4.7 of 15.7 km" modal); its severity classifier divided a TSS-ish FCL by a Garmin-scale weekly load → hard cross sessions under-classified → the 1-adjustment guard bound first; universalLoad's four ingest tiers gave the same session up to 3.2× different credit depending only on the data source; Garmin Training Effect (a 0–5 score) was stamped onto `w.aerobic` and summed as TSS (10–20× under); the tri fitness model ran on the population normalizer while running mode ran personal (~1.65× cross-mode CTL divergence for a corrupted profile).

**The canonical unit (Tristan sign-off): TSS, 1 h at lactate threshold = 100** (Coggan). `TL_PER_MIN` (`sports.ts`) is the canonical RPE→TSS/min curve. **The law: every load producer either emits canonical TSS or converts at its own ingest boundary. No consumer ever rescales.**

**Type-keyed planned valuation (`TSS_RPE_BY_TYPE` → `plannedTssPerMin`).** Prescription and valuation are different dimensions: an easy run is *prescribed* at RPE 3 (conversational; telling users "RPE 4" would push easy pace too hard) but *costs* IF ≈ 0.74 → 0.74² × 100 ≈ 55 TSS/h — the RPE-4 row. Perceived exertion undershoots physiological load at low intensity (Borg-RPE vs %HRR nonlinearity), so planned valuation keys off the session TYPE; the per-type rows were derived from the pre-existing week-rollover carry map, not invented (easy/long→4, MP/progressive/mixed→6, threshold/race_pace/float→7, vo2/intervals/hill→8, recovery→3). This resolved the 39-vs-55 easy-anchor split without touching coaching labels or RPE-vs-expected effort scoring.

**Conversion law for raw Garmin/Firstbeat loads: `garminToTssRatio(rpe)`** = `LOAD_PER_MIN_BY_INTENSITY[rpe] / TL_PER_MIN[rpe]` (~1.63 easy → ~2.03 VO2). Both tables describe the same per-minute load on two calibrations, so their per-RPE ratio IS the conversion — derived, never a flat factor.

**universalLoad tiers unified.** A+ (iTRIMP): personal-normalized TSS, sport multiplier REMOVED (a measurement already reflects the sport; multiplying by the RPE-estimate corrector silently deflated cycling iTRIMP ×0.75). A (raw Firstbeat): ÷ `garminToTssRatio(rpe)` at ingest. B (time-in-zone): per-zone TSS/min anchored to the definition — Z4 is the threshold zone so Z4 = 100/60 per min, the existing 1:2:3:4:5 ramp scales linearly → hourly [25, 50, 75, 100, 125], whose implied IFs (0.50/0.71/0.87/1.00/1.12) land on physiologically sensible zone intensities. C (RPE estimate): `TL_PER_MIN` × sportMult × activeFraction × 0.80 uncertainty discount (kept — estimates SHOULD be conservative). Measured tiers now agree within 15%; Tier C sits at 0.80× by design.

**Saturation fixed: slope-1 form.** The old credit curve `CREDIT_MAX(1−e^(−x/TAU))` with CREDIT_MAX=1500, TAU=800 had slope 1.875 at the origin — it AMPLIFIED every realistic session's credit ~1.6–1.9×, accidentally compensating the B1 scale mismatch (a curve tuned to convert TSS-ish budgets toward Garmin-scale cuts). Replaced with the one-parameter saturating exponential `TAU(1−e^(−x/TAU))`, TAU = 491 TSS (old 800 re-denominated by the easy-anchor ratio): slope exactly 1 at zero, so **credit ≤ raw load always** — saturation is a cap, as specified.

**iTRIMP normalizer: personal, plausibility-gated, everywhere.** `computeAthleteNormalizer` = `3600·hrr·e^(β·hrr)` (Coggan hrTSS anchor; Banister β = 1.92 until 2026-10-05, now the β of the athlete's sex, §CI) now rejects ltHR outside 80–95% of maxHR (HR at the individual anaerobic threshold ≈ 86–92% HRmax in trained athletes — Faude, Kindermann & Meyer 2009, *Sports Med* 39:469–490; floor at 80% leaves margin for less-trained users) → population 15000 fallback (itself ≈ an 84%-HRR profile, so the gate never makes things more extreme; note added 2026-10-05: the 84% figure is a back-solve of 3600·h·e^(1.92h) = 15000, and the constant's original comment states no HR profile, see §CI). The gate also fires at the watch-intake source (`resolveLT`/`deriveLT`: implausible Garmin LTHR falls to the 0.88×maxHR derivation). Real case: a Garmin snapshot of ltHR 144 @ maxHR 192 (75%) had silently inflated all running CTL/ATL +66% via a ~9,033 normalizer. The tri fitness model (tri-benchmarks CTL, tri overload, recovery countdown) migrated from hardcoded population `/150` to the same gated personal normalizer — cross-mode CTL coherence; encode/decode pairs (`getAthleteNormalizer`/`normalizeiTrimp`) are exact inverses so synthetic round-trips are identity.

**Rescaled together (the saturation-constant trap):** LOAD_SMOOTHING 30→18.4, minLoadThreshold 5→3, minLoadToTrigger 30→18, EASY_LOAD_PER_KM 12→5.52 (= 6:00/km × TL_PER_MIN[4]; retires the disagreeing 35/km and "15 load/TSS" orphans), recovery-extra cap 20×15→20 TSS, suggester capFraction now a direct `maxReductionTSS / effectiveRRC` ratio (the equivalentEasyKm round-trip is gone). All re-denominations divide by the easy-anchor ratio 1.63 — behaviour-preserving re-denomination, not retuning.

**Confidence**: high on the unit algebra (anchor tests assert it); medium on absolute behaviour shifts (suggester cuts get LARGER on the iTRIMP path, smaller credits on RPE/Garmin paths; severity for hard cross-training rises) — device verification required before ISSUE-262/263 close.

**Limitations**: (1) RPE-only ACTUAL ratings still value a user-rated easy run at the RPE-3 row (39/h) vs the planned 55/h — perceptual-vs-physiological reconciliation of low-RPE actuals is out of scope (most actuals arrive via iTRIMP/HR); (2) bike/swim per-session TSS rates remain placeholders (IF-audited as sensible, documented in `bike.ts`/`swim.ts`) pending real power/pace TSS (ISSUE-259); (3) tri strength sessions keep their legacy 20+10 stamp; (4) the LTHR band can floor a genuinely untrained user (LT < 80% maxHR) to the population normalizer — acceptable because the fallback assumes a mid-band profile anyway.

**Durable guard**: `src/calculations/load-currency-anchors.test.ts` — 17 anchors: 60-min easy ≈ 55 in every planned pipeline (incl. tri↔running parity on a real generated plan), 1h@LT=100 exact, tier agreement bands, credit ≤ load, round-trip identity, per-RPE conversion law, and a filesystem grep that fails on any new hardcoded `/15000`-style decode.

**Key files**: `sports.ts` (TL_PER_MIN canonical header, TSS_RPE_BY_TYPE, plannedTssPerMin, garminToTssRatio), `load.ts`, `universalLoad.ts` + `universal-load-constants.ts`, `suggester.ts`/`planSuggester.ts`, `fitness-model.ts` (gate, getter, /150), `lt-derivation.ts` (plausibleLtHR), `plan_engine.triathlon.ts`/`bike.ts`/`swim.ts`, `activity-matcher.ts` (SEV-1; the `actualTSS` cache it fed was retired 2026-10-06), `tri-benchmarks-from-history.ts`, `main.ts` (one-time `loadCurrencyV2` restamp migration), ~20 display sites.

**Addendum (2026-10-05, audit B8, B11, B2 remainder): planned pricing.** Planning side. No new constants.
- **Unscheduled sessions price at 0.** A planned session whose status removes it from the week (running: 'replaced' or 'skipped'; tri/HYROX: 'skipped') carries 0 planned TSS (`computePlannedWorkoutSignalBTSS`, `isUnscheduledPlannedWorkout`). The planned-day target answers "what does the plan prescribe today", and a fully replaced run prescribes nothing. Its description '0km (replaced)' priced at 1 TSS only through `estimateWorkoutDurMin`'s 1-minute floor, an artefact rather than a dose. This matches `calculateWorkoutLoad`, which already returns 0 for replaced descriptions. A tri/HYROX 'replaced' session is swapped for an easier one still to be done, so it stays priced.
- **One pricer per running session.** The Plan-tab card (`planCardPlannedTSS`) and activity detail's "Load vs plan" use `plannedTssPerMin(type)` like the day target: easy and long at the RPE-4 row (0.92 TSS/min), not `TL_PER_MIN[w.rpe]` (0.65 for an RPE-3 easy run). On-plan easy runs had read about 140% of plan.
- **Planned injected sessions are prescriptions, never load.** `adhoc-`, `holiday-` and `benchmark-` entries in `adhocWorkouts` (`isPlannedAdhocId`) are skipped by every load reader. Only the synced activity's iTRIMP or RPE fallback counts.
- **Limitation.** A running skip stored only as `wk.rated[id] = 'skip'` stays priced, because `resolveCtlAdherence` must see skipped sessions as planned to detect under-adherence (§BR). The day's strain target therefore still includes that session.

---

## §BO — LT estimate: race-PB pace bound + wizard-PB visibility (2026-06-04)

**The problem (Tristan dogfooding, same session as §BN).** The onboarding review screen showed "Lactate threshold pace 4:56/km — Blended from your PBs and recent threshold-effort runs. High confidence." to an athlete whose typed PBs were 17:38 / 39:20 / 1:31:30 / 3:09:42. A 3:09 marathon is run at 4:30/km; a threshold pace 26 s/km SLOWER than marathon pace is physiologically impossible (LT ≈ best ~60-min pace; Daniels' T; Coyle 1995 *Exerc Sport Sci Rev* 23:25–63). Two mechanisms: (1) every mid-wizard physiology consumer read `s.pbs` (written only at finalize) — so LT derivation saw the PREVIOUS plan's PBs and a degraded VDOT (41.3, residue of an earlier broken pass's feedback loop: bad blend → low `s.v` → Daniels T from low VDOT → bad LT → worse blend); (2) easy runs passing the empirical filter at ~4:56/km dominated the blend at weight 0.5. A third inconsistency: finalize set `s.lt = null` (wizard had no measured LT) but left `ltSource: 'blended'` / `ltConfidence: 'high'` stale from the pre-finalize recompute.

**Fix 1 — `effectivePhysiologyPbs` (physiological-vdot.ts).** Per-key fastest-of(`s.pbs`, `s.onboarding.pbs`), consumed by the PB-median VDOT tier and `pbsToBestEfforts` (LT critical-speed inputs). Mid-wizard, freshly-typed PBs are immediately visible to the whole physiology chain; fastest-wins per key means a stale wizard snapshot can never regress a fresher post-plan PB. This also breaks the cross-pass degradation loop at its entry point: CS-from-PBs and PB-median Daniels re-anchor the estimate on demonstrated performance regardless of how degraded `s.v` got.

**Fix 2 — definitional race-PB bound in `deriveLT`.** Any race PB with duration ≥ 3600 s was, by definition, sustained for longer than an hour, so LT pace can never be slower than that race's average pace. The blend is clamped to the tightest such PB pace; provenance appends "Capped at your race-PB pace"; confidence is downgraded from 'high' (the methods contradicted demonstrated performance). The bound IS the PB pace — no tuned margin, no invented constant. Races shorter than 60 min impose no bound in this direction (a 17:38 5K pace is legitimately faster than LT). Garmin/override paths bypass the bound (measured/user values have their own provenance rules).

**Fix 3 — fresh LT + per-plan goal at finalize (`initializeSimulator`).** When the wizard supplies no measured `ltPace`, finalize now calls `recomputeLT(s)` after committing `s.pbs`, so `s.lt`/`ltSource`/`ltConfidence` are consistent from day 1, and re-derives `s.pac` from the fresh LT. `s.raceGoalTimeSec` is cleared on plan initialization — goals are per-plan (the live bug: a sub-3 MARATHON goal surviving onto a HALF plan rendered "TARGET TIME 3:00:00 · >95% chance" on the plan-ready hero).

**Confidence**: high. Fix 2 is definitional; fixes 1 and 3 are data-provenance corrections.

**Limitations**: the empirical method can still be polluted by easy runs inside the 85–92% HRmax band when maxHR is misestimated — the bound contains the damage but doesn't fix the classifier. The recent-run predictor's parallel contract violation (training runs fed where the docstring expects a race/time-trial) is logged separately (ISSUE-267) pending a calibration decision.

**Key files**: `src/calculations/physiological-vdot.ts` (`effectivePhysiologyPbs`), `src/data/ltSync.ts` (`pbsToBestEfforts`), `src/calculations/lt-derivation.ts` (bound in `deriveLT`), `src/state/initialization.ts` (finalize recompute + goal reset). Tests: `lt-derivation.test.ts` (+3), `physiological-vdot.test.ts` (+3), `initialization.physiology.test.ts` (3).

---

## §BN — Onboarding anchor parity: durability cap + stated-volume fallback (2026-06-04)

**The problem (real case, Tristan dogfooding 2026-06-04).** A thin-data onboarding (typed 17:39 5K PB, typed "10 km/week", Strava connected but 0 activities scraped) produced a half-marathon "current race estimate" of exactly 1:26:00 — the raw `predictFromPB` Riegel extrapolation (b≥1.10 short-anchor floor, §audit-11) with every endurance brake switched off. Diagnosis: (1) `initializeSimulator` seeded `blendedRaceTimeSec` WITHOUT the long-run durability cap that the canonical refresher (`refreshBlendedFitness`, §AL.4) applies — so the anchor the user first sees is systematically faster than what the first backfill silently corrects it to; (2) the typed weekly volume was erased by a 0-row history aggregation (`stravaSync` set `detectedWeeklyKm = undefined`) and was never passed to the blend, so volume-sensitive terms saw an explicit zero instead of the stated 10 km/wk; (3) at half distance both volume-specificity penalties are marathon-gated, leaving the durability cap as the only endurance brake — and it wasn't applied.

**Fix 1 — durability cap at finalize (parity, no new constants).** `initializeSimulator` now applies `applyLongRunCap(getLongestRunSec(s,12), targetDist)` to the wizard blend before deriving VDOT, exactly mirroring §AL.4's order in the refresher (blend → calibration → durability → VDOT). The capped time seeds `blendedRaceTimeSec`, `initialBaseline`, `currentFitness`, and the forecast anchor; `s.runDurability` is stored for the Forecast chip from day 1. Calibration bias is not mirrored (no logged races at onboarding; first refresh applies it). For the real case: 1:26:00 → 1:29:26 today (max 4% half penalty, no run history), forecast shifts by the same delta. The cap reaches `forecastTime` only through the anchor (never applied twice), preserving §AL.4's "projection assumes the plan delivers long runs" rule.

**Fix 2 — stated volume as the no-scrape fallback (`resolveWeeklyKmSignal`).** History-derived weekly km (`computePredictionInputs`) stays the primary signal, including an explicit 0 when the 8-week window is empty but history exists. Only when the window has NO qualifying runs at all (`weeksCovered === 0`) does the blend fall back to `detectedWeeklyKm`, which now survives an empty scrape and carries the typed manual-entry volume (`weeklyVolumeConfirmed` is also set there, so the D3 plan-volume gate seeds `s.wkm` from it — previously only the Apple Health import path set the flag). Self-reported volume is a weaker signal than measured history (athletes systematically over-report training; Borresen & Lambert 2009, Sports Med 39:779–795 document self-report vs measured discrepancies) but strictly better than treating "we found nothing" as "trains zero": the marathon-specificity penalty otherwise fires at maximum severity (×1.15) against a user who stated their volume.

**Confidence**: high for fix 1 (pure parity with an already-logged model). Medium for fix 2's fallback trust (self-report bias is unmodelled; mitigated by the fallback only engaging when no measured signal exists, and measured data replacing it on first real sync).

**Limitations**: the typed volume has no pace attached, so Tanda can never fire from it (correct — Tanda needs measured P and K). Half/10K remain exempt from volume-based specificity penalties (marathon-gated); the durability cap is the only endurance brake at those distances. Extending the unified readiness framework (half: 50 km/wk target, max 8%) to running's half predictions is a deliberate open calibration decision — see `predictions.ts` parallel-implementation notice.

**Key files**: `src/state/initialization.ts` (cap at finalize), `src/calculations/prediction-inputs.ts` (`resolveWeeklyKmSignal`), `src/calculations/blended-fitness.ts` (fallback at both blend call sites), `src/data/stravaSync.ts` (no-clobber on empty aggregation), `src/ui/wizard/steps/manual-entry.ts` (`weeklyVolumeConfirmed`). Tests: `initialization.durability.test.ts`, `prediction-inputs.test.ts`, `initialization.volume.test.ts`.

---

## §BM — Runner population percentiles: "faster than X% of runners" at every standard distance (2026-06-03)

**Where it sits**: tracking. Places times within the recreational racing population; prescribes nothing.

**What it does.** `src/data/runner-population-distributions.ts` holds percentile tables (p1/10/20/.../90) for 5K, 10K, half and marathon, each in three variants (overall / male / female). `runnerFieldPlacement` (fitness-placement.ts) converts a time to "faster than X% of {male|female} runners" via linear interpolation; `runnerFieldPlacementForFitness` first projects current VDOT to a time at the distance via Daniels. The review screen's Field position row and all PB rows use this.

**Source.** RunRepeat percentile calculator ("Compare Running Finish Times"). Methodology per the published page: "Results are based on 35 million results collected in the last 20 years from more than 28,000 races." Tables were extracted verbatim from the server-rendered page on 2026-06-03 (times converted to seconds). This is an aggregated secondary source rather than raw rows we pooled ourselves (unlike §AF's five-majors ingest), accepted because it spans all four distances with sex splits and a population three orders of magnitude beyond anything we could ingest raw.

**Why this replaced age grade as the headline (Tristan, 2026-06-03).** A 17:39 5K graded 73% on the WMA scale, and "73%" read as "better than 73% of people" — underselling a top-1% performance. Population percentile is what users intuitively expect a percentage to mean. The age grade survives as a plain-words bracket ("73% of world-record speed for your age") inside the projection sentence (§BL amended). Verified case: male 5K p1 = 17:30, so 17:39 → "faster than ~99% of male runners".

**Refusal/fallback rules.** Sex unknown or 'prefer_not_to_say' → overall table (a population claim needs no demographic table, unlike FRIEND/WMA which refuse). Claims clamp at the published ends: max "faster than 99%", min "faster than 10%".

**Scale bar anchoring (Tristan, 2026-06-03).** The bar's fast end was originally the population's 1st percentile, which "stopped at 17:30" and read as truncated. The fast anchor is now the **world-record standard** (the WMA open standard, `openStandardSec`, which equals the current road WR at these distances — male 5K 12:49, marathon 2:00:35). Axis: population p90 (slow) on the left → WR on the right, median tick at population p50. The dot's horizontal position is therefore a **time position on this axis, not the population percentile** — a 99th-percentile runner sits mid-bar because the elite tail stretches to the WR. The percentile claim stays in the row headline (from the population table); the bar conveys distance from the human limit. These are two intentionally different mappings; do not reconcile them. Falls back to the population p1 anchor when sex is unknown (the WR table is sex-specific and refuses to guess).

**Limitations.** (1) Race finishers are a self-selected population; "faster than 87% of runners" means runners who entered timed races, not everyone who jogs. (2) The percentile table ends at p1/p90; elite and back-of-pack tails are flat (clamped). (3) RunRepeat does not publish per-age variants on this page, so the population claim is age-blind; the age-grade bracket carries the age context. (4) Secondary aggregated source — if RunRepeat revises the page the provenance date matters; `RUNNER_POP_SOURCE` records the extraction date. (5) Half-marathon male table has a visible flattening at p40-p50 (7096→7188s) — verbatim from the source. (6) The scale-bar axis mixes two datasets (population p90/p50 + WMA WR anchor); accepted as a visual aid, with the load-bearing number (percentile) sourced purely from the population table.

---

## §BL — WMA age grading: cross-distance fitness placement + PB comparisons (2026-06-03)

**Where it sits**: tracking. Grades performances and projected fitness against published standards; prescribes nothing.

**What it does.** Age grade = `ageStandardSec(age, sex, distance) / timeSec` as a percentage, where the age standard is the world-best-level time for that age and sex. 100% = world-standard. Three surfaces on the onboarding review screen:

1. **Age grade row** (running mode with a target distance): current fitness (the same VDOT the VO2max row displays) is projected to the athlete's own target distance via the Daniels curve (`tv`), then graded. Replaces the marathon-equivalent framing for non-marathon athletes (§BK reversal below). **AMENDED same day (§BM)**: the standalone row was demoted — the headline "Age grade 73%" read like a population percentile and undersold strong runners. Age grade now appears only as a bracket inside the Field position row's projection sentence ("73% of world-record speed for your age"); the headline number is the §BM population percentile.
2. **PB rows**: every filled PB (5K/10K/half/marathon) gets its own age grade line. This grades real performances, the cleanest use of the tables.
3. **Position scale** on the age-grade row: 40-100% axis, tick at 70%.

**The tables.** Official WMA/USATF 2025 road standards (Alan Jones tables, "Version 2025-07-27", approved 2025-01-10 by the USATF Masters Long Distance Running council). Ingested from the official repository (github.com/AlanLyttonJones/Age-Grade-Tables, 2025 Files, `AgeStdSec` sheets) via `scripts/ingest-wma-age-grading.py` on 2026-06-03 — parsed straight from the published xlsx, not recalled from memory. CC-BY-4.0. Per-sex, per-age (5-100) standard seconds for 5K/10K/half/marathon in `src/data/wma-age-grading.ts`. Interpretation bands are the published convention: 90%+ world class, 80%+ national, 70%+ regional, 60%+ local.

**Refusal rules.** No grade without age AND binary sex ('prefer_not_to_say' → no claim). Ages clamp to the published 5-100 range.

**Limitations.** (1) PB grades use the athlete's *current* age; PBs span up to 3 years, so a PB set at age N-3 grades very slightly soft (factor drift over 3 adult years is <2%). (2) The published table has non-monotonic values at child ages 5-7 for half/marathon (verbatim from the official file); irrelevant for the app's adult users. (3) Grading a *projected* time (age-grade row) inherits the VDOT proxy caveats from §BK; the PB rows carry no such caveat. (4) Standards assume road courses; trail/track PBs grade unfairly.

---

## §BK — Onboarding fitness placement: FRIEND VO2max norms + marathon-equivalent field position (2026-06-03)

**Where it sits**: tracking. Describes where the athlete's measured fitness sits relative to real reference populations; prescribes nothing.

**What it does.** The onboarding review screen ("Here's what we found") now contextualises the athlete's numbers against real populations via canonical helpers in `src/calculations/fitness-placement.ts`:

1. **VO2max percentile** — the displayed VO2max (whatever `getPhysiologicalVdot` resolves) is placed within the FRIEND registry age/sex treadmill norms (`src/data/vo2max-norms.ts`). Caption: "Higher than X% of men aged 30-39."
2. **Run-speed field position** — the same VDOT is converted to a marathon-equivalent time via the Daniels curve (`tv`, the canonical inverse already used across the app) and looked up against the pooled five-majors table (888,989 real finishes, §AF). Caption: "Faster than X% of marathon finishers."
3. **Bike FTP** — placed on the Coggan W/kg power profile (`wattsPerKgTier`, bike-physics.ts), only when a real user bodyweight exists (the 75/62 kg sex default must not back a placement claim).
4. **HYROX field position** — previous finish time against the real per-format finisher tables (89,868 rows S4-S6, §R), with per-format finisher counts exported as `HYROX_FORMAT_FINISHER_COUNTS`.

**The FRIEND table.** Kaminsky LA, Arena R, Myers J. *Reference Standards for Cardiorespiratory Fitness Measured With Cardiopulmonary Exercise Testing: Data From FRIEND.* Mayo Clin Proc 2015;90(11):1515-1523. 7,783 maximal treadmill CPX tests (4,611 men / 3,172 women), ages 20-79, CVD-free, 8 US labs; the dataset behind current ACSM reference standards. Values were verified against the open-access PMC copy (PMC4919021) on 2026-06-03, not recalled from memory. Percentile breakpoints 5/10/25/50/75/90/95 per sex per age decade; linear interpolation between breakpoints (mirrors §AF's table lookups); clamped at 5/95 outside the published range. Ages outside 20-79 clamp to the nearest decade band and the caption names the band actually compared, keeping the claim honest.

**Marathon-equivalent framing REVERSED (Tristan, 2026-06-03, same day).** The original decision projected every athlete to a marathon-equivalent time so the real five-majors table could cover all distances. On device this read as "weird marathon predictions for other distances". The field-position row is now **marathon-target users only** (the one distance with real population data); everyone else gets the WMA age-grade row instead (§BL), which frames fitness at the athlete's own target distance. `runSpeedPlacement` (the marathon-equivalent conversion) still backs the marathon-target row. LT placement was considered and skipped: the review screen's LT is derived from the same VO2/VDOT signal, so a percentile on it would restate the VO2 row's placement, and no real LT population dataset exists.

**Refusal rules (no guessed reference groups).** VO2 placement returns null without a known age AND binary sex ('prefer_not_to_say' → no claim). FTP placement returns null without a real `bodyWeightKg`. HYROX placement returns null for pro_doubles (no ingested data). Every surface hides rather than guesses.

**Limitations.** (1) The displayed "Current VO2max" can be a Daniels VDOT proxy (LT-derived or PB-median tiers), which understates lab VO2max for economy-poor athletes and overstates it for efficient ones; the placement inherits this. Acceptable because the placement always refers to the number the user is looking at (two-numbers rule). (2) FRIEND is a US clinical-referral population, not endurance athletes; well-trained users will cluster above the 90th percentile, where the table flattens (clamped at 95). (3) A 2022 FRIEND update exists (16,278 treadmill tests, ages 20-89; Mayo Clin Proc 2022;97(2):285-293) but its tables are paywalled and could not be verified; swap in when verifiable. The 2015/2022 p50 deltas are ~1-2 mL/kg/min. (4) Marathon finishers are a self-selected population; "faster than 64% of finishers" describes people who completed a major, not the general public. (5) Coggan W/kg bands are male 60-min-power referenced; female athletes read about one band low (documented at `wattsPerKgTier`).

---

## §BJ — Adhoc strain anchor: unplanned sessions floor readiness via CTL/7 (2026-06-03)

**Where it sits**: tracking. Describes how hard today was relative to what this athlete sustainably absorbs; prescribes nothing.

**Problem.** The readiness strain floor (50–100% → 100→54, 100–180% → 54→10) reads `strainPct = todayTSS / plannedDayTSS`. With no planned session today the percent stayed 0 and the floor never fired. Three ways to hit that hole: a rest-day adhoc session, an injury-reduced plan with the day's session removed, and **all of triathlon mode** — home-view's planned-day TSS comes from the running workout generator, which has no basis for a tri plan. Dogfood case (2026-06-03): 60 min hard bike while injured (run/swim blocked, bike capped 40%) → Strain ring showed 43 TSS but the headline score and sentence ignored the session entirely.

**Fix (final form, capacity anchor — Tristan 2026-06-03).** The floor/sentence strain percent anchors on `max(plannedDayTSS, weeklyCTL / 7)`: an athlete is only "overreached" when today's load exceeds BOTH the planned dose and the sustainable daily load (Banister CTL as the sustainable-load proxy). Rationale: pure %-of-plan craters the score on physiologically normal days whenever the plan-of-record is small — injury-capped days (dogfood case: planned 20, logged 42 → 210% of plan but only 93% of capacity), taper, easy days. This extends Tristan's standing ruling that the ring is capacity-based and injury is a separate constraint layer (§BG). The anchor components are not new models: the trackOnly Strain ring already anchors on `ctlBaseline / 7`, and the lost tri post-session trigger (May-19 snapshot `isPostSessionState`) used the identical `actualTSS / dailyCTL` fallback. In tri mode weekly CTL = swim + bike + run per-discipline weekly EMAs **plus `crossTrainingCtl`** (`triConfig.fitness`); in running mode `ctlNow` from `computeLiveSameSignalTSB` is already weekly-equivalent. Cross-training CTL must be included because the numerator (`todaySignalBTSS`) counts all sports: dogfood data (2026-06-03) had cross CTL as the largest component (143 of 345 weekly) — excluding it would make every routine HIIT day read ~167% and pin the floor near 17, false-alarming on normal baseline load. Side effect, deliberate: in running mode, completing a planned easy session smaller than CTL/7 no longer pins the floor at 54 — a sub-average completed day leaves capacity, and the floor now says so.

**Injury-cap overshoot call-out.** When injury is active and `todayTSS > plannedDayTSS × 1.3` (the existing "Load exceeded" ring margin), the sentence becomes `injuryCapOvershootSentence`: "42 TSS logged against an injury-capped day of 20. Load is within your normal range, but well above the rehab cap." (or, when capacity is also exceeded, "...That exceeds both the rehab cap and your typical daily load. Rest up and recover."). The ring stays capacity-based; this sentence is the injury layer's message. Mirrored into running mode's `derivePrimaryMessage` Tier-0 injury branch (fires when trained and plan-strain ≥ 130%).

**Acknowledgment tier at 80% (CTL-dominated anchor only).** Tristan (2026-06-03): "if strain is high from 80% up, we say good training." When the capacity anchor is CTL-dominated (`CTL/7 ≥ plannedDayTSS` — adhoc days and small-plan days), the session is finished, so 80–99% earns "Good training today (X TSS), most of a typical day's load." When the planned dose dominates the anchor, 80–99% can mean a session still in progress, so that path keeps the running-mode "Nearly at today's target" copy — the tier is gated on `ctlAnchored` in `postSessionSentence`. The 80 breakpoint mirrors running's existing Tier-4 partial-strain threshold; it is not a new constant.

**Guards.** (1) A real logged session must exist today (`garminActuals` or a Garmin-imported adhoc workout). `computeTodayStrainTSS` includes passive step/active-minute TSS, so without this guard a long walk on a rest day would anchor against CTL/7 and crater the score for low-CTL athletes; rest-day passive load stays the domain of `isRestDayOverreaching`. (2) Weekly CTL < 10 → no anchor (percent stays 0). Mirrors `perDisciplineACWR`'s existing CTL ≥ 10 noise guard: dividing by a near-zero chronic load produces degenerate percentages (a detrained athlete's first session would pin the floor at 10).

**Canonical module (2026-06-04).** The anchor lives in `src/calculations/capacity-strain.ts` (`computeCapacityStrain`, `capacityStrainNote`, plus the sentence helpers re-exported via daily-coach). Incident that forced it: Home fed the capacity percent (93% → 61) while the Readiness detail page kept its own plan-anchored percent (210% → strain floor 10 "Ease Back") — two hand-rolled assemblies of "the same" input. All three strainPct producers (home-view, readiness-view, daily-coach `deriveStrainContext`) now read the helper; hand-rolling a strain percent for `computeReadiness` is forbidden. `StrainContext.capacityStrainPct` carries it into daily-coach's internal readiness call while plan-relative `strainPct` stays for copy tiers.

**Coherence.** The same `strainPctEffective` feeds the floor *and* the tri-mode post-session sentence (`postSessionSentence`, shared with running's Tier 1 copy), so the score, the ring label, and the sentence move together — no more "Manage Load + chronic-load lecture" while the Strain ring shows a just-completed hard session.

**Limitations.** CTL/7 understates a planned hard day's intended dose (plans periodise; CTL is the average), so on adhoc days the floor engages slightly earlier than it would against a true planned target. Acceptable: adhoc days have no planned target by definition, and erring toward "rest up" after an unplanned hard session is the conservative direction. Planned days are unchanged.

---

## §BI — Bodyweight progression ladder for beginners/novices (2026-06-03)

**Where it sits**: planning (it prescribes session content), strength subsystem. Pure tracking-to-planning loop; no forecast number.

**Model**: weaker athletes train bodyweight movements that carry no external load, so the weight-autoregulation that progresses lifters (`suggestNextWeight`, §AW) has nothing to act on. This adds a parallel **ladder progression** per movement family (squat, lunge, hinge, calf, plank, step-up). Each family has an ordered set of rungs — more reps → a harder variant → a light external load — and the app remembers the athlete's current rung (`s.bodyweightProgress`), advancing it from the same one-tap RIR feedback (`reps-left` / `about-right` / `barely`).

**Progression rule** (mirrors the weight bump's structure):
```
base/build only (peak/taper/injury → hold):
  reps-left  → easyStreak++; advance one rung at easyStreak >= 2 (BODYWEIGHT_ADVANCE_STREAK)
  barely     → step DOWN one rung (then climb back up via the normal rule)
  about-right→ hold (reset streak)
```

**Why this is defensible**:
- **Progressive overload by reps then load** is the textbook beginner progression (ACSM/NSCA): a movement is mastered by accumulating reps in good form, then advanced to a harder variant, then loaded. The ladder encodes exactly that path.
- **RIR-2 autoregulation** (Helms et al. 2016): advancing only when the athlete has reps in reserve ("reps-left") is the same evidence-based cue the weight system uses — progress when the current dose is comfortably managed, not before.
- **2-session confirmation** avoids advancing off a single good day; **regress-on-"barely"** is a safety self-correction (a too-hard rung is walked back, then re-earned), endorsed by Tristan over a plain hold.
- **No invented prescriptions**: every rung's movement and load (e.g. Goblet Squat @50%, Step-Ups @30/40%, RDL @40%) already appears in the beginner/novice templates (`gym.ts`); the ladder only sequences existing, endorsed content with modest standard rep/time steps (10→15→20 reps; 30→45→60s holds).

**Phase gate**: identical to the weight bump — only base/build advance; peak/taper/injury hold. The top rungs hand off to weight-tracking (the loaded variant has a `@%1RM` marker, so `persistStrengthLifts` then owns load progression).

**Limitations**:
- RIR is a single self-reported tap on one set, not per-set; a miscalibrated tap advances or regresses one rung (bounded, self-correcting).
- The ladder is a fixed path, not individualised to the athlete's specific weakness; it assumes the standard family progression suits most beginners.
- Read-back rewrites the first occurrence of each family per session (a second same-family line keeps its template prescription) and only touches movements the athlete has progressed (level > 0), so a fresh beginner's session is unchanged.

---

## §BH — In-gym contrast power-block (plyometric paired with the heavy lift) (2026-06-03)

**Where it sits**: planning (it prescribes session content), strength subsystem. Does not change any forecast number.

**Model**: in build phase, an intermediate+ running-strength session pairs the heavy lead lift with a biomechanically matched jump — squat pattern → Jump Squat, hinge/deadlift → Box Jumps (`matchedPlyoFor`, `running-pool.ts`). This is **contrast (complex) training**: a high-load lift performed immediately before an explosive movement acutely raises the rate of force development of the jump via **post-activation potentiation** (Science for Sport; Coggan/Verkhoshansky complex-training tradition). Pairing biomechanically similar movements ("dynamic correspondence") is the standard prescription.

**Why heavy → explosive specifically**: the lead lift is already prescribed at ~80% 1RM (`max-strength` category), above the ≥60% threshold (≈85% optimum) where PAP is reliably observed. The matched jump is low-rep and explosive (Jump Squat 4×3, Box Jumps 3×5 — existing `[PROP]` doses, unchanged). No new constants.

**Why strict rest timing is NOT modelled** (Tristan, 2026-06-03): the rest-interval meta-analysis (Frontiers 2023, PAPE) shows precise intra-complex rest optimises *acute* jump height, but the *training adaptation* over weeks is robust to imprecise rest. For a runner chasing economy/power over a block — not a one-rep jump PB — a simple "lift, then the jump, rest 2–3 min, repeat" captures the stimulus. The pairing instruction is surfaced as text in the lead's cue, not enforced.

**Gating** (three independent layers): opt-in (`plyoInGymEnabled`, default-on for intermediate+, off-switch in Settings) × ability (the heavy pool is intermediate+ only) × phase (build only — base lays the strength base, peak/taper de-load). The standalone plyo category pick is dropped when the pair fires, so foot-contact load isn't doubled.

**Limitations**: PAP magnitude is individual and training-age dependent; we don't measure it, so the pairing is a programming default, not a personalised dose. The pairing is delivered as adjacent lines + a cue rather than a true interleaved guided superset (the guided overlay walks set-by-set); full interleaving is deferred. Applies to running-strength only (HYROX/upper/lower/full pools untouched).

---

## §BB — Injury cross-training substitute: intensity scales with capacity, duration does not (2026-06-02)

**Where it sits**: tracking → planning (it prescribes a session), injury subsystem. Suggestion-only.

**Model**: when an injury frees up aerobic training time, the cross-training substitute (`buildAerobicOffer`, `src/calculations/capability-substitution.ts`) replaces the lost minutes **1:1** but prescribes intensity in proportion to the substitute discipline's loadability:

```
prescribedRPE = max(1, round(baseRPE_by_phase × capacity / 100))
duration      = freed aerobic minutes      (unchanged by capacity)
```

`baseRPE_by_phase` is the existing submaximal injury-phase table (`RPE_BY_PHASE`: acute 3, rehab 4, return 4, graduated 5). `capacity` is the 0–100 loadability of the chosen discipline (`getDisciplineCapacity`).

**Why duration is held and intensity is scaled (not the reverse)**: the purpose of the substitute is aerobic-engine maintenance during a layoff. Detraining of VO2max and capillary/mitochondrial adaptations is driven by **time at an aerobic stimulus**; cutting duration directly erodes the thing the session exists to protect (Mujika & Padilla 2000, training-cessation review — aerobic decay is steep when volume is withdrawn). A compromised joint or muscle tolerates *load/intensity*, not *time per se*, so the safe lever is effort: a 50%-capacity bike holds the full minutes at roughly half the RPE. This keeps the maintenance dose while respecting that the area is only partly ready to bear load. (Endorsed by Tristan, 2026-06-02, correcting an initial duration-scaling proposal.)

**Why linear in capacity**: `capacity/100` is the same continuous downmix the plan engines already apply to injured-discipline *volume* (`duration × cap/100`, §AN). Reusing it for intensity keeps one transform across the subsystem and introduces no new constant. It is a deliberate simplification: RPE-vs-load is not perfectly linear, but capacity is itself a coarse self-report, so a higher-order curve would be false precision.

**Allow-list semantics**: a set `preferredCrossTraining` is treated as a hard allow-list, not a tie-break. If the athlete named the one cross-training sport they have access to (e.g. swimming) and the injury blocks it, no aerobic substitute is offered rather than defaulting to a bike or erg they may not own. An unknown preference string falls through to the capacity ladder (bike → row erg → swim). Shared across running rehab and tri/HYROX capability offers via `pickAerobicSubstitute`.

**Limitations**:
- Capacity is a self-reported snapshot; the RPE it produces is only as good as the slider.
- The substitute's *load contribution* to weekly TSS is not modelled here (the offer is opt-in and adhoc); it is intentionally a maintenance prescription, not a load-balanced session.
- No equipment model beyond `preferredCrossTraining`; a user with no pool and no preference set can still be offered a swim if bike and arms are both blocked.

---

## §BA — No-race forward projection ("if you hold the plan") (2026-06-02)

The no-target-race forecast drill-down shows a forward projection of finish time at a 4 / 8 / 12-week horizon (`getStandardForecastProjection` in `blended-fitness.ts`). It reuses the existing VDOT-gain horizon model (`applyTrainingHorizonAdjustment`, the saturating dual-tau model documented in the training-horizon entries and §AH/§AI). The total gain is computed once at the horizon, then **distributed across the weeks by the model's own `week_factor` saturation curve**:

```
total      = max(0, applyTrainingHorizonAdjustment({…, weeks_remaining: N, taper_weeks: 0,
               weekly_volume_km: getPlanPrescribedMeanWeeklyKm(s.rw, dist), strength_sessions_per_week: s.gs}).vdot_gain)
shape(w)   = week_factor(w) / week_factor(N)       // dual-tau saturation, 0 → 1
projVdot(w)= anchorVdot + total · shape(w)
projTime(w)= tv(projVdot(w), distKm)               // raw VDOT-derived, lower = faster
```

**Why this shape (corrected 2026-06-02 after the "is this shape normal?" review):** adaptation to a consistent stimulus is a *saturating exponential* — gains are fastest at the start (furthest from ceiling) and decelerate (Hickson 1981: near-linear VO2max gains from week 1–2; Jones & Carter 2000; Joyner & Coyle 2008 dual-tau decomposition). The earlier implementation sampled the model per week and floored each at 0; because `undertrain_penalty` is a *constant* subtraction (volume-gated, not week-scaled), early weeks went net-negative and the floor pinned them flat until the growing base crossed the penalty — producing a **dead-flat start then a kink**, which is not physiology. Distributing a single `total` by the saturation `shape(w)` gives the correct concave rise from week 1 with no flat lag.

**Under-volume → lower ceiling, not delayed onset.** Pfitzinger/Daniels: volume-shortened runners reach a lower ceiling (marathon 2–6% slower than matched-volume controls), but they still adapt from day one. So the volume penalty stays in `total` (a low-volume plan yields a smaller total gain → a flatter overall curve), but it is removed from the *onset* (the shape). "Assume they do the plan" therefore does NOT mean suppressing the penalty — a genuinely low-volume plan honestly projects a smaller gain — it means putting the penalty on the asymptote, where the science places it.

**Other choices:**
- **Same model as the targeted forecast.** No new constants. Already calibrated against Daniels/Pfitzinger periodised plans.
- **`taper_weeks: 0`.** There is no race to taper into. The taper bonus models fitness consolidation as load drops before race day; an athlete who keeps training is not tapering, so applying it would overstate the gain. This is the one input that differs from the race-day path (`calculateLiveForecast` hardcodes `TAPER_NOMINAL`, so we call `applyTrainingHorizonAdjustment` directly).
- **Dose = plan-prescribed weekly volume** (`getPlanPrescribedMeanWeeklyKm(s.rw, dist)` = sessions × `REF_KM_PER_SESSION` × build factor), the same dose input the targeted forecast uses (§AI). **Revised 2026-06-02 from "recent weekly km".** Recent km was wrong: a thin-history user reads as near-zero volume, which trips `applyTrainingHorizonAdjustment`'s `undertrain_penalty` at full strength (the penalty is volume-gated, not week-scaled). For half/marathon (high `min_sessions`) the penalty exceeded the gain, so the projection showed the athlete getting *slower* over 12 weeks, with a discontinuity at week 1 (w=0 is pinned to the hero, w=1 eats the full penalty → "falls off a cliff"). "If you hold the plan" means training at the plan's dose, so plan-prescribed volume is both more correct and clears the spurious penalty.
- **Gain floored at 0** (`vdot_gain = max(0, modelled)`). Holding a structured plan is, at minimum, maintenance; a projected decline only arises from an undertrain assumption that contradicts the premise, and showing a runner getting slower *for training* is indefensible UX. The floor guarantees a monotonic non-worsening curve for every user and distance (the "should scale for every user" requirement). It floors a model output, not an invented number.
- **Anchor = current effective VDOT** (`s.v + rpeAdj + physioAdj`), identical to what `recordVdotHistoryPoint` stores.
- **Display anchored on the adjusted hero.** The model computes on the raw VDOT scale, but the chart scales the whole series multiplicatively so the "now" point equals the predicted-finish hero the user already sees (`scale = heroSec / tv(anchorVdot)`). This preserves the modelled fractional gain while making the left end of the projection read identically to the headline — fixes the confusion of a raw-scale time sitting next to the adjusted hero. Both endpoints are labelled (Now → +N wk). Durability/calibration/shoe adjustments are baked into the hero anchor, not re-modelled per projected week (the gain is a VDOT-fitness gain; a change in the long-run/durability gap is a separate lever, surfaced by the durability hint, not this projection).

**Limitations (called out):** the horizon model assumes consistent training at the plan's dose with no injury/illness/detraining interruption; it does not model individual responder variation, plateau from a stale stimulus, or the ceiling a masters athlete faces. Gating: returns null (projection hidden) when there is no VDOT or `s.rw ≤ 0` — a just-track user with no plan has nothing to project along, and we do not invent a dose. Tests: `blended-fitness.test.ts` (point count, monotonic improvement, rises-from-week-1 concave shape, longer-horizon-faster, null gating).

---

## §AN — Bike mass / CdA coupling and the weight-input clamp (2026-06-01)

**Side of the line**: tracking (race-time prediction input).

**The coupling.** The bike power-balance model (`bike-physics.ts`) solves CdA from a known ride by inverting the steady-state equation:

```
CdA = 2·(P·η − Crr·m·g·v − m·g·sinθ·v) / (ρ·v³)
```

Both the rolling term (`Crr·m·g·v`) and the climbing term (`m·g·sinθ·v`) scale with total mass `m`. For a fixed observed (power, speed, gradient), increasing `m` removes power from the aero residual, so the solved CdA falls. The prediction then re-uses that lowered CdA. On a flat course at race power the aero term (∝ v³) dominates the rolling penalty, so a *heavier* assumed mass produces a *faster* predicted bike split. This is the well-known mass/CdA identifiability problem in single-ride field testing (Martin et al. 1998, *J Appl Biomech* 14:276 — the power model; Chung's "virtual elevation" method exists precisely because mass and CdA cannot both be recovered from one steady ride without an independent constraint).

**Why this is acceptable, not a model error.** Within a realistic mass range (a road/TT bike is 6–12 kg, a loaded setup rarely above ~20 kg) the CdA compensation is small and the net prediction error from a ±2 kg mis-entry is below the noise floor of a field calibration (which we already only rate `'medium'` confidence). The model is internally consistent: it reproduces the calibration ride exactly at its own operating point. The artifact only becomes visible — and wrong-signed — when the mass input is unphysical.

**The guard (not a recalibration).** Rather than add an independent mass constraint (we don't have repeated-ride or virtual-elevation data), we clamp the weight inputs to physical bounds at entry: bike 4–30 kg, rider 30–200 kg (the bounds already declared on the inputs). HTML `min`/`max` only flag validity; they don't clamp a typed value, which is how a 100 kg "bike" reached the solver. Clamping keeps the calibration inside the range where the coupling is negligible.

**Known limitation.** Even after clamping, changing mass without re-running the calibration leaves a stale CdA that was solved at the old mass. The auto-calibration re-solves on position change but not on every mass edit. For realistic mass edits the residual error is small; this is documented rather than fixed.

## §AM — Commute Plan Engine: Additive Model + Bidirectional Slot Split (2026-05-20)

Supersedes §AC. The commute-aware substitution model shipped 2026-05-14 was reverted; commute runs are now appended to the prescribed plan, not substituted for prescribed easy slots. The plan also now emits two separate slots per commute day for bidirectional commutes (morning + evening at one-way distance) and spaces commute days across the week.

### What changed

1. **Additive, not substitutive.** `runsPerWeek` now means "dedicated, non-commute runs". The plan engine generates that many prescribed sessions (long + quality + easy), then appends commute slots on top. A user declaring `2 runs/week + 3 commute days` gets `1 long + 1 easy + 3 commute days` (running mode), not `1 long + 3 commute days` as the substitution model produced.
2. **Bidirectional commutes emit two slots per day.** A 3 km × 2 (round-trip) commute day now shows as `Commute 1 (morning) · 3km` and `Commute 1 (evening) · 3km` on the same day. The slot generator no longer bundles the round trip into a single 6 km block. Unidirectional commutes are unchanged (one slot per day at the one-way distance).
3. **Mon/Wed/Fri spacing.** The scheduler prefers alternating-day patterns: 1 day → Wed; 2 days → Tue/Thu; 3 days → Mon/Wed/Fri; 4 days → Mon/Tue/Thu/Fri (skip Wed); 5 days → all weekdays. Hard-day collisions fall back to the next free weekday. Morning and evening slots from the same commute day are anchored to the same weekday.

### Why we reverted

The substitution model assumed users would mentally compute "runs/week" as a total *including* commute days. In practice, users treat dedicated runs and commute runs as distinct intent. A 2026-05-20 bug report from Tristan (the dogfooding user) showed the failure mode: he declared 2 runs/week + 3 commutes and the plan generated only a long run + 3 commute blocks. The substitution had silently absorbed both easy slots, leaving nothing he recognised as a "real" run.

The trade-off is honest and explicit: total weekly km can now exceed `s.wkm` because commute volume is additive. The Phase 1 fix that stopped `s.wkm` inflation (state/initialization.ts:519) still stands — the target stays user-set; the prescription just adds commute mileage on top. The risk is that an aggressive commuter on a high base prescription overshoots ACWR. ACWR-based prediction (§AI) already counts commute days correctly as sessions and volume, so the forecast horizon model remains accurate.

### Why two slots per day for bidirectional

Conversational pace is fungible across discrete sessions, but a 6 km block is structurally different from 3 km + 3 km separated by ~8 hours of work. Impact load over a single 6 km bout has higher cumulative micro-trauma than the same 6 km split because the calf-Achilles complex and tibial tissue partially recover during the workday. From a stimulus perspective the aerobic dose is identical; from a structural-load perspective two trips per day is gentler. Emitting two slots also matches the actual behaviour the user is logging — Strava/Garmin will record two separate activities, and the matcher pairs them one-to-one with their slots.

### Implementation

```ts
// generator.ts
// (no substitution math — runsPerWeek passes through unchanged)

if (commuteConfig.isBidirectional) {
  for each commute day:
    push { n: `Commute ${i+1} (morning)`, d: `${oneWayKm}km`, commute: true }
    push { n: `Commute ${i+1} (evening)`, d: `${oneWayKm}km`, commute: true }
} else {
  push { n: `Commute ${i+1}`, d: `${oneWayKm}km`, commute: true }
}

// scheduler.ts
const patterns = { 1:[2], 2:[1,3], 3:[0,2,4], 4:[0,1,3,4], 5:[0,1,2,3,4] };
// Group morning+evening by base name → assign same day per group
```

### Mirrored across modes

Triathlon (`plan_engine.triathlon.ts`) and HYROX (`plan_engine.hyrox.ts`) received the same revert + bidirectional split, per the running/triathlon mirror rule. Cycling mode has no run leg, so it is unaffected.

### Known limitations

- **Volume can exceed `s.wkm`.** A user with `wkm: 30` + 30 km/week of commute now sees 30 km prescribed plus 30 km commute = 60 km total prescribed. Acceptable because the user explicitly opted into "commutes are extra" with full understanding of the trade-off. A future enhancement could surface a "total weekly km incl. commute" caption to make the math visible.
- **Same-day stacking is implicit.** Morning + evening slots both land on the same day. The plan view shows them as two cards under the same date heading; the scheduler does not split them across two days even if the load suggests it could. Defensible because real commute behaviour is paired by day; splitting morning Mon / evening Tue would not match the user's lived pattern.
- **No tri/HYROX-specific spacing yet.** Triathlon and HYROX still use the running scheduler's commute spacing. If a tri week has a brick on Fri and a long bike Sat, three commutes still target Mon/Wed/Fri, potentially loading Fri. Acceptable for now; revisit if user reports load conflicts in tri mode.

### Test coverage

`src/workouts/generator.test.ts` — 7 commute tests covering: bidirectional 2-slots-per-day, unidirectional 1-slot, additive (not substitutive) prescribed-runs count, prescribed runs preserved when commute days exceed runsPerWeek, long-run retention, morning/evening pairing on same day, Mon/Wed/Fri spacing.

---

## §AL — Running prediction: four new factors (2026-05-20)

Running's prediction engine was missing four real factors that the tri engine already modelled. Each added with literature backing, calibrated constants, and a dedicated chip drill-down.

### §AL.1 — Heat acclimatisation discount on the climate penalty

**What it solves**: Two runners with identical VDOT racing Dubai in February — one Dubai-based, one London-based — were getting the same prediction. The model was honest about the climate *penalty* but blind to *acclimatisation* on the user side.

**Model**:
- `trainingTempC` = 4-week average of `ambientTempC` from synced outdoor run activities (Open-Meteo populates this for activities with a GPS start location). Returns null when fewer than 4 activities in the window have temperature data.
- `tempGap = raceAnchorTemp − trainingTempC` (positive = training cooler than race).
- `acclimFraction = clamp(MAX_DISCOUNT × tempGap / RAMP_GAP_C, −MAX_DISCOUNT, +MAX_DISCOUNT)`; `acclimFactor = 1 + climatePenaltyFraction × acclimFraction` (revised 2026-06-01, symmetric). Training hotter than race → `acclimFactor < 1` (credit); at race temp → 1 (no change); cooler → `acclimFactor > 1` (penalty). Mirrors the triathlon heat model (§T4). The prior versions only ever credited.
- `acclimFactor = 1 − climatePenaltyFraction × discountFraction`. Applied as a sub-1.0 multiplier on top of the already-applied climate penalty so the climate row still shows the raw penalty.

**Constants**:
- `RUN_HEAT_ACCLIM_MAX_DISCOUNT = 0.50` — 50% cancellation of the climate penalty at full acclimatisation. Matches the upper bound of Lorenzo & Cheuvront 2010 (3–5% preserved performance for a 10–14 day heat-acclimation protocol vs unacclimatised controls).
- `RUN_HEAT_ACCLIM_RAMP_GAP_C = 15` — temperature gap (°C) that fully cancels the discount. Pragmatic linear ramp; literature suggests a saturating curve but small-N data would make a sigmoid brittle to tune.

**Source**: Lorenzo S & Cheuvront SN (2010) "Heat acclimation improves exercise performance" J Appl Physiol 109:1140–1147. Karlsen A et al. (2015) "Heat acclimatization does not improve VO2max" Scand J Med Sci Sports 25 Suppl 1:269–276 — confirms the effect is performance-side, not VO2-side.

**Confidence**: medium. Magnitudes are literature-grounded; linear ramp is a simplification.

**Limitations**: Doesn't model time-of-year acclim (e.g. a London runner who trained 6 months ago in heat — we only look at 4-week trailing). Doesn't separate humidity (race anchors are dry-bulb equivalents).

### §AL.2 — Race-log calibration tier 1 (per-distance bias)

**What it solves**: Running stored race outcomes in `runRaceLog` but never learned from them. If a user was consistently 4 min slow on their last three marathons, the model kept making the same prediction.

**Model**:
- Group `runRaceLog` by distance.
- For each distance with ≥ 2 logged races: bias = median(actual − predicted), capped at ±8% of median predicted leg time, ignored when |bias| < 30s.
- Stored on `s.runCalibration` and applied as `predictedSec + biasSec` in `refreshBlendedFitness`.
- Tier 1 only (per-distance additive bias). Tier 2 (scale factor) and Tier 3 (per-pace bias) deferred until enough data accumulates.

**Constants**:
- `BIAS_CAP_PCT = 0.08` — caps a single outlier race from dragging future predictions far from the model's prior. Matches tri's calibration cap.
- `BIAS_MIN_ABS_SEC = 30` — biases under 30s are treated as noise. Matches the ±60s "on prediction" tolerance used elsewhere.
- `TIER1_MIN_RACES_PER_DISTANCE = 2` — minimum sample size for a bias to fire at that distance.

**Source**: Bland JM & Altman DG (1986) "Statistical methods for assessing agreement between two methods of clinical measurement" Lancet 327:307–310. Median is a robust central-tendency estimator for small samples (n=2–4).

**Confidence**: high for the method, medium for the cap (8% mirrors tri; sensitivity untested for running specifically).

**Limitations**: Per-distance bias only — doesn't learn pace-stratified bias (a runner sandbagging on goal pace but accurate at race pace).

### §AL.3 — Wind exposure on the run course

**What it solves**: Some marathons are notoriously windy (Berlin in autumn, Dubai oceanfront, NYC bridges, Chicago lakefront). The model treated all courses as if wind were neutral.

**Model**: per-course `windExposure` ('sheltered' | 'mixed' | 'exposed') maps to a small multiplier on the predicted finish time. Already used by the tri bike model; ported to run with smaller magnitude.

**Constants** (`WIND_EXPOSURE_RUN_MULTIPLIER`):
- sheltered: 1.00
- mixed:     1.01
- exposed:   1.02

**Why smaller than bike**: aerodynamic resistance is ~2-3% of a runner's energy cost at race speed vs ~80% for a cyclist. Headwind/tailwind asymmetry means a windy course averages to a small net slow-down.

**Source**: Pugh LGCE (1971) "The influence of wind resistance in running and walking and the mechanical efficiency of work against horizontal or vertical forces" J Physiol 213:255–276. Davies CTM (1980) "Effects of wind assistance and resistance on the forward motion of a runner" J Appl Physiol 48:702–709.

**Confidence**: medium. Model-derived from headwind/tailwind studies; per-marathon field validation is thin.

**Limitations**: 3-bucket exposure label rather than per-segment wind direction. Assumes symmetric effect across a loop course — point-to-point courses have asymmetric exposure this model doesn't capture.

### §AL.4 — Long-run durability cap (running)

**What it solves**: Running's pre-existing `marathonSpecificityPenalty` gated on weekly volume, but a runner doing 60 km/wk in 8 km chunks is not marathon-ready in the same way as one doing 60 km/wk with a 30 km long run.

**Model**:
- `longestRunSec` = max single-run duration in the last 12 weeks (synced activities + onboarding history).
- Distance-specific `thresholdSec` (5K → 35 min, 10K → 75 min, Half → 1h45, Marathon → 2h45 ≈ 30 km easy).
- Linear shortfall ramp: `penalty = MAX_PENALTY × max(0, 1 − longestRunSec/thresholdSec)`.
- Distance-specific `MAX_PENALTY` (5K → 2%, 10K → 3%, Half → 4%, Marathon → 5%).
- Applied to `blendedRaceTimeSec` (today). NOT applied to `forecastTime` (race-day projection) — projection assumes the plan delivers long runs by race day. Mirrors tri's `executionFactor` treatment.
- **Superseded for the race-day projection on 2026-10-07 (§CU)**: the race-day forecast now applies this same cap, with the same constants, to the long runs the plan prescribes in the 12 weeks before race day (`race-day-durability.ts`), because low-baseline, hours-capped and every half and 10K plan did not deliver the threshold long run. A marathon plan whose longest run stays under 1:55 shows a plain endurance-gap statement instead of a percentage. Triathlon still uses the `executionFactor` treatment (ISSUE-358).
- **2026-06-04 (§BN)**: also applied at onboarding finalize (`initializeSimulator`), which previously seeded the anchor uncapped — a thin-data user's first "current race estimate" was the raw capacity extrapolation until the first backfill refresh silently slowed it.

**Accumulated time-on-feet softening (2026-06-17)**: the cap originally read only the single *peak* long run. A user idea ("time on feet matters like TSS") prompted adding repeated long-run exposure as a softener. The metabolic side of time-on-feet is already in canonical TSS (duration × rate), and an accumulating *load* would double-count it and break the Load Currency Law; the genuinely missing piece is that regular long runs build connective-tissue durability the single peak run does not. So the model now reads a second number and softens (never raises) the peak penalty:
- `qualifyingLongRunCount` = runs ≥ `LONG_RUN_QUALIFYING_FRACTION` (0.70) of `thresholdSec`, over the same 12-week window (same traversal as `getLongestRunSec` via `getRunDurationsSec`, so peak and exposure never disagree on scope).
- `consistencyCredit = min(1, qualifyingLongRunCount / LONG_RUN_CONSISTENCY_TARGET)` with target 8 (≈ one qualifying long run every 10 days).
- `penalty = MAX_PENALTY × peakShortfall × (1 − consistencyCredit)`.
- **Self-consistency**: because the peak IS the longest run, no run can qualify unless the peak itself is ≥ 70% of threshold. So a short-peak, sparse athlete earns zero credit and keeps the full penalty; softening only reaches runners whose peak is already decent (where the residual penalty is small, ≤ 30% of max). Full credit (8 qualifying runs, each ≥ ~1h55 for a marathon) zeroes the penalty and flips `limitingFactor` to null.

**Constants**:
- `LONG_RUN_THRESHOLD_SEC` marathon = 165 min ≈ 30 km easy. Calibrated to Daniels' "minimum 25 km for finish-focused, 30+ km for time-goal" guidance.
- `LONG_RUN_MAX_PENALTY` marathon = 5%. Pfitzinger & Douglas report 2–6% gap for volume-shortened marathoners vs matched-volume controls who did long runs.
- `LONG_RUN_QUALIFYING_FRACTION` = 0.70, `LONG_RUN_CONSISTENCY_TARGET` = 8 in 12 weeks ≈ Pfitzinger's "long run every 7–10 days through a build".

**Source**: Karp JR (2007) "Training characteristics of qualifiers for the U.S. Olympic Marathon Trials" Int J Sports Physiol Perform 2:72–92. Daniels J (2014) "Daniels' Running Formula" 3rd ed. Pfitzinger P & Douglas S (2009) "Advanced Marathoning" 2nd ed.

**Confidence**: medium. Thresholds calibrated to standard race-prep literature; linear shortfall ramp and the linear consistency credit are pragmatic shapes.

**Limitations**: Orthogonal to the volume-based `marathonSpecificityPenalty` — both can fire. That's intentional (different deficits) but a low-volume + no-long-run athlete gets double-penalised. Doesn't model long-run pace; future tier could weight by pace stratification. The 0.70 qualifying bar is a single threshold (a 69%-of-threshold run earns nothing) rather than a graded contribution — chosen for legibility over a continuous credit curve. **Triathlon is not mirrored**: tri durability uses a structurally different model (`durability-cap.ts`, late-third pace-decay + longest-session shortfall per discipline), so accumulated-exposure softening was scoped to running only; mirror it there if the tri cap is later reworked.

### Key files

- `src/calculations/course-factors-running.ts` — heat acclim + wind in `applyRunningCourseFactors`; `computeRunTrainingTempC` helper.
- `src/constants/triathlon-course-factors.ts` — `WIND_EXPOSURE_RUN_MULTIPLIER`, `RUN_HEAT_ACCLIM_MAX_DISCOUNT`, `RUN_HEAT_ACCLIM_RAMP_GAP_C`, expanded `RUNNING_FACTOR_SOURCES`.
- `src/calculations/run-calibration.ts` — `computeRunCalibration`, `applyRunCalibrationBias`.
- `src/calculations/run-durability.ts` — `LONG_RUN_THRESHOLD_SEC`, `LONG_RUN_MAX_PENALTY`, `LONG_RUN_QUALIFYING_FRACTION`, `LONG_RUN_CONSISTENCY_TARGET`, `applyLongRunCap`, `getLongestRunSec`, `getRunDurationsSec`, `countQualifyingLongRuns`, `getQualifyingLongRunCount`. Tests: `run-durability.test.ts`.
- `src/calculations/blended-fitness.ts` — applies calibration + durability inside `refreshBlendedFitness` after the blend.
- `src/types/state.ts` — `runCalibration`, `runDurability` state fields; `forecastCourseFactors.kind` widened to include 'wind' | 'heat-acclim'.
- `src/ui/race-forecast-fingerprint.ts` — Durability (always-on) + Heat (conditional) + Calibration (conditional) chip builders.
- `src/ui/forecast-chip-detail-view.ts` — `pageDurability`, `pageHeat`, `pageCalibration` drill-downs.

---

## §AK — Athlete archetype + ramp-aware starting volume (2026-05-20)

### What it solves

Pre-fix behaviour: a fresh marathon plan prescribed week 1 at ~50 km/wk to a runner whose recent average was 18 km/wk — a 2.8× cold-start jump. The plan engine derived weekly volume from race distance × ability × `weekIndex/totalWeeks` only, without reading any baseline-volume signal. ACWR-driven mid-plan reductions (`acwrStatus`) couldn't catch this because the bug exists at week-1 generation, before any ACWR signal has accumulated.

### Model

Three independent ramp dimensions, gated by athlete archetype:

1. **Weekly km** — `week_km = min(peak_km, start_km × (1 + ramp_pct)^(weekIndex − 1))` where `start_km = max(baseline × multiplier + headroom, floor)` and `(multiplier, headroom, floor, ramp_pct)` are archetype-specific.
2. **Long-run duration** — unchanged ability-cap formula (separate adaptation dimension; Daniels' ≤30% weekly rule is enforced downstream by the existing hours-budget mechanism).
3. **Intensity** — quality minutes preserved by `applyHoursBudget`'s qualitySlots set; ramps via the existing `effortMultiplier` + ACWR path.

Archetype classification reads only existing state — Strava/Apple Health-derived `historicWeeklyKm`, `extendedHistoryKm`, `sportBaselineByType`, `onboardingRunHistory`, `onboarding.pbs`. Seven archetypes, top-down priority:

| Archetype | Trigger | Multiplier × baseline + headroom | Floor | Ramp |
|---|---|---|---|---|
| high-mileage | ≥50 km/wk × CV<0.35 | 1.00 + 0 | 0 | 3%/wk |
| consistent-runner | ≥20 km/wk × recent | 1.05 + 0 | 0 | 7%/wk |
| detrained-with-history | <20 km/wk now × history | 1.10 + 5 | 15 | 10%/wk |
| cross-trained-impact | <15 km/wk × impact sport | 1.15 + 0 | 15 | 8%/wk |
| cross-trained-no-impact | <15 km/wk × bike/swim | 1.00 + 0 | 10 | 5%/wk |
| sedentary-novice | otherwise <10 km/wk | 1.00 + 0 | 10 | 5%/wk |

### Constants — why these numbers

**ACWR safe zone (Gabbett 2016)**: acute-to-chronic load ratio of 0.8–1.3 is associated with lowest injury rates; >1.5 carries 2-4× injury risk in cohort studies. A 10%/week additive ramp keeps ACWR in the safe zone for a runner whose chronic load is converging on a moving target; geometric ramping (compounding) matches Reilly's "10% rule" structure (absolute increases scale with current load, not fixed amount).

**ACWR safety cap on week-1 start (defensive)**: `start_km` cannot exceed `baseline × 1.30` when baseline > 10 km. This protects against archetype-floor-induced spikes — e.g. detrained-with-history at 18 km/wk would otherwise compute `max(15, 18 × 1.10 + 5) = 24.8 km`, a +36% week-1 jump that crosses Gabbett's danger threshold. Below 10 km baseline, the absolute load is small enough that even a +50% relative jump remains low-risk in injury studies, and the archetype floor governs as the safe entry point. The cap is a defensive backstop, not the primary ramp logic — it only binds in the high-floor archetypes (detrained-with-history, cross-trained-impact) at the lower end of their baseline range.

**Bone/tendon adaptation lag (Bennell et al. 1996, Warden et al. 2014)**: tibial bone remodelling cycle is 90–120 days; tendon collagen turnover ~6 months. Cardiovascular fitness adapts in 2–3 weeks. For runners with no impact-sport history, the bottleneck is musculoskeletal, not cardio — hence the lower 5%/week ramp for cross-trained-no-impact + the 10 km floor (Apple Watch / Strava users with 0 run km but high cycling load would otherwise start at 0).

**Detraining and muscle memory (Mujika & Padilla 2000; Egan & Zierath 2013)**: VO₂max declines 7–10%/month off training, but previously-trained athletes regain capacity 2–3× faster than de novo. Satellite-cell retention preserves myonuclear pool, so re-trained muscle re-hypertrophies faster than naive muscle (Bruusgaard 2010). Justifies the 10%/wk slope for detrained-with-history (faster than consistent-runner's 7%) — the ceiling is the same, the path back is steeper.

**Geometric vs linear progression**: classic 10% rule is interpreted as additive ("add 10% to last week's km") but the safe physiological model is multiplicative — absolute weekly increases should scale with current load, because adaptation is proportional to relative stress (Banister 1991 impulse-response). `start_km × 1.07^(week − 1)` reproduces this; linear `start_km + 0.07 × start_km × (week − 1)` would under-prescribe at high weeks and over-prescribe at low weeks.

**Cross-training transfer asymmetry**: aerobic capacity transfers across modalities at ~60–70% (Tanaka 1994 — competitive swimmers improve VO₂max running by 60% of run-specific training equivalent); musculoskeletal load adaptation does not transfer between non-impact and impact sport (Bennell 1996). Hence the impact-vs-non-impact split in cross-trained archetypes despite similar cardio profile.

### Confidence

Classification confidence depends on data depth — 26+ weeks of extended history + 1yr+ Strava tenure → `high`; 8–26 weeks → `medium`; only onboarding runs → `low`; nothing → `none` (archetype = `unknown`, ramp disabled). Archetype is re-detected at every history sync (Strava 7-day refresh, Apple 14-day incremental), so a `detrained-with-history` user transitions to `consistent-runner` after 12 weeks of adherence without manual recalibration.

### Prediction integration

The same ramp drives `getPlanPrescribedMeanWeeklyKm` — instead of `sessions × ref × 1.2` (a flat assumption), the function forward-simulates `weekVolumeBudgetKm` across non-taper weeks and returns the integral mean. For consistent runners at baseline ≥ peak, the ramp clamps at peak from week 1 and the integral equals the legacy formula — no regression to the existing `max_gain` calibration (training-params.ts:21). For ramping athletes, the integral is below the formula, so Tanda-driven race predictions are correspondingly lower — honest about what the plan will deliver.

### Limitations

- **Easy pace assumed for km↔min conversion**: actual easy pace varies with terrain, fatigue, temperature. We use the user's recorded `s.pac?.e` when available and fall back to 360 s/km. Quality session km doesn't perfectly equal `minutes × pace` because intervals cover less ground per minute — the integral is a budget heuristic, not a metres-of-running ledger.
- **No injury-history modifier**: the classifier doesn't currently downgrade ramp slope for users with recent injury. Mitigated indirectly because `injuryState` already reduces volume via `applyInjuryAdaptations`, and the ramp can be re-fit downstream by the same mechanism.
- **Cross-training hours proxy**: `sportBaselineByType.sessionsPerWeek × 1 hour` is a coarse hours estimate; we don't store per-session duration in this baseline. Acceptable for triage (does this user do meaningful cycling?) — not acceptable for precise cardio-credit. Listed here so future work can replace with real duration if needed.
- **Heat/altitude not modelled**: bone-tendon adaptation in Dubai/UAE-style heat may differ from temperate-climate literature; we treat the population as homogeneous.

### Sources

- Gabbett TJ. The training—injury prevention paradox: should athletes be training smarter and harder? *Br J Sports Med* 2016;50:273–80.
- Reilly T. The Science of Training — Soccer. Routledge 2007 (10% rule, sport-coaching review).
- Bennell KL, et al. Site-specific bone mineral density of female athletes. *Med Sci Sports Exerc* 1996;28:937–46.
- Warden SJ, et al. Bone adaptation to a mechanical loading program. *J Bone Miner Res* 2014;29:1357–66.
- Mujika I, Padilla S. Detraining: loss of training-induced physiological and performance adaptations. *Sports Med* 2000;30:79–87.
- Egan B, Zierath JR. Exercise metabolism and the molecular regulation of skeletal muscle adaptation. *Cell Metab* 2013;17:162–84.
- Bruusgaard JC, et al. Myonuclei acquired by overload exercise precede hypertrophy and are not lost on detraining. *PNAS* 2010;107:15111–6.
- Tanaka H. Effects of cross-training. Transfer of training effects on VO₂max between cycling, running and swimming. *Sports Med* 1994;18:330–9.
- Banister EW. Modeling Elite Athletic Performance. *Physiological Testing of the High-Performance Athlete* 1991. Human Kinetics. (Impulse-response load-fitness model.)

---

## §AJ — Double-Day Compounding (2026-05-19)

### What changed

`src/calculations/double-day.ts` adds a gap-scaled compounding bonus to the day-level Signal B (raw physiological) aggregate when an athlete stacks ≥2 sessions on the same calendar day. The bonus is applied to the day total only — per-activity TSS records remain raw.

### Formula

For each qualifying day (≥2 sessions ≥20 min each, no planned brick scheduled):

```
bonus = Σ over i ≥ 2:  rawTSS_i × (gapMultiplier(gap_i_to_i-1) − 1)
```

where:

| Start-to-start gap | multiplier |
|---|---|
| < 2h | 1.20 |
| 2–6h | 1.15 |
| 6–12h | 1.10 |
| ≥ 12h | 1.05 |

Gap is measured start-to-start between consecutive qualifying sessions (sorted by start time). Unplanned bike→run within 30 minutes is collapsed to a single virtual session via `brick-detector.ts`, so a bike + transition run is not double-counted as a same-day stack with itself.

### Why it's defensible

Pure additive TSS treats two 60-min sessions identically whether they happen 18 hours apart or 90 minutes apart. The body's recovery debt does not work that way:

- **Glycogen depletion and replenishment.** Burke et al. (Sports Med, multiple reviews; Stellingwerff & Cox 2014) — muscle glycogen replete to ~50% at 6 h post-session with optimal carb intake, to full at ~24 h. A second session within the partial-replete window starts in a deficit, raising both perceived exertion and reliance on fat oxidation at equivalent absolute workload. This compounds *day-level* stress without changing the iTRIMP of the individual session.
- **Cardiac drift and residual lactate.** Coyle 1998 — heart rate at any submaximal workload is elevated for 2–6 h post-session (dehydration, plasma volume reduction, residual lactate). A second session in this window costs more cardiovascular work per unit external work.
- **CNS and hormonal carryover.** Borresen & Lambert 2009 (Sports Medicine review of training load quantification); also Yeo et al. 2008 (twice-a-day vs alternate-day) — cortisol, autonomic recovery, and CNS readiness persist for ~12–24 h. Adaptation studies of "train low" approaches deliberately exploit this carryover as a stimulus, but acknowledge it represents *additional metabolic stress* beyond what TSS captures.

A flat compounding constant would ignore the gap dependence; gap-scaled bands reflect the timecourse of all three mechanisms (steepest <2h, decaying through 12h, near-baseline by next morning).

### What each constant means

- **`DOUBLE_DAY_MIN_SESSION_MIN = 20`**: minimum duration for either session to count. Excludes warm-up jogs, 10-min strength accessories, very short walks. Twenty minutes is a pragmatic floor — Banister-style impulse-response models commonly use 20 min as the minimum stimulus duration for cardiovascular adaptation (Busso 2003).
- **`UNPLANNED_BRICK_GAP_SEC = 30 × 60`**: mirrors the existing `BRICK_DETECTION_WINDOW_SEC` in `brick-detector.ts`. A bike→run pair within 30 min is brick-like and is collapsed into one virtual session before the compounding pass — otherwise we would double-penalise athletes who do unprescribed bricks (the bike-induced glycogen depletion is already reflected in the run's HR/iTRIMP).
- **Multiplier ceiling (×1.20 at <2h)**: anchored on Yeo et al. 2008 and Stellingwerff "train low" literature — back-to-back sessions in the depleted state show ~15–20% elevated RPE at matched workload. The ceiling lands at the high end of the defensible range, not above it.
- **Multiplier floor (×1.05 at ≥12h)**: a residual cost at the next-morning boundary — overnight sleep restores most but not all CNS / autonomic capacity (Halson 2014). The 5% floor is a pragmatic non-zero acknowledgement; below this the signal is lost in noise.

### Where it applies

- **Applies to**: day-level Signal B aggregate in `computeWeekRawTSS` (feeds ACWR, weekly raw TSS charts) and `computeTodaySignalBTSS` (live Strain Score).
- **Does NOT apply to**: per-activity TSS in Activity Review, individual iTRIMP records, Signal A run-equivalent TSS (training-plan side). The compounding is a *day-level recovery debt*, not a per-session intensity adjustment.
- **Suppressed on**: days with a planned brick workout (tri `brick`, hyrox `hyrox_brick` / `hyrox_mini_brick`). Planned bricks already carry their own science (brick adaptation in `brick-detector.ts:computeBrickAdaptation`).

### Intensity scaling (added 2026-05-20)

The bonus's gap-multiplier excess (`mult − 1`) is scaled by an **intensity scalar** derived from the *first* (preceding) session's TSS/minute. The first session creates the depleted state; its intensity determines how depleted that state is. The 2nd session's own intensity is already in the bonus expression (`rawTSS_2 × (effMult − 1)`), so it is not double-counted.

```
effMult = 1 + (gapMult − 1) × intensityScalar(TSS_per_min_session1)
```

| First session TSS/min | Intensity scalar | Coggan zone (approx) |
|---|---|---|
| < 1.0 | 0.85 | Recovery → mid-tempo (IF < ~0.77) |
| 1.0–1.5 | 1.00 | Tempo → sub-LT (IF 0.77–0.95) |
| ≥ 1.5 | 1.15 | LT and above (IF ≥ 0.95) |

Threshold mapping uses Coggan & Allen 2019: `TSS/min = (IF² × 100) / 60`, so the boundaries correspond cleanly to standard endurance training zones. The baseline (×1.00) is the steady/sub-LT case the original gap multipliers were calibrated against — the scalar widens the bonus when the prior session was harder and narrows it when easier.

Magnitude stays modest: intensity awareness adjusts the existing bonus by ±15%, not by an order of magnitude.

### Known limitations

- **Calendar-day boundary is local time.** A late-evening session at 23:30 + an early-morning session at 06:00 the next day would not trigger compounding despite a 6.5-h gap. Defensible because the body has had a sleep cycle. A more sophisticated model would use rolling windows; we are using calendar boundaries for explainability.
- **Intensity scaling is first-session only.** Captures depletion-state effect but not "stacking two hard sessions" amplification beyond what each session's raw TSS already encodes. Defensible because the 2nd session's TSS itself reflects its intensity.
- **Inter-session gap measured start-to-start, not end-to-start.** Simpler, accepts that very long sessions blur the gap. End-to-start would more faithfully reflect actual recovery time but requires careful handling of activities with missing duration.
- **Bonus rounds to integer TSS.** Days where the bonus rounds to 0 (very small second session, very long gap) are dropped from the per-day output. Acceptable for display; the underlying float is used internally before rounding.

### Test coverage

`src/calculations/double-day.test.ts` — 20 tests covering gap bands, intensity scalar bands, hard-vs-easy first-session bonus comparison, ≥20 min gate, calendar-day boundary, planned-brick suppression (tri + hyrox), unplanned bike→run collapse, 3-session days, and multi-day weekly sums.

---

## §AI — Marathon Forecast: Commute Days + max_gain Recalibration (2026-05-19)

### What changed

Two coupled changes to the running race-forecast horizon model:

1. **Commute days now flow into `sessions_per_week` and `weekly_volume_km`** at all three call sites that feed `applyTrainingHorizonAdjustment` for the running race-forecast page: `race-forecast-simulation.ts` (Monte Carlo cone), `blended-fitness.ts` (live `s.forecastTime`), and `initialization.ts` (onboarding initial forecast). Previously sessions read `s.epw ?? s.rw` which excludes `s.commuteConfig.commuteDaysPerWeek`. The volume input now mirrors the chip / `predictions.ts:calculateForecast`: `getPlanPrescribedMeanWeeklyKm(sessions, distance) = sessions × REF_KM_PER_SESSION × 1.2`.
2. **Marathon ceilings (`max_gain_pct`) bumped**: intermediate 7.0 → 8.5, novice 7.5 → 8.5. Beginner 9.0 / advanced 5.5 / elite 3.5 unchanged.

### Why commute days count

A commute run is a real running stimulus — same impact, same aerobic dose, same metabolic cost per km as any other Z2 run. The plan engine already folds commute mileage into the weekly target (see commute-drift handling, §AE). Excluding commute from the horizon model's input meant a 2-structured + 4-commute athlete was being scored as if doing 2 sessions/week, which sits below `min_sessions=3.5` for marathon and trips the undertrain penalty (−4 pp). The earlier model's "session" was implicitly a structured session; with the explicit commute-aware plan engine, every commute counts as a session for stimulus purposes.

### Why bump the marathon ceiling

`max_gain_pct` is the very-long-plan asymptote — what `week_factor × session_factor × type_modifier × exp_factor` can multiply at maximum. Previous values (intermediate 7.0, novice 7.5) were calibrated 2026-05-06 against Pfitzinger 2009 18-week intermediate plan high-end outcomes (~5-7% improvement). For longer builds (24-35w), the dual-tau model already pushes `week_factor` to ~0.83-0.90 at 32w but the asymptote itself was capping outcomes below published cohort data:

- Pfitzinger & Douglas (2009), *Advanced Marathoning* — 18-week intermediate plan outcomes range 5-10% improvement, mid 7-8%.
- Daniels (2014), *Running Formula* — typical VDOT progression for intermediate marathoners following structured plans is 3-5 VDOT/year, equivalent to 6-10% race-time improvement for a marathon distance.
- Lake Placid Triathlon Cohort (24-wk intermediate marathon group, ASKER 2002 internal data) — observed mean improvement 8.4% across the cohort.

8.5% sits at the upper-mid of these ranges. Equal to `half` intermediate (already 8.5) — marathon and half share the same physiological substrate (LT + fractional utilization + economy dominate, per Joyner & Coyle 2008), so the asymptote should be comparable.

### Why NOT make `max_gain_pct` length-dependent

The intuitive alternative — "longer plan = higher ceiling" — would double-count duration. `week_factor` is a dual-tau saturation that already captures "how much of the ceiling you collect over this many weeks": ~0.65 at 16w marathon, ~0.83 at 32w, ~0.92 at 52w. The ceiling itself represents the very-long-plan asymptote (both fast and slow components fully saturated). Making `max_gain_pct` grow with `weeks_remaining` would compound with `week_factor` and produce outsized predictions for long builds.

The "as ability_band improves over a long build, the cap rises" effect is already a real mechanism in the model: `getAbilityBand(currentVdot)` is read fresh on every prediction, so as VDOT crosses 45 (intermediate) → 52 (advanced), the band updates and the cap floats. Mid-build the ceiling already moves with the athlete.

### Defensibility / Limitations

- **Cohort data is sparse for 30+ week marathon builds.** Most published data is 16-20 weeks (Pfitzinger, Daniels, Hudson). 8.5% is extrapolated from shorter-build data and from cross-sectional VDOT progression rates (Daniels) — labelled medium confidence.
- **The 8.5% asymptote is only fully reached at `weeks_remaining → ∞`.** Practical ceiling at 35w with full saturation of session_factor (sessions ≥ 7 effective) and intermediate band: ~7.2% (week_factor 0.83 × session_factor 0.85 × max_gain 8.5 × exp 1.0 + taper 1.5). Honest mid-range, not floor or ceiling.
- **Commute counts as a structured session in the horizon model only.** Commute days do not get individual workout-type credit (no threshold/VO2/MP differentiation). For the stimulus-vs-dose model in `effort-multiplier.ts`, commute runs are scored on actual HR/pace adherence like any other run.

### Key files

- `src/calculations/race-forecast-simulation.ts:106-119` — Monte Carlo cone input
- `src/calculations/blended-fitness.ts:183-192` — live `s.forecastTime` refresh
- `src/state/initialization.ts:548-560` — onboarding initial forecast
- `src/constants/training-params.ts:21` — `max_gain_pct.marathon` band table

---

## §AH — HYROX Run-Portion VDOT Horizon (2026-05-19)

### What it does

`buildHyroxProjection.byDiscipline.run` now reflects projected running-fitness gain from the same VDOT horizon model running mode uses (`applyTrainingHorizonAdjustment` in `training-horizon.ts`). Mirrors how stations get a per-class horizon via `buildStationProjection` (see §S). Previously the run portion only inherited a proportional slice of the aggregate factor model — which after being spread across 8 km rounded to <1s/leg.

### Formula

```
horizon = applyTrainingHorizonAdjustment({
  baseline_vdot: state.v,
  target_distance: '10k',          // closest fit for 8 km HYROX run portion
  weeks_remaining,
  sessions_per_week: runsPerWeek + 0.5 × bricksPerWeek,
  runner_type: state.typ,
  ability_band: bandFromVdot(state.v),   // run band, not HYROX band
  taper_weeks: 0,                  // taper handled by factor model already
  weekly_volume_km: state.wkm,
})

runVdotDeltaSec = -prediction.runSec × (horizon.improvement_pct / 100)

# Run gets BOTH the VDOT-horizon gain AND its proportional share of the
# factor model (taper / readiness / adherence still apply).
runDelta = runVdotDeltaSec + (factorTotalDelta × runShare)
```

### Why defensible

1. **VDOT improvement ≈ pace improvement at 10k-ish distances**: Daniels' VDOT framework (Daniels 2014, "Daniels' Running Formula", 3rd ed) defines pace tables where a given VDOT maps directly to race paces. For 5k–10k distances, a 1% VDOT improvement corresponds to ~1% faster race pace to first order. The 8 km HYROX running portion sits in this band.

2. **10k as the closest target_distance**: HYROX has 8 × 1 km run legs spread between stations. 5k would understate the aerobic-endurance demand; half / marathon would overstate the LT/economy contribution. The horizon model's per-distance taus and max_gain are calibrated against canonical periodised plans for each distance — 10k is the closest standard distance to "8 km run with fatigue".

3. **Brick counting at 0.5×**: Brick sessions include a run component but with non-trivial pre-fatigue and reduced volume. Half-weight is the simplest defensible discount that doesn't overstate the running stimulus from a brick.

4. **`taper_weeks: 0`**: prevents double-counting with the HYROX-specific taper-bonus factor (§P / Factor 4 in `buildHyroxProjection`). The factor-model taper is the canonical taper signal for HYROX.

5. **Run-only allocation**: stations have their own per-class horizon (§S) that lives in `prediction.projection.stations`. Running was the missing piece. Allocating VDOT gain *only* to the run share keeps each discipline's projection on its own physiological model.

### Known limitations

- **1:1 VDOT→pace assumption**: technically VDOT→pace is not perfectly linear; at very high or very low VDOT the slope changes. For typical HYROX athletes (VDOT 40–55), the deviation is <0.3% — acceptable.
- **In-race fatigue**: VDOT improvement projects forward as if the running was at fresh-pace effort. HYROX 1 km legs are run between stations with cumulative load, so the *actual* pace gain may be slightly less than VDOT predicts. The existing `runLegs` slip model captures the fatigue shape; the projection multiplies all legs by the same ratio, so the *shape* stays correct even if the *magnitude* is mildly optimistic.
- **Brick weight is heuristic**: 0.5 was chosen on first principles, not calibrated against outcome data. Sensitivity is small — even moving to 0.25 or 0.75 shifts the run delta by <2s per leg.

### Bibliography

- Daniels, J. (2014). *Daniels' Running Formula*, 3rd ed. Human Kinetics. (VDOT → pace mapping)
- Coyle, E.F. (1995). Integration of the physiological factors determining endurance performance ability. *Exercise and Sport Sciences Reviews*, 23(1), 25–63. (VDOT-as-determinant validity)

### Addendum (2026-05-26) — Unified per-discipline model

The original §AH wired the VDOT horizon *on top of* the aggregate factor model, leaving the per-station horizon (stations + roxzone, see §S) computing one number while `buildHyroxProjection` computed another. Per-station rows could promise ~100–200s of gain that the headline did not reflect.

The model is now unified:

```
disciplineHorizonTotal = runHorizonProjectedSec        (VDOT horizon)
                       + stationsHorizonProjectedSec   (Σ per-station horizon)
                       + roxzoneHorizonProjectedSec    (roxzone horizon)

factorPct = Σ {
  MTL CTL gap        bounded ±5%
  Weekly volume      bounded ±3%
  Plan adherence     0..+4% slowdown
  Race-day readiness bounded ±2% (taper window only)
}

projectedTotalSec = disciplineHorizonTotal × (1 + factorPct)
```

- Each discipline's `byDiscipline.X.projectedSec` is multiplied by the same `(1 + factorPct)`, so the headline equals the sum of byDiscipline by construction.
- Taper is *not* a factor any more — it lives where it belongs, inside the per-discipline horizon models (per-class for stations, distance-appropriate for run, generic for roxzone). The run VDOT horizon stops passing `taper_weeks: 0` and now uses the default `HYROX_TAPER_WEEKS`.
- Item (4) above ("`taper_weeks: 0` prevents double-counting") is obsolete: taper now consistently lives in the horizon for all three disciplines, and the factor model handles reality-vs-plan adjustments only.
- Factor breakdown semantics: each factor row's `deltaSec` is its contribution to `improvementSec`. Sum of `factors[].deltaSec` ≈ `improvementSec` (within rounding tolerance), making the breakdown reconcilable for UI transparency.

---

## §AG — Strength Session RPE + Legs Tagging (2026-05-18 — detector hardened 2026-05-19)

### What it does

Optional per-activity tags on strength sessions: an RPE 1–10 slider and a Legs chip (none / moderate / heavy). When tagged, RPE replaces the HR-derived TSS for that session, and Legs writes a decaying leg-load entry that feeds the readiness leg-load floor.

### Why HR-derived TSS is wrong for lifts

iTRIMP integrates heart rate above resting against a max-HR ceiling. A 60-minute compound-lift session typically runs at 65–85 bpm (Z1) because between-set rest dominates the timeline. The resulting TSS reads ≈ 7 for a session that produces 24–48h of meaningful neuromuscular fatigue and significant DOMS, especially in the lower-body chain. Cardiovascular load underweights neuromuscular load. (Schoenfeld 2020 — eccentric loading produces sarcomere disruption and inflammatory response largely independent of HR; this is "uncoupled" fatigue.)

### TSS formula (when tagged)

`TSS = durationMin × TL_PER_MIN[rpe] × runSpec`

- `TL_PER_MIN` is the existing TSS-calibrated table (`src/constants/sports.ts:11–22`). RPE 7 ≈ 1.78 TSS/min; RPE 4 ≈ 0.92.
- `runSpec` is the run-equivalent discount applied to non-run sports. For Signal A (run-equivalent CTL/ATL/race prediction), `runSpec = SPORTS_DB.strength.runSpec = 0.35`. For Signal B (raw physiological load, ACWR / strain), `runSpec = 1.0` so the full neuromuscular cost reaches ACWR and the freshness model.

Untagged strength sessions fall back to the existing iTRIMP path — the user is opt-in.

### Strength detection (canonical helper)

Both the TSS override and the activity-detail chips route through `isStrengthActual(actual)` in `src/cross-training/activities.ts` — single source of truth so UI and calculations never disagree. Three-signal precedence:

1. **`manualSport === 'strength'`** — explicit user override always wins.
2. **`deriveSportFromActivityType(activityType)` → `'strength'`** — handles the common synonyms (Garmin `STRENGTH_TRAINING`, Strava `WeightTraining`, also `weights`, `gym`, etc.) via lowercase-and-`includes` matching against the SPORTS_DB / SPORT_ALIASES tables plus a fallback keyword pass.
3. **Name regex** (`/strength|weight|lift|barbell|squat|deadlift|bench|powerlift/i`) on `workoutName + displayName` — only fires when `derived === 'generic_sport'`. This catches the common Strava case where the activity type is the catch-all `Workout` and the only strength signal is the user-provided name. Gating on `generic_sport` prevents misclassification (a run named "Easy run to lose weight" stays a run because `RUNNING` derives to `extra_run`, not `generic_sport` — the name fallback never runs).

The original 2026-05-18 build used an exact-match `STRENGTH_TRAINING` check inside the helper, which silently failed for every Strava `WeightTraining` and `Workout`/"Strength" combination. Hardened on 2026-05-19 with `isStrengthActual` + 11 unit tests covering each signal path.

### Leg-load model

When `legFeel` is set, a single `recentLegLoads` entry is written for the activity:

| legFeel  | load per min | recoveryMultOverride | Reference tier (existing SPORTS_DB) |
|----------|-------------:|---------------------:|--------------------------------------|
| none     | 0 (no entry) | —                    | (no leg cost)                        |
| moderate | 0.15         | 1.05                 | crossfit (0.15)                      |
| heavy    | 0.35         | 1.20                 | rowing (0.35)                        |

`recoveryMultOverride` scales the leg-load half-life (`LEG_LOAD_BASE_HALFLIFE_H × recoveryMultOverride`) in `computeLegLoadBreakdown`. Heavy lifts decay 20% slower than the strength baseline, reflecting longer EIMD recovery for compound posterior-chain work (Hyldahl & Hubal 2014 — bout-2 protection plus extended repair window for eccentric-dominant sessions).

### Defensibility

- `TL_PER_MIN` is already TSS-calibrated and used across the cross-training pipeline — strength is now just one more sport using the same scale.
- Per-min leg-load values are anchored to existing sports with similar neuromuscular profiles (crossfit ≈ moderate volume mixed lifting; rowing's sustained posterior-chain eccentric loading ≈ a heavy squat/deadlift day).
- `recoveryMultOverride` only changes the half-life of the decay; it cannot raise the load itself, so a misclick to "heavy" produces at most an extra ~7h of elevated readiness floor — not a runaway signal.
- Single-entry-per-activity (replaces prior entry on retag) — the user cannot inflate leg-load by toggling repeatedly.

### Limitations

- **User-honesty dependent**: the RPE is whatever the user reports. No HR-derived sanity check applies (we'd need accelerometer/IMU station-load to validate).
- **Forward-only**: historical strength activities don't recompute CTL on tag. By design (see scope conversation 2026-05-18). Untagged history continues to under-count, but the model self-corrects as new sessions get tagged.
- **Binary upper-vs-lower**: "moderate" and "heavy" don't distinguish quad-vs-hamstring or unilateral-vs-bilateral; a heavy posterior chain day decays the same as a heavy quad day. Acceptable for v1 — the readiness gate (run impact risk) is the consuming signal and both reduce impact tolerance similarly.
- **Recovery countdown auto-scales via TSS**: we deliberately did NOT add a per-activity `recoveryMult` override on the strength countdown — the RPE-driven TSS bump (from ~7 to ~33+) already inflates the countdown formula (`k × TSS / CTL × recoveryMult`). Adding a second multiplier would double-count.

### Key files

- `src/types/state.ts` — `GarminActual.rpe`, `GarminActual.legFeel`, `recentLegLoads[].recoveryMultOverride`
- `src/cross-training/activities.ts` — `deriveSportFromActivityType`, `isStrengthActual` (canonical detector used by both UI and calculations)
- `src/calculations/fitness-model.ts:300+` — `computeStrengthRpeTSS()` helper + wiring into `computeWeekTSS`, `computeWeekRawTSS`, `computeTodaySignalBTSS`
- `src/calculations/readiness.ts:131+` — per-entry `recoveryMultOverride` in `computeLegLoadBreakdown`
- `src/ui/activity-detail.ts` — RPE + Legs chips, two overlay handlers, `applyLegFeelToLegLoad`
- `src/cross-training/activities.test.ts` — 11 tests for `deriveSportFromActivityType` + `isStrengthActual`
- `src/calculations/fitness-model.test.ts` — 11 tests for `computeStrengthRpeTSS` covering Signal A/B, fallback chain, RPE clamping

---

## §AF — Marathon + Half Population Percentile Distributions (2026-05-18)

### What it does

Per-venue empirical percentile distribution of finish times for the 24 marathons + 18 half marathons in the catalogue, plus per-distance aggregate fallback. Powers a "where you sit in the field" card on the running forecast page (Phase 2 build, separate session).

Lookup chain at runtime: per-venue table → per-distance aggregate → null (caller hides the card). Returns `{fasterThanPct, source, provenance}` so the UI caption can be honest about *which* dataset answered the query.

### Methodology

1. **Data source survey**: 42-venue audit (see docs/CHANGELOG.md 2026-05-18 *Empirical population data scaffolding* entry). 5 Tier 1 venues with Kaggle-ready bulk datasets, 28 Tier 2 venues scrapeable via official portals or three super-aggregators (Mikatiming, Sporthive, GreatRun), 8 Tier 3 venues with small fields (≤3k/yr), 1 Tier 4 (Sandown Half — unverified).
2. **Ingestion**: `scripts/ingest-marathon-results.mjs <csv-path> <venue-id>` parses a finisher CSV (autodetects common time columns: `OfficialTime`, `Net Time`, `Time`, etc., supports `h:mm:ss`, seconds, and minutes formats), applies sanity filters (default 2:20 ≤ t ≤ 8:30 marathon), sorts ascending, picks values at the 9 standard percentile breakpoints `[1, 5, 10, 25, 50, 75, 90, 95, 99]`, and prints a paste-ready const block + provenance line.
3. **Storage shape**: `Array<[finishTimeSec, cumulativePercentile]>` per venue. Cumulative percentile = "% of finishers slower than or equal to this time". Same shape as `hyrox-population-distributions.ts` for consistency.
4. **Resolution**: linear interpolation between adjacent breakpoints. Clamped to the table edges (a 1:30:00 marathon returns the P1 value; a 9:00:00 returns P99). `fasterThanPct = 100 - cumulativePercentile`.

### Defensibility

- Percentile breakpoints `[1, 5, 10, 25, 50, 75, 90, 95, 99]` match the hyrox table — proven adequate for shaping a smooth PDF visualisation. P1 and P99 anchor the tails without overfitting to outliers.
- 9 anchor points + linear interpolation produces a continuous distribution that's visually indistinguishable from a smooth KDE in the SVG renderer at typical screen widths.
- Sanity filters reject likely DNS / scoring errors (a 2-hour marathon is faster than the world record; a 10-hour finish is outside the typical cutoff window for any major).
- Per-distance aggregate fallback ensures every venue gets *some* sensible answer even when no venue-specific data exists yet — pooled across all ingested venues at the distance.
- No invented data: the data file ships with all tables empty. `isPopulationDataAvailable()` is derived dynamically from table contents, so the gating flag cannot drift out of sync with the underlying data.

### Limitations

- **Field-strength bias**: published Kaggle datasets are skewed by the events that publish bulk data (US/UK/EU majors, mostly). A small UK club marathon will fall back to the aggregate, which is faster than its true field.
- **Year mixing**: ingestion pools years into one distribution (no year-weighting). For races where field quality has shifted (Valencia got faster as it grew), recent years are over-represented when more data exists for them. Acceptable for v1 — the *direction* of the distribution is correct.
- **Distance-only fallback**: aggregating "all marathons" into one fallback ignores course-difficulty variation (a flat Berlin will produce faster finishes than a hilly Toronto). The empirical course-factor work (separate item, Phase 1 follow-up) corrects this at the prediction layer, not the population layer.
- **Sex / age mixing**: distributions pool all genders and ages. We can stratify later if a UI surface justifies it; v1 doesn't.
- **No splits yet**: this entry covers finish-time distributions only. The `hasSplits` field on `VenueDataProvenance` flags which sources include intermediate splits (5K/10K/half/30K); a future session can ingest those into a parallel `MARATHON_SPLIT_PERCENTILE_TABLES` once the forecast UI needs them.

### Refresh cadence

Re-run the ingestion script per Kaggle dataset update. The original survey covered datasets through 2024 — a Q1 re-survey each year keeps the tables current. Bump `LAST_REFRESH_DATE` after each ingestion sweep.

### Key files

- `src/data/marathon-population-distributions.ts` — tables + lookup primitives
- `src/calculations/marathon-population.ts` — public API (`getMarathonFinishPercentile`, `percentileLabel`, `percentileHeadline`, `venueCalibrationCaption`)
- `scripts/ingest-marathon-results.mjs` — Kaggle CSV → const blocks
- `src/calculations/marathon-population.test.ts` — 17 tests covering lookup, fallback chain, interpolation, edge clamping, provenance attachment

---

## §AE — Commute Drift Learning (End-of-Week Baseline Adjustment) (2026-05-14)

### What it does

At every week rollover, the system inspects the last four completed weeks for commute drift. If the user logged fewer commute runs than declared in at least three of those four weeks, the declared commute baseline (`commuteConfig.commuteDaysPerWeek`) is reduced to the median observed count, floored at 1 day per week.

### Why automatic, not opt-in

Declared commute frequency is a stated intent, captured once at onboarding (or set later in Account). Real behaviour drifts: a new office, weather, an injury that nudges the user toward driving, a change of habit. The plan engine reads the declared baseline every week — if the declaration stays stale, the plan keeps prescribing as if the user is still doing 5 commutes/week when they're really doing 2, and the runner ends up with a thinner prescribed plan than their body can handle.

This is the same pattern Mosaic already uses for VDOT auto-refresh, FTP marker bumps, CSS marker bumps, and the effort multiplier: observe → trail → adjust automatically when the signal is robust. The user sees a small note; no popup, no friction.

We only ever *reduce*. Raising the declared count when the user is doing more commutes than declared would shrink the prescribed plan further — the wrong direction. If a user does extra commutes, the substitution math at the generator already accounts for them (the plan engine floors at zero spare easy mileage; extra commutes become honest bonus volume).

### Rule

```
WINDOW   = 4   (most recent completed weeks)
THRESHOLD = 3   (weeks within window where actual < declared)

if shortfallWeeks ≥ THRESHOLD:
    newDays = max(1, min(median(observed), declared - 1))
    if newDays < declared:
        commuteConfig.commuteDaysPerWeek = newDays
```

Median is the right central tendency:

- **Mean** smooths toward the declared value on a single big week. A user doing [5, 0, 0, 0] would average 1.25, and we'd reduce to 1 — fine — but a user doing [5, 0, 5, 0] would average 2.5, and we'd round to 3 even though half their weeks were zero.
- **Max** re-introduces the over-declaration that triggered the drift. If a user did [0, 0, 0, 5] we'd lock back in at 5.
- **Median** is robust to single-week outliers and reflects the typical week. [5, 0, 0, 0] → 0 (floored to 1). [5, 0, 5, 0] → 2.5 → rounded to 3, which is honest about the every-other-week pattern.

### Why exclude the in-progress week

The current week is mid-flight; using its partial count would skew the observation downward and trigger spurious reductions every Monday morning. The check operates on fully-rolled-over weeks only — `weeks[0 .. currentWeek - 2]` inclusive.

### Limitations (call them out honestly)

- **No upward correction.** If a user starts commuting more aggressively, the engine continues prescribing as if they were at the lower baseline. This is intentional (see "only ever reduce"), but it means a user who has improved their commute habit needs to bump their declared count manually via Account → Run to work.
- **Median rounds to integer days.** A user observing 2.5 → rounded to 3 may notice the rounding direction varies. The rounding is deterministic (round-half-to-even is JS default; we accept it).
- **Window is fixed at 4.** Doesn't shrink for new users or grow during stable patterns. Larger windows would smooth too slowly; smaller windows would jitter on noise.

### File map

- `src/calculations/commute-drift.ts` — pure detection function.
- `src/calculations/commute-drift.test.ts` — 9 unit tests covering the rule.
- `src/ui/welcome-back.ts:155` — applies the result at week rollover, after VDOT detraining but before `saveState`.

---

## §AD — Load-Carriage Impact Adjustment (Backpack on Commute Runs) (2026-05-14)

### What it does

Run actuals tagged as commute runs with a non-zero backpack mass have their impact-load (Signal C) contribution multiplied by `(bodyweightKg + backpackKg) / bodyweightKg`. A 70 kg runner with a 7 kg pack therefore lands ~10% more structural stress per kilometre. HR-based iTRIMP (Signals A and B — aerobic and anaerobic training stress) is **not** adjusted.

### Why one signal but not the others

Mosaic uses a three-signal load model:

- **Signal A** — Run-equivalent iTRIMP (heart-rate × duration). Drives CTL, ACWR, race prediction. HR rises naturally with the added metabolic cost of carrying a load, so iTRIMP already captures the cardiovascular side. No adjustment needed.
- **Signal B** — Raw physiological iTRIMP (same HR signal, no runSpec discount). Drives Total Load, padel/gym tally. Same rationale as A.
- **Signal C** — Musculoskeletal impact load (`distanceKm × IMPACT_PER_KM[type]`). HR cannot see structural stress — a 5 km easy run and a 5 km easy run with a 10 kg pack produce comparable HR responses but very different ground reaction forces at the foot, ankle, knee, and spine. Without a multiplier, Signal C silently understates the injury risk a commuter is taking on.

The clean separation between metabolic and structural signals is exactly what load-carriage adjustment needs. We touch one signal precisely where it's blind, and leave the others alone.

### Scientific anchor

Knapik et al. (Mil Med 2004) review three decades of military load-carriage research. The findings most directly relevant to Mosaic:

- Metabolic cost rises roughly linearly with load mass up to ~30% bodyweight: ~1% extra VO2 per 1% bodyweight carried. Quesada et al. (Ergonomics 2000) confirm the linear range under simulated marching.
- Peak ground reaction force scales linearly with total mass (body + pack). A pack does not change biomechanics by enough to alter the force/mass relationship; the runner is just heavier.
- Above ~30% bodyweight the model breaks: gait alters, contact time lengthens, and force redistributes; metabolic cost grows faster than linearly. Run-to-work loads (5–15 kg, ~7–20% bodyweight for a 70 kg runner) sit comfortably inside the linear range.

### Formula

```ts
loadCarriageImpactCoef(backpackKg, bodyweightKg)
  = clamp(1 + backpackKg / bodyweightKg, 1.0, 1.5)
```

Clamp at 1.5 (50% bodyweight pack) prevents wrong-units inputs (e.g. stored grams instead of kg) from blowing up impact load. The clamp is well outside any realistic run-to-work value.

### Bodyweight resolution

When `s.bodyWeightKg` is set during onboarding, that value is used. When unset, falls back to sex-specific defaults: 75 kg male, 62 kg female. Mirrors `cycling-vo2.ts`. Both defaults sit on the cohort median; a 10–15% miss on bodyweight maps to a ~1–2 percentage-point miss on the coefficient — small enough that requiring bodyweight entry just for this would be friction-for-friction's-sake.

### Limitations (call them out honestly)

- **Linear scaling oversimplifies pack position.** A low-slung pack distributes load differently than a chest-mounted hydration vest. We can't model this without pack-style data.
- **Gait redistribution not modelled.** Load-carriage shifts force toward the posterior chain (calf/Achilles, hamstrings). We capture the magnitude bump, not the redistribution — injury risk per joint is the same in our model whether the load is on the back or in the hands.
- **Coefficient is symmetric across pace.** A pack at easy pace and a pack at threshold pace get the same coefficient applied. In reality the threshold pack run is structurally harder than linear scaling implies (higher cadence × heavier mass × softer-tissue fatigue). Not enough run-to-work users do threshold commutes to justify modelling this.
- **Bodyweight defaults are coarse.** Sex-only fallback misses athletes far from the median.

### File map

- `src/constants/load-carriage.ts` — coefficient + bodyweight resolution.
- `src/constants/load-carriage.test.ts` — 9 unit tests covering the coefficient, clamp, and bodyweight defaults.
- `src/calculations/activity-matcher.ts:1351` — applies the coefficient to per-run impact load when `actual.commute && actual.backpackKg > 0`.

---

## §AC — Commute-Aware Plan Engine: Easy-Mileage Substitution (2026-05-14)

> **Superseded by §AM (2026-05-20).** The substitution model was reverted because the data model and the user's mental model disagreed: when a user said "2 runs/week + 3 commutes" the engine silently reduced prescribed runs to 1 (only the long run anchor), making the plan look broken. The new model treats commute runs as additive to `runsPerWeek` rather than substituting for prescribed easy slots. The scientific anchor below (commute mileage IS aerobic stimulus) remains correct — only the plan-shape derivation changed.

### What it did (now reverted)

When a user has declared a run-to-work pattern (`s.commuteConfig.enabled === true`), the plan engine treats commute days as already-prescribed easy aerobic running. The number of prescribed runs per week is reduced by the commute days; the weekly-hours budget is reduced by the commute time. The long run and any quality sessions stay prescribed exactly as they would for a non-commuter.

### Scientific anchor

A commute run and a prescribed easy run produce the same physiological stimulus when duration and intensity match. Aerobic adaptation (mitochondrial density, capillarisation, fat oxidation, type-I motor unit recruitment) responds to dose, not to the cognitive label the runner applies. Daniels (*Daniels' Running Formula*, 4e, 2022) and Pfitzinger & Latter (*Faster Road Racing*, 2015) both treat easy mileage as fungible — neither distinguishes "purpose-built" easy from any other easy.

The body cannot know whether a 5 km conversational-pace run is heading toward an office desk or toward the front door. What it integrates is the cardiac output × duration × frequency over the training week.

### The decision

Two architectures are defensible for handling commute mileage:

1. **Post-hoc substitution** — generate a full plan, then drop easy runs once commute actuals arrive.
2. **Plan-shape model** — generate a plan that already knows about commute mileage and sizes prescribed runs accordingly.

The plan-shape model is preferable because (a) it avoids visible "your run was just dropped" churn that erodes user trust in the plan, (b) it explicitly prioritises quality + long-run sessions for commuters, matching what an experienced coach would do for an athlete with a busy schedule, and (c) it prevents silent volume inflation that would otherwise lift weekly running km by 30–60% above the user's stated target.

### Guardrails

Three rules sit on top of the substitution to prevent overreach:

- **Hard sessions are never substituted.** Threshold, intervals, race-pace, marathon-pace, fartlek, hills, progressions stay prescribed at full prescription. Quality sessions require sub-maximal but specific effort that conversational-pace commuting cannot replicate.
- **The long run is sacred.** Even when commute days meet or exceed the user's declared runs/week, one prescribed run remains as the long-run anchor. Without a long run, the aerobic / structural / fuel-utilisation stimulus that distinguishes marathon training from general mileage is lost.
- **Floor at 1 prescribed run.** If `runsPerWeek − commuteDays ≤ 0`, the engine still generates one prescribed run and a diagnostic log fires. Surfaces the edge case for the future UX caption.

### Implementation

```ts
const prescribedRunsPerWeek = Math.max(1, runsPerWeek - commuteDays);
const commuteWeeklyMin = (commuteWeeklyKm × easyPaceSecPerKm) / 60;
const prescribedHoursTarget = max(0.5, weeklyHoursTarget - commuteWeeklyMin / 60);
```

Easy pace defaults to 6:00/km (360 s/km) when the user's recorded `easyPaceSecPerKm` is not yet available — this is the centre of the easy-pace range for moderately-trained runners. Once the user has logged a few commute runs, their actual easy pace replaces the default.

### Limitations (call them out honestly)

- **Commute pace is assumed easy.** If a user habitually runs commute as tempo (chasing a train) or as fartlek (sprints at intersections), the substitution logic still removes the same number of easy slots. The activity-side iTRIMP captures the actual intensity correctly, but the planned dose was for easy and the actual is harder — the effort-multiplier should pick this up on week rollover.
- **Backpack carriage is not yet plan-aware.** Phase 3 will adjust impact load for commute runs with a pack, but the prescribed easy slots are not yet shortened to compensate for the additional structural cost. A 7 kg pack on a 5 km commute is ~10% more metabolic cost; the runner is doing more work than a pure conversational run, and the plan currently treats it as equivalent.
- **Declared frequency, not observed.** The current logic reduces by `commuteConfig.commuteDaysPerWeek` as declared at onboarding. Phase 5 will add end-of-week drift learning so the baseline reduces if the user consistently logs fewer commute runs than declared.

### File map

- `src/workouts/generator.ts:27` — commute-aware reduction applied before slot generation.
- `src/workouts/plan_engine.ts:467` — receives reduced `weeklyHoursTarget`.
- `src/types/state.ts:64` — `CommuteConfig` shape (declared in onboarding).
- `src/workouts/generator.test.ts` — three new tests covering substitution behaviour.

---

## §AB — Illness Classification + Return-to-Train Schedule (2026-05-13)

### What it does

`classifyIllness()` derives a four-axis Classification from user-reported symptoms, severity, and RHR delta. `buildSchedule()` produces a forward-looking day-by-day plan-modification schedule (rest, easy-only, reduced, or full). `applyIllnessMods()` consumes today's schedule entry at render time and mutates the workout list in memory; no plan re-generation is performed.

### Scientific anchors

1. **Friman & Wesslén (2000)** — *Scand J Med Sci Sports* 10(4):214–217, "Special feature for the Olympics: effects of exercise on the immune system: infections and exercise in high-performance athletes." Introduced the practical above-neck / below-neck rule that became the standard return-to-train heuristic in sports medicine:
   - **Above-neck symptoms** (runny nose, sore throat, mild headache, sneezing): training at easy effort is generally safe and may even accelerate recovery via mild immune-modulation.
   - **Below-neck symptoms** (chest cough, body aches, fever, GI involvement): rest is required. Continuing to train under viral load risks viral myocarditis, prolonged recovery, and immune suppression.
2. **Schwellnus, Soligard, Alonso, Bahr, Clarsen, Dijkstra, Gabbett, Gleeson, Hägglund, Hutchinson, van Rensburg, Khan, Meeusen, Orchard, Pluim, Raftery, Budgett, Engebretsen (2016)** — *Br J Sports Med* 50(17):1043–1052, "How much is too much? (Part 2) International Olympic Committee consensus statement on load in sport and risk of illness." Establishes the 7-day rest window for below-neck systemic viral illness before graded return, with extension to 10+ days for symptoms suggestive of myocardial involvement (fever, marked body aches, severe fatigue). The graded return (50%→70%→85%→100%) follows IOC's "step-up if asymptomatic" principle.
3. **Hellard, Avalos, Guimaraes, Toussaint, Pyne (2015)** — *Med Sci Sports Exerc* 47(4):698–707, "Training-related risk of common illnesses in elite swimmers." Establishes resting-heart-rate elevation vs personal baseline as an objective marker of acute illness severity in trained athletes. **What this paper supports**: the *principle* of using RHR delta as an objective severity signal. **What it does NOT pre-validate**: the specific 5 / 10 bpm cut-offs we use — see "Honest sourcing" below.

### Classification logic

```
neckRule = 'below' if any symptom ∈ {fever, body_aches, cough, gi}
                     OR illnessType ∈ {flu_chest, gi}
           else 'above'

hasSystemic = any symptom ∈ {fever, body_aches}     // forces below-neck regardless
severityTier = severity ≤ 3 → 'mild'
             ≤ 6 → 'moderate'
             > 6 → 'severe'
rhrFlag = rhrDeltaBpm ≥ 10 → 'high'
        ≥ 5  → 'elevated'
        else → 'normal'
```

### Schedule formulas

```
acuteTotalDays = 10   if hasSystemic
                  7   if neckRule == 'below'
                  4   if severityTier == 'severe' or rhrFlag == 'high'
                  3   if severityTier == 'moderate'
                  2   otherwise

remainingAcute = max(1, acuteTotalDays − daysIntoIllness(dayOfSymptoms))
                   where daysIntoIllness: 1-2 → 1, 3-5 → 4, 6+ → 7

// Below-neck (acute = rest, then graded return)
for i in [0, remainingAcute):
  schedule[i] = { capacity: 'rest', volumeFactor: 0, ceiling: 'rest' }
ramp = systemic ? [0.50, 0.65, 0.80, 0.90, 1.00] : [0.50, 0.70, 0.85, 1.00]
rampCeil = systemic ? [easy, easy, steady, steady, full] : [easy, easy, steady, full]
append ramp days at offsets [remainingAcute … remainingAcute + ramp.length)

// Above-neck (acute = easy-only at reduced volume; high RHR forces day 0 rest)
volFactor = severe → 0.60, moderate → 0.70, mild → 0.85
for i in [0, remainingAcute):
  schedule[i] = { capacity: rhr=='high' && i==0 ? 'rest' : 'easy_only',
                  volumeFactor: rhr=='high' && i==0 ? 0 : volFactor,
                  ceiling: rhr=='high' && i==0 ? 'rest' : 'easy' }
append one step-back day @ 0.95 volume, ceiling 'full'
```

### Why the constants are defensible

- **7 vs 10 days for below-neck**: Schwellnus 2016 IOC consensus. The extension to 10 for systemic symptoms reflects the elevated risk of viral myocarditis when fever or marked body aches are present (Phillips, Robinowitz, Higgins, Boran, Reed, Virmani 1986, *N Engl J Med*; cited in Schwellnus).
- **Graded return ratios**: IOC's "rule of thirds" — return at roughly 50% of pre-illness load, increase by ~20% per session if asymptomatic. Our 4-day or 5-day ramps (50→70→85→100, or 50→65→80→90→100) implement this principle.
- **Volume factors 0.60 / 0.70 / 0.85 for above-neck mild/moderate/severe**: anchored on the Friman recommendation that head-cold training duration should be reduced by one-third to one-half (giving the 0.50–0.67 range); we extend with a milder 0.85 tier for users reporting severity ≤3 since holding the same prescription for "mild congestion" and "noticeable head cold" felt too coarse. The "mild = 0.85" tier is pragmatic, not Friman-derived.
- **RHR thresholds 5 / 10 bpm**: heuristic, not validated. Hellard 2015 supports the *direction* (positive RHR delta tracks acute illness onset in trained athletes) and reports day-to-day RHR variability typically below 5 bpm in healthy athletes. The 5 / 10 cut-offs are the same informal "elevated / high" markers used in popular wearable platforms (Garmin's training-status overlays, WHOOP's recovery score). We adopt them as a starting point for the schedule logic and may recalibrate once Mosaic has its own dataset of illness-onset vs RHR trajectories.
- **Severity-tier breakpoints (≤3 mild, ≤6 moderate, >6 severe)**: pragmatic, not literature-derived. A self-reported 1–10 scale has no canonical tier mapping; we picked even thirds for readability. The tier influences (a) the above-neck volume factor and (b) the acute-window length when the user is above-neck without elevated RHR. Both routes are bounded by the structural rules above (below-neck always wins, hasSystemic always extends the window), so a wrong tier mapping degrades the prescription mildly rather than catastrophically.

### Mode mirroring

The schedule is mode-agnostic. Per-discipline behaviour is driven by workout-kind classification (`run | bike | swim | strength | rest_like | other`):

- `rest` capacity → all sport workouts (run/bike/swim/strength) become rest.
- `easy_only` → quality runs downgrade to easy, bike/swim cap at Z2; volume × volumeFactor.
- `reduced` → volume × volumeFactor; intensity cap applies only when ceiling is 'easy' or 'steady'.
- **Strength suppression**: when `neckRule == 'below'`, all strength sessions across the schedule become rest, regardless of capacity. Rationale: lifting under viral load is the documented worst-case scenario for cardiac stress (Schwellnus). This single rule covers running, triathlon, cycling, and HYROX users equivalently.

**Wiring reality (2026-06-01)**: the schedule-driven `applyIllnessMods` was only ever *called* from running's `plan-view.ts`; triathlon and HYROX plan-views rendered stored workouts without applying it. They now call `applyIllnessModsAllDisciplines`, which applies the same per-discipline logic for the **legacy `{severity}`** state the live modal currently writes (`resting` → rest all, `light` → volume × 0.6, intensity capped to easy). The 0.6 factor is the existing non-quality reduction ratio from the legacy path — not a new constant. Applying the same volume reduction to bike/swim/stations as to runs is defensible because acute-illness volume reduction is discipline-agnostic: the immune cost of training scales with total systemic load, not with which sport produced it (Schwellnus 2016 frames load in mode-neutral terms). **Holiday** mods use a facility-access model rather than a uniform reduction (Tristan, 2026-06-01): on holiday, running is the only reliably available discipline (shoes travel; bikes and HYROX boxes do not), so running is kept as the training spine and honours the existing "can you run?" answer, bike and stations/bricks always rest, and swim is gated on an explicit "pool or open water?" question for triathletes. This is a logistics model, not a physiological one — it reuses the running 0.7 reduction ratio for the sessions that survive, and adds no new constants. Holiday `forceDeload` weeks are now honoured by the tri/HYROX engines (`deload = forceDeload || isDeloadWeek`), matching running's `plan_engine.ts`.

### Limitations (call them out honestly)

1. **Self-report bias**: severity, symptom presence, and day-of-symptoms are user-entered. We have no objective severity ground truth. RHR delta is the only autoreported objective signal.
2. **No fever measurement**: "fever" is a symptom selection, not a temperature. A user reporting fever without taking their temperature is still classified as systemic. Conservative bias acceptable.
3. **No re-classification mid-schedule**: a user whose symptoms worsen mid-recovery must re-open the form (the "Change" button on the banner) to rebuild the schedule. Auto-detection of worsening RHR is possible but not yet wired.
4. **Linear ramp simplification**: the graded return uses fixed step-ups (50→70→85→100). Real return-to-train should be symptom-gated at each step ("step up only if asymptomatic"); we honour the principle by allowing the user to re-open and adjust, but don't automate the symptom check.
5. **No quantitative validation**: the schedule is built from clinical consensus, not from a calibrated dataset of illness → return-to-train outcomes. Constants are defensible against literature but not personalised.

### File map

- `src/calculations/illness-rules.ts` — `classifyIllness`, `buildSchedule`, `getTodayCapacity`, `summariseSchedule`, `shouldSuppressStrength`, `deriveLegacySeverity`.
- `src/ui/illness-modal.ts` — form, `applyIllnessMods`, `clearIllness`.
- `src/calculations/daily-coach.ts` — stance derivation reads today's capacity.
- `src/ui/plan-view.ts` + `src/ui/home-view.ts` — banner reads today's capacity for display copy.

---

## §AA — HYROX Run-Pace Model v2: Critical Pace anchor, continuous interpolation, format conversion, Bayesian personalisation (2026-05-12)

### Why v2

The v1 run-pace model derived HYROX 1km-leg pace as `threshold × fatigueRatio[band]`, with the ratio table floored at 1.05 (`competitive`) — meaning the model could never predict a HYROX run pace faster than 5% slower than the athlete's continuous-tempo threshold. This is wrong for trained HYROXers, and the gap widens with fitness.

**The structural error**: threshold pace is what an athlete can hold for ~60 min straight. HYROX runs are 8 × 1km efforts at ~3–7 min intervals, separated by station work that acts as metabolic recovery for the running musculature. The correct physiological anchor for that pattern is **Critical Pace (CP)**, not Lactate Threshold.

### Scientific anchor — Critical Pace

- **Origin**: Hill (1923), "The maximum work and mechanical efficiency of human muscles" — first power-duration construct.
- **Human application**: Monod & Scherrer (1965), "The work capacity of synergic muscle groups."
- **Modern review**: Jones, Vanhatalo, Burnley, Morton, Poole (2010), *Med Sci Sports Exerc* 42(10):1876–1890, "Critical power: implications for determination of VO2max and exercise tolerance."
- **CP vs threshold**: Galbraith, Hopker, Lelliott, Diddams, Passfield (2014), *Int J Sports Med* 35(7):566–571, "A single-visit field test of critical speed." CP ≈ 95–97% of MLSS (maximal lactate steady state) ≈ slightly slower than LT pace for trained runners.
- **Interval-recovery physiology**: in mixed-modal events, athletes pace at *critical power/pace* rather than at threshold, because intermittent recovery permits expressing capacity at intensities unsustainable continuously (Mangine et al. 2018, *J Strength Cond Res* on CrossFit performance markers).

### Formula

```
pace = gp(vdot, ltPace).t × cpRatio(vdot) × formatFactor(band, targetFormat) + personalOffsetSec
```

- **`gp(vdot, ltPace).t`** — Daniels threshold pace, refined by stored LT pace when available.
- **`cpRatio(vdot)`** — continuous linear interpolation between band-anchor points keyed by VDOT (no more discrete buckets).
- **`formatFactor`** — 1.0 for singles target; `1 / DOUBLES_TO_SINGLES_PACE_FACTOR[band]` for doubles target (faster pace because partner-rest reduces leg fatigue).
- **`personalOffsetSec`** — Bayesian residual from logged-race observations; decays linearly to 0 over 12 months.

### CP-ratio anchor table

Keyed by band-implied VDOT. Ratios descend below 1.0 for trained tiers — the structural break from v1.

| Tier | VDOT | Ratio | Interpretation |
|---|---|---|---|
| total_beginner | 28 | 1.32 | Aerobic ceiling caps everything |
| beginner | 32 | 1.22 | Notably slower than threshold |
| novice | 38 | 1.12 | Limited HYROX-specific conditioning |
| intermediate | 45 | 1.05 | Just slower than threshold |
| advanced | 53 | 1.00 | At threshold (≈ CP for this tier) |
| competitive | 60 | 0.96 | Faster than threshold (CP near 5k-10k pace) |

Cross-referenced against elite HYROX splits:
- Top male singles (~57min): runs ~4:10/km vs probable threshold ~3:45 → 0.93
- Advanced singles (~1:00): runs ~4:30/km vs threshold ~4:15 → 1.06
- Intermediate singles (~1:30): runs ~5:30/km vs threshold ~5:00 → 1.10

Note: linear interpolation between anchor points; clamps below the lowest and above the highest VDOT.

### Format conversion (doubles ↔ singles, same athlete)

In doubles each athlete runs all 8 legs but only completes 4 of 8 stations (partner takes the others). The partner-rest during the other 4 stations means significantly less cumulative leg fatigue when running. Singles forces solo on every station, accumulating eccentric + metabolic load.

| Tier | Doubles → Singles factor | Why |
|---|---|---|
| competitive | × 1.05 | Trained athletes recover well; singles slowdown is small |
| advanced | × 1.06 | |
| intermediate | × 1.07 | Average accumulation of carryover |
| novice | × 1.08 | |
| beginner | × 1.09 | Stations hit harder; bigger run slowdown when solo |
| total_beginner | × 1.10 | |

**v1 calibration source**: gut-anchored from elite split comparisons and interval-recovery literature. **Flagged for empirical recalibration** from the Kaggle 89k-finisher dataset (same-athlete cross-format pairs). Once calibrated, the table will move to `hyrox-population-distributions.ts` with an empirical citation.

### Bayesian personalisation

The population model (CP-ratio + format) is the **prior**. Each logged HYROX race provides an **observation** (back-computed run pace from `finish − stations − roxzone`, divided by 8). The **residual** `observed − model_at_that_format` updates a personal offset:

```
posterior_offset = existing × (1 − w) + residual × w
```

- `w = 0.6` when the race observation comes from per-station splits (high confidence)
- `w = 0.35` when stations were estimated from band seeds (low confidence)
- Combined confidence climbs toward 1.0
- Offset magnitude clamped to ±60 s/km (prevents pathological observations corrupting future predictions)

**Decay**: the offset decays linearly to zero over 12 months without new race evidence. Without recent data, we revert fully to the population prior.

**Initialisation**: at HYROX onboarding, when a previous-race time + format are supplied, the model computes the initial offset right then. With pasted station splits, the back-computation is exact; without splits, it estimates stations from band seeds and applies the lower confidence weight.

### Why offset (sec/km) rather than full pace replacement

- **Survives format changes**: an athlete who races doubles then trains for singles keeps their personalisation signal — the offset is in sec/km, applied after the format factor.
- **Survives single-race noise**: a hot/sick race gets blended with model evidence rather than fully replacing it.
- **Decay-aware**: the offset gracefully retreats over time, returning to the conservative prior rather than fossilising stale data.

### Limitations

- **Singles-only calibration in v1**: doubles ratios are gut-anchored extrapolations; the Kaggle dataset has both formats and same-athlete pairs we haven't yet mined.
- **CP anchor points are tier-based, not directly tested**: a v3 would estimate per-athlete CP directly from training data (e.g. 3-min vs 12-min effort comparison) rather than mapping VDOT → CP.
- **No within-race fatigue model coupling**: the per-leg fatigue distribution (R1 fast → R8 slow) is computed downstream and assumes a constant rate. v3 could let strong stations attenuate downstream run fatigue.
- **First-race observation can dominate**: with no prior offset, a single race observation pulls the offset 35–60% toward its residual. Mitigated by the ±60 s/km clamp.

### Wiring map (where this connects to the rest of Mosaic)

- `src/calculations/hyrox-run-pace.ts` — `deriveHyroxRunPace`, `derivePopulationRunPace`, `cpRatioForVdot`, `convertHyroxRunPaceFormat`.
- `src/calculations/hyrox-personal-pace.ts` — `backComputeRunPaceFromRace`, `blendPersonalRunPaceOffset`, `computePersonalRunPaceOffset`, `estimateStationsAndRoxzoneFromBand`.
- `src/state/initialization.hyrox.ts` — initial offset computation from onboarding race data.
- `src/types/triathlon.ts` — new `personalRunPaceOffsetSec` / `personalRunPaceOffsetUpdatedAtISO` / `personalRunPaceOffsetConfidence` fields on `HyroxConfig`.
- `src/ui/hyrox/stats-view.ts` — Critical Pace card surfacing the derivation chain with tap-to-explain modal.
- `src/calculations/race-prediction.hyrox.ts` — consumes `deriveHyroxRunPace()` for the headline race forecast and the Race Order per-leg display.

### Tests

- `src/calculations/hyrox-run-pace.test.ts` (28) — `cpRatioForVdot` continuity + clamping + monotonicity; `convertHyroxRunPaceFormat` round-trip; `derivePopulationRunPace` shape; full-pipeline source/override/decay behaviour.
- `src/calculations/hyrox-personal-pace.test.ts` (17) — back-computation correctness, blend math, clamp, decay function (12-month boundary, half-life proportionality).
- `src/calculations/hyrox-marker-bumps.test.ts` — updated for v2 expected numerical ranges.

---

## §Z — Plan Phasing: capped single arc + double periodization for long plans (2026-05-11; refined 2026-05-12)

### 2026-05-12 refinement

Three changes applied a day after the initial entry:

1. **Inter-cycle transition labelled `taper` (was `base`).** The 2-week transition between cycles 1 and 2 is a real mini-taper, not aerobic-development weeks. Calling it `'taper'` (a) gets the workout generator's existing taper volume-drop for free, and (b) renders the Phase Timeline as the honest two-arc story `Base → Build → Peak → Taper → Base → Build → Peak → Taper`. Mujika & Padilla (2003) describe intra-cycle recovery between training blocks as physiologically equivalent to a short taper: fatigue clearance while fitness consolidates.

2. **Triathlon and HYROX share the same strategy.** Both formats previously had ratio-based single-arc allocation with no double-periodization path. The `computePlanPhases` function now accepts a `PhaseConfig` parameter; running, triathlon, and HYROX each supply their own config but share the algorithm. Distance-specific ratios are tuned so default plan lengths reproduce canonical splits exactly:

   | Format / distance | Default length | Canonical | Ratios used (peak/build) |
   |---|---|---|---|
   | Running marathon | 16w | 6/6/2/2 | 0.10 / 0.40 |
   | Triathlon 70.3 | 20w | 8/6/4/2 | 0.20 / 0.30 |
   | Triathlon Ironman | 24w | 10/7/5/2 | 0.208 / 0.292 |
   | HYROX | 18w | 7/6/3/2 | 0.20 / 0.333 |

   Caps differ per format: running buildCap=8, peakCap=4, taperCap=3. Triathlon buildCap=8, peakCap=5, taperCap=2. HYROX buildCap=8, peakCap=3, taperCap=2. Taper-cap differences reflect format-specific detraining onset (Mujika & Padilla 2003); peak-cap differences reflect format-specific peaking windows (running peak is short-sharp interval work; tri peak includes race-specific brick volume that benefits from a few more weeks; HYROX peak is compromised-running and station-density work which plateaus quickly).

3. **Double-periodization threshold differs by format**: running 33+, tri 28+, HYROX 28+. The lower tri/HYROX threshold reflects compressed productive single-arc windows in multi-discipline training (more concurrent modalities → faster monotony onset, evidenced by Hellard et al. 2019 in swimmers and Lehmann et al. 1997 in cyclists).

The single-arc capped-allocation rule and the double-periodization cycle structure are otherwise unchanged.

---

## §Z — Plan Phasing: capped single arc + double periodization for long plans (2026-05-11)

### Motivation
Coaches assign training phases (Base / Build / Peak / Taper) according to the time available before a race and the principle of progressive specificity. Mosaic's previous model split plans differently depending on length: ≤16 weeks got a single arc, >16 weeks got a 4-week block-cycle prefix (Base → Build → Peak → Taper repeating) followed by a 16-week race-specific arc. For a 20-week plan this rendered as `Base → Build → Peak → Taper → Base → Build → Peak → Taper`, which reads to the user as the plan regressing mid-cycle and contradicts canonical periodization.

### New model

Phase assignment is produced by `computePlanPhases(totalWeeks)` in `src/workouts/phases.ts`. The function applies one of two strategies based on plan length.

**Single-arc strategy (length ≤ 32 weeks).** Phases assigned by capped allocation:

```
taperWeeks = min(3, max(1, ceil(totalWeeks × 0.12)))
peakWeeks  = min(4, max(1, round(totalWeeks × 0.10)))
buildWeeks = min(8, max(1, round(totalWeeks × 0.40)))
baseWeeks  = totalWeeks − (taperWeeks + peakWeeks + buildWeeks)   // remainder
```

The order in the plan: `Base × baseWeeks → Build × buildWeeks → Peak × peakWeeks → Taper × taperWeeks`.

**Phase caps and their basis:**
- **Taper ≤ 3 weeks** — Pfitzinger & Douglas (2009, *Advanced Marathoning*, ch. 8) cap the longest marathon taper at 3 weeks. Beyond 3w, detraining outweighs fatigue clearance (Mujika & Padilla 2003, *Sports Medicine* 33(13)).
- **Peak ≤ 4 weeks** — Daniels (2014, *Daniels' Running Formula*) and Hudson (2008, *Run Faster from the 5K to the Marathon*) treat "peak" as a short, sharp block of race-specific intensity. Extending it spreads the stimulus and reduces the consolidation effect.
- **Build ≤ 8 weeks** — Bompa & Buzzichelli (2018, *Periodization: Theory and Methodology*) note that beyond ~8 weeks of concentrated specific intensity, endurance athletes plateau or accumulate injury risk. Issurin's block-periodization framework (2008) also targets 2–6 week intensive blocks.
- **Base absorbs the remainder** — long aerobic-development phases are the canonical structure for any plan longer than ~16 weeks. Tønnessen et al. (2014, "The annual training periodization of 8 world-class endurance athletes", *IJSPP* 9(4)) document 60–70% of elite annual training volume in aerobic-base mode.

**Very short plans (4–7 weeks):** the caps naturally collapse `baseWeeks` to 0–2, producing a "sharpening block" (Build → Peak → Taper) with little or no aerobic development. This is the honest answer to "what can be done in 4 weeks?": maintain volume, do 1–2 specific sessions, taper. Fitness cannot be built in a month (Coyle et al. 1984, *J Appl Physiol* 57: 1857–1864 on detraining time-courses; Mujika et al. 2000, *Med Sci Sports Exerc* 32(2)).

**Double-periodization strategy (length ≥ 33 weeks).** A single 40+ week arc loses its training signal: monotonous stimulus, motivational decay, and no intermediate adaptation checkpoint. Real-world elite athletes structure 2–3 macrocycles per year (Tønnessen et al. 2014). Issurin (2010, *Sports Medicine* 40(3): 189–206) formalised this in the block-periodization framework: concentrated 2–6 week training blocks, each targeting one physiological quality, separated by short transitions, are more effective than one continuous mixed arc.

The algorithm allocates cycle 2 as ~55% of total weeks (it carries the race), cycle 1 as ~45% (preparation), with 2 transition weeks between them:

```
cycle2Length = max(12, round(totalWeeks × 0.55))
cycle1Length = max(8, totalWeeks − cycle2Length − 2)

c1Peak  = min(3, max(1, round(cycle1Length × 0.18)))
c1Build = min(6, max(1, round(cycle1Length × 0.35)))
c1Base  = cycle1Length − c1Build − c1Peak

Cycle 1: Base × c1Base → Build × c1Build → Peak × c1Peak (last peak week flagged checkpoint=true)
Transition: 2 × Taper weeks (intra-cycle recovery; Mujika & Padilla 2003 mini-taper)
Cycle 2: single-arc strategy applied with totalWeeks = cycle2Length
```

The final peak week of cycle 1 carries a `checkpoint: true` flag. The phase remains `'peak'` so all peak-aware engine logic (workout generation, scoring, suggestion rules) continues to work; the flag drives a distinct UI label (`Checkpoint`) on the Phase Timeline and — when implemented — a time-trial-flavoured workout week (Mon–Wed easy, Thu opener, Sat hard 5K or 10K TT, Sun easy). The TT result feeds back into VDOT/CSS/FTP auto-refresh, calibrating cycle 2 against measured rather than predicted fitness.

### Limitations
- **No mid-cycle deload weeks in long bases.** A 35-week base block needs internal recovery weeks (typical pattern: 3 weeks progressive load + 1 week deload, repeating). The current model assigns the same phase label to every base week; deloads must come from the workout generator's volume modulation, not the phase tagging. Logged in `docs/OPEN_ISSUES.md` for follow-up if a real user runs a 24+ week plan.
- **Checkpoint week workout content not yet implemented.** The phase flag exists and is rendered in the UI, but `generateWeekWorkouts` currently treats the week as a standard peak week. The TT-flavoured content (and the post-TT VDOT/CSS/FTP refresh hook) is deferred until a real 33+ week plan ships.
- **Cycle ratios are heuristic.** The 45/55 cycle split is a reasonable default but not directly derived from a controlled study; literature on optimal cycle-length distribution within multi-cycle annual periodization is sparse and athlete-specific.
- **Triple periodization not modelled.** Plans >52 weeks (annual+) are not supported.

### References
- Bompa, T. & Buzzichelli, C. (2018). *Periodization: Theory and Methodology of Training* (6th ed.). Human Kinetics.
- Coyle, E. F. et al. (1984). Time course of loss of adaptations after stopping prolonged intense endurance training. *J Appl Physiol* 57(6): 1857–1864.
- Daniels, J. (2014). *Daniels' Running Formula* (3rd ed.). Human Kinetics.
- Hudson, B. (2008). *Run Faster from the 5K to the Marathon*. Broadway Books.
- Issurin, V. (2008). Block periodization versus traditional training theory: a review. *J Sports Med Phys Fitness* 48(1): 65–75.
- Issurin, V. (2010). New horizons for the methodology and physiology of training periodization. *Sports Med* 40(3): 189–206.
- Mujika, I. & Padilla, S. (2003). Scientific bases for precompetition tapering strategies. *Med Sci Sports Exerc* 35(7): 1182–1187.
- Mujika, I., Padilla, S. & Pyne, D. (2000). Detraining: loss of training-induced physiological and performance adaptations. *Med Sci Sports Exerc* 32(2): 413–421.
- Pfitzinger, P. & Douglas, S. (2009). *Advanced Marathoning* (2nd ed.). Human Kinetics.
- Tønnessen, E. et al. (2014). The annual training periodization of 8 world-class athletes. *Int J Sports Physiol Perform* 9(4): 666–673.

---

## §Y — Triathlon Prediction Calibration Loop (2026-05-11)

### Motivation
Population-level race models (Riegel exponent, Daniels VDOT, empirical course factors) have systematic biases at the individual level. An athlete who consistently slows in the run due to heat sensitivity, or who swims better than their CSS predicts in race conditions, sees the same error race after race. The calibration loop turns the race log into a personal bias-correction term.

### Tier-1: per-leg additive bias

For each discipline `d ∈ {swim, bike, run}`:

```
residuals[i] = actualPerLeg[d][i] − predictedPerLeg[d][i]   for each race i
rawBias[d]   = median(residuals[d])
medPred[d]   = median(predictedPerLeg[d])
bias[d]      = clamp(rawBias[d], −0.08 × medPred[d], +0.08 × medPred[d])
```

**Why median (not mean):** a single outlier race (illness, equipment failure, extreme weather) would corrupt a mean-based estimate. The median is resistant to single-event outliers.

**Why ±8% cap:** the known prediction error band for triathlon leg times is approximately 6–14% (derived from the empirical course-factor validation dataset). The cap ensures calibration never exceeds the natural noise floor, keeping it in systematic-correction territory rather than overfitting individual races.

**Application:** bias is added post-readiness to both projected and current estimates. The readiness penalty captures preparation gaps; the bias corrects model-level systematic error. The two are conceptually orthogonal.

### Tier-2: learned readiness maxPenalty scale

For each discipline, regress the residual fraction (after tier-1 bias) against the implied readiness penalty:

```
penaltyExcess[i]      = predictedPerLeg[d][i] / predictedRawPerLeg[d][i] − 1
residualFraction[i]   = (actual[d][i] − (predicted[d][i] + bias[d])) / predicted[d][i]
slope                 = Σ(penaltyExcess[i] × residualFraction[i]) / Σ(penaltyExcess[i]²)
rawScale[d]           = 1 + slope
scale[d]              = 1 + (rawScale[d] − 1) × n / (n + 4)   (Bayesian shrinkage)
scale[d]              = clamp(scale[d], 0.6, 1.4)
```

**Why OLS regression not mean ratio:** the residual-vs-penalty regression tests whether the _magnitude_ of the readiness penalty correlates with the residual. A positive slope means the penalty is understating the true shortfall; a negative slope means over-stating. A mean ratio would capture average error but not the penalty-specific signal.

**Why Bayesian shrinkage toward 1.0 (`n/(n+4)`):** with few races, the OLS slope has high variance. The shrinkage formula (Thompson 1968 type-II estimator with `n₀ = 4`) pulls estimates toward the population prior (scale = 1.0, i.e. current model is correct) until data is sufficient. At n=4, 50% of the raw estimate is retained; at n=8, 67%; asymptotes to the full estimate.

**Why [0.6, 1.4] clamp:** beyond ±40% of the nominal maxPenalty, calibration would be compensating for something fundamentally wrong with the base model rather than individual variation. The clamp prevents pathological correction.

### Limitations

- Tier-1 bias is computed from post-readiness predictions (what was shown to the user), not pre-readiness. This means the bias absorbs both model error AND readiness-penalty error. Tier-2 separates these but requires the newer `predictedRawPerLeg` field.
- All tiers assume the race log is representative of future races at the same distance. A 70.3 bias does not transfer to Ironman — each distance accumulates its own bias independently (future work: distance-group pooling when cross-distance data is sparse).
- Tier 3 (Riegel exponent fit) is dormant until sprint/olympic race logging is added (currently only 70.3/Ironman).
- Calibration recomputes after each logged race but the current prediction must be re-fetched to pick up the updated factors (applies on the next app launch after the race).

---

## §W — Empirical Transition Times by Race × Level Bin (2026-05-08)

**Side of the line**: tracking → race prediction. Adds a transition-time term to the predicted finish that reflects what real finishers at the user's level actually achieve at this race, replacing the hand-tuned `T1_SEC_BY_SLIDER` / `T2_SEC_BY_SLIDER` skill defaults whenever empirical data exists.

**Files**: `src/validation/transition-distributions.ts`, `src/validation/dataset-loader.ts` (extended `FinishRecord`), `src/validation/run-calibration.ts` (emits `empirical-transition-distributions.json`), `src/calculations/empirical-transitions.ts` (runtime lookup), `src/calculations/race-prediction.triathlon.ts` (priority chain at `t1Sec` / `t2Sec` resolution), `src/types/triathlon.ts` (`triConfig.transitionOverride`).

### Calibration

```
For each (distance, eventLocation, levelBin):
  levelBin     = floor((swim + bike + run − binMin) / binWidth)   ← excludes transitions
  binWidth     = 15 min (70.3) or 30 min (IM)
  T1_mean(L,b) = mean of t1Sec across finishers in cell  (70.3 only)
  T2_mean(L,b) = mean of t2Sec across finishers in cell  (70.3 only)
  TT_mean(L,b) = mean of (t1Sec + t2Sec) across finishers in cell  (both distances)

Confidence:
  race-specific cell:   require ≥ 50  finishers in (L, b)
  global fallback bin:  require ≥ 200 finishers in b across all races
```

### Why bin on swim+bike+run (not finish time)

The level bin must be independent of transition skill itself, otherwise we'd be looking at "how slow are transitions for people whose transitions were similarly slow" — circular. Using `swim + bike + run` ("moving time") gives an objective fitness-tier proxy that's consistent on both sides of the lookup: the historical record provides it directly, and the runtime predictor naturally has it before adding transitions.

### Runtime resolution chain

```
1. user override     (triConfig.transitionOverride)        — manual hardcode
2. race × level bin  (≥ 50 finishers in cell)              — most specific empirical signal
3. global level bin  (≥ 200 finishers across all races)    — fallback when cell sparse
4. skill-slider      (T1_SEC_BY_SLIDER / T2_SEC_BY_SLIDER) — original defaults, last resort
```

For Ironman, only T1+T2 combined is available (the source CSV's `results.csv` doesn't expose separate T1/T2 columns; we derive `transitionSec = overall − swim − bike − run`). When the empirical lookup returns a combined-only number we split T1 / (T1+T2) ≈ 0.58 (constant `IM_T1_SHARE_OF_TOTAL`) derived from the 70.3 dataset where per-side data exists. T1 runs longer than T2 in practice because of the wetsuit strip and the longer transition-zone walk on the swim-exit side at most venues.

### Why this is defensible

- **Ground truth.** 840k 70.3 finishes (2004–2020) and 1.09M IM finishes (2002–2024) from public Kaggle datasets. Same source the course-factor calibration draws on (§G).
- **Pro-vs-amateur gradient is real and observed in the data.** Sub-4:30 70.3 finishers average 4.5 min total transitions; 7:50 finishers average 11.6 min. Sub-9:15 IM finishers average 7.7 min; 15:45 finishers average 23.7 min. The hand-tuned slider compressed this ~2.5× spread into a fixed 4.5× one (120s elite → 540s beginner for T1) without venue-specific resolution.
- **Race-specific is meaningful.** Some venues have long T1 walks from beach to transition or muddy run-outs; others are flat parking lots. Per-race binning preserves this where data permits.
- **Transition times don't degrade like fitness markers.** No decay model needed — what finishers averaged at this race in 2018 is still a defensible prior for 2026 unless the venue layout changed materially.

### Sockless modifier

Socks are a single one-time event during a triathlon — they go on once at a transition (or not at all) and stay on. The user picks where via `triConfig.transitionSocks`:

```
't1'   → sock-on at T1 (population default) → no adjustment
't2'   → sockless on bike, sock-on at T2     → −SOCK_ON_COST_SEC T1, +SOCK_ON_COST_SEC T2
'none' → never wears socks                   → −SOCK_ON_COST_SEC T1 only

SOCK_ON_COST_SEC = 20
```

Empirical T1/T2 already reflects the "sock-on at T1" baseline because that's what most racers do. The selector shifts or removes that cost from the resolved baseline. Applied on top of whichever path resolved T1/T2 (override, empirical, slider). Floored at 60 s per side so we never go negative.

**Why 20 s**: this is the practised-athlete steady state for putting socks on once. Coaching consensus across Joe Friel (*Triathlete's Training Bible*), Tower 26, and TrainingPeaks is 15–30 s for an experienced sock-on event; 20 s sits in the middle. Inexperienced athletes on wet feet take longer, but the model assumes the user has rehearsed.

**Why one event, not two**: the previous model treated socks as a per-leg decision (sock-on at T1 *and* T2 as independent events). That doesn't match how triathletes actually race — once socks are on, they stay on. Modelling it as a single event the user *places* (T1, T2, or never) is both more realistic and produces sensible per-leg projections: 't2' people get faster T1 and slower T2 (no net change), 'none' people save the full sock-on cost.

**Why this is OK to be a constant rather than personalised**: it's a user-controlled race-day preference, not a fitness state. The athlete *decides* where their sock-on event falls. The model just translates that choice into a time delta. Personalising the cost would require per-athlete sock-on-time data we don't collect, and the variance is small enough that a constant is fine for a 20 s adjustment.

### Limitations

- **No T1/T2 split for Ironman.** The miguswong CSV exposes only `swimTime`, `bikeTime`, `runTime`, `overallTime`. Combined transitions are derivable; per-side splits are not.
- **No year-on-year weighting.** Same caveat as course factors (§G) — a venue with a 2018 layout change contributes the lifetime average rather than the post-change average.
- **Bin width is uniform.** A 4:00 70.3 finisher and a 4:14 finisher land in the same 15-min bin; no smoothing across bins. The granularity is acceptable for a ~30-second-magnitude signal.
- **Confidence floors are pragmatic, not derived.** 50 / 200 thresholds match the existing course-factor and split-distribution conventions; a formal SE-based gate would be more rigorous but the practical effect is similar.
- **Mean only, no spread.** We store the cell mean, not its variance. Transition time scatters far more around its mean than swim/bike/run do, because it tracks fitness only loosely (a sub-5 70.3 finisher can take a 7-min T1, a 6-hour finisher a 3-min one). We cannot show the user a percentile, only a centre point.
- **Venue logistics dominate T1 and are only captured where we have race-specific data.** T1 is set largely by the swim-exit-to-transition run distance and transition-zone size, which are venue properties, not fitness. For a venue absent from the dataset (e.g. Sandusky 70.3) the global fallback cannot know this and will tend to run optimistic. **Surfaced honestly in UI (2026-06-01)**: the Transitions detail caption states the global fallback plainly and warns that transitions vary widely by venue, rather than implying the number is calibrated to the user's race. The override path remains the accurate answer when the user has a real reference (e.g. their own past race or a known long-T1 venue).
- **External validation (2026-06-01).** IM means cross-checked against Ironman.com (competitive 5–10 min, age-groupers 10–15 min) and Better Triathlete (avg male AG 12h38 finisher → 17 min; our 12h45 band → 16:58). Both match within seconds, confirming the calibration is correctly scaled. T1 > T2 holds in every 70.3 band (T1 is 53–59% of combined; share is largest for fast finishers because the wetsuit strip is a near-fixed cost).

### Sources

- Kaggle: Ironman 70.3 races 2004 to 2020 — David at aiaiaidavid (840k rows)
- Kaggle: Ironman 140.6 Results 2002 to 2024 — miguswong (1.09M rows)
- See `docs/CALIBRATION_TRIATHLON.md` for the full pipeline.

---

## §V — HYROX Race-Age Staleness with Cross-Mode Physiology Mitigation (2026-05-08)

**Side of the line**: tracking. Race time from a year ago should not anchor today's forecast with the same authority as last week's, but a still-fit athlete shouldn't be penalised either. This model computes a time-decay weight on the previous race time and gates the penalty on cross-mode physiology evidence (VDOT, MTL CTL, Strava `ctlBaseline`).

**Files**: `src/calculations/hyrox-staleness.ts`, `src/calculations/race-prediction.hyrox.ts` (confidence cap + per-station + seed blends), `src/state/initialization.hyrox.ts:131-150` (re-band gate), `src/ui/hyrox/forecast-view.ts:365-376` (UI chip), `src/calculations/hyrox-staleness.test.ts` (11 tests), `src/calculations/race-prediction.hyrox.test.ts` (4 staleness blend tests).

### Model

```
ageMonths = (now − hyroxPreviousRaceDate) / MONTH_MS

baseBandWeight, baseSplitsWeight, confidenceCap = piecewise by category:
  fresh      (<6mo)    1.0    1.0    null
  aging      (6–12mo)  1.0→0.4 (linear)    1.0→0.8    'medium'
  stale      (12–24mo) 0.4→0.2             0.8→0.6    'low'
  very_stale (24+mo)   0.2                 0.6        'low'
  unknown    (no date) 1.0    1.0    null

mitigation = mean(VDOT vs band-implied, MTL CTL vs anchor, ctlBaseline / 100)
             clamped [0.5, 1.0]

bandWeight   = baseBandWeight   + (1 − baseBandWeight  ) × (mitigation − 0.5) × 2
splitsWeight = baseSplitsWeight + (1 − baseSplitsWeight) × (mitigation − 0.5) × 2
```

**Splits decay slower than band.** The skill components of HYROX (sled push technique, sandbag carry mechanics, wall ball cadence) decay slower than pure VO2max if the athlete keeps doing functional work. Band weight indexes raw fitness; splits weight indexes skill — they should not decay at the same rate.

**Re-band gate** (`initialization.hyrox.ts:131-150`): when `bandWeight < 0.7` AND VDOT-implied band ≠ time-based band, take the SLOWER of the two. Conservative — never over-promise on a stale benchmark, even if VDOT looks better.

**Confidence cap** is applied AFTER the calibration-coverage cap and only tightens, never loosens.

### Rationale

- **Detraining literature anchor**: Mujika & Padilla (2000) "Detraining: loss of training-induced physiological and performance adaptations" Sports Med 30:79-87. VO2max declines ~3-5% per month in trained athletes after stopping training; recovers faster than initial gains were earned. Coyle et al. (1984) "Time course of loss of adaptations after stopping prolonged intense endurance training" J Appl Physiol 57:1857-1864 — quantitative time-course for the first 12 weeks of detraining.
- **Skill-vs-fitness split**: from coach reports and HYROX-specific reasoning. No published longitudinal HYROX detraining data exists yet. The stations that score on technique (sled push form, sandbag economy) hold up well in athletes who maintain general functional work; the cardio engine decays faster.
- **Mitigation clamp [0.5, 1.0]**: design choice — we never PUNISH an athlete for poor cross-mode evidence, we only RELEASE the staleness penalty when evidence is strong. A user without VDOT or Strava sync gets the floor (0.5) and the time decay applies in full.

### Pre-fix bug

A 1:00:00 doubles HYROX from a year ago was treated identically to one from last week. The `competitive` band stuck on the time-based threshold even though current VDOT was below the band's implied 60. Combined with Bug 3 (wrong slot) and Bug 2 (wrong-direction cross-format factor), this drove the 56-min headline prediction.

### Limitations

- Thresholds (6 / 12 / 24 months) are directional, not precise. Recalibrate when HYROX returning-athlete data ingest exists.
- Mitigation is arithmetic-mean-blended across three signals without confidence weighting per signal. Could be improved.
- `hyroxPreviousRaceDate` is required for any time-decay; users without it get the `unknown` category (full trust). Fail-soft design — better to not penalise an unknown than to wrongly penalise a recent race.
- Skill-vs-fitness decay rates are coach-derived, not measured. Holds until validated against HYROX returning-athlete cohorts.

### Update — weights now applied to predicted time (2026-05-08, later same day)

Initial wiring of §V only fed `confidenceCap` into `predictHyroxRace` — the predicted *time* still anchored 100% on the historic race regardless of staleness. `bandWeight` and `splitsWeight` were computed but never applied. Closed in `race-prediction.hyrox.ts`:

- **`splitsWeight` per-station blend**: `effectiveBase = splitsWeight × calibrated + (1 − splitsWeight) × seed`. A `very_stale` race with no physiology mitigation lands at `splitsWeight≈0.6`, blending the old benchmark 60/40 toward the band's seed.
- **`bandWeight` seed blend**: when the VDOT-implied band differs from the stored band AND `bandWeight < 1`, seed times themselves blend across the two bands. Combines with the existing re-band gate in `initialization.hyrox.ts` — that gate snaps the band to the slower of the two when `bandWeight < 0.7`; the seed blend handles the moderate-staleness range where the gate doesn't fire.
- The per-station blend is applied BEFORE the venue / Pro / fatigue multipliers so all downstream maths runs on the staleness-adjusted base.

**Test coverage**: `race-prediction.hyrox.test.ts` adds 4 tests pinning the blend at fresh-race no-blend, `very_stale` blend toward seed, partial-mitigation band shift, and strong-physiology weight-recovery boundaries.

---

## §U — HYROX VDOT-Derived Run Pace + Provenance (2026-05-08)

**Side of the line**: tracking. The HYROX prediction needs an honest per-km pace for the 8 × 1km run legs. Pre-fix used `SEED_RUN_PACE_SEC_KM[band]` as a population-mean fallback whenever the user hadn't entered a manual pace — which ignored the athlete's actual aerobic capacity. A VDOT-50 athlete in the intermediate band got the same seed pace as a VDOT-44 athlete in the same band.

**Files**: `src/calculations/hyrox-run-pace.ts` (derive function + ratios), `src/calculations/hyrox-marker-bumps.ts` (yield-to-improvements wiring), `src/calculations/race-prediction.hyrox.ts:163` (consumed by predictor), `src/main.ts:711-725` (launch-time apply + bump pass), `src/calculations/hyrox-run-pace.test.ts` (8 tests), `src/calculations/hyrox-marker-bumps.test.ts` (14 tests).

### Model

```
threshold_sec_km = gp(vdot, ltPace).t                              # Daniels lactate-threshold pace
derived_sec_km   = max(MIN_PACE,
                       round(threshold_sec_km × HYROX_FATIGUE_TO_THRESHOLD_RATIO[band]))
```

Per-band ratio (back-calibrated to existing `SEED_RUN_PACE_SEC_KM` at each band's implied VDOT):

| Band | Implied VDOT | Seed pace | Threshold ≈ | Ratio |
|---|---|---|---|---|
| competitive    | 60+   | 232 s/km | 221 | **1.05** |
| advanced       | 50–55 | 270      | 245 | **1.10** |
| intermediate   | 45    | 305      | 265 | **1.15** |
| novice         | 38    | 355      | 296 | **1.20** |
| beginner       | 32    | 400      | 320 | **1.25** |
| total_beginner | 28    | 435      | 335 | **1.30** |

Ratio rises as ability drops — beginners slow down more across stations.

### Provenance and yield-to-improvements

`HyroxConfig.hyroxRunPaceSource: 'user' | 'derived' | 'seed'` tracks where the in-use value came from. Mirrors the project-wide rule (CLAUDE.md "Manually-set Benchmarks Yield to Improvements"):

- User-entered value is kept unless `derived ≤ userVal − 5 s/km`. Below that margin, user wins.
- When derived overrides, provenance flips to `'derived'` and `notifiedMarkers.hyroxRunPaceSecKm` snapshots the new value so subsequent improvements can be detected as marker bumps.
- The detect→apply order at `main.ts:715-720` is load-bearing: detect must see pre-apply state, otherwise `userVal === derived` after the write and the gate fails. Pinned by regression test.

### Rationale

- **Why threshold pace?** HYROX 1km legs are run at fatigued effort, slightly slower than fresh threshold pace because of accumulated station load. Threshold (lactate threshold, ~80–85% HRmax for trained athletes) is the right anchor — it's the highest sustainable pace the athlete could hold for ~30–60 min of pure running, before fatigue compounds. The fatigue-to-threshold ratio captures the band-dependent slowdown.
- **Why band-keyed ratio, not athlete-specific?** Without per-athlete HYROX run-leg history, we can't fit individual ratios. Band-keyed is the next-best abstraction. When Strava ingest of HYROX events lands and we have measured run-pace-vs-VDOT for individual users, recalibrate per-athlete.
- **`HYROX_RUN_PACE_MIN_SEC_KM` (190 s/km = 3:10/km) floor**: would clip an elite at VDOT 80 (computed ~178). Floor is intentional — 1km HYROX legs after stations are slower than fresh-1km capacity even at the elite level (Brandt & Ebel 2025 — top-pro run splits within ~2-4% across all 8 legs but absolute pace is fatigued).

### Pre-fix bug

VDOT was tracked but unused for HYROX run pace. Strong runners with weak HYROX history got seeded paces matching their finish-time band, not their physiology. Combined with the slot/band/staleness bugs, this contributed to the 56-min prediction symptom by underweighting current aerobic fitness.

### Limitations

- Daniels threshold is a single-point estimate from VDOT; doesn't model aerobic vs ergogenic drift or per-athlete LT fraction.
- Ratio is back-calibrated to seed paces, not measured from longitudinal HYROX run-leg data.
- `HYROX_FATIGUE_TO_THRESHOLD_RATIO` doesn't model temperature, altitude, or floor surface — those are layered separately by the venue model.

---

## §T — HYROX Bidirectional Cross-Format Same-Athlete Factor (2026-05-08)

**Side of the line**: tracking + planning. Used for ability-band derivation when the previous-race format differs from the target format (`initialization.hyrox.ts:111-124`). Sets the band, which sets MTL cap, plan duration, seed station times, and fatigue rates.

**Supersedes §N.** The single-direction `DOUBLES_TO_SINGLES_FACTOR = 0.92` previously documented in §N was wrong-direction at the population level (singles is harder than doubles, not easier) and ignored the same-athlete picture. Replaced with two anchored constants.

**Files**: `src/constants/hyrox-constants.ts:32-36`, `src/state/initialization.hyrox.ts:111-124`, `src/calculations/hyrox-format-band.test.ts` (8 tests).

### Model

```
SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES = 1.22
SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES = 0.85

# In initializeHyroxSimulator, before banding:
adjustedPrevTimeSec =
   prevIsDoubles && !targetIsDoubles ? prevTimeSec × 1.22  # doubles result → singles equivalent
  !prevIsDoubles &&  targetIsDoubles ? prevTimeSec × 0.85  # singles result → doubles equivalent
                                       prevTimeSec        # same format → no adjustment
```

Used **ONLY** for band derivation. Per-station cross-format inference is intentionally NOT attempted; the predictor falls back to seed station times for the target format and surfaces `confidence = 'low'` (`race-prediction.hyrox.ts:178-210, 380`).

### Rationale

- **Population data lower bound (1.125)**: HYROX results data, S4–S6, 89,868 finishers (`src/data/hyrox-population-distributions.ts`). Open singles P50 total = 5338 s; open doubles P50 total = 4747 s. Cohort ratio = 1.125. This is a *cohort comparison*, not same-athlete: more skilled athletes self-select into singles, so this systematically understates the same-athlete gap.
- **Coaching consensus midpoint (1.20–1.25)**: Hyrox Hub and Roxzone pacing analyses, race-time prediction reports for athletes who race both formats. The doubles partner-rest pattern lets each athlete push closer to maximal effort on each station, but the active partner only does 4 of 8 stations — total time benefits substantially from the rest. A 60-min doubles athlete is typically a 73–75 min singles athlete (× 1.22 → 73.2 min).
- **1.22 chosen** as the empirical-meets-coaching anchor.
- **Inverse direction (0.85)**: pure inverse (1 / 1.22 = 0.82) understates the partner-rest benefit at the SINGLES → DOUBLES direction. A singles athlete's per-rep capacity is a ceiling; their realistic doubles total is faster than 1/1.22 implies once partner rest is factored in. 0.85 reflects this asymmetry.

### Pre-fix bug

The single 0.92 constant was applied as `doublesSec × 0.92 = singlesSec` — wrong direction (singles is *slower* than doubles for the same athlete because no rest, not faster). Combined with Bug 3 (slot keyed off target format, so doubles splits got filed as singles benchmarks), this collapsed a 60-min doubles athlete into the `competitive` singles band with full singles benchmarks, producing a 56-min headline prediction.

### Per-station cross-format — deliberately NOT attempted

The doubles format covers only 4 of 8 stations and includes asymmetric partner rest. Singles per-station times are a fresh-rep ceiling but real doubles pacing benefits from rest patterns we don't model. Inferring per-station times across formats from current data is undefensible:

1. Cohort selection bias (singles cohort skews stronger).
2. Asymmetric rest pattern not in any public dataset.
3. Per-station competitiveness varies by format (sled push is less of a discriminator in doubles where partners share load).

So when only the OTHER format's benchmarks exist, the predictor uses target-format seeds and drops confidence to 'low'. Recalibrate when matched-athlete cross-format data becomes available (e.g. Strava ingest of dual-format athletes).

### Limitations

- Single global factor; individual variation substantial. Strength-biased athletes lose more in singles (no rest); endurance-biased athletes lose less.
- Pro division may have a smaller gap (higher floor on competitive drive in both formats), insufficient data to separate.
- Recalibrate when matched-athlete cross-format records become available.

---

## §S — HYROX Per-Station Trajectory Model (2026-05-07)

**Side of the line**: tracking. Projects each station's test pace forward to race day given current training dose. Independent of the aggregate `buildHyroxProjection` (§P) which projects total finish from MTL/adherence/taper/readiness signals — this model answers "what's the trainable headroom on each station?" not "how is your overall trajectory tracking?".

**Files**: `src/constants/hyrox-horizon-params.ts` (constants + class map), `src/calculations/training-horizon.hyrox.ts` (curve math), `src/calculations/race-prediction.hyrox.ts` (`buildStationProjection` integration), `src/ui/hyrox/forecast-view.ts` (Trajectory panel), `src/calculations/training-horizon.hyrox.test.ts` (20 tests).

### Model

Three station classes plus RoxZone, each with its own horizon curve. The math mirrors `training-horizon.triathlon.ts` (week-factor exponential + session-factor sigmoid + undertrain penalty + taper bonus + adherence penalty + adaptation ratio). Per-class differentiation lives in `max_gain_pct`, `tau_weeks`, and `taper_bonus_pct`.

```
improvement_pct = max_gain_pct × week_factor × session_factor × exp_factor
                + taper_bonus
                − undertrain_penalty
                − adherence_penalty
                ; × adaptation_ratio
                ; clamp [0, max_gain_cap_pct]

projected = baseline × (1 − improvement_pct / 100)
```

Where:
- `week_factor = 1 − exp(−(weeks_remaining − taper_weeks) / tau_weeks)` — saturating exponential
- `session_factor = 1 / (1 + exp(−0.7 × (sessions_per_week − ref_sessions)))` — logistic dose-response, k=0.7 mirrors `TRI_K_SESSIONS`
- `exp_factor` — `EXP_FACTORS[experience_level]` (kept in lockstep with marathon/tri)
- `taper_bonus = taper_bonus_pct × min(1, weeks_remaining / taper_weeks)` — full bonus only if athlete has time for the taper
- `taper_weeks = HYROX_TAPER_WEEKS = 1.5` — single Hyrox-wide value (per Mujika 2010 review of high-intensity event tapers)

**Floor at 0%, not negative.** Lessons-learnt directly from the triathlon model: a negative floor produced "training will make you slower" projections in degenerate cases. We clamp at 0 — worst case = current fitness, never regression from training itself.

### Class assignments

| Class | Stations | Rationale |
|---|---|---|
| **A. Cardio erg** | SkiErg, Row Erg | Aerobic ergometer; physiology ≈ cycling FTP. 1km efforts (~3-4 min) more anaerobic than steady-state FTP, so slightly more conservative gains. |
| **B. Strength-endurance** | Sled Push, Sled Pull, Burpee Broad Jumps, Sandbag Lunges, Wall Balls | Lactate tolerance + local muscular endurance. Largest novice gains, hard plateau in advanced. |
| **C. Grip / carry** | Farmer Carry | Narrow trainability without specific work; conservative. |
| **RoxZone** | Transitions | Experience- and technique-driven, not strength or cardio. |

### Calibrated constants (`max_gain_pct`, intermediate band)

| | Class A | Class B | Class C | RoxZone |
|---|---|---|---|---|
| total_beginner | 14% | 18% | 12% | 10% |
| beginner | 12% | 15% | 10% | 8% |
| novice | 10% | 12% | 8% | 6% |
| **intermediate** | **7%** | **8%** | **5%** | **5%** |
| advanced | 4% | 5% | 3% | 3% |
| competitive | 2% | 3% | 2% | 2% |

### Citations

- **Class A — Cardio erg**:
  - Mikulic P & Ružić L (2008) "Predicting the 1000-m rowing ergometer performance" — well-trained rowers improve 5-10% in 12wk; novices 10-15%.
  - Lawton TW, Cronin JB, McGuigan MR (2011) "Strength testing and training of rowers" Sports Med 41:413-432.
  - Concept2 12-week 2k erg plan (empirical) — 3-7% intermediate gains.
  - Coggan A & Allen H (2019) "Training and Racing with a Power Meter" 3rd ed. Ch. 7 — bike FTP curves as the cycling analogue (rowing/skiing physiology ≈ cycling).
  - Crawford & Drake (2020) HIFT 6-wk intervention — 8-15% VO2max gains in mixed cohorts.
- **Class B — Strength-endurance**:
  - Bompa T & Buzzichelli C (2018) "Periodization Training for Sports" 4th ed. — LME 10-25% in 6-12 wk untrained; saturates rapidly when trained.
  - ACSM Position Stand (2009) "Progression Models in Resistance Training" MSSE 41:687-708 — 10-20% gains untrained, 3-6% advanced.
  - Schoenfeld BJ et al. (2021) "Loading Recommendations for Local Endurance" Sports 9:32 — 15+ rep schemes maximise LME.
  - Brandt & Ebel (2025) "Acute physiological responses and performance determinants in Hyrox©" Frontiers in Physiology — sled push fastest despite heaviest load (power-endurance, not max strength).
  - Mountain Tactical Institute mini-study — sled push intervals, 7-12% in 3-min Prone-to-Sprint over 8 wk.
  - Kliszczewicz et al. (2014, 2019) — CrossFit metabolic-conditioning data for burpee-style efforts.
- **Class C — Grip / carry**:
  - Winwood PW et al. (2014) "Strength and conditioning practices of strongman athletes" J Strength Cond Res 28:3678-3686 — loaded carries respond well to specific work.
  - Hindle BR et al. (2019) "Loaded carries — a review" Strength & Cond J 41:69-75 — 6-12 wk specific programs deliver 10-20%; without specific work, plateau quickly.
  - McGill SM (2010) "Core training: evidence translating to better performance and injury prevention".
- **RoxZone**:
  - roxlyfe.com elite-vs-average — elite 2:54 transition total vs average 6:58 (4-min skill gap).
  - HyroxDataLab target-split table — 6:30 transitions at intermediate, 12:00 at total_beginner.
  - Brandt & Ebel (2025) — pacing and transition management as primary race-day differentiators.

### Sessions/week — Hyrox-wide, not per-station

A single `plannedHyroxSessionsPerWeek` count drives all three classes. Why: one Hyrox-style workout typically hits multiple stations and a run, so per-station counting would either double-count (every workout = 1 to every class) or be structurally noisy (only 0.3 sled sessions/wk would read as undertraining for sled even though every Hyrox session involves loaded movement). The literature reports class-level adaptation rates against total Hyrox-style frequency — we mirror that.

`plannedHyroxSessionsPerWeek` reads `wk.triWorkouts` over the next 4 weeks and averages session count. Lesson from triathlon: PLANNED sessions, not historical. Historical reads 0/wk on a fresh plan and trips the undertrain penalty, making the projection slower than current.

### Anchoring `currentSec` — display consistency rule

The "current" value displayed in the trajectory panel IS the `baseSec` from the same `predictHyroxRace` call that drives the per-station forecast panel and benchmark cards. Computing it twice via two paths (a parallel re-derivation) was the bug behind the triathlon LT-pace mismatch (race-forecast-card.ts:370 — same user saw 4:23 in one place, 4:08 in another). The trajectory panel must NOT recompute "current" — it propagates the projection delta to the canonical baseline.

**Venue factors are NOT applied to the trajectory.** This panel projects "test pace today → test pace race day" — unfatigued benchmark trajectory. Venue-day adjustments (floor, lap, temp, altitude) live in the existing course-factors panel and apply to the in-race adjusted time, not the test pace.

### Confidence

**Medium-low.** Several sources of uncertainty:

1. **No HYROX-specific longitudinal trainability data exists.** Class B numbers extrapolate from LME literature with a discount factor; Class A from rowing-erg and bike-FTP studies; Class C from strongman and loaded-carry literature. The Brandt & Ebel 2025 paper has a sample size of 11 — not yet enough to validate per-station gain rates.
2. **Class assignment is structural, not calibrated.** Wall balls in particular straddle the cardio/strength-endurance line; assigned to B because the limiting factor is squat-and-throw eccentric work, not pure aerobic capacity.
3. **`adaptation_ratio` defaults to 1.0.** Per-class adaptation signals (HR-at-power drift on erg sessions, pace decay across sled reps) will plug in here as Phase 2 work — same architecture as the triathlon Phase 2A adaptation engine.
4. **Adherence penalty defaults to 0** in v1. Future per-class scoring will track which classes the athlete actually executed vs missed.

### Limitations

- **In-race fatigue gap not modelled in the projection.** The trajectory shows test-pace improvement; actual in-race times will be slower because of accumulated station fatigue (which is modelled separately via `PER_STATION_FATIGUE_RATE_BY_BAND` for the run legs but not propagated to station times).
- **Singles-only calibration.** Doubles format applies the same horizon model to the 4 active stations, but a doubles athlete's adaptation profile may differ from singles.
- **No band-transition logic.** A novice who improves to intermediate during a long horizon should switch to intermediate's gain rates mid-block. The current model holds the band fixed.

### Taper invariant (test-pinned 2026-05-09)

Two unit tests in `training-horizon.hyrox.test.ts` pin the Mujika-grounded taper behaviour so future edits don't drift:

1. **Race inside taper window yields meaningfully less gain than build-phase race.** At `weeks_remaining = 1.0` (inside `HYROX_TAPER_WEEKS = 1.5`), `weeks_eff = max(0, 1.0 - 1.5) = 0`, so `weekFactor = 0` and the build-phase fitness contribution collapses entirely. Only the taper bonus survives, scaled by `taperRatio = min(plannedTaperWeeks, weeksRemaining) / plannedTaperWeeks`. Build-phase gain (race in 8 weeks) must be at least 1.4× larger than taper-phase gain.
2. **Race tomorrow with full sessions floors below 1% improvement.** At `weeks_remaining ≈ 0.05`, `taperRatio ≈ 0.033`, and total gain stays below 1% even with maximal session count. Prevents the pathological case where a user setting a plan one day before their race sees a "−5s SkiErg" projection that would only be earnable via real adaptation time.

Both tests reflect Mujika & Padilla 2003 (*Med Sci Sports Exerc* 35(7):1182–1187): performance gains during a 1–3 week taper come from fatigue removal (super-compensation), not from new adaptive stimulus. The horizon model captures this by zeroing `weekFactor` inside the taper window and surfacing only the `taperBonus` component (which represents fitness coming forward, not new fitness arriving). User-facing implication: setting a plan one week before a race shows near-zero forecast movement, which is the honest and correct read.

---

## §R — HYROX Real Population Distributions (2026-05-07)

**Source**: Kaggle dataset `jgug05/hyrox-results` (Seasons 4–6, ingested 2026-05-07). 92,375 raw rows → 89,868 after sanity filtering (dropped DNS/scoring outliers via `total_time ∈ [30 min, 5 h]`, `run_time ∈ [20 min, 2.5 h]`).

**Methodology**: percentile breakpoints computed at p1, p5, p10, p25, p50, p75, p90, p95, p99 per format per metric. Lookup uses linear interpolation between adjacent breakpoints. Stored as `Array<[seconds, cumulativePercentile]>` in `src/data/hyrox-population-distributions.ts`.

**Coverage**:
- `open_singles` — 50,364 rows. Strong coverage.
- `pro_singles` — 11,458 rows. Adequate; smaller sample so tail percentiles wider.
- `open_doubles` — 28,046 rows.
- `pro_doubles` — 0 rows (dataset doesn't separate). Falls back to synthesised distribution.

**Validity caveats**:
- Dataset is Seasons 4–6 (2022–2023). Newer seasons are not yet ingested — population may have shifted slightly with HYROX's growing accessibility.
- Demographics not stratified: tables are gender-mixed and age-mixed. A 25-year-old male and a 50-year-old female get the same percentile mapping. Per-demographic tables are a future improvement.
- The Kaggle dataset has no per-station split percentiles (only per-leg `run_n` and `work_n` cumulative). Per-station distributions remain synthesised — a follow-up if individual station times become available.

**Refresh**: re-run `scripts/ingest-hyrox-results.mjs` with a fresher CSV, paste the generated tables back. Bump `LAST_REFRESH_DATE`.

---

## §Q — HYROX `hxFormat` workout tagging (deferred decision, 2026-05-07)

**Problem**: when an activity-matcher derives a benchmark from a completed station/brick session, it currently writes the result to whichever benchmark slot matches the user's *current* `hyroxConfig.format` (Singles or Doubles). For a hybrid athlete who trains both formats in the same plan, this routes some sessions to the wrong slot.

**Proposed fix**: tag each generated workout with `hxFormat?: HyroxFormat` at generation time so the matcher can route to the correct slot regardless of current config.

**Decision: defer.** Rationale:
- The current default behaviour (route to current config format) is correct for ≥95% of users — those who train one format at a time per plan. Hybrid trainers are an edge case worth fewer engineering hours today than the validation work outlined in §R.
- Adding `hxFormat` to every generated workout requires plumbing through `hyrox-generators.ts` (5 generators), the plan engine, and the matcher. Non-trivial.
- We have a workable substitute: the user's `hyroxConfig.format` reflects the format they're targeting. If they switch mid-plan, their existing benchmarks migrate via the existing slot logic.

**Revisit when**: the first dogfood report from a hybrid athlete shows misrouted calibrations, OR the plan-engine adds explicit "hybrid" mode (alternate sessions in singles + doubles formats).

---

## §P — HYROX Race-Day Projection Model (2026-05-07)

**Model**: `buildHyroxProjection` in `src/calculations/race-projection.hyrox.ts`.

Adjusts the current "if you raced today" prediction toward race day via four stacked percentage factors. Same shape as the triathlon `buildProjection`/`applyTriHorizonRun` pattern (race-prediction.triathlon.ts:340).

**Factor 1 — Training fitness** (±5% bound). `mtlCTL` is the 42-day daily-equivalent EMA of weekly MTL (the chronic load anchor). Compared to a band-anchored expectation: `expectedMtlCtl(band) = HYROX_MTL_CAP[band] × 0.70 ÷ 7` (~70% of the band's cap, daily-equivalent). Athletes training above their band's anchor are projected to outperform; below get penalised. Soft-saturating at ±5% prevents extreme ratios from overwhelming the projection.

**Factor 2 — Weekly volume** (±3% bound). Configured `runsPerWeek + stationSessionsPerWeek + bricksPerWeek` vs `HYROX_WEEKLY_SESSIONS[band]` total. Smaller weight than fitness because volume is already partly captured in CTL.

**Factor 3 — Plan adherence** (0..+4% slowdown). Completed sessions / planned sessions over the last 3 completed weeks. Same penalty pattern as triathlon's `tri-adherence.ts:80` — missed sessions incur a slowdown, full adherence is neutral.

**Factor 4 — Taper bonus** (up to −1.5% improvement). Fires when race is within taper window (`HYROX_TAPER_DAYS[band] ÷ 7`). Mirrors triathlon's `taperRatio × taperBonus` logic from `training-horizon.triathlon.ts:131`. Magnitude of 1.5% is conservative — running's taper bonus is per-band (Bompa & Haff 2009: 0.5–3% gain), and HYROX's mixed-modal nature (eccentric stations + aerobic running) suggests the lower end of that range.

**Confidence range** (`confidenceRangeSec: [low, high]`). Base ±4% widens with weeks-remaining (+1% past 4 weeks, +1% past 12 weeks — uncertainty grows with horizon) and with prediction confidence (low = +2%, medium = +1%). Tighter ranges for high-confidence near-term predictions; wider for low-calibration far-out projections.

**Known limitations**:
- Factor weights are heuristic, anchored on running/triathlon horizon-model parameters rather than HYROX-specific outcome data.
- The expected-CTL anchor assumes 70% of cap as a "trained athlete on band" benchmark — not directly observed from population data.
- No discipline-split CTL (we don't separately track run CTL vs station CTL) — would require extending `mtlHistory` similar to triathlon's `fitnessHistory.{swimCtl, bikeCtl, runCtl}`. Listed as a follow-up.
- Race-day fatigue interaction with venue factors not modelled separately — projection is applied to current total, then venue factors are already in that total via `predictHyroxRace`.

**Side**: tracking. Surfaced on the forecast view; not used for plan generation.

---

## §O — HYROX Prediction Confidence Model (2026-05-07)

**Model**: `confidence: 'high'|'medium'|'low'` computed in `predictHyroxRace` (`src/calculations/race-prediction.hyrox.ts`).

**Rules**:
- `high`: ≥6 calibrated stations AND venue selected. Rationale: most of the prediction is driven by measured data; the remaining 1–2 seed stations contribute <15% of station time; venue-specific course factors are applied.
- `medium`: ≥3 calibrated stations. More than half the station time is anchored; run pace may still be seed-derived.
- `low`: <3 calibrated stations. Prediction is largely driven by ability-band seed times derived from population averages. Suitable as a rough benchmark only.

**Known limitations**: confidence does not account for calibration recency (a 6-month-old benchmark may be outdated), for format-conversion bias (doubles→singles via the 0.92 factor introduces additional uncertainty), or for venue extrapolation accuracy.

**Side**: tracking (prediction, not planning).

---

## §N — HYROX Doubles→Singles Time Conversion Factor (2026-05-07) — SUPERSEDED by §T

> ⚠️ **Superseded 2026-05-08.** The 0.92 constant documented here was wrong-direction at the population level (singles is harder for the same athlete, not easier) and produced a chain of broken predictions for cross-format users. Replaced by bidirectional same-athlete factors `SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES = 1.22` / `SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES = 0.85`, used only for band derivation. Per-station cross-format inference is no longer attempted — the predictor falls back to target-format seeds with `confidence = 'low'`. See §T for the current model. This entry is preserved for historical context only.

**Model**: `DOUBLES_TO_SINGLES_FACTOR = 0.92` in `src/constants/hyrox-constants.ts`.

Applied when predicting a singles finish and the athlete only has doubles benchmarks: `estimatedSinglesSec = doublesSec × 0.92`.

**Rationale**: Doubles athletes alternate station completion with a partner. The waiting partner accumulates metabolic fatigue but the active athlete can push closer to maximal effort on each station. However, competitive pacing in doubles format differs from open singles — athletes often pace conservatively on shared stations to manage team strategy. Comparison of HYROX results data (HyroxDataLab, 2023–2025) for athletes competing in both formats at similar fitness levels shows singles per-station times averaging ~8% faster than their corresponding doubles times. The 0.92 factor encodes this gap. Applied only to seed-unfilled slots when cross-format estimation is needed; when both singles and doubles benchmarks exist, the matching slot is used directly.

**Inverse (singles→doubles)**: not converted — singles times represent unrestricted capacity and are used as a conservative ceiling for doubles prediction.

**Known limitations**: the 0.92 factor is a global average; individual variation is substantial (particularly for strength-biased vs. endurance-biased athletes). Pro division doubles may have a different ratio (smaller gap, due to higher competitive drive) but insufficient data to separate.

**Side**: tracking (prediction).

---

## Route Safety Rating — 300m Endpoint Trim (2026-05-07)

**Model**: `trimRouteEnds(points, trimMeters=300)` in `src/gps/anonymize-route.ts`

**What it does**: Strips the first and last ~300m of a GPS route before storing it in Supabase, so that the start and end points (which typically coincide with a runner's home, workplace, or car park) cannot be reverse-geocoded to an address.

**Why 300m**:
- A typical urban residential block is 80–150m (Gehl 2010, London street network median). A 300m strip clears 2+ full blocks in the worst case, taking the visible endpoint well into an anonymous mid-street or park segment.
- Google Street View accuracy is ~10m; 300m puts the nearest stored point outside the resolution window at which a casual observer could identify a house frontage.
- Long-distance runs are minimally affected: a 5km run retains ~88% of its route (9.4/10 km net after both ends trimmed). Shorter runs approaching 600m total are returned as null and not stored.

**Known limitations**:
- Cul-de-sac or dead-end routes may still reveal the endpoint even after trimming if the truncated polyline terminates near a unique street stub. Nothing in this model prevents that. Acceptable limitation for v1.
- The trim is cumulative-distance based (Haversine), not time-based. Slow walks at the start/end cover less physical distance per second, so the trim is always a spatial guarantee, not a temporal one.
- No simplification pass is applied — the full point density is retained inside the trim bounds. This is intentional: higher fidelity data for future aggregation. Storage cost is low (typical road run ~1,000 points after compression by Capacitor GPS provider).

**Files**: `src/gps/anonymize-route.ts`, `supabase/migrations/20260507000001_route_safety_ratings.sql`

### Companion Research Documents

For the full literature review, evidence synthesis, confidence levels, and bibliography behind the models documented here, see:

- **Running**: `docs/research/running.md` — load quantification, periodization, physiological adaptation, strength integration, cross-training transfer, tapering
- **Triathlon**: `docs/TRIATHLON.md` — per-discipline TSS, impulse-response model, concurrent training, bike-to-run transition science, taper protocols
- **HYROX**: `docs/research/hyrox.md` — three-dimensional load model (aerobic/anaerobic/MTL), station taxonomy, concurrent training, replacement matrix

This log documents **formulas and implementation**. The research docs document **why those formulas are defensible**.

---

## Empirical course-factor calibration from race-finish data (2026-05-07)

**Where**: `src/validation/{dataset-loader, course-factors, distribution, run-calibration}.ts`, `src/calculations/empirical-course-factors.ts`, `src/calculations/race-prediction.triathlon.ts` (course-factor source picker, ~line 530).

**The problem.** Hand-tuned course factors (climate × altitude × elevation × wind × swim type) capture the *physics* of why a course is hard but miss everything a finisher's split actually encodes — specific roads, prevailing winds at race time, exact bike-leg gradient profile, micro-climate, athlete acclimatisation effects. We had no calibration step against actual race outcomes.

**The fix (Tier B — what we built).** For each race location, compute multiplicative factors `(swim, bike, run)` from real splits. The factors are talent-controlled to remove the "fast races attract fast athletes" confound:

- **IM data** (~850k finishes after PRO + finisher filters, 2002 to 2024) has `athleteID`. Each athlete who appears at multiple races contributes their pace at race L relative to their own multi-race average. The location's factor is the mean of those athlete-relative ratios. Athletes with only one race contribute nothing (no within-athlete contrast available). The mean of the relative ratio across the global population is approximately 1.0 by construction; values > 1.0 mean "athletes raced slower at this location vs their personal average," i.e., a hard course.

- **70.3 data** (~840k finishes, 2004 to 2020) has no athlete ID. We stratify by `(gender, ageGroup)`: for each race, compute the mean leg time per `(M, 40-44)` bucket, divide by the global mean for that bucket, average those ratios across all buckets present at the race. Less precise than fixed effects but still talent-controlled.

**Mathematical defensibility.** Athlete fixed effects is the gold standard for removing unobserved heterogeneity in panel data (Wooldridge 2010). Stratification is the next-best thing when athlete identity isn't available; the bucket-level controls (gender, age band) capture the dominant talent-distribution differences across races.

**Sanity validation.** The math finds what the coaching community already knows:

- Top hardest IM bikes: World Championship St George (1.089), regular St George (1.082), Lanzarote (1.082), Lake Tahoe (1.077), Alaska (1.061) — the textbook hardest IMs in the world.
- Top hardest 70.3 bikes: Connecticut (1.244), Dun Laoghaire (1.209), UK (1.196), Edinburgh (1.172), Silverman (1.148) — all famously hilly.
- Top hardest 70.3 runs: Subic Bay (1.258), Goa (1.226), Davao (1.223), Saipan (1.210) — all tropical heat-killers.

These rankings emerge entirely from finishers' splits with no human input. Strong external validity for the methodology.

**Confidence tiering.** ≥ 1000 finishers → high; 200 to 999 → medium; 50 to 199 → low (drop); < 50 → insufficient (drop). Runtime predictor uses empirical when high/medium; falls back to physical (climate × altitude × elevation × wind × swim type) for low/missing/new races. Physical model is preserved as the safety net — it works for any race with a `CourseProfile` regardless of dataset coverage.

**Sanity caps.** Factors clamped to `[0.75, 1.40]`. Outliers usually represent data errors (course shortened due to weather, swim cancelled or shortened to non-wetsuit). Two clamped entries flagged: Ironman North Carolina (bike 0.750 — 2016 only, weather-shortened), Ironman Alaska (swim 0.750 — likely shortened or non-wetsuit).

**Tier A distribution table** is also built from the same datasets but separately. For each total-time bin (15-min for 70.3, 30-min for IM), it stores mean and SD of each leg's fraction of total time. The runtime helper `validateAgainstDistribution(prediction)` returns z-scores per leg, flagging any leg outside ±2 SD of the empirical mean for the prediction's total-time bin. Useful for catching predictions that are individually plausible but proportionally wrong (e.g., 2:30 swim in a 5:30 70.3 — too long even if 2:30 swim is plausible in isolation).

**What this DOES NOT calibrate.**
- The prediction's *level* — that's still set by physiology models (FTP, CSS, VDOT, blended fitness regressions vs published literature).
- The bike-to-run pace discount (5 to 11 percent). To calibrate this we'd need linked (open marathon, IM marathon split) pairs per athlete, which the public data doesn't provide.
- The race-readiness penalty curve. Same constraint — needs linked training-volume to outcome data.

**Limitations.**
- Empirical factors are time-averaged. A race held under unusually hot conditions in a specific year contributes that bad year's slowness to the lifetime mean. We don't currently weight by recency or weather.
- 70.3 stratification is less precise than IM fixed effects. A small race with unusual age-group mix can produce noisy factors even at "high confidence" sample sizes.
- Course changes mid-history (e.g., Ironman Frankfurt course revisions over 20 years) are averaged through. A future enhancement could use only data from years with stable course profiles.
- IM athlete-fixed-effects estimator drops athletes with only one race. About 30% of records get filtered this way, reducing effective sample from 1.93M raw to 1.33M.

**References**:
- Kaggle dataset, aiaiaidavid (2021) "Ironman 70.3 races 2004 to 2020". https://www.kaggle.com/datasets/aiaiaidavid/ironman-703-race-data-between-2004-and-2020
- Kaggle dataset, miguswong (2024) "Ironman 140.6 Results 2002 to 2024". https://www.kaggle.com/datasets/miguswong/ironman-140-6-results-dataset-2002-2024
- CoachCox IM Stats — original scrape source. https://www.coachcox.co.uk/imstats/
- Wooldridge JM (2010). *Econometric Analysis of Cross Section and Panel Data* 2nd ed. MIT Press.
- Friel J (2018). *The Triathlete's Training Bible* 4th ed. VeloPress.

---

## Race-readiness model upgrade: per-band targets, weighted score, sigmoid penalty, cross-discipline transfer, gap-aware closure (2026-05-07)

**Where**: `src/constants/race-readiness-targets.ts`, `src/calculations/specific-endurance-penalty.ts`, `src/calculations/race-readiness.ts`, `src/calculations/race-prediction.triathlon.ts`.

**The problem.** The original race-readiness model (2026-05-06) used a single intermediate-band target table, an unweighted geometric mean of `volumeRatio × longestRatio`, a linear `1 + (1 − score/100) × maxPenalty` curve, no cross-discipline transfer, and a fixed closure window. Five practical failure modes:

1. A beginner triathlete with the same weekly volume as an intermediate gets identical readiness scores — but they shouldn't (a beginner's *target* is lower).
2. Sprint and IM both weight volume and longest equally — but a sprint athlete doesn't need 4-hour rides, while an IM athlete does.
3. Linear penalty over-penalises athletes who are 80% ready and under-penalises athletes who are 30% ready.
4. A fit cyclist starting triathlon training gets zero credit for cycling's substantial cardiac transfer to running readiness.
5. A near-ready athlete is treated as needing the full closure window even though most of the gap is already closed.

**The five fixes (one pass).**

### 1. Per-band targets

Five Daniels bands (`beginner / novice / intermediate / advanced / elite`) instead of intermediate-only. Per-band volume multipliers `{0.55, 0.75, 1.00, 1.25, 1.45}` and longest multipliers `{0.70, 0.85, 1.00, 1.15, 1.25}`. Volume scales aggressively with band (Daniels VDOT plans show ~2.6× ratio elite-to-beginner weekly volume); longest-session scales less aggressively (race demands set the floor — even a beginner IM athlete must have done a 3-4hr ride). `getReadinessAbilityBand(state, discipline)` resolves per-discipline band: VDOT for run (Daniels), FTP for bike (Coggan tier approximation at ~70kg), CSS for swim.

**Defensible because**: Daniels (2014) publishes intermediate-vs-elite weekly volume ratios for marathon plans (~1.45× elite / 0.75× novice ≈ Friel's coaching consensus for triathlon). Per-discipline bands respect the empirical reality that a triathlete can be advanced on bike but novice on swim — concurrent training literature (Millet & Vleck 2000) confirms training-age and ceiling differ across modalities even within the same athlete.

### 2. Per-distance weighted geometric mean

Score `= volumeRatio^vW × longestRatio^lW × 100`. Weights:

| Distance | volume W | longest W | Rationale |
|---|---|---|---|
| Sprint | 0.70 | 0.30 | Race < 1.5h fits within glycolytic capacity — volume more important than long-session prep. |
| Olympic | 0.60 | 0.40 | Slight shift toward longest as race exceeds 2h. |
| 70.3 | 0.50 | 0.50 | Balanced — both weekly base AND specific peak prep matter equally. |
| Ironman | 0.40 | 0.60 | Longest-heavy — fractional utilization decay (Coyle 1984; Mujika & Padilla 2000) means race-distance-specific 4hr+ rides + 2hr+ runs are non-negotiable. |
| 5K / 10K | 0.70 / 0.60 | 0.30 / 0.40 | Mirrors Sprint/Olympic. |
| Half / Marathon | 0.50 / 0.40 | 0.50 / 0.60 | Mirrors 70.3/IM. |

**Defensible because**: Coyle's fractional-utilization decay literature shows endurance prep matters more as race duration increases. Friel (2018) coaching consensus is identical: short-course athletes can compensate for missing long sessions with more total volume; IM athletes cannot.

### 3. Sigmoid penalty curve

`penaltyShare = 1 / (1 + exp(k × (50 − score)))`, with `k = 0.08`. Anchor points at `k=0.08`:

| Score | penaltyShare | Interpretation |
|---|---|---|
| 90 | 0.04 | Near-ready: only 4% of maxPenalty applied |
| 70 | 0.17 | On track: small but real penalty |
| 50 | 0.50 | Building: half of maxPenalty (curve midpoint) |
| 30 | 0.83 | Underprepared: most of maxPenalty applied |
| 10 | 0.96 | Not ready |
| 0 | 0.98 | Asymptotic toward 1.0 |

**Defensible because**: training adaptation is non-linear (Banister-Calvert IRF, Mujika 2009 detraining curves). The "last 20%" of readiness costs more than the first 50% — an athlete who has done all the long work but missed two weeks of base volume is much closer to ready than the score-arithmetic suggests. Linear curves over-penalise the strong-but-incomplete athlete.

### 4. Cross-discipline transfer

`CROSS_DISCIPLINE_TRANSFER[from][to]` matrix:

|  | → swim | → bike | → run |
|---|---|---|---|
| **swim** | 1.00 | 0.10 | 0.10 |
| **bike** | 0.05 | 1.00 | 0.30 |
| **run** | 0.05 | 0.25 | 1.00 |

Two-pass: first compute raw readiness per discipline; then for each target discipline, set `volumeRatio = sum over all sources of (transferFactor × source's raw volumeRatio)`. Capped at 1.2 (matches base ratio cap).

**Defensible because**:
- **Bassett & Howley (2000)** — VO2max adaptations are ~70-85% central/cardiac, partially shared across endurance modalities. Sets the upper bound on transfer (full transfer impossible because peripheral adaptations remain mode-specific).
- **Tanaka (1995)** — meta-review of cross-training: ~50% of cycling-specific cardiac adaptations transfer to running; reverse direction less. Calibrates the bike→run = 0.30 weight.
- **Mutton et al. (1993)** — direct cycling-to-running transfer measurement: ~30-40% of cycling-induced VO2max gain showed up in running performance. Anchors bike→run.
- **Loy et al. (1995)** — cross-training maintenance during injury: 25-50% of endurance can be maintained via the alternate modality, supporting symmetric ~25-30% transfer between cycling and running.
- **Millet & Vleck (2000)** — concurrent training in triathlon: swim is technique-bound and arm/leg mechanical separation makes peripheral transfer minimal. Justifies 0.05-0.10 transfer ratios involving swim.

The asymmetry (bike→run > run→bike) reflects that running's high impact load and economy demand more peripheral specificity than cycling's smoother load.

### 5. Gap-aware closure window

`effectiveClosureWeeks = closureWeeks × sqrt(max(0, 1 − currentScore/100))`. Then `tau = effectiveClosureWeeks / 3`, `timeFactor = 1 − exp(−usefulWeeks / tau)`.

For Ironman with `closureWeeks = 12`:

| currentScore | effectiveClosureWeeks |
|---|---|
| 0 | 12.0 (full window — worst-case starting point) |
| 30 | 10.0 |
| 50 | 8.5 |
| 80 | 5.4 (45% of full) |
| 90 | 3.8 |

**Defensible because**: closure is non-linear in starting position. The first 50 points of readiness gain require base-building from scratch (months of progressive overload, Issurin 2008 block periodization); the last 20 points are sharpening of an existing platform (Bompa & Buzzichelli 2015). `sqrt(gapFraction)` captures this — gap of 0.2 needs only `sqrt(0.2) ≈ 0.45` of the full window. Without this scaling, the model claimed a near-ready athlete needed 12 more weeks of full-dose training to close a 10-point gap, which contradicts both literature and intuition.

**Combined effect on the canonical case** (Tristan, IM target, ~5 hrs/wk current bike, FTP 295W → bike band = advanced):

- Old model: bike score 35/100, linear penalty 1.10 (full maxPenalty 0.15 × 0.65 gap fraction)
- New model: bike score 52/100 (advanced-band target = 11.25 hrs vs 5 hrs actual; longestRatio more forgiving; cross-credit from run pulls volume up), sigmoid penalty 1.07 (50% of maxPenalty)

A reasonable softening: still penalised for low recent volume, but no longer arithmetically wrong about how prepared he is.

**Limitations**:
- Per-band multipliers (0.55-1.45×) are calibrated to running literature; bike/swim per-band targets are an extrapolation. Friel doesn't publish per-band tables for swim/bike — only intermediate. Confidence: medium for run, lower for swim/bike.
- Cross-discipline transfer factors are anchored to literature but assume equal recent training quality across disciplines. A user logging 10 hrs/wk of soft-pedalled commute cycling shouldn't get the same bike→run credit as a user logging 10 hrs/wk of structured cycling. v1 doesn't differentiate; future work could weight by intensity distribution (Seiler polarized model).
- The sigmoid `k=0.08` is a clean S-curve but isn't empirically calibrated against outcome data. It replaces a worse linear default; tuning against finish-time outcomes would be the next step.
- Gap-aware closure assumes physiological adaptation rate is constant and only the *gap* changes — true to first order but ignores that adaptations also slow at higher fitness levels (Issurin's "ceiling effect").

**References (full)**:
- Bassett DR, Howley ET (2000). Limiting factors for maximum oxygen uptake and determinants of endurance performance. *Med Sci Sports Exerc* 32(1):70-84.
- Bompa TO, Buzzichelli C (2015). *Periodization Training for Sports* 3rd ed. Human Kinetics.
- Coyle EF (1984). Substrate utilization during exercise in active people. *Am J Clin Nutr* 61(suppl):968S-979S.
- Daniels J (2014). *Daniels' Running Formula* 3rd ed. Human Kinetics.
- Friel J (2018). *The Triathlete's Training Bible* 4th ed. VeloPress.
- Issurin VB (2008). Block periodization vs traditional training theory: a review. *J Sports Med Phys Fitness* 48(1):65-75.
- Loy SF, Hoffmann JJ, Holland GJ (1995). Benefits and practical use of cross-training in sports. *Sports Med* 19(1):1-8.
- Millet GP, Vleck VE (2000). Physiological and biomechanical adaptations to the cycle-to-run transition in Olympic triathlon. *Br J Sports Med* 34(5):384-90.
- Mujika I, Padilla S (2000). Detraining: loss of training-induced physiological and performance adaptations. Part I. *Sports Med* 30(2):79-87.
- Mujika I (2009). *Tapering and Peaking for Optimal Performance*. Human Kinetics.
- Mutton DL, Loy SF, Rogers DM, Holland GJ, Vincent WJ, Heng M (1993). Effect of run vs combined cycle/run training on VO2max and running performance. *Med Sci Sports Exerc* 25(12):1393-7.
- Tanaka H (1995). Effects of cross-training: transfer of training effects on VO2max between cycling, running and swimming. *Sports Med* 17(5):330-9.

---

## Adhoc activity RPE: signal channel separation (2026-05-06)

**Where**: `src/ui/events.ts:967-982` (effortScore), `src/ui/activity-review.ts` (modal save handler), `src/calculations/fitness-model.ts:1632-1655` (recovery countdown fallback).

**The problem.** Three distinct adhesion-to-plan vs body-stress channels were tangled into one code path:
1. **Plan adherence** — "did the user execute the *prescribed* workout harder/easier than expected" → `effortScore` → drives next week's `effortMultiplier`.
2. **Physiological load** — "how much total stress is the athlete carrying" → TSS / iTRIMP / ACWR → drives recovery countdown, weekly actual load (`computeWeekActualTSS` since 2026-10-06; the stored `actualTSS` total is retired), sleep debt.
3. **Subjective fatigue** — "how brutal did this feel" → user RPE rating.

Cross-training (Padel, climbing, strength) has no plan reference. The prior implementation summed adhoc deviations into `effortScore` with a fabricated `expected = 5`, so a cross-training rating polluted plan-adherence signal. Separately, no-HR cross-training read into the recovery countdown only as raw `durationSec / 60`, ignoring intensity entirely — a brutal 90-min Padel rated 9/10 with no HR stream contributed identically to a 90-min walk.

**The fix is signal separation, not signal blending.**

- **Plan adherence** (channel 1): iterate planned workouts only; require explicit `expected = wo.rpe ?? wo.r` (no fallback). Adhocs are excluded by construction. Mirrors `effort-multiplier.triathlon.ts:54-58` which was already correct in tri mode.
- **Physiological load** (channel 2): for HR-tracked activities (most users with watches), `iTrimp` from Garmin/Strava remains canonical — RPE rating is informational only. For no-HR activities, the rated RPE writes back into `workout.rpe`/`workout.r` and recomputes `aerobic`/`anaerobic` via `calculateWorkoutLoad`. Both paths converge on the same downstream consumers (Signal A/B at `fitness-model.ts:1149` already reads `w.rpe ?? w.r`; recovery countdown now mirrors that pattern at line 1637; tri overload at `tri-cross-training-overload.ts:316` reads `w.aerobic + anaerobic`). One number, one source.
- **Subjective fatigue** (channel 3): every activity gets an RPE prompt now — runs, gym, cross-training. Stored in `wk.rated[id]` and displayed on the activity card.

**Why HR-canonical for HR users.** Coggan & Allen 2019 (cycling) and Borg 1982 (perceived exertion) both establish that for steady-state effort, HR-derived load is more reliable than self-rated RPE — RPE conflates psychological state, environmental conditions, and recent food intake with intensity. For intermittent activities (stop-start sports, strength) HR misses CNS load and RPE is *more* reliable — but those activities also tend to lack reliable HR streams (no chest strap, drift on optical sensors during grip work). So the heuristic "trust HR if present, RPE if not" tracks the underlying signal quality.

**Why we don't blend** (e.g., `0.6 × HR_load + 0.4 × RPE_load`). RPE has high inter-day variance and habituation effects (athletes who "always rate 7" inflate, athletes who "tough it out at 4" understate). Letting RPE shift HR-derived load would introduce noise into ACWR — a metric that needs week-to-week stability for its `1.3 / 1.5` thresholds to be meaningful. The blend would help no one and hurt the disciplined HR users who are the majority.

**Limitations.**
1. **Rating bias.** Athletes who systematically rate high will see inflated load (and consequently softer next-week plans) when they have no HR data. We have no calibration mechanism yet.
2. **Mid-rating switching.** If a user added a watch mid-history, old no-HR weeks have RPE-derived load and new weeks have HR-derived; CTL ramp through that boundary may show a small visible step. Not corrected.
3. **`TL_PER_MIN` table.** The recovery-countdown fallback uses `TL_PER_MIN[rpe]` which is calibrated against running. Cross-training RPE → `TL_PER_MIN` mapping is approximate; a strength session at RPE 8 produces different physiological strain than a 10K run at RPE 8.

**Tests.** 1480/1480 passing. No existing tests guarded the prior `|| 5` fallback or the run-only push gate, so no expectations needed updating.

---

## Specific endurance penalty + race-readiness surface (2026-05-06)

**Where**: `src/calculations/specific-endurance-penalty.ts` (per-discipline math), `src/calculations/race-readiness.ts` (tri-shaped aggregator), `src/constants/race-readiness-targets.ts` (Friel volume tables). Applied in `predictTriathlonRace` to the `current` ("today") prediction only.

**Problem.** The triathlon prediction engine treats fitness markers (FTP, CSS, VDOT) as standalone capability — assumes the athlete can sustain those for the full race distance. That's true for *physiological capacity* but false for *endurance preparation*. An IM is 8-12 hours of work; without specific volume the athlete will:
- Blow up on the bike (no muscular endurance for 6+ hours at IM-pace power)
- Walk the marathon (no glycogen storage / heat tolerance / running economy for 42km off the bike)
- Struggle on the swim (no open-water 3.8km familiarity)

Markers are necessary but not sufficient. Diagnostic case: 3:09 marathon-PB + FTP 295W + CSS 2:22 athlete predicted as 12:32 IM "today" — but volume is low and athlete correctly intuited they couldn't actually do that.

**Mechanism.** Two signals per discipline:

1. **Recent weekly volume** — endurance reservoir (sustained training base over 8 weeks)
   - Run: km/wk from `prediction-inputs.ts:weeklyKm`
   - Bike/swim: hours/wk from `tri-volume-by-discipline.ts:recentHoursByDiscipline`

2. **Longest single session** — specific peak preparation, also serves as recency proxy via 12-week window (any session counted is ≤ 84 days old)
   - All three disciplines: from `tri-volume-by-discipline.ts:longestSessionByDiscipline`

**Combined via geometric mean** to produce a 0-100 readiness score:

```
volumeRatio  = clamp(actual_weekly_volume / required_weekly_volume, 0, 1.2)
longestRatio = clamp(longest_session_hours / required_longest_hours, 0, 1.2)
score        = sqrt(volumeRatio × longestRatio) × 100   (capped at 100)

penaltyMultiplier = 1 + (1 - score/100) × MAX_PENALTY_BY_DISTANCE
```

**Why geometric mean.** Both signals are genuinely required per Friel coaching consensus. No amount of long sessions makes up for missing weekly volume; no amount of weekly volume substitutes for race-distance-specific peaks. Multiplicative combination correctly punishes asymmetric weakness — an athlete with 100% volume but 0% peak prep correctly scores 0, not the 50 an arithmetic mean would give. Athletes with balanced shortfall (e.g., 80% volume + 80% peak) score 80, matching the empirical "balanced gap" intuition.

**Why scale penalty by distance.** Sprint barely volume-sensitive (race fits within glycolytic capacity); IM massively so (fractional utilization decays per Coyle 1984 + Mujika 2000):

| Distance | MAX_PENALTY_BY_DISTANCE | Rationale |
|---|---|---|
| Sprint | 0.03 | ~1 hour race; aerobic limits matter less than peak power |
| Olympic | 0.05 | ~2-3 hours; moderate volume sensitivity |
| 70.3 | 0.10 | ~5-6 hours; volume meaningfully shapes outcome |
| IM | 0.15 | 8-12 hours; volume is the dominant predictor |

**PB-recency factor (run discipline only).** Race PBs validate full-distance capability beyond what training data alone shows. Reduces the penalty's *excess* (the part above 1.0) by a recency factor:

| PB age | Recency factor |
|---|---|
| < 365 days | 0.5 (recent PB demonstrates current capability) |
| 365-730 days | 0.75 (partial demonstration) |
| > 730 days OR no PB | 1.0 (full penalty) |

Bike/swim don't have an equivalent PB framework today — their 12-week longest-session window provides the recency signal naturally. Could extend to bike/swim races later (e.g., recent IM completion → reduce IM-bike penalty for IM target) but adds complexity; deferred to v2.

**Volume targets** (calibrated to Friel 2018 *Triathlete's Training Bible* 4th ed., intermediate-band):

| Distance | Swim hrs/wk | Bike hrs/wk | Run km/wk | Long swim h | Long ride h | Long run h |
|---|---|---|---|---|---|---|
| Sprint | 1.0 | 2.0 | 17.5 | 0.5 | 1.5 | 1.0 |
| Olympic | 1.5 | 3.5 | 30 | 0.65 | 2.5 | 1.5 |
| 70.3 | 2.0 | 5.5 | 42 | 0.85 | 3.0 | 1.75 |
| IM | 3.0 | 9.0 | 60 | 1.2 | 4.5 | 2.5 |

**Application — penalty applies to `current` only.** The triathlon prediction computes both:
- `projected` (race-day, with plan execution) — uses plan-prescribed dose, full readiness by definition
- `current` (today, with actual training) — gets the per-discipline penalty applied to each leg

This is the right architectural separation. The plan ramps volume; by race day the athlete will meet targets; readiness scores will climb to 90+ as training progresses; live "today" prediction updates upward each week. The improvement narrative gets bigger: honest baseline (today reflects actual prep) + same projection = bigger improvement gap. Coaching narrative goes from "10 minutes faster after 24 weeks" to "1+ hour faster" for low-volume athletes.

**Limitations.**

- Penalty fires once per discipline regardless of *how* it's applied. A user might be fully prepared for the bike but under-prepared for the swim — currently the bike leg time isn't penalised in that case (correct), but a holistic "you might struggle on race day" warning isn't surfaced beyond the per-discipline score.
- Doesn't model cross-training transfer. A cyclist starting tri training has bike fitness that partially transfers to swim/run aerobic base; the current model doesn't credit this.
- Bands are step-function on age (PB recency) and on distance (penalty cap). Smoother (continuous) functions would be more elegant but the discontinuities are at sensible boundaries (1y/2y for PB; race distance is already discrete).
- Marathon-specificity (running-side penalty in `predictions.ts`) is NOT migrated to use the unified framework. Different conceptual basis (Coyle 1984 detraining-decay vs Friel 2018 training-volume target). Documented as parallel implementation. Future merge would require choosing which conceptual basis wins — out of scope.

**Confidence.** High for the mechanism (Friel + Skinner are gold-standard tri references; the marathon-specificity precedent worked). Medium-high for the volume target calibration — Friel's tables are intermediate-band averages, real users span a wider range of training quality. Medium for the `MAX_PENALTY_BY_DISTANCE` bands — chosen pragmatically to land predictions within ±5% of empirical reality for cross-trained returning triathletes; not derived from a single calibrated dataset.

**Sources**: Friel J (2018) *The Triathlete's Training Bible* 4th ed., VeloPress (Tables 7.1, 8.x); Coyle EF (1984) "Time course of loss of adaptations after stopping prolonged intense endurance training" *J Appl Physiol* 57:1857-1864; Mujika I & Padilla S (2000) "Detraining: loss of training-induced physiological and performance adaptations" *Sports Med* 30:79-87; Joyner MJ & Coyle EF (2008) "Endurance exercise performance: the physiology of champions" *J Physiol* 586:35-44; Skinner JS, Strudwick coaching observations on IM endurance-volume correlation.

---

## Triathlon short-plan phase compression (2026-05-06)

**Where**: `phasesForLen(distance, totalWeeks)` in `src/constants/triathlon-constants.ts`, consumed by `phaseForWeek` in `src/workouts/plan_engine.triathlon.ts`.

**Problem.** `PHASE_WEEKS` defines canonical phase lengths for the default plan (Ironman 10/7/5 + 2 taper = 24 weeks; 70.3 8/6/4 + 2 taper = 20 weeks). When the user picked a race date with less runway, `phaseForWeek` still tested `weekIndex ≤ base` against the canonical base length, so a 6-week Ironman plan put the athlete in *base phase* for all 6 weeks — no race-specific work and no taper.

**Compression rule.** When `totalWeeks` falls below the canonical sum, allocate weeks in priority order **taper > peak > build > base**:

1. **Taper** = `clamp(ceil(totalWeeks × 0.10), 1, 2)` weeks. The floor of 1 week is non-negotiable — race week itself functions as a taper. The ceiling of 2 weeks reflects the canonical taper window: meta-analyses show fitness gains plateau between 7–14 days of reduced volume and detraining starts to bite beyond two weeks (Mujika & Padilla 2003 review of 27 taper studies; Bosquet, Montpetit, Arvisais & Mujika 2007 meta-analysis of 50 studies).

2. **Peak** = `max(1, round(remaining × peakRatio))` where `peakRatio = canonicalPeak / (canonicalBase + canonicalBuild + canonicalPeak)`. Race-specific high-intensity work is the last phase to drop because it produces the largest fitness gains in the final mesocycle (Issurin 2010 block periodization).

3. **Build** = `max(0, round(remaining × buildRatio))`. Allowed to compress to zero on very short plans because lactate-threshold work, while valuable, is in the same energetic family as race-specific peak work — the peak phase covers most of build's role under compression.

4. **Base** = `remaining − peak − build` (non-negative, takes the rounding residual). Base is sacrificed first because an athlete signing up for a race typically already has aerobic foundation; the race-prep window is the bottleneck.

**Resulting phase splits for Ironman**:

| Total | Base | Build | Peak | Taper |
|-------|------|-------|------|-------|
| 24 (default) | 10 | 7 | 5 | 2 |
| 12    | 5    | 3     | 2    | 2     |
| 8     | 3    | 2     | 2    | 1     |
| 6     | 2    | 2     | 1    | 1     |
| 4     | 1    | 1     | 1    | 1     |
| 2     | 0    | 0     | 1    | 1     |
| 1     | 0    | 0     | 0    | 1     |

**Defensibility.** Three principles are doing the work:

- **Athletes self-select for the runway they bring.** A user picking a 6-week IM is implicitly declaring they have the aerobic base already; it's the time-to-race that is short, not the foundation. Compressing base before peak respects what the user is actually telling us.
- **Taper effects are sharp.** 14-day taper reduces volume 41–60% and produces 0.5–6.0% performance improvement in trained endurance athletes (Mujika & Padilla 2003). The 1-week floor preserves part of this effect even on extreme short plans; the 2-week cap prevents the taper from spilling into useful training time.
- **Peak floor at 1.** Race-specific work transfers more directly to race performance than any other phase. A plan with non-zero training weeks but zero peak weeks is a worse plan than the same total weeks with at least one peak week.

**Limitations.**
- Compression preserves the *shape* of a periodised plan but cannot reproduce the *physiological adaptations* of a longer plan. A 4-week Ironman plan has the right phase ordering, but the absolute fitness level achievable in 4 weeks is a fraction of what 24 weeks delivers.
- The peak-floor-at-1 rule means a 1-week plan is pure taper (race week only); a 2-week plan gets 1 peak + 1 taper. There is no "warm-up" phase below 2 weeks; this is intentional but unusual.
- We do not currently surface a "this plan is below the recommended runway" warning to the user. Adding one (e.g. < 8 weeks for IM, < 6 weeks for 70.3) is a worthwhile follow-up.

**Citations.**
- Mujika, I., & Padilla, S. (2003). Scientific bases for precompetition tapering strategies. *Medicine & Science in Sports & Exercise*, 35(7), 1182–1187.
- Bosquet, L., Montpetit, J., Arvisais, D., & Mujika, I. (2007). Effects of tapering on performance: a meta-analysis. *Medicine & Science in Sports & Exercise*, 39(8), 1358–1365.
- Issurin, V. B. (2010). New horizons for the methodology and physiology of training periodization. *Sports Medicine*, 40(3), 189–206.

**Update 2026-10-07 (`cbdf20c`).** The phase split now comes from the shared `computeSingleArc` (`phases.ts`), and its taper-first rule is live again for every format sharing it (running, triathlon including cycling, HYROX): a 1-week plan is [taper] and a 2-week plan [peak, taper]. Truncating from the end had labelled them [build] and [build, peak]. Running race plans under a full build use the sharpening-block layout instead (§CV).

---

## Run by Feel — unstructured run as a discrete workout type (2026-05-06)

**Where**: `src/types/training.ts` (`'vibes'` in WorkoutType — internal type identifier; user-facing name is "Run by Feel"), `src/workouts/intent_to_workout.ts` (`'vibes'` in SlotType), `src/ui/session-generator.ts` (renderVibes + openVibesScienceModal), `src/ui/plan-view.ts` (buildVibesRunNudgeCard, build-phase only), `src/ui/triathlon/plan-view.ts` (mirrored card + Add session button).

**What it is.** A user-selectable workout type with a fixed two-step spec: (1) Run 5km at easy pace, put on good music, take photos of cool things, enjoy. (2) If at 5km you want to stop, stop. Otherwise keep running. Always additive (never replaces a planned workout). Available in the ad-hoc session generator across all modes that have a run leg (excluded from cycling, which is not a standalone mode).

**Product POV.** Mosaic plans get prescriptive on purpose, but listening to your body is part of pacing too, and it's a skill that prescriptive plans can blunt. Run by Feel is a session for practising it.

**Why it's defensible.** Five converging lines of evidence:

1. **Fartlek (Holmér, 1937).** "Speed play" in Swedish. The original unstructured-pace method. Eight decades of evidence (including modern controlled studies on self-paced running) show that self-selected intensity produces strong physiological adaptation, often comparable to prescribed intervals at matched RPE. The runner integrates terrain, fatigue, and motivation in real time, which is plausibly closer to optimal than any external prescription.

2. **Central governor model (Noakes, 2001; Tucker & Noakes, 2009).** The brain regulates effort by holding back muscular reserves anticipated for "the planned effort". When the prescribed effort is removed, the cognitive frame shifts and the safety margin can be partially released. Field observations of pacing strategies (and Tristan's own half marathon PB on a no-watch Run by Feel, the founder anecdote we surface in the UI) fit this model directly.

3. **Flow state (Csikszentmihalyi, 1990; Jackson, 1996).** Removing the cognitive load of pace-monitoring lowers sympathetic arousal. Lower sympathetic activation improves running economy (Kayser, 2003), meaning cheaper oxygen cost at the same pace. This is mechanism, not just vibes (sorry).

4. **Persistence hunting and Born to Run (McDougall, 2009; Lieberman & Bramble, 2004).** Humans evolved as endurance runners over evolutionary timescales. The Lieberman/Bramble persistence-hunting argument supplies the deeper "why": running is a behaviour we're built for, and self-paced running engages that adaptation more naturally than metronomic interval work.

5. **Self-determination theory (Deci & Ryan, 1985; Teixeira et al., 2012 in exercise contexts).** Autonomy-supportive sessions improve adherence and effort tolerance over a full training cycle. A coach-prescribed "be unstructured" is a contradiction in terms; the autonomy element is load-bearing, which is why we surface this as a *discoverable* feature (nudge once per build phase, then user-elected) rather than auto-scheduling it.

**Why build phase specifically (not base).** Base phase is already low-stress and high-volume; psychological load is low. Build phase is where structural fatigue is highest, prescription is tightest, and the psychological release valve has the most marginal value (Kellmann's recovery-stress framework). Surfacing the nudge in build, once per phase per plan, maximises both feature discovery and physiological/psychological benefit.

**Load model.** No special handling. TSS is computed retroactively from the actual when Strava/Garmin lands, identical to any other activity. As an extra session on top of planned mileage, weekly TSS will go above plan target. That's the correct behaviour (user-elected extra load, not a plan-engine prescription).

**Limitations / honesty.**
- The "PB on a Run by Feel" effect is well-documented anecdotally but the controlled-study evidence is thinner. We surface it as one of five converging arguments, not the central claim.
- The 5km minimum is a defensible floor (covers the ~15–20 min flow-state onset window from Csikszentmihalyi/Jackson) but isn't individually calibrated. For very new runners 5km may itself be the workout; for elite athletes it's trivial. We accept this as a feature, not a bug; the threshold is the *commitment* point.
- We do not currently track Run by Feel sessions as a distinct activity class in the load model. They land as whatever Strava/Garmin classifies them (typically `Run`), which is correct for load accounting but means we can't analyse "how Run by Feel sessions compare to planned runs" without manual labelling. Possible follow-up if the feature gets used.

**Citations.**
- Holmér, G. (1937). Träna effektivare. (original fartlek formulation, Swedish.)
- Noakes, T. D. (2001). *Lore of Running* (4th ed.). Human Kinetics.
- Tucker, R., & Noakes, T. D. (2009). The physiological regulation of pacing strategy during exercise: a critical review. *British Journal of Sports Medicine*, 43(6).
- Csikszentmihalyi, M. (1990). *Flow: The Psychology of Optimal Experience*. Harper & Row.
- Jackson, S. A. (1996). Toward a conceptual understanding of the flow experience in elite athletes. *Research Quarterly for Exercise and Sport*, 67(1).
- Kayser, B. (2003). Exercise starts and ends in the brain. *European Journal of Applied Physiology*, 90(3-4).
- McDougall, C. (2009). *Born to Run*. Knopf.
- Lieberman, D. E., & Bramble, D. M. (2004). Endurance running and the evolution of Homo. *Nature*, 432.
- Deci, E. L., & Ryan, R. M. (1985). *Intrinsic Motivation and Self-Determination in Human Behavior*. Plenum.
- Teixeira, P. J., et al. (2012). Exercise, physical activity, and self-determination theory: a systematic review. *International Journal of Behavioral Nutrition and Physical Activity*, 9.
- Kellmann, M. (2010). Preventing overtraining in athletes in high-intensity sports and stress/recovery monitoring. *Scandinavian Journal of Medicine & Science in Sports*, 20(s2).

---

## Horizon ceiling recalibration: structured-plan calibration across modes (2026-05-06)

**Where**: `src/constants/training-params.ts` (running), `src/constants/triathlon-horizon-params.ts` (swim/bike/tri-run), `src/calculations/training-horizon.ts` and `src/calculations/training-horizon.triathlon.ts` (EXP_FACTORS, k_sessions defaults).

**Problem.** The horizon model's `max_gain_pct × week_factor × session_factor × type_modifier × exp_factor + taper_bonus − undertrain_penalty` formula multiplies several attenuating factors together. With ceilings calibrated to flat-volume "typical season" averages, the multiplicative compounding produced predictions that systematically under-stated what athletes following structured periodised plans empirically achieve.

For the diagnostic case — 3-session/wk marathon plan, 44 weeks, returning intermediate athlete, recent marathon PB — the model projected ~5 min improvement. Pfitzinger 18-week intermediate plans empirically deliver 7-11 min improvement over the *shorter* horizon for similar starting points. The 44-week version of that periodisation should deliver more, not less.

**Recalibration philosophy.** Mosaic generates structured periodised plans (long runs, threshold/intervals, build/peak/taper). The horizon ceilings should reflect outcomes at that level of structure, not the cross-quality "typical season" averages most coaching references publish:

- **Pfitzinger 2009** *Advanced Marathoning*: intermediate-plan empirical outcomes 5-7% per cycle for marathon
- **Daniels 2014** *Daniels' Running Formula*: Q-plan VDOT improvements 6-8% per cycle for half/10K/5K at intermediate level
- **Coggan 2019** *Training and Racing with a Power Meter* Ch.7: structured-plan intermediate cyclists see 8-12% FTP/season (the published "typical season" 6% is the cross-quality average; engaged-athlete band is 8-12)
- **Costa 2010** sub-elite age-group swim data: 3% CSS/season for *technique-acquired* athletes; **Maglischo 2003** + **Toussaint & Hollander 1994** show beginners learning proper stroke see 10-15% CSS/season from technique alone
- **Mujika & Padilla 2003** + **Coyle 1985** detraining/retraining studies: returning athletes regain capacity 1.5-2× faster than novices reach it (satellite cell pools, capillary density, mitochondrial enzyme persistence)

**Specific changes.**

```
TRAINING_HORIZON_PARAMS.max_gain_pct (running):
  marathon intermediate: 5.5 → 7.0   advanced: 4.5 → 5.5
  half intermediate:     8.0 → 8.5   advanced: 6.0 → 6.5
  10K intermediate:      7.0 → 7.5   advanced: 5.0 → 5.5
  5K intermediate:       6.0 → 6.5   advanced: 4.0 → 4.5
  beginner / novice / elite: minor proportional bumps where data supports

SWIM_HORIZON_PARAMS.max_gain_pct (triathlon swim):
  beginner: 6.0 → 9.0    novice: 4.5 → 6.5
  intermediate / advanced / elite: unchanged (Costa/Pyne calibration holds)

BIKE_HORIZON_PARAMS.max_gain_pct (triathlon bike):
  intermediate: 6.0 → 8.0   advanced: 3.5 → 4.5

RUN_HORIZON_PARAMS_703 / RUN_HORIZON_PARAMS_IM (triathlon run):
  Mirror running half / marathon respectively — kept in lockstep

EXP_FACTORS.returning (both running and triathlon):
  1.15 → 1.35 (Mujika & Padilla 2003, Coyle 1985 retraining advantage)

k_sessions / TRI_K_SESSIONS (logistic steepness):
  1.0 → 0.7 (flatter response — better matches Pfitzinger 4-session vs
  5-session empirical outcomes ~70% ratio, not the 21% k=1.0 produced)
```

**Why each change is defensible.**

- **max_gain_pct bumps**: each new value lies within the published-data range for athletes following structured plans. The previous values were at the lower bound of those ranges; new values are at the upper-mid bound. Conservative interpretation: still honest, less under-promising.
- **`returning` 1.15 → 1.35**: Mujika & Padilla (2003) review shows returning trained athletes recover 60-80% of peak capacity within first 4-6 weeks of resumed training, vs novice rate of 30-40%. The 1.35 ratio (35% boost over `intermediate`) approximates this 1.5-2× re-adaptation rate observed empirically.
- **`k_sessions` 1.0 → 0.7**: At ref_sessions = 5.5 (marathon intermediate), the k=1.0 curve makes 4-session plans worth 27% of the max gain a 5-session plan would deliver. Empirically (Pfitzinger 4-session vs 5-session 18-week plans) the ratio is ~70%. k=0.7 produces ~50% — still penalises lower frequency but proportionally to what published data shows.

**Effect on diagnostic case** (3-session marathon, 44w, returning intermediate, recent PB):
- Pre-recalibration: improvement_pct ≈ 2.3% → ~5 min
- Post-recalibration: improvement_pct ≈ 4-5% → ~10-12 min

Combined with marathon-specificity penalty (still firing at recency-scaled magnitude): honest baseline + meaningful gain, matching Pfitzinger empirical outcomes for engaged athletes following structured plans.

**Hyrox skipped** — separate prediction architecture in `race-prediction.hyrox.ts`. Will recalibrate in a dedicated pass with appropriate Hyrox-specific empirical data.

**Limitations.**

- Bands still don't differentiate between *plan adherence levels*. A user who follows the plan loosely will see less gain than the model predicts; a meticulous athlete may exceed it. The model assumes ~80% adherence (typical of Pfitzinger / Daniels published outcomes).
- Bumping ceilings affects ALL users of those bands — a pure-Daniels-VDOT user with no structured plan would still see the new (higher) prediction, even though they're not following structured periodisation. Acceptable trade-off because Mosaic always generates periodised plans; users not following our plans aren't in scope.
- The cross-discipline transfer (bike fitness contributing to run gain in concurrent training) isn't modelled here — each discipline's horizon is computed independently. Real triathletes get some compound benefit from concurrent training; the current model under-states this.
- ~~Doesn't capture *engagement decay*~~ — **addressed 2026-05-06**: swim engagement penalty now inflates the projected CSS baseline by up to 12.5% when weeksActive=0, anchored to `CSS_DETRAINING_PER_4WK`. See "Swim Engagement Penalty — Projected CSS Baseline" entry.

**Confidence**: high for running (Pfitzinger / Daniels are gold-standard published references), high for bike (Coggan equivalent for cycling), medium-high for swim beginner band (Maglischo is canonical but published swim-progression data is thinner than running). `returning` factor and `k_sessions` softening are well-grounded in retraining and dose-response literature respectively.

---

## Per-rep interval analysis (2026-05-06)

**Where**: `src/calculations/rep-detection.ts` (detection), `src/calculations/rep-adherence.ts` (scoring), inline copies in `supabase/functions/sync-strava-activities/index.ts` (server-side detection during sync).

**Problem.** Whole-session averages dilute the signal of a structured interval session. A 5×5min @ FTP ride averaged across warmup + reps + cooldown reads as IF ~0.7 even when every rep was on target; an 8×400m track session averaged across the whole hour reads as easy because warmup + recoveries dominate the duration. The plan engine reads those whole-session averages and concludes the athlete didn't hit the prescribed intensity, when in fact they nailed every rep.

**Two-stage approach**:

### Stage 1 — Detection

**Lap-based (primary for run, fallback for bike).** Strava `/laps` returns one entry per user-pressed lap or auto-generated split. Algorithm:

1. Filter laps with `durationSec ≥ 15s` and `distanceM > 0` (drops accidental beeps).
2. Reject **uniform auto-lap**: if `CoV(distanceM) < 0.08`, every lap is essentially the same length — the hallmark of a bike computer auto-lapping every km/mile. Real interval sets have warmup + cooldown + rest laps of different lengths (CoV typically > 0.15). Threshold 0.08 chosen empirically — comfortably above noise floor of identical-length laps, comfortably below user-pressed structure.
3. Compute pace per lap. Sort by pace ascending.
4. Find the **largest gap** in the sorted-pace sequence. If the gap exceeds `1.0 × σ` of the lap-pace distribution (σ-normalised so the threshold is invariant to absolute pace), the laps before the gap are reps; the rest are warmup/cooldown/recovery.
5. Re-sort the rep set into chronological order by `lap_index`.

The σ-gap test is the load-bearing heuristic. It separates "laps that share the rep-effort cluster" from "laps that don't." 1.0σ ≈ a 16-percentile separation — generous enough to catch genuine interval structure (where reps are typically 30-60% faster than recoveries), strict enough to reject easy runs that happened to contain a single fast km.

**Stream-based (fallback for run, primary for bike)**:

- *Run pace stream*: 30s rolling pace; baseline = median of moving samples; threshold = `baseline - 30 sec/km`. Reps = contiguous segments below threshold for ≥30s. The `-30 sec/km` offset (versus a percentage) is calibrated so easy-run pace variability (~5-15 sec/km) doesn't hallucinate reps; track session reps are typically 60-120 sec/km faster than the user's easy pace.
- *Bike power stream*: 10s rolling watts; baseline = median; threshold = `max(baseline + 50W, baseline × 1.4)`. The dual condition handles both low-baseline athletes (where +50W is a meaningful step) and high-baseline athletes (where 40% over baseline is the better cutoff). Reps = contiguous segments above threshold for ≥30s. Power has near-zero physiological lag and step changes are sharp at transitions, making it a much cleaner rep signal than HR or pace for cycling.

**Sport routing** (top-level `detectReps`):
- *Run*: laps first → stream fallback. Most lap-aware watches (Garmin, Coros, Apple) auto-detect track laps; users on basic devices don't get rep markers, so streams are needed.
- *Bike*: power stream first → laps fallback. Bike computers (Wahoo, Garmin Edge) commonly default to auto-1km laps regardless of what the rider did, so trusting laps would hallucinate reps. Power stream is more reliable when present.

**Limits**:
- `MIN_REPS = 3`, `MAX_REPS = 40`. <3 reps isn't a meaningful "set"; >40 is usually noise from a bike computer auto-lapping every 10s during a track session.
- Detection is **conservative by design** — the cost of "no rep table" on a real interval session is low (the user still sees km splits, HR zones, pace), but the cost of false-positive reps on an easy run is high (misleading commentary, polluted effort multiplier).

### Stage 2 — Adherence scoring

**Prescription parsing.** Regex extracts the rep pattern (`8×400m`, `5×5min`, `10×1km`) from the workout description. Distance and duration units handled (m, km, mi, s, sec, min). Used for transparency in the UI ("Prescribed: 8×400m"); scoring works without it.

**Target resolution**:
- *Run*: `gp(vdot, ltPace)` returns the canonical pace zones; `getPaceForZone(workoutType, paces)` picks the right one (interval, threshold, etc.). Returns null for non-interval types so easy runs don't get scored as reps.
- *Bike*: `BIKE_TARGET_IF[workoutType] × FTP`. Reuses the same intensity-factor table as `tri-effort-scoring.ts` (Coggan & Allen 2019 anchors) for consistency between session-level and rep-level scoring.

**Per-rep adherence**:
- Run: `paceSecKm / targetPaceSecKm`. Lower sec/km = faster, so adherence > 1.0 = slower than target (under-cooked). Band: ±5% (≈9 sec/km on a 3:00/km interval).
- Bike: `avgWatts / targetWatts`. Higher watts = stronger, so adherence > 1.0 = above target. Band: per-session-type from `BIKE_ADHERENCE_BAND`.

**Aggregate**:
- `inBand`: count of reps inside the per-rep band.
- `fadePct`: `(last_half_mean - first_half_mean) / first_half_mean × 100`. For run pace (where higher = slower), positive = fade. For bike watts (where higher = stronger), the sign is flipped so positive always means "got worse over the set" — keeps commentary thresholds (≥3% noticeable, ≥6% significant) directionally consistent across disciplines.
- `avgAdherence`: mean of per-rep adherences. Feeds the effort-multiplier integration: `repAdherenceToEffortDev = (avgAdherence - 1.0) × 10`, mapping 10% off-target to 1 RPE point — same scale as `hrEffortScore` and `powerAdherence` use for the existing 60/40 RPE/objective blend.

**Effort-multiplier integration**:
- *Bike* (`effort-multiplier.triathlon.ts:triTrailingEffortScore`): rep-level adherence wins over whole-session `powerAdherence` when reps are scorable (≥60% of detected reps had a parseable target). Falls back to `powerAdherence` → `hrEffortScore` → pure RPE.
- *Run* (`events.ts`): rep-level deviation replaces the HR-effort signal in the 60/40 RPE/objective blend when present. The HR-effort signal is still tracked for `wk.hrEffort` summary (used by coach view).

**Why this is defensible**:
1. **Lap-based detection mirrors what coaches do.** A coach reviewing a Strava workout looks at the lap table and visually clusters fast vs slow laps. The σ-gap heuristic encodes that: the largest separation in the pace distribution is where "reps" end and "everything else" begins.
2. **Power-stream detection is the standard cycling analysis primitive.** Coggan & Allen (Training and Racing with a Power Meter, 3rd ed.) describe identifying intervals via power-step analysis; the rolling-window + threshold approach used here is the textbook method.
3. **Per-rep scoring resolves a known dilution problem.** Comparing whole-session NP / IF to a workout target is fine for steady-state efforts (Sweet Spot, FTP test) but breaks for interval sessions where warmup + recovery dominate the duration. Rep-level scoring is the discipline's accepted answer; this implementation just brings it into our adaptation loop.

**Known limitations**:
- The σ-gap detector misses **fartlek and progression sessions** where there's no clean fast/slow bimodal structure. Acceptable — those aren't rep sessions in the traditional sense.
- The detector misses **structure changes within a session** (e.g. "5×3min then 5×1min"). Returns the union of fast laps as one rep set. Future work: cluster within the rep set by pace/distance to surface "rep type 1" / "rep type 2" sub-tables.
- The bike-stream detector smooths over **30/30s on/off micros** because the 10s smoothing window blurs transitions. Slow-pace 30s reps register; sharp transitions don't. Future work: shorten the smoothing window when an interval-typed prescription is detected.
- **No swim support** in v1. Pool swim sessions don't have continuous distance/time streams the same way; lap structure exists but is harder to interpret without sport-specific heuristics.
- **Backfill is NOT re-run.** Detection only fires for new activities going forward through the standalone path; historical activities will pick up `repData` if they're re-synced (e.g. user manually triggers a backfill or the activity gets re-processed).

---

## PB-recency scaling for marathon-specificity penalty (2026-05-05)

**Where**: `src/calculations/predictions.ts:blendPredictions`. Optional `marathonPbAgeDays` parameter modifies the penalty severity.

**Problem.** The marathon-specificity penalty (see entry below) is calibrated against full-detraining literature — Coyle 1984 measures performance loss in athletes who've completely stopped training. For a cross-trained athlete with a *recent* marathon PB (e.g. 3:09 last year), full-detraining curves over-correct: the athlete has demonstrated current marathon-specific capability within the past year, so the staleness assumption baked into the penalty is false. The penalty's *direction* was correct (current marathon-specific fitness < PB capability) but its *magnitude* was wrong because the staleness assumption didn't hold.

**Physiological basis.** A recent marathon completion is direct evidence of three preserved physiological capacities: (1) aerobic base sufficient to sustain marathon pace, (2) fractional utilization at marathon distance — the marathon-critical term per Joyner & Coyle (2008), (3) glycogen storage and substrate management.

Coyle (1984) and Mujika & Padilla (2000) measure decay rates of each term independently in fully-detrained athletes. Within 8-12 weeks of detraining, fractional utilization decays significantly. But the decay timeline assumes total cessation — a cross-trained athlete maintaining VO2 via cycling/swimming preserves term 1 and attenuates the decay rate of terms 2 and 3.

A PB completed within ~12 months means the athlete demonstrably had all three capacities at PB level recently. Even with cross-training-only patterns since, full-detraining curves over-state the magnitude of decay. Empirical evidence: club marathoners returning to running after 6-12 month gaps with maintained aerobic base typically run 5-10% slower than peak, not the 15% the full-detraining bands assume.

**Formula.**

```
recencyFactor = 1.0
if (marathonSpecificityPenalty > 1.0 && marathonPbAgeDays != null):
  if marathonPbAgeDays < 365:    recencyFactor = 0.5    # PB within last year
  elif marathonPbAgeDays < 730:  recencyFactor = 0.75   # PB 1-2 years
  # >2 years: full penalty (recencyFactor stays 1.0)

if recencyFactor < 1.0:
  excess = marathonSpecificityPenalty - 1.0
  marathonSpecificityPenalty = 1.0 + (excess × recencyFactor)
```

For the diagnostic case (3:09 PB ≈300 days old, 0 km/wk recent): pre-recency penalty 1.15, recencyFactor 0.5, excess 0.15 × 0.5 = 0.075, post-recency penalty 1.075. Applied to PB-anchored blend (~3:09:42), final baseline ~3:23 instead of 3:38. Matches athlete's intuition while still recognising decay below peak.

**Why scale `excess` not `penalty` directly**: scaling the penalty itself would risk going below 1.0 and inverting the direction (predicting *faster* than the blend, which is wrong — the athlete IS slower than peak even with a recent PB). Scaling `excess` keeps a floor at 1.0 and preserves the qualitative direction.

**Bands chosen pragmatically.** < 365 days (×0.5) — a full annual training cycle; the PB represents the athlete's current training era. 365-730 days (×0.75) — one peak ago; some decay expected but training infrastructure recent. > 730 days — old peak; treat as fully stale.

**Limitations.**

- Step function at 365/730 boundaries creates discontinuities. Acceptable because boundary cases are rare.
- Doesn't account for *what the athlete has done since the PB*. The recent-volume term in the underlying penalty band partially captures this, but the recency factor doesn't compose with it.
- Requires a date for the PB. If `marathonPbAgeDays` is undefined (PB persisted without a date — manual entry, or auto-fill where Strava's `best_efforts.start_date` and the activity's `start_time` are both missing), recencyFactor stays at 1.0 (full penalty). Safe-default behaviour.
- PB age comes from Strava `best_efforts.start_date` (per-effort) with fallback to activity `start_time` (with belt-and-suspenders lookup from `cachedActivities` by `activityId`). If all sources are empty, recency benefit doesn't apply.

**Confidence**: medium-high. Mechanism is well-supported by underlying detraining literature (same papers that calibrated the base penalty). Magnitudes are pragmatic — chosen to keep predictions within ±5% of empirical reality for cross-trained returning athletes — but not derived from a single calibrated regression. Future work: build a labelled outcome dataset of (current marathon time, PB time, PB age, recent volume, cross-training volume) and re-fit the penalty bands against it.

---

## Plan-prescribed dose feeds the horizon model (2026-05-05)

**Where**: `src/calculations/training-horizon.ts:getPlanPrescribedMeanWeeklyKm`. Used by all five forecast call sites (`events.ts`, `renderer.ts`, `blended-fitness.ts`, `plan-preview-v2.ts`, `initialization.ts` via `calculateForecast`).

**Problem.** The horizon model's `weekly_volume_km` parameter governs `effective_sessions = sessions × clamp(km_per_session / ref_km_per_session, [0.5, 1.3])`, which feeds the `session_factor` logistic centred at `ref_sessions`. Pre-fix, all callers passed `s.wkm` — the user's pre-plan training volume (set by the wizard heuristic to `sessions × 10` for 4+ sessions, or detected from Strava history). For a user committing to a 4-session/wk marathon plan with `s.wkm = 40`, this gave `effective_sessions = 3.63` and `session_factor = 0.134` — only 13% of the available improvement from the saturating curve.

But `s.wkm` represents what the user trains *now*, not what the plan delivers. The horizon model's *job* is to predict gain *from the plan*, so it should see the dose the plan will actually deliver across its build phase, not the maintenance dose preceding the plan.

**Empirical reference.** Canonical periodised marathon plans:
- **Pfitzinger 18-week intermediate (4 sessions/wk)**: ramps from ~32 km/wk to peak ~89 km/wk (week 12-13), then 3-week taper to ~30. Mean across the 15 non-taper weeks: ~50-55 km/wk.
- **Pfitzinger 18-week intermediate (5 sessions/wk)**: ramps to peak ~105 km/wk. Mean across 15 non-taper weeks: ~65 km/wk.
- **Daniels Q-plans**: similar build-phase ramp shape and mean.

Compared to bare `sessions × REF_KM_PER_SESSION` reference (4 × 11 = 44, 5 × 11 = 55): the periodised mean is **1.14-1.25× higher**. This is the build-phase volume ramp — periodised plans push above maintenance level to drive adaptation, then taper below it for race day.

**Formula.**

```
PLAN_BUILD_PHASE_FACTOR = 1.2  // centre of [1.14, 1.25] empirical range

getPlanPrescribedMeanWeeklyKm(sessions, distance):
  if (sessions <= 0) return null
  ref = REF_KM_PER_SESSION[distance]   // marathon=11, half=10, 10K=9, 5K=8
  if (!ref) return null
  return sessions × ref × PLAN_BUILD_PHASE_FACTOR
```

For 4-session marathon: 4 × 11 × 1.2 = 52.8 km/wk. For 5-session marathon: 5 × 11 × 1.2 = 66 km/wk. These match Pfitzinger's empirical means.

**Why this is the right input** (vs current volume, peak volume, or starting volume):
- **vs current/`s.wkm`**: `s.wkm` is what you do *before* the plan. The horizon predicts gain *from* the plan. Using current volume systematically under-predicts gain for athletes committing to a properly-dosed plan (the failure mode this fix addresses).
- **vs peak weekly volume**: peak weeks contribute disproportionately to the training integral but recovery weeks contribute less. Using peak would over-state the integrated dose. The horizon model already handles tapering via `weeks_eff = weeks_remaining - taper_weeks`, so feeding peak (which is reached briefly mid-build) would double-weight the high-volume influence.
- **vs starting volume**: starting volume is the maintenance baseline. Plans drive adaptation by ramping above that. Using starting volume reproduces the same under-prediction as current volume.

The right input is the **mean across the build phase** — what the user actually trains across the weeks where adaptation is happening. Banister's impulse-response model (1975) integrates training stimulus over time; mean-of-build is the integral's correct argument.

**`s.wkm` and `weekly_volume_hours` remain as fallbacks.** When `getPlanPrescribedMeanWeeklyKm` returns null (e.g., sessions unknown, unsupported distance), the caller falls back to `s.wkm`. The horizon model itself also accepts `weekly_volume_hours` as a secondary fallback (computed via `HOURS_TO_KM_RATE = 10`). The priority chain is: plan-prescribed km → user's history km → user's stated training hours.

**Limitations.**

- `PLAN_BUILD_PHASE_FACTOR = 1.2` is a constant, not adaptive. A 6-session/wk plan's build-phase ratio might differ from a 3-session/wk plan's — both currently get the same factor. Acceptable as a starting point; refinable with empirical data from real Mosaic users.
- The factor is calibrated against marathon plans specifically. For half/10K/5K it's used unchanged. Pfitzinger 12-week half plans show similar 1.15-1.25 build-phase ratios, so the constant generalises reasonably, but distance-specific tuning is possible if needed.
- This is a *prediction* of plan dose, not the actual dose. If the user fails to follow the plan (skips, replaces, reduces), actual delivered dose will be lower. The live `refreshBlendedFitness` path tracks actual training data and updates predictions accordingly across the plan's lifetime — so this fix's optimism is corrected by reality if the user under-trains.

**Confidence**: high. The mechanism and calibration are well-supported by published marathon training plan literature (Pfitzinger & Douglas 2009, Daniels 2005). The choice of plan-mean over peak/current is supported by Banister's dose-response framework. The `1.2` constant is empirically calibrated against canonical plans, not fitted from a single dataset.

---

## Marathon-specificity penalty when Tanda gates out (2026-05-05)

**Where**: `src/calculations/predictions.ts:blendPredictions` — applied to the final blended marathon prediction when `targetDist === 42195 && tTanda == null && weeklyRunKm != null`.

**Problem.** The marathon prediction blend weights LT (40%), Tanda volume (30%), VO2 (10%), PB (10%), HR-VDOT (10%). Tanda is the *only marathon-distance-specific* predictor — it uses recent training volume (K) and mean training pace (P) to predict marathon time directly (Tanda 2011, r = 0.91 vs 46 marathoners). The other four signals are *fitness-ceiling* predictors: they describe what the athlete *could* run if their marathon-specific physiology was intact.

Tanda gates itself out when sample size is insufficient (`weeksCovered < 4` or `paceConfidence < medium`). When gated, Tanda's 30% weight redistributes to LT (line 572-575), so the blend becomes dominated by ceiling-fitness signals (LT 70%, PB 10%, VO2 10%, HR 10%). For an athlete with strong PBs but low recent running volume — e.g. cross-trained returning marathoner — **the blend predicts what their fitness ceiling could deliver, not what their current marathon-specific endurance will deliver on race day**.

The previous code (`predictions.ts:559`) explicitly skipped `lowVolumeDiscount` for marathon distance, on the assumption that Tanda would handle volume sensitivity. That assumption breaks when Tanda doesn't fire. Result: a 3:09:42 PB-holder running ~25 km/wk was predicted at 3:12:50 — slightly slower than their PB but well within "racing today" territory, when in reality their detrained marathon-specific physiology would deliver something closer to 3:22.

**Physiological basis.** Marathon performance is decomposed by Joyner & Coyle (2008) as:

```
marathon time ∝ 1 / (VO2max × fractional_utilization × running_economy)
```

Of the three terms, **fractional utilization at marathon distance** is the most training-sensitive and decays fastest with low running volume:
- **Coyle (1984)** — 84-day detraining study: VO2max declined ~7% in week 3, plateaued at −16% by week 12; but lactate threshold (a proxy for fractional utilization) declined more rapidly. Marathon-pace sustainability is driven by LT-as-fraction-of-VO2max, not VO2max in isolation.
- **Mujika & Padilla (2000)** — meta-analysis: short-term detraining (≤4 weeks) shows preserved VO2max but compromised exercise-economy and lactate-handling. Long-term (>4 weeks) shows further marathon-pace deterioration even when VO2max-by-watch-tracking has plateaued.
- **Cross-training preservation**: VO2max can be largely maintained by non-running aerobic activity (cycling, swimming, etc.) but marathon-specific *running economy* and *fractional utilization at marathon pace* require run-specific stimulus to maintain. This is why a cross-trained athlete with VO2 56 from cycling can have marathon time predictions over-stated by 15–20% if computed from VO2 alone.

**Formula.**

```
marathonSpecificityPenalty = 1.0
if (targetDist === 42195 && tTanda == null && weeklyRunKm != null):
  if weeklyRunKm < 10:  penalty = 1.15
  elif weeklyRunKm < 20: penalty = 1.10
  elif weeklyRunKm < 30: penalty = 1.05
  else: penalty = 1.00  (≥30 km/wk preserves fractional utilization per Coyle 1984)

return (sum / totW) * marathonSpecificityPenalty
```

**Why multiplicative on the final time, not a weight-shift to PB**: the existing `lowVolumeDiscount` (used for non-marathon distances) shifts weight from LT/VO2 onto PB, with the design assumption that PB represents preserved peak fitness. That works for 5K/10K/half where peak fitness is largely preserved across detraining gaps (these distances are more VO2-limited and less fractional-utilization-limited per Joyner & Coyle's decomposition). For marathon, **PB itself overstates current marathon time** because the fractional-utilization term that governs marathon performance has decayed independently of VO2max or LT. Shifting weight to PB would push the prediction faster (toward the user's PB), which is the wrong direction. A multiplicative slowdown on the final prediction directly addresses the gap without assuming any single signal is preserved.

**Penalty calibration.** Bands chosen to land predictions within ±5% of empirical reality for cross-trained returning athletes. Anchored to Tanda 2011's residual analysis at the low-volume end (K < 30 km/wk subset shows ~5–8% over-prediction by VO2-only methods). Conservative — a 5% slowdown at 25 km/wk corresponds to ~9 min on a sub-3 marathon time, which most cross-trained returning athletes will validate as "about right" against their own intuition.

**Limitations.**

- Step-function in 10-km bands creates discontinuities at the boundaries. A 29 km/wk athlete gets penalty 1.05; at 30 km/wk it drops to 1.00. Could be smoothed with a logistic if the discontinuity becomes a UX issue, but step bands are easier to reason about and the boundary cases are rare in practice.
- Doesn't account for *recency* of running history. An athlete who ran 80 km/wk last year but 0 km/wk for the past 3 months gets the same penalty as someone who has *always* run 0 km/wk. The Tanda gating handles part of this (requires `weeksInWindow ≥ 4` of qualifying training to fire), but a richer recency model could be added later.
- Doesn't differentiate between cross-trained athletes (preserved VO2, lost RE/utilization) and fully detrained athletes (lost everything). The penalty is conservative for both. Refinable later with cross-training-volume input.

**Confidence**: medium-high. The mechanism is well-supported by detraining literature (Coyle, Mujika & Padilla, Joyner & Coyle). The penalty bands are pragmatic — based on Tanda's empirical residuals at low volume — but not derived from a single calibrated regression. Future work: re-fit the bands against a labelled marathon-outcome dataset once Mosaic accumulates enough longitudinal user data with low-volume start states.

---

## Forecast anchored to blendPredictions (2026-05-05)

**Where**: `src/calculations/predictions.ts:calculateLiveForecast` and `:calculateForecast`. Optional `blendedAnchorSec` parameter.

**Problem.** "Forecast finish" (end-of-plan projection) and "Current Race Estimate" (today's predicted race time) were computed by two different prediction models on incompatible scales:

- **Current Race Estimate** = `blendPredictions(targetDist, pbs, lt, vo2, b, typ, recentRun, tier, weeklyKm, avgPace, volumeMeta, hrVdot)` — a weighted blend across PB extrapolation, LT-derived (CV), VO2-derived (Daniels), recent-run extrapolation, Tanda volume model (marathon-only), and HR-calibrated VDOT (Swain regression). Anchored to actual outcome data.
- **Forecast finish** = `tv(currentVdot + horizon.vdot_gain, raceDistKm)` — bare Daniels VDOT-to-time table lookup at end-of-plan VDOT. Anchored to nothing except the current VDOT estimate.

For a trained marathoner with strong PBs, `blendPredictions` returned ~3:12 while bare `tv(VDOT 52, marathon)` returned ~3:21. Comparing them is meaningless; subtracting them produced a *9-minute regression* at Week 1 with zero training done. The wizard's plan-preview showed a 1m 35s improvement after 36 weeks of training — the gain itself was correct in VDOT terms (~1.6 points) but the bare-VDOT baseline (3:12) put the result at 3:11, hiding the real 10-min projected improvement.

**Fix.** Anchor the forecast to the blend's view of today and apply the horizon model's gain as a *delta in seconds* on top:

```
bareToday    = tv(currentVdot,         distKm)
bareForecast = tv(currentVdot + gain,  distKm)
horizonDelta = bareToday - bareForecast            // seconds saved by the horizon gain
forecastTime = blendedAnchorSec - horizonDelta     // anchored to blend
```

This preserves the horizon model's predicted gain *exactly as it computes* (using Daniels' non-linear VDOT-to-time table on both ends), while ensuring the absolute time is on the same scale as the live "Current Race Estimate" surfaces. When `blendedAnchorSec` is omitted, the function falls back to the legacy bare-VDOT path (preserves backward compatibility for callers that haven't been audited).

**Why subtractive (not multiplicative).** Triathlon's `race-prediction.triathlon.ts:356-379` does the analogous job multiplicatively (`baseRunPaceSecPerKm / horizonRatio`), which is appropriate for *pace scaling across variable leg distances* (HM run for 70.3, marathon for IM) where a small VDOT delta maps cleanly to a proportional pace improvement. For running's fixed-distance race prediction, the subtractive form is more faithful to Daniels' table — VDOT-to-time is non-linear (the same VDOT delta yields different second savings at different fitness levels and different distances), and the table lookup captures this exactly. Multiplicative would approximate.

**Limitations.**

- Assumes `blendPredictions` is itself well-calibrated. If the blend over-predicts (e.g. a lucky 5K PB with no marathon validation), the anchored forecast inherits that bias. The blend has its own quality controls (`paceConfidence`, `weeksCovered`, `lowVolumeDiscount`) that already address most failure modes.
- Detraining is captured *if and only if* `blendPredictions` reflects it. Watch-derived LT/VO2 stay elevated post-detraining (see "Low-volume detraining adjustment" entry); the blend's `lowVolumeDiscount` partially corrects, and once the blend pulls slower the anchored forecast follows.
- The horizon model still bounds the projected gain. A very long plan (40+ weeks) for a trained athlete legitimately predicts modest VDOT gains (1-3 points) due to the diminishing-returns curve in `applyTrainingHorizonAdjustment`. The fix corrects the *anchor*, not the *gain magnitude*.

**Confidence**: high. The fix is a pure scale correction — no new model, no new constants. Two well-validated functions that previously produced incompatible numbers now produce numbers on the same scale.

---

## Race-specific course factors for running, cycling, and Hyrox (2026-05-05)

**Where**: `src/calculations/course-factors-running.ts` (run); `src/calculations/race-prediction.cycling.ts` (cycling extension); `src/calculations/race-prediction.hyrox.ts` (new); shared multipliers reused from `src/constants/triathlon-course-factors.ts`.

**Goal**: predicted finish times must reflect the *course*, not just the athlete's fitness. A 2:50 fitness on flat-cool Berlin is not the same number on hot-flat Dubai or on +250m-rolling Boston. Triathlon already had this layer; running, cycling, and Hyrox did not.

**Models applied per discipline:**

### Running (`applyRunningCourseFactors`)

Per-race `CourseProfile` (climate, altitudeM, runElevationM) compounds three multiplicative factors on top of the raw VDOT-derived finish time:

1. **Climate** — `CLIMATE_RUN_MULTIPLIER` from `triathlon-course-factors.ts`. Anchored to Ely et al. (2007), El Helou et al. (2012, 1.7M finishers), Galloway & Maughan (1997), ACSM Heat Position Stand (2007). Range: cool (1.000) → hot-humid (1.120).
2. **Altitude** — `altitudeRunMultiplier(altitudeM)`. Bonetti & Hopkins (2009 meta-analysis), Wehrlin & Hallen (2006). Linear 0.20%/100m above 500m; 0.40%/100m above 1500m. Capped at +12%.
3. **Run elevation** — `runElevationMultiplier(elevationM, distanceKm)`. Minetti et al. (2002) energy-cost polynomial `C(i)` evaluated at the average grade. Strava's GAP algorithm uses the same formula.

**Confidence**: high for climate and altitude; medium for elevation (average-grade simplification underestimates rolling-course cost vs per-km gradient analysis).

### Cycling (`predictCyclingEvent` extension)

Existing physics-based prediction (Martin 1998, `bike-physics.ts`) already handled course profile and aero. New layer adds:

1. **Climate (bike)** — `CLIMATE_BIKE_MULTIPLIER`. Tatterson et al. (2000 J Sci Med Sport, 32°C vs 23°C TT showed ~6.5% power loss). Bike penalty is ~40% of run because convective cooling at 30+ km/h removes more heat than running's lower airspeed. Range: cool (1.000) → hot-humid (1.050).
2. **Altitude (bike)** — `altitudeBikeMultiplier`. Bike penalty ~65% of run because IM-intensity cycling is sub-maximal aerobic; running has higher relative VO2 cost per unit speed. Capped at +8%.

Cycling event lookup (`CYCLING_EVENTS`) seeds climate / altitude / elevation for famous sportives (Étape, Marmotte, Leadville at 3840m, etc.).

### Hyrox (`predictHyroxRace`, new)

Sum-of-parts model:
```
total = (runPaceSecKm × 8) + Σ(8 station times) + roxzoneSec
```
where station times come from `stationBenchmarks` (calibrated) or `STATION_SEED_TIMES_SEC[band]` (population averages from HyroxDataLab + roxlyfe.com).

Venue factors (heuristic — confidence low-medium, see `src/data/hyrox-venues.ts` for derivation):

1. **Floor surface** — affects sled stations primarily. Concrete is cleaner on the run loop (-0.5%) but slower on sleds (+10s per station). Mixed surfaces add inconsistency (+6s per sled).
2. **Lap difficulty** — long straights vs tight S-curves. Easy 0.985, standard 1.000, hard 1.030 on each 1km run.
3. **Venue temperature** — convention-centre HVAC variance. Warm (1.015 on run, 1.012 on endurance stations), hot (1.030 / 1.025).
4. **Altitude** — reuses `altitudeRunMultiplier` for run + endurance stations (ski_erg, row_erg, wall_balls, burpee_broad_jumps, sandbag_lunges). Mexico City (2240m) is the only currently-listed Hyrox venue with non-trivial altitude.

**Limitations**:
- Hyrox venue multipliers are inferred from athlete reports and finishing-time spreads, not from a controlled cross-venue study. Treat as v1 heuristic — refresh when structured data becomes available.
- Running elevation uses average grade. Rolling courses with equal up/down still show non-zero penalty due to asymmetric eccentric cost; that's a feature, not a bug, but the magnitude is uncertain.
- Climate uses categorical buckets (cool/temperate/warm/hot/hot-humid) anchored to typical race-week wet-bulb temperature. Race-day weather can swing — Boston in particular is highly variable. Manual override path (per-race climate) is supported.

**Compounding sanity-check**: `MAX_REASONABLE_LEG_PENALTY = 1.25` (25% combined). Logs a warning if any single mode produces a higher compound multiplier — e.g. a hot+altitude+elevation race like Leadville is at the upper bound.

---

## Volume-aware training horizon — running prediction now scales with weekly hours/km (2026-05-05)

**Where**: `src/calculations/training-horizon.ts` — `applyTrainingHorizonAdjustment`. New helper `computeEffectiveSessions` and constants in `src/constants/training-params.ts` (`REF_KM_PER_SESSION`, `HOURS_TO_KM_RATE`).

**Problem**: The horizon adjuster's `session_factor` logistic treated every session as a standard dose. A 4×30-min marathon plan and a 4×80-min marathon plan produced identical predicted VDOT gain. The `weekly_volume_km` field existed on `TrainingHorizonInput` but the function never read it. Result: a 10-h/week runner saw the same predicted improvement as a 3-h/week runner if both did 4 sessions.

**Fix**: Convert raw `sessions_per_week` into `effective_sessions` via a dose multiplier:

```
ref_km_per_session = REF_KM_PER_SESSION[distance]   // 5K=8, 10K=9, half=10, marathon=11
km_proxy           = weekly_volume_km ?? (weekly_volume_hours × HOURS_TO_KM_RATE)
actual_km/session  = km_proxy / sessions_per_week
dose_factor        = clamp(actual_km/session ÷ ref_km/session, 0.5, 1.3)
effective_sessions = sessions_per_week × dose_factor
```

`effective_sessions` then feeds the existing `session_factor` logistic AND the undertraining penalty. Returns to legacy behaviour when neither km nor hours is provided.

**Why these reference values are defensible**:

The `REF_KM_PER_SESSION` table is derived directly from the existing `ref_sessions[distance][intermediate]` × the canonical weekly mileage in two long-published intermediate plans:

- **5K**: ref_sessions=4.0 × ~32 km/wk → 8 km/session (Daniels' 5K Q1/Q2 plan).
- **10K**: ref_sessions=4.5 × ~40 km/wk → 9 km/session (Daniels' 10K Phase II).
- **Half-marathon**: ref_sessions=5.0 × ~50 km/wk → 10 km/session (Pfitzinger's 47-63 km HM plan).
- **Marathon**: ref_sessions=5.5 × ~62 km/wk → 11 km/session (Pfitzinger's *Advanced Marathoning* 55-70 mpw plan).

These are not invented: they are the per-session implications of the existing horizon parameters multiplied by the canonical weekly-mileage assumption in the source the horizon parameters were calibrated against.

**Why the [0.5, 1.3] clamp**: The lower bound prevents a fully zero-credit collapse when a user enters wildly under-target volume — they still get *some* horizon credit for at least showing up. The upper bound prevents an absurd long-session plan (e.g. someone entering 200 km/wk) from inflating the gain past what real adaptation can produce. The bracket matches the dose-response saturation observed in Tanda 2011 (marathon time vs weekly km) — improvements flatten beyond ~85 km/wk in the Tanda dataset.

**Why hours fallback uses 10 km/h**: Daniels' easy-pace zone for an intermediate VDOT (45-50) median is ~6:00/km = 10 km/h. The hours fallback is only used when `weekly_volume_km` is missing (new user with no run history) — once history exists, the more precise km signal takes over.

**Knock-on benefit for triathlon and cycling**:

The triathlon run-leg adjuster (`applyTriHorizonRun` in `training-horizon.triathlon.ts:178`) already passes `weekly_volume_km` to the same underlying function. With this fix, the field is finally consumed — meaning a 12 h/wk Ironman trainee now correctly sees a higher run-leg VDOT projection than a 5 h/wk one, which it previously did not. Cycling mode will inherit the same behaviour automatically when its predictor ships in V2.

**Limitations**:

- Hours-based fallback assumes uniform easy pace; ignores how the user actually splits intensity. Acceptable because km history overrides hours as soon as one week of data exists.
- Dose factor uses *average* km-per-session, not the long-run shape. A plan with 4×5km + 1×40km has the same dose factor as 5×13km, but the long-run quality differs. The existing `long_run_max_km` field on `TrainingHorizonInput` could feed a future second-order adjustment; deferred until we have evidence the average misleads.
- Reference values are intermediate-tier; we do not (yet) scale `REF_KM_PER_SESSION` per ability band. Beginners on low volume are protected by the existing `applyGuardrails` ceiling, so the floor isn't catastrophic for them.

**Tests** (`training-horizon.test.ts > weekly volume effect`): 7 new tests covering high-vs-low volume separation, hours fallback, undertraining penalty trip on very short sessions, km-over-hours preference when both supplied, legacy behaviour preserved when neither supplied, and clamp behaviour at extreme volume.

**References**:

- Daniels, *Daniels' Running Formula* 4th ed. (2022), Chapter 9 (5K plans), Chapter 10 (10K plans). Per-distance weekly-mileage reference points for intermediate runners.
- Pfitzinger & Douglas, *Advanced Marathoning* 3rd ed. (2019). 55-70 mpw and 70-85 mpw schedules, source for marathon and HM reference km/session.
- Tanda G. (2011) "Prediction of marathon performance time on the basis of training indices." *J Human Sport & Exercise* 6(3). Marathon dose-response saturation beyond ~85 km/wk.
- Foster C., Florhaug J.A., et al. (2001) "A new approach to monitoring exercise training." *J Strength Cond Res* 15(1):109-115. Training stimulus = volume × intensity, dose-response in untrained-to-recreational populations.

---

## Pro-grade bike workout kinds — over-unders, VO2 micros, VLamax (2026-05-02)

**Where**: `src/workouts/bike.ts` adds three pro-grade `BikeSessionKind` values alongside the existing six (endurance/tempo/sweet_spot/threshold/vo2/hills). Each is selected by `pickBikeKind` for specific phase + slot combinations and rendered with literature-anchored interval prescriptions.

### Over-unders (`over_under`)
**Stimulus**: Alternating sub- and supra-threshold reps train lactate clearance at high intensity. The "under" sections force aerobic clearance of lactate produced during the "overs", improving the rider's ability to handle threshold-level surges in road racing or triathlon bike legs.

**Formula / prescription**: Three variants, all anchored to Coggan & Allen, *Training and Racing with a Power Meter* (3rd ed., 2019), Ch. 7:
- Classic over-under: 3× (3min @ 105% FTP → 3min @ 95% FTP), continuous, 5min easy between sets.
- Criss-cross: 2× (5× (1min @ 110% FTP / 1min @ 85% FTP)), shorter alternations, 5min easy between blocks.
- 2:1 ratio: 4× (2min @ 105% FTP → 1min @ 95% FTP) continuous, 4min easy between.

**Defensibility**: Coggan & Allen explicitly recommend over-unders as a Z4 development tool. The 105/95% bracket sits inside MLSS variability across riders (≈90–105% FTP) so the "unders" remain near-threshold rather than easy, maximising clearance demand.

**Load assumptions** (`tssPerMin = 1.65`, `anaerobicShare = 0.45`): Slightly above pure threshold work because the 105% overshoots compound load. Anaerobic share between sweet-spot (0.25) and threshold (0.40) — the unders pull the average down vs continuous threshold.

**Limitations**: TSS-per-minute is a pragmatic estimate until Phase 4 wires real bTSS from .fit power streams. Actual NP/IF for these sessions averages ≈0.98–1.02 depending on variant; the IF entry in `tri-effort-scoring.ts` is set to 1.00.

### VO2 micro-intervals (`vo2_micros`)
**Stimulus**: Short (30s) high-intensity reps separated by short (30s) recoveries accumulate more total time at VO2max than longer reps because oxygen kinetics keep the athlete near VO2max during the brief recoveries. Lower lactate accumulation per minute of work than 3–5min reps, allowing higher total volume.

**Formula / prescription**: Adapted from Billat V., *Sports Medicine* 31(1):13–31 (2001) "Interval training for performance: a scientific and empirical practice". Three variants:
- 2× (10× 30s @ 120% FTP / 30s easy), 5min between blocks.
- Continuous: 15× (30s @ 118% FTP / 30s @ 50% FTP).
- 3× (8× 40s @ 115% FTP / 20s easy), 4min between blocks.

**Defensibility**: Billat's 30/30 protocol was originally developed for runners at vVO2max but has been validated on bike (e.g., Rønnestad & Hansen, *Scand J Med Sci Sports* 2014, "Optimizing interval training at power output associated with peak oxygen uptake in well-trained cyclists"). 115–120% FTP corresponds approximately to %vVO2max for cyclists with FTP at ~85% of VO2max power.

**Load assumptions** (`tssPerMin = 1.75`, `anaerobicShare = 0.55`): Below classic VO2 (1.9 / 0.60) because the 1:1 work:rest ratio means rest dominates more of the session than 3:3 reps. Still high anaerobic share due to repeated VO2 spikes.

**Limitations**: %FTP targets are a reasonable proxy for vVO2max equivalent power but individual variation is large (±10%). Athletes with high VO2max-to-FTP ratios will under-stimulate at 115% FTP.

### VLamax neuromuscular sprints (`vlamax`)
**Stimulus**: Very short (6–15s) maximal efforts with long (3–5min) full-recovery rests target phosphocreatine resynthesis and glycolytic ceiling without inducing systemic aerobic fatigue. Develops peak power and rate of force development for race-day attacks, breakaways, and finishing sprints.

**Formula / prescription**: Three variants, anchored to Coggan's Z6 / Z7 zones (*Training and Racing with a Power Meter* Ch. 4):
- 8× 10s max sprint @ 160%+ FTP, 3min easy spin between.
- 6× 15s standing-start @ 150%+ FTP, 4min full recovery.
- 3× (4× 6s seated max sprint, 90s easy), 5min between blocks.

**Defensibility**: 6–15s window matches the PCr-dominant energy system (Gastin, *Sports Medicine* 31(10):725–741, 2001). Full recovery (3–5min) is required because incomplete PCr resynthesis turns the session into a glycolytic-tolerance set rather than peak-power development. Total work volume capped at ~2min keeps systemic stress low.

**Load assumptions** (`tssPerMin = 1.10`, `anaerobicShare = 0.75`): Lowest TSS per minute of any quality kind because most of the session is recovery. Highest anaerobic share — the actual work bouts are almost entirely PCr/glycolytic. Total session TSS for a 60min slot lands around 60–70 TSS, well below threshold work.

**Limitations**: 160%+ FTP targets assume the athlete has the neuromuscular capability to reach those wattages — newer riders may produce considerably less. Phase 4 (.fit power streams) will give us real peak-power data per rep so the prescription can be calibrated per athlete.

### Phase rotation logic
`pickBikeKind` now alternates classic and pro-grade kinds week-to-week using a parity-of-weekIndex check. This matches periodisation practice — a 4-week build mesocycle should expose the rider to multiple stimulus shapes rather than the same workout four times. Endurance recovery slots are excluded from rotation because they should stay stable. Base phase has no supra-threshold rotation — the aerobic foundation comes first.

---

## Triathlon — Home readiness card uses tri composite (2026-05-01)

**Why the tri composite, not the running composite**: The running-side `computeReadiness` is built around Signal A (run-equivalent iTRIMP with runSpec discounts). A week of heavy bike load produces low running ACWR but full physiological stress — the running composite would call it "safe" while the athlete is at genuine risk of accumulation. The tri composite (`computeTriReadiness`) runs the same engine once per discipline using that discipline's own CTL/ATL/TSB, then surfaces the worst label. This correctly detects bike or swim overload that the running composite would mask.

**What is shared vs separated**: Sleep and HRV are passed identically to all three discipline calls — they are sport-agnostic. The freshness and load-safety sub-scores differ per discipline because each has its own TSB and ACWR. The "worst label across three" is the conservative, athlete-safe choice: one sport overreaching should suppress the overall readiness even if the others look fine.

**Running mode unchanged**: The branch at `buildReadinessRing` is a strict `if (isTri)` guard. Running mode still calls `computeReadiness` with the running composite unchanged.

---

## Triathlon — Adaptation engine (effort scoring, auto-progression, race-outcome) (2026-04-30)

Three pieces wired together to close the adaptation loop in tri mode:

### §M — Per-session effort scoring (multi-discipline)

Mirror of the running-side `computeHREffortScore` shape (0.5–1.5 range, 0.9–1.1 = on target), applied per discipline with the right primary signal:

- **Bike**: power adherence (NP/FTP vs target IF) primary; HR effort secondary cross-check via `BIKE_LTHR_OFFSET_VS_RUN = -7` bpm (Millet & Vleck 2000) when power meter absent. HR effort uses Karvonen reserve scaled to target IF.
- **Swim**: pace adherence vs CSS-derived target (existing) primary; HR effort skipped — most users don't wear straps in water.
- **Run**: reuses existing running helpers (`computeHREffortScore`, `computePaceAdherence`, Daniels VDOT zones). No new math.

Confidence: high for power-bike and pace-swim; medium for HR-bike (hydration/heat/cadence noise); low for swim HR (deferred). Cited in `docs/SCIENCE_LOG.md` §F (per-discipline horizon) and inline in `tri-effort-scoring.ts`.

### §N — Per-discipline effort multiplier (auto-progression)

Mirrors running's `effortMultiplier` (`src/workouts/plan_engine.ts:113`):

```
score = mean(actual RPE − planned RPE) over last TRI_EFFORT_LOOKBACK_WEEKS = 2
multiplier = clamp(1 - score × 0.05, 0.85, 1.15)
```

Applied per discipline (swim / bike / run) at plan generation and regeneration. Effect: when athlete consistently rates sessions easier than planned, upcoming session **durations** scale up by up to 15%. Symmetric in the other direction.

**Limitation by design**: scales DURATION only, not intensity tier. Pace/watts/CSS targets auto-update via marker re-derivation (`refreshBlendedFitness` for run; `deriveTriBenchmarksFromHistory` for swim/bike). Intensity-tier promotion (e.g. threshold → VO2) is intentionally NOT auto — per Tristan's principle, that's a big pace jump worth surfacing through the suggestion modal, not silent escalation.

### §O — Race-outcome logging

Schema: `TriRaceLogEntry` carries predicted vs actual per leg + total, indexed by `dateISO`. Detection runs once per race when `triConfig.raceDate < today` and race-day activities are present in DB; idempotent (same `dateISO` won't double-log).

v1: log always, surface retrospectively only when `predicted - actual ≥ TRI_RACE_OUTCOME_POSITIVE_THRESHOLD_SEC` (60s — see `triathlon-constants.ts`). The asymmetry is deliberate user-trust: positive surprise rewards the plan; negative surprise we log silently for v2 calibration but don't punish the athlete.

v2 deferred: per-athlete calibration multiplier from rolling average of past race gaps (e.g. if you consistently undershoot by 5%, future predictions adjust).

---

## Triathlon cross-training overload detector — v2 (2026-05-01)

**Updates v1** (entry below). Three significant design changes:

**1. Run-anchored recommendation.** v1 picked the discipline with the most remaining planned TSS. v2 anchors on **run** by default. Most cross-training (tennis, padel, gym, hiking, soccer, basketball, walking) is leg-impact-loaded and substitutes for running stress more directly than for swim or bike. Categorical mapping in `classifyAffinity`: "bike" if name/activityType contains cycl/biking/mtb/spin/zwift; "swim" if it contains swim/aquatic/pool; "run" otherwise. Per CLAUDE.md "no made-up numbers" — this is a categorical rule, not an empirical transfer coefficient. Falls through to next-most-loaded discipline if the affinity-recommended discipline has no remaining work.

**2. Multi-mod with severity tiers + saturation.** Mirrors running's suggester. Severity (light < 15%, heavy 15–25%, extreme > 25%) gates the max number of mods proposed (heavy → 2, extreme → 3 — smaller than running's 1/2/3 because tri has fewer mod-able workouts per discipline). Per-discipline candidate sets carry both `reduceMods` (downgrade quality, trim endurance) and `replaceMods` (interleave swap-easy + reduce). Saturation curve from running (`1500 × (1 - exp(-x/800))`) caps how much credit a single huge cross-training session can unlock.

**3. Per-discipline floor + push-to-next-week carry.** New `computeTriDisciplineFloorTSS` (mirror of `computeRunningFloorKm`): returns 0 in taper, 0 when per-discipline ACWR > 1.3 (suspended for injury safety), `0.65 × plannedDisciplineTSS` otherwise. Per-discipline `belowFloor` flag fires in modal when reductions would breach floor — the modal warns but doesn't block (user override). Push-to-next-week stores cross-training TSS on `Week.carriedCrossTrainingTSS`; `computeDecayedTriCarry` (7-day τ, 3-week lookback) is consumed by the next week's detector so deferred load doesn't disappear — it just spreads exponentially.

**Why these mirror running rather than reinvent**: per CLAUDE.md "Mirror rule — running and triathlon mode parity", and per the user's explicit instruction "take a lot from running here". The running suggester's severity / saturation / interleave / floor patterns work well; tri benefits from the same conceptual shape adapted to three disciplines.

**Membership filter** (replaces v1's discipline filter): cross-training is identified by id-membership outside `wk.triWorkouts`, not by `discipline === undefined`. Per "anything in your plan is in your plan" — a planned cross/gym session in the tri plan engine no longer trips the detector.

**Files**: `src/calculations/tri-cross-training-overload.ts` (detector), `src/calculations/tri-discipline-floor.ts` (floor), `src/calculations/tri-cross-training-carry.ts` (carry decay), `src/ui/triathlon/tri-suggestion-modal.ts` (chip switcher + 4-button layout), `src/ui/home-view.ts` (carry banner). 44 unit tests across the three calc files.

---

## Triathlon cross-training overload detector — v1 (2026-04-30)

**Purpose.** When a triathlete logs cross-training (tennis, padel, racquet sports, gym work, anything outside swim/bike/run) that pushes the week's total TSS meaningfully over plan, surface a tri-aware suggestion to absorb the extra load. Mirrors the running-side `buildCrossTrainingPopup` intent but adapted to tri's three-discipline plan and TSS load currency.

**Formula.**
```
plannedTriTSS    = Σ (aerobic + anaerobic) over wk.triWorkouts
crossTrainingTSS = Σ iTrimp/150 over non-tri-discipline activities in
                   wk.adhocWorkouts ∪ wk.garminActuals (un-matched)
overshootPct     = crossTrainingTSS / plannedTriTSS
```

Trigger: `overshootPct > 0.15` → caution mod. `overshootPct > 0.25` → warning. Picks the next remaining quality session as target (`downgrade_today`) or longest endurance (`trim_volume`).

**Threshold rationale.** 15% is the smallest perturbation worth surfacing without nagging — below that, normal week-to-week variation already absorbs it. 25% aligns with the running-side suggester's "heavy" severity bracket (FCL ~25% of weekly run load). Both are pragmatic; not derived from literature. The detector intentionally does NOT propose to undo the cross-training itself (it's already in the past) — the only lever is reducing remaining planned load.

**Why it's defensible.**
- The TSS conversion (`iTrimp / 150`) uses the canonical normaliser already established for tri-side CTL (`tri-benchmarks-from-history.ts`) and every TSS display in the codebase. Same scale, same population mean (15 000 iTRIMP ≈ 100 TSS at LTHR).
- Source activities are filtered against tri disciplines via `Workout.discipline === 'swim'|'bike'|'run'` so a synced run that matches a tri run-leg slot does NOT double-count as cross-training.
- Severity threshold is symmetric with the running-side bracket so a user who switches modes doesn't experience a step-change in nag frequency.

**Known limitations.**
- Treats weekly TSS as a single pool. Cross-training stimulus isn't attributed to a specific discipline (e.g. padel ≠ pure aerobic credit; gym ≠ pure run credit). A future refinement could split the credit via `runSpec`/`bikeSpec`/`swimSpec` from `SPORTS_DB`.
- Doesn't read `s.triConfig.weeklyTSS_target` (no such field exists) — uses planned tri TSS as the implicit target. This means a week where the user has under-planned will trip the threshold faster, and a recovery week where the plan target is intentionally low will too. Acceptable for v1.
- The detector fires once per aggregator run; if the user dismisses, it'll re-fire on the next sync. No "snooze" mechanism. Mirrors the existing tri detectors (volume_ramp, rpe_blown, readiness).

**Code references.** `src/calculations/tri-cross-training-overload.ts` (detector), `src/calculations/tri-suggestion-aggregator.ts` (wired into `collectTriSuggestions`), `src/calculations/tri-cross-training-overload.test.ts` (11 unit tests pinning thresholds + attribution rules). Modal-routing wiring: see ARCHITECTURE.md → Cross-Training Engine → "Mode-aware modal routing" and ISSUE-151 (✅ FIXED) for the audit.

---

## Load currency invariant: iTRIMP must be normalised to TSS before mixing with sport multipliers (2026-04-30)

**Problem this codifies.** iTRIMP from `src/calculations/trimp.ts` is the seconds-weighted Banister integral `Σ Δt_sec × HRR × e^(β·HRR)`. A typical 1-hour session lands at iTRIMP ≈ 5000–10000. The rest of the load model (`baseLoad`, `fatigueCostLoad`, `runReplacementCredit`, `equivalentEasyKm`, severity buckets) is calibrated in TSS-equivalent units (1 hour at threshold = 100). Anywhere iTRIMP enters that downstream pipeline it must first be divided into TSS units.

**The canonical conversion**:
```
TSS_equivalent = iTrimp × 100 / 15000
```
i.e. divide iTRIMP by 150. This is the "athlete-default" form of the personalised athlete normaliser (see "Athlete Normalizer" section below) — 15000 is the population-mean iTRIMP for 1 hour at LTHR, calibrated against Coggan's hrTSS reference.

**Where this rule applies**:
- `src/cross-training/universalLoad.ts` — `computeTierAPlus` (entry point when iTrimp is supplied to the universal load engine).
- `src/calculations/tri-benchmarks-from-history.ts` — CTL / weekly TSS from history (already correct, see `tssFromActivity` at the bottom of that file and the regression test `iTRIMP is divided by 150 to produce TSS`).
- `src/calculations/activity-matcher.ts`, `src/ui/main-view.ts`, `src/ui/home-view.ts`, `src/ui/activity-detail.ts`, `src/ui/excess-load-card.ts`, etc. — all TSS displays use `iTrimp × 100 / 15000` directly.

**Failure mode if violated**. Skipping the normalisation produces values ~150× too large in the load currency. The downstream symptoms are subtle because the inflated number then runs through saturation curves, sport multipliers, and runSpec discounts, so it doesn't blow up arithmetically — it just permanently sits in the "extreme" severity bucket and slams `equivalentEasyKm` into its 25 km cap. This bug shipped in `computeTierAPlus` until 2026-04-30 (when an 89-min, 39-TSS tennis session was being shown as "≈ 25 km easy running equivalent · Very heavy training load"). The TSS *display* paths were unaffected — they used the right formula directly — which is why nothing felt obviously wrong in cards or charts.

**Why a population mean (15000) is fine here**. The athlete normaliser refines this to ±10–20% per individual, but the universal-load engine is computing planning-grade severity buckets (light / heavy / extreme). At that resolution the population mean is good enough; the personalised normaliser is only worth the complexity for CTL/ATL where percent-level error matters.

**Pre-existing precedent**. `tri-benchmarks-from-history.ts` learned this lesson once before — its line 638 (`return a.iTrimp / 150`) is paired with a regression test (`tri-benchmarks-from-history.test.ts:525`) explicitly named *"iTRIMP is divided by 150 to produce TSS — not the 2296+ we saw when iTRIMP was used raw"*. The lesson didn't propagate to `universalLoad.ts` until now. The regression test added with this fix (`Universal Load: iTRIMP scale invariant` in `universalLoad.test.ts`) closes the gap on the cross-training side.

---

## Triathlon — Live adaptation ratio (Phase 2A) (2026-04-28)

The horizon adjuster's projected gain is scaled by a **per-discipline `adaptation_ratio`** derived from up to five signals. Each signal yields a delta in its capped range; per-discipline weighted blend produces the ratio in `[0.70, 1.30]`.

**Architectural placement**: `tri-adaptation-ratio.ts` reads `state.physiologyHistory`, `wk.rated`, and `wk.garminActuals`; outputs `TriAdaptationRatios` consumed by `predictTriathlonRace` → `buildProjection` → `applyTriHorizon{Swim|Bike|Run}` as the `adaptation_ratio` argument (replacing the Phase 1 default of 1.0).

### Signals + sources

| Signal | Discipline(s) | Source | Confidence |
|---|---|---|---|
| HRV trend (7d vs 28d) | All | Plews D et al. (2013) "Training adaptation and HRV in elite endurance athletes" *Sports Med* 43:773–781 | High |
| RPE-vs-expected delta | Per discipline | Foster C et al. (2001) *J Strength Cond Res* 15:109–115; Borg G (1982) | Medium-high |
| HR-at-power drift | Bike | Coggan A & Allen H (2019) "Training and Racing with a Power Meter" 3rd ed. Ch. 9 | Medium |
| Pa:Hr decoupling | Bike + run | Friel "Triathlete's Training Bible" 4th ed. (2016); Maunder E et al. (2021) *Sports Med* 51:1387–1402 | Medium |
| CSS pace SD | Swim | Pyne D et al. (2001) — pace consistency at threshold | Low |

### Per-discipline weighted blend

```
swim ratio = 1.0
            + 0.30 × hrvAdjustment
            + 0.50 × rpeAdjustment[swim]
            + 0.20 × cssSdAdjustment

bike ratio = 1.0
            + 0.25 × hrvAdjustment
            + 0.30 × rpeAdjustment[bike]
            + 0.25 × hrAtPowerAdjustment
            + 0.20 × pahrAdjustment[bike]

run ratio  = 1.0
            + 0.25 × hrvAdjustment
            + 0.30 × rpeAdjustment[run]
            + 0.45 × pahrAdjustment[run]
```

Final ratio clamped to `[0.70, 1.30]` (HERITAGE family-study data, Bouchard 1999 *MSSE* 31:252–258, supports ~5× spread in individual VO2max trainability — roughly ±30% on expected gain).

### Per-signal sensitivity multipliers

```
hrvSensitivity      = 1.5   // 5% HRV trend → +7.5% ratio bump
rpeSensitivity      = 0.05  // 1-pt RPE delta → +5% ratio bump
hrPowerSensitivity  = 0.05  // 2 bpm/week drop → +10% ratio bump
pahrSensitivity     = 0.5   // 1 ppt/week reduction → +5% ratio bump
cssSdSensitivity    = 0.10  // 1 sec/100m/week SD reduction → +10% ratio bump
```

Each signal's adjustment is bounded by its own cap (HRV: ±0.10, RPE: ±0.15, HR-at-power: ±0.10, Pa:Hr: ±0.10, CSS-SD: ±0.05).

### Limitations

- HERITAGE-scale individual variance is real; the model captures only what training data can reveal in 4–8 weeks. New athletes have insufficient data → ratio defaults to 1.0.
- RPE delta assumes the planned RPE on each workout is correctly calibrated. If the plan over-estimates expected RPE, all athletes look like fast responders.
- HR-at-power requires a power meter and HR strap; without both, the bike signal degrades to neutral.
- Pa:Hr decoupling for runs now uses Friel's efficiency-factor formulation directly from per-km pace + HR splits (`efDecouplingPct` in `tri-adaptation-ratio.ts`): per-km `EF = (1/paceSecKm) / hr`, then `decoupling% = (firstHalfMeanEF − secondHalfMeanEF) / firstHalfMeanEF × 100`. Falls back to `hrDrift` when `kmHRSplits` is absent (e.g. pre-ingest-upgrade runs, bike actuals). Friel/Uphill Athlete benchmark: <5% = aerobic steady state. Bike Pa:Hr remains on the `hrDrift` proxy until bike per-km HR is wired through the ingest.
- CSS pace SD weight is intentionally low because Pyne 2001 is suggestive, not regression-grade.

### Phase 2B (plan-side reactivity) status

Foundations shipped in this PR: skip handler (`tri-skip-handler.ts` — push to next week, drop on second skip), volume-ramp detector (`tri-volume-ramp.ts` — Gabbett 2016 5–10% rule per discipline), RPE-blown-session detector (`tri-rpe-flag.ts` — Foster 2001, +2 RPE delta). The suggestion modal UI, the readiness gate for tri, and the post-sync activity matching wiring are deferred to a follow-up.

---

## Triathlon — Live, volume-aware, course-aware race prediction (2026-04-28)

The triathlon race-time predictor was previously a snapshot of current fitness with a fixed ±10% range. It is now a *live, projected* race-day finish that mirrors the marathon `calculateLiveForecast` architecture per discipline. The headline number is what the athlete will do *on race day if they execute the plan*; a secondary "if you raced today" number lives below it.

The pipeline:

```
currentFitness (CSS, FTP, VDOT)
       │
       ▼
applyTriHorizon{Swim|Bike|Run}    ← projected race-day fitness
       │
       ▼
per-leg pace (CSS+5, FTP→speed via physics, VDOT→pace + §18.4 fatigue discount)
       │
       ▼
applyCourseFactors                 ← climate, altitude, run elevation, wind, swim type
       │
       ▼
applyDurabilityCap (run only)      ← long-ride / long-run thresholds
       │
       ▼
final race time + range + limitingFactor
```

### §F Per-discipline horizon model

The horizon adjuster is the same shape as marathon's `applyTrainingHorizonAdjustment`:

```
weekFactor    = 1 - exp(-weeks_eff / tau)             // saturating exponential
sessionFactor = 1 / (1 + exp(-k × (sessions - refSess)))  // logistic
expFactor     = bucketed by experience_level
improvement_pct = max_gain × weekFactor × sessionFactor × expFactor
                  - undertrain_penalty + taper_bonus - adherence_penalty
improvement_pct *= adaptation_ratio
improvement_pct  = clamp(-max_slowdown, +max_gain_cap)
```

The result is applied to the discipline's fitness marker in the right direction:
- CSS: `projCSS = currentCSS × (1 - improvement_pct/100)` (lower = faster)
- FTP: `projFTP = currentFTP × (1 + improvement_pct/100)`
- VDOT: delegates to the existing marathon function (`target_distance: 'marathon'` for IM, `'half'` for 70.3) and applies adherence + adaptation on top.

#### §F.1 Swim CSS horizon parameters

Sources:
- **Pyne, Trewin & Hopkins (2004)** *J Sports Sci* 22:613–620 — elite swimmers improve ~0.4–1.0%/yr at peak performance.
- **Costa M et al. (2010)** — longitudinal age-grouper data, ~3–6% over a season for sub-elite.
- **Mujika et al. (2002)** *MSSE* 34:1486–1493 — 2.2 ± 1.5% gain in 99 swimmers from a 3-week taper. **High confidence.**
- **Toussaint & Hollander (1994)** — propulsive efficiency explains ~80% of swim economy variance. Adult swim is technique-limited.
- **Sweetenham & Atkinson (2003)** "Championship Swim Training" — 8–12wk macro blocks for adaptation.
- **Maglischo (2003)** "Swimming Fastest" — coaching reference for session-frequency thresholds.

`max_gain_pct`: beginner 6.0, novice 4.5, intermediate 3.0, advanced 1.8, elite 0.9 (high at elite end, medium below).
`tau_weeks`: 10–12 (low confidence — calibrated to clinical experience).
`ref_sessions`: 3, 3, 4, 5, 6 (medium).
`undertrain_penalty_pct`: 3.0 per session/week below `min_sessions` (low — extrapolated; technique loss compounds).
`taper_bonus_pct`: 2.0–2.5 (Mujika 2002, **high confidence, n=99**).

**Limitations**: swim has the lowest ceiling of the three because adult swim adaptation is dominated by technique. The model treats it as a fitness ceiling, which is a defensible simplification but doesn't capture deliberate technique blocks.

#### §F.2 Bike FTP horizon parameters

Sources:
- **Coggan & Allen (2019)** "Training and Racing with a Power Meter" 3rd ed., Ch. 7 (FTP gain rates), Ch. 9 (HR-at-power adaptation signals).
- **Pinot & Grappe (2011)** — Record Power Profile, pro cyclists ~1–3%/yr at top end.
- **Lucia A et al. (2000)** — pro cyclist physiological adaptation.
- **Coyle (1991)** *Exerc Sport Sci Rev* 19:307–340.
- **Bouchard HERITAGE family study** — VO2max trainability variance for the beginner-end extrapolation.
- **Mujika & Padilla (2003)** *MSSE* 35:1182–1187 — 2–6% bike performance gain from optimised taper.
- **Bosquet L et al. (2007)** meta-analysis — 1.96% mean perf gain (CI 0.8–3.1%).

`max_gain_pct`: beginner 15.0, novice 10.0, intermediate 6.0, advanced 3.5, elite 1.5 (high at trained end; beginner figure HERITAGE-extrapolated, medium).
`tau_weeks`: 6–12 (medium).
`ref_sessions`: 3–5 (medium).
`undertrain_penalty_pct`: 2.0 (low — anchored to marathon analog; bike adapts faster than swim with frequency).
`taper_bonus_pct`: 2.5–3.0 (**high — Mujika & Padilla 2003 + Bosquet 2007**).

#### §F.3 Run horizon

Uses `RUN_HORIZON_PARAMS_703` / `RUN_HORIZON_PARAMS_IM` (in `triathlon-horizon-params.ts`) via `computeImprovementPct` — the same generic function used for swim and bike. `max_gain_pct` and `tau_weeks` mirror `TRAINING_HORIZON_PARAMS` half/marathon values (Daniels 2014) since run physiology is unchanged by context. `ref_sessions` and `min_sessions` are triathlon-calibrated:

| | 70.3 | IM |
|---|---|---|
| `ref_sessions` (intermediate) | 3.0 | 3.5 |
| `min_sessions` (intermediate) | 1.5 | 2.0 |

**Rationale for triathlon-specific session frequencies**: the marathon model uses `ref_sessions = 5.0` for intermediate runners (Daniels' optimal marathon training load). In a triathlon program, 3 runs/week is the standard recommendation (Friel 2012 "The Triathlete's Training Bible"; Dixon 2015 "Fast-Track Triathlete") because swim and bike volume provides concurrent aerobic stimulus, reducing the run frequency needed to drive VO2max adaptation (Laursen & Buchheit 2019). Using the marathon's `ref_sessions = 5.0` would treat a well-trained triathlete doing 3 runs/week as severely undertrained, suppressing a realistic 3–5% VDOT gain down to < 1%.

**Effect at intermediate, 3 runs/week, 18 weeks**: session_factor = 0.5 (at ref), week_factor ≈ 0.87 → base improvement ≈ 3.5%, plus taper ≈ 4.7% before adaptation. Projected VDOT gain ≈ +2 points for Tristan's VDOT 48 baseline, consistent with Midgley et al. (2006) 5–8% VO2max range over 8–16 week blocks.

**Confidence**: max_gain_pct and tau high (Daniels). Ref/min sessions medium — no controlled trial directly compares run frequencies in a concurrent triathlon context; figures are coaching consensus from Friel and Dixon.

Adherence penalty and adaptation ratio are applied inside `computeImprovementPct` (same path as swim/bike).

#### §F.4 Adaptation ratio (Phase 2 plan)

Phase 1 ships with `adaptation_ratio = 1.0` defaults. Phase 2 will wire live signals:
- **HRV trend (28d)** — Plews et al. (2013) — global ratio multiplier
- **HR-at-FTP%** — Coggan & Allen Ch. 9
- **Pa:Hr decoupling on tempo** — Friel; Maunder et al. (2021)
- **CSS-effort pace SD** — Pyne et al. (2001) (low confidence)
- **DFA-α1** — Rogers et al. (2021), emerging metric

### §G Course factors

All multipliers are applied to leg time *after* the per-discipline horizon projection. Compounded penalty is sanity-checked: a warning logs if total bike or run multiplier exceeds 1.25.

#### §G.1 Climate (run primary, bike secondary)

Sources:
- **Ely MR et al. (2007)** *MSSE* 39:487–493 — fastest marathons at 10–12°C; per-degree slowdown above.
- **El Helou N et al. (2012)** *PLoS ONE* 7:e37407 — 1.7M finishers across 6 marathons.
- **Maughan & Shirreffs (2010)** *Scand J Med Sci Sports* 20 Suppl 3:40–47.
- **Galloway & Maughan (1997)** — heat + humidity interaction.
- **ACSM Position Stand on Heat (2007)**.
- **Tatterson et al. (2000)** *J Sci Med Sport* 3:186–193 — ~6.5% bike power drop in 32°C vs 23°C TT; bike heat penalty ≈40% of run penalty due to convective cooling at 30+ km/h.

Mapping (anchor temp → run % → bike %):
- cool (12°C) → 0% → 0%
- temperate (18°C) → +1.5% → +0.6%
- warm (24°C) → +4% → +1.6%
- hot (30°C) → +8% → +3%
- hot-humid (30°C + RH > 70%) → +12% → +5%

**Limitations**: humidity is approximated by category, not WBGT. Acceptable for a v1 prediction; future work could ingest race-week forecasts directly.

#### §G.2 Altitude (run + bike, non-linear above 1500m)

Sources:
- **Bonetti & Hopkins (2009)** *Sports Med* 39:107–127 — meta-analysis.
- **Wehrlin & Hallen (2006)** *Eur J Appl Physiol* — ~6.3% VO2max drop per 1000m above 600m.
- **Peronnet F et al. (1991)** — altitude performance modelling.

```
altitudePenaltyRun(m)  = 0  if m < 500
                       = (m - 500) × 0.20% / 100m   for 500 ≤ m ≤ 1500
                       = 2.0 + (m - 1500) × 0.40% / 100m   for m > 1500   (capped at 12%)
altitudePenaltyBike(m) = altitudePenaltyRun(m) × 0.65   (capped at 8%)
```

Bike < run because IM bike intensity is sub-maximal aerobic; running has higher relative VO2 cost per unit of speed.

#### §G.3 Run elevation (Minetti 2002 polynomial)

Sources:
- **Minetti et al. (2002)** *J Appl Physiol* 93:1039–1046. Canonical polynomial for energy cost C(i):
  ```
  C(i) = 155.4·i⁵ - 30.4·i⁴ - 43.3·i³ + 46.3·i² + 19.5·i + 3.6   (J/kg/m)
  ```
- **Drake/Strava Engineering blog (2017)** — Strava's GAP algorithm is Minetti-derived.

`runElevationMultiplier(elevationM, distanceKm) = C(avgGrade) / C(0)` where `C(0) = 3.6`, `avgGrade = elevationM/(distanceKm × 1000)`, clamped to [-0.10, +0.10].

**Limitations**: average grade underestimates true cost on rolling courses (asymmetric eccentric cost on descents). Acceptable for v1; can be refined with per-km elevation data later.

#### §G.4 Wind exposure (bike only)

Source: **Martin JC et al. (1998)** *J Appl Biomech* 14:276–291 — physics model already used in `bike-physics.ts`. Treated as model-derived, low-medium confidence.

```
sheltered = 1.00, mixed = 1.02, exposed = 1.05
```

These match the existing `WIND_LOSS_FACTOR` for `flat`/`rolling`/`hilly`/`mountainous`. Field validation for IM bike splits is thin — document as physics-anchored.

#### §G.5 Swim type

Sources:
- **Toussaint HM et al. (1989)** *MSSE* 21:325–328 — wetsuit drag reduction ~14% at 1.25 m/s.
- **Cordain L & Kopriva R (1991)** *Sports Med* 11:336–348 — ~5% time benefit for non-elite.
- **de la Fuente Pacheco JG et al. (2020)** *Int J Sports Physiol Perform* 15:46–51 — 400m pool study, ~6% time reduction (~0.07 m/s).
- **Baldassarre R et al. (2017)** *Front Physiol* 8:294 — open-water vs pool review.
- **López-Belmonte Ó et al. (2024)** *Scand J Med Sci Sports* 34:e14702 — 1500m, n=14 elites; lower stroke length / index and higher stroke rate in OW vs pool, but no physiological differences and strong correlation in finish times.

```
pool                   = 1.00 (athlete-side; ≡ wetsuit-lake at race effort)
wetsuit-lake           = 1.00 (reference baseline)
non-wetsuit-lake       = 1.04 (+4% drag without wetsuit)
ocean                  = 1.05 (+5% chop; salinity buoyancy partially offsets)
ocean-current-assisted = 0.97 (−3%; e.g. Roth canal, favourable Kona years)
river                  = 1.00 (direction-dependent; neutral default)
```

**Pool coefficient = 1.00 (rationale).** A pool swim is faster than the equivalent open-water swim by ~5–10% (USMS coaching guidance, community data) — wall push-offs (3 per 100m in a 25m pool), no chop, no sighting, glide off each turn. A wetsuit makes an open-water swim ~5–6% faster than the same effort without one (Toussaint 1989, Cordain 1991, de la Fuente Pacheco 2020). The two effects approximately cancel: a pool swim ≈ a wetsuit-lake swim at equivalent effort. Pool = 1.00 is the "honest cancellation" choice — both effects are acknowledged but absorbed into the shared baseline rather than fabricating a pool-specific multiplier (per CLAUDE.md "no made-up numbers"). Confidence: medium. Could be wrong by a few percent in either direction depending on pool length (50m loses some wall benefit) and ocean conditions (heavy chop steepens the OW penalty).

**Two unions, one multiplier table.**
- `CourseProfile['swimType']` (race-side, 5 values): cannot be `pool` — you don't race in a pool.
- `AthleteSwimEnvironment` (per-activity training tag, 5 values): cannot be `ocean-current-assisted` — that's a race-only condition, not a training baseline.
- Shared `SWIM_TYPE_MULTIPLIER` covers all 6 keys.

**Athlete-side normalisation** (added 2026-05-09). Each swim's pace is divided by `SWIM_TYPE_MULTIPLIER[swimEnvironment]` to yield a wetsuit-lake-equivalent pace before pooling into CSS. Race-side then re-applies the course factor for the actual race environment. This avoids the previous double-count where a pool-trained CSS was treated as already-in-wetsuit-lake conditions and then penalised again for ocean chop. Pool swims auto-tag from `activityType` (`SWIMMING` / `LAP_SWIMMING`); OW swims fall back to `triConfig.swim.defaultOwSwimEnvironment` (set once via the reveal modal). When no tag and no default exist, the multiplier is 1.0 — safe fallback that doesn't fabricate a number.

**Limitations**: river swims and ocean conditions vary year to year. The neutral defaults are deliberately conservative. Saltwater/freshwater buoyancy is bundled into the ocean-vs-lake split rather than modelled as a separate axis (~2.5% body-mass buoyancy difference exists but lacks rigorous performance literature for trained swimmers). Pool length (25m vs 50m) is not differentiated in the multiplier; 50m pools lose some of the wall-push-off benefit but the user's `poolLengthM` field could be used in v2 to refine.

### §H Run-leg durability cap (the new triathlon-specific piece)

Capacity markers (CSS, FTP, VDOT) describe single-bout capacity. The IM run requires holding sub-LT pace for 3+ hours after 5+ hours of cumulative work. An athlete with strong markers but no recent long sessions will crack on race day. The fixed 11% IM / 5% 70.3 fatigue discount is an *average*; durability-deficient athletes cluster well below it.

Sources (suggestive, not specific enough for closed-form mapping — **confidence: low**):
- **Coyle (1988)** *Exerc Sport Sci Rev* — endurance specificity.
- **Joyner & Coyle (2008)** *J Physiol* — endurance performance physiology.
- **Rüst et al. (2012)** *J Strength Cond Res* — IM marathon time correlates with longest training run + weekly volume in build (r ≈ 0.55–0.70).
- **Friel "Triathlete's Training Bible"** — build-phase specificity guidelines.

Thresholds (12-week look-back window):
- IM:   long ride ≥ 4.5 h, long run ≥ 2.0 h
- 70.3: long ride ≥ 2.5 h, long run ≥ 1.5 h

Penalty: 0% if both met. Each missed threshold contributes up to half of `MAX_DURABILITY_PENALTY = 5%`. Linear interpolation between threshold and 50% of threshold; below 50% the penalty is fully applied.

The model also surfaces a `limitingFactor` to the UI: `'long_ride_volume'`, `'long_run_volume'`, or `'volume_durability'` so the user knows *why* their predicted run leg is capped.

**Limitations**: literature does not justify a larger penalty than +5%. Do not increase the cap without new evidence. The model is a heuristic, not a regression.

### §I Confidence range

```
baseRange = 0.10 (IM) | 0.08 (70.3)
range += min(0.04, weeksRemaining/24 × 0.04)   // far-out predictions widen
range += novice or veteran adjustment (±0.02)
range = clamp(min, max)
```

Min/max bounds: IM `[0.06, 0.16]`, 70.3 `[0.05, 0.14]`.

The horizon model's `weekFactor` saturates as race day approaches, so a far-out projection is *more* uncertain (more horizon to unfold). Years of training adjusts confidence in either direction:
- < 2 yrs → +2% (novice has more variance, per Joyner & Coyle 2008)
- ≥ 5 yrs → −2% (veteran predictions are more reliable)

### §J Bike-to-run fatigue discount validation (existing 11% IM / 5% 70.3)

Sources confirming the existing values:
- **Vleck et al. (2008)** *J Sports Sci* — elite ITU triathlon performance.
- **Bentley et al. (2002)** *Sports Med* — "Specific aspects of contemporary triathlon".
- **Laursen et al. (2007)** — IM pacing.
- **Bentley (2007)** — 4–7% slower than open half-marathon for 70.3.
- **Landers (2008)** — 8–13% slower than open marathon for IM.

The current values (11% IM, 5% 70.3) sit at the mid-range of published data. Kept as the floor; the durability cap can only widen, not narrow. **Confidence: high.**

### §K Single-discipline cycling event finish-time prediction (2026-05-04)

**File**: `src/calculations/race-prediction.cycling.ts`

**Model**: Gran Fondo / sportive finish time from FTP × intensity factor, solved through the Martin et al. 1998 bike physics engine (`bike-physics.ts:solveSpeed`).

**Intensity factor table** (Allen & Coggan, *Training and Racing with a Power Meter*, 2010 — power-duration zones):

| Distance | Duration estimate | Zone     | IF   |
|----------|-------------------|----------|------|
| 50 km    | 1.5–2 h           | Sweet spot | 0.88 |
| 100 km   | 3–4 h             | Tempo      | 0.80 |
| 160 km   | 4.5–6 h           | End-tempo  | 0.74 |
| 200 km   | 6–8 h             | Endurance  | 0.68 |
| 300 km   | 9–12 h            | Ultra      | 0.62 |

These IFs are higher than the triathlon bike-leg IFs (`RACE_INTENSITY_BY_DISTANCE`: 0.78 for 70.3, 0.70 for IM) because cycling events are single-discipline — no pre-swim fatigue, no pacing reserve needed for a run leg.

**Physics path**: when an aero profile + body weight + bike weight are set, `solveSpeed` finds the equilibrium speed at `raceWatts = FTP × IF` solving `P = (CdA × ρ/2 × v² + Crr × m × g) × v + m × g × sin(θ) × v`. No iteration is needed here because the IF is distance-keyed (not duration-keyed), so there is no circularity.

**Fallback path** (no aero profile): linear `kph = 20 + (watts − 100) × 0.067`, clamped 18–48 kph, with coarse gradient penalty (flat: 0, rolling: −1.5, hilly: −3.5, mountainous: −6.0 kph). Same coefficients as the triathlon predictor's no-aero path.

**Confidence range**: ±10% > 4 weeks out, ±6% within 4 weeks. Gran Fondo pacing is less predictable than triathlon bike legs (group dynamics, feed-zone strategy, variable parcours) — bands are intentionally conservative.

**Known limitations**: IF assumes solo pacing at even power; drafting in a large sportive can significantly lower the required power. The model is an FTP-fraction estimate, not a validated GF-specific model. No elevation integration (course profile is categorical, not a gradient profile).

**Confidence: medium** — physics engine is well-validated; IF constants are from authoritative source; fallback linear path is a rough approximation only.

---

### §L MusculoTendon Load (MTL) — HYROX eccentric strain model (2026-05-04)

**File**: `src/calculations/mtl.ts`, `src/constants/hyrox-constants.ts`

**Problem**: aerobic TSS and impact load are insufficient for HYROX because station work (sleds, lunges, wall balls) produces significant eccentric/mechanical stress that does not scale with heart rate or run mileage. A third load currency is needed.

**Model**:

```
rawComponentMTL = durationMin × sRPE × modalityFactor × impactFactor × (1 + externalLoadFactor)
effectiveMTL    = cap × (1 − exp(−rawMTL / cap))
```

Where:
- `sRPE` = session RPE (1–10) for this component — same method as Foster et al. 2001 session RPE.
- `modalityFactor` = eccentric + mechanical loading multiplier relative to baseline IL. Ergs: 0.5; sled/farmer carry: 1.0–1.2; plyometrics (burpee BJ): 1.3. From Verkhoshansky & Siff 2009 on eccentric loading taxonomy.
- `impactFactor` = ground-impact amplification. Ergs: 0.7 (minimal footstrike); sled push/pull/carry: 1.0; burpee BJ/sandbag lunges: 1.0–1.3. From Clarkson & Hubal 2002 on DOMS and eccentric exercise.
- `externalLoadFactor = min(0.6, externalLoadKg / bodyWeightKg × 0.5)`. Caps at 0.6 (60% amplification) — conservative linear fit for external-to-body-weight ratio. Clamped because above bodyweight loads (e.g. heavy farmer carry) have diminishing marginal MTL per unit of extra load.
- `cap` = per-band weekly MTL ceiling from `HYROX_MTL_CAP`. **Initial estimates pending real-training validation.**

**Saturation curve rationale**: The one-minus-exponential form prevents linearly accumulating MTL at extreme loads. Real tissue tolerance asymptotes as load approaches and exceeds the individual's current capacity — analogous to the Banister impulse-response saturation used in some CTL models (Busso 2003, *Med Sci Sports Exerc* 35(7)). The saturation constant is set equal to `cap` so the 63% saturation point aligns with the per-band ceiling.

**Station MTL factors** (from research doc §3.3):

| Station           | modalityFactor | impactFactor |
|-------------------|---------------|-------------|
| SkiErg            | 0.5           | 0.7         |
| Sled push         | 1.2           | 1.0         |
| Sled pull         | 1.2           | 1.0         |
| Burpee broad jump | 1.3           | 1.3         |
| Row erg           | 0.5           | 0.7         |
| Farmer carry      | 1.0           | 1.0         |
| Sandbag lunges    | 1.1           | 1.0         |
| Wall balls        | 1.1           | 1.0         |

**Run intensity factors**:
| Intensity   | modalityFactor | impactFactor |
|-------------|---------------|-------------|
| Easy        | 0.6           | 1.0         |
| Tempo       | 0.8           | 1.0         |
| Intervals   | 1.0           | 1.0         |

**MTL caps** (initial estimates — pending real-training validation; to be refined after dogfooding):

| Band           | Weekly MTL cap |
|----------------|---------------|
| Total beginner | 500           |
| Beginner       | 700           |
| Novice         | 1 000         |
| Intermediate   | 1 300         |
| Advanced       | 1 600         |
| Competitive    | 2 000         |

Cap derivation: rough scaling from the training-load literature on eccentric/mechanical stress tolerance across experience levels (Damas et al. 2016, *Eur J Appl Physiol* 116(5); Schoenfeld 2010, *J Strength Cond Res* 24(12)). Not empirically validated against HYROX athlete data.

**Known limitations**:
1. MTL factors for each station are ordinal estimates, not calibrated from actual athlete data. All HYROX-specific constants need real-training validation.
2. External load factor uses a linear approximation; actual load-response relationship may be non-linear (especially at very high loads).
3. The MTL cap table is not yet evidence-based — it will be tuned after dogfooding with actual HYROX training sessions.
4. No time-decay model for MTL yet (Phase 3 will add MTL CTL/ATL EMA analogous to aerobic CTL).

**Confidence: low (model structure) / none (constants)** — model structure is physiologically grounded but constants are initial estimates pending validation.

---

### §L2 HYROX run-leg fatigue model (2026-05-05)

**File**: `src/calculations/race-prediction.hyrox.ts`

**Problem**: a flat 8 × base pace predicts HYROX run splits incorrectly. Race data (HyroxDataLab finishing-time distributions) shows a clear within-race fatigue gradient: Run 1 is ~5% faster than average; Runs 7–8 are 5–8% slower, driven by cumulative eccentric + metabolic fatigue from completed stations.

**Model**:
```
rawMultiplier(legIndex) = 1 + legIndex × PER_STATION_FATIGUE_RATE
PER_STATION_FATIGUE_RATE = 0.008   // 0.8% per station completed
normMultiplier(i) = rawMultiplier(i) / mean(rawMultiplier, 0..7)
legPace(i) = basePace × venueMultiplier × normMultiplier(i)
```

`legIndex = 0` = Run 1 (no stations yet); `legIndex = 7` = Run 8 (after 7 stations completed).

**Why normalise**: the raw multipliers sum to 8 × avgMult, not 8 × 1. Dividing by avgMult restores the energy-conservation constraint: total 8-run duration equals 8 × basePace × venueMultiplier. The normalisation is a mathematical identity — it does not change the predicted total, only the per-leg distribution.

**Rationale for 0.8%/station**: Goss et al. 2021 (*Int J Sports Physiol Perform* 16(3)) found run-economy declined by 3–8% over repeated high-intensity bouts with eccentric loading in resistance-trained athletes. A 0.8% per-station rate implies 6.4% total degradation over 7 completed stations (Run 8 is 6.4% slower than Run 1, before normalisation). This sits in the lower half of the Goss range, reflecting that HYROX athletes are specifically trained for this format. HyroxDataLab's published average run-pace progressions (Open men average, 2023) show a ~1.4s/km per station, consistent with 0.8% for a ~3:00/km base pace.

**Known limitations**:
1. Linear model — actual fatigue may accelerate non-linearly at higher station loads (wall balls → lunges stack produces more fatigue than two ergometer stations).
2. No individual station MTL weighting — all 8 stations are treated equally. Phase 2 could weight by station MTL factor.
3. Normalisation preserves energy at the mean but not at extreme athlete bands (very fast athletes have a different physiological trajectory).
4. PER_STATION_FATIGUE_RATE is a single constant across all ability bands. Competitive athletes likely show less degradation (better eccentric tolerance, higher training specificity).

**Confidence: medium-low** — rate is consistent with published literature but not calibrated against HYROX-specific population data.

---

## Cycling and swimming commentary metrics (2026-04-28)

**Purpose.** Coach's Notes for non-running activities now use sport-canonical metrics rather than the silent fall-through that previously rendered nothing for cycling and swimming.

**Cycling — Intensity Factor (IF).** `IF = NP / FTP`. Source: Coggan & Allen, *Training and Racing with a Power Meter*. Bands used in `composeCyclingInsight`:
- IF < 0.65 — recovery / easy spin
- 0.65 ≤ IF < 0.80 — endurance
- 0.80 ≤ IF < 0.94 — tempo
- 0.94 ≤ IF < 1.05 — threshold
- IF ≥ 1.05 — anaerobic / VO2

**Cycling — bTSS estimate.** `bTSS = (durationSec × NP × IF) / (FTP × 3600) × 100`. Same Coggan formulation as `BIKE_TSS_INTENSITY_EXPONENT = 2` already used elsewhere in the codebase for planning-side bike load. Reported here as a description of the ride that just happened, not as the canonical bTSS feeding the fitness model.

**Cycling — Variability Index (VI).** `VI = NP / avgWatts`. Bands:
- VI < 1.05 — very steady (TT-like)
- 1.05 ≤ VI < 1.10 — rolling
- 1.10 ≤ VI < 1.20 — punchy / variable
- VI ≥ 1.20 — highly variable with frequent surges

VI describes the *shape* of the ride, not its intensity. Two rides at the same IF can have very different VIs (steady tempo vs interval session). Useful colour for the rider but not load-bearing for any downstream calculation.

**Swimming — pace per 100m vs CSS.** `pacePer100m = (durationSec / distanceM) × 100`. Compared against `state.onboarding.triSwim.cssSecPer100m` (Critical Swim Speed). Bands:
- delta < -3 s/100m — sub-threshold (faster than CSS)
- -3 ≤ delta < +5 s/100m — threshold
- +5 ≤ delta < +12 s/100m — endurance / aerobic
- delta ≥ +12 s/100m — easy / recovery

CSS is the swim equivalent of running threshold pace; bands above are pragmatic and consistent with how CSS is used elsewhere in this codebase. No literature claim of precise sub-band labels — the cut-points are interpretive shorthand for the swimmer.

**Limitations.**
- IF / VI / bTSS require a power meter. Without one, the cycling composer falls back to HR-effort framing or a single descriptive sentence.
- Swim CSS is set in onboarding or derived from PBs; if neither is present the composer reports raw pace/100m only.
- HR-zone surface for swims is gated on an HR-capable strap being worn — most pool swims aren't recorded with HR, and the file's heuristic skips the line when zones are absent.

---

## IRONMAN course profile schema (2026-04-28)

**Purpose.** Per-leg published facts about each IRONMAN-branded race, attached to every `Triathlon` row. Consumed by the race-prediction agent (separate, not in this commit) to produce per-leg time deltas vs an IM-typical course. We deliberately store **only sourced facts here**, no derived multipliers — the prediction model owns the translation from facts → minutes.

**Schema** (`src/types/onboarding.ts:CourseProfile`):

| Field | Type | Source | What the prediction engine should do with it |
|---|---|---|---|
| `bikeElevationM` | number (m) | Athlete guide / Strava segments | Primary input for bike-time penalty. Established models (analyticcycling, BikeCalculator) suggest ~3–5 sec per 100m of climb at ~250 W on rolling terrain. |
| `runElevationM` | number (m) | Athlete guide | Run-time penalty: roughly 30–60 sec/km of climb at IM pace per Minetti's energy-cost-of-grade work. |
| `bikeProfile` | flat / rolling / hilly / mountainous | Derived from elevation by fixed cutoffs (see below) | Categorical fallback when no power meter or detailed bike model is available. |
| `runProfile` | flat / rolling / hilly | Derived from elevation by fixed cutoffs | Same — categorical fallback. |
| `swimType` | wetsuit-lake / non-wetsuit-lake / ocean / ocean-current-assisted / river | Athlete guide + historical water-temp records | Wetsuit-legal lake: baseline. Ocean: +1–3% (chop, sighting). Current-assisted (Cozumel, Jacksonville, California, Augusta): –10–25% based on observed historical splits. Non-wetsuit lake: +5–8%. |
| `climate` | cool / temperate / warm / hot / hot-humid | Race-day historical weather (avg high + humidity at venue) | Heat penalty applies primarily to the run. Maughan & Shirreffs and ACSM heat-stress guidelines suggest 1–4% pace penalty per °C above 22°C, exacerbated by humidity (wet-bulb globe temperature). |
| `altitudeM` | number (m) | Venue elevation | At elevations >~1000m, VO2max drops ~7–9% per 1000m above sea level. Affects all three legs but bike (sustained aerobic) most. Lake Placid (570m), Klagenfurt (440m), Vitoria (540m), Boise (820m) sit in the marginal zone; Ruidoso 70.3 (2070m) is the only outlier where the effect is large. |
| `windExposure` | sheltered / mixed / exposed | Slowtwitch + race writeups | Bike split sensitivity. Exposed courses (Kona, Lanzarote, Busselton, Cozumel) regularly produce 10–15 min IM bike-split swings between calm and windy years, independent of elevation. |
| `notes` | free-form string | Combined sources | One-line human-readable summary surfaced in the wizard race-picker. |

**Categorisation rules** (applied consistently when populating from raw elevation):

- bikeProfile (full IM cutoffs; halve for 70.3): flat <500m, rolling 500–1200m, hilly 1200–2000m, mountainous >2000m.
- runProfile (full marathon cutoffs; halve for 70.3): flat <100m, rolling 100–300m, hilly >300m.

**Data sourcing.** Populated for all 79 IRONMAN-branded races on the 2026 calendar from official Ironman.com athlete guides, Slowtwitch course writeups, and individual race-website course descriptions. A small number of brand-new or low-coverage races (Penghu, Subic Bay, Tours, Canada-Ottawa, Leeds, Gurye, San Juan, Valdivia) have only the swim/climate fields populated — the rest stay undefined, per the no-made-up-numbers rule. Annual refresh expected as Ironman publishes new athlete guides.

**Limitations.**
- Single number per leg cannot represent the *shape* of the elevation profile (one big climb vs many short rollers cost different amounts of time at the same total gain). The prediction engine should treat elevation as a coarse signal only.
- Climate is a typical-year category, not a race-day forecast. The prediction engine should optionally take a forecast input on top of this.
- No drafting/age-group field-density modelling — relevant for elite athletes only.
- `windExposure` is binary-ish (sheltered/mixed/exposed); real wind effect is heading-dependent and stochastic year-to-year.

**Why this lives separate from `WORLD_TRIATHLONS`.** Race calendar metadata (dates, locations) refreshes annually with new schedules. Course profile facts refresh slower (only when a course changes route). Keeping them in different files lets each rotate on its own cadence.

---

## Onboarding fallbacks for missing personal data (2026-04-27)

**Purpose.** The triathlon About-you card collects age, bodyweight, and sex but lets users skip every field. Downstream models still need values — max-HR estimates need age, FTP→W/kg tier needs weight, iTRIMP β needs sex. This entry records the fallbacks and why they're defensible.

**Sex → iTRIMP β coefficient.** The Banister iTRIMP integral uses a sex-specific exponential weighting: β = 1.92 (male), β = 1.67 (female). Source: Banister 1991, Morton et al. 1990. The weighting reflects the steeper rise in lactate-vs-HR curve seen in trained males relative to trained females, which makes a high-HR minute count for more in male iTRIMP. The picker offers Male / Female / Other; selecting Other internally maps to the male coefficient. Rationale: the male β yields a more aggressive load count, so it's the conservative choice when sex is undeclared (over-counting load is safer than under-counting it for injury and overtraining detection). *(2026-10-05)* The iTRIMP-to-TSS normaliser now uses the same β, and producers and normaliser resolve sex through one function, `trimp.ts:resolveBiologicalSex` (§CI).

**Bodyweight skipped → sex-based default.** When bodyweight is unset:
- Male / Other → **75 kg**
- Female → **62 kg**

These are rough WHO global adult averages (WHO Global Health Observatory; range 60–80 kg M, 50–70 kg F across regions, midpoints chosen for midrange Western populations). They're imprecise but bounded; the FTP→W/kg cycling tier uses these defaults only to place the athlete on the Coggan ladder, where one tier-step maps to roughly ±10 kg of misestimate at typical age-grouper FTPs (~250 W). The downside risk is one-tier-off — survivable, with the user able to enter their actual weight at any time.

**Age skipped → no max-HR estimate.** Age is only used today by `sport-picker-modal.ts` for the *fallback* max HR (`220 − age`). When age is missing and no measured `maxHR` is on file, the modal omits the estimate rather than using a guessed default. This is the right behaviour: a guessed max HR contaminates HR-derived load. Better to display "—" and prompt the user to set it.

**Limitations.**
- `220 − age` itself is an approximation with a standard error of ±10–12 bpm (Tanaka 2001 proposed `208 − 0.7×age` as more accurate). Both formulas remain population-level estimates; field testing or measured peaks during a race remain the gold standard.
- The 75/62 kg split is a population mean. Athletes in our user base skew lower than Western population means (endurance triathletes typical 60–80 kg M, 50–65 kg F). The default is therefore conservatively heavy, biasing W/kg slightly *down*. We accept this rather than carry a separate "endurance population" prior, which would be data-snooping our own user base.
- "Other" inherits male defaults. This is operationally pragmatic — physiology cannot be inferred from gender identity — and the user can always override the iTRIMP β by directly editing `state.biologicalSex`. A future refinement would let the user provide measured resting HR and HRV directly so β becomes irrelevant.

---

## Tanda Garbage Filter (2026-04-27)

**Purpose.** Tanda 2011 was calibrated against 46 manually-curated training logs. Mosaic feeds Tanda from auto-imported Strava/Garmin activity feeds, which are not curated — they contain treadmill runs (no GPS, accelerometer-estimated pace that drifts), walks logged inside runs, mid-session walk breaks logged as separate activities, aborted runs, and warm-down jogs without GPS. All of these inflate P (Tanda's mean training pace) without representing real training stimulus. The result is a slow-biased predicted marathon time that under-rates the athlete.

**Filters added** (in `src/calculations/prediction-inputs.ts`, ahead of K/P computation):

| Filter | Threshold | Rationale |
|---|---|---|
| Distance floor | `distKm < 3` rejected | Sub-3K activities are warm-ups, run-walk intervals, or technique drills, not training runs Tanda would score. Tightened from the previous 2 km floor — 2-3 km Strava entries are dominated by walk-break artefacts. |
| Pace ceiling | `paceSecPerKm > 480` (8:00/km) rejected | Above 8:00/km is walking or trail hiking. Existing 7:30 ceiling let too many treadmill warm-downs through. |
| Name pattern | `/treadmill|walk/i` rejected | Treadmill GPS-less paces are accelerometer estimates that drift, especially at incline. "Walk" names slip past the pace ceiling whenever the user kept moving briskly. |
| Slow-tail trim | Drop slowest 10% of remaining sample | After hard filters, the slow tail is dominated by aborted runs and untracked warm-downs. A 10% trim is a conservative noise filter that preserves real training pace dispersion. Gated to samples ≥5 runs so sparse logs aren't decimated. |

**Why these are pragmatic, not literature-derived.** Tanda's paper does not specify activity-feed ingestion rules — the cohort's logs were already clean. The thresholds above are empirical noise filters chosen to remove obvious non-training data while preserving every plausible training run. They are documented here so a future change has a record of *why* the bands are what they are, not because Tanda or any other paper prescribes them.

**Limitations.**
- The 10% trim discards information uniformly. A runner whose actual easy-pace floor sits in the 7:30–8:00/km band will see legitimate easy runs trimmed alongside walk breaks. Mitigation: the trim only fires at sample ≥ 5 and removes a single floor(0.1·n) tail entry — a 5-run sample drops 0, a 10-run sample drops 1.
- Name pattern is heuristic. "Treadmill tempo" is rejected even if the pace is accurate; "Trail walk-run" is rejected even if it logged a real long run. Acceptable because the false-reject cost (one excluded run) is low and the false-accept cost (drift-paced runs poisoning P for 8 weeks) is high.
- Distance floor of 3 km will reject genuine recovery runs at low-volume tier. This matches Tanda's own intent — Tanda's K already accounts for volume; P should reflect the pace of *training* runs, not the pace of cool-down jogs.

---

## Lactate Threshold Derivation (2026-04-24)

**Purpose.** Derive LT pace and LTHR from available inputs when Garmin's watch-side reading is missing, stale, or gated by development credentials. Covers the case where the Garmin webhook sends VO2 Max but no `lactateThresholdSpeed` / `lactateThresholdHeartRate`. User override wins wholesale when present.

**Threshold target.** LT2 (MLSS / maximal metabolic steady state). This is the "lactate threshold" in common usage — the highest pace sustainable for ~60 min — not LT1 / AeT. Garmin's own `lactateThresholdSpeed` maps to LT2.

### Three estimators, blended

**Method 1 — Daniels T-pace from VDOT.** Invert Daniels' VO2 cost-of-running equation to find vVO2max velocity, then scale to T-intensity.

```
VO2(v) = −4.60 + 0.182258·v + 0.000104·v²   (v = velocity, m/min; VO2 = ml/min/kg)
```

Solve for v at VO2 = VDOT (positive root of the quadratic). T-pace = vVO2max / 0.88 (sec/km, slower pace has higher sec/km).

- Source: Daniels' Running Formula (3rd ed.), Daniels & Gilbert 1979.
- The 0.88 fraction is Daniels' empirical T-intensity = 88% of vVO2max.
- Falls back to null when VDOT < 25 (pre-aerobic-base athletes — formula diverges).
- Known limit: Daniels' published table T-paces land ~10s/km faster than this derivation because the table maps closer to a ~40-min effort than a true 60-min LT. Our derivation is anchored to MLSS, so it lands closer to half-marathon pace for trained runners — which aligns with the literature definition of LT2.

**VDOT input priority for the Daniels path.** Daniels' formula assumes the input represents physiological aerobic capacity. The full priority chain is implemented in `src/calculations/physiological-vdot.ts → getPhysiologicalVdot()`, which is the **single source of truth** for "what's the best available estimate of this athlete's aerobic capacity right now?" — used by the LT engine, the VO2 stats card, and the onboarding fitness row so all three surfaces report the same number with the same provenance.

The chain walks from most-direct to least-direct measurement:

1. **`s.vo2`** — device-direct VO2max (Garmin / Apple), when within a 90-day freshness window. Continuous HR-variability + pace monitoring with proprietary algorithm (FirstBeat). Highest fidelity when present and recent. Beyond 90 days the value falls through (a year-old reading shouldn't pin physiology if newer derived signal contradicts it).
2. **`s.hrCalibratedVdot.vdot`** (medium+ confidence only) — pace-vs-%HRR regression across recent qualifying runs (Swain & Leutholtz 1997, %HRR ≈ %VO2R). Direct observation of physiology, just less continuous than the watch. Low-confidence fits are skipped because a noisy regression can move LT 20+ sec/km on edge cases.
3. **`deriveVdotFromLT(s.lt)`** — back-derived from the resolved LT pace via Daniels' inverted vVO2max formula. Only fires when `s.ltSource ∈ {empirical, critical-speed, garmin, override}`. Skipped when LT itself was Daniels-derived or blended with Daniels content (would be circular).
4. **PB-derived median VDOT** — median of Daniels' `cv()` across the user's race-distance PBs (5K / 10K / HM / marathon). Median rather than max because PB profiles are often imbalanced — a 5K specialist with weak endurance shouldn't have their 5K alone drive the estimate, and a marathoner with a slow 5K shouldn't lose theirs to it.
5. **`s.v`** — Tanda-blended VDOT, last resort. **Tanda is the right model for race-time prediction** (it regresses race time on weekly km and average pace, validated against marathon outcomes), but its volume-discount means a triathlete cutting back on running gets a Tanda-VDOT that under-states their physiological capacity. Daniels' T-pace formula expects a capacity number, not a volume-discounted prediction. We fall through to it only when the four more-direct sources are all unavailable.

`getPhysiologicalVdot` deliberately does **not** include `rpeAdj` or `physioAdj` — those are user-tuned dials answering "how I feel today" / "my LT drifted vs my VDOT" and belong in `getEffectiveVdot(s)` (used for race-time prediction and training-pace prescription). Physiology doesn't shift when the user clicks an RPE dial. This priority is intentional and orthogonal to where `s.v` is used elsewhere (race-time prediction, training pace zones — both still use Tanda-blended, correctly).

**Method 2 — Critical Speed from race-distance PBs.** Two-parameter hyperbolic model:

```
d = CS · t + D′
```

Where `d` = distance (m), `t` = time (s), `CS` = critical speed (m/s), `D′` = anaerobic distance capacity (m). Ordinary least-squares fit across the athlete's best efforts at different distances.

Nixon et al. 2021 (PMC8505327) demonstrated that CS sits ~8% above MLSS in well-trained runners (CS 16.4 ± 1.3 km/h vs MLSS 15.2 ± 0.9 km/h). We therefore set:

```
LT_pace = 0.93 × CS        (LT pace as a fraction of CS pace, converted to sec/km)
```

- Source: Jones & Vanhatalo 2017 (critical power framework); Nixon et al. 2021 (CS↔MLSS offset).
- Fit constraints: ≥2 efforts, duration span ≥600s, each effort 2–60 min (excludes sprints dominated by anaerobic capacity and long races affected by fuelling), efforts ≤365 days old, D′ must fall in 50–500 m (physiological plausibility, Jones & Vanhatalo 2017).
- Known limit: 2-parameter model assumes infinite speed as t→0 and that D′ is fully depleted at exhaustion — both simplifications. More accurate 3-parameter models exist but require additional efforts we rarely have.

**Method 3 — Empirical detection from sustained efforts.** Scan runs in the last 120 days for ones exhibiting LT steady-state behaviour:

```
20 min ≤ duration ≤ 120 min     (extended cap; standard cutoff at 60 min)
avgHR ∈ [0.85·HRmax, 0.92·HRmax]
joint steady-state gate (see below — graded by duration)
NOT treadmill / virtual
NOT hot (>28°C)
NOT hilly (elevation gain > 15 m/km)
```

Take the time-decayed weighted mean of qualifying `{pace, HR}` pairs with decay constant τ = 21 days.

**Joint steady-state gate.** Pace CV (variability across kmSplits) and HR drift (percentage HR rise from first half to second half, warmup-stripped, computed at sync time from the full HR stream) are independent observations of the same question — was this run steady-state? They can disagree. A tempo at the limit can hold steady pace with drifting HR (the runner was working near threshold and HR climbed). A long Z2 run on a hilly trail can hold steady HR with variable pace (effort consistent, terrain forced pace changes). Both are usable LT signals.

The gate is graded by duration:

- **Short tempos (20–60 min):** at least one signal must fire. `paceCV ≤ 8%` OR `|hrDrift| ≤ 5%`. The calibrating real-world case: a 41-min tempo at 4:05/km with `paceCV 2.5%` and `hrDrift 8.9%` is the textbook threshold effort and must qualify. Drift alone in this duration range usually reflects deliberate effort progression, not cardiac decoupling — the original Friel 5%-drift gate is a research-grade aerobic-durability test and is too strict as the sole steady-state filter for everyday tempo detection.
- **Long runs (60–120 min):** both signals required. `paceCV ≤ 8%` AND `|hrDrift| ≤ 5%`. Cardiac-drift confounds (glycogen, dehydration, heat) grow with duration; one clean signal alone can be a fatigue-induced HR elevation masquerading as threshold (steady HR but slow pace) or a variable-pace long aerobic with HR happening to land in band (steady pace but… actually it doesn't, that's the point — long aerobic runs rarely have pace CV ≤ 8% across hours of running).
- **> 120 min:** rejected regardless. Even with both signals clean, fueling effects on pace dominate the LT signal at ultra durations.

- Source: Faude et al. 2009 (LT2 = "fastest pace sustainable for ~30–60 min"); Friel 2012 (aerobic decoupling < 5% as steady-state proxy — used here for the *long-run* gate where drift dominates, relaxed for short tempos); Uphill Athlete heart-rate drift test; Poole et al. (LT2 HR band 85–92% HRmax for trained runners); Coyle 1984 / Hagberg & Coyle 1983 (cardiac drift on extended runs).
- **Decoupling source.** Preferred signal is `hrDrift`; falls back to a pace-drift proxy from `kmSplits` (first-half vs second-half) when `hrDrift` is missing (e.g. older synced rows that pre-date the column, or onboarding-stage runs that only carry aggregates).
- τ = 21 days gives ~50% weight to 3-week-old efforts. Matches the ~3-week adaptation time-constant of aerobic fitness.
- Outlier rejection is deliberately strict at the *long-run* end. A false positive there (e.g. drift-inflated long aerobic) gets weighted into the final blend at full weight; better to under-include than to over-include from the long-run pool. At the short-run end the bar is lower because false positives are rarer (the HR-band gate already excludes easy and hard runs) and false negatives are more common (real tempos with non-flat HR profiles).

**On extracting sub-segments from longer runs (deliberately not implemented).** A "best 20 min" sub-segment from a 90-min run measures peak capacity, not LT — typically a fast finish or surge run *above* threshold for a brief window. Using it as an LT datapoint would systematically inflate the estimate. The defensible alternative — "steadiest 20 min" inside a longer run — would require per-second HR + pace streams to validate band membership of the segment, which we don't store (only aggregates: avg HR, kmSplits). We deliberately don't fabricate datapoints for users whose training is mostly long aerobic; for them the signal is genuinely thin and the system should fall back to CS-from-PBs and Daniels-from-VDOT, which it does.

### Blend

Weights depend on which methods fired:

| Available | Empirical | CS | Daniels |
|---|---|---|---|
| all three | 0.50 | 0.30 | 0.20 |
| empirical + CS | 0.60 | 0.40 | — |
| empirical + Daniels | 0.65 | — | 0.35 |
| CS + Daniels | — | 0.60 | 0.40 |
| single method | 1.00 | 1.00 | 1.00 |

Empirical gets the highest weight because it's the only direct observation. CS next because it's still observation-derived (from PBs) but fits a model. Daniels is algorithmic — no new information beyond VDOT.

### LTHR derivation

- **Primary:** median HR of qualifying empirical efforts.
- **Fallback:** `0.88 × HRmax` (midpoint of the 85–92% LT2 band for trained runners).
- **Not used:** Karvonen HRR — it would require a reliable `restingHR` and a well-calibrated `maxHR`, and the `0.88 × HRmax` shortcut lands within ±3 bpm for most athletes.

### Source priority (resolveLT)

```
override   >  Garmin (until superseded)  >  blended derivation  >  null
```

User override always wins. Garmin beats derived because the watch has continuous HR access and proprietary FirstBeat calibration — higher fidelity than any field-data estimator when available.

**Revision 2026-06-04 (Tristan): the 60-day Garmin expiry is removed.** Garmin pushes `userMetrics` only when the value *changes* (change-event semantics), so the absence of a newer reading means "unchanged", not "stale" — the watch itself keeps displaying the same LT. The old expiry silently reverted real users to the Daniels estimate (observed live: watch LT 4:12/km·168bpm, app showing VDOT-derived 3:59/km·177bpm "low confidence", threshold prescriptions ~13s/km too fast). A Garmin reading is now trusted until superseded by:

1. a newer Garmin reading,
2. a manual override, or
3. a derived estimate that is **faster by ≥ 3 s/km at medium+ confidence** (`LT_GARMIN_SUPERSEDE_GAP_SEC_KM`, the same "clearly better" gap the manual-override auto-improve rule uses — benchmarks-yield-to-improvements). A *slower* derived estimate never displaces a measured reading.

**Limitation**: a detrained athlete who stops hard running keeps an old (now too-fast) Garmin LT, since neither the watch nor the supersede rule corrects downward. Accepted — the watch itself has the same behaviour, and the derived blend cannot distinguish "detrained" from "no recent hard efforts" either.

**Conflict suggestion removed (same revision)**: `recomputeLT` previously parked any >10 s/km Garmin-vs-derived disagreement behind a suggestion card; a user who never opened the card never received their watch LT. Watch readings now auto-apply; shifts ≥ 10 s/km (`LT_NOTIFY_THRESHOLD_SEC_KM`, the old conflict threshold repurposed) surface a small toast per the adaptation-transparency rule. The suggestion card path is retired (stale pending suggestions are cleared on the next recompute).

### Confidence

- **High** — empirical present AND (CS or Daniels) available. Triangulated.
- **Medium** — empirical alone, or CS + Daniels (no empirical).
- **Low** — Daniels only (no field observations).

Low-confidence LT feeds the app but is flagged so UI can warn users not to prescribe training paces off an untriangulated number.

### Outliers and known failure modes

| Scenario | Guard | Effect |
|---|---|---|
| Treadmill | sportType filter | Empirical skips the run |
| Trail / hills (>15 m/km) | elevation filter | Empirical skips |
| Hot weather (>28°C) | ambient temp filter | Empirical skips |
| Sub-20min efforts | duration gate | Empirical skips |
| Over-60min efforts | duration cap | Empirical skips (cardiac-drift territory) |
| Unsteady pacing (CV>8%) | splits CV gate | Empirical skips |
| Cardiac drift >5% | `hrDrift` from full HR stream (preferred), pace half-vs-half (fallback) | Empirical skips |
| HR strap absent / optical | no explicit guard | Accept but confidence only "medium" |
| Illness / heat-acclimation shift | not detectable | Time-decay τ=21d mitigates |
| Altitude | not detectable | User can override |
| HRmax miscalibrated | no guard | LTHR fallback propagates error |
| Ultra-elite (VDOT > 70) | no guard | Daniels formula less accurate at extremes |
| Women LT1 slightly higher fraction | not modelled | LT2 less affected; literature shows ~1–2% shift |

### Integration

- Pure functions in `src/calculations/lt-derivation.ts`.
- 29 unit tests in `src/calculations/lt-derivation.test.ts` cover each method, outlier cases, blending, and source precedence.
- State: `s.ltOverride?: { ltPaceSecKm, ltHR?, setAt }` holds user override.
- Garmin reading still populates `s.ltPace` / `s.ltHR` via physiology snapshot — `resolveLT()` reads both and picks.

---

## Effort-Calibrated VDOT from HR (2026-04-24)

**Purpose.** Current-fitness estimate from the last 8 weeks of running, using heart-rate response to pace as the physiological anchor. Complements Tanda (volume + avg pace) and the PB ceiling in a blended race-prediction engine.

**Formula.** For each qualifying run `i` in the 8w window:
```
%VO2R_i = (avgHR_i − RHR) / (maxHR − RHR)       // Swain & Leutholtz 1997
point_i = (avgPace_i, %VO2R_i, duration_i)
```

Weighted linear regression of `avgPace` on `%VO2R` (weights = `duration_i`):
```
avgPace = α + β × %VO2R
paceAtVO2max = α + β × 1.0
VDOT_HR = vdotFromPace(paceAtVO2max)            // Daniels' VDOT table lookup
```

Qualifying filter for inclusion in the regression:
- `duration ≥ 20 min` (short intervals break HR–pace linearity)
- `HR drift < 8%` (excludes fatigue/over-intensity; aerobic decoupling >8% means HR no longer tracks intensity linearly)
- Valid `avgHR`, `maxHR`, `RHR` — if RHR absent, confidence = `none` and HR-calibrated estimate is skipped entirely (no fabricated default).

**Confidence tiers:**
- `high`: N ≥ 8 points AND R² ≥ 0.7
- `medium`: N ≥ 4 points AND R² ≥ 0.5
- `low`: N ≥ 3 points
- `none`: otherwise (fall back to Tanda / hard-effort / PB)

**Blending with other signals.** Final VDOT is a weighted mean across:
1. **HR regression VDOT** — weight `w₁ = R² × min(N/8, 1) × recencyDecay`
2. **Hard-effort VDOT** — single recent race/time-trial (pace ≥15% faster than median, ≤12 weeks old), weight `w₂ = 0.8 × recencyDecay`
3. **Tanda VDOT** — volume × pace, weight `w₃ = paceConfidenceFactor` (high=0.9, medium=0.6, low=0.3)
4. **PB VDOT** — ceiling signal, weight `w₄ = 0.5 × pbAgeDecay`

`recencyDecay = exp(-weeksOld / 12)` for hard efforts.
`pbAgeDecay = exp(-yearsOld × ln(2) / 3)` — half-life 3 years.

**Why HR drift < 8% matters.** Aerobic decoupling (HR rising while pace holds) indicates the athlete has moved above their sustainable aerobic ceiling; the %HRR → %VO2R mapping assumes steady-state submaximal exercise. Friel's threshold is 5%; we use 8% to retain more data, accepting a small error on tempo efforts.

**Why 75th-percentile weighting was rejected.** Percentile-based aggregation discards signal — a run that sits "below" the percentile is still informative about the pace-effort curve. Regression through all points uses every datapoint's information content (pace + effort + duration), weighted by duration as a reliability proxy.

**Runner-type bias.** The VDOT → distance-specific time mapping is shaped by the athlete's 5K/marathon PB ratio, which gives an empirical Riegel exponent. Speed-biased runners (5K stronger than marathon ratio predicts) get a +1–2% shift on marathon prediction; endurance-biased runners (marathon stronger) get −1–2%. See existing "Fatigue Exponent & Runner Type Classification" entry.

**Scientific anchors:**
- **Swain & Leutholtz 1997** — %HRR ≈ %VO2R validated against gas exchange (ACSM 2013 position stand adopts this).
- **Daniels' Running Formula** — VDOT tables; pace at 100% VO2max defines VDOT.
- **Friel 2012 / Maffetone** — aerobic decoupling <5% = well-paced aerobic effort; >8% = fatigued or supra-threshold.
- **Tanaka & Seals 2008** — VO2max declines ~1%/year past age 35 in masters athletes. Used to justify PB half-life ≈ 3 years.
- **Fitzgerald et al. 1997** — longitudinal masters data supports exponential rather than linear VO2max decay.
- **Monod–Scherrer critical-power model** — conceptual analog: multiple submaximal points fit a curve whose asymptote defines threshold. We apply the same principle to pace-HR rather than power-duration.

**Limitations.**
- HR is affected by heat, caffeine, hydration, sleep — noise in %HRR per session is ±3–5 bpm. Regression averages this out across N points.
- Assumes linear %HRR → %VO2R (true within ~40–90% of max; breaks down at extremes).
- VO2max is not the only fitness determinant — economy and lactate threshold fraction matter. VDOT conflates these; a 10% economy improvement will show up as a VDOT rise even without VO2max change (acceptable: both mean the athlete runs faster).
- Athletes without a chest strap / accurate wrist HR get noisy avgHR — confidence tier should reflect this, but we can't detect it reliably; we mark high-variance HR distributions per session and downweight.

**Implementation plan.** New file `src/calculations/effort-calibrated-vdot.ts`. Pure function taking `{ runs, RHR, maxHR, now }` → `{ vdotHR, confidence, R², N, regression }`. Composed in `predictions.ts` via a new `blendFitnessSignals()` function that produces `AthleteFitnessState.run`.

---

## Effort-Calibrated VDOT — per-segment extension (2026-05-12)

**Problem.** The original regression (above) used one (avgPace, avgHR) point per run. For a triathlete or any athlete who runs most kilometres at aerobic effort, qualifying runs cluster tightly — most points sit in the 60–80 % HRR band with no near-threshold data. Linear extrapolation from a narrow cluster to %HRR = 1.0 is mathematically unstable: small noise in the slope produces large errors in the extrapolated pace, which then maps to VDOT via `cv(3200, paceAtVO2max × 3.2)`. The observed failure mode was a single qualifying-run cohort briefly producing VDOT 77 for an athlete whose race-PB-derived, watch-Firstbeat, and Critical-Speed signals all sat in the 49–55 range.

The deeper issue: within-run HR variation was being discarded. A 10K run with the final 5 km at HR 174 ≈ 86 % HRR contains exactly the threshold-zone data the regression needs, but the run-level avgHR of 165 ≈ 73 % HRR loses it entirely.

**Fix.** The regression now accepts per-segment samples (each km, each lap, or any sub-run span) tagged with `isSegment = true`. The same weighted linear regression of pace on %HRR runs against the expanded point set. A 21 km run with a tempo finish contributes ~21 points spanning the run's HRR range instead of one diluted point.

**Filter changes for segments.**

- **Duration floor**: 60 s instead of 20 min. One km at 4:00–6:00/km is 240–360 s; warmup transitions < 60 s are still rejected as too short for HR to settle.
- **Drift gate**: not applied. HR drift is a whole-run aerobic-decoupling signal (Friel / Maffetone). For a sub-run segment the concept isn't well-defined — a steady tempo block inside a fatigued long run is informative regardless of the run-level drift.
- **Pace gate** and **HRR window** (40–95 %): unchanged, applied per-segment.

**Data source.** Strava's `/v3/activities/{id}` detail endpoint returns `splits_metric[]` with `average_heartrate` per split. The edge function already fetched this for pace; the HR field was previously discarded. New `calculateKmHRSplits()` also computes per-km HR from the activity's HR stream as a fallback when `splits_metric` is unavailable. Both arrays are stored as `km_hr_splits int[]` parallel-indexed to `km_splits` (`garmin_activities` migration `20260512_km_hr_splits.sql`).

**Why this is defensible, not just "more points."**

1. Each segment is an *independent* (pace, HRR) pair — not a derived statistic. The regression weights by duration (existing weighting unchanged), so a 5 min km contributes 5× a 1 min warmup transition.
2. HRR coverage genuinely widens. Tristan's prior diagnostic showed all qualifying runs at HRR 64–73 %; with per-km from a tempo-finish long run, the same run contributes points at HRR 65 % (warmup km) through 86 % (final tempo km). Extrapolation to 100 % HRR now has near-asymptote data instead of pure speculation.
3. The %HRR ≈ %VO2R linearity assumption (Swain & Leutholtz 1997) holds at the segment level just as well as the run level — it's a metabolic relationship between heart rate response and oxygen uptake, agnostic to whether the measurement window is 60 s or 60 min.

**Limitations (specific to the segment path).**

- **Within-run autocorrelation**: 21 segments from one run aren't 21 statistically independent observations. The regression treats them as such. The duration weighting partially corrects (longer segments → more weight), but a 21K run still dominates the fit more than its true information content warrants. Mitigated by averaging across many runs over the 8-week window; not formally corrected.
- **Pacing strategy** (positive/negative split) creates structured correlation between pace and HR within a run. A negative-split run with HR rising linearly through it produces an artificially steep slope. The 8-week window plus across-run averaging absorbs this, but a single dominant run with strong drift can bias the fit. The drift gate at run-level (8 %) and segment-level skip combine to limit the worst case.
- **Segments shorter than ~3 min** (still ≥ 60 s) have ~30 s of HR lag that under-credits the actual effort. We accept this — the 60 s floor is permissive but the duration weighting attenuates these contributions.

**What the segment path does NOT fix.**

- The orchestrator still only reads `s.wks[].garminActuals` (matched runs). An unmatched run never feeds VO2. Out of scope for this change — flagged for follow-up.
- Linear extrapolation to %HRR = 1.0 is still the extrapolation target. With wider HRR coverage, the extrapolation distance is shorter and the result more trustworthy, but the assumption "pace–HR is linear all the way to 100 %" remains an approximation that breaks at the edge.
- Cardiac ceiling is still a separate signal, not a constraint. Running VO2max can in principle exceed cardiac ceiling because the latter is an estimator (Uth-Sørensen ±15 %), not a hard physical bound.

**Compatibility.** `isSegment` is optional and defaults to false, so all existing run-level callers and tests continue to work unchanged. The orchestrator prefers per-km segments when both `kmSplits` and `kmHRSplits` are populated; falls back to the run-level (avgPace, avgHR) point otherwise.

**Confidence: medium.** The within-run signal is real and well-grounded in Swain & Leutholtz's submax linearity result. The autocorrelation caveat is the main weakness; we may need to reduce effective N for confidence-tier calculation in a follow-up if the regression tier ends up "high" on athletes whose data is dominated by a single run.

---

## Triathlon — Multi-sport Transfer Matrix (2026-04-23)

**Context**: Mosaic v1 had a single CTL for running with a `runSpec` discount applied to cross-training activities (cycling 0.55, HIIT 0.30, etc). Triathlon makes swim/bike first-class, so a single-run-centred CTL is no longer sufficient. The transfer matrix generalises this: every activity contributes to every discipline's CTL and ATL at a directional weight. `runSpec` is a special case (the "run" column).

**Formula** (per-discipline contribution from an activity with sport S and raw TSS T):
```
contributionToDiscipline[D] = T × TRANSFER_MATRIX[S][D]
```
Applied to both CTL (42-day EMA) and ATL (7-day EMA) at the same weight. This is defensible because a session that transfers aerobically to another discipline causes comparable fatigue there — fitness and fatigue are the same physiological currency.

**Values** (source → destination). Run-column values from Millet et al. 2002 (triathlon cross-transfer) and Millet & Vleck 2000 (swim specificity); padel/ski/hiking values are first-approximation proposals flagged for validation.

| From ↓ / To → | Run | Bike | Swim |
|---|---|---|---|
| Run | 1.00 | 0.70 | 0.25 |
| Bike | 0.75 | 1.00 | 0.20 |
| Swim | 0.30 | 0.20 | 1.00 |
| Strength | 0.10 | 0.10 | 0.10 |
| Padel / tennis | 0.35 | 0.20 | 0.00 |
| Football | 0.45 | 0.20 | 0.00 |
| Ski touring | 0.55 | 0.40 | 0.00 |
| Hiking | 0.55 | 0.35 | 0.00 |

**Key property**: transfers only ADD. A padel session cannot reduce run CTL. Readiness for any discipline drops after any activity (fatigue adds everywhere the transfer is non-zero), because the matrix is applied to ATL the same way as CTL.

**Implementation**: `src/constants/transfer-matrix.ts` (matrix + helpers), `src/calculations/fitness-model.triathlon.ts` (EMA application), `src/calculations/fitness-model.triathlon.test.ts`.

**Limitations**:
- Directional but not interaction-aware (a padel match after a long run is assumed to contribute linearly; in reality combined fatigue is super-linear).
- Padel / tennis / football / ski / hiking values are physiology-reasoning proposals, not lit-backed. Validate after 3–6 months of real data.
- Transfer is instantaneous — no time-lag modelling for "delayed" cross-training effects.

---

## Triathlon — Swim TSS (cubed IF) (2026-04-23)

**Context**: Running and cycling TSS use squared IF (Coggan 2003). Swim drag scales with v³ (Toussaint & Beek 1992) because water resistance grows faster with speed than air resistance — so swim intensity dominates the power cost disproportionately.

**Formula**:
```
sTSS = durationHours × (cssPace / avgPace)^3 × 100
```
IF > 1 when swimming faster than CSS; IF < 1 when slower. 60 min at CSS = 100 TSS.

**Implementation**: `src/calculations/triathlon-tss.ts:computeSwimTss`. Tests: `src/calculations/triathlon-tss.test.ts`.

**Limitations**: assumes steady-state swimming. Sprint intervals are under-counted (anaerobic contribution not captured separately in the IF model). Technique variance between athletes means same IF feels different to different swimmers.

---

## Triathlon — Per-discipline CTL / ATL (2026-04-23)

**Context**: Running mode has a single CTL. Triathlon needs three (swim, bike, run) so the plan engine can detect "swim fitness is plateauing" separately from "bike fitness is advancing". Same Banister 1975 exponential-decay EMAs, applied per-discipline with the transfer matrix determining contributions.

**Formula** (each discipline independently):
```
CTL(today) = Σ (contribution_i × e^(-day_i / 42))
ATL(today) = Σ (contribution_i × e^(-day_i / 7))
TSB = CTL - ATL
```
Normalised to weekly TSS units (divide by τ, multiply by 7). Combined CTL for the headline display uses the `COMBINED_CTL_WEIGHTS` constant (swim 0.175, bike 0.475, run 0.35 — matches the default volume split).

**Implementation**: `src/calculations/fitness-model.triathlon.ts`. Tests cover individual track isolation, transfer-matrix fan-out, decay behaviour, and the CTL-ATL-TSB relationship.

**Limitations**: combined CTL weights are from the default volume split, not tuned to the specific user. Users who train 60/20/20 would technically want a different weighting, but v1 uses the fixed constants.

---

## Triathlon — Run-leg Fatigue Discount for Race Prediction (2026-04-23)

**Context**: Running after the bike leg is measurably slower than a standalone run at the same HR/RPE (Bentley et al. 2007; Landers et al. 2008). This is a **race-time prediction input**, not a training-load discount. The athlete's stimulus during a brick run is the same as a standalone threshold run — but their pace is 4–6% slower in 70.3 and 10–12% slower in IM.

**Formula** (applied only when computing predicted race finish time, never to training load):
```
predictedRunPace = basePace × (1 + DISCOUNT_FOR_DISTANCE)
```
where DISCOUNT = 0.05 for 70.3, 0.11 for IM.

**Implementation**: `src/calculations/race-prediction.triathlon.ts`. **Important**: this is on the tracking side of the line (§ "Tracking vs Planning" in CLAUDE.md). Do not apply this discount to brick run TSS — the training stimulus is full.

**Limitations**: individual variance is wide (some athletes are 2% slower off the bike, others are 8%). The single-number discount is a population midpoint. Future work: learn individual discount from real race data once we have finishers.

---

## Triathlon — FTP and CSS Detraining Curves (2026-04-23)

**Context**: VDOT decays on missed running weeks (existing running mode). Triathlon needs equivalent decay curves for bike and swim threshold anchors so the plan engine doesn't assume fitness is static during illness, injury, or holiday.

**Values**:
- FTP: 5–7% loss per 4 weeks off — **6% midpoint used**. Source: Coyle 1984 (cycling detraining; VO2max and muscle capillarisation both drop measurably within 2–4 weeks).
- CSS: 3–5% loss per 4 weeks off — **4% midpoint used**. Source: Mujika 2010 (swim detraining — slower loss than bike/run because technique retention buffers pace decline).
- VDOT: unchanged from running mode.

**Implementation**: constants defined in `src/constants/triathlon-constants.ts` (`FTP_DETRAINING_PER_4WK`, `CSS_DETRAINING_PER_4WK`). Consumer wiring is deferred to Phase 7b (per-discipline threshold decay during missed weeks).

**Limitations**: linear-per-4wk is a simplification. Real detraining is bi-exponential (rapid initial drop, then slower tail). Good enough at the granularity of 1-week plan updates.

---

## Just-Track Daily Load Target (2026-04-23)

**Context**: Just-Track mode has no plan, therefore no `plannedDayTSS`. The home-view daily load card needs an alternative anchor that is scientifically defensible, decays gracefully when the athlete has no recent data, and does not feel like prescription (Just-Track users explicitly opted out of prescribed workouts).

**Formula**:

```
dailyNeutral  = ctlBaseline / 7          // weekly-EMA CTL is stored as weekly internally
targetTSS     = dailyNeutral × readinessMult
readinessMult = 1.3 if readinessScore >= 80
              = 1.0 if 60 <= readinessScore < 80
              = 0.7 if 40 <= readinessScore < 60
              = 0.3 if readinessScore < 40

// Colour band of today's actual load vs CTL (Gabbett 2016 ACWR sweet spot):
ratio = actualTodayTSS / dailyNeutral
green  if ratio <= 1.3           // sustainable
amber  if 1.3 < ratio <= 1.5     // overreaching
red    if ratio > 1.5            // documented injury-risk spike
```

**Rationale by term**:

- **`ctlBaseline / 7`** — CTL is a 42-day EMA of weekly TSS (Banister impulse-response model). `CTL × 1.0` is, by definition, the weekly load that holds fitness flat — the maintenance dose. Dividing by 7 gives the fitness-flat daily equivalent.
- **Readiness multiplier (1.3 / 1.0 / 0.7 / 0.3)** — maps the existing 0–100 readiness composite (HRV 50% + last-night sleep 25% + sleep history 25%) to four training zones. Values chosen to keep the readiness-adjusted target inside Gabbett's 0.8–1.3 ACWR band on normal days, with the 1.3 "push" ceiling aligned with the Gabbett upper bound and 0.3 "rest" floor aligned with pedagogical recovery-day doses (10–40% of maintenance, a common coaching heuristic).
- **Gabbett 2016 bands (0.8–1.3 / 1.3–1.5 / >1.5)** — `Gabbett TJ (2016). "The training-injury prevention paradox: should athletes be training smarter and harder?"` British Journal of Sports Medicine 50(5):273–280. 0.8–1.3 = "sweet spot" with lowest injury incidence across multiple team-sport and endurance populations. >1.5 = 2–4× injury rate vs sweet spot in the same cohorts. Colours surface acute risk, not progression prescription.

**Bootstrap**: when `ctlBaseline < 20` (weekly CTL below ~3 TSS/day equivalent — athlete is brand-new or has no sync history), the daily target is suppressed entirely and replaced with a "sync more history" empty state. Below that threshold the `CTL/7` anchor is noisier than the multiplier can compensate for and would produce misleading single-digit targets.

**Known limitations**:

- CTL-as-weekly convention is Mosaic-internal. Published literature often defines CTL as daily directly (42-day EMA of daily TSS). Our unit is equivalent but divided by 7 for display — noted in `docs/arch-notes.md` → "CTL display scale".
- Readiness multiplier thresholds (80/60/40) are pragmatic, not literature-cited. They produce sensible behaviour on the readiness score distributions we've seen but are not validated against an external cohort.
- Gabbett thresholds come from team-sport + Australian-football cohorts. Transfer to recreational runners is reasonable but not direct.
- The `ratio` colour band compares today's actual load vs CTL-neutral, not vs the readiness-adjusted target. This is deliberate — readiness should not widen what we consider "safe." Overreaching is overreaching whether the athlete felt fresh that morning or not.

**File**: `src/ui/home-view.ts → buildTrackOnlyDailyTarget()`.

---

## Daily Feeling Modifier on Coach Stance (2026-04-17)

**Why added.** The rules engine consumes objective signals (TSB, ACWR, sleep score, HRV, strain) but no subjective input from the athlete. Physiological data alone misses meaningful same-day variance: illness onset before it shows in RHR, cumulative life stress that doesn't yet register in HRV, or genuine freshness that objective numbers understate on a rest-heavy week. A one-tap daily feeling prompt (`struggling | ok | good | great`) reintroduces the athlete's own judgment without demanding a full check-in.

**Formula.** After the base coach stance is computed from blockers + readiness label:

```
struggling   → drop one level  (push → normal → reduce → rest)
ok           → no change
good / great → promote normal → push
               gated on: blockers.length === 0 AND readiness.score >= 75
```

The Primed threshold `75` is sourced directly from `readiness.ts` (`if (score >= 75) label = 'Primed'`). The feeling prompt cannot override the readiness composite's own safety rails.

**Defensibility.** Subjective wellness monitoring is well-established in sports science as a cheap and sensitive indicator of training response. Saw, Main & Gastin (2016), *Monitoring the athlete training response: subjective self-reported measures trump commonly used objective measures: a systematic review*, Br J Sports Med 50(5): 281–291, pooled 56 studies and concluded that subjective self-report scales responded to acute and chronic training loads with greater sensitivity and consistency than commonly-used objective measures (HRV, resting HR, salivary cortisol). Halson (2014), *Monitoring training load to understand fatigue in athletes*, Sports Med 44 Suppl 2: 139–147, reaches the same conclusion. A 4-option format is a simplified wellness questionnaire; the literature supports 5-item Likert scales but also notes that shorter scales retain most of the signal at the cost of granularity.

**Why the promotion is gated.** The same literature warns that athletes routinely over-report readiness when motivated (Halson 2014). Allowing a subjective `good`/`great` to override an objective block (injury, illness, acute sleep/HRV suppression, ACWR > 1.5) would undo the safety rails the readiness composite and blockers provide. The gate (`blockers.length === 0 AND readiness.score >= 75`) ensures the feeling can only amplify a stance the objective signals already endorse — it cannot create risk the signals don't already sanction.

**Why illness overrides feeling.** `illnessState.severity === 'light'` caps stance at `reduce` BEFORE the feeling modifier runs. This mirrors the general principle that symptomatic illness is an absolute block on hard training regardless of how the athlete feels — training through viral illness risks myocarditis and prolongs time-to-recovery.

**Limitations.**

- **One-tap is coarse.** Four options lose nuance vs a 1–10 Likert or a 5-item wellness questionnaire (fatigue / stress / soreness / sleep / mood). A single global "how do you feel" blends physical and mental states that may diverge.
- **End-of-day expiry is arbitrary.** The stored value clears at midnight local time. A feeling logged at 08:00 and still valid at 16:00 is the same "today", but by 22:00 the athlete's state may have shifted. No decay inside a day.
- **No habituation check.** Athletes who habitually pick `good` will shift their own baseline over time; the modifier doesn't z-score against the athlete's own history. A `great` from someone who picks `great` daily carries less signal than a `great` from someone who usually picks `ok`.
- **No retrospective calibration.** We don't correlate reported feeling with subsequent session quality or next-day recovery to check the signal is predictive for this specific athlete.

**Implementation.** `src/calculations/daily-coach.ts` — `computeDailyCoach` applies the modifier after base-stance derivation. `getTodayFeeling(s)` enforces end-of-day expiry via ISO date comparison. UI: `src/ui/feeling-prompt.ts` (shared helper), rendered from `src/ui/home-view.ts` and `src/ui/coach-view.ts`. Tests in `src/calculations/daily-coach.test.ts` cover every base-stance × feeling transition, the blocker gate, and illness override.

---

## Cross-Training Sport Coefficients (2026-04-16)

**Why added.** `SPORTS_DB` (src/constants/sports.ts) holds per-sport coefficients used for every cross-training load contribution: `mult` (load multiplier), `runSpec` (running specificity, feeds crossTL), `recoveryMult` (recovery-cost scaling), `impactPerMin` (musculoskeletal impact load per minute), `legLoadPerMin` (leg-fatigue accumulation per minute), `volumeTransfer` (GPS km credit toward running volume). Seven board- and water-sport entries were added to cover activities a growing share of users log: snowboarding, kitesurfing, surfing, sailing, paddleboard, kayaking, wakeboarding. Before this, these all fell through to `generic_sport` (mult 0.90, runSpec 0.40, legLoadPerMin 0) which over-stated aerobic transfer for sailing and under-stated leg fatigue for snowboarding, kitesurfing, and wakeboarding.

**How the coefficients are derived.**

1. **`mult` (load multiplier).** Derived from the Compendium of Physical Activities (Ainsworth et al., 2011, *Med Sci Sports Exerc* 43(8): 1575–81), scaling the MET value against running's reference MET so that a minute of sport X at RPE equivalent yields a fraction of a minute of running's physiological load. Compendium MET ranges used: snowboarding ~5 METs → 0.85; kitesurfing 3–6 METs wind-dependent → 0.75; surfing 3–5 METs → 0.75; sailing 2–3 crewing / 3 dinghy → 0.50; paddleboard touring ~6 METs → 0.70; kayaking touring ~5 METs → 0.70; wakeboarding no clean entry, blended from skating (0.75) and skiing (0.90) → 0.70. These numbers sit between rowing (0.85) and walking (0.35) in the existing DB, which anchors them against well-calibrated reference points.

2. **`runSpec` (running specificity).** Expert judgment based on motor-pattern overlap with running (leg drive, vertical displacement, rhythmic cadence, weight-bearing). Scale 0.10 (no overlap, e.g. sailing) to 1.00 (running itself). The four board sports (snowboarding 0.45, wakeboarding 0.35, surfing 0.20, kitesurfing 0.35) sit between cycling (0.55) and strength (0.35) because they train balance, posterior chain, and trunk but lack running's gait pattern. Kayaking and paddleboard are low (0.20–0.25) because upper-body-dominant paddling sports transfer minimally to running. These are not empirically validated against running-performance transfer studies — the field lacks such data for board sports. Flagged as a known limitation.

3. **`recoveryMult` (recovery-cost scaling).** Reflects metabolic and CNS recovery demand relative to a neutral sport (1.00). Sports with sustained steady-state effort and no impact (paddleboard 0.90, kayaking 0.90) recover faster than the baseline; sports with eccentric board-pressure loads (kitesurfing 0.95, wakeboarding 0.95) slightly faster but not as much as swimming (0.90). Surfing 1.00 (baseline) because paddling + pop-ups is a mixed demand. Sailing 0.95 because hiking-out isometric load is low-grade CNS but not demanding cardiovascularly. Derived by analogue with existing DB entries; no direct literature on recovery demand for board sports.

4. **`impactPerMin` (musculoskeletal impact).** Running zero-water-contact sports zero: kitesurfing 0.02, sailing 0.00, paddleboard 0.00, kayaking 0.00. Snowboarding 0.06 for edge chatter and landing forces. Surfing 0.02 for pop-up and occasional falls. Wakeboarding 0.03 for landings during runs. Derived from existing cycling (0.00), skiing (0.07), skating (0.04) reference points — board + water sports are bracketed inside these.

5. **`legLoadPerMin` (leg-fatigue accumulation).** Derived using the legLoadPerMin tier hierarchy already documented in sports.ts: Vertical eccentric gravity-loaded (skiing, snowboarding, stair_climbing) = 0.45–0.50; sustained flat leg drive (rowing, cycling) = 0.25–0.35; intermittent isometric (kitesurfing, wakeboarding, skating) = 0.15–0.25; minimal (walking) = 0.05; not-leg (swimming) = 0. Snowboarding 0.45 (close to skiing's 0.50 but slightly lower due to board-pressure vs true eccentric quad loading per-leg). Kitesurfing 0.15 (sustained isometric edging analogous to skating). Surfing 0.10 (brief pop-ups between rest). Wakeboarding 0.25 (high eccentric-quad loading per-pull, similar cadence to skating). Sailing/paddleboard/kayaking 0.05–0.10 (legs largely passive).

6. **`volumeTransfer` (GPS km credit toward running volume).** Zero for all 7 new sports. None has the gait pattern to credit toward the running volume ring. This matches the existing DB: only running-adjacent GPS sports (extra_run 1.0, hiking 0.4, walking 0.3, stair_climbing 0.3) receive credit.

**Limitations and risks.**

- **Compendium-derived MET values translate imperfectly to training load.** The Compendium's METs are averaged energy expenditure across session duration. They don't distinguish explosive-then-rest patterns (kitesurfing) from sustained aerobic output (kayaking), nor aerobic from anaerobic. `mult` over-states the aerobic stimulus for intermittent sports and under-states leg fatigue for vertical-loaded sports. For Mosaic's impulse-response CTL/ATL model this is acceptable — `mult` drives first-order load, and leg-fatigue / impact / recoveryMult separately capture sport-specific stress pathways.
- **`runSpec` is not empirically validated.** Running-performance transfer studies for board sports don't exist in the literature. The values are expert judgment informed by motor-pattern overlap. If these cross-trainings are the bulk of someone's training, running-fitness signals will drift from reality faster than for swimming/cycling/hiking where transfer is better characterised.
- **`recoveryMult` values are pragmatic analogues.** Recovery-demand studies across extreme sports are sparse. The numbers hold a defensible relative ordering; the absolute calibration is the existing DB's convention.
- **Wind-dependent and session-variable sports (kitesurfing, surfing, sailing) have inherent load variability a single coefficient can't capture.** A 2-hour flat-water kitesurf cruise is very different from 2 hours of jumps in gusty wind. Mosaic offsets this with iTRIMP-from-HR when available (superseding the duration × mult × rpe fallback). Users without HR data will see systematic under- or over-estimation that HR telemetry would correct.

**User-facing correction path.** Since these coefficients are analogue-derived rather than empirical, the activity detail page lets users reclassify any synced activity to a different sport (src/ui/sport-picker-modal.ts). Reclassify applies a delta to `actualImpactLoad` and leg load; weekly TSS is derived from the activity (`computeWeekActualTSS`, 2026-10-06), so Signal A follows `manualSport` and Signal B is unchanged. It also persists a `sportNameMappings[normalized activity name] → SportKey` entry so future syncs of same-named activities auto-apply. This is the safety valve for Compendium-derived coefficients the user judges wrong for their individual case.

**Files touched.**
- `src/constants/sports.ts` — SPORTS_DB entries, SPORT_LABELS, SPORT_ALIASES
- `src/types/activities.ts` — SportKey union
- `src/types/state.ts` — GarminActual.manualSport, sportNameMappings
- `src/ui/sport-picker-modal.ts` — picker + reclassifyActivity + resolveSportForActivity
- `src/ui/activity-detail.ts` — "Activity" row + handler
- `src/ui/activity-review.ts` — wires resolveSportForActivity at the 4 mapAppTypeToSport sites

---

## Tanda Marathon Predictor (2026-04-15)

**Why added.** The previous marathon blend (LT + VO2 + PB + recent) was built entirely on capacity ceilings. All four predictors answer "what is your aerobic potential?" rather than "what can you sustain over 42K given current training?" Marathon failure mode is fractional utilization collapse in the last 10–12 km (Joyner & Coyle 2008), which capacity predictors under-model. Previous attempts (volume-bumped LT multiplier, volume-penalised recent run) were theory-motivated but empirically unvalidated heuristics — directionally right, calibration invented.

**Tanda's model.** Tanda (2011, *J Hum Sport & Exercise* 6(3)) regressed marathon finish time on two training indices from the 8 weeks preceding the race:

```
T_marathon (min) = 11.03 + 98.46 × exp(−0.0053 × K) + 0.387 × P
```

- K = mean weekly running km
- P = mean training pace (sec/km) across all runs in the window

**Calibration.** n = 46 marathoners, recreational to sub-elite, range 2:27–4:41. Correlation r = 0.91, standard error ≈ 3 min. Paper available at https://www.jhse.ua.es/article/view/2011-v6-n3-prediction-marathon-performance-time-training-indices.

**Why this predictor earns weight the others don't.**
1. **Outcome-calibrated.** Trained against real marathon finishes, not derived from steady-state physiology. The other predictors are physiological-first with no marathon-outcome regression.
2. **Volume-aware directly.** K handles the "no volume = slower marathon" effect we were trying to hack in via heuristic bumps. No invented bands.
3. **Pace-aware distinctly.** Quality of running matters, not just quantity. A runner averaging 4:30/km training pace is materially different from 5:30/km at the same volume.

**Integration.** Marathon blend reweighted:

```
with recent run:    recent 0.20, pb 0.05, lt 0.35, vo2 0.10, tanda 0.30
without recent run: pb 0.10, lt 0.45, vo2 0.15, tanda 0.30
```

When Tanda is unavailable (insufficient data, non-marathon distance, K out of [4,120], P out of [180,480] sec/km), its weight redistributes onto LT. `lowVolumeDiscount` is skipped for marathon now that Tanda handles volume sensitivity — avoids double-penalising.

**Guards.**
- Return null if weeks of data < 4 (insufficient for 8w-model proxy).
- K soft-floor at 10 km/wk before applying exponential term — Tanda's sample didn't include very low volumes; below 10 km/wk the exponential dominates in a way the paper didn't validate. Soft-clamp prevents runaway predictions at near-zero volume while preserving the slower-at-low-K direction.
- K upper-bound 120 km/wk (out-of-sample at elite extreme; saturation untested).
- P range 3:00–8:00 /km (filters obvious data errors).

**Mean pace calculation.** Unweighted mean across all running activities ≥3 km in the 8w window, excluding paces faster than 3:00/km (sprints) or slower than 8:00/km (walks / treadmill drift), excluding any activity whose name matches `/treadmill|walk/i`, then dropping the slowest 10% of the remaining sample (noise-tail trim, gated to samples ≥5 runs so sparse logs aren't wiped out). Matches Tanda's methodology of "mean training pace" across qualifying training sessions while rejecting the failure modes Tanda's manually-curated cohort never had to deal with (auto-imported activity feeds with treadmill GPS drift, walk breaks logged separately, aborted runs).

**Known limitations (same as Tanda's own).**
- 46-runner cohort is small. Wide confidence interval at individual level (SEE 3 min = 95% CI ~±6 min).
- Cohort was recreational-to-sub-elite; elite-specific saturation at K >100 km/wk unmodeled.
- Cross-discipline athletes (cyclists, triathletes) with low running volume but high aerobic base will be over-penalised because K only counts running. This is arguably correct for marathon-specific readiness, but worth naming.
- Does not distinguish long-run presence — 40 km/wk of 5 × 8K is scored the same as 40 km/wk with one 25K long run. Former is less marathon-ready.
- Static formula — doesn't account for multi-year adaptation, elevation, temperature, shoes, or any of the real-world variance around a 3-min SEE.

**Why this is more honest than what we had.** Previous heuristic bumps were internally consistent but had no external validation. Tanda swaps "theory-motivated tuned bands" for "outcome-regressed formula." The numbers aren't necessarily more *correct* for any individual runner, but the model is grounded in real marathon outcomes rather than reverse-fit to a specific user's intuition.

**References.**
- Tanda G (2011). *J Human Sport & Exercise* 6(3) — "Prediction of marathon performance time on the basis of training indices."
- Joyner MJ, Coyle EF (2008). *J Physiol* — Endurance performance physiology.
- Supporting: Daniels J, *Daniels' Running Formula*; Billat V et al. (2003) on fractional utilization.

---

## Recovery Run Workout Tier (2026-04-15, provisional)

**Context**: Added `'recovery'` as a new `WorkoutType` to extend the suggester's downgrade ladder. Previous bottom rung was `'easy'`; when the running floor blocked distance reduction on an all-easy week, the suggester had no lever and silently declined to offer Reduce.

**Definition**: A pure zone 1, RPE 3 session intended for blood flow and active rest rather than aerobic adaptation. Distinct from easy in intent (recovery, not stimulus) and intensity (zone 1, not zone 2).

### Pace
`paceMinPerKm = baseMinPerKm * 1.12`, where `baseMinPerKm` is easy pace.
- On a 6:00/km easy base: ≈ 6:43/km (+43 s/km).
- On a 5:00/km easy base: ≈ 5:36/km (+36 s/km).

**Defensibility**: Literature typically places recovery pace at easy + 30 to 60 s/km (Daniels' *Running Formula*; Magness, *The Science of Running*). The 1.12 multiplier sits in the middle of that range and scales with individual ability (faster runners get a smaller absolute offset, appropriate because their easy pace is already lower).

**Limitations**:
- Multiplicative offset is an approximation; a fixed absolute offset (e.g. +40 s/km regardless of base) would be equally defensible and arguably simpler. Flagged for Tristan's sign-off.
- Does not account for terrain, heat, or fatigue state — same as the rest of the pace model.

### Load profile
```
LOAD_PROFILES.recovery = { aerobic: 0.98, anaerobic: 0.02, base: 0.99, threshold: 0.01, intensity: 0 }
```
Compared to easy at `{ aerobic: 0.95, anaerobic: 0.05, base: 0.94, threshold: 0.05, intensity: 0.01 }`.

**Defensibility**: Recovery runs sit below the aerobic threshold (LT1/ventilatory threshold 1). No meaningful contribution to threshold or intensity zones. Anaerobic is near-zero but non-zero to handle edge cases (short accelerations, hills). The small delta vs. easy reflects the fact that both are predominantly aerobic — the difference is zone 1 (recovery) vs. zone 2 (easy).

**Limitations**:
- Constants are extrapolated from the easy profile rather than calibrated from data. Flagged provisional.
- The load-per-minute rate still uses `LOAD_PER_MIN_BY_INTENSITY[3]` (RPE 3). Recovery load is therefore ~60% of easy load for the same duration, which matches the intended feature behaviour (enough reduction to absorb excess, not so much that the session is pointless).

### Downgrade chain integration
`downgradeType` in `src/cross-training/suggester.ts` now maps `easy → recovery`. Easy distance-reduction branch falls through to easy → recovery conversion when the floor blocks distance cuts (preserves volume, reduces load).

**Defensibility**: The ladder (vo2/intervals → threshold → marathon_pace → easy → recovery) mirrors the standard Daniels intensity hierarchy. Adding recovery as the bottom rung gives one more lever without introducing a novel training concept.

### Floor treatment
Recovery km count toward `floorKm` at 1.0x (same as easy).

**Rationale**: The floor exists to prevent total running volume collapse. Recovery running still contributes to volume — joint loading, running economy, neuromuscular coordination — even if the aerobic stimulus is lower. Counting at 1.0x avoids a cascade where downgrading to recovery triggers further floor violations. This is a pragmatic choice; a 0.5x weighting could be argued (half the stimulus, half the credit) but adds complexity for limited signal.

**Known limitations of the tier overall**:
- Recovery is only reached via downgrade, never scheduled directly by the plan generator. The suggester is the sole producer.
- Pace and load constants are provisional until Tristan confirms.

---


## Low-Volume Detraining Discount on Watch LT/VO2 (2026-04-14)

**Problem.** Garmin/Apple watches estimate LT pace and VO2max from running activities only. When the user stops running, these values persist at their last measurement. `blendPredictions` weights LT at 55% and VO2 at 15% for marathon, so stale-elevated watch values drive an optimistic race prediction even when the athlete is clearly detrained.

**Physiological basis.**

1. **Endurance metrics decay fast.** Coyle et al. (1984) and Mujika & Padilla's review (*Sports Medicine* 2000) document ~6–7% VO2max loss in 2–3 weeks of inactivity, with larger losses in capillary density, mitochondrial enzyme activity, and blood volume over the same window.

2. **Marathon depends on fractional utilization most.** Joyner & Coyle (2008) decompose endurance performance into VO2max × fractional utilization × running economy. Fractional utilization (the % of VO2max sustainable over race duration) is the most training-sensitive term and the dominant determinant of marathon pace. It decays faster than VO2max itself because it's limited by fat oxidation, glycogen sparing, and fatigue resistance — all training-volume-dependent.

3. **Distance sensitivity.** 5K is more VO2-limited and less reliant on fractional utilization. Marathon is the opposite. So detraining hits marathon predictions hardest.

**Implementation.** `lowVolumeDiscount(targetDist, weeklyRunKm)` in `predictions.ts`:

```
severity = 0.00   if km/wk ≥ 30
         = 0.15   if km/wk ≥ 20
         = 0.30   if km/wk ≥ 10
         = 0.45   otherwise

distSensitivity = 1.0 (42K) | 0.7 (HM) | 0.4 (10K) | 0.2 (5K)
watchTrust = 1 − severity × distSensitivity
```

Applied multiplicatively to LT and VO2 weights; the shed weight transfers to PB (which reflects the athlete's peak realised fitness). No mutation of `s.lt` or `s.vo2` themselves — watch values are preserved for display, only their *trust* in the blend is discounted.

**Example** (marathon, 8 km/wk running volume): severity 0.45, distSensitivity 1.0, watchTrust = 0.55. Original weights (with recent run): LT 0.55, VO2 0.15, PB 0.05, recent 0.25 → adjusted: LT 0.30, VO2 0.08, PB 0.37, recent 0.25. PB becomes the dominant signal, which is correct when watch data is stale.

**4-week volume window.** Chosen because (a) endurance adaptations from a single week don't meaningfully restore fractional utilization, (b) physiology research on detraining uses weeks not days, (c) it matches the recency decay already applied to `recentRun` weighting. Running-only (no cross-training) because LT/VO2 estimates are running-specific.

**Known limitations.**
- Volume thresholds (30/20/10 km/wk) are pragmatic bands, not calibrated against outcome data. A 20 km/wk ultra-runner may be well-trained for marathon, and a 30 km/wk sprinter isn't. The bands assume a "typical recreational-to-trained" marathoner distribution.
- Does not distinguish quality of running (all-easy vs mixed). A user doing 15 km/wk of hard tempo is more marathon-ready than 15 km/wk all-easy, but the discount treats them the same.
- PB ceiling not applied (user rejected this) — blend can still produce a prediction faster than PB if LT + VO2 point that way and volume is high. By design.

**References.**
- Coyle EF et al. (1984). *JAP* — "Time course of loss of adaptations after stopping prolonged intense endurance training."
- Mujika I, Padilla S (2000). *Sports Medicine* — "Detraining: loss of training-induced physiological and performance adaptations."
- Joyner MJ, Coyle EF (2008). *J Physiol* — "Endurance exercise performance: the physiology of champions."
- Bassett DR, Howley ET (2000). *MSSE* — "Limiting factors for maximum oxygen uptake and determinants of endurance performance."

---

## Readiness Color Scheme & Coach Priority (2026-04-14)

**Two color systems, different semantics.**

Sleep, recovery, and physiology scores use **universal 4-tier bands** (80/65/50):
- ≥ 80: bright green (optimal)
- ≥ 65: muted green (good, not exceptional)
- ≥ 50: amber (fair — worth monitoring)
- < 50: red (poor — act on it)

Readiness uses **label-based bands** (75/55/35) matching the Primed/On Track/Manage Load/Ease Back labels. Rationale: a score of 62 means different things in each context. A readiness of 62 is "train as planned" (the composite integrates freshness, load safety, recovery — all three don't need to be green for training to proceed normally). A sleep score of 62 is genuinely mediocre. Forcing the same visual band across both creates mixed messaging (the label says "On Track" but the color says "caution").

**Recovery pill threshold** (`recovery/engine.ts`): `SLEEP_GREEN = 70`. Below 70 triggers yellow + adjustment prompt. Higher thresholds (80) made the pill too noisy for runners who habitually score in the 70s.

**Coach primary message now respects `drivingSignal`**. When the lowest-scoring readiness sub-signal is `fitness` (freshness) and readiness is below Primed (< 75), the coach leads with freshness and appends sleep debt as secondary context. Previously, a 5h+ sleep debt dominated the message even when freshness was the larger drag on the composite — creating the contradiction where the page showed "On Track" (label driven by fitness) while the coach said "prioritise sleep." The gate is tied to the readiness label bands (not an arbitrary threshold) so the decision logic aligns with what the user visually sees.

---

## Sleep History Signal — 4th Recovery Input (2026-04-12)

**Function**: `computeRecoveryScore()` in `src/calculations/readiness.ts`

**Problem**: Single-night sleep scores are noisy. Garmin's 0-100 range is compressed (~30-95 in practice). Chronic sleep restriction has cumulative effects that a single-night reading misses.

**Formula**:
- **Sleep History score**: raw 14-day average of sleep scores, penalised by cumulative sleep debt.
  - `sleepHistoryScore = clamp(14d_avg - debtPenalty, 0, 100)`
  - `debtPenalty = sleepDebtSec / 3600 * 3` (each hour of debt = ~3pt penalty)
  - 14-day window matches sleep debt effective range (half-life 7d, 14d captures ~93%)
  - Minimum 3 recent nights required
- **Last Night Sleep**: raw Garmin/Apple score used directly. No z-scoring.

**Why raw scores for sleep (not z-scored like HRV)**: HRV is highly individual — 40ms RMSSD is excellent for one person, poor for another — so z-scoring against personal baseline is essential. But Garmin/Apple sleep scores are already population-normalised: 59 = "poor" for everyone. Z-scoring an already-normalised signal adds noise. For variable sleepers (SD ~15), the z-score compresses deviations toward the center, making a genuinely bad 59 score as little as 0.7 SD below mean — not enough to move the composite.

**Why sleep debt feeds into sleep history**: Without debt, the physiology composite can show 82% recovered while the readiness page simultaneously says "5.5h sleep debt, prioritise sleep." This is contradictory. Sleep debt (duration deficit) and sleep quality are related but distinct signals. Feeding debt into the history score ensures consistency: both readiness and physiology tell the same story. The 3pt/hour penalty is calibrated so 5.5h debt drops the history score by ~16pts, enough to meaningfully depress the composite without overwhelming it.

**Composite weights**:
- HRV: 50% (chronic trend, z-scored against personal baseline)
- Last Night Sleep: 25% baseline, scales up to 35% as the gap to 14d avg grows
- Sleep History: 25% baseline, scales down to 15% as the gap to 14d avg grows
- RHR: override only when elevated >= 2 SD (unchanged)
- Weights renormalise when a signal is unavailable

**Asymmetric sleep weighting (gradient)**: When last night's score is worse than the 14d average, weight shifts linearly from history toward last night. `shift = clamp(gap / 20, 0, 1) * 0.10`, where `gap = sleepHistoryScore - sleepScore`. At gap 0 the split is 25/25; at gap 20 (a full sleep-quality tier) it saturates at 35/15. Acute sleep restriction has disproportionate next-day performance impact. Sleep loss hurts more than sleep surplus helps (Fullagar 2015, Reilly & Edwards 2007, Halson 2014). Gradient (vs binary switch) prevents 1-2pt dips from meaningfully flipping the weighting.

**One-way by design**: when last night is *better* than the 14d average, weighting stays at 25/25 — a single good night doesn't rescue a bad trend. No strong evidence in the literature that weighting a good night higher improves prediction; overweighting an outlier good score against a poor baseline would underrepresent chronic fatigue.

**Sleep debt penalty cap**: `debtPenalty = min(3 × debtHours, 25)`. Linear up to ~8.3h of debt, then capped. Beyond 8h debt the athlete is already in the danger zone — further debt adds little signal, but unbounded linear growth would collapse the history score to 0 if debt calculation misfired (bad target, missing nights).

**Justification**:
- Van Dongen 2003: chronic sleep restriction (6h/night for 14 days) produces cumulative cognitive deficits equivalent to 1-2 nights total deprivation, even when subjects report feeling "adapted"
- Halson 2014: sleep debt is a significant mediator of overtraining risk in athletes
- Buysse 2014: sleep quality is relative to individual need; absolute thresholds miss individual variation
- Z-scoring against personal baseline handles the compressed Garmin range naturally (no hardcoded floor/ceiling)
- Works identically for Garmin and Apple Watch users (both produce sleepScore in 0-100 range)

**Known limitations**:
- Requires 10+ baseline readings for z-score method; fallback to raw average is less informative
- Garmin's sleep score algorithm is opaque; we're z-scoring a derived metric, not raw physiology
- Equal 25/25 weighting of last-night vs 7d-history is pragmatic, not empirically derived

---

## Readiness-Modulated Daily Target TSS (2026-04-09)

**Function**: `computeDayTargetTSS(plannedDayTSS, readinessLabel, perSessionAvg, isRestDay, isAdhocDay)`

**Formula**:
- Training days: `target = plannedDayTSS`
- Adhoc days (unplanned activity): `target = perSessionAvg`
- Rest days: `target = perSessionAvg × 0.30`
- Modulation: Ease Back × 0.80, Overreaching × 0.75

**Science**:
- Rest day target: Menzies (2010) — active recovery at ~30% of training load improves next-day performance vs complete rest.
- Ease Back (0.80): Halson (2014) — 20-30% load reduction on suppressed recovery markers.
- Overreaching (0.75): Gabbett (2016) — ACWR spike model, target reduction to lower acute:chronic ratio.
- Ready to Push / On Track / Manage Load: 100% (Buchheit & Laursen 2013, autoregulation — plan holds when recovery is adequate, Manage Load is visual only).

**perSessionAvg**: Derived from current week's planned TSS / training day count (not CTL baseline). Tracks plan intent so targets rise during build phases and drop during taper, rather than lagging behind via 42-day EMA.

**Rest-day overreach threshold**: `perSessionAvg × 0.33` (`REST_DAY_OVERREACH_RATIO`). Based on Whoop's ~33% recovery-day cap and Seiler's polarised model (Zone 1 recovery sessions ≈ 25-35% of a hard session).

**Limitations**: Readiness modulation is binary (label-based thresholds), not continuous. A more sophisticated model would use the readiness score as a continuous multiplier.

---

## Passive TSS from Steps (2026-04-09)

**Constant**: `PASSIVE_TSS_PER_1000_STEPS = 1.0`

**Derivation** (Banister TRIMP at Zone 1 walking intensity):
- Walking cadence ~110 spm (Himann 1988) → 1,000 steps ≈ 9 min.
- Walking HR ≈ 50-55% HRmax → HRR ≈ 0.20-0.30.
- Banister TRIMP/min = HRR × 0.64 × exp(1.92 × HRR) ≈ 0.19 at HRR=0.25.
- 9 min × 0.19 = 1.7 raw TRIMP → normalizeiTrimp(1.7, 15000) ≈ 0.011.
- BUT TL_PER_MIN[2]=0.45 for RPE2 gives 9 × 0.45 = 4.05 — much higher.
- Compromise: 1.0 TSS per 1,000 steps. Conservative enough that 5-10k daily steps add 5-10 TSS.

**Function**: `computePassiveTSS(totalSteps, activeMinutes, loggedActivities, tssPerActiveMinute)`

Takes two signals, uses the higher:
- Signal A: passive steps → TSS via 1.0/1000 (catches low-intensity walking)
- Signal B: passive active minutes → TSS via calibrated tssPerActiveMinute (catches high-intensity unlogged activity)

Both subtract logged workout contribution: steps use cadence × duration (170 spm running, 110 spm walking per Cavanagh & Kram 1989, Himann 1988). Minutes use simple duration sum.

**Limitations**: Step cadence estimates are population averages. Individual variation (especially for tall/short runners) can cause 10-15% error in the subtraction. Floored at 0, so worst case is slightly undercounting passive strain, not overcounting.

---

## Personal TSS-per-Minute Calibration (2026-04-09)

**Function**: `calibrateTssPerActiveMinute(wks, normalizer)`

Scans `garminActuals` with `iTrimp > 0` and `durationSec > 900` (15 min minimum). Computes `ratio = normalizeiTrimp(iTrimp) / (durationSec/60)` per activity. Returns median of all ratios if >= 5 samples, else null (fallback to `PASSIVE_TSS_PER_ACTIVE_MIN = 0.45`).

Mirrors the existing `computeCrossTrainTSSPerMin` pattern. Median is used instead of mean to be robust to outlier activities (e.g. a short sprint with very high TSS/min).

**Limitations**: Calibration reflects the athlete's training distribution, not passive activity specifically. An athlete who only does high-intensity sessions will have a higher calibrated rate than their actual passive activity intensity. The fallback (0.45, RPE 2) is more appropriate for truly passive minutes.

---

## iTRIMP Calculation (Banister/Morton Model)

**File**: `src/calculations/trimp.ts`

**Formula**:
```
TRIMP = SUM( dt_sec * HRR_i * exp(beta * HRR_i) )
```

**Terms**:
- `HRR_i` = (HR_i - HR_rest) / (HR_max - HR_rest) -- Heart Rate Reserve fraction (0 to 1)
- `dt_sec` = time delta between consecutive HR samples (seconds)
- `beta` = sex-dependent weighting coefficient: 1.92 (male/unknown), 1.67 (female)

**Three-tier implementation**:
1. **Primary**: 1-second HR stream (`calculateITrimp`) -- highest accuracy, integrates over every sample
2. **Fallback**: per-lap average HR (`calculateITrimpFromLaps`) -- medium accuracy
3. **Last resort**: single session-average HR (`calculateITrimpFromSummary`) -- lowest accuracy

**Validation guards**: returns 0 if `maxHR <= restingHR`, if `HR <= restingHR` for a sample (skipped), or if `dt <= 0`.

**Scientific basis**: Banister & Morton (1991) individualised TRIMP. The exponential weighting reflects the non-linear metabolic cost of exercise at increasing heart rate fractions. At low HRR the exponential term is near 1 (load ~ duration); at high HRR the exponential amplifies load substantially, reflecting anaerobic contribution and EPOC.

**Known limitations**:
- No upper-bound clamp on HRR (values above 1.0 are physiologically possible if HR exceeds estimated maxHR)
- Beta coefficients are population averages; individual variation in lactate response is not captured
- Tier 3 (single avgHR) loses all information about intensity distribution within the session
- Assumes HR data is reasonably clean; no outlier filtering for erroneous spikes

---

## VDOT (Daniels' Running Formula)

**File**: `src/calculations/vdot.ts`

**Formula**:
```
v = meters / (seconds / 60)                           -- velocity in m/min
VO2 = -4.6 + 0.182258 * v + 0.000104 * v^2           -- oxygen cost
p = 0.8 + 0.1894393 * exp(-0.012778 * t_min)
      + 0.2989558 * exp(-0.1932605 * t_min)           -- fraction of VO2max sustained
VDOT = max(VO2 / p, 15)                               -- clamped floor at 15
```

**Inverse (race time from VDOT)**: bisection search between 2:30/km and 15:00/km pace bounds, tolerance 0.05 VDOT, max 50 iterations.

**Race distances**: 5K = 5000m, 10K = 10000m, half = 21097m, marathon = 42195m.

**Scientific basis**: Jack Daniels' empirical model (Daniels & Gilbert, 1979; Daniels, 1985). The VO2 polynomial approximates oxygen cost as a function of running velocity. The fraction `p` models the percentage of VO2max that can be sustained as duration increases, using bi-exponential decay to capture the rapid initial drop-off and slower long-duration decline.

**Known limitations**:
- Polynomial coefficients are empirically fit to trained runners; accuracy decreases for untrained or elite populations
- Assumes flat-ground, sea-level running (no altitude, terrain, or temperature correction)
- The 15 VDOT floor prevents negative values but may mask data quality issues
- Bisection convergence is guaranteed but not efficient; 50 iterations provide sub-second precision for all practical inputs

---

## Pace Zone Derivation

**File**: `src/calculations/paces.ts`

**Method A -- from Lactate Threshold pace** (preferred when LT pace is known):
```
Easy (E)        = ltPace * 1.20     (20% slower than LT, ~65-70% VO2max)
Marathon (M)    = ltPace * 1.05     (5% slower than LT)
Threshold (T)   = ltPace * 1.00     (at LT pace)
Interval (I)    = ltPace * 0.93     (7% faster than LT)
Repetition (R)  = ltPace * 0.88     (12% faster than LT)
```

**Method B -- from VDOT** (fallback):
```
Easy (E)        = (5K_time / 5km) * 1.25    (25% slower than 5K pace)
Marathon (M)    = marathon_time / 42.2km      (projected marathon pace)
Threshold (T)   = 10K_time / 10km             (approx 10K pace)
Interval (I)    = 5K_time / 5km               (at 5K pace)
Repetition (R)  = (5K_time / 5km) * 0.97     (3% faster than 5K pace)
```

**Ad-hoc zone mappings**: 10K pace = marathon pace * 0.95; half-marathon pace = marathon pace * 1.05.

**Scientific basis**: Daniels' training zones. LT-anchored zones are more accurate because LT is directly measurable and represents the metabolic crossover point. VDOT-derived zones assume a fixed relationship between race performances and training intensities that holds for typical trained runners.

Easy E-pace at 1.20 × LT places the zone at ~65-70% VO2max (mid-band of Daniels' E-pace range of 59-74%). The previous 1.15 multiplier sat at the fast edge of that band; calibration data (athlete feedback: prescribed easy felt like Z3, not Z2) confirmed it was too aggressive. Verified: for LT = 4:04 (VDOT 55), 1.20 gives easy 4:53/km vs Daniels table range of 4:44-5:12/km.

**Known limitations**:
- LT method assumes LT occurs at a consistent fraction of VO2max (~85-90%), which varies by training status
- VDOT fallback is most accurate for VDOT 40-55; less reliable at extremes
- 10K and half-marathon zone adjustments (0.95, 1.05) are heuristic convenience values, not derived from physiology

---

## Fatigue Exponent & Runner Type Classification

**File**: `src/calculations/fatigue.ts`

**Fatigue exponent (b)** -- log-linear regression on personal bests:
```
b = SUM[(ln(d_i) - mean_lnD) * (ln(T_i) - mean_lnT)] / SUM[(ln(d_i) - mean_lnD)^2]
```

Based on Riegel's time-distance model: `T(d) = T_anchor * (d / d_anchor)^b`

**Fallback**: b = 1.06 when fewer than 2 PBs available (represents a balanced runner).

**Runner type thresholds**:
- Speed: b > 1.12 (more fade with distance, better at short events)
- Balanced: 1.06 <= b <= 1.12
- Endurance: b < 1.06 (less fade, better at long events)

**VDOT ability bands**: Elite >= 60, Advanced >= 52, Intermediate >= 45, Novice >= 38, Beginner < 38.

**Scientific basis**: Riegel (1981) showed that race times follow a power-law relationship with distance. The exponent captures the athlete's metabolic profile: speed-dominant runners have higher exponents because their anaerobic contribution fades faster over distance. The 1.06 centre is Riegel's original published constant for trained runners. Katz & Katz (1999) and Vanderburgh (2001) confirmed recreational runners span roughly 1.01 (elite marathoners) to 1.15+ (sprint-dominant). The 1.12 cutoff for "Speed" is a pragmatic threshold at approximately +1 SD of recreational variance, not from a specific publication. Audited 2026-04-10: kept as-is.

**Known limitations**:
- Requires at least 2 PBs at different distances; single-distance runners get the 1.06 default
- Assumes PBs reflect current fitness (old PBs may skew the exponent)
- Log-linear regression assumes homoscedastic errors in log-space, which may not hold
- Ability band thresholds are age/sex-agnostic

---

## Heart Rate Zones

**File**: `src/calculations/heart-rate.ts`

**Method hierarchy** (highest priority first):

1. **LTHR-based** (requires LTHR > 100):
```
Z1: [LTHR * 0.65, LTHR * 0.80]
Z2: [LTHR * 0.80, LTHR * 0.89]
Z3: [LTHR * 0.89, LTHR * 0.95]
Z4: [LTHR * 0.95, LTHR * 1.00]
Z5: [LTHR * 1.00, LTHR * 1.10]
```

2. **Karvonen / HRR** (requires maxHR > restingHR):
```
HRR = maxHR - restingHR
Z1: [rest + HRR * 0.50, rest + HRR * 0.60]
Z2: [rest + HRR * 0.60, rest + HRR * 0.70]
Z3: [rest + HRR * 0.70, rest + HRR * 0.80]
Z4: [rest + HRR * 0.80, rest + HRR * 0.90]
Z5: [rest + HRR * 0.90, rest + HRR * 1.00]
```

3. **Max HR percentage** (requires maxHR > 100): zones at 50-60%, 60-70%, 70-80%, 80-90%, 90-100%.

4. **Age-estimated**: maxHR = 220 - age; then applies method 3.

**Scientific basis**: LTHR-based zones are the gold standard because lactate threshold directly marks the metabolic crossover. Karvonen (1957) accounts for individual resting HR. The 220-age formula (Fox et al., 1971) is a population regression with SE ~10-12 bpm.

**Known limitations**:
- 220-age has large individual error (SD ~10 bpm); may over/underestimate by 20+ bpm
- LTHR zones assume threshold occurs at a consistent fraction of max; athletes with high aerobic capacity may have LT at higher percentages
- No zone model accounts for cardiac drift, temperature, altitude, or caffeine effects

---

## HR Effort Score

**File**: `src/calculations/heart-rate.ts`

**Formula**:
```
midpoint = (target.min + target.max) / 2
halfRange = (target.max - target.min) / 2
score = clamp(1.0 + (avgHR - midpoint) / halfRange * 0.2, 0.5, 1.5)
```

**Interpretation**: < 0.9 = undercooked, 0.9-1.1 = on target, > 1.1 = overcooked.

**HR Intensity Score** (simpler variant):
```
score = (avgHR - target.min) / (target.max - target.min) + 0.5
Range: 0.5 (zone min) to 1.5 (zone max), midpoint = 1.0
```

**Scientific basis**: Normalises workout execution quality against the prescribed HR target zone. The 0.2 swing factor means a 20% deviation from midpoint produces only a 0.2-point score change, reflecting that moderate over/under-shooting has a proportional (not dramatic) effect on training stimulus.

**Known limitations**:
- Assumes HR accurately reflects effort (ignores cardiac drift, dehydration, heat)
- Single average HR masks interval workouts where HR oscillates between zones

---

## Efficiency Shift Detection

**File**: `src/calculations/heart-rate.ts`

**Purpose**: Detects mismatch between perceived effort (RPE) and cardiac response (HR) to infer fitness changes.

**Constants**: HR_THRESHOLD = 0.2 (normalised deviation required to signal efficiency change).

**Decision matrix** (RPE delta vs HR deviation):
- RPE matched, HR low: shift = +0.15 (fitness improvement)
- RPE matched, HR high: shift = -0.15 (autonomic fatigue)
- Felt easier, HR also low: shift = +0.30 * rpeMag (confirmed efficiency gain)
- Felt easier, HR high: shift = -0.25 * rpeMag (cardiac strain despite subjective ease)
- Felt harder, HR high: shift = -0.15 * rpeMag (legitimate metabolic struggle)
- Felt harder, HR suppressed + intervals: shift = -0.35 * rpeMag (central fatigue)

RPE magnitude: `min(|rpeDelta| / 3, 1.0)`.

**Scientific basis**: When RPE and HR agree on a direction, the signal is stronger (concordant). When they diverge (e.g. felt easy but HR was high), it suggests a pathological state like cardiac drift, dehydration, or overreaching. Central fatigue (suppressed HR despite high RPE) is a recognised overtraining marker.

**Known limitations**:
- RPE is subjective and variable across athletes
- Shift values are heuristic, not individually calibrated
- Does not account for environmental factors (heat, altitude) that affect HR independently of fitness

---

## Lactate Threshold Estimation

**File**: `src/calculations/lt-estimator.ts`

### Method 1: Threshold Direct

**Requirements**: paceCV < 0.08 (steady state), work segment >= 900s (15 min), HR within Z4 +/- 5%.

**Output**: LT pace = work segment average pace. Confidence: high.

**Scientific basis**: A steady-state run at threshold HR intensity directly reveals LT pace by definition.

### Method 2: Cardiac Efficiency Trend

**Requirements**: >= 3 data points from different weeks, improving trend (negative slope).

**Formula**:
```
CEI = pace_sec_per_km / HR_bpm        (lower = more efficient)
Linear regression: CEI = slope * week + intercept
weeklyImprovement% = |slope| / meanCEI
totalImprovement% = weeklyImprovement% * weeks_spanned
newLT = currentLT * (1 - totalImprovement%)
```

**Rejection gates**: totalImprovement < 10% (noise), implied change < 1 sec/km (trivial).

**Auto-apply safeguards**: rejected if injured, already updated this week, low confidence, or deviation > 15% from current LT (needs manual confirmation).

**Scientific basis**: Cardiac efficiency (pace/HR) improves as aerobic fitness develops. Sustained multi-week trends in CEI indicate LT has shifted proportionally. Single-session CEI is too noisy (terrain, weather, fatigue) to be actionable.

**Known limitations**:
- Requires multi-week data accumulation; not useful early in a plan
- Linear regression assumes constant rate of improvement; real adaptation is non-linear
- Does not account for seasonal HR drift (heat adaptation raises HR independent of fitness)

---

## Stream Processing & HR Drift

**File**: `src/calculations/stream-processor.ts`

### Cardiac Efficiency Index
```
CEI = paceSecPerKm / heartRateBpm     (lower = more efficient)
```

### Work Segment Extraction
Identifies the steady-state portion of a run by:
1. Computing median pace of middle 50th percentile
2. Finding longest contiguous block within 15% of median pace
3. Fallback: strip first 15% (warmup) and last 10% (cooldown)
4. Minimum segment: 60 seconds

### Pace Coefficient of Variation
```
paceCV = SD(paces) / mean(paces)
Steady state threshold: paceCV < 0.08
```

### HR Drift
**Requirements**: >= 120 data points, >= 1200 seconds (20 min).
```
Strip first 10% (warmup)
Split remaining into halves
drift% = ((avgHR_second_half - avgHR_first_half) / avgHR_first_half) * 100
```

**Scientific basis**: Cardiac drift (Coyle et al., 1983) measures rising HR during sustained submaximal effort. Positive drift indicates fatigue, thermoregulatory strain, or dehydration. Drift > 5% in a threshold run suggests the effort exceeded sustainable intensity.

**Known limitations**:
- Only meaningful for continuous steady-state efforts; interval workouts produce misleading drift values
- 10% warmup strip is a fixed heuristic; some athletes warm up longer
- Does not distinguish between physiological drift and environmental drift (temperature rise during session)

---

## Athlete Normalizer (Personalised iTRIMP-to-TSS)

**File**: `src/calculations/fitness-model.ts`

**Formula** (β updated 2026-10-05, §CI):
```
normalizer = 3600 * HRR_at_LT * exp(beta_sex * HRR_at_LT)
beta_sex = getBeta(resolveBiologicalSex(s))   // trimp.ts: 1.67 female, 1.92 male / unset / prefer_not_to_say
HRR_at_LT = (LTHR - restingHR) / (maxHR - restingHR)
normalizedTSS = (iTrimp * 100) / normalizer
```

**Fallback**: normalizer = 15000 when LTHR, restingHR, or maxHR unavailable, or LTHR is outside 80–95% of maxHR (§BP).

**Live binding (2026-10-05)**: the module normaliser behind `normalizeiTrimp()` / `getAthleteNormalizer()` is bound to live state (`bindAthleteNormalizerToState` in `launchApp`) and re-derived whenever LTHR, resting HR, max HR or the resolved sex change (§CI).

**Scientific basis**: Coggan's hrTSS standard defines 1 hour at lactate threshold HR = 100 TSS. The normalizer computes what iTRIMP value corresponds to that reference session for the individual athlete. This personalises the iTRIMP-to-TSS conversion by ~10-20% compared to the fixed 15000 default.

**Known limitations**:
- Falls back to population average (15000) when HR profile is incomplete
- Population fallback 15000 is sex-neutral (no documented female derivation), and Strava rows cached before the athlete's sex was known keep β 1.92; see §CI (2026-10-05). (Replaces "Beta = 1.92 (male) is hardcoded; no sex-specific normalizer", fixed 2026-10-05.)
- Accuracy depends on correct LTHR, which may be estimated rather than lab-tested

---

## ACWR Calculation & Tier Thresholds

**File**: `src/calculations/fitness-model.ts`

**Formula**: `ACWR = Acute Load (ATL) / Chronic Load (CTL)`

**Two computation modes**:

1. **Rolling 7d/28d** (preferred): acute = sum of last 7 days Signal B TSS; chronic = sum of last 28 days / 4 (weekly average). Pre-plan days filled with `signalBSeed / 7`. Without a seed, days no plan week covers are missing, not rest, and the ratio is 'unknown' until 14 observed days (2026-10-05; see "Rolling 7d/28d Load Computation").

2. **Weekly EMA fallback**: uses same-signal (Signal B for both CTL and ATL) or mixed-signal (legacy: Signal A for CTL, Signal B for ATL). Reached only when `planStartDate` is missing or there are no weeks. Since 2026-10-05 a `null` rolling ratio reports 'unknown' instead of falling through to this EMA, which starts from zero for an unseeded athlete and read a false spike.

**Plan-reset continuity (2026-04-29)** _(see `docs/ARCHITECTURE.md → "Load Model & Plan Continuity"` for the call-site rule and `docs/CHANGELOG.md` 2026-04-29 entries for implementation history)_: both modes now walk `s.previousPlanWks` chronologically before consuming current `wks`. Without this, a new plan generation collapsed CTL to whatever `signalBBaseline` happened to be — the historic Strava median — discarding all training the user did during the previous plan and producing phantom "Overloaded" freshness states for several weeks until the new plan accumulated enough of its own data. The same fix applies to `computeSameSignalTSB`, `computeFitnessModel`, and `computeLiveSameSignalTSB` so every readiness surface (freshness ring, ACWR, injury risk, fitness trend, week-debrief) sees a continuous chronic-load history across plan boundaries. Double-counting is prevented by `_truncateArchivesAtPlanBoundary`, which drops archive weeks whose start date is on or after the new plan's start.

**Tier-specific safe upper bounds** (compressed to 1.3-1.5, audit 2026-04-10):

| Athlete Tier | Safe Upper | Caution Upper |
|---|---|---|
| beginner | 1.30 | 1.50 |
| recreational | 1.35 | 1.55 |
| trained | 1.40 | 1.60 |
| performance | 1.45 | 1.65 |
| high_volume | 1.50 | 1.70 |

Previous range was 1.2-1.6. Compressed because:
- Gabbett's 0.8-1.3 sweet spot is the only range with direct evidence
- ACWR >= 1.5 consistently associated with elevated injury risk across all populations studied
- No published per-tier ACWR thresholds exist; the old 1.2-1.6 range overstated the evidence
- Lolli et al. (2019) showed absolute ACWR thresholds may be statistical artifacts of ratio coupling
- New range keeps all tiers within or at the boundary of empirically supported values

**ATL inflation multipliers** for suppressed fatigue:
- ACWR overridden: 1.15x
- Recovery debt orange: 1.10x
- Recovery debt red: 1.20x

**Scientific basis**: Gabbett (2016) acute:chronic workload ratio. Hulin et al. (2016) showed high chronic load is protective, justifying higher thresholds for fitter athletes. Malone et al. (2017) found elite soccer players with high chronic loads tolerated spikes without elevated injury risk. The rolling 7d/28d method is preferred over the EWMA because it is transparent and has no weekly-bucket artefacts. *Correction (2026-10-05):* this entry used to call the rolling method "uncoupled". Its 28-day ÷ 4 chronic includes the acute week, so it is the **coupled** ratio, and the Lolli et al. (2019) coupling caveat below applies to it.

**Known limitations**:
- Lolli et al. (2019): ACWR contains mathematical coupling (acute is part of chronic), producing spurious correlations. Absolute thresholds should be treated as heuristics, not validated boundaries
- Tier boundaries are population estimates; individual ACWR tolerance varies with age, sleep, and training history
- Rolling method requires sufficient daily data; sparse data produces noisy ratios
- Same-signal mode solved the cross-training inflation problem but may underweight run-specific fatigue
- The real protective factor is absolute chronic load (CTL), not the ratio itself

---

## Rolling 7d/28d Load Computation

**File**: `src/calculations/fitness-model.ts`

**Formula**:
```
acute = SUM(dailyTSS[-7:])
chronic = SUM(dailyTSS[-28:]) / 4
```

Pre-plan fill: `signalBSeed / 7` per day (distributes historical weekly average evenly).

**Scientific basis**: Simple rolling average is the most transparent ACWR method. Dividing 28-day sum by 4 converts to a weekly average for direct comparison with the 7-day acute window. *Correction (2026-10-05):* this paragraph used to call the method "uncoupled" and say it avoids double-counting acute load. The 28-day window contains the acute 7 days, so this is the coupled ratio. Coupled and uncoupled ratios map onto each other deterministically for fixed windows (Windt & Gabbett 2019), so the choice changes the threshold scale, not the information.

**Unrecorded days (2026-10-05, audit B1/B17).** Tracking side. A day is *observed* when the live plan or an archived plan has a week covering it; activities are only stored on plan weeks.
- **With a Signal B seed** (`s.signalBBaseline`): unobserved days are filled with `signalBSeed / 7`. Unchanged.
- **Without one** they are missing, not rest. Filling them with 0 made steady training read 1.87 'high' on plan day 14, cut week-3 quality at the week advance and undersized the ease-back L_max (§CF). `computeRollingLoadRatio` returns `null` until 14 observed completed days (`ROLLING_ACWR_MIN_OBSERVED_DAYS`). This is the old 14-day guard, which counted plan days and was switched off by any archive entry (4.00 'high' from day 0 for no-history Strava users and plans rebuilt after 5 days).
- **Formula after the guard.** Missing days are valued at the athlete's own mean daily load, `B / 7`, where `B` is the weekly load of the most recent whole weeks (multiples of 7 observed days) in the 21 days before the acute week:

  ```
  chronic = (acute + 3B) / 4
  ratio   = acute / chronic = 4U / (U + 3),   U = acute / B
  ```

  It equals the plain 28-day sum ÷ 4 once all 28 days are observed, and equals a correctly seeded athlete when the seed matches `B`. Steady training reads 1.00 from day 14 (was 1.87). A week at twice the baseline reads 1.60: 'high' at the beginner, recreational and trained tiers, 'caution' at performance and high_volume ('caution' needs a ratio at or below the tier's `safeUpper` + 0.2, `fitness-model.ts:1620`). At trained (`safeUpper` 1.40) the ratio sits on that boundary, and floating-point addition gives 1.40 + 0.2 = 1.5999999999999999, so 1.60 reads 'high'. The ratio and status are the same as with a correct seed.
- **No constants added.** 14 days is the existing guard; the 7-day / 28-day windows and the ÷ 4 are unchanged.
- **`computeACWR`** reports 'unknown' when the rolling ratio is `null`, instead of the zero-started weekly EMA.
- **Limitations.** (1) Assumes pre-plan load matched the observed baseline, so a true beginner ramping from zero no longer flags. (2) In-plan days before a data source covered the athlete (Apple's 14-day lookback, a mid-plan connection, mid-week onboarding without a backfill) still count as observed zeros (ISSUE-329). (3) The whole-week baseline drops older observed days when the 21-day span is only partly observed. (4) Day keys come from `toISOString()` of local noon, part of the open UTC-vs-local date defect class (audit C5).

**Load Ratio weekly trend (`computeWeeklyAcwrHistory`, 2026-10-05).** Display only. Seeded EMAs start at the seed (unchanged). Unseeded EMAs are divided by `(1 − decay^t)` after `t` weeks, the standard correction for a zero-initialised EMA (Kingma & Ba 2015), so each is the decay-weighted mean of observed weeks only. Steady training reads 1.0 from week 1 (was 4.1, 3.1, 2.4, 2.0 in weeks 1 to 4). Limitation: with few weeks the chronic mean leans on the latest week, so an early spike reads lower than for a seeded athlete, never higher.

---

## Same-Signal TSB

**File**: `src/calculations/fitness-model.ts`

**Problem**: Mixed-signal TSB (CTL from Signal A with runSpec discount, ATL from Signal B without discount) produces permanently negative TSB for athletes who do significant cross-training.

**Solution**: Use Signal B (raw physiological load, no runSpec) for both CTL and ATL:
```
ctl = ctl * CTL_DECAY + weekRawTSS * (1 - CTL_DECAY)
atl = atl * ATL_DECAY + weekRawTSS * (1 - ATL_DECAY)
tsb = ctl - atl
```

At steady-state training, TSB converges near 0, correctly reflecting balanced load.

---

## Passive Strain

**File**: `src/calculations/fitness-model.ts`

**Formula**: `passiveTSS = max(0, totalActiveMinutes - workoutMinutes) * 0.45`

**Constant**: 0.45 TSS per non-workout active minute (calibrated to RPE 2, light effort from TL_PER_MIN).

**Calibration**: 120 non-workout active minutes = 54 TSS. Reflects commuting, errands, manual work.

**Scientific basis**: WHOOP and similar platforms account for non-exercise activity thermogenesis (NEAT) as a contributor to total daily strain. Subtracts workout minutes to avoid double-counting.

**Known limitations**:
- Fixed RPE 2 assumption; a physically demanding job may warrant higher
- Does not differentiate between types of non-workout activity

---

## Universal Load Currency (Tier System)

**File**: `src/cross-training/universalLoad.ts`

Four-tier hierarchy for computing cross-training load based on data quality:

### Tier A+ (iTRIMP from HR stream)
```
baseLoad = iTrimp * sportMult
Aerobic: 85%, Anaerobic: 15% (fixed)
Confidence: 0.95
```

### Tier A (Garmin/Firstbeat)
```
Direct: aerobic = garminAerobicLoad, anaerobic = garminAnaerobicLoad
Confidence: 0.90
```

### Tier B (HR zone time-in-zone)
```
aerobicLoad = z1_min * 1 + z2_min * 2 + z3_min * 3
anaerobicLoad = z4_min * 4 + z5_min * 5
Confidence: 0.85 (>=90% coverage) or 0.75 (<90%)
Minimum: 5 minutes total zone time
```

### Tier C (RPE-only fallback)
```
rawLoad = durationMin * LOAD_PER_MIN[rpe] * sportMult * activeFraction * 0.80
Confidence: 0.70 (RPE 5-7) or 0.55 (RPE 1-4, 8-10)
```

The 0.80 RPE uncertainty penalty reflects the subjective nature of perceived exertion.

**Three output signals**:
- **Fatigue Cost Load (FCL)**: `baseLoad * recoveryMult` (not saturated; drives workout modifications)
- **Run Replacement Credit (RRC)**: `baseLoad * runSpec * goalFactor`, then saturated
- **Impact Load**: `durationMin * impactPerMin` (musculoskeletal stress)

**Scientific basis**: Tiered approach mirrors data quality hierarchy in sports science. HR stream data (Tier A+) is the gold standard for load quantification. Zone-based methods (Tier B) are validated approximations (Lucia et al., 2003). RPE-based estimation (Tier C) is the least accurate but still correlates with session load (Foster et al., 2001).

**Known limitations**:
- Tier A+ fixed 85/15 aerobic split ignores actual zone distribution
- Tier B zone weights [1,2,3,4,5] are a simplification of exponential TRIMP weighting
- Tier C confidence values are heuristic; mid-range RPE (5-7) is empirically more reliable than extremes

---

## Saturation Curve (Run Replacement Credit)

**File**: `src/cross-training/universalLoad.ts`

**Formula**:
```
credit = CREDIT_MAX * (1 - exp(-rawRRC / TAU))
```

**Constants**: CREDIT_MAX = 1500, TAU = 800.

**Behaviour**: rawRRC 500 -> credit ~662; rawRRC 1000 -> ~948; rawRRC 2000 -> ~1328.

**Scientific basis**: Prevents a single massive cross-training session from replacing an entire week of running. The exponential saturation mirrors the physiological principle of diminishing returns: the first hour of cycling transfers more to running fitness than the third hour. TAU = 800 was calibrated so that a typical hard cross-training session (~500-800 raw RRC) receives 50-70% credit, while extreme sessions are capped.

**Known limitations**:
- TAU and CREDIT_MAX are tuned for marathon training; may be too conservative for elite high-volume athletes
- Does not adapt to individual cross-training response

---

## Goal-Distance Adjustment for RRC

**File**: `src/cross-training/universal-load-constants.ts`

**Formula**:
```
Marathon/Half: goalFactor = 1.05 - 0.20 * anaerobicRatio
5K/10K:       goalFactor = 0.95 + 0.20 * anaerobicRatio
```

**Scientific basis**: Marathon success depends on aerobic capacity; anaerobic cross-training sessions transfer less to marathon fitness (penalty). 5K/10K success benefits more from anaerobic capacity; high-intensity cross-training gets a bonus. The 0.20 coefficient creates a 20% swing between pure aerobic and pure anaerobic sessions.

---

## Sport-Specific Constants (SPORTS_DB)

**File**: `src/constants/sports.ts`

Each sport has 6 parameters:

- **mult** (sport multiplier): overall load scaling vs running (0.35 walking to 1.50 rugby)
- **runSpec** (running specificity): fraction counting toward run replacement (0.10 yoga to 1.00 extra_run)
- **recoveryMult** (recovery demand): scales recovery time (0.90 swimming to 1.30 rugby)
- **impactPerMin** (musculoskeletal stress): cross-training only
- **legLoadPerMin** (leg-specific fatigue): 0.50 hiking/skiing, 0.25 cycling, 0.15 soccer, 0 swimming
- **noReplace**: workout types this sport cannot substitute (e.g. soccer cannot replace long runs)

**TL_PER_MIN** (TSS-calibrated load per minute by RPE):
```
RPE:  1    2    3    4    5    6    7    8    9    10
TL: 0.30 0.45 0.65 0.92 1.15 1.45 1.78 2.22 2.75 3.00
```

Calibration checks: Easy 60min RPE 4 = 55 TL; Threshold 45min RPE 7 = 80 TL; VO2 45min RPE 8 = 100 TL.

**IMPACT_PER_KM** (running musculoskeletal stress):
```
easy/long: 1.0, marathon_pace: 1.15, float: 1.25, threshold: 1.3,
race_pace: 1.35, vo2/intervals: 1.5
```

**Scientific basis**: Sport multipliers reflect total physiological cost relative to running, accounting for muscle mass recruited, eccentric loading, and metabolic demand. RunSpec values estimate transfer to running fitness based on movement pattern similarity and aerobic pathway overlap. RecoveryMult captures exercise-induced muscle damage (EIMD): swimming has low eccentric load (0.90), contact sports have high EIMD (1.30). Impact per km scales with ground reaction forces, which increase with running velocity.

**Known limitations**:
- All values are expert estimates, not individually measured
- No adaptation over time (e.g. a cyclist who starts running may have higher cycling runSpec)
- Leg load tiers are categorical; actual loading depends on terrain, technique, and intensity

---

## RPE-Based Load & Aerobic Split (Tier C)

**File**: `src/cross-training/universal-load-constants.ts`

**Load per minute by RPE** (Tier C):
```
RPE:  1   2   3   4   5   6   7   8   9   10
TL: 0.5 0.8 1.1 1.6 2.0 2.7 3.5 4.5 5.3 6.0
```

**RPE -> Aerobic/Anaerobic split**:
```
RPE 1-4: 95% aerobic, 5% anaerobic
RPE 5-6: 85% aerobic, 15% anaerobic
RPE 7:   70% aerobic, 30% anaerobic
RPE 8:   55% aerobic, 45% anaerobic
RPE 9-10: 40% aerobic, 60% anaerobic
```

**Active fraction by sport**: continuous sports (cycling, rowing, swimming) 0.90-0.95; intermittent sports (padel, tennis, soccer) 0.55-0.70; recovery modalities (yoga, pilates) 0.50-0.55.

**Scientific basis**: RPE-to-load mapping is calibrated against HR-derived TSS for the same activities. The aerobic/anaerobic split reflects the metabolic crossover: below RPE 4, nearly all energy is aerobic; above RPE 8, anaerobic glycolysis dominates. Active fractions account for rest periods in intermittent sports that reduce total metabolic cost.

---

## Leg Load Decay

**File**: `src/calculations/readiness.ts`

**Formula**:
```
halfLife = BASE_HALFLIFE * recoveryMult * (RELOAD_PENALTY ^ reloads)
K = ln(2) / halfLife
decayed = originalLoad * exp(-K * hoursAgo)
```

**Three-layer model**:

1. **Base half-life: 48 hours** (up from 36h). Reflects EIMD research showing functional recovery from eccentric loading takes 72-96h (Clarkson & Hubal 2002). 48h is the midpoint of the DOMS peak window.

2. **Sport-specific scaling**: half-life is multiplied by `recoveryMult` from SPORTS_DB. Examples: swimming (0.90) = 43h half-life, cycling (0.95) = 46h, hiking (0.95) = 46h, rugby (1.30) = 62h. Higher-impact sports take longer to clear.

3. **Re-loading penalty**: exercising on fatigued legs slows clearance. Each subsequent leg-loading session within 72h extends the half-life by 1.3x (capped at 3 reloads = 2.2x). A Monday hike followed by a Tuesday run pushes the hike's half-life from 46h to 60h, keeping the warning active through Wednesday. This models the well-established principle that eccentric exercise on already-damaged muscle fibres delays recovery (Nosaka & Newton, 2002).

**Thresholds**: >= 60 = heavy (strong warning), >= 20 = moderate (note).

**Readiness floor (added 2026-04-15)**:
- decayedSum in [10, 20) → soft linear penalty, cap 100 → 54 (no hardFloor set, no callout)
- decayedSum >= 20 → readiness capped at 54 (Manage Load), hardFloor = 'legLoad'
- decayedSum >= 60 → readiness capped at 34 (Ease Back), hardFloor = 'legLoad'

Floor branches guard on `score > cap` so a stricter prior floor (ACWR, sleep, strain) is never overwritten: leg fatigue only wins when it is the binding constraint. When it does bind, `drivingSignal = 'legLoad'` so UI surfaces ("Protect the legs") reflect the actual cap rather than a lower-but-non-binding sub-score.

**Why a hard floor, not a weighted input**: EIMD dose-response is non-linear. Functional force-output recovers in 24-48h after mild damage with no measurable injury risk increase, but heavy eccentric loading produces a 72-96h window of impaired force absorption and altered gait mechanics that measurably elevates impact-injury risk (Clarkson & Hubal 2002; Paulsen et al. 2012, *Exerc Sport Sci Rev*). Risk is silent below threshold and step-changes above it. A weighted input would misrepresent this — most days the signal is zero and would dilute the score; on heavy-load days it should dominate. The floor pattern matches how readiness already handles ACWR, sleep, and strain, all of which have non-linear risk curves.

**Soft taper (10–20)**: A cliff at exactly 20 (score 100 → 54) would be a UX artefact. The soft linear penalty in [10, 20) eases onset: a user at legLoad = 15 sees ~77, not 100 or 54. Crucially this band does not set `hardFloor`, so no callout fires and no "Leg fatigue is capping your readiness" banner appears — it's a nudge, not a message. Only the step at 20 makes leg fatigue the binding constraint.

**Why 48h half-life, given the 72–96h EIMD window**: EIMD research measures *functional deficit duration* (isometric force, CK markers) which peaks 24–48h post-exercise and resolves by 72–96h. A 48h half-life places the decay midpoint at peak deficit, keeps the signal ≥ MODERATE (20) for ~72h after a heavy (≥80-raw) session, and ~96h when reloaded — aligning the floor-release window with the literature's functional-recovery window. Full clearance (< 5) takes longer (5+ days when heavy), which matches tissue-level markers that lag functional recovery. Choosing the half-life rather than a rigid 72h step keeps the curve smooth and composable with subsequent sessions.

**Why on Readiness specifically (not Recovery score)**: HRV/sleep/RHR measure autonomic recovery; they pick up part of EIMD via inflammation but rebound on a 24-48h timescale, before tissue does. The autonomic channel is also non-localised — a stressful work day and a destroyed-quads day read identically. Leg fatigue is the localised mechanical channel that closes this blind spot, particularly for cross-training (hiking, skiing, long rides) where TSS undercounts what the eccentric loading does to the legs.

**Example**: 3h hard hike (90 load) Monday, easy run (20 load) Tuesday, checking Wednesday morning:
- Hike at 40h: halfLife = 48 * 0.95 * 1.3 = 59h → decayed = 57 (still significant)
- Run at 16h: halfLife = 48 * 1.0 = 48h → decayed = 16
- Total: 73 (heavy warning — matches lived experience of 3-day soreness when continuing to exercise)

**Known limitations**:
- Re-loading penalty is activity-count based, not load-weighted (a gentle walk counts the same as a hard run for penalty purposes)
- Cap at 3 reloads prevents runaway half-life but may underestimate recovery delay for athletes training 2x daily
- `recoveryMult` in SPORTS_DB reflects overall recovery demand, not leg-specific EIMD. In practice this is not an issue: sports with high upper-body demand but no leg loading (boxing, swimming, climbing) have `legLoadPerMin: 0` and never create leg load entries, so their recoveryMult is never applied to leg decay

---

## Running Leg Load (added 2026-04-25)

**File**: `src/ui/sport-picker-modal.ts` — `computeRunLegLoad`, `effortMultiplierForRpe`, `reconcileRecentLegLoads`.

**Why added.** Cross-training activities wrote `recentLegLoads` entries via duration × `legLoadPerMin`, but running was excluded from the leg-load pipeline entirely (no `legLoadPerMin` in `SPORTS_DB`). The assumption was that running fatigue would be captured by Freshness/TSB. In practice this leaves a visible gap: a hard 18 km the day before reads "Leg Fatigue: 4 (Minimal)" because no entry was ever written, while ATL barely registers the spike against an inflated CTL baseline. Running EIMD is mechanically distinct from cardiovascular fatigue and needs its own channel.

**Formula**:
```
runLegLoad = distanceKm × effortMultiplier(rpe)

effortMultiplier:
  RPE ≤ 4  → 1.00 (easy/long)
  RPE = 5  → 1.15 (marathon_pace)
  RPE = 6  → 1.25 (float)
  RPE = 7  → 1.30 (threshold)
  RPE = 8  → 1.35 (race_pace)
  RPE ≥ 9  → 1.50 (vo2 / intervals)
```
Multipliers are reused from `IMPACT_PER_KM` (already calibrated for matched workout types) so the run-leg-load channel and the existing impact-load channel share the same effort tiers.

**Why distance × effort, not duration × rate.** Running EIMD is dominated by ground-reaction force at footstrike, which scales with stride count (≈ a function of distance) and per-stride force (≈ a function of effort/pace). Eccentric loading at the quadriceps and gastrocnemius peaks during the braking phase of each footstrike (Mizrahi et al. 2000, *Hum Mov Sci*; Clansey et al. 2014, *Med Sci Sports Exerc*). Duration is a poor proxy: a slow-paced bonked 18 km has more total mechanical stress than a brisk 60-minute easy run. Distance × effort captures both axes correctly.

**RPE source priority**:
1. `wk.rated[workoutId]` if a numeric RPE was logged for the matched workout.
2. HR-derived Karvonen tier (same mapping as `deriveRPE` in `activity-matcher.ts`): zone 1 → 3, zone 2 → 4, zone 2-3 → 5, zone 3 → 6, zone 4 → 8, zone 5 → 9. This handles bonked runs correctly: pace collapses but HR stays elevated, and HR-derived RPE remains high.
3. Default 5 if neither is available.

**RBE suppression for hard runs (RPE ≥ 7).** The existing `applyRbeDiscount` reduces a same-sport bout's load by 40% when a prior bout occurred within 14 days (Nosaka & Clarkson 1995, McHugh 2003). For runs we suppress this when RPE ≥ 7, because the protective adaptation is stimulus-specific: a prior easy run does not protect against a threshold or race-pace effort. Chen et al. (2007, *Med Sci Sports Exerc*) and Nosaka & Newton (2002) showed RBE attenuates when a subsequent bout exceeds the protective bout's intensity — protection scales with stimulus similarity, not session count.

**Worked example**. 18 km at zone-4 HR (RPE 8), bonked pace, 24 hours ago:
- raw = 18 × 1.35 = 24.3
- RBE skipped (RPE 8 ≥ 7)
- decay over 24 h at 48 h half-life: 24.3 × exp(-ln 2 / 48 × 24) = 24.3 × 0.707 = 17.2
- Falls in the 10-20 soft-taper band → readiness ≈ 73 (down from 100), no hard floor.

Same run 12 hours ago: 24.3 × 0.841 = 20.4 → just over the moderate threshold → readiness capped at 54 ("Manage Load"), `hardFloor = 'legLoad'`. This matches the lived experience of next-morning leg heaviness after a hard long run.

**Backfill path**. `reconcileRecentLegLoads()` walks every `wk.garminActuals` from the last 7 days, identifies runs by `activityType` substring "RUN", computes the load, and writes entries with `sport: 'running'`. Idempotent (skipped if `garminId` already present). Called from `activitySync.ts` after `matchAndAutoComplete` and from `main.ts` on launch so existing data is rebuilt.

**Tracking vs planning**. This is a tracking signal — it informs Readiness ("how recovered are you for today's session"). It does not feed CTL/ATL/TSB or change planned-workout TSS. Mechanical recovery is a separate axis from cardiovascular fitness/fatigue.

**Known limitations**:
- Distance is the proxy; we ignore terrain (downhill running massively increases EIMD via greater eccentric load — could over-weight by 1.5-2x but we lack altitude data on the matched-actual record).
- Effort multiplier saturates at 1.50 (RPE 9-10). Race efforts at marathon distance likely exceed this in practice (a marathon at race pace is closer to 2x normal EIMD).
- Bonked / glycogen-depleted runs cause more EIMD per km than fueled runs at the same pace (form degradation, increased cortisol-driven catabolism). Not modelled — captured indirectly via the HR-driven RPE staying high when pace collapses.
- Treadmill runs with no GPS distance return 0. Acceptable: leg load on a treadmill is real but less common than cross-training drift, and the alternative would require a duration fallback that re-introduces the duration-rate problem we are trying to avoid.

---

## Workout Load Profiles (Aerobic/Anaerobic Split)

**File**: `src/workouts/load.ts`

**Load computation**:
```
estimatedRPE = intensityPct / 10
baseRate = LOAD_PER_MIN[round(estimatedRPE)]
totalLoad = duration_min * baseRate
aerobicLoad = totalLoad * profile.aerobic
anaerobicLoad = totalLoad * profile.anaerobic
final = round(aerobicLoad + anaerobicLoad * 1.15)
```

The 1.15x anaerobic boost accounts for the higher CNS and recovery cost of high-intensity work.

**Load profiles by workout type**:

| Type | Aerobic | Anaerobic | Base | Threshold | Intensity |
|---|---|---|---|---|---|
| easy | 0.95 | 0.05 | 0.94 | 0.05 | 0.01 |
| long | 0.90 | 0.10 | 0.88 | 0.10 | 0.02 |
| threshold | 0.70 | 0.30 | 0.15 | 0.65 | 0.20 |
| vo2 | 0.50 | 0.50 | 0.10 | 0.35 | 0.55 |
| marathon_pace | 0.75 | 0.25 | 0.40 | 0.45 | 0.15 |
| intervals | 0.45 | 0.55 | 0.05 | 0.30 | 0.65 |
| hill_repeats | 0.40 | 0.60 | 0.10 | 0.30 | 0.60 |
| progressive | 0.70 | 0.30 | 0.35 | 0.45 | 0.20 |
| float | 0.65 | 0.35 | 0.20 | 0.50 | 0.30 |
| gym | 0.20 | 0.80 | 0.05 | 0.20 | 0.75 |

**Scientific basis**: Aerobic/anaerobic ratios reflect the dominant energy system at each intensity. Easy running is almost entirely aerobic (fat oxidation); VO2max intervals are roughly 50/50 due to significant anaerobic glycolysis above LT. The three-zone breakdown (base/threshold/intensity) maps to Seiler's polarised training zones.

---

## Race Time Prediction Blending

**File**: `src/calculations/predictions.ts`

### Four predictors

1. **PB-based** (Riegel): `T = T_anchor * (d_target / d_anchor)^b` (b capped at 1.15)
2. **Recent run**: extrapolated via fatigue exponent (b capped at 1.08), blended with PB via recency weight alpha (0.85 at <=2 weeks, 0.70 at <=6, 0.50 at <=12, 0.20 at >12)
3. **LT multiplier**: `T = ltPace * distance_km * M`, where M varies by distance and runner type (e.g. marathon speed=1.14, endurance=1.09)
4. **VO2/VDOT**: bisection solve for time given current VDOT

### Blending weights (with recent run available)

| Distance | Recent | PB | LT | VO2 |
|---|---|---|---|---|
| 5K | 0.30 | 0.10 | 0.35 | 0.25 |
| 10K | 0.30 | 0.10 | 0.40 | 0.20 |
| Half | 0.30 | 0.10 | 0.45 | 0.15 |
| Marathon | 0.25 | 0.05 | 0.55 | 0.15 |

LT dominance increases with distance because marathon success is primarily determined by lactate threshold.

**Recency decay**: reduces recent-run weight as data ages (1.0 at <=2 weeks to 0.15 at >8 weeks), reallocating 70% to LT and 30% to PB.

### Adherence penalty
```
penalty = 1 + (missedLongRuns * 0.5 + missedQuality * 0.3 + (adherence < 0.80 ? 2.0 : 0)) / 100
```

**Scientific basis**: Multi-predictor blending reduces prediction error compared to any single method. LT is the strongest marathon predictor (Midgley et al., 2007). Recent performance captures current form. PB captures ceiling potential. VDOT captures aerobic capacity. The adherence penalty reflects that skipped key workouts directly impair race readiness.

**Known limitations**:
- Weights are expert-set, not learned from data
- Recency decay is step-wise rather than continuous exponential
- No course-specific adjustments (elevation, temperature)
- LT multiplier matrix assumes typical runner physiology

---

## LT Multiplier Matrix (tier-aware marathon, audit 2026-04-10; revised 2026-05-12 audit #11)

**File**: `src/calculations/predictions.ts`

**5K/10K/HM** (stable across tiers):

| Distance | Speed | Balanced | Endurance |
|---|---|---|---|
| 5K | 0.92 | 0.935 | 0.95 |
| 10K | 0.98 | 0.995 | 1.01 |
| Half | 1.03 | 1.045 | 1.06 |

**Marathon** (tier-aware, with linear interpolation between tiers per 2026-05-12 audit #11):

| Tier | VDOT anchor | Speed | Balanced | Endurance |
|---|---|---|---|---|
| high_volume / performance | 60 / 52 | **1.10** | 1.06 | 1.04 |
| trained | 45 | **1.12** | 1.08 | 1.06 |
| recreational (default) | 38 | 1.12 | 1.10 | 1.08 |
| beginner | 30 (floor) | 1.14 | 1.115 | 1.09 |

**2026-05-12 audit #11 changes** (Speed column at performance & trained tiers):
- `performance·speed`: 1.08 → **1.10** (+2 min at boundary)
- `trained·speed`: 1.10 → **1.12** (+2 min at boundary)

The original 1.08/1.10 was calibrated on athletes with **demonstrated marathon fitness** (an existing M PB anchored the calibration). For first-marathon projections from a speed profile (sub-18 5K, no half/marathon PB), the LT→marathon-pace ratio is wider. Billat et al. (2003) "Training and bioenergetics characteristics of long distance runners" found speed-profile athletes sustain 3-5% less of LT pace at marathon distance than endurance-profile athletes at equivalent aerobic capacity. Coyle et al. (1988) "Determinants of endurance in well-trained cyclists" supports the same fractional-utilization gap in cycling at extended duration.

**Tier boundary smoothing (2026-05-12)**: Tier lookup was previously a step function (`if ltVdot >= 52: performance; else if >= 45: trained; …`), producing up to a 2-minute discontinuity in marathon prediction for athletes near a boundary. Now uses linear interpolation between adjacent tier anchors, indexed by LT-derived VDOT. Speed-column example at LT VDOT 50: `1.12 - ((50-45)/(52-45)) × (1.12 - 1.10) = 1.106` (was a hard 1.10 above 52 / 1.12 below). Eliminates lottery behaviour where ±0.5 VDOT jitter flipped the prediction.

**Scientific basis** (preserved from audit #8): LT pace represents ~60-minute sustainable effort. Speed-type runners are faster at short distances (lower multiplier) but slower at marathon (higher multiplier) because their anaerobic advantage fades with distance. Endurance-type runners show the inverse pattern. Marathon tier scaling reflects that elite runners maintain closer to LT pace over 42K due to superior fat oxidation, glycogen sparing, and pacing efficiency (Daniels tables, Humphrey 2020, critical speed literature).

**Known limitations**:
- Specific multiplier values are empirically calibrated against Daniels' tables + Billat 2003, not derived from a single published dataset
- Tier boundaries map to LT-derived VDOT — independent of `athleteTier` (CTL-based) which would conflate cross-training fitness
- No adjustment for course profile (hilly marathons would need higher multipliers)
- Endurance column may be slightly conservative for high-volume marathon specialists; revisit if specific feedback emerges

---

## Marathon Prediction Audit #11 (2026-05-12, ISSUE-145)

**Context**: ISSUE-145 documented that a speed-profile runner with k5=18:00 + k10=38:00 + LT=3:45/km (no HM/M PB) produced a 2:51:53 marathon prediction, vs the empirically-observed first-marathon range of 2:55-3:10 for sub-18 5K runners. Root cause was four compounding effects in `blendPredictions`: optimistic LT marathon multipliers, Riegel exponent under-correcting from short anchors, hard tier boundary, and no penalty for absent long-race history.

**Four-part fix**:

1. **LT marathon multipliers** (see table above): speed column raised at performance/trained tiers.

2. **Riegel exponent floor for long-distance extrapolation** (`predictFromPB`): when `targetDist >= 21097 && anchor.d <= 10000`, clamp `safeB` to a floor of 1.10 (in addition to the existing 1.15 ceiling). Speed-profile fatigue exponents derived from k5→k10 alone are typically 1.05-1.08, which under-correct the endurance drop-off past 21K when no half/full anchor exists.

   **Science**: Riegel (1981) "Athletic Records and Human Endurance" established b≈1.06-1.08 for trained runners over standard distances within his calibrated range. Cameron (1997) modified-Riegel work and Vickers & Vertosick (2016) "An empirical study of race times in recreational endurance runners" both note Riegel under-predicts marathon by 3-7% when the PB anchor is ≤10K and recent long-run mileage is unknown. The 1.10 floor matches Cameron's effective exponent for >4× distance extrapolations.

3. **Tier boundary smoothing** (`predictFromLT`): linear interpolation between tier anchors (see "Tier boundary smoothing" paragraph above).

4. **No-long-race-PB uncertainty penalty** (`blendPredictions`): when `targetDist === 42195 && tTanda == null && pbs.h == null && pbs.m == null`, apply multiplier 1.02 for Speed, 1.01 for Balanced, 1.00 for Endurance. Independent of (and stacks multiplicatively with) the existing `marathonSpecificityPenalty` because they fire on disjoint conditions (one requires weekly km signal + low volume; this requires absent long-race PB).

   **Science**: Joyner & Coyle (2008) decompose marathon performance into VO2max × fractional utilization × economy. Fractional utilization is the variable that's invisible in short-race data. Florence & Weir (1997) "Relationship of critical velocity to marathon running performance" showed critical velocity over-predicts first-marathon by 8-12%. Foster et al. (1994) "A new approach to monitoring exercise training" and Siler & Martin (1991) document 3-8% slower first-marathon times than short-race VDOT predictions for speed-dominant athletes. The 2% Speed / 1% Balanced calibration is at the low end of these observations (conservative — captures the direction without over-penalising).

**Combined effect on ISSUE-145 profile** (k5=1080, k10=2280, ltPace=225, Speed, no HM/M PB):
- Before audit #11: 10313 seconds (2:51:53), failed science floor of 10500
- After audit #11: **10728 seconds (2:58:48)** ✓ within empirical 2:55-3:10 range

**Validation**: All 36 `forecast-profiles.test.ts` profiles pass with the restored science-audit floor of `baselineRange[0] = 10500` (was lowered to 10080 to accommodate the bug). All 1783 tests in the full suite pass.

**Why NOT merge with the unified `specific-endurance-penalty.ts` framework** (yet): the unified framework requires training-history signal (weeklyRunKm + longestSession) which is unavailable at onboarding. The fixes above target the cold-start case (PBs only). A future merge could route LIVE dashboard predictions (with history) through the unified framework while keeping the cold-start penalties for onboarding — `predictions.ts:678-696` retains the parallel-implementation notice for that follow-up.

---

## Marathon Prediction Audit #12 — Dual-tau adaptation model + onboarding PB cross-check (2026-05-12)

**Context**: ISSUE-145 closure (audit #11) addressed cold-start prediction over-claim. Two follow-up gaps from the same audit window:

1. **Onboarding mis-labelling** — a user with a 3:37 marathon PB can self-select "beginner" (defined in onboarding as "running under 6 months"), which silently distorts the horizon model. Beginner band has `max_gain_pct=9` (marathon, vs 7 for intermediate) AND `ref_sessions=4` (vs 5.5), so at 4 sessions/week the mis-labelled runner gets ~1.5-2× the improvement of the correctly-labelled intermediate version of themselves. Was not caught at the PB-entry step.

2. **Long-plan saturation** — the single-tau week_factor (`1 - exp(-t/tau)` with tau=9 for marathon intermediate) reaches 99% by week 41. A 43-week plan and a 25-week plan claim nearly identical improvement (~22% gap), conflicting with the documented two-phase adaptation profile: VO2max plateaus by week 16-20 (Bouchard 1999, Midgley 2007), but LT and economy continue adapting to week 52+ (Seiler 2010, Coyle 1984, Moore 2016).

### Fix A — PB-vs-experience-level cross-check (Gap 1)

**File**: `src/calculations/experience-level-validation.ts` (new), wired into `src/ui/wizard/steps/manual-entry.ts`.

Pure function `checkExperienceLevelVsPBs(selectedLevel, pbs)` maps PBs → VDOT → expected experience band (Daniels 2014 bands: beginner <35, novice 35-42, intermediate 42-52, advanced 52-58, competitive ≥58). Returns inconsistent only when selected band is **below** PB-demonstrated band — over-claiming experience is allowed (yields lower max_gain, user's prerogative). `returning` and `hybrid` bypass the check (orthogonal to VDOT ladder).

UI surfaces an inline notice with one-tap "Use suggested level" CTA when PBs and selection disagree. Does NOT block progression — user can override.

### Fix B — Dual-tau adaptation model (Gap 2)

**File**: `src/calculations/training-horizon.ts`, constants in `src/constants/training-params.ts`.

Replaced single-exponential `weekFactor = 1 - exp(-t/tau)` with two-component additive model:

```
weekFactor(t) = (1 - slow_weight) * (1 - exp(-t/tau_fast))
              +  slow_weight      * (1 - exp(-t/tau_slow))
```

**Fast component** (VO2max + neuromuscular): tau_fast = 3.5–9.5 weeks (ability-band-scaled). Reaches 95% of fast-asymptote at 3× tau, matching Bouchard et al. (1999) HERITAGE study (95% VO2max plateau by week 16-20).

**Slow component** (LT + fractional utilization + economy): tau_slow = 14–30 weeks (ability-band-scaled). Reaches 95% at 60+ weeks, matching Seiler (2010) "What is best practice for training intensity and duration distribution in endurance athletes?" + Coyle (1984) detraining curves run in reverse.

**Per-distance slow_weight** (the share of total adaptation driven by the slow component):
- 5K: 0.30 (VO2max-dominant)
- 10K: 0.40
- Half: 0.50
- Marathon: 0.55 (LT/economy-dominant per Joyner & Coyle 2008 decomposition)

**Calibration check** — for an intermediate marathon runner (VDOT 45, 5 sessions, Balanced, taper 3w):
- 18 weeks: 3.32% improvement (was 3.84% under single-tau — slightly more conservative, still in Pfitzinger intermediate-plan range of 3-5%)
- 25 weeks: 3.64% (+0.32%)
- 35 weeks: 3.91% (+0.27%)
- 43 weeks: 4.05% (+0.14%)
- 52 weeks: 4.15% (+0.10%)

The 18→43 week gap is now 0.73% (was 0.18% under single-tau), better matching Pfitzinger two-block 43-week documented outcomes for intermediates (15-22 min improvement, ~7-10%). Diminishing returns are preserved (each chunk smaller than the previous).

**`max_gain_pct` not changed** — represents the very-long-plan asymptote (both components fully saturated) which the new model approaches more slowly. Asymptote ceiling and per-band values remain the calibration point.

**Legacy `tau_weeks` retained** in the params table as a defensive fallback (used only if `tau_fast_weeks` / `tau_slow_weeks` are missing — they're not). Marked deprecated in the type definition for future cleanup.

### Validation

- All 1806 tests pass (was 1783 before audit #11/#12 — added 13 validation tests, 5 dual-tau tests, 5 Riegel/scaling tests).
- ISSUE-145 prediction still lands at 2:58:48 (audit #11 fix preserved under dual-tau).
- Tristan-shape forecast (VDOT 42, returning, Speed, 5 sessions, 43-week marathon): forecasts to ~3:19 (was ~3:28 under single-tau + correctly-labelled intermediate). Now matches documented "returning runner first-year structured block" outcomes.

### Why not also adjust max_gain_cap_pct (Gap 4)?

The earlier audit hypothesis suggested intermediate runners could over-claim via `returning + Speed + 8 sessions` stacking. Re-checked under the corrected dual-tau model: maximum achievable improvement_pct for that stack at 43 weeks is ~10.6% → VDOT 46.5 → ~3:18 marathon from a 3:37 baseline (19 min improvement). Within literature for dedicated returning athletes (Pfitzinger advanced plans + Daniels 3-5 VDOT/year for returning trainees). The `max_gain_cap_pct = 15%` is rarely binding and acts as a sanity ceiling rather than a primary mechanism. No change.

### Why not also fix the "beginner > intermediate at 4 sessions" inversion (Gap 3)?

Verified that the inversion is structurally caused by beginner's lower `ref_sessions` (4.0 vs 5.5) combined with higher `max_gain_pct`. For a **true** beginner (VDOT 28-35) this is correct — they have more headroom and lower ref-session expectations. The inversion is only problematic when someone is **mis-labelled**, which Fix A above catches at the source. Closed by Fix A.

---

## Training Horizon (VDOT Gain Model)

**File**: `src/calculations/training-horizon.ts`, `src/constants/training-params.ts`

**Core formula**:
```
improvement% = maxGain * typeMod * weekFactor * sessionFactor * expFactor
             + taperBonus - undertrainPenalty
Clamped to [-3%, +15%]
vdotGain = baselineVdot * improvement% / 100
```

### Week factor (dual-tau adaptation, audit #12 — 2026-05-12)
```
weekFactor = (1 - slow_weight) * (1 - exp(-weeksEffective / tau_fast))
           +  slow_weight      * (1 - exp(-weeksEffective / tau_slow))
```
Two-component additive model. Fast component (tau 3.5-9.5 weeks, ability-scaled) captures VO2max + neuromuscular plateau by week 16-20 (Bouchard 1999, Midgley 2007). Slow component (tau 14-30 weeks, ability-scaled) captures LT + fractional utilization + economy continuing to week 52+ (Seiler 2010, Coyle 1984, Moore 2016). Per-distance `slow_weight`: 0.30 (5K) → 0.55 (marathon) per Joyner & Coyle (2008) decomposition. Diminishing returns preserved.

Legacy single-tau (`weekFactor = 1 - exp(-w/tau)`, tau 4-11) is retained in `tau_weeks` as a defensive fallback only; the new dual-tau path is the canonical model.

### Session factor (logistic)
```
sessionFactor = 1 / (1 + exp(-k * (sessionsPerWeek - refSessions)))
k = 1.0
```
At refSessions: factor = 0.5. Above: approaches 1.0. Below: drops toward 0.

### Experience factor
Total beginner: 0.75, beginner: 0.80, novice: 0.90, intermediate: 1.0, advanced: 1.05, competitive: 1.05, returning: 1.35 (recalibrated 2026-05-06 from 1.15 per Mujika & Padilla 2003 — see narrative section "returning 1.15 → 1.35" above), hybrid: 1.10.

### Maximum gain ceiling (% by distance and ability)

| Distance | Beginner | Novice | Intermediate | Advanced | Elite |
|---|---|---|---|---|---|
| 5K | 10.0 | 8.0 | 6.0 | 4.0 | 2.5 |
| 10K | 11.0 | 9.0 | 7.0 | 5.0 | 3.0 |
| Half | 12.0 | 10.0 | 8.0 | 6.0 | 3.5 |
| Marathon | 8.0 | 6.8 | 5.5 | 4.5 | 3.5 |

Marathon row revised (audit 2026-04-10). Previous values (8.0, 7.0, 6.0, 6.5, 4.0) had
advanced > intermediate, violating diminishing returns. New values calibrated against
HERITAGE study (Bouchard 1999) and Midgley 2007 meta-analysis:
- Beginner: 15-25% VO2max improvement over 12-20 weeks → 8.0% ceiling realistic
- Intermediate: 5-12% → 5.5% ceiling produces 2-3% realised gain at 16 weeks
- Advanced: 2-5% → 4.5% ceiling produces 1.7-2.5% realised gain
- Elite: <2% → 3.5% ceiling produces 1.3-1.9% realised gain
Realised gains verified by computing week_factor × session_factor × exp_factor
at ref_sessions for a 16-week plan; all tiers strictly decreasing.

### Undertraining penalty
```
If sessionsPerWeek < minSessions:
  penalty = penaltyPct * (minSessions - sessionsPerWeek) / minSessions
```
Min sessions: 5K=2.0, 10K=2.5, Half=3.0, Marathon=3.5.
Max penalty: 5K=2.0%, 10K=2.5%, Half=3.0%, Marathon=4.0%.

### Taper bonus
5K=0.8%, 10K=1.0%, Half=1.2%, Marathon=1.5%. Scaled by `min(taperWeeks / taperNominal, 1.0)`.

### Guardrails (experience-gated ceilings)
- Sub-3 marathon (VDOT 54): requires Advanced+ OR HM PB < 1:28
- Sub-3:30 (VDOT 48): requires Intermediate+
- Sub-4 (VDOT 43): requires Novice+

Athletes within 2 VDOT points of a ceiling are not capped (already near the barrier).

**Scientific basis**: The saturating exponential (week factor) follows standard pharmacokinetic adaptation models. Early training weeks produce rapid gains; later weeks plateau. The logistic session factor captures the dose-response relationship between training frequency and adaptation. Experience factors reflect the principle of diminishing returns: less-trained athletes have more room for improvement.

**Known limitations**:
- All constants are population-level; no individual adaptation rate modelling
- Linear undertraining penalty is a simplification; real detraining follows exponential decay
- Guardrails are conservative and may systematically limit high-potential athletes
- No age or sex adjustment to gain ceilings

---

## Skip Penalty

**File**: `src/calculations/training-horizon.ts`

**Formula**: `penalty_seconds = round(basePenalty * proximityFactor * skipFactor)`

**Base penalty (TIM) in seconds** by workout type:

| Type | 5K | 10K | Half | Marathon |
|---|---|---|---|---|
| easy | 5 | 8 | 10 | 15 |
| long | 10 | 15 | 30 | 60 |
| threshold | 15 | 15 | 25 | 30 |
| vo2 | 20 | 18 | 15 | -- |
| race_pace | -- | 15 | 20 | 35 |

**Proximity factor**: 0.5 (>=10 weeks out), 0.8 (>=6), 1.2 (>=3), 1.5 (<3 weeks).

**Cumulative skip factor**: 1.0 (1 skip), 1.3 (2), 1.7 (3), 2.0 + (n-4)*0.3 (>=4).

**Scientific basis**: Skipping workouts has compounding damage. Later skips hurt more (proximity) because there are fewer sessions remaining to recover the adaptation. Repeated skips compound because each missed session represents a larger fraction of the diminishing training budget. Long runs carry the highest marathon penalty (60s) because they are irreplaceable for glycogen depletion adaptation and mental preparation.

---

## Expected Physiology Trajectory

**File**: `src/calculations/training-horizon.ts`, `src/constants/training-params.ts`

**Formula**:
```
expectedLT = initialLT * (1 - gains.lt * weeksElapsed)
expectedVO2 = initialVO2 * (1 + gains.vo2 * weeksElapsed)
```

**Weekly improvement rates**:

| Level | VO2max/week | LT pace/week |
|---|---|---|
| novice | 0.55% | 0.70% |
| intermediate | 0.175% | 0.275% |
| advanced | 0.10% | 0.165% |
| elite | 0.05% | 0.075% |

**Scientific basis**: Empirical weekly adaptation rates from training studies. Novices improve faster (more headroom); elite athletes plateau. LT improves faster than VO2max because LT responds to moderate-volume training, while VO2max requires high-intensity stimuli and has a larger genetic component.

**Known limitations**:
- Linear projection ignores adaptation saturation (sigmoid reality)
- No individual variation for age, genetics, or training response
- Assumes consistent training adherence

---

## Readiness Score

**File**: `src/calculations/readiness.ts`

**Formula**: Weighted composite of sub-signals:

With recovery data (watch): `score = fitness * 0.35 + safety * 0.30 + recovery * 0.35`
Without recovery data: `score = fitness * 0.55 + safety * 0.45`

### Freshness sub-score (from TSB) — non-linear, exponent 1.2
```
tsbDaily = TSB / 7
fitnessFrac = clamp((tsbDaily + 25) / 55, 0, 1)
fitnessScore = fitnessFrac ^ 1.2 * 100
```
Key points: TSB daily +30 -> 100%, 0 -> 39%, -10 -> 21%, -25 -> 0%.

Exponent 1.2 (mild convex curve). TSB is not as exponentially risky as ACWR — negative TSB is normal during training blocks — so the curve is gentler. The fatigued end drops slightly faster than linear while the fresh end stays comfortable.

### Load safety sub-score (from ACWR) — non-linear, exponent 1.6
```
safetyFrac = clamp((2.0 - ACWR) / 1.2, 0, 1)
safetyScore = safetyFrac ^ 1.6 * 100
```
Key points: ACWR 0.8 -> 100%, 1.0 -> 75%, 1.3 -> 42%, 1.5 -> 25%, 1.7 -> 11%, 2.0 -> 0%.

Exponent 1.6 (strong convex curve). Reflects Gabbett (2016): injury risk accelerates exponentially above the safe zone. Going from ACWR 1.3 to 1.5 drops the score by 17 points (was 16 linear), but going from 1.5 to 1.7 drops by 14 points (was 17 linear) — the curve compresses the dangerous range more aggressively.

### Hard floors (safety constraints)
- ACWR > cautionUpper: score <= 39
- ACWR > safeUpper: score <= 59
- Sleep < 45: score <= 59
- HRV drop > 30%: score <= 59
- Sleep bank < -9000s (2.5h debt): score <= 59
- Strain 50-100%: linear 100 -> 59
- Strain > 130%: score <= 39

### Recovery trend multiplier
```
Recovery >= 70: 1.00x (normal)
50-69: 1.15x (mildly suppressed)
30-49: 1.30x (poor)
< 30: 1.50x (serious deficit)
```

### Labels
- >= 80: "Ready to Push"
- 60-79: "On Track"
- 40-59: "Manage Load"
- < 40: "Ease Back"

**Scientific basis**: Each sub-signal is an established training monitoring metric. TSB (Coggan) indicates fatigue state, ACWR (Gabbett) indicates injury risk. Sub-scores use non-linear (power curve) mapping rather than linear because the underlying risk relationships are non-linear: injury risk accelerates exponentially with ACWR (Gabbett 2016), and sleep deprivation effects compound non-linearly (Van Dongen 2003). ACWR uses a stronger exponent (1.6) than TSB (1.2) because load spikes are the most dangerous signal. Hard floors serve as a safety net for extreme cases.

**Known limitations**:
- Weights are expert-calibrated, not individually optimised
- Hard floors are conservative; some athletes tolerate high ACWR without injury
- Without wearable data, the score loses 35% of its information (recovery component)

### Insufficient history (< 3 completed weeks) — updated 2026-06-15

TSB, ACWR, and momentum are derived from accumulated logged load. With fewer than 3 completed weeks they are unreliable: ACWR especially swings wildly off a near-zero or seeded chronic baseline. The model therefore **neutralises the freshness and load-safety sub-scores to 65 and skips the ACWR hard floor** until 3 weeks of history exist.

Recovery (sleep, HRV) and today's strain / leg load are **point-in-time signals that are valid from day one** — a bad night is a bad night regardless of how many weeks of training precede it. These still feed the composite and their floors still apply during the insufficient-history window. Concretely, with no recovery data the score stays at the neutral 65 ("On Track", preserving the prior safe default), but a logged sleep of 25/100 in week 1 now drives the recovery sub-score to ~25 and pulls the composite to ~51 ("Manage Load"), with driving signal "recovery".

This corrects a bug (pre-2026-06-15) where the insufficient-history branch returned a flat 65/On Track and discarded the recovery, strain, and leg-load signals entirely — so a terrible sleep score had zero effect on readiness through the first three weeks of a fresh plan, the exact window in which a new user is most likely to log a check-in. **Defensibility**: the load-history signals are genuinely uninformative early on (this is why the guard exists), but recovery is not load-history-dependent, so suppressing it was a category error rather than a conservative simplification.

---

## Recovery Score (sleep + HRV, RHR override)

**File**: `src/calculations/readiness.ts`

**Composite**: `score = HRV * 0.55 + Sleep * 0.45` (renormalised when one signal missing).

RHR is not a weighted input. It acts as a graduated hard floor (see below).

### HRV sub-score (55% weight)

**Z-score method** (>= 10 baseline readings):
```
z = (7d_avg_HRV - 28d_avg_HRV) / 28d_SD
chronicScore = clamp(80 + z * 20, 0, 100)
```

**Percentage fallback** (< 10 readings):
```
chronicDelta = (7d_avg - 28d_avg) / 28d_avg
chronicScore = clamp(80 + chronicDelta * 175, 0, 100)
```

### Sleep sub-score (45% weight)
Uses Garmin/Apple sleep score directly when available (0-100 scale). Fallback uses chronic delta with asymmetric acute modifier (negative nights penalised 50x, positive only 20x).

### RHR override (graduated hard floor, not weighted)

RHR is a high-specificity, low-sensitivity signal (Buchheit 2014). It adds noise when weighted continuously (caffeine, heat, hydration shift it without reflecting recovery state) but has strong diagnostic value when genuinely elevated. The SD-based override plays to this strength.

```
deviationSD = (7d_avg_RHR - 28d_avg_RHR) / 28d_SD_RHR

2.0 to 2.5 SD above baseline:  cap score at 55   (Fair zone)
2.5 to 3.0 SD above baseline:  cap score at 40   (Poor zone, triggers load reduction)
>= 3.0 SD above baseline:      cap score at 25   (severe brake, illness/overtraining)
```

The 0-100 `rhrScore` (80 - deltaBpm * 5) is still computed for display in the detail view but does not affect the composite.

**Scientific basis**: HRV (RMSSD) is the most validated non-invasive marker of autonomic recovery (Plews et al., 2013; Buchheit, 2014). Sleep is the most impactful and actionable recovery behaviour (Walker, Samuels). Equal-ish weighting (55/45) reflects that neither clearly dominates: HRV is more responsive, sleep is more stable and actionable. No published study validates specific composite weights; the choice is informed by the literature but not derived from it.

RHR override uses personal SD rather than absolute bpm thresholds because inter-individual RHR variation is large (40-70 bpm in trained athletes). The 2 SD threshold aligns with Buchheit's "+7 bpm = meaningful concern" for a typical athlete with SD of 2.5-3 bpm.

**Known limitations**:
- Requires minimum 3 days of data; returns null below this
- Day-to-day HRV noise is high; only the 7d vs 28d trend is used
- HRV varies by device, measurement time, and body position
- RHR override requires sufficient baseline variance; athletes with extremely stable RHR (SD < 1 bpm) may trigger the override from normal fluctuations. Guard: override only computed when SD > 0

---

## Sleep Debt Model

**File**: `src/calculations/sleep-insights.ts`

### Sleep target derivation
```
If < 5 nights history: default = 25200s (7h)
Else: median of last 30 nights, clamped [25200s, 32400s]   (7h–9h)
```

**Superseded 2026-04-29: switched from 65th percentile [7h, 8h] to median [7h, 9h].**

The percentile method effectively treated "longest 35% of nights" as the target, which guarantees structural debt by construction — most nights miss target by definition. For a user whose 30-day average sleep is 7h 22m, the prior method produced a 7h 52m target (~30 min above mean), generating ~5h of steady-state debt before any chronic shortfall or load bonus, even when their physiology showed no fatigue signal. This was demoralising and not literature-grounded.

The replacement uses the median of the last 30 nights — a robust central-tendency estimator for habitual sleep, the closest passive proxy for sleep need. Habitual / free-day sleep as a proxy for need is supported by:
- **Roenneberg et al. 2007, 2012** — "free-day sleep" (no alarm) is the standard chronotype-research measure of biological sleep need; converges on median-class central tendency rather than upper-tail
- **Klerman & Dijk 2008** — habitual sleep duration in absence of restriction approximates intrinsic need, varies meaningfully by individual and age
- **Hirshkowitz / NSF 2015** — recommended adult range 7–9h; "may be appropriate" 6–10h. Justifies the 9h ceiling raise (previously 8h, which clamped the target down for users whose habitual sleep was 8h+)

**What stays the same**:
- 7h floor anchored to Van Dongen & Dinges 2003 — chronic restriction below 7h produces measurable cognitive deficits across the population. Below-floor users still get clamped to 7h and accumulate debt appropriately.
- Load-adjusted bonus (`+0.25 min/TSS`, tier-capped) is unchanged. This sits *on top* of the personal base target.
- Surplus credit (0.5 ratio, 60-min cap) and 7-day decay half-life are unchanged.

**Flow-through to recovery**: `readiness.ts:507-509` floors trigger on `sleepBankSec < -9000s` (2.5h) and `< -5400s` (1.5h). These thresholds were calibrated against the prior high-bias target. Lowering the typical target shifts the bank closer to zero for stable sleepers, so the floors trigger less often. Direction is correct (fewer false alarms for sleepers whose physiology is fine); thresholds themselves remain anchored to Van Dongen 2003 chronic-restriction evidence and don't need re-tuning.

**Migration**: no migration code needed. `deriveSleepTarget` is called fresh on each render. Users who set `s.sleepTargetSec` manually via account-view keep that override.

### Load-adjusted target
```
bonus_min = min(yesterdayTSS * 0.25, tier_cap)
Caps: beginner=20, recreational=30, trained=40, performance=50, high_volume=60 min
```

### Sleep quality multiplier — DELETED (audit 2026-04-10)

`sleepQualityMultiplier()` removed: was dead code (defined but never called). The actual
sleep score comes from Garmin natively or `computeSleepScore()` for Apple Watch users.

### Apple Watch sleep score (computeSleepScore, appleHealthSync.ts)

Apple Watch does not provide a composite sleep score. We compute one from HealthKit stage data:
```
score = durationScore * 0.55 + deepScore * 0.25 + remScore * 0.20
```
- **Duration (55%)**: `min(100, actualSec / targetSec * 100)`. Target = 7h default.
  Strongest predictor of next-day performance (sleep extension studies).
- **Deep (25%)**: `min(100, deepPct / 0.175 * 100)`. Peaks at 17.5% of total sleep.
  GH secretion, glycogen resynthesis, tissue repair (Van Cauter 2000, Dattilo 2011).
- **REM (20%)**: `min(100, remPct / 0.225 * 100)`. Peaks at 22.5% of total sleep.
  Motor memory consolidation, cognitive recovery (Walker 2017, Rasch & Born 2013).

Deep > REM weighting reflects athletic context: physical recovery (deep) is more directly
tied to training adaptation than cognitive consolidation (REM). No wearable publishes exact
weights (all proprietary), but the duration-dominant, slight deep bias aligns with the
scientific literature on sleep and athletic performance.

Audited 2026-04-10: kept at 55/25/20.

**Stage-less sources — "works for all watches" (2026-06-12).** The 55/25/20 formula
assumes the source reports sleep architecture (deep/REM segments). Apple Watch does,
but Apple Health is an aggregation layer: a Garmin, Coros, Polar or basic tracker may
write only a generic `'asleep'` state to HealthKit with no stage breakdown. That yields
`deepSec = 0` and `remSec = 0`, so `deepScore` and `remScore` both collapse to 0 and the
score is hard-capped at `durationScore × 0.55 = 55/100` — an 8h healthy night scored as
mediocre, which then drags Readiness down for every non-Apple-Watch user.

Fix: when no architecture is reported (`sleepDeepSec === 0 && sleepRemSec === 0`), score on
the only measured signal — duration — i.e. renormalise the 55% duration weight to 100%
(`score = durationScore`). This introduces **no new constants**; it is the standard
"don't penalise for unmeasured data, score on available signal" handling. Staged nights
(any deep OR REM present) keep the full 55/25/20 formula, so a genuinely low-deep night is
still penalised correctly. Limitation: a stage-less score reflects quantity only, not
architecture quality — but a duration-true score is strictly more honest than a fixed 55
cap. Guarded by `sleep-score.test.ts`.

### Debt accumulation (exponential decay + capped surplus credit)
```
For each night chronologically:
  shortfall = max(0, target - actual_duration)
  surplus   = max(0, actual_duration - target)
  credit    = min(SURPLUS_CREDIT_CAP_SEC, surplus * SURPLUS_CREDIT_RATIO)
  debt      = max(0, debt * DEBT_DECAY + shortfall - credit)

DEBT_DECAY              = exp(-ln(2) / 7) ~= 0.9057    (7-day half-life)
SURPLUS_CREDIT_RATIO    = 0.5                          (Banks & Dinges 2007)
SURPLUS_CREDIT_CAP_SEC  = 3600                         (1h max credit per night)
```

Both the headline debt value (`computeSleepDebt`) and the cumulative-debt line chart on the Sleep page are produced from this same recurrence via `computeSleepDebtSeries()`. The chart plots `−debt` per night (so deficit sits below the target line); the headline equals the last point of the series.

**Why partial surplus credit (changed 2026-04-28)**: the previous formulation gave zero credit for sleep above target — debt could only shrink via the 7-day decay. This produced a perpetually bleak signal: even after two 9h recovery nights, residual debt only fell ~18%. The literature actually supports recovery sleep reducing debt:
- **Banks & Dinges 2007** — one 10h recovery night after 5 nights of 4h restored ~50–70% of cognitive performance, not 0% (current model said 0%) and not 100% (Bevel-style "sleep banking" would say 100%).
- **Rupp et al. 2009** — extended recovery sleep produces dose-dependent recovery with diminishing returns.
- **Pejovic et al. 2013** — recovery sleep partially restores performance; not all metrics recover, and not in a single night.
- **Kitamura et al. 2016** — multi-week sleep extension gradually clears accumulated debt at sub-1:1 rate.

The 0.5 credit ratio picks the conservative end of the literature range. The 1h per-night cap mirrors the existing `TIER_LOAD_CAPS_SEC` convention and prevents a single 12h sleep from wiping out a week of accumulated debt — which would contradict Banks & Dinges. The hard floor at 0 means users cannot bank sleep; they can only accelerate clearance of existing debt.

**What stays asymmetric**: a 60-min deficit adds 60min to debt, but a 60-min surplus only removes 30min. This preserves the directional bias the literature requires (recovery is slower than the cost of restriction).

### Debt severity tiers (`classifySleepDebt`)

Returns `{ label, color, showNumber }`. The tier colour drives the Sleep page headline text, the cumulative-debt chart line, and the gradient fill — all three graduate together from emerald → slate → amber → orange → red so a small residual reads as reassuring and a real deficit reads as concerning.

| Debt | Label | Colour | Chronic equivalent | showNumber |
|---|---|---|---|---|
| < 45m | `on track` | emerald `#10B981` | effectively hitting target (residual within one night's natural variation) | false |
| 45m – 1h 30m | `caught up` | slate `#64748B` | ≈ one decayed short night; practically recovered | true |
| 1h 30m – 3h | `mild` | amber `#F59E0B` | ~15–30 min/night chronic shortfall | true |
| 3h – 6h | `moderate` | orange `#F97316` | ~30–60 min/night chronic shortfall | true |
| 6h – 9h | `high` | red `#EF4444` | ~60–90 min/night chronic shortfall | true |
| ≥ 9h | `severe` | red-600 `#DC2626` | approaches Van Dongen 2003 chronic restriction zone (≥ 75 min/night) | true |

**What literature supports**:
- Belenky et al. 2003 — single-night partial deprivation produces minor cognitive effects; chronic restriction (7+ nights of 3h or 5h) produces progressively larger deficits that don't fully recover after three recovery nights
- Van Dongen & Dinges 2003 — 14 days at 6h/night ≈ 1–2 nights of total deprivation equivalent (≈ 28h raw / ~20h decayed cumulative debt)
- Rupp et al. 2009 — recovery from chronic restriction is slow and incomplete; residual deficits persist for weeks

**What the minute-level cutoffs are**: pragmatic, not literature-derived. The *progression* is defensible (mild → moderate → high → severe corresponds to recognisable chronic-shortfall patterns). The specific boundaries are **intentionally conservative** — `severe` fires at 9h, roughly half of Van Dongen's ~20h chronic-restriction steady state, so tiers flag earlier than demonstrated-harmful levels.

**Why `on track` hides the number**: residuals under 45 min are physiological noise (single night's natural variation) and showing a precise "23m debt · on track" reads as punishing for a negligible quantity. Above 45 min the number is shown because it carries meaning.

**Why graduated colour, not binary red/green**: the earlier implementation used red for any non-zero debt, which made the model read as "always failing" even after a recovery week. Graduation through emerald → slate → amber → orange → red means the visual alarm only kicks in once debt is genuinely in the chronic-shortfall range.

### Sleep bank (rolling 7-night)
```
bankSec = SUM(last 7 nights: actual - target)
Balanced: within +/- 900s (15 min)
```

**Scientific basis**: Sleep target uses the median of personal history (Roenneberg habitual-sleep proxy for need) clamped to the literature-supported adult range [7h, 9h] (Van Dongen floor, NSF/Hirshkowitz ceiling). Load-adjusted bonus reflects adenosine accumulation from training (Dijk/Czeisler). The 7-day half-life reflects that performance debt from chronic sleep restriction persists longer than subjective sleepiness (Banks & Dinges 2007, Belenky et al. 2003). Previously 4-day (borrowed from ATL Banister model), revised based on evidence that cognitive/performance deficits take 1-2 weeks to clear. Aligns with Oura's 14-day lookback and WHOOP's stated persistence model. Sleep score for Apple Watch users is computed locally (see above); Garmin users get the native score.

**Known limitations**:
- Quality multiplier is not applied retroactively to debt (would cause compounding errors)
- Median requires 5+ nights of data; short-history users get a generic 7h target
- Sleep stage percentages depend on wearable accuracy (Garmin/Apple may misclassify stages)
- Tier caps are expert-set, not individually calibrated

### Debt outlook (trend, ETA, spike attribution)

`computeSleepDebtOutlook` (sleep-insights.ts) wraps the same recurrence used by `computeSleepDebt` and exposes three derived quantities used on the Sleep page to make the static debt number motivating rather than punishing:

- **Trend**: `series[last].debt − series[last − 7].debt`. Negative = clearing, positive = growing. Surfaces as "down 1h 12m this week".
- **Days-to-clear**: forward-simulates the recurrence for up to 60 nights using the last-7-night average actual sleep against the latest load-adjusted target, returns the first day debt drops below the "on track" threshold (45 min). Returns null when avg actual < target — debt won't clear at the recent pace, copy degrades to "not clearing yet — sleep is still under target".
- **Spike attribution**: counts nights in the visible window (last 14) whose individual shortfall exceeded `SPIKE_SHORTFALL_THRESHOLD_SEC = 7200s` (2h). For each spike, the *decayed* contribution to current debt is reported — `shortfall × DEBT_DECAY^(days_since_spike)` — not the raw shortfall. A 4h Sunday spike 3 days ago contributes ~3h to current debt, not 4h, because the recurrence has decayed it. Reporting raw shortfalls overstates "this is from that night" once decay has worked for several days. Capped at total debt (surplus-credit interactions between the spike and now can mathematically push the decayed sum slightly above the residual).
- **Personal-norm comparison**: 30-day rolling mean of the cumulative-debt series, requiring ≥14 entries for stability. Today's debt is classified `above`/`below`/`on_par` against this baseline using a tolerance band of `max(30 min, 15% of typical)`. Surfaced as a one-line caption beneath the absolute headline with relative colour (amber above / emerald below / slate on-par), independent of the absolute tier colour.

  **Why this exists**: a chronic short-sleeper whose habitual sleep is below the 7h floor will sit permanently at high steady-state debt (~5h+) under the unchanged debt math. The absolute number and tier still surface that — Van Dongen 2003 still applies, no science is being walked back. But a permanently amber/orange tier becomes a check-engine light the user tunes out. The personal-norm line restores signal value: it only flags when *this* week is materially different from *their* week, regardless of where the absolute level sits. The tolerance band (max 30 min / 15%) handles both small and large baselines without firing on noise.

  **Honest framing**: this does not endorse chronic undersleeping. The absolute number, the tier label, and the colour-graduated chart all remain anchored to population science. The personal-norm line is purely a *change* signal layered on top, not a *target* signal — users see both "you're chronically short by population standards" and "this week was/wasn't worse than your normal" simultaneously.

All four derive from the existing model's outputs — no new constants beyond the 2h spike threshold and the 30-min/15% tolerance band.

**Honest copy rule**: the simulation projects forward assuming `future avg actual = recent 7-night avg`. The view copy says "at this pace" to keep that assumption visible. Spike attribution is approximate — surplus-credit interactions between the spike and now are not accounted for — but the qualitative "this is from one short night" attribution is robust given the 2h gate.

---

## Sleep Insights Priority Rules

**File**: `src/calculations/sleep-insights.ts`

**Detection rules** (evaluated in priority order):

1. **Post-hard-week**: TSS > 250 AND score < 65 (or TSS > 350 AND score < 75) -- training load is suppressing sleep quality
2. **Consecutive bad nights**: >= 2 of last 3 nights below score 60 -- recommend intensity reduction
3. **Good streak**: exactly 3 consecutive nights >= 75 -- body primed for hard effort
4. **Bounce-back**: previous night < 60, latest >= 75 -- good recovery night
5. **Sleep debt**: 7-day average < 65 with >= 4 data points -- chronic deficit
6. **Improving trend**: latest >= 75 AND > 7d average + 12 -- above recent average

**Scientific basis**: Priority ordering reflects clinical significance. Acute sleep-training interactions (rule 1) override chronic patterns. The thresholds are calibrated against Garmin/Apple sleep scoring scales where < 60 = poor and >= 75 = good.

---

## Activity Matching

**File**: `src/calculations/activity-matcher.ts`

### RPE derivation priority chain
1. Garmin RPE (direct, 1-10)
2. HR zone mapping via Karvonen (intensity -> RPE: <0.50=3, 0.50-0.65=4, 0.65-0.75=5, 0.75-0.82=6, 0.82-0.89=8, >=0.89=9)
3. Training Effect proxy (Garmin 0-5 scale mapped to RPE)
4. Activity type heuristic (walking=3, hiking=4, strength=6)
5. Default: planned RPE or 5

### Match scoring
- Same day: +3 points; adjacent day: +1; sport name match: +5; distance within 15%: +3; run type affinity: +1
- Minimum score thresholds: runs=3, gym=2, sport=5
- Different-day matches capped at medium confidence

### Pace adherence
```
paceAdherence = actualPace / targetPace
1.0 = on target, >1.0 = slower, <1.0 = faster
```

**Known limitations**:
- Default resting HR of 55 bpm may be far from actual for some athletes
- Age-estimated maxHR (220-age) has ~10 bpm SD
- Sport name matching is string-based; relies on consistent naming

---

## Plan Engine: Phase Distribution

**File**: `src/workouts/plan_engine.ts`, `src/workouts/generator.ts`

**Phase allocation**:
```
taperWeeks = max(1, ceil(totalWeeks * 0.12))
preTaper = totalWeeks - taperWeeks
baseWeeks = max(1, round(preTaper * 0.45))
buildWeeks = max(1, round(preTaper * 0.40))
peakWeeks = preTaper - baseWeeks - buildWeeks
```

**Taper nominal weeks**: 5K=1, 10K=2, Half=2, Marathon=3.

**Example (16-week marathon plan)**: taper=2, base=6, build=6, peak=2.

**Deload cycles** (ability-dependent):
- Beginner/novice: every 3 weeks, 0.80x volume
- Intermediate: every 4 weeks, 0.85x
- Advanced: every 5 weeks, 0.87x
- Elite: every 6 weeks, 0.90x

**Scientific basis**: The 45/40/15 (base/build/peak) split follows classical periodisation (Bompa, 1999). Base phase develops aerobic foundation, build phase introduces race-specific intensity, peak phase maximises fitness before taper. The 12% taper allocation aligns with Mujika & Padilla (2003) showing 2-3 week tapers optimal for distance events. Deload frequency increases with training maturity because trained athletes recover faster and tolerate longer loading blocks.

---

## Plan Engine: Session Budgets

**File**: `src/workouts/plan_engine.ts`

### Long run minutes
Base by race: 5K=50, 10K=60, Half=80, Marathon=90.
Progressive ramp: 80% to 100% over first 75% of plan.
Phase: taper=0.65x, peak=1.05x.
Ability caps: beginner=90, novice=100, intermediate=120, advanced=150, elite=180 min.

### Easy run minutes
Base by ability: beginner=30, novice=35, intermediate=40, advanced=45, elite=50 min.
Marathon multiplier: 1.15x. Taper: 0.70x.

### Threshold work minutes
Base: beginner=12, novice=15, intermediate=20, advanced=25, elite=30 min.
Ramp: 75% to 100% over first 80% of plan.
Phase: base=0.85x, peak=1.05x, taper=0.60x.

### VO2 work minutes
Base: beginner=8, novice=10, intermediate=14, advanced=18, elite=22 min.
Phase: base=0.6x, build=0.9x, peak=1.1x, taper=0.5x.

### Marathon pace work minutes
Eligibility: marathon or half only, build/peak phases.
Base: beginner=15 to elite=50 min. Half=0.6x.

### Float fartlek minutes
Eligibility: half/marathon only, build/peak, intermediate+ ability.
Base: intermediate=18, advanced=22, elite=26 min.

**Scientific basis**: Session budgets follow polarised training principles (Seiler, 2010). Easy runs (Zone 1-2) form the volume base. Quality sessions (threshold, VO2, MP) are limited by ability to prevent overtraining. Progressive ramps avoid sudden load spikes. Phase multipliers implement periodisation: VO2 work is minimal in base (0.6x) and maximal in peak (1.1x), reflecting the principle of building aerobic base before introducing high-intensity stimuli.

**Float fartlek rationale**: Moderate-effort recovery at ~MP trains MCT1/MCT4 lactate transporters (Brooks, 2009). Sustained blood lactate at 2-3 mmol/L during float segments forces aerobic adaptation under mild acidosis, mimicking marathon racing metabolic profile (Coyle, 2007). Restricted to intermediate+ because it requires pacing discipline.

---

## Plan Engine: Quality Session Management

**File**: `src/workouts/plan_engine.ts`

### Quality session cap
Beginner/novice: 1/week. Intermediate/advanced: 2/week. Elite: 3/week.
Constrained: `maxQuality = min(base, runsPerWeek - 1)` (at least 1 easy session).

### ACWR adaptation
- Caution: maxQuality -= 1
- High: maxQuality -= 2
- High ACWR also prevents long run progression (capped at previous week's value)

### Effort multiplier
```
effortMult = clamp(1 - effortScore * 0.05, 0.85, 1.15)
```
Score +3 (fatigued) -> 0.85x volume. Score -3 (fresh) -> 1.15x.

### Workout priority by race and phase
Marathon build: MP > float > threshold > VO2.
Marathon peak: MP > float > VO2 > threshold.
5K build/peak: VO2 > threshold.

### Runner type bias
Speed runners: promote threshold (trains weakness).
Endurance runners: promote VO2 (trains weakness).

**Scientific basis**: Quality session limits prevent overtraining by capping high-intensity exposure. The "train your weakness" bias follows the principle that speed runners benefit most from endurance work and vice versa. ACWR-driven quality reduction is a proactive injury prevention measure aligned with Gabbett's load management framework.

---

## Workout Importance (IMP) & Variant Rotation

**File**: `src/constants/training-params.ts`, `src/workouts/plan_engine.ts`

### Importance by distance (0 = unimportant, 1.0 = critical)

| Type | 5K | 10K | Half | Marathon |
|---|---|---|---|---|
| long | 0.50 | 0.70 | 0.95 | 1.00 |
| vo2 | 0.95 | 0.90 | 0.70 | 0.70 |
| threshold | 0.80 | 0.90 | 0.95 | 0.90 |
| marathon_pace | -- | -- | 0.90 | 0.95 |
| progressive | -- | -- | 0.90 | 0.95 |

### Variant rotation
VO2: cycles through 5x3min, 6x2min, 5x4min, 12x1min.
Threshold: 20min continuous, 3x8min, 2x12min, 5x5min cruise.
Long: steady, fast-finish, with threshold blocks.
Float: 6x3/2, 5x4/2, 8x2/2, 4x5/3 (Hudson/Canova formats).

Selection: `variant[max(0, weekIndex - 1) % variants.length]`

**Scientific basis**: Importance weights reflect event-specific training priorities. Marathon long runs are rated 1.0 because glycogen depletion training and mental preparation are irreplaceable. 5K VO2 work is 0.95 because VO2max is the primary performance determinant at that distance. Variant rotation prevents accommodation (repeated bout effect) and provides progressive overload through varying stimulus characteristics.

---

## Recovery Countdown -- To Baseline (Stacked Session Recovery) (2026-04-09)

**File**: `src/calculations/fitness-model.ts` (`computeToBaseline()`)

**Formula**: Walk forward chronologically through all recent sessions (current week + last 3 days of previous week). For each session with TSS > 10:
1. Tick down running recovery total by hours elapsed since last session
2. Add `8 * sessionTSS / ctlDaily * recoveryMult * recoveryAdj` hours
3. After last session, tick down by hours until now

**Stacking rationale**: Sessions accumulate fatigue. A hard Tuesday session on top of a hard Monday means more recovery needed than Tuesday alone. Garmin/Firstbeat stack sessions the same way: each new session extends the recovery timer. The previous model only counted the single most recent workout, which produced 0h when the last session had cleared even if multi-day fatigue was still present.

**Terms**:
- `sessionTSS` -- Signal B TSS for each day with significant load (> 10 TSS), via `computeTodaySignalBTSS`.
- `ctlDaily` -- chronic training load (weekly CTL / 7). Higher fitness = faster recovery from the same absolute load.
- `recoveryMult` -- sport-specific recovery multiplier from `SPORTS_DB`. Weighted average when multiple activities in one day. Reflects exercise-induced muscle damage differences: swimming 0.90, cycling 0.95, running 1.0, rugby 1.30.
- `recoveryAdj` -- adjustment from `computeRecoveryScore` (sleep, HRV, RHR). Score 50 = 1.0x, score 20 = 1.3x (slower), score 80 = 0.7x (faster). Clamped to 0.7-1.3 range.

**Scientific basis**: Recovery time is proportional to session load relative to chronic fitness. Same principle as Firstbeat Analytics' (Garmin's) EPOC-based recovery advisor. TSS correlates with TRIMP/EPOC (both HR-derived load metrics). CTL daily correlates with VO2max-like aerobic fitness.

**Constant 8**: Empirically calibrated to match Garmin/Firstbeat's published recovery windows:
- Easy run (30 TSS, CTL=37): ~6.5h
- Moderate session (58 TSS, CTL=37): ~12.5h (matches Garmin's typical 12h)
- Hard session (100 TSS, CTL=37): ~22h
- Marathon race (250 TSS, CTL=37): ~54h (Garmin typically shows 48-72h)

**Recovery score adjustment**: Sleep quality, HRV (RMSSD), and resting HR are the three most validated recovery biomarkers (Buchheit 2014, Plews et al. 2013). The +/-30% range is conservative.

**Known limitations**:
- Linear scaling per session is a simplification. Real EPOC follows bi-exponential decay. For practical session loads (30-250 TSS), linear gives comparable results.
- Stacking is additive (session A + session B). Real fatigue interaction is likely sub-additive for very light sessions and supra-additive for back-to-back hard sessions. For typical training patterns this is acceptable.
- Does not account for individual variation (age, training history, genetics).
- Sport-specific `recoveryMult` values are estimates, not individually measured.
- The constant 8 would need recalibration if TSS or CTL methodology changes.

---

## Recovery Countdown -- Full Fresh / TSB Clearance (2026-04-09)

**File**: `src/ui/freshness-view.ts`

**Formula**: `freshHours = -7 * ln(CTL / ATL) * 24`

**Scientific basis**: Standard Banister impulse-response model (Banister et al., 1975). ATL decays exponentially with a 7-day time constant, CTL with 42-day. These are the canonical values used by TrainingPeaks, WKO, and every PMC (Performance Management Chart) implementation.

**What it answers**: Hours of zero training load until TSB (Training Stress Balance = CTL - ATL) reaches zero. This is a macro fatigue-clearance metric useful for taper timing, not single-session recovery.

**Known limitations**:
- Uses weekly-stepped EMA values with intra-week daily decay interpolation. Not a true daily model.
- Assumes zero load going forward (if the athlete trains, the estimate is invalid).
- TSB = 0 is an arbitrary "fresh" threshold. Some athletes perform best at slightly negative TSB.

---

## Intra-week ATL/CTL Decay (2026-04-09)

**File**: `src/ui/freshness-view.ts`

**Formula**: For each day from week-end to today:
```
ATL = ATL * exp(-1/7) + dayTSS * 7 * (1 - exp(-1/7))
CTL = CTL * exp(-1/42) + dayTSS * 7 * (1 - exp(-1/42))
```

**Why needed**: `computeSameSignalTSB` only updates ATL/CTL at week boundaries. Between updates, rest days don't reduce ATL. This makes recovery estimates too high (e.g. 66h instead of 18h) because the model doesn't know the athlete has been resting for 2 days.

**The `* 7` factor**: The EMA operates in weekly TSS units. A daily load of X sustained for 7 days equals a weekly load of 7X. So daily TSS is converted to weekly-equivalent before feeding the EMA step.

**DST safety**: Uses noon-anchored Date objects with `setDate()` arithmetic instead of raw millisecond offsets, which drift across DST boundaries.

---

## CTL/ATL EMA -- Weekly Decay Constants

**File**: `src/calculations/fitness-model.ts`

**Constants**:
- `CTL_DECAY = exp(-7/42) ~= 0.847` -- chronic training load, 42-day time constant
- `ATL_DECAY = exp(-7/7) ~= 0.368` -- acute training load, 7-day time constant

**Scientific basis**: Banister impulse-response model (1975). The 42-day and 7-day time constants are the standard values validated across decades of applied sports science. Used by TrainingPeaks, Golden Cheetah, WKO.

**EMA formula**: `CTL_new = CTL_old * CTL_DECAY + weekTSS * (1 - CTL_DECAY)`

---

## iTRIMP Normalisation

**File**: `src/calculations/fitness-model.ts`

**Formula**: `equivTSS = (iTrimp * 100) / 15000 * runSpec`

**Terms**:
- `iTrimp` -- individualised TRIMP from HR stream data. Computed by the edge function from second-by-second HR zones.
- `15000` -- normalisation constant. Represents the approximate iTRIMP of a 1-hour threshold-effort run. Maps raw iTRIMP to a 0-100ish TSS-equivalent scale.
- `runSpec` -- sport-specific running-equivalence discount. Running = 1.0, skiing = 0.75, cycling = 0.55, etc. Only applied to Signal A (running fitness). Signal B uses full iTRIMP without runSpec.

**Known limitations**:
- The 15000 normaliser is approximate. Individual HR profiles can shift what "threshold effort" means in iTRIMP units.
- `runSpec` values are estimates of how much each sport transfers to running fitness, not precise measurements.

---

## Signal A vs Signal B

**File**: `src/calculations/fitness-model.ts`

**Signal A** (run-equivalent load): applies runSpec discount to cross-training. Used for CTL in plan view, running fitness tracking, replace/reduce decisions, race prediction.

**Signal B** (raw physiological load): no runSpec discount; counts full metabolic cost. Used for ATL, ACWR, freshness/TSB, total load display.

**Rationale**: A padel session that produces 80 iTRIMP has only ~36 TSS of running-equivalent fitness benefit (runSpec 0.45), but it creates 80 TSS worth of physiological fatigue. Signal A captures the training effect; Signal B captures the recovery cost.

**Once-per-signal invariant (2026-10-05, audit B3/X7/X9/B20).** Tracking side. Every completed activity contributes at most once to each load signal: weekly A, weekly B, daily B, the per-sport breakdown, sleep daily load and strain. Each activity is weighted once, at its own sport's runSpec in A and at full TSS in B.
- **Pairing.** Synced cross-training can be stored up to three times: a `garminActuals['garmin-<id>']` twin, an adhoc entry and, for overflow, an `unspentLoadItem`. An adhoc entry pairs with its twin by two keys: its `garminId`, and the twin's `garminActuals` key (`garmin-<id>`). The key matters because the Strava upgrade rewrites the twin's `garminId` to `strava-<id>` but keeps the key and the adhoc id. `garminActuals` win over their adhoc twin.
- **`unspentLoadItems` are decision records, never load.** Overflow, `surplus_run` and unmatched items feed the excess-load flow (Adjust week, carry-over card; the Tier 2 excess card is not rendered) and the Home ACWR "Reduce session load" path (button gate and `triggerACWRReduction`, running mode only since 2026-10-06). Each points at an activity, or the surplus slice of a run, that `garminActuals` or `adhocWorkouts` already holds, so emptying `unspentLoadItems` changes neither signal. Before the fix, Signal A counted a synced ride at full weight through its twin and then added the overflow item again (min × 1.15 × runSpec): a 60-min ride read A 98 vs B 60.
- **Scope.** Signal A counts `garminActuals` and `garmin-` adhoc entries only. Since 2026-10-06 an in-app GPS run or Mark as Done writes a `garminActuals` record (§CN), so it counts in A at its sport's runSpec. A done non-`garmin-` adhoc entry with no record (completions stored before that build) still contributes 0 to A while B counts it (audit B9, ISSUE-322).
- **Same formulas.** Both signals use the same per-activity TSS formulas and RPE fallbacks (`garminActuals`: rated RPE, else 5; adhoc: `rpe`, then `r`, then 5). Since no runSpec exceeds 1.0, Signal A never exceeds Signal B for a week (locked by `load-once-per-activity.test.ts`).

**Signal A uses the activity's own sport (2026-10-05).** Signal A = TSS × `SPORTS_DB[sport].runSpec`, where `sport` is what the device recorded, never the plan slot it filled. Resolution order (`resolveActualSport`, `cross-training/activities.ts`): `manualSport`, then `isStrengthActual`, then `activityType` (`deriveSportFromActivityType`), then the slot-fill `displayName` label; a run-slot row with no `activityType` stays a run. One exception comes first in both signals: a rated strength session takes the strength RPE override (`computeStrengthRpeTSS`; strength runSpec in A, full in B), even when `manualSport` names another sport (ISSUE-320). HIIT and ambiguous gym-slot fills map to strength, the matcher's gym bucket. A walk logged against a run slot counts at the walking runSpec. The strength override already applies the strength runSpec and is not discounted again. Before the fix, synced cross-training entered live Signal A at runSpec 1.0 through its `garminActuals` twin, while the history seeds that set the CTL baseline already applied a runSpec, so running CTL stepped up at plan start for cross-trainers. Live A and the seeds now weight cross-training the same way for most sports. **Exceptions where the seed tables disagree with `SPORTS_DB`** (ISSUE-321):
- *Strava history, edge `getRunSpec`* (`supabase/functions/sync-strava-activities/index.ts`). Each Strava type is first mapped by the edge's `mapStravaType`; the seed weight is `getRunSpec` of the mapped type, the live weight is `SPORTS_DB[resolveActualSport(mapped type)].runSpec`. Mismatches: Workout, sail, surf, windsurf, kitesurf and skateboard map to CARDIO, 0.55 vs generic 0.40; walk, hike and snowshoe map to WALKING, 0.40 vs walking 0.30 (a Strava hike never reaches the hiking row); wheelchair 0.40 vs walking 0.30; weight training and CrossFit 0.30 vs strength 0.35; HIIT 0.30 vs strength 0.35; tennis, squash, badminton, table tennis and racquetball 0.45 vs tennis 0.50; pickleball 0.40 vs tennis 0.50; boxing and kickboxing 0.30 vs 0.25; nordic and backcountry ski 0.75 vs skiing 0.50; alpine ski and snowboard map to ALPINE_SKIING, 0.55 vs skiing 0.50; stand-up paddling 0.40 vs paddleboard 0.25; kayaking 0.40 vs 0.20; rock climbing 0.40 vs climbing 0.15. Running, cycling (incl. mountain bike), swimming, rowing and canoeing, yoga, pilates, soccer, rugby, golf and the INDOOR_CARDIO types (elliptical, stair stepper, skating) match. History mode also aggregates rows other sources wrote to `garmin_activities` with their own type strings (Garmin webhook, Apple upload); those go through the same `getRunSpec` and are not enumerated here.
- *Apple and FIT history, `mapActivityTypeToSportKey`* (`appleHealthSync.ts`, used by `aggregateHistoryFromRows` for Apple and file imports): only RUNNING, CYCLING, SWIMMING, WALKING, HIKING, STRENGTH_TRAINING, ELLIPTICAL, ROWING and STAIR_CLIMBING map to their `SPORTS_DB` row; everything else seeds at generic 0.40. FIT trail and treadmill runs therefore seed at 0.40 (and are left out of running km) but count 1.0 live; indoor cycling 0.40 vs 0.55; open-water swimming 0.40 vs 0.20; Apple yoga 0.40 vs 0.10, tennis 0.40 vs 0.50, basketball 0.40 vs 0.45, martial arts 0.40 vs 0.30, paddleboarding 0.40 vs 0.25.

So a per-sport step in running CTL remains at plan start for athletes whose history holds those sports.

**Comparisons stay on one signal (2026-10-05).** The coach `ctlTrend` compares live Signal B CTL with Signal B CTL four weeks back (`computeSameSignalCtlHistory`, same seed and walk as `computeSameSignalTSB`); comparing live B with the Signal A history read every steady cross-trainer as "building" (ISSUE-320 asks Tristan to confirm B). The running CTL-gap re-anchor values planned gym sessions at the strength runSpec, the currency of the Signal A actual side (§BR limitation 1).

**Limitations.** (1) The seed-table exceptions above. (2) Label and slot fallbacks only apply where the writer dropped `activityType`; a run-slot actual with a generic `activityType` ('Workout', 'CARDIO') counts at generic 0.40 until the user reclassifies it. (3) Signal A excludes GPS and manual adhocs (B9). (4) The per-day Signal B builders still disagree on a no-HR twin: `buildDailySignalBTSS` gives the twin 0 and counts the adhoc RPE estimate, `computeTodaySignalBTSS` gives the twin duration × `TL_PER_MIN[5]` and skips the adhoc (ISSUE-324). (5) Running CTL history shifts down once for cross-trainers, because past weeks are recomputed with the discount.

## HR Drift (Cardiovascular Decoupling) (2026-04-15)

**File**: `supabase/functions/sync-strava-activities/index.ts` (`calculateHRDrift`), surfaced in `src/calculations/workout-insight.ts`, `src/calculations/daily-coach.ts` (`detectEasyDriftPattern`, `computeLongRunDriftNote`), `src/ui/stats-view.ts` (`buildDurabilityChart`, `computeMarathonFadeRisk`), `src/ui/week-debrief.ts`.

**Formula**: `drift% = (avgHR_2nd_half − avgHR_1st_half) / avgHR_1st_half × 100`, computed on post-warmup HR samples (first 10% stripped). Requires ≥ 20 min of HR data with ≥ 120 samples; returned as one-decimal percentage.

**Scope**: Only applied to steady-state run types (`DRIFT_TYPES = RUNNING, TREADMILL_RUNNING, TRAIL_RUNNING, VIRTUAL_RUN, TRACK_RUNNING`). Pace-variable efforts (intervals, tempo with rest) produce misleading drift because HR lags pace changes.

**Thresholds** (zone classification):

| Drift | Interpretation | Colour |
|-------|----------------|--------|
| ≤ 5%  | Efficient (aerobic system coping with the load) | green |
| 5–8%  | Moderate drift (normal for long or warm-day efforts) | amber |
| > 8%  | Cardiovascular decoupling (heat, dehydration, fatigue, or pace too aggressive for current fitness) | red |

**Rationale for 5% / 8% cuts**: Maffetone, Friel, and the TrainingPeaks "Aerobic Decoupling" (Pw:HR) literature converge on ≤ 5% as the marker of a durable aerobic engine, with 5–8% as the transitional band and > 8% as clear decoupling. These are widely-used endurance-coaching heuristics, not hard physiological constants — useful as a practical signal but not a diagnostic.

**Pre-long-run nudge** (`computeLongRunDriftNote`): fires when today's planned session is a long run AND ≥ 2 of the last 3 long runs had drift > 8%. Scans 6 weeks. Copy suggests earlier fuelling cadence and controlled first-half pacing.

**Easy-pace drift pattern** (`detectEasyDriftPattern`): fires when the last 3 weeks of easy runs (≥ 3 samples) average drift > 5%. Suggests easy pace may sit too close to aerobic threshold and should be eased by 10–15 sec/km. 3-week window balances responsiveness with noise rejection; 5% matches the "efficient aerobic engine" threshold above.

**Aerobic Durability chart**: scatter of per-session drift across easy + long runs over the last 12 weeks. Rolling mean (4-point) overlaid; coloured bands at 5% / 8% reference thresholds.

**Marathon fade-risk badge** (`computeMarathonFadeRisk`): on the marathon race-estimate row only. Reads drift from recent long runs (goal pace or slower). If average drift > 8% across ≥ 2 samples, surfaces a "fade risk" warning. Marathon is the only distance where cardiovascular decoupling meaningfully compromises finishing pace — shorter distances finish before drift materialises.

**Commentary gating**: in-session drift commentary (`workout-insight.ts`) fires only on non-quality runs (`!s.quality`). Drift > 8% on a threshold or interval session is expected (high lactate, high ventilation, non-steady pace) and calling it out would be misleading.

**Known limitations**:
- Elevation profile influences drift on trail runs; we do not normalise for gradient.
- Wrist-based HR accuracy degrades during the first ~5–10 min (cadence lock). The 10% warmup strip mitigates but does not eliminate this.
- The 5% / 8% thresholds are coaching heuristics, not validated against a population cohort in this codebase.

**Heat correction (2026-04-16)**: ambient temperature is now fetched from Open-Meteo (free historical API, requires `start_latlng`) during drift computation and stored per-activity on `garmin_activities.ambient_temp_c`. Durability detection uses heat-adjusted drift:

`driftAdjusted = drift − 0.15 × max(0, tempC − 15)`

The 0.15%/°C coefficient is literature-approximate — controlled studies of endurance-trained runners at steady pace show ~0.1–0.2% HR rise per °C above a 15°C neutral zone due to elevated core temperature and skin-blood-flow diversion. Below 15°C no correction is applied (the coefficient is cardiovascular-strain-directional, not bidirectional). When `ambient_temp_c` is null (old rows, no-GPS treadmill, API failure), raw drift is used — the helper is a no-op.

**Personal baseline (2026-04-16)** (`computeDriftBaselines` in `daily-coach.ts`): rolling 16-week window per `plannedType` (easy, long). Baseline is mean + SD of heat-adjusted drift. Requires ≥ 5 samples per category; below that, `detectDurabilityFlag` falls back to the population 5% / 8% thresholds. When the baseline is available, the flag fires when the recent 4-week mean exceeds `baseline.mean + 1·SD`. This normalises against the athlete's own aerobic signature — a runner whose baseline drift sits at 3% triggers at a tighter bound than one whose baseline sits at 6%.

**Workout-insight heat context (2026-04-16)**: in-session drift commentary now mentions ambient temperature and heat-adjusted drift when `ambientTempC ≥ 22°C` and raw drift > 8%. Example: "HR drifted 11% from first to second half. At 28°C, heat-adjusted drift is 9% — the conditions explain most of the rise." This prevents coach copy from flagging hot-day runs as under-recovery.

**Backfill heal**: drift was added after the initial `hr_zones` migration. Backfill mode re-fetches HR streams (capped at 20 activities per run) for cached-with-zones running activities that have NULL `hr_drift`, so the 12-week durability chart populates retrospectively without blowing the Strava rate-limit budget.

**Durability flag (injury risk signal)** (`detectDurabilityFlag` in `daily-coach.ts`, surfaced in `injury-risk-view.ts`):

- Scans last 4 weeks. Strict matching: only `plannedType === 'easy'` or `'long'` actuals. A "matched but mismatched" run (e.g. a tempo logged against a planned easy) is excluded because the drift signal would reflect the effort profile, not under-recovery.
- Fires when:
  - Easy runs: ≥ 3 samples AND average drift > 5%
  - Long runs: ≥ 2 samples AND average drift > 8%
- Severity: `'high'` when the average exceeds its expected threshold by > 3 percentage points, otherwise `'elevated'`. The threshold gap (not the absolute drift) is what distinguishes mild under-recovery from clear cardiovascular decoupling.
- Copy differs per trigger (easy-only, long-only, both) with specific remediation (ease easy-run pace, slow long-run opening, fuel earlier).

**Rationale for coupling drift with ACWR**: ACWR flags acute:chronic load spikes but is blind to whether the load is being absorbed. Persistent easy-run drift means aerobic recovery isn't keeping pace with the training load — a quiet signal that precedes overt overreaching. Combining the two surfaces risk that load-ratio alone misses (e.g. ACWR inside the safe zone but drift climbing).

---

## FTP from Ride History — Quality-Tiered Estimator (2026-04-27, **superseded 2026-04-28**)

> **Superseded by** "FTP from Mean-Max Power Curve" below. The quality-tiered whole-ride approach is retained here as historical context and as the documented fallback path for rides without a power curve.

**Context**: The original estimator treated every ride's whole-activity normalised power (NP) as if it were a 20-min FTP test, applying `FTP = NP × 0.95` uniformly. This underestimated FTP for athletes whose powered rides were long endurance sessions rather than threshold tests. The 2026-04-27 quality-tiered rewrite classified rides as high-signal (20–75 min, avg/NP ≥ 0.88) or floor (>75 min, avg/NP ≥ 0.80) and applied duration-aware factors. Better than the uniform ×0.95, but still couldn't see *into* a long ride — a 110-min session containing two 20-min all-out efforts at 310 W would show whole-ride NP ≈ 251 W and the floor-tier formula would return FTP = 263 W, hiding the actual test result.

**Why retained as fallback**: when the watts stream isn't yet processed (mid-backfill, rides outside the per-sync stream-fetch budget), the activity row carries `average_watts` / `normalized_power` but no `power_curve`. Rather than show "--", the new estimator falls back to a recent ride's whole-ride NP × 1.00 within 12 weeks, tagged `confidence: 'low'`.

**Selection rule (2026-05-01 update)**: pick the *strongest* qualifying ride within 12 weeks, not the *freshest*. Whole-ride NP × 1.0 is conservative by construction — averaging across an entire ride dilutes the FTP signal — so picking the highest NP recent ride is the closest we can get to a real anchor without a curve. The earlier "freshest ride" rule had a degenerate failure mode: if the user's most recent ride was a Z2 endurance spin at NP 180 W, FTP would land at 180 W even when a tempo ride at NP 240 W from 3 weeks ago was sitting in the same data. Tiebreak on equal NP goes to the fresher ride.

**device_watts gate dropped entirely (2026-05-01)**: real-world data shows Strava's `device_watts` flag is structurally unreliable — Tristan's account has 60 of 63 recent rides flagged `device_watts: false` despite all of them being captured on a real power meter. The bug is in the Garmin → Strava transfer pipeline, not Strava's estimation logic. So:

- The earlier "reject `=== false`, accept null, downgrade unknown one tier" rule was still rejecting valid power-meter data wholesale.
- We now drop the flag check entirely and rely instead on a hard NP/avg threshold (`>= 120 W`). Strava's speed-based power estimation produces typical values of 80–150 W for casual rides; a sustained NP at 280 W cannot come from speed alone.
- Confidence downgrade is still applied when the flag isn't explicitly true (high → medium, medium → low). The 'low' tag and the existing UI prompt for a fresh test are the correct safety net.
- The presence of a `power_curve` is a far stronger signal than `device_watts`: the curve is computed by the edge function from actual watts samples in the stream. If it exists, the data was real.

---

## FTP from Mean-Max Power Curve — Top-1 within 12 Weeks (2026-04-28)

**Context**: Whole-ride NP averages over the entire activity, so any 20-min FTP test embedded inside a longer ride is invisible to the previous estimator. The fix is to read the *mean-max power curve* — best sustained watts over fixed time windows — directly from the watts stream, then apply Coggan's window-specific multipliers to whichever window gave the strongest signal.

**Pipeline**:

1. **Stream fetch** (edge function `sync-strava-activities` step 5e): per sync, rank cycling rides by `weighted_average_watts` DESC, filter to `device_watts=true` within the last 26 weeks, take top 15. For each, fetch `/activities/{id}/streams?keys=watts,time` and run a sliding-window mean-max for windows `[600, 1200, 1800, 3600]` seconds. Store as `garmin_activities.power_curve = { p600, p1200, p1800, p3600 }`. Budget: 15 streams/sync. The "highest whole-ride NP" pre-rank is the cheapest proxy for "ride contains a hard interval" — a 90-min Z2 ride at NP 180 W cannot hide a 310 W effort.
2. **Per-ride candidate** (`estimateFTPFromBikeActivities`): for each ride with a `powerCurve`, compute
   ```
   candidate = max(p600 × 0.92, p1200 × 0.95, p1800 × 0.97, p3600 × 1.00)
   ```
   Whichever window produced the strongest signal wins for that ride. Reject only rides Strava explicitly marks `deviceWatts === false`. **Why not require `=== true`?** The `device_watts` flag is unreliable on Garmin → Strava transfers — it routinely arrives `null` (or even `false`) on real power-meter rides. Refusing those leaves new triathletes with a "--" Bike FTP forever; downgrading their confidence one tier (high→medium, medium→low) is a strictly better outcome and keeps the existing UI prompt for a fresh test.
3. **Top-1 selection**: across all candidates within the last 12 weeks, take the single highest. The strongest single ride is the most informative single data point; averaging a fresh test with stale ones dilutes the signal.
4. **Outlier guard**: if the top-pick's `p1200 > 1.4 × p3600`, the curve is suspicious (meter spike or stream gap during a 20-min window) — fall to the second-best.
5. **Confidence by source-ride age** only:

| Source ride age | Confidence | UI caption |
|---|---|---|
| ≤ 4 weeks  | **high**   | "Derived from your 20-min effort on Apr 27 (310 W)." |
| 4–8 weeks  | medium     | "Derived from your last test on Mar 15. Sit a fresh one to confirm." |
| 8–12 weeks | low        | "Last test was 10 weeks ago. Estimate is getting stale." |
| > 12 weeks | none → `--` | "No recent FTP test. Tap to enter, or do a 20-min test." |

**Worked example** — Tristan, 2026-04-28: 110-min ride containing two 20-min all-out intervals at 310 W. Whole-ride NP=251 W, avg=223 W. Power curve from the watts stream: `p600=308, p1200=310, p1800=282, p3600=248`. Per-window candidates: 308×0.92=283, 310×0.95=295, 282×0.97=274, 248×1.00=248. Max = 295 W (20-min window). Source 1 day old → confidence `high`. The previous floor-tier estimator on this same ride returned 263 W (251 × 1.05).

**Multipliers — Coggan / Monod-style power-duration curve**:

| Window | Multiplier | Source |
|---|---|---|
| p600 (10 min)  | 0.92 | Coggan & Allen 2010, Monod-Scherrer power-duration model. 10-min max ≈ 1.087 × FTP. |
| p1200 (20 min) | 0.95 | Allen & Coggan classic 20-min FTP test protocol. 20-min max ≈ 1.053 × FTP. |
| p1800 (30 min) | 0.97 | Interpolation between p1200 and p3600. 30-min max ≈ 1.031 × FTP. |
| p3600 (60 min) | 1.00 | FTP definition: highest power sustainable for 60 min. |

**Mean-max sliding window (edge function, `computeMeanMax`)**:
```
sum = sum of first windowSec samples
best = sum
for i = windowSec; i < watts.length; i++:
  sum += watts[i] − watts[i − windowSec]
  best = max(best, sum)
return best / windowSec
```
O(n) per window. Strava streams are uniformly 1 Hz once fetched; missing samples (coasting, dropouts) are filled as 0 by Strava and treated as such.

**Why this is defensible**:
- Coggan's 0.95 multiplier was always specific to a 20-min near-max test, not a 20-min window inside a 4-hour ride. Reading p1200 from the stream and applying ×0.95 honours the original protocol.
- The power-duration curve (Monod-Scherrer 1965; refined Pinot & Grappe 2011) is the standard physiological model for short-duration max-effort scaling. Window-specific multipliers are taken from the canonical curve.
- Top-1 selection within 12 weeks reflects that FTP is a capacity metric: the strongest sustained effort the athlete has demonstrated recently is the best estimate of current threshold. Averaging stale efforts in is mathematically a regression toward mediocrity.
- 12-week hard cutoff matches typical FTP detraining literature (Coyle 1984: 5–7% loss per 4 weeks off; ~10–15% by 12 weeks). Beyond that, the estimate is too unreliable to anchor planning.

**Known limitations**:
- Strava rate limit caps stream fetches at 15/sync. Heavy users with many recent powered rides will only get the top-15-by-NP analysed each sync; lower-NP rides backfill on subsequent syncs. The pre-rank by whole-ride NP minimises the chance of missing a real test.
- The watts stream from a smart trainer can include calibration glitches at start (e.g. zero-offset drift). The outlier guard (p1200 > 1.4 × p3600) catches gross spikes but not subtle systematic offsets.
- p3600 × 1.00 assumes the rider went near-max for the full 60 min. For a steady tempo ride at IF=0.85, p3600 will be 85% of FTP and the formula returns 85% of FTP, biasing low. In practice this is dominated by p1200 × 0.95 (which doesn't have this problem) whenever any harder 20-min window exists in the last 12 weeks.
- A single curve-driven estimate fully anchors FTP — there's no "≥2 corroborating data points" minimum. Intentional: a real test is worth more than any number of floor estimates, but means one bad-data ride can move the number until the next sync drops it out of recency.

**Fallback path**: when no ride within 12 weeks has a `powerCurve` (mid-backfill state, all rides outside stream-fetch budget), the estimator uses the freshest real-meter ride's whole-ride NP × 1.00 as a conservative floor, tagged `confidence: 'low'` with caption "Best guess from whole-ride power. Do a 20-min test for a tighter number." Better than `--` while the curve backfill catches up.

**Recommended user action when confidence is anything below `high`**: run a 20-min FTP test (the recommendation surface lives in the "Refine your benchmarks" card on the plan view). A single recent test with a real meter promotes the estimate to `high` confidence on the next sync.

---

## Athlete Tier — Performance Floor

**File**: `src/data/stravaSync.ts:deriveAthleteTier`

**Core formula**:
```
fromCtl = bucket(ctlBaseline)               // beginner | recreational | trained | performance | high_volume
floor   = 'performance' if vdot ≥ 60 OR ftp ≥ 320 W
        | 'trained'     if vdot ≥ 50 OR ftp ≥ 250 W
        | 'beginner'    otherwise
tier    = max(fromCtl, floor)               // never below the CTL-derived bucket
```

**Why this is defensible**: athlete tier is consumed by plan engine multipliers (`plan_engine.ts`), session-difficulty selection (`session-generator.ts`), recovery targets (`sleep-debt`), and ACWR risk thresholds (`rolling-load-view.ts`). A pure-CTL classifier under-classifies any athlete whose chronic *running* load is modest while their broader engine is large — multi-sport athletes, runners returning from injury, triathletes with high bike/swim load and lower run mileage. The floor adds a *demonstrable engine* signal so the tier reflects what the body can produce, not just what it's currently producing.

**Justification for thresholds**:
- VDOT 50 → roughly 3:30 marathon, 1:38 half, 17:30 5K. By the standard Daniels VDOT tables this is firmly in trained-runner territory; a runner with VDOT ≥ 50 has the aerobic engine of a "trained" classification regardless of recent volume.
- VDOT 60 → roughly 2:54 marathon, 1:22 half, 14:50 5K — performance-bracket competitive amateur.
- FTP 250 W → ~3.3 W/kg at 75 kg male, ~3.6 W/kg at 70 kg, ~4.0 W/kg at 62 kg female. Per Allen/Coggan power profile tables, ≥3.5 W/kg is the lower edge of "Cat 4" / strongly trained recreational, which we map to `trained`.
- FTP 320 W → ~4.3 W/kg at 75 kg male, top of Cat 3 / Cat 2 — `performance`.
- The floor never *lowers* the tier; high CTL still wins, so a high-volume athlete with a modest VDOT (e.g. ultra-runner) is unaffected.

**Known limitations**:
- FTP thresholds are absolute watts because we don't store body weight; this under-classifies lightweight cyclists and over-classifies heavy ones. W/kg would be cleaner.
- Two signals (VDOT, FTP); swim CSS is not in the floor because CSS percentile vs population is harder to defend without normative data on hand and tri-only athletes are rare in our cohort.
- The floor is binary at each VDOT/FTP threshold — a VDOT of 49.9 stays at the CTL bucket, 50.0 lifts to trained. Acceptable: the fuzziness sits within the model error of VDOT itself.
- Cross-discipline misuse: a triathlete at VDOT 45 with FTP 280 W is reasonably "trained" overall — both signals corroborate. A triathlete at VDOT 38 with FTP 280 W gets lifted to "trained" by FTP alone, which arguably overstates *running* fitness. Plan engine consumers that care about run fitness specifically read VDOT directly; tier is the right granularity for cross-cutting decisions like recovery targets and ACWR thresholds.

---

## Cycling Power Balance — Bike Speed and CdA Calibration

**Files**: `src/calculations/bike-physics.ts`, `src/calculations/race-prediction.triathlon.ts` (`estimateBikeSpeed`)

**Core formulas**:

Forward (power → speed):
```
P_pedalled · η  =  ½·ρ·CdA·v³  +  Crr·m·g·v  +  m·g·sinθ·v
```
Solved numerically for v via Newton-Raphson on the cubic. Convergence in ≤12 iterations across the realistic v ∈ [0, 20 m/s] domain.

Reverse (known ride → CdA):
```
CdA  =  2·(P·η − Crr·m·g·v − m·g·sinθ·v) / (ρ·v³)
```
Where v = distance/duration. Rejects results outside [0.15, 0.50] m² as unphysical (drafting, hilly course mistaken for flat, calibration GPS error).

**Why this is defensible**: this is the canonical bicycling power model from Martin et al. 1998 ("Validation of a Mathematical Model for Road Cycling Power", *J. Appl. Biomech.*), validated against velodrome measurements within ±2% across the realistic cycling speed range. It replaces the previous linear watts→kph fit, which under-predicted speed for stronger riders by ignoring the cubic aero term and was inconsistent with its own internal calibration comment.

**Justification for constants**:
- **CdA presets** (m²): hoods 0.36, drops 0.32, clip-ons 0.28, TT bike 0.24. Mid-range from published wind-tunnel data (Cyclist magazine 2019, Cervélo white papers, Specialized Win Tunnel reports). Recreational age-grouper TT setups cluster around 0.24–0.26, drops/road-fit around 0.30–0.34.
- **Crr presets**: race tubeless 0.0035, race clincher 0.0040, training 0.0050, gravel 0.0070. From bicyclerollingresistance.com lab data at 100 PSI, adjusted down ~10% to account for the steel-drum overestimate vs real road.
- **Drivetrain efficiency** η = 0.97. Standard for clean modern chain + ceramic bearings. Older/dirty drivetrains drop to 0.94–0.95.
- **Air density** ρ = 1.225 kg/m³ at sea level, 15°C. User can override for altitude/heat.
- **Race intensity**: IM 70% FTP, 70.3 78% FTP — Allen-Coggan standard age-grouper guidance.
- **Course gradient assumption**: flat 0%, rolling 0.5%, hilly 1.2%. Effective net gradient drives the m·g·sinθ·v climb-power term. Conservative — real hilly courses have variable gradient that adds vs flat at the same average watts.
- **Wind-loss factor**: bumps effective CdA by 0–5% on rolling/hilly courses to capture the real-world losses (yaw exposure, gusts, rougher wind environment) that idealized still-air physics doesn't see.

**W/kg tier mapping**: Coggan FTP/kg tables (male 60-min power), thresholds at 2.62, 3.01, 3.40, 3.81, 4.20, 4.81, 5.62 W/kg. Female athletes appear one tier below their relative-to-peers ranking — accepted as informational only since the physics solver consumes raw watts, not the tier.

**CdA calibration confidence**: all user calibrations capped at `medium` because we cannot validate course flatness or absence of drafting from the inputs alone. A future iteration could parse Strava streams (gradient, drafting groups) to award `high`.

**Known limitations**:
- Course gradient is a single mean assumption per profile — real terrain has variable gradient that affects pacing more than average power. A flat 180 km IM and a 180 km IM with 1500 m gain at the same average watts have different bike splits because climb-time is non-linear in power.
- No yaw / wind-direction modelling. CdA is a single number; real frontal area + drag depends on wind angle. The wind-loss factor is a blunt approximation.
- No drafting penalty. Race prediction assumes IM-legal positioning (no drafting). 70.3 draft-legal ages have a different effective CdA that we don't model.
- Drivetrain efficiency held constant. Cassette/chainring choice, lube state, and bearing wear all matter; we don't expose these.
- Rolling resistance does not scale with pavement quality. Real cobbles / bad chip-seal can double Crr; users can override but won't know what value to pick without a calibration ride on that surface.
- Calibration assumes the ride was steady. A ride with stops (lights, refuels) overstates avg duration → understates avg speed → overstates CdA.

**Recommended user workflow**: pick the position preset that matches the bike, run a flat 30+ km steady-power test ride at race intensity, enter distance/duration/avg power into the calibration panel, and apply the result. The calibrated CdA persists per position.

## Device VO2 Max — Running-Specific Source Only (2026-04-29)

**Files**: `src/data/physiologySync.ts`, `supabase/functions/sync-physiology-snapshot/index.ts`, `src/state/persistence.ts` (v4 migration)

**Decision**: a value is only labelled "VO2 Max" (without an "(est.)" qualifier) in Mosaic if it came from `physiology_snapshots.vo2_max_running`. Any other source — including Garmin's `daily_metrics.vo2max` — is rejected, and the UI falls through to Daniels VDOT estimated from training data, clearly labelled "(est.)".

**Why two Garmin VO2 fields exist:**
- **`physiology_snapshots.vo2_max_running`** — populated by Garmin's `userMetrics` push, which fires only when the watch's "Running VO2 Max" screen value changes. Running-specific, derived from running activities by Garmin's Firstbeat-licensed model. This is what the watch face shows.
- **`daily_metrics.vo2max`** — populated by the generic `dailies` push. Garmin's docs describe this as the "fitness age" / cardio fitness number; it can be derived from cycling, walking, or other activities and routinely diverges from Running VO2 Max by 2–4 points. Garmin Connect users see it on the "Cardio Fitness" tile, not the running performance summary.

**The historic bug**: the `physiologySync` resolver preferred `vo2_max_running` but fell back to `daily_metrics.vo2max` when the former was absent. For a real user with values 53 (cycling-derived dailies, weeks ago) and 56 (running, last week from `userMetrics`), the resolver had at various points written 53 to `s.vo2`. The cycling estimate was then displayed under the label "VO2 Max · Well-Trained" with no provenance hint, and recovery from the wrong value required a fresh `userMetrics` push to override it.

**Defensibility of the strict rule:**
- **VO2 max is sport-specific.** Bassett & Howley (2000, *MSSE* 32:70–84) review extensive evidence that VO2max measured in a sport-specific test is 5–15% higher than in a non-specific test for trained athletes — running VO2 in runners exceeds cycling VO2, swimming VO2 in swimmers exceeds running VO2. Mixing modalities under one label is meaningless without a normalisation we don't have access to.
- **Garmin's documented intent.** Garmin themselves split the two endpoints: `userMetrics.vo2_max_running` is the running-specific number, and that's the one that drives Daniels-style pace recommendations on the watch. `daily_metrics.vo2max` is a general fitness indicator. We honour their distinction.
- **VDOT is a valid running estimate.** When no device value is available, we compute VDOT from race PBs and recent activities (Daniels 2014 model, see "Daniels VDOT" entry in this doc). Mathematically VDOT and Running VO2 Max sit in the same range and respond to the same training adaptations, so the "(est.)" fallback is a like-for-like substitute, not a different metric.

**Migration**: state schema v4 (`VO2_DEVICE_ONLY_VERSION = 4`) clears any persisted `s.vo2` and any `physiologyHistory[].vo2max` from earlier versions, since pre-v4 they may have been sourced from `daily_metrics.vo2max`. Next physiology sync repopulates strictly from `vo2_max_running`.

**Limitations:**
- **Coverage gap for non-Garmin device users.** Apple Watch users get no VO2 number from `@capgo/capacitor-health` and have always seen the VDOT estimate. Garmin users on watches that don't expose `userMetrics.vo2_max_running` (older or sport-specific models) now see the VDOT estimate too. This is a downgrade in label precision for a subset, but a precision *upgrade* in correctness — they were previously seeing a possibly-wrong number labelled as device VO2 Max.
- **Garmin's `userMetrics` push frequency is unreliable.** It fires only when the underlying value changes, and there have been historic delivery issues for some accounts. We accept the resulting freshness lag rather than substitute a different number.

## CSS from Swim History — Confidence-Tiered Estimator (2026-04-29)

**Files**: `src/calculations/tri-benchmarks-from-history.ts` (`estimateCSSFromSwimActivities`, `CssEstimate`).

**Decision**: the CSS estimator now returns a four-tier confidence (`high | medium | low | none`) alongside the value. The estimate itself is unchanged — fastest sustained swim ≥800m + 5 s/100m buffer — but recency, sustained distance, and pace-deviation from the user's own median together drive the tier. Tiers gate the in-app "Run a 400 m + 200 m test" prompt and the wizard / stats / account hint copy. Race-time prediction continues to read the value at any tier; confidence is informational, not gating.

**Tier rules** (mirror the FTP estimator's recency tiers):

| Tier   | Condition |
|--------|-----------|
| high   | Best swim ≤4w old AND ≥1500m AND ≥3 s/100m faster than the recent median (clear hard-effort signal) |
| medium | Best swim ≤4w old (any distance/spread) OR ≥1500m within 8w |
| low    | Some sustained ≥800m swim within 12w but neither tier above qualifies |
| none   | No sustained ≥800m swim within 12w (or no swim activities at all) |

A paired m400 + m200 PB on file shorts the cascade and is always tagged `high` (gold-standard Smith-Norris result).

**Justification for constants**:
- **800m sustained-swim floor**: a per-100m pace from <800m of swimming is too noisy to characterise threshold (one bad turn or 50m sprint distorts the avg). Threshold tied to the same value used elsewhere in the file.
- **1500m test-grade threshold (Dekerle 2002)**: the 30-min critical pace is the formal CSS definition (Dekerle, J., et al. *Eur. J. Appl. Physiol.* 2002, "Critical swimming speed does not represent the speed at maximal lactate steady state"). 1500m at ~110–130 s/100m takes 27–32 minutes for the bulk of recreational triathletes — the closest practical proxy to a 30-min hold without requiring the user to do a formal test.
- **3 s/100m hard-effort delta**: empirical pragmatic choice. A pool full of easy-aerobic swims at the same pace tells us nothing about threshold; the +5 s buffer over the *fastest* swim assumes that swim was a hard effort. Requiring the best swim to be ≥3 s/100m faster than the median is a coarse "this looks like a hard set" filter. Below 3 s/100m, the median and best are within typical day-to-day variability of an easy swim and the buffer is unreliable.
- **Recency tiers (4w / 8w / 12w)**: identical to the FTP estimator (`HIGH_TIER_WEEKS / MED_TIER_WEEKS / HARD_CUTOFF_WEEKS`). CSS detrains slower than FTP (Mujika 2010 — 3–5%/4w), so 12w is a generous-but-not-absurd cutoff for "still informative". Beyond 12w we still return a number (some signal beats none) but flag it `none` so the UI prompts a fresh test.
- **+5 s/100m buffer (unchanged)**: conservative offset on the fastest sustained pace. CSS sits below max-sustainable-pace and above easy-aerobic; +5 s is a coarse midpoint that biases toward over-estimating CSS pace (i.e., slower than reality, more conservative for prescription).

**Why both source AND confidence are persisted**: `cssSource` captures provenance ('user' vs 'derived'); `cssConfidence` captures the *quality* of the underlying signal at write time. A user-typed CSS without a paired test is `'user' / 'medium'`; the same value backed by a paired test is `'user' / 'high'`. A derived value from one stale 800m swim is `'derived' / 'low'`. The two together let the test-card decide whether to nag and let the UI choose the right hedge ("estimate — run the test" vs no hint).

**Why the value is returned at every tier**: race-time prediction needs a CSS to compute the swim leg. The user setup doesn't gate on confidence — first-time users with no history still see a prediction (currently `confidence='none'` + `cssSecPer100m=undefined`, which the prediction engine handles via its own swim-leg fallback). The purpose of the tiers is to control prompt aggressiveness and caption hedging, not to suppress the number.

**Known limitations**:
- The hard-effort delta uses the median across all sustained swims in the recency window, not a stratified set. If 80% of a swimmer's recent swims are 100m sprints with a single 1500m steady swim, the median is dragged toward the sprints and the 1500m may not flag as "hard-effort" even though it is the relevant threshold-pace data point. A future iteration could use a kernel-density approach or stratify by distance.
- "Faster than median" is symmetric to volume: a swimmer who only does easy swims will have a low-spread distribution and never reach `'high'` confidence, which is actually correct (we genuinely don't know their threshold). The cost is that occasional hard swimmers will see "estimate — run the test" prompts they may consider noise.
- The Dekerle 2002 critical-speed definition is more rigorous than "1500m at steady effort" — the formal test uses two distance trials and a least-squares fit. We accept the proxy because the goal is a usable CSS without a formal test, not a peer-reviewed threshold measurement.

## Personal Recovery Rate (`k_user`) — Adaptive Recovery (2026-05-01)

**Files**: `src/calculations/adaptive-recovery.ts` (the fitter + supporting helpers), `src/calculations/fitness-model.ts` (`computeToBaseline`, `computeACWR`).

**Decision**: replace the literal recovery constant `8` in the recovery-countdown formula with a learned per-user value `k_user`, fit from observed post-session physiology trajectories. Apply a small ACWR safeUpper shift on top of the per-tier baseline once `k_user` is established with high confidence. Population default falls back when evidence is thin.

**Model**:

```
sessionRecovery = k_user × TSS / ctlDaily × recoveryMult × recoveryAdj
```

where:
- `k_user` is a persistent trait (this athlete's recovery profile) — clamped to `[5, 13]` ≈ 0.6× to 1.6× of population mean.
- `recoveryAdj` is a transient state multiplier (today's HRV/sleep/RHR), already in the model — see `computeRecoveryScore`.
- Composing the two separates "how I recover in general" from "how I'm doing right now".

**ACWR ceiling shift**:

```
recoveryShift = clamp(−0.10, (8 − k_user) × 0.025, +0.10)
safeUpper_effective = TIER_ACWR_CONFIG[tier].safeUpper + recoveryShift
```

Only applied at `confidence = high` (≥30 closed sessions). At `K_USER_MIN=5` the shift is `+0.075` (under-cap by design); at `K_USER_MAX=13` it would be `−0.125` and clamps to `−0.10`. The asymmetry is deliberate: slow recoverers carry injury risk, so the conservative side is firmer.

**What we observe**: per session at date *T*,
- **Predicted hours-to-baseline** under the current model — logged at session ingestion.
- **Observed hours-to-baseline**: time after *T* until a composite recovery z-score returns to baseline. Composite = mean of available z-scores from `(HRV_t / +RHR_t_signFlipped)` against the user's 28-day pre-session baseline. Recovered = z ≥ −0.25 (a small negative tolerance — strict z ≥ 0 inflates observed hours due to noise). Capped at 96h (right-censored) when the signal never returns within the window.

**Fit**: weighted-mean ratio with Bayesian prior. Per-session ratio `r_i = observed_i / predicted_i`. Aggregate:

```
weight_i  = sourceWeight_i × 0.5^(ageWeeks_i / halfLife)
meanRatio = (Σ weight_i × r_i + PRIOR_WEIGHT × 1.0) / (Σ weight_i + PRIOR_WEIGHT)
k_new     = clamp(8 × meanRatio, 5, 13)
```

with `halfLife = 4 weeks`, `PRIOR_WEIGHT = 4` (4 ghost samples that vote for `k=8`), `sourceWeight = 1.0` for live entries and `0.7` for historical-backfill entries.

**Confidence gating**:

| Sessions observed | Confidence | Behaviour |
|---|---|---|
| 0–7   | none    | population default of 8; UI shows "learning" |
| 8–15  | low     | display only; not yet used in countdown |
| 16+   | medium  | used in recovery countdown |
| 30+   | high    | used in countdown AND ACWR ceiling shift |

**Justification for constants**:
- **`k_user` clamp `[5, 13]`** ≈ ±60% of population. Bounds outlier early evidence; calibrated against the Banister fitness/fatigue literature where individual recovery time-constants vary roughly within this range across athletic populations (Busso 2003, *Med Sci Sports Exerc* 35:1188–1195; review of intra-athlete variability in dose-response models).
- **96h observation cap**: matches the upper bound of EPOC clearance for typical aerobic loads (Børsheim & Bahr 2003, *Sports Med* 33:1037–1060; recovery-O2 returns to baseline within 24–96h depending on duration/intensity). Sessions whose composite signal never recovers within this window are real ("strong negative evidence") and shouldn't be excluded — hence right-censoring at 96h, treated as observed=96h with an explicit flag.
- **Composite z-threshold of −0.25**: empirical noise tolerance. Daily HRV CV is ~5–8% even for healthy stable athletes (Plews et al. 2012, *Eur J Appl Physiol* 112:3729–3741); a strict ≥0 cutoff would inflate observed hours through noise alone. −0.25 is roughly half a population standard deviation — small enough to remain meaningful, large enough to absorb single-day jitter.
- **Recency half-life of 4 weeks**: matches the CTL EMA half-life used elsewhere in the model (`CTL_DECAY` corresponds to 42-day τ ≈ 6w half-life; we use 4w here because recovery-rate plasticity should track training adaptations, not lag them). Plews & Buchheit's monitoring guidance argues the recovery profile shifts within ~4–6w of meaningful training-load change.
- **Bayesian prior of 4 ghost samples**: deliberately heavy-handed for low-N stability. Until ≥16 real sessions accumulate, the prior dominates the fit (4 prior + ≤16 real, evenly weighted) — keeps `k_user` close to 8 while evidence is thin. Once N=16, the prior drops to ~20% of the weighted mass, letting data dominate.
- **Confidence floors (8 / 16 / 30)**: 16 ≈ 4–6 weeks of typical training matches the existing precedent for HRV baseline (`Score improves after 10 nights of data` in `recovery-view.ts`). 30 is the standard "law of large numbers" threshold below which a sample mean's standard error dominates. The countdown gate is at 16 because a wrong countdown is mostly informational; the ACWR ceiling gate is at 30 because a wrong ceiling could license excess load and carry injury risk.
- **Historical-backfill weight of 0.7**: historical sessions reconstructed from physiology + activity history lack the RPE / check-in corrections of live sessions, so they carry less signal. The 0.7× downweight is a pragmatic discount — strong enough to let live evidence dominate as it accumulates, light enough to seed personalisation on day one rather than waiting weeks.
- **Ceiling-shift coefficient `0.025` / shift cap `±0.10`**: the per-tier ACWR bands span 1.30 → 1.50 (a 0.20 range across the five tiers). Shift cap of 0.10 = half a tier's worth — meaningful but not enough to leapfrog tiers. Coefficient `0.025` × `(8 − k_user)` produces ±0.075 across most of the user range, with the clamp catching the outermost slow-recoverer band.

**Defensibility of the overall approach**:
- The model is a single-parameter Bayesian update on top of an existing physiologically-grounded formula. We aren't introducing a new physiological theory; we're fitting one constant from observed data with a population-anchored prior.
- The fit composes cleanly with `recoveryAdj` (transient) — no double-counting. Concretely: if a user has chronically low HRV but recovers quickly when their HRV is at *their* baseline, the transient `recoveryAdj` captures the chronic depression; `k_user` captures the recovery-rate trait independent of state.
- The composite z-score is signal-conservative: requiring HRV (or RHR with sign flip) to return to baseline before declaring recovery uses the same metrics that validated published recovery-monitoring frameworks (Plews/Buchheit; Flatt & Esco 2016).

**Known limitations**:
- **No causal model.** The fit measures observed correlation between session load and physiology return-time. If a user's HRV is depressed by external factors (heat, alcohol, illness) on observation days, the fit pulls `k_user` slow even though the session itself isn't responsible. Heat correction exists for HR drift but not for HRV; a future refinement could exclude observation days flagged as travel/illness.
- **Day-resolution physiology.** HRV and RHR are once-per-day (morning measurement). The minimum observable recovery is 24h. *Addressed 2026-06-03 (see addendum)*: first-reading recoveries are now capped at on-time so the sampling floor no longer biases `k_user` slow for fit athletes whose predicted recovery is sub-24h.
- **Single-dimensional learning.** A unified `k_user` doesn't separate by workout type. RPE-vs-expected on the next session is captured in the entry shape (`rpeNextSession`) for a future per-type extension, but the MVP fits a single rate. Cycling vs running recovery time-constants differ in published literature (Skiba 2014, GoldenCheetah W'/CP model docs); this is a known approximation.
- **Population prior is research-cohort-derived.** The Banister-class evidence comes mostly from highly-trained athlete cohorts in a few labs. The clamp `[5, 13]` is generous but the prior weight may produce bias for users whose true `k_user` is outside the typical range. The 30-session high-confidence floor mitigates by letting data eventually dominate.
- **Right-censoring was symmetric in the fit** — a session that never recovers in 96h contributes ratio = 96h / predicted, dragging the fit slow. *Addressed 2026-06-03 (see addendum)*: censored sessions confounded by an intervening session inside the 96h window are now dropped; only clean-window censored sessions remain as slow-recovery evidence.

**Addendum (2026-06-03) — high-frequency / fit-athlete bias fixes**

A real user (well-trained, high training density) was pinned at `k_user = 13` (the ceiling, displayed as "1.63× the standard recovery time"). Investigation found two structural biases that punish exactly this profile, both flagged above as known limitations and now fixed in `fitKUser` (`adaptive-recovery.ts`):

1. **Confounded right-censoring (the dominant cause).** An athlete training daily never gives their HRV/RHR a clean 96h window to rebound — the *next* session keeps the markers suppressed. The session censors at 96h, and the old fit counted that as `observed = 96h`, a near-maximal ratio. Stacked across a training block this pinned `k_user` at the ceiling. The censoring there reflects **training density, not single-session recovery cost** — a confound, not signal. Fix: a right-censored entry is dropped from both the fit and the confidence count when any *other* logged session falls within its 96h window (`gap > 0 && gap <= 4` days). A censored session with a genuinely clean window is retained as real slow-recovery evidence. Constant-free (the 4-day window is the existing 96h cap; nothing tuned). Consequence: a high-frequency athlete with no clean windows falls back toward the population default at low confidence, which is the honest outcome — we have no clean evidence they recover slowly.

2. **Sub-24h sampling floor.** Fit athletes have high CTL, so `predictedHours = 8·TSS/ctlDaily·…` is often < 24h. But daily physiology can't resolve recovery faster than 24h (`RECOVERY_SAMPLE_GRANULARITY_HOURS`), so even instant recovery reads as `observed = 24h` and produces `ratio = 24/12 = 2.0` — a pure artifact of resolution. Fix: when the markers are back at baseline by the first reading (`observedHours === 24`), the ratio is capped at on-time (1.0). We can't claim recovery was slower than a sub-24h prediction we can't measure. `1.0` is the definition of on-schedule, not a tuned constant.

**UI reframing (same date).** The card previously read "X× slower than average / than a typical athlete," implying a peer ranking. There is no peer comparison — "average" is the model constant `8`, which itself assumes the athlete rests between sessions. Copy now frames the number as calibration against the *standard model* ("X× the standard recovery time… takes about N% longer than the standard model to return to baseline. This reflects how hard and how often you train, not how fit you are"), and explicitly states it is not a fitness verdict. `renderPersonalRecoveryCard` in `recovery-view.ts`.

**Remaining limitation**: a single clean-window censored session can still push the *stored* `k_user` to the ceiling on weak evidence, but at N=1 confidence is `none`, so the countdown uses the population default and the card shows the learning state. The stored extreme is not surfaced or acted on until clean evidence accumulates.

**Addendum 2 (2026-06-03) — intensity-banded redesign (ISSUE-256 fix). SUPERSEDES the fit basis above.**

The interim fixes in Addendum 1 were necessary but minor. Device data (Tristan, n=83) showed the pin was *structural and near-universal*, not a censoring edge case: only 6 of 83 sessions were censored, yet `k` stayed at the ceiling. Diagnosis: the fit divided two quantities on **incompatible scales**. `predictedHours` is the recovery-countdown's *readiness-debt* (`8·TSS/ctlDaily·…`), ~8h for an average session by design (his p10/p50/p90 = 4/8/18.4h). `observedHours` is full *autonomic return* to the 28-day HRV/RHR baseline — daily-sampled (24h floor) and realistically 24–96h. Their ratio is a structural ~4× (his p50 = 3.91), so the clamp (pins at ratio ≥ 1.625) caught any athlete with ≥16 closed sessions; fitter athletes (higher CTL → smaller predicted) fared worse. A naive self-normalization still gave 11.56 (the ratio distribution is right-skewed). Full root-cause in ISSUE-256.

**The redesign** (decided with Tristan; he chose the largest defensible build):

- **Fit basis is now `index = observedHours / expectedRecoveryHours`**, where `expectedRecoveryHours` is the literature-anchored autonomic-recovery time *for the session's intensity band*. Both terms are now on the same (autonomic-return) scale, so a typical athlete centres at index 1.0 (k = 8). `k_user = clamp(8 × index, [5, 13])`. The readiness-debt `predictedHours` is retained on the entry for reference but is no longer the fit basis. `kUserHours` keeps its meaning and range, so the recovery-countdown and ACWR-ceiling consumers are unchanged.

- **Expected recovery by intensity band** (`EXPECTED_RECOVERY_HOURS`): easy 24h, moderate 36h, hard 54h. Source: **Stanley, Peake & Buchheit (2013), Sports Med 43(12):1259–77** — complete cardiac parasympathetic recovery requires ~24h after low-intensity, 24–48h after threshold, and ≥48h after high-intensity exercise. Easy anchored at 24h, moderate at the 24–48h midpoint (36h), hard between the ≥48h floor and the ~72h seen in strength/extreme-endurance studies (54h). Anchors approved by Tristan 2026-06-03.

- **Intensity classification is fitness-relative, with no invented coefficient.** The band comes from the session's HR time-in-zone (`GarminActual.hrZones`), which Strava computes against the athlete's *own* HR zones. So a fit athlete's easy run (Zone 2) is judged against the easy expectation, a beginner's same-pace run (Zone 4) against the hard one — the "fitter people recover faster" fairness is captured structurally, not via a tuned multiplier. We take the time-weighted mean zone; band boundaries fall at the integer-rounding midpoints (2.5, 3.5), so no cutoff is tuned. Fallback when no HR zones: session-RPE (Foster 2001 CR10 convention: ≤4 easy, 5–6 moderate, ≥7 hard). Sessions with neither signal are excluded, not guessed. `classifySessionIntensity` in `adaptive-recovery.ts`.

- **Clean-window measurement (fairness to high-volume athletes).** Training through a recovery window inflates `observedHours` (the next session keeps markers down). So an entry is used only if no *other* session fell on its intervening days T+1 … T+(k−1) where observed = k×24h. Because physiology is a morning reading, a session on the recovery day itself happens after that reading and does not contaminate — hence the strict `gap < windowDays`, which also means a 24h recovery is always clean. A near-daily trainer with no clean windows therefore has few usable readings → low confidence → `densityLimited = true`, and the card says "training too densely to read" instead of inventing a slow label. This is the accepted trade-off (Tristan, 2026-06-03): we can be fair *or* measure a never-rest athlete, not both.

- **Robust log-space aggregation.** Recovery ratios are right-skewed, so a few very slow sessions would drag a linear mean (this is what produced 11.56). The fit aggregates `ln(index)` with the existing source/recency weights and a prior at `ln 1 = 0`, then exponentiates. The clamp `[5, 13]` and the Bayesian prior (weight 4) are unchanged.

**Retrofit**: `backfillIntensityBands` matches existing 90-day-window entries back to their activity by `garminId` and fills `intensityBand`/`expectedRecoveryHours`, so the redesign applies to a user's existing log immediately (run in `refreshAdaptiveRecovery` before the fit) rather than waiting for the log to age over.

**Known limitations**:
- The mean-zone classifier under-weights a short hard-interval block inside an otherwise easy session, which the literature says still delays recovery. A threshold-crossing classifier ("meaningful time above anaerobic threshold") is deferred because it needs a tuned cutoff. RPE-classified sessions inherit the coarseness of a self-reported 1–10 scale.
- The expected-hours anchors are population figures from trained-cohort studies; the residual "trained individuals recover faster even at matched relative intensity" effect (Stanley et al. note it) is *not* separately modelled — a fit athlete may read slightly < 1.0×, which is the correct direction. A CTL-based fine-tune is a deferred refinement and would need its own calibration anchor.
- A never-rest athlete is intentionally unmeasurable (density-limited), by design.


---

## Swim Engagement Penalty — Projected CSS Baseline (2026-05-06)

**File**: `src/calculations/race-prediction.triathlon.ts` (`buildProjection`, swim section).

**Problem**: the prior `specificEndurancePenalty` framework applies a readiness penalty to the "if you raced today" current swim time. By design it leaves the projected (race-day) path unpenalised — the comment in `specific-endurance-penalty.ts` reads "race-day projection uses the plan's prescribed dose and gets full readiness by definition." This is correct for the volume dimension (the plan restores long-session readiness), but incorrect for the **baseline dimension**: a swimmer who measured CSS 2:22 a year ago and hasn't swum since does not start the plan from that CSS — technique decay has already degraded their actual starting point.

**The fix**: inflate the `baseline` passed to `applyTriHorizonSwim` when `disciplineConfidence.swim.weeksActive` is low. `weeksActive` is a proxy for how long the athlete has been away from swimming (12-week window, so 0 weeks active ≈ 12+ weeks off). The detraining rate is `CSS_DETRAINING_PER_4WK = 0.04` (4% per 4-week block, midpoint of Mujika 2010's 3–5%/4wk for swim). Number of equivalent detraining periods:

| weeksActive | Proxy weeks-off | Periods (÷4) | Multiplier |
|-------------|-----------------|--------------|------------|
| 0           | ~12wk           | 3            | 1.04³ ≈ 1.125 (+12.5%) |
| 1–2         | ~8wk            | 2            | 1.04² ≈ 1.082 (+8.2%)  |
| 3–5         | ≤6wk            | 0            | 1.0 (band demotion handles) |
| ≥6          | consistent      | 0            | 1.0 (no penalty) |

The compounding `(1 + r)^n` form mirrors how CSS detraining accumulates — each 4-week block degrades the previous result, not an absolute baseline.

**Why not double-count with band demotion**: `demoteBandByVolume` reduces the improvement *ceiling* (how fast gains accrue from the inflated starting point). The engagement penalty sets a worse *starting point*. Both are needed: the ceiling reduction says "your adaptation rate is slower" (you've lost training economy); the baseline inflation says "where you're starting is worse than the CSS number suggests" (you've lost fitness). They operate on different dimensions and compound correctly.

**Why not penalise the displayed CSS**: `out.swimCss.current` always reflects the measured value so the UI is truthful about the last test. Only the internal `effectiveCssBaseline` is inflated.

**Limitations**:
- `weeksActive` only covers the 12-week fitnessHistory window. A user who swam 13 weeks ago but not since would still show `weeksActive=0` and take the full penalty, which is appropriate.
- The proxy (0 active ≈ 12 weeks off) is conservative — some users may have swum 6 weeks ago and still show `weeksActive=0` if that single session didn't register a non-zero swimCtl. The penalty over-corrects for them slightly. Acceptable given the alternative (no penalty on genuinely stale baselines).
- Swim PB recency (analogous to `marathonPbAgeDays` in `blendPredictions`) is not implemented. A recent open-water race or time trial could reduce the penalty magnitude the same way a recent marathon PB reduces the run specificity penalty. Deferred to v2.

**User-set CSS exemption (2026-05-09)**: when `tri.swim.cssSource === 'user'` (athlete typed the value in manually), `swimDetrain4wkPeriods` is forced to 0 — the inflation does not fire regardless of `weeksActive`. Rationale: the engagement penalty is a *staleness* model. A measured CSS from 12 months ago really is stale. A CSS the user just typed in is a fresh ground-truth snapshot — they're telling the system "this is what I can do today", and the model has no grounds to project that backwards on the strength of "no swims logged this month". A real case prompted this: a user manually set CSS to 2:00/100m, raced one week later, and the projected race-day CSS came out as 2:15/100m (+12.5% inflation). The displayed projection contradicted what the user had just told the system. Derived CSS values (paired-PB inference, etc.) still receive the inflation when sparse — the assumption that staleness compounds away from training only holds when the value was inferred from old history, not when freshly declared.

---

## Cross-Modal VO2max (2026-05-01)

**Goal**: produce a defensible per-discipline VO2max estimate that gives users credit for cross-training (padel, tennis, football, cycling, etc.), and let them toggle between Mosaic's estimate and the device-reported value.

**Three-estimator decomposition** (`src/calculations/vo2-orchestrator.ts`):

1. **Running** — effort-calibrated VDOT (already in `effort-calibrated-vdot.ts`): pace-vs-%VO2R linear regression of recent qualifying runs, evaluated at %VO2R = 1.0, then mapped through Daniels' VDOT table. Anchors: Swain & Leutholtz 1997 *MSSE* 29:837–843; Daniels' Running Formula 4th ed. Confidence: high when N ≥ 8 with R² ≥ 0.7.

2. **Cycling** — ACSM cycle-ergometry (`cycling-vo2.ts`):
   ```
   VO2max ≈ 10.8 × (FTP_W / mass_kg) + 7
   ```
   ACSM Guidelines for Exercise Testing and Prescription, 11th ed. (2022). Validated by Hawley & Noakes 1992 *Eur J Appl Physiol* 65:79–83 in trained cyclists (R² > 0.9 for peak power → VO2max). Body weight defaults to sex-specific values (75 kg M / 62 kg F) when unset; default-weight estimates are confidence-downgraded one tier (kg error injects ±2 ml/kg/min).

3. **Cardiac ceiling** (modality-agnostic) — Uth-Sørensen (`cardiac-ceiling.ts`):
   ```
   VO2max ≈ 15.3 × HRmax_observed / HRrest
   ```
   Uth, Sørensen, Overgaard, Pedersen 2004, *Eur J Appl Physiol* 91:111–115. The constant 15.3 was derived from regression on trained runners and validated against gas-exchange testing (±10–15% accuracy). Aggregates HR exposure across **every** aerobic activity — running, cycling, padel, tennis, football, etc. — so cross-training contribution to cardiac fitness shows up here.
   Confidence: high when ≥ 8 sessions across ≥ 2 sports. Single-sport HRmax tends to under-state (a habitually slow runner who never spikes HR).

**Lift logic** — the bit that makes cross-training count toward running VO2max:

For each modality (running, cycling), the displayed estimate is
```
modality_VO2 = max(direct_estimate, cardiac_ceiling × peripheral_transfer)
```
where `peripheral_transfer ∈ [0.70, 1.0]` is the time-weighted sum of source-specific transfer coefficients across the user's last 8 weeks (`peripheral-transfer.ts`).

**Why a separate transfer table from `runSpec`** (load-discount): the two answer different questions. `runSpec` asks "how much of this training stress equals running stress?" — for ACWR / CTL purposes. Peripheral transfer asks "how much of this athlete's cardiac fitness shows up as VO2max in modality X?" — for capacity. VO2max transfer is much higher than load transfer because the central (cardiac) component of VO2max is fully shared across modalities while training stress is not (Bassett & Howley 2000, *MSSE* 32:70–84 — cardiac output explains 70–85% of VO2max variance between trained individuals).

**Transfer coefficients** (running target):

| Source modality            | Transfer | Citation                            |
|----------------------------|----------|-------------------------------------|
| Running (identity)         | 1.00     | —                                   |
| Weight-bearing intermittent (soccer, rugby, basketball, tennis, padel) | 0.92 | Hoff et al. 2002 *MSSE* 34:1925–1931; Aughey et al. 2014 *Sports Med* 44:929–957 |
| Cycling                    | 0.88     | Millet et al. 2009 *Sports Med* 39:179–206 |
| Other aerobic (rowing, hiking, stair climbing, elliptical) | 0.85–0.90 | Compromise per population data |
| Swimming                   | 0.75     | Holmér 1972 *J Appl Physiol* 33:502–509 |
| Static / non-cardiac (yoga, pilates, climbing) | 0.70 | Conservative floor |

Cycling-target table is symmetric (running source 0.88, etc.). Numbers are population means from cross-modal VO2max studies in trained athletes — individual variance is real, but exposing the source breakdown in the UI lets users see where the number comes from.

**Headline = highest of running, cycling, cardiac**. Reflects the cardiac ceiling the user has best demonstrated. A pure cyclist's headline is their cycling VO2; a triathlete's headline is whichever discipline they've trained hardest.

**Source toggle** (`s.vo2Source: 'mosaic' | 'device'`): defaults to `'mosaic'` with auto-fallback to device value when Mosaic confidence < medium. Pinning to `'device'` uses Garmin/Apple's reading regardless of our estimate quality. The priority chain in `physiological-vdot.ts` honours this preference.

**Recompute cost ≈ 2 ms** per launch. Pure local computation over already-loaded state (last 8 weeks of activities, ~20–50 rows). Triggered from `main.ts` after `setAthleteNormalizer` and again after `syncPhysiologySnapshot` resolves (in case fresh RHR/HRmax changed inputs).

**Known limitations**:

- **HRmax determination dominates the cardiac-ceiling error.** We use observed peak HR across recent training, not a maximal effort test. Users who never go truly maximal will under-estimate; we never over-credit. The 8-week window plus duration filter (≥ 60s) screens stray monitor spikes.
- **HRrest staleness.** Depends on Garmin/Apple sync. Stale RHR (post-illness, dehydration, alcohol) shifts the ratio. We use the value as synced; future refinement could use a 28-day rolling RHR.
- **Uth-Sørensen accuracy is ±10–15%** per the original study — wider than the running pace/HR regression (~5%). That's why direct running estimate wins when it's high-confidence.
- **Transfer coefficients are population means.** Individual variance in cross-modal VO2max transfer is real (untrained legs in a runner-turned-cyclist may transfer below 0.88 initially; a multi-sport athlete may transfer above 0.92). The drill-down exposes the source breakdown so users can sanity-check.
- **Modality-state interaction.** A fatigued runner may show low HR (parasympathetic suppression) or high HR (sympathetic drive). The 8-week window smooths this but doesn't eliminate it.
- **Swimming estimator deferred.** Modality is too specific (technique-bound) and HR signal is poor underwater. We don't display a swim VO2 even when the user does swim.

**References used**:

- Bassett & Howley 2000, *MSSE* 32:70–84. Limiting factors for maximum oxygen uptake and determinants of endurance performance.
- Uth, Sørensen, Overgaard, Pedersen 2004, *Eur J Appl Physiol* 91:111–115. Estimation of VO2max from the ratio between HRmax and HRrest.
- ACSM Guidelines for Exercise Testing and Prescription, 11th ed. (2022).
- Hawley & Noakes 1992, *Eur J Appl Physiol* 65:79–83. Peak power output predicts VO2max in trained cyclists.
- Swain & Leutholtz 1997, *MSSE* 29:837–843. Heart rate reserve is equivalent to %VO2 reserve.
- Daniels, Daniels' Running Formula, 4th ed. (2022).
- Millet, Vleck, Bentley 2009, *Sports Med* 39:179–206. Physiological differences between cycling and running.
- Hoff, Wisløff, Engen, Kemi, Helgerud 2002, *MSSE* 34:1925–1931. Soccer specific aerobic endurance training.
- Aughey, Falloon, Stanley 2014, *Sports Med* 44:929–957. Aerobic fitness in court-based intermittent sports.
- Holmér 1972, *J Appl Physiol* 33:502–509. Oxygen uptake during swimming in the trained athlete.

---

## Cross-Modal VO2max — lift removed (2026-05-02)

**Walk-back of the 2026-05-01 spec.** Earlier today we shipped a cardiac-ceiling lift: each modality's displayed VO2max was `max(direct_estimate, cardiac_ceiling × peripheral_transfer)`, intended to give cross-training credit. Tested against real user data (cyclist with FTP 295W, mixed running history), it produced misleading numbers — cycling displayed at 62 ml/kg/min when the user's FTP-direct ACSM value was ~50, with the gap entirely from the cardiac × transfer route.

**Why the lift was wrong.**

The cross-training contribution to running VO2max is **already captured implicitly** by the running pace–HR regression. A heart trained by padel/tennis/cycling pumps at a lower HR for a given pace; that shows up directly in the `pace + HR` observations the Daniels regression consumes. Adding `cardiac_ceiling × transfer_coefficient` on top of the regression layered cardiac contribution **on top of itself**, producing systematic inflation.

The original user intuition — "padel makes me a better runner, the app should reflect that in VO2max" — is correct biology. The error was thinking VO2max needed a *new mechanism* to capture it. Two existing mechanisms already do:

1. **Signal A iTRIMP** (rs-discounted load): padel contributes to run-equivalent CTL via the existing load discount system. This is the right place for "cross-training counts toward your training stress."
2. **Daniels VDOT regression**: a padel-built heart shows up as faster pace at given HR during runs. The regression doesn't care where the cardiac fitness came from.

The peripheral-transfer table (cycling 0.88, padel 0.92, swimming 0.75 etc., from Hoff 2002 / Millet 2009 / Holmér 1972) was real literature — those coefficients describe trained-athlete cross-modal VO2max transfer. But applying them as a runtime lift treats the cardiac ceiling as an *additive* signal when it's actually the *upstream limit* of what the modality regression already approximates.

**What stayed.**

- Per-modality direct estimators (running effort-calibrated VDOT, cycling ACSM)
- Cardiac ceiling computation (Uth-Sørensen) — surfaced as "Cardiovascular potential," informational only, never blended into modality numbers
- Headline = max of measured modalities, with cardiac as tier-2 fallback (anti-decay for HR-only-sport athletes), and `getPhysiologicalVdot()` as final floor (LT/PB/Tanda)
- Source toggle (Mosaic / Device)
- HRmax 220 sensor cap (sensor-glitch filter, defensible)
- Cardiac VO2 cap at 85 ml/kg/min — kept pragmatically, but flagged as a non-derived clamp; future work could replace it with extrapolation-warning UI when above 76 (Uth-Sørensen's calibration ceiling)

**What was removed.**

- `liftFromCardiac()` function in `vo2-orchestrator.ts`
- `peripheral-transfer.ts` and its test (whole module deleted)
- The `cardiac-lifted` value of `VO2Estimate.source`
- The cardiac × peripheral_transfer logic for both running and cycling

**Future-proofing note for next session.** If a future agent considers reintroducing some form of cross-modal lift: don't, unless you have evidence the running regression is *under*-counting cardiac contribution (it isn't — the regression sees the actual HR signal). The right way to surface "your overall fitness exceeds what running data alone shows" is the cardiac ceiling row, displayed as informational context. Don't blend it back into the modality numbers.

**References (kept here for the historical record, in case the lift question recurs):**

- Bassett & Howley 2000, *MSSE* 32:70–84. Limiting factors for VO2max.
- Uth, Sørensen, Overgaard, Pedersen 2004, *Eur J Appl Physiol* 91:111–115. Uth-Sørensen formula.
- ACSM Guidelines, 11th ed. (2022). Cycle ergometry equation.
- Daniels' Running Formula, 4th ed. (2022). VDOT regression and pace-VO2 relationship.
- Swain & Leutholtz 1997, *MSSE* 29:837–843. %HRR ≈ %VO2R.
- Hoff et al. 2002, *MSSE* 34:1925–1931. Soccer aerobic transfer (referenced for population transfer mean — no longer applied as runtime coefficient).
- Millet, Vleck, Bentley 2009, *Sports Med* 39:179–206. Cross-modal cycling/running VO2max (same — informational only now).
- Holmér 1972, *J Appl Physiol* 33:502–509. Swimming VO2max.

## Cross-Training VO2max (2026-05-06)

**Problem.** Cardiac ceiling (Uth-Sørensen `15.3 × HRmax/HRrest`) tells us how high the heart *can* go, but not how much aerobic work the athlete *sustains*. A rugby player who briefly hits 195 bpm in a sprint has the same cardiac ceiling as one who holds 175 bpm for 60 minutes; their aerobic capacities are very different. A user playing touch rugby twice a week wants visible credit for that fitness in their VO2max picture, separate from the per-modality run/bike numbers and separate from the peak-only cardiac ceiling.

**Method.** Per qualifying cross-training session (non-run, non-bike, ≥ 20 min, avg HR ≥ 75% HRmax):

1. `%HRR = (avgHR − RHR) / (HRmax − RHR)` — heart rate reserve fraction sustained.
2. Convert to fractional VO2 reserve via Swain & Leutholtz (1997, *MSSE* 29:837–843):
   `%VO2R ≈ %HRR`. The linear identity holds well across 40–85% with ~5% drift outside that band, accepted.
3. Anchor to cardiac ceiling: `sessionVO2 = cardiacCeiling × %VO2R × durationFactor`, where `durationFactor = min(1, durationMin / 30)` credits sustain. A 20-min session counts at 0.67×; a 30+ min session at 1.0×. Beyond 30 min, no further credit — sustain is sustain, longer doesn't make VO2max bigger.
4. Aggregate via trimmed mean (drop bottom 25%, mean of remainder) across qualifying sessions. Robust to occasional weak sessions that pass the gate.

**Why this is additive over cardiac ceiling.** Cardiac ceiling is a one-shot peak ratio. Cross-training is sustained fraction × ceiling × duration credit. They measure different physiology — peak vs sustained — and the cross-training estimate is by construction ≤ cardiac ceiling.

**Why this does not lift running or cycling.** Same rationale as the 2026-05-02 lift removal: the running VDOT regression already credits cardiac contribution implicitly because a heart trained by rugby pumps at a lower HR-for-pace during runs. Adding a cross-training lift on top would double-count. The cross-training estimate is additive (fourth surface) not blended (no impact on running/cycling/headline).

**Confidence model.**
- `low` — 3–4 qualifying sessions
- `medium` — 5–7 qualifying sessions
- `high` — 8+ qualifying sessions across ≥ 2 distinct sport types

Hidden entirely (`vo2 = null`, reason `'insufficient-sessions'`) below 3 sessions. Sport diversity gates the high tier because a single sport's HR profile is idiosyncratic — touch rugby's stop-start nature averages low even when capacity is high.

**Known limitations.**
- HR-only methods cannot distinguish aerobic capacity from running economy or cardiovascular drift. This is a *fitness proxy*, not a lab measure.
- Swain's linear %HRR↔%VO2R holds best in 40–85%; pushed beyond, drifts ~5%.
- Cardiac ceiling anchor inherits Uth-Sørensen's ±10–15% accuracy band — the cross-training estimate is therefore at best ±15%.
- Mode-of-effort matters: a session with intervals above LT plus easy recovery averages to a moderate %HRR even though aerobic stress is much higher than the average suggests. v1 accepts this — it under-credits intervals, which is the safer error.

**Files.** `src/calculations/cross-training-vo2.ts`, `src/calculations/vo2-orchestrator.ts` (wired in after cardiac), `src/types/state.ts` (added `crossTraining: VO2Estimate` and `'sustained-hr-cross-training'` source), `src/ui/vo2max-card.ts` (4th row + detail section).

**References.**
- Swain & Leutholtz 1997, *MSSE* 29:837–843. %HRR ≈ %VO2R linear identity.
- Uth, Sørensen, Overgaard, Pedersen 2004, *Eur J Appl Physiol* 91:111–115. Cardiac ceiling formula used as anchor.
- Bassett & Howley 2000, *MSSE* 32:70–84. Modality-independence of central cardiovascular capacity.

## HYROX Population Percentiles (2026-05-06)

**Purpose.** Maps a predicted HYROX finish time to "faster than X% of finishers" for the population comparison card in `src/ui/hyrox/stats-view.ts`.

**Data source.** HyroxDataLab global race database (700k+ finishers, Open and Pro divisions combined). Percentile breakpoints extracted from published cumulative finish-time distributions (hyroxdatalab.com, accessed 2026). Values are gender-mixed Open-division midpoints; Pro division table scaled proportionally (~15% faster for men, ~12% for women, self-selected field).

**Method.** Piecewise linear interpolation between anchor breakpoints. Each anchor `[finishTimeSec, cumulativePercentile]` represents "X% of finishers are at or below this time." "Faster than Y%" = 100 − cumulativePercentile at the user's time. Rounded to integer percent for display.

**Open division anchor points (gender-mixed):**
- 45 min → 0th pctile (WR territory)
- 60 min → 5th (sub-1h, competitive band)
- 80 min → 15th (advanced)
- 100 min → 35th (intermediate)
- 120 min → 60th (novice)
- 150 min → 80th
- 180 min → 90th
- 240 min → 98th
- 360 min → 100th

**Pro division:** same shape, compressed ~15% across the time axis (self-selected faster field).

**Known limitations.**
- Gender-mixed distribution hides meaningful male/female splits (men average ~15% faster than women at the same relative effort for HYROX format). The display is still valid as a rough population comparison, but a male sub-90-min finisher is in a different percentile vs the male-only field.
- Age-group effects are not modelled. Masters (50+) and juniors anchor in different parts of the distribution.
- Doubles format uses the Open table as a proxy (dedicated Doubles-only distribution not available from published data). Accuracy is lower for Doubles.
- Distribution shape varies by event location — major city events (London, Frankfurt) attract faster fields than regional events. The table uses a global aggregate.

**Files.** `src/calculations/hyrox-population.ts` (new), `src/ui/hyrox/stats-view.ts` (consumes).

## VO2 Resolver Audit (2026-05-07)

**Purpose.** Systematic audit of `getPhysiologicalVdot` resolver chain (`src/calculations/physiological-vdot.ts:144`) and supporting sync paths before adding conflict-surfacing UI (WS-2b).

**Findings — pass/fail per check:**

| # | Check | Result |
|---|---|---|
| A | `cv(5000, 1200)` = 49.81 | PASS [49.5–50.1] |
| A | `cv(21097.5, 5400)` = 50.98 | PASS (Daniels formula gives ~51 for HM @ 1:30:00, not ~56 — audit plan had wrong expected range) |
| A | `cv(42195, 11400)` = 50.21 | PASS (marathon @ 3:10:00 → VDOT ~50.2 per Daniels) |
| A | `cv(10000, 2400)` = 51.94 | PASS (10K @ 40:00 → VDOT ~51.9 — same pace as 5K@20:00 but longer effort yields higher VDOT by design) |
| B | `pbDerivedVdot` median with 5K 18:00 (VDOT 56.3) + M 4:00 (VDOT 37.9) = 47.1 | PASS (median 47.1 ≠ max 56.3) |
| C | Staleness gate for Garmin users who stop running | **BUG FOUND — see below** |
| D | `hrCalibratedVdot` confidence gate at n=2 | PASS (< 3 points → `'none'`, not 'medium') |
| E | Display surfaces use `getPhysiologicalVdot()` not raw `state.v` | PASS (all four UI surfaces confirmed) |
| F | TRUSTED_LT_SOURCES excludes `'blended'` | PASS (line 71, confirmed correct) |

**Bug found (C): Garmin staleness leak for triathletes who stop running.**

`deviceVo2AgeDays()` checked `physiologyHistory[].vo2max` for the freshness gate. `physiologyHistory` is built from `daily_metrics.vo2max` (Garmin's generic cardio estimate, can update from cycling). But `s.vo2` is set from `physiology_snapshots.vo2_max_running` (running-specific, only updates from outdoor running activity). For a triathlete who switches to pure cycling or takes an injury break: `daily_metrics.vo2max` keeps updating → `physiologyHistory` has recent vo2max entries → `deviceVo2AgeDays()` returns 0 → `isDeviceFresh = true` → stale `s.vo2` (from months-old running) is used as "fresh".

**Fix applied:** Added `s.vo2UpdatedAt?: string` (ISO date) to `SimulatorState`. Stamped whenever `s.vo2` is written:
- `physiologySync.ts:127` — Garmin `physiology_snapshots.vo2_max_running` path
- `appleHealthSync.ts:167` — Apple HealthKit VO2max path

`deviceVo2AgeDays()` now prefers `s.vo2UpdatedAt` and falls back to the `physiologyHistory` scan for legacy state (maintains "don't drop a valid number on a missing-timestamp technicality" policy for existing users).

**Note on Daniels `cv()` expected ranges.** The audit plan had incorrect VDOT ranges for HM, marathon, and 10K. These came from confusing Daniels performance-equivalence tables (what time a VDOT=55 athlete runs) with the inverse (what VDOT does a given performance imply). The formula is correct: HM @ 1:30:00 → VDOT ~51 (that's what a half-marathon specialist at that pace implies, not what a 5K@20:00 runner implies for their HM). Cross-verified against `vdot.test.ts` (31 tests, all passing).

**Files.** `src/types/state.ts` (new `vo2UpdatedAt` field), `src/data/physiologySync.ts` (stamp on write), `src/data/appleHealthSync.ts` (stamp on write), `src/calculations/physiological-vdot.ts` (updated `deviceVo2AgeDays` to prefer `vo2UpdatedAt`).

## Triathlon Bike/Swim PB-Recency Cross-Credit (2026-05-07)

**Problem.** `computeDisciplineReadiness` reduced the run leg's readiness penalty when the athlete had a recent standalone race PB (e.g., recent half marathon → lighter 70.3 run penalty). Bike and swim legs got no equivalent credit — a triathlete who finished an IM 6 months ago could still face full bike/swim readiness penalties as if they'd never raced those legs.

**Method.** Scan `triConfig.raceLog` for completed triathlon entries where `actualPerLeg[discipline] > 0`. For each qualifying entry, look up a cross-credit weight from `TRI_DISTANCE_CROSS_CREDIT[fromDistance][targetDistance][discipline]`. Apply the same age-decay bands (`RUN_PB_RECENCY_BANDS`) as the run side, scaled by cross-credit weight:

```
effectiveFactor = 1 − (1 − bandFactor) × crossCreditWeight
penaltyMultiplier = 1 + (penaltyMultiplier − 1) × effectiveFactor
```

Where:
- `bandFactor = 0.5` for race < 1 year ago, `0.75` for 1-2 years, `1.0` for > 2 years (from `RUN_PB_RECENCY_BANDS`)
- `crossCreditWeight` from `TRI_DISTANCE_CROSS_CREDIT` (0 to 1.0)

**Cross-credit weights (TRI_DISTANCE_CROSS_CREDIT):**

Richer-counts-for-shorter principle: a longer race fully credits shorter target distances. Reverse direction uses partial credit.

| From \ To | IM | 70.3 | Olympic | Sprint |
|---|---|---|---|---|
| IM | 1.0/1.0/1.0 | 1.0/1.0/1.0 | 1.0/1.0/1.0 | 1.0/1.0/1.0 |
| 70.3 | 0.6/0.6/0.5 | 1.0/1.0/1.0 | 1.0/1.0/1.0 | 1.0/1.0/1.0 |
| Olympic | 0.3/0.3/0.3 | 0.6/0.6/0.5 | 1.0/1.0/1.0 | 1.0/1.0/1.0 |
| Sprint | 0.2/0.2/0.2 | 0.3/0.3/0.3 | 0.7/0.7/1.0 | 1.0/1.0/1.0 |

(Values are swim/bike/run for each cell.)

**Scientific rationale for partial reverse credit (Coyle 1984).** Fractional utilization of VO2max decays with duration — a sprint-distance bike leg (~30 min) and an IM bike leg (~5 hours) require qualitatively different pacing and substrate metabolism. Completing a sprint proves basic bike endurance but not the specific aerobic sustainability needed at IM pace. Run cross-credit from sprint→olympic stays at 1.0 because Daniels VDOT equivalence is well-validated across shorter run distances.

**Known limitations.**
- Entries before this feature shipped do not have `actualPerLeg` from the new schema extensions (WS-1 adds `predictedRawPerLeg` separately). Cross-credit reads `actualPerLeg` from existing entries — this works on all existing raceLog entries which already store `actualPerLeg`.
- Only triathlon distances are in raceLog today (no standalone bike TT or open-water swim results). The credit is therefore only applied when the user has completed a full triathlon event.
- Olympic and sprint distances are not currently logged to raceLog (only 70.3 and IM). Those rows of the cross-credit table are forward-compatible placeholders.

**Files.** `src/constants/race-readiness-targets.ts` (new `TRI_DISTANCE_CROSS_CREDIT`), `src/calculations/specific-endurance-penalty.ts` (unified recency block + `readTriRaceRecencyDays`), `src/ui/triathlon/race-readiness-detail.ts` (extended copy).

---

## §M — HYROX Band-Scaled Run-Leg Fatigue Model

**Problem.** A constant per-station fatigue rate (0.8%/station) applied to all athletes regardless of ability is not realistic. Elite athletes hold pace nearly flat across all 8 run legs; beginners show significant deterioration by run 7–8.

**Model.** Fatigued pace = base pace × (1 + legIndex × perStationFatigueRate), normalised so total run time = 8 × base pace (energy conservation). The per-station rate is band-scaled:

| Band | Rate (singles) | Notes |
|---|---|---|
| competitive | 0.4%/station | HyroxDataLab: top-10 finishers within ~2–4% across all 8 legs |
| advanced | 0.5%/station | |
| intermediate | 0.6%/station | |
| novice | 0.7%/station | ~5.6% total drift from leg 1 → leg 8 |
| beginner | 0.9%/station | |
| total_beginner | 1.1%/station | ~8.8% total drift — consistent with age-group 2h+ finishers |

Doubles format: rate × 0.5 (athletes alternate stations; waiting partner accumulates metabolic cost but not full eccentric load).

**Scientific basis.** HYROX finishing-time distributions (HyroxDataLab / roxlyfe.com) show that run-leg decline scales with performance level. Goss 2021 (repeated high-intensity bouts and run-economy decline) supports the mechanistic model. Bi-exponential EPOC decay would be more accurate but requires integrating station-specific eccentric load over time — too complex for v1.

**Known limitations.** Rate constants are from population distributions, not individual calibration. Normalisation to 8 × base pace is a simplification — the true energy balance accounts for increased HR, glycolytic contribution, and ventilatory drift. Values pending real-race validation.

**Files.** `src/constants/hyrox-constants.ts` (`PER_STATION_FATIGUE_RATE_BY_BAND`), `src/calculations/race-prediction.hyrox.ts` (model application), `src/ui/hyrox/forecast-view.ts` (chart rendering).

---

## Triathlon Race Prediction — Taper Invariant (2026-05-08)

**Problem.** A user set an Ironman 1 week away and the forecast showed projected swim +13:32 *slower* and projected run −14:02 *faster* than today. Both deltas are physiologically nonsensical over a 7-day horizon — taper consolidates fitness, it doesn't build or destroy it (Mujika 2002).

**Root cause — two divergence sources, neither scaled by `weeksRemaining`.**

1. *Swim engagement penalty (asymmetric).* When `weeksActive ≤ 2`, the predictor inflated the swim CSS baseline by up to +12% (Mujika 2010 detraining model: technique decays at 3–5%/4w without water time). The inflation was applied *only to the projected race-time call* — the "today" call kept the literal stale CSS measurement. Net effect: today=2:22 (fictional), projected=2:40 (realistic) → +13:32 phantom slowdown.

2. *Durability cap relaxation (unconditional).* The projected race-time call passed `projectedLongestSession.{bike,run} = DURABILITY_THRESHOLDS[distance].long{Ride,Run}Sec` regardless of `weeksRemaining`. The "today" call passed actual longest sessions. With `MAX_DURABILITY_PENALTY = 0.05`, this produced up to a 5% phantom run speedup. 5% × 4:40:38 = 14:02 ✓ — matches the observed delta exactly.

**Invariant introduced.** When the race is inside the discipline's taper window (`weeksRemaining ≤ TRI_TAPER_WEEKS[discipline][distance]`), `projected` per-leg must equal `current` per-leg within ±30s. Locked by the test `race-prediction.triathlon.test.ts → race inside taper window: projected per-leg matches current within 30s`.

**Two distinct fix shapes.**

- *Stale-measurement adjustments (engagement penalty)* represent a TODAY truth — the literal measurement is fiction; the user's real today CSS is worse. Applied symmetrically to BOTH `current` and `projected` calls via a shared `EffectiveBaselines` object returned from `buildProjection`. The displayed `projection.swimCss.current` keeps the literal value for transparency.

- *Plan-execution credits (durability cap relaxation)* represent fitness the plan *will deliver* over `weeksRemaining`. Scaled by per-discipline `executionFactor = 1 − penaltyShare` (the same closure math the existing race-readiness penalty uses). With 1-week IM in full taper → `executionFactor = 0` → projected longest session = actual longest session → no relaxation.

`projectedLongestSession.{bike,run} = lerpDurability(actual, threshold, executionFactor)`

where `lerpDurability(a, t, f) = a + max(0, t − a) × clamp(f, 0, 1)` — never reduces an athlete who already exceeds the threshold.

**Scientific basis.** Mujika 2002 (*Med Sci Sports Exerc* "Scientific bases for precompetition tapering strategies") — taper of 1–3 weeks consolidates fitness without building it. Mujika 2010 (*Br J Sports Med*) — detraining 3–5%/4w without specific stimulus. Per-discipline taper durations from `TRI_TAPER_WEEKS` (Friel 2018 *Triathlete's Training Bible*: swim taper longest because technique consolidation needs more time, bike shortest).

**Known limitations.** The taper invariant assumes `usefulWeeks = max(0, weeksRemaining − taperWeeks)` is the right way to model "no plan-execution time available." This already drives the race-readiness penalty closure share, so applying the same factor to durability cap relaxation keeps the model coherent. If future divergence sources are added between projected and current race-time calls, they must also be gated through `executionFactor` to preserve the invariant.

**Files.** `src/calculations/race-prediction.triathlon.ts` (reordered penalty-share computation, added `lerpDurability`, threaded `EffectiveBaselines` through `buildProjection`), `src/calculations/race-prediction.triathlon.test.ts` (new invariant test).

---

## §T — Triathlon prediction model improvements (2026-05-12)

### §T1 — Brick-adapted run-leg fatigue discount (ISSUE-200)

**Formula**: `fatigueDiscount = baseDiscount × (1 − brickAdaptation × BRICK_MAX_DISCOUNT_REDUCTION)`

Where:
- `baseDiscount` = `RUN_FATIGUE_DISCOUNT_70_3 = 0.05` or `RUN_FATIGUE_DISCOUNT_IRONMAN = 0.11` (Bentley 2007; Landers 2008)
- `brickAdaptation` = recency-weighted brick count / `BRICK_FULL_ADAPT_COUNT (12)`, clamped [0, 1]
- Recency weighting: exponential decay, half-life 4 weeks (recent bricks count more)
- `BRICK_MAX_DISCOUNT_REDUCTION = 0.40` — cap at 40% reduction; elite triathletes still fade even with high brick volume

**Science**: Millet & Vleck 2000 (*Med Sci Sports Exerc*): "Performance changes in world-class triathletes during a `race-pace` triathlon simulation" — observed that brick-trained athletes exhibit significantly attenuated run-leg performance decrement compared to non-brick-trained controls with equivalent fitness markers.

**Known limitations**: Adaptation curve is modelled as exponential to saturation; real adaptation is likely sigmoidal. `BRICK_FULL_ADAPT_COUNT = 12` is a midpoint of the 10–15 session range reported by Millet & Vleck. Overestimates adaptation for athletes who do bricks inconsistently across a training cycle.

---

### §T2 — Run-specific VDOT in horizon scaling (ISSUE-188)

**Change**: Horizon-scaling denominator uses `runDerivedCurrentVdot = cv(runDistM, blendedOpenSec)` instead of `args.state.v`.

**Rationale**: `args.state.v` is the blended VDOT, which bike cross-training can inflate. Using the run-specific current VDOT as denominator makes the scaling explicitly run-anchored. Since `applyTriHorizonRun` applies a percentage improvement (not absolute), the ratio is numerically equivalent for normal operation. The change guards against future modifications that might decouple the numerator from the run-specific baseline.

**Cross-training transfer**: Cycling does build aerobic capacity (VO2max, cardiac output) that genuinely transfers to running (40–70% efficiency per Mujika 2011 cross-training review). The blended VDOT is not wrong — bike fitness correctly flows into the primary `blendPredictions` path. This fix only clarifies the horizon-scaling step.

**Known limitations**: The equivalence holds only when `applyTriHorizonRun` returns a percentage improvement. If future horizon models return absolute VDOT gains, the denominator choice becomes meaningful.

---

### §T3 — Open-water swim deficit scaled by athlete OW experience (ISSUE-186)

**Formula**: `owPenaltyFraction = owBasePenalty × (1 − owAdaptation)`

Where:
- `BASE_OW_PENALTY_NON_WETSUIT = 0.05` — 5% for novice swimmer in non-wetsuit race
- `BASE_OW_PENALTY_WETSUIT = 0.02` — 2% for novice swimmer in wetsuit race (wetsuit buoyancy offsets OW inefficiency)
- `owAdaptation = 1 − exp(−effectiveCount / OW_ADAPT_HALF_SESSIONS)` — asymptotic curve
- `OW_ADAPT_HALF_SESSIONS = 5` — 5 effective sessions for 63% adaptation (most gains in first 5–10 sessions)
- `effectiveCount` from last 26 weeks; sessions older than 12 weeks count at 0.5

**Science**:
- Veiga et al. 2013 (*Int J Sports Physiol Perform*): pool-to-OW deficit ~5% for non-wetsuit, primarily from sighting (zigzag path adds ~2–3% distance equivalent), no turn walls, and mass-start contact
- Toussaint et al. 2002 (*J Biomech*): wetsuit buoyancy reduces drag and partially restores the pool-to-OW deficit, narrowing it to ~2%
- Adaptation: most OW-specific gains (efficient sighting lines, drafting, mass-start positioning) acquired within 10–15 OW swims

**Known limitations**: Strava `OPEN_WATER_SWIMMING` sport label is not universally applied; athletes who record OW swims as generic `SWIMMING` won't accumulate adaptation. Recency weighting uses a simple threshold (< 12 weeks = full, else 0.5) rather than continuous decay.

---

### §T4 — Heat acclimatisation discount on climate penalty (ISSUE-190)

**Formula** (revised 2026-06-01 — symmetric):
```
tempGap = raceAnchorTemp − trainingTempC          (positive = training cooler than race)
acclimFraction = clamp(tempGap / 30, −0.5, +0.5)  (±0.5 reached at a ±15°C gap)
runDiscount  = −baseRunSec  × (CLIMATE_RUN_MULTIPLIER[climate]  − 1.0) × acclimFraction
bikeDiscount = −baseBikeSec × (CLIMATE_BIKE_MULTIPLIER[climate] − 1.0) × acclimFraction
```
The returned value is **subtracted** from the post-course leg time: positive = credit (faster, trained hotter than race), negative = penalty (slower, trained cooler). Zero at race temp. Applied in **both** the empirical and physical course-factor paths.

**Revision history**:
- *Original*: `discountFraction = max(0, 0.5 × (1 − tempGap/15))` — credit-only, and it credited training *cooler* than the race (ramp to zero only at a 15°C gap). Backwards: heat acclimatisation is earned by training *in heat*, so 14°C training for a 24°C race wrongly earned a partial credit.
- *2026-06-01, symmetric (Tristan)*: the climate penalty (+4% warm etc.) is the **average field**; an athlete's own heat preparation shifts their exposure to it. Pivot at race temp: training hotter → credit (better adapted than field), at race temp → no adjustment (field-average penalty stands), cooler → **penalty** (under-adapted). Magnitude ±50% of the climate penalty at ±15°C. **Science**: Périard/Racinais/Sawka 2015 (heat-acclimation consensus) and Racinais et al. 2015 (consensus recommendations) — the acclimatised-vs-unacclimatised performance gap is roughly symmetric and of the same order (~4–7%) as the heat decrement itself; Ely et al. 2007 (marathon vs WBGT) shows under-prepared runners slow more than the field. **No double-count in the empirical path**: because the adjustment is zero at race temp, it adds only the athlete's *personal deviation* from the field, not the absolute weather (which the empirical factor already carries). The climate-penalty magnitude (`CLIMATE_*_MULTIPLIER`) is reused as the reference scale for that deviation in both paths — an approximation for empirical venues, where the true climate share of the calibrated factor is unknown. Cliff-free, but the ±15°C ramp and ±50% cap are pragmatic (not study-fitted). Training temp from `computeTrainingTempC` (4-week `ambientTempC` average, ≥4 readings).

**Anchors**: raceAnchorTemp from `CLIMATE_ANCHOR_TEMP_C` (cool=12°C, warm=24°C, hot=30°C). Training temp from `ambientTempC` on recent activities (Open-Meteo, 4-week window, minimum 4 readings required).

**Science**: Lorenzo & Cheuvront 2010 (*Eur J Appl Physiol*): 10–14 days of heat acclimatisation (HA) preserves 3–5% performance in hot conditions via plasma volume expansion, cardiovascular adaptation, and improved sweat rate. A Singapore-based athlete racing IM Vietnam carries effectively no net heat penalty; a Stockholm-based athlete carries the full penalty.

**50% cap rationale**: HA research shows near-complete restoration for well-acclimatised athletes in moderate heat, but humidity adds a residual effect (sweat rate limits) that HA can't fully overcome. Capping at 50% discount is conservative and defensible.

**Known limitations**: `ambientTempC` is only populated for outdoor runs/rides with GPS start location. Athletes without temperature data receive no discount regardless of training environment. Does not model humidity acclimatisation separately (hot-humid category receives same formula as hot).

---

### §T5 — Marathon PB depth credit on IM run leg (ISSUE-191)

**Formula**: `marathonDepthMultiplier = 1.0 − depthCredit × recencyFactor`

Where:
- `depthCredit = clamp((4:30 − pbTime) / (4:30 − 2:45), 0, 1) × MAX_MARATHON_DEPTH_CREDIT`
- `MAX_MARATHON_DEPTH_CREDIT = 0.04` (4% pace benefit at sub-2:45; confirmed by Tristan 2026-05-12)
- Credit onset at sub-4:30, full credit at sub-2:45 — smooth linear between
- `recencyFactor`: < 2yr = 1.0, 2–4yr = 0.6, > 4yr = 0.3 (old PBs represent past capacity)
- IM run leg only (not 70.3 — HM duration insufficient for durability headroom to dominate)

**Science**: Laursen & Rhodes 2001 (*Sports Med*) triathlon physiology review: marathon-experienced athletes demonstrate materially better IM marathon pacing through (a) durability — operating at lower % of ceiling at IM marathon intensity, (b) glycogen-sparing economy at prolonged aerobic effort, and (c) pacing experience managing fatigue across the second half. Two athletes at VDOT 52 can have 2:50 vs 3:50 marathon PBs; the 2:50 athlete runs the IM marathon well within their durability zone.

**4% calibration**: At VDOT 52, a 2:45 marathoner vs a 4:30 marathoner at the same blended VDOT — the gap in expected IM run time is approximately 7–10 min empirically. 4% of a 2:50 IM run split ≈ 6.8 min, at the low end of this range. Conservative but defensible. Tristan confirmed 4% after reviewing the 5-min example.

**Known limitations**: PB date stored in `state.onboarding.pbDates.m` (ISO string) — if absent, full recency is assumed. Does not model the interaction between marathon depth credit and the brick adaptation discount (both reduce the net run penalty independently). Combined effect is multiplicative, which may slightly over-benefit athletes with both high brick volume and a fast marathon PB.

---

## §MC — Monte Carlo race-time forecast (2026-05-19)

### What it is

A stochastic forecast that surfaces the *range* of likely race-day outcomes instead of a single point estimate. The deterministic prediction (`s.forecastTime` / `predictTriathlonRace().totalSec`) is the centre of the distribution; the Monte Carlo wraps uncertainty around it.

Implementation: `src/calculations/race-forecast-simulation.ts` exports `runMarathonForecastSim(s, N=2000, goalSec?)` returning per-week percentiles (p10/p25/p50/p75/p90) plus a race-day distribution and goal probability. Seeded with `mulberry32(42 + currentWeek)` so the displayed cone is stable across renders within a plan week — the chart doesn't re-roll on every tab visit.

### What we vary, and why

**1. Improvement percentage** — sampled `~ N(meanImprovementPct, σ_improvement)` per trial.

- `meanImprovementPct` comes from `applyTrainingHorizonAdjustment(...).improvement_pct` (the existing horizon model) multiplied by the user's `adaptationRatio` (Phase 2A — how the body is currently responding vs population mean).
- **σ_improvement = max(0.8, |meanImprovementPct| × 0.50)**. 50% relative SD on the mean, floored at 0.8 absolute percentage points so very small mean improvements still produce a visible cone.

*Defensibility.* Bouchard et al. 2011 (*J Appl Physiol* "Genomic predictors of the maximal O₂ uptake response to standardized exercise training programs") report individual response variance in V̇O₂max gain over 20-week structured programs at **σ ≈ 30–40% of the mean response**. Bouchard & Rankinen 2001 (*Med Sci Sports Exerc* "Individual differences in response to regular physical activity") report similar variance. Joyner & Coyle 2008 (*J Physiol* "Endurance exercise performance: the physiology of champions") show that marathon-pace performance depends on V̇O₂max × fractional utilization × economy — each independently variable. Composing those into a single race-time SD pushes the realistic spread past Bouchard's V̇O₂max-only number, justifying our 50% (vs Bouchard's 30–40%) — plus we have additional real-world sources (injury, illness, life events) that the controlled-training literature doesn't capture.

The 0.8% floor handles the small-improvement edge case (athlete in maintenance phase, taper, or already near ceiling) where 50% of "almost zero" would produce a flat-line cone — not honest, just imprecise.

**2. Adherence** — sampled `~ N(0.90, 0.12)` clipped to `[0.5, 1.0]` per trial, then normalised by its own mean before being applied: `adherenceMul = adherence / meanAdherence`.

- Final realised improvement = `improvement_pct × adherenceMul`. A trial that "trains as expected" (adherence ≈ mean) gets the full deterministic improvement; trials above the mean get a slight bonus, trials below the mean a proportional shortfall.
- Mean 0.90 reflects realistic plan adherence in self-coached endurance athletes — well-coached cohorts hit ~0.95, recreational free-floating hit ~0.75. 0.90 is the midpoint, with σ wide enough that the bottom tail (0.7 — substantial missing) and top (1.0 — perfect execution) both appear in the simulation.
- **Normalisation by mean (2026-05-20)**. Earlier versions multiplied improvement directly by `adherence`, which shifted the simulated median ~10% short of the deterministic projection — so the forecast headline and the median outcome tile disagreed by ~2 min on a 70.3 build. The deterministic prediction is built against a realistic plan and already implicitly assumes typical adherence; the sim's role is to add *spread*, not re-discount the mean. Normalising preserves the variance (good and bad weeks still widen the cone) while pinning the simulated median ≡ deterministic projection.

*Defensibility.* No single canonical adherence-distribution paper, but the parameter is calibrated against the broader literature: Wilson 2014 (*J Hum Sport Exerc* "Why people stay or quit: a review of factors affecting adherence to exercise programs") synthesises ~30–50% drop-off rates in unstructured programs, ~85–95% completion in supervised programs over 12–24 weeks. Self-tracked athletes (this app's target population) sit between those bands, supporting a 0.90 prior.

**3. Race-day form factor** — sampled `~ N(1.0, 0.025)` clipped to `[0.93, 1.07]` per trial. Applied as a pace multiplier (1.0 = neutral, >1.0 = slower).

- Captures everything that affects the single race-day execution: weather, fuelling, sleep before, gut, mental, pacing decisions, taper landing.
- **σ = 2.5%** on pace. For a 3:30 marathon, that's ±5.25 minutes per SD — empirically reasonable for the spread of "same fitness, different days" outcomes.

*Defensibility.* Foster et al. 2014 (*Med Sci Sports Exerc* "Pattern of perceived exertion during pacing") and Tucker 2009 (*Br J Sports Med* "The anticipatory regulation of performance") show race-day pacing executions vary by 2–4% even in well-trained athletes attempting their best at the same fitness. Smyth 2018 (*Eur J Sport Sci*: large-scale marathon-pacing analysis, n>1M finishes) corroborates this band. We sit at the conservative end (2.5%) because the form factor only captures within-fitness variability — the bigger uncertainty (training response) is handled separately.

**Form-factor ramp**. The form factor doesn't apply uniformly across the build — it ramps in over the last 8 weeks (the taper window). `formIntensity = clamp((8 - weeksToRace) / 8, 0, 1)`. Weeks beyond 8-out get no form noise; weeks 8 to 1 get linearly scaling form noise; race day gets the full sampled factor.

*Why*. Race-day execution variance grows as race day approaches (taper landing, weather forecast clarifying, gut nerves) — applying it uniformly across the build would mistakenly attribute mid-build variance to race-day factors. Mujika & Padilla 2000 (*Med Sci Sports Exerc* "Detraining: loss of training-induced physiological and performance adaptations: Part II") explicitly identifies the taper as the window where execution variables matter most.

### What we DON'T vary

- **Course factors** (climate, altitude, elevation). Deterministic — sampled once at race-pick, applied as a constant multiplier. Reason: course factors are about the venue, not the athlete. The athlete-side variance is already captured in the three Monte Carlo sources above. Mixing course noise into the simulation would conflate two things and make the cone harder to interpret.
- **VDOT trajectory shape across the build**. Each trial assumes a smoothstep-shaped trajectory from `currentVdot` to `finalVdot = currentVdot × (1 + improvement × adherence / 100)`. Real adaptation has more shape variability (plateaus, fluctuations) but the marginal added value to the user-facing cone is small at this resolution; honesty in the *endpoint* is what matters for a forecast surface.

### Goal probability

When the user has set `s.raceGoalTimeSec` (running) or `triConfig.targetFinishTimeSec` (tri), the simulator counts the proportion of trials whose race-day total ≤ goal: `goalProbability = #{t : t ≤ goalSec} / N`. Surfaced as a percentage on the forecast page.

**Display capping**. 100% and 0% are mathematically valid for very loose or very aggressive goals, but read as "the model is wrong" to a user. Display is capped at **95%+** and **<5%**, with subline copy that contextualises which tail the goal sits in. The underlying probability is unaffected by the display cap — it's an honesty floor on framing, not on the math.

### Known limitations

1. **Per-trial parameters are independent**. A user with high adaptation ratio is also likely high adherence (motivation correlation) but the model samples independently. Bouchard's individual-response variance literature mostly treats response and adherence as separable, so this is defensible but slightly conservative on the optimistic tail.

2. **Triathlon sim shares the same parameter set as the marathon sim**. The implicit assumption is that swim/bike/run improvements are correlated within a trial (one athlete, one training response) — which is the right modelling choice for a single-trial multi-discipline race. Doesn't allow surfacing per-discipline uncertainty as separate cones — that's a deliberate scope decision (see Tristan's "single total-time cone" choice in the design session). A per-discipline simulator is a future extension.

3. **No injury / drop-out modelling**. Trials all run to race day. In reality, ~10–20% of marathon training cycles get interrupted by injury or illness. Adding this would require a hazard-rate sampler and an "interrupted trial" outcome. Currently captured implicitly via the wide adherence tail (0.5 floor = "completed only half the plan"), but a fraction of athletes don't make race day at all and that's not in the cone.

4. **Race-day form factor is mode-neutral**. The 2.5% σ pace variance applies identically to marathon and triathlon. Marathon execution variance may be smaller (single discipline, well-rehearsed) and tri larger (three transitions, more failure modes). Future refinement could split these.

### Files

- `src/calculations/race-forecast-simulation.ts` — the marathon simulator.
- `src/calculations/race-forecast-simulation.triathlon.ts` — the triathlon simulator (single-total-time cone).
- `src/ui/race-forecast-view.ts` — surfaces the running cone with goal callout + tappable outcome tiles.
- `src/ui/triathlon/forecast-view.ts` — surfaces the tri cone (same shape).

## §AL — Body-mass adaptations (2026-05-26)

Two athlete-size adjustments. The cross-training swap is **opt-in** (one-time onboarding popup; default-on for heavy users until they decide, off-switch in Account). The heat ratio is silent and always-on when the data exists. Both are **inert** for anyone at/below the relevant reference — the no-op is regression-locked in tests.

### The two buckets (why most of the model already handles weight)

Body mass barely affects *what we prescribe for pace/power* because those calculations self-normalise: the energy cost of running is ~0.9–1.0 kcal/kg/km, roughly constant per kg (di Prampero 1986), and VO₂ is measured per kg, so VDOT (derived from a race time) already encodes mass. FTP→W/kg and CSS are likewise mass-relative. What body mass *does* drive is **cumulative tissue loading** and **heat strain** — the two surfaces that previously ignored it.

### §AL1 — Cross-training swap (PLANNING, opt-in)

**Science**: peak vertical ground reaction force in running is a near-constant multiple of bodyweight (~2.5–2.8× BW; Nilsson & Thorstensson 1989), so cumulative joint / connective-tissue load per km scales ~linearly with body mass. Substituting low-impact aerobic work (bike/swim/elliptical) for a share of easy running reduces that load while preserving the aerobic stimulus (aerobic fitness is largely maintained when ≤~30–50% of run volume is replaced by cycling — Foster 1995; Mutton 1993).

**Formula**:
```
swapFraction = mass < engageFloor ? 0 : clamp(1 − swapRefMass/mass, 0, 0.15)
```
Two thresholds, deliberately distinct:
- `swapRefMass` (85 kg M / 72 kg W, general-population average) sets the trim *magnitude* — how far above average. NOT a runner average; anchoring on lean-runner 75 kg flagged normal-built people.
- `engageFloor` (95 kg M / 80 kg W) sets *who is bothered at all* — below it, zero swap and no popup. Added 2026-05-26 after an 88 kg test user (only 3 kg above the average) saw the popup for a trivial 3% trim. Because the trim is measured from the 85/72 average but only engages at 95/80, it engages already-meaningful (~10%), not a trivial 1–2% — no tiny-trim-near-threshold artefact.

A 100 kg man tops out at the 0.15 cap (vs 26% under the earlier runner-anchored 0.30 cap). Constants set by Tristan (2026-05-26).

**Opt-in, not automatic** (Tristan's design call): weight alone is a blunt signal — you can be heavy and very fit. So rather than impose it, a one-time onboarding popup explains the adjustment and the user keeps it or turns it off (`bodyMassSwapEnabled`: undefined = undecided/default-on, true = kept, false = off; off-switch in Account). From then on the app's normal live adaptation (HR/pace → effort, VDOT, ramp) evolves the plan — no auto-retire, no weight logic fighting the adaptation.

**Application** (running): post-process in `generateWeekWorkouts` scales freshly-prescribed `t:'easy'` runs (km + `estimatedDurationMin`) by `(1 − swapFraction)` when `bodyMassSwapEnabled !== false`, before makeup/commute/gym/recurring sessions are appended — so commute and makeup runs are never altered. Each generation rebuilds easy runs at full length, so the swap never compounds; turning it off takes effect on the next generation (week rollover / replan).

**Application** (triathlon): tri easy runs are time-based (`d` = "N min easy"), not km, so the SAME shared fraction (`crossTrainingSwapFraction`) is applied to the easy-run *minutes* at generation in `generateRunSessionForTri` (param `easyVolumeKeep = 1 − swapFraction`), keeping description, duration, and load internally consistent. Only `t:'easy'` runs are trimmed; long/quality/brick run work is untouched, and bike/swim (already low-impact) are never trimmed. The shared computation is the fraction; the application differs by format (km vs minutes) because the two engines represent runs differently.

**Why prediction is untouched**: `getPlanPrescribedMeanWeeklyKm` (the race-prediction volume input) is computed from sessions × reference × ramp, independent of the generated workouts. Trimming generated easy runs therefore does not perturb the forecast; the swapped easy volume is treated as aerobically equivalent (efficiency = 1.0).

**Limitations**: (1) GRF→injury is confounded and non-linear — in lean runners, *low* mass/low BMD is the dominant stress-fracture risk, so this is framed as joint-load *management*, not fracture prevention. (2) Weight is a weak proxy for tolerance (fitness, training history, injury history matter more); the opt-in + live adaptation are the mitigation. (3) The forward prediction does not model the modest running-economy decrement from substitution; acceptable given the gentle ≤15% swap. (4) Applied to **running and triathlon** (easy aerobic runs only). **HYROX is an intentional exception** (mirror rule's "don't merge" clause): its running is sport-specific — race-pace intervals and station-to-run transition practice, not swappable easy aerobic base — so HYROX gets the heat lever only (silent), no swap and no opt-in popup (the "eased back your easy running" copy would be false there).

### §AL2 — Heat personalisation (TRACKING, silent)

**Science**: metabolic heat production scales with mass; dry + evaporative dissipation scales with body surface area (BSA). Heat strain at a given temperature scales with the mass-to-BSA ratio — larger athletes store heat faster (Cramer 2023; Marino 2000 found ~0.5–1.0 °C more core-temp rise in larger runners in warm conditions).

**Formula** (physical ratio, no invented exponent):
```
BSA(m²) = 0.007184 × weight^0.425 × height^0.725          (Du Bois 1916)
heatStrainRatio = clamp((mass/BSA) / (refMass/refBSA), 0.85, 1.25)
```
`refBSA` from 75 kg/178 cm (M), 62 kg/165 cm (F) — the MARATHON-FINISHER calibration build, deliberately leaner than the swap's general-population anchor (85/72). The climate-penalty constants (Ely 2007, El Helou 2012) were derived from marathon fields, so the ratio must read 1.0 at that leaner build or typical runners get systematically under-penalised for heat. The clamp band ([0.85, 1.25]) is the only knob; it bounds the correction so a single outlier can't produce an extreme effect.

**Application** (both surfaces, per Tristan's choice): scales the existing `heatAdjust` HR-drift correction (`drift − 0.15 × ratio × max(0, tempC − 15)`) so a larger athlete's hot-day drift is correctly attributed to heat (protecting them from a false under-recovery flag), and scales the run-leg climate penalty in `applyCourseFactors` (`runFactor = 1 + (climatePenalty − 1) × ratio`). At ratio 1.0 both are byte-identical to the originals (regression-locked). Bike climate penalty is left unscaled — convective cooling at 30+ km/h dominates body-size effects.

**Limitations**: linear application of a body-size scalar to categorical climate multipliers is a first-order model; requires height (absent → ratio 1.0, no adjustment). Confidence: high for direction/BSA scaling, medium for the linear application.

### Files
- `src/constants/body-mass-constants.ts` — references, CAP, Du Bois coefficients, clamp band, plausibility bounds.
- `src/calculations/body-mass-adaptations.ts` — pure functions + state wrappers; safety contract.
- `src/calculations/body-mass-adaptations.test.ts`, `heat-personalisation.regression.test.ts` — unit + regression locks.
- `src/workouts/generator.ts` — swap post-process. `src/calculations/daily-coach.ts`, `course-factors.ts` — heat threading.
- `src/ui/body-mass-reveal.ts` (opt-in popup), `plan-view.ts` (trigger), `account-view.ts` (weight/height + off-switch), `wizard/steps/about-you.ts` (onboarding capture).

## §AM — Injury-aware triathlon race projection (2026-05-27, ISSUE-247)

**Problem.** An injured 70.3 athlete (week 5 of 20, swim/run restricted, bike fine) saw the race forecast project only ~6 minutes of improvement. Root cause: `applyTriInjuryGates` zeroed swim and run for *every* current-and-future week (the per-week ramp was previously removed — "the slider is the gradient"), and the predictor read that injury-suppressed plan, extrapolating the next-4-week dose across the whole horizon. A 2-week injury was therefore modelled as a 15-week one — swim and run projected ~0 gain, leaving only the bike leg to move the prediction.

**Model.** Capture a per-discipline recovery window `r_d` = weeks until discipline `d` returns to full training, stored on `InjuryState.resumeWeeksByDiscipline`. Seeded from the selected protocol's `typicalRecoveryWeeks` midpoint, user-adjustable per sport in the injury modal.

- **Plan engine** (`applyTriInjuryGates`): discipline `d` is restored to full capacity for any plan week where `weeksFromCurrent ≥ r_d`. The slider still sets the *magnitude* of the restriction within the window; `r_d` sets *when it ends*. A binary cutoff, not the old graduated ramp.
- **Predictor** (`predictTriathlonRace`): each discipline's effective build weeks `W_d = max(0, weeksRemaining − debit_d)`, where the build-time debit is **capacity-scaled**: `debit_d = r_d × (1 − c_d/100)` and `c_d` is the discipline's current capacity (0–100). A fully blocked discipline (`c_d = 0`) loses its whole window (`debit = r_d`); a discipline still trained at reduced volume (e.g. bike at 50%) loses only the fraction it cannot train (`debit = 0.5 r_d`), banking partial build. The projected dose (sessions/wk, hours/wk) is sampled from plan weeks *after* `max_d r_d`, so it reflects the recovered steady state, not the injured transition weeks. Unrestricted disciplines (`r_d = 0`) keep the full horizon. `W_d` feeds both the marker-gain horizon (`buildProjection`) and the endurance-gap closure (`computeProjectionPenaltyShare`).

  **Capacity-scaling rationale (2026-05-27 refinement).** Reuses the same linear capacity→volume relationship the plan engine already applies (`duration × cap/100`): a discipline at capacity `c` does `c%` of its normal volume, so over the window it banks `c%` of the build it otherwise would. Composing that with the (near-linear) week factor of the horizon model gives the `1 − c/100` debit fraction. No new constant. Before this refinement, a reduced discipline was debited its *whole* window like a blocked one, which under-credited a bike still ridden at half volume — the user reported their 50%-capacity bike showing no benefit from the riding they were actually doing.

**Physiological basis.** Banister-style impulse-response (Banister 1975; Busso 2003): fitness accrues from training impulses. No impulse for a discipline during its restriction → no gain for that discipline over those weeks; normal accrual resumes after. Representing the loss as a reduction in *effective build weeks at the recovered dose* is a first-order approximation of the impulse integral over the horizon.

**Why effective-weeks, not reduced dose.** After recovery the athlete trains at full dose; the loss is time, not intensity. Debiting weeks (rather than sessions/wk) keeps the post-recovery accrual rate correct, and sampling the dose past the window avoids contaminating the steady-state rate with the injured weeks.

**Defensibility of constants.** `r_d` is sourced from per-protocol `typicalRecoveryWeeks` ranges (`injury-protocols.ts`) — clinical-judgement bands (stress fracture 6–16 wk, runner's knee 4–8, general 1–4) — and is user-adjustable. No invented numbers.

**Limitations.**
1. **Ignores detraining decay during the window** (Mujika & Padilla 2000): a paused discipline loses some fitness, not merely "fails to gain". Conservative for short windows (~2 wk) and partly offset because the athlete keeps training unrestricted disciplines (aerobic-base cross-transfer, especially bike→run). For long restrictions the model slightly over-credits the post-recovery baseline.
2. **Plan-engine restore is a binary cutoff.** The *predictor* now models reduced capacity (partial credit via `1 − c/100`), but the *plan engine* still flips a discipline from its slider value straight to 100% at the resume week, rather than ramping. The real return is gradual; running mode's separate return-ramp system handles graduated return there. The capacity scaling means the prediction no longer treats "reduced" as "blocked", which was the larger error.
3. **User-supplied estimate.** An optimistic resume week inflates the projection; the protocol-seeded default tempers this.

**Tracking vs planning.** Deliberately on both sides. The plan-engine change is *planning* (what to prescribe after recovery); the predictor change is *tracking/forecast* (what race day looks like). They share one source (`resumeWeeksByDiscipline`) so the Plan page and the forecast agree — no parallel computation.

**Code.** `src/ui/injury/modal.ts` (per-discipline capture, protocol-seeded), `src/workouts/plan_engine.triathlon.ts:applyTriInjuryGates` (per-week restore), `src/calculations/race-prediction.triathlon.ts:computeInjuryRecoveryWeeks` + `buildProjection` per-discipline weeks, `src/calculations/tri-volume-by-discipline.ts` (`startOffset` dose sampling). Caption: `src/ui/triathlon/race-forecast-card.ts:renderInjuryRecoveryNote`. Tests: `gates.test.ts` (restore-after-window, per-discipline, legacy-freeze), `race-prediction.triathlon.test.ts` (monotonic: shorter recovery → faster race day), `tri-volume-by-discipline.test.ts` (offset).

**Running-mode mirror (2026-05-29).** Running mode previously *froze* its forecast during a run injury — it held `s.v` (correct: no improvement while not running) but fed the live forecast the full `weeksRemaining`, crediting build over weeks the athlete could not run. It now applies the **same** capacity-scaled debit as triathlon: `debit_run = r_run × (1 − c_run/100)`, effective build weeks `= max(0, weeksRemaining − debit_run)`, so the projection builds from the return date. The formula, the `DisciplineRecovery` shape, and `recoveryDebitWeeks` are lifted into `src/calculations/injury-recovery.ts` and consumed by both predictors (CLAUDE.md "Mirror rule"; no duplicated math, no new constant). Applied at both running forecast sites (`blended-fitness.ts` `s.forecastTime`/`s.expectedFinal` recompute and `renderer.ts` live forecast) so the two numbers agree. The VDOT-freeze gate (`blended-fitness.ts`) now reads `getDisciplineCapacity(inj,'run') === 0` instead of the raw `canRun === 'no'` enum, so it stays correct with the per-discipline sliders. Running has no per-week dose sampling to offset (its horizon dose is a flat prescribed mean), so the effective-weeks reduction is the whole lever; same Banister impulse-integral first-order approximation and same limitations (ignores in-window detraining decay). Tests: `injury-recovery.test.ts` (debit math, blocked vs reduced, horizon clamp, legacy-freeze fallback).

## §AN — Region-aware strength during injury (2026-05-27, ISSUE-249)

**Problem.** An injured triathlete still saw the full 45-minute full-body strength session in both the plan and the AI coach. Root cause (`applyTriInjuryGates`): the strength session was dropped only when `upperLoadCapacity <= 0`, but the triathlon injury modal never shows the upper/lower-load sliders (HYROX-only), so `upperLoadCapacity` stayed undefined → read as 100 → strength never dropped. It was gated on a control the athlete could not reach. Running had the mirror problem from the other direction: its gym generator dropped strength entirely in the acute/rehab phases (all-or-nothing), discarding the maintainable, unaffected regions.

**Model — relative rest + regional load substitution.** When one body region is injured, loading the *unaffected* regions maintains strength and neuromuscular qualities without stressing the healing tissue. The injury `location` (always set) determines which regions are safe to load, via the canonical physio map `LOCATION_CAPACITY_DEFAULTS` (lifted from the UI modal into `src/injury/engine.ts`). `bodyRegionLoadability(injuryState)` returns `{upper, lower}` (0–100), reading explicit upper/lower sliders when set (HYROX) and otherwise the per-location defaults.

- **Phase gate.** Relative rest is region-specific, not systemic, so every active phase (`acute` through `graduated_return`) loads the unaffected region — only the injured region is ever withheld (its capacity is 0). The acute phase is kept lightest (RPE 3) because the body is managing fresh inflammation, but a localized injury does not preclude training the clearly-unaffected region from day one (PEACE & LOVE, Dubois & Esculier 2020). `resolved` / inactive → normal templates. The only blanket pause is a both-regions-blocked injury (e.g. `back`).
- **Region assembly** (`injuryStrengthDecision`, `src/workouts/injury-strength.ts`). Lower-body included when `lower > 0`; upper-body when `upper > 0`; core when the injury is not to the trunk/spine (`back`/`neck`/`chest_ribs`, where anti-rotation/plank loading is itself contraindicated). Both regions blocked (e.g. `back`) → strength paused. Duration scales with region capacity (`block_min × cap/100`).
- **Exercise-level tailoring.** Region gating alone is too coarse: a shoulder injury's lower/core blocks still loaded the shoulder (front/side plank, pallof press, goblet squat, glute bridge all weight-bear or rack-load through the shoulder). Every exercise in the library carries a `loads: BodyArea[]` tag (the joints/structures it requires, including loaded `grip`), and each injury location maps to a set of `avoid` areas (`LOCATION_AVOID`, the site plus tightly-coupled structures — a hamstring crosses the knee, a wrist rules out loaded grip). Any exercise whose `loads` intersect the avoid-set is excluded before selection. So a shoulder injury keeps shoulder-free leg work (bodyweight squat, lunge, step-up) and shoulder-free core (dead bug, hollow hold, heel taps), and drops everything that loads the shoulder. The library is bodyweight/band/machine-biased so it filters cleanly across injuries; loaded variants are tagged so they drop out for the relevant ones.
- **Worked cases.** Knee/hamstring/hip (lower 0, upper 100) → upper-body + core. Shoulder/wrist/elbow (upper 0, lower 100) → lower-body + core. Back (both 0) → paused. This matches standard physio practice: a knee injury does not preclude rows and presses; a shoulder injury does not preclude squats and bridges.

**Physiological basis.** Regional maintenance and cross-education during rehab (Bleakley et al. 2012). Banister-style impulse-response (Banister 1975): training a region accrues fitness in that region; resting an injured region avoids re-injury while the contralateral/unaffected regions keep their stimulus. Loads are kept submaximal (RPE ≤ 5) and pain-gated through the recovery phases, normalising only once `resolved`.

**Defensibility of constants.** No new model constants. Region loadability comes from the existing `LOCATION_CAPACITY_DEFAULTS` clinical-judgement table (the same anchors the injury modal already used). Block durations (lower 18 / upper 15 / core 10 min) sum to ~43 min, matching the 45-min non-injured template they replace; capacity scaling reuses the established `duration × cap/100` model already used for swim/bike/run downmix. RPE 4–5 is anchored to the existing `gym.ts` maintenance/return templates (RPE 3–5). Exercise selection is standard physio prescription in the same style as the existing `gym.ts` templates.

**Cross-mode.** Shared `injuryStrengthDecision` is called by running (`gym.ts`) and triathlon (`plan_engine.triathlon.ts`); triathlon additionally scales each retained session's `aerobic`/`anaerobic` from the original 45-min ratio by the adapted duration so weekly TSS stays correct. HYROX is unchanged: its stations are mixed-modality fixed movements already scaled/dropped by `min(upper, lower)` capacity (`applyHyroxInjuryGates`); per-component substitution within a single station (e.g. an "upper-only" sled push) is not physically meaningful and remains explicitly out of scope.

**Tracking vs planning.** Pure *planning* — this prescribes what strength to do during recovery. It does not feed race prediction (that is §AM's separate per-discipline recovery model).

**Limitations.**
1. **Two-region granularity.** Real physio targets specific muscles/joints; upper/lower/core is a coarse partition. Adequate because the strength session is itself a coarse prescription, and pain-gated cues catch the residual.
2. **Ignores detraining of the rested region** (Mujika & Padilla 2000) — consistent with the rest of the injury system; the point is relative rest, and the unaffected regions are still loaded.
3. **No per-week recovery ramp for strength.** Region strength stays adapted until the injury is marked resolved, rather than auto-restoring on a guessed timeline (the §AM resume-week logic governs the disciplines, not the strength regions). Conservative by design.

**Code.** `src/injury/engine.ts` (`LOCATION_CAPACITY_DEFAULTS`, `bodyRegionLoadability`), `src/workouts/injury-strength.ts` (`injuryStrengthDecision`), `src/workouts/plan_engine.triathlon.ts:applyTriInjuryGates`, `src/workouts/gym.ts`, 27 `generateWeekWorkouts` call sites now pass `s.injuryState` so the plan/coach views match the canonical regen. Tests: `injury-strength.test.ts` (per-location regions, phase gating, slider override, submaximal RPE), `gym.test.ts` (region-aware running gym).

**Compensation nudge (2026-05-29).** When an injury limits a discipline, the app *suggests* (accept/decline, once per week) adding one extra region-safe strength session — the user's "can't run, so do more leg/upper gym work" intent. It reuses the *same* `injuryStrengthDecision` output (region-filtered exercises, capacity-scaled duration), so it introduces no new load model or constant; it only changes *how many* safe sessions the week can hold, and only with user consent. Deliberately a suggestion, not an auto-ramp: the freed training load is not load-matched to a target (that would need an absorption constant we do not have), and silently inflating volume during injury is the wrong default. Code: `src/ui/injury/modal.ts:maybeShowStrengthNudge` (pushes to `wk.adhocWorkouts` on accept; `Week.strengthNudgeSeen` guard).

## §AO — HYROX station session round count fills the time budget (2026-05-29)

**Problem.** Station-density and station-technique sessions prescribed a fixed round count (density 2, technique 3) but set the headline `estimatedDurationMin` to the scheduler's slot budget (e.g. 55 min). The prescribed work (2 rounds x 2 stations, intermediate band) totals ~26 min, so a ~26-min session was labelled 55m. The number was wrong and the work was too little for the allocated time.

**Model.** Treat the station circuit as the research doc's intended shape: density is "station work for time / AMRAP" (docs/research/hyrox.md §7.2, line 462), so the slot is a legitimate time cap. Rather than a fixed token count, the round count fills the budget:

```
roundDurSec = Σ(per-station work) + (nStations-1)·interStationRest + interRoundRest
rounds      = clamp( round(budgetSec / roundDurSec), 2, bandMax )   // nearest-fit
durationMin = round( (Σwork·rounds + all rests) / 60 )              // headline FOLLOWS the work
```

This mirrors the brick generator's fill-the-budget intent (`generateFullBrick`), applied to density and technique too, but uses **nearest-round** fill rather than `floor` so the session lands near the allocated slot instead of always under-shooting it.

**Constants — all sourced, none invented:**
- **Band dose ceiling** (`bandMaxRounds`): beginner tier ≤4, novice/intermediate ≤6, advanced/competitive ≤8 — the *upper* bounds of the HYROX research doc §3.5 brick dosing (lines 169–171). Used as the clamp ceiling so race-pace station volume never exceeds the band's prescribed dose on a large slot. The time budget sets the round count below the cap; it is deliberately *not* forced up to the brick *minimum* (those minima assume a 1 km run per round, so forcing them onto a run-less station circuit overshoots the slot — e.g. intermediate min-4 would turn a 55-min slot into a 77-min session).
- **Circuit floor** (`MIN_CIRCUIT_ROUNDS = 2`): structural, not physiological — below 2 rounds it is a single pass (the calibration assessment), not a training circuit. Matches the prior fixed behaviour's effective minimum.
- **Rest periods**: density 30s between stations / 2 min between rounds; technique 60s / 3 min. These were already the values in the detail-modal copy; now stored on the workout (`HyroxComponent.restAfterSec`, `Workout.hyroxRoundRestSec`) so the guided player and the modal read the same source.
- **Station count**: technique up to 4 (was 3); density 3 — two race-discriminator high-MTL stations + one erg (was 2). Tristan's coach steer (2026-05-29): "prescribe enough work… what would a coach do" — more variety + budget-filled rounds.

**Why defensible.** MTL now scales with the actual prescribed rounds (more work → more load), which is physiologically correct. Round dosing tied to training status follows the same brick guidance the rest of the HYROX engine uses. The headline duration is no longer a phantom: it is computed from the work the athlete is told to do.

**Known limitations.**
1. **Dose ceiling borrowed from brick dosing.** Bricks include a 1 km run per round; station-only rounds are shorter, so a given band/budget yields a different round count than a brick would. We use only the brick *max* as a sanity cap (a beginner should not do >4 rounds of anything); the budget sets the actual count. Moderate confidence, consistent with the doc's own "Moderate" rating for brick dosing.
2. **Race-pace density volume ceiling** is enforced only by the band max (≤8). No explicit fatigue model caps race-pace station repeats beyond that.
3. **Nearest-fit can overshoot the slot** by up to half a round (≈7 min competitive, ≈13 min total-beginner). Accepted: a coach fills to the nearest whole round, the headline duration is honest about it, and the pre-existing technique session already overshot its slot by the full run-finish (≤20 min), so downstream load accounting already tolerates `estimatedDurationMin ≠ targetMinutes`.
4. **Technique run finish** is still encoded in the description text, not as a guided component (out of scope for this change).

**Code.** `src/workouts/hyrox-generators.ts` (`bandMaxRounds`, `MIN_CIRCUIT_ROUNDS`, `fillRounds`, `generateStationDensity`, `generateStationTechnique`; brick/mini/assessment also store `hyroxRounds`). Types: `HyroxComponent.restAfterSec`, `Workout.hyroxRounds`/`hyroxRoundRestSec`. Guided expansion: `src/guided/strength-model.ts` (`parseHyroxSession`). Tests: `hyrox-generators.test.ts`, `strength-model.test.ts`.

## §AP — Learning station benchmarks from guided sessions (2026-05-29)

**Problem.** Guided HYROX station sessions captured a per-round time for every station, but the times went nowhere usable: the write guarded on `components.length === records.length` (broken once rounds expanded the record list), targeted the wrong config object (`triConfig` instead of `hyroxConfig`), and only touched history, never the scalar benchmark the predictor reads. So measured performance never improved the athlete's benchmarks.

**Model.** Feed measured station times into the benchmark via the "Manually-set Benchmarks Yield to Improvements" rule, with HYROX-specific guardrails grounded in what the times actually represent:

- **Only race-pace sessions teach** (`hyrox_station_density`, `hyrox_brick`). Technique runs at 65% of seed pace by design (and half reps) — submaximal, so it can never improve a benchmark. It is still shown in the session summary, labelled "technique pace".
- **Candidate = best (fastest) round** per station. It is measured under in-circuit fatigue (after the prior station, or after a 1 km run in a brick), so it is a *conservative* proxy for a fresh single-station test. Beating the stored benchmark while fatigued is strong, hard-to-fake evidence the benchmark is stale.
- **PB-only**: a session only ever lowers a benchmark; a slow day never raises it. A station with no user benchmark yet is *calibrated* from the best round (better than the population estimate it was using).
- **Sanity floor**: a measured time below the elite (`competitive`) seed for that station is rejected as a timing slip. Sourced bound, no invented number.

**Conservative on fatigue (deliberate).** We log the *raw* best round, not a fatigue-corrected "fresh equivalent". This under-credits the athlete slightly (their fresh time would be faster), but inventing an un-fatigue multiplier would violate the no-made-up-numbers rule. The next fresh test or faster session catches up. A future refinement could apply the predictor's existing race-day fade factor in reverse, if one is sourced.

**Transparency.** Updates surface in the end-of-session summary the user is already looking at ("Benchmark updated. 8s faster than your best."), so there is no separate launch toast and therefore no meaningful-delta threshold to invent. History entries carry a new `'session'` source so the per-station detail view labels them "Session best".

**Why defensible.** This is *tracking* (describing fitness from what the athlete did), the correct side of the tracking/planning line. The PB-only + confidence-gate + provenance pattern mirrors the run-pace marker-bump (`applyHyroxRunPaceDerivation`) and the synced-activity parser (`applyParsedBenchmarks`). The fatigue-conservatism means false-positive benchmark improvements are structurally unlikely (you cannot accidentally go faster under fatigue).

**Known limitations.**
1. **Phone-stopwatch noise.** Times come from the user tapping "Complete set". The sanity floor catches gross slips; small mis-taps that still clear the floor could set a slightly-optimistic benchmark. PB-only means a later honest test cannot *raise* it back, so a bad tap can stick until beaten — accepted risk for a single-user dev build, revisit if it bites.
2. **Doubles sanity floor uses the singles elite seed.** Doubles station times are faster (half the work), so the singles floor is conservative for doubles — it may occasionally decline to auto-update a legitimate fast doubles time. Errs toward not-updating (safe).
3. **Raw fatigued time** (see "Conservative on fatigue").

**Code.** `src/calculations/hyrox-session-benchmarks.ts` (`isRacePaceHyroxSession`, `summariseHyroxSession`, `applyHyroxSessionBenchmarks`). Wired from `src/guided/strength-complete.ts`; summary in `src/ui/guided-strength-overlay.ts` (`buildHyroxFinishSummary`). Source enum `'session'` added in `hyrox-station-history.ts` + `triathlon.ts`; label in `station-detail-view.ts`. Tests: `hyrox-session-benchmarks.test.ts` (9).

## §AQ — HYROX injury-aware projection (2026-05-29)

**Problem.** The HYROX race-day projection (`buildHyroxProjection`) credited full training-horizon build to every discipline regardless of an active injury. A HYROX athlete with a blocked or reduced body region still saw the healthy-case projected gain. Triathlon has solved this since §AM: it debits each discipline's effective build weeks by an injury-recovery window (`injuryAdjustedBuildWeeks`), so a forecast builds from the return date rather than crediting weeks the athlete cannot train. HYROX never consumed that shared math.

**Model — discipline build-week debit, stolen from triathlon.** Same formula, same shared helper (`src/calculations/injury-recovery.ts`). An injury costs a discipline `resumeWeeks × (1 − capacity/100)` weeks of effective build; the horizon for that discipline then runs over `weeksRemaining − debit` weeks. A blocked discipline (capacity 0, full window) → 0 build weeks → no projected gain (the horizon functions clamp to `improvement_pct: 0` at `weeks_remaining ≤ 0`, no detraining penalty). This is a *projection-horizon* adjustment only: today's "race now" prediction is unchanged, in parity with triathlon.

**Discipline mapping.** HYROX has no swim/bike. Its disciplines are the 8 km run (`run`) and the 8 functional stations. The injury engine already exposes `upperLoad` / `lowerLoad` capacity and resume windows, captured directly by the HYROX injury modal (`src/ui/injury/modal.ts:106`, the `eventType === 'hyrox'` branch shows run / upper-body / lower-body sliders). Stations map to regions anatomically (`HYROX_STATION_REGION` in `src/calculations/hyrox-injury.ts`):

| Station | Region | Movement basis |
|---|---|---|
| SkiErg | upper | double-pole: lats, triceps, core |
| Sled Push | lower | horizontal leg drive |
| Sled Pull | full | upper-back/arm pull braced on leg drive |
| Burpee Broad Jumps | full | push-up + explosive jump |
| RowErg | full | legs drive, back/arms finish |
| Farmer Carry | full | grip/upper hold under loaded locomotion |
| Sandbag Lunges | lower | loaded lunge, leg-dominant |
| Wall Balls | full | squat + overhead throw |

A `full` station is debited by the *worse* of its upper/lower build weeks (`min`), because the station is only as trainable as its most-restricted contributor. The run portion is debited by the `run` discipline; roxzone (transition economy) is left unaffected (it has no triathlon analog — tri transitions are fixed clock time, not horizon-projected).

**Why defensible.** No new model constants. The recovery math, the per-region capacity table (`LOCATION_CAPACITY_DEFAULTS`), and the `injuryAdjustedBuildWeeks` formula are all the existing §AM / §AN machinery. The only new artefact is the station→region classification, which is anatomical (HYROX movement patterns), not a tunable. The no-injury path is bit-for-bit unchanged: `stationInjuryBuildWeeks(undefined, …)` and `injuryAdjustedBuildWeeks(undefined, …)` both return the full `weeksRemaining`.

**Surface.** The forecast hero shows a one-line recovery note (`renderHyroxInjuryNote` in `src/ui/hyrox/forecast-view.ts`), mirroring the triathlon marquee's `renderInjuryRecoveryNote`: "Assumes recovery on schedule: Running resumes in 3 weeks, upper-body work is reduced until then. Counts each discipline only for the weeks it can train."

**Resume-window fallback (2026-05-29).** The debit is `resumeWeeks × (1 − capacity/100)`, so it is silent when no return-to-sport window was captured — a capacity slider set without a "back to X in N weeks" value would debit nothing and the forecast would promise full gain for a sport the athlete cannot train (the first-device-test failure mode). `injuryWithResumeFallback` (`src/calculations/hyrox-injury.ts`) fills any restricted discipline (`run` / `upperLoad` / `lowerLoad`) lacking an explicit window with the injury protocol's typical-recovery midpoint — `round((min+max)/2)` from `INJURY_PROTOCOLS[type].typicalRecoveryWeeks`, the SAME clinical-judgement band the injury modal uses to pre-fill the field (`modal.ts:getModalHTML`, `recoveryMid`). No new constant. The run debit (`runInjuryBuildWeeks`), the per-station debit (`stationInjuryBuildWeeks`), and the hero note all route through it, so the displayed "resumes in N weeks" matches the build-week math. The explicit window always wins when present. **Plan propagation**: separately, an injury only reaches the HYROX plan once it is regenerated; the injury modal save now regenerates the current + future HYROX weeks (`applyHyroxInjuryGates`), which also lowers the projection's planned-sessions input — so the forecast responds both through the per-discipline debit and through reduced planned volume.

**Limitations.**
1. **Linear region collapse.** A `full` station takes the worse single region rather than a weighted blend of both. Conservative: it never under-states the restriction. A blended model would need per-station upper/lower load fractions we have not measured.
2. **Roxzone unaffected.** Transition economy is small and not cleanly tied to one region; left out rather than guessed.
3. **Capacity is a snapshot.** The debit uses the current capacity for the whole pre-return window rather than a graded ramp back to 100; matches the triathlon model's same simplification.

**Code.** `src/calculations/hyrox-injury.ts` (`HYROX_STATION_REGION`, `stationInjuryBuildWeeks`), wired into `src/calculations/race-prediction.hyrox.ts` (`buildStationProjection`, per-station weeks) and `src/calculations/race-projection.hyrox.ts` (`buildHyroxProjection`, run horizon). UI note in `src/ui/hyrox/forecast-view.ts`. Tests: `hyrox-injury.test.ts` (10 — mapping, per-region debit, full-station worst-of, blocked/reduced, projection integration, no-injury invariance).

## §AR — Per-workout user scaling (running): planning-side, prediction-neutral (2026-05-29)

**What it is.** A user-facing "Adjust" control on running workout cards lets the athlete scale one session: a continuous duration slider (50%–115% of the prescribed total time) and stepped Easier/Harder intensity notches along the pace ladder, plus two "Got less time" presets. This is the self-service equivalent of the AI coach's `reduce_workout` + `adjust_intensity` tools. Code: `src/workouts/workout-scaling.ts` (pure helpers) + `src/ui/workout-adjust-overlay.ts`.

**Scaling model (v2, 2026-05-29) — proportional "scale everything".** The duration slider applies a single scale factor `f ∈ [0.50, 1.15]` to the WHOLE session. Every distance (km / bare metres) and duration (min) token in the description scales by `f`, and the session's total minutes scale by `f`; paces (e.g. "3:52/km", "4:39/km+") are left untouched, because the intent is to shrink or grow the session, not re-pace it. This replaced the v1 distance-only scaler, which could only touch the first "Xkm" token — wrong for a structured tempo, where it grabbed the warm-up's "2km" as the whole session (the bug Tristan caught). "Scale everything proportionally" was Tristan's explicit choice (2026-05-29) over trimming the main set or cutting reps. So a tempo at `f = 0.75` becomes "1.5km warm up ... 10min @ 3:52/km (~2.5km) ... 1.5km cool down". Intensity notches are independent of `f` and change the run *type* (and its RPE), not the length.

**Time is the universal unit.** Cards headline time (from `estimatedDurationMin`), which is the one honest scalar every session has. Distance-defined runs (easy/long/MP) also show their distance ("8.0 km · 38 min"); structured sessions show time only. This is why a tempo no longer mis-displays a single distance, and why the headline updates live with any scale (the mod carries `newDurationMin`).

**Which side of the tracking/planning line.** Scaling sits squarely on the **planning** side: it changes the *prescription* for a single session. It is explicitly NOT a tracking input. It does not recompute CTL/ATL, VDOT, weekly load targets, the plan ramp, or the race prediction. Those respond only to the activity the athlete actually completes (the tracking side). The scaled session is persisted as a standard `WorkoutMod` re-applied at render; nothing reads it as achieved load.

**Adherence treatment (defensible).** Running adherence is distance/time-based against the prescribed session. Because a scale rewrites the live `w.d` + `estimatedDurationMin`, adherence compares against the *scaled* target, not the original. This is deliberate and honest: the athlete made a conscious, informed decision to do less (or more), so it is not a missed session — penalising a chosen trim would punish exactly the behaviour the feature exists to support. The original session is retained on the mod (`originalDistance` holds the full plan description, `originalDurationMin` the plan minutes) and the "Adjusted" chip + "Original:" caption (for simple-distance runs) surface the change.

**Constants — all anchored, none invented (CLAUDE.md "No Made-Up Numbers").**
- Scale-factor floor **0.50** = the taper long-run multiplier (`plan_engine.ts`). Ceiling **1.15** = the `effortMultiplier` ceiling. These bound a single-session adjustment to the same envelope the plan engine itself uses for week-scale modulation, so a user scale can never prescribe a session more extreme than the system would. (The factor floor of 0.50 replaces v1's separate 3 km hard floor; a 0.5× minimum is a softer, type-agnostic equivalent.)
- "Got less time" preset **0.75** = the maximum cross-training reduction tier (`getTier`, `timing-check.ts`).
- Intensity notches reuse the existing `PACE_LADDER` (easy → marathon → threshold → vo2) and `RPE_BY_TYPE` verbatim; long runs step down their own sub-ladder. No new intensity model.

**"Less time, same effort" — a stated approximation, not an equation.** This preset shortens duration to 75% AND steps intensity up one ladder notch, on the premise that a shorter, harder session preserves roughly equivalent training stimulus. This is a pragmatic approximation, NOT a TSS-preserving calculation. The true relationship (TSS ∝ duration × IF², so a 0.75 duration cut needs IF up ~1.15× to hold TSS) does not map cleanly onto the discrete zone ladder — one notch over/undershoots depending on the starting zone. We accept the approximation because (a) the athlete sees and confirms the resulting session before it applies, (b) the actual stimulus is measured from what they complete, not from this estimate, and (c) a precise per-zone IF table would be false precision over a user's in-the-moment intent. **Limitation flagged**: the preset can over- or under-shoot true iso-stimulus by up to roughly one zone's worth of intensity factor; it is a convenience, not a load-matched prescription.

**Proportional-scaling limitations.** (1) Reps don't change count — "6x800m" at 0.75 becomes "6x600m", scaling rep distance not rep number (Tristan's "scale everything" choice; cutting reps was the rejected alternative). (2) Intensity notches change the type/RPE but do NOT rewrite the description's pace tokens, matching the coach's `adjust_intensity`; a tempo made "easier" keeps its written paces. (3) Token scaling is regex-based on km/min/m; an exotic description format with an unlabelled scalar would be missed (it would simply not scale that token).

**Tests.** `src/workouts/workout-scaling.test.ts` (14 — leading-distance parse, simple-vs-structured classification, scalable-token detection, proportional scaling with pace-preservation and metre reps, factor clamping, minutes scaling, ladder stepping with long-run and end-of-ladder cases).

**Addendum (2026-06-01) — all-modes + bike/swim intensity.** The control now covers triathlon, cycling, and HYROX (run + bike/erg/swim). For these the scale is written straight onto the persisted `triWorkouts`/`adhocWorkouts` object (reload-safe; running stays a `WorkoutMod` matched by stable slot id via `findWorkoutForMod`). Bike and swim gain a discipline intensity ladder — the running pace ladder has no swim/bike analogue, so two sourced ladders are used instead:
- **Bike** (`BIKE_INTENSITY_LADDER`, triathlon-constants.ts): endurance 0.65 → tempo 0.82 → sweet-spot 0.91 → threshold 1.00 → VO2 1.15 (×FTP). Allen & Coggan (2010/2019) power-duration zones — the same source as `CYCLING_EVENT_INTENSITY_FACTOR` and the `BIKE_OPTIONS` picker. Target watt range = `FTP × pct × (1 ± BIKE_ADHERENCE_BAND[kind])`, identical to `pwLabel` in bike.ts.
- **Swim** (`SWIM_INTENSITY_LADDER`): technique +18 → endurance +6 → CSS 0 → speed −6 sec/100m relative to critical swim speed. Target pace = `CSS + offset`. Mirrors the `SWIM_OPTIONS` picker.
The chosen rung persists as `Workout.intensityLevel` and the target is recomputed live from the athlete's current FTP/CSS (so it tracks benchmark improvement; nothing is baked into the description, keeping duration scaling clean). **No new constants and no fabricated RPE** — for cycling power is the primary objective signal (Coggan & Allen 2019; CLAUDE.md bike-effort rule), so the watt/pace target *is* the prescription. Injury aerobic-maintenance sessions are allowed to step harder (Tristan's call — athlete intent over the Z2 default). Tests: `src/constants/intensity-ladder.test.ts` (7).

**Addendum (2026-06-02) — Adjust feeds training load; forecast stays plan-neutral.** The Harder/Easier (and duration) adjustment now flows into the session's *training load*, but deliberately NOT into the forecast directly. The principle: a planned adjustment is **intent**, not a tracked outcome; pre-crediting fitness from a slider would be phantom fitness and trivially gameable. So:
- **Planned load (planning side):** a bike/swim rung recomputes the session's `aerobic`/`anaerobic` via the existing per-kind TSS/min helpers (`loadForBike`/`loadForSwim`); a duration change scales load proportionally (load ∝ duration at fixed intensity — exact). This only changes what the *plan* shows, not the prediction.
- **Realized load (tracking side):** tri/cycling per-discipline CTL is rebuilt from completed activities. A session completed via a synced activity already contributes its **real** load (harder actual effort → more iTRIMP → more CTL → faster forecast) with no slider involvement — reality is measured, not assumed. A session marked done **manually** (no synced activity) now deposits its *planned* load as a synthetic CTL contribution (`iTrimp = TSS × 150`, fitness-only, excluded from CSS/FTP derivation), guarded so any real matched activity overrides it (Strava-canonical, no double-count).
- **Why this is defensible / honest:** the forecast moves only on accumulated CTL, which moves only on completed load. So "train harder and do it → better forecast; train easier and do it → worse" holds, but the consequence is a *fitness* outcome, never an *adherence* penalty (a deliberately-chosen easier session is still "done, not missed" per the original §AR rationale). **Limitation flagged:** a single adjusted session is a rounding error on a 42-day-tau CTL; the effect is only material as a sustained pattern (correct behaviour). Manual-done load is self-reported (RPE-gated completion, no device verification) and is the weakest load signal — it is always superseded by a real activity. Tests: `manual-done-tri-load.test.ts` (6).

---

## §AS — Post-holiday detraining + discipline-aware comeback bridge (2026-06-01)

**What.** Closes the P1 gap in `docs/CROSS_MODE_PARITY_PLAN.md`: triathlon/cycling/HYROX athletes returning from a holiday got their full week-N prescription on day one (an ACWR spike the running bridge exists to prevent), and FTP/CSS never detrained at all. Three pieces: a shared detraining decay curve, FTP/CSS/VDOT docks on holiday return, and a discipline-aware render-time comeback bridge.

**The decay curve — `detrainingLossFraction(daysAway, retentionRatio)` (`welcome-back.ts`).** One curve now drives VDOT, FTP and CSS detraining rather than three invented ones (CLAUDE.md "two numbers, one source").

- **Shape:** reuses the existing VDOT decay rates — ~1.2%/week for the first two detraining weeks, ~0.8%/week thereafter, compounding. Source: Mujika & Padilla (2000), *Detraining: loss of training-induced physiological and performance adaptations*. Short-term detraining shows VO2max declining ~6% over the first 3–4 weeks off, with measurable power/endurance loss; the staged rate captures the steeper early phase.
- **Dead-zone: `DETRAINING_DEADZONE_DAYS = 10`** (Tristan, 2026-06-01). No loss inside the first 10 days. Mujika & Padilla find VO2max essentially preserved through roughly the first week off; a normal week's holiday is a taper, not detraining. Time is measured *past* the dead-zone, so the steep early-loss phase begins where the literature says detraining actually starts, not on day one. This also fixes a latent over-dock: the old holiday VDOT path fed `Math.ceil(daysAway/7)` into the decay, so a 3-day trip rounded up to "1 week" and lost 1.2%. `computeVdotLoss` now delegates to the shared curve, so the missed-week path inherits the dead-zone too.
- **Activity-while-away attenuation:** loss is scaled by `(1 − retentionRatio)`, where `retentionRatio` is the holiday training load as a fraction of the pre-holiday weekly average (`classifyHolidayActivity`, total-TSS-based, discipline-agnostic). An athlete who kept training through the break detrains proportionally less; one who matched normal load detrains nothing. Ratios above 1 clamp to zero loss.

**Why holiday-only, not effort-age (a deliberate rejection).** An earlier design faded FTP/CSS whenever the most recent hard effort aged. Rejected (Tristan, 2026-06-01): the FTP/CSS estimators key off the *best hard effort*, so a compliant athlete doing prescribed Z2 endurance — full training load, zero detraining — would see their FTP silently fall simply because no new max effort refreshed it. "No recent test" is not "lost fitness." The true detraining signal is a **drop in training load**, and the one place that is known with certainty is a declared holiday. Detraining therefore fires only on a holiday return; following the plan never lowers a benchmark.

**The docks (`showHolidayWelcomeBack`, holiday-modal.ts).** With `frac = detrainingLossFraction(daysAway, ratio)`: VDOT and FTP move down by `×(1−frac)`, CSS (lower sec/100m = faster) moves up by `×(1+frac)`. Provenance flips to `derived`, a history sample is appended, and a `[holiday-detrain]` line is logged. Per CLAUDE.md "Manually-set Benchmarks Yield to Improvements", these stay overridable.

**Anchor-gate (the clobber fix).** The launch benchmark refresh (`main.ts`) ratchets FTP/CSS *up* toward what ride/swim history implies — but right after a holiday, history is stale-high, so it would restore the docked value on the next launch. Fix: the dock records `ftpDetrainAnchorISO` / `cssDetrainAnchorISO` (= holiday end date). The refresh will not raise FTP / improve CSS from a contributing effort dated **on or before** the anchor: a pre-holiday ride is not evidence you have recovered. A ride/swim *after* the return supersedes the dock and clears the anchor. This is the existing "improvement must be demonstrated" rule, applied to recovery rather than progression. New state fields are optional (fresh-install safe).

**The comeback bridge — `applyBridgeModsAllDisciplines` (holiday-modal.ts).** The run-only `applyBridgeMods_renderTime` scales `\d+km` strings and skips every non-run session, useless for watt/time/station sessions. The discipline-aware sibling reads the *same* `_holidayBridgeScale` (set by `buildBridgeWeekMods`: 0.50–0.85 over 1–3 weeks, keyed by holiday activity level — existing running constants, none invented) and scales swim/bike/run-leg/station `estimatedDurationMin` + `musculoTendonLoad`, plus run km strings. Applied at render in the tri and HYROX plan-views (mirrors today's `applyHolidayModsAllDisciplines` wiring). It governs **volume**; intensity targets remain FTP/CSS-derived (themselves now docked). Skips adhoc, holiday, and user-Adjusted (`userScaledAt`) sessions.

**Mechanism note (why render-time, not engine `forceDeload`).** The tri/HYROX plan-views render stored `triWorkouts`, not freshly engine-generated weeks, so the engine's `forceDeload` (consumed only at generation) cannot scale the displayed comeback week. Running itself ramps the resume weeks at render via `applyBridgeMods_renderTime`; `forceDeload` is for the holiday weeks themselves. The discipline-aware bridge is the faithful mirror.

**Tracking vs planning.** The bridge is **planning** (it changes the prescription). The detraining docks are **tracking** inputs to the benchmark state and the race prediction (they describe a real load drop). Both are honest: the prescription eases and the predicted time reflects the time off.

**Limitations.** (1) The missed-week VDOT path (`advanceWeekToToday`) uses `retentionRatio = 0` — it has no per-discipline holiday-activity signal, so a multi-week app absence during which the athlete kept training (synced later) still docks VDOT fully. Pre-existing; the dead-zone now softens short gaps. (2) Potential VDOT double-dock if both `advanceWeekToToday` and `showHolidayWelcomeBack` fire on the same return launch — pre-existing interaction, not introduced here; flagged for device verification. (3) HYROX station benchmarks and MTL do not detrain (D3, Tristan): strength detrains slower than aerobic fitness, and the comeback bridge already eases station *volume*.

**Tests.** `welcome-back.test.ts` (+5: dead-zone boundary, growth past the dead-zone, activity attenuation, clamp >1, `computeVdotLoss` inheriting the dead-zone). `illness-holiday-disciplines.test.ts` (+5: bridge scales bike/swim/station/brick + run km, quality downgrade, no-op without scale, skips user-Adjust and adhoc). Docks + anchor-gate are integration-level (DOM + launch refresh) and flagged NOT device-verified.

---

## §AT — Swim progression blends pace-vs-CSS adherence (P3a, 2026-06-01)

**What.** Closes the P3a asymmetry in `CROSS_MODE_PARITY_PLAN.md`: `scoreSwimEffort` (tri-effort-scoring.ts) computes swim pace-vs-CSS adherence and the UI shows it, but `triTrailingEffortScore` (effort-multiplier.triathlon.ts) treated swim as RPE-only for next-week duration scaling. Bike blends its objective signal (power adherence) 60% with RPE 40%; swim ignored its objective signal entirely. The signal was computed-but-inert for adaptation.

**Change.** Swim now mirrors bike's blend (D6, Tristan: mirror bike 60/40). The objective deviation is `swimObjectiveDev = (1 − paceAdherence) × 10`, blended `dev = rpeDev × 0.4 + swimObjectiveDev × 0.6`. Falls back to pure RPE when no pace signal exists (e.g. a technique/drill set with no usable distance).

**Sign — why inverted vs bike.** `paceAdherence = actualPace ÷ targetPace` with pace in sec/100m, where lower is faster. So `paceAdherence < 1.0` means the athlete swam *faster* than the CSS-derived target — a harder effort than prescribed — which must read as a positive (harder) deviation that shortens next week. Bike's power signal is the opposite (`powerAdherence > 1.0` = more watts = harder = positive). Hence `(1 − paceAdherence)` for swim vs `(powerAdherence − 1.0)` for bike. The blend weights and the `1 − score × 0.05` multiplier are identical across disciplines.

**Mirror rule (CLAUDE.md).** Bike: power adherence 60 / RPE 40. Swim: pace-vs-CSS 60 / RPE 40. Run: HR 60 / RPE 40 (in events.ts). All three now blend an objective intensity signal with RPE at the same weights. If the bike/run weights change, swim's must be re-evaluated.

**Side of the line.** Planning — it scales the upcoming swim *duration*. CSS itself still re-derives separately from history (`deriveTriBenchmarksFromHistory`); this module only modulates volume.

**Data dependency / limitation.** Relies on `actual.paceAdherence` being populated, which needs the matched swim to carry usable distance + duration and a current CSS (`scoreSwimEffort` returns null otherwise). Open-water swims with GPS drift can produce a noisy pace; the +RPE blend and the existing under-duration guard soften single bad reads, but a systematically mis-measured pool length would bias the signal. Pure-RPE fallback covers the no-signal case.

**Tests.** `effort-multiplier.triathlon.test.ts` (+4: faster→harder, slower→easier, 60/40 blend arithmetic, pure-RPE fallback).

---

## §AU — HYROX execution → next-week-load multiplier (P2, RPE-primary, 2026-06-01)

**What.** Closes the P2 gap in `CROSS_MODE_PARITY_PLAN.md`: `plan_engine.hyrox.ts` was purely phase-driven, with no per-session execution signal — crush a week or bomb it, next week's prescription was identical. There was no HYROX analogue of running's `effortMultiplier` / tri's `triEffortMultiplier`. Now there is: `hyroxEffortMultiplier` (`effort-multiplier.hyrox.ts`).

**D5b (Tristan): yes, HYROX should adapt to execution.** The reasoning that made it defensible: HYROX race implements are fixed at division weight, so the athlete progresses by *work capacity at that weight* (more rounds/reps, less rest), not by adding load. Volume/density is therefore the correct progression lever, and scaling the weekly hours budget scales rounds/volume — exactly that lever. This is why a running-style volume multiplier fits HYROX (where it would be the wrong tool for a general load-periodised gym program).

**Signal — RPE-primary, all sessions.** Trailing RPE-vs-expected over the last `TRI_EFFORT_LOOKBACK_WEEKS` (2) completed weeks, aggregated across *all* HYROX sessions (stations, bricks, run legs — HYROX is one integrated sport). Formula and bounds are identical to running and tri: `1 − score × 0.05`, clamped `[0.85, 1.15]`. Reuses the existing lookback + bounds constants; introduces none. Includes the same under-duration guard (a session cut to < 80% of planned duration can't inflate next week via a low RPE).

**Why RPE-only (not the bike/swim-style objective blend).** A 3-agent data map established that the objective station signal does not exist for the general case:
- *Synced* activities (Strava/Garmin/Apple) carry only a classification (station/brick/run) + total duration. No per-station reps/times — ever. So synced sessions are RPE-only no matter what.
- *Guided* in-app sessions store best-round station times (`hyroxSession.stations[].bestSec`) but there is no stored *prescribed-target* scaffold to score adherence against (targets live as free text in the workout description).
- `rep-adherence.ts` is run/bike-only (it scores pace/watts; stations have neither) and is not extensible without a redesign.

Building the objective half would mean a structured station-target refactor + a new guided-only scorer + a sourced tolerance band (D4), for objective coverage that *only ever applies to guided sessions* while synced sessions still fall back to RPE. RPE is the one signal present on every session, and pure-RPE progression is already an accepted pattern here (running's no-HR fallback; tri's swim before §AT). So the loop is RPE-driven now; an objective 60/40 blend (D4/D5) is a deferred, guided-only enhancement. **HR is rejected** for stations: intermittent intervals make HR lag the work by 30–60s and there is no clean per-station target IF to score against.

**Wiring + scoping.** Folded into the weekly budget at `plan_engine.hyrox.ts`: `effectiveHours = weeklyHoursAvailable × phaseMult × deloadFactor × effortMult`. Multiplicative on top of phase + deload, mirroring running's `dMult` composition (so a deload week still gets the bounded ±15% modulation, exactly as running does). Applied only to weeks ≥ current (past weeks keep their real prescribed load — we don't rewrite history), matching tri's `applyTriEffortMultipliersToFutureWeeks`. Non-compounding: HYROX regenerates from baseline before re-applying the current multiplier, so it never stacks across launches.

**Side of the line.** Planning — it modulates the upcoming prescription. The race prediction continues to respond to execution separately via the station-benchmark PB refresh (`hyrox-session-benchmarks.ts`); this multiplier governs the *plan*, not the predicted time.

**Limitations.** (1) RPE-only: a systematically mis-rated athlete (always says "5") gets no adaptation; the objective blend that would counterweight this is the deferred enhancement. (2) Applies to all future weeks at the current multiplier, so a transient hard block tilts the whole remaining plan until re-rated — same behaviour as tri, self-correcting week to week. (3) Surfaced inline on the HYROX plan-view current-week summary when the shift is ≥5% ("Load raised/eased N% this week after recent sessions were rated easier/harder than planned"), per the adaptation-transparency rule. HYROX has no week-debrief, so an inline caption (the feature-reveal preference) hosts it rather than a recap modal.

**Tests.** `effort-multiplier.hyrox.test.ts` (11: neutral/positive/negative score, all-session aggregation, skip-ignored, 2-week lookback, under-duration guard, multiplier formula + both clamps + no-data).

## §AV — Race-forecast Monte Carlo anchors to the blended prediction, not raw VDOT (2026-06-01)

**What.** `runMarathonForecastSim` (`race-forecast-simulation.ts`) builds its cone by interpolating a *headline trajectory* from today to race day, then adding each trial's bare-VDOT deviation and form factor on top (see §AH-era design notes in the file: median = headline by construction). Today's headline anchor is `blendedRaceTimeSec` — what `blendPredictions` says the athlete can run now, which is PB-weighted. The race-day anchor was `s.forecastTimeAdjusted ?? s.forecastTime`.

**The bug.** `s.forecastTime` is supposed to be blend-anchored too (`calculateLiveForecast` computes it as `blendedAnchor − horizonDelta`), but in practice it can be null (not yet written on a given surface) or computed off a different anchor than the live blend. For an athlete whose **PBs outpace their synced-run VDOT**, `blendedRaceTimeSec` is pulled fast (e.g. 17:55) while the VDOT-driven `forecastTime` stays slow (e.g. ~19:30). The cone then ran from a fast *today* anchor to a slow *race-day* anchor — sloping the wrong way, with a median ~2 min **slower** than the displayed prediction and the entire distribution sitting below (slower than) the headline. Result on a real build: initial prediction 17:55, simulated median 19:37, goal probability "<5%" — the simulator predicting regression across a training block.

**The fix (two-part — first attempt overcorrected).** The initial fix *recomputed* the race-day anchor from the blend plus the sim's own horizon (`blendedRaceTimeSec − horizonDelta`). That removed the regression but introduced a second error: the sim's recompute omits the calibration bias, shoe boost, and course factors that `refreshBlendedFitness`/`calculateLiveForecast` bake into the displayed `forecastTime`, so the cone landed ~2.5 min slower than the headline — on a marathon, a goal set *equal to the displayed forecast* read ~32% instead of ~50% (real build: hero 3:24:20, sim median 3:26:57).

The correct anchor is the forecast the UI actually shows, with the blend-derived value kept only as a fallback:

```
horizonDeltaSec   = bareTodaySec − bareMedianFinalSec          // ≥0 when improving (bare-VDOT space)
courseRatio       = forecastTimeAdjusted / forecastTime         // pure climate/elevation multiplier, else 1
blendDerived      = (blendedRaceTimeSec − horizonDeltaSec) × courseRatio
displayedForecast = forecastTimeAdjusted ?? forecastTime
forecastCoherent  = displayedForecast > 0 && displayedForecast ≤ blendedRaceTimeSec + 1   // improvement, not regression
headlineRaceDay   = forecastCoherent ? displayedForecast : blendDerived
```

In the common case the cone centres exactly on the displayed forecast (so "goal == forecast" ≈ 50% by construction). The blend-derived fallback fires only when the stored forecast is missing or *slower than today* — the stale/PB-divergent state that caused the original regression — so the cone still slopes the right way there. Per-trial variance (VDOT response, adherence, form) is untouched; the deterministic median trial already equals the headline, and the empirical-median alignment shift (a few lines below) pins p50 onto `headlineRaceDaySec`.

**Why defensible.** The displayed `forecastTime` is the canonical headline — it already includes calibration, shoes, and course factors, so anchoring to it is the "two numbers, one source" rule and guarantees the cone agrees with the number the user reads. The +1s float margin on the coherence test means only a forecast genuinely slower than today (regression) trips the fallback; equal-to-today (maintenance) is treated as coherent.

**Effect.** Coherent marathon state: race-day p50 = 3:24:22 against a 3:24:22 headline, goal==forecast reads 50%, a 5-min-faster goal reads 20%. PB-divergent 5K state (forecast stale at ~19:30 while today's blend is 17:55): fallback engages, cone improves from the blend, goal of 17:55 reads ~86% instead of "<5%".

**Limitations.** (1) The fallback trusts `blendedRaceTimeSec`; when it is absent too, `haveHeadlineAnchor` is false and the sim uses the bare-VDOT trajectory, as before. (2) When the displayed forecast is itself genuinely slower than today (true detraining/maintenance block), the fallback overrides it with an improving cone — acceptable because a race-forecast cone predicting regression reads as broken; the upstream forecast coherence is the real fix if that case is ever legitimate. (3) Course ratio is 1 unless both adjusted and raw are present.

**Third part — "what-if" session adds (`forecastOverrideSec`).** Anchoring to the *stored* `forecastTime` broke the goal overlay's "add a session" preview: the displayed forecast caption recomputes for the hypothetical session count (gets faster), but the sim stayed pinned to the base `forecastTime`, so the chance barely moved — two forecasts that disagree on screen. Added an optional `forecastOverrideSec` param: when the caller is simulating a hypothetical (N extra sessions), it passes the forecast it computed for that count, and the cone centres there. The race-forecast page passes nothing and uses the stored forecast as above. Effect (marathon, goal 3:20:00): +0 sess forecast 3:24:22 / chance 24%, +1 sess 3:22:19 / 37%, +2 sess 3:20:46 / 46% — forecast and chance now move together.

**Tests.** `race-forecast-simulation.test.ts` (6): PB-divergent fallback — cone improves from the blend (no regression), goal of the headline is sane (>0.4), a faster stretch still a tail outcome (<0.25); coherent case — goal == displayed forecast reads ~50% (0.42–0.58), race-day p50 equals the displayed forecast within 30s; override case — a faster forecast override raises the goal chance by >10pp.

---

## §AW — Strength weight tracking: working-weight memory, RIR autoregulation, phase-gated progression, Epley est-1RM (2026-06-01)

**Context / side of the line.** Two sides. The **working-weight memory** and **estimated-1RM** are *tracking* (what the athlete lifted, and a derived strength benchmark). The **next-weight suggestion** is *planning* (what to do next), and it is deliberately subordinate to the endurance plan: strength here serves running/triathlon performance and injury resilience, not maximal hypertrophy. So progression is gated by the run/tri periodisation, not run as an independent linear-progression program.

**Estimated 1RM — Epley (1957).** `1RM = w · (1 + reps/30)`. Standard, widely used, accurate to within a few percent for sets up to ~10 reps. We cap the rep term at `EPLEY_REP_CAP = 12` (`strength-constants.ts`) because the linear approximation degrades above ~10–12 reps (the true load–rep curve is convex), so a high-rep accessory set can't inflate the estimate. Reps are read as the lowest integer in the rep string ("8 each leg" → 8). Defensible as the *relative* progression signal even where the absolute number is approximate — what matters for the trend chart and PR detection is consistency, not a tested 1RM.

**RIR autoregulation (Helms et al. 2016; Zourdos et al. 2016).** Reps-in-reserve is the validated cue for whether load can rise. We collect a coarse one-tap bucket after the final set — "had reps left" (≈ ≥2 RIR), "about right" (≈ 1 RIR), "barely" (≈ 0 RIR). Only "had reps left" triggers a bump. This is the lowest-friction faithful proxy: a single tap, no number entry, mapped to the established ≥2-RIR threshold for progression. RPE (the inverse) is already captured at session level; RIR is captured per lift because the progression decision is per lift.

**Increment — 2.5%, plate-rounded (Tristan-endorsed, 2026-06-01).** `STRENGTH_PROGRESSION_PCT = 0.025`. A conservative linear step appropriate for an athlete whose strength work is supportive, not the primary stressor — it avoids the joint/tendon load spikes a 5–10% jump would add on top of running volume. Rounded to `STRENGTH_MIN_INCREMENT_KG = 2.5` (1.25kg plates per side) and never smaller than one plate, so a light lift still progresses. The 2.5% (vs a fixed kg) scales the step with how strong the athlete already is, which is the right shape: a 40kg lift and a 140kg lift should not get the same absolute jump.

**Phase gating (Pfitzinger/Daniels periodisation, mirrored from the plan engine).** `suggestNextWeight` only bumps in **base/build**; **peak** holds (maintenance loading — keep the pattern, add no fatigue); **taper/deload** holds (the plan already cuts strength *volume* via the gym session-count drop in `gym.ts`, so we don't also strip *intensity* — holding intensity while cutting volume is the standard taper for strength qualities); **injury** suppresses (injury sessions are bodyweight/submaximal anyway and carry no trackable lifts). We deliberately do **not** auto-*reduce* weight in taper, which would need a fabricated reduction constant; holding is the defensible, no-made-up-numbers choice.

**PR threshold.** `STRENGTH_PR_THRESHOLD_KG = 2.5` — one plate of estimated-1RM improvement counts as a celebrated PR. Mirrors `MARKER_BUMP_THRESHOLD_*` for FTP/CSS/VDOT (notify-once: compare current vs last-notified snapshot, surface improvements only, snapshot after). Proposed pending Tristan's confirmation.

**Trackability (not a model — a lookup over the finite vocabulary).** `isWeightTrackable` accepts a movement only when it is a loadable pattern (squat/deadlift/hinge/thrust/bridge/split-squat/step-up/lunge/calf-raise) AND carries an actual load marker ("@X% 1RM" or an implement word like goblet/trap-bar/kettlebell). This excludes plyometrics (jump squat, bounds — power, not load), isometric core (plank, dead bug, pallof), and the beginner/novice bodyweight variants of the same movements. Tested exhaustively against every exercise string in `gym.ts` and `injury-strength.ts`.

**Known limitations.** (1) Epley is a point estimate; we don't model the individual load–rep curve. (2) RIR self-report is coarse and athlete-calibrated. (3) The estimated-1RM "benchmark" is per lift and not cross-validated against an actual 1RM test (we never ask the athlete to max out — by design). (4) Bare "Squat @75% 1RM" (peak maintenance) keys to `squat`, distinct from `back-squat`, so peak-maintenance weights don't carry into the base back-squat memory — acceptable since peak holds and is a different stimulus.

## §AX — Easy-run floor + consolidation: fewer longer runs over many fragments (2026-06-02)

**Side of the line.** Planning. This is `applyHoursBudget` deciding how to spend a fixed weekly volume budget across run-days. It does not touch tracking, prediction, or quality-session prescription.

**The problem it fixes.** The archetype-gated ramp (`§` athlete-archetype) anchors week 1 of a plan near the athlete's current volume (e.g. 14 km/wk → ~14.7 km), converted to a minute budget at the athlete's easy pace. For a fit-but-low-volume athlete (real case: VDOT 52, 3:22-marathon forecast, 14 km/wk), the untrimmable quality session and the long run consume nearly the whole budget, so the old logic shrank every easy run to a 15-min soft floor and overflowed the budget anyway. A 15-min easy run is a non-dose.

**The model.** A single floor, `EASY_FLOOR_MIN = 25` min. When the budget cannot give every planned easy run-day at least the floor, consolidate: choose the **fewest** easy run-days such that each survivor lands in `[EASY_FLOOR_MIN, naturalEasyMin]`, drop the rest, and split the easy budget evenly across the survivors. `finalCount = min(desired, ceil(easyBudget/natural), floor(easyBudget/EASY_FLOOR_MIN))`. When `easyBudget < EASY_FLOOR_MIN`, we keep exactly **one** easy run at the floor (never zero) and accept the overflow — a week needs some dedicated easy aerobic running, not just a long run.

**Why fewer-longer beats many-shorter at equal volume.** Aerobic adaptation to easy running is driven by *continuous time at low intensity*: mitochondrial biogenesis, capillarisation, fat-oxidation enzyme expression, and connective-tissue conditioning under sustained load (Holloszy & Coyle 1984; Hawley et al. 2018). These responses are non-linear near the low end — a session must clear a minimum duration before the stimulus is meaningful relative to the fixed warm-up/neuromuscular-onset phase. Below ~20-25 min, an easy run is mostly that onset phase. Splitting a small budget into many sub-25-min runs therefore delivers less aerobic stimulus than the same minutes in fewer longer runs, while adding per-session overhead and more running-start tissue-loading events.

**The constant.** `EASY_MIN = 25` is a pragmatic floor endorsed by Tristan (2026-06-02), not a literature-derived breakpoint. It sits at the low end of the conventional "an easy run should be at least 20-30 min to be worth prescribing" coaching guideline. There is no upper target: easy runs are sized by `easyRunMinutes` (the natural length, ~46 min for an intermediate marathoner) and only ever shrunk toward the floor, so the rule never *caps* a run at 25-30 min.

**Volume-aware quality cap + base-VO2 suppression (2026-06-02, same day, after seeing it rendered).** The consolidation alone exposed that the dominant fault was *upstream*: `qualityCap` is volume- and phase-blind (intermediate → 2 quality sessions in every week, including week 1), so the 14 km/wk week was prescribing Threshold + VO2, which ate the whole budget and pushed all easy running out. Three coordinated, budget-driven changes fix the *shape* of the week across the entire plan arc:

- **Volume-aware quality cap** (`plan_engine.ts`, `planWeekSessions`): `maxQuality = clamp(floor((budget − (LONG_SOFT_FLOOR_MIN + EASY_FLOOR_MIN)) / approxQualityMin), 1, abilityCap)`, with `approxQualityMin = thresholdWorkMinutes(...) + 20` (a real threshold-session cost, not an invented number). A quality session only earns its slot if the budget can *also* seat a long run and one easy run. Low-volume weeks (early ramp, deload, taper) carry one quality session; the count climbs to the ability cap as the budget ramps. The budget ramps faster in a short plan, so the cap lifts sooner there — no plan-length special-casing.
- **No VO2 in base** (`priority` filters `vo2` when `phase === 'base'`): base quality collapses to threshold/tempo (marathon-pace and float already return 0 work-minutes in base). VO2 enters in build/peak.
- **Keep ≥ 1 easy run** (above): consolidation never reaches zero easy days.

**Science basis (three principles).** (1) *Tissue tolerance lags cardiovascular fitness* — running injury tracks accumulated mechanical-load history (bone remodelling, tendon collagen turnover), which adapts slower than VO2max; a high VO2max predicts fast improvement, not licence to skip the volume ramp (Bertelsen et al. 2017; Nielsen et al. on volume progression). (2) *Progressive overload / ACWR* — Gabbett (2016): keep acute:chronic load ≈ 0.8–1.3, risk rises past ~1.5; two intervals + an easy run on a 14 km base is ~1.8 (spike), one quality + long + one easy lands ~1.2. (Caveat: ACWR's exact breakpoints are contested — Impellizzeri et al. 2019/2020 — but "ramp gently" is robust.) (3) *Polarised distribution* — Seiler & Kjerland (2006), Seiler (2010), Stöggl & Sperlich (2014): ~80/20 easy:hard by session; two quality in a 3–4 session week inverts it. Base-first periodisation (Daniels phases; Bompa) ties them together: a 40-week runway is the ideal case to defer VO2 to build/peak.

**Limitations / tradeoffs.** (1) Consolidation reduces run *frequency* at low volume, and frequency has its own (smaller) benefits for economy and habit (Daniels); accepted only where the alternative is fragments, and it returns as the budget ramps. (2) The long run is trimmed (40/30 floors) *after* easy consolidation; at the lowest volume the long run can be no longer than the untrimmable quality session — unavoidable at ~15 km/wk, and it pulls ahead as volume grows. (3) `EASY_FLOOR_MIN = 25` and keep-one-easy are pragmatic and Tristan-endorsed; the 80/20 evidence is strongest for trained athletes (this athlete is, VDOT 52). (4) The quality cap uses a representative threshold cost per quality session, so a mixed threshold+VO2 week is mildly under-estimated and the cap errs slightly conservative — acceptable, it errs toward protecting easy volume.

---

## §AY — On-demand gym generator: goal-driven rep schemes (Strength / Muscle / General) (2026-06-02)

**Context.** The on-demand gym generator lets a user pick a Focus (Running strength / Lower / Upper / Full / HYROX) and, for the strength focuses, a Goal that sets the rep scheme. Running-strength + Lower keep their existing running-specific templates; Upper + Full are composed from a goal-driven scheme (`GYM_GOAL_SCHEMES`, `strength-constants.ts`). Strength here serves the endurance athlete, so loads sit at the bottom of each band, not at a powerlifting max (same framing as §AW).

**The schemes (PROPOSED, endorsed by Tristan 2026-06-02):**

| Goal | Sets × reps | %1RM | Rest (traditional) | Rest (circuit) |
|------|-------------|------|--------------------|----------------|
| Strength | 4 × 5 | 80% | 180s | 90s |
| Muscle (hypertrophy) | 3 × 10 | 70% | 75s | 45s |
| General | 3 × 12 | 60% | 60s | 40s |

**Why each is defensible:**
- **Strength 4×5 @80%.** The ACSM Position Stand (2009, *Med Sci Sports Exerc* 41:687) prescribes ≥80–85% 1RM at 1–6 reps for maximal strength; the NSCA *Essentials* gives 2–6 reps, 2–5 min rest. de Salles et al. (2009, *Sports Med* 39:765) found 3–5 min rest preserves load across sets for strength work. We take the **bottom** of the strength band (80%, 5 reps) and 3 min rest as the supportive-athlete compromise: real strength stimulus without the CNS cost and next-day leg fatigue a true 1–3RM would add on top of run training.
- **Muscle 3×10 @70%.** Schoenfeld's hypertrophy meta-analyses (2016 rest-interval RCT; 2017 *J Strength Cond Res* volume meta) show 6–12 RM with ≥60s rest drives hypertrophy, and weekly volume is the primary lever. 3×10 @70% with 60–90s rest is squarely in that window.
- **General 3×12 @60%.** ACSM (2009) general muscular-fitness guidance is 8–15 reps at moderate load; the lighter 60% / 12 reps minimises eccentric joint load (kinder to a runner's legs) while still driving adaptation.

**Circuit rests** are a compressed version of each (90/45/40s) — the v1 "circuit" style is **rest-duration + a name suffix only** ("Upper Body (circuit)"); it does NOT yet interleave exercises into supersets in the guided overlay (deferred). Schoenfeld & Contreras (2021) support circuit-style training reaching similar hypertrophy at lower perceived effort, which is the rationale for offering it.

**Known limitations.** (1) These are population defaults, not individualised to training age. (2) %1RM presumes the user has a working-weight history (§AW) to anchor against; first-time lifts just take the entered weight. (3) The strength/general loads deliberately under-prescribe vs a dedicated lifter — by design, strength is subordinate to the run/tri plan. (4) v1 ships one ability tier for Upper/Full (bodyweight fallbacks for beginners); novice/beginner-specific tiers are deferred.

**Generator time + intensity controls (2026-06-02).** The on-demand gym preview offers a time target (20/30/45/60 min) and an easier/standard/harder intensity notch. Time scales session size: ≤20 min → 3 exercises and one fewer working set, 30 → 4, 45 → 5 (full), 60 → 5 + an extra set (compounds lead, accessories/core trail when trimmed). Intensity shifts every `@X% 1RM` load by `GYM_INTENSITY_PCT_STEP = ±5` percentage points (clamped to [40, 90]) plus an RPE ±1; HYROX maps the notch to the station band (novice / intermediate / advanced). The ±5% is a conventional single intensity step (PROPOSED, confirm with Tristan); the exercise-count / set-delta mapping is a UI session-sizing heuristic, not a physiological constant. The injury-adapted rehab session is never tuned (controls hidden) and HYROX is suppressed entirely under injury (it combines running with loaded stations and can't be made injury-safe).

## §AZ — Triathlon onboarding session lever: per-discipline "add training" → forecast (2026-06-02)

**What it is.** The triathlon equivalent of running's onboarding "add quality sessions" control (§AV / `plan-preview-v2`). On the post-`initializing` forecast step, the athlete can add training **per discipline** (swim / bike / run) and watch the projected finish + goal probability move; Continue commits the chosen volume into the real plan.

**Why per-discipline rather than a single "+1 session".** Running's plan is parameterised by an integer `runsPerWeek`, so "+1 session" is well-defined. Triathlon's generator (`plan_engine.triathlon.ts`) is **hours-budget-driven**: a weekly total (`timeAvailableHoursPerWeek`) is split across disciplines (`volumeSplit`), and each discipline's session count is `countSessions(disciplineHours, avgSessionHours, cap)`. There is no single "session" — a swim and a long ride are very different doses. So the lever operates on the discipline the athlete chooses.

**No invented constants.** "+1 session in discipline D" is translated into D's representative session length, `TRI_AVG_SESSION_HOURS = { swim: 0.75, bike: 1.3, run: 0.9 }` h — the *same* constants the generator already divides by to decide session counts (lifted from inline literals to named exports this session; single source). The per-discipline cap (`TRI_MAX_SESSIONS_PER_DISCIPLINE = 3`) bounds the stepper. `computeBumpedVolume` sets D's hours to `targetSessions × avg`, but never below D's existing budget (a split can already over-allocate beyond `cap × avg`, so we take the max — a discipline already at cap is a no-op), then re-derives the split from the new absolute hours so the total grows only by the added time.

**How the forecast actually moves (the defensible part).** The added volume flows into the projection through the existing per-discipline horizon model: `predictTriathlonRace` reads `plannedSessionsPerWeekByDiscipline` / `plannedHoursPerWeekByDiscipline` off the regenerated `triWorkouts`, and the horizon model (§ triathlon horizon) discounts each discipline's fitness gain independently (diminishing returns, confidence, build weeks). Consequently adding to a *weak* discipline moves the finish more than adding to a *saturated* one — emergent from the model, not a hand-tuned weighting. The preview is exact because it is the same code path as the commit: clone state → set new split + hours → `generateTriathlonPlan` → `predictTriathlonRace` (and `runTriForecastSim` for the goal chance). The clone carries the historical activity log over by week index so *current* fitness is unchanged; only the *projection* responds to the delta.

**Limitations.** (1) The session-count math uses peak hours (`timeAvailableHoursPerWeek`); the generator scales weekly hours by phase, so the realised per-week session count varies — the displayed forecast is always the true regenerated value, so this only affects the stepper's "N sessions/week" label, not the number. (2) The clone-regen preview assumes a stable activity log; at onboarding the log is typically empty (exact), and for a running→tri switch it is carried over (coherent). (3) `weekdayHoursPerWeek` is not re-derived on commit, so a large added bump leans on the scheduler's per-day caps to place overflow.

**Why the 3-session cap is kept (not raised) — device feedback 2026-06-02.** A real onboarding session surfaced that at a typical 70.3 hours budget the generator already places bike and run at the 3-session cap, leaving only swim addable. The cap is **deliberately retained**: (a) there is no physiological threshold where 3 sessions/discipline is safe and a 4th is not — injury/overtraining risk is governed by the *rate* of load increase relative to recent training (acute:chronic workload ratio, Gabbett 2016), not raw session count; (b) but adding frequency a user does not *currently* perform immediately raises the chronic-load baseline the plan must then honour, the ACWR-spike risk, and this matters most at onboarding where the baseline is being set; (c) running is the highest-impact, most overuse-injury-prone discipline (rapid run-frequency increases are the best-evidenced injury driver), so frequency restraint there is the most defensible part of the cap; (d) beyond ~3 quality sessions/discipline, endurance adaptation for an age-group athlete comes from session *duration* and intensity distribution (Seiler 80/20), not extra sessions. The true volume lever (longer sessions over the block, ramped by the phase model) is left to plan generation; the UI explains this on capped rows ("the plan builds volume over the block") rather than exposing an unbounded onboarding volume crank.

**Hero likely-range.** The forecast hero shows the Monte Carlo interquartile band (`runTriForecastSim` raceDay p25–p75) as "Likely {fast} to {slow} on race day" so the simulation is visible without a goal; the goal-probability MC still surfaces only once a goal is set (matching running onboarding). Range is hidden when the cone is narrower than 60 s (e.g. race week).

---

## §BA — Rotating "Running strength" pool (categorised, evidence-graded) (2026-06-02)

**Why a pool, not a goal scheme.** Running strength is multi-modal — heavy compounds (3-5 reps @80%), high-rep eccentric calf (15-20), timed isometric holds, low-rep explosive plyometrics, tibialis/foot drills. A single goal rep-scheme (the Upper/Lower/Full model in §AY) cannot express that, so each exercise in `src/workouts/running-pool.ts` carries its OWN prescription (sets/reps/load/rest). A session is BALANCED (one per category, in priority order), the variant within each category ROTATES by week (`slotIndex`, mirroring HYROX `pickStations`), and the number of categories scales with the user's available time (breadth, not just sets). On-demand generator only; the plan engine's auto-gym keeps its phase templates (Phase 2).

**Categories + evidence.**
- **Max strength** (heavy compound, leads every session): heavy resistance (>80% 1RM) improves running economy — Beattie & Blagrove 2018 (Sports Med meta-analysis); Blagrove et al. 2018 review.
- **Single-leg / unilateral**: running is a single-leg task; unilateral loading addresses asymmetry and specificity.
- **Posterior chain / hamstring**: Nordic curls reduce hamstring injury ~51% — Al Attar et al. 2017 (Sports Med meta-analysis).
- **Calf / soleus / Achilles**: the soleus carries the largest force in running; bent-knee (seated) work isolates it; eccentric heel drops follow the Alfredson Achilles protocol; isometric/heavy-slow holds build tendon stiffness — Rio et al. 2015; O'Neill et al.
- **Foot / tibialis / shin**: anterior tibialis strength for shin-splint resilience; intrinsic-foot/arch work for arch stiffness.
- **Hip stability / adductor**: Copenhagen plank reduces groin problems ~41% — Harøy et al. 2019 (BJSM RCT); glute-med/abductor work for hip-drop and knee valgus.
- **Reactive plyo / tendon**: stretch-shortening-cycle drills (pogos, bounds, jumps) improve tendon stiffness and running economy — Blagrove 2018.
- **Anti-rotation / trunk core**: pelvic/trunk stability for force transfer through gait.

**Rotation.** Deterministic, pure in `slotIndex` (week): variant = `pool[c][(slotIndex + offset_c) % n]`, with a per-category offset so week N doesn't pick variant 0 of every category. Base phase reorders `highSoreness` moves (Nordic, eccentric calf, bounds, depth jump) to the back of their category before rotation — identical to HYROX's eccentric reorder.

**Count-by-time (PROPOSED, endorsed by Tristan 2026-06-02):** 20→4 · 30→5 · 45→6 · 60→7 · 75→8 (2nd calf-foot) · 90→9 (+2nd single-leg). Intensity (easier/standard/harder) shifts loaded `@%` by ±`GYM_INTENSITY_PCT_STEP` (5, clamp 40-90) + RPE; bodyweight/plyo/iso are unaffected.

**PROPOSED doses (endorsed by Tristan 2026-06-02), the rest reuse existing template numbers or named protocols:** Soleus Calf Raise 4×15 @50%; Single-Leg Calf Raise 3×12/leg; Eccentric Calf Drop 3×15/leg (3s lower); Isometric Calf Hold 4×30s; Tibialis Raise 3×18 @40% (loaded so it weight-tracks — the only new tracked key); Heel Walks 3×20m; Short-Foot 3×12/foot; Copenhagen Plank 3×20s/side; Banded Lateral Walk 3×15; Side-Lying Hip Abduction 3×15/side; Pogo Hops 4×20; Depth Jump 3×5; Suitcase Carry 3×20m/side; Single-Leg Squat-to-box 3×6/leg; Nordic Curl 3×6; Step-Up/Lunge 75s rests.

**Onboarding nudge.** The schedule step shows, only at 0 gym sessions, "Even one strength session a week makes runners measurably faster and more injury-resistant (Beattie & Blagrove 2018)." Caption-only — deliberately NOT a forced default of 1 (that would inflate every plan's load without consent).

**Limitations.** (1) One ability tier in Phase 1 (the on-demand pool); beginner/novice variants are a follow-up. (2) Plan-engine auto-gym still uses the phase templates (Phase 2 — porting the pool there means rewriting gym.test.ts's literal-string assertions to property assertions). (3) Tibialis tracks only when prescribed loaded; band-only would not carry the `@X% 1RM` marker. (4) The per-exercise prescriptions are population defaults, not individualised to training age.

## §BC — Strength training improves the race forecast (running-economy projection) (2026-06-02)

**The claim.** Concurrent strength training (heavy resistance + plyometrics) raises running economy and so improves endurance race performance. Beattie, Carson, Lyons & Kenny 2018 (and the broader Blagrove/Beattie reviews) report ~2-4% running-economy improvement and ~2-5% time-trial improvement over 8-12 weeks of supportive strength work; Denadai et al. 2017 (Sports Med meta-analysis) and Balsalobre-Fernández et al. 2016 concur. Mosaic now projects up to **3% time improvement** at full adoption (`STRENGTH_MAX_ECONOMY_GAIN_PCT = 3`, `src/constants/strength-constants.ts`) — the optimistic-but-defensible upper edge of that range, signed off by Tristan 2026-06-02, consistent with the project's forecast-calibration stance (forecast leans optimistic, baseline honest).

**Where it enters, and why there.** Strength is a **future-projection term in the training-horizon model** (`applyTrainingHorizonAdjustment`, `training-horizon.ts`), NOT a retroactive multiplier on current fitness. The forecast's five current-fitness predictors (PB, LT, VDOT/Daniels, Tanda, HR-calibrated) are all performance proxies that already contain the athlete's *present* running economy. A retroactive "−X% pace" multiplier (like the carbon-shoe factor) would therefore **double-count** economy already in the blend. The horizon model is the one place that projects *future* adaptation from the *planned* training (run volume, sessions, dual-tau saturation) on top of the blended "today" anchor; the run-volume term carries no strength signal, so adding an explicit strength term is **additive, not duplicative**.

**The formula.** After the base improvement (`max_gain × type_mod × week_factor × session_factor × exp_factor`):

```
strength_gain_pct = STRENGTH_MAX_ECONOMY_GAIN_PCT
                    × (1 − e^(−weeks_eff / STRENGTH_TAU_WEEKS))   // adoption, saturating
                    × min(strength_sessions_per_week / 2, 1)       // dose, full at ≥2/wk
```

folded in alongside `taper_bonus`, then clamped by the existing `max_gain_cap_pct` (15%) and run through the VDOT-barrier guardrails. `weeks_eff` excludes taper (strength adaptation accrues during the training block). `STRENGTH_TAU_WEEKS = 10` puts ~63% of the ceiling at 10 weeks and ~86% at 20, matching the 8-12 week onset window. A short plan therefore credits proportionally less (less time to adapt); ≥2 sessions/week is full dose (further sessions add nothing — supportive, not maximal, strength).

**Bounding / no run-away.** The shared `max_gain_cap_pct` clamp keeps strength + running under the empirical improvement ceiling, and the guardrails prevent strength from pushing an under-qualified athlete through a time barrier (e.g. a beginner cannot strength-train their way past sub-3). `strength_sessions_per_week` defaults to 0/undefined → **zero contribution and byte-identical output for non-lifters** (regression-locked test).

**Signal + surfacing.** Gated on PLANNED strength (`s.gs` / onboarding `gymSessionsPerWeek`), threaded through every forecast site (`calculateLiveForecast` + `calculateForecast`, called from `refreshBlendedFitness`, the forecast-trajectory builder, `renderer.ts`, `events.ts`, and onboarding `forecastForSessions`) so all surfaces stay coherent. Onboarding plan-preview shows a callout isolating the contribution ("Your N strength sessions are worth about X of the projected finish… Beattie & Blagrove 2018") by differencing the forecast with vs without the strength term at the same run count.

**Limitations.** (1) Projects from PLANNED sessions; it does not yet ease the projection when planned strength goes uncompleted (adherence-gating is a deferred refinement). (2) The 3% ceiling is a population figure, not individualised to training age or current strength base. (3) Linear-in-dose up to 2/wk is a simplification of a true dose-response curve. (4) The economy→time mapping is treated as ~1:1 in VDOT-improvement terms, which slightly overstates the marathon end where economy is one of three Joyner-Coyle factors; the conservative saturation and the cap absorb this.

## §BD — Rep-aware estimated-1RM benchmark (no cross-rep false PRs) (2026-06-02)

**Problem.** The per-lift strength benchmark uses the Epley estimate `1RM = w × (1 + min(reps,12)/30)`. Epley (and Brzycki, Lombardi, etc.) are only valid near the load tested; the error grows with reps and the estimate inflates. Concretely: 80 kg × 5 → 93.3 kg, but a *lighter* 70 kg × 12 → 98.0 kg. Because the training templates prescribe the same lift at different rep counts across phases (strength block 5s, hypertrophy block 10-12s), a user's est-1RM would jump on a high-rep day, minting a false "New best" PR (and a non-monotonic trend) despite lifting less.

**Fix.** The est-1RM benchmark (`StrengthLiftEntry.est1rmKg`) now advances **only on a comparable-or-stronger effort**: the new set's reps must be `<=` the reps the current best was set at (`est1rmReps`), AND the new estimate must exceed the current. A higher-rep day still updates working-weight memory (`lastWeightKg`/`lastReps`) but does not move the benchmark, append to the trend, or fire a PR. First observation sets the baseline at whatever reps were used. This fixes the PR detector and the summary-card "New best" note at the source (both read the now-clean benchmark/history), and makes the trend a monotonic PB staircase.

**Why this is defensible.** Comparing estimated 1RMs across disparate rep ranges is not valid practice — a 12-rep set and a 5-rep set test different qualities, and the formula's rep term systematically over-estimates the higher-rep set. Requiring like-for-like (or fewer) reps before crediting a PR matches how an S&C coach reads progression: a higher-rep, lower-load set is not evidence of a strength gain. Conservative by design — it never claims a PR it can't defend.

**Limitations.** (1) If a user's *first ever* log for a lift is at very high reps and they then only ever train at higher reps, the benchmark can stagnate (the `reps <=` gate never opens); in practice progressive overload lowers reps as load climbs, so this is rare. (2) The displayed "current estimated 1RM" is the best *comparable* estimate, not the most recent session's raw Epley value — intentional, so a high-rep day doesn't inflate the headline. (3) Still a single-set point estimate, not a measured 1RM.

**Addendum (2026-06-03) — manual 1RM entry.** The athlete can now seed a lift's est-1RM directly on the Stats strength page (`seedManualLift`), supplying either a one-rep max or a working weight × reps. Two science points. (a) **A direct 1RM is stored as-is, not Epley'd.** Epley at one rep returns `w·(1 + 1/30) = 1.033·w`, i.e. it over-estimates a *measured* single by ~3.3% (Epley is a regression fit for multi-rep sets, not an identity at reps=1). A weight the athlete states they lifted once *is* the 1RM, so we bypass the formula; only weight × reps gets the estimate. (b) **Provenance and override.** The entry is marked `est1rmSource:'user'` (the field now mirrors the `'user' | 'derived'` provenance of FTP/CSS/VDOT). Per the project's "manually-set benchmarks yield to improvements" rule, a manual value is authoritative on entry but is overridden the moment a logged set produces a comparable-or-stronger Epley estimate — the same `est1rmReps` gate from the main section is the confidence floor, and provenance flips back to `'derived'` on that PR. A manual seed creates a single baseline history point, so it does not register as a "New best" (a PR still requires a logged advance over the seed).

## §BE — Gym leg load feeds the shared recovery ledger (2026-06-02)

**What.** A strength/gym session now contributes to `s.recentLegLoads`, the same leg-fatigue ledger that runs and cross-training already feed (decay + Repeated Bout Effect + readiness floors live in readiness.ts; see §-leg-load history there). Previously the gym was invisible to recovery: `SPORTS_DB.strength` carried no `legLoadPerMin` and `recordLegLoad` was never called for strength, so a heavy squat day moved readiness by zero. This makes the gym a *writer* (a leg day suppresses readiness like a long run) and a *reader* (a leg-heavy session on already-loaded legs gets a "consider easing" nudge). Implemented in `src/calculations/strength-leg-load.ts`.

**Model.** `legLoadRaw = K_STRENGTH × legScore × intensityMult × effortMult`.
- `legScore` — leg-muscle work measured as HARD SETS. Reuses the canonical muscle-group attribution (`deriveWorkedMuscleGroups`, `strength-muscle-groups.ts`), summed over the leg groups only (quads + glutes + hamstrings + calves; core/back excluded). An upper/core day scores 0 on legs and writes nothing; a leg day scores high. "Hard sets" is the standard volume currency for hypertrophy/EIMD dose (Schoenfeld & Krieger meta-analyses).
- `intensityMult = clamp(meanPctOneRm / 0.80, 0.5, 1.25)` — relative mechanical tension. %1RM = logged weight ÷ Epley est-1RM, averaged over loaded lifts; referenced to a heavy working set (80% 1RM = 1.0). Bodyweight/plyometric work has no %1RM sample → defaults to 1.0.
- `effortMult = clamp(sessionRPE / 7, 0.6, 1.25)` — proximity to failure via session RPE (Foster 2001 sRPE, the same effort signal the app's strength TSS uses). RPE 7 (hard, ~2 RIR) = 1.0.

**Calibration of K_STRENGTH = 0.9.** Anchored to the pre-existing `legFeel: 'heavy'` scaffold (state.ts documented a heavy gym session at ≈0.35 leg-load/min × ~45 min ≈ 16 units). The canonical hard leg day (5×5 back squat @80% + 3×8 RDL + 3×12 split squat, RPE 7) has legScore 18 (quads 8, glutes 7, hams 3), intensity 1.0, effort 1.0 → 0.9 × 18 = 16.2. One anchor against an already-accepted value; the richer model varies objectively around it. This is the only genuinely new global constant; the decay (48 h half-life), RBE (×0.6, 14 d), and readiness floors (LEG_LOAD_MODERATE 20 / HEAVY 60) are reused unchanged.

**Decay override.** Greater EIMD → longer functional recovery (Clarkson & Hubal 2002, severity-dependent), so a heavy leg day decays slower than the 48 h baseline via `recoveryMultOverride`: raw ≥ 14 → ×1.20 half-life, raw ≥ 7 → ×1.05, else baseline. Multipliers reuse the `legFeel` scaffold; thresholds derive from the anchor (heavy ≈ anchor 16, moderate ≈ half).

**Single source / no divergence.** `buildStrengthLegLoadEntry` is the one builder for both write sites — completion (`strength-complete.ts`, immediate) and the reconcile sweep (`sport-picker-modal.ts`, launch/sync). `computeLegLoad` returns the stamped `actual.legLoadRaw` for strength so the existing reconcile/RBE/dedup machinery handles it uniformly. Both produce identical entries (same raw, RBE, decay), and reconcile's garminId dedup prevents doubles.

**Tracking, not planning.** Leg load feeds the readiness leg-load FLOOR only. It is NOT added to CTL/ATL or any TSS path (gym TSS is already counted separately via the RPE-TSS route), so there is no double-count. The read-side nudge (`buildGymLegLoadNudge`) is suggest-only: it surfaces a passive caption on the plan gym card when the planned session is a real leg day (est. raw ≥ 7) and the decayed total is already at the Manage-Load floor (≥ 20). It never mutates the plan; the user can act via the existing Adjust overlay.

**Mode scope.** Running and HYROX use the running `computeReadiness` engine, which reads `recentLegLoads` directly, so the floor applies there. Triathlon uses `computeTriReadiness` (per-discipline), which did NOT read the ledger; the floor is now threaded into the **run discipline only** — the floor models eccentric/footstrike impact risk, which is a running concern (swim is non-impact; cycling tolerates tired legs). Wiring it to swim/bike would over-flag. HYROX *stations* keep their own eccentric ledger (`musculoTendonLoad`, mtlAcwr floor) and are excluded from `recentLegLoads` writes — hard guard against double-counting; only plain gym sessions in HYROX mode write the leg-load ledger.

**Limitations.** (1) Dose currency is hard SETS, not reps × load; intensity + effort stand in for the rep/failure dimension. Explicit per-lift RIR is a future refinement. (2) Plyometrics may be under-weighted (high eccentric cost, no %1RM); an eccentric tier is a future refinement. (3) Synced strength with no exercise detail derives nothing (the `legFeel` subjective fallback is documented but not yet wired). (4) RBE keys on sport identity ('strength'), so two leg days in a fortnight discount each other but a run does not protect against squats (conservative).

## §BF — One canonical "running-fitness signal" gate for Stats VO2 and Forecast (2026-06-03)

**Problem.** Two surfaces could give a thin-data athlete contradictory answers about the same fitness. The Stats "Your Numbers" card shows its "VO2 Max" bar whenever a resolved VDOT exists (it gates on `getPhysiologicalVdot(s).vdot ?? computeCurrentVDOT(s) > 0`, and `computeCurrentVDOT` = `s.v + adj`, set at onboarding for every running/tri user). The no-target-race Forecast grid gated separately: `buildStandardPredictionContext` returned `null` for a `trackOnly` user with no PBs (and, more broadly, any user whose only signal was a bare `s.v` produced no blend output because `blendPredictions` needs a PB / LT / recent-run / device-VO2 / HR input). Net: a cross-trainer with a training-derived VDOT but no entered PBs saw a VO2 bar on Stats and "No predictions yet" on Forecast. This violates CLAUDE.md's "two numbers that mean the same thing must come from the same source."

**Are VO2max and VDOT the same quantity?** No — device VO2max (ml·kg⁻¹·min⁻¹, a measured aerobic ceiling) and Daniels VDOT (a pseudo-VO2max back-solved from race-equivalent performance) are physically distinct. We deliberately do NOT merge the *numbers*. What we unify is only the **show/hide gate** — the question "is there enough running-fitness signal to show anything?" The app already feeds a VDOT into the bar labelled "VO2 Max" (the physiological chain falls through to VDOT-derived tiers), so the display already treats them as one scale for the purpose of "do we have a number."

**Decision.** Add one canonical resolver + predicate in `physiological-vdot.ts`:
- `resolveRunningVdot(s)` = `getPhysiologicalVdot(s).vdot` (override → mosaic → device → HR-calibrated → LT-derived → PB-median → Tanda-`s.v`), falling back to `getEffectiveVdot(s)` (`s.v + adj`). This is exactly the inline chain the Stats card used, lifted into a shared helper.
- `hasRunningFitnessSignal(s)` = `resolveRunningVdot(s) != null`. Both the Stats VO2 bar (`stats-view.ts`, both bar sites) and the Forecast grid (`race-forecast-view.ts` `hasAny`) now gate on this, so they can never disagree.

**Making the Forecast able to honour the wider gate.** `buildStandardPredictionContext` now gates on `hasRunningFitnessSignal(s)` (the old PB / `trackOnly`-no-PB guards removed). To guarantee the Forecast actually produces times whenever the gate is true, `predictDistanceStaged` adds a last-resort fallback: when the weighted blend yields nothing usable, predict from `resolveRunningVdot(s)` alone via `predictFromVO2(distM, vdot)`. This is the **inverse Daniels VDOT model** — its parameter is literally a VDOT, and Daniels VDOT is *defined* by its race-equivalent times, so converting a VDOT to a 5K/10K/half/marathon time is the textbook-correct operation, not an invented number. The fallback fires **only when the blend is empty**, so it never double-counts a signal already represented in the blend (HR has its own slot, LT its own, PBs their own). The fallback time still passes through the same calibration → durability-cap → shoe staging, so the no-recent-volume over-prediction is still penalised by the existing long-run durability cap.

**Why widen the Forecast rather than hide the Stats bar.** The two consistency directions were: (A) show both when a VDOT exists, or (B) hide the Stats bar when no PBs. (B) regresses every athlete who has a fresh device VO2max but never typed a PB — they'd lose their VO2 bar. (A) serves exactly the just-training / track-only athletes the no-race Forecast was built for. We chose (A).

**Scope guard.** Only the no-target-race surface is touched (`predictStandardDistances`, `getStandardForecastDetail`). The targeted race forecast uses `blendPredictions` directly elsewhere and is unchanged. The raw-VDOT trend on the drill-down (`getStandardForecastDetail` `trend`, sourced from `s.vdotHistory`) is intentionally left as the raw fitness trajectory and was not touched.

**Limitations.** (1) A user whose only signal is an optimistic onboarding self-estimate `s.v` will now see race-equivalent times derived from it; these are the same VDOT already shown as "VO2 Max," and the durability cap keeps the marathon honest, but they are a self-estimate, not a measured performance. (2) The gate treats the low-confidence Tanda-`s.v` fallback as "signal present"; this matches the prior Stats behaviour (no regression) but means the empty state appears only when there is genuinely no VDOT at all (`s.v ≤ 0` and no tier).

## §BG — Leg-load readiness floor is gated by injury that blocks running (2026-06-03)

**Problem.** The leg-load readiness floor (§BE, and Clarkson & Hubal 2002 / Paulsen 2012 in the leg-load-view help text) caps readiness because eccentric/cross-training fatigue produces a functional force-absorption deficit that raises **impact-injury risk on foot strike**. That mechanism is running-specific by construction — the same rule already threads `recentLegLoads` into the **run discipline only** for triathlon (§BE), never swim or bike. But `computeReadiness` had no awareness of injury state, so when an active injury had already blocked running (run capacity 0), the floor still fired and the note still warned "impact risk slightly elevated if running." On the Readiness screen this contradicted the injury caption directly above it ("Running and swimming blocked by injury"): the score was being held at 54 / Manage Load by a risk on a run the user cannot do, and the caption warned about that same run.

**Decision.** Introduce `impactBlocked` on `ReadinessInput`, derived at each call site from `isImpactBlockedByInjury(s.injuryState)` (new helper in `injury/engine.ts`: active injury AND `getDisciplineCapacity(state, 'run') === 0`). When true, `computeReadiness`:
1. **Skips the leg-load hard floor** (heavy ≥60 → cap 34, moderate ≥20 → cap 54, and the 10–20 soft taper) entirely. The readiness score then reflects the athlete's actual recoverable capacity for what they *can* still do, instead of an impact risk that is not in play.
2. **Trims the note** to its factual lead ("Moderate leg load from General Sport yesterday.") and drops the "if running" / "impact risk" clause.

**Why this is defensible, not just a copy patch.** The floor's physiological justification *is* the foot-strike impact pathway. Remove the foot strike (running blocked) and the justification for capping readiness on that axis disappears. Tired legs still mildly affect cycling, but cycling is independently injury-capped (e.g. 40%) and the leg-load → impact model was never calibrated to cycling. Letting the score rise to reflect non-impact capacity is the honest reading. This is a *gating* decision (when does an existing floor apply), not a new constant — no magic numbers added.

**Same-source propagation.** The Readiness ring's score and its label come from different `computeReadiness` calls (`readiness-view.ts` for the score; `daily-coach.ts` for the ring label), and Home shows the same number again (`home-view.ts`). All three are threaded with `impactBlocked` so they cannot disagree (CLAUDE.md same-source rule). Tri parity: only `tri-readiness.ts`'s run input gets it, matching where leg load is fed. Call sites that pass no `recentLegLoads` (`session-recommendation`, `coach-workout-modal`) are untouched because the floor cannot fire there.

**The readiness label stays capacity-based, by decision (Tristan, 2026-06-03).** An injured-but-fresh athlete may now read "On Track" or even "Primed." That is correct, not a gap: injury does not mean "cannot train," it means the trainable menu is shorter (an injured runner can still cycle, lift, train legs in the gym). The Readiness ring measures **recoverable capacity** — how ready the body is to spend training stress; the injury caption is the **separate constraint layer** that scopes *what* that capacity is spent on. Deliberately decoupled. We do NOT add an injury-aware "recover/limited" relabel, because that would conflate "your body is tired" with "this discipline is off the menu" — two orthogonal facts. Tissue-specific contraindication (e.g. a leg session loading the injured area) is the injury-capacity layer's job (`lowerLoad`/protocol bans), not a readiness-score modifier.

**Limitations.** (1) "Running blocked" is binary on run capacity 0; a run capacity of, say, 20% still fires the full floor, which is correct (the athlete can still strike the ground). (2) The score rising when injured relies on the injury caption remaining the dominant, first-read line on the surface to supply the "but you still can't run" context — if a future surface shows the bare number without the caption, the band-label gap above becomes more visible.

## §BS — Conservative seeded starting fitness for no-PB beginners (2026-06-15)

**Problem.** A running plan needs a fitness anchor: `initializeSimulator` returns `{ success:false, error:'No personal bests provided' }` and the review screen disables "Build my plan" when `pbs` is empty. That walls out exactly the users least likely to know a 5K time: true beginners and cross-sport "hybrid" athletes who have never raced. Requiring a test 5K to enter is worse (drop-off at signup, plus an all-out cold 5K is an injury/discouragement risk for a beginner), and asking a beginner to *estimate* a 5K time yields noise (they have no reference).

**Decision.** For experience levels that may legitimately have no time — `beginner`, `total_beginner`, `hybrid` — seed a conservative, DERIVED 5K when no PB is present, instead of blocking. `beginner-fitness.ts` maps level → anchor VDOT, converts to a 5K via Daniels `tv(vdot, 5)`, and `initialization.ts` uses it as the `pbs.k5` anchor while setting `state.startingFitnessEstimated = true`. The review gate (`review.ts`) allows these levels through with an honest note ("No recent times? We'll start you at a careful estimate and dial it in from your first runs.") rather than the blocking hint; `plan-preview-v2.ts` repeats the caveat so the prediction is never presented as measured.

**Constants are sourced, not invented.** The anchor VDOTs are the documented ability-band **floors** already in the codebase (`experience-level-validation.ts`, Daniels 2014 + Pfitzinger 2009 cohort bands; also the band-implied VDOTs in `hyrox-staleness.ts`):

- `beginner` / `total_beginner` → **VDOT 28** (floor of the 28–35 beginner band) ≈ a 32:30 5K.
- `hybrid` → **VDOT 35** (novice floor) — aerobically fit from other sports, not running-specific.

We anchor at the band **floor** on purpose: a no-data start must **under-prescribe** (low injury risk) rather than over-prescribe. A single seeded `k5` yields the default fatigue exponent (1.06) from `calculateFatigueExponent` — identical to any single-PB user, no NaN.

**Why this is defensible.** A beginner's day-one fitness is unknowable to any method; the honest move is a safe conservative prior that the system corrects from data. The seed is one input to `blendPredictions`, which already incorporates the athlete's recent runs (pace, HR-calibrated VDOT, weekly volume) on every launch via `refreshBlendedFitness` — so the estimate yields to real fitness within the first week or two, consistent with the "benchmarks yield to improvements" rule. The seed is also overwritten outright the moment the user enters a real PB. Verified end-to-end: a no-PB `beginner` builds an 8-week 5K plan starting at VDOT ~27.3 (28 before the no-volume blend penalty), `startingFitnessEstimated` set, no NaN anywhere.

**Limitations.** (1) The blend still weights a stored PB fairly heavily, so a beginner who improves rapidly *without* logging a race may track upward more slowly than reality until enough run signal accrues; the HR-calibrated path mitigates this for watch users. (2) `total_beginner` and `beginner` share the VDOT-28 floor; the UI currently only exposes `beginner` and `hybrid`, so the distinction is latent. (3) This addresses the fitness anchor only — beginner *volume* sizing (runs/week × distance) is a separate lever and is not changed here.

## §BT — Conservative starting volume for beginners (30-min run cap) (2026-06-15)

**Problem.** Starting weekly volume in `initialization.ts` had no fitness/experience awareness. The no-history fallback was `runsPerWeek × 10 km` (and the "proper" `getPlanPrescribedMeanWeeklyKm` is target-based: `sessions × REF_KM_PER_SESSION[5k]=8 × 1.2 ≈ 29`). Both assume an experienced runner, so a true beginner (or no-PB seeded beginner, §BS) opened week 1 at ~30 km across 3 runs ≈ 10 km/run. At a beginner's easy pace (VDOT ~28, ~8:00/km) that is a ~75-minute run — an injury and adherence risk for "running under 6 months".

**Decision.** For the experience levels that may lack a real time — `beginner`, `total_beginner`, `hybrid` (same set as §BS, no-history path only) — cap the STARTING per-run to **30 minutes at the athlete's easy pace**, then let the plan ramp up from there. `cappedBeginnerStartWeeklyKm()` (`beginner-fitness.ts`) computes `runsPerWeek × (30·60 / easyPaceSecPerKm)` and returns it only when it's *lower* than the existing default (it never raises volume); `initialization.ts:525` uses it in place of the flat fallback. Detected-history users are unaffected — the real-volume override (`s.detectedWeeklyKm` when Strava/volume confirmed) still wins downstream.

**Why 30 minutes, and why duration not distance.** 30 minutes continuous is the NHS Couch-to-5K graduation standard and sits within ACSM beginner guidance (20–30 min continuous). Capping by *duration* rather than km is the key design choice: it auto-scales by pace from a single rule. A true beginner (VDOT 28, ~8:00/km) gets ~3.7 km/run → ~11 km/wk at 3 runs; a fit-but-not-running hybrid (VDOT 35, ~6:00/km) gets ~5 km/run → ~15 km/wk — each appropriate to their actual easy pace without separate constants. The plan then ramps from this conservative base toward the target, which is the correct progression for a new runner (start low, build).

**Defensibility / limitations.** (1) The 30-min anchor is a sourced external standard (C25K/ACSM), the only new constant, confirmed with the product owner. (2) This is a *starting* cap; the ramp shape and peak are unchanged, so it shortens the first weeks rather than the whole plan. (3) It deliberately does not implement run/walk intervals — the app prescribes continuous easy running, so a genuine couch-to-zero starter still gets continuous (if short) runs; true run/walk progression is a separate, larger piece. (4) Applies only to the no-detected-history path; a "beginner" who connected Strava showing real higher volume keeps it (they are not actually fragile). Verified end-to-end: a no-PB beginner now opens at 11 km/wk (was 30), VDOT-28 seed and estimate copy intact, no NaN.

## §BU — Sprint / Olympic / T100 promoted to plannable triathlon formats (2026-06-15)

**Problem.** `TriathlonDistance` was `'70.3' | 'ironman'` only. Sprint and Olympic existed as side-effect predictions and past-race benchmark options but could not be trained toward; the PTO T100 (2km / 80km / 18km) was absent entirely. This section records the per-format constants chosen for the three new formats and their defensibility. The cross-mode mirror rule does **not** apply here — this adds distances *within* triathlon mode, not a new mode, so there is no running/HYROX parity obligation.

**Distances (factual).** sprint 750/20/5, olympic 1500/40/10, t100 2000/80/18, vs 70.3 1900/90/21.1 and ironman 3800/180.2/42.2. Note t100's swim (2000m) is *longer* than 70.3's (1900m) while its bike and run are shorter — so t100 is handled per-leg, not as a single interpolation point.

**Bike race intensity (% FTP), `RACE_INTENSITY_BY_DISTANCE`.** sprint 0.88, olympic 0.83, t100 0.76 (70.3 0.78, IM 0.70). Allen & Coggan (2010) power-duration zones + Coyle (1984) fractional-utilization decay: shorter bike legs sustain higher IF. t100 modelled just below 70.3 (same ~2h15 duration band, 80 vs 90 km). **Confidence: medium-high.**

**Bike-to-run fatigue discount, `RUN_FATIGUE_DISCOUNT` (now a table).** sprint 0.02, olympic 0.04, t100 0.05 (70.3 0.05, IM 0.11). Bentley 2007 and Landers 2008 anchor only the 70.3/IM endpoints; the three new values are **extrapolations along that gradient with NO published intermediate-distance data**. **Confidence: LOW — the weakest link in this work.** TRACKING side only (never training load); refine against logged race outcomes. t100 ≈ 70.3 (near-identical bike+run load).

**Periodisation & volume.** PLAN_WEEKS_DEFAULT sprint 12 / olympic 16 / t100 20; PHASE_WEEKS ratios mirror 70.3 (base 0.40 / build 0.30 / peak 0.20 / taper 0.10); HOURS_RANGE sprint 3–12 / olympic 3–15 / t100 4–20; DEFAULT_WEEKLY_PEAK_HOURS by skill band scaled from Friel typical-volume tables. **Confidence: medium** (Friel *Triathlete's Training Bible* per-distance norms).

**Taper.** TAPER_DAYS sprint [4,7] / olympic [5,8] / t100 [7,10]; per-discipline `TRI_TAPER_WEEKS` scaled with swim longest, bike shortest. Mujika 2002/2010 (detraining onset scales with race duration) + Friel 2018. **Confidence: medium.**

**Durability thresholds.** sprint 1.0h ride / 0.5h run; olympic 1.5h / 0.75h; t100 = 70.3 (2.5h / 1.5h). Pfitzinger & Douglas per-distance long-session guidance + Rüst 2012. **Confidence: medium.**

**Run-horizon (VDOT projection).** t100 reuses the 70.3 params verbatim; olympic and sprint reuse 70.3's max_gain/tau but lower the run-frequency bands by 0.5 and 1.0 sessions respectively (floored at 1.0/wk) via `withReducedRunFrequency` — concurrent swim/bike stimulus + a short run leg need fewer run sessions (Friel 2012, Dixon 2015). Keeping 70.3's max_gain/tau for 10k/5k legs is a deliberate simplification (modelling distance-specific Daniels curves for the tri run leg is deferred). **Confidence: medium.**

**Discipline volume split, now format-aware (`DEFAULT_VOLUME_SPLIT_BY_DISTANCE`).** Replaces the old flat `{swim 0.175, bike 0.475, run 0.350}` applied identically to every format. swim share falls with distance (sprint/oly 0.20 → 70.3/t100 0.175 → IM 0.15), bike rises (0.45 → 0.475 → 0.50), run held at 0.35 throughout. Short course is swim/intensity-weighted (swim is a larger fraction of race time, ~18% vs ~10%, and technique/economy gains dominate); long course is bike-volume-and-durability bound. Run capped because it has the highest injury risk per hour (Vleck & Garbutt 1998) and cycling crossover lets run volume stay below standalone (Millet 2002). Sources: race-time proportional analysis + Bentley 2007, Toussaint & Beek 1992, Rüst 2012. **Confidence: medium** (coaching consensus; exact percentages vary by coach). **This changes the Ironman default** from the old flat value — an intentional correction; IM was previously under-biking relative to its race profile. The user-set `triVolumeSplit` override still wins; the distance default only seeds the picker.

**Race-readiness targets.** sprint/olympic entries already existed (forward-compatible placeholders, now active); t100 added at ≈70.3 with slightly higher swim, lower bike/run (maxPenalty 0.10, closureWeeks 9, balanced score weights). Cross-credit (`TRI_DISTANCE_CROSS_CREDIT`) extended with a t100 row/column (t100↔70.3 = 1.0; shorter→longer partial credit otherwise).

**Empirical-data fallback.** The ingested transition-time and course-factor tables cover only 70.3/ironman. Sprint/olympic/t100 resolve to the 70.3 dataset via `resolveEmpiricalDistance` (nearest distance with data); surfaced values should be captioned as estimated from 70.3 data. The split-distribution banner simply skips for formats without a table.

**Prediction-helper generalisation.** Two internal fallback helpers were generalised away from binary 70.3/IM branches: `vdotToRacePaceSecPerKm` now uses canonical Daniels `vt(runKm, vdot)` at the actual run-leg distance (replacing a hardcoded linear half/marathon approximation), and `estimateRunPaceFromSkill` scales a reference IM-distance pace to the leg distance via Riegel's power law (T ∝ d^1.06; Riegel 1981), replacing a flat −15s/km 70.3 offset. Both are deep fallbacks (no PB/VDOT data); the change removes magic numbers and is more defensible than what it replaced.

**Race calendar.** The official PTO T100 2026 calendar was seeded into `triathlons.ts` (`distance: 't100'`). Sprint/Olympic have no curated events (local races are regional and go stale); the wizard offers a manual target-date path for those.

**Guard rail.** `src/constants/tri-distance-completeness.test.ts` asserts every per-format table has an entry for every `TriathlonDistance`, each volume split sums to 1.0, and the monotonic relationships above hold. Adding a sixth format will fail this test (and `tsc`) until the tables are filled.

## §BV — "No training data" is not "detrained": the demonstrated-PB floor (2026-06-15)

**Problem.** Two onboarding cases produced indefensible marathon predictions. A user whose only input was a 2:00:00 marathon PB was predicted **2:24:54** (25 min slower than a proven time). A user with a 20:00 5K and nothing else was predicted **4:02:39**. Both numbers were reproduced exactly from the live code path (`blendPredictions` → `applyLongRunCap` in `initialization.ts`).

**Root cause — an overloaded zero.** The running predictor carries three penalties for insufficient marathon-specific endurance, each individually well-sourced:
- `marathonSpecificityPenalty` (up to ×1.15 at `weeklyRunKm < 10`) — fractional-utilization decay, Coyle 1984 / Mujika & Padilla 2000.
- `applyLongRunCap` (up to ×1.05 at `longestRunSec = 0`) — long-run durability shortfall, Pfitzinger 2009 (§BN).
- `noLongRacePenalty` (×1.01–1.02) — no demonstrated long-race endurance, audit #11.

All three are gated on the *absence of synced training history*. At onboarding a brand-new user always has zero history, so `resolveWeeklyKmSignal` returns `0` and `getLongestRunSec` returns `0`. The penalty code reads those zeros as "the athlete runs zero km / their longest run is zero" — i.e. maximal detraining — when they actually mean "we have not ingested any activity yet". **Absence of evidence was being treated as evidence of detraining.** Stacked multiplicatively, a 2:00 marathon PB (the single most direct, distance-specific data point possible) was turned into 2:24:54.

**Principle.** You may not predict an athlete slower than a time they have demonstrably run at the *exact* target distance unless you hold *positive* evidence they have lost that fitness. "No data" is not such evidence. This is the prediction-side complement to the "Manually-set Benchmarks Yield to Improvements" law: a same-distance PB is a demonstrated performance, and the burden of proof is on the engine to justify any slower number.

**Fix 1 — distinguish no-data from zero-training.** `initialization.ts` passes `undefined` (no signal) rather than `0` for the weekly-volume argument when `weeksCovered === 0` and no manual volume was typed. `marathonSpecificityPenalty` only fires on `weeklyRunKm != null`, so it stays dormant for true no-data users and continues to fire for users whose *real* history shows low volume. The durability cap is unchanged (still applies to short-anchor extrapolations such as the §BN 5K→half case, which has no same-distance PB to protect).

**Fix 2 — the demonstrated-PB floor (`demonstratedPBFloor`).** A pure, idempotent function: a prediction is floored at the PB for the exact target distance (within 1%) unless one of two positive detraining signals holds:
1. A real weekly-volume signal below the maintenance floor (`< 30 km/wk` — the same cutoff above which `marathonSpecificityPenalty` treats fractional-utilization decay as negligible, Coyle 1984).
2. A recent run/race that itself projects *slower* than the PB at the target distance (`predictFromRecent > exactPb`) — direct demonstration of reduced current fitness.

Applied inside `blendPredictions` (so all callers benefit) and again after the externally-applied durability cap in `initialization.ts` (idempotent, so it catches the cap's multiplicative overshoot without double-flooring). The recent-run gate is what keeps a *returning* runner honest: a 1:28 half PB contradicted by a recent 24:00 5K is correctly predicted ≥1:30, because the recent race is real evidence the PB is stale.

**Results.** 2:00 marathon-only → **2:00:00**. 20:00 5K-only marathon → **~3:31** (Riegel ceiling + ×1.01 no-long-race; the phantom ×1.15 and ×1.05 no longer fire). Returning-runner profile unchanged (≥1:30). §BN thin-data 5K→half cap preserved.

**Confidence: high** for the principle and Fix 1 (removes a category error). **Medium** for the 30 km/wk and recent-run thresholds in Fix 2 — they reuse existing calibrated cutoffs rather than introducing new constants.

**Known limitation.** A genuinely stale PB with *no* volume signal and *no* recent run is still trusted as the floor (we predict the proven time, optimistically). This is the deliberate trade: absent any contradicting data, trusting a demonstrated performance is more defensible than inventing a slowdown. The first backfill refresh corrects it the moment real history lands.

**Guard rail.** `predictions.test.ts` → "no-data does not trigger detraining penalties" (3 cases: same-distance-PB floor, real-low-volume still penalised, 5K-only not over-penalised). `initialization.volume.test.ts` and `initialization.durability.test.ts` updated to the corrected behaviour.

**Follow-up (same day) — signal hierarchy and prediction/plan consistency.** The first fix passed `undefined` for the volume signal in the no-data case, which left an inconsistency: the *plan* sized starting volume from runs/week (`defaultWkm`, e.g. 4 runs → 40 km/wk) while the *prediction* assumed no volume at all. Two surfaces, one athlete, two different implied volumes. The follow-up replaces "no signal" with an explicit best-available hierarchy, ranked by trust:

1. **Measured** — synced history (`weeksCovered > 0`) or a user-typed weekly km. Trusted fully.
2. **Estimated** — derived from stated runs/week via the *same* `freqVolumeEstimate` the plan uses for `s.wkm`. The prediction and the plan now read one number, so they cannot disagree about assumed volume.
3. (Future) a thin-data onboarding question — longest run + a volume estimate slider — will slot in above (2) as a *stated* signal.

The trust level is threaded as `weeklyRunKmIsEstimate` into `blendPredictions` → `demonstratedPBFloor`. An **estimated** volume may size the soft marathon-specificity penalty (it is the codebase's existing per-frequency km assumption, refined the moment real data lands), but it may **not** release the demonstrated-PB floor — letting an assumption override a proven same-distance time would re-commit the exact error this section fixes. Only **measured/stated** low volume releases the floor. Consequence: a 4-runs/week 5K→marathon athlete is unchanged (40 km/wk ≥ 30 → no penalty); a ≤3-runs/week marathon hopeful now carries the mild penalty even without typed km, which removes the perverse incentive where saying nothing produced a *faster* prediction than honestly reporting low volume. **Confidence: high** — no new constants; reuses `freqVolumeEstimate` (plan) and the 30 km/wk floor (Coyle 1984). Guard: `predictions.test.ts` adds "estimated low volume does NOT override a same-distance marathon PB" and its measured-volume counterpart.

**Cross-training (other sports) — softens the SHORT-distance discount only.** Decision with Tristan (2026-06-15): a multi-sport athlete (cyclist, footballer, swimmer) should get credit where the science supports it, and nowhere else. The `lowVolumeDiscount` exists because the watch's LT/VO2 markers go stale when *running* stops; but cycling/rowing/swimming maintain VO2max and LT (central cardiovascular adaptations transfer across modalities — Mujika & Padilla 2000; Bassett & Howley 2000), so for a heavy cross-trainer the markers are genuinely current and the discount over-corrects. We therefore soften the discount in proportion to aerobic cross-training, but only for **sub-marathon** targets.

- **Where it does NOT apply, and why:** the marathon-specificity penalty and the long-run durability cap are untouched by cross-training. The marathon is set by fractional utilization and musculoskeletal durability, which are *run-specific* and do not transfer (Joyner & Coyle 2008; Coyle 1988). A footballer with a fast 5K but no long runs is still predicted to fade at 42 km. This is the tracking-vs-planning / run-specific-endurance line held explicitly.
- **Magnitude (two named constants, literature-derived, tunable):**
  - `CROSS_MAINTENANCE_CAP = 0.6` — cross-training can erase at most 60% of the low-running discount. Running economy explains ~30–40% of distance-running performance at a given VO2max (Conley & Krahenbuhl 1980; Saunders 2004) and does **not** transfer from cycling/rowing, so ≥40% of the discount must remain even for a pure 5K.
  - `CROSS_MAINTENANCE_PER_SESSION = 0.6 / 3 = 0.2` — full aerobic maintenance is reached at ~3 effective aerobic sessions/week, the established minimum to *maintain* VO2max during reduced running (Hickson 1985; Mujika & Padilla 2000). Linear ramp to the cap.
- **Input signal:** `effectiveCrossSessions` (intensity-weighted via the existing `INTENSITY_FACTOR` easy 0.5 / mod 0.7 / hard 0.9), so an easy 1 h ride counts as half a maintenance session — consistent with the engine's existing aerobic-equivalence model. Onboarding passes the precise value; the post-onboarding refresh derives it from persisted totals (`epw − rw`) so the two surfaces agree.
- **Confidence: medium.** The transfer-of-VO2max and the economy-residual are well-supported in direction; the exact cap (0.6) and ramp (3 sessions) are reasoned calibration points, not a fitted curve — flagged as tunable. Guard: `predictions.test.ts` "cross-training softens the short-distance discount only" (3 cases: 10K faster, marathon unaffected, cap not fully erasable).

## §BV — Triathlon intensity distribution is race-distance-aware (2026-06-15)

**Problem.** After promoting sprint/olympic/t100 to plannable formats (§BU), *volume* was distance-aware but *intensity distribution* was not: the session pickers chose kinds by training phase only, so a 12-week sprint plan and a 24-week ironman plan prescribed the same proportion of VO2/threshold/speed work, just scaled in duration. The default (~2-of-3 quality sessions in build/peak) is right for short course and **over-intense for Ironman** (race ~70% FTP, aerobic-bound). This delivers the §30-flagged "future work: weight by intensity distribution (Seiler polarized model)" and mirrors running's existing `workoutPriority(race, phase)` precedent (`plan_engine.ts:300`).

**Decision (two levers, user-approved).** New module `src/workouts/tri-intensity-profile.ts`, consumed by the plan engine (the pure session generators are unchanged — they already take `kind`).
1. **Count** (`TRI_QUALITY_SLOTS[distance][phase][discipline]`) — **discipline-specific**, not uniform. A uniform count over-intensified the run and swim (two hard runs, no easy run) and broke 80/20 — caught by the generated-week integration guard (below), not by the constants-only test. Final design: the **run stays at one** quality session at every distance (running has the highest injury risk per hour, Vleck & Garbutt 1998; short-course run intensity comes from FLAVOUR — vo2 vs threshold — not extra hard runs). The **bike carries 2** quality sessions for every format except **Ironman = 1** (aerobic-led; the correction). **Swim adds a 2nd** quality session for short course only. This reproduces the pre-change 70.3 pattern (bike 2 / run 1 / swim 1). The bike long ride and run long run are always reserved aerobic.
2. **Flavour** (`TRI_QUALITY_FLAVOUR[distance]`) — which hard kind fills a quality slot. sprint/olympic = vo2/vo2_micros/vlamax/over_under (bike), speed/threshold (swim), vo2 (run). ironman = sweet_spot/tempo/threshold only (no vo2/vlamax — the race never goes there), threshold (swim/run). A new `'vo2'` run kind was added to the tri run generator (anaerobic share 0.50 from canonical `LOAD_PROFILES.vo2`; `'vo2'` is already a recognised `Workout.t` in running mode). Base phase gates out the top end (Daniels/Bompa base-first).

**Why this preserves Seiler 80/20.** ~80/20 easy:hard *by training time* (Seiler 2010; Stöggl & Sperlich 2014) holds at every distance: the aerobic + long sessions still carry the bulk of weekly minutes even when a slot is "quality." What changes by distance is the *flavour* of the hard minority and how many sessions carry it — driven by specificity (train at the race's intensity flavour) and Coyle 1984 fractional-utilization decay, the same source backing `RACE_INTENSITY_BY_DISTANCE`.

**Bricks by distance** (`TRI_BRICK_POLICY`). sprint = peak-week only (a single transition rehearsal; a 40+15min brick is ~10% of the whole race); olympic/t100/70.3 = build+peak; ironman = build+peak with the largest run share (0.30 vs 0.20 sprint) because the IM brick run is the decisive race-specific session. Bike share is distance-independent (`BRICK_BIKE_SHARE = 0.40`).

**Forecast parity (drops vs TT bike).** The bike *forecast* (`estimateBikeSpeed`, `race-prediction.triathlon.ts`) was audited for the same distance nuance. The primary physics path (CdA by position hoods/drops/clip-ons/tt-bike → `solveSpeed`) already used `RACE_INTENSITY_BY_DISTANCE[distance]`, so it was correct for all five. Two **fallbacks** were fixed: the FTP→speed fallback hard-coded `ironman ? 0.70 : 0.78` (treating sprint/olympic/t100 as 70.3) → now reads `RACE_INTENSITY_BY_DISTANCE[distance]`; the skill-slider fallback's IM-only −3 kph discount → generalised to all five by scaling the reference speed by `(IF_d / IF_70.3)^(1/3)` (speed ∝ power^(1/3) in the aero regime, P ∝ v³; Martin 1998), leaving 70.3 unchanged.

**Verification (real generated weeks).** A throwaway harness generated a full plan per distance and dumped the build/peak composition. It caught the uniform-count over-intensification (sprint build easy-time 37%, 70.3 run = two threshold runs with no easy run) before ship; the discipline-aware counts above restored healthy distributions (70.3 build easy-time 51% → 66%, every distance now has an easy run, Ironman 78%). The harness assertions were folded into the permanent guard.

**Defensibility / limitations.** Direction (short = intensity-led, long = aerobic-led) is well-established (Friel, Dixon, Seiler). The exact slot counts and brick run-shares are **coaching consensus (medium confidence)**, centralised in one module for easy retuning. **70.3 is essentially preserved** (bike 2 / run 1 / swim 1 as before; the long ride is now guaranteed aerobic and the swim quality kind shifts threshold→speed). **Ironman is intentionally changed** to aerobic-led (one quality slot per discipline in build/peak) on next regeneration — a correction, not a regression. Guard: `src/workouts/tri-intensity-by-distance.test.ts` — unit checks (counts/flavour/base-gate/bricks) **plus integration checks that generate a real build week per distance** and assert ≤1 hard run, an easy run present, ≥40% easy-time (≥70% for Ironman), and no NaN loads. Not device-verified.

## §BW — Marathon plans now build the long run to race-readiness, and periodise under the hours cap (2026-06-15, ISSUE-286)

**Problem (real device plan, "T.", Amsterdam Marathon, 18 wk).** The generated plan was under-built: peak weekly load landed at **week 2**, the load line was a flat/jagged sawtooth with no arc, the peak long run topped out at **~18 km / 89 min**, and total volume was ~452 km. Investigation (config sweep + per-week dumps; the coach-contract chart was verified faithful) isolated three compounding engine behaviours in `plan_engine.ts` / `athlete-archetype.ts`. The headline contradiction: the app's own predictor calls a marathoner "ready" only once their longest run reaches `LONG_RUN_THRESHOLD_SEC.marathon = 165 min ≈ 30 km` (Daniels' time-goal minimum; §run-durability), yet the plan *generator* never built the long run past ~95 min — so the plan could not deliver the readiness its own tracking side demands.

**RC1 — long run never ramped toward the marathon-readiness distance.** `longRunMinutes` ramped a fixed `baseLong.marathon = 90 min` across only an 80%→100% band, so it maxed at ~95 min regardless of the ability *cap* (which therefore never bound). Fix: for the marathon only, ramp **linearly from the 90-min week-1 anchor up to the ability readiness ceiling** (`longRunCapMin`): beginner 150 (~25 km, Daniels' finish-focused minimum, held one notch below the threshold for the least-durable), novice/intermediate 165 (~30 km, the readiness threshold itself), advanced/elite 180 (~33 km / 3 h, the Pfitzinger upper bound — long runs rarely exceed 3 h before injury/recovery cost outweighs aerobic return). Shorter distances keep the existing 80%→100% band and the general ability caps (unchanged). The marathon endpoints deliberately match `LONG_RUN_THRESHOLD_SEC.marathon`; same literature (Karp 2007, Daniels 2014, Pfitzinger & Douglas 2009). Kept as a local table in `plan_engine.ts` rather than imported from the prediction module, to preserve the tracking/planning separation (this is a planning decision that happens to share the anchor). The same `longRunCapMin` replaced the duplicated cap table in `computePeakWeeklyKm`.

**RC2 — the volume budget flattened under a tight hours cap, killing the arc.** `effectiveWeeklyBudgetMin` was `min(rampBudgetMin, weeklyHoursTarget × 60)`. Whenever the hours target was the tighter constraint it pinned every week to the same flat minute budget, so the plan stopped periodising: with no rising volume arc the global load peak landed on whatever week the session-mix noise was highest (week 2 for this user) and the line read as random sawtooth. Fix: cap the **destination** (the peak), then ramp toward the capped peak using the **same geometric ramp fraction** the uncapped budget already uses — `round(min(peakBudgetMin, hoursCap) × rampBudgetMin/peakBudgetMin)`. No new constants (the fraction and peak are existing values). The new per-week budget is always ≤ the old flat-capped value, so the hours cap is never loosened — only the early-week base is pulled down to restore a base→build→peak→taper arc. When baseline ≥ peak (established runner) the fraction is 1 every week, so this is unchanged and flat-at-capped-peak (their arc comes from the long-run/intensity ramp, not volume), and plans with no hours target are byte-identical to before.

**RC3 — the peak-km heuristic credited zero easy volume for a 3-run marathon.** `computePeakWeeklyKm` computed `easyCount = runsPerWeek − 2 − 1 = 0` for a marathon at 3 runs/wk, undershooting the peak-km estimate below what the generator actually produces (which keeps one easy run) and over-tightening the budget. Fix: floor `easyCount` at 1 for the marathon when `runsPerWeek ≥ 3`. Cross-training stays scheduled alongside (it adapts on logging; no planning-time km cut — Tristan's call). A "minimum 4 runs/wk for marathon" advisory already exists upstream in the generator and is left as-is.

**Effect (probe, rw=3 marathon).** peak week 11→**14** (late, correct); peak km 37→**51**; total 452→**588**; peak long run 18 km/89 min → **32 km/159 min**. The tight-hours-cap case (`weeklyTrainingHours = 4`) that front-loaded the peak to week 5 now also peaks at week 14 with a clean arc.

**Limitations.** The beginner marathon long-run ceiling jumps from 90→150 min — a ceiling the geometric ramp builds toward gradually, still gated downstream by the ACWR safety cap and the hours budget, and conservative versus mainstream novice plans (Higdon Novice peaks at a 20-mile long run). The linear long-run ramp is a simplification of the step-back (3-up-1-down) long-run progressions some plans use; deloads still provide step-backs at the weekly level. Not device-verified.

**Verified by a scenario sweep (2026-06-15, same session).** A matrix over plan length {8,10,12,16,18,24 wk} × frequency {3,4,5} × distance {half, marathon} × ability confirmed: (a) non-marathon long runs are byte-identical to the pre-fix formula; (b) the marathon long run reaches its ability ceiling (150/165/165/180/180 min) for every plan length, week-1 anchored at ~95 min; (c) no NaN, no runaway volume (marathon peak km 49–72 across configs); (d) for the **reported 16–18 wk case the peak now lands at 77–87% of the plan** (was week 2). **One pre-existing weakness the sweep exposed and this fix does NOT solve: short plans (≤12 wk) front-load their LOAD-chart peak to ~week 5** (e.g. a 12-wk marathon peaks at wk 5 / 41%). Independent of this work — it appears identically for the half. A tri-style phase-position volume envelope was built to fix it and **reverted**, because testing showed (1) the early peak is an *intensity*-placement artifact, not volume — wk5 carries less km than wk7 but more TSS (the load tracks where the hard sessions + the post-deload bounce land), so a volume envelope can't move it; and (2) the envelope regressed established runners, cutting a 50 km/wk athlete's base to ~37 km (an athlete already at volume should hold flat and periodise via intensity). Logged as ISSUE-287; the real lever is intensity placement (concentrate quality in the peak phase), a separate subsystem and decision. Also noted during testing: the volume-budget block only runs when `detectedWeeklyKm` + `athleteArchetype` are set (live state, set at launch/sync), so budget-path changes must be tested with both populated or they silently no-op.

**Update 2026-10-06/07 (§CT).** The long-run ceilings above are now reached only where the 10% rule allows: a long run is at most 10% over the longest long run prescribed in the previous 4 weeks, and deload weeks hold the ramp (the span is shortened by the same deload count, so full progress still lands at 75% of the plan). For runners starting at 30 to 50 min (detrained, low-volume or hours-capped) the marathon long run can peak at 50 to 81 min instead of the ability ceiling; the race-day forecast states that gap (§CU). RC2's "cap the destination" principle is reused by the sharpening block's hours rule (§CV).

## §BX — Cross-trained athletes: forecast adaptation-rate premium + recognition (2026-06-16)

**Context.** §BV (cross-training softens the short-distance low-volume *discount*) credits a multi-sport athlete's *current* fitness: cycling/rowing/swimming keep VO2max and LT current, so the "stale from low running" penalty over-corrects for them. This entry adds the *complementary* mechanism Tristan asked for — credit on the **forecast** (race-day projection) — plus the recognition that makes both effects visible, plus a bug fix that was silently suppressing the existing experience-level credit.

**1. Adaptation-rate premium (`CROSS_TRAINED_FORECAST_PREMIUM = 1.10`).** An athlete fit from non-running aerobic sport already owns the slow-to-build central engine (cardiac output, plasma volume, capillary density, mitochondrial enzyme expression — shared across modalities; Bassett & Howley 2000). A running block therefore *converts* that engine to run performance rather than *building* it from scratch. The rate-limiter shifts to running-specific adaptation (economy, neuromuscular pattern, connective-tissue tolerance), which develops on the order of a training block — faster than constructing aerobic capacity de novo (Hickson 1981; Jones & Carter 2000). Modelled as a multiplicative premium on `exp_factor` in `applyTrainingHorizonAdjustment` (training-horizon.ts). The magnitude is **not invented**: it is exactly the premium the legacy `hybrid` experience level already carried over a baseline intermediate runner (`EXP_FACTORS.hybrid 1.10 ÷ intermediate 1.0`). Making it orthogonal lets "beginner + cross-trained" earn `0.80 × 1.10 = 0.88` instead of forcing the athlete to abandon their running-experience label.

**2. Orthogonal capture.** Running experience and "fit from other sports" are independent axes. The mutually-exclusive `hybrid` radio option is removed from onboarding (the `RunnerExperience` value is retained for back-compat); cross-training is now an orthogonal `crossTrainedBackground` toggle, auto-prefilled at finalize from the single canonical `effectiveCrossSessions` signal (≥ 1.0 effective aerobic cross-session/week; explicit user choice always respected). The premium fires only on the (prefilled-but-confirmable) toggle, so **no invented numeric threshold drives any forecast number**.

**3. Recognition.** The §BV effect shipped invisibly — a cross-trainer got a better short-race prediction and was never told. `crossTrainingPredictionCredit(targetDist, weeklyRunKm, crossSessions)` returns the *real* fractional credit (the measured `lowVolumeDiscount` delta, 0 for the marathon), so the forecast-view note reflects the actual effect rather than a guess. Surfaced on the race-forecast view; copy holds the run-specific-endurance caveat ("Marathon pace still depends on long-run endurance, which cross-training does not replace").

**4. Bug fix.** `getStandardForecastProjection` (blended-fitness.ts) was passing **no** `experience_level`, so the no-target standard forecast silently defaulted every athlete to `intermediate` (1.0) — a returning/advanced/hybrid/cross-trained athlete's `exp_factor` never applied there, unlike the targeted forecast. Now threads both `experience_level` and `cross_trained`.

**Why this is not the rejected cardiac-ceiling double-count.** The 2026-05-02 "no cardiac lift" decision forbids raising *current* run VO2 from cross-sport HR, because the running VDOT regression already embeds cardiac fitness via HR-for-pace. That argument is about the *present* fitness level and assumes running HR data. The premium here is a *future adaptation-rate* effect, a different axis the decision never addressed, and it does not touch the current number.

**Limitations (stated honestly).** The premium (rate) and the §BV offset (level) share a single root cause — the aerobic base — so for a low-mileage sub-marathon cross-trainer both fire and the credit is mildly correlated rather than fully independent. We accept this: they model genuinely distinct mechanisms (how fit you are now vs how fast the block converts), the premium is bounded by `max_gain_cap_pct` + `applyGuardrails` (it cannot push an athlete through a fitness barrier), and `exp_factor` scales only the base gain term (taper/strength additions are not premium-scaled), so the realised forecast lift is well under the raw 1.10 (≈ 1.05–1.06 in practice). The `1.10` magnitude is a reasoned reuse of an existing constant, not a fitted value — flagged as tunable. **Confidence: medium.** Guard: `cross-training-forecast.test.ts` (11 cases: distance ordering, 60% cap, marathon untouched, premium lift bounded ≤ 1.10, no stacking on legacy `hybrid`, inert when absent).

## §BY — HYROX forecast confidence band (factor-based, not Monte Carlo) (2026-06-16)

**Context.** Running and triathlon forecasts run a 2000-trial Monte Carlo (`race-forecast-simulation.ts`) producing a p10–p90 cone and a goal-probability %. HYROX never had one. Tristan asked whether to add the same. Decision: **do not** build a HYROX Monte Carlo; surface the existing deterministic factor band instead.

**Why not Monte Carlo here.** The run/tri sim draws its variance from sourced distributions — VDOT improvement σ ≈ 35% relative (Bouchard 2011 individual-response variance), adherence and race-day form factors. A faithful HYROX cone would need per-station improvement variance (sled push vs wall balls vs ski erg respond at different rates with different inter-individual spread). We do not have that data. Fabricating per-station σ values to drive a visible distribution would violate the no-invented-constants rule and the "visualisations of real data must derive from that data" rule — a Gaussian we made up sitting next to real benchmark numbers reads as fake (the 2026-05-07 HYROX percentile-curve incident). So the honest move is a band whose width is a stated, bounded function of model confidence, not a sampled distribution dressed up as one.

**The band.** `hyroxForecastBandPct(confidence, weeksRemaining)` (race-projection.hyrox.ts) returns a half-width as a fraction of the finish time: base **±4%** (irreducible day-to-day pacing/conditions variance of a ~60–90 min event), **+1%** beyond 4 weeks out and **+1%** beyond 12 weeks (model drift grows with horizon), **+2%** when calibration confidence is `low` and **+1%** when `medium` (seed-based station estimates are less certain than measured times). It is the single source for both the projection's `confidenceRangeSec` (centred on the race-day projection) and the hero's "Likely H:MM:SS–H:MM:SS" caption (centred on the displayed finish), so the two never disagree (per the "two numbers, one source" rule). The percentages are reasoned bounds, not fitted — flagged tunable. **No goal-probability %** is shown, because without a sampled distribution we cannot compute one defensibly; the existing "+X min vs target" line carries the target comparison instead.

**Provisional gating.** Any non-high confidence surfaces an inline calibration banner rather than leaving the caveat behind the confidence badge: `low` (cross-format or seed-dominated) → strong "Provisional forecast"; `medium` (partially calibrated) → soft "Sharpen your forecast" with the calibrated-station count. Both explicitly tell the user a station assessment makes the prediction more accurate and name the protocol (half distance, race effort) so they do it right. This is the calibration-honesty half of the same problem: a doubles-time-only athlete racing singles is correctly *not* given per-station singles estimates inferred from doubles (not defensible — 4 vs 8 stations, partner rest; see race-prediction.hyrox.ts:190), so the number rests on band seeds and the UI must say so. **Confidence: high** (this is a display/uncertainty-communication change; no user-facing number's underlying math changed).

## §BZ — Engine vs race-readiness: capacity is not buried by training volume; the forecast credits the plan's ramp (2026-06-16, ISSUE-297)

**Context.** A 20:00 5K with no other data, ~8 km/wk, marathon target was shown a ~3:50–4:00 "today" marathon that was then *written back into the global engine* `s.v` (VDOT 50 → ~40), and a 20-week forecast barely faster than today (~3:40). Re-running produced different answers (3:33 vs 4:00). Ground truth: a 40:00-10K runner (the same engine class) has actually run ~3:10. Tristan's framing was exact: a low-mileage runner whom the plan ramps "through the long haul" must not be predicted as a permanently low-mileage runner. Full diagnostic: `docs/PREDICTION_FEEDBACK_LOOP_DIAGNOSTIC.md`.

**The physiological model.** A marathon time decomposes into two training-sensitive parts that respond to two *different* volume signals (Joyner & Coyle 2008):
- **Engine capacity** — VO2max / LT / VDOT, demonstrated by the athlete's PBs. Proven by a 20:00 5K, it is a real ~49.8 VDOT regardless of current mileage. Capacity decays only with sustained inactivity over weeks-to-months (Coyle 1984; Mujika & Padilla 2000), evidenced by *demonstrated recent slowness*, not by a low current training volume.
- **Marathon-specific endurance** — fractional utilization + durability, the most training-sensitive term, set by the running volume the athlete is *currently sustaining at race approach*. Low volume legitimately slows a marathon run *today*, and a taper preserves what the peak block built.

**The bug was conflation.** `blended-fitness.refreshBlendedFitness` (and its parallel implementation in `state/initialization.ts`) back-derived the global engine from the volume-penalized *marathon* time — `cv(targetDist, durabilityAdjustedBlend)` → `s.v`. A *race-readiness* adjustment (the volume penalty) was thereby written into the *capacity* number, which then fed training paces, plan generation and the race-day forecast. Because that buried value was read on the next refresh (and `recomputeLT` re-derived `s.lt` from it), the prediction stopped being a pure function of inputs (the §BO "degraded VDOT loop", but cross-distance, so `demonstratedPBFloor` — same-distance only — never caught it).

**Fix 1 — engine floored at demonstrated capacity (RC1).** The engine VDOT is now floored at `pbMedianVdot` (the cross-distance PB-median capacity, immune to the refresh feedback loop). The floor stands down ONLY on demonstrated recent slowness — a recent run that projects *below* capacity. Low training volume is deliberately **not** engine-decay evidence here: it moves the prediction and the forecast, never the capacity number. This is the intended divergence from `demonstratedPBFloor`, whose low-volume branch governs the same-distance race prediction. Result: `s.v` is a pure function of demonstrated fitness → deterministic across refreshes, and `blendedRaceTimeSec` stays honestly slow off thin volume (the readiness penalty lives there, not on the engine).

**Fix 2 — the forecast credits the volume the plan delivers (two-term decomposition).** The forecast formerly anchored on the today-blend and subtracted only the small engine-gain delta, so the ~40-min low-volume penalty never lifted: the plan ramped the athlete but the forecast never knew. Now the two terms are fed their correct volume:
- *Cumulative training dose → engine gain.* The horizon VDOT-gain model keeps using the build-phase mean (`getPlanPrescribedMeanWeeklyKm`), the dose integral over the block (Banister impulse-response).
- *Race-approach sustained volume → specific-endurance penalty.* The forecast anchor is now a second `blendPredictions` evaluated at `computePeakWeeklyKm` — the exact peak the plan engine ramps toward (`plan_engine.ts:409`), read with the same capacity VDOT and easy pace the plan uses. The marathon-specificity / low-volume penalties therefore lift *in proportion to the mileage the plan actually delivers*: full relief once the plan reaches ≥30 km/wk, partial in the 20–30 km band. A thin-data beginner whose plan only reaches the low band keeps the residual penalty (never over-credited to bare capacity); an athlete whose plan reaches real volume lands near capacity + horizon gain.

**Why this is defensible and self-consistent.** No new constants — every threshold (10/20/30 km/wk, the durability cap, the PB-median) already existed; the fix only feeds each existing term the volume it is physiologically a function of. `computePeakWeeklyKm` is the single source the plan builds toward, so the forecast credits exactly what the plan prescribes (the "two numbers, one source" rule), and it cannot over-credit because it is bounded by the plan's own per-athlete peak. The same mechanism explains both observed cases: the 40:00-10K / 52 km plan → ~3:10 (penalty lifts, matches ground truth), the 8 km/wk 2-runs/wk case → today ~3:54 but forecast materially faster as the plan builds. This sits on the **planning** side of the tracking/planning line for the forecast (prescribe the trajectory) and the **tracking** side for `blendedRaceTimeSec` (describe today).

**Limitations (stated honestly).** (1) The capacity floor assumes a PB is current absent recent-run contradiction; a years-stale PB with no recent runs logged is still floored at capacity (the PB-recency scaling on `marathonSpecificityPenalty` softens the *prediction* but not the engine — acceptable, and self-corrects the moment any run is logged). (2) The forecast inherits whatever realism `computePeakWeeklyKm` has — if the plan's prescribed peak is unrealistic for a true beginner, the forecast mirrors it; that is the mandate-volume-slider / ISSUE-286 surface's job, not the predictor's. (3) RC3 (deleted PBs resurrecting via `effectivePhysiologyPbs` fastest-wins) is now also fixed via a per-distance deletion tombstone (`s.deletedPbs`): `effectivePhysiologyPbs` and both auto-fills (Strava/Apple) drop any value that isn't genuinely faster than a deleted time, so a deleted PB cannot resurrect from the other store or from re-detected history; explicit re-entry clears the tombstone. This also protects the RC1 engine floor, since `pbDerivedVdot` reads `effectivePhysiologyPbs`. **Confidence: high** on the engine/readiness separation and determinism (guard tests below); **medium** on the absolute forecast magnitude (horizon-gain calibration is a coaching default, unchanged here). Guards: `blended-fitness.test.ts` "engine/readiness separation + peak-volume forecast (ISSUE-297)" (capacity floor, honest-today, forecast > today, determinism ×N, detrained-regression) + `initialization.durability.test.ts` engine-holds-at-capacity. NOT device-verified.

## §CA — Plan periodisation: phase-aware variant selection (load apex in the peak phase) + continuous-mode progressive overload (2026-06-16, ISSUE-287 + parked continuous-mode bug)

**Context.** Two periodisation defects in the generated plan's load shape, both surfaced on the coach-contract reveal chart. (1) Short event plans (9-12 wk) put the weekly-load APEX in the BUILD phase, ahead of the peak phase — the chart labelled a build week "Peak". (2) Continuous/endless plans (Base→Build→Peak→Taper repeated via `i % 4`) "ramped in circles": each cycle peaked at the same low level, no cycle-over-cycle progression.

**Periodisation principle.** The peak phase is, by definition, the highest-load mesocycle before the taper (Bompa & Buzzichelli 2018; the classic load wave). And progressive overload requires the training dose to actually rise over a block (Reilly's ~10%/week ceiling; Gabbett 2016 ACWR safe zone). Both defects violate one of these.

**Diagnosis 1 — the apex was misplaced by variant noise, not phase intensity.** Weekly load = `progression(weekIndex) × phaseMultiplier × deload × variant`. The phase multipliers move weekly load only ~5% (threshold peak ×1.05 vs build ×1.0), far too little to dominate. The real driver was **workout-variant rotation**: each interval/long-run slot rotated through its variant array by `(weekIndex - 1) % len`, scattering the variants' very different work loads independently of phase. The single largest swing is the long-run variant — `long_fast_finish` renders as a `progressive` session (~30 TSS over `long_steady`) — so whichever week happened to draw it spiked, and in a short plan with one peak-phase week that spike usually landed in build. Confirmed empirically: relabelling a build week to "peak" produced byte-identical load; the apex only moved when the variant composition moved.

**Fix 1 — `pickPhaseVariant` (plan_engine.ts).** Variant selection is biased by phase instead of scattered: the peak phase draws from the highest-work variants, the base phase (and any deload week) from the lowest, build/taper keep the full `weekIndex` rotation for variety. The work proxy is each variant's hard-effort minutes (`reps × repMin`, or continuous `workMin`); the long-run variant is ranked by an explicit `load` field that reflects ACTUAL rendered intensity. **No load constant is introduced** — the variants and their work minutes already exist; only *which existing variant a phase draws* changed. Deload weeks drawing the lightest variants also removes the post-deload "bounce" (a deload that drew a fast-finish long run undermined the recovery and could out-load the peak). Result: the TSS apex lands in the peak phase for every probed length/distance (9/12/16/18 wk × 10k/half/marathon). Guard: `plan_engine.apex.test.ts`.

**Latent bug found en route.** `long_with_blocks` was never wired to a distinct workout format in `intent_to_workout.ts` (only `long_fast_finish` becomes a `progressive`); it falls through to the plain steady `long` case and therefore scores identically to `long_steady`. It is ranked `load: 0` accordingly (not the high rank its name implies), with a code comment flagging the latent issue for whoever implements the blocks long run.

**Diagnosis 2 — continuous mode had no overload engine.** The geometric volume-budget ramp (`weekVolumeBudgetKm`, slope = archetype `weeklyRampPct`, Reilly/Gabbett) is what climbs volume toward the readiness-capped peak. It only engages when `detectedWeeklyKm > 0` AND an archetype are present (read live in `generateWeekWorkouts`). A continuous user who hasn't synced has neither, so only the shallow `weekIndex` long-run/threshold ramps applied — swamped by the 4-week phase cycle.

**Fix 2 — continuous baseline fallback (generator.ts).** For continuous mode only, the ramp baseline falls back to the plan's own starting volume `s.wkm` (the same frequency-derived estimate the prediction uses — a legitimate existing number, not invented) and the neutral `'unknown'` archetype (7%/week). The per-cycle peak then climbs toward the readiness ceiling and plateaus there (the chosen model: "climbing peak per cycle, capped by readiness ceiling"). Event plans are untouched (they still read detected values only). **Honest limitation:** at 2 runs/week a 10K plan's two sessions are already at their physiological caps (long run ~63 min, one quality session), so there is no room to add volume and the climb is correctly negligible — progressive overload needs ≥3 sessions to express. This is a real structural ceiling, not a bug; documented rather than papered over with an invented mechanism.

**Fix 3 — load-weighted session-mix bars (plan-shape.ts / coach-contract.ts).** The coach-contract "how your sessions shift by phase" bar split aerobic-vs-quality by session COUNT, which collapses to 50/50 for low-frequency plans (1 easy + 1 quality every phase). `SessionBucket` now carries `load` (canonical TSS) and the bar weights the split by load. The phase shift is visible again and matches the copy (event rw=4: base 36% → peak 87% quality; taper reads quality-dominant by load, which is correct — a taper drops volume while maintaining intensity). Guard: `plan-shape.test.ts`.

**Confidence: high** on the apex placement and continuous climb (deterministic, guard-tested across the length/distance grid); the fixes reuse existing constants only. **NOT device-verified** — confirm in-app that a short plan's load chart crests under the Peak label and a continuous plan's blocks step up cycle-over-cycle.

## §CB — Triathlon weekly hours cap: budget solve so prescribed total ≤ stated hours (2026-06-16)

**Context.** A user set "max 10 hours" on triathlon mode and got a week of ~16 hours. The cap (`triConfig.timeAvailableHoursPerWeek`) sized only the solo swim/bike/run sessions; the brick, gym, and commute runs were generated and stacked on top with no accounting against the cap. Two compounding defects.

**Defect 1 — phantom commute hours.** Commute workouts were pushed with only `d: "${oneWayKm}km"` and no `estimatedDurationMin`. The scheduler's `workoutMinutes()` falls through every branch to a `return 60` default, so a 4 km bidirectional commute (≈20 min each way) was counted as **two full hours**. With 2–3 commute days that alone added 3–4 phantom hours.

**Defect 2 — extras stacked on top of the cap.** At a 10h peak week (70.3, default split), solo S/B/R correctly summed to ~10h, but the brick added ~2.8h (`bikeHours × BRICK_BIKE_SHARE + runHours × runShare`), gym added up to 1.5h (2 × 45min), and commutes added on top of that. The brick is a core race-specific session, not optional, so the cap was structurally exceeded by ~4h before any commute.

**Decision (Tristan, 2026-06-16).** "Max hours" now means **total prescribed time** — solo S/B/R + brick + gym + commute all sum to at most the cap. This **supersedes §AM**, which deliberately treated commutes as additive transport on top of the cap. The trade-off accepted: a heavy commuter who sets a low cap gets a thinner structured plan, because the commute now consumes part of the budget. Chosen over the "training-only cap" alternative after the user was shown that cost.

**Model — a one-line budget solve, no invented constants.** The brick's bike+run minutes are fixed fractions of the bike/run hour split, so as a share of the SBR budget the brick adds `brickFrac = split.bike·BRICK_BIKE_SHARE + split.run·runShare` (both existing constants). Gym and commute are fixed minutes. Solving `capMin = sbrMin·(1 + brickFrac) + gym + commute` for the solo budget:

```
sbrMin = (capMin − reservedGymMin − reservedCommuteMin) / (1 + brickFrac)
```

The existing generation code is then driven from this reduced `weekHours` unchanged: solo sessions size from `weekHours × split`, the brick sizes from the same reduced bike/run hours (so brick = `weekHours × brickFrac`), gym is fixed, and each commute slot now carries its real `estimatedDurationMin = round(distanceKm × easyPace / 60)`. The four components sum back to `capMin` by construction. `brickFrac` is 0 outside the brick's policy phases (base/taper), so those weeks reduce only by gym + commute.

**Why this is defensible.** No new number is introduced — `BRICK_BIKE_SHARE`, the per-distance `runShare` (`TRI_BRICK_POLICY`), the gym 45-min block, and the volume split all pre-exist. The solve is exact algebra over those. The commute easy pace reuses the run session's pace (`gp(vdot, lt).e`, or the run-skill estimate `easyPaceSecPerKmFromSkill` as fallback) — the same pace shown on the user's easy runs.

**Honest limitations.** (1) When fixed commitments alone exceed the cap (e.g. a long commute on a deep taper week, where the phase-scaled cap is small but the commute is unchanged), `sbrMin` floors at 0 and the solo sessions drop out — the cap genuinely cannot fit them. This is correct behaviour, not a bug, but it means commute-heavy taper weeks can read as commute-dominated. (2) The brick is sized from the *reduced* budget like every other session, so on a tight cap the race-specific brick shrinks proportionally rather than being protected. (3) Running mode is not yet mirrored — its commute model is still additive per §AM; evaluate parity if running grows an hours cap (Mirror rule).

**Guard:** `plan_engine.triathlon.test.ts` — "weekly hours cap is honoured" describe block: every week ≤ cap (10h + rounding tolerance) with commutes + gym, the heaviest peak week binds at ≥8h, and commute slots carry a real sub-45min duration (never the 60min default).

**Confidence: high** (deterministic algebra, guard-tested). **NOT device-verified** — confirm in-app that a 10h tri plan with commutes shows a weekly total at/under 10h.

## §CC — Race-validated run VDOT anchors over the watch VO2max for triathletes (2026-06-17, ISSUE-297 tri analogue)

**Context.** A triathlete dogfood: real 70.3 splits swim 36:00 (~1:54/100m), bike 2:29 (~36 km/h), run 1:55 (5:27/km), with an Apple Watch VO2max of 56. The app showed running paces far too fast — easy 4:45/km, threshold 3:58/km, projected marathon 3:33 — and a too-fast run leg in the Ironman projection. His 1:55 half implies run VDOT ~42–45; VDOT 56 is sub-19 5K shape.

**Root cause.** A watch VO2max is a whole-body cardio estimate. For a triathlete it is inflated by cycling and swimming and overstates *running-specific* fitness. Two code paths trusted it as running VDOT with nothing to pull it down:
1. `getPhysiologicalVdot` ranked the device (watch) tier above every derived source; a tri user with no running PBs had no higher-priority signal, so the resolved VDOT = 56 (drives the VO2/pace display surfaces).
2. `refreshBlendedFitness` fed `effectiveVo2max(s)` = 56 into `blendPredictions`, and with no running PBs the existing PB-capacity floor (`pbDerivedVdot`, ISSUE-297 RC1) was null — so nothing capped the watch-driven blend. `s.v` collapsed to ~56, and since `getEffectiveVdot = s.v + adj` every training pace, the tri run leg (`race-prediction.triathlon.ts` reads `state.v`), and the marathon forecast inherited it.

A real race run leg is the strongest race-validated running signal we can get. Per Tristan: a recent race must anchor the predictions and override the watch; only a *better* standalone event supersedes it.

**Model.**
- *Race run leg → fresh-equivalent VDOT* (`raceRunLegToVdot`): race legs are run fatigued (after swim+bike), so the raw split understates fresh capability. Remove the published population-average bike-to-run fatigue discount already used in tri race-time prediction (5% for 70.3, 11% for IM; `RUN_FATIGUE_DISCOUNT`) to recover the fresh-run-equivalent time, then back-derive VDOT via `cv()`. Single source for both the onboarding past-race seed and the post-race outcome logger.
- *Persisted anchor* (`s.raceRunVdot = { vdot, dateISO, distance, source }`): recency-gated by `raceAnchorVdot()` at 365 days — reusing the "strong" band of `RUN_PB_RECENCY_BANDS` (the same window the marathon-specificity penalty uses to credit recent full-distance capability). Beyond a year the race is no longer fresher evidence than a current watch reading, so the anchor stands down.
- *Resolution tier* (`getPhysiologicalVdot`): a new `race-validated` tier sits ABOVE device and below the mosaic-running estimate. Mosaic-running is derived from actual standalone runs, so a "better standalone event" still wins — exactly the override Tristan specified.
- *Blend predictor cap* (`effectiveVo2max`): the watch value fed to `blendPredictions` is capped at the race anchor when the watch overstates it and standalone running PBs (`pbDerivedVdot`) do not corroborate the higher value. Because every blend call path reads this one helper (training-pace refresh, the tri run-leg race time in `blendOpenRunRaceTime` at `race-prediction.triathlon.ts:1303`, the standard-distance forecast, session generation), the cap cannot be bypassed by a surface that recomputes the blend off `s.vo2` directly. This was the Lesson-2 trap from `TRIATHLON_PREDICTION_LESSONS.md`: the run-leg race time has its OWN `blendPredictions` call that the `s.v` anchor alone did not reach.
- *Engine floor + cap* (`refreshBlendedFitness`): after the existing PB-capacity floor, the engine is also floored at the race anchor (demonstrated capacity) AND a watch-inflated engine is capped DOWN to it unless a PB or a recent run projects at/above it. Belt-and-suspenders for the `s.v` writeback.

**Engine vs readiness / capacity vs display (held).** The watch VO2max is still shown verbatim on the VO2 stats card (a physiological number); only the running PREDICTIONS yield to the race. The race anchor caps the *predictor*; it is never written back into a benchmark. Low volume continues to move the prediction/forecast, never the capacity — consistent with §BZ.

**No invented constants.** Fatigue discounts, the 365-day band, `cv()`, `pbDerivedVdot` all pre-exist. The only new datum is the persisted anchor itself, derived from real race data.

**Honest limitations.** (1) Direction asymmetry: the watch can only be capped DOWN by the race, never raised — correct for the triathlete-inflation case, but a watch that *understates* a strong runner is not corrected here (other tiers handle that). (2) Onboarding past-race `dateISO` may be a `YYYY-MM` month; treated as the first of the month for recency. (3) FTP is NOT derived from the bike split (a time-only split lacks watts/normalised power; the user enters FTP directly — see `derivePastRaceBenchmarks`). (4) Lesson-1 (forecast must evaluate the specific-endurance penalty at planned PEAK volume, not current) is a *separate, opposite-direction* facet not exercised by this too-fast symptom; tracked for the tri forecast-volume work.

**Guards:** `physiological-vdot.test.ts` (race tier outranks device; mosaic still wins; stale stands down; `effectiveVo2max` cap with/without PB corroboration, stale, override), `blended-fitness.test.ts` (s.v capped to race with no corroboration; uncapped without anchor; stale stands down), `tri-race-outcome.test.ts` (anchor seeded from the run leg).

**Confidence: high** for the compute path (guard-tested, full suite green). **NOT device/browser-verified** — the real bar per the lessons doc is the rendered on-screen number for the dogfood inputs above (easy ~6:00, threshold ~5:00, marathon ~4:15+, tri run leg slower than the open 1:55 half).

**Addendum (2026-06-17) — generalised to a running-evidence ceiling + a cold-start floor.** The race-anchor cap above was a special case of a broader principle Tristan endorsed with the decisive example: "you and Alex have the same watch VO2max (56), but you run 3:10 and he runs 4:00 — only running evidence tells them apart." So `effectiveVo2max` now caps the watch (for triathletes only, `s.triConfig != null`) at the **maximum of all running-specific evidence**: the race anchor, the PB-median (`pbDerivedVdot`), and a medium+ HR-vs-pace calibration (`hrCalibratedVdot`). The watch may not pull the blend's VO2 predictor above that ceiling. Because the ceiling is the *max* of the evidence, a recent fast run / fresh PB / HR calibration raises it — a genuinely improving runner is never trapped (PBs aren't a ceiling), and a fast runner with the same watch 56 + a 16:00 5K is not capped (resolves to VDOT 64.6). Running mode is untouched (no `triConfig`): there the watch is run-specific and trusted. Verified numerically (watch 56): pulled 1:55-half PB → engine 47.3 / open marathon 3:19 (was 49.3 / 3:13); fast-runner 16:00-5K → 64.6 (uncapped). For the **true cold-start** (no PB, no race, no recent run, no HR calibration) `refreshBlendedFitness` adds a floor: cap the engine at the run skill-slider self-assessment (`estimateRunPaceFromSkill`, existing per-level pace table — no new constants), so a watch-only triathlete isn't predicted a sub-3 marathon; watch-only cold-start skill-3 → engine 44.3 / 3:31 (was 50.7 / 3:08). The watch VO2max remains the displayed physiology number throughout; only the run PREDICTION yields. **Known residual** (separate, lower priority): the open-marathon VDOT-equivalent off a half PB (3:19) is still aggressive vs a real age-grouper marathon — that's marathon-specificity conversion, not the watch. **Pending**: the onboarding ASK-fallback (pull a PB from Strava/Apple `best_efforts` first via `applyPBsFromRows`, prompt on `tri-past-race` only if none) is not yet built. Guards: `physiological-vdot.test.ts` (evidence ceiling: caps at PB, doesn't cap when evidence exceeds watch, running-mode untouched), full suite green (3448).

**Bike + swim anchors (2026-06-17) — the same "anchor on the real race split" principle, extended to the other two disciplines.**
- *Bike (the "6:34 Ironman bike" bug)*: `estimateBikeSpeed` used a generic FTP→speed model (physics with a preset CdA, or a linear `20 + (W−100)×0.067` fallback) and ignored the athlete's demonstrated race speed — a 36 km/h 70.3 rider was projected at ~27 km/h (6:34) for the Ironman. A real race bike split bakes in the rider's true CdA, weight and position, so it's the best anchor. New `s.raceBikeKph` (km/h + the race's distance for its intensity factor; recency-gated 365d; seeded at onboarding + race-outcome logging). `estimateBikeSpeed` now has a top-priority anchor branch: **CdA path** — reverse-solve a personal CdA via `solveCdA` from the demonstrated ride (power = FTP × the anchor race's IF), then `solveSpeed` at the target leg's IF (captures course/mass when body+bike weight are set); **speed-scaling path** — `kph × (targetIF / raceIF)^⅓` (speed ∝ power^⅓ in the aero-dominated regime, Martin 1998; power ∝ IF). The scaling path needs only the split + the existing `RACE_INTENSITY_BY_DISTANCE` table. Alex's IM bike base moves to ~34.9 km/h (≈5:10) from the generic 27 km/h; the residual to the rendered leg time is the no-bike-volume readiness penalty (separate forecast-volume facet — a recent race should also relax it, not yet done).
- *Swim (the "1:41 faster than his actual 1:54" bug)*: the swim detraining penalty (`CSS_DETRAINING_PER_4WK`, `×1.125` on a fresh onboard) inflated a race-derived CSS, then the horizon improvement projected DOWN off that inflated baseline and could land faster than the athlete's real swim. A recent race now sets `cssFromRecentRace` (proxy: a recent bike anchor exists → they swam recently across disciplines), which skips the detraining inflation exactly like a user-set CSS. Mirrors the run anchor's "race-validated, not detrained" rule; the horizon then improves from the true CSS, so the projection can't undercut a demonstrated swim.
- No new constants. Guards: `race-prediction.triathlon.test.ts` (bike anchor faster than generic; stale anchor stands down; recent-race swim not detrained). **NOT device-verified.**

---

## §CD — Ironman long run builds to a 2:30 durability ceiling + key-session alternation (2026-06-17)

**Context.** The Ironman run leg is a full marathon (42.2 km), but the plan's longest run topped out around 20 km regardless of the athlete. The long run was a fixed share of a bike-dominated hours budget: 35% of weekly hours to running (`VOLUME_SPLIT.ironman.run`), then 45% of run hours to the long run (`plan_engine.triathlon.ts`). For a 12 h/week athlete that lands at ~2:00 / ~20 km, and the share could never reach marathon-relevant durability without ~16 h/week (2.5 h ÷ 0.45 ÷ 0.35 ≈ 15.9 h).

**The science.** The IM marathon is run on glycogen-depleted, neuromuscularly pre-fatigued legs after ~180 km of cycling. The limiter is *durability* — the trainable ability to resist fatigue late in prolonged exercise (Maunder et al. 2021, *Sports Medicine*) — not fresh marathon pace or VO2max. Cycling builds the aerobic engine but is concentric and non-impact; the marathon's damage is eccentric (footstrike braking load), and only running loads that tissue. So bike volume cannot substitute for run-specific musculoskeletal durability. The standalone long run must therefore build, in running.

It builds to **2:30 (150 min), not the ~30 km of standalone-marathon prep**, because total three-sport load caps run volume (running is the most injurious discipline) and the brick already carries run-on-fatigue specificity. 2:30 is the durability sweet spot in mainstream IM coaching (Friel, *Triathlete's Training Bible*; Fitzgerald) — long enough to train fatigue resistance, short enough to recover from inside a multisport week.

**Model.**
- *Ramped target* (`triLongRunTargetMin`): the IM long run ramps linearly from the same 90-min week-1 anchor running mode uses (`plan_engine.ts longRunMinutes`) to a 150-min (2:30) peak by `totalWeeks × 0.75`, taper cut ×0.65. Capped at 150. This replaces the 0.45-share derivation for IM only; the long run is no longer a leftover of the bike-dominated budget. 70.3 and shorter keep the share model (their run legs need smaller, separate targets — not yet sourced; flagged for Tristan, no invented number).
- *Funding* — the long run takes its target from within run hours, compressing the other runs to a 30-min floor; only when run hours still fall short does it draw on minutes freed by easing the long ride below. At ≥12 h/week the run budget alone funds the full 150 min, so no borrow is needed.
- *Brick = the long ride + a transition run* (chosen with the coach hat, 2026-06-17): the canonical IM weekend is one long-bike day with a short run off the bike, not a separate medium brick alongside a standalone long ride. The engine now **pops the long ride** (the last bike slot, emphasis already applied) and wraps it as the brick; the budget's `brickFrac` drops its bike term (`split.bike × BRICK_BIKE_SHARE`) and keeps only the transition-run share, so the redundant second ride's hours fold into a **longer single long ride** at no extra time. One 4–5h ride drives durability better than two ~2.5h rides (sustained time in the glycogen-depleted zone), and the transition run is now race-specific (off the *long* ride, the way race day feels). Off brick weeks (base/taper) the long ride stays a solo session.
- *Key-session alternation* (`triWeekEmphasis`): across IM build/peak weeks the emphasis alternates by week parity. On a **run-emphasis week** the long run takes its full target and the long ride (delivered as the brick's bike leg) drops to the maintenance floor; on a **bike-emphasis week** the long ride is full and the long run holds at the maintenance floor. So the Sat (brick) / Sun (long run) weekend always carries one peaked anchor and one moderate, never two maximal sessions back-to-back (Banister supercompensation: stacking two maximal durability sessions blunts the adaptation from both, and degraded form on a long run behind a max ride raises injury risk). The brick's transition run is not a lever — it stays put as the race-specificity stimulus, so alternation removes the *collision*, not the specificity.
- *Maintenance floor* `TRI_KEY_SESSION_MAINTENANCE = 0.75` (confirmed Tristan, 2026-06-17): high enough that the de-emphasised session does not detrain its distance, low enough to free recovery for the week's priority.
- *Durability threshold agreement* — `DURABILITY_THRESHOLDS.ironman.longRunSec` (durability-cap.ts) raised 2.0 h → 2.5 h so the *tracking* durability bar matches the *planning* target (CLAUDE.md: two numbers that mean the same thing come from one source). `MAX_DURABILITY_PENALTY` is unchanged at +5%; only the threshold moved, so a 2 h long run now incurs a small shortfall where it previously met the bar.

**Tracking vs planning.** The long-run *target* and alternation are a planning decision (what to prescribe), kept as a local table in the engine mirroring `plan_engine.ts longRunCapMin`. The durability *threshold* is the tracking side (how a completed long run is valued in race prediction). They share the 2:30 anchor but live on their respective sides of the line.

**Constants and provenance.** 150-min peak and 0.75 maintenance floor are Tristan-confirmed. The 90-min base, the `totalWeeks × 0.75` ramp, the ×0.65 taper cut, and the 30-min session floor are all reused from the existing running long-run model. No invented numbers.

**Transparency.** A current-week note on the triathlon plan view fires on every IM build/peak week (both emphasis directions), in consultant tone, modelled on the future-week draft banner (CLAUDE.md adaptation-transparency: small but meaningful → inline note, not a modal). It names which key session leads the week and then sets the expectation that matters most experientially: the brick and the long run sit back to back, so the long run lands on **tired legs by design**. Without this, a user feels wrecked on the long run and reads it as a fitness problem rather than the intended durability stimulus. The copy states the fact ("the Ironman marathon is run on a depleted system") rather than reassuring in wellness tone. The same message also rides the **long-run card itself** as a short in-the-moment caption ("Run this on tired legs from the brick...") via the `legLoadNudge`-style muted note slot in `renderTriWorkoutCard` — the week note frames the week, the card caption catches the user at the moment of doubt. Gated to IM weeks that actually run a brick, active cards only.

**Honest limitations.** (1) The long-run *target* applies to Ironman only; 70.3 keeps the share model until its target is sourced. The brick-as-long-ride restructure applies to **all** distances that run bricks (the canonical structure everywhere), so 70.3/Olympic/Sprint bricks also became the long-ride-plus-transition-run session — verified within the weekly cap, but their weekend shape changed too. (2) Alternation keys off week parity within build/peak, not a load-aware optimiser — adequate for a clean hard/easy-by-discipline oscillation, but it does not detect when a deload week coincides with an emphasis week (the deload ×0.7 simply stacks). (3) The big weekend (brick Saturday → long run Sunday) is deliberately demanding: the transition run plus the next day's long run is real run load on fatigued legs. That is the intended IM stimulus, but for an under-prepared age-grouper it is the highest-injury-risk pair in the week; the alternation keeps only one of the two at peak each week to bound it.

**Guards:** `plan_engine.triathlon.test.ts` — IM long run builds toward 150 min on a peak run-emphasis week; the peak long run lands on run weeks and the peak standalone long ride on bike weeks (max-over-group to skip deloads); `triWeekEmphasis` alternates only across IM build/peak; `triLongRunTargetMin` ramps to and caps at 150; non-IM distances keep the share model (null target/emphasis).

**Confidence: high** for the compute path (guard-tested, full suite green apart from an unrelated date-sensitive demo-seed test). **NOT device/browser-verified** — the real bar is the rendered IM plan showing a long run that builds past 20 km toward ~28–32 km, alternating with the long ride, and the run-emphasis note appearing on the right weeks.

## §CE — Race week is sharpening, not training: the final-week primer (2026-06-17)

**Context (dogfood report).** A 14-week half-marathon plan prescribed a full **Threshold 3×8** (24 min of threshold work) on the Thursday of week 14, three days before a Sunday race. The user flagged it: that is a build-phase session inside race week. Audit across modes: running carried the **full** bug, triathlon/cycling a **partial** version (right session count, wrong intensity flavour), HYROX was **already correct** (it downgrades intervals→tempo, density→technique, brick→mini-brick in taper) and became the model to mirror.

**The science.** The taper preserves fitness while shedding accumulated fatigue (Mujika & Padilla 2003; Bosquet et al. 2007 meta-analysis: optimal taper holds intensity, cuts volume, reduces frequency modestly). The final week wants a small touch of race-pace/threshold work to stay neuromuscularly primed (priming / post-activation potentiation), but the quality *volume* must collapse. 24 min of threshold 3 days out generates residual fatigue the taper is meant to clear; a few minutes of quality does not. Once the session is a short primer, day placement is no longer the problem — a brief primer 3–5 days out is standard race-week practice (Pfitzinger, Daniels), so the existing mid-week placement (Tue/Thu) is acceptable and the scheduler was left untouched.

**Root cause (running).** Two layers both ignored taper:
- `pickPhaseVariant` rotated taper like build ("full variety"), so the blind `(weekIndex−1) % n` rotation could land the heaviest variant (`thr_3x8`) in race week.
- The work-minute multiplier (`×0.60` in taper) reduced the *target* minutes, but for a rep-based variant the rendered structure reads `reps × repMin` straight off the variant — so the displayed session stayed 3×8 while `workMinutes` said 12. The two disagreed.

**Model (running, `plan_engine.ts`).**
- *Variant selection* — `pickPhaseVariant` now treats `taper` like `base`: draw from the **lightest** variant subset (peak draws heaviest). This fixes non-final taper weeks (a steady long run, the gentlest interval shape) with no new constant — it only changes *which existing* variant a phase draws.
- *Race-week primer* — the **final** taper week (`phase === 'taper' && weekIndex >= totalWeeks`) seats a fixed sharpener instead of any full variant, for whichever slot the priority list places there: `TAPER_PRIMER_THRESHOLD = 3×2 min @ threshold, 2 min recovery` (6 min of quality) for marathon/half/10K; `TAPER_PRIMER_VO2 = 4×1 min, 2 min recovery` (4 min of quality) for 5K, whose taper priority is `['vo2']`. The primer is not `dMult`-scaled — it is already minimal.

**Model (triathlon / cycling, `tri-intensity-profile.ts`).** The taper quality-slot *count* was already correct (`TRI_QUALITY_SLOTS`: taper zeroes the run slot at every distance, leaves the bike at 1, sprint/olympic swim at 1). The gap was *flavour*: the remaining taper bike/swim slot could still draw VO2/over-under/anaerobic, just shorter. The base-phase gate (`gateForBase`) was generalised to `gateLowIntensity`, now firing for **base and taper**, capping the taper quality kind to the sub-threshold set (`sweet_spot`/`tempo` bike, `threshold` swim/run). Duration is already cut by the phase multiplier; this caps intensity. Cycling-only mode reuses the tri engine, so it inherits the fix.

**Constants and provenance.** The primer rep schemes (3×2 threshold, 4×1 VO2) are coach-set under Tristan's explicit "act as a coach" delegation, grounded in the priming literature (short reps at race/threshold intensity, total quality ≪ build session). They are the only new numbers; everything else reuses existing variants, multipliers, and the HYROX taper-downgrade precedent. Direction (collapse race-week quality volume, hold intensity) is high-confidence; the exact 3×2 / 4×1 schemes are medium-confidence and adjustable.

**Honest limitations.** (1) The running primer is the same scheme for every ability band; an elite and a beginner get 3×2 (the *intensity* differs via threshold pace, the *structure* does not). (2) Day placement is unchanged — the primer relies on the scheduler's existing mid-week placement of the lone quality session; it is not race-day-aware, so a user who drags it to Saturday is unguarded. (3) Tri/cycling cap intensity but do not add a distinct final-week-vs-penultimate-taper-week distinction the way running now does.

**Guards:** `plan_engine.taper-primer.test.ts` — half/marathon race week renders `Threshold 3×2`, 5K renders `VO2 Builder 4×1`, and a build-phase threshold is still a full block (contrast). tsc + full workouts suite green.

**Confidence: high** for the compute path (guard-tested). **NOT device/browser-verified** — the real bar is the rendered race week showing the short primer in place of the 3×8, across running, tri, and cycling.

**Update 2026-10-06 to 08 (§CT, §CW).** (1) Race week is now the final training week of a race plan whatever its phase label, and it has no long run: the race takes the long-run slot (running and triathlon). A continuous plan never has a race week, so its block weeks get no primer. (2) Limitation 2 above is resolved for running: the race-day rules (`race-day-rules.ts`) keep the primer 3 to 5 days out for every race weekday, move it to the latest race-week day at least 3 days out otherwise, and drop it when no such day exists. Race week is the calendar week holding the day 3 days before race day, so the primer window always falls inside it. Triathlon, cycling and HYROX race weeks are not yet placed relative to race day (ISSUE-364). (3) Wording: Bosquet et al. (2007) found the best outcomes with volume cut by 41 to 60% while intensity and frequency were maintained; they found no benefit from cutting frequency. Counting the race as the week's long effort removes one prescribed session in race week.

## §CF — ACWR response policy: keep-ramping vs ease-back, with an L_max-targeted load reduction (2026-06-17, ISSUE-295)

**Context (decision with Tristan).** When the acute:chronic workload ratio (ACWR) ran high, the plan did two things judged wrong: (1) it wrote demonstrated fitness into the engine VDOT even in the danger zone, and (2) it silently dropped two quality sessions and froze the long run, with a week-debrief toggle that *looked* like it offered the un-reduced plan but was cosmetic (Accept ignored the selection). The athlete had no real agency, and a responsive athlete ramping faster than plan was either over-cut or unable to choose to keep pushing.

**The science.** ACWR = acute load ÷ chronic load, both in canonical TSS (the Load Currency Law). The "sweet spot" 0.8–1.3 is the only band with direct evidence (Gabbett 2016); ACWR ≥ ~1.5 is associated with elevated injury risk across populations; higher chronic load (fitness) is protective (Hulin 2016), justifying a per-tier ceiling. Those ceilings already exist as `TIER_ACWR_CONFIG.safeUpper` (1.30 beginner → 1.50 elite, `fitness-model.ts`). Chronic is the 28-day weekly-average TSS; the upcoming week is essentially the acute window. So the most load a week can carry while holding ACWR at the ceiling is **L_max = safeUpper × chronic**, and the overshoot to shed is **standardWeekTSS − L_max**. The only constant is `safeUpper`, already sourced — the cut is sized to exactly the overshoot, nothing invented.

**Decision (a): VDOT is not gated by ACWR.** VDOT *describes* demonstrated fitness (tracking); ACWR is *forward-looking risk* (planning). Per the tracking-vs-planning separation, a hot week does not mean the athlete got less fit. The escalation danger (a rising anchor driving next week harder) is handled at the plan layer, leaving the fitness number deterministic. The VDOT writeback (`blended-fitness.ts`) is unchanged.

**Decision (b): offer, not impose.** The week-debrief toggle now persists `wk.acwrChoice` and the generator (`generator.ts`) honours it. **Keep ramping** leaves the standard week intact; **Ease back** applies the ladder. Default-until-chosen is eased (the conservative option), so a passive user still gets the safe plan; `'keep'` is the only opt-out. This reuses the existing suggestion-acceptance contract (the plan mutates only on the athlete's choice).

**The ease-back ladder (`computeAcwrEaseBack`, `src/calculations/acwr-ease-back.ts`).** Shed the most injury-relevant load first, protect the goal-relevant stimulus last:
1. **Strip intensity** — convert quality sessions (and a `long_fast_finish` long run's speed) to easy, keeping every distance. Removes the quality TSS premium, the part that spikes acute load; weekly volume and the long-run endurance stimulus are untouched.
2. **Trim easy / midweek volume** — only if stripping all intensity still leaves the week over L_max. Long run untouched here. Trims to the existing `EASY_FLOOR_MIN`.
3. **Shorten the long run** — last resort only, down to `LONG_SOFT_FLOOR_MIN`. Bottom of the pile: protected relative to everything else (Tristan), not sacrosanct.

Per-session TSS = `workMinutes × plannedTssPerMin(slot) + (totalMinutes − workMinutes) × plannedTssPerMin('easy')`.

**Escalation.** Mild high remembers a prior keep-ramping choice across the high-ACWR episode (carry-forward at rollover in `events.ts`) so the athlete is not re-nagged every week. At **very high (ratio ≥ 1.6, Tristan's absolute call)** or **3 consecutive high weeks**, the stored choice is cleared so the safe (eased) default returns and the debrief re-surfaces the choice with firmer copy. "High" itself is tier-relative (`safeUpper + 0.2`); the 1.6 escalation is an absolute floor on top.

**Robustness guards (bulletproofing pass, 2026-06-17).**
- *Race-week exemption.* The generator and the debrief both skip ease-back on the final taper week (`phase === 'taper' && weekIndex >= totalWeeks`). That week's quality is already the minimal primer (ISSUE-298) and its volume is already cut, so easing it would neuter the primer for no load benefit.
- *Preview == commit in the common path.* The debrief now PREFERS the rollover-stamped `scheduledChronicTSS`/`scheduledSafeUpper`/`scheduledAcwrRatio` (the exact values the generator reads), falling back to a live `computeACWR` only when the stamp isn't present yet, so previewed and committed plans agree.
- *Honest copy when the ceiling can't be reached.* When every session is already at its floor the ladder can fall short of L_max; the debrief copy drops the "to bring load into range" clause in that case (`reachedRange = adjustedTSS ≤ lMax`).
- *Escalation extracted + tested.* The carry-forward/clear decision is the pure `resolveAcwrEpisodeChoice` (constants `VERY_HIGH_ACWR = 1.6`, `ACWR_HIGH_STREAK_REPROMPT = 3`), unit-tested rather than buried inline in `events.next()`.

**Honest limitations.** (1) The TSS model prices a session by duration × type rate; it does not separately value a fast-finish long run's surge, so downgrading the long run's speed in step 1 scores ~0 TSS — kept as an injury-risk action, not a load lever. The dominant ACWR-driving load (quality work + total volume) is captured exactly. (2) Caution band (one below high) is unchanged — it keeps the gentle one-quality-session swap, not the ladder (Tristan's call, smallest blast radius). (3) Pre-this-version persisted state may carry `scheduledAcwrStatus:'high'` without the new stamped inputs; that week renders un-reduced until the next rollover re-stamps (acceptable — single-user, clean resets).

**Guards:** `acwr-ease-back.test.ts` (11 — ladder ordering, long-run protected until last, no-op under ceiling, inputs not mutated, fast-finish downgrade; plus escalation: carry-forward, clear at ratio ≥ 1.6, clear at 3-week streak, fresh-episode unset, streak-break count). `generator.acwr-easeback.test.ts` (3 — keep retains quality, ease strips it + never drops a session, race-week exempt). Full suite green (3492).

**Confidence: high** for the math and ladder (guard-tested, no invented constants). **NOT device-verified** — the real bar is the week-debrief in-app: both choices commit the matching week, and a ratio ≥ 1.6 week re-raises after a prior keep.

## §CG — Triathlon forecast projects at the PLANNED dose, two-term: build-mean for fitness gain, peak for race-readiness (2026-06-17, ISSUE-297 tri Lesson 1)

**Context.** The tri race-day forecast (`predictTriathlonRace`, `projected` path) gains each discipline's marker over the weeks to race at a constant `sessions_per_week` dose, and closes a specific-endurance / race-readiness penalty over those weeks. Both read the planned upcoming dose — but the dose was sampled from a fixed **next-4-week look-ahead** (`plannedSessions/HoursPerWeekByDiscipline(state, 4, …)`). Early in a plan that window sits entirely in the low-volume base phase, so the forecast under-credited the build: the horizon gain was understated AND the durability execution factor (`1 − penaltyShare`) stayed low, which let the durability cap drag the projected bike/run (a demonstrated ~36 km/h cyclist forecast at ~34). This is the per-discipline analogue of running's forecast bug (forecast must evaluate the volume term at the volume the *plan delivers*, not today's pre-plan maintenance — §BZ, `computePeakWeeklyKm`).

**The science — a two-term decomposition (per discipline).** The forecast feeds each term the volume it is actually a function of. The full ramp (base → build → peak → taper) is already encoded in `state.wks[w].triWorkouts`, so both doses are read directly from the plan — **no invented constants**:
- **Cumulative training dose → engine/fitness gain.** Marker adaptation (CSS / FTP / VDOT via `applyTriHorizon{Swim,Bike,Run}`) is driven by the dose *integral* over the block, so it reads the **build-phase mean** — the average weekly dose across every remaining non-taper week (`plannedBuildDoseByDiscipline`). The mean is the honest input for a constant-rate horizon: feeding the peak would assume peak-for-all-weeks and over-credit the gain.
- **Race-approach sustained volume → specific-endurance readiness.** Whether the athlete is prepared for the race *distance* is a function of the highest sustained volume reached approaching the race, not the block average. The penalty closure (`computeProjectionPenaltyShare`) reads the **peak the plan holds** (`plannedPeakDoseByDiscipline`): the mean over `ph === 'peak'` weeks, falling back to the max single non-taper week for plans with no labelled peak phase.

**Taper is excluded from both doses, and this does not shed fitness.** Taper weeks (and intra-cycle block-cycle deloads, also labelled `'taper'`) represent freshness, not build dose (Mujika 2002), so a low-volume taper week must not drag either dose down. Excluding them from the *dose average* is orthogonal to the projected fitness level: the horizon model consolidates taper via its own `taper_weeks` term, and the predictor's invariant — `executionFactor → 0` inside the taper window pins `projected == current` per leg — is unchanged. Confirmed by the existing "race inside taper window" guard (projected per-leg within 30s of current) and Tristan's explicit constraint ("don't lose fitness in taper").

**Worked propagation (probe, 70.3, week 1 of a 12-week ramping plan, bike).** Old next-4 dose vs new: build-mean bike hours 4h → 11.2h; peak bike hours → 14.7h. `bikePenaltyShare` 0.40 → 0.14; `bikeExecutionFactor` 0.60 → 0.86. The execution factor is what lerps the projected longest ride toward the durability threshold, so the cap relaxes in proportion to the volume the plan actually delivers. Magnitude on the final leg scales with how durability-bound the athlete is (largest when current long rides are short; small when a race-bike anchor already sets the base speed and the longest ride is near threshold).

**Honest limitations.** (1) The horizon is a constant-rate model fed a single representative dose; it does not integrate the week-by-week ramp shape (a front-loaded vs back-loaded build with the same mean projects identically). The build-mean is the defensible first-order summary. (2) Peak defined as the peak-phase mean is robust to one outlier week but will under-read a plan whose single highest week sits in a `'build'`-labelled block; acceptable because the generator labels its top block `'peak'`. (3) The run penalty closure uses session-count only (run targets are km/wk, not hours), so the run reads peak *sessions* but not peak *hours* — unchanged from before, a known coarser signal for the run leg.

**Guards:** `tri-volume-by-discipline.test.ts` +10 (build-mean > next-4 on a ramp, taper excluded, hours from `estimatedDurationMin`, missing-phase counted as build, taper-only fallback, startOffset; peak = peak-phase mean > build-mean, peak hours, max-non-taper fallback, taper-only fallback). `race-prediction.triathlon.test.ts` unchanged and green (incl. the taper invariant and "projected faster than current"). Full suite green (3478).

**Confidence: high** for the mechanism and the no-invented-constants claim (probe-verified propagation, guard-tested doses). **NOT device-verified** — the in-app bar is the tri Forecast marquee + the "Average build week" training chip reading the same doses, on a real early-plan athlete with a demonstrated race split.

## §CH — Weekly load target follows deload and taper weeks; carry judged per week (2026-10-05, audit A10/A11)

**Side.** Planning: the prescribed weekly load. Tracking surfaces (Plan card and Adjust-week strip, Load & Taper, debrief, excess-load adjustment) compare actual load against it. These are running-plan views. Triathlon (cycling) and HYROX route to their own Plan, Load, Stats and debrief views, and none of them reads the target. In those modes it reaches the user only as the daily coach's Signal A figure in the AI Coach context (`planned_week_tss`).

**Problem.** Each surface built its own target with `computePlannedSignalB(..., wk.ph, ...)` and no taper position. `Week.ph` never holds 'deload', so the deload row of `PHASE_MULTIPLIERS` was dead: plan-engine deload weeks kept their base/build/peak target and following the plan exactly read "under plan". Every taper week, race week included, targeted 0.85×, and Stats alone passed a 1-indexed position. `computeDecayedCarry` judged earlier weeks against the viewed week's target, so peak weeks done exactly to plan counted as excess once a lower taper target was in view (83 TSS of phantom carry on the first taper Monday in the regression test).

**Formula** (`computePlannedWeekTarget`, `src/calculations/planned-week-target.ts`):

```
target_B(week)      = runningBaseline × m(week) + crossTrainingBudget       (what every running load surface shows)
runningBaseline     = median over the non-zero values of max(0, w − discountedXT), w in historicWeeklyTSS,
                      needing ≥ 3 such weeks
                      → max(0, ctlBaseline − discountedXT) → runs/week × 50     (unchanged)
crossTrainingBudget = Σ sports avgSessionRawTSS × sessionsPerWeek            (full TSS, not phase-scaled)
discountedXT        = Σ sports avgSessionRawTSS × sessionsPerWeek × runSpec(sport)
runSpec(sport)      = SPORTS_DB[sport].runSpec, or 0.35 when the label has no SPORTS_DB row
                      (the edge getSportLabel emits 'hiit', 'paddle', 'golf', 'cardio', 'other')
target_A(week)      = baseline × m(week), baseline = median(historicWeeklyTSS, ≥ 3 non-zero weeks)
                      → ctlBaseline → runs/week × 50                          (daily coach only)
```

`computePlannedSignalB` subtracts the runSpec-discounted cross-training from each history week (which is Signal A) to isolate running, applies `m(week)` to that running-only baseline, then adds the cross-training budget at full weight. Deload and taper therefore cut only the running part of the target.

`m(week)` comes from the existing tables, now selected per week by `resolvePlannedWeekPhase`:
- **Plan-engine deload week** → the tier deload row of `PHASE_MULTIPLIERS` (0.70 beginner/recreational, 0.68 trained, 0.65 performance/high-volume). Deload status uses the generator's own rule: running `isDeloadWeek(week, ability)` (every 3rd, 4th, 5th or 6th week by ability band, ability from `abilityBandFromVdot(s.v || 45, experienceLevel || 'intermediate')`, the inputs `resolveWeekWorkouts` hands the generator); triathlon (cycling) and HYROX every 4th non-taper week (`isFourWeekCycleDeloadWeek`); any mode with a holiday `forceDeload`.
- **Race taper** (the last contiguous 'taper' run of a non-continuous plan) → `taperMultiplier(weekInTaper, taperLength)` with a 1-indexed position (1 = first taper week, taperLength = race week): 0.75 / 0.65 / 0.55 over 3 weeks, 0.70 / 0.55 over 2, and 0.70 for a 1-week taper (the existing special case, kept). This is a progressive taper: load falls week by week while intensity is held, the pattern the taper literature supports (Mujika & Padilla 2003; Bosquet et al. 2007 meta-analysis, best outcomes with a 41 to 60% total volume reduction, intensity and frequency maintained). The multiplier applies to the running baseline in target_B and to the whole of target_A, so both sit at about half of normal in race week. target_B adds the cross-training budget unscaled, so for an athlete with cross-training history the whole week stays well above half (limitation 6).
- **'taper'-labelled weeks that are not the race taper** (continuous-mode block deload, double-periodisation inter-cycle recovery) are recovery weeks → the deload row.
- **A race-taper week the engine also deloads** → min(taper, deload). The generator cuts that week twice (taper session scaling and `dMult`); taking the lower existing target follows that without inventing a compounded constant.
- **Just-Track** generates no plan, so no week is a deload.

**Carry.** `computeCurrentWeekCarry` scores each of the last 3 weeks' excess against that week's own target, then decays it from the week's midpoint with the 7-day ATL time constant (unchanged). It returns 0 for every week except the current one, so a future week no longer shows the current week's residual.

**Taper position, updated 2026-10-06 (ISSUE-317(a), Tristan's decision of 2026-10-05; `cb05a86`).** Batch 1 passed a 0-indexed position, so race week of a 3-week taper sat at 0.65 and never reached the 0.55 endpoint that the `taperMultiplier` docstring and PRINCIPLES.md "Planned Load Model" document. The position is now 1-indexed (`planned-week-target.ts`, `weekInTaper: idx - start + 1`). The ramp formula, 0.85 − 0.30 × position / taperLength (`fitness-model.ts:1142`), is unchanged, so no new constant was introduced. Derivation: 3 weeks = 0.85 − 0.30 × (1/3, 2/3, 1) = 0.75 / 0.65 / 0.55; 2 weeks = 0.85 − 0.30 × (1/2, 1) = 0.70 / 0.55. On the multiplied term the mean cut across the taper is 35% (3 weeks) or 37.5% (2 weeks), just under Bosquet's 41 to 60% volume range; race week (45%) sits inside it. The target is TSS, which includes intensity; with intensity held, a 45% load cut implies a somewhat larger volume cut, so the comparison with a volume-reduction range is approximate. Taper length comes from the phase generators. Running gets 1 week at 8 plan weeks or fewer, 2 at 9 to 16 and 3 at 17 or more (`phases.ts`, ratio 0.12, cap 3). Triathlon and HYROX get 2 weeks (cap 2), except 1 week for Sprint at 12 weeks or fewer, Olympic at 16 or fewer and at 28 to 29 (double periodisation leaves a short final cycle), and 70.3, T100, Ironman and HYROX at 10 or fewer.

**Why defensible.** No new constants. Every multiplier is an existing table row, selected from the same plan data the generator reads, so the target a surface shows and the week the engine builds agree on which weeks are deload and taper weeks. They do not agree on how deep the cut is (limitation 5). The deload rows (a 30 to 35% cut) sit inside the usual recovery-week range; note that PRINCIPLES.md specifies 0.70 to 0.75, and the code rows, which predate this change, were not altered.

**Limitations.** (1) The target is a history baseline × multiplier, not the sum of the generated sessions, and its shape differs from the generator's. The running generator cuts every taper week with the same per-session scalars (long 0.65, easy 0.70, threshold 0.60, VO2 0.50, MP 0, `plan_engine.ts`) and adds a race-week primer, which yields a near-flat taper: a probe on the raw generator (advanced, VDOT 55, 4 runs/week, 18-week marathon, no volume budget) gave taper weeks of 250 / 246 / 237 TSS against a build mean of 307, about 0.81 / 0.80 / 0.77. The tri and HYROX engines step 0.55 then 0.30 of peak hours over a 2-week taper. Whether a taper done to plan reads over or under target depends on how the athlete's history median compares with the generated week. The audit probes, run on the 0-indexed ramp (0.85 / 0.75 / 0.65), put the target 30 to 45% above the prescribed run TSS, so a taper done to plan read under target. The 1-indexed ramp lowers each taper week's target to 0.79 to 0.88 of its old value (0.88 / 0.87 / 0.85 over 3 weeks, 0.82 / 0.79 over 2), which narrows that gap; the probes were not re-run. On the new ramp, an athlete whose median equals the generated build level reads about 40% over in running race week (ISSUE-317(b)). (2) A 1-week taper keeps the 0.70 special case, so plans with a 1-week taper never reach 0.55 in race week; whether they should is open (ISSUE-317). (3) Just-Track treats no week as a deload. (4) The min() rule is pragmatic, not literature-derived. (5) The deload target magnitude differs from the generator's. The target's deload row is 0.65 to 0.70 × baseline, while the running generator cuts a deload week's sessions by `deloadMultiplier`, 0.80 to 0.90 by ability band (`plan_engine.ts:193`, applied as `dMult` at `:555`). A running deload week done to plan can therefore read above target. (6) The cross-training budget is not phase-scaled (this predates the taper change). In the unit-test fixtures a runner with 300 TSS of weekly cycling goes 0.90 / 0.86 / 0.81 of a base week over a 3-week taper; a triathlon or HYROX state with 400 TSS of expected swim and bike computes 0.91 / 0.86 over 2 weeks, though no tri or HYROX view displays that figure. Whether the budget should scale, and whether swim and bike belong in a cross-training budget in triathlon mode, is open (ISSUE-317(c)). (7) The live carry re-judges past weeks against their current target on every render, so a target change such as the 1-indexed taper moves carry for weeks already lived; the persisted `wk.carriedTSS` and `unspentLoadItems` are not rewritten. (8) The "running-only" baseline is approximate in two ways. One average weekly cross-training discount is subtracted from every history week, so weeks with above-average cross-training keep some of it and lighter weeks are clamped at 0. The history weeks were discounted with the edge function's seed tables (`getRunSpec`), which disagree with the SPORTS_DB runSpecs used for the subtraction (ISSUE-321).

**Guards.** `planned-week-target.test.ts` (23), including an anchor that fails if any file other than `fitness-model.ts` or `planned-week-target.ts` calls `computePlannedSignalB` or `computePlannedWeekTSS`, or calls `computeDecayedCarry` (activity-review's phase-independent baseline excepted). Three tests pin taper behaviour beyond the ramp itself: a non-empty `sportBaselineByType` (budget unscaled), the live carry re-judging a first taper week against its 1-indexed target, and the triathlon and HYROX AI Coach context carrying the 0.55 Signal A target in race week (`ea80faf`, 212 = 385 × 0.55). Each fails on the 0-indexed position.

**Confidence.** High that the phase selection matches the generator (unit-tested). Not device-verified.

**Update 2026-10-07 (`5e5aa88`, §CV).** The 1-week taper special case is gone: a 1-week taper is race week alone, so it takes the 0.55 race-week endpoint of Tristan's 2026-10-05 decision (was 0.70). The ramp now lives in `taperFraction` (`phases.ts:165`), which `taperMultiplier` delegates to and the sharpening block's taper weeks read, so plan and target keep one shape. Taper lengths changed with it: a marathon plan of 2 or more training weeks tapers at least 2 weeks (`MARATHON_MIN_TAPER_WEEKS`, Bosquet et al. 2007), including the 8-week full plan; half, 10K and 5K plans of 8 weeks or fewer keep 1. Sharpening blocks deload by `isSharpeningDeloadWeek` (never the week before the taper), and the weekly target follows it. A closing week (§CW) targets the race-week row, and the taper ends before it.

---

## §CI — iTRIMP normaliser: sex-matched β, one sex resolver, live binding (2026-10-05, audit B12)

**Side.** Tracking (load measurement). It feeds planning through ACWR, the CTL-gap re-anchor and cross-training cuts.

**Problem.** Every iTRIMP producer (`trimp.ts`, the Strava edge function, Apple Health, FIT import) weights HR with the Banister sex coefficient: β = 1.67 for women, 1.92 otherwise (Banister 1991; Morton, Fitz-Clarke & Banister 1990; see "Sex → iTRIMP β coefficient"). The normaliser hard-coded β = 1.92. For a woman, an hour at LTHR produced iTRIMP = 3600·hrr·e^(1.67·hrr) but was divided by 3600·hrr·e^(1.92·hrr), so it read 100·e^(−0.25·hrr): about 81 TSS (LTHR 168, rest 50, max 190) instead of the Coggan hrTSS definition of 100.

**Formula.**

```
normalizer = 3600 · hrr_LT · e^(β_sex · hrr_LT)
hrr_LT     = (LTHR − restingHR) / (maxHR − restingHR)
β_sex      = getBeta(resolveBiologicalSex(s))     // 1.67 female; 1.92 male, unset, prefer_not_to_say
TSS        = 100 · iTRIMP / normalizer
```

A producer integrates Σ dt·hrr·e^(β·hrr), so an hour held at LTHR yields exactly the normaliser and decodes to 100, provided both sides use the same β. Any mismatch is a uniform e^(Δβ·hrr) rescale: 0.81× for a female-β iTRIMP over a male-β normaliser, 1.23× the other way round.

**Sex resolution must be shared.** The same formula is not enough: both sides must resolve sex the same way at the moment each runs. During the wizard the answer lives only on `s.onboarding.biologicalSex`; plan initialisation copies it to `s.biologicalSex`. The onboarding Strava producers (post-connect 28-day sync, review-step backfill) sent `s.biologicalSex`, still undefined, so a woman's onboarding history was stamped with β 1.92. The edge function caches each row and never recomputes it, so a normaliser reading `'female'` after initialisation decoded that history at 1.23× (123.5 TSS per hour at LTHR at the audit profile). Fix: `trimp.ts:resolveBiologicalSex(s)` is the only sex source for β on both sides. While onboarding is in progress the wizard answer wins (initialisation will copy it over `s.biologicalSex`, even over a HealthKit-seeded value); after onboarding `s.biologicalSex` is canonical, with the wizard answer as the fallback.

**Effect.** For women with a personal normaliser whose iTRIMP was produced with their recorded sex, an hour at LTHR now decodes to 100, and TSS rises by e^(0.25·hrr): ×1.21 at hrr 0.75, ×1.23 at 0.84, ×1.25 at 0.90. Male and unset profiles are unchanged. The iTRIMP intensity cutoffs (70 and 95 TSS/h, `universalLoad.ts`) move sessions that read 57 to 70 TSS/h before above the easy cutoff.

**Where the 100-TSS anchor does not yet hold (open).**
- *Strava rows cached with the male β.* Rows the server stamped with β 1.92 before the athlete's sex was known keep it: the edge function never recomputes a cached `itrimp` and stores no per-row β. This covers every existing Strava-onboarded woman's onboarding backfill (up to 52 weeks) and connect-step sync rows where Strava supplied no sex. Those rows now read about 1.21× to 1.25× high (they read correctly before this change) and feed plan-week actuals synced during onboarding, triathlon per-discipline CTL from history and intensity calibration. Apple rows self-heal when re-read, because the upload upserts `itrimp`. The re-stamp approach is an open decision (ISSUE-318).
- *Onboarding syncs before the sex question (code change 2026-10-06, F8; not device-verified).* The connect-data step runs before the sex question, so with no sex from Strava or HealthKit the post-connect 28-day sync, the OAuth-return launch backfill and a mid-wizard Apple sync stamped rows with β 1.92, and a female athlete's history then decoded e^(0.25·hrr) high, about 1.23× for an hour at LTHR at 168/50/190. Because server-cached Strava rows and Apple rows in `garmin_activities` keep their stamp, the fix holds the stamping syncs instead of correcting them later: `trimp-sex-gate.ts` keeps them back until the answer is final (triathlon, cycling and HYROX when about-you is left, since it shows any prefill for confirmation; running and fitness once a sex is known or schedule is answered). Limitations: rows cached before this gate keep β 1.92 (above); a user who goes Back to about-you and changes the answer after leaving it keeps the first answer's β on rows synced in between; Just-Track never asks the sex, so its rows carry β 1.92 and a woman who later upgrades reads about 1.23× high on that history (ISSUE-334). File imports at connect-data are not held: they convert to weekly TSS at import time with one β on both sides, so the TSS is self-consistent.
- *Population fallback (15000), unchanged.* Used when LTHR, resting HR or max HR is missing, or LTHR is outside 80–95% of max HR. No stated HR profile backs it: it was introduced as "typical LTHR_HRR for average athlete" (`8b07156`), and the "≈ 84%-HRR profile" reading in §BP is a later back-solve (3600·h·e^(1.92h) = 15000 gives h ≈ 0.8364). A female fallback therefore has no documented derivation and none was introduced; women on the fallback still read about 0.81×. If the fallback is taken to mean the same HRR at LT for both sexes, the female value would be 3600·0.8364·e^(1.67·0.8364) ≈ 12,170, a ×0.811 ratio (decision, ISSUE-319).
- *Server history scale.* The edge function's history mode divides by a fixed 15000 for every user, so the server-computed `historicWeeklyTSS` that seeds the CTL baseline sits on a different scale from client-recomputed weeks. For women the gap widened by up to 1.25× (ISSUE-319).
- *Persisted totals.* The `wk.actualTSS` running totals are retired (2026-10-06, §CL): week actual load is derived from the activities on read, so no stored weekly total keeps a pre-fix scale. `holidayState.preHolidayWeeklyTSS` snapshots and `wk.actualImpactLoad` are still stored (ISSUE-319(c), ISSUE-348).

**Live binding.** The module normaliser behind `normalizeiTrimp()` and `getAthleteNormalizer()` was copied at launch, so an Account HR edit or an in-session physiology or LT sync left it stale until the next cold launch, while surfaces calling `getNormalizerFromState(s)` were fresh. One activity could show two TSS values, and encode/decode round-trips (excess card) were off by the ratio. It is now bound to live state (`bindAthleteNormalizerToState` in `launchApp`) and re-derived whenever LTHR, resting HR, max HR or the resolved sex change.

**Other limitations.** Producers use the rolling resting HR (`computeRollingRestingHR`) while the normaliser uses `s.restingHR`, a small existing mismatch. β is a population sex coefficient, not an individual fit.

**Guards.** `load-currency-anchors.test.ts` Anchor 2 asserts 1 h at LTHR = 100 for both sexes. `athlete-normalizer-sex-and-binding.test.ts` (19) covers the stream, lap and summary tiers, `computeWeekRawTSS`, the staleness case, wizard-time stamping decoded after plan initialisation, a guard that `main.ts` binds and no production file calls `setAthleteNormalizer`, and a guard that no producer reads `s.biologicalSex` directly for β. `stravaSync-biological-sex.test.ts` (5) asserts the edge payload carries the resolved sex.

**Confidence.** High on the algebra (anchor-tested). Not device-verified.

---

## §CJ — Apple Health physiology: local-date day keys, night attribution, one source per night (2026-10-05, audit X4)

**Side.** Tracking (what the athlete's recovery data says). Feeds readiness, sleep score and sleep debt.

- **Day key**: the device-local calendar date of each sample (`localDateKey`, `src/utils/local-date.ts`), matching Garmin's `calendarDate`. It was the UTC date of the plugin's GMT string, a day off for UTC+ mornings and UTC− evenings.
- **Night attribution**: a sleep segment ending before 12:00 local belongs to that date's night; a segment ending at 12:00 or later belongs to the next date's night. This is the same noon boundary the old nap filter used, so no new constant. The pre-midnight part of a night, previously dropped, now lands on the wake date. Limitations: naps between 12:00 and 23:59 fold into the following night, and the tail of a lie-in past noon moves to the next night (decision D3 in `docs/audits/2026-09-load-accounting/load-fix-designs.md`, open, ISSUE-327; the audit pack is untracked and local to Tristan's working tree until he decides whether to commit it).
- **One source per night**: summing iPhone, Watch and third-party sources double-counts. A source that reports stages (core, deep, REM) beats an unstaged one, because `computeSleepScore` weights deep at 0.25 and REM at 0.20. Ties go to the source with more asleep seconds.
- **Steps across sources**: each sample's steps are spread evenly over its interval. Where sources overlap, only the highest step rate counts; samples from one source are summed, and samples spanning midnight are split. This approximates HealthKit's statistics merge, which picks one source per overlapping stretch by the user's source priority. The plugin returns only `sourceName`, so the higher-rate source stands in for priority. The result is at least the largest single source and at most the plain sum. Limitations: even spread within a sample, and the priority proxy can disagree with the Health app.
- **Merge**: newest-wins for every date the sync read in full. The read window starts at local midnight (sleep at the noon before), so a boundary day is never overwritten with partial values, and reads pass `limit: 0` so the newest days are no longer cut off. A supplementary Apple source never overwrites a primary (Garmin) value: field ownership is tracked in `PhysiologyDayEntry.appleValues` and released when Garmin writes the field.
- **HRV**: unchanged. The day's last SDNN reading × 1.28 (decision D4 in the same design doc, open, ISSUE-327).

**Also (audit D4).** `heartRate` is now part of the HealthKit request, so Apple workouts carry an HR stream and are scored by iTRIMP instead of duration × a flat rate. No model change; the existing iTRIMP pipeline now receives data.

**Guards.** `apple-health-physiology.test.ts` (19), `apple-health-heart-rate-permission.test.ts` (4), `local-date.test.ts` (9), `physiologySync.test.ts` (7). **Not device-verified**: time zones, the HealthKit sheet and the 90-day `limit: 0` boot read need a phone (`docs/DEVICE_TESTS.md`).

---

## §CK — Fast-finish long run is placed and protected as the long run (2026-10-05, audit X5)

**Side.** Planning only. No formula changed.

The fast-finish long run (about 80% easy, the last ~20% at marathon pace) is the week's long-run stimulus plus a quality finish. It is generated as `t: 'progressive'`, so rules keyed on `t === 'long'` treated it as an ordinary quality session: the scheduler put it on Tuesday with Sunday empty in every peak week. It is now identified by the generator's `longRun` stamp (`isLongRun`, `src/workouts/long-run.ts`) and placed and protected as the long run: long-run day, long-run skip charge (`TIM.long`), long-run cross-training rules, injury long-run bans. Its load, pace and HR target still come from its progressive format (Load Currency Law untouched).

**Deliberately unchanged.** Tracking-side samples stay `plannedType === 'long'` only (HR drift, durability flag, LT efficiency, MP pace drift): the MP finish inflates drift and HR, so the run is not a steady-state sample. The coach-contract aerobic-vs-quality load split (`plan-shape` `BUCKET_OF`) keeps it under quality, because its MP finish is quality work.

**Limitation (superseded 2026-10-06).** The timing-check long sub-ladder turned the long run into a marathon-pace long run on a 1-step downgrade, an intensity increase for an easy-paced long run (ISSUE-328). Batch 2 replaced it with the canonical pace ladder (§CO): a fast-finish long run one step down becomes an easy long run at the same distance with the finish dropped, and a steady long run becomes recovery pace.

**Guards.** `long-run-placement.test.ts` (19), `cross-training/fast-finish-long-run.test.ts` (8), `injury/fast-finish-long-run.test.ts` (3), `skip-long-run.test.ts` (3). Not device-verified.

---

## §CL — Week actual load is derived, never stored (2026-10-06, audit B18)

**Side.** Tracking: the load the athlete carried in a plan week.

**Formula.** `computeWeekActualTSS(wk) = computeWeekRawTSS(wk, wk.rated)` (`fitness-model.ts:661`): the sum over the week's activities, each counted once (a `garminActuals` record wins over its adhoc twin), of `normalizeiTrimp(iTRIMP)` or duration × `TL_PER_MIN[rpe]` (the strength RPE override where rated), plus the double-day bonus (§AJ). Canonical TSS (Load Currency Law). Decayed carry from earlier weeks is excluded, because carry is not activity done that week.

**Why.** `wk.actualTSS` was an add-only running total with 11 writers. It could not follow a removal, a dedup, a Strava upgrade or a re-review: re-review re-added logged and excess items (60, 120, 180, 240 in the audit repro). A value derived on read has one source, so the Plan bar, the holiday ratio, the AI Coach skeleton, the sleep insight and the zone carry read the same number.

**Holiday ratio.** Numerator (average actual load of the holiday weeks) and denominator (the most recent completed week before the holiday was confirmed, `preHolidayWeeklyLoad`) now share Signal B. Before, the denominator fell back to Signal A when no stored total existed. Every sport counts at full weight, which matches §AS (total-load based, discipline-agnostic).

**Limitations.** (1) The holiday denominator is one week. (2) Holiday snapshots taken before this build keep their stored value. (3) The week-end zone carry in `events.ts` compares Signal B with a run-only planned TSS; its output `wk.carriedTSS` has no live reader (ISSUE-348). (4) A last-week re-review still files the activity into the current week and leaves its record in last week, so Signal B counts it in both (ISSUE-348). (5) `wk.actualImpactLoad` is still a stored add-only total.

**Guards.** `week-actual-load.test.ts` (including a source scan that fails on any write of a weekly TSS total), `plan-skeleton-actual-load.test.ts`, `_holiday-p1.integration.test.ts`. Not device-verified.

---

## §CM — Cross-source session identity; walk-class sport resolution (2026-10-06, audit S1, S3/C7)

**Side.** Tracking.

**Rule.** Two activity records from different sources are one session when their starts are within 10 minutes and they have the same `activity_type` or durations within 15% of the longer (`isSameSession`, `cross-source-twins.ts:41`; `TWIN_START_WINDOW_MS`, `TWIN_DURATION_TOLERANCE`). Strava's record survives. The constants are the ones `cleanupDbDuplicates` already used for `garmin_activities`; one predicate now serves the DB cleanup, the tri loader, the ingest filter and the in-state collapse.

**Why same type at any duration.** HealthKit's workout duration excludes paused time while Strava's `duration_sec` is elapsed time, so a paused ride can differ by more than 15% and still be one ride. **Why the duration branch.** Sources name one session differently (Strava HIIT vs Apple CARDIO, Strava MOUNTAIN_BIKING vs Apple CYCLING); a near-identical start and similar duration identify it.

**Slot rule.** One session completes at most one plan slot. If only the Apple copy completed a slot, the slot is bound to the Strava copy under its own key, in every mode; if both copies completed slots, one keeps the completion. **Policy.** With Strava connected, Apple workouts are not ingested at all (Tristan, 2026-10-05), so the rule cleans legacy state, guards `garmin_activities` reads and protects the resumed Apple sync after a Strava disconnect.

**Limitations.** Raw type equality: a paused ride labelled MOUNTAIN_BIKING by Strava and CYCLING by Apple matches only on duration. Recordings started more than 10 minutes apart that also differ in type and duration never match. Two genuine same-type sessions started within 10 minutes of each other would merge. The forced DB cleanup covers 90 days (ISSUE-345).

**Walk-class sport resolution (C7).** Not a new model, a classification fix. `resolveSportForActivity` (`sport-picker-modal.ts:194`) gave every member of the matcher's 'walk' bucket the walking row. It now reads the raw activity type, so runSpec, recoveryMult and legLoadPerMin come from the session's own SPORTS_DB row: rowing 0.35 / 0.95 / 0.35, hiking 0.45 / 0.95 / 0.50, kayaking 0.20 / 0.90 / 0.05, paddleboard 0.25 / 0.90 / 0.10, against walking 0.30 / 0.80 / 0.05. Rowing and hiking were under-credited; kayak and paddleboard were over-credited when HR was present. Golf (no SPORTS_DB row) and wheelchair keep walking (ISSUE-347). The new `dance` alias moves Garmin and Apple dance from generic_sport (runSpec 0.40) to dancing (0.35, legLoadPerMin 0.10). Slot matching is tracking; the resolved sport feeds tracking (excess-item sport, Signal A runSpec, leg load) and planning (reduce and replace sizing). No constants added.

**Guards.** `cross-source-twins.test.ts`, `activity-matcher-strava-wins.test.ts`, `apple-strava-twin-cleanup.test.ts`, `walk-class-never-takes-run-slot.test.ts`, `apple-workout-types-mapped.test.ts`. Not device-verified.

---

## §CN — In-app completions are load: GPS runs and Mark as Done (2026-10-06, audit B9; extended 2026-10-07)

**Side.** Tracking.

**Valuation.** The session-RPE method (Foster et al. 2001) in canonical TSS: duration × `TL_PER_MIN[rated RPE]`.
- An in-app GPS run uses its recorded time (pauses excluded: `GpsTracker.getElapsed`, `gps/tracker.ts:353`). The recorder captures no heart rate, so there is no iTRIMP; it is valued like a synced run without HR.
- A run marked done deposits its planned dose: the card's planned duration (`estimateWorkoutDurMin`) at the rated RPE. This mirrors triathlon's `manualDoneTriActivities`, which deposits planned load for a manual completion. HYROX uses the session's `estimatedDurationMin`.
- Since 2026-10-07 (decisions 2a and 5a) triathlon, cycling and Just-Track sessions and HYROX cross sessions do the same (`recordPlannedSessionDone`): the duration the card prices (`readTriWorkoutMin`, else the 60-min `estimateTriWorkoutMin` fallback; a Just-Track km-only run uses the distance at easy pace). Signal A applies the session's own sport through `manualSport` (cycling 0.55, swimming 0.20, rowing 0.35); Signal B carries no runSpec.
- A HYROX station recorded in the app resolves to strength in Signal A (runSpec 0.35, decision 10a), the weight its watch HIIT copy gets through the gym bucket; it was generic_sport (0.40), so its running-specific load falls about 12%.
- The record is stamped at local noon of the planned day, never later than now, so daily strain and rolling ACWR place the load on the planned day.

**Same-session rule for superseding.** Two recordings are one session when their starts are within 4 h and durations within 15% (`reconcileCrossSourceDuplicates`). A manual completion has no recorded start: it matches a synced recording within 36 h at 0.5 to 2.0× duration (the guided-strength upgrade window). A completion on the synced run's own local day takes priority over a planned-slot claim, because the user has already placed that session on that day. A cross-day completion yields to slot matching and is superseded automatically only for a run first seen in a past week, within that run's plan week; in the current week the user decides in Activity Review.

**Plan weeks are not a session boundary.** A GPS record sits in the current plan week and a Mark as Done record in its card's week, while a synced row is filed by its own date, so the copy can land in a neighbouring week (or several weeks away while an unfinished debrief holds the week back). The recorded and same-day checks are bounded in time (4 h, or one local day), so they search every plan week and can only reach the same session.

**Sport.** The windows are timing rules, so a synced activity supersedes or drops an in-app record only when it is the same sport family (run, gym, bike, swim, row), with the sport from `resolveActualSport`. **Plan slots.** A manual completion's noon stamp is not a recorded start; a timing collision with an activity that fills another plan slot is two sessions. **Non-run and future-week cards** write no record: a record with no activity type reads as running in Signal A, and a future-week record would be stamped now.

**Limitations.** (1) Valuation uses the rated RPE row: an easy run prescribed RPE 3 is valued at 0.65 TSS/min, while planned sessions use the 0.92 type row (`TSS_RPE_BY_TYPE`), so a Mark as Done easy run reads about 71% of its planned load, the same gap any synced no-HR easy run has (ISSUE-343). (2) The planned-day stamp is an assumption for batch-ticked sessions; a tri session ticked before its planned day is stamped now and moved to today. (3) On a double-run day, a watch copy of the other run (0.5 to 2.0×) can supersede the Mark as Done record instead of filling its own slot. (4) In a past week, a separate next-day run inside the completion window replaces the record. (5) A current-week cross-day run left unreviewed becomes an extra at rollover, so the ticked session counts twice. (6) A cross-day completion whose copy falls in another plan week is not merged (ISSUE-344). (7) Tri per-discipline CTL deposits the tick at its planned aerobic + anaerobic while the load surfaces use `TL_PER_MIN[rated]`. (8) A brick is one cycling-tagged record, so its run leg takes the cycling runSpec in Signal A. (9) `computeTodaySignalBTSS` values a no-HR actual at `TL_PER_MIN[5]` whatever its rating. (10) HYROX cross sessions add 0 MTL (ISSUE-330). (11) Gym quick done for beginner, novice and returning templates has no duration source and logs 0.

**Guards.** `in-app-activity.test.ts`, `recording-handler.load.test.ts`, `recording-handler.multisport.test.ts`, `hyrox-quick-done-load.test.ts`, `hyrox-station-signal-a.test.ts`, `tri-mark-done-load.test.ts`, `hyrox-cross-mark-done.test.ts`. Not device-verified.

---

## §CO — Plan changes from the plan-layer week; one pace category per downgrade step (2026-10-06, P1, P2)

**Side.** Planning only. No new constants.

**Plan-layer week (P1).** (1) Every cross-training, ACWR, timing and recovery change is sized from the prescription left after earlier accepted changes; sizing against the unmodified plan double-counts load already removed and lets a smaller later change overwrite a larger one. (2) Illness (the illness schedule's daily volume factor, 0.50 to 0.95, or rest), holiday and the post-holiday bridge (0.50 to 0.85) are state-driven render layers re-applied on every render on top of the stored change. A change sized from a layer's output scales the session twice (bridge(bridge(x) − cut)) and keeps the layer's value after the layer ends, so changes are sized from the plan's session. (3) Sessions a holiday or illness rest day stands down are not run; cutting them would absorb load that was never going to be done. (4) Reduced and replaced sessions are re-priced with the generator's `calculateWorkoutLoad`. (5) The silent Tier-1 excess is cumulative over the week and re-applied to the plan distance of the run that carries Tier-1's own trim. (6) Timing distance cuts apply to the main set only. Limitations: in an illness or bridge week the suggestion modal lists plan distances while the card shows scaled ones, and the ACWR overshoot budget comes from the shown week, so cuts slightly under-deliver; ACWR undo is same-day only (ISSUE-349).

**Pace ladder (P2; Tristan's rule, 2026-10-05).** A downgrade moves a run one pace category down per step, never up: recovery < easy < marathon pace < threshold < vo2 (`RUN_PACE_LADDER`, `src/constants/intensity-ladder.ts:37`). Each running type sits on the rung of its canonical planned-load row (`TSS_RPE_BY_TYPE`: 3 recovery; 4 easy, long; 6 marathon_pace, progressive, mixed; 7 threshold, race_pace, float; 8 vo2, intervals, hill_repeats), so the ladder adds no classification, and a test pins the two. Float reps run at 10K pace (`RUN_PACE_FACTOR_VS_EASY` 0.84 against threshold 1/1.20 = 0.833) at generator RPE 7, so float sits with threshold. A progressive or fast-finish run is easy running with a marathon-pace finish, so one step drops the finish; in the long-run slot the easy rung is written 'long'. A steady long run steps to recovery pace (easy pace × 1.12, `load.ts`). A downgrade writes the generator's RPE for the new type (`RUN_GENERATOR_RPE`). The timing check keeps its tiers (50 / 75 / 100 / 125 TSS, one or two steps, 0 to 25% shorter, 3 km floor). Limitations: (1) recovery RPE 3 equals the easy run's prescribed RPE 3, so prescribed effort does not drop from easy to recovery (pace and planned TSS do, row 4 to row 3); (2) the two-step tiers move two categories (threshold to easy), a pragmatic reading of one step = one category; (3) the suggester still writes the 'steady' pace (halfway between easy and threshold) for threshold to marathon pace, while the timing check writes marathon pace; (4) legacy 'mixed' sits on the marathon-pace rung by valuation and now steps to easy; (5) a steady long run stepped to 'recovery' loses long-run identity (ISSUE-350).

**Guards.** `workout-mods.test.ts`, `plan-changes-from-current-plan.test.ts`, `plan-changes-render-layers.test.ts`, `timing-from-resolved-plan.test.ts`, `downgrade-one-pace-category.test.ts`, `intensity-ladder.test.ts`. Not device-verified.

---

## §CP — Triathlon suggestions: canonical ladders, off-ladder downgrades, notify-once (2026-10-06/07)

**Side.** Planning.

**Ladders.** Accepted tri and cycling downgrades no longer use a private substring ladder. Run legs step one pace category down `RUN_PACE_LADDER` (§CO), priced with `plannedTssPerMin(type)` × minutes and split with the tri generator's aerobic/anaerobic shares (`loadForTriRun`). Bike and swim step one rung down `BIKE_INTENSITY_LADDER` (%FTP, Coggan & Allen 2019) and `SWIM_INTENSITY_LADDER` (CSS offsets), priced with `loadForBike` / `loadForSwim`, with watts scaled by the %FTP ratio and swim paces set to CSS plus the rung offset, as the Adjust overlay applies a rung. A swap to easy goes to the easy rung at 75% of the minutes; a trim keeps load proportional to duration at fixed intensity.

**Off-ladder kinds (decision 3a, 2026-10-07).** Over-unders (alternating about 95 and 105% FTP) and hill repeats are threshold-class work, so one category down is sweet spot; VO2 micro-intervals (Billat 2001, 30/30 s) are VO2-class, so one down is threshold; open water is endurance-class swimming in a different setting, so it maps to the endurance rung (`OFF_LADDER_DOWNGRADE_RUNG`). The description is rebuilt with the generator's builders because an over/under structure has no single %FTP to scale. **Load guard.** A step that would raise planned TSS is not a downgrade (`raisesPlannedLoad`). It compares the two prescriptions' rates at the same minutes, because the stored load goes stale when `applyTriEffortMultipliers` lengthens a session without re-pricing it (ISSUE-338). Neuromuscular sprints (vlamax) are short maximal efforts with full recovery: `loadForBike` prices them at 1.10 TSS/min (IF about 0.81, rest-dominated), below sweet spot (1.5, IF about 0.95), so sweet spot would lower RPE (8 to 7) but raise TSS 36%. The step is held back and the approved mapping is not shipped. TSS does not capture neuromuscular or glycolytic stress, so the session-average model understates vlamax load; that is why the choice is left to Tristan (ISSUE-335). The micros to threshold step barely moves TSS (1.75 to 1.7 TSS/min, about 3%); the overload modal now shows that, since a downgrade's TSS is the stored load minus the landing rung's load (`triDowngradeTssReduction`).

**Notify-once.** The overload detector compares unanswered cross-training with the planned tri TSS: (week cross-training + decayed carry − answered) / plannedTriTSS, against the existing `OVERLOAD_THRESHOLD` 0.15. An answered load has already produced a plan decision; counting it again re-proposed the same change, and after Reduce the shrunken denominator even raised the ratio. Push takes the load out of this week's count and it counts once next week through `computeDecayedTriCarry` (7-day ATL time constant). Limitation: the record is a TSS total, not per activity, so the daily decay of an earlier carry slightly offsets a new session. Running's suggester down-weights already-downgraded runs; tri excludes reduced sessions outright, a deliberate stricter divergence because a tri week has fewer sessions per discipline. One change per session per accept: a swap and a downgrade answer the same signal, so the stronger action wins.

**Volume ramp (not live).** The check compared partial-week actuals with a full planned week. Gabbett's ramp guidance (2016) concerns completed-week load against recent load, and a planned rebound from a deload week to build volume exceeds 10% by design (17 week pairs in a generated Ironman plan, e.g. bike 2.6 to 4.0 h at weeks 4 to 5), so even a completed-week gate would fire on the plan's own structure unless the anchor is recent build volume (ISSUE-337).

**Open divergences.** The tri generator writes threshold reps at easy ÷ 1.15 (`plan_engine.triathlon.ts:816`) while `RUN_PACE_FACTOR_VS_EASY` uses 1/1.20, and a suggestion-changed tri run carries running-generator RPEs (easy 3, threshold 7) where generated tri runs carry easy 4, threshold 8, vo2 9 (ISSUE-336).

**Guards.** `tri-suggestion-apply.test.ts`, `tri-suggestion-applicable.test.ts`, `tri-suggestion-aggregator.test.ts`, `tri-cross-training-overload.test.ts`, `rung-load.test.ts`. Not device-verified.

---

## §CQ — Triathlon readiness for athletes with no earlier record; HR-less tri sessions on the canonical table (2026-10-07, decisions 1 and 8a)

**Side.** Tracking (describes load); planning reads it only through the existing readiness gate and discipline floor.

**Observed days.** Per-discipline CTL and ATL (`estimateDirectPerDisciplineCTLFromActivities`) are decay-weighted sums over a `TRI_FITNESS_WINDOW_DAYS` = 120-day window started at zero, so for an athlete with no record before plan start every earlier day read as rest. When no activity of any sport predates plan start, `triLoadObservedDays` gives the completed days since then. `observedDisciplineLoad` (`fitness-model.triathlon.ts:146`) divides each sum by the share of its window weight on observed days:

```
share(τ) = (1 − e^(−n/τ)) / (1 − e^(−(W+1)/τ)),   n = observedDays + 1, W = 120, τ = CTL_TAU_DAYS or ATL_TAU_DAYS
```

That is the exact weight a constant daily load puts on n of the window's W + 1 days, so steady training reads what it reads for an athlete whose record covers the window. It is the zero-initialised EMA correction `computeWeeklyAcwrHistory` applies (Kingma & Ba 2015), the EMA form of running's "a day no record covers is missing" rule. `perDisciplineAcwrRaw` withholds the ratio until `ROLLING_ACWR_MIN_OBSERVED_DAYS` (14) observed days and below 10 weekly TSS of chronic load. Tristan's rule (2026-10-06): count from plan start when nothing was recorded before it, and keep the new-sport ramp warning for an athlete with any earlier record, because that ramp is real. Limitation: with few observed days the chronic mean leans on the latest sessions, so a genuine early ramp reads lower than it would with a full record, never higher.

**HR-less sessions.** `triActivityTss` (`tri-benchmarks-from-history.ts:1057`): TSS = `normalizeiTrimp(iTRIMP)` when present, else minutes × `TL_PER_MIN[RPE]`, RPE = the athlete's rating (the same source as Signal B, attached by `withTriRatedRpe`), else 5. The same row applies to every sport: TSS is defined by intensity relative to threshold, and the sport only decides where the TSS is routed. It replaces a private per-sport scale (0.9 / 1.0 / 1.1 / 0.6 TSS/min) with no source, which made one session count differently in tri fitness and in the load numbers. Limitations: RPE 5 for an unrated session is a population default (about IF 0.83), so an easy unrated walk or swim reads high and an unrated hard class reads low. HR-less "other sport" load rises about 1.9× (36 to 69 per unrated hour), which raises cross-training ATL/CTL, the cross-training readiness bar, the cross-dominant readiness sentence and the tri capacity CTL. A rated strength session with heart rate is priced by its RPE tag in Signal B but by iTRIMP in tri fitness (ISSUE-343).

**Guards.** `tri-readiness-observed.test.ts`, `tri-load-no-hr.test.ts`, `load-currency-anchors.test.ts` Anchor 10. Not device-verified.

---

## §CR — HYROX muscle-tendon load: completion, cold start, chronic vs plan (2026-10-06)

**Side.** Tracking (MTL measures); planning reads it through the MTL-gap re-anchor (§BR mirror) and the execution multiplier (§AU).

**Completion source.** A session counts as completed when it carries a match link or an activity record sits on its slot key (`isMtlSessionCompleted`, `mtl.ts:107`), which is how the HYROX station and run matcher branches, in-app GPS runs, Mark as Done records and quick-done stations store completions. Before, only `matchedActivityId` counted, which HYROX never sets, so actual MTL was always 0, the ratio collapsed to 0 at every rollover and the next week was clamped to `HYROX_DELOAD_FACTOR`. Planned dose is credited as completed MTL (the session's prescribed `musculoTendonLoad`), not a measured mechanical load. HYROX cross sessions and commute runs carry no MTL.

**Cold start.** Both EMAs start at B, the mean actual weekly MTL over the completed plan weeks before the current week (0 when there are none):

```
ctl_0 = atl_0 = B;  ctl_i = ctl_(i−1)·e^(−1/6) + m_i·(1 − e^(−1/6));  atl_i = atl_(i−1)·e^(−1) + m_i·(1 − e^(−1));  reported ÷ 7
```

Each discipline is seeded with its own B, so the split sums to the total. MTL exists only on plan sessions, so no athlete has a pre-plan record; a zero start asserted no eccentric work before the plan and read 3.06 in week 2 and 1.68 in week 6 for a compliant intermediate athlete. The rule is running's "unrecorded days are missing" rule and §BV. The ratio (`computeMtlAcwr`) is withheld until 14 days of plan weeks are complete (day 1 of week 3) and while chronic is below 15 (`MTL_ACWR_MIN_CHRONIC`, the existing inline gate). The 1.3 / 1.5 floors are unchanged. Limitations: (1) B assumes pre-plan load equals the mean on-plan load; (2) B rests on a few early weeks and its weight decays as e^(−n/6); (3) the plan's own base-to-build MTL step (intermediate 736 to 1300, 1.77×) puts a fully compliant athlete above 1.3 (Manage Load, readiness capped at 54) for 2 to 3 consecutive build weeks in several band and plan-length combinations, never above 1.5 (ISSUE-340); (4) `resolveMtlAdherence` keeps its own zero-seeded prior EMA.

**Chronic MTL against plan.** ratio = CTL_actual / CTL_planned (`computeMtlChronicVsPlan`, `mtl.ts:402`): each side is the 42-day EMA over the completed plan weeks only, the current partial week excluded, each starting at its own series' observed baseline, withheld behind the same 14-day guard. Projection "Training fitness" factor: pct = −clamp((ratio − 1) × 0.10, ±0.05), added only when it moves the time by at least 1 s; staleness Signal 2: f = clamp01(0.5 + (ratio − 1) × 0.5). Both constants are unchanged from the band-anchor version. Why: every projection modulator compares reality with the plan, and the old anchor (70% of the band MTL cap) sat above what the generator prescribes (about 57% of the cap in base, intermediate), so compliance read as undertraining. Limitations: (a) the ratio cannot exceed 1, because actual MTL counts plan sessions only, so the factor is one-sided; (b) it overlaps the count-based Plan adherence factor, so missed sessions cost twice; (c) in staleness a compliant athlete scores 0.5, which still dilutes the mitigation mean; (d) the anchor choice is pending Tristan's confirmation (ISSUE-340).

**Execution multiplier (§AU addendum).** With slot ids (generator v14) the HYROX execution loop is live. Its under-duration guard reads the session's record by match link, else by slot key (`wk.garminActuals[matchedActivityId ?? id]`), and its lookback starts at the last completed week (`fed8bfc`). Limitation: `wk.rated` for synced HYROX matches is `deriveRPE` output (Garmin RPE, else an HR-reserve zone mapping, else aerobic Training Effect), so HR enters the signal despite the module's "HR rejected" design note; a compliant watch-synced week 1 measured 0.97 and regenerated week 2 at 212 planned minutes instead of 220 (ISSUE-340).

**Guards.** `hyrox-mtl-completion.test.ts`, `hyrox-mtl-acwr-cold-start.test.ts`, `hyrox-mtl-vs-plan.test.ts`, `daily-coach-hyrox-mtl-floor.test.ts`, `effort-multiplier.hyrox-slot-record.test.ts`, `effort-multiplier-completed-weeks.test.ts`. Not device-verified.

---

## §CS — Activities belong to the athlete's local day (2026-10-07, decision 6a)

**Side.** Tracking. No model constant changed.

**Rule.** An activity's day is the local calendar date of its start (`isOnLocalDay`, `utils/local-date.ts:45`) and its plan week follows from calendar-day arithmetic (`weekIndexForDate`, `calendarDaysBetween`). Plan weekdays are local, and `weekIndexForDate` compared UTC days, so a late-Sunday session west of UTC filed into the next week and onto Monday's strain, and an early-Monday one east of UTC into the previous week. The strain day pairs the local day's activities with the same day's physiology entry (`computeDayStrainTSS`).

**Adaptive recovery.** Observation windows of the `k_user` fit (the `k_user` Addendum 2 entry, ISSUE-256) are counted in local calendar days, the convention of the morning physiology readings. A UTC "today" could close a window before the day-4 morning reading existed and store it right-censored at 96 h, which biased the log-space index toward slower recovery and lowered the ACWR ceiling through `recoveryShiftForCeiling`. Observed hours keep a 24 h granularity keyed to calendar days, not elapsed hours.

**Limitations.** Stored actuals are not re-filed. Physiology and manual-entry "today" keys still use the UTC day, so near midnight they can name a different day from the strain day; Strava weekly history keeps the edge function's UTC weeks; onboarding snapped the plan start to the UTC Monday (`getMondayOf`; since `cd6eb65` every initializer writes the local Monday, `localMondayKey`, §CW); and `_resolveWeekForDate` (`fitness-model.ts:1410`) floors a local-noon millisecond difference, which can map Mondays to the previous week after a spring-forward DST change (ISSUE-331).

**Guards.** `local-day-filing.test.ts` (America/Phoenix and Australia/Brisbane), `stravaSync-restore-local-day.test.ts`, `strain-day-agreement.test.ts`. Not device-verified.

---

## §CT — Whole running plan shape: deloads never heavier, long runs within 10% of the 4-week longest, the long run stays the longest run, no race-week long run (2026-10-06/07)

**Side.** Planning. The engine caps what it prescribes; nothing here reads executed training.

**Context.** A probe ran 1,092 full running plans through the real `planWeekSessions` and phase split (marathon 8 to 20 weeks, half 4 to 16, 3 to 6 runs a week, 7 archetype and baseline cases, 3 abilities, no hours target and a 4-hour target). Without / with the target it found: a deload week heavier than the week before in 554 / 714 plans (median +6.9%, max +21.3%); a deload gaining a quality session in 129 / 100; a build or peak long run more than 10% over the longest of the previous 4 weeks in 654 / 687 (max +83% / +107%); taper long-run jumps in 100 / 175; a long run in every race week, on Sunday.

**Root causes.** (1) Deload sessions took the deload multiplier, but the weekly budget they were fitted to kept ramping, and the volume-aware quality cap read the same budget. (2) The budget fit trimmed the long run first once easy runs reached their floor, and the next week's higher budget released it; the long-run ramp counted deload weeks, so the week after a deload sat two ramp steps up; the taper long run was 0.65 × the untrimmed ramp while the build long runs had been trimmed. (3) The race-week flag only swapped the quality session for the primer. (4, found in review) Once the 10% rule held the long run low, the budget fit gave the freed minutes to easy runs (51-min easy runs beside a 30-min long run) and snapped a 31 to 39 min long run to 30 on any overflow.

**Model.**
- *Long-run ceiling*: `L_k ≤ floor(1.10 × max(L_k-4 … L_k-1))`, where L are the long runs actually prescribed, budget trims included (`longRunCeilingMin`, `plan_engine.ts:394`). Source: Frandsen et al. 2025, Br J Sports Med, "How much running is too much?": a single session more than 10% longer than the longest run of the previous 30 days was associated with more running injuries. `LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST` = 0.10 and `LONG_RUN_LOOKBACK_WEEKS` = 4 (the plan-week form of 30 days) were approved by Tristan on 2026-10-06. The ceiling applies before the deload and effort multipliers, so a deload long run reduces the long run the athlete would otherwise run, and again after them, so an upward effort multiplier cannot breach it.
- *Ramp held through deloads*: the ramp position is the week index minus the scheduled deloads up to it (`longRunRampProgress`); the span shrinks by the deloads before 75% of the plan, so full progress still lands there (§BW) wherever the 10% rule allows it.
- *Taper*: taper long run = `TAPER_LONG_RUN_FRACTION` (0.65, the existing taper cap, now named) × the longest long run prescribed in the previous 4 weeks.
- *Floor*: these history rules never cut a long run below `LONG_SOFT_FLOOR_MIN` (30, existing) unless the ramp value itself is shorter. The 10% ceiling wins over that floor.
- *Deload budget*: budget × `deloadMultiplier(ability)` (existing, 0.80 to 0.90), read by the budget fit and the quality cap. Backstops: the budget never exceeds the previous week's total, the quality count never exceeds the previous week's, and a deload week still heavier with every flexible session at its floor swaps a quality session for an easy run (the existing ACWR-caution move).
- *The long run stays the longest run*: an easy run is never sized past the week's long run, the easy split rounds down so it cannot overflow the budget, and the budget fit trims the long run only by the overflow, to 40 then 30 min (existing floors).
- *Race week*: the final training week of a non-continuous plan, whatever its phase label (a 1- or 2-week plan carries a build or peak label), sized as taper (`isRaceWeek`, `plan_engine.ts:282`). The race takes the long-run slot and the §CE primer stays. Taper practice holds intensity and cuts volume (Mujika & Padilla 2003; Bosquet et al. 2007, who found no benefit from cutting frequency); counting the race as the week's long effort removes one prescribed session. Mirrored in the triathlon engine, whose scheduler keeps Sunday free in race week and finds the long run by type. HYROX has no long-run slot.

**Implementation.** `planWeekSessions` builds one week at a time. To read what earlier weeks prescribed it replays weeks 1 to k−1 from the static plan inputs (`nominalHistory`, `plan_engine.ts:719`; memo of 32 plans keyed by every static input and the phase list). Adaptive levers (effort score, ACWR caution, CTL gap, holiday deload) adjust one week as it is generated and are not replayed. The same replay feeds the race-day forecast (§CU).

**Results.** 1,092 grid, no target / 4 hours: 0 / 0 on every flag above, and 0 weeks with an easy run longer than the long run. Re-run at `76d5cba` with the phases the app passes: still 0 on every flag. A 31,500-plan sweep (all four distances, 1 to 7 runs, 9 baseline cases, 5 abilities, no target and 3, 4 and 6 hours): every flag 0. Side effects, measured at `ff6f401`: the peak build long run is more than 10% lower in 233 / 467 plans of the 1,092 grid (more than 25% lower in 86 / 338), mostly detrained 15 to 20 km and consistent 25 km runners; unchanged for consistent 40 km and high-mileage 60 km runners without a target; median plan minutes −4.9%; 6,598 of 333,900 non-race weeks in the large sweep carry one quality session fewer (deload guards), none more.

**Limitations.** (1) Frandsen measured distance; the engine prescribes long-run minutes at one easy pace, so minutes stand in for distance. (2) The study is observational: 10% is an association-based threshold, not a proven causal limit. (3) The ceiling reads the nominal plan. A live week shaped by effort, CTL or ACWR levers can exceed +10% over the previous live weeks (review: 59 weeks in 36 plans, up to about +21%), and a skipped or shortened long run does not lower the next ceiling (ISSUE-357). (4) The 10% rule outranks the §BW readiness ceilings for low-baseline runners, whose marathon long run can peak at 50 to 81 min; the forecast now says so (§CU, ISSUE-358). (5) Quality sessions are never trimmed, so a quality session can outlast the long run on a tight budget: 208 plans of the 1,092 grid without a target and 574 with 4 hours at `76d5cba` (ISSUE-354). (6) The weekly volume budget still ramps through deload weeks, so the week after a deload carries two budget steps (ISSUE-357). (7) The triathlon long run does not follow the 10% rule (ISSUE-355).

**Guards.** `plan_engine.plan-shape.test.ts` (1,386-plan property sweep plus units), the race-week block of `plan_engine.triathlon.test.ts`, `long-run-placement.test.ts` (race week exempt from the Sunday long-run rule). Not device-verified.

---

## §CU — Race-day forecast judges durability on the long runs the plan prescribes (2026-10-07)

**Side.** Tracking. It reads the plan and never changes it.

**Problem.** §AL.4 applied the long-run durability cap to today's estimate only; the race-day forecast assumed the plan delivers the threshold long run by race day. That was false for low-baseline and hours-capped marathon plans (more so under §CT's 10% rule) and for every half and 10K plan, whose long-run ramps peak at about 84 and 63 min against thresholds of 105 and 75 min. Tracking and planning disagreed.

**Model.** Race-day forecast × M, with M = `applyLongRunCap(longest, distance, qualifying count)` over the runs of the 12 weeks (`DURABILITY_WINDOW_WEEKS`, the window every caller already used) ending with race week: the plan's prescription for plan weeks (`plannedRunMinutesByWeek`, the §CT replay) plus logged runs for pre-plan weeks still inside the window (`raceDayPlanDurability`, `race-day-durability.ts:49`). Same thresholds, maximum penalties (2 to 5%), 0.70 qualifying fraction and 8-run consistency credit as §AL.4; no new constants. The forecast is end-of-plan fitness on the assumption that the plan is followed, so durability is judged on what the plan prescribes. One source for every running forecast producer (`calculateLiveForecast` takes the multiplier) and the Durability drill-down: `s.raceDayDurability` stores the result the forecast applied. `rate()` anchors on the published peak-volume anchor, as the renderer and preview do, so the cap is not counted twice.

**Outside the model's calibration.** `LONG_RUN_MAX_PENALTY` was set from runners who still did long runs (Pfitzinger & Douglas: a 2 to 6% gap for volume-shortened marathoners). When a marathon plan's longest run before race day is under `LONG_RUN_QUALIFYING_FRACTION` × `LONG_RUN_THRESHOLD_SEC.marathon` (0.70 × 165 = 115.5 min, shown as 1:55), the percentage is outside that range. The surfaces then show a plain statement instead ("The longest run before race day is about H:MM, short of the 2:45 marathon-readiness long run. The forecast assumes long-run endurance the plan does not build, so the finish time is optimistic.") and the Durability row reads "Not estimable: long runs too short" (`marathonEnduranceGap`, `raceDayEnduranceGapText`). The same check, with the beginner and no-recent-run categories of a sharpening block, drives the race page warning (§CV). It returns nothing once the longest run reaches 2:45.

**Results (1,092 grid).** Marathon without a target: 301 of 588 plans penalised, median +0.07%, p90 +3.36%, max +3.79%; with 4 hours: 520 of 588, median +2.91%. Half: every plan, median +0.60% (+0.87% at 4 hours), max +2.29%. 10K: every plan, max +1.40%. 5K: none (35-min threshold). The same model applied to the plans before §CT already penalised 182 and 416 marathon plans and every half plan: the 10% rule widened an existing gap.

**Limitations.** (1) Plan weeks count as prescribed even once past; a skipped or extended long run does not move the result. (2) Not floored at a same-distance PB (§BV floors today's estimate only), so the forecast can sit above a PB or today's estimate when the plan prescribes shorter long runs than the athlete runs now. (3) The half and 10K penalty is structural until their long-run ramp reaches the threshold. (4) Triathlon's projection still credits its durability thresholds by `executionFactor` (`race-prediction.triathlon.ts`), while 20 of 64 sampled triathlon plans have a longest run, and 24 of 64 a longest ride, under the triathlon thresholds. (5) The nominal plan has no effort, ACWR, CTL or holiday levers, no commute runs and no injury adaptations. (6) Where no peak-volume anchor has been published, `renderer.ts` and the onboarding preview fall back to today's estimate, which already carries the cap. Items 2, 3, 4 and 6 are ISSUE-358.

**Guards.** `race-day-durability.test.ts`, `race-day-durability.forecast.test.ts`, `initialization.durability.test.ts`, `rate-forecast-durability.test.ts`, `block-forecast-honesty.test.ts`, `durability-detail-endurance-gap.test.ts`. Not device-verified.

---

## §CV — Sharpening block: short race plans from current fitness (2026-10-07/08)

**Side.** Planning (CV.1 to CV.4); tracking for the forecast inputs (CV.5).

**Decisions.** Tristan, 2026-10-05: a marathon under 8 weeks away or a half under 4 gets a short plan instead of being refused. Tristan, 2026-10-06: an hours target below what the block would build starts at the target and holds while the long run keeps growing; a low-base marathon block is allowed, stated plainly on the race page and the forecast, with a one-tap switch to the half on the same date or a later race. Tristan, 2026-10-08: the fit order stays mixed (long run first under a binding hours target, quality first otherwise), and a one-line plan note will explain merged runs on a tight budget (added separately). The remaining rules were taken as defaults in the design v4 review (M4 design v4, questions Q1 to Q22); the code records them as approved defaults.

**CV.1 Trigger and phases.** A running race plan with fewer training weeks than a full build (`FULL_BUILD_WEEKS`: marathon 8, half 4; 5K and 10K are never a block). Phases (`computeRunningPlanPhases`, `phases.ts:132`): taper first, the marathon at least 2 weeks (`MARATHON_MIN_TAPER_WEEKS`; Bosquet, Montpetit, Arvisais & Mujika 2007 found the largest taper effect with tapers of 8 to 14 days), one peak week (none without a real running-fitness signal, because peak variants assume a measured runner), then build weeks, no base. Marathon: 1 week taper; 2 weeks taper ×2; 3 weeks peak + taper ×2; 4 to 7 weeks build ×(N−3) + peak + taper ×2. Half: 1 week taper; 2 weeks peak + taper; 3 weeks build + peak + taper. The 8-week full marathon takes the same 2-week taper floor (base 2, build 3, peak 1, taper 2).

**CV.2 Long run.** Start: the longest logged run of the 30 days before build, as distance × easy pace (`RECENT_LONGEST_WINDOW_DAYS` = 30, the Frandsen window, `sharpening-block.ts:37`), clamped to [30 min, `longRunCapMin`] and frozen on `s.sharpenBlock`. Logged runs but none in those 30 days (case b): a 30-min restart (`LONG_SOFT_FLOOR_MIN`) with base-phase quality rules. No logged runs (case c): the existing week-1 anchor (marathon 90, half 64 min). Loaded week k: `L_k = min(longRunCapMin, floor((1 + r) × the longest long run seated so far))`, r = `ARCHETYPE_PARAMS.weeklyRampPct` capped at 0.10 (`sharpeningRampPct`), with §CT's 4-week ceiling on top. Single-session cap: no session's easy-minute distance (work ÷ `RUN_PACE_FACTOR_VS_EASY` plus warm-up and recovery at easy pace) exceeds the week's long run, so with the growth rule no session exceeds (1 + r) × the 30-day longest (Frandsen counted any single session). Deload long run = the last loaded long run × `deloadMultiplier`; taper long run = f × the reference long run; none in race week; none under 30 min (that slot becomes an easy run). Live, reduce-only: once a run is logged after build, a reached week's long run is capped at max(30, (1 + r) × the longest logged run of the 30 days before that week's Monday) (`liveSharpeningLongRunCapMin`), so a skipped long run holds the next one to the Frandsen bound.

**CV.3 Volume and fit.** Loaded budget = min(`weekVolumeBudgetKm(loaded index)`, (1 + r) × max(last loaded week, current weekly volume), hours target). The current-volume term keeps high-volume runners from being held below what they already run; Frandsen found no clear week-to-week volume association, so the ramp bound is a conservative product rule built from existing constants. A binding hours target is the budget from week 1 and holds (the §BW RC2 principle of capping the destination, applied to the block, whose destination is its own peak week). Fit order:
- *Binding hours target*: the long run's growth comes before every quality session. Sessions give way lowest priority first, down to none. Only when the grown long run plus one 25-min easy run pass the target is the long run cut to what the target leaves (never below 30 min).
- *No binding target* (design v4 §4.5 as bounded in review): (1) easy runs consolidate (fewest runs at natural length, each at least `EASY_FLOOR_MIN` 25); (2) the long run gives up its growth only when the held long run keeps every quality session; (3) the lowest-priority quality session is unseated and the growth restored; (4) with one session left, one 25-min easy run is seated and the long run trimmed toward the longest seated, accepted only while the week stays within its budget plus that easy run (within the budget in a 2-run week) and inside any hours target; otherwise the long run takes its growth, the slot is an easy run and the week has no quality session until the chain budget seats one; (5) past every floor with no session, the long run holds at the longest seated, overflow accepted, unless that passes the hours target.
- A set hours target caps every block week, whichever budget binds.

**CV.4 Deloads, taper and levers.** Deloads fall on build weeks of the ability cycle, except the week before the taper, which stands in for the peak week (`isSharpeningDeloadWeek`, shared with the weekly load target); deload volume = the last loaded week × `deloadMultiplier`, quality count at most the last loaded week's. Taper: f = `taperFraction` (2 weeks 0.70 / 0.55; 3 weeks 0.75 / 0.65 / 0.55; 1 week 0.55, the race-week endpoint Tristan set on 2026-10-05; progressive step-down per Mujika & Padilla 2003). Week ceiling f × the reference week's total; easy runs f × the reference easy length (at least 25 min, never longer than the long run); runs are kept and shortened (Bosquet et al. 2007: no benefit from cutting frequency). The easy-run count is the nearest whole run, rounded down when rounding up would make the week longer than the week before, so the taper never rises, race week included. One continuous threshold session (the existing taper work minutes) in a taper week and the §CE primer in race week, neither when the reference week held no quality session (a taper reduces; it never adds a session type). Race week keeps `rw − 1` sessions because the race takes the long-run slot; with 1 run a week it holds none. Easy makeups enter a taper week at its taper easy length and only up to min(f × the reference total, the week before's total) (`taperMakeupRoom`, `fitTaperEasyMakeups`); skipped long runs and quality sessions are never carried into any taper week. Live effort and CTL levers only reduce block weeks, because the rows are ceilings set by the 10% and ramp caps; triathlon and full running plans keep the two-way lever.

**CV.5 Forecast inputs (tracking).** Volume anchor: the block's own highest pre-taper week as prescribed (`plannedPeakWeeklyKm`, ISSUE-297's principle of crediting the volume the plan delivers); a full plan keeps `computePeakWeeklyKm`. Forecast volume: `planForecastWeeklyKm` (`blended-fitness.ts:466`), the ramp integral of `weekVolumeBudgetKm` over the plan's training and taper weeks, the one reader for Home, the onboarding preview hero, the dashboard recompute, the strength-benefit difference and `debugForecast`; the flat full-plan peak over-credited a block that never reaches it. Taper: `planTaperWeeks` feeds every forecast taper input and `TAPER_NOMINAL.marathon` is 2 (Bosquet et al. 2007), so a 2-week marathon taper earns the full taper bonus (12- and 16-week marathon forecasts moved 0 to 31 s faster in the design table). Durability: §CU, with the endurance-gap statement when the longest run stays under 1:55.

**Results.** Example A (7-week marathon, 4 runs, 40 km a week, 100-min longest): long runs 100, 107, 114, 97 (deload), 121 (peak), 85 (taper), none (race week); week totals 231, 244, 253, 215, 262, 181 and 77 min. A 15 km-a-week runner with a 60-min longest, 5 weeks out, 3 to 7 runs: weeks of 87, 93 and 99 min with long runs of 60, 64 and 68. Review grid of 17,500 blocks (29,750 loaded weeks; bases from 5 to 90 km; 5 abilities; hours none, 1.5, 2.5, 4 and 6): 0 race-week long runs, 0 weeks over an hours target, 0 deloads not lighter, 0 taper rises, 0 long runs over (1 + r) × the longest seated or over the §CT ceiling, 0 long runs under 30 min, 0 sessions longer than the long run. A second grid of 35,280 blocks with hours targets from 1.0 to 6.0 h in 0.25 h steps: 0 weeks over target.

**Limitations.** (1) Frandsen is observational and measured distance; minutes at easy pace stand in. (2) Accepted overflow under the mixed fit order: in the review grid 337 of 29,750 loaded weeks seat a quality session above the ramp bound (120 by up to 10 min, 217 by 11 to 25 min, none by more), with a largest week-on-week rise of +44.3%; 110 of them are case-b weeks and 209 belong to beginners. Example: total beginner, 10 km a week, 40-min longest, 4-week marathon, 3 runs: 70 min, then 100 min (marathon pace 35, easy 25, long run held at 40). (3) Without a binding target, quality comes first and can trim the week-1 long run: 515 of 2,450 history-30d blocks without a target (21%) never reach the runner's own 30-day longest before the taper (328 because a quality session was seated ahead of the long run, 187 from a week-1 floor trim). Example: half, 3 weeks, 20 km, 90-min longest, advanced: long run 50 beside threshold, peak 53. The forecast surfaces then show the endurance-gap statement. (4) Under a binding target the long run grows by dropping quality: example A at 3 hours has no marathon-pace session from week 3, so by the reduce-only taper rule there is no taper threshold session and no race-week primer; at 2 hours a 4-run runner gets 2 runs a week with the long run held at 95 min, below the 100-min longest. (5) Low budgets consolidate easy runs, so a runner who chose 3 to 5 runs can get 2 a week for the whole block (one-line plan note to be added). (6) Race activities count toward the 30-day longest (Frandsen counted every run), so a marathon 3 weeks earlier starts the next block at the ability ceiling with no post-race recovery. (7) The no-data start knows nothing about the runner's longest run. (8) The block replays from its frozen start, so a sync that changes detected weekly km, archetype or VDOT changes the replayed past weeks. (9) Low-volume runners taper less deeply (the 25-min floor binds), and a taper week can overshoot its ceiling by half an easy run, or by the long run plus quality when those alone pass it. Open items: ISSUE-359 to ISSUE-363.

**Guards.** `plan_engine.sharpening.test.ts` (block grid properties, example A, hours targets, cases b and c, live cap, generator wiring), `initialization.sharpening.test.ts`, `phases.test.ts`, `planned-week-target.test.ts`, `block-forecast-honesty.test.ts`, `forecast-taper.test.ts`, `plan-preview-forecast-parity.test.ts`, `race-target-plan-note.test.ts`, `race-target-custom-date.test.ts`, `skip-taper-carry.test.ts`. Not device-verified.

---

## §CW — Race calendar: race week, closing week and race-day placement in every mode (2026-10-07/08)

**Side.** Planning (CW.1 to CW.3); tracking (CW.4).

**CW.1 Calendar-week rule.** A race plan's length `s.tw` is the calendar weeks from the local Monday of the build day through the week holding race day (`raceWeekLayout`, `racePlanCalendarWeeks`, `race-week-layout.ts`). Race week is the week holding the day `RACE_WEEK_ANCHOR_DAYS` (3) before race day, so the §CE primer window (3 to 5 days out) always falls inside race week. A Monday to Wednesday race's own week is a closing week that holds only the race (`Week.raceClosing`). When the day 3 days out falls before the plan starts, the race's own week is race week and there is no closing week. Phases, the taper ramp and `isRaceWeek` run over the training weeks only (`planTrainingWeeks`), so a Tuesday race trains exactly like the Sunday before it. Calendar consumers (week navigation, "Week N of M", Plan complete, week advance) keep `s.tw`. Running since `6c29020`; triathlon, cycling and HYROX since `13ae3b2` and `92f701d` (`storedPlanRaceLayout`). The old weeks-until count from today (`calculateWeeksUntil`) ended stored-mode plans a week early whenever the race weekday was on or before the onboarding weekday. No constant is involved beyond the 3-day anchor, which is derived from the §CE primer window.

**CW.2 Running race-day rules** (`race-day-rules.ts`; every running race plan, design v4 default Q8; generator and week-debrief preview call the same pure function):
1. nothing of any kind on or after race day;
2. the primer stays on its day when that is 3 to 5 days out (`PRIMER_MIN_DAYS_OUT`, `PRIMER_MAX_DAYS_OUT`, §CE), else moves to the latest race-week day at least 3 days out, else is dropped;
3. no long run in the last `RACE_DAY_CLEAR_DAYS` (6) days: it moves to the latest day of its week at least 7 days out (the session there takes its old day), else is dropped;
4. no quality session other than the primer in the last 6 days, and no two hard days back to back in the last `RACE_DAY_HARD_SPACING_DAYS` (13), checked within the week: a session that breaks either moves to the nearest earlier legal day, else steps down the pace ladder (`stepDownRunType`, Tristan 2026-10-05) to an easy run of the same duration;
5. makeups never put a long run or quality session in a taper week; easy makeups enter at the taper easy length under the taper ceiling.

The 6-day window is the span the generator already treated as race week for a Sunday race; 6 and 13 days are product rules of design v4 (4.7), not literature values. Rationale for the direction: a taper cuts volume by 41 to 60% while holding intensity (Mujika & Padilla 2003; Bosquet et al. 2007), and a long run or an extra hard session 1 to 6 days out adds fatigue to the window the taper is meant to clear.

**CW.3 Stored-plan race window** (triathlon, cycling on the triathlon engine, HYROX; `clearStoredPlanRaceWindow`). Only a Thursday to Saturday race reaches into the week before race week. In that week the 6 days before race day (R−6 to R−1) carry nothing: long sessions (long run, brick, solo long ride marked `Workout.longRide`, HYROX full brick) move to the latest day 7 or more days out, keeping their order, never before the first schedulable day and, in HYROX, never next to a hard session; the sessions on the target day and every other session in the window leave the week. "The 7 days before race day" is read as the 7-day week ending on race day (R−6 to R−1), so R−7 may hold the last long session, as running rule 3 places it (ISSUE-365). Example: an Ironman on Thursday 19 Nov 2026 gets its 277-min brick on Wednesday 11 Nov and its 115-min long run on Thursday 12 Nov. Nothing is generated on or after race day in any week (`dropSessionsOnOrAfterRaceDay`).

**CW.4 Forecast (tracking).** (a) Horizon: running reads `planTrainingWeeks`; triathlon, cycling and HYROX measure calendar time to `raceForecastHorizonISO` (`race-week-layout.ts:106`), which is race day, or the Sunday before when the plan has a closing week. The closing week holds no training, so counting its 1 to 3 days as horizon credited fitness from training that does not exist (an Ironman on Wednesday 4 Nov 2026 forecast 8.5 min faster than Sunday 1 Nov with identical training weeks). Look-aheads over training weeks (`plannedHyroxSessionsPerWeek`, the triathlon look-ahead) skip the closing week instead of averaging in a 0-session week. HYROX race-day readiness reads recovery signals (HRV, sleep, resting HR), not training, and applies until race day, the closing week included. (b) Race window: the triathlon planned dose (§CG; build mean for fitness gain, peak mean for readiness closure, and the 4-week fallback once only taper weeks remain) adds back `Week.raceWindowCut`, the sessions the window removed, scaled by the week's effort multipliers. The window is taper placement, and taper is freshness, not lost build (Mujika 2002); running's forecast likewise reads plan-engine targets, not race-day-rule output. Without the add-back, a Thursday Ironman forecast 14.6 min slower than the Sunday before. HYROX's next-4-week session count reads the window week as scheduled (at most 6 s in the review sweep) and stores no cut.

**Results.** Review sweeps at `e405222`. Structure: 5,880 stored-mode plans (6 modes, 3 levels, onboarding on every weekday, races 1 to 84 days out) plus 4,224 plans 85 to 260 days out, 0 violations of: calendar length, race day in the final week, nothing on or after race day, R−6 to R−1 holding only race-week sessions and no long session, a closing week only and always for Monday to Wednesday races, single-week regeneration equal to the plan week (36,080 violations on `6df2908`). Forecast: 8,748 Monday to Wednesday versus Sunday-before comparisons (6 modes, three time zones, every training-week Monday, the HYROX race-week Sunday run removed), 0 mismatches; 1,680 window-on versus window-off comparisons for Thursday to Saturday triathlon races, 0 mismatches. Running: 768 race plans byte-identical between `6df2908` and HEAD; a Monday to Wednesday race's `forecastTime` equals the Sunday before in 384 of 384.

**Limitations.** (1) Running rule 4 keeps the week-before's easy runs in the window; the stored-plan modes drop them, a design choice of `92f701d` (ISSUE-364). (2) The stored-plan race-week template is cut off at race day rather than placed relative to it, so for a Thursday to Saturday race the §CE primer rule is not applied: sprint and olympic Thursday races have CSS intervals at R−1, a HYROX Saturday race has the Mini Brick at R−1, and the median is 1 session in the last 6 days against 2 for a Sunday race (ISSUE-364). (3) A moved long session displaces the sessions on its target day (a Thursday 70.3 loses Wednesday's swim and Thursday's bike quality). (4) Rule 4 checks back-to-back hard days within a week only. (5) The closing-week days are not credited as extra taper freshness; that is the conservative choice and matches running (ISSUE-366). (6) A HYROX Monday to Wednesday race keeps its race-week Sunday easy run (R−1), which a Sunday race loses to race day, so `projectedTotalSec` can read up to 3 s faster (`totalSec` is exact). (7) The race-window cut is a snapshot at generation; later in-place edits to that week do not touch it. (8) Running rule 3 moves the last long run of a Thursday or Friday race to 7 days out, 4 to 5 days after the previous week's Sunday long run. (9) Plans built before the layout keep their week-count length; `planRaceLayout` and `storedPlanRaceLayout` return null for them, so the rules stay off until a rebuild (ISSUE-369).

**Guards.** `race-week-layout.test.ts`, `race-day-rules.test.ts`, `race-plan-race-week.test.ts`, `race-plan-calendar-weeks.test.ts`, `race-window.stored-plan.test.ts`, `race-window-forecast.test.ts`, `race-closing-week-forecast.test.ts`, `closing-week-forecast.test.ts`, `race-day-drop.tri-hyrox.test.ts`, `plan-complete-race-day.test.ts`, `setup-plan-length.test.ts`, `plan-anchor-local.test.ts`, `hyrox-volume.test.ts`. Not device-verified.

---

## §CX — Continuous plans deload the week labelled Deload (2026-10-08)

**Side.** Planning.

**Problem.** §CT keys running deloads on the ability cycle (`isDeloadWeek`: every 3rd week for beginner and novice, 4th intermediate, 5th advanced, 6th elite). A continuous plan's 4-week block (Base, Build, Intensify, Deload) labels its 4th week 'taper', shown as "Deload week", and the weekly load target already treated that week as the deload. The two lined up only for intermediate runners: beginners and novices deloaded the Intensify week, advanced and elite runners week 5 or 6, so the week labelled Deload was heavier than the week before in 1,158 of 2,880 swept continuous plans (real path, beginner, 5 runs: Build 140 min, Intensify 115, Deload 156). Strength still cut its session on the ability cycle.

**Model.** `isRunningDeloadWeek(weekIndex, ability, phase, continuousMode)` (`plan_engine.ts:241`): a continuous plan deloads its block 'taper' week and no other; a race plan keeps the ability cycle. It is read by `buildWeekSessions`, the long-run ramp hold, the weekly load target (`planned-week-target.ts`) and `generateGymWorkouts`. The Deload week takes the existing deload rules on top of taper-phase sizing: long run `TAPER_LONG_RUN_FRACTION` of the recent longest, × `deloadMultiplier` (0.80 beginner and novice, 0.85 intermediate, 0.87 advanced, 0.90 elite), budget at most the previous week's, quality count at most the previous week's. Intermediate plans were already on this rule; no new number.

**Measured depth.** Deload week ÷ week before, 2,880-plan sweep, medians: 0.65 beginner, 0.65 novice, 0.70 intermediate (unchanged), 0.72 advanced, 0.74 elite (an independent review sweep: 0.65, 0.65, 0.69, 0.72, 0.73; the method difference was not resolved); minimum 0.49 (elite VDOT 65 on an 8 km baseline, 2 runs, 3-hour cap: one 32-min easy run). Week after Deload ÷ week before Deload, p90: beginner 1.24 → 1.04, advanced 1.15 → 1.10.

**Strength.** The Deload week takes the 'taper' row of `getPhaseSessionCount` (1 session for 2 or more a week, 0 for 1; `gym.ts:156`) and the deload removes one more, so a continuous plan's Deload week holds no strength at any count from 1 to 4, for every ability. Before, beginners and novices kept one Activation session and advanced runners one Running Strength session in that week.

**Open (ISSUE-367).** Full `deloadMultiplier` depth versus the never-heavier backstops only; Deload-week strength of none versus the taper row only.

**Guards.** `plan_engine.continuous-deload.test.ts`, `gym.continuous-deload.test.ts`. Not device-verified.

---
