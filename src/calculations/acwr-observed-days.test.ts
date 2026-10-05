/**
 * Rolling ACWR for an athlete with no Signal B seed (s.signalBBaseline unset).
 *
 * Days that no live or archived plan week covers have no record. Without a seed
 * they are missing, not rest: counting them as 0 read steady training as a spike
 * (1.87 'high' on plan day 14) and any archive entry switched the 14-day guard
 * off (4.00 'high' from day 0). See computeRollingLoadRatio.
 *
 * Time is pinned at LOCAL noon so the date keys line up in any timezone, and the
 * fixtures sit in June/July 2026 so no daylight-saving change falls inside them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  computeACWR,
  computeReadinessACWR,
  computeRollingLoadRatio,
  computeWeeklyAcwrHistory,
  computeWeekRawTSS,
  getDailyLoadHistory,
  ROLLING_ACWR_MIN_OBSERVED_DAYS,
} from './fitness-model';
import type { Week } from '@/types';

// Plan day 0 = Monday 1 June 2026.
const PLAN_START = '2026-06-01';
const localNoon = (planDay: number) => new Date(2026, 5, 1 + planDay, 12, 0, 0, 0);
// Same date key the code builds (toISOString of local noon).
const dateKey = (planDay: number) => localNoon(planDay).toISOString().split('T')[0];
const atPlanDay = (planDay: number) => { vi.useFakeTimers(); vi.setSystemTime(localNoon(planDay)); };
afterEach(() => { vi.useRealTimers(); });

// One run per day with no iTRIMP: Signal B TSS = minutes × TL_PER_MIN[5] (1.15),
// so multiples of 20 minutes give whole numbers (20 → 23, 40 → 46, 60 → 69).
const tssOf = (min: number) => Math.round(min * 1.15);

function emptyWeek(w: number): Week {
  return {
    w, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, garminActuals: {},
  } as unknown as Week;
}

/** Weeks anchored at `startDay` (a plan day), with `minutesForDay(planDay)` of running on each day. */
function buildWeeks(
  minutesForDay: (planDay: number) => number,
  opts: { startDay?: number; firstDay?: number; lastDay?: number; weeks?: number } = {},
): Week[] {
  const startDay = opts.startDay ?? 0;
  const wks = Array.from({ length: opts.weeks ?? 16 }, (_, i) => emptyWeek(i + 1));
  for (let day = opts.firstDay ?? startDay; day <= (opts.lastDay ?? 60); day++) {
    const min = minutesForDay(day);
    const idx = Math.floor((day - startDay) / 7);
    if (min <= 0 || idx < 0 || idx >= wks.length) continue;
    wks[idx].garminActuals![`run-${day}`] = {
      garminId: `g-${day}`, startTime: `${dateKey(day)}T07:00:00.000Z`, distanceKm: 10,
      durationSec: min * 60, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
      iTrimp: null, activityType: 'RUNNING',
    } as any;
  }
  return wks;
}

const acwrAt = (wks: Week[], opts: { seed?: number; archives?: Array<{ planStartDate: string; weeks: any[] }>; w?: number; planStart?: string } = {}) =>
  computeACWR(wks, opts.w ?? 3, 'recreational', undefined, opts.planStart ?? PLAN_START, 0, opts.seed, undefined, opts.archives);

// Mon..Sun minutes: an uneven weekly pattern (Mon and Fri rest).
const PATTERN_MIN = [0, 40, 40, 60, 0, 40, 80];
const patternDay = (planDay: number) => PATTERN_MIN[((planDay % 7) + 7) % 7];

describe('rolling ACWR without a Signal B seed: unrecorded days are missing, not rest', () => {
  it('steady training reads 1.0 on plan days 14 to 26 (was 1.87 high on day 14)', () => {
    const wks = buildWeeks(() => 60);
    for (let day = 14; day <= 26; day++) {
      atPlanDay(day);
      const a = acwrAt(wks);
      expect(a.ratio).toBeCloseTo(1, 9);
      expect(a.status).toBe('safe');
    }
  });

  it('an uneven weekly pattern reads exactly 1.0 from day 14 (baseline uses whole weeks)', () => {
    const wks = buildWeeks(patternDay);
    for (let day = 14; day <= 26; day++) {
      atPlanDay(day);
      expect(acwrAt(wks).ratio).toBeCloseTo(1, 9);
    }
  });

  it('chronic is the athlete\'s own weekly load, not understated by pre-plan zeros', () => {
    atPlanDay(14);
    const r = computeRollingLoadRatio(buildWeeks(() => 60), PLAN_START)!;
    expect(r.acute).toBe(7 * tssOf(60));
    expect(r.chronic).toBeCloseTo(7 * tssOf(60), 9); // HEAD: 15 × 69 / 4 = 258.75
  });

  it('a genuine spike is still caught and matches a correctly seeded athlete', () => {
    // Weeks 1-2 at 40 min a day, week 3 at 80 min a day.
    const wks = buildWeeks(d => (d < 14 ? 40 : 80));
    atPlanDay(20);
    const unseeded = acwrAt(wks);
    const seeded = acwrAt(wks, { seed: 7 * tssOf(40) });
    expect(unseeded.ratio).toBeCloseTo(1.6, 9);
    expect(unseeded.status).toBe('high');
    expect(unseeded.ratio).toBeCloseTo(seeded.ratio, 9);
    expect(unseeded.ctl).toBeCloseTo(seeded.ctl, 9);
  });

  it(`stays unknown until ${ROLLING_ACWR_MIN_OBSERVED_DAYS} completed days are observed`, () => {
    const wks = buildWeeks(() => 60);
    atPlanDay(13);
    expect(computeRollingLoadRatio(wks, PLAN_START)).toBeNull();
    expect(acwrAt(wks).status).toBe('unknown');
    atPlanDay(14);
    expect(computeRollingLoadRatio(wks, PLAN_START)).not.toBeNull();
  });

  it('an archive entry with no weeks no longer switches the guard off (was 4.00 high)', () => {
    const wks = buildWeeks(() => 60);
    for (const day of [1, 3, 6, 10, 13]) {
      atPlanDay(day);
      const a = acwrAt(wks, { archives: [{ planStartDate: PLAN_START, weeks: [] }] });
      expect(a.status).toBe('unknown');
      expect(a.ratio).toBe(0);
    }
  });

  it('a Strava-restore archive overlapping the live plan adds no observed days (was 4.00 / 3.20 high)', () => {
    // restoreHistoryFromServer anchors the archive at the Monday of the first
    // activity, which for an athlete with no history is inside the live plan.
    const wks = buildWeeks(() => 60);
    const archive = { planStartDate: PLAN_START, weeks: buildWeeks(() => 60) };
    for (const day of [0, 3, 6, 7, 13]) {
      atPlanDay(day);
      expect(acwrAt(wks, { archives: [archive] }).status).toBe('unknown');
    }
  });

  it('a plan rebuilt after 5 days stays unknown until 14 days are observed, then reads 1.0', () => {
    // Old plan: Monday 25 May (plan day -7), trained every day. Rebuilt into a
    // new plan starting Monday 1 June; old week 1 is archived.
    const oldWeeks = buildWeeks(() => 60, { startDay: -7, firstDay: -7, lastDay: -1, weeks: 1 });
    const archives = [{ planStartDate: dateKey(-7), weeks: oldWeeks }];
    const wks = buildWeeks(() => 60);
    atPlanDay(0);
    expect(acwrAt(wks, { archives }).status).toBe('unknown'); // HEAD: 4.00 high
    atPlanDay(2);
    expect(acwrAt(wks, { archives }).status).toBe('unknown'); // HEAD: 3.50 high
    atPlanDay(7); // 7 archived + 7 live completed days observed
    const a = acwrAt(wks, { archives });
    expect(a.ratio).toBeCloseTo(1, 9);
    expect(a.status).toBe('safe');
  });

  it('archived days count as observed, so a long archive gives a value from plan day 0', () => {
    const oldWeeks = buildWeeks(() => 60, { startDay: -28, firstDay: -28, lastDay: -1, weeks: 4 });
    const archives = [{ planStartDate: dateKey(-28), weeks: oldWeeks }];
    atPlanDay(0);
    const a = acwrAt(buildWeeks(() => 60), { archives });
    expect(a.ratio).toBeCloseTo(1, 9);
  });

  it('reports unknown, not the zero-started weekly EMA, when s.w runs ahead of the calendar', () => {
    // "Complete week" / simulator: s.w = 5 on plan day 10. HEAD fell through to
    // the weekly EMA started at 0 and read about 2.0 'high'.
    atPlanDay(10);
    const a = acwrAt(buildWeeks(patternDay), { w: 5 });
    expect(a.status).toBe('unknown');
  });

  it('computeReadinessACWR (Home ring, week advance inputs) reads the same 1.0', () => {
    atPlanDay(14);
    const a = computeReadinessACWR({ wks: buildWeeks(() => 60), w: 3, planStartDate: PLAN_START, ctlBaseline: 60 });
    expect(a.ratio).toBeCloseTo(1, 9);
    expect(a.ctl).toBeCloseTo(7 * tssOf(60), 9); // ease-back L_max = safeUpper × this
  });
});

describe('rolling ACWR is unchanged where a seed or full data covers the window', () => {
  it('seeded: every plan day 0 to 40 equals the seed/7 fill and 28-day sum / 4', () => {
    const seed = 7 * tssOf(60);
    const wks = buildWeeks(patternDay);
    for (let day = 0; day <= 40; day++) {
      atPlanDay(day);
      let acute = 0, sum = 0;
      for (let d = day - 27; d <= day; d++) {
        const v = d < 0 ? seed / 7 : tssOf(patternDay(d));
        sum += v;
        if (d > day - 7) acute += v;
      }
      const r = computeRollingLoadRatio(wks, PLAN_START, seed)!;
      expect(r.acute).toBeCloseTo(acute, 9);
      expect(r.chronic).toBeCloseTo(sum / 4, 9);
    }
  });

  it('unseeded with all 28 days observed: plain 28-day sum / 4', () => {
    atPlanDay(30);
    const r = computeRollingLoadRatio(buildWeeks(patternDay), PLAN_START)!;
    let sum = 0, acute = 0;
    for (let d = 3; d <= 30; d++) { sum += tssOf(patternDay(d)); if (d >= 24) acute += tssOf(patternDay(d)); }
    expect(r.acute).toBe(acute);
    expect(r.chronic).toBeCloseTo(sum / 4, 9);
  });
});

describe('rolling-load chart draws recorded days only', () => {
  it('without a seed, days no plan covers are left off instead of drawn as zero', () => {
    atPlanDay(10);
    const entries = getDailyLoadHistory(buildWeeks(() => 60), PLAN_START);
    expect(entries).toHaveLength(11);
    expect(entries[0].date).toBe(dateKey(0));
    expect(entries.every(e => e.tss === tssOf(60))).toBe(true);
  });

  it('with a seed, unrecorded days still show the seed fill', () => {
    atPlanDay(10);
    const entries = getDailyLoadHistory(buildWeeks(() => 60), PLAN_START, 7 * 50);
    expect(entries).toHaveLength(28);
    expect(entries[0].tss).toBe(50);
  });
});

describe('Load Ratio weekly trend without a seed', () => {
  it('steady training reads 1.0 each week (was 4.1, 3.1, 2.4, 2.0)', () => {
    const wks = buildWeeks(patternDay);
    const hist = computeWeeklyAcwrHistory(wks, 6, undefined, PLAN_START);
    expect(hist).toHaveLength(6);
    for (const e of hist) expect(e.ratio).toBeCloseTo(1, 9);
  });

  it('a heavier week still reads above 1, and never above the seeded reading', () => {
    const wks = buildWeeks(d => (d >= 14 && d < 21 ? 80 : 40));
    const unseeded = computeWeeklyAcwrHistory(wks, 3, undefined, PLAN_START);
    const seeded = computeWeeklyAcwrHistory(wks, 3, 7 * tssOf(40), PLAN_START);
    expect(unseeded[2].ratio).toBeGreaterThan(1.1);
    expect(unseeded[2].ratio).toBeLessThanOrEqual(seeded[2].ratio);
  });

  it('seeded history is unchanged (EMAs start at the seed)', () => {
    const wks = buildWeeks(patternDay);
    const seed = 300;
    const hist = computeWeeklyAcwrHistory(wks, 3, seed, PLAN_START);
    let ctl = seed, atl = seed;
    const CTL_D = Math.exp(-7 / 42), ATL_D = Math.exp(-7 / 7);
    for (let i = 0; i < 3; i++) {
      const raw = computeWeekRawTSS(wks[i], wks[i].rated ?? {}, PLAN_START);
      ctl = ctl * CTL_D + raw * (1 - CTL_D);
      atl = atl * ATL_D + raw * (1 - ATL_D);
      expect(hist[i].ratio).toBeCloseTo(atl / ctl, 9);
    }
  });
});
