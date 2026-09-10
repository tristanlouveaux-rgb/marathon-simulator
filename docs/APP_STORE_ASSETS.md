# App Store Assets — Mosaic v1

> **STATUS 2026-09-10** — most of this is now entered in App Store Connect (app `6776750342`).
> Live values are recorded inline below marked **[LIVE]**. Four items remain and are
> Tristan-only: Developer Program License Agreement acceptance, DSA trader status,
> Regulated Medical Device declaration, and the final Add for Review.

What needs to be produced before the first App Store submission. Most items are content/design, not code — Tristan owns these.

Related docs:
- `docs/MARKETING.md` — playbook + screenshot guidance
- `docs/PRIVACY_NUTRITION_LABEL.md` — privacy form copy
- `docs/PRESUBMISSION_TEST.md` — pre-submission checklist
- `memory/feedback_marketing_screenshots.md` — capture real-device screenshots, no AI mockups

---

## 1. Listing copy

**App name**: `Mosaic`

**Subtitle** (30 chars max): **[LIVE]** `Your training plan adapts` (25 chars). Chosen 2026-09-10 over the marathon-specific drafts because it covers running, triathlon and HYROX. Test alternatives via A/B once live.

**Promotional text** (170 chars, can be updated without resubmit): one sentence highlighting whatever Tristan is pushing right now (e.g. "New: AI Coach reads your training and answers your questions.").

**Description** (drafted opening — refine in `marketing/`):

> **[LIVE, revised 2026-09-10 — Strava and Garmin connect claims removed, see below]**
>
> Mosaic builds an adaptive marathon, triathlon, or HYROX training plan around your real fitness, not a one-size template.
>
> Connect Apple Health, set a race goal, and Mosaic models your trajectory: fitness, fatigue, freshness, and predicted race time. Every session you log refines the next session. Skip a workout, get sick, change your race date, and the plan adapts.
>
> What's inside:
> • Race time prediction from your VDOT, FTP, CSS, and recent runs
> • Daily readiness from HRV, sleep, training stress balance, and ACWR
> • Guided audio runs with voice cues that play while your screen is locked
> • Adaptive training load with weekly progression caps tuned to your tier
> • Apple Health sync, plus .fit, .gpx, and .tcx import from Garmin and other devices
>
> (AI Coach bullet removed 2026-08-04: AI_COACH_ENABLED=false in the v1 binary — describing it would be a 2.3.1 metadata-accuracy risk. Restore the bullet when the feature ships.)
>
> Built on published exercise-physiology models (Banister impulse-response, Daniels VDOT, Coggan TSS).
>
> HYROX is a registered trademark of HYROX GmbH. Mosaic is not affiliated with or endorsed by HYROX.
>
> Mosaic is not a medical device. Always consult a physician before starting any training programme.

**Integration claims — do not re-add Strava or Garmin without checking the flags.**
For a public v1 user neither is reachable: `GARMIN_CONNECT_ENABLED = false` in
`src/constants/feature-flags.ts` (the Garmin webhook is approved for a single developer
account), and the Strava connect button is gated behind the `BENJAMIN` code in
`src/constants/access-codes.ts` with a 10-athlete Standard Tier cap. Naming either in the
description is a 2.3.1 metadata-accuracy rejection risk. The honest claim is Apple Health
sync plus manual `.fit`/`.gpx`/`.tcx` import (`src/ui/import-activity-modal.ts`, ungated).
Restore the live-connect wording only when the flag flips and Extended Access lands.

Tristan to refine the bullet voice (consultant tone per CLAUDE.md). The
guided-audio bullet (ISSUE-235), the methodology line (ISSUE-233), and the
HYROX trademark disclaimer (ISSUE-232) are added per the 2026-05-18 audit and
should be kept on the live listing.

---

## 2. Keywords (100 chars, comma-separated, no spaces)

**[LIVE]** `marathon,triathlon,running,training,plan,coach,vdot,ftp,hyrox,race,half,fitness,pace` (84/100).

`strava` and `garmin` were removed 2026-09-10: third-party trademarks for features a public
user cannot reach. Do not re-add them while the flags above are off.

---

## 3. Screenshots

Per `memory/feedback_marketing_screenshots.md`, capture on a real device. No AI/CSS mockups.

Five required screenshots (6.5" + 6.9" iPhone sizes):

1. **Home / readiness ring** — clean readiness state, training stress balance visible.
2. **Plan view** — week's workouts with a planned long run highlighted.
3. **Activity detail** — a recent run showing zones, splits, route. Power or HR zones.
4. **AI Coach reply** — natural conversation snippet, no PII.
5. **Stats trend** — VDOT, CTL, or fitness sparkline showing improvement over weeks.

Optional 6–10 if there's space: race prediction screen, recovery view, durability cap explainer.

---

## 4. App preview video (optional but recommended)

15–30s. Walk-through of: connect Strava → race goal → adaptive plan → readiness ring → coach reply. No music with copyright. Captions if any.

---

## 5. Support + marketing URLs

Already live:
- Privacy: `https://mosaicrunning.run/privacy.html`
- Terms: `https://mosaicrunning.run/terms.html`
- Support: `https://mosaicrunning.run/support.html`
- Contact: `tristan@mosaicrunning.run`

App Store Connect requires Support URL + Privacy URL fields. Use `support.html` and `privacy.html`.

Marketing URL: top-level `https://mosaicrunning.run` (build the landing page from `marketing/` before submission, or omit — Apple allows blank).

---

## 6. Categorisation

- **Primary**: Health & Fitness
- **Secondary**: Sports

**[LIVE]** Both categories set 2026-09-10.

Age rating: **9+**, not 4+. The questionnaire was completed 2026-09-10 with every answer
None/No except **Health or Wellness Topics = Yes**, which is what produces 9+. That answer is
accurate (the app makes self-care and lifestyle recommendations) and should not be changed to
reach 4+. Regional outcomes: 9+ in 172 countries, 12+ Vietnam, A10 Brazil, ALL Korea. On OS
versions earlier than 26 it still resolves to a global 4+. Content Rights declared as no
third-party content. The wizard asks for age (16+ per Terms of Use) but that's a Terms thing,
not a content rating.

---

## 7. Privacy nutrition label

Enter per `docs/PRIVACY_NUTRITION_LABEL.md`. The "quick reference" section at the bottom of that doc is the exact App Store Connect entry order.

Tracking: **No** — confirm. ATT framework not used.

---

## 8. Pricing & availability

- **Price tier**: **[LIVE]** Free, set 2026-09-10 across all 175 regions. Confirmed by Tristan against the
  contradicting `AI_COACH_ENABLED` comment in feature-flags.ts which described v1 as a paid base app.
  Free means no Paid Applications agreement (banking + tax) is needed to submit.
- **In-app purchases**: None for v1. The AI Coach is allowlist-gated in v1 (see ISSUE-231). Tier 2 ships in v1.1 as auto-renewing subscriptions via RevenueCat: AI Coach Monthly at £4.99 and AI Coach Annual at £49.99, both with a 7-day free trial. Setup runbook in `docs/REVENUECAT_SETUP.md`. Paywall surface in `src/ui/coach-paywall.ts` (Apple 3.1.3 compliant).
- **Availability**: **[LIVE]** All 175 countries, available on app release, set 2026-09-10. EU/UK GDPR rights
  are covered by `privacy.html`. NOTE: EU availability still depends on DSA trader status being provided.

---

## 9. Apple Small Business Programme

- [ ] Apply at https://developer.apple.com/app-store/small-business-program/.
- Reduces Apple's commission from 30% to 15% on subscriptions while Mosaic earns under $1M/year. Important once Tier 2 ships.
- No reason not to apply now — App Review doesn't gate on this.

---

## 10. App Review notes (one-time submission text)

When submitting, include these notes for the reviewer:

> Mosaic is an adaptive training planner for runners, triathletes, and hybrid athletes.
>
> Test account: review@mosaicrunning.run / (password set 2026-08-04 — Tristan pastes it here; also in the ASC notes field)
>
> The account is pre-loaded with a sample athlete: a 16-week marathon plan with a populated Home, Plan, Forecast, and Stats. Sign in and the app restores it automatically within a few seconds. No other setup is needed. If the account is ever blank, it can be re-seeded: sign in, enter any name, choose Running, choose Garmin on the data step, and enter access code REVIEW in the "Connect through Strava" card. The app reloads with the sample athlete.
>
> Strava: optional. The Strava connect button is behind a beta access code while our Strava API capacity application is in review, so it is not open to the public in this build. The reviewer account does not need Strava.
>
> AI features: none in this build. Coaching text is generated by deterministic rules from the athlete's own data. There is no AI chat surface, no subscription, and no purchase.
>
> Apple Health: read-only. Mosaic does not write to Apple Health.
>
> Location: used while recording a live run. Background mode declared for users tracking long runs with the screen off.
>
> Audio background mode: used by the guided-audio runs feature to play voice training cues while the screen is locked or the app is in the background.
>
> Account deletion: in-app under Account → Delete account. 30-day grace window. Strava OAuth token is revoked synchronously on deletion. See https://mosaicrunning.run/privacy.html.

Updated 2026-08-04: real reviewer account (pre-seeded via REVIEW code, backup-restored on sign-in — see ISSUE-230), Strava gate stated honestly, AI Coach paragraph replaced (AI_COACH_ENABLED=false — no AI surface exists in the binary, so the old allowlist wording described something reviewers could never find).

---

## Owner

Tristan. None of this is code — except where it isn't:

- Marketing landing site at `marketing/` — once content is drafted, decide cookie banner per `LEGAL_CHECKLIST.md`.
