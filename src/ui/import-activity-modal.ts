/**
 * Guided "import an activity file" modal.
 *
 * A mobile-friendly walkthrough for importing a .fit / .gpx / .tcx file the
 * user exported from their watch or activity app. This is the free pathway to
 * per-km splits and full heart rate for users whose data does not bridge richly
 * through Apple Health. Notably Garmin, whose GPS route and speed stream do not
 * reach Apple Health, so per-km splits can only come from the original file.
 *
 * It does NOT touch any third-party API: the user imports their own exported
 * file, which is their data-portability right, so it needs no Strava/Garmin
 * approval and carries no third-party branding.
 *
 * Reused from the Account screen and the onboarding connect step. Single files
 * route to `importActivityFile()`; a full export `.zip` (Strava archive or
 * Garmin "request your data" bundle) routes to `importActivityArchive()`, both
 * in `@/data/fitImport`. This file is purely the guided UI. Modelled on the
 * glass-modal pattern in `triathlon/swim-normalisation-reveal.ts`
 * (vertically centered overlay, per docs/UX_PATTERNS.md → Overlays and Modals).
 */

import { showSimpleToast } from '@/ui/toast';

const OVERLAY_ID = 'import-activity-modal';

/** Fires after any successful import (single file or archive). Set per-open. */
let onCompleteCb: (() => void) | undefined;

/**
 * Open the guided activity-file import modal. No-op if already open.
 *
 * `opts.onComplete` runs after a successful import. Used by the onboarding
 * data-source step to reveal its Continue button and nudge guests to save
 * their account so imported runs sync to their phone.
 */
export function openImportActivityModal(opts: { onComplete?: () => void } = {}): void {
  if (document.getElementById(OVERLAY_ID)) return;
  onCompleteCb = opts.onComplete;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);

  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" aria-labelledby="import-modal-title"
         style="width:min(440px,100%);max-height:90dvh;overflow-y:auto;overscroll-behavior:contain;background:rgba(255,255,255,0.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.18);padding:20px;position:relative">
      <button id="import-modal-close" aria-label="Close"
              style="position:absolute;top:12px;right:12px;width:28px;height:28px;border:none;background:transparent;color:var(--c-muted);font-size:18px;cursor:pointer;line-height:1;padding:0">×</button>

      <div id="import-modal-title" style="font-size:16px;font-weight:600;color:#0F172A;letter-spacing:-0.01em;margin-bottom:6px;padding-right:28px">Import your runs</div>
      <div style="font-size:12.5px;color:var(--c-muted);line-height:1.5;margin-bottom:16px">Add a single run, or your full history in one export .zip. Heart rate, zones, splits, and pace all come straight from the file.</div>

      ${howTo('Bring your full history (.zip)', 'Export everything at once, then upload the .zip here. From Garmin, request your data at garmin.com/account/datamanagement. The export takes a few days to arrive by email. From Strava, request your archive under Settings, My Account, Download or Delete Your Account.')}
      ${howTo('A single run from Garmin', 'Open connect.garmin.com, open the activity, tap the gear icon, and choose Export Original. Then choose that file below.')}
      ${howTo('A single run from Strava', 'Open the activity in Strava, choose Export (original or GPX), then choose that file below.')}
      ${howTo('From Apple Watch', 'Apple Watch runs already sync through Apple Health, so you usually will not need this. To import a single file, save it to Files first, then choose it below.')}

      <label id="import-choose-label" style="display:block;margin-top:16px;padding:12px 14px;border-radius:10px;background:var(--c-black, #0F172A);color:#FDFCF7;font-size:14px;font-weight:500;text-align:center;cursor:pointer">
        Choose file or .zip
        <input id="import-modal-input" type="file" accept=".fit,.gpx,.tcx,.zip" style="display:none" />
      </label>
      <div id="import-modal-status" style="font-size:12.5px;color:var(--c-muted);line-height:1.5;margin-top:10px;text-align:center;min-height:1px"></div>

      <div style="display:flex;justify-content:flex-end;margin-top:16px">
        <button id="import-modal-done" style="padding:10px 18px;background:transparent;border:1px solid var(--c-border);border-radius:10px;color:var(--c-black);font-size:14px;font-weight:500;cursor:pointer">Done</button>
      </div>
    </div>
  `;

  document.getElementById('import-modal-close')?.addEventListener('click', close);
  document.getElementById('import-modal-done')?.addEventListener('click', close);
  document.getElementById('import-modal-input')?.addEventListener('change', onFile);
}

/** A collapsible "how to export" step. Plain-text instructions, no third-party logos. */
function howTo(title: string, body: string): string {
  return `
    <details style="border:1px solid var(--c-border);border-radius:10px;margin-bottom:8px;overflow:hidden">
      <summary style="padding:11px 14px;list-style:none;cursor:pointer;font-size:13.5px;color:var(--c-black);display:flex;align-items:center;justify-content:space-between;gap:10px">
        <span>${title}</span>
        <span style="color:var(--c-muted);font-size:12px;flex-shrink:0">Show steps</span>
      </summary>
      <div style="padding:0 14px 12px;font-size:12.5px;color:var(--c-muted);line-height:1.55">${body}</div>
    </details>
  `;
}

async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const statusEl = document.getElementById('import-modal-status');
  const label = document.getElementById('import-choose-label') as HTMLLabelElement | null;
  const isZip = file.name.toLowerCase().endsWith('.zip');
  if (statusEl) statusEl.textContent = isZip ? 'Reading archive…' : 'Reading file…';
  if (label) label.style.pointerEvents = 'none';
  try {
    let msg: string;
    if (isZip) {
      // Full Strava / Garmin export. Many activities in one .zip.
      const { importActivityArchive } = await import('@/data/fitImport');
      const result = await importActivityArchive(file, (done, total) => {
        if (statusEl) statusEl.textContent = `Reading archive… ${done}/${total}`;
      });
      msg = result.summary;
    } else {
      const { importActivityFile } = await import('@/data/fitImport');
      msg = await importActivityFile(file);
    }
    if (statusEl) statusEl.textContent = msg;
    showSimpleToast(msg, 'info');
    input.value = '';
    onCompleteCb?.();
  } catch (err) {
    const detail = err instanceof Error ? err.message : '';
    if (statusEl) statusEl.textContent = `Could not read that file. ${detail}`.trim();
    showSimpleToast('Could not read that file', 'error');
    input.value = '';
  } finally {
    if (label) label.style.pointerEvents = '';
  }
}

function close(): void {
  document.getElementById(OVERLAY_ID)?.remove();
  onCompleteCb = undefined;
}
