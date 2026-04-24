/**
 * Triathlon race-time prediction.
 *
 * **Side of the line**: tracking. Produces `TriRacePrediction` objects shown
 * in the stats and home views. Not consumed by the plan engine.
 *
 * Per-leg predictions:
 *   - Swim: distance / CSS-adjusted pace. Race-pace ≈ CSS + 5s/100m for
 *     sustained open-water effort (Dekerle 2002).
 *   - Bike: time = distance × (FTP → speed map) if power available,
 *     otherwise from skill slider (level-based pace).
 *   - Run: distance × race-pace derived from VDOT (if known), otherwise
 *     from skill slider. Then apply §18.2 fatigue discount (5% for 70.3,
 *     11% for IM) — this is the tracking-side pace discount.
 *   - T1 / T2: level-based defaults from triathlon-constants.
 */

import type { SimulatorState } from '@/types/state';
import type { TriRacePrediction, TriSkillSlider } from '@/types/triathlon';
import {
  RACE_LEG_DISTANCES,
  RUN_FATIGUE_DISCOUNT_70_3,
  RUN_FATIGUE_DISCOUNT_IRONMAN,
  T1_SEC_BY_SLIDER,
  T2_SEC_BY_SLIDER,
} from '@/constants/triathlon-constants';

export function predictTriathlonRace(state: SimulatorState): TriRacePrediction | null {
  const tri = state.triConfig;
  if (!tri) return null;

  const distance = tri.distance;
  const legs = RACE_LEG_DISTANCES[distance];
  const rating = tri.skillRating ?? { swim: 3, bike: 3, run: 3 };

  // Swim
  const cssSec = tri.swim?.cssSecPer100m ?? estimateCSSFromSkill(rating.swim as TriSkillSlider);
  // Race pace = CSS + 5 s/100m (Dekerle 2002 — lactate steady state is slightly below CSS)
  const swimPaceSecPer100m = cssSec + 5;
  const swimSec = Math.round((legs.swimM / 100) * swimPaceSecPer100m);

  // Bike
  const bikeAvgKph = estimateBikeSpeed(tri.bike?.ftp, tri.bike?.hasPowerMeter, rating.bike as TriSkillSlider, distance);
  const bikeSec = Math.round((legs.bikeKm / bikeAvgKph) * 3600);

  // Run — base pace from VDOT if available, else skill fallback
  const baseRunPaceSecPerKm = state.v ? vdotToRacePaceSecPerKm(state.v, distance) : estimateRunPaceFromSkill(rating.run as TriSkillSlider, distance);
  // Apply fatigue discount (tracking-side only per §18.4)
  const discount = distance === 'ironman' ? RUN_FATIGUE_DISCOUNT_IRONMAN : RUN_FATIGUE_DISCOUNT_70_3;
  const adjustedRunPaceSecPerKm = baseRunPaceSecPerKm * (1 + discount);
  const runSec = Math.round(legs.runKm * adjustedRunPaceSecPerKm);

  // Transitions
  const t1Sec = T1_SEC_BY_SLIDER[rating.bike as TriSkillSlider];
  const t2Sec = T2_SEC_BY_SLIDER[rating.bike as TriSkillSlider];

  const totalSec = swimSec + t1Sec + bikeSec + t2Sec + runSec;

  // ±range: ~8% for 70.3, ~10% for IM. Represents uncertainty from individual
  // variation in bike-run fatigue response, race-day conditions, and nutrition.
  const rangePct = distance === 'ironman' ? 0.10 : 0.08;
  const totalRangeSec: [number, number] = [
    Math.round(totalSec * (1 - rangePct)),
    Math.round(totalSec * (1 + rangePct)),
  ];

  // Sprint / Olympic side-effect predictions
  const sprintTotalSec = estimateSideDistance('sprint', cssSec, bikeAvgKph, baseRunPaceSecPerKm);
  const olympicTotalSec = estimateSideDistance('olympic', cssSec, bikeAvgKph, baseRunPaceSecPerKm);

  return {
    totalSec,
    swimSec,
    t1Sec,
    bikeSec,
    t2Sec,
    runSec,
    totalRangeSec,
    sprintTotalSec,
    olympicTotalSec,
    computedAtISO: new Date().toISOString(),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function estimateCSSFromSkill(slider: TriSkillSlider): number {
  // Rough CSS by skill (sec/100m). Linear from 2:50 (slider 1) to 1:25 (slider 5).
  const map: Record<TriSkillSlider, number> = { 1: 170, 2: 150, 3: 120, 4: 100, 5: 85 };
  return map[slider];
}

function estimateBikeSpeed(
  ftp: number | undefined,
  hasPower: boolean | undefined,
  skill: TriSkillSlider,
  distance: '70.3' | 'ironman'
): number {
  // If FTP known, map race intensity to speed. 70.3 typically ~78% FTP,
  // IM typically ~70% FTP. Speed at N% FTP depends on aero + weight but a
  // rough approximation: 1W/kg sustainable ≈ 30 kph on flat roads for
  // a typical age-grouper on a road bike. IF = 0.78, FTP = 220W, 75kg → 2.3 W/kg
  // race → ~38 kph. This is an approximation; real prediction needs a CdA
  // model, which we defer.
  if (hasPower && ftp) {
    const racePct = distance === 'ironman' ? 0.70 : 0.78;
    const raceWatts = ftp * racePct;
    // Linear fit: 100W = 25 kph, 300W = 40 kph. Rough but reasonable for flat courses.
    const kph = Math.min(48, Math.max(18, 20 + (raceWatts - 100) * 0.067));
    return kph;
  }
  // Skill-based fallback (race-pace km/h on flat course)
  const byLevel: Record<TriSkillSlider, number> = { 1: 24, 2: 28, 3: 32, 4: 36, 5: 40 };
  let base = byLevel[skill];
  // IM is slower than 70.3
  if (distance === 'ironman') base -= 3;
  return base;
}

function estimateRunPaceFromSkill(skill: TriSkillSlider, distance: '70.3' | 'ironman'): number {
  // Marathon-equivalent race pace by skill, sec/km.
  const byLevel: Record<TriSkillSlider, number> = { 1: 420, 2: 360, 3: 300, 4: 260, 5: 225 };
  let base = byLevel[skill];
  // 70.3 run is shorter — slightly faster baseline
  if (distance === '70.3') base -= 15;
  return base;
}

function vdotToRacePaceSecPerKm(vdot: number, distance: '70.3' | 'ironman'): number {
  // Rough VDOT → race pace (sec/km). Daniels' tables map roughly:
  //   VDOT 40 → marathon ~3:38/km, half ~3:20/km
  //   VDOT 50 → marathon ~3:05/km, half ~2:49/km
  //   VDOT 60 → marathon ~2:41/km, half ~2:26/km
  // Linear fit good enough for a prediction card.
  const halfPace = 318 - (vdot - 40) * 3.0;       // ~3:18 at 40, ~2:48 at 50, ~2:18 at 60
  const marathonPace = halfPace + 20;              // marathon slightly slower
  return distance === 'ironman' ? marathonPace : halfPace;
}

function estimateSideDistance(
  which: 'sprint' | 'olympic',
  cssSec: number,
  bikeKph: number,
  runPaceSecPerKm: number
): number {
  const dist = which === 'sprint'
    ? { swimM: 750, bikeKm: 20, runKm: 5 }
    : { swimM: 1500, bikeKm: 40, runKm: 10 };
  const swimSec = (dist.swimM / 100) * (cssSec + 5);
  const bikeSec = (dist.bikeKm / bikeKph) * 3600;
  const runSec = dist.runKm * runPaceSecPerKm;
  const transitionBuffer = which === 'sprint' ? 180 : 300;
  return Math.round(swimSec + bikeSec + runSec + transitionBuffer);
}
