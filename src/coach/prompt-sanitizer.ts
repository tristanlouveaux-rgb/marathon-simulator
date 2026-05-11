/**
 * prompt-sanitizer.ts
 * ====================
 * Sanitizes user-controlled strings before they enter any LLM prompt.
 * Defends against prompt injection via Strava activity names, workout titles, etc.
 */

const INJECTION_PATTERNS = [
  /ignore\s+all\s+previous/i,
  /\bSYSTEM\s*:/i,
  /\[INST\]/i,
  /<\|/,
  /###\s*(System|User|Assistant)/i,
  /\bforget\s+(everything|all|your\s+instructions)/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\b/i,
];

/**
 * Sanitize a single string field for LLM inclusion.
 * - Strips HTML tags
 * - Collapses newlines/CR to spaces
 * - Truncates to maxLen
 * - Replaces strings matching injection patterns with [removed]
 */
export function sanitizeField(value: string | null | undefined, maxLen: number = 120): string {
  if (value === null || value === undefined) return '';

  let s = String(value);

  // Strip HTML tags
  s = s.replace(/<[^>]*>/g, '');

  // Collapse newlines/CR to spaces
  s = s.replace(/[\n\r\t]/g, ' ');

  // Collapse multiple spaces
  s = s.replace(/\s{2,}/g, ' ');

  // Truncate
  s = s.slice(0, maxLen).trim();

  // Check for injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(s)) {
      return '[removed]';
    }
  }

  return s;
}

/** Sanitize an array of strings, filtering out empty results */
export function sanitizeStringArray(values: string[], maxLen: number = 120): string[] {
  return values
    .map(v => sanitizeField(v, maxLen))
    .filter(v => v !== '' && v !== '[removed]');
}

/** Sanitize a number — returns null if not a finite number */
export function sanitizeNumber(value: unknown): number | null {
  if (typeof value === 'number' && isFinite(value)) return value;
  return null;
}
