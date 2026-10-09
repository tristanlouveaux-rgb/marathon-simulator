import { describe, expect, it } from 'vitest';
import {
  detectArchetype,
  classify,
  gatherEvidence,
  startingWeeklyKm,
  weekVolumeBudgetKm,
  ARCHETYPE_PARAMS,
  typedWeeklyKm,
  typedVolumeArchetype,
  planRampArchetype,
  type ArchetypeEvidence,
} from './athlete-archetype';
import type { SimulatorState } from '@/types/state';

function emptyState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return { ...overrides } as SimulatorState;
}

function evidence(overrides: Partial<ArchetypeEvidence> = {}): ArchetypeEvidence {
  return {
    currentWeeklyKm: 0,
    peakWeeklyKmPast52: 0,
    longestRunPast12moKm: 0,
    weeksSinceConsistent: Infinity,
    crossTrainingHoursPerWeek: 0,
    impactSportPresent: false,
    hasCompletedMarathon: false,
    yearsOfRecordedTraining: null,
    weeklyKmCV: 0,
    ...overrides,
  };
}

describe('classify', () => {
  it('returns high-mileage for ≥50 km/wk with low CV', () => {
    expect(classify(evidence({ currentWeeklyKm: 65, weeksSinceConsistent: 0, weeklyKmCV: 0.15 })))
      .toBe('high-mileage');
  });

  it('does NOT return high-mileage when CV is too volatile (returning from injury)', () => {
    // 50+ km/wk average but with big spikes/drops → not steady high-mileage
    expect(classify(evidence({ currentWeeklyKm: 50, weeksSinceConsistent: 0, weeklyKmCV: 0.5 })))
      .toBe('consistent-runner');
  });

  it('returns consistent-runner for ≥20 km/wk recent', () => {
    expect(classify(evidence({ currentWeeklyKm: 35, weeksSinceConsistent: 1 })))
      .toBe('consistent-runner');
  });

  it('returns detrained-with-history when current low, layoff > 2 weeks, peak history present', () => {
    expect(classify(evidence({ currentWeeklyKm: 18, peakWeeklyKmPast52: 50, weeksSinceConsistent: 6 })))
      .toBe('detrained-with-history');
  });

  it('detrained-with-history triggers on marathon completion + layoff', () => {
    expect(classify(evidence({ currentWeeklyKm: 18, hasCompletedMarathon: true, weeksSinceConsistent: 4 })))
      .toBe('detrained-with-history');
  });

  it('detrained-with-history triggers on long-run evidence + layoff', () => {
    expect(classify(evidence({ currentWeeklyKm: 18, longestRunPast12moKm: 22, weeksSinceConsistent: 5 })))
      .toBe('detrained-with-history');
  });

  it('stable low-volume runner (18 km/wk, hit 20+ last week, marathon PB) is CONSISTENT not detrained', () => {
    // Real case from production: user at 18.2 km/wk, weeksSinceConsistent=1, has marathon PB.
    // Not a layoff. They're a stable low-volume athlete with history.
    expect(classify(evidence({
      currentWeeklyKm: 18.2,
      peakWeeklyKmPast52: 38.5,
      longestRunPast12moKm: 21.2,
      weeksSinceConsistent: 1,
      hasCompletedMarathon: true,
    }))).toBe('consistent-runner');
  });

  it('low-volume + history but weeksSinceConsistent exactly 2: still consistent', () => {
    expect(classify(evidence({
      currentWeeklyKm: 17, hasCompletedMarathon: true, weeksSinceConsistent: 2,
    }))).toBe('consistent-runner');
  });

  it('low-volume + history with weeksSinceConsistent = 3: now detrained', () => {
    expect(classify(evidence({
      currentWeeklyKm: 17, hasCompletedMarathon: true, weeksSinceConsistent: 3,
    }))).toBe('detrained-with-history');
  });

  it('returns cross-trained-impact when low run km but impact sport active', () => {
    expect(classify(evidence({ currentWeeklyKm: 8, impactSportPresent: true })))
      .toBe('cross-trained-impact');
  });

  it('returns cross-trained-no-impact when low run km but cycling/swim present', () => {
    expect(classify(evidence({ currentWeeklyKm: 8, crossTrainingHoursPerWeek: 6 })))
      .toBe('cross-trained-no-impact');
  });

  it('returns sedentary-novice when nothing else fits', () => {
    expect(classify(evidence({ currentWeeklyKm: 5 })))
      .toBe('sedentary-novice');
  });

  it('priority: high-mileage beats consistent-runner', () => {
    expect(classify(evidence({ currentWeeklyKm: 55, weeksSinceConsistent: 0, weeklyKmCV: 0.2 })))
      .toBe('high-mileage');
  });

  it('priority: detrained-with-history beats cross-trained-impact when history + layoff', () => {
    expect(classify(evidence({
      currentWeeklyKm: 12,
      hasCompletedMarathon: true,
      weeksSinceConsistent: 8,
      impactSportPresent: true,
    }))).toBe('detrained-with-history');
  });
});

describe('detectArchetype', () => {
  it('returns unknown when Strava not connected and no onboarding runs', () => {
    const r = detectArchetype(emptyState());
    expect(r.archetype).toBe('unknown');
    expect(r.confidence).toBe('none');
  });

  it('returns low confidence when only onboardingRunHistory exists', () => {
    const r = detectArchetype(emptyState({
      onboardingRunHistory: [
        { startTime: '2026-05-01', distKm: 12, durSec: 4500, activityType: 'RUNNING' },
      ],
      detectedWeeklyKm: 15,
    }));
    expect(r.confidence).toBe('low');
    expect(r.archetype).not.toBe('unknown');
  });

  it('returns medium confidence with 8+ weeks of history', () => {
    const r = detectArchetype(emptyState({
      stravaHistoryFetched: true,
      historicWeeklyKm: [25, 28, 30, 22, 26, 27, 29, 28],
      detectedWeeklyKm: 28,
      firstStravaActivityISO: '2025-09-01',
    }));
    expect(r.confidence).toBe('medium');
    expect(r.archetype).toBe('consistent-runner');
  });

  it('returns high confidence with 26+ weeks AND >1 year tenure', () => {
    const longHistory = Array(30).fill(0).map((_, i) => 30 + (i % 4));
    const r = detectArchetype(emptyState({
      stravaHistoryFetched: true,
      extendedHistoryKm: longHistory,
      historicWeeklyKm: longHistory.slice(-8),
      detectedWeeklyKm: 31,
      firstStravaActivityISO: '2024-01-01',
    }));
    expect(r.confidence).toBe('high');
  });

  it('detrained-with-history: 18km/wk now but ran 50km/wk last summer', () => {
    const r = detectArchetype(emptyState({
      stravaHistoryFetched: true,
      extendedHistoryKm: [
        50, 52, 48, 55, 60, 58, 45, 30,  // 8 months ago - peak
        20, 18, 15, 12, 10, 15, 18, 20,  // gradual decline
        18, 17, 18, 19, 18, 17, 18, 18,  // current 8 weeks
      ],
      historicWeeklyKm: [18, 17, 18, 19, 18, 17, 18, 18],
      detectedWeeklyKm: 18,
      onboarding: { pbs: { m: 13200 } } as never,
    }));
    expect(r.archetype).toBe('detrained-with-history');
  });
});

describe('startingWeeklyKm', () => {
  it('consistent-runner at 30 km/wk starts at ~32 km (5% bump, under cap)', () => {
    expect(startingWeeklyKm(30, 'consistent-runner')).toBeCloseTo(31.5, 1);
  });

  it('detrained-with-history at 18 km/wk caps at ACWR 1.30 (was 24.8 raw, now 23.4)', () => {
    // raw: 18 * 1.10 + 5 = 24.8 → ACWR cap: 18 * 1.30 = 23.4
    expect(startingWeeklyKm(18, 'detrained-with-history')).toBeCloseTo(23.4, 1);
  });

  it('detrained-with-history at 30 km/wk: cap (39) > raw (38) → raw applies', () => {
    // raw: 30 * 1.10 + 5 = 38 → cap: 30 * 1.30 = 39 → raw wins (smaller)
    expect(startingWeeklyKm(30, 'detrained-with-history')).toBeCloseTo(38, 1);
  });

  it('detrained-with-history honours the 15 km floor at low baseline', () => {
    // baseline=5, ≤10 km so ACWR cap does NOT apply; raw: max(15, 10.5)=15
    expect(startingWeeklyKm(5, 'detrained-with-history')).toBe(15);
  });

  it('high-mileage stays at current (already peak)', () => {
    expect(startingWeeklyKm(75, 'high-mileage')).toBe(75);
  });

  it('cross-trained-no-impact at 0 km/wk starts at 10 (floor — bone-limited)', () => {
    expect(startingWeeklyKm(0, 'cross-trained-no-impact')).toBe(10);
  });

  it('cross-trained-impact at 5 km/wk starts at 15 (floor — bone-adapted, cap skipped)', () => {
    // raw: max(15, 5*1.15)=15; baseline ≤ 10 so cap not applied
    expect(startingWeeklyKm(5, 'cross-trained-impact')).toBe(15);
  });

  it('cross-trained-impact at 12 km/wk: floor (15) binds, under cap (15.6)', () => {
    // raw: max(15, 12*1.15)=max(15, 13.8)=15; cap: 12*1.30=15.6 → 15 (under cap)
    expect(startingWeeklyKm(12, 'cross-trained-impact')).toBe(15);
  });

  it('cross-trained-impact at 20 km/wk: ACWR cap (26) protects against floor-induced spike', () => {
    // raw: max(15, 20*1.15)=23; cap: 20*1.30=26 → raw wins (under cap). Safe.
    expect(startingWeeklyKm(20, 'cross-trained-impact')).toBeCloseTo(23, 1);
  });

  it('sedentary-novice never starts above 10 km regardless of baseline', () => {
    expect(startingWeeklyKm(0, 'sedentary-novice')).toBe(10);
  });

  it('ACWR cap: no archetype can exceed baseline × 1.30 above the 10km threshold', () => {
    // Worst-case headroom-floor combo at baseline=15 (just above threshold):
    // detrained-with-history: raw 15*1.10+5=21.5, cap 15*1.30=19.5 → 19.5
    expect(startingWeeklyKm(15, 'detrained-with-history')).toBeCloseTo(19.5, 1);
    // Confirm ratio:
    expect(startingWeeklyKm(15, 'detrained-with-history') / 15).toBeLessThanOrEqual(1.30 + 1e-9);
  });

  it('cap does not apply at exactly 10 km baseline (boundary)', () => {
    // baseline=10 (boundary, NOT >10): cap is OFF, raw value applies
    // detrained-with-history: raw=max(15, 10*1.10+5)=max(15,16)=16. No cap. Returns 16.
    expect(startingWeeklyKm(10, 'detrained-with-history')).toBe(16);
  });
});

describe('weekVolumeBudgetKm', () => {
  it('week 1 returns startingWeeklyKm', () => {
    expect(weekVolumeBudgetKm(1, 18, 70, 'detrained-with-history'))
      .toBeCloseTo(startingWeeklyKm(18, 'detrained-with-history'), 5);
  });

  it('caps at peakKm — never overshoots', () => {
    // detrained-with-history ramps at 10%/wk: by week 20, 24.8 × 1.10^19 = ~155 km. Peak should clamp
    expect(weekVolumeBudgetKm(20, 18, 70, 'detrained-with-history')).toBe(70);
  });

  it('high-mileage at baseline=peak is flat', () => {
    expect(weekVolumeBudgetKm(1, 75, 75, 'high-mileage')).toBe(75);
    expect(weekVolumeBudgetKm(10, 75, 75, 'high-mileage')).toBe(75);
  });

  it('consistent-runner takes ~6 weeks to ramp 30 → 45 km/wk at 7%/wk', () => {
    // 30 * 1.05 (start) * 1.07^5 ≈ 31.5 × 1.4 ≈ 44 km
    const w6 = weekVolumeBudgetKm(6, 30, 60, 'consistent-runner');
    expect(w6).toBeGreaterThan(40);
    expect(w6).toBeLessThan(48);
  });

  it('ramp is geometric, not linear', () => {
    const w1 = weekVolumeBudgetKm(1, 20, 80, 'consistent-runner');
    const w2 = weekVolumeBudgetKm(2, 20, 80, 'consistent-runner');
    const w3 = weekVolumeBudgetKm(3, 20, 80, 'consistent-runner');
    const delta12 = w2 - w1;
    const delta23 = w3 - w2;
    expect(delta23).toBeGreaterThan(delta12);
  });
});

describe('ARCHETYPE_PARAMS', () => {
  it('all archetypes are configured', () => {
    const expected = [
      'high-mileage', 'consistent-runner', 'detrained-with-history',
      'cross-trained-impact', 'cross-trained-no-impact', 'sedentary-novice', 'unknown',
    ] as const;
    for (const a of expected) {
      expect(ARCHETYPE_PARAMS[a]).toBeDefined();
      expect(ARCHETYPE_PARAMS[a].weeklyRampPct).toBeGreaterThan(0);
      expect(ARCHETYPE_PARAMS[a].weeklyRampPct).toBeLessThan(0.20);
    }
  });

  it('bone-limited archetypes have lower ramp slopes than running-history archetypes', () => {
    expect(ARCHETYPE_PARAMS['cross-trained-no-impact'].weeklyRampPct)
      .toBeLessThan(ARCHETYPE_PARAMS['detrained-with-history'].weeklyRampPct);
    expect(ARCHETYPE_PARAMS['sedentary-novice'].weeklyRampPct)
      .toBeLessThan(ARCHETYPE_PARAMS['consistent-runner'].weeklyRampPct);
  });

  it('prediction band widens with lower confidence in adherence', () => {
    expect(ARCHETYPE_PARAMS['high-mileage'].predictionBandPctWidth)
      .toBeLessThan(ARCHETYPE_PARAMS['sedentary-novice'].predictionBandPctWidth);
    expect(ARCHETYPE_PARAMS['consistent-runner'].predictionBandPctWidth)
      .toBeLessThan(ARCHETYPE_PARAMS['cross-trained-no-impact'].predictionBandPctWidth);
  });
});

describe('gatherEvidence', () => {
  it('handles fully empty state without throwing', () => {
    const e = gatherEvidence(emptyState());
    expect(e.currentWeeklyKm).toBe(0);
    expect(e.peakWeeklyKmPast52).toBe(0);
    expect(e.weeksSinceConsistent).toBe(Infinity);
  });

  it('computes weeksSinceConsistent from extendedHistoryKm (oldest first)', () => {
    const e = gatherEvidence(emptyState({
      extendedHistoryKm: [25, 28, 30, 22, 15, 12, 10, 8],
      detectedWeeklyKm: 8,
    }));
    // The most recent 4 weeks are below 20km, week index 4 (0-based from end) was 22 km.
    // Reversed: [8, 10, 12, 15, 22, ...]. First ≥20 is at index 4.
    expect(e.weeksSinceConsistent).toBe(4);
  });

  it('flags hasCompletedMarathon from PB', () => {
    const e = gatherEvidence(emptyState({
      onboarding: { pbs: { m: 14400 } } as never,
    }));
    expect(e.hasCompletedMarathon).toBe(true);
  });

  it('flags hasCompletedMarathon from a 38+km run in onboarding history', () => {
    const e = gatherEvidence(emptyState({
      onboardingRunHistory: [
        { startTime: '2026-01-15', distKm: 42.2, durSec: 14400, activityType: 'RUNNING' },
      ],
    }));
    expect(e.hasCompletedMarathon).toBe(true);
  });

  it('detects impactSportPresent for tennis but not cycling', () => {
    const ePadel = gatherEvidence(emptyState({
      sportBaselineByType: { tennis: { avgSessionRawTSS: 80, sessionsPerWeek: 1.5 } },
    }));
    expect(ePadel.impactSportPresent).toBe(true);

    const eBike = gatherEvidence(emptyState({
      sportBaselineByType: { cycling: { avgSessionRawTSS: 90, sessionsPerWeek: 3 } },
    }));
    expect(eBike.impactSportPresent).toBe(false);
    expect(eBike.crossTrainingHoursPerWeek).toBeGreaterThan(0);
  });
});

describe('typedVolumeArchetype (weekly km typed in onboarding, no sync)', () => {
  const typed = (km: number, overrides: Partial<SimulatorState> = {}) =>
    emptyState({ detectedWeeklyKm: km, weeklyVolumeConfirmed: true, ...overrides });

  it('runs the sync classifier on the typed km', () => {
    expect(typedVolumeArchetype(typed(50))).toBe('high-mileage');      // no history reads as steady (CV 0): slowest ramp
    expect(typedVolumeArchetype(typed(30))).toBe('consistent-runner');
    expect(typedVolumeArchetype(typed(15))).toBe('consistent-runner'); // classifier fallback, 10 to 20 km
    expect(typedVolumeArchetype(typed(5))).toBe('sedentary-novice');
  });

  it('never reads a typed km as a layoff: under 20 km with a marathon PB is consistent, not detrained', () => {
    const s = typed(15, { onboarding: { pbs: { m: 14400 } } as SimulatorState['onboarding'] });
    expect(classify(gatherEvidence(s))).toBe('detrained-with-history');
    expect(typedVolumeArchetype(s)).toBe('consistent-runner');
  });

  it('is undefined without a typed or confirmed km, or once synced weekly history exists', () => {
    expect(typedVolumeArchetype(emptyState({ detectedWeeklyKm: 30 }))).toBeUndefined();
    expect(typedVolumeArchetype(typed(0))).toBeUndefined();
    expect(typedVolumeArchetype(typed(30, { historicWeeklyKm: [30, 30, 30] }))).toBeUndefined();
    expect(typedWeeklyKm(emptyState({ detectedWeeklyKm: 30 }))).toBeUndefined();
    expect(typedWeeklyKm(typed(30))).toBe(30);
  });

  it('planRampArchetype prefers the synced classification over the typed one', () => {
    expect(planRampArchetype(typed(50))).toBe('high-mileage');
    expect(planRampArchetype(typed(50, {
      athleteArchetype: { archetype: 'detrained-with-history' } as SimulatorState['athleteArchetype'],
    }))).toBe('detrained-with-history');
    expect(planRampArchetype(emptyState())).toBeUndefined();
  });
});
