# Pre-Launch Security Checklist

Run this before the first App Store submission and before any major paid acquisition push. Curated from `~/Documents/ALL AI NOTES.docx` plus standard production hygiene.

For ongoing reviews of code changes, use the `/security-review` slash command (per `CLAUDE.md`).

---

## Network & Auth

- [ ] **CORS allowlist**: configure CORS on every Supabase edge function to allow only `https://mosaicrunning.run`, `https://*.mosaicrunning.run`, and `capacitor://localhost` (iOS app).
- [ ] **Redirect URL allowlist**: validate every redirect (auth, OAuth, payment-return) against an explicit allowlist. Reject any URL not on the list.
- [ ] **JWT session expiration**: confirm Supabase session tokens have a sensible expiration (default 1h is fine).
- [ ] **JWT rotation**: refresh tokens rotate on each use.
- [ ] **Server-side admin checks**: every protected route verifies `user.role === 'admin'` *server-side*, not from a client claim.
- [ ] **Rate limit password-reset**: cap reset requests per email per hour to prevent abuse.

## Storage (Supabase)

- [ ] **RLS enabled on every table**: confirm `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for all user-data tables.
- [ ] **Storage policies**: per-user bucket access — users can only read/write their own files, never others'.
- [ ] **No service-role key in client code**: confirm only the `anon` key is in the Capacitor bundle.

## Webhooks

- [ ] **Stripe signature verification**: every Stripe webhook handler calls `stripe.webhooks.constructEvent()` with the signing secret before trusting the payload. Never process payment data from an unverified webhook.
- [ ] **Strava webhook signature** (if/when added): same pattern.
- [ ] **Garmin webhook signature**: confirm verification is in place per `docs/WEBHOOKS.md`.

## Error Handling

- [ ] **No raw errors to users**: every server-side error path returns a generic message (e.g. "Something went wrong, please try again"). Stack traces, table names, query failures stay in server logs only.
- [ ] **Server-side error logging**: confirm errors land in Supabase logs or a dedicated error-tracking service.

## Code Hygiene

- [ ] **Remove all `console.log` statements** from production code paths. Replace with proper structured logging where genuinely needed. Review `console-cleanup-rollback.md` first if previous attempts caused issues.
- [ ] **Update dependencies**: `npm audit` clean of high/critical. Patch or pin any flagged packages.
- [ ] **`/security-review`**: run as the final gate before App Store submission.
- [ ] **Bug Rabbit final pass**: run before submission; review and triage findings.

## Pre-Submission Audit

- [ ] All checkboxes above ticked.
- [ ] `/security-review` run on the App-Store-bound branch.
- [ ] One full end-to-end manual test: signup → onboarding → plan view → activity sync → coach chat → settings → delete account.
- [ ] Confirm no API keys, secrets, or `.env` contents in the iOS bundle (`grep -r "sk_live" ios/`, `grep -r "service_role" ios/`).
