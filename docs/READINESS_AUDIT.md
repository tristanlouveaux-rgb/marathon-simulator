# Readiness Audit — Handoff Brief (2026-06-04)

Full audit of the readiness-score incidents of 2026-06-03/04, what was shipped, what remains, and the execution plan for the next session. Written as a standalone brief: a new agent should be able to work from this document plus the referenced files.

---

## 1. Executive summary

A dogfood report ("I rode 60 min hard and readiness ignored it") unravelled into four distinct defects, three now fixed:

| # | Defect | Status |
|---|--------|--------|
| 1 | Tri post-session sentence override lost in the May crash (dead code `isPostSessionState`) | ✅ Fixed — restored + extended via canonical `capacityStrainNote` |
| 2 | Readiness strain floor blind to unplanned/injury-capped sessions (plan-anchored % stayed 0 or exploded) | ✅ Fixed — capacity anchor `max(plannedDayTSS, weeklyCTL/7)`, SCIENCE_LOG §BJ |
| 3 | Home ring and Readiness detail page computed **different scores from hand-rolled inputs** (61 vs 10 on screen) | ✅ Fixed for the strain input — canonical `src/calculations/capacity-strain.ts`; **full input builder still pending = ISSUE-260** |
| 4 | HR-based iTRIMP undercounts interval rides (~42 TSS for a session whose power-based TSS is ~65–75) — readiness reads "normal day" while the athlete is exhausted | ❌ Open = **ISSUE-259** |

Everything below is the detail.

---

## 2. Incident timeline (all 2026-06-03/04, Tristan's live tri account, injured: run/swim blocked, bike capped 40%)

1. **Score 50 "Manage Load", chronic sentence** after a hard 56-min VO2 ride (6×2min @ 350W, 218W avg, iTRIMP 5202 → 43 TSS). Strain ring showed the session; score/sentence ignored it.
   - Cause A: the tri post-session override existed in snapshot `7e9c5ca` (2026-05-19), wiring lost in the May crash. `isPostSessionState` survived in `daily-coach.ts` as dead code with zero call sites.
   - Cause B: `strainPct = todayTSS / plannedDayTSS`, and home-view computed `plannedDayTSS` from the **running** workout generator — phantom 71-TSS run in tri mode. 42/71 = 59% → no floor, no note.
2. **Score 65 "On Track"** after first fixes — inputs had shifted under parallel work; a `[readiness-debug]` log pinned the real numbers: planned 71 (phantom), pct 59, no floor. The "insufficient history default = 65" hypothesis was checked and was **wrong** (weeksOfHistory = 65).
3. Parallel agent shipped **`getPlannedDayTSSContext`** (`src/ui/planned-day-tss.ts`) — canonical, mode-aware planned TSS. Today's plan became the real injury-capped ~20 TSS. Plan-anchored strain would now read 42/20 = **210% → floor 10** on a physiologically average day.
4. **Tristan's ruling (capacity anchor)**: floor anchors on `max(plannedDayTSS, weeklyCTL/7)` — overreached only when exceeding BOTH the plan and sustainable daily load. Extends his standing "ring = capacity, injury is a separate layer" ruling (§BG). Result: 42/45.3 = 93% → floor ≈ 61. Home showed 61. ✅
5. **Detail page showed 10 "Ease Back" under the same 61 Home ring.** `readiness-view.ts` had its own plan-anchored strain assembly (210%). The line above it literally said "must match home-view logic" — a comment, not a mechanism. → canonical module built (see §4).
6. **Tristan: "10 felt more right — I'm exhausted."** Analysis (accepted by Tristan): the 10 was right-by-coincidence — undercounted TSS (42) ÷ injury-shrunken plan (20), two errors cancelling. With an honest power-based ~70 TSS, the capacity model itself lands ~142% → floor ≈ 31 "Ease Back", matching his state. The fix is the measurement (ISSUE-259), not the anchor.

---

## 3. What is shipped (and where)

### Canonical module — `src/calculations/capacity-strain.ts`
- `computeCapacityStrain(s)` → `{ todayTSS, plannedDayTSS, hasPlannedWorkout, loggedSessionToday, weeklyCtl, anchorTSS, pctPlan, pctCapacity, ctlAnchored, injuryCapOvershoot }`
  - Anchor = `max(plannedDayTSS, weeklyCtl/7)`; tri weeklyCtl = swim+bike+run **+ crossTrainingCtl** (numerator counts all sports — excluding cross pinned every routine HIIT day at ~17); running ctl = `computeLiveSameSignalTSB` (already weekly-equivalent).
  - Guards: unplanned days require a real logged session (passive step TSS must not crater a rest day); weekly CTL ≥ 10 (mirrors `perDisciplineACWR` noise guard).
  - `injuryCapOvershoot` = injury active AND `todayTSS > plannedDayTSS × 1.3` (the existing "Load exceeded" margin).
- `postSessionSentence(tss, pct, {ctlAnchored})` — 130%+ "Big session today (X TSS)…", 100%+ "Solid session…", `ctlAnchored && 80%+` "Good training today (X TSS), most of a typical day's load." (Tristan: "from 80% up we say good training"). `ctlAnchored` = CTL/7 ≥ planned; gated because against a dominant planned target 80–99% can mean mid-session (running keeps "Nearly at today's target").
- `injuryCapOvershootSentence(tss, planned, capacityPct)` — "42 TSS logged against an injury-capped day of 20. Load is within your normal range, but well above the rehab cap." / sterner variant when capacity also exceeded.
- `capacityStrainNote(cs)` — canonical priority: overshoot call-out > tier sentences > null.
- Both sentence fns re-exported from `daily-coach.ts` for import compatibility.

### Consumers (the only valid pattern: call the helper)
- `src/ui/home-view.ts` — ring score input (`capStrain.pctCapacity`), tri sentence override (`capacityStrainNote`), `StrainContext.capacityStrainPct`. **Contains a TEMP `[readiness-debug]` console.log — remove after device verification.**
- `src/ui/readiness-view.ts` — ring score input, lead sentence override (before the tri/systemic fallthrough), and the Today's Strain card descriptor when `injuryCapOvershoot` (the % display stays plan-relative — that is the card's semantic).
- `src/calculations/daily-coach.ts` — `deriveStrainContext` populates `capacityStrainPct`; the internal `computeReadiness` call reads `capacityStrainPct ?? strainPct`. Plan-relative `strainPct` deliberately retained for copy tiers. Running's Tier-0 injury branch mirrors the overshoot call-out (fires when trained && plan-strain ≥ 130%).

### Science + docs
- `docs/SCIENCE_LOG.md §BJ` — full rationale, guards, canonical-module note, limitations.
- `docs/FEATURES.md` — readiness card + sentence-logic sections updated.
- `docs/CHANGELOG.md` 2026-06-03 entry + 3 follow-ups.
- Memory: `memory/project_adhoc_strain_readiness_floor.md`.

### Verification state
- `npx tsc --noEmit` clean; **3098 tests green** (daily-coach 35, capacity-strain 4 new); `npm run lint:ui` clean.
- **NOT device-verified.** Expected on Tristan's account after reload: Home ring ≈ 61, detail ring identical, sentence = the injury-cap call-out, Today's Strain card 210% with call-out caption. The `[readiness-debug]` log prints all intermediates.
- One earlier full-suite failure was `_holiday-p1.integration.test.ts` straddling the midnight rollover; passes consistently since.

---

## 4. Open problem 1 — ISSUE-260: five hand-rolled `computeReadiness` input assemblies

`docs/OPEN_ISSUES.md → ISSUE-260`. The strain leg is canonical; the other ~12 inputs are still assembled independently per surface. Known call sites:

| Caller | Deviations found |
|---|---|
| `src/ui/home-view.ts:~1002` | reference implementation (live TSB/ACWR/recovery/strain) |
| `src/ui/readiness-view.ts:~177` | now matches Home on strain; rest is a near-duplicate block that can still drift |
| `src/calculations/daily-coach.ts:~330` | own assembly; now reads capacityStrainPct |
| `src/ui/coach-workout-modal.ts:395` | **no strainPct, no recoveryScore, `ctlNow: s.ctlBaseline` (stale), `weeksOfHistory` capped at 4** — feeds the LLM coach payload |
| `src/calculations/session-recommendation.ts:64` | same deviations — feeds the on-demand generator |
| `src/calculations/tri-readiness.ts` | EXCLUDED by design (per-discipline inputs) |

### Execution plan (agreed with Tristan)
- **Phase 0 — audit + freeze (~30 min)**: per-caller, per-field source table; `git blame` each deviation (accident vs intent).
- **Phase 1 — `buildReadinessInput(s)`** in new `src/calculations/readiness-input.ts`, composing `capacity-strain.ts` + `planned-day-tss.ts`. Returns `{ input, intermediates }` (metrics, sleepBank, recoveryResult, acwr, tsb, capStrain — the views render these). Memoize per state reference: Home + detail currently pay the fitness-model cost twice per render.
- **Phase 2 — migrate home-view + readiness-view**. Gate: temp log diffing the two scores every render; must be zero before the log is removed.
- **Phase 3 — migrate daily-coach internal, coach-workout-modal, session-recommendation.** Every Phase-0 deviation either dies or gets a written justification in the builder. Default: full canonical input — the LLM coach should see the ring's score.
- **Phase 4 — regression guards**: (a) golden test — one synthetic full-feature state, assert home/detail/coach scores identical; (b) grep-based CI test failing if `computeReadiness(` appears outside the builder, tri-readiness, and tests.
- **Constraints**: home-view + readiness-view are the most contended files this week (three edit collisions on 2026-06-03 alone). Run as a **single-agent task in a quiet window**. Estimate 2–4 focused hours. **Do ISSUE-260 before ISSUE-259** — changing TSS sources while inputs are duplicated re-creates the 61-vs-10 split in more places.

---

## 5. Open problem 2 — ISSUE-259: HR-based ride TSS undercounts intervals

`docs/OPEN_ISSUES.md → ISSUE-259`. Repro: 56-min VO2 ride (6×2min @ 350W / 145W, 218W avg) → iTRIMP 5202 / personal normalizer ≈ 12,100 → 43 TSS on a 1h-at-LTHR = 100 scale. Power-based Coggan TSS ≈ 65–75 (FTP-dependent, NP > avg on intervals). Cycling HR lags power 30–60s on 2-min reps — the same reason power adherence (not HR) is already the primary bike effort signal (CLAUDE.md mirror section).

Consequences: readiness read the session at 93% of capacity while the athlete was exhausted; with an honest ~70 TSS the same capacity model lands ~142% → floor ≈ 31 "Ease Back" — i.e. **the anchor is right, the input is wrong**. Tristan probed reverting to the plan anchor on feel; the counterfactual above is the agreed answer (do not relitigate the anchor).

Direction (two parts):
1. **Quick win — session-RPE override for endurance sessions** (Foster sRPE × duration). The pattern already exists for strength (`computeStrengthRpeTSS`, which exists because HR undercounts strength the same way). User tags the ride 9/10 → TSS corrects immediately.
2. **Structural — power-based Coggan TSS** for rides carrying power: `(sec × NP × IF)/(FTP × 3600) × 100`, NP preferred, avg watts as floor, iTRIMP fallback. Needs: per-activity watts field availability (Strava `weighted_average_watts` vs Garmin webhook), FTP source from `triConfig` (provenance-aware per the benchmark-override rules), and a migration story — **CTL/ATL are built from the same signal**, so switching rides to power-TSS shifts the chronic baseline; whole-pipe change, coordinate with whoever owns the matching/load pipeline.

---

## 6. Decisions log — do not relitigate without new evidence

| Decision | Who/when |
|---|---|
| Ring is **capacity-based**, injury is a separate constraint layer (caption/sentence) | Tristan, §BG (2026-06-03), reaffirmed twice |
| Floor anchor = `max(plannedDayTSS, weeklyCTL/7)` | Tristan picked "Capacity anchor + cap call-out" (2026-06-04) |
| Cross-training CTL included in the tri anchor | forced by data (cross = 143/345 of his weekly CTL) |
| Acknowledge sessions from **80%** of anchor up ("good training") — CTL-dominated anchor only | Tristan, 2026-06-03 |
| Injury-cap overshoot margin = ×1.3 | reuse of the existing "Load exceeded" ring threshold, not a new constant |
| Plan-relative % stays on the Today's Strain card (display semantic), capacity % feeds the score | this session |
| "10 felt right" ≠ revert the anchor; fix the TSS input (ISSUE-259) | argued + accepted 2026-06-04 |

## 7. Known smaller gaps (parked)

- Running-mode injury Tier-0 outranks Tier-1 post-session copy, EXCEPT the new overshoot branch — an injured running user with a sub-130% session sees the generic injury line, never "Solid session today".
- `matchedActivityToday` in both views is only computed when `plannedDayTSS === 0` — do not reuse it as "any activity today".
- `capacityStrainNote` is tri-gated at the call sites (running gets copy via `derivePrimaryMessage`); if a future mode (cycling/HYROX home card) needs it, call the same helper, do not fork.
- HYROX/cycling home cards have not been audited for this sentence behaviour at all.

## 8. First actions for the next session

1. Device-verify: reload Tristan's account → Home ring == detail ring (≈61 pending today's load), sentence = injury-cap call-out on both, paste `[readiness-debug]`.
2. If verified: **remove the TEMP `[readiness-debug]` console.log in `src/ui/home-view.ts`** and mark the CHANGELOG entries device-verified.
3. Start ISSUE-260 Phase 0 (quiet window, single agent).
4. Then ISSUE-259 (sRPE quick win first, power-TSS second).

---

## 9. Addendum (2026-06-04, later session) — maths verified, two new findings

Tristan re-reported the symptoms ("score doesn't reflect training, commentary static, 65↔61 flicker") and pasted a live `[readiness-debug]` log. Findings:

### 9a. Flicker = launch data race, NOT input-assembly drift
The pasted log showed render 1 → score **66**, renders 2–5 → score **61**, with **identical strain fields** (`todayTSS 2, anchor 0, pctCapacity 0, floor null` — a rest day, all correct). The moving leg is one the log didn't print (tsb / acwr / sleep / HRV / recovery): render 1 fires before the async sync + physiology fetch lands, the rest after. The TEMP debug log in `home-view.ts` now prints **all** the legs plus `physioLen` / `actualsLen`; the next reload identifies the mover. Candidate fix once identified: don't compute/paint the ring until first sync completes (or re-render silently), to be folded into ISSUE-260.

### 9b. Maths verified — `src/calculations/readiness-strain-sensitivity.test.ts` (15 tests)
- **Floor shape** (readiness.ts:627): 93% → 60, 100% → 54, 130% → 38, 155% → 24, 180%+ → 10. All asserted.
- **The floor is a cap, not a penalty**: an athlete whose ambient composite is already below the floor sees ZERO change from a sub-100% session. This is the design explanation for "the score ignores my training" on tired days.
- **ISSUE-259 quantified**: the same dogfood ride (iTRIMP 5202, anchor 45.3) floors at **59 "On Track"** undercounted vs **24 "Ease Back"** with honest power TSS (~70). The measurement gap alone spans two label bands. Confirms §5's priority.

### 9c. NEW — capacity-strain numerator/denominator scale mismatch (ISSUE-263 class)
`computeCapacityStrain`'s `todayTSS` uses the **personal** iTRIMP normalizer (`normalizeiTrimp`, fitness-model.ts:291); the tri `weeklyCtl` denominator comes from `triConfig.fitness`, built by `estimateTss` = `iTrimp / 150` — the **population** 15000 scale (tri-benchmarks-from-history.ts:907). Same ride, two TSS values, divided by each other: every tri `pctCapacity` is inflated by `15000 / personalNorm` (~1.23× for Tristan). Owned by the queued load-currency session (`docs/LOAD_CURRENCY_PLAN.md`) — do not point-fix.

### 9d. weeklyCtl anomaly RESOLVED (mostly) — stale persisted fitness + dedup-halved chronic
Tristan pasted `[tri:fitness-diag]`: activityCount 40, DIRECT CTL swim 0 / bike 106.4 / run 17.3 (= 123.7 + crossTrainingCtl, cross not printed). Two conclusions:

1. **The `weeklyCtl: 83` in the readiness logs was STALE persisted `triConfig.fitness` from a previous boot** — the readiness renders fire before main.ts's benchmark refresh writes the new direct CTLs. The capacity anchor is subject to the same launch race as the other inputs. (Open sub-question: a post-refresh `scheduleHomeRefresh` render should have logged weeklyCtl ≈ 124+cross; all pasted lines showed 83 — verify on next reload with the extended log that the refresh write reaches the rendered state.)
2. **317 → ~124+cross is mostly the cross-source dedup (2026-06-03) removing Strava+Garmin double-counting** — the audit's "93% of capacity" was calibrated against inflated chronic load. With honest chronic, the same 43-TSS session reads ~155-240% → floor 10-24, ON TOP of the 9c scale inflation (~1.23×). The system has likely flipped from under-reacting to OVER-reacting. This makes the load-currency reconciliation (ISSUE-263, `docs/LOAD_CURRENCY_PLAN.md`) a prerequisite for trusting any capacity-anchored score — the anchor now divides personal-scale acute TSS by deduped population-scale chronic.

NOTE for anyone reading the `[tri] benchmarks refreshed` console line: it prints the MATRIX-ADJUSTED per-discipline CTLs (race-prediction set, e.g. run 113.2); the capacity anchor reads the DIRECT set from `triConfig.fitness` (run 17.3). Do not compare them.

### 9e. Trained-day acknowledgment SHIPPED (2026-06-04)
Tristan: "the day you've trained the commentary should at least reflect that rather than look unphased." `capacityStrainNote(cs, fallback)` now takes the caller's chronic sentence; on any day with a real logged session (`loggedSessionToday` — passive steps excluded, no new threshold) that lands below the strain tiers, the lead sentence becomes "X TSS logged today. <chronic sentence>". Home (`home-view.ts`) and the detail page (`readiness-view.ts`) both pass their chronic fallback; priority unchanged (injury-cap overshoot > tiers > acknowledgment > chronic). 4 tests added, suite 3141 green, NOT device-verified. Running mode (`derivePrimaryMessage`) was evaluated per the mirror rule: it has its own copy chain with plan-relative tiers; add a matching acknowledgment tier there only if the same complaint appears in running mode.

### 9f. FTP regression root-caused — account fragmentation (2026-06-04)
"We used to auto find the 295" decoded via live DB queries: the dev athlete's history is split across 4+ user_ids — gmail `44bd716f` (12 activities, holds the Garmin token), anon `9de72f10` (created 06-01, 29 activities, likely the current app sign-in), anon `4886ffb0` (created 06-02, the 294-activity Strava backfill holding the ONLY `power_curve` ride = the 295W source), anon `1c55ea4b` (246 old-dated activities). FOUR live Strava token rows refresh daily for the same athlete. The 295 auto-derive worked only via the data-isolation leak (pre-filter, the loader read every account's rows). With the correct `user_id=eq` filter (`tri-activity-loader.ts:90`), the signed-in fragment has no power curves → fallback 153W low-conf. The same fragmentation is part of the weeklyCtl story (§9d). **Fix = consolidate activities/tokens onto one canonical account + make every device/webhook authenticate as it (data migration, Tristan sign-off pending). Do NOT relax the user_id filter.**
