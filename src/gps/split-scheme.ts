import type { Paces } from '@/types';
import type { SplitScheme, SplitSegment } from '@/types';
import { getPaceForZone } from '@/calculations';

/**
 * Build a SplitScheme from a workout description and current paces.
 * Parses the workout description (same formats as parser.ts) and creates
 * distance-based segments the tracker will watch for.
 *
 * Multi-line descriptions (with warm up / cool down lines) are handled by
 * extracting WU/CD as single segments and parsing the main set from the
 * middle line(s).
 */
export function buildSplitScheme(workoutDesc: string, paces: Paces): SplitScheme {
  // Multi-line: extract WU / main set / CD separately
  if (workoutDesc.includes('\n')) {
    return buildMultiLineScheme(workoutDesc, paces);
  }
  return buildSingleLineScheme(workoutDesc, paces);
}

/**
 * Resolve a pace zone name OR a literal "m:ss/km" pace string to sec/km.
 * e.g. "4:49/km" → 289, "vo2" → paces.v, "threshold" → paces.t
 */
function resolvePace(zone: string, paces: Paces): number {
  const literal = zone.match(/^(\d+):(\d{2})(?:\/km)?$/);
  if (literal) return parseInt(literal[1]) * 60 + parseInt(literal[2]);
  return getPaceForZone(zone, paces);
}

/** Parse a single-line workout description into a SplitScheme. */
function buildSingleLineScheme(workoutDesc: string, paces: Paces): SplitScheme {
  // Try interval format: "8×400m @ 5K, 90s" or "4×1km @ threshold, 2min"
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

  // Try time intervals: "6×2min @ 4:49/km (~790m), 2 min recovery between sets"
  // or "3×10min @ threshold, 2min"
  // Optional (~dist) parenthetical between zone and rest time.
  const timeIntervalMatch = workoutDesc.match(
    /^(\d+)×(\d+(?:\.\d+)?)min\s*@\s*([\w\-:./]+)\s*(?:\([^)]*\))?,?\s*(\d+(?:\.\d+)?)\s*min/i
  );
  if (timeIntervalMatch) {
    return buildTimeIntervalScheme(timeIntervalMatch, paces);
  }

  // Try continuous time at pace: "20min @ threshold (~3.2km)" or "20min @ 4:49/km"
  // Produced by intentToWorkout for threshold/vo2 without reps, and marathon_pace.
  const contTimeMatch = workoutDesc.match(
    /^(\d+(?:\.\d+)?)min\s*@\s*([\w\-:./]+(?:\s*\([^)]*\))?)/i
  );
  if (contTimeMatch) {
    const minutes = parseFloat(contTimeMatch[1]);
    // Strip parenthetical from zone before resolving
    const zone = contTimeMatch[2].replace(/\s*\([^)]*\)/, '').trim();
    const pace = resolvePace(zone, paces);
    if (pace > 0) {
      const dist = (minutes * 60 / pace) * 1000;
      const label = `${contTimeMatch[1]}min @ ${zone}`;
      return { segments: [{ label, distance: dist, targetPace: pace }], totalDistance: dist, description: label };
    }
  }

  // Try progressive: "21km: last 5 @ HM"
  const progressiveMatch = workoutDesc.match(
    /^(\d+\.?\d*)km:?\s*last\s*(\d+\.?\d*)\s*@\s*(\w+)/i
  );
  if (progressiveMatch) {
    return buildProgressiveScheme(progressiveMatch, paces);
  }

  // Try distance @ pace: "20km @ MP" — per-km splits at target pace
  const distAtPaceMatch = workoutDesc.match(/^(\d+\.?\d*)km\s*@\s*([\w\-:./]+)/i);
  if (distAtPaceMatch) {
    const dist = parseFloat(distAtPaceMatch[1]) * 1000;
    const pace = resolvePace(distAtPaceMatch[2], paces);
    const label = `${distAtPaceMatch[1]}km @ ${distAtPaceMatch[2]}`;
    return buildKmSplits(dist, pace, label);
  }

  // Try simple distance: "8km" or "8km easy jog" — per-km splits at easy pace
  const simpleDistMatch = workoutDesc.match(/^(\d+\.?\d*)km\b/i);
  if (simpleDistMatch) {
    const dist = parseFloat(simpleDistMatch[1]) * 1000;
    return buildKmSplits(dist, paces.e, `${simpleDistMatch[1]}km easy`);
  }

  // Can't parse — return empty scheme
  return { segments: [], totalDistance: 0, description: workoutDesc };
}

/**
 * Parse a multi-line description.
 * Lines are categorised as:
 *   - Warm-up:   "Xkm warm up ..."  → single WU segment at easy pace
 *   - Cool-down: "Xkm cool down ..." → single CD segment at easy pace
 *   - Main set:  everything else — first parseable line wins
 */
function buildMultiLineScheme(workoutDesc: string, paces: Paces): SplitScheme {
  const lines = workoutDesc.split('\n').map(l => l.trim()).filter(Boolean);

  let wuDist = 0;
  let cdDist = 0;
  let mainScheme: SplitScheme | null = null;

  for (const line of lines) {
    const wuMatch = line.match(/^(\d+\.?\d*)km\s+warm\s+up/i);
    if (wuMatch) {
      wuDist = parseFloat(wuMatch[1]) * 1000;
      continue;
    }
    const cdMatch = line.match(/^(\d+\.?\d*)km\s+cool\s+down/i);
    if (cdMatch) {
      cdDist = parseFloat(cdMatch[1]) * 1000;
      continue;
    }
    if (!mainScheme) {
      const candidate = buildSingleLineScheme(line, paces);
      if (candidate.segments.length > 0) mainScheme = candidate;
    }
  }

  const segments: SplitSegment[] = [];

  if (wuDist > 0) {
    const km = wuDist / 1000;
    segments.push({
      label: `${km % 1 === 0 ? km.toFixed(0) : km}km Warm Up`,
      distance: wuDist,
      targetPace: paces.e,
    });
  }

  if (mainScheme) {
    segments.push(...mainScheme.segments);
  }

  if (cdDist > 0) {
    const km = cdDist / 1000;
    segments.push({
      label: `${km % 1 === 0 ? km.toFixed(0) : km}km Cool Down`,
      distance: cdDist,
      targetPace: paces.e,
    });
  }

  const totalDistance = segments.reduce((s, seg) => s + seg.distance, 0);
  const description = mainScheme?.description ?? workoutDesc.split('\n')[0];

  return { segments, totalDistance, description };
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

  const restSeconds = restUnit === 'min' ? restVal * 60 : restVal;

  const segments: SplitSegment[] = [];
  for (let i = 0; i < reps; i++) {
    segments.push({
      label: `Rep ${i + 1} of ${reps}`,
      distance: distPerRep,
      targetPace: workPace,
    });
    if (i < reps - 1 && restSeconds > 0) {
      // Estimate recovery distance from easy pace jog
      const recoveryDist = (restSeconds / paces.e) * 1000;
      segments.push({
        label: `Recovery ${i + 1}`,
        distance: recoveryDist,
        durationSeconds: restSeconds,
        targetPace: null,
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
  const workMin = parseFloat(match[2]);
  const zone = match[3];
  const restMin = parseFloat(match[4]);

  const workPace = resolvePace(zone, paces);
  const workDist = (workMin * 60) / workPace * 1000;
  const restSeconds = restMin * 60;

  const segments: SplitSegment[] = [];
  for (let i = 0; i < reps; i++) {
    segments.push({
      label: `Rep ${i + 1} of ${reps}`,
      distance: workDist,
      targetPace: workPace,
    });
    if (i < reps - 1 && restSeconds > 0) {
      const recoveryDist = (restSeconds / paces.e) * 1000;
      segments.push({
        label: `Recovery ${i + 1}`,
        distance: recoveryDist,
        durationSeconds: restSeconds,
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

  // Easy portion as per-km splits so the runner can track each km
  if (easyKm > 0) {
    const easyScheme = buildKmSplits(easyKm * 1000, paces.e, `${easyKm % 1 === 0 ? easyKm.toFixed(0) : easyKm}km Easy`);
    segments.push(...easyScheme.segments);
  }

  // Fast portion as km splits so the runner can track each km
  for (let i = 0; i < Math.floor(fastKm); i++) {
    segments.push({
      label: `Fast km ${i + 1} of ${Math.floor(fastKm)}`,
      distance: 1000,
      targetPace: fastPace,
    });
  }
  const fastRemainder = (fastKm - Math.floor(fastKm)) * 1000;
  if (fastRemainder > 50) {
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
