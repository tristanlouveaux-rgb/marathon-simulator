/**
 * One-time health disclaimer modal. Required for App Store §1.4 (Safety/Physical Harm)
 * compliance — any fitness/training app that prescribes load must surface a clear
 * medical-device disclaimer and obtain user acknowledgement.
 *
 * Triggered once per device per user. Persisted via `state.healthDisclaimerAcknowledged`.
 * Fires for both new (post-wizard) and existing (pre-update) users on next launch.
 *
 * Follows the UX_PATTERNS glass spec: centered overlay, X close, filled-black primary
 * CTA, transparent secondary. No emoji, consultant tone.
 */

import { getMutableState, getState } from '@/state/store';
import { saveState } from '@/state/persistence';

let shownThisSession = false;

/**
 * If the user has not yet acknowledged the health disclaimer, show the modal.
 * Returns a promise that resolves once the modal has been dismissed (or skipped).
 * No-op for already-acknowledged users.
 */
export function maybeShowHealthDisclaimer(): Promise<void> {
  if (shownThisSession) return Promise.resolve();
  const state = getState();
  if (state.healthDisclaimerAcknowledged) return Promise.resolve();
  if (document.getElementById('health-disclaimer-overlay')) return Promise.resolve();

  shownThisSession = true;

  return new Promise<void>((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'health-disclaimer-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:210',
      'background:rgba(0,0,0,0.45)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:20px',
    ].join(';');

    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-label="Health disclaimer"
           style="position:relative;max-width:420px;width:100%;background:rgba(255,255,255,0.78);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border-radius:16px;padding:28px 24px 22px;box-shadow:0 12px 40px rgba(0,0,0,0.18);border:1px solid rgba(255,255,255,0.6)">
        <h2 style="font-size:18px;font-weight:600;color:var(--c-black);margin:0 0 14px">Before you start training</h2>
        <p style="font-size:14px;line-height:1.6;color:var(--c-muted);margin:0 0 12px">Mosaic is not a medical device and does not provide medical advice. Training plans, fitness benchmarks, and coaching suggestions are informational only.</p>
        <p style="font-size:14px;line-height:1.6;color:var(--c-muted);margin:0 0 12px">Consult a physician before starting any training programme, particularly if you have a pre-existing medical condition, are returning from injury, or are pregnant.</p>
        <p style="font-size:14px;line-height:1.6;color:var(--c-muted);margin:0 0 18px">You are responsible for your own training decisions and for stopping any session that does not feel right.</p>
        <label for="hd-ack" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-bottom:16px;padding:10px 12px;border:1px solid var(--c-border);border-radius:10px;background:rgba(255,255,255,0.5)">
          <input id="hd-ack" type="checkbox" style="margin-top:3px;cursor:pointer" />
          <span style="font-size:13px;line-height:1.5;color:var(--c-black)">I understand and accept that Mosaic's recommendations are informational, not medical advice.</span>
        </label>
        <button id="hd-confirm" disabled
                style="width:100%;padding:12px;border-radius:999px;border:none;background:#1a1a1a;color:#fff;font-size:14px;font-weight:500;cursor:not-allowed;opacity:0.4">Continue</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const ack = overlay.querySelector('#hd-ack') as HTMLInputElement;
    const btn = overlay.querySelector('#hd-confirm') as HTMLButtonElement;

    ack.addEventListener('change', () => {
      btn.disabled = !ack.checked;
      btn.style.cursor = ack.checked ? 'pointer' : 'not-allowed';
      btn.style.opacity = ack.checked ? '1' : '0.4';
    });

    btn.addEventListener('click', () => {
      if (!ack.checked) return;
      const ms = getMutableState();
      ms.healthDisclaimerAcknowledged = true;
      ms.healthDisclaimerAcknowledgedISO = new Date().toISOString();
      try { saveState(); } catch { /* ignore */ }
      overlay.remove();
      resolve();
    });
  });
}
