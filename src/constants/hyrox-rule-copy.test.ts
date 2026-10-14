/**
 * Guard: HYROX rule copy stays on the 26/27 rulebooks.
 *
 *  - Wall balls are 100 reps in every division since 24/25; app code must not
 *    state the old 75-rep Women Open count as a current rule. (The 75 may only
 *    appear as the era caveat on the S4 to S6 results data.)
 *  - The doubles "10-second rule" is not in the official 26/27 Doubles
 *    rulebook (media only, no penalty stated): never show it.
 *  - No single "Pro weights" line: Pro loads differ by sex (Women Pro races
 *    the Men Open tier), so copy must come from hyrox-division.ts.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function appFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...appFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function offenders(pattern: RegExp, allow: (line: string) => boolean = () => false): string[] {
  return appFiles(SRC)
    .flatMap(f => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f, i: i + 1, line })))
    .filter(({ line }) => pattern.test(line) && !allow(line))
    .map(({ f, i }) => `${f.replace(SRC, 'src')}:${i}`);
}

describe('HYROX rule copy (26/27)', () => {
  it('no doubles 10-second rule anywhere in app code', () => {
    expect(offenders(/10[- ]?second rule|ten[- ]second rule/i)).toEqual([]);
  });

  it('no 75-rep wall-ball rule stated as current', () => {
    // Allowed: the population-data era caveat and comments citing the old count.
    const isEraOrComment = (line: string) => /then \(100 since|was the 23\/24|^\s*(\/\/|\/?\*)/.test(line);
    expect(offenders(/75 (reps|wall ?balls)/i, isEraOrComment)).toEqual([]);
  });

  it('no hardcoded Men Pro load line presented as the Pro weights', () => {
    expect(offenders(/sled push 202 kg, sandbag 30 kg/)).toEqual([]);
  });
});
