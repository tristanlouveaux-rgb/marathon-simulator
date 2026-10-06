/**
 * A week's actual load is derived from its activities, never a stored running
 * total (audit B18, load-accounting item F6).
 *
 * `wk.actualTSS` used to be an add-only running total: a re-review re-added
 * logged and excess items, a reclassify applied a runSpec delta to a Signal B
 * total, and removal, reconcile drops and Discard never subtracted. Its readers
 * (holiday snapshot and detraining ratio, week-end zone carry, AI coach
 * skeleton, sleep insight) now read computeWeekActualTSS, the canonical weekly
 * Signal B the Plan bar shows. These tests pin that contract.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeWeekActualTSS,
  computeWeekRawTSS,
  recentWeeksActualTSS,
  setAthleteNormalizer,
  getAthleteNormalizer,
} from './fitness-model';
import { addAdhocWorkoutFromPending } from './activity-matcher';
import { reclassifyActivity } from '@/ui/sport-picker-modal';
import { getDefaultState, setState, getMutableState } from '@/state/store';
import type { GarminActual, GarminPendingItem, Week } from '@/types';

beforeEach(() => setAthleteNormalizer()); // population normalizer

/** iTRIMP that decodes to `tss` under the current normalizer (exact inverse of normalizeiTrimp). */
function iTrimpFor(tss: number): number {
  return (tss * getAthleteNormalizer()) / 100;
}

function emptyWeek(w: number): Week {
  return {
    w, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
  } as Week;
}

function pendingHike(garminId: string, tss: number): GarminPendingItem {
  return {
    garminId,
    activityType: 'HIKING',
    appType: 'walk',
    startTime: '2026-09-29T09:00:00.000Z',
    durationSec: 90 * 60,
    distanceM: 6000,
    avgHR: 120,
    maxHR: 140,
    aerobicEffect: null,
    anaerobicEffect: null,
    garminRpe: null,
    calories: null,
    iTrimp: iTrimpFor(tss),
  };
}

function rideActual(garminId: string, tss: number): GarminActual {
  return {
    garminId,
    startTime: '2026-09-30T07:00:00.000Z',
    distanceKm: 30,
    durationSec: 75 * 60,
    avgPaceSecKm: null,
    avgHR: 135,
    maxHR: 160,
    calories: null,
    iTrimp: iTrimpFor(tss),
    activityType: 'CYCLING',
  } as GarminActual;
}

describe('computeWeekActualTSS: the week total is derived, not stored', () => {
  it('equals the Plan bar Signal B and ignores a legacy stored actualTSS', () => {
    const wk = emptyWeek(1);
    wk.garminActuals = { 'garmin-strava-1': rideActual('strava-1', 80) };
    (wk as any).actualTSS = 313; // a legacy add-only total, e.g. a ride re-added over four syncs

    expect(computeWeekActualTSS(wk, '2026-09-28')).toBe(computeWeekRawTSS(wk, wk.rated, '2026-09-28'));
    expect(computeWeekActualTSS(wk, '2026-09-28')).toBe(80);
  });

  it('a missing week reads zero', () => {
    expect(computeWeekActualTSS(undefined)).toBe(0);
  });

  it('a re-review that re-adds a logged activity leaves the week total unchanged and stores no running total', () => {
    const wk = emptyWeek(3);
    const item = pendingHike('strava-hike-1', 60);
    const adhocId = `garmin-${item.garminId}`;

    addAdhocWorkoutFromPending(wk, item, adhocId, 5);
    const once = computeWeekActualTSS(wk);
    expect(once).toBe(60);

    // openActivityReReview's undo removes the adhoc entry (activity-review.ts),
    // then Save re-adds it through addAdhocWorkoutFromPending. Three unchanged
    // Saves used to take the stored total 60 -> 120 -> 180 -> 240.
    for (let i = 0; i < 3; i++) {
      wk.adhocWorkouts = (wk.adhocWorkouts ?? []).filter(w => w.id !== adhocId);
      addAdhocWorkoutFromPending(wk, item, adhocId, 5);
      expect(computeWeekActualTSS(wk)).toBe(once);
    }
    expect((wk as any).actualTSS).toBeUndefined();
  });

  it('removing an activity lowers the week total to what is left', () => {
    const wk = emptyWeek(2);
    addAdhocWorkoutFromPending(wk, pendingHike('strava-hike-2', 40), 'garmin-strava-hike-2', 5);
    wk.garminActuals!['garmin-strava-ride-2'] = rideActual('strava-ride-2', 80);
    expect(computeWeekActualTSS(wk)).toBe(120);

    // removeGarminActivity drops the adhoc entry and its garminActuals twin.
    wk.adhocWorkouts = wk.adhocWorkouts!.filter(w => w.id !== 'garmin-strava-hike-2');
    delete wk.garminActuals!['garmin-strava-hike-2'];
    expect(computeWeekActualTSS(wk)).toBe(80);
  });

  it('reclassifying an activity writes no week total, and Signal B does not move with the sport label', () => {
    const s = getDefaultState();
    const wk = emptyWeek(1);
    const ride = rideActual('strava-ride-3', 80);
    wk.garminActuals = { 'garmin-strava-ride-3': ride };
    s.wks = [wk];
    s.w = 1;
    setState(s);

    const live = getMutableState().wks[0];
    const before = computeWeekActualTSS(live);
    reclassifyActivity(live.garminActuals!['garmin-strava-ride-3'], 'yoga');

    // The old delta writer set wk.actualTSS = round(old + (yogaTL - cyclingTL)),
    // a runSpec-weighted delta on a Signal B total (probe: 80 -> 62).
    expect((live as any).actualTSS).toBeUndefined();
    expect(computeWeekActualTSS(live)).toBe(before);
  });
});

describe('recentWeeksActualTSS: the recent-load window ends at the current week', () => {
  it('reads the weeks up to the current week, oldest first, never the final plan weeks', () => {
    const wks = Array.from({ length: 16 }, (_, i) => emptyWeek(i + 1));
    wks[3].garminActuals = { 'garmin-a': rideActual('a', 100) }; // week 4
    wks[4].garminActuals = { 'garmin-b': rideActual('b', 300) }; // week 5 (current)
    (wks[15] as any).actualTSS = 999; // legacy value on the final plan week

    // The sleep view used to read wks.slice(-4) of the whole plan, i.e. weeks
    // 13-16, so its "hard week" check looked at the final plan week.
    expect(recentWeeksActualTSS(wks, 5, 4)).toEqual([0, 0, 100, 300]);
  });

  it('early in the plan it returns only the weeks that exist', () => {
    const wks = Array.from({ length: 16 }, (_, i) => emptyWeek(i + 1));
    wks[0].garminActuals = { 'garmin-c': rideActual('c', 50) };
    expect(recentWeeksActualTSS(wks, 1, 4)).toEqual([50]);
    expect(recentWeeksActualTSS(undefined, 3, 4)).toEqual([]);
  });
});

describe('no code keeps a wk.actualTSS running total', () => {
  it('no source file writes the retired wk.actualTSS field', () => {
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const [i, line] of src.split('\n').entries()) {
          const code = line.split('//')[0];
          if (/\.actualTSS\s*=(?!=)/.test(code) || /\[\s*['"]actualTSS['"]\s*\]\s*=(?!=)/.test(code)) {
            offenders.push(`${path.relative(root, full)}:${i + 1}`);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
