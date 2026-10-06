import { describe, it, expect } from 'vitest';
import { BIKE_INTENSITY_LADDER, SWIM_INTENSITY_LADDER } from './triathlon-constants';
import { intensityTargetLabel } from '@/ui/workout-adjust-overlay';
import type { Workout } from '@/types/state';
import { RUN_PACE_LADDER, runPaceRung, stepDownRunType, RUN_GENERATOR_RPE } from './intensity-ladder';
import { TSS_RPE_BY_TYPE } from './sports';
import { intentToWorkout, type SessionIntent } from '@/workouts/intent_to_workout';

describe('intensity ladders', () => {
  it('bike ladder is monotonically harder (ascending %FTP)', () => {
    for (let i = 1; i < BIKE_INTENSITY_LADDER.length; i++) {
      expect(BIKE_INTENSITY_LADDER[i].pct).toBeGreaterThan(BIKE_INTENSITY_LADDER[i - 1].pct);
    }
  });
  it('swim ladder is monotonically faster (descending sec/100m offset)', () => {
    for (let i = 1; i < SWIM_INTENSITY_LADDER.length; i++) {
      expect(SWIM_INTENSITY_LADDER[i].cssOffsetSec).toBeLessThan(SWIM_INTENSITY_LADDER[i - 1].cssOffsetSec);
    }
  });
});

describe('intensityTargetLabel', () => {
  const w = (intensityLevel?: string): Workout => ({ t: 'cross_training', n: 'Bike', d: '60 min', intensityLevel } as Workout);

  it('returns null when no rung is set', () => {
    expect(intensityTargetLabel(w(undefined), 250, 95)).toBeNull();
  });

  it('renders a bike watt range from FTP at the rung pct', () => {
    // bike_threshold: pct 1.00, band 0.05 → 250*1.00*(0.95..1.05) = 238–263W
    expect(intensityTargetLabel(w('bike_threshold'), 250, undefined)).toBe('Threshold · 238–263W');
  });

  it('renders a harder rung as more watts than an easier one', () => {
    const endurance = intensityTargetLabel(w('bike_endurance'), 250, undefined)!;
    const vo2 = intensityTargetLabel(w('bike_vo2'), 250, undefined)!;
    const wattsOf = (s: string) => parseInt(s.match(/(\d+)–/)![1], 10);
    expect(wattsOf(vo2)).toBeGreaterThan(wattsOf(endurance));
  });

  it('renders a swim pace from CSS + the rung offset', () => {
    // swim_threshold offset 0, css 95 sec/100m → 1:35/100m
    expect(intensityTargetLabel(w('swim_threshold'), undefined, 95)).toBe('CSS intervals · 1:35/100m');
    // swim_speed offset -6 → 89s → 1:29/100m (faster)
    expect(intensityTargetLabel(w('swim_speed'), undefined, 95)).toBe('Speed · 1:29/100m');
  });

  it('returns null for a bike rung when FTP is missing', () => {
    expect(intensityTargetLabel(w('bike_threshold'), undefined, undefined)).toBeNull();
  });
});

// ── Running pace ladder (one pace category down per step) ──────────────────


describe('running pace ladder', () => {
  it('puts every valued running type on the rung of its TSS valuation row', () => {
    // The ladder adds no classification of its own: each rung is one
    // TSS_RPE_BY_TYPE row (recovery 3, easy 4, marathon pace 6, threshold 7, vo2 8).
    for (const [type, row] of Object.entries(TSS_RPE_BY_TYPE)) {
      const rung = RUN_PACE_LADDER.findIndex(c => TSS_RPE_BY_TYPE[c] === row);
      expect(rung, type).toBeGreaterThanOrEqual(0);
      expect(runPaceRung(type), type).toBe(rung);
    }
  });

  it('steps every type exactly one category down per step, never up', () => {
    for (const type of Object.keys(TSS_RPE_BY_TYPE)) {
      const from = runPaceRung(type);
      const one = stepDownRunType(type, 1);
      const two = stepDownRunType(type, 2);
      expect(runPaceRung(one), type).toBe(Math.max(0, from - 1));
      expect(runPaceRung(two), type).toBe(Math.max(0, from - 2));
    }
  });

  it('names the categories below each session type', () => {
    expect(stepDownRunType('vo2', 1)).toBe('threshold');
    expect(stepDownRunType('threshold', 1)).toBe('marathon_pace');
    expect(stepDownRunType('float', 1)).toBe('marathon_pace');
    expect(stepDownRunType('marathon_pace', 1)).toBe('easy');
    expect(stepDownRunType('progressive', 1)).toBe('easy');
    expect(stepDownRunType('easy', 1)).toBe('recovery');
    expect(stepDownRunType('long', 1)).toBe('recovery');
    expect(stepDownRunType('recovery', 1)).toBe('recovery');
  });

  it('keeps the long-run slot a long run when it lands on the easy rung', () => {
    expect(stepDownRunType('progressive', 1, { longRun: true })).toBe('long');
    expect(stepDownRunType('progressive', 2, { longRun: true })).toBe('recovery');
    expect(stepDownRunType('long', 1, { longRun: true })).toBe('recovery');
  });

  it('leaves off-ladder types unchanged', () => {
    expect(stepDownRunType('cross', 1)).toBe('cross');
    expect(stepDownRunType('gym', 2)).toBe('gym');
    expect(runPaceRung('rest')).toBe(-1);
  });

  it('generator RPEs match what the plan generator prescribes for each type', () => {
    const intent = (slot: SessionIntent['slot'], extra: Partial<SessionIntent> = {}): SessionIntent => ({
      dayIndex: 0, slot, totalMinutes: 60, workMinutes: 20, variantId: 'x', notes: '', ...extra,
    });
    const gen = (i: SessionIntent) => intentToWorkout(i, 'marathon', 'Balanced', 330);
    expect(gen(intent('easy')).rpe).toBe(RUN_GENERATOR_RPE.easy);
    expect(gen(intent('long')).rpe).toBe(RUN_GENERATOR_RPE.long);
    const ff = gen(intent('long', { variantId: 'long_fast_finish' }));
    expect(ff.t).toBe('progressive');
    expect(ff.rpe).toBe(RUN_GENERATOR_RPE.progressive);
    expect(gen(intent('progressive')).rpe).toBe(RUN_GENERATOR_RPE.progressive);
    expect(gen(intent('marathon_pace')).rpe).toBe(RUN_GENERATOR_RPE.marathon_pace);
    expect(gen(intent('threshold')).rpe).toBe(RUN_GENERATOR_RPE.threshold);
    expect(gen(intent('vo2')).rpe).toBe(RUN_GENERATOR_RPE.vo2);
    expect(gen(intent('float', { reps: 6, repMinutes: 3, recoveryMinutes: 2 })).rpe).toBe(RUN_GENERATOR_RPE.float);
  });
});
