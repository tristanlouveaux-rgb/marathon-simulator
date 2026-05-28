# App Store Assets — Mosaic v1

What needs to be produced before the first App Store submission. Most items are content/design, not code — Tristan owns these.

Related docs:
- `docs/MARKETING.md` — playbook + screenshot guidance
- `docs/PRIVACY_NUTRITION_LABEL.md` — privacy form copy
- `docs/PRESUBMISSION_TEST.md` — pre-submission checklist
- `memory/feedback_marketing_screenshots.md` — capture real-device screenshots, no AI mockups

---

## 1. Listing copy

**App name**: `Mosaic`

**Subtitle** (30 chars max): something like *Adaptive marathon coaching* or *Train smarter, race faster*. Test 2–3 in App Store Connect's A/B feature once live.

**Promotional text** (170 chars, can be updated without resubmit): one sentence highlighting whatever Tristan is pushing right now (e.g. "New: AI Coach reads your training and answers your questions.").

**Description** (drafted opening — refine in `marketing/`):

> Mosaic builds an adaptive marathon, triathlon, or HYROX training plan around your real fitness — not a one-size template.
>
> Connect Strava or Apple Health, set a race goal, and Mosaic models your trajectory: fitness, fatigue, freshness, and predicted race time. Every session you log refines the next session. Skip a workout, get sick, change your race date — the plan adapts.
>
> What's inside:
> • Race time prediction from your VDOT, FTP, CSS, and recent runs
> • Daily readiness from HRV, sleep, training stress balance, and ACWR
> • Guided audio runs with voice cues that play while your screen is locked
> • An AI Coach (optional) that reads your week and answers your questions
> • Adaptive training load with weekly progression caps tuned to your tier
> • Apple Health, Strava, and Garmin integration
>
> Built on published exercise-physiology models (Banister impulse-response, Daniels VDOT, Coggan TSS).
>
> HYROX is a registered trademark of HYROX GmbH. Mosaic is not affiliated with or endorsed by HYROX.
>
> Mosaic is not a medical device. Always consult a physician before starting any training programme.

Tristan to refine the bullet voice (consultant tone per CLAUDE.md). The
guided-audio bullet (ISSUE-235), the methodology line (ISSUE-233), and the
HYROX trademark disclaimer (ISSUE-232) are added per the 2026-05-18 audit and
should be kept on the live listing.

---

## 2. Keywords (100 chars, comma-separated, no spaces)

Draft pool:
`marathon,triathlon,running,training plan,coach,VDOT,FTP,strava,garmin,hyrox,VO2max,race,half marathon`

Pick 10–13 that fit under 100 chars. Avoid stuffing.

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

Age rating: 4+ (no objectionable content). The wizard asks for age (16+ per Terms of Use) but that's a Terms thing, not a content rating.

---

## 7. Privacy nutrition label

Enter per `docs/PRIVACY_NUTRITION_LABEL.md`. The "quick reference" section at the bottom of that doc is the exact App Store Connect entry order.

Tracking: **No** — confirm. ATT framework not used.

---

## 8. Pricing & availability

- **Price tier**: Free for v1.
- **In-app purchases**: None for v1. The AI Coach is allowlist-gated in v1 (see ISSUE-231). Tier 2 ships in v1.1 as auto-renewing subscriptions via RevenueCat: AI Coach Monthly at £4.99 and AI Coach Annual at £49.99, both with a 7-day free trial. Setup runbook in `docs/REVENUECAT_SETUP.md`. Paywall surface in `src/ui/coach-paywall.ts` (Apple 3.1.3 compliant).
- **Availability**: All countries (worldwide). EU/UK GDPR rights are covered by `privacy.html`.

---

## 9. Apple Small Business Programme

- [ ] Apply at https://developer.apple.com/app-store/small-business-program/.
- Reduces Apple's commission from 30% to 15% on subscriptions while Mosaic earns under $1M/year. Important once Tier 2 ships.
- No reason not to apply now — App Review doesn't gate on this.

---

## 10. App Review notes (one-time submission text)

When submitting, include these notes for the reviewer:

> Mosaic is an adaptive training planner for runners and triathletes.
>
> Test account: <email> / <password>
> (This account has Strava pre-connected with at least 16 weeks of activities. Allow about 30 seconds after sign-in for the history sync to complete before the home screen populates.)
>
> The AI Coach is currently behind an internal allowlist while we finalise the subscription path. Reviewer accounts will see the rules-based Coach screen (brief, recovery readout, today's workout, feeling prompt, export-snapshot button) instead of the AI surface. Email tristan@mosaicrunning.run if you'd like to evaluate the AI surface — we can allowlist your reviewer Apple ID.
>
> Apple Health: read-only. Mosaic does not write to Apple Health.
>
> Location: used while recording a live run. Background mode declared for users tracking long runs with the screen off.
>
> Audio background mode: used by the guided-audio runs feature to play voice training cues while the screen is locked or the app is in the background.
>
> Account deletion: in-app under Account → Delete account. 30-day grace window. Strava OAuth token is revoked synchronously on deletion. See public/privacy.html.

---

## Owner

Tristan. None of this is code — except where it isn't:

- Marketing landing site at `marketing/` — once content is drafted, decide cookie banner per `LEGAL_CHECKLIST.md`.
