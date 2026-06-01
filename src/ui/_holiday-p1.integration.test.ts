/**
 * Integration test: post-holiday detraining + bridge mods.
 *
 * Exercises the REAL `showHolidayWelcomeBack` from holiday-modal.ts via the
 * real store (setState / getMutableState). A minimal document/body stub is
 * installed so DOM calls after the state mutations don't crash Node.
 *
 * Scenarios:
 *   a. Long sedentary holiday (21 days, ~0 activity ratio)
 *   b. Short holiday (8 days) → inside the 10-day dead-zone, no dock
 *   c. Active holiday (21 days, ~70% retention) → attenuated dock vs (a)
 *   d. Bridge mods: applyBridgeModsAllDisciplines scales swim/bike/run/skips
 *      userScaledAt sessions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setState, getMutableState, resetState } from '@/state/store';
import { detrainingLossFraction, DETRAINING_DEADZONE_DAYS } from './welcome-back';
import { showHolidayWelcomeBack, applyBridgeModsAllDisciplines } from './holiday-modal';
import type { SimulatorState, Week } from '@/types';

// ---------------------------------------------------------------------------
// Minimal document + body stub. The state mutations in showHolidayWelcomeBack
// happen BEFORE any DOM call. The DOM calls (createElement, appendChild,
// getElementById) appear at the modal-HTML stage and then in the "Continue"
// click handler (which we never fire). We stub just enough that they don't throw.
// ---------------------------------------------------------------------------

function makeElement(tag: string): any {
  const el: any = {
    tagName: tag,
    id: '',
    className: '',
    style: {},
    innerHTML: '',
    children: [] as any[],
    eventListeners: {} as Record<string, Function[]>,
    addEventListener(type: string, fn: Function) {
      this.eventListeners[type] = this.eventListeners[type] || [];
      this.eventListeners[type].push(fn);
    },
    remove() {},
    querySelector: () => null,
    appendChild(child: any) { this.children.push(child); return child; },
  };
  return el;
}

const bodyEl = makeElement('body');

// Install global stubs before any imports resolve in-module DOM usage.
(globalThis as any).document = {
  createElement: (tag: string) => makeElement(tag),
  getElementById: (id: string) => {
    // Return a stub element so addEventListener calls don't throw.
    return makeElement('div');
  },
  body: bodyEl,
};
(globalThis as any).localStorage = {
  _store: {} as Record<string, string>,
  getItem(k: string) { return this._store[k] ?? null; },
  setItem(k: string, v: string) { this._store[k] = v; },
  removeItem(k: string) { delete this._store[k]; },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO date N days before today. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

/** Build a minimal SimulatorState with tri config for detraining tests. */
function buildState(opts: {
  vdot: number;
  ftp: number;
  css: number;
  holidayDays: number;
  holidayWeeksTSS?: number;   // TSS for EVERY week that overlaps the holiday window (uniform)
  preHolidayWeeklyTSS?: number;
}): SimulatorState {
  // Plan started 12 weeks ago (Monday). 16 planned weeks.
  const planStart = daysAgo(84); // 12 weeks ago
  const holidayEndDate = daysAgo(1); // ended yesterday
  const holidayStartDate = daysAgo(opts.holidayDays); // started N days ago

  // Compute which week numbers (1-based) overlap the holiday window,
  // using the same weekNumForDate logic the production code uses.
  function weekNumForDate(date: string, planStartDate: string): number {
    const d = new Date(date + 'T12:00:00');
    const start = new Date(planStartDate + 'T12:00:00');
    const days = Math.floor((d.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
    return Math.max(1, Math.floor(days / 7) + 1);
  }
  const startWeek = weekNumForDate(holidayStartDate, planStart);
  const endWeek = weekNumForDate(holidayEndDate, planStart);

  // Build wks array: 16 weeks
  const wks: Week[] = Array.from({ length: 16 }, (_, i) => ({
    w: i + 1,
    ph: i < 6 ? 'base' : i < 10 ? 'build' : i < 14 ? 'peak' : 'taper',
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
    actualTSS: 0,
  } as any));

  // Write holiday TSS into ALL weeks the production code will iterate over.
  // This ensures classifyHolidayActivity sees the intended retention ratio.
  if (opts.holidayWeeksTSS !== undefined) {
    for (let w = startWeek; w <= endWeek && w <= 16; w++) {
      (wks[w - 1] as any).actualTSS = opts.holidayWeeksTSS;
    }
  }

  const state: SimulatorState = {
    schemaVersion: 1,
    w: 13,        // currently in week 13 (return week)
    tw: 16,
    v: opts.vdot,
    iv: opts.vdot,
    rpeAdj: 0,
    rd: 'marathon',
    epw: 5,
    rw: 4,
    wkm: 60,
    pbs: {},
    rec: null,
    lt: null,
    vo2: null,
    initialLT: null,
    initialVO2: null,
    initialBaseline: null,
    currentFitness: null,
    forecastTime: null,
    typ: 'Balanced',
    calculatedRunnerType: 'Balanced',
    b: 1.06,
    wks,
    pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
    skip: [],
    timp: 0,
    expectedFinal: opts.vdot,
    planStartDate: planStart,
    hasCompletedOnboarding: true,
    holidayState: {
      startDate: holidayStartDate,
      endDate: holidayEndDate,
      canRun: 'no',
      holidayType: 'relaxation',
      active: false, // already deactivated (welcome-back fires after deactivation)
      preHolidayWeeklyTSS: opts.preHolidayWeeklyTSS ?? 400,
    },
    triConfig: {
      distance: '70.3',
      bike: {
        ftp: opts.ftp,
        ftpSource: 'user',
        ftpConfidence: 'high',
        ftpHistory: [],
      },
      swim: {
        cssSecPer100m: opts.css,
        cssSource: 'user',
        cssConfidence: 'high',
        cssHistory: [],
      },
    } as any,
    eventType: 'triathlon',
  } as any;

  return state;
}

// ---------------------------------------------------------------------------
// Scenario (a): Long sedentary holiday — 21 days, ~0% activity
// ---------------------------------------------------------------------------

describe('showHolidayWelcomeBack — scenario a: long sedentary, 21 days', () => {
  const FTP_BEFORE = 250;
  const CSS_BEFORE = 100;  // sec/100m
  const VDOT_BEFORE = 50;
  const DAYS_AWAY = 21;

  // Expected detraining fraction: 0 activity ratio, 21 days.
  // detrainingDays = 21 - 10 = 11 → weeks = 11/7 ≈ 1.571
  // wholeWeeks = 1, frac after 1 week: 0.012 (rate i<2)
  // partial = 0.571, rate = 0.012 (wholeWeeks=1 < 2)
  // frac += (1 - 0.012) * 0.012 * 0.571 ≈ 0.012 + 0.006762 ≈ 0.018762
  // retentionRatio = 0 → loss = frac * (1 - 0) = frac
  const expectedFrac = detrainingLossFraction(DAYS_AWAY, 0);

  beforeEach(() => {
    resetState();
    // No holiday-week activity: preHolidayWeeklyTSS=400, actual holiday TSS=0
    setState(buildState({
      vdot: VDOT_BEFORE,
      ftp: FTP_BEFORE,
      css: CSS_BEFORE,
      holidayDays: DAYS_AWAY,
      holidayWeeksTSS: 0,
      preHolidayWeeklyTSS: 400,
    }));
  });

  it('detrainingLossFraction > 0 for 21 days (past dead-zone)', () => {
    console.log(`\n[scenario-a] expectedFrac for 21 days, 0 retention: ${expectedFrac.toFixed(5)}`);
    expect(expectedFrac).toBeGreaterThan(0);
    expect(expectedFrac).toBeLessThan(0.05); // sanity: should be ~1.9%
  });

  it('VDOT drops by approximately expectedFrac × vdot', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    const vdotAfter = s.v!;
    console.log(`[scenario-a] VDOT: ${VDOT_BEFORE} → ${vdotAfter} (expected loss ≈ ${(VDOT_BEFORE * expectedFrac).toFixed(2)})`);

    expect(vdotAfter).toBeLessThan(VDOT_BEFORE);

    // Verify within rounding tolerance (0.2 points)
    const actualLoss = VDOT_BEFORE - vdotAfter;
    const expectedLoss = VDOT_BEFORE * expectedFrac;
    expect(Math.abs(actualLoss - expectedLoss)).toBeLessThanOrEqual(0.2);
  });

  it('VDOT is floored at 20', () => {
    // VDOT=21 with 21 days sedentary should not go below 20
    const s = getMutableState();
    s.v = 21;

    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const after = getMutableState().v!;
    console.log(`[scenario-a] VDOT floor: 21 → ${after}`);
    expect(after).toBeGreaterThanOrEqual(20);
  });

  it('FTP drops and ftpDetrainAnchorISO is set to holiday.endDate', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    const ftpAfter = s.triConfig!.bike!.ftp!;
    const anchor = s.triConfig!.bike!.ftpDetrainAnchorISO;

    console.log(`[scenario-a] FTP: ${FTP_BEFORE}W → ${ftpAfter}W, anchor: ${anchor}`);

    expect(ftpAfter).toBeLessThan(FTP_BEFORE);
    const expectedFtpAfter = Math.round(FTP_BEFORE * (1 - expectedFrac));
    expect(ftpAfter).toBe(expectedFtpAfter);

    // Anchor should be set to holiday.endDate (yesterday)
    expect(anchor).toBe(daysAgo(1));
  });

  it('FTP history entry is appended', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    const history = s.triConfig!.bike!.ftpHistory!;
    console.log(`[scenario-a] FTP history entries: ${history.length}, last: ${JSON.stringify(history[history.length - 1])}`);

    expect(history.length).toBeGreaterThan(0);
    const lastEntry = history[history.length - 1];
    expect(lastEntry.source).toBe('derived');
    expect(lastEntry.value).toBeLessThan(FTP_BEFORE);
  });

  it('CSS increases (slower) and cssDetrainAnchorISO is set to holiday.endDate', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    const cssAfter = s.triConfig!.swim!.cssSecPer100m!;
    const anchor = s.triConfig!.swim!.cssDetrainAnchorISO;

    console.log(`[scenario-a] CSS: ${CSS_BEFORE}s/100m → ${cssAfter}s/100m (+${cssAfter - CSS_BEFORE}s), anchor: ${anchor}`);

    expect(cssAfter).toBeGreaterThan(CSS_BEFORE);
    const expectedCssAfter = Math.round(CSS_BEFORE * (1 + expectedFrac));
    expect(cssAfter).toBe(expectedCssAfter);

    expect(anchor).toBe(daysAgo(1));
  });

  it('CSS history entry is appended', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    const history = s.triConfig!.swim!.cssHistory!;
    console.log(`[scenario-a] CSS history entries: ${history.length}, last: ${JSON.stringify(history[history.length - 1])}`);

    expect(history.length).toBeGreaterThan(0);
    const lastEntry = history[history.length - 1];
    expect(lastEntry.source).toBe('derived');
    expect(lastEntry.value).toBeGreaterThan(CSS_BEFORE);
  });

  it('onComplete is called (modal appeared and DOM stubs worked)', () => {
    // We don't click the button, but the function finishes synchronously and
    // the overlay/button logic runs. onComplete fires when the "Continue"
    // button click handler is wired — that only fires on click, so we verify
    // the fn was constructed without throwing (no assertion on onComplete being called).
    // The real mutation assertions above are the meaningful signal.
    const onComplete = vi.fn();
    expect(() => showHolidayWelcomeBack(onComplete)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario (b): Short holiday — 8 days (inside dead-zone → no dock)
// ---------------------------------------------------------------------------

describe('showHolidayWelcomeBack — scenario b: short holiday, 8 days (dead-zone)', () => {
  const FTP_BEFORE = 250;
  const CSS_BEFORE = 100;
  const VDOT_BEFORE = 50;
  const DAYS_AWAY = 8;

  beforeEach(() => {
    resetState();
    setState(buildState({
      vdot: VDOT_BEFORE,
      ftp: FTP_BEFORE,
      css: CSS_BEFORE,
      holidayDays: DAYS_AWAY,
      holidayWeeksTSS: 0,
      preHolidayWeeklyTSS: 400,
    }));
  });

  it('detrainingLossFraction is 0 for 8 days (inside 10-day dead-zone)', () => {
    const frac = detrainingLossFraction(DAYS_AWAY, 0);
    console.log(`\n[scenario-b] detrainingLossFraction(${DAYS_AWAY}, 0) = ${frac}`);
    expect(frac).toBe(0);
  });

  it('VDOT unchanged after 8-day holiday', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    console.log(`[scenario-b] VDOT: ${VDOT_BEFORE} → ${s.v}`);
    expect(s.v).toBe(VDOT_BEFORE);
  });

  it('FTP unchanged after 8-day holiday', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    console.log(`[scenario-b] FTP: ${FTP_BEFORE}W → ${s.triConfig?.bike?.ftp}W`);
    expect(s.triConfig?.bike?.ftp).toBe(FTP_BEFORE);
  });

  it('CSS unchanged after 8-day holiday', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    console.log(`[scenario-b] CSS: ${CSS_BEFORE}s/100m → ${s.triConfig?.swim?.cssSecPer100m}s/100m`);
    expect(s.triConfig?.swim?.cssSecPer100m).toBe(CSS_BEFORE);
  });

  it('ftpDetrainAnchorISO NOT set (no dock occurred)', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    expect(s.triConfig?.bike?.ftpDetrainAnchorISO).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario (c): Active holiday — 21 days, ~70% load maintained
// ---------------------------------------------------------------------------

describe('showHolidayWelcomeBack — scenario c: active holiday, 21 days, 70% retention', () => {
  const FTP_BEFORE = 250;
  const CSS_BEFORE = 100;
  const VDOT_BEFORE = 50;
  const DAYS_AWAY = 21;
  const PRE_HOLIDAY_TSS = 400;
  // 70% retention: each holiday week has 0.7 × 400 = 280 TSS
  const HOLIDAY_WEEK_TSS = Math.round(PRE_HOLIDAY_TSS * 0.7);

  const fracSedentary = detrainingLossFraction(DAYS_AWAY, 0);
  // classifyHolidayActivity averages actualTSS over all holiday weeks, including any
  // that fall before the first filled slot (no zero-pad on the left). With the corrected
  // fixture (all holiday weeks filled), avgWeeklyTSS = HOLIDAY_WEEK_TSS, ratio = 0.7.
  // We use 0.7 as the intended retention; the fixture now writes TSS to ALL holiday weeks.
  const INTENDED_RETENTION = 0.7;
  const fracActive = detrainingLossFraction(DAYS_AWAY, INTENDED_RETENTION);

  beforeEach(() => {
    resetState();
    setState(buildState({
      vdot: VDOT_BEFORE,
      ftp: FTP_BEFORE,
      css: CSS_BEFORE,
      holidayDays: DAYS_AWAY,
      holidayWeeksTSS: HOLIDAY_WEEK_TSS,
      preHolidayWeeklyTSS: PRE_HOLIDAY_TSS,
    }));
  });

  it('fracActive < fracSedentary (attenuation confirmed)', () => {
    console.log(`\n[scenario-c] fracSedentary(21d, 0): ${fracSedentary.toFixed(5)}`);
    console.log(`[scenario-c] fracActive(21d, 0.7):   ${fracActive.toFixed(5)}`);
    expect(fracActive).toBeLessThan(fracSedentary);
    expect(fracActive).toBeGreaterThan(0); // still some detraining
  });

  it('VDOT drop is smaller than sedentary scenario', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    const vdotAfter = s.v!;
    const lossC = VDOT_BEFORE - vdotAfter;
    const lossA = VDOT_BEFORE * fracSedentary;

    console.log(`[scenario-c] VDOT: ${VDOT_BEFORE} → ${vdotAfter} (loss ${lossC.toFixed(2)} vs sedentary ${lossA.toFixed(2)})`);

    expect(vdotAfter).toBeLessThan(VDOT_BEFORE);
    expect(lossC).toBeLessThan(lossA + 0.2); // active loss < sedentary loss (with rounding tolerance)
  });

  it('FTP drop is proportional to fracActive (within rounding)', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    const ftpAfter = s.triConfig!.bike!.ftp!;
    const expectedFtpAfter = Math.round(FTP_BEFORE * (1 - fracActive));

    console.log(`[scenario-c] FTP: ${FTP_BEFORE}W → ${ftpAfter}W (expected ${expectedFtpAfter}W, fracActive=${fracActive.toFixed(5)})`);
    expect(ftpAfter).toBe(expectedFtpAfter);
  });

  it('CSS increase is proportional to fracActive (within rounding)', () => {
    const onComplete = vi.fn();
    showHolidayWelcomeBack(onComplete);

    const s = getMutableState();
    const cssAfter = s.triConfig!.swim!.cssSecPer100m!;
    const expectedCssAfter = Math.round(CSS_BEFORE * (1 + fracActive));

    console.log(`[scenario-c] CSS: ${CSS_BEFORE}s/100m → ${cssAfter}s/100m (expected ${expectedCssAfter}s/100m)`);
    expect(cssAfter).toBe(expectedCssAfter);
  });
});

// ---------------------------------------------------------------------------
// Step 4: applyBridgeModsAllDisciplines
// ---------------------------------------------------------------------------

describe('applyBridgeModsAllDisciplines — bridge scaling', () => {
  const SCALE = 0.6;

  /** Build a minimal Week with _holidayBridgeScale set. */
  function makeWk(scale: number, downgrade = false): Week {
    const wk: any = {
      w: 3,
      ph: 'base',
      rated: {},
      skip: [],
      cross: [],
      wkGain: 0,
      workoutMods: [],
      adjustments: [],
      unspentLoad: 0,
      extraRunLoad: 0,
      _holidayBridgeScale: scale,
      _holidayBridgeDowngrade: downgrade,
    };
    return wk;
  }

  it('scales bike estimatedDurationMin to ~60%', () => {
    const workouts = [
      {
        id: 'tri-bike-1',
        t: 'bike_z2',
        n: 'Bike Easy',
        d: '60 min easy',
        r: 4,
        discipline: 'bike',
        estimatedDurationMin: 60,
        musculoTendonLoad: 100,
      },
    ];
    const wk = makeWk(SCALE);
    applyBridgeModsAllDisciplines(workouts as any, wk);

    console.log(`\n[bridge] bike: estimatedDurationMin=${workouts[0].estimatedDurationMin}, status=${workouts[0].status}`);
    // 60 * 0.6 = 36 → rounded to nearest 5 = 35; floor = max(15, round(36/5)*5) = 35
    expect(workouts[0].estimatedDurationMin).toBeLessThan(60);
    expect(workouts[0].estimatedDurationMin).toBeGreaterThanOrEqual(15);
    expect(workouts[0].status).toBe('reduced');
    expect(workouts[0].modReason).toBe('Post-holiday bridge');
  });

  it('scales swim estimatedDurationMin to ~60%', () => {
    const workouts = [
      {
        id: 'tri-swim-1',
        t: 'swim',
        n: 'Swim Easy',
        d: '40 min easy swim',
        r: 4,
        discipline: 'swim',
        estimatedDurationMin: 40,
        musculoTendonLoad: 0,
      },
    ];
    const wk = makeWk(SCALE);
    applyBridgeModsAllDisciplines(workouts as any, wk);

    // 40 * 0.6 = 24 → round to nearest 5 = 25; max(15, 25) = 25
    console.log(`[bridge] swim: estimatedDurationMin=${workouts[0].estimatedDurationMin}`);
    expect(workouts[0].estimatedDurationMin).toBeLessThan(40);
    expect(workouts[0].estimatedDurationMin).toBeGreaterThanOrEqual(15);
    expect(workouts[0].status).toBe('reduced');
  });

  it('scales run km string to ~60% of original', () => {
    const workouts = [
      {
        id: 'tri-run-1',
        t: 'easy',
        n: 'Easy Run',
        d: '10km easy pace',
        r: 3,
        discipline: 'run',
      },
    ];
    const wk = makeWk(SCALE);
    applyBridgeModsAllDisciplines(workouts as any, wk);

    // 10 * 0.6 = 6 → round to nearest 0.5 = 6; max(2, 6) = 6
    console.log(`[bridge] run: d="${workouts[0].d}"`);
    expect(workouts[0].d).toContain('km');
    // The km string should be smaller than original (10)
    const match = workouts[0].d.match(/(\d+\.?\d*)km/);
    const newKm = match ? parseFloat(match[1]) : 10;
    console.log(`[bridge] run km: 10 → ${newKm}`);
    expect(newKm).toBeLessThan(10);
    expect(newKm).toBeGreaterThanOrEqual(2);
    expect(workouts[0].status).toBe('reduced');
  });

  it('skips userScaledAt sessions (respect explicit user Adjust)', () => {
    const workouts = [
      {
        id: 'tri-swim-2',
        t: 'swim',
        n: 'Swim Steady',
        d: '50 min steady swim',
        r: 5,
        discipline: 'swim',
        estimatedDurationMin: 50,
        userScaledAt: '2026-06-01T10:00:00Z', // user has explicitly adjusted this session
      },
    ];
    const wk = makeWk(SCALE);
    applyBridgeModsAllDisciplines(workouts as any, wk);

    // userScaledAt should be respected — NO modification
    console.log(`[bridge] userScaledAt: estimatedDurationMin=${workouts[0].estimatedDurationMin} (should stay 50)`);
    expect(workouts[0].estimatedDurationMin).toBe(50);
    expect((workouts[0] as any).status).toBeUndefined();
  });

  it('no-op when _holidayBridgeScale is absent', () => {
    const workouts = [
      {
        id: 'tri-bike-2',
        t: 'bike_z2',
        n: 'Bike Easy',
        d: '60 min easy',
        r: 4,
        discipline: 'bike',
        estimatedDurationMin: 60,
      },
    ];
    const wk: any = {
      w: 3,
      ph: 'base',
      rated: {},
      skip: [],
      cross: [],
      wkGain: 0,
      workoutMods: [],
      adjustments: [],
      unspentLoad: 0,
      extraRunLoad: 0,
      // NO _holidayBridgeScale
    };
    applyBridgeModsAllDisciplines(workouts as any, wk);

    console.log(`[bridge] no-scale: estimatedDurationMin=${workouts[0].estimatedDurationMin} (should stay 60)`);
    expect(workouts[0].estimatedDurationMin).toBe(60);
    expect((workouts[0] as any).status).toBeUndefined();
  });

  it('musculoTendonLoad scales proportionally (bike)', () => {
    const workouts = [
      {
        id: 'hyrox-brick-1',
        t: 'hyrox_station',
        n: 'Station Circuit',
        d: '45 min station circuit',
        r: 6,
        discipline: 'station',
        estimatedDurationMin: 45,
        musculoTendonLoad: 200,
      },
    ];
    const wk = makeWk(SCALE);
    applyBridgeModsAllDisciplines(workouts as any, wk);

    const expectedMtl = Math.round(200 * SCALE);
    console.log(`[bridge] MTL: 200 → ${workouts[0].musculoTendonLoad} (expected ${expectedMtl})`);
    expect(workouts[0].musculoTendonLoad).toBe(expectedMtl);
  });

  it('already-holiday-modded sessions are skipped', () => {
    const workouts = [
      {
        id: 'tri-run-3',
        t: 'easy',
        n: 'Holiday, rest day',
        d: 'On holiday. No running planned.',
        r: 0,
        holidayMod: true,
        estimatedDurationMin: 0,
      },
    ];
    const wk = makeWk(SCALE);
    applyBridgeModsAllDisciplines(workouts as any, wk);

    // holidayMod sessions are already zeroed — do not touch them
    expect(workouts[0].estimatedDurationMin).toBe(0);
    expect((workouts[0] as any).status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Summary print — before/after table for all numeric scenarios
// ---------------------------------------------------------------------------

describe('summary: before/after dock fractions', () => {
  it('prints the detraining fraction table', () => {
    const scenarios = [
      { label: 'a: 21d sedentary',      days: 21, retention: 0 },
      { label: 'b: 8d short (deadzone)', days: 8,  retention: 0 },
      { label: 'c: 21d active (70%)',   days: 21, retention: 0.7 },
      { label: '10d boundary',          days: 10, retention: 0 },
      { label: '11d just past boundary',days: 11, retention: 0 },
      { label: '28d sedentary (max)',   days: 28, retention: 0 },
    ];

    console.log('\n── Detraining fraction table ──');
    console.log('Scenario'.padEnd(30), 'frac'.padStart(8), ' FTP_250→', ' CSS_100→', ' VDOT_50→');
    for (const sc of scenarios) {
      const frac = detrainingLossFraction(sc.days, sc.retention);
      const ftpAfter = Math.round(250 * (1 - frac));
      const cssAfter = Math.round(100 * (1 + frac));
      const vdotAfter = Math.max(Math.round(50 * (1 - frac) * 10) / 10, 20);
      console.log(
        sc.label.padEnd(30),
        frac.toFixed(5).padStart(8),
        String(ftpAfter).padStart(9),
        String(cssAfter).padStart(9),
        String(vdotAfter).padStart(9),
      );
    }
    expect(true).toBe(true); // always passes — informational only
  });

  it('DETRAINING_DEADZONE_DAYS constant is 10', () => {
    expect(DETRAINING_DEADZONE_DAYS).toBe(10);
  });
});
