import { describe, it, expect } from 'vitest';
import { applyTriSuggestions } from './tri-suggestion-apply';
import type { TriSuggestionMod } from './tri-suggestion-aggregator';
import type { SimulatorState, Workout, Week } from '@/types/state';
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { isActivityCompatibleWithSlot } from './matching';
import { plannedTssPerMin } from '@/constants';
import { loadForBike } from '@/workouts/bike';
import { loadForSwim } from '@/workouts/swim';
import { getPlannedDayTSSContext } from '@/ui/planned-day-tss';
import { getDefaultState } from '@/state/store';

function workout(id: string, t: string, discipline: 'swim' | 'bike' | 'run', durMin = 60): Workout {
  return { id, t, discipline, n: 'Test', d: `${durMin}min`, r: 5, estimatedDurationMin: durMin };
}

function state(workouts: Workout[]): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 1,
    wks: [{ triWorkouts: workouts }],
    triConfig: { distance: 'ironman' },
  } as unknown as SimulatorState;
}

describe('applyTriSuggestions', () => {
  it('swap_easy replaces a quality session with endurance + cuts duration', () => {
    const s = state([workout('w1', 'bike_threshold', 'bike', 60)]);
    const mod: TriSuggestionMod = {
      id: 'm1', source: 'rpe_blown', discipline: 'bike',
      headline: 'Test', body: 'Test',
      severity: 'caution',
      targetWorkoutId: 'w1',
      action: 'swap_easy',
    };
    const r = applyTriSuggestions(s, [mod]);
    expect(r.applied).toBe(1);
    const w = s.wks![0].triWorkouts![0];
    expect(w.status).toBe('replaced');
    expect(w.t).toBe('bike_endurance');
    expect(w.estimatedDurationMin).toBe(45);  // 60 × 0.75
    expect(w.originalName).toBeDefined();
  });

  it('downgrade_today drops one tier (vo2 → threshold)', () => {
    const s = state([workout('w1', 'bike_vo2', 'bike', 60)]);
    const mod: TriSuggestionMod = {
      id: 'm1', source: 'readiness', discipline: 'bike',
      headline: 'Test', body: 'Test',
      severity: 'caution',
      targetWorkoutId: 'w1',
      action: 'downgrade_today',
    };
    applyTriSuggestions(s, [mod]);
    const w = s.wks![0].triWorkouts![0];
    expect(w.status).toBe('reduced');
    expect(w.t).toBe('bike_threshold');
  });

  it('trim_volume reduces duration by 15%', () => {
    const s = state([workout('w1', 'bike_endurance', 'bike', 200)]);
    const mod: TriSuggestionMod = {
      id: 'm1', source: 'volume_ramp', discipline: 'bike',
      headline: 'Test', body: 'Test',
      severity: 'caution',
      targetWorkoutId: 'w1',
      action: 'trim_volume',
    };
    applyTriSuggestions(s, [mod]);
    const w = s.wks![0].triWorkouts![0];
    expect(w.status).toBe('reduced');
    expect(w.estimatedDurationMin).toBe(170);  // 200 × 0.85
  });

  it('skips mods without a targetWorkoutId', () => {
    const s = state([workout('w1', 'bike_endurance', 'bike')]);
    const mod: TriSuggestionMod = {
      id: 'm1', source: 'volume_ramp', discipline: 'bike',
      headline: 'Test', body: 'Test',
      severity: 'caution',
      action: 'trim_volume',  // no targetWorkoutId
    };
    const r = applyTriSuggestions(s, [mod]);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
  });
});

// ─── Real generated sessions (tri + cycling share this path) ───────────────
// Regression for the accepted-suggestion path: a private substring ladder
// skipped or invented intensity steps (run threshold → 'tempo', swim threshold
// → running 'tempo', bike threshold → tempo, sweet spot → endurance), marked
// off-ladder bike kinds 'reduced' with nothing changed, never rewrote RPE, and
// kept the old load and the old watts/pace text after every change.

const FTP = 220;
const CSS = 100; // sec/100m

function realTriState(distance: '70.3' | 'ironman'): SimulatorState {
  const s = {
    ...getDefaultState(),
    eventType: 'triathlon',
    w: 1,
    tw: 20,
    v: 50,
    pac: { e: 300, t: 250, i: 230, m: 275, r: 200 },
    wks: [],
    triConfig: {
      distance,
      timeAvailableHoursPerWeek: 12,
      volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: 3 },
      bike: { hasPowerMeter: true, ftp: FTP },
      swim: { cssSecPer100m: CSS },
      weeksToRace: 20,
    },
  } as unknown as SimulatorState;
  s.wks = generateTriathlonPlan(s);
  return s;
}

/** First generated session of type `t`, with the state's current week moved
 *  to the week it sits in (so planned-day reads see it as this week). */
function sessionOf(s: SimulatorState, t: string): { w: Workout; wk: Week; weekNo: number } {
  const weeks = s.wks ?? [];
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i].triWorkouts?.find(x => x.t === t);
    if (w) { s.w = i + 1; return { w, wk: weeks[i], weekNo: i + 1 }; }
  }
  throw new Error(`no generated ${t} session`);
}

const modFor = (w: Workout, action: TriSuggestionMod['action'], source: TriSuggestionMod['source'] = 'readiness'): TriSuggestionMod => ({
  id: `m-${w.id}`, source, discipline: (w.discipline ?? 'run') as any,
  headline: 'h', body: 'b', severity: 'caution', targetWorkoutId: w.id, action,
});

const load = (w: Workout) => (w.aerobic ?? 0) + (w.anaerobic ?? 0);
const watts = (d: string) => [...d.matchAll(/(\d+)–(\d+)\s*W/g)].map(m => [Number(m[1]), Number(m[2])]);

describe('applyTriSuggestions — canonical ladders on real tri sessions', () => {
  it('run threshold downgrade → marathon_pace, RPE 6, run-slot compatible, canonical load', () => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, 'threshold');
    const min = w.estimatedDurationMin!;
    const r = applyTriSuggestions(s, [modFor(w, 'downgrade_today')]);
    expect(r.applied).toBe(1);
    expect(w.t).toBe('marathon_pace');
    expect(w.rpe).toBe(6);
    expect(w.r).toBe(6);
    expect(w.status).toBe('reduced');
    expect(isActivityCompatibleWithSlot('run', w)).toBe(true);
    expect(load(w)).toBe(Math.round(plannedTssPerMin('marathon_pace') * min));
    // Work reps now carry marathon pace; the easy warm-up stays easy.
    expect(w.d).toMatch(/@ MP \(4:3\d\/km\)/);
    expect(w.d).toMatch(/warm up @ 4:59\/km/);
  });

  it('swim threshold downgrade → swim_endurance, swim compatible, endurance pace and load', () => {
    const s = realTriState('ironman');
    const { w } = sessionOf(s, 'swim_threshold');
    const min = w.estimatedDurationMin!;
    applyTriSuggestions(s, [modFor(w, 'downgrade_today')]);
    expect(w.t).toBe('swim_endurance');
    expect(w.intensityLevel).toBe('swim_endurance');
    expect(isActivityCompatibleWithSlot('swim', w)).toBe(true);
    // CSS 1:40 + 6 s (endurance rung offset) = 1:46/100m; the (CSS) tag goes.
    expect(w.d).toContain('1:46/100m');
    expect(w.d).not.toContain('(CSS)');
    expect(w.rpe).toBe(5);
    const expected = loadForSwim('endurance', min);
    expect(w.aerobic).toBe(expected.aerobic);
    expect(w.anaerobic).toBe(expected.anaerobic);
  });

  it('bike threshold downgrade → bike_sweet_spot, watts × 0.91, sweet-spot load', () => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, 'bike_threshold');
    const min = w.estimatedDurationMin!;
    const before = watts(w.d!);
    expect(before.length).toBeGreaterThan(0);
    applyTriSuggestions(s, [modFor(w, 'downgrade_today')]);
    expect(w.t).toBe('bike_sweet_spot');
    expect(w.intensityLevel).toBe('bike_sweet_spot');
    expect(w.originalIntensityLevel).toBeNull();
    expect(w.rpe).toBe(7);
    expect(watts(w.d!)).toEqual(before.map(([lo, hi]) => [Math.round(lo * 0.91), Math.round(hi * 0.91)]));
    const expected = loadForBike('sweet_spot', min);
    expect(w.aerobic).toBe(expected.aerobic);
    expect(w.anaerobic).toBe(expected.anaerobic);
  });

  it('bike sweet spot downgrade → bike_tempo (one rung, not endurance)', () => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, 'bike_sweet_spot');
    const min = w.estimatedDurationMin!;
    applyTriSuggestions(s, [modFor(w, 'downgrade_today')]);
    expect(w.t).toBe('bike_tempo');
    const expected = loadForBike('tempo', min);
    expect(load(w)).toBe(expected.aerobic + expected.anaerobic);
  });

  it('bike over-under (off the ladder) is left untouched and counted as skipped', () => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, 'bike_over_under');
    const snapshot = structuredClone(w);
    const r = applyTriSuggestions(s, [modFor(w, 'downgrade_today')]);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
    expect(w.status).not.toBe('reduced');
    expect(w).toEqual(snapshot);
  });

  it('swap_easy on a 50-min threshold run → easy, 38 min, 35 TSS', () => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, 'threshold');
    // Same generated session at 50 min, priced as the generator prices it.
    w.estimatedDurationMin = 50;
    const total = 50 * plannedTssPerMin('threshold');
    w.aerobic = Math.round(total * 0.77);
    w.anaerobic = Math.round(total * 0.23);
    applyTriSuggestions(s, [modFor(w, 'swap_easy', 'rpe_blown')]);
    expect(w.t).toBe('easy');
    expect(w.status).toBe('replaced');
    expect(w.estimatedDurationMin).toBe(38);
    expect(load(w)).toBe(35);
    expect(w.rpe).toBe(3);
    // Reps now at the generator's easy pace (same source as the warm-up);
    // no threshold pace left in the description.
    expect(w.d).not.toContain('4:20/km');
    expect(w.d).toMatch(/×\d+min @ 4:59\/km/);
  });

  it('swap_easy on the long run keeps the long-run type and name, 25% shorter', () => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, 'long');
    const min = w.estimatedDurationMin!;
    const name = w.n;
    applyTriSuggestions(s, [modFor(w, 'swap_easy', 'rpe_blown')]);
    expect(w.t).toBe('long');
    expect(w.n).toBe(name);
    expect(w.estimatedDurationMin).toBe(Math.round(min * 0.75));
    expect(load(w)).toBe(Math.round(plannedTssPerMin('long') * Math.round(min * 0.75)));
  });

  it('a brick (two disciplines, no single ladder) is left untouched and counted as skipped', () => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, 'brick');
    const snapshot = structuredClone(w);
    const r = applyTriSuggestions(s, [modFor(w, 'swap_easy', 'rpe_blown'), modFor(w, 'downgrade_today')]);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(2);
    expect(w).toEqual(snapshot);
  });

  it('a session already on the bottom rung is not marked reduced', () => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, 'bike_endurance');
    const snapshot = structuredClone(w);
    const r = applyTriSuggestions(s, [modFor(w, 'downgrade_today')]);
    expect(r.skipped).toBe(1);
    expect(w).toEqual(snapshot);
  });

  it('swap_easy on a bike threshold session drops watts to the endurance rung', () => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, 'bike_threshold');
    const before = watts(w.d!);
    const min = w.estimatedDurationMin!;
    applyTriSuggestions(s, [modFor(w, 'swap_easy', 'readiness')]);
    expect(w.t).toBe('bike_endurance');
    expect(w.n).toBe('Easy Bike');
    expect(w.estimatedDurationMin).toBe(Math.round(min * 0.75));
    expect(watts(w.d!)).toEqual(before.map(([lo, hi]) => [Math.round(lo * 0.65), Math.round(hi * 0.65)]));
    const expected = loadForBike('endurance', Math.round(min * 0.75));
    expect(load(w)).toBe(expected.aerobic + expected.anaerobic);
  });

  it('trim scales load with duration (180 → 153 min)', () => {
    const s = realTriState('ironman');
    const { w } = sessionOf(s, 'bike_endurance');
    w.estimatedDurationMin = 180;
    w.aerobic = 150;
    w.anaerobic = 8; // 158 TSS at 180 min
    applyTriSuggestions(s, [modFor(w, 'trim_volume', 'volume_ramp')]);
    expect(w.estimatedDurationMin).toBe(153);
    expect(w.status).toBe('reduced');
    expect(load(w)).toBe(Math.round(150 * 153 / 180) + Math.round(8 * 153 / 180)); // 128 + 7 = 135, ≈ 158 × 0.85
    expect(Math.abs(load(w) - 158 * 153 / 180)).toBeLessThanOrEqual(1);
  });

  it("getPlannedDayTSSContext reads the downgraded session's new load for that day", () => {
    const s = realTriState('70.3');
    const { w, wk, weekNo } = sessionOf(s, 'bike_threshold');
    const day = w.dayOfWeek!;
    const others = (wk.triWorkouts ?? []).filter(x => x !== w && x.dayOfWeek === day).reduce((a, x) => a + load(x), 0);
    const before = getPlannedDayTSSContext(s, weekNo).plannedTSSForDay(day);
    expect(before).toBe(others + load(w));
    applyTriSuggestions(s, [modFor(w, 'downgrade_today')]);
    const after = getPlannedDayTSSContext(s, weekNo).plannedTSSForDay(day);
    expect(after).toBe(others + load(w));
    expect(after).toBeLessThan(before);
  });
});
