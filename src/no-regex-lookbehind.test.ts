/**
 * Guard: no regex lookbehind in app code.
 *
 * The iOS app's deployment target is iOS 15 (ios/App/App.xcodeproj,
 * IPHONEOS_DEPLOYMENT_TARGET = 15.0). WKWebView only parses lookbehind
 * ((?<= and (?<!) from iOS 16.4; before that a lookbehind literal is a
 * SyntaxError for the whole module, and in a startup chunk the app never loads.
 * Named groups (?<name>...) are fine and are not matched here.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

function appFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...appFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('no regex lookbehind in app code (iOS 15 support)', () => {
  it('no source file under src/ contains (?<= or (?<!', () => {
    const offenders = appFiles(join(__dirname))
      .flatMap(f => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f, i: i + 1, line })))
      .filter(({ line }) => /\(\?<[=!]/.test(line))
      .map(({ f, i }) => `${f.replace(__dirname, 'src')}:${i}`);
    expect(offenders).toEqual([]);
  });
});
