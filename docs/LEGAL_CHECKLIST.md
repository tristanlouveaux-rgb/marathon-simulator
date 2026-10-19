# Pre-Launch Legal Checklist

Run this before the first App Store submission. Curated from `~/Documents/ALL AI NOTES.docx` and Apple App Store Review Guidelines.

Cross-reference to launch strategy Phase 0 blockers: see `project_launch_strategy.md`.

---

## Public Pages (live before App Store submission)

- [x] **Privacy policy** — `public/privacy.html` updated 2026-05-17. Names Anthropic + Claude Haiku, lists sub-processors (Supabase, Strava, Garmin, Apple, Anthropic), covers commute drift / route detection, GDPR rights, in-app deletion path. ICO complaint link added.
- [x] **Support page** — `public/support.html` updated 2026-05-17 with in-app deletion + export pointers.
- [x] **Terms of Use** — `public/terms.html` drafted 2026-05-17. Acceptable use, no-warranty for training advice, liability cap (£50 or 12-month spend, whichever greater), AI Coach informational clause, UK governing law. Linked from privacy policy and in-app Account view.
- [x] **Health disclaimer** — App Store §1.4. Surfaced two places: (1) one-time launch modal that fires for new users post-wizard and for existing users on the next launch (`src/ui/health-disclaimer.ts`), persisted via `state.healthDisclaimerAcknowledged`; (2) quiet footer caption beneath the Legal & data section in Account view. Copy: "Mosaic is not a medical device. Consult a physician before starting any training programme. Mosaic's recommendations are informational; you are responsible for your own training decisions."

> **Submission-time URL note (ISSUE-244)**: When entering URLs in App Store Connect (Privacy Policy, Terms, Support), use the `www.` prefix — `https://www.mosaicrunning.run/privacy.html`, `/terms.html`, `/support.html`. The apex (`mosaicrunning.run`) 307-redirects to the `www.` subdomain, which has tripped previous App Review checks. Apex resolves fine in browsers but the review tooling has occasionally flagged it.

## App Store Submission

- [x] **Privacy nutrition label** — declared in `docs/PRIVACY_NUTRITION_LABEL.md` (entered into App Store Connect at submission). Categories: Email, Health & Fitness (Health + Fitness), Location (precise), User Content (AI Coach messages + support email + notes), Identifiers (user ID), Diagnostics (crash + performance). No tracking.
- [x] **HealthKit plist entries** — only `NSHealthShareUsageDescription` is present in `ios/App/App/Info.plist` (ISSUE-240, 2026-05-18: `NSHealthUpdateUsageDescription` removed because Mosaic never writes to Apple Health — keeping a usage string explaining why a key exists is a known App Review trigger). HealthKit entitlement file at `ios/App/App/App.entitlements`; `CODE_SIGN_ENTITLEMENTS = App/App.entitlements;` set on both Debug and Release configs in `project.pbxproj`. Open Xcode once before submission to confirm the HealthKit capability is registered against the provisioning profile.
- [ ] **Strava data use compliance** — confirm Mosaic's use of Strava data complies with Strava's API agreement (no resale, no public display of other users' data).
- [ ] **Garmin data use compliance** — same for Garmin Connect Developer Program terms.
- [ ] **App Store Review Guidelines** — particularly §1.4 (Safety – Physical Harm), §3.1 (In-App Purchase), §5.1 (Privacy).

## GDPR & UK GDPR (required for EU/UK users)

- [ ] **Cookie / consent banner** on the marketing site if any non-essential analytics fire pre-consent. (Marketing site `marketing/` is currently untracked; revisit after content lands.)
- [x] **Right to deletion** — in-app `Delete account` row in Account view (2026-05-17). Self-serve confirmation modal (typed "DELETE") → `delete-account` edge function → marks `deleted_at = now()` with 30-day grace period (matches `privacy.html` promise). Daily `purge-deleted-accounts` cron hard-deletes user rows and the `auth.users` record after the grace window. Edge functions ship as a follow-up commit (Phase 3 plan). 2026-10-13: the HYROX Doubles partner tables are added to `delete-account` in source (`49b92bf`), not deployed (RUNBOOK, HYROX Doubles partner tables); the app deletes partner rows itself on account deletion meanwhile, and the 30-day purge cascades them.
- [x] **Data export** — in-app `Download my data` row in Account view (2026-05-17). Calls `export-user-data` edge function which returns a JSON file aggregating user rows (with tokens stripped). Edge function ships as a follow-up commit (Phase 6 plan). 2026-10-13: the HYROX Doubles partner tables are added to `export-user-data` in source (`49b92bf`), not deployed (RUNBOOK, HYROX Doubles partner tables); until the deploy the export file has no partner tables.
- [ ] **Data Processing Agreements** — confirm Supabase, Strava, Garmin, Anthropic DPAs are in place (most are auto-signed at signup).
- [ ] **Cookies on marketing site** — disclose any cookies (PostHog, etc.) and gate non-essential ones behind consent.

## IP

- [ ] **Trademark check**: "Mosaic" — already established the name is clear for fitness app context. Re-confirm at submission time.
- [ ] **No copyrighted music or imagery** in marketing assets without licence (royalty-free libraries or AI-generated only).

## Analytics Declaration

Required for App Store privacy nutrition + GDPR transparency. Mosaic's planned analytics (per launch_strategy):

- PostHog — wizard funnel, Strava connect, plan view, coach chat, rate limit hit, upgrade tapped.
- Apple App Store Connect (built-in) — install, uninstall, crash, retention.

Declare both. No third-party ad networks (no Facebook SDK, no Google Analytics on the app itself).

## Payments (when Tier 2 ships)

- [ ] **StoreKit IAP** — per launch_strategy, not RevenueCat unless Android lands.
- [ ] **Restore purchases** flow tested.
- [ ] **Subscription terms** disclosed in the IAP screen and Terms of Use: price, renewal cadence, cancellation path.

## Apple Small Business Programme

- [ ] **Apply** — reduces Apple's commission from 30% to 15% if Mosaic earns under $1M/year. No reason not to.
  - Reference: https://developer.apple.com/app-store/small-business-program/

---

## Pre-Submission Audit

- [ ] All checkboxes above ticked or explicitly deferred with a reason.
- [ ] Privacy policy + Terms of Use linked from onboarding, settings, and the marketing site footer.
- [ ] Data deletion flow manually tested end-to-end.
