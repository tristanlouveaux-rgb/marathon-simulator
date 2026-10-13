/**
 * HYROX screens never round only the seconds part of a time.
 *
 * Doubles, Pro and goal back-calculation times are fractional. A formatter
 * that floors the minutes and rounds the seconds remainder separately prints
 * 119.6 s as "1:60". Review 2026-10-12 found it in goal-modal.ts,
 * stats-view.ts and workout-detail-modal.ts. HYROX times go through
 * ftRounded and run paces through fmtModelPaceKm (src/utils/format.ts), which
 * round first and carry the minute. This scan fails on the old pattern in any
 * src/ui/hyrox file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DIR = __dirname;
const ROUND_SECONDS_ONLY = /Math\.round\(\s*[\w.]+\s*%\s*60\s*\)/;

describe('HYROX time formatters round before the minute split', () => {
  it('no src/ui/hyrox file rounds only the seconds remainder', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(DIR)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const lines = readFileSync(join(DIR, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (ROUND_SECONDS_ONLY.test(line)) offenders.push(`${name}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
