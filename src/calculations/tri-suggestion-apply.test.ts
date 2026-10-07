import { describe, it, expect } from 'vitest';
import { applyTriSuggestions } from './tri-suggestion-apply';
import type { TriSuggestionMod } from './tri-suggestion-aggregator';
import type { SimulatorState, Workout, Week } from '@/types/state';
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { isActivityCompatibleWithSlot } from './matching';
import { plannedTssPerMin } from '@/constants';
import { describeBikeSession, loadForBike, rpeForBike } from '@/workouts/bike';
import { loadForSwim, rpeForSwim } from '@/workouts/swim';
import { canApplyTriSuggestion } from './tri-suggestion-apply';
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
    expect(w.status).toBe('reduced');
    expect(w.modReason).toBe('Swapped to easy: high RPE yesterday');
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

function realTriState(distance: 'sprint' | '70.3' | 'ironman'): SimulatorState {
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
    expect(w.status).toBe('reduced');
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

// ─── Sessions without estimatedDurationMin ─────────────────────────────────
// Regression (review of a2): minutesOf returned 0, so setRung / setRunType
// skipped re-pricing. A bike_threshold with no duration became bike_endurance
// with watts x0.65 and kept its threshold load. With no minutes to price the
// new prescription at, the session is now left untouched and counted as
// skipped. estimateTriWorkoutMin is not used as a fallback: it reads the
// largest single "Nmin" token, so this generated 80-min threshold reads 15 min.

describe('applyTriSuggestions — sessions without estimatedDurationMin', () => {
  const noDuration = (t: string) => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, t);
    delete w.estimatedDurationMin;
    return { s, w, snapshot: structuredClone(w) };
  };

  for (const t of ['bike_threshold', 'threshold', 'swim_threshold']) {
    for (const action of ['downgrade_today', 'swap_easy'] as const) {
      it(`${t} ${action}: left untouched and counted as skipped`, () => {
        const { s, w, snapshot } = noDuration(t);
        const r = applyTriSuggestions(s, [modFor(w, action)]);
        expect(r.applied).toBe(0);
        expect(r.skipped).toBe(1);
        expect(w).toEqual(snapshot);
      });
    }
  }
});

// ─── Off-ladder bike / swim kinds (Tristan, 2026-10-06) ────────────────────
// Regression: over-unders, VO2 micro-intervals, hill and neuromuscular rides
// and open-water swims have no rung on BIKE_INTENSITY_LADDER /
// SWIM_INTENSITY_LADDER, so an accepted downgrade left them untouched and
// counted it as skipped (and the detectors never proposed one). They now step
// one category down to the rung OFF_LADDER_DOWNGRADE_RUNG maps them to, priced
// and described the way a ladder rung is (loadForRung, the generator's RPE and
// description builder).

describe('applyTriSuggestions — off-ladder downgrades', () => {
  it('bike over-under downgrade → sweet spot: generator description, RPE and load, less TSS', () => {
    const s = realTriState('70.3');
    const { w, wk, weekNo } = sessionOf(s, 'bike_over_under');
    const min = w.estimatedDurationMin!;
    const before = load(w);
    const r = applyTriSuggestions(s, [modFor(w, 'downgrade_today')]);
    expect(r.applied).toBe(1);
    expect(w.t).toBe('bike_sweet_spot');
    expect(w.intensityLevel).toBe('bike_sweet_spot');
    expect(w.originalIntensityLevel).toBeNull();
    expect(w.n).toBe('Sweet spot (downgrade)');
    expect(w.status).toBe('reduced');
    expect(w.modReason).toBe('Readiness downgrade');
    expect(w.rpe).toBe(rpeForBike('sweet_spot', wk.ph));
    expect(w.r).toBe(w.rpe);
    expect(w.d).toBe(describeBikeSession('sweet_spot', min, FTP, true, weekNo, 0));
    expect(w.d).not.toContain('→'); // over-under structure gone
    expect(isActivityCompatibleWithSlot('ride', w)).toBe(true);
    const expected = loadForBike('sweet_spot', min);
    expect(w.aerobic).toBe(expected.aerobic);
    expect(w.anaerobic).toBe(expected.anaerobic);
    expect(load(w)).toBeLessThan(before);
  });

  it('VO2 micro-intervals downgrade → threshold', () => {
    const s = realTriState('sprint');
    const { w, wk, weekNo } = sessionOf(s, 'bike_vo2_micros');
    const min = w.estimatedDurationMin!;
    const before = load(w);
    expect(applyTriSuggestions(s, [modFor(w, 'downgrade_today')]).applied).toBe(1);
    expect(w.t).toBe('bike_threshold');
    expect(w.n).toBe('Threshold intervals (downgrade)');
    expect(w.rpe).toBe(rpeForBike('threshold', wk.ph));
    expect(w.d).toBe(describeBikeSession('threshold', min, FTP, true, weekNo, 0));
    const expected = loadForBike('threshold', min);
    expect(load(w)).toBe(expected.aerobic + expected.anaerobic);
    expect(load(w)).toBeLessThan(before);
  });

  it('hill ride downgrade → sweet spot', () => {
    const hills = { ...workout('h1', 'bike_hills', 'bike', 60), ...loadForBike('hills', 60), r: 8, rpe: 8 };
    const s = state([hills]);
    expect(applyTriSuggestions(s, [modFor(hills, 'downgrade_today')]).applied).toBe(1);
    const w = s.wks![0].triWorkouts![0];
    expect(w.t).toBe('bike_sweet_spot');
    const expected = loadForBike('sweet_spot', 60);
    expect(load(w)).toBe(expected.aerobic + expected.anaerobic);
  });

  it('open-water swim downgrade → endurance swim at the endurance rung pace', () => {
    const ow: Workout = { id: 'ow1', t: 'swim_openwater', discipline: 'swim', n: 'Open water', d: '2000m continuous @ 1:40/100m', r: 6, rpe: 6, estimatedDurationMin: 45 };
    const s = { ...state([ow]), triConfig: { distance: 'ironman', swim: { cssSecPer100m: CSS }, skillRating: { swim: 3, bike: 3, run: 3 } } } as unknown as SimulatorState;
    expect(applyTriSuggestions(s, [modFor(ow, 'downgrade_today')]).applied).toBe(1);
    const w = s.wks![0].triWorkouts![0];
    expect(w.t).toBe('swim_endurance');
    expect(w.n).toBe('Endurance swim (downgrade)');
    expect(w.rpe).toBe(rpeForSwim('endurance', 'base'));
    // CSS 1:40 + 6 s (endurance rung offset) = 1:46/100m, as a ladder step writes it.
    expect(w.d).toContain('1:46/100m');
    expect(w.d).not.toContain('(CSS)');
    expect(isActivityCompatibleWithSlot('swim', w)).toBe(true);
    const expected = loadForSwim('endurance', 45);
    expect(w.aerobic).toBe(expected.aerobic);
    expect(w.anaerobic).toBe(expected.anaerobic);
  });

  it('neuromuscular sprints are not downgraded: sweet spot would add planned load', () => {
    // loadForBike prices vlamax at 1.10 TSS/min (rest-dominated) and sweet spot
    // at 1.5, so the mapped step would raise the session's TSS.
    const s = realTriState('sprint');
    const { w } = sessionOf(s, 'bike_vlamax');
    const min = w.estimatedDurationMin!;
    const ss = loadForBike('sweet_spot', min);
    expect(ss.aerobic + ss.anaerobic).toBeGreaterThan(load(w));
    expect(canApplyTriSuggestion(w, 'downgrade_today')).toBe(false);
    const snapshot = structuredClone(w);
    const r = applyTriSuggestions(s, [modFor(w, 'downgrade_today')]);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
    expect(w).toEqual(snapshot);
  });

  it('an over-under Adjusted to tempo steps to endurance, never up to sweet spot', () => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, 'bike_over_under');
    const min = w.estimatedDurationMin!;
    // What the Adjust overlay stores after one Harder tap from its endurance
    // default: the rung, priced at it, description kept.
    w.intensityLevel = 'bike_tempo';
    w.originalIntensityLevel = null;
    Object.assign(w, loadForBike('tempo', min));
    expect(applyTriSuggestions(s, [modFor(w, 'downgrade_today')]).applied).toBe(1);
    expect(w.t).toBe('bike_endurance');
    const expected = loadForBike('endurance', min);
    expect(load(w)).toBe(expected.aerobic + expected.anaerobic);
  });

  it("Adjust's baseline follows: description rebuilt and re-priced at the baseline minutes", () => {
    const s = realTriState('70.3');
    const { w, weekNo } = sessionOf(s, 'bike_over_under');
    const planMin = w.estimatedDurationMin!;
    // Adjust shortened it to 60 min and stashed the plan baseline.
    const b = w as Workout & { originalAerobic?: number; originalAnaerobic?: number };
    b.originalDistance = w.d;
    b.originalDurationMin = planMin;
    b.originalAerobic = w.aerobic;
    b.originalAnaerobic = w.anaerobic;
    w.estimatedDurationMin = 60;
    expect(applyTriSuggestions(s, [modFor(w, 'downgrade_today')]).applied).toBe(1);
    expect(w.d).toBe(describeBikeSession('sweet_spot', 60, FTP, true, weekNo, 0));
    expect(b.originalDistance).toBe(describeBikeSession('sweet_spot', planMin, FTP, true, weekNo, 0));
    const base = loadForBike('sweet_spot', planMin);
    expect(b.originalAerobic).toBe(base.aerobic);
    expect(b.originalAnaerobic).toBe(base.anaerobic);
  });

  it('a swap to easy on an off-ladder kind is still left untouched (not decided)', () => {
    const s = realTriState('70.3');
    const { w } = sessionOf(s, 'bike_over_under');
    const snapshot = structuredClone(w);
    const r = applyTriSuggestions(s, [modFor(w, 'swap_easy', 'rpe_blown')]);
    expect(r.applied).toBe(0);
    expect(w).toEqual(snapshot);
  });
});
