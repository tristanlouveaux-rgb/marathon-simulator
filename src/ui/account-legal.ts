/**
 * Account-view legal & data flows: delete account, download data, cancel-deletion banner.
 *
 * These are App Store / GDPR compliance surfaces. The modals follow the UX_PATTERNS
 * glass spec (centered overlay, X close, filled-black primary, transparent secondary).
 *
 * Server contracts:
 *  - `delete-account` edge fn (POST) → marks `user_plan_settings.deleted_at = now()` +
 *     revokes Strava token, returns `{ purge_date }`. 30-day grace.
 *  - `cancel-deletion` edge fn (POST) → clears `deleted_at`.
 *  - `export-user-data` edge fn (GET) → JSON of all user rows (no tokens).
 */

import { supabase, getAccessToken, SUPABASE_FUNCTIONS_BASE } from '@/data/supabaseClient';
import { renderAuthView } from './auth-view';
import { showSimpleToast } from './toast';
import { clearState } from '@/state';
import { setLocalStateOwner } from '@/data/planSettingsSync';

/**
 * Show the destructive-confirmation modal for account deletion.
 * User must type "DELETE" to enable the primary action.
 */
export function openDeleteAccountModal(): void {
  const existing = document.getElementById('delete-account-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'delete-account-overlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:200',
    'background:rgba(0,0,0,0.45)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'padding:20px', 'animation:fadeIn 180ms ease-out',
  ].join(';');

  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" aria-label="Delete account"
         style="position:relative;max-width:420px;width:100%;background:rgba(255,255,255,0.78);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border-radius:16px;padding:28px 24px 22px;box-shadow:0 12px 40px rgba(0,0,0,0.18);border:1px solid rgba(255,255,255,0.6)">
      <button id="delete-close-x" aria-label="Close" style="position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border);background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center">
        <svg width="14" height="14" fill="none" stroke="#444" stroke-width="2.2" stroke-linecap="round" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></svg>
      </button>
      <h2 style="font-size:18px;font-weight:600;color:var(--c-black);margin:0 0 12px">Delete account</h2>
      <p style="font-size:14px;line-height:1.55;color:var(--c-muted);margin:0 0 10px">This schedules your account and all data Mosaic holds about you for permanent deletion in 30 days. You can sign back in before then to cancel.</p>
      <p style="font-size:14px;line-height:1.55;color:var(--c-muted);margin:0 0 16px">Connected services (Strava, Garmin) will be disconnected immediately. Apple Health data stays on your device and is not affected.</p>
      <label for="delete-confirm-input" style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:6px">Type <strong>DELETE</strong> to confirm</label>
      <input id="delete-confirm-input" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
             style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--c-border);border-radius:10px;background:#fff;color:var(--c-black);outline:none;margin-bottom:6px" />
      <div id="delete-status" style="min-height:18px;font-size:12px;color:var(--c-warn);margin-bottom:14px"></div>
      <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end">
        <button id="delete-cancel" style="padding:10px 16px;border:none;background:none;font-size:14px;color:var(--c-muted);cursor:pointer">Cancel</button>
        <button id="delete-confirm" class="m-btn-primary" disabled style="padding:10px 20px;font-size:14px;cursor:not-allowed;opacity:0.4">Delete account</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#delete-confirm-input') as HTMLInputElement;
  const confirmBtn = overlay.querySelector('#delete-confirm') as HTMLButtonElement;
  const status = overlay.querySelector('#delete-status') as HTMLElement;

  input.focus();
  input.addEventListener('input', () => {
    const ok = input.value.trim() === 'DELETE';
    confirmBtn.disabled = !ok;
    confirmBtn.style.cursor = ok ? 'pointer' : 'not-allowed';
    confirmBtn.style.opacity = ok ? '1' : '0.4';
    status.textContent = '';
  });

  const close = (): void => { overlay.remove(); };
  overlay.querySelector('#delete-close-x')?.addEventListener('click', close);
  overlay.querySelector('#delete-cancel')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  confirmBtn.addEventListener('click', async () => {
    if (input.value.trim() !== 'DELETE') return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting…';
    status.style.color = 'var(--c-muted)';
    status.textContent = '';

    try {
      const token = await getAccessToken();
      const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/delete-account`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      const body = await res.json().catch(() => ({}));
      const purgeDate = body?.purge_date ? new Date(body.purge_date).toLocaleDateString() : 'in 30 days';

      // HYROX Doubles partner: end the link and delete the shared race
      // snapshot now, so a partner stops reading this account's numbers at
      // once rather than at the purge. Best effort; never blocks deletion.
      try {
        const { removeMyHyroxPartnerData } = await import('@/data/hyroxPartner');
        await removeMyHyroxPartnerData();
      } catch { /* ignore */ }

      // Sign out and clear local state. signOut() fires SIGNED_OUT, whose
      // handler (main.ts) clears the per-device cache and HARD RELOADS the
      // page (the reload is what guarantees the old account's in-memory state
      // and sync timers die). Because the reload wipes this execution context,
      // the "deletion scheduled" confirmation is stashed as a one-shot flag
      // that the auth wall shows after the reload. Clear here too as
      // defense-in-depth in case the listener is slow.
      try { localStorage.setItem('mosaic_deletion_toast', purgeDate); } catch { /* ignore */ }
      try { clearState(); setLocalStateOwner(null); } catch { /* ignore */ }
      try { await supabase.auth.signOut(); } catch { /* ignore */ }
      // Normally unreachable (the SIGNED_OUT reload fires first) — fallback
      // for the pathological case where signOut threw before the event.
      overlay.remove();
      showDeletionScheduledToast(purgeDate);
      renderAuthView();
    } catch (err) {
      status.style.color = 'var(--c-warn)';
      status.textContent = err instanceof Error && err.message ? err.message : 'Something went wrong. Try again, or email tristan@mosaicrunning.run.';
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Delete account';
    }
  });
}

/**
 * Trigger an export of the current user's data. Saves the JSON via download.
 */
export async function triggerDataExport(buttonId = 'btn-export-data'): Promise<void> {
  const btn = document.getElementById(buttonId) as HTMLButtonElement | null;
  const originalLabel = btn?.querySelector('div > div')?.textContent ?? 'Download my data';
  if (btn) {
    btn.style.pointerEvents = 'none';
    btn.style.opacity = '0.6';
    const label = btn.querySelector('div > div');
    if (label) label.textContent = 'Preparing…';
  }

  try {
    const token = await getAccessToken();
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/export-user-data`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mosaic-data-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    const msg = err instanceof Error && err.message ? err.message : 'Export failed.';
    showSimpleToast(`Could not download your data: ${msg}\nIf this persists, email tristan@mosaicrunning.run.`, 'error');
  } finally {
    if (btn) {
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
      const label = btn.querySelector('div > div');
      if (label) label.textContent = originalLabel;
    }
  }
}

/**
 * After a deletion request completes, show a transient toast on the auth screen.
 */
function showDeletionScheduledToast(purgeDate: string): void {
  const toast = document.createElement('div');
  toast.style.cssText = [
    'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
    'background:rgba(26,26,26,0.92)', 'color:#fff', 'padding:14px 18px',
    'border-radius:12px', 'font-size:13px', 'line-height:1.5',
    'box-shadow:0 8px 24px rgba(0,0,0,0.25)',
    'z-index:300', 'max-width:90vw', 'text-align:center',
  ].join(';');
  toast.textContent = `Account scheduled for deletion on ${purgeDate}. Sign in again before then to cancel.`;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 400ms'; }, 6000);
  setTimeout(() => toast.remove(), 6500);
}

/**
 * Check whether the current user has a pending deletion. Returns the purge_date if so.
 * Called on sign-in to surface a cancellation banner.
 */
export async function getPendingDeletion(): Promise<{ purgeDate: string } | null> {
  try {
    const token = await getAccessToken();
    if (!token) return null;
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/delete-account?status=1`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as { deleted_at?: string | null; purge_date?: string | null } | null;
    if (!body?.deleted_at || !body?.purge_date) return null;
    return { purgeDate: body.purge_date };
  } catch {
    return null;
  }
}

/**
 * Cancel a pending deletion for the current user.
 */
export async function cancelPendingDeletion(): Promise<boolean> {
  try {
    const token = await getAccessToken();
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/delete-account?cancel=1`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
