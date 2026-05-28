# App Store Privacy Nutrition Label — Mosaic

This document is the source of truth for the privacy nutrition label that must be entered into App Store Connect at submission time. It maps every category Apple expects to what Mosaic actually does. Update this file whenever a new integration or data flow is added; then mirror the change in App Store Connect.

Reference: [Apple — App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/).

---

## How to read this document

For every data category Apple lists, we answer four questions:

1. **Collected?** — yes/no, with what evidence.
2. **Linked to user?** — yes if stored against a `user_id`; no if anonymous/aggregated.
3. **Used for tracking?** — yes if shared with a data broker or used to follow the user across other apps and websites. Always **no** for Mosaic — we do no advertising and no cross-app tracking.
4. **Purpose** — Apple's six-option enum: App Functionality / Analytics / Product Personalization / Developer's Advertising or Marketing / Third-Party Advertising / Other.

---

## Contact Info

| Type | Collected? | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Name | **No** | — | — | — |
| Email Address | **Yes** (only if user creates an email account; anonymous accounts skip this) | Yes | No | App Functionality (authentication) |
| Phone Number | No | — | — | — |
| Physical Address | No | — | — | — |
| Other User Contact Info | No | — | — | — |

## Health & Fitness

| Type | Collected? | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Health (HR, HRV, RHR, VO2 max, sleep, body weight, age, biological sex) | **Yes** (Strava + Garmin + Apple Health + manual entry) | Yes | No | App Functionality (training plan, readiness, recovery scores) |
| Fitness (activity history, training load, race goals, PBs) | **Yes** (Strava + Garmin + manual) | Yes | No | App Functionality |

**Notes**: Apple Health data is read on-device only. Strava and Garmin data is synced to Supabase. Manual entry goes to Supabase. All linked to user. Never sold, never shared with brokers.

## Financial Info

| Type | Collected? | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Payment Info | No (currently free tier only; revisit if/when subscription launches via StoreKit) | — | — | — |

**Note**: When Tier 2 subscription ships via StoreKit, no payment data reaches Mosaic — Apple handles it. This row stays "No".

## Location

| Type | Collected? | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Precise Location | **Yes** (Strava-sourced GPS routes when user authorises Strava; live GPS during in-app recording sessions) | Yes | No | App Functionality (route display, splits, commute drift detection) |
| Coarse Location | No | — | — | — |

**Note**: GPS routes are stored in Supabase. Commute drift detection compares declared commute start/end to actual route patterns; only summary points and a drift flag are stored, never raw third-party routes beyond what Strava already provides.

## Sensitive Info

| Type | Collected? | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Racial / ethnic data | No | — | — | — |
| Sexual orientation | No | — | — | — |
| Pregnancy or childbirth | No | — | — | — |
| Disability | **No** (we collect injury/illness flags but they are not formal disability data) | — | — | — |
| Religious or philosophical beliefs | No | — | — | — |
| Trade union membership | No | — | — | — |
| Political opinion | No | — | — | — |
| Genetic information | No | — | — | — |
| Biometric data (for identification) | No | — | — | — |

## Contacts

| Type | Collected? |
|---|---|
| Contacts | No |

## User Content

| Type | Collected? | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Emails or Text Messages | **Yes** (AI Coach chat messages — sent to Anthropic to generate responses) | Yes | No | App Functionality |
| Photos or Videos | No | — | — | — |
| Audio Data | No | — | — | — |
| Gameplay Content | No | — | — | — |
| Customer Support | **Yes** (email support correspondence is retained) | Yes | No | App Functionality |
| Other User Content | **Yes** (training notes, check-in responses, RPE scores) | Yes | No | App Functionality |

## Browsing History

| Type | Collected? |
|---|---|
| Browsing History | No |

## Search History

| Type | Collected? |
|---|---|
| Search History | No |

## Identifiers

| Type | Collected? | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| User ID | **Yes** (Supabase `auth.user.id`, UUID) | Yes | No | App Functionality |
| Device ID | **No** (no IDFA, no device-fingerprint collection) | — | — | — |

## Purchases

| Type | Collected? |
|---|---|
| Purchase History | No (revisit when subscription ships — App Store IAP receipts may apply) |

## Usage Data

| Type | Collected? | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Product Interaction | **No** (not collected) | — | — | — |
| Advertising Data | No | — | — | — |
| Other Usage Data | No | — | — | — |

**Note**: PostHog is listed as a "planned analytics" in `docs/LEGAL_CHECKLIST.md` but is NOT wired in the submission binary (verified 2026-05-18 — no PostHog/Mixpanel/Sentry/Firebase/Amplitude SDKs in `package.json`). If analytics ship in a later build, update this row to "Yes" and re-submit the Privacy Nutrition entry in App Store Connect before that build goes live.

## Diagnostics

| Type | Collected? | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Crash Data | **Yes** (Apple App Store Connect built-in crash reporting) | No (aggregated by Apple) | No | App Functionality |
| Performance Data | **Yes** (App Store Connect built-in) | No | No | App Functionality |
| Other Diagnostic Data | No | — | — | — |

## Other Data

| Type | Collected? |
|---|---|
| Other Data Types | No |

---

## Tracking

**Does Mosaic track users across apps and websites owned by other companies?**

**No.** Mosaic does not use the AppTrackingTransparency framework, does not embed any advertising SDK, and does not share data with data brokers. The ATT permission prompt should not be required.

---

## Sub-processors (sub-tab in App Store Connect)

If App Store Connect asks for sub-processor disclosure (not currently a labelled field but increasingly common in privacy reviews), refer to the public `privacy.html` "Sub-processors" section:

- Supabase (database, auth)
- Strava (activity source, where authorised)
- Garmin (activity + physiology source, where authorised)
- Apple (App Store, HealthKit)
- Anthropic (AI Coach Claude API, only when user enables coach)

---

## Quick reference for App Store Connect entry

When entering the label in App Store Connect:

1. **Email Address** → Yes → Linked → No tracking → App Functionality.
2. **Health & Fitness — Health** → Yes → Linked → No tracking → App Functionality.
3. **Health & Fitness — Fitness** → Yes → Linked → No tracking → App Functionality.
4. **Location — Precise Location** → Yes → Linked → No tracking → App Functionality.
5. **User Content — Emails or Text Messages** → Yes → Linked → No tracking → App Functionality (AI Coach messages).
6. **User Content — Customer Support** → Yes → Linked → No tracking → App Functionality.
7. **User Content — Other User Content** → Yes → Linked → No tracking → App Functionality (notes, RPE, check-ins).
8. **Identifiers — User ID** → Yes → Linked → No tracking → App Functionality.
9. **Diagnostics — Crash Data** → Yes → Not Linked → No tracking → App Functionality.
10. **Diagnostics — Performance Data** → Yes → Not Linked → No tracking → App Functionality.

Every other category: No.

Tracking: No.

---

## Maintenance

Update this file when:

- A new third-party integration is added (e.g. enabling PostHog flips "Product Interaction" to Yes).
- The AI Coach data flow changes (currently messages, training summary, readiness signals — no PII).
- The subscription ships (revisit Purchase History, Payment Info).
- Apple revises the data categories.

After updating, mirror in App Store Connect on the next submission.
