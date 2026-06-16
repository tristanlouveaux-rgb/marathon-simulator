Note: we have had a persistence problem of open issues not being correctly logged after long conversations. Going forward can we make it clear with answers to all questions put in here in order to most clearly reflect desired set up
# Open Issues

> **Workflow**: Tristan logs raw bugs/observations in `.claude/TL thoughts`.
> Claude reads that file, triages, and maintains this structured list.
> P1 = broken or actively misleading · P2 = confusing/unclear · P3 = missing feature/future
> **UX overhaul items** are tagged `[ui-ux-pro-max]` — handled via that skill in a dedicated session.

---

### ISSUE-287: Short plans (≤12 weeks) front-load the LOAD-chart peak to ~week 5 *(P2, 2026-06-16)* — diagnosis corrected, fix NOT started

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

### ISSUE-274: HYROX forecast run-pace drill-down shows marathon training pace zones *(P1, 2026-06-05)*

`hyrox/forecast-chip-detail-view.ts:285-296` renders "Training pace zones" with Easy/Marathon/Threshold/Interval/Rep paces from `s.pac` — marathon-centric zones that contradict the HYROX coaching model (Critical Pace). Fires for any HYROX athlete with running history. Fix: gate the card on `s.eventType !== 'hyrox'` or build a Critical-Pace-based equivalent.

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

### ISSUE-230: Reviewer demo account is placeholder text *(P0, 2026-05-18)*

`docs/APP_STORE_ASSETS.md:124` has literal `<email> / <password>` placeholders for App Store Connect sign-in info. The app is empty without 16w of Strava history, so reviewers without working credentials + pre-seeded data cannot evaluate any meaningful surface.

**Fix decision (Tristan, 2026-05-18)**: Tristan creates `reviewer@mosaicrunning.run` account → logs in → connects a Strava account with ≥16 weeks of activities (his own or a dedicated reviewer Strava) → lets the data sync. Then pastes email + password + the note "This account has Strava pre-connected — allow 30 seconds after sign-in for activities to load" into App Store Connect review notes. Manual task for Tristan, not a code change.

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
