/**
 * Simple "turn on Apple Health in Garmin Connect" walkthrough.
 *
 * Garmin/COROS/Polar workouts only reach Mosaic through Apple Health once the
 * user enables that write in the watch's own app. Without it they sync nothing
 * and don't know why. This is an instructions-only overlay (no upload, no async)
 * opened from the connect step. Glass overlay per docs/UX_PATTERNS.md.
 */

const OVERLAY_ID = 'garmin-apple-health-guide';

export function openGarminAppleHealthGuide(): void {
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);

  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" aria-labelledby="gah-title"
         style="width:min(420px,100%);max-height:90dvh;overflow-y:auto;overscroll-behavior:contain;background:rgba(255,255,255,0.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.18);padding:20px;position:relative">
      <button id="gah-close" aria-label="Close"
              style="position:absolute;top:12px;right:12px;width:28px;height:28px;border:none;background:transparent;color:var(--c-muted);font-size:18px;cursor:pointer;line-height:1;padding:0">×</button>

      <div id="gah-title" style="font-size:16px;font-weight:600;color:#0F172A;letter-spacing:-0.01em;margin-bottom:6px;padding-right:28px">Turn on Apple Health in Garmin Connect</div>
      <div style="font-size:12.5px;color:var(--c-muted);line-height:1.5;margin-bottom:18px">A one-time setup. Once it's on, your Garmin workouts and recovery data flow into Mosaic automatically through Apple Health.</div>

      ${step('1', 'Open the Garmin Connect app on your iPhone.')}
      ${step('2', 'Tap More, then Settings, then Apple Health.')}
      ${step('3', 'Turn on Apple Health and allow it to share activities, heart rate, and sleep.')}

      <div style="font-size:11.5px;color:var(--c-faint);line-height:1.5;margin-top:6px">COROS and Polar have the same Apple Health option in their own app's settings.</div>

      <div style="display:flex;justify-content:flex-end;margin-top:16px">
        <button id="gah-done" class="m-btn-secondary" style="padding:10px 18px;font-size:14px">Got it</button>
      </div>
    </div>
  `;

  document.getElementById('gah-close')?.addEventListener('click', close);
  document.getElementById('gah-done')?.addEventListener('click', close);
}

function step(n: string, body: string): string {
  return `
    <div style="display:flex;gap:12px;margin-bottom:14px;align-items:flex-start">
      <div style="flex-shrink:0;width:24px;height:24px;border-radius:50%;border:1px solid var(--c-border);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--c-black)">${n}</div>
      <div style="font-size:13px;color:var(--c-black);line-height:1.5;padding-top:2px">${body}</div>
    </div>
  `;
}

function close(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}
