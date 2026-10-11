/**
 * PB age caption: one copy for every surface whose numbers PB ageing changes
 * (Stats race estimates, the running Forecast tab and its no-race variant, the
 * triathlon Forecast tab). Shown only when ageing changes the model:
 * pbAgeingActive on the shared measured-volume gate (SCIENCE_LOG §DC). The
 * weight is a smooth 3-year half-life, so the copy names no age cut-off.
 */
import { describe, it, expect } from 'vitest';
import type { SimulatorState } from '@/types';
import { getDefaultState } from '@/state/store';
import { pbAgeCaptionText } from './pb-age-caption';

const NOW = new Date('2026-10-09T08:00:00Z');
const DAY_MS = 86400000;
const ago = (years: number) => new Date(NOW.getTime() - years * 365.25 * DAY_MS).toISOString().slice(0, 10);

function state(pbYears: number | undefined, detectedWeeklyKm?: number): SimulatorState {
  return {
    ...getDefaultState(),
    pbs: { k10: 2400 },
    onboarding: { pbs: { k10: 2400 }, ...(pbYears != null ? { pbDates: { k10: ago(pbYears) } } : {}) },
    ...(detectedWeeklyKm != null ? { detectedWeeklyKm } : {}),
  } as SimulatorState;
}

describe('pbAgeCaptionText', () => {
  it('an aged PB with a measured weekly volume gets the caption, naming the surface', () => {
    expect(pbAgeCaptionText(state(3, 35), 'this forecast', NOW)).toBe('Older PBs carry less weight in this forecast.');
    expect(pbAgeCaptionText(state(5, 35), 'these estimates', NOW)).toBe('Older PBs carry less weight in these estimates.');
    // The weight is continuous (a 3-year half-life), so a 1-year-old PB is
    // weighed too, and the copy names no age cut-off.
    expect(pbAgeCaptionText(state(1, 35), 'this forecast', NOW)).toBe('Older PBs carry less weight in this forecast.');
  });

  it('no caption without a measured volume (the PB keeps full weight, §BV), for an undated PB, or with no PBs', () => {
    expect(pbAgeCaptionText(state(5), 'this forecast', NOW)).toBeNull();
    expect(pbAgeCaptionText(state(undefined, 35), 'this forecast', NOW)).toBeNull();
    expect(pbAgeCaptionText({ ...state(5, 35), pbs: {} } as SimulatorState, 'this forecast', NOW)).toBeNull();
  });

  it('a typed PB faster than the dated onboarding time has no date, so no caption', () => {
    expect(pbAgeCaptionText({ ...state(5, 35), pbs: { k10: 2350 } } as SimulatorState, 'this forecast', NOW)).toBeNull();
  });
});
