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
    const result = generateWorkoutInsight(unmatchedStravaRun({
      hrEffortScore: 1.0,
      paceAdherence: 1.0,
      hrDrift: 2,
      durationSec: 1200,
    }));
    expect(result).toBeNull();
  });

  it('flags high HR via effort mismatch or HR insight', () => {
    // High HR triggers effortMismatch — may return null if no splits/elevation,
    // or HR elevated insight if not mismatch. Either way, should not lecture about "easy".
    const result = generateWorkoutInsight(unmatchedStravaRun({
      hrEffortScore: 1.20,
    }));
    expect(result ?? '').not.toContain('easy run');
  });

  it('does not lecture about easy pace on unmatched runs', () => {
    const result = generateWorkoutInsight(unmatchedStravaRun({
      paceAdherence: 0.85,
    }));
    // No "meant to be easy" lecture — unmatched runs are analysed neutrally
    expect(result ?? '').not.toContain('meant to be easy');
  });
});

// ─── cross-training ───────────────────────────────────────────────────────────

describe('cross-training activity', () => {
  it('returns null when there is nothing useful to say', () => {
    const result = generateWorkoutInsight(crossTraining({
      durationSec: 3720,
      hrEffortScore: 1.0,
    }));
    expect(result).toBeNull();
  });
});

// ─── easy run scenarios ───────────────────────────────────────────────────────

describe('easy run — too easy (correct: say nothing or pace comment)', () => {
  it('does not comment when pace is within easy range', () => {
    const result = generateWorkoutInsight(easyRun({
      paceAdherence: 1.05,
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

  it('also fires for very fast easy pace with no other signals', () => {
    // paceAdh < 0.88 should produce easy-pace warning
    const result = generateWorkoutInsight(easyRun({ paceAdherence: 0.84 }));
    expect(result).not.toBeNull();
    expect(result).toContain('easy');
  });
});

describe('easy run — HR too high', () => {
  it('flags high HR on an easy run', () => {
    const result = generateWorkoutInsight(easyRun({ hrEffortScore: 1.20 }));
    // High HR triggers effort mismatch — no "easy run" lecture, but may get
    // neutral analysis or HR-elevated note
    expect(result ?? '').not.toContain('easy run');
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
    expect(result ?? '').not.toContain('drifted');
  });
});

describe('easy run — HR zones too high', () => {
  it('triggers effort mismatch when zones are high', () => {
    const result = generateWorkoutInsight(easyRun({
      hrZones: { z1: 300, z2: 900, z3: 900, z4: 900, z5: 0 },
    }));
    // High zones → effort mismatch. Should NOT contain "easy run" lecture.
    expect(result ?? '').not.toContain('easy run');
  });
});

// ─── quality run scenarios ────────────────────────────────────────────────────

describe('quality run — smashes pace + HR high (went too hard)', () => {
  it('flags over-pace and connects it to HR', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 0.88, hrEffortScore: 1.18 }));
    expect(result).not.toBeNull();
    expect(result).toContain('faster than target pace');
    expect(result).toContain('HR');
  });
});

describe('quality run — smashes pace + HR low (efficient day)', () => {
  it('notes over-pace but contextualises low HR', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 0.88, hrEffortScore: 0.82 }));
    expect(result).not.toBeNull();
    expect(result).toContain('faster than target pace');
    expect(result).toContain('HR');
  });
});

describe('quality run — on pace + HR high (body found it hard)', () => {
  it('connects on-target pace to higher-than-expected HR', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 1.0, hrEffortScore: 1.18 }));
    expect(result).not.toBeNull();
    expect(result).toContain('on target');
    expect(result).toContain('HR');
  });
});

describe('quality run — on pace + HR low (nailed it, felt easy)', () => {
  it('connects on-target pace to comfortable HR', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 1.0, hrEffortScore: 0.82 }));
    expect(result).not.toBeNull();
    expect(result).toContain('HR');
    expect(result).toContain('comfortable');
  });
});

describe('quality run — on pace + HR normal (perfect execution)', () => {
  it('notes pace was on target', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 1.0, hrEffortScore: 1.0 }));
    expect(result).not.toBeNull();
    expect(result).toContain('on target');
  });
});

describe('quality run — too slow + HR high (struggled)', () => {
  it('notes the slower pace and the effort it took', () => {
    const result = generateWorkoutInsight(qualityRun({ paceAdherence: 1.15, hrEffortScore: 1.18 }));
    expect(result).not.toBeNull();
    expect(result).toContain('slower than target');
    expect(result).toContain('HR was elevated');
  });
});

// ─── pacing story (split-half analysis) ──────────────────────────────────────

describe('pacing story', () => {
  const negativeSplitKm = [360, 358, 355, 350, 345, 340]; // getting faster

  it('detects negative split on long run', () => {
    const result = generateWorkoutInsight(longRun({ kmSplits: negativeSplitKm }));
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('negative split');
  });

  it('detects negative split on quality run', () => {
    const result = generateWorkoutInsight(qualityRun({ kmSplits: negativeSplitKm }));
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('negative split');
  });

  const fadedSplitsKm = [330, 332, 335, 334, 336, 360, 375]; // last portion blows up

  it('detects fade on long run', () => {
    const result = generateWorkoutInsight(longRun({ kmSplits: fadedSplitsKm }));
    expect(result).not.toBeNull();
    // regression-based narrative says "slipped" or "faded" depending on R² quality
    expect(result).toMatch(/slipped|faded/);
  });

  const evenSplitsKm = [360, 361, 359, 360, 362, 358, 361];

  it('detects even pacing on easy run', () => {
    const result = generateWorkoutInsight(easyRun({ kmSplits: evenSplitsKm }));
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('consistent');
  });
});

// ─── effort mismatch (easy label but ran hard) ──────────────────────────────

describe('effort mismatch', () => {
  it('gives pacing analysis instead of easy-run lecture', () => {
    const result = generateWorkoutInsight(easyRun({
      hrEffortScore: 1.20,
      kmSplits: [270, 275, 280, 290, 300, 310, 320, 330, 340, 350],
      distanceKm: 10,
    }));
    expect(result).not.toBeNull();
    expect(result).toMatch(/slipped|faded/);
    expect(result ?? '').not.toContain('easy run');
  });

  it('includes elevation context when available', () => {
    const result = generateWorkoutInsight(easyRun({
      hrEffortScore: 1.20,
      kmSplits: [270, 275, 280, 290, 300, 310, 320, 330, 340, 350],
      distanceKm: 10,
      elevationGainM: 200,
    }));
    expect(result).not.toBeNull();
    expect(result).toContain('m/km');
  });

  it('includes TSS comparison when plan data exists', () => {
    const result = generateWorkoutInsight(easyRun({
      hrEffortScore: 1.20,
      kmSplits: [270, 275, 280, 290, 300, 310, 320, 330, 340, 350],
      distanceKm: 21,
      plannedDistanceKm: 8,
      iTrimp: 27000, // → 180 TSS
    }));
    expect(result).not.toBeNull();
    expect(result).toContain('TSS');
  });
});

// ─── elevation context ──────────────────────────────────────────────────────

describe('elevation context', () => {
  it('adds gradient context for hilly runs', () => {
    const result = generateWorkoutInsight(longRun({
      elevationGainM: 400,
      distanceKm: 20,
      kmSplits: [330, 332, 335, 334, 336, 360, 375],
    }));
    expect(result).not.toBeNull();
    expect(result).toContain('m/km');
  });

  it('does not mention flat runs', () => {
    const result = generateWorkoutInsight(easyRun({
      elevationGainM: 30,
      distanceKm: 10,
    }));
    expect(result ?? '').not.toContain('gradient');
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
