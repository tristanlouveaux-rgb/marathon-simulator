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
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { applyTriSuggestions, canApplyTriSuggestion } from './tri-suggestion-apply';
import { collectTriSuggestions, type TriSuggestionMod } from './tri-suggestion-aggregator';
import { detectCrossTrainingOverload } from './tri-cross-training-overload';
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { getDefaultState } from '@/state/store';
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

  it('off-ladder kinds take no swap or downgrade, only a trim', () => {
    for (const t of ['brick', 'bike_vo2_micros', 'bike_over_under']) {
      const w = firstOfType(s, t);
      if (!w) continue; // not every plan generates every kind
      expect(canApplyTriSuggestion(w, 'swap_easy'), t).toBe(false);
      expect(canApplyTriSuggestion(w, 'downgrade_today'), t).toBe(false);
      expect(canApplyTriSuggestion(w, 'trim_volume'), t).toBe(true);
    }
    expect(firstOfType(s, 'brick')).toBeDefined();
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

  it('an off-ladder quality session hands the swap to the next session that can take it', () => {
    const s = {
      eventType: 'triathlon', w: 1,
      triConfig: { distance: 'ironman', bike: { ftp: 220, hasPowerMeter: true } },
      wks: [{
        triWorkouts: [
          { id: 'mon-brick', t: 'brick', n: 'Brick', d: '90min bike + 20min run', r: 7, discipline: 'bike', aerobic: 120, anaerobic: 20, dayOfWeek: 0, estimatedDurationMin: 110 },
          { id: 'tue-micro', t: 'bike_vo2_micros', n: 'VO2 micros', d: '3×10×30/30', r: 9, discipline: 'bike', aerobic: 50, anaerobic: 30, dayOfWeek: 1, estimatedDurationMin: 60 },
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
    expect(ids(o.options.bike.reduceMods)).not.toContain('tue-micro');
    expect(o.options.bike.replaceMods[0]).toMatchObject({ workoutId: 'thu-thr', action: 'swap_easy' });
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
});
