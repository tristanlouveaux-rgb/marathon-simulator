/**
 * Screenshot capture. Hybrid OCR→AI orchestration.
 *
 * Sits between the two engines and the verified parser core
 * (`src/data/screenshotImport.ts`). The strategy:
 *
 *   1. Run on-device Apple Vision OCR (free, private, iOS-only) and parse the
 *      recognised text with `parseScreenshotText`.
 *   2. If the OCR result is confident and complete, use it. No network, no cost.
 *   3. Otherwise (low confidence, missing distance/duration, or no OCR at all —
 *      e.g. on web), fall back to the AI-vision edge function and parse its JSON
 *      with `parsedFromAIJson`.
 *   4. Keep whichever result is better (fewer missing fields, then higher
 *      confidence, then more splits).
 *
 * The engines are injected so the orchestration is unit-testable without a
 * device or a network. The decision helpers (`decideNeedsAI`, `pickBetterParse`)
 * are pure and exported for direct testing.
 */

import {
  parseScreenshotText,
  parsedFromAIJson,
  type ParsedScreenshotActivity,
} from '@/data/screenshotImport';

/** OCR engine: image base64 → recognised text lines (top-to-bottom). */
export type OcrEngine = (imageBase64: string) => Promise<string[]>;

/** AI-vision engine: downscaled image → raw JSON (or null on failure). */
export type AiVisionEngine = (imageBase64: string, mediaType: string) => Promise<unknown | null>;

export interface HybridParseResult {
  parsed: ParsedScreenshotActivity;
  /** Which engine produced the chosen result. */
  source: 'ocr' | 'ai';
  /** Whether the AI fallback was invoked at all (false when OCR was sufficient). */
  usedAI: boolean;
}

const CONFIDENCE_RANK: Record<ParsedScreenshotActivity['confidence'], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Decide whether the AI fallback is worth calling given an OCR-derived parse.
 * We call AI unless OCR is already high-confidence with the two load-bearing
 * fields (distance + duration) present. Pure.
 */
export function decideNeedsAI(ocr: ParsedScreenshotActivity): boolean {
  if (ocr.confidence === 'high') return false;
  return true;
}

/**
 * Choose the better of the OCR and AI parses. AI may be null (engine failed or
 * was never called) in which case OCR wins by default. Comparison is
 * lexicographic: fewer missing fields, then higher confidence, then more
 * splits. Ties go to AI, which is generally more robust on noisy screenshots.
 * Pure.
 */
export function pickBetterParse(
  ocr: ParsedScreenshotActivity,
  ai: ParsedScreenshotActivity | null,
): { parsed: ParsedScreenshotActivity; source: 'ocr' | 'ai' } {
  if (!ai) return { parsed: ocr, source: 'ocr' };

  // Negative missing-count so "fewer missing" sorts higher.
  const ocrScore: [number, number, number] = [-ocr.missing.length, CONFIDENCE_RANK[ocr.confidence], ocr.splits.length];
  const aiScore: [number, number, number] = [-ai.missing.length, CONFIDENCE_RANK[ai.confidence], ai.splits.length];

  for (let i = 0; i < 3; i++) {
    if (aiScore[i] > ocrScore[i]) return { parsed: ai, source: 'ai' };
    if (aiScore[i] < ocrScore[i]) return { parsed: ocr, source: 'ocr' };
  }
  // Exact tie. Prefer AI.
  return { parsed: ai, source: 'ai' };
}

/**
 * Run the hybrid parse. `imageBase64` is the full-resolution image for OCR;
 * `aiImage` is the (typically downscaled) image + media type sent to the AI
 * fallback to keep cost and payload down. If `aiImage` is omitted the OCR
 * image is reused.
 */
export async function runHybridParse(
  imageBase64: string,
  engines: {
    ocr: OcrEngine;
    aiFallback: AiVisionEngine;
    aiImage?: { base64: string; mediaType: string };
  },
): Promise<HybridParseResult> {
  let ocrLines: string[] = [];
  try {
    ocrLines = await engines.ocr(imageBase64);
  } catch {
    ocrLines = [];
  }
  const ocrParsed = parseScreenshotText(ocrLines.join('\n'));

  if (!decideNeedsAI(ocrParsed)) {
    return { parsed: ocrParsed, source: 'ocr', usedAI: false };
  }

  const ai = engines.aiImage ?? { base64: imageBase64, mediaType: 'image/jpeg' };
  let aiJson: unknown | null = null;
  try {
    aiJson = await engines.aiFallback(ai.base64, ai.mediaType);
  } catch {
    aiJson = null;
  }
  const aiParsed = aiJson != null ? parsedFromAIJson(aiJson) : null;

  const best = pickBetterParse(ocrParsed, aiParsed);
  return { parsed: best.parsed, source: best.source, usedAI: aiParsed != null };
}
