// @vitest-environment jsdom
/**
 * Durability drill-down: when a marathon plan's longest run stays under the
 * durability model's long-run bar (raceDayEnduranceBeyondModel), the page says
 * so plainly and quotes no percentage for the race-day penalty anywhere.
 *
 * Before: the banner showed the endurance-gap statement, but the stat card
 * below still read "Applied to race-day forecast +3.80%", a small precise
 * number for a penalty outside the model's calibration (M4 design v4 review,
 * major 4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { renderForecastChipDetail } from './forecast-chip-detail-view';
import { setState, resetState } from '@/state/store';
import { applyLongRunCap } from '@/calculations/run-durability';
import { raceDayEnduranceBeyondModel } from '@/calculations/race-day-durability';
import type { SimulatorState } from '@/types';

function state(raceDayLongestMin: number): SimulatorState {
  return {
    w: 1, tw: 7, rd: 'marathon', rw: 4, v: 45, eventType: 'running', continuousMode: false,
    onboarding: { name: 'Test Runner' },
    wks: [],
    runDurability: applyLongRunCap(70 * 60, 'marathon', 0),
    raceDayDurability: applyLongRunCap(raceDayLongestMin * 60, 'marathon', 0),
  } as unknown as SimulatorState;
}

/** The value cell of the stat row whose label is `label`. */
function statValue(label: string): string | null {
  const spans = Array.from(document.querySelectorAll('span'));
  const i = spans.findIndex(el => el.textContent?.trim() === label);
  return i >= 0 ? (spans[i + 1]?.textContent?.trim() ?? null) : null;
}

describe('Durability drill-down: no precise race-day penalty outside the model', () => {
  beforeEach(() => {
    resetState();
    document.body.innerHTML = '<div id="app-root"></div>';
  });

  it('a 1:06 longest run: plain wording in the stat row, no race-day percentage on the page', () => {
    const s = state(66);
    expect(raceDayEnduranceBeyondModel(s.raceDayDurability, 'marathon')).toBe(true);
    const rddPct = ((s.raceDayDurability!.multiplier - 1) * 100).toFixed(2);
    setState(s);
    renderForecastChipDetail('durability');

    expect(statValue('Applied to race-day forecast')).toBe('Not estimable: long runs too short');
    const text = document.body.textContent ?? '';
    expect(text).toContain('the finish time is optimistic');
    expect(text).not.toContain(`${rddPct}%`);
    expect(text).not.toMatch(/race-day forecast carries a [\d.]+%/);
  });

  it('a 2:01 longest run (inside the model) keeps the precise penalty', () => {
    const s = state(121);
    expect(raceDayEnduranceBeyondModel(s.raceDayDurability, 'marathon')).toBe(false);
    setState(s);
    renderForecastChipDetail('durability');
    const pct = Math.max(0, (s.raceDayDurability!.multiplier - 1) * 100);
    expect(statValue('Applied to race-day forecast')).toBe(pct > 0 ? `+${pct.toFixed(2)}%` : 'None');
  });
});
