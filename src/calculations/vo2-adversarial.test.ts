/**
 * Adversarial tests for the cross-modal VO2max system.
 *
 * Probes failure modes that aren't covered by the happy-path tests:
 * sensor errors, stale physiology, misleading lifts, default-weight bias,
 * HR ceiling artefacts. Each test names the concern it's exercising.
 */

import { describe, it, expect } from 'vitest';
import { computeCardiacCeiling } from './cardiac-ceiling';
import { computeCyclingVO2 } from './cycling-vo2';
import { computeVO2Estimates } from './vo2-orchestrator';
import type { SimulatorState, Week, GarminActual } from '@/types';

const NOW = new Date('2026-05-01T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString();

function mkState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    w: 3, tw: 12, v: 50, iv: 50, rpeAdj: 0, expectedFinal: 48,
    rd: 'marathon' as any, epw: 5, rw: 4, wkm: 50,
    pbs: {} as any, rec: null, lt: null, vo2: null,
    initialLT: null, initialVO2: null, initialBaseline: null,
    currentFitness: null, forecastTime: null,
    typ: 'balanced' as any, b: 1.06,
    wks: [], pac: { e: 330 } as any, skip: [], timp: 0,
    restingHR: 50, maxHR: 195, bodyWeightKg: 75, biologicalSex: 'male',
    ...overrides,
  } as SimulatorState;
}

function mkActual(opts: Partial<GarminActual> & { id: string; daysAgo: number; activityType: string }): GarminActual {
  const { id, daysAgo: ago, ...rest } = opts;
  return {
    garminId: id,
    startTime: daysAgo(ago),
    distanceKm: 0, durationSec: 1800,
    avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
    ...rest,
  } as GarminActual;
}

function mkWeek(actuals: GarminActual[]): Week {
  const map: Record<string, GarminActual> = {};
  for (const a of actuals) map[a.garminId] = a;
  return { w: 1, ph: 'build', workouts: [], targetTSS: 0, actualTSS: 0, garminActuals: map } as any;
}

describe('cardiac ceiling — adversarial', () => {
  it('GUARD: sensor-error HRmax above 220 is filtered out', () => {
    const r = computeCardiacCeiling([{
      startTime: daysAgo(1), durationSec: 1800, maxHR: 230, sport: 'running',
    }], 50, NOW);
    // The 230 reading is rejected → no qualifying sessions → no cardiac value.
    expect(r.vo2).toBeNull();
    expect(r.reason).toBe('no-hrmax');
  });

  it('FAILURE MODE: stale RHR (post-illness, dehydration) shifts ceiling', () => {
    // User's RHR is 65 during illness recovery; their healthy RHR is 50.
    // True cardiac ceiling based on healthy RHR = 15.3 × 195/50 = 59.7
    // What we compute with stale RHR =                   15.3 × 195/65 = 45.9
    const trueRest = 50;
    const staleRest = 65;
    const trueCeiling = computeCardiacCeiling([{
      startTime: daysAgo(1), durationSec: 1800, maxHR: 195, sport: 'running',
    }], trueRest, NOW);
    const staleCeiling = computeCardiacCeiling([{
      startTime: daysAgo(1), durationSec: 1800, maxHR: 195, sport: 'running',
    }], staleRest, NOW);
    const gap = (trueCeiling.vo2! - staleCeiling.vo2!) / trueCeiling.vo2!;
    // RHR drift of 30% produces a ~23% under-estimate of cardiac ceiling.
    expect(gap).toBeGreaterThan(0.20);
    // No mitigation — we trust whatever RHR is in state.
  });

  it('GUARD: cardiac ceiling clamped at physiologically plausible upper limit', () => {
    // A sub-elite user with HRmax 200, RHR 35 → Uth-Sørensen says 87.4.
    // We clamp at 85 to keep numbers within recreational-app plausibility.
    const r = computeCardiacCeiling([{
      startTime: daysAgo(1), durationSec: 1800, maxHR: 200, sport: 'running',
    }], 35, NOW);
    expect(r.vo2!).toBeLessThanOrEqual(85);
    expect(r.vo2!).toBe(85);
  });

  it('FAILURE MODE: single sport, single session = "low" confidence but value still surfaces', () => {
    const r = computeCardiacCeiling([{
      startTime: daysAgo(1), durationSec: 1800, maxHR: 195, sport: 'running',
    }], 50, NOW);
    expect(r.vo2).not.toBeNull();
    expect(r.confidence).toBe('low');
    // Value is shown in the card with "Low confidence" label — that's our
    // safety net. Document this so we don't tighten gating without thinking.
  });
});

describe('cycling VO2 — adversarial', () => {
  it('FAILURE MODE: sex-default body weight overestimates cycling VO2 for lighter athletes', () => {
    // Female athlete weighing 55kg, no weight in state. Defaults to 62kg female.
    // Real cycling VO2 (FTP 200, 55kg) = 10.8 × 200/55 + 7 = 46.3
    // What we compute (default 62kg)   = 10.8 × 200/62 + 7 = 41.8
    // Underestimate by ~10%. Confidence is downgraded but the number is still off.
    const real = computeCyclingVO2({ ftpW: 200, bodyWeightKg: 55 });
    const defaulted = computeCyclingVO2({ ftpW: 200, biologicalSex: 'female' });
    expect(real.vo2!).toBeGreaterThan(defaulted.vo2!);
    expect(defaulted.usedDefaultWeight).toBe(true);
  });

  it('FAILURE MODE: prefer_not_to_say defaults to MALE weight (75kg)', () => {
    const r = computeCyclingVO2({ ftpW: 200, biologicalSex: 'prefer_not_to_say' });
    expect(r.weightKgUsed).toBe(75);
    // For a non-binary or unspecified athlete who's actually lighter, this
    // under-estimates. Documented bias.
  });
});

describe('orchestrator lift logic — adversarial', () => {
  it('GUARD: cycling stays null when user has no FTP (no cardiac-lift inflation)', () => {
    // Pure runner with strong cardiac fitness. They never bike. We must NOT
    // display a cycling number — earlier versions used cardiac × transfer to
    // populate cycling for someone who doesn't ride; that was a double-count
    // and misleading. Cycling stays null until they have an FTP.
    const acts = Array.from({ length: 8 }).map((_, i) =>
      mkActual({ id: `r${i}`, daysAgo: i * 4, activityType: 'RUNNING', maxHR: 195, avgHR: 165, durationSec: 3600 })
    );
    const r = computeVO2Estimates(mkState({ wks: [mkWeek(acts)] }), NOW);
    expect(r.cycling.value).toBeNull();
    expect(r.cycling.source).toBe('none');
  });

  it('GUARD: headline is running/cycling whenever either has data — cardiac never wins over a measurement', () => {
    // Rich running data + strong cardiac. Earlier versions had the headline
    // sort across (running, cycling, cardiac) so cardiac frequently won via
    // raw value. Now headline is restricted to measured peripheral fitness;
    // cardiac is informational only and only carries the headline when
    // neither running nor cycling has signal.
    const acts: GarminActual[] = [];
    for (let i = 0; i < 12; i++) {
      acts.push(mkActual({
        id: `run${i}`, daysAgo: i * 4, activityType: 'RUNNING',
        distanceKm: 10, durationSec: 3000, avgHR: 145 + (i % 3) * 5, maxHR: 175 + (i % 2) * 3,
      }));
    }
    for (let i = 0; i < 6; i++) {
      acts.push(mkActual({
        id: `pad${i}`, daysAgo: i * 4, activityType: 'padel',
        durationSec: 3600, maxHR: 195,
      }));
    }
    const r = computeVO2Estimates(mkState({ wks: [mkWeek(acts)] }), NOW);
    expect(r.headline.value).not.toBeNull();
    expect(r.headline.sport).toBe('running');
    if (r.running.value != null) {
      expect(r.headline.value).toBe(r.running.value);
    }
  });

  it('SAFETY: missing wks does not crash; physio fallback produces a headline', () => {
    const r = computeVO2Estimates(mkState({ wks: undefined }) , NOW);
    // No cross-modal signal → physio fallback walks the LT/PB/Tanda chain and
    // picks Tanda (s.v=50) since no LT/PBs are set. Running.value populated.
    expect(r.headline.value).toBe(50);
    expect(r.running.value).toBe(50);
  });

  it('SAFETY: missing restingHR yields null cardiac, no crash', () => {
    const acts = [mkActual({ id: 'r1', daysAgo: 1, activityType: 'RUNNING', maxHR: 190, avgHR: 160, distanceKm: 5, durationSec: 1800 })];
    const r = computeVO2Estimates(mkState({ restingHR: undefined, wks: [mkWeek(acts)] }), NOW);
    expect(r.cardiac.value).toBeNull();
    // Without cardiac, no lift. Running depends on hr-calibrated which also needs RHR.
    // So everything is null — but no crash.
    expect(() => r.headline.value).not.toThrow();
  });

  it('SAFETY: corrupt activity (missing startTime) is skipped, not thrown', () => {
    const goodAct = mkActual({ id: 'r1', daysAgo: 1, activityType: 'RUNNING', maxHR: 195, avgHR: 160, distanceKm: 5, durationSec: 1800 });
    const badAct = { ...mkActual({ id: 'r2', daysAgo: 0, activityType: 'RUNNING', maxHR: 0 }), startTime: null } as any;
    const r = computeVO2Estimates(
      mkState({ wks: [mkWeek([goodAct, badAct])] }),
      NOW,
    );
    expect(r).toBeDefined();
  });
});
