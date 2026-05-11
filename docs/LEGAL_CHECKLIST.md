# Pre-Launch Legal Checklist

Run this before the first App Store submission. Curated from `~/Documents/ALL AI NOTES.docx` and Apple App Store Review Guidelines.

Cross-reference to launch strategy Phase 0 blockers: see `project_launch_strategy.md`.

---

## Public Pages (live before App Store submission)

- [x] **Privacy policy** — `public/privacy.html` exists. Verify it covers: data collected, third-party processors (Supabase, Strava, Garmin, Apple HealthKit, PostHog, OpenAI/Anthropic for coach), retention, deletion rights, contact email.
- [x] **Support page** — `public/support.html` exists.
- [ ] **Terms of Use** — `public/terms.html` is missing. Draft via Termly. Must cover: acceptable use, liability limits, no-warranty disclaimer for training advice, account termination, governing law.
- [ ] **Health disclaimer** — surface in onboarding *and* in the app footer. Required language pattern: "Mosaic is not a medical device. Consult a physician before starting any training programme."

## App Store Submission

- [ ] **Privacy nutrition label** — declare every category of data collected. Categories Mosaic touches: Health & Fitness (HRV, sleep, HR), Identifiers (user ID), Usage Data (analytics), Diagnostics (crash logs).
- [ ] **HealthKit plist entries** — `NSHealthShareUsageDescription` and `NSHealthUpdateUsageDescription` strings in `Info.plist` per launch_strategy Phase 0.
- [ ] **Strava data use compliance** — confirm Mosaic's use of Strava data complies with Strava's API agreement (no resale, no public display of other users' data).
- [ ] **Garmin data use compliance** — same for Garmin Connect Developer Program terms.
- [ ] **App Store Review Guidelines** — particularly §1.4 (Safety – Physical Harm), §3.1 (In-App Purchase), §5.1 (Privacy).

## GDPR & UK GDPR (required for EU/UK users)

- [ ] **Cookie / consent banner** on the marketing site if any non-essential analytics fire pre-consent.
- [ ] **Right to deletion** — in-app "Delete my account" flow that purges Supabase user data and tokens.
- [ ] **Data export** — user can request a JSON export of their data on demand.
- [ ] **Data Processing Agreements** — confirm Supabase, Strava, Garmin, OpenAI/Anthropic DPAs are in place (most are auto-signed at signup).
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
