# Launch build — copy-paste session prompts

The multi-platform launch build is being split across sessions. Each prompt below is
self-contained — paste one into a fresh Claude Code session. They assume `CLAUDE.md` and
the auto-memory load automatically.

**Already shipped + verified (do NOT redo):** import pipeline (D3 volume gate, D4 fitness
refresh, bulk archive import), Strava fully parked (`STRAVA_ENABLED=false`, one-flip revive),
and the screenshot-import CORE (`src/data/screenshotImport.ts`). Full detail in
`docs/MULTIPLATFORM_LAUNCH_PLAN.md` and the 2026-05-27 `docs/CHANGELOG.md` entries.

**Settled decisions (don't reopen):** D2 dropped; imported PBs auto-apply fastest-wins (no
prompt); Strava buried; Garmin = export-and-upload (not hidden); screenshot = hybrid OCR→AI.

**North star for common users:** the web → iPhone data flow. A user uploads runs on the web
app (laptop) and they sync to their iOS app via the Supabase state snapshot. This is the
primary path for users who can't use live Garmin/Strava sync. Keep it solid and verified.

---

## Session 1 — Onboarding rework + web→iOS flow (verifiable UI)

```
Mosaic launch build, Session 1: rework onboarding around upload + make the web→iPhone data
flow first-class. Read CLAUDE.md (esp. UI Pre-flight + UI Copy), docs/UX_PATTERNS.md, and
docs/MULTIPLATFORM_LAUNCH_PLAN.md before any UI code.

Context already built (don't redo): file import works (src/data/fitImport.ts —
importActivityFile for single files, importActivityArchive for Strava/Garmin export .zips);
Strava is parked behind STRAVA_ENABLED; cross-device sync works via
src/data/planSettingsSync.ts (state snapshot → Supabase → restore on iOS).

Tasks:
1. Re-theme the data-source onboarding step (src/ui/wizard/steps/connect-strava.ts). The
   Strava CTA is already gated off; the step's title/intro copy is still Strava-framed —
   rework it around: Apple Health (iOS primary), "Upload your runs" (primary on web, also
   iOS), and a Garmin "export-and-upload" path. Keep "Enter manually". Honest Garmin copy:
   Garmin doesn't let apps auto-sync history, but you own your data and can export it
   (garmin.com/account/datamanagement, takes a few days) and upload the .zip later.
2. Wire import INTO onboarding: reuse openImportActivityModal (src/ui/import-activity-modal.ts)
   for single files, and extend it to accept .zip and route to importActivityArchive vs
   importActivityFile. Today the modal is only reachable from Account (the fitImport.ts
   TODO(onboarding) calls this out).
3. D6 guest-sync prompt: after a guest/anonymous user imports or finishes onboarding, surface
   a lightweight "Save your account so your runs sync to your phone" prompt (links to the
   upgrade flow in src/ui/auth-view.ts). This protects the web→iOS flow from data loss.
4. Verify the web→iOS round-trip: a run imported on web lands in the snapshot
   (planSettingsSync), and restores on a fresh iOS launch.

Constraints: UI Pre-flight (name the existing pattern you model; <=2 non-neutral colours; no
emoji; no em dashes). Don't un-bury Strava. Onboarding must still complete with zero
connected sources (manual PB path).

Verify: npx tsc --noEmit; npx vitest run; npm run lint:ui. Walk the web onboarding → upload →
plan, and the guest-upgrade path.
```

---

## Session 2 — Screenshot capture (hybrid OCR→AI): native + edge + UI

```
Mosaic launch build, Session 2: complete the iOS-easy screenshot capture path. The CORE is
already built and tested — src/data/screenshotImport.ts (parseScreenshotText, parsedFromAIJson,
screenshotActivityToRow, commitScreenshotActivity). DO NOT rebuild it; build the engines + UI
that feed it. Approach is HYBRID: on-device OCR first, AI vision fallback. Read CLAUDE.md,
docs/UX_PATTERNS.md, src/data/screenshotImport.ts, ios-plugins/health-extras (plugin pattern),
and an existing supabase/functions/* (edge fn pattern).

Tasks:
1. Native Apple Vision OCR plugin (Swift): new Capacitor plugin modelled on
   ios-plugins/health-extras. One method recognizeText(imageBase64) -> string[] using
   VNRecognizeTextRequest (accurate, on-device, free). JS wrapper guarded by isIOS().
2. AI-vision fallback edge function (Supabase, model on the coach edge fn for auth/rate-limit):
   accepts the image, prompts a Claude vision model to return the ParsedScreenshotActivity
   JSON shape; client maps it via parsedFromAIJson. Add a light per-user cap (cost-conscious).
3. Hybrid orchestration: run OCR → parseScreenshotText; if confidence !== 'high' or fields are
   missing, call the AI fallback. Unit-test this orchestration.
4. Capture + confirm UI: image picker (standard file input works web + iOS), run the hybrid,
   show "We read 7.5 km, 42:34, avg HR 132 — correct?" confirm screen (editable), then
   commitScreenshotActivity. Wire entry points: Account ("Add from screenshot") and the iOS
   onboarding data-source step.

Notes: screenshots yield NO GPS route and per-km (not per-second) data — expected. Needs Xcode
to build the plugin and `supabase functions deploy` for the edge fn (flag these as the manual
verify steps).

Verify: npx tsc --noEmit; npx vitest run; npm run lint:ui. On device: OCR a real Strava/Garmin
screenshot end-to-end. Deploy + smoke-test the edge fn fallback.
```

---

## Session 3 — Web polish + cross-device hardening + pre-submission QA

```
Mosaic launch build, Session 3: web/desktop polish + verify the whole multi-platform flow
before submission. Read CLAUDE.md and docs/RUNBOOK.md.

Tasks:
1. Web pinch-zoom: allow zoom on desktop browsers only (index.html has user-scalable=no for the
   iOS app — adjust the viewport for non-native/web at runtime, don't change native behaviour).
2. "AI Coach is purchased in the iOS app" note on web (coach-view.ts / paywall) — RevenueCat is
   iOS-only, so web users can't buy in-app; a subscription bought on iOS still carries to web.
3. Cross-device hardening (the priority for common users): end-to-end test web→iOS and reverse —
   import on web, confirm it appears on iOS for the same account; confirm guest→email upgrade
   preserves data (same Supabase user_id). Document any gaps in docs/MULTIPLATFORM_LAUNCH_PLAN.md.
4. Run /mode-audit all and /persona-qa (focus the web user + Garmin-upload personas) and fix any
   P0/P1 findings.

Verify: npx tsc --noEmit; npx vitest run; npm run lint:ui. Manual web + iOS walkthrough of the
upload → sync flow.
```

---

## Also outstanding (yours, at the machine)

- **Phase 1 — iOS build / TestFlight:** `npx cap sync ios` (links the background-fetch native
  framework) → Archive → TestFlight.
- **Supabase MCP token** is stale (`list_tables` returned "token is malformed"). Refresh it if
  you want a session to inspect/modify the DB directly.
