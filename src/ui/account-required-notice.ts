/**
 * Account-required migration notice. One-time launch modal for EXISTING guest
 * (anonymous) users after the 2026-07-26 switch to account-required auth.
 *
 * Why: before the switch, first launch silently created an anonymous Supabase
 * session and users could onboard without an account. Their data is backed up
 * under that anonymous user_id, but `updateUser` (upgrade-in-place, which
 * preserves the data) only works while the anonymous session is still alive.
 * Once it dies (reinstall, cleared storage, sign-out, token expiry) they hit
 * the auth wall with no guest fallback and the anonymous data is orphaned.
 *
 * So we nudge them to save their account while the session is live. New users
 * never see this — they create an account up front.
 *
 * Fired from `launchApp` after auth is confirmed and `isGuestAccount` is
 * refreshed. The passive Home / Account "Save your account" banner remains for
 * ongoing nudging; this is the one prominent prompt.
 *
 * Modal pattern mirrors `checkin-overlay.ts` (centered white card, backdrop
 * dismiss). Once-only guard mirrors the feature-reveal rule: gate on BOTH a
 * persisted flag and a module-level boolean, set BOTH on create (not dismiss)
 * so navigating away can't re-pop it.
 */

import { getState, getMutableState, saveState } from '@/state';
import { renderAuthView } from './auth-view';

let shownThisSession = false;

export function maybeShowAccountRequiredNotice(): void {
  if (shownThisSession) return;
  if (document.getElementById('account-required-notice')) return;

  const s = getState();
  if (!s.isGuestAccount) return;            // only existing anonymous users
  if (s.accountRequiredNoticeSeen) return;  // once-only

  // Only interrupt users who have real data worth saving. Same signal the guest
  // banner uses (buildGuestAccountBanner in home-view.ts): any completed workout.
  const hasData = (s.wks ?? []).some(w =>
    Object.values(w.garminActuals ?? {}).some(a => a && (a.distanceKm ?? 0) > 0)
  );
  if (!hasData) return;

  // Set both guards on create so a navigation away can't cause a re-pop.
  shownThisSession = true;
  const ms = getMutableState();
  ms.accountRequiredNoticeSeen = true;
  saveState();

  const overlay = document.createElement('div');
  overlay.id = 'account-required-notice';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.cssText = 'background:rgba(0,0,0,0.45)';

  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
      <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:6px">Save your training history</div>
      <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:18px">
        Mosaic now uses accounts. Your training currently lives only on this device. Create an account to back it up and keep it when you change phones or reinstall. Your existing plan and history carry over.
      </div>

      <button id="account-required-save"
        style="width:100%;padding:13px;border-radius:var(--r-pill);border:none;background:var(--c-black);color:#fff;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:8px">
        Save my account
      </button>

      <button id="account-required-later"
        style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer">
        Not now
      </button>
    </div>
  `;

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  document.getElementById('account-required-later')?.addEventListener('click', () => overlay.remove());
  document.getElementById('account-required-save')?.addEventListener('click', () => {
    overlay.remove();
    // upgradeGuest mode: sign-up uses updateUser to convert the anonymous user
    // in place, preserving the user_id and all attached data.
    renderAuthView({ upgradeGuest: true });
  });
}
