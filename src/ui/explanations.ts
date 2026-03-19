/**
 * Help modals and tooltips for training concepts.
 */
import { getState } from '@/state/store';

/**
 * Show RPE (Rate of Perceived Exertion) help modal with 1-10 scale breakdown.
 */
export function showRPEHelp(): void {
  const overlay = document.createElement('div');
  overlay.id = 'rpe-help-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:16px;max-width:384px;width:100%;padding:20px">
      <h3 style="font-size:17px;font-weight:600;color:var(--c-black);margin-bottom:4px">RPE Scale</h3>
      <p style="font-size:12px;color:var(--c-faint);margin-bottom:16px">Rate of Perceived Exertion — how hard did it feel?</p>
      <div style="display:flex;flex-direction:column;gap:4px;font-size:12px">
        <div style="display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;background:rgba(22,163,74,0.06)">
          <span style="font-weight:700;color:var(--c-ok);width:24px;text-align:right">1-2</span>
          <span style="color:var(--c-muted)">Very easy — could chat freely</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;background:rgba(22,163,74,0.04)">
          <span style="font-weight:700;color:var(--c-ok);width:24px;text-align:right">3</span>
          <span style="color:var(--c-muted)">Easy — comfortable conversation</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;background:rgba(245,158,11,0.06)">
          <span style="font-weight:700;color:var(--c-caution);width:24px;text-align:right">4-5</span>
          <span style="color:var(--c-muted)">Moderate — short sentences only</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;background:rgba(245,158,11,0.08)">
          <span style="font-weight:700;color:var(--c-caution);width:24px;text-align:right">6</span>
          <span style="color:var(--c-muted)">Hard — a few words at a time</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;background:rgba(239,68,68,0.05)">
          <span style="font-weight:700;color:var(--c-warn);width:24px;text-align:right">7-8</span>
          <span style="color:var(--c-muted)">Very hard — 1-2 words max</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;background:rgba(239,68,68,0.08)">
          <span style="font-weight:700;color:var(--c-warn);width:24px;text-align:right">9</span>
          <span style="color:var(--c-muted)">Near max — gasping</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;background:rgba(239,68,68,0.12)">
          <span style="font-weight:700;color:var(--c-warn);width:24px;text-align:right">10</span>
          <span style="color:var(--c-muted)">Maximum — cannot sustain</span>
        </div>
      </div>
      <button id="btn-close-rpe-help" style="width:100%;margin-top:16px;padding:8px;background:none;border:none;font-size:12px;color:var(--c-faint);cursor:pointer">Close</button>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('#btn-close-rpe-help')?.addEventListener('click', () => overlay.remove());
}

/**
 * Show Marathon Pace help tooltip/modal.
 */
export function showMPHelp(): void {
  const overlay = document.createElement('div');
  overlay.id = 'mp-help-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:16px;max-width:384px;width:100%;padding:20px">
      <h3 style="font-size:17px;font-weight:600;color:var(--c-black);margin-bottom:4px">Marathon Pace (MP)</h3>
      <p style="font-size:12px;color:var(--c-faint);margin-bottom:12px">The pace you'd sustain for a full marathon on race day.</p>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--c-muted)">
        <p>Marathon pace work teaches your body to burn fat efficiently at race speed. It should feel <strong style="color:var(--c-black)">comfortably hard</strong> — you can say a few words but not hold a conversation.</p>
        <p>Typical RPE: <strong style="color:var(--c-caution)">5-6</strong> out of 10.</p>
        <p style="color:var(--c-faint)">If you can't maintain the pace for the full session, it's too fast. Slow down 5-10 sec/${getState().unitPref === 'mi' ? 'mi' : 'km'}.</p>
      </div>
      <button id="btn-close-mp-help" style="width:100%;margin-top:16px;padding:8px;background:none;border:none;font-size:12px;color:var(--c-faint);cursor:pointer">Close</button>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('#btn-close-mp-help')?.addEventListener('click', () => overlay.remove());
}
