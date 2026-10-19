# Pre-Launch Security Checklist

Run this before the first App Store submission and before any major paid acquisition push. Curated from `~/Documents/ALL AI NOTES.docx` plus standard production hygiene.

For ongoing reviews of code changes, use the `/security-review` slash command (per `CLAUDE.md`).

---

## Network & Auth

- [⏸️] **CORS allowlist**: `coach-chat` and `coach-narrative` use a tight allowlist (`http://localhost*`, `capacitor://localhost`). The other 12 edge functions still set `Access-Control-Allow-Origin: *`. Tightening deferred for v1 because every endpoint requires JWT in the `Authorization` header (CORS does not gate JWT-bearing requests — JWT is the real auth control). Add `https://mosaicrunning.run` and tighten each function in v1.1 with origin-specific manual testing.
- [ ] **Redirect URL allowlist**: validate every redirect (auth, OAuth, payment-return) against an explicit allowlist. Reject any URL not on the list. Strava and Garmin OAuth callbacks already implement PKCE + state validation per audit (2026-05-17).
- [ ] **JWT session expiration**: confirm Supabase session tokens have a sensible expiration (default 1h is fine).
- [ ] **JWT rotation**: refresh tokens rotate on each use.
- [ ] **Server-side admin checks**: every protected route verifies `user.role === 'admin'` *server-side*, not from a client claim.
- [ ] **Rate limit password-reset**: cap reset requests per email per hour to prevent abuse.

## Storage (Supabase)

- [x] **RLS enabled on every table** (audit 2026-05-17): `daily_metrics`, `sleep_summaries`, `activity_details`, `strava_tokens`, `garmin_tokens`, `user_plan_settings`, `coach_chat_usage`, `coach_narrative_cache`, `route_safety_ratings` all have ALTER + per-user SELECT policies. Service-role-only ephemeral tables (`strava_auth_requests`, `garmin_auth_requests`) intentionally have no user policy. Added 2026-10-13 (lane HP): `hyrox_partner_invites`, `hyrox_partner_links`, `hyrox_partner_snapshots`, RLS on, applied by hand through the SQL editor (RUNBOOK, HYROX Doubles partner tables). Two policies return another user's row by design: links (`partner_id = auth.uid()`) and the partner snapshot read (EXISTS on the caller's link row).
- [ ] **Storage policies**: per-user bucket access — users can only read/write their own files, never others'.
- [x] **No service-role key in client code** (audit 2026-05-17): `.env.local` contains only the anon JWT (role=anon, exp 2086). Bundle audit `grep -r "service_role\|sk_live\|sk-ant-" dist/` returns zero matches after `npx vite build`.

## Webhooks

- [ ] **Stripe signature verification**: every Stripe webhook handler calls `stripe.webhooks.constructEvent()` with the signing secret before trusting the payload. Never process payment data from an unverified webhook.
- [ ] **Strava webhook signature** (if/when added): same pattern.
- [x] **Garmin webhook signature** — Garmin Health API does not emit an HMAC header (confirmed 2026-05-17). Auth model documented in `docs/WEBHOOKS.md`: secret webhook URL + server-side `userId`/`userAccessToken` → `garmin_tokens` mapping, unknown IDs dropped, always return HTTP 200. Adopt HMAC the moment Garmin publishes it.

## Error Handling

- [ ] **No raw errors to users**: every server-side error path returns a generic message (e.g. "Something went wrong, please try again"). Stack traces, table names, query failures stay in server logs only.
- [ ] **Server-side error logging**: confirm errors land in Supabase logs or a dedicated error-tracking service.

## Code Hygiene

- [x] **Strip `console.*` from production bundle** (2026-05-17): `vite.config.ts` uses `esbuild.drop: ['console', 'debugger']` for the `build` command only. Dev (`vite serve`) keeps logs. Source files unchanged. Re-grep of `dist/` finds only library-internal references (e.g. `this.logger = console.log` inside Supabase auth helpers — not direct call expressions, esbuild cannot drop these).
- [⏸️] **`npm audit` clean** (2026-05-17): 5 high-severity advisories, all in transitive deps of `@capacitor/cli` (`xmldom`, `minimatch`, `tar`). `@capacitor/cli` is a build-time tool (used by `npx cap sync`/`copy`); it does not ship in the production bundle that runs on users' devices. No user-facing runtime risk. Re-audit when `@capacitor/cli` ships a fix.
- [ ] **`/security-review`**: run as the final gate before App Store submission.
- [ ] **Bug Rabbit final pass**: run before submission; review and triage findings.

## Pre-Submission Audit

- [ ] All checkboxes above ticked.
- [ ] `/security-review` run on the App-Store-bound branch.
- [ ] One full end-to-end manual test (see `docs/PRESUBMISSION_TEST.md`).
- [x] **Bundle has no embedded secrets** (re-verified 2026-05-18 after fresh `vite build` + `cap copy ios`): `grep -r "sk_live\|sk-ant-\|service_role\|ANTHROPIC_API_KEY" dist/ ios/App/App/public/` returns zero across both web and iOS bundles. The string `ANTHROPIC_API_KEY` appears in `src/coach/__tests__/eval-helpers.ts` for offline test-time use but is only imported under `__tests__/`, so Vite does not bundle it.
- [x] **No `api-key-store.ts` remnants** (re-verified 2026-05-18 post-`cap copy ios`): file deleted; grep across `src/`, `supabase/`, **and** `ios/App/App/public/` shows zero references. Replaced by `src/coach/allowlist.ts` (UID allowlist) and server-side Anthropic key. Note: the iOS bundle held stale BYOK assets until `cap copy` ran today — always re-sync the iOS bundle before archiving for App Review.
