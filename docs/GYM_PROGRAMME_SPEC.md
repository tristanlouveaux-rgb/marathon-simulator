# Gym Programme Overhaul — Full Spec

> **Status**: Questions for Tristan. Nothing builds until decisions are made below.
> **Reference**: Current gym code in `src/workouts/gym.ts`, onboarding in `src/ui/wizard/steps/volume.ts`, activity matching in `src/calculations/activity-matcher.ts`.

---

## A. Positioning — what IS gym in this app?

1. **Support for running** (injury prevention, economy) — or a **genuine second pillar** with its own progression?
2. **Target user**: marathoner who lifts twice a week, or hybrid (hyrox/triathlete) who wants real strength programming?
3. Should gym have its own "fitness" metric (analogous to VDOT), or only measured by adherence?

---

## B. Scope / ambition

4. Full programme (progressive overload, week-to-week load math, exercise-level history) — or enhanced template library (better content, still fixed)?
5. Exercise **substitution** library (swap barbell squat -> goblet squat)?
6. Form/technique guidance (video/animation) — or out of scope?
7. Long-term strength tracking (1RM estimates, volume tonnage trend) — yes/no?

---

## C. Onboarding inputs

Today we capture only `gs` (0-3 sessions/week). What else?

8. Equipment tier (full commercial gym / home rack / dumbbells only / bodyweight)?
9. Current 1RMs on core lifts (squat/deadlift/bench) — or skip and estimate from RPE?
10. Gym **goal** pick (prevent injury / support race / build strength)?
11. Exercise preferences or dislikes (e.g. no overhead press, knee-friendly only)?

---

## D. Programme design rules

12. Who drives template selection — **us** (by phase x ability), **user** (picks a plan), or **hybrid** (we suggest, user locks)?
13. Progression rule across weeks — linear +2.5kg/wk? Wave? RPE-regulated? Something else?
14. Gym mesocycle — mirror run phase (base/build/peak/taper), or independent strength periodisation?
15. Mandatory mobility/core blocks in every session, or optional?

---

## E. In-session UX

16. Logging during the session (sets x reps x weight x RPE) or just "mark done" at end?
17. Rest timer between sets?
18. Live HR display from wearable during gym session?
19. "Today's session" live screen (like GPS run) — yes, or stay on the Home card?

---

## F. Integration with the run plan

20. Hard constraints: never on a Q-day? Never within X hrs of a long run? Always day-after-easy?
21. Can the user drag gym to a different day? Does the app auto-reschedule when it clashes with a Q session that moved?
22. Can the user downgrade a session mid-week ("short version")? Cancel a single session vs cancel the week?
23. Mid-plan `gs` change — allowed, and does it re-plan remaining weeks?

---

## G. Activity matching / completion

24. Auto-match rule: synced `WEIGHT_TRAINING` on same calendar day -> complete the planned slot? What if the user logs it differently (HIIT, functional, hyrox)?
25. Load formula for a completed gym session — device HR -> iTRIMP (current), or duration x RPE, or tonnage-based?
26. What if no HR data (home gym, no watch)? Manual RPE input?

---

## H. Load / fatigue model

27. Should completed gym contribute to Signal A (running fitness)? Currently no. Keep?
28. Signal B ACWR — keep gym at 100% physiological load (current)?
29. Does gym feed the Recovery countdown / injury risk model? By how much?

---

## I. UI surfaces

30. Does gym get its **own drill-down view** (parallel to Load / Recovery / Sleep), or stay a card on Home + a row on Plan?
31. Home card — what's the "hero" info? Today's session name, rep scheme, expected duration, readiness-to-lift?
32. Plan row — elevate gym to a primary CTA ("Start session"), or keep secondary?
33. A dedicated **Strength History** view (lifts over time, tonnage, PRs)?

---

## J. Edge cases to define now

34. User does a gym activity that isn't `WEIGHT_TRAINING` (hyrox, crossfit, functional) — matches or not?
35. Two gym sessions same day — which counts?
36. User abandons gym mid-plan — do sessions silently disappear, or keep prompting?
37. Detraining (no gym for 3+ weeks) — any signal shown?
38. Injury -> which exercises drop first, and does the programme auto-downgrade or just skip?

---

## K. Direction

39. **Greenfield spec** (best possible gym module, ignoring current code) then overlay a phased rollout? Or **incremental evolution** from current code?

---

## Current state (for reference)

### What exists today

| Area | State | File |
|------|-------|------|
| Data model | Single field `s.gs` (0-3), set at onboarding, immutable | `src/types/state.ts:324` |
| Generation | Hardcoded templates by phase x ability (beginner/novice/full) | `src/workouts/gym.ts` |
| Onboarding | Button grid 0/1/2/3 with recommendation text | `src/ui/wizard/steps/volume.ts:45-56` |
| Home card | Beige hero card, exercises in `<details>` expandable | `src/ui/home-view.ts:1674-1758` |
| Plan row | Secondary buttons only (`m-btn-secondary`), no "Start" CTA | `src/ui/plan-view.ts:471-473` |
| Matching | Garmin/Strava `WEIGHT_TRAINING` -> ad-hoc workout (does NOT complete planned slot) | `src/calculations/activity-matcher.ts:473-492` |
| Load | TSS forced to 0 for gym in plan view display | `src/ui/plan-view.ts:280` |
| Mid-plan edit | Not possible (no settings page for `gs`) | N/A |

### Known problems

- No gym frequency adjustment after onboarding
- Synced gym activities don't tick off planned sessions
- Gym is second-class citizen in Plan UI (no primary CTA, hidden TSS)
- No exercise customisation, substitution, or progression
- Gym vs cross-training overlap (both produce sessions with similar treatment)
- Templates feel generic — same content every week
- No gym-specific deload toggle
- No strength tracking or history
