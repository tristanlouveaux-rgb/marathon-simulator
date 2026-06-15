/**
 * Guided "bring your Strava history" overlay.
 *
 * Getting a full training history out of Strava is a two-stage, asynchronous
 * process that is not obvious: the bulk export is requested on the Strava
 * website and arrives by email hours later. A generic file-picker does not
 * explain that, so users stall. This screen walks the two stages explicitly,
 * deep-links to the Strava archive-request page, then funnels the emailed .zip
 * into the existing `importActivityArchive` (which recomputes weekly baselines,
 * CTL, archetype and PBs from the whole history).
 *
 * No third-party API: the user exports their own data (a portability right), so
 * this needs no Strava approval and is uncapped. Complements the generic
 * `import-activity-modal.ts`; this one is the focused, linear Strava path.
 *
 * Vertically centered glass overlay per docs/UX_PATTERNS.md → Overlays and Modals.
 */

import { showSimpleToast } from '@/ui/toast';

const OVERLAY_ID = 'strava-history-guide';

// Strava's bulk-export request lives on the account "Download or Delete Your
// Account" page (Request Your Archive). Long-stable URL; re-verify if Strava
// reorganises account settings.
const STRAVA_ARCHIVE_URL = 'https://www.strava.com/athlete/delete_your_account';

let onCompleteCb: (() => void) | undefined;

/** Open the guided Strava-history overlay. No-op if already open. */
export function openStravaHistoryGuide(opts: { onComplete?: () => void } = {}): void {
  if (document.getElementById(OVERLAY_ID)) return;
  onCompleteCb = opts.onComplete;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);

  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" aria-labelledby="strava-guide-title"
         style="width:min(440px,100%);max-height:90dvh;overflow-y:auto;overscroll-behavior:contain;background:rgba(255,255,255,0.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.18);padding:20px;position:relative">
      <button id="strava-guide-close" aria-label="Close"
              style="position:absolute;top:12px;right:12px;width:28px;height:28px;border:none;background:transparent;color:var(--c-muted);font-size:18px;cursor:pointer;line-height:1;padding:0">×</button>

      <div id="strava-guide-title" style="font-size:16px;font-weight:600;color:#0F172A;letter-spacing:-0.01em;margin-bottom:6px;padding-right:28px">Bring your Strava history</div>
      <div style="font-size:12.5px;color:var(--c-muted);line-height:1.5;margin-bottom:18px">Strava sends your full history as one export file. Request it once, then upload it here. Heart rate, zones, splits and pace all come straight from the file.</div>

      ${step('1', 'Request your export', 'Strava builds the file on their website and emails you a download link. This usually takes a few hours, so request it now and come back when it arrives.')}
      <a id="strava-guide-open" href="${STRAVA_ARCHIVE_URL}" target="_blank" rel="noopener"
         style="display:block;margin:0 0 16px;padding:12px 14px;border-radius:10px;background:transparent;border:1px solid var(--c-border);color:var(--c-black);font-size:13.5px;font-weight:500;text-align:center;text-decoration:none">
        Open Strava export page →
      </a>

      ${step('2', 'Wait for the email', 'Strava emails a link to download your archive .zip. Save it to your phone or Files when it lands.')}
      ${step('3', 'Upload the .zip here', 'Come back and choose the export .zip below. Every run, ride and swim imports at once.')}

      <label id="strava-guide-label" style="display:block;margin-top:8px;padding:12px 14px;border-radius:10px;background:var(--c-black, #0F172A);color:#FDFCF7;font-size:14px;font-weight:500;text-align:center;cursor:pointer">
        Upload export .zip
        <input id="strava-guide-input" type="file" accept=".zip" style="display:none" />
      </label>
      <div id="strava-guide-status" style="font-size:12.5px;color:var(--c-muted);line-height:1.5;margin-top:10px;text-align:center;min-height:1px"></div>

      <div style="display:flex;justify-content:flex-end;margin-top:16px">
        <button id="strava-guide-done" class="m-btn-secondary" style="padding:10px 18px;font-size:14px">Done</button>
      </div>
    </div>
  `;

  document.getElementById('strava-guide-close')?.addEventListener('click', close);
  document.getElementById('strava-guide-done')?.addEventListener('click', close);
  document.getElementById('strava-guide-input')?.addEventListener('change', onFile);
}

/** A numbered step row. */
function step(n: string, title: string, body: string): string {
  return `
    <div style="display:flex;gap:12px;margin-bottom:14px">
      <div style="flex-shrink:0;width:24px;height:24px;border-radius:50%;border:1px solid var(--c-border);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--c-black)">${n}</div>
      <div style="min-width:0">
        <div style="font-size:13.5px;font-weight:600;color:#0F172A;margin-bottom:2px">${title}</div>
        <div style="font-size:12.5px;color:var(--c-muted);line-height:1.5">${body}</div>
      </div>
    </div>
  `;
}

async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const statusEl = document.getElementById('strava-guide-status');
  const label = document.getElementById('strava-guide-label') as HTMLLabelElement | null;
  if (!file.name.toLowerCase().endsWith('.zip')) {
    if (statusEl) statusEl.textContent = 'That is not a .zip. Choose the export archive Strava emailed you.';
    input.value = '';
    return;
  }
  if (statusEl) statusEl.textContent = 'Reading archive…';
  if (label) label.style.pointerEvents = 'none';
  try {
    const { importActivityArchive } = await import('@/data/fitImport');
    const result = await importActivityArchive(file, (done, total) => {
      if (statusEl) statusEl.textContent = `Reading archive… ${done}/${total}`;
    });
    if (statusEl) statusEl.textContent = result.summary;
    showSimpleToast(result.summary, 'info');
    input.value = '';
    onCompleteCb?.();
  } catch (err) {
    const detail = err instanceof Error ? err.message : '';
    if (statusEl) statusEl.textContent = `Could not read that archive. ${detail}`.trim();
    showSimpleToast('Could not read that archive', 'error');
    input.value = '';
  } finally {
    if (label) label.style.pointerEvents = '';
  }
}

function close(): void {
  document.getElementById(OVERLAY_ID)?.remove();
  onCompleteCb = undefined;
}
