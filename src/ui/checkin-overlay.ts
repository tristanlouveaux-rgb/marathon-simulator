/**
 * Check-in overlay — shared between home-view and plan-view.
 *
 * Opens a centered modal with three options: Injured, Ill, Holiday.
 * Injured routes to the injury modal. Ill and Holiday are stubs pending implementation.
 */

import { openInjuryModal } from './injury/modal';
import { openIllnessModal } from './illness-modal';

/**
 * Temporary placeholder overlay for unbuilt check-in flows.
 */
function openComingSoonOverlay(title: string, body: string): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.cssText = 'background:rgba(0,0,0,0.45)';
  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
      <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:6px">${title}</div>
      <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">${body}</div>
      <button id="coming-soon-close"
        style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
               background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer">
        Close
      </button>
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  document.getElementById('coming-soon-close')?.addEventListener('click', () => overlay.remove());
}

/**
 * Opens a centered check-in overlay: Injured / Ill / Holiday.
 */
export function openCheckinOverlay(): void {
  const existing = document.getElementById('checkin-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'checkin-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.cssText = 'background:rgba(0,0,0,0.45)';

  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
      <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:4px">Check-in</div>
      <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px">What do you need to adjust for?</div>

      <button id="checkin-injured"
        style="width:100%;display:flex;align-items:center;padding:11px 14px;border-radius:12px;
               border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:6px;text-align:left">
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--c-black)">Injured</div>
          <div style="font-size:12px;color:var(--c-muted);margin-top:1px">Report pain or injury — adjust the plan</div>
        </div>
        <svg style="margin-left:auto;flex-shrink:0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </button>

      <button id="checkin-ill"
        style="width:100%;display:flex;align-items:center;padding:11px 14px;border-radius:12px;
               border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:6px;text-align:left">
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--c-black)">Ill</div>
          <div style="font-size:12px;color:var(--c-muted);margin-top:1px">Reduce load while unwell</div>
        </div>
        <svg style="margin-left:auto;flex-shrink:0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </button>

      <button id="checkin-holiday"
        style="width:100%;display:flex;align-items:center;padding:11px 14px;border-radius:12px;
               border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:14px;text-align:left">
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--c-black)">Holiday</div>
          <div style="font-size:12px;color:var(--c-muted);margin-top:1px">Away or no access to facilities</div>
        </div>
        <svg style="margin-left:auto;flex-shrink:0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </button>

      <button id="checkin-cancel"
        style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
               background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer">
        Cancel
      </button>
    </div>
  `;

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  document.getElementById('checkin-cancel')?.addEventListener('click', () => overlay.remove());
  document.getElementById('checkin-injured')?.addEventListener('click', () => {
    overlay.remove();
    openInjuryModal();
  });
  document.getElementById('checkin-ill')?.addEventListener('click', () => {
    overlay.remove();
    openIllnessModal();
  });
  document.getElementById('checkin-holiday')?.addEventListener('click', () => {
    overlay.remove();
    openComingSoonOverlay('Holiday mode', 'Plan adjustment for time away — coming soon.');
  });
}
