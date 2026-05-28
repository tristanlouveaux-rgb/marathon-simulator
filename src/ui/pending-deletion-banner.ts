/**
 * Pending-deletion banner. Surfaces a non-blocking overlay if the signed-in
 * user has a scheduled account deletion within the 30-day grace window.
 *
 * Fired from `launchApp` after authentication. The user can tap "Cancel
 * deletion" to clear the soft-delete and resume using the app, or dismiss
 * the banner and continue knowing the account will be purged.
 *
 * Data path: server-side via the `delete-account?status=1` edge function.
 * We don't read `user_plan_settings.deleted_at` directly because the RLS
 * policy hides soft-deleted rows from the user.
 */

import { getPendingDeletion, cancelPendingDeletion } from './account-legal';
import { showSimpleToast } from './toast';

let shownThisSession = false;

export async function checkAndShowPendingDeletion(): Promise<void> {
  if (shownThisSession) return;
  if (document.getElementById('pending-deletion-banner')) return;

  const status = await getPendingDeletion();
  if (!status) return;

  shownThisSession = true;

  const purgeDateLabel = (() => {
    try {
      return new Date(status.purgeDate).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      });
    } catch {
      return status.purgeDate;
    }
  })();

  const banner = document.createElement('div');
  banner.id = 'pending-deletion-banner';
  banner.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:150',
    'background:#7a1d1d', 'color:#fff',
    'padding:14px 16px',
    'display:flex', 'align-items:center', 'gap:12px',
    'box-shadow:0 2px 12px rgba(0,0,0,0.2)',
    'font-size:13px', 'line-height:1.5',
    `padding-top:max(14px, env(safe-area-inset-top, 14px))`,
  ].join(';');

  banner.innerHTML = `
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;margin-bottom:2px">Account deletion scheduled</div>
      <div style="opacity:0.9">Your account will be permanently deleted on ${purgeDateLabel}.</div>
    </div>
    <button id="pdb-cancel" style="padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,0.4);background:rgba(255,255,255,0.1);color:#fff;font-size:13px;font-weight:500;cursor:pointer;flex-shrink:0">Cancel</button>
    <button id="pdb-dismiss" aria-label="Dismiss banner" style="width:30px;height:30px;border-radius:50%;border:none;background:rgba(255,255,255,0.1);color:#fff;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center">
      <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></svg>
    </button>
  `;
  document.body.appendChild(banner);

  banner.querySelector('#pdb-dismiss')?.addEventListener('click', () => {
    banner.remove();
  });

  banner.querySelector('#pdb-cancel')?.addEventListener('click', async () => {
    const cancelBtn = banner.querySelector('#pdb-cancel') as HTMLButtonElement | null;
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
      cancelBtn.style.opacity = '0.6';
    }
    const ok = await cancelPendingDeletion();
    banner.remove();
    if (ok) {
      // Light confirmation toast.
      const toast = document.createElement('div');
      toast.style.cssText = [
        'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
        'background:rgba(26,26,26,0.92)', 'color:#fff', 'padding:12px 18px',
        'border-radius:12px', 'font-size:13px', 'box-shadow:0 8px 24px rgba(0,0,0,0.25)',
        'z-index:300',
      ].join(';');
      toast.textContent = 'Account deletion cancelled. Welcome back.';
      document.body.appendChild(toast);
      setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 400ms'; }, 4000);
      setTimeout(() => toast.remove(), 4500);
      // Reload state from server now that user_plan_settings is visible again.
      try {
        const { restorePlanFromSupabase } = await import('@/data/planSettingsSync');
        await restorePlanFromSupabase();
      } catch { /* non-fatal; next launch will pick it up */ }
      window.location.reload();
    } else {
      showSimpleToast('Could not cancel deletion. Try again or email tristan@mosaicrunning.run.', 'error');
    }
  });
}
