import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  planWeekSessions, abilityBandFromVdot, isDeloadWeek, isSharpeningDeloadWeek, sessionEasyEquivalentMin, sharpeningRampPct,
  taperMakeupRoom, EASY_FLOOR_MIN, LONG_SOFT_FLOOR_MIN, LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST,
  type PlanContext, type SharpeningInputs,
} from './plan_engine';
import { computeRunningPlanPhases } from './phases';
import { buildSharpenBlockState, liveSharpeningLongRunCapMin, loggedRuns, RECENT_LONGEST_WINDOW_DAYS } from './sharpening-block';
import { generateWeekWorkouts, initializeWeeks } from './generator';
import { updateState, resetState } from '@/state';
import { isLongRun } from './long-run';
import { fitTaperEasyMakeups } from './race-day-rules';
import type { RaceDistance, SimulatorState } from '@/types';
import type { SessionIntent } from './intent_to_workout';
import type { Archetype } from '@/calculations/athlete-archetype';

/**
 * Sharpening block (Tristan 2026-10-05; M4 design v4 as amended by its review).
 * A marathon under 8 weeks away or a half under 4 gets a block built from the
 * runner's current volume and 30-day longest run instead of the full-plan ramp.
 */

const QUALITY = new Set(['threshold', 'vo2', 'marathon_pace', 'float']);
type Ctx = Omit<PlanContext, 'weekIndex' | 'phase'>;

interface Row {
  k: number; phase: string; deload: boolean; total: number; quality: number;
  qualitySlots: string[]; long: number | null; easy: number[]; xs: SessionIntent[];
}

function blockRows(ctx: Ctx, noSignal = false): Row[] {
  const phases = computeRunningPlanPhases(ctx.totalWeeks, ctx.raceDistance, { noSignal }).map(p => p.ph);
  const ability = abilityBandFromVdot(ctx.vdot, ctx.fitnessLevel);
  const rows: Row[] = [];
  for (let k = 1; k <= ctx.totalWeeks; k++) {
    const xs = planWeekSessions({ ...ctx, planPhases: phases, weekIndex: k, phase: phases[k - 1] });
    rows.push({
      k,
      phase: phases[k - 1],
      deload: isSharpeningDeloadWeek(k, ability, phases),
      total: xs.reduce((a, i) => a + i.totalMinutes, 0),
      quality: xs.filter(i => QUALITY.has(i.slot)).length,
      qualitySlots: xs.filter(i => QUALITY.has(i.slot)).map(i => i.slot),
      long: xs.find(i => i.slot === 'long')?.totalMinutes ?? null,
      easy: xs.filter(i => i.slot === 'easy').map(i => i.totalMinutes),
      xs,
    });
  }
  return rows;
}
const fmt = (r: Row) => `wk${r.k} ${r.phase}${r.deload ? ' deload' : ''} [${r.xs.map(i => `${i.slot}:${i.totalMinutes}`).join(' ')}]`;

const A: Ctx = {
  runsPerWeek: 4, raceDistance: 'marathon', runnerType: 'Balanced', fitnessLevel: 'intermediate',
  vdot: 45, easyPaceSecPerKm: 330, totalWeeks: 7, baselineKm: 40, archetype: 'consistent-runner',
  sharpening: { startLongMin: 100, startSource: 'history-30d' },
};

describe('example A: marathon 7 weeks out, 4 runs, 40 km a week, longest recent run 100 min', () => {
  let rows: Row[];
  beforeAll(() => { rows = blockRows(A); });

  it('phases: build x4 (week 4 a deload), peak, taper, race week', () => {
    expect(rows.map(r => r.phase)).toEqual(['build', 'build', 'build', 'build', 'peak', 'taper', 'taper']);
    expect(rows.map(r => r.deload)).toEqual([false, false, false, true, false, false, false]);
  });

  it('the long run starts at the 30-day longest and grows by the archetype ramp (7%) over the longest seated', () => {
    // 100, floor(100 x 1.07) = 107, 114; deload 114 x 0.85 = 97; peak floor(114 x 1.07) = 121;
    // taper 0.70 x 121 = 85; race week none.
    expect(rows.map(r => r.long)).toEqual([100, 107, 114, 97, 121, 85, null]);
  });

  it('weekly totals: loaded weeks rise within the ramp, the deload drops, the taper steps down', () => {
    expect(rows.map(r => r.total)).toEqual([231, 244, 253, 215, 262, 181, 77]);
  });

  it('two quality sessions every loaded week, one threshold in the taper week, the primer in race week', () => {
    expect(rows.slice(0, 5).map(r => r.qualitySlots)).toEqual(Array(5).fill(['marathon_pace', 'float']));
    expect(rows[5].qualitySlots).toEqual(['threshold']);
    expect(rows[5].xs.find(i => i.slot === 'threshold')!.workMinutes).toBe(12);
    expect(rows[6].xs.filter(i => i.notes === 'Race-week primer')).toHaveLength(1);
  });

  it('taper easy runs: 0.70 then 0.55 of the reference easy run (46 min), floored at 25', () => {
    expect(rows[4].easy).toEqual([46]);
    expect(rows[5].easy).toEqual([32, 32]);
    expect(rows[6].easy).toEqual([25, 25]);
  });
});

// ---------------------------------------------------------------------------
// Properties over a grid of blocks
// ---------------------------------------------------------------------------

const LENGTHS: Array<[RaceDistance, number[]]> = [['marathon', [1, 2, 3, 4, 5, 6, 7]], ['half', [1, 2, 3]]];
const RUNS = [1, 2, 3, 4, 5, 6, 7];
const PEOPLE: Array<{ archetype?: Archetype; baselineKm?: number; start: SharpeningInputs | undefined }> = [
  { archetype: 'consistent-runner', baselineKm: 40, start: { startLongMin: 100, startSource: 'history-30d' } },
  { archetype: 'consistent-runner', baselineKm: 25, start: { startLongMin: 35, startSource: 'history-30d' } },
  // Low base, long run near the weekly volume (review 2026-10-07: loaded weeks jumped 50 to 60%).
  { archetype: 'consistent-runner', baselineKm: 15, start: { startLongMin: 60, startSource: 'history-30d' } },
  { archetype: 'high-mileage', baselineKm: 70, start: { startLongMin: 140, startSource: 'history-30d' } },
  { archetype: 'detrained-with-history', baselineKm: 0, start: { startLongMin: 30, startSource: 'history-no-recent-run' } },
  { archetype: 'detrained-with-history', baselineKm: 20, start: { startLongMin: 60, startSource: 'history-30d' } },
  { archetype: 'unknown', baselineKm: 30, start: undefined },
  { archetype: 'sedentary-novice', baselineKm: 8, start: { startLongMin: 30, startSource: 'history-30d' } },
];
const ABILITIES: Array<[string, number]> = [['beginner', 28], ['novice', 38], ['intermediate', 45], ['advanced', 55]];
const HOURS: Array<number | undefined> = [undefined, 2, 3, 5];

interface Sample { label: string; ctx: Ctx; rows: Row[] }
let samples: Sample[] = [];

describe('sharpening block properties (grid through planWeekSessions)', () => {
  beforeAll(() => {
    samples = [];
    for (const [rd, lengths] of LENGTHS) for (const n of lengths) for (const rpw of RUNS)
      for (const p of PEOPLE) for (const [fitnessLevel, vdot] of ABILITIES) for (const weeklyHoursTarget of HOURS) {
        const ctx: Ctx = {
          runsPerWeek: rpw, raceDistance: rd, runnerType: 'Balanced', fitnessLevel, vdot, easyPaceSecPerKm: 330,
          totalWeeks: n, baselineKm: p.baselineKm, archetype: p.archetype, weeklyHoursTarget, sharpening: p.start,
        };
        samples.push({
          label: `${rd} ${n}wk ${rpw}/wk ${p.archetype} ${p.baselineKm}km start ${p.start?.startLongMin ?? 'none'} ${fitnessLevel} ${weeklyHoursTarget ?? '-'}h`,
          ctx,
          rows: blockRows(ctx, p.start == null),
        });
      }
  });

  it('covers a broad sample', () => { expect(samples.length).toBeGreaterThan(2000); });

  it('race week has no long run', () => {
    const bad = samples.filter(s => s.rows[s.rows.length - 1].long != null).map(s => `${s.label}: ${fmt(s.rows[s.rows.length - 1])}`);
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });

  it('no long run is shorter than 30 minutes', () => {
    const bad: string[] = [];
    for (const s of samples) for (const r of s.rows) if (r.long != null && r.long < LONG_SOFT_FLOOR_MIN) bad.push(`${s.label} ${fmt(r)}`);
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });

  it('each long run is at most (1 + ramp) x the longest long run seated before it (never above 10%)', () => {
    const bad: string[] = [];
    for (const s of samples) {
      const ramp = sharpeningRampPct(s.ctx.archetype);
      expect(ramp).toBeLessThanOrEqual(LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST);
      let longest = 0;
      for (const r of s.rows) {
        if (r.long != null && longest > 0 && r.long > Math.floor(longest * (1 + ramp))) bad.push(`${s.label} ${fmt(r)} after ${longest}`);
        if (r.long != null) longest = Math.max(longest, r.long);
      }
    }
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });

  it('no session covers more distance than the week\'s long run (or the last long run, in a week without one)', () => {
    const bad: string[] = [];
    for (const s of samples) {
      let lastLong: number | null = null;
      for (const r of s.rows) {
        const cap = r.long ?? lastLong;
        if (cap != null) {
          for (const i of r.xs) {
            if (i.slot === 'long') continue;
            const d = sessionEasyEquivalentMin(i);
            // Easy runs keep the 25-min floor even beside a shorter cap.
            const limit = i.slot === 'easy' ? Math.max(cap, EASY_FLOOR_MIN) : cap;
            if (d > limit + 1e-9) bad.push(`${s.label} ${fmt(r)}: ${i.slot} ${d.toFixed(1)} > ${cap}`);
          }
        }
        if (r.long != null) lastLong = r.long;
      }
    }
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });

  it('a deload week is lighter than the week before, with no more quality sessions', () => {
    const bad: string[] = [];
    for (const s of samples) for (let i = 1; i < s.rows.length; i++) {
      const r = s.rows[i], p = s.rows[i - 1];
      if (!r.deload) continue;
      if (r.total > p.total) bad.push(`${s.label} ${fmt(r)} after ${fmt(p)}`);
      if (r.quality > p.quality) bad.push(`${s.label} ${fmt(r)}: quality after ${fmt(p)}`);
    }
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });

  it('the taper never rises: total, long run and easy-run length fall from the reference week to race week', () => {
    const bad: string[] = [];
    for (const s of samples) {
      const firstTaper = s.rows.findIndex(r => r.phase === 'taper');
      const chain = firstTaper > 0 ? s.rows.slice(firstTaper - 1) : s.rows.slice(firstTaper);
      for (let i = 1; i < chain.length; i++) {
        const r = chain[i], p = chain[i - 1];
        if (r.total > p.total) bad.push(`${s.label} total ${fmt(r)} after ${fmt(p)}`);
        if (r.long != null && p.long != null && r.long > p.long) bad.push(`${s.label} long ${fmt(r)} after ${fmt(p)}`);
        const re = Math.max(0, ...r.easy), pe = Math.max(0, ...p.easy);
        if (pe > 0 && re > Math.max(pe, EASY_FLOOR_MIN)) bad.push(`${s.label} easy ${fmt(r)} after ${fmt(p)}`);
      }
    }
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });

  it('the taper never rises, easy makeups included: carried makeups only fill up to f x the reference total', () => {
    // Three easy makeups at the previous week's longest easy run (EASY_FLOOR_MIN when it had none),
    // fitted the way the generator fits them (taperMakeupRoom + fitTaperEasyMakeups).
    const bad: string[] = [];
    for (const s of samples) {
      const phases = computeRunningPlanPhases(s.ctx.totalWeeks, s.ctx.raceDistance, { noSignal: s.ctx.sharpening == null }).map(p => p.ph);
      for (let i = 1; i < s.rows.length; i++) {
        const r = s.rows[i], p = s.rows[i - 1];
        const room = taperMakeupRoom({ ...s.ctx, planPhases: phases, weekIndex: r.k, phase: phases[r.k - 1] });
        if (r.phase !== 'taper') { if (room) bad.push(`${s.label} ${fmt(r)}: room outside the taper`); continue; }
        if (!room) { bad.push(`${s.label} ${fmt(r)}: no room computed`); continue; }
        const len = Math.max(EASY_FLOOR_MIN, ...p.easy);
        const skips = [0, 1, 2].map(() => ({ workout: { t: 'easy', n: 'Easy', d: '', estimatedDurationMin: len } as any }));
        const carried = fitTaperEasyMakeups(skips, r.total, room, (w, m) => ({ ...w, estimatedDurationMin: m }));
        const added = carried.reduce((a, x) => a + (x.workout.estimatedDurationMin ?? 0), 0);
        if (r.total + added > Math.max(r.total, room.ceilingMin)) bad.push(`${s.label} ${fmt(r)}: +${added} past ${room.ceilingMin}`);
        if (added > 0 && r.total + added > p.total) bad.push(`${s.label} ${fmt(r)}: +${added} after ${fmt(p)}`);
        if (carried.some(x => (x.workout.estimatedDurationMin ?? 0) > room.easyMin)) bad.push(`${s.label} ${fmt(r)}: makeup longer than ${room.easyMin}`);
        if (r.k === s.rows.length && carried.length > 0) bad.push(`${s.label} race week carried ${carried.length}`);
      }
    }
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });

  it('a taper week before race week never carries a quality session when the week before the taper had none', () => {
    const bad: string[] = [];
    for (const s of samples) {
      const firstTaper = s.rows.findIndex(r => r.phase === 'taper');
      if (firstTaper < 1) continue;
      if (s.rows[firstTaper - 1].quality > 0) continue;
      for (const r of s.rows.slice(firstTaper, -1)) if (r.quality > 0) bad.push(`${s.label} ${fmt(r)}`);
    }
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });

  it('race week holds exactly one quality session, the primer, whenever it holds a run (2026-10-08)', () => {
    // Before: a block whose reference week held no quality session (a binding hours
    // target or a low budget unseated them) dropped the primer and kept easy runs.
    const bad: string[] = [];
    for (const s of samples) {
      const r = s.rows[s.rows.length - 1];
      const primers = r.xs.filter(i => i.notes === 'Race-week primer').length;
      if (s.ctx.runsPerWeek >= 2 && (r.xs.length === 0 || primers !== 1 || r.quality !== 1)) bad.push(`${s.label} ${fmt(r)}`);
      if (s.ctx.runsPerWeek <= 1 && r.xs.length > 0) bad.push(`${s.label} 1 run a week: ${fmt(r)}`);
    }
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });

  it('loaded weeks: the long run never shrinks, and volume grows by at most the ramp over the larger of the last loaded week and current volume', () => {
    const bad: string[] = [];
    for (const s of samples) {
      const ramp = sharpeningRampPct(s.ctx.archetype);
      const currentMin = (s.ctx.baselineKm ?? 0) * 330 / 60;
      let lastLoaded: Row | null = null;
      for (const r of s.rows) {
        const loaded = (r.phase === 'build' || r.phase === 'peak') && !r.deload && r.k < s.rows.length;
        if (!loaded) continue;
        if (lastLoaded && lastLoaded.long != null && r.long != null && r.long < lastLoaded.long) {
          bad.push(`${s.label} long ${fmt(r)} after ${fmt(lastLoaded)}`);
        }
        const ref = Math.max(lastLoaded?.total ?? 0, currentMin);
        // Past every floor the residual overflow is accepted, up to the one
        // floor-length easy run the week holds (none when it holds no easy run).
        // Before (review 2026-10-07): any week with at most one floor easy run was
        // exempt outright, which hid loaded weeks 50 to 60% over the ramp.
        const atFloors = r.easy.length <= 1 && r.easy.every(e => e === EASY_FLOOR_MIN);
        const allowance = atFloors ? r.easy.length * EASY_FLOOR_MIN : 0;
        if (ref > 0 && r.total > Math.ceil(ref * (1 + ramp)) + 1 + allowance) {
          bad.push(`${s.label} total ${fmt(r)} vs ${ref.toFixed(0)}`);
        }
        lastLoaded = r;
      }
    }
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });
});

describe('a weekly hours target is a ceiling on every block week, whichever budget binds', () => {
  it('grid: no week passes its hours target', () => {
    const bad: string[] = [];
    for (const s of samples) {
      const h = s.ctx.weeklyHoursTarget;
      if (h == null) continue;
      for (const r of s.rows) if (r.total > h * 60) bad.push(`${s.label} ${fmt(r)}`);
    }
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });
});

describe('past every floor, a quality session is seated only within one floor-length easy run of the budget (review 2026-10-07)', () => {
  // Before: with the long run held to seat a quality session, the whole session was
  // accepted as overflow. Marathon 5 weeks, 3 runs, 15 km, 60-min longest: 87, 131
  // [long 60, marathon pace 46, easy 25] (+51%), 135, and the long run never grew.
  const LOW: Ctx = { ...A, totalWeeks: 5, baselineKm: 15, sharpening: { startLongMin: 60, startSource: 'history-30d' } };

  it('15 km a week, 60-min longest, 3 to 7 runs: loaded weeks grow by the ramp and the long run grows each week', () => {
    const ramp = sharpeningRampPct(A.archetype);
    for (const rpw of [3, 4, 5, 6, 7]) for (const [fitnessLevel, vdot] of [['intermediate', 45], ['advanced', 55]] as const) {
      const rows = blockRows({ ...LOW, runsPerWeek: rpw, fitnessLevel, vdot });
      const loaded = rows.filter(r => (r.phase === 'build' || r.phase === 'peak') && !r.deload);
      const label = `${rpw} runs ${fitnessLevel}: ${rows.map(fmt).join(' | ')}`;
      expect(loaded.map(r => r.long), label).toEqual([60, 64, 68]);
      expect(loaded.map(r => r.total), label).toEqual([87, 93, 99]);
      for (let i = 1; i < loaded.length; i++) {
        expect(loaded[i].total, label).toBeLessThanOrEqual(Math.ceil(loaded[i - 1].total * (1 + ramp)) + 1);
      }
    }
  });

  it('2-hour target on the same runner: no week passes 120 min', () => {
    // Before: 131 and 135 against the 120-min target (the chain budget bound, not the target).
    for (const rpw of [3, 4, 5, 6, 7]) {
      const rows = blockRows({ ...LOW, runsPerWeek: rpw, weeklyHoursTarget: 2 });
      for (const r of rows) expect(r.total, fmt(r)).toBeLessThanOrEqual(120);
    }
  });

  it('a session seated past the budget never takes the week past a target the chain budget sits under', () => {
    // 20 km, 60-min longest, advanced, detrained-with-history: the chain budget (117) binds
    // below the 2-hour target. Without the target week 2 seats marathon pace with the
    // 25-min easy run as accepted overflow (139); with it the week stays at or under 120.
    const ctx: Ctx = {
      ...LOW, baselineKm: 20, archetype: 'detrained-with-history', fitnessLevel: 'advanced', vdot: 55, easyPaceSecPerKm: 290,
    };
    const free = blockRows(ctx);
    expect(free[1].xs.map(i => `${i.slot}:${i.totalMinutes}`)).toEqual(['long:60', 'marathon_pace:54', 'easy:25']);
    for (const rpw of [3, 4]) {
      const rows = blockRows({ ...ctx, runsPerWeek: rpw, weeklyHoursTarget: 2 });
      for (const r of rows) expect(r.total, fmt(r)).toBeLessThanOrEqual(120);
    }
  });
});

describe('the taper never rises, race week included', () => {
  it('total beginner, 20 km, 90-min longest, 2-hour target, 7-week marathon, 4 to 7 runs: race week is not longer than the taper week', () => {
    // Before: 74 then 75 (three 25-min easy runs, the count rounded up past the week before).
    for (const rpw of [4, 5, 6, 7]) {
      const rows = blockRows({
        ...A, runsPerWeek: rpw, fitnessLevel: 'total_beginner', vdot: 28, baselineKm: 20, weeklyHoursTarget: 2,
        sharpening: { startLongMin: 90, startSource: 'history-30d' },
      });
      expect(rows[6].total, `${fmt(rows[5])} | ${fmt(rows[6])}`).toBeLessThanOrEqual(rows[5].total);
      expect(rows[6].long).toBeNull();
    }
  });
});

describe('without a binding hours target, the block fit keeps quality sessions before it gives up the long run\'s growth', () => {
  it('reviewer case: 5 runs, 40 km, longest 70 min keeps marathon pace and float in every loaded week', () => {
    const rows = blockRows({ ...A, runsPerWeek: 5, sharpening: { startLongMin: 70, startSource: 'history-30d' } });
    for (const r of rows.slice(0, 5)) expect(r.qualitySlots, fmt(r)).toEqual(['marathon_pace', 'float']);
  });

  it('reviewer case: 6 runs, 60 km, longest 120 min keeps both in every loaded week', () => {
    const rows = blockRows({ ...A, runsPerWeek: 6, baselineKm: 60, sharpening: { startLongMin: 120, startSource: 'history-30d' } });
    for (const r of rows.slice(0, 5)) expect(r.qualitySlots, fmt(r)).toEqual(['marathon_pace', 'float']);
  });

  it('a week whose quality sessions fit only when the long run holds: the long run holds, both sessions stay', () => {
    // 4-week marathon, 'unknown' archetype (7% ramp), 40 km, longest 110 min, no hours target:
    // the peak week's archetype budget seats 117 + 50 + 47 + 25 only with the long run held at 110.
    const rows = blockRows({ ...A, totalWeeks: 4, archetype: 'unknown', sharpening: { startLongMin: 110, startSource: 'history-30d' } });
    expect(rows[1].phase).toBe('peak');
    expect(rows[1].long).toBe(110);
    expect(rows[1].qualitySlots).toEqual(['marathon_pace', 'float']);
  });

  it('the long run is never cut for a quality session the single-session cap then unseats (review 2026-10-07)', () => {
    // 3-week marathon, 2 runs, 15 km, longest 60 min. Before: the past-all-floors rule cut the
    // long run to 37 min to make room for marathon pace, the cap (no session longer than the long
    // run) then unseated marathon pace, and the week was one 37-min run. Now the long run keeps
    // its row length and the freed slot is an easy run.
    const rows = blockRows({ ...A, runsPerWeek: 2, totalWeeks: 3, baselineKm: 15, sharpening: { startLongMin: 60, startSource: 'history-30d' } });
    expect(rows[0].long).toBe(60);
    expect(rows[0].easy).toEqual([27]);
    expect(rows[0].quality).toBe(0);
  });

  it('live 0.85 lever on example A week 3 keeps both quality sessions', () => {
    const phases = computeRunningPlanPhases(7, 'marathon').map(p => p.ph);
    const xs = planWeekSessions({ ...A, planPhases: phases, weekIndex: 3, phase: 'build', effortScore: 3 });
    expect(xs.filter(i => QUALITY.has(i.slot)).map(i => i.slot)).toEqual(['marathon_pace', 'float']);
    const nominal = planWeekSessions({ ...A, planPhases: phases, weekIndex: 3, phase: 'build' });
    expect(xs.reduce((a, i) => a + i.totalMinutes, 0)).toBeLessThan(nominal.reduce((a, i) => a + i.totalMinutes, 0));
  });
});

describe('hours target: start at the target and hold; the long run still grows each week (owner decision 2026-10-06)', () => {
  it('3-hour target (example A): the long run grows every loaded week; quality sessions give way first', () => {
    // Before: the long run held at 107 from week 2 to keep marathon pace (100, 107, 107, 86, 107, 75).
    const rows = blockRows({ ...A, weeklyHoursTarget: 3 });
    expect(rows.map(r => r.long)).toEqual([100, 107, 114, 97, 121, 85, null]);
    // Race week: the primer (27 min) takes one 25-min easy run's place (2026-10-08).
    expect(rows.map(r => r.total)).toEqual([180, 180, 180, 153, 179, 135, 77]);
    expect(rows.map(r => r.qualitySlots.length)).toEqual([1, 1, 0, 0, 0, 0, 1]);
    expect(rows[6].xs.filter(i => i.notes === 'Race-week primer')).toHaveLength(1);
  });

  it('2-hour target (example A): week 1 starts as close to the 100-min longest as the target allows and never halves it', () => {
    // Before: 49, 49, 49, 42, 49, 34 beside marathon pace; the peak week then lost marathon
    // pace to the single-session cap and kept the held 49. Now 120 - one 25-min easy run = 95.
    const rows = blockRows({ ...A, weeklyHoursTarget: 2 });
    expect(rows.map(r => r.long)).toEqual([95, 95, 95, 77, 95, 67, null]);
    expect(rows.map(r => r.total)).toEqual([120, 120, 120, 102, 120, 92, 77]);
    expect(rows[6].xs.filter(i => i.notes === 'Race-week primer')).toHaveLength(1);
    for (const r of rows.filter(r => r.long != null && !r.deload && r.phase !== 'taper')) {
      expect(r.long! + EASY_FLOOR_MIN, fmt(r)).toBe(120);
    }
  });

  it('4-hour target (example A): the peak week grows the long run to 121 and keeps marathon pace', () => {
    // Before: the long run held at 114 to keep float as well.
    const rows = blockRows({ ...A, weeklyHoursTarget: 4 });
    expect(rows.map(r => r.long)).toEqual([100, 107, 114, 97, 121, 85, null]);
    expect(rows[4].qualitySlots).toEqual(['marathon_pace']);
    expect(rows[4].total).toBeLessThanOrEqual(240);
  });


  it('a target below current volume: every loaded week sits at the target, the deload below it, the taper steps down', () => {
    const rows = blockRows({ ...A, weeklyHoursTarget: 3 });
    const loaded = rows.filter(r => (r.phase === 'build' || r.phase === 'peak') && !r.deload);
    expect(rows[0].total).toBe(180);
    for (const r of loaded) expect(r.total, fmt(r)).toBeGreaterThanOrEqual(178);
    for (const r of loaded) expect(r.total, fmt(r)).toBeLessThanOrEqual(182);
    expect(rows[3].total).toBeLessThan(rows[2].total);
    expect(rows[5].total).toBeLessThan(rows[4].total);
    expect(rows[6].total).toBeLessThan(rows[5].total);
  });

  it('a target above current volume leaves no week below current volume and changes nothing when it never binds', () => {
    const currentMin = 40 * 330 / 60; // 220
    const rows = blockRows({ ...A, weeklyHoursTarget: 6 });
    const free = blockRows(A);
    expect(rows.map(r => r.total)).toEqual(free.map(r => r.total));
    for (const r of rows.filter(r => (r.phase === 'build' || r.phase === 'peak') && !r.deload)) {
      expect(r.total, fmt(r)).toBeGreaterThanOrEqual(currentMin);
    }
  });
});

describe('no run in the last 30 days (case b)', () => {
  const B: Ctx = { ...A, baselineKm: 0, archetype: 'detrained-with-history', sharpening: { startLongMin: 30, startSource: 'history-no-recent-run' } };
  it('restarts the long run at 30 min, grows it by the ramp, holds no hard session before race week, stays inside the archetype floor budget', () => {
    const rows = blockRows(B);
    expect(rows.map(r => r.long)).toEqual([30, 33, 36, 31, 39, null, null]);
    for (const r of rows.slice(0, -1)) expect(r.quality, fmt(r)).toBe(0);
    // Race week keeps the §CE primer whenever it holds a run (2026-10-08).
    expect(rows[6].xs.filter(i => i.notes === 'Race-week primer'), fmt(rows[6])).toHaveLength(1);
    expect(rows[6].quality).toBe(1);
    // detrained floor 15 km/wk at 5:30 = 82.5 min, ramping 10% a week.
    expect(rows[0].total).toBeLessThanOrEqual(83);
  });
});

describe('block deloads', () => {
  it('1 run a week: a deload whose long run falls under 30 min is one shorter easy run, below the week before', () => {
    // Before: the single run fell back to the last long run (32 then 32).
    for (const n of [6, 7]) {
      const rows = blockRows({ ...A, runsPerWeek: 1, fitnessLevel: 'beginner', vdot: 28, totalWeeks: n, sharpening: { startLongMin: 30, startSource: 'history-30d' } });
      const deloads = rows.filter(r => r.deload);
      expect(deloads.length, rows.map(fmt).join(' | ')).toBeGreaterThan(0);
      for (const r of deloads) {
        const prev = rows[r.k - 2];
        expect(r.total, `${fmt(r)} after ${fmt(prev)}`).toBeLessThan(prev.total);
        expect(r.total).toBeGreaterThanOrEqual(EASY_FLOOR_MIN);
      }
    }
  });

  it('build weeks on the ability cycle deload; the last week before the taper never does (it stands in for the peak)', () => {
    const noPeak = computeRunningPlanPhases(5, 'marathon', { noSignal: true }).map(p => p.ph); // build x3, taper x2
    expect(isDeloadWeek(3, 'novice')).toBe(true);
    expect(isSharpeningDeloadWeek(3, 'novice', noPeak)).toBe(false);
    const seven = computeRunningPlanPhases(7, 'marathon').map(p => p.ph);
    expect(isSharpeningDeloadWeek(4, 'intermediate', seven)).toBe(true);
    expect(isSharpeningDeloadWeek(3, 'novice', seven)).toBe(true);
    // Peak (week 5) and taper weeks never deload.
    expect(isDeloadWeek(6, 'novice')).toBe(true);
    expect(isSharpeningDeloadWeek(6, 'novice', seven)).toBe(false);
    expect(isSharpeningDeloadWeek(5, 'advanced', seven)).toBe(false);
  });
});

describe('live levers are reduce-only in a block', () => {
  it('an effort score that would lift a full plan leaves the block week unchanged', () => {
    const phases = computeRunningPlanPhases(7, 'marathon').map(p => p.ph);
    const nominal = planWeekSessions({ ...A, planPhases: phases, weekIndex: 2, phase: 'build' });
    const lifted = planWeekSessions({ ...A, planPhases: phases, weekIndex: 2, phase: 'build', effortScore: -3 });
    expect(lifted).toEqual(nominal);
  });

  it('the live long-run cap holds the long run and the easy runs (reduce-only)', () => {
    const phases = computeRunningPlanPhases(7, 'marathon').map(p => p.ph);
    const capped = planWeekSessions({ ...A, planPhases: phases, weekIndex: 3, phase: 'build', liveLongRunCapMin: 90 });
    expect(capped.find(i => i.slot === 'long')!.totalMinutes).toBe(90);
    const loose = planWeekSessions({ ...A, planPhases: phases, weekIndex: 3, phase: 'build', liveLongRunCapMin: 500 });
    expect(loose.find(i => i.slot === 'long')!.totalMinutes).toBe(114);
  });
});

describe('block start inputs from logged runs (buildSharpenBlockState)', () => {
  const NOW = Date.parse('2026-10-07T12:00:00Z');
  const day = 86400000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const base = { v: 45, pac: { e: 330 } as any, onboarding: { experienceLevel: 'intermediate' } as any };

  it('a: the longest run of the last 30 days, by distance at easy pace, deduplicated across sources', () => {
    const s = {
      ...base,
      wks: [{ garminActuals: { a: { startTime: iso(NOW - 3 * day), activityType: 'RUNNING', distanceKm: 18.2, durationSec: 5400 } } }] as any,
      previousPlanWks: [{ planStartDate: '2026-09-01', archivedAt: '', weeks: [{ garminActuals: { b: { startTime: iso(NOW - 3 * day), activityType: 'RUNNING', distanceKm: 18.2, durationSec: 5400 } } }] }],
      onboardingRunHistory: [
        { startTime: iso(NOW - 40 * day), distKm: 30, durSec: 10800, activityType: 'RUNNING' }, // outside 30 days
        { startTime: iso(NOW - 10 * day), distKm: 10, durSec: 3000, activityType: 'RUNNING' },
      ],
    };
    expect(loggedRuns(s)).toHaveLength(3);
    const b = buildSharpenBlockState(s, { raceDistance: 'marathon', trainingWeeks: 7, noSignal: false, nowMs: NOW });
    expect(b.startSource).toBe('history-30d');
    expect(b.startLongMin).toBe(100); // 18.2 km x 330 s / 60 = 100.1
    expect(b.recentLongestMin).toBe(100);
    expect(RECENT_LONGEST_WINDOW_DAYS).toBe(30);
  });

  it('a: clamped to [30 min, ability ceiling]', () => {
    const short = { ...base, onboardingRunHistory: [{ startTime: iso(NOW - day), distKm: 3, durSec: 1000, activityType: 'RUNNING' }] };
    expect(buildSharpenBlockState(short, { raceDistance: 'marathon', trainingWeeks: 5, noSignal: false, nowMs: NOW }).startLongMin).toBe(30);
    const race = { ...base, onboardingRunHistory: [{ startTime: iso(NOW - 20 * day), distKm: 42.2, durSec: 14400, activityType: 'RUNNING' }] };
    expect(buildSharpenBlockState(race, { raceDistance: 'marathon', trainingWeeks: 5, noSignal: false, nowMs: NOW }).startLongMin).toBe(165);
  });

  it('b: synced runs, none in 30 days: the 30-min restart', () => {
    const s = { ...base, onboardingRunHistory: [{ startTime: iso(NOW - 60 * day), distKm: 20, durSec: 7200, activityType: 'RUNNING' }] };
    const b = buildSharpenBlockState(s, { raceDistance: 'marathon', trainingWeeks: 7, noSignal: false, nowMs: NOW });
    expect(b).toMatchObject({ startSource: 'history-no-recent-run', startLongMin: 30, recentLongestMin: null });
  });

  it('c: no logged runs: the existing week-1 anchor (marathon 90, half 64)', () => {
    expect(buildSharpenBlockState(base, { raceDistance: 'marathon', trainingWeeks: 7, noSignal: true, nowMs: NOW }))
      .toMatchObject({ startSource: 'no-data', startLongMin: 90, noSignal: true });
    expect(buildSharpenBlockState(base, { raceDistance: 'half', trainingWeeks: 3, noSignal: true, nowMs: NOW }).startLongMin).toBe(64);
  });

  it('non-run activities never count', () => {
    const s = { ...base, onboardingRunHistory: [{ startTime: iso(NOW - day), distKm: 60, durSec: 7200, activityType: 'CYCLING' }] };
    expect(buildSharpenBlockState(s, { raceDistance: 'marathon', trainingWeeks: 7, noSignal: false, nowMs: NOW }).startSource).toBe('no-data');
  });
});

describe('live long-run cap (liveSharpeningLongRunCapMin)', () => {
  const block = { v: 1, startLongMin: 100, startSource: 'history-30d' as const, recentLongestMin: 100, noSignal: false, trainingWeeks: 7, builtISO: '2026-09-07' };
  const at = (y: number, m: number, d: number, h = 9) => new Date(y, m - 1, d, h).toISOString();
  const s = (runs: Array<[string, number]>, w: number) => ({
    w, planStartDate: '2026-09-07', pac: { e: 330 } as any, sharpenBlock: block,
    athleteArchetype: { archetype: 'consistent-runner' } as any,
    onboardingRunHistory: runs.map(([startTime, distKm]) => ({ startTime, distKm, durSec: distKm * 330, activityType: 'RUNNING' })),
  });

  it('no run logged since the block started: no cap', () => {
    expect(liveSharpeningLongRunCapMin(s([[at(2026, 9, 1), 18.2]], 2) as any, 2)).toBeUndefined();
  });

  it('after a skipped long run: (1 + ramp) x the longest run of the 30 days before the week', () => {
    // Long runs skipped; the longest logged run since the block started is 12 km (66 min,
    // Sep 20); the pre-block 18.2-km run (Sep 1) is still inside the 30 days before week 3 (Sep 21).
    const runs: Array<[string, number]> = [[at(2026, 9, 1), 18.2], [at(2026, 9, 20), 12]];
    expect(liveSharpeningLongRunCapMin(s(runs, 3) as any, 3)).toBe(Math.floor(100.1 * 1.07));
    // By week 6 (Oct 12) the Sep 1 run has left the window: cap from the 12-km run.
    expect(liveSharpeningLongRunCapMin(s(runs, 6) as any, 6)).toBe(Math.floor(66 * 1.07));
  });

  it('future weeks stay on the plan rows', () => {
    const runs: Array<[string, number]> = [[at(2026, 9, 9), 12]];
    expect(liveSharpeningLongRunCapMin(s(runs, 2) as any, 3)).toBeUndefined();
  });
});

describe('the taper never rises, makeups included (generateWeekWorkouts)', () => {
  afterEach(() => { resetState(); vi.restoreAllMocks(); });

  /**
   * Before: filterTaperMakeups dropped makeup long runs and quality sessions but
   * carried easy makeups at their original length with no bound. Skipping the
   * peak week's easy runs lifted the first taper week above the peak week
   * (16-week marathon, 6 runs: 267 + 3 x 46 = 405 against a 400-min peak week)
   * and far above its taper ceiling (7-week block: 192 + 2 x 31 = 254 against
   * 0.70 x 278 = 195).
   */
  function run(rd: 'marathon' | 'half', tw: number, rw: number) {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wks = initializeWeeks(tw, { raceDistance: rd });
    updateState({
      rw, rd, typ: 'Balanced', tw, v: 45, gs: 0, w: 1, pac: { e: 330 }, wks, continuousMode: false,
      detectedWeeklyKm: 40, athleteArchetype: { archetype: 'consistent-runner' }, eventType: 'running',
      onboarding: { experienceLevel: 'intermediate' },
      ...(tw < 8 ? { sharpenBlock: { v: 1, startLongMin: 100, startSource: 'history-30d', recentLongestMin: 100, noSignal: false, trainingWeeks: tw, builtISO: '2026-10-05' } } : {}),
    } as unknown as SimulatorState);
    const gen = (k: number, skips: Array<{ workout: any; skipCount: number }> = []) => generateWeekWorkouts(
      wks[k - 1].ph, rw, rd, 'Balanced', skips, undefined, null, undefined, 'intermediate', undefined, 330, k, tw, 45, 0,
    );
    const runMin = (ws: any[]) => ws.filter(w => !['gym', 'cross', 'rest'].includes(w.t))
      .reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
    const first = wks.findIndex(w => w.ph === 'taper') + 1;
    const peak = gen(first - 1);
    const easySkips = peak.filter(w => w.t === 'easy').map(w => ({ workout: w, skipCount: 1 }));
    const own = gen(first);
    const withMakeups = gen(first, easySkips);
    const ownEasy = Math.max(...own.filter(w => w.t === 'easy' && !w.skipped).map(w => w.estimatedDurationMin ?? 0));
    return { peak: runMin(peak), skipped: easySkips.length, own: runMin(own), withMakeups: runMin(withMakeups), makeups: withMakeups.filter(w => w.skipped), ownEasy };
  }

  it('16-week marathon, 6 runs: three skipped peak-week easy runs never lift the first taper week above the peak week', () => {
    const r = run('marathon', 16, 6);
    expect(r.skipped).toBe(3);
    expect(r.withMakeups).toBeLessThanOrEqual(r.peak);
    expect(r.withMakeups).toBeLessThanOrEqual(Math.max(r.own, Math.round(0.70 * r.peak)));
    for (const m of r.makeups) expect(m.estimatedDurationMin).toBeLessThanOrEqual(r.ownEasy);
  });

  it('7-week block, 6 runs: the first taper week stays at or under 0.70 x the reference week', () => {
    const r = run('marathon', 7, 6);
    expect(r.skipped).toBeGreaterThanOrEqual(2);
    expect(r.withMakeups).toBeLessThanOrEqual(Math.max(r.own, Math.round(0.70 * r.peak)));
    for (const m of r.makeups) expect(m.estimatedDurationMin).toBeLessThanOrEqual(r.ownEasy);
  });

  it('12-week half, 6 runs: the same bound', () => {
    const r = run('half', 12, 6);
    expect(r.withMakeups).toBeLessThanOrEqual(r.peak);
    expect(r.withMakeups).toBeLessThanOrEqual(Math.max(r.own, Math.round(0.70 * r.peak)));
  });
});

describe('generator wiring: generateWeekWorkouts reads the stored block', () => {
  afterEach(() => resetState());

  it('week 1 long run is the stored start; race week has no long run', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tw = 7;
    const wks = initializeWeeks(tw, { raceDistance: 'marathon' });
    updateState({
      rw: 4, rd: 'marathon', typ: 'Balanced', tw, v: 45, gs: 0, w: 1,
      pac: { e: 330 }, wks, continuousMode: false, detectedWeeklyKm: 40,
      athleteArchetype: { archetype: 'consistent-runner' },
      onboarding: { experienceLevel: 'intermediate' },
      sharpenBlock: { v: 1, startLongMin: 100, startSource: 'history-30d', recentLongestMin: 100, noSignal: false, trainingWeeks: 7, builtISO: '2026-10-05' },
    } as unknown as SimulatorState);
    const longOf = (k: number) => generateWeekWorkouts(
      wks[k - 1].ph, 4, 'marathon', 'Balanced', [], undefined, null, undefined, 'intermediate',
      undefined, 330, k, tw, 45, 0,
    ).find(isLongRun)?.estimatedDurationMin ?? null;
    expect(longOf(1)).toBe(100);
    expect(longOf(2)).toBe(107);
    expect(longOf(7)).toBeNull();
    vi.restoreAllMocks();
  });
});
