/**
 * Regression test for ISSUE-189 — verify the bike-setup modal's local
 * prediction matches the headline forecast for the same inputs.
 *
 * The modal exists for users to tune fit, position, tires, and weights and
 * see the impact on bike split. If the modal's number differs from the
 * headline forecast (race-prediction.triathlon.ts), users lose trust in both.
 *
 * The bug: the modal originally applied only physics + physical course
 * factors, missing the empirical-course-factor calibration and the race-
 * readiness penalty multiplier the headline applies. After the fix the modal
 * routes through `lookupEmpiricalCourseFactors` + `pickCourseFactors` (same
 * source picker as the predictor) and reads `raceReadiness.bike.penaltyMultiplier`
 * from the cached prediction.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setState, getState } from '@/state/store';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { predictBikeSplit, type FormState } from './bike-setup-view';
import { CDA_PRESET, CRR_PRESET } from '@/calculations/bike-physics';
import type { SimulatorState } from '@/types/state';

function buildState(): SimulatorState {
  const futureRaceDate = new Date();
  futureRaceDate.setDate(futureRaceDate.getDate() + 20 * 7);
  const raceISO = futureRaceDate.toISOString().split('T')[0];

  const yearsAgo = new Date();
  yearsAgo.setFullYear(yearsAgo.getFullYear() - 3);

  return {
    eventType: 'triathlon',
    v: 50,
    bodyWeightKg: 72,
    w: 0,
    wks: [],
    triConfig: {
      distance: '70.3',
      raceDate: raceISO,
      skillRating: { swim: 3, bike: 3, run: 3 },
      swim: { cssSecPer100m: 95 },
      bike: {
        ftp: 270,
        hasPowerMeter: true,
        bikeWeightKg: 8.5,
        courseProfile: 'rolling',
        aeroProfiles: [
          {
            id: 'active',
            label: 'TT bike',
            position: 'tt-bike',
            cda: CDA_PRESET['tt-bike'],
            cdaSource: 'preset',
            crr: CRR_PRESET['race-clincher'],
            tire: 'race-clincher',
            drivetrainEff: 0.97,
            airDensityKgM3: 1.225,
          },
        ],
      },
    },
    onboarding: { selectedTriathlonId: 'im-703-mallorca' as any },
    firstStravaActivityISO: yearsAgo.toISOString(),
  } as unknown as SimulatorState;
}

describe('ISSUE-189: bike-setup modal preview matches headline forecast', () => {
  beforeEach(() => {
    setState(buildState());
  });

  it('modal preview agrees with headline bike split within rounding (currentBikeSec)', () => {
    const state = getState();
    const prediction = predictTriathlonRace(state);
    expect(prediction).not.toBeNull();
    const headlineCurrentBikeSec = prediction!.currentBikeSec;
    expect(headlineCurrentBikeSec).toBeGreaterThan(0);

    // Build a FormState matching the saved bike setup.
    const tri = state.triConfig!;
    const aero = tri.bike!.aeroProfiles![0];
    const form: FormState = {
      riderKg: state.bodyWeightKg!,
      bikeKg: tri.bike!.bikeWeightKg!,
      position: aero.position,
      tire: aero.tire!,
      cda: aero.cda,
      cdaSource: aero.cdaSource,
      course: tri.bike!.courseProfile!,
      ftp: tri.bike!.ftp!,
      calibDistKm: '',
      calibDurationMin: '',
      calibAvgPowerW: '',
      showCalib: false,
      autoCalib: null,
      courseDropdownOpen: false,
      showCdaInfo: false,
      showCrrInfo: false,
    };
    const modal = predictBikeSplit(form, '70.3');

    // Within 10 seconds — accounts for rounding (modal rounds final, headline
    // rounds intermediate).
    expect(Math.abs(modal.splitSec - headlineCurrentBikeSec!)).toBeLessThanOrEqual(10);
  });

  it('improving CdA in the modal reduces the predicted split (no readiness or course coupling)', () => {
    const state = getState();
    const tri = state.triConfig!;
    const aero = tri.bike!.aeroProfiles![0];
    const form: FormState = {
      riderKg: state.bodyWeightKg!,
      bikeKg: tri.bike!.bikeWeightKg!,
      position: aero.position,
      tire: aero.tire!,
      cda: aero.cda,
      cdaSource: aero.cdaSource,
      course: tri.bike!.courseProfile!,
      ftp: tri.bike!.ftp!,
      calibDistKm: '',
      calibDurationMin: '',
      calibAvgPowerW: '',
      showCalib: false,
      autoCalib: null,
      courseDropdownOpen: false,
      showCdaInfo: false,
      showCrrInfo: false,
    };
    const baseline = predictBikeSplit(form, '70.3');

    // 0.02 m² CdA improvement (≈ a hood-to-clip-ons jump for an amateur).
    const improved: FormState = { ...form, cda: form.cda - 0.02 };
    const tuned = predictBikeSplit(improved, '70.3');

    expect(tuned.splitSec).toBeLessThan(baseline.splitSec);
    expect(tuned.kph).toBeGreaterThan(baseline.kph);
  });
});
