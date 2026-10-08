import { describe, it, expect } from 'vitest';
import { fmtDurationMin } from './format';

describe('fmtDurationMin: minutes under an hour, h:mm from an hour (visual QA 2026-10-08)', () => {
  it('under an hour reads in minutes', () => {
    expect(fmtDurationMin(36)).toBe('36 minutes');
    expect(fmtDurationMin(1)).toBe('1 minute');
    expect(fmtDurationMin(59.4)).toBe('59 minutes');
  });

  it('an hour or more reads h:mm', () => {
    expect(fmtDurationMin(59.6)).toBe('1:00');
    expect(fmtDurationMin(66)).toBe('1:06');
    expect(fmtDurationMin(165)).toBe('2:45');
  });
});
