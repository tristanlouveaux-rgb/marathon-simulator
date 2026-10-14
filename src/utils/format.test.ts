import { describe, it, expect } from 'vitest';
import { fmtDurationMin, ft, ftRounded } from './format';

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

describe('ftRounded: nearest whole second before the minute split (HYROX m:60 fix, 2026-10-13)', () => {
  it('carries the minute instead of printing ":60"', () => {
    expect(ftRounded(119.6)).toBe('2:00');
    expect(ftRounded(59.5)).toBe('1:00');
    expect(ftRounded(3599.6)).toBe('1:00:00');
  });

  it('rounds to the nearest second, where ft floors', () => {
    expect(ftRounded(4565.6)).toBe('1:16:06');
    expect(ft(4565.6)).toBe('1:16:05');
    expect(ftRounded(4565.4)).toBe('1:16:05');
  });

  it('formats whole seconds exactly as ft does', () => {
    for (const sec of [75, 267, 3600, 4747, 5338]) expect(ftRounded(sec)).toBe(ft(sec));
  });

  it('non-finite input reads as missing', () => {
    expect(ftRounded(NaN)).toBe('--');
    expect(ftRounded(Infinity)).toBe('--');
  });
});
