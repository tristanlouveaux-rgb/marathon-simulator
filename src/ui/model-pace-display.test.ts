// @vitest-environment jsdom
/**
 * Model paces display as the whole second (2026-10-12, review round 5).
 *
 * s.lt is stored unrounded, and s.pac = gp(v, s.lt), so the threshold pace IS
 * the LT and easy / marathon / interval are fixed multiples of it. Every
 * display of those paces rounds at the display boundary (displayPaceSec /
 * fpModel / fmtModelPaceKm, src/utils/format.ts). Measured before this fix
 * (review round 5): at s.lt 256.5002 the LT page headline read 4:17/km and its
 * Training Paces Threshold card 4:16/km (floor), and the HYROX critical-pace
 * detail read "Threshold pace 4:60/km" at s.lt 299.6.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { getMutableState, getState, resetState } from '@/state/store';
import { gp } from '@/calculations/paces';
import { displayPaceSec, fpModel, fmtModelPaceKm, fmtDesc } from '@/utils/format';
import { buildLTMetricPage } from './stats-view';
import { renderHyroxCriticalPaceDetail } from './hyrox/critical-pace-detail-view';
import { buildYourNumbersCard } from './triathlon/fitness-detail-view';
import { renderForecastFingerprint } from './race-forecast-fingerprint';
import { buildRunningCoachContext } from '@/coach/coach-context-builder';
import { intentToWorkout } from '@/workouts/intent_to_workout';
import { retargetDescriptionPace, displayDescWithPace } from '@/workouts/workout-scaling';

/** A displayed pace with fractional seconds ("4:16.5") or an uncarried
 *  minute ("4:60"). */
const FRACTIONAL_SECONDS = /\d:\d{2}\.\d/;
const UNCARRIED_MINUTE = /\d:60(?!\d)/;

function expectWholeSecondPaces(text: string): void {
  expect(text).not.toMatch(FRACTIONAL_SECONDS);
  expect(text).not.toMatch(UNCARRIED_MINUTE);
}

function seedLt(lt: number, extra: Partial<SimulatorState> = {}): SimulatorState {
  resetState();
  const s = getMutableState();
  Object.assign(s, { v: 50, lt, ltPace: lt, ltSource: 'blended', ltConfidence: 'medium', unitPref: 'km', pac: gp(50, lt), ...extra });
  return getState();
}

describe('display helpers', () => {
  it('round to the nearest whole second and carry the minute', () => {
    expect(displayPaceSec(256.5002)).toBe(257);
    expect(displayPaceSec(256.4999)).toBe(256);
    expect(fpModel(299.6)).toBe('5:00/km');
    expect(fpModel(256.5002)).toBe('4:17/km');
    expect(fmtModelPaceKm(299.6)).toBe('5:00');
    // Mile pace: the whole-second km pace converted, then rounded with the
    // minute carried. 298 s/km × 1.60934 = 479.58 s/mi reads 8:00/mi.
    expect(fpModel(298, 'mi')).toBe('8:00/mi');
  });

  it('fmtDesc carries the minute in mile paces, as fpModel does', () => {
    expect(fmtDesc('6km @ 4:58/km', 'mi')).toContain('8:00/mi');
    expect(fmtDesc('6km @ 4:58/km', 'mi')).toContain(fpModel(298, 'mi'));
  });
});

describe('LT and threshold pace read the same whole second', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="app-root"></div>'; });

  it('LT page: the headline LT equals the Training Paces Threshold card at s.lt 256.5002', () => {
    const s = seedLt(256.5002);
    expect(s.pac!.t).toBe(s.lt);
    const html = buildLTMetricPage(s);
    const thresholdCard = html.match(/Threshold<\/div>\s*<div[^>]*>([^<]+)<\/div>/);
    expect(thresholdCard).not.toBeNull();
    expect(thresholdCard![1]).toBe('4:17/km');
    expect(html).toContain('>4:17/km<'); // headline
    expect(html).not.toContain('4:16/km');
    expectWholeSecondPaces(html);
  });

  it('LT page in miles: headline and Threshold card agree', () => {
    const s = seedLt(256.5002, { unitPref: 'mi' });
    const html = buildLTMetricPage(s);
    const thresholdCard = html.match(/Threshold<\/div>\s*<div[^>]*>([^<]+)<\/div>/);
    expect(thresholdCard![1]).toBe(fpModel(256.5002, 'mi'));
    expect(html).toContain(`>${fpModel(256.5002, 'mi')}<`);
    expectWholeSecondPaces(html);
  });

  it('HYROX critical-pace detail at s.lt 299.6 reads Threshold pace 5:00/km, never 4:60', () => {
    seedLt(299.6, {
      eventType: 'hyrox',
      hyroxConfig: {
        format: 'open_singles', athleteBand: 'intermediate', hyroxPhase: 'base',
        stationAccess: { sled: 'always', skiErg: true, rowErg: true },
        weeklyMTL: 0, mtlCap: 1000, mtlHistory: [], runsPerWeek: 3, stationSessionsPerWeek: 1,
        bricksPerWeek: 1, weeklyHoursAvailable: 8,
      } as unknown as SimulatorState['hyroxConfig'],
    });
    renderHyroxCriticalPaceDetail();
    const txt = (document.getElementById('app-root')?.textContent ?? '').replace(/\s+/g, ' ');
    expect(txt).toContain('Threshold pace 5:00/km');
    expect(txt).not.toContain('4:60');
    expectWholeSecondPaces(txt);
  });

  it('triathlon Your Numbers card at s.lt 299.6 reads 5:00/km', () => {
    const s = seedLt(299.6, { eventType: 'triathlon', triConfig: { distance: '70.3' } as unknown as SimulatorState['triConfig'] });
    const html = buildYourNumbersCard(s);
    expect(html).toContain('5:00/km');
    expectWholeSecondPaces(html);
  });

  it('fingerprint and coach context read the same whole second as the LT page', () => {
    const s = seedLt(256.5002, { rd: 'marathon', forecastTime: 11000, blendedRaceTimeSec: 11400 });
    expect(renderForecastFingerprint(s, false)).toContain('LT 4:17/km');
    const ctx = buildRunningCoachContext(s) as { athlete: { lt_pace: string | null; paces: Record<string, string | null> | null } };
    expect(ctx.athlete.lt_pace).toBe('4:17 min/km');
    expect(ctx.athlete.paces?.threshold).toBe('4:17 min/km');
  });
});

describe('workout descriptions write model paces as the whole second', () => {
  it('a generated threshold session reads the LT page pace', () => {
    const easy = gp(50, 256.5002).e; // 307.80024
    const w = intentToWorkout(
      { dayIndex: 1, slot: 'threshold', totalMinutes: 50, workMinutes: 20, reps: 2, repMinutes: 10, recoveryMinutes: 2, variantId: 'thr-2x10', notes: '' },
      'marathon', 'Balanced', easy,
    );
    expect(w.d).toContain('4:17/km');
    expect(w.d).not.toContain('4:16/km');
    expectWholeSecondPaces(w.d);
  });

  it('Adjust retarget and the display-layer pace append agree with generation', () => {
    const easy = gp(50, 256.5002).e;
    expect(retargetDescriptionPace('7km @ 6:10/km', 'threshold', easy)).toBe('7km @ 4:17/km');
    expect(displayDescWithPace('7km', 'easy', easy)).toBe(`7km @ ${fmtModelPaceKm(easy)}/km`);
    expect(fmtModelPaceKm(easy)).toBe('5:08'); // 307.8 → 308
  });
});
