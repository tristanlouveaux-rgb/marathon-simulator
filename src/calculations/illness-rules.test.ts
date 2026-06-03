/**
 * Unit tests for illness classification + schedule.
 * Covers the branch matrix that drives the user-facing recovery prescription.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyIllness, buildSchedule, getTodayCapacity,
  summariseSchedule, deriveLegacySeverity, shouldSuppressStrength,
  resolveEffectiveEntry, detectRaceCollision, computeRhrDeltaFromHistory,
  classifyWorkoutKind, applyIllnessMods,
  type ScheduleEntry,
} from './illness-rules';

// ─── classifyIllness ─────────────────────────────────────────────────────────

describe('classifyIllness', () => {
  it('runny nose + sore throat → above-neck, mild', () => {
    const c = classifyIllness({
      illnessType: 'head_cold',
      symptoms: ['runny_nose', 'sore_throat'],
      severity1to10: 2,
      rhrDeltaBpm: 1,
    });
    expect(c.neckRule).toBe('above');
    expect(c.severityTier).toBe('mild');
    expect(c.hasSystemic).toBe(false);
    expect(c.rhrFlag).toBe('normal');
  });

  it('cough alone → below-neck (chest involvement)', () => {
    const c = classifyIllness({
      illnessType: 'head_cold',
      symptoms: ['cough'],
      severity1to10: 4,
      rhrDeltaBpm: null,
    });
    expect(c.neckRule).toBe('below');
    expect(c.hasSystemic).toBe(false);
  });

  it('fever forces below-neck + systemic regardless of other selections', () => {
    const c = classifyIllness({
      illnessType: 'head_cold',  // user mis-selected as head cold
      symptoms: ['fever', 'runny_nose'],
      severity1to10: 7,
      rhrDeltaBpm: 8,
    });
    expect(c.neckRule).toBe('below');
    expect(c.hasSystemic).toBe(true);
    expect(c.severityTier).toBe('severe');
    expect(c.rhrFlag).toBe('elevated');
  });

  it('body aches alone → systemic, below-neck', () => {
    const c = classifyIllness({
      illnessType: 'other',
      symptoms: ['body_aches'],
      severity1to10: 5,
      rhrDeltaBpm: 0,
    });
    expect(c.hasSystemic).toBe(true);
    expect(c.neckRule).toBe('below');
    expect(c.severityTier).toBe('moderate');
  });

  it('illnessType=flu_chest forces below-neck even with above-neck symptoms only', () => {
    const c = classifyIllness({
      illnessType: 'flu_chest',
      symptoms: ['sore_throat'],
      severity1to10: 5,
      rhrDeltaBpm: null,
    });
    expect(c.neckRule).toBe('below');
    expect(c.hasSystemic).toBe(false);
  });

  it('RHR delta thresholds: ≥10 high, ≥5 elevated, else normal', () => {
    const base = {
      illnessType: 'head_cold' as const,
      symptoms: ['runny_nose'] as const,
      severity1to10: 3,
    };
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], rhrDeltaBpm: 12 }).rhrFlag).toBe('high');
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], rhrDeltaBpm: 10 }).rhrFlag).toBe('high');
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], rhrDeltaBpm: 7  }).rhrFlag).toBe('elevated');
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], rhrDeltaBpm: 5  }).rhrFlag).toBe('elevated');
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], rhrDeltaBpm: 4  }).rhrFlag).toBe('normal');
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], rhrDeltaBpm: -3 }).rhrFlag).toBe('normal');
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], rhrDeltaBpm: null }).rhrFlag).toBe('normal');
  });

  it('severity tier breakpoints: ≤3 mild, ≤6 moderate, >6 severe', () => {
    const base = {
      illnessType: 'head_cold' as const,
      symptoms: ['runny_nose'] as const,
      rhrDeltaBpm: null,
    };
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], severity1to10: 1 }).severityTier).toBe('mild');
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], severity1to10: 3 }).severityTier).toBe('mild');
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], severity1to10: 4 }).severityTier).toBe('moderate');
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], severity1to10: 6 }).severityTier).toBe('moderate');
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], severity1to10: 7 }).severityTier).toBe('severe');
    expect(classifyIllness({ ...base, symptoms: [...base.symptoms], severity1to10: 10 }).severityTier).toBe('severe');
  });
});

// ─── buildSchedule ───────────────────────────────────────────────────────────

describe('buildSchedule', () => {
  it('above-neck mild + day 1-2 → 1 remaining easy_only day at 0.85 + 1 reduced step-back', () => {
    // acuteTotalDays=2 (default for mild), elapsed=1 → remaining=1 → schedule = 1 easy_only + 1 reduced
    const c = classifyIllness({
      illnessType: 'head_cold',
      symptoms: ['runny_nose'],
      severity1to10: 2,
      rhrDeltaBpm: 1,
    });
    const schedule = buildSchedule(c, '1-2');
    expect(schedule).toHaveLength(2);
    expect(schedule[0].capacity).toBe('easy_only');
    expect(schedule[0].volumeFactor).toBe(0.85);
    expect(schedule[0].intensityCeiling).toBe('easy');
    expect(schedule[1].capacity).toBe('reduced');
    expect(schedule[1].volumeFactor).toBe(0.95);
  });

  it('above-neck severe → 4-day acute window + 1 step-back; volume factor 0.60', () => {
    const c = classifyIllness({
      illnessType: 'head_cold',
      symptoms: ['runny_nose'],
      severity1to10: 9,
      rhrDeltaBpm: 0,
    });
    const schedule = buildSchedule(c, '1-2');
    expect(schedule).toHaveLength(4);                   // remaining=3 + 1 step-back
    expect(schedule[0].volumeFactor).toBe(0.60);
    expect(schedule[0].capacity).toBe('easy_only');
  });

  it('above-neck high RHR forces day-0 rest', () => {
    const c = classifyIllness({
      illnessType: 'head_cold',
      symptoms: ['runny_nose', 'sore_throat'],
      severity1to10: 4,
      rhrDeltaBpm: 12,
    });
    const schedule = buildSchedule(c, '1-2');
    expect(schedule[0].capacity).toBe('rest');
    expect(schedule[0].volumeFactor).toBe(0);
    // Subsequent days continue with easy_only, since the user only stays above-neck.
    expect(schedule[1].capacity).toBe('easy_only');
  });

  it('below-neck non-systemic + day 1-2 → 6 rest days + 4-day ramp 0.5/0.7/0.85/1.0', () => {
    const c = classifyIllness({
      illnessType: 'flu_chest',
      symptoms: ['cough'],
      severity1to10: 5,
      rhrDeltaBpm: 3,
    });
    const schedule = buildSchedule(c, '1-2');
    const restDays = schedule.filter(e => e.capacity === 'rest').length;
    const rampDays = schedule.filter(e => e.capacity === 'reduced').length;
    const fullDays = schedule.filter(e => e.capacity === 'full').length;
    expect(restDays).toBe(6);                       // acuteTotal=7, elapsed=1 → 6 remaining
    expect(rampDays).toBe(3);                       // last ramp entry hits 1.0 → 'full', not 'reduced'
    expect(fullDays).toBe(1);
    expect(schedule.find(e => e.dateOffsetDays === 6)?.capacity).toBe('reduced');
    expect(schedule.find(e => e.dateOffsetDays === 9)?.capacity).toBe('full');
    expect(schedule.find(e => e.dateOffsetDays === 9)?.volumeFactor).toBe(1.0);
  });

  it('below-neck systemic (fever) gets the longer 10-day acute window + 5-day ramp', () => {
    const c = classifyIllness({
      illnessType: 'flu_chest',
      symptoms: ['fever', 'cough', 'body_aches'],
      severity1to10: 8,
      rhrDeltaBpm: 10,
    });
    const schedule = buildSchedule(c, '1-2');
    const restDays = schedule.filter(e => e.capacity === 'rest').length;
    expect(restDays).toBe(9); // 10 - 1 elapsed
    expect(schedule).toHaveLength(9 + 5);
    expect(schedule[schedule.length - 1].volumeFactor).toBe(1.0);
  });

  it('dayOfSymptoms shifts schedule forward', () => {
    const c = classifyIllness({
      illnessType: 'flu_chest',
      symptoms: ['cough'],
      severity1to10: 5,
      rhrDeltaBpm: 0,
    });
    const day12 = buildSchedule(c, '1-2');
    const day35 = buildSchedule(c, '3-5');
    const day6p = buildSchedule(c, '6+');
    const restCount = (s: typeof day12) => s.filter(e => e.capacity === 'rest').length;
    expect(restCount(day12)).toBe(6);  // 7 - 1
    expect(restCount(day35)).toBe(3);  // 7 - 4
    expect(restCount(day6p)).toBe(1);  // max(1, 7-7) = 1, floor at 1 day
  });

  it('schedule never has zero acute days even when elapsed exceeds total', () => {
    const c = classifyIllness({
      illnessType: 'flu_chest',
      symptoms: ['cough'],
      severity1to10: 3,
      rhrDeltaBpm: 0,
    });
    const schedule = buildSchedule(c, '6+');
    expect(schedule[0]).toBeDefined();
    expect(schedule[0].dateOffsetDays).toBe(0);
  });
});

// ─── getTodayCapacity ────────────────────────────────────────────────────────

describe('getTodayCapacity', () => {
  const schedule = [
    { dateOffsetDays: 0, capacity: 'rest'     as const, volumeFactor: 0,    intensityCeiling: 'rest' as const },
    { dateOffsetDays: 1, capacity: 'reduced'  as const, volumeFactor: 0.7,  intensityCeiling: 'easy' as const },
    { dateOffsetDays: 2, capacity: 'full'     as const, volumeFactor: 1.0,  intensityCeiling: 'full' as const },
  ];

  it('today = startDate returns offset 0', () => {
    const r = getTodayCapacity(schedule, '2026-05-13', '2026-05-13');
    expect(r?.capacity).toBe('rest');
  });

  it('today = startDate + 1 returns offset 1', () => {
    const r = getTodayCapacity(schedule, '2026-05-13', '2026-05-14');
    expect(r?.capacity).toBe('reduced');
  });

  it('past schedule end returns null', () => {
    const r = getTodayCapacity(schedule, '2026-05-13', '2026-05-17');
    expect(r).toBeNull();
  });

  it('today before startDate returns null (defensive)', () => {
    const r = getTodayCapacity(schedule, '2026-05-13', '2026-05-12');
    expect(r).toBeNull();
  });

  it('empty schedule returns null', () => {
    expect(getTodayCapacity([], '2026-05-13', '2026-05-13')).toBeNull();
    expect(getTodayCapacity(undefined, '2026-05-13', '2026-05-13')).toBeNull();
  });
});

// ─── summariseSchedule + helpers ─────────────────────────────────────────────

describe('summariseSchedule', () => {
  it('below-neck systemic mentions the extended window', () => {
    const c = classifyIllness({
      illnessType: 'flu_chest',
      symptoms: ['fever'],
      severity1to10: 8,
      rhrDeltaBpm: 10,
    });
    const schedule = buildSchedule(c, '1-2');
    const lines = summariseSchedule(c, schedule);
    expect(lines.some(l => /Systemic/i.test(l))).toBe(true);
    expect(lines.some(l => /rest/i.test(l))).toBe(true);
  });

  it('above-neck high-RHR mentions elevated HR and today as rest', () => {
    const c = classifyIllness({
      illnessType: 'head_cold',
      symptoms: ['runny_nose'],
      severity1to10: 4,
      rhrDeltaBpm: 12,
    });
    const schedule = buildSchedule(c, '1-2');
    const lines = summariseSchedule(c, schedule);
    expect(lines.some(l => /Resting HR/.test(l))).toBe(true);
  });
});

describe('deriveLegacySeverity', () => {
  it('rest day 0 → resting', () => {
    expect(deriveLegacySeverity([{ dateOffsetDays: 0, capacity: 'rest', volumeFactor: 0, intensityCeiling: 'rest' }])).toBe('resting');
  });
  it('easy_only day 0 → light', () => {
    expect(deriveLegacySeverity([{ dateOffsetDays: 0, capacity: 'easy_only', volumeFactor: 0.85, intensityCeiling: 'easy' }])).toBe('light');
  });
});

describe('shouldSuppressStrength', () => {
  it('below-neck classification → true', () => {
    expect(shouldSuppressStrength({ neckRule: 'below', severityTier: 'moderate', hasSystemic: false, rhrFlag: 'normal' })).toBe(true);
  });
  it('above-neck classification → false', () => {
    expect(shouldSuppressStrength({ neckRule: 'above', severityTier: 'mild', hasSystemic: false, rhrFlag: 'normal' })).toBe(false);
  });
  it('undefined classification → false', () => {
    expect(shouldSuppressStrength(undefined)).toBe(false);
  });
});

// ─── resolveEffectiveEntry ───────────────────────────────────────────────────

describe('resolveEffectiveEntry', () => {
  const easyEntry: ScheduleEntry = { dateOffsetDays: 0, capacity: 'easy_only', volumeFactor: 0.85, intensityCeiling: 'easy' };
  const reducedEntry: ScheduleEntry = { dateOffsetDays: 0, capacity: 'reduced', volumeFactor: 0.7, intensityCeiling: 'steady' };
  const restEntry: ScheduleEntry = { dateOffsetDays: 0, capacity: 'rest', volumeFactor: 0, intensityCeiling: 'rest' };

  it('no override → schedule unchanged', () => {
    expect(resolveEffectiveEntry(easyEntry, undefined)).toBe(easyEntry);
    expect(resolveEffectiveEntry(null, undefined)).toBeNull();
  });

  it('override rest → forces rest entry', () => {
    const r = resolveEffectiveEntry(easyEntry, 'rest');
    expect(r?.capacity).toBe('rest');
    expect(r?.volumeFactor).toBe(0);
  });

  it('override walks → maps to rest (no scheduled workout)', () => {
    const r = resolveEffectiveEntry(reducedEntry, 'walks');
    expect(r?.capacity).toBe('rest');
  });

  it('override easy_only vs schedule reduced → easy_only wins', () => {
    const r = resolveEffectiveEntry(reducedEntry, 'easy_only');
    expect(r?.capacity).toBe('easy_only');
    expect(r?.intensityCeiling).toBe('easy');
    expect(r?.volumeFactor).toBe(0.7);   // inherits engine volume
  });

  it('override easy_only vs schedule rest → engine wins (rest more restrictive)', () => {
    const r = resolveEffectiveEntry(restEntry, 'easy_only');
    expect(r).toBe(restEntry);
  });

  it('override rest vs null schedule → still rests', () => {
    const r = resolveEffectiveEntry(null, 'rest');
    expect(r?.capacity).toBe('rest');
  });

  it('override easy_only vs null schedule → easy_only synthetic', () => {
    const r = resolveEffectiveEntry(null, 'easy_only');
    expect(r?.capacity).toBe('easy_only');
    expect(r?.volumeFactor).toBe(0.85);
  });
});

// ─── detectRaceCollision ─────────────────────────────────────────────────────

describe('detectRaceCollision', () => {
  const schedule: ScheduleEntry[] = [
    { dateOffsetDays: 0, capacity: 'rest', volumeFactor: 0, intensityCeiling: 'rest' },
    { dateOffsetDays: 1, capacity: 'rest', volumeFactor: 0, intensityCeiling: 'rest' },
    { dateOffsetDays: 2, capacity: 'reduced', volumeFactor: 0.7, intensityCeiling: 'easy' },
    { dateOffsetDays: 3, capacity: 'full', volumeFactor: 1, intensityCeiling: 'full' },
  ];

  it('null raceDate returns null', () => {
    expect(detectRaceCollision(null, '2026-05-13', schedule)).toBeNull();
  });

  it('empty schedule returns null', () => {
    expect(detectRaceCollision('2026-05-15', '2026-05-13', [])).toBeNull();
    expect(detectRaceCollision('2026-05-15', '2026-05-13', undefined)).toBeNull();
  });

  it('race on a rest day → acute phase', () => {
    const r = detectRaceCollision('2026-05-14', '2026-05-13', schedule, '2026-05-13');
    expect(r?.phase).toBe('acute');
  });

  it('race on a reduced day → ramp phase', () => {
    const r = detectRaceCollision('2026-05-15', '2026-05-13', schedule, '2026-05-13');
    expect(r?.phase).toBe('ramp');
  });

  it('race past schedule end → safe', () => {
    const r = detectRaceCollision('2026-05-20', '2026-05-13', schedule, '2026-05-13');
    expect(r?.phase).toBe('safe');
  });
});

// ─── computeRhrDeltaFromHistory ──────────────────────────────────────────────

describe('computeRhrDeltaFromHistory', () => {
  it('returns null when fewer than 5 entries', () => {
    expect(computeRhrDeltaFromHistory([])).toBeNull();
    expect(computeRhrDeltaFromHistory([
      { date: '2026-05-12', restingHR: 50 },
    ])).toBeNull();
  });

  it('returns null when undefined history', () => {
    expect(computeRhrDeltaFromHistory(undefined)).toBeNull();
  });

  it('returns rounded latest minus baseline when enough data', () => {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const history = [
      { date: '2026-04-15', restingHR: 50 },
      { date: '2026-04-16', restingHR: 50 },
      { date: '2026-04-17', restingHR: 50 },
      { date: '2026-04-18', restingHR: 50 },
      { date: '2026-04-19', restingHR: 50 },
      { date: yesterday, restingHR: 50 },
      { date: today, restingHR: 60 },
    ];
    expect(computeRhrDeltaFromHistory(history)).toBe(10);
  });

  it('returns null if latest entry is older than 3 days', () => {
    const stale = '2026-04-01';
    const history = Array.from({ length: 8 }, (_, i) => ({ date: stale, restingHR: 50 + i }));
    expect(computeRhrDeltaFromHistory(history)).toBeNull();
  });
});

// ─── classifyWorkoutKind ─────────────────────────────────────────────────────

describe('classifyWorkoutKind', () => {
  it('walk/yoga/rest are rest_like regardless of capacity', () => {
    expect(classifyWorkoutKind({ t: 'walk', n: 'Walk', d: '20min' })).toBe('rest_like');
    expect(classifyWorkoutKind({ t: 'yoga', n: 'Yoga', d: '' })).toBe('rest_like');
    expect(classifyWorkoutKind({ t: 'rest', n: 'Rest', d: '' })).toBe('rest_like');
  });

  it('bike_endurance / bike_threshold → bike', () => {
    expect(classifyWorkoutKind({ t: 'bike_endurance', n: 'Bike', d: '60min' })).toBe('bike');
    expect(classifyWorkoutKind({ t: 'bike_threshold', n: 'Bike', d: '60min' })).toBe('bike');
  });

  it('swim type → swim', () => {
    expect(classifyWorkoutKind({ t: 'swim_endurance', n: 'Swim', d: '2km' })).toBe('swim');
  });

  it('hyrox_station, hyrox_brick, hyrox_assessment → strength', () => {
    expect(classifyWorkoutKind({ t: 'hyrox_station_density', n: 'Station Density', d: '' })).toBe('strength');
    expect(classifyWorkoutKind({ t: 'hyrox_brick', n: 'HYROX Brick', d: '' })).toBe('strength');
    expect(classifyWorkoutKind({ t: 'hyrox_assessment', n: 'HYROX Assessment', d: '' })).toBe('strength');
    expect(classifyWorkoutKind({ t: 'hyrox_mini_brick', n: 'Mini Brick', d: '' })).toBe('strength');
  });

  it('strength/gym/lift type → strength', () => {
    expect(classifyWorkoutKind({ t: 'strength', n: 'Strength', d: '' })).toBe('strength');
    expect(classifyWorkoutKind({ t: 'gym', n: 'Gym', d: '' })).toBe('gym' === 'gym' ? 'strength' : 'strength');
  });

  it('plain run with km → run', () => {
    expect(classifyWorkoutKind({ t: 'easy', n: 'Easy', d: '8km easy pace' })).toBe('run');
    expect(classifyWorkoutKind({ t: 'long', n: 'Long Run', d: '15km' })).toBe('run');
    expect(classifyWorkoutKind({ t: 'threshold', n: 'Threshold', d: '8km incl 4x1km @ thr' })).toBe('run');
  });

  it('padel / climb / tennis with no km → other', () => {
    expect(classifyWorkoutKind({ t: 'padel', n: 'Padel', d: '' })).toBe('other');
    expect(classifyWorkoutKind({ t: 'climb', n: 'Climb', d: '' })).toBe('other');
    expect(classifyWorkoutKind({ t: 'tennis', n: 'Tennis', d: '' })).toBe('other');
  });

  it('"easy run + gym after" name is not flagged as strength', () => {
    // type 'easy' decides this before name-based strength matching.
    expect(classifyWorkoutKind({ t: 'easy', n: 'Easy run before gym', d: '6km easy' })).toBe('run');
  });
});

// ─── applyIllnessMods ────────────────────────────────────────────────────────
//
// All tests fix the startDate to a known ISO and pass todayISO so date math
// is deterministic without faking timers.

describe('applyIllnessMods', () => {
  const today = '2026-05-13';
  const baseIllness = {
    startDate: today,
    severity: 'light' as const,
    active: true,
    classification: { neckRule: 'above' as const, severityTier: 'mild' as const, hasSystemic: false, rhrFlag: 'normal' as const },
    schedule: [
      { dateOffsetDays: 0, capacity: 'easy_only' as const, volumeFactor: 0.85, intensityCeiling: 'easy' as const },
    ],
  };

  it('rest capacity rests run/bike/swim/strength but skips walk', () => {
    const illness = { ...baseIllness,
      classification: { ...baseIllness.classification, neckRule: 'below' as const },
      schedule: [{ dateOffsetDays: 0, capacity: 'rest' as const, volumeFactor: 0, intensityCeiling: 'rest' as const }],
    };
    const workouts = [
      { t: 'easy', n: 'Easy', d: '8km easy', r: 4 },
      { t: 'bike_endurance', n: 'Bike', d: '60min Z2', r: 4 },
      { t: 'swim_endurance', n: 'Swim', d: '2km', r: 3 },
      { t: 'strength', n: 'Strength', d: '45min', r: 5 },
      { t: 'walk', n: 'Walk', d: '20min', r: 1 },
    ];
    applyIllnessMods(workouts, illness, today);
    expect(workouts[0].d).toBe('Rest — illness');
    expect(workouts[1].d).toBe('Rest — illness');
    expect(workouts[2].d).toBe('Rest — illness');
    expect(workouts[3].d).toBe('Rest — illness');
    expect(workouts[4].d).toBe('20min');                // walk untouched
  });

  it('easy_only capacity scales km and downgrades quality run to easy', () => {
    const workouts = [
      { t: 'threshold', n: 'Threshold', d: '10km incl 4x1km', r: 8 },
      { t: 'easy',      n: 'Easy',      d: '8km easy pace',  r: 4 },
    ];
    applyIllnessMods(workouts, baseIllness, today);
    expect(workouts[0].t).toBe('easy');                 // quality downgraded
    expect(workouts[0].d).toBe('8.5km easy pace');      // 10 × 0.85 = 8.5
    expect(workouts[1].d).toBe('7km easy pace');        // 8 × 0.85 = 6.8 → 7 (rounded to 0.5)
  });

  it('reduced capacity with steady ceiling preserves intensity intent', () => {
    const illness = { ...baseIllness, schedule: [{ dateOffsetDays: 0, capacity: 'reduced' as const, volumeFactor: 0.7, intensityCeiling: 'steady' as const }] };
    const workouts = [{ t: 'tempo', n: 'Tempo', d: '10km tempo', r: 7 }];
    applyIllnessMods(workouts, illness, today);
    expect(workouts[0].d).toBe('7km steady pace');      // 10 × 0.7 = 7, steady ceiling
    expect(workouts[0].t).toBe('tempo');                 // not downgraded since ceiling = steady
  });

  it('reduced + full ceiling: scale only, no intensity downgrade', () => {
    const illness = { ...baseIllness, schedule: [{ dateOffsetDays: 0, capacity: 'reduced' as const, volumeFactor: 0.95, intensityCeiling: 'full' as const }] };
    const workouts = [{ t: 'threshold', n: 'Threshold', d: '10km', r: 8 }];
    applyIllnessMods(workouts, illness, today);
    expect(workouts[0].t).toBe('threshold');             // kept
    expect(workouts[0].d).toBe('9.5km easy pace');       // ceiling=full but copy uses 'easy' label per scaleAndCap fallback
  });

  it('full capacity → no mutation', () => {
    const illness = { ...baseIllness, schedule: [{ dateOffsetDays: 0, capacity: 'full' as const, volumeFactor: 1, intensityCeiling: 'full' as const }] };
    const workouts = [{ t: 'easy', n: 'Easy', d: '8km easy', r: 4 }];
    applyIllnessMods(workouts, illness, today);
    expect(workouts[0].d).toBe('8km easy');
    expect((workouts[0] as any).illnessMod).toBeUndefined();
  });

  it('below-neck classification suppresses strength even on ramp days', () => {
    const illness = { ...baseIllness,
      classification: { ...baseIllness.classification, neckRule: 'below' as const },
      schedule: [{ dateOffsetDays: 0, capacity: 'reduced' as const, volumeFactor: 0.7, intensityCeiling: 'steady' as const }],
    };
    const workouts = [
      { t: 'hyrox_brick', n: 'HYROX Brick', d: '1km run + stations', r: 8 },
      { t: 'strength',    n: 'Strength',    d: '45min',              r: 6 },
      { t: 'easy',        n: 'Easy',        d: '8km easy',           r: 4 },
    ];
    applyIllnessMods(workouts, illness, today);
    expect(workouts[0].d).toBe('Rest — illness');       // brick = strength → rest
    expect(workouts[1].d).toBe('Rest — illness');       // strength → rest
    expect(workouts[2].d).toBe('5.5km steady pace');    // 8 × 0.7 = 5.6 → 5.5 (rounded to nearest 0.5)
  });

  it("'other' workouts (padel etc) are left untouched outside rest capacity", () => {
    const workouts = [
      { t: 'padel', n: 'Padel', d: '90min hit-around', r: 5 },
      { t: 'climb', n: 'Climb', d: 'gym session',      r: 5 },
    ];
    applyIllnessMods(workouts, baseIllness, today);
    expect(workouts[0].d).toBe('90min hit-around');
    expect(workouts[1].d).toBe('gym session');
  });

  it('legacy state (no schedule, severity=resting) now rests ALL disciplines, not just runs', () => {
    const illness = { startDate: today, severity: 'resting' as const, active: true };
    const workouts = [
      { t: 'easy', n: 'Easy', d: '8km easy', r: 4 },
      { t: 'bike_endurance', n: 'Bike', d: '60min', r: 4 },
    ];
    applyIllnessMods(workouts, illness, today);
    expect(workouts[0].d).toBe('Rest — illness');
    // Fixed 2026-06-02: the legacy fallback now routes through
    // applyIllnessModsAllDisciplines, so bike/swim/strength are no longer left
    // at full load when a pre-v2 illness state has only a severity.
    expect(workouts[1].d).toBe('Rest — illness');
  });

  it('past schedule end → no mutation', () => {
    const illness = { ...baseIllness };
    const workouts = [{ t: 'easy', n: 'Easy', d: '8km easy', r: 4 }];
    applyIllnessMods(workouts, illness, '2026-05-20');   // 7 days past offset 0
    expect(workouts[0].d).toBe('8km easy');
  });

  it('userCapacityOverride=rest forces rest even on an easy_only schedule day', () => {
    const illness = { ...baseIllness, userCapacityOverride: 'rest' as const };
    const workouts = [{ t: 'easy', n: 'Easy', d: '8km easy', r: 4 }];
    applyIllnessMods(workouts, illness, today);
    expect(workouts[0].d).toBe('Rest — illness');
  });

  it('userCapacityOverride=easy_only against a reduced schedule day caps intensity', () => {
    const illness = { ...baseIllness,
      schedule: [{ dateOffsetDays: 0, capacity: 'reduced' as const, volumeFactor: 0.95, intensityCeiling: 'full' as const }],
      userCapacityOverride: 'easy_only' as const,
    };
    const workouts = [{ t: 'threshold', n: 'Threshold', d: '10km', r: 8 }];
    applyIllnessMods(workouts, illness, today);
    expect(workouts[0].t).toBe('easy');                  // downgrade kicks in once ceiling = easy via override
  });
});
