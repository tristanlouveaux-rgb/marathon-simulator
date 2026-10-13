/**
 * HYROX session generators load stations at the athlete's tier.
 *
 * Station MTL external loads come from the rulebook tier
 * (stationExternalLoadKg, src/constants/hyrox-benchmarks.ts). A call without
 * `loadTier` silently falls back to HYROX_DEFAULT_LOAD_TIER (M-Open), so a
 * woman's brick is loaded at men's Open sled weights. Review 2026-10-12 found
 * the gym session generator's HYROX brick (src/ui/session-generator.ts, any
 * mode) doing exactly that.
 *
 * Two checks:
 *  1. Callers: a source scan fails on any non-test call of a public generator
 *     that omits the field. It checks the call sites only.
 *  2. Inside the generators: a behavioural check that the tier reaches the
 *     loaded-station MTL for each brick kind. generateHyroxBrick used to drop
 *     loadTier for kind 'mini_brick', whose farmer-carry fallback (no ergs)
 *     then carried no external load at all (review 2026-10-13).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { generateHyroxBrick, type BrickParams } from './hyrox-generators';

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

describe('the load tier reaches the loaded-station MTL inside the brick generators', () => {
  const noErgs = { sled: 'always' as const, skiErg: false, rowErg: false };
  const base: BrickParams = {
    kind: 'mini_brick', targetMinutes: 30, band: 'beginner', stationAccess: noErgs,
    phase: 'base', slotIndex: 0, bodyWeightKg: 70,
  };
  const stationMtl = (p: BrickParams) =>
    generateHyroxBrick(p).hyroxComponents!.filter(c => c.type !== 'run').reduce((a, c) => a + (c.mtl ?? 0), 0);

  it('mini brick, farmer-carry fallback: W-Open < M-Open (default) < M-Pro', () => {
    const w = stationMtl({ ...base, loadTier: 'W-Open' });
    const m = stationMtl({ ...base, loadTier: 'M-Open' });
    const pro = stationMtl({ ...base, loadTier: 'M-Pro' });
    expect(generateHyroxBrick(base).hyroxComponents!.some(c => c.type === 'farmer_carry')).toBe(true);
    expect(w).toBeLessThan(m);
    expect(m).toBeLessThan(pro);
    expect(stationMtl(base)).toBe(m);
  });

  it('mini brick on an erg: no external load, so the tier changes nothing', () => {
    const ergs = { sled: 'always' as const, skiErg: true, rowErg: true };
    expect(stationMtl({ ...base, stationAccess: ergs, loadTier: 'W-Open' }))
      .toBe(stationMtl({ ...base, stationAccess: ergs, loadTier: 'M-Pro' }));
  });

  it('full brick: the tier reaches the station MTL too', () => {
    const full: BrickParams = { ...base, kind: 'brick', targetMinutes: 60, band: 'intermediate', stationAccess: { sled: 'always', skiErg: true, rowErg: true } };
    // A loaded station (farmer carry) for the slot, so the tier matters.
    let slot = 0;
    while (slot < 8 && !generateHyroxBrick({ ...full, slotIndex: slot }).hyroxComponents!.some(c => c.type === 'farmer_carry')) slot++;
    expect(slot).toBeLessThan(8);
    expect(stationMtl({ ...full, slotIndex: slot, loadTier: 'W-Open' }))
      .toBeLessThan(stationMtl({ ...full, slotIndex: slot, loadTier: 'M-Open' }));
  });
});
