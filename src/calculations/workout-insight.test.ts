import { describe, it, expect } from 'vitest';
import { generateWorkoutInsight } from './workout-insight';
import type { GarminActual } from '@/types';

// ─── helpers ─────────────────────────────────────────────────────────────────

function base(overrides: Partial<GarminActual> = {}): GarminActual {
  return {
    garminId: 'test-1',
    distanceKm: 10,
    durationSec: 3600,
    avgPaceSecKm: 360,
    avgHR: 140,
    maxHR: 160,
    calories: 600,
    activityType: 'RUNNING',
    plannedType: 'easy',
    ...overrides,
  };
}

function easyRun(overrides: Partial<GarminActual> = {}): GarminActual {
  return base({ plannedType: 'easy', ...overrides });
}

function longRun(overrides: Partial<GarminActual> = {}): GarminActual {
  return base({ plannedType: 'long', distanceKm: 20, durationSec: 7200, ...overrides });
}

function qualityRun(overrides: Partial<GarminActual> = {}): GarminActual {
  return base({ plannedType: 'threshold', ...overrides });
}

function unmatchedStravaRun(overrides: Partial<GarminActual> = {}): GarminActual {
  return base({ activityType: 'RUNNING', plannedType: null, ...overrides });
}

function crossTraining(overrides: Partial<GarminActual> = {}): GarminActual {
  return base({ activityType: 'CYCLING', plannedType: null, ...overrides });
}

// ─── unmatched Strava runs ────────────────────────────────────────────────────

describe('unmatched Strava run (no plannedType)', () => {
  it('does NOT produce cross-training boilerplate', () => {
    const result = generateWorkoutInsight(unmatchedStravaRun({ durationSec: 3720 }));
    expect(result ?? '').not.toContain('Cross-training');
    expect(result ?? '').not.toContain('cross-training');
  });

  it('returns null when nothing notable to say', () => {
    // Normal easy effort, normal pace, no drift, short enough to skip "stable HR" comment
    const result = generateWorkoutInsight(unmatchedStravaRun({
      hrEffortScore: 1.0,
      paceAdherence: 1.0,
      hrDrift: 2,
      durationSec: 1200, // < 2400s threshold for "stable HR" comment
    }));
    expect(result).toBeNull();
  });

  it('flags HR too high like an easy run', () => {
    const result = generateWorkoutInsight(unmatchedStravaRun({
      hrEffortScore: 1.20,
    }));
    expect(result).not.toBeNull();
    expect(result).toContain('easy');
  });

  it('flags pace too fast like an easy run', () => {
    const result = generateWorkoutInsight(unmatchedStravaRun({
      paceAdherence: 0.85, // ran 15% faster than target
    }));
    expect(result).not.toBeNull();
    expect(result).toContain('easy');
  });
});

// ─── cross-training ───────────────────────────────────────────────────────────

describe('cross-training activity', () => {
  it('returns null when there is nothing useful to say', () => {
    const result = generateWorkoutInsight(crossTraining({
      durationSec: 3720, // 62 min — would have triggered old boilerplate
      hrEffortScore: 1.0,
    }));
    expect(result).toBeNull();
  });
});

// ─── easy run scenarios ───────────────────────────────────────────────────────

describe('easy run — too easy (correct: say nothing or pace comment)', () => {
  it('does not comment when pace is within easy range', () => {
    const result = generateWorkoutInsight(easyRun({
      paceAdherence: 1.05, // slightly slower than target — fine
      hrEffortScore: 1.0,
    }));
    expect(result).toBeNull();
  });
});

describe('easy run — ran too hard (pace)', () => {
  it('flags significantly faster than easy pace', () => {
    const result = generateWorkoutInsight(easyRun({ paceAdherence: 0.85 }));
    expect(result).not.toBeNull();
    expect(result).toContain('easy');
  });

  it('gives a softer nudge for slightly fast easy pace', () => {
    const result = generateWorkoutInsight(easyRun({ paceAdherence: 0.91 }));
    expect(result).not.toBeNull();
    expect(result).toContain('easy');
  });
});

describe('easy run — HR too high', () => {
  it('flags high HR on an easy run', () => {
    const result = generateWorkoutInsight(easyRun({ hrEffortScore: 1.20 }));
    expect(result).not.toBeNull();
    expect(result).toContain('easy run');
  });
});

describe('easy run — HR drifts', () => {
  it('notes significant drift on easy run', () => {
    const result = generateWorkoutInsight(easyRun({ hrDrift: 10, durationSec: 3600 }));
    expect(result).not.toBeNull();
    expect(result).toContain('10%');
  });

  it('does not flag small drift', () => {
    const result = generateWorkoutInsight(easyRun({ hrDrift: 4, durationSec: 3600 }));
    // drift alone < 8% threshold → no drift comment (may be other comments or null)
    expect(result ?? '').not.toContain('drifted');
  });
});

describe('easy run — HR zones too high', () => {
  it('flags high Z4+Z5 time on an easy run', () => {
    const result = generateWorkoutInsight(easyRun({
      hrZones: { z1: 300, z2: 900, z3: 900, z4: 900, z5: 0 }, // ~30% Z4
    }));
    expect(result).not.toBeNull();
    expect(result).toContain('Z4');
  });
});

// ─── quality run scenarios ────────────────────────────────────────────────────

describe('quality run — smashes pace + HR high (went too hard)', () => {
  it('flags over-pace on a quality session', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 0.88, hrEffortScore: 1.18 }));
    expect(result).not.toBeNull();
    expect(result).toContain('faster than target pace');
    expect(result).toContain('Heart rate was running hot');
  });
});

describe('quality run — smashes pace + HR low (efficient day)', () => {
  it('notes over-pace but flags low HR as useful signal', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 0.88, hrEffortScore: 0.82 }));
    expect(result).not.toBeNull();
    expect(result).toContain('faster than target pace');
    expect(result).toContain('HR was well under');
  });
});

describe('quality run — on pace + HR high (body found it hard)', () => {
  it('surfaces HR running hot even when pace was good', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 1.0, hrEffortScore: 1.18 }));
    expect(result).not.toBeNull();
    expect(result).toContain('running hot');
  });
});

describe('quality run — on pace + HR low (nailed it, felt easy)', () => {
  it('notes both good pace and efficient HR', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 1.0, hrEffortScore: 0.82 }));
    expect(result).not.toBeNull();
    expect(result).toContain('HR was well under');
  });
});

describe('quality run — on pace + HR normal (perfect execution)', () => {
  it('compliments the pacing', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 1.0, hrEffortScore: 1.0 }));
    expect(result).not.toBeNull();
    expect(result).toContain('on the money');
  });
});

describe('quality run — too slow + HR high (struggled)', () => {
  it('notes the slower pace and the effort it took', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 1.15, hrEffortScore: 1.18 }));
    expect(result).not.toBeNull();
    expect(result).toContain('slower than target');
    expect(result).toContain('running hot');
  });
});

// ─── split patterns ───────────────────────────────────────────────────────────

describe('split patterns', () => {
  const negativeSplitKm = [360, 358, 355, 350, 345, 340]; // getting faster

  it('recognises negative split on long run', () => {
    const result = generateWorkoutInsight(longRun({ kmSplits: negativeSplitKm }));
    expect(result).not.toBeNull();
    expect(result).toContain('negative split');
  });

  it('recognises negative split on quality run', () => {
    const result = generateWorkoutInsight(qualityRun({ kmSplits: negativeSplitKm }));
    expect(result).not.toBeNull();
    expect(result).toContain('negative split');
  });

  const fadedSplitsKm = [330, 332, 335, 334, 336, 360, 375]; // last 20% blows up

  it('flags fade on long run', () => {
    const result = generateWorkoutInsight(longRun({ kmSplits: fadedSplitsKm }));
    expect(result).not.toBeNull();
    expect(result).toContain('dropped off');
  });

  const evenSplitsKm = [360, 361, 359, 360, 362, 358, 361];

  it('compliments metronomic pacing on easy run', () => {
    const result = generateWorkoutInsight(easyRun({ kmSplits: evenSplitsKm }));
    expect(result).not.toBeNull();
    expect(result).toContain('even');
  });
});

// ─── no data edge cases ───────────────────────────────────────────────────────

describe('insufficient data', () => {
  it('returns null when there is nothing to say about a normal easy run', () => {
    const result = generateWorkoutInsight(easyRun({
      hrEffortScore: null,
      paceAdherence: null,
      hrDrift: null,
      kmSplits: null,
      hrZones: null,
    }));
    expect(result).toBeNull();
  });
});
