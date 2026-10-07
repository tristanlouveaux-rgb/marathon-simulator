/**
 * No tri / cycling suggestion promises a change the apply step then skips.
 *
 * Regression (review of the a2 fixes): the cross-training overload Reduce /
 * Replace builders and the readiness and RPE gates marked 'brick' and
 * 'bike_vo2_micros' (and other off-ladder kinds) as quality and proposed a
 * downgrade or swap with a TSS reduction. applyTriSuggestions leaves those
 * sessions untouched and counts them as skipped, but the answer was still
 * recorded, so that load was never proposed again. Probe before the fix: 88 of
 * 1226 overload proposals across generated 70.3, Ironman, olympic and sprint
 * plans were skipped on apply. canApplyTriSuggestion is now the one gate both
 * ends read.
 *
 * Since 2026-10-06 (Tristan's rule) off-ladder bike / swim kinds take a
 * downgrade to the rung OFF_LADDER_DOWNGRADE_RUNG maps them to, unless it would
 * raise their planned load; a brick and an off-ladder swap still take none.
 *
 * Regression (review of 92d662e): neither detector proposed that downgrade for
 * an over-under or an open-water swim. Both picked quality sessions by type
 * keyword, and 'bike_over_under' / 'swim_openwater' match none, so the readiness
 * row skipped them and the overload builders trimmed them instead. Both now
 * read isTriQualitySession, which counts every OFF_LADDER_DOWNGRADE_RUNG kind.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { applyTriSuggestions, canApplyTriSuggestion, isTriQualitySession, triDowngradeTssReduction } from './tri-suggestion-apply';
import { collectTriSuggestions, type TriSuggestionMod } from './tri-suggestion-aggregator';
import { detectCrossTrainingOverload } from './tri-cross-training-overload';
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { getDefaultState } from '@/state/store';
import { loadForBike } from '@/workouts/bike';
import { loadForSwim } from '@/workouts/swim';
import type { SimulatorState, Workout } from '@/types/state';
import type { Discipline } from '@/types/triathlon';

type Plan = { label: string; distance: string; disciplines?: Discipline[] };
const PLANS: Plan[] = [
  { label: 'Ironman', distance: 'ironman' },
  { label: '70.3', distance: '70.3' },
  { label: 'olympic', distance: 'olympic' },
  { label: 'sprint', distance: 'sprint' },
  { label: 'cycling (bike only)', distance: '70.3', disciplines: ['bike'] },
];

function generated(p: Plan): SimulatorState {
  const s = {
    ...getDefaultState(),
    eventType: 'triathlon',
    w: 1,
    tw: 20,
    v: 50,
    pac: { e: 300, t: 250, i: 230, m: 275, r: 200 },
    wks: [],
    triConfig: {
      distance: p.distance,
      timeAvailableHoursPerWeek: 12,
      volumeSplit: p.disciplines ? { swim: 0, bike: 1, run: 0 } : { swim: 0.175, bike: 0.475, run: 0.35 },
      ...(p.disciplines ? { disciplines: p.disciplines } : {}),
      skillRating: { swim: 3, bike: 3, run: 3 },
      bike: { hasPowerMeter: true, ftp: 220 },
      swim: { cssSecPer100m: 100 },
      weeksToRace: 20,
    },
  } as unknown as SimulatorState;
  s.wks = generateTriathlonPlan(s);
  return s;
}

const allSessions = (s: SimulatorState): Workout[] => (s.wks ?? []).flatMap(wk => wk.triWorkouts ?? []);
const firstOfType = (s: SimulatorState, t: string): Workout | undefined => allSessions(s).find(w => w.t === t);

describe('canApplyTriSuggestion', () => {
  const s = generated(PLANS[1]);

  it('a brick takes only a trim; off-ladder kinds take a downgrade and a trim, no swap', () => {
    const sprint = generated(PLANS[3]); // generates every off-ladder bike kind but hills
    const brick = firstOfType(sprint, 'brick')!;
    expect(brick).toBeDefined();
    expect(canApplyTriSuggestion(brick, 'swap_easy')).toBe(false);
    expect(canApplyTriSuggestion(brick, 'downgrade_today')).toBe(false);
    expect(canApplyTriSuggestion(brick, 'trim_volume')).toBe(true);
    for (const t of ['bike_vo2_micros', 'bike_over_under']) {
      const w = firstOfType(sprint, t)!;
      expect(w, t).toBeDefined();
      expect(canApplyTriSuggestion(w, 'swap_easy'), t).toBe(false);
      expect(canApplyTriSuggestion(w, 'downgrade_today'), t).toBe(true);
      expect(canApplyTriSuggestion(w, 'trim_volume'), t).toBe(true);
    }
    // Neuromuscular sprints price below sweet spot (loadForBike 1.10 vs 1.5
    // TSS/min): the mapped step would add load, so no downgrade is offered.
    const vlamax = firstOfType(sprint, 'bike_vlamax')!;
    expect(vlamax).toBeDefined();
    expect(canApplyTriSuggestion(vlamax, 'downgrade_today')).toBe(false);
    expect(canApplyTriSuggestion(vlamax, 'trim_volume')).toBe(true);
  });

  it('a session on the bottom rung takes a swap (shorter) but no downgrade', () => {
    const tech = { id: 'x', t: 'swim_technique', discipline: 'swim', n: 'T', d: '30min', r: 3, estimatedDurationMin: 30 } as Workout;
    expect(canApplyTriSuggestion(tech, 'downgrade_today')).toBe(false);
    expect(canApplyTriSuggestion(tech, 'swap_easy')).toBe(true);
    const rec = { id: 'y', t: 'recovery', discipline: 'run', n: 'R', d: '30min', r: 3, estimatedDurationMin: 30 } as Workout;
    expect(canApplyTriSuggestion(rec, 'downgrade_today')).toBe(false);
    expect(canApplyTriSuggestion(rec, 'swap_easy')).toBe(true);
  });

  it('a session without planned minutes takes nothing', () => {
    const w = { id: 'z', t: 'bike_threshold', discipline: 'bike', n: 'B', d: '2×20min', r: 8 } as Workout;
    for (const a of ['swap_easy', 'downgrade_today', 'trim_volume'] as const) expect(canApplyTriSuggestion(w, a)).toBe(false);
  });

  it('agrees with applyTriSuggestions on every generated session and action', () => {
    for (const p of PLANS) {
      const base = generated(p);
      for (const [wi, wk] of base.wks.entries()) {
        for (const [si, w] of (wk.triWorkouts ?? []).entries()) {
          for (const action of ['swap_easy', 'downgrade_today', 'trim_volume'] as const) {
            const s = structuredClone(base);
            const target = s.wks[wi].triWorkouts![si];
            const mod: TriSuggestionMod = { id: 'm', source: 'readiness', discipline: 'run', headline: 'h', body: 'b', severity: 'caution', targetWorkoutId: target.id, action };
            const r = applyTriSuggestions(s, [mod]);
            expect(r.applied === 1, `${p.label} wk${wi + 1} ${w.t} ${action}`).toBe(canApplyTriSuggestion(w, action));
          }
        }
      }
    }
  });
});

describe('cross-training overload proposes only changes the apply step makes', () => {
  it('every Reduce and Replace proposal in generated plans applies in full', () => {
    let proposals = 0;
    for (const p of PLANS) {
      const base = generated(p);
      for (let wi = 0; wi < base.wks.length; wi++) {
        const s = structuredClone(base);
        s.w = wi + 1;
        // 220 TSS of padel on top of the week (iTrimp 33000).
        s.wks[wi].adhocWorkouts = [{ id: 'padel', t: 'cross', n: 'padel', d: '150min', r: 7, iTrimp: 33000 } as any];
        const o = detectCrossTrainingOverload(s, 0);
        if (!o) continue;
        for (const d of ['swim', 'bike', 'run'] as const) {
          for (const set of [o.options[d].reduceMods, o.options[d].replaceMods]) {
            if (set.length === 0) continue;
            const c = structuredClone(s);
            const mods: TriSuggestionMod[] = set.map((a, i) => ({
              id: `xt_${d}_${i}`, source: 'cross_training_overload', discipline: a.discipline,
              headline: a.workoutLabel, body: '', severity: 'caution', targetWorkoutId: a.workoutId, action: a.action,
            }));
            const r = applyTriSuggestions(c, mods);
            proposals += set.length;
            expect(r.skipped, `${p.label} wk${wi + 1} ${d}: ${set.map(a => `${a.workoutLabel}:${a.action}`).join(', ')}`).toBe(0);
          }
        }
      }
    }
    expect(proposals).toBeGreaterThan(500);
  });

  it('an off-ladder quality session takes a downgrade and hands the swap to the next session that can take it', () => {
    const s = {
      eventType: 'triathlon', w: 1,
      triConfig: { distance: 'ironman', bike: { ftp: 220, hasPowerMeter: true } },
      wks: [{
        triWorkouts: [
          { id: 'mon-brick', t: 'brick', n: 'Brick', d: '90min bike + 20min run', r: 7, discipline: 'bike', aerobic: 120, anaerobic: 20, dayOfWeek: 0, estimatedDurationMin: 110 },
          // Priced as the generator prices it (loadForBike), above the threshold rung it steps to.
          { id: 'tue-micro', t: 'bike_vo2_micros', n: 'VO2 micros', d: '3×10×30/30', r: 9, discipline: 'bike', ...loadForBike('vo2_micros', 60), dayOfWeek: 1, estimatedDurationMin: 60 },
          { id: 'thu-thr', t: 'bike_threshold', n: 'Threshold ride', d: '2×20min @ 213–227W', r: 8, discipline: 'bike', aerobic: 80, anaerobic: 25, dayOfWeek: 3, estimatedDurationMin: 75 },
          { id: 'sat-end', t: 'bike_endurance', n: 'Long ride', d: '4h', r: 5, discipline: 'bike', aerobic: 200, anaerobic: 20, dayOfWeek: 5, estimatedDurationMin: 240 },
        ],
        adhocWorkouts: [{ id: 'spin', t: 'cross', n: 'spin class', d: '90min', r: 7, iTrimp: 33000 }],
      }],
    } as unknown as SimulatorState;
    const o = detectCrossTrainingOverload(s, 0)!;
    expect(o).not.toBeNull();
    const ids = (set: { workoutId: string }[]) => set.map(a => a.workoutId);
    expect(ids(o.options.bike.reduceMods)).not.toContain('mon-brick');
    expect(ids(o.options.bike.replaceMods)).not.toContain('mon-brick');
    expect(o.options.bike.reduceMods.find(a => a.workoutId === 'tue-micro')).toMatchObject({ action: 'downgrade_today' });
    expect(o.options.bike.replaceMods.find(a => a.workoutId === 'tue-micro')).toMatchObject({ action: 'downgrade_today' });
    expect(o.options.bike.replaceMods.find(a => a.action === 'swap_easy')).toMatchObject({ workoutId: 'thu-thr' });
  });
});

describe('readiness and RPE rows skip sessions the apply step cannot change', () => {
  afterEach(() => { vi.useRealTimers(); });

  function wednesday(today: Workout): SimulatorState {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0)); // local Wednesday (dow 2)
    const disc = { ctl: 70, atl: 56, tsb: 14, directCount: 5 };
    return {
      eventType: 'triathlon',
      w: 1,
      physiologyHistory: [],
      // Heavy leg load floors readiness (readiness gate fires).
      recentLegLoads: [{ load: 80, sport: 'strength', sportLabel: 'Strength', timestampMs: Date.now(), recoveryMultOverride: 1.2 }],
      triConfig: { distance: 'ironman', fitness: { swim: { ...disc }, bike: { ...disc }, run: { ...disc } }, fitnessHistory: [{}, {}, {}, {}] },
      wks: [{
        ph: 'build',
        // Yesterday's easy run rated 8 vs a planned 4 (RPE-blown fires).
        rated: { 'tue-easy': 8 },
        triWorkouts: [
          { id: 'tue-easy', t: 'easy', n: 'Easy run', d: '40min', r: 4, rpe: 4, discipline: 'run', dayOfWeek: 1, estimatedDurationMin: 40 },
          today,
        ],
      }],
    } as unknown as SimulatorState;
  }

  it('a brick today gets no readiness or RPE row', () => {
    const s = wednesday({ id: 'wed-brick', t: 'brick', n: 'Brick', d: '90min bike + 20min run', r: 7, rpe: 7, discipline: 'bike', dayOfWeek: 2, estimatedDurationMin: 110 } as Workout);
    const r = collectTriSuggestions(s);
    expect(r.diagnostics.rpeBlown).toBe(true);
    expect(r.diagnostics.readinessLabel).not.toBeNull();
    expect(r.mods.filter(m => m.targetWorkoutId === 'wed-brick')).toEqual([]);
  });

  it('a threshold run today still gets its row', () => {
    const s = wednesday({ id: 'wed-thr', t: 'threshold', n: 'Threshold run', d: '60min', r: 8, rpe: 8, discipline: 'run', dayOfWeek: 2, estimatedDurationMin: 60 } as Workout);
    expect(collectTriSuggestions(s).mods.filter(m => m.targetWorkoutId === 'wed-thr')).toHaveLength(1);
  });

  // Generated sessions, moved to today (Wednesday). Readiness reads 'Ease Back'.
  const g703 = generated(PLANS[1]);
  const gSprint = generated(PLANS[3]);
  const todayOf = (s: SimulatorState, t: string): Workout => ({ ...firstOfType(s, t)!, id: 'wed-q', dayOfWeek: 2, status: undefined });
  const openWater = { id: 'wed-q', t: 'swim_openwater', n: 'Open water', d: '2000m continuous', r: 6, rpe: 6, discipline: 'swim', dayOfWeek: 2, estimatedDurationMin: 45 } as Workout;

  for (const [label, today, landsOn] of [
    ['a generated over-under', () => todayOf(g703, 'bike_over_under'), 'bike_sweet_spot'],
    ['a generated VO2 micros ride', () => todayOf(gSprint, 'bike_vo2_micros'), 'bike_threshold'],
    ['an open-water swim', () => openWater, 'swim_endurance'],
  ] as const) {
    it(`${label} today gets one readiness downgrade row, and it lands on ${landsOn}`, () => {
      const s = wednesday(today());
      const r = collectTriSuggestions(s);
      expect(r.diagnostics.readinessLabel).toBe('Ease Back');
      const rows = r.mods.filter(m => m.targetWorkoutId === 'wed-q');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: 'readiness', action: 'downgrade_today' });
      // The RPE-blown swap is never proposed for an off-ladder kind.
      expect(r.mods.some(m => m.action === 'swap_easy')).toBe(false);
      expect(applyTriSuggestions(s, rows).applied).toBe(1);
      expect(s.wks[0].triWorkouts![1].t).toBe(landsOn);
    });
  }

  it('the RPE-blown detector still fires on a VO2 micros day, with no swap row', () => {
    const r = collectTriSuggestions(wednesday(todayOf(gSprint, 'bike_vo2_micros')));
    expect(r.diagnostics.rpeBlown).toBe(true);
    expect(r.mods.map(m => m.action)).toEqual(['downgrade_today']);
  });

  it('a neuromuscular sprint today gets no row (quality, but sweet spot would add load)', () => {
    const vlamax = todayOf(gSprint, 'bike_vlamax');
    expect(isTriQualitySession(vlamax)).toBe(true);
    const r = collectTriSuggestions(wednesday(vlamax));
    expect(r.diagnostics.readinessLabel).toBe('Ease Back');
    expect(r.mods.filter(m => m.targetWorkoutId === 'wed-q')).toEqual([]);
  });
});

describe('isTriQualitySession', () => {
  it('counts the type keywords and every off-ladder kind the gate lands a downgrade for', () => {
    const w = (t: string) => ({ t } as Workout);
    for (const t of ['bike_threshold', 'bike_sweet_spot', 'bike_tempo', 'bike_vo2', 'swim_threshold', 'swim_speed', 'threshold', 'vo2', 'brick',
      'bike_over_under', 'bike_vlamax', 'bike_hills', 'bike_vo2_micros', 'swim_openwater']) {
      expect(isTriQualitySession(w(t)), t).toBe(true);
    }
    for (const t of ['bike_endurance', 'swim_endurance', 'swim_technique', 'easy', 'long', 'recovery', 'gym', 'cross']) {
      expect(isTriQualitySession(w(t)), t).toBe(false);
    }
  });
});

describe('cross-training overload: off-ladder quality sessions take a downgrade priced at its landing rung', () => {
  const ouLoad = loadForBike('over_under', 75);
  function week(extra: Workout[] = []): SimulatorState {
    return {
      eventType: 'triathlon', w: 1,
      triConfig: { distance: 'ironman', bike: { ftp: 220, hasPowerMeter: true }, swim: { cssSecPer100m: 100 } },
      wks: [{
        triWorkouts: [
          // Priced as the generator prices it (loadForBike).
          { id: 'tue-ou', t: 'bike_over_under', n: 'Over-unders', d: '3×(2min @ 95% / 1min @ 105%)', r: 8, discipline: 'bike', ...ouLoad, dayOfWeek: 1, estimatedDurationMin: 75 },
          { id: 'thu-thr', t: 'bike_threshold', n: 'Threshold ride', d: '2×20min @ 213–227W', r: 8, discipline: 'bike', ...loadForBike('threshold', 75), dayOfWeek: 3, estimatedDurationMin: 75 },
          { id: 'sat-end', t: 'bike_endurance', n: 'Long ride', d: '4h', r: 5, discipline: 'bike', ...loadForBike('endurance', 240), dayOfWeek: 5, estimatedDurationMin: 240 },
          ...extra,
        ],
        adhocWorkouts: [{ id: 'spin', t: 'cross', n: 'spin class', d: '90min', r: 7, iTrimp: 33000 }],
      }],
    } as unknown as SimulatorState;
  }

  it('an over-under takes downgrade_today, not trim_volume, in Reduce and Replace; the swap goes to the threshold ride', () => {
    const s = week();
    const o = detectCrossTrainingOverload(s, 0)!;
    expect(o).not.toBeNull();
    const reduce = o.options.bike.reduceMods.find(a => a.workoutId === 'tue-ou');
    const replace = o.options.bike.replaceMods.find(a => a.workoutId === 'tue-ou');
    expect(reduce).toMatchObject({ action: 'downgrade_today' });
    expect(replace).toMatchObject({ action: 'downgrade_today' });
    expect(o.options.bike.replaceMods.find(a => a.action === 'swap_easy')).toMatchObject({ workoutId: 'thu-thr' });
    // -N TSS = stored load minus sweet spot at 75 min (124 -> 112 after rounding), not a flat 25% (31).
    const ss = loadForBike('sweet_spot', 75);
    const expected = ouLoad.aerobic + ouLoad.anaerobic - (ss.aerobic + ss.anaerobic);
    expect(reduce!.tssReduction).toBe(expected);
    expect(replace!.tssReduction).toBe(expected);
    // ... and that is what accepting it takes off the plan.
    const c = structuredClone(s);
    const mod: TriSuggestionMod = { id: 'x', source: 'cross_training_overload', discipline: 'bike', headline: '', body: '', severity: 'caution', targetWorkoutId: 'tue-ou', action: 'downgrade_today' };
    expect(applyTriSuggestions(c, [mod]).applied).toBe(1);
    const w = c.wks[0].triWorkouts![0];
    expect(w.t).toBe('bike_sweet_spot');
    expect(ouLoad.aerobic + ouLoad.anaerobic - ((w.aerobic ?? 0) + (w.anaerobic ?? 0))).toBe(reduce!.tssReduction);
  });

  it('an open-water swim takes downgrade_today in the swim option set', () => {
    const o = detectCrossTrainingOverload(week([
      { id: 'wed-ow', t: 'swim_openwater', n: 'Open water', d: '2000m continuous', r: 6, discipline: 'swim', aerobic: 54, anaerobic: 6, dayOfWeek: 2, estimatedDurationMin: 45 } as Workout,
    ]), 0)!;
    const ow = o.options.swim.reduceMods.find(a => a.workoutId === 'wed-ow');
    // 60 stored -> endurance swim at 45 min (loadForSwim: 41 + 5 after rounding).
    const end = loadForSwim('endurance', 45);
    expect(ow).toMatchObject({ action: 'downgrade_today', tssReduction: 60 - (end.aerobic + end.anaerobic) });
  });

  it('a neuromuscular sprint is quality with no downgrade, so it is not proposed', () => {
    const vlamax = { ...firstOfType(generated(PLANS[3]), 'bike_vlamax')!, id: 'mon-vl', dayOfWeek: 0, status: undefined } as Workout;
    const o = detectCrossTrainingOverload(week([vlamax]), 0)!;
    for (const set of [o.options.bike.reduceMods, o.options.bike.replaceMods]) {
      expect(set.map(a => a.workoutId)).not.toContain('mon-vl');
    }
  });

  it('a downgrade that would not lower the stored load (stale, effort-scaled minutes) books no reduction and is not proposed', () => {
    // Minutes x1.05 as applyTriEffortMultipliers leaves them, load not re-priced:
    // threshold at 63 min (107) is above the 105 stored.
    const micro = { id: 'mon-mi', t: 'bike_vo2_micros', n: 'VO2 micros', d: '3×10×30/30', r: 9, discipline: 'bike', ...loadForBike('vo2_micros', 60), dayOfWeek: 0, estimatedDurationMin: 63 } as Workout;
    expect(canApplyTriSuggestion(micro, 'downgrade_today')).toBe(true);
    expect(triDowngradeTssReduction(micro)).toBe(0);
    const o = detectCrossTrainingOverload(week([micro]), 0)!;
    for (const set of [o.options.bike.reduceMods, o.options.bike.replaceMods]) {
      expect(set.map(a => a.workoutId)).not.toContain('mon-mi');
    }
  });

  it('every downgrade proposed in generated plans shows the TSS the apply step takes off', () => {
    let downgrades = 0;
    for (const p of PLANS) {
      const base = generated(p);
      for (let wi = 0; wi < base.wks.length; wi++) {
        const s = structuredClone(base);
        s.w = wi + 1;
        s.wks[wi].adhocWorkouts = [{ id: 'padel', t: 'cross', n: 'padel', d: '150min', r: 7, iTrimp: 33000 } as any];
        const o = detectCrossTrainingOverload(s, 0);
        if (!o) continue;
        for (const d of ['swim', 'bike', 'run'] as const) {
          for (const set of [o.options[d].reduceMods, o.options[d].replaceMods]) {
            set.forEach((a, i) => {
              if (a.action !== 'downgrade_today') return;
              const c = structuredClone(s);
              const w = c.wks[wi].triWorkouts!.find(x => x.id === a.workoutId)!;
              const before = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
              const mod: TriSuggestionMod = { id: 'x', source: 'cross_training_overload', discipline: a.discipline, headline: '', body: '', severity: 'caution', targetWorkoutId: a.workoutId, action: a.action };
              expect(applyTriSuggestions(c, [mod]).applied).toBe(1);
              const taken = before - ((w.aerobic ?? 0) + (w.anaerobic ?? 0));
              const where = `${p.label} wk${wi + 1} ${a.workoutLabel}`;
              expect(a.tssReduction, where).toBeGreaterThan(0);
              // Equal; the last adjustment of a set can be cut to the budget left.
              if (i < set.length - 1) expect(a.tssReduction, where).toBe(taken);
              else expect(a.tssReduction, where).toBeLessThanOrEqual(taken);
              downgrades += 1;
            });
          }
        }
      }
    }
    expect(downgrades).toBeGreaterThan(50);
  });
});
