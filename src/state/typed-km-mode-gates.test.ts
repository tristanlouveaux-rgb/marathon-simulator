/**
 * A typed weekly km shapes running plans only (Tristan, 2026-10-09 and
 * 2026-10-11). The typed-volume archetype and the typed weekly load target
 * share one gate (typedVolumeShapesPlan): no triathlon (cycling included), no
 * HYROX, no Just-Track.
 *
 * Before (cross-mode report 2026-10-09): planRampArchetype was not gated, so a
 * typed 15 km from the triathlon review row reached the shared refresh's ramp
 * volume (planForecastWeeklyKm 118.8 to 29.7 km; s.forecastTime 12425 to
 * 12781 s, expectedFinal 48.51 to 46.82), and HYROX and cycling drifted the
 * same way. Just-Track has no plan, but a typed 15 km set its "planned" weekly
 * target (80 against 243), which the AI Coach reads as planned_week_tss and the
 * carry and excess bookkeeping use. PLANNING side.
 */
import { describe, it, expect, vi } from 'vitest';
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

import { initializeSimulator } from './initialization';
import { initializeTriathlonSimulator } from './initialization.triathlon';
import { initializeHyroxSimulator } from './initialization.hyrox';
import { getMutableState, getState, resetState } from './store';
import { refreshBlendedFitness, planForecastWeeklyKm } from '@/calculations/blended-fitness';
import { planRampArchetype, typedVolumeArchetype, typedVolumeShapesPlan } from '@/calculations/athlete-archetype';
import { typedVolumeWeeklyTSS } from '@/calculations/fitness-model';
import { computePlannedWeekTarget } from '@/calculations/planned-week-target';
import { localMondayKey } from '@/utils/local-date';

function planDay(week: number, dow: number): string {
  const [y, m, d] = localMondayKey(new Date()).split('-').map(Number);
  const t = new Date(y, m - 1, d + (week - 1) * 7 + dow);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** The same athlete with the 15 km typed (confirmed) or left unconfirmed. */
function seed(confirmed: boolean): Partial<SimulatorState> {
  return { detectedWeeklyKm: 15, weeklyVolumeConfirmed: confirmed || undefined };
}

describe('typedVolumeShapesPlan: running plans only', () => {
  it('running yes; triathlon, HYROX and Just-Track no', () => {
    expect(typedVolumeShapesPlan({ eventType: 'running' })).toBe(true);
    expect(typedVolumeShapesPlan({})).toBe(true);
    expect(typedVolumeShapesPlan({ eventType: 'triathlon' })).toBe(false);
    expect(typedVolumeShapesPlan({ eventType: 'hyrox' })).toBe(false);
    expect(typedVolumeShapesPlan({ eventType: 'running', trackOnly: true })).toBe(false);
  });

  it('the archetype and the weekly target read the same gate', () => {
    const typed = { detectedWeeklyKm: 15, weeklyVolumeConfirmed: true, pac: { e: 330 } };
    for (const mode of [{ eventType: 'triathlon' as const }, { eventType: 'hyrox' as const }, { trackOnly: true }]) {
      expect(typedVolumeArchetype({ ...typed, ...mode } as never)).toBeUndefined();
      expect(typedVolumeWeeklyTSS({ ...typed, ...mode })).toBeUndefined();
    }
    expect(typedVolumeArchetype({ ...typed, eventType: 'running' } as never)).toBe('consistent-runner');
    expect(typedVolumeWeeklyTSS({ ...typed, eventType: 'running' })).toBeGreaterThan(0);
  });
});

describe('real initializers: a typed km leaves non-running modes as they were', () => {
  function tri(confirmed: boolean) {
    resetState();
    Object.assign(getMutableState(), seed(confirmed));
    expect(initializeTriathlonSimulator({
      trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
      customRaceDate: planDay(20, 6), triSkillRating: { swim: 3, bike: 3, run: 3 }, pbs: { h: 5400 },
    } as OnboardingState).success).toBe(true);
    refreshBlendedFitness(getMutableState());
    const s = getState();
    return { arch: planRampArchetype(s), km: planForecastWeeklyKm(s, s.epw ?? 9), ft: s.forecastTime, ef: s.expectedFinal, target: computePlannedWeekTarget(s, 1) };
  }

  it('triathlon: no typed archetype, so the shared refresh is unchanged', () => {
    const typed = tri(true);
    const untyped = tri(false);
    expect(typed.arch).toBeUndefined();
    expect(typed.km).toBe(untyped.km);
    expect(typed.ft).toBe(untyped.ft);
    expect(typed.ef).toBe(untyped.ef);
    expect(typed.target).toBe(untyped.target);
  });

  it('HYROX: no typed archetype and the same refresh and target', () => {
    const run = (confirmed: boolean) => {
      resetState();
      Object.assign(getMutableState(), seed(confirmed));
      expect(initializeHyroxSimulator({
        trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
        triTimeAvailableHoursPerWeek: 8, pbs: { h: 5400 },
      } as unknown as OnboardingState).success).toBe(true);
      refreshBlendedFitness(getMutableState());
      const s = getState();
      return { arch: planRampArchetype(s), ft: s.forecastTime, ef: s.expectedFinal, target: computePlannedWeekTarget(s, 1) };
    };
    const typed = run(true);
    const untyped = run(false);
    expect(typed.arch).toBeUndefined();
    expect(typed.ft).toBe(untyped.ft);
    expect(typed.ef).toBe(untyped.ef);
    expect(typed.target).toBe(untyped.target);
  });

  it('Just-Track: a typed km creates no weekly target (the AI Coach planned_week_tss keeps runs/week x 50)', () => {
    const run = (confirmed: boolean) => {
      resetState();
      Object.assign(getMutableState(), seed(confirmed));
      expect(initializeSimulator({
        trainingMode: 'running', trackOnly: true, runsPerWeek: 5, pbs: { k10: 2700 },
        experienceLevel: 'intermediate',
      } as unknown as OnboardingState).success).toBe(true);
      const s = getState();
      expect(s.trackOnly).toBe(true);
      return { a: computePlannedWeekTarget(s, 1, 'A'), b: computePlannedWeekTarget(s, 1, 'B'), arch: planRampArchetype(s) };
    };
    const typed = run(true);
    const untyped = run(false);
    expect(typed.arch).toBeUndefined();
    expect(typed.a).toBe(untyped.a);
    expect(typed.b).toBe(untyped.b);
  });

  it('running: the typed km still shapes the plan and the target (lane k unchanged)', () => {
    const run = (confirmed: boolean) => {
      resetState();
      Object.assign(getMutableState(), seed(confirmed));
      expect(initializeSimulator({
        trainingMode: 'running', trainingForEvent: true, raceDistance: 'marathon', runsPerWeek: 4,
        pbs: { k10: 2700 }, experienceLevel: 'intermediate', customRaceDate: planDay(16, 6), planDurationWeeks: 16,
      } as unknown as OnboardingState).success).toBe(true);
      const s = getState();
      return { arch: planRampArchetype(s), target: computePlannedWeekTarget(s, 1) };
    };
    const typed = run(true);
    const untyped = run(false);
    expect(typed.arch).toBe('consistent-runner');
    expect(untyped.arch).toBeUndefined();
    expect(typed.target).toBeLessThan(untyped.target);
  });
});
