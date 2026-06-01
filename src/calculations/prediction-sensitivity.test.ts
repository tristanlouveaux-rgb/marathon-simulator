/**
 * Flow-through guard: every input that SHOULD move the predicted time must
 * actually move it. This locks in the fix for the "I change a setting and the
 * number doesn't budge" class of bug (bike CdA/position/tyres/weight, FTP, CSS,
 * course, VDOT, PBs, HR, weekly volume, etc.).
 *
 * The test perturbs one factor at a time from a known-good baseline and asserts
 * the relevant predicted output changes (and, where physics dictates a sign,
 * that it moves the right way). It guards the PREDICTION layer — a future change
 * that makes a factor silently inert here fails CI. UI refresh/plumbing is
 * covered separately (manual + the onSaved wiring).
 */

import { describe, it, expect } from 'vitest';
import { predictTriathlonRace } from './race-prediction.triathlon';
import { predictCyclingEvent } from './race-prediction.cycling';
import { refreshBlendedFitness } from './blended-fitness';
import { defaultAeroProfile } from './bike-physics';
import type { SimulatorState } from '@/types/state';

function futureISO(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString().split('T')[0];
}
function yearsAgoISO(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString();
}

// ───────────────────────────────────────────────────────────────────────────
// Triathlon — full physics path active (aero profile + masses present)
// ───────────────────────────────────────────────────────────────────────────

function triState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    eventType: 'triathlon',
    v: 50,
    bodyWeightKg: 75,
    w: 0,
    wks: [],
    triConfig: {
      distance: '70.3',
      raceDate: futureISO(20),
      skillRating: { swim: 3, bike: 3, run: 3 },
      swim: { cssSecPer100m: 95 },
      bike: {
        ftp: 250,
        hasPowerMeter: true,
        bikeWeightKg: 9,
        courseProfile: 'hilly', // non-flat so mass has a clear effect
        aeroProfiles: [defaultAeroProfile('test', 'TT', 'tt-bike', 'race-clincher')],
      },
    },
    onboarding: { selectedTriathlonId: 'im-roth' as never },
    firstStravaActivityISO: yearsAgoISO(3),
    ...overrides,
  } as SimulatorState;
}

/** Deep-ish clone helper for nested triConfig.bike edits. */
function triWith(mutate: (s: SimulatorState) => void): SimulatorState {
  const s = triState();
  // ensure nested objects are fresh so we don't mutate the baseline
  s.triConfig = JSON.parse(JSON.stringify(s.triConfig));
  mutate(s);
  return s;
}

describe('triathlon: bike & aero factors flow through to the bike split', () => {
  const base = predictTriathlonRace(triState());

  it('baseline produces a finite bike split', () => {
    expect(base!.bikeSec).toBeGreaterThan(0);
  });

  it('rider weight: heavier is slower', () => {
    const heavy = predictTriathlonRace(triWith(s => { s.bodyWeightKg = 95; }));
    expect(heavy!.bikeSec).toBeGreaterThan(base!.bikeSec);
  });

  it('bike weight: heavier is slower', () => {
    const heavy = predictTriathlonRace(triWith(s => { s.triConfig!.bike!.bikeWeightKg = 14; }));
    expect(heavy!.bikeSec).toBeGreaterThan(base!.bikeSec);
  });

  it('riding position (CdA): more aero is faster', () => {
    const draggy = predictTriathlonRace(triWith(s => {
      s.triConfig!.bike!.aeroProfiles = [defaultAeroProfile('t', 'hoods', 'hoods', 'race-clincher')];
    }));
    expect(draggy!.bikeSec).toBeGreaterThan(base!.bikeSec);
  });

  it('tyres (Crr): slower-rolling is slower', () => {
    const slow = predictTriathlonRace(triWith(s => {
      s.triConfig!.bike!.aeroProfiles = [defaultAeroProfile('t', 'TT', 'tt-bike', 'gravel')];
    }));
    expect(slow!.bikeSec).toBeGreaterThan(base!.bikeSec);
  });

  it('course profile: hillier is slower', () => {
    const flat = predictTriathlonRace(triWith(s => { s.triConfig!.bike!.courseProfile = 'flat'; }));
    expect(flat!.bikeSec).toBeLessThan(base!.bikeSec);
  });

  it('FTP: more power is faster', () => {
    const strong = predictTriathlonRace(triWith(s => { s.triConfig!.bike!.ftp = 320; }));
    expect(strong!.bikeSec).toBeLessThan(base!.bikeSec);
  });

  it('CSS: faster swimmer has a faster swim split', () => {
    const fast = predictTriathlonRace(triWith(s => { s.triConfig!.swim!.cssSecPer100m = 80; }));
    expect(fast!.swimSec).toBeLessThan(base!.swimSec);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Cycling — shares the bike physics
// ───────────────────────────────────────────────────────────────────────────

function cycState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    eventType: 'cycling',
    bodyWeightKg: 75,
    w: 0,
    wks: [],
    triConfig: {
      distance: '70.3',
      bike: {
        ftp: 250,
        bikeWeightKg: 9,
        courseProfile: 'hilly',
        aeroProfiles: [defaultAeroProfile('test', 'TT', 'tt-bike', 'race-clincher')],
      },
    },
    onboarding: { cyclingDistance: '100km' },
    firstStravaActivityISO: yearsAgoISO(3),
    ...overrides,
  } as SimulatorState;
}
function cycWith(mutate: (s: SimulatorState) => void): SimulatorState {
  const s = cycState();
  s.triConfig = JSON.parse(JSON.stringify(s.triConfig));
  s.onboarding = JSON.parse(JSON.stringify(s.onboarding));
  mutate(s);
  return s;
}

describe('cycling: bike & aero factors flow through to the event time', () => {
  const base = predictCyclingEvent(cycState());

  it('baseline produces a finite time', () => {
    expect(base).not.toBeNull();
    expect(base!.totalSec).toBeGreaterThan(0);
  });

  it('rider weight: heavier is slower', () => {
    const heavy = predictCyclingEvent(cycWith(s => { s.bodyWeightKg = 95; }));
    expect(heavy!.totalSec).toBeGreaterThan(base!.totalSec);
  });

  it('CdA (position): more aero is faster', () => {
    const draggy = predictCyclingEvent(cycWith(s => {
      s.triConfig!.bike!.aeroProfiles = [defaultAeroProfile('t', 'hoods', 'hoods', 'race-clincher')];
    }));
    expect(draggy!.totalSec).toBeGreaterThan(base!.totalSec);
  });

  it('tyres (Crr): slower-rolling is slower', () => {
    const slow = predictCyclingEvent(cycWith(s => {
      s.triConfig!.bike!.aeroProfiles = [defaultAeroProfile('t', 'TT', 'tt-bike', 'gravel')];
    }));
    expect(slow!.totalSec).toBeGreaterThan(base!.totalSec);
  });

  it('FTP: more power is faster', () => {
    const strong = predictCyclingEvent(cycWith(s => { s.triConfig!.bike!.ftp = 320; }));
    expect(strong!.totalSec).toBeLessThan(base!.totalSec);
  });

  it('course profile: hillier is slower', () => {
    const flat = predictCyclingEvent(cycWith(s => { s.triConfig!.bike!.courseProfile = 'flat'; }));
    expect(flat!.totalSec).toBeLessThan(base!.totalSec);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Running — refreshBlendedFitness writes the predicted time onto state
// ───────────────────────────────────────────────────────────────────────────

function runState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    schemaVersion: 1,
    w: 1, tw: 16, v: 50, iv: 50, rpeAdj: 0,
    rd: 'marathon',
    epw: 5, rw: 5, wkm: 50,
    pbs: { m: 3 * 3600 + 30 * 60 }, // 3:30 marathon PB
    rec: null, lt: null, vo2: null,
    initialLT: null, initialVO2: null, initialBaseline: null,
    currentFitness: null, forecastTime: null,
    typ: 'Balanced', calculatedRunnerType: 'Balanced',
    b: 1.06, wks: [],
    pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
    skip: [], timp: 0, expectedFinal: 50,
    restingHR: 50, maxHR: 190,
    ...overrides,
  } as SimulatorState;
}
/** Run the running pipeline and return the current blended race time. */
function runTime(overrides: Partial<SimulatorState> = {}): number {
  const s = runState(overrides);
  refreshBlendedFitness(s);
  return s.blendedRaceTimeSec ?? s.forecastTime ?? 0;
}
/**
 * The end-of-plan forecast specifically. Some factors (carbon shoes, weekly
 * volume, weeks-remaining) move the projected race-day time without changing
 * the current-fitness baseline blend, so they must be asserted against
 * s.forecastTime rather than the blended baseline.
 */
function forecastTime(overrides: Partial<SimulatorState> = {}): number {
  const s = runState(overrides);
  refreshBlendedFitness(s);
  return s.forecastTime ?? 0;
}

describe('running: fitness factors flow through to the predicted time', () => {
  const base = runTime();

  it('baseline produces a finite time', () => {
    expect(base).toBeGreaterThan(0);
  });

  // Note: s.v (VDOT) is a DERIVED output of the blend (from PBs + run history),
  // not a free input — refreshBlendedFitness recomputes it. The real fitness
  // inputs are PBs, run history, and race distance, tested below.

  it('race distance: a half is faster than a marathon', () => {
    expect(runTime({ rd: 'half' })).toBeLessThan(base);
  });

  it('marathon PB: a faster PB pulls the prediction faster', () => {
    expect(runTime({ pbs: { m: 3 * 3600 } })).toBeLessThan(base);
  });

  it('runner type changes the prediction', () => {
    const speed = runTime({ typ: 'Speed', calculatedRunnerType: 'Speed' });
    const endurance = runTime({ typ: 'Endurance', calculatedRunnerType: 'Endurance' });
    expect(speed).not.toBe(endurance);
  });

  it('carbon shoes: supershoes make the forecast faster (~3%)', () => {
    const plain = forecastTime({ shoeKind: 'standard' });
    const carbon = forecastTime({ shoeKind: 'supershoes' });
    expect(plain).toBeGreaterThan(0);
    expect(carbon).toBeLessThan(plain);
    // Hoogkamer 2018: flat 3% economy boost → ~0.97 multiplier.
    expect(carbon / plain).toBeCloseTo(0.97, 2);
  });

  it('weekly volume: more running moves the projected race-day time', () => {
    const low = forecastTime({ wkm: 30, epw: 3, rw: 3 });
    const high = forecastTime({ wkm: 80, epw: 6, rw: 6 });
    expect(low).toBeGreaterThan(0);
    expect(high).not.toBe(low);
  });
});
