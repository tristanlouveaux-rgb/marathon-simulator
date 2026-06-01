import { describe, it, expect } from 'vitest';
import { isValidAccessCode, VALID_ACCESS_CODES } from './access-codes';

describe('isValidAccessCode', () => {
  it('accepts the configured beta code', () => {
    expect(isValidAccessCode('BENJAMIN')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isValidAccessCode('benjamin')).toBe(true);
    expect(isValidAccessCode('Benjamin')).toBe(true);
    expect(isValidAccessCode('BeNjAmIn')).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(isValidAccessCode('  benjamin  ')).toBe(true);
    expect(isValidAccessCode('\tBENJAMIN\n')).toBe(true);
  });

  it('rejects an empty or whitespace-only string', () => {
    expect(isValidAccessCode('')).toBe(false);
    expect(isValidAccessCode('   ')).toBe(false);
  });

  it('rejects an unknown code', () => {
    expect(isValidAccessCode('letmein')).toBe(false);
    expect(isValidAccessCode('benjami')).toBe(false);
    expect(isValidAccessCode('benjamins')).toBe(false);
  });

  it('does not match on a substring of the input', () => {
    // Guards against a sloppy `includes`-based check.
    expect(isValidAccessCode('my benjamin code')).toBe(false);
  });

  it('every configured code validates against its own checker', () => {
    for (const code of VALID_ACCESS_CODES) {
      expect(isValidAccessCode(code)).toBe(true);
    }
  });
});
