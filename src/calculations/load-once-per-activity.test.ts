/**
 * Every activity counts exactly once per load signal, and Signal A weights it by
 * the runSpec of its OWN sport (audit B3, X7, X9; SCIENCE_LOG "Signal A vs Signal B").
 *
 * Fixtures mirror the real write sites:
 *   - overflow cross-training (activity-review autoProcessActivities):
 *     populateUnspentLoadItems + addAdhocWorkoutFromPending, which writes the
 *     adhoc entry AND a garminActuals['garmin-<id>'] twin;
 *   - cross/gym slot fills (activity-review applyReview / autoProcess): a
 *     garminActuals entry keyed by the slot id with displayName only;
 *   - run matches: workoutName + activityType;
 *   - surplus runs: an extra `<id>_surplus` unspent item on top of the match.
 *
 * Expected values are derived from SPORTS_DB and TL_PER_MIN, never hardcoded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeWeekTSS,
  computeWeekRawTSS,
  computeTodaySignalBTSS,
  computeTodayStrainTSS,
  getDailyLoadHistory,
  computeFitnessModel,
  listWeekSignalAEntries,
  computeSameSignalCtlHistory,
  computeSameSignalTSB,
  normalizeiTrimp,
  getAthleteNormalizer,
  setAthleteNormalizer,
} from './fitness-model';
import { buildDailySignalBTSS } from './sleep-insights';
import { resolveActualSport, resolveAdhocSport, signalARunSpec } from '@/cross-training/activities';
import { SPORTS_DB, TL_PER_MIN } from '@/constants';
import type { Week, GarminActual, UnspentLoadItem, Workout } from '@/types';
import type { PhysiologyDayEntry } from '@/types/state';

const PLAN_START = '2026-03-02'; // a Monday
const DAY = (offset: number, hh = '08') => {
  const d = new Date(PLAN_START + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.toISOString().slice(0, 10)}T${hh}:00:00Z`;
};

function week(w: number, parts: Partial<Week> = {}): Week {
  return {
    w,
    ph: 'build',
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
    garminActuals: {},
    adhocWorkouts: [],
    unspentLoadItems: [],
    ...parts,
  } as unknown as Week;
}

/** iTRIMP that normalises to `tss`: the exact inverse of normalizeiTrimp (getAthleteNormalizer doc). */
const itrimpFor = (tss: number) => tss * getAthleteNormalizer() / 100;

/**
 * Synced cross-training logged as overflow: the three records
 * autoProcessActivities leaves in state (activity-review.ts overflow branch).
 */
function overflow(
  id: string,
  opts: { activityType: string; label: string; sport: string; durationMin: number; tss?: number; startTime: string; t?: string },
): { key: string; actual: GarminActual; adhoc: Workout; unspent: UnspentLoadItem } {
  const key = `garmin-${id}`;
  const iTrimp = opts.tss != null ? itrimpFor(opts.tss) : null;
  return {
    key,
    actual: {
      garminId: id,
      startTime: opts.startTime,
      distanceKm: 0,
      durationSec: opts.durationMin * 60,
      avgPaceSecKm: null,
      avgHR: null,
      maxHR: null,
      calories: null,
      iTrimp,
      hrZones: null,
      displayName: opts.label,
      activityType: opts.activityType,
    } as GarminActual,
    adhoc: {
      id: key,
      t: opts.t ?? 'cross',
      n: opts.label,
      d: `${opts.durationMin}min · 4 Mar 08:00`,
      r: 5,
      rpe: 5,
      garminTimestamp: opts.startTime,
      garminDurationMin: opts.durationMin,
      iTrimp,
    } as unknown as Workout,
    unspent: {
      garminId: id,
      displayName: opts.label,
      sport: opts.sport,
      durationMin: opts.durationMin,
      aerobic: 1.5,
      anaerobic: 0.5,
      date: opts.startTime.slice(0, 10),
      reason: 'overflow',
    } as UnspentLoadItem,
  };
}

function weekWithOverflow(o: ReturnType<typeof overflow>, w = 1): Week {
  return week(w, {
    garminActuals: { [o.key]: o.actual },
    adhocWorkouts: [o.adhoc],
    unspentLoadItems: [o.unspent],
  });
}

/**
 * The same week after the Strava upgrade loop (activity-matcher.ts, "Strava
 * upgrade") has run: the twin keeps its key `garmin-<id>` but its garminId
 * becomes strava-<id> and its duration and iTRIMP come from the Strava row; the
 * adhoc entry keeps its id and only takes the Strava name and type.
 */
function stravaUpgraded(o: ReturnType<typeof overflow>, stravaId: string, durationMin?: number): Week {
  const wk = weekWithOverflow(o);
  wk.garminActuals![o.key] = {
    ...o.actual,
    garminId: stravaId,
    durationSec: (durationMin ?? o.actual.durationSec / 60) * 60,
  };
  return wk;
}

beforeEach(() => setAthleteNormalizer()); // population normaliser

const A = (wk: Week) => computeWeekTSS(wk, wk.rated ?? {}, PLAN_START);
const B = (wk: Week) => computeWeekRawTSS(wk, wk.rated ?? {}, PLAN_START);
const withoutUnspent = (wk: Week): Week => ({ ...wk, unspentLoadItems: [] } as Week);

describe('An overflow activity counts once in every signal', () => {
  const ride = overflow('strava-111', {
    activityType: 'CYCLING', label: 'Cycling', sport: 'cycling', durationMin: 60, tss: 60, startTime: DAY(2),
  });

  it('a 60-min overflow ride counts once at the cycling runSpec in Signal A, once at full TSS in Signal B', () => {
    const wk = weekWithOverflow(ride);
    expect(A(wk)).toBe(Math.round(60 * SPORTS_DB.cycling.runSpec));
    expect(B(wk)).toBe(60);
  });

  it('emptying unspentLoadItems changes neither signal (they are decision records, not load)', () => {
    const wk = weekWithOverflow(ride);
    expect(A(withoutUnspent(wk))).toBe(A(wk));
    expect(B(withoutUnspent(wk))).toBe(B(wk));
  });

  it('the ride counts once on its day in daily Signal B (strain, rolling ACWR)', () => {
    const wk = weekWithOverflow(ride);
    expect(computeTodaySignalBTSS(wk, ride.actual.startTime!.slice(0, 10))).toBe(60);
  });

  it('a swim with no HR counts at the swimming runSpec in Signal A', () => {
    const swim = overflow('apple-112', {
      activityType: 'SWIMMING', label: 'Swim', sport: 'swimming', durationMin: 45, startTime: DAY(3),
    });
    const wk = weekWithOverflow(swim);
    const raw = 45 * TL_PER_MIN[5];
    expect(B(wk)).toBe(Math.round(raw));
    expect(A(wk)).toBe(Math.round(raw * SPORTS_DB.swimming.runSpec));
  });

  it('an unmatched run logged as overflow counts once at full weight in both signals', () => {
    const run = overflow('strava-113', {
      activityType: 'RUNNING', label: 'Run', sport: 'run', durationMin: 50, tss: 50, startTime: DAY(1), t: 'easy',
    });
    const wk = weekWithOverflow(run);
    expect(A(wk)).toBe(50);
    expect(B(wk)).toBe(50);
  });
});

describe('Unspent records with no activity behind them add nothing', () => {
  const orphan: UnspentLoadItem = {
    garminId: 'strava-333', displayName: 'Tennis', sport: 'tennis', durationMin: 45,
    aerobic: 1.5, anaerobic: 0.5, date: DAY(2).slice(0, 10), reason: 'overflow',
  };

  it('an orphan left after the activity was removed counts 0 in A, B and daily B', () => {
    const wk = week(1, { unspentLoadItems: [orphan] });
    expect(A(wk)).toBe(0);
    expect(B(wk)).toBe(0);
    expect(computeTodaySignalBTSS(wk, orphan.date)).toBe(0);
  });

  it('a surplus_run slice never adds to the matched run, however many copies exist', () => {
    const matched: GarminActual = {
      garminId: 'strava-222', startTime: DAY(1), distanceKm: 20, durationSec: 6000,
      avgPaceSecKm: 300, avgHR: 150, maxHR: 170, calories: null,
      iTrimp: itrimpFor(133), hrZones: null, workoutName: 'Long Run', activityType: 'RUNNING',
    } as GarminActual;
    const surplus: UnspentLoadItem = {
      garminId: 'strava-222_surplus', displayName: 'Running', sport: 'extra_run', durationMin: 30,
      aerobic: 20, anaerobic: 2, date: DAY(1), reason: 'surplus_run',
    };
    for (const n of [0, 1, 3]) {
      const wk = week(1, { garminActuals: { 'W1-long-0': matched }, unspentLoadItems: Array(n).fill(surplus) });
      expect(A(wk)).toBe(133);
      expect(B(wk)).toBe(133);
    }
  });
});

describe('Signal A weights each activity by its own sport', () => {
  it('a tennis session filling a cross slot (displayName only, RPE 5) counts at the tennis runSpec', () => {
    const wk = week(1, {
      rated: { 'W1-cross-0': 5 },
      garminActuals: {
        'W1-cross-0': {
          garminId: 'strava-444', startTime: DAY(2), distanceKm: 0, durationSec: 3600,
          avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, hrZones: null,
          displayName: 'Tennis',
        } as GarminActual,
      },
    });
    const raw = 60 * TL_PER_MIN[5];
    expect(B(wk)).toBe(Math.round(raw));
    expect(A(wk)).toBe(Math.round(raw * SPORTS_DB.tennis.runSpec));
  });

  it('a walk recorded against a run slot counts at the walking runSpec, not as a run', () => {
    const wk = week(1, {
      rated: { 'W1-easy-1': 3 },
      garminActuals: {
        'W1-easy-1': {
          garminId: 'apple-555', startTime: DAY(3), distanceKm: 5, durationSec: 3600,
          avgPaceSecKm: 720, avgHR: null, maxHR: null, calories: null, iTrimp: null, hrZones: null,
          workoutName: 'Easy Run', activityType: 'WALKING',
        } as GarminActual,
      },
    });
    const raw = 60 * TL_PER_MIN[3];
    expect(B(wk)).toBe(Math.round(raw));
    expect(A(wk)).toBe(Math.round(raw * SPORTS_DB.walking.runSpec));
  });

  it('a gym slot filled under the plan session name counts at the strength runSpec', () => {
    const wk = week(1, {
      rated: { 'W1-gym-0': 6 },
      garminActuals: {
        'W1-gym-0': {
          garminId: 'strava-666', startTime: DAY(4), distanceKm: 0, durationSec: 2700,
          avgPaceSecKm: null, avgHR: 120, maxHR: 150, calories: null, iTrimp: itrimpFor(30), hrZones: null,
          displayName: 'Posterior Chain',
        } as GarminActual,
      },
    });
    expect(B(wk)).toBe(30);
    expect(A(wk)).toBe(Math.round(30 * SPORTS_DB.strength.runSpec));
  });

  it('a watch HIIT counts at the strength runSpec, the gym bucket the matcher files it under', () => {
    const hiit = overflow('strava-667', {
      activityType: 'HIIT', label: 'HIIT', sport: 'generic_sport', durationMin: 40, tss: 50, startTime: DAY(4), t: 'gym',
    });
    expect(A(weekWithOverflow(hiit))).toBe(Math.round(50 * SPORTS_DB.strength.runSpec));
  });

  it('a rated strength session is discounted once (the RPE override already applies the strength runSpec)', () => {
    const lift = overflow('strava-777', {
      activityType: 'STRENGTH_TRAINING', label: 'Strength', sport: 'strength', durationMin: 60, tss: 20, startTime: DAY(5), t: 'gym',
    });
    const wk = weekWithOverflow(lift);
    wk.rated = { [lift.key]: 6 };
    expect(A(wk)).toBe(Math.round(60 * TL_PER_MIN[6] * SPORTS_DB.strength.runSpec));
    expect(B(wk)).toBe(Math.round(60 * TL_PER_MIN[6]));
  });

  it('an unrated strength session with HR counts at the strength runSpec', () => {
    const lift = overflow('strava-778', {
      activityType: 'STRENGTH_TRAINING', label: 'Strength', sport: 'strength', durationMin: 60, tss: 20, startTime: DAY(5), t: 'gym',
    });
    expect(A(weekWithOverflow(lift))).toBe(Math.round(20 * SPORTS_DB.strength.runSpec));
  });

  it("the user's manual reclassification decides the sport", () => {
    const cardio = overflow('strava-779', {
      activityType: 'CARDIO', label: 'Cardio', sport: 'generic_sport', durationMin: 60, tss: 60, startTime: DAY(6),
    });
    cardio.actual.manualSport = 'padel';
    expect(A(weekWithOverflow(cardio))).toBe(Math.round(60 * SPORTS_DB.padel.runSpec));
  });

  it('a matched run counts at full weight in both signals', () => {
    const wk = week(1, {
      garminActuals: {
        'W1-easy-0': {
          garminId: 'strava-880', startTime: DAY(0), distanceKm: 10, durationSec: 3300,
          avgPaceSecKm: 330, avgHR: 140, maxHR: 160, calories: null, iTrimp: itrimpFor(60), hrZones: null,
          workoutName: 'Easy Run', activityType: 'RUNNING',
        } as GarminActual,
      },
    });
    expect(A(wk)).toBe(60);
    expect(B(wk)).toBe(60);
  });

  it('a legacy run-slot row with no activityType keeps full weight', () => {
    const wk = week(1, {
      garminActuals: {
        'W1-long-0': {
          garminId: 'garmin-881', startTime: DAY(6), distanceKm: 20, durationSec: 6600,
          avgPaceSecKm: 330, avgHR: 145, maxHR: 165, calories: null, iTrimp: itrimpFor(100), hrZones: null,
          workoutName: 'Long Run',
        } as GarminActual,
      },
    });
    expect(A(wk)).toBe(100);
  });

  it('a legacy adhoc ride with no garminActuals twin counts at the cycling runSpec', () => {
    const ride = overflow('strava-882', {
      activityType: 'CYCLING', label: 'Cycling', sport: 'cycling', durationMin: 60, tss: 60, startTime: DAY(2),
    });
    const wk = week(1, { adhocWorkouts: [ride.adhoc] });
    expect(A(wk)).toBe(Math.round(60 * SPORTS_DB.cycling.runSpec));
    expect(B(wk)).toBe(60);
  });

  it('two garminActuals entries carrying one garminId (stale twin + slot entry) count once', () => {
    const ride = overflow('strava-883', {
      activityType: 'CYCLING', label: 'Cycling', sport: 'cycling', durationMin: 60, tss: 60, startTime: DAY(2),
    });
    const wk = weekWithOverflow(ride);
    wk.garminActuals!['W1-cross-0'] = { ...ride.actual };
    expect(A(wk)).toBe(Math.round(60 * SPORTS_DB.cycling.runSpec));
    expect(B(wk)).toBe(60);
  });
});

describe('Signal A never exceeds Signal B', () => {
  it('holds for a week mixing every record shape, with and without unspent items', () => {
    const ride = overflow('strava-901', { activityType: 'CYCLING', label: 'Cycling', sport: 'cycling', durationMin: 90, startTime: DAY(1) });
    const swim = overflow('apple-902', { activityType: 'SWIMMING', label: 'Swim', sport: 'swimming', durationMin: 45, tss: 47, startTime: DAY(3) });
    const run = overflow('strava-903', { activityType: 'RUNNING', label: 'Run', sport: 'run', durationMin: 40, tss: 45, startTime: DAY(5), t: 'easy' });
    const wk = week(1, {
      rated: { 'W1-cross-0': 6 },
      garminActuals: {
        [ride.key]: ride.actual, [swim.key]: swim.actual, [run.key]: run.actual,
        'W1-cross-0': {
          garminId: 'strava-904', startTime: DAY(6), distanceKm: 0, durationSec: 3000,
          avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, hrZones: null,
          displayName: 'Padel',
        } as GarminActual,
      },
      adhocWorkouts: [ride.adhoc, swim.adhoc, run.adhoc],
      unspentLoadItems: [ride.unspent, swim.unspent, run.unspent, {
        garminId: 'strava-999', displayName: 'Rowing', sport: 'rowing', durationMin: 30,
        aerobic: 1, anaerobic: 0, date: DAY(4).slice(0, 10), reason: 'overflow',
      }],
    });
    expect(A(wk)).toBeLessThanOrEqual(B(wk));
    expect(A(withoutUnspent(wk))).toBe(A(wk));
    expect(B(withoutUnspent(wk))).toBe(B(wk));
  });

  it('a legacy adhoc run carrying only its planned RPE reads the same in A and B', () => {
    const wk = week(1, {
      adhocWorkouts: [{ id: 'garmin-1', t: 'easy', n: 'Easy Run', d: '60min · 4 Mar 08:00', r: 3 } as unknown as Workout],
    });
    expect(A(wk)).toBe(Math.round(60 * TL_PER_MIN[3]));
    expect(A(wk)).toBe(B(wk));
  });

  it('the per-activity entries sum to the weekly Signal A total', () => {
    const ride = overflow('strava-911', { activityType: 'CYCLING', label: 'Cycling', sport: 'cycling', durationMin: 60, tss: 60, startTime: DAY(1) });
    const wk = weekWithOverflow(ride);
    const entries = listWeekSignalAEntries(wk, wk.rated ?? {});
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: ride.key, sport: 'cycling', isRun: false });
    expect(Math.round(entries.reduce((s, e) => s + e.tss, 0))).toBe(A(wk));
  });
});

describe('Running CTL does not step up for cross-trainers at plan start', () => {
  // 8 weeks of one 300-TSS run plus two 100-TSS overflow rides, the shape the
  // history seeds already score with runSpec (aggregateHistoryFromRows,
  // edge history): Signal A = 300 + 2 × 100 × cycling runSpec.
  const signalA = 300 + 2 * 100 * SPORTS_DB.cycling.runSpec;
  function crossTrainerWeeks(): Week[] {
    return Array.from({ length: 8 }, (_, i) => {
      const off = i * 7;
      const r1 = overflow(`strava-r1-${i}`, { activityType: 'CYCLING', label: 'Cycling', sport: 'cycling', durationMin: 100, tss: 100, startTime: DAY(off + 2) });
      const r2 = overflow(`strava-r2-${i}`, { activityType: 'CYCLING', label: 'Cycling', sport: 'cycling', durationMin: 100, tss: 100, startTime: DAY(off + 4) });
      return week(i + 1, {
        garminActuals: {
          [`W${i + 1}-long-0`]: {
            garminId: `strava-run-${i}`, startTime: DAY(off + 6), distanceKm: 40, durationSec: 3 * 3600,
            avgPaceSecKm: 270, avgHR: 150, maxHR: 170, calories: null, iTrimp: itrimpFor(300), hrZones: null,
            workoutName: 'Long Run', activityType: 'RUNNING',
          } as GarminActual,
          [r1.key]: r1.actual,
          [r2.key]: r2.actual,
        },
        adhocWorkouts: [r1.adhoc, r2.adhoc],
        unspentLoadItems: [r1.unspent, r2.unspent],
      });
    });
  }

  it('weekly Signal A matches the runSpec-weighted history, Signal B stays the full load', () => {
    const metrics = computeFitnessModel(crossTrainerWeeks(), 8, signalA, PLAN_START);
    for (const m of metrics) {
      expect(m.actualTSS).toBe(Math.round(signalA));
      expect(m.rawTSS).toBe(500);
    }
  });

  it('CTL seeded from that history holds level instead of climbing', () => {
    const metrics = computeFitnessModel(crossTrainerWeeks(), 8, signalA, PLAN_START);
    expect(metrics[metrics.length - 1].ctl).toBeCloseTo(signalA, 0);
  });
});

describe('Same-signal CTL history', () => {
  it('its last entry equals computeSameSignalTSB for the same walk', () => {
    const wks = [
      week(1, { adhocWorkouts: [{ id: 'gps-1', t: 'easy', n: 'Run', d: '60min', rpe: 4 } as unknown as Workout] }),
      week(2, { adhocWorkouts: [{ id: 'gps-2', t: 'easy', n: 'Run', d: '90min', rpe: 5 } as unknown as Workout] }),
    ];
    const hist = computeSameSignalCtlHistory(wks, 2, 300, PLAN_START);
    expect(hist).toHaveLength(2);
    expect(hist[1]).toBeCloseTo(computeSameSignalTSB(wks, 2, 300, PLAN_START)!.ctl, 10);
  });
});

describe('Daily Signal B (sleep load) counts an adhoc activity with a twin once', () => {
  it('an overflow ride day reads 60, not 120', () => {
    const ride = overflow('strava-921', { activityType: 'CYCLING', label: 'Cycling', sport: 'cycling', durationMin: 60, tss: 60, startTime: DAY(2) });
    const byDate = buildDailySignalBTSS([weekWithOverflow(ride)]);
    expect(byDate[DAY(2).slice(0, 10)]).toBeCloseTo(60, 6);
  });

  it('a twin without HR leaves the adhoc RPE estimate to count, once', () => {
    const swim = overflow('apple-922', { activityType: 'SWIMMING', label: 'Swim', sport: 'swimming', durationMin: 45, startTime: DAY(3) });
    const byDate = buildDailySignalBTSS([weekWithOverflow(swim)]);
    expect(byDate[DAY(3).slice(0, 10)]).toBeCloseTo(45 * TL_PER_MIN[5], 6);
  });
});

describe('A Strava-upgraded twin still pairs with its adhoc entry', () => {
  // An Apple (or Garmin) activity logged as adhoc, later re-synced from Strava.
  const ride = overflow('apple-777', { activityType: 'CYCLING', label: 'Cycling', sport: 'cycling', durationMin: 60, tss: 60, startTime: DAY(2) });
  const date = DAY(2).slice(0, 10);
  afterEach(() => vi.useRealTimers());

  it('weekly A and B are unchanged by the upgrade', () => {
    const wk = stravaUpgraded(ride, 'strava-999');
    expect(A(wk)).toBe(Math.round(60 * SPORTS_DB.cycling.runSpec));
    expect(B(wk)).toBe(60);
  });

  it('daily Signal B (sleep load) counts it once, matching today\'s Signal B', () => {
    const wk = stravaUpgraded(ride, 'strava-999');
    const byDate = buildDailySignalBTSS([wk]);
    expect(byDate[date]).toBeCloseTo(60, 6);
    expect(Math.round(byDate[date])).toBe(computeTodaySignalBTSS(wk, date));
  });

  it('an upgraded twin with no HR still leaves the adhoc RPE estimate to count, once', () => {
    const swim = overflow('apple-778', { activityType: 'SWIMMING', label: 'Swim', sport: 'swimming', durationMin: 45, startTime: DAY(3) });
    const byDate = buildDailySignalBTSS([stravaUpgraded(swim, 'strava-998')]);
    expect(byDate[DAY(3).slice(0, 10)]).toBeCloseTo(45 * TL_PER_MIN[5], 6);
  });

  it("the day's strain is unchanged by the upgrade (logged minutes are subtracted once)", () => {
    // 100 active minutes and 12,000 steps: the passive term depends on how many
    // logged minutes are subtracted, so a double-listed ride moves the strain.
    const physio: PhysiologyDayEntry = { date, steps: 12000, activeMinutes: 100 } as PhysiologyDayEntry;
    const before = computeTodayStrainTSS(weekWithOverflow(ride), date, physio);
    const after = computeTodayStrainTSS(stravaUpgraded(ride, 'strava-999'), date, physio);
    expect(after).toBe(before);
  });

  it("the rolling-load day lists it once, and its activities sum to the day's load", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${date}T12:00:00`));
    // Strava's duration differs by 5 min (inside the upgrade's 15% window), so
    // the list's name+duration fallback cannot hide the duplicate.
    const entries = getDailyLoadHistory([stravaUpgraded(ride, 'strava-999', 65)], PLAN_START);
    const day = entries.find(e => e.date === date)!;
    expect(day.activities).toHaveLength(1);
    expect(day.activities.reduce((sum, a) => sum + a.tss, 0)).toBe(day.tss);
  });
});

describe('Sport resolvers', () => {
  const runSpecOf = (activityType: string) => signalARunSpec(resolveActualSport('garmin-x', { activityType }));

  it('recorded types map to their SPORTS_DB runSpec', () => {
    expect(runSpecOf('RUNNING')).toBe(SPORTS_DB.running.runSpec);
    expect(runSpecOf('TRAIL_RUNNING')).toBe(SPORTS_DB.extra_run.runSpec);
    expect(runSpecOf('CYCLING')).toBe(SPORTS_DB.cycling.runSpec);
    expect(runSpecOf('INDOOR_CYCLING')).toBe(SPORTS_DB.cycling.runSpec);
    expect(runSpecOf('SWIMMING')).toBe(SPORTS_DB.swimming.runSpec);
    expect(runSpecOf('WALKING')).toBe(SPORTS_DB.walking.runSpec);
    expect(runSpecOf('HIKING')).toBe(SPORTS_DB.hiking.runSpec);
    expect(runSpecOf('STRENGTH_TRAINING')).toBe(SPORTS_DB.strength.runSpec);
    expect(runSpecOf('HIIT')).toBe(SPORTS_DB.strength.runSpec);
    expect(runSpecOf('YOGA')).toBe(SPORTS_DB.yoga.runSpec);
    expect(runSpecOf('ELLIPTICAL')).toBe(SPORTS_DB.elliptical.runSpec);
    expect(runSpecOf('STAIR_CLIMBING')).toBe(SPORTS_DB.stair_climbing.runSpec);
    expect(runSpecOf('CARDIO')).toBe(SPORTS_DB.generic_sport.runSpec);
  });

  it('slot-fill labels (formatActivityType output) resolve like the codes they came from', () => {
    const label = (displayName: string) => resolveActualSport('W1-cross-0', { displayName });
    expect(label('Stair Climbing')).toBe('stair_climbing');
    expect(label('Lap Swim')).toBe('swimming');
    expect(label('Indoor Cycling')).toBe('cycling');
    expect(label('Rock Climbing')).toBe('climbing');
    expect(resolveActualSport('W1-gym-0', { displayName: 'HIIT' })).toBe('strength');
  });

  it('adhoc entries: run-typed adhocs are runs, others use their name', () => {
    expect(resolveAdhocSport({ t: 'easy', n: 'General Sport 1' })).toBe('running');
    expect(resolveAdhocSport({ t: 'cross', n: 'Cycling' })).toBe('cycling');
    expect(resolveAdhocSport({ t: 'gym', n: 'HIIT' })).toBe('strength');
    expect(resolveAdhocSport({ t: 'cross', n: 'Lap Swim (Garmin)' })).toBe('swimming');
  });

  it('normalizeiTrimp fixture helper round-trips (guards the expected values above)', () => {
    expect(normalizeiTrimp(itrimpFor(60))).toBeCloseTo(60, 10);
  });
});
