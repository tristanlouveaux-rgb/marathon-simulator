/**
 * Unit tests for coach-tools — validation, apply, undo, and the HYROX fix.
 * Network-free; runs as part of the default `npm test`.
 *
 * Tests use the live state store (singleton) seeded via setState/getDefaultState
 * before each test. applyPendingChange mutates that singleton in place.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateAndBuildPendingChange,
  applyPendingChange,
  undoPendingChange,
  MEMORY_FACT_MAX,
} from '../coach-tools';
import { getDefaultState, getMutableState, setState } from '../../state/store';
import type { Workout } from '../../types/state';

// ─── Test helpers ────────────────────────────────────────────────────────────

function tuesdaySwim(): Workout {
  return {
    n: 'Swim technique',
    d: '3300m total. 200m WU. 8x75m @ 2:10/100m. 200m CD.',
    t: 'swim_technique',
    r: 3,
    rpe: 3,
    discipline: 'swim',
    dayName: 'Tuesday',
    dayOfWeek: 1,
    aerobic: 30,
    anaerobic: 5,
    estimatedDurationMin: 66,
    status: 'planned',
  };
}

function seedTriWithSwim(): void {
  const s = getMutableState();
  s.eventType = 'triathlon';
  s.w = 1;
  if (!s.wks[0]) {
    s.wks[0] = { w: 1, ph: 'base' as any } as any;
  }
  s.wks[0].triWorkouts = [tuesdaySwim()];
}

function seedHyroxWithSwim(): void {
  const s = getMutableState();
  s.eventType = 'hyrox';
  s.w = 1;
  if (!s.wks[0]) {
    s.wks[0] = { w: 1, ph: 'base' as any } as any;
  }
  s.wks[0].triWorkouts = [tuesdaySwim()];
}

beforeEach(() => {
  setState(getDefaultState());
});

// ─── validateAndBuildPendingChange ───────────────────────────────────────────

describe('validateAndBuildPendingChange', () => {
  it('rejects invalid day', () => {
    seedTriWithSwim();
    const change = validateAndBuildPendingChange('reduce_workout', {
      day: 'fridayyy', workout_index: 0, reduction_pct: 30, reason: 'test',
    });
    expect(change).toBeNull();
  });

  it('rejects missing reason', () => {
    seedTriWithSwim();
    const change = validateAndBuildPendingChange('reduce_workout', {
      day: 'tuesday', workout_index: 0, reduction_pct: 30, reason: '',
    });
    expect(change).toBeNull();
  });

  it('rejects out-of-range reduction_pct', () => {
    seedTriWithSwim();
    expect(validateAndBuildPendingChange('reduce_workout', {
      day: 'tuesday', workout_index: 0, reduction_pct: 5, reason: 'r',
    })).toBeNull();
    expect(validateAndBuildPendingChange('reduce_workout', {
      day: 'tuesday', workout_index: 0, reduction_pct: 60, reason: 'r',
    })).toBeNull();
  });

  it('rejects invalid swap target', () => {
    seedTriWithSwim();
    const change = validateAndBuildPendingChange('swap_workout', {
      day: 'tuesday', workout_index: 0, new_type: 'invalid_type', reason: 'r',
    });
    expect(change).toBeNull();
  });

  it('rejects zone_cap outside 2|3', () => {
    seedTriWithSwim();
    expect(validateAndBuildPendingChange('adjust_intensity', {
      day: 'tuesday', workout_index: 0, zone_cap: 4, reason: 'r',
    })).toBeNull();
    expect(validateAndBuildPendingChange('adjust_intensity', {
      day: 'tuesday', workout_index: 0, zone_cap: 1, reason: 'r',
    })).toBeNull();
  });

  it('resolves by name when index is wrong but only one workout that day', () => {
    seedTriWithSwim();
    const change = validateAndBuildPendingChange('reduce_workout', {
      day: 'tuesday', workout_index: 7, workout_name: 'Swim technique', reduction_pct: 30, reason: 'r',
    });
    expect(change).not.toBeNull();
    expect(change?._workoutIdx).toBe(0);
  });

  it('rejects unknown tool name', () => {
    expect(validateAndBuildPendingChange('frobnicate', { day: 'tuesday', workout_index: 0, reason: 'r' })).toBeNull();
  });
});

describe('validateAndBuildPendingChange — memory tools', () => {
  it('builds a remember change with a sanitised fact', () => {
    const change = validateAndBuildPendingChange('remember', {
      fact: 'Athlete prefers Tuesday and Thursday for quality.',
      reason: 'Stated preference.',
    });
    expect(change?.tool).toBe('remember');
    expect(change?._params.fact).toBe('Athlete prefers Tuesday and Thursday for quality.');
    expect(change?._weekIdx).toBe(-1);
  });

  it('rejects remember with empty fact', () => {
    expect(validateAndBuildPendingChange('remember', { fact: '', reason: 'r' })).toBeNull();
  });

  it('rejects forget with out-of-range fact_index', () => {
    const s = getMutableState();
    s.coachMemory = { lastUpdatedISO: '', facts: [{ text: 'a', addedISO: '' }] };
    expect(validateAndBuildPendingChange('forget', { fact_index: 5, reason: 'r' })).toBeNull();
    expect(validateAndBuildPendingChange('forget', { fact_index: -1, reason: 'r' })).toBeNull();
  });

  it('builds a forget change when index is valid', () => {
    const s = getMutableState();
    s.coachMemory = { lastUpdatedISO: '', facts: [
      { text: 'fact A', addedISO: '' }, { text: 'fact B', addedISO: '' },
    ]};
    const change = validateAndBuildPendingChange('forget', { fact_index: 1, reason: 'no longer applies' });
    expect(change?.tool).toBe('forget');
    expect(change?._params.factIndex).toBe(1);
    expect(change?.headline).toContain('fact B');
  });
});

// ─── applyPendingChange — triathlon path ─────────────────────────────────────

describe('applyPendingChange — triathlon reduce_workout', () => {
  it('scales description + sets aiModifiedAt + reduces aerobic/anaerobic', () => {
    seedTriWithSwim();
    const before = (getMutableState().wks[0].triWorkouts as Workout[])[0];
    const beforeAerobic = before.aerobic ?? 0;

    const change = validateAndBuildPendingChange('reduce_workout', {
      day: 'tuesday', workout_index: 0, workout_name: 'Swim technique', reduction_pct: 30, reason: 'r',
    });
    expect(change).not.toBeNull();
    applyPendingChange(change!);

    const after = (getMutableState().wks[0].triWorkouts as Workout[])[0];
    expect(after.status).toBe('reduced');
    expect(after.aiModifiedAt).toBeTruthy();
    expect(after.aiPreModSnapshot).toBeTruthy();
    expect(after.n).toContain('reduced 30%');
    expect(after.aerobic).toBeLessThan(beforeAerobic);
    expect(after.d).not.toBe('3300m total. 200m WU. 8x75m @ 2:10/100m. 200m CD.');
    // Pace token (2:10/100m) must NOT be scaled
    expect(after.d).toContain('/100m');
  });
});

describe('applyPendingChange — triathlon swap_workout', () => {
  it('replaces type, description, and zeros anaerobic', () => {
    seedTriWithSwim();
    const change = validateAndBuildPendingChange('swap_workout', {
      day: 'tuesday', workout_index: 0, workout_name: 'Swim technique', new_type: 'rest', reason: 'r',
    });
    applyPendingChange(change!);

    const after = (getMutableState().wks[0].triWorkouts as Workout[])[0];
    expect(after.t).toBe('rest');
    expect(after.status).toBe('skipped'); // rest swap becomes skipped
    expect(after.anaerobic).toBe(0);
    expect(after.aerobic).toBe(0);
    expect(after.estimatedDurationMin).toBe(0);
    expect(after.aiModifiedAt).toBeTruthy();
  });
});

describe('applyPendingChange — triathlon adjust_intensity', () => {
  it('caps intensity, zeros anaerobic, trims aerobic', () => {
    seedTriWithSwim();
    const change = validateAndBuildPendingChange('adjust_intensity', {
      day: 'tuesday', workout_index: 0, zone_cap: 2, reason: 'r',
    });
    applyPendingChange(change!);

    const after = (getMutableState().wks[0].triWorkouts as Workout[])[0];
    expect(after.status).toBe('reduced');
    expect(after.anaerobic).toBe(0);
    expect(after.n).toContain('Z2 cap');
    expect(after.d.toLowerCase()).toContain('z2 cap');
    expect(after.aiModifiedAt).toBeTruthy();
  });
});

describe('applyPendingChange — triathlon skip_workout', () => {
  it('flips skipped flag + status, zeros loads', () => {
    seedTriWithSwim();
    const change = validateAndBuildPendingChange('skip_workout', {
      day: 'tuesday', workout_index: 0, reason: 'r',
    });
    applyPendingChange(change!);

    const after = (getMutableState().wks[0].triWorkouts as Workout[])[0];
    expect(after.skipped).toBe(true);
    expect(after.status).toBe('skipped');
    expect(after.aerobic).toBe(0);
    expect(after.anaerobic).toBe(0);
  });
});

// ─── applyPendingChange — HYROX path (regression for the P0 bug) ─────────────

describe('applyPendingChange — HYROX mutates triWorkouts (P0 regression)', () => {
  it('writes to wk.triWorkouts when eventType is hyrox', () => {
    seedHyroxWithSwim();
    const change = validateAndBuildPendingChange('reduce_workout', {
      day: 'tuesday', workout_index: 0, workout_name: 'Swim technique', reduction_pct: 30, reason: 'r',
    });
    applyPendingChange(change!);

    const s = getMutableState();
    // The fix: tri/hyrox both mutate wk.triWorkouts. The pre-fix bug pushed to workoutMods.
    const triw = s.wks[0].triWorkouts as Workout[];
    expect(triw[0].status).toBe('reduced');
    expect(triw[0].aiModifiedAt).toBeTruthy();
    // And the running-mods array should NOT have received anything.
    expect(s.wks[0].workoutMods ?? []).toHaveLength(0);
  });
});

// ─── applyPendingChange — running path ───────────────────────────────────────

describe('applyPendingChange — running pushes a workoutMod', () => {
  it('appends a WorkoutMod via name resolution when the engine produces a tempo run', () => {
    // The running validator calls generateWeekWorkouts(), which is heavy and
    // schedule-dependent. We use a lightweight resolveWorkout shortcut by
    // pushing a pre-built PendingChange directly: this exercises the apply
    // path (the bug surface) without depending on the engine output.
    const s = getMutableState();
    s.eventType = 'running' as any;
    s.w = 1;
    s.wks[0] = { w: 1, ph: 'base' as any, workoutMods: [] } as any;

    // Build the PendingChange shape directly (skipping the validator that
    // depends on the runtime workout-generator). The fields below match what
    // validateAndBuildPendingChange would produce for an adjust_intensity call.
    const directChange = {
      id: 'test-adjust-1',
      tool: 'adjust_intensity' as const,
      headline: 'Cap Tuesday workout at Zone 2',
      reason: 'Coach test reason',
      _weekIdx: 0,
      _workoutIdx: 0,
      _params: { day: 'tuesday', workoutIndex: 0, zoneCap: 2, workoutName: 'Tempo run' },
    };

    applyPendingChange(directChange);
    const mods = s.wks[0].workoutMods ?? [];
    expect(mods.length).toBe(1);
    const lastMod = mods[0];
    expect(lastMod.aiModifiedAt).toBeTruthy();
    expect(lastMod.zoneCap).toBe(2);
    expect(lastMod.status).toBe('reduced');
    expect(lastMod.newType).toBe('easy');
    expect(lastMod.newRpe).toBe(2);
  });
});

// ─── applyPendingChange — memory operations ──────────────────────────────────

describe('applyPendingChange — remember / forget', () => {
  it('appends a fact to coachMemory', () => {
    const change = validateAndBuildPendingChange('remember', {
      fact: 'Tuesday is quality day.', reason: 'r',
    });
    applyPendingChange(change!);
    const s = getMutableState();
    expect(s.coachMemory?.facts).toHaveLength(1);
    expect(s.coachMemory?.facts[0].text).toBe('Tuesday is quality day.');
  });

  it('caps at MEMORY_FACT_MAX, dropping oldest', () => {
    const s = getMutableState();
    s.coachMemory = {
      lastUpdatedISO: '',
      facts: Array.from({ length: MEMORY_FACT_MAX }, (_, i) => ({ text: `f${i}`, addedISO: '' })),
    };
    const change = validateAndBuildPendingChange('remember', { fact: 'NEWEST', reason: 'r' });
    applyPendingChange(change!);
    expect(s.coachMemory.facts).toHaveLength(MEMORY_FACT_MAX);
    expect(s.coachMemory.facts.find(f => f.text === 'f0')).toBeUndefined();
    expect(s.coachMemory.facts[s.coachMemory.facts.length - 1].text).toBe('NEWEST');
  });

  it('removes the indexed fact', () => {
    const s = getMutableState();
    s.coachMemory = { lastUpdatedISO: '', facts: [
      { text: 'keep me', addedISO: '' },
      { text: 'remove me', addedISO: '' },
    ]};
    const change = validateAndBuildPendingChange('forget', { fact_index: 1, reason: 'r' });
    applyPendingChange(change!);
    expect(s.coachMemory.facts).toHaveLength(1);
    expect(s.coachMemory.facts[0].text).toBe('keep me');
  });
});

// ─── undoPendingChange ───────────────────────────────────────────────────────

// ─── HYROX plan skeleton (P0 regression for the buildPlanSkeleton miss) ──────

describe('buildPlanSkeleton — HYROX uses the structured per-week shape (P0 regression)', () => {
  it('emits sessions counts + planned_tss for HYROX, not the bare running skeleton', async () => {
    const { buildPlanSkeleton } = await import('../coach-context-builder');
    const s = getMutableState();
    s.eventType = 'hyrox' as any;
    s.w = 1;
    s.wks[0] = {
      w: 1, ph: 'build' as any,
      triWorkouts: [
        { n: 'Stations', t: 'hyrox_station', discipline: 'station', d: '4 stations', r: 7, aerobic: 80, anaerobic: 20, estimatedDurationMin: 70 },
        { n: 'Easy run', t: 'easy_run', discipline: 'run', d: '8km easy', r: 3, aerobic: 30, anaerobic: 0, estimatedDurationMin: 42 },
      ],
    } as any;

    const skeleton = buildPlanSkeleton(s);
    expect(skeleton.length).toBeGreaterThan(0);
    const currentWeek = skeleton[0];
    // Structured fields present (would be absent if HYROX fell through to running branch)
    expect(currentWeek.sessions).toBeTruthy();
    expect(currentWeek.planned_tss).toBe(130);
    expect((currentWeek.sessions as any).run).toBe(1);
    expect((currentWeek.sessions as any).bike).toBe(0);
    expect(currentWeek.planned_hours).toBeCloseTo(112 / 60, 1);
  });
});

describe('undoPendingChange — round trip restores pre-mod fields', () => {
  it('restores triathlon workout after a reduce', () => {
    seedTriWithSwim();
    const before = JSON.parse(JSON.stringify((getMutableState().wks[0].triWorkouts as Workout[])[0]));

    const change = validateAndBuildPendingChange('reduce_workout', {
      day: 'tuesday', workout_index: 0, workout_name: 'Swim technique', reduction_pct: 30, reason: 'r',
    });
    applyPendingChange(change!);
    const ok = undoPendingChange(change!);
    expect(ok).toBe(true);

    const after = (getMutableState().wks[0].triWorkouts as Workout[])[0];
    expect(after.n).toBe(before.n);
    expect(after.d).toBe(before.d);
    expect(after.aerobic).toBe(before.aerobic);
    expect(after.anaerobic).toBe(before.anaerobic);
    expect(after.estimatedDurationMin).toBe(before.estimatedDurationMin);
    expect(after.status).toBe(before.status);
    expect(after.aiModifiedAt).toBeUndefined();
    expect(after.aiPreModSnapshot).toBeUndefined();
  });
});
