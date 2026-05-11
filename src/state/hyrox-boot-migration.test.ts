/**
 * Boot-time HYROX migration tests.
 *
 * Verifies the idempotent doubles-in-singles repair block in main.ts:611-637.
 * Pre-fix, a user with a doubles previous race got their splits stored in
 * the Singles slot. The migration moves them to the Doubles slot on launch.
 *
 * The migration logic is duplicated here as a pure function for unit testing
 * — `main.ts` itself is hard to test in isolation due to its launch wiring.
 * The function below is the same shape as the inline block in main.ts and
 * must be kept in sync if either changes.
 */

import { describe, it, expect } from 'vitest';
import type { HyroxConfig } from '@/types/triathlon';

/** Mirror of main.ts:611-637 step 3 — doubles-in-singles repair. */
function applyDoublesInSinglesRepair(hx: HyroxConfig): { moved: boolean } {
  const prevFmt = hx.hyroxPreviousTimeFormat;
  const prevIsDoubles = prevFmt === 'open_doubles' || prevFmt === 'pro_doubles';
  const singlesPopulated = hx.stationBenchmarksSingles
    && Object.keys(hx.stationBenchmarksSingles).length > 0;
  const doublesEmpty = !hx.stationBenchmarksDoubles
    || Object.keys(hx.stationBenchmarksDoubles).length === 0;
  if (prevIsDoubles && singlesPopulated && doublesEmpty) {
    hx.stationBenchmarksDoubles = { ...hx.stationBenchmarksSingles };
    hx.stationBenchmarksSingles = undefined;
    return { moved: true };
  }
  return { moved: false };
}

const SPLITS = { ski_erg: 250, sled_push: 130, sled_pull: 140 };

function buildHx(overrides: Partial<HyroxConfig> = {}): HyroxConfig {
  return {
    format: 'open_singles',
    athleteBand: 'intermediate',
    hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0,
    mtlCap: 1000,
    mtlHistory: [],
    runsPerWeek: 3,
    stationSessionsPerWeek: 1,
    bricksPerWeek: 1,
    weeklyHoursAvailable: 8,
    ...overrides,
  } as HyroxConfig;
}

describe('boot migration: doubles-in-singles repair', () => {
  it('moves splits Singles → Doubles when prev fmt is open_doubles', () => {
    const hx = buildHx({
      hyroxPreviousTimeFormat: 'open_doubles',
      stationBenchmarksSingles: { ...SPLITS },
      stationBenchmarksDoubles: undefined,
    });
    const { moved } = applyDoublesInSinglesRepair(hx);
    expect(moved).toBe(true);
    expect(hx.stationBenchmarksDoubles).toEqual(SPLITS);
    expect(hx.stationBenchmarksSingles).toBeUndefined();
  });

  it('moves splits when prev fmt is pro_doubles', () => {
    const hx = buildHx({
      hyroxPreviousTimeFormat: 'pro_doubles',
      stationBenchmarksSingles: { ...SPLITS },
      stationBenchmarksDoubles: undefined,
    });
    const { moved } = applyDoublesInSinglesRepair(hx);
    expect(moved).toBe(true);
    expect(hx.stationBenchmarksDoubles).toEqual(SPLITS);
  });

  it('idempotent: second run is a no-op', () => {
    const hx = buildHx({
      hyroxPreviousTimeFormat: 'open_doubles',
      stationBenchmarksSingles: { ...SPLITS },
      stationBenchmarksDoubles: undefined,
    });
    applyDoublesInSinglesRepair(hx);
    const { moved } = applyDoublesInSinglesRepair(hx);
    expect(moved).toBe(false);
    expect(hx.stationBenchmarksDoubles).toEqual(SPLITS);
    expect(hx.stationBenchmarksSingles).toBeUndefined();
  });

  it('no-op when prev fmt is open_singles + singles populated (correct state)', () => {
    const hx = buildHx({
      hyroxPreviousTimeFormat: 'open_singles',
      stationBenchmarksSingles: { ...SPLITS },
      stationBenchmarksDoubles: undefined,
    });
    const { moved } = applyDoublesInSinglesRepair(hx);
    expect(moved).toBe(false);
    expect(hx.stationBenchmarksSingles).toEqual(SPLITS);
    expect(hx.stationBenchmarksDoubles).toBeUndefined();
  });

  it('no-op when doubles slot already populated (don\'t overwrite real data)', () => {
    const existingDoubles = { ski_erg: 300 };
    const hx = buildHx({
      hyroxPreviousTimeFormat: 'open_doubles',
      stationBenchmarksSingles: { ...SPLITS },
      stationBenchmarksDoubles: { ...existingDoubles },
    });
    const { moved } = applyDoublesInSinglesRepair(hx);
    expect(moved).toBe(false);
    expect(hx.stationBenchmarksDoubles).toEqual(existingDoubles);
    expect(hx.stationBenchmarksSingles).toEqual(SPLITS);
  });

  it('no-op when prev fmt missing', () => {
    const hx = buildHx({
      hyroxPreviousTimeFormat: undefined,
      stationBenchmarksSingles: { ...SPLITS },
      stationBenchmarksDoubles: undefined,
    });
    const { moved } = applyDoublesInSinglesRepair(hx);
    expect(moved).toBe(false);
  });
});
