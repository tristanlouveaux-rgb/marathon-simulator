# Internal Load Currency — Audit Handover & Session Plan

> **For the dedicated "internal currency" session.** Written 2026-06-04 after ISSUE-263 was discovered while deciding whether the heavy-week suggestion modal should display TSS. Companion issues: ISSUE-262 (display normalizer divergence), ISSUE-259 (power-TSS, explicitly OUT of scope here).
>
> **Goal**: one canonical load scale, conversions only at pipeline boundaries, consistency tests that make this bug class unrepresentable.

---

## 1. The problem in one paragraph

The app computes "training load" on at least **four scales** and subtracts numbers across them. The cross-training suggester budgets its plan cuts (Garmin scale, ~1.6× TSS) against a credit from the universalLoad pipeline (annotated "TSS-equivalent"), while the weekly-target math uses a third, genuinely TSS-calibrated table, and the iTRIMP→TSS conversion exists in two competing variants (hardcoded population constant vs personal normalizer). Consequences observed in dogfooding: the suggester appears to systematically under-cut (the "absorbs 4.7 of 15.7 km" pattern), and the same activity displays different TSS on different screens.

## 2. Inventory of scales (verified, with evidence)

| # | Scale | Anchor (60-min easy run) | Definition | Used by |
|---|-------|--------------------------|------------|---------|
| 1 | **TSS-calibrated `TL_PER_MIN`** | ≈ 55 | `src/constants/sports.ts:11` — RPE-indexed, easy RPE4 = 0.92/min. Header comment verifies against TSS. | Weekly targets: `computeWeekRawTSS`, `computePlannedSignalB`, overshoot calc in `main-view.ts:2283-2290`, week-rollover carry in `events.ts:1097` (`TL_BY_TYPE`) |
| 2 | **Garmin-calibrated `LOAD_PER_MIN_BY_INTENSITY`** | ≈ 90 | `src/constants/sports.ts:219` — easy RPE4 = 1.5/min. Consumed by `calculateWorkoutLoad` (`src/workouts/load.ts:94`, comment: "Calculate load to match GARMIN scale") | Suggester cuts (`computeWorkoutWeightedLoad`, suggester.ts:470), planned-run loads (`workoutsToPlannedRuns`, suggester.ts:1259 via `w.aerobic`), matcher, planSuggester, plus many UI render sites |
| 3 | **universalLoad pipeline units** | iTRIMP tier: ≈ TSS (per its own comment) | `src/cross-training/universalLoad.ts` `computeTierAPlus` (~line 95): `iTrimp × 100 / 15000` → "TSS-equivalent units". **Other tiers (garmin/hr/rpe) scale NOT verified — audit them.** Outputs: FCL, RRC (`runReplacementCredit`), `equivalentEasyKm` | Suggester budget (`effectiveRRC`), the modal's header equivalent, excess-load card |
| 4 | **iTRIMP→TSS normalizers (two variants)** | — | Hardcoded `iTrimp × 100 / 15000` at ~30 sites vs personal LTHR-derived `getNormalizerFromState` (≈ 9,100 for Tristan, 65% off population default) | Strain ring (personal) vs `activity-detail.ts:171` and ~30 others (hardcoded) — ISSUE-262 |

**Orphan conversion constants inside `suggester.ts` (all three disagree):**
- `:1045` — `20 * 15` annotated "20 TSS × 15 (load units per TSS approx)" → claims 15 load/TSS
- `:1053` — `fullRrcTSS = equivalentEasyKm × easyPaceMin × 0.92` → converts via scale #1
- `:368-374` (deprecated) + `:1246` — "1 km easy ≈ 35 aerobic load" → implies ~5.8 load/min at 6 min/km

## 3. The live bugs

**B1 — Budget loop crosses scales (the ISSUE-263 core).** `buildReduceAdjustments` / `buildReplaceAdjustments`: `remainingLoad` starts at `effectiveRRC` (scale #3) and decrements by `loadReduction` from `computeWorkoutWeightedLoad` (scale #2) — `suggester.ts:494, 574`. If #3 is truly TSS-scale, every cut is over-valued ≈ 1.6× against the budget → the suggester stops cutting early → systematic under-cut. This is plausibly a large part of the "options absorb a small fraction of the excess" behaviour the modal redesign kept tripping over.

**B2 — Similarity ranking crosses the same scales.** `vibeSimilarity(actAerobic, actAnaerobic, run.plannedAerobic, run.plannedAnaerobic)` (`suggester.ts:431`) compares activity loads (scale #3) against planned-run loads (scale #2). `LOAD_SMOOTHING = 30` and the load-ratio term are tuned on mixed units. Candidate *ordering* may be mostly preserved (monotone in both), but the load-similarity weighting is not meaningful as tuned.

**B3 — Display divergence (ISSUE-262).** Same activity: 33 TSS (strain timeline, personal normalizer) vs 20 (`activity-detail.ts:171`, hardcoded `/15000`). ~30 hardcoded sites. SCIENCE_LOG:2623 documents the split as deliberate for planning-vs-CTL purposes but never anticipated both rendering user-visibly.

## 4. Proposed plan (in order)

1. **Audit pass (read-only).** Grep every load/TSS production + consumption site; classify each by scale (extend §2 table). Verify the unverified: universalLoad's garmin/hr/rpe tiers, `SPORTS_DB.mult` interaction, `CREDIT_MAX`/`TAU`/`MAX_EQUIVALENT_EASY_KM` (which scale are the saturation constants in?). Deliverable: complete scale map in this doc.
2. **Pick the canonical scale: TSS (1 h at LT = 100), i.e. scale #1's calibration.** It's already the app lingua franca (Strain ring, Signal B, carriedTSS, CTL/ATL, tri carry) and the only unit that extends to tri/cycling. *(Proposed, not yet formally signed off by Tristan — confirm at session start.)*
3. **ISSUE-262 prerequisite check FIRST**: validate Tristan's ltHR/restingHR/maxHR plausibility (LT at ~68% HRR flagged as low). If the profile is wrong, the *personal* normalizer is the broken one and it feeds CTL/ATL — decide personal-vs-population before standardising the iTRIMP conversion.
4. **Fix B1**: convert at the suggester boundary so budget and cuts share the canonical scale. Derive the conversion from the two tables (e.g. per-RPE ratio of `LOAD_PER_MIN_BY_INTENSITY` to `TL_PER_MIN`), do NOT invent a single factor. Rescale `minLoadThreshold` and any budget-relative constants in the same pass. Re-check B2's similarity weighting after.
5. **Sweep B3 display sites** (cross-cutting rule: list all ~30, fix all, re-grep zero).
6. **Consistency tests** (the durable deliverable): a test file asserting the anchors — "60-min easy run values ≈ 55 in every pipeline", "1 h at LT = 100", "suggester budget and cuts share a scale (cut of a full session ≤ its own load)".
7. **Calibration + freeze-check**: run against real activities (the n=83 device dataset from the adaptive-recovery work); snapshot readiness / ACWR / strain / CTL / ATL on current state before and after — CTL/ATL recalibration is OUT of scope, deltas there must be ~zero or explained.
8. **SCIENCE_LOG entry** declaring the canonical scale and the boundary-conversion law. Update CLAUDE.md if a new rule emerges ("new load producer must emit canonical TSS or convert at its boundary").

## 5. Decisions Tristan must make in-session

- Canonical scale = TSS via `TL_PER_MIN` calibration? (proposed yes)
- iTRIMP conversion: personal normalizer vs population `/15000` — pending the profile plausibility check (step 3)
- Is B2 (similarity weighting) in-scope or logged separately?
- After B1 lands, the suggestion modal will propose **larger cuts** — re-confirm the modal's behaviour/feel on device (its display math is scale-free ratios and adapts automatically, but `askKm` will grow)

## 6. Risks & gotchas

- **Suggester tests encode current-scale expectations** — they will fail and need principled updates against the canonical anchors, not nudged numbers (test-failure policy applies).
- **Saturation constants** (`CREDIT_MAX=1500`, `TAU=800`, `MAX_EQUIVALENT_EASY_KM`, `minLoadToTrigger=30`, `LOAD_BUDGET_CONFIG` percents are scale-free but the absolute ones aren't) live in whatever unit their pipeline used — rescaling the pipeline without rescaling them silently changes behaviour.
- **Shared files** (`sports.ts`, `state.ts`, `suggester.ts`) are multi-agent collision targets — `git diff <file> > /tmp/...` before editing.
- **Do not point-fix one conversion factor** — that's how the three orphan constants in §2 happened.
- SCIENCE_LOG already documents some of the split as deliberate (`:2623`) — read it before declaring anything a bug.

## 7. Quick orientation map

| File | Why it matters |
|------|----------------|
| `src/constants/sports.ts` | Both per-minute tables (#1 at :11, #2 at :219), `SPORTS_DB`, `LOAD_BUDGET_CONFIG` |
| `src/workouts/load.ts` | `calculateWorkoutLoad` — scale #2 producer ("GARMIN scale", :94) |
| `src/cross-training/universalLoad.ts` (+ `universal-load-constants.ts`) | Scale #3 producer; tier-by-tier conversions; FCL/RRC/equivalentEasyKm |
| `src/cross-training/suggester.ts` | B1 (:494, :574), B2 (:431), orphan constants (:368, :1045, :1053, :1246), `effectiveReductionBudget` payload field (added 2026-06-03) |
| `src/calculations/trimp.ts` | iTRIMP + `getNormalizerFromState` (personal normalizer) |
| `src/calculations/fitness-model.ts` | CTL/ATL — freeze-check target, not a change target |
| `src/ui/main-view.ts:2270-2300` | overshootTSS (scale #1) fed into the suggester as `maxReductionTSS` — another implicit cross-scale boundary |
| `src/ui/events.ts:1090-1145` | Week-rollover carriedTSS (scale #1-ish) |
| `docs/OPEN_ISSUES.md` | ISSUE-263 (this), ISSUE-262 (displays), ISSUE-259 (power-TSS, out of scope) |
| `memory/project_suggestion_modal_glass_redesign.md` | Why the modal displays "equivalent of easy running" and why TSS display is blocked on this work |

## 8. Session progress (2026-06-04, live)

**Decisions locked by Tristan:**
- ✅ **Canonical scale = TSS, 1 h at LT = 100** (TL_PER_MIN calibration, 60-min easy ≈ 55). Signed off.
- ✅ **B2 (similarity weighting) in scope** — inputs become same-scale under canonicalisation; re-verify LOAD_SMOOTHING=30 ranking afterwards.
- ✅ **Display currency: TSS-led with mode-aware caption, identical pattern in every mode.** Modal wording: "…come down by ≈ 45 TSS — about 4.7 km of easy running." Headline = canonical TSS (same number as the strain ring). Caption = plain-language equivalent derived from the TSS at render time, mode-aware (easy-run km in running; "≈ 25 min easy riding" when the cut lands on the bike; etc.), cosmetic only, never arithmetic'd against. This finally unblocks the modal-TSS display item from the suggestion-modal redesign.
- ✅ **Normalizer is plausibility-gated for the general population, not hand-fixed for Tristan**: ltHR within a physiological band (LTHR ~80–95% maxHR — band to be sourced from literature, not invented) → personal normalizer; missing/out-of-band → population 15,000 fallback. Gate lives at the normalizer boundary so all entry paths (Garmin snapshot, derived estimator, manual) are covered. Tristan's 144-bpm profile = test case #1.

**§5 profile plausibility check (ISSUE-262 prerequisite) — RESOLVED in principle:**
- Formula: `computeAthleteNormalizer` (fitness-model.ts:267) = `3600 × HRR_LT × e^(1.92 × HRR_LT)` (Coggan hrTSS, Banister β=1.92). The formula is sound; the *input* is the bug.
- Tristan's profile (from Garmin): restingHR 42, maxHR 192, LT pace 4:12/km. Stored ltHR ≈ 144 implied by the ~9,100 normalizer → LT at 68% HRR / 75% maxHR — physiologically implausible for a 4:12/km-threshold athlete (expect 85–92% maxHR ≈ 163–177 bpm).
- Normalizer table: stored profile → 9,033 (TSS inflated +66%); population fallback → 15,000; plausible ltHR 172 → ≈16,477 (TSS ~10% *below* population).
- **Conclusion: keep the personal normalizer (scientifically better), fix the stored ltHR.** `s.ltHR` is written only via `applyResolved` (ltSync.ts:260) from the LT resolver chain — source visible in Stats LT subtitle + `s.ltSource`. PENDING: Tristan to read the actual LTHR bpm off Garmin (shown next to the 4:12 pace) and identify which resolver source produced 144.

**CORRECTION (post-audit, device console check from the parallel ISSUE-268 session)**: Tristan's ACTUAL stored profile is ltHR 177 / rest 43 / max 201 → 88% maxHR, IN-band, normalizer ≈ 15,556 (within 4% of population). The handover's "~9,100 / 68% HRR" was stale — his CTL/ATL were never +66% inflated, and freeze-check Phase A deltas should be ~4%, not ~40%. The plausibility gate ships as the general-population protection regardless; the 144-profile is the hypothetical it guards against. When ISSUE-268 lands the watch LT (168 bpm @ 201), the normalizer becomes ~13,000 (TSS +19%) — in-band, and now ALL surfaces shift together because the B3 sweep routed every decode through `normalizeiTrimp`.

**Audit fleet**: workflow `wf_ebba8d99-ac2` (8 census + 1 empirical + 5 adversarial verifiers + synthesis). First run killed by session rate limit 2026-06-04 00:39 BST; relaunched 09:30 BST.

## 9. Definition of done

- One documented canonical scale; every producer either emits it or converts at its boundary.
- Anchor tests green and impossible to pass with mixed scales.
- Suggester budget loop unit-consistent; modal re-verified on device (cuts will be larger).
- ISSUE-262 display sweep complete (re-grep zero hardcoded `/15000` in user-facing surfaces, or each survivor justified in a comment).
- Readiness/ACWR/CTL/ATL deltas on Tristan's real state: ~zero or explicitly explained.
- SCIENCE_LOG entry; ISSUE-262 + ISSUE-263 marked fixed only after Tristan device-confirms.

---

# AUDIT RESULTS — 2026-06-04 fleet (15 agents, 2.3M tokens)

> Supersedes §2 where they disagree. CORRECTION to §2 row 3: universalLoad Tier A+ uses the PERSONAL normalizer (normalizeiTrimp with no 2nd arg → _athleteNorm), NOT /15000 — the universalLoad.ts:101 comment is wrong.


## A. Complete scale map

## Complete Scale Inventory (extends handover §2)

The handover's 4-scale model is **incomplete**. The codebase carries load on **8 distinct numeric scales** (4 documented + 4 surfaced). Anchors are the 60-min easy-run value; "measured" = empirical agent's live run (scratch deleted), "inferred" = from constants.

| # | Scale | 60-min easy anchor | Definition / source | Producers (file:line) | Consumers (file:line) |
|---|-------|-------------------|---------------------|----------------------|----------------------|
| **1** | **`TL_PER_MIN` — canonical TSS** | **55.2 @ RPE4 (header); 39 @ RPE3 (live easy run); 69 @ RPE5 (unrated fallback)** | `sports.ts:11`, RPE-indexed TSS, 1h@LT=100. *Three live easy anchors because generator assigns easy→RPE3.* | `sports.ts:11`; `fitness-model.ts:489,492,515,538` (computeWeekRawTSS), `:768-774` (computePlannedDaySignalBTSS), `:315` (computeStrengthRpeTSS); `events.ts:1079` (`TL_BY_TYPE`, easy=0.92); `main-view.ts:2289` (overshoot); `timing-check.ts:83` (`TSS_PER_MIN`, RPE4=0.8) | strain ring, CTL/ATL, carriedTSS, overshoot calc, planned-day-tss (running branch `planned-day-tss.ts:124`) |
| **2** | **`LOAD_PER_MIN_BY_INTENSITY` — Garmin** | **90 @ RPE4 (1.5/min); measured easy 10 km aero 86, total 91, 1.56× TSS** | `sports.ts:219`, "GARMIN scale" | `load.ts:94-97` (calculateWorkoutLoad); `cross-training/activities.ts:204` (estimate path); `generator.ts:297-298` (stamps running `w.aerobic`); `events.ts:1851` (re-stamp on rating); `suggester.ts:470-476` (cut size), `:1386` (applyAdjustments write-back) | suggester cuts, planSuggester cuts, planned-run `w.aerobic`, matcher, getWeeklyLoad |
| **3** | **`LOAD_PER_MIN_BY_RPE` — 2nd Garmin table** | **96 @ RPE4 (1.6/min)** | `universal-load-constants.ts:139`, "aligned with Garmin scale". *Disagrees with #2: RPE4 1.6 vs 1.5.* | `universalLoad.ts:214` (Tier C); `suggester.ts:200` (deprecated resolveActivityLoad LOAD_PER_MIN, easy=1.6) | universalLoad Tier C, dead suggester path |
| **4a** | **universalLoad Tier A+ (iTRIMP) — PERSONAL-normalizer TSS** | **measured 56.4 (norm ~9100); pop /15000 = ~33–34; suspect-ltHR144 = 96.5** | `universalLoad.ts:114` `normalizeiTrimp(iTrimp)` **NO 2nd arg → `_athleteNorm` (personal, set `main.ts:435`), NOT /15000** despite the `:101` comment | RRC/FCL → suggester budget; **the dominant real-data path (Strava/Garmin HR streams)** | suggester `effectiveRRC`, modal equivalentEasyKm, excess card |
| **4b** | **universalLoad Tier A (raw Garmin Firstbeat)** | **measured base 90, RRC 165.5 (1.6× iTRIMP tier)** | `universalLoad.ts:140-144` — `garminAerobic/garminAnaerobic` passed through **raw, no normalize, no sportMult** | (same RRC/FCL) | same budget |
| **4c** | **universalLoad Tier B (zone-weight minutes [1..5])** | **measured base 115–130 (~2.1× TSS)** | `universalLoad.ts:170-179` — `Σ zoneMin × HR_ZONE_WEIGHTS`, **no normalize, no sportMult** | (same RRC/FCL) — largest, most unanchored | same budget |
| **4d** | **universalLoad Tier C (RPE)** | **measured base 57.6, RRC 108 (×0.80 uncertainty)** | `universalLoad.ts:214-225` — `dur × LOAD_PER_MIN_BY_RPE × sportMult × AF × 0.80` (Garmin-ish) | (same RRC/FCL) | same budget |
| **5** | **iTRIMP→TSS population `/15000`** | **~33–34 (iTrimp 5000)** | hardcoded `iTrimp×100/15000` at **~30 display + 6 matcher-cache + 3 sync sites** | `activity-matcher.ts:757,1149,1314,1532,1799,1924` (`wk.actualTSS`), `:890`; `home-view.ts:148` (`normalizeiTrimpLocal`); `activity-detail.ts:171`; `plan-view.ts:417`; `main-view.ts:1609,1671,2325`; `excess-load-card.ts:223`; `stravaSync.ts:605,698`; `appleHealthSync.ts:1605`; `renderer.ts:1031`; `activity-review.ts:1510,2165`; `sport-picker-modal.ts:218`; `triathlon/plan-view.ts:62`; `triathlon/progress-detail-view.ts:125` | activity-detail display, Load-vs-Plan bar actuals, `wk.actualTSS` cache, sync aggregates |
| **5-tri** | **iTRIMP→TSS population `/150` (== /15000 ×100)** | **~33–34** | `tri-benchmarks-from-history.ts:907` (`iTrimp/150`, planned encode `×150` at :895); `tri-cross-training-overload.ts:308`; `fitness-model.ts:1716` (recovery countdown) | **ENTIRE TRI FITNESS MODEL** + recovery countdown | tri CTL/ATL/Form (population) — diverges from running CTL/ATL (personal) by ~1.65× |
| **6** | **personal-normalizer TSS (`getNormalizerFromState`)** | **measured ~56 (norm ~9100); plausible ltHR172 → ~50.6; suspect ltHR144 → 96.5** | `fitness-model.ts:291` (no-arg `normalizeiTrimp`), `:267` (computeAthleteNormalizer = `3600×hrr×e^(1.92·hrr)`, fallback 15000) | strain `strain-view.ts:149,194,548`; stats `stats-view.ts:2030` (already fixed w/ comment); all CTL/ATL; computeWeekRawTSS; **universalLoad Tier A+** | strain ring, CTL/ATL, Signal-B (the canonical internal pipeline) |
| **7** | **tri-engine `w.aerobic+w.anaerobic` per-workout TSS** | **easy run ~60 (0.95+0.05/min); bike endurance ~51 (0.85); swim endurance ~60 (1.0); threshold ~93** | `plan_engine.triathlon.ts:668,676,686` (run), `:348` (strength 20+10); `bike.ts:352` ("Rough TSS-per-minute, Phase 4 → real bTSS"); `swim.ts:218` ("Phase 4 → cubed-IF") | `planned-day-tss.ts:96` (tri branch sums `w.aerobic+w.anaerobic` AS TSS); `coach-context-builder.ts:105`; `capacity-strain.ts:90` (tri planned anchor) | tri planned-day TSS, AI coach TSS, tri strain target. *~60/hr ≈ 1.09× scale-1's 55* |
| **8** | **Garmin Training Effect 0–5 (`aerobicEffect`)** | **~2.5–3 for 60-min easy (0–5 scale)** | `activity-matcher.ts:1876` stamps `workout.aerobic = item.aerobicEffect`, `anaerobic = item.anaerobicEffect` (`state.ts:340` "Garmin Training Effect (0-5)") onto **the same `w.aerobic` field tri reads as TSS** | `planned-day-tss.ts:96` (tri), `coach-context-builder.ts:105`, `tri-cross-training-overload.ts:318` read it as TSS | **SEVERE**: synced cross adhoc contributes ~3–8 instead of ~50 to tri "TSS" sums |
| **MTL** | **`musculoTendonLoad` (HYROX, correctly siloed)** | n/a (not TSS) | `mtl.ts:35` (`durMin×sRPE×modality×impact`); `plan_engine.hyrox.ts:170` (enforceMTLCap) | HYROX cap only; `planned-day-tss` synthesizes HYROX TSS separately via `dur×TL_PER_MIN` | **No cross-scale leak** — keep OUT of canonicalisation |
| **orphan** | **3 disagreeing easy-load-per-km constants** | n/a | `EASY_LOAD_PER_KM=12` (`universal-load-constants.ts:228`, live); `35` (`suggester.ts:377,1248`, deprecated-but-live fallback); `15 load/TSS` (`suggester.ts:1051` `20*15`); measured true ~8.6/km | RRC→equivalentEasyKm, modal headline, km-from-load fallback | modal "≈ X km easy" display |

**Saturation/threshold constants (in RRC units, NOT scale-free — must rescale together):** `TAU=800`, `CREDIT_MAX=1500` (`universal-load-constants.ts:83,86`); `MAX_EQUIVALENT_EASY_KM=25`; `minLoadToTrigger=30` (`sports.ts:233`, Garmin units); `minLoadThreshold=5` (`suggester.ts:501`, Garmin); `LOAD_SMOOTHING=30` (`suggester.ts:179`, mixed).


## B. Cross-scale boundaries by severity

## Cross-scale boundaries, ordered by severity (user-visible impact × error multiplier)

**SEV-1 — `aerobicEffect` (0–5) on `w.aerobic` read as TSS.** `activity-matcher.ts:1876` (scale #8, 0–5) → `planned-day-tss.ts:96` / `coach-context-builder.ts:105` / `tri-cross-training-overload.ts:318` (read as scale #7 TSS). **Multiplier: ~10–20× UNDER** (3–8 vs ~50). Symptom: a real synced cross-training session contributes almost nothing to the tri week's planned/actual TSS and the AI coach sees a near-zero load. *Undocumented; not in handover. NEEDS RUNTIME CONFIRMATION that aerobicEffect actually lands on `w.aerobic` for accepted Garmin pending cross items vs being overwritten.*

**SEV-2 — Tri fitness model on population `/150` vs running on personal `~9100`.** `tri-benchmarks-from-history.ts:907` + `tri-cross-training-overload.ts:308` (scale #5-tri, /150) vs `fitness-model.ts:291` (scale #6, personal). **Multiplier: ~1.65× (Tristan)**. Symptom: the same iTRIMP session yields ~1.65× different CTL/ATL/Form in tri mode vs running mode. *Handover frames personal-vs-pop as a display bug (ISSUE-262); this is a deeper **cross-mode fitness-model** mismatch. Confirm no caller injects a personal norm into the tri path.*

**SEV-3 — B1 budget loop: RRC budget vs Garmin cuts.** `suggester.ts:494,574,728` + **`planSuggester.ts:456` (2nd site, doc missed)** — `remainingLoad = effectiveRRC` (scale #4, tier-dependent) decremented by `computeWorkoutWeightedLoad` (scale #2, Garmin, `suggester.ts:470`). **Multiplier: per-RPE ratio 1.63 (RPE4 easy) to ~2.0 (RPE7+)** — NOT a flat 1.6×. Symptom: the heavy-week modal absorbs only a fraction of the excess ("4.7 of 15.7 km"). **DIRECTION IS DISPUTED** (see contradictions): cut-side firmly Garmin; budget-side is tier-dependent and the saturation curve's near-zero slope (CREDIT_MAX/TAU = 1.875×) amplifies small rawRRC, so for the iTRIMP/cycling path the loop may actually OVER-cut vs the system's own `equivalentEasyKm`. The observed under-cut may be driven by `MAX_ADJUSTMENTS`/`minLoadThreshold`/`floorKm`/`capFraction` guards, not the budget magnitude alone — **trace before attributing the symptom solely to B1.**

**SEV-4 — universalLoad tier inconsistency (5th-scale-inside-#3).** `universalLoad.ts:114` (Tier A+ ≈ personal TSS) vs `:140` (Tier A raw Garmin) vs `:170` (Tier B zone-weight ~2.1×) vs `:214` (Tier C Garmin ×0.80). **Multiplier: up to 3.17× (cycling base 41/90/130/55) for one identical session** depending only on which data tier ingested it. Symptom: identical sessions get ~3× different RRC credit; the suggester budget jumps by data source. *The test suite (`universalLoad.test.ts:855`) institutionalises this by only asserting A+ vs C agree within 0.3–3×; B and A are never compared.* Compounded by **sportMult asymmetry** (applied in A+/C, NOT in A/B).

**SEV-5 — `excess-load-card` synthetic round-trip.** `excess-load-card.ts:342` encodes `iTrimp = excess×150` (population inverse) from a personal-scale `excess` (`computeWeekRawTSS`), then universalLoad decodes via personal norm. **Multiplier: ~1.65× inflation (Tristan)**. Symptom: the synthetic "Week overload" activity sizes reductions ~1.65× too large in the synthetic path (while the budget loop under-cuts in the Garmin path — **the two errors do NOT cancel**).

**SEV-6 — `wk.actualTSS` population cache vs scale-1 planned (week-rollover carry).** `activity-matcher.ts:757…1924` write population `/15000` into `wk.actualTSS`; `events.ts:1078` prefers it over personal `computeWeekTSS`, then subtracts a scale-1 `plannedTSS` (`TL_BY_TYPE`, `:1097`). **Multiplier: ~0.61× (actual reads ~39% LOW)**. Symptom: carriedTSS understated when the cache is populated. *`computeWeekTSS` explicitly distrusts `wk.actualTSS` as "may be stale/corrupted" but events.ts trusts it.*

**SEV-7 — Load-vs-Plan bar chart: population actuals vs scale-1 planned.** `main-view.ts:1609,1671` (actuals `/15000`) vs planned bars (scale #1). **Multiplier: ~0.61×**. Symptom: actual bars render ~39% shorter than planned on a shared axis. *Note `main-view.ts:1583` already converts the planned side Garmin→TSS via per-RPE ratio — so this bar is NOT a Garmin-vs-TSS bug (handover wrong on that point), it's a residual personal-vs-population mix.*

**SEV-8 — B2 similarity: activity (scale #4, personal-TSS) vs planned-run (scale #2, Garmin).** `suggester.ts:309,431`, `vibeSimilarity` load term `1/(1+|w1−w2|/30)`. **Multiplier: w1 ~2.0–2.4× smaller than w2.** Symptom: load term biased toward shortest candidate; **flips ranking whenever two candidates share an intensity zone** (zone bonus can't break the tie) and in `alreadyCompletedMatch` (no zone bonus). *Worse than handover's "ordering mostly preserved" hedge.*

**SEV-9 — Intra-scale-1 contradiction: `TL_BY_TYPE` (easy=0.92) vs generator (easy=RPE3=0.65).** `events.ts:1079` vs `intent_to_workout.ts:54`. **Multiplier: 1.42×.** Symptom: carriedTSS over-values easy/long carry by 42% relative to `computeWeekRawTSS`. Plus the **phantom ×1.2 long multiplier** in `sports.ts:9` header exists in no TSS pipeline (long is valued linearly; comment overstates by 1.7×).

**SEV-10 — overshoot→suggester handoff.** `main-view.ts:2296` (overshootTSS, clean scale #1) → `suggester.ts:1059` `fullRrcTSS = equivalentEasyKm × easyPaceMin × 0.92` (scale-1) → capFraction scales `effectiveRRC` (scale #4). **The capFraction is scale-1-consistent**, but it scales a budget then spent against Garmin cuts. *`EASY_LOAD_PER_KM=12` inside fullRrcTSS is ~2.2× true easy TSS/km (5.52), inflating capFraction ~1.67× → small-overshoot damping (capFraction≤0.35/0.65) rarely engages.*


## C. Canonical spec (decisions folded in)

## Canonical currency spec — TSS, 1h at LT = 100 (LOCKED by Tristan, handover §8)

**Canonical unit:** TSS where 1 hour at lactate threshold = 100, i.e. `TL_PER_MIN` (scale #1) calibration. Per-RPE intensity curve. iTRIMP path: `iTrimp × 100 / normalizer` with the **personal** normalizer (locked: plausibility-gated, not hand-fixed).

### Conversion law per producer (derived from existing tables — NO invented constants)

| Producer | Current scale | Conversion to canonical TSS | Status |
|----------|--------------|------------------------------|--------|
| `TL_PER_MIN` (sports.ts:11) | already TSS | identity | SAFE |
| `calculateWorkoutLoad` (load.ts:94) Garmin | #2 | **÷ per-RPE ratio `LOAD_PER_MIN_BY_INTENSITY[rpe]/TL_PER_MIN[rpe]`** = 1.63@RPE3, 1.63@RPE4(1.5/0.92), 1.74@RPE5, 1.97@RPE7, 2.03@RPE8. Equivalently: emit `dur×TL_PER_MIN[rpe]×profile`. | derived |
| universalLoad Tier A+ iTRIMP (uniLoad:114) | #4a personal-TSS | identity **once ltHR fixed** | SAFE-after-ltHR |
| universalLoad Tier A raw Garmin (uniLoad:140) | #4b | **÷ ~1.63** (per-RPE Garmin→TSS) AND apply sportMult (currently missing) | derived |
| universalLoad Tier B zone-min (uniLoad:170) | #4c | **replace `Σ zoneMin×[1..5]` with the TSS-IF intensity factors already in `classifyWorkoutType` (uniLoad:588: easy 0.55 / thr 0.85 / vo2 1.1)** + apply sportMult | derived (reuse existing) |
| universalLoad Tier C RPE (uniLoad:214) | #4d Garmin | **swap `LOAD_PER_MIN_BY_RPE` → `TL_PER_MIN`** (keep ×0.80 uncertainty, sportMult, AF) | derived |
| tri-engine `w.aerobic+w.anaerobic` (plan_engine.tri, bike.ts, swim.ts) | #7 ~60/hr | **TRISTAN-DECISION**: re-anchor easy to 55 (×0.917) OR accept ~60/hr as deliberate. Bike/swim are explicitly "Phase 4 placeholder" (ISSUE-259 power-TSS out of scope). | TRISTAN-DECISION |
| `aerobicEffect` 0–5 (matcher:1876) | #8 | **No defensible 0–5→TSS map exists. STOP stamping TE on `w.aerobic`** — route synced cross through the iTRIMP/duration TSS path instead. | TRISTAN-DECISION (likely: don't write TE to that field) |
| `TL_BY_TYPE` (events.ts:1079) | #1-variant | **replace lookup with `TL_PER_MIN[canonical-rpe-for-type]`** so carry == computeWeekRawTSS | derived |
| `TSS_PER_MIN` (timing-check.ts:83, RPE4=0.8) | #1-variant | **replace with `TL_PER_MIN`** | SAFE |
| population `/15000` & `/150` display/cache sites (scale #5, #5-tri) | population | **replace with `getNormalizerFromState(s)`** (personal) — the B3 sweep | mechanical SAFE |
| MTL (mtl.ts:35) | separate currency | **DO NOT convert** — keep siloed | n/a |

### Constants that MUST rescale together when RRC moves to TSS (the saturation trap)
- `CREDIT_MAX=1500`, `TAU=800` (`universal-load-constants.ts:83,86`) — RRC units; near-zero slope = CREDIT_MAX/TAU = 1.875× is load-bearing.
- `EASY_LOAD_PER_KM=12` (`:228`) — must become true easy TSS/km (≈ `easyPaceMin × TL_PER_MIN[3]` ≈ 6×0.65 = 3.9, or ×0.92 = 5.52 — **TRISTAN-DECISION which RPE**).
- `MAX_EQUIVALENT_EASY_KM=25`; `minLoadToTrigger=30` (`sports.ts:233`); `minLoadThreshold=5` (`suggester.ts:501`); `LOAD_SMOOTHING=30` (`suggester.ts:179`).
- capFraction severity thresholds `0.35/0.65` (`suggester.ts:1066`) — tuned against the wrong `fullRrcTSS`.
- Orphan `20*15` (`suggester.ts:1051`) and `35 load/km` (`suggester.ts:377,1248`) — **delete/reconcile to one derived constant**.

### Boundary-conversion law
**Producers emit canonical TSS at construction** (preferred for the universalLoad tiers — a single suggester-side factor CANNOT fix tier-dependent inputs, per the tier-consistency verdict). For the suggester specifically: convert `calculateWorkoutLoad` output to TSS via the per-RPE ratio **at the boundary** so cuts and the (now-TSS) RRC budget share a scale. Apply to **both** `suggester.ts` AND `planSuggester.ts:456`.


## D. Fix list

## Ordered per-site fix list (handover steps 4–6)

### Step 3 prerequisite (BEFORE anything) — TRISTAN-DECISION (already resolved in principle, §8)
- `s.ltHR` 144 is the bug. Source = `applyResolved` (ltSync.ts:260). PENDING: Tristan reads actual LTHR off Garmin, identifies which resolver produced 144, plausibility-gate at the normalizer boundary (LTHR 80–95% maxHR band, source from literature). Until fixed, personal norm ~9100 inflates ALL running CTL/ATL +66%. **This must land before B3, else the sweep canonicalises onto a wrong personal scale.**

### Step 4 — B1 boundary fix (RISKY, device-verify; larger cuts expected)
1. **RISKY** `suggester.ts:470-476` `computeWorkoutWeightedLoad` → divide by per-RPE `LOAD_PER_MIN_BY_INTENSITY[rpe]/TL_PER_MIN[rpe]` (emit TSS cuts).
2. **RISKY** `universalLoad.ts:140` Tier A → ÷~1.63 + sportMult; `:170` Tier B → swap to `classifyWorkoutType` IF factors + sportMult; `:214` Tier C → swap `LOAD_PER_MIN_BY_RPE`→`TL_PER_MIN`. (Makes ALL tiers emit TSS so the leak doesn't invert onto non-iTRIMP tiers.)
3. **RISKY** `planSuggester.ts:456,476,489,493` — **second B1 site**; same TSS-cut conversion or the file stays broken.
4. **RISKY** Rescale together: `CREDIT_MAX`, `TAU` (`universal-load-constants.ts:83,86`), `EASY_LOAD_PER_KM` (`:228`), `minLoadThreshold=5` (`suggester.ts:501`), `minLoadToTrigger=30` (`sports.ts:233`), `MAX_EQUIVALENT_EASY_KM`, `LOAD_SMOOTHING` (`suggester.ts:179`), capFraction thresholds (`suggester.ts:1066`).
5. **SAFE** Delete orphans: `suggester.ts:1051` (`20*15`), `:377` (deprecated `easyLoadPerKm=35`), reconcile `:1248` km-from-load to one derived constant.
6. **RISKY** `excess-load-card.ts:342` — encode `iTrimp = excess × _athleteNorm/100` (personal), not `×150`, so the round-trip is self-consistent.
7. **SAFE** `suggester.ts:933` docstring says "converts using EASY_LOAD_PER_KM" — code uses `fullRrcTSS` path; fix docstring.

### Step 5 — B3 display sweep (mostly SAFE, mechanical; ~30 sites)
Replace hardcoded `/15000` (and `/150`) with `getNormalizerFromState(s)`. Template: `stats-view.ts:2030` (already done, with comment).
- **SAFE**: `activity-detail.ts:171`, `home-view.ts:148` (`normalizeiTrimpLocal`)+`:195,228,2322`, `plan-view.ts:417`, `main-view.ts:1609,1671,2325`, `renderer.ts:1031`, `activity-review.ts:1510,2165`, `sport-picker-modal.ts:218`, `triathlon/plan-view.ts:62`, `triathlon/progress-detail-view.ts:125`, `excess-load-card.ts:223`.
- **SAFE** sync pipes write personal: `stravaSync.ts:605,698`, `appleHealthSync.ts:1605`.
- **RISKY** `activity-matcher.ts:757,1149,1314,1532,1799,1924` (`wk.actualTSS` cache) — population writes consumed by `events.ts:1078`. Either write personal OR stop trusting the cache (use `computeWeekTSS`). Touches carry math — verify.
- **TRISTAN-DECISION** `tri-benchmarks-from-history.ts:907`, `tri-cross-training-overload.ts:308`, `fitness-model.ts:1716` — the **tri fitness model** on /150. Switching tri to personal norm **changes tri CTL/ATL** (out-of-scope per handover "CTL/ATL deltas ~zero"). Decide: leave tri on population (accept cross-mode mismatch, document) OR migrate tri to personal (a real model change, separate freeze-check).

### Step 5b — SEV-1 collision (TRISTAN-DECISION)
- `activity-matcher.ts:1876` — stop stamping `aerobicEffect`/`anaerobicEffect` (0–5) onto `w.aerobic/w.anaerobic`. Route synced cross through the iTRIMP/duration TSS path. **Confirm at runtime first** that TE actually lands there.

### Step 6 — anchor / intra-scale-1 cleanup (SAFE)
- `events.ts:1079` `TL_BY_TYPE` → `TL_PER_MIN[canonical-rpe-for-type]`.
- `timing-check.ts:83` `TSS_PER_MIN` → `TL_PER_MIN`.
- **TRISTAN-DECISION** Reconcile easy-run RPE: generator emits RPE3 (39 TSS) but header/memory cite 55 (RPE4). Pick one; make the anchor test match the generator. Phantom ×1.2 long multiplier (`sports.ts:9`): add to pipeline or remove from header.


## E. Anchor test plan

## Anchor consistency tests (the durable deliverable)

**CRITICAL FIRST**: resolve the easy-run RPE convention before writing these, or they freeze the wrong number. The live generator emits easy→RPE3 = **39 TSS** for 60 min; the header/memory cite **55** (RPE4). The anchor MUST match whatever the generator assigns.

1. **`60-min easy run ≈ canonical TSS in every pipeline`** — assert `computeWeekRawTSS`, `computePlannedDaySignalBTSS`, `planned-day-tss` (running+tri), `TL_BY_TYPE` carry, and `timing-check` all return the SAME value (within ±2) for an identical 60-min easy run at the canonical RPE. *Makes the 3-anchors-for-easy bug (39/55/69) unrepresentable.*

2. **`1h at LT = 100`** — `normalizeiTrimp(itrimp_for_1h_at_LT) === 100` for the personal normalizer. Pins the canonical definition. *Makes a normalizer regression visible.*

3. **`universalLoad tiers agree within 15%`** — TIGHTEN `universalLoad.test.ts:855` from the current 0.3–3× tolerance to ~1.15×. Construct one 60-min easy session, feed it through A+/A/B/C, assert all four baseLoads ≈ canonical TSS. *Makes the 3.17× tier divergence unrepresentable; the current test institutionalises the bug.*

4. **`suggester budget and cuts share a scale`** — assert the cut cost of replacing/reducing a full session ≤ its own RRC budget contribution (`computeWorkoutWeightedLoad(full session) ≤ RRC` after conversion). *Makes B1 (Garmin cut vs TSS budget) impossible to reintroduce.* Add the identical assertion for `planSuggester`.

5. **`equivalentEasyKm round-trips`** — `RRC / EASY_LOAD_PER_KM × (easyPaceMin × TL_PER_MIN[rpe]) ≈ RRC`-as-TSS. *Pins the orphan constant to the canonical scale; makes the 12/35/15 disagreement representable as a failure.*

6. **`excess-card synthetic round-trips`** — encode an excess TSS to iTrimp then decode via universalLoad; assert output ≈ input. *Makes the population-encode/personal-decode mismatch fail loudly.*

7. **`aerobicEffect never reaches a TSS sum`** — assert that for a synced cross activity, the value feeding `planned-day-tss`/coach is a TSS-scale number, not a 0–5 TE. *Makes SEV-1 unrepresentable.*

8. **`per-RPE Garmin→TSS ratio table`** — unit-test that `computeWorkoutWeightedLoad('easy',10,4)` ≈ 1.63× the TSS of the same run (asserting the conversion law, not a single factor — guards against the "don't invent one factor" rule).

9. **`no hardcoded /15000 or /150 in user-facing src/ui`** — a grep/AST test (re-grep zero). *Makes B3 regressions fail in CI.*


## F. Contradictions to settle

## Unresolved disagreements the main session MUST settle before building

1. **B1 DIRECTION — under-cut vs over-cut (the biggest open question).** The handover and the consumers/suggester census say **systematic UNDER-cut** (~1.6×, "absorbs 4.7 of 15.7 km"). The **B1-budget-scale verifier REFUTES the direction**: cut-side is firmly Garmin, but RRC is `saturate(baseLoad×runSpec×goalFactor)` and the saturation near-zero slope (CREDIT_MAX/TAU=1.875×) amplifies small rawRRC, so for the dominant iTRIMP/cycling path the loop tends to **OVER-cut** vs the system's own equivalentEasyKm — same ~1.6× magnitude, opposite sign. **The observed "4.7 of 15.7 km" symptom may NOT be the budget magnitude at all** but the `MAX_ADJUSTMENTS`/`minLoadThreshold`/`floorKm`/`capFraction` guards. **Action: instrument a real activity and trace `effectiveRRC` vs Σ cuts vs how many runs got touched BEFORE choosing the fix direction.** Getting this wrong means the "larger cuts" device-verification expectation in §8/§9 could be backwards.

2. **universalLoad normalizer: personal, NOT /15000 (handover §2 row 3 is WRONG).** Every verifier independently confirmed `computeTierAPlus` calls `normalizeiTrimp(iTrimp)` with no 2nd arg → `_athleteNorm` (personal ~9100), despite the `:101` comment claiming /15000. **I verified this directly** (`fitness-model.ts:291` default `?? _athleteNorm`; `universalLoad.ts:114` no arg). The handover, the §2 table, and the universalLoad.ts:101 comment all need correcting. Consequence: the B1 leak is Garmin-cut-vs-**personal-TSS**-budget, and the leak only fires for the iTRIMP tier (Garmin/RPE tiers are accidentally self-consistent because RRC is already Garmin there).

3. **Tri fitness model scope.** Census found the tri model is hardwired to population /150 (`tri-benchmarks:907`, `tri-overload:308`), so tri CTL/ATL ≠ running CTL/ATL by ~1.65×. Handover treats personal-vs-pop as **display-only (ISSUE-262)**. **TRISTAN-DECISION: is migrating tri to the personal normalizer in-scope (a real CTL/ATL change, violates "deltas ~zero") or do we accept the cross-mode mismatch and document it?**

4. **Easy-run anchor number.** anchor-55 verifier: generator emits easy→RPE3 = **39 TSS**, but header + session memory cite **55** (RPE4). The "60-min easy ≈ 55 everywhere" anchor the whole plan rests on is a number **no pipeline produces** for a standard easy run. Must pick the convention before writing tests.

5. **main-view load-vs-actual bar — handover claim WRONG.** Handover implies the bar crosses Garmin↔TSS. `main-view.ts:1583` already converts planned Garmin→TSS via the per-RPE ratio (the doc's own proposed B1 fix, already shipped for this bar). The residual issue is actuals use /15000 population vs planned scale-1 — a personal-vs-population mix, not Garmin-vs-TSS.

6. **B2 severity.** Handover hedges "ordering may be mostly preserved." B2 verifier proves ranking **flips** for intra-zone candidates and in `alreadyCompletedMatch`. Also: the iTRIMP tier hard-codes an **85/15 aero/anaero split regardless of intensity** (`universalLoad.ts:117`), so vibeSimilarity's 60%-weighted ratio term is **nearly inert** on the dominant path — load+zone do all the work. `LOAD_SMOOTHING=30` MUST be re-tuned after canonicalisation (deltas shrink ~2×) or the load term dies.

7. **SCIENCE_LOG citation drift.** Handover/ISSUE-262 cite `SCIENCE_LOG:2623` for the deliberate personal-vs-pop split; history verifier says it's actually **`:2682`**. Minor but the doc reference should be corrected.


## G. Freeze-check plan

## Freeze-check plan — prove readiness/ACWR/strain/CTL/ATL deltas ≈ 0

**Principle:** CTL/ATL/ACWR run entirely on the personal-normalizer Signal-B path; ACWR is a ratio (scale cancels). They are freeze-check TARGETS, not change targets. The B1/B3 fixes touch the suggester budget and display sites, which must NOT move CTL/ATL.

**Snapshot harness (before any edit):**
1. Load Tristan's real state (the n=83 device dataset from adaptive-recovery). For each of the 12 most-recent weeks, capture and dump to `/tmp/freeze_before.json`:
   - `computeFitnessModel(...)` → CTL, ATL, Form per week (and per-discipline for tri).
   - `computeRollingLoadRatio(...)` → ACWR + status.
   - `computeReadiness(...)` → readiness score + ring label + every input (recentLegLoads, impactBlocked).
   - `computeTodayStrainTSS` + `getPlannedDayTSSContext` → strain pct, anchor, today/planned TSS.
   - `getNormalizerFromState(s)` (log the actual personal norm — expect ~9100 pre-ltHR-fix, ~16,500 post-fix).
2. **Order matters:** run the freeze-check in TWO phases.
   - **Phase A (ltHR fix only):** CTL/ATL/strain WILL move (+66% → corrected). This is the intended ISSUE-262 model correction — capture the delta and have Tristan confirm it matches the expected +66% inflation removal. Re-baseline `/tmp/freeze_after_ltHR.json`.
   - **Phase B (B1+B3 from the new baseline):** CTL/ATL/ACWR/readiness deltas MUST be ~0 (B1/B3 are suggester+display only). Any non-zero CTL/ATL delta after Phase B = a leak (a display/cache site was feeding the model).
3. **Assertions:**
   - Phase B: `|CTL_after − CTL_before| < 0.5` per week, same for ATL/Form; ACWR identical to 3 dp; readiness score identical.
   - The suggester WILL change (larger or differently-directioned cuts — see contradiction #1): capture `effectiveRRC`, Σ cuts, and #runs-touched for 5 representative activities before/after and present the diff to Tristan rather than asserting zero.
4. **Cache trap:** `wk.actualTSS` (population cache, 6 matcher sites) feeds `events.ts:1078` carry. If the B3 sweep changes whether the cache is written/trusted, week-rollover carriedTSS moves. Snapshot carriedTSS per week explicitly and treat any change as Phase-A (model) not Phase-B (display).
5. **Tri caveat:** if tri stays on population /150 (contradiction #3), tri CTL/ATL are excluded from the Phase-B zero-delta assertion; document why.

Deliverable: a `/tmp` diff table pasted into the session showing Phase-B CTL/ATL/ACWR/readiness deltas at ~0, with every non-zero entry explained.


## H. Verifier verdicts (raw)


### B1-budget-scale
- **Verdict**: PARTIALLY-CONFIRMED. The structural bug is real (budget and cuts are on two different, unreconciled scales — confirmed at two sites, not one), but the doc's claimed *direction* (systematic UNDER-cut) and clean "RRC = TSS-scale, ~1.6× off" framing are REFUTED. RRC is neither TSS-scale nor Garmin-scale: it is `saturate(baseLoad × runSpec × goalFactor)`, a sport-and-tier-dependent quantity. The saturation curve's ~1.875× near-zero amplification (which the doc omits) pushes RRC for the dominant iTRIMP path to ROUGHLY Garmin-scale, so the loop actually tends to OVER-cut relative to the system's own `equivalentEasyKm` — same ~1.6× magnitude, opposite sign.
- **True value**: There is no single multiplier; the budget/cut scale ratio is sport-and-tier-dependent. CUT SIDE (decrements) is firmly Garmin-scale: easy run cut cost = LOAD_PER_MIN_BY_INTENSITY[rpe] × paceMin/km. At rpe3 easy, 6min/km: 1.2/min × 6 = 7.2 load/km, weightedLoad ≈ 7.4/km (aerobic 0.95×7.2 + 1.5×0.05×7.2). At rpe4: 1.5×6 = 9/km. So 90/hr easy (=scale #2). BUDGET SIDE: effectiveRRC = saturate(baseLoad_TSS × runSpec × goalFactor). saturate(x)=1500(1−e^(−x/800)), near-zero slope = 1500/800 = 1.875×. Worked example — 60-min easy CYCLING, iTRIMP tier: normalizeiTrimp gives baseLoad ≈ 55 TSS/h (universalLoad.ts:101 comment + 60min easy), × sportMult 0.75 = 41.3 TSS-scale; rrcRaw = 41.3 × runSpec 0.55 × goalFactor ~1.04 = 23.6; RRC = saturate(23.6) = 1500×(1−e^(−23.6/800)) = 43.6. The loop spends 43.6 cutting easy runs at ~7.4/km → cuts ~5.9 km. But the session's own credited running-equivalent is equivalentEasyKm = RRC/EASY_LOAD_PER_KM = 43.6/12 = 3.6 km. So the loop OVER-cuts by 5.9/3.6 = 1.64× vs the system's own equivalence. Because RRC scales with runSpec (0.10 yoga → 0.65 elliptical), the budget-vs-cut ratio ranges from ~0.3× to ~1.6× across sports — NOT a fixed factor. Within the suggester three different easy-km rates coexist: 7-9/km (cut, scale #2), 12/km (EASY_LOAD_PER_KM, RRC's own), 35/km (deprecated, lines 377/1248), and 5.52/km (fullRrcTSS cap conversion via 0.92×6, scale #1).
- **Evidence**: Budget provenance: suggester.ts:970 runReplacementCredit = loadResult.runReplacementCredit → universalLoad.ts:353 runReplacementCredit = saturateCredit(rrcRaw); :345 rrcRaw = baseLoad × runSpec; :350 ×goalFactor; saturateCredit at :61-63 = CREDIT_MAX(1500)×(1−e^(−x/TAU(800))) [universal-load-constants.ts:83,86]. iTRIMP baseLoad is TSS-scale: universalLoad.ts:114 normalizeiTrimp(iTrimp) → fitness-model.ts:291-293 (iTrimp×100)/normalizer, default 15000 = 1h@LTHR=100 TSS (fitness-model.ts:263). effectiveRRC: suggester.ts:1050-1051 (+recoveryExtra cap "20 TSS × 15 load units per TSS"), :1064 ×capFraction, passed to loop at :1088-1089 and :1097-1098 as loadBudget; buildReduceAdjustments :494 remainingLoad = loadBudget. Cut provenance (Garmin scale): downgrades via computeWorkoutWeightedLoad :470-476 → calculateWorkoutLoad → load.ts:94-97 "Calculate load to match GARMIN scale" using LOAD_PER_MIN_BY_INTENSITY [sports.ts:219, easy=1.5/min]; easy/long km reductions decrement runLoad :457 = weightedLoad(plannedAerobic,plannedAnaerobic) = w.aerobic [suggester.ts:1259] set by generator.ts:297-298 from calculateWorkoutLoad. Decrement sites: :574, :606, :629, :653 (and replace path :717-728). equivalentEasyKm = RRC/12: universalLoad.ts:378-381 with EASY_LOAD_PER_KM=12 [universal-load-constants.ts:228]. SECOND B1 SITE (doc missed): planSuggester.ts:456 remainingCredit = activityLoad.runReplacementCredit, gated/decremented by runLoad (Garmin) at :476, :489, :493 [runLoad from :266 weightedLoad(plannedAerobic…)=w.aerobic]. Modal propagates the same scale conflation: suggestion-modal.ts:161-167 "loadReduction and runReplacementCredit share the suggester's load units" — they don't. maxReductionTSS is genuinely scale #1: main-view.ts:2289 uses TL_PER_MIN; suggester cap fullRrcTSS = equivalentEasyKm×easyPaceMin×0.92 (:1059) converts via scale #1.
- **Implications**: 1) The canonicalisation must treat RRC's scale as runSpec-dependent, not a flat 1.6× rescale — a single boundary factor will be WRONG for every sport except the one it's tuned on (exactly the failure mode CLAUDE.md warns against). The fix must derive RRC's scale from its construction (baseLoad scale × runSpec × saturation Jacobian), or, cleaner, re-express RRC in canonical TSS at the universalLoad boundary (multiply the TSS baseLoad by runSpec only for ranking, keep the budget in TSS) and make calculateWorkoutLoad emit TSS so cuts and budget match. 2) The saturation curve (CREDIT_MAX=1500, TAU=800) is itself in RRC units; rescaling RRC to TSS without rescaling these silently changes saturation behaviour (doc §6 gotcha — confirmed live, the 1.875× slope is load-bearing). 3) There are TWO B1 sites, not one: suggester.ts (buildReduce/Replace) AND planSuggester.ts:456 — the audit/fix must cover both or planSuggester stays broken. 4) The modal km display (suggestion-modal.ts:167) and excess-load-card both inherit the distortion; fixing the loop without fixing these leaves the displayed km wrong. 5) The doc's anchor test "cut of a full session ≤ its own load" will pass/fail differently per sport under the current scales — the consistency test must assert per-tier, per-sport, not a global number. 6) EASY_LOAD_PER_KM=12 disagrees with both the cut rate (7-9) and scale #1 (5.5) — it is a fourth orphan constant inside the same pipeline and should be derived from the canonical scale, not retained.
- **Surprises**: (a) The doc gets the SIGN wrong: it predicts under-cut; the math gives over-cut for the dominant iTRIMP/cycling path, because the saturation curve amplifies small rawRRC by ~1.875× (slope = CREDIT_MAX/TAU). The "absorbs 4.7 of 15.7 km" dogfic symptom is therefore NOT explained by this mechanism alone — it is more likely driven by the capFraction path (maxReductionTSS/fullRrcTSS) and the MAX_ADJUSTMENTS / minLoadThreshold / floorKm guards capping how many runs get touched, not by the budget being too small. Worth a separate trace before attributing the symptom to B1. (b) SECOND undocumented B1 instance in planSuggester.ts:456-493 with identical cross-scale comparison and an additional REPLACE_THRESHOLD(0.95)×runLoad gate — replacement is gated on a Garmin-scale runLoad vs an RRC-scale credit, so whether a run is replaceable also crosses scales. (c) FOUR distinct easy-load-per-km constants live inside the single suggester+universalLoad pipeline: 7-9 (cut), 12 (EASY_LOAD_PER_KM), 35 (deprecated, still live at suggester.ts:1248 for the km-from-load fallback), 5.52 (fullRrcTSS cap). The deprecated 35 still executes when a workout has load but no parseable distance. (d) The recovery-extra cap comment "20 TSS × 15 (load units per TSS approx)" (suggester.ts:1051) is a fifth, hardcoded, never-derived conversion claiming 15 load/TSS — inconsistent with all four above and with the Garmin ~9/km≈1.6×TSS implied elsewhere.


### B2-similarity-scale
- **Verdict**: CONFIRMED — both halves hold. The two vibeSimilarity inputs are on genuinely different scales, and the mismatch can and does flip candidate ranking for realistic inputs. The handover's hedge ("ordering MAY be mostly preserved") is too generous: ordering is only preserved when the downstream zone-match bonus distinguishes the candidates; it flips whenever two candidates share an intensity zone, and the alreadyCompletedMatch fallback has no bonus at all.
- **True value**: Scale gap (60-min easy hour, dominant iTRIMP tier): activity-side aerobic ≈ normalizeiTrimp(iTrimp)=~55 TSS × sportMult × 0.85. For cycling (mult 0.75) that is 55×0.75×0.85 ≈ 35; planned-run easy aerobic via calculateWorkoutLoad ≈ 60min × 1.5 (LOAD_PER_MIN_BY_INTENSITY[4]) × 0.95 ≈ 81. Activity weightedLoad is ~2.0–2.4× SMALLER than the equivalent planned-run weightedLoad. weightedLoad w=aerobic+1.5×anaerobic, so the loadScore=1/(1+|w1−w2|/30) term sees w1 systematically undersized → biases toward the smallest-load (shortest) candidate.

Counter-example (intra-zone, NOT rescuable by zone bonus): activity = 90-min easy hike, iTRIMP tier, tssEquiv 82 × hiking mult 0.80 → base 65.6, 85/15 split → a=55.8 an=9.8, w1=70.5. Candidates both EASY: SHORT (30min, w=46.0) vs LONG (75min, w=116.0). MISMATCHED scale: sim(short)=0.757 > sim(long)=0.701 → picks SHORT (wrong). SAME scale (activity rescored on Garmin scale, 90min easy → a=128 an=7, w=138.5): sim(short)=0.694 < sim(long)=0.828 → picks LONG (correct, the true closest load). Both candidates are 'easy' zone so ZONE_MATCH_BONUS=0.20 adds identically to each and cannot break the tie — the scale-distorted load term is the sole differentiator and it picks the wrong run.

Mixed-zone example (rescuable): moderate-hard activity (a=63.8 an=11.2 w=80.6) vs threshold-run-A (w=161) and easy-run-B (w=46). Pure vibeSimilarity: A=0.618 < B=0.723 → picks easy B (wrong). With correct classifier 'threshold' (+0.20 to A): A=0.818 > B=0.723 → picks A (rescued). With classifier defaulting to 'easy' (RPE-only/profile fallback): +0.20 goes to B instead → B=0.923 wins (wrong). So the rescue depends entirely on the classifier firing correctly.
- **Evidence**: (a) Different scales: suggester.ts:1005 passes aerobic/anaerobic = loadResult.aerobicLoad/anaerobicLoad from computeUniversalLoad (suggester.ts:967-968). For the dominant iTRIMP tier, universalLoad.ts:114-121 computeTierAPlus = normalizeiTrimp(iTrimp) × sportMult, 85/15 split; normalizeiTrimp (fitness-model.ts:291-292) = iTrimp×100/normalizer (TSS-equivalent, ~55 for easy hour). Planned-run side: vibeSimilarity at suggester.ts:431 reads run.plannedAerobic/plannedAnaerobic = w.aerobic/w.anaerobic (workoutsToPlannedRuns, suggester.ts:1259-1260), assigned by calculateWorkoutLoad (generator.ts:297-298) which uses LOAD_PER_MIN_BY_INTENSITY (load.ts:96, comment line 94 "Calculate load to match GARMIN scale"; sports.ts:219-230). So activity=universalLoad/TSS-ish scale, planned=Garmin scale. Confirmed. (Note: Tier-A Garmin path, universalLoad.ts:140-144, returns raw garminAerobic/garminAnaerobic — also Garmin-magnitude but not run through the per-minute table, a third mismatch flavor; the iTRIMP path is the standard Strava/Garmin case.)
(b) vibeSimilarity formula suggester.ts:309-318: ratioScore scale-free, loadScore=1/(1+|w1−w2|/LOAD_SMOOTHING), LOAD_SMOOTHING=30 (suggester.ts:179), weightedLoad=a+1.5×an (suggester.ts:229-231). Ranking sites: buildCandidates:431 (zone bonus added after, :447-455, ZONE_MATCH_BONUS=0.20 :184, ZONE_MISMATCH_PENALTY=0.10 :185); alreadyCompletedMatch:1037-1038 (NO zone bonus — pure scale-dependent ranking). Classifier 'easy' default that disarms the rescue: universalLoad.ts:592-595 (profile fallback returns type 'easy'). Constants: LOAD_PER_MIN_BY_INTENSITY sports.ts:219-230, LOAD_PROFILES workouts.ts:124-137, SPORTS_DB mult/runSpec sports.ts:40-60.
- **Implications**: B2 is real and slightly worse than the doc states. (1) Canonicalising both inputs onto TSS (scale #1) directly fixes the load-term distortion — after conversion at the suggester boundary, w1 and w2 share magnitude and loadScore becomes meaningful. (2) LOAD_SMOOTHING=30 is currently tuned against Garmin-scale w-deltas (which run 40–250+); once both sides are TSS-scale the deltas shrink ~1.6–2× and the loadScore curve will be far too flat (everything near 1.0) — LOAD_SMOOTHING must be re-tuned in the same pass, not just left at 30. The handover's step-4 note "re-check B2's similarity weighting after" must include rescaling LOAD_SMOOTHING, or the load term effectively dies. (3) The zone-match bonus is currently doing the real ranking work and masking the bug in the common (Garmin/Strava, classifier-fires) path — which is why dogfooding hasn't screamed about mis-matches. Do not remove or weaken the zone bonus when fixing the scale, or latent flips will surface. (4) alreadyCompletedMatch:1037-1038 needs the same canonical inputs (it has no zone-bonus safety net), though its blast radius is just a display label.
- **Surprises**: 1. The iTRIMP tier hard-codes an 85/15 aerobic/anaerobic split (universalLoad.ts:117-121) REGARDLESS of activity intensity — so for any HR-stream activity the ratioScore term in vibeSimilarity is pinned to anaRatio≈0.15 and cannot distinguish a hard interval session from an easy spin. This means for the most common (iTRIMP) path, vibeSimilarity's 60%-weighted ratio term is nearly inert across candidates, leaving the (scale-broken) 40% load term and the zone bonus to do all the discrimination. The doc's framing of ratio vs load weighting (RATIO_WEIGHT=0.60) overstates how much real signal the ratio term carries on the dominant path.
2. There are TWO deprecated parallel implementations still in the file (resolveActivityLoad :251 with its own LOAD_PER_MIN table :200-211, and computeEquivalentEasyKm :374 hard-coding easyLoadPerKm=35) — they aren't called by buildCrossTrainingPopup but the '1km easy ≈ 35 load' constant ALSO appears live at workoutsToPlannedRuns:1248 (km = w.aerobic/35) as a fallback distance estimate, so that orphan constant is not fully dead. That fallback divides a Garmin-scale aerobic by 35, which is internally consistent with the Garmin scale, but it is a 4th encoding of "load per easy km" to reconcile.
3. classifyWorkoutType returns runningEquivTSS = tss × runSpec (universalLoad.ts:598) which is logged (suggester.ts:1002) but never actually used to rank or budget — it's computed and discarded, a latent unused TSS-scale signal that could have been the canonical matching currency.


### tier-consistency
- **Verdict**: REFUTED — the four tiers of universalLoad.ts emit on DIFFERENT scales; an athlete's identical session gets ~3× different credit depending only on which data tier ingested it. This is a fifth scale bug, distinct from the four in the handover.
- **True value**: Reference activity = 60-min easy, RPE 4, ~75% maxHR. Comparing baseLoad (aerobic+anaerobic, the tier emission) and the live RRC the suggester budgets against.

RUNNING (mult 1.0, runSpec 1.0) — pure scale check, sport factors neutral:
- Tier A+ (iTRIMP): baseLoad = normalizeiTrimp(iTRIMP)×mult = 55×1.0 = 55  (universalLoad.ts:114-115; anchor "55 TSS easy 60min" :496/sports.ts:6) → TSS-SCALE
- Tier C (RPE):     baseLoad = 60×LOAD_PER_MIN_BY_RPE[4](1.6)×AF(extra_run 1.0)×0.80 = 76.8  (universalLoad.ts:214-225, constants:143) → GARMIN-SCALE
  Same easy hour: 55 vs 76.8 = 1.40× divergence with sport factors removed.

CYCLING (mult 0.75, runSpec 0.55, AF 0.95) — a sport that realistically arrives via all four tiers:
- Tier A+ (iTRIMP): 55×0.75 = 41.25
- Tier A (Garmin):  garminAerobic+garminAnaerobic used RAW, no mult, no normalize (universalLoad.ts:140-144). 60-min easy on Garmin's own scale ≈ 90 (scale #2 anchor, sports.ts:219). baseLoad ≈ 90
- Tier B (HR-only): raw minutes×[1..5], no mult, no normalize (universalLoad.ts:170-179). 50min Z2+10min Z3 = 50×2+10×3 = 130. baseLoad ≈ 120–130
- Tier C (RPE):     60×1.6×0.75×0.95×0.80 = 54.7
  baseLoad spread: 41 / 90 / 130 / 55 → max/min = 130/41 = 3.17×.

Live RRC (= effectiveRRC budget, suggester.ts:970) for cycling, half goal: rrcRaw = baseLoad×0.55×~1.05, saturate=1500×(1−e^(−rrcRaw/800)):
- A+:  rrcRaw 23.8 → RRC 44.0
- A:   rrcRaw 51.98 → RRC 94.4
- B:   rrcRaw 75.1 → RRC 134.4
- C:   rrcRaw 39.5 → RRC 72.3
  RRC spread = 134.4/44.0 = 3.05×. Saturation does NOT mask it (rrcRaw ≪ TAU=800, curve near-linear here).

Root causes of the divergence:
1. LOAD_PER_MIN_BY_RPE (Tier C, constants:139-150, comment "aligned with Garmin scale") is numerically near-identical to LOAD_PER_MIN_BY_INTENSITY (scale #2 Garmin ~90/hr, sports.ts:219-230) and ~1.4× above TL_PER_MIN (scale #1 TSS ~55/hr, sports.ts:11-22). RPE4: 1.6 vs Garmin 1.5 vs TSS 0.92. So Tier C emits Garmin-scale, not TSS.
2. Tier A passes Garmin training-load through untouched — Garmin-scale by construction.
3. Tier B emits raw zone-weighted minutes (weights 1-5) with NO normalization to any anchor and NO sport mult — its own ad-hoc TRIMP scale, the largest and most arbitrary.
4. Only Tier A+ applies normalizeiTrimp → genuine TSS. It is the ONLY TSS-calibrated tier, and it is the one the handover verified.
5. Asymmetry compounds it: sportMult is applied in A+ and C but NOT in A or B (universalLoad.ts:115,218 vs 140-144,173-179), so cycling's 0.75 discount silently applies to two tiers and not the other two.
- **Evidence**: universalLoad.ts:114-115 (A+ normalizeiTrimp×mult, TSS); :140-144 (A raw Garmin, no mult/no normalize); :170-197 (B raw min×[1..5], no normalize); :214-230 (C RPE×lpm×mult×AF×0.80); :332 (baseLoad=aer+anaer, no rescale); :345-353 (rrcRaw=baseLoad×runSpec×goalFactor → saturateCredit). universal-load-constants.ts:139-150 (LOAD_PER_MIN_BY_RPE, RPE4=1.6, "aligned with Garmin scale"); :83-86 (TAU=800,CREDIT_MAX=1500); :228 (EASY_LOAD_PER_KM=12). constants/sports.ts:11-22 (TL_PER_MIN scale#1, RPE4=0.92, TSS-verified header); :219-230 (LOAD_PER_MIN_BY_INTENSITY scale#2, RPE4=1.5, "Garmin-calibrated"). fitness-model.ts:291-293 (normalizeiTrimp = itrimp×100/normalizer), :267-274 (computeAthleteNormalizer). suggester.ts:967-971 (RRC/equivalentEasyKm flow straight from loadResult into budget). universalLoad.test.ts:855-873 — the suite ITSELF only asserts Tier A+ vs Tier C agree "within a factor of 2" (assert 0.3–3.0×), explicitly tolerating the divergence and never testing Tier B or Tier A against the others.
- **Implications**: The handover §2 row 3 says "iTRIMP tier ≈ TSS; other tiers NOT verified — audit them." Verdict: the other three tiers are NOT TSS, and are NOT even mutually consistent. This is a genuine FIFTH scale problem living INSIDE the one pipeline the doc treated as a single scale (#3). The plan's step-4 boundary conversion ("convert at the suggester boundary") is necessary but INSUFFICIENT: a single suggester-side factor cannot fix it because the input itself is tier-dependent (44–134 for one session). The fix must move INTO computeUniversalLoad: every tier must emit canonical TSS before baseLoad is formed — (a) Tier C: swap LOAD_PER_MIN_BY_RPE for TL_PER_MIN (scale #1) or apply the per-RPE Garmin→TSS ratio; (b) Tier A: divide incoming Garmin load by the Garmin→TSS factor (≈1.6, derive per-RPE from the two tables per the doc's own "don't invent one factor" rule); (c) Tier B: replace raw min×[1..5] with a TSS-anchored zone TRIMP (the classifyWorkoutType path already uses 0.55/0.85/1.1 TSS-IF intensity factors at :588 — reuse those, they ARE TSS-scaled); (d) decide sportMult symmetry (apply to all four or none). Anchor test must be extended: "60-min easy ≈ 55 in EVERY tier" (currently only A+ passes; the existing :855 test must be tightened from 3× to ~1.15×). Also flags ISSUE-262: Tier A+ uses the population /15000 path via normalizeiTrimp's default _athleteNorm unless setAthleteNormalizer ran — same personal-vs-population split lives here too.
- **Surprises**: 1. The test suite documents the bug as acceptable: universalLoad.test.ts:855-873 asserts A+ vs C only within 0.3–3× and comments "Different methodologies WILL differ" — institutionalising a 3× scale gap as expected behaviour. No test compares Tier B or Tier A numerically against the others at all.
2. Tier B is the worst offender and entirely unflagged anywhere: raw zone-minutes×[1..5] is not calibrated to ANY anchor (TSS, Garmin, or otherwise) and skips sportMult — a 60-min easy ride reads ~120-130 "load units", ~2.3× the TSS truth and ~1.4× even the Garmin number.
3. sportMult application is asymmetric across tiers (A+/C apply it, A/B don't) — universalLoad.ts:115,218 vs 140-144,173-197. So the SAME cycling session's 0.75 discount appears or vanishes purely by data tier, compounding the scale divergence with a second tier-dependent factor. The handover's §2 never noted this asymmetry.
4. The orphan constant at suggester.ts:1051 ("20 TSS × 15 load units per TSS") implies 15 load/TSS, which matches NONE of the four tier scales here (A+ ≈1, C/A ≈1.6, B ≈2.3 vs TSS) — a sixth disagreeing constant, consistent with the handover's warning about point-fix proliferation.


### overshoot-boundary
- **Verdict**: PARTIALLY-CONFIRMED — overshootTSS is genuinely scale #1 (TSS), but the doc mislocates the cross-scale boundary: the maxReductionTSS comparison at suggester.ts:1057-1064 is internally TSS÷TSS (clean); the real cross-scale leak is upstream/downstream of it (effectiveRRC scale vs Garmin-scale cuts, plus an EASY_LOAD_PER_KM=12 fudge in fullRrcTSS).
- **True value**: overshootTSS scale = scale #1 (TSS, ~55/hr easy). Both endpoints proven: projectedTotal = currentTSS [computeWeekRawTSS, fitness-model.ts:492 uses TL_PER_MIN + :489 normalizeiTrimp] + carried [computeDecayedCarry] + remainingRunTSS [main-view.ts:2289 durMin × TL_PER_MIN[rpe], TL_PER_MIN[4]=0.92 → 60min easy=55.2]; minus plannedB [computePlannedSignalB]. overshootTSS = projectedTotal − plannedB = TSS − TSS. CLEAN.

What the suggester does with maxReductionTSS (suggester.ts:1057-1064): it is NEVER subtracted from a load-scale number. It is only a numerator in a ratio: capFraction = min(1, maxReductionTSS / fullRrcTSS), where fullRrcTSS = equivalentEasyKm × easyPaceMin × 0.92 (line 1059). The ×0.92 is TL_PER_MIN[4] (scale #1), so fullRrcTSS is built in TSS and capFraction is dimensionless TSS÷TSS. effectiveRRC = effectiveRRC × capFraction (1064) — fraction scales the load-scale budget. So at THIS line the doc's 'cross-scale boundary' framing is imprecise: the boundary is scale-consistent.

The REAL distortions, two of them:
(1) fullRrcTSS is wrong by construction. equivalentEasyKm = runReplacementCredit / EASY_LOAD_PER_KM, EASY_LOAD_PER_KM=12 (universal-load-constants.ts:228). True easy TSS/km at 6:00/km = 6×0.92 = 5.52, so 12 is ~2.2× the real TSS/km — a Garmin-ish constant. With easyPaceMin=6: fullRrcTSS = (RRC/12)×6×0.92 = 0.46×RRC. But the budget loop actually spends RRC in Garmin units worth ~0.77 TSS each (see below), so it really cuts ≈0.77×RRC TSS. fullRrcTSS UNDER-states the budget's true TSS reach by ~0.46/0.77 ≈ 0.6×. Therefore capFraction = overshootTSS/fullRrcTSS is INFLATED ~1.67×, so for a given overshoot the suggester keeps MORE budget than needed (capFraction saturates to 1 too easily) → it tends to NOT dampen, i.e. over-cuts in the capped path — opposite direction to the headline 'under-cut'.
(2) The genuine B1 cross-scale leak is in the budget loop, tier-dependent: effectiveRRC (runReplacementCredit) is on universalLoad scale #3, which is TSS for the iTRIMP tier (computeTierAPlus, universalLoad.ts:114-115: iTrimp×100/15000×sportMult) but Garmin-scale for Tier A/B/C. The loop decrements remainingLoad by computeWorkoutWeightedLoad → calculateWorkoutLoad ('Calculate load to match GARMIN scale', load.ts:94), i.e. LOAD_PER_MIN_BY_INTENSITY (sports.ts:219, RPE4=1.5). For a non-iTRIMP session RRC and cuts are BOTH Garmin (Tier C uses LOAD_PER_MIN_BY_RPE RPE4=1.6 ≈ matches) → self-consistent, NO bug. For an iTRIMP session RRC is TSS but each cut is Garmin (~1.6× a TSS unit, since LOAD_PER_MIN_BY_INTENSITY[4]=1.5 vs TL_PER_MIN[4]=0.92, ratio 1.63) → each cut over-spends the TSS budget ~1.6× → budget exhausts after ~60% of the cuts → systematic UNDER-cut. This matches the doc's 'absorbs 4.7 of 15.7 km' and bites the highest-confidence tier (Garmin/Strava HR streams = Tristan's common case).

Net per-RPE scale-2÷scale-1 ratios (the conversion law to derive at the boundary, do NOT collapse to one factor): RPE3 1.2/0.65=1.85; RPE4 1.5/0.92=1.63; RPE5 2.0/1.15=1.74; RPE7 3.5/1.78=1.97; RPE8 4.5/2.22=2.03.
- **Evidence**: main-view.ts:2271 overshootTSS declared; :2284-2290 remainingRunTSS via durMin × TL_PER_MIN[rpe] (scale #1); :2296 overshootTSS = projectedTotal − plannedB; :2312 buildCrossTrainingPopup(...,overshootTSS,maxAdjustments) — the ONLY call passing the 6th arg (grep confirms excess-load-card.ts:380 passes 'excess' as the 5th/recoveryMultiplier slot, a different boundary). fitness-model.ts:489,492 computeWeekRawTSS TSS-scale. suggester.ts:933 maxReductionTSS param; :1057-1064 capFraction = min(1, maxReductionTSS/fullRrcTSS), fullRrcTSS = equivalentEasyKm × easyPaceMin × 0.92, effectiveRRC ×= capFraction. universalLoad.ts:378-380 equivalentEasyKm = RRC/EASY_LOAD_PER_KM; :114-115 iTRIMP tier TSS-scale baseLoad; :140-144 Tier A passes raw Garmin through; :345-353 RRC = saturateCredit(baseLoad × runSpec × goalFactor). universal-load-constants.ts:228 EASY_LOAD_PER_KM=12; :139 LOAD_PER_MIN_BY_RPE (Tier C, RPE4=1.6). suggester.ts:470-476 computeWorkoutWeightedLoad → calculateWorkoutLoad; load.ts:94-97 'GARMIN scale' baseRate = LOAD_PER_MIN_BY_INTENSITY; suggester.ts:494 remainingLoad=loadBudget(effectiveRRC), :574/:606/:629/:653/:697 remainingLoad -= scale-#2 loadReduction. sports.ts:11 TL_PER_MIN[4]=0.92; :219-223 LOAD_PER_MIN_BY_INTENSITY[4]=1.5.
- **Implications**: 1) Don't 'fix' suggester.ts:1057-1064 as a cross-scale boundary — it is scale-consistent in isolation. The fix is to make effectiveRRC and the cut loop share the canonical TSS scale, AFTER which fullRrcTSS should be computed as the true TSS the budget cuts (derive equivalentEasyKm's TSS from TL_PER_MIN, not the EASY_LOAD_PER_KM=12 fudge), or fullRrcTSS becomes redundant.
2) Canonicalising on TSS converts the cut loop (computeWorkoutWeightedLoad/calculateWorkoutLoad) from Garmin (scale #2) to TSS — use the per-RPE ratio table above, NOT a single factor (the ratio ranges 1.63–2.03 across RPE). This is the one boundary that matters; the maxReductionTSS path then self-heals.
3) Tier-dependence is the trap: today the B1 leak only fires for iTRIMP sessions (RRC TSS vs cuts Garmin); Garmin/HR/RPE tiers are accidentally self-consistent because RRC is already Garmin there. After canonicalisation make ALL tiers emit TSS (normalize Tier A garmin loads ÷~1.63, Tier B/C swap LOAD_PER_MIN_BY_RPE→TL_PER_MIN) or the leak inverts onto the non-iTRIMP tiers. Add equivalentEasyKm / EASY_LOAD_PER_KM to the §2 scale-map audit.
4) User-visible surface of THIS boundary is narrow: only the launch-time ACWR-reduction auto-popup (wk.unspentLoadItems flow, main-view.ts ~2270). It distorts how aggressively that popup trims the week back to the SignalB target — for iTRIMP-sourced excess it under-trims (stops cutting ~40% short, the '4.7 of 15.7 km'); the fullRrcTSS=0.46×RRC error separately makes capFraction saturate to 1 so the small-overshoot damping (light/heavy severity downgrade at capFraction≤0.35/≤0.65) rarely engages, meaning small overshoots still propose multi-workout changes when the doc's intent was a single trim. Both are display/aggressiveness-of-cut effects, not CTL/ATL — freeze-check safe.
- **Surprises**: 1) The EASY_LOAD_PER_KM=12 constant (universal-load-constants.ts:228) is an unflagged 4th orphan conversion the §2 doc table missed — it is ~2.2× the true easy TSS/km and sits directly in fullRrcTSS, so it independently corrupts capFraction even before the RRC/cut scale leak. The §2 'orphan constants' list (:1045, :1053, :1246) should add this.
2) The maxReductionTSS damping logic (suggester.ts:1066-1070) keys severity downgrades off capFraction thresholds (0.35/0.65) that were tuned against the WRONG fullRrcTSS (0.46×RRC). Rescaling fullRrcTSS will silently change which overshoots get the single-adjustment vs multi-adjustment treatment — a §6 'saturation constants' style gotcha not currently called out for these two thresholds.
3) budgetWasCapped (suggester.ts:1094) suppresses ALL replacement options whenever maxReductionTSS triggered a severity downgrade. Because the capFraction is inflated (~1.67×) by the EASY_LOAD_PER_KM error, capFraction<1 fires LESS often than intended, so replacements are suppressed LESS often than the design intended — another behavioural drift riding on the same broken constant.
4) The 20*15 orphan at suggester.ts:1051 ('20 TSS × 15 load units per TSS') asserts 15 load/TSS, while EASY_LOAD_PER_KM=12 and the per-RPE Garmin/TSS ratio is ~1.6 — three different implicit load/TSS factors (15, 12-per-km, 1.6-per-min) coexist within ~600 lines of the same file.


### anchor-55
- **Verdict**: PARTIALLY-CONFIRMED — the TL_PER_MIN table is genuinely TSS-calibrated as a per-RPE intensity curve and the header arithmetic is correct, BUT the header's stated "verification" rows do not match the RPEs the plan actually assigns, one of the four verification lines invokes a ×1.2 long-multiplier that exists nowhere in any TSS production path, and a second scale-#1 consumer (TL_BY_TYPE in events.ts) disagrees with TL_PER_MIN on the most common session type by 1.42×. So "canonicalise on TSS via TL_PER_MIN" is sound in principle but inherits a real per-RPE-vs-per-type inconsistency that must be reconciled.
- **True value**: Header arithmetic (all correct as written): Easy 60min RPE4 = 60×0.92 = 55.2; Threshold 45min RPE7 = 45×1.78 = 80.1; VO2 45min RPE8 = 45×2.22 = 99.9; Long 2h RPE4×1.2 = 120×0.92×1.2 = 132.5. ✓ arithmetic.

Implied IF per RPE (IF = sqrt(60minTSS/100), TSS theory IF²×100): RPE3→0.62, RPE4→0.74, RPE5→0.83, RPE6→0.93, RPE7→1.03, RPE8→1.15, RPE10→1.34. Easy@RPE4 IF 0.74 is textbook-easy ✓. Threshold@RPE7 → 60min = 106.8 TSS → IF 1.03 (slightly above LT, defensible for a true LT session; the header's 45-min/80-TSS framing is fine). VO2@RPE8 → 60min = 133 TSS → IF 1.15 (supra-threshold, physiologically reasonable for VO2 intervals). All rows the comment checks are individually well-calibrated. So the per-RPE CURVE is sound.

THE REFUTATIONS:
1. Wrong RPE for the dominant session. The canonical plan builder intent_to_workout.ts assigns easy → rpe 3 (sports.ts TL_PER_MIN[3]=0.65) and long → rpe 3, NOT rpe 4. Real planned easy 60min = 60×0.65 = 39 TSS, not 55. Real planned long 2h = 120×0.65 = 78 TSS. The header "verifies" a 55 the pipeline never produces for a standard easy run.
2. Phantom ×1.2 long multiplier. The 4th verification line multiplies by a "long multiplier" of 1.2. grep of fitness-model.ts and planned-day-tss.ts finds NO such multiplier in computeWeekRawTSS / computePlannedSignalB / computePlannedDaySignalBTSS. The real long-run TSS path is plain durMin × TL_PER_MIN[rpe]. So 132 is unreachable; a planned 2h long is 78 (rpe3) — a 1.7× overstatement.
3. Intra-scale-#1 contradiction. events.ts:1079 TL_BY_TYPE maps easy→0.92 and long→0.92 (the RPE-4 rate), while every other scale-#1 site (computeWeekRawTSS:492/515, computePlannedDaySignalBTSS:774, planned-day-tss.ts:103) rates the SAME easy/long run at 0.65 via TL_PER_MIN[3]. Gap = 0.92/0.65 = 1.42×. Two scale-#1 consumers disagree by 42% on the most frequent workout.
4. Unrated-actual fallback uses RPE 5 (1.15/min = 69 TSS/hr), not RPE 4 (computeWeekRawTSS:487,538; computePlannedDaySignalBTSS:772) — a third easy-run anchor (69) distinct from both 55 and 39.
- **Evidence**: src/constants/sports.ts:3-22 (TL_PER_MIN table + header comment with the 4 verification lines); TL_PER_MIN[3]=0.65, [4]=0.92, [5]=1.15, [7]=1.78, [8]=2.22.
src/workouts/intent_to_workout.ts:54-56 (easy → rpe:3), :78-79 (long → rpe:3), :93-94/:104-105 (threshold → rpe:7 ✓), :119/:130 (vo2 → rpe:8 ✓), :141-142 (marathon_pace → rpe:6); called canonically at src/workouts/generator.ts:97.
src/calculations/fitness-model.ts:492 + :515 + :538 (computeWeekRawTSS uses TL_PER_MIN[rated rpe], unrated fallback RPE5/1.15), :772-774 (computePlannedDaySignalBTSS reads w.rpe → 3 for easy → 39 TSS).
src/ui/planned-day-tss.ts:103 (tri/HYROX fallback durMin × TL_PER_MIN[rpe]).
src/ui/events.ts:1079 (TL_BY_TYPE easy:0.92, long:0.92 — the conflicting scale-#1 rate) consumed at :1097.
No-×1.2 proof: grep of "long.*1.2" / "1.2.*long" across fitness-model.ts and planned-day-tss.ts returns only the ACWR comment (fitness-model.ts:1045) and a ctlSeed comment (:1410); no long-run multiplier in any TSS path.
- **Implications**: 1. Do NOT trust the sports.ts:3-9 header as the calibration spec — fix the comment to the RPEs the plan actually emits (easy/long = RPE 3 = 0.65/min = 39 TSS for 60min easy, NOT 55). The "60-min easy ≈ 55" anchor the plan and the session memory keep citing is the RPE-4 number; the live easy run is ~39. The consistency tests in step 6 must anchor on the RPE actually assigned, or they will codify a value (55) no pipeline produces. Decide deliberately: either (a) keep RPE3=39 as the true easy anchor, or (b) re-rate easy to RPE4 — but pick one and make the test match the generator.
2. TL_BY_TYPE (events.ts:1079) is a fourth hardcoded mini-table inside scale #1 that disagrees with TL_PER_MIN by 1.42× on easy/long. The week-rollover carriedTSS (a documented scale-#1 consumer) therefore over-values easy/long carry by 42% relative to computeWeekRawTSS. This is itself a cross-scale bug WITHIN scale #1 and belongs in the canonicalisation sweep — replace TL_BY_TYPE lookups with TL_PER_MIN[canonical-rpe-for-type] so carry and raw-TSS agree.
3. The phantom ×1.2 long multiplier in the header means anyone reasoning about long-run TSS from the comment will overstate it by 1.7×. If a long-run amplification is actually wanted (defensible — long runs accrue durability load beyond IF²×t), it must be ADDED to the real pipeline, not left only in a comment. Currently long runs are valued purely linearly.
4. Net: scale #1 is the right canonical CHOICE, but it has at least three different easy-run anchors live in the codebase (39 via RPE3 generator, 55 via header/RPE4, 69 via RPE5 unrated fallback, 0.92→55 via TL_BY_TYPE). The "60-min easy ≈ 55 everywhere" anchor test from the plan will FAIL today against the real generator output of 39. Reconcile the easy-run RPE convention BEFORE writing the anchor tests, else the canonicalisation freezes in the wrong number.
- **Surprises**: events.ts:1079 TL_BY_TYPE is a previously-uncatalogued FIFTH scale-#1 lookup table (hardcoded per-type rates) that the handover §2 lists only as "TL_BY_TYPE" without noting it disagrees with TL_PER_MIN on easy/long. It also rates intervals→2.22, hill_repeats→2.0, progressive→1.45 — none of which are cross-checked against the per-RPE table and at least one (hill_repeats 2.0) corresponds to no exact TL_PER_MIN entry. The ZONE_PROFILES table beside it (events.ts:1080-1090) is a separate base/threshold/intensity split used only for carry-zone bucketing, not load magnitude — not a scale, but worth noting it co-exists. Also: PASSIVE_TSS_PER_ACTIVE_MIN = TL_PER_MIN[2] = 0.45 (fitness-model.ts:39) quietly pins passive-minute load to the RPE-2 rate, another implicit RPE-as-anchor coupling that a TL_PER_MIN rescale would silently move.


## I. Census agent summaries (raw)


### producers
The handover doc's 4-scale model is correct but incomplete: I found at least 6 distinct numeric scales, not 4. (1) TL_PER_MIN (sports.ts:11) is genuinely TSS-calibrated, ~55/hr easy, and is the de-facto canonical scale for running CTL/ATL/Signal-B/strain/carry. (2) LOAD_PER_MIN_BY_INTENSITY (sports.ts:219, ~90/hr easy, "Garmin scale") drives calculateWorkoutLoad (load.ts), createActivity's estimate path, and Tier-C/RPE in universalLoad — and it is what stamps running-mode w.aerobic/w.anaerobic. (3) universalLoad pipeline: its iTRIMP tier IS TSS (normalizeiTrimp), but Tier-A passes raw Garmin Firstbeat aerobic_load straight through (Garmin native scale), Tier-B uses zone-minute weights [1,2,3,4,5] (a TRIMP-ish 4th micro-scale), Tier-C uses LOAD_PER_MIN_BY_RPE (~Garmin). So RRC/FCL are NOT a single scale — they are whatever the input tier was, which is exactly why crossing RRC against the TSS budget under-cuts. (4) iTRIMP→TSS has TWO live normalizers: personal getNormalizerFromState/module _athleteNorm (~9100 for Tristan) used by CTL/ATL/Strain ring, vs hardcoded /15000 (= /150) used at ~30 display sites AND, critically, hardwired into the entire triathlon fitness model (tri-benchmarks iTrimp/150, tri-overload iTrimp/150). The doc frames personal-vs-population as a display bug (ISSUE-262) but MISSES that tri CTL/ATL run population while running CTL/ATL run personal — a cross-MODE fitness-model mismatch of ~1.65×. (5) A 5th collision the doc doesn't flag: synced Garmin cross-training adhocs stamp w.aerobic = aerobicEffect, the Garmin Training Effect 0–5 scale (state.ts:340), onto the same w.aerobic field that tri reads as TSS and running fills with Garmin-load — three incompatible meanings on one field. (6) HYROX uses musculoTendonLoad, a separate musculoskeletal currency that correctly stays out of the TSS pipeline (planned-day-tss synthesizes TSS for HYROX via duration×TL_PER_MIN). Plus a 4th TSS-scale RPE table in timing-check.ts (TSS_PER_MIN, RPE4=0.8 vs TL_PER_MIN 0.92) and an inline TL_BY_TYPE in events.ts. B1 is confirmed and worse than documented: main-view feeds overshootTSS (scale #1) as maxReductionTSS, the suggester reconstructs fullRrcTSS in TSS (line 1059) but then decrements effectiveRRC (universalLoad/RRC scale) by loadReduction from computeWorkoutWeightedLoad (Garmin scale #2) — and excess-load-card encodes the synthetic excess at iTrimp=excess×150 (population) which universalLoad then decodes at the personal norm (~9100), a ~1.65× round-trip inflation. planSuggester.ts replicates the same cross-scale budget loop independently. Contrast: the tri overload card (tri-cross-training-overload.ts) is internally TSS-consistent (both planned w.aerobic+w.anaerobic and actuals iTrimp/150 are ~TSS), so the under-cut pathology is a running-suggester-specific problem. The doc's claim that main-view.ts:2283-2290 overshoot is scale #1 is correct; its claim that the load-vs-actual bar crosses scales is WRONG — main-view:1583 explicitly converts Garmin→TSS via the per-RPE TL/LOAD ratio (it is the doc's own proposed B1 fix, already implemented for that bar only).


### consumers
The app carries load on five distinct numeric scales, not four. The handover's four (TSS-calibrated TL_PER_MIN ~55/hr; Garmin LOAD_PER_MIN_BY_INTENSITY ~90/hr; universalLoad pipeline units; iTRIMP-to-TSS personal-vs-population normalizers) are all confirmed. A fifth, undocumented scale is the triathlon/cycling/swim plan-engine's per-workout aerobic+anaerobic stamping (run easy ~60/hr via aerobic=min×0.95+anaerobic=min×0.05; bike endurance 0.85 TSS/min; swim endurance 1.0 TSS/min — all self-described "rough TSS-per-minute", roughly TSS-scale but anchored to ~60/hr not the canonical 55), consumed directly as TSS by planned-day-tss.ts and capacity-strain.

The single most important correction to the handover: it claims universalLoad uses the hardcoded /15000 population normalizer, but it does NOT. computeTierAPlus and classifyByITrimp call normalizeiTrimp(iTrimp) with NO second argument, so they use the module-level _athleteNorm (personal, ~9100 for Tristan, set in main.ts:435). Same for computeWeekTSS:383/489 and computeWeekRawTSS:489. So the canonical internal-TSS pipeline (Strain ring, Signal B, carriedTSS, computeWeekRawTSS, universalLoad iTRIMP tiers) is ALL on the PERSONAL normalizer. The ~30 hardcoded ×100/15000 sites (matcher wk.actualTSS writes, main-view Load-vs-Plan bars, home-view, plan-view, activity-detail, sync pipes) are the POPULATION scale. For Tristan personal/population = 9100/15000 ≈ 0.61, so every population-scale number reads ~39% LOW versus the personal pipeline it gets compared against. This IS ISSUE-262 and it is live (stats-view.ts:2030 already worked around it with an explicit getNormalizerFromState fix + comment).

B1 (the ISSUE-263 core) confirmed exactly as described: buildReduceAdjustments/buildReplaceAdjustments start remainingLoad at effectiveRRC (universalLoad RRC, base×runSpec×goalFactor, saturated) and decrement by computeWorkoutWeightedLoad cuts (calculateWorkoutLoad = explicit Garmin scale #2, ~90/hr). RRC's baseLoad for an HR-tracked session is personal-TSS-scale (iTRIMP normalized), then ×runSpec (0.2–1.0) ×goalFactor (0.85–1.15) ×saturation — so RRC is a discounted-TSS quantity, while cuts are full Garmin-scale loads ~1.6× larger than TSS. Cuts are over-valued against the budget, so the loop stops early — systematic under-cut. The overshoot cap path (main-view:2296 overshootTSS in pure scale #1 → suggester:1059 fullRrcTSS = equivalentEasyKm×easyPaceMin×0.92, scale #1) is internally TSS-consistent for the capFraction, but it scales an effectiveRRC that is in universalLoad units, so the capped budget is still spent against Garmin-scale cuts.

B2 confirmed: vibeSimilarity compares activity loads (universalLoad aerobic/anaerobic, personal-TSS-scale) against planned-run loads (w.aerobic/w.anaerobic from calculateWorkoutLoad, Garmin scale #2) with LOAD_SMOOTHING=30 tuned on neither — load-similarity weighting is meaningless as tuned, though ordering is roughly preserved.

Additional boundaries not in the handover: (1) events.ts:1078 zone-carry reads wk.actualTSS (population /15000 cache written by 6 matcher sites) in preference to computeWeekTSS (personal), then subtracts plannedTSS computed from TL_BY_TYPE (scale #1) at :1105 — a population-minus-personal subtraction whenever the matcher populated the cache. (2) excess-load-card synthetic path sets iTrimp = excess×150 (inverse of /15000 population) but excess came from computeWeekRawTSS (personal), so the synthetic activity round-trips at the wrong magnitude (~1.65× for Tristan). (3) excess-load-card computeWeightedRunSpec uses hardcoded ITRIMP_NORMALIZER=15000 while the excess it weights is personal-scale. (4) main-view Load-vs-Plan bar chart renders population-scale actual bars against scale-1 planned bars on a shared axis.

The orphan conversion constants are real and disagree: suggester EASY_LOAD_PER_KM-equivalent is 35 (workoutsToPlannedRuns:1248, deprecated computeEquivalentEasyKm:377) vs universalLoad EASY_LOAD_PER_KM=12 — a 2.9× disagreement in load-per-easy-km, used in different equivalence paths. suggester:1051 hardcodes "20 TSS × 15 (load units per TSS)" claiming 15 load/TSS, a third figure. CTL/ATL (computeFitnessModel) and ACWR (computeRollingLoadRatio) are scale-safe: ACWR is a ratio so scale cancels, and both run entirely on the personal-normalizer Signal-B path. capacity-strain, planned-day-tss (running branch), and daily-coach are internally clean on scale #1 personal.


### universalLoad
universalLoad scale map


### normalizers
test


### suggester
Units trace of src/cross-training/suggester.ts. B1 (cross-scale budget loop) and B2 (cross-scale similarity) confirmed; three handover-doc corrections. PIPELINE: (a) activity load = computeUniversalLoad (scale 3). For real Strava data the popup builds from combinedActivity.iTrimp (main-view.ts:2262) so computeTierAPlus fires and calls normalizeiTrimp(iTrimp) with NO explicit normalizer = the PERSONAL LTHR _athleteNorm (~9100), NOT population /15000. This contradicts handover row 3 and universalLoad.ts:101 comment. So scale 3's iTRIMP tier is the personal-normalizer scale (same as CTL/ATL and the Strain ring), roughly TSS already. (b) Planned runs from workoutsToPlannedRuns (:1228) read w.aerobic/w.anaerobic from calculateWorkoutLoad (generator.ts:298, load.ts:94 GARMIN scale) = scale 2 (~90/hr easy). (c) maxReductionTSS = overshootTSS (main-view.ts:2296) = scale 1 TSS via TL_PER_MIN. B1: in buildReduceAdjustments (:494) and buildReplaceAdjustments (:728) remainingLoad starts at effectiveRRC (scale 3) and decrements by loadReduction from computeWorkoutWeightedLoad (:470, scale 2); cuts over-valued 1.36-1.63x (per-RPE LOAD_PER_MIN_BY_INTENSITY/TL_PER_MIN), not flat 1.6x, so budget exhausts ~1.5x too fast and under-cuts. B2: vibeSimilarity (:309/:431) compares activity scale-3 loads vs planned scale-2 loads; LOAD_SMOOTHING=30 tuned on mixed units. ORPHANS verified numerically: :1051 (20*15) implies 15 load/TSS; :1059 fullRrcTSS=equivalentEasyKm*easyPaceMin*0.92 (equivalentEasyKm=RRC/12) implies ~2.17 load/TSS at 6:00/km; :377/:1248 (35 load/km easy) imply ~5.83 load/min vs scale-2 1.5/min and universalLoad 12/km=2 load/min. Three incompatible easy-load figures (35, 12, 15). DISPLAY SAFE: modal cuts are scale-free ratios loadToKm=load/runReplacementCredit*equivalentEasyKm (:166); askKm/absorbLine/optionEasyKm proportional, auto-rescale. The one absolute display is equivalentEasyKm (RRC/12). applyAdjustments (:1386) recomputes loads via calculateWorkoutLoad (scale 2). CORRECTIONS: (1) scale 3 iTRIMP tier is personal-normalizer not /15000; (2) suggester.ts:933 docstring says maxReductionTSS converts using EASY_LOAD_PER_KM but code uses the fullRrcTSS/capFraction path (:1059); (3) suggester.ts does NOT import LOAD_BUDGET_CONFIG/minLoadToTrigger=30 (legacy matcher.ts/load-matching.ts only); the popup's own floor is minLoadThreshold=5 (scale 2).


### modes
Four scales confirmed plus two missing: HYROX MTL and w.aerobic Garmin-in-running vs TSS-in-tri.


### tests
17 load-scale test pins across 4 scales. Sites group them by scale; full per-file detail in evidence. Key doc contradictions in openQuestions.


### history
Multiple coexisting load scales confirmed; key findings in sites and openQuestions.


### empirical
Measured live (scratch deleted). 4 scales confirmed. Full numbers are in each site evidence below.

## J. B1 instrumentation result (2026-06-04, scratch trace — settles contradiction #1)

Same 90-min hard ride (iTrimp 12000) through each tier, typical 5-run week (weekly run load 555 Garmin):

| Scenario | RRC | eqEasyKm | severity→maxAdj | Replace Σcut (Garmin / TSS) | cut/RRC in TSS |
|---|---|---|---|---|---|
| iTRIMP, pop 15000 | 61.8 | 5.2 | light→1 | 59.0 / 36.2 | 0.59 |
| iTRIMP, suspect 9033 | 101.2 | 8.4 | light→1 | 59.0 / 36.2 | 0.36 |
| iTRIMP, plausible 16477 | 56.4 | 4.7 | light→1 | 11.8 / 7.2 (could NOT afford replacing a 5km easy run) | 0.13 |
| RPE tier | 172.6 | 14.4 | heavy→2 | 96.0 / 55.0 | self-consistent (Garmin both sides) |
| Garmin tier | 269.4 | 22.5 | heavy→2 | 106.5 / 65.3 | self-consistent |

**Verdict — three compounding mechanisms, all one root cause:**
1. **iTRIMP tier (dominant Strava/Garmin-HR path): UNDER-cut confirmed.** Budget is personal-TSS; cuts priced in Garmin units drain it ~1.63× too fast. Cleanest case: a ~73 TSS ride cannot absorb a ~29 TSS (5km easy) run because the run is priced at 59 Garmin units against a 56 TSS budget.
2. **Severity classification crosses scales**: `computeSeverity(FCL/weeklyRunLoad)` = tier-units / Garmin-units → iTRIMP activities under-classified (light → maxAdjustments=1) → guard binds first. The "guards, not budget" and "budget" camps were both right; same root cause.
3. **RPE/Garmin tiers: budgets inflated 2.8×/4.4×** vs iTRIMP for the same session (loop self-consistent in Garmin units, but credit + modal eqEasyKm headline over-stated).

**Device expectation after fix**: iTRIMP-path cuts get LARGER; RPE-only activity credits get SMALLER; severity for hard cross-training rises.

## K. BUILD COMPLETE (2026-06-04) — status at session end

All eight plan steps executed in one session (rate limits killed two agent fleets; built inline). SCIENCE_LOG §BP is the canonical record; CLAUDE.md gained "The Load Currency Law". Suite: 3,173 green (+32 new), tsc clean, ui-lint clean.

Shipped: ltHR plausibility gate (computeAthleteNormalizer + resolveLT intake) · calculateWorkoutLoad emits TSS via type-keyed plannedTssPerMin · garminToTssRatio conversion law · all 4 universalLoad tiers TSS (sportMult only on Tier C) · slope-1 saturation TAU=491 (CREDIT_MAX retired) · suggester/planSuggester same-scale budgets+cuts, orphans deleted, constants re-denominated · SEV-1 TE-stamp fix · tri run stamps re-anchored + tri fitness model on personal normalizer · B3 sweep complete (re-grep zero) · loadCurrencyV2 launch migration · load-currency-anchors.test.ts (17) · TSS-led modal copy ("≈ N TSS, about X km of easy running").

OUT of scope, still open: ISSUE-259 (real bike/swim TSS; placeholders IF-audited + documented) · RPE-only ACTUAL ratings value at the rated row (perceptual vs physiological, §BP limitation 1) · tri strength 20+10 stamp.

DEVICE VERIFICATION (gates closing ISSUE-262/263): heavy-week modal (TSS+km wording, larger cuts on HR-tracked activities) · `[load-currency] one-time migration restamped N` console line on first launch · synced cross contributes real TSS to tri week · strain/CTL deltas small (profile in-band, ≈4% normalizer shift at most).
