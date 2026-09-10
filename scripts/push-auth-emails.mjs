#!/usr/bin/env node
/**
 * Push the branded auth email templates in supabase/templates/ to the linked
 * hosted Supabase project via the Management API.
 *
 * Why a script and not `supabase config push`: the [auth.email.template.*]
 * blocks in config.toml apply to LOCAL development only. Hosted projects take
 * their templates from the Dashboard or from PATCH /v1/projects/{ref}/config/auth.
 * Running `supabase config push` against a config.toml that does not mirror
 * every remote auth setting risks resetting the ones it omits, so we touch the
 * mailer fields explicitly and leave the rest of the auth config alone.
 *
 * Usage:
 *   export SUPABASE_ACCESS_TOKEN=...      # https://supabase.com/dashboard/account/tokens
 *   node scripts/push-auth-emails.mjs --dry-run
 *   node scripts/push-auth-emails.mjs
 *
 * Optionally point Supabase at Resend so mail sends from Mosaic's own domain
 * rather than the shared noreply@mail.app.supabase.io sender:
 *   export RESEND_API_KEY=re_...
 *   node scripts/push-auth-emails.mjs --smtp
 *
 * The --smtp flag is opt-in and separate because the templates can be updated
 * freely, while rotating SMTP credentials is the kind of change you want to
 * make deliberately. Verify the sending domain in Resend BEFORE pushing this,
 * or every auth email silently fails to send.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');
const PUSH_SMTP = process.argv.includes('--smtp');

/**
 * Resend SMTP, per https://resend.com/docs/send-with-smtp
 * Port 587 is explicit TLS via STARTTLS. The username is the literal string
 * "resend"; the password is the API key.
 */
const SMTP = {
  host: 'smtp.resend.com',
  port: 587,
  user: 'resend',
  senderName: 'Mosaic',
  adminEmail: 'noreply@mosaicrunning.run',
};

const TEMPLATES = [
  {
    file: 'confirmation.html',
    subjectField: 'mailer_subjects_confirmation',
    contentField: 'mailer_templates_confirmation_content',
    subject: 'Confirm your Mosaic account',
  },
  {
    file: 'recovery.html',
    subjectField: 'mailer_subjects_recovery',
    contentField: 'mailer_templates_recovery_content',
    subject: 'Reset your Mosaic password',
  },
  {
    file: 'email_change.html',
    subjectField: 'mailer_subjects_email_change',
    contentField: 'mailer_templates_email_change_content',
    subject: 'Confirm your Mosaic email address',
  },
];

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) fail('SUPABASE_ACCESS_TOKEN is not set. Create one at https://supabase.com/dashboard/account/tokens');

let projectRef;
try {
  projectRef = readFileSync(resolve(ROOT, 'supabase/.temp/project-ref'), 'utf8').trim();
} catch {
  fail('Could not read supabase/.temp/project-ref. Run `npx supabase link` first.');
}
if (!projectRef) fail('supabase/.temp/project-ref is empty.');

const payload = {};
for (const t of TEMPLATES) {
  const path = resolve(ROOT, 'supabase/templates', t.file);
  let html;
  try {
    html = readFileSync(path, 'utf8');
  } catch {
    fail(`Missing template: supabase/templates/${t.file}`);
  }
  // The confirm link is the entire point of the email. A template that lost its
  // placeholder would send a dead-end mail to every new user, so refuse to push.
  if (!html.includes('{{ .ConfirmationURL }}')) {
    fail(`${t.file} does not contain {{ .ConfirmationURL }} — refusing to push a template with no working link.`);
  }
  payload[t.subjectField] = t.subject;
  payload[t.contentField] = html;
}

if (PUSH_SMTP) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) fail('--smtp requires RESEND_API_KEY. Create one at https://resend.com/api-keys');
  payload.smtp_host = SMTP.host;
  // Management API expects the port as a string, not a number.
  payload.smtp_port = String(SMTP.port);
  payload.smtp_user = SMTP.user;
  payload.smtp_pass = resendKey;
  payload.smtp_sender_name = SMTP.senderName;
  payload.smtp_admin_email = SMTP.adminEmail;
}

console.log(`\n  Project:   ${projectRef}`);
console.log(`  Templates: ${TEMPLATES.map((t) => t.file).join(', ')}`);
for (const t of TEMPLATES) {
  const bytes = Buffer.byteLength(payload[t.contentField], 'utf8');
  console.log(`    ${t.file.padEnd(20)} ${String(bytes).padStart(5)} bytes   subject: "${t.subject}"`);
}

if (PUSH_SMTP) {
  console.log(`  SMTP:      ${SMTP.user}@${SMTP.host}:${SMTP.port}`);
  console.log(`             from "${SMTP.senderName}" <${SMTP.adminEmail}>  (key ${process.env.RESEND_API_KEY.slice(0, 6)}...)`);
} else {
  console.log('  SMTP:      unchanged (pass --smtp to point Supabase at Resend)');
}

if (DRY_RUN) {
  console.log('\n  --dry-run: nothing sent.\n');
  process.exit(0);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  fail(`Management API returned ${res.status}: ${await res.text()}`);
}

console.log('\n  Pushed. Send yourself a test signup to confirm rendering.\n');
