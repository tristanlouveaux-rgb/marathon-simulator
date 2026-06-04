/**
 * Save-account overlay — shown once during onboarding, at the moment a data
 * source connects (Strava/Garmin OAuth return on the connect-data step).
 *
 * Why here (ISSUE-270): the app signs every new user in anonymously. A user
 * who never adds an email loses everything on reinstall, device change, or
 * WKWebView storage eviction, and their next Strava connect forks the history
 * under a fresh user_id. The moment data starts syncing is the moment the
 * account becomes worth protecting, so that is when we ask.
 *
 * Mechanism: supabase.auth.updateUser({ email, password }) converts the
 * anonymous user IN PLACE (same user_id, all data preserved) — the same call
 * the Account-settings upgrade uses (auth-view.ts). signUp() would create a
 * fresh user and orphan the guest data; never use it here.
 *
 * Skippable ("Later"): declining must not block onboarding. The Home guest
 * banner and the Account view remain the fallback surfaces.
 */

import { supabase } from '@/data/supabaseClient';
import { getState } from '@/state';
import { getOnboardingState, updateOnboarding } from './controller';

/**
 * Show the save-account overlay if the session is anonymous and it hasn't
 * been offered this onboarding. Calls `onDone` when the user saves or skips
 * (or immediately when the overlay doesn't apply).
 */
export function maybeOfferAccountSave(onDone: () => void): void {
  const s = getState();
  const ob = getOnboardingState();
  // Only anonymous sessions need saving; isGuestAccount is refreshed from the
  // live session at every launch (main.ts). Offer once per onboarding.
  if (s.isGuestAccount !== true || ob?.accountSaveOffered) {
    onDone();
    return;
  }
  updateOnboarding({ accountSaveOffered: true });
  openSaveAccountOverlay(onDone);
}

function openSaveAccountOverlay(onDone: () => void): void {
  document.getElementById('save-account-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'save-account-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.innerHTML = `
    <style>
      .sa-input { width:100%; height:44px; border-radius:12px; border:1px solid var(--c-border-strong); background:#FFFFFF; padding:0 14px; font-size:14px; color:var(--c-black); box-sizing:border-box; }
      .sa-input:focus { outline:none; border-color:var(--c-black); }
      .sa-save { width:100%; height:46px; border-radius:23px; border:none; background:var(--c-black); color:#FFFFFF; font-size:14px; font-weight:500; cursor:pointer; }
      .sa-save:disabled { opacity:0.55; cursor:default; }
      .sa-later { display:block; margin:12px auto 0; background:transparent; border:none; color:var(--c-muted); font-size:13px; cursor:pointer; }
      .sa-error { font-size:12.5px; color:#B91C1C; line-height:1.5; margin:8px 0 0; }
    </style>
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
      <h3 style="font-size:17px; font-weight:600; color:var(--c-black); margin:0 0 6px;">Save your account</h3>
      <p style="font-size:13px; color:var(--c-muted); line-height:1.55; margin:0 0 16px;">
        Your training data is syncing. Add an email and password so your history can be recovered on any device.
      </p>
      <div style="display:flex; flex-direction:column; gap:10px;">
        <input id="sa-email" class="sa-input" type="email" autocomplete="email" placeholder="Email" />
        <input id="sa-password" class="sa-input" type="password" autocomplete="new-password" placeholder="Password (8+ characters)" />
      </div>
      <div id="sa-error"></div>
      <div style="margin-top:16px;">
        <button id="sa-save" class="sa-save">Save account</button>
        <button id="sa-later" class="sa-later">Later</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const finish = () => {
    overlay.remove();
    onDone();
  };

  // No backdrop dismiss: an accidental tap would silently skip the one moment
  // we protect the account. "Later" is the explicit decline.
  overlay.querySelector('#sa-later')?.addEventListener('click', finish);

  const emailInput = overlay.querySelector('#sa-email') as HTMLInputElement;
  const passwordInput = overlay.querySelector('#sa-password') as HTMLInputElement;
  const saveBtn = overlay.querySelector('#sa-save') as HTMLButtonElement;
  const errorEl = overlay.querySelector('#sa-error') as HTMLElement;

  const showError = (msg: string) => {
    errorEl.innerHTML = `<p class="sa-error">${msg}</p>`;
  };

  // Map raw Supabase auth errors to actionable copy. The "already registered"
  // case has a real next step (sign in instead); rate limits should not read
  // like a fault. Everything else falls back to a generic line that points at
  // the Account-settings retry path.
  const friendlyError = (raw: string): string => {
    const msg = raw.toLowerCase();
    if (msg.includes('already') && (msg.includes('registered') || msg.includes('exists') || msg.includes('in use'))) {
      return 'This email already has a Mosaic account. Skip this step, then use Sign in from the welcome screen to load that account instead.';
    }
    if (msg.includes('rate limit') || msg.includes('too many')) {
      return 'Too many attempts. Wait a minute and try again, or do this later from Account.';
    }
    if (msg.includes('invalid') && msg.includes('email')) {
      return 'Enter a valid email address.';
    }
    return 'Something went wrong. You can also do this later from Account settings.';
  };

  saveBtn?.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !email.includes('@')) { showError('Enter a valid email address.'); return; }
    if (password.length < 8) { showError('Password needs at least 8 characters.'); return; }

    saveBtn.disabled = true;
    errorEl.innerHTML = '';
    try {
      // In-place anonymous upgrade: same user_id, all synced data preserved.
      const { error } = await supabase.auth.updateUser({ email, password });
      if (error) throw error;
      // Honest copy: with email confirmation enabled, the email only attaches
      // once the link is clicked — recovery on a new device depends on it.
      const card = overlay.querySelector('div.max-w-sm') as HTMLElement;
      if (card) {
        card.innerHTML = `
          <h3 style="font-size:17px; font-weight:600; color:var(--c-black); margin:0 0 6px;">One step left</h3>
          <p style="font-size:13px; color:var(--c-muted); line-height:1.55; margin:0 0 16px;">
            A confirmation link was sent to ${email}. Open it to finish securing your account. Until then the email is not attached, and recovery on a new device will not work.
          </p>
          <button id="sa-continue" class="sa-save">Continue</button>
        `;
        card.querySelector('#sa-continue')?.addEventListener('click', finish);
      } else {
        finish();
      }
    } catch (err: unknown) {
      saveBtn.disabled = false;
      showError(friendlyError(err instanceof Error ? err.message : ''));
    }
  });
}
