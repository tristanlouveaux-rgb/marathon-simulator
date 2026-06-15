/**
 * Native "Share to Mosaic" intake — the WebView-side seam for the iOS share
 * sheet / "Open in Mosaic" path.
 *
 * The easiest manual upload from a phone is: in Strava (website) tap Export
 * Original, then from the downloaded file tap Share -> Mosaic. iOS then hands
 * the app the file. The native layer base64-encodes it and calls the global
 * registered here; we decode it to a File and route it through
 * `ingestActivityFile`, which auto-attaches it to the matching thin run (or
 * imports it as new). The user never has to open the app, find the run, and
 * pick the file by hand.
 *
 * The native wiring is a separate iOS build and is NOT done here:
 *   1. Info.plist: declare `CFBundleDocumentTypes` (+ imported UTIs) for .fit,
 *      .gpx, .tcx and .gz so the share sheet offers Mosaic for those files.
 *   2. Handle the opened file (AppDelegate `application(_:open:options:)`, or
 *      `@capacitor/app` `appUrlOpen`), read its bytes, base64-encode, and call
 *      `window.__mosaicIngestSharedFile({ name, base64 })`.
 * This module is the single, stable entry that native step 2 targets, so the
 * native code stays a thin call into existing, tested TS.
 */

import { showSimpleToast } from '@/ui/toast';

function base64ToFile(name: string, base64: string): File {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name);
}

let busy = false;

/**
 * Decode a base64 activity file handed over by the native share sheet and route
 * it through the auto-attach importer. Toasts the outcome. Re-entrancy-guarded
 * so a double-fire from the OS can't double-import.
 */
export async function ingestSharedActivityFile(payload: { name?: string; base64: string }): Promise<void> {
  if (busy || !payload?.base64) return;
  busy = true;
  try {
    const file = base64ToFile(payload.name || 'shared-activity.fit', payload.base64);
    const { ingestActivityFile } = await import('@/data/fitImport');
    const result = await ingestActivityFile(file);
    showSimpleToast(result.message, 'info');
  } catch (e) {
    console.warn('[SharedFileIntake] failed:', e);
    showSimpleToast(e instanceof Error ? e.message : 'Could not read that file.', 'error');
  } finally {
    busy = false;
  }
}

/** Register the global the native share-sheet handler calls. Idempotent. */
export function initSharedFileIntake(): void {
  (window as unknown as { __mosaicIngestSharedFile?: typeof ingestSharedActivityFile })
    .__mosaicIngestSharedFile = ingestSharedActivityFile;
}
