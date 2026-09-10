# App Review Playbook — Mosaic v1

What to do if Apple sends build 1.0(29) back. Risks are ranked by probability for
*this* app, not generic App Store advice. Each entry has the trigger, a
pre-drafted Resolution Center reply, and the fix if one is needed.

Submitted 2026-09-10. Build 1.0(29), commit `56fa077`, tag `appstore-v1.0-build29`.

---

## Before they respond: the one test that matters

**Install build 29 from TestFlight on a real iPhone, deny Apple Health when
asked, and sign in as `review@mosaicrunning.run`.**

This is the highest-value thing to do while waiting. Reason: the reviewer flow
was verified on 2026-08-04 against the local tree with Playwright. It has never
run on a device, and never on build 29. Build 29 adds `appleActivityUpload.ts`
(new file) and changes `appleHealthSync.ts`, both of which execute at or near
launch, on a device where the reviewer will refuse HealthKit access.

If the seeded athlete does not appear, that is a guaranteed 2.1 rejection and
you want to know before Apple tells you.

Pass criteria:
1. Sign-in succeeds with no wizard.
2. Home, Plan, Forecast and Stats all render with the sample athlete's data.
3. No blank screens, no spinners that never resolve, no crash on cold start.
4. If it lands in the wizard instead: name, Running, Garmin, access code `REVIEW`
   re-seeds it. That path must also work, because the notes describe it.

---

## P0. Guideline 2.1 — App Completeness (reviewer cannot reach content)

**Trigger**: reviewer signs in and gets an empty app, the onboarding wizard, a
blank screen, or a crash.

**Most likely cause**: launch-time code path failing when HealthKit permission
is denied, or the Supabase backup restore not firing. `main.ts` runs the Garmin
backfill before `syncPhysiologySnapshot`; the restore is what makes the reviewer
account look populated.

**Reply**:

> The account restores a pre-seeded sample athlete on sign-in. If the app
> appeared empty, please sign in again and allow a few seconds for the restore,
> or re-seed directly: enter any name, choose Running, choose Garmin on the data
> step, and enter access code REVIEW in the "Connect through Strava" card. The
> app reloads with a complete 16-week marathon plan.
>
> Apple Health access is not required to evaluate the app. The sample athlete's
> data is restored from our backend, not from HealthKit.

**Fix if it is real**: reproduce with HealthKit denied, then guard the failing
launch path. Ship as a new build; 2.1 rejections need a binary, not a reply.

---

## P1. Guideline 5.1.5 / 2.5.4 — background location justification

**Trigger**: Apple asks you to justify or demonstrate the `location` background
mode, or says the feature was not found.

**Probability**: moderate. Background location draws routine scrutiny, and a
reviewer who never starts a tracked run will not see it used.

**Reply**:

> Background location is used only while the user is recording a run. Mosaic
> continues capturing GPS for pace, distance and per-km splits when the screen
> locks or the app backgrounds, which is the normal case for a training run.
> Location is not collected at any other time and is never used for advertising.
>
> To see it: open the app, start a run from the tracker, lock the screen, walk
> or drive a short distance, unlock and observe distance and splits have
> continued to accumulate.

**Prepare now**: a 30 second screen recording showing a run being tracked with
the screen locked, then distance having advanced on unlock. Apple accepts video
in Resolution Center and it usually ends this conversation in one round.

The `audio` background mode is separate and easier: guided audio runs play voice
cues while the screen is locked (`src/guided/`).

---

## P2. Guideline 5.1.1(v) — account deletion

**Trigger**: reviewer cannot find in-app account deletion, or it fails.

**Probability**: moderate. Apple actively tests this and it is a common
first-submission rejection.

**Status**: deletion is implemented under Account, with a 30-day grace window,
and revokes the Strava OAuth token synchronously. Resolved in production, but
per project notes the end-to-end throwaway-account test is still pending.

**Do this while waiting**: create a throwaway account, delete it in-app, and
confirm the row is gone and sign-in no longer works.

**Reply**:

> Account deletion is in the app under Account, "Delete account". It removes the
> account and all associated training data, with a 30-day grace window during
> which the user can recover it. Any connected Strava OAuth token is revoked
> synchronously at deletion. This is documented at
> https://mosaicrunning.run/privacy.html.

---

## P3. Guideline 2.3.1 — hidden or undocumented features

**Trigger**: reviewer finds the access-code field on the data step and treats
the Strava path as hidden functionality.

**Probability**: low. It is already disclosed in the review notes.

**Reply**:

> The access code field is disclosed in our review notes. Strava connection is
> limited to 10 athletes under Strava's Standard API tier while our Extended
> Access application is pending, so the connect button is gated behind a beta
> code rather than being offered to all users. It is not hidden functionality
> and it is not required to evaluate the app. The same field accepts the code
> REVIEW, which seeds the reviewer demo account described in our notes.

---

## P4. Guideline 1.4.1 — physical harm / health claims

**Trigger**: reviewer objects to training prescriptions or readiness scoring
derived from HRV and sleep.

**Probability**: low. There is no diagnosis, no treatment guidance, and the
listing carries a disclaimer.

**Reply**:

> Mosaic is a training planner, not a medical device, and we have declared it as
> such. It does not diagnose, treat, or manage any medical condition. Every
> number is produced by published exercise-physiology models (Banister
> impulse-response, Daniels VDOT, Coggan TSS) applied to the user's own training
> data. The app description and our in-app disclaimer both state that Mosaic is
> not a medical device and that users should consult a physician before starting
> a training programme.

---

## P5. Metadata and consistency items (found 2026-09-10, fix in 1.0.1)

Not expected to cause rejection, but they are inconsistencies a reviewer could
pick at, and they are cheap to clean:

- **`NSHealthUpdateUsageDescription` declares HealthKit write access that the
  app never uses.** Only `CAPGO_READ_TYPES` is requested; there are no write
  calls. The review notes correctly say "read-only", so the Info.plist string
  contradicts them. Remove the key in 1.0.1.
- **Screenshot count is 5, not 6.** The Physiology / recovery-ring shot was lost
  when the broken app preview was deleted. It was listed as screenshot #1 in
  APP_STORE_ASSETS §3 and Apple uses only the first 3 on the install sheet.
  Restore it in the next update.
- **App preview video**: none attached. Optional, but worth adding once a clean
  one is produced.

---

## Mechanics: what to do when the email arrives

1. **Read the exact guideline number.** Apple cites one. The number tells you
   whether a reply or a new binary is required.
2. **Metadata rejections** (2.3.x, 5.x wording) are usually fixable by editing
   the listing and replying, with no new build.
3. **Binary rejections** (2.1 crashes, missing functionality) need a new build.
   Bump the build number, upload, and attach it to the same version.
4. **Reply in Resolution Center, not by resubmitting silently.** A clear reply
   with a video or steps usually resolves in one round. Resubmitting without
   explanation invites the same rejection.
5. **Do not argue the guideline.** Answer the question they asked, show the
   feature working, and offer the exact steps to see it.
6. **Expedited review** exists for critical issues. Do not spend it on a first
   submission rejection.

Rejection does not send you to the back of a queue. A reply typically gets
looked at within 24 to 48 hours, the same as the original submission.
