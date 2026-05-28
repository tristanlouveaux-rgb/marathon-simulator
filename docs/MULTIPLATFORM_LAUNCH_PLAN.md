# Multi-platform launch plan (web + iOS, Garmin via upload)

**Created:** 2026-05-27 (autonomous session while Tristan was away).
**Status:** investigation complete and verified; foundation laid; all product/UX
decisions held for Tristan. No shared UI files or plan-generation logic were edited.

**Session 1 progress (2026-05-28):** D1 actioned (FIT/.zip import wired into the
onboarding data-source step via the shared modal). D5 partial (Strava parked
already; Garmin OAuth retained for recovery physiology — sleep/HRV/RHR — and
paired with an honest "Garmin can't auto-sync past runs, export and upload"
note that routes history through the upload modal). D6 actioned (Home guest
banner reframed around cross-device sync; lightweight post-import nudge for
anonymous users in onboarding — informational, since launching auth mid-wizard
would abandon the flow). See CHANGELOG 2026-05-28.

## The strategy (as Tristan framed it)

- Ship as a **multi-platform** product: one Vite codebase → web (Vercel) + iOS (Capacitor).
- **Apple Health** is the primary live source on iOS. **Strava/Garmin live sync is parked**
  (both are dev-account-only — see `docs/STRAVA_PARKED.md`).
- **Actively serve Garmin users** via manual upload: export FIT/GPX/TCX from Garmin Connect
  on a laptop, upload on the **web** app, and have it **flow into iOS**. The web surface is
  the natural home for laptop file upload; iOS picks it up via cloud sync.

## What is CONFIRMED working (verified this session)

1. **Cross-device sync is real.** `saveState()` → `savePlanSettings()` upserts the full
   state snapshot to Supabase `user_plan_settings.state_snapshot` keyed by `user_id`
   (`src/data/planSettingsSync.ts:48-72`). On a fresh device, `restorePlanFromSupabase()`
   rehydrates it (`src/main.ts:312-316`). So a run uploaded on web reaches iOS for the
   same logged-in user.
2. **One codebase, two targets.** Vercel project `mosaic-256r`; Capacitor `webDir: 'dist'`
   (`capacitor.config.ts:6`); `build:ios` reuses the web build (`package.json:7-8`).
3. **Anonymous auth + upgrade.** First web launch auto-creates an anonymous Supabase user
   (`src/main.ts:189`); `updateUser({email,password})` upgrades it preserving the same
   `user_id` (`src/ui/auth-view.ts:246`), so the same account opens on iOS.
4. **The file importer already works on web.** Standard `<input type="file">`
   (`src/ui/import-activity-modal.ts:50`), `file.arrayBuffer()/text()` — no native picker.
   A laptop user can pick a `.fit/.gpx/.tcx` today.
5. **Build is green.** `tsc --noEmit` clean, `npm run lint:ui` clean, full `vitest` suite
   exit 0 (2026-05-27, on top of the background logo/UX/sleep work).

## VERIFIED GAPS for the Garmin-web-upload story

These are confirmed against the code (not just agent claims). Each maps to a decision below.

1. **FIT import is not reachable during onboarding.** `openImportActivityModal()` is wired
   only from Account (`src/ui/account-view.ts:1820`); zero references in `src/ui/wizard/**`.
   Explicit `TODO(onboarding)` at `src/data/fitImport.ts:21` and `:635`. A new Garmin user
   on web cannot bootstrap their plan from a FIT file during sign-up. → **D1**
2. **Imported activities are not persisted to Supabase `garmin_activities`.**
   `importActivityFile()` calls `matchAndAutoComplete([row])` → `saveState()` → `render()`
   only (`src/data/fitImport.ts:677-682`). The activity rows DO travel inside the
   `state_snapshot` blob (so they reach iOS via plan sync), but they are invisible to any
   DB-backed view/derivation (`loadActivitiesFromDB`, the review pipeline's
   `fetchRecentActivities`, tri-benchmark derivation). → **D2**
3. **Imports don't feed planning signals.** `importActivityFile()` does not refresh VDOT
   (`refreshBlendedFitness`), `onboardingRunHistory`, `detectedWeeklyKm`, archetype, or
   `s.pbs`. `extractBestEfforts()` runs inside `streamsToActivityRow` and lands `best_efforts`
   on the row, but those are never fed back to `s.pbs`. Six months of imported runs show as
   completed activities but do not move the race prediction or benchmarks. → **D4**
4. **Manual-entry weekly volume does not seed the plan's starting volume.** CORRECTION to
   the agent's "volume is ignored": `manual-entry.ts:346` writes `s.detectedWeeklyKm`, which
   IS read by the archetype classifier (`athlete-archetype.ts:116`), forecast, and prediction.
   It is only excluded from setting `s.wkm` (plan starting volume) because the gate at
   `initialization.ts:537` (twin at `:338`) requires `stravaHistoryAccepted`, and that flag
   is set in exactly one place (`account-view.ts:1901`, the Strava "Use this" button). So a
   manual or import-only user's typed volume never seeds plan `s.wkm`; it falls back to the
   runs-per-week lookup (`initialization.ts:478`). Whether that's intended is a judgement call
   on a user-facing plan number. → **D3**
5. **Garmin OAuth during onboarding gives physiology, not run history.** Connecting Garmin
   pulls sleep/HRV/RHR via the webhook/backfill, but not historical activity FITs. A
   Garmin-connected-only web user still has an empty `garmin_activities` table and must
   import files or enter PBs. (Reinforces why upload is the Garmin path.)
6. **Anonymous data is device-local until upgraded.** If a web user imports runs, completes
   onboarding, but never upgrades the guest account, opening iOS fresh and signing in with a
   new email creates a different `user_id` — the web data is unreachable. No in-onboarding
   prompt warns that guest data is device-local. → **D6**

## Web-platform reality (degradations vs iOS)

Mostly graceful; flagged here so launch messaging is honest. (Source: platform-divergence
recon, file:line in session notes.)

- **Graceful / guarded:** HealthKit, HealthExtras, RevenueCat, native GPS, haptics,
  keep-awake, guided voice are all behind platform checks; on web they no-op or fall back.
  Apple Health button on the wizard shows a greyed "iOS app only" state, not a crash.
- **Genuinely degraded on web:** no background GPS (tab-hidden pauses tracking); no HealthKit
  data at all; **no in-app purchase of AI Coach on web** (RevenueCat is iOS-only; web
  entitlement falls back to the Supabase `subscription_active` row, so an iOS purchase carries
  to web, but you can't buy on web). → **D7**
- **Cosmetic on desktop:** portrait-tuned ring/atmosphere visuals in a landscape window;
  `user-scalable=no` blocks pinch-zoom; narrow ~460px column with large side gutters; no wide
  breakpoints. → **D7**

## DECISION QUEUE (nothing below was actioned)

Each has my recommendation, but the call is yours.

**D1 — Wire FIT import into onboarding?** Where/how?
*Recommendation:* Yes — it's the crux of the Garmin-web story. Add an "Upload your runs"
option on the connect step (the `connect-strava` wizard step) alongside "Enter manually",
reusing `openImportActivityModal()`. Open question for you: single-file vs multi-file/drag-drop
for a 6-month bootstrap, and whether import is a primary CTA or secondary to Apple Health.

**D2 — Persist imported activities to Supabase `garmin_activities`?**
*DECIDED (Tristan, 2026-05-27): DROP.* Investigation showed Apple Health (the primary
shipped source) does not write to `garmin_activities` either — it uses local state +
snapshot sync, identical to file import — and imports already reach other devices via the
snapshot. Writing imports to the table would make them inconsistent with the primary source
for no cross-device benefit.
*Known limitation accepted:* the triathlon benchmark auto-derivation (CSS/FTP from history)
reads `garmin_activities`, so it will not pick up imported-from-file tri history. This gap is
shared with Apple Health. Mitigation: users set their own FTP/CSS manually (and the
"benchmarks yield to derived improvements" rule still applies once live data arrives). If this
ever matters enough, the fix is the broader one — teach those derivations to read local state
— which helps Apple users too. Not launch-blocking.

**D3 — Should manual/import volume seed plan starting `s.wkm`?**
*Recommendation:* Likely yes — generalise the `initialization.ts:537` gate beyond
`stravaHistoryAccepted` (e.g. an explicit `volumeSource` provenance), so a typed or
import-derived weekly volume seeds `s.wkm`. This changes a user-facing plan number, so I
held it. Confirm intent first.

**D4 — Should imports feed VDOT / Tanda / archetype / PBs?**
*Recommendation:* Yes for VDOT/archetype/volume (run `refreshBlendedFitness` + recompute
after an import batch). PB auto-update from imported `best_efforts` is more delicate (PBs are
a benchmark with provenance; see the "Manually-set Benchmarks Yield to Improvements" rule) —
I'd surface a "we found a faster 10k, update your PB?" rather than silently overwrite.

**D5 — Parking UX: hide vs repurpose the connect surfaces?** (drives Phase 4 wiring)
*Recommendation:* Hide Strava entirely. For Garmin, **replace** the connect button with an
"Upload from Garmin Connect" affordance rather than hiding it, so Garmin users have a path.
Exact copy + layout is yours. This gates the `STRAVA_PARKED.md` wiring.

**D6 — Warn that guest data is device-local before upgrade?**
*Recommendation:* Add a lightweight "Save your account to sync across devices" prompt after a
web user imports runs / finishes onboarding, before they can lose it. Placement is a UX call.

**D7 — How much web polish for launch?**
*Recommendation:* Minimum honest baseline: allow pinch-zoom on desktop, and a clear note that
AI Coach purchase happens in the iOS app. Full responsive/landscape redesign is a bigger
project — probably post-launch. Your call on scope.
*PARTIALLY SHIPPED (Session 3, 2026-05-28):* (a) pinch-zoom: `applyWebViewportPolicy()` in
`src/main.ts` rewrites the viewport meta at runtime when `!isNative()` so desktop/web allow
zoom; iOS native keeps `user-scalable=no` untouched. (b) AI Coach iOS-purchase note: a card
on the classic coach view (`src/ui/coach-view.ts:getClassicCoachHTML`) gated on `!isNative()`
explains the subscription is bought in the iOS app and carries to web. The iOS paywall
deliberately stays untouched (Apple Guideline 3.1.1 — no external-payment steering).
*Still open under D7:* responsive/landscape redesign, wide breakpoints, large side gutters.

## Session 3 verification (2026-05-28)

Code-level verification of the web ↔ iOS round-trip and the guest-upgrade path. Runtime
device-pair test still pending (no iOS device in this session).

**Verified at code level:**

1. **Web → iOS round-trip.** A run imported on web via `importActivityFile`
   (`src/data/fitImport.ts:677-682`) lands in `s.wks[].garminActuals` and triggers
   `saveState()`, which fires `savePlanSettings()` fire-and-forget. The activity is included
   in the snapshot (not in `EXCLUDE_KEYS` at `src/data/planSettingsSync.ts:31-42`). On a
   fresh iOS launch with empty localStorage, `launchApp()` calls `restorePlanFromSupabase()`
   (`src/main.ts:330-336`) which writes the snapshot back, so the imported run appears.
2. **Guest → email upgrade preserves the same `user_id`.** `auth-view.ts:246` uses
   `supabase.auth.updateUser({email, password})` in place rather than `signUp`, keeping the
   anonymous user's id (confirmed at `src/main.ts:285-287`). USER_UPDATED is not handled by
   the auth listener so the local state is not relaunched/wiped — the guest's imported runs
   stay on disk and the same `user_plan_settings` row is now reachable from any device that
   signs in with the upgraded email.

**Newly documented gaps for launch:**

3. **Ongoing sync is initial-restore only, not continuous.** `restorePlanFromSupabase()` is
   gated on empty localStorage (`src/main.ts:331`). Once an iOS device has any state, a
   subsequent web upload will not propagate to that iOS device automatically — the iOS app
   does not re-pull the snapshot on launch or foreground. The cloud copy is last-writer-wins
   from whichever device saved most recently. **Implication for launch messaging:** the
   web → iOS flow is reliable for the first hand-off (set up on web, install on iOS), not
   for ongoing two-way merge. Either set expectations in copy ("Set up on the web, then
   continue on iOS") or follow up with a periodic resnapshot pull on iOS launch behind a
   conflict-resolution model. Not launch-blocking if framed honestly.
4. **Snapshot save is gated on `hasCompletedOnboarding`** (`src/data/planSettingsSync.ts:54`).
   A guest who imports during onboarding but bails before completing it leaves the import
   in localStorage only — never reaches the cloud. Acceptable for launch (completing
   onboarding is the natural close), but worth knowing if a partial-onboarding crash story
   is reported.
5. **Cross-device gap 6 (guest data device-local until upgrade) is unchanged.** D6's
   in-onboarding "Save your account" prompt is the canonical fix and lives in Session 1's
   scope. Until that ships, web-guest users must upgrade voluntarily before installing iOS.

## ASSUMPTIONS I made

1. "Park Garmin" from earlier turns means park the **live OAuth/webhook** path, NOT abandon
   Garmin users — reconciled with the new "build for Garmin users" directive as
   park-live + serve-via-upload. If you meant something else, D5 changes.
2. The web app is intended for real end-users (not just a dev preview), so web degradations
   matter for launch. If web is dev-only for now, D7 mostly drops.
3. I did not commit anything. All changes are uncommitted in the working tree for your review.

## Execution map (ready to run once decisions land)

- **Parking (Phase 4):** `docs/STRAVA_PARKED.md` has every gate site + the flags. One pass
  once D5 is decided.
- **Onboarding rework (Phase 2):** wizard step order in `src/ui/wizard/controller.ts:18`;
  the data-source step is the whole of `src/ui/wizard/steps/connect-strava.ts`; completion
  gate in `review.ts` (`refreshContinueGate`); routing flag `state.hasCompletedOnboarding`
  checked at `src/main.ts:855`. Onboarding does NOT currently require a connected source
  (manual path works), which is the right foundation for adding upload.
- **Import wiring (D1/D2/D3/D4):** `src/data/fitImport.ts` (`importActivityFile`,
  `streamsToActivityRow`) is the single integration point.

## Foundation laid this session (inert, no behaviour change)

- `src/constants/feature-flags.ts`: added `STRAVA_ENABLED` / `GARMIN_CONNECT_ENABLED`
  (default `true`, not wired).
- `docs/STRAVA_PARKED.md`: parking runbook.
- This file.
