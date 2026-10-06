import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  planWeekSessions, isDeloadWeek, abilityBandFromVdot, isRaceWeek, longRunMinutes,
  longRunCeilingMin, LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST, LONG_RUN_LOOKBACK_WEEKS,
  type PlanContext,
} from './plan_engine';
import { computePlanPhases } from './phases';
import { generateWeekWorkouts, initializeWeeks } from './generator';
import { updateState, resetState } from '@/state';
import type { SimulatorState } from '@/types';
import { isLongRun } from './long-run';
import type { RaceDistance } from '@/types';
import type { Archetype } from '@/calculations/athlete-archetype';

/**
 * Whole-plan shape guard (2026-10-06).
 *
 * A sweep of 1,092 full running plans (marathon 8 to 20 weeks, half 4 to 16,
 * 3 to 6 runs a week, seven archetype/baseline cases, three abilities) found:
 *   1. Deload weeks heavier than the week before (554 plans), some with an extra
 *      quality session (129): the sessions took the deload multiplier but were
 *      fitted to a weekly budget that kept ramping through the deload.
 *   2. Long runs jumping more than 10% over the longest long run of the previous
 *      4 weeks (654 plans, up to +83%): the budget fit trimmed a long run and
 *      the next week released it, the ramp counted deload weeks, and the taper
 *      long run was 0.65 x the untrimmed ramp.
 *   3. A long run in every race week, scheduled on Sunday (race day).
 * This test replays a representative sample of that sweep through the real
 * engine and asserts the three properties on every plan. The 10% rule is
 * Frandsen et al. 2025 (BJSM), see LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST.
 */

const QUALITY = new Set(['threshold', 'vo2', 'marathon_pace', 'float']);

interface WeekRow {
  k: number;
  phase: string;
  deload: boolean;
  total: number;
  quality: number;
  long: number | null;
  sessions: string;
}

function planRows(ctx: Omit<PlanContext, 'weekIndex' | 'phase'>): WeekRow[] {
  const phases = computePlanPhases(ctx.totalWeeks).map(p => p.ph);
  const ability = abilityBandFromVdot(ctx.vdot, ctx.fitnessLevel);
  const rows: WeekRow[] = [];
  for (let k = 1; k <= ctx.totalWeeks; k++) {
    const xs = planWeekSessions({ ...ctx, weekIndex: k, phase: phases[k - 1] });
    rows.push({
      k,
      phase: phases[k - 1],
      deload: isDeloadWeek(k, ability),
      total: xs.reduce((a, i) => a + i.totalMinutes, 0),
      quality: xs.filter(i => QUALITY.has(i.slot)).length,
      long: xs.find(i => i.slot === 'long')?.totalMinutes ?? null,
      sessions: xs.map(i => `${i.slot}:${i.totalMinutes}`).join(' '),
    });
  }
  return rows;
}

const LENGTHS: Array<[RaceDistance, number[]]> = [
  ['marathon', [8, 10, 12, 16, 20]],
  ['half', [4, 8, 12, 16]],
  ['10k', [8, 12]],
];
const RUNS = [3, 4, 6];
const BASELINES: Array<[Archetype | undefined, number | undefined]> = [
  ['consistent-runner', 25],
  ['high-mileage', 60],
  ['detrained-with-history', 15],
  ['detrained-with-history', 20],
  ['unknown', 30],
  ['sedentary-novice', 8],
  [undefined, undefined],
];
const ABILITIES: Array<[string, number]> = [['novice', 38], ['intermediate', 45], ['advanced', 55]];
const HOURS: Array<number | undefined> = [undefined, 4];

interface Sample { label: string; rows: WeekRow[] }
let samples: Sample[] = [];

describe('whole-plan shape (representative sweep through planWeekSessions)', () => {
  beforeAll(() => {
    // applyHoursBudget warns when quality alone exceeds a tiny budget; expected here.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    samples = [];
    for (const [rd, lengths] of LENGTHS) for (const N of lengths) for (const rpw of RUNS)
      for (const [archetype, baselineKm] of BASELINES) for (const [fitnessLevel, vdot] of ABILITIES)
        for (const weeklyHoursTarget of HOURS) {
          const rows = planRows({
            runsPerWeek: rpw, raceDistance: rd, runnerType: 'Balanced', fitnessLevel,
            totalWeeks: N, vdot, easyPaceSecPerKm: 330, baselineKm, archetype, weeklyHoursTarget,
          });
          samples.push({
            label: `${rd} ${N}wk ${rpw}/wk ${archetype ?? 'no-archetype'} ${baselineKm ?? '-'}km ${fitnessLevel} ${weeklyHoursTarget ?? '-'}h`,
            rows,
          });
        }
  });
  afterAll(() => { vi.restoreAllMocks(); });

  it('covers a broad sample', () => {
    expect(samples.length).toBeGreaterThan(1000);
  });

  it('no deload week is heavier, or carries more quality sessions, than the week before', () => {
    const bad: string[] = [];
    for (const { label, rows } of samples) {
      for (let i = 1; i < rows.length; i++) {
        const w = rows[i], p = rows[i - 1];
        if (!w.deload) continue;
        if (w.total > p.total) bad.push(`${label} wk${w.k}: ${w.total} min after ${p.total} [${p.sessions}] -> [${w.sessions}]`);
        if (w.quality > p.quality) bad.push(`${label} wk${w.k}: ${w.quality} quality after ${p.quality}`);
      }
    }
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });

  it(`no long run is more than ${LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST * 100}% over the longest long run of the previous ${LONG_RUN_LOOKBACK_WEEKS} weeks`, () => {
    const bad: string[] = [];
    for (const { label, rows } of samples) {
      for (let i = 1; i < rows.length; i++) {
        const L = rows[i].long;
        if (L == null) continue;
        const prior = rows.slice(Math.max(0, i - LONG_RUN_LOOKBACK_WEEKS), i)
          .map(r => r.long ?? 0);
        const longest = Math.max(0, ...prior);
        if (longest > 0 && L > longest * (1 + LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST) + 1e-9) {
          bad.push(`${label} wk${rows[i].k} (${rows[i].phase}): ${L} min vs ${longest} (prior ${prior.join(',')})`);
        }
      }
    }
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });

  it('race week (final taper week) has no long run', () => {
    const bad = samples
      .filter(({ rows }) => rows[rows.length - 1].long != null)
      .map(({ label, rows }) => `${label}: race week [${rows[rows.length - 1].sessions}]`);
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });
});

describe('long-run ramp and the 10% rule (unit)', () => {
  it('a scheduled deload week holds the ramp; the next week is one step above the pre-deload week', () => {
    // Intermediate, 16-week marathon: deload weeks 4, 8, 12.
    const ramp = (k: number) => longRunMinutes(k, 16, 'intermediate', 'marathon', 'base');
    expect(isDeloadWeek(4, 'intermediate')).toBe(true);
    expect(ramp(4)).toBe(ramp(3));
    const step = ramp(3) - ramp(2);
    expect(Math.abs((ramp(5) - ramp(3)) - step)).toBeLessThanOrEqual(1);
  });

  it('the ramp still reaches the ability ceiling by 75% of the plan (SCIENCE_LOG §BW)', () => {
    expect(longRunMinutes(12, 16, 'intermediate', 'marathon', 'build')).toBe(165);
    expect(longRunMinutes(15, 20, 'advanced', 'marathon', 'build')).toBe(180);
  });

  it('longRunCeilingMin is the floor of +10%', () => {
    expect(longRunCeilingMin(100)).toBe(110);
    expect(longRunCeilingMin(129)).toBe(141);
  });

  it('an upward effort multiplier never lifts a long run past the 10% rule', () => {
    const base: PlanContext = {
      runsPerWeek: 4, raceDistance: 'marathon', runnerType: 'Balanced', phase: 'base',
      fitnessLevel: 'intermediate', weekIndex: 2, totalWeeks: 8, vdot: 45,
    };
    const week1Long = planWeekSessions({ ...base, weekIndex: 1 }).find(i => i.slot === 'long')!.totalMinutes;
    const eased = planWeekSessions({ ...base, effortScore: -3 }).find(i => i.slot === 'long')!.totalMinutes;
    expect(eased).toBeLessThanOrEqual(longRunCeilingMin(week1Long));
  });

  it('a taper long run scales from the long run the plan prescribed, not the untrimmed ramp', () => {
    // 8-week marathon, 3 runs, detrained 15 km, advanced, 4 h target: every build long
    // run is held near the 30-min floor. Before, the taper long run was 0.65 x the
    // untrimmed ramp (82 min, +173% over the build).
    const rows = planRows({
      runsPerWeek: 3, raceDistance: 'marathon', runnerType: 'Balanced', fitnessLevel: 'advanced',
      totalWeeks: 8, vdot: 55, easyPaceSecPerKm: 330, baselineKm: 15,
      archetype: 'detrained-with-history', weeklyHoursTarget: 4,
    });
    const buildLongest = Math.max(...rows.filter(r => r.phase !== 'taper').map(r => r.long ?? 0));
    for (const r of rows.filter(r => r.phase === 'taper')) {
      if (r.long != null) expect(r.long).toBeLessThanOrEqual(longRunCeilingMin(buildLongest));
    }
  });
});

describe('race week', () => {
  it('isRaceWeek: final taper week of a race plan only; never in continuous mode', () => {
    expect(isRaceWeek('taper', 16, 16)).toBe(true);
    expect(isRaceWeek('taper', 15, 16)).toBe(false);
    expect(isRaceWeek('peak', 16, 16)).toBe(false);
    expect(isRaceWeek('taper', 16, 16, true)).toBe(false);
  });

  it('a continuous plan keeps the long run in its final taper (block deload) week, with no primer', () => {
    const ctx: PlanContext = {
      runsPerWeek: 4, raceDistance: 'half', runnerType: 'Balanced', phase: 'taper',
      fitnessLevel: 'intermediate', weekIndex: 16, totalWeeks: 16, vdot: 45, continuousMode: true,
      planPhases: Array.from({ length: 16 }, (_, i) => (['base', 'build', 'peak', 'taper'] as const)[i % 4]),
    };
    const xs = planWeekSessions(ctx);
    expect(xs.find(i => i.slot === 'long')).toBeTruthy();
    expect(xs.some(i => i.notes === 'Race-week primer')).toBe(false);
  });

  it('the race takes the long-run slot: one fewer prescribed session, primer kept', () => {
    const ctx: PlanContext = {
      runsPerWeek: 5, raceDistance: 'marathon', runnerType: 'Balanced', phase: 'taper',
      fitnessLevel: 'intermediate', weekIndex: 16, totalWeeks: 16, vdot: 45,
    };
    const xs = planWeekSessions(ctx);
    expect(xs).toHaveLength(4);
    expect(xs.find(i => i.slot === 'long')).toBeUndefined();
    expect(xs.filter(i => i.notes === 'Race-week primer')).toHaveLength(1);
  });

  for (const rd of ['marathon', 'half', '10k', '5k'] as RaceDistance[]) {
    it(`${rd}: race-week schedule leaves Sunday free and seats the primer on Tuesday`, () => {
      for (const rpw of [2, 3, 4, 5, 6, 7]) {
        const ws = generateWeekWorkouts(
          'taper', rpw, rd, 'Balanced', [], undefined, null, undefined, 'intermediate',
          undefined, 330, 16, 16, 45, 0,
          undefined, undefined, undefined, undefined, undefined,
        );
        const runs = ws.filter(w => !['cross', 'gym', 'strength', 'rest'].includes(w.t));
        expect(runs.filter(isLongRun), `${rd} ${rpw}/wk`).toHaveLength(0);
        expect(runs.filter(w => w.dayOfWeek === 6).map(w => w.n), `${rd} ${rpw}/wk Sunday`).toEqual([]);
        const primer = runs.find(w => w.t === 'threshold' || w.t === 'vo2');
        expect(primer, `${rd} ${rpw}/wk primer`).toBeDefined();
        // Tuesday: 5 days before a Sunday race, 4 before a Saturday race (SCIENCE_LOG §CE: 3 to 5 days out).
        expect(primer!.dayOfWeek, `${rd} ${rpw}/wk primer day`).toBe(1);
      }
    });
  }
});

describe('generator wiring (state phases + continuous mode)', () => {
  afterEach(() => resetState());

  it('continuous plan: the final taper week keeps its long run, and long runs respect the 10% rule', () => {
    const tw = 16;
    const wks = initializeWeeks(tw);
    const blockPhases = ['base', 'build', 'peak', 'taper'] as const;
    for (let i = 0; i < wks.length; i++) wks[i].ph = blockPhases[i % 4];
    updateState({
      rw: 4, rd: 'half', typ: 'balanced', tw, v: 45, gs: 0,
      pac: { e: 360 }, wks, continuousMode: true, wkm: 24,
    } as unknown as SimulatorState);
    const longs = wks.map((wk, i) => {
      const ws = generateWeekWorkouts(
        wk.ph, 4, 'half', 'Balanced', [], undefined, null, undefined, 'intermediate',
        undefined, 360, i + 1, tw, 45, 0,
        undefined, undefined, undefined, undefined, undefined,
      );
      return ws.find(isLongRun)?.estimatedDurationMin ?? null;
    });
    expect(longs[tw - 1], 'final continuous week').not.toBeNull();
    for (let i = 1; i < tw; i++) {
      const longest = Math.max(0, ...longs.slice(Math.max(0, i - LONG_RUN_LOOKBACK_WEEKS), i).map(l => l ?? 0));
      if (longs[i] != null && longest > 0) {
        expect(longs[i]!, `wk${i + 1} [${longs.join(',')}]`).toBeLessThanOrEqual(longRunCeilingMin(longest));
      }
    }
  });
});
