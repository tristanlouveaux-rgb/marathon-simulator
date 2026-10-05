/**
 * The iTRIMP→TSS normalizer must (1) use the same Banister β as the iTRIMP
 * producers for the athlete's sex, and (2) never go stale after an in-session
 * HR-profile edit (audit B12; A1 related defect, Account HR save).
 *
 * (1) Every producer (trimp.ts, the Strava edge function, Apple Health, FIT
 * import) builds female iTRIMP with β 1.67. The normalizer hard-coded β 1.92,
 * so 1 hour at LTHR decoded to e^(−0.25·hrr) ≈ 81 TSS for women instead of
 * the Coggan hrTSS definition of 100.
 *
 * (2) The module normalizer was a value set at launch. Saving max/resting HR
 * in Account (or any physiology sync / LT recompute outside the launch refresh
 * points) left it stale until the next cold launch, while surfaces that read
 * getNormalizerFromState(s) were already fresh, so the same activity showed two
 * TSS values. It is now bound to live state.
 *
 * (3) Producer and normalizer must resolve the athlete's sex the same way.
 * During the onboarding wizard the answer lives only on
 * s.onboarding.biologicalSex (plan init copies it to s.biologicalSex), so a
 * normalizer reading s.biologicalSex alone decodes wizard-stamped iTRIMP with
 * a different β than it was produced with. Both sides now go through
 * trimp.ts resolveBiologicalSex.
 *
 * Fixture profile (LTHR 168, rest 50, max 190 = 88% of max, inside the
 * plausible LTHR band) is the B12 audit probe profile.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  computeAthleteNormalizer,
  getNormalizerFromState,
  setAthleteNormalizer,
  bindAthleteNormalizerToState,
  normalizeiTrimp,
  getAthleteNormalizer,
  computeWeekRawTSS,
  type AthleteHRProfile,
} from './fitness-model';
import {
  calculateITrimp, calculateITrimpFromLaps, calculateITrimpFromSummary, getBeta,
  resolveBiologicalSex, resolveTrimpSex,
} from './trimp';
import type { Week, GarminActual } from '@/types';

const LT = 168;
const REST = 50;
const MAX = 190;
const HRR_AT_LT = (LT - REST) / (MAX - REST);

/** One hour of 1-second samples held exactly at `hr` (3600 s of integrated time). */
function hourAt(hr: number): { hrs: number[]; ts: number[] } {
  const hrs: number[] = [];
  const ts: number[] = [];
  for (let t = 0; t <= 3600; t++) { hrs.push(hr); ts.push(t); }
  return { hrs, ts };
}

afterEach(() => setAthleteNormalizer()); // unbind + population 15000

describe('normalizer β follows the athlete\'s sex (same β as the iTRIMP producers)', () => {
  it('female: 1 hour at LTHR decodes to exactly 100 TSS through every iTRIMP tier', () => {
    const norm = getNormalizerFromState({ ltHR: LT, restingHR: REST, maxHR: MAX, biologicalSex: 'female' });
    const { hrs, ts } = hourAt(LT);
    const stream = calculateITrimp(hrs, ts, REST, MAX, 'female');
    const laps = calculateITrimpFromLaps([{ avgHR: LT, durationSec: 3600 }], REST, MAX, 'female');
    const summary = calculateITrimpFromSummary(LT, 3600, REST, MAX, 'female');
    expect(normalizeiTrimp(stream, norm)).toBeCloseTo(100, 6);
    expect(normalizeiTrimp(laps, norm)).toBeCloseTo(100, 6);
    expect(normalizeiTrimp(summary, norm)).toBeCloseTo(100, 6);
  });

  it('female normalizer is the Coggan anchor with β 1.67 (getBeta), not 1.92', () => {
    const female = computeAthleteNormalizer(LT, REST, MAX, 'female');
    expect(getBeta('female')).toBe(1.67);
    expect(female).toBeCloseTo(3600 * HRR_AT_LT * Math.exp(getBeta('female') * HRR_AT_LT), 6);
    // The old male-β normalizer read female load e^(−0.25·hrr) low (~0.81 here).
    const male = computeAthleteNormalizer(LT, REST, MAX, 'male');
    expect(female / male).toBeCloseTo(Math.exp((1.67 - 1.92) * HRR_AT_LT), 10);
  });

  it('male, unset and prefer_not_to_say keep β 1.92, matching the producers\' default', () => {
    const expected = 3600 * HRR_AT_LT * Math.exp(1.92 * HRR_AT_LT);
    expect(computeAthleteNormalizer(LT, REST, MAX, 'male')).toBeCloseTo(expected, 6);
    expect(computeAthleteNormalizer(LT, REST, MAX)).toBeCloseTo(expected, 6);
    expect(computeAthleteNormalizer(LT, REST, MAX, 'prefer_not_to_say')).toBeCloseTo(expected, 6);
    const { hrs, ts } = hourAt(LT);
    expect(normalizeiTrimp(calculateITrimp(hrs, ts, REST, MAX), expected)).toBeCloseTo(100, 6);
  });

  it('getNormalizerFromState reads biologicalSex from a state-shaped object', () => {
    const base: AthleteHRProfile = { ltHR: LT, restingHR: REST, maxHR: MAX };
    expect(getNormalizerFromState({ ...base, biologicalSex: 'female' }))
      .toBe(computeAthleteNormalizer(LT, REST, MAX, 'female'));
    expect(getNormalizerFromState(base)).toBe(computeAthleteNormalizer(LT, REST, MAX, 'male'));
  });

  it('the population fallback stays sex-neutral until a documented derivation exists', () => {
    // 15000 has no stated HR profile behind it (see SCIENCE_LOG, Athlete
    // Normalizer). A female-specific fallback would be an invented number.
    expect(computeAthleteNormalizer(undefined, REST, MAX, 'female')).toBe(15000);
    expect(computeAthleteNormalizer(144, 42, 192, 'female')).toBe(15000); // implausible ltHR gate
  });

  it('weekly raw load (Signal B) for a female athlete: an hour at LTHR counts as 100 TSS', () => {
    const state = { ltHR: LT, restingHR: REST, maxHR: MAX, biologicalSex: 'female' as const };
    bindAthleteNormalizerToState(() => state);
    const { hrs, ts } = hourAt(LT);
    const actual = {
      garminId: 'strava-1', startTime: '2026-03-04T08:00:00Z', distanceKm: 14, durationSec: 3600,
      avgPaceSecKm: 257, avgHR: LT, maxHR: LT, calories: null,
      iTrimp: calculateITrimp(hrs, ts, REST, MAX, 'female'),
      hrZones: null, activityType: 'RUNNING', workoutName: 'Threshold',
    } as unknown as GarminActual;
    const wk = {
      w: 1, ph: 'build', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
      unspentLoad: 0, extraRunLoad: 0, garminActuals: { 'w1-threshold': actual }, adhocWorkouts: [], unspentLoadItems: [],
    } as unknown as Week;
    expect(computeWeekRawTSS(wk, {}, '2026-03-02')).toBe(100);
  });
});

describe('module normalizer is bound to live state and cannot go stale', () => {
  it('an Account max/resting HR edit takes effect on the next conversion with no refresh call', () => {
    const s: AthleteHRProfile = { ltHR: LT, restingHR: REST, maxHR: MAX, biologicalSex: 'male' };
    bindAthleteNormalizerToState(() => s);
    expect(getAthleteNormalizer()).toBeCloseTo(getNormalizerFromState(s), 10);

    // Same writes as account-view btn-save-hr: s.maxHR / s.restingHR, then saveState().
    s.maxHR = 196;
    s.restingHR = 46;
    const fresh = computeAthleteNormalizer(LT, 46, 196, 'male');
    expect(getAthleteNormalizer()).toBeCloseTo(fresh, 10);
    expect(normalizeiTrimp(fresh)).toBeCloseTo(100, 10);
  });

  it('module normalizer and getNormalizerFromState(s) agree after every profile change', () => {
    const s: AthleteHRProfile = { ltHR: LT, restingHR: REST, maxHR: MAX };
    bindAthleteNormalizerToState(() => s);
    const edits: Array<(p: AthleteHRProfile) => void> = [
      p => { p.biologicalSex = 'female'; },  // HealthKit sex seeding
      p => { p.ltHR = 170; },                // LT recompute after a sync
      p => { p.restingHR = 44; },            // physiology snapshot
      p => { p.ltHR = 150; },                // implausible (79% of max) → population fallback
    ];
    for (const edit of edits) {
      edit(s);
      expect(getAthleteNormalizer()).toBe(getNormalizerFromState(s));
    }
  });

  it('follows a replaced state object (updateState swaps the object, the getter reads it fresh)', () => {
    let current: AthleteHRProfile = { ltHR: LT, restingHR: REST, maxHR: MAX, biologicalSex: 'male' };
    bindAthleteNormalizerToState(() => current);
    const before = getAthleteNormalizer();
    current = { ...current, biologicalSex: 'female' };
    expect(getAthleteNormalizer()).not.toBe(before);
    expect(getAthleteNormalizer()).toBe(computeAthleteNormalizer(LT, REST, MAX, 'female'));
  });

  it('encode/decode stays an exact round-trip across a profile change', () => {
    const s: AthleteHRProfile = { ltHR: LT, restingHR: REST, maxHR: MAX };
    bindAthleteNormalizerToState(() => s);
    s.biologicalSex = 'female';
    const encoded = (73.4 * getAthleteNormalizer()) / 100;
    expect(normalizeiTrimp(encoded)).toBeCloseTo(73.4, 8);
  });

  it('an explicit setAthleteNormalizer replaces the binding', () => {
    const s: AthleteHRProfile = { ltHR: LT, restingHR: REST, maxHR: MAX, biologicalSex: 'female' };
    bindAthleteNormalizerToState(() => s);
    setAthleteNormalizer();
    s.maxHR = 200;
    expect(getAthleteNormalizer()).toBe(15000);
  });
});

describe('producers and the normalizer resolve sex the same way, including mid-wizard', () => {
  type WizardState = AthleteHRProfile & { hasCompletedOnboarding?: boolean };
  const wizard = (onboardingSex?: 'male' | 'female' | 'prefer_not_to_say', topLevel?: 'male' | 'female'): WizardState => ({
    ltHR: LT, restingHR: REST, maxHR: MAX,
    hasCompletedOnboarding: false,
    biologicalSex: topLevel,
    onboarding: { biologicalSex: onboardingSex },
  });
  /** What initialization*.ts does with the wizard answer: copy it over when set, then finish onboarding. */
  const initialisePlan = (s: WizardState) => {
    if (s.onboarding?.biologicalSex) s.biologicalSex = s.onboarding.biologicalSex;
    s.hasCompletedOnboarding = true;
  };

  it('mid-wizard, the answer on s.onboarding is the resolved sex', () => {
    expect(resolveBiologicalSex(wizard('female'))).toBe('female');
    expect(resolveTrimpSex(wizard('female'))).toBe('female');
    // HealthKit seeded s.biologicalSex, then the user answered differently in about-you.
    expect(resolveBiologicalSex(wizard('female', 'male'))).toBe('female');
  });

  it('after onboarding, s.biologicalSex wins and the wizard answer is only a fallback', () => {
    expect(resolveBiologicalSex({ hasCompletedOnboarding: true, biologicalSex: 'female', onboarding: { biologicalSex: 'male' } })).toBe('female');
    expect(resolveBiologicalSex({ hasCompletedOnboarding: true, onboarding: { biologicalSex: 'female' } })).toBe('female');
    expect(resolveBiologicalSex({ biologicalSex: 'female' })).toBe('female'); // state with no onboarding object
    expect(resolveBiologicalSex({})).toBeUndefined();
  });

  it('prefer_not_to_say resolves to the producers\' default β (no sex argument)', () => {
    expect(resolveTrimpSex(wizard('prefer_not_to_say'))).toBeUndefined();
    expect(getNormalizerFromState(wizard('prefer_not_to_say'))).toBe(computeAthleteNormalizer(LT, REST, MAX, 'male'));
  });

  it('the normalizer reads the wizard answer when s.biologicalSex is not yet set', () => {
    expect(getNormalizerFromState(wizard('female'))).toBe(computeAthleteNormalizer(LT, REST, MAX, 'female'));
  });

  it('an hour at LTHR stamped during the wizard decodes to 100 TSS once the plan is initialised', () => {
    for (const s of [wizard('female'), wizard('female', 'male'), wizard('male')]) {
      bindAthleteNormalizerToState(() => s);
      const { hrs, ts } = hourAt(LT);
      const stamped = calculateITrimp(hrs, ts, REST, MAX, resolveTrimpSex(s)); // e.g. review-step backfill
      expect(normalizeiTrimp(stamped)).toBeCloseTo(100, 6);                  // decoded mid-wizard
      initialisePlan(s);
      expect(normalizeiTrimp(stamped)).toBeCloseTo(100, 6);                  // decoded after plan init
    }
  });

  it('the bound normalizer follows the plan-init copy of the wizard answer', () => {
    const s = wizard('female', 'male');
    bindAthleteNormalizerToState(() => s);
    const female = computeAthleteNormalizer(LT, REST, MAX, 'female');
    expect(getAthleteNormalizer()).toBe(female);
    initialisePlan(s);
    expect(getAthleteNormalizer()).toBe(female);
    expect(getAthleteNormalizer()).toBe(getNormalizerFromState(s));
  });
});

describe('guard: every client iTRIMP producer takes sex from resolveBiologicalSex', () => {
  it('no producer reads s.biologicalSex directly for β', () => {
    const srcRoot = path.join(__dirname, '..');
    const patterns = [
      /biological_sex:\s*\w+\.biologicalSex\b/,                                   // edge-function payload
      /\.biologicalSex === 'male' \|\| \w+\.biologicalSex === 'female'/,              // inline narrowing for a producer
      /(calculateITrimp\w*|resolveITrimp|computeHREnrichment\w*|streamsToActivityRow)\([^)]*\.biologicalSex/,
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        for (const [i, line] of lines.entries()) {
          const code = line.split('//')[0];
          if (patterns.some(re => re.test(code))) offenders.push(`${full}:${i + 1}`);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

describe('guard: production code binds the normalizer instead of setting a launch-time copy', () => {
  it('launchApp binds to live state, and no non-test file calls setAthleteNormalizer', () => {
    const srcRoot = path.join(__dirname, '..');
    expect(fs.readFileSync(path.join(srcRoot, 'main.ts'), 'utf8')).toMatch(/bindAthleteNormalizerToState\(\s*\(\)\s*=>\s*getState\(\)\s*\)/);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        if (entry.name === 'fitness-model.ts') continue; // the definition
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        for (const [i, line] of lines.entries()) {
          if (/\bsetAthleteNormalizer\s*\(/.test(line.split('//')[0])) offenders.push(`${full}:${i + 1}`);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
