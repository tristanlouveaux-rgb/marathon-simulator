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

**§5 profile plausibility check (ISSUE-262 prerequisite) — RESOLVED in principle:**
- Formula: `computeAthleteNormalizer` (fitness-model.ts:267) = `3600 × HRR_LT × e^(1.92 × HRR_LT)` (Coggan hrTSS, Banister β=1.92). The formula is sound; the *input* is the bug.
- Tristan's profile (from Garmin): restingHR 42, maxHR 192, LT pace 4:12/km. Stored ltHR ≈ 144 implied by the ~9,100 normalizer → LT at 68% HRR / 75% maxHR — physiologically implausible for a 4:12/km-threshold athlete (expect 85–92% maxHR ≈ 163–177 bpm).
- Normalizer table: stored profile → 9,033 (TSS inflated +66%); population fallback → 15,000; plausible ltHR 172 → ≈16,477 (TSS ~10% *below* population).
- **Conclusion: keep the personal normalizer (scientifically better), fix the stored ltHR.** `s.ltHR` is written only via `applyResolved` (ltSync.ts:260) from the LT resolver chain — source visible in Stats LT subtitle + `s.ltSource`. PENDING: Tristan to read the actual LTHR bpm off Garmin (shown next to the 4:12 pace) and identify which resolver source produced 144.

**Audit fleet**: workflow `wf_ebba8d99-ac2` (8 census + 1 empirical + 5 adversarial verifiers + synthesis). First run killed by session rate limit 2026-06-04 00:39 BST; relaunched 09:30 BST.

## 9. Definition of done

- One documented canonical scale; every producer either emits it or converts at its boundary.
- Anchor tests green and impossible to pass with mixed scales.
- Suggester budget loop unit-consistent; modal re-verified on device (cuts will be larger).
- ISSUE-262 display sweep complete (re-grep zero hardcoded `/15000` in user-facing surfaces, or each survivor justified in a comment).
- Readiness/ACWR/CTL/ATL deltas on Tristan's real state: ~zero or explicitly explained.
- SCIENCE_LOG entry; ISSUE-262 + ISSUE-263 marked fixed only after Tristan device-confirms.
