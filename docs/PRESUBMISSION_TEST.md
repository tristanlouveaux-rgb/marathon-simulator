# Pre-Submission End-to-End Test

Run this script against the App-Store-bound branch before submitting Mosaic to App Review. Every box must be ticked. Anything that fails blocks submission.

Use a real device (or iOS Simulator with a fresh state — wipe localStorage and Supabase rows for the test user first).

Reference checklists:
- `docs/SECURITY_CHECKLIST.md`
- `docs/LEGAL_CHECKLIST.md`
- `docs/PRIVACY_NUTRITION_LABEL.md`

---

## Pre-flight (developer machine)

- [ ] `git status` is clean on the App-Store-bound branch (no untracked secrets, no stray .env).
- [ ] `npx tsc --noEmit` exits 0.
- [ ] `npx vitest run` — all tests green (or every failure has a one-sentence justification in the PR description).
- [ ] `npm run lint:ui` — no new violations vs baseline.
- [ ] `npx vite build` — succeeds, no warnings beyond chunk-size advice.
- [ ] `grep -r "sk_live\|sk-ant-\|service_role\|ANTHROPIC_API_KEY" dist/ ios/App/App/public/` returns zero hits.
- [ ] `npm audit --omit=dev` — no high/critical advisories on **runtime** dependencies. (Build-time deps like `@capacitor/cli` may have advisories; document any exceptions in `SECURITY_CHECKLIST.md`.)
- [ ] `npx ecc-agentshield scan ~/.claude` clean (per `memory/reference_agentshield_prelaunch.md`).

## Xcode setup

- [ ] Open `ios/App/App.xcworkspace` in Xcode.
- [ ] Target App → Signing & Capabilities → **HealthKit** capability is present (added by the entitlements file at `ios/App/App/App.entitlements`). If not, click `+ Capability` → HealthKit, then re-archive.
- [ ] `Info.plist`: location, motion, HealthKit strings read honestly and match what the app actually does.
- [ ] Bundle identifier: `com.mosaic.training`. Version + build number bumped.
- [ ] Signing team is the production team.

## On-device smoke test

Open the app fresh on a real iPhone (or Simulator).

### 1. First-launch flow

- [ ] App opens directly into the onboarding wizard.
- [ ] Every wizard step renders; "Continue" is enabled only when valid.
- [ ] After the final wizard step, the **health disclaimer modal** appears with the tick checkbox and "Continue" CTA.
- [ ] Without ticking, "Continue" is disabled. After ticking, it's enabled and the modal dismisses on tap. The user lands on the plan/main view.
- [ ] Reload the app — the disclaimer does NOT re-appear (it's been acknowledged).

### 2. AI Coach consent

- [ ] Tap into the Coach tab for the first time.
- [ ] **"Before we start" modal** appears, names **Anthropic Claude (Haiku model)** explicitly, and links to the privacy policy.
- [ ] Tap the link → external browser opens `https://mosaicrunning.run/privacy.html`. Confirm it loads and lists Anthropic in the sub-processors table.
- [ ] Dismiss the consent → coach chat works.
- [ ] Reload the app and re-open Coach → consent does NOT re-appear.

### 3. Strava connect

- [ ] Account → Strava → tap Connect.
- [ ] OAuth flow completes, returns to app, shows Connected.
- [ ] Activities sync within a few seconds.

### 4. Garmin connect (optional path)

- [ ] If the test account has Garmin, Account → Garmin → Connect → OAuth flow → Connected.
- [ ] Webhook delivery: trigger a Garmin sync from the watch, confirm a daily_metrics row appears.

### 5. Coach chat allowlist gate

- [ ] As an **allowlisted** user (`ALLOWED_USER_IDS` env var): coach chat streams a response.
- [ ] As a **non-allowlisted** user: the client receives a 402 `subscription_required` response and shows the locked state. No request reaches Anthropic.

### 6. Legal & data section (Account view)

- [ ] Account → scroll to **Legal & data**.
- [ ] Tap **Privacy policy** → external browser opens privacy.html. Confirm "Last updated 17 May 2026" or later.
- [ ] Tap **Terms of use** → external browser opens terms.html. Confirm health disclaimer is in section 3, AI Coach clause in section 6.
- [ ] Tap **Download my data** → JSON file downloads (or share sheet appears on iOS). Open it — confirm `meta.user_id` matches, no `access_token` strings present.
- [ ] Footer disclaimer text reads "Mosaic is not a medical device…" — present beneath the section.

### 7. Account deletion (the most critical App Review gate)

Run this with a **test account** — the data is real and will be purged.

- [ ] Account → Legal & data → **Delete account**.
- [ ] Modal opens. Primary button is disabled until "DELETE" is typed.
- [ ] Type "DELETE" → tap the primary button → loading state appears.
- [ ] On success: app signs out, returns to auth view, brief toast announces the purge date (30 days out).
- [ ] DB check (Supabase dashboard SQL): `SELECT deleted_at, user_id FROM user_plan_settings WHERE user_id = '<test-id>';` — `deleted_at` is set; row is invisible to client SELECT.
- [ ] Strava revocation check: log into strava.com → Settings → My Apps — Mosaic should be revoked. (If not, fallback purge still runs in 30 days.)

### 8. Cancel-deletion banner

- [ ] Sign back in with the same test account.
- [ ] Red banner appears at top: "Account deletion scheduled. Permanently deleted on `<date>`." with **Cancel** + dismiss buttons.
- [ ] Tap **Cancel** → spinner → page reloads → banner gone. Confirm DB: `deleted_at IS NULL`. Confirm the app works normally.
- [ ] Re-trigger deletion. Sign back in. Tap the **dismiss** ✕ button — banner clears, but `deleted_at` remains set (user can still cancel later via Account view).

### 9. Hard-purge dry run

- [ ] Invoke the cron manually: `supabase functions invoke purge-deleted-accounts --no-verify-jwt --header "x-cron-secret:<vault secret>"`.
- [ ] Response JSON: `processed`, `purged`, `failed` counts. Test row's user_id appears in `results` with `status: "purged"`.
- [ ] DB check: `SELECT * FROM auth.users WHERE id = '<test-id>';` returns 0 rows. Same for `user_plan_settings`, `strava_tokens`, `garmin_tokens`, `daily_metrics`, etc.
- [ ] App side: try to sign in with the deleted account — should fail or auto-create a brand-new anonymous user.

### 10. Permission prompts

Fresh-state device walkthrough:
- [ ] First run prompts NSLocationWhenInUseUsageDescription with the wording from Info.plist.
- [ ] If background tracking ever requested: NSLocationAlwaysAndWhenInUseUsageDescription wording matches Info.plist.
- [ ] NSMotionUsageDescription appears at appropriate moment.
- [ ] Apple Health: NSHealthShareUsageDescription appears, lists the metrics honestly. NSHealthUpdateUsageDescription appears once (with the honest "does not write" wording).

### 11. Sign-out and re-sign-in

- [ ] Account → Sign Out → auth view.
- [ ] Sign in with a different account (or anonymous) → plan state changes accordingly. No data leak from the previous user.

### 12. Apple Health (if test device has HealthKit data)

- [ ] Account → physiology source → Apple → permission prompts pass.
- [ ] Workouts sync. Sleep / HR / HRV / RHR populate the readiness view.

---

## After all boxes ticked

- [ ] Tag the commit: `git tag -a v1.0.0-rc1 -m "Pre-submission build"`.
- [ ] Archive in Xcode → upload to App Store Connect.
- [ ] Enter privacy nutrition label per `docs/PRIVACY_NUTRITION_LABEL.md`.
- [ ] Submit for review. Note in the App Review notes section the demo account, where to find the Coach gate, and that the AI Coach is subscription-gated (currently allowlist).

If anything in this script fails: fix it, re-run the affected section, then continue. Do not submit with known-broken flows.
