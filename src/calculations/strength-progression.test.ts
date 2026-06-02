import { describe, it, expect } from 'vitest';
import {
  isWeightTrackable,
  normalizeExerciseKey,
  cleanExerciseName,
} from './strength-exercise-key';
import {
  estimate1RM,
  plateRound,
  suggestNextWeight,
  type NextWeightArgs,
} from './strength-progression';
import { appendEst1rmSample } from './strength-log-history';
import type { StrengthLiftEntry } from '@/types/strength-log';
import { EPLEY_REP_CAP } from '@/constants/strength-constants';

// ── Exercise key + trackability ──────────────────────────────────────────────
// Names below are exactly as they appear AFTER parseStrengthSession (reps token
// and parentheticals removed, load marker retained). This is the real contract.

describe('isWeightTrackable + normalizeExerciseKey — gym.ts vocabulary', () => {
  const TRACKABLE: Array<[string, string]> = [
    ['Back Squat @80% 1RM', 'back-squat'],
    ['Front Squat @85% 1RM', 'front-squat'],
    ['Goblet Squat @50% 1RM', 'goblet-squat'],
    ['Squat @75% 1RM', 'squat'],                       // peak maintenance, bare
    ['Romanian Deadlift @60% 1RM', 'rdl'],
    ['Single-Leg RDL @40% 1RM', 'single-leg-rdl'],
    ['Deadlift @80% 1RM', 'deadlift'],
    ['Trap-Bar Deadlift @85% 1RM', 'trap-bar-deadlift'],
    ['Kettlebell Deadlift @50% 1RM', 'kettlebell-deadlift'],
    ['Hip Thrust @60% 1RM', 'hip-thrust'],
    ['Glute Bridge @60% 1RM', 'glute-bridge'],
    ['Bulgarian Split Squat @60% 1RM', 'split-squat'],
    ['Split Squat @40% 1RM', 'split-squat'],
    ['Step-Ups @50% 1RM', 'step-up'],
    ['Weighted Lunges @50% 1RM', 'lunge'],
    ['Lunges @40% 1RM', 'lunge'],
    // Upper-body (on-demand generator pool)
    ['Barbell Bench Press @80% 1RM', 'bench-press'],
    ['Overhead Press @75% 1RM', 'overhead-press'],
    ['Dumbbell Row @70% 1RM', 'row'],
    ['Lat Pulldown @70% 1RM', 'lat-pulldown'],
    ['Biceps Curl @65% 1RM', 'curl'],
  ];

  it.each(TRACKABLE)('"%s" is trackable -> key "%s"', (name, key) => {
    expect(isWeightTrackable(name)).toBe(true);
    expect(normalizeExerciseKey(name)).toBe(key);
  });

  const NON_TRACKABLE = [
    // Plyometric / power
    'Jump Squat bodyweight or light',
    'Squat Jumps',
    'Box Jumps',
    'Box Jumps low box',
    'Single-Leg Bounds',
    // Isometric / core
    'Front Plank',
    'Side Plank',
    'Plank',
    'Dead Bug',
    'Bird Dog',
    'Pallof Press',
    'Banded Clamshells',
    'Wall Sit',
    'Core circuit: 30s plank + 20s each side plank',
    // Eccentric bodyweight
    'Nordic Curl assisted',
    // Explicitly bodyweight lower-body (no load to remember)
    'Bodyweight Squat',
    'Lunges bodyweight',
    'Walking Lunges',
    'Reverse Lunge',
    'Calf Raises',                 // template never loads these (no marker)
    'Glute Bridge',                // beginner/novice bodyweight, no marker
    'Single-Leg Glute Bridge',
    'Step-Ups low box',
    // Upper-body WITHOUT a load marker (injury-rehab variants) — must NOT track,
    // so rehab-light loads never pollute a lift's est-1RM trend.
    'Dumbbell Row',                // injury rehab, no @% marker
    'Biceps Curl (light)',         // injury rehab
    'Single-Arm Press (light)',    // not a loadable pattern anyway
    'Band Pull-Apart',
  ];

  it.each(NON_TRACKABLE)('"%s" is not trackable -> key ""', (name) => {
    expect(isWeightTrackable(name)).toBe(false);
    expect(normalizeExerciseKey(name)).toBe('');
  });

  it('squat variants stay distinct (do not blend)', () => {
    const keys = new Set([
      normalizeExerciseKey('Back Squat @80% 1RM'),
      normalizeExerciseKey('Front Squat @85% 1RM'),
      normalizeExerciseKey('Goblet Squat @50% 1RM'),
    ]);
    expect(keys.size).toBe(3);
  });
});

describe('injury-strength vocabulary yields no trackable lifts', () => {
  // Names post-parse (parentheticals stripped). All injury work is submaximal /
  // bodyweight / band, so nothing should be weight-tracked.
  const INJURY_NAMES = [
    'Bodyweight Squat', 'Reverse Lunge', 'Step-Ups', 'Single-Leg RDL',
    'Banded Hip Abduction', 'Standing Calf Raises', 'Wall Sit',
    'Hamstring Slider Curl', 'Glute Bridge', 'Single-Leg Glute Bridge',
    'Band Pull-Apart', 'Band Face Pull', 'Dumbbell Row', 'Single-Arm Press',
    'Incline Push-Up', 'Biceps Curl', 'Suitcase Carry', 'Dead Bug',
    'Heel Taps', 'Hollow Hold', 'Supine Marches', 'Front Plank', 'Side Plank',
    'Pallof Press', 'Bird Dog',
  ];
  it.each(INJURY_NAMES)('"%s" not trackable', (name) => {
    expect(isWeightTrackable(name)).toBe(false);
  });
});

describe('cleanExerciseName', () => {
  it('strips the @X% 1RM garnish', () => {
    expect(cleanExerciseName('Back Squat @80% 1RM')).toBe('Back Squat');
    expect(cleanExerciseName('Single-Leg RDL @40% 1RM')).toBe('Single-Leg RDL');
    expect(cleanExerciseName('Goblet Squat @ 55 % 1rm')).toBe('Goblet Squat');
  });
  it('leaves clean names untouched', () => {
    expect(cleanExerciseName('Front Plank')).toBe('Front Plank');
    expect(cleanExerciseName('Glute Bridge')).toBe('Glute Bridge');
  });
});

// ── Epley estimate ───────────────────────────────────────────────────────────

describe('estimate1RM (Epley)', () => {
  it('matches the formula w*(1+reps/30)', () => {
    expect(estimate1RM(100, 5)).toBeCloseTo(100 * (1 + 5 / 30), 6);
    expect(estimate1RM(60, 8)).toBeCloseTo(60 * (1 + 8 / 30), 6);
  });
  it('caps the rep term at EPLEY_REP_CAP', () => {
    const capped = estimate1RM(50, 20);
    expect(capped).toBeCloseTo(50 * (1 + EPLEY_REP_CAP / 30), 6);
    expect(estimate1RM(50, 20)).toBe(estimate1RM(50, EPLEY_REP_CAP));
  });
  it('guards non-positive / NaN input', () => {
    expect(estimate1RM(0, 5)).toBe(0);
    expect(estimate1RM(100, 0)).toBe(0);
    expect(estimate1RM(100, NaN)).toBe(0);
    expect(estimate1RM(NaN, 5)).toBe(0);
    expect(estimate1RM(-50, 5)).toBe(0);
  });
});

describe('plateRound', () => {
  it('rounds to the nearest 2.5kg', () => {
    expect(plateRound(61)).toBe(60);     // 24.4 -> 24
    expect(plateRound(61.2)).toBe(60);   // 24.48 -> 24
    expect(plateRound(63.7)).toBe(62.5); // 25.48 -> 25
    expect(plateRound(64)).toBe(65);     // 25.6 -> 26
  });
});

// ── Phase-gated progression ──────────────────────────────────────────────────

describe('suggestNextWeight — phase gating', () => {
  const base = (over: Partial<NextWeightArgs> = {}): NextWeightArgs => ({
    lastWeightKg: 100,
    lastRir: 'reps-left',
    phase: 'base',
    isDeload: false,
    injuryKind: 'normal',
    ...over,
  });

  it('bumps in base/build when reps left (2.5%, rounded, min one plate)', () => {
    const r = suggestNextWeight(base({ phase: 'base' }));
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('bump');
    // 100 * 0.025 = 2.5 -> +2.5
    expect(r.weightKg).toBe(102.5);
    expect(suggestNextWeight(base({ phase: 'build' })).changed).toBe(true);
  });

  it('a light lift still bumps by at least one plate', () => {
    const r = suggestNextWeight(base({ lastWeightKg: 40 })); // 40*0.025=1 -> min 2.5
    expect(r.weightKg).toBe(42.5);
  });

  it('holds in peak even with reps left', () => {
    const r = suggestNextWeight(base({ phase: 'peak' }));
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('hold');
    expect(r.weightKg).toBe(100);
  });

  it('holds in taper and on deload weeks', () => {
    expect(suggestNextWeight(base({ phase: 'taper' })).changed).toBe(false);
    expect(suggestNextWeight(base({ isDeload: true })).changed).toBe(false);
  });

  it('never bumps on "about right" or "barely"', () => {
    expect(suggestNextWeight(base({ lastRir: 'about-right' })).changed).toBe(false);
    expect(suggestNextWeight(base({ lastRir: 'barely' })).changed).toBe(false);
    expect(suggestNextWeight(base({ lastRir: undefined })).changed).toBe(false);
  });

  it('suppresses under injury (adapted or paused) regardless of phase/RIR', () => {
    expect(suggestNextWeight(base({ injuryKind: 'adapted' })).reason).toBe('suppressed');
    expect(suggestNextWeight(base({ injuryKind: 'none' })).reason).toBe('suppressed');
    expect(suggestNextWeight(base({ injuryKind: 'adapted' })).changed).toBe(false);
  });

  it('holds when there is no prior weight', () => {
    const r = suggestNextWeight(base({ lastWeightKg: 0 }));
    expect(r.changed).toBe(false);
  });
});

// ── History append ───────────────────────────────────────────────────────────

describe('appendEst1rmSample', () => {
  const mk = (): StrengthLiftEntry => ({
    key: 'back-squat', displayName: 'Back Squat',
    lastWeightKg: 100, lastReps: '5', lastDate: '2026-01-01',
  });

  it('appends the first sample', () => {
    const e = mk();
    appendEst1rmSample(e, 116.7);
    expect(e.est1rmHistory).toHaveLength(1);
    expect(e.est1rmHistory![0].value).toBe(116.7);
  });

  it('replaces today\'s entry rather than piling up', () => {
    const e = mk();
    appendEst1rmSample(e, 116.7);
    appendEst1rmSample(e, 120);
    expect(e.est1rmHistory).toHaveLength(1);
    expect(e.est1rmHistory![0].value).toBe(120);
  });

  it('ignores non-finite / non-positive values', () => {
    const e = mk();
    appendEst1rmSample(e, 0);
    appendEst1rmSample(e, NaN);
    expect(e.est1rmHistory ?? []).toHaveLength(0);
  });
});
