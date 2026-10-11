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
 * - The running Home forecast card carries the PB-age caption.
 * - The HYROX run pace "From VDOT" (s.v and s.lt) carries it too.
 */
import { describe, it, expect, vi } from 'vitest';

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
import { getMutableState, getState, resetState } from '@/state/store';
import { predictStandardDistances } from '@/calculations/blended-fitness';
import { blendPredictions } from '@/calculations/predictions';
import { effectiveVo2max } from '@/calculations/physiological-vdot';
import { timeTrialPredictions } from './session-generator';
import { buildRaceForecastCard } from './home-view';
import { hyroxRunPaceSourceNote } from './hyrox/forecast-view';
import { buildForecastTimesCard } from './stats-view';
import { localMondayKey } from '@/utils/local-date';

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
      const sec = std[k]!;
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const sc = Math.round(sec % 60);
      const shown = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}` : `${m}:${String(sc).padStart(2, '0')}`;
      expect(html).toContain(`>${shown}</span>`);
    }
    expect(html).toContain(`${CAPTION} in these estimates.`);
  });
});

describe('running Home forecast card: the PB-age caption', () => {
  it('shows with a dated PB and a measured weekly volume, and not without the volume', () => {
    expect(buildRaceForecastCard(runner(40))).toContain(`${CAPTION} in this forecast.`);
    expect(buildRaceForecastCard(runner(undefined))).not.toContain(CAPTION);
  });
});

describe('HYROX run pace from VDOT: the PB-age caption', () => {
  it('a derived run pace carries it under the volume gate; a population seed or no volume does not', () => {
    const aged = { ...runner(40), eventType: 'hyrox' } as SimulatorState;
    expect(hyroxRunPaceSourceNote(aged, 'derived')).toBe(`Run pace updated from your VDOT. ${CAPTION} in the run pace.`);
    expect(hyroxRunPaceSourceNote(aged, 'seed')).not.toContain(CAPTION);
    expect(hyroxRunPaceSourceNote(aged, 'user')).toBe('');
    const noVolume = { ...runner(undefined), eventType: 'hyrox' } as SimulatorState;
    expect(hyroxRunPaceSourceNote(noVolume, 'derived')).toBe('Run pace updated from your VDOT.');
  });
});
