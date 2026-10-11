/**
 * Triathlon plan regeneration reads the refreshed s.lt (Tristan, 2026-10-11).
 *
 * The generator bakes run paces from gp(s.v, s.lt) into the stored run
 * descriptions. main.ts regenerated tri plans on a TRI_GENERATOR_VERSION bump
 * in its triathlon block, before the launch refresh that recomputes s.lt, so a
 * stored plan kept the previous launch's run paces: a plan built from an
 * uncapped watch s.lt (220 s/km, easy 4:24/km at watch 62 and run skill 3)
 * kept 4:24/km after the 2026-10-09 run-pace cap. The regen now runs after the
 * refresh (applyTriGeneratorRegen) and v23 makes existing plans regenerate.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OnboardingState } from '@/types/onboarding';
import type { SimulatorState } from '@/types';

const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
});
vi.stubGlobal('alert', vi.fn());
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { initializeTriathlonSimulator } from './initialization.triathlon';
import { getMutableState, getState, resetState } from './store';
import { refreshBlendedFitness } from '@/calculations/blended-fitness';
import { applyTriGeneratorRegen } from './tri-plan-regen';
import { generateTriathlonPlan, TRI_GENERATOR_VERSION } from '@/workouts/plan_engine.triathlon';
import { localMondayKey } from '@/utils/local-date';

function planDay(week: number, dow: number): string {
  const [y, m, d] = localMondayKey(new Date()).split('-').map(Number);
  const t = new Date(y, m - 1, d + (week - 1) * 7 + dow);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function runTexts(s: SimulatorState): string[] {
  return s.wks.flatMap(w => (w.triWorkouts ?? []).filter(x => x.discipline === 'run').map(x => x.d ?? ''))
    .filter(t => /@ \d+:\d\d\/km/.test(t));
}

/** A 70.3 cold start (run skill 3, watch 62) whose stored plan was written
 *  from the uncapped watch LT at generator v22, as plans built before the cap. */
function staleTriPlan(): SimulatorState {
  resetState();
  Object.assign(getMutableState(), { vo2: 62 });
  expect(initializeTriathlonSimulator({
    trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
    customRaceDate: planDay(20, 6), triSkillRating: { swim: 3, bike: 3, run: 3 },
  } as OnboardingState).success).toBe(true);
  const s = getMutableState();
  expect(s.lt).toBe(288);
  // The previous launch's stored s.lt, from the uncapped watch, and the plan
  // the v22 generator wrote from it.
  s.lt = 220;
  const old = generateTriathlonPlan(s);
  for (let i = 0; i < s.wks.length; i++) s.wks[i].triWorkouts = old[i].triWorkouts;
  s.triConfig!.generatorVersion = 22;
  return s;
}

describe('applyTriGeneratorRegen after the launch refresh', () => {
  it('TRI_GENERATOR_VERSION is 23 (the bump that regenerates pre-cap plans)', () => {
    expect(TRI_GENERATOR_VERSION).toBe(23);
  });

  it('a stale plan regenerates at the capped run paces when the refresh runs first', () => {
    const s = staleTriPlan();
    expect(runTexts(s).some(t => t.includes('@ 4:24/km'))).toBe(true);
    refreshBlendedFitness(s);
    expect(s.lt).toBe(288);
    expect(applyTriGeneratorRegen(s)).toBe(true);
    const texts = runTexts(getState());
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some(t => t.includes('@ 5:45/km'))).toBe(true);
    expect(texts.some(t => t.includes('@ 4:24/km'))).toBe(false);
    expect(getState().triConfig!.generatorVersion).toBe(TRI_GENERATOR_VERSION);
    // Idempotent: the current version does not regenerate again.
    expect(applyTriGeneratorRegen(getMutableState())).toBe(false);
  });

  it('the old order (regen before the refresh) wrote the previous launch\'s uncapped paces', () => {
    const s = staleTriPlan();
    expect(applyTriGeneratorRegen(s)).toBe(true);
    expect(runTexts(s).some(t => t.includes('@ 4:24/km'))).toBe(true);
  });

  it('user-added sessions survive the regen', () => {
    const s = staleTriPlan();
    const added = { id: 'adhoc-1', t: 'easy', n: 'Added run', d: '30min easy', r: 3, discipline: 'run' } as unknown as NonNullable<SimulatorState['wks'][number]['triWorkouts']>[number];
    s.wks[0].triWorkouts = [...(s.wks[0].triWorkouts ?? []), added];
    refreshBlendedFitness(s);
    applyTriGeneratorRegen(s);
    expect(getState().wks[0].triWorkouts!.some(w => w.id === 'adhoc-1')).toBe(true);
  });

  it('running and HYROX plans are never touched', () => {
    const s = staleTriPlan();
    s.eventType = 'running';
    expect(applyTriGeneratorRegen(s)).toBe(false);
  });

  it('main.ts runs the regen after the launch refresh', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8');
    const refreshAt = src.indexOf('refreshBlendedFitness(getMutableState());');
    const regenAt = src.indexOf('applyTriGeneratorRegen(getMutableState())');
    expect(refreshAt).toBeGreaterThan(0);
    expect(regenAt).toBeGreaterThan(refreshAt);
    // The generator is no longer called directly from the triathlon block.
    expect(src.includes('generateTriathlonPlan(mutable)')).toBe(false);
  });
});
