/**
 * Hybrid OCR→AI orchestration.
 *
 * Engines are injected (no device, no network). The full Strava OCR fixture is
 * borrowed from screenshotImport.test.ts so a "good OCR" case parses to high
 * confidence and the AI fallback is never called.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runHybridParse,
  decideNeedsAI,
  pickBetterParse,
} from './screenshotCapture';
import { parseScreenshotText } from './screenshotImport';

// A clean Strava run screenshot, as OCR would yield it (high confidence).
const GOOD_OCR_LINES = [
  'Run',
  'Splits',
  'Km Pace Elev HR',
  '1 5:30 7 131',
  '2 5:29 -1 133',
  '3 5:29 5 133',
  '4 5:52 -1 129',
  'Avg Pace 5:41 /km',
  'Moving Time 42:34',
  'Avg Heart Rate 132 bpm',
  'Max Heart Rate 146 bpm',
  'Distance 7.5',
];

// A blurry / partial OCR pass — distance + duration unreadable, low confidence.
const POOR_OCR_LINES = ['Run', 'some blurry text', 'Avg Heart Rate 140 bpm'];

const CLEAN_AI_JSON = {
  distanceM: 7500,
  durationSec: 2554,
  avgPaceSecKm: 341,
  avgHR: 132,
  maxHR: 146,
  splits: [
    { km: 1, paceSecKm: 330, hr: 131 },
    { km: 2, paceSecKm: 329, hr: 133 },
    { km: 3, paceSecKm: 329, hr: 133 },
  ],
};

describe('decideNeedsAI', () => {
  it('skips AI when OCR is high confidence', () => {
    expect(decideNeedsAI(parseScreenshotText(GOOD_OCR_LINES.join('\n')))).toBe(false);
  });
  it('calls AI when OCR is low confidence', () => {
    expect(decideNeedsAI(parseScreenshotText(POOR_OCR_LINES.join('\n')))).toBe(true);
  });
  it('calls AI on medium confidence (no splits / no HR signal)', () => {
    const medium = parseScreenshotText('Distance 7.5\nMoving Time 42:34');
    expect(medium.confidence).toBe('medium');
    expect(decideNeedsAI(medium)).toBe(true);
  });
});

describe('pickBetterParse', () => {
  it('keeps OCR when AI is null', () => {
    const ocr = parseScreenshotText(GOOD_OCR_LINES.join('\n'));
    const res = pickBetterParse(ocr, null);
    expect(res.source).toBe('ocr');
    expect(res.parsed).toBe(ocr);
  });
  it('prefers AI when it has fewer missing fields', () => {
    const ocr = parseScreenshotText(POOR_OCR_LINES.join('\n'));    // missing distance + duration
    const ai = parseScreenshotText(GOOD_OCR_LINES.join('\n'));     // complete
    const res = pickBetterParse(ocr, ai);
    expect(res.source).toBe('ai');
  });
  it('keeps OCR when OCR is strictly more complete than AI', () => {
    const ocr = parseScreenshotText(GOOD_OCR_LINES.join('\n'));    // nothing missing
    const ai = parseScreenshotText('Distance 7.5\nMoving Time 42:34'); // missing HR
    const res = pickBetterParse(ocr, ai);
    expect(res.source).toBe('ocr');
  });
});

describe('runHybridParse', () => {
  it('uses OCR and never calls AI when OCR is sufficient', async () => {
    const ocr = vi.fn().mockResolvedValue(GOOD_OCR_LINES);
    const aiFallback = vi.fn().mockResolvedValue(null);
    const res = await runHybridParse('BASE64', { ocr, aiFallback });

    expect(res.usedAI).toBe(false);
    expect(res.source).toBe('ocr');
    expect(res.parsed.distanceM).toBe(7500);
    expect(aiFallback).not.toHaveBeenCalled();
  });

  it('falls back to AI when OCR is poor and prefers the better AI result', async () => {
    const ocr = vi.fn().mockResolvedValue(POOR_OCR_LINES);
    const aiFallback = vi.fn().mockResolvedValue(CLEAN_AI_JSON);
    const res = await runHybridParse('BASE64', { ocr, aiFallback });

    expect(aiFallback).toHaveBeenCalledOnce();
    expect(res.usedAI).toBe(true);
    expect(res.source).toBe('ai');
    expect(res.parsed.distanceM).toBe(7500);
    expect(res.parsed.durationSec).toBe(2554);
  });

  it('retains the OCR result when the AI fallback fails', async () => {
    const ocr = vi.fn().mockResolvedValue(POOR_OCR_LINES);
    const aiFallback = vi.fn().mockRejectedValue(new Error('network down'));
    const res = await runHybridParse('BASE64', { ocr, aiFallback });

    expect(aiFallback).toHaveBeenCalledOnce();
    expect(res.usedAI).toBe(false);
    expect(res.source).toBe('ocr');
    expect(res.parsed.avgHR).toBe(140); // the one field OCR did read
  });

  it('runs AI when OCR returns nothing (the web path — no native OCR)', async () => {
    const ocr = vi.fn().mockResolvedValue([]);
    const aiFallback = vi.fn().mockResolvedValue(CLEAN_AI_JSON);
    const res = await runHybridParse('BASE64', { ocr, aiFallback });

    expect(aiFallback).toHaveBeenCalledOnce();
    expect(res.source).toBe('ai');
    expect(res.parsed.distanceM).toBe(7500);
  });

  it('sends the downscaled AI image to the fallback when provided', async () => {
    const ocr = vi.fn().mockResolvedValue([]);
    const aiFallback = vi.fn().mockResolvedValue(CLEAN_AI_JSON);
    await runHybridParse('FULLRES', {
      ocr,
      aiFallback,
      aiImage: { base64: 'SMALL', mediaType: 'image/jpeg' },
    });
    expect(aiFallback).toHaveBeenCalledWith('SMALL', 'image/jpeg');
  });
});
