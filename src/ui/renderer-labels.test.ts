import { describe, it, expect } from 'vitest';

/**
 * Unit tests for workout card label formatting logic in renderer.ts.
 *
 * The renderer builds HTML strings inline, so we test the pure transformations
 * extracted here. Any change to the label format in renderer.ts should be
 * reflected in these expectations.
 */

// ---------------------------------------------------------------------------
// Inline logic mirrored from renderer.ts — keep in sync with the three sites:
//   1. Detail card modification banner  (isModified && w.modReason block)
//   2. Calendar compact card status label (statusLabel assignment)
//   3. Calendar compact card cyan line   (modReason display in isReplaced branch)
// ---------------------------------------------------------------------------

/** Strip the "Garmin: " prefix from a raw modReason string. */
function extractActivityName(modReason: string): string {
  return modReason.replace(/^Garmin:\s*/i, '').trim();
}

/** Detail banner label for replaced / reduced workouts. */
function formatBannerLabel(modReason: string, isReplaced: boolean): string {
  const activityName = extractActivityName(modReason);
  return isReplaced ? `Replaced by ${activityName}` : `Reduced — ${activityName}`;
}

/** Calendar compact card status label appended to workout name. */
function formatStatusLabel(modReason: string | undefined): string {
  const actName = modReason ? extractActivityName(modReason) : '';
  return actName ? ` → ${actName}` : ' Replaced';
}

/** Calendar compact cyan line (the sub-description under struck-through original). */
function formatCyanLine(modReason: string | undefined): string {
  return modReason ? extractActivityName(modReason) : 'Replaced';
}

// ---------------------------------------------------------------------------

describe('extractActivityName', () => {
  it('strips "Garmin: " prefix (standard case)', () => {
    expect(extractActivityName('Garmin: HIIT')).toBe('HIIT');
  });

  it('strips "Garmin: " prefix with sport name and duration', () => {
    expect(extractActivityName('Garmin: Tennis (45min)')).toBe('Tennis (45min)');
  });

  it('strips "Garmin: " prefix for multi-activity summary', () => {
    expect(extractActivityName('Garmin: 2 cross-training activities')).toBe('2 cross-training activities');
  });

  it('strips "garmin: " prefix case-insensitively', () => {
    expect(extractActivityName('garmin: Cycling')).toBe('Cycling');
    expect(extractActivityName('GARMIN: Swimming')).toBe('Swimming');
  });

  it('leaves strings without the prefix unchanged', () => {
    expect(extractActivityName('HIIT')).toBe('HIIT');
    expect(extractActivityName('Tennis (45min)')).toBe('Tennis (45min)');
  });

  it('trims surrounding whitespace', () => {
    expect(extractActivityName('Garmin:   Yoga  ')).toBe('Yoga');
  });
});

// ---------------------------------------------------------------------------

describe('formatBannerLabel', () => {
  it('formats a replaced workout with activity name', () => {
    expect(formatBannerLabel('Garmin: HIIT', true)).toBe('Replaced by HIIT');
  });

  it('formats a reduced workout with activity name', () => {
    expect(formatBannerLabel('Garmin: Tennis (45min)', false)).toBe('Reduced — Tennis (45min)');
  });

  it('formats a replaced workout — multi-activity', () => {
    expect(formatBannerLabel('Garmin: 2 cross-training activities', true)).toBe('Replaced by 2 cross-training activities');
  });

  it('formats a reduced workout — cycling', () => {
    expect(formatBannerLabel('Garmin: Cycling 1h', false)).toBe('Reduced — Cycling 1h');
  });

  it('uses em-dash (—) not hyphen for reduced label', () => {
    const label = formatBannerLabel('Garmin: Swimming', false);
    expect(label).toContain('—');
    expect(label).not.toMatch(/Reduced\s*-\s/);
  });

  it('uses "Replaced by" (not "Replaced:") for replaced label', () => {
    const label = formatBannerLabel('Garmin: HIIT', true);
    expect(label).toMatch(/^Replaced by /);
  });
});

// ---------------------------------------------------------------------------

describe('formatStatusLabel (calendar compact card)', () => {
  it('returns "→ HIIT" for a replaced workout with modReason', () => {
    expect(formatStatusLabel('Garmin: HIIT')).toBe(' → HIIT');
  });

  it('returns "→ Tennis (45min)" for a replaced workout', () => {
    expect(formatStatusLabel('Garmin: Tennis (45min)')).toBe(' → Tennis (45min)');
  });

  it('falls back to " Replaced" when modReason is undefined', () => {
    expect(formatStatusLabel(undefined)).toBe(' Replaced');
  });

  it('falls back to " Replaced" when modReason is empty string', () => {
    expect(formatStatusLabel('')).toBe(' Replaced');
  });
});

// ---------------------------------------------------------------------------

describe('formatCyanLine (calendar compact sub-description)', () => {
  it('strips Garmin prefix from modReason', () => {
    expect(formatCyanLine('Garmin: Tennis (45min)')).toBe('Tennis (45min)');
  });

  it('falls back to "Replaced" when modReason is undefined', () => {
    expect(formatCyanLine(undefined)).toBe('Replaced');
  });

  it('falls back to "Replaced" when modReason is empty', () => {
    expect(formatCyanLine('')).toBe('Replaced');
  });
});
