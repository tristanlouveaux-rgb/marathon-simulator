/**
 * ScreenshotOCR. Typed bridge to the MosaicScreenshotOCR Capacitor plugin.
 *
 * On-device Apple Vision text recognition for run-summary screenshots. This is
 * the first engine of the hybrid screenshot-import path; the AI-vision edge
 * function (`screenshot-vision`) is the fallback when OCR confidence is low.
 *
 * iOS-only. Returns an empty array on web/Android so the orchestration in
 * `src/data/screenshotCapture.ts` falls straight through to the AI fallback.
 */

import { registerPlugin } from '@capacitor/core';
import { isIOS } from '@/utils/platform';

interface ScreenshotOCRPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  recognizeText(opts: { imageBase64: string }): Promise<{ lines: string[] }>;
}

/** Underlying plugin handle. On non-iOS the web shim throws when methods are
 *  called. The wrappers below catch and return empty results. */
const ScreenshotOCR = registerPlugin<ScreenshotOCRPlugin>('ScreenshotOCR');

/** True on native iOS, where on-device OCR is available. */
export function isScreenshotOcrAvailable(): boolean {
  return isIOS();
}

/**
 * Run on-device OCR over a base64-encoded image (raw base64 or a `data:` URL).
 * Returns recognised text as visual lines, top-to-bottom, with splits-table
 * cells joined into single rows. Empty array on web/Android or on any error,
 * so callers can treat "no lines" as "OCR unavailable, use the AI fallback".
 */
export async function recognizeScreenshotText(imageBase64: string): Promise<string[]> {
  if (!isIOS()) return [];
  try {
    const res = await ScreenshotOCR.recognizeText({ imageBase64 });
    return res.lines ?? [];
  } catch (err) {
    console.warn('[ScreenshotOCR] recognizeText failed', err);
    return [];
  }
}
