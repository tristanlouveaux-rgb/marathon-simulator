import type { Paces } from '@/types';
import type { SplitScheme, SplitSegment } from '@/types';
import { getPaceForZone } from '@/calculations';

/**
 * Build a SplitScheme from a workout description and current paces.
 * Parses the workout description (same formats as parser.ts) and creates
 * distance-based segments the tracker will watch for.
 */
export function buildSplitScheme(workoutDesc: string, paces: Paces): SplitScheme {
  // Try interval format: "8×400 @ 5K, 90s" or "4×1km @ threshold, 2min"
  const intervalDistMatch = workoutDesc.match(
    /^(\d+)×(\d+\.?\d*)(m|mi|km|k)\s*@\s*([\w\-]+),?\s*(\d+)-?(\d*)(s|min)?/i
  );
  if (intervalDistMatch) {
    return buildIntervalScheme(intervalDistMatch, paces);
  }

  // Try interval without unit: "8×800 @ 5K, 90s"
  const noUnitMatch = workoutDesc.match(
    /^(\d+)×(\d+\.?\d*)\s*@\s*([\w\-]+),?\s*(\d+)-?(\d*)(s|min)?/i
  );
  if (noUnitMatch) {
    const adapted = [
      noUnitMatch[0], noUnitMatch[1], noUnitMatch[2], 'm',
      noUnitMatch[3], noUnitMatch[4], noUnitMatch[5], noUnitMatch[6]
    ] as unknown as RegExpMatchArray;
    return buildIntervalScheme(adapted, paces);
  }

  // Try time intervals: "3×10min @ threshold, 2min"
  const timeIntervalMatch = workoutDesc.match(
    /^(\d+)×(\d+)min\s*@\s*(\w+),?\s*(\d+)min/i
  );
  if (timeIntervalMatch) {
    return buildTimeIntervalScheme(timeIntervalMatch, paces);
  }

  // Try progressive: "21km: last 5 @ HM"
  const progressiveMatch = workoutDesc.match(
    /^(\d+\.?\d*)km:?\s*last\s*(\d+\.?\d*)\s*@\s*(\w+)/i
  );
  if (progressiveMatch) {
    return buildProgressiveScheme(progressiveMatch, paces);
  }

  // Try distance @ pace: "20km @ MP"
  const distAtPaceMatch = workoutDesc.match(/^(\d+\.?\d*)km\s*@\s*(\w+)/i);
  if (distAtPaceMatch) {
    const dist = parseFloat(distAtPaceMatch[1]) * 1000;
    const pace = getPaceForZone(distAtPaceMatch[2], paces);
    return buildKmSplits(dist, pace, `${distAtPaceMatch[1]}km @ ${distAtPaceMatch[2]}`);
  }

  // Try simple distance: "8km"
  const simpleDistMatch = workoutDesc.match(/^(\d+\.?\d*)km$/i);
  if (simpleDistMatch) {
    const dist = parseFloat(simpleDistMatch[1]) * 1000;
    return buildKmSplits(dist, paces.e, `${simpleDistMatch[1]}km easy`);
  }

  // Fallback: km splits for whatever distance we can extract
  const anyDistMatch = workoutDesc.match(/(\d+\.?\d*)\s*km/i);
  if (anyDistMatch) {
    const dist = parseFloat(anyDistMatch[1]) * 1000;
    return buildKmSplits(dist, null, workoutDesc);
  }

  // Can't parse — return empty scheme
  return { segments: [], totalDistance: 0, description: workoutDesc };
}

function buildIntervalScheme(match: RegExpMatchArray, paces: Paces): SplitScheme {
  const reps = parseInt(match[1]);
  const dist = parseFloat(match[2]);
  const unit = match[3].toLowerCase();
  const zone = match[4];
  const restVal = parseInt(match[5]);
  const restUnit = match[7] || 's';

  let distPerRep = 0;
  if (unit === 'm') distPerRep = dist;
  else if (unit === 'mi') distPerRep = dist * 1609;
  else if (unit === 'km' || unit === 'k') distPerRep = dist * 1000;

  const workPace = getPaceForZone(zone, paces);

  // Estimate recovery distance from rest time at easy pace
  const restSeconds = restUnit === 'min' ? restVal * 60 : restVal;
  const recoveryDist = (restSeconds / paces.e) * 1000;

  const segments: SplitSegment[] = [];
  for (let i = 0; i < reps; i++) {
    segments.push({
      label: `Rep ${i + 1} of ${reps}`,
      distance: distPerRep,
      targetPace: workPace,
    });
    if (i < reps - 1 && recoveryDist > 0) {
      segments.push({
        label: `Recovery ${i + 1}`,
        distance: recoveryDist,
        targetPace: null, // recovery is untimed
      });
    }
  }

  const totalDist = segments.reduce((s, seg) => s + seg.distance, 0);
  return {
    segments,
    totalDistance: totalDist,
    description: `${reps}×${dist}${unit} @ ${zone}`,
  };
}

function buildTimeIntervalScheme(match: RegExpMatchArray, paces: Paces): SplitScheme {
  const reps = parseInt(match[1]);
  const workMin = parseInt(match[2]);
  const zone = match[3];
  const restMin = parseInt(match[4]);

  const workPace = getPaceForZone(zone, paces);
  const workDist = (workMin * 60) / workPace * 1000;
  const recoveryDist = (restMin * 60) / paces.e * 1000;

  const segments: SplitSegment[] = [];
  for (let i = 0; i < reps; i++) {
    segments.push({
      label: `Rep ${i + 1} of ${reps}`,
      distance: workDist,
      targetPace: workPace,
    });
    if (i < reps - 1 && recoveryDist > 0) {
      segments.push({
        label: `Recovery ${i + 1}`,
        distance: recoveryDist,
        targetPace: null,
      });
    }
  }

  const totalDist = segments.reduce((s, seg) => s + seg.distance, 0);
  return {
    segments,
    totalDistance: totalDist,
    description: `${reps}×${workMin}min @ ${zone}`,
  };
}

function buildProgressiveScheme(match: RegExpMatchArray, paces: Paces): SplitScheme {
  const totalKm = parseFloat(match[1]);
  const fastKm = parseFloat(match[2]);
  const zone = match[3];
  const easyKm = totalKm - fastKm;

  const fastPace = getPaceForZone(zone, paces);

  const segments: SplitSegment[] = [];

  // Easy portion as km splits
  for (let i = 0; i < Math.floor(easyKm); i++) {
    segments.push({
      label: `km ${i + 1}`,
      distance: 1000,
      targetPace: paces.e,
    });
  }
  const easyRemainder = (easyKm - Math.floor(easyKm)) * 1000;
  if (easyRemainder > 0) {
    segments.push({
      label: `km ${Math.floor(easyKm) + 1} (partial)`,
      distance: easyRemainder,
      targetPace: paces.e,
    });
  }

  // Fast portion as km splits
  for (let i = 0; i < Math.floor(fastKm); i++) {
    segments.push({
      label: `Fast km ${i + 1} of ${Math.floor(fastKm)}`,
      distance: 1000,
      targetPace: fastPace,
    });
  }
  const fastRemainder = (fastKm - Math.floor(fastKm)) * 1000;
  if (fastRemainder > 0) {
    segments.push({
      label: `Fast km ${Math.floor(fastKm) + 1} (partial)`,
      distance: fastRemainder,
      targetPace: fastPace,
    });
  }

  return {
    segments,
    totalDistance: totalKm * 1000,
    description: `${totalKm}km: last ${fastKm} @ ${zone}`,
  };
}

function buildKmSplits(
  totalDist: number,
  pace: number | null,
  description: string
): SplitScheme {
  const fullKm = Math.floor(totalDist / 1000);
  const remainder = totalDist - fullKm * 1000;

  const segments: SplitSegment[] = [];
  for (let i = 0; i < fullKm; i++) {
    segments.push({
      label: `km ${i + 1}`,
      distance: 1000,
      targetPace: pace,
    });
  }
  if (remainder > 50) {
    segments.push({
      label: `km ${fullKm + 1} (${Math.round(remainder)}m)`,
      distance: remainder,
      targetPace: pace,
    });
  }

  return {
    segments,
    totalDistance: totalDist,
    description,
  };
}
