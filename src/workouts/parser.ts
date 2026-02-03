import type { ParsedWorkout, Paces } from '@/types';
import { getPaceForZone } from '@/calculations';

/**
 * Parse workout description to extract distance and pace zones
 * @param desc - Workout description string
 * @param paces - Current pace zones
 * @returns Parsed workout information
 */
export function parseWorkoutDescription(desc: string, paces: Paces): ParsedWorkout {
  const result: ParsedWorkout = {
    totalDistance: 0,
    workTime: 0,
    totalTime: 0,
    avgPace: null,
    paceZone: null,
    format: 'unknown'
  };

  // Handle modified workout descriptions (e.g., "4km (was 6km)")
  const modifiedMatch = desc.match(/^(\d+\.?\d*)km\s*\(was/i);
  if (modifiedMatch) {
    result.totalDistance = parseFloat(modifiedMatch[1]) * 1000;
    result.format = 'simple';
    result.avgPace = paces.e;
    result.paceZone = 'easy';
    result.workTime = (result.totalDistance / 1000) * paces.e;
    result.totalTime = result.workTime;
    return result;
  }

  // Format 1: Simple distance (e.g., "8km", "10km")
  const simpleDistMatch = desc.match(/^(\d+\.?\d*)km$/i);
  if (simpleDistMatch) {
    result.totalDistance = parseFloat(simpleDistMatch[1]) * 1000;
    result.format = 'simple';
    result.avgPace = paces.e;
    result.paceZone = 'easy';
    result.workTime = (result.totalDistance / 1000) * paces.e;
    result.totalTime = result.workTime;
    return result;
  }

  // Format 2: Time @ pace (e.g., "20min @ threshold", "45min @ tempo")
  const timeAtPaceMatch = desc.match(/^(\d+)min\s*@\s*(\w+)/i);
  if (timeAtPaceMatch) {
    const minutes = parseInt(timeAtPaceMatch[1]);
    const zone = timeAtPaceMatch[2].toLowerCase();
    const pace = getPaceForZone(zone, paces);

    result.workTime = minutes * 60;
    result.totalTime = minutes * 60;
    result.totalDistance = (minutes * 60) / pace * 1000;
    result.avgPace = pace;
    result.paceZone = zone;
    result.format = 'time_at_pace';
    return result;
  }

  // Format 3: Intervals with distance (e.g., "8×800 @ 5K, 90s", "4×1mi @ 10K, 2min")
  let intervalDistMatch = desc.match(/^(\d+)×(\d+\.?\d*)(m|mi|km|k)\s*@\s*([\w\-]+),?\s*(\d+)-?(\d*)(s|min)?/i);

  // If no match, try without unit (assume meters for distances like "800")
  if (!intervalDistMatch) {
    const noUnitMatch = desc.match(/^(\d+)×(\d+\.?\d*)\s*@\s*([\w\-]+),?\s*(\d+)-?(\d*)(s|min)?/i);
    if (noUnitMatch) {
      intervalDistMatch = [
        noUnitMatch[0],
        noUnitMatch[1],  // reps
        noUnitMatch[2],  // distance
        'm',             // implied meters
        noUnitMatch[3],  // pace zone
        noUnitMatch[4],  // rest value (min)
        noUnitMatch[5],  // rest value (max) if range
        noUnitMatch[6]   // rest unit
      ] as RegExpMatchArray;
    }
  }

  if (intervalDistMatch) {
    const reps = parseInt(intervalDistMatch[1]);
    const dist = parseFloat(intervalDistMatch[2]);
    const unit = intervalDistMatch[3].toLowerCase();
    const zone = intervalDistMatch[4];
    const restVal = parseInt(intervalDistMatch[5]);
    const restVal2 = intervalDistMatch[6] ? parseInt(intervalDistMatch[6]) : restVal;
    const restAvg = (restVal + restVal2) / 2;
    const restUnit = intervalDistMatch[7] || 's';

    let distPerRep = 0;
    if (unit === 'm') distPerRep = dist;
    else if (unit === 'mi') distPerRep = dist * 1609;
    else if (unit === 'km' || unit === 'k') distPerRep = dist * 1000;

    const pace = getPaceForZone(zone, paces);
    const repTime = (distPerRep / 1000) * pace;
    const restTime = restUnit === 'min' ? restAvg * 60 : restAvg;

    result.totalDistance = distPerRep * reps;
    result.workTime = repTime * reps;
    result.totalTime = (repTime + restTime) * reps - restTime;
    result.avgPace = pace;
    result.paceZone = zone;
    result.format = 'intervals_dist';
    return result;
  }

  // Format 4: Intervals with time (e.g., "3×10min @ threshold, 2min" or "3×10min @ threshold, 2 minute break")
  const intervalTimeMatch = desc.match(/^(\d+)×(\d+\.?\d*)min\s*@\s*(\w+),?\s*(\d+\.?\d*)\s*(?:min(?:ute)?\s*(?:break)?|minute\s+break)/i);
  if (intervalTimeMatch) {
    const reps = parseInt(intervalTimeMatch[1]);
    const workMin = parseFloat(intervalTimeMatch[2]);
    const zone = intervalTimeMatch[3];
    const restMin = parseFloat(intervalTimeMatch[4]);

    const pace = getPaceForZone(zone, paces);
    const repTime = workMin * 60;
    const restTime = restMin * 60;
    const distPerRep = (repTime / pace) * 1000;

    result.totalDistance = distPerRep * reps;
    result.workTime = repTime * reps;
    result.totalTime = (repTime + restTime) * reps - restTime;
    result.avgPace = pace;
    result.paceZone = zone;
    result.format = 'intervals_time';
    return result;
  }

  // Format 5: Progressive/Fast finish (e.g., "21km: last 5 @ HM", "29km: last 10 @ MP")
  const progressiveMatch = desc.match(/^(\d+\.?\d*)km:?\s*last\s*(\d+\.?\d*)\s*@\s*(\w+)/i);
  if (progressiveMatch) {
    const totalDist = parseFloat(progressiveMatch[1]) * 1000;
    const fastDist = parseFloat(progressiveMatch[2]) * 1000;
    const zone = progressiveMatch[3];

    const easyDist = totalDist - fastDist;
    const fastPace = getPaceForZone(zone, paces);
    const easyPace = paces.e;

    const easyTime = (easyDist / 1000) * easyPace;
    const fastTime = (fastDist / 1000) * fastPace;

    result.totalDistance = totalDist;
    result.workTime = easyTime + fastTime;
    result.totalTime = easyTime + fastTime;
    result.avgPace = result.totalTime / (totalDist / 1000);
    result.paceZone = 'progressive';
    result.format = 'progressive';
    return result;
  }

  // Format 6: Simple distance @ pace (e.g., "20km @ MP")
  const distAtPaceMatch = desc.match(/^(\d+\.?\d*)km\s*@\s*(\w+)/i);
  if (distAtPaceMatch) {
    const dist = parseFloat(distAtPaceMatch[1]) * 1000;
    const zone = distAtPaceMatch[2];
    const pace = getPaceForZone(zone, paces);

    result.totalDistance = dist;
    result.workTime = (dist / 1000) * pace;
    result.totalTime = result.workTime;
    result.avgPace = pace;
    result.paceZone = zone;
    result.format = 'dist_at_pace';
    return result;
  }

  // Format 7: Mixed paces (e.g., "10@MP, 4@10K, 5@HM", "6.5@MP, 2.5@10K, 3@HM")
  const mixedMatch = desc.match(/(\d+\.?\d*)@(\w+)/gi);
  if (mixedMatch && mixedMatch.length > 1) {
    let totalDist = 0;
    let totalTime = 0;

    for (const segment of mixedMatch) {
      const parts = segment.match(/(\d+\.?\d*)@(\w+)/i);
      if (parts) {
        const dist = parseFloat(parts[1]) * 1000;
        const zone = parts[2];
        const pace = getPaceForZone(zone, paces);

        totalDist += dist;
        totalTime += (dist / 1000) * pace;
      }
    }

    result.totalDistance = totalDist;
    result.workTime = totalTime;
    result.totalTime = totalTime;
    result.avgPace = totalTime / (totalDist / 1000);
    result.paceZone = 'mixed';
    result.format = 'mixed';
    return result;
  }

  // Format 8: Long intervals (e.g., "2×10km @ MP, 2min", "2×15km @ threshold, 3min")
  const longIntervalMatch = desc.match(/^(\d+)×(\d+\.?\d*)km\s*@\s*(\w+),?\s*(\d+)min/i);
  if (longIntervalMatch) {
    const reps = parseInt(longIntervalMatch[1]);
    const distPerRep = parseFloat(longIntervalMatch[2]) * 1000;
    const zone = longIntervalMatch[3];
    const restMin = parseInt(longIntervalMatch[4]);

    const pace = getPaceForZone(zone, paces);
    const repTime = (distPerRep / 1000) * pace;
    const restTime = restMin * 60;

    result.totalDistance = distPerRep * reps;
    result.workTime = repTime * reps;
    result.totalTime = (repTime + restTime) * reps - restTime;
    result.avgPace = pace;
    result.paceZone = zone;
    result.format = 'long_intervals';
    return result;
  }

  // If we can't parse it, return what we have
  console.warn(`Could not fully parse workout: "${desc}"`);
  return result;
}
