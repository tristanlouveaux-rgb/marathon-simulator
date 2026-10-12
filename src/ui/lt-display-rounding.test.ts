/**
 * s.lt is stored unrounded (2026-10-12): it is a model input, and the PB age
 * weight moves the derived LT a little every day. Display rounds it to the
 * whole second at the display boundary, so the LT the user reads is what it
 * was when s.lt was stored rounded, and a pace such as 299.6 s/km never shows
 * as "4:60".
 */
import { describe, it, expect, vi } from 'vitest';
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

import { getDefaultState } from '@/state/store';
import { renderForecastFingerprint } from './race-forecast-fingerprint';
import { buildRunningCoachContext } from '@/coach/coach-context-builder';

function stateWithLt(lt: number): SimulatorState {
  return { ...getDefaultState(), v: 50, lt, ltPace: lt, unitPref: 'km', rd: 'marathon', forecastTime: 11000, blendedRaceTimeSec: 11400 } as SimulatorState;
}

describe('LT display rounds the unrounded s.lt to the whole second', () => {
  it('forecast fingerprint: 299.6 s/km reads LT 5:00/km, never 4:60', () => {
    const html = renderForecastFingerprint(stateWithLt(299.6), false);
    expect(html).toContain('LT 5:00/km');
    expect(html).not.toContain('4:60');
  });

  it('forecast fingerprint: 287.4 s/km reads 4:47/km, as the stored 287 did', () => {
    expect(renderForecastFingerprint(stateWithLt(287.4), false)).toContain('LT 4:47/km');
  });

  it('coach context: 299.6 s/km reads 5:00 min/km', () => {
    const ctx = buildRunningCoachContext(stateWithLt(299.6)) as { athlete: { lt_pace: string | null } };
    expect(ctx.athlete.lt_pace).toBe('5:00 min/km');
  });
});
