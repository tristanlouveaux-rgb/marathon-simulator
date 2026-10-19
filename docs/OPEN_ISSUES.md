Note: we have had a persistence problem of open issues not being correctly logged after long conversations. Going forward can we make it clear with answers to all questions put in here in order to most clearly reflect desired set up
# Open Issues

> **Workflow**: Tristan logs raw bugs/observations in `.claude/TL thoughts`.
> Claude reads that file, triages, and maintains this structured list.
> P1 = broken or actively misleading · P2 = confusing/unclear · P3 = missing feature/future
> **UX overhaul items** are tagged `[ui-ux-pro-max]` — handled via that skill in a dedicated session.

---

> **2026-10-14, triathlon and cycling taper (lane tri-taper): open questions (ISSUE-400).** Raised in the implementer and reviewer reports for `fix/tri-taper` (merged in `5068d8b`; CHANGELOG 2026-10-14; SCIENCE_LOG §DN). Notes added to ISSUE-317, ISSUE-364, ISSUE-380, ISSUE-381, ISSUE-382 and ISSUE-383. None of the lane's changes is marked fixed: they are unit-tested, not device-verified (`docs/DEVICE_TESTS.md`).

### ISSUE-400: Triathlon and cycling taper open questions *(P3, 2026-10-14, needs Tristan's decisions; several pre-existing)* — OPEN

Already decided, not re-asked: taper length by race distance, 0.55 then 0.30 and 0.55 for a one-week race week, the low-hours taper, quality kept with 70.3 and Ironman capped at race intensity, and the conservative sourced day-before values, including Allen's 10-min run cap over the fact-check's 10 to 15 (Tristan, 2026-10-13); the low-hours taper for sprint and Olympic only, the closing-week activation and the weekly target on `triTaperFraction` (orchestrator, 2026-10-14).

(a) **Effort multiplier sizing** (§DN limitation 15). The orchestrator decided (2026-10-14) that taper weeks skip the effort multiplier; review showed that delivered 0.55/m and 0.30/m of the week trained (two-week mean outside the band at m 1.15), and the fixer sized the taper from the reference week as trained instead (`triTrainedReference`, `plan_engine.triathlon.ts:827`; `26183cf`). The science reviewer judged this the correct reading (Mujika 2011 measures the cut against pre-taper training) and asked for confirmation. Alternatives: round 3's behaviour (taper week 1 scaled, race week not) or unscaled taper weeks with the docs corrected; reverting `26183cf` gives the latter. Related: a past taper week is read at the multiplier in force when it was current (`triStateAtWeek`, `:796`), an assumption that a late rating or `advanceWeekToToday` skipping the race-week rollover can break; stamping the multiplier on each taper week at build time (`wk.triEffortMultAtBuild`) would remove it.

(b) **Mirror rule: the CTL gap in the taper.** Running's taper weeks take both levers (`adaptiveVolumeMultiplier`, `plan_engine.ts:646`, CTL gap on every non-deload week); the triathlon taper takes the effort multiplier through its reference week and skips the CTL-gap stamp (reduce-only; skipping it only lightens the cut). `d5a7f39` had named running's taper the mirror-rule difference when the tri taper skipped effort altogether; `26183cf` replaced that comment. Should the triathlon taper take the CTL gap, or running's taper skip it? HYROX matches triathlon here (effort through the reference week, the MTL gap suppressed in taper weeks; ISSUE-383 note).

(c) **Long-course race-pace dose** (§DN limitation 12). A taper-week-1 race-pace session holds as many 90 s repeats as its 0.55 share holds (at least 3), without cutting steady sessions to reach the 75% target that short course and cycling reach: 70.3 16 weeks 10 h holds bike 5 × 90 s and run 4 × 90 s against 8 each beside a 65-min steady ride and a 60-min long run (science reviewer at `d5a7f39`). One-line alternative: set the slot's need to `triRacePaceNeedMin(discipline, targetReps)` capped at its reference (`plan_engine.triathlon.ts:1111-1118`), so long rides and runs shrink first. Keep as built? A change after v24 reaches users needs a `TRI_GENERATOR_VERSION` bump.

(d) **Thursday to Saturday races** (ISSUE-364; §DN limitation 8). The race window cuts taper week 1, so these tapers fall below the band and lose taper-week-1 quality (Thursday 360 of 417 triathlon plans, Friday 265, Saturday 0; fixer's sweep at `ba5e09b`). Taper week 1 has free days at least 7 days out. Should window-cut sessions move to those days, as `taperWeekKeepsDisciplines` (`:522`) already does for a discipline the window empties?

(e) **Thin weeks above the band** (§DN limitation 5). Three 20-min floor sessions hold taper week 1 at about 0.67 for 70.3 or T100 at 4 h with gym or commutes, and low-hours one-week race weeks reach 0.73. Accept as a floor artefact (the 21 to 40% band still helped), or let a thin taper drop sessions below 80%?

(f) **Race-week frequency counts the race and the activations** (§DN limitation 4), while the volume rule leaves the race out. On training sessions alone 113 of 380 Sunday race weeks fall below 80%. Kept by the orchestrator; confirm, or count training sessions only (which adds sessions to race week).

(g) **Closing-week activation** (implementer's inference). It counts toward race week's frequency and comes off race week's budget, and race week still keeps its own session in each discipline, so a Tuesday or Wednesday thin race week plus its activation sits a few minutes above taper week 1 (2 plans per weekday at the default split, 100 with commutes). Confirm.

(h) **Fallback opener and the 31-min race-pace floor** (`6fe94ce`, `444ebd6`). With no budget for an opener, race week still holds one at 3 × 90 s in the discipline it overshoots least; a race-pace session may run 1 min past a 30-min reference to hold 3 × 90 s. Confirm.

(i) **Matcher and the closing week.** `runTriActivityMatching` (`src/main.ts:1964`) and `matchTriathlonWeek` fall back to any unmatched same-discipline slot in the week (`activity-matcher.triathlon.ts:81-82`). A Tuesday or Wednesday race's closing week now holds the spin and jog: if the athlete skips them, the race's bike or run leg can match the 20-min spin or 5-min jog, be marked completed against a Z2 target and be moved to race day. Other race weekdays already expose race week's slots the same way. Suggested: keep race-day activities out of the fuzzy pool, or limit `day_before` slots to same-day matches.

(j) **Signal B in the taper** (ISSUE-317 (c); §DN limitation 17). `computePlannedSignalB` (`fitness-model.ts:1253`) tapers only its running term: a triathlete with synced rides and swims reads race week at 0.77 of a base week (460 against 594) while Signal A reads 0.30, and in cycling mode the settle's race-week target stays near a base week. Taper the cross-training budget for triathlon and cycling?

(k) **Brick placement.** Byrn and Allen put the brick and the heaviest race-week day 3 days out, and the plan follows them; the build brief's race-week decision asked for a moderate brick early in race week. Kept as a documented default (orchestrator decision 6). Keep 3 days out, or move the brick to 5 to 6 days out?

(l) **Weekend onboarding** (§DN limitation 10). A Friday to Sunday onboarding with a Monday to Wednesday race 2 weeks out makes race week the partial first week: from Saturday or Sunday onboarding some disciplines get no race-week session (135 plans at the default split, correctness reviewer at `ba5e09b`). No fix is possible inside that week. Accept, or warn at setup?

(m) **Commutes and gym fill a thin long-course week** (pre-existing generator issue). T100 and 70.3 at 4 h with 2 gym sessions and three bidirectional commutes leave the reference week, and so the whole taper, no swim, bike or run. Fix in the hours solve (§CB) as its own issue?

(n) **T100** (implementer's extensions, no source). T100 takes 2 taper weeks, the race-pace ceiling and the race-week brick, which Tristan's decisions named for 70.3 and Ironman only; its race intensity 0.76 FTP (`RACE_INTENSITY_BY_DISTANCE`, `bike-physics.ts:99`) was placed just below 70.3 with no source, although its 80 km leg is shorter than 70.3's 90 km, so Coyle's reasoning puts it at or above 0.78. The constant predates the lane and now sets planning race-pace targets. Confirm or source.

(o) **Cycling ceiling.** Cycling's taper week 1 keeps sweet spot or tempo (the fact-check's corrected ceiling, kept by the orchestrator); Tristan's decisions named no cycling ceiling. The alternative is race intensity, as for long course; for 160 to 300 km events (IF 0.62 to 0.74) that is a Z2 taper like Ironman's. Confirm.

(p) **Ironman taper quality sits in Z2** (§DN limitation 13). Race intensity 0.70 FTP is in the endurance zone, so Ironman's race-pace rides are typed endurance (RPE 3) with repeats 5% FTP above steady. The Ironman coaches cited use 70.3 pace in race week (Dave Scott, Byrn). Keep race intensity, or set long-course repeats at 70.3 intensity?

(q) **Per-discipline depth.** Every discipline is cut alike (0.55, 0.30); coaching cuts the run deepest and the fact-check left the ordering to Tristan (uniform within the band, or run deepest with the run past 60%).

(r) **Race-pace copy rounding.** `fmtMin` (`tri-taper.ts:184`) rounds 30 min and more to the nearest 5, so a 31-min race-pace session's text reads "30min" while `estimatedDurationMin` is 31. Not checked on a rendered card. Round to the minute in taper copy?

(s) **Dead code and stale comments** (code, not docs). Unused: the scheduler's `raceWeek` argument (`scheduler.triathlon.ts:72`), `placeStoredPlanRaceWeekPrimer` (`race-day-rules.ts:503`, test only), `TRI_BIKE_QUALITY_DOW` (`scheduler.triathlon.ts:43`). Stale comments: `tri-volume-by-discipline.ts:137-139` (a closing week "holds only the race"), `phases.ts:160-162` (`taperFraction` the weekly target's single source in every mode), `scheduler.triathlon.ts:62-71` (the race-week primer and the no-doubles rule presented as physiology), `race-day-rules.ts:245` and `:490` (the triathlon primer). User-facing em dashes outside the lane: "Brick — bike + run" (`brick.ts:61`, shown in reference weeks) and the HYROX injury note "Capacity ${cap}% — ..." (`plan_engine.hyrox.ts:1876`).

(t) **HYROX taper fractions: mirror evaluated, decision open** (full note on ISSUE-383). At `d8432d2` (lane H2) HYROX tapers 2 weeks at `taperFraction`, 0.70 then 0.55 of its reference week's planned minutes (`plan_engine.hyrox.ts:2587`). Delivered (docs-pass probe at `d8432d2`, 629 Open Singles plans): taper week 1 median 0.70 and race week median 0.55 of the reference week, a mean cut of about 38%, in the weaker 21 to 40% band (Bosquet ES 0.27, p = 0.02, against 0.72 for 41 to 60%), where triathlon and cycling cut 57.5% (0.55 then 0.30). HYROX's plan and weekly load target use the same fractions. No change was made. Keep 0.70/0.55 for HYROX with a recorded reason, or move it to 0.55/0.30? Re-check the delivered fractions after the HYROX session-content lane (`fix/hyrox-h2b`) lands.

(u) **Test hygiene.** The `tri-taper-rules.test.ts` matrix tests have no explicit timeout. Running the lane's 12 test files together with vitest's default workers (8 cores here), the Sunday to Wednesday matrix tests for sprint and Olympic fail with "Test timed out in 5000ms": 3 failures in one run at `5068d8b`, then 1 and 2 in two runs at `d8432d2`; other combined runs passed. The file passes alone (43 tests, 7.4 s at `d8432d2`) and all 12 files pass with `--maxWorkers=2` (306 tests). Give the matrix tests an explicit timeout. Separately, the `tri-taper-effort.test.ts` race-week upper bound (0.37) sits 0.002 above Olympic 16 weeks 8 h at m 0.85 (0.368), so a small change to the openers or floors fails it without a regression; derive the allowance from the composed floor sessions. Intermediate commit `08f7091` fails `bike.test.ts` (fixed by `80a8351`), so a bisect stops there.

> **2026-10-13, HYROX Doubles partner matching (lane HP): open questions and production follow-ups (ISSUE-399).** Raised in the implementer and reviewer reports for `feat/hyrox-partner` (merged in `d8bdff7`; CHANGELOG 2026-10-13; SCIENCE_LOG §DM; RUNBOOK "HYROX Doubles partner tables"). The migration is live in production (applied by hand 2026-10-13); the two edge-function edits are not deployed. A note added to ISSUE-254. None of the lane-HP changes is marked fixed: they are unit-tested, not device-verified (`docs/DEVICE_TESTS.md`).

## New issue

### ISSUE-399: HYROX Doubles partner open questions *(P2, 2026-10-13, needs Tristan's decisions; (a) before a real second user links)* — OPEN

Already decided (Tristan, 2026-10-12, migration header `20261013000001_hyrox_partner.sql:6-8`): link by invite code; share only race-relevant numbers; either partner can unlink at any time; one partner at a time.

(a) **The privacy policy says nothing is shared with other users.** `public/privacy.html:60` and the live copy `~/Documents/mosaic-landing/privacy.html:60` read "No data is shared with other users or sold to third parties." A linked partner sees the athlete's snapshot: header initials, format, division, race tier, per-station benchmarks with load tier and pair-time flags, forecast station lines, Roxzone and solo run pace (`HYROX_PARTNER_SNAPSHOT_KEYS`, `hyrox-partner-snapshot.ts:75`). Review the policy, `docs/PRIVACY_NUTRITION_LABEL.md` (initials derived from the first name and fitness numbers are shown to another user at the athlete's request) and `docs/LEGAL_CHECKLIST.md` (privacy policy, data export) before anyone beyond Tristan's own test accounts links. No legal text was drafted. Both copies of the page have to change together (ISSUE-254).

(b) **Two edge-function deploys pending** (`49b92bf`; commands in RUNBOOK). Production today: on account deletion the app runs `removeMyHyroxPartnerData` right after `delete-account` returns (`account-legal.ts:103`; unlink, then own snapshot and invite), Wipe everything runs the same cleanup, and the 30-day purge cascades every partner row through the `auth.users` foreign keys. Missing until the deploy: the three partner tables in the export file (whose meta note says it holds every row), and a server-side partner delete for when the client step fails (the app killed or offline straight after the delete call; the partner can then read the snapshot until the purge). Decide when to deploy. Confirm too that partner rows are hard-deleted when deletion is scheduled and not restored on cancel; the client already behaves that way today.

(c) **Production record and the RLS script.** The migration was applied by hand, so `supabase_migrations.schema_migrations` has no row for it, alongside the wider tracker drift (`docs/SECURITY_SWEEP_REPORT.md`, "STILL OPEN"). Fold it into that reconcile when it happens? The RLS script (`supabase/rls-tests/20261013000001_hyrox_partner_rls_test.sql`) has run only on throwaway local databases. Its header (`:5-8`) offers the Supabase SQL editor; the audit runbook (`docs/audits/2026-10-13-partner-table-runbook.md`) says not to run it on the live database. Options: (1) run it once on production (one transaction ending in ROLLBACK; it inserts three throwaway `auth.users` rows inside it, which fire any `auth.users` triggers before the rollback); (2) run it on a branch or staging copy; (3) rely on the local runs and change the header to say so. The script sits outside `supabase/migrations/`, so `supabase db push`, `db reset` and `migration list` never see it.

(d) **Pair forecast run term** (SCIENCE_LOG §DM limitation 1). The pair runs at 8 × the slower partner's singles pace; each athlete's own doubles forecast applies the cohort run ratio. Reviewer's probe at `5dcde1b`, identical partners: the pair forecast is faster than the athlete's own doubles forecast by 176 s in Mixed, 112 s in Women Open, 96 s in Women Pro, 24 s in Men Open and 0 s in Men Pro (a Mixed intermediate man: Forecast 4419 s, pair 4241 s). Option A: keep the rule (the real slower partner replaces the ratio; the implementer's choice). Option B (reviewer): each partner's device computes their run pace in doubles terms (`deriveHyroxRunPace` at the doubles format, no biological sex shared), and the pair runs at 8 × the slower of the two; the `run_pace_sec_km` column then means doubles pace and the "solo pace" captions change.

(e) **Invite code defaults.** 8 characters from a 31-character alphabet, 24 h expiry, one live code per user: set in the migration (`:70-72`, `:132`, labelled "Product defaults (kept in review, 2026-10-13)" at `:26-27`) and mirrored in the client (`hyroxPartner.ts:25-26`). Confirm or give values.

(f) **No redeem throttle.** Nothing limits redeem attempts or code creation rate. unavailable merges unknown, expired and redeemed codes, but own_code and partner_linked still show that a live code exists. Code space 31^8, about 8.5 × 10^11, with a 24 h life; a correct guess links to a stranger, who then sees race numbers and initials. A rate limit needs numbers from Tristan; none were invented.

(g) **Leaving doubles: Edit Plan keeps the link, Reset plan may end it.** Account > Edit Plan away from doubles deletes the athlete's own snapshot and keeps the link, so a temporary format change keeps the pair; a Reset plan that ends outside doubles ends the link (`hyroxPartnerSync.ts:15-35`). Unify, so leaving doubles always unlinks? Related, from the implementer: the leaving-doubles delete needs the session to have seen doubles at an earlier save (`lastSeenDoubles`, `:82`, `:294`), so a format change made on another device deletes the snapshot from that device only.

(h) **The redeemer's own code stays live while linked**, up to its 24 h expiry, so a crossing redeem a few seconds later answers linked (migration `:411-415`). A third person entering it reads "That athlete already has a partner." It is deleted on the partner's crossing redeem, on unlink, on a new code or on account deletion. A shorter window needs a number.

(i) **A snapshot write racing an unlink can leave an orphan row.** An upsert whose statement began before a concurrent unlink committed still lands (migration `:310-313`; the reviewer reproduced it locally on both the insert and the update path). Nobody can read it, every later write is refused, and it is deleted when the athlete leaves doubles, resets or deletes the account. Accept, or add the reviewer's BEFORE INSERT trigger that takes the owner's advisory lock and re-checks the link?

(j) **Dead-code copy.** "This code has expired or been used. Check the 8 characters." (`partner-view.ts:68`). The second sentence covers a mistyped well-formed code, which also reads unavailable. Keep or drop it.

(k) **Placement, polling and an open page.** The Partner row sits at the bottom of Stats (alternatives raised: the Forecast tab, the Account HYROX card). The page polls the link every 5 s only while a code is on screen (`LINK_POLL_MS`, `partner-view.ts:50`), and a push waits 4 s after the last save (`PUSH_DEBOUNCE_MS`, `hyroxPartnerSync.ts:108`), both engineering values. An open linked page keeps showing the old comparison when the partner unlinks, until it is reopened; only the Stats row listens for cache changes.

(l) **Reset waits on the partner requests.** Reset plan and Wipe everything await the partner step beside `deletePlanSettings` (`events.ts:1457`, `:1480`), up to three sequential requests with no timeout, so a connection that is up but stalled can hold the reset. The implementer kept the wait so that a Reset plan's snapshot delete is not cancelled by the reload; the pending entry is written before any await, so the launch would retry either way. Pre-existing and related (reviewer's jsdom probe at `e0d6aa2`, not device-confirmed): `softResetState` writes localStorage and leaves the in-memory store old until the reload (`persistence.ts:579-632`), so a background `saveState` in that window writes the old state back and undoes the reset locally; a longer wait widens the window. Options: stop awaiting the partner step, add a timeout, or close the store gap in `softResetState`.

(m) **Wipe with no owner stamp on the web.** The pending entry is written synchronously only when the state carries an owner stamp (`hyroxPartnerSync.ts:212`); a plan rebuilt offline after a Reset plan has none, so an offline Wipe on the web then waits on the lazy chunk import, fails, and records nothing (a pending 'reset' entry is later decided as a reset). Reviewer's option: reuse a single pending entry's account id, or read the stored session synchronously. Also: an entry for an account that never signs in on the device again stays in localStorage (a few bytes).

(n) **Division on history entries.** `stationBenchmarkHistory` entries record format and Pro weights, not division (`src/types/triathlon.ts:168-175`), so a test logged under an earlier division is read at the current division's loads (SCIENCE_LOG §DM limitation 7). Add an optional division to new entries? It touches lane H3b's per-entry conversion.

> **2026-10-13, HYROX lane H3c (one planning band, cohort-named ranks, per-entry staleness, load notes, provenance copy): open questions (ISSUE-398).** Raised in the implementer and reviewer reports for `fix/hyrox-h3c` (merged in `d7bc44b`; CHANGELOG 2026-10-13; SCIENCE_LOG §DL). Notes added to ISSUE-395 (b), (d) and (k). None of the lane-H3c changes is marked fixed: they are unit-tested, not device-verified (`docs/DEVICE_TESTS.md`).

### ISSUE-398: HYROX lane H3c open questions *(P3, 2026-10-13, needs Tristan's decisions)* — OPEN

The planning-field rule (one field for every format, Open Singles at the athlete's own sex, a Pro or Doubles finish converted first; display ranks stay cohort-specific), the per-entry decay and the copy changes were orchestrator decisions in the lane brief, recorded as such in code (`hyrox-planning-band.ts:10`); they stand unless Tristan reverses them. The one review approved the lane with four minor issues and no later commit in the range addressed them: (b), (c), (d) and the comment fix at the end. Its fourth issue, the release gate with lane H2, is closed by H2's merge (`d8432d2`); what is left of it is (a).

(a) **Existing athletes keep their stored band** (release gate closed by lane H2, `d8432d2`). Lane H2 applied the implementer's merge notes: the initializer reads `hyroxPlanningBandFor` (`initialization.hyrox.ts:144`) and passes the race's tables to the back-computed race (`:287`, `:290`); the generators read the planning-field seeds (`hyroxStationSeedsAtTarget`, `hyroxSeedRunPaceSecKm`; `hyrox-generators.ts:172`, `:235`); `hyroxBandingTimeSec` is deleted; `HYROX_GENERATOR_VERSION` is 18 (`plan_engine.hyrox.ts:284`). Docs-pass probe through the real initializer at `d8432d2`: a woman with an Open Singles 1:25:00, a Pro Singles 1:30:00, a Pro Doubles 1:15:00 (women's pair), an Open Doubles 1:15:00 (Mixed) or an Open Doubles 1:20:00 (women's pair), and a man with a Pro Singles 1:20:00, all initialise advanced, the band setup shows once the previous format is picked (at `5068d8b` the five women initialised intermediate). Left: the v18 regeneration migrates session counts (`migratePreV18HyroxSessionCounts`, `hyrox-plan-regen.ts:64`) and keeps each stored band, so an athlete onboarded under the global scale or lane H3b's field-relative rule keeps that band until they log a previous time or correct its format. Re-band stored athletes with `hyroxPlanningBandFor` at the v18 regeneration? It changes the MTL cap, the session structure and the seeds (compare ISSUE-395 (j)).

(b) **Confidence cap and staleness note still read the race's age** (review issue 1; implementer's question). Per-entry decay changed only the blend weight. With 8 station tests from last week and an 18-month-old race, the tests count in full, yet confidence is capped low (`race-prediction.hyrox.ts:1038`) and the forecast reads "8/8 stations calibrated. The race is 18 months old, so confidence is low." (`hyroxConfidenceCaption`, `forecast-view.ts:515`) and "Race 18 months ago. Forecast leans on current physiology evidence." (`forecast-view.ts:936`). The reverse: tests 15 months old decay (weight 0.75 with no physiology evidence) and confidence can still read high with no note. Reviewer's fix: apply the race-age cap and note only when a value in use reads the race-age weight (race splits, 'manual' entries, or the band blend for an untested station); otherwise cap by the oldest in-use entry's own age on the same curve. Minimum: drop the "leans on current physiology" line when every calibrated station is dated by its own entry. Should the cap go per entry?

(c) **Provenance copy not finished** (review issue 2). The "population average(s)" strings are gone, but these seed labels still say "population" without naming the source: the benchmark card count line "All stations use population estimates." and "N stations still using population estimates." (`benchmark-card.ts:92-93`), station detail "Population estimate for the pair" and "Population estimate" (`station-detail-view.ts:167-168`) and "Solo population estimate" (`:230`), the Stats ledger's "Population est." (`stats-view.ts:434`, `:480`), and the chip detail Stations subhead "Personal anchors vs population seeds" (`forecast-chip-detail-view.ts:441`). Reviewer's fix: "Band median" as the label with a caption naming the HYROX results, as the run-pace seed now reads, or record why a site is skipped.

(d) **Station test loads and the Pro toggle** (review issue 3; implementer's question). (1) A woman on Pro Doubles with "Calibrated at Pro weights" on reads "Test at Men Open loads: 152 kg incl. sled." with no reason; only the Mixed woman is told why. Reviewer's fix: "Women Pro loads (the Men Open weights)". (2) `entryIsPro` (`race-prediction.hyrox.ts:410`) honours `benchmarksAtProWeights` for any target, but the toggle renders only for Pro formats (`stats-view.ts:277`): a toggle left on after the target moves to Open Doubles makes a women's pair's modal say "Men Open loads", and the athlete cannot turn it off (lane H3b behaviour the modal now shows). Fix: clear the toggle when the target leaves the Pro family, or show the toggle while it is on. (3) The toggle restyles in place without re-rendering (`stats-view.ts:338-355`, whose comment says nothing else on the page reads the flag), but the Benchmarks rows and their "Converted to race weights" note read it through `resolveHyroxStationBenchmarks`, so they are stale until the page re-renders. (4) Pro tests default to Open loads unless the toggle is on (lane H3b's convention), so the modal tells a Pro Doubles man to test at Men Open loads with a pointer to the toggle. Should Pro tests default to Pro loads? That is a model change to `entryIsPro`, not copy.

(e) **Band-median seeds at a band edge** (implementer's question). A Pro Singles man who raced 1:20:00 is 1:16:47 in Open Singles terms (docs-pass probe), under the Open Singles men's advanced cut-off of 1:18:28, so he plans advanced (intermediate under lane H3b) and seeds from the advanced medians: his no-test forecast reads 1:14:21, faster than the race he ran (implementer's probe, confirmed by the reviewer; 1:16:21 with VDOT 48 and the race-anchored run offset). The reviewer measured an Open man at 1:18 forecasting 1:11:40 under lane H3b too, so the cause is band width, not the conversion. Options: read seeds at the athlete's own percentile in the planning field instead of the band median; anchor the forecast more strongly on the race; keep.

(f) **Doubles calibration CTA** (implementer's question). "Test your stations" shows when every station is converted (`calibrationBannerCtaLabel`, `forecast-view.ts:466`). Under the confidence-cap rule (option A, ISSUE-395 (a)), solo tests never lift a doubles target above medium; only the pair's own race splits do, and the banner body says so. Keep the label, or drop the CTA or send it to logging a doubles race (lane H3b product reviewer's fix)? Logging is offered only when no previous time is on file (ISSUE-395 (e)).

(g) **Merged into ISSUE-397 (a)** (`bandFromVdot`, one VDOT scale for both sexes; raised in lanes H3b and H3c).

(h) **An undated race split never decays** (implementer's question). Race splits keep the race-age weight, and a race with no date is 'unknown' (weight 1). Its history entry carries the log date, not race day, so the per-entry rule does not use it. Accept, or decay from the log date?

(i) **Planning band from the field's split pattern** (implementer's question; §DL limitation 1). The conversion gives the athlete the race field's average composition at their percentile, not their logged splits, so the band is a function of the finish alone and every band writer agrees. Logged splits would personalise it, but setup would then disagree with the initializer until splits are known. Keep?

Comment fixes, no decision needed: (1) review issue 4: the farmers carry range in the `hyrox-doubles.ts:36` comment reads "0.74 to 0.84"; the S8-S9 medians give 0.7389 to 0.8346 (the upper end is the Mixed man against men's singles), so it should read 0.83 (checked at `5068d8b`; the comment and tables are unchanged at `d8432d2`). (2) The `doublesTotalInSinglesTermsSec` comment (`hyrox-doubles.ts:218`) still says it is kept for `hyroxBandingTimeSec`, which lane H2 deleted; its live caller is the improvement ceiling (`race-projection.hyrox.ts:400`).

> **2026-10-13, HYROX lane H3b (the real S8 to S9 results wired in): open questions (ISSUE-397).** Raised in the implementer and reviewer reports for `fix/hyrox-h3b` (merged in `ee19331`; CHANGELOG 2026-10-13; SCIENCE_LOG §DK). Lanes H3c (`d7bc44b`, §DL) and H2 (`d8432d2`) answered several of them in code; those are listed, not re-asked. Notes added to ISSUE-395 and ISSUE-390. None of the lane-H3b changes is marked fixed: they are unit-tested, not device-verified (`docs/DEVICE_TESTS.md`).

### ISSUE-397: HYROX lane H3b open questions *(P3, 2026-10-13, needs Tristan's decisions)* — OPEN

(a) **`bandFromVdot` is one scale for both sexes, mirroring the global finish scale** (`hyrox-staleness.ts:58`: VDOT 60 / 53 / 45 / 38 / 30; raised in lanes H3b and H3c, merged here from ISSUE-398 (g)). It picks the band the stale-race seed blend leans toward (`race-prediction.hyrox.ts:599`), the initializer's staleness re-band (the slower of the time band and the VDOT band, `initialization.hyrox.ts:194-196`) and, since lane H2 (`d8432d2`), the band of a first-timer with a real running signal (`firstTimerBand`, `initialization.hyrox.ts:77`, capped at intermediate). Bands are now positions in the athlete's own-sex Open Singles field (lane H3c), so for a woman the VDOT band and the time band answer different scales, and she reads a band low by VDOT. Re-express it per sex, or keep it as an aerobic-capacity proxy? A per-sex scale needs a sourced VDOT-to-finish mapping, which the codebase does not have: do it, and from which source?

(b) **The improvement ceiling never binds.** Modelled race-day gains are 1.0 to 2.8% (implementer's probe), while the repeat athletes' median gain at the shortest window is 3.6% for Open Singles women intermediate and 4.5% for Open Singles men novice (`HYROX_S79_IMPROVEMENT`, mean of races, gap 1), and the ceilings run 5.9 to 11.3%. So typical projections sit in the conservative half of what the data shows, against the standing rule to aim at the optimistic end of defensible. Options: add a data floor (for example the cell median, net of the documented field drift of +12 to +149 s a year), or accept and record it. Related: any horizon up to 39 weeks reads the 6-month cell (`hyroxImprovementGapFor`), the optimistic end; interpolating toward zero would be an invented shape.

(c) **Mixed Doubles assumptions now in code; confirm.** (1) A previous doubles race is taken to be in the current division (no previous-race division is stored), as the band paths already assumed. (2) A Mixed pair with no biological sex on file stays Open (pooled tables, no Pro-tier conversion). (3) A station test's load family follows the format it was logged under (`entryIsPro`, `race-prediction.hyrox.ts:410`): tests a Mixed woman logs under Open Doubles are read at M-Open, tests under Open Singles at W-Open, and a race split with no weight record or a slot value with no entry stays Open. Since lane H3c the test entry modal names the loads to use (`hyroxStationTestLoadTier`, `:429`).

(d) **Goal back-calculation floors are not cohort-aware.** `hyrox-goal-back-calc.ts:89` and `goal-modal.ts:82` floor each station at the pooled Open Singles competitive seed × the line's team ratio. With real data that seed is the median split of the pooled field's top 1%. For a Pro target it sits below the converted seed on every loaded station; for a woman it differs station by station (pooled sled push 135 s against the women's 126 s, pooled SkiErg 248 s against 281 s). It is a lower bound, so the main effect is a looser feasibility check. Options: read `hyroxStationSeedsAtTarget(state, 'competitive')`, or keep it.

(e) **Session-best floor strictness.** The floor is now the station split's timing-slip fence in the athlete's singles field (`hyroxStationLowerFenceSec`; Open Singles women: wall balls 87 s, sled push 54 s). It catches format slips (2 s for 2:56) but accepts any round above the fence, however unlikely. Keep it, or add a plausibility check against the athlete's own history?

Answered in code by lane H2 (`d8432d2`), not re-asked here: the onboarding initializer banding on the global scale (it reads `hyroxPlanningBandFor` with the athlete's doubles tables, `initialization.hyrox.ts:144`, `:287`, `:290`, and `hyroxBandingTimeSec` is gone), and the generator version and the generators' own seeds (`HYROX_GENERATOR_VERSION` 18, `plan_engine.hyrox.ts:284`; existing plans regenerate on launch through `applyHyroxGeneratorRegen`, `src/main.ts:913`; the run, station, brick and assessment generators read `hyroxStationSeedsAtTarget` and `hyroxSeedRunPaceSecKm` for the athlete passed as `seed`). Answered in code by lane H3c (§DL): Pro fields banded lower under field-relative planning bands (one planning field, Open Singles at the athlete's sex); the seed field for a self-reported Pro band; fresh station tests decaying by the race's age; two finish percentiles on adjacent tabs (the "Where you sit" total row names its cohort); the banner CTA "Calibrate the rest" when every station is converted ("Test your stations"); the Stats ledger saying nothing when a row is converted to the race's weights ("Converted to race weights"); the test entry modal naming no loads; the Field rank bar drawing a bound as a point; the loose run-pace seed copy ("Population average"); the doubles-ratio ranges in code comments. Lane H3c's own follow-ups are tracked with lane H3c.

> **2026-10-13, HYROX lane H3a (seasons 7 to 9 results ingest): open questions (ISSUE-396).** Raised in the implementer and reviewer reports for `fix/hyrox-h3` (H3a, merged in `3e4b08d`; CHANGELOG 2026-10-13; SCIENCE_LOG §DJ). Note added to ISSUE-395. Nothing in lane H3a is marked fixed: the tables are unit-tested and have no user-facing surface at `3e4b08d`.

### ISSUE-396: HYROX lane H3a open questions: results licence, re-ingest and hygiene edge cases *(P2, 2026-10-13, needs Tristan's decisions)* — OPEN

P2 because of (a): the app ships, and since lane H3b shows, numbers derived from this dataset. The rest is P3.

Already decided, not re-asked: lane H3b's brief chose the seasons 8 and 9 tables for percentiles, seeds, band thresholds and conversions and the pooled S7 to S9 tables for age groups (decision 1), and treats Pro Doubles mixed rows as data errors (decision 3). Lane H3b added field-relative band thresholds (`HYROX_S89_BAND_THRESHOLDS_SEC`, `hyrox-results-s79.ts:1420`) and an improvement ceiling read from the mean-of-races cells, which answers the implementer's band and improvement-calibration questions. Lane H1 corrected the old percentile docstring in `8352d0e` (see (j)).

(a) **Licence for commercial use.** The source is the Kaggle dataset "HYROX Race Results, Seasons 7-9 (Anonymised)" by Tanvi Jivani, built from public HYROX results with pyrox-client. pyrox-client's MIT licence covers the client code. The dataset's Kaggle licence is listed as "Other", and the results are not licensed by HYROX (`scripts/ingest-hyrox-results-s79.py:5-9`, `src/data/hyrox-results-s79.ts:4-7`). Only aggregate tables ship. No report records a decision. Question: does the "Other" licence (and HYROX's terms for its public results) allow derived aggregates in a paid app? Options: read the licence text on the Kaggle page and record it in the script docstring; ask the dataset author; ask HYROX; or keep the S4 to S6 tables (§R) until cleared. Decide before the public launch.

(b) **Re-ingest needs a fresh download.** The 2026-10-13 copies of `hyrox_results_anonymised.parquet` and `repeat_athletes.csv` are gone. The script names the dataset and the two files (`:5-16`) but has no download link or dataset version, and a fresh download may be a newer version with different counts. The provenance test pins `HYROX_S79_LAST_REFRESH_DATE` = '2026-10-13' (`hyrox-results-s79.test.ts:137`) and the smoke tests pin three medians (`:569`, `:574`), and since lane H3b a regeneration changes the tables the app reads. Options: add the Kaggle link, the version and a file checksum to the script docstring; keep a private copy of the two files outside the repo; or accept a fresh download and re-check the tables on each refresh.

(c) **The one-dominant-segment rule may drop genuine slow finishers.** An above-fence total is kept only when no segment exceeds the cell's far-out share fence, fitted on mostly sub-2 h finishers (script `:559-572`, check `:618-623`). Reviewer's probe at `7cf2c1d`: 51 of the 88 rows it drops look like genuine slow finishers (2.8 to 5.4 h, share under 0.4, mostly wall balls); among singles finishers between 3 h and the fence, p99 share is 0.28 to 0.31. Effect: p99 totals read 0 to 24 s fast (Pro Singles women 9450 against 9474 s; Open women 10265 against 10275 s), p95 7 s or less, medians unchanged. The header says genuine slow finishers are slow throughout (`hyrox-results-s79.ts:58-59`). Options: fit the share fence on slow in-fence rows (above the cell's p90 total); limit the rule to totals where the over-7 h evidence applies; or keep it and correct the header to say p99 totals may read up to about 24 s fast.

(d) **R5 drops cluster at a few doubles events.** Reviewer's probe at `7cf2c1d`: Open Doubles rows dropped at S7-2025 Manchester 736 of 2,199, Toulouse 897 of 2,664, Auckland 426 of 1,640, Guadalajara 148 of 643, with residuals just past the 17 s bound (median −24 to −34 s, which points to a timing offset), and the dropped rows slower than the kept ones (Manchester 79:48 against 77:53). Pooled tables move 1 s or less, but the Open Doubles women's S7-2025 to S8-2026 same-venue shift reads +149 s against +130 s with those totals kept (men +64 against +54), and +149 s is the upper end of the drift range in the improvement header. Options: send R5-inconsistent rows whose total sits inside the fences to the total tables only (R6 already trusts the start and finish mats for missed-mat rows); or keep the rule and caveat the drift figure.

(e) **Two single-result values ship.** `HYROX_S79_INGEST_REPORT.keptAboveFenceMaxTotalSec` (21735, `hyrox-results-s79.ts:170`) and `droppedAboveFenceOneSegmentTotalRangeSec` ([10109, 107488], `:171`) are each one athlete's finish time, printed in the header too (`:61-62`). Neither identifies anyone alone; the lane's rule is aggregates only. The test that reads the first (`hyrox-results-s79.test.ts:195`) is weak: its bound is already the largest fence hi, 13,964 s. Fix: drop the two fields or replace them with counts or coarse buckets, and bound each cell's top breakpoint by its own fence or a published high percentile.

(f) **Fences published for the withheld cell.** `HYROX_S79_TOTAL_FENCES_SEC.pro_doubles.mixed` (`:190`) publishes lo 2372, hi 8655 and maxSegmentShare 0.228, quantile values from 39 rows, under the 119-row minimum. Lane H3b never selects that cell (decision 3), and its station-fence export already leaves withheld cells out. Fix: omit withheld cells from the fences export, or emit their row counts only.

(g) **"Current judging" is inferred.** The S8 and S9 set exists because wall balls (+30 to +33 s) and sled push (+13 to +20 s; Pro Singles +29 to +40 s) step up at the same venues from S7 to S8 (`HYROX_S79_SAME_VENUE_SEASON_SHIFT`, `:916`). The module header attributes this to an S8 judging change (`:80-85`); nobody checked a rulebook. S7 is 2024/25, so the Women Open 75-to-100 rep change (§DG) predates the step, and Open men's wall balls step by +33 s too. Drift continues: Open women's wall balls +14 s and total +65 s from S8-2025 to S9-2026, so the set describes the recent field and keeps moving. Options: confirm the 2025/26 wall-ball and sled standard change in the rulebooks and cite it in the script; or reword the header and constant comment (`CURRENT_JUDGING_SEASONS`, script `:128-132`) to "recent field" and drop the attribution.

(h) **Cross-label copies: confirm the hybrid.** R3b resolves a set of identical-timing copies by a sign test on work-to-run votes (Mechelen 2026: 520 Pro Doubles copies dropped, the Pro Singles results kept; `HYROX_S79_CROSS_LABEL_RESOLUTIONS`, `:178`) and drops both copies of an isolated pair (136 rows). The final reviewer confirmed the Mechelen call (copies' ln(work/run) median −0.027, Pro Singles −0.03, Pro Doubles −0.341; reviewer's probe). Alternatives the first review offered: always keep the singles copy (about 3 doubles-looking pairs would land in singles, implementer's probe), or drop every copy (removes 520 genuine, slower-than-median Pro Singles results). The isolated-pair drops pushed the Taipei S7-2025 Pro men cell to 117 rows, under the normaliser's 119, which removed 44 repeat athletes from the improvement tables (implementer's and final reviewer's probes). Confirm the hybrid or pick an alternative.

(i) **Doubles age bands.** Doubles age tables use 10-year bands (16-29 to 70+) so S7, which used 10-year codes, can be pooled; S8 and S9 use 5-year bands (`HYROX_S79_AGE_GROUPS`, `:668`). The dataset carries one age label per team, and how HYROX assigns it cannot be checked from the data. Lane H3b ranks doubles athletes on these tables with the note "Age group from your age; doubles age groups go by the pair." (`src/ui/hyrox/stats-view.ts:182`). Keep the pooled 10-year bands, or switch doubles to 5-year bands from S8 and S9 only (smaller cells)?

(j) **Stale header sentence (defect, no decision needed).** The module header says the old data file's doc comment reads "slower than or equal" (`hyrox-results-s79.ts:24-26`, written by `ingest-hyrox-results-s79.py:1284-1287`). Lane H1 corrected that comment in `8352d0e`, before H3a merged: `hyrox-population-distributions.ts:68-70` reads "at or faster". Fix in the script and regenerate, together with (c) to (g).

> **2026-10-13 — HYROX lane H1 (26/27 rules, divisions, doubles forecast, labels, 2027 calendar): open questions (ISSUE-395).** Raised in the implementer and reviewer reports for `fix/hyrox-h1` (merged in `8352d0e`; CHANGELOG 2026-10-13; SCIENCE_LOG §DG to §DI). Notes added to ISSUE-195, ISSUE-390 and ISSUE-391. None of the lane-H1 changes is marked fixed: they are unit-tested, not device-verified (`docs/DEVICE_TESTS.md`).

### ISSUE-395: HYROX lane H1 open questions *(P3, 2026-10-13, needs Tristan's decisions; several pre-existing)* — OPEN

The S7 to S9 results re-ingest is under way in lane H3: H3a merged in `3e4b08d` (about 1.16 million results, per-division, sex and age tables in `src/data/hyrox-results-s79.ts`), not yet read by any consumer; lane H3b wires it. It is expected to address (g), (h) and (i), and the pooled-sex and 75-rep-era caveats on every HYROX caption.

**Note 2026-10-13 (lane H3b, `ee19331`):** the S7 to S9 tables are wired: every finish and station percentile, the doubles mapping, the seeds and the Open-to-Pro conversion read them through `src/calculations/hyrox-results.ts` (SCIENCE_LOG §DK), and the captions are by sex or division in the 100-rep era, so the pooled-sex and 75-rep-era caveats are gone. (g) is addressed in code (note below); (h) and (i) are untouched. H3b's own open questions are ISSUE-397.

(a) **Confidence-cap scope** (§DH limitation 6). A converted station caps confidence at medium (`race-prediction.hyrox.ts:727`), but which values count as converted depends on the slot. For a doubles target a singles-slot value is capped, while a solo test or session best in the doubles slot goes through the same × station ratio and is not: Open Doubles with a venue and 8 solo half tests in the doubles slot reads high, the same 8 times in the singles slot read medium. Option A: cap every station the doubles forecast scales by the ratio, so only the pair's own race splits reach high. Option B: keep the slot rule as a recorded limitation.

**Note 2026-10-13 (lane H3b, `ee9e742`, `0ae4c96`):** the code now does option A, chosen in the lane brief (decision 10, an orchestrator decision; no report records Tristan's own). For a doubles target every calibrated value except the target family's own doubles race splits caps confidence at medium: singles values, the doubles slot's solo tests and session bests, and doubles race splits from the other weight family (`race-prediction.hyrox.ts:478`). A singles target is capped by any doubles race split. The banner names the source and says only doubles race splits replace the converted times. Tests in `race-prediction.hyrox.test.ts` and `ui/hyrox/doubles-stations-caption.test.ts`. Confirm A, or revert to B. Not marked fixed.

(b) **Stale-race caption contradicts itself** (pre-existing copy, now in `hyroxConfidenceCaption`, `forecast-view.ts:441`). When race-age staleness caps confidence at low, the caption reads "Mostly seed data. Only 8/8 stations calibrated. Best treated as a rough benchmark." for a fully calibrated forecast (reproduced: Open Singles, 8 doubles splits, a venue, a 20-month-old race). Reviewer's fix: use the seed-data sentence only below 3 calibrated stations, otherwise name the race age.

**Note 2026-10-13 (lane H3b, `71f85dc`, `a4db61f`):** the caption now follows the reviewer's fix: below 3 calibrated stations it keeps the seed-data sentence; a race-age cap to low at 3 or more reads "8/8 stations calibrated. The race is 20 months old, so confidence is low."; at 6 or more a medium forecast names the missing venue or the race's age ("The race is 9 months old, so confidence is medium."), never "Calibrate more"; and the banner hides when all 8 stations are calibrated and none converted (`hyroxConfidenceCaption`, `forecast-view.ts:479`; tests in `ui/hyrox/doubles-stations-caption.test.ts`). Not device-verified.

**Note 2026-10-13 (lane H3c, `3162847`):** station tests and session bests now decay by their own date, while confidence and this caption still follow the race's age. A forecast with 8 fresh tests beside an 18-month-old race therefore reads "8/8 stations calibrated. The race is 18 months old, so confidence is low." although every station counts in full. Tracked as ISSUE-398 (b).

(c) **Pro target, untested stations disagree across surfaces** (pre-existing). Stats shows the Open-weight band seed as "Population est." and the generators prescribe that seed at Pro loads, while the forecast row uses seed × `HYROX_PRO_STATION_MULTIPLIER` (`seedAtTarget`, `race-prediction.hyrox.ts:351`): up to 15% apart on the sleds. Fix: expose the forecast's seed at target weights per station for the Stats seed row and the generator fallback (needs a `HYROX_GENERATOR_VERSION` bump).

**Note 2026-10-13 (lane H3b, `f4b7bf7`, `0ae4c96`):** untested stations now read one seed at the target's weights on every surface: the forecast, the Stats ledger, the station detail page, the benchmark card and the plan (`hyroxPlanningStationBenchmarks` returns all 8 stations, `race-prediction.hyrox.ts:769`), and the Pro step is the per-station, per-sex conversion, not `HYROX_PRO_STATION_MULTIPLIER`. At this merge the week-1 assessment and the run-pace fallbacks still read the Open Singles pooled seeds; lane H2 (`d8432d2`) points them at the same seeds and bumps `HYROX_GENERATOR_VERSION` to 18.

(d) **History views mix the pair's time with solo times, and Pro with Open weights.** Race splits now land in `stationBenchmarkHistory`, so on a doubles plan the station detail Best, Latest, Since first test, sparkline and PR badge, and the chip detail history, compare the pair's race split with one athlete's tests (rendered probe: "Best 4:40" on a 280 s pair's split beside "Latest 5:00", a solo test far better than the split's solo equivalent). A Pro split shows tagged "· Pro weights" while Stats shows its Open equivalent. Fix in one place: compare history in solo terms at the target's weights, or keep race splits apart from solo entries. Related: should a Stats row converted from the other weight regime say so (a 4:20 Pro split shows as 3:46, captioned "Calibrated")?

**Note 2026-10-13 (lane H3b, `ee9e742`, `71f85dc`, `0ae4c96`, `a4db61f`):** history views now show one frame per card. Station detail reads every entry of every format as one athlete at the race's weights (`hyroxStationHistoryInTargetFrame`, `race-prediction.hyrox.ts:524`), tags rows by source and format, and labels the frame once; the chip detail per-station card reads PRs and the re-test delta in the row's terms (the pair's time for doubles), labelled once. The related question (should a converted Stats row say so) is answered in code by lane H3c's "Converted to race weights" note (§DL). Not marked fixed.

**Note 2026-10-13 (lane H3c, `a8e1d29`):** the related question is answered for the Stats ledger: a row whose stored time crossed load families to reach the target's weights carries "Converted to race weights" (`HYROX_LEDGER_LOAD_NOTE`, `stats-view.ts:504`; loaded stations only). The history views moved to one frame per card in lane H3b (note above).

(e) **Race identity for a re-logged race.** `upsertRaceSplitEntry` (`hyrox-station-history.ts:66`) dedupes by entry date and format: an undated race re-logged on a later day, a corrected date, or a re-log with fewer splits leaves stale entries or slot values. Unreachable today, because the only entry to the log modal (`hx-cd-log-prev`, `forecast-chip-detail-view.ts:186`) shows only when no previous time is on file. Decide before any "edit previous race" UI ships: does a log edit the previous race (replace every entry with its id, clear stations the new log omits) or record a new race (keep the old one's history)?

(f) **Fresh half test × 2 with no fade.** The benchmark card doubles a half-distance test into the full-station benchmark (`benchmark-card.ts:193`) with no fresh-to-race fade. No fade constant exists in the code, the research files or the results tables (which have no fatigued per-station splits); a sourced per-station number is needed. See ISSUE-195.

(g) **`HYROX_PRO_STATION_MULTIPLIER` is unsourced and one set for both sexes** (`hyrox-constants.ts:38`; sleds 1.15, other loaded stations 1.08). Set from the men's Open-to-Pro jump; the women's jump is larger in relative terms (sled push +49% against +33%, sandbag +100% against +50%). Since `9acc3f0` it also converts cross-regime race splits for plan targets and Stats rows, not only the forecast. Replace from per-station, per-sex Open and Pro results.

**Note 2026-10-13 (lane H3b, `ee9e742`):** replaced in code by a per-station, per-sex difference in differences on the S8 to S9 Pro and Open singles results (`hyroxProConversionAt`, `hyrox-results.ts:583`). At the median women's sled push converts × 1.573 and men's × 1.405 (was 1.15 for both). The table stays as a fallback for an adjusted ratio below 1, which no loaded station reaches (lowest 1.006, men's sandbag lunges near p2). Not marked fixed.

(h) **`HYROX_DEFAULT_LOAD_TIER` = M-Open** (`hyrox-division.ts:40`), the tier with no biological sex and no division pick (pre-division saved states; a HYROX brick from another mode with no sex on file). The middle tier, so at most one tier off. Pre-division states with a Pro target and unknown sex load sessions at M-Open (the Women Pro load) while their session bests are saved as Pro times. Confirm M-Open or pick another.

(i) **Re-check `HYROX_MTL_CAP` after the tier change** (`hyrox-constants.ts:168`). MTL external load moved: men's Open sled push 50 to 76 kg and pull 40 to 51.5 kg; women's Open farmers 24 to 16 kg, sandbag 20 to 10 kg, ball 9 to 4 kg. The caps were never validated; re-check after dogfooding.

(j) **Existing doubles athletes** keep the band the old rule gave them (doubles terms, often one band fast) until they re-log a race or re-onboard, and a personal run-pace offset computed under the old doubles model stays frozen (the refresh skips a set offset) and decays over 12 months. Re-band and reset them at launch? That regenerates plans, so it belongs with lane H2's `HYROX_GENERATOR_VERSION` bump.

**Note 2026-10-13 (lane H3b):** the question now covers more athletes. Field-relative bands (lane H3b) and the planning band (lane H3c, §DL) place women and Pro athletes differently from the global scale, while every existing athlete keeps the band set at onboarding until a race is re-logged or the previous format corrected. No launch path re-bands: lane H2's version-18 regeneration on launch (`applyHyroxGeneratorRegen`) rebuilds sessions at the stored band.

(k) **Setup hours slider keeps the time-entry band.** `setupBand` (`hyrox-setup.ts:64`) converts a doubles time once the previous race's format is picked, but the previous-format and target-format toggles never rescope the hours slider, which is scoped at time entry before the format row appears (a 1:19:07 doubles time scopes "advanced", max 16 h, against "intermediate", max 14 h). The plan band and the sessions and plan-week defaults are right; only the slider range is stale. Fix: one rescope helper called from the time input and both format toggles.

**Note 2026-10-13 (lane H3c, `3b4203a`):** `setupBand` is now at `hyrox-setup.ts:56` and reads the planning band (`hyroxPlanningBandFor`). Before the previous format is picked it reads the time as an Open Singles finish on the athlete's own-sex field (was the global 60/80/100/120-minute scale). The rescope gap remains: the previous-format, division and target-format toggles (`hyrox-setup.ts:455-500`) never rescope the hours slider. New example (docs-pass probe at `5068d8b`): a woman typing 1:30:00 scopes intermediate (max 14 h; above the women's advanced cut-off of 1:26:28); picking Pro Singles makes the planning band advanced (1:26:08 in Open Singles terms, max 16 h), and the slider keeps 14 h. The 1:19:07 example above still holds for a Mixed pair with no biological sex on file (advanced at entry on the pooled field, intermediate once Open Doubles is picked). Unchanged at `d8432d2`: lane H2 did not touch `hyrox-setup.ts`, and since its initializer reads the planning band, the woman's plan above initialises advanced while her slider still stops at 14 h.

(l) **Docs outside `docs/`.** CLAUDE.md's "Visualisations of real data" rule still gives "Live HYROX field. 89,868 finishers across S4–S6" as the correct subtitle; the code now uses `hyroxPopulationCaption` and a guard test blocks the hardcoded count. The docs pass could not edit CLAUDE.md.

**Note 2026-10-19 (docs pass for lanes H3a to H3c):** still open. CLAUDE.md's "Visualisations of real data" rule still gives "Live HYROX field. 89,868 finishers across S4–S6" as the correct subtitle and still cites "a 89,868-finisher Kaggle ingest"; the docs pass does not edit CLAUDE.md. Since lane H3b the code's caption is `hyroxResultsCaption` (`src/calculations/hyrox-results.ts:345`), for example "HYROX results, seasons 8 and 9 (2025 to 2026), 119,468 Open Singles women finishers, via the open pyrox project.", and the guard test (`hyrox-population-captions.test.ts`) blocks 89,868 and each S8 to S9 pooled count in app code under `src` outside the two data files. That caption is the replacement for the rule's example; UX_PATTERNS "Population Distribution Charts" already carries it.

Not implemented on purpose: World Championships Pro loads. The 25/26 Singles rulebook and the hyroxus.com FAQ say under-60 Open qualifiers race Pro weights at Worlds; the 26/27 rulebooks do not restate it. Confirm the 26/27 rule before coding it.

**Note 2026-10-13 (lane H3a, `3e4b08d`):** the S7 to S9 tables hold per-station splits per format and sex for Open and Pro (`HYROX_S79_PERCENTILES`, `HYROX_S89_PERCENTILES`), the input (g) asks for. The ingest's own open questions (licence, re-ingest, hygiene edge cases) are ISSUE-396.

> **2026-10-12 — Fitness model (lane v): follow-ups (ISSUE-387 → 394).** Raised in the implementer and reviewer reports for `fix/lane-v` (merged in `33052a8`, plus `5795c3f`; CHANGELOG 2026-10-12; SCIENCE_LOG §CY update, §DA to §DE). Each is an open question for Tristan, a default the orchestrator took under his delegation for him to confirm, or a defect found next to the changed code; several are pre-existing. Notes added to ISSUE-359 and ISSUE-372 to ISSUE-377. None of the lane-v changes is marked fixed: they are unit-tested, not device-verified (`docs/DEVICE_TESTS.md`).

### ISSUE-387: PB ageing can make a prediction faster *(P2, 2026-10-12, needs Tristan's decision, mirror rule)* — OPEN

(a) **Triathlon**: the 70.3 race-day run leg gets faster as a half PB ages (half 1:30, typed 25 km: 5298 s at 0 days, 5285 s at 800, 5272 s at 2000; about 0.02 s a day since `s.lt` is unrounded). `computeRaceTime` (`race-prediction.triathlon.ts:837-846`) divides the projected run VDOT, grown from the engine (floored at full PB capacity), by `cv(runDist, blendedOpenSec)` of the aged run blend: the slower the blend, the larger the ratio, and the time falls. Implementer's proposal, no new constant: `horizonRatio = projected / current baseline VDOT`, which is what the ISSUE-188 comment there says the ratio is. It changes nothing at age 0 in this case, adds about 2% (+107 s) at 800 days, and changes triathlon run legs wherever the engine differs from the run-leg blend's VDOT. (b) **Running mirror** (review): a single short PB gives a faster long-distance prediction as it ages (5K 20:00, marathon target, typed 30 km: today's time 12689.9 s at 0 days, 12627.0 s at 3000). (c) **Drifting-engine residual**: with a dated 10K beside an undated marathon PB the forecast falls about 0.0007 s a day (1.5 s over 8 years), because today's time stays on the undated PB while the engine falls and the horizon delta `tv(v) − tv(v + gain)` (`predictions.ts` `calculateLiveForecast`) grows as `v` falls. Option: compute the delta at the anchor's own VDOT, which changes forecasts wherever the engine and the anchor differ. Decide (a) and (b) together.

### ISSUE-388: The Ironman marathon-depth credit ages the marathon PB outside the run model's gate *(P3, 2026-10-12, needs Tristan's decision)* — OPEN

`computeMarathonDepthMultiplier` (`race-prediction.triathlon.ts:1667`) and its drill-down label (`forecast-chip-detail-view.ts`) call `pbAgeWeight(state.onboarding?.pbDates?.m)` directly, with no measured-volume gate (§BV) and no date-ownership check, while every run-model weight goes through `modelPbAgeWeightsIfMeasured` and `pbAgeWeightsFor`. Measured (modes review, Ironman, marathon PB 3:15, run skill 3): with no running volume `s.v` is 48.68 dated or undated, as the gate intends, but the run leg reads 12542 s with the PB dated 1500 days against 12320 s undated, and no caption shows; a synced faster marathon inherits the old onboarding date. The PB-age caption's counterfactual still carries the credit's ageing (typed 30 km, 1500 days: 12543 s aged, 12597 s with ageing suspended, 12374 s undated), and there ageing makes the leg faster, because the credit and the blend move in opposite directions (see ISSUE-387). Since 2026-10-11 PBs under 2 years age too (1 year 0.79, was 1.0 under the §T5 bands). Option: route the credit through `modelPbAgeWeightsIfMeasured`; it changes Ironman run legs for dated marathon PBs with no measured volume.

### ISSUE-389: Race-anchor gates still switch off on a race's first anniversary *(P3, 2026-10-12, needs Tristan's decision)* — OPEN

`RACE_VDOT_ANCHOR_MAX_AGE_DAYS` = 365 (`physiological-vdot.ts:79`: the race-validated run VDOT tier and the §CC engine floor and cap) and the race bike-speed anchor (`raceBikeAnchorKph`, `race-prediction.triathlon.ts:1235`, `ageDays > 365`) decide which source sets the run VDOT or the bike speed, and stop on the day a logged race turns one year old, so a triathlete's forecast can jump that day. A separate rule from the PB-recency factor, which is continuous since §DE. Options: blend the race and the next source by a continuous weight, or accept.

### ISSUE-390: HYROX run pace rounded inside the model; stored HYROX labels not regenerated *(P3, 2026-10-12)* — OPEN

(a) `derivePopulationRunPace` and `deriveHyroxRunPace` round the pace with `Math.round` (`hyrox-run-pace.ts:189`, `:227`). As `s.lt` drifts with PB age, the run pace ticks by 1 s/km, about 8 s on an 8 km HYROX run total overnight: the defect class `0b55382` fixed for `s.lt`. Keep the model value unrounded and round at display? (b) HYROX generator run labels carry the minute since `ced8427`, but `HYROX_GENERATOR_VERSION` was not bumped (still 17), so a stored HYROX plan keeps any old ":60" label until its next regeneration. Bump it?

**Note 2026-10-13 (lane H1, `8352d0e`):** `HYROX_GENERATOR_VERSION` is still 17. Lane H1 also changed generator output (station MTL follows the athlete's load tier, wall balls read "100 reps", station target times read `hyroxPlanningStationBenchmarks`, the station time formatter carries the minute) without a bump; lane H2 is to bump it for both lanes (ISSUE-395 (j)). Part (a) is unchanged: `derivePopulationRunPace` and `deriveHyroxRunPace` still round, now after the doubles run ratio.

**Note 2026-10-13 (lane H3b, `ee19331`):** lane H3b also changed generator output without a bump (plan targets for untested stations, the pooled seed tables' values). Lane H2 (`d8432d2`) bumped `HYROX_GENERATOR_VERSION` to 18, so stored plans regenerate on launch (`applyHyroxGeneratorRegen`, `src/main.ts:913`), which answers part (b) in code; part (a) is unchanged.

### ISSUE-391: Time and pace formatters outside the model-pace rule can show ":60", and two surfaces round one race time differently *(P3, 2026-10-12)* — OPEN

(a) **Actual-activity paces** (implementer): formatters that round the seconds without carrying the minute read an actual 4:59.6/km as "4:60/km", for example `fmtPace` in `src/ui/activity-detail.ts:55-61`, the strava-detail pace formatter (`strava-detail.ts:269`), `fmtPace` in `src/calculations/workout-insight.ts:45` and the HYROX Stats pace formatter (`src/ui/hyrox/stats-view.ts:220`). They were left alone because they are not model paces. (b) **Race times** (found while writing the lane-v docs, read in code, not measured): the Stats "Current Race Estimates" card formats `predictStandardDistances` with its own `fmtTime` (`stats-view.ts:3252-3258`), which rounds the seconds without carrying the minute, while the Forecast tiles use `ft` (`format.ts:20`), which floors. `predictStandardDistances` returns fractional seconds (a 5K of 1639.5 s in the review's probe), so the two surfaces can show one prediction 1 s apart, and the Stats card can read "22:60" for 1379.6 s, the defect `1f9bf0a` fixed in the session generator's `fmtTimeSec`. The forecast-progress formatters at `stats-view.ts:3162` and `:4145` share the pattern. One race-time formatter that rounds once before splitting, used by every surface?

**Note 2026-10-13 (lane H1, `50ab879`):** the HYROX Stats pace formatter in (a) now goes through `fmtModelPaceKm`, and the HYROX Stats Benchmarks card, the goal modal and the HYROX workout detail target column format times through the new `ftRounded` (`src/utils/format.ts:38`: nearest whole second, then the `ft` split); the station detail page's own formatter rounds first (`10aa61d`). A source scan (`hyrox-time-format-guard.test.ts`) covers `src/ui/hyrox` only. The non-HYROX formatters in (a) and (b) are unchanged. Not marked fixed.

### ISSUE-392: Cycling onboarding runs no launch refresh *(P3, 2026-10-12)* — OPEN

`initializeCyclingSimulator` never calls `refreshBlendedFitness`, so a cycling athlete keeps the store defaults (`s.v` 50, `s.lt` null, the default `s.pac`) until the first launch (modes review: `s.v` 50.977 and `s.lt` 256.6 after it). No cycling surface shows them (the LT bar and running VO2 row are gated by `isCyclingOnlyMode`, `fitness-detail-view.ts:302`, `:390`; the triathlon Forecast caption at `forecast-view.ts:90`), and the plan holds no run sessions, so nothing visible is wrong. Comments still say every initializer runs the refresh: `paces.ts:43`, `blended-fitness.ts:541`, `initialization.ts:867`; `paces.ts:43` also says it runs after `refreshVO2Estimates`, which is not true in triathlon (launch runs it after the DB activity load). Add the refresh to the cycling initializer for parity, or correct the comments.

### ISSUE-393: Defaults taken under Tristan's delegation, for confirmation *(P3, 2026-10-12, needs Tristan's sign-off)* — OPEN

(a) **PB-recency anchors** (`1f9bf0a`, §DE): 0.5 through 365 days, linear to 0.75 at 730 and to 1.0 at 1095. It never exceeds the old bands and keeps forecasts under 1 s a day, but a race now counts as fully stale at three years, not the 2026-05-05 rule's two. (b) **PB-age caption rule** (`9df38ae`, §DC): show it only when ageing moves a displayed number by at least 1 s. (c) **Triathlon predictor rounds once** (`44613be`, §DD). (d) **Pace-cache scope** (`3bb40e3`): it also syncs `s.pac` when `recomputeLT` writes a new LT (the foreground watch-LT sync and the post-sync recompute move paces at once), and a manual physiology entry with only a VO2max keeps the threshold pace on `s.lt` instead of writing a VDOT pace. Confirm each, or name the alternative.

### ISSUE-394: Stale comments and dead code found in lane v *(P3, 2026-10-12)* — OPEN

(a) Comments still describe the PB-recency factor reaching full penalty at two years: `predictions.ts:784-785` (the `marathonPbAgeDays` parameter doc), `predictions.ts:1014-1015` and `physiological-vdot.ts:209`; the code (`RUN_PB_RECENCY_ANCHORS`) reaches it at three. (b) `buildRaceForecastCard` (`home-view.ts:838`) is never rendered and its click handler (`home-view.ts:3253`) targets an element that is never created; FEATURES feature 3 described it as a Home surface (annotated 2026-10-12). Pre-existing. (c) `src/calculations/marathon-signal-strength.ts` has no production import (only its test), and holds a 365-day freshness step (`:51-61`). Delete or wire up?

> **2026-10-08 — QA round (stored-plan race weeks, race-day card, recent race effort): follow-ups (ISSUE-372 → 386).** Raised in the implementer and reviewer reports for `fix/lane-i`, `fix/lane-r` and `fix/lane-t` (merged in `49366c5`, `03459f1`, `c68b72b`; CHANGELOG 2026-10-08 QA round; SCIENCE_LOG §CY, §CZ). Each is an open question for Tristan or a defect found next to the changed code; several are pre-existing. None of the QA-round changes is marked fixed: they are unit-tested and checked on the dev harness, not device-verified (`docs/DEVICE_TESTS.md`).

### ISSUE-372: Triathlon run paces come from the uncapped watch VO2max through `s.lt` *(P1, 2026-10-08, pre-existing, high priority, needs Tristan's decision on the ceiling)* — OPEN

The triathlon cold-start cap holds the engine VDOT (`s.v`) and the forecast at the run skill rating, but run paces read `s.lt`. `triRunEasyPaceSec` = `gp(s.v, s.lt).e` (`tri-run-pace.ts:40`), and `gp` ignores VDOT whenever an LT pace is set (`paces.ts:10`). `recomputeLT` (`src/data/ltSync.ts:173`) sets `s.lt` from an LT override, a Garmin LT reading or a blend of sustained-effort, PB critical-speed and Daniels estimates (`lt-derivation.ts:622-645`), and takes the Daniels input from `getPhysiologicalVdot` (`ltSync.ts:189`). That function's device tier (`physiological-vdot.ts:465-478`) returns the raw watch VO2max with no triathlon check. The triathlete ceiling at `physiological-vdot.ts:369-381` belongs to `effectiveVo2max`, the blend's VO2 input, and never reaches `s.lt`; editing it does not change paces. Only tier order keeps the watch out of the Daniels input: a VO2max override, the Mosaic running estimate (tier 1a) and a race anchor (tier 1a-bis) rank above the device tier, while an HR fit, an observed LT and a PB rank below it. The Mosaic tier applies only when `vo2Source` is 'mosaic' (the default) and `s.vo2Estimates.running` holds a medium-or-better estimate; `computeVO2Estimates` builds it from the HR fit whenever the fit returns a value, otherwise from the race anchor, an observed LT or the PB median (`vo2-orchestrator.ts:226-253`), and `refreshVO2Estimates` runs from `main.ts`. Scope: a fresh watch reading sets the Daniels input for (1) a triathlete with no running evidence; (2) a triathlete with a PB or an HR fit, even a slower one, when `vo2Source` is 'device', when `s.vo2Estimates` has not been refreshed, or when the Mosaic estimate is below medium confidence (for example a low-confidence HR fit beside a PB). Without sustained efforts the watch is the whole LT estimate in case (1) and with one PB, and the 0.4 Daniels share beside critical speed with two or more PBs. Measured (review, `initializeTriathlonSimulator` plus `refreshBlendedFitness`): 70.3, run skill 3, no running PB, watch VO2max 62: `s.v` capped at 44.31, `s.lt` 220 s/km, easy runs prescribed at 264 s/km (4:24/km) against the run-skill-3 easy pace of 345 s/km (5:45/km). Identical before and after the QA round, with or without easy runs. A triathlete with a cross-trained watch number is prescribed run paces about 80 s/km too fast for their stated ability, an injury risk. Options: (a) give the device tier of `getPhysiologicalVdot` the triathlete ceiling `effectiveVo2max` applies (race anchor, PB, medium-or-better HR fit) and, with no running evidence, the cold-start skill cap, so the VDOT `recomputeLT` reads is capped whatever `vo2Source` is; (b) skip the device tier for triathletes, so the Daniels input falls through to a medium-or-better HR fit, an observed LT or the PB median, and with none of these to `s.v`, which the cold-start cap already holds at the skill rating (one refresh behind); (c) another ceiling. The ceiling is a modelling decision; no number exists in the code for it beyond the skill table (`estimateRunPaceFromSkill`). Device test: "Synced easy runs keep the PB's VDOT" (triathlon variant).

**Note 2026-10-12 (lane v, code changed, not marked fixed):** a combination of options (a) and (b) shipped (`85c1ea4`, `5a255db`, `f4959a8`; SCIENCE_LOG §DA). For a triathlete whose Daniels input is the watch ('device') or the engine fallback ('tanda-fallback'), `resolveLtDanielsInput` (`physiological-vdot.ts:769`) caps it at the running-evidence ceiling (race anchor, PB capacity, medium-or-better HR fit, and since `014148c` a synced race effort) or, with none, at the run skill VDOT, whatever `vo2Source` is. The engine stays as before where the cap lowered a watch input (`min(skill VDOT, the blend with the uncapped LT)`); with no fresh watch it is held at the skill VDOT. Measured case above: `s.lt` 288 s/km and easy runs at 5:46/km (5:45 before `s.lt` was kept unrounded), engine 44.31. `TRI_GENERATOR_VERSION` 23 and the regen moved after the launch refresh (`01739cd`), so stored plans regenerate at the capped paces. The Mosaic tier and the race anchor still rank above the device tier unchanged. Needs the device check and Tristan's confirmation.

### ISSUE-373: Stale PBs are no longer corrected by training data *(P2, 2026-10-08, needs Tristan's decision)* — OPEN

Since `57935d0` (§CY) only a race effort or a typed recent race (`s.rec`) stands the §BZ engine floor down (both gates read `recentRun ?? s.rec`, `initialization.ts:581-594`, `blended-fitness.ts:643-656`); easy runs and the HR-calibrated VDOT do not. A race anchor lifts the engine, or caps an uncorroborated engine down to the race, but never lowers it below PB capacity (`blended-fitness.ts:672-694`), so a slower race anchor does not correct a stale PB either. Measured: 10K PB 40:00 (VDOT 51.9) with six weeks of easy runs at 6:15 to 6:45/km holds 51.9 with or without HR, while the runner's high-confidence HR fit reads 41.8. Before: 34.0 at onboarding, 35.9 to 39.3 after a refresh (an over-correction). The cost is the plan and the forecast, not paces (paces come from LT: threshold 253 and easy 304 s/km without HR, LT 302 s/km from the HR fit with HR, identical before and after). At 'advanced' experience: before, novice band, deload every 3rd week, peak week 345 TSS, longest long run 33 km; after, advanced band, deload every 5th week, peak week 423 TSS, long run 36 km, forecast VDOT 41.2 to 53.8. At 'intermediate', deload every 4th week instead of every 3rd. Options: (1) keep it (a typed recent race or a synced race effort still corrects it); (2) when a medium-or-better HR-calibrated VDOT sits below PB capacity, let it overrule the floor (the floor stands down, or the engine is held at the HR value; the same mechanism as ISSUE-374 option 4, helps only runners with HR); (3) apply PB age to the engine with the existing `pbDates`, e.g. no floor from a PB older than the 365-day band of `RUN_PB_RECENCY_BANDS` (the cut-off `RACE_VDOT_ANCHOR_MAX_AGE_DAYS` uses; helps only runners who enter a PB date). Implementer's lean: (2) plus (3). Paces too fast for a runner with an old PB and no medium-or-better HR fit are a separate, pre-existing issue in the PB-derived LT. Also: the pin's docblock (`src/state/initialization.easy-runs-vdot.test.ts:322`) still says the engine "keeps paces set by the 40:00 10K"; it should say the engine VDOT, band and forecast stay at the PB.

**Note 2026-10-12 (lane v, partly addressed, not marked fixed):** a version of options (2) and (3) shipped for dated PBs (Tristan 2026-10-09 and 2026-10-11; `9c1b442`, `7a0bd5e`, `3f2cf6f`, `e7574f0`, `7e67752`; SCIENCE_LOG §DC). With a measured weekly volume, a PB dated from Strava or Apple weighs `exp(−years × ln 2 / 3)` in the model, and the §BZ floor is `w × capacity + (1 − w) × min(HR fit, capacity)` when a medium-or-better HR fit exists. Not addressed: typed PBs (no date, never age), which is this issue's measured case; any PB with no medium-or-better HR fit (the floor stays at capacity); a slower race anchor still never lowers the engine below PB capacity. The pin's docblock is now at `initialization.easy-runs-vdot.test.ts:373`; besides the "paces" wording it says "nothing applies PB age to the engine", which no longer holds for dated PBs with a measured volume (its PB is typed, so its numbers stand). Direction items in ISSUE-387, the Ironman gap in ISSUE-388.

### ISSUE-374: Tempo runs and parkruns still count as races and lower VDOT *(P2, 2026-10-08, needs Tristan's decision)* — OPEN

The race-effort test is pace-only: any run more than 15% faster than the window's median pace is a race (`RACE_FILTER_RATIO` 0.85, `prediction-inputs.ts:200`). It projects as a slower race and stands the §BZ floor down. Measured among easy runs at about 5:50/km: 10K 45:00 runner (45.3) with one 5 km tempo at 4:45/km 40.3; with a weekly 23:20 parkrun 40.5; 10K 46:30 runner (43.6) with one 6 km session at 4:50/km 39.5, novice band, deload every 3rd week. A tempo at 84% of HR reserve still gives 41.3. Before the QA round the three cases read 39.3, 40.5 and 38.5: two are higher now and the parkrun case is unchanged, all still wrong. Related limits: a race within 15% of the median (a marathon, some halves) is missed; a lone synced race is never a race effort (a window of one run is its own median), and a race beside one easy run counts only when its pace is at least 26% faster than the easy run's. Options: (1) keep it; (2) let average HR mark a run as submaximal (needs a race-effort HR threshold from Tristan; no sourced number exists); (3) use the Strava workout type "Race" flag or the activity name (neither is ingested today); (4) make the §BZ gate compare capacity against the run's HR-calibrated VDOT instead of a raw race projection (runs with HR only). Implementer's lean: (3) where a tag exists, plus (4). Pinned in `initialization.easy-runs-vdot.test.ts`.

**Note 2026-10-12 (lane v, code changed, not marked fixed):** option (2) shipped with Tristan's threshold (2026-10-11, `ff2d980`, `59a1675`, `34e8b21`; SCIENCE_LOG §CY update). A run with an average HR, for an athlete with HR zones, fills the recent-run slot only at or above the middle of Z4, `(z4.min + z4.max) / 2` (`raceEffortHrFloorBpm`, `heart-rate.ts:137`; Karvonen 190 / 50: 169 bpm). Tanda's P stays pace-filtered. The 10K 45:00 runner with a 5 km tempo at HR 165 or 168 now holds 45.3. Still open: (a) runs without HR keep the pace-only test, so the tempo and parkrun cases above stand for them (pins remain); (b) known false negatives: a half marathon averaging in the lower half of Z4 (1:38 at HR 168) is not a race effort, nor a race within 15% of the window median; option (3), the Strava "Race" flag, would catch both but is not ingested; (c) counting a race does not by itself pull today's estimate to it, because the race point also enters the HR fit (`computeHRCalibratedVdot`), which can cancel it (`heart-rate.ts:131-133`, open question).

### ISSUE-375: Typed weekly km moves neither the plan nor the weekly target for manual-entry athletes *(P2, 2026-10-08, needs Tristan's decision)* — OPEN

An athlete who types weekly km on the review step instead of syncing gets the last-resort target, runs/week × 50 × the phase multiplier (`fitness-model.ts:1179`, §CH), and the plan takes the race-target volume, because the ramp from current km needs an athlete archetype (`plan_engine.ts:663`) that only synced history produces (`stravaSync.ts:570`, `appleHealthSync.ts:2150`, and `main.ts:1657` from cached `historicWeeklyKm`; manual entry sets `detectedWeeklyKm` and `weeklyVolumeConfirmed` only). Measured (16-week marathon, 10K 45:00): typed 50 km on 3 runs prices weeks 2 to 6 at 214 to 235 TSS against a 146 target (47 to 61% over on every surface that compares load with the target, the excess-load adjustment included); typed 15 km on 4 runs at 255 to 277 against 194, with week 2 at about 40 km, the same plan a typed 50 km builds on 4 runs. Options: (1) keep it; (2) a stated-volume step before the last resort, typed km × easy pace × 0.92 TSS/min (`TL_PER_MIN[4]`; target and plan would still disagree); (3) with no history, the target is the sum of the generated week's priced sessions; (4) give manual-entry athletes the existing neutral 'unknown' archetype (`athlete-archetype.ts:293`, already the continuous-mode fallback) so the plan ramps from the typed km (a planning change). Implementer's lean: (4) with (3) or (2). Pinned in `initialization.load-target-no-history.test.ts`. **Note 2026-10-12:** lane k (`5a58cf2`, merged 2026-10-11, not documented in this pass) makes a typed weekly km drive the volume ramp archetype and a weekly-target baseline (`typedVolumeArchetype`, `typedVolumeWeeklyTSS`); lane v's `4991e58` limits both to running plans (`typedVolumeShapesPlan`, `athlete-archetype.ts:288`: not triathlon, cycling, HYROX or Just-Track). Not marked fixed; lane k's docs, science entry and device check are outstanding. QA harness note (untracked files): the harness seeds per-run history but not `historicWeeklyTSS`, `ctlBaseline` or `athleteTier`, so every running scenario shows the last-resort target (216 on the fewer-runs scenario); it also seeds an archetype a manual-entry athlete never has.

**Note 2026-10-12 (lane k docs, not marked fixed):** lane k is documented in CHANGELOG 2026-10-09, FEATURES (feature 8, 7e and the planned weekly load target), ARCHITECTURE and SCIENCE_LOG §DF, with a device check in DEVICE_TESTS. What shipped: option (2) for the target (`typedVolumeWeeklyTSS`, `fitness-model.ts:1165`) and a variant of option (4) for the plan, the sync classifier on the typed km (`typedVolumeArchetype`, `athlete-archetype.ts:340`) instead of the neutral 'unknown' archetype; a saved review volume-row edit now sets `weeklyVolumeConfirmed` (`fb4d226`). Option (3) is not built, so target and plan still disagree for a low typed km. Measured at `d0a1dc5` (16-week marathon, 10K 45:00, weeks 2, 3, 5 and 6): typed 15 km on 4 runs prices 118 to 145 TSS against a 76 target (55 to 91% over; before lane k 256 to 278 against 194); typed 30 km 209 to 257 against 152; typed 50 km on 4 runs 256 to 278 against 253; on 3 runs 214 to 236 against 253. Every surface that compares load with the target reads a low-typed-km plan done exactly as over target (§DF limitation 1). Needs Tristan's decision on option (3) before this can close, plus the device check.

### ISSUE-376: A synced race effort lifts the triathlete cold-start cap and lets the watch number back in *(P2, 2026-10-08, pre-existing, more frequent since §CY)* — OPEN

The triathlete watch ceiling in `effectiveVo2max` (`physiological-vdot.ts:369-381`, the blend's VO2 input) caps the watch VO2max at the best running evidence: race anchor, PB or medium-or-better HR fit. A synced race effort is not in that list, but it lifts the cold-start cap (`blended-fitness.ts:717`). Measured: 70.3, run skill 3, watch 62, easy runs plus a synced 10K in 48:20 (worth 41.6): engine 47.9, above the skill cap (44.3) and the race itself; at watch 56, 44.2. Before §CY the same seeds read 44.2 and 41.0, because a newer easy run took the recent-run slot; the race effort now wins over newer easy runs, so this case is more common. Options: (1) keep it; (2) add the synced race effort's own VDOT to the ceiling's evidence (no new numbers; `effectiveVo2max` would need the run window, which touches every caller). Implementer's lean: (2). Related: ISSUE-372.

**Note 2026-10-12 (lane v, code changed, not marked fixed):** Tristan approved option (2) on 2026-10-11 (`014148c`). The synced race effort's own VDOT, `cv(d, t)`, is now one of the ceilings in `triathleteRunEvidenceCeiling` (`physiological-vdot.ts:680`), so the watch is held at the run that lifted the cap, in the blend's VO2 input and in the LT input. Where HR zones exist the run must carry an average HR (`triRunEvidenceRaceEffort`, `requireHr`). Measured (70.3, watch 62, run skill 3, three weeks of jogs plus an 8 km run at 5:00/km): no HR with HR zones, cap holds (`s.lt` 288, engine 44.31, run leg 1:39:22); no HR zones, `s.lt` 317 from the run's VDOT 41.4 (engine 35.74, run leg 2:01:00); HR 175, `s.lt` 294, engine 37.79. SCIENCE_LOG §DA. Needs the device check "Triathlon run paces after onboarding" (`DEVICE_TESTS.md`) and Tristan's confirmation.

### ISSUE-377: A typed recent race now applies to synced athletes and never ages *(P3, 2026-10-08, needs Tristan's decision)* — OPEN

`s.rec.weeksAgo` is set once at onboarding (`initialization.ts:687`, `events.ts:336`) and never aged. Before §CY any synced run hid `s.rec`; now a synced athlete with no race effort in the window keeps the typed race at its onboarding recency weight indefinitely, and it keeps the §BZ floor down. Measured: 10K 45:00 runner with easy runs and a typed recent 10K of 48:20 "3 weeks ago": 40.09 at onboarding and 41.03 after a refresh (before: 37.59 and 39.52, from the easy run), the same a year later. Options: age `s.rec` from its entry date, drop it after the 8-week window, or fold it into the ISSUE-373 decision.

**Note 2026-10-12 (lane v):** unchanged. PB ageing (§DC) does not touch `s.rec`; the typed recent race keeps its onboarding recency weight.

### ISSUE-378: Triathlon commute runs can share a weekday with another run *(P3, 2026-10-08, needs Tristan's decision)* — OPEN

Scheduler step 3b (`scheduler.triathlon.ts:207`) keeps training runs apart but skips commutes, which keep steps 4 and 5 (collision allowed). Commutes that used to sit beside the Sunday long run now go to weekdays: commute plus another run on one weekday rose from 3,450 to 5,298 weeks in the 33,210-week test sweep (with a quality run, `isQualityRun`, 1,335 to 2,460; default weekday split 1,416 to 1,743, quality 231 to 393; the review's sweep 2,607 to 3,363). If commutes followed step 3b: 1,803 and 1,203 (default split 453 and 75), below the starting point. Does a commute count as a second run, so commutes avoid days with a run before doubling?

### ISSUE-379: Triathlon with 0 weekday hours: two runs on Saturday, overflow runs on weekdays *(P3, 2026-10-08, needs Tristan's decision)* — OPEN

With weekday hours set to 0, step 3's weekend two-a-day still puts two runs on Saturday beside the long ride: 3,687 of 30,510 weeks in the implementer's wider sweep, unchanged from before (review: 2,658 to 2,604). Example: sprint, beginner, 8 h: Saturday endurance ride, swim technique, easy run, easy run. Since `6466f77` a run that may not sit beside the long run or brick takes a weekday over its 0 cap, where before everything stacked on the weekend (commute plus quality run on one weekday 0 to 1,836 of those weeks). In race week, sessions with no free day are left out instead. Keep weekday runs for these users, drop the overflow run in normal weeks too, or also move Saturday's second run to a weekday?

### ISSUE-380: Triathlon and cycling race-week primer is off running's primer day for most Saturday and Sunday races *(P3, 2026-10-08, docs corrected, needs Tristan's decision)* — OPEN

`placeStoredPlanRaceWeekPrimer` (`race-day-rules.ts:503`) keeps the primer on Tuesday only when the scheduler seated it there; otherwise it takes the latest race-week day 3 to 5 days out. The race-week weekday cap often stops the scheduler seating the first ride on Tuesday, so for a Saturday race the primer lands on Wednesday and for a Sunday race on Thursday (3 days out), where running and HYROX use Tuesday (4 and 5 days out): 570 of 792 Saturday and 1,059 of 1,584 Sunday race weeks in the review's 7,128-plan sweep. Example: sprint, 8 h, Sunday race 22 Nov 2026: primer Thursday, swim Tuesday. Monday to Friday races match running. The day is inside the §CE window either way. `triRaceWeekPlacement` (`plan_engine.triathlon.ts`) computes running's day (`primerDow`) but only its null check is used, and its doc comment describes placement the code does not do. Options: (a) place the primer on `primerDow` wherever the scheduler seated it, keeping the same-discipline swap, with a plan-level assertion of running's days in `tri-race-week.test.ts`; (b) keep the behaviour and correct the `primerDow` comment. Either way the behaviour change needs a `TRI_GENERATOR_VERSION` bump.

**Note 2026-10-14 (lane tri-taper, `5068d8b`):** the primer placement this issue describes no longer exists for triathlon and cycling. Race week is composed relative to race day (`composeTriRaceWeekWithClosing`, `tri-taper.ts:688`): race-pace openers on the days 5, 4 and 3 out (thin weeks take the days nearest the race; long course puts the brick 3 days out), nothing 2 days out, the activation the day before. `triRaceWeekPlacement` is removed and `placeStoredPlanRaceWeekPrimer` is no longer called by the engine (test only, ISSUE-400 (s)), so options (a) and (b) no longer apply. Saturday and Sunday races now use the whole of running's primer window. Not marked fixed: needs the device check in `DEVICE_TESTS.md` (Olympic race week, Sunday race).

### ISSUE-381: Race-week commutes are left out in triathlon and HYROX; race week can exceed the week before by commute minutes *(P3, 2026-10-08, needs Tristan's decision)* — OPEN

HYROX schedules one session a day on the allowed race-week days, so commutes with no free day disappear: 480 of 1,728 race weeks with bidirectional commutes keep none (every Thursday race, some Friday and Saturday races). Triathlon's no-double rule does the same: race weeks keeping only 1 of 4 commute slots rose from 24 to 90. Separately, in 90 triathlon plans (bidirectional commute, 0 weekday hours, Thursday to Saturday race) race week is heavier than the week before, by commute minutes only: the race window cleared the week before's weekend commutes (sprint, 4 h, Friday race 20 Nov 2026: 150 against 120 min). Without commutes race week is at most 0.67 of the week before. Should race-week commutes be kept as transport outside the race-week day rules?

**Note 2026-10-14 (lane tri-taper, `5068d8b`):** triathlon race-week commutes are now placed by `triRaceWeek` (`plan_engine.triathlon.ts:1238`): weekdays 3 or more days out holding no run, the days with the fewest sessions first; a commute with no such day is left out, as before. They count toward neither the race-week fraction nor the two-session limit (§DN limitation 11). The 24-to-90 figure above was not re-measured. HYROX is unchanged.

### ISSUE-382: Triathlon and cycling race-week content questions *(P3, 2026-10-08, needs Tristan's decision)* — OPEN

(a) **Swim primer**: race-week swims are always aerobic, because no existing CSS set is primer-sized (each holds at least 600 m at CSS; a 30-min swim gives 10×100 m, 5×200 m or 3×400 m). Keep the ride as the only primer, or add a short swim rep scheme (needs Tristan's numbers)? (b) **Cycling race week holds 4 rides where the week before holds 5**: the ride days are Tuesday, Thursday, Friday and Saturday, and Sunday is the race's. A Monday to Wednesday race could seat the fifth on Sunday, but its race week would then differ from the Sunday race before it (the parity and forecast tests). Accept 4? (c) **Ironman primer**: `TRI_QUALITY_SLOTS.ironman.taper` is all zeros (`tri-intensity-profile.ts:84`); every race week now has a primer ride. Confirm. (d) **Primer card copy**: `describeBikeSession` variant 0 at 30 min reads "15min Warm up. Main: 1×8min @ ..., 5min recovery. 5min Cool down." (a recovery after a single rep, 33 min under a 30-min label; tempo reads "1×10min ..., 5min easy between"). Shared copy (normal weeks and the ad-hoc picker use it). Fix the single-rep wording in `bike.ts`? (e) Remainder of ISSUE-364: Thursday to Saturday race weeks are otherwise still the template cut at race day; with no doubles a cycling Thursday race week can hold only the Monday primer (18 plans in the implementer's sweep).

**Note 2026-10-14 (lane tri-taper, `5068d8b`):** (a) swim openers now exist: a steady swim with 90 s race-pace repeats, 3 to 5 days out, when the swim budget holds one. (b) The 4-rides-against-5 comparison no longer describes cycling: race week is 0.30 of the reference week with a ride opener on each window day, aerobic rides and the pre-race spin, with at least 80% of the reference sessions as counted (race and spin included) for Sunday to Wednesday events. (c) Ironman taper week 1 keeps the reference week's quality count (1/1/1) as race-pace sessions (`TRI_QUALITY_SLOTS.ironman.taper` is now 1/1/1 too, for inter-cycle taper weeks), and race week has openers and Byrn's brick in place of the primer. (d) Race week no longer uses the variant-0 primer; the shared single-rep wording in `bike.ts` is unchanged and can appear when a cycling taper-week-1 sweet spot or tempo ride sits at its one-rep minimum (26 min; not checked on a rendered card). (e) Thursday race weeks are now composed (Monday's training, up to two sessions, and the Wednesday activation; every discipline keeps a session); the race window still cuts taper week 1 (ISSUE-364, ISSUE-400 (d)). Not marked fixed.

### ISSUE-383: HYROX race-week follow-ups *(P3, 2026-10-08)* — OPEN

(a) **No ergs**: race week leaves the circuit slots out, so only runs remain. Keep it, or offer a short farmer-carry-only touch (a one-station set is below `MIN_CIRCUIT_STATIONS` 2)? (b) **Volume at low hours**: race weeks over the 0.30 budget: 411 of 1,296 in the implementer's sweep, 2,556 of 5,184 in the review's (before: 435 and 3,976), all from the 20-min run, 35-min circuit and 2-round floors, never heavier than the week before. Keep frequency, or drop sessions to fit the budget? (c) **Add session in race week** (pre-existing): `ui/hyrox/add-session-modal.ts:275` reschedules the whole week with `scheduleHyroxWeek` and no allowed days, so adding a session in race week can move the primer or put a circuit in the last 2 days. (d) **Stale comment**: `raceWeekCircuitStations` (`src/workouts/hyrox-generators.ts:105-109`) says that without ergs "the slot becomes an easy run"; since `c2bd375` the circuit slots are left out (`raceWeekCircuitOk`, `plan_engine.hyrox.ts:379`).

**Note 2026-10-19 (docs pass for the triathlon and cycling taper, `5068d8b`; checked at `d8432d2`): HYROX taper fractions, mirror evaluated, no change.** Triathlon and cycling now taper at 0.55 then 0.30 of the reference week per discipline: a 57.5% mean cut, inside the 41 to 60% band that had the largest effect (Bosquet et al. 2007; SCIENCE_LOG §DN). HYROX at `d8432d2` (lane H2) tapers 2 weeks at every plan length that holds them (`HYROX_TAPER_WEEKS_MIN`, `hyrox-constants.ts:123`) at `taperFraction`, nominally 0.70 then 0.55 of the reference week's planned minutes, the reference week being the last week before the taper that is neither taper nor deload (`plan_engine.hyrox.ts:2519`, `:2587`; engine header `:25-28`): a nominal 37.5% mean cut, in the weaker 21 to 40% band (Bosquet ES 0.27, p = 0.02, against 0.72). The smallest circuit is exempt from the fractions in taper week 1 and race week, and the taper never rises above the week before (`:2297-2307`). Delivered, the docs-pass probe at `d8432d2` (629 Open Singles plans: every band, 8 to 24 weeks, the hours grid of `plan_engine.hyrox.rules.test.ts`, 2 taper weeks each) measured taper week 1 at a median 0.70 and race week at a median 0.55 of the reference week's minutes: a mean cut of about 38%, the nominal depth, below the 41 to 60% band. A race-week median of 0.43 appears in lane H2's round-4 review, but as that round's before figure; its fix moved the median to 0.54. No change was made in the docs pass. HYROX's weekly load target reads the same `taperFraction` (0.70 then 0.55; `planned-week-target.test.ts`, 280 and 220 from a 400 baseline), and plan and target share the deload rule (`isHyroxDeloadWeek`, `plan_engine.ts:301`, read by `planned-week-target.ts:103-106`), so the two agree on the taper's shape. They differ in base, as in triathlon: the target scales the athlete's baseline TSS, the plan the reference week's planned minutes, and Signal B tapers only its running term (540 then 510 against a 594 base week in the test fixture). The effort and MTL-gap levers reach HYROX's taper only through the reference week, as in triathlon. Open (ISSUE-400 (t)): move HYROX to 0.55/0.30, or record a reason for 0.70/0.55 (HYROX's strength and eccentric content may justify a lighter cut; no source is cited for either). Re-check the delivered fractions after the HYROX session-content lane (`fix/hyrox-h2b`) lands. Item (b) above (race weeks over the 0.30 budget) predates lane H2, whose race week is 0.55 of the reference week; H2's docs pass should restate it.

### ISSUE-384: Stored-plan quality-run spacing is checked within the week *(P3, 2026-10-08, mirrors running)* — OPEN

`spaceStoredPlanQualityRuns` (`race-day-rules.ts:402`) checks spacing inside one week, as running rule 4 does (`race-day-rules.ts:147-153`). A quality run it moves to Monday can follow the previous week's Sunday long run: 321 to 363 weeks in the review's sweep, all 42 new cases Friday races 11 days out. Example: sprint, 12 h, Friday race 20 Nov 2026: the week before race week moves its threshold run from Wednesday (next to Thursday's brick) to Monday, the day after Sunday's 105-min long run and 87-min over-unders. Make both helpers read the previous week's Sunday (running too, mirror rule), or accept?

### ISSUE-385: Running race-week primer exceptions awaiting confirmation *(P3, 2026-10-08, needs Tristan's sign-off)* — OPEN

Since `e421a73` race week keeps the §CE primer whenever it holds a run (§CE update 4). (a) **Case b**: blocks with logged runs but none in the 30 days before build now get the race-week primer; design v4 Q19 ("no run in 30 days: 30-min restart, no primer") said none (ISSUE-360). The old code left it out only because the reference week held no quality session. Keep it, or exempt these runners? (b) **ACWR caution** no longer removes the race-week primer, to match the existing high-ACWR race-week exemption. Confirm. (c) Race week still has no primer when the user excluded threshold workouts (or VO2 for a 5K), and when onboarding falls after the day 3 days before the race. Confirm both. (d) **Debrief copy**: `_computeChanges` (`week-debrief.ts:1186`) prints "1 quality session replaced with easy (training load elevated)" whenever ACWR is at caution, which is now false for race week; it shows only when the race-week preview otherwise differs by 1 km or more per session, so it is rare. The 'high' lines have the same pre-existing inaccuracy for race week. Proposed: pass the preview's race-week flag (`_raceWeek`, `week-debrief.ts:936`) into `_computeChanges` and skip the ACWR lines in race week.

### ISSUE-386: Race-day card follow-ups *(P3, 2026-10-08)* — OPEN

(a) Race day is still a drop target in all three plan views; a session dragged onto it shows beside the card, as dropping on a rest day did. On Home the dropped session also replaces the race: `buildRestOrRaceDayHero` runs only from the empty-day branches (`home-view.ts:1975-1983` running, `:2947-2949` triathlon and cycling, `:3014-3016` HYROX), so the Today card shows the session instead of the race. In running an activity completed that day does the same (`findTodayCompletedActivity`, `:1978-1981`), and in HYROX so can an ad-hoc session logged with that day; the triathlon card filters synced and completed sessions out. Should race day refuse drops, and should Home show the race beside any session that day? (b) Running, rest-typed workout on race day (injury weeks emit "Complete Rest" or "Rest & Ice"): the strip keeps its "Rest" tag with the card under it (`plan-view.ts:885-893`); the empty-day branch drops the tag. (c) The cycling card title comes from `getCyclingEventLabel` (`cycling-mode.ts:24`), which writes "160 km" whatever the unit setting; every other distance on the card goes through `formatKm`. (d) Wording when no race is picked: running "Marathon" or "Half marathon"; triathlon "<city> 70.3", or "70.3 triathlon" with no city; cycling "160 km"; HYROX "<city> HYROX" or "HYROX" with the format in the detail. Confirm. (e) The HYROX card reads only `hyroxConfig.raceDate` (the generator's source), while the HYROX plan header countdown falls back to `onboarding.customRaceDate` (`ui/hyrox/plan-view.ts:117`).

> **2026-10-08 — Race plans (whole-plan shape, sharpening block, race-week calendar): follow-ups (ISSUE-354 → 371).** Raised in the implementer and reviewer reports for `fix/lane-s` (merged in `c5f4a7f`, CHANGELOG 2026-10-08, SCIENCE_LOG §CT to §CX). Each is an open question Tristan has not decided, or a defect found next to the changed code; several are pre-existing. Already decided and not listed: the hours-target rule and the low-base marathon rule (2026-10-06), the mixed fit order and the merged-runs plan note (2026-10-08). None of the lane-s changes is marked fixed: they are unit-tested, not device-verified (`docs/DEVICE_TESTS.md`).

### ISSUE-354: Quality session longer than the long run in budget-bound full plans *(P2, 2026-10-08, needs Tristan's decision)* — OPEN

On a tight budget `applyHoursBudget` never trims a quality session (the "quality never trimmed" contract) but trims the long run to its 40 / 30 min floors, and the 10% rule (§CT) now keeps early long runs low on short plans. In the 1,092-plan grid at `76d5cba` a quality session is longer than the week's long run in 208 plans without an hours target (115 marathon, 93 half) and 574 with a 4-hour target (372, 202); before the branch 204 and 569. Example: advanced 8-week marathon, a 54 to 60 min marathon-pace session beside a 51 to 57 min long run. Options: (a) keep quality first; (b) the long run never drops below the week's longest quality session, with the quality session shrinking or dropping first (breaks the "quality never trimmed" contract and the quality-cap floor of one). The sharpening block already caps every session at the long run's distance (§CV).

### ISSUE-355: Triathlon long run and the 10% rule *(P3, 2026-10-08, needs Tristan's decision)* — OPEN

Running long runs grow at most 10% over the 4-week longest (§CT); the triathlon long run does not. It is a 0.45 share of run hours (the Ironman long run has its own §CD ramp and a maintenance floor on alternation weeks), so it moves with phase-multiplier steps and session counts: 58 of 64 sampled plans exceed +10% (max +44%: 70.3, 12 weeks, 8 h, week 5, 65 against 45 min); a wider sample found 74 of 128 (max +100%). Applying the rule needs a decision on where the freed minutes go inside the §CB hours cap.

### ISSUE-356: Triathlon and cycling deload week heavier than the week before in 7- to 9-week plans *(P2, 2026-10-08, defect)* — OPEN

`generateWeekForTriathlon` applies the 0.7 deload to the deload week's own phase multiplier (`plan_engine.triathlon.ts:370`). When week 4 is the first build week after three base weeks, 0.92 × 0.7 = 0.644 of peak hours exceeds base week 3 at 0.625, so the deload week is heavier: 70.3, 8 weeks, 8 h: week 3 300 min, week 4 (deload) 310; Ironman 8 weeks 15 h: 564 to 587; cycling 8 weeks 10 h: 377 to 386. Grid: sprint 3 of 28, 70.3 3 of 32, Ironman 4 of 36, cycling 4 of 32, olympic 0 of 32; HYROX 0 of 72. Proposed fix, no new constants: cap the deload multiplier at the previous week's phase multiplier, as running's backstop does; it changes generator output (`TRI_GENERATOR_VERSION` bump).

### ISSUE-357: The 10% long-run ceiling reads the nominal plan; the volume ramp counts deload weeks *(P3, 2026-10-08, follow-ups)* — OPEN

(a) `nominalHistory` replays past weeks from the static inputs, without the effort, CTL-gap, ACWR or holiday levers that shaped each live week. A live long run can therefore exceed +10% over the previous live long runs (review: 59 weeks in 36 plans, up to about +21%; bounded by the effort band at about +29%), and a skipped or shortened long run does not lower the next ceiling. Past levers can be read from state (`getTrailingEffortScore(s.wks, k)`, `wk.ctlRatio`) and replayed. (b) `effectiveWeeklyBudgetMin` ramps `weekVolumeBudgetKm` by the raw week index (`plan_engine.ts:637`), so the week after a deload carries two budget steps over the pre-deload week. Holding the volume ramp through deloads would mirror the long-run ramp hold.

### ISSUE-358: Race-day durability decisions *(P2, 2026-10-08, needs Tristan's decision)* — OPEN

The race-day forecast now applies the durability cap to the plan's prescribed long runs (§CU). (a) **Low-baseline marathoners in full plans**: the 10% rule outranks the §BW readiness long run, so detrained or hours-capped marathon plans peak at 50 to 81 min and forecast up to 3.8% slower (detrained 15 km: median +2.3%; 4-hour plans: median +2.9%). Keep it, let the 10% rule yield to readiness in a bounded way (needs a number from Tristan), or state the plan's longest run and the penalty at plan creation? (b) **Half and 10K**: every plan carries a penalty (half median +0.6%, max +2.3%; 10K max +1.4%) because their long-run ramps peak at about 84 and 63 min under the 105 and 75 min thresholds. Build the ramp to the threshold, revisit the threshold, or keep the message? (c) **PB floor**: the race-day penalty is not floored at a same-distance PB (§BV floors today's estimate only), so a forecast can sit above a PB or above today's estimate. Floor it? (d) **Triathlon mirror**: the triathlon projection credits its durability thresholds by `executionFactor` (`race-prediction.triathlon.ts`), while 20 of 64 sampled plans have a longest run under the run threshold and 24 of 64 a longest ride under the ride threshold (70.3 at 6 h: run 65 of 90 min, ride 100 of 150; Ironman at 6 h: run 100 of 150, ride 104 of 270). Read the triathlon plan's prescribed longest sessions too? (e) `renderer.ts` and the onboarding preview fall back to today's estimate when no peak-volume anchor has been published; in that window the race-day term counts durability twice. Only a state that never completed `initializeSimulator` or `refreshBlendedFitness` reaches it. Confirm or guard.

### ISSUE-359: Home forecast after the first refresh differs from the onboarding headline *(P2, 2026-10-08, one-number rule, probably pre-existing)* — OPEN

The onboarding preview hero now equals `s.forecastTime` at build (`planForecastWeeklyKm`, `76d5cba`). `refreshBlendedFitness` run straight after build gives a different number: Home can read 4 to 21 min faster than the headline (review cases: 15 km a week, 5-week block, 21 min; a 6-week block for a runner with no run in 30 days, 12 min; the Tuesday-race example, 15 min). A 16-week full plan shows a similar gap, so the refresh path is the likely cause, not the block: the refresh replaces `s.v` with `blendedEffectiveVdot` and re-reads the peak-volume anchor at that VDOT, and `initializeSimulator` does not. Whether it predates the branch is not established (no base build was run). Fix: align `initializeSimulator`'s forecast anchor with `refreshBlendedFitness`, or run the refresh before the preview reads the forecast. Device test: "6-week marathon short plan".

**Note 2026-10-12 (lane v, code changed, not marked fixed):** the second option shipped (`07d658f`, SCIENCE_LOG §DB). `initializeSimulator` ends with `refreshBlendedFitness` on the committed plan, and the preview reads `runningForecastForSessions`, the computation the refresh stores as `s.forecastTime`; triathlon, HYROX and Just-Track init end with the same refresh. `one-forecast-mirror.test.ts` checks init against the launch. The review cases above were not re-measured; needs the device check "Plan preview equals Home" (`DEVICE_TESTS.md`).

### ISSUE-360: Sharpening block rules awaiting Tristan's confirmation *(P3, 2026-10-08, needs Tristan's sign-off)* — OPEN

Design v4 is the lane-s working design for the sharpening block (2026-10-06); it is not checked in to the repo, and SCIENCE_LOG §CV ("Design v4 reference") summarises its questions and sections. Built as product rules inside the design v4 framework, not yet confirmed: (a) the week before the taper never deloads in a block (it stands in for the peak week when there is no fitness signal); (b) race week keeps `rw − 1` sessions because the race takes the long-run slot (example A's race week is 77 min, a primer plus two 25-min easy runs, against 102 in the design table); (c) with 1 run a week, race week holds no session (the design had one easy run). (d) The M4 design v4 review defaults the branch was built on, recorded in code as approved defaults: 2-week marathon taper including the 8-week full plan (Q1, Q2); 30-day start, archetype growth and single-session cap (Q3); volume and deload rule (Q4); the new taper step-down for blocks only (Q5); reduce-only levers in blocks (Q6); 0.55 one-week taper in every mode (Q7); race-day rules for every running race plan (Q8); closing week for Monday to Wednesday races (Q9); local anchors in every mode (Q10); `TAPER_NOMINAL.marathon` 2 (Q11); block durability penalty as an exception to §AL.4 (Q12); no 5K or 10K blocks (Q13); earliest race date tomorrow (Q14); triathlon and HYROX race-week content later (Q15); race week and the closing week always open (Q16); full-plan deloads and long-run jumps as a separate issue (Q17, since covered by §CT); preview on the shared forecast inputs (Q18, built as `planForecastWeeklyKm`); case-b 30-min restart with no primer (Q19; since `e421a73` race week holds the primer for these runners too, ISSUE-385); hours target in a block (Q20, decided by Tristan 2026-10-06); skipped long runs and quality before a taper dropped with the base penalty (Q21); taper overshoot of up to half a run (Q22).

### ISSUE-361: Sharpening block replays past weeks from current inputs (frozen rows not built) *(P3, 2026-10-08, needs Tristan's decision)* — OPEN

Design v4 §4.2 called for frozen block rows and an `applyPlanSettingChange` path (a proposed name; no such function exists in `src/`). The branch freezes only the build-day start (`s.sharpenBlock`) and replays every week from current inputs (`nominalHistory`). Runs-per-week, session and hours changes therefore recompute without extra code, but a sync that changes `detectedWeeklyKm`, the archetype or `s.v` also changes the replayed past weeks (full plans behave the same). Accept, or build frozen rows?

### ISSUE-362: Sharpening block race page and forecast follow-ups *(P3, 2026-10-08)* — OPEN

(a) **Low-base basis**: the race page judges the block's projected peak long run (`projectedSharpeningPeakLongMin`, an upper bound) against 1:55; the alternative is the raw 30-day longest under 1:55, which would also flag example A (1:40). (b) The race page cannot see an hours target (the schedule step comes later): a 2-hour target that holds the long run at 95 min against a projected 121 is not flagged there; the forecast surfaces flag it after build because they read the built plan. (c) The one-tap switch to a half or a later race is on the race page only; the forecast surfaces state the gap but do not offer it (needs an in-app rebuild flow). (d) Race activities count toward the 30-day longest (Frandsen counted every run), so a marathon 3 weeks earlier starts the next block at the ability ceiling with no post-race recovery. Exclude races, or ask a no-data runner for their longest run on the race page? (e) Goal check: only the label tells the truth ("Add a run a week" when the extra run would be easy). The design's gate (offer an extra run only when the forecast with it lands within 20 min of the goal, via `computeRunForecast`, a function name proposed in design v4 that does not exist in `src/`) is not built.

### ISSUE-363: Race page does not describe a partial first week *(P3, 2026-10-08)* — OPEN

A plan built mid-week has a partial week 1, and the race-day rules respect the onboarding day (`firstTrackedDow`). The race page note ("6-week plan, short of the 8-week marathon build. 4 weeks of race-specific training ...") counts calendar weeks as if week 1 were full. Design v4 called for a partial-first-week note; it is not built.

### ISSUE-364: Triathlon, cycling and HYROX race-week content around race day *(P2, 2026-10-08, needs Tristan's decision; mostly pre-existing)* — OPEN

For a Thursday to Saturday race the stored-plan race-week template is cut off at race day rather than placed relative to it, so running's primer rules (§CE: primer 3 to 5 days out, no other quality in the last 6 days) do not apply. Review examples (real initializers, onboarding Sunday 11 Oct 2026): sprint and olympic Thursday races have CSS intervals at R−1; HYROX Thursday a Station Circuit at R−1 and a Tempo Run (RPE 7) at R−2; HYROX Friday Station Circuits at R−2 and R−1; HYROX Saturday the Mini Brick at R−1; cycling Thursday a 99-min sweet spot at R−2, longer than the peak week's 83-min one. Median sessions in the last 6 days: 1 for a sprint, olympic or 70.3 Thursday to Saturday race against 2 for a Sunday race (HYROX 3 against 5); a 70.3 race week is one 31-min swim and a 38-min ride. Related: (a) the race window drops the week-before sessions that fall in the last 6 days (a `92f701d` design choice), where running keeps easy runs and steps quality down to easy; (b) a moved long session displaces the sessions on its target day (a Thursday 70.3 loses Wednesday's swim and Thursday's bike quality); stacking them or dropping the long session are the alternatives; (c) the race-window review's option C (the planning side keeps the window's volume) is open, while the forecast already reads the cut (option A, `Week.raceWindowCut`); (d) a Sunday triathlon's race week puts its remaining ride and swim on Saturday (Ironman 14 h: a 54-min ride and a 44-min swim the day before); (e) a HYROX Monday to Wednesday race keeps its race-week Sunday easy run at R−1. Proposed follow-up: mirror running rules 2 and 4 for these modes (primer or mini-brick 3 to 5 days out, no other hard session in the last 6 days, easy sessions kept at a reduced length, which needs a sourced rule).

**Update 2026-10-08 (QA round, SCIENCE_LOG §CZ): partly addressed, still open.** HYROX race week is now placed relative to race day for every race weekday: no brick or Mini Brick, the tempo primer on running's primer day, technique circuits without the eccentric-heavy or sled stations at least 3 days out, easy runs only in the last 2 days, so the HYROX Thursday, Friday and Saturday examples above no longer occur. Triathlon and cycling race week keeps the week before's frequency, holds one short primer ride 3 to 5 days out (off running's day for most Saturday and Sunday races, ISSUE-380), has aerobic swims (no CSS set at R−1) and never holds a discipline twice on one day; in the last 13 days no quality run sits next to the brick or long run. Remaining: Thursday to Saturday triathlon race weeks are otherwise still the template cut at race day, and with no doubles a cycling Thursday race week can hold only the Monday primer (ISSUE-382 e); (a) to (c) unchanged; (d) not re-measured; (e) is now by design (HYROX easy runs take the latest free days, and a Monday to Wednesday race holds the same race-week sessions as the Sunday race before it). Race-week commutes: ISSUE-381.

**Note 2026-10-14 (lane tri-taper, `5068d8b`):** triathlon and cycling race week is now composed relative to race day for every race weekday (SCIENCE_LOG §DN): openers 3 to 5 days out, nothing 2 days out, a short activation the day before, the brick 3 days out for long course; (d) no longer occurs (the day before holds only a 20 to 30 min spin and a 5 to 10 min jog). For Thursday to Saturday races the race window still cuts taper week 1: below the volume band and the taper-week-1 quality count lost in most Thursday and Friday plans (ISSUE-400 (d)); `taperWeekKeepsDisciplines` puts one session back only for a discipline the window emptied. (a) to (c) unchanged.

### ISSUE-365: "The 7 days before race day": a 6-day or a 7-day window *(P3, 2026-10-08, needs Tristan's decision)* — OPEN

The stored-plan race window and running rule 3 read "the 7 days before race day" as the 7-day week ending on race day: R−6 to R−1 hold no long session and R−7 may hold the last one (`RACE_DAY_CLEAR_DAYS` 6, recorded in the `race-plan-race-week.test.ts` header). In a 5,880-plan review sweep R−7 holds a long session in 2,633 plans and a peak-phase session in 2,589, all Thursday to Sunday races (about 95% of Thursday to Sunday triathlon and cycling plans). The literal reading, R−7 to R−1, would widen the window to 7 days and move every Sunday race's last long run, running included.

### ISSUE-366: Closing-week follow-ups *(P3, 2026-10-08)* — OPEN

(a) **Labels**: in a closing week the training horizon is 0, so the triathlon Training detail header shows "Race date pending" (`ui/triathlon/forecast-chip-detail-view.ts:297`) and the fingerprint "Current markers" (`ui/triathlon/race-forecast-fingerprint.ts:112`) 1 to 2 days before the race; before `1ff0194` they read "1w to race day" and "Race in 1w". "Nw to race day" and "Race in Nw" now count to the end of race week, up to 3 days short of race day. Running's chip detail has the same quirk in its final week (`ui/forecast-chip-detail-view.ts:413`). Suggested: drive these labels from calendar days to race day, e.g. "Race week" as `main-view.ts:191` shows for the closing week. (b) **Cone**: the triathlon Monte Carlo cone spans `s.tw`, closing week included (`race-forecast-simulation.triathlon.ts:97`), while running spans `planTrainingWeeks`; race-day percentiles and goal probability are identical, the cone gains one x-axis point. (c) **Freshness**: the 1 to 3 closing-week days before the race are not credited as extra taper (the conservative choice, matching running); crediting them needs a sourced taper-length effect. (d) **Naming**: in code "race week" is the week holding race day minus 3 (`isRaceWeek`, training weeks), while the UI labels the closing week "Race week".

### ISSUE-367: Continuous plan Deload week: strength depth and run depth *(P2, 2026-10-08, needs Tristan's decision)* — OPEN

Since `6df2908` and `712d352` a continuous plan deloads its labelled Deload week (§CX). (a) **Strength**: the Deload week takes the 'taper' row of `getPhaseSessionCount` (1 session for 2 or more a week, 0 for 1; `gym.ts:156`) and the deload removes one more, so it now holds 0 strength sessions at every count from 1 to 4, for every ability (40 real-path plans). Before, beginners and novices kept one Activation session and advanced runners one Running Strength session that week, while the runs drop only to about 0.65 to 0.80 of a normal week. Keep zero (intermediate plans already had it), or apply the taper row without the extra deload cut (1 session for 2 or more)? (b) **Run depth**: the Deload week takes taper sizing × `deloadMultiplier` (median 0.65 of the week before for beginners and novices, 0.70 intermediate, 0.72 advanced, 0.74 elite; minimum 0.49 for an elite VDOT on an 8 km baseline, 2 runs, 3-hour cap). Keep the full depth, or apply only the never-heavier backstops in the continuous Deload week?

### ISSUE-368: Triathlon forecast peak mean includes 4-week-cycle deload weeks *(P3, 2026-10-08, pre-existing)* — OPEN

`plannedPeakDoseByDiscipline` averages the peak-phase weeks, including `isFourWeekCycleDeloadWeek` weeks (×0.7, still labelled peak), although its doc says block deloads are excluded. A plan one week longer can move the deload into the peak block, so the forecast is not monotonic in race date: a 70.3 on Thursday 3 Dec 2026 forecasts 1.1 min slower than one on Sunday 29 Nov; 70.3 Thursday 7 Jan +1.5 min; Ironman Thursday 7 Jan +1.2 min; olympic up to +0.9 min (identical with the race window on or off, and before the branch). Excluding deload weeks from the peak mean changes many forecasts, Sunday races included, so it needs Tristan's call.

### ISSUE-369: Plans built before the race calendar keep their old length *(P3, 2026-10-08)* — OPEN

(a) Triathlon, cycling and HYROX plans built with the weeks-until count end a week before race week whenever the race weekday was on or before the onboarding weekday. The launch regen keeps the stored length, so no generator bump extends them, and `storedPlanRaceLayout` returns null for them, which keeps the final week as race week. A launch-time repair (append the missing week and regenerate when `raceWeekLayout(planStartDate, raceDate).calendarWeeks === tw + 1`) is possible but is a state migration; a rebuild (Edit settings or Reset plan) applies the new length today. (b) Running plans built before `6c29020` keep their week-count length; `planRaceLayout` returns null, so the race-day rules stay off until a rebuild. (c) `reconcilePlanAnchorToEarliestActivity` can pull `planStartDate` back a week when activities predate it without extending the plan, so race day can fall after the plan's last week and the race-day rules switch off (pre-existing for every race plan; the final week's review opens once and Plan complete still waits for race day).

### ISSUE-370: Mode switches leave race-plan state behind *(P2, 2026-10-08, defects)* — OPEN

(a) **Plan complete → Continue**: Continue keeps the finished race plan's weeks and sets `trackOnly` and `continuousMode` (`week-debrief.ts:777`). The closing-week skip (`generator.ts:91`), `isRaceWeek(..., continuousMode)` and the block check (`!ctx.continuousMode && isSharpeningBlock`) read `continuousMode` alone, so every past week of the finished plan regenerates on the continuous engine: a block becomes a full plan with long runs past its 10% chain, race week regains a long run and a full threshold session, and the closing week gets a full week of sessions. Those weeks feed activity matching, so a race that syncs after Continue can match a phantom long run. `planned-week-target.ts` already treats this case as a race plan. Example (6-week block, race Sunday 15 Nov 2026): week 3 long run 102 → 133 min after Continue; week 6 gains an 86-min long run and a 45-min threshold. Proposed: key the closing-week skip on the week flag alone (`isClosingWeek`), and either archive the finished plan's weeks on Continue (`archiveCurrentWksIfPopulated`, as the trackOnly init does) or give the engine the planned-week-target predicate for the finished plan's weeks. (b) **Stale block state**: `s.sharpenBlock` is written only by `initializeSimulator`'s running race path; the triathlon, cycling and HYROX initializers and the trackOnly path leave it in place. `s.raceDayDurability` is also rewritten by `refreshBlendedFitness` (`blended-fitness.ts:823-824`), which clears it outside running race plans whenever the refresh reaches its forecast step (`s.rd`, `s.typ` and weeks remaining set; triathlon, cycling and HYROX states carry the `s.rd = 'marathon'` placeholder, and `raceDayPlanDurability` returns null for them and for trackOnly). The defect that follows keys on `s.sharpenBlock`. `welcome-back.ts:162` spares a taper landing week from the 3-week-gap 'base' relabel when `s.sharpenBlock` is set and `isSharpeningBlock(s.rd, trainingWeeks)`, and those modes store `s.rd = 'marathon'` as a placeholder, so a 1- to 7-week triathlon, cycling or HYROX plan built after a running block takes the running exemption. Proposed: clear both fields in those initializers, or gate the exemption on a running plan.

### ISSUE-371: Date-dependent test fixtures mix the UTC date with local-date code *(P3, 2026-10-08, test hygiene)* — OPEN

Three fixtures fail when the suite runs near UTC midnight: `src/calculations/hyrox-injury.test.ts` ('a blocked run removes the projected run gain', `eightWeekState`) and `src/ui/benchmark-checkin-planned.test.ts` ("prices into today's planned TSS", `todayIso`) take today from the UTC date while the code uses the local date, so they fail while the local date runs a day ahead of UTC (00:00 to 01:00 BST) and pass with `TZ=UTC`; `src/calculations/readiness-strain-sensitivity.test.ts` ('FIXED (ISSUE-263): the tri CTL pipe uses the SAME personal normalizer') dates its ride at 00:30 UTC today, so a run before 00:30 UTC sees a future activity and skips it. None touches the race-plan code. Build the fixture dates the way the code reads them.

> **2026-10-07 — Load-accounting batch 2, cross-mode fixes and defaults: follow-ups (ISSUE-330 → 353).** Raised in the implementer and reviewer reports for load-accounting batch 2 (CHANGELOG 2026-10-06), the cross-mode verification fixes (2026-10-06) and Tristan's cross-mode defaults (2026-10-07). Each is an open decision for Tristan or a defect found next to the changed code; several are pre-existing. Server-cached Strava rows stamped with the male β stay under ISSUE-318 (updated, not duplicated). None of the batch 2 or cross-mode fixes is marked fixed: they are unit-tested, not device-verified (`docs/DEVICE_TESTS.md`).

### ISSUE-330: HYROX cross sessions add no muscle-tendon load *(P3, 2026-10-07, decision 5a follow-up, needs Tristan's numbers)* — OPEN

A ticked or recorded HYROX cross session (bike, row erg, swim) now counts as load and as completed, but adds 0 MTL and does not move `resolveMtlAdherence`: the injury offers (`injury/modal.ts`, stored in `wk.adhocWorkouts`) carry no `musculoTendonLoad`, the MTL sums read `wk.triWorkouts` only (`mtl.ts computeWeekActualMTL`), and MTL factors exist for stations and runs only (`hyrox-constants.ts` `STATION_MTL_FACTORS`, `RUN_MTL_FACTORS`). Options: (a) accept 0 (cycling and swimming carry little eccentric load); (b) give the row erg offer an MTL from `STATION_MTL_FACTORS.row_erg` via `computeComponentMTL` and include planned adhoc offers in both planned and actual MTL sums; (c) new bike and swim factors, which need Tristan's numbers.

### ISSUE-331: Local-day filing leftovers *(P3, 2026-10-07, decision 6a follow-up)* — OPEN

Synced activities and the strain day use the local calendar day; these sites still do not. (a) "Today" keys built with `new Date().toISOString().split('T')[0]` (about 60 sites per the lane report), including the manual sleep and recovery entry writers (`main-view.ts`, `home-view.ts`) and every `physiologyHistory` lookup, while physiology entries are local-keyed: off UTC they read the neighbouring day for several hours daily (west of UTC every evening, east every morning). (b) Strava weekly history (`historicWeeklyTSS` and siblings) is bucketed by UTC Monday in `sync-strava-activities` (edge change plus deploy needed). (c) Onboarding snaps the plan start to the UTC Monday (`getMondayOf`, `persistence.ts:200`, called from `initialization.ts:311` and `:798`, `initialization.triathlon.ts:183`, `initialization.hyrox.ts:332`, `initialization.cycling.ts:125`): onboarding east of UTC between local and UTC Monday midnight snaps to the previous Monday. (Addressed in code by `cd6eb65`, 2026-10-07: every initializer writes `localMondayKey(now)` and a local `planCreatedAt`; not device-verified.) (d) `_resolveWeekForDate` (`fitness-model.ts:1410`) floors a local-noon millisecond difference, so after a spring-forward DST change Monday activities can map to the previous plan week in the rolling load history; fix with `calendarDaysBetween` on date keys. (e) Stored actuals are not re-filed.

### ISSUE-332: HYROX "Reduce session load" and suggestions *(P3, 2026-10-07, cross-mode decision 4, open)* — OPEN

HYROX now logs cross-training overflow with no modal, hides the Home "Reduce session load" button and the recovery advice sheet, and gets no day-after timing suggestions (the running ones targeted a phantom week). Decide: (a) keep log-only (what ships), or (b) build a HYROX version that shortens or swaps HYROX sessions, possibly with a readiness / overload path mirroring the triathlon one and timing suggestions on HYROX run sessions.

### ISSUE-333: AI Coach load numbers per plan *(P3, 2026-10-07, cross-mode decision 7, open; the AI Coach is switched off)* — OPEN

The triathlon and HYROX coach contexts send the Signal A running-style weekly target as `planned_week_tss` (about half the triathlon plan in build weeks; in race week 0.55 of the history median). The triathlon context pairs `tss_8_weeks` from `historicWeeklyRawTSS` (Signal B) with Signal A `week_tss` and `planned_week_tss` (`coach-context-builder.ts:477`). The tri plan skeleton sums `aerobic + anaerobic`, and tri and HYROX skeleton rows carry no `actual_tss` (running rows do). The coach swap tool still sets status 'replaced' on tri/HYROX sessions, which hides them from Home Today while planned-day TSS still prices them (`coach-tools.ts`). Options: (a) send each plan's own weekly load and the measured load so every coach figure is on one scale (triage recommendation); (b) leave until the coach is switched on.

### ISSUE-334: Just-Track history keeps the male β after a later sex answer *(P3, 2026-10-07, cross-mode decision 9, open)* — OPEN

Just-Track never asks the athlete's sex, so its Strava and Apple rows are stamped with β 1.92. A woman who later upgrades and answers reads about 1.23× high on that history. Options: (a) accept, as the known cached-history limitation (ISSUE-318); (b) re-stamp from Apple Health full history now, and Strava once the server change in ISSUE-318 lands.

### ISSUE-335: Triathlon off-ladder decisions *(P3, 2026-10-07, decision 3a follow-up)* — OPEN

(a) **Neuromuscular sprints (`bike_vlamax`)**: the approved vlamax to sweet spot mapping is not shipped, because `loadForBike` prices vlamax at 1.10 TSS/min and sweet spot at 1.5 (an 87-min session would go from 96 to 131 TSS under "Downgrade"). Since `isTriQualitySession` includes it, vlamax also lost its 15% overload trim. Options: keep holding back; apply sweet spot anyway; step to endurance (0.85, the only rung priced below it); or fall back to the 15% trim. (b) **Swap to easy on off-ladder kinds** (over-under, micros, hills, vlamax, open water) is not offered; decision 3 covered downgrades only. If approved, `tri-rpe-flag.ts`'s own keyword list also needs the shared classifier. (c) **Two sessions on one day**: the readiness and RPE gates pick today's first open session, so accepting a row brings back a row for the day's second session on the next launch (dismissing does not), and a brick first in the day hides a later quality session. Options: one row per eligible session in one modal, or record the answer per signal per day. (d) The overload modal shows a flat 50% for a swap to easy (`REPLACE_WITH_EASY_TSS_REDUCTION`); the applied swap takes about 63% of a threshold ride. Price it from the landing rung like the downgrade?

### ISSUE-336: Triathlon suggestion follow-ups *(P3, 2026-10-07)* — OPEN

(a) **Run RPE scale**: a suggestion-changed tri run writes running-generator RPEs (easy 3, marathon pace 6, threshold 7) while the tri generator writes easy 4, long 5/6, threshold 8, vo2 9, so the RPE-blown detector is one point stricter on a changed run. A tri-native scale needs Tristan's values for marathon pace and recovery. (b) **Threshold pace**: the tri generator writes threshold reps at easy ÷ 1.15 (`plan_engine.triathlon.ts:816`), the canonical factor is 1/1.20; aligning changes generator output (TRI_GENERATOR_VERSION bump). (c) **No power meter**: a downgraded bike keeps its HR-zone text ("Z4 / sub-threshold (≈100% FTP)") because only watt ranges are rewritten; the Adjust overlay has the same gap. (d) Swap and trim do not rescale description durations, because `scaleDescriptionProportional` misreads "1h 25min" and rewrites "/100m" denominators. (e) `estimateTriWorkoutMin` reads the largest single "Nmin" token (an 80-min threshold ride reads 15 min) and is the plan views' duration fallback.

### ISSUE-337: Triathlon volume-ramp suggestions are off *(P3, 2026-10-07, needs Tristan's decision)* — OPEN

`TRI_VOLUME_RAMP_SUGGESTIONS_LIVE = false` (`tri-suggestion-aggregator.ts:36`). Mid-week the check compared partial actuals with next week's full plan, and accepted trims compounded (87, 74, 63, 54 min). Pick a gate: (a) only once the week is complete, completed actuals against next week's plan; or (b) the last completed week against the current week's plan. Either way the plan's own deload-to-build rebounds exceed 10% (17 week pairs in a generated Ironman plan), so the anchor probably needs recent build volume. Also confirm the Push semantics (a pushed load leaves this week's overload count and counts once next week through the decayed carry) and that closing the overload modal counts as Keep.

### ISSUE-338: `applyTriEffortMultipliers` scales minutes without re-pricing load *(P2, 2026-10-07, pre-existing)* — OPEN

At every rollover rebake (`events.ts rebakeFutureWeeksInPlace`) `applyTriEffortMultipliers` (`effort-multiplier.triathlon.ts`) scales `estimatedDurationMin` by 0.85 to 1.15 and never re-prices `aerobic` / `anaerobic`, so the plan header and the tri forecast's planned dose are off by up to 15%, the CTL-gap re-anchor cuts no planned load, and the description keeps the unscaled minutes. Until fixed, the overload detector skips a downgrade that would raise a stale stored total (the readiness row still offers it). Proposed fix: scale load by new/old minutes (the Adjust overlay's rule); needs a TRI_GENERATOR_VERSION bump and moves the tri forecast.

### ISSUE-339: Possible next-week-as-current reads (1-based `s.w`) outside the fixed modules *(P2, 2026-10-07, pre-existing, verify each)* — OPEN

The cross-mode fixes corrected five tri detectors, the tri carry default, the MTL page and the effort scores. Sites flagged but not changed: `ui/hyrox/forecast-view.ts:650` (`s.wks?.[s.w ?? 0]`, "sessions this week") and `:834` (week label); `ui/hyrox/forecast-chip-detail-view.ts` (around `:418-422`); `calculations/hyrox-volume.ts:31` (starts at `wks[state.w]`, feeds `race-prediction.hyrox.ts`); `tri-adaptation-ratio.ts:74`, `:113`, `:181`, `:222`; `tri-discipline-confidence.ts:59`, `:78`; `tri-volume-by-discipline.ts:48` and its look-ahead helpers; `tri-skip-handler.ts` (not imported). Each needs checking against whether it means the week in progress.

### ISSUE-340: HYROX MTL decisions *(P2, 2026-10-07, needs Tristan's decision)* — OPEN

(a) **Cold-start rule**: confirm pre-plan weeks valued at the athlete's mean completed-week MTL with the ratio withheld for 14 days (alternatives: seed from the plan's prescription, or apply the floor only once the 42-day EMA settles). (b) **Build-entry weeks**: the plan's base-to-build MTL step puts a fully compliant athlete above 1.3 (Manage Load, readiness capped at 54) for 2 to 3 consecutive build weeks in several band and plan-length combinations (reviewer scan: 46 cases, none above 1.5). Smooth the generator step (version bump) or accept. (c) **"Training fitness" anchor**: plan-relative ratio is one-sided (cannot exceed 1), overlaps the Plan adherence factor, and leaves a compliant athlete at 0.5 in staleness; the alternative is a per-phase band anchor, which needs Tristan's numbers. (d) **HR in the HYROX execution loop**: matcher ratings are `deriveRPE` output, so a compliant watch-synced week 1 measured 0.97 and week 2 regenerated at 212 planned minutes instead of 220. Count only user-entered ratings, or leave? (e) **Forecast chip detail** (`ui/hyrox/forecast-chip-detail-view.ts:558-560`, `:597-598`) shows "MTL fitness" / "MTL fatigue" from the launch snapshot `hx.mtlCTL` / `hx.mtlATL`, while Stats reads the live `hyroxMtlAcwr`; they disagree after an in-session completion. Read `hyroxMtlAcwr(s)` there.

### ISSUE-341: HYROX plan structure follow-ups *(P3, 2026-10-07, mostly pre-existing)* — OPEN

(a) A pre-v14 bare rating under a name two sessions share stays under the name; neither session shows done, and a later Mark as Done can add the session a second time. (b) `regenerateHyroxWeek` (injury modal) replaces `triWorkouts` wholesale and drops user-added sessions, unlike the launch regen. (c) The add-session modal re-runs `scheduleHyroxWeek` over the whole week and can move placed or done sessions. (d) The station technique run finish uses an unrounded seed pace × 1.2 and ignores `hyroxRunPaceSecKm` (changing it needs a version bump). (e) Commute runs carry no `musculoTendonLoad`. (f) The GPS card match keeps only sessions with `discipline === 'run'` (`multiSportRunSessions`, `gps/recording-handler.ts:303`), so a GPS run started from a legacy HYROX run card without a discipline matches no card and takes the impromptu path. Mark as Done on that card does write a run record: `recordHxSessionDone` (`ui/hyrox/workout-detail-modal.ts:317`) goes through `plannedSessionRecordSport`, which falls back to `isPlanCardRunType(t)`. (g) HYROX initializing does not await startup syncs, so a backfill released when about-you is left may still be landing at plan initialisation.

### ISSUE-342: Home and coach readiness inputs differ *(P3, 2026-10-07, pre-existing)* — OPEN

Home uses today's `sleepScore`, `sleepDebtExcessSec`, an all-history `hrvPersonalAvg` and `capStrain.pctCapacity` when `todayTSS > 0`; `daily-coach.ts` uses the latest `sleepScore`, no `sleepDebtExcessSec`, a 28-day `hrvPersonalAvg` and `strain.capacityStrainPct` only when trained today. With recovery data the ring score (Home's readiness) and the label and sentence (coach readiness) can disagree. The MTL input was aligned on 2026-10-06; the rest needs one canonical readiness-input builder.

### ISSUE-343: In-app completion valuation and dose *(P3, 2026-10-07)* — OPEN

(a) Mark as Done and every no-HR actual are valued at `TL_PER_MIN[rated RPE]` (easy run at RPE 3: 0.65 TSS/min) while planned sessions use the type row (0.92), so a ticked easy run reads about 71% of its planned load. Use `plannedTssPerMin(type)` for in-app completions? (b) Gym quick done for the total_beginner, beginner, novice and returning templates logs 0 load: `getBeginnerTemplates` / `getNoviceTemplates` (`workouts/gym.ts`) set no `estimatedDurationMin`. A per-template duration or a stated rule is needed from Tristan. (c) Tri per-discipline CTL deposits a tick at its planned `aerobic + anaerobic` (`manualDoneTriActivities`) while load surfaces use `TL_PER_MIN[rated]`. (d) A brick tick is one cycling-tagged record, so its run leg takes the cycling runSpec in Signal A. (e) `computeTodaySignalBTSS` values a no-HR actual at `TL_PER_MIN[5]` whatever its rating, while weekly Signal B uses the rating. (f) A rated strength session with HR is priced by its RPE tag in Signal B but by iTRIMP in tri fitness. (g) Should in-app GPS runs feed race prediction, durability and VO2? (h) Should Mark as Done or GPS on running-mode non-run cards carry load? (i) Completions made before 2026-10-06 have no record (no backfill).

### ISSUE-344: In-app supersede edge cases *(P3, 2026-10-07)* — OPEN

(a) The stale-pending resolver (`activity-matcher.ts`) turns an unreviewed current-week cross-day run into an extra at rollover without checking in-app records, so a ticked session done on another day counts twice. (b) A cross-day completion whose watch copy falls in another plan week is not merged. (c) On a double-run day, a watch copy of the other run can supersede the first run's Mark as Done record in the matcher; a planned-distance tie-break would resolve most cases. (d) A tri session ticked before its planned day is stamped now (`manualCompletionStartIso`), and `reconcileTriCompletions` moves the card to today. (e) Mark as Done on a tri card already completed by the fuzzy matcher or brick detection stores a rating that can differ from the activity's effort; hide or relabel it as rate-only? (f) The HYROX station upgrade overwrites the slot's rating with `deriveRPE(row)`, while the run, ride and swim supersede keep the user's rating. (g) An in-app GPS run can count twice in tri run CTL for one launch when its watch copy is already in `garmin_activities` but has not yet superseded the local record (`main.ts` reads both before any sync). (h) A separate same-day Strava strength session of similar length can replace a HYROX station quick done through the Strava upgrade loop.

### ISSUE-345: Strava and Apple source follow-ups *(P3, 2026-10-07)* — OPEN

(a) If `stravaConnected` is true but the tokens were revoked server-side, Apple workouts stay off and no Strava activities arrive; the launch self-heal only flips the flag on. (b) Same-type matching compares raw `activity_type` (MOUNTAIN_BIKING vs CYCLING matches only on duration); widen to the sport class everywhere, DB cleanup included? (c) `previousPlanWks` archives are not scanned for Apple twins, and `restoreHistoryFromServer` copies Apple twins into archives until the DB cleanup deletes them. (d) The forced DB cleanup uses 90 days, so DB twins older than that still double count in the server's 52-week history aggregate; a one-time 364-day pass? (e) Confirm the Account copy ("Sleep and recovery. Workouts come from Strava.") and that HealthKit VO2max and cycling FTP keep refreshing for Strava users. (f) When the user had placed the Strava copy as an extra, the Apple slot now binds to it and the extra entry goes (the matcher writes the same pointer for a user choice and its own placement).

### ISSUE-346: Sync parity follow-ups *(P3, 2026-10-07)* — OPEN

(a) `mergeTimingMods` is not run after Apple syncs (`appleHealthSync.ts:815`); the Strava path runs it before the pending step. (b) Strava's zero-row branch has an empty block where the review-guard reset should be, and neither Strava nor Garmin has the wizard guard; replace both inline blocks with the shared helper? (c) `fitImport.ts` and `screenshotImport.ts` test the `{ changed, pending }` result of `matchAndAutoComplete` for truthiness (always true / never fires); decide the intended duplicate-import behaviour first. (d) Running and fitness users whose Strava profile has no sex now start the 52-week launch backfill at review, so it can overlap the review step's own backfill and hit Strava rate limits. (e) The trimp sex gate's module comment still says only the latest 14 Apple days are re-read; the window is 28 since S2. (f) The tri DB-empty Apple sync (`main.ts`) runs the pending step before the plan-anchor reconcile and `advanceWeekToToday`.

### ISSUE-347: Activity type mapping decisions *(P3, 2026-10-07)* — OPEN

(a) Apple core training maps to strength (gym bucket, can fill a gym slot); the alternative is a CORE_TRAINING type at generic_sport. (b) Kickboxing maps to boxing (alternative: martial arts). (c) No SPORTS_DB row, so generic_sport cost: golf (keeps the walking cost through the walk class; activity detail shows generic_sport), volleyball, squash, badminton, racquetball, table tennis, cricket, softball; rows need Tristan's numbers. (d) `WHEELCHAIR_PUSH_RUN`: walking in review, but `deriveSportFromActivityType` reads RUN and gives extra_run (runSpec 1.0) in activity detail and Signal A. (e) The Strava edge maps Hike/Snowshoe to WALKING, Canoeing to ROWING and Elliptical/StairStepper to INDOOR_CARDIO (deploy needed). (f) A walk with no sport-named cross slot is still proposed into the closest generic cross slot by day on the matching screen. (g) The deprecated pre-iOS 14 Apple `.dance` type stays unmapped.

### ISSUE-348: Week targeting and the stored totals left after B18 *(P2, 2026-10-07)* — OPEN

(a) A last-week re-review still moves the activity into the current week: `applyReview` and `showMatchingEntryScreen` hard-code `s.wks[s.w - 1]` while `openActivityReReview` undoes the week it was given, and the undo leaves the adhoc's `garmin-<id>` record in last week, so Signal B (and `computeWeekActualTSS`) counts it in both weeks. (b) `wk.actualImpactLoad` is still a stored add-only total with the same re-review drift. (c) `wk.carriedTSS` has no live reader (only the dead main-view `updateCarryBanner`); delete it with the dead main-view load functions? (d) The Sleep page's hard-week insight reads `recentWeeksActualTSS` while the Home coach's copy reads `s.historicWeeklyTSS` (Signal A, completed weeks); make both read one source and decide whether the window includes the current week. (e) Holidays confirmed before 2026-10-06 keep a snapshot taken from the old stored total. (f) Account → Rebuild plan drops each week's `adhocWorkouts` and `unspentLoadItems`.

### ISSUE-349: Running plan-change follow-ups *(P3, 2026-10-07)* — OPEN

(a) The silent Tier-1 trim and timing suggestions skip bridge-scaled sessions, so in a bridge week the trim usually finds no target; or trim bridge sessions from their plan distance? (b) In illness and bridge weeks the suggestion modal lists plan distances ("8km to 6km") while the card shows scaled ones. (c) Confirm the debrief line "Keep ramping carries over from last week." (d) Sessions with a user Adjust mod are left out of every automatic cut; only the readiness action may replace them. Confirm. (e) The Adjust overlay's `INTENSITY_LADDER` (`workout-scaling.ts`) still emits 'marathon' and appends its mod instead of upserting. (f) `next()` still counts makeup sessions the Plan does not show as unrated (audit X12 bug 9). (g) Legacy mods without a `workoutId` stack after a drag-move. (h) ACWR undo is same-day only.

### ISSUE-350: Downgrade ladder follow-ups *(P3, 2026-10-07)* — OPEN

(a) Two-step tiers (100+ TSS) move two categories; should every downgrade be exactly one category with only the distance cut scaling? (b) A steady long run one step down is typed 'recovery', so it stops being the long run (`isLongRun` false) and is never cut further; keep 'long' with a recovery-pace description instead? (c) The user Adjust control keeps its own ladder (emits 'marathon', RPE easy 4 / vo2 9, no-op for marathon pace, float and progressive). (d) The suggester writes the 'steady' pace for threshold to marathon pace while the timing check writes marathon pace; which? (e) Legacy 'mixed' now steps to easy. (f) Other downgrade writers still jump categories or write non-generator RPEs: the readiness "Recovery: downgraded to easy" (`events.ts`), the holiday bridge (`holiday-modal.ts`) and the coach tool (`coach-tools.ts`). (g) `buildReduceAdjustments` passes 2 and 3 have no used-id dedupe; a cut long run's floor is measured from its current km, so repeated heavy sessions ratchet it to `MIN_LONG_KM`; Replace can still delete a quality session. (h) `suggestion-modal.ts` labels a downgrade to 'recovery' as "lower intensity".

### ISSUE-351: Just-Track follow-ups *(P3, 2026-10-07)* — OPEN

(a) Home's Just-Track This week card (`home-view.ts buildTrackOnlyThisWeek`) keeps its own loop: it adds the planned km of un-done generated sessions and drops skip-rated ones, so it can disagree with the Plan tab's `trackOnlyWeekLog` (one-source rule). (b) Should a skip-rated generated session count as done (the Plan tab and Home Recent count it; Home This week does not)? (c) Pending synced activities are left off the Plan tab card. (d) `downgradeToTrackOnly` (Account "Switch to Just-Track", Home post-race banner) keeps `onboarding.trainingMode`, and `initializeSimulator` forks on triathlon, cycling and HYROX before it checks `trackOnly`, so those plans are rebuilt instead of switched. (e) Every plan init branch clears `s.trackOnly` before it writes the plan; if generation throws, Return to plan cannot restore Just-Track. (f) Cross-training overflow in Just-Track still opens the running suggestion modal with no adjustments ("No changes to your running plan."; `activity-review.ts` `applyReview` and `autoProcessActivities`).

### ISSUE-352: Cross-training overflow side effects in triathlon and HYROX *(P3, 2026-10-07)* — OPEN

(a) Overflow sent through `redirectToTriSuggestionFlow` records no leg load at review time; `reconcileRecentLegLoads` backfills it only at launch, when the leg-load view opens or after a Garmin-webhook sync, so a long ride or hike reviewed after a Strava or Apple sync is missing from the readiness leg-load signal until the next launch. Call the existing idempotent `reconcileRecentLegLoads` there (both modes). (b) The triathlon redirect skips the RPE prompt that HYROX now reaches; give tri the same continuation?

### ISSUE-353: Pre-existing items noticed in the cross-mode triage *(P3, 2026-10-07, not scheduled)* — OPEN

(a) Triathlon and HYROX Skip never moves the session to next week (agreed rule: a skip pushes, a second skip drops). (b) General-fitness plans prescribe the race-week primer in the last week of each block (addressed in code by `6a965e5`: `isRaceWeek` is false in continuous mode, so no block week gets the primer; not device-verified, DEVICE_TESTS "Continuous plan Deload week"). (c) The "Review FTP" button on the bike prompt opens running test options. (d) A cyclist's holiday return mentions run fitness.

> **2026-10-05 — Load-accounting batch 1 follow-ups (ISSUE-317 → 329).** Raised by the implementers and reviewers of lanes A, F and M (CHANGELOG 2026-10-05; audit pack `docs/audits/2026-09-load-accounting/`, untracked and local to Tristan's working tree until he decides whether to commit it). Each is either an open decision for Tristan or a defect found next to the fixed code. None of the batch 1 fixes is marked fixed here: they are code-complete and unit-tested, not device-verified (`docs/DEVICE_TESTS.md`).

### ISSUE-317: Weekly load target in taper: race week to 0.55, and the target vs the generated sessions *(P2, 2026-10-05, audit A10/A11 follow-up)* — OPEN, (a) in code since 2026-10-06, awaiting device verification

(a) **Decided by Tristan, 2026-10-05: race week reaches 0.55. Code change in batch 2 (`cb05a86`, 2026-10-06), not device-verified.** `resolvePlannedWeekPhase` now passes a 1-indexed taper position, so the running part of the target steps 0.75 / 0.65 / 0.55 (3 weeks) or 0.70 / 0.55 (2 weeks); SCIENCE_LOG §CH and FEATURES §27 updated. (b) **Open.** The target is a history baseline × phase multiplier (plus the cross-training budget), not the sum of the generated sessions, and the shapes differ: the running generator's taper is near-flat (raw probe, 18-week marathon, advanced, VDOT 55: 250 / 246 / 237 TSS against a build mean of 307, about 0.81 / 0.80 / 0.77). The direction of the gap depends on the athlete. The audit probes, run on the 0-indexed ramp (0.85 / 0.75 / 0.65), put the target 30 to 45% above the prescribed run TSS, so a taper done to plan read under target. The 1-indexed ramp lowers each taper week's target to 0.79 to 0.88 of its old value (0.88 / 0.87 / 0.85 over 3 weeks, 0.82 / 0.79 over 2), which narrows that gap; the probes were not re-run. On the new ramp, an athlete whose history median equals the generated build level reads about 40% over in running race week. Needs a call on which side moves (target follows the generated week, or the generator follows the ramp). (c) **Open.** The cross-training budget (`sportBaselineByType`) is not phase-scaled in deload or taper weeks (pre-existing; pinned by `fb1ca07`); should it take the multiplier, and do swim and bike belong in a cross-training budget in triathlon mode? (d) **Open.** A 1-week taper keeps 0.70 (running plans of 8 weeks or fewer; Sprint 12 or fewer; Olympic 16 or fewer or 28 to 29; 70.3, T100, Ironman and HYROX 10 or fewer); should it reach 0.55? (e) **Open.** Race week reads over target more often (the race counts toward it), so the Adjust-week strip (above 15 TSS of excess) is more likely in race week and its modal sizes cuts to the larger overshoot: exempt race week, or leave the race out of the comparison? (f) Load & Taper copy says "Volume drops 30 to 50%"; the running-term cut is now 25 to 45%. Key file: `src/calculations/planned-week-target.ts`.

**Note 2026-10-14 (lane tri-taper, `5068d8b`):** triathlon and cycling plans now read their own taper fractions in the weekly target (`triTaperFraction`: Signal A 0.55 then 0.30, 0.55 for a one-week taper; `planned-week-target.ts:192`), the shares their generator builds the taper with, which narrows (b) for those modes. (c) still applies: Signal B tapers only its running term, so a triathlete's race-week settle target reads 0.77 of a base week and a cyclist's stays near a base week (ISSUE-400 (j)). (d) is stale: a one-week taper has targeted 0.55 since `5e5aa88` (2026-10-07), and the triathlon one-week taper is now sprint, low-hours Olympic and plans shorter than their taper plus 2 weeks. Running and HYROX unchanged.

### ISSUE-318: Female Strava rows the server cached with the male β read about 1.23× high *(P2, 2026-10-05, audit B12 follow-up, needs Tristan's decision)* — OPEN

The normaliser now uses the athlete's own β (SCIENCE_LOG §CI). Strava rows the edge function stamped with β 1.92 before the athlete's sex was known keep it: `sync-strava-activities` caches `itrimp` permanently and stores no per-row β. This covers every existing Strava-onboarded woman's onboarding backfill (up to 52 weeks; the 99 most recent HR activities are stream-tier) and connect-step 28-day sync rows where Strava supplied no sex. They now read about 1.21× to 1.25× high (123.5 TSS per hour at LTHR at the audit profile; they read correctly before the fix) and feed plan-week actuals synced during onboarding, triathlon per-discipline CTL from history (`tri-benchmarks-from-history.ts`) and intensity calibration (`stravaSync.ts`). The client cannot correct them. **Options**: (a) add a `beta_used` column (migration plus edge change) so the client can rescale, or the server can recompute when it differs from the resolved sex; (b) a one-time edge re-stamp mode that recomputes `itrimp` from stored HR for rows whose sex was unknown; (c) accept it and let the rows age out of the 42-day CTL window. New rows stop accruing: since 2026-10-06 (F8, `bb9577c`, `fb8fd3e`) the onboarding syncs that ran before the sex question are held until it is answered (`src/data/trimp-sex-gate.ts`), so this issue covers rows cached before that build (and Just-Track history, ISSUE-334). A client-side alternative to (a)/(b): re-run the backfill with a force flag for rows whose stamped sex differs. Any edge change is a scoped deploy by Tristan (never `supabase db push`). Reach today: Strava is capped at 10 beta athletes.

### ISSUE-319: Normaliser follow-ups: female fallback, server history scale, persisted totals *(P2/P3, 2026-10-05, audit B12 follow-up, needs Tristan's decision)* — OPEN

(a) **Female population fallback.** 15000 (used when the HR profile is missing or implausible) has no stated HR profile behind it: the original comment (`8b07156`) says only "typical LTHR_HRR for average athlete", and the "≈ 84%-HRR" reading in SCIENCE_LOG §BP is a later back-solve. It was left sex-neutral, so women on the fallback still read about 0.81×. Option: treat it as "the same HRR at LT for both sexes", h0 ≈ 0.8364 (the solution of 3600·h0·e^(1.92·h0) = 15000, to 4 decimal places), giving a female fallback of 3600·h0·e^(1.67·h0) ≈ 12,170 (×0.811). Approve that, or keep 15000 for everyone? (b) **Server history scale.** The edge function's history mode divides by a fixed 15000 for every user (`sync-strava-activities/index.ts`), so the server-computed `historicWeeklyTSS` that seeds the CTL baseline sits on a different scale from client-recomputed weeks; for women the gap widened by up to 1.25×. (c) **Persisted totals.** Largely resolved by batch 2 (F6, 2026-10-06): `wk.actualTSS` is retired and stripped on load, and week actual load is derived from the activities, so carry, the holiday modal, main-view historical loads and the coach context no longer read a pre-fix stored total. Left: `holidayState.preHolidayWeeklyTSS` snapshots taken before that build, and `wk.actualImpactLoad` (ISSUE-348).

### ISSUE-320: Signal A open decisions: HIIT runSpec, coach trend signal, reclassified strength sessions *(P3, 2026-10-05, audit B3/X7 follow-up, needs Tristan's decision)* — OPEN

(a) **HIIT** now resolves to strength (runSpec 0.35, the matcher's gym bucket). The edge `getRunSpec` uses 0.30 and `deriveSportFromActivityType` alone says generic (0.40). Confirm 0.35. (b) **Coach `ctlTrend`** now compares Signal B with Signal B (`computeSameSignalCtlHistory`), matching `ctlNow` and the readiness TSB beside it. The design doc's decision 7 suggested Signal A at both ends, which needs a live Signal A "now" that does not exist. Confirm B, or ask for A. (c) **A rated strength session the user reclassified** to another sport (`manualSport`, e.g. padel) still takes the strength RPE override in both signals, because `computeStrengthRpeTSS` runs before sport resolution and `isStrengthActual` only checks `manualSport === 'strength'`. This predates batch 1 and is documented. To honour the reclassification, gate `computeStrengthRpeTSS` on `!manualSport || manualSport === 'strength'` so both signals change together.

### ISSUE-321: History seed runSpec tables disagree with SPORTS_DB *(P2, 2026-10-05, audit X9 follow-up)* — OPEN

Live Signal A now weights each activity by `SPORTS_DB[sport].runSpec`. The history seeds that set the CTL baseline use their own tables, so a per-sport step in running CTL remains at plan start for athletes whose history holds these sports (full list in SCIENCE_LOG "Signal A vs Signal B"). **Strava edge `getRunSpec`** (`supabase/functions/sync-strava-activities/index.ts`), compared after the edge's own `mapStravaType` against the live `resolveActualSport` → SPORTS_DB: Workout, sail, surf, windsurf, kitesurf and skateboard (CARDIO) 0.55 vs generic 0.40; walk, hike and snowshoe (WALKING) 0.40 vs walking 0.30; wheelchair 0.40 vs walking 0.30; weight training and CrossFit 0.30 vs strength 0.35; HIIT 0.30 vs strength 0.35; tennis, squash, badminton, table tennis and racquetball 0.45 vs tennis 0.50; pickleball 0.40 vs tennis 0.50; boxing and kickboxing 0.30 vs 0.25; nordic and backcountry ski 0.75 vs skiing 0.50; alpine ski and snowboard (ALPINE_SKIING) 0.55 vs skiing 0.50; stand-up paddling 0.40 vs paddleboard 0.25; kayaking 0.40 vs 0.20; rock climbing 0.40 vs climbing 0.15. History mode also reads rows other sources wrote to `garmin_activities` with their own type strings (Garmin webhook, Apple upload); those go through the same `getRunSpec` and are not enumerated here. **Apple and FIT aggregator `mapActivityTypeToSportKey`** (`src/data/appleHealthSync.ts`, feeds `aggregateHistoryFromRows`): only nine types map to their SPORTS_DB row and the rest seed at generic 0.40, so FIT trail and treadmill runs seed at 0.40 (and miss running km) but count 1.0 live, indoor cycling 0.40 vs 0.55, open-water swim 0.40 vs 0.20, Apple yoga 0.40 vs 0.10, tennis 0.40 vs 0.50, basketball 0.40 vs 0.45, martial arts 0.40 vs 0.30, paddleboarding 0.40 vs 0.25. Fix direction: both seed paths resolve the sport with `deriveSportFromActivityType` and read SPORTS_DB. The aggregator fix is client-only; the edge fix needs a scoped deploy by Tristan.

### ISSUE-322: In-app GPS runs and manual logs count 0 in Signal A *(P2, 2026-10-05, audit B9, pre-existing)* — OPEN, code change in batch 2, awaiting device verification

`listWeekSignalAEntries` counts `garminActuals` and `garmin-` adhoc entries only. A run recorded in the app or logged manually (non-`garmin-` adhoc id) contributed 0 to Signal A (running CTL, race prediction inputs, the CTL-gap re-anchor) while Signal B counted it, and the re-validation (`docs/audits/2026-09-load-accounting/REVALIDATION.md`, B9, local and untracked) found an in-app GPS run scored a flat 35 weekly Signal B whatever its distance. **Batch 2 (M3, 2026-10-06/07)**: a GPS run, a run-card Mark as Done, a HYROX quick done and (since 2026-10-07) a tri, cycling or Just-Track tick write a `guided-` `garminActuals` record, valued at its own duration × `TL_PER_MIN[rated RPE]`, so it counts in both signals (FEATURES §20c, SCIENCE_LOG §CN). Still open: completions stored before that build have no record and count in Signal B only; in-app GPS runs are still excluded from race prediction, durability and VO2 (ISSUE-343(g)). Not device-verified.

### ISSUE-323: Week debrief CTL reads an archived-plan week after a plan reset *(P2, 2026-10-05, pre-existing, found during lane F)* — OPEN

`week-debrief.ts:184-185` reads `metrics[weekNum - 1]` (and `metrics[weekNum - 2]` for the delta), but `computeFitnessModel` returns archived-plan weeks first when `previousPlanWks` is passed. For any user with an archived plan, the debrief's Running Fitness value and delta come from the wrong week. Fix: index from the end of the array, or pass the live-plan offset.

### ISSUE-324: Load surfaces still disagree in edge cases *(P3, 2026-10-05, audit B3/B19/B20 follow-ups)* — OPEN

(a) The per-day Signal B builders disagree on a no-HR twin: `buildDailySignalBTSS` (sleep target, sleep debt) gives the twin 0 and counts the adhoc RPE estimate, while `computeTodaySignalBTSS` gives the twin duration × `TL_PER_MIN[5]` and skips the adhoc. Unifying them means one per-day Signal B helper. (b) `computeLoadBreakdown` (Home, Load & Taper) has no strength RPE override and no double-day bonus, so its segments do not sum to the headline in those cases. (c) The main-view run-km bar counts a twin with no slot as running km (display only). (d) Re-review undo leaves `${id}_surplus` items behind (audit B19). (e) Slot fills in `activity-review.ts` do not store `activityType` (design 4e), so Signal A falls back to the `displayName` label for them.

### ISSUE-325: Dead load code to delete *(P3, 2026-10-05, cleanup)* — OPEN

Left untouched by batch 1, recommended for deletion (or rewiring to the canonical helpers if revived): (a) `excess-load-card.ts:computeWeightedRunSpec`, no caller; it has the old garminId-suffix-only pairing and its own runSpec resolver. If revived it should read `listWeekSignalAEntries` and `computeWeekRawTSS`. (b) Stats `buildTSBLineChart`, `buildACWRTrendChart`, `buildCTLCard`, `buildFitnessDetailPage`, `buildCTLMetricPage`: their hosts (`buildReadinessDetailPage`, `buildStatsScroll`, `renderFitnessDetail`) have no callers. (c) Home momentum in `buildReadinessRing` (per the implementer, computed but not rendered; confirm before deleting) still pairs Signal B now with Signal A history; use `computeSameSignalCtlHistory` if revived. (d) `computeACWR`'s weekly-EMA fallback still pairs Signal A CTL with Signal B ATL; unreachable while `planStartDate` is set. (e) Added 2026-10-07: Home `buildProgressBars` (`home-view.ts:679`) has no caller, the `home-tss-row` click handler and the refresh checks for that id look for an element nothing renders, and `renderExcessLoadCard` / `wireExcessLoadCard` have no caller; together they make `computePlannedWeekTarget`'s caller list look wider than what users see. (f) `wk.carriedTSS` and the main-view load, ACWR and carry functions that read it are dead (ISSUE-348(c)). (g) The optional `hyroxConfig.weeklyActualMTL` type field has no writer or reader since `bfd89a8`.

### ISSUE-326: Benchmark check-in results are never recorded automatically *(P2, 2026-10-05, pre-existing, found during audit B8 fix)* — OPEN

A chosen continuous-mode check-in now shows as an "Added" planned card and no longer counts as load. The synced run is still not matched to the check-in card, and `recordBenchmark` (`events.ts`) has no in-app caller, so the check-in's result never reaches `benchmarkResults`. FEATURES §24 Continuous Mode now documents this gap and points here.

### ISSUE-327: Apple physiology open decisions: daytime naps and the HRV daily value *(P3, 2026-10-05, audit X4 decisions D3/D4)* — OPEN

From `docs/audits/2026-09-load-accounting/load-fix-designs.md` (X4 decisions; local and untracked, see the batch note above). **D3**: with the noon boundary, naps between 12:00 and 23:59 fold into the following night, and the tail of a lie-in past noon moves to the next night. Keep that (no new constant), or exclude sessions ending between noon and an evening cut-off Tristan provides? **D4**: the HRV daily value is the day's last SDNN reading × 1.28. Use the last reading, the mean over that night's sleep window (closest to Garmin's overnight HRV), or the daily mean? And should the ×1.28 SDNN→RMSSD factor stay? Short-term norms (Nunan et al. 2010) put RMSSD below SDNN, which contradicts a factor above 1; it only matters for the absolute thresholds in `rmssdToHrvStatus`.

### ISSUE-328: Timing-check long sub-ladder steps a long run to marathon pace on a 1-step downgrade *(P3, 2026-10-05, found during audit X5 fix)* — OPEN, code change in batch 2, awaiting device verification

In the timing-check long-run sub-ladder (`stepDownLong`), a 1-step downgrade turned the long run into a marathon-pace long run (2 steps gave easy); for an easy-paced long run the 1-step result was an intensity increase, and the fast-finish long run inherited it. **Batch 2 (P2, `0997f68`, 2026-10-06)** removed the sub-ladder: `stepDownRunType` on the canonical ladder (`src/constants/intensity-ladder.ts`) sends a fast-finish long run one step down to an easy long run at the same distance and a steady long run to recovery pace (FEATURES §18b timing, SCIENCE_LOG §CO). Not device-verified. Follow-ups in ISSUE-350. Key file: `src/cross-training/timing-check.ts`.

### ISSUE-329: Unseeded ACWR: days before a data source covered the athlete count as zeros *(P3, 2026-10-05, audit B1 follow-up)* — OPEN

Batch 1 treats days no plan week covers as missing for athletes with no Signal B seed. In-plan days before a data source started covering the athlete (Apple's 14-day lookback, a mid-plan connection, mid-week onboarding without a backfill) still count as observed zeros, which can read as a ramp. Separately, the observed-baseline fill assumes pre-plan load matched the observed baseline, so a true beginner ramping from zero no longer flags. SCIENCE_LOG "Rolling 7d/28d Load Computation" lists both.

> **2026-06-16 — Persona-QA sweep batch (ISSUE-288 → 296).** Surfaced by `/persona-qa` (all groups) after the triathlon distance/intensity build, then confirmed by a dedicated triage pass. All are **pre-existing and unrelated to the triathlon work** (that work was verified clean). Triage also **debunked these as false positives** (do NOT re-investigate): Tier-3 overload modal "never fires" (it fires from `activity-review.ts`, a separate path); "no home overload badge" (the readiness "Manage Load" label + daily-coach `stance: 'reduce'` cover it); "notify-once modals re-fire" (debrief is mitigated by ISSUE-273's forced-Continue; suggestion/coach intros are gated); HYROX holiday bridge-field loss (bridge mods are runtime-only, re-applied at render); "debrief Accept gates adaptation" (CTL re-anchor applies on rollover regardless); "VDOT not updated from race result" (intentional asymmetry, documented in `run-race-outcome.ts`).

### ISSUE-316: Strava disconnect must purge stored Strava data within 30 days *(P1 — compliance, 2026-08-04, Strava application prep)* — OPEN

The Strava API Policy §7.4 requires deleting a user's Strava data within 30 days of revocation, with written confirmation (§2.5). Both support pages now promise exactly that. But disconnect (`account-view.ts:2511`) only deletes the `strava_tokens` row; `strava-` prefixed rows in `garmin_activities` and in state survive. **Needed**: (1) purge of `strava-` rows (server + local state) on in-app disconnect, (2) handle Strava's deauthorization webhook for revocations made on strava.com, (3) confirmation email once the purge completes. Until built, fulfil manually when a disconnect happens. Related open question (flagged 2026-08-04, unresolved): §6.2's 7-day cache limit vs long-term storage of Strava activities — raise with developers@strava.com if pursuing Extended Access.

### ISSUE-315: New account on a used phone inherited the old account's plan *(P1, 2026-08-04, Tristan on device)* — ✅ fixed in code, pending device verification

**Symptom.** Signed out of account 1, signed up account 2 on the same phone → account 2 showed all of account 1's data instead of the wizard.

**Root cause.** The account-required sign-out fix cleared **disk but not memory**: `clearState()` removes localStorage keys, but the in-memory store (`state/store.ts`) and every background sync timer survive because the page never reloads. `savePlanSettings()` reads `getState()` and upserts under *whoever is currently signed in* — so the first of ~425 `saveState()` call sites to fire after account 2 signed in re-persisted account 1's in-memory state to disk AND uploaded it as account 2's cloud backup, re-stamping the owner and defeating the owner-mismatch check. The leak then lives server-side: account 2's `user_plan_settings` row genuinely contains account 1's snapshot.

**Fix.** Hard reload at every account boundary: `SIGNED_OUT` → clear + `window.location.reload()` (bootstrap lands on the auth wall); `SIGNED_IN` for a different user → owner-mismatch wipe + reload (bootstrap restores the new user's backup or falls to the wizard). The reload kills in-memory state, timers, and in-flight syncs — the only reliable isolation in a long-lived page. Account-deletion toast survives the reload via a one-shot localStorage flag shown on the auth wall. Loop-safe: post-reload duplicate SIGNED_IN is suppressed by the launchedUserId check.

**Residue.** Any account created during the buggy window may carry another account's snapshot server-side (Tristan's test account 2 does). Purge those `user_plan_settings` rows manually.

> **2026-07-26 — Full persona-QA sweep (all 25 personas), ISSUE-304 → 314.** Run after the injury/Today-card fixes. Every P0/P1 claim was re-verified against code before filing; several agent claims were **debunked** (do NOT re-investigate): "debrief ✕ re-fires every launch" (no `debrief-cancel` button exists in any HTML — orphaned handlers, now deleted); "trackOnly Complete-Week crash" (wks defaults to `[]` in getDefaultState → safe early-return; defensive guard added anyway); P02 full-triathlete, P07 hyrox-injury, P23 post-race, P24 general-fitness traced **clean**. Fixed same-day: ISSUE-304 (HYROX week-pointer deadlock), P04 hyrox countdown in plan-view header, P09 tri Home Today card now routes through `resolveTriWeekWorkouts` (illness/holiday mods reach Home).

### ISSUE-304: HYROX (and track-only) week pointer clamped to week 1 forever *(P1, 2026-07-26, persona P08)* — ✅ fixed in code, pending device verification

The launch-time debrief gate (`main.ts` ~1044) clamps `s.w` back to `lastCompleteDebriefWeek + 1` on EVERY launch (only the v3 reseed is one-time) and exempted only `triathlon`. HYROX never fires the running plan-preview debrief (`week-debrief.ts:75,115` bar hyrox) and nothing else advances `lastCompleteDebriefWeek` (initialization seeds 0), so a HYROX athlete's week rolled forward via `advanceWeekToToday` and was immediately dragged back to week 1 — the plan froze at week 1 permanently. **Fix**: exempt `hyrox` and `trackOnly` alongside `triathlon`.

### ISSUE-305: No downward benchmark revision — a wrong-high FTP/CSS never self-corrects *(P1, 2026-07-26, persona P21, needs Tristan's design call)* — OPEN

The benchmark pipeline is upward-only by design (`tri-benchmarks-from-history.ts`; SCIENCE_LOG notes the deliberate no-downward rule for max-HR). A user who enters FTP 350W / CSS 1:00 gets: every session at unexecutable targets; the effort multiplier can only trim duration ±15% (`effort-multiplier.triathlon.ts:142`), never the watt target; the 3-week high-RPE prompt (`triathlon/plan-view.ts:1449-1497`) is advisory-once with no persistent badge; the race forecast shows a sub-3h 70.3 as fact with no plausibility caveat. Candidate fix respects the existing provenance system: chronic (powerAdherence < X over N weeks + RPE ≥ 8) → propose a derived-downward FTP as a suggestion modal (never silent). Constants need Tristan.

### ISSUE-306: Tri injury — past-week excused runs counted against adherence; dropped runs unexplained *(P1/P2, 2026-07-26, personas P22/P10)* — OPEN

(a) `computeTriPlanAdherence` counts planned runs from weeks generated before the injury (past weeks keep original runs — `plan_engine.triathlon.ts` isPastWeek skips gates) with zero actuals → adherence drags despite medical excuse; `resolveTriDisciplineAdherence` (`fitness-model.triathlon.ts:207`) checks only the *current* week's injury, not the injury state at the scored week's time. (b) When run capacity = 0 the runs are silently absent from the plan — no "Run. Paused" card (the `renderInjuryRestCard` path at `triathlon/plan-view.ts:1062-1076` is unreachable because dropped runs never appear in the list), no session-count explanation, brick silently vanishes (`plan_engine.triathlon.ts:676`).

### ISSUE-307: Ghost user — debrief-gate clamp corrupts detraining accounting *(P2, 2026-07-26, persona P12, running mode)* — OPEN

`advanceWeekToToday` applies VDOT detraining proportional to `actualAdvance = s.w - oldW` (`welcome-back.ts:140-147`), but the every-launch debrief clamp (`main.ts` ~1044) can pull `s.w` back before/after, making detraining timing-dependent (a 4-week absence can detrain 0 weeks); `detrainApplied` (`welcome-back.ts:154-162`) then suppresses the CTL-gap re-anchor even when the clamp only allowed a 1-week advance. ISSUE-304's fix removes this interaction for HYROX/track-only but running-mode ghosts still hit it. Needs a decision on ordering (clamp before detraining, or detrain on calendar gap not pointer delta).

### ISSUE-308: Debrief "changes" list understates/misattributes volume reductions *(P2, 2026-07-26, personas P16/P15)* — OPEN

`week-debrief.ts:1034-1040` computes the "Volume scaled down N%" annotation from the effort multiplier alone; when the CTL re-anchor is also active the real clamped reduction is larger (e.g. eMult 0.88 + ctlRatio 0.70 → annotation "12%", actual floor 0.85 = 15%) and the CTL driver goes unmentioned. Related copy nit (P15): "Keep ramping leaves the week as planned" (`week-debrief.ts:934`) — the keep pane already carries the effort adjustment. Fix: compute the annotation from the actual adaptive multiplier and name both drivers.

### ISSUE-309: Chronic-skipper pattern invisible outside the debrief *(P2, 2026-07-26, personas P13/P19)* — OPEN

TIM skip penalties accumulate silently (`events.ts:894-901`) and surface only in the final race forecast; carried-forward workouts carry no "carried from week N / drops on second skip" badge in plan-view; the ctlRatio load reduction applies with no explanatory banner; the ISSUE-296 chronic callout lives only in the debrief modal. Adjacent (P19): manual-only users who train off-app but never rate get the same carry/penalty machinery — the completion modal is the mitigation but nothing explains that rating IS the logging mechanism for them.

### ISSUE-310: Holiday machinery edge cases *(P2, 2026-07-26, persona P06)* — OPEN

(a) `computePreHolidayShifts` HYROX path mutates stored `wk.triWorkouts[].dayOfWeek` in place (`holiday-modal.ts:499-502`) — double-application risk on re-run; clone first. (b) `getHolidayDaysForWeek` (`holiday-modal.ts:765-785`) assumes Monday-anchored weeks; verify against mid-week onboarding day indices. (c) A future HYROX/tri holiday sets `forceDeload` but stored `triWorkouts` don't regenerate until some other trigger fires — the promised deload is inert until then; consider regenerating affected weeks on holiday confirm.

### ISSUE-311: Cycling-only leaks in coach context + adaptation fingerprint *(P2/P3, 2026-07-26, persona P03)* — OPEN

`coach-context-builder.ts:350-373` sends swim/run readiness+benchmarks for cycling-only athletes (latent while AI_COACH_ENABLED=false, but will produce "your run is fresh" advice the day it ships); `race-forecast-fingerprint.ts:145` averages `(swim + bike + run) / 3` so a cycling-only athlete's strong bike adaptation (1.2) reads as a diluted 1.067 "On track". Weight by active disciplines.

### ISSUE-312: Jargon + empty-state polish bundle *(P3, 2026-07-26, personas P17/P20/P19/P05/P18)* — OPEN

TSS shown unexplained on the Home progress row and strain ring (info sheet exists only in Stats); bike Z-zone terms have no help modal (`explanations.ts` covers RPE/MP only); swim threshold/endurance descriptions render without any pace hint when CSS is null (`swim.ts:144-162` — technique/speed variants have fallbacks, these don't); no "estimated benchmarks" disclosure when the tri plan was generated from skill-level fallbacks; stats VO2 bar hides silently for no-signal users (correct gate, missing one-line explanation); readiness copy says "Connect a watch" though manual sleep entry works (`readiness-view.ts:76-81`); trackOnly strain ring max degenerates to 1 when ctlBaseline=0 (`home-view.ts:1168`); debrief animation says "Factoring in RPE feedback" for users with zero RPE data (`week-debrief.ts:56-62`).

### ISSUE-313: Cycling wizard preview shows running metrics *(P3 — latent, mode hidden from picker, 2026-07-26, persona P25)* — OPEN

`plan-preview-v2.ts:257-272` unconditionally renders "Runs per week / Starting VO2max / Threshold pace" — meaningless for the cycling path (review.ts already gates its equivalents). Cycling is in HIDDEN_MODES (`goals.ts:87`) so no user reaches it today; fix before re-enabling cycling onboarding.

### ISSUE-314: Home forecast card fallback can show a stale number vs the forecast view *(P3, low confidence — needs repro, 2026-07-26, persona P01)* — OPEN

`home-view.ts` (~860) falls back `forecastTimeAdjusted → forecastTime → blendedRaceTimeSec`; if the first two are unset a stale cached blend could disagree with the freshly-computed forecast view. Also: CTL momentum shows "Stable" with <5 weeks of history instead of a no-data state (`home-view.ts:928-935`). Verify with a real state before building.

> **2026-07-26 — "3 runs today while injured" investigation (ISSUE-300 → 303).** Tristan's device (real plan, active injury, Home Today card) showed 3 runs on one day. Probe tests reproduced the defect family; 300/301 are fixed in code, 302 needs a product decision, 303 is a nit. The exact on-device combination is unconfirmed until Tristan's state is inspected, but 300+301 each independently produce the reported symptoms.

### ISSUE-300: Tri Home Today card renders synced actuals as planned sessions, badged "Run" *(P1, 2026-07-26)* — ✅ fixed in code, pending device verification

**Symptom.** An injured athlete's logged non-run activities (walk/ride/gym) appeared on the Home Today card as planned sessions, each badged "Run" → "3 runs today while I can't run".

**Root cause (two stacking halves).** (1) `buildTodayWorkoutTriathlon` (`home-view.ts`) read `wk.triWorkouts + wk.adhocWorkouts` filtered only by `dayOfWeek` — no synced-actual exclusion (`garmin-`/`strava-` adhocs, `garminTimestamp`) and no completed/skipped exclusion, unlike both the running Today card and `planned-day-tss.ts` (`isSyncedActual`). The tri matcher's reconcile step 4 (`activity-matcher.triathlon.ts:188-199`) also *day-shifts completed slots onto the day their activity actually happened*, piling them onto today next to their adhoc twins. (2) `buildTriathlonSessionBlock` defaulted any workout without a `discipline` field (and not gym/strength) to the **"Run"** badge — synced adhocs (`t:'easy'|'gym'|'cross'`, no discipline) and row-erg injury substitutes all mislabelled as runs.

**Fix.** Today-card filter now mirrors the running card (excludes synced actuals, completed/skipped/replaced, garminActuals-matched); new exported `triSessionKind()` sniffs discipline → type tokens and falls back to **cross**, never run. Guard: `tri-session-kind.test.ts`.

### ISSUE-301: Injured running week invisible on every day-keyed surface *(P1, 2026-07-26)* — ✅ fixed in code, pending device verification

**Symptom/probe.** With an active injury in acute/rehab/test_capacity/return_to_run phase, ALL phase-replacement workouts carry `dayOfWeek: undefined` (the injury engine's phase generators never set it, and they run *after* `assignDefaultDays`). Probe-proven: Plan tab shows all-Rest rows, strain target reads 0, Home shows "Rest Day" — the rehab sessions render nowhere.

**Fix.** `generator.ts` post-injury block assigns spaced days (Tue/Thu/Sat then Mon/Wed/Fri/Sun — the existing hard-day convention) to any injury-emitted workout without a day; adapted-in-place weeks (graduated_return) keep their original days. Guard: `injury-render.test.ts`.

### ISSUE-302: Injury phases auto-advance / auto-resume without user confirmation *(P1, 2026-07-26, needs Tristan's UX decision)* — OPEN

**Running**: `applyInjuryAdaptations` calls `evaluatePhaseTransition` at every render; with pain ≤3 an injury logged days ago silently climbs acute→rehab→…→`graduated_return`, which renders near-normal run sessions ('Steady Run', 'VO2 Builder') while the user still can't run. Probe log: `INJURY PHASE PROGRESSION: acute -> rehab` fired mid-render with no user input. **Tri**: `applyTriInjuryGates` restores a discipline to **100% capacity** the moment `resumeWeeksByDiscipline` elapses — the resume estimate captured at injury save is treated as fact, so runs return at full volume with no check-in. Related: ISSUE-278 (phases don't age without modal re-opens — the two mechanisms disagree about who owns phase time). **Recommendation**: time can *propose*, only a check-in can *confirm* — gate run-restoring transitions (→test_capacity/return_to_run/graduated_return, and tri capacity restoration) behind a lightweight "how's the injury?" prompt. Needs Tristan's call on the prompt surface (modal vs check-in nudge).

### ISSUE-303: `placeByPreference` last-resort comment claims weekend-first, implementation is a global min *(P3, 2026-07-26)* — OPEN

`scheduler.triathlon.ts:154-163`: comment says "pick across weekend FIRST then weekdays", but the `reduce` is a pure fewest-sessions min over `[weekend, ...preferred]` — a weekday with 0 sessions beats a weekend with 1, so a 0h-weekday user can still get weekday workouts in the last-resort path. Probe confirmed (45-min run placed on a 0-cap Wednesday). Cosmetic-to-minor; fix is ordering the reduce weekend-first or respecting caps in the tie-break.

### ISSUE-299: Sunday onboard → whole of week 1 flagged "Missed" the next day *(P1, 2026-06-22)* — FIX IN WORKING TREE, pending Tristan confirmation + device test

**Symptom (dogfood, screenshot).** Christina onboarded on a Sunday (week 1 = 15–21 Jun, 16-week plan). The day after (Mon 22 Jun, now week 2), opening the past week 1 showed Mon–Sat all flagged "Missed" and the headline reading "0 / 5 sessions". She was guilt-tripped for sessions scheduled before she ever signed up.

**Root cause.** `dropPreOnboardSessions` (`src/ui/workout-status.ts`) suppressed pre-onboard days **only while the onboarding week was the current week** (`if (viewWeek !== currentWeek) return workouts`). Once week 1 rolled into the past, the guard short-circuited, the dropped Mon–Sat sessions reappeared in the resolved list, and `plan-view.ts:827` marks every day of a past week (`viewWeek < s.w`) as past → "Missed". The reduced-partial-first-week semantics held for exactly one day.

**Fix.** Removed the current-week guard. `firstTrackedDow` is already week-agnostic — it returns the onboard-day offset only for the week containing `planCreatedAt` and 0 for every other week — so the drop self-restricts to the onboarding week whether it is current or past. Pre-onboard days now render as empty Rest rows in retrospect, never "Missed"; headline Sessions/Distance/Load derive from the same dropped list so they stay correct. Applies to running, tri, HYROX (all three resolvers call this helper). `plan-adherence.ts` already used `firstTrackedDow` per-week, so the pro-rata denominator was already correct. Guards: `workout-status.test.ts` (inverted the old past-week no-op assertion + added a non-onboarding-week no-op). tsc + 67 status/adherence + 236 UI tests green.

**Next: Tristan device-verifies a Sat/Sun onboard then advances a day — week 1 shows the chill lead-in (no "Missed"), then mark FIXED.**

### ISSUE-298: Race week prescribed a full-size quality block (3×8 threshold 3 days out) *(P1, 2026-06-17)* — FIX IN WORKING TREE, pending Tristan confirmation + device test

**Symptom (dogfood, Tristan).** A 14-week half-marathon plan put a full **Threshold 3×8** (24 min of threshold work) on the Thursday of week 14 — three days before a Sunday race. That is a build-phase session inside race week; the taper is meant to shed fatigue, not add it.

**Root cause.** Running engine (`plan_engine.ts`): `pickPhaseVariant` rotated `taper` like `build`, so the blind `(weekIndex−1) % n` rotation could land the heaviest variant (`thr_3x8`) in race week; and although the `×0.60` taper multiplier cut the *target* minutes, a rep-based variant renders `reps × repMin` straight off the variant, so the displayed structure stayed 3×8 while `workMinutes` said 12. Tri/cycling (`tri-intensity-profile.ts`) had a partial version: the taper quality-slot *count* was right but the *flavour* wasn't gated, so the remaining taper bike/swim slot could still draw VO2/over-under. HYROX was already correct.

**Fix (act-as-coach, all modes).** Running: `pickPhaseVariant` now treats taper like base (lightest variants); the final taper week seats a fixed primer (`TAPER_PRIMER_THRESHOLD` 3×2 min, or `TAPER_PRIMER_VO2` 4×1 min for 5K). Tri/cycling: `gateForBase`→`gateLowIntensity` now gates base **and** taper to sub-threshold kinds. Day placement left unchanged (a short primer 3–5 days out mid-week is standard). Science: taper holds intensity, cuts volume (Mujika & Padilla 2003; Bosquet 2007). SCIENCE_LOG §CE; CHANGELOG 2026-06-17. Guards: `plan_engine.taper-primer.test.ts` (4). tsc + full workouts suite green.

**Next: Tristan confirms the rendered race week shows the short primer (running + tri + cycling), then device-verify, then mark FIXED.** Open question for Tristan: are 3×2 (threshold) and 4×1 (VO2) the rep schemes you want, or different?

### ISSUE-297: Race predictions bury a strong engine + aren't reproducible *(P1, 2026-06-16)* — RC1 + forecast + RC3 all FIXED in code (NOT device-verified)

**⏳ STATUS UPDATE (2026-06-16).** All three root causes are **fixed in code, not yet device-verified** (device-verify before marking FIXED).
- **RC1 (engine/readiness conflation):** the engine VDOT (`s.v`) is floored at demonstrated PB capacity (`pbMedianVdot`) in both `refreshBlendedFitness` and `initializeSimulator`, standing down only on demonstrated recent slowness — low volume no longer buries the engine, so refreshes are deterministic.
- **Forecast:** anchors on a `blendPredictions` at `computePeakWeeklyKm` (the plan's own peak), crediting the volume ramp in proportion to what the plan delivers. No new constants.
- **RC3 (deleted PBs resurrecting):** new per-distance deletion tombstone `s.deletedPbs`. `effectivePhysiologyPbs` drops any value not genuinely faster than a deleted time (kills the cross-store fastest-wins resurrection); the Strava (`review.ts`) and Apple (`appleHealthSync.ts`) auto-fills honour the tombstone (no silent re-add); `recordPbDeletion` clears BOTH stores + sets the tombstone + refreshes; explicit re-entry clears it (`clearPbTombstone`). Wired into the review-step PB editor (the actual delete site; the other audit files only display PBs). Validated empirically across PB/volume/distance matrices incl. slower runners + 0km-recently.

Guards: `physiological-vdot.test.ts` (tombstones), `blended-fitness.test.ts` + `initialization.durability.test.ts` (engine/forecast). SCIENCE_LOG §BZ; CHANGELOG 2026-06-16. **Next: Tristan device-verifies the full bundle (onboard 20:00-5K / 25:00-5K / 40:00-10K; enter-then-delete a PB), then mark FIXED.**

**⏳ TRI ANALOGUE (2026-06-17) — race-validated run VDOT anchors over the watch VO2max. Fixed in code, NOT device-verified.**
- **Symptom (dogfood)**: a triathlete with a real 70.3 (run 1:55 half) + Apple Watch VO2max 56 saw running paces far too fast (easy 4:45/km, threshold 3:58/km, marathon 3:33) and a too-fast Ironman run leg. His 1:55 half implies VDOT ~42–45; 56 is sub-19-5K shape.
- **Root cause**: the watch VO2max (inflated for triathletes by cycling/swimming) won `getPhysiologicalVdot`'s device tier AND was fed raw into `blendPredictions`; with no running PBs the RC1 PB-floor was null, so `s.v` collapsed to ~56 and every pace/forecast/tri-run-leg inherited it.
- **Fix**: new `s.raceRunVdot` anchor (fatigue-discounted fresh-run equivalent via `raceRunLegToVdot`, recency-gated 365d; seeded at onboarding + race-outcome logging). Ranks above device in `getPhysiologicalVdot` (below standalone-run mosaic), caps the blend's VO2 predictor in `effectiveVo2max` (covers the `blendOpenRunRaceTime` surface that recomputes off the watch directly — the Lesson-2 trap), and floors/caps the engine in `refreshBlendedFitness`. SCIENCE_LOG §CC; CHANGELOG 2026-06-17. Guards: race tier + `effectiveVo2max` cap in `physiological-vdot.test.ts`, s.v anchor in `blended-fitness.test.ts`, seeding in `tri-race-outcome.test.ts`.
- **Still open (separate, NOT this fix)**: (a) tri bike target renders as "6:34" — a run-pace `targetPaceSecPerKm` leaking onto a bike `DisciplineTarget` (`workout-detail-modal.ts:351`); (b) swim projects faster than the actual split; (c) Lesson-1 forecast-volume facet — the tri specific-endurance penalty evaluates on CURRENT per-discipline volume, so the forecast should but may not credit planned PEAK volume (opposite-direction, not exercised by this too-fast symptom). See `docs/TRIATHLON_PREDICTION_LESSONS.md`.
- **Next**: Tristan device-verifies the dogfood inputs render corrected numbers (easy ~6:00, threshold ~5:00, marathon ~4:15+, tri run leg slower than the open 1:55 half), then mark FIXED.

**✅ ADDRESSED IN CODE (2026-06-17) — watch VO2max overstated run fitness for triathletes. Fixed two ways; NOT device-verified.** *(Tristan approved both: "same VO2, I run 3:10, Alex runs 4:00 — only running evidence tells them apart. Cap.")*
- **Finding (measured)**: Alex *without* his 70.3 — synced watch VO2max 56, no running PB/runs — was predicted **open marathon 2:53** (engine 50.7 after blend penalties). A 1:55-half athlete (VDOT ~43). Two athletes with the same watch 56 can be a 3:10 and a 4:00 marathoner — the watch can't tell them apart.
- **Fix 1 — running-evidence ceiling (`effectiveVo2max`, tri-gated)**: the watch can't pull the blend's VO2 predictor ABOVE the max of the athlete's running-specific evidence (race anchor / PB-median / medium+ HR-pace calibration). A recent fast run / fresh PB raises the ceiling, so a genuinely improving runner is never trapped (PBs aren't a ceiling); a fast runner with the same watch 56 + 16:00 5K is NOT capped (→ VDOT 64.6). Running mode (no `triConfig`) untouched.
- **Fix 2 — cold-start skill cap (`refreshBlendedFitness`, tri)**: with NO running-specific signal at all, cap the engine at the run skill-slider self-assessment (`estimateRunPaceFromSkill`). No new constants.
- **Pull beats ask**: running PBs auto-pull from Strava/Apple `best_efforts` (`applyPBsFromRows`) into `s.pbs` and flow to the tri run blend — so a connected triathlete is anchored without being asked.
- **Result (watch 56)**: pulled 1:55-half PB → open marathon 3:19 (was 3:13, and the IM run leg adds 11% fatigue → ~4:15); cold-start skill-3 → 3:31 (was 2:53/3:08); fast runner 16:00-5K → 2:33 (uncapped). SCIENCE_LOG §CC.
- **Residual (separate issue)**: the *open*-marathon VDOT-equivalent off a half PB (3:19) is still aggressive vs a real age-grouper marathon (~4:00) — that's marathon-specificity conversion, not the watch bug. Lower priority.
- **Still pending**: (a) the **tri-past-race onboarding ASK-fallback** field (pre-filled from any pulled PB, prompt only if empty) — not yet built; (b) device verification of all of the above before TestFlight.



**Symptom (Tristan dogfooding).** A 20:00 5K (no other data, low/blank weekly volume, marathon target) is shown a ~3:50–4:00 marathon, a *different* time on each recompute (3:33 vs 4:00), and "Faster than 95% of male runners / VO2max 49.8" on the SAME review screen as the slow marathon. Also: enter a 2:00:00 marathon, delete it, plan stays sub-2.

**Root cause (3 linked, one theme — prediction isn't a pure function of inputs).** (1) The volume-penalized *marathon* time is written back into the global engine `s.v` via `cv(targetDist, penalizedBlend)` (`blended-fitness.ts:583,603`), collapsing VDOT 50→40 — capacity/readiness conflation. (2) That writeback + `recomputeLT` (`:486`) feed the next refresh → path-dependent / non-reproducible (the §BO "degraded VDOT loop"). (3) `effectivePhysiologyPbs` merges `Math.min(s.pbs, onboarding.pbs)` (fastest-wins), so a deleted PB resurrects from the other store. The review screen reads `getPhysiologicalVdot` (PB-median ≈ correct) while the plan/forecast read the buried `s.v` → visible contradiction.

**Why existing fixes miss it.** `demonstratedPBFloor` (ISSUE-285) is *same-distance only*, so a 5K PB → marathon target gets no floor.

**Fix direction.** Separate engine from readiness: don't let volume/durability penalties write below PB-derived capacity (`pbDerivedVdot`) absent real detraining evidence (VDOT-level sibling of `demonstratedPBFloor`); keep the race prediction honest but build the forecast from true capacity; deletion must clear both PB stores (+ tombstone for fastest-wins). **Full diagnostic + repro + file:line + test plan: `docs/PREDICTION_FEEDBACK_LOOP_DIAGNOSTIC.md`.** Hot files (parallel agent's domain) — coordinate.

### ISSUE-288: Render-time illness/holiday mods persist to stored plan (tri/cycling/HYROX) *(P0, 2026-06-16)* — FIX IN WORKING TREE, pending Tristan confirmation + device test

**Fix (2026-06-16).** The tri + HYROX plan-views (and cycling, which reuses the tri view) now call `resolveTriWeekWorkouts` with the default `clone:true`, so render-time illness/holiday/bridge mods apply to copies and never mutate the stored `wk.triWorkouts`. Handlers look up stored objects by id (clean), so ratings/drag still persist correctly; cards still show mods (from the cloned resolve). Resolver doc now forbids `clone:false` from any view that can `saveState`; `week-resolve.triathlon.test.ts` documents the hazard. tsc + lint clean; resolver tests 11/11. Files: `src/ui/triathlon/plan-view.ts`, `src/ui/hyrox/plan-view.ts`, `src/ui/triathlon/week-resolve.triathlon.ts`. **Device test:** report illness on a tri/HYROX plan, rate/drag a session, mark recovered → confirm workouts return to normal (no lingering "Rest — illness").



**Symptom.** After a triathlon/cycling/HYROX user recovers from illness (or a holiday ends), workouts can stay marked "Rest — illness" / holiday-modified until the plan regenerates.

**Root cause (triage-confirmed).** `resolveTriWeekWorkouts(s, viewWeek, { clone: false })` (tri plan-view `src/ui/triathlon/plan-view.ts:103,445`; HYROX `src/ui/hyrox/plan-view.ts:107`) returns direct references to stored `wk.triWorkouts`. The render-time mod appliers (`applyIllnessMods`, `applyHolidayModsAllDisciplines`, `applyBridgeModsAllDisciplines`) mutate those shared objects **in place** (`src/ui/triathlon/week-resolve.triathlon.ts:41`). Any subsequent `saveState()` (rating, drag, adjust) persists the temporary mods; on recovery the mods are no longer re-applied but the persisted ones remain. RUNNING mode is immune — it regenerates the week fresh each render and stores mods separately (`wk.workoutMods`).

**Fix direction.** Either clone on render for tri (match running) and have handlers re-read from a clean source, OR strip render-mod fields (`illnessMod`/`holidayMod`/`modReason`/`original*`) in `saveState()` before persisting. Needs care — the `clone:false` exists so click/drag handlers re-read shared objects.

### ISSUE-289: Leftover dead `buildRaceForecastCard` on Home *(P3 — downgraded from P1, 2026-06-16)* — NOT a missing feature

**Correction (2026-06-16).** Originally logged as "race forecast missing from Home (P1)". **Wrong** — verified with Tristan: the race forecast was deliberately moved to its own **Forecast tab** (`tab-bar.ts:35`; running → `renderRaceForecastView` via `navigateToForecastTab`). The tab-bar doc says so explicitly ("the forecast is now a full standalone view ... and belongs in the tab bar"). The feature is fully present and reachable; there is **no user impact**.

**Remaining (cosmetic).** `buildRaceForecastCard(s)` (`src/ui/home-view.ts:854`) and its click handler (`:3209`, listens for `#home-race-forecast-card` which is never in the DOM) are leftover dead code from the old inline-on-Home version. Optional cleanup: delete both. No behaviour change.

**Fix direction.** Restore the `${buildRaceForecastCard(s)}` call in `getHomeHTML()` (with its existing visibility guards), or remove the dead function + handler. **Verify on a clean tree first** — home-view was under parallel edits this session.

### ISSUE-290: `effortMultiplier` offline with zero ratings *(CLOSED — overstated, 2026-06-16)* — not a real bug

**Correction (2026-06-16, caught by Tristan).** Originally logged P1 "adaptation silently off for non-raters." **Largely false.** You can't really "not rate" a run: when an activity syncs and matches, `deriveItemRPE` → `deriveRPE(avgHR/maxHR/aerobic-effect/…)` auto-derives an RPE from heart-rate data and stores it in `wk.rated` (`activity-review.ts:177,1130`), shown pre-filled as `autoRpe`. So `effortScore` IS computed for anyone who syncs. And adaptation already blends HR + pace: RPE 60% / objective 40%, the objective half being HR effort or per-rep **pace** adherence on intervals (`events.ts:1045,1052`).

**Residue (no action).** The only zero-signal case is a user who syncs nothing AND never manually logs — who also has no HR or pace data, so there is nothing to adapt from and no fallback to add. The persona/triage pass traced `getTrailingEffortScore → 0` for the literal zero-ratings case and missed the auto-rate-on-sync behaviour. Closed.

### ISSUE-291: HYROX plan-view lacks the injury button/banner (parity gap) *(P3 — downgraded from P1, 2026-06-16)*

**Correction (2026-06-16, verified).** Originally logged P1 "HYROX has no injury entry point." **Wrong** — HYROX uses the shared home-view, whose "Check-in" button (`home-view.ts:2799`, every non-track-only mode) opens the check-in overlay → "Injured" → `openInjuryModal()` (`checkin-overlay.ts:80`), which handles HYROX disciplines and regenerates HYROX weeks. So a HYROX athlete **can** report an injury (Home → Check-in) and the plan adapts.

**Real residue (cosmetic parity).** HYROX's *plan view* lacks the dedicated injury button + persistent "In Recovery" banner that running/tri plan-views show, so an injured HYROX user gets no on-plan status indicator. Optional: port the tri injury header button + banner into `hyrox/plan-view.ts`. No capability is missing.

### ISSUE-292: Switch-to-tracking doesn't clear `eventType` / `triConfig` / `hyroxConfig` *(P2, 2026-06-16)* — confirmed, fix actionable

**Root cause (triage-confirmed).** `downgradeToTrackOnly()` (`src/ui/wizard/controller.ts:620-639`) shallow-spreads `onboarding` and sets `trackOnly: true` but never clears the top-level `eventType`/`triConfig`/`hyroxConfig`. Most views check `trackOnly` first, so it's currently latent, but mode-specific routing (`week-debrief.ts`, `home-view.ts`) keys on `eventType` and could fire. **Fix:** clear those fields explicitly on downgrade (or in `initializeSimulator` when `trackOnly && eventType !== 'running'`).

### ISSUE-293: Post-race plan shows "Week N of M" with N>M and a blank week *(P2, 2026-06-16)* — confirmed, fix actionable

**Root cause (triage-confirmed).** When `s.w > s.tw` (race past, week advanced beyond plan), `viewWeek` clamps to `s.w`; `s.wks?.[viewWeek-1]` is undefined → `resolveWeekWorkouts` returns [] → 7 blank rest rows, header reads e.g. "Week 13 of 12" (`src/ui/plan-view.ts:2499,3373`). **Fix:** clamp `viewWeek` to `min(s.w, s.tw)` post-plan, or render a "plan complete" end-state.

### ISSUE-294: Post-race `previousPlanWks` not archived until "Complete Week" tapped *(P3, 2026-06-16)* — confirmed (by-design gap)

**Root cause.** `archiveCurrentWksIfPopulated()` only runs on explicit week-complete (`src/ui/events.ts:1292`). Post-race auto-advance can take `s.w > s.tw` without the user tapping Complete, leaving history unarchived. **Fix (optional):** auto-archive when a race outcome is detected.

### ISSUE-295: ACWR response policy — VDOT bump + plan volume not gated by ACWR *(P2, 2026-06-16)* — DECIDED + IMPLEMENTED in working tree (2026-06-17), pending Tristan confirmation + device test

**Original two linked behaviours:**
1. **VDOT auto-bump ignores ACWR** — `s.v` written from demonstrated fitness even at high ACWR, so an over-distance week could inflate the anchor and escalate next week.
2. **Plan doesn't volume-deload on high ACWR** — only quality sessions dropped + long run frozen; the toggle to opt out was cosmetic (Accept ignored the selection).

**DECISIONS (Tristan, 2026-06-17):**
- **(a) Do NOT gate VDOT on ACWR.** VDOT describes demonstrated fitness (tracking); ACWR is forward-looking risk (planning). A hot week doesn't mean less fit — fix the escalation at the plan layer, leave the number honest. **VDOT writeback unchanged.**
- **(b) Offer, don't impose.** Agency: the athlete chooses **Keep ramping** (plan intact) or **Ease back** (intelligent reduction). Default-until-chosen is eased.
- **No flat volume damper** (the `−15%/−25%` was invented). Instead `L_max = safeUpper × chronic` and the week sheds exactly its overshoot.

**IMPLEMENTED (2026-06-17, SCIENCE_LOG §CF, all green 3468):**
- `computeAcwrEaseBack` (`src/calculations/acwr-ease-back.ts`) — intensity-first ladder: (1) quality→easy + fast-finish long→steady, distances kept; (2) trim easy volume; (3) shorten long run last resort. Guard `acwr-ease-back.test.ts`.
- Coarse "drop 2 quality + freeze long" removed from `plan_engine.ts` (caution unchanged); generator (`generator.ts`) applies the ladder as a post-pass unless `acwrChoice==='keep'`.
- Week-debrief toggle now persists `wk.acwrChoice` and commits the selected plan (was cosmetic). New Week fields in `state.ts` (`acwrChoice`, `scheduledAcwrRatio/ChronicTSS/SafeUpper`).
- Escalation: carry a keep choice across the episode (no re-nag); clear it (re-raise, firmer copy) at very high (ratio ≥ 1.6) or 3 consecutive high weeks. Stamped in `events.ts` at rollover.

**Next: Tristan device-verifies** — generate/regenerate a plan that goes high, confirm (1) both toggle choices commit the matching week, (2) ease-back keeps the long run distance and strips intensity first, (3) a ratio ≥ 1.6 week re-raises after a prior keep. Then mark FIXED.

### ISSUE-296: No trigger for chronic low adherence *(P3, 2026-06-16)* — FIX IN WORKING TREE, pending Tristan confirmation + device test

**Decision (Tristan, 2026-06-17):** surface a sustained-under-delivery callout when adherence is **< 70% over the last 3+ weeks** (conservative threshold so a single rough week, or a runner deliberately running less, doesn't trip it). Surface in the **week-debrief** (not the coach) — per CLAUDE.md's adaptation-transparency rule, a multi-week pattern is a "big change → end-of-week summary."

**Key finding while investigating.** The issue's premise (`coach-triggers.ts` should gain an adherence trigger) was moot: the LLM coach is hard-gated off (`AI_COACH_ENABLED = false`, `renderCoachView` routes straight back), and **nothing in the UI renders `coachInsightQueue`** — `topUnseenInsight`/`markInsightSeen` are only referenced in tests. So the entire `coach-triggers.ts` pipeline is dead end-to-end (queue is populated on launch but displayed nowhere, and its only consumer is the disabled brief stream). Adding a trigger there would write into a void.

**Fix (in working tree, 2026-06-17).**
1. New canonical detector `detectChronicLowAdherence()` + constants `CHRONIC_ADHERENCE_WINDOW_WEEKS = 3` / `CHRONIC_ADHERENCE_THRESHOLD_PCT = 70` (`plan-adherence.ts`). Mode-agnostic — operates on the shared `{ pct, weeksIncluded }` shape so running and tri read from one source.
2. `computePlanAdherence` gained an optional `nWeeks` trailing-window arg (mirrors `computeTriPlanAdherence`'s existing `nWeeks`).
3. Surfaced as a factual note in both debriefs: running `week-debrief.ts` (`_renderPlanPreview`) and tri `tri-week-debrief.ts` (`_showTriPlanPreview`), alongside the existing last-week CTL-gap note. Copy states the pattern only, no action pointer.
4. **One-tap recalibrate prototyped, then PULLED (not bulletproof).** A "Rebuild plan at N runs/week" button was built routing through `initializeSimulator` (the Settings runner-type/gym-edit path). Reverted same session: that path resets `s.w = 1` / `planStartDate = this Monday` and only heals position when `reconcilePlanAnchorToEarliestActivity` finds a logged activity (welcome-back.ts:305 returns false with none) — unsafe for the sparse-activity users the detector targets (a zero-completion user trips it, floors to 1, rebuild destroys the race countdown). Also found: **there is no runs-per-week editor in Settings**, so the note's original "lower it in Settings" pointer was false (now removed). `suggestedRunsPerWeek` helper + tests removed.
5. **Bug fixed in same pass:** gym + cross-training (rugby) were dragging down *triathlon* adherence (`computeTriPlanAdherence` counted gym sessions in the denominator but never credited them — a done strength session read as a missed tri session). New `isScorableTriSession` filter (swim/bike/run/brick only). Running was already clean (denominator = `s.rw` runs). Also corrects the tri Progress-detail adherence number.

**Follow-up (open):** a *safe* one-tap recalibrate — change `s.rw` + `onboarding.runsPerWeek` and regenerate only the future weeks in place (leave `s.w`/`tw`/`planStartDate` untouched, so no reset and no reconcile dependency). Needs the per-week generator args threaded (see events.ts next-week generation). Deferred pending Tristan's go-ahead.

**Guard:** `plan-adherence.test.ts` (+8: trailing window + detector), `plan-adherence.triathlon.test.ts` (new, 3: gym/cross exclusion). tsc + lint:ui clean, suite green (1 unrelated wall-clock-flaky holiday-detraining test). **Not device-verified** — do not mark FIXED until Tristan completes a <70%/3wk week in-app and confirms the note renders.

### ISSUE-287: Short plans (≤12 weeks) front-load the LOAD-chart peak to ~week 5 *(P2, 2026-06-16)* — FIX IMPLEMENTED in working tree, pending Tristan confirmation + device test

**Fix (2026-06-16, SCIENCE_LOG §CA).** The corrected diagnosis below was right that it is an intensity-placement artifact, but the lever was finer than "concentrate quality in the peak phase": the apex was being thrown by **workout-variant rotation**, not the phase multipliers (which move weekly load only ~5%). The blind `(weekIndex - 1) % len` rotation scattered the high-load variants — chiefly the `fast_finish` progressive long run (~30 TSS over steady) — so the heaviest week often landed in build. New `pickPhaseVariant` (plan_engine.ts) biases variant selection by phase (peak → heaviest, base/deload → lightest, build/taper → full rotation); deload weeks drawing the lightest variants also kills the post-deload bounce. No invented constants. Verified: TSS apex now lands in the peak phase for every length/distance probed (9/12/16/18 wk × 10k/half/marathon); guard `plan_engine.apex.test.ts` (12 cases). The short-plan "compressed plan" warning is now an inline muted caption under the coach-contract load chart, shown for event plans of ≤12 weeks (continuous plans excluded — they loop, no taper). Do not mark FIXED until Tristan regenerates a short plan in-app and confirms the load chart crests under the Peak label.

---

#### Original diagnosis (retained for context)

**Symptom (scenario sweep, not device-confirmed).** Rebuilding real plans across lengths: the load (TSS) peak lands late for 16-24 wk plans (77-87%) but **early for short plans** — an 8/10/12-wk plan peaks at **week 5** (62% / 50% / 41%).

**Not caused by ISSUE-286's fix.** Appears identically for the half; RC2 can only move a peak later.

**Corrected root cause (2026-06-16, after building + reverting a trial fix).** The first hypothesis — "the geometric volume ramp saturates early, fix it with a tri-style phase envelope" — was **built and tested, then reverted**, because it was wrong on two counts:
1. **The early peak is an INTENSITY-placement artifact, not a volume one.** In a 12-wk plan, wk5 carries *less* km than wk7 (55 vs 67) but *more* load (TSS 565 vs 500). The load peak tracks where the hard quality sessions + the post-deload bounce land (first big week after the wk4 deload), not where volume peaks. A volume envelope therefore can't move it — confirmed: with the envelope active the TSS peak stayed at wk5.
2. **A blanket volume envelope regresses established runners.** Mirroring tri's `phaseMultiplier` (base 0.55→0.85 of peak) cut a 50 km/wk runner's week-1 volume to ~37 km — detraining someone already at volume. For an athlete whose baseline ≈ peak, a flat volume profile is *correct*; they periodise via intensity, not a volume ramp. Flooring the envelope at baseline (to protect them) cancels its effect for exactly the fit-runner case it was meant to fix.

Also discovered while testing: the whole volume-budget subsystem (geometric ramp, RC2, any envelope) only runs when **both `state.detectedWeeklyKm > 0` and `state.athleteArchetype` are set** (read live in `generateWeekWorkouts`; archetype is set at launch by `detectArchetype` and after Strava/Apple sync). Real launched/synced users have them; a bare `initializeSimulator` test does not — so budget-path changes MUST be tested with both set or they silently no-op.

**Fix direction (needs Tristan's call).** The real lever is **intensity placement** — concentrate the hardest quality sessions in the peak phase and damp the post-deload load spike in early build — so the load peak lands late for short plans too. Distinct subsystem from ISSUE-286 (quality-cap / session-type distribution by phase, `workoutPriority` + `qualityCap`). Alternative: accept it — short plans are inherently compressed, and the reported 18-wk case already peaks correctly (wk14). Deferred for a dedicated decision.

### ISSUE-286: Marathon plans are under-built — short long run, flat/front-loaded ramp, low volume *(P1, 2026-06-15)* — fix in working tree, pending Tristan confirmation + device test

**Symptom (Tristan, device, real 18-wk Amsterdam plan).** Weekly-load chart peaks at **week 2** (should be ~wk 14-16), reads as a jagged no-arc sawtooth, ~34 km peak week / ~452 km total. For a 3-runs/wk marathon the **long run tops out at ~18 km / 89 min**.

**Verified NOT the chart.** coach-contract's chart faithfully sums the prescribed sessions; the km-undercount was already fixed (`plannedWorkoutKm`). The plan itself is under-built.

**Root causes (engine):** (1) long run time-capped too low for marathon (`longRunMinutes` / `computePeakWeeklyKm` longCap, intermediate=120min⇒~18-24km); (2) volume ramp goes **flat** under a tight cap so the plan stops periodizing — peak lands on noise (`weekVolumeBudgetKm` athlete-archetype.ts:347 + `effectiveWeeklyBudgetMin` plan_engine.ts:356); (3) low run frequency starves volume + zeroes easy runs for marathon (`computePeakWeeklyKm` easyCount = rw-2-1).

**Fix (in working tree, 2026-06-15) — SCIENCE_LOG §BW, all three RCs:**
1. **RC1**: marathon long run now ramps linearly from the 90-min week-1 anchor up to a distance-aware readiness ceiling (`longRunCapMin`: beginner 150 / novice-intermediate 165 / advanced-elite 180 min — matches the predictor's `LONG_RUN_THRESHOLD_SEC.marathon = 165 min ≈ 30 km`). Same cap reused in `computePeakWeeklyKm`. (Old code maxed at ~95 min because the base ramp, not the cap, was binding.)
2. **RC2**: `effectiveWeeklyBudgetMin` caps the *peak* destination then ramps toward it with the existing geometric fraction (was `min(ramp, hoursCap)` per week, which flattened under any tight cap). New budget always ≤ old; no-hours-target plans byte-identical.
3. **RC3**: marathon `easyCount` floored at 1 when `runsPerWeek ≥ 3`. Cross-training stays alongside (Tristan's call: no planning-time km cut).

**Effect (rw=3 marathon probe):** peak wk 11→**14**, peak km 37→**51**, total 452→**588**, peak long run 18 km/89 min → **32 km/159 min**. Tight-hours-cap front-loaded peak (wk 5) → wk 14. `tsc` clean, plan/workout suite (326) green. **Not device-verified** — do not mark FIXED until Tristan regenerates a real marathon plan and confirms the arc + long-run distance.

**Full diagnostic + repro:** see **`docs/MARATHON_PLAN_DIAGNOSTIC.md`**.

### ISSUE-285: Prediction engine read "no training data" as "detrained" — predicted a 2:00 marathoner at 2:22 *(P1, 2026-06-15)* — fix in working tree, pending Tristan confirmation + device test

**Symptom (Tristan, 2026-06-15).** A user whose only data is a 2:00:00 marathon PB was predicted **2:22:50** (reproduced as 2:24:54 from the live code). A 20:00 5K runner with no other data, training 3×/week + 1 speed, was predicted **4:03** for the marathon. Both are slower than the athlete's demonstrated fitness warrants.

**Root cause.** Three endurance-shortfall penalties (`marathonSpecificityPenalty` ×1.15, `applyLongRunCap` ×1.05, `noLongRacePenalty` ×1.01) all key off the *absence of synced training history*. A brand-new onboarding user always has zero history, so `resolveWeeklyKmSignal` → `0` and `getLongestRunSec` → `0`, which the penalty code reads as "runs zero km / longest run is zero" (maximal detraining) rather than "no data yet". Absence of evidence was treated as evidence of detraining; stacked multiplicatively it slowed a proven 2:00 marathon to 2:25.

**Fix (in working tree).**
1. **No-data gate** — `initialization.ts` passes `undefined` (not `0`) for weekly volume when `weeksCovered === 0` and no manual volume typed, so `marathonSpecificityPenalty` stays dormant for true no-data users (still fires for real low-volume history).
2. **Demonstrated-PB floor** (`demonstratedPBFloor`, `predictions.ts`) — never predict slower than a same-distance PB unless positive detraining evidence exists (real `< 30 km/wk` signal, OR a recent run projecting slower than the PB). Applied in `blendPredictions` and after the durability cap in `initialization.ts`.

**Result.** 2:00 marathon-only → 2:00:00; 20:00 5K-only marathon → ~3:31; returning runner (1:28 half PB + recent 24:00 5K) still ≥1:30. Full suite green (3340); SCIENCE_LOG §BV; CHANGELOG 2026-06-15. **NOT device-verified — do not mark FIXED until Tristan confirms the onboarding numbers in-app.**

---

### ISSUE-284: Strava/Garmin OAuth on native iOS uses a full-page redirect, no in-app browser or deep-link return *(P1 if broken on device, unverified, 2026-06-12)*

`startStravaConnect` (`src/data/stravaSync.ts:78`) and `startGarminConnect` (`src/data/garminOAuth.ts:19`) do `window.location.href = data.url` to begin OAuth; the callback redirects back to the app origin with `?strava=connected` / `?garmin=connected`, handled in `connect-data.ts` + `main.ts`. There is **no `@capacitor/browser` `Browser.open` in-app Safari view and no `@capacitor/app` `appUrlOpen` deep-link listener** anywhere in `src/`. On web this is fine (normal redirect). On a Capacitor iOS build it navigates the entire WKWebView away from `capacitor://localhost` to Strava and depends on the callback redirecting cleanly back into the app — which may leave the user on a blank page or lose JS state. Since Strava is the **primary data source for shipped users** (Garmin API not yet approved), a broken iOS OAuth would block onboarding for most users.

**Partially mitigated (2026-06-12)**: added a redirect-independent self-heal — tapping Connect persists `onboarding.oauthPending`; on the next `connect-data` render `recoverPendingStravaOAuth` re-checks `strava_tokens` via `isStravaConnected()` and completes the flow if the token landed, even when the `?strava=connected` bounce is lost. JS-only, web path unchanged. This means onboarding **recovers** from a flaky iOS redirect, so the remaining work is no longer a hard blocker.

**Native in-app-browser OAuth — BUILT, gated off (2026-06-12)**: the full flow now exists behind `NATIVE_OAUTH_ENABLED` (`feature-flags.ts`, default false). `@capacitor/browser` + `@capacitor/app` installed; `mosaic://` scheme in `Info.plist`; `src/data/oauth-native.ts` opens the in-app browser + handles the `appUrlOpen` return (re-enters with `?strava=connected` to reuse the tested handler); `strava/garmin-auth-callback` `pickRedirectTarget` allowlists `mosaic://oauth` (exact-match, **staged not deployed**). All client checks green; web unchanged.

**To ship it (native-build session, full runbook in `docs/RUNBOOK.md → Native OAuth`)**: (1) `npx cap sync ios`; (2) deploy `strava-auth-callback` + `garmin-auth-callback`; (3) flip `NATIVE_OAUTH_ENABLED` → true; (4) Xcode rebuild + device-test. Order matters — deploying the callbacks before flipping the flag avoids the in-app browser landing on the web app. The shipped self-heal covers the gap until then. **Decision (Tristan, 2026-06-12): "best app regardless of depth of build."**

**`invalid_state` error page on device — root-caused + fixed in code (2026-06-15)**: `NATIVE_OAUTH_ENABLED` is now `true`, but a beta connect showed the in-app Safari sheet stuck on `{"error":"invalid_state","details":null}`. Cause: the callbacks `DELETE`d the `*_auth_requests` row on success, so the in-app browser's re-hit of the callback (it can't follow the `mosaic://` redirect) found no row. Connection had actually succeeded. **Fix**: idempotent callbacks — `consumed_at` column (migration `20260615_oauth_idempotent_callback.sql`), replay-success on duplicate hits, atomic claim to prevent double token-exchange, friendly HTML page when the row is truly gone, opportunistic purge of consumed rows >1h. **DEPLOYED 2026-06-15**: `consumed_at` column added to both tables (Management API, scoped — not `db push`) + both callback functions redeployed. Not device-verified.

**Two more device failures + the real fix (2026-06-15)**: after the idempotency deploy, connect showed "Safari cannot open the page because the address is invalid", then raw HTML as source. Two walls: SFSafariViewController won't follow a 302 to a custom scheme, AND the Supabase edge gateway force-rewrites responses to `text/plain` (so a JS-redirect HTML page won't run). **Fix: dropped `@capacitor/browser`, added `@mosaic/web-auth` (ASWebAuthenticationSession) plugin** — iOS's purpose-built OAuth view that intercepts the `mosaic://` callback natively. Client rewired (`oauth-native.ts` → `runNativeOAuth`), edge callbacks reverted to plain 302→mosaic://. Typecheck + 3308 tests green; `vite build` + `cap sync ios` done. **REQUIRES a TestFlight repush** (native plugin) — Xcode rebuild + archive + upload pending. Not device-verified. This is the path that should finally close ISSUE-284.

---

> **2026-06-05 persona-qa sweep (all 25 personas, pre-App-Store)**: ISSUE-273…282 below came from the full `/persona-qa all` run. Each was code-verified by an audit agent with file:line cites; ISSUE-273 was additionally hand-verified in this session. None are crashes on the reviewer path — the REVIEW demo journey itself was tested clean the same day (stale race-date bug found and already fixed in `demo-data.ts`).

### ISSUE-273: Week-debrief ✕ freezes week advance and re-fires every launch *(P1, 2026-06-05)* — fix in working tree, pending device verification

The debrief's ✕ button (`week-debrief.ts:395-397`) just removed the modal — it never set `lastDebriefWeek`/`lastCompleteDebriefWeek` (only `_closeAndRecord` does). `welcome-back.ts:132-138` clamps `s.w` to `lastCompleteDebriefWeek + 1`, so a habitual dismisser got: week pointer frozen + the same debrief re-firing every launch until they tapped Continue once. **Tristan picked: remove the ✕ entirely (2026-06-05)** — the review is a checkpoint; Continue is the only exit and it records. Implemented same day: all four ✕ instances removed (step-1 summary, analysis animation, plan-preview step, plan-complete screen) plus their orphan handlers. Plan-complete now requires the Start-new-plan / Continue-tracking choice (both safe; new-plan stays reachable from Account if they pick tracking). Suite 3228 green. NOT device-verified — confirm the weekly flow on device before closing.

### ISSUE-274: HYROX forecast run-pace drill-down shows marathon training pace zones *(P1, 2026-06-05)* — FIX IN CODE, pending device verification

`hyrox/forecast-chip-detail-view.ts` previously rendered a "Training pace zones" card with Easy/Marathon/Threshold/Interval/Rep paces from `s.pac` — marathon-centric zones that contradict the HYROX coaching model (Critical Pace), firing for any HYROX athlete with running history.

**Fix (2026-06-17).** The leaking Daniels-zone card was already removed in commit `5c4dea6` (the issue was just never closed). This session took the issue's "build a Critical-Pace-based equivalent" path: the run-pace forecast page now surfaces the athlete's **Critical pace** (a stat row) plus a muted "View critical pace →" link to the existing `critical-pace-detail-view.ts`. The CP value reads from the same canonical `deriveHyroxRunPace(s).components.criticalPaceSecKm` call the detail page uses, so the two surfaces agree by construction. The CP detail view gained an optional `onBack` handler so Back returns to the run-pace page (not Stats) when opened from the forecast. tsc + lint clean; `hyrox-run-pace.test.ts` 28/28 green. **Not device-verified** — confirm on a HYROX plan that the run-pace forecast page shows Critical pace + the link, and Back round-trips correctly, then mark FIXED.

### ISSUE-275: Running mode lacks the under-duration guard tri has — underachiever load spiral *(P1 model, mirror-rule gap, 2026-06-05)*

Tri clamps effort deviations when actual < 80% of planned duration (`effort-multiplier.triathlon.ts:65-69`). Running's effort score (`events.ts:~987-1028`) blends RPE+HR only, no distance/duration adherence: a runner who completes 70% of the planned distance and rates RPE 2-3 scores "easier than planned" → `effortMultiplier` raises next week's load up to 1.15×. Chronic under-deliverers get pushed harder. Per the mirror rule, port the tri guard: clamp negative deviation to 0 when completed km < ~80% of planned. Also: week-end VDOT gain adherence is count-based not distance-based (`events.ts:895-916`).

### ISSUE-276: Chronic skipping is invisible to plan adaptation *(P1 model design, 2026-06-05)*

Skipped sessions produce no rating → excluded from effort scoring (2-week lookback, `effort-multiplier.triathlon.ts:51`; same shape in running). `computeTriAdherence`'s penalty (~2% at 0.80 ratio) feeds ONLY the race-forecast horizon, never the plan generator. Net: a 40%-skipper's plan never adapts downward, no coach trigger names the pattern, and the forecast stays ~2% optimistic. Needs a design decision: trailing completion-ratio input to the effort multiplier, a coach trigger at sustained <75% adherence, or both.

### ISSUE-277: Manual benchmarks can never be corrected downward; absurd values uncaveated *(P1 design, 2026-06-05)*

The yield-to-derived rule is improvement-only by design (CLAUDE.md): `main.ts:654-681` overrides user FTP only when derived ≥ current+3W. A wrongly-HIGH manual FTP (350W accepted by the [80,500] bounds at `review.ts:2587`) is permanent: power adherence floors the effort multiplier at 0.85 (−15% duration, can't fix a +75% watt error), no re-test prompt fires, and the race forecast renders the absurd prediction with zero sanity caveat (`race-prediction.triathlon.ts:206`, FTP→speed at :1224-1229). CSS same shape ([30,600] bounds). Needs: persistent-overshoot escalation (re-test suggestion when powerAdherence <0.75 for N weeks) and/or a forecast caveat when benchmarks sit outside plausible bands. Tristan decision — touches the manually-set-benchmarks rule.

### ISSUE-278: Running injury state doesn't age without modal re-opens *(P1, 2026-06-05, related ISSUE-261)*

(1) `evaluatePhaseTransition` (`injury/engine.ts:937`) only runs on modal save or workout generation — never on launch — so a reported injury stays at day-0 phase if the modal is never re-opened. (2) Running VDOT detraining during injury fires only when `wk.injuryCheckedIn` is set weekly (`events.ts:878-893`) — no check-in, no decay, fitness stalls frozen. (3) Plan view labels injury-rested runs as guilt-orange "Missed" (`plan-view.ts:903`) — illness has a suppression check (`:908`), injury doesn't. (4) The running race forecast never calls `injuryAdjustedBuildWeeks` (`race-forecast-simulation.ts:91`) — tri does (`blended-fitness.ts:561`). Tri/HYROX injury paths verified clean by the same sweep.

### ISSUE-279: Ghost-user return is silent — frozen CTL, no recap, possible silent plan end *(P2, 2026-06-05)*

Multi-week absence: VDOT detraining applies once, correctly capped (`welcome-back.ts:143-147` ✅), but (a) `ctlBaseline` never decays across the gap so home/stats show pre-absence fitness until the next Strava refresh, (b) no welcome-back recap exists (`showWelcomeBackModal` is never called), the week pointer just jumps, and (c) if the gap pushes past `s.wks.length` in non-continuous mode the plan silently ends with no end-state messaging.

### ISSUE-280: Partial tri setup — silent skill-level fallbacks, unlabeled estimates *(P2, 2026-06-05)*

With null CSS/FTP: race prediction silently substitutes skill-slider estimates (`race-prediction.triathlon.ts:206` CSS, `:845-850` bike speed) with no user-facing provenance; swim session descriptions omit the pace target entirely (`swim.ts:200`) where bike at least falls back to HR zones; the "No CSS"/"No FTP" workout chips only render when the benchmark test was *dismissed* (`triathlon/workout-card.ts:56-57`) — inverted logic, the chip should signal absence not acknowledgement. Fix: label estimates ("estimated from your skill level"), always chip missing benchmarks, add skill-pace hint to swim descriptions.

### ISSUE-281: Cycling-only mode content leaks *(P2 — low urgency, mode is hidden from goals picker, 2026-06-05)*

Cycling is in `HIDDEN_MODES` (`goals.ts:87`) so no new user can reach it, but for legacy/dev state: vibes "Run by Feel" nudge renders unguarded and can add a `discipline:'run'` workout to a bike-only plan (`triathlon/plan-view.ts:260,366`); tri debrief animation says "Analysing swim, bike, and run data" (`tri-week-debrief.ts:28-35` — the discipline ROWS are correctly filtered at :132, just the steps copy isn't); home today-card swim/run badge builder has no cycling guard (`home-view.ts:2879-2910`). Also if cycling is ever unhidden: it skips plan-preview-v2 entirely, and `commute.ts:89` copy says "Do you run to work?". Bundle these into the cycling-unpark session.

### ISSUE-282: Persona-sweep polish bundle *(P2/P3, 2026-06-05)*

- Daily coach claims recovery confidence with zero recovery data: "Freshness and load are good. Good session today" fires with `hasRecovery=false` (`daily-coach.ts:1127-1135`) — rephrase to the literal signals.
- Naked jargon: "TSS planned" label on main-view:424 (rename "Weekly Load" or gloss); "Fitness (CTL)"/"Fatigue (ATL)" labels unglossed inline (`freshness-view.ts:205`); coach copy exposes raw ACWR ratio "Load spike (1.45×)" undefined (`daily-coach.ts:896`).
- Stats "Recent weeks" shows literal `0 sessions / 0 load` instead of `—` for empty state (`stats-view.ts:792-803`).
- `hx.athleteBand.replace()` without null guard — crashes on corrupted state (`hyrox/plan-view.ts:154`, `hyrox/stats-view.ts:41`).
- ~~`coach-workout-modal.ts:377` indexes `wks[s.w-1]` unbounded~~ — FALSE POSITIVE on re-verify (2026-06-05): `wk` is guarded at every dereference (`wk ? :` at weekTssActual, `.filter` on lookWeeks) and `computeLiveSameSignalTSB` clamps internally. No fix needed.
- Stray DIAG `console.log` block `home-view.ts:1069-1090` (already marked for removal post-dogfood).
- `buildRaceForecastCard` (`home-view.ts:807-861`) appears to have zero callers — dead code or a missing home surface; decide which.

### ISSUE-283: Random logout converts real account to anonymous guest; sign-in flow shows confusing guest warning *(P1, 2026-06-05 — fix shipped, awaiting Tristan device confirmation)*

**Symptom (Tristan)**: app "logs me out sometimes"; on re-entering credentials the auth screen shows "Signing into an existing account will leave your current guest training data behind" — wrong, because the guest data IS the account's data. Email also had to be retyped every time.

**Root cause**: `getValidSession()` (`supabaseClient.ts`) and the boot path (`main.ts:197`) treated ANY token-refresh failure — including transient network errors, routine on iOS resume-from-background — as a dead session: `signOut()` (revokes the still-valid refresh token server-side) then `signInAnonymously()`. The real account silently became an anonymous guest; the SIGNED_IN owner-mismatch check then ran `clearState()`, wiping local state. The guest-upgrade auth view (defaulting to Sign up + the amber abandon-data warning) is the correct screen for real guests but the wrong one here.

**Fix (in code, suite 3228 green, NOT device-verified)**: (1) refresh failures classified via `isAuthRetryableFetchError` — network-shaped failures keep the session untouched (SDK auto-refresh retries; boot launches with the stale session); (2) a genuinely invalid token on a real account signs out locally (`scope:'local'`) to the honest sign-in screen instead of downgrading to guest; anonymous-fallback only for anonymous sessions; (3) last successful email stored in `localStorage` (`mosaic_last_email`), prefilled on the auth view, which now defaults to Sign in when a remembered email exists. Typed email also survives toggle/error re-renders.

**Follow-up (same day, Tristan dogfood screenshot)**: hitting "Save my account" with an already-registered email showed the raw Supabase error and dead-ended. Now auto-switches the form to Sign in (email kept, password focused) with "This email already has an account. Enter your password to sign in."; the amber guest warning is suppressed in that case since its "choose Sign up instead" advice is wrong for that email. Email persistence through the switch confirmed working by Tristan on device.

### ISSUE-272: Reschedule is the missing third lever — timing-aware readiness suggestions *(P2 design, Tristan, 2026-06-04)*

Found dogfooding the load-currency build. Scenario: readiness 15 driven by ACWR (safety), week projection ON target, hard session imminent (e.g. long run today/tomorrow). The system's two levers both fit badly: Reduce cuts volume the athlete doesn't need to lose (the week's budget is fine), Keep carries acute risk onto a high-impact session. The correct lever is **moving the session** — fatigue decays ~13%/day (7-day ATL constant), so a 2–3 day shift absorbs the spike at zero training cost.

**Decision tree (agreed in-session)**:
- Week projected OVER target → Reduce (existing modal, `triggerACWRReduction`).
- Week ON target + hard session within ~2 days + readiness floor (safety/recovery driven) → **offer Reschedule**: "Move [session] to [day]?" Target day = earliest day where projected readiness/ACWR recovers, respecting no-consecutive-hard-days (`checkConsecutiveHardDays`) and week boundaries. Reuse the existing workout-move machinery (workoutMods moves); suggestion-acceptance contract applies (user accepts before plan mutates).
- Week ON target + nothing hard imminent → caption only (shipped 2026-06-04: the canonical `computeAcwrReductionProjection` now gates the Reduce button's visibility/label/routing so no dead button shows).

**Related refinement (same session)**: when a cut IS warranted, the reduce modal ranks candidates by load-similarity, not date — it can downgrade Sunday's session when the risk peaks tomorrow. Date-aware candidate ordering belongs in the same build.

**Fork points for the build session**: auto-pick one target day vs offer 2 options; interaction with week debrief + mid-week moves; whether tri mode mirrors (per-discipline ramps complicate "move the run").

### ISSUE-271: Sign in with Apple — one-tap durable identity *(P3 nice-to-have, 2026-06-04)*

NOT an App Store 4.8 compliance requirement: 4.8 targets third-party/social login for the PRIMARY account; Mosaic's primary auth is first-party email/password (Supabase), and Strava/Garmin OAuth are data connections, not login. Worth building eventually because one tap beats typing an email mid-onboarding. **Landmine for whoever builds it**: native `signInWithIdToken({provider:'apple'})` LOGS OUT the anonymous user and signs into a different account — it would orphan the onboarding data ISSUE-270 protects. The anonymous-upgrade path must use `linkIdentity` (web-redirect OAuth, requires "manual linking" enabled in the Supabase dashboard + Apple Service ID config in the Apple Developer portal). Sources: supabase docs auth-apple, supabase-swift#588, supabase discussion #25976.

### ISSUE-270: Anonymous-by-default auth fragments user data across accounts *(P1 launch blocker class, 2026-06-04)* — protections built 2026-06-04, deploy + device verification pending

`main.ts:213` silently creates a fresh anonymous Supabase user on any launch with no session — fresh install, new device, or storage eviction (iOS WKWebView evicts localStorage under pressure). The user's Strava reconnect then forks their history under the new user_id, and the token-refresh cron keeps BOTH accounts alive forever. Discovered while root-causing the FTP 295→153 regression: Tristan's dev history is split across 4+ data-bearing accounts (gmail holds the Garmin webhook token; an anon account holds the 294-activity Strava backfill with the only power_curve ride; the app signs in as a third — 20 user_ids hold tokens for one Strava athlete). Pre-data-isolation this was masked because the unfiltered loader read all accounts' rows; the correct user_id filter exposed it. Users experience it as "the app forgot all my training". Note: `garmin_activities.garmin_id` is globally UNIQUE, so a forked account cannot even re-sync the history the old account owns. *(Originally filed as ISSUE-268; renumbered — a parallel session took 268 for the Garmin LT pipe.)*

**BUILT (2026-06-04, this session)**: (1) save-account overlay at the data-connect moment in onboarding (`src/ui/wizard/save-account-overlay.ts`, in-place `updateUser` upgrade, skippable); (2) fork guard in `strava-auth-callback` (`existing=N` redirect param) + `strava-claim-history` edge function (athlete-proof history move + old-token retirement) + client wiring (silent claim mid-wizard, confirm overlay on main view — `src/ui/history-claim-overlay.ts`, `src/data/strava-claim.ts`). **DEPLOYED 2026-06-04** (claim-history v1 verify_jwt true, callback v29 verify_jwt false, unauthed smoke test 401).

**HARDENING ROUND 2 (2026-06-04, same day)**: reconnect OAuth upsert clears `deleted_at` (retired/claimed-from accounts resurrect on legitimate reconnect); `sync-strava-activities` token select filters `deleted_at IS NULL` (a retired fork can no longer sync new rows under the abandoned user_id — kills the two-device re-fork loop); daily claim-on-launch convergence check (`maybeOfferClaimOnLaunch`, 24h device-local throttle — catches forks that form while this device is idle); the mid-wizard silent claim now shows an "Imported N activities" toast; save-account overlay errors mapped to actionable copy ("email already registered" → use Sign in) and the success card states honestly that recovery only works after the confirmation link is clicked. Both edge functions redeployed.

**PENDING**: device verification + Tristan's own consolidation (the claim path handles it: sign into the canonical account, reconnect Strava, import). Sign in with Apple assessed and parked as ISSUE-271 (not a 4.8 requirement). Detail: `READINESS_AUDIT.md §9f`, CHANGELOG 2026-06-04.

### ISSUE-267: recentRun feeds easy training runs into a race-grade predictor *(P1 model, 2026-06-04)*

Found in the LT-contamination diagnosis (§BO). `predictFromRecent` (`predictions.ts:88`) documents its input as a "Recent race/time trial" and extrapolates it Riegel-style at α=0.85 weight when fresh — but `computePredictionInputs.recentRun` (`prediction-inputs.ts`) is "most recent qualifying run" with pace-sanity filters only, no effort filter. Live consequence (Tristan, 2026-06-04): a fresh easy run extrapolated to a 1:45:50 half outvoted his same-distance 1:31:30 race PB (recent ~25% blend weight vs PB ~24% after the lowVolume shift), dragging the anchor to 1:38:52. **Fix direction**: `recentRun` should only populate when the run looks race-like — the race-detection predicate already exists in the same file (`RACE_FILTER_RATIO`: pace ≤ 85% of median training pace, currently used to EXCLUDE races from Tanda's P term; reuse it inverted). No race-like run in window → `recentRun` null → predictor falls back to PB (its documented contract). `s.rec` (user-declared recent race at onboarding) is unaffected — explicitly a race. **Why not yet done**: shifts predictions for every user with recent activity; Tristan to approve the model change. Counter-consideration: recentRun currently also serves as a "current form vs stale PB" dampener; after §BN/§BO the volume penalties + durability cap + PB-recency machinery cover that role with honest signals.

### ISSUE-266: Half/10K predictions have no volume-based endurance penalty *(P3 calibration decision, 2026-06-04)*

Found during the 1:26-half diagnosis (§BN). Both `marathonSpecificityPenalty` and `noLongRacePenalty` are gated `targetDist === 42195` (`predictions.ts:712`, `:765`), so at half/10K the long-run durability cap (max 4%/3%) is the ONLY endurance brake on a capacity extrapolation. The unified readiness framework already has calibrated half targets (50 km/wk, 1.5h longest, max 8% — `race-readiness-targets.ts:178`) but is deliberately triathlon-only per the parallel-implementation notice (`predictions.ts:687`). Extending it to running's half/10K shifts predictions for all low-volume users — a calibration decision Tristan deferred on 2026-06-04 when choosing the §BN fixes. Revisit if thin-data half predictions still read optimistic after the durability-cap parity beds in.

### ISSUE-265: Onboarding hero forecast ignores the athlete's baseline volume (no rampCtx) *(P2, 2026-06-04)*

The plan-preview hero computes its horizon gain via `forecastForSessions` (`plan-preview-v2.ts:415`), which calls `getPlanPrescribedMeanWeeklyKm(sessions, s.rd)` WITHOUT the `rampCtx` (baselineKm + archetype) that `initializeSimulator`'s own `calculateForecast` call threads (`initialization.ts` — `{ baselineKm: s.detectedWeeklyKm, archetype }`). A 10 km/wk starter is therefore projected as if absorbing the full plan-prescribed volume (~50 km/wk for 5 sessions) from week 1 — observed as a ~7-minute half-marathon horizon gain over 16 weeks (anchor 1:30:09 → forecast 1:23:04) on Tristan's thin-data onboarding. Fix direction: thread `{ baselineKm: s.detectedWeeklyKm, archetype: s.athleteArchetype?.archetype }` into the `calculateLiveForecast` call (it already accepts the dose inputs) or route through `calculateForecast`'s dual-mode ramp integration. Affects the hero, the milestone feasibility check, and the goal overlay (all read `forecastForSessions`). Now that §BN persists the typed volume into `detectedWeeklyKm`, the ramp has a real baseline to anchor on.

### ISSUE-264: First onboarding pass lost the typed 5K PB (`s.pbs: {}` at finalize) *(P2, unreproduced, 2026-06-04)*

Tristan's first thin-data onboarding pass typed an 18:10 5K in manual entry yet finalized with `s.pbs: {}` — the anchor (1:30:09) was built from the experience-level default LT (~245 s/km), not the PB, and `initializeSimulator` requires non-empty `pbs` to proceed (`initialization.ts:361`), so the PB must have vanished from wizard state before finalize, then something non-PB seeded the path. A second pass (typed 17:39) committed and finalized correctly, so it is NOT a deterministic handoff bug. Suspects, in order: (1) back-navigation re-rendering manual-entry/review and committing an empty field over the stored value (`commitPbs` deletes keys for unparseable/empty inputs — `manual-entry.ts:295-298`); (2) the stale-captured-state pattern in review's `commitEditing` (`review.ts:2530` spreads render-time `state.pbs`, the same staleness class manual-entry fixed at `manual-entry.ts:280`); (3) a mid-wizard Strava autofill race. Repro attempt: type a PB, go Back past manual-entry, Continue through again without retyping, finish — check `s.pbs`.

### ISSUE-263: Cross-training suggester mixes two load scales — budget vs cuts *(P2, 2026-06-04)* — fix shipped 2026-06-04, pending device verification

Found while answering "should the reduction modal display TSS?". The suggester budgets cuts against a credit from a **different load scale** than the cuts themselves:

- **Cuts** (`computeWorkoutWeightedLoad` → `calculateWorkoutLoad`, `workouts/load.ts:94`): explicitly "Calculate load to match GARMIN scale" via `LOAD_PER_MIN_BY_INTENSITY` (easy RPE4 = 1.5/min → 60-min easy ≈ 90).
- **Budget** (`effectiveRRC` from `computeUniversalLoad`'s `runReplacementCredit`): the iTRIMP tier normalises to "TSS-equivalent units" per its own comment (`iTrimp × 100 / 15000` → 60-min easy ≈ 55). Other tiers (RPE/HR) may sit on yet another effective scale.
- **Weekly-target math** (`overshootTSS` in main-view, `computePlannedSignalB`, `computeWeekRawTSS`): the TSS-calibrated `TL_PER_MIN` table (easy RPE4 = 0.92/min).

`buildReduceAdjustments` does `remainingLoad -= actualReduction` across these scales (suggester.ts:574). If the budget is TSS-scale and cuts are Garmin-scale (~1.6× larger per minute), each cut is over-valued against the budget and the suggester **systematically under-cuts** — plausibly part of why options absorb a small fraction of the displayed excess. Conflicting conversion annotations in-code: "20 TSS × 15 (load units per TSS approx)" (suggester.ts:1045), "1km easy ≈ 35 aerobic load" (suggester.ts:1246), "GARMIN scale" (load.ts:94), "TSS-equivalent" (universalLoad.ts computeTierAPlus).

**Blocked decisions**: displaying the reduction ask in TSS (Tristan's question) is a made-up-numbers violation until one canonical scale exists. **Direction**: pick a canonical internal scale (TSS via `TL_PER_MIN` is the app-wide lingua franca: Strain ring, Signal B, carriedTSS, CTL/ATL), convert at the universalLoad boundary, and add a unit-consistency test (60-min easy run should value ≈ 55 everywhere). Needs a dedicated session with calibration checks against real activities; do not point-fix a single conversion factor. **Full session handover: `docs/LOAD_CURRENCY_PLAN.md`** (scale inventory, live bugs B1–B3, ordered plan, decision list, risks).

**FIX SHIPPED (dedicated session, 2026-06-04 — SCIENCE_LOG §BP, full record in `docs/LOAD_CURRENCY_PLAN.md`).** The 15-agent audit found 8 scales, not 4. Everything canonicalised on TSS (1h@LT=100, Tristan sign-off): `calculateWorkoutLoad` emits TSS (type-keyed valuation `TSS_RPE_BY_TYPE`, easy=55/h); all four universalLoad tiers emit TSS (measured tiers lose sportMult; Tier B zone weights anchored Z4=100/h; Tier C keeps the 0.80 estimate discount); raw Garmin loads convert at ingest via per-RPE `garminToTssRatio`; the saturation curve's hidden 1.87× amplification replaced by the slope-1 form (TAU=491 TSS, CREDIT_MAX retired); SEV-1 fixed (Training Effect 0–5 never reaches `w.aerobic`); tri engine run stamps re-anchored; tri fitness model migrated to the gated personal normalizer; all ~25 hardcoded `/15000`+`/150` decodes routed through `normalizeiTrimp`; suggester/planSuggester budgets and cuts now same-scale (B1+B2); constants re-denominated together (LOAD_SMOOTHING 18.4, minLoadThreshold 3, minLoadToTrigger 18, EASY_LOAD_PER_KM 5.52, recovery cap 20 TSS); one-time `loadCurrencyV2` migration restamps stored tri-run/adhoc loads. Durable guard: `load-currency-anchors.test.ts` (17 anchors incl. a filesystem grep). 3,173 tests green. **NOT marked fixed: needs device verification — expect LARGER cuts on iTRIMP-path activities, smaller credits on RPE-only ones, and the modal now says "≈ N TSS — about X km of easy running".**

### ISSUE-261: Running injury adaptations don't apply at plan render *(P2, 2026-06-03)* — fix shipped 2026-06-04, pending device verification

Found during the mode-aware strain-target fix. `resolveWeekWorkouts` (week-resolve.ts) passed `injuryState=null` to `generateWeekWorkouts`, so the running Plan tab (and the strain target, same resolver) rendered the healthy plan during an active injury — while the activity matcher (`activity-matcher.ts:321`) already regenerated WITH `injuryState` for matching, so render and matching disagreed about the week.

**Fix shipped (Tristan approved 2026-06-04)**: `s.injuryState` threaded into `resolveWeekWorkouts`. The generator gates forward-only via `injuryAppliesToWeek` (past weeks never rewritten). During an active running injury the Plan tab, Home Today card, strain target, and coach all render the adapted week (relative-rest model: rest the injured area + region-safe strength). Old `workoutMods` keyed to healthy-plan slots no-op during adapted phases. Test: `planned-day-tss.test.ts` ISSUE-261 case. Suite 3107 green. NOT yet device-verified — needs a running-mode injury checked on device before marking ✅ FIXED.

### ISSUE-262: Two iTRIMP→TSS normalizers exist — /15000 hardcoded at ~30 display sites *(P3, 2026-06-03, premise corrected 2026-06-04)* — fix shipped 2026-06-04, pending device verification

**Original premise was WRONG** — the "33 vs 20" pairing was the actual ride's TSS vs a *different* (planned, injury-shortened) workout's TSS, not the same number on two surfaces. Device console check (2026-06-04): state holds ltHR 177 / rest 43 / max 201 → personal normalizer ≈ 15,556, within 4% of the population 15,000, so on Tristan's profile the two formulas agree to rounding. Downgraded to P3 hygiene: ~30 sites hardcode `/15000` (main-view, home-view, plan-view, renderer, activity-review, activity-matcher, stravaSync, etc.) while CTL/ATL and strain surfaces use `getNormalizerFromState`/`normalizeiTrimp`. For users whose LT sits far from 88% of max the surfaces would genuinely diverge. Eventual fix: route display sites through `normalizeiTrimp()`. No urgency for the current user base. Note: if ISSUE-268 lands LT HR 168, the personal normalizer drops to ~13,000 (TSS readings rise ~19%) and the divergence becomes visible — do 268 first, then revisit.

**FIX SHIPPED (load-currency session, 2026-06-04 — SCIENCE_LOG §BP).** Every hardcoded `/15000` and `/150` decode (~25 sites: displays, sync pipes, the matcher's `wk.actualTSS` cache, adaptive-recovery, the tri fitness model) now routes through `normalizeiTrimp()` — so when ISSUE-268 lands LT 168, every surface shifts together instead of diverging. The personal normalizer is now plausibility-gated (ltHR must sit at 80–95% of maxHR; out-of-band/corrupt watch values fall back to population 15000 AND are rejected at the LT-resolver intake). Anchor test 8 greps the codebase for regressions. NOT marked fixed until device-confirmed.

### ISSUE-268: Garmin lactate threshold never reaches the app — LT silently falls back to VDOT *(P2, 2026-06-04)* — fix shipped 2026-06-04, pending device verification

> Renumbered from a duplicate ISSUE-263 (parallel sessions collided on the number; 263 is the cross-training load-scale issue).

Tristan's watch has a measured LT (4:12/km, 168 bpm) but the app shows "3:59/km · 177 bpm · Low confidence · Derived from VDOT 56.0" (177 = the 0.88 × maxHR fallback). The LT pace drives threshold prescriptions, so sessions are currently ~13s/km too fast. DB evidence (2026-06-04): `physiology_snapshots` has 11 rows ever, latest 2026-05-19, **zero with `lactate_threshold_pace`/`lt_heart_rate`**; `daily_metrics` is alive through today, so the webhook works.

**Root cause**: Garmin only generates a userMetrics summary when VO2/LT *changes*. The launch backfill (`triggerGarminBackfill(8)`) requests an 8-day userMetrics window — Tristan's LT last changed before the webhook was registered, so no window has ever contained it. Injury (not running) also halts VO2 updates, which is why snapshots stopped 2026-05-19.

**Fix shipped (Tristan's policy decisions, 2026-06-04)**:
1. **Retention**: 60-day Garmin expiry removed (`resolveLT`) — watch LT holds until a newer reading, manual override, or a clearly-faster derived estimate (≥3s/km at medium+ confidence). Rationale: Garmin pushes userMetrics only on change; silence = unchanged. SCIENCE_LOG revised.
2. **Auto-apply**: the >10s/km Garmin-vs-derived suggestion card is retired (`recomputeLT`); watch readings apply directly, ≥10s/km shifts get a toast.
3. **Webhook hardening**: merge-preserving upsert in `handleUserMetrics` so a VO2-only push can't null a same-day LT. **DEPLOYED 2026-06-04** (garmin-webhook v87; smoke-tested: GET 200, unauthenticated POST 401).
4. **Deep historical backfill DROPPED** (Tristan): the existing 8-week connect-time backfill suffices for future users; older LT arrives on the next hard run.

**Remaining**: Tristan has set the manual override (4:12/km, 168 bpm — his own LT change event predates the webhook). Verifies fully the first time Garmin pushes a fresh LT and it auto-applies with a toast.

### ISSUE-260: Activity identity invariants — one binding, every surface, correct day *(P1, Tristan's 4-point spec, 2026-06-03)*

**Spec (Tristan, after a full evening of dogfooding the matching pipeline):**
1. **All activities present on all 3 screens** — Plan, Recent, Review must render from the same canonical set; an activity must never be visible on one surface and absent on another.
2. **Correct day** — an activity renders on the day it was actually recorded (`startTime`), not the planned slot's day. Running mode already derives an effective day from the actual's startTime at render; tri/HYROX plan-views read `w.dayOfWeek` directly, so tagging a Wednesday ride onto a Tuesday slot visually "moves" it to Tuesday (perceived as the activity disappearing).
3. **Tagging must never make an activity disappear** — assigning a recording to a slot re-homes it (slot card + slot-keyed actual); any path where the standalone card is removed without the slot card visibly carrying the activity is a bug. The 2026-06-03 incidents (day-moves, twin-era leftovers, `__pending__` limbo) all read as "my ride vanished".
4. **An activity binds to exactly one slot** — enforced as an invariant, not by convention. The twin double-assign (same ride Logged on Tue AND Thu) violated this via cross-source duplicate ids.

**Root-cause work already landed 2026-06-03** (CHANGELOG "Tri workout IDs, always-available review" + follow-ups): tri workout ids + regen bump, `__pending__`-limbo re-queue, twin reconcile before re-review, excess-ledger twin prune, regen preserving user-added sessions, same-day-first gym matching, `dropActual` clearing phantom ratings. **Remaining for this issue**: (a) tri/HYROX plan-views render matched slots on the ACTUAL's day (mirror running's effectiveDay); (b) one canonical "week activity join" feeding Plan/Recent/Review (extend `collectWeekActivities` and consume it everywhere); (c) an invariant check (reconcile or dev assert) that one garminId maps to at most one binding across rated/garminActuals/adhoc. Needs a fresh focused session with tests; do NOT keep point-patching surfaces.

### ISSUE-269: coach-workout-modal + session-recommendation compute their own readiness (no strain/recovery inputs) *(P2 drift, 2026-06-04)*

> Renumbered from a duplicate ISSUE-260 (parallel sessions collided on the number; 260 is the activity-identity-invariants spec).

Audit fallout from the Home-61-vs-detail-10 incident. Two more `computeReadiness` callers assemble their own inputs instead of sharing the card's: `coach-workout-modal.ts:395` and `session-recommendation.ts:64`. Both omit `strainPct` (no strain floor), omit `precomputedRecoveryScore`, use `ctlNow: s.ctlBaseline` instead of live same-signal CTL, and cap `weeksOfHistory` at 4. Their scores feed the LLM coach payload and the on-demand generator, so the coach can be told "readiness 78" while the ring shows 45. Fix direction: extract the full canonical readiness-input builder (the strain leg is done — `capacity-strain.ts`) and have all five callers consume it. Lower urgency than the ring split because these scores are advisory inputs, not user-facing rings.

### ISSUE-259: HR-based ride TSS undercounts interval sessions — power-based TSS for rides with power data *(P2 misleading, 2026-06-03)*

**Repro (dogfood, 2026-06-03)**: 56-min indoor VO2 session — 6 × 2min @ 350W / 145W recovery, 218W average, hard ramp-up — scored **43 TSS** via iTRIMP (raw 5202, personal normalizer ≈ 12,100). On the 1h-at-LTHR = 100 scale, 43 implies an easy-to-moderate ride; the actual session was a hard VO2 day. Power-based TSS (Coggan, NP²-weighted) for that session would land roughly 60–70 (FTP-dependent), i.e. iTRIMP undercounts by ~35%.

- **Why**: cycling HR lags power by 30–60s on 2-min intervals (already documented in CLAUDE.md's bike-effort-signal rationale — the same reason power adherence, not HR, is the primary bike *effort* signal). iTRIMP integrates the lagging HR, so short hard intervals never register at their true intensity. Readiness/strain consequences: the adhoc strain anchor read this session at 87% of typical daily load when it was likely 120–140%.
- **Direction**: rides carrying power data should compute Signal B TSS via Coggan power TSS (`(sec × NP × IF) / (FTP × 3600) × 100`, NP if available, else avg power as a floor), falling back to iTRIMP when no power. Needs: per-activity watts fields availability check (Strava `weighted_average_watts` vs Garmin webhook), FTP source (`triConfig` bike FTP, provenance-aware per the benchmark rules), and mirror-rule check against how running TSS is sourced.
- **Caution**: CTL/ATL are built from the same iTRIMP signal — switching rides to power-TSS changes the chronic baseline too. Whole-pipe change, not a point fix; coordinate with the day-TSS bug another agent is fixing (2026-06-03, planned-20/logged-42/expected-80 case).

### ISSUE-257: Onboarding gym choice may not reach the built plan (`s.gs` = 0 despite picking 2) *(P3 watch — did NOT reproduce manually, 2026-06-03)*

> **Update 2026-06-03**: Tristan ran onboarding manually with 2 gym sessions and they came through correctly. The Playwright repro used the ⚡ dev-fill + scripted clicks, so this is most likely a dev-fill/automation artifact, not a real-user path. Downgraded to watch; close if it never recurs.

**Observed in Playwright dogfooding** (fresh profile, isolated dev server, ⚡ dev-fill then manual steps): picked **2 gym sessions** on the schedule step (the "Your week" panel confirmed "2× gym"), finished onboarding → the built plan had **`s.gs = 0`** and zero gym sessions, while `s.onboarding.gymSessionsPerWeek = 2` was correctly persisted. Re-running `initializeSimulator(s.onboarding)` mapped it correctly (`s.gs = 2`, gym cards appeared) — so the mapping (`initialization.ts:488`) works; the wizard's init must have run with an onboarding object missing the gym count.

- **Root cause not isolated.** Possible suspects: the ⚡ dev-fill path (real users don't use it), a step-flow race between `updateOnboarding` (replaces `s.onboarding` via spread) and the object captured for `renderInitializing`, or scripted-click timing.
- **Next step**: reproduce WITHOUT the ⚡ dev-fill, slowly, watching `s.gs` right after init. If it reproduces, every new user who asks for gym sessions silently gets none — launch-relevant.
- **Workaround if hit**: Account → Strength sessions → re-save (rebuilds via initializeSimulator, which maps correctly).

### ISSUE-258: Plan-ready screen shows two different VO2 numbers (39.9 vs 53.0) *(P2 confusing, 2026-06-03)* — fix shipped, pending Tristan's visual confirm

On the onboarding "Your plan is ready" screen, the stats list showed **"Starting VO2max 39.9"** and, a few rows below, **"VO2 max 53.0 ml/kg/min"**. Root cause: the first row is `s.v` (the **VDOT**, wearing the "VO2max" label with the method subline), the second was `s.initialVO2` (the physiological estimate) — two different quantities under one name on one screen. **Fix (Tristan: "I don't think we should have 2")**: dropped the `ml/kg/min` row from `plan-preview-v2.ts`; the physiological VO2max stays on Stats where it has room to be explained. Found via Playwright dogfooding (the row is conditional on `initialVO2`, so it doesn't show on every profile — Tristan's review-screen check predates the plan-ready screen). Not yet visually re-confirmed on a fresh onboarding.

### ISSUE-256: Personal recovery rate (`k_user`) pins ~every athlete at the slow ceiling — predicted/observed scale mismatch *(P1 misleading, 2026-06-03)* — ✅ FIXED (device-confirmed value; card-polish reload pending)

**RESOLUTION (2026-06-03)**: Full intensity-banded redesign shipped (Tristan chose the largest defensible build). Fit basis changed from `observed/predicted` (incompatible scales) to `observed / expectedRecoveryHours`, where the expectation is the literature anchor (Stanley et al. 2013: easy 24h / moderate 36h / hard 54h) for the session's **intensity band**, classified from `GarminActual.hrZones` (Strava zones → fitness-relative) with RPE fallback. Only clean rest-gap windows are measured (training-through excluded); never-rest athletes are flagged `densityLimited` instead of mislabelled. Robust log-space aggregation. `backfillIntensityBands` retrofits existing entries. 46 tests, full suite 2964 green, tsc + lint:ui clean. Details: CHANGELOG 2026-06-03, SCIENCE_LOG `k_user` Addendum 2.

**DEVICE-CONFIRMED (Tristan, 2026-06-03)**: the value moved from the pinned **1.63× (worst)** to **1.02× (typical)** on his real data — the correct read for a fit athlete. Core fix verified. Card-presentation polish from the same check (verdict-first copy "Recovers at a typical rate", HRV pulse icon replacing the spinner-looking sun, and a **double-padding width bug** fixed — the card was nested in the already-padded Detailed Metrics section yet added its own `padding:0 16px`) ships in the same commit; awaits a reload to confirm it reads cleanly, but the substantive issue is resolved.

**Symptom**: Tristan (well-trained, high CTL) saw "Personal recovery rate 1.63× slower than average" — the `K_USER_MAX = 13` clamp. The model rated a strong athlete as the *worst* recoverer.

**Root cause (confirmed on real data, 2026-06-03)**: `fitKUser` fits `k = 8 × mean(observedHours / predictedHours)`, but the two terms are different physiological quantities on incompatible scales:
- `predictedHours` = the recovery-countdown's *training-readiness debt* (`8 × tss/ctlDaily × …`), ~8h for an average session by design (so you can train again same-day after easy work). Tristan's data: predicted p10/p50/p90 = **4 / 8 / 18.4 h**.
- `observedHours` = full *autonomic return* to the 28-day HRV/RHR baseline (z ≥ −0.25), sampled daily so the **floor is 24h**, and realistically 24–96h. Tristan's distribution: `{24:54, 48:10, 72:9, 96:10}`.
- Result: ratio p10/p50/p90 = **1.43 / 3.91 / 10.82**. The clamp pins at ratio ≥ 1.625, so even the 10th percentile is at the ceiling.

**Why it's universal, not athlete-specific**: to avoid pinning, predicted must average ≥ `24 / 1.625 ≈ 15h`, i.e. each session must be ~1.85× the athlete's *daily-average* load — most sessions aren't. **Any user reaching medium confidence (16+ closed sessions) lands at k=13.** Worse for fitter athletes (higher CTL → smaller predicted → bigger ratio). The feature has almost certainly reported "max slow" for every qualifying user; Tristan was the first to question the number.

**Three compounding obstacles to a fix**:
1. Scale mismatch (above) — predicted and observed measure different things.
2. No population anchor for "expected observed-recovery hours," so we can't define a normal ratio. `8` is the countdown's debt constant, never an observed-hours expectation.
3. The base constant serves two masters — raising it so ratio centres at 1 would 3–4× the user-facing recovery *countdown*, which is correctly calibrated at ~8h/session.

A naive self-normalization (centre on the athlete's own median ratio) does **not** rescue it — the ratio distribution is right-skewed, so the heavy tail drags k back to 11.56 in Tristan's preview. Any self-normalization must be robust (median / log-space).

**What the data CAN support**: a within-athlete, robust *deviation* signal — "are your markers returning slower than *your own* recent baseline" — a **state** signal (Plews/Buchheit HRV-vs-personal-baseline), not a population trait. This aligns with the card copy already de-peer-ified on 2026-06-03 ("vs the standard," not "vs other athletes").

**Already shipped 2026-06-03 (partial, real but minor)**: dropped confounded right-censored entries; capped sub-24h-prediction first-reading recoveries at on-time; reframed the card off the false peer comparison. These are correct in isolation but do **not** resolve the pin (the 48–96h sessions still have ratios of 10–30× against tiny predicted). SCIENCE_LOG `k_user` addendum (2026-06-03) documents them.

**DECISION PENDING (Tristan)** — pick the redesign direction:
- **(A) Robust self-normalization** — re-anchor `k_user` to the athlete's own median/log baseline; it becomes "recovery vs your own norm" (state, not trait). Constant-free, matches the reframed card, feeds the ceiling-shift only on genuine deviation. Cost: loses cross-athlete "faster than others" meaning.
- **(B) Separate population-anchored expected-observed-hours model** — decouple the learning's predicted from the countdown's predicted; needs a calibration number / literature anchor from Tristan (no made-up constants).
- **(C) Decouple + stop surfacing the absolute multiplier** — keep the countdown on k=8, drop the misleading "X×" number, show only the within-baseline trend.
- **(D) Disable/hide the card** until (A) or (B) is built.

Until decided, the card still shows a structurally-pinned number to any medium-confidence user. Code: `src/calculations/adaptive-recovery.ts` (`fitKUser`), `src/calculations/fitness-model.ts` (`computeToBaseline`), `src/ui/recovery-view.ts` (`renderPersonalRecoveryCard`).

### ISSUE-255: Residual edge-function CORS/auth hardening (deferred from 2026-06-02 security pass) *(P2, 2026-06-02)*

**Context**: A server-side security review (see CHANGELOG 2026-06-02) fixed the exploitable issues. These remaining items are JWT-gated defence-in-depth — **not exploitable today** — and were deliberately deferred to avoid restructuring the load-bearing data pipe in an untested bulk deploy.

**To do, with on-device sync testing**:
1. Replace wildcard CORS (`Access-Control-Allow-Origin: *`) with the restricted allowlist on `sync-activities`, `sync-strava-activities`, `sync-physiology-snapshot` (use the same `corsHeadersFor` pattern already applied to `sync-activity-details`/`sync-today-steps`/`garmin-backfill`). `sync-strava-activities` is the canonical activity source — test sync end-to-end before/after. Also check `garmin-refresh-token` / `garmin-auth-start` (redirect/refresh; CORS may legitimately be `*`).
2. `garmin-backfill` still verifies auth on a service-role client and reads/writes `garmin_tokens` through it. Not a bypass (token is cryptographically verified), but refactor to an anon client for auth + service client only for the token refresh write, matching `sync-activities`. Touches live Garmin token flow — test carefully.
3. Move `coach-chat` tool *definitions* server-side. The 2026-06-02 fix allowlists the 6 tool names, but description/input_schema still come from the client. Build the canonical tool schemas in the function (as `coach-generate-workout` does).
4. `garmin-backfill` refresh-error responses still return `details: txt`/`details: String(e)` to the client (minor info leak, same class as the callback leaks already fixed).
5. **(NEW, 2026-06-03 sweep)** `garmin-reconcile` and `garmin-refresh-token` were **missed by the original CORS sweep entirely** — both still `Access-Control-Allow-Origin: *` (`garmin-reconcile/index.ts:44`, `garmin-refresh-token/index.ts:13`). Apply the restricted `corsHeaders(req)` pattern (convert the static `corsHeaders` object to a per-request function + thread `req` through `jsonResponse`). Auth'd (JWT/cron-secret) so lower risk, but they are the last two auth'd functions outside the restricted pattern. **Structural change to the preflight — test before deploy** (the reason this whole issue was deferred).
6. **(NEW, 2026-06-03 sweep)** Extend the M2 error-leak cleanup beyond `garmin-backfill` (item 4): `garmin-refresh-token:90` (`details: text`), `garmin-auth-start:61,93`, `strava-auth-start:54,86`, and the `String(e)` fields in both OAuth callbacks still return raw provider/DB error strings. Log server-side, return a generic code.

**✅ DEPLOYED + smoke-tested 2026-06-03 (token restored):**
- `strava-auth-callback` (v28): dropped `raw: tokenJson` from the no-access-token error path (was returning a potentially-live OAuth token body to the client — HIGH). Smoke: bare GET → 400 `missing_code_or_state`.
- `garmin-reconcile` (v13): cron-secret compare switched from `===` to `constantTimeEqual` (timing-safe). Smoke: unauth POST → 401 `unauthorized`.

### ISSUE-252: AI Coach must not use Strava data (Strava API Policy §5.3) *(P1 strategic, 2026-06-01)* — decided, build deferred to Coach GA

**Context**: Strava's June 2026 API Policy (§5.3) bans using Strava Data — *including data derived/aggregated from it, and including ingestion into an LLM context window* — for the operation of any AI Application. §5.10 bans disclosing Strava Data to third parties (names AI providers). The AI Coach feeds Strava-derived training data (`coach-chat-client.ts:63-69`) to Anthropic.

**DECISION (Tristan, 2026-06-01)**: **Strava is non-negotiable** (only viable pipe for Garmin users), so **the AI Coach must not use Strava data**. In practice the Coach is **unavailable to Strava-connected users**; it may only serve Apple-Health-only / manual-entry users.

**Not a live violation now**: Coach is allowlist/entitlement-gated server-side (`entitlement.ts`), serving no general/Strava users. So this is a *before-GA* requirement, not a fire.

**Required at Coach GA** (deferred until then): gate the Coach off whenever Strava is a connected source for that user (or strictly exclude Strava-derived data — which for those users is effectively everything). Re-evaluate Tier-2 monetisation, since the paying cohort (serious Garmin/Strava athletes) is the one the Coach can no longer serve. Full reasoning in `docs/AI_STRATEGY.md → Update 2026-06-01`.

**Open question to ask Strava** (developers@strava.com): does BYOK (user's own Anthropic key, personal use) change anything? Don't assume it does — Mosaic still operates the pipeline.

### ISSUE-253: Strava disconnect must delete Strava data (API Agreement requirement) *(P1 compliance, 2026-06-01)* — small build, not started

**Problem**: On in-app Strava disconnect (`account-view.ts:2153`), we delete the `strava_tokens` row but **do not delete the synced Strava activity data** (`garmin_activities` rows where `garmin_id LIKE 'strava-%'`) and **do not call Strava `deauthorize`**. Strava's API Agreement requires deleting an athlete's Strava data on deauthorization.

**Interim (done 2026-06-01)**: the public privacy/support pages no longer claim "deleted within 48 hours" — softened to "disconnect stops syncing; to erase synced data, delete your account or email us" (a valid manual-deletion posture). So no false published claim, but the auto-delete is still owed.

**DECISION (Tristan)**: do the small build after the website work. Scope: extend the disconnect handler (or a small `strava-disconnect` edge function mirroring `delete-account`'s deauthorize) to call `deauthorize`, delete `garmin_activities` Strava rows, and strip `strava-` entries from state (`garminActuals`/`garminPending`/`rated`/`garminMatched`). **Keep** the derived benchmark scalars (VDOT/FTP/CSS) — Option A, chosen 2026-06-01. Once shipped, restore the stronger auto-delete wording on the website.

### ISSUE-254: Sync in-app legal pages to match the landing site *(P2, 2026-06-01)* — not started

**Problem**: privacy/support/terms exist in two places — the landing repo (`~/Documents/mosaic-landing`, what mosaicrunning.run + the Strava reviewer see) and the app repo `public/` (what the app displays in-app + serves at the vercel.app build). The 2026-06-01 edits (fleshed-out support page, softened deletion wording, fixed footer links) were made on the **landing** copy only. The app repo `public/privacy.html` / `public/support.html` are now stale.

**Fix**: copy the updated wording into `public/privacy.html` + `public/support.html` so the two stay consistent. Per memory, the app repo `public/` is meant to be source-of-truth — consider reversing the flow (edit `public/`, copy to landing) to avoid future drift.

**Note 2026-10-13 (lane HP, `d8bdff7`):** Both copies of the privacy page (`public/privacy.html:60` and `~/Documents/mosaic-landing/privacy.html:60`) say "No data is shared with other users or sold to third parties." HYROX Doubles partner matching shows a linked partner the athlete's race snapshot, so the wording has to change in both copies (ISSUE-399 (a)).

### ISSUE-251: Reuse the guided-session shape for running interval workouts *(P3, 2026-05-28)* — idea, not started

**Idea (Tristan, end of guided-strength session)**: "Using this format for people doing tempo runs on their phone, they can click log run at the end if they're doing 4×400m sprints and stuff like that." The guided-strength flow (tap to complete, log time per segment, auto-advance, finish summary) maps cleanly onto interval running done on the phone without a watch.

**Reuse path**: the existing GPS-driven `GuideController` (`src/guided/controller.ts`) handles paced runs. The strength flow's `StrengthGuideController` + overlay handles tap-driven sessions. A "phone-only intervals" mode would be the strength flow re-skinned for run reps — `parseRunIntervalSession(workout)` that turns the timeline's work/rec steps into `GuidedSet`s with `setCount=1`, the existing overlay walks them, the existing per-set time records capture each rep's measured time. No GPS, no pace target — just elapsed.

**Out of scope until requested**: the actual build, scope of which workouts qualify (just intervals, or also tempo / strides?), and whether to expose the choice as a toggle vs auto-pick when no GPS recording is active.

### ISSUE-250: Re-apply guided strength entry points after parallel-agent rollback *(P1, 2026-05-28)* — tri + HYROX modal entries re-applied; running gym card + tri compact card UX still need re-apply

**Symptom**: during the guided-strength build session, parallel agents rewrote `src/ui/triathlon/workout-card.ts`, `src/ui/triathlon/workout-detail-modal.ts`, and `src/ui/hyrox/workout-detail-modal.ts`, wiping the entry points to the guided overlay. The full core (controller, model, overlay, completion, HYROX adapter, rings, rest timer, countdown, station benchmark history) is intact — only the buttons that launched it were gone.

**Already re-applied (this session)**:
- Tri detail modal — `Start session` + `Mark as done` buttons added back when discipline is strength (`src/ui/triathlon/workout-detail-modal.ts`).
- HYROX detail modal — `Start session` + `Mark as done` buttons added back (`src/ui/hyrox/workout-detail-modal.ts`).

**Still needed (follow-up)**:
- **Running plan-view gym card**: the inline `Start session` button on `t === 'gym'` workouts (above `Mark as done`) was removed. `plan-view.ts:~638` block + the click handler near `:~3460` need re-adding. The handler decodes `workoutDescEnc` and calls `openGuidedStrength`.
- **Tri compact strength card**: the "N exercises · tap to view" replacement for the full description wall in `src/ui/triathlon/workout-card.ts` is gone. Card now shows the full `\n`-joined description again. Re-add the `isStrength` branch + `countExercises` helper.

**Why it matters**: the guided session works end-to-end on the test surfaces I re-applied. Running mode users currently can't launch the guided flow from a gym card without re-adding the entry. The card-UX regression is a polish issue, not a functional one (the description is still readable, just verbose).

### ISSUE-249: Strength session ignores injury mode (still shows 45-min full-body) *(P1, 2026-05-27)* — fixed in code, ⚠️ awaiting device verification

**Symptom (Tristan, production)**: "Despite being on injury mode, I'm still seeing strength come through. That's 45 minutes full body strength. Same as in coach. That shouldn't happen if I'm injured. The strength plan should also adjust." Desired behaviour: physio-led — shoulder injury → lower body only, leg injury → upper body only.

**Root cause (triathlon)**: `applyTriInjuryGates` (`plan_engine.triathlon.ts`) dropped the strength session only when `upperLoadCapacity <= 0`. But the injury modal only shows the upper/lower-load sliders in HYROX mode (`modal.ts:getRequiredCapacityFields`); a triathlete only sets run/bike/swim. So `upperLoadCapacity` stayed undefined → `getDisciplineCapacity` returned 100 → the full-body session never dropped. The session was gated on a control the athlete could not reach. The AI coach reads the same `wk.triWorkouts`, so it showed the identical session. **Running** had the mirror gap: the injury-aware gym generator was capable but ~27 display call sites passed `null` for injury state.

**Fix (this session)**: Region-aware, physio-led strength shared across modes.
- New `src/workouts/injury-strength.ts:injuryStrengthDecision` — phase-gated + region-aware. Drives off the injury `location` via `bodyRegionLoadability` (canonical `LOCATION_CAPACITY_DEFAULTS`, lifted from the UI modal into `src/injury/engine.ts`). Knee/hamstring/hip → upper-body + core; shoulder/wrist/elbow → lower-body + core; back/neck/chest → core dropped (trunk contraindicated); back / acute → strength paused. Loads submaximal (RPE ≤ 5), pain-gated, normalise once resolved.
- Triathlon (`applyTriInjuryGates`) + running (`gym.ts`) both call it; triathlon scales each retained session's `aerobic`/`anaerobic` by the adapted duration. 27 `generateWeekWorkouts` call sites now pass `s.injuryState` so plan + coach match the canonical regen.
- HYROX unchanged — stations already scale/drop by `min(upper, lower)`; per-component substitution within a fixed station stays future work.
- Science in `SCIENCE_LOG.md → §AN`. Tests: `injury-strength.test.ts` (11) + rewritten `gym.test.ts` injury block. Full suite 2264 pass; `tsc`/`lint:ui` clean for all touched files.

**Why still open**: device confirmation pending — set an active injury (e.g. a leg injury) in triathlon mode and confirm the plan + coach now show an upper-body/core session (or paused), not the 45-min full-body session.

### ISSUE-248: Updating an injury auto-advances/completes the current week *(P1, 2026-05-27, re-fixed 2026-05-29)* — ✅ FIXED (Tristan confirmed in-app 2026-05-30; on `main` @ `c3bb015`, pushed)

**Symptom (Tristan, production)**: "I just updated my injury for the new build and it's kicked me forward a week again." Recurring. Any edit to an active injury silently completed the current week.

**⚠️ Regression — the fix was lost.** Re-reported 2026-05-29 on `feat/revenue-cat-iap`. The fix below was documented on 2026-05-27 but was **not present in the codebase** — neither on this branch nor on `main` (both still had the unconditional `await next()` at `modal.ts` / `main:368`, and `advanceWeekAfterSave` existed nowhere). The doc entry survived a multi-agent rollback that reverted the actual code change. Re-applied 2026-05-29.

**Root cause**: `handleSaveInjury` (`src/ui/injury/modal.ts`) called `events.ts:next()` unconditionally whenever the injury was already active. `next()` is the full complete-week-and-advance flow (`s.w++`). The same `handleSaveInjury` runs for *every* entry point, so banner/button "update injury" edits — which are not trying to advance — advanced anyway. Compounding bug: `planStartDate` also drifted forward a week in at least one real case, so `s.w` and the calendar anchor disagreed (caught by `assertPlanAnchorConsistent()`).

**Why `next()` can't just be deleted**: there IS one legitimate path. When `next()` hits an active, un-checked-in injury (`events.ts:861-873`, acute/rehab/test_capacity phases) it opens the modal as a gate and `return`s without advancing; saving the check-in must re-call `next()` to resume that paused advance. The `return-to-run` and `graduated-return` phases use their own dedicated gate modals.

**Fix**: `openInjuryModal` takes an opt-in `{ advanceWeekAfterSave }` (module-level flag in `modal.ts`). Only the weekly check-in gate caller (`events.ts:873`) passes `true`. All banner / button / daily-check-in-overlay entry points stay bare → re-render in place via `render()`, never advance. `tsc` + `lint:ui` clean on touched files (`modal.ts`, `events.ts`).

**Verified**: Tristan confirmed in-app on 2026-05-30 that editing an injury no longer advances the week. Shipped on `main` (`c3bb015`, pushed to origin). The fix also lives in the `feat/revenue-cat-iap` working tree.

### ISSUE-247: Injured triathlon forecast projects almost no improvement *(P1, 2026-05-27)* — fixed in code, ⚠️ awaiting device verification

**Symptom (Tristan, production)**: Ironman 70.3, week 5 of 20, injured (can only bike). The race forecast showed only −6 min improvement. A 47:51 swim (~151 s/100m) is a genuine beginner-band swim sitting on the headroom shelf — it should be one of the *biggest* projected gains, not zero.

**Root cause**: `applyTriInjuryGates` (`plan_engine.triathlon.ts`) applied the current injury capacity uniformly to *every* current-and-future week (the per-week ramp had been deliberately removed — "the slider is the gradient"), so setting swim/run capacity to 0 today zeroed them for all 15 remaining weeks. The predictor (`predictTriathlonRace`) faithfully read that suppressed plan and extrapolated the next-4-week dose across the whole horizon. Neither the plan engine nor the predictor consulted any recovery duration — `expectedDurationWeeks` existed on the type but was never captured (always 0). Net: a 2-week injury was modelled as a 15-week one; only the bike leg moved the prediction.

**Fix (this session)**: Per-discipline recovery windows, captured + propagated.
- Capture: injury modal adds a "Back to full in N weeks" field per restricted discipline, seeded from the protocol's `typicalRecoveryWeeks` midpoint, user-adjustable. Stored on `InjuryState.resumeWeeksByDiscipline`.
- Plan: `applyTriInjuryGates` restores a discipline at its own resume week (binary cutoff; slider still sets magnitude inside the window). Legacy injuries with no captured window keep the conservative freeze.
- Forecast: `predictTriathlonRace` debits each discipline only its own recovery weeks of build time and samples the recovered dose from after the window; bike (unrestricted) keeps the full horizon. Plan and forecast share one source (`resumeWeeksByDiscipline`).
- Caption on the forecast card explains the result. Science: `SCIENCE_LOG.md → §AM`. Tests: gates restore-after-window, predictor monotonic recovery, volume offset. Full suite 2248 pass; `tsc` + `lint:ui` clean.

**Decisions captured (Tristan, this session)**: fix reaches *both* plan and forecast (not forecast-only); recovery duration is *asked* (pre-filled from protocol), not silent; granularity is *per-sport*, not a single number; forecast gets an explanatory caption.

**Why still open**: per CLAUDE.md, an issue is not marked FIXED until Tristan confirms on device. Verify with the real injured 70.3 state — set swim/run out ~2 weeks and confirm the forecast now shows meaningful swim/run gains and the Plan page restores swim/run after the window.

---

## 🚀 App Store Submission Audit (2026-05-18)

Audit run 2026-05-18 by 4 parallel agents (Apple guidelines, privacy/legal/IP, monetisation/IAP, reviewer experience). Tristan confirmed: log all severities (P0+P1+P2), work in priority order. Marketing URL is **optional** in App Store Connect — mosaicrunning.run product-landing rebuild is logged as P2, not a submission blocker. Apple mandatory URLs are Privacy + Support only, both already live on mosaicrunning.run.

**Work order**: P0 first (will reject) → P1 (likely reject) → P2 (polish). Mark each `✅ FIXED` per CLAUDE.md workflow.

### ISSUE-225: AI Coach "coming soon" cards visible to reviewers *(P0, 2026-05-18)* ✅ FIXED 2026-05-18

`src/ui/coach-view.ts:356-359` and `src/ui/account-view.ts:976` render "coming soon" cards with a "Join the waitlist" CTA. Apple guideline 2.3.1 explicitly forbids placeholder/future features in shipping builds. Reviewers are non-allowlisted (`src/coach/allowlist.ts:23` hardcodes Tristan's UID), so these cards are *all they will see of the headline AI Coach feature pitched in `docs/APP_STORE_ASSETS.md:31`*.

**Fix**: Removed the `comingSoonCard()` render from the classic Coach view and deleted both the card and its `wireComingSoonCard()` handler entirely. Stripped the "AI Coach / Coming soon / Subscription pricing announced soon" header block from the account-view group, leaving the (still-functional) Coach priorities row alone. The classic Coach screen now shows: hero → why → recovery → today's workout → feeling prompt → export-snapshot button. No placeholder copy anywhere. Marketing-side "coming soon" framing stays on the website only (per Tristan).

### ISSUE-226: No app-target `PrivacyInfo.xcprivacy` manifest *(P0, 2026-05-18)* ✅ FIXED 2026-05-18

Mandatory since May 2024. `find ios/App/App -name "PrivacyInfo*"` returns only vendored framework manifests, no app-level one. Capacitor/WKWebView/Supabase call Required Reason APIs (UserDefaults, file timestamps, disk space, system boot time) that must be declared.

**Fix**: Created `ios/App/App/PrivacyInfo.xcprivacy` declaring four API categories with required reasons: `NSPrivacyAccessedAPICategoryUserDefaults` (CA92.1 — app access to its own UserDefaults via Capacitor Preferences plugin), `NSPrivacyAccessedAPICategoryFileTimestamp` (C617.1 — file ops via WKWebView cache), `NSPrivacyAccessedAPICategoryDiskSpace` (E174.1 — Supabase/WKWebView capacity checks), `NSPrivacyAccessedAPICategorySystemBootTime` (35F9.1 — Capacitor timestamp util). `NSPrivacyTracking` set to false, `NSPrivacyCollectedDataTypes` empty (data flows live in the App Store Connect Privacy Nutrition entry, not the manifest).

**Deploy 2026-05-19**: `npx cap copy ios` run — manifests now live in `ios/App/App/public` ready for the next Xcode archive.

### ISSUE-227: Dead "Strava sync coming soon" toast on home header *(P0, 2026-05-18)* ✅ FIXED 2026-05-19 (original audit was wrong — see below)

The most prominent orange CTA on Home (`src/ui/main-view.ts:567`) fires `src/ui/main-view.ts:2715-2718` showing `showAdaptToast('Strava sync coming soon!...')`. Strava OAuth actually works (`src/ui/wizard/steps/connect-strava.ts:135-136` for first-run; `src/ui/account-view.ts:2072` for post-onboarding). A reviewer taps the orange Strava pill, sees "coming soon", concludes the integration is unimplemented. Guideline 2.3.1 / 4.0 false-advertising risk.

**Audit correction (cross-flow agent, 2026-05-19)**: The original audit was wrong about the file. `getMainViewHTML()` (which renders `renderStravaButton`) is dead code — `renderMainView()` now delegates entirely to `renderTriathlonPlanView` / `renderHyroxPlanView` / `renderPlanView`. The "coming soon" toast at `main-view.ts:2718` could never fire because the button that triggered it never renders. The actual user-visible Strava Connect button lives in `src/ui/account-view.ts:404/428` with the handler at `:2063`, and that handler had no error UX — it silently swallowed every failure, which on a reviewer device with flaky network reads as a broken integration.

**Fix**: Two changes.
1. The dead-code path in `main-view.ts:2716` was still updated to call the real `strava-auth-start` edge function (defensive — if `getMainViewHTML` ever gets re-wired back into the render path, the button works).
2. The live handler at `account-view.ts:2063` was hardened: disables the button during the round-trip, surfaces a `showSimpleToast` on every failure path (HTTP error, missing redirect URL, thrown exception), re-enables the button so the user can retry. Reviewer with poor Wi-Fi now sees "Could not start Strava connect. Check your connection and try again." instead of nothing happening.

### ISSUE-228: Bootstrap fully gated on Supabase reachability *(P0, 2026-05-18)* ✅ FIXED 2026-05-18

`src/main.ts:160-188` — any failure on `supabase.auth.getSession()` / `signInAnonymously()` dumps the user to `renderAuthView()` with no offline path. Apple's review network is famously flaky; a reviewer on poor Wi-Fi sees a blank/error auth screen they cannot bypass. Guideline 2.1.

**Fix**: Replaced the `renderAuthView()` fallback with an offline-bootstrap path. On `signInAnonymously()` failure, `launchApp()` runs anyway — localStorage drives the wizard + UI. A new `scheduleOfflineAuthRetry()` helper attaches a `window.online` listener and a 5-second timeout retry; once anonymous sign-in succeeds, the listener self-removes and the regular `setupAuthListener()` SIGNED_IN handler takes over. Net: a reviewer on poor Wi-Fi sees the wizard/home instead of a dead auth screen, and the app silently catches up when connectivity returns.

### ISSUE-229: iPad declared in build target but no iPad layouts *(P0, 2026-05-18)* ✅ FIXED 2026-05-18

`ios/App/App.xcodeproj/project.pbxproj:313,335` sets `TARGETED_DEVICE_FAMILY = "1,2"` (iPhone + iPad). All views are portrait iPhone layouts only. Reviewer testing on iPad Pro sees stretched UI. Guideline 2.5.1 ("works on all advertised devices").

**Fix**: Changed `TARGETED_DEVICE_FAMILY = "1,2";` → `TARGETED_DEVICE_FAMILY = "1";` in both Debug and Release configs (`project.pbxproj` lines 313 + 335). iPhone-only. Needs Xcode re-open to confirm the change loads cleanly in the project settings UI before archiving.

### ISSUE-230: Reviewer demo account is placeholder text *(P0, 2026-05-18)* — ✅ account live + web-verified 2026-08-04, pending device check

**Superseded plan**: no Strava connection needed. `review@mosaicrunning.run` exists on prod (user `9cbf8bb2`), email confirmed, and was seeded via the REVIEW code with the Sample Athlete marathon plan; the snapshot backs up to `user_plan_settings`, so a fresh-device sign-in restores the populated app directly (verified with Playwright on the current tree: storage wipe → sign-in → seeded Home, no wizard). Remaining: (1) confirm once on a physical device via TestFlight, (2) paste credentials + "account is pre-loaded; enter code REVIEW at the connect step only to re-seed" into App Store Connect review notes, replacing the stale simulator-mode wording. Password is with Tristan (set 2026-08-04).

### ISSUE-231: `AI_STRATEGY.md` Stripe path is 3.1.1-fatal if shipped to iOS *(P1, 2026-05-18)* ✅ DECIDED 2026-05-19 — Option A in flight via parallel paywall agent; v1 ships with allowlist as de facto gate

Today's binary is clean (no Stripe SDK, no payment surface). But the planned Tier 2 flow at `docs/AI_STRATEGY.md:79-84,149` — Stripe Checkout on web flips a Supabase row that unlocks the in-app coach — is the textbook example Apple rejects. The strategy doc's footnote at `:157` claiming "compliant as long as no in-app link" is wrong: the bar is "in-app digital unlocks require IAP", not "no in-app link to payment".

**Decision (Tristan, 2026-05-19)**: Option A — hybrid IAP via RevenueCat. A separate parallel agent is building the IAP integration in a feature branch; details in the dispatch prompt Tristan kept. Out-of-scope for v1 submission. **v1 ship plan**: the existing allowlist gate (`src/coach/allowlist.ts` + edge function `ALLOWED_USER_IDS` env var) stays as the de facto access control. Reviewers see the classic Coach view (ISSUE-225 fix). When the paywall agent's branch is ready it replaces the allowlist with a RevenueCat entitlement check — that ships as v1.1.

For v1: rate limit tightened from 30 → 10 calls/user/day in `supabase/functions/coach-chat/index.ts` to keep Anthropic spend bounded while only Tristan + manual allowlist additions can hit the endpoint. ⚠️ Edge function needs `supabase functions deploy coach-chat` for the cap to take effect.

**Paywall compliance hardening 2026-05-19**: Code review of `src/ui/coach-paywall.ts` (commit 8e6131d) flagged two Apple 3.1.3 blockers + two warnings — the legal disclosure paragraph was static and missing the subscription title, length, and price, and used "within 24 hours of the end" instead of the canonical "within 24 hours prior to the end". Fixed by deriving the disclosure block from the selected `PurchasesPackage` at every render (so switching between Monthly/Annual updates it) and correcting the renewal wording. Anti-steering check (3.1.3(a)) was already clean: no Stripe / web-checkout references on the paywall surface. Not a v1 blocker (allowlist still in force) but de-risks v1.1 review.

### ISSUE-232: HYROX trademark used without disclaimer *(P1, 2026-05-18)* ✅ FIXED 2026-05-18 (in-app + marketing); ⚠️ App Store description copy outstanding for Tristan

"HYROX" appears as a sport name across `src/ui/home-view.ts:2238`, `src/ui/hyrox/plan-view.ts:120` (48px heavy display), `marketing/carousel-hyrox.html`. HYROX is a registered trademark of HYROX GmbH. Nominative fair use is OK if disclaimer present; risk grows with marketing assets ("Training for HYROX" reads as a product promise).

**Fix**: Created `src/ui/hyrox/trademark-footer.ts` exporting `buildHyroxTrademarkFooter()` — single canonical disclaimer line ("HYROX is a registered trademark of HYROX GmbH. Mosaic is not affiliated with or endorsed by HYROX."). Mounted at the bottom of all three HYROX tab views (`plan-view`, `forecast-view`, `stats-view`) above the tab bar. Marketing carousel `marketing/carousel-hyrox.html` got the same disclaimer added to the CTA slide footer. Tristan still needs to add the same disclaimer line to the App Store Connect description copy when filling that field at submission.

### ISSUE-233: Health-claim methodology not surfaced (1.4.1) *(P1, 2026-05-18)* ✅ Code + deploy shipped 2026-05-19, awaiting on-device verification before final close

Description bullets at `docs/APP_STORE_ASSETS.md:30-32` claim "Race time prediction from VDOT, FTP, CSS", "Daily readiness from HRV, sleep, training stress balance, and ACWR". Apple 1.4.1 requires methodology disclosure for health-measurement accuracy claims. Health disclaimer modal exists but methodology citation is not surfaced in-app or in listing.

**Fix**:
- Created `public/methodology.html` — single-page methodology surface modelled on `public/privacy.html`. Sections: training load (TSS / Banister CTL-ATL-TSB / ACWR), race prediction (VDOT / FTP+CP / CSS / course factors), readiness (composite signal + z-score against personal baseline), limitations, full bibliography (Banister, Coggan, Daniels, Gabbett, Hulin, Manzi, Monod-Scherrer, Wakayoshi). Includes a "not a medical device" disclaimer at the top.
- **In-app drill-down (2026-05-19)**: replaced the external `target="_blank"` links with an in-app methodology view (`src/ui/methodology-view.ts`) mirroring the `buildCTLLearnMorePage` pattern. Four per-surface entry points wire from `race-forecast-view.ts`, `readiness-view.ts`, `triathlon/forecast-view.ts`, `hyrox/forecast-view.ts`. Each opens with sections relevant to that surface only (running predictor shows VDOT + course factors; tri shows FTP/CSS too; etc.) and returns to the opener on back-button.
- **Marketing site deployed (2026-05-19)**: pushed `methodology.html`, `privacy.html`, `support.html`, `terms.html` from `public/` to the `~/Documents/mosaic-landing` repo (commit `c4e5d1d`) and ran `vercel --prod`. All four URLs now return 200 (previously 404 — the audit memory was wrong about privacy/support already being live). External page kept because privacy and terms are still linked from `coach-paywall.ts`, `account-view.ts`, `coach-view.ts`, and Apple reviewer flow uses the public URL.
- Added the App Store description sentence "Built on published exercise-physiology models (Banister impulse-response, Daniels VDOT, Coggan TSS)." to `docs/APP_STORE_ASSETS.md` so Tristan can paste it into App Store Connect at submission.

### ISSUE-234: Illness modal medical language *(P1, 2026-05-18)* ✅ FIXED 2026-05-18

`src/ui/illness-modal.ts:138` reads "Below-neck (chest, fever, body aches) needs rest." `src/coach/coach-chat-client.ts:225` references "myocarditis risk". The neck-check is standard sports-med folk wisdom; naming myocarditis crosses into clinical territory.

**Fix**: Three user-facing strings rewritten to non-clinical wording.
- `illness-modal.ts:138` header copy → "Mosaic recommends rest until symptoms clear. Consult a clinician for chest symptoms or fever."
- `illness-modal.ts:582` rest-window override prompt → drops "below-neck illness" + "viral myocarditis", now reads "raises the risk of relapse, particularly with chest involvement or fever … consult a clinician if you are unsure."
- `coach-chat-client.ts:225` system-prompt line → drops "myocarditis", now defers to a clinician for chest symptoms or fever instead of offering training guidance.
Internal source-code comments (`illness-modal.ts:12` doc comment, `illness-rules.ts` model commentary citing Schwellnus 2016) kept intact — App Review only sees user-facing strings, and the internal terminology is load-bearing for the model.

### ISSUE-235: `UIBackgroundModes` audio is justifiable but undisclosed in listing *(P1, 2026-05-18)* ✅ FIXED 2026-05-18 in `APP_STORE_ASSETS.md` (Tristan to paste into App Store Connect at submission)

`ios/App/App/Info.plist:60-64` declares `audio` background mode for the `@mosaic/guided-voice` plugin (`guided/voice.ts:146` uses `AVAudioSession(.playback)` for voice playback while screen-locked). Justifiable but reviewers scrutinise `audio` mode heavily.

**Fix**: Added to `docs/APP_STORE_ASSETS.md` description block — new bullet "Guided audio runs with voice cues that play while your screen is locked". Added to App Review notes — new line "Audio background mode: used by the guided-audio runs feature to play voice training cues while the screen is locked or the app is in the background." Tristan to paste both into the App Store Connect description + review-notes fields at submission.

### ISSUE-236: Strava token revocation on account-delete is async-only *(P1, 2026-05-18)* ✅ FIXED 2026-05-18 (needs `supabase functions deploy delete-account`)

`docs/PRESUBMISSION_TEST.md:86` says Strava revocation is checked manually with a 30-day cron fallback. `supabase/functions/delete-account/index.ts` does not call Strava's `/oauth/deauthorize` synchronously on user-triggered deletion. Apple 5.1.1(v) expects clean revocation of third-party access on account deletion.

**Fix**: Refactored `revokeStravaToken` in `supabase/functions/delete-account/index.ts` to:
- Wrap the `fetch` in an `AbortController` with a 5-second timeout (Apple's review network is not a place to hang on a slow Strava response).
- Return a structured result (`success` / `no_token` / `failed` with reason: `timeout` / `network_error` / `http_error` + status code).
- Caller logs the outcome with the userId and adds `strava_revoke` to the response body so support can debug post-hoc and the client knows what happened.
- Token row is already marked `deleted_at = now()` before the revoke fires, so a failed revoke does not block the deletion — the 30-day purge cron remains the safety net.

⚠️ **Edge function must be re-deployed** for the fix to take effect — Tristan needs to run `supabase functions deploy delete-account` (or merge to main and let the deploy pipeline pick it up).

### ISSUE-237: Custom Capacitor plugins likely missing `PrivacyInfo.xcprivacy` *(P1, 2026-05-18)* ✅ FIXED 2026-05-18

`@mosaic/guided-voice` (audio category) and `@mosaic/health-extras` (health category) are Tristan's own plugins. Both fall under Apple's "commonly used third-party SDK" list that requires per-plugin privacy manifests. `@transistorsoft/capacitor-background-geolocation` already ships one (verified).

**Fix**: Created `PrivacyInfo.xcprivacy` inside each plugin's source folder:
- `ios-plugins/guided-voice/ios/Sources/GuidedVoicePlugin/PrivacyInfo.xcprivacy`
- `ios-plugins/health-extras/ios/Sources/HealthExtrasPlugin/PrivacyInfo.xcprivacy`

Both declare `NSPrivacyTracking=false`, empty `NSPrivacyCollectedDataTypes`, empty `NSPrivacyAccessedAPITypes`. Source inspection of `GuidedVoicePlugin.swift` confirmed it only uses `AVSpeechSynthesizer` + `AVAudioSession` (neither is a Required Reason API); `HealthExtrasPlugin` reads from HealthKit which is declared at the host-app level via `NSHealthShareUsageDescription` (no privacy-manifest implication for the plugin itself). Updated both `Package.swift` files to register the manifest via `resources: [.process("PrivacyInfo.xcprivacy")]` so SPM bundles it with the target.

### ISSUE-238: Privacy policy overclaims Anthropic data retention *(P1, 2026-05-18)* ✅ FIXED 2026-05-19

`public/privacy.html:75` states Anthropic data is "not used to train... not retained beyond operational period". This requires a Zero Data Retention (ZDR) agreement; Anthropic's standard Commercial Terms have 30-day default retention.

**Fix**: Tristan confirmed 2026-05-19 — no ZDR agreement with Anthropic. Path (b) taken plus a reframe to match v1 reality (AI Coach is allowlist-gated in this release per ISSUE-231 decision). Rewrote the entire `public/privacy.html` AI Coach section:
- Section heading renamed "AI Coach (private beta in this release)".
- New opening paragraph states the feature is on a limited internal access list while the subscription path is being built, and that users not on the list have no data flowing to Anthropic at all.
- Retention paragraph rewritten honestly: "Anthropic retains messages for up to 30 days under their Commercial Terms, after which they are deleted. Anthropic does not use these messages to train their models." Links to both the Anthropic Privacy Policy and Commercial Terms preserved.
- Final-paragraph copy adjusted from "first time you open the AI Coach" to "when the AI Coach becomes generally available you will be asked to consent" — accurate for the v1 state.

Deployed 2026-05-19 alongside methodology/support/terms — `https://www.mosaicrunning.run/privacy.html` returns 200 with the rewritten copy. Commit `c4e5d1d` in `~/Documents/mosaic-landing`.

### ISSUE-239: `Info.plist` declares landscape orientations, no landscape layouts exist *(P2, 2026-05-18)* ✅ FIXED 2026-05-18

`ios/App/App/Info.plist:35-40` lists `UISupportedInterfaceOrientations` including landscape. The app is portrait-only by design.

**Fix**: Stripped the landscape entries from `UISupportedInterfaceOrientations`, leaving only `UIInterfaceOrientationPortrait`. Removed the `UISupportedInterfaceOrientations~ipad` key entirely (no iPad target per ISSUE-229).

### ISSUE-240: `NSHealthUpdateUsageDescription` borderline wording *(P2, 2026-05-18)* ✅ FIXED 2026-05-18

`Info.plist:58-59` reads "Mosaic does not write data to Apple Health. (Required by HealthKit.)". Apple has rejected apps for usage strings that explain *why* a permission key is present rather than *what the app does with it*. Borderline acceptable, safer to remove.

**Fix**: Removed both the `NSHealthUpdateUsageDescription` key and its value from `Info.plist`. Only `NSHealthShareUsageDescription` remains (which is honest — Mosaic reads from Apple Health, never writes). `docs/LEGAL_CHECKLIST.md` HealthKit row updated to reflect the change.

### ISSUE-241: `window.alert()` calls across the app *(P2, 2026-05-18)* ✅ FIXED 2026-05-18

Spans `src/ui/account-view.ts:1543,1573,1574,1789,1818,2300`, `src/ui/pending-deletion-banner.ts:94`, `src/ui/account-legal.ts:144`, `src/ui/renderer.ts:78`, `src/ui/main-view.ts:1543`. Native iOS WKWebView renders `window.alert()` with the app's URL in the title — reviewer-noticeable web-app smell. Functional but unpolished; Apple 4.2 minimum-functionality concern.

**Fix**: Added a generic `showSimpleToast(message, kind?)` helper in `src/ui/toast.ts` (info / error variants, auto-dismiss 5s/7s, tap to dismiss, multi-line on `\n`, same Apple shadow + border treatment as the existing assignment toast). Swept the codebase and replaced every `alert()` call with it.
- `src/ui/events.ts` — 13 calls (PB sanity messages, plan-not-initialised, RPE/duration validation, training-plan completed, race-prediction failure). Sentence-case copy with full stops per UI Copy rules.
- `src/ui/account-view.ts` — 6 calls (sleep target, max HR, resting HR validation; rebuild-plan onboarding-missing, rebuild-plan failure, recalculate failure).
- `src/ui/renderer.ts` — Garmin-cleared confirmation now shows the toast then reloads after 600ms.
- `src/ui/pending-deletion-banner.ts` — cancel-deletion failure.
- `src/ui/account-legal.ts` — data-export failure.
- `src/state/persistence.ts` — load-state failure toast deferred with `setTimeout(1500)` + dynamic import to avoid an early-render no-op and a circular UI import from a persistence module.

The audit listed 5 files; sweep found 16 calls across 5 files plus `events.ts` and `persistence.ts`. All replaced. Zero `alert(` calls remain in `src/` outside tests.

`confirm()` calls (e.g. `account-view.ts:1791` rebuild-plan destructive op) NOT touched — would need a custom confirm modal, out of scope for this submission pass. Logged as **follow-up**: replace `confirm()` calls with an in-app confirm-modal pattern.

### ISSUE-242: `window.diagnoseVO2` attached in production builds *(P2, 2026-05-18)* ✅ FIXED 2026-05-18

`src/main.ts:33` attaches a debug global. Discoverable via Safari Web Inspector. Not a hard reject vector but signals "unfinished".

**Fix**: Wrapped the `(window as any).diagnoseVO2 = ...` assignment in `if (import.meta.env.DEV) { ... }`. Vite strips the block in production builds, so the global is gone from the shipped iOS bundle. Comment updated to call out the gate.

### ISSUE-243: `PRIVACY_NUTRITION_LABEL.md` has "Product Interaction = TBD" *(P2, 2026-05-18)* ✅ FIXED 2026-05-18

`docs/PRIVACY_NUTRITION_LABEL.md:116` is unresolved. Audit confirms no PostHog/Mixpanel/Sentry/Firebase/Amplitude SDKs in `package.json` — the answer is **No**. Resolve before App Store Connect entry to avoid Apple's automated mismatch check.

**Fix**: Set Product Interaction = **No (not collected)**. Note rewritten to clarify analytics are NOT wired in the submission binary and to remind the next dev that any future analytics SDK addition must re-submit the Privacy Nutrition entry in App Store Connect before that build goes live.

### ISSUE-244: Apex-to-www 307 redirect on privacy URL *(P2, 2026-05-18)* ✅ FIXED 2026-05-18

`mosaicrunning.run/privacy.html` returns 307 → `www.mosaicrunning.run/privacy.html`. Works, but some App Review reviewers have flagged redirects on the privacy URL field in App Store Connect.

**Fix**: Added a "Submission-time URL note" callout to `docs/LEGAL_CHECKLIST.md` under Public Pages: when entering Privacy / Terms / Support URLs in App Store Connect, use the `www.` prefix directly (`https://www.mosaicrunning.run/privacy.html`, etc.) to avoid the apex 307. Submission-time instruction only — no code change required.

### ISSUE-245: Rebuild `mosaicrunning.run` as a real product landing *(P2, 2026-05-18, OPTIONAL)*

Currently a "Coming Soon" sign-up page. Apple's Marketing URL field is **optional** in App Store Connect — leaving it blank just removes the "Developer Website" link from the listing. Rebuild is a credibility/conversion improvement, not a submission requirement.

**Fix decision (Tristan, 2026-05-18)**: Logged but not a submission blocker. Treat as post-launch work unless Tristan wants to bundle it. Estimated ~1 hour of work for a single-page landing (headline + 3 screenshots + App Store badge) keeping privacy/terms/support endpoints intact.

### ISSUE-246: Anti-steering compliance when IAP ships *(P2, 2026-05-18, FUTURE)*

When ISSUE-231 (Tier 2 monetisation) resolves with any IAP path: NO "subscribe on web" copy in-app, NO Stripe portal deep-link from Account view, NO price comparisons between in-app and web pricing. Apple 3.1.3 intro paragraph. Not actionable until ISSUE-231 is decided.

**Fix decision**: Deferred — depends on ISSUE-231 outcome.

---

## 🔴 TOP PRIORITY — Next session

### ISSUE-224: Cycling-only mode lacks race-outcome retro card *(P3, 2026-05-18)*

`isCyclingOnlyMode(state)` paths render `renderRaceOutcomeRetroCard(s)` at `src/ui/triathlon/forecast-view.ts:108`, but `triConfig.raceLog` is only populated by `tri-race-outcome.ts` for full triathlon events — never for cycling-only events. So a user who finishes their cycling-only event never sees a retro card. Fix needs a `cyclingRaceLog` field on triConfig (new optional state) populated by a new `cycling-race-outcome.ts` detector wired into `detectRaceOutcomeAfterSync` in `main.ts`, plus a `renderCyclingRaceOutcomeRetroCard` mirroring the existing pattern. Predicted slot = cached `predictCyclingEvent` output from race-day; actual = sum of activity duration in the race window.

### ISSUE-223: HYROX station-level retro detail *(P3, 2026-05-18)*

`renderHyroxRaceOutcomeRetroCard` shipped in 2026-05-18 with a single-discipline "you beat your target by X" line. The `HyroxRaceLogEntry` shape doesn't currently carry per-station actuals, so we can't surface "Sled push 12s faster than predicted" without first extending `hyrox-race-outcome.ts` to capture station splits from the race-day activity. Worth doing when we have a HYROX-tracked race in the wild to validate the parsing path. Files: `src/types/triathlon.ts` (HyroxRaceLogEntry extension), `src/calculations/hyrox-race-outcome.ts`, `src/ui/hyrox/forecast-view.ts`.

### ✅ ISSUE-222: Audit all hardcoded `iTrimp * 100 / 15000` call sites *(P2, 2026-05-18, FIXED 2026-05-18)*

Display paths across `activity-detail.ts`, `home-view.ts`, `main-view.ts`, `plan-view.ts` (running), `renderer.ts`, `sport-picker-modal.ts`, `activity-review.ts`, `excess-load-card.ts` (including a local `ITRIMP_NORMALIZER` constant), `workout-insight.ts`, `sleep-insights.ts`, `cross-training/timing-check.ts`, and `cross-training/universalLoad.ts` were converting iTRIMP→TSS with a hardcoded `15000` divisor, diverging from the daily-load chart / rolling-load ring / weekly TSS chart for any athlete with a computed normalizer.

**Fix**: `normalizeiTrimp` exported from `fitness-model.ts` and called from every display path. `runSpec` multipliers preserved. Storage paths (`data/stravaSync.ts` calibration thresholds, `data/appleHealthSync.ts` historic baseline) intentionally NOT touched — they run at sync time when the normalizer may not yet be initialized, and their `tssPerHour` bounds were tuned against the fixed divisor.

### ✅ ISSUE-221: Triathlon past-week "Completed" list still keys on `status === 'completed'` *(P2, 2026-05-18, FIXED 2026-05-18)*

`buildCompletedEfforts` in `src/ui/triathlon/plan-view.ts` filtered `triWorkouts` by `status === 'completed'` and went empty when the matcher hadn't run.

**Fix**: replaced the past-week-only Completed card with a new `buildDoneActivitiesList` that renders on current + past weeks, iterates `wk.garminActuals` directly (no matcher dependency), and shows discipline · name · day · duration · TSS-done-of-planned · effort signal per row. Tapping a row routes to the existing `renderActivityDetail` page so the full HR zone / split / route breakdown is one tap away.

### ISSUE-220: i18n — coach copy + error messages are English-only *(P3, 2026-05-17, DEFERRED)*

Coach system prompt, toast copy ("Back tomorrow", "this week"), and chip-reply rules all hard-code English. Mosaic has no i18n pattern in the codebase yet. Deferred until there's a concrete non-English user requirement.

### ✅ ISSUE-219: Coach system prompt now built server-side (was tamperable) *(P2, 2026-05-17, FIXED 2026-05-17)*

The system prompt was constructed client-side and sent in the POST body as `system_prompt`. A non-allowlisted (future paid) user could replace it with anything under 16K chars on the wire — rewriting refusal rules, scope guardrails, or eliciting arbitrary output. Tolerable at single-user alpha but a real security issue once the allowlist opens.

**Fix**: edge function now builds the prompt server-side from a `coach_context` JSON payload via `buildSystemPromptServer`. Any client-supplied `system_prompt` is logged and ignored. Client `buildSystemPrompt` stays for the "Export training snapshot" feature only, with a doc comment noting the canonical lives in the edge fn and the two must be kept in sync manually.

### ✅ ISSUE-218: Token-budget guard on coach context *(P2, 2026-05-17, FIXED 2026-05-17)*

`buildCoachContext` could emit a payload that hit Anthropic's input-token ceiling on long programs with 16+ weeks of skeleton + adaptation log + memory + 4 weeks of activities. Cost risk grew with context size.

**Fix**: `applyTokenBudget(ctx, currentWeek)` trims in order of decreasing essentialness when the JSON exceeds 40,000 chars (~10K tokens):
1. Drop `adaptation_log`
2. Trim `plan_skeleton` to current week ± 2
3. Drop oldest `recent_activities` (down to 5 most recent)

Console-warns when triggered.

### ✅ ISSUE-217: Running `reduce_workout` description didn't scale at render *(P2, 2026-05-17, FIXED 2026-05-17)*

Running workouts regenerate fresh each render, so the AI reduce-mod (which leaves `newDistance` empty) couldn't pre-bake the scaled description like the in-place tri/hyrox path does. Result: the workout card showed "Coach: Reduced 30%" but the description still read the full volume.

**Fix**: both mod-application loops in `plan-view.ts` now call `scaleWorkoutDescription` at render when `mod.aiModifiedAt && mod.autoReduceNote && mod.status === 'reduced'`. The pct is parsed out of the autoReduceNote. Workout name gets a `(reduced X%)` suffix if not already present.

### ✅ ISSUE-216: Coach payload could exceed the edge function's 32 KB cap *(P1, 2026-05-17, FIXED 2026-05-17)*

Long chat sessions could approach 32 KB (7K system prompt + ~17K context + history). Edge fn would 413 and the UI showed a generic error.

**Fix**: `streamCoachChat` now pre-flights the body size and trims oldest message pairs (preserving the first turn + recent context) until under 30 KB. If a `payload_too_large` ever escapes, the client surfaces "This conversation got too long. Tap ↻ to start a fresh session."

### ✅ ISSUE-215: `force_tool_use` over-eager on bare affirmatives *(P1, 2026-05-17, FIXED 2026-05-17)*

"yes" / "ok" / "do it" was forcing `tool_choice: any`, producing spurious tool calls when the user was answering an information question rather than confirming a proposed change.

**Fix**: `isClearDirective` now takes the prior assistant turn as a second arg. Bare affirmatives only count as a directive when the prior turn contained tool-intent phrasing ("Want me to…", "I'll reduce…", "Cutting Tuesday's swim…"). New unit-test cases cover both branches.

### ✅ ISSUE-214: `lastToolDropReason` module-level race on parallel tool streams *(P1, 2026-05-17, FIXED 2026-05-17)*

If Anthropic emits two tool_use blocks back-to-back in a stream, the singleton `lastToolDropReason` from `coach-tools.ts` could be clobbered.

**Fix**: new `validateToolCall(toolName, input)` returns `{ change }` or `{ dropReason }` inline. Chat-stream consumer uses the new API; back-compat shim left in place for legacy callers.

### ✅ ISSUE-213: HRV trigger headline doubly-negated *(P1, 2026-05-17, FIXED 2026-05-17)*

`"HRV is -20% below baseline"` reads as "negative twenty below" — minus sign and "below" both encode direction. Fix: `coach-triggers.ts` uses `Math.abs(pctRounded)` for headline + primer copy.

### ✅ ISSUE-212: Vacuously-passing running adjust_intensity test *(P2, 2026-05-17, FIXED 2026-05-17)*

`coach-tools.test.ts` wrapped its assertion in `if (change) { ... }` so a silent breakage of the validator would let the test pass.

**Fix**: test now builds a `PendingChange` directly (skipping the generator-dependent validator) and unconditionally asserts the apply path produces a workoutMod with `aiModifiedAt`, `zoneCap=2`, `status='reduced'`, `newType='easy'`, `newRpe=2`.

### ✅ ISSUE-211: Coach `cardTitle` + `classicHero` stance badge violated Visual Constraints *(P2, 2026-05-17, FIXED 2026-05-17)*

Two surfaces used `text-transform:uppercase` + `letter-spacing`, banned by `UX_PATTERNS.md → Visual Constraints`. Fix: both rendered as sentence-case, no transform/spacing.

### ✅ ISSUE-210: Consent modal lacked `shownThisSession` guard *(P2, 2026-05-17, FIXED 2026-05-17)*

Per CLAUDE.md reveal-popup rules, all gating modals should have both a persisted flag AND a module-level `shownThisSession` boolean. Intro and priorities had it; consent did not.

**Fix**: added a `consentShownThisSession` module-level flag flipped before the modal mounts. Mirrors the `coach-intro-overlay` id-guard pattern.

### ✅ ISSUE-209: `buildPlanSkeleton` missed HYROX — coach saw bare running skeleton *(P0, 2026-05-16, FIXED 2026-05-16)*

`coach-context-builder.ts:buildPlanSkeleton` branched on `eventType === 'triathlon'` only, so HYROX users fell through to the bare running branch (no swim/bike/run counts, no planned_tss, no planned_hours, no key_sessions). HYROX coach lost its full-program awareness.

**Fix**: condition broadened to `(triathlon || hyrox) && wk.triWorkouts`, matching the pattern already applied in `applyPendingChange` (ISSUE-205). Regression test `buildPlanSkeleton — HYROX uses the structured per-week shape` covers it.

### ✅ ISSUE-208: AI Coach `scaleWorkoutDescription` scaled interval rep distances *(P0, 2026-05-16, FIXED 2026-05-16)*

When a user accepted a `reduce_workout` Apply, the description scaling regex was catching interval rep distances inside patterns like `8x100m`, `4x400m`, `6×200m` — destroying the interval prescription. A 30% reduce turned `4x400m threshold` into `4x300m threshold`. The unit-test fixture used `75m` reps so it never triggered the bug; real triathlon swim sets and running track work would silently break.

**Fix**: regex now captures an optional `\d+\s*[x×]\s*` multiplier prefix; matches with a multiplier are returned unchanged. Four regression tests added covering `8x100m`, `4x400m`, `6 x 200m`, `8×200m`, plus a "still scales total volumes" guard.

### ✅ ISSUE-207: AI Coach `adjust_intensity` zoneCap was a silent no-op in running mode *(P1, 2026-05-14, FIXED 2026-05-14)*

Running adjust_intensity built a `WorkoutMod` with `zoneCap` set, but the mod-application loop at `plan-view.ts:2325` only read `mod.newRpe` — never `zoneCap`. The cap was invisible to render and to future coach context.

**Fix**: both mod-application loops in `plan-view.ts` now propagate `aiModifiedAt`, `autoReduceNote`, and `zoneCap` onto the workout. `Workout.zoneCap?: 2 | 3` added to types. Coach context emits an `ai_modifications` array so the coach can read its own past calls.

### ✅ ISSUE-206: AI Coach gate chain could lock user out on inconsistent state *(P2, 2026-05-14, FIXED 2026-05-14)*

If `coachPrioritiesSeen=true` but `coachPriorities` was absent (rare edge case from a partial state wipe), the priorities gate would skip forever and users couldn't re-enter the flow.

**Fix**: gate condition now also fires when `coachPrioritiesSeen && !coachPriorities`. The Account view's "Edit priorities" row was already a manual escape hatch.

### ✅ ISSUE-205: AI Coach silently corrupted state for HYROX users *(P0, 2026-05-14, FIXED 2026-05-14)*

`applyPendingChange` branched on `state.eventType === 'triathlon'` and fell through to the running branch for HYROX. HYROX sessions live in `wk.triWorkouts` (same schema as tri), so the running branch pushed a `WorkoutMod` to `wk.workoutMods` — the wrong array. HYROX user tapped Apply, the toast confirmed, the plan card didn't change, and a stale mod hung around polluting future render passes.

**Fix**: branch reads `(triathlon || hyrox) && triWorkouts`. Same fix in `undoPendingChange`. New `buildHyroxCoachContext` in `coach-context-builder.ts` so HYROX users get a proper context payload (was falling through to the running builder, which doesn't read `triWorkouts`). HYROX workout card now renders the "Coach" badge when `aiModifiedAt` is set. Covered by regression test `applyPendingChange — HYROX mutates triWorkouts (P0 regression)`.

### ✅ ISSUE-185: HYROX previous-race format silently mis-classified doubles as singles *(P1, 2026-05-09, FIXED 2026-05-11)*

**Confirmed by Tristan**: forecast affordance + wizard gating tested in the app.

**Root cause**: `src/ui/wizard/steps/hyrox-setup.ts:92` rendered `prevTimeFormat = state.hyroxPreviousTimeFormat ?? format`, which lit up the toggle pill matching the **target** format whenever the user hadn't picked one. Users never saw the question as unanswered. `src/state/initialization.hyrox.ts:178` then defaulted the same way, silently filing doubles splits into the Singles slot. Predictor then read those values at full singles weight, producing impossible "top 1% on 8/8 stations" radars and a 1:07:28 singles prediction off a 1:00:43 doubles race.

**Fix**:
- Wizard render no longer pre-activates a pill (`hyrox-setup.ts:92` — explicit-only).
- Wizard Continue gated on prev-format picked when prev-time entered (`hyrox-setup.ts:683`).
- Init refuses to fall back to target when prev format unknown; skips banding and benchmark seeding (`initialization.hyrox.ts:115-178`).
- New `src/state/hyrox-prev-format-fix.ts` exports `applyHyroxPrevFormatChange(format)` which slot-moves benchmarks, rewrites format on `stationBenchmarkHistory`, re-bands using cross-format factor, regenerates the plan.
- New "Previous race: {format} · {time} · Change ›" link on forecast view hero card opens the format-pick modal (`forecast-view.ts`).

### ISSUE-184: HYROX MTL — actual vs planned/CTL/ATL track different scopes *(P2, 2026-05-08)*

The MusculoTendon Load drill-down (`src/ui/mtl-load-view.ts`) surfaced a model-level inconsistency that was hidden when the metric only had one display surface.

**The mismatch**: `weeklyActualMTL` (per its type comment in `src/types/triathlon.ts`) is "Actual MTL accumulated this week from completed station/brick activities" — station + brick only. But `computeWeekMTL` in `src/calculations/mtl.ts` sums `musculoTendonLoad` across **all** `wk.triWorkouts` including runs, and `weeklyMTL` (planned) and `mtlCTL` / `mtlATL` are derived from it. So the drill-down's hero (actual = 0, station+brick scope) and its 12-week chronic / acute curve and discipline split (run included) measure different things.

**Why it became visible**: The drill-down's discipline split shows Run = 54% of chronic load. Numerically correct under the current model — running has eccentric/impact factors in `RUN_MTL_FACTORS` and accumulates more weekly minutes than stations. But that means a card titled "actual" of 0 sits next to chronic numbers that include running, which can read as a bug.

**Decision needed**: pick a single scope.

- (a) Make all four (actual, planned, chronic, acute) **all-discipline** — change `weeklyActualMTL` to include run mechanical contribution from completed runs. Most consistent with how the readiness floor `mtlAcwr` is currently used (it already factors in everything via chronic/acute).
- (b) Make all four **station + brick only** — change `computeWeekMTL` to filter on `discipline === 'station' || 'brick'`. Means the chronic/acute and the readiness floor become specifically a station-ramp signal. Run mechanical load would then need to live elsewhere (probably `legLoad`, which it already partially does).

The naming rename to "MusculoTendon Load" (this session) defers the choice — but the actual/planned divergence is still there under the hood and any future tightening of the readiness floor or the cap-enforcement logic needs to pick a scope explicitly.

**Files**: `src/types/triathlon.ts:73`, `src/calculations/mtl.ts:84`, `src/main.ts:664` (recompute block), `src/ui/mtl-load-view.ts` (the surface that exposed it).

---

### ISSUE-182: Apple Health full-parity plugin — VO2max, running power, GPS routes, FTP *(P1, 2026-05-06, code-complete pending on-device test)*

**Status**: TypeScript + Swift implementation shipped. Plugin lives at `ios-plugins/health-extras/`. Wired into `ios/App/CapApp-SPM/Package.swift`, `Info.plist`, and `appleHealthSync.ts`. Awaiting on-device verification before marking ✅ FIXED.

**Verification checklist** (Tristan, next session with iPhone + paired Apple Watch in Xcode):
1. `npx cap sync ios` — refreshes Capacitor's SPM resolution to pick up the new `MosaicHealthExtras` package.
2. Open `ios/App/App.xcworkspace` (or `.xcodeproj`) in Xcode; build for a real device (HealthKit data is not available on simulator).
3. Onboarding → Apple Health connect — confirm the combined permission dialog lists the new types (VO2max, running power, GPS routes, etc.).
4. Wizard review step — confirm 16w backfill runs, polyline-derived best-efforts auto-fill the PB rows.
5. Stats view — confirm VO2max shows real device value (no "(est.)" label), trend chart renders.
6. Activity detail on a recent outdoor run — confirm route map renders, km splits chart renders, source badge says "Apple Health".
7. If `runningPower` data is present in Health app, confirm `averageWatts`/`maxWatts` flow through to the row.
8. Triathlon mode FTP — if user has cycling FTP in Health app, confirm `s.onboarding.triBike.ftp` auto-populates.

**Known soft risks** (compile-untested Swift):
- `HKWorkoutRouteQuery` streaming pattern — verify the accumulator resolves only on `done==true` (a missed `done` would leave the promise pending).
- ISO8601 date parsing — Apple's HK dates can be either `withFractionalSeconds` or not; the parser tries both formats.
- iOS-17 type identifiers (`cyclingPower`, `cyclingFunctionalThresholdPower`, `cyclingCadence`, `cyclingSpeed`) — verify they compile on iOS 17 SDK; silently drop on iOS 16 via `#available`.

**Goal**: Apple-only iOS users (no Strava, no Garmin) reach Garmin-tier feature parity. Today they're missing several HealthKit fields the current plugin (`@capgo/capacitor-health` v8.2.16) doesn't expose.

**HealthKit fields capgo doesn't expose** that we want:
- **VO2max** — `HKQuantityTypeIdentifierVO2Max` (iOS 11+). Apple Watch updates this from outdoor GPS runs. Without it we fall back to HR-calibrated/PB-derived VDOT (already wired) and label "(est.)". With it, the number matches what the user sees in their Health app.
- **Running power** — `HKQuantityTypeIdentifierRunningPower` (iOS 16+). Native running power, no Stryd needed.
- **Cycling power** — `HKQuantityTypeIdentifierCyclingPower` (iOS 17+). For triathletes with paired power meters.
- **Cycling FTP** — `HKQuantityTypeIdentifierCyclingFunctionalThresholdPower` (iOS 17+). Apple's auto-derived FTP.
- **HKWorkoutRoute** — GPS polyline per workout. Enables route maps + per-km splits + PB extraction (compute fastest 5K/10K/HM segments from the location stream → mirror Strava `best_efforts`).
- **Running form** (iOS 16+): `runningStrideLength`, `runningGroundContactTime`, `runningVerticalOscillation`, `runningSpeed` (computes pace from this), step count → cadence.
- **Wrist temperature** — `HKQuantityTypeIdentifierAppleSleepingWristTemperature` (iOS 16+, Series 8/Ultra). Recovery / illness / ovulation signal.
- **Walking HR average** — `HKQuantityTypeIdentifierWalkingHeartRateAverage`. Slow fitness-trend proxy.

**Recommended path: Hybrid.** Keep `@capgo/capacitor-health` for what it does well (sleep stages, HRV, RHR, HR streams, basic workouts, daily aggregates) — re-implementing those is pure waste. Add a small custom plugin in `ios/App/App/plugins/` that exposes only the gaps.

**Why not switch to `@perfood/capacitor-healthkit`**: would mean re-validating every existing physiology code path. Hybrid keeps the working part working.

**Why not fork capgo**: capgo's enum-based API can't extend cleanly to dynamic identifiers; their architecture would need restructuring.

**Plugin scaffold** (under `ios/App/App/plugins/MosaicHealthExtras/`):
- `MosaicHealthExtrasPlugin.swift` — register methods (~50 lines)
- `MosaicHealthExtras.swift` — HK queries (~250-300 lines)
- TS bridge: `src/data/healthExtras.ts` (~80 lines, `registerPlugin` + thin wrappers)
- Methods: `requestPermissions(types)`, `readVO2Max(start, end)`, `readWorkoutRoute(uuid)` (CLLocation array → polyline encoder), `readWorkoutPowerSamples(uuid, type)`, `readCyclingFTP()`, `readWristTemperature(start, end)`, `readRunningFormMetrics(uuid)`.

**Integration into `appleHealthSync.ts`**:
1. After HR enrichment per workout, also query VO2 / running power / form metrics in the same window.
2. After workout sync, fetch `HKWorkoutRoute` per running workout → polyline (use Strava's polyline encoder or store raw lat/lon array).
3. Compute fastest 5K/10K/HM/marathon segments from the polyline → synthesize `best_efforts` shape on the row → existing `readPBsFromHistory` works unchanged.
4. Standalone VO2 sync writes `s.vo2` directly; UI drops the "(est.)" label when `vo2Source === 'apple-device'`.
5. Latest cycling FTP → `s.onboarding.triBike.ftp` for triathletes.

**iOS deployment target**: bump to iOS 16 minimum. Series 8 (Sept 2022) and iPhone 8 (Apple's iOS 16 cutoff) cover >95% of likely Apple Watch users in 2026. iOS 17+ fields gated by `#available(iOS 17, *)` checks.

**Estimated effort**: 1-2 focused days.
- Plugin scaffold + Swift queries: 4-6h
- TS bindings + integration into appleHealthSync.ts: 2-3h
- On-device testing (Xcode + real iPhone with paired Apple Watch): 2-4h
- Doc updates (CHANGELOG, FEATURES, this issue marked fixed): 1h

**Open questions for execution session**:
1. Does `HKWorkoutRoute` need a separate read permission beyond the workout permission? (Likely yes — `HKSeriesType.workoutRoute()`.)
2. For running power: is it on the workout's metadata or queried by time-window like HR? (Should be sample-based, query by workout start/end.)
3. Apple's VO2max sample frequency — per-workout, daily, or weekly? Need to know to pick the right query window.
4. Polyline storage: encode via the same algorithm Strava uses, or store raw lat/lon array on the row?

**Already shipped (2026-05-06) — foundation**:
- 16-week activity backfill with HR-stream enrichment.
- Per-workout iTRIMP + zones + observed maxHR (from HR streams across all hard workouts).
- Weekly aggregation → `historicWeeklyTSS`, `ctlBaseline`, `detectedWeeklyKm`, `athleteTier`.
- Onboarding: Apple Health button always visible (graceful "iOS app only" disabled state on web).
- `stravaHistoryFetched` gates extended to also accept `appleHistoryFetched`.

This issue completes the parity story.

---

### ✅ ISSUE-178: Triathlon forecast UI — multiple display inconsistencies *(P1, 2026-05-06)* — **FIXED 2026-05-06**

**Resolved symptoms**:
1. ~~LT 4:23 vs 4:08 across surfaces~~ → `race-forecast-card.ts` now anchors current LT to canonical `s.lt` and propagates the VDOT-projected delta. Both surfaces show the same number for "today".
2. **VDOT vs VO2max** disconnect — *Not fixed in this pass*. Tracked separately as ISSUE-180 (cross-source validation needed; basic selection UI already exists per Tristan 2026-05-06).
3. **Course-factor `+` labels** — *Partial fix*. The labels themselves weren't relabelled, but the underlying gates were corrected (item 5) so negative deltas now surface — making the sign convention clearer in practice. Pure label clarity ("Climate adds X to your run leg") deferred.
4. ~~Bike modal 5:24 vs headline 6:44~~ → `bike-setup-view.ts` modal now labelled "Bike split (no conditions)" with subtext "race-day adds climate & wind". Modal preserves tuning-playground function as a clean baseline.
5. **Bonus**: `course-factors.ts` + `course-factors-running.ts` had `if (factor > 1.0)` gates silently dropping sub-1.0 values (sheltered wind, ocean-current-assist swim). Changed to `!== 1.0` so legitimate negative course factors surface as faster-on-race-day deltas.
6. **Bonus**: `bike-setup-view.ts` showed "Mean gradient 0.5%" for rolling courses. Changed to "≈900m climbing" when race-specific elevation data is available — cyclists quote elevation gain, not mean gradient.

See CHANGELOG 2026-05-06 "Triathlon forecast UI cleanup" for full detail.

### ✅ ISSUE-179: Swim-specificity penalty for low recent swim engagement *(P2, 2026-05-06)* — **RESOLVED 2026-05-06**

Subsumed by the unified per-discipline race-readiness framework. The new `specificEndurancePenalty` covers swim alongside bike and run — when recent swim volume is low (`recentHoursByDiscipline(state, 8)['swim']`) and longest swim session is below the race-distance target, the swim leg's `current` prediction is penalised by up to 15% (IM) / 10% (70.3) / 5% (Olympic) / 3% (Sprint).

The originally-proposed swim-specificity penalty would have only addressed swim. The unified framework handles all three disciplines with the same architecture, plus surfaces per-discipline scores via the new Race Readiness panel. See CHANGELOG 2026-05-06 "Race-readiness penalty + per-discipline UI surface (triathlon)" for the full picture.

**Outstanding scope from this issue**: PB-recency for swim is NOT yet implemented (run-only in v1). Could extend later — recent open-water race / TT could reduce the swim penalty the same way recent marathon PB reduces the run penalty. Tracked as a sub-item; bike/swim PB recency is mentioned in the new SCIENCE_LOG entry as "deferred to v2".

### ISSUE-180: VO2max source selection + validation *(P2, 2026-05-06)*

**Problem**: VO2max comes from multiple sources (Garmin direct, Apple Health GPS-run estimate, Polar Running Index, manual entry, PB-derived VDOT). Currently the system picks one but doesn't explain choice, doesn't cross-validate against other signals (e.g., PB-derived VDOT), and doesn't detect stale device readings (Apple's VO2max only updates on outdoor GPS runs — could be 6+ months stale).

**Status**: Tristan confirmed (2026-05-06) the user-facing VO2max selection control already exists in stats. The architectural improvements (cross-source validation, stale detection, conflict surfacing) are the open work — not the basic selection UI.

**Reference**: `docs/WEARABLE.md` for source-by-source VO2max specifics (lines 12, 74, 105, 116, 232, 289, 332, 433).

### ✅ ISSUE-181: Injury system mode-blind — triathlon has no injury UI or plan modification *(P1, 2026-05-05)*

The running injury system (`applyAdvancedInjuryLogic`, `openInjuryModal`, injury banner, morning pain check) was entirely absent from the triathlon plan view. Triathletes with a lower-body injury saw unmodified run workouts — no UI to report the injury, no plan changes, no discipline-aware guidance on what was still safe to do.

**Fix**: Added full discipline-aware injury support to triathlon plan view:
- `getDisciplineStatusForInjury(location)`: maps injury location to per-discipline status (`ok` / `easy` / `stop`). Foot/knee/calf/hamstring/hip: run=stop, bike=easy, swim=ok. Back: all=easy. Other: run=easy, bike/swim=ok.
- `buildTriInjuryBanner(inj)`: shows discipline table (Continue normally / Low intensity only / Paused), pain level, phase, Update/Recovered buttons.
- `buildTriMorningPainCheck(inj)`: one-per-day Worse/Same/Better card. Persists via `recordMorningPain` + `lastMorningPainDate`.
- Header: "In Recovery" pill replaces "Check-in" button when injury is active.
- Workout rendering: stopped-discipline workouts render as greyed-out "Paused" cards (non-draggable, non-tappable). Easy-discipline workouts get an amber "Easy intensity only" note via `renderTriWorkoutCard`'s new `injuryEasy` opt.
- Brick workouts: use the more restrictive of bike/run status.
**Files**: `src/ui/triathlon/plan-view.ts`, `src/ui/triathlon/workout-card.ts`.

---

### ISSUE-177: Per-rep interval analysis — verify on real interval sessions *(P1, 2026-05-06)*

**Status**: Built and tested in unit suite (`rep-detection.test.ts` 12 ✓, `rep-adherence.test.ts` 22 ✓, full suite 1413/1413). Edge function changes + DB migration NOT yet deployed. End-to-end behaviour unverified on real Strava data.

**What ships**: per-rep table, fade %, in-band marker, and a one-line execution commentary on the activity-detail page for any structured interval session (run + bike). Per-rep adherence drives the running effort blend (`events.ts`) and the bike effort multiplier (`effort-multiplier.triathlon.ts`) so progression next week reflects rep-level execution, not whole-session averages.

**Pre-test deploy steps**:
1. Apply migration `supabase/migrations/20260505_rep_data.sql` (`supabase db push` or via dashboard).
2. Deploy edge function: `supabase functions deploy sync-strava-activities`.
3. Sync. New interval sessions detect on first sync; up to 8 historic sessions backfill per sync via the `REP_HEAL_BUDGET` heal pass.

**Verification checklist**:
1. **Run — track session with user-pressed laps** (e.g. 8×400m). After sync, open activity detail. Expect: "Reps" block with source "Strava laps", 8 rows showing distance/pace/HR/in-band marker, fade %, commentary like "8/8 reps in target band, no fade — strong execution".
2. **Run — track session without lap presses** (just GPS). Expect rep block sourced "Auto-detected" if alternating fast/slow segments cleanly visible. Confidence is lower; some misses are OK.
3. **Bike — 5×5min @ FTP with power meter**. Expect rep block detecting 5 reps from the watts stream, source "Auto-detected" (bike skips laps since auto-1km is the default). Watts and HR per rep, fade % flips sign so power drop = positive.
4. **Bike — auto-1km easy ride** (uniform laps, no power surges). Expect NO rep block (CoV gate rejects uniform laps; baseline-power gate rejects flat rides).
5. **Easy run with one fast km**. Expect NO rep block (σ-gap gate rejects single outlier).
6. **Effort multiplier reactivity**: complete an interval workout that the rep scorer rates as undercooked (slower than target). Next week's prescription for that discipline should shrink (multiplier < 1.0). Conversely, on-target reps should hold or slightly grow next week.
7. **Console logs**: `[Standalone:reps] strava-XXX: detected N reps (source)` on first sync; `[Standalone:rep-heal] strava-XXX: backfilled N reps` on heal pass.

**Known limitations to expect** (not bugs):
- 30/30s micros may not split cleanly because the bike-stream 10s smoothing window blurs short transitions.
- Fartlek and progression sessions miss the σ-gap heuristic — no rep block surfaces. Acceptable.
- Backfill mode (16-week one-shot history) doesn't run detection. Historic intervals trickle in via heal cap (8/sync).
- Swim is out of scope for v1.

**Tunable thresholds** if false positives/negatives show up:
- `REP_PACE_GAP_SIGMA = 1.0` in `rep-detection.ts` — raise to be stricter (fewer false positives), lower to be more sensitive.
- `REP_UNIFORM_DIST_COV = 0.08` — uniform-lap rejection threshold.
- `RUN_PACE_BAND = 0.05` (±5%) and `BIKE_ADHERENCE_BAND` per session type — in-band tolerance for per-rep scoring.

**Files**: `supabase/migrations/20260505_rep_data.sql`, `src/calculations/rep-detection.ts`, `src/calculations/rep-adherence.ts`, `src/calculations/{rep-detection,rep-adherence}.test.ts`, `src/types/state.ts`, `supabase/functions/sync-strava-activities/index.ts`, `src/calculations/activity-matcher.ts`, `src/data/stravaSync.ts`, `src/calculations/effort-multiplier.triathlon.ts`, `src/ui/events.ts`, `src/ui/activity-detail.ts`. See CHANGELOG 2026-05-06 + SCIENCE_LOG "Per-rep interval analysis" for the full rationale.

---

### ✅ ISSUE-151: Triathlon mode shows the running suggestion modal for cross-training overload *(P2, 2026-04-30)* — **confirmed in-app 2026-05-01**

**Status**: v1 shipped 2026-04-30, **v2 shipped 2026-05-01** (see CHANGELOG). Per CLAUDE.md issue-tracking workflow, do not mark `✅ FIXED` until Tristan has confirmed in-app on a real Ironman setup.

**v2 verification checklist**:
1. Sync (or manually log) ~80–90 min tennis. Expect the tri modal with severity badge, discipline chips defaulting to **run** (tennis = leg-impact), Reduce / Replace & Reduce / Keep / Push-to-next-week buttons.
2. Flip chips between run / bike / swim — proposed mod list re-renders. Below-floor disciplines de-emphasised but still clickable; modal warns before commit.
3. Click *Reduce* → mods apply to `wk.triWorkouts`, modal closes.
4. Repeat with ~90 min cycling → recommendation should default to **bike** (cycling = bike-affinity), not run.
5. Repeat with ~120 min swim → recommendation should default to **swim**.
6. Click *Push to next week* → `wk.carriedCrossTrainingTSS` increments, modal closes. Next week's home view shows "X TSS carried over from cross-training" banner; banner shrinks day-by-day, disappears after ~3 weeks.
7. Plan-vs-extra: a planned `cross` or `gym` session in `wk.triWorkouts` (with `discipline` undefined) should NOT trigger the detector.

**v1 changes** (still valid, see ARCHITECTURE.md → Cross-Training Engine for the full mode-routing map):
- New detector `src/calculations/tri-cross-training-overload.ts` (rewritten in v2 — multi-mod, per-discipline, run-anchored).
- Mode-aware modal routing at activity-review, events.ts, main-view ACWR, excess-load-card defensive guard. `gps/recording-handler.ts:196` deliberately untouched (run-only).
- Aggregator wired with `cross_training_overload` source (v2 carries `overloadOptions` payload).

**Update 2026-05-01 — home readiness CTA wired through (separate session)**: The home readiness card's "Adjust plan" button was a silent no-op in tri mode (it called `triggerACWRReduction` which early-returns for tri). Fixed: tri-mode click handler routes into `collectTriSuggestions` + `showTriSuggestionModal`; show-gate flipped to key off `bundle.mods.length > 0` so the button is hidden when no mod is actionable; CTA label switches to "Reduce session load" when the dominant mod is `cross_training_overload` or `readiness`. Drop handlers in `src/ui/triathlon/plan-view.ts` also surface the modal when a workout is dragged onto today (`maybeOpenSuggestionsAfterDrop`). See CHANGELOG 2026-05-01.

**Update 2026-05-01 — home readiness composite fixed (confirmed in-app)**: `buildReadinessRing` now branches on `isTri`: calls `computeTriReadiness(s)`, uses worst-discipline `ReadinessResult` for score/label/colour/drivingSignal, and replaces the daily-coach sentence with `triReadinessResult.sentence`. Running-ACWR "Load spike" copy no longer appears in tri mode. Confirmed proportional and correct by Tristan on 2026-05-01.

✅ FIXED — all sub-items resolved. Move to resolved section on next triage.

---

## Persona QA + Mode Audit Findings — 2026-05-05

> Source: `/persona-qa all` + `/mode-audit all` run across 25 personas and 5 modes.
> P0 = crash/blank · P1 = wrong data/broken logic · P2 = confusing UX · P3 = copy/polish

---

### ✅ ISSUE-156: Hyrox — plan view shows running plan structure *(P0, 2026-05-05)*

`src/ui/plan-view.ts:3183` — `renderPlanView` routes `eventType === 'triathlon'` to the tri plan view but has no Hyrox branch. Hyrox athletes see the running plan view, which has no concept of stations, bricks, or MTL. Workout cards, skip handlers, and session types are all wrong.
**Fix**: replaced all direct `renderPlanView()` navigation calls across 15 files with `renderMainView()` which already has the correct mode-aware routing (triathlon → tri plan, hyrox → hyrox plan, else → running plan). All `navigateTab` functions and post-action CTAs updated. Also fixed the `tab === 'plan'` routing in all triathlon sub-views.

---

### ✅ ISSUE-157: Hyrox — forecast tab shows blank screen *(P0, 2026-05-05)*

`src/ui/triathlon/forecast-view.ts:54` — `renderTriathlonForecastView` checks `if (!tri) return` early. Hyrox athletes have no `s.triConfig`, so the tab renders blank with no error or empty state.
**Fix**: removed the Forecast tab from Hyrox's tab bar (`tab-bar.ts:29` — `isTriathlon` now only `=== 'triathlon'`, not `=== 'hyrox'`). Hyrox has no race predictor yet; showing the tab was misleading. Also fixed the `renderPlanView` call inside forecast-view.ts navigateTab.

---

### ✅ ISSUE-158: Just-track — week debrief fires with no plan *(P0, 2026-05-05)*

`src/ui/week-debrief.ts:122` — `shouldAutoDebrief()` does not check `s.trackOnly`. On week rollover, a just-track user gets a week debrief modal with plan-derived metrics (CTL, adherence, debrief copy) even though they have no plan. Confusing and misleading.
**Fix**: added `if (s.trackOnly) return false;` at the top of `shouldAutoDebrief()`, and added `&& !s.trackOnly` guard to the `pendingDebrief` path in `fireDebriefIfReady`. The end-of-plan path already had this guard.

---

### ✅ ISSUE-159: Hyrox — week debrief shows running metrics *(P1, 2026-05-05)*

`src/ui/week-debrief.ts:122` guard is `s.eventType !== 'triathlon' && !s.trackOnly` — Hyrox passes this and receives the running week debrief.
**Fix**: Added `if (s.eventType === 'hyrox') return false` to `shouldAutoDebrief()`, `if (s.eventType === 'hyrox') return` early in `fireDebriefIfReady()`, and `&& s.eventType !== 'hyrox'` to the end-of-plan guard at line 123. Suppresses the running debrief entirely for Hyrox; a Hyrox-specific debrief remains a future build.

---

### ✅ ISSUE-160: Hyrox — holiday modal pre-shift silently fails *(P1, 2026-05-05)*

`src/ui/holiday-modal.ts:438-493` — `computePreHolidayShifts` calls `generateWorkoutsForWeek` which produces running workout objects whose IDs never match any Hyrox session. Shifts silently fail.
**Fix**: Added a Hyrox branch at the top of `computePreHolidayShifts` that reads `wk.triWorkouts` directly instead of re-generating running workouts. Same shift algorithm (shiftable types extended to include `station`, `mtl`). Also updated "Running on holiday" / "Are you planning on running?" copy to "Training on holiday" / "Are you planning on training?" for mode-neutrality. File: `src/ui/holiday-modal.ts`.

---

### ✅ ISSUE-161: Readiness commentary tone contradicts ring score *(P1, 2026-05-05)*

`src/calculations/tri-readiness.ts:127` — the sentence "Load has jumped from cross-training. Ease back across all sessions this week." fires when `overall === 'Overreaching'` for a single discipline, but the ring score (computed by the systemic `computeReadiness`) can show "On Track" (57-59) because systemic HRV/sleep/TSB is fine. The ring says you're OK; the commentary says ease back. Directly contradictory.
**Root cause**: two separate models — systemic (`computeReadiness`) and per-discipline (`computeTriReadiness`) — disagree and are displayed together without reconciliation.
**Fix (Option A)**: when the systemic ring is "On Track" or "Primed", downgrade commentary to informational tone ("Cross-training has added bike load above baseline — watch volume on bike sessions this week") rather than alarm tone ("Ease back across all sessions"). Reserve alarm copy for when the ring itself reflects concern. Apply same principle to running-mode readiness sentences.

---

### ✅ ISSUE-162: Readiness score shows different values on home vs detail view *(P1, 2026-05-05)*

Home view shows 60, readiness detail view shows 59 — same metric, same session, two different numbers. Violates the canonical-computation rule in CLAUDE.md.
**Root cause**: two divergences in how `computeReadiness` is called:
1. **Sleep score**: readiness view falls back to most recent historical sleep when today's hasn't synced; home view uses today-only and passes `null` if absent. One input differs → score differs by 1.
2. **Metrics week index**: readiness view passes `completedWeek = s.w - 1`; home view passes `s.w`. Can shift CTL/TSB inputs.
**Fix**: extract a canonical `buildReadinessInputs(s)` helper that both views call. Use the readiness view's sleep fallback (historical fallback is correct — morning before sync, yesterday's sleep is better than null). Same `completedWeek = Math.max(0, s.w - 1)` in both.

---

### ✅ ISSUE-163: Underachiever effort multiplier inverts — plan gets harder when you do less *(P1, 2026-05-05)*

When a user consistently runs 30% shorter than planned with RPE 2-3 (easier than expected), the blended effort signal flips sign. `effortMultiplier` returns > 1.0 (clamped [0.85, 1.15]), making the following week longer. The plan escalates for someone chronically under-delivering.
**Fix**: In `triTrailingEffortScore` (`effort-multiplier.triathlon.ts`), added an under-duration guard: if actual duration < 80% of planned, the workout's deviation is clamped to max 0. This prevents low-RPE short sessions from driving plan inflation — the session was cut short, not genuinely easy.

---

### ✅ ISSUE-164: Skip pattern invisible to plan engine and coach *(P1, 2026-05-05)*

Chronic skipping (40%+ of workouts over 6+ weeks) produces no coaching signal and no plan re-fit.
**Fix**: Added `buildConsecutiveSkipNote(s, viewWeek)` in `plan-view.ts`. Detects 2+ consecutive completed weeks where `wk.skip.length > 0` (workouts pushed). Surfaces a plain white card above the workout list: "Sessions sliding for N weeks. Workouts pushed to next week will drop on a second skip and affect your race prediction. Consider reducing this week's volume instead."

---

### ✅ ISSUE-165: Mid-plan injury — run CTL/VDOT don't decay during run layoff *(P1, 2026-05-05)*

When a user reports a running injury and stops running, VDOT remains at its pre-injury value. Root cause: `refreshBlendedFitness` (called on every launch) overwrites `s.v` with the PB/HR blend — which uses pre-injury race times — undoing `advanceWeekToToday`'s weekly decay.
**Fix**: Added an `injuryBlockingRun` guard in `blended-fitness.ts` at the `s.v = s.blendedEffectiveVdot` write. When `injuryState.active && injuryState.canRun === 'no'` (acute/rehab phases), the blend does not overwrite `s.v`. `advanceWeekToToday`'s weekly decay (1.2%/week from Coyle 1985) now accumulates unimpeded. Once `canRun` returns to `'limited'` or `'yes'` (return-to-run phase), the blend resumes writing normally so post-injury fitness is re-calibrated from actual runs. File: `src/calculations/blended-fitness.ts`.

---

### ✅ ISSUE-166: Wrong benchmarks — unreachable targets never flagged *(P1, 2026-05-05)*

If a user sets FTP far too high, the plan generates unexecutable watt targets. After multiple weeks of high RPE (9-10), no coaching signal fires.
**Fix**: Added `detectConsecutiveHighRpeBike()` and `maybePromptHighRpeBike()` in `src/ui/triathlon/plan-view.ts`. Detects 3+ consecutive completed weeks where all rated bike workouts had RPE ≥ 8. Shows a UX-compliant modal (no auto-correction): "Bike sessions consistently at high effort. Targets may be set too high relative to your current FTP." Two CTAs: "Review FTP" (opens benchmark overlay) and "Got it" (dismiss). Fires once per week via `triConfig.notifiedMarkers.highRpeBikeWeek`.

---

### ✅ ISSUE-167: Stale VDOT/LT/VO2 not cleared on mode switch *(P1, 2026-05-05)*

Carrying over running VDOT to triathlon run-leg pacing is intentional — it's the best available fitness signal for the run discipline when switching. The guard `if (!s.v && pastRaceBench.vdot)` correctly only seeds when empty, not overwriting an existing value. No action needed; documented here as intentional design.

---

### ✅ ISSUE-168: Post-race banner not shown for triathlon or hyrox *(P2, 2026-05-05)*

`buildRaceCompleteBanner` (home-view.ts:560) only checked running race date fields.
**Fix**: extended `raceDate` lookup to also read `triConfig?.raceDate` and `hyroxConfig?.raceDate`. Hyrox race name shows "Your HYROX" instead of generic "Your race".

---

### ✅ ISSUE-169: Illness modal "Still running" copy ambiguous for triathlete *(P2, 2026-05-05)*

`src/ui/illness-modal.ts` — button copy "Still running" and description "Easy and long runs reduced" are running-specific. For a triathlete managing illness, "Still running" is ambiguous (all three disciplines? just run?) and there's no tri-specific option like "Keep swim/bike, rest running."
**Fix**: branched modal copy on `isMultiSport()`. Tri/cycling/hyrox: button reads "Still training", description uses sport-agnostic "Quality sessions converted to easy effort at 50% volume. Low-intensity sessions reduced to 60%." Full-rest description updated to "All sessions replaced with rest."

---

### ✅ ISSUE-170: Cycling wizard — isCyclingOnlyMode not confirmed before first plan render *(P2, 2026-05-05)*

Verified not a real issue: `isCyclingOnlyMode` checks `onboarding.trainingMode === 'cycling'` first (set at the goals step, long before plan view renders), so the guard resolves correctly even before `triConfig.disciplines` is written by `initializeCyclingSimulator`. No code change needed.

---

### ISSUE-171: Non-tech user faces jargon wall on first use *(P2, 2026-05-05)*

CTL, ACWR, VDOT, TSS, ATL, TSB all surface in home view, readiness view, and coach view without plain-language translation. A user who doesn't know these terms has no way to interpret them. The "what do I do today" answer is buried under unfamiliar metrics.
**Fix**: add a plain-language label alongside or below each metric on first exposure: "CTL 42 — your current fitness base", "ACWR 1.12 — load is ramping faster than usual", etc. Could be a tooltip, a subtitle, or a one-time coach note. Discuss format with Tristan before building.

---

### ✅ ISSUE-172: General fitness mode — race forecast card may appear with no race *(P2, 2026-05-05)*

Verified: `buildRaceForecastCard` already gates on `s.continuousMode` (returns '' for general fitness), `!s.rd` (no race distance), and `!s.initialBaseline` (no goal time). All three guards correctly suppress the card in non-race scenarios. No code change needed.

---

### ✅ ISSUE-173: benchmark-overlay Save/Skip CTAs navigate to plan view unconditionally *(P2, 2026-05-05)*

Verified already fixed: both CTAs call `renderMainView()` (via dynamic import) which routes mode-correctly to the appropriate plan view (tri, hyrox, or running). The overlay is only opened from plan-surface buttons, so `renderMainView()` always returns to the correct opener. No code change needed.

---

### ✅ ISSUE-174: Mode-audit — accent colour on navigation links *(P2, 2026-05-05)*

Checked all four reported instances. All were already using `var(--c-muted)` — the violations were resolved in a prior session. Verified: "Sync", "Edit", "Log sleep →" buttons all use muted colour, not accent.

---

### ✅ ISSUE-175: Mode-audit — hardcoded units in guided overlay *(P2, 2026-05-05)*

Checked `src/ui/guided-overlay.ts:40-41`. The code already correctly handles both units: `pref === 'mi' ? ... mi : ... km`. No hardcoded violation exists. Resolved in a prior session.

---

### 🔄 ISSUE-177: Plan card mixes planned-sport and actual-sport when day-proximity fallback matches across sports *(P2, 2026-05-06)* — **fix pending on-device confirmation**

**Symptom**: Card showed CROSS badge → "Tennis" heading → "60min wakeboarding" description → "Tennis · Strava · 2.9 km · …" sub-line. Heading is the actual sport (Strava `displayName`), description is the planned sport (`w.d`), sub-line repeats the actual sport. Reads as broken even though the load attribution is correct.

**Root cause**: In `src/ui/activity-review.ts:1488-1503`, when no sport-name match exists, cross-training activities fall through to a closest-cross-slot-by-day picker. A tennis session can land in a wakeboarding slot. The renderer in `plan-view.ts` then pulls heading from one source (actual sport) and description from another (planned sport) without reconciling them.

**Fix (2026-05-06)**: `src/ui/plan-view.ts` — added `isSportSwap` flag (cross/gym slot + activity `displayName !== w.n`); replaced the planned description with a `Planned: <slot name>` caption when set; dropped the activity-name prefix in `actMatchRow` whenever it duplicates the heading. Matcher behaviour unchanged — load attribution stays.

**Verification**: needs on-device check after next Strava sync that produces a cross-sport swap (tennis in wakeboarding slot, etc.). Marker stays 🔄 until Tristan confirms.

---

### ✅ ISSUE-176: Mode-audit — em dashes in user-facing copy (10+ instances) *(P3, 2026-05-05)*

Fixed prose em dashes in user-facing copy across:
- `main-view.ts`: "Cross-training covering fitness load. Consider a short run for conditioning." and "Viewing. Return to current week."
- `welcome-back.ts`: 7 prose em dashes rewritten with periods/commas
- `stats-view.ts`: CTL/ATL/TSB/ACWR/momentum tooltip definitions rewritten
- `activity-detail.ts`: FTP estimate sentences split with periods
- `src/ui/home-view.ts:1943` — "Next: ${label} — ${next.n}"
- `src/ui/coach-view.ts:175` — "ACWR ${n} — acute load spike."
- `src/ui/account-view.ts:1635` — "Session expired — please sign in again"
**Fix**: rewrite as period, comma, or colon per copy rules. Audit all files for remaining instances.

---

### ISSUE-152: Triathlon — real-world dogfooding before next feature push *(P1, 2026-04-30)*

**Context**: Across the last few sessions we've shipped a substantial body of triathlon work — race prediction (Phases 1, 2A, 2B), course-aware scoring, durability cap, suggestion modal, sync-time activity matching, per-session HR effort scoring (bike + swim), `triEffortMultiplier` auto-progression, race-outcome logging, marker-bump toasts, and the end-of-week debrief modal. 1234 tests pass. **None of it has been validated against real-world activity data over multiple weeks.**

**Why this is a P1**: Tristan is doing an actual 24-week IM build. The next high-leverage move isn't another feature — it's noticing what's wrong, missing, or annoying when the system runs against real activity, real RPE ratings, real marker bumps. We've built faster than we've validated.

**What "doing this" looks like**:
1. Use the app daily for 1–2 weeks of actual training.
2. Each time something feels off (prediction stale, multiplier didn't apply, marker bump didn't surface, debrief modal said something weird, a session's RPE didn't propagate), dump it in `.claude/TL thoughts`.
3. Next session: triage TL thoughts into discrete issues, fix the top 5.

**Concrete things to watch for**:
- Marker-bump toast actually fires on a real CSS / FTP / VDOT improvement
- Effort multiplier visibly changes session durations after 2 consecutive easy-rated weeks
- End-of-week debrief fires on Monday morning with sensible content
- Suggestion modal fires when expected (volume-ramp, RPE-blown, readiness)
- Race-day handling once the user actually races

**No code change required.** This is a process item — once we have field data, we'll know what's worth building.

---

### ✅ ISSUE-153: Triathlon — completed-efforts tracking page (mirror running's pattern) *(P2, fixed 2026-05-11)*

Added `buildCompletedEfforts(wk, s)` and `openCompletedEffortDetail(id, wk, s)` to `src/ui/triathlon/plan-view.ts`. When you navigate to a past week on the tri Plan tab, a "Completed" card appears below the week navigation pills listing every `triWorkout` with `status='completed'`. Each row shows discipline badge, workout name, day + actual duration, and a signal label (On target / Above target / Hard effort / Off pace etc.) derived from `powerAdherence` (bike), `paceAdherence` (swim), or `hrEffortScore` (run). Tapping a row opens a vertically-centred modal showing planned vs actual duration, distance, avg HR, RPE rated, and a plain-language signal note. 1726/1726 tests pass, typecheck clean.

---

### ISSUE-154: Triathlon — manual brick tagging *(P3, 2026-04-30)*

**Context**: Brick auto-detection (`detectBricks` in `src/calculations/brick-detector.ts`) pairs a bike followed by a run within 30 minutes. Some users record bike + run as a *single* Strava activity (sport: brick or multi-sport) — auto-detection misses these.

**Fix**: Let the user manually tag two activities as a brick pair from the activity-detail modal. Store linkage on `garminActuals.brickPairId` (UUID generated on tag); `runTriActivityMatching` checks `brickPairId` first, falls through to auto-detection.

**Files involved**:
- `src/types/state.ts`: add `GarminActual.brickPairId?: string` (optional per iOS-ship rule)
- `src/ui/activity-detail.ts`: add "Tag as brick" action + picker for partner activity
- `src/main.ts → runTriActivityMatching`: read `brickPairId` before falling through to `detectBricks`

**Estimated**: ~1–2 hours.

---

### ✅ ISSUE-156: `sync-strava-activities` skipped watts streams when `device_watts !== true` *(P1, 2026-05-01)* — **confirmed in-app 2026-05-01**

**Fix summary**: removed the `device_watts !== true` filter at `supabase/functions/sync-strava-activities/index.ts:1252`, replaced with an NP-threshold check (`avg/NP >= 120 W`). Client-side FTP estimator at `src/calculations/tri-benchmarks-from-history.ts` got the same treatment (drop the gate, downgrade confidence one tier when flag isn't `=== true`). Deployed at v78 (2026-05-02 08:01:16). After deploy + cold launch + auto-backfill, the curve path landed FTP correctly. User confirmed ("whatever has worked now works as its back").



**Context**: The edge function step 5e fetches mean-max power curves only for rides flagged `device_watts=true` in the Strava DB rows. Strava's flag is structurally unreliable on Garmin → Strava transfers — Tristan's account has 60 of 63 recent rides flagged `device_watts: false` despite all of them being captured on a real power meter. So the curve fetch never fires for those rides, `garmin_activities.power_curve` stays null, and the client-side FTP estimator drops to whole-ride NP × 1.0 (which collapses on interval workouts because recovery sections drag NP down).

**Confirmed via diagnostic** (2026-05-01): the user's 2026-04-27 hard ride (114 min, two 20-min intervals at 310 W) has the *correct* answer of FTP=295 W from the curve, but the DB row stores only `average_watts=193`, `normalized_power=null`, `power_curve=null`. The estimator picks 193 W because that's the only signal in the row. The 295 W is recoverable via watts-stream → mean-max → ×0.95 only.

**Code change (deployed: NO, pushed locally only)**:

- Removed the `device_watts !== true` filter at `supabase/functions/sync-strava-activities/index.ts:1252`.
- Added an NP-threshold check (`avg/NP >= 120 W`) — strong enough to filter out commuter rides where Strava is genuinely estimating power from speed alone, but accepts real-meter rides whose flag Strava mislabeled.
- Kept the 15-stream-per-sync budget and the NP-DESC ranking.

**Deploy steps**:

1. `supabase functions deploy sync-strava-activities --project-ref elnuiudfndsvtbfisaje`
2. Wait for any active Strava 429 rate-limit window to clear.
3. Trigger a manual backfill from the app (or wait for next launch — Mosaic auto-backfills on startup when conditions met).
4. Reload review page; FTP should land at ~295 W with `confidence: 'high'` (the curve path).
5. Mark ISSUE-156 ✅ FIXED in this file once the user confirms the 295 W lands.

---

### ISSUE-155: Triathlon — per-discipline rawTSS routing for non-power-meter cyclists *(P3, 2026-04-30)*

**Context**: `computeBikeTssFromHr` (HR-based bike TSS) and `computeSwimTss` (pace-based swim TSS) exist in `src/calculations/triathlon-tss.ts:71–86` and `:30–40` but are never called. Currently in tri mode, bike and swim activities don't reach per-discipline CTL because `rawTSS` computation is gated to running activities (`activity-matcher.ts:605`).

**Effect**: Users without a power meter get less accurate per-discipline CTL/ATL/Form readings. The display falls back to whatever the matrix-based estimator produces, which is conservative.

**Fix**: extend `activity-matcher.ts` so in tri mode:
- Bike with power → `computeBikeTssFromPower` (squared IF) — already exists
- Bike with HR only → `computeBikeTssFromHr`
- Swim with pace → `computeSwimTss` (cubic IF, Toussaint 1992)
- Result writes to `garminActuals.rawTSS` for tri mode (parallel to running)

**Estimated**: ~2 hours. Tests should verify HR-only bike TSS values match the published Coggan zones.

---

### ✅ ISSUE-200: Triathlon — brick training should reduce the run-leg fatigue discount *(P2, 2026-05-08, FIXED 2026-05-12)*

**Context**: Race prediction hard-codes `RUN_FATIGUE_DISCOUNT_70_3 = 5%` and `RUN_FATIGUE_DISCOUNT_IRONMAN = 11%` regardless of the athlete's brick history. The whole point of brick sessions is to reduce that bike-to-run fade — an athlete with 12 weeks of bricks should be markedly less affected than one with zero.

**We already have**: `src/calculations/brick-detector.ts` counting brick sessions.

**Proposed model**: `actualFatigueDiscount = baseDiscount × (1 - brickAdaptation)` where `brickAdaptation` scales with recent brick volume (e.g. last 8–12 weeks). Defensible per Millet & Vleck 2000 (brick-specific running economy adaptation).

**Open questions before implementing**:
- Cap on `brickAdaptation` (e.g. max 50% reduction in discount)? An IM-experienced triathlete still fades — never zero.
- Window for "recent" — last 8 weeks of build, or rolling 12?
- Volume metric — count of brick sessions, total brick-run minutes, or weighted (longer bricks > short ones)?

**Files**: `src/calculations/race-prediction.triathlon.ts` (constants + discount application), `src/calculations/brick-detector.ts` (expose adaptation score). Update `docs/SCIENCE_LOG.md` with the Millet & Vleck citation and the constant calibration.

---

### ✅ ISSUE-186: Triathlon — open-water swim deficit not modelled *(P3, 2026-05-08, FIXED 2026-05-12)*

**Context**: We use pool CSS as the swim pace anchor and apply a `swimType` multiplier (ocean/lake/etc.) on top. But the pool→open-water deficit is a real, separable physiological/skill effect: sighting losses, no walls/turns, contact, wetsuit drag. Veiga 2013 puts it at ~5% slower, varies heavily by athlete experience. Currently lumped into the climate-style factor.

**Proposed model**: dedicated `openWaterAdjustment` scaled by athlete's recent open-water swim history (count + recency). Novice OW swimmer carries the full 5% penalty; experienced OW racer carries 1–2%.

**Open questions**:
- Detection — Strava sport `OPEN_WATER_SWIMMING` is reliable; do we also infer from venue/location data?
- Adaptation curve — linear with sessions, or asymptotic (most gains in first 5–10 OW sessions)?

**Files**: `src/calculations/race-prediction.triathlon.ts` swim-leg path, new helper in `src/calculations/swim-skill.ts` or extend existing. Citation: Veiga 2013.

---

### ISSUE-187: Triathlon — bike intensity factor should adapt to athlete experience *(P2, 2026-05-08)*

**Context**: `RACE_INTENSITY_BY_DISTANCE = { '70.3': 0.78, ironman: 0.70 }` is fixed. Real IM bike pacing varies 0.65–0.80 IF depending on experience and strategy. A first-IM athlete pacing 0.78 will blow the run; an experienced one at 0.70 won't.

**Two routes** (probe before implementing):
- (a) **Ask** the user their pacing intent in race setup ("conservative / target / aggressive").
- (b) **Infer** from `raceLog` IF distribution — first-timer defaults conservative, repeat racer matches their last race's IF.

Probably (b) when history exists, fall back to (a) on first race.

**Files**: `src/calculations/race-prediction.triathlon.ts`, race-setup UI for the prompt path.

---

### ✅ ISSUE-188: Triathlon — IM run leg uses blended VDOT, not run-specific *(P2, 2026-05-08, FIXED 2026-05-12)*

**Problem**: `currentVdot = state.v` is the overall blended VDOT, pulled toward whatever signals dominate the blend. For triathletes, bike fitness can inflate VO2 via cross-training, but that doesn't translate fully to run-specific capacity. The IM marathon leg is then over-predicted.

**Proposed**: a `runSpecificVdot` derived from run-only signals (PBs + recent run pace + run-derived HR-VDOT) used for the run leg of triathlon prediction. Bike/swim legs continue to use their own fitness anchors.

**Files**: `src/calculations/vdot.ts` (or new `vdot-run-only.ts`), `src/calculations/race-prediction.triathlon.ts` run-leg path.

**Mirror check**: running mode already uses run signals only — this brings tri-mode run-leg in line.

---

### ✅ ISSUE-189: Triathlon — verify aero/equipment inputs reach the headline forecast *(P1, fixed 2026-05-12, pending in-app confirmation)*

**Root cause**: the bike-aero modal's `predictBikeSplit` applied physics + physical course factors only. Two gaps vs the headline forecast in `predictTriathlonRace`:
1. **Empirical course factors** (shipped 2026-05-07, ~1.3M historical finishes per race location) were ignored — for any race with a high/medium confidence empirical entry (most majors), the modal preview disagreed with the headline by whatever the empirical-vs-physical delta is.
2. **Race-readiness penalty multiplier** (`raceReadiness.bike.penaltyMultiplier`) was not applied — captures low recent bike volume / longest ride relative to the race distance's endurance demands. For a low-readiness profile this is a ~5–10% slowdown the modal missed entirely.

Net effect: modal showed a 2:35 bike split when the headline said 2:50. A 15W-equivalent CdA improvement that the modal predicted at –5 min would still land at the headline forecast, but starting from a wrong baseline.

**Fix** (`src/ui/triathlon/bike-setup-view.ts:399-427` `predictBikeSplit`):
- Replace `applyCourseFactors(...)` alone with the same `pickCourseFactors(empirical, physical)` source picker the predictor uses, routed through `lookupEmpiricalCourseFactors` for the empirical lookup.
- Read `raceReadiness.bike.penaltyMultiplier` from the cached prediction when present; compute fresh via `computeTriRaceReadiness(state, distance)` on first launch / after invalidation.

**Regression test**: `src/ui/triathlon/bike-setup-preview.test.ts` — locks the modal-vs-headline parity to within 10s and validates that CdA tuning still moves the predicted split in the expected direction. 2 tests, both pass. Pending in-app confirmation that the prediction strip now matches the forecast card for Tristan's actual race.

---

### ✅ ISSUE-190: Triathlon — heat acclimatisation should discount climate penalty *(P2, 2026-05-08, FIXED 2026-05-12)*

**Context**: Currently the climate factor is a flat venue penalty regardless of where the athlete trains. Per Lorenzo & Cheuvront 2010, 10–14 days of heat acclimatisation delivers ~3–5% performance preservation in heat. A user training in Singapore racing IM Vietnam shouldn't carry the same 27-min climate penalty as someone training in Stockholm.

**Proposed model**: a `trainingClimate` signal compared against `raceClimate`. If the athlete's recent training environment matches or exceeds the race environment in heat/humidity, discount the climate penalty (cap at ~50% reduction).

**Source for `trainingClimate`**:
- (a) Strava activity weather data (temp on most rides) — preferred, no user friction.
- (b) Onboarding question — fallback for athletes without temp-tagged history.

**Files**: `src/calculations/race-prediction.triathlon.ts` climate-factor application, new helper to derive `trainingClimate` from activity history. Citation: Lorenzo & Cheuvront 2010.

---

### ✅ ISSUE-191: Triathlon — credit marathon-PB depth on IM run leg *(P3, 2026-05-08, FIXED 2026-05-12)*

**Context**: Two athletes with the same blended VDOT can have very different marathon experience — a 3:50 marathoner and a 2:50 marathoner. The 2:50 athlete handles IM marathon (essentially marathon at ~89% intensity) very differently — they have headroom and pacing experience. Currently we treat them identically.

**Proposed**: a marathon-experience multiplier on the IM run leg — credit for sub-3:30 marathon PBs, more for sub-3:00. Smooth function, not a step.

**Open questions**:
- Curve shape — linear with PB time, or stepped tiers?
- Recency — does a 2:50 from 5 years ago still count? Likely partial credit decays with time since PB.
- Does this apply to 70.3 run leg too, or only IM where the duration is the differentiator?

**Files**: `src/calculations/race-prediction.triathlon.ts` IM run-leg path, reads existing marathon PBs from `s.pbs`.

---

### ISSUE-192: Hyrox — per-station physiology fallback when historic race time is missing or stale *(P3, 2026-05-08)*

**Context**: Sister issue to the staleness-blend wiring shipped 2026-05-08 (which applied existing `bandWeight` / `splitsWeight` from `hyrox-staleness.ts` to the predicted time). When a user has no calibrated benchmarks AND no recent race time, the prediction collapses to band-keyed seed times. We have richer physiology signals (VDOT, FTP, MTL CTL, Strava CTL) and known per-station training loads (sled-push reps/week, wall-ball cadence drift, erg paces) that could re-anchor the per-station estimates rather than defaulting to population averages.

**Today's coverage** (already wired):
- Run pace from VDOT — `src/calculations/hyrox-run-pace.ts:65-95` (overrides user-entered when faster)
- VDOT + MTL CTL feed staleness mitigation — `src/calculations/hyrox-staleness.ts:70-92`
- Strava `ctlBaseline` feeds projection time — `src/calculations/race-projection.hyrox.ts`

**Gap**: stations other than running have no physiology fallback. `hyrox-station-potential.ts` exists but produces *improvement targets*, not absolute station times.

**Open design questions** (must answer before implementing — no made-up numbers per CLAUDE.md):
1. Which physiology signal predicts which station? Candidates per literature:
   - **Sled push / sled pull**: lower-body strength × bodyweight ratio. Need a strength signal — gym 1RM if logged, or proxy from `weightSessionsPerWeek` × duration?
   - **Wall balls / burpees**: cardiac fitness signal (VO2max, MAS, lactate threshold).
   - **Sandbag lunges**: lower-body endurance + grip — proxy from MTL CTL?
   - **Farmer carry**: grip endurance × bodyweight — no current signal.
   - **Ski erg / row erg**: directly from FTP-equivalent on the erg if available; otherwise from running threshold pace.
2. **Confidence weighting**: a sled-push estimate from gym log (high confidence) vs from `bricksPerWeek` proxy (low confidence) — how do we surface that without misleading the user?
3. **Calibration data**: do we have research-grade mappings from VDOT → wall-ball time, FTP → row-erg time? If not, this needs literature work first.
4. **Integration**: when does the physiology fallback win vs the band seed? Probably: only when confidence ≥ medium AND signal is present. Otherwise stick with the band seed.

**Why P3, not P2**: the staleness blend (shipped today) already partially addresses the user's concern by blending stored band → VDOT-implied band when stale. A user with strong VDOT will see seeds shift toward the implied band's seeds. The full per-station physiology fallback is a refinement, not a fix to a broken prediction.

**Files involved when this is built**: `src/calculations/race-prediction.hyrox.ts` (per-station fallback path), new helper(s) in `src/calculations/hyrox-station-physiology.ts`, citations into `docs/SCIENCE_LOG.md`.

---

### ISSUE-193: Hyrox — per-station detail view with sparklines *(P2, 2026-05-08)* — **🟡 code-complete pending in-app confirmation**

**Context**: Tier 1 of the per-station UX work shipped 2026-05-08 — `stationBenchmarkHistory` field, append-on-test wiring, backfill, inline percentile, PR badge, staleness caption. Foundation is in place but no dedicated drill-down exists yet. Tapping a station row should open a detail page showing: sparkline of historical test times for the format, list of all entries with dates, current best/worst/average, comparison to band median.

**Spec**:
- New view at `src/ui/hyrox/station-detail-view.ts`
- Trigger from a tap on `renderStationsTable` rows (forecast-view.ts:99-128)
- Sparkline reads `getStationHistory(state, station)` filtered by current format
- Show: best time + date, current/latest, improvement from first → latest, percentile evolution if percentiles can be retro-computed
- "Test again" CTA at bottom navigates to plan view + un-dismisses benchmark card (mirrors the forecast banner pattern)

**Files**: `src/ui/hyrox/station-detail-view.ts` (new), `src/ui/hyrox/forecast-view.ts:99-128` (wire row tap), reuse helpers from `src/calculations/hyrox-station-history.ts`.

**Estimated**: ~2 h.

---

### ISSUE-194: Hyrox — weakest-link insight (highest-ROI station) *(P2, 2026-05-08)* — **🟡 code-complete pending in-app confirmation**

**Context**: User asked about surfacing where the highest gain is. The skills-analysis panel in `src/ui/hyrox/forecast-view.ts:218-260` shows top strengths and limiters by percentile, but doesn't combine percentile with **time contribution** to the total. A sled push at p30 contributing 4 minutes to the total finish is a bigger lever than burpees at p25 contributing 90 seconds — the percentile tells you "weakness", time-share tells you "size of the prize".

**Proposed model**:
- For each station, compute `gainableSec = adjustedSec × (1 − bandMedianRatio)` — how many seconds you'd save by closing the gap to the band median (or some other target percentile).
- Surface the top 1-2 stations by `gainableSec` as "Working on sled push has the highest forecast impact: ~45 sec gainable to band median."
- Caveat: gain potential depends on training adaptability. A station the athlete has been at p30 on for 12 months may be a structural ceiling, not a low-hanging fruit. Could weight by improvement rate from `stationBenchmarkHistory` once enough data exists.

**Open questions**:
- Target percentile for the gain calculation: band median (p50)? Or "next tier up" (advance from p30 → p50)?
- How to handle stations the user can't access (sled at home gym): exclude from the rec?
- Surface as a card on the forecast view, or as a sub-section of skills analysis?

**Files**: `src/calculations/hyrox-weakest-link.ts` (new), `src/ui/hyrox/forecast-view.ts` (surface in skills analysis or new card).

**Estimated**: ~1.5 h.

---

### ISSUE-195: Hyrox — race-pace vs fresh-test fade visualisation *(P3, 2026-05-08)* — **🟡 Phase 1 code-complete pending confirmation, Phase 2 still gated on race-result import**

**Context**: User asked: "we would need to track fitness decay across the race right?" — yes. The benchmark card stores fresh-test times (half distance × 2), but the forecast applies in-race fatigue separately via run-leg multipliers. The athlete-specific decay across the full race is not measured today; we use a band-scaled fatigue rate (`PER_STATION_FATIGUE_RATE_BY_BAND`).

**Proposed feature**:
- Per station, show the fresh-test time alongside the predicted race-day time. Format: "Fresh: 2:00 · Race-day: 2:15 · 7.5% fade." (dropped em-dashes per CLAUDE.md UI rules).
- This is purely informational — surfacing what's already computed, not new math.
- Connects to a future capability: when an athlete races a full Hyrox, extract per-station times from the result and compare to their fresh tests. Their personal `fadePerStation` factor replaces the band-scaled assumption.

**Phase 1**: just surface the fade % on the per-station detail view (ISSUE-193). Reads `line.adjustedSec` (post-fatigue from run-leg multipliers) vs the fresh test time from history.

**Phase 2**: extract per-station race times when a race result lands (currently only total race time is logged). Compute personal `fadeFactor[station]`. Replace the band-scaled fatigue rate for athletes with race history. Needs a race-result entry path (out of scope until logged race results carry per-station splits).

**Files**: `src/ui/hyrox/station-detail-view.ts` (Phase 1, when ISSUE-193 ships), future `src/calculations/hyrox-personal-fade.ts` (Phase 2).

**Estimated**: ~1 h for Phase 1 once 193 ships. Phase 2 gated on race-result-import design.

**Note 2026-10-13 (lane H1, `c9952a5`, `c6f090b`):** race splits from onboarding and Log a previous time are now written to the station history (source 'race'), so the Phase 2 input exists per station when a race is logged with splits. The station detail "Race-day fade" row shows only when the newest entry is a test or session best (a race split is already a race-day time) and never on a doubles page. The fresh half test is still doubled with no fade constant (ISSUE-395 (f)).

---

### ISSUE-196: Hyrox — goal-back-calculation (target time → required station times) *(P3, 2026-05-08)* — **🟡 code-complete pending in-app confirmation**

**Context**: Inverts the prediction. Given a target finish time (e.g. "I want to break 75 minutes"), back-calculate the per-station times the athlete needs to achieve. Useful for setting test targets and structuring training around specific weaknesses.

**Proposed model**:
- Take the current prediction's per-station, run-leg, and roxzone breakdown.
- Compute the gap: `gainNeeded = currentPredictionSec − targetSec`.
- Distribute the gain across stations weighted by current ranking (lower percentile = more headroom) and time contribution. Avoid suggesting impossible station times (cap at the band's elite seed).
- Surface as: "To break 75 min, you need wall balls under 1:55 (currently 2:10) and sled push under 1:30 (currently 1:42). Other stations stay near current."

**Open questions**:
- How aggressive to be on the distribution? Equal-time-share gain split is too naive (some stations have more headroom).
- Surface where? Optional "set a target" CTA on the forecast view → opens a modal with goal slider → shows back-calc.
- Validation: predicted times after applying the back-calc should sum to roughly the target. Edge case: if target is unrealistic (faster than band's elite seed), surface explicitly rather than silently clipping.

**Files**: `src/calculations/hyrox-goal-back-calc.ts` (new), `src/ui/hyrox/goal-modal.ts` (new), surface CTA in `src/ui/hyrox/forecast-view.ts`.

**Estimated**: ~3 h. Worth probing the design before building — multiple reasonable interpretations.

---

### ISSUE-197: Hyrox — within-station fatigue model (rep/segment decay) *(P3, 2026-05-08, blocked on data)*

**Context**: Currently each station is a single time. In reality wall balls slow over the 100 reps, sled push slows on later 25m segments, sandbag lunges slow as form breaks down. Within-station decay is real but not modelled.

**Why this is blocked, not just deferred**: per CLAUDE.md "no made-up numbers" rule, we can't invent the constants. We'd need either:
1. Published HYROX rep-decay data (not aware of any).
2. Coach-derived heuristics with confidence flagged as low.
3. Empirical data from device sensors — wall-ball cadence from accelerometer, sled-push split times from manual segment markers, etc.

**What this would unlock once data exists**:
- More accurate per-station predictions (a 100-rep wall-ball block isn't 100 × first-rep pace).
- Visualisation of "where the seconds bleed" within a station.
- Coaching insights — "your wall ball cadence drops 12% over the last 25 reps, focus on cadence consistency".

**Files when unblocked**: `src/calculations/hyrox-within-station-fatigue.ts` (new), feeds into `race-prediction.hyrox.ts` station-time computation, surfaces in detail view.

**Estimated**: blocked — data-gathering first.

---

### ISSUE-149: iOS build — remaining wiring + on-device verification *(P1, 2026-04-27)*

**Context**: iOS platform scaffold landed 2026-04-16 (ISSUE-134/136). Voice plugin, haptics adapter, Info.plist, bundle rename to Mosaic are all in code. But the build has never run on a physical device.
**Remaining items**:
1. **On-device test.** Open Xcode (`npx cap open ios`), sign with a Team, build to iPhone. Verify: voice over silent switch, voice while screen locked, music ducking (Spotify/Apple Music), haptic ticks on step transitions.
2. **Wire `keep-awake` into Record tab.** `src/guided/keep-awake.ts` has `enableScreenAwake()`/`disableScreenAwake()` but they are not called anywhere. Hook into `startTracking`/`stopTracking` in `src/ui/gps-events.ts` when a guided run is active.
3. **Wire `BackgroundGeolocation.ready(GUIDED_RUN_LOCATION_CONFIG)`.** Config object is in `src/guided/background-location.ts`. Needs a call site in the tracker bootstrap that uses Transistorsoft on native and falls back to `navigator.geolocation` on web.
4. **Xcode signing.** `com.mosaic.training` bundle ID is set but no Team / provisioning profile selected yet.
5. **App icon + launch screen.** Still Capacitor placeholder assets.
**See also**: `docs/IOS_SETUP.md` "Remaining work" section for the full checklist.
**Files**: `src/ui/gps-events.ts`, `src/guided/keep-awake.ts`, `src/guided/background-location.ts`, `ios/App/App/Assets.xcassets/`.

---

### ISSUE-150: Gym programme overhaul — Whoop-level UX from onboarding to tracking *(P2, 2026-04-27)*

**Problem**: The gym module is the weakest part of the app. A single `gs` field set at onboarding, hardcoded templates that repeat weekly with no progression, synced WEIGHT_TRAINING activities that don't tick off planned sessions, no exercise customisation, no strength tracking, and second-class UI treatment in both Home and Plan views.
**Full spec**: `docs/GYM_PROGRAMME_SPEC.md` — contains the complete question set (39 items across 11 categories) that must be answered before implementation starts.
**Scope categories**:
1. Positioning (support-for-running vs second pillar)
2. Scope/ambition (progressive overload vs enhanced templates)
3. Onboarding inputs (equipment, 1RMs, goals, preferences)
4. Programme design (progression model, periodisation, mobility blocks)
5. In-session UX (live logging vs mark-done, rest timer, live screen)
6. Run plan integration (scheduling constraints, mid-plan changes)
7. Activity matching (auto-complete planned slots from synced data)
8. Load/fatigue model (Signal A/B treatment, recovery impact)
9. UI surfaces (drill-down view, home card, plan row, strength history)
10. Edge cases (non-WEIGHT_TRAINING gym, detraining, injury downgrade)
11. Direction (greenfield spec vs incremental evolution)
**Current state**: `src/workouts/gym.ts` (templates), `src/types/state.ts:324` (`gs` field), `src/ui/wizard/steps/volume.ts:45-56` (onboarding), `src/ui/home-view.ts:1674-1758` (home card), `src/ui/plan-view.ts:471-473` (plan row), `src/calculations/activity-matcher.ts:473-492` (matching).
**Next step**: Tristan answers the spec questions in `docs/GYM_PROGRAMME_SPEC.md`, then we build a phased implementation plan.

---

### ISSUE-148: Recurring activities — add flow in Account *(P3, 2026-04-25)*

**Problem**: Account → Training → Recurring activities only supports remove (× per row). Users can't add a new recurring sport without re-onboarding via Reset.
**Why deferred**: Add flow needs the same sport-picker / duration / intensity picker that lives in `wizard/steps/schedule.ts`. Lifting that into a reusable modal is non-trivial — separate task.
**Files**: `src/ui/account-view.ts` (`showRecurringActivitiesModal`), `src/ui/wizard/steps/schedule.ts` (sport picker logic to extract).
**Workaround**: Reset (Account → Advanced → Reset) and re-onboard. Existing PBs / physiology / Strava connection are preserved by `softResetState`.

---

### ✅ ISSUE-147: Just-Track mode — synced activities don't surface in local feed *(resolved 2026-04-23)*

**Resolved by the Just-Track redesign** (CHANGELOG 2026-04-23). Option (a) chosen: `initializeSimulator` now seeds a rolling 1-week bucket and `advanceWeekToToday` extends it one week per calendar week. Sync pipeline writes into `wk.garminActuals` unchanged. Activity feed, recent activity, and weekly summaries now populate identically to planned users.

---

### ✅ ISSUE-129: plan-view.ts uncommitted work wiped by `git checkout --` *(reconstructed 2026-03-22)*
**What happened**: Claude ran `git checkout -- src/ui/plan-view.ts` to undo cosmetic changes, destroying all uncommitted work.
**Fix**: All code reconstructed. Illness banner (`buildIllnessBanner`), running km bar (`weekKmBar`), week overview / coach insight pills (`buildWeekOverview`), and check-in button all confirmed present in `plan-view.ts`. CLAUDE.md updated with hard rule against `git checkout --`.

---

### ISSUE-137: Excess-load modal hides Reduce option when a tempo remains *(P1, fix pending confirmation — 2026-04-15)*

**Problem**: When extra cross-training load pushes the week over target, the modal only shows Push / Keep — even when a tempo or other quality workout is still on the plan. "Recommended" green appears on Keep with no explanation.
**Root cause**: `suggester.ts:1002-1018` caps the reduction budget by `capFraction = maxReductionTSS / fullRrcTSS`. When the overshoot is small relative to the full run-replacement credit, `effectiveRRC` drops below `minLoadThreshold` (5 load units). `buildReduceAdjustments` then short-circuits at line 529 before any candidate is evaluated, silently returning zero adjustments.
**Fix applied**:
- `suggester.ts:529`: only break when at least one adjustment has been proposed.
- `suggester.ts:545`: first quality downgrade records its true `loadReduction` instead of a tiny budget-clipped number (controlled overshoot preferred to silent suppression).
- `suggestion-modal.ts`: when `!hasReductions && !hasReplacements`, show an explanation banner and move the "Recommended" green from Keep → Push (carrying forward is the better default; Keep is the fallback).
- `km-budget.test.ts`: assertion loosened to allow overshoot by ≤ single largest adjustment's load.
**Status**: Awaiting Tristan to reproduce on-device with the screenshot scenario (5 cross-training activities, tempo remaining) and confirm Reduce now appears.

---

### ✅ ISSUE-138: Recovery workout tier added (easy → recovery downgrade) *(P2, fixed 2026-05-06)*

**Problem**: When remaining runs are all already at or near the running floor and all easy, the suggester has no lever to absorb excess load — Reduce returns empty.
**Fix**: `'recovery'` is the bottom of the intensity ladder (`easy → recovery` in `downgradeType`). In `buildReduceAdjustments`, the easy-run branch now falls back to an `easy → recovery` intensity downgrade whenever distance cuts are blocked (floor-constrained OR run already at `MIN_EASY_KM`). `paceForType` and `paceLabelForType` in `applyAdjustments` handle `'recovery'` (pace = easy × 1.12; label = "recovery pace"). Removed the `if (workout.t !== 'easy')` guard that was blocking the type update. All 13 cross-training tests pass, typecheck clean.
**Constants confirmed**: `LOAD_PROFILES.recovery = { aerobic: 0.98, anaerobic: 0.02 }`, pace `× 1.12`. Cycling/swim extension deferred — lower priority since cycling load is already runSpec-discounted 0.55×.

---

### ISSUE-133: HR drift not computed for activities — "HR during sessions" always shows "—" *(P3)*

**Problem**: The "HR during sessions" signal in the week debrief always shows "—" because `hrDrift` is `undefined` on all garminActuals.
**Root cause**: `hrDrift` comes from `row.hrDrift` in the DB, which is populated by the edge function during Strava sync. The edge function either doesn't compute HR drift for all activities, or doesn't store it in the DB column.
**Desired behaviour**: For steady-state runs >20 minutes with HR stream data, compute drift (second-half avg HR / first-half avg HR) in the edge function and store in `garmin_activities.hr_drift`.
**Impact**: "HR during sessions" signal in debrief and plan-view week overview. Low priority since it's one of five signals and the others now work.
**Files**: `supabase/functions/sync-strava-activities/index.ts` (needs drift computation), `src/calculations/activity-matcher.ts` (reads `row.hrDrift`).

---

### ✅ ISSUE-131: Resting HR used for iTRIMP should be a rolling average, not today's snapshot *(P2)*

Added `computeRollingRestingHR(physiologyHistory, fallback)` in `activity-matcher.ts`: takes the last 7 days of `physiologyHistory` entries with a valid `restingHR`, computes the median (≥3 readings required; falls back to raw snapshot if fewer). Both `matchAndAutoComplete` and `healMissingITrimp` now compute `rhrBaseline` once at entry and pass it to every `resolveITrimp` and `calculateITrimpFromSummary` call instead of `s.restingHR`. `deriveRPE` and `computeHRCalibratedVdot` still use the raw snapshot (lower sensitivity, separate concern). 1480/1480 tests pass.

---

### ISSUE-130: Coach — LLM narrative deferred, Phase 2 signals still to wire *(deferred 2026-04-24)*

**Status**: The LLM narrative half of this issue is **deferred until paying users exist**. The rules-layer half (the actual Coach surface) is built and live via `src/ui/coach-view.ts`.

**What shipped**:
- `src/calculations/daily-coach.ts` — `computeDailyCoach(state)` aggregates all signals into `CoachState` (stance, blockers, primaryMessage, sessionNote, workoutMod). This IS the "Brain".
- `src/ui/coach-view.ts` — Sleep-style sub-page (sky hero, stacked cards, "Why this call" evidence bullets, Recovery / Fitness / This week / Status). No LLM fetch.
- Coach button in Home header + Plan header.

**What's deferred (do not deploy)**:
- `supabase/functions/coach-narrative/index.ts` stays in the repo as dormant scaffolding but is not deployed and not called from the client. The infra cost (GDPR consent modal, subscription plumbing, server-side rate limiting, Anthropic TOS review, Apple privacy nutrition label update) is not justified pre-revenue. The rules layer already delivers the synthesis the LLM was meant to provide. See `docs/BRAIN.md` for the preserved design reference.
- Next LLM scope when revisited (threshold: ~100 paying users): **"Ask the coach" chatbot**, not the narrative paragraph. Explaining plans and recovery is a different and more valuable product than restating the rules layer in prose.

**Phase 2 signals still worth wiring (rules-layer work, no LLM)**:
- VDOT history sparkline (no history stored yet — needs `vdotHistory` array populated on week advance)
- Weekly aerobic efficiency trend across last 4 weeks (aggregate `hrDrift` from `garminActuals`)
- Previous-week carry-forward: if last week's stance was `reduce`/`rest`, this week starts discounted to prevent whiplash

---

### ISSUE-135: Race prediction marathon time optimistic when VO2/LT stale *(P3, partially addressed)*

**Symptom**: Race Predictions marathon showed 3:07 for a user with a 3:12 PB who hasn't been running much. Now lands at ~3:09 after fixes, which the user has accepted as reasonable given stale watch data.

**What shipped (2026-04-13)**:
- **Marathon tier now running-specific**: `predictFromLT` derives the marathon multiplier tier from LT pace itself (`cv(10000, ltPace * 10)` → VDOT band) rather than from `athleteTier` (total cross-training CTL). Previously cross-trained athletes got "high_volume" tier (1.06 mult) regardless of running fitness.
- **Recent run auto-derived from garminActuals**: Blend now uses the most recent running activity rather than the stale onboarding `s.rec`.
- **Card relabeled** "Current Race Estimates" with subtitle "Estimated finish times if racing today" so users understand it's current-fitness, not end-of-plan.
- `s.v` compounding detraining bug fixed (51.4 → 24.5 corruption); state repair migration added.
- LT physiology sync will self-heal now that `s.v` is repaired (±8 VDOT deviation guard no longer rejects).
- Rewired both Race Prediction cards to `blendPredictions()` (LT/VO2/PB/recent blend) instead of pure VDOT-to-time.

**Rejected approaches** (do not revisit without discussion):
- **PB ceiling** — user explicitly: "I don't want a cap at PB that's not the point". Blended prediction can legitimately be faster than PB if the evidence (LT, VO2, recent pace) supports it.
- **HR-scaled recent run extrapolation** — tested and made marathon worse (scaled-up 10K projects too aggressively over 42K). Reverted to raw garminActual data.

**What remains**:
- Residual 3:09 optimism likely comes from stale VO2 (`s.vo2=56` vs chart shows ~47). Will resolve when physiology sync updates VO2 from the watch (self-healing path in place now that `s.v` is correct).
- Could optionally reduce VO2 weight when no recent running activity in last ~2 weeks, but probably not worth it if the self-heal works.

**Files**: `src/calculations/predictions.ts`, `src/ui/stats-view.ts`, `src/ui/welcome-back.ts`, `src/state/persistence.ts`

---

### ISSUE-145: Speed-profile marathon baseline too optimistic *(P1, logged 2026-04-16, ✅ FIXED 2026-05-12 — pending Tristan's on-device confirmation)*

**Fix summary (2026-05-12 audit #11)**: All four candidate fixes implemented. ISSUE-145 profile now blends to 2:58:48 (was 2:51:53). Test lower bound restored to 10500s (science audit floor — had been silently lowered to 10080s to mask the bug). All 1783 tests pass. See SCIENCE_LOG.md "Marathon Prediction Audit #11" for full physiological rationale and four-part fix detail.

Files touched: `src/calculations/predictions.ts` (`predictFromLT` tier smoothing + raised speed mults, `predictFromPB` Riegel floor 1.10 for marathon-from-short-anchor, `blendPredictions` no-long-race-PB penalty), `src/calculations/forecast-profiles.test.ts` (lower bound 10080 → 10500), `src/calculations/predictions.test.ts` (added 3 new tests covering the Riegel floor behaviour).

**Audit #12 follow-up (same day, 2026-05-12)**: Two adjacent gaps closed.

- **Onboarding PB / experience-level cross-check** — `src/calculations/experience-level-validation.ts` (new) plus inline notice in `src/ui/wizard/steps/manual-entry.ts`. A 3:37 marathoner could self-select "beginner" with no validation; the model would silently use `max_gain_pct=9` + `ref_sessions=4` (vs intermediate 7 / 5.5) and over-claim improvement. Now flags inconsistency at PB-entry with one-tap correction. Asymmetric — only flags under-claiming. 13 unit tests.
- **Dual-tau adaptation model** — `src/calculations/training-horizon.ts` + new constants in `training-params.ts`. Single-tau `1 - exp(-t/tau)` saturated at 99% by week 41, so 43-week plans claimed nearly identical improvement to 25-week plans. Replaced with additive fast (VO2max) + slow (LT/economy) model per Joyner & Coyle 2008 + Seiler 2010 + Bouchard 1999. 18-week Pfitzinger calibration preserved; 43-week claim widened (Tristan-shape 3:37 → 3:19 instead of 3:28). 5 new dual-tau guards.

1806/1806 tests pass. SCIENCE_LOG audit #12 entry.



**Symptom**: `forecast-profiles.test.ts > Per-profile pipeline tests > 7. Speed → Marathon` has been failing since the science-audit change that raised the lower bound of the expected baseline range. One test fails, 35 in the same file pass.

**Exact failure**:
```
baseline 2:51:53 should be in [2:55:00, 3:35:00]:
expected 10313.44 to be greater than or equal to 10500
```
Predicted baseline marathon time is **~3 minutes 7 seconds faster** than the assertion floor. Not a crash — the pipeline returns a valid number — but it's outside the expected-physiological-range the science audit laid down.

**Profile under test** (`forecast-profiles.test.ts:195`):
- 5K PB 18:00 (`k5:1080`) · 10K PB 38:00 (`k10:2280`) · no half-marathon or marathon PB
- LT pace 3:45/km (`ltPace:225`) · no VO2max · no recent race
- `confirmedRunnerType: 'Speed'` · intermediate · 5 runs/wk · 20-week plan
- Expected baseline range `[2:55:00, 3:35:00]` — comment on line 202 says lower bound was raised by science audit #8 (tier-aware LT multiplier)

**Root-cause diagnosis** (investigated in this session):
The baseline comes from `blendPredictions()` in `predictions.ts`. With this input vector:
- `predictFromPB(42195, pbs, b=1.077)` → extrapolates 10K PB to 42195m via Riegel with `b≈1.077`. Yields **~2:59:00**. Riegel under-penalises speed runners at marathon distance because `b` computed from k5→k10 only doesn't capture the endurance-specific drop-off past 21K.
- `predictFromLT(42195, 225, 'Speed', tier)` → derives tier from `cv(10000, 2250)` ≈ VDOT 51-52, which sits **right on the 'trained' (≥45) / 'performance' (≥52) boundary**. At `performance · speed` the multiplier is **1.08** → **~2:50:53**. At `trained · speed` it's **1.10** → **~2:54:03**. Tiny numerical jitter in `cv()` decides which side of the boundary you land on.
- `predictFromVO2` returns `null` (profile has no vo2max).
- `predictFromVolume` (Tanda) returns `null` (no `weeklyRunKm` / `avgPaceSecPerKm` passed in).

Because VO2 and Tanda are both null, the no-recent marathon base weights `{pb: 0.10, lt: 0.45, vo2: 0.15, tanda: 0.30}` collapse to just `pb=0.10 + lt=0.75` (Tanda's weight is explicitly redistributed to LT on line 460-463; VO2's weight just shrinks the denominator). **LT predictor ends up carrying 88% of the blend.** Under `performance` tier this produces `0.10·10745 + 0.75·10253` normalised by 0.85 = **10311s = 2:51:51** — matches the failing assertion (`10313.44`).

**Summary of what's wrong**:
1. The `predictFromLT` marathon multiplier at `performance · speed` (1.08) is too aggressive for a speed-profile runner with no half-marathon or marathon PB. A true "sub-18 5K, never raced past 10K" speed runner typically first-marathons in 2:55–3:10, not 2:51. The multiplier was calibrated on runners whose marathon fitness has been demonstrated, not extrapolated.
2. `predictFromPB`'s Riegel extrapolation with `b` derived from k5→k10 alone under-corrects the endurance drop-off over 21–42K. `safeB = min(b, 1.15)` caps extreme cases but doesn't lower-bound for speed runners. Speed runners need a *higher* fatigue exponent when extrapolating past HM distance without a long-race PB anchor.
3. The blend weights leave LT at 75% (plus VO2's 15% effectively available when VO2 is null) when both VO2 and Tanda are missing. No safety net against an optimistic LT predictor.
4. The performance/trained tier boundary at VDOT=52 is a hard cutoff that flips the marathon mult from 1.10 → 1.08 with a ~2 minute discontinuity. Linear interpolation between tiers (rather than a step function) would reduce boundary jitter.

**Why the test is set up this way**: The science audit (see `SCIENCE_LOG.md` on tier-aware LT multipliers, search "audit #8") raised the lower bound of the Speed → Marathon baseline range to 10500 precisely to encode the "no marathon history = more endurance uncertainty" physiological reality. The test is correct about the range. The code's predictors are the bit that's optimistic.

**User impact**: A runner onboarding with a fast 5K/10K but no marathon experience will see a slightly optimistic first-marathon prediction. They may pace off this estimate on race day and blow up. The error is **~3 minutes** at the `performance` tier boundary and **~30 seconds** at `trained`. Both are within "wrong but plausible" range for race-day pacing decisions.

**Possible fixes (pick one or combine)**:
a. Raise `marathonMult['performance']['speed']` from 1.08 to 1.10, `marathonMult['trained']['speed']` from 1.10 to 1.12. Reduces optimism by 200-300s directly.
b. Add a "no HM/M PB" penalty: when `pbs.h == null && pbs.m == null` and `targetDist === 42195`, apply an extra 2-3% multiplier to both `predictFromPB` and `predictFromLT` outputs to encode endurance uncertainty.
c. Cap `predictFromPB`'s closest-anchor selection: when extrapolating past 21K with only 5K/10K anchors, blend toward a fallback safe exponent rather than using `b` from just two short distances.
d. Smooth the tier boundary: linear interpolation of `marathonMult` between tier cut-points instead of a step function.
e. When both VO2 and Tanda are null and `targetDist === 42195`, bump `w.pb` and dampen `w.lt` so LT doesn't dominate.

**Why not act now**:
- Per `CLAUDE.md`: "Never invent constants, multipliers, thresholds, or fallback values". Raising 1.08 → 1.10 needs either literature backing or a calibration pass against a runner cohort.
- Per `CLAUDE.md` scientific-defensibility rules: any change requires stating the physiological basis, justifying the new constant, and logging in `SCIENCE_LOG.md`.
- This is a full science-audit item, not a quick fix. Deserves a dedicated session.

**Files implicated**: `src/calculations/predictions.ts` (lines 147-180 marathon multipliers, 48-63 `predictFromPB`, 384-470 `blendPredictions` weights). Test: `src/calculations/forecast-profiles.test.ts:195-204`. Science log entry to update: `docs/SCIENCE_LOG.md` (the "tier-aware LT multiplier / audit #8" section).

**Related**: ISSUE-135 (marathon optimism from stale VO2) — different root cause (physiology not updated) but same user-facing symptom (race prediction too fast).

---

### ISSUE-146: Activity matcher should suggest best-fit workout when no exact match *(P3, 2026-04-17)*

**Problem**: When a completed run doesn't neatly match a planned workout, it falls through to "unmatched". The user gets no credit and no feedback on what the run most closely resembled.
**Desired behaviour**: When the primary matcher fails, run a fallback scoring pass across all remaining planned sessions for the week. Score by distance delta, avg pace vs target zone, and avg HR vs expected zone. Present the best-fit suggestion as "Looks like this was your [Tempo]?" with a one-tap confirm. Include a "None of these" default action so a poor match doesn't get auto-assigned.
**Gate**: Require a minimum match score threshold before surfacing a suggestion. A sloppy mixed-pace run should stay unmatched rather than being mislabelled (protects adherence tracking and VDOT).
**Files**: `src/calculations/activity-matcher.ts` (scoring function), `src/ui/activity-review.ts` (suggestion UI in the review flow).

---

### Read `docs/STATS_REDESIGN.md` before suggesting any to-do list

When Tristan asks "what should we work on?" or "what's next?" or requests a to-do list — **direct him to `docs/STATS_REDESIGN.md` first**. The stats page redesign is the #1 priority. Walk through the suggested next session agenda in that file:

1. Pick a design direction (A, B, C, or D)
2. Define the 5-second test — what 3 things should a runner know after 5 seconds
3. Sketch the summary page layout before touching any code
4. Decide on depth model (single scroll vs current 2-level cards)
5. Implement, then review with the reviewer agent

Do not skip to other issues until a direction is chosen and the redesign is underway.

---

## 🔵 Tested & Confirmed (2026-04-08)

All items in this section have been confirmed working on device.

### ✅ ISSUE-130: Unmatched activities showing in strain but not in timeline *(confirmed 2026-04-08)*
**Fix**: Overflow items added to `adhocWorkouts` via `addAdhocWorkoutFromPending`, `garminMatched` set. `seenGarminIds` dedup prevents double-counting.
**Files**: `src/ui/activity-review.ts`

---

### ✅ ISSUE-128: Recovery advice sheet — session-specific actions *(confirmed 2026-04-08)*
**Fix**: Adjust sheet detects today's quality session, shows "Convert to easy run" / "Move to [Day]", back-to-back flag, generic fallback rows.
**Files**: `src/ui/home-view.ts`

---

### ✅ ISSUE-126: REM sleep data missing — field name mismatch *(confirmed 2026-04-08)*
**Fix**: Webhook checks both `remSleepInSeconds` and `remSleepDurationInSeconds`. Light sleep also captured.
**Files**: `supabase/functions/garmin-webhook/index.ts`, `src/ui/home-view.ts`

---

### ✅ ISSUE-94: Activity card map too zoomed out *(confirmed 2026-04-08)*
**Fix**: `drawPolylineOnCanvas` filters garbage coords. Canvas hidden if no valid points remain.
**Files**: `strava-detail.ts`

---

### ✅ ISSUE-102: Cross-training load missing from wk.actualTSS *(confirmed 2026-04-08)*
**Fix**: `addAdhocWorkout` + `addAdhocWorkoutFromPending` accumulate Signal B TSS onto `wk.actualTSS`.
**Files**: `src/ui/activity-review.ts`

---

### ✅ ISSUE-105: Garmin sleep/backfill not pulling *(confirmed 2026-04-08)*
**Fix**: 12-hour TTL replaces permanent guard. Old key migrated on first run.
**Files**: `src/data/supabaseClient.ts`

---

### ✅ ISSUE-107: Verify "Wrap up week" Sunday behaviour *(confirmed 2026-04-08)*
**Fix**: Sunday debrief pill, auto-fire once, dismiss/reopen, week advance all working.
**Files**: `src/ui/week-debrief.ts`, `src/ui/plan-view.ts`

---

### ✅ ISSUE-114: Recovery staleness gate *(confirmed 2026-04-08)*
**Fix**: `computeRecoveryScore` returns `dataStale: true` when physiology >3 days old. Grey "Sync Garmin" pill on Home, amber message on Stats.
**Files**: `src/calculations/readiness.ts`, `src/ui/home-view.ts`, `src/ui/stats-view.ts`

---

### ✅ ISSUE-115: Stats page redesign v2 *(confirmed 2026-04-08)*
**Fix**: 3-card layout with inline sparklines. VDOT sparkline in fitness detail. Readiness = single scroll. Zones chart removed.
**Files**: `src/ui/stats-view.ts`

---

### ✅ ISSUE-125: Underload system — km floor nudge + carry-over fixes *(confirmed 2026-04-08)*
**Fix**: Green nudge card for km floor, false carry-over cleared at week advance, carry-over card tap fixed.
**Files**: `src/ui/plan-view.ts`, `src/ui/events.ts`, `src/state/persistence.ts`, `src/ui/excess-load-card.ts`

---

### ✅ ISSUE-124: Home recent activity — dates + unmatched display *(confirmed 2026-04-08)*
**Fix**: Actual dates shown (e.g. "Mon 17 Mar"). Unmatched items show amber pill, tap opens review.
**Files**: `src/ui/home-view.ts`

---

### ✅ ISSUE-133: Alpine skiing (and other sports) shows "Estimated" TSS — iTrimp not computed from Strava HR *(P2)*

Verified stale (2026-05-07): the edge function stores `avg_hr` for all activity types (not just running). `resolveITrimp` in `activity-matcher.ts` already falls back to `calculateITrimpFromSummary(avg_hr, duration, rhrBaseline, maxHR)` for any sport when `row.iTrimp` is null. HR-based TSS should be computed correctly for skiing/cross-training. No code change needed; if the "Estimated" label still appears, it means `avg_hr` was null for that specific activity (no HR device worn), which is correct behaviour.

---

### ✅ ISSUE-136: Garmin step count never populates in `daily_metrics.steps` — FIXED 2026-04-14

**Root cause**: Garmin's webhook dailies payload uses field name `steps`, not `totalSteps`. The `totalSteps` field is only used by the REST pull / backfill endpoint. The webhook was storing `d.totalSteps ?? null`, which was always undefined → NULL.

**Fix**: `handleDailies` now reads `d.steps ?? d.totalSteps ?? d.stepsCount` as the step value. Also added `active_calories` (`d.activeKilocalories`), `active_minutes` (`d.moderateIntensityDurationInSeconds + d.vigorousIntensityDurationInSeconds`, fallback `d.activeDurationInSeconds`), and `highly_active_minutes` (`d.vigorousIntensityDurationInSeconds`). Confirmed on-device: steps flowing to strain view.

**Related**: `sync-today-steps` edge function rewritten to read directly from `daily_metrics` (previously called Garmin epoch API which returned `401 app_not_approved`). Webhook is now the single source of truth for steps.

---

### ISSUE-134: Garmin LT threshold not syncing — `userMetrics` push not enabled *(P2, blocked)*

**Status 2026-04-14**: Confirmed still broken. `lt_thresholds` table is entirely empty. `physiology_snapshot_daily.lt_pace_sec_per_km` is NULL across every row. Garmin webhook logs show only `dailies` and `stressDetails` pushes — zero `userMetrics` pushes have ever arrived.

**Blocked on**: Garmin developer portal access (Tristan flagged ongoing portal access issues on 2026-04-14). The app/dev console needs the **User Metrics** push subscription enabled. The webhook handler (`garmin-webhook/index.ts` line 59, `handleUserMetrics`) and the DB tables are wired correctly — we just never receive the payload.

**Once portal access is restored**:
1. Enable the **User Metrics** data type / push subscription for the app in developer.garmin.com
2. Trigger a qualifying Garmin activity (or wait for Garmin to recompute)
3. Verify `[garmin-webhook] Physiology snapshot saved` appears in webhook logs
4. Verify `physiology_snapshots.lactate_threshold_pace` populates

**Edge function prep already done**: `sync-physiology-snapshot` queries the latest `physiology_snapshots` row without a date filter (deployed 2026-04-07), so once data lands in the table it will pull through to state immediately regardless of how infrequently Garmin pushes.

**Files**: Garmin developer portal (external, blocked), `supabase/functions/garmin-webhook/index.ts` (handler exists), `supabase/functions/sync-physiology-snapshot/index.ts` (updated), `src/data/physiologySync.ts` (updated).

---

## 🟡 To Be Discussed

Issues where a design decision is needed before any code work.

### ISSUE-33: Can't plan 2 workouts on one day
**Question**: Was this ever supported, or has it never been built?
**Decision needed**: Confirm whether this is a regression (fix it) or a new feature request (scope it properly). Low priority until plan page UX is settled.

---

### ISSUE-97: Home load graph — remove or redesign?
**Decision needed**: The load bar chart on Home doesn't read clearly. Options:
- **Remove it** — rely on Stats page for load history
- **Redesign** — add a clear axis, legend, and explanation
**Files**: `src/ui/home-view.ts`. Connected to ISSUE-108 (daily loop / Home hierarchy).

---

## P1 — Bugs (broken or actively misleading)

### ✅ ISSUE-01: Stats chart current week near-zero despite high total TSS *(fixed 2026-03-04)*
Removed `garmin-` filter from `computeWeekRawTSS` (Signal B) in `fitness-model.ts`.
Signal A (`computeWeekTSS`) retains the filter — correct. Added `w.rpe ?? w.r ?? 5` fallback.

---

### ✅ ISSUE-02: CTL range card uses wrong scale *(fixed 2026-03-04)*
Replaced broken bar (max 120) with 5-pill Garmin-style tier row in `stats-view.ts`.
Tiers: Beginner 0–50 / Recreational 50–100 / Trained 100–150 / Performance 150–200 / Elite 200+.
Active tier highlighted. Plain-language sentence below. Sparkline Y-axis now zooms to actual range.

---

### ✅ ISSUE-03: ⓘ info buttons don't work on iOS *(fixed 2026-03-04)*
Added `touchstart` listeners (with `preventDefault`) alongside `click` in `stats-view.ts`.
All ⓘ buttons now have 44×44pt touch targets enforced via inline style.

---

### ✅ ISSUE-04: Injury Risk shows red bar but label says "Low" *(fixed 2026-03-04)*
Bar now uses solid colour matching status label (`home-view.ts`, `stats-view.ts`). Verify on device.

---

### ✅ ISSUE-05: "This Week" card shows -74% on Tuesday *(fixed 2026-03-04)*
Baseline now prorated by day of week in `stats-view.ts`. Sub-label reads "Wednesday · week in progress".
Sat/Sun uses full baseline. -74% on Tuesday is gone.

---

### ✅ ISSUE-13: Strava pace doesn't match app *(fixed 2026-03-04)*
Root cause: `elapsed_time` used for pace instead of `moving_time` (excludes pauses).
Fixed in all three sync loops in `sync-strava-activities/index.ts`. `duration_sec` kept as
`elapsed_time` for iTRIMP (correct — total physiological time). Requires edge function redeploy.

---

### ✅ ISSUE-14: VDOT declining sharply *(fixed 2026-03-04)*
**Root cause**: Cardiac Efficiency Trend estimator (fires on week advance) computed a slower LT
from recent easy runs with declining cardiac efficiency, setting `physioAdj` negative.
Compounded by Garmin LT sync writing stale `lt_pace_sec_km` unconditionally.
**Fixes**: `physioAdj` clamped to −5.0 max. Garmin LT rejected if derived VDOT is >8pts from `s.v`.
**Note**: Existing `physioAdj` value not auto-reset — may need manual recalibration button (ISSUE-46).

---

### ✅ ISSUE-15: Session count shows wrong denominator *(fixed 2026-03-04)*
Denominator now calls `generateWeekWorkouts()` and counts all non-rest sessions including
general sport placeholders and adhoc additions. Fixed in `home-view.ts`.

---

### ✅ ISSUE-16: Skipped workouts — general fitness mode not pushing to next week *(fixed 2026-03-05)*
**Root cause**: In `continuousMode` (general fitness), second skip auto-dropped with a race-time penalty (`s.timp`) that has no meaning outside a race plan. First skip correctly pushes to next week in both modes. **Fix**: Second skip in `continuousMode` now shows a "Drop It / Keep It" confirmation dialog instead of auto-dropping. Race-time penalty only applied in race mode (`!s.continuousMode`). VDOT decline link: primarily caused by ISSUE-48 (efficiency trend), not skip logic.

---

### ✅ ISSUE-17: Deload week check-in suggested all-out effort *(fixed 2026-03-05)*
**Root cause**: `renderBenchmarkPanel` / `buildBenchmarkPanel` showed hard check-in options (threshold, speed, race sim) without gating on week type.
**Fix**: Added `isDeloadWeek` check in both `main-view.ts` and `plan-view.ts`. Benchmark panel now returns '' entirely on deload weeks — no check-in prompt shown.

---

### ✅ ISSUE-53: Moving a workout on the Plan tab does not update the Home view *(fixed 2026-03-05)*
**Root cause**: `buildTodayWorkout` and `buildNoWorkoutHero` in `home-view.ts` applied `workoutMods` but not `workoutMoves`. Today's session was found by `dayOfWeek` before moves were applied.
**Fix**: Added `workoutMoves` loop (identical to plan-view.ts) in both `buildTodayWorkout` and the "next workout" finder in `buildNoWorkoutHero`.

---

### ✅ ISSUE-54: Two "Running Fitness" sections in suggestion modal *(fixed 2026-03-05)*
**Root cause**: Resolved during 2026-03-04 jargon cleanup — runner type boilerplate and aero/anaero split sections (which included "Running Fitness" context) were removed from the modal. Current `suggestion-modal.ts` contains no duplicate "Running Fitness" block.

---

### ✅ ISSUE-55: Injury risk mismatch — elevated on Stats, Low on Home *(fixed 2026-03-04)*
**Root cause**: `buildSignalBars` in `home-view.ts` called `computeACWR` without `atlSeed`, while `buildAdvancedSection` in `stats-view.ts` inflated ATL seed by `1 + min(0.1 × gymSessions, 0.3)`. Result: gym-heavy athletes saw different ACWR values on Home vs Stats.
**Fix**: Added identical `atlSeed` calculation to `buildSignalBars` in `home-view.ts`. Both views now call `computeACWR` with the same arguments.

---

### ✅ ISSUE-57: Week of 25 Feb still shows near-zero load *(fixed 2026-03-05)*
**Root cause**: The edge function history mode always includes the current in-progress week as the last row. `fetchStravaHistory` was storing all rows (including the partial current week) into `historicWeeklyTSS`. This caused an off-by-one shift: the previous completed week appeared at the wrong position in the chart, and Fix 4's `planWeekIdx` lookup in `getChartData` missed it. **Fix**: Both `fetchStravaHistory` and `backfillStravaHistory` now filter with `r.weekStart < thisMondayISO` before storing to all historicWeekly* arrays and extendedHistory* arrays.

---

## P2 — UX / Clarity (confusing but not technically broken)

### ✅ ISSUE-06: Plan-view TSS badge → weekly summary card *(fixed)*
**Symptom**: "59 Run · 334 Total" chip in week header — users don't know what it means.
**Fix**: Replaced with a proper load progress bar (`weekLoadBar`) showing actual/planned TSS with tap-to-expand breakdown. Old chip removed.

---

### ISSUE-07: Running Fitness sparkline flat with no ranges `[ui-ux-pro-max]`
**Symptom**: Line is flat near top. CTL 182 ↓ with no context about what 182 means.

**Fix**: Zoom Y-axis to actual variation range. Add tier bands as background colours.
Show "Performance level" prominently. Add trend context: "+7 pts in 4 weeks."

---

### ✅ ISSUE-08: Training Load vs Plan bar unlabelled *(resolved 2026-03-09)*
The "More detail" section on Stats already shows `${currentTSS} / ${Math.round(plannedTSS)}` label on the Total Load vs Plan bar, plus the Distance vs Plan bar. Both bars have clear labels and actual/planned values. No additional changes needed.

---

### ✅ ISSUE-09: Injury risk and Reduce/Replace modal are disconnected *(fixed 2026-03-05)*
**Root cause**: ACWR risk caption in `home-view.ts` gave no context about what drove the spike; no top-contributor attribution.
**Fix**: `buildSignalBars()` now identifies the top-contributing activity (highest Signal B TSS) from `garminActuals` + `adhocWorkouts`. ACWR caution/high captions include the top contributor name and a "Tap to adjust your training plan" CTA that routes to the suggestion modal.

---

### ✅ ISSUE-10: Reduce/Replace modal copy is too technical *(fixed 2026-03-05)*
**Root cause**: `acwrHeader` in `suggestion-modal.ts` led with "Your ACWR is 1.45× — 21% above your 6-week baseline" — technical ratio with no human meaning.
**Fix**: Rewrote to lead with human consequence: "You've been training X% harder than usual this week. Your body needs extra recovery before your next hard effort." ACWR ratio preserved in the expandable "See details" panel. Titles changed to "Heavy training week" / "Load building up".

---

### ✅ ISSUE-18: "Hyrox" in user-facing copy *(fixed 2026-03-04)*
Replaced with "heavy load sports" in `stats-view.ts`. Sport-type constants left unchanged.

---

### ✅ ISSUE-19: Home page load bars confusing *(resolved 2026-03-09)*
Home page load bars already have: label ("Training Load (TSS)"), actual/planned values (`tssActual / tssPlan TSS`), colour coding (grey <70%, green ≤105%, amber >plan), and overflow label (+X%) when over target. The 88%-wide bar acts as the 100% reference. No further changes needed.

---

### ✅ ISSUE-20: Activity card km splits match Strava *(fixed + confirmed)*
Standalone mode uses `splits_metric` from Strava API directly (exact match). Stream-based computation retained as fallback.

---

### ✅ ISSUE-21: AI-sounding copy throughout the app *(fixed 2026-03-08)*
Rewrote recovery labels ("How are you feeling?" / "Feeling good" / "Feeling rough"), removed 🏃 emoji + "Today's planned run" → "Today", welcome-back bullets → plain sentences, wizard runner-type → direct voice.

---

### ✅ ISSUE-22: Sync jumps to home; no feedback *(fixed 2026-03-04)*
Button now shows "Syncing..." (disabled), then "Synced ✓" for 2.5s on success or "Sync failed"
on error. Does not auto-navigate. Fixed in `plan-view.ts`.

---

### ✅ ISSUE-23: "17w average" hardcoded label bug *(fixed 2026-03-05)*
Legend label already reads "Your running base" (stats-view.ts line 242). No hardcoded week count visible in current code.

---

### ✅ ISSUE-24: "Building baseline" / "Calibrating intensity zones" shown when data exists *(fixed 2026-03-05)*
**Fix**: All "Building baseline" gates raised from `< 3` to `< 4` weeks in `stats-view.ts` and `main-view.ts`. "Calibrating intensity zones" already gated on `thresh.calibratedFrom > 0` (only shows during active partial calibration).

---

### ✅ ISSUE-25: Missing "Go to current week" button *(fixed 2026-03-04)*
"→ This week" button added to `plan-view.ts`, visible when browsing past weeks. Hides on current week.
"Review this week" still pending — connected to ISSUE-06 post-week debrief card.

---

### ✅ ISSUE-26 + ISSUE-45: Week load visual bar on Plan page *(fixed 2026-03-05)*
**Root cause**: Load was shown as a text line ("Week load: 47 TSS planned · 31 so far") — hard to read at a glance.
**Fix**: Replaced text line with a visual progress bar (same style as home page) showing planned TSS vs actual TSS. Shown for current and future weeks; past weeks already show the TSS badge. Bar turns accent-coloured as the week progresses.

---

### ✅ ISSUE-27: Sync Strava button on Plan page — wrong location *(confirmed resolved)*
**Status**: Already resolved. Sync Strava lives in `account-view.ts` (rendered via `renderStravaEnrichCard` and `renderStravaStandaloneCard`). It does not appear in `plan-view.ts` or `buildPlanActionStrip`. No code change needed.

---

### ✅ ISSUE-28: Cannot edit historic weeks *(confirmed on device 2026-03-12)*
**Fix applied**:
- `data-week-num` added to "Mark Done" and "Skip" buttons in `plan-view.ts` — buttons now know which week they live in
- Click handlers pass `targetWeek` to `rate()` and `skip()` in `events.ts`
- Past week edits use a minimal path: just sets `wk.rated[workoutId]`, no VDOT/week-advance side effects
- Skip on past week = mark as skipped in-place, no push to next week
- Strava/Garmin-matched sessions stay read-only (green "Synced" badge, no buttons)
- Auto-push on "Complete week": before advancing, shows "X sessions weren't completed — Move to next week / Drop them"

---

### ✅ ISSUE-29: VDOT not tracked over time and poorly explained *(fixed 2026-03-04)*
`vdotHistory` added to state. Sparkline + change note + ⓘ explanation added to stats-view.ts.

---

### ✅ ISSUE-46: VDOT physioAdj reset button *(fixed 2026-03-04)*
"Reset VDOT calibration" button added to Advanced card in `account-view.ts`.
Sets `physioAdj = 0`, saves state, shows 3s confirmation. Real fix is ISSUE-48.

---

### ✅ ISSUE-48: Cardiac Efficiency Trend fires incorrectly on easy runs *(fixed 2026-03-05)*
**Root cause**: Efficiency data collection in `events.ts` did not check HR zone — recovery runs (<Z2) and aerobic-threshold runs (>Z2) polluted the trend. **Fix (1)**: Added Z2 gate in `recordEfficiencyPoint` call — only records when `avgHR` is within `effZones.z2.min..z2.max × 1.05`. **Fix (2)**: Added `totalImprovementPct < 0.10` guard in `estimateFromEfficiencyTrend()` — ignores week-to-week variance of <10%. CEI = pace/HR was already correct (lower = more efficient). physioAdj clamp (-5.0) remains as safety net.

---

### ✅ ISSUE-49: docs/MODEL.md *(written 2026-03-04)*
See `docs/MODEL.md` — covers VDOT, physioAdj, Signal A/B/C, iTRIMP, CTL/ATL/TSB, ACWR.
Includes "why does X look wrong?" quick-reference table.

---

### ✅ ISSUE-50: Load chart footnote missing *(already present)*
Footnote `"History from Strava · current week includes all training at full physiological weight"` is already rendered at line 265 of `stats-view.ts:buildLoadHistoryChart`. No code change needed.

---

### ✅ ISSUE-51: Cross-training load management v2 *(fixed 2026-03-08)*
All 4 bugs confirmed resolved by code inspection:
1. Blocking modal now only fires at Tier 3 (ACWR caution/high) — `activity-review.ts:1524-1538`
2. Tier 1 (auto-absorb <15 TSS) and Tier 2 (nudge card 15–40 TSS) implemented in `excess-load-card.ts`
3. Excess card surfaces carry-over items on-demand via "Adjust Plan" button
4. Timing sensitivity: `mergeTimingMods()` wired in `activitySync.ts:52`, `timing-check.ts` fully built

---

### ✅ ISSUE-52: Signal B weekly baseline — edge function gap *(fixed 2026-03-04)*
**Problem**: `historicWeeklyRawTSS` (raw iTRIMP per week, no runSpec) doesn't exist.
The Strava edge function `history` mode returns Signal A (runSpec-discounted) only.
Until fixed, Tier 1/2 excess thresholds have no accurate baseline to compare against.

**Fix**: New `sport-history` mode on `sync-strava-activities` edge function.
Groups `garmin_activities` by week, sums raw iTRIMP, returns `weeklyRawTSS[]` + per-sport breakdown.
**Fallback**: Signal A × 1.4 proxy (conservative) until this ships.

**Files**: `supabase/functions/sync-strava-activities/index.ts` + state field
`historicWeeklyRawTSS` in `src/types/state.ts`.

---

### 📌 ISSUE-47: What-if sandbox / training scenario simulator *(scoped — ON HOLD)*
**Confirmed design:**
- Entry: dedicated "Sandbox" tab opened from Stats page
- Read-only: never touches the real plan
- Real-time recomputation as sliders change

**Toggleable inputs (5 sliders/controls):**
1. Weekly km — volume modifier (e.g. 30–90km range)
2. Pace — faster/slower than plan (% modifier, e.g. −10% to +15%)
3. Perceived difficulty — how hard sessions feel (RPE 1–10 slider)
4. HR above/below expected — modifier on HR data (affects efficiency/VDOT estimation)
5. Weeks until race — countdown (affects taper logic and peaking point)

**Outputs that update in real time:**
- Projected race time
- VDOT trajectory (sparkline forward)
- CTL/fitness curve projection
- Injury risk (ACWR projection)

**Architecture**: New `src/ui/sandbox-view.ts`. Takes current `AppState` as baseline, creates
a simulated copy with modifications applied, runs forecast functions against the sim state.
No writes to actual state. A "Reset to current plan" button restores defaults.

**Fix**: Add VDOT sparkline over plan weeks. Add a tap-to-explain tooltip: "VDOT is a measure
of your running fitness — higher means faster across all distances." Flag suspicious drops.

---

### ✅ ISSUE-30: Load metrics have no reference point *(resolved 2026-03-09)*
Stats Recovery and Progress cards now have position bars with zone labels (Fresh/Neutral/Fatigued, tier labels for CTL). VDOT sparkline shows progression. Position bars provide sufficient context — no additional copy needed.

---

### ✅ ISSUE-31: No KM/Mile toggle *(fixed 2026-03-05)*
**Fix**: Added `unitPref: 'km' | 'mi'` to `SimulatorState`. Added `formatKm(km, pref, decimals)` utility to `src/utils/format.ts`. Added "Preferences" card in `account-view.ts` with km/mi segmented control. Updated distance displays in `home-view.ts` (weekly distance bar), `stats-view.ts` (distance card, Distance vs Plan bar, Running km label), and `activity-detail.ts` (Distance stat). Toggle persists in state, re-renders on change.

---

### ✅ ISSUE-32: Phases have taken a back seat — not visible in plan *(fixed 2026-03-05)*
**Root cause**: Phase label was rendered as faint uppercase text alongside the date range — same styling, easy to miss.
**Fix**: Phase now renders as a colour-coded badge (blue=Base, orange=Build, red=Peak, green=Taper) in the plan week header, next to the date range. `phaseBadge()` helper added to `plan-view.ts`.

---

## P3 — New Features / Future

### ISSUE-201: Race day is rendered as a generic taper week (running + tri + hyrox) *(P2, 2026-05-12)*
**Observation (from post-race audit)**: race week falls out of the phase machine as a taper week. There is no race-day-specific session prescription. For running, this is acceptable (a rest or 20 min shakeout fits inside taper). For triathlon, race day should specifically prescribe a short swim + spin + jog warmup, not whatever the taper sequence places there. For HYROX, race day should be 20 min easy run + brief station familiarity, not a hard taper workout. Risk: athletes following the plan literally do a normal taper workout on race morning.
**Fix sketch**: Add `computeRaceWeek()` to each plan engine that detects `wk.w === s.tw` and `wkDay === raceDayOffset` and substitutes a race-day-specific micro-session. Constants live in `triathlon-constants.ts` / `hyrox-constants.ts`. Running's taper already handles this acceptably; tri + hyrox are the priorities.
**Files**: `src/workouts/plan_engine.triathlon.ts`, `src/workouts/plan_engine.hyrox.ts`.

### ISSUE-202: Race-complete banner offers only "Switch to tracking", no "New Plan" CTA *(P2, 2026-05-12)*
**Observation**: `buildRaceCompleteBanner` in `src/ui/home-view.ts:565-594` shows after the race date passes, but only offers a single CTA — downgrade to tracking. To set a new race or start the next training cycle, the user has to navigate Account → wizard. The natural moment to ask "what's next" is right here.
**Fix sketch**: Add a primary "Plan next race" CTA next to the existing "Switch to tracking" button. Route to the appropriate wizard step based on `s.eventType` (running → marathon picker; tri → triathlon picker; hyrox → hyrox event picker). Keep the dismiss X.
**Files**: `src/ui/home-view.ts:581-594`, plus a wire-up in the home event handlers.

### ISSUE-203: The race itself is not modelled as a fatigue spike *(P3, 2026-05-12)*
**Observation**: when the race-day activity syncs, it contributes TSS / iTRIMP naturally through the matcher, so CTL/ATL do update. However, the recovery countdown and Today's Load detail don't recognise "you just raced" as a categorically different event from "you just trained hard". A user who finished a marathon yesterday sees the same recovery countdown shape as someone who finished a long run yesterday.
**Fix sketch**: When `runRaceLog` / `hyroxConfig.raceLog` / `triConfig.raceLog` gets a new entry for `dateISO === today − 1`, surface a "Race recovery" banner that shows a longer-than-usual recovery window (e.g. 2× normal for marathon, 3× for IM). Don't double-count TSS — this is a UX overlay, not a model change.
**Files**: `src/ui/recovery-view.ts`, possibly a new `race-recovery-banner.ts`.

### ISSUE-204: Running + HYROX race-outcome retro UI surface not built *(P3, 2026-05-12)* ✅ FIXED 2026-05-18
**Fix shipped**: `buildRunRaceOutcomeRetroCard` added to `src/ui/race-forecast-view.ts` (above hero ring), `renderHyroxRaceOutcomeRetroCard` added to `src/ui/hyrox/forecast-view.ts` (above forecast body). Both mirror tri's `renderRaceOutcomeRetroCard` pattern — green-tinted card, "You beat your prediction/target by X" headline, predicted/target vs actual sub-line, ≥60s gate. Running compares against `runRaceLog[i].predictedTotalSec`; HYROX compares against `hyroxConfig.raceLog[i].targetTotalSec` (HYROX has no cached prediction, so the target is the comparison anchor). Cycling-only retro deferred as ISSUE-224. HYROX station-level retro deferred as ISSUE-223. Pending Tristan verification on device.

---

### ISSUE-132: Garmin daily steps as background load signal in Today's Load *(P3)*
**Motivation**: A rest day with 18,000 steps is physiologically different from a sedentary rest day. Steps are a proxy for non-structured activity (standing, walking, general movement) that contributes meaningfully to daily fatigue but isn't captured by structured training alone.
**Design**:
- Pull `totalSteps` from the Garmin Health API dailies endpoint (already partially wired via `syncPhysiologySnapshot` — confirm field availability).
- Convert to a Signal B contribution: steps × a per-step load factor (TBD — do not invent; confirm with Tristan once data lands).
- Show as a "Steps" placeholder card on the Today's Load detail page until Garmin data is available. When available, replace placeholder with actual step count and TSS contribution.
- Do not include steps in Signal A (running fitness) — steps are background load only.
**Files**: `supabase/functions/sync-physiology-snapshot/index.ts`, `src/types/state.ts` (add `dailySteps?` to `PhysiologyDayEntry`), `src/ui/strain-view.ts`.
**Blocked by**: Garmin steps pull not yet implemented.

---

### ✅ ISSUE-133b: Freshness and Injury Risk detail pages — parity with Recovery *(confirmed 2026-04-23)*
**Fix**: Both detail pages already built — `freshness-view.ts` and `injury-risk-view.ts` — with Recovery-parity design language (sub-score rows, sparklines, plain-language advice). Confirmed on device.
**Files**: `src/ui/freshness-view.ts`, `src/ui/injury-risk-view.ts`.
**Note**: This issue was numbered 133 alongside the HR-drift ISSUE-133. Suffixed as 133b during 2026-04-18 triage to disambiguate.

---

### ISSUE-115: Holiday mode *(P3)* — IMPLEMENTED, bugs fixed 2026-04-09
**Status**: Feature fully built. Audit on 2026-04-09 found and fixed: bridge mods wiped on app restart (main.ts cleanup too aggressive), forceDeload flags not cleaned on short-holiday cancel or manual end, hardcoded km units in session chooser (now uses formatKm/formatPace), pre-holiday shift range off by one, parseKmFromDesc returning warm-up km instead of total for structured descriptions.
**Files**: `src/ui/holiday-modal.ts`, `src/main.ts`, `src/ui/plan-view.ts`, `src/ui/home-view.ts`, `src/ui/checkin-overlay.ts`, `src/types/state.ts`.

---

### ISSUE-123: HR zones / LT threshold should auto-pull from Garmin, not require manual input *(P2)*
**Symptom**: HR threshold and zone boundaries are currently entered via a manual input button. Users don't know their LT HR and won't enter it — so zones default to generic estimates.
**Root cause**: The Garmin Health API returns `lactateThresholdBpm` in the physiology/dailies endpoint. This is already the correct value; we just aren't reading it automatically.
**Design**:
- On Garmin connect / first sync: auto-populate `lt_hr`, HR zones, and max HR from the Garmin physiology endpoint. No user action required.
- Show the pulled values as read-only in Account (e.g. "LT HR: 162 bpm — from Garmin").
- Provide a manual override toggle: "Override Garmin value" — exposes the input field. User-entered value takes precedence.
- If Garmin returns no value and no manual entry exists, fall back to age-based estimate (current behaviour) and label it "Estimated".
**Files**: `supabase/functions/sync-physiology-snapshot/index.ts` (read `lactateThresholdBpm`), `src/ui/account-view.ts` (display + override toggle), `src/state/store.ts` (source field: `'garmin' | 'manual' | 'estimated'`).

---

### ISSUE-116: Email Garmin for Auth API access *(P2 — external action required)*
**Context**: Garmin's Health API requires OAuth2 partner approval. Current implementation may rely on a workaround or limited-access token that could break.
**Action needed**: Email Garmin developer support to formally request Health API partner access and OAuth2 credentials. This is a business/admin task, not a code task.
**Impact if not done**: Garmin sleep, HRV, and dailies sync (ISSUE-76, ISSUE-105) are at risk if the current auth approach is outside approved use.

---

### ✅ ISSUE-117: "Preview week" copy should say it will be based on last week *(P2, fixed 2026-05-11)*
Changed the future-week banner from "Draft. Final workouts depend on the preceding week's performance." to "Estimated from last week's load. Sessions and distances adjust as you train." `plan-view.ts:2602`.

---

### ISSUE-118: Be more explicit about load matching *(P2)*
**Symptom**: When a Strava/Garmin activity is matched to a planned session, users don't understand what "matched" means — did it count? Was the load accepted? How does it affect the plan?
**Design**: On matched activity cards, add a brief explanation: e.g. "Matched to Tuesday's run — load counted toward your week." If a session was over/under target, show a one-line delta: "12% harder than planned." This closes the loop for users who wonder if the sync did anything.
**Files**: `src/ui/plan-view.ts`, `src/ui/activity-review.ts`.

---

### ISSUE-119: Onboarding "how it works" screen — deferred *(P3, 2026-05-11)*
The current wizard already gates Strava connection behind goal/name setup and the review step shows what was inferred from history. A standalone "how it works" screen at wizard entry is standard onboarding padding — the highest-friction moment to add text. Better addressed via first-use contextual tooltips inside the app when/if retention data shows users are confused. Downgraded to P3.

---

### ISSUE-120: Check-in button — includes illness, injury, and general feeling *(P3)*
**Symptom**: There is no lightweight daily check-in for subjective wellbeing. The app has no way to know if a user is ill, injured, or just feeling flat — it can only infer from HR and load data.
**Design**: A daily check-in button on the Home screen (optional, soft nudge). Options: "Feeling good / Feeling okay / Feeling rough / Ill / Injured." If "Ill" or "Injured": surfaces ISSUE-37 illness mode or a rest-day suggestion. If "Rough": adjusts today's session intensity with a soft note. Check-in data stored in state; feeds into ACWR/readiness commentary.
**Files**: `src/ui/home-view.ts`, `src/state/store.ts` (daily check-in field), `src/calculations/readiness.ts`.

---

### ISSUE-121: Zone 2 explainer — what Kipchoge's Z2 looks like and why it matters *(P3)*
**Design**: Add a contextual info button ("ⓘ") above the Zone 2 section in Stats HR zones chart. Tapping it opens an inline explanation:
- What Zone 2 actually feels like (conversational pace, nasal breathing)
- Why it's the foundation of aerobic fitness (fat oxidation, mitochondrial density)
- The Kipchoge angle: elite athletes do 80%+ of volume in Z2 — but paired with structured tempo work
- Caution: Z2 alone without quality sessions plateaus quickly
Keep it short (4–5 sentences). Tone: coaching, not lecture.
**Files**: `src/ui/stats-view.ts` (HR zones chart section).

---

### ISSUE-122: Onboarding should ask for training goals *(P3)*
**Symptom**: Onboarding asks for current fitness level and race target but never asks *why* the user is training. A user training for Hyrox has completely different needs from someone who just wants to get fit or lose weight.
**Design**: Add a goal-selection step in the wizard. Options (multi-select allowed):
- Run faster (speed)
- Run further (distance / endurance)
- Get fit / improve health
- Just run (no specific goal)
- Build strength
- Get in shape / lose weight
- Hyrox
- Triathlon
Selected goals influence: plan tone/copy, cross-training weighting, benchmark suggestions, and coaching language. Hyrox/Triathlon selections unlock sport-specific load logic.
**Files**: `src/ui/wizard/` (new goal step), `src/state/store.ts` (goals field), `src/types/state.ts`.

---


### ✅ ISSUE-34: RPE → pacing logic *(resolved 2026-03-09, merged into ISSUE-60)*
RPE capture was already built (`wk.effortScore`, `wk.rated`, `wo.rpe`). Week-end debrief (ISSUE-60) surfaces effortScore and offers rpeAdj pacing adjustment. No new capture screen built — existing per-session RPE rating is the input.

---

### ISSUE-35: HR vs expected HR — use to adjust future workouts *(Build 1+2+3 ✅ ALL COMPLETE)*
**Design confirmed (2026-03-11)**:

**Build 1 — HR Effort + Pace Adherence Signal** ✅ COMPLETE (2026-03-12):
- `computeHREffortScore()` compares avgHR to target HR zone → `hrEffortScore` on GarminActual
- `computePaceAdherence()` compares actual pace to VDOT target → `paceAdherence` on GarminActual
- Blended into `wk.effortScore`: quality sessions weight pace 35%, easy runs 15%, HR fills the rest
- Enrichment backfill adds both scores to existing actuals on next sync
- Future weeks show adaptive note with context-aware detail
- All 8 plan engine factors verified wired and composing correctly

**Build 2 — HR Drift** ✅ COMPLETE (2026-03-12):
- `computeHRDrift()` in `stream-processor.ts` + inline in edge fn
- Strips 10% warmup, splits in half, compares avg HR. Requires ≥20 min + ≥60 valid HR points.
- Only computed for DRIFT_TYPES (running variants). Stored in DB `hr_drift` column + `GarminActual.hrDrift`.
- Drift > 5% on easy/long adds bonus to effort score (capped +1.0 RPE-equiv). Surfaced in adaptive note.
- Migration: `20260312_hr_drift.sql`. Edge fn needs redeploy.

**Build 3 — Intelligent Workout Commentary** ✅ COMPLETE (2026-03-12):
- `generateWorkoutInsight()` in `src/calculations/workout-insight.ts` — rules-based priority system, coaching/direct tone, 2–3 sentences
- Picks top 2-3 insights by priority from: pace adherence (quality vs easy), HR effort score, HR drift, split consistency (CV, negative split, late fade), HR zone distribution
- Rendered as "Coach's Notes" card on activity detail screen (below training load, above stats grid)
- All activity types — runs get full analysis, cross-training gets HR effort + load commentary
- Only shows when there's something useful to say (no empty/generic filler)

**Dependency chain**: Build 1 → Build 2 (enriches effort score) → Build 3 (consumes all signals)

**Deploy checklist (Build 1+2):**
1. `supabase db push` (or run `20260312_hr_drift.sql` manually) — adds `hr_drift` column
2. `supabase functions deploy sync-strava-activities --project-ref elnuiudfndsvtbfisaje`
3. Build + deploy client (`npx tsc && npx vite build`)

**Testing (not yet verified on device):**
- [ ] Sync a Strava run → check localStorage `wks[N].garminActuals[workoutId]` has `hrEffortScore`, `paceAdherence`, and `hrDrift` (drift only on runs ≥20 min)
- [ ] View a future week in Plan tab → should see adaptive note card below the header
- [ ] Run 2–3 weeks with data → compare workout durations week-to-week. If you consistently ran harder than planned, future weeks should show slightly shorter durations (up to 15% via effortMultiplier)
- [ ] Deliberately run a threshold session slower than target pace → on next week advance, effort score should reflect it and scale down next week's sessions
- [ ] Check edge fn logs for `[Backfill]` / `[Standalone]` — `hr_drift` should appear in upserts
- [ ] Tap into a completed run → "Coach's Notes" card should appear below training load with 2-3 sentences
- [ ] Tap into a cross-training activity → should see HR effort commentary (if HR data exists)
- [ ] Tap into an activity with no HR/pace data → no Coach's Notes card (graceful absence, not empty card)

**UX note:** With Build 3 complete, all three signals (HR effort, pace adherence, HR drift) are now user-visible via "Coach's Notes" on the activity detail screen. The adaptive note on future weeks (Build 1) + commentary on past workouts (Build 3) together make the system's intelligence transparent.

---

### ✅ ISSUE-36: Garmin sleep data — edge function needed *(superseded by ISSUE-76)*
**Fix**: `garmin-backfill/index.ts` fetches sleep data from Garmin Health API (`/wellness-api/rest/sleeps`) and upserts into `sleep_summaries`. Built as part of ISSUE-76 (Garmin historic backfill).

---

### ✅ ISSUE-37: Illness mode *(fixed)*
**Fix**: Full illness mode built. `illness-modal.ts` for flagging illness, `illnessStart` tracked in state, illness banners in home-view and plan-view with severity badges ("Still running" / "Full rest"), "Recovered" button clears state.

---

### ✅ ISSUE-38: Race simulator / race mode inaccessible *(resolved)*
**Fix**: Race simulation is accessible via the benchmark picker in `events.ts` (gated behind experience level, hidden for beginner/novice). ISSUE-71 removed the standalone Stats button as intended. Entry point now lives in the check-in flow.

---

### ✅ ISSUE-40: Edit week entry point needs rethinking *(fixed 2026-03-08)*
Resolved by ISSUE-28 fix: ✎ button moved from current week to past week headers.

---

### ✅ ISSUE-41: HR analysis of completed workouts should inform future session intensity *(merged into ISSUE-35, all builds complete)*
**Fix**: All 4 functions built and wired: `computeHREffortScore` (heart-rate.ts), `computePaceAdherence` (activity-matcher.ts), `computeHRDrift` (stream-processor.ts), `generateWorkoutInsight` (workout-insight.ts). Imported and active in renderer.ts and activity-detail.ts.

---

### ✅ ISSUE-42: TSS showing 97/90 after one tennis session *(fixed 2026-03-05)*
**Root cause**: Off-by-one in historicWeeklyTSS (current partial week included, shifting all entries). Combined with ISSUE-68 dedup fix. Both resolved by ISSUE-57 fix.

---

### ✅ ISSUE-43: Historic week view should show actual activity days, not planned layout *(fixed 2026-03-08)*
**Symptom**: Once a week is matched and completed, the plan view still shows the original planned
session slots rather than which day you actually did each activity.
**Fix**: For completed past weeks, render activities on the day they were actually performed
(use activity date from `adhocWorkouts` or matched session), not the planned day.

---

### ✅ ISSUE-44: Race time forecast display on Stats *(fixed 2026-03-08)*
Collapsible "Forecast times" section added to Stats Advanced area. Shows 5K, 10K, Half, Marathon times from VDOT. Gated on ≥4 weeks of data. Combined with ISSUE-62.

---

### ✅ ISSUE-45: Week load on plan page should be a bar, not a text line *(fixed 2026-03-05, combined with ISSUE-26)*

---

### ✅ ISSUE-56: "Reduce one session" language replaced with load-based copy *(fixed 2026-03-05)*
**Fixed locations**:
- `stats-view.ts`: "High load this week. Consider swapping one session for rest." → "Shorten or ease your remaining sessions."
- `suggestion-modal.ts`: "Consider reducing at least one session." → "Consider reducing intensity or duration of remaining sessions."
- `home-view.ts`: "Reduce one session this week." → "Shorten or ease remaining sessions."

---

### ✅ ISSUE-58: Sleep card on Home → build dedicated Recovery section *(resolved 2026-03-08)*
Recovery system was already fully built. Blocker was expired Garmin token (ISSUE-70). Now that token refresh is implemented (Group A), sleep/HRV data will flow again and recovery ring, recovery modal, and readiness sub-score all activate automatically. Verify after deploying garmin-refresh-token edge function.

---

### ✅ ISSUE-59: Maintenance gym session on Home — not expandable, poorly labeled *(fixed 2026-03-05)*
Gym workout names now get "Gym Session" appended if not already present. Exercises (from `d` field, newline-separated) render as a `<details>` expandable list in the Home card.

---

### ✅ ISSUE-39: Welcome back message shows incorrectly *(fixed 2026-03-05)*
**Root cause**: `WELCOME_BACK_MIN_HOURS` was 20, allowing the modal to fire if the user opened the app less than 24h before the week rolled over.
**Fix**: Raised `WELCOME_BACK_MIN_HOURS` from 20 → 24 in `welcome-back.ts`. Modal also gated on daily calendar key and actual missed-week detection (returns 0 if still in current week).

---

### ✅ ISSUE-60: Week-end debrief *(fixed 2026-03-09, ISSUE-34 merged)*
`src/ui/week-debrief.ts` built. Shows phase badge + "Week N complete", load % vs planned, distance, CTL delta, effort pacing adjustment (reads `wk.effortScore`, applies `rpeAdj` adjustment capped at ±0.5 VDOT). "Finish week" button added to plan page current week header. Auto-triggers on app open after week advance (guarded by `lastDebriefWeek`).

---

### ISSUE-61: LT pace / VDOT improvement should update race forecast and plan *(logged 2026-03-04)*
**Symptom**: If a user's LT pace or VDOT improves (detected from Strava or Garmin), there's no mechanism to update the race forecast time or re-pace future sessions.
**Design**: When VDOT changes by >2pts, recalculate race time estimate and offer to re-pace the remaining plan. Confirmation-gated — never auto-changes paces without user input.
**Priority**: P3 — significant build, depends on ISSUE-48 (efficiency trend algorithm fix) being stable first.

---

### ✅ ISSUE-62: Race time forecast in general fitness mode *(fixed 2026-03-08)*
Combined with ISSUE-44. "Forecast times" collapsible section added to Stats page. Shows 5K, 10K, Half, Marathon. Gated on ≥4 weeks data. Copy: "Based on your current fitness".

---

### ✅ ISSUE-63: HR-based ATL inflation for gym sessions *(fixed)*
**Fix**: `computeWeekRawTSS` in fitness-model.ts uses actual `iTrimp` values from every activity including gym/cross-training, normalised via `normalizeiTrimp`. Gym sessions with HR streams feed directly into ATL. The flat-percentage multiplier path is now only an additive adjustment for check-in recovery debt and ACWR overrides, not a replacement for iTRIMP accounting.

---

### ✅ ISSUE-64: Production build blocked — 42 TypeScript errors *(fixed 2026-03-05)*
**Root cause**: Multiple sources: (1) `src/scripts/` and `src/testing/` not excluded from tsconfig so offline audit scripts were compiled; (2) `import.meta.env` lacked type declarations (missing `vite-env.d.ts`); (3) `InjuryType` narrowed after tests were written (`'overuse'` removed, `'general'` added); (4) `'passed'` not in `Workout['status']` union (dead code path); (5) `window.rateCapacityTest` not in `Window` interface declaration; (6) ~60 lines of unreachable code in `initializing.ts` after early `return` caused null-index errors.
**Fix**: Added `tsconfig.json` exclude for scripts/testing; created `src/vite-env.d.ts`; updated test fixtures to `type: 'general'` and `'pain_free_walk'`; cast `(w as any).status === 'passed'` in renderer; added `rateCapacityTest` to Window interface; deleted unreachable block in `initializing.ts`.

---

### ✅ ISSUE-65: GPS split scheme — per-km splits never shown during runs *(fixed 2026-03-05)*
**Root cause**: `buildKmSplits()` was defined in `split-scheme.ts` but never called. Simple distance (`"8km"`) and distance-at-pace (`"20km @ MP"`) branches both returned a single segment instead of per-km splits. Progressive runs had per-km splits for the fast portion but a single block for the easy portion. A general `Xkm [description]` catch-all was also missing.
**Fix**: Wired `buildKmSplits()` into simple distance, dist@pace, progressive easy portion, and added a `/^(\d+\.?\d*)km\b/i` catch-all for descriptions like "5km warmup jog". All 5 failing tests now pass (714 total, 0 failures).

---

### ✅ ISSUE-66: ACWR atlSeed missing from 9 of 12 call sites *(fixed 2026-03-05)*
**Root cause**: ISSUE-55 fix applied `atlSeed` (gym-inflation correction) only to `buildSignalBars` in `home-view.ts`. Nine other `computeACWR` call sites — including the "On Track" status pill, click-handler routing, Stats trend sentence, reduce/replace modal trigger, ACWR inline panel, load bar zones, week-complete handler, and activity-review gating — computed ACWR without the correction.
**Fix**: Added `atlSeed = ctlBaseline × (1 + min(0.1 × gymSessions, 0.3))` before all 9 missing call sites across `home-view.ts`, `main-view.ts`, `stats-view.ts`, `renderer.ts`, `events.ts`, `activity-review.ts`. Also added missing `planStartDate` to `stats-view.ts:428`.

---

### ✅ ISSUE-67: Recovery bar direction inverted *(fixed 2026-03-05)*
**Root cause**: `home-view.ts` used `width: ${100 - recoveryPct}%` — good sleep (85%) showed a narrow 15% bar; bad sleep (30%) showed a wide 70% bar. Combined with the green→red left-to-right gradient, poor recovery appeared as a wide green bar.
**Fix**: Changed to `width: ${recoveryPct}%`. Wide = good, narrow = poor.

---

### ✅ ISSUE-68: `computeWeekTSS` (Signal A) missing garminId deduplication *(fixed 2026-03-05)*
**Root cause**: `computeWeekRawTSS` (Signal B) deduplicated via `seenGarminIds` Set to prevent double-counting activities in both `garminActuals` and `adhocWorkouts`. `computeWeekTSS` (Signal A) had no such dedup, so matched runs that also appeared as adhoc entries could inflate Signal A TSS — plausible root cause of ISSUE-42/57.
**Fix**: Added identical `seenGarminIds` dedup logic to `computeWeekTSS`, mirroring the pattern from `computeWeekRawTSS`.

---

### ✅ ISSUE-69: Suggestion modal ACWR details panel always visible *(fixed 2026-03-05)*
**Root cause**: `suggestion-modal.ts:222` had inline style `display:none;...;display:flex` — the second declaration immediately overrode the first, so the panel was always shown. The "See details" toggle did nothing on first load.
**Fix**: Removed `display:none;` from the inline style, keeping `display:flex` as the default. The toggle JS handles visibility.

---

### ISSUE-11: Auto-slot cross-training load before week completes
**Design**: When Signal B load is below weekly target AND user has unused cross-training capacity,
suggest adding a session. Non-blocking nudge card.

---

### ISSUE-12: Day-before impact warning (Signal C)
**Status**: Deferred. Connected to ISSUE-09.

---

### ISSUE-71: Remove "Simulate Race" button from Stats *(P2)* — ✅ FIXED 2026-03-09
**Fix**: Deleted `buildRaceSimulatorEntry()` and click handler from `stats-view.ts`.

---

### ISSUE-72: Stats page "Your Numbers" should split into Recovery vs Running *(P1)* — ✅ FIXED 2026-03-09
**Fix**: Split into **Progress card** (Running Fitness CTL + VDOT) and **Recovery card** (Freshness TSB + Short-Term Load ATL + Load Safety ACWR). Both always visible, no accordion needed.

---

### ISSUE-73: "Dig Deeper" and "Your Numbers" hierarchy is confusing *(P1)* — ✅ FIXED 2026-03-09
**Fix**: Killed "Dig Deeper" accordion — Distance and Zones charts promoted as tabs in the main chart card alongside Load. "Your Numbers" replaced by Progress + Recovery cards (ISSUE-72). Remaining advanced content under a "More detail" toggle.

---

### ISSUE-74: Running Fitness and VDOT info (i) buttons don't work *(P1)* — ✅ FIXED 2026-03-09
**Fix**: Added inline info boxes in `buildOnePositionBar()` so (i) buttons toggle the explanation text directly below the bar.

---

### ISSUE-75: Running fitness appears to improve despite no recent running *(P2)* — ✅ FIXED 2026-03-09
**Fix**: `wkGain` adherence now only counts running workouts (filters out gym/cross-training names via `NON_RUN_KW` list in `events.ts`).

---

### ✅ ISSUE-76: Garmin historic HR/sleep backfill *(fixed 2026-03-09)*
`supabase/functions/garmin-backfill/index.ts` built. Pulls dailies (resting HR, max HR, HRV, stress, VO2max), sleep scores, and HRV from Garmin Health API for N weeks. Upserts into `daily_metrics` + `sleep_summaries` (idempotent). Called from `triggerGarminBackfill()` in `supabaseClient.ts` on both Garmin-only and Strava+Garmin startup paths.
**Pipeline fix (2026-03-09)**: `sync-physiology-snapshot` had a `const days` variable shadowing bug (Deno runtime crash). Fixed by renaming to `mergedDays`. Also added explicit `user_id` filters to all DB queries (defense in depth alongside RLS) and diagnostic logging. Column names confirmed to match `garmin-backfill` write schema.

---

### ISSUE-77: Activities not sorted by time within a week *(P1)* — ✅ FIXED 2026-03-09
**Fix**: Sort activities by `garminActual.startTime` descending in `plan-view.ts`.

---

### ISSUE-78: "952% of my week" — prorated baseline broken on Monday *(P1)* — ✅ FIXED 2026-03-09
**Fix**: "This Week" card now shows progress as "X% · actual/target TSS" using Signal B baseline (weekly average). Resets each Monday — always current week actual vs full weekly target.

---

### ISSUE-79: plannedTSS is not based on historic load *(P1, architectural)* — ✅ FIXED 2026-03-09
**Fix**: New `computePlannedWeekTSS()` in `fitness-model.ts` — uses MEDIAN of `historicWeeklyTSS` as baseline (not EMA), with tier-aware phase multipliers. Wired into stats-view, plan-view, and home-view. See PRINCIPLES.md §Planned Load Model.

---

### ✅ ISSUE-81: Remove welcome-back modal *(fixed 2026-03-09)*
`showWelcomeBackModal` trigger removed from `main.ts`. `detectMissedWeeks()` + `recordAppOpen()` still called. `welcome-back.ts` file preserved (its state logic may still be referenced) but modal never fires.

---

### ✅ ISSUE-80: Recovery score bar in Stats Recovery card *(fixed 2026-03-09)*
`computeRecoveryScore()` added to `readiness.ts` — HRV 45% / Sleep 35% / RHR 20%, all relative to user's 28-day personal baseline. `buildRecoveryCard()` in `stats-view.ts` shows position bar + clickable sub-bars (Sleep, HRV, Resting HR with sparklines). Gated on `hasData` (≥3 days of `physiologyHistory`). Shows "Connect a watch" placeholder when no data.

---

### ✅ ISSUE-82: "How are you feeling?" check-in is mandatory, should be optional *(fixed 2026-03-09)*
**Fix**: Removed auto-triggered `showRecoveryLogModal()` from startup. The `checkRecoveryAndPrompt` function no longer shows a manual check-in when no Garmin data exists — it silently returns. Both startup `checkRecoveryAndPrompt()` calls removed from `main.ts`.

---

### ✅ ISSUE-83: TSS value looks wrong — shows 107% / 245/330 *(resolved 2026-03-09, shared root cause with ISSUE-85)*
**Root cause**: The inflated numbers shared a root cause with ISSUE-85 — cross-training iTRIMP was accumulated into `wk.actualTSS` without runSpec discount, and `computeWeekTSS` returned the cached (corrupted) value. The ISSUE-85 fix (always recompute from raw data, apply runSpec) resolves this. Signal B computation path (used by home "This Week" card) was audited and found correct: dedup in place, same signal both sides (D4), `signalBBaseline` from proper edge fn average.

---

### ✅ ISSUE-84: HR zones chart is visually ugly *(obsolete — chart removed)*
**Status**: The standalone HR zones chart no longer exists in `stats-view.ts`. Zone data is shown as compact inline bars in activity detail only. Original issue is moot.

---

### ✅ ISSUE-85: Running Fitness (CTL) shows 222 — inflated, not calibrated to real athlete level *(fixed 2026-03-09)*
**Symptom**: User has a 3:12 marathon (solidly recreational/trained), but CTL reads 222 which the tier system labels as "Elite" (200+). This is wrong and erodes trust in the whole fitness model.
**Root cause (hypotheses)**:
1. CTL computed from raw iTRIMP without proper normalisation — 1 hour of backcountry skiing or Hyrox inflates it disproportionately relative to running
2. `CTL_DECAY` constant may be too slow, causing CTL to accumulate without decay
3. `historicWeeklyTSS` baseline fed into CTL includes Signal A values (runSpec-discounted) in some paths and raw Signal B in others — inconsistency inflates the number
4. VDOT-to-CTL expected range: a 3:12 marathoner (~VDOT 48–52) would have CTL ~60–90 in a trained training block, not 222
**Action**: Audit the CTL EMA computation in `fitness-model.ts`, verify `CTL_DECAY` (`e^(-7/42)`), check which signal feeds `ctlBaseline`, and review tier thresholds — they may need recalibration against real runner populations.
**Impact**: High — CTL feeds athlete tier, ACWR baseline, plannedTSS, and cross-training tier thresholds. A 222 CTL corrupts all downstream calculations.

---

### ✅ ISSUE-86: Reduce/Replace recommendation is wildly disproportionate to stated load *(fixed 2026-03-12)*
**Root cause (bug 1 — misleading headline)**: `pctAbove` was computed as `(ratio/safeUpper − 1) × 100` — the excess above the safety ceiling, not above baseline. "2% above your normal load" actually meant 2% above the 1.6× ceiling (i.e. 63% above baseline). Rule 1 zoneAdvice had the same error.
**Root cause (bug 2 — oversized cut)**: Synthetic activity duration had a `Math.max(20, …)` floor. A 3% ceiling overshoot (6 TSS excess) computed 7 min, got bumped to 20 min, inflating the load budget ~3× and pushing the cut near the 40% cap.
**Fix (bug 1)**: Added `pctAboveBaseline = Math.round((ratio − 1) × 100)` in `suggestion-modal.ts`. `humanConsequence` now references baseline, not ceiling. When pctAboveCeiling ≤ 5%, copy reads "Your load is just above the safe ceiling (1.63× vs 1.60×). A small adjustment is enough." Rule 1 zoneAdvice updated to use baseline %.
**Fix (bug 2)**: Changed floor from `Math.max(20, …)` → `Math.max(5, …)` in `main-view.ts` — keeps cut proportional to actual TSS excess for small overages.

---


### ✅ ISSUE-87: Two "Load Safety" bars on Stats — kill the second one *(fixed 2026-03-12)*
**Fix**: Removed the duplicate Load Safety bar from `stats-view.ts`.

---

### ✅ ISSUE-89: Sleep debt tracker *(fixed)*
**Fix**: `computeSleepDebt` in `sleep-insights.ts` implements exponential decay with a 4-day half-life. Rendered in `sleep-view.ts` as a sleep debt sub-label and dedicated HTML section.

---

### ✅ ISSUE-88: km/mile unit tag not working *(fixed 2026-03-19)*
**Fix**: `formatKm` wired across all distance display sites (`plan-view.ts`, `home-view.ts`, `stats-view.ts`, `activity-detail.ts`, `activity-review.ts`, `suggestion-modal.ts`, `matching-screen.ts`, `gps-panel.ts`, `week-debrief.ts`, `record-view.ts`, `gps-completion-modal.ts`). `account-view.ts` toggle persists to state and re-renders. Pace display (`formatPace`) also wired for `/mi` conversion. Confirmed by user.

---

### ISSUE-90: LT Threshold not surfaced in setup; no Garmin auto-pull *(P2)*
**Symptom**: Users need to manually input their LT HR from a Garmin device, which is non-obvious — most don't know where to find it. The app doesn't guide them.
**Design**:
1. Add in-setup guidance: where to find LT HR on Garmin (Physio True Up or LT test) with a screenshot/diagram.
2. Longer term: pull it automatically via the Garmin edge function (dailies or physio endpoint already returns `lactateThresholdBpm`).
**Files**: `src/ui/wizard/` (setup steps), `supabase/functions/garmin-webhook/` or `sync-physiology-snapshot`.

---

### ✅ ISSUE-91: Plan restart generates a different running profile — nondeterministic *(P2)*

Verified stale (2026-05-07): no `Math.random` anywhere in plan generation or wizard initialisation (only in ID generation, which is correct). Any apparent non-determinism on restart was almost certainly a Strava backfill timing artifact — different Strava history landed on the second run, producing a different VDOT/CTL baseline. The plan engine itself is deterministic given the same inputs. No code change needed.

---

### ISSUE-92: Onboarding should display historic load scan before confirming plan *(P3)*
**Symptom**: The setup wizard never shows users proof that their training history was understood. Users have no confidence the plan is calibrated to them.
**Design**: After Strava backfill completes, show a summary screen: "We found X activities over N weeks · Average weekly load: Y TSS · Your ramp rate: Z%." Then let them confirm or adjust before the plan starts. Mirrors what a real coach would do.
**Files**: `src/ui/wizard/steps/initializing.ts`, `src/data/stravaSync.ts`.

---

### ✅ ISSUE-93: 8W / 16W / All chart tabs confusing *(fixed 2026-03-12)*
**Fix**: Removed "All" tab (or renamed/clarified) in `stats-view.ts`.

---


### ✅ ISSUE-95: Injury icon inconsistency — heart on some screens, emoji on others *(resolved)*
**Fix**: No emoji-based injury/risk icons found in `src/ui/`. All injury risk rendering uses CSS colour tokens (`var(--c-warn)`, `#EF4444`, `#F59E0B`) and text labels. Issue either already fixed or never manifested in current code.

---

### ✅ ISSUE-96: "Start Run" pre-loads today's session *(fixed)*
Today's planned workout (distance, target pace, session description) is passed into the record view when navigating from "Start Run" on the Home page. Confirmed working.

---


### ISSUE-98: Activity card shows total load only — no split by sport type *(P2)*
**Symptom**: The load figure on activity cards is a single number (e.g. "93 TSS") with no breakdown. Users want to see e.g. "40 TSS Running / 53 TSS Tennis" to understand where the load came from.
**Fix**: Add a sport-type breakdown row to the activity load card when the week contains multiple sport types.
**Files**: `src/ui/activity-review.ts`, `src/ui/excess-load-card.ts`.
**Note (2026-05-11)**: The excess-load card is a narrow amber banner — fitting a sport breakdown in it is a design question. The activity review flow already shows each activity individually so the marginal value is lower than it looks. Parked for `[ui-ux-pro-max]` session.

---

### ✅ ISSUE-99: Load on Plan page doesn't match load on Stats page *(fixed 2026-03-12)*
Both views now read from the same computation path.

---

### ✅ ISSUE-100: Injury risk label wording inconsistency — "Low" vs "Manageable" *(fixed 2026-03-12)*
**Fix**: Unified risk label vocabulary across all views (home, stats, renderer).

---


### ✅ ISSUE-104: HR target label implies whole session is Z4, including warm up/cool down *(fixed 2026-03-11)*
**Fix**: `buildWorkoutExpandedDetail` in `plan-view.ts` now detects warm up/cool down structure (checks for "warm up" in `w.d`) and appends "· main set" to the HR target label. Simple sessions show "Z4" alone; structured sessions show "Z4 · main set".

---

### ✅ ISSUE-106: Cross-training planned TSS inflated ~7× vs actual iTRIMP scale *(fixed 2026-03-12)*
**Root cause**: `TL_PER_MIN` is calibrated for running HR responses. Cross-training at the same RPE produces lower HR → lower iTRIMP → much lower actual TSS. A historical weekly→daily scale shift compounded this — displayed planned (103) vs actual (14) was consistently misleading for cross-training.
**Fix**: Cross-training planned TSS now uses `computeCrossTrainTSSPerMin()` (median iTrimp-based TSS/min from user's own history, in `fitness-model.ts`). Fallback when < 2 samples: `TL_PER_MIN[rpe] × sportRunSpec` (e.g. 0.40 for generic_sport). Planned vs actual bars suppressed for matched cross-training in both plan-view and activity-detail — RPE→HR mapping unreliable for non-running sports. Future unmatched cross-training still shows `~X TSS` using corrected formula. Running unchanged. `general_sport` alias added to `SPORTS_DB` so "General Sport" placeholders resolve correctly.

---

### ✅ ISSUE-103: Planned TSS in workout detail uses wrong scale *(fixed 2026-03-11)*
**Root cause**: `calculateWorkoutLoad()` used `LOAD_PER_MIN_BY_INTENSITY` (Garmin scale) for planned TSS; actual TSS used `TL_PER_MIN` (app scale). ~74% inflation on the planned side.
**Fix**: Replaced `calculateWorkoutLoad()` with a direct `TL_PER_MIN`-based computation at the top of `buildWorkoutExpandedDetail`. Both the "Planned Load" (future sessions) and "Training Load" planned vs actual bars now share a single `plannedTSS` on the correct scale.

---




## Priority Order

| Priority | Issue | Group | Effort | Impact |
|---|---|---|---|---|
| ✅ | ISSUE-79: plannedTSS not based on historic load | Arch | Large | Critical |
| ✅ | ISSUE-78: Prorated baseline broken on Monday | Stats | Small | High |
| ✅ | ISSUE-77: Activities not sorted by time | Plan | Small | High |
| ✅ | ISSUE-76: Garmin historic backfill | Edge fn | Medium | High |
| ✅ | ISSUE-81: Welcome-back modal removed | main.ts | Small | High |
| ✅ | ISSUE-80: Recovery score bar | Stats | Medium | High |
| ✅ | ISSUE-60: Week-end debrief | UI | Medium | High |
| ✅ | ISSUE-74: Info buttons don't work on Stats | Stats | Small | High |
| ✅ | ISSUE-73: Dig Deeper / Your Numbers hierarchy | Stats | Medium | High |
| ✅ | ISSUE-72: Split Your Numbers into Recovery/Running | Stats | Medium | High |
| ✅ | ISSUE-71: Remove Simulate Race button | Stats | Small | Low |
| ✅ | ISSUE-75: Running fitness improves without running | Calc | Medium | High |
| ✅ | ISSUE-20: Activity card UX | Cards | Medium | High |
| ✅ | ISSUE-19: Home load bars | Home | — | High |
| ✅ | ISSUE-08: Training Load bar unlabelled | Stats | — | High |
| ✅ | ISSUE-89: Sleep debt tracker | Sleep sheet | Small | Medium |
| ✅ | ISSUE-88: km/mile unit tag — all distances + pace wired | Format | Small | High |
| ✅ | ISSUE-87: Two Load Safety bars — kill second one | Stats | Small | Medium |
| ✅ | ISSUE-106: Cross-training planned TSS inflated — historical calibration + bar suppression | Calc/UI | Small | High |
| ✅ | ISSUE-94, 102, 105, 107, 114, 115, 124, 125, 126, 128, 130: all confirmed 2026-04-08 | — | — | — |
| ✅ | ISSUE-86: Reduce recommendation 32% cut for 2% overshoot — disproportionate | Modal | Small | High |
| ✅ | ISSUE-85: CTL 222 — inflated, corrupts all downstream calcs | Calc | Medium | Critical |
| ✅ | ISSUE-83: TSS 245/330 — resolved (shared root cause with ISSUE-85) | Calc | Small | High |
| ✅ | ISSUE-82: "How are you feeling?" check-in — made optional | Home | Small | Medium |
| ✅ | ISSUE-84: HR zones chart — removed (obsolete) | Stats/Cards | Small | Medium |
| ✅ | ISSUE-29: VDOT history | Stats | Medium | High |
| ✅ | ISSUE-35: HR effort signal + drift + commentary (all 3 builds complete) | Feature | Large | High |
| 🟡 | ISSUE-33: 2 workouts/day — see **To Be Discussed** section | — | — | — |
| ✅ | ISSUE-37: Illness mode | Feature | Large | Medium |
| P3 | ISSUE-11: Auto-slot load | Feature | Large | Medium |
| ✅ | ISSUE-99: Plan page load ≠ Stats page load | Calc | Small | High |
| ✅ | ISSUE-100: Injury risk label "Low" vs "Manageable" mismatch | Copy | Small | Medium |
| P2 | ISSUE-90: LT Threshold setup guidance + Garmin pull | Setup | Medium | Medium |
| ✅ | ISSUE-91: Plan restart nondeterministic — stale, no Math.random in plan gen | — | — | — |
| ✅ | ISSUE-93: 8W/16W/All tabs confusing | Stats | Small | Low |
| ✅ | ISSUE-95: Injury icon inconsistency — no emoji found, clean | UI | Small | Low |
| ✅ | ISSUE-96: Start Run goes to blank record screen | Home | Small | Medium |
| 🟡 | ISSUE-97: Home load graph — remove or redesign? — see **To Be Discussed** | — | — | — |
| P2 | ISSUE-98: Activity card no load split by type | Cards | Small | Medium |
| P3 | ISSUE-92: Onboarding historic load scan before plan start | Wizard | Medium | High |
| P2 | ISSUE-123: HR zones / LT threshold auto-pull from Garmin, manual as override | Account/Edge fn | Small | High |
| P2 | ISSUE-116: Email Garmin for Auth API access (external action) | Admin | — | Critical |
| P2 | ISSUE-117: Preview week copy → "based on last week" | Plan | Small | Medium |
| P2 | ISSUE-118: Load matching explainer on matched activity cards | Cards | Small | Medium |
| P2 | ISSUE-119: Onboarding — explain what the app does | Wizard | Small | High |
| ~~P3~~ | ~~ISSUE-115: Holiday mode~~ | ~~Feature~~ | ~~Medium~~ | ~~High~~ | Implemented + bugs fixed 2026-04-09 |
| P3 | ISSUE-120: Check-in button (illness / injury / feeling) | Home | Medium | High |
| P3 | ISSUE-121: Zone 2 explainer with Kipchoge context | Stats | Small | Medium |
| P3 | ISSUE-122: Onboarding goal-selection step | Wizard | Medium | High |


---

## Product Improvements — Competing at the Top

> Strategic product bets — features that move us from "solid training app" to genuinely competing with polished products like BEVEL. Not bugs, not UX polish. These are the things that make a runner *choose* this app over the competition.

---

### ISSUE-108: Daily loop — Home screen must be compelling to open every morning *(P2)*
**Problem**: A training app lives or dies by the daily habit. If opening the app doesn't immediately give a clear, motivating answer to "what do I do today?" — users drift away.
**Design goal**: In under 3 seconds, the home screen should show: today's workout with clear context, a single load/readiness signal, and one actionable coaching insight. No noise.
**Current gap**: Home has multiple cards, load bars, a graph, and a recovery bar — but no clear hierarchy. The most important thing (today's session) competes with everything else.
**Files**: `src/ui/home-view.ts`. Connected to ISSUE-97 (home load graph removal).

---

### ISSUE-109: Plan explainability — tell the runner *why* today's workout is this *(P3)*
**Problem**: Plans feel generic. A runner sees "8km @ easy pace" and has no idea if this is recovery, base building, or filling a volume target. BEVEL and coaching apps explain the why.
**Design**: Each workout card should carry a one-sentence coach rationale, e.g. "Build phase week 3 — aerobic base before threshold work starts next week." Derived from phase, week position, and VDOT relative to target.
**Impact**: Makes the plan feel intelligent and personalised, not a generic schedule. Builds trust that the algorithm understands you.
**Files**: `src/ui/plan-view.ts`, `src/ui/home-view.ts`, plan generation logic.

---

### ISSUE-110: Race day narrative — predicted time *and* what it takes to go faster *(P3)*
**Problem**: We show a predicted marathon time (e.g. 3:12) but don't make it actionable. A runner wants to know: *what would it take to run 3:05?*
**Design**: Below the predicted time, a single coaching sentence: "To run sub-3:10, you'd need ~4 more weeks at your current load + one extra threshold session per week." Derived from VDOT → pace mapping and plan headroom. Makes the product aspirational and coaching-forward rather than just descriptive.
**Files**: `src/ui/stats-view.ts` (forecast section), `src/calculations/fitness-model.ts`.

---

### ISSUE-111: Onboarding — prove calibration before the plan starts *(P2)*
**Problem**: When a new user finishes setup, they have no confidence the plan is actually built for them. They don't see the training history that was scanned, the load level detected, or why the plan looks the way it does.
**Design**: After Strava/Garmin backfill, show a "We found you" summary screen before confirming the plan — e.g. "Based on your last 12 weeks: avg 47 km/week · load trending up · your strongest day is Tuesday." Then confirm. This is what a real coach does in their first session.
**Connected to**: ISSUE-92 (historic load scan screen). ISSUE-111 is the broader onboarding hook — ISSUE-92 is the specific data summary screen.
**Files**: `src/ui/wizard/steps/initializing.ts`, `src/data/stravaSync.ts`.

---


### ISSUE-112: Coherent visual design pass *(P2)* `[ui-ux-pro-max]`
**Problem**: Screens have been built feature-by-feature. The result is inconsistent card styling, mixed icon languages, varying font weights, and a home/stats split that doesn't feel like one product.
**Design goal**: One coordinated session with `ui-ux-pro-max` to establish a consistent card system, typography scale, colour use, and icon vocabulary — then apply it across all screens.
**Known rough spots**: HR zones chart (ISSUE-84), home load graph (ISSUE-97), activity cards, stats recovery card, plan week headers.
**Files**: Most of `src/ui/`. Tackle as a single pass, not file by file.

---

### ✅ ISSUE-128: Sleep analysis should use 7-day rolling window, not today's snapshot *(P2)*

Verified stale (2026-05-07): `sleep-view.ts` already reads `physiologyHistory.slice(-7)` for the 7-day average score and `physiologyHistory.slice(-30)` for the 30-day duration baseline. The readiness model accepts `sleepHistory` and computes acute/chronic deltas from it. No code change needed.

---

### ISSUE-127: REM sleep analysis — surface insights and training impact *(P3)*
**Motivation**: Once REM data is reliably flowing (ISSUE-126), there's a coaching signal here. REM is the sleep stage most sensitive to overtraining and stress; low REM correlates with poor cognitive recovery and elevated cortisol. It's a more actionable signal than total duration.
**Design**:
- **Stage breakdown on Home sleep card**: show Deep / REM / Light / Awake as labelled bars with % of total (already partially built — needs REM data to populate)
- **REM trend sparkline on Stats recovery card**: 7-day rolling REM % (target: 20–25% of total sleep). Trend down = flag
- **Coaching insight**: if REM% < 15% for 3+ consecutive nights, show a recovery card note: "Your REM sleep has been low this week — this can blunt training adaptation. Prioritise sleep consistency."
- **Training load link**: compare REM% against weekly TSS. Surfaces "Your hardest weeks correlate with lower REM — your body is working hard." Adds a layer of intelligence between load and recovery
- **Dependency**: ISSUE-126 must be confirmed working first (REM data in DB)
**Files**: `src/ui/home-view.ts` (sleep card), `src/ui/stats-view.ts` (recovery card), `src/calculations/readiness.ts` (REM% signal into recovery score)

---

### ISSUE-113: Shareable moments *(P3)*
**Problem**: Every hard workout, milestone week, or PB prediction is a potential share moment. Currently there's no way to export or share anything. BEVEL and Strava capitalise heavily on this for organic growth.
**Design**: Shareable cards for: week completed (load + distance summary), new VDOT high, predicted race time improvement, long run PB. Native share sheet via Capacitor. Optional — never forced.
**Files**: New `src/ui/share-card.ts`. Capacitor Share plugin.

---

### ✅ ISSUE-133: Guided runs — skip/extend desync the tracker's SplitScheme *(P1, fixed 2026-04-15)*
**What**: `GuideController.skipStep()` and `extendCurrentStep(sec)` mutated the engine's `Timeline` but not the tracker's `SplitScheme`, so splits/per-km cues/adherence drifted after a user tapped "Skip rest" or "+30s".
**Fix**: Added public `skipSegment()` and `extendSegment(sec)` on `GpsTracker`. `GuideController.skipStep()` / `extendCurrentStep()` now accept an optional tracker adapter and advance both representations in lockstep. `gps-events.ts` exposes `guidedSkipStep()` / `guidedExtendCurrentStep()` helpers wired from the rest overlay (via dynamic import to break the cycle).
**Status**: Typecheck + 122 tests pass. Still needs on-device confirmation during a real interval session. ISSUE-137 (single parser) is the longer-term architectural fix.
**Files**: `src/gps/tracker.ts`, `src/guided/controller.ts`, `src/ui/gps-events.ts`, `src/ui/guided-overlay.ts`.

---

### ✅ ISSUE-134: Guided runs — iOS WKWebView blockers (voice, haptics, silent switch) — FIXED 2026-04-16 (pending on-device verification)
**What was**: Voice + haptic stack had never been tested on a real iPhone. Web Speech unreliable in WKWebView, `navigator.vibrate` silent on iOS, silent switch muted everything.
**Fix shipped**:
- App renamed to Mosaic (`com.mosaic.training`). `Info.plist` gained `NSMotionUsageDescription` and `audio` in `UIBackgroundModes` so voice can keep speaking while the screen is locked.
- `@capacitor/haptics` installed and wired as a runtime adapter inside `src/guided/haptics.ts`. Native → `Haptics.impact` (Taptic Engine), browsers → `navigator.vibrate`. Existing tests unaffected — the injectable `HapticAdapter` interface is preserved.
- New local SPM plugin `@mosaic/guided-voice` at `ios-plugins/guided-voice/`, Swift target `ios/Sources/GuidedVoicePlugin/GuidedVoicePlugin.swift`. Wraps `AVSpeechSynthesizer`; activates `AVAudioSession(.playback, .voicePrompt, [.duckOthers, .mixWithOthers])` around every utterance — `.playback` overrides the silent switch. Deactivates with `.notifyOthersOnDeactivation` on the delegate finish / cancel callback.
- `src/guided/voice.ts` routes `speak()`/`cancel()` through `registerPlugin<GuidedVoicePlugin>('GuidedVoice')` when `Capacitor.isNativePlatform()`; Web Speech is the browser fallback. `composePhrase` stays pure so tests pass unchanged.
- Plugin registered as a proper local npm package (`npm install file:./ios-plugins/guided-voice`) so `npx cap sync ios` auto-adds it to `packageClassList` and to `CapApp-SPM/Package.swift`. Keeping the Swift file inline under `CapApp-SPM/Sources/` would have been silently stripped on every sync.
**Pending on-device verification** per CLAUDE.md rule: install on iPhone, flip the silent switch, lock the screen mid-run, confirm voice + haptics fire and music ducks.
**Files**: `capacitor.config.ts`, `ios/App/App/Info.plist`, `ios/App/App.xcodeproj/project.pbxproj`, `src/guided/haptics.ts`, `src/guided/voice.ts`, `ios-plugins/guided-voice/**`, `docs/IOS_SETUP.md`.

---

### ✅ ISSUE-135: Guided runs — cues fire late or not at all when screen is locked *(P1, interim fix 2026-04-16)*
**What**: The tracker's 1s `setInterval` (which drives engine updates) is throttled heavily when the webview is backgrounded or the screen is locked. The user pockets the phone and voice cues stop. This defeats the guided experience for the majority of the run.
**Interim fix (web-only)**: Screen Wake Lock API acquired inside `startTracking` when a `GuideController` is created and `guidedKeepScreenOn !== false` (default ON). Released on `stopTracking` (both branches), `disableActiveGuide`, and when the user toggles it off. Re-acquires automatically on `visibilitychange → visible` since browsers release the lock on tab-hide. Graceful no-op on unsupported browsers (Safari pre-16.4). New Account → Preferences toggle ("Keep screen on") below the voice-rate slider, disabled with "Not supported on this browser" sub-label when the API is missing.
**Follow-up**: FUTURE-03 Live Activity / Capacitor `@capacitor-community/keep-awake` on native shells will supersede this when the phone is pocketed.
**Files**: `src/utils/wake-lock.ts` (new), `src/utils/wake-lock.test.ts` (new, 11 tests), `src/ui/gps-events.ts`, `src/ui/account-view.ts`, `src/types/state.ts`.

---

### ✅ ISSUE-136: Guided runs — music ducking not implemented *(P2, fixed 2026-04-16 via ISSUE-134 native plugin)*
**Fix**: `GuidedVoicePlugin.swift` activates `AVAudioSession` with category `.playback`, mode `.voicePrompt`, and options `[.duckOthers, .mixWithOthers]` before each utterance and deactivates with `.notifyOthersOnDeactivation` on finish / cancel. On iOS the app will dip Spotify/Apple Music while the voice speaks and restore it after. Web fallback (`SpeechSynthesisUtterance`) has no ducking equivalent — speech plays over music at full volume as it did before, but this is only the development path.
**Status**: Implemented in code. Needs on-device confirmation that ducking behaves as expected against Apple Music and Spotify.
**Files**: `ios-plugins/guided-voice/ios/Sources/GuidedVoicePlugin/GuidedVoicePlugin.swift`, `src/guided/voice.ts` (native bridge via `@capacitor/core registerPlugin('GuidedVoice')`).

---

### ✅ ISSUE-137: Guided runs — two parsers for one workout description *(P2, architectural, fixed 2026-04-16)*
**Fix**: `buildSplitScheme` is now a thin adapter over `buildTimeline`. The split scheme is derived by walking the `Timeline` steps and mapping: rep → single paced segment, recovery → untimed segment with `durationSeconds`, warmup/cooldown → single paced segment at easy pace, single-block distance/time work → per-km splits, progressive (2-step easy+fast) → per-km easy + per-km "Fast km N of M". Timeline was extended to cover formats split-scheme already handled but timeline did not: (1) literal paces `"4:49/km"` in interval time / distance-at-pace expressions, (2) optional `(~790m)` / `(~3.2km)` parentheticals after zone tokens, (3) `{N}km <descriptor>` forms like `"5km warmup jog"`. New anti-regression test in `integration.test.ts` iterates every split-scheme test input and asserts the timeline is non-empty + structured where expected + all paced segments trace back to a timeline step pace.
**Files**: `src/guided/timeline.ts`, `src/gps/split-scheme.ts`, `src/guided/integration.test.ts`, `docs/ARCHITECTURE.md`.

---

### ✅ ISSUE-138: Guided runs — rest overlay leaks on tab navigation *(P2, fixed 2026-04-15)*
**Fix**: `tab-bar.ts` delegated click handler unmounts the guided overlay on any non-Record tab. `record-view.ts` re-mounts the overlay on re-entry if a `GuideController` is still active (the controller re-emits / `mountGuidedOverlay` re-renders immediately when the current step is recovery).
**Files**: `src/ui/tab-bar.ts`, `src/ui/record-view.ts`.

---

### ✅ ISSUE-139: Guided runs — mid-run settings changes silently ignored *(P3, fixed 2026-04-15)*
**Fix**: `gps-events.ts` exposes `disableActiveGuide()` and `setActiveGuideSplitAnnouncements(bool)`. Account toggles now forward to the active controller (destroy on "Off", forward split toggle live). Re-enabling mid-run still requires stopping and restarting (fresh `GuideController` needs a workout+paces, which only `startTracking` holds).
**Files**: `src/ui/gps-events.ts`, `src/ui/account-view.ts`.
**Files**: `src/ui/account-view.ts` (toggle handlers), `src/ui/gps-events.ts` (export a control surface).

---

### ✅ ISSUE-140: Guided runs — adherence uses one tolerance for every step type *(P3, fixed 2026-04-15)*
**Fix**: `ADHERENCE_TOLERANCE_BY_KIND` map: work ±4, warmup/cooldown ±10, other ±5 (recovery is always untimed). `classifyPace` takes a kind argument; `summariseAdherence` passes the categorised kind through. Tests updated for the new bands.
**Files**: `src/guided/adherence.ts`, `src/guided/adherence.test.ts`.

---

### ✅ ISSUE-141: Guided runs — end-to-end integration test missing *(P2, fixed 2026-04-15)*
**Fix**: `src/guided/integration.test.ts` drives a single structured workout description through both parsers (`buildTimeline` + `buildSplitScheme`) and asserts they produce compatible work-rep counts, that the controller emits `stepStart` cues in strictly increasing step order and reaches `timelineComplete`, that the cue log captures every emitted event, and that `summariseAdherence` classifies synthetic splits correctly under the new per-kind tolerances. Uncovered the exact seam ISSUE-137 warns about: the initial test description ("…60s recovery") failed `buildSplitScheme` silently — confirmed the need for a single parser but tangential to this test.
**Files**: `src/guided/integration.test.ts` (new, 4 tests).

---

### ✅ ISSUE-142: Guided runs — speech rate hard-coded to 1.0 *(P3, fixed 2026-04-15)*
**Fix**: Added `guidedVoiceRate` to state (0.8–1.4, default 1.0). Slider in Account → Preferences below the two toggles; value saved on change, forwarded live to the active `VoiceCoach` via `GuideController.setVoiceRate`. `VoiceCoach.setRate` clamps to the valid range.
**Files**: `src/types/state.ts`, `src/ui/account-view.ts`, `src/guided/voice.ts`, `src/guided/controller.ts`, `src/ui/gps-events.ts`.

### ✅ ISSUE-143: Guided runs — +30s has no cap *(P3, fixed 2026-04-15)*
**Fix**: Engine records `originalDurationSec` on first extend; caps extensions at 2× original. `extendCurrentStep` now returns the actual seconds applied so the tracker's SplitScheme stays in sync even when clipped. Overlay's +30s button is disabled (faded, `cursor:not-allowed`) when remaining allowance < 30s.
**Files**: `src/guided/timeline.ts`, `src/guided/engine.ts`, `src/guided/controller.ts`, `src/ui/guided-overlay.ts`.

### ✅ ISSUE-144: Guided runs — no observability for in-run cues *(P3, fixed 2026-04-15)*
**Fix**: `GuideController` now pushes every `CueEvent` into a 100-entry ring buffer (`getCueLog()`), tagged with timestamp, run-elapsed seconds, step idx/label and event type. `stopTracking()` attaches the log to the `GpsRecording` as the optional `cueLog` field. Not surfaced in UI — debug-only, available on the stored recording for support diagnostics.
**Files**: `src/types/gps.ts`, `src/guided/controller.ts`, `src/ui/gps-events.ts`.

---

### ISSUE-184: Checkpoint week TT workout content + deload weeks in long base *(P3, future build)*
**What**: Three follow-ups from the 2026-05-11 plan-phasing rewrite, status updated 2026-05-12:

1. ~~**Inter-cycle transition volume drop**~~ — **Resolved 2026-05-12** by relabelling the 2-week inter-cycle transition from `'base'` to `'taper'`. The workout generator's existing taper-phase volume drop now fires automatically.
2. **Checkpoint TT explicit workout content**: For plans in double-periodization (running ≥33w, tri/hyrox ≥28w), `computePlanPhases` flags the last peak week of cycle 1 with `wk.checkpoint = true`. The Phase Timeline labels it "Checkpoint" and shows a caption telling the user to race a parkrun or 10K TT that Saturday (added 2026-05-12). The result feeds VDOT/CSS/FTP auto-refresh through the existing activity matcher — covering ~80% of the value. *Still deferred*: explicit TT-flavoured workout content (Mon-Wed easy / Thu opener / Sat 5K or 10K hard / Sun easy) so the generator produces the right shape automatically. Currently the generator produces standard peak-week sessions and the user substitutes the TT manually.
3. **Deload weeks in long base**: Plans 24+ weeks can have base blocks 15+ weeks long. A coach would deload every 4th week (~30% volume drop) to avoid monotony. The phase label stays "Base"; only the volume drops. Likely handled in `planWeekSessions` / `generator.ts` volume modulation, not phase tagging.

**Why deferred**: No current user has a 28+ week plan; the parkrun-caption path covers the checkpoint week for now.
**Files** (when ready): `src/workouts/generator.ts` (`generateWeekWorkouts` checkpoint branch), `src/workouts/plan_engine.ts` (deload-in-base modulation), `src/main.ts` (post-TT marker refresh trigger).

---

### ISSUE-183: HYROX session generator is a single Run by Feel shortcut *(P3, future build)*
**What**: HYROX mode's `+ Add session` button (`src/ui/hyrox/plan-view.ts:113`) jumps straight to Run by Feel via `openSessionGenerator()` short-circuit (`src/ui/session-generator.ts:201`). No way to ad-hoc add a station block, a brick session, or a structured run from the picker.
**Why deferred**: Single-button shortcut was the deliberate V1 call (2026-05-07). Tristan parked the broader picker until usage shows the rough edge.
**When to revisit**: If users start asking for ad-hoc HYROX-specific shapes (sled push intervals, compromised-running blocks, brick run-after-station). Likely needs a 2-discipline picker — Run / Station — with kind sub-pickers under each (run shapes already exist in `intentToWorkout`; station shapes need a new builder, similar to `generateBikeSession`).
**Files** (when ready): `src/ui/session-generator.ts` (new HYROX-mode flow), `src/workouts/hyrox/` (likely a new `station.ts` builder), `src/ui/hyrox/plan-view.ts` (button label might change).

---

### ISSUE-153: RPE rating bias for no-HR users — calibration needed *(P3, future build)*
**What**: After the 2026-05-06 cross-training RPE work, no-HR users' rated RPE drives `aerobic`/`anaerobic` load on adhoc workouts (which feeds ACWR, recovery countdown, sleep insights, tri overload). For users who systematically over- or under-rate, this introduces consistent drift in one direction:
- Always-high raters (9-10) → inflated load → false ACWR climb → softer plan → under-training.
- Always-low raters (3-4) → understated load → ACWR low → potential under-recovery and injury risk.
**HR users are unaffected** — the iTrimp guard short-circuits before any RPE-derived load mutation. Affects only no-HR cross-training, which is a small subset.
**Why deferred**: Cheap hedges (cap RPE-derived TSS at 1.5× duration-at-neutral, soft floor at 0.5×) require made-up constants without data. Right next move is observability before mitigation: log RPE-derived load alongside iTrimp-derived load wherever both signals exist, build a sample, then compute personal calibration ratios.
**Mitigations the system already has**: HRV/sleep/RHR feed `recoveryAdj` (`fitness-model.ts:1573-1576`) which can bump load up to 30% on objectively bad-recovery days, independent of what the user rated. So the worst overtraining cases get caught even if rating is consistently low.
**Files** (when ready): `src/calculations/fitness-model.ts` (calibration computation), `src/calculations/activity-matcher.ts` (apply calibration to RPE-derived TSS).

---

### ISSUE-132: Apple Watch — extend HealthKit plugin for advanced metrics *(P3, future build)*
**What**: `@capgo/capacitor-health` does not expose several HealthKit data types that Apple Watch captures and Garmin doesn't (or does worse). These need a plugin contribution or fork to access.
**Data to add**:
- **Wrist temperature** (`HKQuantityType.appleSleepingWristTemperature`) — deviation from baseline. Early overtraining/illness signal (same signal that makes Oura valuable). Series 8+ only.
- **Running Power** (`HKQuantityType.runningPower`) — native on Apple Watch since watchOS 9. Better load metric than pace on hilly terrain. Would need a new load model path alongside iTRIMP.
- **Running form metrics** — ground contact time (`runningGroundContactTime`), stride length (`runningStrideLength`), vertical oscillation (`runningVerticalOscillation`). Injury risk indicators and running economy signals. Series 6+.
- **HR Recovery rate** — how fast HR drops post-exercise. Strong fitness/fatigue indicator.
- **SpO2 + Respiratory Rate** — already in the plugin's `HealthDataType` enum but not currently read. Useful once an illness/overtraining detection model is built to consume them.
**Blocked by**: Plugin limitation (need to extend `HealthDataType` enum and add native Swift queries). No consumer logic exists yet in the readiness/fitness model for these signals.
**Files**: `@capgo/capacitor-health` (plugin fork or PR), `src/data/appleHealthSync.ts`, `src/types/state.ts` (new fields on `PhysiologyDayEntry`), readiness model (new illness detection), fitness model (running power load path).

---

| Priority | Issue | Effort | Impact |
|---|---|---|---|
| P2 | ISSUE-108: Daily loop / Home hierarchy | Medium | Critical |
| P2 | ISSUE-111: Onboarding calibration proof | Medium | High |
| P2 | ISSUE-112: Visual design coherence pass | Large | High |
| P3 | ISSUE-109: Plan explainability — workout why | Medium | High |
| P3 | ISSUE-110: Race narrative — what it takes to go faster | Medium | High |
| P3 | ISSUE-113: Shareable moments | Medium | Medium |
| ✅ | ISSUE-128: Sleep analysis 7-day rolling — stale, already implemented | — | — |
| P3 | ISSUE-127: REM sleep analysis — stage breakdown, trend, training link | Medium | High |
| P3 | ISSUE-132: Apple Watch advanced metrics (temp, power, form, SpO2) | Large | High |

---

## Future Builds — Major Feature Tracks

> These are standalone product tracks with their own design docs. Not bugs, not polish. Each one is a multi-week build that expands the product into a new capability.

---

### FUTURE-01: Workout to Watch — Garmin + Apple Watch Push

**Doc**: [`docs/WorkoutWatch.md`](WorkoutWatch.md)

**What**: Push structured workouts (warm-up, intervals, targets, cool-down) to Garmin watches via the Training API so users execute them with live pace/HR guidance on the wrist. Apple Watch via WorkoutKit as Phase 2.

**Why it matters**: The app generates detailed structured workouts but users currently have no way to follow them live during execution. This is the gap between "training plan" and "coaching platform". Every competitor (TrainingPeaks, Garmin Coach, COROS) syncs to the watch.

**Garmin path (Phase 1, ~7-10 days)**:
- OAuth already built. Same Bearer token works for Training API.
- New edge function: `garmin-push-workout` (create + schedule)
- New mapper: `src/garmin/workout-mapper.ts` (SplitScheme to Garmin JSON)
- UI: "Send to Garmin" per workout + "Send Week" in plan header
- Prerequisite: enable "Workout Import" permission on Garmin Developer Portal consumer key

**Apple Watch path (Phase 2, ~9-12 days)**:
- Custom Capacitor plugin (Swift) bridging WorkoutKit
- HealthKit entitlements currently missing from iOS project (must fix first)
- WorkoutKit available iOS 17+ / watchOS 10+

**Status**: Design doc complete. Ready to build.

---

### FUTURE-03: Guided Runs — Lock-Screen Live Activity (iOS) + Foreground Notification (Android)

**What**: Surface a live-updating lock-screen view for a tracked run. On iOS this is ActivityKit / Live Activity (step in, duration, pace, next rep) with Dynamic Island support. On Android this is a persistent foreground-service notification with the same content.

**Why it matters**: The in-app guided-runs build (voice cues, rest overlay, engine, haptics) is complete and end-to-end wired. The remaining gap is glanceability: during a run the user locks the phone and loses access to the current step, remaining distance, or next rep. Competitors (Strava, Nike Run Club, Garmin Connect) all offer this. Without it, the guided experience only works phone-in-hand.

**iOS path (~5–7 days)**:
- Add a Widget Extension target in Xcode (must be done in Xcode, not Capacitor CLI)
- SwiftUI views for the Lock Screen and Dynamic Island presentations
- Small custom Capacitor plugin (Swift) exposing `startActivity`, `updateActivity({step, remaining, pace, next})`, `endActivity` to JS
- Wire calls from `GuideController` or `gps-events.ts` on step transitions + tick
- Live Activity requires iOS 16.1+

**Android path (~4–6 days, deferred until Android is in scope)**:
- `npm install @capacitor/android` + `npx cap add android` (scaffolds ~50 files)
- Reuse `@transistorsoft/capacitor-background-geolocation` foreground service notification (already bundled), OR write a custom Capacitor plugin for a dedicated "guided run" notification with live text
- Update notification title/body on step transitions

**Status**: Parked. Android is not a current priority. iOS Live Activity is a future build — in-app guided runs (step 5 of the original 8-step plan) is shipped. Steps 6 (Android notification) and 7 (iOS Live Activity) are now unified under this FUTURE entry.

---

### FUTURE-02: Triathlon Mode — Multi-Sport Plan Engine

**Doc**: [`docs/TRIATHLON.md`](TRIATHLON.md)

**What**: Extend the plan engine to generate swim/bike/run training plans for 70.3 and Ironman distances. Per-discipline fitness tracking, brick sessions, multi-sport weekly scheduling.

**Why it matters**: The adaptive engine, load model, and activity sync infrastructure are sport-agnostic. Triathlon is the natural expansion. The user base overlaps heavily (marathon runners who move to triathlon). No competitor does adaptive triathlon plans well.

**Key components**:
- Race profiles: 70.3 and Ironman with distance/time targets
- Per-discipline load tracking: swim CTL, bike CTL, run CTL (Signal A per sport)
- Workout library: swim sets (CSS-based), bike sessions (FTP-based), brick workouts
- Scheduler: multi-sport week layout respecting recovery between disciplines
- Activity matching: Strava/Garmin already classify swim/bike/run — matching logic extends
- Onboarding: swim CSS, bike FTP, existing run VDOT — three calibration paths

**Architecture impact**: Plan generator needs sport-aware workout templates. Fitness model needs per-discipline CTL/ATL. State schema adds `swimFTP`, `bikeFTP`, discipline-level metrics. UI needs discipline tabs or filters on plan/stats views.

**Status**: Full architecture doc written. Planning phase. Blocked on: confirming demand signal from users.

---

### FUTURE-03: The Brain — AI Coaching Intelligence

**Doc**: [`docs/BRAIN.md`](BRAIN.md)

**What**: A central coaching coordinator (`daily-coach.ts`) that collates all signals (sleep, HRV, load, injury, illness, ACWR) into a single `CoachState` — the authoritative answer to "what should I do today?". Optional LLM layer generates a coaching narrative paragraph.

**Why it matters**: The app collects rich signal (sleep, HRV, load, injury, HR drift, RPE) but each system fires in isolation. No single function answers "given everything we know, what's the coaching stance for today?" This is what makes a coach valuable — connecting signals that individually seem fine but together indicate a problem.

**Key components**:
- `daily-coach.ts` (rules-based coordinator) — **Phase 1 built**, computes stance/blockers/alerts
- Coach modal — **built**, surfaces readiness ring + 5 signal rows + narrative card
- `coach-narrative` edge function (Haiku LLM call) — **built but not deployed**
- Phase 0 hardening: JWT auth, server-side rate limiting, spend cap, input validation — **not started**
- Phase 2: subjective daily feeling, VDOT history trend, aerobic efficiency trend, REM% signal
- Paywall: LLM narrative is premium. Rules-based stance is free.

**Status**: Phase 1 built. Needs edge function deployment, hardening (Phase 0), and paywall infrastructure before going live.

---

### FUTURE-04: Plan Swap — Change Goal Without Losing Progress

**What**: Allow users to switch plans (e.g. marathon to half, race mode to general fitness, or change race date) without losing accumulated physiology state (CTL, VDOT, historicWeeklyTSS, readiness history, Strava cache).

**Why it matters**: Users' goals change. Injury, schedule shift, or a new race means they need a different plan. Currently the only option is a full reset. The physiology state is already decoupled from the plan object (`s.wks`), so preserving progress is mostly about regenerating `s.wks` for the new goal while carrying forward fitness data.

**Open design questions**:
- Three swap types with different UX: (1) change race distance (marathon to half), (2) change race date (recompute phases), (3) switch modes (general fitness to race mode or vice versa). Which to support first?
- Should the current week's completed workouts carry into the new plan, or does the swap start fresh from "this week"?
- UI: settings page toggle, or a dedicated "Change Plan" flow?

**Status**: Needs design decisions before build.

---

### FUTURE-05: Block Summary — Training Phase Completion Report

**What**: When a user finishes a training block (phase), surface a summary of what they did, how fitness changed, and what's next.

**Why it matters**: Users complete base/build/peak/taper phases with no acknowledgement or reflection. A phase-end summary closes the loop, builds trust in the system, and primes the user for what's ahead.

**Open design questions**:
- Trigger: phase-end (base to build, build to peak, etc.) is the most defensible since phases already exist in the plan engine. Full plan completion (race day) is a second trigger.
- Content: volume/intensity summary, CTL delta, VDOT delta, adherence %, key workouts, coach narrative?
- Format: modal overlay, dedicated page, or push notification?

**Status**: Needs design decisions before build.

---

| Track | Doc | Effort | Status | Dependencies |
|---|---|---|---|---|
| FUTURE-01: Workout to Watch | [`WorkoutWatch.md`](WorkoutWatch.md) | 7-10 days (Garmin), 9-12 days (Apple) | Design complete, ready to build | Garmin: Workout Import permission. Apple: HealthKit entitlements |
| FUTURE-02: Triathlon Mode | [`TRIATHLON.md`](TRIATHLON.md) | Large (multi-week) | Architecture doc written, planning | User demand signal |
| FUTURE-03: The Brain | [`BRAIN.md`](BRAIN.md) | Phase 0-1: 1 week. Phase 2+: ongoing | Phase 1 built, needs deployment + hardening | Anthropic API key, paywall infra |
| FUTURE-04: Plan Swap | — | Medium | Needs design | — |
| FUTURE-05: Block Summary | — | Small–Medium | Needs design | — |

---

## Architectural Considerations

These are not bugs or features — they are design decisions to revisit as the product grows.

### CONSIDERATION-01: localStorage as primary store vs Supabase as source of truth

**Current architecture**: localStorage is primary (fast, offline-first). Supabase is a backup — `user_plan_settings` table is written on every `saveState()` and read only when localStorage is empty (plan lost / new device).

**Why this is fine for now**: Capacitor (mobile) localStorage persists until uninstall. The backup means no user ever loses their plan. Single-device usage is the norm.

**When to revisit**: When users request multi-device sync (phone + tablet, phone + web). At that point, flip the architecture: Supabase becomes the source of truth, localStorage becomes a read-through cache. The data flows already exist — it's a meaningful but not huge refactor.

**Do not build this until a real user asks for it.**

---

### ISSUE-198: mtl-by-discipline transient test failures *(P2, 2026-05-12)*

**Symptom**: In a 2026-05-12 session, `src/calculations/mtl-by-discipline.test.ts` reported 3 failures even when run in isolation:
- "produces separate CTL/ATL per discipline" — expected CTL 1, got 0 (EMA not accumulating)
- "CTL stays below ATL when load is rising" — expected CTL < 3, got 7.44 (ratio inverted)
- "respects currentWeekIndex limit" — expected defined value, got undefined

**Current state**: Tests pass 11/11 in isolation and 1726/1726 in the full suite on subsequent runs. The failures could not be reproduced after the session ended.

**Root cause hypothesis**: The failures coincided with an in-session MTL refactor ("MTL chronic/acute now read from completed work, not planned" — `computeMTLFitnessFatigueByDiscipline` rewrite landed in the same session). The tests likely ran against a mid-refactor code state where implementation and test expectations were momentarily inconsistent. The committed code is correct.

**What to watch**: If these tests start failing reproducibly again, the suspect is `computeMTLFitnessFatigueByDiscipline` in `src/calculations/mtl.ts` — specifically the EMA accumulation loop and discipline-bucket routing. Check whether `computeWeekActualMTLByDiscipline` is being called correctly with `matchedActivityId`-gated logic.

**Files**: `src/calculations/mtl.ts`, `src/calculations/mtl-by-discipline.test.ts`

---

### ISSUE-199: vo2-sources test pollution when run in full suite *(P2, 2026-05-12)* ✅ MOOT 2026-05-19

`src/calculations/vo2-sources.ts` and its test file were deleted when the "Sources disagree" banner on the VO2max detail page was removed (banner was redundant with the per-sport bars + Source toggle on the same surface). No more module, no more test pollution surface.

Original report kept below for reference.

---

### ISSUE-199 (original report): vo2-sources test pollution when run in full suite *(P2, 2026-05-12)*

**Symptom**: In a 2026-05-12 session, 3 tests in `src/calculations/vo2-sources.test.ts` failed only in the full suite (not in isolation):
- "returns no conflict when fewer than 2 sources available"
- "returns no conflict when sources agree within threshold"
- "includes device when s.vo2 > 0"

**Current state**: Tests pass 12/12 in isolation and in the full suite on subsequent runs. Not currently reproducible.

**Root cause hypothesis**: A test earlier in the suite is mutating the `getState()` singleton (likely setting `s.vo2` or `s.maxHR`) and not resetting it, leaving the shared state polluted when `vo2-sources.test.ts` runs. The MTL refactor that was in-progress during the same session is a likely candidate — it calls `getMutableState()` directly.

**What to watch**: If these become reproducible, run `npx vitest run --reporter=verbose` and look at which test file runs immediately before `vo2-sources.test.ts`. The polluter will have set a `vo2`-related field on the singleton without a matching `beforeEach` reset.

**Fix pattern**: The polluting test needs a `beforeEach(() => { getMutableState().vo2 = undefined; })` guard, or `vo2-sources.test.ts` needs to reset the relevant fields before each test rather than relying on a clean slate.

**Files**: `src/calculations/vo2-sources.test.ts`, unknown polluter (likely in `src/calculations/mtl*.test.ts` or `src/state/initialization*.test.ts`)
