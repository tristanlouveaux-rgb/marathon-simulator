# Device Test Checklist

Things that **only a real device can verify** — native plugins, iOS rendering, WKWebView perf — plus real-data dogfood paths. Web/node tests and browser walkthroughs cannot cover Tier 1.

**How to use**: when a new TestFlight build goes out, work the Tier 1 list first. Tick an item only after confirming it on device. Note the build number you verified it in. An item stays unchecked across builds until someone actually taps it on a phone.

Last reviewed against changelog: 2026-06-16 (covers work through the 2026-06-15 evening commit `5c4dea6`).

Also added 2026-10-05: items for load-accounting batch 1 and the onboarding Continue fixes (CHANGELOG 2026-10-05). The changelog between 2026-06-16 and 2026-10-05 has not been re-reviewed for this list.

---

## Tier 1 — Native, no other coverage exists

### Onboarding → connect data
- [ ] **Apple Watch tile auto-advances**: tap → approve HealthKit → wizard advances on its own (do NOT rely on the faint Continue link). `connect-data.ts:836` — *this is the bug a tester hit on V8 (build was cut 2 hrs before the fix).*
- [ ] **Apple no-data path**: device with no Health data → inline recovery card appears next to the tapped button (not page-bottom); "Open Settings" opens iOS Settings. `appleHealthSync.ts`, `healthExtras.ts`
- [ ] **Apple "Connecting…" deadlock**: tap Apple tile, switch to Garmin hub, re-tap "Connect Apple Health" quickly → no permanent spinner (20s timeout + in-flight guard). `appleHealthSync.ts:112`
- [ ] **HealthKit permission sheet appears at all** (an invalid type previously suppressed it for everyone).
- [ ] **Multi-watch sleep**: Garmin/Coros/Polar via Apple Health get real sleep stages, not hard-capped at 55/100.
- [ ] **Manual "Sync" pulls full history** (Account → Apple Watch → Sync): on a device with months of HealthKit workouts but sparse/empty ingested activity, one tap backfills the full window — rides, swims, runs — and bike/swim/run benchmarks re-derive from real activity (not the manual past-race anchor / watch VO2max). Diag line should read `pulled=N` with N > 0 and `first=true`. The fix for "had to reset to recover my training". `appleHealthSync.ts forceFullHistory`, `account-view.ts btn-sync-apple`.

### Apple Health data (2026-10-05, audit D4, X4)
- [ ] **Heart Rate permission, fresh install**: connect Apple Health → the HealthKit sheet lists Heart Rate; Settings → Health → Data Access & Devices → Mosaic shows a Heart Rate toggle. Record a Watch run → its activity shows avg HR, zones and an HR-based load, not a duration-only one. `appleHealthSync.ts CORE_READ_TYPES`
- [ ] **Heart Rate re-prompt, existing install**: on a phone connected under an earlier build (no Heart Rate toggle under Mosaic), the first launch after update shows one HealthKit sheet with Heart Rate; the second launch shows none. Workouts from the last 14 days regain HR load after the grant; Account → Apple Watch → Sync covers older ones. `ensureHeartRatePermissionRequested`
- [ ] **Sleep on the wake date**: after a night that starts before midnight, Sleep shows the full night, pre-midnight part included, on today's date, close to the Health app's Time Asleep, with no short phantom night on yesterday.
- [ ] **Time zones**: set the phone to Australia/Brisbane (UTC+10), then America/Phoenix (UTC−7). Morning resting HR and steps land on today; evening steps stay on today.
- [ ] **Steps not doubled**: walk with the iPhone in a pocket and the Watch on. Today's steps roughly match the Health app's Steps total, not double it.
- [ ] **No freeze**: open the app in the morning, walk, reopen in the evening. Steps and sleep have updated.
- [ ] **90-day boot read completes**: on a phone with months of data, the Apple physiology diag shows a non-zero `steps=` and no `hung@reads`, and launch is not visibly slower (`limit: 0` now reads every raw step sample).
- [ ] **Garmin + Apple**: for a Garmin-primary user with Apple connected, Garmin's sleep score and resting HR are never replaced by Apple values. `physiology-provenance.ts`

### Onboarding Continue gates (2026-10-05, `16cca9e`, `0dec641`)
- [ ] **Custom race date**: Running → event Yes → Marathon → "Other / enter date manually". Dates under about 8 weeks are greyed out in the picker. Spin the wheel to about 16 weeks out: the picker stays open, "16 weeks of training" appears, and Continue advances on the first tap. Clear the field: Continue disables again. `race-target.ts`
- [ ] **HYROX previous time**: pick a race, type 1:12:30 in Previous Hyrox time, tap outside. Above Continue: "Pick the format your previous time was set in to continue." Tap Continue: the page scrolls to the four format pills. Pick one: Continue advances. Then type "1:12": the field asks for h:mm:ss and Continue names the previous time. `hyrox-setup.ts`
- [ ] **Triathlon past race**: tick the box, choose a month, type 5 / 32 in the time boxes (the digit keypad appears), skip the distance, tap Continue. The page scrolls to Race distance and shows "Pick the race distance to continue." inside it and above Continue. Pick 70.3: Continue saves. `tri-past-race.ts`
- [ ] **Manual entry first tap**: Running, skip Strava, level Intermediate. Type 5K 18:30 and tap Continue with the keyboard still up: it advances on the first tap. Type "18.30" instead: it stays, the field shows the format error, the hint shows under Continue, and the page scrolls to the field. `manual-entry.ts`
- [ ] **Review PB edit**: running, no PB yet. Tap the 5K row, type 22:30, press Return: the time saves and Build enables. On a fresh run, tap Build straight after typing: it advances with the time saved. Type "22.30": "Use mm:ss, e.g. 22:30, to continue." appears while typing. `review.ts`

### Native OAuth (needs a fresh archive — plugin change)
- [ ] **Strava connect** via `ASWebAuthenticationSession` returns cleanly, app stays alive, no `invalid_state` JSON page. `oauth-native.ts`
- [ ] **Garmin connect**, same path.
- ⚠️ The `@mosaic/web-auth` plugin needs a TestFlight **repush**: confirm the build was archived *after* `cap sync ios`, or it silently falls back.

### GPS / record (arm-gate)
- [ ] **Start a run**: GPS "acquiring" → confirm-tap starts the clock only after lock; distance is NOT 0.00 km (the `changePace(true)` fix). `GpsTracker`, `record-view.ts`
- [ ] **Motion denied**: behaviour is sane, not a stuck "acquiring" state.

### iOS-only rendering / physics
- [ ] **Overscroll bounce** feels native on a fling (top and bottom).
- [ ] **Safe-area**: scroll the detail views (leg-load, freshness, load-taper, sleep, mtl-load, injury-risk, strain, rolling-load, readiness, recovery) on a Dynamic-Island phone → sticky headers pin below the notch, not under it.
- [ ] **Activity Review overlay** header clears the status bar.
- [ ] **Foreground-resume**: background overnight, reopen → sleep/physiology refreshes (not stale). `physiologySync.ts`

### Perf (device-only — WKWebView re-raster cliffs)
- [ ] **Tab switching**: glass cards don't re-animate/jump on every switch; entrance plays once per session.
- [ ] **Forecast tab**: cards fade in, don't "jump up and out"; background drift is smooth.
- [ ] **Onboarding intro/transitions**: no ring-scale lag on iPhone.

---

## Tier 2 — Logic shipped, dogfood with real data

Have test coverage, but real-data confirmation is worth it.

- [ ] **Marathon plan shape** (ISSUE-286): real 18-wk plan peaks ~wk 11–14, long run builds toward 30 km, smooth base→build→peak→taper arc — not peaking at week 2. `plan_engine.ts`
- [ ] **No-data predictions**: marathon-only / 5K-only user not predicted slower than their PB; no "Faster than 81%" or phantom percentiles off a bare VDOT.
- [ ] **Readiness week 1**: fresh install, log terrible sleep (~25) → readiness actually drops, not flat "65 On Track".
- [ ] **Race goal persistence**: set a goal, change runner type / add sessions / toggle mode → goal survives. `initialization.ts`
- [ ] **Wizard STEP_ORDER**: onboarding does not crash on the review-step path (TDZ fix).
- [ ] **Button depth**: press-in feedback on all CTAs; RPE glass slider works.
- [ ] **Coach-contract step**: after plan reveal, graphics reflect the real plan (phase ribbon, volume ramp, session mix).
- [ ] **Mid-week onboarding** (all modes): onboard on a **Wednesday** → Plan + Home week 1 start today (no blank Mon/Tue cards, none marked Missed); a run logged earlier this week still credits to load. Onboard on a **Saturday** → week 1 is a chill 1–2 session lead-in, first full week is the following Monday. After advancing to week 2, the onboarding week's adherence does not show a false penalty. `dropPreOnboardSessions`, `plan-adherence.ts`, `events.ts`

**Load-accounting batch 1 (2026-10-05)**: unit-tested, needs real data.

- [ ] **Deload week target** (running): on a plan-engine deload week, the Plan week-summary Training Load target is lower than the week before (about 0.70× baseline vs about 1.08×), and the debrief for that week, done to plan, does not read about 70%. `planned-week-target.ts`
- [ ] **Taper target**: in a 3-week race taper the target steps down each week and Load & Taper shows the same number as the Plan card. Monday of the first taper week after peak weeks done to plan: Training Load starts at 0, not about 80. Load & Taper opened on a future week shows 0 actual. (Race week moves to 0.55 when batch 2 lands, ISSUE-317.)
- [ ] **Stats forecast = Plan card**: Stats → Forecast load chart, the dashed value for the current week equals the Plan card target. Continuous mode: the 4th week of a block shows the deload target.
- [ ] **Cross-training does not lift running fitness**: sync a ride or swim that lands as excess load. Stats "Running fitness" does not jump, and the Load & Taper Running row matches the headline. Run more than 1.3× a km-described easy run: the Running row equals that run's TSS, with no surplus on top. `listWeekSignalAEntries`
- [ ] **Removed activity leaves no excess record**: remove a synced cross-training activity with ×; the carry-over card ("Unresolved load from last week") no longer counts it and the Adjust plan modal no longer references it. The Tier 2 excess card is not rendered, so there is nothing to check there. `removeGarminActivity`
- [ ] **Strength week not "behind plan"**: week rollover after completing every planned run and strength session. The debrief shows no behind-plan line and next week's volume is not reduced. `resolveCtlAdherence`
- [ ] **Apple + Strava twin counts once**: Apple Watch or Garmin user who also syncs Strava logs a cross-training session that lands as adhoc; when the Strava copy arrives, the Strain view lists it once, today's strain does not rise, and that night's sleep target does not jump.
- [ ] **ACWR without a seed**: on a state with no `signalBBaseline` (fresh Apple install with Health granted after onboarding, or a guided-session-only phone user), plan days 0–13: Readiness hides the 7-Day Rolling Load card and the Load Ratio page says "Insufficient data", also after a plan rebuild. Days 14–20 with steady training: the ratio reads about 1.0, no "Load spike detected" banner on the next week, and the session-generator caption does not show a single-digit Readiness. `computeRollingLoadRatio`
- [ ] **Rolling Load drill-down = Readiness card**: open it from the Readiness card (and in triathlon from Discipline Readiness): 7d, 28d average and label equal the card, and the chart starts at the first recorded day.
- [ ] **Replaced run is not a 1-TSS day**: running plan, accept Replace on today's easy run after a ride. The Home strain ring shows a rest-day or activity-day target (not "Target 1 TSS"), no "Big session today" from steps, and the Readiness strain card shows no 4-digit percent. Tri: push a session and its day's strain target drops to rest. `computePlannedWorkoutSignalBTSS`
- [ ] **Plan card planned load**: expand a matched easy run on the Plan tab: the Planned vs Actual bar is near 100% green at a Z2 effort, and "View full activity" shows the same planned number in "Load vs plan". `planCardPlannedTSS`
- [ ] **Benchmark check-in** (continuous plan, week 5/9/13): pick a check-in. The popup does not come back, an "Added" Check-in card appears today, weekly load and today's strain do not jump until the run syncs, and Remove on the card brings the check-in prompt back. `benchmark-overlay.ts`
- [ ] **Female TSS**: female profile with max HR, resting HR and LTHR set. A run synced after onboarding reads about 1.23× the previous build (an hour near threshold reads close to 100), and the strain ring, activity detail and Stats agree. Male or unset profile: unchanged from the previous build. `getNormalizerFromState`
- [ ] **HR edit applies without relaunch**: Account → edit Max HR (+6 bpm) and save. Without relaunching, Strain and activity detail TSS change at once and match. `bindAthleteNormalizerToState`
- [ ] **Female Strava onboarding**: fresh install as a woman, connect Strava, answer Female in about-you, finish the wizard. A pre-onboarding Strava run near threshold reads close to 100 TSS per hour, not about 123. Known exception: if the Strava profile has no sex set, rows from the connect-step 28-day sync still carry the male β (batch 2 fix, ISSUE-318).
- [ ] **Fast-finish long run on Sunday**: running marathon or half plan, a peak week (or any week with "Long Run (Fast Finish)"). It sits on Sunday with its title and "last N @ MP" description on the Plan card and Home; Tue/Thu hold the quality sessions; Skip on it shows the "Skip Long Run?" warning. `isLongRun`
- [ ] **Triathlete VDOT stable across launches**: triathlon (or HYROX) account with run VDOT under 45 in a taper week. Force-quit and relaunch twice: the tri forecast run leg and the plan's easy pace do not change. `persistence.ts loadState`
- [ ] **Typed race date on desktop web**: desktop Safari or Firefox, triathlon setup "Other / enter date manually", type a date; same for the HYROX custom date and the running marathon custom date (6 weeks out shows "Marathon plans need at least 8 weeks. This date is 6 weeks away."). Continue enables (or explains) while the cursor is still in the field.

---

## Verified log

Record build number + date as items pass on device.

| Item | Build | Date | By |
|------|-------|------|-----|
| _(none yet)_ | | | |
