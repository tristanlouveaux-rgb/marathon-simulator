# Parking Strava & Garmin (launch runbook)

**Status (2026-06-01): STRAVA IS RE-ENABLED.** `STRAVA_ENABLED = true` in
`src/constants/feature-flags.ts`. Strava's June 2026 Developer Program overhaul lets
Standard Tier self-serve up to **10 athletes** with no review; Tristan upgraded (Premium
satisfies the developer-subscription requirement). All Strava UI and launch-time network
calls are live again. **CEILING: 10 athletes — this is the beta path, not public scale.**
Public launch with Strava needs Extended Access Tier (see section below).

`GARMIN_CONNECT_ENABLED` is still gated — Garmin's own webhook is single-dev-account only,
so live Garmin OAuth stays off. Garmin users come in via **Garmin → Strava → Mosaic**,
which is the whole reason Strava is back on.

## TO RE-PARK STRAVA (if ever needed)

Set `STRAVA_ENABLED = false` in `src/constants/feature-flags.ts`. That single flip hides
every gated site — connect buttons, source rows, the auto-log banner — and skips the
launch-time sync / backfill / restore / self-heal. No other edits needed. Existing synced
Strava data is never deleted by burying. After flipping either way, run `npx tsc --noEmit`,
`npm run lint:ui`, and `npx vitest run` to confirm green.

## Extended Access Tier (the public-scale path)

Standard Tier caps at 10 athletes. To onboard more than 10 Strava users, Mosaic needs
**Extended Access** (greater user capacity, higher rate limits, no developer-sub required).
Approval-gated — the same review that historically capped us at 1.

**How to apply:**
1. Form: https://share.hsforms.com/1VXSwPUYqSH6IxK0y51FjHwcnkd8 (also linked from the API
   settings dashboard). Or email developers@strava.com with the Client ID.
2. Submit the Mosaic Client ID + app description. Strava reviews for: current API agreement,
   branding-guideline compliance (Powered-by-Strava badge — already wired in
   `connect-strava.ts`), athlete-privacy respect, rate-limit behaviour.
3. Expect delays — community reports range from the stated 7–10 business days to ~4 weeks
   (June 2026 backlog from a 448% application surge).

**Positioning:** direct integration (no intermediary), athlete-benefit use case (training
planning, not data resale or AI training), real Standard-tier beta usage to cite. Keep Apple
Health as the Apple-Watch spine so a slow/denied review only blocks the Garmin segment.

## Why park

- **Strava**: API access is capped at 1 authorised user on the current registration.
  Live Strava sync cannot work for any shipped user.
- **Garmin**: the webhook is approved for a single developer account. Live Garmin sync
  cannot work for any shipped user.
- **Replacement**: Apple Health is the primary live source on iOS; manual FIT/GPX/TCX
  file import (works on web and iOS) is the universal fallback. See the multi-platform
  plan for the Garmin-via-upload story.

## What "parked" means per flag

Each flag gates BOTH the UI (hide the connect/sync surfaces) AND the launch-time
background network triggers (skip the sync/backfill/restore calls). One flip per
provider re-enables everything for the dev account.

## Re-enable (one-flip)

Set `STRAVA_ENABLED = true` and/or `GARMIN_CONNECT_ENABLED = true` in
`src/constants/feature-flags.ts`. Everything below is guarded by those constants once
the wiring pass is done, so flipping back restores the dev experience with no other edits.

---

## Sites to gate — STRAVA

> Line numbers are from a recon pass (2026-05-27). Confirm at edit time; they drift.

### UI (hide behind `!STRAVA_ENABLED`)

| Site | What it is |
|---|---|
| `src/ui/wizard/steps/connect-strava.ts:135-142` | Wizard "Connect with Strava" CTA + "Strava connected" pill + Powered-by-Strava badge |
| `src/ui/main-view.ts:239` | `renderStravaButton(s.stravaConnected)` in plan-view header |
| `src/ui/main-view.ts:342-354` | Orange "Automatic workout logging / Connect Strava" banner |
| `src/ui/main-view.ts:556-574` | `renderStravaButton()` definition (`btn-connect-strava`) |
| `src/ui/account-view.ts:400-422` | `renderStravaStandaloneRow()` (connect/sync/disconnect + badge) |
| `src/ui/account-view.ts:424-445` | `renderStravaEnrichRow()` (HR-enrichment variant) |
| `src/ui/account-view.ts:793-854` | `renderTrainingHistoryGroup()` — Load / Rebuild / Sync-history / Restore buttons |

### Background triggers (skip behind `!STRAVA_ENABLED`)

| Site | What it triggers |
|---|---|
| `src/main.ts:1196-1213` | Launch activity sync: `syncStravaActivities()` + downstream |
| `src/main.ts:1297-1334` | Launch history backfill: `backfillStravaHistory(52)` |
| `src/main.ts:1360-1425` | Launch auto-restore: `restoreHistoryFromServer(180)` |
| `src/main.ts:1152-1167` | OAuth-callback `strava=connected` → resync |
| `src/main.ts:351-361` | `stravaConnected` self-heal network call |
| `src/main.ts:449-463` | Tri-mode empty-DB Strava backfill |
| `src/ui/wizard/steps/review.ts:327` | `backfillStravaHistory()` in onboarding review loader |
| `src/ui/main-view.ts:2698-2701` | `btn-sync-now` manual sync (UI-triggered) |

---

## Sites to gate — GARMIN

### UI (hide behind `!GARMIN_CONNECT_ENABLED`)

| Site | What it is |
|---|---|
| `src/ui/wizard/steps/connect-strava.ts:151-156` | Wizard "Connect Garmin" secondary CTA |
| `src/ui/wizard/steps/connect-strava.ts:278-350` | `wireGarminHandler()` (status check + OAuth start) |
| `src/ui/account-view.ts:352-379` | `renderGarminRow()` (connect/sync/disconnect) |
| `src/ui/account-view.ts:57-133` | `checkGarminStatus()` (runs every account render) |

### Background triggers (skip behind `!GARMIN_CONNECT_ENABLED`)

| Site | What it triggers |
|---|---|
| `src/main.ts:1215-1223` | Launch Garmin activity sync branch |
| `src/main.ts:1248-1293` | `syncAllPhysiology()` — backfill, steps, sleep, snapshots |
| `src/main.ts:369-385` | Physiology-source self-heal network call |
| `src/main.ts:153-159` | Bootstrap `garmin=connected` guard reset |
| `src/main.ts:1134-1149` | Garmin OAuth-callback toast + nav |
| `src/main.ts:1828-1840` | Foreground-resume physiology re-sync |
| `src/ui/wizard/steps/review.ts:339-346` | `triggerGarminBackfill(8)` in onboarding review loader |

---

## Decision dependency

The asymmetry between Strava and Garmin matters for wiring:

- **Strava**: fully park (hide everything). No replacement surface needed.
- **Garmin**: park the live OAuth/webhook path, but Garmin users are a target audience
  via **manual upload**. The connect surfaces should likely be *replaced* with an
  "upload your Garmin runs" affordance rather than simply hidden. That replacement is
  decision **D5** + the onboarding rework (Phase 2). Do not hide the Garmin surfaces
  without first deciding what stands in their place — otherwise a Garmin user lands on
  a screen with no path in.

## Pre-flight before wiring

- Read `docs/UX_PATTERNS.md` (the replacement surfaces are UI work).
- Run `npm run lint:ui` after any UI edit.
- `npx tsc --noEmit` and `npx vitest run` must stay green.
- Because `main.ts` and the wizard/account files are also touched by other launch work,
  dump a recovery patch (`git diff <file> > /tmp/<file>.before.patch`) before editing.
