/**
 * Every HYROX session generator call passes the athlete's load tier.
 *
 * Station MTL external loads come from the rulebook tier
 * (stationExternalLoadKg, src/constants/hyrox-benchmarks.ts). A call without
 * `loadTier` silently falls back to HYROX_DEFAULT_LOAD_TIER (M-Open), so a
 * woman's brick is loaded at men's Open sled weights. Review 2026-10-12 found
 * the gym session generator's HYROX brick (src/ui/session-generator.ts, any
 * mode) doing exactly that. This source scan fails on any non-test call of a
 * generator that omits the field.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');
const GENERATORS = ['generateHyroxBrick(', 'generateHyroxStation(', 'generateHyroxAssessment('];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** The argument text of the call that opens at `openIdx` (the "(" index),
 *  up to its matching ")". */
function callArgs(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx + 1);
}

describe('HYROX generator calls pass loadTier', () => {
  const calls: Array<{ where: string; args: string }> = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const name of GENERATORS) {
      let idx = src.indexOf(name);
      while (idx !== -1) {
        const before = src.slice(Math.max(0, idx - 16), idx);
        // Skip the declarations themselves.
        if (!before.includes('function ')) {
          const line = src.slice(0, idx).split('\n').length;
          calls.push({ where: `${relative(SRC, file)}:${line}`, args: callArgs(src, idx + name.length - 1) });
        }
        idx = src.indexOf(name, idx + name.length);
      }
    }
  }

  it('finds the known call sites (plan engine, add-session modal, gym session generator)', () => {
    const files = new Set(calls.map(c => c.where.split(':')[0]));
    expect(files).toContain(join('workouts', 'plan_engine.hyrox.ts'));
    expect(files).toContain(join('ui', 'hyrox', 'add-session-modal.ts'));
    expect(files).toContain(join('ui', 'session-generator.ts'));
  });

  it('every call sets loadTier', () => {
    const missing = calls.filter(c => !c.args.includes('loadTier')).map(c => c.where);
    expect(missing).toEqual([]);
  });
});
