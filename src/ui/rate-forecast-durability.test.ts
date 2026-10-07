/**
 * rate() recomputes the race-day forecast after a rating. It must apply the
 * race-day durability the plan builds (race-day-durability.ts) on the published
 * peak-volume forecast anchor, like renderer.ts and the onboarding preview.
 * Before 2026-10-07 it anchored on today's estimate, which already carries
 * today's logged-run durability cap, and had no race-day term.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./renderer', () => ({ render: vi.fn(), log: vi.fn() }));
vi.mock('@/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state')>();
  return { ...actual, saveState: vi.fn() };
});

import { setState, getMutableState } from '@/state/store';
import { rate } from './events';
import { raceDayDurabilityMultiplier } from '@/calculations/race-day-durability';
import type { SimulatorState } from '@/types';

function lowBaselineMarathon(forecastBlendAnchorSec: number): SimulatorState {
  return {
    w: 2, tw: 14, rd: 'marathon', rw: 4, epw: 4, v: 45, iv: 45, expectedFinal: 47, rpeAdj: 0,
    typ: 'Balanced', b: 1.06, timp: 0, continuousMode: false, eventType: 'running',
    detectedWeeklyKm: 15, wkm: 15, athleteArchetype: { archetype: 'detrained-with-history' },
    onboarding: { experienceLevel: 'novice', weeklyTrainingHours: 4 },
    pac: { e: 330, t: 280, i: 255, m: 300, r: 240 }, lt: null, pbs: {},
    blendedRaceTimeSec: 4 * 3600 + 30 * 60,
    forecastBlendAnchorSec,
    planStartDate: '2026-09-28',
    wks: Array.from({ length: 14 }, (_, i) => ({ w: i + 1, ph: i < 6 ? 'base' : i < 11 ? 'build' : 'taper', rated: {}, skip: [] })),
  } as unknown as SimulatorState;
}

describe('rate(): race-day forecast after a rating', () => {
  it('scales the peak-volume anchor by the plan\'s race-day durability multiplier', () => {
    const m = raceDayDurabilityMultiplier(lowBaselineMarathon(4 * 3600))!;
    expect(m).toBeGreaterThan(1);

    setState(lowBaselineMarathon(4 * 3600));
    rate('W2-easy-0', 'Easy Run', 5, 5, 'easy', false);
    const f1 = getMutableState().forecastTime!;

    setState(lowBaselineMarathon(4 * 3600 + 600));
    rate('W2-easy-0', 'Easy Run', 5, 5, 'easy', false);
    const f2 = getMutableState().forecastTime!;

    // 600 s more on the anchor moves the forecast by 600 s x the race-day multiplier.
    expect((f2 - f1) / 600).toBeCloseTo(m, 9);
  });
});
