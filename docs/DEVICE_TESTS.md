# Device Test Checklist

Things that **only a real device can verify** — native plugins, iOS rendering, WKWebView perf — plus real-data dogfood paths. Web/node tests and browser walkthroughs cannot cover Tier 1.

**How to use**: when a new TestFlight build goes out, work the Tier 1 list first. Tick an item only after confirming it on device. Note the build number you verified it in. An item stays unchecked across builds until someone actually taps it on a phone.

Last reviewed against changelog: 2026-06-16 (covers work through the 2026-06-15 evening commit `5c4dea6`).

---

## Tier 1 — Native, no other coverage exists

### Onboarding → connect data
- [ ] **Apple Watch tile auto-advances**: tap → approve HealthKit → wizard advances on its own (do NOT rely on the faint Continue link). `connect-data.ts:836` — *this is the bug a tester hit on V8 (build was cut 2 hrs before the fix).*
- [ ] **Apple no-data path**: device with no Health data → inline recovery card appears next to the tapped button (not page-bottom); "Open Settings" opens iOS Settings. `appleHealthSync.ts`, `healthExtras.ts`
- [ ] **Apple "Connecting…" deadlock**: tap Apple tile, switch to Garmin hub, re-tap "Connect Apple Health" quickly → no permanent spinner (20s timeout + in-flight guard). `appleHealthSync.ts:112`
- [ ] **HealthKit permission sheet appears at all** (an invalid type previously suppressed it for everyone).
- [ ] **Multi-watch sleep**: Garmin/Coros/Polar via Apple Health get real sleep stages, not hard-capped at 55/100.

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

---

## Verified log

Record build number + date as items pass on device.

| Item | Build | Date | By |
|------|-------|------|-----|
| _(none yet)_ | | | |
