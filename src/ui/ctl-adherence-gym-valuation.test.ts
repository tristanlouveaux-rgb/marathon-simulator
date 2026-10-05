/**
 * Running CTL-gap re-anchor: completing the plan exactly never reads as behind.
 *
 * resolveCtlAdherence compares Signal A actual load (computeWeekTSS: every
 * activity at its own sport's runSpec) with the planned week. A planned gym
 * session was valued at full TSS while the session that filled it counted at the
 * strength runSpec, so an athlete who did every session as prescribed read as
 * behind and next week's volume was cut (ctlGapMultiplier is reduce-only with no
 * dead zone). The planned side now values gym sessions at the strength runSpec.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveCtlAdherence } from './planned-day-tss';
import { resolveWeekWorkouts } from './week-resolve';
import { computePlannedDaySignalBTSS, estimateWorkoutDurMin, getAthleteNormalizer, setAthleteNormalizer } from '@/calculations/fitness-model';
import { setState, resetState, getDefaultState } from '@/state/store';
import type { SimulatorState, GarminActual } from '@/types';

const BASE_MIN_PER_KM = 330 / 60;

function runningState(): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'running',
    w: 2,
    tw: 18,
    rw: 3,
    rd: 'marathon',
    typ: 'balanced',
    v: 40,
    gs: 2,
    pac: { e: 330 },
    ctlBaseline: 300,
    planStartDate: '2026-03-02',
    wks: [
      { w: 1, ph: 'base', rated: {}, skip: [], garminActuals: {} },
      { w: 2, ph: 'base', rated: {}, skip: [], garminActuals: {} },
    ],
  } as unknown as SimulatorState;
}

/**
 * Fill every planned session of week 1 exactly as prescribed, the way the real
 * matchers write it: runs carry workoutName + RUNNING and HR load equal to the
 * planned TSS; gym slots carry the watch label as displayName and the RPE in
 * wk.rated (activity-review gym slot fill).
 */
function completeWeekOneAsPlanned(s: SimulatorState, gymLabel: string): void {
  const wk = s.wks[0] as any;
  const planned = resolveWeekWorkouts(s, 1).filter((w: any) => w.t !== 'cross' && w.t !== 'rest');
  let i = 0;
  for (const w of planned as any[]) {
    const id = w.id || w.n;
    const durMin = estimateWorkoutDurMin(w, BASE_MIN_PER_KM);
    const rpe = w.rpe ?? w.r ?? 5;
    const startTime = `2026-03-0${2 + (w.dayOfWeek ?? 0)}T07:00:00Z`;
    if (w.t === 'gym') {
      wk.garminActuals[id] = {
        garminId: `strava-gym-${i++}`, startTime, distanceKm: 0, durationSec: durMin * 60,
        avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, hrZones: null,
        displayName: gymLabel,
      } as GarminActual;
      wk.rated[id] = rpe;
    } else {
      const tss = computePlannedDaySignalBTSS([w], w.dayOfWeek, BASE_MIN_PER_KM);
      wk.garminActuals[id] = {
        garminId: `strava-run-${i++}`, startTime, distanceKm: 0, durationSec: durMin * 60,
        avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: tss * getAthleteNormalizer() / 100, hrZones: null,
        workoutName: w.n, activityType: 'RUNNING',
      } as GarminActual;
      wk.rated[id] = rpe;
    }
  }
}

describe('CTL adherence values planned gym sessions in Signal A terms', () => {
  beforeEach(() => { resetState(); setAthleteNormalizer(); });

  it('the fixture plan has gym sessions to complete', () => {
    const s = runningState();
    setState(s);
    expect(resolveWeekWorkouts(s, 1).some((w: any) => w.t === 'gym')).toBe(true);
  });

  for (const label of ['Strength', 'HIIT']) {
    it(`completing every session, gym filled by a watch "${label}", is not behind plan`, () => {
      const s = runningState();
      setState(s);
      completeWeekOneAsPlanned(s, label);
      const adh = resolveCtlAdherence(s, 1);
      expect(adh.valid).toBe(true);
      // Planned per-session TSS is rounded to whole numbers, actual is not: allow that rounding only.
      expect(adh.ratio).toBeGreaterThan(0.995);
      expect(Math.abs(adh.pctOfPlanned - 100)).toBeLessThanOrEqual(1);
    });
  }

  it('skipping both gym sessions still reads as a (smaller) shortfall', () => {
    const s = runningState();
    setState(s);
    completeWeekOneAsPlanned(s, 'Strength');
    const wk = s.wks[0] as any;
    for (const id of Object.keys(wk.garminActuals)) {
      if (wk.garminActuals[id].displayName === 'Strength') { delete wk.garminActuals[id]; delete wk.rated[id]; }
    }
    expect(resolveCtlAdherence(s, 1).ratio).toBeLessThan(1);
  });
});
