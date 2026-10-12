// @vitest-environment jsdom
/**
 * PB age reaches every surface whose numbers it changes, through one source
 * (Tristan, 2026-10-11).
 *
 * - The Time Trial step's predicted times and the Stats race estimates read
 *   predictStandardDistances (the Forecast tab's figures). The Time Trial's
 *   local blend passed no PB age weights, no HR-tested recent race and no
 *   weekly km; the Stats card read the synced window's weekly km (0 with a
 *   typed km), no HR fit, calibration or durability cap. Both disagreed with
 *   the Forecast.
 * - The HYROX run pace "From VDOT" (s.v and s.lt) carries it too.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { ft } from '@/utils/format';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import type { OnboardingState } from '@/types/onboarding';
import { defaultOnboardingState } from '@/types/onboarding';
import type { SimulatorState } from '@/types';
import { initializeSimulator } from '@/state/initialization';
import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { getMutableState, getState, resetState } from '@/state/store';
import { predictStandardDistances } from '@/calculations/blended-fitness';
import { blendPredictions } from '@/calculations/predictions';
import { effectiveVo2max } from '@/calculations/physiological-vdot';
import { timeTrialPredictions } from './session-generator';
import { hyroxRunPaceSourceNote } from './hyrox/forecast-view';
import { buildForecastTimesCard } from './stats-view';
import { localMondayKey } from '@/utils/local-date';

// One clock for the whole file (follow-up review 1, 2026-10-11). pbAgeWeight is
// continuous in time, so two surfaces computed a few milliseconds apart differ
// in the last bits (1153.0206901157746 vs 1153.0206901153929). Date is frozen
// at the real current time; timers stay real.
const FROZEN_NOW = new Date();
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(FROZEN_NOW);
afterAll(() => { vi.useRealTimers(); });

const DAY_MS = 86400000;
const CAPTION = 'Older PBs carry less weight';

function planDay(week: number, dow: number): string {
  const [y, m, d] = localMondayKey(new Date()).split('-').map(Number);
  const t = new Date(y, m - 1, d + (week - 1) * 7 + dow);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** Half target; 5K 19:00 one year old and half 1:32 three years old. */
function runner(typedKm: number | undefined): SimulatorState {
  resetState();
  Object.assign(getMutableState(), {
    unitPref: 'km',
    ...(typedKm != null ? { detectedWeeklyKm: typedKm, weeklyVolumeConfirmed: true } : {}),
  });
  const ob = {
    ...defaultOnboardingState,
    name: 'QA', currentStep: 'initializing', trainingMode: 'running', trainingForEvent: true,
    raceDistance: 'half', selectedRace: null, hasSmartwatch: true,
    customRaceDate: planDay(16, 6), planDurationWeeks: 16, runsPerWeek: 4,
    experienceLevel: 'intermediate', pbs: { k5: 1140, h: 5520 },
    pbDates: {
      k5: new Date(Date.now() - 365 * DAY_MS).toISOString(),
      h: new Date(Date.now() - 3 * 365 * DAY_MS).toISOString(),
    },
  } as OnboardingState;
  getMutableState().onboarding = ob;
  expect(initializeSimulator(ob).success).toBe(true);
  return getState();
}

describe('Time Trial predicted times are the Forecast tab\'s', () => {
  it('each distance equals predictStandardDistances', () => {
    const s = runner(40);
    const std = predictStandardDistances(s);
    const tt = timeTrialPredictions(s);
    expect(tt.map(d => d.key)).toEqual(['5k', '10k', 'half', 'marathon']);
    for (const d of tt) {
      expect(d.predictedSec).not.toBeNull();
      expect(d.predictedSec).toBe(std[d.key]);
    }
  });

  it('the old local blend (no PB age, recent race or weekly km) disagreed for a dated PB', () => {
    const s = runner(40);
    const half = timeTrialPredictions(s).find(d => d.key === 'half')!.predictedSec!;
    const old = blendPredictions(21097, s.pbs ?? {}, s.lt ?? null, effectiveVo2max(s) ?? s.v,
      s.b ?? 1.06, s.typ ?? 'Balanced', s.rec ?? null, s.athleteTier ?? undefined)!;
    expect(Math.abs(half - old)).toBeGreaterThan(30);
  });

});

describe('Stats race estimates are the Forecast tab\'s', () => {
  it('each row shows predictStandardDistances, with the caption', () => {
    const s = runner(40);
    const std = predictStandardDistances(s);
    const html = buildForecastTimesCard(s);
    for (const k of ['marathon', 'half', '10k', '5k'] as const) {
      // ft, the Forecast tiles' formatter (buildStdDistanceTile): the same
      // seconds read the same on both screens, never ':60'.
      expect(html).toContain(`>${ft(std[k]!)}</span>`);
    }
    expect(html).toContain(`${CAPTION} in these estimates.`);
  });
});

/** HYROX athlete, 5K 19:00 one year old and half 1:32 three years old. */
function hyroxAthlete(typedKm: number | undefined): SimulatorState {
  resetState();
  Object.assign(getMutableState(), {
    unitPref: 'km',
    ...(typedKm != null ? { detectedWeeklyKm: typedKm, weeklyVolumeConfirmed: true } : {}),
  });
  expect(initializeHyroxSimulator({
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8, pbs: { k5: 1140, h: 5520 },
    pbDates: {
      k5: new Date(Date.now() - 365 * DAY_MS).toISOString(),
      h: new Date(Date.now() - 3 * 365 * DAY_MS).toISOString(),
    },
  } as unknown as OnboardingState).success).toBe(true);
  return getState();
}

describe('HYROX run pace from VDOT: the PB-age caption', () => {
  it('a derived run pace carries it when ageing moves the pace a second; a population seed or no volume does not', () => {
    const aged = hyroxAthlete(40);
    expect(hyroxRunPaceSourceNote(aged, 'derived')).toBe(`Run pace updated from your VDOT. ${CAPTION} in the run pace.`);
    expect(hyroxRunPaceSourceNote(aged, 'seed')).not.toContain(CAPTION);
    expect(hyroxRunPaceSourceNote(aged, 'user')).toBe('');
    expect(hyroxRunPaceSourceNote(hyroxAthlete(undefined), 'derived')).toBe('Run pace updated from your VDOT.');
  });

  it('no caption when the run pace does not come from the HYROX config (it reads the population seed)', () => {
    // A running state carries no hyroxConfig, so deriveHyroxRunPace returns the
    // seed whatever the PBs' age: ageing moves nothing this note speaks for.
    const noConfig = { ...runner(40), eventType: 'hyrox' } as SimulatorState;
    expect(hyroxRunPaceSourceNote(noConfig, 'derived')).toBe('Run pace updated from your VDOT.');
  });
});
