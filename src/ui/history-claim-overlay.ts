/**
 * History-claim overlay — shown after a Strava connect on the main view when
 * the fork guard found activities under prior accounts (ISSUE-270).
 *
 * Mid-wizard the claim runs silently (main.ts); here an established plan
 * already exists, so the user confirms before their history merges in.
 * Canonical centered-overlay pattern (UX_PATTERNS → Overlays and Modals).
 */

import { claimStravaHistory } from '@/data/strava-claim';

export function openHistoryClaimOverlay(existingCount: number, onDone: () => void): void {
  document.getElementById('history-claim-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'history-claim-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.innerHTML = `
    <style>
      .hc-primary { width:100%; height:46px; border-radius:23px; border:none; background:var(--c-black); color:#FFFFFF; font-size:14px; font-weight:500; cursor:pointer; }
      .hc-primary:disabled { opacity:0.55; cursor:default; }
      .hc-later { display:block; margin:12px auto 0; background:transparent; border:none; color:var(--c-muted); font-size:13px; cursor:pointer; }
    </style>
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
      <h3 style="font-size:17px; font-weight:600; color:var(--c-black); margin:0 0 6px;">Previous training history found</h3>
      <p style="font-size:13px; color:var(--c-muted); line-height:1.55; margin:0 0 16px;">
        ${existingCount} activities from this Strava account exist from a previous session. Importing them restores your training history, benchmarks, and load baseline.
      </p>
      <button id="hc-import" class="hc-primary">Import ${existingCount} activities</button>
      <button id="hc-later" class="hc-later">Not now</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const finish = () => {
    overlay.remove();
    onDone();
  };

  overlay.querySelector('#hc-later')?.addEventListener('click', finish);

  overlay.querySelector('#hc-import')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#hc-import') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Importing…';
    const result = await claimStravaHistory();
    if (result && result.moved > 0) {
      btn.textContent = `Imported ${result.moved} activities`;
      setTimeout(finish, 900);
    } else {
      btn.textContent = 'Import failed. Try again from Account.';
      setTimeout(finish, 1600);
    }
  });
}
